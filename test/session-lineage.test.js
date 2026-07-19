'use strict';
// The Claude /clear parent resolver (#223). Two sources, in a fixed order:
//
//   1. A CLAIM reported by the backend — "terminal <tag> ended session <id> by clearing". Claude produces
//      it through a per-spawn hook settings file (`--settings`) whose URL carries the terminal's tag; the
//      CLI's SessionEnd fires with reason "clear" and the OLD session id. That is a fact from the CLI, so
//      the number of live sessions in the folder stops mattering.
//   2. Otherwise the pre-existing conservative rule: exactly one live session in the folder is
//      unambiguously the one that cleared.
//
// With neither, it bails. That matters because no folder-local signal (mtime, cwd, gitBranch) can tell the
// true parent from a bystander that just went idle — the parent's think-time before /clear puts its
// transcript's freeze OUTSIDE any birth window in ~95% of real clears, while a bystander frozen inside the
// window would be mis-picked. A mis-key collapses two tabs onto one id, which is worse than doing nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveClearParent } = require('../src/session/session-lineage');

test('exactly one live session in the folder is the one that cleared → high', () => {
  const r = resolveClearParent({ candidates: [{ id: 'A' }] });
  assert.equal(r.parentId, 'A');
  assert.equal(r.confidence, 'high');
  assert.equal(r.via, 'single-session');
});

test('no candidates → none', () => {
  assert.equal(resolveClearParent({ candidates: [] }).confidence, 'none');
  assert.equal(resolveClearParent({}).confidence, 'none');
});

test('two or more live sessions and no claim → none (never a guess — a mis-key is worse than the bail)', () => {
  assert.equal(resolveClearParent({ candidates: [{ id: 'A' }, { id: 'B' }] }).confidence, 'none');
  assert.equal(resolveClearParent({ candidates: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] }).confidence, 'none');
});

// The failure the conservative rule exists to prevent: two sessions live, one is a bystander that just
// finished a turn. Without a claim there is no input that makes it pick anyone.
test('with a bystander present and no claim it never resolves anyone', () => {
  assert.equal(resolveClearParent({ candidates: [{ id: 'parent' }, { id: 'bystander' }] }).confidence, 'none');
});

// --- the claim path (#223) ---------------------------------------------------------------------------

test('a claim resolves the parent even with several live sessions — that is the whole point', () => {
  const candidates = [{ id: 'A', tag: 'tag-a' }, { id: 'B', tag: 'tag-b' }, { id: 'C', tag: 'tag-c' }];
  const r = resolveClearParent({ candidates, claim: { tag: 'tag-b', sessionId: 'B' } });
  assert.equal(r.parentId, 'B');
  assert.equal(r.confidence, 'high');
  assert.equal(r.via, 'claim');
});

test('the claim names the parent, so a re-keyed terminal still resolves to what the CLI ended', () => {
  // The terminal's tag is stable across re-keys; its session id is not. After one clear the live row is
  // keyed under B2 while the claim says the CLI just ended B2 — the tag is what ties them.
  const candidates = [{ id: 'A', tag: 'tag-a' }, { id: 'B2', tag: 'tag-b' }];
  const r = resolveClearParent({ candidates, claim: { tag: 'tag-b', sessionId: 'B2' } });
  assert.equal(r.parentId, 'B2');
  assert.equal(r.via, 'claim');
});

test('a claim from a terminal that is no longer live resolves nothing', () => {
  // Its PTY exited between the clear and the child appearing. Acting on it would re-key a dead row —
  // and with the tag gone from the candidates there is nothing to match against.
  const candidates = [{ id: 'A', tag: 'tag-a' }, { id: 'B', tag: 'tag-b' }];
  const r = resolveClearParent({ candidates, claim: { tag: 'tag-gone', sessionId: 'X' } });
  assert.equal(r.confidence, 'none', 'a stale claim must not resurrect anything');
});

test('a malformed claim falls through to the count rule rather than throwing', () => {
  assert.equal(resolveClearParent({ candidates: [{ id: 'A' }], claim: {} }).via, 'single-session');
  assert.equal(resolveClearParent({ candidates: [{ id: 'A' }], claim: { tag: 'x' } }).via, 'single-session');
  assert.equal(resolveClearParent({ candidates: [{ id: 'A' }, { id: 'B' }], claim: { sessionId: 'A' } }).confidence, 'none');
});

test('a claim never overrides the folder: a candidate without a tag cannot be claimed', () => {
  // Sessions started before the binding existed (or by a backend that declines it) carry no tag. They
  // must not be matched by a claim that happens to name their id.
  const candidates = [{ id: 'A', tag: null }, { id: 'B', tag: null }];
  assert.equal(resolveClearParent({ candidates, claim: { tag: 'tag-a', sessionId: 'A' } }).confidence, 'none');
});
