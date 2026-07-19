// Settings: the blob on disk, the cascade that turns it into what a launch actually uses, and the
// export/import pair (#145).
//
// THE TRUST BOUNDARY IS scrubBlobForDisk: nothing a RENDERER supplied reaches the disk without it. The
// scrub lives on the main side of the IPC on purpose, because the renderer can be bypassed — which is also
// why it cannot be the renderer that decides to call it.
//
// TWO doors take renderer input, and both go through it (#221): `set-setting` (via persistSettingsBlob,
// which adds the backend re-arm) and `merge-setting` (which must NOT re-arm — it fires on every sidebar
// drag). This comment used to say the second one walked around the guard; it no longer does, and the test
// in test/backend-env.test.js drives both channels rather than reading this paragraph.
//
// windows.js (window bounds, zoom) and projects.js also call ctx.db.setSetting directly, and stay that
// way ON PURPOSE: neither takes a blob from the renderer. They read-modify-write a blob that was already
// scrubbed on its way in and add values the MAIN process computed (a window rectangle, a zoom factor, the
// project register). Routing them through the scrub would cost a walk of every launcher and backendEnv
// entry on every window move and buy nothing — there is no untrusted input on that path. If one of them
// ever starts writing something a renderer handed it, it belongs on one of the two doors above.
//
// THE CASCADE IS PER OPTION, not per blob (#149). `backendDefaults` used to be taken as one object
// whenever the project's was non-empty, which froze every backend's defaults at the moment a project
// overrode a single Codex option — later changes to the global defaults could never reach it again.
//
// Electron arrives through ctx (the two file dialogs are the only thing here that needs it), and so does
// the DB. That keeps this file loadable in `node --test`. It is not tidiness: `test/backend-env.test.js`
// used to pull `stripBackendEnvSecrets` out of main.js's SOURCE TEXT and run it through `new Function`,
// and `test/settings-cascade.test.js` did the same for the merge — both only because main.js needs
// Electron and could never be required. They require this module now.
// (The DB has a second reason: db.js resolves DATA_DIR at module load, so a top-level require here would
// run before main.js sets it — see main.js:81-85 and test/main-modules-no-db.test.js.)
'use strict';

const fs = require('fs');
const profiles = require('../backends/profiles');
const settingsTransfer = require('./settings-transfer');

let ctx = null;

/**
 * @param {object} context
 * @param {object} context.db  getSetting/setSetting/deleteSetting/listSettings + getProjectStates/setProjectState
 * @param {object} context.dialog  Electron's, injected so this module needs no electron require
 * @param {(sender: any) => any} context.getParentWindow  the window that ASKED — the export/import
 *   buttons also render in the standalone settings pop-out, so the dialog must not always parent to main
 * @param {() => void} context.broadcastSettingsChanged
 * @param {() => void} context.startBackendWatchers
 * @param {{ postReconcile: () => void }} context.indexWorker
 * @param {() => void} context.notifyRendererProjectsChanged
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

// NOTE: Claude's launch options (permissionMode, worktree, chrome, addDirs, preLaunchCmd,
// mcpEmulation, afkTimeoutSec, …) are NOT here. They are a backend's launch options like any other
// backend's and live under `backendDefaults.claude` (§4a) — see migrateClaudeLaunchDefaults below.
// What remains here is what belongs to the app, not to a CLI.
const SETTING_DEFAULTS = {
  // 10, not 5 (#237). This said 5 for as long as it existed and reached nobody: the sidebar — the only
  // consumer — reads the RAW `global` blob, so with the key unsaved it kept the renderer's own 10, and the
  // 5 only ever left here through get-effective-settings, whose callers (launch dialogs, spawn) do not
  // read it. Correcting the dead value to what actually applies keeps every existing sidebar as it is;
  // choosing 5 would have shortened everyone's session list without them touching anything.
  visibleSessionCount: 10,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  shellProfile: 'auto',
  // T-2.5/T-3.7: the Terminal bucket's shell (in-app plain terminal + External Terminal).
  // 'inherit' = use the CLI shell (`shellProfile`) — the default, so behaviour is unchanged.
  terminalShellProfile: 'inherit',
  conptyBackend: 'bundled',
};
// NOT IN THE CASCADE (#239): `sessionMaxAgeDays` and `autoHideDays`. They read like per-project settings
// — one project is an archive worth keeping visible, another is noise — but they are how the sidebar as a
// WHOLE is trimmed, and a per-project answer would mean the same list is pruned by different rules
// depending on which project a row belongs to, with nothing showing which rule applied. They stay global
// and are set in Settings. Revisit only together with a UI that makes such an override visible.
//
// Their DEFAULTS still live in one place, here — being global-only is not a licence to scatter them. They
// were spread over four literals across three files (app.js, settings-panel.js twice, projects.js), which
// is exactly the shape #237 had to be dug out of: independent numbers that happen to agree until one of
// them is edited. The renderer cannot require this module, so its literals are pinned against these by
// test/settings-defaults.test.js — same technique as visibleSessionCount.
const GLOBAL_ONLY_DEFAULTS = {
  sessionMaxAgeDays: 3,   // hide sessions older than N days; 0 = no limit
  autoHideDays: 0,        // auto-hide inactive projects after N days; 0 = off
};

/**
 * A settings blob may carry `customLaunchers[].env` (Tier-3, T-3.10). Those values follow the same rule
 * as a profile's: a `$VAR` reference (resolved at spawn) or a plain literal — but NEVER a raw key. This
 * drops any value that looks like one, so a pasted token cannot reach the disk.
 * Returns { value, removed[] }; `value` is the original object when nothing was stripped.
 */
function stripLauncherSecrets(blob) {
  const removed = [];
  if (!blob || typeof blob !== 'object' || !Array.isArray(blob.customLaunchers)) return { value: blob, removed };

  const launchers = blob.customLaunchers.map(l => {
    if (!l || typeof l !== 'object' || !l.env || typeof l.env !== 'object') return l;
    const env = {};
    for (const [k, v] of Object.entries(l.env)) {
      if (typeof v === 'string' && profiles.looksLikeRawSecret(v, k)) {
        removed.push(`${l.name || l.id || 'launcher'}.${k}`);
        continue;   // dropped: an unresolved $VAR is dropped at spawn too, so this fails visibly, not silently
      }
      env[k] = v;
    }
    return { ...l, env };
  });

  if (!removed.length) return { value: blob, removed };
  return { value: { ...blob, customLaunchers: launchers }, removed };
}

/**
 * The same rule for a BACKEND's own env bundle (`backendEnv.<id>`). It goes to disk exactly like a
 * launcher's and a template's, so it gets exactly the same guard: a value that looks like a pasted key is
 * dropped here, at the trust boundary, and never written. A `$VAR` reference is the supported way — it is
 * resolved at spawn and lives only in the user's environment.
 */
function stripBackendEnvSecrets(blob) {
  const removed = [];
  if (!blob || typeof blob !== 'object' || !blob.backendEnv || typeof blob.backendEnv !== 'object') {
    return { value: blob, removed };
  }
  const out = {};
  for (const [backendId, env] of Object.entries(blob.backendEnv)) {
    if (!env || typeof env !== 'object') continue;
    const clean = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string' && profiles.looksLikeRawSecret(v, k)) {
        removed.push(`${backendId}.${k}`);
        continue;   // an unresolved $VAR is dropped at spawn too, so this fails visibly, not silently
      }
      clean[k] = v;
    }
    out[backendId] = clean;
  }
  if (!removed.length) return { value: blob, removed };
  return { value: { ...blob, backendEnv: out }, removed };
}

/**
 * The one way a settings blob reaches the disk. Every writer goes through here — the settings
 * form, and the settings IMPORT (#145). An importer that called setSetting() directly would be a
 * back door around both halves of this: the secret scrub below, and the backend re-arm.
 */
/**
 * THE SCRUB ITSELF — everything a renderer-supplied blob has to survive before it may reach the disk.
 *
 * Custom launchers (Tier-3) carry an env block, and the settings blob goes to DISK. A profile's env is
 * guarded at exactly this boundary (profiles.save rejects a literal key); the launchers promised "the same
 * hygiene" in their own comment and never had it — a pasted key was written out verbatim.
 *
 * Its own function since #221, because there is more than one door: `merge-setting` also takes a partial
 * from the renderer, and it used to write straight through. A guard that sits on only one of two doors is
 * decorative. It never throws — a settings save must not fail on this.
 */
function scrubBlobForDisk(value) {
  try {
    const stripped = stripLauncherSecrets(value);
    if (stripped.removed.length) {
      ctx.log.warn(`[launchers] refused to persist literal secret(s): ${stripped.removed.join(', ')} — use a $VAR reference`);
      value = stripped.value;
    }
    const env = stripBackendEnvSecrets(value);
    if (env.removed.length) {
      ctx.log.warn(`[backends] refused to persist literal secret(s) in backendEnv: ${env.removed.join(', ')} — use a $VAR reference`);
      value = env.value;
    }
  } catch { /* never block a settings save on this */ }
  return value;
}

function persistSettingsBlob(key, value) {
  value = scrubBlobForDisk(value);

  ctx.db.setSetting(key, value);
  // Enabling/disabling a backend changes which stores must be watched and scanned. Re-arm here so
  // the change takes effect immediately instead of only after a restart (§5.8: a newly-enabled
  // `ready` backend must "appear with no code change" — and with no restart either).
  if (key === 'global') {
    try {
      ctx.startBackendWatchers();
      // The roster the worker scans is recomputed per request, so a full reconcile picks up the
      // just-enabled/disabled backend; postReconcile pushes projects-changed itself on apply.
      ctx.indexWorker.postReconcile();
      ctx.notifyRendererProjectsChanged();
    } catch (err) {
      ctx.log.warn('[backends] re-arm after settings change failed:', err?.message || err);
    }
  }
}

// Claude's launch options used to live at the top of the settings blob (Sessions & CLI). They are
// launch options like any other backend's, so they now live where every backend's do:
// `backendDefaults.claude.<opt>` (§4a). Move them once, per settings scope, and delete the old keys —
// keeping both would recreate exactly the two-homes-one-setting trap this consolidates away.
//
// `dangerouslySkipPermissions` collapses into the permissionMode CHOICE 'dangerously-skip': the CLI
// treats them as one decision (the skip flag wins over --permission-mode), so the schema models one
// control, not two that can contradict each other.
const LEGACY_CLAUDE_LAUNCH_KEYS = [
  'permissionMode', 'dangerouslySkipPermissions', 'worktree', 'worktreeName',
  'chrome', 'addDirs', 'preLaunchCmd', 'mcpEmulation', 'afkTimeoutSec',
];

function migrateClaudeLaunchDefaults() {
  const scopes = [{ key: 'global', value: ctx.db.getSetting('global') }, ...ctx.db.listSettings('project:')];
  let moved = 0;
  for (const scope of scopes) {
    const blob = scope.value;
    if (!blob || typeof blob !== 'object') continue;
    if (blob.backendDefaults && blob.backendDefaults.claude) continue;            // already migrated
    if (!LEGACY_CLAUDE_LAUNCH_KEYS.some(k => blob[k] !== undefined)) continue;    // nothing to move

    const claude = {};
    for (const k of LEGACY_CLAUDE_LAUNCH_KEYS) {
      const v = blob[k];
      if (v === undefined || v === null) continue;
      if (k === 'dangerouslySkipPermissions') { if (v) claude.permissionMode = 'dangerously-skip'; continue; }
      if (k === 'permissionMode' && claude.permissionMode === 'dangerously-skip') continue;   // skip wins
      claude[k] = v;
    }
    const next = { ...blob, backendDefaults: { ...(blob.backendDefaults || {}), claude } };
    for (const k of LEGACY_CLAUDE_LAUNCH_KEYS) delete next[k];
    ctx.db.setSetting(scope.key, next);
    moved++;
  }
  if (moved) ctx.log.info(`[settings] moved Claude's launch options into backendDefaults.claude (${moved} scope(s))`);
}

// Cascade all settings: default → global → project; null/undefined mean
// "inherit". Single implementation for the get-effective-settings IPC, the
// shell-profile resolution and createTerminalSession (#79).
function effectiveSettings(projectPath) {
  const global = ctx.db.getSetting('global') || {};
  const project = projectPath ? (ctx.db.getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) effective[key] = global[key];
    if (project[key] !== undefined && project[key] !== null) effective[key] = project[key];
  }
  // Per-backend launch defaults (§4a) cascade **per option**, like every other setting — not as one
  // block. Taking the project's whole blob whenever it was non-empty meant a project that overrode a
  // single Codex option FROZE every backend's defaults at the moment it was saved: later changes to the
  // global defaults could never reach that project again (#149).
  //
  // A project therefore stores only the options it actually overrides.
  effective.backendDefaults = mergeBackendDefaults(global.backendDefaults, project.backendDefaults);
  return effective;
}

/** global ⊕ project, per backend, per option. The project wins where it has a value of its own. */
function mergeBackendDefaults(globalDefaults, projectDefaults) {
  const g = globalDefaults && typeof globalDefaults === 'object' ? globalDefaults : {};
  const p = projectDefaults && typeof projectDefaults === 'object' ? projectDefaults : {};
  const out = {};
  for (const id of new Set([...Object.keys(g), ...Object.keys(p)])) {
    const gOpts = (g[id] && typeof g[id] === 'object') ? g[id] : {};
    const pOpts = (p[id] && typeof p[id] === 'object') ? p[id] : {};
    const merged = { ...gOpts };
    for (const [opt, value] of Object.entries(pOpts)) {
      if (value === undefined || value === null) continue;   // absent = "inherit this option"
      merged[opt] = value;
    }
    out[id] = merged;
  }
  return out;
}

/**
 * @param {Electron.IpcMain} ipc  passed in, not required — see the header: this module stays
 *   Electron-free so its guards can be required instead of scraped out of source text.
 */
function registerIpc(ipc) {
  ipc.handle('get-setting', (_event, key) => {
    return ctx.db.getSetting(key);
  });

  ipc.handle('set-setting', (_event, key, value) => {
    persistSettingsBlob(key, value);
    return { ok: true };
  });

  // Atomic partial update of an object-valued setting: read-merge-write happens
  // synchronously inside this single handler, so concurrent callers (tab drag,
  // sidebar resize, a second window) can't clobber each other's unrelated keys
  // the way a renderer-side read-modify-write of the whole blob does (issue #75).
  ipc.handle('merge-setting', (_event, key, partial) => {
    const cur = ctx.db.getSetting(key);
    const base = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
    // `partial` is renderer-supplied, so it takes the same scrub set-setting does (#221). Its callers only
    // ever send sidebarWidth/tabOrder today — the point is that the channel enforces it regardless of who
    // calls it next, which is the whole reason the guard is on the main side.
    //
    // Deliberately NOT persistSettingsBlob: that also re-arms the backend watchers and posts a full
    // reconcile on the `global` key, and this handler fires on every sidebar drag and tab reorder. A
    // partial that changes `backendEnabled` would need that re-arm — no caller does, and one that starts
    // to belongs on set-setting.
    ctx.db.setSetting(key, scrubBlobForDisk({ ...base, ...(partial || {}) }));
    return { ok: true };
  });

  ipc.handle('delete-setting', (_event, key) => {
    ctx.db.deleteSetting(key);
    return { ok: true };
  });

  ipc.handle('get-effective-settings', (_event, projectPath) => {
    return effectiveSettings(projectPath);
  });

  // --- IPC: settings export / import (#145) ---
  // Global blob only. What goes in the file and what may come out of it is decided in
  // settings-transfer.js; this pair owns the two things that need Electron — the native file
  // dialogs — and nothing else. The dialog parents to the window that ASKED, because these
  // buttons also render in the standalone settings pop-out.
  ipc.handle('export-settings', async (event) => {
    const parent = ctx.getParentWindow(event.sender);
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await ctx.dialog.showSaveDialog(parent, {
      title: 'Export Settings',
      defaultPath: `switchboard-settings-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      // The project list rides along explicitly now — it is a table, not a settings key (#167).
      const payload = settingsTransfer.buildExportPayload(ctx.db.getSetting('global'), new Date().toISOString(), ctx.db.getProjectStates());
      fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
      ctx.log.info(`[settings] exported ${Object.keys(payload.global).length} global key(s)`);
      return { ok: true, filePath: result.filePath, keys: Object.keys(payload.global).length };
    } catch (err) {
      ctx.log.error('[settings] export failed:', err);
      return { ok: false, error: err.message };
    }
  });

  ipc.handle('import-settings', async (event) => {
    const parent = ctx.getParentWindow(event.sender);
    const result = await ctx.dialog.showOpenDialog(parent, {
      title: 'Import Settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    try {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
      } catch {
        return { ok: false, error: 'The file is not valid JSON.' };
      }
      const check = settingsTransfer.validateImportPayload(parsed);
      if (!check.ok) return { ok: false, error: check.error };

      // Through the same door a normal save uses: secrets scrubbed, backends re-armed.
      persistSettingsBlob('global', settingsTransfer.mergeImport(ctx.db.getSetting('global'), check.global));

      // The project list (#167). A file that carries none — an older export, or a machine that never had a
      // project — leaves the list here ALONE: importing "nothing" must not mean "wipe it".
      const incoming = settingsTransfer.importProjects(parsed);
      for (const row of incoming) {
        ctx.db.setProjectState(row.projectPath, { registered: 1, hidden: row.hidden, removedAt: null });
      }

      ctx.broadcastSettingsChanged();   // main-initiated: every window re-applies, incl. the sender
      const keys = Object.keys(check.global).length;
      ctx.log.info(`[settings] imported ${keys} global key(s), ${incoming.length} project(s)`);
      return { ok: true, keys, projects: incoming.length };
    } catch (err) {
      ctx.log.error('[settings] import failed:', err);
      return { ok: false, error: err.message };
    }
  });
}

module.exports = {
  init,
  registerIpc,
  // main.js's spawn/terminal paths and its lifecycle call these.
  effectiveSettings,
  migrateClaudeLaunchDefaults,
  SETTING_DEFAULTS,
  GLOBAL_ONLY_DEFAULTS,
  // The trust boundary and the cascade. Exported so the tests can REQUIRE them — they used to be
  // scraped out of main.js's source and run through `new Function`, because main.js needs Electron.
  persistSettingsBlob,
  stripLauncherSecrets,
  stripBackendEnvSecrets,
  mergeBackendDefaults,
};
