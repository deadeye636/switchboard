// Measure what Codex' app-server does with a thread it drives (#734, spec 49): the marker a client can set, what a resume,
// a fork and a compaction do with it, the notification order around turns, approvals, questions, history paging, project
// config, image input and how the CLI is launched. Each action is one short run in a Codex home of its own, on the model
// given (default the smallest one the account accepts today).
//
// Usage: node scripts/measure-codex-app-server.js <action> --home=<dir> [options]
//   start      a new thread with a `threadSource` marker and one turn
//   resume     --thread=<id>: resume and one turn
//   fork       --thread=<id>: fork without a marker, and one turn
//   compact    --thread=<id>: resume and `thread/compact/start`
//   hold       --thread=<id>: resume, start a long turn and keep the process for --hold-ms (default 30000) with the
//              thread loaded; the turn usually ends first, so most of the hold is idle. --idle sends no turn at all. Run a
//              second action on the same thread from another shell meanwhile to see two clients meet.
//   edges      four turns on a new thread: plain, interrupted after its first delta, steered after its first delta, and
//              one on a model the server refuses (--refused-model, default gpt-5.4-mini). Prints each turn's notification
//              order, status and error keys.
//   approval   one turn with `approvalPolicy: on-request` and a read-only sandbox that asks for a shell command; the server
//              request is answered with --decision (accept|decline|cancel, default decline).
//   question   one turn that asks the model to use its request_user_input tool; --experimental sends
//              `capabilities.experimentalApi: true` at initialize, --plan sends the turn with the experimental
//              `collaborationMode: plan`. A question is answered with its first option.
//   paging     three turns, then `thread/turns/list` and `thread/items/list` paged with small pages, compared with the
//              items the live `item/completed` notifications carried.
//   trust      no turn: <dir>/work gets a project `.codex/config.toml` naming --project-model (default gpt-5.6-luna), and a
//              `thread/start` without a model shows whether the project file was read. --trusted first marks the folder
//              trusted in the home's `config.toml` (the probe's own home, never the user's).
//   image      two one-image turns, `localImage` with a file path and `image` with a data URL.
//   init       no turn: initialize and `thread/start` without a model, to see the launch options take effect.
// Options:
//   --home       A directory of its own: CODEX_HOME becomes <dir>/home, the CLI runs in <dir>/work. The account's
//                `auth.json` is copied there from $CODEX_HOME or ~/.codex when missing, so delete <dir> afterwards.
//   --version    Runs a published version through `npx -y @openai/codex@<version>` instead of the installed CLI.
//   --exe        Starts this file instead of `codex` on PATH, without a shell: a native `codex.exe`, or a `.js` entry run
//                with this Node (the npm package's `bin/codex.js`).
//   --config     key=value, repeatable: sent as `-c key=value` BEFORE `app-server`.
//   --model, --client, --source (threadSource for start, default `switchboard`), --decision, --experimental, --plan,
//   --refused-model, --project-model.
//
// Prints ids, versions, statuses, key names, counts and the CLI's own text on error, warning and deprecation notices. No
// conversation text and no paths. Exits 1 on a failed run or a turn that did not end as expected (`approval
// --decision=cancel` expects `interrupted`). The last measurement is in `docs/backend-formats.md` (Codex,
// "Driving a thread over app-server (#734)").
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
const opts = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const flag = (name) => args.includes(`--${name}`);
const ACTIONS = ['start', 'resume', 'fork', 'compact', 'hold', 'edges', 'approval', 'question', 'paging', 'trust', 'image', 'init'];
const NEEDS_THREAD = ['resume', 'fork', 'compact', 'hold'];
// Absolute, so `cwd` and the trust key name the same folder the server sees.
const base = opt('home') ? path.resolve(opt('home')) : null;
const holdArg = opt('hold-ms', '30000');
const threadArg = opt('thread');
const version = opt('version');
const exe = opt('exe');
const configs = opts('config');
const model = opt('model', 'gpt-6-luna');
const client = opt('client', 'switchboard_probe');
const source = opt('source', 'switchboard');
const decision = opt('decision', 'decline');
const refusedModel = opt('refused-model', 'gpt-5.4-mini');
const projectModel = opt('project-model', 'gpt-5.6-luna');
function usage(msg, code = 1) {
  if (msg) console.error(msg);
  console.error(`Usage: node scripts/measure-codex-app-server.js ${ACTIONS.join('|')} --home=<dir> [--thread=<id>] [--version=<x.y.z> | --exe=<file>] [--config=<key=value>]... [--model=<id>] [--client=<name>] [--source=<threadSource>] [--decision=accept|decline|cancel] [--experimental] [--plan] [--trusted] [--hold-ms=<ms>] [--idle] [--refused-model=<id>] [--project-model=<id>]`);
  process.exit(code);
}
if (flag('help')) usage(null, 0);
if (!ACTIONS.includes(action) || !base) usage();
if (NEEDS_THREAD.includes(action) && !threadArg) usage(`${action} needs --thread`);
// These can reach a shell command line (Codex is a `.cmd` shim on Windows), so each is checked against a narrow shape.
if (version && !/^\d+\.\d+\.\d+$/.test(version)) usage('--version takes x.y.z');
for (const m of [model, refusedModel, projectModel]) if (!/^[\w.-]+$/.test(m)) usage('a model option takes a model id');
for (const c of configs) if (!/^[\w.]+=[\w."-]+$/.test(c)) usage('--config takes key=value with letters, digits, dots, dashes and quotes');
if (!['accept', 'decline', 'cancel'].includes(decision)) usage('--decision takes accept, decline or cancel');
if (exe && !fs.existsSync(exe)) usage('--exe names no file');
if (exe && version) usage('--exe and --version exclude each other');
if (!/^\d+$/.test(holdArg)) usage('--hold-ms takes milliseconds');
const holdMs = Number(holdArg);
// The trust action writes the folder into a TOML literal key, which cannot hold a single quote.
if (base.includes("'")) usage('--home may not contain a single quote');

const TURN_TIMEOUT_MS = 180000;
const REQUEST_TIMEOUT_MS = 120000;
const SETTLE_MS = 1500;
const EXIT_GRACE_MS = 5000;
const MAX_NOTICE_CHARS = 240;
const PAGE_TURNS = 2;
const PAGE_ITEMS = 3;
const PROMPT = 'Reply with exactly the word OK and nothing else.';
const LONG_PROMPT = 'Write the whole numbers from 1 to 400, one per line, and nothing else.';
const STEER_TEXT = 'Stop counting now and reply with exactly the word STEERED.';
const APPROVAL_PROMPT = 'Run exactly this shell command in the current directory and nothing else: echo probe > probe.txt';
const QUESTION_PROMPT = 'Before answering, use your request_user_input tool to ask me one multiple-choice question with two options about which colour I prefer. Then reply with exactly the word DONE.';
const IMAGE_PROMPT = 'What is the main colour of this image? Reply with one word.';
// A 1x1 red PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

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
if (action === 'trust') {
  fs.mkdirSync(path.join(work, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(work, '.codex', 'config.toml'), `model = "${projectModel}"\n`);
  // --trusted: the home's config marks the folder trusted, as the TUI's trust prompt does; without it the file is removed.
  const homeConfig = path.join(home, 'config.toml');
  if (flag('trusted')) fs.writeFileSync(homeConfig, `[projects.'${work}']\ntrust_level = "trusted"\n`);
  else if (fs.existsSync(homeConfig)) fs.rmSync(homeConfig);
}

// No `--stdio`: stdio is the default transport, and 0.129.0 refuses the flag. `-c` goes before the subcommand.
const cfgArgs = configs.flatMap((c) => ['-c', c]);
const env = { ...process.env, CODEX_HOME: home };
let child;
if (exe) {
  const file = /\.js$/i.test(exe) ? process.execPath : exe;
  const argv = /\.js$/i.test(exe) ? [exe, ...cfgArgs, 'app-server'] : [...cfgArgs, 'app-server'];
  child = spawn(file, argv, { cwd: work, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
} else {
  const command = [version ? `npx -y @openai/codex@${version}` : 'codex', ...cfgArgs, 'app-server'].join(' ');
  child = spawn(command, { shell: true, cwd: work, env, stdio: ['pipe', 'pipe', 'ignore'] });
}
child.stdin.on('error', () => {});

let nextId = 1;
const pending = new Map();
const turnDone = new Map();
const order = [];
const listeners = new Set();
let serverRequestHandler = (msg) => ({ error: { code: -32601, message: `not handled by this probe: ${msg.method}` } });
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
child.on('error', (e) => { order.push({ ms: Date.now() - t0, spawnError: e.code || e.message }); });
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
    for (const l of listeners) l(msg);
    if (msg.id != null && msg.method) {
      const reply = serverRequestHandler(msg);
      order.push({ ms: Date.now() - t0, request: msg.method, paramKeys: Object.keys(msg.params || {}).sort(), reply: reply.error ? 'error' : JSON.stringify(reply.result).slice(0, 80) });
      send({ id: msg.id, ...reply });
      continue;
    }
    if (!msg.method || /delta|startupStatus|rateLimits/i.test(msg.method)) continue;
    const p = msg.params || {};
    // The CLI's own words, for the notices that carry them (a refused model, a deprecation). Never conversation text.
    const notice = msg.method === 'error' ? p.error?.message : /deprecationNotice|warning/i.test(msg.method) ? p.summary ?? p.message : undefined;
    order.push({ ms: Date.now() - t0, method: msg.method, turn: p.turn?.status, item: p.item?.type, status: p.status?.type ? [p.status.type, ...(p.status.activeFlags || [])].join(':') : typeof p.status === 'string' ? p.status : undefined,
      notice: typeof notice === 'string' ? notice.slice(0, MAX_NOTICE_CHARS) : undefined });
    if (msg.method === 'turn/completed' && p.turn && turnDone.has(p.turn.id)) { turnDone.get(p.turn.id)(p.turn); turnDone.delete(p.turn.id); }
  }
});

function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
function request(method, params) {
  const id = nextId++;
  if (exited !== null) return Promise.resolve({ error: { message: `app-server exited (${exited})` } });
  send({ id, method, params });
  return new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) resolve({ error: { message: `no answer to ${method}` } }); }, REQUEST_TIMEOUT_MS).unref();
  });
}
function waitTurn(id) {
  if (exited !== null) return Promise.resolve({ status: `app-server exited (${exited})` });
  return new Promise((resolve) => {
    turnDone.set(id, resolve);
    setTimeout(() => { if (turnDone.delete(id)) resolve({ status: 'timeout' }); }, TURN_TIMEOUT_MS).unref();
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
function waitMessage(pred, ms) {
  return new Promise((resolve) => {
    const l = (msg) => { if (pred(msg)) { listeners.delete(l); resolve(msg); } };
    listeners.add(l);
    setTimeout(() => { if (listeners.delete(l)) resolve(null); }, ms).unref();
  });
}
// `extendedPath`: whether `thread.path` came with the Windows `\\?\` prefix. The path itself is not printed.
const marker = (t) => (t ? { id: t.id, source: t.source, originator: t.originator ?? null, threadSource: t.threadSource ?? null, forkedFromId: t.forkedFromId ?? null, cliVersion: t.cliVersion,
  extendedPath: typeof t.path === 'string' ? t.path.startsWith('\\\\?\\') : null } : null);
const errorShape = (e) => (e ? { keys: Object.keys(e).sort(), codexErrorInfo: e.codexErrorInfo ?? null, message: String(e.message || '').slice(0, MAX_NOTICE_CHARS) } : null);
const text = (t) => [{ type: 'text', text: t }];

// Ends the CLI: closing stdin ends app-server; under `shell: true` `kill()` would only reach the shell, so a process
// still there after the grace period is ended with its tree.
async function shutdown() {
  child.stdin.end();
  const until = Date.now() + EXIT_GRACE_MS;
  while (exited === null && Date.now() < until) await sleep(100);
  out.exitedOnStdinClose = exited !== null;
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
  const lines = fs.readFileSync(found[0], 'utf8').split('\n');
  let first = null;
  try { const j = JSON.parse(lines[0]); const p = j.payload || {}; first = { type: j.type, originator: p.originator ?? null, source: p.source ?? null, thread_source: p.thread_source ?? null, cli_version: p.cli_version }; } catch { /* not JSON */ }
  return { header: first, sessionMetaLines: lines.filter((l) => l.includes('"type":"session_meta"')).length, compactedLines: lines.filter((l) => l.includes('"type":"compacted"')).length };
}

async function newThread(extra = {}) {
  const r = await request('thread/start', { cwd: work, model, threadSource: source, approvalPolicy: 'never', sandbox: 'read-only', ...extra });
  if (r.error) throw new Error(`thread/start: ${r.error.code ?? ''} ${r.error.message}`);
  return r.result;
}

// One turn; `during` gets the turn id once the turn has started and may steer or interrupt it.
async function runTurn(threadId, input, { turnModel = model, during = null } = {}) {
  const mark = order.length;
  // --plan: the experimental collaboration mode the TUI calls plan mode (needs --experimental).
  const mode = flag('plan') ? { collaborationMode: { mode: 'plan', settings: { model: turnModel, reasoning_effort: 'low' } } } : {};
  const t = await request('turn/start', { threadId, input, model: turnModel, effort: 'low', ...mode });
  if (t.error) return { refusedAtStart: errorShape(t.error), order: order.slice(mark) };
  const id = t.result.turn.id;
  const done = waitTurn(id);
  const extra = during ? await during(id) : undefined;
  const turn = await done;
  await sleep(SETTLE_MS);
  return { status: turn.status, error: errorShape(turn.error), extra, order: order.slice(mark).map((o) => ({ ...o, ms: undefined })) };
}

const firstDelta = (turnId) => waitMessage((m) => m.method === 'item/agentMessage/delta' && (!m.params?.turnId || m.params.turnId === turnId), TURN_TIMEOUT_MS);

const ACTION_RUNNERS = {
  async start() {
    const r = await newThread();
    out.answer = marker(r.thread);
    out.turn = await runTurn(r.thread.id, text(PROMPT));
    return r.thread.id;
  },
  async fork() {
    const r = await request('thread/fork', { threadId: threadArg });
    if (r.error) throw new Error(`thread/fork: ${r.error.code ?? ''} ${r.error.message}`);
    out.answer = marker(r.result.thread);
    out.turn = await runTurn(r.result.thread.id, text(PROMPT));
    return r.result.thread.id;
  },
  async resume() {
    const r = await request('thread/resume', { threadId: threadArg, model, excludeTurns: true });
    if (r.error) throw new Error(`thread/resume: ${r.error.code ?? ''} ${r.error.message}`);
    out.answer = marker(r.result.thread);
    out.turn = await runTurn(threadArg, text(PROMPT));
    return threadArg;
  },
  async compact() {
    const r = await request('thread/resume', { threadId: threadArg, model, excludeTurns: true });
    if (r.error) throw new Error(`thread/resume: ${r.error.code ?? ''} ${r.error.message}`);
    out.answer = marker(r.result.thread);
    const mark = order.length;
    const c = await request('thread/compact/start', { threadId: threadArg });
    if (c.error) throw new Error(`thread/compact/start: ${c.error.message}`);
    out.compactAnswer = c.result;
    // The compaction runs as a turn of its own; its turn/completed is the end.
    const ended = await waitOrder((o, i) => i >= mark && o.method === 'turn/completed', TURN_TIMEOUT_MS);
    out.turn = { status: ended ? ended.turn : 'no turn/completed', order: order.slice(mark) };
    return threadArg;
  },
  async hold() {
    const r = await request('thread/resume', { threadId: threadArg, model, excludeTurns: true });
    if (r.error) throw new Error(`thread/resume: ${r.error.code ?? ''} ${r.error.message}`);
    out.answer = marker(r.result.thread);
    if (flag('idle')) {
      // Loaded and idle: no turn at all for the whole hold.
      await sleep(holdMs);
      out.heldIdleMs = holdMs;
      return threadArg;
    }
    // The turn usually ends long before the hold does; the process then stays with the thread loaded and idle.
    out.turn = await runTurn(threadArg, text(LONG_PROMPT), {
      during: async (turnId) => {
        await sleep(holdMs);
        const i = await request('turn/interrupt', { threadId: threadArg, turnId });
        return { interruptAnswer: i.error ? errorShape(i.error) : i.result };
      },
    });
    return threadArg;
  },
  async edges() {
    const { thread } = await newThread();
    out.answer = marker(thread);
    out.plain = await runTurn(thread.id, text(PROMPT));
    out.interrupted = await runTurn(thread.id, text(LONG_PROMPT), {
      during: async (turnId) => {
        await firstDelta(turnId);
        const r = await request('turn/interrupt', { threadId: thread.id, turnId });
        return { interruptAnswer: r.error ? errorShape(r.error) : r.result };
      },
    });
    out.steered = await runTurn(thread.id, text(LONG_PROMPT), {
      during: async (turnId) => {
        await firstDelta(turnId);
        const wrong = await request('turn/steer', { threadId: thread.id, expectedTurnId: 'not-the-active-turn', input: text(STEER_TEXT) });
        const r = await request('turn/steer', { threadId: thread.id, expectedTurnId: turnId, input: text(STEER_TEXT) });
        return { wrongTurnAnswer: wrong.error ? errorShape(wrong.error) : wrong.result, steerAnswer: r.error ? errorShape(r.error) : r.result };
      },
    });
    out.steerIdle = await request('turn/steer', { threadId: thread.id, expectedTurnId: 'none', input: text(STEER_TEXT) }).then((r) => (r.error ? errorShape(r.error) : r.result));
    out.failed = await runTurn(thread.id, text(PROMPT), { turnModel: refusedModel });
    return thread.id;
  },
  async approval() {
    serverRequestHandler = () => ({ result: { decision } });
    const { thread } = await newThread({ approvalPolicy: 'on-request', sandbox: 'read-only' });
    out.answer = marker(thread);
    out.turn = await runTurn(thread.id, text(APPROVAL_PROMPT));
    out.decision = decision;
    out.fileWritten = fs.existsSync(path.join(work, 'probe.txt'));
    return thread.id;
  },
  async question() {
    serverRequestHandler = (msg) => {
      if (msg.method !== 'item/tool/requestUserInput') return { result: { decision: 'decline' } };
      const qs = msg.params?.questions || [];
      out.questionShape = { count: qs.length, keys: qs[0] ? Object.keys(qs[0]).sort() : [], options: qs[0]?.options?.length ?? null,
        optionKeys: qs[0]?.options?.[0] ? Object.keys(qs[0].options[0]).sort() : [], autoResolutionMs: msg.params?.autoResolutionMs ?? null };
      return { result: { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [q.options?.[0]?.label ?? 'yes'] }])) } };
    };
    const { thread } = await newThread();
    out.answer = marker(thread);
    out.turn = await runTurn(thread.id, text(QUESTION_PROMPT));
    return thread.id;
  },
  async paging() {
    const live = [];
    listeners.add((m) => { if (m.method === 'item/completed' && m.params?.item) live.push({ id: m.params.item.id, type: m.params.item.type, turnId: m.params.turnId }); });
    const { thread } = await newThread();
    out.answer = marker(thread);
    const runIds = [];
    listeners.add((m) => { if (m.method === 'turn/started' && m.params?.turn?.id) runIds.push(m.params.turn.id); });
    for (let i = 0; i < 3; i++) out[`turn${i + 1}`] = (await runTurn(thread.id, text(PROMPT))).status;
    out.turnIdsInRunOrder = runIds;
    const turnPages = [];
    let cursor = null;
    do {
      const r = await request('thread/turns/list', { threadId: thread.id, limit: PAGE_TURNS, cursor });
      if (r.error) { turnPages.push({ error: errorShape(r.error) }); break; }
      const res = r.result;
      turnPages.push({ keys: Object.keys(res).sort(), turns: (res.data || res.turns || []).map((t) => ({ id: t.id, status: t.status, items: (t.items || []).length, itemsView: t.itemsView })), cursorType: typeof (res.nextCursor ?? res.cursor) });
      cursor = res.nextCursor ?? null;
    } while (cursor && turnPages.length < 10);
    const itemPages = [];
    cursor = null;
    const listed = [];
    do {
      const r = await request('thread/items/list', { threadId: thread.id, limit: PAGE_ITEMS, cursor });
      if (r.error) { itemPages.push({ error: errorShape(r.error) }); break; }
      const res = r.result;
      const items = res.data || res.items || [];
      // An entry may wrap the item; its own keys are printed once so the wrapping is on record.
      listed.push(...items.map((it) => { const inner = it.item || it; return { id: inner.id, type: inner.type }; }));
      itemPages.push({ keys: Object.keys(res).sort(), count: items.length, entryKeys: items[0] ? Object.keys(items[0]).sort() : [], nextCursor: res.nextCursor === null ? null : typeof res.nextCursor });
      cursor = res.nextCursor ?? null;
    } while (cursor && itemPages.length < 20);
    const liveIds = live.map((x) => x.id);
    const listedIds = listed.map((x) => x.id);
    out.paging = {
      turnPages, itemPages,
      liveItems: live.map((x) => x.type), listedItems: listed.map((x) => x.type),
      liveNotListed: liveIds.filter((id) => !listedIds.includes(id)).length,
      listedNotLive: listedIds.filter((id) => !liveIds.includes(id)).length,
      sameOrder: JSON.stringify(liveIds.filter((id) => listedIds.includes(id))) === JSON.stringify(listedIds.filter((id) => liveIds.includes(id))),
    };
    return thread.id;
  },
  async trust() {
    const r = await request('thread/start', { cwd: work, threadSource: source, approvalPolicy: 'never', sandbox: 'read-only' });
    if (r.error) throw new Error(`thread/start: ${r.error.code ?? ''} ${r.error.message}`);
    out.answer = marker(r.result.thread);
    out.projectModel = projectModel;
    out.startedModel = r.result.model ?? r.result.thread.model ?? null;
    out.projectConfigRead = out.startedModel === projectModel;
    return r.result.thread.id;
  },
  async init() {
    const r = await request('thread/start', { cwd: work, threadSource: source, approvalPolicy: 'never', sandbox: 'read-only' });
    if (r.error) throw new Error(`thread/start: ${r.error.code ?? ''} ${r.error.message}`);
    out.answer = marker(r.result.thread);
    out.startedModel = r.result.model ?? r.result.thread.model ?? null;
    out.configs = configs;
    return r.result.thread.id;
  },
  async image() {
    const file = path.join(work, 'probe.png');
    fs.writeFileSync(file, Buffer.from(PNG_BASE64, 'base64'));
    const { thread } = await newThread();
    out.answer = marker(thread);
    const strip = (t) => ({ status: t.status, error: t.error, refusedAtStart: t.refusedAtStart });
    out.localImage = strip(await runTurn(thread.id, [{ type: 'text', text: IMAGE_PROMPT }, { type: 'localImage', path: file }]));
    out.dataUrl = strip(await runTurn(thread.id, [{ type: 'text', text: IMAGE_PROMPT }, { type: 'image', url: `data:image/png;base64,${PNG_BASE64}` }]));
    return thread.id;
  },
};

const out = { action, cli: exe ? (/\.js$/i.test(exe) ? 'node entry' : 'native exe') : version || 'installed', model };
(async () => {
  try {
    const init = await request('initialize', { clientInfo: { name: client, version: '0.0.0' }, ...(flag('experimental') ? { capabilities: { experimentalApi: true } } : {}) });
    if (init.error) throw new Error(`initialize: ${init.error.message}`);
    out.userAgentVersion = (init.result.userAgent || '').split(' ')[0];
    send({ method: 'initialized' });
    const models = await request('model/list', {});
    out.models = models.error ? models.error.message : (models.result?.data || []).map((m) => m.id);
    const threadId = await ACTION_RUNNERS[action]();
    const read = await request('thread/read', { threadId, includeTurns: false });
    out.read = read.error ? read.error.message : marker(read.result.thread);
    out.rollout = rolloutHeader(threadId);
  } catch (e) {
    out.error = String(e.message || e);
  }
  out.order = order.length > 40 ? `${order.length} events` : order;
  await shutdown();
  console.log(JSON.stringify(out, null, 1));
  // A `cancel` decision interrupts its turn on purpose.
  const expected = action === 'approval' && decision === 'cancel' ? 'interrupted' : 'completed';
  const failedTurn = out.turn && typeof out.turn === 'object' && out.turn.status && out.turn.status !== expected;
  process.exitCode = out.error || failedTurn ? 1 : 0;
  setTimeout(() => process.exit(), 500).unref();
})();
