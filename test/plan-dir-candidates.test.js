'use strict';
// #470 — the plan directories a project is searched in are a setting a PROJECT may override.
//
// WHY THIS EXISTS:
//   `planDirNames` had been in the cascade since the plans convention landed, and half of it was never
//   wired: the candidates were read once with `ctx.effectiveSettings(null)`, which is the global answer
//   whatever a project had configured. So an override could be saved and was then ignored by the only
//   code that reads it, while `planDir` beside it resolved per project correctly.
//
//   Nothing could see that. The Plans tab renders identically either way unless a project actually HAS a
//   directory the global list does not name — which is exactly the case this file builds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plansMemory = require('../src/app/plans-memory');

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plandirs-')));
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

function project(name, dirs) {
  const root = path.join(ROOT, name);
  for (const dir of dirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'a-plan.md'), '# A plan\n');
  }
  return root;
}

/**
 * Two registered projects and a settings cascade that answers per project.
 *
 * `overrides` is keyed by project path; anything not in it gets the global answer, which is what a
 * project with no override of its own must keep getting.
 */
function setup({ global: globalNames, overrides = {} } = {}) {
  const states = new Map();
  const add = (p) => states.set(p, { registered: true, hidden: false, autoHidden: false });
  for (const p of Object.keys(overrides)) add(p);
  return {
    addProject: add,
    init: (extraProjects = []) => {
      for (const p of extraProjects) add(p);
      plansMemory.init({
        backends: { list: () => [] },
        db: { getProjectStates: () => states, getProjectDisplayNames: () => new Map() },
        log: { warn() {}, error() {}, info() {} },
        activeSessions: new Map(),
        dataDir: ROOT,
        effectiveSettings: (projectPath) => ({
          planDirNames: (projectPath && overrides[projectPath]) || globalNames,
        }),
      });
    },
  };
}

test('a project override decides where that project is searched', () => {
  const custom = project('with-override', ['team-plans']);
  const plain = project('no-override', ['.plans']);
  const s = setup({ global: ['.plans'], overrides: { [custom]: ['team-plans'] } });
  s.init([plain]);

  const sources = plansMemory._projectPlanSources();
  const dirs = sources.map(x => x.dir);
  assert.ok(dirs.includes(path.join(custom, 'team-plans')),
    'the project said team-plans and has one — it must be found');
  assert.ok(dirs.includes(path.join(plain, '.plans')),
    'a project with no override of its own keeps the global list');
  assert.ok(!dirs.some(d => d.startsWith(plain + path.sep) && d.endsWith('team-plans')),
    "one project's override must not leak into another project");
});

test('the global list still applies when nothing overrides it', () => {
  const a = project('global-only', ['docs/plans']);
  const s = setup({ global: ['.plans', 'docs/plans'] });
  s.init([a]);
  assert.deepEqual(plansMemory._projectPlanSources().map(x => x.dir), [path.join(a, 'docs', 'plans')]);
});

test('an emptied list means the default, not "no directories"', () => {
  // The same rule the handoff list follows: a list that can be emptied is a setting that hides every
  // plan the project has.
  const s = setup({ global: [] });
  s.init();
  assert.deepEqual(plansMemory._planDirCandidates(null), ['.plans', 'docs/plans', 'plans', '.agent/plans']);
  assert.deepEqual(plansMemory._planDirCandidates('/nowhere'), ['.plans', 'docs/plans', 'plans', '.agent/plans']);
});

test('a blank entry is dropped rather than resolving to the project root', () => {
  const s = setup({ global: ['  ', 'plans', ''] });
  s.init();
  assert.deepEqual(plansMemory._planDirCandidates(null), ['plans']);
});
