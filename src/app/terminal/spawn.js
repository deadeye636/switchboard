// The spawn: everything that turns "open a terminal for this session" into a live PTY.
//
// The biggest single thing main.js did, and the last of the nine to move (#213) precisely because it
// touches all the others: it mutates watch/adopt.js's live maps on exit, calls app/variables.js's secret
// cleanup, asks app/settings.js for the cascade, and hands the MCP bridge the window.
//
// WHAT IS ACTUALLY HARD HERE, so nobody "simplifies" it back:
//  - Resume is BACKEND-BOUND (§5.11). Resuming without an explicit choice must keep the session's
//    recorded backend, or it spawns `claude --resume <codex-uuid>` and hands the user a dead tab.
//    session_cache.backendId is the authoritative provenance; the overlay is only the bridge until the
//    first scan (§5.7).
//  - The OSC-0 TITLE heuristic is CLAUDE'S ALONE (#120). Its idle half is the literal character ✳. Run
//    it against a CLI that also spins in its title — Codex does — and the busy latch closes on the first
//    frame and can never open again: the tab reads "working" forever at an idle prompt.
//  - argv mode is not a preference, it is Windows. CreateProcess cannot run the `.cmd` shim an npm CLI
//    installs, so argv is honoured only when the command resolves to a real executable.
//  - The env order is backend → the user's backendEnv → template, and the template's keys are lifted out
//    of launch.env first. Get it backwards and a global variable silently overrides the template the
//    user picked by name.
//
// ctx is large because this handler genuinely is the crossroads. Every entry is either a `const`
// collaborator passed by reference, or a getter for something main.js reassigns — never a captured value.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const { resolveShell, isWindows, isWslShell, windowsToWslPath, ptyShellArgs, quoteArgvForShell } = require('./shell-profiles');
const { normalizeLauncher } = require('../../shared/custom-launchers');
const { appendToOutputBuffer, MAX_BUFFER_SIZE } = require('./output-buffer');
const { decideOsc94 } = require('./osc-busy');
const { afkTimeoutToEnvMs, resolveAfkTimeoutSec } = require('./afk-timeout');
const { encodeProjectPath } = require('../../session/encode-project-path');
const { conptyBuildHint } = require('./conpty');

let ctx = null;

/**
 * @param {object} context
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — see the ctx rule.
 * @param {() => boolean} context.getAppQuitting  also a getter: it flips during quit, and the PTY's own
 *   onData/onExit fire AFTER it does (ConPTY flushes asynchronously after kill), when the DB is closed.
 * @param {Map} context.activeSessions
 * @param {Map} context.liveStoreRef  watch/adopt.js's — the exit handler drops this session's claim
 * @param {Map} context.liveBusy
 * @param {object} context.cleanPtyEnv
 */
function init(context) {
  ctx = context;
}

const windowLive = () => {
  const w = ctx.getMainWindow();
  return !!w && !w.isDestroyed();
};
const sendToWindow = (channel, ...args) => {
  const w = ctx.getMainWindow();
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
};

/** The open-terminal handler. Reattaches to a live session, or spawns a new PTY for it. */
async function openTerminal(sessionId, projectPath, isNew, sessionOptions) {
  if (!ctx.getMainWindow()) return { ok: false, error: 'no window' };

  // Starting a session here is an explicit act, so the project goes on the list — in BOTH modes (#167).
  // The mode governs DISCOVERY (may a session that merely turned up in a store register its project?),
  // not the user. This used to fire in manual mode only, which read the setting as "I cannot start
  // anything anywhere new", and in auto mode the project appeared only once the transcript existed.
  if (projectPath) ctx.ensureProjectAdded(projectPath);

  // Reattach to existing session. `exited` is set the moment stop-session issues
  // the kill (#130), so between that and ptyProcess.onExit the entry still exists
  // while its PTY is already dead — reattaching there would wire the renderer to a
  // corpse. Fall through to the resume/spawn path instead.
  const existingSession = ctx.activeSessions.get(sessionId);
  if (existingSession && !existingSession.exited) {
    const session = existingSession;
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      sendToWindow('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      sendToWindow('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      sendToWindow('terminal-data', sessionId, '\x1b[?25l');
    }

    return { ok: true, reattached: true, mcpActive: !!session.mcpServer };
  }

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  const isPlainTerminal = sessionOptions?.type === 'terminal';

  // T-3.10 / T-3.5: a Tier-3 custom launcher (and the ad-hoc "Custom command…") rides on the plain
  // terminal path — the same MONITORED PTY tab, with the user's command typed into the shell once
  // it is up. It stays a terminal session: no backendId, no session file, nothing for the scanner.
  const launcher = isPlainTerminal ? normalizeLauncher(sessionOptions?.launcher) : null;
  const spawnCwd = ctx.resolveLauncherCwd(launcher, projectPath);

  // Resolve shell profile from effective settings.
  // T-3.7 — the shell is split by INTENT: `shellProfile` is the CLI shell (Claude and every backend
  // spawn), `terminalShellProfile` is the Terminal bucket (the in-app plain terminal + the External
  // Terminal action). Its default 'inherit' falls back to the CLI shell, so nothing changes until the
  // user actually sets it.
  const effectiveProfileId = isPlainTerminal
    ? ctx.resolveTerminalShellProfileId(projectPath)
    : ctx.effectiveSettings(projectPath).shellProfile;
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(spawnCwd);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  ctx.log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(ctx.projectsDir, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  // #114: prefer node-pty's bundled conpty.dll (Windows Terminal codebase) over the
  // in-box conhost ConPTY. The OS one mis-handles rapid cursor-up + erase-line redraw
  // cycles (Claude CLI's spinner), leaving stale/duplicated rows that only a resize
  // repaint clears. 'system' falls back to the OS ConPTY (the node-pty flag is
  // experimental). No effect on non-Windows platforms.
  const useConptyDll = isWindows && (ctx.effectiveSettings(projectPath) || {}).conptyBackend !== 'system';

  let ptyProcess;
  let mcpServer = null;
  // Set inside the backend branch below (where the descriptor is in scope) and consumed after the
  // session object exists — a backend may warn that it takes a while to become usable.
  let startupHint = null;
  // Was this meant to be a resume of an id the backend has never heard of (#290)? Set in the backend
  // branch, consumed twice out here: the session records that it is NOT a resume after all, and the
  // user is told in one line why their history is missing. Hoisted for the same reason startupHint is —
  // the label comes along because the descriptor is only in scope inside that branch.
  let resumeUnknown = false;
  let resumeUnknownLabel = '';
  // Does the OSC-0 TITLE busy heuristic apply to this session? Only for the claude binary — see the
  // session object below. Same reason `isClaudeBinary` exists, hoisted because the session is built out
  // here while the descriptor is only in scope in the branch.
  let oscTitleState = false;
  // #223: the terminal's identity for live re-binding. Minted here — before the backend branch — because
  // it must be STABLE across every re-key this terminal goes through; the session id is not, it is the
  // thing that changes. What the backend built (a temp file, typically) is cleaned up on exit.
  const terminalTag = crypto.randomUUID();
  let liveBindingCleanup = null;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command. Override `claude`
      // with a helpful hint so users don't try to launch it here. The override MUST
      // match the shell's syntax — a bash function def written into PowerShell/cmd
      // shows up as a garbage line (#23) — so branch per shell type.
      const shellBase = path.basename(shell).toLowerCase();
      const isPowerShell = shellBase.includes('pwsh') || shellBase.includes('powershell');
      const isCmd = shellBase === 'cmd.exe' || shellBase === 'cmd';
      const isBashLike = !isPowerShell && !isCmd; // bash/zsh/sh/fish/wsl
      const hint = 'To start a Claude session, use the + button in the sidebar.';
      const bashShim = `claude() { printf '\\033[33m%s\\033[0m\\n' '${hint}'; return 1; }; export -f claude 2>/dev/null;`;

      const env = {
        ...ctx.cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
        CLAUDECODE: '1',
      };
      // ENV (sh/dash) + BASH_ENV inject the function for bash-like shells; useless
      // for PowerShell/cmd, so don't set them there.
      if (isBashLike) { env.ENV = bashShim; env.BASH_ENV = bashShim; }

      // A custom launcher's env: `$VAR` refs resolved at spawn (an unresolved one is dropped — never a
      // literal secret on disk, §5.2 — and SAID, #169). It must be in place BEFORE the shell starts.
      if (launcher && launcher.env) {
        Object.assign(env, ctx.resolveSpawnEnv(launcher.env, launcher.name || 'Launcher', sessionId));
      }

      ptyProcess = pty.spawn(shell, ptyShellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : spawnCwd,
        env,
        useConptyDll,
      });

      // ENV/BASH_ENV don't apply to zsh/pwsh/cmd — write the shell-appropriate
      // override after the shell starts, then clear the pasted line.
      let initCmd;
      if (isPowerShell) {
        initCmd = `function claude { Write-Host "${hint}" -ForegroundColor Yellow }; Clear-Host\r`;
      } else if (isCmd) {
        initCmd = `doskey claude=echo ${hint} & cls\r`;
      } else {
        initCmd = bashShim + ' clear\n';
      }
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(initCmd);
          } catch {}
        }
      }, 300);

      // Type the launcher's command into the shell, after the init line above has been consumed.
      // Written into the PTY (not passed as `-c`/`/C` argv) so the interactive shell SURVIVES the
      // command: the tab keeps its output and stays usable, exactly as if the user had typed it.
      const launcherCmd = launcher ? ctx.composeLauncherCommand(shell, launcher) : '';
      if (launcherCmd) {
        ctx.log.info(`[launcher] in-app "${launcher.name}" session=${sessionId} cwd=${spawnCwd}`);
        setTimeout(() => {
          if (!ptyProcess._isDisposed) {
            try { ptyProcess.write(launcherCmd + '\r'); } catch {}
          }
        }, 600);
      }
    } else {
      // Route the launch through the backend registry (Phase 1, T-1.2). `claude` is the default
      // backend and reproduces today's exact argv/command; an Axis-A profile additionally supplies
      // an env bundle (merged into ptyEnv further down). Claude behaviour is byte-identical — the
      // arg logic now lives in backends/claude/index.js buildLaunch.
      // Resume is backend-bound (§5.11): when resuming/forking WITHOUT an explicit backend choice,
      // keep the session's recorded backend/profile from the overlay instead of clobbering it with
      // the `claude` default. In Phase 1 the overlay is empty for pre-existing sessions, so this is
      // byte-identical (recorded == null -> claude); it forecloses the resume-clobber landmine once
      // profiles ship (Phase 2/3). A fork inherits the source session's recorded backend too.
      let recorded = null;
      if (!sessionOptions?.backendId) {
        const lookupId = sessionOptions?.forkFrom || (!isNew ? sessionId : null);
        if (lookupId) {
          recorded = ctx.sessionBackends.get(lookupId);
          // The overlay is only the bridge until the first scan. `session_cache.backendId` is the
          // AUTHORITATIVE provenance (§5.7), so fall back to it — otherwise resuming a session the
          // overlay no longer knows (a scanner-discovered Codex session, or one whose entry aged out)
          // would silently default to `claude` and spawn `claude --resume <codex-uuid>`, which fails.
          //
          // Consult the cache ALSO when the overlay points at a backend that no longer resolves (#196):
          // a session launched under a TEMPLATE records that template's id (session-backends.record gets
          // `backend.id`, which for a profile launch is the profile id), and the template may since have
          // been deleted. The cache's backendId is the BASE backend the transcript was actually written
          // by, so this heals a deleted-template session onto its real base binary instead of Claude.
          if (!recorded || !ctx.backends.get(recorded.backendId)) {
            try {
              const row = ctx.getCachedSession(lookupId);
              if (row && row.backendId) recorded = { backendId: row.backendId, profileId: null };
            } catch { /* cache unavailable -> fall through to the claude default */ }
          }
        }
      }
      // A session with no recorded provenance predates the multi-LLM era: it is Claude's, by definition.
      // That inference is still right, and with Claude disableable (#162) it is also the reason such a
      // session cannot be resumed while Claude is off — which the user is owed a sentence about, not a
      // raw failure.
      const requestedId = sessionOptions?.backendId || recorded?.backendId || 'claude';
      const inferredClaude = !sessionOptions?.backendId && !recorded?.backendId;
      // A recorded provenance that STILL does not resolve (its backend/template was removed from this
      // build, and the cache heal above found nothing) must not silently become a Claude resume of a
      // foreign transcript — `claude --resume <codex-uuid>` gives a dead tab, where every other
      // bad-provenance branch below refuses with a sentence. Only the genuine `inferredClaude` case (no
      // provenance at all → really Claude's) may default to Claude (#196).
      const backend = ctx.backends.get(requestedId) || (inferredClaude ? ctx.backends.get('claude') : null);
      if (!backend) {
        return { ok: false, error: inferredClaude
          ? `Backend '${requestedId}' is not installed in this build.`
          : `The backend or template this session ran under ('${requestedId}') is no longer installed, `
            + `so it cannot be resumed. Re-create it, or start a new session.` };
      }
      startupHint = backend.startupHint || null;

      // §5.8 guard: only a `ready` (built) AND `enabled` (user-activated) backend may ever spawn. A
      // `planned` binary or a disabled backend is rejected here, before any PTY exists — the picker
      // never offers them, so reaching this is either a stale renderer or a crafted IPC call.
      if (!ctx.backends.isLaunchable(backend.id)) {
        const label = backend.label || backend.id;
        let error;
        if (backend.status === 'planned') {
          error = `Backend '${label}' is not built yet.`;
        } else if (backend.isProfile) {
          // A template runs its base backend's binary, so a disabled base leaves it nothing to launch.
          error = `'${label}' runs on ${backend.baseLabel || backend.baseId}, which is disabled. `
            + `Enable ${backend.baseLabel || backend.baseId} in Settings → Backends to use it again.`;
        } else if (inferredClaude) {
          error = 'This session was started before Switchboard supported other backends, so it belongs '
            + 'to Claude Code — which is currently disabled. Enable Claude Code in Settings → Backends '
            + 'to resume it. (It stays visible and searchable either way.)';
        } else {
          error = `Backend '${label}' is disabled. Enable it in Settings → Backends.`;
        }
        ctx.log.info(`[spawn] refused: backend=${backend.id} not launchable`);
        return { ok: false, error };
      }

      // Availability: a backend may declare that its binary is missing. Without this the user gets a
      // raw `'hermes' is not recognized...` from the shell inside a terminal tab, with no hint what to
      // install — the descriptor already knows the answer, so say it here instead of spawning.
      if (typeof backend.probe === 'function') {
        let avail;
        try { avail = backend.probe(); } catch (err) { avail = { ok: false, reason: err?.message || String(err) }; }
        if (avail && avail.ok === false) {
          ctx.log.info(`[spawn] backend=${backend.id} unavailable: ${avail.reason}`);
          return { ok: false, error: avail.reason || `${backend.label || backend.id} is not available.` };
        }
      }

      // Forking an id the backend never issued produces a dead tab ("No session found"). It happens with
      // every backend that names its own sessions: until it has written its store record we only hold OUR
      // id, which means nothing to it. Refuse with a sentence instead of spawning.
      if (sessionOptions?.forkFrom && typeof backend.liveRefFor === 'function') {
        let known = null;
        try { known = backend.liveRefFor(sessionOptions.forkFrom); } catch { known = null; }
        if (!known) {
          return {
            ok: false,
            error: `${backend.label || backend.id} does not know this session yet — it names its own `
              + 'sessions and records one only after the agent has answered. Send a message first, then fork.',
          };
        }
      }

      // RESUMING an id the backend never issued is the same defect as forking one, one door along (#290),
      // and it is the commoner of the two: until a backend that names its own sessions has written its
      // store record, the only id we hold is the one WE minted, and `<cli> -r <our-uuid>` matches nothing.
      // The session then starts empty (or dies), while our row keeps pointing at a record that will never
      // exist.
      //
      // Unlike fork, this must NOT refuse. `liveRefFor` answers "is this id in the store I am reading
      // right now", and a store that a CLI update moved or rewrote answers "no" for sessions that were
      // perfectly real — refusing there would lock the user out of every session of that backend at once.
      // So drop the `-r` and let it start fresh, with a sentence saying so.
      if (!isNew && !sessionOptions?.forkFrom && typeof backend.liveRefFor === 'function') {
        let known = null;
        try { known = backend.liveRefFor(sessionId); } catch { known = null; }
        if (!known) {
          resumeUnknown = true;
          resumeUnknownLabel = backend.label || backend.id;
          ctx.log.info(`[spawn] backend=${backend.id} does not know session ${sessionId} — starting a new session instead of resuming`);
        }
      }

      const launch = backend.buildLaunch({
        cwd: projectPath,
        resume: !isNew && !resumeUnknown,
        sessionId,
        forkFrom: sessionOptions?.forkFrom,
        options: sessionOptions || {},
      });
      // LIVE RE-IDENTIFICATION (#223). A backend that can tell us mid-flight that this terminal moved to
      // a new session id gets the chance to set that up now: it receives the terminal's tag and the URL
      // our ingest listens on, and answers with whatever its launch needs. Claude writes a per-spawn hook
      // settings file and asks for `--settings <file>`.
      //
      // The tag identifies the TERMINAL and must outlive every re-key — the session id will not.
      // Everything here is best-effort: no URL (server not up), no hook (backend declines), or a failed
      // write all mean the same thing, which is today's behaviour — the conservative single-live-session
      // rule, and a bail when it is ambiguous. A binding never becomes a launch failure.
      if (backend.supportsLiveRebinding === true && typeof backend.buildLiveBinding === 'function') {
        try {
          const url = ctx.clearBindUrl ? ctx.clearBindUrl(terminalTag) : null;
          const binding = url ? backend.buildLiveBinding({ dir: ctx.bindingDir, tag: terminalTag, url, log: ctx.log }) : null;
          if (binding && Array.isArray(binding.args) && binding.args.length) {
            launch.args = [...launch.args, ...binding.args];
            // Keep the RELEASE, not the descriptor: the exit handler runs far from here, where `backend`
            // is out of scope, and a re-lookup there could pick a different descriptor than the one that
            // created this. The backend decides what "release" means; the core only calls it.
            const release = binding.cleanup && typeof backend.releaseLiveBinding === 'function'
              ? (log) => backend.releaseLiveBinding(binding.cleanup, log)
              : null;
            liveBindingCleanup = release;
            ctx.log.info(`[clear-bind] session=${sessionId} terminal=${terminalTag.slice(0, 8)} bound via ${backend.id}`);
          }
        } catch (err) {
          ctx.log.warn(`[clear-bind] session=${sessionId} could not set up: ${err.message}`);
        }
      }

      // How this backend wants to be spawned (00 §4). Claude runs as a shell-quoted command string
      // (today's path). An Axis-B binary may ask for ARGV mode instead: Codex is happiest with clean
      // execFile-style argv, and Windows shell quoting mangles it.
      //
      // Windows caveat: argv mode spawns through CreateProcess, which can only execute a real binary.
      // A CLI installed via npm is usually a `.cmd` shim on PATH (that is what `codex` resolves to),
      // and CreateProcess cannot run one. So argv mode is honoured only when the command resolves to
      // an actual executable; otherwise we fall back to the shell path, which resolves the shim fine.
      const argvExe = launch.spawnMode === 'argv' ? ctx.resolveArgvExecutable(launch.command) : null;

      // A pre-launch command is a raw SHELL prefix (`nvm use 20 &&`, `aws-vault exec profile --`), so
      // there has to be a shell — and a command line — for it to sit in front of. Argv mode has neither.
      //
      // That is the entire reason this option was Claude's: Claude spawns through a shell, the Axis-B
      // backends spawn argv (Windows shell quoting mangles their arguments). It was never a statement
      // about Claude. So: keep argv as the default for everyone, and drop to the shell path for the one
      // session where somebody actually set a prefix. They asked for a shell; they get one, quoted by
      // the same `quoteArgvForShell` Claude has always used.
      const preLaunchCmd = String(sessionOptions?.preLaunchCmd || '').trim();
      if (preLaunchCmd && /[\r\n]/.test(preLaunchCmd)) {
        return { ok: false, error: 'The pre-launch command must not contain newlines.' };
      }

      const useArgvSpawn = !!argvExe && !preLaunchCmd;
      if (launch.spawnMode === 'argv' && !argvExe) {
        ctx.log.info(`[spawn] backend=${backend.id} wanted argv mode but '${launch.command}' is not a directly-executable binary here — using the shell path`);
      } else if (launch.spawnMode === 'argv' && preLaunchCmd) {
        ctx.log.info(`[spawn] backend=${backend.id} has a pre-launch command — starting through the shell instead of argv`);
      }

      // The MCP IDE bridge stays CLAUDE's: `--ide` is a claude flag and the bridge speaks Claude's own
      // protocol. Handing it to Codex would be a flag it does not know. (`preLaunchCmd` used to be gated
      // here too, for a reason that turned out to be about the spawn mode — see above.)
      const isClaudeBinary = launch.command === 'claude';
      oscTitleState = isClaudeBinary;

      let claudeCmd = null;
      if (!useArgvSpawn) {
        claudeCmd = launch.command + ' ' + quoteArgvForShell(shell, launch.args);
        if (preLaunchCmd) claudeCmd = preLaunchCmd + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (isClaudeBinary && sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await ctx.startMcpServer(sessionId, [projectPath], ctx.getMainWindow(), ctx.log);
          claudeCmd += ' --ide';
        } catch (err) {
          ctx.log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      // Core terminal env comes from the backend layer (single source of truth): iTerm identity so
      // Claude emits OSC 9, plus the MCP IDE-bridge port when one was started. Byte-identical to the
      // former inline block; shared with every backend spawn (T-1.2).
      const ptyEnv = {
        ...ctx.cleanPtyEnv,
        ...ctx.backends.backendCoreEnv({ mcpPort: mcpServer ? mcpServer.port : undefined }),
        // ISOLATED STORES (#241): a SWITCHBOARD_STORE_* override moves where Switchboard LOOKS, never
        // where the CLI WRITES — so a demo/sandbox session used to land in the user's real store and stay
        // invisible to the instance that launched it. The backend declares its own home variable
        // (CLAUDE_CONFIG_DIR, CODEX_HOME, …) and returns null when it isn't isolated, or has no such
        // variable at all (agy). Placed here, before the user's and the template's env, so an explicit
        // variable of theirs still wins.
        ...(typeof backend.cliHomeEnv === 'function' ? (backend.cliHomeEnv() || {}) : {}),
      };

      // Per-session AskUserQuestion timeout (#51): cascade session > project >
      // global, empty = inherit. Only inject when a value is actually set so an
      // unset field leaves Claude's built-in default (60s) in place.
      // The project/global halves now come from backendDefaults.claude (§4a), where every backend's
      // launch options live; the session half still overrides both.
      {
        const g = ((ctx.getSetting('global') || {}).backendDefaults || {}).claude || {};
        const p = projectPath
          ? (((ctx.getSetting('project:' + projectPath) || {}).backendDefaults || {}).claude || {})
          : {};
        const sec = resolveAfkTimeoutSec(sessionOptions?.afkTimeoutSec, p.afkTimeoutSec, g.afkTimeoutSec);
        const afkMs = afkTimeoutToEnvMs(sec);
        if (afkMs != null) {
          ptyEnv.CLAUDE_AFK_TIMEOUT_MS = afkMs;
          ctx.log.info(`[afk] session=${sessionId} CLAUDE_AFK_TIMEOUT_MS=${afkMs} (from sec=${sec})`);
        }
      }

      // Axis-A profile env bundle: resolve `$VAR` refs at spawn (never on disk, §5.2) and merge
      // over the base env — the profile OVERRIDES base. Empty for the Claude default, so this is a
      // no-op there (byte-identical). Then record the launch-time backend/profile OVERLAY (§5.7):
      // the scanner later merges it into the authoritative session_cache.backendId.
      // The env a session actually gets, least specific first:
      //   1. the BACKEND's own bundle — its `$VAR` auth refs, from buildLaunch
      //   2. the USER's variables for that backend (`backendEnv.<id>`). New: a plain backend could not
      //      carry any, so the only way to hand Codex a variable was to wrap it in a whole template
      //   3. the TEMPLATE's bundle, when this launch is a template — the most specific thing there is
      //
      // `launch.env` already has (1) ⊕ (3) merged, because a template's descriptor merges its bundle over
      // its base's. So lift the template's own keys back out first, or the user's backend variables would
      // land ON TOP of the template — the wrong way round, and silently.
      //
      // `$VAR` refs are resolved here, at spawn, and never written to disk (§5.2).
      {
        const allEnv = (ctx.getSetting('global') || {}).backendEnv || {};
        const baseId = backend.isProfile ? (backend.baseId || 'claude') : backend.id;
        const templateEnv = backend.isProfile ? (backend.templateEnv || {}) : {};

        const baseEnv = { ...(launch.env || {}) };
        for (const key of Object.keys(templateEnv)) delete baseEnv[key];

        // The template's name, not the backend's: three templates can reference three different keys,
        // and "OPENAI_API_KEY is not set" without saying WHOSE is a riddle (#169).
        Object.assign(ptyEnv, ctx.resolveSpawnEnv({
          ...baseEnv,
          ...(allEnv[baseId] || {}),
          ...templateEnv,
        }, backend.label || backend.id, sessionId));
      }
      const effectiveProfileId = sessionOptions?.profileId != null ? sessionOptions.profileId : (recorded?.profileId || null);
      ctx.sessionBackends.record(sessionId, backend.id, effectiveProfileId);

      const ptyOpts = {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
        useConptyDll,
      };

      if (useArgvSpawn) {
        // ARGV mode: spawn the binary directly, no shell in between, so nothing re-interprets the
        // arguments. Codex asks for this because Windows shell quoting mangles its argv.
        ctx.log.info(`[spawn] backend=${backend.id} mode=argv cmd=${argvExe} args=${JSON.stringify(launch.args)}`);
        ptyProcess = pty.spawn(argvExe, launch.args, ptyOpts);
      } else {
        ptyProcess = pty.spawn(shell, ptyShellArgs(shell, claudeCmd, shellExtraArgs), ptyOpts);
      }

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    // The shell family THIS session resolved to. Recorded here because this is the only place that knows
    // it: `shellProfile` (the CLI shell) and `terminalShellProfile` (the Terminal bucket) are different
    // settings, so asking the PROJECT afterwards can answer for the wrong one — and a variable insert that
    // builds `$(cat …)` for a pwsh session, or `(Get-Content …)` for a bash one, silently emits literal text
    // and puts the secret's temp-file path in the transcript. `resolve-variable-insert` reads it from here
    // instead of being told by the renderer.
    shellType: ctx.classifyShellType(shell),
    mcpServer, _openedAt: Date.now(),
    // Did this session already exist in the backend's store before we spawned it? Only then can our id
    // be an id the backend knows — which is the one case where `liveRefFor` has anything to find
    // (claimLiveRecord). A fork is NOT a resume: the backend names the child itself.
    //
    // A resume the backend could not place (#290) is not a resume either — we just spawned it WITHOUT
    // `-r`, so it is about to name a fresh session of its own. Saying so here is what puts adoption on
    // the `matchLiveSession` path, which is the only one that can find that new record and re-key the
    // row onto it. Left at `true`, claimLiveRecord would ask `liveRefFor` for our id on every flush,
    // for ever, and the row would keep the id nothing will ever write.
    _resumed: !isNew && !resumeUnknown,
    // Whether the OSC-0 TITLE heuristic applies to this session. It is Claude's, and only Claude's:
    // busy = a Braille spinner glyph, idle = the ✳ character. Run it against another CLI whose TUI also
    // spins in the title — Codex does — and the busy latch closes on the first spinner frame and can
    // NEVER open again, because that CLI has no reason to ever write a ✳. The session then reads
    // "working" forever while it sits at its prompt. Every other backend reports its own state through
    // `liveState`; this heuristic exists precisely because Claude does not.
    _oscTitleState: oscTitleState,
    // #223: this terminal's stable identity for live re-binding, and whatever the backend created for it.
    // On the session (not in a side map) so a re-key carries them along for free — the record moves to
    // the new id, and the terminal keeps the same tag through every clear.
    _terminalTag: terminalTag,
    _liveBindingCleanup: liveBindingCleanup,
  };
  ctx.activeSessions.set(sessionId, session);

  // A backend may warn that it takes a while to become usable (Hermes needs ~12s to load its Python
  // stack). Without a word the tab just sits black and reads as broken. Write the hint straight into
  // the session's buffer, so it also survives a detach/reattach — the binary's own output scrolls it
  // away the moment it starts talking.
  if (startupHint) {
    const hint = `\x1b[2m${String(startupHint).replace(/[\r\n]+/g, ' ')}\x1b[0m\r\n`;
    session.outputBuffer.push(hint);
    session.outputBufferSize += hint.length;
    if (windowLive()) {
      sendToWindow('terminal-data', sessionId, hint);
    }
  }

  // The user clicked a session and got a fresh one (#290). Say it here, in the tab it happened in, or an
  // empty prompt where a conversation was expected reads as the app having lost their history. Yellow,
  // not dim: this is a thing that happened TO them, unlike the startup hint above. It goes through the
  // buffer for the same reason — a detach/reattach must not lose it.
  if (resumeUnknown) {
    const notice = `\x1b[33m── ${resumeUnknownLabel} has no record of this session — started a new one instead ──\x1b[0m\r\n`;
    session.outputBuffer.push(notice);
    session.outputBufferSize += notice.length;
    if (windowLive()) {
      sendToWindow('terminal-data', sessionId, notice);
    }
  }

  ptyProcess.onData(data => {
    // ConPTY flushes buffered output asynchronously after pty.kill(), so a last
    // chunk can arrive after will-quit closed the DB — the OSC 9;4 path below
    // calls ctx.getSetting() and would throw "The database connection is not open"
    // in an uncaught-exception dialog (#90 class, PTY edition).
    if (ctx.getAppQuitting()) return;
    const currentId = session.realSessionId || sessionId;

    // LIVENESS, not state. A backend whose busy/idle comes from its store (Codex/Hermes/Pi) has one
    // blind spot: a turn that runs long without writing anything looks finished. The PTY stream closes
    // it — "the process is still talking" — so state derivation can refuse to call such a turn idle.
    // It is deliberately NOT a busy signal: a spinner frame is output, and so is an echoed keystroke.
    session._lastOutputAt = Date.now();

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle).
        //
        // CLAUDE ONLY. The idle half of this test is the literal character ✳, which no other CLI has any
        // reason to write — so on a backend whose TUI also spins in the window title (Codex), the busy
        // latch closes on the first spinner frame and never opens again. The session reads "working"
        // forever while it sits at its prompt. Every other backend reports its own state through
        // `liveState`; this heuristic exists precisely because Claude does not.
        if (code === '0' && session._oscTitleState) {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          // One line per title change — the CLI retitles on every spinner frame.
          ctx.log.silly(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            // Marks the flag as OSC-0-owned so a stray `9;4;0` can't clear it (#120).
            session._busySource = 'osc0';
            ctx.log.info(`[OSC 0] session=${currentId} → BUSY`);
            if (windowLive()) {
              sendToWindow('cli-busy-state', currentId, true);
            }
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            session._busySource = null;
            ctx.log.info(`[OSC 0] session=${currentId} → IDLE`);
            if (windowLive()) {
              sendToWindow('cli-busy-state', currentId, false);
            }
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          const decision = decideOsc94(level, {
            cliBusy: !!session._cliBusy,
            busySource: session._busySource || null,
            hooksEnabled: ctx.attentionHooksEnabled(),
          });
          // Progress sequences repeat while a task runs — raw line stays at silly.
          ctx.log.silly(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy} → ${decision}`);
          if (decision === 'set') {
            session._cliBusy = true;
            session._oscIdle = false;
            session._busySource = 'osc94';
            ctx.log.info(`[OSC 9;4] session=${currentId} → BUSY`);
            if (windowLive()) {
              sendToWindow('cli-busy-state', currentId, true);
            }
          } else if (decision === 'clear') {
            // Release the latch this path set — otherwise a TUI dialog leaves the
            // session on "Working" forever (#120).
            session._cliBusy = false;
            session._oscIdle = true;
            session._busySource = null;
            ctx.log.info(`[OSC 9;4] session=${currentId} → IDLE (latch released)`);
            if (windowLive()) {
              sendToWindow('cli-busy-state', currentId, false);
            }
          }
        } else {
          // Regular notification (attention, permission, etc.)
          ctx.log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          if (windowLive()) {
            sendToWindow('terminal-notification', currentId, payload);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      ctx.log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        ctx.log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        ctx.log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      appendToOutputBuffer(session, data, MAX_BUFFER_SIZE);
    }

    if (windowLive()) {
      sendToWindow('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    // During quit the DB is already closed (getSetting below would throw) and
    // before-quit has shut down MCP + killed the PTYs — skip the cleanup.
    if (ctx.getAppQuitting()) return;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    ctx.shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    if (windowLive()) {
      sendToWindow('process-exited', realId, exitCode);
      // If a fork/plan-accept transition re-keyed this session under realId
      // but the PTY exited before transition detection ran, also notify the
      // renderer for the original sessionId so it doesn't stay stuck as "Running".
      if (realId !== sessionId && ctx.activeSessions.has(sessionId)) {
        sendToWindow('process-exited', sessionId, exitCode);
      }
    }
    ctx.activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    ctx.activeSessions.delete(sessionId);
    // Release the Codex rollout claim + busy latch for this session (T-4.5), so the file can be
    // re-claimed and the maps don't grow for the life of the app.
    for (const id of [realId, sessionId]) { ctx.liveStoreRef.delete(id); ctx.liveBusy.delete(id); }
    // #223: this terminal is gone. Drop any clear claim it left behind — a claim from a dead terminal
    // can never be paired with a child, and leaving it would let it win a pairing that is not its own.
    // Then remove whatever the backend wrote for the binding.
    try {
      ctx.forgetClearClaims(session._terminalTag);
      if (typeof session._liveBindingCleanup === 'function') session._liveBindingCleanup(ctx.log);
    } catch (err) {
      ctx.log.debug(`[clear-bind] cleanup failed for session=${realId}: ${err.message}`);
    }
    // Wipe this session's secret-ref temp files (default on; the prompt that used
    // them is done). Quit/startup wipe still covers the setting-off case.
    if (ctx.getSetting('global')?.secretRefCleanupOnSessionStop !== false) {
      ctx.cleanupSecretRefsForSession(realId);
      if (realId !== sessionId) ctx.cleanupSecretRefsForSession(sessionId);
    }
  });

  if (sessionOptions?.forkFrom) {
    ctx.log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
}

/**
 * @param {Electron.IpcMain} ipc  passed in, not required — this module needs no electron of its own.
 */
function registerIpc(ipc) {
  ipc.handle('open-terminal', (_event, sessionId, projectPath, isNew, sessionOptions) =>
    openTerminal(sessionId, projectPath, isNew, sessionOptions));
  // Synchronous: the renderer needs the ConPTY build hint BEFORE it constructs the
  // xterm Terminal (windowsPty is a constructor option), which happens before
  // open-terminal returns. Resolved per project (project → global conptyBackend
  // cascade), matching useConptyDll above so the wrapping hint and the actual ConPTY
  // backend never disagree (#268).
  ipc.on('get-windows-build', (event, projectPath) => {
    event.returnValue = conptyBuildHint({
      platform: process.platform,
      release: os.release(),
      conptyBackend: (ctx.effectiveSettings(projectPath) || {}).conptyBackend,
    });
  });
}

module.exports = { init, registerIpc, openTerminal };
