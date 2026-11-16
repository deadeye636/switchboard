// backends/claude/models.js — the models a Claude launch form offers (#878).
//
// The CLI has no command that lists its models (`claude --help`, 2.1.323). The only machine-readable list is the
// runtime's answer to an `initialize` control request, which carries every model the account may use with the
// effort levels each one takes (`supportsEffort`, `supportedEffortLevels`). So this module keeps ONE cache, fed
// from two places, and falls back to the aliases while it is empty:
//
//   1. a short probe: `claude -p --input-format stream-json --output-format stream-json --verbose`, one
//      `initialize`, stdin closed after the answer. No turn, no transcript file (measured, docs/backend-formats.md
//      "Choosing a model and an effort at launch"). Without `disableAllHooks` it ran the user's SessionStart hooks
//      for a session that never happens, so the probe passes that as a flag setting; `--strict-mcp-config` with
//      no `--mcp-config` keeps the user's MCP servers from being started for it. `--bare` is no way out: it reads
//      no OAuth, and the list is the account's.
//   2. every `initialize` answer a running claude-native session gives its own model picker (`remember`, called
//      from `../claude-native/rpc-protocol.js`), so a user of the GUI mode refreshes the list for free.
//
// Both modes of Claude store the `model` field once (src/shared/backend-modes.js), so both answer from here.
//
// Known limits, accepted with #878: the probe runs with the process environment plus the isolated home
// (`cliHomeEnv`), not with a template's or the user's per-backend variables, and the cache is one per process — so a
// template pointed at another endpoint is offered the main account's list (free text still sends what it says).
// On Windows only a native `claude.exe` is started; when PATH finds an npm `claude.cmd` first, the cache and the
// aliases answer. The probe writes its own control line rather than claude-native's `modelsCommand`, because this
// module is below that one (claude-native requires it, not the other way round); the effort rule is shared
// (`effortLevelsOf`).
'use strict';

const os = require('os');
const { spawn } = require('child_process');

// What the list holds before anything is known: the aliases the CLI documents (`--model` help) and the runtime
// listed (#872). No effort levels, so a form offers the backend's full list for them.
const ALIASES = [
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'fable', label: 'Fable (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
];

// The account's models change rarely, and every open claude-native session refreshes the cache anyway.
const CACHE_TTL_MS = 30 * 60 * 1000;
// Measured 1.9-2.3 s to the answer. The ceiling is generous because this runs when a user opens the model
// field, not on the scan path, and the answer is cached afterwards.
const PROBE_TIMEOUT_MS = 20 * 1000;
// Once the answer is in, stdin is closed and the CLI exits by itself (0.9-1.8 s measured); past this it is killed.
const EXIT_GRACE_MS = 5 * 1000;

let cache = null;      // { at, models }
let inflight = null;   // the probe running now, shared by every caller

/**
 * The effort levels one `initialize` row says its model takes, `[]` for none. The one reading of that rule: the
 * running session's picker (`../claude-native/rpc-protocol.js`, `modelsFromResponse`) asks it too.
 */
function effortLevelsOf(m) {
  return m && m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)
    ? m.supportedEffortLevels.filter((l) => typeof l === 'string' && l)
    : [];
}

/**
 * The runtime's `initialize` answer as form rows: `{ id, label, effortLevels }`. `effortLevels` is the list the
 * model takes, `[]` for a model that takes none. `default` is left out: an empty field already means the CLI's
 * own default, and a row that sends `--model default` would be a second way to say it.
 * Takes the core's normalised response (`{ success, data: { models } }`), the shape claude-native hands its picker.
 */
function modelsFromInitialize(response) {
  const list = response && response.success !== false && response.data && response.data.models;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m.value !== 'string' || !m.value || m.value === 'default') continue;
    out.push({
      id: m.value,
      label: typeof m.displayName === 'string' && m.displayName ? m.displayName : m.value,
      effortLevels: effortLevelsOf(m),
    });
  }
  return out;
}

/** Keep a list the runtime gave. A list with no rows changes nothing. */
function remember(response) {
  const models = modelsFromInitialize(response);
  if (models.length) cache = { at: Date.now(), models };
  return models;
}

/**
 * Ask a fresh `claude` for its list. Resolves the normalised response, or null when it could not be had (no
 * executable, a timeout, an exit before the answer). Never rejects.
 */
function probeInitialize({ exe, env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!exe) { resolve(null); return; }
    let child;
    try {
      child = spawn(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--settings', JSON.stringify({ disableAllHooks: true }), '--strict-mcp-config'], {
        // Not a project: a project's own settings and its CLAUDE.md are nothing a model list needs, and a bare
        // program name never runs with a project as its working directory (CLAUDE.md reflex 10).
        cwd: os.tmpdir(),
        env: env || process.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch { resolve(null); return; }
    // A CLI that exits before it reads raises EPIPE or EOF on its stdin asynchronously; the exit answers this probe.
    child.stdin.on('error', () => {});
    let settled = false;
    let buf = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      const grace = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, EXIT_GRACE_MS);
      grace.unref();
      child.once('exit', () => clearTimeout(grace));
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const r = msg && msg.type === 'control_response' ? msg.response : null;
        if (!r || r.request_id !== 'models') continue;
        finish(r.subtype === 'success' ? { success: true, data: r.response || {} } : null);
      }
    });
    try {
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n');
    } catch { finish(null); }
  });
}

/**
 * The descriptor's `listModels`. A fresh cache answers at once; otherwise one probe runs (shared by every caller
 * while it is out). A probe that fails leaves an older list standing, and with none the aliases answer, so the
 * field always offers something and free text stays possible.
 */
async function listModels({ exe, env, probe = probeInitialize } = {}) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { ok: true, models: cache.models, cached: true };
  if (!inflight) {
    inflight = Promise.resolve(probe({ exe, env }))
      .then((res) => (res ? remember(res) : []))
      .catch(() => [])
      .finally(() => { inflight = null; });
  }
  const fresh = await inflight;
  if (fresh.length) return { ok: true, models: fresh, cached: false };
  if (cache) return { ok: true, models: cache.models, cached: true, stale: true };
  return { ok: true, models: ALIASES.slice(), cached: false, fallback: true };
}

// For tests: forget what was learned.
function _reset() { cache = null; inflight = null; }

module.exports = { listModels, remember, modelsFromInitialize, effortLevelsOf, probeInitialize, ALIASES, CACHE_TTL_MS, _reset };
