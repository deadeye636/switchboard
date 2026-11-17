'use strict';
// session-changes.js — what a session changed since the last review (#870, spec 47 sections 4 and 5).
//
// The renderer sends a SESSION ID, never a path: main finds the cached row, its lineage (D1), its backend's declaration
// and its working directory itself. Attribution comes from the derived tables the scan writes (O1: the transcript decides
// which files and commits are this session's); version control supplies the content (line counts, history checks), and
// `session-changes-model.js` turns both into what the group and Details draw.
//
// VCS-BLIND: every argv comes from a provider hook in `src/vcs/` (`numstatArgs`, `logRangeArgs`, `revExistsArgs`,
// `headArgs`, `revBeforeArgs`, `resolveCommitArgs`, `isAncestorArgs`, `showCommitArgs`, `diffArgs`), run with
// `provider.bin` (absolute on Windows, reflex 10), the checkout as `cwd`, a timeout, an output cap and a closed stdin.
// A builder throws `TypeError` on a value it refuses (an untrusted SHA from a transcript); that is "not available".
//
// UNTRUSTED INPUT: a recorded commit SHA is resolved once with `resolveCommitArgs` and accepted only when the full SHA
// starts with what was recorded and that is at least 7 hex digits (a short hex rev can name a branch, G4). A transcript
// path is checked with `path-containment.js` (real paths, reflex 13) before any use; a path outside the checkout is
// listed as outside and never reaches version control or the filesystem. Error text is generic: version control's
// stderr carries paths.
//
// ONE READ IN FLIGHT PER SESSION AND REQUEST: a call with the same range and view while one runs marks the slot dirty
// and gets the result of one more run. A refresh makes at most `SPAWN_BOUND` calls (see `gitFacts`).
//
// ROW IDS are content-derived (the model's `f:<hash of cut and key>`, `c:<recorded SHA>`) and kept for the last few
// answers per session (`MAX_REQUESTS_PER_SESSION`, least recently used out, `MAX_REMEMBERED_SESSIONS` sessions), so a
// diff asked from Details names Details' file even after the sidebar asked another range. `forget` drops a session.
//
// The ctx rule: no top-level database require. Everything the database answers arrives through `init(ctx)`.

const path = require('path');
const { execFile } = require('child_process');
const model = require('./session-changes-model');
const { isAtOrInside } = require('./path-containment');
const { networkShareOf } = require('./network-path');
const { cleanChangesView } = require('../db/changes-record');
const { closeProbeStdin } = require('./terminal/shell-profiles');

// Answer 1 of `.claude/rules/backends.md`: a row with no backendId was written before #161, when every session was Claude's.
const LEGACY_SESSION_BACKEND = 'claude';
// Lineage kinds that continue the parent's timeline (D1). A fork starts a timeline of its own.
const CONTINUES = new Set(['clear', 'terminal', 'parent']);
const TIMEOUT_MS = 4000;
const CAP_SMALL = 64 * 1024;
const CAP_LOG = 2 * 1024 * 1024;
const CAP_NUMSTAT = 4 * 1024 * 1024;
const CAP_DIFF = 8 * 1024 * 1024;
const MAX_LOG = 500;                 // commits read back from history per refresh
const MAX_RESOLVE = 16;              // SHA lookups per refresh (history hits are free); the rest stay "unknown"
const MAX_CUT_RESOLVE = 8;           // lookups for the cut SHAs (push tips) per refresh, before the commit marks
const MAX_NUMSTAT_CUTS = 12;         // numstat reads per refresh (All + the newest Split blocks)
const MAX_LINEAGE = 200;             // sessions followed in one lineage
const MAX_OTHER_SESSIONS = 300;      // other sessions of the project asked for E8
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RECORDED_SHA_RE = /^[0-9a-f]{7,64}$/;

const MSG = Object.freeze({
  notFound: 'This session is not known.',
  failed: 'Version control could not be read.',
  outside: 'This file is outside this checkout: no diff.',
  openOutside: 'This file is outside this checkout.',
  noDiff: 'No diff is available for this item.',
  stale: 'This item is no longer listed. Refresh and try again.',
  quitting: 'The app is closing.',
});

let ctx = null;
const inflight = new Map();   // sessionId -> { dirty, opts, promise }
const lastGood = new Map();   // sessionId -> vcs facts of the last read that worked
const targets = new Map();    // sessionId -> { root, files: Map<id, …>, commits: Map<id, …>, input }
const timelineInit = new Map(); // lineageId -> promise (one start initialisation at a time)
const noCommitsAt = new Map();  // lineageId -> when a fork's baseline last found a repository without commits
const NO_COMMITS_RETRY_MS = 5 * 60 * 1000;

function init(context) {
  for (const sessionId of [...followed.keys()]) releaseFolder(sessionId);   // through the OLD ctx, which holds them
  ctx = context || {};
  inflight.clear();
  lastGood.clear();
  targets.clear();
  timelineInit.clear();
  followed.clear();
  wiredSenders.clear();
  if (offVcsStatus) { offVcsStatus(); offVcsStatus = null; }
}

const quitting = () => !!(ctx && typeof ctx.getAppQuitting === 'function' && ctx.getAppQuitting());
const nowMs = () => (ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now());
const store = () => (ctx && ctx.store) || {};
function debug(msg) { if (ctx && ctx.log && typeof ctx.log.debug === 'function') ctx.log.debug(`[session-changes] ${msg}`); }

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

function vcsRegistry() { return (ctx && ctx.vcs) || require('../vcs'); }
function backendsRegistry() { return (ctx && ctx.backends) || require('../backends'); }

/** Does this session's backend report what it changed? Only an explicit `reportsChanges: false` says no. */
function reportsFor(row) {
  let d = null;
  try { d = backendsRegistry().get(row.backendId || LEGACY_SESSION_BACKEND); } catch { d = null; }
  return !(d && d.reportsChanges === false);
}

// --- the lineage (D1) ---

/**
 * `{ root, order, rows, lineageId, isFork }`: the root of the asked session's timeline (followed up through the
 * continuing lineage kinds), then every continuing descendant in the same folder, depth first, older child first.
 * A subagent row stands for its parent's lineage.
 */
function lineageOf(sessionId) {
  let row = ctx.getCachedSession(sessionId);
  if (!row) return null;
  if (row.parentSessionId) { const p = ctx.getCachedSession(row.parentSessionId); if (p) row = p; }
  const rows = new Map([[row.sessionId, row]]);
  let root = row;
  while (root.lineageParentId && CONTINUES.has(root.lineageKind) && !rows.has(root.lineageParentId) && rows.size < MAX_LINEAGE) {
    const p = ctx.getCachedSession(root.lineageParentId);
    if (!p) break;
    rows.set(p.sessionId, p);
    root = p;
  }
  const children = new Map();
  let links = [];
  try { links = (typeof ctx.getFolderLineage === 'function' && root.folder ? ctx.getFolderLineage(root.folder) : []) || []; } catch { links = []; }
  for (const l of links) {
    if (!l || !CONTINUES.has(l.lineageKind) || !l.lineageParentId) continue;
    if (!children.has(l.lineageParentId)) children.set(l.lineageParentId, []);
    children.get(l.lineageParentId).push(l.sessionId);
  }
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || order.length >= MAX_LINEAGE) return;
    seen.add(id);
    const r = rows.get(id) || ctx.getCachedSession(id);
    if (!r) return;
    rows.set(id, r);
    order.push(id);
    const kids = (children.get(id) || []).map((k) => rows.get(k) || ctx.getCachedSession(k)).filter(Boolean);
    kids.sort((a, b) => (toMs(a.startedAt || a.created) || 0) - (toMs(b.startedAt || b.created) || 0));
    for (const k of kids) { rows.set(k.sessionId, k); visit(k.sessionId); }
  };
  visit(root.sessionId);
  return { root, order, rows, lineageId: root.sessionId, isFork: root.lineageKind === 'fork' };
}

function subagentsOf(order) {
  const out = [];
  if (typeof ctx.getCachedByParent !== 'function') return out;
  for (const sid of order) {
    let subs = [];
    try { subs = ctx.getCachedByParent(sid) || []; } catch { subs = []; }
    for (const s of subs) if (s && s.sessionId) out.push({ sessionId: s.sessionId, at: toMs(s.lastEntryAt) ?? toMs(s.modified) });
  }
  return out;
}

const EMPTY = { files: [], commits: [], pushes: [], truncated: false };
function maxPosition(row) {
  let max = null;
  const see = (p) => { if (typeof p === 'number' && Number.isFinite(p) && (max === null || p > max)) max = p; };
  for (const f of row.files) see(f.last);
  for (const c of row.commits) see(c.position);
  for (const p of row.pushes) see(p.position);
  return max;
}

// --- running the provider ---

/** One provider call: `{ ok, code, timedOut, stdout }`. Never rejects; a builder's TypeError answers `{ refused: true }`. */
function run(provider, cwd, build, maxBuffer) {
  let args;
  try { args = build(); } catch (e) {
    if (e instanceof TypeError) return Promise.resolve({ ok: false, refused: true, code: null, stdout: '' });
    throw e;
  }
  if (!Array.isArray(args)) return Promise.resolve({ ok: false, refused: true, code: null, stdout: '' });
  const exec = (ctx && ctx.execFile) || execFile;
  return new Promise((resolve) => {
    try {
      closeProbeStdin(exec(provider.bin, args, { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer, encoding: 'utf8' },
        (err, stdout) => {
          if (err) {
            // The message names the command line, and that carries paths: only the code goes to the log.
            debug(`a read failed (code ${err.code === undefined ? '?' : err.code})`);
            const overCap = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(err.message || ''));
            return resolve({ ok: false, code: typeof err.code === 'number' ? err.code : null, overCap, timedOut: !overCap && !!(err.killed || err.signal), stdout: String(stdout || '') });
          }
          resolve({ ok: true, code: 0, stdout: String(stdout || '') });
        }));
    } catch { resolve({ ok: false, code: null, stdout: '' }); }
  });
}

/** A checkout for a working directory: `{ provider, root }` or null (no repository, or a provider without these hooks). */
function checkoutOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let provider = null;
  try { provider = vcsRegistry().detect(cwd); } catch { provider = null; }
  if (!provider || typeof provider.numstatArgs !== 'function') return null;
  let where = null;
  try { where = typeof provider.describeRepo === 'function' ? provider.describeRepo(cwd) : null; } catch { where = null; }
  return { provider, root: where && where.root ? where.root : cwd };
}

/** The lookup state of one refresh: what was resolved, the history read, and how many lookups are left. */
function newLookup(budget) {
  return { memo: new Map(), history: [], left: budget };
}

/**
 * A recorded (untrusted) SHA as the full SHA of a commit of this repository: the full SHA, `null` (not a commit here,
 * or refused), or `undefined` (the lookup budget is spent: unknown). Accepted only when it is at least 7 hex digits and
 * the answer STARTS WITH it (G4: a short hex rev can equal a branch name, and rev-parse would answer that branch's tip).
 * A SHA the history read already holds costs no call and no budget; only a real lookup counts.
 */
async function resolveSha(co, raw, look) {
  if (typeof raw !== 'string' || !RECORDED_SHA_RE.test(raw)) return null;
  if (look.memo.has(raw)) return look.memo.get(raw);
  const hit = look.history.find((h) => h.sha.startsWith(raw));
  if (hit) { look.memo.set(raw, hit.sha); return hit.sha; }
  if (look.left <= 0) return undefined;
  look.left--;
  const r = await run(co.provider, co.root, () => co.provider.resolveCommitArgs(raw), CAP_SMALL);
  const full = r.ok ? r.stdout.trim() : '';
  const ok = FULL_SHA_RE.test(full) && full.startsWith(raw) ? full : null;
  look.memo.set(raw, ok);
  return ok;
}

// --- the baseline (E1, D1, G3, G7) ---

/**
 * E1: the baseline commit for a session that started at `startMs`: the commit at its start (`revBeforeArgs`), else
 * HEAD (E1 (b)). `{ sha, how, failed }`; a repository without commits has no baseline (G7: `sha: null`, `no-commits`).
 * At most two calls.
 */
async function baselineFor(co, startMs) {
  if (startMs !== null) {
    const r = await run(co.provider, co.root, () => co.provider.revBeforeArgs(new Date(startMs).toISOString()), CAP_SMALL);
    const out = r.ok ? r.stdout.trim() : '';
    if (FULL_SHA_RE.test(out)) return { sha: out, how: 'before-start', failed: false };
    if (!r.ok && !r.refused && r.code !== 128) return { sha: null, how: null, failed: true };
  }
  const h = await run(co.provider, co.root, () => co.provider.headArgs(), CAP_SMALL);
  const out = h.ok ? h.stdout.trim() : '';
  if (FULL_SHA_RE.test(out)) return { sha: out, how: 'head', failed: false };
  if (!h.ok && h.code === 128) return { sha: null, how: 'no-commits', failed: false };
  return { sha: null, how: null, failed: true };
}

const FORK_FIRST_SEEN = 'fork-first-seen';

/**
 * G3: a fork's `start` is stored ONCE, the first time the fork is seen (the header figure's read or a refresh, with or
 * without a repository), from the database alone: at the highest position its row holds then, with the counts there as
 * the snapshot, `sha: null`. It never moves afterwards, so the fork's own later work is counted. Its SHA is filled later
 * by `ensureTimeline` when a repository answers (or stays null, as G7 allows). A fork first seen after it already did
 * work of its own starts at first sight: that earlier own work is not counted (spec 47, G3).
 */
function ensureForkStart(lin, changes) {
  const s = store();
  if (!lin.isFork || typeof s.listChangeEntries !== 'function' || typeof s.addChangeEntry !== 'function') return;
  if (s.listChangeEntries(lin.lineageId).some((e) => e.kind === 'start')) return;
  const root = lin.root;
  const row = changes.get(root.sessionId) || EMPTY;
  s.addChangeEntry('start', {
    lineageId: lin.lineageId, sessionId: root.sessionId, position: maxPosition(row) ?? 0,
    at: toMs(root.startedAt) ?? toMs(root.created), sha: null, files: row.files,
  }, { repoRoot: null, how: FORK_FIRST_SEEN });
}

/**
 * Make sure the lineage has its `start` entry with a SHA where a repository can give one, and a `cli-clear` entry for
 * every `/clear` child (D1). A root's start is stored when a repository first answers (E1, G7); a fork's start is
 * stored at first sight (`ensureForkStart`) and only its SHA is filled here. At most two calls (`baselineFor`).
 */
async function ensureTimeline(lin, co, changes) {
  const s = store();
  if (typeof s.listChangeEntries !== 'function' || typeof s.addChangeEntry !== 'function') return;
  const lineageId = lin.lineageId;
  ensureForkStart(lin, changes);
  const startOf = () => s.listChangeEntries(lineageId).find((e) => e.kind === 'start') || null;
  const start = startOf();
  // A fork in a repository without commits keeps a null SHA; do not repeat the baseline calls on every refresh for it.
  const noCommitsSince = noCommitsAt.get(lineageId);
  const recentlyNoCommits = noCommitsSince !== undefined && Date.now() - noCommitsSince < NO_COMMITS_RETRY_MS;
  const needsSha = start && !start.sha && start.how === FORK_FIRST_SEEN && typeof s.setChangeStartSha === 'function'
    && !recentlyNoCommits;
  if (co && (!start || needsSha)) {
    if (!timelineInit.has(lineageId)) {
      timelineInit.set(lineageId, (async () => {
        const root = lin.root;
        const startMs = toMs(root.startedAt) ?? toMs(root.created);
        const b = await baselineFor(co, startMs);
        if (b.failed || quitting()) return;   // try again on the next read rather than record a guess
        const now = startOf();
        if (!now) s.addChangeEntry('start', { lineageId, sessionId: root.sessionId, position: null, at: startMs, sha: b.sha }, { repoRoot: co.root, how: b.how });
        else if (!now.sha && now.how === FORK_FIRST_SEEN && b.sha) s.setChangeStartSha(now.id, b.sha, co.root);
        else if (!now.sha && now.how === FORK_FIRST_SEEN && !b.sha) noCommitsAt.set(lineageId, Date.now());
      })().finally(() => timelineInit.delete(lineageId)));
    }
    await timelineInit.get(lineageId);
  }
  if (quitting()) return;
  const now = s.listChangeEntries(lineageId);
  for (const sid of lin.order.slice(1)) {
    const r = lin.rows.get(sid);
    if (!r || r.lineageKind !== 'clear') continue;
    if (now.some((e) => e.kind === 'cli-clear' && e.sessionId === sid)) continue;
    s.addChangeEntry('cli-clear', { lineageId, sessionId: sid, position: null, at: toMs(r.startedAt) ?? toMs(r.created) });
  }
}

// --- what the model is handed ---

const slash = (p) => p.split(path.sep).join('/');

/**
 * `Map<rawPath, { key, outside }>`: the key is relative to the checkout (or the working directory without one).
 *
 * A transcript path is untrusted, and resolving a network path (`\\host\share\…`, `//host/share/…`) through the
 * filesystem is already an SMB connection to whoever named it (#780). So a path on a share the checkout is not on is
 * answered "outside" LEXICALLY, before anything touches it; only a local path, or one on the checkout's own share, is
 * asked on real paths (reflex 13).
 */
function pathMapOf(rawPaths, cwd, root) {
  const base = root || cwd;
  const baseShare = networkShareOf(base);
  const out = new Map();
  for (const p of rawPaths) {
    if (out.has(p) || typeof p !== 'string' || !p || p.includes('\0')) continue;
    const share = networkShareOf(p);
    if (share && share !== baseShare) { out.set(p, { key: p, outside: true }); continue; }
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
    const absShare = networkShareOf(abs);
    if (absShare && absShare !== baseShare) { out.set(p, { key: p, outside: true }); continue; }
    const rel = path.relative(base, abs);
    // Reflex 13: a guard is decided on real paths. The lexical `rel` is only the row's key.
    const outside = !rel || !isAtOrInside(abs, base);
    out.set(p, { key: rel ? slash(rel) : slash(abs), outside });
  }
  return out;
}

/** E8: how many OTHER sessions of the same project edited each key since `sinceMs` (a database read, no version control). */
function editedByOthers(row, excluded, keys, sinceMs, base) {
  const out = new Map();
  if (typeof ctx.getCachedByProjectPath !== 'function' || !row.projectPath || !keys.size) return out;
  let others = [];
  try { others = ctx.getCachedByProjectPath(row.projectPath) || []; } catch { others = []; }
  const since = sinceMs || 0;
  others = others.filter((o) => o && o.sessionId && !excluded.has(o.sessionId) && (toMs(o.modified) ?? toMs(o.lastEntryAt) ?? 0) >= since)
    .sort((a, b) => (toMs(b.modified) || 0) - (toMs(a.modified) || 0)).slice(0, MAX_OTHER_SESSIONS);
  if (!others.length) return out;
  const changes = store().getSessionChanges(others.map((o) => o.sessionId));
  for (const o of others) {
    const ch = changes.get(o.sessionId);
    if (!ch) continue;
    const cwd = o.projectPath || row.projectPath;
    const seen = new Set();
    for (const f of ch.files) {
      if (typeof f.at === 'number' && f.at < since) continue;
      const abs = path.isAbsolute(f.path) ? path.normalize(f.path) : path.resolve(cwd, f.path);
      const key = slash(path.relative(base, abs));    // a match, not a guard: lexical on purpose
      if (!keys.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.set(key, (out.get(key) || 0) + 1);
    }
  }
  return out;
}

function storedRequest(sessionId) {
  const s = store();
  let v = null;
  try { v = typeof s.getChangesView === 'function' ? s.getChangesView(sessionId) : null; } catch { v = null; }
  return model.cleanRequest(v || {});
}

function requestOf(sessionId, opts) {
  const o = opts || {};
  const stored = storedRequest(sessionId);
  return model.cleanRequest({
    range: o.range !== undefined ? o.range : stored.range,
    view: o.view !== undefined ? o.view : stored.view,
    pickFrom: o.pickFrom !== undefined ? o.pickFrom : stored.pickFrom,
    pickTo: o.pickTo !== undefined ? o.pickTo : stored.pickTo,
  });
}

/** Everything the database answers about a session's lineage, shaped for the model. Null for an unknown session. */
function gatherDb(sessionId, request) {
  const row = ctx.getCachedSession(sessionId);
  if (!row) return null;
  if (!reportsFor(row)) return { row, input: { reports: false, request } };
  const lin = lineageOf(sessionId);
  const subagents = subagentsOf(lin.order);
  const changes = store().getSessionChanges([...lin.order, ...subagents.map((s) => s.sessionId)]);
  // G3: a fork's start is stored the first time it is seen, here too (the header figure is often the first reader).
  ensureForkStart(lin, changes);
  const entries = typeof store().listChangeEntries === 'function' ? store().listChangeEntries(lin.lineageId) : [];
  const input = {
    reports: true, sessionId, order: lin.order, rows: changes, subagents, entries, request, now: nowMs(),
    startedAt: toMs(lin.root.startedAt) ?? toMs(lin.root.created), paths: new Map(), facts: {}, vcs: null,
  };
  return { row, lin, changes, input };
}

// --- the version-control facts of one refresh ---

/**
 * What version control says for one refresh. The spawn count of a refresh is bounded whatever the lineage holds:
 * `SPAWN_BOUND` = `ensureTimeline`'s baseline (2, first refresh or a fork whose SHA is still missing) + the baseline
 * check (1) + the history read (1) + the cut SHAs (`MAX_CUT_RESOLVE` lookups, a budget of their own, taken FIRST so the
 * blocks keep their counts) + the shown commits' marks (`MAX_RESOLVE` lookups) + one ancestry check per resolved SHA that
 * is not in the history read (a cut SHA resolved above can be a shown commit too, so up to `MAX_CUT_RESOLVE + MAX_RESOLVE`
 * of them) + `MAX_NUMSTAT_CUTS` line-count reads. Only the commits the answer SHOWS are checked (`plan.shas`), and a SHA the
 * history read holds costs nothing.
 */
async function gitFacts(co, first) {
  const facts = {
    noRepo: false, failed: false, baselineGone: false, countsCapped: false,
    inHistory: new Map(), numstat: new Map(), otherCommits: null,
  };
  const look = newLookup(MAX_RESOLVE);
  const cutLook = newLookup(MAX_CUT_RESOLVE);
  cutLook.memo = look.memo;
  // A cut end the app wrote from version-control output (a start's baseline, a Clear's HEAD) is used as it is; one read
  // out of a transcript (a push) is resolved whatever its length (`core.abbrev=40` prints full ones).
  const full = async (sha, trusted) => (trusted && sha && FULL_SHA_RE.test(sha) ? sha : resolveSha(co, sha, cutLook));
  const cuts = first.plan.cuts;
  const base = cuts[0] ? cuts[0].fromSha : null;
  let baseFull = null;
  if (base) {
    baseFull = cuts[0].fromTrusted && FULL_SHA_RE.test(base) ? base : null;
    if (baseFull) {
      const r = await run(co.provider, co.root, () => co.provider.revExistsArgs(baseFull), CAP_SMALL);
      if (!r.ok) { if (r.code === 128 || r.code === 1 || r.refused) facts.baselineGone = true; else facts.failed = true; }
    }
  }
  if (facts.failed) return facts;
  // E3 and the "other commits" line: the history since the range start, then each SHOWN recorded SHA it does not hold.
  const log = await run(co.provider, co.root, () => co.provider.logRangeArgs({ from: facts.baselineGone ? null : baseFull, to: 'HEAD', max: MAX_LOG }), CAP_LOG);
  if (!log.ok && !log.refused && log.code !== 128) { facts.failed = true; return facts; }
  look.history = log.ok ? co.provider.parseLog(log.stdout, 3) : [];
  cutLook.history = look.history;
  if (base && !baseFull) {
    baseFull = await full(base);
    if (baseFull === null) facts.baselineGone = true;
  }
  // The cut SHAs (push tips, numstat ranges) first, on their own budget: the marks below must not starve the blocks.
  const ends = new Map();
  for (const cut of cuts.slice(0, MAX_NUMSTAT_CUTS)) {
    ends.set(cut.id, {
      from: await full(cut.fromSha, cut.fromTrusted),
      to: cut.working ? null : await full(cut.toSha, cut.toTrusted),
    });
  }
  const matched = new Set();
  for (const raw of first.plan.shas.filter((s) => RECORDED_SHA_RE.test(s))) {
    const f = await resolveSha(co, raw, look);
    if (f === undefined) continue;                  // over the lookup budget: no mark rather than a guess
    if (f === null) { facts.inHistory.set(raw, false); continue; }
    if (look.history.some((h) => h.sha === f)) { facts.inHistory.set(raw, true); matched.add(f); continue; }
    const a = await run(co.provider, co.root, () => co.provider.isAncestorArgs(f, 'HEAD'), CAP_SMALL);
    if (a.ok) facts.inHistory.set(raw, true); else if (a.code === 1) facts.inHistory.set(raw, false);
  }
  if (first.range.toId === null && !facts.baselineGone && baseFull && look.history.length < MAX_LOG) {
    facts.otherCommits = look.history.filter((h) => !matched.has(h.sha)).length;
  }
  // Line counts per cut, in the plan's order (All, then the newest blocks), filtered to this lineage's keys by the model
  // (a shared tree lists only this session's files).
  for (const cut of cuts.slice(0, MAX_NUMSTAT_CUTS)) {
    if (facts.baselineGone && cut === cuts[0]) continue;
    const { from, to } = ends.get(cut.id);
    if (!from) continue;
    if (!cut.working && !to) continue;
    if (to && to === from) { facts.numstat.set(cut.id, new Map()); continue; }
    const r = await run(co.provider, co.root, () => co.provider.numstatArgs({ from, to }), CAP_NUMSTAT);
    if (!r.ok) {
      if (r.overCap) facts.countsCapped = true;     // too large to read: counts not available, not a failure
      // 128 = a revision this repository no longer has (a rewritten block): no counts, not a failure.
      else if (!r.refused && r.code !== 128) facts.failed = true;
      continue;
    }
    facts.numstat.set(cut.id, new Map(co.provider.parseNumstat(r.stdout).map((n) => [n.path, n])));
  }
  if (quitting()) facts.failed = true;
  return facts;
}

// --- the read ---

const MAX_REMEMBERED_SESSIONS = 32;   // sessions whose last facts and row targets are kept (least recently used out)
const MAX_REQUESTS_PER_SESSION = 4;   // answers kept per session (the sidebar and Details may ask different ranges)

/** Set `key` in a Map used as an LRU: re-inserted at the end, the oldest dropped over `max`. */
function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

const requestKey = (req) => JSON.stringify([req.range, req.view, req.pickFrom, req.pickTo]);

/**
 * What a row id the model gave out names: a file row (`f:<hash of cut and key>`) with the cut it was measured in, or a
 * commit (`c:<recorded SHA>`). The ids are content-derived, so the same id means the same item in every answer.
 */
function targetsOf(view) {
  const files = new Map();
  const commits = new Map();
  const cutOf = (id) => (view.plan.cuts.find((c) => c.id === id) || null);
  const allCut = view.plan.cuts[0] || null;
  for (const f of view.files) files.set(f.id, { ...f, cut: allCut });
  for (const c of view.commits) commits.set(c.id, c);
  for (const b of view.blocks) {
    const cut = cutOf(b.id);
    for (const f of b.files) if (!files.has(f.id)) files.set(f.id, { ...f, cut });
    for (const c of b.commits) if (!commits.has(c.id)) commits.set(c.id, c);
  }
  return { files, commits };
}

/** The answer without what only main needs (the plan holds SHAs and cut ids; nothing there is for the renderer). */
function publicView(view) {
  const { plan, ...rest } = view;
  return { ok: true, ...rest };
}

async function computeState(sessionId, opts) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  const request = requestOf(sessionId, opts);
  let g = gatherDb(sessionId, request);
  if (!g) return { ok: false, error: MSG.notFound };
  if (g.input.reports === false) return publicView(model.buildModel(g.input));
  const co = checkoutOf(g.row.projectPath);
  await ensureTimeline(g.lin, co, g.changes);
  if (quitting()) return { ok: false, error: MSG.quitting };
  g = gatherDb(sessionId, request);   // the entries may have grown
  if (!g) return { ok: false, error: MSG.notFound };
  const { row, lin, changes, input } = g;
  const raw = new Set();
  for (const ch of changes.values()) for (const f of ch.files) raw.add(f.path);
  const cwd = row.projectPath || '';
  input.paths = pathMapOf(raw, cwd, co ? co.root : null);
  const outside = new Set();
  const keys = new Set();
  for (const v of input.paths.values()) { keys.add(v.key); if (v.outside) outside.add(v.key); }
  input.facts.outside = outside;
  const first = model.buildModel(input);
  input.facts.editedByOthers = editedByOthers(row, new Set([...lin.order, ...input.subagents.map((s) => s.sessionId)]),
    keys, first.range.fromAt, co ? co.root : cwd);
  // E7 and the "new" mark come from the poller's last status of this directory; no status run of our own.
  let status = null;
  try { status = typeof ctx.getVcsStatus === 'function' ? ctx.getVcsStatus(cwd) : null; } catch { status = null; }
  if (status && Array.isArray(status.files) && !status.truncated) {
    input.facts.statusKeys = status.files.map((f) => f && f.path).filter((p) => typeof p === 'string');
    input.facts.untracked = new Set(status.files.filter((f) => f && f.kind === 'untracked').map((f) => f.path));
  } else if (status && Array.isArray(status.files)) {
    input.facts.untracked = new Set(status.files.filter((f) => f && f.kind === 'untracked').map((f) => f.path));
  }
  const reqKey = requestKey(input.request);
  if (!co) input.vcs = { noRepo: true };
  else {
    let facts;
    try { facts = await gitFacts(co, first); } catch (e) {
      debug('refresh threw: ' + (e && e.name));
      facts = { failed: true };
    }
    if (facts.failed) {
      // The last good facts stand in only for the SAME request: another range's counts would be wrong here.
      const good = lastGood.get(sessionId);
      input.vcs = { ...(good && good.reqKey === reqKey ? good.facts : {}), failed: true };
    } else {
      remember(lastGood, sessionId, { reqKey, facts }, MAX_REMEMBERED_SESSIONS);
      input.vcs = facts;
    }
  }
  if (quitting()) return { ok: false, error: MSG.quitting };
  const view = model.buildModel(input);
  const t = targetsOf(view);
  const perSession = targets.get(sessionId) || new Map();
  remember(perSession, reqKey, { root: co ? co.root : null, cwd, provider: co ? co.provider : null, files: t.files, commits: t.commits, input }, MAX_REQUESTS_PER_SESSION);
  remember(targets, sessionId, perSession, MAX_REMEMBERED_SESSIONS);
  return publicView(view);
}

/**
 * `state(sessionId, { range, view, pickFrom, pickTo, fresh })`. One read in flight per session AND request: a call with
 * the same cleaned request while one runs marks it dirty and gets the result of one more run; a call with another
 * request (the sidebar and Details asking different ranges) runs on its own and gets its own range.
 */
function state(sessionId, opts) {
  if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve({ ok: false, error: MSG.notFound });
  const key = sessionId + '\u0001' + requestKey(requestOf(sessionId, opts));
  const slot = inflight.get(key);
  if (slot) { slot.dirty = true; return slot.promise; }
  const s = { dirty: false };
  s.promise = (async () => {
    let result;
    do {
      s.dirty = false;
      result = await computeState(sessionId, opts);
    } while (s.dirty && !quitting());
    return result;
  })().finally(() => inflight.delete(key));
  inflight.set(key, s);
  return s.promise;
}

/** Drop what is kept for a session (its last facts and row targets). T10 calls it when the group unsubscribes. */
function forget(sessionId) {
  lastGood.delete(sessionId);
  targets.delete(sessionId);
}

/** V1: the header figure, from the database only. `{ ok, reports, figure }`. */
function summary(sessionId) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: MSG.notFound };
  const g = gatherDb(sessionId, model.cleanRequest({}));
  if (!g) return { ok: false, error: MSG.notFound };
  return { ok: true, ...model.summaryOf(g.input) };
}

/** Details: the state plus the timeline strip. */
async function details(sessionId, opts) {
  const st = await state(sessionId, opts);
  if (!st.ok) return st;
  const per = targets.get(sessionId);
  const t = per ? per.get(requestKey(st.request)) : null;
  return { ...st, timeline: t ? model.timeline(t.input).ticks : [] };
}

/** The timeline ticks alone (for "Pick entries"), from the database only. */
function entries(sessionId, opts) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  const g = typeof sessionId === 'string' && sessionId ? gatherDb(sessionId, requestOf(sessionId, opts)) : null;
  if (!g) return { ok: false, error: MSG.notFound };
  return { ok: true, ticks: model.timeline(g.input).ticks };
}

/**
 * One diff, by the id of a row the module gave out in a recent answer for this session: a file row (`f:…`, which names
 * its cut and key) or a commit (`c:<recorded SHA>`). The renderer never names a path or a SHA of its own: an id no kept
 * answer holds is refused as stale before anything runs.
 */
/** The kept answer that holds a row id (the newest first): `{ t, file, commit }`, or null when no kept answer lists it. */
function findTarget(sessionId, targetId) {
  const per = targets.get(sessionId);
  if (!per || typeof targetId !== 'string') return null;
  for (const cand of [...per.values()].reverse()) {
    const file = cand.files.get(targetId) || null;
    const commit = file ? null : cand.commits.get(targetId) || null;
    if (file || commit) return { t: cand, file, commit };
  }
  return null;
}

/** The two revisions a file row's cut names, as full SHAs: `{ from, to }` (`to` null = the working tree), or null. */
async function cutRevisions(co, file, look) {
  const cut = file.cut;
  // An end the app wrote from version-control output is used as it is; one out of a transcript (a push) is resolved.
  const trustedOr = async (sha, trusted) => (trusted && sha && FULL_SHA_RE.test(sha) ? sha : resolveSha(co, sha, look));
  const from = cut ? await trustedOr(cut.fromSha, cut.fromTrusted) : null;
  if (!from) return null;
  let to = null;
  if (cut && !cut.working) {
    to = await trustedOr(cut.toSha, cut.toTrusted);
    if (!to) return null;
  }
  return { from, to };
}

async function diff(sessionId, targetId) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  const found = findTarget(sessionId, targetId);
  if (!found) return { ok: false, error: MSG.stale };
  const { t, file, commit } = found;
  if (!t.provider || !t.root) return { ok: false, error: MSG.noDiff };
  const co = { provider: t.provider, root: t.root };
  const look = newLookup(4);
  if (commit) {
    const sha = await resolveSha(co, commit.rawSha, look);
    if (!sha) return { ok: false, error: MSG.noDiff };
    const r = await run(co.provider, co.root, () => co.provider.showCommitArgs(sha), CAP_LOG);
    if (!r.ok) return { ok: false, error: MSG.failed };
    const c = co.provider.parseLog(r.stdout, 4)[0];
    return c ? { ok: true, kind: 'commit', commit: { sha: c.sha.slice(0, model.SHORT_SHA), time: c.time, subject: c.subject, body: c.body } } : { ok: false, error: MSG.noDiff };
  }
  const abs = path.resolve(co.root, file.key);
  if (file.outside || !isAtOrInside(abs, co.root)) return { ok: false, error: MSG.outside };
  if (file.isNew) {
    // An untracked file has no committed side: the hardened reader shows it as all added.
    const res = require('./vcs').readUntrackedDiff(co.root, file.key);
    return res && res.ok ? { ok: true, kind: 'file', text: res.text || '', note: res.note || null } : { ok: false, error: MSG.noDiff };
  }
  const revs = await cutRevisions(co, file, look);
  if (!revs) return { ok: false, error: MSG.noDiff };
  const { from, to } = revs;
  const r = await run(co.provider, co.root, () => co.provider.diffArgs({ path: file.key, rev: from, to }), CAP_DIFF);
  if (!r.ok) return { ok: false, error: r.refused ? MSG.noDiff : MSG.failed };
  return { ok: true, kind: 'file', text: r.stdout, base: from.slice(0, model.SHORT_SHA), working: !to };
}

/**
 * The old and new text of a file row for the side-by-side window (`vcs.js` `fileVersions`): the cut's baseline against the
 * working copy, or against the push that ended the block. By row id, like `diff`; an untracked file has no old side.
 */
async function versions(sessionId, targetId) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  const found = findTarget(sessionId, targetId);
  if (!found || !found.file) return { ok: false, error: MSG.stale };
  const { t, file } = found;
  if (!t.provider || !t.root) return { ok: false, error: MSG.noDiff };
  const co = { provider: t.provider, root: t.root };
  const abs = path.resolve(co.root, file.key);
  if (file.outside || !isAtOrInside(abs, co.root)) return { ok: false, error: MSG.outside };
  const vcsApp = require('./vcs');
  if (file.isNew) return vcsApp.fileVersions(co.root, file.key, 'untracked', false);
  const revs = await cutRevisions(co, file, newLookup(4));
  if (!revs) return { ok: false, error: MSG.noDiff };
  if (quitting()) return { ok: false, error: MSG.quitting };
  return vcsApp.fileVersions(co.root, file.key, '', false, revs);
}

/** A name for a window title: the checkout's folder name, nothing from the session's text. */
function labelOf(sessionId) {
  const row = ctx && typeof ctx.getCachedSession === 'function' ? ctx.getCachedSession(sessionId) : null;
  if (!row) return null;
  const p = String(row.projectPath || '').replace(/[\\/]+$/, '');
  return p ? p.split(/[\\/]/).pop() : '';
}

/** Open (or focus) the Details window of a session. The renderer sends a session id and where to land, never a path. */
function openDetails(sessionId, at) {
  if (quitting() || typeof sessionId !== 'string' || !sessionId) return { ok: false };
  const label = labelOf(sessionId);
  if (label === null) return { ok: false, error: MSG.notFound };
  return { ok: require('./vcs').openDetailsWindow(sessionId, { at, label }) === true };
}

/** A large diff of a listed file row in its own side-by-side window; the id must be one a kept answer holds. */
function openDiffWindow(sessionId, targetId) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  const found = findTarget(sessionId, targetId);
  if (!found || !found.file) return { ok: false, error: MSG.stale };
  if (!found.t.provider || !found.t.root) return { ok: false, error: MSG.noDiff };
  if (found.file.outside) return { ok: false, error: MSG.outside };
  const name = String(found.file.key).split('/').pop();
  return { ok: require('./vcs').openSessionDiffWindow(sessionId, targetId, name) === true };
}

/**
 * The file a row names, for Open: the contained absolute path, by the id of a file row of a recent answer (never a path from
 * the renderer). The row's key is relative to the checkout root, so only main can say which file it is when a session
 * runs in a subfolder. The renderer hands the path to the preview, whose reader has its own guards.
 */
function open(sessionId, targetId) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  const per = targets.get(sessionId);
  if (!per || typeof targetId !== 'string') return { ok: false, error: MSG.stale };
  let file = null;
  let t = null;
  for (const cand of [...per.values()].reverse()) {
    file = cand.files.get(targetId) || null;
    if (file) { t = cand; break; }
  }
  if (!file) return { ok: false, error: MSG.stale };
  const base = t.root || t.cwd;
  if (file.outside || !base) return { ok: false, error: MSG.openOutside };
  const abs = path.resolve(base, file.key);
  if (!isAtOrInside(abs, base)) return { ok: false, error: MSG.openOutside };
  return { ok: true, path: abs };
}

/**
 * Clear (spec 47 section 5, V2, D5): one `clear` entry at the session's current position, with the previous review point
 * (`fromSha`), HEAD (`toSha`) and the per-file counts there. It moves "Since last review" only. `{ missing: true }` is
 * E2's "Set review point to now": the same entry with `fromSha` null (the previous point is gone).
 */
async function clear(sessionId, opts) {
  if (quitting()) return { ok: false, error: MSG.quitting };
  const g = typeof sessionId === 'string' && sessionId ? gatherDb(sessionId, model.cleanRequest({})) : null;
  if (!g) return { ok: false, error: MSG.notFound };
  if (g.input.reports === false) return { ok: false, error: MSG.noDiff };
  const co = checkoutOf(g.row.projectPath);
  await ensureTimeline(g.lin, co, g.changes);
  let head = null;
  if (co) {
    const h = await run(co.provider, co.root, () => co.provider.headArgs(), CAP_SMALL);
    const out = h.ok ? h.stdout.trim() : '';
    head = FULL_SHA_RE.test(out) ? out : null;
  }
  if (quitting()) return { ok: false, error: MSG.quitting };
  const s = store();
  const list = s.listChangeEntries(g.lin.lineageId);
  let prev = null;
  for (let i = list.length - 1; i >= 0 && !prev; i--) {
    const e = list[i];
    const sha = e.kind === 'clear' ? e.toSha : e.sha;
    if (sha) prev = { sha, position: e.position };
  }
  // The session the review is taken in: the lineage's session with the newest activity. `order` is depth first, so its
  // last id is the newest only along a straight chain; two `/clear` children of one parent make a branch, and the one
  // the user works in now is the one that moved last.
  let last = g.lin.order[g.lin.order.length - 1];
  let lastAt = -Infinity;
  for (const sid of g.lin.order) {
    const r = g.lin.rows.get(sid);
    const at = r ? (toMs(r.lastEntryAt) ?? toMs(r.modified) ?? -Infinity) : -Infinity;
    if (at >= lastAt) { lastAt = at; last = sid; }
  }
  const row = (g.changes && g.changes.get(last)) || EMPTY;
  const entry = s.addChangeEntry('clear', {
    lineageId: g.lin.lineageId, sessionId: last, position: maxPosition(row) ?? 0, at: nowMs(),
    fromSha: opts && opts.missing === true ? null : (prev ? prev.sha : null), toSha: head,
    fromPosition: prev ? prev.position : null, files: row.files,
  });
  if (!entry) return { ok: false, error: MSG.failed };
  lastGood.delete(sessionId);
  return { ok: true, entry: { id: entry.id, at: entry.at, sha: head ? head.slice(0, model.SHORT_SHA) : null } };
}

/** V4: the range and view kept for a session. A pick end is an entry id or a push tick's key (the store validates it). */
function getView(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const r = storedRequest(sessionId);
  return { range: r.range, view: r.view, pickFrom: r.pickFrom, pickTo: r.pickTo };
}

function setView(sessionId, value) {
  if (typeof sessionId !== 'string' || !sessionId || quitting()) return { ok: false };
  const s = store();
  if (typeof s.setChangesView !== 'function') return { ok: false };
  if (value === null) s.setChangesView(sessionId, null);
  else {
    const r = model.cleanRequest(value || {});
    s.setChangesView(sessionId, cleanChangesView({ range: r.range, view: r.view, pickFrom: r.pickFrom, pickTo: r.pickTo }));
  }
  // The range and view are shared by every window that shows this session (the sidebar group, Details): the ones that
  // follow it read again, so a change made in one is seen in the other.
  notifyFollowers(sessionId);
  return { ok: true };
}

// --- following: what makes an open group read again (spec 47 section 4, "Triggers") ---
//
// No timer. A followed session is read again when (a) the poller's status for ITS checkout moved (a status that reads
// the same as the last one is dropped here: the poller reports every poll) or (b) a scan wrote `changes` for a session of
// its lineage. Either way main only sends `session-changes-updated` { sessionId } to the windows that follow it; the
// window asks `session-changes-state` again, so one refresh runs per trigger and nothing else. The subscription is the
// window's: it ends on unfollow, on the window's `destroyed` and on a main-frame navigation, and the last one for a
// session calls `forget` and releases the folder. Following a session also makes main follow its folder with the poller
// (`ctx.followFolder`, one key per session), so the group never reports a folder itself and two groups cannot overwrite
// each other's list.

const CHANGED_CHANNEL = 'session-changes-updated';
const followed = new Map();        // sessionId -> { cwd, sig, subs: Map<senderKey, sender> }
const wiredSenders = new Set();    // senderKeys whose `destroyed` / `did-start-navigation` listeners are on: added once, gone with the window
let offVcsStatus = null;
const folderKey = (sessionId) => 'changes:' + sessionId;
function releaseFolder(sessionId) {
  if (ctx && typeof ctx.followFolder === 'function') { try { ctx.followFolder(folderKey(sessionId), null); } catch { /* best effort */ } }
}

const senderKeyOf = (sender) => (sender && sender.id != null ? sender.id : 'main');

const statusSig = (summary) => { try { return summary ? JSON.stringify(summary) : null; } catch { return null; } };

function statusOf(cwd) {
  try { return typeof ctx.getVcsStatus === 'function' ? statusSig(ctx.getVcsStatus(cwd)) : null; } catch { return null; }
}

function notifyFollowers(sessionId) {
  const f = followed.get(sessionId);
  if (!f || quitting()) return;
  for (const [key, sender] of [...f.subs]) {
    if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) { dropSub(sessionId, key); continue; }
    try { sender.send(CHANGED_CHANNEL, { sessionId }); } catch { dropSub(sessionId, key); }
  }
}

function onVcsStatus(cwd, summary) {
  if (quitting()) return;
  const sig = statusSig(summary);
  for (const [sessionId, f] of [...followed]) {
    if (f.cwd !== cwd || sig === f.sig) continue;
    // null -> first status notifies too: a folder followed for the first time had no cached status, so the opening read
    // had no untracked files and no "new" marks; this re-ask is the one that adds them.
    f.sig = sig;
    notifyFollowers(sessionId);
  }
}

function dropSub(sessionId, key) {
  const f = followed.get(sessionId);
  if (!f || !f.subs.delete(key)) return;
  if (f.subs.size) return;
  followed.delete(sessionId);
  forget(sessionId);
  releaseFolder(sessionId);
  if (!followed.size && offVcsStatus) { offVcsStatus(); offVcsStatus = null; }
}

// A navigation ends the window's subscriptions but keeps its listeners (the same page object follows again after the
// reload); `destroyed` ends both. Re-wiring on every reload would pile up listeners.
function dropWindow(key, { destroyed = false } = {}) {
  for (const sessionId of [...followed.keys()]) dropSub(sessionId, key);
  if (destroyed) wiredSenders.delete(key);
}

/** A window follows a session's answer. `sender` is the window's webContents (or a stand-in with `id`, `send`, `once`). */
function follow(sessionId, sender) {
  if (typeof sessionId !== 'string' || !sessionId || !sender || quitting()) return { ok: false };
  const row = ctx.getCachedSession(sessionId);
  if (!row) return { ok: false };
  const key = senderKeyOf(sender);
  let f = followed.get(sessionId);
  if (!f) {
    f = { cwd: row.projectPath || '', sig: statusOf(row.projectPath || ''), subs: new Map() };
    followed.set(sessionId, f);
    // The poller polls this folder while the session is followed, chip or no chip; the status signature above and the
    // push compare use this same string.
    if (f.cwd && typeof ctx.followFolder === 'function') { try { ctx.followFolder(folderKey(sessionId), f.cwd); } catch { /* best effort */ } }
  }
  f.subs.set(key, sender);
  if (!offVcsStatus && typeof ctx.onVcsStatus === 'function') offVcsStatus = ctx.onVcsStatus(onVcsStatus) || null;
  if (!wiredSenders.has(key) && typeof sender.once === 'function') {
    wiredSenders.add(key);
    sender.once('destroyed', () => dropWindow(key, { destroyed: true }));
    // A reload builds the sidebars anew, so what the old page followed is stale when the navigation starts.
    if (typeof sender.on === 'function') {
      sender.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) dropWindow(key); });
    }
  }
  return { ok: true };
}

function unfollow(sessionId, sender) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  dropSub(sessionId, senderKeyOf(sender));
}

/**
 * The scan wrote `changes` for these sessions (`applyIndexResults`): a followed session whose lineage or subagents are
 * among them is asked about again. A closed group follows nothing, so it costs nothing here.
 */
function noteScanWrite(sessionIds) {
  if (!followed.size || !Array.isArray(sessionIds) || !sessionIds.length || quitting()) return;
  const wrote = new Set(sessionIds);
  for (const sessionId of [...followed.keys()]) {
    let ids = [sessionId];
    try {
      const lin = lineageOf(sessionId);
      if (lin) ids = [...lin.order, ...subagentsOf(lin.order).map((s) => s.sessionId)];
    } catch { /* the session itself still counts */ }
    if (ids.some((id) => wrote.has(id))) notifyFollowers(sessionId);
  }
}

const optsOf = (o) => (o && typeof o === 'object' ? {
  range: o.range, view: o.view, pickFrom: o.pickFrom, pickTo: o.pickTo, fresh: o.fresh === true,
} : {});

function registerIpc(ipc) {
  ipc.handle('session-changes-summary', (_e, sessionId) => summary(sessionId));
  ipc.handle('session-changes-state', (_e, sessionId, opts) => state(sessionId, optsOf(opts)));
  ipc.handle('session-changes-details', (_e, sessionId, opts) => details(sessionId, optsOf(opts)));
  ipc.handle('session-changes-diff', (_e, sessionId, targetId) => diff(sessionId, typeof targetId === 'string' ? targetId : null));
  ipc.handle('session-changes-open', (_e, sessionId, targetId) => open(sessionId, typeof targetId === 'string' ? targetId : null));
  // The Details window (spec 47 section 7): `at` is `{ id }` of a row, `{ pick: true }` or `{}`; the window holds a session id only.
  ipc.handle('session-changes-open-details', (_e, sessionId, at) => openDetails(sessionId, at));
  // A large diff in the side-by-side window, and the two sides it draws, both by row id.
  ipc.handle('session-changes-open-diff-window', (_e, sessionId, targetId) => openDiffWindow(sessionId, typeof targetId === 'string' ? targetId : null));
  ipc.handle('session-changes-versions', (_e, sessionId, targetId) => versions(sessionId, typeof targetId === 'string' ? targetId : null));
  ipc.handle('session-changes-clear', (_e, sessionId, opts) => clear(sessionId, { missing: !!(opts && opts.missing === true) }));
  ipc.handle('session-changes-entries', (_e, sessionId, opts) => entries(sessionId, optsOf(opts)));
  ipc.handle('session-changes-view-get', (_e, sessionId) => getView(sessionId));
  ipc.handle('session-changes-view-set', (_e, sessionId, value) => setView(sessionId, value));
  // The Changes group follows while it is open and shown (spec 47 section 4); fire-and-forget like `vcs-follow`.
  ipc.handle('session-changes-follow', (e, sessionId) => follow(sessionId, e && e.sender));
  ipc.on('session-changes-unfollow', (e, sessionId) => { unfollow(sessionId, e && e.sender); });
}

module.exports = {
  init, registerIpc, summary, state, details, entries, diff, versions, open, openDetails, openDiffWindow, clear, getView, setView, forget, follow, unfollow, noteScanWrite,
  SPAWN_BOUND: 2 + 2 + 2 * (MAX_CUT_RESOLVE + MAX_RESOLVE) + MAX_NUMSTAT_CUTS,
  _lineageOf: (id) => lineageOf(id),
  _followedSessions: () => [...followed.keys()],
  _hasTargets: (id) => targets.has(id),
};
