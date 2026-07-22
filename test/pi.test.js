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

const pi = require('../src/backends/pi');
const parser = require('../src/backends/pi/parser');
const { deriveState, deriveStateFromFileTail, ACTIVITY_WINDOW_MS } = require('../src/backends/pi/state');

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

// The hybrid (D21, approved): the transcript decides the state; PTY output is a LIVENESS signal that may
// only keep a running turn alive. Without it, a long turn that writes nothing (deep reasoning, a slow
// tool) flips to idle while pi is still working — the one thing generic PTY-activity would have got right.
test('a long SILENT turn stays busy while the process is still producing output', () => {
  const last = '2026-07-12T08:00:00.000Z';
  const now = Date.parse(last) + ACTIVITY_WINDOW_MS + 60_000;   // long past the staleness window
  assert.strictEqual(
    deriveState({ lastRole: 'user', lastEntryAt: last }, now, { lastOutputMs: now - 5000 }),
    'busy',
    'the transcript is quiet, but pi is clearly alive',
  );
  assert.strictEqual(
    deriveState({ lastRole: 'user', lastEntryAt: last }, now, { lastOutputMs: now - 10 * 60_000 }),
    'idle',
    'output long ago is not liveness',
  );
});

test('PTY output can never CREATE a busy state — only prevent a premature idle', () => {
  // An answered turn is answered, however loudly the TUI repaints afterwards (it redraws its prompt,
  // echoes keystrokes, blinks a cursor). Treating that as "busy" is exactly the trap generic
  // PTY-activity falls into.
  const now = Date.parse('2026-07-12T08:31:30.000Z');
  assert.strictEqual(
    deriveState(
      { lastRole: 'assistant', lastStopReason: 'stop', lastEntryAt: '2026-07-12T08:31:25.000Z' },
      now,
      { lastOutputMs: now - 100 },
    ),
    'idle',
  );
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
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'backends', 'pi', 'index.js'), 'utf8');
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

// #209: the transcript NAME carries the start time, so an old one is rejected before it is stat'd. Drives
// Pi's own birthHint regex end-to-end (the hook is internal to the file-store closure).
test('matchLiveSession: an old transcript is rejected by its NAME, without a stat (#209)', () => {
  const store = tmpStore();
  const id = '019f5573-63e7-7e7d-ba4e-200c900885ff';
  try {
    // Written NOW — its real birth is post-spawn, so a stat would accept it. Only the name says 2026-07-12.
    fs.copyFileSync(FIXTURE, path.join(store.dir, `2026-07-12T08-30-53-415Z_${id}.jsonl`));
    pi.setRoot(store.root);

    // A spawn a year after the name's date: the name alone rules the record out.
    const spawn = Date.UTC(2027, 6, 12, 8, 30, 53);
    assert.strictEqual(pi.matchLiveSession({ cwd: 'Z:\\temp', sinceMs: spawn, claimed: new Set() }), null,
      'a transcript the name dates a year before the spawn is not ours');

    // Control: a spawn just after the name's date is INSIDE the 24 h margin, so it is still stat'd and
    // matched (its real birth is now). This is what keeps a timezone misreading from losing a session.
    const justAfter = Date.UTC(2026, 6, 12, 9, 0, 0);
    assert.ok(pi.matchLiveSession({ cwd: 'Z:\\temp', sinceMs: justAfter, claimed: new Set() }),
      'inside the margin the hint is not trusted to mean "old" (control)');
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

test('probe caches the toolchain — it does not shell out to `node --version` on every scan', () => {
  // probe() rides on backends.list(), which is on the SCAN path, and the registry's availability cache
  // only holds 15s. Uncached, this ran a SYNCHRONOUS child process on the main thread every 15 seconds
  // for the life of the app (#155).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-probe-'));
  const oldPath = process.env.PATH;
  const oldExt = process.env.PATHEXT;
  try {
    // A PATH holding `pi` and nothing else: no node, so the probe fails on the Node requirement.
    const ext = process.platform === 'win32' ? '.CMD' : '';
    fs.writeFileSync(path.join(dir, 'pi' + ext), '');
    process.env.PATHEXT = '.EXE;.CMD;.BAT';
    process.env.PATH = dir;
    pi._resetToolchainCache();

    const cold = pi.probe();
    assert.strictEqual(cold.ok, false);
    assert.match(cold.reason, /Node/, 'no node on PATH -> the probe says so');

    // Put the real toolchain back. WITHOUT a reset the answer must not move: that is the cache doing its
    // job (a fresh probe here would mean another synchronous exec).
    process.env.PATH = oldPath + path.delimiter + dir;
    assert.match(pi.probe().reason || '', /Node/, 'still the cached answer — no second exec');

    // ...and the cache is a cache, not a freeze: cleared, it sees the node that is now there.
    pi._resetToolchainCache();
    const warm = pi.probe();
    assert.ok(warm.ok || !/no node was found/.test(warm.reason), 'after a refresh the probe sees the real node');
  } finally {
    process.env.PATH = oldPath;
    if (oldExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = oldExt;
    pi._resetToolchainCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- lineage: a fork names its parent (#193) -----------------------------------------------------
//
// Pi's session header carries `parentSession` — the full PATH of the parent transcript — but ONLY on a
// forked session. A survey that happens to look at four unforked sessions concludes Pi records no
// parent, which is what the descriptor claimed for several issues (and what spec 13 said). One real
// `pi --fork` transcript settles it, and these tests keep it settled.
//
// The path→id step is the descriptor's on purpose: `<ISO-timestamp>_<uuid>.jsonl` is Pi's naming
// convention, not the core's.

function piSessionFile(dir, { id, cwd, parentSession }) {
  const header = { type: 'session', version: 3, id, timestamp: '2026-07-12T09:29:25.877Z', cwd };
  if (parentSession) header.parentSession = parentSession;
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: 'message', timestamp: '2026-07-12T09:29:30.000Z',
      message: { role: 'user', content: 'hello' } }),
  ];
  const file = path.join(dir, `2026-07-12T09-29-25-877Z_${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('a forked Pi session reports its parent as a hard link (#193)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lineage-'));
  try {
    const parentId = '019f55a8-fc75-7062-a523-5af87a5e5971';
    const childId = '019f56c9-b0f6-7400-bfe4-38ce21890906';
    const parentFile = piSessionFile(dir, { id: parentId, cwd: 'C:/p' });
    const childFile = piSessionFile(dir, { id: childId, cwd: 'C:/p', parentSession: parentFile });

    const child = pi.parseSession({ kind: 'file', path: childFile });
    assert.strictEqual(child.lineageParentRef, parentFile, 'the parser passes the raw path through');

    const lineage = pi.resolveLineage(child);
    assert.deepStrictEqual(lineage, { lineageParentId: parentId, lineageKind: 'fork' });

    // And the id it derived is really the parent's own id, not just a substring that looks like one.
    const parent = pi.parseSession({ kind: 'file', path: parentFile });
    assert.strictEqual(parent.sessionId, lineage.lineageParentId);
    assert.strictEqual(pi.resolveLineage(parent), null, 'an unforked session declares no parent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a parentSession Pi did not write yields no link rather than a guess (#193)', () => {
  // Better no lineage than a wrong one: a `fork` link is rendered as FACT, not as a guess, and a wrong
  // ancestor is not something the reader can recover from.
  //
  // The middle three are the ones that matter and the reason the whole filename is matched rather than
  // split on the first underscore: that looser rule answered `backup_copy.jsonl` with the id `copy` —
  // a confident link to a session that does not exist.
  const refs = [
    null, '', undefined,
    'backup_copy.jsonl',                                   // an underscore, but not Pi's shape
    'a_b_c.jsonl',                                         // several underscores
    '2026-07-12T09-29-25-877Z_019f55a8.txt',               // right prefix, wrong extension and short id
    'no-underscore.jsonl',
    '2026-07-12T09-29-25-877Z_.jsonl',                     // prefix, no id
    '2026-07-12T09-29-25-877Z_019f55a8-fc75-7062-a523-5af87a5e5971.jsonl.bak',
  ];
  for (const ref of refs) {
    assert.strictEqual(pi.resolveLineage({ lineageParentRef: ref }), null, `ref=${JSON.stringify(ref)}`);
  }
  assert.strictEqual(pi.resolveLineage({}), null);
  assert.strictEqual(pi.resolveLineage(null), null);
});

test('#283 liveState gate re-derives with a fresh now — a quiet running turn still flips to idle', () => {
  const { deriveStateFromFileTailGated, _clearFactsCache } = require('../src/backends/pi/state');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gate-'));
  const p = path.join(dir, 'transcript.jsonl');
  try {
    const ts = '2026-07-12T09:00:00.000Z';
    fs.writeFileSync(p, JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }) + '\n');
    const base = Date.parse(ts);
    _clearFactsCache();
    assert.strictEqual(deriveStateFromFileTailGated(p, base + 1000, {}), 'busy', 'a trailing user prompt = a running turn -> busy');
    // File UNCHANGED (same signature -> cached facts), but time moved far past the activity window: the gate
    // must RE-DERIVE with the fresh now, not serve the stale cached busy.
    assert.strictEqual(deriveStateFromFileTailGated(p, base + 24 * 3600 * 1000, {}), 'idle',
      'signature unchanged but now advanced -> re-derived to idle, not a stale cached busy');
  } finally {
    _clearFactsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
