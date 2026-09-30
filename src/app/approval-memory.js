// app/approval-memory.js — what the user already allowed, for a runtime-driven session's approval questions (#731).
//
// A backend whose approvals are the APP's (pi-native's gate: Pi itself asks nothing) may let the core answer a
// question the user already answered, instead of drawing the same card again. What was allowed is kept here, in
// two places, and neither names a backend or a key of one:
//
//   * FOR THIS SESSION, per session id. The key is the backend's own (opaque here). Kept in the app's database
//     under `approval-sessions` rather than in the runtime, so it outlives what the runtime rebuilds — Pi builds a
//     new extension instance on `/reload` and every respawn — while a new conversation, which is a new id, starts
//     empty. Bounded: the newest SESSION_CAP sessions are kept.
//   * IN THIS PROJECT, as rules in the backend option the descriptor names (`rpc.approvalRulesOption`), one per
//     line, in the project's settings blob (`settingsOwnerPath`, so a worktree's are its project's). Read per
//     question, so an edit on the settings screen reaches a running session at its next question. The option
//     cascades like every other one: the project's value when it has one, else the global one.
//
// WHAT A RULE MEANS is the backend's (`rpc.approvalAutoAnswer`); this module only stores lines. A rule written
// while the settings window is open is overwritten by that window's next Save, which holds a snapshot of the blob
// (`.claude/rules/renderer.md`, #146) — the same caveat every main-side writer of a setting carries.
'use strict';

const { settingsOwnerPath } = require('../shared/worktree-path');

const SESSIONS_KEY = 'approval-sessions';
const SESSION_CAP = 300;

let ctx = null;

/**
 * @param {object} context
 * @param {object} context.db  getSetting/setSetting
 * @param {(key: string, value: any) => void} context.persistSettingsBlob  the settings module's write door
 * @param {() => void} [context.broadcastSettingsChanged]  every window re-applies after a main-side write
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
}

const sessionEntryKey = (backendId, sessionId) => `${backendId}:${sessionId}`;

function readSessions() {
  const v = ctx && ctx.db ? ctx.db.getSetting(SESSIONS_KEY) : null;
  return v && typeof v === 'object' && v.entries && typeof v.entries === 'object' ? v : { entries: {} };
}

function writeSessions(store) {
  const all = Object.entries(store.entries).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  ctx.db.setSetting(SESSIONS_KEY, { entries: Object.fromEntries(all.slice(0, SESSION_CAP)) });
}

/** The keys allowed for this session, as a Set (empty when nothing was allowed or nothing can be read). */
function sessionKeys(backendId, sessionId) {
  if (!ctx || !backendId || !sessionId) return new Set();
  try {
    const entry = readSessions().entries[sessionEntryKey(backendId, sessionId)];
    return new Set(entry && Array.isArray(entry.keys) ? entry.keys.map(String) : []);
  } catch (err) {
    ctx.log.warn(`[approval-memory] session allows not read: ${err.message}`);
    return new Set();
  }
}

function rememberSession(backendId, sessionId, key) {
  if (!ctx || !backendId || !sessionId || !key) return;
  try {
    const store = readSessions();
    const k = sessionEntryKey(backendId, sessionId);
    const keys = new Set(store.entries[k] && Array.isArray(store.entries[k].keys) ? store.entries[k].keys : []);
    keys.add(String(key));
    store.entries[k] = { keys: [...keys], at: Date.now() };
    writeSessions(store);
  } catch (err) {
    ctx.log.warn(`[approval-memory] session allow not kept: ${err.message}`);
  }
}

// The session a runtime named at its start is the SAME conversation as the id the app launched it under, so what
// was allowed under the launch id moves with it. Only that first move: a later one is `/new` or a fork, which is
// another conversation and starts empty.
function carrySession(backendId, fromId, toId) {
  if (!ctx || !backendId || !fromId || !toId || fromId === toId) return;
  try {
    const store = readSessions();
    const from = store.entries[sessionEntryKey(backendId, fromId)];
    if (!from) return;
    const to = store.entries[sessionEntryKey(backendId, toId)];
    const keys = new Set([...(to && Array.isArray(to.keys) ? to.keys : []), ...(Array.isArray(from.keys) ? from.keys : [])]);
    delete store.entries[sessionEntryKey(backendId, fromId)];
    store.entries[sessionEntryKey(backendId, toId)] = { keys: [...keys], at: Date.now() };
    writeSessions(store);
  } catch (err) {
    ctx.log.warn(`[approval-memory] session allows not carried: ${err.message}`);
  }
}

const linesOf = (value) => (Array.isArray(value) ? value : String(value == null ? '' : value).split(/\r?\n/))
  .map(l => String(l).trim()).filter(Boolean);

function optionAt(scopeKey, backendId, option) {
  const blob = ctx.db.getSetting(scopeKey);
  const opts = blob && blob.backendDefaults && blob.backendDefaults[backendId];
  return opts && Object.prototype.hasOwnProperty.call(opts, option) ? opts[option] : undefined;
}

/** The project's rules for this backend option: the project's value when it has one, else the global one. */
function projectRules(backendId, projectPath, option) {
  if (!ctx || !backendId || !option) return [];
  try {
    const own = projectPath ? optionAt('project:' + settingsOwnerPath(projectPath), backendId, option) : undefined;
    return linesOf(own !== undefined ? own : optionAt('global', backendId, option));
  } catch (err) {
    ctx.log.warn(`[approval-memory] project rules not read: ${err.message}`);
    return [];
  }
}

// Adds a rule to the project's value of the option. A project that has no value of its own yet starts from the
// global one, so writing the first project rule does not silently drop the global rules for that project.
function rememberProjectRule(backendId, projectPath, option, rule) {
  // A rule is one line of the option: one with a line break would store as several.
  if (!ctx || !backendId || !projectPath || !option || !rule || /[\r\n]/.test(String(rule))) return false;
  try {
    const key = 'project:' + settingsOwnerPath(projectPath);
    const blob = ctx.db.getSetting(key);
    const next = blob && typeof blob === 'object' && !Array.isArray(blob) ? { ...blob } : {};
    const defaults = { ...(next.backendDefaults || {}) };
    const opts = { ...(defaults[backendId] || {}) };
    const lines = linesOf(Object.prototype.hasOwnProperty.call(opts, option) ? opts[option] : optionAt('global', backendId, option));
    if (lines.includes(String(rule))) return true;
    lines.push(String(rule));
    opts[option] = lines.join('\n');
    defaults[backendId] = opts;
    next.backendDefaults = defaults;
    ctx.persistSettingsBlob(key, next);
    if (typeof ctx.broadcastSettingsChanged === 'function') ctx.broadcastSettingsChanged();
    ctx.log.info(`[approval-memory] project rule added for ${backendId}`);
    return true;
  } catch (err) {
    ctx.log.warn(`[approval-memory] project rule not written: ${err.message}`);
    return false;
  }
}

module.exports = { init, sessionKeys, rememberSession, carrySession, projectRules, rememberProjectRule, SESSIONS_KEY, SESSION_CAP };
