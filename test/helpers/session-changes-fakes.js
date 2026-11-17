'use strict';
// Fakes for `src/app/session-changes.js` (#870): a provider that spells its argv with the REAL `src/vcs/git.js`
// builders (so argv order is what ships) but runs nothing, a fake `execFile` that answers by subcommand, an
// in-memory store with the shapes of `changes-store.js`, and a session cache.
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../../src/vcs/git');
const { makeEntry, normalizeSnapshot } = require('../../src/db/changes-record');
const { parseNumstat, parseLog } = require('../../src/vcs/parse-git-changes');

const FULL = (c) => c.repeat(40);

/** A fresh checkout directory (real, so path containment answers about something that exists). */
function makeCheckout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-repo-')));
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}

function makeProvider(root, overrides = {}) {
  return {
    id: 'fake', label: 'Fake', bin: path.join(root, '..', 'fake-vcs-bin'),
    describeRepo: () => ({ root, mainRoot: null }),
    numstatArgs: git.numstatArgs, logRangeArgs: git.logRangeArgs, revExistsArgs: git.revExistsArgs,
    headArgs: git.headArgs, revBeforeArgs: git.revBeforeArgs, showCommitArgs: git.showCommitArgs,
    resolveCommitArgs: git.resolveCommitArgs, isAncestorArgs: git.isAncestorArgs, diffArgs: git.diffArgs,
    parseNumstat, parseLog,
    ...overrides,
  };
}

/**
 * `answers[sub]` is `{ out }`, `{ code }`, `{ killed: true }` or a function `(args) => answer`; `sub` is the subcommand
 * after the global flags (`rev-list`, `rev-parse`, `cat-file`, `log`, `diff`, `merge-base`, `show`). `delay` defers.
 */
function makeExec(answers, { delay = false } = {}) {
  const calls = [];
  const exec = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    const sub = args.find((a, i) => i > 0 && !a.startsWith('--')) || args[0];
    let a = answers[sub];
    if (typeof a === 'function') a = a(args);
    a = a || { code: 1 };
    const reply = () => {
      if (a.killed) { const e = new Error('killed'); e.killed = true; e.signal = 'SIGTERM'; return cb(e, '', ''); }
      if (a.code) { const e = new Error('failed at a path'); e.code = a.code; return cb(e, a.out || '', 'fatal: some path'); }
      cb(null, a.out || '', '');
    };
    if (delay) setImmediate(reply); else reply();
    return { stdin: { end() {} } };
  };
  return { exec, calls };
}

function makeStore() {
  const entries = [];
  const views = new Map();
  let nextId = 1;
  const changes = new Map();
  const added = [];
  return {
    entries, changes, added, views,
    api: {
      getSessionChanges: (ids) => new Map(ids.filter((id) => changes.has(id)).map((id) => [id, changes.get(id)])),
      addChangeEntry: (kind, fields, extra) => {
        if (kind === 'push') return null;
        const e = makeEntry(kind, fields);
        if (!e) return null;
        const stored = { id: nextId++, ...e, repoRoot: extra && extra.repoRoot || null, how: extra && extra.how || null,
          files: fields && fields.files !== undefined ? normalizeSnapshot(fields.files) : null };
        entries.push(stored);
        added.push(kind);
        return stored;
      },
      setChangeStartSha: (id, sha, repoRoot) => {
        const e = entries.find((x) => x.id === id && x.kind === 'start' && !x.sha);
        if (!e || !/^[0-9a-f]{40,64}$/.test(sha)) return false;
        e.sha = sha;
        if (!e.repoRoot) e.repoRoot = repoRoot || null;
        return true;
      },
      listChangeEntries: (lineageId) => entries.filter((e) => e.lineageId === lineageId).map((e) => ({ ...e })),
      getChangesView: (id) => views.get(id) || null,
      setChangesView: (id, v) => { if (v === null) views.delete(id); else views.set(id, v); },
    },
  };
}

function makeCtx({ root, sessions, provider, exec, store, status, reports = true, others = [] }) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  return {
    getCachedSession: (id) => byId.get(id) || null,
    getFolderLineage: (folder) => sessions.filter((s) => s.folder === folder && s.lineageParentId)
      .map((s) => ({ sessionId: s.sessionId, lineageParentId: s.lineageParentId, lineageKind: s.lineageKind })),
    getCachedByParent: (id) => sessions.filter((s) => s.parentSessionId === id),
    getCachedByProjectPath: (p) => [...sessions, ...others].filter((s) => s.projectPath === p),
    getSessionScopeRows: () => [...sessions, ...others].filter((s) => s.projectPath)
      .map((s) => ({ sessionId: s.sessionId, projectPath: s.projectPath, modified: s.modified, lastEntryAt: s.lastEntryAt })),
    store: store.api,
    getVcsStatus: () => status || null,
    vcs: { detect: () => provider },
    backends: { get: () => ({ reportsChanges: reports }) },
    execFile: exec,
    getAppQuitting: () => false,
    now: () => Date.UTC(2026, 10, 16, 12),
    log: { debug() {} },
    root,
  };
}

module.exports = { makeCheckout, makeProvider, makeExec, makeStore, makeCtx, FULL };
