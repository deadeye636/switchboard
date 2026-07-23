// A `.session-item` can CONTAIN other `.session-item`s — a folded lineage ancestor (#193) and a nested
// subagent row (#112). So a state rule written as `.session-item.<state> .<child>` does not style "this
// row", it styles every row underneath it too: an idle ancestor wearing the head's Stop button and the
// head's busy shimmer (#288).
//
// The fix is the `> .session-row` scoping the hover/active rules already used. This guard keeps it: the
// first combinator after a stateful `.session-item.<class>` selector must be the child combinator, never a
// descendant space. Nothing else in the suite looks at CSS.
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

test('no state rule on .session-item reaches into a NESTED row', () => {
  // `.session-item.<state>` followed by a descendant combinator and another simple selector.
  const leaking = selectors().filter(({ sel }) => /^\.session-item\.[^\s>]+\s+[.:#a-z]/i.test(sel));
  assert.deepEqual(leaking, [],
    'scope it to the row\'s own `> .session-row`, or the head\'s state paints its lineage ancestors and subagents');
});

// The selector check above only sees rules that REACH DOWN with a combinator. A rule on the item itself
// leaks just as far when its property cascades into the subtree — `opacity` on an archived head dimmed the
// ancestor rows folded under it, and no descendant selector was involved (#288).
test('no state rule on .session-item cascades into the subtree from the item itself', () => {
  const CASCADING = /^\s*(opacity|color|filter|font-[a-z-]+|text-[a-z-]+|visibility)\s*:/;
  const lines = CSS.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    const sel = line.split('/*')[0].trim();
    if (!/^\.session-item\.[^\s>{,]+\s*\{$/.test(sel)) return;
    for (let j = i + 1; j < lines.length && !lines[j].includes('}'); j++) {
      if (CASCADING.test(lines[j])) offenders.push({ sel, decl: lines[j].trim(), line: j + 1 });
    }
  });
  assert.deepEqual(offenders, [],
    'put the declaration on `> .session-row`, or a nested lineage ancestor inherits the head\'s look');
});

test('the status chip keys on its OWN status class, not on an ancestor\'s', () => {
  // The chip carries status.className itself (buildSessionItem + patchSidebarStatuses), so an ancestor
  // form is both unnecessary and wrong inside a nested row.
  const ancestorForm = selectors().filter(({ sel }) => /^\.status-[a-z-]+\s+\.session-status-chip$/.test(sel));
  assert.deepEqual(ancestorForm, [], 'write `.session-status-chip.status-<x>` instead');
});
