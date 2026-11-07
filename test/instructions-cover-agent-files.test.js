'use strict';
// #823 T9 — every row the Agent Files tab shows today has a new home (spec 44, plan T9).
//
// The Agent Files tab is gone (T11, T12), so its answer is RECORDED below instead of computed: `RECORDED_ROWS` is what the
// removed `getMemories()` listed over exactly this fixture (all five CLIs, global and one project), captured from the
// last commit that still had it (31c920ae). The old function cannot stay in the tree just to be the baseline. Each
// recorded row must be found, BY REAL PATH KEY (`pathKey`, never a name), in one of the new homes:
//   - the resource inventory (agents, commands, rules),
//   - the skills inventory,
//   - the instruction inventory,
//   - the project Instructions page's "Work files" listing (T10, plan P6),
// or be a kind that is deliberately elsewhere (`handoff` groups stay where handoffs are, plan P7).
// If the fixture changes, the recorded list changes with it: add the row you made, with the kind Agent Files gave it.
// A row with no home fails by name and kind. The inventories are asked through their `_collect` seams because
// the public answers carry no path by design.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cover-'));
const STORE = {};
for (const id of ['claude', 'codex', 'hermes', 'pi', 'agy']) {
  STORE[id] = path.join(root, id, 'store');
  fs.mkdirSync(STORE[id], { recursive: true });
  process.env['SWITCHBOARD_STORE_' + id.toUpperCase()] = STORE[id];
}
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });

const backends = require('../src/backends');
const inventory = require('../src/app/resource-inventory');
const instructions = require('../src/app/instruction-files');
const backendResources = require('../src/app/backend-resources');
const skills = require('../src/app/skills');
const { pathKey } = require('../src/app/path-containment');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file, body = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const claudeHome = path.dirname(STORE.claude);
const codexHome = path.dirname(STORE.codex);
const hermesHome = STORE.hermes;
const piAgentDir = require('../src/backends/pi/trust').agentDir();
const STORE_FOLDER = 'folder-for-project';

// Fixture homes: the same shapes as test/instruction-inventory.test.js, plus an agent, a rule, a skill and work files
// so each Agent Files kind has a row. A copy of that file's layout; extend both when a new kind needs a fixture.
write(path.join(claudeHome, 'CLAUDE.md'), '# claude global\n');
write(path.join(claudeHome, 'notes.md'), '# loose note\n');
write(path.join(claudeHome, 'settings.json'), '{}\n');
write(path.join(claudeHome, 'output-styles', 'terse.md'), 'terse\n');
write(path.join(claudeHome, 'commands', 'ship.md'), '# command\n');
write(path.join(claudeHome, 'agents', 'reviewer.md'), '# agent\n');
write(path.join(claudeHome, 'skills', 'do-it', 'SKILL.md'), '---\nname: do-it\ndescription: d\n---\n');
write(path.join(codexHome, 'AGENTS.md'), '# codex global\n');
write(path.join(codexHome, 'config.toml'), 'model = "x"\n');
write(path.join(codexHome, 'memories', 'remember.md'), 'remember\n');
write(path.join(codexHome, 'rules', 'default.md'), '# rule\n');
write(path.join(hermesHome, 'SOUL.md'), 'soul\n');
write(path.join(hermesHome, 'AGENTS.md'), 'hermes agents\n');
write(path.join(hermesHome, 'config.yaml'), 'a: 1\n');
write(path.join(piAgentDir, 'settings.json'), '{}\n');
write(path.join(project, 'CLAUDE.md'), '# project claude\n');
write(path.join(project, 'AGENTS.md'), '# project agents\n');
write(path.join(project, 'GEMINI.md'), '# project gemini\n');
write(path.join(project, '.claude', 'settings.json'), '{}\n');
write(path.join(project, '.claude', 'extra.md'), '# extra\n');
write(path.join(project, '.claude', 'commands', 'local.md'), '# local command\n');
write(path.join(project, '.claude', 'agents', 'local-agent.md'), '# local agent\n');
write(path.join(project, '.codex', 'config.toml'), 'a = 1\n');
write(path.join(project, '.pi', 'settings.json'), '{}\n');
write(path.join(project, '.work-files', 'scratch.txt'), 'scratch\n');
write(path.join(STORE.claude, STORE_FOLDER, 'memory', 'MEMORY.md'), '# auto memory\n');

const noLog = { debug() {}, warn() {}, error() {}, info() {} };
const states = () => new Map([[project, { registered: true }]]);

function wire() {
  inventory.init({ backends, log: noLog });
  backendResources.init({ backends, log: noLog });
  skills.init({ backends, log: noLog, dataDir: path.join(root, 'data'), effectiveSettings: () => ({}), projectStates: states });
  instructions.init({
    backends, log: noLog,
    db: { getProjectStates: states, getAllFolderMeta: () => new Map([[STORE_FOLDER, { projectPath: project }]]) },
  });
}

// What Agent Files listed for this fixture: [path below the temp root, kind]. Recorded, not computed (see the header).
const RECORDED_ROWS = [
  ['claude/CLAUDE.md', 'instructions'],
  ['claude/agents/reviewer.md', 'agent'],
  ['claude/commands/ship.md', 'command'],
  ['claude/notes.md', 'instructions'],
  ['claude/output-styles/terse.md', 'output-style'],
  ['claude/settings.json', 'settings'],
  ['claude/store/folder-for-project/memory/MEMORY.md', 'instructions'],
  ['codex/config.toml', 'settings'],
  ['codex/memories/remember.md', 'memory-store'],
  ['codex/rules/default.md', 'rule'],
  ['hermes/store/AGENTS.md', 'instructions'],
  ['hermes/store/SOUL.md', 'instructions'],
  ['hermes/store/config.yaml', 'settings'],
  ['pi/pi-agent/settings.json', 'settings'],
  ['project/.claude/agents/local-agent.md', 'agent'],
  ['project/.claude/commands/local.md', 'instructions'],
  ['project/.claude/extra.md', 'instructions'],
  ['project/.claude/settings.json', 'settings'],
  ['project/.codex/config.toml', 'settings'],
  ['project/.pi/settings.json', 'settings'],
  ['project/.work-files/scratch.txt', 'work-file'],
  ['project/AGENTS.md', 'instructions'],
  ['project/CLAUDE.md', 'instructions'],
  ['project/GEMINI.md', 'instructions'],
];

function agentFilesRows() {
  return RECORDED_ROWS.map(([rel, kind]) => {
    const filePath = path.join(root, ...rel.split('/'));
    return { key: pathKey(filePath), filePath, kind, where: rel.startsWith('project/') ? 'project' : 'global', group: null };
  });
}

// The recorded rows are real files of this fixture, or the list has drifted from it.
test('the recorded Agent Files rows exist in the fixture', () => {
  for (const r of agentFilesRows()) assert.ok(fs.existsSync(r.filePath), 'fixture file missing: ' + r.filePath);
});

// The new homes, by real path key.
function homeKeys() {
  const keys = new Set();
  for (const view of Object.keys(inventory.RESOURCE_VIEWS)) {
    for (const projectPath of [null, project]) {
      for (const r of inventory._collect(view, projectPath).rows) keys.add(pathKey(r.filePath));
    }
  }
  for (const projectPath of [null, project]) {
    for (const r of skills._collectSkillInventory({ projectPath })) keys.add(pathKey(r.filePath));
    for (const r of instructions._collect(projectPath).rows) keys.add(pathKey(r.filePath));
  }
  // The project Instructions page's "Work files" section (T10): listed through the same door the page uses.
  for (const f of instructions._workFilesOf(project).files) keys.add(pathKey(f.filePath));
  return keys;
}

// Kinds Agent Files lists that live somewhere other than the three inventories. Each carries its reason. A kind
// here that every fixture row of it nevertheless finds in an inventory is stale and fails below.
const ELSEWHERE = {
  handoff: 'handoff packets stay in the sidebar Handoffs group, the picker and src/app/handoffs.js (plan P7)',
};
// Kinds still waiting for a home. Empty since T10 gave work files their section (plan P6); the stale check stays.
const PENDING_T10 = {};

test('every Agent Files row has a new home, matched by real path', () => {
  wire();
  const rows = agentFilesRows();
  const homes = homeKeys();
  assert.ok(rows.length >= 10, `the fixture homes produce Agent Files rows (got ${rows.length})`);

  const homeless = rows.filter(r => !homes.has(r.key) && !(r.kind in ELSEWHERE) && !(r.kind in PENDING_T10));
  assert.deepEqual(
    homeless.map(r => `${r.kind}: ${path.basename(r.filePath)} (${r.where}${r.group ? ', group ' + r.group : ''})`),
    [],
    'Agent Files rows with no home in the resource, skills or instruction inventory: fix the inventory, not this list',
  );
});

test('the fixture reaches the kinds the tab has (a guard that sees nothing proves nothing)', () => {
  wire();
  const kinds = new Set(agentFilesRows().map(r => r.kind));
  for (const k of ['agent', 'command', 'rule', 'output-style', 'memory-store', 'settings', 'work-file']) {
    assert.ok(kinds.has(k), `the fixture produces a ${k} row (got ${[...kinds].sort().join(', ')})`);
  }
});

test('the exemption lists are not stale', () => {
  wire();
  const rows = agentFilesRows();
  const homes = homeKeys();
  for (const [kind, reason] of Object.entries(PENDING_T10)) {
    assert.ok(reason);
    const ofKind = rows.filter(r => r.kind === kind);
    assert.ok(ofKind.length, `the fixture has a ${kind} row, or the pending entry guards nothing`);
    const housed = ofKind.filter(r => homes.has(r.key));
    assert.deepEqual(housed.map(r => path.basename(r.filePath)), [],
      `${kind} rows now have a home in an inventory: T10 landed, so delete the ${kind} entry from PENDING_T10`);
  }
  for (const [kind, reason] of Object.entries(ELSEWHERE)) {
    assert.ok(reason);
    const housed = rows.filter(r => r.kind === kind && homes.has(r.key));
    assert.deepEqual(housed.map(r => path.basename(r.filePath)), [],
      `${kind} rows are in an inventory now: delete the ${kind} entry from ELSEWHERE`);
  }
});

test('work files: listed by id, read-only text, deleted only when listed (T10)', () => {
  wire();
  const list = instructions.getWorkFileList({ scope: project });
  assert.equal(list.ok, true);
  const row = list.rows.find(r => r.name === 'scratch.txt');
  assert.ok(row && !('filePath' in row), 'a row by id, no path');
  assert.equal(instructions.readWorkFileById({ id: row.id, scope: project }).content, 'scratch\n');
  assert.equal(instructions.getWorkFileList({ scope: 'global' }).ok, false, 'work files belong to a project');
  assert.equal(instructions.getWorkFileList({ scope: path.join(root, 'elsewhere') }).ok, false, 'an unregistered project is refused');
  assert.equal(instructions.deleteWorkFileById({ id: '../x', scope: project }).ok, false, 'an unlisted id is refused');
  const doomed = path.join(project, '.work-files', 'doomed.txt');
  write(doomed);
  const id = instructions.getWorkFileList({ scope: project }).rows.find(r => r.name === 'doomed.txt').id;
  assert.equal(instructions.deleteWorkFileById({ id, scope: project }).ok, true);
  assert.equal(fs.existsSync(doomed), false);
});

test('work files: a .work-files that is a link out of the project lists nothing; a linked file is not read', (t) => {
  wire();
  const other = path.join(root, 'linked-project');
  const outside = path.join(root, 'outside-dir');
  write(path.join(outside, 'secret.txt'), 'secret\n');
  fs.mkdirSync(other, { recursive: true });
  try { fs.symlinkSync(outside, path.join(other, '.work-files'), 'junction'); } catch (err) {
    t.skip('cannot create a directory link here: ' + err.code);
    return;
  }
  const states2 = () => new Map([[project, { registered: true }], [other, { registered: true }]]);
  instructions.init({ backends, log: noLog, db: { getProjectStates: states2, getAllFolderMeta: () => new Map() } });
  skills.init({ backends, log: noLog, dataDir: path.join(root, 'data'), effectiveSettings: () => ({}), projectStates: states2 });
  const listed = instructions.getWorkFileList({ scope: other });
  assert.deepEqual(listed.rows || [], [], 'a link out of the project lists nothing');
  assert.equal(listed.total, 0);
});
