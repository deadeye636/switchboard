'use strict';
// session-changes-model.js — the view model of a session's Changes group and its Details window (#870, spec 47).
//
// PURE: no database, no version control, no Electron, no filesystem. `src/app/session-changes.js` gathers the facts
// (the lineage order, the derived rows of every session, the timeline entries, what version control answered, the
// database's answer to "who else edited this file") and hands them in; this file decides what is drawn.
//
// The rules it applies (spec 47, "Timeline, range and views"):
//   - One timeline per lineage (D1): the stored entries (`start`, `clear`, `cli-clear`) and every CUTTING push of the
//     lineage's sessions (a push event with a snapshot, D4), ordered by the lineage's session order and, inside one
//     session, by position (D6: a position is comparable only inside one session id).
//   - A range always snaps to ticks (D3, V3) and is resolved into per-session cuts by `rangeSessions` (D6). A session's
//     counts in a cut are a snapshot difference (`diffCounts`, D4), always handed the ENTRY or EVENT object so a
//     truncated snapshot reports unknown files instead of full totals. A subagent is atomic (`subagentInRange`).
//   - All sums the range (E4: each file once, edits summed); Split cuts it at cutting pushes (D2), newest block first,
//     Clear and `/clear` as marks inside a block.
//   - The header figure always counts "Since last review" (V1).
//
// Path keys: the caller hands in `paths: Map<rawPath, { key, outside }>`; a file is one row per key (a transcript may
// spell one file two ways). The model never decides containment (reflex 13); it reads the answer.

const crypto = require('crypto');
const {
  diffCounts, rangeSessions, subagentInRange, isCuttingPush, MAX_FILES,
} = require('../db/changes-record');

const RANGES = Object.freeze(['since-review', 'today', 'since-push', 'whole', 'pick']);
const VIEWS = Object.freeze(['all', 'split']);
const DEFAULT_RANGE = 'since-review';
const DEFAULT_VIEW = 'all';
const SHORT_SHA = 7;

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, SHORT_SHA) : null);
const EMPTY_ROW = Object.freeze({ files: [], commits: [], pushes: [], truncated: false });

/** The range and view a caller asked for, cleaned: unknown values fall back to the defaults (V4). */
function cleanRequest(req) {
  const r = req || {};
  const kind = RANGES.includes(r.range) ? r.range : DEFAULT_RANGE;
  const view = VIEWS.includes(r.view) ? r.view : DEFAULT_VIEW;
  const id = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && v && v.length <= 300) ? v : null;
  return { range: kind, view, pickFrom: kind === 'pick' ? id(r.pickFrom) : null, pickTo: kind === 'pick' ? id(r.pickTo) : null };
}

// --- the timeline ---

const TIE = { start: 0, 'cli-clear': 0, push: 1, clear: 2 };

/**
 * The lineage's ticks in timeline order: stored entries plus the cutting pushes of the lineage's own sessions (subagent
 * pushes are not ticks: a subagent is atomic, D6). A lineage without a stored `start` gets an implicit one at the root's
 * beginning (no SHA). Entries of a session that is not in `order` are left out.
 */
function buildTicks({ order, rows, entries, startedAt }) {
  const idx = new Map((order || []).map((id, i) => [id, i]));
  const list = [];
  let seq = 0;
  let hasStart = false;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !idx.has(e.sessionId) || !Object.prototype.hasOwnProperty.call(TIE, e.kind) || e.kind === 'push') continue;
    if (e.kind === 'start') { if (hasStart) continue; hasStart = true; }
    list.push({
      id: e.id, kind: e.kind, sessionId: e.sessionId, position: num(e.position), at: num(e.at),
      sha: e.sha || null, fromSha: e.fromSha || null, toSha: e.toSha || null,
      snapshot: e.files && typeof e.files === 'object' ? e.files : null, seq: seq++,
    });
  }
  for (const sid of order || []) {
    const row = (rows && rows.get(sid)) || EMPTY_ROW;
    row.pushes.forEach((p, i) => {
      if (!isCuttingPush(p)) return;
      list.push({
        id: `push:${sid}:${p.position !== null && p.position !== undefined ? p.position : 'i' + i}`, kind: 'push', sessionId: sid,
        position: num(p.position), at: num(p.at), sha: typeof p.sha === 'string' && p.sha ? p.sha : null, fromSha: null, toSha: null, snapshot: p, event: p, seq: seq++,
      });
    });
  }
  if (!hasStart && order && order.length) {
    list.push({ id: 'start', kind: 'start', sessionId: order[0], position: null, at: num(startedAt), sha: null, fromSha: null,
      toSha: null, snapshot: null, implicit: true, seq: -1 });
  }
  const posKey = (t) => {
    if (t.position !== null) return t.position;
    if (t.kind === 'start' || t.kind === 'cli-clear') return -Infinity;
    if (t.kind === 'clear') return -0.5;  // a Clear taken before the session had any event
    return Infinity;                      // a push without a position: the end of its session
  };
  list.sort((a, b) => (idx.get(a.sessionId) - idx.get(b.sessionId)) || (posKey(a) - posKey(b))
    || (TIE[a.kind] - TIE[b.kind]) || (a.seq - b.seq));
  // A start is the first tick of its timeline, whatever its position says.
  const s = list.findIndex((t) => t.kind === 'start');
  if (s > 0) list.unshift(list.splice(s, 1)[0]);
  return list;
}

/** Is tick `a` before `b` in the lineage (session order, then position)? Used for commits, which are not ticks. */
function orderKey(idx, sessionId, position) {
  return [idx.has(sessionId) ? idx.get(sessionId) : -1, position === null ? Infinity : position];
}
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** Local midnight of `now` (V3's "today"). */
function midnightOf(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The earliest activity time at or after `since` in the lineage's rows and its subagents' (a file's last edit, an event). */
function firstActivitySince(rowsList, since) {
  let first = null;
  const see = (at) => { if (num(at) !== null && at >= since && (first === null || at < first)) first = at; };
  for (const row of rowsList) {
    for (const f of row.files) see(f.at);
    for (const c of row.commits) see(c.at);
    for (const p of row.pushes) see(p.at);
  }
  return first;
}

/**
 * Which ticks bound a range: `{ from, to, empty, todayAt, approxStart }` as indexes into `ticks` (`to` null = now).
 * Snaps to ticks (D3). "Today" (V3): the first tick of today when there is one. Without one, the first edit of today is a
 * derived tick, never stored; it has no snapshot, so the range starts at the tick before it and `approxStart` says the
 * first block's counts include that block's earlier work. With no activity today the range is empty.
 */
function resolveRange(ticks, req, { now, rowsList }) {
  const last = (pred) => { for (let i = ticks.length - 1; i >= 0; i--) if (pred(ticks[i])) return i; return -1; };
  const out = { from: 0, to: null, empty: false, todayAt: null, approxStart: false };
  if (!ticks.length) { out.empty = true; return out; }
  switch (req.range) {
    case 'since-review': { const i = last((t) => t.kind === 'clear'); out.from = i < 0 ? 0 : i; break; }
    case 'since-push': { const i = last((t) => t.kind === 'push'); out.from = i < 0 ? 0 : i; break; }
    case 'whole': break;
    case 'today': {
      const midnight = midnightOf(now);
      const activity = firstActivitySince(rowsList, midnight);
      const firstTick = ticks.findIndex((t) => num(t.at) !== null && t.at >= midnight);
      const tickAt = firstTick >= 0 ? ticks[firstTick].at : null;
      if (activity === null && tickAt === null) { out.from = ticks.length - 1; out.empty = true; break; }
      out.todayAt = activity === null ? tickAt : tickAt === null ? activity : Math.min(activity, tickAt);
      if (tickAt !== null) { out.from = firstTick; break; }
      // No tick today: the first edit of today is the derived start. Snap back to the tick whose block holds it (never
      // cut a block, D3); that block's earlier work is then counted too, and the flag says so.
      let i = ticks.length - 1;
      while (i > 0 && !(num(ticks[i].at) !== null && ticks[i].at <= activity)) i--;
      out.from = i;
      out.approxStart = true;
      break;
    }
    case 'pick': {
      const find = (id) => (id === null ? -1 : ticks.findIndex((t) => t.id === id));
      let a = find(req.pickFrom);
      let b = find(req.pickTo);
      if (a < 0) a = 0;
      if (b >= 0 && b < a) [a, b] = [b, a];
      out.from = a;
      out.to = b < 0 ? null : b;
      if (out.to === out.from) out.empty = true;
      break;
    }
    default: break;
  }
  return out;
}

// --- one cut of the lineage: the counts and events between two ticks ---

/** The `rangeSessions` boundary of a FROM tick: null for the lineage's beginning. */
function fromBoundary(tick) {
  if (!tick || (tick.kind === 'start' && tick.position === null)) return null;
  return { sessionId: tick.sessionId, position: tick.position, at: tick.at };
}

/**
 * The `rangeSessions` boundary of a TO tick (null = now). A tick without a position is the very start of its session (a
 * `/clear` child's `cli-clear`): the cut then ends with the PREVIOUS session, whole. `undefined` when nothing is before it.
 */
function toBoundary(tick, order) {
  if (!tick) return null;
  if (tick.position !== null) return { sessionId: tick.sessionId, position: tick.position, at: tick.at };
  const i = order.indexOf(tick.sessionId);
  if (i <= 0) return undefined;
  return { sessionId: order[i - 1], position: null, at: tick.at };
}

/** The commits of every session that a later amend replaced (E3: the amend's SHA takes the old one's place). */
function replacedCommits(rowsBySession) {
  const gone = new Set();
  for (const row of rowsBySession.values()) {
    const sorted = row.commits.slice().sort((a, b) => (num(a.position) ?? Infinity) - (num(b.position) ?? Infinity));
    let prev = null;
    for (const c of sorted) {
      if (c.amend && prev) gone.add(prev);
      prev = c;
    }
  }
  return gone;
}

/**
 * The files and commits between two ticks: `{ files: Map<key, agg>, commits: [{ c, sessionId, sub }] }`. Counts are
 * snapshot differences per session (D4), subagents are whole or out (D6), files are united by key (E4).
 */
function cutBetween(ctx, fromTick, toTick) {
  const { order, rows, subagents, keyOf, replaced } = ctx;
  const files = new Map();
  const commits = [];
  const fromB = fromBoundary(fromTick);
  const toB = toBoundary(toTick, order);
  if (toB === undefined) return { files, commits };
  const cuts = rangeSessions(order, fromB, toB) || new Map();
  const addFile = (path, count, unknown, at, sessionId) => {
    const key = keyOf(path);
    let f = files.get(key);
    if (!f) { f = { key, paths: new Set(), count: 0, known: false, unknown: false, lastAt: null, sessions: new Set() }; files.set(key, f); }
    f.paths.add(path);
    f.sessions.add(sessionId);
    if (unknown) f.unknown = true; else { f.count += count; f.known = true; }
    if (num(at) !== null && (f.lastAt === null || at > f.lastAt)) f.lastAt = at;
  };
  for (const [sid, cut] of cuts) {
    const row = rows.get(sid) || EMPTY_ROW;
    const atOf = new Map(row.files.map((f) => [f.path, f.at]));
    const fromSnap = fromTick && fromTick.sessionId === sid && cut.fromPosition !== null ? fromTick.snapshot : null;
    const toSnap = toTick && toTick.sessionId === sid && cut.toPosition !== null ? toTick.snapshot : null;
    // R2: the snapshot OBJECTS (entry `files` / push event), never their lists, so a truncated snapshot stays unknown.
    for (const d of diffCounts(toSnap || row.files, fromSnap)) addFile(d.path, d.count, d.unknown === true, atOf.get(d.path), sid);
    for (const c of row.commits) {
      if (replaced.has(c)) continue;
      const p = num(c.position);
      if (!cut.whole && p === null) continue;
      if (cut.fromPosition !== null && !(p > cut.fromPosition)) continue;
      if (cut.toPosition !== null && !(p <= cut.toPosition)) continue;
      commits.push({ c, sessionId: sid, sub: false });
    }
  }
  const subFrom = fromB ? { at: fromB.at } : null;
  const subTo = toB ? { at: toTick ? toTick.at : null } : null;
  for (const sub of subagents) {
    if (!subagentInRange(sub, subFrom, subTo)) continue;
    const row = rows.get(sub.sessionId) || EMPTY_ROW;
    for (const f of row.files) addFile(f.path, f.count, false, f.at, sub.sessionId);
    for (const c of row.commits) if (!replaced.has(c)) commits.push({ c, sessionId: sub.sessionId, sub: true });
  }
  return { files, commits };
}

// --- SHAs a cut is measured between ---

/** The fallback tip of a push that recorded no SHA (a new branch prints none): the newest lineage commit before it. */
function pushTipSha(ctx, tick) {
  const pk = orderKey(ctx.idx, tick.sessionId, tick.position);
  let best = null;
  for (const sid of ctx.order) {
    const row = ctx.rows.get(sid) || EMPTY_ROW;
    for (const c of row.commits) {
      if (ctx.replaced.has(c)) continue;
      const ck = orderKey(ctx.idx, sid, num(c.position));
      if (!before(ck, pk)) continue;
      if (!best || before(best.k, ck)) best = { k: ck, sha: c.sha };
    }
  }
  return best ? best.sha : null;
}

/** The SHA a tick stands for: a start's baseline, a Clear's HEAD, a push's tip; else the nearest earlier tick's. */
function shaOfTick(ctx, i) {
  const s = sourcedShaOfTick(ctx, i);
  return s ? s.sha : null;
}

/**
 * The same, with where it came from: `trusted` when the app wrote it from version-control output (a start's baseline,
 * a Clear's HEAD), false for one read out of a transcript (a push's SHA or tip), which must be resolved before use.
 */
function sourcedShaOfTick(ctx, i) {
  for (let j = i; j >= 0; j--) {
    const t = ctx.ticks[j];
    if (t.kind === 'push') {
      const sha = t.sha || pushTipSha(ctx, t);
      if (sha) return { sha, trusted: false };
    } else {
      const sha = t.kind === 'clear' ? t.toSha : t.sha;
      if (sha) return { sha, trusted: true };
    }
  }
  return null;
}

// --- rows for the renderer ---

/**
 * A row id the renderer hands back for a diff: derived from what the row IS (the cut it was measured in and its key),
 * so the same id names the same file in every answer, and an id from another range or an older timeline names nothing.
 */
function fileIdOf(cutId, key) {
  return 'f:' + crypto.createHash('sha1').update(`${cutId}|${key}`).digest('hex').slice(0, 20);
}

function fileRows(cut, ctx, numstat, cutId) {
  const { facts } = ctx;
  const out = [];
  for (const f of cut.files.values()) {
    if (!f.known && !f.unknown) continue;
    if (f.known && f.count <= 0 && !f.unknown) continue;
    const ns = numstat ? numstat.get(f.key) : null;
    const outside = !!(facts.outside && facts.outside.has(f.key));
    out.push({
      id: fileIdOf(cutId, f.key),
      key: f.key,
      count: f.known ? f.count : null,
      unknown: f.unknown,
      isNew: !!(facts.untracked && facts.untracked.has(f.key)),
      outside,
      otherSessions: (facts.editedByOthers && facts.editedByOthers.get(f.key)) || 0,
      added: ns && !outside ? ns.added : null,
      deleted: ns && !outside ? ns.deleted : null,
      binary: !!(ns && ns.binary),
      lastAt: f.lastAt,
    });
  }
  return out.sort((a, b) => ((b.count || 0) - (a.count || 0)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function commitRows(cut, ctx) {
  const { vcs, idx, ticks } = ctx;
  const pushes = ticks.filter((t) => t.kind === 'push');
  const rows = cut.commits.map(({ c, sessionId, sub }) => {
    const ck = orderKey(idx, sessionId, num(c.position));
    const push = pushes.find((p) => (sub ? num(p.at) !== null && num(c.at) !== null && p.at >= c.at
      : before(ck, orderKey(idx, p.sessionId, p.position))));
    const inHistory = vcs && vcs.inHistory ? vcs.inHistory.get(c.sha) : undefined;
    return {
      id: 'c:' + c.sha, sha: short(c.sha), rawSha: c.sha, subject: c.subject || '', at: num(c.at), sessionId, subagent: sub,
      pushed: !!push, pushedAt: push ? push.at : null, rewritten: inHistory === false, amend: c.amend === true,
      _k: ck,
    };
  });
  rows.sort((a, b) => (before(a._k, b._k) ? 1 : before(b._k, a._k) ? -1 : (b.at || 0) - (a.at || 0)));
  return rows.map(({ _k, ...r }) => r);
}

function totalsOf(files, commits) {
  let edits = 0; let added = 0; let deleted = 0; let measured = false;
  for (const f of files) {
    edits += f.count || 0;
    if (f.added !== null) { added += f.added; deleted += f.deleted || 0; measured = true; }
  }
  return {
    files: files.length, commits: commits.length, notPushed: commits.filter((c) => !c.pushed && !c.rewritten).length,
    edits, added: measured ? added : null, deleted: measured ? deleted : null,
  };
}

function tickView(t, ctx, i) {
  return { id: t.id, kind: t.kind, at: t.at, sha: short(shaOfTick(ctx, i)), implicit: !!t.implicit };
}

// --- the model ---

function contextOf(input) {
  const order = Array.isArray(input.order) ? input.order.filter((s) => typeof s === 'string' && s) : [];
  const rows = input.rows instanceof Map ? input.rows : new Map();
  const subagents = (Array.isArray(input.subagents) ? input.subagents : []).filter((s) => s && typeof s.sessionId === 'string');
  const paths = input.paths instanceof Map ? input.paths : new Map();
  const keyOf = (p) => { const k = paths.get(p); return k && typeof k.key === 'string' && k.key ? k.key : p; };
  const allRows = [...order, ...subagents.map((s) => s.sessionId)].map((s) => rows.get(s) || EMPTY_ROW);
  const ticks = buildTicks({ order, rows, entries: input.entries, startedAt: input.startedAt });
  const ctx = {
    order, rows, subagents, keyOf, ticks, allRows, idx: new Map(order.map((id, i) => [id, i])),
    facts: input.facts || {}, vcs: input.vcs || null,
  };
  ctx.replaced = replacedCommits(new Map([...order, ...subagents.map((s) => s.sessionId)].map((s) => [s, rows.get(s) || EMPTY_ROW])));
  return ctx;
}

/** V1: the header figure, "Since last review" whatever is picked. `{ files, commits }`, or null when there is nothing. */
function figureOf(ctx) {
  if (!ctx.order.length) return null;
  const r = resolveRange(ctx.ticks, { range: 'since-review' }, { now: 0, rowsList: ctx.allRows });
  const cut = cutBetween(ctx, ctx.ticks[r.from], null);
  let files = 0;
  for (const f of cut.files.values()) if ((f.known && f.count > 0) || f.unknown) files++;
  const commits = cut.commits.length;
  return files || commits ? { files, commits } : null;
}

/**
 * The model the group and Details draw. Input:
 *   reports      false when the session's backend declares it does not report (the "does not report" state)
 *   sessionId    the asked session; order: the lineage's session ids, root first; startedAt: the root's start (ms)
 *   rows         Map<sessionId, changes> (`getSessionChanges`), for the lineage and its subagents
 *   subagents    [{ sessionId, at }] (last activity time, ms)
 *   entries      the lineage's stored entries (`listEntries`)
 *   request      { range, view, pickFrom, pickTo }; now: ms
 *   paths        Map<rawPath, { key, outside }>
 *   facts        { outside: Set<key>, untracked: Set<key>, editedByOthers: Map<key, n>, statusKeys: [key] }
 *   vcs          null (not read: DB only) or { noRepo, failed, baselineGone, inHistory: Map<rawSha, bool>,
 *                numstat: Map<cutId, Map<key, { added, deleted, binary }>>, otherCommits }
 */
function buildModel(input) {
  const req = cleanRequest(input && input.request);
  if (!input || input.reports === false) {
    return { reports: false, request: req, figure: null, state: 'not-reported', notes: [{ code: 'not-reported' }],
      actions: { clear: false, setReviewPointNow: false }, files: [], commits: [], blocks: [], totals: totalsOf([], []),
      ticks: [], plan: { cuts: [] } };
  }
  const ctx = contextOf(input);
  const now = num(input.now) !== null ? input.now : Date.now();
  const { ticks, vcs } = ctx;
  const range = resolveRange(ticks, req, { now, rowsList: ctx.allRows });
  const fromTick = ticks[range.from] || null;
  const toTick = range.to === null ? null : ticks[range.to];
  // A cut is named by its boundary TICKS, not their indexes, so a tick added later does not rename an older cut.
  const cutId = (a, b) => `${ticks[a] ? ticks[a].id : 'none'}..${b === null ? 'now' : ticks[b].id}`;
  // The order is the read order the app follows under its numstat cap: All first, then the blocks newest first.
  const plan = [];
  const planCut = (a, b) => {
    const id = cutId(a, b);
    if (plan.some((c) => c.id === id)) return id;
    const from = ticks.length ? sourcedShaOfTick(ctx, a) : null;
    const to = b === null ? null : sourcedShaOfTick(ctx, b);
    plan.push({
      id, fromSha: from ? from.sha : null, toSha: to ? to.sha : null, working: b === null,
      fromTrusted: !!(from && from.trusted), toTrusted: !!(to && to.trusted),
    });
    return id;
  };

  const numstatOf = (id) => (vcs && vcs.numstat instanceof Map ? vcs.numstat.get(id) || null : null);
  const emptyCut = { files: new Map(), commits: [] };

  // All: the whole range in one list.
  const allId = planCut(range.from, range.to);
  const allCut = range.empty ? emptyCut : cutBetween(ctx, fromTick, toTick);
  const files = fileRows(allCut, ctx, numstatOf(allId), allId);
  const commits = commitRows(allCut, ctx);

  // Split: blocks ending at cutting pushes (D2), newest first.
  let blocks = [];
  if (req.view === 'split' && !range.empty) {
    const end = range.to === null ? ticks.length - 1 : range.to;
    const bounds = [range.from];
    for (let i = range.from + 1; i <= end; i++) if (ticks[i].kind === 'push') bounds.push(i);
    const segs = [];
    for (let k = 0; k < bounds.length; k++) {
      const a = bounds[k];
      const b = k + 1 < bounds.length ? bounds[k + 1] : range.to;
      if (b === a) continue;
      segs.push([a, b]);
    }
    blocks = segs.reverse().map(([a, b]) => {
      const id = planCut(a, b);
      const cut = cutBetween(ctx, ticks[a], b === null ? null : ticks[b]);
      const bf = fileRows(cut, ctx, numstatOf(id), id);
      const bc = commitRows(cut, ctx);
      const endTick = b === null ? null : ticks[b];
      const kind = b === null ? 'open' : endTick.kind === 'push' ? 'pushed' : 'range';
      const marks = [];
      for (let i = a + 1; i < (b === null ? ticks.length : b); i++) {
        if (ticks[i].kind === 'clear' || ticks[i].kind === 'cli-clear') marks.push({ id: ticks[i].id, kind: ticks[i].kind, at: ticks[i].at });
      }
      return {
        id, kind, fromSha: short(shaOfTick(ctx, a)), toSha: b === null ? null : short(shaOfTick(ctx, b)),
        push: kind === 'pushed' ? { id: endTick.id, at: endTick.at, summary: endTick.event.summary || '' } : null,
        marks, files: bf, commits: bc, totals: totalsOf(bf, bc), empty: !bf.length && !bc.length,
      };
    });
  }

  // The states table of spec 47.
  const figure = figureOf(ctx);
  const truncated = ctx.allRows.some((r) => r.truncated) ? { limit: MAX_FILES } : null;
  const lastClear = [...ticks].reverse().find((t) => t.kind === 'clear') || null;
  const lastPush = [...ticks].reverse().find((t) => t.kind === 'push') || null;
  const notes = [];
  if (vcs && vcs.noRepo) notes.push({ code: 'no-repo' });
  // E2: a gone review point offers "Set review point to now"; a gone start of any other range only says so.
  const reviewGone = !!(vcs && vcs.baselineGone) && req.range === 'since-review';
  if (vcs && vcs.baselineGone) notes.push({ code: reviewGone ? 'baseline-gone' : 'range-start-gone' });
  if (vcs && vcs.failed) notes.push({ code: 'vcs-failed' });
  if (vcs && vcs.countsCapped) notes.push({ code: 'counts-unavailable' });
  if (truncated) notes.push({ code: 'truncated', limit: truncated.limit });
  let state;
  if (!figure && req.range === 'since-review') state = 'nothing-since-review';
  else if (!files.length && !commits.length) state = 'nothing-in-range';
  else if (!commits.length) state = 'edits-no-commit';
  else if (commits.some((c) => !c.pushed && !c.rewritten)) state = 'commits-not-pushed';
  else state = 'commits-pushed';
  if (!figure && req.range === 'since-review') notes.push({ code: 'nothing-since-review' });

  // E7: files the working tree shows changed that no session of this lineage edited.
  const ours = new Set();
  for (const r of ctx.allRows) for (const f of r.files) ours.add(ctx.keyOf(f.path));
  const statusKeys = Array.isArray(ctx.facts.statusKeys) ? ctx.facts.statusKeys : null;
  const otherChanged = statusKeys ? statusKeys.filter((k) => !ours.has(k)).length : null;

  const totals = totalsOf(files, commits);
  totals.otherCommits = vcs && num(vcs.otherCommits) !== null ? vcs.otherCommits : null;
  return {
    reports: true,
    sessionId: input.sessionId || null,
    request: req,
    range: {
      kind: req.range, empty: range.empty,
      fromId: fromTick ? fromTick.id : null, toId: toTick ? toTick.id : null,
      fromAt: fromTick ? fromTick.at : null, toAt: toTick ? toTick.at : null, todayAt: range.todayAt,
      approxStart: range.approxStart,
    },
    view: req.view,
    figure,
    state,
    notes,
    actions: { clear: !!figure && !reviewGone, setReviewPointNow: reviewGone },
    files,
    commits,
    blocks,
    totals,
    lastPush: lastPush ? { at: lastPush.at } : null,
    lastReview: lastClear ? { at: lastClear.at, sha: short(lastClear.toSha) } : null,
    otherChanged,
    footer: { baseSha: short(plan[0] ? plan[0].fromSha : null) },
    truncated,
    ticks: ticks.map((t, i) => tickView(t, ctx, i)),
    // What the app has to ask version control: one numstat per cut (by id), and which recorded SHAs to look up.
    plan: { cuts: plan, shas: shownShas(commits, blocks) },
  };
}

/** The recorded SHAs this answer SHOWS (All and the returned blocks): the only ones E3's history check asks about. */
function shownShas(commits, blocks) {
  const out = new Set();
  for (const c of commits) if (c.rawSha) out.add(c.rawSha);
  for (const b of blocks) for (const c of b.commits) if (c.rawSha) out.add(c.rawSha);
  return [...out];
}

/** V1 on its own: what a closed group shows, from the database only. */
function summaryOf(input) {
  if (!input || input.reports === false) return { reports: false, figure: null };
  return { reports: true, figure: figureOf(contextOf(input)) };
}

/**
 * The Details strip: one tick per entry (start, clear, cli-clear, cutting push), the derived "today" tick (V3, not
 * stored) and "now"; `inRange` marks the ticks of the picked range.
 */
function timeline(input) {
  const req = cleanRequest(input && input.request);
  if (!input || input.reports === false) return { ticks: [] };
  const ctx = contextOf(input);
  const now = num(input.now) !== null ? input.now : Date.now();
  const range = resolveRange(ctx.ticks, req, { now, rowsList: ctx.allRows });
  const end = range.to === null ? ctx.ticks.length : range.to;
  const out = ctx.ticks.map((t, i) => ({ ...tickView(t, ctx, i), inRange: !range.empty && i >= range.from && i <= end }));
  const todayAt = firstActivitySince(ctx.allRows, midnightOf(now));
  const firstTodayTick = ctx.ticks.find((t) => num(t.at) !== null && t.at >= midnightOf(now));
  const derived = [todayAt, firstTodayTick ? firstTodayTick.at : null].filter((v) => v !== null);
  if (derived.length) {
    const at = Math.min(...derived);
    let i = out.findIndex((t) => num(t.at) !== null && t.at >= at);
    if (i < 0) i = out.length;
    out.splice(i, 0, { id: 'today', kind: 'today', at, sha: null, implicit: true, derived: true, inRange: req.range === 'today' });
  }
  out.push({ id: 'now', kind: 'now', at: now, sha: null, implicit: true, inRange: range.to === null && !range.empty });
  return { ticks: out };
}

module.exports = {
  buildModel, summaryOf, timeline, cleanRequest, buildTicks, resolveRange,
  RANGES, VIEWS, DEFAULT_RANGE, DEFAULT_VIEW, SHORT_SHA,
};
