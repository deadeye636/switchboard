// "No projects" and "we could not find out" are different answers (#431).
//
// WHY THIS EXISTS:
//   `get-projects` used to answer a failed read with `[]` — which is also what a fresh install answers.
//   The renderer could not tell them apart, so a broken read replaced a populated sidebar with nothing
//   and said nothing about it. The handler rejects now, and these are the rules the renderer applies to
//   the two outcomes. Pure, so both branches can be pinned without an app.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectListState, replacesExistingList, projectsFailureNotice,
} = require('../src/renderer/lib/project-list-state');

test('an empty install is a RESULT, not a failure', () => {
  assert.equal(projectListState({ ok: true, projects: [] }), 'empty');
  assert.equal(projectListState({ ok: true, projects: undefined }), 'empty');
});

test('a listing that arrived is loaded', () => {
  assert.equal(projectListState({ ok: true, projects: [{ projectPath: '/x' }] }), 'loaded');
});

test('a failed read is unknown — the one state that did not exist before', () => {
  assert.equal(projectListState({ ok: false }), 'unknown');
  assert.equal(projectListState({ ok: false, projects: [] }), 'unknown',
    'even carrying an empty array: how it got here is what decides');
});

test('only a real answer may replace what is on screen', () => {
  assert.equal(replacesExistingList('loaded'), true);
  assert.equal(replacesExistingList('empty'), true, 'a genuinely empty install must be able to empty it');
  assert.equal(replacesExistingList('unknown'), false, 'a wrong empty sidebar is worse than a stale one');
});

// The wording is not decoration here: with a list on screen the reassuring half is true, and on a first
// load that failed the same sentence would be a lie about an empty sidebar.
test('the notice says something different when there is nothing to keep', () => {
  const kept = projectsFailureNotice(new Error('no such table: session_cache'), true);
  assert.match(kept.text, /showing what was last loaded/);
  assert.match(kept.title, /no such table: session_cache/);

  const nothing = projectsFailureNotice(new Error('no such table: session_cache'), false);
  assert.doesNotMatch(nothing.text, /last loaded/, 'nothing was loaded — do not claim otherwise');
  assert.match(nothing.title, /not because there is nothing/);
});

test('the notice survives a thrown non-Error', () => {
  assert.match(projectsFailureNotice('plain string', true).title, /plain string/);
  assert.match(projectsFailureNotice(null, true).title, /unknown error/);
  assert.match(projectsFailureNotice(undefined, false).title, /unknown error/);
});

test('both branches always offer the retry, because the click is the only way back', () => {
  for (const hadList of [true, false]) {
    assert.match(projectsFailureNotice(new Error('x'), hadList).title, /Click to try again/);
  }
});
