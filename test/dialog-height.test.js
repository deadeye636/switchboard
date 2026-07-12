'use strict';
// A generated dialog must never grow past the screen and take its own buttons with it.
//
// The Configure dialog and the template editor are BUILT FROM the backend's `configFields` — so they get
// taller every time a backend learns to do more. #160 took Codex from three options to nine, and the
// dialog simply ran off the bottom of the display: Start and Cancel went with it, and the only way out
// was the Escape key. Reported from the field, with a screenshot of a dialog with no bottom.
//
// Nothing in the content can cap this, and nothing should have to: the fix belongs to the FRAME. Cap its
// height, scroll the middle, pin the title and the actions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const DIALOGS = fs.readFileSync(path.join(ROOT, 'public', 'dialogs.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(ROOT, 'public', 'backends-panel.js'), 'utf8');

/** The declarations of one CSS rule. */
function rule(selector) {
  const at = CSS.indexOf(selector + ' {');
  assert.notEqual(at, -1, `${selector} must exist`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

test('the dialog frame is capped to the viewport', () => {
  assert.match(rule('.new-session-dialog'), /max-height:\s*\d+vh/,
    'a dialog taller than the screen has no bottom, and its buttons are off it');
});

test('the body scrolls — capping alone would only hide the buttons inside the frame', () => {
  const body = rule('.new-session-dialog-body');
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /min-height:\s*0/, 'a flex child will not shrink below its content without this');
});

test('the actions do not scroll away with the content', () => {
  assert.match(rule('.new-session-dialog-scroll'), /flex-direction:\s*column/);
  assert.match(rule('.new-session-dialog-scroll .new-session-actions'), /flex:\s*0 0 auto/);
});

// Both generated dialogs, because both are built from configFields and both will grow again.
test('the Configure dialog puts its generated options in the scrolling body', () => {
  assert.match(DIALOGS, /dialog\.classList\.add\('new-session-dialog-scroll'\)/);
  assert.match(DIALOGS, /<div class="new-session-dialog-body">/);
});

test('the template editor does too — and keeps its error box where it can be seen', () => {
  assert.match(PANEL, /dialog\.classList\.add\('new-session-dialog-scroll'\)/);
  assert.match(PANEL, /classList\.contains\('backend-editor-error'\)/,
    'an error you have to scroll to find is an error you miss');
  assert.match(PANEL, /classList\.contains\('settings-btn-row'\)/, 'and the buttons stay pinned');
});
