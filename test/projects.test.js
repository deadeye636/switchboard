'use strict';
// projects.js — the project-management logic that lived in main.js and could therefore not be tested
// (#170). These are its first tests. Nothing here mocks the logic; it runs the real module against a
// fake context — an in-memory settings blob, an in-memory db, and a real temp store on disk.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projects = require('../src/projects/projects');
const backends = require('../src/backends');
const { encodeProjectPath } = require('../src/session/encode-project-path');

// A context in the shape main.js hands over. Everything is observable: what was written, what was
// refreshed, what was deleted.
function makeCtx({ autoHideDays = 0, global: initialGlobal = {} } = {}) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-store-'));
  const settings = new Map([['global', { autoHideDays, ...initialGlobal }]]);
  const autoHidden = new Set();
  // ONE store, because there is one table: project_meta holds the favourite, the auto-hide timer AND the
  // register (#167). Two maps here would let a test pass while the real code read a column the other map
  // had written — the fake would be lying about the shape of the thing it stands in for.
  const states = new Map();        // projectPath -> the project_meta row
  // What the scan SAW in the stores: projectPath -> newest session. A Set would have been a lie by
  // omission — without the timestamp, a new session in a removed project cannot be told from an old one,
  // and "removed" silently becomes "banned for good".
  const storePaths = new Map();
  const folderMeta = new Map();    // folder -> { projectPath } — a project can own several (legacy encodings)
  const calls = {
    refreshed: [], deletedFolders: [], deletedSearch: [], notified: 0, favorites: new Map(),
    deletedSessions: [], deletedSearchSessions: [], prunedProjects: [],
  };
  let adminRows = [];
  let cachedRows = [];             // session_cache rows for the project being remapped (#171)

  const ctx = {
    PROJECTS_DIR: store,
    activeSessions: new Map(),
    log: { info() {}, warn() {}, error() {} },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    // The REAL registry: remap and trust are backend business (#171), and a fake one would only prove
    // that the fake works.
    backends,
    db: {
      getCachedByProjectPath: (p) => cachedRows.filter(r => r.projectPath === p),
      getBackendsByProjectPath: () => new Map(),
      // Discovery reads the rows straight (one pass), not through buildProjectsAdmin — that one also
      // readdirs the store and stats every project, on every sidebar render.
      getAllCached: () => cachedRows.map(r => ({ ...r })),
      getAllFolderMeta: () => folderMeta,
      getSetting: (k) => settings.get(k),
      setSetting: (k, v) => settings.set(k, v),
      deleteSetting: (k) => settings.delete(k),
      deleteCachedFolder: (folder, scope) => calls.deletedFolders.push({ folder, scope }),
      deleteSearchFolder: (folder, scope) => calls.deletedSearch.push({ folder, scope }),
      // The row really goes, so a later getCachedByProjectPath tells the truth — the prune decides on it.
      deleteCachedSession: (sid) => {
        calls.deletedSessions.push(sid);
        cachedRows = cachedRows.filter(r => r.sessionId !== sid);
      },
      deleteSearchSession: (sid) => calls.deletedSearchSessions.push(sid),
      getProjectMeta: (p) => states.get(p) || null,
      setProjectAutoHidden: (p, on) => {
        if (on) autoHidden.add(p); else autoHidden.delete(p);
        states.set(p, { ...(states.get(p) || {}), autoHidden: on ? 1 : 0 });
      },
      resetProjectAutoHide: (p) => {
        autoHidden.delete(p);
        states.set(p, { ...(states.get(p) || {}), autoHidden: 0, autoHideResetAt: new Date().toISOString() });
      },
      getAutoHiddenProjects: () => autoHidden,
      // Only the keys given are written — "not mentioned" is not "set to null", or registering a project
      // would wipe its favourite.
      setProjectState: (p, patch) => {
        const next = { ...(states.get(p) || {}), ...patch };
        states.set(p, next);
        if (next.autoHidden) autoHidden.add(p); else autoHidden.delete(p);
      },
      getProjectStates: () => new Map(states),
      getProjectTombstones: () => {
        const out = new Map();
        for (const [p, s] of states) if (s.removedAt) out.set(p, s.removedAt);
        return out;
      },
      renameProjectRefs: () => {},
      // This is what the prune calls — it takes the project's tags, handoffs and favourites with it.
      deleteProjectRefs: (p) => { calls.prunedProjects.push(p); states.delete(p); autoHidden.delete(p); },
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
      getStoreProjectPaths: () => storePaths,
    },
  };

  projects.init(ctx);
  projects._resetAutoHideThrottle();
  return {
    ctx, store, calls, autoHidden, states,
    settings: () => settings.get('global'),
    setAdminRows: (rows) => { adminRows = rows; },
    setCachedRows: (rows) => { cachedRows = rows; },
    setFolderMeta: (folder, projectPath) => { folderMeta.set(folder, { folder, projectPath }); },
    // `[path, newestSessionIso]` pairs, or a bare path when the time does not matter to the test.
    setStorePaths: (paths) => {
      storePaths.clear();
      for (const p of paths) {
        if (Array.isArray(p)) storePaths.set(p[0], p[1]);
        else storePaths.set(p, null);
      }
    },
    state: (p) => states.get(p) || null,
    cleanup: () => fs.rmSync(store, { recursive: true, force: true }),
  };
}

// --- add / remove / unhide -------------------------------------------------------------------------

test('addProject puts the project ON THE LIST — and forges no session to do it', () => {
  const t = makeCtx();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try {
    const res = projects.addProject(dir);
    assert.strictEqual(res.ok, true);

    const state = t.state(dir);
    assert.strictEqual(state.registered, 1, 'it is on the register — that is what makes it exist (#167)');
    assert.ok(state.registeredAt, 'and when');

    // It used to create the store folder and write a FAKE transcript into it ("New project", a session
    // that never happened), because a project the app could not DERIVE from a transcript could not exist.
    assert.strictEqual(fs.existsSync(path.join(t.store, encodeProjectPath(dir))), false,
      'no store folder is conjured up');
  } finally { t.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('addProject refuses a file, and brings back a project that was removed', () => {
  const t = makeCtx();
  const file = path.join(t.store, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try {
    assert.match(projects.addProject(file).error, /not a directory/i);

    projects.addProject(dir);
    projects.removeProject(dir);
    assert.strictEqual(t.state(dir).registered, 0);
    assert.ok(t.state(dir).removedAt, 'a tombstone');

    // Adding it again is an explicit act: it goes back on the list, VISIBLE, and the tombstone is buried
    // — otherwise the old sessions on disk would be ignored forever and the project would stay empty.
    projects.addProject(dir);
    assert.strictEqual(t.state(dir).registered, 1);
    assert.strictEqual(t.state(dir).hidden, 0);
    assert.strictEqual(t.state(dir).removedAt, null, 'the tombstone is buried');
  } finally { t.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hide keeps the project on the list; remove takes it off and tombstones it', () => {
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\a');
    // Two backends in the same project. "Remove from Switchboard" must clear BOTH — a removal that leaves
    // the Codex rows in the cache, the search index and the stats has removed a sidebar row, not a project.
    t.setCachedRows([
      { sessionId: 'c1', folder: encodeProjectPath('D:\\a'), projectPath: 'D:\\a', backendId: 'claude' },
      { sessionId: 'x1', folder: encodeProjectPath('D:\\a'), projectPath: 'D:\\a', backendId: 'codex' },
    ]);

    projects.hideProject('D:\\a');
    assert.strictEqual(t.state('D:\\a').registered, 1, 'hiding does not remove it');
    assert.strictEqual(t.state('D:\\a').hidden, 1);
    assert.deepStrictEqual(t.calls.deletedFolders, [], 'and it does not purge anything — unhide must be instant');

    projects.removeProject('D:\\a');
    assert.strictEqual(t.state('D:\\a').registered, 0, 'removing takes it off the list');
    assert.ok(t.state('D:\\a').removedAt, 'and remembers when, or the next scan would put it straight back');
    assert.strictEqual(t.state('D:\\a').hidden, 0,
      'the hide flag goes: it qualifies a LISTED project, and this one is not on the list any more');

    // EVERY backend's rows, and ROW BY ROW. Not by folder: a store folder is keyed on the cwd a session
    // started from, so since #157 it can hold rows of other projects, and clearing by folder would drop
    // those while their transcripts sat on disk. And not Claude-only: a removal that leaves the Codex rows
    // behind has removed a sidebar row, not a project — search would still find them.
    assert.deepStrictEqual(t.calls.deletedSessions, ['c1', 'x1']);
    assert.deepStrictEqual(t.calls.deletedSearchSessions, ['c1', 'x1']);
    assert.deepStrictEqual(t.calls.deletedFolders, [], 'and no folder-wide delete anywhere');
  } finally { t.cleanup(); }
});

test('unhideProject clears BOTH hide flags, or the next pass hides it straight back', () => {
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\a');
    projects.hideProject('D:\\a');
    t.autoHidden.add('D:\\a');

    projects.unhideProject('D:\\a');

    assert.strictEqual(t.state('D:\\a').hidden, 0);
    assert.strictEqual(t.autoHidden.has('D:\\a'), false, 'the auto flag too (#57)');
    assert.ok(t.state('D:\\a').autoHideResetAt, 'and the grace timer restarts');
    assert.deepStrictEqual(t.calls.refreshed, [encodeProjectPath('D:\\a')], 're-indexed so it reappears');
  } finally { t.cleanup(); }
});

test('getHiddenProjects lists what is on the list but unseen, and says which one staleness did', () => {
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\manual');
    projects.ensureProjectAdded('D:\\auto');
    projects.ensureProjectAdded('D:\\shown');
    projects.hideProject('D:\\manual');
    t.ctx.db.setProjectAutoHidden('D:\\auto', 1);

    assert.deepStrictEqual(projects.getHiddenProjects(), [
      { path: 'D:\\manual', autoHidden: false },
      { path: 'D:\\auto', autoHidden: true },
    ], 'a shown project is not in the hidden list, and a removed one is not either');
  } finally { t.cleanup(); }
});

// --- the register ----------------------------------------------------------------------------------

test('ensureProjectAdded registers, is idempotent, and restarts the auto-hide grace timer', () => {
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\x');
    const first = t.state('D:\\x').registeredAt;
    projects.ensureProjectAdded('D:\\x');

    assert.strictEqual(t.state('D:\\x').registered, 1);
    assert.ok(first, 'registered once, with a timestamp');
    // #57: a just-added project must not be auto-hidden on the very next pass for being "stale".
    assert.ok(t.state('D:\\x').autoHideResetAt);
  } finally { t.cleanup(); }
});

test('switching to manual mode changes WHO writes to the list, not the list', () => {
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\a');
    projects.ensureProjectAdded('D:\\b');

    projects.setProjectAutoAdd(false);
    assert.strictEqual(t.settings().projectAutoAdd, false);
    // It used to SNAPSHOT the visible projects into an allowlist, because manual mode was a filter over a
    // derivation and without the snapshot the sidebar went blank. The list is the list now.
    assert.strictEqual(t.settings().addedProjects, undefined, 'no allowlist is frozen any more');
    assert.strictEqual(t.state('D:\\a').registered, 1, 'and nothing falls off the list');
    assert.strictEqual(t.state('D:\\b').registered, 1);

    projects.setProjectAutoAdd(true);
    assert.strictEqual(t.settings().projectAutoAdd, true);
  } finally { t.cleanup(); }
});

test('discovery registers a project it finds a session in — in auto mode only', () => {
  const t = makeCtx();
  try {
    t.setCachedRows([{ sessionId: 's1', projectPath: 'D:\\found', modified: '2026-07-01T00:00:00.000Z' }]);

    // Manual mode: nobody but the user writes to the list.
    projects.setProjectAutoAdd(false);
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\found'), null, 'manual mode: discovery may not add it');

    projects.setProjectAutoAdd(true);
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\found').registered, 1, 'auto mode: it goes on the list');
  } finally { t.cleanup(); }
});

test('discovery does NOT resurrect a removed project from the sessions it left behind', () => {
  // The whole reason "remove" was never implemented: the transcripts stay on disk, so the very next scan
  // would find them and put the project straight back. Only a session NEWER than the removal counts.
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\gone');
    projects.removeProject('D:\\gone');
    const removedAt = t.state('D:\\gone').removedAt;

    const older = new Date(new Date(removedAt).getTime() - 60_000).toISOString();
    t.setCachedRows([{ sessionId: 'o1', projectPath: 'D:\\gone', modified: older }]);
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\gone').registered, 0, 'the old sessions do not bring it back');

    const newer = new Date(new Date(removedAt).getTime() + 60_000).toISOString();
    t.setCachedRows([{ sessionId: 'n1', projectPath: 'D:\\gone', modified: newer }]);
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\gone').registered, 1, 'a session that happened AFTER it does');
    assert.strictEqual(t.state('D:\\gone').removedAt, null, 'and the tombstone is buried');
  } finally { t.cleanup(); }
});

test('a NEW session in a removed project brings it back — the scan sees it, the cache never would', () => {
  // The bug this test exists for: a removed project is deliberately not indexed, so a new session in it
  // produces NO cached row. Discovery that only looks at the cache therefore never hears about it, and
  // "removed" quietly means "banned for good" — the project can never come back, whatever you do in it.
  // Found by starting a session in a removed project in the running app; every unit test was green.
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\p');
    projects.removeProject('D:\\p');
    const removedAt = t.state('D:\\p').removedAt;

    // The scan sees the store — no cached rows, because it does not index a removed project.
    t.setCachedRows([]);

    const older = new Date(new Date(removedAt).getTime() - 60_000).toISOString();
    t.setStorePaths([['D:\\p', older]]);
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\p').registered, 0, 'the transcripts it left behind do not bring it back');

    const newer = new Date(new Date(removedAt).getTime() + 60_000).toISOString();
    t.setStorePaths([['D:\\p', newer]]);
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\p').registered, 1, 'but a session that happened AFTER the removal does');
    assert.strictEqual(t.state('D:\\p').removedAt, null);

    // ...and it comes back with its sessions. While it was removed the scan skipped its folder and
    // stamped the mtime memo as up to date on the way past, so nothing would ever have indexed it again:
    // the project would sit in the sidebar EMPTY, its transcripts on disk, with no way to bring them in.
    assert.deepStrictEqual(t.calls.refreshed, [encodeProjectPath('D:\\p')], 'its folder is indexed at once');
  } finally { t.cleanup(); }
});

test('hiding a project that is not on the list is refused, not written invisibly', () => {
  // The silent swallow, one door further along. `hidden` qualifies a LISTED project; setting it on one
  // that is not on the list writes a flag nothing shows and nothing can clear — and the day discovery
  // registers that project, it arrives already hidden, for a reason nobody can see.
  const t = makeCtx();
  try {
    const res = projects.hideProject('D:\\not-listed');
    assert.match(res.error, /not on the list/i);
    assert.strictEqual(t.state('D:\\not-listed'), null, 'and nothing is written');

    // Same after a removal — a hide must not re-arm what the removal just cleared.
    projects.ensureProjectAdded('D:\\p');
    projects.removeProject('D:\\p');
    assert.match(projects.hideProject('D:\\p').error, /not on the list/i);
    assert.strictEqual(t.state('D:\\p').hidden, 0);
  } finally { t.cleanup(); }
});

test('re-adding indexes EVERY store folder of the project, not just the canonical one', () => {
  // Claude's folder-name encoding has changed over time, so one project can own several store folders.
  // While it was removed, each of those had its mtime memo stamped up to date on the way past — so
  // refreshing only the canonical name leaves the others skipped by the reconcile gate, their sessions
  // gone from the cache and their files on disk, until something happens to touch them.
  const t = makeCtx();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-multi-'));
  try {
    t.setFolderMeta('legacy-encoding-of-the-same-project', dir);

    projects.addProject(dir);

    assert.deepStrictEqual(
      [...t.calls.refreshed].sort(),
      [encodeProjectPath(dir), 'legacy-encoding-of-the-same-project'].sort(),
      'both folders are indexed'
    );
  } finally { t.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a tombstone is not missed because Windows spells the path differently', () => {
  // A real store carries the same directory in two casings (#157). A tombstone looked up under the wrong
  // spelling is a tombstone that is not there — and a missed tombstone means a resurrected project.
  if (process.platform !== 'win32') return;
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\Projekte\\Thing');
    projects.removeProject('D:\\Projekte\\Thing');
    const removedAt = t.state('D:\\Projekte\\Thing').removedAt;

    const older = new Date(new Date(removedAt).getTime() - 60_000).toISOString();
    t.setStorePaths([['d:\\projekte\\thing', older]]);     // the same directory, as Codex spelled it
    projects.syncRegistry();

    assert.strictEqual(t.state('d:\\projekte\\thing'), null, 'the other spelling is not registered behind its back');
    assert.strictEqual(t.state('D:\\Projekte\\Thing').registered, 0, 'and the removal holds');
  } finally { t.cleanup(); }
});

test('the tombstone sweep is blind to nothing: a transcript on disk keeps the removal alive', () => {
  // The trap. A removed project is deliberately NOT indexed, so the CACHE is empty for it by
  // construction. Believe the cache and the sweep drops the tombstone on the next pass — and the scan
  // after that resurrects the project from the very transcripts the removal was meant to forget.
  const t = makeCtx();
  const ancient = new Date(Date.now() - 400 * 86400000).toISOString();
  try {
    projects.ensureProjectAdded('D:\\old');
    projects.removeProject('D:\\old');
    t.ctx.db.setProjectState('D:\\old', { removedAt: ancient });   // long past any grace period
    t.setCachedRows([]);                                           // no cached rows: it is not indexed

    t.setStorePaths(['D:\\old']);                                  // ...but the scan still SEES it on disk
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\old').removedAt, ancient, 'the tombstone stays while a session exists');

    t.setStorePaths([]);                                           // now the transcripts are really gone
    projects.syncRegistry();
    assert.strictEqual(t.state('D:\\old').removedAt, null,
      'with nothing left to guard, the tombstone is swept — a NEW session there should register it again');
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
      { projectPath: 'D:\\stale', registered: true, lastActivity: new Date(Date.now() - 60 * 86400000).toISOString() },
      { projectPath: 'D:\\fresh', registered: true, lastActivity: new Date(Date.now() - 1 * 86400000).toISOString() },
    ]);
    projects.applyAutoHide(true);

    // ONLY the flag. It used to also push the path onto `hiddenProjects` — the same list a manual hide
    // wrote to — which made the two states one, and an auto-hidden project could then never come back by
    // itself on activity, the one thing that tells it apart from a hide (#167).
    assert.strictEqual(t.autoHidden.has('D:\\stale'), true);
    assert.strictEqual(t.state('D:\\stale').autoHidden, 1);
    assert.strictEqual(t.state('D:\\stale').hidden, undefined, 'it is not HIDDEN — it is auto-hidden');
    assert.strictEqual(t.autoHidden.has('D:\\fresh'), false);
  } finally { t.cleanup(); }
});

test('auto-hide passes over a project that is not on the list at all', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([
      { projectPath: 'D:\\unlisted', registered: false, lastActivity: new Date(Date.now() - 60 * 86400000).toISOString() },
    ]);
    projects.applyAutoHide(true);
    assert.strictEqual(t.autoHidden.has('D:\\unlisted'), false, 'nothing to hide — it is not shown anyway');
  } finally { t.cleanup(); }
});

test('auto-hide never touches a project with a running session', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    // Ancient by every measure — but somebody is working in it right now.
    t.setAdminRows([{ projectPath: 'D:\\live', registered: true, lastActivity: '2020-01-01T00:00:00.000Z' }]);
    t.ctx.activeSessions.set('s1', { exited: false, projectPath: 'D:\\live' });

    projects.applyAutoHide(true);
    assert.strictEqual(t.autoHidden.has('D:\\live'), false, 'a live session is activity');

    // ...and an EXITED session is not.
    t.ctx.activeSessions.set('s1', { exited: true, projectPath: 'D:\\live' });
    projects._resetAutoHideThrottle();
    projects.applyAutoHide(true);
    assert.strictEqual(t.autoHidden.has('D:\\live'), true);
  } finally { t.cleanup(); }
});

test('auto-hide respects the grace timer, not just the last session', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    // Its sessions are ancient, but it was added/unhidden yesterday — the grace timer is what counts,
    // otherwise re-adding a stale project would hide it again immediately (#57).
    t.setAdminRows([{ projectPath: 'D:\\readded', lastActivity: '2020-01-01T00:00:00.000Z' }]);
    t.ctx.db.setProjectState('D:\\readded', { autoHideResetAt: new Date(Date.now() - 86400000).toISOString() });

    projects.applyAutoHide(true);
    assert.deepStrictEqual(t.settings().hiddenProjects, undefined, 'the reset stamp wins over old sessions');
  } finally { t.cleanup(); }
});

test('auto-hide is throttled — an unforced pass right after another does nothing', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([{ projectPath: 'D:\\a', registered: true, lastActivity: '2020-01-01T00:00:00.000Z' }]);
    projects.applyAutoHide(true);
    assert.deepStrictEqual([...t.autoHidden], ['D:\\a']);

    // A second stale project appears, but the throttle window has not passed: an unforced pass is a no-op.
    t.setAdminRows([
      { projectPath: 'D:\\a', registered: true, autoHidden: true, lastActivity: '2020-01-01T00:00:00.000Z' },
      { projectPath: 'D:\\b', registered: true, lastActivity: '2020-01-01T00:00:00.000Z' },
    ]);
    projects.applyAutoHide();
    assert.deepStrictEqual([...t.autoHidden], ['D:\\a'], 'throttled');

    projects.applyAutoHide(true);
    assert.deepStrictEqual([...t.autoHidden], ['D:\\a', 'D:\\b'], 'forced runs anyway');
  } finally { t.cleanup(); }
});

// --- remap ------------------------------------------------------------------------------------------

test('remapProject moves EVERY backend\'s sessions, not just Claude\'s', () => {
  // The bug, reproduced against a real install before this was written: remapping a project that had
  // Claude AND Codex sessions moved Claude's and left Codex' behind — so one project became two, and the
  // phantom at the old path held the user's Codex history.
  const t = makeCtx();
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-'));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-'));
  try {
    const oldPath = 'D:\\old';
    const folder = encodeProjectPath(oldPath);
    const folderPath = path.join(t.store, folder);
    fs.mkdirSync(folderPath, { recursive: true });

    // Claude: cwd on every line. A line from another cwd must be left alone.
    // NOTE the file NAME: a Claude row carries NO filePath in the cache (the column exists for the
    // backends whose transcript location cannot be reconstructed — a date-bucketed Codex rollout). Its
    // path follows from the folder and the session id. The first cut of this skipped rows without a
    // filePath, so Claude quietly stayed behind while Codex moved. The fake must therefore lie about
    // nothing: the row below has filePath: null.
    const claudeFile = path.join(folderPath, 'a.jsonl');
    fs.writeFileSync(claudeFile,
      JSON.stringify({ type: 'user', cwd: oldPath, message: { role: 'user', content: 'one' } }) + '\n' +
      JSON.stringify({ type: 'assistant', cwd: oldPath, message: { role: 'assistant', content: 'two' } }) + '\n' +
      JSON.stringify({ type: 'user', cwd: 'D:\\somewhere-else', message: { role: 'user', content: 'not mine' } }) + '\n');

    // Codex: cwd once, in the session_meta header — and in a completely different store.
    const codexFile = path.join(codexDir, 'rollout-2026-07-13T12-00-00-x.jsonl');
    fs.writeFileSync(codexFile,
      JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: oldPath } }) + '\n');

    t.setCachedRows([
      { sessionId: 'a', folder, projectPath: oldPath, filePath: null, backendId: 'claude' },
      { sessionId: 'x', folder, projectPath: oldPath, filePath: codexFile, backendId: 'codex' },
    ]);

    const res = projects.remapProject(oldPath, newDir);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.moved, { claude: 1, codex: 1 }, 'both backends were told');

    const a = fs.readFileSync(claudeFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(a.map(l => l.cwd), [newDir, newDir, 'D:\\somewhere-else'],
      'Claude moves, and a line belonging to another cwd is untouched');

    const c = JSON.parse(fs.readFileSync(codexFile, 'utf8').trim());
    assert.strictEqual(c.payload.cwd, newDir, 'and Codex comes along instead of staying behind');

    // The folder memo must be re-pointed BEFORE the refresh, or the folder keeps resolving to the old
    // path (folderProjectPath short-circuits while the old directory still exists) and the project
    // vanishes from the sidebar.
    assert.deepStrictEqual(t.calls.refreshed, [folder], 'and the folder is re-indexed');

    // The project keeps its place on the list at the new path — and carries NO tombstone that might have
    // been sitting there, or it would vanish again on the next scan with nothing to say why (#167).
    assert.strictEqual(t.state(newDir).registered, 1);
    assert.strictEqual(t.state(newDir).removedAt, null);
  } finally {
    t.cleanup();
    fs.rmSync(newDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test('a project with NO Claude sessions is remappable — it used to be refused outright', () => {
  const t = makeCtx();
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-codex-'));
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store2-'));
  try {
    const oldPath = 'D:\\codex-only';
    const file = path.join(store, 'rollout-x.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: oldPath } }) + '\n');
    t.setCachedRows([{ sessionId: 'x', projectPath: oldPath, filePath: file, backendId: 'codex' }]);

    // There is no ~/.claude/projects folder for this project at all. That used to be the end of it:
    // "No session data found for this project".
    const res = projects.remapProject(oldPath, newDir);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.moved, { codex: 1 });
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8').trim()).payload.cwd, newDir);
  } finally {
    t.cleanup();
    fs.rmSync(newDir, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('remapProject says which backend it could NOT move', () => {
  // Hermes keeps its cwd in a column of a database we may only read (#2914). Its sessions stay at the old
  // path, and the user is told — rather than discovering a phantom project later.
  const t = makeCtx();
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-h-'));
  try {
    t.setCachedRows([{ sessionId: 'h1', projectPath: 'D:\\old', filePath: null, backendId: 'hermes' }]);
    const res = projects.remapProject('D:\\old', newDir);

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.moved, {}, 'nothing moved');
    assert.deepStrictEqual(res.cannotMove, ['Hermes'], 'and it says so, by name');
  } finally { t.cleanup(); fs.rmSync(newDir, { recursive: true, force: true }); }
});

test('a remapped project is not auto-hidden out from under the rename', () => {
  // Found in the running app, not in a test: between the rewrite and the next scan the project at the
  // NEW path is momentarily EMPTY — its sessions have not been re-attributed yet. Auto-hide reads "no
  // activity, ever", and no activity is stale by definition. It hides the project. And the scan SKIPS a
  // hidden project — so the sessions never arrive, and the rename stays broken forever.
  const t = makeCtx({ autoHideDays: 10 });
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap-ah-'));
  try {
    // The target path is ALREADY auto-hidden (a previous life, or the auto-hide pass that just ran).
    t.ctx.db.setProjectAutoHidden(newDir, 1);

    t.setCachedRows([]);
    fs.mkdirSync(path.join(t.store, encodeProjectPath('D:\\old')), { recursive: true });
    projects.remapProject('D:\\old', newDir);

    assert.strictEqual(t.autoHidden.has(newDir), false,
      'an AUTO hide on the target is cleared — the user is plainly moving a project here');
    assert.ok(t.state(newDir).autoHideResetAt, 'and the grace timer restarts, like an add or an unhide');
    assert.strictEqual(t.state(newDir).registered, 1, 'and the project is on the list at its new path');
  } finally { t.cleanup(); fs.rmSync(newDir, { recursive: true, force: true }); }
});

test('remapProject refuses a target that is not a directory, and a project it cannot find', () => {
  const t = makeCtx();
  try {
    const file = path.join(t.store, 'a-file');
    fs.writeFileSync(file, 'x');
    assert.match(projects.remapProject('D:\\old', file).error, /not a directory/i);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remap2-'));
    // No sessions anywhere, no store folder: there is genuinely nothing to remap.
    assert.match(projects.remapProject('D:\\never-seen', dir).error, /No session data/i);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

// --- deleting a project's sessions, per backend (#171) ----------------------------------------------

test('deletableBackends lists what the project has — and what cannot be deleted, with the reason', () => {
  const t = makeCtx();
  try {
    t.setCachedRows([
      { sessionId: 'a', folder: 'f', projectPath: 'D:\\p', filePath: null, backendId: 'claude' },
      { sessionId: 'b', folder: 'f', projectPath: 'D:\\p', filePath: 'x.jsonl', backendId: 'codex' },
      { sessionId: 'c', folder: 'f', projectPath: 'D:\\p', filePath: 'y.jsonl', backendId: 'codex' },
      { sessionId: 'd', folder: 'f', projectPath: 'D:\\p', filePath: null, backendId: 'hermes' },
    ]);

    const list = projects.deletableBackends('D:\\p');
    const byId = Object.fromEntries(list.map(b => [b.id, b]));

    assert.strictEqual(byId.claude.sessions, 1);
    assert.strictEqual(byId.codex.sessions, 2);
    assert.strictEqual(byId.claude.deletable, true);
    assert.strictEqual(byId.codex.deletable, true);

    // Hermes keeps its sessions in a database we open read-only and may never write (#2914). It is shown
    // — with the reason — rather than offered a switch that would do nothing.
    assert.strictEqual(byId.hermes.deletable, false);
    assert.match(byId.hermes.reason, /only read/i);
  } finally { t.cleanup(); }
});

test('deleting one backend\'s history leaves the others\' alone — files AND rows', () => {
  // The bug: "delete session history" cleared `~/.claude/projects` and nothing else, so a project's Codex
  // rollouts survived — invisible only because the project got hidden in the same breath, and back the
  // day it was unhidden.
  const t = makeCtx();
  const codexStore = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-del-'));
  try {
    const projectPath = 'D:\\p';
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(t.store, folder);
    fs.mkdirSync(folderPath, { recursive: true });
    const claudeFile = path.join(folderPath, 'a.jsonl');
    fs.writeFileSync(claudeFile, JSON.stringify({ type: 'user', cwd: projectPath, message: { role: 'user', content: 'x' } }) + '\n');

    const codexFile = path.join(codexStore, 'rollout-x.jsonl');
    fs.writeFileSync(codexFile, JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: projectPath } }) + '\n');

    t.setCachedRows([
      { sessionId: 'a', folder, projectPath, filePath: null, backendId: 'claude' },
      { sessionId: 'x', folder, projectPath, filePath: codexFile, backendId: 'codex' },
    ]);

    // Delete ONLY Claude's.
    const res = projects.deleteProjectSessions(projectPath, ['claude']);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.deleted, { claude: 1 });

    assert.strictEqual(fs.existsSync(claudeFile), false, 'Claude\'s transcript is gone');
    assert.strictEqual(fs.existsSync(folderPath), false, 'and the folder with it — nothing was left in it');
    assert.strictEqual(fs.existsSync(codexFile), true, 'Codex\' rollout is NOT — it was not asked for');

    // The rows go the same way, one by one: only the sessions whose files were deleted. Clearing the
    // cache BY FOLDER would take Codex' row with it — and its file is still on disk.
    assert.deepStrictEqual(t.calls.deletedSessions, ['a']);
    assert.deepStrictEqual(t.calls.deletedSearchSessions, ['a']);
    assert.deepStrictEqual(t.calls.deletedFolders, [], 'the hard delete does not clear the cache by folder');
  } finally {
    t.cleanup();
    fs.rmSync(codexStore, { recursive: true, force: true });
  }
});

test('a session that MOVED into another project is not destroyed with this one', () => {
  // The one that hurt. Claude's store folder is keyed on the cwd a session STARTED from, and since #157 a
  // session belongs to the tree it WORKS in — so one folder can hold sessions of two projects. Deleting
  // the project by removing its folders took the other project's transcripts with it: never counted,
  // never offered, and not recoverable.
  const t = makeCtx();
  try {
    const projectPath = 'D:\\p';
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(t.store, folder);
    fs.mkdirSync(folderPath, { recursive: true });

    const mine = path.join(folderPath, 'a.jsonl');
    const movedOut = path.join(folderPath, 'b.jsonl');       // same folder, now belongs to D:\other
    fs.writeFileSync(mine, '{}');
    fs.writeFileSync(movedOut, '{}');

    t.setCachedRows([
      { sessionId: 'a', folder, projectPath, filePath: null, backendId: 'claude' },
      { sessionId: 'b', folder, projectPath: 'D:\\other', filePath: null, backendId: 'claude' },
    ]);

    const res = projects.deleteProjectSessions(projectPath, ['claude']);
    assert.deepStrictEqual(res.deleted, { claude: 1 }, 'one session — the one that is actually this project\'s');
    assert.strictEqual(fs.existsSync(mine), false);
    assert.strictEqual(fs.existsSync(movedOut), true, 'the session that moved to another project survives');
    assert.strictEqual(fs.existsSync(folderPath), true, 'and its folder with it — it is not empty');
    assert.deepStrictEqual(t.calls.deletedSessions, ['a'], 'and the other project keeps its row');
  } finally { t.cleanup(); }
});

test('a subagent transcript goes with its project — it has no filePath to follow', () => {
  // A Claude row carries no `filePath`; the transcript is reconstructed from folder + session id, and a
  // subagent's file sits under the parent's directory. Without parentSessionId/agentId on the row that
  // path came out wrong, so the subagent was silently left behind.
  const t = makeCtx();
  try {
    const projectPath = 'D:\\p';
    const folder = encodeProjectPath(projectPath);
    const subDir = path.join(t.store, folder, 'parent-1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const parent = path.join(t.store, folder, 'parent-1.jsonl');
    const sub = path.join(subDir, 'agent-7.jsonl');
    fs.writeFileSync(parent, '{}');
    fs.writeFileSync(sub, '{}');

    t.setCachedRows([
      { sessionId: 'parent-1', folder, projectPath, filePath: null, backendId: 'claude' },
      { sessionId: 'sub:parent-1:7', folder, projectPath, filePath: null, backendId: 'claude', parentSessionId: 'parent-1', agentId: '7' },
    ]);

    projects.deleteProjectSessions(projectPath, ['claude']);
    assert.strictEqual(fs.existsSync(sub), false, 'the subagent transcript is gone too');
    assert.strictEqual(fs.existsSync(parent), false);
  } finally { t.cleanup(); }
});

test('a subagent the cache never saw still goes with its parent — files, sidecar and all', () => {
  // Found by mutation testing: the line that removes a parent's `subagents/` directory was held by NO
  // test. The test above only looked like it covered this — its subagent had a cached ROW, so its file was
  // in the delete list on its own account and would have gone with or without that line.
  //
  // A subagent with no row is not exotic: it has not been scanned yet, or it was written by a parser
  // version whose rows were dropped. Delete the project's history and its transcript would sit on disk for
  // ever, orphaned — belonging to a project that no longer exists, and reachable by nothing.
  const t = makeCtx();
  try {
    const projectPath = 'D:\\p';
    const folder = encodeProjectPath(projectPath);
    const subDir = path.join(t.store, folder, 'parent-1', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });

    const parent = path.join(t.store, folder, 'parent-1.jsonl');
    const parentMeta = path.join(t.store, folder, 'parent-1.meta.json');
    const orphanSub = path.join(subDir, 'agent-9.jsonl');
    const orphanMeta = path.join(subDir, 'agent-9.meta.json');
    for (const f of [parent, parentMeta, orphanSub, orphanMeta]) fs.writeFileSync(f, '{}');

    // ONLY the parent is in the cache. The subagent is on disk and nowhere else.
    t.setCachedRows([{ sessionId: 'parent-1', folder, projectPath, filePath: null, backendId: 'claude' }]);

    const res = projects.deleteProjectSessions(projectPath, ['claude']);

    assert.strictEqual(fs.existsSync(parent), false);
    assert.strictEqual(fs.existsSync(parentMeta), false, 'the sidecar goes with the transcript');
    assert.strictEqual(fs.existsSync(orphanSub), false, 'and so does the subagent nobody had indexed');
    assert.strictEqual(fs.existsSync(subDir), false, 'its directory with it');
    assert.deepStrictEqual(res.deleted, { claude: 1 }, 'counted as the one session it is — the parent');
  } finally { t.cleanup(); }
});

test('clearing one backend keeps the project\'s tags while another backend still has sessions', () => {
  // pruneProjectIfGone wipes a project's tags, handoffs and favourites, and it only ever looked in
  // CLAUDE's store. Clearing the Claude history of a project that also has Codex sessions therefore read
  // as "nothing left" and threw all of that away — while the Codex sessions carried on being listed.
  const t = makeCtx();
  const codexStore = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-keep-'));
  try {
    const projectPath = 'D:\\p';
    const folder = encodeProjectPath(projectPath);
    fs.mkdirSync(path.join(t.store, folder), { recursive: true });
    fs.writeFileSync(path.join(t.store, folder, 'a.jsonl'), '{}');
    const codexFile = path.join(codexStore, 'rollout-x.jsonl');
    fs.writeFileSync(codexFile, '{}');

    t.setCachedRows([
      { sessionId: 'a', folder, projectPath, filePath: null, backendId: 'claude' },
      { sessionId: 'x', folder, projectPath, filePath: codexFile, backendId: 'codex' },
    ]);

    projects.deleteProjectSessions(projectPath, ['claude']);
    assert.deepStrictEqual(t.calls.prunedProjects, [], 'the project is not forgotten — Codex is still in it');
  } finally {
    t.cleanup();
    fs.rmSync(codexStore, { recursive: true, force: true });
  }
});

test('a backend that cannot delete is refused by name, not silently skipped', () => {
  const t = makeCtx();
  try {
    t.setCachedRows([{ sessionId: 'h', folder: 'f', projectPath: 'D:\\p', filePath: null, backendId: 'hermes' }]);

    const res = projects.deleteProjectSessions('D:\\p', ['hermes']);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.deleted, {}, 'nothing was deleted');
    assert.deepStrictEqual(res.refused, ['Hermes'], 'and the user is told which, by name');
  } finally { t.cleanup(); }
});

test('a delete never leaves the store it belongs to', () => {
  // The paths come from cached rows. A row is data, and data can be wrong — a stale or tampered
  // filePath must not turn "delete this project's Codex history" into "delete that file over there".
  const { deleteTranscripts } = require('../src/backends/delete-sessions');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  try {
    const inside = path.join(store, 'mine.jsonl');
    const stranger = path.join(outside, 'not-mine.jsonl');
    fs.writeFileSync(inside, '{}');
    fs.writeFileSync(stranger, '{}');

    const res = deleteTranscripts([inside, stranger], store);

    assert.strictEqual(res.removed, 1);
    assert.deepStrictEqual(res.failed, [stranger], 'and it says which it refused');
    assert.strictEqual(fs.existsSync(inside), false);
    assert.strictEqual(fs.existsSync(stranger), true, 'a file outside the store is never touched');
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
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
  const t = makeCtx();
  try {
    projects.ensureProjectAdded('D:\\gone');
    projects.ensureProjectAdded('D:\\other');
    projects.hideProject('D:\\gone');

    assert.strictEqual(projects.projectHasSessionsOnDisk('D:\\gone'), false);
    assert.strictEqual(projects.pruneProjectIfGone('D:\\gone'), true);

    // The register row IS the project_meta row (#167), so the entry, the hide flag and any tombstone go
    // with it — one delete, not a settings blob to comb through.
    assert.strictEqual(t.states.has('D:\\gone'), false, 'its per-project row goes');
    assert.strictEqual(t.states.has('D:\\other'), true, 'without taking the neighbours');
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

// --- auto-hide RELEASES, too (#184) ----------------------------------------------------------------
//
// An auto-hide is the machine's decision, and the one thing that separates it from a hide is that the
// machine takes it back by itself. It never did: the sweep only ever SET the flag, and nothing but an
// unhide by hand or a remap cleared it. A project that went quiet long enough was gone for good, however
// much work went into it afterwards — and the registry's own contract says the opposite.

test('#184: an auto-hidden project comes back when work happens in it again', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([{ projectPath: 'D:\revived', registered: true, lastActivity: '2020-01-01T00:00:00.000Z' }]);
    projects.applyAutoHide(true);
    assert.strictEqual(t.autoHidden.has('D:\revived'), true, 'stale: hidden');

    // A session runs there today.
    t.setAdminRows([{
      projectPath: 'D:\revived', registered: true, autoHidden: true,
      lastActivity: new Date().toISOString(),
    }]);
    projects._resetAutoHideThrottle();
    projects.applyAutoHide(true);

    assert.strictEqual(t.autoHidden.has('D:\revived'), false, 'activity brings it back by itself');
    assert.strictEqual(t.state('D:\revived').autoHidden, 0);
    assert.strictEqual(t.state('D:\revived').autoHideResetAt, undefined,
      'only the flag goes — no grace period it did not earn, so it can age out again');
  } finally { t.cleanup(); }
});

test('#184: a live session brings an auto-hidden project back, whatever its timestamps say', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([{
      projectPath: 'D:\live', registered: true, autoHidden: true,
      lastActivity: '2020-01-01T00:00:00.000Z',
    }]);
    t.ctx.db.setProjectState('D:\live', { autoHidden: 1 });
    t.ctx.activeSessions.set('s1', { exited: false, projectPath: 'D:\live' });

    projects.applyAutoHide(true);
    assert.strictEqual(t.autoHidden.has('D:\live'), false, 'somebody is working in it right now');
  } finally { t.cleanup(); }
});

test('#184: a hide the USER made is not undone by activity', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([{
      projectPath: 'D:\hidden-by-hand', registered: true, hidden: true,
      lastActivity: new Date().toISOString(),
    }]);
    t.ctx.db.setProjectState('D:\hidden-by-hand', { hidden: 1, registered: 1 });

    projects.applyAutoHide(true);
    assert.strictEqual(t.state('D:\hidden-by-hand').hidden, 1,
      'that is the entire point of saying hide — new sessions do not bring it back');
  } finally { t.cleanup(); }
});

test('#184: switching auto-hide off gives back every project it was holding', () => {
  const t = makeCtx({ autoHideDays: 30 });
  try {
    t.setAdminRows([
      { projectPath: 'D:\a', registered: true, lastActivity: '2020-01-01T00:00:00.000Z' },
      { projectPath: 'D:\b', registered: true, lastActivity: '2020-01-01T00:00:00.000Z' },
    ]);
    projects.applyAutoHide(true);
    assert.deepStrictEqual([...t.autoHidden], ['D:\a', 'D:\b']);

    // The user turns the feature off. A machine that is no longer running may not keep holding projects.
    t.settings().autoHideDays = 0;
    projects._resetAutoHideThrottle();
    projects.applyAutoHide(true);

    assert.deepStrictEqual([...t.autoHidden], [], 'every auto-hide is given back');
    assert.strictEqual(t.state('D:\a').autoHidden, 0);
  } finally { t.cleanup(); }
});

// --- what the sidebar is NOT showing (#183) ---------------------------------------------------------
//
// A session in a project that is not on the list is indexed and searchable and painted nowhere. That is
// correct — the register decides, and in manual mode discovery may not write to it — and it is silent,
// which is not: the session you were in an hour ago is simply not there. `unlistedProjects` is what the
// sidebar's notice counts, and it must never offer something the register itself would refuse.

test('#183: unlistedProjects lists the projects that have sessions and are not on the list', () => {
  const t = makeCtx({ global: { projectAutoAdd: false } });
  try {
    t.setAdminRows([
      { projectPath: 'D:\\listed', registered: true, sessionCount: 3, lastActivity: '2026-07-01T10:00:00.000Z' },
      { projectPath: 'D:\\unlisted', registered: false, sessionCount: 2, lastActivity: '2026-07-02T10:00:00.000Z' },
      { projectPath: 'D:\\empty', registered: false, sessionCount: 0, lastActivity: null },
    ]);

    const res = projects.unlistedProjects();
    assert.deepStrictEqual(res.projects.map(p => p.projectPath), ['D:\\unlisted'],
      'a listed project is shown anyway; one with no sessions has nothing to miss');
    assert.strictEqual(res.sessionCount, 2, 'and it says how many sessions are being withheld');
  } finally { t.cleanup(); }
});

test('#183: a project the user REMOVED is not offered back — until a session newer than the removal', () => {
  const t = makeCtx({ global: { projectAutoAdd: false } });
  try {
    const removedAt = '2026-07-01T00:00:00.000Z';
    t.ctx.db.setProjectState('D:\\removed', { registered: 0, removedAt });
    t.setAdminRows([
      { projectPath: 'D:\\removed', registered: false, sessionCount: 5, lastActivity: '2026-06-01T00:00:00.000Z' },
    ]);
    assert.deepStrictEqual(projects.unlistedProjects().projects, [],
      'the sessions that were already there when it was removed are exactly what the tombstone ignores');

    // Work happens there again, after the removal.
    t.setAdminRows([
      { projectPath: 'D:\\removed', registered: false, sessionCount: 6, lastActivity: '2026-07-05T00:00:00.000Z' },
    ]);
    assert.deepStrictEqual(projects.unlistedProjects().projects.map(p => p.projectPath), ['D:\\removed'],
      'a NEW session is a reason to offer it again — the same rule auto-add follows');
  } finally { t.cleanup(); }
});
