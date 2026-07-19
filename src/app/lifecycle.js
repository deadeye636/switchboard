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
// `node --test` — that is what lets `makeRunScheduleCommand` be tested. A scheduled run is the one path
// here with a rule of its own: it must ask Claude's enable gate (#162), because a cron tick that silently
// keeps spawning a disabled backend is exactly what it used to do.
'use strict';

const path = require('path');

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
 * The scheduler's runner, shared by the cron tick and "run now". Takes argv, not a shell string.
 *
 * Built as a factory so it can be tested: it is the one lifecycle path with a rule that broke silently.
 * @returns {(claudeArgv: string[], cwd: string, name: string, onDone?: (err?: Error) => void) => void}
 */
function makeRunScheduleCommand(ctx) {
  return function runScheduleCommand(claudeArgv, cwd, name, onDone) {
    const globalSettings = ctx.getSetting('global') || {};
    const profileId = globalSettings.shellProfile || ctx.SETTING_DEFAULTS.shellProfile;
    const profile = ctx.resolveShell(profileId);
    const shell = profile.path;

    // Scheduled runs are Claude-only by design: the schedule UI composes Claude's headless argv. So
    // they answer to Claude's enable gate like everything else (#162) — a disabled backend must not
    // keep spawning its binary from a cron tick, which is exactly what this path did, silently,
    // because it never asked. Refuse loudly instead: a scheduled task that quietly stops running is
    // worse than one that says why.
    if (!ctx.backends.isLaunchable('claude')) {
      const msg = `[schedule] "${name}" skipped: Claude Code is disabled (scheduled runs are Claude-only).`;
      ctx.log.warn(msg);
      if (typeof onDone === 'function') onDone(new Error('Claude Code is disabled — scheduled runs need it.'));
      return;
    }

    // A scheduled run is a session the user asked for, so its project goes on the list (#167) — in both
    // modes, like any other launch. Without this, a schedule pointed at a project the user has not added
    // writes transcripts that never show up anywhere: real sessions, invisible, with no way to find them.
    if (cwd) { try { ctx.ensureProjectAdded(cwd); } catch { /* the scan will get it in auto mode */ } }

    // The binary name comes from the backend descriptor, not a literal (T-1.7) — so no `'claude '`
    // command build survives outside backends/.
    const cmd = (ctx.backends.get('claude')?.binary || 'claude') + ' ' + ctx.quoteArgvForShell(shell, claudeArgv);
    const args = ctx.shellArgs(shell, cmd, profile.args || []);

    // cmd.exe: Node's default arg joining escapes embedded `"` as `\"`, which
    // cmd does not understand — pass the pre-quoted line verbatim instead
    // (same failure class as the node-pty launch path, see ptyShellArgs).
    const isCmdShell = path.basename(shell).toLowerCase().startsWith('cmd');

    ctx.log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
    const child = ctx.spawnChild(shell, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Same isolation the interactive spawn path applies (#241): under a demo/sandbox run the CLI must
      // write into the isolated home, not the user's real one. A scheduled run is still a real session —
      // without this it was the one path that kept writing into `~/.claude/projects` from an instance
      // that promises it touches nothing real. Null (the normal case) merges nothing.
      env: {
        ...ctx.cleanPtyEnv,
        FORCE_COLOR: '0',
        ...(ctx.backends.get('claude')?.cliHomeEnv?.() || {}),
      },
      windowsVerbatimArguments: isCmdShell,
    });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('exit', (code) => {
      if (stderr.trim()) ctx.log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
      ctx.log.info(`[schedule] ${name} finished (exit ${code})`);
      if (onDone) onDone();
    });

    child.on('error', (err) => {
      ctx.log.error(`[schedule] ${name} error:`, err.message);
      if (onDone) onDone();
    });
  };
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
    // Remove IDE lock files left behind by a crashed instance whose PID was
    // reused (the function only unlinks locks matching our own pid).
    ctx.cleanStaleLockFiles(ctx.log);
    ctx.scheduleIpc.ensureScheduleCreatorCommand();

    const runScheduleCommand = makeRunScheduleCommand(ctx);
    ctx.scheduleIpc.init(ctx.log, runScheduleCommand);
    ctx.startScheduler(ctx.log, runScheduleCommand);

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

  app.on('before-quit', () => {
    // Stop any pending debounced cache flush from running after the DB closes (#90).
    ctx.setAppQuitting(true);

    // Leave no hook pointing at a port nobody listens on: Claude Code blocks on every
    // UserPromptSubmit until it times out, in every project, not just ours (#125). The
    // next boot rewrites the hook, so removing it here costs nothing.
    try { if (ctx.attentionHooksEnabled()) ctx.removeClaudeAttentionHook(); } catch { /* best effort */ }
    ctx.cleanupHandoffExports();

    // Shut down all MCP servers
    ctx.shutdownAllMcp();

    // Remove the tray icon
    ctx.destroyTray();

    // Close filesystem watchers
    ctx.stopProjectsWatcher();
    ctx.stopBackendWatchers();

    // Kill all PTY processes on quit
    for (const [, session] of ctx.activeSessions) {
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
    }

    // Wipe any secret-ref temp files written for inline secret insertion.
    ctx.cleanupSecretRefs();

    // Flush the launch-time backend/profile overlay so a session started just before quit keeps
    // its provenance across the restart (§5.7).
    try { ctx.flushSessionBackends(); } catch {}
  });

  // Close SQLite after all windows are closed to avoid "connection is not open" errors
  app.on('will-quit', () => {
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
  });
}

module.exports = { shouldUseSingleInstanceLock, makeRunScheduleCommand, start, registerQuitHandlers };
