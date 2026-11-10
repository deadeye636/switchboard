/**
 * process-usage.js — what a session costs the machine: its process tree with CPU and memory (#834, spec 43).
 *
 * A session runs a tree of processes from one root: the terminal's shell, or the pipe child of a backend driven over
 * a runtime protocol (`agent-rpc.js` wraps that child to answer `session.pty`, so both are `session.pty.pid`). The core
 * knows that root and nothing about the backend; no backend id decides anything here (CLAUDE.md reflex 5).
 *
 * One measurement covers every session: on Windows one `getProcessList(process.pid)` of `@vscode/windows-process-tree`
 * (a native module, owner decision on #834, way a) followed by one `getProcessCpuUsage`, whose worker reads the times
 * twice a second apart off the main thread. Every session's shell and pipe child is a direct child of this process
 * (node-pty starts a ConPTY shell with CreateProcess here; `child_process.spawn` likewise), so the descendants of
 * `process.pid` hold all of them. On macOS and Linux one `ps` call per sample, and CPU is the difference of the
 * processes' CPU time between two samples, in the same unit Windows answers: a share of all cores, 0 to 100.
 *
 * Nothing runs on its own. The renderer asks (`process-usage`) only while the sidebar's Processes group is open in a
 * visible sidebar, every few seconds; requests that arrive while a sample is out, or within `REUSE_MS` of the last one,
 * share it, so two sidebars and two windows still cost one sample. The answer is small and neutral: per session a
 * total and a flat list of rows (pid, name, depth, cpu, memory), nothing else.
 *
 * The native module is optional (`optionalDependencies`): it is required lazily, and a machine where it did not build
 * answers `{ supported: false }` with a sentence, instead of failing.
 */

'use strict';

const os = require('os');
const { execFile } = require('child_process');
const { closeProbeStdin } = require('./terminal/shell-profiles');
const { readableError } = require('./readable-error');

let ctx = null;

// A sample younger than this answers a second request; a Windows sample itself takes about a second.
const REUSE_MS = 1500;
// The rows one session answers, deepest-first trees cut at this many.
const MAX_ROWS = 60;
const PS_TIMEOUT_MS = 5000;
// The native CPU pass alone takes a second; past this the sample is given up.
const NATIVE_TIMEOUT_MS = 8000;
// A previous `ps` sample older than this is not a baseline: its CPU difference would be an average over the whole
// time the group was closed, not what the session uses now. That sample then shows memory only, like the first.
const PS_BASELINE_MAX_MS = 15000;

let last = null;        // { at, procs: Map<pid, { pid, ppid, name, memory, cpu }> }
let inflight = null;    // Promise of the sample being taken
let psPrevious = null;  // { at, times: Map<pid, seconds> } — the CPU times of the previous `ps` sample
let nativeTree;         // undefined: not tried yet; null: not available

/**
 * @param {object} context
 * @param {() => Map<string, { pty?: { pid?: number } }>} context.activeSessions  the running sessions, by id
 * @param {object} [context.log]
 * @param {string} [context.platform]  `process.platform`, for tests
 * @param {object} [context.nativeTree]  stands in for `@vscode/windows-process-tree`, for tests
 * @param {(file: string, args: string[], opts: object, cb: Function) => object} [context.execFile]  for tests
 * @param {number} [context.nativeTimeoutMs]  replaces NATIVE_TIMEOUT_MS, for tests
 */
function init(context) {
  ctx = context;
  last = null;
  inflight = null;
  psPrevious = null;
  nativeTree = context && context.nativeTree !== undefined ? context.nativeTree : undefined;
}

function platformOf() {
  return (ctx && ctx.platform) || process.platform;
}

function loadNativeTree() {
  if (nativeTree !== undefined) return nativeTree;
  try {
    nativeTree = require('@vscode/windows-process-tree');
  } catch (err) {
    nativeTree = null;
    if (ctx && ctx.log) ctx.log.info(`[process-usage] the process tree module is not available: ${err.message}`);
  }
  return nativeTree;
}

// --- Pure helpers, exported for the tests. ---

// `ps` prints CPU time as `[[dd-]hh:]mm:ss[.cc]` (Linux `time`, macOS `time` with hundredths). Seconds, or null.
function parseCpuTime(text) {
  const s = String(text || '').trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (Number(days || 0) * 86400) + (Number(hours || 0) * 3600) + (Number(minutes) * 60) + Number(seconds);
}

// One `ps -A -o pid=,ppid=,rss=,time=,comm=` listing: rss is KiB, comm may be a path (macOS) and may hold spaces.
function parsePsOutput(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[5].split('/').pop() || m[5];
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), memory: Number(m[3]) * 1024, time: parseCpuTime(m[4]), name });
  }
  return rows;
}

/**
 * Each requested session's tree from its root, as rows in tree order with a depth, and a total.
 * @param {Map<number, { pid: number, ppid: number, name: string, memory?: number, cpu?: number|null }>} procs
 * @param {Array<[string, number]>} roots  [sessionId, root pid]
 * @returns {Record<string, { running: boolean, total: { cpu: number|null, memory: number, count: number }, rows: object[], truncated: boolean }>}
 */
function sessionUsage(procs, roots) {
  const children = new Map();
  for (const p of procs.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  for (const list of children.values()) list.sort((a, b) => a.pid - b.pid);
  const out = {};
  for (const [sessionId, rootPid] of roots) {
    const root = Number.isInteger(rootPid) ? procs.get(rootPid) : null;
    if (!root) {
      out[sessionId] = { running: false, total: { cpu: null, memory: 0, count: 0 }, rows: [], truncated: false };
      continue;
    }
    const rows = [];
    let cpu = null;
    let memory = 0;
    let count = 0;
    const seen = new Set();
    const walk = (p, depth) => {
      if (seen.has(p.pid)) return; // a pid reused as its own ancestor must not loop
      seen.add(p.pid);
      count++;
      if (Number.isFinite(p.cpu)) cpu = (cpu || 0) + p.cpu;
      if (Number.isFinite(p.memory)) memory += p.memory;
      if (rows.length < MAX_ROWS) rows.push({ pid: p.pid, name: p.name, depth, cpu: Number.isFinite(p.cpu) ? p.cpu : null, memory: Number.isFinite(p.memory) ? p.memory : null });
      for (const c of children.get(p.pid) || []) walk(c, depth + 1);
    };
    walk(root, 0);
    out[sessionId] = { running: true, total: { cpu, memory, count }, rows, truncated: count > rows.length };
  }
  return out;
}

// --- The samplers. ---

// The native calls answer through callbacks. A callback that never comes would hold `inflight` for good, and every
// later request with it, so the sample gives up after NATIVE_TIMEOUT_MS; a throw inside a callback rejects instead
// of escaping as an uncaught exception in main.
function sampleWindows(tree) {
  return new Promise((resolve, reject) => {
    let done = false;
    const limit = (ctx && ctx.nativeTimeoutMs) || NATIVE_TIMEOUT_MS;
    // Not unref'd: it is cleared the moment the sample ends either way, and it is what ends a sample that hangs.
    const timer = setTimeout(() => finish(new Error('The process tree did not answer in time.')), limit);
    const finish = (err, procs) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(procs);
    };
    try {
      const flags = tree.ProcessDataFlag ? tree.ProcessDataFlag.Memory : 1;
      tree.getProcessList(process.pid, (list) => {
        try {
          if (!Array.isArray(list)) { finish(null, new Map()); return; }
          tree.getProcessCpuUsage(list, (withCpu) => {
            try {
              const procs = new Map();
              for (const p of Array.isArray(withCpu) ? withCpu : list) {
                procs.set(p.pid, { pid: p.pid, ppid: p.ppid, name: p.name, memory: p.memory, cpu: Number.isFinite(p.cpu) ? p.cpu : null });
              }
              finish(null, procs);
            } catch (err) { finish(err); }
          });
        } catch (err) { finish(err); }
      }, flags);
    } catch (err) { finish(err); }
  });
}

function samplePs() {
  return new Promise((resolve, reject) => {
    const run = (ctx && ctx.execFile) || execFile;
    const child = run('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,comm='], { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(err); return; }
      const at = Date.now();
      const rows = parsePsOutput(stdout);
      const cores = Math.max(1, os.cpus().length);
      const times = new Map();
      const procs = new Map();
      if (psPrevious && at - psPrevious.at > PS_BASELINE_MAX_MS) psPrevious = null;
      for (const r of rows) {
        times.set(r.pid, r.time);
        let cpu = null;
        const before = psPrevious && psPrevious.times.get(r.pid);
        const elapsed = psPrevious ? (at - psPrevious.at) / 1000 : 0;
        if (elapsed > 0 && Number.isFinite(before) && Number.isFinite(r.time) && r.time >= before) {
          cpu = Math.min(100, (100 * (r.time - before)) / (elapsed * cores));
        }
        procs.set(r.pid, { pid: r.pid, ppid: r.ppid, name: r.name, memory: r.memory, cpu });
      }
      psPrevious = { at, times };
      resolve(procs);
    });
    closeProbeStdin(child);
  });
}

async function takeSample() {
  if (platformOf() === 'win32') {
    const tree = loadNativeTree();
    if (!tree) return { supported: false };
    return { supported: true, procs: await sampleWindows(tree) };
  }
  return { supported: true, procs: await samplePs() };
}

// One sample shared by everybody who asks within REUSE_MS or while it is out.
function sharedSample() {
  if (last && Date.now() - last.at < REUSE_MS) return Promise.resolve(last.result);
  if (inflight) return inflight;
  inflight = takeSample()
    .then((result) => { last = { at: Date.now(), result }; return result; })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * @param {string[]} sessionIds
 * @returns {Promise<{ ok: true, supported: boolean, message?: string, sessions?: object }|{ ok: false, error: string }>}
 */
async function usageOf(sessionIds) {
  if (!ctx) return { ok: false, error: 'Process usage is not available yet.' };
  const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string' && id).slice(0, 64) : [];
  const sessions = ctx.activeSessions ? ctx.activeSessions() : new Map();
  const roots = ids.map((id) => {
    const s = sessions.get(id);
    const pid = s && s.pty && Number.isInteger(s.pty.pid) ? s.pty.pid : null;
    return [id, pid];
  });
  let sample;
  try {
    sample = await sharedSample();
  } catch (err) {
    return { ok: false, error: readableError(err, 'The processes could not be read.', ctx.log) };
  }
  if (!sample.supported) {
    return { ok: true, supported: false, message: 'The process tree module is not installed on this machine.' };
  }
  return { ok: true, supported: true, sessions: sessionUsage(sample.procs, roots) };
}

function registerIpc(ipc) {
  ipc.handle('process-usage', (_event, sessionIds) => usageOf(sessionIds));
}

module.exports = { init, registerIpc, usageOf, sessionUsage, parsePsOutput, parseCpuTime, REUSE_MS, MAX_ROWS, NATIVE_TIMEOUT_MS };
