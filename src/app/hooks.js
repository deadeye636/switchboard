// Claude Code hook → attention ingest (spec 05).
//
// A tiny loopback HTTP server receives structured hook events from Claude Code (registered as
// `type: "http"` hooks in ~/.claude/settings.json) and forwards a normalized `attention-signal` to the
// renderer. The hook payload's `session_id` is the Claude session UUID — exactly Switchboard's
// realSessionId — so no extra correlation is needed. OSC-9 remains the default heuristic + fallback.
//
// THE TRUST BOUNDARY IS THE TOKEN CHECK (#77). This server listens on 127.0.0.1, which means every
// local process can reach it — not just Claude Code. So the URL carries a per-run random token and a POST
// without it is answered 403 and nothing else: no signal, no fast-path reindex. Without that check any
// local process could forge attention signals and force undebounced reads. It is the first thing the
// request handler does, and it must stay that way.
//
// This module deliberately does NOT require electron: `registerIpc` takes the ipc object instead of
// reaching for it. That keeps the whole file loadable in `node --test`, which is what lets the token
// check and the settings.json rewrite be tested for real rather than asserted against source text.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const attentionSource = require('../shared/attention-source');

const CLAUDE_SETTINGS_JSON = path.join(os.homedir(), '.claude', 'settings.json');
// Sentinel in the hook URL path so we can find & remove only our own handlers.
const ATTENTION_HOOK_MARK = '/switchboard-attention-hook';

let ctx = null;
let attentionHookServer = null;
let attentionHookPort = null;
let attentionHookToken = null; // random token embedded in the hook URL, verified on POST (issue #77)

/**
 * @param {object} context
 * @param {() => Electron.BrowserWindow|null} context.getMainWindow  a GETTER — the window is reassigned
 *   on reopen, and a captured value would address one that no longer exists.
 * @param {(key: string) => any} context.getSetting  through ctx, not a require: db.js resolves DATA_DIR
 *   at module load, and main.js sets DATA_DIR before it requires db.js.
 * @param {Map} context.activeSessions
 * @param {{ postFile: (folder: string, rel: string, opts?: object) => void }} context.indexWorker
 * @param {object} context.log
 * @param {string} [context.claudeSettingsPath] the settings.json to rewrite. main.js does not pass it —
 *   the real path is the default. It exists so a test can point the write/remove round-trip at a temp
 *   directory instead of the developer's own ~/.claude/settings.json.
 */
function init(context) {
  ctx = context;
}

/** The settings.json this run rewrites. */
function settingsPath() {
  return (ctx && ctx.claudeSettingsPath) || CLAUDE_SETTINGS_JSON;
}

function attentionHooksEnabled() {
  const global = ctx.getSetting('global') || {};
  return global.attentionHooks === true;
}

// A dev build must not touch the user's shared ~/.claude/settings.json by default. The file belongs to
// Claude Code (like ~/.claude/projects/**), and only the DB + userData are separated per instance — the
// hook is the last thing that leaks into shared user state. A dev run is force-killed by `npm run stop:dev`
// (no before-quit), so a written hook is left behind pointing at a dead port, and a dev enable/quit also
// strips the INSTALLED app's hook because the sentinel carries no instance marker (#219). So in an
// unpackaged build the whole write/strip path is a no-op unless you opt in with
// SWITCHBOARD_DEV_ATTENTION_HOOK=1 — which you do only when working on the attention hook itself. Attention
// detection falls back to the OSC-9 heuristic, which is what a dev build wants for everyday work anyway.
function hookWritingAllowed() {
  if (ctx && ctx.isPackaged) return true;
  return process.env.SWITCHBOARD_DEV_ATTENTION_HOOK === '1';
}

/**
 * The request handler, split out of the server so a test can drive it with a fake req/res and no socket.
 * @param {string} [token] the token to verify against — defaults to this run's, and is only ever passed
 *   by the tests, which have no other way to exercise the wrong-token branch of the check.
 */
function handleHookRequest(req, res, token = attentionHookToken) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  // Verify the per-run token from the hook URL so an unrelated local process
  // can't forge attention signals or force undebounced reads (issue #77).
  let reqToken = null;
  try { reqToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('t'); } catch {}
  if (!token || reqToken !== token) {
    res.writeHead(403);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy(); // guard against runaway payloads
  });
  req.on('end', () => {
    try {
      const hook = JSON.parse(body || '{}');
      const sessionId = hook.session_id || hook.sessionId;
      // Fast-path: a hook POST (Stop/Notification) is an instant push at a turn
      // boundary. Refresh that session's transcript now — bypassing the watcher +
      // reindex debounces — so a rename (Claude /rename → custom-title) shows the
      // moment the turn ends instead of lagging up to several seconds (#60).
      if (sessionId) {
        try {
          const sess = ctx.activeSessions.get(sessionId)
            || [...ctx.activeSessions.values()].find(x => x.realSessionId === sessionId);
          if (sess && sess.projectFolder) {
            // relFilename is folder-prefixed (refreshFile strips the first segment).
            const rel = sess.projectFolder + '/' + sessionId + '.jsonl';
            // The parse runs off-thread, but the reply still jumps the queue (priority lane) so the
            // rename shows the instant the turn ends — the whole point of the immediate fast-path.
            ctx.indexWorker.postFile(sess.projectFolder, rel, { immediate: true });
          }
        } catch (err) {
          ctx.log.warn(`[attention-hook] fast refresh failed: ${err.message}`);
        }
      }
      const signal = attentionSource.classifyAttentionSignal({ source: 'hook', payload: hook });
      const mainWindow = ctx.getMainWindow();
      if (sessionId && signal && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('attention-signal', {
          sessionId,
          kind: signal.kind,
          reason: signal.reason,
          source: 'hook',
          // Subagent lifecycle events carry the subagent's identity (#119).
          agentId: signal.agentId || null,
          agentType: signal.agentType || null,
        });
        const agentSuffix = signal.agentId ? ` agentId=${signal.agentId}` : '';
        ctx.log.info(`[attention-hook] session=${sessionId} kind=${signal.kind}${agentSuffix} reason="${signal.reason}"`);
      }
    } catch (err) {
      ctx.log.warn(`[attention-hook] bad payload: ${err.message}`);
    }
    // Empty decision object = no-op; never block or alter Claude's behavior.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}

/**
 * @returns {http.Server} the live server. main.js ignores it; a test needs it to close the socket it
 *   opened, or `node --test` waits on the handle forever.
 */
function startAttentionHookServer() {
  if (attentionHookServer) return attentionHookServer;
  if (!hookWritingAllowed()) {
    ctx.log.info('[attention-hook] disabled in this dev build — set SWITCHBOARD_DEV_ATTENTION_HOOK=1 to enable');
    return null;
  }
  attentionHookToken = crypto.randomUUID();
  const server = http.createServer((req, res) => handleHookRequest(req, res));
  // Set the guard immediately (not inside the listen callback) so a second call
  // while the socket is still binding cannot create a second server (issue #76).
  attentionHookServer = server;
  server.on('error', (err) => ctx.log.error(`[attention-hook] server error: ${err.message}`));
  // A closed server must not be handed back as live on the next start (it would never re-listen). Clearing
  // the guards on close lets a restart create a fresh one — in production this only happens at quit.
  server.on('close', () => { if (attentionHookServer === server) { attentionHookServer = null; attentionHookPort = null; } });
  server.listen(0, '127.0.0.1', () => {
    attentionHookPort = server.address().port;
    ctx.log.info(`[attention-hook] listening on 127.0.0.1:${attentionHookPort}`);
    // Re-stamp the live port into settings.json if the feature is already on.
    try {
      if (attentionHooksEnabled()) writeClaudeAttentionHook(attentionHookPort);
    } catch (err) {
      ctx.log.error(`[attention-hook] failed to refresh hook on startup: ${err.message}`);
    }
  });
  return server;
}

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

// Remove only Switchboard-owned HTTP handlers (identified by the sentinel URL),
// pruning now-empty matcher groups and hook events. Leaves all other user hooks
// untouched — this is what makes the change reversible.
function stripSwitchboardHooks(settings) {
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const group of groups) {
      if (group && Array.isArray(group.hooks)) {
        group.hooks = group.hooks.filter(
          (h) => !(h && typeof h.url === 'string' && h.url.includes(ATTENTION_HOOK_MARK)),
        );
        if (group.hooks.length > 0) keptGroups.push(group);
      } else {
        keptGroups.push(group);
      }
    }
    if (keptGroups.length > 0) settings.hooks[event] = keptGroups;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

function writeClaudeAttentionHook(port) {
  if (!port) return;
  if (!hookWritingAllowed()) return; // dev build: never touch the shared ~/.claude/settings.json (#219)
  const url = `http://127.0.0.1:${port}${ATTENTION_HOOK_MARK}?t=${attentionHookToken}`;
  const settings = stripSwitchboardHooks(readClaudeSettings());
  if (!settings.hooks) settings.hooks = {};
  // Claude Code blocks on the hook response. The server is on 127.0.0.1 and answers
  // in milliseconds, so a long timeout only ever buys latency once nothing is
  // listening — which is exactly the case a crash leaves behind (#125).
  const HOOK_TIMEOUT_SEC = 1;
  const addHook = (event, matcher) => {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({ matcher: matcher || '', hooks: [{ type: 'http', url, timeout: HOOK_TIMEOUT_SEC }] });
  };
  addHook('Notification', ''); // permission_prompt / idle_prompt / elicitation / …
  addHook('Stop', ''); // agent finished responding (matcher ignored for Stop)
  addHook('UserPromptSubmit', ''); // turn start → "Working" (TUI sessions emit no OSC-0 spinner)
  // Subagent lifecycle → the two-color overlay + the nested running indicator (#119).
  // Both events carry the parent session_id and the subagent's agent_id, and
  // SubagentStop fires at the subagent's real end. An empty matcher (which these
  // events match against the agent *type*) catches every agent type.
  addHook('SubagentStart', '');
  addHook('SubagentStop', '');
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
  ctx.log.info(`[attention-hook] wrote hooks to ${settingsPath()} (${url})`);
}

function removeClaudeAttentionHook() {
  // A dev build never wrote (see hookWritingAllowed), so it must not strip either — stripSwitchboardHooks
  // removes EVERY sentinel entry, so a dev quit would otherwise clobber the installed app's live hook (#219).
  if (!hookWritingAllowed()) return;
  if (!fs.existsSync(settingsPath())) return;
  const settings = stripSwitchboardHooks(readClaudeSettings());
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
  ctx.log.info(`[attention-hook] removed Switchboard hooks from ${settingsPath()}`);
}

/**
 * @param {Electron.IpcMain} ipc  passed in, not required — see the header: this module stays
 *   Electron-free so its trust boundary can be tested.
 */
function registerIpc(ipc) {
  // Renderer toggles the setting then calls this to write/remove the ~/.claude hook.
  ipc.handle('configure-attention-hook', (_event, enabled) => {
    try {
      if (enabled) {
        // Dev builds don't write to the user's shared ~/.claude/settings.json unless opted in (#219) — tell
        // the renderer so it can note why the toggle didn't take effect.
        if (!hookWritingAllowed()) return { ok: true, devBlocked: true };
        if (!attentionHookServer) startAttentionHookServer();
        // If the server is still binding, the listen callback will stamp the port.
        if (attentionHookPort) writeClaudeAttentionHook(attentionHookPort);
      } else {
        removeClaudeAttentionHook();
      }
      return { ok: true };
    } catch (err) {
      ctx.log.error(`[attention-hook] configure failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
}

module.exports = {
  init,
  registerIpc,
  startAttentionHookServer,
  removeClaudeAttentionHook,
  attentionHooksEnabled,
  // Exported for the tests — the token check and the settings.json rewrite are the trust boundary and
  // the reversibility promise; both are testable only from here.
  handleHookRequest,
  stripSwitchboardHooks,
  ATTENTION_HOOK_MARK,
  CLAUDE_SETTINGS_JSON,
};
