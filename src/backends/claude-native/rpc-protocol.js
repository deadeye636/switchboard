// backends/claude-native/rpc-protocol.js — Claude Code's stream-json protocol, spoken in Claude's words and
// answered in neutral ones (#660).
//
// `claude -p --input-format stream-json --output-format stream-json` takes one JSON line per user turn or
// control request on stdin and writes messages, stream events and control traffic to stdout. This file is the
// only place that knows what those lines mean. What leaves it is the app's own vocabulary — the ops
// `src/app/agent-rpc.js` moves and the conversation view draws, listed at the top of
// `../pi-native/rpc-protocol.js` — so neither the core nor the renderer learns a Claude event name.
//
// The entries are Claude's own transcript lines (`{ type: 'user'|'assistant', uuid, message }`), which the
// Message History viewer already draws, so a live session and its history look the same and there is no
// second mapping of Claude's message format.
//
// What the protocol does that decides the code below, all measured against Claude Code 2.1.283 rather than
// read off the SDK's source:
//
//   1. A turn line is never answered. The core writes it and takes the write as the turn's start
//      (`sendAcknowledged: false`), and `result` is its end.
//   2. A turn the core did not write still starts: a line queued behind a running turn runs after that
//      turn's `result` with nothing written in between. Every turn opens with a `system/init`, so that is
//      the busy edge for it — for a turn the core wrote, the core has already said busy and this repeats it.
//   3. The user's own line comes back only with `--replay-user-messages`, and it comes back when its turn
//      STARTS, not when it was written — so a queued follow-up is drawn where it ran, not where it was typed.
//   4. Each finished content block arrives as an `assistant` line of its own, under the uuid the transcript
//      gives the same line. So the uuid is the entry's key, unique for the conversation, and the streamed
//      partial is emptied as each block lands rather than when the model's message ends.
//   5. `/clear` answers with `conversation_reset` and then continues under a new session id; `/compact`
//      keeps the id. The id is read off every line, so either move — and a `--fork-session` launch, whose
//      first line names the fork — reaches the core as one `identity` op.
//   6. A local slash command (`/cost`, `/context`, `/login`) answers with an assistant line whose model is
//      `<synthetic>` and an ordinary `result`. It is an entry like any other, NOT a `localCommand` op — that
//      op is a `!` shell line of the core's own and is dropped for an id the core did not start.
//   7. A tool that needs an approval asks over the control channel (`control_request`, `can_use_tool`) only
//      with `--permission-prompt-tool stdio`. The answer echoes the tool's input back as `updatedInput`, which
//      is why `answerCommand` is handed the question it answers. A request the CLI withdraws
//      (`control_cancel_request`) must not be answered.
//   8. Stop (`interrupt`) is answered at once and ends the running turn with an ordinary `result` whose
//      subtype is `error_during_execution`, `is_error` set and a diagnostic line as its `errors` — the same
//      shape a turn that really failed has. So the decoder hears what the core wrote (`noteSent`) and reads
//      that result, when it follows a Stop, as the stop it is. The session takes the next turn as usual.
'use strict';

// The two answers an approval card offers in this step. "Allow for this session" needs the CLI's own
// permission suggestions, which is #661's part; until then a card offers once or refuse.
const ALLOW = 'allow';
const REFUSE = 'deny';

// What Claude is told when the user refuses a tool. The model reads it, so it says what happened.
const REFUSED_MESSAGE = 'The user refused this tool call in Switchboard.';

// A stream event, a message or a result that belongs to a subagent's own conversation carries the tool call
// that started it. Those are the subagent's, drawn under that call by Claude's history reader, not turns of
// this conversation.
const ofSubagent = (msg) => !!(msg && msg.parent_tool_use_id);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

// A tool call's arguments stream as JSON text. Until they parse, the block shows what has arrived so far
// rather than an empty object — the same answer Pi's decoder gives.
function argsFromText(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _partial: text }; }
}

// One stream line as the entry the viewer draws: Claude's own shape, and the uuid the transcript has for it.
function entryOf({ type, uuid, timestamp, message }) {
  return {
    type,
    uuid: typeof uuid === 'string' ? uuid : undefined,
    timestamp: typeof timestamp === 'string' ? timestamp : new Date().toISOString(),
    message,
  };
}

/**
 * One decoder per running session: it holds the assistant message being streamed and the session id the
 * CLI last named. `decode(line)` takes one parsed stdout record and answers the ops it amounts to.
 */
function createDecoder() {
  // The content blocks of the model message being streamed, by the index the stream gives them. A block that
  // finished has already arrived as an `assistant` line and been taken out (point 4 above).
  let partial = null;
  let sessionId = null;
  // A Stop went out and the turn it stopped has not ended yet (point 8 above). Cleared by the result that
  // ends that turn, and by a turn starting — a Stop sent while nothing ran ends nothing, and must not turn
  // the next turn's real failure into "Stopped.".
  let stopping = false;

  const partialEntry = () => {
    if (!partial) return null;
    const content = partial.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b;
      const { _argText, ...rest } = b;
      return rest;
    });
    return content.length ? { type: 'assistant', message: { role: 'assistant', content } } : null;
  };
  const partialOp = () => ({ op: 'partial', entry: partialEntry() });

  function onStreamEvent(ev) {
    if (!ev || typeof ev !== 'object') return [];
    switch (ev.type) {
      case 'message_start':
        partial = [];
        return [partialOp()];
      case 'content_block_start': {
        if (!partial) partial = [];
        const b = ev.content_block && typeof ev.content_block === 'object' ? { ...ev.content_block } : null;
        if (!b || !Number.isInteger(ev.index)) return [];
        if (b.type === 'text') b.text = typeof b.text === 'string' ? b.text : '';
        if (b.type === 'thinking') b.thinking = typeof b.thinking === 'string' ? b.thinking : '';
        if (b.type === 'tool_use') { b.input = {}; b._argText = ''; }
        partial[ev.index] = b;
        return [partialOp()];
      }
      case 'content_block_delta': {
        const b = partial && Number.isInteger(ev.index) ? partial[ev.index] : null;
        const d = ev.delta || {};
        if (!b) return [];
        if (d.type === 'text_delta' && b.type === 'text') b.text += d.text || '';
        else if (d.type === 'thinking_delta' && b.type === 'thinking') b.thinking += d.thinking || '';
        else if (d.type === 'input_json_delta' && b.type === 'tool_use') {
          b._argText += d.partial_json || '';
          b.input = argsFromText(b._argText);
        } else return [];
        return [partialOp()];
      }
      case 'message_stop':
        partial = null;
        return [{ op: 'partial', entry: null }];
      default:
        return [];
    }
  }

  // The id the CLI is on, read off any line that names one. A change is announced once, as the core's
  // `identity` op; the first id seen is announced too, and the core's re-key ignores an id it already holds.
  function followId(msg) {
    const id = msg && typeof msg.session_id === 'string' ? msg.session_id : '';
    if (!id || id === sessionId) return [];
    sessionId = id;
    return [{ op: 'identity', sessionId: id }];
  }

  function onAssistant(msg) {
    const m = msg.message;
    if (!m || typeof m !== 'object') return [];
    const ops = [];
    // The block this line carries is finished; the partial keeps only what is still being written.
    if (partial) { partial = partial.map(() => undefined); ops.push({ op: 'partial', entry: null }); }
    ops.push({ op: 'append', entry: entryOf(msg) });
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_use' && b.id) ops.push({ op: 'tool', id: b.id, status: 'running', output: '' });
    }
    // A failed model call (a lapsed login, an exhausted account) arrives as an assistant line with an
    // `error` and a sentence as its text. Said as a notice too, so it is not read as an ordinary reply.
    if (msg.error) ops.push({ op: 'notice', level: 'error', text: textOf(m.content) || 'The model call failed.' });
    return ops;
  }

  function onUser(msg) {
    const m = msg.message;
    if (!m || typeof m !== 'object' || msg.isMeta) return [];
    const ops = [{ op: 'append', entry: entryOf(msg) }];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_result' && b.tool_use_id) {
        ops.push({ op: 'tool', id: b.tool_use_id, status: b.is_error ? 'error' : 'done', output: textOf(b.content) });
      }
    }
    return ops;
  }

  function onResult(msg) {
    const ops = [];
    if (partial) { partial = null; ops.push({ op: 'partial', entry: null }); }
    const stopped = stopping && msg.subtype === 'error_during_execution';
    stopping = false;
    if (stopped) {
      ops.push({ op: 'notice', level: 'info', text: 'Stopped.' });
    } else if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
      // `errors` is the CLI's own sentences about what went wrong; `result` is the reply text, which for a
      // failed turn is usually the same sentence. Neither is a thrown message naming a path.
      const why = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.map(String).join(' ')
        : (typeof msg.result === 'string' && msg.result ? msg.result : '');
      ops.push({ op: 'notice', level: 'error', text: why || 'The turn ended with an error.' });
    }
    ops.push({ op: 'busy', busy: false });
    return ops;
  }

  function onSystem(msg) {
    switch (msg.subtype) {
      // Every turn opens with it — the busy edge for a turn nothing of ours started (point 2 above).
      case 'init': stopping = false; return [{ op: 'busy', busy: true }];
      case 'status':
        return msg.status === 'compacting' ? [{ op: 'notice', level: 'info', text: 'Compacting the conversation…' }] : [];
      case 'compact_boundary':
        return [{ op: 'notice', level: 'info', text: 'Conversation compacted.' }];
      case 'api_retry':
        return [{ op: 'notice', level: 'warning', text: 'The model call failed and is being retried.' }];
      case 'permission_denied':
        return [{ op: 'notice', level: 'warning', text: `A ${msg.tool_name ? `${msg.tool_name} ` : ''}call was refused by the permission rules.` }];
      default:
        return [];
    }
  }

  function onControlRequest(msg) {
    const r = msg.request || {};
    if (r.subtype !== 'can_use_tool' || msg.request_id == null) return [];
    return [{
      op: 'ask',
      request: {
        id: String(msg.request_id),
        kind: 'approval',
        tool: String(r.tool_name || ''),
        toolCallId: r.tool_use_id ? String(r.tool_use_id) : '',
        method: 'select',
        title: '',
        // Claude's own words about the call, where it gave some (a Bash call's description).
        message: typeof r.description === 'string' ? r.description : '',
        requestedBy: '',
        options: [],
        answers: { once: ALLOW, refuse: REFUSE },
        // What this question is worth, for the card: Claude asks it under its own permission rules, the same
        // question its terminal would put, and a tool its rules allow never reaches this card.
        note: 'Claude Code asks this under its own permission rules, as it would in a terminal.',
        // Kept for the answer: an allow hands the tool's input back as `updatedInput` (point 7 above).
        input: r.input && typeof r.input === 'object' ? r.input : {},
      },
    }];
  }

  function decode(msg) {
    if (!msg || typeof msg !== 'object') return [];
    if (ofSubagent(msg)) return [];
    const ops = followId(msg);
    switch (msg.type) {
      case 'stream_event': return ops.concat(onStreamEvent(msg.event));
      case 'assistant': return ops.concat(onAssistant(msg));
      case 'user': return ops.concat(onUser(msg));
      case 'result': return ops.concat(onResult(msg));
      case 'system': return ops.concat(onSystem(msg));
      case 'control_request': return ops.concat(onControlRequest(msg));
      case 'control_cancel_request':
        return msg.request_id == null ? ops : ops.concat([{ op: 'answered', id: String(msg.request_id) }]);
      case 'conversation_reset':
        // `/clear`: the conversation on screen is over. The new id arrives on the next line.
        partial = null;
        return ops.concat([{ op: 'partial', entry: null }, { op: 'reset', entries: [] }]);
      default:
        return ops;
    }
  }

  // A line the core wrote. Only a Stop matters here (point 8 above).
  function noteSent(line) {
    if (line && line.type === 'control_request' && line.request && line.request.subtype === 'interrupt') stopping = true;
  }

  return { decode, noteSent, currentPartial: partialEntry };
}

// --- commands ---

// How a line of input reaches the agent (M8 of the plan). `prompt` is a turn of its own — queued by the CLI
// behind a running one, which is what a plain line written while it runs does anyway. `steer` goes into the
// running turn at its next tool boundary (`next`); `follow_up` waits until it is done (`later`). Claude's
// third priority, `now`, cuts the running turn off and is not offered.
const PRIORITIES = { steer: 'next', follow_up: 'later' };
function sendCommand({ text, mode } = {}) {
  const line = {
    type: 'user',
    message: { role: 'user', content: String(text == null ? '' : text) },
    parent_tool_use_id: null,
    session_id: '',
  };
  if (PRIORITIES[mode]) line.priority = PRIORITIES[mode];
  return line;
}

const control = (id, request) => ({ type: 'control_request', request_id: String(id), request });

// Stop is a control request, not a signal: the turn ends and the process stays.
const abortCommand = (id) => control(id, { subtype: 'interrupt' });

// The commands a `/` can complete to. `initialize` answers them, and it may be sent again (measured: two in a
// row both answered, before and without a turn), so asking for the list is asking it once more. Nothing else
// in the protocol lists them with their descriptions.
const commandsCommand = (id) => control(id, { subtype: 'initialize' });

function commandsFromResponse(response) {
  const list = response && response.data && response.data.commands;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
      kind: 'command',
      arguments: false,
    });
  }
  return out;
}

// The answer to an approval (`ask`). `answer` is the app's: `{ value }` with one of the card's answers, or
// `{ cancelled: true }` for a card dismissed without one, which refuses — a tool nobody allowed does not run.
function answerCommand(requestId, answer = {}, ask = null) {
  const allowed = !answer.cancelled && answer.value === ALLOW;
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: String(requestId),
      response: allowed
        ? { behavior: 'allow', updatedInput: (ask && ask.input && typeof ask.input === 'object') ? ask.input : {} }
        : { behavior: 'deny', message: REFUSED_MESSAGE },
    },
  };
}

// Which line answers a request of the core's: a `control_response` under the `request_id` it was sent with.
// A refusal carries `subtype: 'error'` and the CLI's sentence.
function responseOf(msg) {
  if (!msg || msg.type !== 'control_response' || !msg.response || typeof msg.response !== 'object') return null;
  const r = msg.response;
  if (r.request_id == null) return null;
  return r.subtype === 'success'
    ? { id: String(r.request_id), payload: { success: true, data: r.response || {} } }
    : { id: String(r.request_id), payload: { success: false, error: typeof r.error === 'string' && r.error ? r.error : 'refused' } };
}

// What an attach draws from the transcript file: the lines of this conversation that the stream sends as
// entries too — user and assistant turns, not a subagent's, not the CLI's own bookkeeping (`isMeta`). The
// file holds more kinds of line (attachments, queue operations, titles), which the history viewer shows and
// a live conversation never sends; keeping them out is what makes a mounted view read like a live one.
function conversationEntries(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || (line.type !== 'user' && line.type !== 'assistant')) continue;
    if (line.isSidechain || line.isMeta || !line.message || typeof line.uuid !== 'string') continue;
    out.push(line);
  }
  return out;
}

// The key the core stamps on an `append` and an attach answers for its snapshot: the line's uuid, which the
// stream and the transcript share (point 4 above).
const entryKey = (entry) => (entry && typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : null);

module.exports = {
  createDecoder,
  responseOf,
  sendCommand,
  abortCommand,
  commandsCommand,
  commandsFromResponse,
  answerCommand,
  conversationEntries,
  entryKey,
  ALLOW,
  REFUSE,
};
