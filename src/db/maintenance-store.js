// The turns the app itself sent to an idle session (#827, spec 45): written when an action is taken, read when a conversation
// is drawn again after a restart, so that a maintenance turn is not mistaken for something the user wrote.
// Beside them, the session's own override of the idle settings (`session_meta.idleOverride`), so a resumed session runs on
// what the user last picked for it.
'use strict';

const { db } = require('./connection');
const { runWithBusyRetry } = require('./sqlite-busy-retry');
const { cleanIdleOverride } = require('./idle-override-record');

const stmts = {
  insert: db.prepare('INSERT INTO maintenance_turn (session_id, entry_key, entry_text, kind, sent_at) VALUES (?, ?, ?, ?, ?)'),
  forSession: db.prepare('SELECT entry_key AS key, entry_text AS text, kind, sent_at AS at FROM maintenance_turn WHERE session_id = ? ORDER BY sent_at'),
  overrideGet: db.prepare('SELECT idleOverride FROM session_meta WHERE sessionId = ?'),
  overrideSet: db.prepare(`INSERT INTO session_meta (sessionId, idleOverride) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET idleOverride = excluded.idleOverride`),
  overrideClear: db.prepare('UPDATE session_meta SET idleOverride = NULL WHERE sessionId = ?'),
};

function recordMaintenanceTurn({ sessionId, key, text, kind, at }) {
  stmts.insert.run(sessionId, key || null, text || null, kind, at);
}

/** @returns {Array<{key: string|null, text: string|null, kind: string, at: number}>} */
function getMaintenanceTurns(sessionId) {
  return stmts.forSession.all(sessionId);
}

/** The session's stored override, `{ idleMaintenance*: value }`, or null (= follow the settings). */
function getIdleOverride(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const r = stmts.overrideGet.get(sessionId);
  if (!r || !r.idleOverride) return null;
  try { return cleanIdleOverride(JSON.parse(r.idleOverride)); } catch { return null; }
}

/** Store the session's override; null or an empty one clears it back to the settings. */
function setIdleOverride(sessionId, value) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const v = cleanIdleOverride(value);
  runWithBusyRetry(() => (v ? stmts.overrideSet.run(sessionId, JSON.stringify(v)) : stmts.overrideClear.run(sessionId)));
}

module.exports = { recordMaintenanceTurn, getMaintenanceTurns, getIdleOverride, setIdleOverride };
