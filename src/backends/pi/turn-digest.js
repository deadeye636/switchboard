'use strict';
// backends/pi/turn-digest.js — a Pi session as NEUTRAL messages (#507, the `readTurnDigest` hook).
//
// Same contract as Claude's reader: the grammar stays here, grouping and caps are the core's
// (`src/session/turn-view.js`). One async read of at most MAX_TAIL_BYTES from the END of the session file
// through `readFileTailAsync`, never the whole file and never a synchronous fs call. `partial` is the tail's,
// and true as well when `maxMessages` left older messages out.
//
// Pi's file is a tree (`id` / `parentId`). The entries of the window go through the viewer's own
// `normalizeTranscriptEntries`, which keeps the active branch from the last entry back — inside the window,
// since the walk stops where a parent is outside it. Only a user or assistant message with text (or a tool
// call, whose NAME goes to `tools`) is a message here; tool results, thinking, bash executions, summaries,
// extension data and every unknown kind are skipped, never guessed.
const fileStore = require('../file-store');
const { normalizeTranscriptEntries } = require('./transcript-view');

function messageOf(entry) {
  if (!entry || entry.type !== 'message' || !entry.message) return null;
  const { role, content } = entry.message;
  if (role !== 'user' && role !== 'assistant') return null;
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n').trim();
  const tools = role === 'assistant'
    ? blocks.filter(b => b && b.type === 'tool_use' && typeof b.name === 'string').map(b => b.name)
    : [];
  if (!text && !tools.length) return null;
  return { role, text, at: entry.timestamp, ...(tools.length ? { tools } : {}) };
}

/** The neutral messages of a tail window, oldest first. Lines that are not JSON are skipped. */
function messagesFromTail(text) {
  const entries = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    try { entries.push(JSON.parse(raw)); } catch { /* a cut or live-written line */ }
  }
  const out = [];
  for (const e of normalizeTranscriptEntries(entries)) {
    const m = messageOf(e);
    if (m) out.push(m);
  }
  return out;
}

/**
 * @param {string|null} file the session file's path
 * @param {{ maxMessages?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ messages: Array, partial: boolean }|null>} null when the file is missing or unreadable
 */
async function readTurnDigest(file, opts = {}) {
  const { maxMessages, signal } = opts || {};
  if (!file || (signal && signal.aborted)) return null;
  let tail;
  try { tail = await fileStore.readFileTailAsync(file, fileStore.MAX_TAIL_BYTES); } catch { return null; }
  if (signal && signal.aborted) return null;
  let messages = messagesFromTail(tail.text);
  const cap = Math.floor(Number(maxMessages));
  let partial = tail.partial === true;
  if (Number.isFinite(cap) && cap > 0 && messages.length > cap) {
    messages = messages.slice(messages.length - cap);
    partial = true;   // older messages were left out here, whatever the window held
  }
  return { messages, partial };
}

module.exports = { readTurnDigest, messagesFromTail };
