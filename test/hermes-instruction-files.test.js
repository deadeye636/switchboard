'use strict';
// #451 — Hermes reads instruction files, and the descriptor now says so.
//
// The descriptor claimed `memorySources: () => []` and "no per-project instruction files", while its own
// `ignoreRules` launch option offered to skip "AGENTS.md, SOUL.md, memory and preloaded skills for this
// run" — an option that only makes sense if they are read otherwise. Hermes' own source settles it: its
// coding context names AGENTS.md, CLAUDE.md and .cursorrules as project context files, with SOUL.md and
// .hermes.md alongside, taken from the working directory or from HERMES_HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const hermes = require('../src/backends/hermes/index');
const plansMemory = require('../src/app/plans-memory');

const namesOf = (sources) => sources.map(s => path.basename(s.path)).sort();

test('Hermes declares the instruction files it reads, for a project', () => {
  const sources = hermes.memorySources({ projectPath: path.join('D:', 'tmp', 'demo'), storeFolders: [] });
  assert.deepEqual(namesOf(sources), ['.cursorrules', '.hermes.md', 'AGENTS.md', 'CLAUDE.md', 'SOUL.md']);
  for (const s of sources) {
    assert.equal(s.kind, 'file');
    assert.ok(s.path.includes(path.join('D:', 'tmp', 'demo')), 'a project source sits in the project');
  }
});

test('and for the home scope, where the same set is read', () => {
  const sources = hermes.memorySources({ projectPath: null, storeFolders: [] });
  assert.deepEqual(namesOf(sources), ['.cursorrules', '.hermes.md', 'AGENTS.md', 'CLAUDE.md', 'SOUL.md']);
  // Not under the project — this scope is HERMES_HOME.
  assert.ok(sources.every(s => !s.path.includes(path.join('D:', 'tmp', 'demo'))));
});

test('a scope of nothing does not throw', () => {
  assert.ok(Array.isArray(hermes.memorySources(null)));
  assert.ok(Array.isArray(hermes.memorySources(undefined)));
});

test('an instruction file without an extension can still be opened', () => {
  const isInstruction = plansMemory._isInstructionFile;
  // The whole point of declaring `.cursorrules`: a row the list shows and the viewer answers with an
  // empty editor is worse than a row that is not there.
  assert.equal(isInstruction(path.join('D:', 'p', '.cursorrules')), true);
  assert.equal(isInstruction(path.join('D:', 'p', 'AGENTS.md')), true);
  assert.equal(isInstruction(path.join('D:', 'p', 'secrets.env')), false);
  assert.equal(isInstruction(path.join('D:', 'p', 'id_rsa')), false);
});
