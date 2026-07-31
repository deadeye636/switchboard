// #381 — the three sidebar-TAB views ask main whether they are already open elsewhere, and they ask
// under the TAB name. That works only because the tab name and the view kind are the same string for
// all three, which nothing in the code says out loud: `ADMIN_TABS` lives in `renderer/app.js` and
// `VIEW_KINDS` in `renderer/views/panes-view.js`, and neither mentions the other.
//
// A tab renamed on one side would then ask about a kind that does not exist. `focus-view-window`
// answers `{focused:false}` for an unknown kind — so the duplicate quietly comes back, with no error
// anywhere and every test still green. Hence a guard rather than a comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

function adminTabs() {
  const m = read('renderer/app.js').match(/ADMIN_TABS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'ADMIN_TABS not found in renderer/app.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function viewKinds() {
  const src = read('renderer/views/panes-view.js');
  const block = src.match(/const VIEW_KINDS = \{([\s\S]*?)\n  \};/);
  assert.ok(block, 'VIEW_KINDS not found in views/panes-view.js');
  return block[1]
    .split('\n')
    .map((line) => line.match(/^\s{4}([A-Za-z][A-Za-z0-9]*)\s*:\s*\{/))
    .filter(Boolean)
    .map((m) => m[1]);
}

test('#381: every admin tab name is also a view kind', () => {
  const kinds = new Set(viewKinds());
  const tabs = adminTabs();
  assert.ok(tabs.length >= 3, 'the three sidebar-tab views should still be there');
  for (const tab of tabs) {
    assert.ok(kinds.has(tab), `admin tab "${tab}" has no matching VIEW_KINDS entry — the duplicate check would ask about a kind nobody knows`);
  }
});

test('#381: each of them is a view the tab OWNS, so its × goes back through the sidebar', () => {
  // `close: 'admin'` is what routes the tab's × to `closeAdminView()` rather than the viewer
  // teardown, and it is the same three. If a tab were admin here but not there, closing it would
  // leave the sidebar asserting a view that is gone (#342) — the defect that rule exists to prevent.
  const src = read('renderer/views/panes-view.js');
  for (const tab of adminTabs()) {
    const line = src.split('\n').find((l) => new RegExp(`^\\s{4}${tab}\\s*:\\s*\\{`).test(l));
    assert.ok(line, `no VIEW_KINDS line for "${tab}"`);
    assert.match(line, /close:\s*'admin'/, `VIEW_KINDS.${tab} should carry close: 'admin'`);
  }
});
