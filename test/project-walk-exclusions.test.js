'use strict';
// #483 — the two walks that descend through a project, and what they now refuse to enter.
//
// `.work-files/` is scratch space and the skills tree keeps going until a folder holds SKILL.md, so both
// happily walk a checkout, a venv or an install that somebody dropped in there — a hundred thousand
// entries for no document. The second refusal is not about cost: a stat on a path ending in `.asar`
// makes Electron cache that archive open for the life of the process, and that is how a build stopped
// being possible while the app ran. `src/app/build-dirs.js` has the measurement.
//
// What these tests can and cannot see: `node --test` runs on plain Node, which has no asar layer, so the
// observable here is that the entry is not LISTED. The handle itself was measured under Electron and is
// recorded in the module header; nothing in the suite can reproduce it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const expand = require('../src/backends/resource-expand');
const plansMemory = require('../src/app/plans-memory');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, body = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// --- the skills tree -----------------------------------------------------------------------------

const skillsIn = (root) =>
  expand.createExpandResource({ s: { mode: 'skillTree', kind: 'skill' } })({ path: root, source: 's' });

test('a skills tree does not descend into a dependency or build directory', () => {
  const root = tmpdir('sb-483-skills-');
  write(path.join(root, 'code-review', 'SKILL.md'));
  // The shape that costs: an install dropped beside the skills, deep enough that every level is a read.
  write(path.join(root, 'node_modules', 'some-package', 'SKILL.md'));
  write(path.join(root, 'dist', 'bundle', 'SKILL.md'));

  assert.deepEqual(skillsIn(root).entries.map(e => e.name), ['code-review']);
});

test('...but a skill that is itself called `build` still counts', () => {
  // This one passed before the change too — it is a guard on the SHAPE of the exclusion, not a
  // regression test. The exclusion is on the DESCENT, not on the name, and the cheap way to write it
  // (skip the entry before ever asking about SKILL.md) would delete a real skill from the list.
  const root = tmpdir('sb-483-skills2-');
  write(path.join(root, 'build', 'SKILL.md'));
  write(path.join(root, 'build', 'node_modules', 'nested', 'SKILL.md'));

  assert.deepEqual(skillsIn(root).entries.map(e => e.name), ['build'],
    'the skill is reported, and nothing under it is walked');
});

test('an asar in a customization directory is never STATTED, in any of the three modes', () => {
  // The assertion is on the stat and not on the listing, because the listing was already innocent in two
  // of the three modes while the stat happened in all of them — and it is the stat that takes the handle.
  const root = tmpdir('sb-483-asar-');
  write(path.join(root, 'app.asar'), 'not really an archive');
  write(path.join(root, 'real', 'SKILL.md'));
  write(path.join(root, 'note.md'));

  const realStat = fs.statSync;
  const touched = [];
  fs.statSync = (p, ...rest) => { touched.push(String(p)); return realStat(p, ...rest); };
  let entries;
  try {
    entries = ['skillTree', 'flatFiles', 'dirs'].map(mode => ({
      mode,
      names: expand.createExpandResource({
        s: { mode, kind: 'k', rootMarkdown: true, keepExtension: true },
      })({ path: root, source: 's' }).entries.map(e => path.basename(e.path)),
    }));
  } finally {
    fs.statSync = realStat;
  }

  assert.deepEqual(touched.filter(p => p.toLowerCase().endsWith('.asar')), [],
    'one stat and Electron holds the archive open for the rest of the session');
  for (const { mode, names } of entries) {
    assert.equal(names.includes('app.asar'), false, `${mode} listed the archive`);
  }
  // …and the walk still reports everything beside it.
  assert.equal(entries.find(e => e.mode === 'flatFiles').names.includes('note.md'), true);
});

// --- the work-files walk -------------------------------------------------------------------------

/** A project whose `.work-files/` holds one real note plus the shapes a workspace collects. */
function projectWithWorkFiles() {
  const projectPath = tmpdir('sb-483-work-');
  const work = path.join(projectPath, '.work-files');
  write(path.join(work, 'notes.md'));
  write(path.join(work, 'sub', 'deeper.md'));
  write(path.join(work, 'node_modules', 'left-pad', 'index.js'));
  write(path.join(work, 'dist', 'win-unpacked', 'resources', 'app.asar'));
  write(path.join(work, 'scratch-clone', '.git', 'config'));
  write(path.join(work, 'app.asar'));

  plansMemory.init({
    backends: { list: () => [] },
    db: {
      getProjectStates: () => new Map([[projectPath, { registered: 1, hidden: 0, autoHidden: 0 }]]),
      getProjectDisplayNames: () => new Map(),
      getAllFolderMeta: () => new Map(),
      deleteSearchType() {},
      upsertSearchEntries() {},
    },
    log: { warn() {}, error() {}, info() {} },
    activeSessions: new Map(),
    dataDir: projectPath,
  });
  plansMemory.invalidateFtsSignature('work-file');
  return projectPath;
}

test('the work-files walk lists the documents and skips what a workspace collects', () => {
  projectWithWorkFiles();
  const { projects } = plansMemory.getWorkFiles();
  assert.equal(projects.length, 1);
  const listed = projects[0].files.map(f => f.relativePath.split(path.sep).join('/')).sort();

  assert.deepEqual(listed, ['notes.md', 'sub/deeper.md']);
  assert.equal(projects[0].totalCount, 2, 'the count the group header shows is the walked set');
});
