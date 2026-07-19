'use strict';
// The clear-claim registry (#223) — "terminal <tag> just reset session <id>".
//
// This is the state behind the one thing that makes a multi-session re-key safe: a claim is a FACT the
// CLI reported (Claude's SessionEnd fires with reason "clear" and the old id, posted to a per-terminal
// URL), not an inference from mtimes or keystrokes. Both of those were tried and rejected — see
// session-lineage.js for why the mtime window mis-keys a bystander.
//
// So what these pin is the small set of rules that keep a fact from turning into a guess: claims expire,
// a dead terminal's claim explains nothing, two claims in one window are still ambiguous, and a consumed
// claim cannot win twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const claims = require('../src/session/clear-claims');

test.beforeEach(() => claims._resetForTests());

test('a claim is recorded and found again', () => {
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1', folder: 'proj' });
  const one = claims.resolveSingleClaim({ folder: 'proj', liveTags: ['t1'] });
  assert.equal(one.sessionId, 'S1');
  assert.equal(one.tag, 't1');
});

test('an incomplete claim is not recorded — a half-fact is not a fact', () => {
  assert.equal(claims.recordClearClaim({ tag: 't1' }), null);
  assert.equal(claims.recordClearClaim({ sessionId: 'S1' }), null);
  assert.deepEqual(claims.claimsFor({}), []);
});

test('a claim from a terminal that is no longer live is ignored', () => {
  // Its PTY exited between the clear and the child appearing. Acting on it would re-key a dead row.
  claims.recordClearClaim({ tag: 'gone', sessionId: 'S1' });
  assert.equal(claims.resolveSingleClaim({ liveTags: ['other'] }), null);
});

test('TWO claims in one folder stay ambiguous — this is the case that must never be guessed', () => {
  // Both terminals cleared inside the window; both children are appearing. Picking one would put a
  // terminal on another session's transcript, which is the exact failure #223 forbids.
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1', folder: 'proj' });
  claims.recordClearClaim({ tag: 't2', sessionId: 'S2', folder: 'proj' });
  assert.equal(claims.resolveSingleClaim({ folder: 'proj', liveTags: ['t1', 't2'] }), null);
  assert.equal(claims.claimsFor({ folder: 'proj', liveTags: ['t1', 't2'] }).length, 2);
});

test('…but two claims in DIFFERENT folders do not shadow each other', () => {
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1', folder: 'projA' });
  claims.recordClearClaim({ tag: 't2', sessionId: 'S2', folder: 'projB' });
  assert.equal(claims.resolveSingleClaim({ folder: 'projA', liveTags: ['t1', 't2'] }).sessionId, 'S1');
  assert.equal(claims.resolveSingleClaim({ folder: 'projB', liveTags: ['t1', 't2'] }).sessionId, 'S2');
});

test('a claim with no folder still answers a folder-scoped lookup', () => {
  // The hook payload carries no folder, so claims are recorded without one. Filtering them out would
  // discard every real claim; the liveTags filter is what keeps a foreign terminal out.
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1' });
  assert.equal(claims.resolveSingleClaim({ folder: 'proj', liveTags: ['t1'] }).sessionId, 'S1');
});

test('a claim expires', () => {
  const t0 = 1_000_000;
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1', now: t0 });
  assert.ok(claims.resolveSingleClaim({ liveTags: ['t1'], now: t0 + claims.CLAIM_TTL_MS - 1 }));
  assert.equal(claims.resolveSingleClaim({ liveTags: ['t1'], now: t0 + claims.CLAIM_TTL_MS + 1 }), null,
    'an old claim must not pair with an unrelated clear minutes later');
});

test('a second clear in one terminal replaces the first claim', () => {
  // Otherwise the stale claim (whose child was already matched) could win a later pairing.
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1' });
  claims.recordClearClaim({ tag: 't1', sessionId: 'S2' });
  const all = claims.claimsFor({ liveTags: ['t1'] });
  assert.equal(all.length, 1);
  assert.equal(all[0].sessionId, 'S2');
});

test('a consumed claim cannot win again', () => {
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1' });
  assert.equal(claims.releaseClaim('t1'), true);
  assert.equal(claims.resolveSingleClaim({ liveTags: ['t1'] }), null);
});

test('forgetting a terminal drops its claim', () => {
  claims.recordClearClaim({ tag: 't1', sessionId: 'S1' });
  claims.forgetTag('t1');
  assert.equal(claims.resolveSingleClaim({ liveTags: ['t1'] }), null);
});
