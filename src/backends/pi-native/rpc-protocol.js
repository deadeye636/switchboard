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
//   { op: 'exportFile', args }       the user asked for a file of this session (#643). `args` is the file
//                                    they named, or '' — the core decides the path and sends
//                                    `exportCommand`, because where a file the app produced belongs is
//                                    not a question about the runtime
//   { op: 'lastReply' }              the user asked for the agent's last reply as text (#643), to put on
//                                    the clipboard. The core sends `lastReplyCommand`, does the copying,
//                                    and draws `copiedNotice`
//   { op: 'shell', command }         the user asked to run a shell line (#643, a `!` line). The core sends
//                                    `shellCommand` and the runtime runs it, so the output joins the
//                                    session's own context
//   { op: 'branchTree' }             the user asked for the session's branch tree (#646). The core sends
//                                    `treeCommand` and hands the view what `treeRows` makes of the answer
//   { op: 'navigated', token, … }    the move the app asked for (`navigateCommand`) is done, refused or
//                                    cancelled; `draft` is a user message handed back for editing
//   { op: 'localCommand', id, … }    a shell line the user ran: `command` when it starts, `output` as it
//                                    grows, `status` running/done/error/cancelled. Keyed by `id` because a
//                                    shell line and an assistant turn can be live AT ONCE (measured), so
//                                    this cannot share the `partial` slot with one
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
const { parseLink, parseAskTitle, parseDismiss, parseCompletions, parseStats, parseExport, parseCopy, parseShell, parseTree, parseNavigated, describeFailure, MESSAGE_CAP, COMPLETE_COMMAND, NAVIGATE_COMMAND, ARGUMENT_COMMANDS, TUI_ONLY } = require('./session-commands');

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
  // What a shell line (`!cmd`) has written so far, by the id its request went out under. The growing text
  // is accumulated HERE rather than in the renderer: a view that re-mounts mid-command would otherwise
  // have to rebuild it from deltas it never saw. Bounded both ways — the map because a session can run
  // many lines, and each string because a command can write megabytes and only the app's screen reads
  // this. The FINAL output is the runtime's own (`shellResult`), truncation marker and all, so a live
  // view that kept the tail is corrected the moment the command ends.
  const shellOutput = new Map();
  const LIVE_OUTPUT_CAP = 200000;

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
      // A shell line the user ran writes here as it goes. It is NOT a tool call — no tool block exists to
      // attach it to — so it gets an op of its own, keyed by the id the `bash` request carried.
      case 'bash_execution_update': {
        const id = String(msg.id == null ? '' : msg.id);
        if (!id) return [];
        if (shellOutput.size > 8 && !shellOutput.has(id)) shellOutput.clear();
        let output = (shellOutput.get(id) || '') + String(msg.delta == null ? '' : msg.delta);
        if (output.length > LIVE_OUTPUT_CAP) output = output.slice(output.length - LIVE_OUTPUT_CAP);
        shellOutput.set(id, output);
        return [{ op: 'localCommand', id, status: 'running', output }];
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
          // `/export` and `/copy`, the same way: the command says only that it was typed, and the core
          // answers over the protocol below. Neither carries a path or any text.
          const asked = parseExport(msg.message);
          if (asked) return [{ op: 'exportFile', args: asked.args }];
          if (parseCopy(msg.message)) return [{ op: 'lastReply' }];
          // A `!` line, caught by the extension's `input` hook rather than by a command.
          const shell = parseShell(msg.message);
          if (shell) return [{ op: 'shell', command: shell.command }];
          // `/tree` (#646): the tree is asked for over RPC. And the answer to a move the app asked for.
          if (parseTree(msg.message)) return [{ op: 'branchTree' }];
          const moved = parseNavigated(msg.message);
          if (moved) return [{ op: 'navigated', ...moved }];
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
    if (!c || typeof c.name !== 'string' || !c.name || c.name === COMPLETE_COMMAND || c.name === NAVIGATE_COMMAND) continue;
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

// --- a file of the session (#643, `/export`) ---

// Pi's documented `export_html`. The `outputPath` is not optional HERE although it is in the protocol:
// without one Pi writes beside its own working directory and answers a RELATIVE name (measured on
// 0.85.1: `pi-session-<stamp>_<id>.html`, and the file landed in the project). A file appearing in
// somebody's repository because they asked a session to export itself is not an answer to what they
// asked, so the core names the path and this always carries it.
const exportCommand = (id, { outputPath } = {}) => ({ id, type: 'export_html', outputPath: String(outputPath || '') });

/**
 * What the file is CALLED. The core names the directory it goes in and this names the file, because the
 * format is the runtime's: Pi exports HTML, and a core that spelled `.html` would have learned one
 * runtime's answer to a question it is not allowed to know.
 *
 * `hint` is whatever the core can say about the session; anything that is not plainly a filename is
 * dropped rather than escaped, because a name assembled out of someone else's string is how a path
 * segment stops being one.
 */
function exportFileName(hint) {
  const safe = String(hint == null ? '' : hint).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `pi-session-${safe || 'unnamed'}-${stamp}.html`;
}

/**
 * `exportCommand`'s answer as a notice — `{ level, text, path }`. `path` is the file the runtime says it
 * wrote, and the core offers to open it; a notice without one is still a notice, so a runtime that
 * answers success and says nothing does not read as a command that did not run.
 *
 * The runtime's own refusal is the actionable part and is passed on, through `describeFailure` for the
 * same reason every other message from it is (#444): Pi words some of these itself, and one of them
 * ("Nothing to export yet - start a conversation first") is exactly what the user needs to read.
 */
function exportNotice(response) {
  if (!response || response.success === false) {
    return { level: 'error', text: 'The session was not written: ' + describeFailure({ message: response && response.error }, MESSAGE_CAP) };
  }
  const p = response.data && typeof response.data.path === 'string' ? response.data.path : '';
  if (!p) return { level: 'warning', text: 'Pi wrote the session but did not say where.' };
  return { level: 'info', text: 'Session written to ' + p, path: p };
}

// --- the agent's last reply (#643, `/copy`) ---

// Pi's documented `get_last_assistant_text`. It answers `{ text: null }` for a session the agent has not
// replied in yet, which is a real answer and not a failure.
const lastReplyCommand = (id) => ({ id, type: 'get_last_assistant_text' });

/**
 * The last assistant turn as text — and THREE answers, not two, because collapsing the last into the
 * middle one is a sentence that lies to the reader:
 *
 *   a string   the reply
 *   null       there is no reply yet. A real answer: a session nobody has been answered in.
 *   undefined  the request was not answered at all — a timeout, a child that has exited. Saying "no
 *              reply yet" about a session full of replies is the one wrong thing this can print, so it
 *              is a case of its own. `statsNotice` and `exportNotice` both word an unanswered request
 *              rather than staying silent about it; this is the same rule one command along.
 */
function lastReplyText(response) {
  if (!response || response.success === false) return undefined;
  const d = response.data;
  const text = d && typeof d.text === 'string' ? d.text : '';
  return text ? text : null;
}

/**
 * What to say once the app has TRIED to copy. `copied` is the app's own answer, because the clipboard
 * belongs to the machine rather than to the session — this file words the sentence, the core performs
 * the act, and neither does both.
 */
function copiedNotice({ text, copied } = {}) {
  if (text === undefined) return { level: 'warning', text: 'Pi did not answer, so nothing was copied.' };
  if (text === null) return { level: 'info', text: 'The agent has not replied in this session yet, so there is nothing to copy.' };
  if (!copied) return { level: 'error', text: 'The reply could not be put on the clipboard.' };
  return { level: 'info', text: 'The agent\'s last reply is on the clipboard (' + plural(String(text).split('\n').length, 'line') + ').' };
}

// --- a shell line the user ran (#643, a `!` line) ---

// Pi's documented `bash`. The runtime runs it and books a `BashExecutionMessage` into the session, which
// is the whole reason for going through the protocol rather than running a child here: the next prompt
// carries the output to the model, exactly as it does in Pi's terminal interface.
const shellCommand = (id, { command } = {}) => ({ id, type: 'bash', command: String(command || '') });

// Pi's documented `abort_bash`. It takes no id — the runtime runs one shell line at a time — and it is
// the ONLY thing that stops one: measured on 0.85.1, a plain `abort` answers success and the command
// runs to completion with `cancelled: false`, because `abort` is about the agent's turn and a shell line
// is not one.
const shellAbortCommand = (id) => ({ id, type: 'abort_bash' });

/**
 * `shellCommand`'s answer as the final state of that line — `{ status, output }`.
 *
 * The output is worded the way the Message History viewer words the same execution when it reads it back
 * out of the transcript (`../pi/transcript-view.js`): the text, then the exit code, then the truncation
 * marker. A live line and the same line re-read after a re-mount then look alike, which is the point of
 * building it here rather than in the renderer.
 *
 * A CANCELLED line KEEPS what it had already printed — measured on 0.85.1 by stopping a command that
 * was writing at the time, and the reply carried every line of it. An earlier reading said the opposite
 * and was taken from a command that had printed nothing when it was stopped, where an empty answer means
 * "there was nothing", not "it was thrown away". So the marker says the line was stopped and the output
 * above it stands.
 */
function shellResult(response) {
  if (!response || response.success === false) {
    // "did not finish", not "was not run": the commonest way to land here is the session ending while the
    // line was running, and it HAD run. Whether it started at all is not knowable from this answer.
    return { status: 'error', output: 'The shell line did not finish: ' + describeFailure({ message: response && response.error }, MESSAGE_CAP) };
  }
  const d = response.data && typeof response.data === 'object' ? response.data : {};
  const status = d.cancelled ? 'cancelled' : (d.exitCode ? 'error' : 'done');
  // `[cancelled]`, not a word of this file's own: the history reader spells the SAME execution that way
  // when it reads it back out of the transcript, and a line that says one thing live and another after a
  // re-mount is the drift this wording exists to avoid. `test/pi-source-agents`-style pinning is done in
  // `test/pi-native-session-commands.test.js`, which asserts the two against each other.
  const parts = [
    String(d.output == null ? '' : d.output),
    d.cancelled ? '[cancelled]' : (d.exitCode == null ? '' : `[exit ${d.exitCode}]`),
    d.truncated ? '[truncated]' : '',
  ].filter(Boolean);
  return { status, output: parts.join('\n') };
}

// --- the session's branch tree (#646, `/tree`) ---

// Pi's documented `get_tree`: `{ tree, leafId }`, where a node is `{ entry, children, label? }` and a root
// may be a settings entry rather than a message.
const treeCommand = (id) => ({ id, type: 'get_tree' });

// More rows than anybody reads in a dialog, and a bound on what one answer can put on the IPC.
const TREE_ROWS_CAP = 2000;
const TREE_TEXT_CAP = 200;

const oneLine = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
const clip = (t) => { const v = oneLine(t); return v.length > TREE_TEXT_CAP ? v.slice(0, TREE_TEXT_CAP - 1) + '…' : v; };

// What one of Pi's entries is, in the app's words: `kind` is user / assistant / tool / summary / setting /
// other, `text` a one-line preview. `null` for an entry the tree does not show at all.
function treeEntry(entry, isLeaf) {
  if (!entry || typeof entry !== 'object') return null;
  switch (entry.type) {
    case 'message': {
      const m = entry.message || {};
      switch (m.role) {
        case 'user': return { kind: 'user', text: clip(textOf(m.content)) };
        case 'assistant': {
          const text = clip(textOf((Array.isArray(m.content) ? m.content : []).filter(c => c && c.type === 'text')));
          if (text) return { kind: 'assistant', text };
          // Pi's own tree hides a turn that only called tools — the calls' results carry what happened —
          // unless it failed or was stopped, or the session is standing on it.
          if (m.stopReason === 'error') return { kind: 'assistant', text: clip(m.errorMessage || 'The model call failed.') };
          if (m.stopReason === 'aborted') return { kind: 'assistant', text: 'Stopped.' };
          const calls = (Array.isArray(m.content) ? m.content : []).filter(c => c && c.type === 'toolCall').map(c => c.name).filter(Boolean);
          return isLeaf ? { kind: 'assistant', text: calls.length ? 'Called ' + calls.join(', ') : '' } : null;
        }
        case 'toolResult': return { kind: 'tool', text: clip((m.toolName ? m.toolName + ': ' : '') + textOf(m.content)) };
        case 'bashExecution': return { kind: 'tool', text: clip('! ' + (m.command || '')) };
        case 'branchSummary': return { kind: 'summary', text: clip(m.summary || 'A summary of a branch left behind') };
        case 'compactionSummary': return { kind: 'summary', text: clip(m.summary || 'The conversation, compacted') };
        default: return { kind: 'other', text: clip(textOf(m.content)) };
      }
    }
    case 'branch_summary': return { kind: 'summary', text: clip(entry.summary || 'A summary of a branch left behind') };
    case 'compaction': return { kind: 'summary', text: clip(entry.summary || 'The conversation, compacted') };
    case 'custom_message': return { kind: 'other', text: clip(textOf(entry.content)) };
    case 'model_change': return { kind: 'setting', text: clip('Model: ' + [entry.provider, entry.modelId].filter(Boolean).join('/')) };
    case 'thinking_level_change': return { kind: 'setting', text: clip('Thinking: ' + (entry.thinkingLevel || '')) };
    case 'session_info': return { kind: 'setting', text: clip('Session name: ' + (entry.name || '')) };
    case 'label': return { kind: 'setting', text: clip('Label: ' + (entry.label || '(removed)')) };
    case 'custom': return { kind: 'setting', text: clip(entry.customType || 'An extension\'s entry') };
    default: return { kind: 'other', text: clip(entry.type || '') };
  }
}

/**
 * `treeCommand`'s answer as rows the app draws — `{ rows, truncated }`, or null when there was no answer.
 *
 * FLAT, NOT NESTED, and that is the point rather than a convenience: a session is a chain in which every
 * message is the child of the one before, so a nested drawing indents once per message. `depth` is the
 * number of branch points above a row — the way Pi's own tree view indents — and the branch holding the
 * session's current point comes first at every fork. A row is `{ id, depth, kind, text, label, onPath,
 * current }`: `onPath` is the branch the session is on, `current` the point it stands on.
 */
function treeRows(response) {
  const d = response && response.success !== false ? response.data : null;
  if (!d || typeof d !== 'object') return null;
  const roots = (Array.isArray(d.tree) ? d.tree : (d.tree ? [d.tree] : [])).filter(n => n && n.entry);
  const leafId = typeof d.leafId === 'string' ? d.leafId : null;
  const kids = (n) => (Array.isArray(n.children) ? n.children.filter(c => c && c.entry) : []);

  // Which subtrees hold the current point — iterative, because a long session is a chain thousands deep.
  const onPath = new Set();
  const order = [];
  const walk = [...roots];
  while (walk.length) { const n = walk.pop(); order.push(n); for (const c of kids(n)) walk.push(c); }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if ((leafId && n.entry.id === leafId) || kids(n).some(c => onPath.has(c))) onPath.add(n);
  }

  const first = (list) => [...list.filter(n => onPath.has(n)), ...list.filter(n => !onPath.has(n))];
  const rows = [];
  let truncated = false;
  const stack = first(roots).reverse().map(n => [n, roots.length > 1 ? 1 : 0]);
  while (stack.length) {
    const [n, depth] = stack.pop();
    const id = String(n.entry.id || '');
    const current = !!leafId && id === leafId;
    const shown = id ? treeEntry(n.entry, current) : null;
    if (shown) {
      if (rows.length >= TREE_ROWS_CAP) { truncated = true; break; }
      rows.push({
        id,
        depth,
        kind: shown.kind,
        text: shown.text,
        label: typeof n.label === 'string' ? clip(n.label) : '',
        onPath: onPath.has(n),
        current,
      });
    }
    const children = first(kids(n));
    const next = children.length > 1 ? depth + 1 : depth;
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], next]);
  }
  return { rows, truncated };
}

// Move the session to another point. A prompt that runs the extension's internal command — like
// `argumentsCommand`, it reaches neither the model nor the transcript. The outcome comes back later as a
// `navigated` op carrying the same token, because a move with a summary is a model call.
function navigateCommand(id, { target, summarize, token } = {}) {
  const req = { target: String(target || ''), summarize: summarize === true, token: String(token || '') };
  return { id, type: 'prompt', message: `/${NAVIGATE_COMMAND} ${JSON.stringify(req)}` };
}

// What to say once a move is done — `{ level, text }`, or null for a move the user cancelled.
function navigatedNotice(op) {
  if (!op) return null;
  if (op.cancelled) return null;
  if (!op.ok) return { level: 'error', text: op.error || 'The session did not switch branches.' };
  const parts = ['Switched to another point in the session.'];
  if (op.summarized) parts.push('A summary of the branch you left was added at the new point.');
  if (op.draft) parts.push('The message you picked is back in the input, to edit and send again.');
  parts.push('The branch you left stays in the tree.');
  return { level: 'info', text: parts.join(' ') };
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
  exportCommand,
  exportFileName,
  exportNotice,
  lastReplyCommand,
  lastReplyText,
  copiedNotice,
  shellCommand,
  shellAbortCommand,
  shellResult,
  treeCommand,
  treeRows,
  navigateCommand,
  navigatedNotice,
  answerCommand,
  sessionIdFromState,
  entriesFromMessages,
};
