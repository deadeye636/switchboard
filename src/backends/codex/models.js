// backends/codex/models.js — the models a Codex launch form offers (#878).
//
// `codex debug models` prints the model catalog as JSON, one entry per model with its `slug`, `display_name`,
// `visibility` and the reasoning levels it takes (`supported_reasoning_levels: [{ effort, description }]`).
// Measured on codex-cli 0.167.0 (docs/backend-formats.md, "Choosing a model and an effort at launch"):
//   - without `--bundled` the CLI refreshes the catalog first (about 1 s), and THAT list is the account's: the
//     bundled one still held `gpt-5.5`, which the account refused at the turn;
//   - `--bundled` prints the catalog shipped in the binary, with no network call. It answers here only when the
//     refresh fails, as the next best thing to no list at all;
//   - entries marked `visibility: "hide"` are internal (a reviewer model, a reserve) and are not offered.
'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { findOnPath } = require('../file-store');
const { closeStdin, cliComplaint } = require('../cli-probe');

const CACHE_TTL_MS = 10 * 60 * 1000;
// The refresh took about 1 s; the ceiling is for a slow network, on a user opening the model field.
const PROBE_TIMEOUT_MS = 20 * 1000;
// Each entry carries its full base instructions, so the output runs to megabytes.
const MAX_BUFFER = 64 * 1024 * 1024;

let cache = null; // { at, models }

/**
 * How to start Codex without a shell. On Windows `codex` is an npm `.cmd` shim, which a process started without
 * a shell cannot run; the shim hands its arguments to `node <package>/bin/codex.js`, so that is what is started.
 * The same answer Pi gives for its own shim (`../pi/exec-command.js`).
 */
function codexExecCommand() {
  const exe = findOnPath('codex');
  if (!exe) return null;
  if (process.platform === 'win32' && /\.cmd$/i.test(exe)) {
    return { command: 'node', args: [path.join(path.dirname(exe), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] };
  }
  return { command: exe, args: [] };
}

/** The catalog as form rows: `{ id, label, effortLevels }`, hidden entries left out. */
function modelsFromCatalog(text) {
  let parsed;
  try { parsed = JSON.parse(String(text || '')); } catch { return []; }
  const list = parsed && Array.isArray(parsed.models) ? parsed.models : (Array.isArray(parsed) ? parsed : []);
  const out = [];
  for (const m of list) {
    if (!m || typeof m.slug !== 'string' || !m.slug) continue;
    if (m.visibility && m.visibility !== 'list') continue;
    const levels = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels.map((l) => (typeof l === 'string' ? l : l && l.effort)).filter((l) => typeof l === 'string' && l)
      : [];
    out.push({ id: m.slug, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug, effortLevels: levels });
  }
  return out;
}

function runCatalog(launch, extra, env) {
  return new Promise((resolve) => {
    // closeStdin, not a `stdio` option: execFile ignores that one (#532, ../cli-probe.js). Not a project as the
    // working directory: a bare `node` must not be looked up in one first (CLAUDE.md reflex 10). The refresh
    // writes Codex' own catalog cache, so it runs under the home the caller hands in (an isolated instance's).
    closeStdin(execFile(launch.command, [...launch.args, 'debug', 'models', ...extra], {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, cwd: require('os').tmpdir(),
      env: env || process.env,
    }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = !!(err.killed || err.code === 'ETIMEDOUT');
        resolve({ models: [], reason: timedOut
          ? `Codex did not answer within ${Math.round(PROBE_TIMEOUT_MS / 1000)} seconds. Try again, or type the model id.`
          : (cliComplaint(stderr) || 'Could not list Codex models.') });
        return;
      }
      resolve({ models: modelsFromCatalog(stdout) });
    }));
  });
}

/** The descriptor's `listModels`: the refreshed catalog, else the bundled one, cached for a while. */
async function listModels({ resolveCommand = codexExecCommand, run = runCatalog, env } = {}) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { ok: true, models: cache.models, cached: true };
  const launch = resolveCommand();
  if (!launch) return { ok: false, reason: 'Codex was not found on PATH.' };
  const fresh = await run(launch, [], env);
  if (fresh.models.length) {
    cache = { at: Date.now(), models: fresh.models };
    return { ok: true, models: fresh.models, cached: false };
  }
  const bundled = await run(launch, ['--bundled'], env);
  // Not cached: the next open tries the account's list again.
  if (bundled.models.length) return { ok: true, models: bundled.models, cached: false, bundled: true };
  return { ok: false, reason: fresh.reason || bundled.reason || 'Codex listed no models.' };
}

function _reset() { cache = null; }

module.exports = { listModels, modelsFromCatalog, codexExecCommand, _reset };
