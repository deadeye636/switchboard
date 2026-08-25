'use strict';
// #473 — the keyboard route from a session to writing a handoff.
//
// WHY THIS EXISTS:
//   Writing a handoff used to be mouse-only: a chip in the sidebar and the same chip on a grid card,
//   both on a row you have to leave the terminal to reach. The route added instead is a command-palette
//   action, and the two things that can quietly go wrong with it are exactly what is pinned here.
//
//   One: WHICH session it means. The rule is `focusedActionSession()` — the session the app holds as
//   active, not the DOM focus — and the action NAMES it, because a row that says "Write a handoff" while
//   three sessions are open is a guess the user has to make. If a later change drops the name from the
//   title, this file fails.
//
//   Two: it must reach the SAME flow the chip opens (`showHandoffPrompt`), not a second one. A second
//   way in that skips the producer choice or the review would spend tokens without the confirmation the
//   flow asks for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REN = path.join(__dirname, '..', 'src', 'renderer');
const ACTIONS = fs.readFileSync(path.join(REN, 'shell', 'command-actions.js'), 'utf8');
const HANDOFF = fs.readFileSync(path.join(REN, 'handoff', 'handoff.js'), 'utf8');

// The renderer's classic scripts share one global scope, so the test builds that scope: the registry
// first (it is what handoff.js calls at parse time), then handoff.js itself, with the free globals it
// reaches for stubbed. `showHandoffPrompt` is replaced AFTER the load so the action's call is observable
// without the dialog it would otherwise open.
function load({ session = null } = {}) {
  const opened = [];
  const ctx = vm.createContext({});
  ctx.window = ctx;
  ctx.sessionMap = new Map();
  ctx.openSessions = new Map();
  ctx.focusedActionSession = () => session;
  ctx.cleanDisplayName = (s) => (s || '').trim();
  vm.runInContext(ACTIONS, ctx);
  vm.runInContext(HANDOFF, ctx);
  ctx.showHandoffPrompt = (s) => { opened.push(s); };
  return { ctx, opened, action: () => ctx.listCommandActions().find(a => a.id === 'handoff.create') };
}

test('the action is absent when no session is active', () => {
  const { action } = load({ session: null });
  assert.equal(action(), undefined,
    'offered everywhere and failing on use is the shape this replaces');
});

test('the action names the session it would write about', () => {
  const { action } = load({ session: { sessionId: 's1', name: 'refactor settings screen' } });
  assert.equal(action().title, 'Write a handoff for “refactor settings screen”');
});

test('a session with no name falls back to its id rather than to an empty pair of quotes', () => {
  const { action } = load({ session: { sessionId: 's1' } });
  assert.equal(action().title, 'Write a handoff for “s1”');
});

test('taking the action opens the same flow the health chip opens', async () => {
  const session = { sessionId: 's1', name: 'a' };
  const { action, opened } = load({ session });
  await action().run();
  assert.deepEqual(opened, [session]);
});

test('the action asks again when it runs, so a session that ended in the meantime opens nothing', async () => {
  const session = { sessionId: 's1', name: 'a' };
  const { ctx, action, opened } = load({ session });
  const row = action();
  ctx.focusedActionSession = () => null;      // the session ended while the palette was open
  await row.run();
  assert.deepEqual(opened, []);
});

test('startHandoffForSession turns an id into the session, and does nothing when it does not resolve', async () => {
  const session = { sessionId: 's1', name: 'a' };
  const { ctx, opened } = load({ session: null });
  ctx.sessionMap.set('s1', session);
  await ctx.startHandoffForSession('s1');
  assert.deepEqual(opened, [session]);
  await ctx.startHandoffForSession('gone');
  await ctx.startHandoffForSession(null);
  assert.equal(opened.length, 1, 'a dialog about a session that is gone is worse than no dialog');
});

test('a mounted session that is no longer in the map is still reachable', async () => {
  // `openSessions` outlives `sessionMap` for a session whose row was dropped from the sidebar; the
  // packet is about the work, and the work is still on screen.
  const session = { sessionId: 's1', name: 'a' };
  const { ctx, opened } = load({ session: null });
  ctx.openSessions.set('s1', { session });
  await ctx.startHandoffForSession('s1');
  assert.deepEqual(opened, [session]);
});
