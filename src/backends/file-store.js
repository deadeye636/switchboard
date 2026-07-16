// backends/file-store.js — the FILE half of the discovery seam, written once (#156).
//
// A file-mode backend (Codex, Pi, and whatever comes next) keeps its history as one transcript per
// session under a store root. Discovering them, watching the root, and the two identity hooks that
// pair a live session with its record are then the SAME code every time — only the root, the filename
// shape and the parser differ. Codex and Pi carried that code verbatim, twice.
//
// That is not a tidiness complaint. It is the failure pattern behind #148-#155: a defect gets found in
// one backend, fixed there, and its twin keeps it. A file backend now composes this instead, and
// declares the three things that are genuinely its own:
//
//   createFileStore({
//     root:        () => '<store root>',              // LAZY — setHome()/setRoot() and tests move it
//     matches:     (filename) => boolean,             // which files are transcripts
//     parseSession: (handle) => row | null,           // the backend's own parser (correlation needs cwd+id)
//     refSuffix:   (sessionId) => '<suffix>',         // how a filename ends when it belongs to that id
//     birthHint?:  (filename) => ms | null,           // OPTIONAL coarse start time read from the NAME (#209)
//   })  ->  { discoverSessions, watchTargets, matchLiveSession, liveRefFor }
//
// A db-mode backend (Hermes) shares none of this and composes nothing — its store has no files.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve an executable NAME on PATH. On Windows the extension matters: npm ships these CLIs as `.cmd`
 * shims, so a bare `codex` never stats — hence PATHEXT.
 */
function findOnPath(name) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.trim()).filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Every file under `dir` (recursively) whose name `matches`. A store root that is not there yields none.
 *
 * `stats.errors` (when a stats object is passed) counts directories that could not be read — a permission
 * error or a lock on a SUBTREE. The caller needs that: a swallowed read error makes a subtree's sessions
 * simply absent from the result, indistinguishable from "the user deleted them" — and the reconcile would
 * then purge real history for a store we only failed to read (#197).
 */
function walkStore(dir, matches, out = [], stats = null) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { if (stats) stats.errors++; return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkStore(p, matches, out, stats);
    else if (e.isFile() && matches(e.name)) out.push(p);
  }
  return out;
}

/**
 * How far a filename-derived birth may be WRONG before we stop trusting it to mean "old" (#209).
 *
 * Deliberately huge. A transcript filename carries no timezone in the formats we read (Codex writes
 * `rollout-2026-07-01T10-00-00-<id>.jsonl`), so any reading of it can be off by a whole UTC offset — and a
 * hint that wrongly says "older than the spawn" would make a live session never pair with its record at
 * all, which is far worse than the stat it saves. 24 h swallows every offset plus clock skew, and still
 * drops everything but the last day of a store that spans months.
 */
const BIRTH_HINT_SKEW_MS = 24 * 60 * 60 * 1000;

function createFileStore({ root, matches, parseSession, refSuffix, birthHint } = {}) {
  if (typeof root !== 'function') throw new Error('file-store: root must be a function (the root moves)');
  if (typeof matches !== 'function') throw new Error('file-store: matches must be a function');
  if (typeof parseSession !== 'function') throw new Error('file-store: parseSession must be a function');
  if (typeof refSuffix !== 'function') throw new Error('file-store: refSuffix must be a function');
  if (birthHint != null && typeof birthHint !== 'function') throw new Error('file-store: birthHint must be a function');

  /** FILE-mode discovery: one {kind:'file'} handle per transcript. */
  function discoverSessions() {
    const storeRoot = root();
    const stats = { errors: 0 };
    const handles = walkStore(storeRoot, matches, [], stats).map(p => ({
      kind: 'file',
      path: p,
      // The filename usually carries the id too, but the header is authoritative — the parser reads it there.
      sessionId: null,
      parentSessionId: null,
      root: storeRoot,
    }));
    // A subtree that could not be read makes this result PARTIAL: its sessions are missing, not gone. Flag
    // it so the reconcile keeps unseen rows instead of deleting real history for a store it only half-read
    // (#197). A wholly-absent root also trips this, harmlessly: the whole-store guard already keeps
    // everything there. NON-enumerable so the handle list still deep-equals a plain array (the discovery
    // contract is "an array of handles"); the reconcile reads the flag off it directly.
    if (stats.errors > 0) Object.defineProperty(handles, 'incomplete', { value: true, enumerable: false });
    return handles;
  }

  /** STORE-level watch target: the root, recursively (new subdirectories appear on their own — a date
   *  bucket at midnight, a cwd folder with its first session). */
  function watchTargets() {
    return [{ kind: 'dir', path: root(), recursive: true }];
  }

  /**
   * Is this transcript unambiguously OLDER than the spawn, judged by its NAME alone (#209)?
   *
   * Reading a start time out of the filename costs no syscall; `statSync` costs one PER FILE, and this
   * loop runs on the main thread on every watcher flush while a session is still unpaired — measured at
   * ~163 ms of pure stat for a 5000-transcript store. So drop what the name already proves is too old
   * before touching the disk. Only ever a REJECT: a survivor is still stat'd, so the precise birth (and
   * the oldest-wins tiebreak below) is exactly what it was. Anything the hint cannot answer — no hook, an
   * unparseable name, a throw — falls through to the stat, which is the safe direction.
   */
  function tooOldByName(filePath, sinceMs) {
    if (sinceMs == null || !birthHint) return false;
    let hint;
    try { hint = birthHint(path.basename(filePath)); } catch { return false; }
    if (typeof hint !== 'number' || !Number.isFinite(hint)) return false;
    return hint < sinceMs - BIRTH_HINT_SKEW_MS;
  }

  /**
   * The NEW-session half of the identity seam. These CLIs name their own sessions, so the id we spawned
   * under is not the id the store records; until the two are paired the app shows two rows for one
   * session and resume targets an id the CLI never had.
   *
   * Correlate by CREATION time, not "most recently touched": the transcript header is written at startup,
   * so birth time is what lines up with the spawn. Newest-mtime would let an already-working session's
   * file be stolen by an older session whose own file is still just a header.
   */
  function matchLiveSession({ cwd, sinceMs, claimed } = {}) {
    const claimedSet = claimed instanceof Set ? claimed : new Set(claimed || []);
    let best = null;
    let bestBirth = Infinity;
    for (const handle of discoverSessions()) {
      if (claimedSet.has(handle.path)) continue;
      if (tooOldByName(handle.path, sinceMs)) continue;   // #209: no stat for what the name already rules out
      let st;
      try { st = fs.statSync(handle.path); } catch { continue; }
      const birth = st.birthtimeMs || st.mtimeMs;
      if (sinceMs != null && birth < sinceMs) continue;
      const row = parseSession(handle);
      if (!row || !row.sessionId || !row.cwd) continue;
      if (cwd && path.resolve(row.cwd) !== path.resolve(cwd)) continue;
      if (birth < bestBirth) { best = { sessionId: row.sessionId, ref: handle.path }; bestBirth = birth; }
    }
    return best;
  }

  /**
   * The RESUME half. `matchLiveSession` only accepts records BORN after the spawn, which a resumed
   * session's transcript never is — it already existed. Without this a resumed session would never claim
   * its own record (no busy/idle, and a re-scan of the whole store on every watcher flush), and the stale
   * claim could later adopt the id of the next NEW session in the same cwd.
   *
   * On resume we already hold the CLI's own id, so the filename settles it: matching the suffix costs a
   * readdir, where parsing every transcript to compare header ids would read the whole store.
   */
  function liveRefFor(sessionId) {
    if (!sessionId) return null;
    const suffix = String(refSuffix(String(sessionId))).toLowerCase();
    for (const handle of discoverSessions()) {
      if (handle.path && handle.path.toLowerCase().endsWith(suffix)) return handle.path;
    }
    return null;
  }

  return { discoverSessions, watchTargets, matchLiveSession, liveRefFor };
}

module.exports = { createFileStore, findOnPath, walkStore, BIRTH_HINT_SKEW_MS };
