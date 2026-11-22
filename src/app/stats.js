// stats.js — the Stats page's main-process side (#877, spec 48 "Main-process side").
//
// One call per filter change: `stats-get` takes the filter the renderer built, sanitises it, resolves the range on the
// local clock, folds the project and backend choices into what the SQL wants (worktree paths, template and driver ids),
// asks the database for raw rows (`db.getStatsPayload`, src/db/stats-queries.js) and folds them back onto the owning CLI and
// project. Only aggregates cross IPC. This module is the page's whole answer; the old `get-stats-from-db` /
// `refresh-stats` pair is gone.
//
// Names no backend: label, colour, icon, cache accounting and "settled" all come from the registry's descriptors, and which
// ids a CLI expands to comes from `rowOwnerOf`. Electron-free and DB-free (the database arrives through ctx), so a test
// drives it with a fake ctx.
'use strict';

const { cacheHit, rateOf } = require('../backends/cache-accounting');
const { settingsOwnerPath } = require('../shared/worktree-path');
const { pathKey } = require('./path-containment');
const { networkShareOf } = require('./network-path');
const { startTimer } = require('../perf');
const { bucketKindFor } = require('../db/stats-queries');
const usageWindows = require('./usage-windows');

// The one remembered filter (spec 48 "Persistence", O10): an internal key of the settings table, like `lastDialogDir`,
// not a field of the settings screen and not in a settings export.
const FILTER_KEY = 'statsFilter';

const RANGE_KINDS = ['7d', '30d', '90d', 'year', 'all', 'day', 'custom'];
const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, year: 365 };
const DEFAULT_RANGE = '30d';
const MEASURES = ['tokens', 'cost', 'messages', 'sessions'];
const SPLITS = ['none', 'backend', 'model', 'project'];
const SESSION_SORTS = ['tokens', 'cost', 'messages'];
const MAX_MODEL_LENGTH = 200;
// A project value from the renderer or the stored filter is a real path at most this long: past it the real-path walk in
// `pathKey` is quadratic (32 KB measured 9.9 s of blocked main thread), and no project path is that long.
const MAX_PATH_LENGTH = 4096;
const MAX_PATH_SEGMENTS = 64;
// Where a stored backend id the registry no longer lists goes (a deleted template, a removed backend): its base is unknowable
// once the template is gone, so those rows share one neutral bucket instead of one bucket per dead id labelled with the raw id.
const REMOVED_BACKEND = 'removed';
const REMOVED_LABEL = 'Removed backend or template';
const SERIES_TOP = 8;
const PROJECTS_CAP = 50;
// The most session lines an export carries (`sessionsTable` clamps at one more).
const EXPORT_SESSIONS_CAP = 500;
const OTHER_KEY = '__other__';
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
// This machine's figures are shown for a window of at least a day (#883 E4): the start hour counts whole, which skews a short window.
const MACHINE_MIN_WINDOW_MINUTES = 1440;

let ctx = null;

function init(context) {
  ctx = context || null;
}

// --- day keys (LOCAL, #75): arithmetic in UTC on the parsed key, so a DST change never moves a day -----------------------

function dayNumber(key) {
  return Math.round(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / DAY_MS);
}
function dayKey(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
function isDayKey(v) {
  if (typeof v !== 'string' || !DAY_KEY.test(v)) return false;
  return dayKey(dayNumber(v)) === v;
}
/** The local calendar day of a Date as a key; never `toISOString()`, which is UTC. */
function localDayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
/** A stored timestamp as the LOCAL day it falls on (a day key), or null when there is none or it does not parse. */
function localDayOf(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : localDayKey(d);
}

// --- the filter ---------------------------------------------------------------------------------------------------------

function defaultFilter() {
  return { v: 1, range: { kind: DEFAULT_RANGE }, backend: null, project: null, model: null };
}

function sanitiseRange(raw) {
  const fallback = { kind: DEFAULT_RANGE };
  if (typeof raw === 'string') raw = { kind: raw };
  if (!raw || typeof raw !== 'object') return fallback;
  if (isDayKey(raw.day)) return { kind: 'day', from: raw.day, to: raw.day };
  const kind = raw.kind;
  if (!RANGE_KINDS.includes(kind)) return fallback;
  if (kind === 'day') {
    const d = isDayKey(raw.from) ? raw.from : (isDayKey(raw.to) ? raw.to : null);
    return d ? { kind, from: d, to: d } : fallback;
  }
  if (kind === 'custom') {
    if (!isDayKey(raw.from) || !isDayKey(raw.to) || raw.from > raw.to) return fallback;
    return { kind, from: raw.from, to: raw.to };
  }
  return { kind };
}

/**
 * The owner path a project value from outside names, or null. Lexical first: a value that IS one of the paths the page knows
 * (the owner path it was handed) is accepted without touching the filesystem. Anything else is capped, refused when it is a
 * network path no known project is on (`ctx.isForeignNetworkFile`, #780: a stat would be an SMB connection to whoever named
 * it) and only then asked of `pathKey`, which resolves real paths.
 */
function matchProject(raw, know) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PATH_LENGTH) return null;
  // The real-path walk is quadratic in the segment count; no project is this deep (2047 segments measured ~210 ms).
  if (raw.split(/[\\/]+/).length > MAX_PATH_SEGMENTS) return null;
  const exact = know.exact && know.exact.get(raw);
  if (exact) return exact;
  if (know.isForeign && know.isForeign(raw)) return null;
  const keyOf = know.keyOf || pathKey;
  return know.projects.get(keyOf(settingsOwnerPath(raw))) || null;
}

/**
 * Anything from the renderer becomes a filter this module can run, never a throw: an unknown range falls back to the
 * default, a backend that is not launchable or a project that left the list is dropped to "all", the model is a capped
 * string. `know` is what `knowledge()` found: `backends` (a Set of CLI ids) and `projects` (a Map pathKey -> owner path).
 */
function sanitiseFilter(raw, know) {
  const out = defaultFilter();
  const f = raw && typeof raw === 'object' ? raw : {};
  out.range = sanitiseRange(f.range);
  if (typeof f.backend === 'string' && f.backend && know.backends.has(f.backend)) out.backend = f.backend;
  const owner = matchProject(f.project, know);
  if (owner) out.project = owner;
  if (typeof f.model === 'string') {
    const m = f.model.trim().slice(0, MAX_MODEL_LENGTH);
    if (m) out.model = m;
  }
  // The Rhythm block's fold (spec 48 V6) is remembered with the filter. Only a collapsed block is written, so the default
  // shape of a filter stays what it was.
  if (f.rhythmCollapsed === true) out.rhythmCollapsed = true;
  return out;
}

function sanitiseView(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    measure: MEASURES.includes(v.measure) ? v.measure : 'tokens',
    split: SPLITS.includes(v.split) ? v.split : 'backend',
    sessionsBy: SESSION_SORTS.includes(v.sessionsBy) ? v.sessionsBy : 'tokens',
  };
}

// --- the range, resolved on the local clock ------------------------------------------------------------------------------

/**
 * `{ kind, from, to, days, prevFrom, prevTo, includesToday }`: inclusive local day keys. `7d` is today and the six days
 * before it, `year` the last 365 days, `all` runs from the first metrics date to today. The previous period is the same
 * number of days directly before `from`; `all` has none (`prevFrom` null).
 */
function resolveRange(range, today, firstDate) {
  let from;
  let to;
  if (range.kind === 'all') {
    to = today;
    from = isDayKey(firstDate) && firstDate <= today ? firstDate : today;
  } else if (RANGE_DAYS[range.kind]) {
    to = today;
    from = dayKey(dayNumber(today) - (RANGE_DAYS[range.kind] - 1));
  } else {
    from = range.from;
    to = range.to;
  }
  const days = dayNumber(to) - dayNumber(from) + 1;
  let prevFrom = null;
  let prevTo = null;
  if (range.kind !== 'all') {
    prevTo = dayKey(dayNumber(from) - 1);
    prevFrom = dayKey(dayNumber(from) - days);
  }
  return { kind: range.kind, from, to, days, prevFrom, prevTo, includesToday: from <= today && to >= today };
}

// --- what main knows: backends and projects ------------------------------------------------------------------------------

function backendIndex() {
  const byId = new Map();
  const list = ctx.backends.list();
  for (const b of list) byId.set(b.id, b);
  return { list, byId };
}

/** The CLI a stored backend id is counted under: a template folds onto its base's owner, a driver onto its owner. */
function bucketOf(id, idx) {
  const d = idx.byId.get(id);
  if (!d) return REMOVED_BACKEND;
  return ctx.backends.rowOwnerOf(d.isProfile ? d.baseId : id);
}

/** What the page shows for a CLI: the registry's label, colour token and icon, never a name of ours. */
function backendFacts(id, idx) {
  if (id === REMOVED_BACKEND) return { id, label: REMOVED_LABEL, colour: null, icon: null };
  const d = idx.byId.get(id);
  return { id, label: d ? d.label : id, colour: d ? d.colour || null : null, icon: d ? d.icon || null : null };
}

/** The ids a backend filter expands to: the CLI itself, the templates on it and a GUI driver that writes under it (#752). */
function backendIds(base, idx) {
  const ids = new Set([base]);
  for (const b of idx.list) if (bucketOf(b.id, idx) === base) ids.add(b.id);
  return [...ids];
}

function lastSegment(p) {
  const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || String(p || '');
}

/**
 * Everything the sanitiser and the folds need, read fresh per call. `known-worktree.refresh` runs FIRST: the main-process
 * copy of the worktree list is not guaranteed loaded when Stats is opened before the sidebar (spec 48, T1).
 */
function knowledge() {
  const idx = backendIndex();
  const backends = new Set();
  for (const b of idx.list) {
    if (b.status === 'ready' && b.enabled) backends.add(bucketOf(b.id, idx));
  }
  const paths = ctx.db.getStatsProjectPaths();
  const states = ctx.db.getProjectStates();
  if (typeof ctx.refreshKnownWorktrees === 'function') {
    try { ctx.refreshKnownWorktrees(paths, states); } catch { /* an unloaded list only folds fewer worktrees */ }
  }
  // `networkShareOf` is the cheap lexical pre-filter (a plain path is not asked at all: main's guard reads the register on every
  // call, 10 ms over a few hundred paths); a network path is answered by main's guard, and refused when there is none.
  const isForeign = (p) => {
    if (!networkShareOf(p)) return false;
    if (typeof ctx.isForeignNetworkFile !== 'function') return true;
    try { return !!ctx.isForeignNetworkFile(p); } catch { return true; }
  };
  // A path key without touching the disk for a network path no known project is on (#780): that is lexical or nothing.
  const lexicalKey = (p) => 'net:' + String(p).split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  const keyOf = (p) => (isForeign(p) ? lexicalKey(p) : pathKey(p));
  const removed = new Set();
  const projects = new Map();       // pathKey of the owner -> owner path, in the spelling the REGISTER uses where it has one
  const memberPaths = new Map();    // owner pathKey -> every raw path filed under it
  const exact = new Map();          // a path spelled exactly as the page knows it -> its owner path
  for (const [p, s] of states || []) {
    if (s && s.removedAt) removed.add(keyOf(settingsOwnerPath(p)));
  }
  const note = (raw) => {
    const owner = settingsOwnerPath(raw);
    const key = keyOf(owner);
    if (!key || removed.has(key)) return;
    // Registered paths are noted FIRST, so the owner spelling is the one the register (and the display names) use (#566, #579).
    if (!projects.has(key)) projects.set(key, owner);
    const known = projects.get(key);
    let m = memberPaths.get(key);
    if (!m) { m = new Set(); memberPaths.set(key, m); }
    m.add(raw);
    exact.set(raw, known);
    exact.set(known, known);
  };
  for (const [p, s] of states || []) if (s && s.registered && !s.removedAt) note(p);
  for (const p of paths) note(p);
  // Display names are stored under a path spelling of their own: look them up by exact string, then by path key.
  const names = ctx.db.getProjectDisplayNames ? ctx.db.getProjectDisplayNames() : new Map();
  const namesByKey = new Map();
  for (const [p, name] of names) {
    const k = keyOf(p);
    if (k && !namesByKey.has(k)) namesByKey.set(k, name);
  }
  return { idx, backends, projects, memberPaths, exact, isForeign, keyOf, names, namesByKey };
}

function projectName(ownerPath, know) {
  const named = know.names.get(ownerPath) || (know.namesByKey && know.namesByKey.get(know.keyOf(ownerPath)));
  return named || lastSegment(ownerPath);
}

/** A raw project path as its owner project: `{ path, name }`. A path with no project at all is one "(no project)" line. */
function ownerOfPath(raw, know) {
  if (!raw) return { path: '', name: '(no project)' };
  const known = know.exact.get(raw) || know.projects.get(know.keyOf(settingsOwnerPath(raw))) || settingsOwnerPath(raw);
  return { path: known, name: projectName(known, know) };
}

function toSqlFilter(clean, range, know) {
  let projects = null;
  if (clean.project) {
    const set = new Set(know.memberPaths.get(know.keyOf(clean.project)) || []);
    set.add(clean.project);
    projects = [...set];
  }
  return {
    from: range.from,
    to: range.to,
    backend: clean.backend ? backendIds(clean.backend, know.idx) : null,
    projects,
    model: clean.model || null,
  };
}

// --- cost and cache, per backend -----------------------------------------------------------------------------------------

const num = (v) => (Number.isFinite(v) ? v : 0);
const add = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));

/**
 * One sum of money from stored groups. A figure is SETTLED only when the backend calls its cost status settled AND the
 * group holds an actual figure (the T3 verifier note: the status word alone is not enough). Anything else is an estimate,
 * an actual under an unsettled status included, so a sum with any estimated part is an estimate. `null` when no group
 * carries a figure: "—", never $0.
 */
function costFold(groups, idx) {
  let usd = null;
  let estimated = false;
  for (const g of groups) {
    const est = g.estimatedCostUsd;
    const act = g.actualCostUsd;
    if (est != null) { usd = add(usd, est); estimated = true; }
    if (act != null) {
      usd = add(usd, act);
      const d = idx.byId.get(g.backendId);
      let settled = false;
      try { settled = !!(d && typeof d.costSettled === 'function' && d.costSettled(g.costStatus)); } catch { settled = false; }
      if (!settled) estimated = true;
    }
  }
  return usd == null ? null : { usd, estimated };
}

function accountingOf(backendId, idx) {
  const d = idx.byId.get(backendId);
  return d ? d.cacheAccounting || null : null;
}

/** Fold the key-figure groups of one period (`cur` 1 or 0) into the tile figures. */
function foldPeriod(rows, cur, idx) {
  const groups = rows.filter(r => r.cur === cur);
  const t = { messages: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const pair = { hit: 0, base: 0 };
  const excluded = new Set();
  for (const g of groups) {
    const inp = num(g.inputTokens), read = num(g.cacheReadTokens), write = num(g.cacheCreationTokens);
    const accounting = accountingOf(g.backendId, idx);
    t.messages += num(g.messages);
    t.toolCalls += num(g.toolCalls);
    t.output += num(g.outputTokens);
    t.cacheRead += read;
    t.cacheWrite += write;
    // An `included` backend's input already holds the cached part: the tile shows it without, so the numbers do not overlap (O2).
    t.input += accounting === 'included' ? Math.max(0, inp - read) : inp;
    const hit = cacheHit(accounting, { input: inp, cacheRead: read, cacheCreation: write });
    if (hit) { pair.hit += hit.hit; pair.base += hit.base; }
    else if (accounting !== 'additive' && accounting !== 'included' && inp + read + write + num(g.outputTokens) > 0) {
      excluded.add(backendFacts(bucketOf(g.backendId, idx), idx).label);
    }
  }
  return {
    figures: {
      messages: t.messages, toolCalls: t.toolCalls,
      input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
      // The stored `input + output`, so history reads as before (O2); the split above is the normalised view.
      tokens: groups.reduce((s, g) => s + num(g.inputTokens) + num(g.outputTokens), 0),
      cost: costFold(groups, idx),
      cacheRate: rateOf(pair),
    },
    excluded: [...excluded].sort(),
  };
}

function changeOf(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / prev;
}

function foldKeyFigures(raw, hasPrev, idx) {
  const counts = (cur) => raw.periodCounts.find(r => r.cur === cur) || {};
  const build = (cur) => {
    const p = foldPeriod(raw.keyFigures, cur, idx);
    const c = counts(cur);
    return {
      figures: { ...p.figures, sessions: num(c.sessions), costSessions: num(c.costSessions), activeDays: num(c.activeDays) },
      excluded: p.excluded,
    };
  };
  const cur = build(1);
  const prev = hasPrev ? build(0) : null;
  const change = {};
  for (const k of ['sessions', 'messages', 'toolCalls', 'tokens', 'activeDays']) {
    change[k] = prev ? changeOf(cur.figures[k], prev.figures[k]) : null;
  }
  change.cost = prev ? changeOf(cur.figures.cost && cur.figures.cost.usd, prev.figures.cost && prev.figures.cost.usd) : null;
  // A rate changes in percentage points, not as a ratio of itself.
  change.cacheRate = prev && cur.figures.cacheRate != null && prev.figures.cacheRate != null
    ? cur.figures.cacheRate - prev.figures.cacheRate : null;
  return { cur: cur.figures, prev: prev ? prev.figures : null, change, cacheExcluded: cur.excluded };
}

/**
 * The imported share of a combined total (#584), or null when there is none or it was not asked (a backend filter). Imported
 * sessions stay IN the totals, like the sidebar keeps them beside their original; the page names this share instead.
 */
function foldImported(rows) {
  const r = rows && rows[0];
  if (!r || !(num(r.sessions) > 0)) return null;
  return { sessions: num(r.sessions), messages: num(r.messages) };
}

// --- the series ----------------------------------------------------------------------------------------------------------

function enumerateBuckets(from, to, kind) {
  const out = [];
  if (kind === 'day') {
    for (let n = dayNumber(from); n <= dayNumber(to) && out.length < 400; n++) out.push({ key: dayKey(n), start: dayKey(n), end: dayKey(n) });
  } else if (kind === 'week') {
    const f = dayNumber(from);
    let n = f - ((new Date(f * DAY_MS).getUTCDay() + 6) % 7);
    for (; n <= dayNumber(to) && out.length < 400; n += 7) out.push({ key: dayKey(n), start: dayKey(n), end: dayKey(n + 6) });
  } else {
    let y = +from.slice(0, 4), m = +from.slice(5, 7);
    const last = to.slice(0, 7);
    for (; out.length < 400; m++) {
      if (m > 12) { m = 1; y++; }
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key > last) break;
      const end = dayKey(Math.round(Date.UTC(y, m, 0) / DAY_MS));
      out.push({ key, start: `${key}-01`, end });
    }
  }
  return out;
}

function foldSeries(rows, range, view, kind, today, know) {
  const idx = know.idx;
  const keyOf = (raw) => {
    if (view.split === 'none') return '';
    if (view.split === 'backend') return bucketOf(raw, idx);
    if (view.split === 'project') return ownerOfPath(raw, know).path;
    return raw;
  };
  const byKey = new Map();   // key -> Map(bucket -> value)
  const totals = new Map();
  for (const r of rows) {
    if (r.value == null) continue;
    const k = keyOf(r.key);
    let m = byKey.get(k);
    if (!m) { m = new Map(); byKey.set(k, m); }
    m.set(r.bucket, (m.get(r.bucket) || 0) + r.value);
    totals.set(k, (totals.get(k) || 0) + r.value);
  }
  const ranked = [...totals.keys()].sort((a, b) => (totals.get(b) - totals.get(a)) || (a < b ? -1 : 1));
  const top = ranked.slice(0, SERIES_TOP);
  const rest = ranked.slice(SERIES_TOP);
  const keys = top.map((k) => {
    if (view.split === 'backend') return { ...backendFacts(k, idx), key: k, other: false };
    if (view.split === 'project') return { key: k, label: k ? projectName(k, know) : '(no project)', colour: null, icon: null, other: false };
    return { key: k, label: view.split === 'none' ? 'Total' : k, colour: null, icon: null, other: false };
  });
  if (rest.length) keys.push({ key: OTHER_KEY, label: 'Other', colour: null, icon: null, other: true });

  const buckets = enumerateBuckets(range.from, range.to, kind).map((b) => {
    const values = {};
    for (const k of top) values[k] = (byKey.get(k) && byKey.get(k).get(b.key)) || 0;
    if (rest.length) values[OTHER_KEY] = rest.reduce((s, k) => s + ((byKey.get(k) && byKey.get(k).get(b.key)) || 0), 0);
    // A bucket whose natural end is still ahead is a partial one; the page draws it lighter and says "so far" (O8).
    return { bucket: b.key, start: b.start, end: b.end, partial: kind !== 'day' && b.end > today && b.start <= range.to, values };
  });
  // The cost axis is an estimate as soon as any part of it is (null for another measure or no figure at all).
  const cost = view.measure === 'cost' ? costFold(rows.map(partsOf), idx) : null;
  return {
    measure: view.measure, split: view.split, bucket: kind, keys, buckets,
    estimated: cost ? cost.estimated : null,
    partialLast: buckets.length > 0 && buckets[buckets.length - 1].partial,
  };
}

// --- the tables ----------------------------------------------------------------------------------------------------------

// The table queries return their cost as parts per (key, costBackendId, costStatus) group: the estimate on rows without an
// actual and the actual. `costFold` decides settled per group through the backend's `costSettled`, so a fully settled row is
// not flagged as an estimate and any estimated part is.
const partsOf = (r) => ({ backendId: r.costBackendId, costStatus: r.costStatus, estimatedCostUsd: r.estimatedCostUsd, actualCostUsd: r.actualCostUsd });

function foldProjects(rows, know, cap = PROJECTS_CAP) {
  const byOwner = new Map();
  for (const r of rows) {
    const o = ownerOfPath(r.projectPath, know);
    let e = byOwner.get(o.path);
    if (!e) { e = { projectPath: o.path, name: o.name, selectable: !!o.path, sessions: 0, messages: 0, tokens: 0, parts: [] }; byOwner.set(o.path, e); }
    e.sessions += num(r.sessions);
    e.messages += num(r.messages);
    e.tokens += num(r.tokens);
    e.parts.push(partsOf(r));
  }
  const all = [...byOwner.values()].sort((a, b) => b.tokens - a.tokens);
  const out = ({ parts, ...e }) => ({ ...e, cost: costFold(parts, know.idx) });
  const shown = all.slice(0, cap).map(out);
  const rest = all.slice(cap);
  if (rest.length) {
    shown.push(out({
      projectPath: '', name: 'Other', other: true, selectable: false,
      sessions: rest.reduce((s, e) => s + e.sessions, 0), messages: rest.reduce((s, e) => s + e.messages, 0),
      tokens: rest.reduce((s, e) => s + e.tokens, 0),
      parts: rest.flatMap(e => e.parts),
    }));
  }
  return shown;
}

function foldModels(rows, idx) {
  const by = new Map();
  for (const r of rows) {
    let e = by.get(r.model);
    if (!e) { e = { model: r.model, selectable: true, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, parts: [] }; by.set(r.model, e); }
    e.sessions += num(r.sessions);
    e.input += num(r.inputTokens);
    e.output += num(r.outputTokens);
    e.cacheRead += num(r.cacheReadTokens);
    e.cacheWrite += num(r.cacheCreationTokens);
    e.parts.push(partsOf(r));
  }
  return [...by.values()].map(({ parts, ...e }) => ({ ...e, tokens: e.input + e.output, cost: costFold(parts, idx) }))
    .sort((a, b) => b.tokens - a.tokens);
}

function foldBackends(rows, know) {
  const idx = know.idx;
  const by = new Map();
  for (const r of rows) {
    const id = bucketOf(r.backendId, idx);
    let e = by.get(id);
    if (!e) { e = { ...backendFacts(id, idx), selectable: know.backends.has(id), groups: [], sessions: 0, messages: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pair: { hit: 0, base: 0 } }; by.set(id, e); }
    const inp = num(r.inputTokens), read = num(r.cacheReadTokens), write = num(r.cacheCreationTokens);
    const accounting = accountingOf(r.backendId, idx);
    e.groups.push(r);
    e.sessions += num(r.sessions);
    e.messages += num(r.messages);
    e.tokens += inp + num(r.outputTokens);
    e.output += num(r.outputTokens);
    e.cacheRead += read;
    e.cacheWrite += write;
    e.input += accounting === 'included' ? Math.max(0, inp - read) : inp;
    const hit = cacheHit(accounting, { input: inp, cacheRead: read, cacheCreation: write });
    if (hit) { e.pair.hit += hit.hit; e.pair.base += hit.base; }
  }
  return [...by.values()].map(({ groups, pair, ...e }) => ({ ...e, cost: costFold(groups, idx), cacheRate: rateOf(pair) }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * The Sessions table's lines. `rollup` is the SQL's rows for the sessions each line STARTED (`sessionsRollup`: descendants only,
 * by cost group), so "incl. started sessions" is the line's own figures plus those. It goes through the same `costFold` as the
 * own cost (settled or estimated per group, null when nobody reported money) and is never added to anything else.
 */
function foldSessions(rows, know, rollup = []) {
  const started = new Map();
  for (const g of rollup) {
    let list = started.get(g.sessionId);
    if (!list) { list = []; started.set(g.sessionId, list); }
    list.push(g);
  }
  return rows.map((r) => {
    const o = ownerOfPath(r.projectPath, know);
    const own = { backendId: r.backendId, costStatus: r.costStatus, estimatedCostUsd: r.estimatedCostUsd, actualCostUsd: r.actualCostUsd };
    const groups = started.get(r.sessionId) || [];
    return {
      sessionId: r.sessionId, title: r.aiTitle || null,
      projectPath: o.path, projectName: o.name,
      // The session's OWN path, for opening it: a worktree session resumes in its worktree, not in the owner's checkout.
      openPath: r.projectPath || null,
      // A group whose parent row is gone has no project path: there is no folder to resume it in, so it is not openable.
      openable: !!r.projectPath,
      backend: backendFacts(bucketOf(r.backendId, know.idx), know.idx),
      // The local day the session started on: decided here, so the page and the export show the same day.
      started: localDayOf(r.created), lastDate: r.lastDate || null, lastModel: r.lastModel || null,
      messages: num(r.messages), tokens: num(r.tokens),
      cost: costFold([own], know.idx),
      inclTokens: num(r.tokens) + groups.reduce((s, g) => s + num(g.tokens), 0),
      inclCost: costFold([own, ...groups.map(partsOf)], know.idx),
    };
  });
}

/**
 * The sidebar list: per owner project a total and at most 30 points (`size` days each), the SQL's top 50 folded.
 * LIMIT: the SQL ranks its top 50 on the RAW `projectPath` before this fold, so a project whose tokens are split over many
 * worktrees can fall out of the 50 although its folded total would rank (spec 48, "As built: T4a").
 */
function foldSidebar(rows, days, know) {
  const size = Math.max(1, Math.ceil(days / 30));
  const count = Math.max(1, Math.ceil(days / size));
  const by = new Map();
  for (const r of rows) {
    const o = ownerOfPath(r.projectPath, know);
    let e = by.get(o.path);
    if (!e) { e = { projectPath: o.path, name: o.name, selectable: !!o.path, total: 0, points: new Array(count).fill(0) }; by.set(o.path, e); }
    const b = Math.min(count - 1, Math.max(0, num(r.bucket)));
    e.points[b] += num(r.tokens);
    e.total += num(r.tokens);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

// --- the payload ---------------------------------------------------------------------------------------------------------

// `full` is the export's ask (spec 48 V10): every project row instead of the top 50 plus "Other", and the largest session
// list the SQL allows, one line past the cap, so the export can tell a full list from a cut one.
function buildPayload(clean, view, today, know, full = false) {
  const range = resolveRange(clean.range, today, ctx.db.getStatsFirstDate());
  const filter = toSqlFilter(clean, range, know);
  const heatmapFrom = dayKey(dayNumber(range.to) - 364);
  const raw = ctx.db.getStatsPayload({
    filter,
    prevFrom: range.prevFrom,
    series: { measure: view.measure, split: view.split },
    sessions: { by: view.sessionsBy, limit: full ? EXPORT_SESSIONS_CAP + 1 : 50 },
    heatmap: { from: heatmapFrom, to: range.to },
    // Only a combined total can hold an imported session twice (#584): under one backend its original is not in it.
    imported: !clean.backend,
  });
  return {
    range,
    keyFigures: { ...foldKeyFigures(raw, range.prevFrom != null, know.idx), imported: foldImported(raw.imported) },
    series: foldSeries(raw.series, range, view, bucketKindFor(range.days), today, know),
    projects: foldProjects(raw.projects, know, full ? Infinity : PROJECTS_CAP),
    models: foldModels(raw.models, know.idx),
    backends: foldBackends(raw.backends, know),
    sessions: foldSessions(raw.sessions, know, raw.rollup || []),
    heatmap: { from: heatmapFrom, to: range.to, days: raw.heatmap.map(r => ({ date: r.date, messages: num(r.messages) })) },
    grid: raw.grid.map(r => ({ weekday: r.weekday, hour: r.hour, messages: num(r.messages), tokens: num(r.tokens) })),
    sidebar: foldSidebar(raw.sidebar, range.days, know),
  };
}

function readStored() {
  try { return ctx.getSetting(FILTER_KEY); } catch { return null; }
}

function persist(clean, stored) {
  const text = JSON.stringify(clean);
  if (stored && JSON.stringify(stored) === text) return;
  try { ctx.setSetting(FILTER_KEY, clean); } catch (err) {
    if (ctx.log && ctx.log.warn) ctx.log.warn(`[stats] could not remember the filter: ${err && err.code ? err.code : 'error'}`);
  }
}

/**
 * `stats-get`: the filter in (null or missing = the remembered one), the whole page out.
 * `{ ok: true, filter, view, payload }` — `filter` is the sanitised echo, already remembered — or `{ ok: false, error }`.
 */
function getStats(rawFilter, rawView) {
  if (!ctx) return { ok: false, error: 'The statistics are not ready.' };
  const done = startTimer();
  try {
    const stored = readStored();
    const know = knowledge();
    const clean = sanitiseFilter(rawFilter == null ? stored : rawFilter, know);
    const view = sanitiseView(rawView);
    const payload = buildPayload(clean, view, localDayKey(ctx.now()), know);
    // Only a filter the page could be built under is remembered: one that throws would be asked again on every reopen.
    persist(clean, stored);
    if (ctx.log && ctx.log.debug) {
      ctx.log.debug(`[stats] payload ${done().toFixed(1)} ms (range ${clean.range.kind}, ${payload.range.days} days, `
        + `backend ${clean.backend ? 1 : 0}, project ${clean.project ? 1 : 0}, model ${clean.model ? 1 : 0})`);
    }
    return { ok: true, filter: clean, view, payload };
  } catch (err) {
    if (ctx.log && ctx.log.error) ctx.log.error('[stats] building the payload failed:', err);
    return { ok: false, error: 'The statistics could not be read.' };
  }
}

/**
 * What an export is built from (spec 48 V10): the same sanitise and payload path as `getStats`, run fresh with the full row
 * set, and nothing remembered (an export never changes the stored filter). `{ ok, filter, view, payload, projectName,
 * sessionsCap, sessionsTruncated }`; `projectName` is the display name of the filter's project (the filter itself carries a path).
 */
function getExportData(rawFilter, rawView) {
  if (!ctx) return { ok: false, error: 'The statistics are not ready.' };
  try {
    const know = knowledge();
    const clean = sanitiseFilter(rawFilter == null ? readStored() : rawFilter, know);
    const view = sanitiseView(rawView);
    const payload = buildPayload(clean, view, localDayKey(ctx.now()), know, true);
    const sessionsTruncated = payload.sessions.length > EXPORT_SESSIONS_CAP;
    if (sessionsTruncated) payload.sessions = payload.sessions.slice(0, EXPORT_SESSIONS_CAP);
    return {
      ok: true, filter: clean, view, payload, projectName: clean.project ? projectName(clean.project, know) : null,
      sessionsCap: EXPORT_SESSIONS_CAP, sessionsTruncated,
    };
  } catch (err) {
    if (ctx.log && ctx.log.error) ctx.log.error('[stats] building the export failed:', err);
    return { ok: false, error: 'The statistics could not be read.' };
  }
}

/**
 * `stats-facets`: the choices behind the filter bar's dropdowns, read lazily when one opens. Backends and models still
 * having rows under the OTHER filters, and the projects the page knows. `{ ok, backends, models, projects }`.
 */
function getFacets(rawFilter) {
  if (!ctx) return { ok: false, error: 'The statistics are not ready.' };
  try {
    const know = knowledge();
    const clean = sanitiseFilter(rawFilter == null ? readStored() : rawFilter, know);
    const range = resolveRange(clean.range, localDayKey(ctx.now()), ctx.db.getStatsFirstDate());
    const raw = ctx.db.getStatsFacets(toSqlFilter(clean, range, know));
    const owners = new Set();
    for (const id of raw.backends || []) {
      const owner = bucketOf(id, know.idx);
      if (know.backends.has(owner)) owners.add(owner);
    }
    const projects = [...know.projects.values()].map(p => ({ path: p, name: projectName(p, know) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      ok: true,
      backends: [...owners].map(id => backendFacts(id, know.idx)).sort((a, b) => a.label.localeCompare(b.label)),
      models: (raw.models || []).slice().sort(),
      projects,
    };
  } catch (err) {
    if (ctx.log && ctx.log.error) ctx.log.error('[stats] reading the facets failed:', err);
    return { ok: false, error: 'The filter choices could not be read.' };
  }
}

/**
 * `stats-set-rhythm`: fold or open the Rhythm block. Remembers the flag in the stored filter and nothing else, so the page
 * does not ask for a new payload to change a block it already holds. `{ ok }`.
 */
function setRhythmCollapsed(collapsed) {
  if (!ctx) return { ok: false };
  const stored = readStored();
  const next = { ...(stored && typeof stored === 'object' ? stored : defaultFilter()) };
  if (collapsed === true) next.rhythmCollapsed = true; else delete next.rhythmCollapsed;
  persist(next, stored);
  return { ok: true };
}

/**
 * `stats-usage-windows` (#883, spec 48 V11): the usage windows of the backends that report them, each with a projection to
 * its reset (usage-windows.js) and, for a window of a day or longer, this machine's tokens and cost since it started (E4).
 * `backend` is a CLI id or null for all. It reads what the poll already sampled and never fetches. Backend filter only.
 * `{ ok, windows: [{ backendId, backendLabel, colour, icon, key, label, percent, resetsAt, startsAt, windowMinutes,
 * elapsedFraction, projection, machine }] }`; `machine` is `null` under a day, for an expired window or when the query failed, else
 * `{ tokens, cost: { usd, estimated } | null, tokensPerHour }`.
 *
 * Templates do not count (E7): a template with its own endpoint or key is not on the subscription. A template session's row is
 * stored under the TEMPLATE's id (the provenance the user chose), so the id list is the CLI's non-template ids only, a GUI driver
 * that writes under it included. A removed template's rows carry an id the registry no longer lists and are left out as well.
 */
function getUsageWindows(rawBackend) {
  if (!ctx || !ctx.usageSampler) return { ok: false, error: 'The usage windows are not ready.' };
  try {
    const idx = backendIndex();
    const only = typeof rawBackend === 'string' && rawBackend ? rawBackend : null;
    const nowMs = ctx.now().getTime();
    const windows = [];
    // The registry's one answer to "whose usage is read" (#885): the owner's own switch or a launchable driver's.
    const readers = new Set(ctx.backends.usageReaders().map(b => b.id));
    for (const { backendId, window: w, projection } of usageWindows.describeAll(ctx.usageSampler, nowMs)) {
      const d = idx.byId.get(backendId);
      if (!d || !readers.has(backendId) || d.isProfile || (only && backendId !== only)) continue;
      const facts = backendFacts(backendId, idx);
      windows.push({
        backendId, backendLabel: facts.label, colour: facts.colour, icon: facts.icon, ...w, projection,
        machine: projection.basis === 'expired' ? null : machineFigures(w, backendId, idx, nowMs),
      });
    }
    return { ok: true, windows };
  } catch (err) {
    if (ctx.log && ctx.log.error) ctx.log.error('[stats] reading the usage windows failed:', err);
    return { ok: false, error: 'The usage windows could not be read.' };
  }
}

/** This machine's figures in one window, or null: under a day (E4), no query available, or the query failed. */
function machineFigures(w, backendId, idx, nowMs) {
  if (w.windowMinutes < MACHINE_MIN_WINDOW_MINUTES || !ctx.db.getUsageWindowFigures) return null;
  try {
    const start = new Date(w.startsAt);
    const ids = backendIds(backendId, idx).filter(id => { const d = idx.byId.get(id); return d && !d.isProfile; });
    const end = new Date(w.resetsAt);
    const rows = ctx.db.getUsageWindowFigures(ids, localDayKey(start), start.getHours(), localDayKey(end), end.getHours());
    const tokens = rows.reduce((sum, r) => sum + num(r.tokens), 0);
    const hours = (Math.min(nowMs, new Date(w.resetsAt).getTime()) - start.getTime()) / 3600000;
    return {
      tokens,
      cost: costFold(rows.map(partsOf), idx),
      tokensPerHour: hours > 0 ? tokens / hours : null,
    };
  } catch (err) {
    if (ctx.log && ctx.log.error) ctx.log.error('[stats] reading the usage window figures failed:', err);
    return null;
  }
}

function registerIpc(ipc) {
  ipc.handle('stats-get', (_event, filter, view) => getStats(filter, view));
  ipc.handle('stats-set-rhythm', (_event, collapsed) => setRhythmCollapsed(collapsed));
  ipc.handle('stats-facets', (_event, filter) => getFacets(filter));
  ipc.handle('stats-usage-windows', (_event, backend) => getUsageWindows(backend));
}

module.exports = {
  init, registerIpc, getStats, getFacets, getUsageWindows, getExportData, setRhythmCollapsed,
  FILTER_KEY, defaultFilter, sanitiseFilter, sanitiseRange, sanitiseView, resolveRange, localDayKey, localDayOf,
  backendIds, bucketOf, costFold, foldKeyFigures, foldImported, foldSeries, foldProjects, foldBackends, enumerateBuckets,
};
