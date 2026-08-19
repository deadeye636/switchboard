'use strict';
// #447 — the Agent Files filters: by type, and by backend.
//
// An earlier version of this file asserted that certain SOURCE STRINGS were present, and it passed
// while the "nothing matches the current filter" message it checked for was unreachable: the empty
// check asked whether the raw data was empty, so filtering a non-empty list to nothing rendered a blank
// panel. A test that greps for a sentence proves the sentence exists, not that anyone can ever see it.
//
// So the decisions moved into `views/agent-file-filter.js` — pure, requireable — and this file calls
// them with data. What remains as a source check is only the wiring nothing else can see.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const plansMemory = require('../src/app/plans-memory');
const filter = require('../src/renderer/views/agent-file-filter');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const row = (over) => ({ filePath: 'p', kind: 'skill', backendIds: ['hermes'], ...over });

const DATA = {
  global: {
    files: [
      row({ filePath: '/g/CLAUDE.md', kind: 'instructions', backendIds: ['claude', 'pi'] }),
      row({ filePath: '/g/AGENTS.md', kind: 'instructions', backendIds: ['codex', 'pi'] }),
    ],
    groups: [
      { id: 'hermes:skills', backendId: 'hermes', label: 'skills', files: [
        row({ filePath: '/g/skills/a/SKILL.md' }),
        row({ filePath: '/g/skills/b/SKILL.md' }),
      ] },
      { id: 'claude:commands', backendId: 'claude', label: 'commands', files: [
        row({ filePath: '/g/commands/x.md', kind: 'command', backendIds: ['claude'] }),
      ] },
    ],
  },
  projects: [
    { folder: 'f1', projectPath: '/p1', shortName: 'p1', displayName: 'One',
      files: [row({ filePath: '/p1/CLAUDE.md', kind: 'instructions', backendIds: ['claude'] })], groups: [] },
  ],
};

// --- the label and counting rules (core) ---------------------------------------------------------

test('a kind becomes a plural label', () => {
  const label = plansMemory._typeLabel;
  assert.equal(label('skill'), 'Skills');
  assert.equal(label('command'), 'Commands');
  assert.equal(label('memory'), 'Memories');            // y -> ies, not "Memorys"
  assert.equal(label('instructions'), 'Instructions');  // already plural, left alone
  assert.equal(label('prompt-template'), 'Prompt templates');
});

test('types are counted from the rows, biggest first, and a type with no rows gets no chip', () => {
  const counts = plansMemory._typeCounts([
    { kind: 'skill' }, { kind: 'skill' }, { kind: 'skill' },
    { kind: 'instructions' }, { kind: 'rule' }, { kind: 'rule' },
  ]);
  assert.deepEqual(counts.map(t => `${t.id}:${t.count}`), ['skill:3', 'rule:2', 'instructions:1']);
  assert.equal(counts.some(t => t.id === 'command'), false);
});

test('a row with no kind is STAMPED with the fallback, not merely counted as one', () => {
  // The renderer compares against what it was given. If the core only counted the fallback without
  // writing it onto the row, filtering to it would match nothing and the chip would be a dead end.
  const rows = [{ kind: null }, {}];
  const counts = plansMemory._typeCounts(rows);
  assert.deepEqual(counts, [{ id: 'other', label: 'Others', count: 2 }]);
  assert.deepEqual(rows.map(r => r.kind), ['other', 'other']);
});

test('a file claimed by two backends counts for both', () => {
  const counts = plansMemory._backendCounts(
    [{ backendIds: ['claude', 'pi'] }, { backendIds: ['pi'] }, { backendIds: ['codex'] }],
    [{ id: 'claude', label: 'Claude Code' }, { id: 'pi', label: 'Pi' }, { id: 'codex', label: 'Codex' }],
  );
  assert.deepEqual(counts.map(b => `${b.id}:${b.count}`), ['pi:2', 'claude:1', 'codex:1']);
  assert.equal(counts.find(b => b.id === 'claude').label, 'Claude Code');
});

// --- what the tab shows (renderer, pure half) ----------------------------------------------------

test('no filter shows everything', () => {
  const s = filter.agentFileSections(DATA, {});
  assert.equal(s.shown, 6);
  assert.equal(s.globalGroups.length, 2);
  assert.equal(s.projects.length, 1);
});

test('the type filter narrows global files, groups and projects alike', () => {
  const s = filter.agentFileSections(DATA, { type: 'instructions' });
  assert.equal(s.shown, 3);
  assert.equal(s.globalFiles.length, 2);
  assert.equal(s.globalGroups.length, 0, 'a group left with no matching file drops out');
  assert.equal(s.projects.length, 1);
});

test('the backend filter matches a file that several backends claim', () => {
  // AGENTS.md is Codex' and Pi's. Filtering to Pi must show it; filtering to Codex must too.
  const pi = filter.agentFileSections(DATA, { backend: 'pi' });
  assert.deepEqual(pi.globalFiles.map(f => f.filePath), ['/g/CLAUDE.md', '/g/AGENTS.md']);
  const codex = filter.agentFileSections(DATA, { backend: 'codex' });
  assert.deepEqual(codex.globalFiles.map(f => f.filePath), ['/g/AGENTS.md']);
  assert.equal(codex.projects.length, 0);
});

test('type and backend filters AND together', () => {
  const s = filter.agentFileSections(DATA, { type: 'skill', backend: 'hermes' });
  assert.equal(s.shown, 2);
  const none = filter.agentFileSections(DATA, { type: 'skill', backend: 'claude' });
  assert.equal(none.shown, 0, 'claude has no skills in this data');
});

test('search and the chips AND together, and an empty search Set narrows to nothing', () => {
  const searchIds = new Set(['/g/skills/a/SKILL.md']);
  assert.equal(filter.agentFileSections(DATA, { searchIds }).shown, 1);
  assert.equal(filter.agentFileSections(DATA, { searchIds, type: 'instructions' }).shown, 0);
  // A search that matched nothing is an EMPTY set, not null — the difference between "no search" and
  // "searched and found nothing", and getting it wrong opens the list back up.
  assert.equal(filter.agentFileSections(DATA, { searchIds: new Set() }).shown, 0);
});

test('narrowing to nothing says so, and an empty store says something else', () => {
  // This is the defect the source-string version of this file could not see.
  assert.equal(filter.agentFileSections(DATA, { type: 'rule' }).shown, 0);
  assert.equal(filter.agentFileEmptyMessage({ type: 'rule' }), 'Nothing matches the current filter.');
  assert.equal(filter.agentFileEmptyMessage({ searchIds: new Set() }), 'Nothing matches the current filter.');
  assert.equal(filter.agentFileEmptyMessage({}), 'No agent files found.');
});

test('a malformed payload does not take the tab down with it', () => {
  // The module exists so decisions can be handed data. Data includes the shapes a caller got wrong —
  // and an exception here blanks the whole sidebar tab, not just one row.
  assert.doesNotThrow(() => filter.agentFileSections({ global: { files: [], groups: [{ id: 'x' }] }, projects: [] }, {}));
  assert.doesNotThrow(() => filter.agentFileSections({}, { type: 'skill' }));
  assert.doesNotThrow(() => filter.agentFileSections(null, {}));
  assert.doesNotThrow(() => filter.agentFileSections({ projects: [{ folder: 'f' }] }, { backend: 'pi' }));
  assert.equal(filter.agentFileSections(null, {}).shown, 0);
  assert.equal(filter.agentFileRowVisible(null, {}), false);
});

test('a filter whose chip left the data clears itself', () => {
  const rows = [{ id: 'skill' }, { id: 'command' }];
  assert.equal(filter.agentFileLiveFilter('skill', rows), 'skill');
  assert.equal(filter.agentFileLiveFilter('rule', rows), null);
  assert.equal(filter.agentFileLiveFilter(null, rows), null);
});

test('filtering is on when any one filter is', () => {
  assert.equal(filter.agentFileFiltering({}), false);
  assert.equal(filter.agentFileFiltering({ type: 'skill' }), true);
  assert.equal(filter.agentFileFiltering({ backend: 'pi' }), true);
  assert.equal(filter.agentFileFiltering({ searchIds: new Set() }), true);
});

// --- the wiring no behavioural test can see ------------------------------------------------------

test('instruction files are given a kind and their backends by the core', () => {
  const src = read('src/app/plans-memory.js');
  assert.match(src, /INSTRUCTION_KIND = 'instructions'/);
  assert.equal((src.match(/kind: INSTRUCTION_KIND/g) || []).length, 2,
    'both collection paths (a directory scan and a single file) must stamp the kind');
  assert.match(src, /function claim\(seen, filePath, backendId\)/,
    'a second backend claiming the same file must add itself to the row, not be dropped');
});

test('the payload carries both chip rows', () => {
  const src = read('src/app/plans-memory.js');
  assert.match(src, /types: typeCounts\(everyFile\)/);
  assert.match(src, /backends: backendCounts\(everyFile, backendsList\)/);
});

test('the renderer names no kind of its own', () => {
  const view = read('src/renderer/views/plans-memory-view.js');
  for (const kind of ['skill', 'rule', 'command', 'instructions', 'other']) {
    assert.equal(view.includes(`'${kind}'`), false,
      `plans-memory-view.js names the kind "${kind}" — that vocabulary belongs to the core`);
  }
});

test('the chip bar belongs to the Agent Files tab alone', () => {
  assert.match(read('src/renderer/app.js'), /applyAgentFileTypeFilterVisibility\(tabName\)/);
  assert.match(read('src/renderer/index.html'), /id="agent-file-type-filters"/);
});
