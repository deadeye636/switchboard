// Pi (Phase 6) — descriptor, JSONL parser, busy/idle, the identity seam.
//
// The fixture is a REAL transcript (docs/plans/research/pi-format.md): a session that started on
// anthropic, failed (no provider configured), then switched to openai-codex mid-flight. That is not an
// edge case — Pi is multi-provider per session, so the "last model wins" rule and the cross-provider
// token/cost totals are the normal path.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pi = require('../backends/pi');
const parser = require('../backends/pi/parser');
const { deriveState, deriveStateFromFileTail, ACTIVITY_WINDOW_MS } = require('../backends/pi/state');

const FIXTURE = path.join(__dirname, 'fixtures', 'pi-session.jsonl');

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-store-'));
  const dir = path.join(root, '--Z--temp--');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

function handleFor(p) {
  return { kind: 'file', path: p };
}

// --- parser ---------------------------------------------------------------------------------------

test('parseSession reads identity and cwd from the HEADER, not from the folder name', () => {
  const row = parser.parseSession(handleFor(FIXTURE));
  assert.ok(row, 'the transcript parsed');
  assert.strictEqual(row.sessionId, '019f5573-63e7-7e7d-ba4e-200c900885ff');
  assert.strictEqual(row.cwd, 'Z:\\temp', 'the header carries the real cwd — the folder is encoded');
  assert.strictEqual(row.backendId, 'pi');
});

test('the LAST model wins — Pi switches provider mid-session', () => {
  const row = parser.parseSession(handleFor(FIXTURE));
  assert.strictEqual(row.model, 'gpt-5.5', 'it started on claude-opus-4-7 and moved to gpt-5.5');
});

test('tokens are summed across providers; the title is the first real prompt', () => {
  const row = parser.parseSession(handleFor(FIXTURE));
  assert.strictEqual(row.summary, 'test');
  assert.strictEqual(row.userMessageCount, 4);
  assert.strictEqual(row.messageCount, 8);   // 4 prompts + 4 assistant turns (the first one errored)
  assert.strictEqual(row.inputTokens, 1628 + 111 + 151);
  assert.strictEqual(row.outputTokens, 7 + 29 + 10);
  assert.strictEqual(row.cacheReadTokens, 1536 + 1536);
  assert.match(row.textContent, /Ich bin von OpenAI/, 'the assistant text is in the FTS body');
});

test('cost: usage.cost is an OBJECT (.total), summed into an ESTIMATE — never a settled amount', () => {
  const row = parser.parseSession(handleFor(FIXTURE));
  // 0.008350000000000002 + 0.002193 + 0.001823
  assert.ok(Math.abs(row.estimatedCostUsd - 0.012366) < 1e-9, `got ${row.estimatedCostUsd}`);
  assert.strictEqual(row.actualCostUsd, null, 'Pi prices its own turns — that is an estimate, not a bill');
  assert.strictEqual(row.costStatus, 'estimated');
});

test('a session whose turns all failed reports NO cost (not a zero)', () => {
  const store = tmpStore();
  const p = path.join(store.dir, '2026-07-12T07-49-04-568Z_aaaa1111-0000-4000-8000-000000000001.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'session', version: 3, id: 'aaaa1111-0000-4000-8000-000000000001', timestamp: '2026-07-12T07:49:04.568Z', cwd: 'Z:\\temp' }),
    JSON.stringify({ type: 'message', timestamp: '2026-07-12T07:49:10.000Z', message: { role: 'user', content: [{ type: 'text', text: 'test' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-07-12T07:49:11.000Z', message: { role: 'assistant', content: [], model: 'claude-opus-4-7', provider: 'anthropic', stopReason: 'error', errorMessage: 'no provider', usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } } }),
  ].join('\n') + '\n');
  try {
    const row = parser.parseSession(handleFor(p));
    assert.strictEqual(row.estimatedCostUsd, null, 'a zero is "no price known", not "it was free" (D16)');
    assert.strictEqual(row.costStatus, null);
  } finally { fs.rmSync(store.root, { recursive: true, force: true }); }
});

test('incremental parse resumes from the offset and matches a full read', () => {
  const full = parser.parseSession(handleFor(FIXTURE));

  const store = tmpStore();
  const p = path.join(store.dir, '2026-07-12T08-30-53-415Z_019f5573-63e7-7e7d-ba4e-200c900885ff.jsonl');
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
  try {
    // Write half the session, parse it, then append the rest and parse incrementally.
    fs.writeFileSync(p, lines.slice(0, 5).join('\n') + '\n');
    const first = parser.parseSessionIncremental(handleFor(p), {}, null);
    assert.ok(first.parseState.offset > 0);

    fs.appendFileSync(p, lines.slice(5).join('\n') + '\n');
    const second = parser.parseSessionIncremental(handleFor(p), {}, first.parseState);

    assert.strictEqual(second.row.messageCount, full.messageCount, 'same as a cold read');
    assert.strictEqual(second.row.inputTokens, full.inputTokens);
    assert.ok(Math.abs(second.row.estimatedCostUsd - full.estimatedCostUsd) < 1e-9);
    assert.ok(second.parseState.offset > first.parseState.offset);
  } finally { fs.rmSync(store.root, { recursive: true, force: true }); }
});

test('a truncated final line is left unconsumed instead of corrupting the parse', () => {
  const store = tmpStore();
  const p = path.join(store.dir, '2026-07-12T08-30-53-415Z_019f5573-63e7-7e7d-ba4e-200c900885ff.jsonl');
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
  try {
    fs.writeFileSync(p, lines.slice(0, 4).join('\n') + '\n' + '{"type":"message","mess');  // mid-write
    const row = parser.parseSession(handleFor(p));
    assert.ok(row, 'the complete lines still parse');
    assert.strictEqual(row.sessionId, '019f5573-63e7-7e7d-ba4e-200c900885ff');
  } finally { fs.rmSync(store.root, { recursive: true, force: true }); }
});

// --- state ----------------------------------------------------------------------------------------

test('busy while the last message is the user prompt; idle once the turn answered', () => {
  const now = Date.parse('2026-07-12T08:31:30.000Z');
  assert.strictEqual(deriveState({ lastRole: 'user', lastEntryAt: '2026-07-12T08:31:20.000Z' }, now), 'busy');
  assert.strictEqual(deriveState({ lastRole: 'assistant', lastStopReason: 'stop', lastEntryAt: '2026-07-12T08:31:25.000Z' }, now), 'idle');
});

test('a dangling prompt goes idle once it has been quiet — a crashed pi must not spin forever', () => {
  const last = '2026-07-12T08:00:00.000Z';
  const now = Date.parse(last) + ACTIVITY_WINDOW_MS + 1000;
  assert.strictEqual(deriveState({ lastRole: 'user', lastEntryAt: last }, now), 'idle');
});

test('deriveStateFromFileTail reads the transcript tail', () => {
  const state = deriveStateFromFileTail(FIXTURE, Date.parse('2026-07-12T08:33:00.000Z'));
  assert.strictEqual(state, 'idle', 'the fixture ends on an answered assistant turn');
});

test('a HUGE final answer still reads as idle — the tail window grows to fit one line', () => {
  // A Pi message is ONE JSONL line. An assistant turn that dumps a big diff blows past a fixed 64KB tail
  // read: the whole window then sits inside that single line, no line in it starts with '{', and the
  // reader finds nothing. "Nothing" means "no change" to the caller, so the session would keep the last
  // edge it was given — BUSY, from the user's prompt — and spin forever although the turn is finished.
  const store = tmpStore();
  const id = 'bbbb2222-0000-4000-8000-000000000002';
  const p = path.join(store.dir, `2026-07-12T09-00-00-000Z_${id}.jsonl`);
  const huge = 'x'.repeat(200 * 1024);   // one message, way over the 64KB window
  try {
    fs.writeFileSync(p, [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-07-12T09:00:00.000Z', cwd: 'Z:\\temp' }),
      JSON.stringify({ type: 'message', timestamp: '2026-07-12T09:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'dump the diff' }] } }),
      JSON.stringify({ type: 'message', timestamp: '2026-07-12T09:00:20.000Z', message: { role: 'assistant', content: [{ type: 'text', text: huge }], model: 'gpt-5.5', stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } } } }),
    ].join('\n') + '\n');

    const state = deriveStateFromFileTail(p, Date.parse('2026-07-12T09:00:30.000Z'));
    assert.strictEqual(state, 'idle', 'the answered turn is found even though its line dwarfs the window');
  } finally { fs.rmSync(store.root, { recursive: true, force: true }); }
});

test('probe names the bash requirement, not just the binary and Node', () => {
  // The plan asks for it and the docstring claimed it; the code did not check it (Phase-6 gate finding).
  const src = fs.readFileSync(path.join(__dirname, '..', 'backends', 'pi', 'index.js'), 'utf8');
  assert.match(src, /function findBash\(/, 'a bash probe exists');
  assert.match(src, /bash shell/i, 'and its reason says so in words the user can act on');
});

test('the OAuth-shadow gotcha is surfaced, not just commented', () => {
  assert.ok(pi.caveat, 'the descriptor carries a caveat the settings page renders');
  assert.match(pi.caveat, /login/i);
});

// --- descriptor -----------------------------------------------------------------------------------

test('buildLaunch: new vs resume (binary-bound, §5.11)', () => {
  assert.deepStrictEqual(pi.buildLaunch({ cwd: 'Z:\\temp' }).args, []);
  assert.deepStrictEqual(
    pi.buildLaunch({ cwd: 'Z:\\temp', resume: true, sessionId: 'abc' }).args,
    ['--session', 'abc'],
  );
  assert.deepStrictEqual(
    pi.buildLaunch({ cwd: 'Z:\\temp', options: { model: 'gpt-5.5' } }).args,
    ['--model', 'gpt-5.5'],
  );
});

test('fork: the sidebar offers it, so buildLaunch must honour it', () => {
  // Dropping forkFrom does not disable the Fork button — it launches a plain `pi`, i.e. an unrelated
  // empty session. Pi supports --fork, so wire it (found by the Phase-6 gate).
  assert.deepStrictEqual(
    pi.buildLaunch({ cwd: 'Z:\\temp', forkFrom: 'abc' }).args,
    ['--fork', 'abc'],
  );
  assert.deepStrictEqual(
    pi.buildLaunch({ cwd: 'Z:\\temp', options: { forkFrom: 'abc' } }).args,
    ['--fork', 'abc'],
  );
});

test('auth is injected as $VAR refs only — never a literal, never Pi credential files', () => {
  const env = pi.buildLaunch({ cwd: 'Z:\\temp' }).env;
  for (const v of Object.values(env)) assert.match(v, /^\$[A-Z_]+$/);
});

test('discoverSessions yields one file handle per transcript, under the cwd-encoded folders', () => {
  const store = tmpStore();
  try {
    fs.copyFileSync(FIXTURE, path.join(store.dir, '2026-07-12T08-30-53-415Z_019f5573-63e7-7e7d-ba4e-200c900885ff.jsonl'));
    fs.writeFileSync(path.join(store.dir, 'not-a-session.txt'), 'ignore me');
    pi.setRoot(store.root);

    const handles = pi.discoverSessions();
    assert.strictEqual(handles.length, 1);
    assert.strictEqual(handles[0].kind, 'file');
    assert.match(handles[0].path, /\.jsonl$/);
  } finally { pi.setRoot(null); fs.rmSync(store.root, { recursive: true, force: true }); }
});

test('matchLiveSession claims a NEW session; liveRefFor claims a RESUMED one (D17)', () => {
  const store = tmpStore();
  const id = '019f5573-63e7-7e7d-ba4e-200c900885ff';
  const file = path.join(store.dir, `2026-07-12T08-30-53-415Z_${id}.jsonl`);
  try {
    fs.copyFileSync(FIXTURE, file);
    pi.setRoot(store.root);

    const match = pi.matchLiveSession({ cwd: 'Z:\\temp', sinceMs: 0, claimed: new Set() });
    assert.ok(match, 'the transcript of the session we just launched');
    assert.strictEqual(match.sessionId, id, "the id PI chose, not ours");

    // Another project's session is not ours.
    assert.strictEqual(pi.matchLiveSession({ cwd: 'D:\\elsewhere', sinceMs: 0, claimed: new Set() }), null);
    // A record older than the launch cannot be a NEW session's...
    assert.strictEqual(
      pi.matchLiveSession({ cwd: 'Z:\\temp', sinceMs: Date.now() + 3600_000, claimed: new Set() }),
      null,
    );
    // ...but a RESUMED session holds its id already, so it claims the record directly.
    assert.strictEqual(pi.liveRefFor(id), file);
    assert.strictEqual(pi.liveRefFor('11111111-2222-4333-8444-555555555555'), null);
  } finally { pi.setRoot(null); fs.rmSync(store.root, { recursive: true, force: true }); }
});

test('probe: a clear reason, and it names the Node requirement', () => {
  const res = pi.probe();
  assert.strictEqual(typeof res.ok, 'boolean');
  if (!res.ok) assert.match(res.reason, /pi|Node/i);
});

test('watchTargets: the sessions root, recursively (a new cwd folder appears with its first session)', () => {
  const targets = pi.watchTargets();
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].kind, 'dir');
  assert.strictEqual(targets[0].recursive, true);
});
