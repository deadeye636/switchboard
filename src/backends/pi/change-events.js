'use strict';
// Pi's half of the session-changes read (#870, spec 47): it finds the edits, commits and pushes in a transcript's lines and
// feeds the neutral accumulator (`../change-events.js`). Everything Pi-specific lives here, from the shapes recorded in
// `docs/backend-formats.md` ("File edits, commits and pushes", Pi):
//   - a `message` entry whose assistant content holds a `toolCall` block: `edit` and `write` name a file in
//     `arguments.path`; `bash` carries `arguments.command`;
//   - a `message` entry with `role: "toolResult"` settles the call whose id it repeats in `toolCallId`: `isError` decides an
//     edit, the output text decides a commit (`[branch sha] subject`) and a push (ref lines), never the error flag (a chained
//     commit whose later step failed is an error result that still holds the commit line).
// Every line is read, not the active branch: Pi's transcript is a tree, and an edit on a branch the user later left still
// happened on disk. `position` is the byte offset of the RESULT line, given by the caller's cursor and asked for only when a
// result settles a call this extractor is waiting for.

const { createAccumulator, createLineCursor, MAX_PENDING } = require('../change-events');
const { gitCommandsIn, commitFrom, pushFrom } = require('../git-command-events');

const EDIT_TOOLS = new Set(['edit', 'write']);
const MAX_RESULT_CHARS = 200000;

/** The text of a result's `content`: a string, or the text blocks of an array. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      out += (out ? '\n' : '') + b.text;
      if (out.length > MAX_RESULT_CHARS) break;
    }
  }
  return out;
}

function createPiChangeExtractor() {
  const acc = createAccumulator();
  const calls = new Map(); // call id -> { edit: true } | { amend, force, commit, push }  (insertion order = age)

  const remember = (id, call) => {
    calls.delete(id);
    calls.set(id, call);
    while (calls.size > MAX_PENDING) calls.delete(calls.keys().next().value);
  };

  /** Fold one parsed transcript line; `cursor.offset()` is asked only for a line that settles a call. */
  function feed(entry, cursor) {
    if (entry.type !== 'message') return;
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') return;
    if (msg.role === 'assistant') {
      if (!Array.isArray(msg.content)) return;
      for (const b of msg.content) {
        if (!b || b.type !== 'toolCall' || typeof b.id !== 'string' || !b.arguments || typeof b.arguments !== 'object') continue;
        if (EDIT_TOOLS.has(b.name)) {
          const p = b.arguments.path;
          if (typeof p === 'string' && acc.noteEdit(p, { callId: b.id })) remember(b.id, { edit: true });
        } else if (b.name === 'bash' && typeof b.arguments.command === 'string') {
          const found = gitCommandsIn(b.arguments.command, { dialect: 'posix' });
          if (!found.length) continue;
          const call = { commit: false, push: false, amend: false, force: false };
          for (const f of found) {
            if (f.kind === 'commit') { call.commit = true; if (f.amend) call.amend = true; }
            else if (f.kind === 'push') { call.push = true; if (f.force) call.force = true; }
          }
          remember(b.id, call);
        }
      }
      return;
    }
    if (msg.role !== 'toolResult' || typeof msg.toolCallId !== 'string') return;
    const call = calls.get(msg.toolCallId);
    if (!call) return;
    calls.delete(msg.toolCallId);
    const position = cursor.offset();
    const at = Date.parse(entry.timestamp);
    const when = Number.isFinite(at) ? at : null;
    if (call.edit) {
      acc.resolve(msg.toolCallId, { error: msg.isError === true, position, at: when });
      return;
    }
    const text = resultText(msg.content);
    if (call.commit) {
      const c = commitFrom(text, { amend: call.amend });
      if (c) acc.noteCommit({ ...c, position, at: when });
    }
    if (call.push) {
      const p = pushFrom(text);
      if (p) acc.notePush({ ...p, force: call.force, position, at: when });
    }
  }

  return {
    feed,
    toRow: acc.toRow,
    get revision() { return acc.revision; },
  };
}

module.exports = { createPiChangeExtractor, createLineCursor };
