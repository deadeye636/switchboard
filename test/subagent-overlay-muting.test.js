// The subagent-activity overlay must never outrank a MUTED dot (#504).
//
// `status-unpaired` (#460) is the quietest thing a status dot does: the backend has no record of the
// session, so the dot goes hollow and still — `box-shadow: none`, `animation: none`. The subagent
// overlay carries five or six class selectors against its two, so it won on specificity alone and the
// quietest state in the app pulsed teal. Rule order cannot fix that; only the `:not()` can.
//
// Three views draw this overlay (sidebar, grid card, tab strip) and they have drifted apart before, so
// this guard reads the selectors rather than trusting that a fix reached all three.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

// Selector lists sit on their own lines in this file (one selector per line, `,`-separated).
function selectors() {
  const out = [];
  CSS.split('\n').forEach((line, i) => {
    const text = line.split('/*')[0].trim();
    if (!text || !text.startsWith('.')) return;
    for (const sel of text.replace(/\s*\{$/, '').split(',')) {
      const s = sel.trim();
      if (s) out.push({ sel: s, line: i + 1 });
    }
  });
  return out;
}

const overlayRules = () => selectors().filter(({ sel }) => sel.includes('.subagent-active'));

test('every view draws the subagent overlay, so every view is in this guard', () => {
  const views = ['.session-item', '.grid-card', '.session-tab'];
  for (const view of views) {
    assert.ok(overlayRules().some(({ sel }) => sel.startsWith(view)),
      `${view} has no subagent overlay rule — either it lost one, or this guard is looking at the wrong name`);
  }
});

test('no subagent overlay rule paints over a muted dot', () => {
  const painting = overlayRules().filter(({ sel }) => !sel.includes(':not(.status-unpaired)'));
  assert.deepEqual(painting, [],
    'add `:not(.status-unpaired)` — the overlay wins on specificity, so leaving it out makes the muted dot pulse');
});
