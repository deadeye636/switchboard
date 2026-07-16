'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parser = require('../backends/codex/parser');
const codex = require('../backends/codex');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-session.jsonl');
const handle = { kind: 'file', path: FIXTURE };

// --- T-4.4: parser

test('parses the recon sample into the normalised row', () => {
  const row = parser.parseSession(handle);
  assert.ok(row, 'row produced');
  assert.strictEqual(row.sessionId, '019f081a-8834-7342-8741-30624c553c1c', 'id from session_meta');
  assert.strictEqual(row.backendId, 'codex');
  assert.strictEqual(row.cwd, 'D:\\Projekte\\demo', 'cwd from session_meta (project grouping key)');
  assert.strictEqual(row.startedAt, '2026-06-27T10:03:04.019Z');
});

test('model comes from the LAST turn_context', () => {
  const row = parser.parseSession(handle);
  assert.strictEqual(row.model, 'gpt-5.5', 'last turn wins (not the first, gpt-5.4)');
});

test('tokens come from the LAST token_count total_token_usage (assigned, not summed)', () => {
  const row = parser.parseSession(handle);
  assert.strictEqual(row.inputTokens, 14425);
  assert.strictEqual(row.outputTokens, 267);
  assert.strictEqual(row.cacheReadTokens, 2432);
  assert.strictEqual(row.reasoningTokens, 77);
  assert.strictEqual(row.totalTokens, 14692);
  assert.strictEqual(row.contextWindow, 258400);
});

test('messageCount counts only response_item messages (not reasoning)', () => {
  const row = parser.parseSession(handle);
  // 2 user + 2 assistant messages; the `reasoning` item must not count
  assert.strictEqual(row.messageCount, 4);
  assert.strictEqual(row.userMessageCount, 2);
});

test('summary/firstPrompt is the first user prompt (searchable via FTS)', () => {
  const row = parser.parseSession(handle);
  assert.strictEqual(row.summary, 'Refactor the auth middleware and add tests');
  assert.strictEqual(row.firstPrompt, row.summary);
  assert.match(row.textContent, /token expiry edge case/);
});

test('the title skips Codex\'s injected AGENTS.md context and uses the real prompt', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-')), 'rollout.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(tmp,
    line({ timestamp: '2026-06-27T10:00:00Z', type: 'session_meta', payload: { id: 'X1', cwd: 'D:\\p', timestamp: '2026-06-27T10:00:00Z' } }) +
    // Codex injects the project's AGENTS.md as the first "user" message — not a prompt.
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '# AGENTS.md instructions for D:\\p\n\n<INSTRUCTIONS>do things</INSTRUCTIONS>' }] } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Fix the failing auth test' }] } })
  );
  const row = parser.parseSession({ kind: 'file', path: tmp });
  assert.strictEqual(row.summary, 'Fix the failing auth test', 'injected context must not become the title');
});

test('injected context is kept OUT of the search body (it is identical in every session of a project)', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fts-')), 'rollout.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(tmp,
    line({ timestamp: '2026-06-27T10:00:00Z', type: 'session_meta', payload: { id: 'X3', cwd: 'D:\\p', timestamp: '2026-06-27T10:00:00Z' } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '# AGENTS.md instructions for D:\\p\n\nUSE_TABS_EVERYWHERE' }] } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Fix the auth test' }] } })
  );
  const row = parser.parseSession({ kind: 'file', path: tmp });
  assert.ok(!/USE_TABS_EVERYWHERE/.test(row.textContent),
    'a term from the injected AGENTS.md must not make every Codex session of the project match');
  assert.match(row.textContent, /Fix the auth test/, 'the real prompt IS indexed');
});

test('a session with ONLY injected context still gets a title (fallback, not blank)', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title2-')), 'rollout.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(tmp,
    line({ timestamp: '2026-06-27T10:00:00Z', type: 'session_meta', payload: { id: 'X2', cwd: 'D:\\p', timestamp: '2026-06-27T10:00:00Z' } }) +
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '# AGENTS.md instructions for D:\\p' }] } })
  );
  const row = parser.parseSession({ kind: 'file', path: tmp });
  assert.match(row.summary, /AGENTS\.md/, 'falls back rather than showing an empty title');
});

test('the base_instructions system-prompt blob never reaches textContent', () => {
  const row = parser.parseSession(handle);
  assert.ok(!/HUGE SYSTEM PROMPT BLOB/.test(row.textContent), 'base_instructions must be skipped');
});

test('a truncated final line (live append) is tolerated', () => {
  const row = parser.parseSession(handle);
  assert.ok(row, 'truncated tail line does not invalidate the file');
  assert.strictEqual(row.messageCount, 4, 'the incomplete message is not counted');
});

// --- incremental-parse contract (§5.10)

test('incremental re-read from a saved offset == a full read', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inc-')), 'rollout.jsonl');
  const all = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
  const head = all.slice(0, 8).join('\n') + '\n';
  const rest = all.slice(8).join('\n') + '\n';

  // first pass over the partial file
  fs.writeFileSync(tmp, head);
  const first = parser.parseSessionIncremental({ kind: 'file', path: tmp }, {}, null);
  assert.ok(first.parseState.offset > 0);
  assert.strictEqual(first.parseState.version, parser.PARSER_SCHEMA_VERSION);

  // append the rest, then resume from the saved offset
  fs.appendFileSync(tmp, rest);
  const second = parser.parseSessionIncremental({ kind: 'file', path: tmp }, {}, first.parseState);
  const full = parser.parseSession({ kind: 'file', path: tmp });

  assert.strictEqual(second.row.messageCount, full.messageCount);
  assert.strictEqual(second.row.model, full.model);
  assert.strictEqual(second.row.inputTokens, full.inputTokens);
  assert.strictEqual(second.row.totalTokens, full.totalTokens);
  assert.strictEqual(second.row.textContent, full.textContent);
  assert.strictEqual(second.row.summary, full.summary);
});

test('a fingerprint mismatch forces a full re-read (no stale row)', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fp-')), 'rollout.jsonl');
  fs.copyFileSync(FIXTURE, tmp);
  const first = parser.parseSessionIncremental({ kind: 'file', path: tmp }, {}, null);
  // rewrite the file with different content at the same-ish size -> fingerprint no longer matches
  const bogus = { ...first.parseState, fingerprint: 'deadbeef'.repeat(5) };
  const second = parser.parseSessionIncremental({ kind: 'file', path: tmp }, {}, bogus);
  const full = parser.parseSession({ kind: 'file', path: tmp });
  assert.strictEqual(second.row.messageCount, full.messageCount, 'fell back to a full re-read');
});

test('a shrunk file forces a full re-read', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shrink-')), 'rollout.jsonl');
  fs.copyFileSync(FIXTURE, tmp);
  const first = parser.parseSessionIncremental({ kind: 'file', path: tmp }, {}, null);
  const all = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(tmp, all.slice(0, 6).join('\n') + '\n'); // shrink
  const second = parser.parseSessionIncremental({ kind: 'file', path: tmp }, {}, first.parseState);
  assert.ok(second.row.messageCount <= 2, 'row reflects the shrunk file, not stale state');
});

test('a schema-version bump drops the persisted state wholesale', () => {
  const stale = { version: parser.PARSER_SCHEMA_VERSION + 1, offset: 999999, fingerprint: 'x', state: {} };
  const res = parser.parseSessionIncremental(handle, {}, stale);
  const full = parser.parseSession(handle);
  assert.strictEqual(res.row.messageCount, full.messageCount, 'version mismatch -> full re-read');
});

// --- T-4.3: descriptor + buildLaunch + discovery

test('descriptor: codex is Axis-B, ready, monogram Cx, with its own configFields', () => {
  assert.strictEqual(codex.id, 'codex');
  assert.strictEqual(codex.axis, 'B');
  assert.strictEqual(codex.status, 'ready');
  assert.strictEqual(codex.monogram, 'Cx');
  // The full set Codex' own `--help` offers and we consider safe per session (#160). Pinned as a list
  // so that dropping one is a decision, not an accident — the Settings page is generated from it.
  const ids = codex.configFields.map(f => f.id);
  assert.deepStrictEqual(ids.sort(), [
    'addDirs', 'approvalMode', 'configOverrides', 'localProvider', 'model', 'oss', 'profile',
    'sandbox', 'search',
  ]);
});

test('buildLaunch: new session uses argv spawnMode (no shell string)', () => {
  const l = codex.buildLaunch({ cwd: 'D:\\p', resume: false, sessionId: 'S1' });
  assert.strictEqual(l.command, 'codex');
  assert.strictEqual(l.spawnMode, 'argv', 'Codex spawns via clean argv — Windows shell quoting bites it');
  assert.deepStrictEqual(l.args, []);
});

test('buildLaunch: options map to Codex flags', () => {
  const l = codex.buildLaunch({
    resume: false, sessionId: 'S1',
    options: { model: 'gpt-5.5', approvalMode: 'on-request', sandbox: 'workspace-write' },
  });
  assert.deepStrictEqual(l.args, [
    '-m', 'gpt-5.5',
    '-a', 'on-request',
    '-s', 'workspace-write',
  ]);
});

test('buildLaunch: resume targets the recorded session id (binary-bound, §5.11)', () => {
  const l = codex.buildLaunch({ resume: true, sessionId: 'abc-123' });
  assert.deepStrictEqual(l.args, ['resume', 'abc-123']);
});

test('discoverSessions recurses the date-bucketed rollout tree', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const day = path.join(home, 'sessions', '2026', '06', '27');
  fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(day, 'rollout-2026-06-27T10-03-04-019f081a.jsonl'));
  fs.writeFileSync(path.join(day, 'not-a-rollout.jsonl'), '{}\n'); // must be ignored

  codex.setHome(home);
  const handles = codex.discoverSessions();
  assert.strictEqual(handles.length, 1, 'only rollout-*.jsonl files are sessions');
  assert.strictEqual(handles[0].kind, 'file');
  assert.match(handles[0].path, /rollout-/);
});

test('watchTargets returns the sessions root as a dir target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-w-'));
  codex.setHome(home);
  const t = codex.watchTargets();
  assert.strictEqual(t[0].kind, 'dir');
  assert.match(t[0].path, /sessions$/);
});

// --- T-4.5: state derivation from the rollout tail

test('deriveState: task_started -> busy, task_complete -> idle', () => {
  const st = parser.createParseState();
  parser.applyLine(st, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }));
  assert.strictEqual(codex.deriveState(st), 'busy');
  parser.applyLine(st, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }));
  assert.strictEqual(codex.deriveState(st), 'idle');
});

test('deriveState: a session with no task event yet is idle', () => {
  assert.strictEqual(codex.deriveState(parser.createParseState()), 'idle');
});

// The LIVE signal: Codex emits no OSC title, so busy/idle is read from the rollout file's tail.

test('deriveStateFromFileTail: last task event in the file wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-'));
  const f = path.join(dir, 'rollout.jsonl');
  const line = (t) => JSON.stringify({ type: 'event_msg', payload: { type: t } }) + '\n';

  fs.writeFileSync(f, line('task_started'));
  assert.strictEqual(codex.deriveStateFromFileTail(f), 'busy');

  fs.appendFileSync(f, line('task_complete'));
  assert.strictEqual(codex.deriveStateFromFileTail(f), 'idle');

  // a new turn begins -> busy again
  fs.appendFileSync(f, line('task_started'));
  assert.strictEqual(codex.deriveStateFromFileTail(f), 'busy');
});

test('deriveStateFromFileTail: ignores a truncated tail line and unrelated events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail2-'));
  const f = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(f,
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }) + '\n' +
    '{"type":"event_msg","payl');   // live append, mid-write
  assert.strictEqual(codex.deriveStateFromFileTail(f), 'busy', 'token_count is not a task event');
});

test('deriveStateFromFileTail: an unreadable file returns null (state left untouched)', () => {
  assert.strictEqual(codex.deriveStateFromFileTail('D:\\nope\\missing.jsonl'), null);
});

// --- D10: identity adoption. Codex names its own session, so the id we launch under is NOT the id it
// records. matchLiveSession is how the main process finds the rollout belonging to a session it just
// spawned. Getting this wrong steals another session's rollout — so it is worth testing directly.

// The RESUME half: a resumed session continues an EXISTING rollout, which matchLiveSession rejects
// (it only accepts records born after the spawn). liveRefFor claims it by the id we already hold.
test('liveRefFor: a resumed session finds its own rollout by id, whatever its age', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
  const day = path.join(home, 'sessions', '2026', '06', '27');
  fs.mkdirSync(day, { recursive: true });
  const id = '019f081a-8834-7342-8741-30624c553c1c';
  fs.copyFileSync(FIXTURE, path.join(day, `rollout-2026-06-27T10-00-00-${id}.jsonl`));
  codex.setHome(home);

  assert.match(codex.liveRefFor(id), /rollout-2026-06-27T10-00-00-.*\.jsonl$/);
  // A brand-new session runs under an id we invented — it must claim nothing and fall through to
  // correlation, or it would adopt a stranger's rollout.
  assert.strictEqual(codex.liveRefFor('11111111-2222-4333-8444-555555555555'), null);
  assert.strictEqual(codex.liveRefFor(null), null);
});

test('matchLiveSession: finds the rollout for a session we just launched in this cwd', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-'));
  const day = path.join(home, 'sessions', '2026', '06', '27');
  fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(day, 'rollout-a.jsonl'));
  codex.setHome(home);

  const match = codex.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: 0, claimed: new Set() });
  assert.ok(match, 'found the rollout');
  assert.strictEqual(match.sessionId, '019f081a-8834-7342-8741-30624c553c1c', 'the id CODEX chose, not ours');
  assert.match(match.ref, /rollout-a\.jsonl$/);
});

// #209: the rollout NAME carries the start time, so an old rollout is rejected before it is stat'd. This
// drives Codex' own birthHint regex end-to-end through the real descriptor (the hook itself is internal
// to the file-store closure — what matters is that the name is read correctly).
test('matchLiveSession: an old rollout is rejected by its NAME, without a stat (#209)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hint-'));
  const day = path.join(home, 'sessions', '2024', '01', '02');
  fs.mkdirSync(day, { recursive: true });
  // The file is written NOW, so its real birth is post-spawn and a stat would accept it. Only the name
  // says 2024. If it still matched, the birthHint never ran.
  fs.copyFileSync(FIXTURE, path.join(day, 'rollout-2024-01-02T10-00-00-019f081a-8834-7342-8741-30624c553c1c.jsonl'));
  codex.setHome(home);

  assert.strictEqual(
    codex.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: Date.now(), claimed: new Set() }), null,
    'a rollout the name dates to 2024 is not the session we just spawned');

  // Control: the same fixture under a name dated NOW is still found — the hint rejects the old, not everything.
  const today = new Date();
  const stamp = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}T${String(today.getUTCHours()).padStart(2, '0')}-00-00`;
  fs.copyFileSync(FIXTURE, path.join(day, `rollout-${stamp}-019f081a-8834-7342-8741-30624c553c1c.jsonl`));
  const match = codex.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: Date.now() - 60_000, claimed: new Set() });
  assert.ok(match, 'a rollout named for today is still correlated (control)');
});

test('matchLiveSession: never hands the same rollout to two sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live2-'));
  const day = path.join(home, 'sessions', '2026', '06', '27');
  fs.mkdirSync(day, { recursive: true });
  const first = path.join(day, 'rollout-a.jsonl');
  fs.copyFileSync(FIXTURE, first);
  codex.setHome(home);

  // Session A claimed it; session B must not be given the same file.
  const match = codex.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: 0, claimed: new Set([first]) });
  assert.strictEqual(match, null, 'a claimed rollout is never re-handed out');
});

test('matchLiveSession: ignores a rollout from a different project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live3-'));
  const day = path.join(home, 'sessions', '2026', '06', '27');
  fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(day, 'rollout-a.jsonl'));   // its cwd is D:\Projekte\demo
  codex.setHome(home);

  const match = codex.matchLiveSession({ cwd: 'D:\\Projekte\\somewhere-else', sinceMs: 0, claimed: new Set() });
  assert.strictEqual(match, null, 'a rollout from another project is not ours');
});

test('matchLiveSession: ignores a rollout that predates the launch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live4-'));
  const day = path.join(home, 'sessions', '2026', '06', '27');
  fs.mkdirSync(day, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(day, 'rollout-a.jsonl'));
  codex.setHome(home);

  // sinceMs far in the future -> nothing can belong to this launch.
  const match = codex.matchLiveSession({ cwd: 'D:\\Projekte\\demo', sinceMs: Date.now() + 3600_000, claimed: new Set() });
  assert.strictEqual(match, null, 'an older rollout belongs to a previous session, not this one');
});
