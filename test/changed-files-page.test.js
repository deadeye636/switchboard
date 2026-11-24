'use strict';

// The changes window (#277) in jsdom against a fake `window.api`, for its List / Tree layout (#894): the default, the
// switch and its stored choice, a tree per status group, folding, and that a file row still opens its diff and its
// Open / Reveal actions in Tree.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const plain = (x) => JSON.parse(JSON.stringify(x));
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await flush(); }

const STATUS = {
  branch: 'main', state: null, staged: 1, unstaged: 2, untracked: 0, conflicted: 0,
  files: [
    { kind: 'staged', path: 'src/app/settings.js', x: 'M', y: '.' },
    { kind: 'unstaged', path: 'src/renderer/shell/sidebar.js', x: '.', y: 'M' },
    { kind: 'unstaged', path: 'README.md', x: '.', y: 'M' },
  ],
};

// The page runs a 5 s "updated … ago" interval: every window is closed after its test, or the file never exits.
const opened = [];
afterEach(() => { for (const w of opened.splice(0)) w.close(); });

function load({ layout = null } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(RENDERER, 'changed-files.html'), 'utf8'), {
    url: 'http://localhost/changed-files.html?cwd=%2Frepo&label=repo',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  opened.push(window);
  const calls = { diff: [], open: [], reveal: [] };
  window.api = {
    vcsStatus: async () => STATUS,
    vcsRefresh: async () => STATUS,
    vcsDiff: async (o) => { calls.diff.push(o); return { ok: true, text: '@@ -1 +1 @@\n-a\n+b\n' }; },
    openPath: (p) => { calls.open.push(p); },
    vcsReveal: (o) => { calls.reveal.push(o); },
    openDiffWindow: () => {},
    onVcsStatusChanged: () => {},
  };
  if (layout) window.localStorage.setItem('changedFilesLayout', layout);
  for (const file of ['diff-render.js', 'lib/file-tree.js', 'changed-files.js']) {
    window.eval(fs.readFileSync(path.join(RENDERER, file), 'utf8'));
  }
  return { window, document: window.document, calls };
}

test('List is the default and draws whole paths', async () => {
  const { document } = load();
  await settle();
  assert.equal(document.querySelector('#layout [data-layout="list"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelectorAll('.tree-dir').length, 0);
  assert.match(document.querySelector('.file[data-path="src/renderer/shell/sidebar.js"] .fpath').textContent, /^src\/renderer\/shell\/sidebar\.js$/);
});

test('Tree builds one tree per status group and keeps the choice', async () => {
  const { window, document } = load();
  await settle();
  document.querySelector('#layout [data-layout="tree"]').click();
  await settle();
  assert.equal(window.localStorage.getItem('changedFilesLayout'), 'tree');
  const dirs = [...document.querySelectorAll('.tree-dir')].map((d) => d.dataset.dir);
  assert.deepEqual(dirs, ['staged|src/app', 'unstaged|src/renderer/shell']);
  assert.equal(document.querySelector('.file[data-path="src/renderer/shell/sidebar.js"] .fpath').textContent, 'sidebar.js');
});

test('in Tree a folder folds, and a file row still opens its diff and its actions', async () => {
  const { document, calls } = load({ layout: 'tree' });
  await settle();
  document.querySelector('.tree-dir[data-dir="unstaged|src/renderer/shell"]').click();
  await settle();
  assert.equal(document.querySelector('.file[data-path="src/renderer/shell/sidebar.js"]'), null);
  document.querySelector('.tree-dir[data-dir="unstaged|src/renderer/shell"]').click();
  await settle();
  const row = document.querySelector('.file[data-path="src/renderer/shell/sidebar.js"]');
  row.click();
  await settle();
  assert.deepEqual(plain(calls.diff), [{ cwd: '/repo', path: 'src/renderer/shell/sidebar.js', kind: 'unstaged', staged: false }]);
  assert.ok(row.nextElementSibling.classList.contains('diff-pane'));
  row.querySelector('button[data-act="reveal"]').click();
  assert.deepEqual(plain(calls.reveal), [{ cwd: '/repo', path: 'src/renderer/shell/sidebar.js' }]);
  row.querySelector('button[data-act="open"]').click();
  assert.deepEqual(plain(calls.open), ['/repo/src/renderer/shell/sidebar.js']);
});
