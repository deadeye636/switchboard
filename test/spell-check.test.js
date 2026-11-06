// The spell check's decisions (#815): which languages reach Electron, and what the menu on a marked word offers.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLanguages, menuTemplate } = require('../src/app/spell-check');

const AVAILABLE = ['de', 'de-DE', 'en-GB', 'en-US', 'fr'];

test('a stored list keeps the codes this build has, in order, and names the others', () => {
  assert.deepEqual(resolveLanguages('en-us, de-DE; xx-XX de-de', AVAILABLE), {
    languages: ['en-US', 'de-DE'],
    unknown: ['xx-XX'],
  });
});

test('a stored list of unknown codes sets nothing rather than falling back in silence', () => {
  assert.deepEqual(resolveLanguages('xx', AVAILABLE), { languages: [], unknown: ['xx'] });
});

test('an empty list means the default, German and English', () => {
  assert.deepEqual(resolveLanguages('  ', AVAILABLE), { languages: ['de-DE', 'en-US'], unknown: [] });
  assert.deepEqual(resolveLanguages(undefined, AVAILABLE), { languages: ['de-DE', 'en-US'], unknown: [] });
});

test('where the OS decides there is no list, so nothing is set', () => {
  assert.deepEqual(resolveLanguages('de-DE', []), { languages: [], unknown: ['de-DE'] });
  assert.deepEqual(resolveLanguages('', []), { languages: [], unknown: [] });
});

// The menu's wait (#818). A fake contents and a fake menu: nothing here draws one.
function menuWorld(t, { suggest, answersAtOnce = () => true } = {}) {
  const { EventEmitter } = require('node:events');
  const spellCheck = require('../src/app/spell-check');
  const shown = [];
  const fakeApp = new EventEmitter();
  fakeApp.whenReady = () => new Promise(() => {});
  spellCheck.init({
    app: fakeApp,
    session: { defaultSession: { availableSpellCheckerLanguages: ['de-DE', 'en-US'] } },
    Menu: { buildFromTemplate: (template) => ({ popup: () => shown.push(template.map((i) => i.label).filter(Boolean)) }) },
    BrowserWindow: { fromWebContents: () => null },
    getSetting: () => ({}),
    suggestFromOs: suggest,
    osAnswersAtOnce: answersAtOnce,
    log: { warn() {} },
  });
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.sent = [];
  contents.send = (...a) => contents.sent.push(a);
  return { spellCheck, contents, shown };
}
const marked = (word, dictionarySuggestions = []) => ({ isEditable: true, misspelledWord: word, dictionarySuggestions, editFlags: {} });

test('a marked word opens with the OS checker\'s corrections first', async (t) => {
  const { spellCheck, contents, shown } = menuWorld(t, { suggest: async () => ['Haus'] });
  await spellCheck.onContextMenu(contents, marked('Hauss', ['Hausa']));
  assert.deepEqual(contents.sent, [['editable-context-menu', true]]);
  assert.deepEqual(shown[0].slice(0, 2), ['Haus', 'Hausa']);
});

test('with Hunspell\'s words in hand and the checker cold the menu does not wait, and warms it', async (t) => {
  const asked = [];
  const { spellCheck, contents, shown } = menuWorld(t, { answersAtOnce: () => false, suggest: (w) => { asked.push(w); return new Promise(() => {}); } });
  await spellCheck.onContextMenu(contents, marked('hosue', ['house']));
  assert.equal(shown[0][0], 'house');
  assert.deepEqual(asked, ['hosue']);
});

test('the latest right click wins, and a press during the wait drops the menu', async (t) => {
  let release = [];
  const suggest = () => new Promise((r) => release.push(r));
  const { spellCheck, contents, shown } = menuWorld(t, { suggest });
  const first = spellCheck.onContextMenu(contents, marked('a'));
  await new Promise((r) => setImmediate(r));
  const second = spellCheck.onContextMenu(contents, marked('b'));
  await new Promise((r) => setImmediate(r));
  release.forEach((r) => r(['x']));
  await Promise.all([first, second]);
  assert.equal(shown.length, 1, 'one menu for two clicks');

  release = [];
  const pressed = spellCheck.onContextMenu(contents, marked('c'));
  await new Promise((r) => setImmediate(r));
  contents.emit('input-event', {}, { type: 'keyDown' });
  release.forEach((r) => r(['y']));
  await pressed;
  assert.equal(shown.length, 1, 'typing went on, so no menu');
  assert.equal(contents.listenerCount('input-event'), 0);
});

test('an answer for a closed window opens nothing', async (t) => {
  let release;
  const { spellCheck, contents, shown } = menuWorld(t, { suggest: () => new Promise((r) => { release = r; }) });
  const open = spellCheck.onContextMenu(contents, marked('a'));
  await new Promise((r) => setImmediate(r));
  contents.isDestroyed = () => true;
  release(['x']);
  await open;
  assert.equal(shown.length, 0);
});

const labels = (t) => t.map((i) => i.label || i.role || i.type);

test('the menu offers the corrections, adding the word, and the edit roles', () => {
  const calls = [];
  const t = menuTemplate(
    { misspelledWord: 'hosue', dictionarySuggestions: ['house', 'hose'], editFlags: { canCut: true, canCopy: true, canPaste: false } },
    { replace: (w) => calls.push(['replace', w]), addWord: (w) => calls.push(['add', w]) },
  );
  assert.deepEqual(labels(t), ['house', 'hose', 'separator', 'Add to dictionary', 'separator', 'cut', 'copy', 'paste']);
  t[1].click();
  t[3].click();
  assert.deepEqual(calls, [['replace', 'hose'], ['add', 'hosue']]);
  assert.equal(t.find((i) => i.role === 'paste').enabled, false);
});

// Measured: a word only the Windows checker rejects reports no suggestions (spec 32).
test('a marked word without suggestions says so', () => {
  const t = menuTemplate({ misspelledWord: 'Rechtschreibprufung', dictionarySuggestions: [] }, {});
  assert.equal(t[0].label, 'No suggestions');
  assert.equal(t[0].enabled, false);
  assert.equal(t.find((i) => i.label === 'Add to dictionary').label, 'Add to dictionary');
});
