'use strict';
// Where does this command live? Resolved on PATH without blocking the main process (#789 slice D).
//
// The external MCP server editor shows whether an entry's `command` exists. That is a PATH walk, and a PATH
// walk on this app's main thread is exactly what #722 and #750 measured and removed from the backend probes:
// ~1,300 stats for one name. So this module reads each PATH directory ONCE (`fs.promises.readdir`), shares that
// listing between every name asked for and for a few seconds between calls, and touches the disk per name only
// to reject a directory that happens to carry the command's name. There is no synchronous fs call anywhere in
// the file (`test/path-resolve.test.js` reads the source for it) and no child process.
//
// It mirrors `findOnPath` / `pathIndex` in `src/backends/file-store.js` — PATHEXT, first directory then first
// extension, case folding on Windows — and does NOT import it: `src/app/` may not reach into a backend folder.
// #790 (uv / uvx / pipx) is the second caller.
//
// THREE answers, and the third is the one that matters (`.claude/rules/backends.md`, #546): `missing` is a claim
// that needs evidence. It is given only when every directory on PATH was read, or was absent (`ENOENT` /
// `ENOTDIR`), and none was skipped. A directory that threw anything else, one that did not answer inside the
// budget, a network directory (never touched, #780 — the caller's `isForeignNetworkPath` decides) and a relative
// PATH entry (its meaning depends on a working directory this module will not guess) all make a miss `unknown`,
// with the reason. A hit is a hit whatever else went wrong on the way.
//
// Electron-free, db-free. Everything the world supplies arrives in `opts`, so a test runs a win32 case anywhere.

const nodePath = require('node:path');
const nodeFs = require('node:fs');

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const DEFAULT_BUDGET_MS = 2000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_CACHE_MS = 5000;
const TIMEOUT = Symbol('timeout');

// What each PATH directory held, shared by every call for `cacheMs`. Keyed on platform, PATH and PATHEXT: a
// changed environment is read afresh. Holds the PROMISES so two overlapping calls share one readdir.
let listing = null; // { key, at, dirs: Map<dir, Promise<{ names?: Set, absent?: true, err?: Error }>> }

/** Drop the shared listing, so the next call reads the directories again (a test, or a launch about to act on it). */
function forgetListing() {
  listing = null;
}

function envValue(env, key, win) {
  if (!env) return undefined;
  if (!win) return env[key];
  const k = Object.keys(env).find((x) => x.toUpperCase() === key);
  return k === undefined ? undefined : env[k];
}

function splitList(raw, delim, quoted) {
  if (!quoted) return raw.split(delim);
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of raw) {
    if (ch === '"') { q = !q; continue; }
    if (ch === delim && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function makeCtx(opts) {
  const platform = opts.platform || process.platform;
  const win = platform === 'win32';
  const pathMod = win ? nodePath.win32 : nodePath.posix;
  const env = opts.env || process.env;
  const budgetMs = Number.isFinite(opts.budgetMs) ? Math.max(0, opts.budgetMs) : DEFAULT_BUDGET_MS;
  const ctx = {
    win,
    pathMod,
    cwd: typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : null,
    fs: (opts.fs || nodeFs).promises,
    now: typeof opts.now === 'function' ? opts.now : Date.now,
    concurrency: Math.max(1, Math.floor(opts.concurrency) || DEFAULT_CONCURRENCY),
    cacheMs: Number.isFinite(opts.cacheMs) ? opts.cacheMs : DEFAULT_CACHE_MS,
    rawPath: String(envValue(env, 'PATH', win) || ''),
    exts: win
      ? String(envValue(env, 'PATHEXT', win) || DEFAULT_PATHEXT).split(';').map((e) => e.trim()).filter(Boolean)
      : [''],
    expired: false,
    timer: null,
    race: null,
    isForeign(p) {
      if (typeof opts.isForeignNetworkPath !== 'function') return false;
      // A guard that throws cannot say the path is safe to touch.
      try { return !!opts.isForeignNetworkPath(p); } catch { return true; }
    },
  };
  const expiredP = new Promise((resolve) => {
    ctx.timer = setTimeout(() => { ctx.expired = true; resolve(TIMEOUT); }, budgetMs);
    // Not unref'd: while a read is pending this timer is what guarantees an answer. It is bounded by the
    // budget and cleared when the call ends.
  });
  ctx.race = (p) => Promise.race([p, expiredP]);
  return ctx;
}

const unknown = (reason) => ({ state: 'unknown', reason });
const isAbsent = (err) => !!err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

/**
 * Absolute in the sense that matters here: independent of the process's current directory AND drive. Windows'
 * own `isAbsolute` also accepts a root-relative path (one leading separator, no drive, no UNC prefix), which resolves against
 * whatever drive the process happens to be on — that is relative for this module.
 */
function isAbsoluteStrict(p, ctx) {
  if (!ctx.pathMod.isAbsolute(p)) return false;
  return ctx.win ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) : true;
}

/** A name that carries a separator or a drive is a path, not something to look up on PATH. */
function isPathLike(name, ctx) {
  return ctx.win ? /[\\/]/.test(name) || /^[A-Za-z]:/.test(name) : name.includes('/');
}

/** The file names to try for `name`: as typed when it already ends in a PATHEXT extension, then name + each. */
function candidatesFor(name, ctx) {
  if (!ctx.win) return [{ file: name, ext: '' }];
  const lower = name.toLowerCase();
  const out = [];
  const typed = ctx.exts.find((e) => lower.length > e.length && lower.endsWith(e.toLowerCase()));
  if (typed) out.push({ file: name, ext: name.slice(name.length - typed.length) });
  for (const e of ctx.exts) out.push({ file: name + e, ext: e });
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `stat` raced against the budget: `{ st }`, `{ absent }`, `{ unreadable }` or `{ timeout }`. */
async function statOf(p, ctx) {
  if (ctx.expired) return { timeout: true };
  const r = await ctx.race(
    Promise.resolve().then(() => ctx.fs.stat(p)).then((st) => ({ st }), (err) => ({ err })),
  );
  if (r === TIMEOUT) return { timeout: true };
  if (r.err) return isAbsent(r.err) ? { absent: true } : { unreadable: true };
  return { st: r.st };
}

function isDir(st) {
  try { return !!st && typeof st.isDirectory === 'function' && st.isDirectory(); } catch { return false; }
}

/** One directory's names, from the shared listing or a fresh readdir. */
async function readDirectory(dir, cache, ctx) {
  if (ctx.expired) return { failed: 'timeout' };
  let p = cache.get(dir);
  if (!p) {
    p = Promise.resolve().then(() => ctx.fs.readdir(dir)).then(
      (list) => ({ names: new Set(Array.from(list, (n) => (ctx.win ? String(n).toLowerCase() : String(n)))) }),
      (err) => (isAbsent(err) ? { absent: true } : { err }),
    );
    cache.set(dir, p);
  }
  const r = await ctx.race(p);
  // An unanswered read is not an answer: do not hold it for the next caller.
  if (r === TIMEOUT) { if (cache.get(dir) === p) cache.delete(dir); return { failed: 'timeout' }; }
  if (r.err) { if (cache.get(dir) === p) cache.delete(dir); return { failed: 'unreadable' }; }
  return r.absent ? { names: new Set() } : { names: r.names };
}

// A Windows PATH entry that still holds a `%NAME%` (#793): nothing expands it when a process searches PATH, so it is
// a relative folder with that literal name. Measured: a Node spawn (libuv) ran a program from `<cwd>/%ZZPROBE%/bin`.
// It is skipped like any relative entry; the reason names it, so the user can fix their PATH.
const UNEXPANDED = /%[^%]+%/;

/** The PATH directories, read once; plus whether any entry was skipped and why. */
async function listPath(ctx) {
  const skipped = { network: false, relative: false, unexpanded: false };
  const dirs = [];
  const seen = new Set();
  const entries = splitList(ctx.rawPath, ctx.win ? ';' : ':', ctx.win);
  for (const raw of entries) {
    const entry = ctx.win ? raw.trim() : raw;
    if (!entry) {
      // POSIX: an empty entry (leading, trailing or doubled colon) means the current directory.
      if (!ctx.win) skipped.relative = true;
      continue;
    }
    const key = ctx.win ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isAbsoluteStrict(entry, ctx)) {
      if (ctx.win && UNEXPANDED.test(entry)) skipped.unexpanded = true;
      else skipped.relative = true;
      continue;
    }
    if (ctx.isForeign(entry)) { skipped.network = true; continue; }
    dirs.push(entry);
  }

  const key = `${ctx.win ? 'w' : 'p'}\0${ctx.rawPath}\0${ctx.exts.join(';')}`;
  const t = ctx.now();
  const age = listing ? t - listing.at : -1; // a clock set back is a stale listing, not an eternal one
  let cache;
  if (ctx.cacheMs > 0 && listing && listing.key === key && age >= 0 && age < ctx.cacheMs) cache = listing.dirs;
  else {
    cache = new Map();
    if (ctx.cacheMs > 0) listing = { key, at: t, dirs: cache };
  }
  const read = await mapLimit(dirs, ctx.concurrency, (dir) => readDirectory(dir, cache, ctx));
  return { dirs: dirs.map((dir, i) => ({ dir, ...read[i] })), skipped };
}

function missOrUnknown(failures, skipped) {
  if (failures.timeout) return unknown('timeout');
  if (failures.unreadable) return unknown('unreadable');
  if (skipped.network) return unknown('network');
  if (skipped.unexpanded) return unknown('unexpanded-path-entry');
  if (skipped.relative) return unknown('relative-path-entry');
  return { state: 'missing' };
}

async function walk(name, view, ctx) {
  const cands = candidatesFor(name, ctx);
  const failures = { timeout: false, unreadable: false };
  let fallback = null; // POSIX: the first hit without an execute bit, used only if no executable copy follows
  for (const d of view.dirs) {
    if (d.failed) { failures[d.failed] = true; continue; }
    for (const { file, ext } of cands) {
      if (!d.names.has(ctx.win ? file.toLowerCase() : file)) continue;
      const resolved = ctx.pathMod.join(d.dir, file);
      const s = await statOf(resolved, ctx);
      if (s.absent) continue; // a dangling link, or a file gone since the listing: not a hit
      if (s.st && isDir(s.st)) continue; // a directory with the command's name is not the command
      const answer = { state: 'found', resolved, ext };
      // A hit that cannot be classified (unreadable, timed out) is still a hit.
      if (s.st && !ctx.win && typeof s.st.mode === 'number') answer.executable = (s.st.mode & 0o111) !== 0;
      // execvp skips a file without an execute bit and runs a later executable copy.
      if (answer.executable === false) { if (!fallback) fallback = answer; continue; }
      return answer;
    }
  }
  if (fallback) return fallback;
  return missOrUnknown(failures, view.skipped);
}

async function resolveAsPath(name, ctx) {
  let base = name;
  if (!isAbsoluteStrict(name, ctx)) {
    if (!ctx.cwd || !isAbsoluteStrict(ctx.cwd, ctx)) return unknown('no-cwd');
    base = ctx.pathMod.resolve(ctx.cwd, name);
  }
  // Lexical, before anything touches the path: every candidate lives on the same share.
  if (ctx.isForeign(base)) return unknown('network');
  const failures = { timeout: false, unreadable: false };
  for (const { file, ext } of candidatesFor(base, ctx)) {
    const s = await statOf(file, ctx);
    if (s.timeout) { failures.timeout = true; continue; }
    if (s.unreadable) { failures.unreadable = true; continue; }
    if (s.absent || isDir(s.st)) continue;
    const answer = { state: 'found', resolved: file, ext };
    if (!ctx.win && typeof s.st.mode === 'number') answer.executable = (s.st.mode & 0o111) !== 0;
    return answer;
  }
  return missOrUnknown(failures, { network: false, relative: false, unexpanded: false });
}

/**
 * Resolve several command names against one PATH listing. Returns a Map name -> answer.
 *
 * opts: { env, cwd, isForeignNetworkPath(p), fs, now, budgetMs, concurrency, cacheMs, platform }
 * answer: { state: 'found' | 'missing' | 'unknown', resolved?, ext?, executable?, reason? }
 * reason (unknown only): 'empty-name' | 'no-cwd' | 'network' | 'unreadable' | 'timeout' | 'relative-path-entry'
 *   | 'unexpanded-path-entry'
 */
async function resolveCommands(names, opts = {}) {
  const ctx = makeCtx(opts);
  const out = new Map();
  try {
    const bare = [];
    for (const name of names) {
      if (out.has(name)) continue;
      if (typeof name !== 'string' || !name.trim()) { out.set(name, unknown('empty-name')); continue; }
      if (isPathLike(name, ctx)) out.set(name, await resolveAsPath(name, ctx));
      else bare.push(name);
    }
    if (bare.length) {
      const view = await listPath(ctx);
      for (const name of bare) out.set(name, await walk(name, view, ctx));
    }
  } finally {
    clearTimeout(ctx.timer);
  }
  return out;
}

async function resolveCommand(name, opts = {}) {
  return (await resolveCommands([name], opts)).get(name);
}

module.exports = { resolveCommand, resolveCommands, forgetListing };
