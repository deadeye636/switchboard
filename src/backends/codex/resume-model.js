// backends/codex/resume-model.js — the model a Codex RESUME launches on (#754).
//
// `codex resume <id>` does NOT restore the model: without `-m` it runs on the CLI default (measured, T1), so the
// session's own model is read out of its rollout and handed back as `-m`.
//
// Source: the LAST `turn_context.payload.model`. NEVER `thread_settings_applied`: a resume writes two of those
// at its start carrying the model in force then (the default), before any `turn_context`, so a session that was
// resumed and abandoned ends in one with the wrong model.
//
// PERFORMANCE (binding): asked once, on one session's resume. One asynchronous tail read of at most
// MAX_TAIL_BYTES; the row's cached `lastModel` answers only where the tail names none, and one small asynchronous
// read of the catalog below. No synchronous fs.
//
// CATALOG: a model the account cannot use makes a resume start and then fail every turn with HTTP 400 until
// `/model` (measured, Codex 0.160.0), where before #754 the resume ran on the default. So the answer is checked
// against Codex's own `models_cache.json` (`models[].slug`, which is what `-m` takes) in the Codex home: a model
// missing from a cache that parses is declined (null); a missing, unreadable or unparsable cache blocks nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const { readFileTailAsync, MAX_TAIL_BYTES } = require('../file-store');

// What may reach `-m` (it becomes argv): no leading dash, no whitespace, no `$`, no quote.
const LAUNCH_MODEL_ARG = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/;

/** The last `turn_context` model in a rollout tail, or null. Pure. */
function lastTurnContextModel(text) {
  let model = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('"turn_context"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }   // a cut or damaged line
    if (!entry || entry.type !== 'turn_context') continue;
    const m = entry.payload && entry.payload.model;
    if (typeof m === 'string' && m.trim()) model = m.trim();
  }
  return model;
}

/** The slugs of Codex's model catalog under `home`, or null when it cannot be read as one (no verdict then). */
async function catalogSlugs(home) {
  if (!home) return null;
  try {
    const cache = JSON.parse(await fs.promises.readFile(path.join(home, 'models_cache.json'), 'utf8'));
    if (!cache || !Array.isArray(cache.models)) return null;
    const slugs = new Set(cache.models.map((m) => m && m.slug).filter((x) => typeof x === 'string'));
    // An empty catalog (a fetch that failed, say) knows no model rather than refusing every one.
    return slugs.size ? slugs : null;
  } catch { return null; }
}

// `homeOf()` is the descriptor's own resolver; `ctx.env.CODEX_HOME` (the launch's layered env) wins over it.
async function resumeLaunchOptions(row, ctx, homeOf) {
  if (!row || typeof row !== 'object') return null;
  let model = null;
  if (row.filePath) {
    try { model = lastTurnContextModel((await readFileTailAsync(row.filePath, MAX_TAIL_BYTES)).text); } catch { /* unreadable: the row answers */ }
  }
  if (!model && typeof row.lastModel === 'string') model = row.lastModel.trim();
  if (!model || !LAUNCH_MODEL_ARG.test(model)) return null;
  const envHome = ctx && ctx.env && ctx.env.CODEX_HOME;
  const slugs = await catalogSlugs(envHome || (typeof homeOf === 'function' ? homeOf() : null));
  if (slugs && !slugs.has(model)) return null;
  // Codex does not restore the model on a resume, so any difference from what was sent changes the launch.
  const sent = ctx && ctx.launchOptions && typeof ctx.launchOptions.model === 'string' ? ctx.launchOptions.model.trim() : '';
  const notice = sent === model ? undefined
    : `Resumed on ${model}, the model this session last used, instead of ${sent || "Codex's default"}`;
  return notice ? { options: { model }, label: model, notice } : { options: { model }, label: model };
}

module.exports = { resumeLaunchOptions, lastTurnContextModel, LAUNCH_MODEL_ARG };
