'use strict';
// A refused project action must stop the WHOLE action — the renderer half (#574, #578).
//
// The main-process guards are pinned in `projects.test.js`: `deleteProjectSessions` and `removeProject`
// both answer `{ error }` while this app runs a session in the project. That is only half of the promise.
// The Projects admin runs the delete, the removal and the per-backend config deletes as ONE sequence, and
// every step used to fall through to the next — the removal's comment said `// always`. A refusal that
// carries on reads as "history kept, project gone" or "project kept, its Codex entry gone", neither of
// which the dialog offered, and it drops entries out of the backends' own config files for a project that
// is still on the list.
//
// #574 fixed the first step and #578 the second, so this reads the source once and asserts the shape for
// both, plus the on-the-list toggle that used to throw the answer away entirely. It is a text guard
// because the alternative is loading a renderer panel that expects a DOM, `window.api` and three globals
// — and what it protects is a control-flow shape, which text can see.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panels', 'projects-admin.js');

// The comments have to go first: this file's prose quotes the very calls being looked for, and a guard
// that reads them would pass on a paragraph while the code below it did the wrong thing.
const src = stripComments(fs.readFileSync(PANEL, 'utf8'));

/** The body of one `action === '<name>'` branch, up to whichever branch comes next. */
function branch(name) {
  const start = src.indexOf(`action === '${name}'`);
  assert.notStrictEqual(start, -1, `the ${name} branch is still in projects-admin.js`);
  const next = src.indexOf('action ===', start + 10);
  return src.slice(start, next === -1 ? src.length : next);
}

// `if (x && x.error) { … return; }` — the shape the panel already uses for every other refusal.
const STOPS = /if \(\w+ && \w+\.error\) \{[^{}]*return;[^{}]*\}/;

test('a refused removal does not fall through to the per-backend config deletes (#578)', () => {
  const body = branch('remove');

  const removal = body.indexOf('removeProject(path)');
  const configs = body.indexOf('removeProjectConfig(');
  assert.notStrictEqual(removal, -1, 'the remove branch still takes the project off the list');
  assert.notStrictEqual(configs, -1, 'and still offers to drop the backends\' config entries');
  assert.ok(removal < configs, 'the removal runs first — the config deletes are the fall-through');

  const between = body.slice(removal, configs);
  assert.match(between, STOPS,
    'a refused removal stops the action instead of dropping config entries for a project that is still listed');
});

test('a refused delete still stops the action before the removal (#574)', () => {
  const body = branch('remove');

  const del = body.indexOf('deleteProjectSessions(');
  const removal = body.indexOf('removeProject(path)');
  assert.notStrictEqual(del, -1, 'the remove branch still offers to delete the history');
  assert.ok(del < removal, 'the delete runs before the removal — it reads the rows the removal clears');

  assert.match(body.slice(del, removal), STOPS,
    'a refused delete stops the action instead of removing the project whose history it just failed to delete');
});

test('the on-the-list toggle reports a refused removal instead of discarding it (#578)', () => {
  const body = branch('allowlist');

  const removal = body.indexOf('removeProject(path)');
  assert.notStrictEqual(removal, -1, 'the toggle still removes a project that is on the list');
  assert.match(body.slice(removal), STOPS,
    'the toggle checks the answer — a refusal here used to look like a checkbox that would not stay unticked');
});
