'use strict';
// projects.js — the project-management logic that lived in main.js and could therefore not be tested
// (#170). These are its first tests. Nothing here mocks the logic; it runs the real module against a
// fake context — an in-memory settings blob, an in-memory db, and a real temp store on disk.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projects = require('../projects');
const { encodeProjectPath } = require('../encode-project-path');

// A context in the shape main.js hands over. Everything is observable: what was written, what was
// refreshed, what was deleted.
function makeCtx({ autoHideDays = 0, global: initialGlobal = {} } = {}) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-store-'));
  const settings = new Map([['global', { autoHideDays, ...initialGlobal }]]);
  const meta = new Map();          // projectPath -> { autoHideResetAt, autoHidden }
  const autoHidden = new Set();
  const calls = { refreshed: [], deletedFolders: [], deletedSearch: [], notified: 0, favorites: new Map() };
  let adminRows = [];

  const ctx = {
    PROJECTS_DIR: store,
    activeSessions: new Map(),
    log: { info() {}, warn() {}, error() {} },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    db: {
      getSetting: (k) => settings.get(k),
      setSetting: (k, v) => settings.set(k, v),
      deleteSetting: (k) => settings.delete(k),
      deleteCachedFolder: (folder, scope) => calls.deletedFolders.push({ folder, scope }),
      deleteSearchFolder: (folder, scope) => calls.deletedSearch.push({ folder, scope }),
      getProjectMeta: (p) => meta.get(p) || null,
      setProjectAutoHidden: (p, on) => { if (on) autoHidden.add(p); else autoHidden.delete(p); },
      resetProjectAutoHide: (p) => { meta.set(p, { autoHideResetAt: new Date().toISOString() }); autoHidden.delete(p); },
      getAutoHiddenProjects: () => autoHidden,
      renameProjectRefs: () => {},
      deleteProjectRefs: (p) => { meta.delete(p); },
      setFolderMeta: () => {},
      toggleProjectFavorite: (p) => {
        const next = !calls.favorites.get(p);
        calls.favorites.set(p, next);
        return next;
      },
    },
    cache: {
      refreshFolder: (folder) => calls.refreshed.push(folder),
      buildProjectsFromCache: () => adminRows.map(r => ({ projectPath: r.projectPath })),
      buildProjectsAdmin: () => adminRows,
      // The real rule (session-cache.js): no activity at all is stale BY DEFINITION.
      shouldAutoHide: (effMs, now, days) => (now - effMs) > days * 86400000,
      claudeStoreScope: () => ({ except: ['codex', 'hermes', 'pi'] }),
      notifyRendererProjectsChanged: () => { calls.notified++; },
    },
  };

  projects.init(ctx);
  projects._resetAutoHideThrottle();
  return {
    ctx, store, calls, autoHidden, meta,
    settings: () => settings.get('global'),
    setAdminRows: (rows) => { adminRows = rows; },
    cleanup: () => fs.rmSync(store, { recursive: true, force: true }),
  };
}

// --- add / remove / unhide -------------------------------------------------------------------------

test('addProject seeds a store folder so the project can be derived at all', () => {
  const t = makeCtx();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try {
    const res = projects.addProject(dir);
    assert.strictEqual(res.ok, true);

    // A project with no transcript cannot be derived (derive-project-path reads the cwd out of one), so
    // adding one writes a seed line. Without it the project would be invisible — which is exactly the
    // hole #167 is about.
    const folder = path.join(t.store, encodeProjectPath(dir));
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.jsonl'));
    assert.strictEqual(files.length, 1, 'a seed transcript is written');
    const seed = JSON.parse(fs.readFileSync(path.join(folder, files[0]), 'utf8').trim());
    assert.strictEqual(seed.cwd, dir, 'and it carries the cwd, which is what makes the project derivable');

    assert.deepStrictEqual(t.settings().addedProjects, [dir], 'an explicit add reaches the allowlist');
    assert.deepStrictEqual(t.calls.refreshed, [encodeProjectPath(dir)], 'and the folder is indexed at once');
  } finally { t.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('addProject refuses a file, and unhides a project that was hidden', () => {
  const t = makeCtx({ global: { hiddenProjects: ['D:\\hidden'] } });
  const file = path.join(t.store, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');
  try {
    assert.match(projects.addProject(file).error, /not a directory/i);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    // Re-adding a hidden project must bring it back — otherwise "add" silently does nothing.
    const t2 = makeCtx({ global: { hiddenProjects: [dir] } });
    projects.addProject(dir);
    assert.deepStrictEqual(t2.settings().hiddenProjects, [], 'adding a hidden project unhides it');
    t2.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

test('removeProject hides, drops the allowlist entry, and scopes its deletes to Claude', () => {
  const t = makeCtx({ global: { hiddenProjects: [], addedProjects: ['D:\\a', 'D:\\b'] } });
  try {
    const res = projects.removeProject('D:\\a');
    assert.strictEqual(res.ok, true);

    assert.deepStrictEqual(t.settings().hiddenProjects, ['D:\\a']);
    assert.deepStrictEqual(t.settings().addedProjects, ['D:\\b'], 'gone from the allowlist too');

    // The folder key is shared with the other backends (it is derived from the cwd), so an unscoped
    // delete would take a project's Codex rows with it — rows whose files are still on disk.
    const folder = encodeProjectPath('D:\\a');
    assert.deepStrictEqual(t.calls.deletedFolders, [{ folder, scope: { except: ['codex', 'hermes', 'pi'] } }]);
    assert.deepStrictEqual(t.calls.deletedSearch, [{ folder, scope: { except: ['codex', 'hermes', 'pi'] } }]);
  } finally { t.cleanup(); }
});

test('unhideProject clears the auto-hide flag, or the next pass hides it straight back', () => {
  const t = makeCtx({ global: { hiddenProjects: ['D:\\a'] } });
  try {
    t.autoHidden.add('D:\\a');
    projects.unhideProject('D:\\a');

    assert.deepStrictEqual(t.settings().hiddenProjects, []);
    assert.strictEqual(t.autoHidden.has('D:\\a'), false, 'the auto flag is cleared (#57)');
    assert.ok(t.meta.get('D:\\a').autoHideResetAt, 'and the grace timer restarts');
    assert.deepStrictEqual(t.calls.refreshed, [encodeProjectPath('D:\\a')], 're-indexed so it reappears');
  } finally { t.cleanup(); }
});

test('getHiddenProjects flags which ones auto-hide did', () => {
  const t = makeCtx({ global: { hiddenProjects: ['D:\\manual', 'D:\\auto'] } });
  try {
    t.autoHidden.add('D:\\auto');
    assert.deepStrictEqual(projects.getHiddenProjects(), [
      { path: 'D:\\manual', autoHidden: false },
      { path: 'D:\\auto', autoHidden: true },
    ]);
  } finally { t.cleanup(); }
});

// --- the allowlist ---------------------------------------------------------------------------------

test('ensureProjectAdded is idempotent and restarts the auto-hide grace timer', () => {
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\x');
    projects.ensureProjectAdded('D:\\x');
    assert.deepStrictEqual(t.settings().addedProjects, ['D:\\x'], 'listed once, not twice');
    // #57: a just-added project must not be auto-hidden on the very next pass for being "stale".
    assert.ok(t.meta.get('D:\\x').autoHideResetAt);
  } finally { t.cleanup(); }
});

test('switching to manual mode freezes the visible projects into the allowlist', () => {
  const t = makeCtx();
  try {
    t.setAdminRows([{ projectPath: 'D:\\a' }, { projectPath: 'D:\\b' }]);
    projects.setProjectAutoAdd(false);

    assert.strictEqual(t.settings().projectAutoAdd, false);
    assert.deepStrictEqual(t.settings().addedProjects, ['D:\\a', 'D:\\b'],
      'nothing may disappear the moment the switch is flipped');

    // Turning it back on ignores the allowlist entirely (everything is discovered again).
    projects.setProjectAutoAdd(true);
    assert.strictEqual(t.settings().projectAutoAdd, true);
  } finally { t.cleanup(); }
});

// --- auto-hide (#57) -------------------------------------------------------------------------------

test('auto-hide is off when autoHideDays is 0, however stale a project is', () => {
  const t = makeCtx({ autoHideDays: 0 });
  try {
    t.setAdminRows([{ projectPath: 'D:\\ancient', lastActivity: '2020-01-01T00:00:00.000Z' }]);
    projects.applyAutoHide(true);
    assert.deepStrictEqual(t.settings().hiddenProjects, undefined, 'nothing is hidden');
  } finally { t.cleanup(); }
});

test('auto-hide hides a stale project and leaves a fresh one alone', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([
      { projectPath: 'D:\\stale', lastActivity: new Date(Date.now() - 60 * 86400000).toISOString() },
      { projectPath: 'D:\\fresh', lastActivity: new Date(Date.now() - 1 * 86400000).toISOString() },
    ]);
    projects.applyAutoHide(true);

    assert.deepStrictEqual(t.settings().hiddenProjects, ['D:\\stale']);
    assert.strictEqual(t.autoHidden.has('D:\\stale'), true, 'flagged as auto, so the restore UI can say so');
  } finally { t.cleanup(); }
});

test('auto-hide never touches a project with a running session', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    // Ancient by every measure — but somebody is working in it right now.
    t.setAdminRows([{ projectPath: 'D:\\live', lastActivity: '2020-01-01T00:00:00.000Z' }]);
    t.ctx.activeSessions.set('s1', { exited: false, projectPath: 'D:\\live' });

    projects.applyAutoHide(true);
    assert.deepStrictEqual(t.settings().hiddenProjects, undefined, 'a live session is activity');

    // ...and an EXITED session is not.
    t.ctx.activeSessions.set('s1', { exited: true, projectPath: 'D:\\live' });
    projects._resetAutoHideThrottle();
    projects.applyAutoHide(true);
    assert.deepStrictEqual(t.settings().hiddenProjects, ['D:\\live']);
  } finally { t.cleanup(); }
});

test('auto-hide respects the grace timer, not just the last session', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    // Its sessions are ancient, but it was added/unhidden yesterday — the grace timer is what counts,
    // otherwise re-adding a stale project would hide it again immediately (#57).
    t.setAdminRows([{ projectPath: 'D:\\readded', lastActivity: '2020-01-01T00:00:00.000Z' }]);
    t.meta.set('D:\\readded', { autoHideResetAt: new Date(Date.now() - 86400000).toISOString() });

    projects.applyAutoHide(true);
    assert.deepStrictEqual(t.settings().hiddenProjects, undefined, 'the reset stamp wins over old sessions');
  } finally { t.cleanup(); }
});

test('auto-hide is throttled — an unforced pass right after another does nothing', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([{ projectPath: 'D:\\a', lastActivity: '2020-01-01T00:00:00.000Z' }]);
    projects.applyAutoHide(true);
    assert.deepStrictEqual(t.settings().hiddenProjects, ['D:\\a']);

    // A second stale project appears, but the throttle window has not passed: an unforced pass is a no-op.
    t.setAdminRows([
      { projectPath: 'D:\\a', lastActivity: '2020-01-01T00:00:00.000Z' },
      { projectPath: 'D:\\b', lastActivity: '2020-01-01T00:00:00.000Z' },
    ]);
    projects.applyAutoHide();
    assert.deepStrictEqual(t.settings().hiddenProjects, ['D:\\a'], 'throttled');

    projects.applyAutoHide(true);
    assert.deepStrictEqual(t.settings().hiddenProjects, ['D:\\a', 'D:\\b'], 'forced runs anyway');
  } finally { t.cleanup(); }
});

// --- remap ------------------------------------------------------------------------------------------

test('remapProject rewrites the cwd in every transcript, and moves the project state with it', () => {
  const t = makeCtx({ global: { hiddenProjects: ['D:\\old'], addedProjects: ['D:\\old', 'D:\\keep'] } });
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-'));
  try {
    const oldPath = 'D:\\old';
    const folder = encodeProjectPath(oldPath);
    const folderPath = path.join(t.store, folder);
    fs.mkdirSync(folderPath, { recursive: true });

    // Two sessions, and a line that is NOT this project's (it must be left alone).
    fs.writeFileSync(path.join(folderPath, 'a.jsonl'),
      JSON.stringify({ type: 'user', cwd: oldPath, message: { role: 'user', content: 'one' } }) + '\n' +
      JSON.stringify({ type: 'assistant', cwd: oldPath, message: { role: 'assistant', content: 'two' } }) + '\n');
    fs.writeFileSync(path.join(folderPath, 'b.jsonl'),
      JSON.stringify({ type: 'user', cwd: 'D:\\somewhere-else', message: { role: 'user', content: 'not mine' } }) + '\n');

    const res = projects.remapProject(oldPath, newDir);
    assert.strictEqual(res.ok, true);

    const a = fs.readFileSync(path.join(folderPath, 'a.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(a.map(l => l.cwd), [newDir, newDir], 'every line of the session moves');

    const b = JSON.parse(fs.readFileSync(path.join(folderPath, 'b.jsonl'), 'utf8').trim());
    assert.strictEqual(b.cwd, 'D:\\somewhere-else', 'a line belonging to another cwd is untouched');

    // The folder memo must be re-pointed BEFORE the refresh, or the folder keeps resolving to the old
    // path (folderProjectPath short-circuits while the old directory still exists) and the project
    // vanishes from the sidebar.
    assert.deepStrictEqual(t.calls.refreshed, [folder], 'and the folder is re-indexed');

    // The user's own lists follow the rename — otherwise a remapped project silently un-hides itself.
    assert.deepStrictEqual(t.settings().hiddenProjects, [newDir]);
    assert.deepStrictEqual(t.settings().addedProjects, [newDir, 'D:\\keep']);
  } finally { t.cleanup(); fs.rmSync(newDir, { recursive: true, force: true }); }
});

test('remapProject refuses a target that is not a directory, and a project it cannot find', () => {
  const t = makeCtx();
  try {
    const file = path.join(t.store, 'a-file');
    fs.writeFileSync(file, 'x');
    assert.match(projects.remapProject('D:\\old', file).error, /not a directory/i);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap2-'));
    // A project with no store folder at all. NOTE: this is exactly the case #171 has to fix — a project
    // whose sessions are Codex' rather than Claude's is refused here, because only Claude's store is
    // consulted.
    assert.match(projects.remapProject('D:\\never-seen', dir).error, /No session data/i);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

// --- prune (#55) -----------------------------------------------------------------------------------

test('pruneProjectIfGone keeps a project that still has sessions on disk', () => {
  const t = makeCtx();
  try {
    const p = 'D:\\keeper';
    const folder = path.join(t.store, encodeProjectPath(p));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 's.jsonl'), JSON.stringify({ type: 'user', cwd: p }) + '\n');

    assert.strictEqual(projects.projectHasSessionsOnDisk(p), true);
    assert.strictEqual(projects.pruneProjectIfGone(p), false, 'still restorable — do not forget it');
  } finally { t.cleanup(); }
});

test('pruneProjectIfGone forgets a project with nothing left to restore', () => {
  const t = makeCtx({ global: { hiddenProjects: ['D:\\gone'], addedProjects: ['D:\\gone', 'D:\\other'] } });
  try {
    t.meta.set('D:\\gone', { autoHideResetAt: 'x' });

    assert.strictEqual(projects.projectHasSessionsOnDisk('D:\\gone'), false);
    assert.strictEqual(projects.pruneProjectIfGone('D:\\gone'), true);

    assert.strictEqual(t.meta.has('D:\\gone'), false, 'its per-project row goes');
    assert.deepStrictEqual(t.settings().hiddenProjects, [], 'and it leaves both global lists');
    assert.deepStrictEqual(t.settings().addedProjects, ['D:\\other'], 'without taking the neighbours');
  } finally { t.cleanup(); }
});

// --- misc -----------------------------------------------------------------------------------------

test('toggleFavorite reports the state it just set', () => {
  const t = makeCtx();
  try {
    assert.deepStrictEqual(projects.toggleFavorite('D:\\a'), { favorited: true });
    assert.deepStrictEqual(projects.toggleFavorite('D:\\a'), { favorited: false });
  } finally { t.cleanup(); }
});

test('browseFolder returns null when the dialog is cancelled', async () => {
  const t = makeCtx();
  try {
    assert.strictEqual(await projects.browseFolder(), null);
  } finally { t.cleanup(); }
});
