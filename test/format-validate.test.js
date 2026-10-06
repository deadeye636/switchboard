'use strict';
// #441 — a save is refused when the text no longer parses as the format the file claims to be.
//
// The point of the refusal is the message: a CLI that finds a broken settings file at its next start
// says so hours later, in a file the user has stopped thinking about. So each case here also checks that
// the parser's own complaint survives into the reason.
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateContent, canValidate, CHECK_CEILING } = require('../src/app/format-validate');

const BOM = '﻿';

test('JSON: valid passes, broken is refused and the message says what the parser saw', () => {
  assert.equal(validateContent('settings.json', '{ "a": 1 }').ok, true);
  const bad = validateContent('settings.json', '{ "a": 1, }');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Not valid JSON/);
  assert.ok(bad.error.length > 'Not valid JSON.'.length, 'the parser\'s own words are kept');
});

test('JSON: a BOM is not a syntax error — the CLI reads that file every day', () => {
  assert.equal(validateContent('settings.json', BOM + '{ "a": 1 }').ok, true);
});

test('TOML: valid passes, broken is refused', () => {
  assert.equal(validateContent('config.toml', 'model = "gpt"\n[profiles.dev]\nkey = 1\n').ok, true);
  const bad = validateContent('config.toml', 'model = = "gpt"\n');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Not valid TOML/);
});

test('YAML: valid passes, broken is refused', () => {
  assert.equal(validateContent('config.yaml', 'model: sonnet\nskills:\n  - a\n  - b\n').ok, true);
  assert.equal(validateContent('config.yml', 'a: 1\n').ok, true);
  const bad = validateContent('config.yaml', 'a:\n b: 1\n  c: 2\n');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Not valid YAML/);
});

test('markdown: a skill\'s frontmatter must parse, the prose below it is nobody\'s business', () => {
  assert.equal(validateContent('SKILL.md', '---\nname: do-a-thing\ndescription: does a thing\n---\n\n# anything ( goes\n').ok, true);
  assert.equal(validateContent('CLAUDE.md', '# no frontmatter here\n\n- a list\n').ok, true);
});

test('markdown: an unclosed or unparseable frontmatter block is refused', () => {
  const unclosed = validateContent('SKILL.md', '---\nname: x\n\n# body\n');
  assert.equal(unclosed.ok, false);
  assert.match(unclosed.error, /not closed/);

  const broken = validateContent('SKILL.md', '---\nname: [unterminated\n---\n\nbody\n');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /frontmatter/);
});

test('markdown: frontmatter that parses to a scalar is not frontmatter', () => {
  const scalar = validateContent('SKILL.md', '---\njust a string\n---\n\nbody\n');
  assert.equal(scalar.ok, false);
  assert.match(scalar.error, /key: value/);
});

test('a format with no parser is saved unchecked, and says so rather than claiming a check', () => {
  const answer = validateContent('hook.sh', 'echo hi\n');
  assert.equal(answer.ok, true);
  assert.equal(answer.unchecked, true, '"saved without a check" is a different promise from "checked and fine"');
  assert.equal(canValidate('hook.sh'), false);
  assert.equal(canValidate('settings.json'), true);
  assert.equal(canValidate('SKILL.MD'), true, 'the extension is matched case-insensitively');
});

test('a missing name or empty text is an answer, not a throw', () => {
  assert.equal(validateContent(null, 'anything').ok, true);
  assert.equal(validateContent('settings.json', '').ok, false, 'an empty settings file is not valid JSON');
  assert.equal(validateContent('notes.md', '').ok, true);
});

// #610: the parse runs on the main process, so above a per-format ceiling the save goes ahead UNCHECKED and
// says why, rather than holding the app for seconds. Just under the ceiling a broken document is still caught.
test('above its ceiling a document is saved unchecked and marked too large; below it the check still runs', () => {
  const cases = [
    ['a.json', CHECK_CEILING.json, (n) => '"' + 'x'.repeat(n) + '"', (n) => '{' + 'x'.repeat(n)],
    ['a.toml', CHECK_CEILING.toml, (n) => 'k = "' + 'x'.repeat(n) + '"', (n) => 'k = ' + 'x'.repeat(n)],
    ['a.yaml', CHECK_CEILING.yaml, (n) => 'k: ' + 'x'.repeat(n), (n) => 'k: [' + 'x'.repeat(n)],
  ];
  for (const [file, ceiling, valid, broken] of cases) {
    assert.deepEqual({ ...validateContent(file, valid(ceiling)) }, { ok: true, unchecked: true, tooLarge: true }, `${file}: over the ceiling`);
    assert.deepEqual(validateContent(file, valid(ceiling - 20)), { ok: true }, `${file}: under it, checked and fine`);
    assert.equal(validateContent(file, broken(ceiling - 20)).ok, false, `${file}: under it, a broken document is still refused`);
  }
  const front = (n) => '---\nk: ' + 'x'.repeat(n) + '\n---\nbody';
  assert.equal(validateContent('SKILL.md', front(CHECK_CEILING.yaml)).tooLarge, true, 'a frontmatter block shares the YAML ceiling');
  assert.deepEqual(validateContent('SKILL.md', '---\nk: v\n---\n' + 'prose '.repeat(200000)), { ok: true }, 'a long BODY is no reason to skip the check');
});

test('the ceilings keep the order the measurement found: TOML is the most expensive parser by far', () => {
  assert.ok(CHECK_CEILING.toml < CHECK_CEILING.yaml && CHECK_CEILING.yaml < CHECK_CEILING.json);
});
