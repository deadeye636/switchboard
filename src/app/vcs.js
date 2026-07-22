// VCS status poller + IPC (#277). The neutral core: it asks `src/vcs` which provider owns a working
// directory, polls it on an interval, caches per cwd, and pushes results to the renderer. It hardcodes
// no VCS — git is just the only provider registered today.
//
// Threading (O1): git runs via async `execFile` (a separate OS process, off the main loop, following
// the existing `worktree-status` precedent that used to live in main.js) with a timeout; the porcelain
// parse is capped. No worker.
//
// The scheduler (`createScheduler`) is deliberately Electron-free and injected with its deps so the
// dedupe / backoff / concurrency logic is node-testable (ctx rule, #213). `init`/`registerIpc` wire the
// real execFile + Electron surfaces on top.
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const vcs = require('../vcs');

const DEFAULT_POLL_SECONDS = 20;
const MIN_POLL_SECONDS = 5;
const STATUS_TIMEOUT_MS = 4000;
const CONCURRENCY_CAP = 3;
const PARSE_CAP = 500;
const BACKOFF_START_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const JITTER_MS = 750;

// ---------------------------------------------------------------------------
// Scheduler — pure logic, no Electron. Drives polling of a changing set of cwds.
// ---------------------------------------------------------------------------
/**
 * @param {object} deps
 * @param {(cwd:string)=>object|null} deps.detect        vcs.detect
 * @param {(provider, cwd, opts)=>Promise<object|null>} deps.runStatus  spawn+parse, resolves null on failure
 * @param {()=>number} deps.now                          clock (Date.now in prod)
 * @param {(cwd:string, summary:object|null)=>void} deps.onStatus  push to the renderer
 * @param {()=>{pollMs:number, countUntracked:boolean}} deps.getConfig
 * @param {(n:number)=>number} [deps.jitter]             injectable for tests (default random)
 */
function createScheduler(deps) {
  const { detect, runStatus, now, onStatus, getConfig } = deps;
  const jitter = deps.jitter || ((n) => Math.floor(Math.random() * n));

  // cwd -> { provider|null, summary, nextDue, backoffMs, inFlight, isRepo }
  const state = new Map();

  function ensure(cwd) {
    let s = state.get(cwd);
    if (!s) {
      const provider = detect(cwd);
      s = { provider, summary: null, nextDue: now(), backoffMs: BACKOFF_START_MS, inFlight: false, isRepo: !!provider };
      state.set(cwd, s);
    }
    return s;
  }

  // Replace the active set with `cwds`. Unknown cwds are added (polled soon); dropped cwds are removed.
  function watch(cwds) {
    const want = new Set((cwds || []).filter(c => typeof c === 'string' && c));
    for (const cwd of want) ensure(cwd);
    for (const cwd of [...state.keys()]) {
      if (!want.has(cwd)) state.delete(cwd);
    }
  }

  function inFlightCount() {
    let n = 0;
    for (const s of state.values()) if (s.inFlight) n++;
    return n;
  }

  function launch(cwd, s) {
    s.inFlight = true;
    const cfg = getConfig();
    const opts = { cap: PARSE_CAP, countUntracked: cfg.countUntracked };
    // Identity check (not `state.has`): if the cwd was dropped and re-added mid-flight, `ensure` made a
    // NEW state object — this stale chain must not touch it, or inFlightCount would undercount and let a
    // churn burst exceed the concurrency cap.
    const current = () => state.get(cwd) === s;
    Promise.resolve()
      .then(() => runStatus(s.provider, cwd, opts))
      .then((summary) => {
        if (!current()) return;                 // dropped/replaced while in flight
        if (summary == null) {                  // failure → back off, keep the last good summary
          s.backoffMs = Math.min(s.backoffMs * 2, BACKOFF_MAX_MS);
          s.nextDue = now() + s.backoffMs;
        } else {
          s.backoffMs = BACKOFF_START_MS;
          s.summary = summary;
          s.nextDue = now() + getConfig().pollMs + jitter(JITTER_MS);
          onStatus(cwd, summary);
        }
      })
      .catch(() => {
        if (!current()) return;
        s.backoffMs = Math.min(s.backoffMs * 2, BACKOFF_MAX_MS);
        s.nextDue = now() + s.backoffMs;
      })
      .finally(() => { if (current()) s.inFlight = false; });
  }

  // One heartbeat: launch due, non-in-flight repo polls up to the concurrency cap.
  function tick() {
    const t = now();
    let budget = CONCURRENCY_CAP - inFlightCount();
    if (budget <= 0) return;
    for (const [cwd, s] of state) {
      if (budget <= 0) break;
      if (!s.isRepo || s.inFlight || t < s.nextDue) continue;
      launch(cwd, s);
      budget--;
    }
  }

  // Force an immediate poll of one cwd (the changes window's Refresh button).
  function refresh(cwd) {
    const s = ensure(cwd);
    s.nextDue = now();
    if (s.isRepo && !s.inFlight && inFlightCount() < CONCURRENCY_CAP) launch(cwd, s);
  }

  function getCached(cwd) {
    const s = state.get(cwd);
    return s ? s.summary : null;
  }

  return { watch, tick, refresh, getCached, _state: state };
}

// ---------------------------------------------------------------------------
// Real status runner — execFile + parse + in-progress state.
// ---------------------------------------------------------------------------
function runStatusReal(provider, cwd, opts) {
  return new Promise((resolve) => {
    if (!provider) return resolve(null);
    execFile(provider.bin, provider.statusArgs(opts), {
      cwd,
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve(null);            // timeout / lock / transient → scheduler backs off
      let summary;
      try {
        summary = provider.parse(stdout, { cap: opts.cap, countUntracked: opts.countUntracked });
      } catch { return resolve(null); }
      // A rebase detaches HEAD, so the parser would say 'detached'; the `.git/` markers are the truth.
      try {
        const st = provider.detectState(cwd);
        if (st) summary.state = st;
      } catch { /* best-effort */ }
      resolve(summary);
    });
  });
}

// ---------------------------------------------------------------------------
// Electron wiring.
// ---------------------------------------------------------------------------
let ctx = null;
let scheduler = null;
let heartbeat = null;

function readConfig() {
  const g = (ctx && ctx.getSetting && ctx.getSetting('global')) || {};
  const enabled = g.vcsChipEnabled !== false;             // default on
  let pollSeconds = Number(g.vcsPollSeconds);
  if (!Number.isFinite(pollSeconds)) pollSeconds = DEFAULT_POLL_SECONDS;
  else if (pollSeconds < MIN_POLL_SECONDS) pollSeconds = MIN_POLL_SECONDS;   // clamp to the floor, don't reset
  return { enabled, pollMs: pollSeconds * 1000, countUntracked: g.vcsCountUntracked !== false };
}

function pushStatus(cwd, summary) {
  const w = ctx && ctx.getMainWindow && ctx.getMainWindow();
  if (w && !w.isDestroyed()) w.webContents.send('vcs-status-changed', { cwd, summary });
}

// --- The standalone changes window: one per cwd, destroy-on-close (#277 F3) ---
// Electron (BrowserWindow, shell) arrives via ctx so this module stays loadable under node --test.
const changesWindows = new Map();   // cwd -> BrowserWindow

function openChangesWindow(cwd, label) {
  const BrowserWindow = ctx && ctx.BrowserWindow;
  if (!BrowserWindow || typeof cwd !== 'string' || !cwd) return;
  const existing = changesWindows.get(cwd);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }

  const parent = ctx.getMainWindow && ctx.getMainWindow();
  const win = new BrowserWindow({
    width: 640, height: 660, minWidth: 420, minHeight: 320,
    title: `Changes — ${label || cwd}`,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    show: false,
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), nodeIntegration: false, contextIsolation: true },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'changed-files.html'), { query: { cwd, label: label || '' } });
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.on('closed', () => { changesWindows.delete(cwd); });
  changesWindows.set(cwd, win);
  // Force a fresh poll now; the vcs-watch handler unions open-window cwds so an open window's repo keeps
  // polling even if its project scrolls off the sidebar.
  if (scheduler) scheduler.refresh(cwd);
}

// Called from src/app/windows.js when the main window closes — a lingering child would keep
// `window-all-closed` from firing (same reason the settings window is destroyed there).
function destroyAllVcsWindows() {
  for (const win of changesWindows.values()) {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }
  changesWindows.clear();
}

function init(context) {
  ctx = context;
  scheduler = createScheduler({
    detect: (cwd) => vcs.detect(cwd),
    runStatus: runStatusReal,
    now: () => Date.now(),
    onStatus: pushStatus,
    getConfig: () => readConfig(),
  });
  // 1s heartbeat: cheap, and the actual poll cadence is governed by each cwd's nextDue.
  heartbeat = setInterval(() => {
    try { if (readConfig().enabled) scheduler.tick(); } catch (e) { ctx.log && ctx.log.debug && ctx.log.debug('[vcs] tick error', e); }
  }, 1000);
  if (heartbeat.unref) heartbeat.unref();
}

function stop() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

// The renderer tells us which repo cwds are on screen (project + worktree headers). We poll exactly
// those; live-PTY sessions are already among them because their projects are rendered.
function registerIpc(ipc) {
  ipc.on('vcs-watch', (_event, cwds) => {
    if (!scheduler) return;
    // Keep polling any open changes-window cwd even if its project scrolled off the sidebar.
    const windowCwds = [...changesWindows.keys()];
    if (!readConfig().enabled) { scheduler.watch(windowCwds); return; }
    scheduler.watch([...(Array.isArray(cwds) ? cwds : []), ...windowCwds]);
  });

  ipc.on('open-changes-window', (_event, payload) => {
    const cwd = payload && payload.cwd;
    openChangesWindow(cwd, payload && payload.label);
  });

  ipc.handle('vcs-reveal', (_event, filePath) => {
    if (ctx && ctx.shell && typeof filePath === 'string' && filePath) {
      try { ctx.shell.showItemInFolder(path.resolve(filePath)); } catch { /* best-effort */ }
    }
  });

  ipc.handle('vcs-status', (_event, cwd) => (scheduler ? scheduler.getCached(cwd) : null));

  ipc.handle('vcs-refresh', (_event, cwd) => {
    if (scheduler && typeof cwd === 'string' && cwd) scheduler.refresh(cwd);
    return scheduler ? scheduler.getCached(cwd) : null;
  });

  // Moved out of main.js (#277 F5): the worktree-delete dialog's dirty check. Now with
  // `--no-optional-locks` (H1) so it can't fight the session's own git.
  ipc.handle('worktree-status', (_event, worktreePath) => {
    return new Promise((resolve) => {
      if (typeof worktreePath !== 'string' || !worktreePath) {
        return resolve({ ok: false, error: 'No worktree path' });
      }
      const normalizedPath = worktreePath.replace(/\/$/, '');
      const re = ctx.worktreePathRe;
      const match = re ? normalizedPath.match(re) : null;
      if (!match) return resolve({ ok: false, error: 'Path does not match a recognized worktree layout' });
      const parentRepo = match[1];
      execFile('git', ['--no-optional-locks', '-C', parentRepo, '-C', normalizedPath, 'status', '--porcelain'],
        { windowsHide: true }, (err, stdout, stderr) => {
          if (err) return resolve({ ok: false, error: (stderr || err.message || String(err)).trim() });
          const dirty = stdout.split('\n').map(l => l.trimEnd()).filter(Boolean);
          resolve({ ok: true, dirty, total: dirty.length });
        });
    });
  });
}

module.exports = { init, registerIpc, stop, destroyAllVcsWindows, createScheduler, runStatusReal, _readConfig: readConfig };
