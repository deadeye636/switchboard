// Measure how long Codex' prompt cache holds a thread's own prefix (#734, spec 45's `maxRefreshMs`). One app-server, one
// thread per gap. Each thread's first turn carries a filler text of its own, seeded per run so nothing else can have
// cached it (about 6k tokens: pseudo-words tokenise poorly; the CLI's own instructions make up the rest of a first turn
// of about 20k). The second turn follows after the gap. A hit is a second turn whose cached tokens grew over
// the first turn's by more than half of the first turn's uncached part (`thread/tokenUsage/updated` →
// `last.cachedInputTokens`).
//
// Usage: node scripts/measure-codex-cache-bound.js --home=<dir> [--gaps=<s,s,...>] [--model=<id>]
//   --home   A directory of its own: CODEX_HOME becomes <dir>/home, the CLI runs in <dir>/work. The account's `auth.json` is
//            copied there from $CODEX_HOME or ~/.codex when missing, so delete <dir> afterwards.
//   --gaps   Seconds between a thread's two turns (default 240,300,420,600,900,1800,3600). The run lasts as long as the
//            largest gap plus a few seconds per thread.
//   --model  Default `gpt-6-luna`, the smallest model the account accepted when this was written.
//
// Prints one line per thread: gap, verdict and the token figures. Figures only, no conversation text and no paths; exits 1
// when a turn did not complete. Costs two short turns per gap. The last measurement is in `docs/backend-formats.md`
// ("How long Codex' cache holds (#734)").
'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const base = opt('home');
const GAPS = opt('gaps', '240,300,420,600,900,1800,3600').split(',').map(Number);
const MODEL = opt('model', 'gpt-6-luna');
if (!base || GAPS.some((n) => !Number.isFinite(n) || n < 0) || !/^[\w.-]+$/.test(MODEL)) {
  console.error('Usage: node scripts/measure-codex-cache-bound.js --home=<dir> [--gaps=<s,s,...>] [--model=<id>]');
  process.exit(1);
}
const TURN_TIMEOUT_MS = 180000;
const REQUEST_TIMEOUT_MS = 120000;
const EXIT_GRACE_MS = 5000;
// Seeds the filler: a second run inside the cache window must not resend the first run's text.
const RUN_SEED = Date.now() % 100000;
const USAGE_SETTLE_MS = 1500;
const FILLER_WORDS = 2600;
const PROMPT = 'Reply with exactly the word OK and nothing else.';

const home = path.join(base, 'home');
const work = path.join(base, 'work');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const authDst = path.join(home, 'auth.json');
if (!fs.existsSync(authDst)) {
  const authSrc = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  if (!fs.existsSync(authSrc)) { console.error('No auth.json in $CODEX_HOME or ~/.codex: log in to Codex first.'); process.exit(1); }
  fs.copyFileSync(authSrc, authDst);
}

// A shell because Codex is a `.cmd` shim on Windows. The command line is a constant.
const child = spawn('codex app-server', { shell: true, cwd: work, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
child.stdin.on('error', () => {});

let nextId = 1;
const pending = new Map();
const turnWaiters = new Map();
const usage = new Map();
let buf = '';
let exited = null;
// A missing CLI or a crash closes the pipes; everything still waiting is answered with that instead of draining silently.
child.on('exit', (code) => {
  exited = code;
  for (const resolve of pending.values()) resolve({ error: { message: `app-server exited (${code})` } });
  pending.clear();
  for (const resolve of turnWaiters.values()) resolve({ status: `app-server exited (${code})` });
  turnWaiters.clear();
});
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); continue; }
    if (m.id != null && m.method) { send({ id: m.id, result: { decision: 'decline' } }); continue; }
    if (m.method === 'thread/tokenUsage/updated') usage.set(m.params.turnId, m.params.tokenUsage.last);
    if (m.method === 'turn/completed') {
      const w = turnWaiters.get(m.params.turn.id);
      if (w) { turnWaiters.delete(m.params.turn.id); w(m.params.turn); }
    }
  }
});
function send(o) { child.stdin.write(JSON.stringify(o) + '\n'); }
function request(method, params) {
  const id = nextId++;
  if (exited !== null) return Promise.resolve({ error: { message: `app-server exited (${exited})` } });
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve({ error: { message: `no answer to ${method}` } }); }, REQUEST_TIMEOUT_MS).unref();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Closing stdin ends app-server; under `shell: true` `kill()` would only reach the shell, so a process still there after
// the grace period is ended with its tree.
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

// Deterministic pseudo-words, different for every seed.
function filler(seed) {
  const syl = ['ka', 'lo', 'mi', 'ten', 'ro', 'va', 'shu', 'pel', 'dri', 'om', 'zan', 'qui', 'bre', 'ux', 'fal', 'nir'];
  let x = (seed * 2654435761) % 4294967296;
  const words = [];
  for (let i = 0; i < FILLER_WORDS; i++) {
    let w = '';
    for (let k = 0; k < 2 + (i % 3); k++) { x = (x * 1103515245 + 12345) % 2147483648; w += syl[x % syl.length]; }
    words.push(w);
  }
  return words.join(' ');
}

async function turn(threadId, text) {
  const r = await request('turn/start', { threadId, input: [{ type: 'text', text }], model: MODEL, effort: 'low' });
  if (r.error) return { status: `refused: ${r.error.message}`, usage: null };
  const id = r.result.turn.id;
  const done = exited !== null ? { status: `app-server exited (${exited})` } : await new Promise((resolve) => {
    turnWaiters.set(id, resolve);
    setTimeout(() => resolve({ status: 'timeout' }), TURN_TIMEOUT_MS).unref();
  });
  await sleep(USAGE_SETTLE_MS); // the usage notification can land just after the completion
  return { status: done.status, usage: usage.get(id) || null };
}

(async () => {
  let failed = false;
  const init = await request('initialize', { clientInfo: { name: 'switchboard_probe', version: '0.0.0' } });
  if (init.error) {
    console.log(JSON.stringify({ error: `initialize: ${init.error.message}` }));
    await shutdown();
    process.exit(1);
  }
  send({ method: 'initialized' });
  console.log(JSON.stringify({ cli: (init.result.userAgent || '').split(' ')[0], model: MODEL, gaps: GAPS }));
  const jobs = [];
  for (const [idx, gap] of GAPS.entries()) {
    const t = await request('thread/start', { cwd: work, model: MODEL, threadSource: 'switchboard', approvalPolicy: 'never', sandbox: 'read-only' });
    if (t.error) { failed = true; console.log(JSON.stringify({ gap, error: `thread/start: ${t.error.message}` })); continue; }
    const threadId = t.result.thread.id;
    const first = await turn(threadId, `Reference text ${idx} (ignore its content):\n${filler(RUN_SEED + idx)}\n\n${PROMPT}`);
    const t1 = Date.now();
    if (first.status !== 'completed') { failed = true; console.log(JSON.stringify({ gap, first: first.status })); continue; }
    jobs.push((async () => {
      await sleep(Math.max(0, gap * 1000 - (Date.now() - t1)));
      const second = await turn(threadId, PROMPT);
      if (second.status !== 'completed') failed = true;
      const u1 = first.usage;
      const u2 = second.usage;
      const own = u1 ? u1.inputTokens - u1.cachedInputTokens : null;
      const gained = u1 && u2 ? u2.cachedInputTokens - u1.cachedInputTokens : null;
      const verdict = own && gained != null ? (gained > own * 0.5 ? 'hit' : 'miss') : 'unknown';
      console.log(JSON.stringify({ gap, actualGapS: Math.round((Date.now() - t1) / 1000), status: second.status, verdict,
        firstInput: u1?.inputTokens, firstCached: u1?.cachedInputTokens, secondInput: u2?.inputTokens, secondCached: u2?.cachedInputTokens }));
    })());
  }
  await Promise.all(jobs);
  await shutdown();
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(), 500).unref();
})();
