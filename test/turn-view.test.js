// #507 step T1: the turn view is a pure function of neutral messages (src/session/turn-view.js).
// Plain arrays in, a plain object out: no fs, no backend, no grammar.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTurnView, DEFAULTS, MAXIMA } = require('../src/session/turn-view');

const u = (text, at) => ({ role: 'user', text, at });
const a = (text, tools, at) => ({ role: 'assistant', text, tools, at });

test('three turns are grouped and ordered, assistant messages merged, tools counted', () => {
  const v = buildTurnView([
    u('q1', 1), a('a1', ['Read', 'Read']), a('a1b', [{ name: 'Edit' }]),
    u('q2', 2), a('a2'),
    u('q3', 3),
  ]);
  assert.deepEqual(v, {
    turns: [
      { n: 1, at: 1, user: 'q1', assistant: 'a1\n\na1b', tools: { Read: 2, Edit: 1 } },
      { n: 2, at: 2, user: 'q2', assistant: 'a2', tools: {} },
      { n: 3, at: 3, user: 'q3', assistant: '', tools: {} },
    ],
    returned: 3, omitted: 0, partial: false,
  });
});

test('a text over the cap keeps head 2/3 and tail 1/3 with a marker; a text under it is untouched', () => {
  const long = 'H'.repeat(60) + 'M'.repeat(100) + 'T'.repeat(30);
  const v = buildTurnView([u('short'), a(long)], { maxCharsPerTurn: 90 });
  const t = v.turns[0];
  assert.equal(t.user, 'short');
  assert.equal(t.assistant, `${'H'.repeat(60)}\n[... 100 characters omitted ...]\n${'T'.repeat(30)}`);
});

test('arguments above their maxima are clamped; junk falls back to defaults', () => {
  const msgs = [];
  for (let i = 1; i <= 40; i++) msgs.push(u(`q${i}`));
  assert.equal(buildTurnView(msgs, { turns: 999 }).returned, MAXIMA.turns);
  assert.equal(buildTurnView(msgs, { turns: 'x' }).returned, DEFAULTS.turns);
  const big = buildTurnView([u('x'.repeat(9000))], { maxCharsPerTurn: 999999 }).turns[0].user;
  assert.equal(Array.from(big.replace(/\n\[\.\.\. \d+ characters omitted \.\.\.\]\n/, '')).length, MAXIMA.maxCharsPerTurn);
});

test('the turn cap keeps the newest turns and reports omitted', () => {
  const msgs = [];
  for (let i = 1; i <= 10; i++) msgs.push(u(`q${i}`));
  const v = buildTurnView(msgs);
  assert.deepEqual(v.turns.map((t) => t.n), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(v.returned, 8);
  assert.equal(v.omitted, 2);
});

test('the ceiling drops the oldest turns first and the view stays under it', () => {
  const msgs = [];
  for (let i = 1; i <= 8; i++) msgs.push(u(`q${i} ` + 'x'.repeat(4000)), a('y'.repeat(4000)));
  const v = buildTurnView(msgs, { turns: 8, maxCharsPerTurn: 4000, ceilingChars: 12000 });
  assert.ok(JSON.stringify(v).length <= 12000);
  assert.ok(v.returned > 0 && v.returned < 8);
  assert.equal(v.omitted, 8 - v.returned);
  assert.equal(v.turns[v.turns.length - 1].n, 8);
  assert.equal(v.turns[0].n, 8 - v.returned + 1);
  // the default ceiling is the maximum, and a larger request is clamped to it
  const w = buildTurnView(msgs, { turns: 8, maxCharsPerTurn: 4000, ceilingChars: 10_000_000 });
  assert.ok(JSON.stringify(w).length <= MAXIMA.ceilingChars);
});

test("roles: 'user' drops assistant text but keeps the turn count", () => {
  const v = buildTurnView([u('q1'), a('a1', ['Bash']), u('q2'), a('a2')], { roles: 'user' });
  assert.equal(v.returned, 2);
  assert.deepEqual(v.turns.map((t) => t.assistant), ['', '']);
  assert.deepEqual(v.turns.map((t) => t.user), ['q1', 'q2']);
  assert.deepEqual(v.turns[0].tools, { Bash: 1 });
});

test('leading assistant messages form turn 0 with an empty user text', () => {
  const v = buildTurnView([a('orphan1'), a('orphan2'), u('q1'), a('a1')]);
  assert.deepEqual(v.turns.map((t) => t.n), [0, 1]);
  assert.equal(v.turns[0].user, '');
  assert.equal(v.turns[0].assistant, 'orphan1\n\norphan2');
  assert.equal(v.turns[1].user, 'q1');
});

test('partial passes through unchanged', () => {
  assert.equal(buildTurnView([u('q')], { partial: true }).partial, true);
  assert.equal(buildTurnView([u('q')], { partial: false }).partial, false);
  assert.equal(buildTurnView([u('q')]).partial, false);
});

test('a cut never splits an emoji or surrogate pair', () => {
  const text = '\u{1F600}'.repeat(30);
  const v = buildTurnView([u(text)], { maxCharsPerTurn: 10 });
  const out = v.turns[0].user;
  assert.equal(out, `${'\u{1F600}'.repeat(7)}\n[... 20 characters omitted ...]\n${'\u{1F600}'.repeat(3)}`);
  assert.equal(JSON.parse(JSON.stringify(out)), out);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out));
});

test('a ceilingChars below the floor clamps to 1000, not to the junk value', () => {
  // One ~300-char turn serializes to a few hundred chars: well over 10, well under 1000. A floor of 1000
  // keeps it; a ceiling that honoured the 10 would drop it to nothing.
  const v = buildTurnView([u('x'.repeat(300))], { ceilingChars: 10 });
  assert.equal(v.returned, 1, 'the floor is 1000, so the turn fits and is kept');
  const len = JSON.stringify(v).length;
  assert.ok(len > 10 && len <= 1000, `serialized length ${len} is within the 1000 floor, not the 10 argument`);
});

test('a negative or zero turns argument clamps to 1', () => {
  const msgs = [u('a'), a('x'), u('b'), a('y')]; // two user turns
  assert.equal(buildTurnView(msgs, { turns: -5 }).returned, 1);
  assert.equal(buildTurnView(msgs, { turns: 0 }).returned, 1);
});

test('empty and degenerate input gives an empty view and never mutates its input', () => {
  const empty = { turns: [], returned: 0, omitted: 0, partial: false };
  assert.deepEqual(buildTurnView([]), empty);
  assert.deepEqual(buildTurnView(undefined), empty);
  assert.deepEqual(buildTurnView([null, { role: 'system', text: 'x' }, 5]), empty);
  const input = [u('q'), a('a', ['T'])];
  const copy = structuredClone(input);
  buildTurnView(input, { maxCharsPerTurn: 1 });
  assert.deepEqual(input, copy);
});
