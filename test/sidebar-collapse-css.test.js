// The sidebar's project/worktree collapse is pure CSS (#744).
//
// WHY THIS EXISTS:
//   Collapsing a header used to hide only its ADJACENT sibling (`.project-header.collapsed +
//   .project-sessions`). The VCS badge row is inserted between the header and its sessions list, and with
//   it on the chevron turned while the sessions stayed on screen. Any row placed there has to fold with
//   the header, whatever it is called, so this loads the real stylesheet into jsdom and asks the cascade
//   rather than reading the selector text.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

// The DOM `renderProjects` builds: a project group with a row between header and list, and a worktree
// group (with its own row) nested inside the project's list.
const MARKUP = `
<div id="sidebar-content">
  <div class="project-group" id="p">
    <div class="project-header" id="ph"></div>
    <div class="vcs-pill-row" id="p-pill"></div>
    <div class="some-future-row" id="p-extra"></div>
    <div class="project-sessions" id="p-list">
      <div class="worktree-group" id="w">
        <div class="worktree-header" id="wh"></div>
        <div class="vcs-pill-row" id="w-pill"></div>
        <div class="worktree-sessions" id="w-list"></div>
      </div>
    </div>
  </div>
</div>`;

function setup() {
  const dom = new JSDOM(`<!DOCTYPE html><html><head><style>${CSS}</style></head><body>${MARKUP}</body></html>`);
  const { window } = dom;
  const el = (id) => window.document.getElementById(id);
  const shown = (id) => window.getComputedStyle(el(id)).display !== 'none';
  return { el, shown, destroy: () => window.close() };
}

test('#744: a collapsed project hides every row between its header and its sessions, and the list', () => {
  const h = setup();
  try {
    for (const id of ['p-pill', 'p-extra', 'p-list']) assert.equal(h.shown(id), true, `${id} shown while expanded`);
    h.el('ph').classList.add('collapsed');
    assert.equal(h.shown('ph'), true, 'the header itself stays');
    for (const id of ['p-pill', 'p-extra', 'p-list']) assert.equal(h.shown(id), false, `${id} hidden while collapsed`);
  } finally { h.destroy(); }
});

test('#744: a collapsed worktree hides its badge row and its sessions, not its own header', () => {
  const h = setup();
  try {
    for (const id of ['w-pill', 'w-list']) assert.equal(h.shown(id), true, `${id} shown while expanded`);
    h.el('wh').classList.add('collapsed');
    assert.equal(h.shown('wh'), true, 'the worktree header stays');
    for (const id of ['w-pill', 'w-list']) assert.equal(h.shown(id), false, `${id} hidden while collapsed`);
    assert.equal(h.shown('p-list'), true, 'the project around it is untouched');
  } finally { h.destroy(); }
});
