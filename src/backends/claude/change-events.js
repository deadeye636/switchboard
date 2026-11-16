'use strict';
// Claude's half of the session-changes read (#870, spec 47): it finds the edits, commits and pushes in a transcript's
// lines and feeds the neutral accumulator (`../change-events.js`). Everything Claude-specific lives here: the tool names,
// the path field each one uses, where a tool's result and a shell command's output sit, and the line types that count.
//
// What it reads, from the shapes recorded in `docs/backend-formats.md` ("File edits, commits and pushes"):
//   - an `assistant` line's `tool_use` block: Edit / Write / MultiEdit (`input.file_path`) and NotebookEdit
//     (`input.notebook_path`) name a file; Bash / PowerShell carry `input.command`;
//   - a `user` line's `tool_result` block settles the call it names: `is_error` decides an edit, the output text decides a
//     commit (`[branch sha] subject`) and a push (ref lines), never the error flag (a chained commit whose push was refused
//     is an error result that still holds the commit line).
// Only `user` and `assistant` lines are read: an `api-request-blob` line repeats the result and would count twice.
// `position` is the byte offset of the RESULT line (the line that proves the call ran), given by the caller's cursor, and it
// is asked for only when a result settles a call this extractor is waiting for.

const { createAccumulator, MAX_PENDING } = require('../change-events');
const { gitCommandsIn, commitFrom, pushFrom } = require('../git-command-events');

const EDIT_PATH_FIELD = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const SHELL_TOOLS = { Bash: 'posix', PowerShell: 'powershell' };
const MAX_RESULT_CHARS = 200000;

/** The text of a `tool_result`'s content: a string, or the text blocks of an array. */
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

function createClaudeChangeExtractor() {
  const acc = createAccumulator();
  const calls = new Map(); // call id -> { edit: true } | { amend, force, commit, push }  (insertion order = age)

  const remember = (id, call) => {
    calls.delete(id);
    calls.set(id, call);
    while (calls.size > MAX_PENDING) calls.delete(calls.keys().next().value);
  };

  /**
   * Fold one parsed transcript line. `cursor.offset()` is the byte offset of this line; it is called only for a line that
   * settles a call, so a transcript without edits costs no offset work.
   */
  function feed(entry, cursor) {
    const type = entry.type;
    if (type !== 'assistant' && type !== 'user') return;
    const msg = entry.message;
    const content = msg && msg.content;
    if (!Array.isArray(content)) return;
    if (type === 'assistant') {
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || typeof b.id !== 'string' || !b.input || typeof b.input !== 'object') continue;
        const field = EDIT_PATH_FIELD[b.name];
        if (field) {
          const p = b.input[field];
          if (typeof p === 'string' && acc.noteEdit(p, { callId: b.id })) remember(b.id, { edit: true });
          continue;
        }
        const dialect = SHELL_TOOLS[b.name];
        if (dialect && typeof b.input.command === 'string') {
          const found = gitCommandsIn(b.input.command, { dialect });
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
    for (const b of content) {
      if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const call = calls.get(b.tool_use_id);
      if (!call) continue;
      calls.delete(b.tool_use_id);
      const position = cursor.offset();
      const at = Date.parse(entry.timestamp);
      const when = Number.isFinite(at) ? at : null;
      if (call.edit) {
        acc.resolve(b.tool_use_id, { error: b.is_error === true, position, at: when });
        continue;
      }
      const text = resultText(b.content);
      if (call.commit) {
        const c = commitFrom(text, { amend: call.amend });
        if (c) acc.noteCommit({ ...c, position, at: when });
      }
      if (call.push) {
        const p = pushFrom(text);
        if (p) acc.notePush({ ...p, force: call.force, position, at: when });
      }
    }
  }

  return {
    feed,
    toRow: acc.toRow,
    get revision() { return acc.revision; },
  };
}

/**
 * A cursor over the lines of a Buffer, for the byte offset of the n-th non-empty line (the same lines
 * `text.split('\n').filter(Boolean)` yields). `base` is the file offset of the buffer's first byte. It walks the raw
 * bytes with `indexOf(0x0A)` and only as far as the last line asked for, and never re-encodes a line.
 */
function createLineCursor(buf, base) {
  let pos = 0;
  let line = -1;
  let start = 0;
  const cursor = {
    index: 0,
    offset() {
      while (line < cursor.index) {
        while (pos < buf.length && buf[pos] === 0x0A) pos++;
        start = pos;
        let end = buf.indexOf(0x0A, pos);
        if (end === -1) end = buf.length;
        pos = end;
        line++;
      }
      return base + start;
    },
  };
  return cursor;
}

module.exports = { createClaudeChangeExtractor, createLineCursor };
