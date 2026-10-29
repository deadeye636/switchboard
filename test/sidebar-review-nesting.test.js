'use strict';
// Spec 39, T10: a review row nests under the session that asked for it. Which rows nest is the pure `nestReviews`
// (shell/sidebar-state.js); the caret and the rows are `appendReviewChildren` (shell/sidebar-subagents.js), loaded
// into jsdom with the few runtime names it reaches for. The click on the real sidebar is the main session's (G2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const { nestReviews } = require('../src/renderer/shell/sidebar-state');
const { stripComments } = require('./helpers/strip-comments');

const REN = path.join(__dirname, '..', 'src', 'renderer');

const row = (sessionId, over = {}) => ({ sessionId, modified: '2026-10-29T10:00:00Z', ...over });
const item = (s, over = {}) => ({ id: 'si-' + s.sessionId, topLevelId: s.sessionId, sessionIds: [s.sessionId], running: false, ...over });
const byId = (rows) => new Map(rows.map((s) => [s.sessionId, s]));

test('a review nests under its caller, newest first, and leaves the top level', () => {
  const caller = row('caller');
  const older = row('r-old', { spawnedBy: 'caller', spawnKind: 'review', modified: '2026-10-29T09:00:00Z' });
  const newer = row('r-new', { spawnedBy: 'caller', spawnKind: 'review', modified: '2026-10-29T11:00:00Z' });
  const other = row('other');
  const items = [caller, older, newer, other].map((s) => item(s));
  const out = nestReviews(items, byId([caller, older, newer, other]));
  assert.deepEqual(out.items.map((i) => i.topLevelId), ['caller', 'other']);
  assert.deepEqual(out.index.get('caller').map((s) => s.sessionId), ['r-new', 'r-old']);
});

test('a caller that is not a single row in this list leaves the review an ordinary row', () => {
  const review = row('r', { spawnedBy: 'gone', spawnKind: 'review' });
  const absent = nestReviews([item(review)], byId([review]));
  assert.deepEqual(absent.items.map((i) => i.topLevelId), ['r'], 'caller archived, filtered away or in another project');
  assert.equal(absent.index.size, 0);

  // A caller folded into a slug group has no topLevelId of its own: nothing to hang the review under.
  const caller = row('caller', { slug: 'plan-x' });
  const review2 = row('r2', { spawnedBy: 'caller', spawnKind: 'review' });
  const group = { id: 'slug-plan-x', topLevelId: null, sessionIds: ['caller', 'sibling'], running: false };
  const grouped = nestReviews([group, item(review2)], byId([caller, review2]));
  assert.deepEqual(grouped.items.map((i) => i.id), ['slug-plan-x', 'si-r2']);
});

test('only a review row nests, never under another review, and a link to itself is ignored', () => {
  const caller = row('caller');
  const review = row('r1', { spawnedBy: 'caller', spawnKind: 'review' });
  const nestedReview = row('r2', { spawnedBy: 'r1', spawnKind: 'review' });
  const notReview = row('x', { spawnedBy: 'caller', spawnKind: 'something-else' });
  const self = row('s', { spawnedBy: 's', spawnKind: 'review' });
  const out = nestReviews([caller, review, nestedReview, notReview, self].map((s) => item(s)), byId([caller, review, nestedReview, notReview, self]));
  assert.deepEqual(out.items.map((i) => i.topLevelId), ['caller', 'r2', 'x', 's']);
  assert.deepEqual(out.index.get('caller').map((s) => s.sessionId), ['r1']);
});

test('the caller item carries its reviews\' ids, so a folded caller with an OPEN review still builds its rows (#516)', () => {
  const caller = row('caller');
  const review = row('r', { spawnedBy: 'caller', spawnKind: 'review' });
  const items = [item(caller), item(review)];
  nestReviews(items, byId([caller, review]));
  assert.deepEqual(items[0].sessionIds, ['caller', 'r']);
  assert.equal(items[0].topLevelId, 'caller', 'the row it hangs under is still the caller');
});

test('a running review makes its caller running, so the caller is never folded behind "older"', () => {
  const caller = row('caller');
  const review = row('r', { spawnedBy: 'caller', spawnKind: 'review' });
  const items = [item(caller), item(review)];
  nestReviews(items, byId([caller, review]), (id) => id === 'r');
  assert.equal(items[0].running, true);
  const idle = [item(caller), item(review)];
  nestReviews(idle, byId([caller, review]), () => false);
  assert.equal(idle[0].running, false);
});

function dom() {
  const d = new JSDOM('<!DOCTYPE html><html><body><div id="list"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = d;
  const ctx = d.getInternalVMContext();
  window.sessionMap = new Map();
  window.activePtyIds = new Set();
  window.launchPending = () => false;
  window.subagentCalls = [];
  window.readLsJson = (key, fallback) => { try { return JSON.parse(window.localStorage.getItem(key) || fallback); } catch { return JSON.parse(fallback); } };
  window.buildSessionItem = (s) => {
    const el = window.document.createElement('div');
    el.className = 'session-item';
    el.id = 'si-' + s.sessionId;
    return el;
  };
  vm.runInContext(fs.readFileSync(path.join(REN, 'shell', 'sidebar-subagents.js'), 'utf8'), ctx, { filename: 'shell/sidebar-subagents.js' });
  // A stand-in for the subagent tree, so the test sees which rows were offered one.
  vm.runInContext('appendSubagentChildren = (el, id, index) => { subagentCalls.push([id, !!index]); };', ctx);
  const append = vm.runInContext('appendReviewChildren', ctx);
  const draw = (index, subagentIndex) => {
    const list = window.document.getElementById('list');
    list.innerHTML = '';
    const parent = window.document.createElement('div');
    parent.id = 'si-caller';
    list.appendChild(parent);
    append(parent, 'caller', index, subagentIndex);
    return list;
  };
  return { window, draw };
}

test('the caret and the rows sit right after the caller row; a caller with no review gets nothing', () => {
  const { draw } = dom();
  const list = draw(new Map([['caller', [row('r1'), row('r2')]]]));
  const kids = [...list.children].map((el) => el.id || el.className);
  assert.deepEqual(kids, ['si-caller', 'rev-caret-caller', 'revc-caller']);
  assert.match(list.querySelector('#rev-caret-caller').textContent, /2 reviews/);
  assert.equal(list.querySelector('#rev-caret-caller').classList.contains('sidebar-children-caret'), true, 'the existing caret style');
  assert.deepEqual([...list.querySelectorAll('#revc-caller > .session-item')].map((el) => el.id), ['si-r1', 'si-r2']);
  assert.equal(draw(new Map()).children.length, 1);
});

test('the fold defaults open, a click closes it and the next render keeps it closed; a running review stays shown', () => {
  const { window, draw } = dom();
  window.activePtyIds.add('r2');
  const kids = [row('r1'), row('r2')];
  let list = draw(new Map([['caller', kids]]));
  assert.equal(list.querySelector('#revc-caller').classList.contains('collapsed'), false);
  list.querySelector('#rev-caret-caller').dispatchEvent(new window.Event('click'));
  assert.equal(list.querySelector('#revc-caller').classList.contains('collapsed'), true);
  list = draw(new Map([['caller', kids]]));
  assert.equal(list.querySelector('#revc-caller').classList.contains('collapsed'), true, 'a re-render keeps the fold');
  assert.equal(list.querySelector('#rev-caret-caller').getAttribute('aria-expanded'), 'false');
  assert.equal(list.querySelector('#si-r2').classList.contains('review-running'), true, 'a live pty is running');
  assert.equal(list.querySelector('#si-r1').classList.contains('review-running'), false);
  window.launchPending = (id) => id === 'r1';
  list = draw(new Map([['caller', kids]]));
  assert.equal(list.querySelector('#si-r1').classList.contains('review-running'), true, 'a pending launch is running too');
  const css = fs.readFileSync(path.join(REN, 'style.css'), 'utf8');
  assert.match(css, /\.sidebar-reviews-container\.collapsed > :not\(\.review-running\):not\(\.has-running-pty\)\s*\{\s*display: none;/,
    'a closed fold hides only what is not running');
});

test('a review row is offered its own subagent tree, and only when subagents nest', () => {
  const { window, draw } = dom();
  draw(new Map([['caller', [row('r1')]]]), new Map());
  // Built in the vm's realm: compared through JSON (.claude/rules/guards-and-scripts.md).
  const calls = () => JSON.parse(JSON.stringify(window.subagentCalls));
  assert.deepEqual(calls(), [['r1', true]]);
  window.subagentCalls.length = 0;
  draw(new Map([['caller', [row('r1')]]]), null);
  assert.deepEqual(calls(), [], 'while subagents do not nest, nothing is offered');
});

test('the push: the runner asks for a projects reload once linked, and a live row carries the link', () => {
  const runner = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'review-runner.js'), 'utf8'));
  assert.ok(runner.indexOf('ctx.notifyProjectsChanged()') > runner.indexOf('ctx.linkSession('), 'after the link is written');
  const app = stripComments(fs.readFileSync(path.join(REN, 'app.js'), 'utf8'));
  const synth = app.slice(app.indexOf('function syntheticSessionRow'), app.indexOf('function dropSessionFromCachedLists'));
  assert.match(synth, /spawnedBy: live\.spawnedBy \|\| null/);
  assert.match(synth, /spawnKind: live\.spawnKind \|\| null/);
});

test('both session lists hand the review index on, and the row marks a review with the existing pill', () => {
  const sidebar = stripComments(fs.readFileSync(path.join(REN, 'shell', 'sidebar.js'), 'utf8'));
  assert.equal((sidebar.match(/appendReviewChildren\(element, item\.topLevelId, reviewIndex, nestSubagents \? subagentIndex : null\)/g) || []).length, 2, 'visible and older rows');
  assert.match(sidebar, /result\.reviewIndex\)/);
  assert.match(sidebar, /wtResult\.reviewIndex\)/);
  const rowSrc = stripComments(fs.readFileSync(path.join(REN, 'shell', 'sidebar-session-row.js'), 'utf8'));
  assert.match(rowSrc, /session\.spawnKind === 'review'/);
  assert.match(rowSrc, /'session-detail-pill session-review-chip'/);
});
