// live-agents.js — which Claude sessions a live process currently holds (#172).
//
// Claude refuses to open a session that is already running, and says so by dying: the resume spawns, the
// CLI prints "Session <id> is currently running as a background agent", the tab exits 1. The user clicked
// an action the app was never able to perform. To refuse it BEFORE the PTY exists, something has to know
// what is running — and only the CLI does.
//
// `claude agents --json` is that answer, documented in its own help as being for scripting and not needing
// a TTY. Measured against the installed CLI, it costs ~0.55 s and answers two differently shaped entries:
//
//   background   { id, cwd, kind, startedAt, sessionId, name, state }     <- no pid, has `state`
//   interactive  { pid, cwd, kind, startedAt, sessionId, name, status }   <- has pid, has `status`
//
// Both shapes are normalized here, so nothing downstream has to know which kind carries which key.
//
// TWO RULES, and both are about not making things worse:
//
//   1. FAIL OPEN. A timeout, a non-zero exit, unparseable output — every one of them answers `null`, which
//      means "do not know" and lets the spawn proceed exactly as it does today. A false refusal locks the
//      user out of a session that is perfectly free, which is worse than the dead tab this prevents.
//   2. NEVER SPAWN ON THE CLICK PATH. `peek()` reads the cache and returns null when it is cold; only
//      `refresh()` runs the child process, and it is called by the poller. So a resume click costs 0 ms
//      and the guard fires whenever the answer happens to be fresh — which, with the poller running, is
//      nearly always.
//
// ELECTRON-FREE, and `execFile` is injected, so `node --test` drives every path without a CLI installed.
'use strict';

const { execFile } = require('child_process');
const { closeStdin } = require('../cli-probe');

// How long an answer stays usable.
//
// IT MUST OUTLIVE THE POLL INTERVAL, and getting that backwards is not a tuning question — it is the
// difference between a guard that works and one that never fires. At 15 s against a 45 s poll (measured:
// a real resume of a live background agent spawned anyway) the cache was cold for two thirds of every
// interval, and the click path only ever reads the cache. So this is one interval plus room for a slow
// tick; `app/live-owners.js` owns the interval and this is written against it.
//
// The cost of the other direction is bounded and recoverable: an entry at most a minute old can name a
// session that has since ended, which produces a dialog the user clicks "Resume anyway" on.
const DEFAULT_TTL_MS = 60000;
// A CLI that does not answer must not hold anything up. Measured at ~0.55 s, so this is six times the
// observed cost — long enough for a loaded machine, short enough that the poller never stacks up.
const DEFAULT_TIMEOUT_MS = 3000;

let cache = { at: 0, entries: null };
let inFlight = null;

/** One entry per live session, with the two shapes flattened into one. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!sessionId) return null;
  const kind = raw.kind === 'background' || raw.kind === 'interactive' ? raw.kind : 'unknown';
  return {
    sessionId,
    kind,
    // Only an interactive entry carries one. A background agent runs under the daemon, so there is no pid
    // to name — and a message that says "pid undefined" is worse than one that does not mention it.
    pid: Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    // `state` on a background agent, `status` on an interactive one — same question, two keys.
    state: typeof raw.state === 'string' ? raw.state : (typeof raw.status === 'string' ? raw.status : ''),
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
  };
}

function parseAgents(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed.map(normalizeEntry).filter(Boolean);
}

/**
 * The last answer, if it is still fresh. Never spawns, never waits — this is what the spawn path calls.
 *
 * `null` means "do not know", which is also what a cold cache means. The caller must treat the two the
 * same: neither is evidence that the session is free.
 */
function peek({ ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!cache.entries) return null;
  if (now - cache.at > ttlMs) return null;
  return cache.entries;
}

/** Who holds this session right now, from the cache only. */
function ownerOf(sessionId, opts = {}) {
  if (!sessionId) return null;
  const entries = peek(opts);
  if (!entries) return null;
  return entries.find((e) => e.sessionId === sessionId) || null;
}

/**
 * Ask the CLI. Resolves with the entries, or `null` when the question could not be answered.
 *
 * Concurrent callers share one child process: the poller and a manual refresh can land in the same tick,
 * and two `claude` processes to answer one question is exactly the cost this module exists to bound.
 */
function refresh({
  exec = execFile,
  bin = 'claude',
  // The environment the CLI is asked IN. Passed by the descriptor, which knows this backend's home
  // variable — main's own environment does not carry it, so an isolated instance would otherwise ask the
  // user's real installation what is running. Undefined means "inherit", which is only right when no
  // isolation is in play.
  env = undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (inFlight) return inFlight;
  inFlight = new Promise((resolve) => {
    let settled = false;
    const done = (entries) => {
      if (settled) return;
      settled = true;
      inFlight = null;
      if (entries) cache = { at: now(), entries };
      resolve(entries);
    };
    try {
      // execFile, never a shell string (CLAUDE.md rule 10) — the arguments are two literals and nothing
      // the user typed reaches this call. `windowsHide` so a poller does not flash a console window every
      // interval on Windows.
      //
      // The one exception is a `.cmd`/`.bat` shim, which is what an npm-installed CLI resolves to on
      // Windows: Node refuses to spawn one without a shell. The measured install here is a real `.exe`,
      // so this branch exists for the machines where it is not — with the same two constant arguments.
      const viaShim = /\.(cmd|bat)$/i.test(String(bin));
      //
      // And its stdin is closed (#532): the child is only ever read from, and a CLI that reads standard
      // input before answering would sit on an open pipe until the timeout.
      closeStdin(exec(bin, ['agents', '--json'], { timeout: timeoutMs, windowsHide: true, shell: viaShim, env }, (err, stdout) => {
        if (err) return done(null);
        done(parseAgents(String(stdout || '')));
      }));
    } catch {
      done(null);
    }
  });
  return inFlight;
}

/** For tests, and for a wiring that starts over. */
function reset() {
  cache = { at: 0, entries: null };
  inFlight = null;
}

module.exports = {
  peek,
  ownerOf,
  refresh,
  reset,
  DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  // For tests: the two entry shapes are the part most likely to change under a CLI update.
  _parseAgents: parseAgents,
};
