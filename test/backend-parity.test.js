// Parity across backends.
//
// The final full-system review found the same defect repeatedly: a bug was found in ONE backend, fixed
// there, and its siblings were never re-checked (fork, the busy-state tail window, the transcript
// viewer, the availability probe — each fixed for exactly one backend). These tests assert the
// PROPERTIES every backend must share, so the next backend cannot quietly skip one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backends = require('../src/backends');
const codexState = require('../src/backends/codex/state');

// Registry-driven, not a hand-maintained roster (#195): a newly registered `ready` backend is covered
// the moment it is seeded, and one that cannot satisfy a contract fails the suite on registration —
// which is the point. A literal id list reproduced, one level up, the very "a sibling quietly keeps the
// defect" failure these tests exist to kill. `status === 'ready'` drops the `planned` dummies (agy);
// profiles run a base backend's binary and are not their own store.
const READY = backends.list().filter(b => b.status === 'ready' && !b.isProfile);
// File-mode backends (own transcript files) owe the incremental-parse contract; a db-backed one (Hermes,
// `transcriptAccess: 'export'`) does not, it only versions its parser.
const FILE_MODE = READY.filter(b => b.transcriptAccess === 'file');

test('every ready backend declares an availability probe', () => {
  // Without one, an enabled-but-not-installed backend is offered in the picker and dies in the terminal
  // with a raw shell error instead of a sentence the user can act on (D15). Codex shipped without it.
  for (const b of READY) {
    const id = b.id;
    if (id === 'claude') continue;   // the default backend: if it is missing, the app has bigger problems
    assert.equal(typeof b.probe, 'function', `${id} must declare probe()`);
    const res = b.probe();
    assert.equal(typeof res.ok, 'boolean', `${id}.probe() returns {ok}`);
    if (!res.ok) assert.ok(res.reason && res.reason.length > 10, `${id}: an actionable reason, not a shrug`);
  }
});

test('every backend states whether it can fork — and only a forker gets forkFrom honoured', () => {
  // The Fork button used to be offered for every session. A backend that ignores `forkFrom` does not
  // "do nothing" — it launches an unrelated EMPTY session. So the capability must be explicit.
  for (const b of READY) {
    const id = b.id;
    assert.equal(typeof b.supportsFork, 'boolean', `${id} must state supportsFork`);

    const args = b.buildLaunch({ cwd: '/p', sessionId: 's1', forkFrom: 'PARENT' }).args.join(' ');
    if (b.supportsFork) {
      assert.match(args, /PARENT/, `${id} claims it can fork, so the parent id must reach the argv`);
    } else {
      assert.ok(!args.includes('PARENT'), `${id} cannot fork — it must not pretend to`);
    }
  }
});

// #230: subagents are a Claude concept the core used to assume. Every backend now DECLARES whether it has
// them (supportsSubagents), the same way it declares supportsFork, so a feature or setting built on top has
// an honest per-backend answer instead of hard-wiring Claude. Claude is the one that does; the rest decline.
test('every backend declares supportsSubagents — and only Claude has them today', () => {
  for (const b of READY) {
    assert.equal(typeof b.supportsSubagents, 'boolean', `${b.id} must state supportsSubagents`);
  }
  const claude = READY.find(b => b.id === 'claude');
  assert.equal(claude && claude.supportsSubagents, true, 'Claude spawns Task subagents — it must declare so');
  for (const b of READY) {
    if (b.id === 'claude') continue;
    assert.equal(b.supportsSubagents, false, `${b.id} has no subagent concept — it must not claim one`);
  }
});

// #193: session lineage is a NEUTRAL feature — the core stamps lineageParentId at one sink by calling each
// backend's resolveLineage(row). Every backend must ANSWER the hook, even if only to decline (return null),
// so no backend's provenance can quietly hard-wire itself into the core. A backend that DOES record a link
// returns { lineageParentId, lineageKind }; one that does not (or cannot verify it) returns null on purpose.
test('every backend declares resolveLineage — a link shape or an honest null', () => {
  for (const b of READY) {
    const id = b.id;
    assert.equal(typeof b.resolveLineage, 'function', `${id} must declare resolveLineage (return null if it records none)`);
    // A bare/empty row must not throw and must not invent a link.
    const bare = b.resolveLineage({});
    assert.ok(bare === null || (bare && typeof bare.lineageParentId === 'string' && typeof bare.lineageKind === 'string'),
      `${id}.resolveLineage({}) must be null or a { lineageParentId, lineageKind } pair`);
    assert.equal(b.resolveLineage(null), null, `${id}.resolveLineage(null) must be null, not a throw`);
  }
});

// #211: the Projects admin remaps and deletes a project's transcripts, and they do not all live in
// Claude's store. It used to reconstruct Claude's path inline (resolveJsonlPath(PROJECTS_DIR, row)) — a
// backend-specific require in the neutral core. Every backend now answers transcriptPathFor(row): a file
// backend hands back row.filePath, Claude reconstructs from folder+id over its own roots, a db backend
// returns null. So the core never reconstructs a Claude path itself.
test('every backend declares transcriptPathFor — a path or an honest null', () => {
  for (const b of READY) {
    const id = b.id;
    assert.equal(typeof b.transcriptPathFor, 'function', `${id} must declare transcriptPathFor`);
    assert.equal(b.transcriptPathFor(null), null, `${id}.transcriptPathFor(null) must be null, not a throw`);
    // A row that carries its own filePath resolves to exactly that, for every backend.
    assert.equal(b.transcriptPathFor({ filePath: '/x/y.jsonl' }), '/x/y.jsonl',
      `${id}.transcriptPathFor must honour a row's own filePath`);
  }
});

// #227: where a backend keeps its plans and its memory/instruction files is DECLARED, not hardcoded to
// ~/.claude in the core. Every backend answers both hooks: plansDir() is a string or null (most have no
// plans store), memorySources(scope) is always an array (a backend with no instruction files returns []).
test('every backend declares plansDir and memorySources — a store or an honest none', () => {
  for (const b of READY) {
    const id = b.id;
    assert.equal(typeof b.plansDir, 'function', `${id} must declare plansDir`);
    const pd = b.plansDir();
    assert.ok(pd === null || typeof pd === 'string', `${id}.plansDir() must be a string path or null`);

    assert.equal(typeof b.memorySources, 'function', `${id} must declare memorySources`);
    // Global scope and a per-project scope both return arrays and never throw.
    assert.ok(Array.isArray(b.memorySources({ projectPath: null, storeFolders: [] })), `${id}.memorySources(global) must be an array`);
    const perProject = b.memorySources({ projectPath: '/tmp/demo', storeFolders: [] });
    assert.ok(Array.isArray(perProject), `${id}.memorySources(project) must be an array`);
    for (const s of perProject) {
      assert.ok(s && (s.kind === 'dir' || s.kind === 'file') && typeof s.path === 'string',
        `${id}.memorySources returns { kind:'dir'|'file', path } entries`);
    }
    assert.ok(Array.isArray(b.memorySources(null)), `${id}.memorySources(null) must not throw`);
  }
});

// #211: per-project config/meta is an OPTIONAL capability. A backend that keeps a projects table in its
// own config (Claude's ~/.claude.json) declares projectMeta; one that keeps none declares nothing, and
// the admin shows no columns for it rather than borrowing Claude's. When present, it must be complete.
test('a backend that declares projectMeta declares the whole capability', () => {
  for (const b of READY) {
    if (!b.projectMeta) continue;
    const id = b.id;
    for (const fn of ['getMany', 'knownProjects', 'has', 'rename', 'remove']) {
      assert.equal(typeof b.projectMeta[fn], 'function', `${id}.projectMeta.${fn} must be a function`);
    }
    assert.ok(b.projectMeta.getMany([]) instanceof Map, `${id}.projectMeta.getMany([]) must be a Map`);
    assert.ok(Array.isArray(b.projectMeta.knownProjects()), `${id}.projectMeta.knownProjects() must be an array`);
  }
});

test('every backend that names its own sessions implements ALL THREE identity hooks (D17)', () => {
  // Two hooks is the resume bug: matchLiveSession only accepts records born after the spawn, which a
  // resumed session's record never is, so it claims the NEXT new session's record instead.
  for (const b of READY) {
    const id = b.id;
    const names = typeof b.matchLiveSession === 'function';
    if (!names) continue;
    assert.equal(typeof b.liveRefFor, 'function', `${id} adopts ids, so it needs liveRefFor (resume)`);
    assert.equal(typeof b.liveState, 'function', `${id} needs liveState`);
  }
});

test('every file-mode backend exposes the incremental-parse contract with a schema version (§5.10)', () => {
  for (const b of FILE_MODE) {
    const id = b.id;
    assert.equal(typeof b.parseSessionIncremental, 'function', `${id} must expose the incremental parse`);
    assert.equal(typeof b.PARSER_SCHEMA_VERSION, 'number', `${id} must version its parser`);
    // The contract is a SHAPE, not just a name: an invalid handle returns `{ row, parseState }`, never a
    // bare null or a backend-private shape — else a generic consumer reads `undefined.row` off it. #188
    // shipped exactly that latent trap (Claude's wrapper returned `{session,next}`/null); this catches it.
    const out = b.parseSessionIncremental({ kind: 'not-a-real-handle' });
    assert.ok(out && typeof out === 'object' && 'row' in out && 'parseState' in out,
      `${id}.parseSessionIncremental must return { row, parseState }, got ${JSON.stringify(out)}`);
  }
  // Every ready backend versions its parser, file-mode or not — Hermes has no incremental parse (SQLite),
  // but the scan's staleness gate still keys on the version.
  for (const b of READY) {
    assert.equal(typeof b.PARSER_SCHEMA_VERSION, 'number', `${b.id} must version its parser`);
  }
});

// --- the tail-window bug, checked on the OTHER backend it was never checked on -------------------

test('Codex stays BUSY when its turn has out-written the tail window', () => {
  // A working Codex writes reasoning + tool output into the rollout, so `task_started` scrolls out of a
  // fixed 64KB tail long before `task_complete` arrives. The old reader then returned IDLE — actively
  // pushing the wrong edge while Codex worked.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-'));
  const file = path.join(dir, 'rollout.jsonl');
  try {
    const lines = [
      JSON.stringify({ timestamp: '2026-07-12T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    ];
    // ...then 200 KB of turn output, no completion event.
    const chunk = 'y'.repeat(4000);
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({ timestamp: '2026-07-12T10:00:0' + (i % 10) + '.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: chunk }] } }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');

    assert.equal(codexState.deriveStateFromFileTail(file), 'busy',
      'the turn is still running — the window must grow until the lifecycle event is in view');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex says NOTHING rather than "idle" when no lifecycle event exists at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail2-'));
  const file = path.join(dir, 'rollout.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/p' } }) + '\n');
    assert.equal(codexState.deriveStateFromFileTail(file), null,
      'no evidence is not evidence of idleness — the caller must be left to keep the last known state');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- the liveness signal (D21), checked on both store-derived backends ---------------------------

test('a long SILENT turn stays busy on every store-derived backend while its PTY still talks', () => {
  const hermes = require('../src/backends/hermes/state');
  const pi = require('../src/backends/pi/state');
  const now = Date.now();
  const longAgo = now - 10 * 60 * 1000;   // well past every activity window

  // Hermes: a turn IS running (the prompt is unanswered), but nothing has been written for ten minutes.
  // The row has to SAY the turn is running — "not ended" never meant that, because `ended_at` is null on
  // every Hermes session, answered or not (#165). The trailing user prompt is what says it.
  const running = { isEnded: false, lastRole: 'user', lastActivityMs: longAgo };
  assert.equal(hermes.deriveState(running, now), 'idle');
  assert.equal(hermes.deriveState(running, now, { lastOutputMs: now - 5000 }), 'busy',
    'Hermes never states that a turn is RUNNING — a silent long turn needs the liveness signal too');

  // Pi: same shape, from the transcript side.
  const last = new Date(longAgo).toISOString();
  assert.equal(pi.deriveState({ lastRole: 'user', lastEntryAt: last }, now), 'idle');
  assert.equal(pi.deriveState({ lastRole: 'user', lastEntryAt: last }, now, { lastOutputMs: now - 5000 }), 'busy');

  // And output NEVER creates a busy state out of an answered turn.
  assert.equal(hermes.deriveState({ isEnded: true, lastActivityMs: now }, now, { lastOutputMs: now }), 'idle');
});

test('...but the terminal cannot hold a turn busy FOR EVER — every net has a ceiling (#166)', () => {
  // `lastOutputMs` is refreshed on every PTY data chunk, and that includes a spinner frame, a clock, an
  // echoed keystroke, a repaint. So a session STUCK in the running-turn branch — a store row that never
  // got its closing message: a crash, a lost write, a state we misread — stayed at "working" for ever, as
  // long as its TUI twitched once a minute. That is the "permanently working" failure this repo has
  // already shipped twice, through a third door.
  //
  // Past the ceiling the STORE is the state. Output was only ever the tie-breaker.
  const hermes = require('../src/backends/hermes/state');
  const pi = require('../src/backends/pi/state');
  const now = Date.now();

  for (const [name, mod] of [['hermes', hermes], ['pi', pi]]) {
    const ceiling = mod.OUTPUT_LIVENESS_CEILING_MS;
    assert.ok(ceiling > mod.ACTIVITY_WINDOW_MS,
      `${name}: a ceiling at or below the activity window would cancel the net it is bounding`);
    assert.ok(ceiling > mod.OUTPUT_LIVENESS_MS, `${name}: and it must outlive the liveness window itself`);
  }

  // A turn silent for just under the ceiling, with a chatty terminal: still busy — this is the case the
  // net exists for.
  const justUnder = now - (hermes.OUTPUT_LIVENESS_CEILING_MS - 30_000);
  assert.equal(
    hermes.deriveState({ isEnded: false, lastRole: 'user', lastActivityMs: justUnder }, now, { lastOutputMs: now }),
    'busy');
  assert.equal(
    pi.deriveState({ lastRole: 'user', lastEntryAt: new Date(justUnder).toISOString() }, now, { lastOutputMs: now }),
    'busy');

  // Past it — and the terminal is STILL talking, right now. Idle anyway.
  const past = now - (hermes.OUTPUT_LIVENESS_CEILING_MS + 1000);
  assert.equal(
    hermes.deriveState({ isEnded: false, lastRole: 'user', lastActivityMs: past }, now, { lastOutputMs: now }),
    'idle', 'hermes: a wedged session must heal itself, whatever its TUI is painting');
  assert.equal(
    pi.deriveState({ lastRole: 'user', lastEntryAt: new Date(past).toISOString() }, now, { lastOutputMs: now }),
    'idle', 'pi: same rule, same reason — fix one, check its sibling');
});

test('a backend that names its own sessions can say whether it knows one yet', () => {
  // The fork bug: Codex, Hermes and Pi name their own sessions, and we only adopt that name once they
  // have written their store record — after the agent's first answer. Fork a session before that, and
  // the only id we hold is OUR id, which means nothing to them: `pi --fork <our-uuid>` answers "No
  // session found" and the user gets a dead tab. `liveRefFor` is what the fork guard asks.
  for (const b of READY) {
    const id = b.id;
    if (typeof b.matchLiveSession !== 'function') continue;   // Claude: our id IS its id
    assert.equal(typeof b.liveRefFor, 'function', `${id} must be able to answer "do you know this session?"`);
    assert.equal(b.liveRefFor('11111111-2222-4333-8444-555555555555'), null,
      `${id} must NOT claim to know an id it never issued`);
  }
});
