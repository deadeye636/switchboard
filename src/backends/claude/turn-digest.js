'use strict';
// backends/claude/turn-digest.js — Claude's transcript as NEUTRAL messages (#507, the `readTurnDigest` hook).
//
// The hook reads the grammar and nothing else: it answers `{ messages: [{ role, text, at?, tools? }], partial }`
// and the core (`src/session/turn-view.js`) groups the messages into turns and applies every cap, so the bounds
// are the same for every backend. Claude's format stays in this folder.
//
// PERFORMANCE (binding): asked on a click, in the main process. One async read of at most MAX_TAIL_BYTES from the
// END of the transcript through `readFileTailAsync`, never the whole file and never a synchronous fs call.
// `partial` is the tail's: true when the window did not start at byte 0 (its cut first line is already dropped).
const fileStore = require('../file-store');
const { displayedLine, isTaskNotification, isPeerMessage } = require('./transcript-view');

// What a user line says in words: a string, or its text blocks. A tool result, an image or any other block is not
// the user's words and is left out.
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n');
}

function messageOf(line) {
  if (!line || typeof line !== 'object' || line.isSidechain || line.isMeta) return null;
  if (line.type === 'user') {
    if (isTaskNotification(line) || isPeerMessage(line)) return null;
    const shown = displayedLine(line);
    const text = shown ? textOf(shown.message && shown.message.content).trim() : '';
    return text ? { role: 'user', text, at: line.timestamp } : null;
  }
  if (line.type === 'assistant' && line.message && Array.isArray(line.message.content)) {
    const blocks = line.message.content;
    const text = textOf(blocks).trim();
    const tools = blocks.filter(b => b && b.type === 'tool_use' && typeof b.name === 'string').map(b => b.name);
    if (!text && !tools.length) return null;
    return { role: 'assistant', text, at: line.timestamp, ...(tools.length ? { tools } : {}) };
  }
  return null;
}

/** The neutral messages of a tail window, oldest first. Lines that are not JSON are skipped. */
function messagesFromTail(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    const m = messageOf(line);
    if (m) out.push(m);
  }
  return out;
}

/**
 * @param {string|null} file the transcript's path
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
