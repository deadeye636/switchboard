// backends/pi/model-windows.js — the context window of a model Pi ran a turn on (#620).
//
// Pi is multi-provider: one session can move from anthropic to openai-codex mid-flight, so the window is
// looked up per turn, for the provider AND model the last assistant message names. Pi keeps a catalog of
// its own for exactly this, with a `contextWindow` per model — measured on a real install, and consistent
// with how Pi behaves: its compactions on a 272 000 model triggered at 256-279k.
//
// Two files, both in Pi's agent directory (which follows the demo/sandbox isolation through `trust.js`):
//   models-store.json   { <provider>: { models: [{ id, contextWindow, … }] } }         Pi's own catalog
//   models.json         { providers: { <provider>: { models: [{ id, contextWindow }] } } }   the user's
// The user's file wins for a provider/model it defines — it is how a local or custom model gets a window.
'use strict';

const fs = require('fs');
const path = require('path');
const trust = require('./trust');

// Read on every sidebar payload, once per row — so both files are held for a few seconds, not re-read.
const TTL_MS = 5000;
let _cache = null;   // { at, dir, windows: Map<"provider\u0000model", number> }

function addModels(windows, provider, models) {
  if (!provider || !Array.isArray(models)) return;
  for (const m of models) {
    const w = m && Number(m.contextWindow);
    if (m && typeof m.id === 'string' && w > 0) windows.set(provider + '\u0000' + m.id, w);
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function catalog() {
  const dir = trust.agentDir();
  const now = Date.now();
  if (_cache && _cache.dir === dir && now - _cache.at < TTL_MS) return _cache.windows;
  const windows = new Map();
  const store = readJson(path.join(dir, 'models-store.json'));
  if (store && typeof store === 'object') {
    for (const [provider, entry] of Object.entries(store)) addModels(windows, provider, entry && entry.models);
  }
  const user = readJson(path.join(dir, 'models.json'));
  if (user && user.providers && typeof user.providers === 'object') {
    for (const [provider, entry] of Object.entries(user.providers)) addModels(windows, provider, entry && entry.models);
  }
  _cache = { at: now, dir, windows };
  return windows;
}

/** `{ windowTokens, source }` for a stored row's last turn, or null when the catalog has no such model. */
function contextWindow(row) {
  if (!row || !row.lastProvider || !row.lastModel) return null;
  const w = catalog().get(row.lastProvider + '\u0000' + row.lastModel);
  return w > 0 ? { windowTokens: w, source: 'catalog' } : null;
}

// Tests point the agent directory elsewhere between cases; this drops what an earlier case cached.
function _resetCache() { _cache = null; }

module.exports = { contextWindow, _resetCache };
