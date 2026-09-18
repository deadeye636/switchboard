// backends/pi-native/rpc-protocol.js — Pi's RPC mode, spoken in Pi's words and answered in neutral ones (#568).
//
// `pi --mode rpc` takes one JSON command per line on stdin and writes responses and events to stdout. This
// file is the only place that knows what those lines mean. What leaves it is the app's own vocabulary, so
// `src/app/agent-rpc.js` can move it and the renderer can draw it without learning a Pi event name:
//
//   { op: 'reset',  entries }        the whole conversation, from `get_messages` (a mount or a reattach)
//   { op: 'append', entry }          one finished entry: a user turn, an assistant turn, a tool result
//   { op: 'partial', entry|null }    the assistant turn being streamed right now, rebuilt from deltas
//   { op: 'tool', id, status, output }  a tool call's execution: running / done / error, live output
//   { op: 'busy', busy }             the agent started or settled
//   { op: 'queue', steering, followUp }  what is waiting to be delivered
//   { op: 'notice', level, text }    something the user should read that is not a turn
//   { op: 'ask', request }           the agent (an extension) is waiting on a decision — step C of #568
//
// Entries are the same neutral shape the Message History viewer already draws, produced by Pi's own
// normaliser (`../pi/transcript-view.js`), so a live session and its history look the same and there is
// one mapping from Pi's message format, not two.
//
// Three things about the protocol that decide the code below, all measured against Pi 0.84.4 rather than
// read off its documentation:
//
//   1. `message_update` carries a DELTA and no snapshot. The partial message is assembled here by
//      `contentIndex`, and `message_end.message` replaces it as the authoritative turn.
//   2. A failed turn is not an error response. It is an assistant message with `stopReason: 'error'` and an
//      `errorMessage` — a lapsed login or an exhausted account arrives exactly like an answer with no text,
//      so it is turned into a notice here or the user sees an empty turn and nothing else.
//   3. `tool_execution_start` arrives BEFORE an extension's `tool_call` handler runs. A tool waiting on an
//      approval is therefore already "running" by the protocol's account; the ask that follows is what says
//      it is not.
'use strict';

const { normalizeTranscriptEntries } = require('../pi/transcript-view');

// One Pi AgentMessage -> the neutral entries the viewer draws (usually exactly one).
function entriesFor(message) {
  if (!message || typeof message !== 'object') return [];
  const timestamp = typeof message.timestamp === 'number' ? new Date(message.timestamp).toISOString() : undefined;
  return normalizeTranscriptEntries([{ type: 'message', timestamp, message }]);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

// Arguments stream as JSON text. Until they parse, the tool block shows what has arrived so far rather than
// an empty object — a long `write` would otherwise look like a call with no content for several seconds.
function argsFromText(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _partial: text }; }
}

// The methods an extension can open that wait for an answer (Pi's RPC doc, "Extension UI Protocol").
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

/**
 * One decoder per running session: it holds the assistant turn being streamed.
 * `decode(line)` takes one parsed stdout record and answers the ops it amounts to (often none).
 */
function createDecoder() {
  let partial = null;   // { role: 'assistant', content: [], timestamp }

  const partialOp = () => ({ op: 'partial', entry: partial ? (entriesFor(partial)[0] || null) : null });

  function onUpdate(ev) {
    if (!partial || !ev || typeof ev !== 'object') return [];
    const i = Number.isInteger(ev.contentIndex) ? ev.contentIndex : partial.content.length;
    const c = partial.content;
    switch (ev.type) {
      case 'text_start': c[i] = { type: 'text', text: '' }; break;
      case 'text_delta': if (!c[i]) c[i] = { type: 'text', text: '' }; c[i].text += ev.delta || ''; break;
      case 'text_end': c[i] = { type: 'text', text: typeof ev.content === 'string' ? ev.content : ((c[i] && c[i].text) || '') }; break;
      case 'thinking_start': c[i] = { type: 'thinking', thinking: '' }; break;
      case 'thinking_delta': if (!c[i]) c[i] = { type: 'thinking', thinking: '' }; c[i].thinking += ev.delta || ''; break;
      case 'thinking_end': c[i] = { type: 'thinking', thinking: typeof ev.content === 'string' ? ev.content : ((c[i] && c[i].thinking) || '') }; break;
      case 'toolcall_start': c[i] = { type: 'toolCall', id: ev.id, name: ev.toolName, arguments: {}, _argText: '' }; break;
      case 'toolcall_delta': {
        if (!c[i]) c[i] = { type: 'toolCall', id: null, name: '', arguments: {}, _argText: '' };
        c[i]._argText = (c[i]._argText || '') + (ev.delta || '');
        c[i].arguments = argsFromText(c[i]._argText);
        break;
      }
      case 'toolcall_end': if (ev.toolCall) c[i] = ev.toolCall; break;
      default: return [];
    }
    return [partialOp()];
  }

  function decode(msg) {
    if (!msg || typeof msg !== 'object') return [];
    switch (msg.type) {
      case 'agent_start': return [{ op: 'busy', busy: true }];
      // `agent_settled`, not `agent_end`: Pi says an `agent_end` "may still be followed by retry,
      // compaction, or queued continuations". The same reading `../pi/live-binding.js` takes (#573).
      case 'agent_settled': {
        const ops = [];
        if (partial) { partial = null; ops.push({ op: 'partial', entry: null }); }
        ops.push({ op: 'busy', busy: false });
        return ops;
      }
      case 'message_start': {
        const m = msg.message;
        if (m && m.role === 'assistant') {
          partial = { role: 'assistant', content: [], timestamp: m.timestamp };
          return [partialOp()];
        }
        return [];
      }
      case 'message_update': return onUpdate(msg.assistantMessageEvent);
      case 'message_end': {
        const m = msg.message;
        const ops = [];
        if (m && m.role === 'assistant') { partial = null; ops.push({ op: 'partial', entry: null }); }
        for (const entry of entriesFor(m)) ops.push({ op: 'append', entry });
        if (m && m.role === 'assistant' && m.stopReason === 'error') {
          ops.push({ op: 'notice', level: 'error', text: String(m.errorMessage || 'The model call failed.') });
        } else if (m && m.role === 'assistant' && m.stopReason === 'aborted') {
          ops.push({ op: 'notice', level: 'info', text: 'Stopped.' });
        }
        return ops;
      }
      case 'tool_execution_start':
        return [{ op: 'tool', id: msg.toolCallId, status: 'running', output: '' }];
      case 'tool_execution_update':
        return [{ op: 'tool', id: msg.toolCallId, status: 'running', output: textOf(msg.partialResult && msg.partialResult.content) }];
      case 'tool_execution_end':
        return [{ op: 'tool', id: msg.toolCallId, status: msg.isError ? 'error' : 'done', output: textOf(msg.result && msg.result.content) }];
      case 'queue_update':
        return [{ op: 'queue', steering: Array.isArray(msg.steering) ? msg.steering : [], followUp: Array.isArray(msg.followUp) ? msg.followUp : [] }];
      case 'compaction_start':
        return [{ op: 'notice', level: 'info', text: 'Compacting the conversation…' }];
      case 'compaction_end':
        if (msg.aborted) return [{ op: 'notice', level: 'info', text: 'Compaction stopped.' }];
        if (!msg.result) return [{ op: 'notice', level: 'error', text: `Compaction failed${msg.errorMessage ? ': ' + msg.errorMessage : '.'}` }];
        return [{ op: 'notice', level: 'info', text: 'Conversation compacted.' }];
      case 'auto_retry_start':
        return [{ op: 'notice', level: 'warning', text: `Retrying (${msg.attempt}/${msg.maxAttempts}) after: ${msg.errorMessage || 'an error'}` }];
      case 'auto_retry_end':
        return msg.success ? [] : [{ op: 'notice', level: 'error', text: `Gave up after ${msg.attempt} attempts: ${msg.finalError || 'an error'}` }];
      case 'extension_error':
        // Not `msg.error`: that is a thrown message from inside the extension, and it can name any path
        // on the machine (#444). Which event failed is enough to act on; the rest is in Pi's own log.
        return [{ op: 'notice', level: 'error', text: `An extension failed while handling ${msg.event || 'an event'}.` }];
      case 'extension_ui_request': {
        if (DIALOG_METHODS.has(msg.method)) {
          return [{
            op: 'ask',
            request: {
              id: String(msg.id),
              method: msg.method,
              title: msg.title || '',
              message: msg.message || '',
              options: Array.isArray(msg.options) ? msg.options.map(String) : [],
              placeholder: msg.placeholder || '',
              prefill: msg.prefill || '',
            },
          }];
        }
        if (msg.method === 'notify' && msg.message) {
          const level = msg.notifyType === 'error' || msg.notifyType === 'warning' ? msg.notifyType : 'info';
          return [{ op: 'notice', level, text: String(msg.message) }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  return { decode, currentPartial: () => (partial ? (entriesFor(partial)[0] || null) : null) };
}

// --- commands ---

// How a line of input reaches the agent. `mode` is the app's choice: `prompt` is a new turn, `steer`
// interrupts the running one between tool calls, `follow_up` waits until it is done. A `prompt` sent
// while the agent is streaming is REFUSED by Pi unless it says what to do, so a busy session turns a plain
// prompt into a follow-up rather than into an error.
function sendCommand({ id, text, mode, busy } = {}) {
  const message = String(text == null ? '' : text);
  if (mode === 'steer') return { id, type: 'steer', message };
  if (mode === 'follow_up') return { id, type: 'follow_up', message };
  return busy ? { id, type: 'prompt', message, streamingBehavior: 'followUp' } : { id, type: 'prompt', message };
}

const abortCommand = (id) => ({ id, type: 'abort' });
const stateCommand = (id) => ({ id, type: 'get_state' });
const messagesCommand = (id) => ({ id, type: 'get_messages' });

// The answer to an `ask`. `answer` is the app's: `{ value }` for a choice or a text, `{ confirmed }` for a
// yes/no, `{ cancelled: true }` for a dismissed dialog — the three response shapes Pi documents.
function answerCommand(requestId, answer = {}) {
  const out = { type: 'extension_ui_response', id: String(requestId) };
  if (answer.cancelled) out.cancelled = true;
  else if (typeof answer.confirmed === 'boolean') out.confirmed = answer.confirmed;
  else out.value = answer.value == null ? '' : String(answer.value);
  return out;
}

// What a `get_state` response says about identity. Only the id is used by the core.
function sessionIdFromState(response) {
  const data = response && response.data;
  return data && typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
}

function entriesFromMessages(response) {
  const messages = response && response.data && response.data.messages;
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) out.push(...entriesFor(m));
  return out;
}

module.exports = {
  createDecoder,
  sendCommand,
  abortCommand,
  stateCommand,
  messagesCommand,
  answerCommand,
  sessionIdFromState,
  entriesFromMessages,
};
