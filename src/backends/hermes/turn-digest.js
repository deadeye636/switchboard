'use strict';
// backends/hermes/turn-digest.js — a Hermes session as NEUTRAL messages (#507, the `readTurnDigest` hook).
//
// Hermes keeps its history in SQLite, not in a tail-readable file, so this reuses the reader the viewer and the
// handoff already use (`reader.readMessages`) instead of a second grammar. That reader keeps only the `user` and
// `assistant` rows with content, so tool results, reasoning and tool scaffolding never reach `text`. A tool-call
// row has no content and is dropped with them, which means `tools` stays empty for Hermes: its tool names live
// in a JSON column this reader does not decode, and a second decoder is not worth it for a name list.
//
// Cost guard (R1): `readMessages` takes a SQL `LIMIT` on the newest rows, so the work is bounded by the number
// of rows asked for, never by the store. One more row than wanted is read, which is how `partial` is known.
// Measured 2026-10-21 over a local store: a 14-message session read in under 10 ms. MAX_READ_MESSAGES is
// provisional and is checked at G2 of the #507 plan.
const reader = require('./reader');

const MAX_READ_MESSAGES = 500;

/**
 * @param {string|null} sessionId the Hermes session id (`sessions.id`)
 * @param {{ maxMessages?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ messages: Array, partial: boolean }|null>} null when the session names nothing readable
 */
async function readTurnDigest(sessionId, opts = {}) {
  const { maxMessages, signal } = opts || {};
  if (!sessionId || (signal && signal.aborted)) return null;
  const asked = Math.floor(Number(maxMessages));
  const cap = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_READ_MESSAGES) : MAX_READ_MESSAGES;
  const entries = reader.readMessages(String(sessionId), { limit: cap + 1 });
  if (!entries.length) return null;
  const partial = entries.length > cap;
  const messages = [];
  for (const e of entries.slice(-cap)) {
    const m = e && e.message;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;
    messages.push(e.timestamp ? { role: m.role, text, at: e.timestamp } : { role: m.role, text });
  }
  return { messages, partial };
}

module.exports = { readTurnDigest, MAX_READ_MESSAGES };
