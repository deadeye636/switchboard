#!/usr/bin/env node
// scripts/perf-sample.js — watch a running instance over hours and write down what it costs.
//
// `drive-app.js` answers "what is on screen right now". This answers the other question: what does the
// app do to the machine while nobody is looking. It attaches to the same debugging port, asks every page
// for Chromium's own counters once per interval, and appends one JSON line per sample. Nothing is
// injected into the app and nothing is clicked — the pages are read, not driven, so a sampler left
// running for a working day cannot be the reason the app misbehaved.
//
// The counters that matter are the ones that should NOT grow: `Nodes`, `JSEventListeners` and
// `JSHeapUsedSize`. A renderer that ends the day with three times the listeners it started with is
// leaking one per something, and the sample file says per what — it carries the wall clock next to the
// number. The cumulative ones (`ScriptDuration`, `TaskDuration`, `LayoutCount`) never fall; what is
// readable there is their RATE, which is why the report prints per-hour figures rather than totals.
//
//   1. Start an instance with the port open:
//        npm run start:debug                                  the dev build, dev database
//        "<install dir>/Switchboard.exe" --remote-debugging-port=9222    the INSTALLED build, real data
//   2. Sample it, in the background, for as long as the question needs:
//        node scripts/perf-sample.js --minutes=240 --out=perf.jsonl
//   3. Read what came out — at any time, the file is complete after every line:
//        node scripts/perf-sample.js report perf.jsonl
//
// An instance that is ALREADY running has no debugging port and cannot be given one without a restart,
// which on a live instance means killing every session in it. `--os-only` is the measurement that costs
// nothing: it skips CDP and records the process tree — count, working set, CPU seconds — which is where a
// leak shows up as a number that only ever climbs. It answers "is something growing"; it cannot answer
// "in which renderer, and is it nodes or listeners". Take that one at the next restart the user was
// going to do anyway.
//
// Options: --interval=<seconds> (default 30), --minutes=<n> (default: until killed),
// --out=<file> (default `.claude/scratchpad/perf-<timestamp>.jsonl`, which is gitignored),
// --port=<n> (default SWITCHBOARD_DEBUG_PORT or 9222), --os-only (processes only, no debugging port).
//
// No dependency: Node 22 ships a global WebSocket, and CDP is JSON over one.
'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULT_PORT = process.env.SWITCHBOARD_DEBUG_PORT || 9222;

// The counters worth keeping. Chromium reports a few dozen; the rest are noise for this question, and a
// sample file that stays small is a sample file somebody actually reads.
const KEEP = [
  'Timestamp', 'ProcessTime', 'ThreadTime',
  'Documents', 'Frames', 'Nodes', 'JSEventListeners', 'MediaKeySessions',
  'JSHeapUsedSize', 'JSHeapTotalSize',
  'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
  'ScriptDuration', 'V8CompileDuration', 'TaskDuration',
];

// Counters that are supposed to come back down. Growth across a long run is the finding.
const LEAK_SUSPECTS = ['Nodes', 'JSEventListeners', 'JSHeapUsedSize', 'Documents', 'Frames'];

// Counters that only ever climb: their rate is the signal, their total is not.
const CUMULATIVE = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
  'ScriptDuration', 'V8CompileDuration', 'TaskDuration', 'ProcessTime', 'ThreadTime'];

// ---------------------------------------------------------------------------- CDP

async function pageTargets(endpoint) {
  // Bounded on purpose. A port that is open but has stopped answering is one of the failures this tool
  // exists to catch, and an unbounded `fetch` would meet it by hanging forever — one stalled tick, then
  // another every interval behind it, and a sample file that simply stops without saying why.
  const res = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return list.filter(t => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}

// ONE session per page, held across ticks. That is not an optimisation, it is the difference between
// numbers and zeroes: `Performance.enable` starts the duration and count metrics from zero FOR THE
// SESSION THAT ENABLED THEM. Attaching afresh each tick therefore reports `ScriptDuration: 0` and
// `LayoutCount: 0` forever, and the app reads as idle no matter what it is doing. Measured against a
// real window: every duration and every count came back 0 across consecutive samples, while `Nodes` and
// `JSHeapUsedSize` — which are absolute, not session-scoped — were right. So the session is kept, and
// the cost is the reconnect handling below: a window that closed is dropped, a page that comes back
// gets a new session, and a reload resets its own counters (the report segments on that).
const sessions = new Map();                  // target id -> connection

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const fail = (err) => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  };
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('attach failed')));
  });
  ws.addEventListener('close', () => fail(new Error('session closed')));
  ws.addEventListener('error', () => fail(new Error('session failed')));
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id === undefined) return;              // an event, not a reply to anything we asked
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'CDP error'));
    else waiter.resolve(msg.result);
  });
  return {
    ready,
    get closed() { return closed; },
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error('session closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // Every call is bounded: an unanswered one must cost this tick, not the run.
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 5000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try { ws.send(JSON.stringify({ id, method, params })); } catch (e) {
          pending.delete(id); clearTimeout(timer); reject(e);
        }
      });
    },
    close() { closed = true; try { ws.close(); } catch { /* already gone */ } },
  };
}

async function sessionFor(target) {
  const cached = sessions.get(target.id);
  if (cached && !cached.closed) return cached;
  if (cached) sessions.delete(target.id);
  const conn = connect(target.webSocketDebuggerUrl);
  const attached = new Promise((_, reject) => setTimeout(() => reject(new Error('attach timeout')), 5000));
  await Promise.race([conn.ready, attached]);
  await conn.send('Performance.enable', { timeDomain: 'timeTicks' });
  sessions.set(target.id, conn);
  return conn;
}

// Windows come and go over a long run — a settings window, a detached session, a diff view. Drop the
// sessions of pages that are no longer listed rather than holding sockets open against the dead.
function pruneSessions(liveIds) {
  for (const [id, conn] of sessions) {
    if (!liveIds.has(id)) { conn.close(); sessions.delete(id); }
  }
}

async function samplePage(target) {
  const conn = await sessionFor(target);
  const res = await conn.send('Performance.getMetrics');
  const metrics = {};
  for (const m of res?.metrics || []) {
    if (KEEP.includes(m.name)) metrics[m.name] = m.value;
  }
  return { title: target.title, url: target.url, id: target.id, metrics };
}

// ---------------------------------------------------------------------------- OS processes

// The page counters describe one renderer. The other half of the cost — the main process, the GPU
// process, the utility processes, and every PTY the app spawned — is only visible from outside.
function osProcesses() {
  return new Promise((resolve) => {
    const done = (v) => resolve(v);
    if (process.platform === 'win32') {
      // `-InputObject @(…)` rather than a pipe into ConvertTo-Json, so that NO match still prints `[]`.
      // Piped, an empty result prints nothing at all, and "the app is not running" would then be
      // indistinguishable from "the query failed" — the one window where the reading matters most.
      const ps = 'ConvertTo-Json -Compress -InputObject @(Get-Process -Name Switchboard,electron '
        + '-ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,CPU)';
      // PowerShell 7 where it exists, Windows PowerShell 5.1 as the fallback: the query works in both.
      runFirst(['pwsh', 'powershell'], ['-NoProfile', '-NonInteractive', '-Command', ps],
        (err, stdout) => {
          // A non-zero exit is not a failure here: `-Command` returns 1 whenever the pipeline wrote an
          // error record, which a -Name matching nothing does even under -ErrorAction SilentlyContinue.
          // The rows are on stdout either way, so the parse decides, not the exit code. Empty stdout IS
          // a failure now: the command above always prints something when it ran.
          try {
            const text = String(stdout).trim();
            if (!text) return done(null);
            // Windows PowerShell 5.1 has no -AsArray: a single process comes back as a bare object.
            const parsed = JSON.parse(text);
            const rows = parsed === null ? [] : (Array.isArray(parsed) ? parsed : [parsed]);
            done(rows.map(r => ({ pid: r.Id, name: r.ProcessName, rss: r.WorkingSet64, cpuSec: r.CPU })));
          } catch { done(null); }
        });
      return;
    }
    execFile('ps', ['-axo', 'pid=,comm=,rss=,time='], { timeout: 10000 }, (err, stdout) => {
      if (err) return done(null);
      const rows = [];
      for (const line of String(stdout).split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.*?)\s+(\d+)\s+([\d:.]+)$/);
        if (!m) continue;
        if (!/switchboard|electron/i.test(m[2])) continue;
        rows.push({ pid: Number(m[1]), name: m[2], rss: Number(m[3]) * 1024, cpuSec: hmsToSeconds(m[4]) });
      }
      done(rows);
    });
  });
}

// Try each executable in turn; the first one that runs owns the answer.
function runFirst(exes, args, cb) {
  const [exe, ...rest] = exes;
  if (!exe) return cb(new Error('no shell found'));
  execFile(exe, args, { timeout: 10000 }, (err, stdout) => {
    if (err && err.code === 'ENOENT') return runFirst(rest, args, cb);
    cb(err, stdout);
  });
}

function hmsToSeconds(s) {
  const parts = String(s).split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// ---------------------------------------------------------------------------- sampling

async function sample(opts) {
  const endpoint = `http://127.0.0.1:${opts.port}`;
  const out = fs.createWriteStream(opts.out, { flags: 'a' });
  // An unhandled 'error' on a stream throws. A full disk or a locked file would otherwise end a run of
  // many hours with a stack trace and no summary — say what happened and keep the samples already written.
  out.on('error', (e) => console.error(`\nwrite failed: ${e.message}`));
  const started = Date.now();
  let ticks = 0;
  let missed = 0;
  let busy = false;

  const tick = async () => {
    // The interval does not await the tick, so a slow one would otherwise be overtaken by the next.
    if (busy) return;
    busy = true;
    try {
      await runTick();
    } finally {
      busy = false;
    }
  };

  const runTick = async () => {
    const at = new Date().toISOString();
    let pages = [];
    let reachable = true;
    if (opts.osOnly) {
      const procs = await osProcesses();
      out.write(`${JSON.stringify({ at, osOnly: true, procs })}\n`);
      ticks += 1;
      const min = ((Date.now() - started) / 60000).toFixed(1);
      process.stdout.write(`${ticks} samples · ${min} min · ${procs === null ? 'query failed' : `${procs.length} process(es)`}   `);
      return;
    }
    try {
      const targets = await pageTargets(endpoint);
      pruneSessions(new Set(targets.map(t => t.id)));
      pages = await Promise.all(targets.map(t => samplePage(t).catch(() => null)));
      pages = pages.filter(Boolean);
    } catch {
      reachable = false;                 // the app is not running, or not listening — keep sampling
      missed += 1;                       // so a restart in the middle shows up as a gap, not an end
      pruneSessions(new Set());          // whatever we held is stale now
    }
    const procs = await osProcesses();
    out.write(`${JSON.stringify({ at, reachable, pages, procs })}\n`);
    ticks += 1;
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    process.stdout.write(`\r${ticks} samples · ${mins} min · ${pages.length} page(s)${reachable ? '' : ' · app unreachable'}   `);
  };

  await tick();
  const timer = setInterval(tick, opts.interval * 1000);

  const stop = () => {
    clearInterval(timer);
    out.end();
    console.log(`\n${ticks} samples in ${opts.out}${missed ? ` (${missed} while the app was unreachable)` : ''}`);
    console.log(`read it with: node scripts/perf-sample.js report ${opts.out}`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  if (opts.minutes) setTimeout(stop, opts.minutes * 60000);
}

// ---------------------------------------------------------------------------- report

// A page is identified by its URL without the query, so a detached session window stays one series while
// the main window stays another. Its id changes on reload; its URL does not.
const seriesKey = (p) => `${String(p.url).split('?')[0].split('/').pop() || p.url}${/detached/.test(p.url) ? ' (detached)' : ''}`;

function report(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return console.log('empty sample file');
  const series = new Map();                    // key -> [{at, metrics}]
  const procSamples = [];
  // Killing a detached run mid-write leaves a half-flushed last line. Every timestamp here comes from a
  // record that actually parsed, so a truncated tail costs that one sample and nothing else.
  let first = Infinity;
  let last = -Infinity;
  let parsed = 0;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const at = Date.parse(rec.at);
    if (!Number.isFinite(at)) continue;
    parsed += 1;
    if (at < first) first = at;
    if (at > last) last = at;
    for (const p of rec.pages || []) {
      const key = seriesKey(p);
      if (!series.has(key)) series.set(key, []);
      series.get(key).push({ at, metrics: p.metrics });
    }
    if (rec.procs) procSamples.push({ at, procs: rec.procs });
  }
  if (!parsed) return console.log('no readable samples in that file');

  const hours = Math.max((last - first) / 3600000, 1 / 3600);
  console.log(`${parsed} samples over ${hours.toFixed(2)} h — ${new Date(first).toLocaleString()} → ${new Date(last).toLocaleString()}\n`);
  // Every rate below is a per-hour extrapolation. Over a few minutes that number is arithmetic, not
  // evidence: one garbage collection or one opened tab decides it. Say so rather than let it be quoted.
  if (hours < 0.5) console.log('short run — the per-hour figures are extrapolated from minutes; treat them as a smoke test, not a finding\n');

  if (!series.size) console.log('(no page samples — this run was --os-only)');

  for (const [key, points] of series) {
    // A restart resets every counter. Report the last unbroken stretch rather than a delta that spans
    // the reset, which would read as a large drop and mean nothing. EVERY cumulative counter is
    // consulted, not one named one: a build that does not report the counter you picked would leave the
    // detection silently switched off, which looks exactly like a run that never restarted.
    let start = 0;
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1].metrics;
      const cur = points[i].metrics;
      const wentBack = CUMULATIVE.some(n => typeof cur[n] === 'number' && typeof prev[n] === 'number' && cur[n] < prev[n]);
      if (wentBack) start = i;
    }
    const seg = points.slice(start);
    if (seg.length < 2) { console.log(`${key}: only ${seg.length} sample(s), nothing to compare\n`); continue; }
    const spanH = Math.max((seg[seg.length - 1].at - seg[0].at) / 3600000, 1 / 3600);
    console.log(`## ${key}  (${seg.length} samples, ${spanH.toFixed(2)} h${start ? ', after a restart mid-run' : ''})`);

    const rows = [];
    for (const name of [...LEAK_SUSPECTS, ...CUMULATIVE]) {
      const a = seg[0].metrics[name];
      const b = seg[seg.length - 1].metrics[name];
      if (a === undefined || b === undefined) continue;
      const peak = Math.max(...seg.map(s => s.metrics[name] ?? 0));
      const perHour = (b - a) / spanH;
      const cumulative = CUMULATIVE.includes(name);
      const grew = !cumulative && a > 0 && (b - a) / a > 0.25 && b - a > 0;
      rows.push({ name, a, b, peak, perHour, cumulative, grew });
    }
    const w = Math.max(...rows.map(r => r.name.length));
    for (const r of rows) {
      const fmt = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(Math.abs(n) < 10 ? 2 : 0));
      const tail = r.cumulative ? `+${fmt(r.perHour)}/h` : `first ${fmt(r.a)} → last ${fmt(r.b)} (peak ${fmt(r.peak)}, ${fmt(r.perHour)}/h)`;
      console.log(`  ${r.name.padEnd(w)}  ${tail}${r.grew ? '   <-- grew' : ''}`);
    }
    console.log('');
  }

  if (procSamples.length) {
    // The page series is not the only thing a restart invalidates. Two consecutive samples that share no
    // process id at all are two different runs of the app, and a working-set delta across that boundary
    // compares one run's memory with another's. A pid set is the honest test here: summed CPU seconds
    // also falls when a single renderer closes, which is not a restart.
    let start = 0;
    for (let i = 1; i < procSamples.length; i += 1) {
      const prev = new Set(procSamples[i - 1].procs.map(p => p.pid));
      const cur = procSamples[i].procs.map(p => p.pid);
      if (prev.size && cur.length && !cur.some(pid => prev.has(pid))) start = i;
    }
    const seg = procSamples.slice(start);
    const withProcs = seg.filter(s => s.procs.length);
    const down = seg.length - withProcs.length;
    console.log(`## processes${start ? '  (after a restart mid-run)' : ''}`);
    if (withProcs.length < 2) {
      console.log(`  only ${withProcs.length} sample(s) with the app running, nothing to compare\n`);
    } else {
      const a = withProcs[0];
      const b = withProcs[withProcs.length - 1];
      const spanH = Math.max((b.at - a.at) / 3600000, 1 / 3600);
      const sum = (s, f) => s.procs.reduce((n, p) => n + (p[f] || 0), 0);
      const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
      console.log(`  count      first ${a.procs.length} → last ${b.procs.length}`);
      console.log(`  rss        first ${mb(sum(a, 'rss'))} → last ${mb(sum(b, 'rss'))} (${mb((sum(b, 'rss') - sum(a, 'rss')) / spanH)}/h)`);
      console.log(`  rss peak   ${mb(Math.max(...withProcs.map(s => sum(s, 'rss'))))}`);
      const cpu = sum(b, 'cpuSec') - sum(a, 'cpuSec');
      if (cpu >= 0) console.log(`  cpu        ${cpu.toFixed(0)} s over ${spanH.toFixed(2)} h = ${((cpu / (spanH * 3600)) * 100).toFixed(1)}% of one core`);
      // "The app was not running" is a finding, not a gap — say it rather than let the samples vanish.
      if (down) console.log(`  down       ${down} sample(s) with no process at all`);
      console.log('');
    }
  }
}

// ---------------------------------------------------------------------------- cli

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'report') {
    if (!argv[1]) { console.error('usage: node scripts/perf-sample.js report <file.jsonl>'); process.exit(2); }
    return report(argv[1]);
  }
  const flag = (name, fallback) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.split('=').slice(1).join('=');
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Default into the gitignored scratchpad rather than the repo root: a sample file is working
  // material, and one that lands in `git status` is one somebody commits by accident.
  const dir = fs.existsSync('.claude/scratchpad') ? '.claude/scratchpad/' : '';
  const opts = {
    port: Number(flag('port', DEFAULT_PORT)),
    interval: Number(flag('interval', 30)),
    minutes: Number(flag('minutes', 0)) || 0,
    osOnly: argv.includes('--os-only'),
    out: flag('out', `${dir}perf-${stamp}.jsonl`),
  };
  try {
    if (!opts.osOnly) await pageTargets(`http://127.0.0.1:${opts.port}`);
  } catch {
    console.error(`no debugger on 127.0.0.1:${opts.port} — start the app with a debugging port:`);
    console.error('  npm run start:debug                             (dev build, dev database)');
    console.error('  "<install dir>/Switchboard.exe" --remote-debugging-port=9222   (installed build)');
    console.error('…or measure the instance that is already running, without restarting it: --os-only');
    process.exit(1);
  }
  console.log(`sampling ${opts.osOnly ? 'processes only' : 'pages + processes'} every ${opts.interval}s`
    + `${opts.minutes ? ` for ${opts.minutes} min` : ' until Ctrl-C'} into ${opts.out}`);
  await sample(opts);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
