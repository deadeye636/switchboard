'use strict';
// The next-attention shortcut only ever targets a session the current window can actually show (#394).
//
// WHY THIS EXISTS:
//   The shortcut walks every session the APP knows of. In the main window that is right — it can open
//   any of them. A window of its own can only show the sessions it holds, so the same walk could land
//   on one living in another window and focus nothing at all: a shortcut that silently does nothing is
//   worse than one that is disabled.
//
//   It was invisible until now, because such a window never learned which sessions were waiting, so the
//   walk found nothing to land on either way. #395 gave it that state, which turned a latent defect into
//   a reachable one — and that is exactly the kind of second-order break a later change would be blamed
//   for.
//
//   The check is on the source rather than on a running renderer: app.js is the monolith the shell
//   modules were cut out of, and standing it up needs the whole DOM. What matters here is one decision,
//   and it is visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

/** The body of a top-level function declaration, brace-matched. */
function bodyOf(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone — this test is about it`);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test('the shortcut narrows its candidates in a window of its own', () => {
  const body = bodyOf('focusNextAttention');
  assert.match(body, /isDetachedWindow/,
    'without this the shortcut can target a session this window does not hold');
  assert.match(body, /sessionIdsInThisWindow/,
    'and the set has to be the window\'s own answer — `openSessions` holds MOUNTED terminals only, so '
    + 'scoping with it makes a dormant tab in this very window unreachable');
});

test('the narrowing keeps what this window holds, rather than dropping it', () => {
  // The inverted version of this filter is the same bug seen from the other side: a shortcut that
  // walks only the sessions living somewhere else. Pin the direction, not just the identifiers.
  const body = bodyOf('focusNextAttention');
  assert.match(body, /mine\.has\(s\.sessionId\)/, 'keep the ones that are mine');
  assert.doesNotMatch(body, /!\s*mine\.has\(/, 'not the ones that are not');
});

test('the main window still walks everything it knows', () => {
  const body = bodyOf('focusNextAttention');
  assert.match(body, /getAllKnownSessionsForStatus\(\)/);
  // The narrowing is conditional, so the unnarrowed list is still what the main window gets — a guard
  // that returned early would disable the shortcut there instead of scoping it.
  assert.doesNotMatch(body, /if\s*\([^)]*isDetachedWindow[^)]*\)\s*return/,
    'a window of its own gets a smaller list, not no shortcut');
});

test('there is one answer to "which sessions are in this window", not two', () => {
  // It was derived twice — the window title got it right, the shortcut got it subtly wrong. The point
  // of naming it is that the next caller cannot get a third answer.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shell', 'detach-window.js'), 'utf8');
  assert.match(src, /function sessionIdsInThisWindow\(\)/);
  assert.match(src, /window\.sessionIdsInThisWindow = sessionIdsInThisWindow/);
  const derivations = src.match(/panes\.sessionIdsInLayout\(\)\s*:\s*\[\.\.\.openSessions\.keys\(\)\]/g) || [];
  assert.equal(derivations.length, 1, 'derived in one place only');
});
