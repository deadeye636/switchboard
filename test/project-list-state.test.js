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

const { projectsFailureNotice } = require('../src/renderer/lib/project-list-state');
const fs = require('node:fs');
const path = require('node:path');

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

// The guarantee this issue is actually about lives in `loadProjects`, as control flow: the failure path
// returns BEFORE it assigns, so the pending-session reconciliation below it never runs against a list
// that failed. app.js is a classic script that cannot be required, so this reads it as text.
//
// That makes it a WIRING GUARD, not a behaviour test — it sees that the early return is still there, not
// that the app does the right thing with it. The behaviour was verified by breaking the store under a
// running app (rename session_cache, refresh, sidebar keeps its rows). Re-verify that way after touching
// this function; a green line here is not a substitute.
test('loadProjects still returns from its failure path before assigning the list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const start = src.indexOf('async function loadProjects(');
  assert.ok(start !== -1, 'loadProjects was renamed — update this guard');

  // The getProjects call and its catch, up to the generation check that follows them.
  const region = src.slice(start, start + 3000);
  const catchAt = region.indexOf('} catch (err) {');
  assert.ok(catchAt !== -1, 'the listing is no longer wrapped — #431 depends on it being caught here');
  const catchBody = region.slice(catchAt, region.indexOf('\n  }', catchAt));

  assert.match(catchBody, /\breturn\b/, 'the failure path must leave before the assignment below it');
  assert.doesNotMatch(catchBody, /cachedProjects\s*=/, 'nothing may replace the list on a failed read');
  assert.match(catchBody, /showProjectsError\(/, 'and the failure has to be said out loud');
  assert.match(catchBody, /myGen !== loadProjectsGen/, 'a stale failure must not overwrite a newer answer');
});

// The reconciliation is the specific thing that must not run: against a list that failed, every pending
// id looks absent and every pending session is re-injected as if its launch were still in flight.
test('the pending-session reconciliation sits after the failure path, not before it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const start = src.indexOf('async function loadProjects(');
  const catchAt = src.indexOf('} catch (err) {', start);
  const reconcileAt = src.indexOf('for (const [sid, pending] of [...pendingSessions])', start);
  assert.ok(reconcileAt !== -1, 'the reconciliation loop moved — re-check that the failure path still skips it');
  assert.ok(catchAt < reconcileAt, 'it must be reachable only past the catch that returns');
});
