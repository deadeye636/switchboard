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
