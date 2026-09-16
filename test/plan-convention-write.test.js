'use strict';
// The plan convention writes a file a CLI owns, so it writes it the way every other such write goes
// (CLAUDE.md rule 11, #441).
//
// WHY THIS EXISTS:
//   `planConventionApply` wrote `.claude/settings.json` with a bare `fs.writeFileSync`. It computed a
//   baseline in the preview — `before`, the file as it stood — and then threw it away, so a change made
//   between the dialog opening and the button being pressed was overwritten without a word. It also
//   wrote LF into a file that spelled its lines CRLF, which turns a one-key change into a diff of the
//   whole settings file for whoever commits it next.
//
//   Neither is visible from the tab: the write succeeds and the key is there. Only the file's owner,
//   later, sees what happened to the rest of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plansMemory = require('../src/app/plans-memory');
const claude = require('../src/backends/claude');

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-planconv-')));
test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

/** A registered project, and the module wired to the one backend that declares `planDirSetup`. */
function project(name) {
  const root = path.join(ROOT, name);
  fs.mkdirSync(root, { recursive: true });
  const states = new Map([[root, { registered: true, hidden: false, autoHidden: false }]]);
  plansMemory.init({
    backends: { list: () => [{ ...claude, status: 'ready' }] },
    db: { getProjectStates: () => states, getProjectDisplayNames: () => new Map() },
    log: { warn() {}, error() {}, info() {}, debug() {} },
    activeSessions: new Map(),
    dataDir: ROOT,
    effectiveSettings: () => ({}),
  });
  return root;
}

const settingsOf = (root) => path.join(root, '.claude', 'settings.local.json');

test('a settings file that spells its lines CRLF keeps them', () => {
  const root = project('crlf');
  fs.mkdirSync(path.dirname(settingsOf(root)), { recursive: true });
  fs.writeFileSync(settingsOf(root), '{\r\n  "model": "opus"\r\n}\r\n', 'utf8');

  const res = plansMemory.planConventionApply(root, { planDir: '.plans' });
  assert.equal(res.ok, true, res.error);

  const after = fs.readFileSync(settingsOf(root), 'utf8');
  assert.ok(!/(?<!\r)\n/.test(after), 'a CRLF file must not come back with LF lines');
  const parsed = JSON.parse(after);
  assert.equal(parsed.plansDirectory, '.plans');
  assert.equal(parsed.model, 'opus', 'everything already in the file is somebody else\'s and stays');
});

test('a change made after the preview was read is not overwritten', () => {
  const root = project('stale');
  fs.mkdirSync(path.dirname(settingsOf(root)), { recursive: true });
  fs.writeFileSync(settingsOf(root), '{}\n', 'utf8');

  // The preview the user is looking at, and then the file moving under it — the CLI itself rewrites this
  // file, so this is the ordinary case rather than a contrived one.
  const preview = plansMemory.planConventionPreview(root, { planDir: '.plans' });
  assert.equal(preview.writes.length, 1);
  fs.writeFileSync(settingsOf(root), '{ "env": { "KEY": "value" } }\n', 'utf8');

  // Apply recomputes the preview, so it reads the NEW baseline and the write goes through — what must
  // survive is the key the other writer added.
  const res = plansMemory.planConventionApply(root, { planDir: '.plans' });
  assert.equal(res.ok, true, res.error);
  const parsed = JSON.parse(fs.readFileSync(settingsOf(root), 'utf8'));
  assert.deepEqual(parsed.env, { KEY: 'value' }, 'the other writer\'s change must still be there');
  assert.equal(parsed.plansDirectory, '.plans');
});

test('a settings file that is not readable as JSON is refused, not replaced', () => {
  const root = project('broken');
  fs.mkdirSync(path.dirname(settingsOf(root)), { recursive: true });
  fs.writeFileSync(settingsOf(root), '{ "model": "opus",\n', 'utf8');

  const res = plansMemory.planConventionApply(root, { planDir: '.plans' });
  // The backend refuses a file it cannot parse, and with nothing left to write the run refuses too.
  assert.equal(res.ok, false, 'a file nobody could parse is not ours to replace');
  assert.equal(fs.readFileSync(settingsOf(root), 'utf8'), '{ "model": "opus",\n',
    'the half-written file is left exactly as it was');
  // …and it says WHY (#556). A refusal reported as "no installed CLI can be pointed at a plans directory"
  // sends the user looking for a missing feature instead of at the comma in their settings file.
  assert.match(res.error, /not readable as JSON/, res.error);
  assert.ok(!/No installed CLI/.test(res.error),
    'a backend that tried and refused is not the same answer as no backend offering at all');
});

test('a project with no settings file yet gets one', () => {
  const root = project('fresh');
  const res = plansMemory.planConventionApply(root, { planDir: 'docs/plans' });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.written, [settingsOf(root)]);
  assert.equal(JSON.parse(fs.readFileSync(settingsOf(root), 'utf8')).plansDirectory, 'docs/plans');
  assert.ok(fs.existsSync(path.join(root, 'docs', 'plans')), 'the directory the CLI writes into too');
});

test('no backend that can be pointed anywhere is a different answer from every backend refusing', () => {
  // The sentence the empty case has always carried is right for exactly one situation: nothing installed
  // declares the hook. It must not be borrowed for a backend that answered.
  const root = path.join(ROOT, 'nobody');
  fs.mkdirSync(root, { recursive: true });
  const states = new Map([[root, { registered: true, hidden: false, autoHidden: false }]]);
  plansMemory.init({
    backends: { list: () => [] },
    db: { getProjectStates: () => states, getProjectDisplayNames: () => new Map() },
    log: { warn() {}, error() {}, info() {}, debug() {} },
    activeSessions: new Map(),
    dataDir: ROOT,
    effectiveSettings: () => ({}),
  });

  const res = plansMemory.planConventionPreview(root, { planDir: '.plans' });
  assert.equal(res.ok, false);
  assert.match(res.error, /No installed CLI/);
});

test('a file that moved between the preview and the write is not overwritten', () => {
  // The property the baseline exists for, exercised through the public call. The recomputed preview makes
  // the real window microseconds wide, which is why this uses a backend whose `planDirSetup` writes to the
  // file after answering: that is exactly the shape of a CLI storing something of its own in the gap.
  //
  // Without the baseline the write lands and the other writer's line is gone — with it, the write is
  // refused and the file is what that writer left.
  const root = path.join(ROOT, 'moved');
  const file = path.join(root, 'settings.json');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, '{}\n', 'utf8');

  const theirs = '{ "written-by": "the CLI" }\n';
  const states = new Map([[root, { registered: true, hidden: false, autoHidden: false }]]);
  plansMemory.init({
    backends: {
      list: () => [{
        id: 'moving', label: 'Moving', status: 'ready',
        planDirSetup: ({ planDir }) => {
          const before = fs.readFileSync(file, 'utf8');
          // …and now somebody else writes, after we read and before we do.
          fs.writeFileSync(file, theirs, 'utf8');
          return { ok: true, file, before, after: JSON.stringify({ plansDirectory: planDir }, null, 2) + '\n' };
        },
      }],
    },
    db: { getProjectStates: () => states, getProjectDisplayNames: () => new Map() },
    log: { warn() {}, error() {}, info() {}, debug() {} },
    activeSessions: new Map(),
    dataDir: ROOT,
    effectiveSettings: () => ({}),
  });

  const res = plansMemory.planConventionApply(root, { planDir: '.plans' });

  assert.equal(res.ok, false, 'a file that moved under the preview is not ours to overwrite');
  assert.deepEqual(res.written, [], 'and nothing claims to have been written');
  assert.equal(fs.readFileSync(file, 'utf8'), theirs, "the other writer's file is exactly as they left it");
});

// `init` starts the plans-directory watch (#452), and it watches whatever plans store the backends it is
// given declare — including Claude's own, which is a real directory on the machine running this. An open
// `fs.watch` keeps the process alive, so the file has to hand it back: without this the run reports every
// test passing and then never exits, which the suite shows as a failing FILE with no failing test in it.
test.after(() => { try { plansMemory.stopWatchingPlansDirs(); } catch {} });

// #630 — the setup preview used to read `eff.planDir` itself and refuse a value that leaves the project,
// while the plan prompt beside it (through `convention-dirs.js`) fell back to `.plans` for the same
// setting. One of the two had to be wrong for every project that configured such a value.
//
// The split it settles is the one the handoff writer settled in #623: a SETTING nobody can use falls back
// silently, a directory the caller NAMED is refused, because they named that one.
test('a planDir setting that leaves the project falls back, as the plan prompt already says (#630)', () => {
  const root = project('escaping-setting');
  plansMemory.init({
    backends: { list: () => [{ ...claude, status: 'ready' }] },
    db: {
      getProjectStates: () => new Map([[root, { registered: true, hidden: false, autoHidden: false }]]),
      getProjectDisplayNames: () => new Map(),
    },
    log: { warn() {}, error() {}, info() {}, debug() {} },
    activeSessions: new Map(),
    dataDir: ROOT,
    effectiveSettings: () => ({ planDir: '../elsewhere' }),
  });

  const preview = plansMemory.planConventionPreview(root, {});
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.planDir, '.plans');
  assert.equal(preview.dir, path.join(root, '.plans'));
});

test('a directory the caller named is still refused when it leaves the project (#630)', () => {
  const root = project('picked-outside');
  const preview = plansMemory.planConventionPreview(root, { planDir: '../elsewhere' });
  assert.equal(preview.ok, false);
  assert.match(preview.error, /inside the project/);
});

// Strictly inside, so the project root is not a plans directory either — Claude refuses it, and a setting
// naming it is one nothing can use.
test('a planDir setting naming the project root falls back too (#630)', () => {
  const root = project('root-setting');
  plansMemory.init({
    backends: { list: () => [{ ...claude, status: 'ready' }] },
    db: {
      getProjectStates: () => new Map([[root, { registered: true, hidden: false, autoHidden: false }]]),
      getProjectDisplayNames: () => new Map(),
    },
    log: { warn() {}, error() {}, info() {}, debug() {} },
    activeSessions: new Map(),
    dataDir: ROOT,
    effectiveSettings: () => ({ planDir: '.' }),
  });

  const preview = plansMemory.planConventionPreview(root, {});
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.planDir, '.plans');
});
