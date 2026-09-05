'use strict';
// WHICH ROW of the register a path is about, on the READ side (#579).
//
// #566 brought the register's WRITES under one resolver, so a write lands on the row the register holds
// rather than the spelling the caller happened to carry. The reads were never enumerated, and three of
// them went on deciding by the raw string. This file covers the resolver itself and the one read that
// runs per session in the scan loop — `isRemovedProject`, where a miss re-indexes a removed project's
// sessions back into the cache and the search index while the register still says removed.
//
// A spelling mismatch is spelled here as a TRAILING SEPARATOR, which folds on every platform: `\` and
// `/` fold only where the host folds them, so a fixture that writes one directory both ways is a Windows
// fixture and this suite runs on Linux CI too (`.claude/rules/backends.md`).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { registerLookup, resolveRegisterRow } = require('../src/projects/register-lookup');
const indexWrites = require('../src/index/index-writes');

const PROJECT = path.join('D:', 'work', 'thing');
const OTHER_SPELLING = PROJECT + path.sep;
const REMOVED_AT = '2026-07-01T00:00:00.000Z';

const row = (over) => ({ registered: 0, hidden: 0, autoHidden: 0, removedAt: null, ...over });

// --- the resolver -------------------------------------------------------------------------------------

test('a row filed under another spelling of the same directory is the row', () => {
  const states = new Map([[PROJECT, row({ removedAt: REMOVED_AT })]]);
  const hit = resolveRegisterRow(states, OTHER_SPELLING);
  assert.equal(hit.path, PROJECT, 'it answers about the row the register holds, not the string it was asked with');
  assert.equal(hit.state.removedAt, REMOVED_AT);
});

test('a REGISTERED row outranks a tombstoned one for the same directory', () => {
  const states = new Map([
    [PROJECT, row({ removedAt: REMOVED_AT })],
    [OTHER_SPELLING, row({ registered: 1 })],
  ]);
  assert.equal(resolveRegisterRow(states, PROJECT).path, OTHER_SPELLING,
    'the row the sidebar shows is the row an act on this project is about');
});

test('the caller\'s own spelling wins among registered rows', () => {
  const states = new Map([
    [PROJECT, row({ registered: 1 })],
    [OTHER_SPELLING, row({ registered: 1 })],
  ]);
  assert.equal(resolveRegisterRow(states, OTHER_SPELLING).path, OTHER_SPELLING,
    'a register that already carries two registered rows still answers about the one it was asked about');
});

test('a path the register knows nothing about resolves to nothing, not to a neighbour', () => {
  const states = new Map([[PROJECT, row({ registered: 1 })]]);
  assert.equal(resolveRegisterRow(states, path.join('D:', 'work', 'other')), null);
  assert.equal(resolveRegisterRow(states, ''), null, 'and a blank path lands nowhere at all');
});

test('registerLookup keys the register once and answers many times', () => {
  const states = new Map([[PROJECT, row({ removedAt: REMOVED_AT })]]);
  const lookup = registerLookup(states);
  assert.equal(lookup(OTHER_SPELLING).path, PROJECT);
  assert.equal(lookup(PROJECT).path, PROJECT);
});

// --- isRemovedProject (src/index/index-writes.js) ------------------------------------------------------

// The register as a fake store, plus a count of what was read — the tiering in `isRemovedProject` is
// load-bearing (it runs per session in the scan loop), so the cheap path has to stay cheap.
function wireRegister(states) {
  const reads = { meta: 0, tombstones: 0, states: 0 };
  indexWrites.init({
    log: { info() {}, warn() {}, error() {}, debug() {} },
    getMainWindow: () => null,
    db: {
      getProjectMeta: (p) => { reads.meta++; return states.get(p) || null; },
      getProjectTombstones: () => {
        reads.tombstones++;
        const out = new Map();
        for (const [p, s] of states) if (s.removedAt) out.set(p, s.removedAt);
        return out;
      },
      getProjectStates: () => { reads.states++; return new Map(states); },
    },
  });
  return reads;
}

test('#579: a tombstone under another spelling still keeps the project out of the index', () => {
  // The register holds the removal at the spelling the user's act carried; the session row carries the
  // cwd its CLI wrote. `getProjectMeta(OTHER_SPELLING)` misses, and the sessions were indexed back in.
  wireRegister(new Map([[PROJECT, row({ removedAt: REMOVED_AT })]]));
  assert.equal(indexWrites.isRemovedProject(OTHER_SPELLING), true);
  assert.equal(indexWrites.isRemovedProject(PROJECT), true, 'and the exact spelling still answers the same');
});

test('#579: a registered row under another spelling means the project is NOT removed', () => {
  wireRegister(new Map([
    [PROJECT, row({ removedAt: REMOVED_AT })],
    [OTHER_SPELLING, row({ registered: 1 })],
  ]));
  assert.equal(indexWrites.isRemovedProject(PROJECT), false,
    'the read resolves the row a write would land on, and that row is on the list');
});

test('a project on the list is answered by the primary-key lookup alone', () => {
  const reads = wireRegister(new Map([[PROJECT, row({ registered: 1 })]]));
  assert.equal(indexWrites.isRemovedProject(PROJECT), false);
  assert.equal(reads.tombstones, 0, 'nothing can outrank a registered row for the caller\'s own path');
  assert.equal(reads.states, 0, 'so the scan loop pays exactly what it paid before');
});

test('with no tombstone anywhere the register is never keyed', () => {
  const reads = wireRegister(new Map([[PROJECT, row({ registered: 0 })]]));
  assert.equal(indexWrites.isRemovedProject(OTHER_SPELLING), false);
  assert.equal(reads.tombstones, 1, 'a short, two-column read decides it');
  assert.equal(reads.states, 0, 'the whole register is only keyed for a directory that really is tombstoned');
});

test('a blank project path is not a question', () => {
  const reads = wireRegister(new Map([[PROJECT, row({ removedAt: REMOVED_AT })]]));
  assert.equal(indexWrites.isRemovedProject(''), false);
  assert.equal(indexWrites.isRemovedProject(null), false);
  assert.equal(reads.meta, 0, 'and nothing is read to answer it');
});
