'use strict';
// #823 T5 — the instruction inventory and its doors (spec 44).
//
// Two halves. The real descriptors over fixture homes (`SWITCHBOARD_STORE_*`) pin what each of the five CLIs
// reports in the global and in a project scope, including the Codex/agy global files the Agent Files tab dropped
// and Claude's auto memory (which needs a store folder). Stub descriptors pin the core's rules for the doors: an id
// that is not in the current listing is refused, a stale baseline writes nothing, EOL/BOM survive, a project off the
// register is refused, and no answer carries a path or a backend id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-instr-'));
const STORE = {};
for (const id of ['claude', 'codex', 'hermes', 'pi', 'agy']) {
  STORE[id] = path.join(root, id, 'store');
  fs.mkdirSync(STORE[id], { recursive: true });
  process.env['SWITCHBOARD_STORE_' + id.toUpperCase()] = STORE[id];
}
const project = path.join(root, 'project');
const otherProject = path.join(root, 'other');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(otherProject, { recursive: true });

const backends = require('../src/backends');
const inventory = require('../src/app/resource-inventory');
const instructions = require('../src/app/instruction-files');
const backendResources = require('../src/app/backend-resources');
const skills = require('../src/app/skills');

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(file, body = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const noLog = { debug() {}, warn() {}, error() {}, info() {} };
const claudeHome = path.dirname(STORE.claude);
const codexHome = path.dirname(STORE.codex);
const hermesHome = STORE.hermes;
const piAgentDir = require('../src/backends/pi/trust').agentDir();

const STORE_FOLDER = 'folder-for-project';

function wire(registry = backends, projects = [project]) {
  const states = () => new Map(projects.map(p => [p, { registered: true }]));
  inventory.init({ backends: registry, log: noLog });
  backendResources.init({ backends: registry, log: noLog });
  skills.init({ backends: registry, log: noLog, dataDir: path.join(root, 'data'), effectiveSettings: () => ({}), projectStates: states });
  instructions.init({
    backends: registry, log: noLog,
    db: { getProjectStates: states, getAllFolderMeta: () => new Map([[STORE_FOLDER, { projectPath: project }]]) },
  });
}

// Global files
write(path.join(claudeHome, 'CLAUDE.md'), '# claude global\n');
write(path.join(claudeHome, 'notes.md'), '# loose note\n');
write(path.join(claudeHome, 'settings.json'), '{}\n');
write(path.join(claudeHome, 'output-styles', 'terse.md'), 'terse\n');
write(path.join(claudeHome, 'commands', 'ship.md'), '# command\n');
write(path.join(codexHome, 'AGENTS.md'), '# codex global\n');
write(path.join(codexHome, 'config.toml'), 'model = "x"\n');
write(path.join(codexHome, 'memories', 'remember.md'), 'remember\n');
write(path.join(hermesHome, 'SOUL.md'), 'soul\n');
write(path.join(hermesHome, 'AGENTS.md'), 'hermes agents\n');
write(path.join(hermesHome, 'config.yaml'), 'a: 1\n');
write(path.join(piAgentDir, 'settings.json'), '{}\n');
// Project files
write(path.join(project, 'CLAUDE.md'), '# project claude\n');
write(path.join(project, 'AGENTS.md'), '# project agents\n');
write(path.join(project, 'GEMINI.md'), '# project gemini\n');
write(path.join(project, '.claude', 'settings.json'), '{}\n');
write(path.join(project, '.claude', 'extra.md'), '# extra\n');
write(path.join(project, '.claude', 'commands', 'local.md'), '# local command\n');
write(path.join(project, '.codex', 'config.toml'), 'a = 1\n');
write(path.join(project, '.pi', 'settings.json'), '{}\n');
write(path.join(STORE.claude, STORE_FOLDER, 'memory', 'MEMORY.md'), '# auto memory\n');

const names = (rows) => rows.map(r => `${r.cli.key}:${r.name}`).sort();
const byName = (rows, name) => rows.find(r => r.name === name);

test('global scope: instruction, memory, settings and style files of every CLI, including the Codex global AGENTS.md', () => {
  wire();
  const a = instructions.getInstructionInventory({ scope: 'global' });
  assert.equal(a.ok, true);
  assert.deepEqual(names(a.rows), [
    'claude:CLAUDE.md', 'claude:notes.md', 'claude:settings.json', 'claude:terse.md',
    'codex:AGENTS.md', 'codex:config.toml', 'codex:remember.md',
    'hermes:AGENTS.md', 'hermes:SOUL.md', 'hermes:config.yaml',
    'pi:settings.json',
  ]);
  const kinds = Object.fromEntries(a.rows.map(r => [`${r.cli.key}:${r.name}`, [r.kind, r.section]]));
  assert.deepEqual(kinds['codex:AGENTS.md'], ['instructions', 'Instructions']);
  assert.deepEqual(kinds['codex:remember.md'], ['memory', 'Memory']);
  assert.deepEqual(kinds['claude:settings.json'], ['settings', 'Settings files']);
  assert.deepEqual(kinds['claude:terse.md'], ['output-style', 'Output styles']);
  assert.ok(a.rows.every(r => r.scope === 'global' && r.editable && typeof r.ext === 'string'));
});

test('a command file is not an instruction (the Agent Files defect), and a CLI with nothing declines', () => {
  wire();
  const g = instructions.getInstructionInventory({ scope: 'global' });
  assert.equal(byName(g.rows, 'ship.md'), undefined);
  assert.deepEqual(g.declines.map(d => d.cli.key), ['agy']);
  assert.match(g.declines[0].sentence, /keeps no instructions here/);
  const p = instructions.getInstructionInventory({ scope: project });
  assert.equal(byName(p.rows, 'local.md'), undefined, 'a project command is a Commands row');
  assert.ok(byName(p.rows, 'extra.md'), 'but .claude/*.md stays an instruction file');
});

test('project scope: the project files, Pi lists AGENTS.md and CLAUDE.md once with both CLIs, Claude auto memory needs the store folder', () => {
  wire();
  const p = instructions.getInstructionInventory({ scope: project });
  assert.equal(p.ok, true);
  assert.ok(p.rows.every(r => r.scope === 'project'));
  const claudeMd = byName(p.rows, 'CLAUDE.md');
  assert.deepEqual(claudeMd.clis.map(c => c.key).sort(), ['claude', 'hermes', 'pi']);
  const agentsMd = byName(p.rows, 'AGENTS.md');
  assert.deepEqual(agentsMd.clis.map(c => c.key).sort(), ['codex', 'hermes', 'pi']);
  assert.equal(p.rows.filter(r => r.name === 'CLAUDE.md').length, 1);
  assert.deepEqual(byName(p.rows, 'GEMINI.md').clis.map(c => c.key), ['agy']);
  const memory = byName(p.rows, 'MEMORY.md');
  assert.ok(memory, 'the store folder is attributed to the project in the db');
  assert.deepEqual([memory.kind, memory.section, memory.cli.key], ['memory', 'Memory', 'claude']);
  for (const n of ['settings.json']) assert.ok(p.rows.filter(r => r.name === n).length >= 2);
  assert.ok(byName(p.rows, 'config.toml'));
  assert.deepEqual(p.declines, []);

  // Without the folder attribution the auto memory is not there.
  instructions.init({ backends, log: noLog, db: { getProjectStates: () => new Map([[project, { registered: true }]]), getAllFolderMeta: () => new Map() } });
  assert.equal(byName(instructions.getInstructionInventory({ scope: project }).rows, 'MEMORY.md'), undefined);
});

test('Hermes lists its five names (the home for global, the project for project scope)', () => {
  wire();
  write(path.join(hermesHome, '.hermes.md'), 'dot\n');
  write(path.join(hermesHome, '.cursorrules'), 'rules\n');
  const g = instructions.getInstructionInventory({ scope: 'global' });
  const h = g.rows.filter(r => r.cli.key === 'hermes' && r.kind === 'instructions').map(r => r.name).sort();
  assert.deepEqual(h, ['.cursorrules', '.hermes.md', 'AGENTS.md', 'SOUL.md']);
  write(path.join(project, '.hermes.md'), 'dot\n');
  const p = instructions.getInstructionInventory({ scope: project });
  assert.ok(byName(p.rows, '.hermes.md'));
});

test('agy: the global GEMINI.md appears when it exists', () => {
  wire();
  // The home is derived by the descriptor from its store override; create the file where it looks.
  const conv = STORE.agy;
  const gemini = path.join(path.dirname(path.dirname(conv)), 'GEMINI.md');
  write(gemini, '# gemini global\n');
  const g = instructions.getInstructionInventory({ scope: 'global' });
  const row = g.rows.find(r => r.name === 'GEMINI.md' && r.scope === 'global');
  assert.ok(row, 'the global agy file is listed');
  assert.equal(row.cli.key, 'agy');
  fs.rmSync(gemini);
});

test('no row carries a backend id or a path; ids are opaque', () => {
  wire();
  for (const scope of ['global', project]) {
    const a = instructions.getInstructionInventory({ scope });
    const text = JSON.stringify(a);
    assert.equal(text.includes(root.replace(/\\/g, '\\\\')), false, 'no path');
    assert.equal(text.includes(path.basename(root)), false, 'no path');
    for (const r of a.rows) {
      assert.match(r.id, /^[0-9a-f]{16}$/);
      assert.equal('path' in r || 'filePath' in r || 'backendId' in r, false);
    }
  }
});

test('a project off the register is refused; an unknown scope is refused', () => {
  wire();
  assert.equal(instructions.getInstructionInventory({ scope: otherProject }).ok, false);
  assert.equal(instructions.getInstructionInventory({ scope: 42 }).ok, false);
  assert.equal(instructions.readInstruction({ id: 'x'.repeat(16), scope: otherProject }).ok, false);
});

// --- doors ----------------------------------------------------------------------------------------------

const idOf = (scope, name, cli) => instructions.getInstructionInventory({ scope }).rows
  .find(r => r.name === name && (!cli || r.cli.key === cli)).id;

test('read: by id; an id not in the listing is refused; the other scope is not reachable with this id', () => {
  wire();
  const id = idOf('global', 'AGENTS.md', 'codex');
  const read = instructions.readInstruction({ id, scope: 'global' });
  assert.equal(read.ok, true);
  assert.equal(read.content, '# codex global\n');
  assert.equal(instructions.readInstruction({ id: '0123456789abcdef', scope: 'global' }).ok, false);
  assert.equal(instructions.readInstruction({ id, scope: project }).ok, false, 'a global file is not in the project scope');
  assert.equal(instructions.readInstruction({ id: '', scope: 'global' }).ok, false);
});

test('save: needs a baseline, writes through safe-write, keeps EOL and BOM, validates the format', () => {
  wire();
  const file = path.join(codexHome, 'config.toml');
  fs.writeFileSync(file, '﻿a = 1\r\nb = 2\r\n');
  const id = idOf('global', 'config.toml', 'codex');
  const baseline = instructions.readInstruction({ id, scope: 'global' }).content;
  assert.equal(instructions.saveInstruction({ id, scope: 'global', content: 'a = 1\n' }).ok, false, 'no baseline, no write');
  const saved = instructions.saveInstruction({ id, scope: 'global', content: 'a = 1\nb = 3\n', baseline });
  assert.equal(saved.ok, true);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(bytes, '﻿a = 1\r\nb = 3\r\n', 'BOM and CRLF are the file\'s own');

  const bad = instructions.saveInstruction({ id, scope: 'global', content: 'a = = =\n', baseline: saved.content });
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '﻿a = 1\r\nb = 3\r\n', 'a failed check writes nothing');
});

test('save: a stale baseline answers the conflict and writes nothing', () => {
  wire();
  const file = path.join(codexHome, 'AGENTS.md');
  fs.writeFileSync(file, 'first\n');
  const id = idOf('global', 'AGENTS.md', 'codex');
  const baseline = instructions.readInstruction({ id, scope: 'global' }).content;
  fs.writeFileSync(file, 'an agent wrote this\n');
  const r = instructions.saveInstruction({ id, scope: 'global', content: 'mine\n', baseline });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(r.diskContent, 'an agent wrote this\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'an agent wrote this\n');
  fs.writeFileSync(file, '# codex global\n');
});

test('read and save refuse a file over the size cap and one that is not text', () => {
  wire();
  const big = path.join(claudeHome, 'notes.md');
  fs.writeFileSync(big, 'a'.repeat(1024 * 1024 + 1));
  const row = instructions.getInstructionInventory({ scope: 'global' }).rows.find(r => r.name === 'notes.md');
  assert.equal(row.editable, false);
  assert.equal(instructions.readInstruction({ id: row.id, scope: 'global' }).ok, false);
  fs.writeFileSync(big, Buffer.from([0x23, 0x20, 0x00, 0x01]));
  assert.match(instructions.readInstruction({ id: row.id, scope: 'global' }).reason, /not text/);
  fs.writeFileSync(big, '# loose note\n');
});

test('a refusal carries no path', () => {
  wire();
  const file = path.join(claudeHome, 'notes.md');
  const id = idOf('global', 'notes.md', 'claude');
  fs.rmSync(file);
  const r = instructions.readInstruction({ id, scope: 'global' });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(r).includes(path.basename(root)), false);
  write(file, '# loose note\n');
});

test('locate: a listed real path gives its id and scope, anything else gives null', () => {
  wire();
  const g = instructions.locateInstruction({ path: path.join(codexHome, 'AGENTS.md') });
  assert.deepEqual([g.scope, g.projectPath], ['global', null]);
  assert.equal(g.id, idOf('global', 'AGENTS.md', 'codex'));
  const p = instructions.locateInstruction({ path: path.join(project, 'GEMINI.md'), projectPath: project });
  assert.deepEqual([p.scope, p.projectPath], ['project', project]);
  assert.equal(p.id, idOf(project, 'GEMINI.md'));
  assert.equal(instructions.locateInstruction({ path: path.join(project, 'GEMINI.md') }), null, 'no project named: only the global scope is asked');
  assert.equal(instructions.locateInstruction({ path: path.join(project, 'nothing.md'), projectPath: project }), null);
  assert.equal(instructions.locateInstruction({ path: path.join(otherProject, 'CLAUDE.md'), projectPath: otherProject }), null);
  assert.equal(instructions.locateInstruction({ path: 'relative.md' }), null);
  assert.equal(instructions.locateInstruction({}), null);
  // Equality, not a prefix: the parent directory is not a file.
  assert.equal(instructions.locateInstruction({ path: project, projectPath: project }), null);
});

test('content match: finds a word that is only in a body, ignores the rest; project off the register is refused', async () => {
  wire();
  write(path.join(project, 'AGENTS.md'), '# project agents\nthe zebra rule\n');
  const hit = await instructions.matchInstructionContent({ scope: project, query: 'ZEBRA' });
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.ids, [idOf(project, 'AGENTS.md')]);
  assert.deepEqual((await instructions.matchInstructionContent({ scope: project, query: 'z' })).ids, [], 'one character matches nothing');
  assert.equal((await instructions.matchInstructionContent({ scope: otherProject, query: 'zebra' })).ok, false);
  write(path.join(project, 'AGENTS.md'), '# project agents\n');
});

test('stub descriptors: one file named by two CLIs is one row carrying both', () => {
  const dir = fs.mkdtempSync(path.join(root, 'stub-'));
  write(path.join(dir, 'AGENTS.md'), 'shared\n');
  const owner = {
    id: 'own', label: 'Own', memorySources: () => [{ kind: 'file', path: path.join(dir, 'AGENTS.md'), source: 'g' }],
    listResources: () => ({ ok: true, resources: [] }),
  };
  const twin = {
    id: 'twin', label: 'Twin', memorySources: () => [{ kind: 'file', path: path.join(dir, 'AGENTS.md'), source: 'g' }],
    listResources: () => ({ ok: true, resources: [] }),
  };
  const list = [owner, twin];
  const registry = {
    list: () => list.map(b => ({ id: b.id, isProfile: false, status: 'ready' })),
    get: (id) => list.find(b => b.id === id) || null,
  };
  wire(registry, []);
  const a = instructions.getInstructionInventory({ scope: 'global' });
  assert.equal(a.rows.length, 1);
  assert.deepEqual(a.rows[0].clis.map(c => c.key).sort(), ['own', 'twin']);
  assert.deepEqual(a.declines, []);
  wire();
});

test('agy built-in resource files outside the editor allow-list are listed, readable as text, never saved', () => {
  wire();
  const builtin = path.join(path.dirname(STORE.agy), 'builtin');
  const txt = write(path.join(builtin, 'prompt.txt'), 'a plain prompt\n');
  write(path.join(builtin, 'blob.bin'), Buffer.from([1, 0, 2]));
  const rows = instructions.getInstructionInventory({ scope: 'global' }).rows;
  const t = rows.find(r => r.name === 'prompt.txt');
  assert.ok(t, 'listed although .txt is not an editor extension');
  assert.deepEqual([t.kind, t.section, t.cli.key, t.editable], ['resource', 'Resources', 'agy', false]);
  assert.equal(instructions.readInstruction({ id: t.id, scope: 'global' }).content, 'a plain prompt\n');
  const saved = instructions.saveInstruction({ id: t.id, scope: 'global', content: 'x\n', baseline: 'a plain prompt\n' });
  assert.equal(saved.ok, false);
  assert.equal(fs.readFileSync(txt, 'utf8'), 'a plain prompt\n', 'nothing written');
  const b = rows.find(r => r.name === 'blob.bin');
  assert.equal(b.editable, false);
  assert.match(instructions.readInstruction({ id: b.id, scope: 'global' }).reason, /not text/);
  fs.rmSync(builtin, { recursive: true, force: true });
});

test('save refuses content with a NUL byte and writes nothing', () => {
  wire();
  const id = idOf('global', 'AGENTS.md', 'codex');
  const baseline = instructions.readInstruction({ id, scope: 'global' }).content;
  const r = instructions.saveInstruction({ id, scope: 'global', content: 'a\0b\n', baseline });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), baseline);
});

test('the module works with only its own init (no plans-memory)', () => {
  instructions.init({ backends, log: noLog, db: { getProjectStates: () => new Map([[project, { registered: true }]]), getAllFolderMeta: () => new Map([[STORE_FOLDER, { projectPath: project }]]) } });
  inventory.init({ backends, log: noLog });
  const p = instructions.getInstructionInventory({ scope: project });
  assert.equal(p.ok, true);
  assert.ok(p.rows.find(r => r.name === 'MEMORY.md'), 'the store folder comes from its own db reads');
});
