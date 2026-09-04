// backends/agy/local-usage.js — read the quota service exposed by a running `agy` process (#509).
//
// Current Antigravity releases own their OAuth token in the OS keyring and expose the same quota data
// that `/usage` renders through a loopback HTTPS service. Keeping the request here means AGY remains the
// owner of authentication and refresh; Switchboard never exports the keyring credential.
'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const { execFile } = require('child_process');
const { closeStdin } = require('../cli-probe');

const QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const MODEL_CONFIG_PATH = '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 10000;

// A probe that never succeeds must not repeat forever. The usage poll runs every 60 s and the durable
// cache only engages after a SUCCESSFUL reading, so an install that is present but not signed in used to
// have Switchboard spawn and kill a full AGY PTY about once a minute for the app's whole lifetime.
// Bounded per attempt is not the same as bounded in repetition (#509).
const PROBE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const PROBE_BACKOFF_MAX_MS = 60 * 60 * 1000;

// Reverse-engineered from AGY's interactive output — a GUESS, not something a reader can check against
// the binary. If a pattern is wrong the probe still stops on PROBE_TIMEOUT_MS, so the failure mode is a
// slower stop rather than an unattended browser login.
const AUTH_PATTERNS = [
  /select\s+login\s+method\s*:?/i,
  /you\s+are\s+not\s+logged\s+into\s+antigravity/i,
  /keyring\s*auth\s*:\s*timed\s+out\b/i,
];

function parseWindowsNetstat(output, pid) {
  const ports = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue;
    if (Number(fields[fields.length - 1]) !== Number(pid)) continue;
    const state = String(fields[fields.length - 2] || '').toUpperCase();
    if (!['LISTENING', 'LISTEN', 'ABHÖREN'].includes(state)) continue;
    const match = String(fields[1] || '').match(/:(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports].filter(validPort).sort((a, b) => a - b);
}

function parseLsof(output) {
  const ports = new Set();
  for (const match of String(output || '').matchAll(/:(\d+)\s+\(LISTEN\)/g)) ports.add(Number(match[1]));
  return [...ports].filter(validPort).sort((a, b) => a - b);
}

function parseProcNet(output, socketInodes) {
  const ports = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== '0A' || !socketInodes.has(fields[9])) continue;
    const separator = fields[1].lastIndexOf(':');
    if (separator < 0) continue;
    const port = Number.parseInt(fields[1].slice(separator + 1), 16);
    if (validPort(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

// Only the CLI itself. A loose match ("anything that looks like a language server") would have
// Switchboard POST into the loopback ports of processes it knows nothing about.
const AGY_PROCESS_NAME = /^agy(\.exe)?$/i;

function parseWindowsTasklist(output) {
  const pids = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const name = fields[0].slice(1, -1);
    const pid = Number(fields[1].slice(1, -1));
    if (AGY_PROCESS_NAME.test(name) && validPid(pid)) pids.push(pid);
  }
  return pids;
}

function parsePosixPs(output) {
  const pids = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const name = match[2].trim().split(/[\\/]/).pop();
    if (AGY_PROCESS_NAME.test(name) && validPid(pid)) pids.push(pid);
  }
  return pids;
}

// Every AGY process on this machine, not only the ones Switchboard spawned. `execFile`, no shell string.
async function discoverPids(deps = {}) {
  const run = deps.execFileText || execFileText;
  try {
    if (process.platform === 'win32') {
      return parseWindowsTasklist(await run('tasklist.exe', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq agy.exe']));
    }
    return parsePosixPs(await run('ps', ['-Ao', 'pid=,comm=']));
  } catch {
    return [];
  }
}

function execFileText(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // closeStdin, not a `stdio` option: execFile ignores that one (#532, backends/cli-probe.js).
    closeStdin(execFile(file, args, {
      encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024, ...opts,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || '');
    }));
  });
}

function procListeningPorts(pid) {
  const root = `/proc/${pid}`;
  let entries;
  try { entries = fs.readdirSync(`${root}/fd`); } catch { return []; }
  const inodes = new Set();
  for (const entry of entries) {
    let target;
    try { target = fs.readlinkSync(`${root}/fd/${entry}`); } catch { continue; }
    const match = target.match(/^socket:\[(\d+)\]$/);
    if (match) inodes.add(match[1]);
  }
  if (inodes.size === 0) return [];
  const ports = new Set();
  for (const name of ['tcp', 'tcp6']) {
    let text;
    try { text = fs.readFileSync(`${root}/net/${name}`, 'utf8'); } catch { continue; }
    for (const port of parseProcNet(text, inodes)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

async function listeningPorts(pid, deps = {}) {
  const run = deps.execFileText || execFileText;
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (process.platform === 'win32') {
    try { return parseWindowsNetstat(await run('netstat.exe', ['-ano', '-p', 'tcp']), pid); }
    catch { return []; }
  }
  try {
    return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)]));
  } catch {
    return process.platform === 'linux' ? procListeningPorts(pid) : [];
  }
}

function requestError(status, body) {
  const err = new Error(`Local AGY quota endpoint returned HTTP ${status}`);
  err.status = status;
  err.body = body;
  return err;
}

function postJson(port, requestPath, payload, { timeoutMs = 1200, requestImpl = https.request } = {}) {
  if (!validPort(port)) return Promise.reject(new Error('Invalid local AGY port'));
  const body = Buffer.from(JSON.stringify(payload || {}));
  return new Promise((resolve, reject) => {
    const req = requestImpl({
      hostname: '127.0.0.1', port, path: requestPath, method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        'Connect-Protocol-Version': '1',
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Local AGY quota response was too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          const err = requestError(res.statusCode, text);
          err.retryAfterSeconds = Number.parseInt(res.headers['retry-after'] || '0', 10) || 0;
          return reject(err);
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('Local AGY quota response was not JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Local AGY quota request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function quotaSummaryPayload(raw) {
  const payload = raw && (raw.response || raw.summary || raw);
  return payload && Array.isArray(payload.groups) ? payload : null;
}

function modelConfigsPayload(raw) {
  const list = raw?.userStatus?.cascadeModelConfigData?.clientModelConfigs || raw?.clientModelConfigs;
  return Array.isArray(list) ? list : null;
}

async function fetchFromPid(pid, deps = {}) {
  const ports = await (deps.listeningPorts || listeningPorts)(pid, deps);
  const post = deps.postJson || postJson;
  let sawAuth = false;
  let retryAfterSeconds = 0;
  for (const port of ports) {
    try {
      const raw = await post(port, QUOTA_SUMMARY_PATH, { forceRefresh: true }, deps);
      if (quotaSummaryPayload(raw)) return { kind: 'summary', raw };
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) sawAuth = true;
      if (err?.status === 429) retryAfterSeconds = Number(err.retryAfterSeconds || 0);
    }
    for (const requestPath of [USER_STATUS_PATH, MODEL_CONFIG_PATH]) {
      try {
        const raw = await post(port, requestPath, {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' },
        }, deps);
        if (modelConfigsPayload(raw)) return { kind: 'models', raw };
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) sawAuth = true;
        if (err?.status === 429) retryAfterSeconds = Number(err.retryAfterSeconds || 0);
      }
    }
  }
  if (retryAfterSeconds || sawAuth) {
    return retryAfterSeconds ? { kind: 'rateLimited', retryAfterSeconds } : { kind: 'authRequired' };
  }
  return { kind: 'unavailable' };
}

function containsAuthPrompt(output) {
  return AUTH_PATTERNS.some(pattern => pattern.test(String(output || '')));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

async function stopManagedProbe(proc, exited, deps = {}) {
  if (!proc) return;
  try { proc.write('/exit\r'); } catch {}
  await Promise.race([exited, (deps.delay || delay)(400)]);
  if (!isAlive(proc.pid)) return;
  try { proc.kill(); } catch {}
  await Promise.race([exited, (deps.delay || delay)(600)]);
  if (!isAlive(proc.pid) || process.platform !== 'win32') return;
  try {
    await (deps.execFileText || execFileText)('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F']);
  } catch { /* the process may have exited between the probe and taskkill */ }
}

async function runManagedProbe(executable, deps = {}) {
  let proc;
  let recentOutput = '';
  let resolveExited;
  const exited = new Promise(resolve => { resolveExited = resolve; });
  try {
    const pty = deps.pty || require('node-pty');
    proc = pty.spawn(executable, [], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: deps.env || process.env,
    });
    proc.onData((data) => { recentOutput = (recentOutput + data).slice(-8192); });
    proc.onExit(() => resolveExited());
    const deadline = Date.now() + Number(deps.probeTimeoutMs || PROBE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (containsAuthPrompt(recentOutput)) return { kind: 'authRequired' };
      const result = await fetchFromPid(proc.pid, deps);
      if (result.kind !== 'unavailable') return result;
      await (deps.delay || delay)(250);
    }
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    await stopManagedProbe(proc, exited, deps);
  }
}

let _probePromise = null;
let _probeBackoff = { failures: 0, nextAttemptAt: 0, lastResult: null };

function resetProbeBackoff() {
  _probeBackoff = { failures: 0, nextAttemptAt: 0, lastResult: null };
}

function isReading(result) {
  return result && (result.kind === 'summary' || result.kind === 'models');
}

// A failed probe is remembered along with the wait, so the polls inside the window keep reporting what
// the last attempt found instead of flipping the status bar between "not signed in" and "unavailable".
function recordProbeResult(result, now) {
  if (isReading(result)) {
    resetProbeBackoff();
    return result;
  }
  const failures = _probeBackoff.failures + 1;
  const wait = Math.min(PROBE_BACKOFF_BASE_MS * (2 ** (failures - 1)), PROBE_BACKOFF_MAX_MS);
  _probeBackoff = { failures, nextAttemptAt: now + wait, lastResult: result };
  return result;
}

async function fetchLocalRaw({ livePids = [], allowLaunch = true, findExecutable, deps = {} } = {}) {
  const tried = new Set();
  const askPid = async (pid) => {
    if (tried.has(pid)) return null;
    tried.add(pid);
    const result = await fetchFromPid(pid, deps);
    if (result.kind === 'unavailable') return null;
    if (isReading(result)) resetProbeBackoff();
    return result;
  };

  for (const pid of [...new Set(livePids)].filter(validPid)) {
    const result = await askPid(pid);
    if (result) return result;
  }
  // "Prefer an already-running AGY process, INCLUDING a PTY launched by Switchboard" (#509) names a set
  // of which our own launch is one member. A CLI the user started in their own terminal owns the same
  // quota service, so ask it before spawning a second process next to it.
  for (const pid of await (deps.discoverPids || discoverPids)(deps)) {
    const result = await askPid(pid);
    if (result) return result;
  }

  if (!allowLaunch || typeof findExecutable !== 'function') return { kind: 'unavailable' };
  const now = (deps.now || Date.now)();
  if (_probeBackoff.nextAttemptAt > now) return _probeBackoff.lastResult || { kind: 'unavailable' };
  const executable = findExecutable();
  if (!executable) return { kind: 'unavailable' };
  if (!_probePromise) {
    _probePromise = runManagedProbe(executable, deps)
      .then(result => recordProbeResult(result, now))
      .finally(() => { _probePromise = null; });
  }
  return _probePromise;
}

module.exports = {
  QUOTA_SUMMARY_PATH,
  USER_STATUS_PATH,
  MODEL_CONFIG_PATH,
  parseWindowsNetstat,
  parseLsof,
  parseProcNet,
  parseWindowsTasklist,
  parsePosixPs,
  discoverPids,
  resetProbeBackoff,
  quotaSummaryPayload,
  modelConfigsPayload,
  containsAuthPrompt,
  postJson,
  fetchFromPid,
  fetchLocalRaw,
  runManagedProbe,
};
