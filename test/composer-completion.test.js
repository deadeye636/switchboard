'use strict';
// src/renderer/session/composer-completion.js (#643): the autocomplete of a session's text input. The
// pure half (what the text before the caret asks for, the ranking, how a path is typed) is called directly;
// the list itself runs in jsdom against a stand-in source, because what matters is what a key does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_PATH = path.join(__dirname, '..', 'src', 'renderer', 'session', 'composer-completion.js');
const { composerCompletionContext, composerCompletionRank, composerPathToken } = require(SRC_PATH);

test('the text before the caret decides what completes', () => {
  assert.deepEqual(composerCompletionContext('/'), { mode: 'command', query: '', start: 0 });
  assert.deepEqual(composerCompletionContext('/mo'), { mode: 'command', query: 'mo', start: 0 });
  assert.deepEqual(composerCompletionContext('/skill:se'), { mode: 'command', query: 'skill:se', start: 0 });
  assert.deepEqual(composerCompletionContext('/model gp'), { mode: 'argument', command: 'model', query: 'gp', start: 7 });
  assert.deepEqual(composerCompletionContext('/model '), { mode: 'argument', command: 'model', query: '', start: 7 });
  assert.equal(composerCompletionContext('/model gpt x'), null, 'one argument, not a sentence');
  assert.equal(composerCompletionContext('say /model'), null, 'a command only at the start, as in a CLI');
  assert.deepEqual(composerCompletionContext('look at @src/re'), { mode: 'path', query: 'src/re', start: 8 });
  assert.deepEqual(composerCompletionContext('@'), { mode: 'path', query: '', start: 0 });
  assert.deepEqual(composerCompletionContext('see @"docs/my'), { mode: 'path', query: 'docs/my', start: 4 });
  assert.deepEqual(composerCompletionContext('see @"my docs/n'), { mode: 'path', query: 'my docs/n', start: 4 }, 'a quoted path keeps its spaces');
  assert.deepEqual(composerCompletionContext('/skill:review @src/ap'), { mode: 'path', query: 'src/ap', start: 14 }, 'a file given to a command');
  assert.deepEqual(composerCompletionContext('/model @x'), { mode: 'path', query: 'x', start: 7 });
  assert.equal(composerCompletionContext('mail me@example'), null, 'an @ inside a word is not a path');
  assert.equal(composerCompletionContext('plain text'), null);
});

test('matches rank by the start of the name, then anywhere in it, then the description', () => {
  const items = [{ n: 'compact', d: 'free context' }, { n: 'model', d: 'switch' }, { n: 'my-model', d: '' }, { n: 'login', d: 'model provider' }];
  assert.deepEqual(composerCompletionRank(items, 'mod', i => i.n, i => i.d).map(i => i.n), ['model', 'my-model', 'login']);
  assert.equal(composerCompletionRank(items, '', i => i.n).length, 4);
});

test('a path with a space is quoted, a directory keeps its quote open', () => {
  assert.equal(composerPathToken('src/app.js'), '@src/app.js');
  assert.equal(composerPathToken('docs/my notes.md'), '@"docs/my notes.md"');
  assert.equal(composerPathToken('my docs/'), '@"my docs/');
});

function setup(source) {
  const dom = new JSDOM('<!doctype html><body><div id="anchor"><textarea id="in"></textarea></div></body>');
  const w = dom.window;
  const ctx = vm.createContext(w);
  vm.runInContext(fs.readFileSync(SRC_PATH, 'utf8'), ctx);
  const input = w.document.getElementById('in');
  const c = vm.runInContext('createComposerCompletion', ctx)(input, w.document.getElementById('anchor'), source);
  const type = async (text) => {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new w.Event('input'));
    await new Promise((r) => setTimeout(r, 0));
  };
  const key = (k, extra = {}) => {
    const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
    return c.handleKey(e);
  };
  const rows = () => [...c.element.querySelectorAll('.vpal-row .vpal-name')].map(n => n.firstChild.textContent);
  return { w, c, input, type, key, rows };
}

const SOURCE = {
  commands: async () => [
    { name: 'login', description: 'Log in', kind: 'command', arguments: true },
    { name: 'model', description: 'Switch the model', kind: 'command', arguments: true },
    { name: 'fix-tests', description: 'Fix failing tests', kind: 'template', arguments: false },
    { name: 'skill:search', description: 'Search the web', kind: 'skill', arguments: false },
  ],
  arguments: async (command) => (command === 'model'
    ? [{ value: 'openai-codex/gpt-5.6-sol', description: 'GPT 5.6 (current)' }, { value: 'anthropic/claude-opus-5', description: 'Opus 5' }]
    : []),
  paths: async (prefix) => (prefix.startsWith('src/') ? [{ value: 'src/app/', dir: true }, { value: 'src/main.js', dir: false }] : [{ value: 'src/', dir: true }]),
};

test('a / opens the command list; Enter takes the highlighted one and opens its arguments', async () => {
  const h = setup(SOURCE);
  await h.type('/');
  assert.deepEqual(h.rows(), ['/login', '/model', '/fix-tests', '/skill:search']);
  assert.equal(h.c.element.querySelectorAll('.composer-completion-kind').length, 2, 'a template and a skill say what they are');
  await h.type('/mo');
  assert.deepEqual(h.rows(), ['/model']);
  assert.equal(h.key('Enter'), true, 'the key is used here, not sent');
  assert.equal(h.input.value, '/model ');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.rows(), ['openai-codex/gpt-5.6-sol', 'anthropic/claude-opus-5'], 'the arguments follow at once');
  assert.equal(h.key('ArrowDown'), true);
  assert.equal(h.key('Tab'), true);
  assert.equal(h.input.value, '/model anthropic/claude-opus-5');
  assert.equal(h.c.isOpen(), false);
  assert.equal(h.key('Enter'), false, 'with the list closed, Enter is the view\'s again');
});

test('Escape closes only the list, and a command without arguments offers none', async () => {
  const h = setup(SOURCE);
  await h.type('/fix');
  assert.equal(h.key('Escape'), true);
  assert.equal(h.c.isOpen(), false);
  assert.equal(h.key('Escape'), false, 'a second Escape reaches the view (and stops a running turn)');
  await h.type('/fix-tests ');
  assert.equal(h.c.isOpen(), false);
});

test('an @ offers paths; a directory keeps the word open for its contents, a file ends it', async () => {
  const h = setup(SOURCE);
  await h.type('read @s');
  assert.deepEqual(h.rows(), ['src/']);
  h.key('Enter');
  assert.equal(h.input.value, 'read @src/');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.rows(), ['src/app/', 'src/main.js']);
  h.key('ArrowDown');
  h.key('Enter');
  assert.equal(h.input.value, 'read @src/main.js ');
});

test('an answer that arrives after the text moved on is dropped', async () => {
  let release;
  const slow = { ...SOURCE, commands: () => new Promise((r) => { release = () => r(SOURCE.commands()); }) };
  const h = setup(slow);
  h.input.value = '/';
  h.input.setSelectionRange(1, 1);
  h.input.dispatchEvent(new h.w.Event('input'));
  await h.type('plain words');
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.c.isOpen(), false);
});

// The caret can move with no `input` event. A row taken then must not be written where the list was opened.
test('a row is not taken when the caret has moved away from what the list answered', async () => {
  const h = setup(SOURCE);
  await h.type('read @s');
  assert.deepEqual(h.rows(), ['src/']);
  h.input.setSelectionRange(0, 0);   // Home, a click — no input event
  assert.equal(h.key('Enter'), true);
  assert.equal(h.input.value, 'read @s', 'the text is untouched');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.c.isOpen(), false, 'and the list follows the caret');
});

test('a list that only repeats what is typed stays closed, so Enter sends', async () => {
  const h = setup({ ...SOURCE, paths: async () => [{ value: 'README.md', dir: false }] });
  await h.type('@README.md');
  assert.equal(h.c.isOpen(), false);
  assert.equal(h.key('Enter'), false);
});

test('a caret inside the word replaces the whole word, not only what is before the caret', async () => {
  const h = setup({ ...SOURCE, paths: async () => [{ value: 'README.md', dir: false }] });
  h.input.value = 'read @REA tail';
  h.input.setSelectionRange(8, 8);   // read @RE|A tail
  h.input.dispatchEvent(new h.w.Event('input'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.key('Enter'), true);
  assert.equal(h.input.value, 'read @README.md  tail');
});
