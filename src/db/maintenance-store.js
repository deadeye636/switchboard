// The turns the app itself sent to an idle session (#827, spec 45): written when an action is taken, read when a conversation
// is drawn again after a restart, so that a maintenance turn is not mistaken for something the user wrote.
'use strict';

const { db } = require('./connection');

const stmts = {
  insert: db.prepare('INSERT INTO maintenance_turn (session_id, entry_key, entry_text, kind, sent_at) VALUES (?, ?, ?, ?, ?)'),
  forSession: db.prepare('SELECT entry_key AS key, entry_text AS text, kind, sent_at AS at FROM maintenance_turn WHERE session_id = ? ORDER BY sent_at'),
};

function recordMaintenanceTurn({ sessionId, key, text, kind, at }) {
  stmts.insert.run(sessionId, key || null, text || null, kind, at);
}

/** @returns {Array<{key: string|null, text: string|null, kind: string, at: number}>} */
function getMaintenanceTurns(sessionId) {
  return stmts.forSession.all(sessionId);
}

module.exports = { recordMaintenanceTurn, getMaintenanceTurns };
