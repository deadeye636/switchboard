// backends/rpc-shared.js — what the protocol translators of the runtime-driven backends share (#664).
//
// `pi-native` and `claude-native` each translate one CLI's protocol into the app's own ops. The translation
// is theirs; the few helpers that are not about either protocol live here, so a second copy cannot drift
// from the first. A backend folder may not import `src/app/`, which is why this sits beside the backends and
// not beside `src/app/agent-rpc.js`.
//
// `test/runtime-backends.test.js` refuses a runtime-driven backend's folder that defines one of these names
// again, and checks every approval it asks against `APPROVAL_ASK_KEYS`.
'use strict';

const { PARTIAL_ARGS_KEY } = require('../shared/partial-args');

/** The text of a message's content: a string as it is, or the `text` of each block joined by line breaks. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

// A tool call's arguments stream as JSON text. Until they parse, the call shows what has arrived so far
// rather than an empty object — a long write would otherwise look like a call with no content for several
// seconds. The key is `src/shared/partial-args.js`, because the viewer reads it too.
function argsFromText(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { [PARTIAL_ARGS_KEY]: text }; }
}

// A command's description as one line for the `/` list, capped: some CLIs write several paragraphs there.
function oneLineDescription(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

// Sentences both translators say in the same situation. The runtime's own words win wherever it gives any;
// these are what the user reads when it gave none.
const NOTICES = Object.freeze({
  modelFailed: 'The model call failed.',
  stopped: 'Stopped.',
  compacting: 'Compacting the conversation…',
  compacted: 'Conversation compacted.',
});

// The fields an `ask` of kind `approval` carries, whichever runtime asked: what the conversation view's
// approval card (`renderApproval`) reads, plus the `kind` that routes it there. A translator that leaves one
// out draws a card with a hole in it. The test derives the card's reads and compares them with this list.
const APPROVAL_ASK_KEYS = Object.freeze(['id', 'kind', 'tool', 'toolCallId', 'message', 'requestedBy', 'answers', 'note']);

module.exports = { textOf, argsFromText, oneLineDescription, NOTICES, APPROVAL_ASK_KEYS };
