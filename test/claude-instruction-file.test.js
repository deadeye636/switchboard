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

function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-instr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of files) fs.writeFileSync(path.join(dir, name), '# rules\n');
  return dir;
}

const instructionFiles = (dir) => claude.memorySources({ projectPath: dir, storeFolders: [] })
  .filter(s => s.kind === 'file').map(s => path.basename(s.path));
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

test('a project with neither: no listed file, the source still points at a file Claude would read', (t) => {
  const dir = project(t, []);
  assert.deepEqual(listedContext(dir), []);
  assert.equal(instructionFiles(dir).length, 1);
});
