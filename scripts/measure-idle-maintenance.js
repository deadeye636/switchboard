// Measure what idle maintenance assumes about the two pipe-driven backends (#827, spec 45): whether a sent turn has a key
// known at send time, what a compaction looks like on the pipe and in the session's file, whether Pi refuses a prompt in
// the gap before `agent_start` and during a compaction, whether a warm turn gets a new title, and where `usage` lands. It
// prints line types, ids, flags, key names and up to 100 characters of Pi's own refusal, never the conversation or a path.
// It costs a few short model turns, one large turn on Pi and one compaction per backend, on the smallest model, and leaves
// one session of each in the stores (it prints the ids). It exits 1 when a backend's measurement did not complete.
//
// Usage: node scripts/measure-idle-maintenance.js [--only=claude|pi|claude-refused-compact|claude-large-compact] [--help]
//   `claude-refused-compact` runs only the declined `/compact` (an empty session; no model turn is asked for).
//   `claude-large-compact` runs a large turn, a short one and a `/compact`, and prints whether `compact_boundary` came
//   before the `result` (one large Haiku turn and one compaction of it).
//   Run it from an empty directory you trust: Windows looks up a bare program there first. Pi's session goes to
//   `pi-sessions` in that directory; Claude's goes to its own store under $CLAUDE_CONFIG_DIR or the default home.
// The last measurement is in `docs/backend-formats.md` ("What idle maintenance can rely on").
'use strict';

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

if (process.argv.includes('--help')) {
  console.log('node scripts/measure-idle-maintenance.js [--only=claude|pi|claude-refused-compact|claude-large-compact]   (from an empty directory you trust; costs model turns)');
  process.exit(0);
}

const STEP_TIMEOUT_MS = 180000;
const STOP_TIMEOUT_MS = 15000;
const SETTLE_MS = 3000;
const MAX_ERROR_CHARS = 100;
const FILLER_NUMBERS = 25000;
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const started = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : id);

// The paths under which a line carries a `usage` object, so a reader can see where the figures land.
function usagePaths(value, at = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    const here = at ? `${at}.${key}` : key;
    return key === 'usage' ? [here] : usagePaths(inner, here, depth + 1);
  });
}

function start(name, command, extraEnv, summarize) {
  const env = { ...process.env, ...extraEnv };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // A shell because Pi is a `.cmd` shim on Windows. Both command lines are constants, nothing is interpolated.
  const child = spawn(command, { env, shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const waiters = new Set();
  let exited = false;
  const say = (text) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${name} ${text}`);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const text = summarize(msg);
    if (text) say(text);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.delete(w); w.resolve(msg); }
  });
  child.once('exit', (code) => {
    exited = true;
    say(`process exit ${code}`);
    for (const w of [...waiters]) { waiters.delete(w); w.resolve(null); }
  });
  return {
    say,
    write: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    until(match, ms = STEP_TIMEOUT_MS) {
      return new Promise((resolve) => {
        const w = { match, resolve };
        waiters.add(w);
        setTimeout(() => { if (waiters.delete(w)) { say('step timed out'); resolve(null); } }, ms);
      });
    },
    async stop() {
      child.stdin.end();
      for (let waited = 0; !exited && waited < STOP_TIMEOUT_MS; waited += 200) await sleep(200);
      if (exited) return;
      say('forced stop');
      if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => {});
      else child.kill();
    },
  };
}

// --- claude-native's launch shape, without user settings or MCP servers ---

function summarizeClaude(msg) {
  if (msg.type === 'stream_event') return '';
  const parts = [`${msg.type}${msg.subtype ? `/${msg.subtype}` : ''}`];
  if (msg.uuid) parts.push(`uuid=${short(msg.uuid)}`);
  if (msg.isReplay) parts.push('replay');
  if (msg.status) parts.push(`status=${msg.status}`);
  if (msg.message && msg.message.model) parts.push(`model=${msg.message.model}`);
  const usage = usagePaths(msg);
  if (usage.length) parts.push(`usage@${usage.join(',')}`);
  return parts.join(' ');
}

function claudeStoreFile(sessionId) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const root = path.join(home, 'projects');
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function contentText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b) => (b && b.text) || '').join('') : '';
}

async function measureClaude() {
  const c = start('claude', 'claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio --strict-mcp-config --setting-sources project', {}, summarizeClaude);
  const isEnd = (m) => m.type === 'result';
  const user = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', ...extra });
  let sessionId = null;
  let sawBoundary = false;
  const identity = c.until((m) => {
    sessionId = m.session_id || sessionId;
    sawBoundary = sawBoundary || (m.type === 'system' && m.subtype === 'compact_boundary');
    return false;
  }, STEP_TIMEOUT_MS * 3);

  c.say('--- warm turn, no key of ours');
  c.write(user('Reply with the single word: warm'));
  await c.until(isEnd);

  const chosen = crypto.randomUUID();
  c.say(`--- warm turn carrying uuid=${short(chosen)}`);
  c.write(user('Reply with the single word: keyed', { uuid: chosen }));
  await c.until(isEnd);

  c.say('--- /compact');
  c.write(user('/compact'));
  await c.until(isEnd);
  await sleep(SETTLE_MS);
  await c.stop();
  void identity;

  if (!sessionId) { c.say('no session id seen'); return false; }
  c.say(`session ${sessionId}`);
  const file = claudeStoreFile(sessionId);
  if (!file) { c.say('no transcript found'); return false; }
  c.say('--- transcript');
  const sentNames = { 'Reply with the single word: warm': 'sent:warm', 'Reply with the single word: keyed': 'sent:keyed', '/compact': 'sent:compact' };
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line);
    const flags = ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'isSidechain'].filter((k) => e[k]);
    const sent = e.type === 'user' ? sentNames[contentText(e.message)] : '';
    const compactMarkup = e.type === 'user' && /<command-name>/.test(contentText(e.message)) ? 'command-markup' : '';
    const carriesOurs = e.uuid === chosen ? 'OUR-UUID' : '';
    c.say(`  ${[e.type, e.subtype, e.uuid && `uuid=${short(e.uuid)}`, e.promptSource && `promptSource=${e.promptSource}`, ...flags, sent, compactMarkup, carriesOurs].filter(Boolean).join(' ')}`);
  }
  if (!sawBoundary) c.say('no compact boundary seen');
  return sawBoundary;
}

// A `/compact` Claude declines: the first line of a session with nothing in it to compact. It shows what tells a refusal
// from a compaction on the pipe (the `result` fields, a replayed local-command output, a `compact_boundary` or none),
// for idle maintenance's "Compacted" record (#827 gap). The CLI's own text is cut at MAX_ERROR_CHARS; no conversation
// exists to print.
async function measureClaudeRefusedCompact() {
  const say = (m) => {
    if (m.type === 'stream_event') return '';
    const parts = [summarizeClaude(m)];
    if (m.type === 'result') {
      parts.push(`is_error=${m.is_error}`, `keys=${Object.keys(m).sort().join('+')}`);
      if (typeof m.result === 'string') parts.push(`result="${m.result.slice(0, MAX_ERROR_CHARS)}"`);
      if (Array.isArray(m.errors)) parts.push(`errors="${m.errors.join(' | ').slice(0, MAX_ERROR_CHARS)}"`);
      if (m.local_command !== undefined) parts.push(`local_command=${JSON.stringify(m.local_command).slice(0, MAX_ERROR_CHARS)}`);
    }
    if (m.type === 'assistant' && m.message && m.message.model === '<synthetic>') parts.push(`text="${contentText(m.message).slice(0, MAX_ERROR_CHARS)}"`);
    if (m.type === 'user' && m.isReplay) parts.push(`text="${contentText(m.message).slice(0, MAX_ERROR_CHARS)}"`);
    return parts.join(' ');
  };
  const c = start('claude', 'claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio --strict-mcp-config --setting-sources project', {}, say);
  let sawBoundary = false;
  c.until((m) => { sawBoundary = sawBoundary || (m.type === 'system' && m.subtype === 'compact_boundary'); return false; }, STEP_TIMEOUT_MS * 2);
  c.say('--- /compact as the first line of an empty session');
  c.write({ type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null, session_id: '' });
  const end = await c.until((m) => m.type === 'result');
  await sleep(SETTLE_MS);
  await c.stop();
  c.say(sawBoundary ? 'a compact boundary was seen' : 'no compact boundary seen');
  return Boolean(end);
}

// A `/compact` on a large session (handoff point 9 of #827, spec 45's closed gap): claude-native's "Compacted" record
// rests on `system/compact_boundary` arriving BEFORE the `result` that ends the compaction's turn, and that was measured on
// two short turns only. A large turn (FILLER_NUMBERS numbers, tens of thousands of tokens) and a short one go first, so
// the compaction has real work and takes its time; then the order of the two lines after `/compact` is printed.
async function measureClaudeLargeCompact() {
  const order = [];
  let compacting = false;
  const c = start('claude', 'claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio --strict-mcp-config --setting-sources project', {}, (m) => {
    if (compacting && (m.type === 'result' || (m.type === 'system' && m.subtype === 'compact_boundary'))) order.push(m.type === 'result' ? 'result' : 'compact_boundary');
    const line = summarizeClaude(m);
    return m.type === 'result' && m.usage ? `${line} input_tokens=${(m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0)}` : line;
  });
  const isEnd = (m) => m.type === 'result';
  const user = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
  const filler = Array.from({ length: FILLER_NUMBERS }, (_, i) => i).join(' ');
  c.say('--- large turn');
  c.write(user(`Reply with the single word: large. Ignore this list: ${filler}`));
  await c.until(isEnd, STEP_TIMEOUT_MS * 2);
  c.say('--- short turn');
  c.write(user('Reply with the single word: short'));
  await c.until(isEnd);
  c.say('--- /compact');
  compacting = true;
  const compactStarted = Date.now();
  c.write(user('/compact'));
  await c.until(isEnd, STEP_TIMEOUT_MS * 3);
  await sleep(SETTLE_MS);
  await c.stop();
  c.say(`compaction took ${((Date.now() - compactStarted) / 1000).toFixed(1)}s; order after /compact: ${order.join(' -> ') || 'nothing'}`);
  const ok = order[0] === 'compact_boundary' && order.includes('result');
  c.say(ok ? 'compact_boundary came before result' : 'compact_boundary did NOT come before result');
  return ok;
}

// --- pi-native's launch shape, without its runtime extension ---

function summarizePi(msg) {
  if (msg.type === 'message_update' || msg.type === 'turn_start' || msg.type === 'turn_end') return '';
  const parts = [msg.type];
  if (msg.type === 'response') {
    parts.push(`id=${msg.id}`, `command=${msg.command}`, `success=${msg.success}`);
    if (msg.error) parts.push(`error="${String(msg.error).slice(0, MAX_ERROR_CHARS)}"`);
    if (msg.data && msg.data.disposition) parts.push(`disposition=${msg.data.disposition}`);
  }
  if (msg.message) {
    parts.push(`role=${msg.message.role}`, `keys=${Object.keys(msg.message).join('+')}`);
    if (msg.message.id) parts.push(`messageId=${short(msg.message.id)}`);
  }
  const usage = usagePaths(msg);
  if (usage.length) parts.push(`usage@${usage.join(',')}`);
  if (msg.type === 'compaction_end') parts.push(`aborted=${msg.aborted}`, `willRetry=${msg.willRetry}`, `result=${msg.result ? Object.keys(msg.result).join('+') : 'none'}`);
  return parts.join(' ');
}

function piFileSummary(p, file, label) {
  if (!file || !fs.existsSync(file)) { p.say(`--- file ${label}: not there`); return; }
  p.say(`--- file ${label}`);
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line);
    p.say(`  ${[e.type, e.id && `id=${short(e.id)}`, e.parentId && `parent=${short(e.parentId)}`, e.message && `role=${e.message.role}`, e.customType].filter(Boolean).join(' ')}`);
  }
}

async function measurePi() {
  const sessionDir = path.join(process.cwd(), 'pi-sessions');
  const p = start('pi', 'pi --mode rpc --provider anthropic --model claude-haiku-4-5', { PI_CODING_AGENT_SESSION_DIR: sessionDir }, summarizePi);
  const prompt = (id, word) => p.write({ id, type: 'prompt', message: `Reply with the single word: ${word}` });
  const responseTo = (id) => (m) => m.type === 'response' && m.id === id;
  const settled = (m) => m.type === 'agent_settled';
  const runEnd = settled; // not `agent_end`: a retry or a compaction can follow that one
  let compactOk = false;

  p.say('--- warm turn');
  prompt('p1', 'warm');
  await p.until(runEnd);
  await sleep(SETTLE_MS);

  p.write({ id: 's1', type: 'get_state' });
  const state = await p.until(responseTo('s1'));
  const data = (state && state.data) || {};
  p.say(`state keys=${Object.keys(data).join('+')} session ${data.sessionId}`);
  piFileSummary(p, data.sessionFile, 'after the warm turn');

  p.say('--- two prompts written in one tick');
  prompt('p2', 'first');
  prompt('p3', 'second');
  await Promise.all([p.until(responseTo('p2')), p.until(responseTo('p3'))]);
  await p.until(runEnd);
  await sleep(SETTLE_MS);

  p.say('--- a prompt written on the answer to the one before, before agent_start can be assumed');
  prompt('p4', 'third');
  await p.until(responseTo('p4'));
  prompt('p5', 'fourth');
  await p.until(responseTo('p5'));
  await p.until(runEnd);
  await sleep(SETTLE_MS);

  p.say('--- RPC compact on a session too small for one');
  p.write({ id: 'c1', type: 'compact' });
  await p.until(responseTo('c1'));
  await sleep(SETTLE_MS);

  // Pi keeps its recent context, so only a large older turn gives it something to summarise.
  const filler = Array.from({ length: FILLER_NUMBERS }, (_, i) => i).join(' ');
  p.say('--- large turn, a short one, then RPC compact');
  p.write({ id: 'p6', type: 'prompt', message: `Reply with the single word: large. Ignore this list: ${filler}` });
  await p.until(runEnd);
  prompt('p7', 'fifth');
  await p.until(runEnd);
  await sleep(SETTLE_MS);
  const compactAnswer = p.until(responseTo('c2'));
  const compactStart = p.until((m) => m.type === 'compaction_start');
  p.write({ id: 'c2', type: 'compact' });
  await compactStart;
  p.say('--- a plain prompt written while the compaction runs');
  const during = p.until(responseTo('p8'));
  prompt('p8', 'during');
  const compacted = await compactAnswer;
  compactOk = Boolean(compacted && compacted.success);
  const answer = await during;
  if (answer && answer.success) await p.until(settled);
  await sleep(SETTLE_MS);
  piFileSummary(p, data.sessionFile, 'after the compaction');
  await p.stop();
  if (!compactOk) p.say('the compaction did not succeed');
  return Boolean(data.sessionId) && compactOk;
}

const runs = only === 'claude-refused-compact' ? [measureClaudeRefusedCompact()]
  : only === 'claude-large-compact' ? [measureClaudeLargeCompact()]
    : [only === 'pi' ? true : measureClaude(), only === 'claude' ? true : measurePi()];
Promise.all(runs)
  .then((answers) => process.exit(answers.every(Boolean) ? 0 : 1))
  .catch((err) => { console.error(`failed: ${err.code || err.name}`); process.exit(1); });
