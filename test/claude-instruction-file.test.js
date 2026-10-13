'use strict';
// #777 — Claude reads AGENTS.md in a project with no CLAUDE.md (Claude Code 2.1.277), so its instruction
// file in the Agent Files tab and in its resource listing is CLAUDE.md where there is one, else AGENTS.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('../src/backends/claude/index');
const resources = require('../src/backends/claude/resources');

// `files`: names, or [name, text] for a file with other content ('' = empty).
function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-instr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of files) {
    const [name, text] = Array.isArray(f) ? f : [f, '# rules\n'];
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const instructionFiles = (dir) => claude.memorySources({ projectPath: dir, storeFolders: [] })
  .filter(s => s.kind === 'file').map(s => path.relative(dir, s.path).split(path.sep).join('/'));
const listedContext = (dir) => resources.createListResources({ claudeHome: () => path.join(dir, 'no-home') })({ projectPath: dir }).resources
  .filter(r => r.source === 'project-context').map(r => r.name);

test('a project with only AGENTS.md: Claude names AGENTS.md', (t) => {
  const dir = project(t, ['AGENTS.md']);
  assert.deepEqual(instructionFiles(dir), ['AGENTS.md']);
  assert.deepEqual(listedContext(dir), ['AGENTS.md']);
});

test('a project with both: CLAUDE.md wins, AGENTS.md is not Claude\'s', (t) => {
  const dir = project(t, ['CLAUDE.md', 'AGENTS.md']);
  assert.deepEqual(instructionFiles(dir), ['CLAUDE.md']);
  assert.deepEqual(listedContext(dir), ['CLAUDE.md']);
});

// #785, measured on Claude Code 2.1.296: `.claude/CLAUDE.md` keeps AGENTS.md unread; an empty CLAUDE.md does not.
test('a project with .claude/CLAUDE.md: that is Claude\'s, not AGENTS.md', (t) => {
  const dir = project(t, ['.claude/CLAUDE.md', 'AGENTS.md']);
  assert.deepEqual(instructionFiles(dir), ['.claude/CLAUDE.md']);
  const row = claude.memorySources({ projectPath: dir, storeFolders: [] }).find(s => s.kind === 'file');
  assert.ok(row.displayPath.endsWith('/.claude/'), 'shown under its own folder');
  assert.deepEqual(listedContext(dir), ['CLAUDE.md']);
});

test('an empty CLAUDE.md counts as none: Claude reads AGENTS.md', (t) => {
  const dir = project(t, [['CLAUDE.md', ''], 'AGENTS.md']);
  assert.deepEqual(instructionFiles(dir), ['AGENTS.md']);
  assert.deepEqual(listedContext(dir), ['AGENTS.md']);
});

test('a project with neither: no listed file, the source still points at a file Claude would read', (t) => {
  const dir = project(t, []);
  assert.deepEqual(listedContext(dir), []);
  assert.equal(instructionFiles(dir).length, 1);
});
