'use strict';
// backends/codex/turn-digest.js — a Codex rollout as NEUTRAL messages (#507, the `readTurnDigest` hook).
//
// Same contract as Claude's reader: the grammar stays here, grouping and caps are the core's
// (`src/session/turn-view.js`). One async read of at most MAX_TAIL_BYTES from the END of the rollout through
// `readFileTailAsync`, never the whole file and never a synchronous fs call. `partial` is the tail's, and true
// as well when `maxMessages` left older messages out.
//
// Measured over a real rollout store: the conversation is the `response_item` lines whose payload is a
// `message` (role user | assistant | developer) and whose tool calls are `function_call` / `custom_tool_call`
// items of their own, between the messages. Reasoning, tool outputs, `event_msg`, `turn_context` and every
// kind not named here are skipped, never guessed. The developer role and the injected user context (AGENTS.md,
// environment block, a stopped turn, a skill's text) are not the user's words — the parser's own test decides
// that, so a rollout's preamble is no turn 0.
const fileStore = require('../file-store');
const { messageText, looksLikeInjectedContext } = require('./parser');

function messageOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const p = entry.payload;
  if (entry.type !== 'response_item' || !p || typeof p !== 'object') return null;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    return typeof p.name === 'string' && p.name
      ? { role: 'assistant', text: '', at: entry.timestamp, tools: [p.name] }
      : null;
  }
  if (p.type !== 'message') return null;
  const text = messageText(p).trim();
  if (!text) return null;
  if (p.role === 'user') return looksLikeInjectedContext(text) ? null : { role: 'user', text, at: entry.timestamp };
  if (p.role === 'assistant') return { role: 'assistant', text, at: entry.timestamp };
  return null;
}

/** The neutral messages of a tail window, oldest first. Lines that are not JSON are skipped. */
function messagesFromTail(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    const m = messageOf(entry);
    if (m) out.push(m);
  }
  return out;
}

/**
 * @param {string|null} file the rollout's path
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
