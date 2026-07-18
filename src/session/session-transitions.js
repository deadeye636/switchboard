const path = require('path');
const fs = require('fs');
const { resolveClearParent } = require('./session-lineage');
// The subagent lifecycle below is the CORE's (mtime stability, bootstrap quiet, reopen, GC). Where the
// subagents of a session live, what they are called and where their metadata comes from is the BACKEND's,
// and it answers through the descriptor (#235) — this module reads no store layout of its own.
const backendRegistry = require('../backends');
// A session row from before #161 carries no backendId, and back then it was always Claude's. A named
// default for a historical record, not a `|| 'claude'` fallback for a live decision.
const LEGACY_SESSION_BACKEND = 'claude';

/**
 * Fork / plan-accept detection for active PTY sessions.
 * Call init(ctx) once with shared context.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log, rekeyMcpServer, rekeySessionBackend, recordLineage;
// Which backend spawned a live session — read from the launch overlay (session-backends.js), injected so
// this module stays loadable under `node --test`. Absent (tests, a pre-#161 session) → null, and the
// caller falls back to the named legacy default.
let getSessionBackend = () => null;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  rekeyMcpServer = ctx.rekeyMcpServer;
  // Multi-LLM (T-1.4): rekey the backend/profile overlay on temp->real id transition, so a
  // session's backend follows it across fork/clear. No-op if not injected.
  rekeySessionBackend = ctx.rekeySessionBackend || (() => {});
  // Record a /clear child's soft lineage link the moment we resolve it (#193). No-op if not injected
  // (the tests drive detectSessionTransitions without a DB).
  recordLineage = ctx.recordLineage || (() => {});
  // #235: the subagent dispatch reads the launch overlay, not a field on the session object.
  getSessionBackend = typeof ctx.getSessionBackend === 'function' ? ctx.getSessionBackend : () => null;
}

// --- Subagent spawn / completion detection ---

// Completion is decided by a stable-mtime timer, but detectSubagentTransitions only
// runs on file-watcher events. A finished subagent stops writing, so it produces no
// further events and its completion could be declared arbitrarily late (only when
// some unrelated file in the folder happens to change). This sweep re-checks the
// open subagents on a timer instead. It starts on the first spawn and stops itself
// once none are open, so an idle app pays nothing.
const SUBAGENT_SWEEP_MS = 5000;
let subagentSweepTimer = null;

function hasOpenSubagents() {
  for (const [, session] of activeSessions) {
    if (session.exited || !session.knownSubagents) continue;
    for (const [, state] of session.knownSubagents) if (!state.completed) return true;
  }
  return false;
}

function sweepOpenSubagents() {
  for (const [sessionId, session] of [...activeSessions]) {
    if (session.exited || session.isPlainTerminal || !session.knownSubagents || !session.projectFolder) continue;
    let open = false;
    for (const [, state] of session.knownSubagents) if (!state.completed) { open = true; break; }
    if (!open) continue;
    detectSubagentTransitions(
      session.realSessionId || sessionId,
      session,
      path.join(PROJECTS_DIR, session.projectFolder),
    );
  }
  if (!hasOpenSubagents()) stopSubagentSweep();
}

function startSubagentSweep() {
  if (subagentSweepTimer) return;
  subagentSweepTimer = setInterval(sweepOpenSubagents, SUBAGENT_SWEEP_MS);
  if (typeof subagentSweepTimer.unref === 'function') subagentSweepTimer.unref();
}

function stopSubagentSweep() {
  if (!subagentSweepTimer) return;
  clearInterval(subagentSweepTimer);
  subagentSweepTimer = null;
}

/** The backend that owns this session's subagents, or null if it has none (#235). A backend that
 *  declares supportsSubagents: false is never probed — "no subagents" is an answer, not a miss.
 *
 *  The id comes from the LAUNCH OVERLAY (session-backends.js), which is what actually knows which
 *  backend spawned a live session. An `activeSessions` entry carries no `backendId` field — reading one
 *  off it looks like dispatch and is not: it is `undefined` for every session, so every lookup would
 *  quietly land on the legacy default no matter what was running.
 *
 *  HONEST LIMIT, not an oversight: the only caller of the enclosing detection is the fs.watch on
 *  CLAUDE's store (`src/watch/projects.js` → detectSessionTransitions), so today nothing but a Claude
 *  session reaches here anyway. Generalising the WATCH is #235's sibling, not this seam — but the
 *  dispatch below is real, so the day a second store is watched this asks the right backend instead of
 *  answering "claude" for all of them. */
function subagentBackendFor(sessionId, session) {
  const overlay = getSessionBackend(sessionId) || (session && session.realSessionId ? getSessionBackend(session.realSessionId) : null);
  // No overlay entry = a session from before the multi-LLM era (#161), when a session was always Claude's.
  // A NAMED legacy default for a historical record — never a `|| 'claude'` guess at a live launch target.
  const id = (overlay && overlay.backendId) || LEGACY_SESSION_BACKEND;
  let b = null;
  try { b = backendRegistry.get(id); } catch { return null; }
  if (!b || b.supportsSubagents !== true) return null;
  if (typeof b.listSubagents !== 'function') return null;
  return b;
}

/** Ask the session's backend which subagents exist right now, then run the spawn/completion state
 *  machine over the answer.
 *  Mutates session.knownSubagents (Map<agentId, { mtimeMs, completed }>).
 *  Emits IPC 'subagent-spawned' and 'subagent-completed' via mainWindow.
 *  `folderPath` is the session's directory in its backend's store — passed through to the hook,
 *  never interpreted here. */
function detectSubagentTransitions(sessionId, session, folderPath) {
  const backend = subagentBackendFor(sessionId, session);
  if (!backend) return;   // this backend has no subagent concept
  const readMeta = (agentId) => {
    if (typeof backend.subagentMeta !== 'function') return {};
    try { return backend.subagentMeta(sessionId, agentId, { folderPath }) || {}; } catch { return {}; }
  };
  let found;
  try { found = backend.listSubagents(sessionId, { folderPath }); } catch { return; }
  // null = "nothing to watch yet" (see the hook): leave knownSubagents unset, so the first sighting
  // still goes through the bootstrap-quiet rule. An empty ARRAY is a watched-but-empty store and does
  // create the map — that difference is what keeps a leftover file from being reported as a spawn
  // (#122), and it used to be carried by readdir throwing vs. returning nothing.
  if (found == null) return;

  // First walk for this session: pre-populate knownSubagents with every
  // existing file silently so we don't flood the renderer with spawn/complete
  // events for agents that already finished before Switchboard started watching.
  // Files modified in the last 60s get a normal lifecycle; older ones are
  // recorded as already-completed without IPC.
  const isBootstrap = !session.knownSubagents;
  if (isBootstrap) {
    session.knownSubagents = new Map();
  }

  const mainWindow = getMainWindow();
  const now = Date.now();
  const STABLE_MS = 30000; // 30 seconds of no mtime advance → completed
  const BOOTSTRAP_LIVE_MS = 60000; // file modified in last 60s = still alive at boot

  for (const entry of found) {
    const agentId = entry && entry.agentId;
    if (!agentId) continue;
    const mtimeMs = Number(entry.mtimeMs);
    if (!Number.isFinite(mtimeMs)) continue;

    const known = session.knownSubagents.get(agentId);

    if (!known) {
      // A file we have never seen is only a spawn when it was written recently.
      // On a cold start that keeps finished agents quiet; afterwards it stops the
      // 5-minute GC from resurrecting them: the entry is dropped from memory but
      // the agent-<id>.jsonl stays on disk, so the next walk rediscovers it (#122).
      const looksAlive = (now - mtimeMs) < BOOTSTRAP_LIVE_MS;
      if (isBootstrap || !looksAlive) {
        session.knownSubagents.set(agentId, {
          mtimeMs,
          completed: !looksAlive,
          _completedAt: looksAlive ? null : now,
        });
        // An agent still running at cold start would otherwise wait for a watcher
        // event that never comes once it stops writing.
        if (looksAlive) startSubagentSweep();
        continue;
      }
      // First sighting post-bootstrap of a freshly written file — a real spawn.
      const meta = readMeta(agentId);
      session.knownSubagents.set(agentId, { mtimeMs, completed: false });
      // A live subagent stops producing watcher events once it finishes writing —
      // the sweep keeps re-checking it so completion isn't declared arbitrarily late.
      startSubagentSweep();
      log.info(`[subagent-spawn] parent=${sessionId} agentId=${agentId} type=${meta.subagentType || 'unknown'}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('subagent-spawned', {
          parentSessionId: sessionId,
          agentId,
          subagentType: meta.subagentType || null,
          description: meta.description || null,
        });
      }
    } else if (known.completed && mtimeMs !== known.mtimeMs) {
      // The stable-mtime guess was wrong: the agent went quiet inside a long tool
      // call and has now written again. Reopen it instead of staying wrong forever
      // (#121). Renderer-side the re-spawn is idempotent.
      known.completed = false;
      known._completedAt = null;
      known.mtimeMs = mtimeMs;
      known._stableStart = null;
      startSubagentSweep();
      log.info(`[subagent-reopen] parent=${sessionId} agentId=${agentId} (wrote again after completion)`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        const meta = readMeta(agentId);
        mainWindow.webContents.send('subagent-spawned', {
          parentSessionId: sessionId,
          agentId,
          subagentType: meta.subagentType || null,
          description: meta.description || null,
        });
      }
    } else if (!known.completed) {
      if (mtimeMs !== known.mtimeMs) {
        // File is still being written — update mtime, reset stability clock
        known.mtimeMs = mtimeMs;
        known._stableStart = null;
      } else {
        // mtime stable — start or continue stability timer
        if (!known._stableStart) {
          known._stableStart = now;
        } else if (now - known._stableStart >= STABLE_MS) {
          known.completed = true;
          log.info(`[subagent-complete] parent=${sessionId} agentId=${agentId}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('subagent-completed', {
              parentSessionId: sessionId,
              agentId,
            });
          }
        }
      }
    }
  }

  // GC: remove completed entries after 5 minutes to avoid unbounded growth
  const GC_TTL = 5 * 60 * 1000;
  for (const [agentId, state] of session.knownSubagents) {
    if (state.completed && state._completedAt && now - state._completedAt > GC_TTL) {
      session.knownSubagents.delete(agentId);
    }
    if (state.completed && !state._completedAt) {
      state._completedAt = now;
    }
  }
}

// --- Fork / plan-accept detection ---

/** Read first few lines of a new .jsonl to extract signals.
 *  Skips file-history-snapshot lines which can be very large (tens of KB)
 *  and reads up to 512KB to find the first user/assistant entry. */
function readNewSessionSignals(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(524288);
    const bytesRead = fs.readSync(fd, buf, 0, 524288, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const lines = head.split('\n').filter(Boolean);
    let forkedFrom = null;
    let planContent = false;
    let slug = null;
    let parentSessionId = null;
    let hasSnapshots = false;
    let clearOrigin = false;
    for (const line of lines) {
      // Per-line try/catch: the fixed 512 KB read almost always truncates the
      // last line, and one bad JSON.parse must not discard the signals already
      // found before it (matches readSessionFile) (issue #76).
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      // Skip snapshot lines — they carry no fork/session signals
      if (entry.type === 'file-history-snapshot') { hasSnapshots = true; continue; }
      if (entry.forkedFrom) forkedFrom = entry.forkedFrom.sessionId;
      if (entry.planContent) planContent = true;
      if (entry.slug && !slug) slug = entry.slug;
      // --fork-session copies messages with original sessionId
      if (entry.sessionId && !parentSessionId) parentSessionId = entry.sessionId;
      // /clear reuses the PTY but mints a new sessionId with NO lineage backref
      // (no forkedFrom / parentSessionId / planContent). The only marker in the
      // fresh file is a SessionStart hook attachment with source "clear".
      if (entry.type === 'attachment' && entry.attachment
          && entry.attachment.hookEvent === 'SessionStart'
          && typeof entry.attachment.hookName === 'string'
          && entry.attachment.hookName.endsWith(':clear')) {
        clearOrigin = true;
      }
      // Stop after finding a user or assistant message
      if (entry.type === 'user' || entry.type === 'assistant') break;
    }
    return { forkedFrom, planContent, slug, parentSessionId, hasSnapshots, clearOrigin };
  } catch {
    return { forkedFrom: null, planContent: false, slug: null, parentSessionId: null, hasSnapshots: false, clearOrigin: false };
  }
}

/** Read tail of old session file for ExitPlanMode and slug */
function readOldSessionTail(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readSize = Math.min(size, 8192);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const hasExitPlanMode = tail.includes('ExitPlanMode');
    // Extract slug from tail (last occurrence)
    let slug = null;
    const slugMatches = tail.match(/"slug"\s*:\s*"([^"]+)"/g);
    if (slugMatches) {
      const last = slugMatches[slugMatches.length - 1].match(/"slug"\s*:\s*"([^"]+)"/);
      if (last) slug = last[1];
    }
    return { hasExitPlanMode, slug };
  } catch {
    return { hasExitPlanMode: false, slug: null };
  }
}

/** Detect fork or plan-accept transitions for active PTY sessions in a folder */
function detectSessionTransitions(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  let currentFiles;
  try {
    currentFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  for (const [sessionId, session] of [...activeSessions]) {
    // Run subagent detection for all non-exited, non-terminal sessions in this folder
    if (!session.exited && !session.isPlainTerminal && session.projectFolder === folder) {
      const effectiveSessionId = session.realSessionId || sessionId;
      detectSubagentTransitions(effectiveSessionId, session, folderPath);
    }

    if (session.exited || session.isPlainTerminal || !session.knownJsonlFiles || session.projectFolder !== folder) {
      if (!session.exited && !session.isPlainTerminal && session.forkFrom) {
        log.info(`[fork-detect] skipped session=${sessionId} forkFrom=${session.forkFrom||'none'} reason=${session.exited ? 'exited' : session.isPlainTerminal ? 'terminal' : !session.knownJsonlFiles ? 'noKnown' : 'folderMismatch('+session.projectFolder+' vs '+folder+')'}`);
      }
      continue;
    }

    const newFiles = currentFiles.filter(f => !session.knownJsonlFiles.has(f));

    if (newFiles.length > 0) log.debug(`[detect] session=${sessionId} forkFrom=${session.forkFrom||'none'} folder=${folder} newFiles=${newFiles.length} knownCount=${session.knownJsonlFiles.size} currentCount=${currentFiles.length}`);

    if (newFiles.length === 0) continue;

    const emptyFiles = new Set(); // files with no signals yet (still being written)

    for (const newFile of newFiles) {
      const newFilePath = path.join(folderPath, newFile);
      const newId = path.basename(newFile, '.jsonl');
      const signals = readNewSessionSignals(newFilePath);

      // File exists but has no parseable content yet — skip and retry next cycle
      // But if the file's mtime is older than 1 hour, treat it as stale and archive it
      if (!signals.forkedFrom && !signals.parentSessionId && !signals.slug && !signals.planContent && !signals.clearOrigin) {
        // Fork file with only snapshots (no user turn yet) — match immediately
        if (signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
          log.info(`[detect] session=${sessionId} matching snapshot-only fork file=${newId}`);
          // Fall through to matching logic — will match via the fork-snapshot path below
        } else {
          let stale = false;
          try {
            const mtime = fs.statSync(path.join(folderPath, newFile)).mtimeMs;
            if (Date.now() - mtime > 3600000) stale = true;
          } catch {}
          if (stale) {
            log.info(`[detect] session=${sessionId} archiving stale empty file=${newId}`);
          } else {
            emptyFiles.add(newFile);
          }
          continue;
        }
      }

      if (session.forkFrom) {
        log.info(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=${session.forkFrom}`);
      } else {
        log.debug(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=none`);
      }

      let matched = false;

      // Fork: forkedFrom.sessionId matches this active PTY or the session it was forked from
      if (signals.forkedFrom === sessionId || (session.forkFrom && signals.forkedFrom === session.forkFrom)) {
        matched = true;
      }
      // --fork-session: new file's parentSessionId matches the forkFrom source,
      // and the new file's name (newId) differs from both our PTY id and the source
      if (!matched && session.forkFrom && signals.parentSessionId === session.forkFrom && newId !== session.forkFrom) {
        matched = true;
      }
      // Fork file with only snapshots — no user turn yet, but this session is waiting for a fork
      if (!matched && signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
        matched = true;
      }

      if (session.forkFrom && !matched) {
        log.info(`[detect] session=${sessionId} NO MATCH for newFile=${newId} forkFrom=${session.forkFrom} parentSessionId=${signals.parentSessionId||'null'} forkedFrom=${signals.forkedFrom||'null'}`);
      }

      // Plan-accept: shared slug + planContent + old session has ExitPlanMode
      if (!matched && signals.planContent && signals.slug) {
        const oldFilePath = path.join(folderPath, sessionId + '.jsonl');
        const oldTail = readOldSessionTail(oldFilePath);
        if (oldTail.hasExitPlanMode && oldTail.slug === signals.slug) {
          // Temporal check: new file created within 30s of old file's last modification
          try {
            const oldMtime = fs.statSync(oldFilePath).mtimeMs;
            const newMtime = fs.statSync(newFilePath).mtimeMs;
            if (Math.abs(newMtime - oldMtime) < 30000) {
              matched = true;
            }
          } catch {}
        }
      }

      // Clear: the fresh file carries a SessionStart:clear marker but NO lineage
      // backref. Resolve the parent conservatively (session-lineage.js): re-key ONLY
      // when this is the SINGLE live session in the folder — with two or more, no
      // folder-local signal can tell the true parent from a bystander that just went
      // idle, and a wrong re-key collapses two tabs onto one id, worse than the bail
      // (#223). Guard activeSessions.has(newId): once a winner re-keyed, the file
      // belongs to an existing session.
      if (!matched && signals.clearOrigin && !activeSessions.has(newId)) {
        // Only follow a freshly created clear file — avoids adopting stale files at watcher start.
        let fresh = false;
        try { fresh = Date.now() - fs.statSync(newFilePath).mtimeMs < 300000; } catch {}
        if (fresh) {
          const candidates = [...activeSessions]
            .filter(([, s]) => !s.exited && !s.isPlainTerminal && s.projectFolder === folder)
            .map(([key]) => ({ id: key }));
          const { parentId, confidence } = resolveClearParent({ candidates });
          if (confidence === 'high' && parentId === sessionId) {
            matched = true;
          } else if (candidates.length > 1) {
            log.info(`[detect] session=${sessionId} clear file=${newId} ambiguous (${candidates.length} active sessions in folder) — skipping`);
          }
        }
      }

      if (matched) {
        const kind = signals.clearOrigin ? 'clear' : (signals.forkedFrom || session.forkFrom ? 'fork' : 'plan-accept');
        log.info(`[session-transition] ${sessionId} → ${newId} (${kind})`);
        // Record the /clear child's provenance (#193). This is the authoritative source for a clear link —
        // the scanner cannot correlate it (the parent's file is unchanged and skipped), so we persist it
        // here where the parent is known at high confidence. Fork lineage is written by the scanner.
        if (kind === 'clear') { try { recordLineage(newId, folder, sessionId); } catch { /* best effort */ } }
        session.knownJsonlFiles = new Set(currentFiles);
        session.realSessionId = newId;
        // Update slug from new session
        if (signals.slug) session.sessionSlug = signals.slug;
        activeSessions.delete(sessionId);
        activeSessions.set(newId, session);
        // Re-key MCP server to match new session ID
        rekeyMcpServer(sessionId, newId);
        // Re-key the backend/profile overlay too (T-1.4) so provenance follows the id.
        rekeySessionBackend(sessionId, newId);
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-forked', sessionId, newId);
        }
        break; // Only one transition per session per flush
      }
    }

    // Update known files, but exclude empty ones so they get rechecked next cycle
    const updated = new Set(currentFiles);
    for (const f of emptyFiles) updated.delete(f);
    session.knownJsonlFiles = updated;
  }
}


module.exports = {
  init, detectSessionTransitions, detectSubagentTransitions, readNewSessionSignals,
  startSubagentSweep, stopSubagentSweep, hasOpenSubagents,
};
