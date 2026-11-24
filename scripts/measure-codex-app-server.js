// Measure what Codex' app-server records about a thread it drives (#734): the marker a client can set, what a resume,
// a fork and a compaction do with it, and the order of notifications around a turn and a compaction. One short turn per
// run on the model given (default the smallest one the account accepts today), in a Codex home of its own.
//
// Usage: node scripts/measure-codex-app-server.js <action> --home=<dir> [--thread=<id>] [--version=<x.y.z>]
//          [--model=<id>] [--client=<name>] [--source=<threadSource>]
//   <action>   start | resume | fork | compact. resume, fork and compact need --thread.
//   --home     A directory of its own: CODEX_HOME becomes <dir>/home, the CLI runs in <dir>/work. The account's
//              `auth.json` is copied there from $CODEX_HOME or ~/.codex when missing, so delete <dir> afterwards.
//   --version  Runs a published version through `npx -y @openai/codex@<version>` instead of the installed CLI.
//   --source   The `threadSource` sent with start (default `switchboard`). fork sends none, to see what it inherits.
//
// Prints the model ids `model/list` offers, the thread's `source`, `originator` and `threadSource` as the answer,
// `thread/read` and the rollout's first line report them, whether `thread.path` carried the Windows `\\?\` prefix, the
// turn's outcome and error, and the notification order (deltas left out) with the CLI's text on `error`, warning and
// deprecation notices. Ids, versions, statuses and CLI notices only, no conversation text and no paths. Exits 1 on a
// failed run or turn. The last measurement is in `docs/backend-formats.md` (Codex, "Driving a thread over
// app-server (#734)").
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const action = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ACTIONS = ['start', 'resume', 'fork', 'compact'];
const base = opt('home');
const threadArg = opt('thread');
const version = opt('version');
const model = opt('model', 'gpt-6-luna');
const client = opt('client', 'switchboard_probe');
const source = opt('source', 'switchboard');
function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node scripts/measure-codex-app-server.js start|resume|fork|compact --home=<dir> [--thread=<id>] [--version=<x.y.z>] [--model=<id>] [--client=<name>] [--source=<threadSource>]');
  process.exit(1);
}
if (!ACTIONS.includes(action) || !base) usage();
if (action !== 'start' && !threadArg) usage(`${action} needs --thread`);
// These go onto a shell command line (Codex is a `.cmd` shim on Windows), so each is checked against a narrow shape.
if (version && !/^\d+\.\d+\.\d+$/.test(version)) usage('--version takes x.y.z');
if (!/^[\w.-]+$/.test(model)) usage('--model takes a model id');

const TURN_TIMEOUT_MS = 180000;
const REQUEST_TIMEOUT_MS = 120000;
const SETTLE_MS = 1500;
const EXIT_GRACE_MS = 5000;
const MAX_NOTICE_CHARS = 240;
const PROMPT = 'Reply with exactly the word OK and nothing else.';

const home = path.join(base, 'home');
const work = path.join(base, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const authDst = path.join(home, 'auth.json');
if (!fs.existsSync(authDst)) {
  const authSrc = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  if (!fs.existsSync(authSrc)) usage('No auth.json in $CODEX_HOME or ~/.codex: log in to Codex first.');
  fs.copyFileSync(authSrc, authDst);
}

// No `--stdio`: stdio is the default transport, and 0.129.0 refuses the flag.
const command = version ? `npx -y @openai/codex@${version} app-server` : 'codex app-server';
const child = spawn(command, { shell: true, cwd: work, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
child.stdin.on('error', () => {});

let nextId = 1;
const pending = new Map();
const turnDone = new Map();
const order = [];
const t0 = Date.now();
let buf = '';
let exited = null;
// A missing CLI or a crash closes the pipes; everything still waiting is answered with that, so the run reports it
// instead of draining silently.
child.on('exit', (code) => {
  exited = code;
  for (const resolve of pending.values()) resolve({ error: { message: `app-server exited (${code})` } });
  pending.clear();
  for (const resolve of turnDone.values()) resolve({ status: `app-server exited (${code})` });
  turnDone.clear();
});
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && !msg.method && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); continue; }
    if (msg.id != null && msg.method) {
      // A server request (approval, question): declined, this run asks for nothing that needs one.
      order.push({ ms: Date.now() - t0, request: msg.method });
      send({ id: msg.id, result: { decision: 'decline' } });
      continue;
    }
    if (!msg.method || /delta|startupStatus|rateLimits/i.test(msg.method)) continue;
    const p = msg.params || {};
    // The CLI's own words, for the notices that carry them (a refused model, a deprecation). Never conversation text.
    const notice = msg.method === 'error' ? p.error?.message : /deprecationNotice|warning/i.test(msg.method) ? p.summary ?? p.message : undefined;
    order.push({ ms: Date.now() - t0, method: msg.method, turn: p.turn?.status, item: p.item?.type, status: p.status?.type ?? (typeof p.status === 'string' ? p.status : undefined),
      notice: typeof notice === 'string' ? notice.slice(0, MAX_NOTICE_CHARS) : undefined });
    if (msg.method === 'turn/completed' && p.turn && turnDone.has(p.turn.id)) { turnDone.get(p.turn.id)(p.turn); turnDone.delete(p.turn.id); }
  }
});

function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
function request(method, params) {
  const id = nextId++;
  if (exited !== null) return Promise.resolve({ error: { message: `app-server exited (${exited})` } });
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`no answer to ${method}`)), REQUEST_TIMEOUT_MS).unref();
  });
}
function waitTurn(id) {
  if (exited !== null) return Promise.resolve({ status: `app-server exited (${exited})` });
  return new Promise((resolve, reject) => {
    turnDone.set(id, resolve);
    setTimeout(() => reject(new Error('turn did not complete')), TURN_TIMEOUT_MS).unref();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitOrder(pred, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = order.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}
// `extendedPath`: whether `thread.path` came with the Windows `\\?\` prefix. The path itself is not printed.
const marker = (t) => (t ? { id: t.id, source: t.source, originator: t.originator ?? null, threadSource: t.threadSource ?? null, forkedFromId: t.forkedFromId ?? null, cliVersion: t.cliVersion,
  extendedPath: typeof t.path === 'string' ? t.path.startsWith('\\\\?\\') : null } : null);

// Ends the CLI: closing stdin ends app-server; under `shell: true` `kill()` would only reach the shell, so a process
// still there after the grace period is ended with its tree.
async function shutdown() {
  child.stdin.end();
  const until = Date.now() + EXIT_GRACE_MS;
  while (exited === null && Date.now() < until) await sleep(100);
  if (exited !== null) return;
  if (process.platform === 'win32') {
    // A full path: Windows looks a bare program up in the current directory before PATH.
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise((resolve) => { const k = execFile(taskkill, ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => resolve()); k.stdin?.end(); });
  } else {
    child.kill();
  }
}

function rolloutHeader(threadId) {
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(threadId)) found.push(p);
    }
  })(path.join(home, 'sessions'));
  if (!found.length) return null;
  const text = fs.readFileSync(found[0], 'utf8');
  const lines = text.split('\n');
  let first = null;
  try { const j = JSON.parse(lines[0]); const p = j.payload || {}; first = { type: j.type, originator: p.originator ?? null, source: p.source ?? null, thread_source: p.thread_source ?? null, cli_version: p.cli_version }; } catch { /* not JSON */ }
  return { header: first, sessionMetaLines: lines.filter((l) => l.includes('"type":"session_meta"')).length, compactedLines: lines.filter((l) => l.includes('"type":"compacted"')).length };
}

(async () => {
  const out = { action, cli: version || 'installed', model };
  try {
    const init = await request('initialize', { clientInfo: { name: client, version: '0.0.0' } });
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    out.userAgentVersion = (init.result.userAgent || '').split(' ')[0];
    send({ method: 'initialized' });
    const models = await request('model/list', {});
    out.models = models.error ? models.error.message : (models.result?.data || []).map((m) => m.id);

    let threadId = threadArg;
    if (action === 'start') {
      const r = await request('thread/start', { cwd: work, model, threadSource: source, approvalPolicy: 'never', sandbox: 'read-only' });
      if (r.error) throw new Error(`thread/start: ${r.error.message}`);
      out.answer = marker(r.result.thread);
      threadId = r.result.thread.id;
    } else if (action === 'fork') {
      const r = await request('thread/fork', { threadId: threadArg });
      if (r.error) throw new Error(`thread/fork: ${r.error.message}`);
      out.answer = marker(r.result.thread);
      threadId = r.result.thread.id;
    } else {
      const r = await request('thread/resume', { threadId: threadArg, model });
      if (r.error) throw new Error(`thread/resume: ${r.error.message}`);
      out.answer = marker(r.result.thread);
    }

    if (action === 'compact') {
      const c = await request('thread/compact/start', { threadId });
      if (c.error) throw new Error(`thread/compact/start: ${c.error.message}`);
      out.compactAnswer = c.result;
      // The compaction runs as a turn of its own; its turn/completed is the end.
      const ended = await waitOrder((o) => o.method === 'turn/completed', TURN_TIMEOUT_MS);
      out.turn = ended ? ended.turn : 'no turn/completed';
    } else {
      const t = await request('turn/start', { threadId, input: [{ type: 'text', text: PROMPT }], model, effort: 'low' });
      if (t.error) throw new Error(`turn/start: ${t.error.message}`);
      const done = await waitTurn(t.result.turn.id);
      out.turn = done.status;
      if (done.error) out.turnError = String(done.error.message || JSON.stringify(done.error)).slice(0, MAX_NOTICE_CHARS);
    }
    await sleep(SETTLE_MS);
    const read = await request('thread/read', { threadId, includeTurns: false });
    out.read = read.error ? read.error.message : marker(read.result.thread);
    out.rollout = rolloutHeader(threadId);
  } catch (e) {
    out.error = String(e.message || e);
  }
  out.order = order;
  console.log(JSON.stringify(out, null, 1));
  await shutdown();
  process.exitCode = out.error || (out.turn && out.turn !== 'completed') ? 1 : 0;
  setTimeout(() => process.exit(), 500).unref();
})();
