'use strict';
// #711: what markdown must not change in a transcript's text. Drawn through the real `renderJsonlText` in
// src/renderer/jsonl/jsonl-viewer.js with the same marked and DOMPurify builds index.html loads, because the
// defects lived in how the text and marked met — a stub for either would pass them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function setup() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.api = new Proxy({}, { get: () => () => {} });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(read('node_modules/dompurify/dist/purify.min.js'), ctx);
  vm.runInContext(read('node_modules/marked/lib/marked.umd.js'), ctx);
  vm.runInContext(read('src/shared/partial-args.js'), ctx);
  vm.runInContext(read('src/renderer/session/subagent-live.js'), ctx);
  vm.runInContext(`
    function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  `, ctx);
  vm.runInContext(read('src/renderer/jsonl/jsonl-viewer.js'), ctx);
  // What a reader sees: the rendered HTML put into an element, read back as text.
  return (text) => {
    ctx.__text = text;
    const el = w.document.createElement('div');
    el.innerHTML = vm.runInContext('renderJsonlText(__text)', ctx);
    return el;
  };
}

test('the real marked and DOMPurify are loaded, not the fallback', () => {
  const el = setup()('**bold**');
  assert.equal(el.querySelector('strong').textContent, 'bold');
});

test('a tag inside an inline code span shows exactly as written', () => {
  const el = setup()('Search with `--search "<keyword>"` first.');
  assert.equal(el.querySelector('code').textContent, '--search "<keyword>"');
});

test('a tag inside a code block shows exactly as written', () => {
  const el = setup()('```html\n<div class="x">hi</div>\n```');
  assert.equal(el.querySelector('pre code').textContent.trim(), '<div class="x">hi</div>');
});

test('a tag outside code shows as text and is never an element', () => {
  const el = setup()('Wrap it in <example> and </example>, or <img src=x onerror=alert(1)>.');
  assert.match(el.textContent, /<example> and <\/example>/);
  assert.match(el.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(el.querySelector('example, img'), null);
});

test('markdown inside tag-shaped lines still renders', () => {
  const el = setup()('<rules>\n**keep** this\n</rules>');
  assert.equal(el.querySelector('strong').textContent, 'keep');
  assert.match(el.textContent, /<rules>/);
});

test('a Windows path in plain text keeps the backslash before a dot', () => {
  const el = setup()('Base directory for this skill: C:\\Users\\someone\\.claude\\skills\\git-issue');
  assert.match(el.textContent, /C:\\Users\\someone\\\.claude\\skills\\git-issue/);
});

test('a path without a drive keeps its backslashes when it has two of them', () => {
  const el = setup()('See .claude\\skills\\_draft and ~\\.config');
  assert.match(el.textContent, /\.claude\\skills\\_draft/);
  assert.match(el.textContent, /~\\\.config/);
});

test('a UNC path keeps both leading backslashes', () => {
  const el = setup()('Stored on \\\\server\\share\\.cache');
  assert.match(el.textContent, /\\\\server\\share\\\.cache/);
});

test('a path inside code is unchanged', () => {
  const el = setup()('Run `C:\\tools\\.bin\\x.exe` now.');
  assert.equal(el.querySelector('code').textContent, 'C:\\tools\\.bin\\x.exe');
});

test('a UNC path inside code is unchanged', () => {
  const el = setup()('Open `\\\\server\\share\\.cache` there.');
  assert.equal(el.querySelector('code').textContent, '\\\\server\\share\\.cache');
});

test('a path keeps the escape on the character after its backslash', () => {
  const el = setup()('Found C:\\foo\\*bar* in the log');
  assert.match(el.textContent, /C:\\foo\\\*bar\*/);
  assert.equal(el.querySelector('em'), null);
});

test('a path keeps a backslash before a bracket', () => {
  const el = setup()('Saved to C:\\Users\\x\\[draft\\] today');
  assert.match(el.textContent, /C:\\Users\\x\\\[draft\\\]/);
});

test('escaped markdown with several backslashes is not read as a path', () => {
  const el = setup()('the \\_\\_init\\_\\_ method and \\*\\*not bold\\*\\*');
  assert.match(el.textContent, /__init__ method/);
  assert.match(el.textContent, /\*\*not bold\*\*/);
  assert.equal(el.querySelector('em, strong'), null);
});

test('a URL is left to markdown: an autolink keeps its backslashes, a written link destination escapes', () => {
  const el = setup()('[a](http://e.com/a\\.b\\c) and <http://e.com/x\\.y\\z> and https://e.com/p\\.q\\r');
  const links = [...el.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.textContent]);
  assert.deepEqual(links, [
    ['http://e.com/a.b%5Cc', 'a'],
    ['http://e.com/x%5C.y%5Cz', 'http://e.com/x\\.y\\z'],
    ['https://e.com/p%5C.q%5Cr', 'https://e.com/p\\.q\\r'],
  ]);
});

test('an escaped backslash alone is not a UNC path', () => {
  const el = setup()('a \\\\ b');
  assert.match(el.textContent, /^a \\ b$/m);
});

test('a lone markdown escape outside a path is still an escape', () => {
  const el = setup()('the my\\_var name and \\*not emphasis\\*');
  assert.match(el.textContent, /my_var/);
  assert.match(el.textContent, /\*not emphasis\*/);
  assert.equal(el.querySelector('em'), null);
});
