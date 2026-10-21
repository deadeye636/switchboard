'use strict';
// backends/agy/turn-digest.js — an agy conversation as NEUTRAL messages (#507, the `readTurnDigest` hook).
//
// agy keeps one SQLite database per conversation, with the turns inside protobuf blobs. The decoder is
// `parser.readMessages` (the one the viewer and the handoff use); this module adds no grammar of its own. It
// keeps the user and model turns only: tool steps and lifecycle steps are skipped by that reader, so tool
// names are not available (`tools` stays empty) and the store has no per-turn timestamp (no `at`).
//
// Cost guard (R1): `parser.readMessages` is synchronous and always walks EVERY step of the conversation, with
// no way to stop early. So the guard is on the file size, checked with one async `stat` before the walk:
// above MAX_EXPORT_BYTES the hook declines (null) rather than stall the main process while a tool call waits.
// Measured 2026-10-21 over the five largest local conversations: 8.5 MB 49 ms, 8.8 MB 48 ms, 13.4 MB 70 ms,
// 17.2 MB 123 ms, 19.1 MB 248 ms (largest local one). MAX_EXPORT_BYTES is provisional, set to about 1.7x the
// largest measured file (a walk of roughly 0.4 s) and checked at G2 of the #507 plan.
const fs = require('fs');
const parser = require('./parser');

const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/**
 * @param {string|null} file the conversation's `.db` path
 * @param {{ maxMessages?: number, signal?: AbortSignal, maxBytes?: number }} [opts]
 * @returns {Promise<{ messages: Array, partial: boolean }|null>} null when the store is missing, empty, or
 *   above the size guard
 */
async function readTurnDigest(file, opts = {}) {
  const { maxMessages, signal } = opts || {};
  if (!file || (signal && signal.aborted)) return null;
  const maxBytes = Number(opts && opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_EXPORT_BYTES;
  let size;
  try { size = (await fs.promises.stat(file)).size; } catch { return null; }
  if (size > maxBytes) return null;
  if (signal && signal.aborted) return null;
  const entries = parser.readMessages(file);
  if (!entries.length) return null;
  const cap = Math.floor(Number(maxMessages));
  const kept = Number.isFinite(cap) && cap > 0 ? entries.slice(-cap) : entries;
  const messages = [];
  for (const e of kept) {
    const m = e && e.message;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (text) messages.push({ role: m.role, text });
  }
  return { messages, partial: kept.length < entries.length };
}

module.exports = { readTurnDigest, MAX_EXPORT_BYTES };
