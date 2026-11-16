'use strict';
// Row shapes, caps and "since" arithmetic of the session-changes tables (#870, spec 47 section 3). Pure and outside the
// store, because no test loads a module that opens the database (`.claude/rules/db.md`). The store (T3) writes what
// `normalizeChanges` returns; the model (T9) reads counts through the helpers below. Requires only the neutral accumulator
// for the caps the parsers already apply, so the two cannot disagree.
//
// Shapes (all numbers are `null` when unknown):
//   changes  { files: [{ path, count, first, last, at }], commits: [{ sha, subject, branch, position, at, amend? }],
//              pushes: [{ ok, summary, position, at, upToDate?, force?, files?: [[path, count]], truncated? }], truncated }
//   snapshot [[path, count], ...]   the per-file edit counts at one position (a push, a Clear, a start)
//   entry    { kind, lineageId, sessionId, position, at, sha, fromSha, toSha, fromPosition, files, truncated }
//            kind: start | clear | cli-clear | push  (D1: one timeline per lineage)
//
// Counts since a baseline are a subtraction (D3, D4): `diffCounts(totalsNow, snapshotAtBaseline)`. Nothing here stores a
// per-edit row.
//
// D6 (spec 47): a `position` is comparable only inside ONE session id. A lineage is ordered by its entries, each entry belongs
// to exactly one session, and `rangeSessions` says which sessions a range takes whole and which it cuts by position. A
// subagent session is atomic (`subagentInRange`, by its last activity time). `touchedSince` / `eventsSince` therefore take
// `{ sessionId, position }` and never compare positions of two sessions.

const {
  MAX_FILES, MAX_COMMITS, MAX_PUSHES, MAX_SNAPSHOT_FILES, MAX_PATH_CHARS, MAX_SUBJECT_CHARS, MAX_BRANCH_CHARS,
  MAX_SUMMARY_CHARS, SHA_RE,
} = require('../backends/change-events');

const MAX_TIMELINE_ENTRIES = 500;     // entries per lineage
const MAX_SNAPSHOT_BYTES = 65536;     // JSON bytes of one stored snapshot (a Clear's or a push's file list): MAX_FILES paths of ~90 characters fit (~45 KB measured on normal paths)
const MAX_SHA_CHARS = 64;
const ENTRY_KINDS = Object.freeze(['start', 'clear', 'cli-clear', 'push']);

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const text = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');
const isEntryKind = (k) => ENTRY_KINDS.includes(k);

/** A count pair list or `{ path, count }` list as `[[path, count]]`, positive integers only, first spelling of a path wins. */
function pairsOf(files) {
  const out = [];
  if (!Array.isArray(files)) return out;
  const seen = new Set();
  for (const f of files) {
    const path = Array.isArray(f) ? f[0] : f && f.path;
    const count = Array.isArray(f) ? f[1] : f && f.count;
    if (typeof path !== 'string' || !path || path.length > MAX_PATH_CHARS || seen.has(path)) continue;
    if (!Number.isInteger(count) || count < 1) continue;
    seen.add(path);
    out.push([path, count]);
  }
  return out;
}

/** A snapshot cut to `MAX_SNAPSHOT_FILES` files and `MAX_SNAPSHOT_BYTES` of JSON: `{ files, truncated }`. */
function normalizeSnapshot(files) {
  const all = pairsOf(files);
  const kept = [];
  let bytes = 2;
  let truncated = all.length > MAX_SNAPSHOT_FILES;
  for (const pair of all.slice(0, MAX_SNAPSHOT_FILES)) {
    bytes += JSON.stringify(pair).length + 1;
    if (bytes > MAX_SNAPSHOT_BYTES) { truncated = true; break; }
    kept.push(pair);
  }
  return { files: kept, truncated };
}

/**
 * The clean `changes` of a parsed row (or of stored JSON): types checked, strings and lists cut to the caps, `truncated`
 * set when anything was cut. `null` for a value that is not an object.
 */
function normalizeChanges(row) {
  if (!row || typeof row !== 'object') return null;
  let truncated = row.truncated === true;
  const files = [];
  const seen = new Set();
  for (const f of Array.isArray(row.files) ? row.files : []) {
    if (!f || typeof f.path !== 'string' || !f.path || f.path.length > MAX_PATH_CHARS || seen.has(f.path)) continue;
    if (!Number.isInteger(f.count) || f.count < 1) continue;
    if (files.length >= MAX_FILES) { truncated = true; break; }
    seen.add(f.path);
    files.push({ path: f.path, count: f.count, first: num(f.first), last: num(f.last), at: num(f.at) });
  }
  const commits = [];
  const shas = new Set();
  for (const c of Array.isArray(row.commits) ? row.commits : []) {
    if (!c || typeof c.sha !== 'string' || c.sha.length > MAX_SHA_CHARS || !SHA_RE.test(c.sha) || shas.has(c.sha)) continue;
    if (commits.length >= MAX_COMMITS) { truncated = true; break; }
    shas.add(c.sha);
    const ev = { sha: c.sha, subject: text(c.subject, MAX_SUBJECT_CHARS), branch: text(c.branch, MAX_BRANCH_CHARS), position: num(c.position), at: num(c.at) };
    if (c.amend === true) ev.amend = true;
    commits.push(ev);
  }
  const pushes = [];
  for (const p of Array.isArray(row.pushes) ? row.pushes : []) {
    if (!p || typeof p !== 'object') continue;
    if (pushes.length >= MAX_PUSHES) { truncated = true; break; }
    const ev = { ok: p.ok === true, summary: text(p.summary, MAX_SUMMARY_CHARS), position: num(p.position), at: num(p.at) };
    if (p.upToDate === true) ev.upToDate = true;
    if (p.force === true) ev.force = true;
    if (p.moved === true) ev.moved = true;
    if (Array.isArray(p.files)) {
      const snap = normalizeSnapshot(p.files);
      ev.files = snap.files;
      if (snap.truncated || p.truncated === true) { ev.truncated = true; truncated = true; }
    }
    pushes.push(ev);
  }
  return { files, commits, pushes, truncated };
}

/** True when a normalised `changes` holds nothing: the store writes nothing for it (and a parser emits nothing). */
function isEmptyChanges(changes) {
  return !changes || (!changes.files.length && !changes.commits.length && !changes.pushes.length);
}

/**
 * A push that moved something and so ends a Split block (D2): it succeeded and was not "Everything up-to-date", or it was
 * partial (one ref refused, another moved: `moved`). A push that moved nothing cuts nothing.
 */
function isCuttingPush(ev) {
  return !!ev && (ev.moved === true || (ev.ok === true && ev.upToDate !== true));
}

/** One timeline entry, normalised; `null` for an unknown kind or without a lineage and session id. */
function makeEntry(kind, fields) {
  const f = fields || {};
  if (!isEntryKind(kind) || typeof f.lineageId !== 'string' || !f.lineageId || typeof f.sessionId !== 'string' || !f.sessionId) return null;
  const entry = {
    kind,
    lineageId: f.lineageId,
    sessionId: f.sessionId,
    position: num(f.position),
    at: num(f.at),
    sha: typeof f.sha === 'string' && f.sha.length <= MAX_SHA_CHARS ? f.sha : null,
    fromSha: typeof f.fromSha === 'string' && f.fromSha.length <= MAX_SHA_CHARS ? f.fromSha : null,
    toSha: typeof f.toSha === 'string' && f.toSha.length <= MAX_SHA_CHARS ? f.toSha : null,
    fromPosition: num(f.fromPosition),
    files: [],
    truncated: false,
  };
  if (f.files !== undefined) {
    const snap = normalizeSnapshot(f.files);
    entry.files = snap.files;
    entry.truncated = snap.truncated;
  }
  return entry;
}

/**
 * `Map<path, count>` of a pair list, a `{ path, count }` list, a snapshot object `{ files }` (a push event, a timeline entry)
 * or a Map (returned as is).
 */
function countsOf(files) {
  if (files instanceof Map) return files;
  if (files && !Array.isArray(files) && Array.isArray(files.files)) return new Map(pairsOf(files.files));
  return new Map(pairsOf(files));
}

/**
 * D3/D4: the edits made after `from` up to `to`: each file whose count in `to` exceeds its count in `from`, as
 * `[{ path, count }]` (the difference), most edits first, then by path. `from` absent means "from the start". A count that
 * went DOWN (a rescan that counts differently) contributes nothing rather than a negative.
 *
 * `from` may be a snapshot object whose `truncated` is true (it lost files to a cap). A file of `to` that such a snapshot does
 * not hold is UNKNOWN, not new: it is returned as `{ path, count: null, unknown: true }`, after the known ones, never as its
 * full total.
 */
function diffCounts(to, from) {
  const before = countsOf(from || []);
  const blind = !!from && !Array.isArray(from) && !(from instanceof Map) && from.truncated === true;
  const out = [];
  const unknown = [];
  for (const [path, count] of countsOf(to)) {
    if (blind && !before.has(path)) { unknown.push({ path, count: null, unknown: true }); continue; }
    const d = count - (before.get(path) || 0);
    if (d > 0) out.push({ path, count: d });
  }
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return out.sort((a, b) => b.count - a.count || byPath(a, b)).concat(unknown.sort(byPath));
}

/** Several count lists summed per path (a lineage's sessions, a parent and its subagents): `[[path, count]]`. */
function sumCounts(lists) {
  const total = new Map();
  for (const list of Array.isArray(lists) ? lists : []) {
    for (const [path, count] of countsOf(list)) total.set(path, (total.get(path) || 0) + count);
  }
  return Array.from(total);
}

const sameSession = (a, b) => !!a && !!b && typeof a.sessionId === 'string' && a.sessionId !== '' && a.sessionId === b.sessionId;

/**
 * D6: a file (`{ sessionId, last }`) is touched since a boundary (`{ sessionId, position }`) when its last edit lies after
 * the boundary position. Positions of two sessions are never compared: another session's file answers `null` ("not
 * comparable, the lineage order decides", see `rangeSessions`). An unknown position answers `false`.
 */
function touchedSince(file, from) {
  if (!sameSession(file, from)) return null;
  return num(file.last) !== null && num(from.position) !== null && file.last > from.position;
}

/**
 * D6: the events (`{ sessionId, position }`) of the boundary's OWN session recorded after its position, in their given order.
 * An event of another session is not returned (that session is taken whole or not at all by `rangeSessions`); an event without
 * a position is not after anything.
 */
function eventsSince(events, from) {
  return (Array.isArray(events) ? events : []).filter((e) => sameSession(e, from) && num(from.position) !== null && num(e.position) !== null && e.position > from.position);
}

/**
 * D6: which sessions of a lineage a range covers. `order` is the lineage's session ids in order (root first), `from` / `to` are
 * the boundary entries (`{ sessionId, position }`; `null` = the start / the end of the lineage). Returns
 * `Map<sessionId, { whole, fromPosition, toPosition }>`: a session strictly between the boundaries is `whole`; the boundary's
 * own session is cut by position (`fromPosition` / `toPosition`, `null` = open on that side; both boundaries in one session
 * cut it on both sides). A session outside the range is absent. `null` when a boundary names a session not in `order`, or
 * the boundaries are in reverse order.
 */
function rangeSessions(order, from, to) {
  if (!Array.isArray(order) || !order.length) return null;
  const first = from ? order.indexOf(from.sessionId) : 0;
  const last = to ? order.indexOf(to.sessionId) : order.length - 1;
  if (first < 0 || last < 0 || first > last) return null;
  if (first === last && from && to && num(from.position) !== null && num(to.position) !== null
      && num(from.position) > num(to.position)) return null;
  const out = new Map();
  for (let i = first; i <= last; i++) {
    const fromPosition = i === first && from ? num(from.position) : null;
    const toPosition = i === last && to ? num(to.position) : null;
    out.set(order[i], { whole: fromPosition === null && toPosition === null, fromPosition, toPosition });
  }
  return out;
}

/**
 * D6: a subagent session is atomic. It is in a range when its last activity time `sub.at` lies inside `[from.at, to.at]` (an
 * open side is `null`); otherwise it is out. A documented approximation: its edits are not in the parent's push snapshots, so
 * they cannot be cut by position. A subagent without a time is out.
 */
function subagentInRange(sub, from, to) {
  const at = num(sub && sub.at);
  if (at === null) return false;
  const lo = from ? num(from.at) : null;
  const hi = to ? num(to.at) : null;
  return (lo === null || at >= lo) && (hi === null || at <= hi);
}

module.exports = {
  normalizeChanges, normalizeSnapshot, isEmptyChanges, isCuttingPush, makeEntry, isEntryKind,
  pairsOf, countsOf, diffCounts, sumCounts, touchedSince, eventsSince, rangeSessions, subagentInRange,
  ENTRY_KINDS, MAX_TIMELINE_ENTRIES, MAX_SNAPSHOT_BYTES, MAX_SHA_CHARS,
  MAX_FILES, MAX_COMMITS, MAX_PUSHES, MAX_SNAPSHOT_FILES, MAX_PATH_CHARS, MAX_SUBJECT_CHARS, MAX_BRANCH_CHARS, MAX_SUMMARY_CHARS,
};
