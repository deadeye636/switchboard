// The app's lifecycle: the single-instance decision, everything that happens once Electron is ready, and
// the ordered teardown on quit.
//
// The teardown order is the part that matters, and every step of it is a bug someone hit:
//   before-quit  sets appQuitting FIRST — every debounced flush, every late PTY chunk and every worker
//                reply checks it, and without it they reach a DB that will_quit has closed (#90).
//   will-quit    flushes, then TERMINATES the workers, then closes the DB. Terminate-then-close accepts
//                the loss of the last debounce window (the next start's reconcile catches it); the other
//                order gives "The database connection is not open" (#76).
//
// Electron arrives through ctx (app, session, BrowserWindow), which keeps this file loadable in
// `node --test`.
'use strict';

const path = require('path');
const sessionShutdown = require('./session-shutdown');
const { markTurnSubmitted } = require('./terminal/live-record-notice');

/**
 * Does this build take the single-instance lock? Everything does now, unless it opts out (#220).
 *
 * The packaged app must: replacing the AppImage while Switchboard runs makes the OS spawn the new binary,
 * which would otherwise initialise a second process and orphan the first one's PTYs.
 *
 * A dev build used to be exempt, and the reason was real: `npm start` must not be handed to the installed
 * app instead of starting. That reason died with **#216**, which gave the dev build its own `userData`.
 * Electron scopes the lock to the userData directory — verified, not assumed: two instances pointed at
 * different userData dirs BOTH get the lock and run side by side, while a second instance on the SAME dir
 * is refused and the first sees `second-instance`. So a dev lock and the installed app's lock are simply
 * different locks, and a dev instance taking one hands nothing to the installed app.
 *
 * What the exemption cost: a dev run whose launcher was killed (a stopped `start:debug`, a closed
 * terminal, an agent's background task) left Electron alive with no window, still holding
 * `--remote-debugging-port=9222` and still writing to `~/.switchboard-dev/switchboard.db`. The next
 * `scripts/drive-app.js` then attached to THAT process and reported on code no longer on disk — a
 * verification that reads as a pass and is worth nothing.
 *
 * `SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES=1` is the escape hatch for deliberately running two dev builds.
 * It does not apply to the packaged app, whose behaviour is unchanged.
 */
function shouldUseSingleInstanceLock({ isPackaged, env = process.env } = {}) {
  if (isPackaged) return true;                                          // unchanged, and not negotiable
  if (env.SWITCHBOARD_FORCE_SINGLE_INSTANCE === '1') return true;       // the old opt-in, still honoured
  if (env.SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES === '1') return false;   // deliberately running two
  return true;
}

/**
 * Boot. Returns false when this launch handed itself to an already-running instance and is quitting.
 *
 * Prevent a second Electron instance from killing active PTY sessions. This happens when the user
 * replaces the AppImage while Switchboard is running: the OS spawns the new binary, which would otherwise
 * initialise a second process and leave the first one's node-pty sessions orphaned or killed.
 * Development builds intentionally skip it so `npm start` can run beside the installed app while
 * validating local changes.
 */
function start(ctx) {
  const { app } = ctx;
  const useSingleInstanceLock = shouldUseSingleInstanceLock({ isPackaged: app.isPackaged, env: process.env });
  const gotSingleInstanceLock = !useSingleInstanceLock || app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    // Say what happened, and say it at a level the launch actually shows. The instance holding the lock
    // may have no window (a dev run whose launcher was killed), in which case the `second-instance` focus
    // below is a no-op and this line is the ONLY thing distinguishing "refused" from "started fine and
    // vanished". Naming userData is what makes it actionable: it identifies WHICH instance is in the way.
    ctx.log.info(`[lifecycle] another instance is already running on this userData ` +
      `(${app.getPath('userData')}) — quitting. ` +
      (app.isPackaged ? 'Its window has been focused.'
        : 'If it is a leftover dev run with no window, stop it; ' +
          'set SWITCHBOARD_ALLOW_MULTIPLE_INSTANCES=1 to deliberately run two.'));
    app.quit();
    return false;
  }

  // Focus the existing window when a second launch is attempted.
  if (useSingleInstanceLock) {
    app.on('second-instance', () => {
      const mainWindow = ctx.getMainWindow();
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(() => {
    // Wipe any secret-ref temp files left behind by a previous run that didn't
    // quit cleanly (crash) — plaintext must not survive a restart.
    try { ctx.cleanupSecretRefs(); } catch {}
    // Same for the per-terminal binding files a backend writes at spawn (#223). They are removed when the
    // PTY exits, but a crash — or `npm run stop:dev`, which sends no before-quit — skips that handler, and
    // one file per session would then accumulate for the life of the install. Harmless individually (the
    // CLI that read it is long gone), which is exactly why nothing would ever notice the pile.
    try { ctx.cleanupClearBindings(); } catch {}
    // One-time: Claude's launch options move from the settings root into backendDefaults.claude.
    // Runs before any window reads settings, so the panel never sees the half-migrated shape.
    try { ctx.migrateClaudeLaunchDefaults(); } catch (err) {
      ctx.log.warn('[settings] Claude launch-defaults migration failed:', err?.message || err);
    }
    // Set Content Security Policy
    ctx.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          // UNCHANGED for the PDF viewer (#465), and that is the point of how it was built: pdf.js
          // draws the pages into canvases this app owns, so the document never becomes a frame and
          // needs no `object-src`/`frame-src` of its own. Widening those was tried first, together
          // with Chromium's built-in viewer, and measured as useless — see spec 21.
          'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'"],
        },
      });
    });

    ctx.buildMenu();
    ctx.createWindow();
    ctx.createTray();
    ctx.startProjectsWatcher();
    // Watch the other enabled backends' own stores (Codex's rollout tree, later Hermes' state.db)
    // so their sessions appear live, not just after a restart (T-4.8).
    ctx.startBackendWatchers();
    ctx.startAttentionHookServer();
    // Who else is running one of our sessions (#172). Its own first fetch is delayed — nothing on screen
    // needs the answer while the cold-start scan is running.
    try { ctx.startLiveOwners(); } catch { /* a build without the module still boots */ }
    // The database's own upkeep (#430) — deliberately NOT on this path: it arms a timer and returns, so
    // the merge and the reclaim land well after the first render and after the cold-start scan that
    // writes the very tables they touch.
    try { ctx.startDbUpkeep(); } catch (err) {
      ctx.log.warn('[db-upkeep] could not be scheduled:', err?.message || err);
    }
    // Remove IDE lock files left behind by a crashed instance whose PID was
    // reused (the function only unlinks locks matching our own pid).
    ctx.cleanStaleLockFiles(ctx.log);
    // Full cache rebuild on every startup — prunes stale rows for deleted
    // transcripts (sub-agent/workflow runs cleaned up between sessions leave
    // ghost rows in session_cache that show in the sidebar but are
    // inaccessible on open). populateCacheViaWorker runs in a Worker thread
    // and is non-blocking; concurrent callers share the same in-flight
    // Promise so the FTS-recreated path below (if also triggered) is free.
    ctx.populateCacheViaWorker().then(() => {
      // #57: run one auto-hide pass once the cache is populated on startup, so
      // stale projects are hidden before the first sidebar render settles.
      try { ctx.applyAutoHide(true); } catch {}
    });

    // File-trigger watcher — allows harness scripts to inject input into open
    // PTY sessions by dropping a JSON file in ~/.switchboard/triggers/.
    // Wrapped in try/catch so a boot failure here doesn't abort app.whenReady.
    try {
      ctx.startTriggerWatcher({
        log: ctx.log,
        getPtyForSession(sessionId) {
          const session = ctx.activeSessions.get(sessionId);
          if (!session || session.exited) return null;
          return { ptyProcess: session.pty };
        },
        isSessionBusy(sessionId) {
          const session = ctx.activeSessions.get(sessionId);
          return session ? !!session._cliBusy : false;
        },
        // A trigger writes its command and its Enter straight to the PTY, so `terminal-input` never
        // sees the turn (#512). The watcher owns no session objects, so the latch is applied here.
        noteTurnSubmitted(sessionId) {
          markTurnSubmitted(ctx.activeSessions.get(sessionId));
        },
      });
    } catch (err) {
      ctx.log.error('[trigger-watcher] Failed to start trigger watcher:', err.message);
    }

    // Re-index search if FTS table was recreated (e.g. tokenizer config change).
    // populateCacheViaWorker is already running above; the guard inside it
    // (populatePromise !== null) means this is a no-op on the same tick and
    // returns the shared Promise — no double scan.
    if (ctx.searchFtsRecreated()) ctx.populateCacheViaWorker();

    app.on('activate', () => {
      if (ctx.BrowserWindow.getAllWindows().length === 0) ctx.createWindow();
    });
  });

  return true;
}

/** The teardown. Order is load-bearing — see the header. */
function registerQuitHandlers(ctx) {
  const { app } = ctx;

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // The three states of quitting, and each one is a bug someone can trigger from the keyboard (#424):
  //   teardownStarted          the body below has run. A SECOND before-quit — Alt+F4 twice, a menu Quit
  //                            on top of a window close — must not run it again: it would re-kill from a
  //                            list already emptied, start a second wait over the same pids, and worst of
  //                            all could let a late `flushSessionBackends` write after will-quit closed
  //                            the DB, which is the #90 class of bug this file's header is about.
  //   sessionsConfirmedStopped the wait finished, so the quit we ask for ourselves goes straight through.
  //   systemShuttingDown       Windows is logging out. Holding a quit there is not caution, it is a race
  //                            against a grace window we do not control — the OS force-kills the tree and
  //                            the orphan comes back. Kill and get out of the way.
  let teardownStarted = false;
  let sessionsConfirmedStopped = false;
  let systemShuttingDown = false;

  // Every step of the teardown says that it ran (#397). Quitting happens once, so a handful of info
  // lines costs nothing — and it is the only thing that makes a future hang legible: the last line of a
  // SUCCESSFUL quit used to be the window teardown's `[detach] the app is going`, which is exactly the
  // line the one observed hang stopped at. A silent good path and a hang look identical in a log.
  const step = (msg) => { try { ctx.log.info(`[shutdown] ${msg}`); } catch { /* never hold a quit for a log line */ } };

  // Windows only, and it fires BEFORE before-quit.
  app.on('session-end', () => { systemShuttingDown = true; });

  app.on('before-quit', (event) => {
    // Stop any pending debounced cache flush from running after the DB closes (#90).
    ctx.setAppQuitting(true);

    // A repeat while the first pass is still waiting: hold the quit, change nothing. Letting it through
    // would run will-quit — and close the DB — underneath a teardown that has not finished.
    if (teardownStarted) {
      if (!sessionsConfirmedStopped && !systemShuttingDown) {
        // Said out loud, because from the outside it looks like the app ignored the keystroke — and a
        // user who hits Alt+F4 again is a user who already thinks the quit is stuck. The second pass we
        // ask for OURSELVES falls through silently: the line above it already said it was coming.
        step('a repeat quit request arrived while the first pass is still waiting — held');
        event.preventDefault();
      }
      return;
    }
    teardownStarted = true;
    step(systemShuttingDown ? 'quit requested by the system shutting down' : 'quit requested');

    // Leave no hook pointing at a port nobody listens on: Claude Code blocks on every
    // UserPromptSubmit until it times out, in every project, not just ours (#125). The
    // next boot rewrites the hook, so removing it here costs nothing.
    try { if (ctx.attentionHooksEnabled()) ctx.removeClaudeAttentionHook(); } catch { /* best effort */ }
    ctx.cleanupHandoffExports();

    // Shut down all MCP servers. With the log, so a quit that walks over an unanswered review says so
    // (#405) — quit is exactly when nobody is watching the screen to notice.
    ctx.shutdownAllMcp(ctx.log);

    // Remove the tray icon
    ctx.destroyTray();

    // Close filesystem watchers
    ctx.stopProjectsWatcher();
    ctx.stopBackendWatchers();

    // Ask every PTY still running to stop. The WAIT for them is below, after the rest of the teardown —
    // this used to be the whole of it, and a kill that had not landed by the time the process exited
    // never landed at all (#424).
    const asked = sessionShutdown.killAll(ctx.activeSessions);
    // Both numbers, because they usually differ and the difference is not a defect: the main window's
    // `closed` handler kills first and empties `activeSessions`, so a normal quit asks for NOTHING here
    // and still has pids to wait for. Logging only the first number reads like a teardown that skipped
    // the sessions.
    step(`asked ${asked} session process(es) to stop; ${sessionShutdown.pendingCount()} pid(s) to wait for`);

    // Wipe any secret-ref temp files written for inline secret insertion.
    ctx.cleanupSecretRefs();

    // Flush the launch-time backend/profile overlay so a session started just before quit keeps
    // its provenance across the restart (§5.7).
    try { ctx.flushSessionBackends(); } catch {}

    // …and only now let the process go (#424). Everything above is synchronous; a process exiting is
    // not. Quitting used to fire the kills and leave, so on a machine where a CLI took a moment to wind
    // down the app was already gone and the CLI was orphaned — which is exactly what a user then finds
    // still running with no window to reach it from.
    //
    // The quit is HELD for one round trip: this pass is cancelled, the pids are waited on (and the
    // stubborn ones get their whole tree killed), and then quit is asked for again. The flag is what
    // stops that second ask from cancelling itself in turn.
    //
    // Except during a system shutdown, where the kills above are all we get to do: the OS is not waiting
    // for us, and holding the quit only risks being force-killed mid-wait — with the orphan this whole
    // path exists to prevent.
    if (sessionsConfirmedStopped || systemShuttingDown) {
      step('not waiting for the processes — the system is going down');
      return;
    }
    event.preventDefault();
    step(`waiting up to ${sessionShutdown.DEFAULT_TIMEOUT_MS * 2} ms for the processes to go`);
    sessionShutdown.awaitAllStopped({ log: ctx.log })
      .catch((err) => ctx.log.warn(`[shutdown] could not confirm every session stopped: ${err.message}`))
      .then(() => {
        sessionsConfirmedStopped = true;
        step('the processes are settled — asking for the quit again');
        app.quit();
      });
  });

  // Close SQLite after all windows are closed to avoid "connection is not open" errors
  app.on('will-quit', () => {
    step('closing the workers and the database');
    // The file and directory watches the viewers hold (#452). An FSWatcher keeps a handle on the
    // filesystem, and #397's whole point is that anything still open here is a handle we opened.
    try { ctx.stopFileWatches(); } catch {}
    // Flush any debounced per-file re-index so the last transcript edits inside a
    // debounce window are persisted before we close the DB (perf review item H).
    try { ctx.flushPendingReindex(); } catch {}
    // Terminate an in-flight project scan so a late worker message can't write to
    // the DB after closeDb() ("connection is not open" at shutdown) (issue #76).
    try { ctx.terminateScanWorker(); } catch {}
    // Terminate the persistent index worker (#199): appQuitting is already set (before-quit), so the reply
    // handler drops any in-flight reply before applyIndexResults; terminate-then-close accepts the lost last
    // debounce window (the reconcile catches it next start). Extends the #76/#90 pattern.
    try { ctx.terminateIndexWorker(); } catch {}
    // Terminate the search worker gracefully before closing the DB, so the
    // worker's read-only connection is released before the WAL checkpoint.
    // shutdown() suppresses the restart logic before calling terminate().
    ctx.shutdownSearchClient();
    ctx.closeDb();
    // THE LAST LINE OF A CLEAN QUIT (#397). Everything Switchboard owns is closed here; anything that
    // keeps the process alive past this point is a handle nothing in this file opened, and a log that
    // ends on this line says so. electron-log's file transport writes synchronously, so it lands.
    step('everything is closed — nothing of ours is holding the process');
  });
}

module.exports = { shouldUseSingleInstanceLock, start, registerQuitHandlers };
