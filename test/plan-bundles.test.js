'use strict';
// #743 — a plan kept as a BUNDLE (`docs/plans/<slug>/PLAN.md`) is a plan.
//
// WHY THIS EXISTS:
//   The project plans directories were read flat, so a project that keeps each plan in a folder of its
//   own had an empty Plans list — and its configured plans directory was reported "empty" above it.
//   The walk that replaced the flat read has limits (depth, skipped folders, no links), and each limit
//   is a place where a plan can silently vanish or a foreign file can silently appear. This file pins
//   each of them, and the open guard beside them, because a row the viewer refuses to open is worse
//   than no row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plansMemory = require('../src/app/plans-memory');

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-planbundles-')));

// Watches are opened by `getPlans`; hand them back before the tree is removed (Windows refuses to delete
// a watched directory), and so the run does not stay alive on an open handle.
test.after(() => { try { plansMemory.stopWatchingPlansDirs(); } catch {} });
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

function write(file, content = '# A plan\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A link to a directory: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkDir(target, at) {
  try {
    fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch { return false; }
}

function init(projects, { backends = [], planDirNames = ['docs/plans'] } = {}) {
  const states = new Map(projects.map(p => [p, { registered: true, hidden: false, autoHidden: false }]));
  plansMemory.init({
    backends: { list: () => backends },
    db: {
      getProjectStates: () => states,
      getProjectDisplayNames: () => new Map(),
      deleteSearchType() {},
      upsertSearchEntries() {},
    },
    log: { warn() {}, error() {}, info() {}, debug() {} },
    activeSessions: new Map(),
    dataDir: ROOT,
    effectiveSettings: () => ({ planDirNames }),
  });
}

test('a bundle folder is found, and its row is named by the path below the plans directory', () => {
  const project = path.join(ROOT, 'bundles');
  const plans = path.join(project, 'docs', 'plans');
  write(path.join(plans, 'top-level.md'), '# Top level\n');
  write(path.join(plans, '60-migration-lock-timeout', 'PLAN.md'), '# Migration lock timeout\n');
  init([project]);

  const rows = plansMemory.getPlans().plans.filter(p => p.projectPath === project);
  const byName = new Map(rows.map(p => [p.filename, p]));
  assert.ok(byName.has('top-level.md'), 'a top-level plan keeps its bare filename');
  const bundle = byName.get('60-migration-lock-timeout/PLAN.md');
  assert.ok(bundle, 'the bundle plan is listed under its relative path, with forward slashes');
  assert.equal(bundle.filePath, path.join(plans, '60-migration-lock-timeout', 'PLAN.md'));
  assert.equal(bundle.title, 'Migration lock timeout');
  assert.equal(bundle.sourceDir, 'docs/plans');

  const opened = plansMemory.readPlan(bundle.filePath);
  assert.equal(opened.content, '# Migration lock timeout\n', 'a listed bundle plan must open');
  const saved = plansMemory.savePlan(bundle.filePath, '# Migration lock timeout\n\nmore\n', opened.content);
  assert.equal(saved.ok, true, 'and save');
});

test('the walk stops three folder levels below the plans directory', () => {
  const plans = path.join(ROOT, 'depth', 'docs', 'plans');
  write(path.join(plans, 'a', 'b', 'c', 'deep-enough.md'));
  const tooDeep = write(path.join(plans, 'a', 'b', 'c', 'd', 'too-deep.md'));
  const rels = plansMemory._walkPlanFiles(plans).map(f => f.relPath);
  assert.deepEqual(rels, ['a/b/c/deep-enough.md']);

  init([path.join(ROOT, 'depth')]);
  assert.equal(plansMemory.readPlan(tooDeep).content, '', 'what the list cannot show, the viewer does not open');
});

test('hidden folders, node_modules and build directories are not entered', () => {
  const plans = path.join(ROOT, 'ignored', 'docs', 'plans');
  write(path.join(plans, 'kept', 'PLAN.md'));
  const hidden = write(path.join(plans, '.git', 'notes.md'));
  write(path.join(plans, 'node_modules', 'pkg', 'README.md'));
  write(path.join(plans, 'dist', 'out.md'));
  write(path.join(plans, 'kept', '.cache', 'scratch.md'));
  const rels = plansMemory._walkPlanFiles(plans).map(f => f.relPath).sort();
  assert.deepEqual(rels, ['kept/PLAN.md']);

  init([path.join(ROOT, 'ignored')]);
  assert.equal(plansMemory.readPlan(hidden).content, '', 'a file under a skipped folder does not open either');
});

test('a plan with no heading is named for its bundle folder, then for its filename', () => {
  assert.equal(plansMemory._planTitle('no heading here\n', '60-migration-lock-timeout/PLAN.md'), '60-migration-lock-timeout');
  assert.equal(plansMemory._planTitle('no heading here\n', 'a/b/notes.md'), 'b');
  assert.equal(plansMemory._planTitle('no heading here\n', 'loose-plan.md'), 'loose-plan');
  assert.equal(plansMemory._planTitle('\n# The heading\r\n', 'x/PLAN.md'), 'The heading', 'a heading still wins');
});

test('a configured plans directory holding only bundle folders is not reported empty', () => {
  const project = path.join(ROOT, 'unfulfilled');
  const cliPlans = path.join(project, 'cli-plans');
  write(path.join(cliPlans, 'some-slug', 'PLAN.md'));
  const empty = path.join(ROOT, 'unfulfilled-empty');
  fs.mkdirSync(path.join(empty, 'cli-plans', 'only-a-folder'), { recursive: true });
  const backend = {
    id: 'test-backend', isProfile: false, status: 'ready',
    plansDir: ({ projectPath } = {}) => (projectPath ? path.join(projectPath, 'cli-plans') : null),
  };
  init([project, empty], { backends: [backend] });

  const reported = plansMemory._unfulfilledPlanDirs();
  assert.ok(!reported.some(u => u.projectPath === project), 'bundle folders are plans');
  const other = reported.find(u => u.projectPath === empty);
  assert.ok(other, 'a directory with folders but no plan in them is still empty');
  assert.equal(other.reason, 'empty');
});

test('a link pointing out of the plans directory is neither listed nor openable', (t) => {
  const project = path.join(ROOT, 'contained');
  const plans = path.join(project, 'docs', 'plans');
  write(path.join(plans, 'inside', 'PLAN.md'));
  const outside = path.join(ROOT, 'elsewhere');
  const foreign = write(path.join(outside, 'foreign', 'PLAN.md'), '# Not this project\n');
  write(path.join(ROOT, 'secret.md'), '# Not a plan\n');
  if (!linkDir(outside, path.join(plans, 'escape'))) {
    t.skip('this system cannot create a directory link');
    return;
  }
  init([project]);

  const rels = plansMemory._walkPlanFiles(plans).map(f => f.relPath);
  assert.deepEqual(rels, ['inside/PLAN.md'], 'the walk does not follow a link out');
  const rows = plansMemory.getPlans().plans.filter(p => p.projectPath === project);
  assert.ok(!rows.some(p => p.title === 'Not this project'), 'no row for the foreign file');

  assert.equal(plansMemory.readPlan(path.join(plans, 'escape', 'foreign', 'PLAN.md')).content, '',
    'spelled inside, real path outside: refused');
  assert.equal(plansMemory.readPlan(foreign).content, '');
  assert.equal(plansMemory.readPlan(path.join(plans, '..', '..', '..', 'secret.md')).content, '',
    'a `..` that climbs out is refused');
  const save = plansMemory.savePlan(path.join(plans, 'escape', 'foreign', 'PLAN.md'), 'x', null);
  assert.equal(save.ok, false, 'and is not writable through the link');
});

test('the watch drops what the walk could not list, at the same depth', () => {
  const allowed = plansMemory._planRelPathAllowed;
  assert.equal(allowed('top.md'), true);
  assert.equal(allowed('a/b/c/PLAN.md'), true, 'three folders down is listed, so it is announced');
  assert.equal(allowed('a/b/c/d/deep.md'), false, 'past the depth: no rebuild');
  assert.equal(allowed('.git/index'), false);
  assert.equal(allowed('kept/node_modules/x.md'), false);
  assert.equal(allowed(path.join('a', '.cache', 'x.md')), false, 'a native separator is split too');
  assert.equal(allowed('..foo/PLAN.md'), false, 'a folder named `..foo` is hidden, not a climb');
});

test('a folder whose name starts with `..` is neither listed nor openable', (t) => {
  const project = path.join(ROOT, 'dotdot');
  const plans = path.join(project, 'docs', 'plans');
  let file;
  try { file = write(path.join(plans, '..foo', 'PLAN.md')); } catch { t.skip('this filesystem refuses the name'); return; }
  write(path.join(plans, 'kept.md'));
  init([project]);
  assert.deepEqual(plansMemory._walkPlanFiles(plans).map(f => f.relPath), ['kept.md']);
  assert.equal(plansMemory.readPlan(file).content, '', 'the guard reads `..foo` as a folder name');
});

test('a plan reached through another spelling of its plans directory meets the same limits', (t) => {
  const project = path.join(ROOT, 'alias');
  const plans = path.join(project, 'docs', 'plans');
  write(path.join(plans, 'kept', 'PLAN.md'), '# Kept\n');
  write(path.join(plans, '.git', 'notes.md'), '# Hidden\n');
  const alias = path.join(project, 'plans-alias');
  if (!linkDir(plans, alias)) { t.skip('this system cannot create a directory link'); return; }
  init([project]);
  assert.equal(plansMemory.readPlan(path.join(alias, 'kept', 'PLAN.md')).content, '# Kept\n');
  assert.equal(plansMemory.readPlan(path.join(alias, '.git', 'notes.md')).content, '',
    'the hidden folder is judged on the real path, not waved through for being spelled elsewhere');
});

test('the project root is not a plan directory on the read list', () => {
  const project = path.join(ROOT, 'rootname');
  write(path.join(project, 'README.md'), '# Not a plan\n');
  write(path.join(project, 'plans', 'real.md'), '# Real\n');
  init([project], { planDirNames: ['.', './', 'docs/..', '../rootname', 'plans'] });
  assert.deepEqual(plansMemory._planDirCandidates(project), ['../rootname', 'plans'],
    'the lexical spellings of the root are dropped like a blank entry');
  const dirs = plansMemory._projectPlanSources().filter(x => x.projectPath === project).map(x => x.dir);
  assert.deepEqual(dirs, [path.join(project, 'plans')], 'a spelling that climbs back in is dropped on real paths');
});

test('a heading-less bundle is titled after its folder in the list', () => {
  const project = path.join(ROOT, 'untitled');
  write(path.join(project, 'docs', 'plans', '61-cache-warmup', 'PLAN.md'), 'status: draft\n\nBody.\n');
  init([project]);
  const row = plansMemory.getPlans().plans.find(p => p.projectPath === project);
  assert.ok(row);
  assert.equal(row.filename, '61-cache-warmup/PLAN.md');
  assert.equal(row.title, '61-cache-warmup');
});

test('one file is one row, whatever case its directory is named in', (t) => {
  if (process.platform !== 'win32') { t.skip('case-insensitive paths are a Windows property'); return; }
  const project = path.join(ROOT, 'casefold');
  write(path.join(project, 'docs', 'plans', 'only.md'), '# Only\n');
  init([project], { planDirNames: ['docs/plans', 'Docs/Plans'] });
  const rows = plansMemory.getPlans().plans.filter(p => p.projectPath === project);
  assert.equal(rows.length, 1);
});

test('a folder with a PLAN.md is a bundle: only that file is a plan', () => {
  const project = path.join(ROOT, 'bundle-rule');
  const plans = path.join(project, 'docs', 'plans');
  write(path.join(plans, 'PLAN.md'), '# A top-level PLAN.md is one plan among others\n');
  write(path.join(plans, 'loose.md'));
  write(path.join(plans, '70-search', 'PLAN.md'), '# Search\n');
  write(path.join(plans, '70-search', 'notes.md'));
  write(path.join(plans, '70-search', 'research', 'sources.md'));
  write(path.join(plans, '71-lower', 'plan.md'), '# Lowercase marker\n');
  write(path.join(plans, '71-lower', 'README.md'));
  write(path.join(plans, 'drafts', 'one.md'));
  write(path.join(plans, 'drafts', 'two.md'));
  write(path.join(plans, 'drafts', '72-nested', 'PLAN.md'));
  write(path.join(plans, 'drafts', '72-nested', 'scratch.md'));

  const rels = plansMemory._walkPlanFiles(plans).map(f => f.relPath).sort();
  assert.deepEqual(rels, [
    '70-search/PLAN.md',
    '71-lower/plan.md',
    'PLAN.md',
    'drafts/72-nested/PLAN.md',
    'drafts/one.md',
    'drafts/two.md',
    'loose.md',
  ]);

  init([project]);
  const rows = plansMemory.getPlans().plans.filter(p => p.projectPath === project);
  assert.ok(!rows.some(p => /notes|sources|README|scratch/.test(p.filename)), 'bundle material is not a plan');
  assert.equal(rows.find(p => p.filename === '71-lower/plan.md').title, 'Lowercase marker');
});

test('a bundle with nothing but its PLAN.md keeps a configured directory from reading as empty', () => {
  const project = path.join(ROOT, 'unfulfilled-bundle');
  write(path.join(project, 'cli-plans', 'only', 'PLAN.md'));
  const backend = {
    id: 'test-backend', isProfile: false, status: 'ready',
    plansDir: ({ projectPath } = {}) => (projectPath ? path.join(projectPath, 'cli-plans') : null),
  };
  init([project], { backends: [backend] });
  assert.ok(!plansMemory._unfulfilledPlanDirs().some(u => u.projectPath === project));
});
