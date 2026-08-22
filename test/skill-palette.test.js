'use strict';
// #462 — the skill picker's decisions, handed data instead of a keyboard.
//
// What is worth guarding here is the difference between the two kinds of row: a skill the CLI can run
// goes in as the CLI's own command, everything else as a reference to the document. Getting that wrong
// is invisible in a screenshot and obvious in a session — the CLI answers a slash command it does not
// have with an error, or reads a path it was never given.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterSkills, skillInsertText, DEFAULT_SKILL_INSERT_TEMPLATE,
} = require('../src/renderer/terminal/skill-palette');

const skill = (over) => ({
  name: 'git-commit', filePath: '/skills/git-commit/SKILL.md', origin: 'Claude · global',
  scope: 'global', backendId: 'claude', invocation: null, ...over,
});

test('the filter matches the name and the origin', () => {
  const rows = [
    skill({ name: 'git-commit', origin: 'Claude · global' }),
    skill({ name: 'humanizer', origin: 'Switchboard' }),
    skill({ name: 'release', origin: 'Claude · project' }),
  ];
  assert.deepEqual(filterSkills(rows, 'git').map(s => s.name), ['git-commit']);
  // The origin answers the other question this list gets asked: what does this project add on top.
  assert.deepEqual(filterSkills(rows, 'project').map(s => s.name), ['release']);
  assert.deepEqual(filterSkills(rows, 'SWITCHBOARD').map(s => s.name), ['humanizer'], 'case does not matter');
  assert.equal(filterSkills(rows, '').length, 3, 'a blank query keeps everything');
  assert.equal(filterSkills(null, 'x').length, 0);
});

test('a skill the CLI can run goes in as the CLI\'s own command', () => {
  const s = skill({ invocation: '/git-commit' });
  // The template must not touch it: the invocation is what main measured for THAT backend.
  assert.equal(skillInsertText(s, 'Use the skill at {path}'), '/git-commit');
  assert.equal(skillInsertText(skill({ invocation: '/skill:git-commit' }), null), '/skill:git-commit');
});

test('everything else goes in as a reference to the document', () => {
  const s = skill({ invocation: null });
  assert.equal(skillInsertText(s, 'Read {path} — it is “{name}”'),
    'Read /skills/git-commit/SKILL.md — it is “git-commit”');
  assert.equal(skillInsertText(s, null),
    DEFAULT_SKILL_INSERT_TEMPLATE.replace('{path}', '/skills/git-commit/SKILL.md'));
});

test('an empty or whitespace template falls back to the default, then to the path', () => {
  const s = skill();
  const expected = DEFAULT_SKILL_INSERT_TEMPLATE.replace('{path}', '/skills/git-commit/SKILL.md');
  assert.equal(skillInsertText(s, ''), expected);
  assert.equal(skillInsertText(s, '   '), expected);
  // A template of placeholders that all resolve empty still has to say something.
  assert.equal(skillInsertText(skill({ name: '' }), '{name}'), '/skills/git-commit/SKILL.md');
});

test('the default names the file and says what to do with it', () => {
  assert.match(DEFAULT_SKILL_INSERT_TEMPLATE, /\{path\}/);
  assert.ok(DEFAULT_SKILL_INSERT_TEMPLATE.trim().split(/\s+/).length > 1, 'a bare path is not an instruction');
});

test('no skill inserts nothing', () => {
  assert.equal(skillInsertText(null, 'x {path}'), '');
});

// The default lives twice by necessity — once in SETTING_DEFAULTS (main) and once here (the renderer
// cannot require main). Two literals that agree until one is edited is the shape #237 had to be dug out
// of, so they are pinned against each other, exactly like the plan template's.
test('the palette default matches SETTING_DEFAULTS', () => {
  const settings = require('../src/app/settings');
  assert.equal(settings.SETTING_DEFAULTS.skillInsertTemplate, DEFAULT_SKILL_INSERT_TEMPLATE);
});

test('the panel fallback matches SETTING_DEFAULTS', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/panels/settings-panel.js'), 'utf8');
  const m = /fieldValue\('skillInsertTemplate', '([^']*)'\)/.exec(panel);
  assert.ok(m, 'the settings panel must read skillInsertTemplate with an explicit fallback');
  assert.equal(m[1], DEFAULT_SKILL_INSERT_TEMPLATE, 'the panel fallback drifted from SETTING_DEFAULTS');
});
