// Guards for the launch menu's Custom commands submenu (#616).
//
// The popover itself is built by `showNewSessionPopover`, which reaches for `window.api`, the backend
// caches and a live anchor element — driving it under `node --test` would assert against the mocks
// rather than the menu. The behaviour was verified against the running app (hover opens the flyout,
// it flips left at the window edge, a click inside it launches the tool).
//
// What is worth guarding is the wiring, because each of these fails silently:
//
//   * a saved tool appended to the POPOVER again — the flat list is back and nothing says so;
//   * the entry built when the list is empty — a row that opens onto nothing;
//   * a second copy of the flyout geometry here, instead of the `openSubmenu`/`closeSubmenu` that
//     `terminal/terminal-context-menu.js` owns — two menus that clamp differently at the same edge;
//   * the CSS scoped back under `.terminal-context-menu`, which leaves this flyout unstyled: a white
//     box of native buttons over a dark menu, with every test still green;
//   * the project's VS Code tasks (step 2) drawn as a flyout of their own inside this one — `closeSubmenu`
//     does not reset a nested `.popover-submenu`, so it would reappear unhovered — or a task that cannot
//     run left clickable.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const dialogs = stripComments(read('renderer/dialogs/dialogs.js'));
const css = read('renderer/style.css');

// The block that builds the entry, so a match cannot come from somewhere else in a 2000-line file.
const submenuBlock = (() => {
  const start = dialogs.indexOf('if (launchers.length || vscodeTasks.length)');
  assert.notEqual(start, -1, 'the Custom commands entry is no longer guarded by the two lists it holds');
  const end = dialogs.indexOf('popover.appendChild(parent)', start);
  assert.notEqual(end, -1, 'the flyout parent is never appended to the popover');
  return dialogs.slice(start, end);
})();

test('the entry is built only when there is something under it', () => {
  // A heading — or here a row — over an empty list is the thing the group labels above already avoid.
  // Either list is enough: saved launchers alone, or only the project's VS Code tasks (E7).
  assert.match(dialogs, /if \(launchers\.length \|\| vscodeTasks\.length\) \{/);
});

test('the VS Code tasks are a section of the flyout, not a flyout of their own', () => {
  assert.match(submenuBlock, /textContent = 'From VS Code'/, 'the tasks have no group label in the flyout');
  assert.equal((submenuBlock.match(/className = 'popover-submenu'/g) || []).length, 1,
    'a second flyout is nested inside the Custom commands one');
  assert.match(submenuBlock, /btn\.className = 'popover-option popover-option-terminal popover-option-launcher popover-option-task'/);
  assert.match(submenuBlock, /popover-option-tag">VS Code</, 'a task row no longer says where it comes from');
  for (const cls of ['popover-option-task', 'popover-option-lines', 'popover-option-line', 'popover-option-subline']) {
    assert.ok(new RegExp(`\\.${cls}[\\s,{:.]`).test(css), `style.css no longer defines .${cls}`);
  }
});

test('a task that cannot run is listed but not clickable, and the keyboard skips it', () => {
  // E2: listed with its reason, never hidden — and never a button that does nothing.
  assert.match(submenuBlock, /if \(task\.disabled\) \{\s*btn\.disabled = true;/);
  assert.match(submenuBlock, /querySelector\('\.popover-option:not\(:disabled\)'\)/,
    'Enter on the entry can focus a disabled task row');
});

test('a saved launcher goes into the flyout, never back onto the popover', () => {
  assert.match(submenuBlock, /sub\.appendChild\(btn\)/, 'the launcher button is not appended to the flyout');
  assert.doesNotMatch(submenuBlock, /popover\.appendChild\(btn\)/, 'a launcher is appended to the popover again — the flat list is back');
});

test('the flyout reuses the terminal menu geometry rather than deriving its own', () => {
  assert.match(submenuBlock, /openSubmenu\(parent, sub\)/, 'the flyout never calls openSubmenu');
  assert.match(submenuBlock, /closeSubmenu\(sub\)/, 'the flyout never closes on mouseleave');
  // A second clamping rule here is the divergence this reuse exists to prevent: the two menus would
  // flip in different directions at the same window edge, and only one of them would be tested.
  assert.doesNotMatch(submenuBlock, /innerWidth|getBoundingClientRect|style\.left/,
    'the flyout positions itself — that answer belongs to openSubmenu');
});

test('it opens on focus as well as hover, so the keyboard reaches it', () => {
  assert.match(submenuBlock, /addEventListener\('mouseenter'/);
  assert.match(submenuBlock, /addEventListener\('focusin'/);
});

test('the classes the JS writes are the ones the CSS defines', () => {
  // One-directional matching is how this guard would have stayed green through the failure it exists
  // to catch: `display: none` lives on the `.popover-submenu` rule, so renaming the class in the JS
  // alone leaves the flyout permanently open, unstyled, inside the popover. Both sides, or neither.
  for (const cls of ['popover-submenu', 'popover-submenu-label', 'has-submenu', 'submenu-arrow']) {
    assert.ok(new RegExp(`['"\`][^'"\`]*\\b${cls}\\b`).test(submenuBlock), `the entry no longer writes .${cls}`);
    assert.ok(new RegExp(`\\.${cls}[\\s,{:.]`).test(css), `style.css no longer defines .${cls}`);
  }
  // The row and the launcher buttons are popover options first — that is where their padding, colour
  // and hover come from (reflex 8: a control with only a behaviour class renders as a native button).
  assert.match(submenuBlock, /parent\.className = 'popover-option popover-option-terminal has-submenu'/);
  assert.match(submenuBlock, /btn\.className = 'popover-option popover-option-terminal popover-option-launcher'/);
});

test('the row answers the keyboard it claims to answer', () => {
  // `role="button"` without an activation is a promise the row does not keep.
  assert.match(submenuBlock, /setAttribute\('role', 'button'\)/);
  assert.match(submenuBlock, /addEventListener\('keydown'/, 'the row claims role=button but answers no key');
  assert.match(submenuBlock, /aria-expanded', 'true'/, 'aria-expanded is never set on open');
  assert.match(submenuBlock, /aria-expanded', 'false'/, 'aria-expanded is never cleared on close');
});

test('the flyout CSS is not scoped to the terminal context menu', () => {
  // `.terminal-context-menu .has-submenu` would leave the launch popover's row unstyled — a bare
  // native button row inside a dark menu. The rules are deliberately unscoped.
  assert.doesNotMatch(css, /\.terminal-context-menu\s+\.has-submenu/,
    'the flyout parent rules are scoped back under the terminal menu');
  assert.doesNotMatch(css, /\.terminal-context-menu\s+\.submenu-arrow/,
    'the arrow rule is scoped back under the terminal menu');
  assert.match(css, /\.terminal-context-submenu,\s*\n\.popover-submenu \{/,
    'the flyout surface no longer covers .popover-submenu');
});

test('the Terminal group keeps its own hover colour on the flyout row', () => {
  // `.has-submenu:hover` is neutral grey and sits later in the file, so without this rule the one row
  // of the Terminal group that opens a flyout would hover a different colour than the rows above it.
  assert.match(css, /\.popover-option-terminal\.has-submenu:hover/);
});
