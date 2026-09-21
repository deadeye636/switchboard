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
//   { op: 'notice', level, text, links? }  something the user should read that is not a turn; `links` are
//                                    pages to open (`[{ url, label }]`, a login page — #642)
//   { op: 'ask', request }           the agent (an extension) is waiting on a decision — step C of #568;
//                                    `request.secret` asks for a masked field (an API key, #642);
//                                    `request.lasting` says it belongs to a command, not to a run, so a run
//                                    settling does not end it
//   { op: 'answered', id }           the runtime stopped waiting on a question without an answer from us
//   { op: 'figures' }                the user asked the session what it has cost so far (#643). It carries
//                                    no numbers: the core answers it by sending `statsCommand` and drawing
//                                    `statsNotice`, so the shape of those figures stays in this file
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
const { parseApprovalTitle, CHOICES } = require('./runtime-extension');
const { parseLink, parseAskTitle, parseDismiss, parseCompletions, parseStats, COMPLETE_COMMAND, ARGUMENT_COMMANDS, TUI_ONLY } = require('./session-commands');

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
  // A question a session command asked (`./session-commands.js`) -> the request id it went out under, so Pi
  // saying it stopped waiting on it can close the card for it. An entry left behind by a question the
  // user answered names a request that is already closed, so it is harmless; the map is only bounded.
  const questionTokens = new Map();
  // Answers to argument-completion requests (`argumentsCommand`), by the token the request carried. The
  // answer arrives as a notice BEFORE Pi's response to the request, so the core reads it here when the
  // response lands. Taken once; bounded in case a request's reader has already given up.
  const completions = new Map();

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
        if (!msg.result) {
          // Pi's own message already says so ("Compaction failed: Nothing to compact…"), measured on 0.84.4.
          const why = String(msg.errorMessage || '');
          return [{ op: 'notice', level: 'error', text: !why ? 'Compaction failed.' : /^compaction failed/i.test(why) ? why : `Compaction failed: ${why}` }];
        }
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
          // OUR approval question (./runtime-extension.js) is drawn as an approval: the app shows the call
          // it is about, from the conversation it already holds, and answers with one of three values.
          const approval = msg.method === 'select' ? parseApprovalTitle(msg.title) : null;
          if (approval) {
            return [{
              op: 'ask',
              request: {
                id: String(msg.id),
                kind: 'approval',
                tool: approval.tool,
                toolCallId: approval.id,
                method: 'select',
                title: '',
                // What the call allows beyond its own input, where the gate could say (a delegation's agent:
                // its tools and model). Plain text for the card; empty for every other tool.
                message: approval.detail || '',
                // Who is asking when it is not the agent's own call — a command the user ran (#632).
                requestedBy: approval.by || '',
                options: [],
                answers: { once: CHOICES.once, session: CHOICES.session, refuse: CHOICES.refuse },
              },
            }];
          }
          // A session command's own question (`./session-commands.js`): its real title, whether the field is
          // a secret (an API key is drawn masked), and the token Pi's "stopped waiting" notice will name. It is
          // `lasting`: it belongs to a command, not to a run, so a run settling does not end it — Pi keeps
          // waiting on it until it is answered, dismissed or taken back.
          const own = msg.method === 'select' || msg.method === 'input' ? parseAskTitle(msg.title) : null;
          if (own) {
            if (questionTokens.size > 64) questionTokens.clear();   // a bound, not a cache: a login asks a few
            questionTokens.set(own.token, String(msg.id));
            return [{
              op: 'ask',
              request: {
                id: String(msg.id),
                method: msg.method,
                title: own.title,
                message: '',
                options: msg.method === 'select' && Array.isArray(msg.options) ? msg.options.map(String) : [],
                placeholder: msg.placeholder || '',
                prefill: '',
                secret: msg.method === 'input' && own.secret,
                lasting: true,
              },
            }];
          }
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
          // Pi stopped waiting on a session command's question (its login's browser callback won the race):
          // RPC mode tells the client nothing of its own, so the card is closed on this word instead.
          const answered = parseCompletions(msg.message);
          if (answered) {
            if (completions.size > 16) completions.clear();
            completions.set(answered.token, answered.items);
            return [];
          }
          const token = parseDismiss(msg.message);
          if (token) {
            const id = questionTokens.get(token);
            questionTokens.delete(token);
            return id ? [{ op: 'answered', id }] : [];
          }
          // `/session` was typed. The command carries no figures on purpose — the core asks for them with
          // `statsCommand` below, which is the one documented way to them (#643, W3).
          if (parseStats(msg.message)) return [{ op: 'figures' }];
          const level = msg.notifyType === 'error' || msg.notifyType === 'warning' ? msg.notifyType : 'info';
          // A page to open — a login page, a device-code page. Drawn with a button rather than as the URL.
          const link = parseLink(msg.message);
          if (link) {
            if (!link.url) return link.text ? [{ op: 'notice', level, text: link.text }] : [];
            return [{ op: 'notice', level, text: link.text, links: [{ url: link.url, label: link.label }] }];
          }
          return [{ op: 'notice', level, text: String(msg.message) }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  function takeCompletions(token) {
    const items = completions.get(String(token));
    completions.delete(String(token));
    return items || null;
  }

  return { decode, takeCompletions, currentPartial: () => (partial ? (entriesFor(partial)[0] || null) : null) };
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
const commandsCommand = (id) => ({ id, type: 'get_commands' });

// What a `/` in the input can complete to (A1): Pi's own list of extension commands, prompt templates and
// skills, in the app's words. `kind` is `command`, `template` or `skill`; `arguments` says the app may ask
// for the argument's completions too (A2) — only while the internal command that answers is registered, or
// the app's question would reach the model as a prompt. That command is not offered, and neither are the
// lines standing in for Pi's terminal-only commands: they only say the thing is not here.
const KINDS = { extension: 'command', prompt: 'template', skill: 'skill' };
function commandsFromResponse(response) {
  const list = response && response.data && response.data.commands;
  if (!Array.isArray(list)) return [];
  const answers = list.some(c => c && c.source === 'extension' && c.name === COMPLETE_COMMAND);
  const out = [];
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name || c.name === COMPLETE_COMMAND) continue;
    if (c.source === 'extension' && Object.prototype.hasOwnProperty.call(TUI_ONLY, c.name)) continue;
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
      kind: KINDS[c.source] || 'command',
      arguments: answers && c.source === 'extension' && ARGUMENT_COMMANDS.includes(c.name),
    });
  }
  return out;
}

// Ask the session what one command takes as an argument. A prompt that runs the extension's internal
// command: Pi runs an extension command at once, even while a turn is streaming, and it reaches neither the
// model nor the transcript. The answer is read with `decoder.takeCompletions(token)`.
function argumentsCommand(id, { command, token } = {}) {
  return { id, type: 'prompt', message: `/${COMPLETE_COMMAND} ${JSON.stringify({ command: String(command || ''), token: String(token || '') })}` };
}
const stateCommand = (id) => ({ id, type: 'get_state' });
const messagesCommand = (id) => ({ id, type: 'get_messages' });

// --- the session's own figures (#643, `/session`) ---

// Pi's documented `get_session_stats`. Its answer is `SessionStats`: message counts, the four token
// counts and their total, the cost, and an optional context reading.
const statsCommand = (id) => ({ id, type: 'get_session_stats' });

// A capacity may be rounded; a figure that is part of a sum may NOT, or the parts stop adding up to the
// total in front of the reader (10 500 + 10 500 = 21 000 prints as "21k (11k, 11k)").
const roundCapacity = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : String(n));
const spend = (n) => '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

/**
 * `statsCommand`'s answer as a notice — `{ level, text }`. An answer that did not arrive is a notice too,
 * at `warning`: a command that says nothing at all reads as one that did not run.
 *
 * The wording names Pi, and that is a decision rather than politeness: these are the runtime's own
 * counters for the session it is running, while the app's statistics view counts the same session from
 * its transcript. The two are close and need not agree — a turn Pi has not written out yet is in one and
 * not the other — and a figure with no source beside a figure with a different source is how somebody
 * spends an afternoon looking for a bug in the arithmetic.
 *
 * NOTHING HERE IS WORDED AS A PARTITION, because Pi's counts are not one. `totalMessages` counts every
 * message entry it holds — a tool result, a bash execution, a compaction summary — while `userMessages`
 * and `assistantMessages` count two of those kinds, and `toolCalls` counts invocations rather than
 * messages at all. In a plain session the numbers look like a breakdown and happen to reconcile; one
 * `/compact` or one shell line later they do not, and a sentence that promised a breakdown would then be
 * the thing at fault rather than the arithmetic.
 */
function statsNotice(response) {
  const d = response && response.success !== false ? response.data : null;
  if (!d || typeof d !== 'object') {
    return { level: 'warning', text: 'Pi did not report the session\'s figures.' };
  }
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const t = d.tokens && typeof d.tokens === 'object' ? d.tokens : {};
  const parts = [
    plural(n(d.totalMessages), 'message') + ', ' + n(d.userMessages) + ' of them yours and '
      + n(d.assistantMessages) + ' the agent\'s',
    plural(n(d.toolCalls), 'tool call'),
    n(t.total) + ' tokens (' + n(t.input) + ' in, ' + n(t.output)
      + ' out, ' + n(t.cacheRead) + ' read from cache, ' + n(t.cacheWrite) + ' written to it)',
    spend(n(d.cost)),
  ];
  // Only while Pi has a reading: right after a compaction it answers one whose tokens and percent are
  // null, until the next turn fills them in again.
  const usage = d.contextUsage;
  if (usage && Number.isFinite(usage.percent) && Number.isFinite(usage.contextWindow)) {
    parts.push(Math.round(usage.percent) + ' % of a ' + roundCapacity(usage.contextWindow) + ' context window');
  }
  return { level: 'info', text: 'As Pi counts this session: ' + parts.join(' · ') + '.' };
}

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
  commandsCommand,
  commandsFromResponse,
  argumentsCommand,
  stateCommand,
  messagesCommand,
  statsCommand,
  statsNotice,
  answerCommand,
  sessionIdFromState,
  entriesFromMessages,
};
