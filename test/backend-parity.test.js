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

const backends = require('../backends');
const codexState = require('../backends/codex/state');

const REAL = ['claude', 'codex', 'hermes', 'pi'];

test('every ready backend declares an availability probe', () => {
  // Without one, an enabled-but-not-installed backend is offered in the picker and dies in the terminal
  // with a raw shell error instead of a sentence the user can act on (D15). Codex shipped without it.
  for (const id of REAL) {
    const b = backends.get(id);
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
  for (const id of REAL) {
    const b = backends.get(id);
    assert.equal(typeof b.supportsFork, 'boolean', `${id} must state supportsFork`);

    const args = b.buildLaunch({ cwd: '/p', sessionId: 's1', forkFrom: 'PARENT' }).args.join(' ');
    if (b.supportsFork) {
      assert.match(args, /PARENT/, `${id} claims it can fork, so the parent id must reach the argv`);
    } else {
      assert.ok(!args.includes('PARENT'), `${id} cannot fork — it must not pretend to`);
    }
  }
});

test('every backend that names its own sessions implements ALL THREE identity hooks (D17)', () => {
  // Two hooks is the resume bug: matchLiveSession only accepts records born after the spawn, which a
  // resumed session's record never is, so it claims the NEXT new session's record instead.
  for (const id of REAL) {
    const b = backends.get(id);
    const names = typeof b.matchLiveSession === 'function';
    if (!names) continue;
    assert.equal(typeof b.liveRefFor, 'function', `${id} adopts ids, so it needs liveRefFor (resume)`);
    assert.equal(typeof b.liveState, 'function', `${id} needs liveState`);
  }
});

test('every backend exposes the incremental-parse contract with a schema version (§5.10)', () => {
  for (const id of ['codex', 'pi']) {   // the file-mode parsers
    const b = backends.get(id);
    assert.equal(typeof b.parseSessionIncremental, 'function', `${id} must expose the incremental parse`);
    assert.equal(typeof b.PARSER_SCHEMA_VERSION, 'number', `${id} must version its parser`);
  }
  assert.equal(typeof backends.get('hermes').PARSER_SCHEMA_VERSION, 'number');
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
  const hermes = require('../backends/hermes/state');
  const pi = require('../backends/pi/state');
  const now = Date.now();
  const longAgo = now - 10 * 60 * 1000;   // well past every activity window

  // Hermes: the session never ended, but wrote nothing for ten minutes.
  assert.equal(hermes.deriveState({ isEnded: false, lastActivityMs: longAgo }, now), 'idle');
  assert.equal(hermes.deriveState({ isEnded: false, lastActivityMs: longAgo }, now, { lastOutputMs: now - 5000 }), 'busy',
    'Hermes states only that a turn ENDED — a silent long turn needs the liveness signal too');

  // Pi: same shape, from the transcript side.
  const last = new Date(longAgo).toISOString();
  assert.equal(pi.deriveState({ lastRole: 'user', lastEntryAt: last }, now), 'idle');
  assert.equal(pi.deriveState({ lastRole: 'user', lastEntryAt: last }, now, { lastOutputMs: now - 5000 }), 'busy');

  // And output NEVER creates a busy state out of an answered turn.
  assert.equal(hermes.deriveState({ isEnded: true, lastActivityMs: now }, now, { lastOutputMs: now }), 'idle');
});
