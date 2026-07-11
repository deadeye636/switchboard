// session-backends.js — the launch-time OVERLAY mapping sessionId -> {backendId, profileId}.
//
// This is written at spawn (we know the chosen backend/profile) and READ by the scanner when
// it persists a session_cache row: for shared-root (Axis-A) sessions the scan can't tell a
// DeepSeek-profile session from a plain Claude one by its files, so it MERGES this overlay into
// the row's authoritative `backendId` (invariant §5.7). The row is the source of truth once
// written; this map is only the bridge until then.
//
// Critical FIFO rule (§5.7): the cap must NOT evict an entry before the first scan has
// persisted it into session_cache — dropping an un-scanned entry loses the provenance for good.
// So eviction spares entries not yet marked persisted (the scanner calls markPersisted after
// writing the row's backendId).
//
// Mirrors ivandobsky's session-profiles.js (debounced atomic flush, before-quit flush, rekey on
// temp->real id transition), generalized from profileId-only to {backendId, profileId}.
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const CAP = 5000;          // soft target; eviction only ever removes PERSISTED entries down to this
const FLUSH_DEBOUNCE_MS = 200;

let _filePath = null;      // resolved lazily (electron userData) unless overridden for tests
let state = null;          // { version, sessions: { id: { backendId, profileId } } }
let order = [];            // insertion order of ids (FIFO)
const persisted = new Set(); // ids whose session_cache row already carries backendId (runtime-only)
let flushTimer = null;
let loaded = false;

function resolveFilePath() {
  if (_filePath) return _filePath;
  // Lazy electron require so a plain-node unit test can load this module and inject a path.
  const { app } = require('electron');
  _filePath = path.join(app.getPath('userData'), 'session-backends.json');
  return _filePath;
}

function isValidEntry(v) {
  return v && typeof v === 'object'
    && typeof v.backendId === 'string' && v.backendId !== ''
    && (v.profileId == null || typeof v.profileId === 'string');
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  state = { version: VERSION, sessions: {} };
  order = [];
  let raw;
  try { raw = fs.readFileSync(resolveFilePath(), 'utf8'); } catch { return; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed || typeof parsed.sessions !== 'object' || !parsed.sessions) return;
  for (const [id, v] of Object.entries(parsed.sessions)) {
    if (typeof id === 'string' && id !== '' && isValidEntry(v)) {
      state.sessions[id] = { backendId: v.backendId, profileId: v.profileId == null ? null : v.profileId };
      order.push(id);
    }
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, FLUSH_DEBOUNCE_MS);
  if (flushTimer.unref) flushTimer.unref();
}

// Atomic write (tmp + rename). Synchronous so before-quit can call it directly.
function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!loaded) return;
  const file = resolveFilePath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, sessions: state.sessions }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Remove oldest PERSISTED entries down to CAP; ALWAYS spare un-persisted ones (§5.7 — an un-scanned
// entry must never be dropped before the first scan writes its provenance). In the pathological case
// of >CAP entries that are all still un-persisted, the map is allowed to exceed CAP rather than lose
// provenance; the scanner marks entries persisted within seconds of a launch, so this is bounded in
// practice (correctness over memory — a lost backendId is unrecoverable, a slightly larger map isn't).
function capEvict() {
  if (order.length <= CAP) return;
  const drop = (id) => {
    delete state.sessions[id];
    persisted.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
  };
  for (let i = 0; i < order.length && order.length > CAP; ) {
    const id = order[i];
    if (persisted.has(id)) { drop(id); } else { i++; }
  }
}

// Record the backend (and optional profile) chosen for a session at launch.
function record(sessionId, backendId, profileId = null) {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  if (typeof backendId !== 'string' || backendId === '') return;
  ensureLoaded();
  const isNew = !(sessionId in state.sessions);
  state.sessions[sessionId] = { backendId, profileId: profileId == null ? null : String(profileId) };
  if (isNew) order.push(sessionId);
  persisted.delete(sessionId); // a fresh record is un-scanned until the next scan re-marks it
  capEvict();
  scheduleFlush();
}

// The whole map, as a plain object (renderer loads it once via IPC).
function getAll() {
  ensureLoaded();
  const out = {};
  for (const [id, v] of Object.entries(state.sessions)) out[id] = { backendId: v.backendId, profileId: v.profileId };
  return out;
}

function get(sessionId) {
  ensureLoaded();
  const v = state.sessions[sessionId];
  return v ? { backendId: v.backendId, profileId: v.profileId } : null;
}

// temp->real sessionId transition: copy the mapping to the real id, drop the temp. Idempotent.
function rekeySession(tempId, realId) {
  if (typeof tempId !== 'string' || typeof realId !== 'string' || tempId === realId) return;
  ensureLoaded();
  const v = state.sessions[tempId];
  if (!v) return;
  const wasPersisted = persisted.has(tempId);
  state.sessions[realId] = { backendId: v.backendId, profileId: v.profileId };
  if (!(realId in state.sessions) || order.indexOf(realId) < 0) order.push(realId);
  if (wasPersisted) persisted.add(realId);
  // remove temp
  delete state.sessions[tempId];
  persisted.delete(tempId);
  const i = order.indexOf(tempId);
  if (i >= 0) order.splice(i, 1);
  scheduleFlush();
}

// The scanner calls this after writing a row's authoritative backendId — it makes the overlay
// entry eligible for FIFO eviction (before this it is spared, §5.7).
function markPersisted(sessionId) {
  ensureLoaded();
  if (sessionId in state.sessions) persisted.add(sessionId);
}

function isPersisted(sessionId) {
  return persisted.has(sessionId);
}

// --- test hooks ---
function _configureForTests({ filePath } = {}) {
  _filePath = filePath || null;
  state = null; order = []; persisted.clear();
  loaded = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

module.exports = {
  record, getAll, get, rekeySession, markPersisted, isPersisted,
  flushNow, scheduleFlush,
  CAP,
  _configureForTests,
};
