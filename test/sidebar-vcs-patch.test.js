// vm.runInContext tests for shell/sidebar-vcs.js — patchSidebarChips (#515).
//
// WHY THIS EXISTS:
//   A VCS status change used to answer with a full refreshSidebar(), measured at 120-500 ms of main
//   thread per push. It patches the rendered chip instead now, and the only thing standing between that
//   and #229's trap is the rule that a patch must write exactly what the next render would produce —
//   which no suite can check by reading the source. So this loads the REAL module into a jsdom vm
//   context, builds the DOM the sidebar builds, and asserts both halves of the contract: what the patch
//   writes, and — the half that actually protects the user — WHEN it refuses and hands back the rebuild.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'shell', 'sidebar-vcs.js');

function setup({ showBadge = true, chipEnabled = true } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sidebar"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const ctx = dom.getInternalVMContext();

  // What the module reaches for at call time. `onVcsStatusChanged` is captured rather than stubbed away:
  // the push handler is where the patch/rebuild decision is made, so the test drives the real one.
  let pushHandler = null;
  const refreshCalls = { n: 0 };
  Object.assign(ctx, {
    escapeHtml: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    vcsChipEnabled: chipEnabled,
    vcsShowBadge: showBadge,
    refreshSidebar: () => { refreshCalls.n++; },
  });
  window.api = { onVcsStatusChanged: (cb) => { pushHandler = cb; }, openChangesWindow: () => {} };

  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx);

  // The sidebar's own markup for one decorated project header, as decorateHeader builds it.
  const mount = (cwd) => {
    const group = window.document.createElement('div');
    group.innerHTML =
      '<div class="project-header">'
      + '<button class="project-vcs-btn vcs-open" data-vcs-cwd="' + cwd + '"></button>'
      + '</div>'
      + (showBadge
        ? '<div class="vcs-pill-row"><span class="vcs-pill vcs-open" data-vcs-cwd="' + cwd + '"></span></div>'
        : '');
    window.document.getElementById('sidebar').appendChild(group);
  };

  return {
    window, ctx, mount, refreshCalls,
    patch: (cwd, summary) => window.vcsView.patchSidebarChips(cwd, summary),
    push: (payload) => {
      // ensureSubscribed runs on the first beginCollect; the handler only exists after that.
      window.vcsView.beginCollect();
      window.vcsView.endCollect();
      pushHandler(payload);
    },
    btn: (cwd) => window.document.querySelector('.project-vcs-btn[data-vcs-cwd="' + cwd + '"]'),
    pill: (cwd) => window.document.querySelector('.vcs-pill[data-vcs-cwd="' + cwd + '"]'),
    destroy: () => window.close(),
  };
}

const CLEAN = { branch: 'main', staged: 0, unstaged: 0, untracked: 0, conflicted: 0, state: null };
const DIRTY = { branch: 'main', staged: 1, unstaged: 2, untracked: 3, conflicted: 0, state: null };

test('#515: a status change patches the pill in place and reports that it handled it', () => {
  const h = setup();
  try {
    h.mount('/repo/a');
    assert.equal(h.patch('/repo/a', DIRTY), true, 'the patch handled it');
    const html = h.pill('/repo/a').innerHTML;
    assert.match(html, /main/, 'the branch is written');
    assert.match(html, /\+1/, 'staged count');
    assert.match(html, /●2/, 'unstaged count');
    assert.match(html, /\?3/, 'untracked count');
    assert.equal(h.btn('/repo/a').classList.contains('has-changes'), true, 'the glyph marks the repo dirty');
  } finally { h.destroy(); }
});

test('#515: a repo that went clean loses the dirty mark, so the patch cannot only ever add', () => {
  const h = setup();
  try {
    h.mount('/repo/a');
    h.patch('/repo/a', DIRTY);
    h.patch('/repo/a', CLEAN);
    assert.equal(h.btn('/repo/a').classList.contains('has-changes'), false, 'the dirty mark is cleared');
    assert.match(h.pill('/repo/a').innerHTML, /✓/, 'a clean repo shows the tick');
  } finally { h.destroy(); }
});

test('#515: an in-progress state sets and then clears its own class', () => {
  const h = setup();
  try {
    h.mount('/repo/a');
    h.patch('/repo/a', { ...CLEAN, state: 'rebase' });
    assert.equal(h.pill('/repo/a').classList.contains('vcs-inprogress'), true, 'rebase marks the pill');
    h.patch('/repo/a', CLEAN);
    assert.equal(h.pill('/repo/a').classList.contains('vcs-inprogress'), false, 'and leaving it unmarks it');
  } finally { h.destroy(); }
});

test('#515: a chip that is not on screen yet is STRUCTURAL — the patch refuses', () => {
  const h = setup();
  try {
    // Nothing mounted: this cwd's header has never been rendered with a chip.
    assert.equal(h.patch('/repo/never-rendered', DIRTY), false, 'the caller must rebuild');
  } finally { h.destroy(); }
});

test('#515: a chip that has to disappear is STRUCTURAL — the patch refuses', () => {
  const h = setup();
  try {
    h.mount('/repo/a');
    assert.equal(h.patch('/repo/a', null), false, 'a summary going away needs the rebuild');
  } finally { h.destroy(); }
});

test('#515: the badge setting disagreeing with the DOM is STRUCTURAL — the patch refuses', () => {
  // Rendered without a pill (badge off at render time), badge on now: the pill has to appear, and only
  // a render can put it there.
  const h = setup({ showBadge: false });
  try {
    h.mount('/repo/a');
    h.ctx.vcsShowBadge = true;
    assert.equal(h.patch('/repo/a', DIRTY), false, 'a pill that has to appear needs the rebuild');
  } finally { h.destroy(); }
});

test('#515: the badge going OFF under a rendered pill is STRUCTURAL too — the other direction', () => {
  // The mirror of the test above. It rides the same guard line, and a guard that only holds in one
  // direction is the kind that gets simplified away by someone who only read one test.
  const h = setup({ showBadge: true });
  try {
    h.mount('/repo/a');
    h.ctx.vcsShowBadge = false;
    assert.equal(h.patch('/repo/a', DIRTY), false, 'a pill that has to go needs the rebuild');
  } finally { h.destroy(); }
});

test('#515: an in-progress repo with no counts still marks the glyph dirty', () => {
  // The dirty test is counts OR state, and the glyph reads it as much as the pill does. With the two
  // halves written out separately this combination was the one that could quietly disagree.
  const h = setup();
  try {
    h.mount('/repo/a');
    h.patch('/repo/a', { ...CLEAN, state: 'rebase' });
    assert.equal(h.btn('/repo/a').classList.contains('has-changes'), true,
      'a rebase with nothing modified is still something to look at');
    h.patch('/repo/a', { ...CLEAN, state: 'detached' });
    assert.equal(h.btn('/repo/a').classList.contains('has-changes'), false,
      'detached alone is not — it is where the head is, not work in progress');
  } finally { h.destroy(); }
});

test('#515: two headers for one cwd are both patched', () => {
  const h = setup();
  try {
    h.mount('/repo/a');
    h.mount('/repo/a');
    assert.equal(h.patch('/repo/a', DIRTY), true, 'handled');
    const btns = h.window.document.querySelectorAll('.project-vcs-btn[data-vcs-cwd="/repo/a"]');
    assert.equal(btns.length, 2, 'both are on screen');
    for (const b of btns) assert.equal(b.classList.contains('has-changes'), true, 'both are marked');
  } finally { h.destroy(); }
});

test('#515: with the chip switched off the patch touches nothing', () => {
  const h = setup({ chipEnabled: false });
  try {
    h.mount('/repo/a');
    assert.equal(h.patch('/repo/a', DIRTY), false, 'the render is what takes the chips away');
    assert.equal(h.btn('/repo/a').classList.contains('has-changes'), false, 'and nothing was written');
  } finally { h.destroy(); }
});

test('#515: with the badge off the glyph alone is patched, no rebuild', () => {
  const h = setup({ showBadge: false });
  try {
    h.mount('/repo/a');
    assert.equal(h.patch('/repo/a', DIRTY), true, 'handled without a pill');
    assert.equal(h.btn('/repo/a').classList.contains('has-changes'), true);
  } finally { h.destroy(); }
});

test('#515: the push handler patches instead of scheduling a render, and still updates the cache', () => {
  const h = setup();
  try {
    h.mount('/repo/a');
    h.push({ cwd: '/repo/a', summary: DIRTY });
    assert.equal(h.refreshCalls.n, 0, 'no full render was even scheduled');
    assert.match(h.pill('/repo/a').innerHTML, /\+1/, 'the chip shows the new counts');
    // The cache is what the next full render reads — a patch that skipped it would drift.
    assert.equal(h.window.vcsView.status('/repo/a').staged, 1, 'the cache carries the same summary');
  } finally { h.destroy(); }
});

test('#515: a push for a cwd with no chip on screen still falls back to the render', (t, done) => {
  const h = setup();
  try {
    h.push({ cwd: '/repo/not-rendered', summary: DIRTY });
    // The fallback is the module's own 150 ms burst debounce.
    setTimeout(() => {
      try {
        assert.equal(h.refreshCalls.n, 1, 'the structural case still rebuilds');
        done();
      } catch (e) { done(e); } finally { h.destroy(); }
    }, 250);
  } catch (e) { h.destroy(); throw e; }
});
