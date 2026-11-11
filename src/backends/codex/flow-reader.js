'use strict';
// Codex's session-flow reader: one rollout file in, one neutral `FlowSnapshot` out (spec 46, #826, plan T14). This is
// where Codex's FORMAT lives (CLAUDE.md reflex 5): `response_item` payload types, `event_msg` `token_count` and
// `turn_aborted`, the top-level `compacted` line, `turn_context`. Nothing past the snapshot sees a vendor field.
//
// Loaded LAZILY by the descriptor's `readSessionFlow` (and by the worker), never at descriptor load. Pure apart from
// reading the file: no Electron, no database, no `fs.*Sync`, so it runs in a worker thread.
//
// Lanes (T15): `main` plus one lane per spawned subagent. A subagent writes a rollout of its own, which the session cache
// does not hold (the parser drops every `source.subagent` rollout), so this reader finds them: a child is spawned while the
// parent runs, so only the date folders of the parent's first-to-last-line window are listed, and only a rollout whose NAME
// time lies in the window is opened, and then only its first 4 KB unless that shows a `thread_spawn`. A header whose `source.subagent.thread_spawn.parent_thread_id` names a thread already found is a child; every
// other header, a guardian's `source.subagent.other` included, is skipped and is never a lane.
//
// BOUNDED the same way Claude's reader is, by the same primitives (`../flow-lines`): 64 KB chunks, a per-line byte cap
// (a longer line becomes ONE `unknown` step and a limitation), truncated strings, a step cap and a size-estimate cap
// (the read stops with `complete: false` and says why), an AbortSignal honoured between chunks.
//
// What it never does: assign the difference between two checkpoints to a step, or read the `compacted` line's
// `latest_token_usage_record` (that is the summarising call, not a request of the session: spec 28).

const fs = require('node:fs');
const pathMod = require('node:path');
const { flowStepId } = require('../../shared/flow-snapshot');
const {
  MAX_STEPS, MAX_LINE_BYTES, MAX_SNAPSHOT_BYTES, LABEL_CHARS, DETAIL_CHARS, STEP_OVERHEAD,
  trunc, firstLine, isObject, readLines, detailSize, evidence,
} = require('../flow-lines');
const { LIMITATIONS, CAPABILITIES } = require('./flow-capabilities');

const LANE_ID = 'main';
const MAIN_PATH = '/root';   // the path Codex gives the session's own thread; a child's header states its own
const HEAD_BYTES = 4 * 1024;      // enough to see `source`, which precedes the large `base_instructions` (measured)
const HEADER_BYTES = 64 * 1024;    // a candidate's whole first line, at most
const WINDOW_SLACK_MS = 2 * 60 * 1000;
const NAME_WIDEN_MS = 60 * 60 * 1000;   // names are local time: an hour back covers the autumn clock change, for the name filter only
const MAX_SCAN_ROUNDS = 4;               // a child that ran longer than the window widens it; so does the child of that child
const NAME_TIME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/;
const MAX_AGENT_LANES = 200;
const MAX_SCAN_DIRS = 31;      // calendar days of a parent's window listed
const MAX_SCAN_FILES = 2000;   // rollouts opened
const MAX_LANE_DEPTH = 8;
const WAIT_TOOLS = new Set(['wait_agent', 'wait']);
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
const lastSegment = (p) => (typeof p === 'string' ? p.split('/').filter(Boolean).pop() || '' : '');
const MAX_PENDING_TOOLS = 5000;
const ARGS_PARSE_CHARS = 64 * 1024;
const INSTRUCTIONS_HEAD = '# AGENTS.md instructions';
// Text the CLI injects as a user message: the environment block, notes about an aborted turn or a compaction. None of
// it is something the user said, so none of it starts a turn.
const INJECTED_PREFIXES = ['<environment_context>', '<user_instructions>', '<turn_aborted>', '<no retained transcript', '<subagent_notification>'];
// The user's own `!` shell line: an action of theirs, shown as an event, starting no turn.
const SHELL_COMMAND_HEAD = '<user_shell_command>';
// Argument keys that say what a function call is about, in the order they are tried.
const BRIEF_KEYS = ['cmd', 'command', 'message', 'task_name', 'prompt', 'path', 'target', 'query'];

function briefOfArguments(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > ARGS_PARSE_CHARS) return '';
  let args;
  try { args = JSON.parse(raw); } catch { return ''; }
  if (!isObject(args)) return '';
  for (const key of BRIEF_KEYS) if (typeof args[key] === 'string' && args[key]) return args[key];
  return '';
}

// A tool output is a string (a function call) or a list of `{ type, text }` parts (a custom tool call). Bounded.
function textOfOutput(output) {
  if (typeof output === 'string') return output.slice(0, DETAIL_CHARS * 2);
  if (!Array.isArray(output)) return '';
  let out = '';
  for (const part of output) {
    if (isObject(part) && typeof part.text === 'string') {
      out += (out ? '\n' : '') + part.text.slice(0, DETAIL_CHARS);
      if (out.length >= DETAIL_CHARS * 2) break;
    }
  }
  return out;
}

// Codex states a tool call's exit code only inside the output text, as `Exit code: N` at the head or `exit_code=N`
// as the last line (the shell tools). The code-mode `exec` wraps a script (`Script completed`) and prints none.
// Only the head and the tail are looked at: an exit code quoted in the middle of a script's output is no verdict.
function exitCodeOf(text) {
  const head = /^Exit code:\s*(-?\d+)/im.exec(text.slice(0, 200));
  if (head) return Number(head[1]);
  const tail = /(?:^|\n)\s*exit_code=(-?\d+)\s*$/.exec(text.slice(-120));
  return tail ? Number(tail[1]) : null;
}

function sandboxOf(policy) {
  if (typeof policy === 'string') return policy;
  return isObject(policy) && typeof policy.type === 'string' ? policy.type : '';
}

// One lane's builder. `shared` is the snapshot-wide state: `{ count, size, stopReason ('steps' | 'bytes'),
// skippedLines, limitations, limitationIds }`.
function makeBuilder(laneId, sourceId, limits, shared, opts) {
  const steps = [];
  const pendingTools = new Map();
  let turn = 0;
  let startStep = null;
  let mode = null;
  let model = null;
  let lastInput = null;
  let lastWindow = null;
  let lastSignature = null;
  let firstRequestSeen = false;
  let requestFirst = null; // the first thinking/tool/output step since the last checkpoint: it carries the reading
  let pendingCompaction = null;
  let instructionBlocks = 0;
  let threadId = null;   // the rollout's own thread id, from its header
  let ownPath = (opts && opts.ownPath) || MAIN_PATH;
  let firstTs = null;
  let lastTs = null;   // the first and the last timestamp this rollout shows: the window its children were spawned in
  let openWait = null;   // the call id of the last wait call, until it is answered, a turn is aborted or a new turn begins
  let pendingTrigger = false;   // the last `inter_agent_communication_metadata` said the next message starts a turn
  const messagesFrom = new Map();   // an agent's path -> the first step in this lane that carries its message

  const limitation = (id, text) => {
    if (shared.limitationIds.has(id)) return;
    shared.limitationIds.add(id);
    shared.limitations.push({ id, text });
  };

  const grow = (n) => {
    shared.size += n;
    if (shared.size > limits.maxBytes) shared.stopReason = shared.stopReason || 'bytes';
  };

  // `ctx` is one line: { lineNo, offset, part, ts }. A line may yield several steps; `part` keeps their ids apart.
  function addStep(ctx, kind, label, detail, extra) {
    if (shared.count >= limits.maxSteps) {
      shared.stopReason = shared.stopReason || 'steps';
      return null;
    }
    const source = { sourceId, line: ctx.lineNo, byteOffset: ctx.offset };
    const step = {
      id: flowStepId(laneId, source, ctx.part),
      laneId,
      ordinal: steps.length,
      turn: turn || null,
      kind,
      label: trunc(label, LABEL_CHARS),
      ts: ctx.ts,
      source,
      checkpoint: null,
      tokens: null,
      flags: [],
      detail: detail || {},
    };
    if (extra) Object.assign(step, extra);
    ctx.part += 1;
    steps.push(step);
    shared.count += 1;
    grow(STEP_OVERHEAD + step.label.length + detailSize(step.detail));
    if (!requestFirst && (kind === 'thinking' || kind === 'tool' || kind === 'output')) requestFirst = step;
    return step;
  }

  function ensureStart(ctx) {
    if (startStep) return;
    startStep = addStep(ctx, 'start', (opts && opts.startLabel) || 'Session start', {});
    if (startStep) {
      startStep.tokens = evidence(null, 'tokens', 'unknown', 'No request has been made yet, so the total is not known.');
      if (mode) startStep.detail.mode = mode;
      if (model) startStep.detail.model = model;
    }
  }

  function checkpointOf(input, window, note) {
    return {
      input: evidence(input, 'tokens', 'measured', note),
      window: Number.isFinite(window) && window > 0
        ? evidence(window, 'tokens', 'measured', 'The window the CLI reported with this request.')
        : evidence(null, 'tokens', 'unknown', 'The rollout reports no window for this request.'),
      model,
    };
  }

  function noteMode(next, ctx) {
    if (!next) return;
    if (mode === null) {
      mode = next;
      if (startStep) startStep.detail.mode = next;
      return;
    }
    if (next === mode) return;
    const from = mode;
    mode = next;
    addStep(ctx, 'mode', `Mode: ${next}`, { from, to: next });
  }

  function onTurnContext(p, ctx) {
    if (typeof p.model === 'string' && p.model) {
      model = p.model;
      if (startStep && !firstRequestSeen) startStep.detail.model = model;
    }
    const parts = [typeof p.approval_policy === 'string' ? p.approval_policy : '', sandboxOf(p.sandbox_policy)].filter(Boolean);
    noteMode(parts.join(', '), ctx);
  }

  function onInstructions(text, ctx) {
    if (!startStep) return;
    const chars = text.length;
    const first = instructionBlocks++ === 0;
    const step = addStep(ctx, 'instructions', first ? 'AGENTS.md instructions' : 'AGENTS.md instructions (again)', { characters: chars }, { parentStepId: startStep.id });
    if (step) step.tokens = evidence(Math.ceil(chars / 4), 'tokens', 'estimated', 'About characters / 4, not a measured count. The block is part of the first request\'s input.');
  }

  function isInjected(text) {
    const t = text.trimStart();
    return INJECTED_PREFIXES.some(p => t.startsWith(p));
  }

  function onShellCommand(text, ctx) {
    const inner = text.trimStart().slice(SHELL_COMMAND_HEAD.length);
    const cmd = /<command>([\s\S]*?)<\/command>/.exec(inner);
    const first = firstLine(cmd ? cmd[1] : inner.replace(/<\/?[a-z_]+>/g, ''));
    addStep(ctx, 'event', first ? `Shell command: ${first}` : 'Shell command', { text: trunc(inner.replace(/<\/?[a-z_]+>/g, '').trim(), DETAIL_CHARS) });
  }

  function onUserMessage(content, ctx) {
    const parts = typeof content === 'string' ? [{ text: content }] : Array.isArray(content) ? content : [];
    let text = '';
    for (const part of parts) {
      if (!isObject(part) || typeof part.text !== 'string' || !part.text) continue;
      if (part.text.startsWith(INSTRUCTIONS_HEAD)) onInstructions(part.text, ctx);
      else if (part.text.trimStart().startsWith(SHELL_COMMAND_HEAD)) onShellCommand(part.text, ctx);
      else if (!isInjected(part.text)) text += (text ? '\n' : '') + part.text;
    }
    if (!text.trim()) return;
    turn += 1;
    openWait = null;
    requestFirst = null; // the next checkpoint belongs to this turn's steps, not to an earlier turn's
    addStep(ctx, 'prompt', firstLine(text) || 'Prompt', { text: trunc(text, DETAIL_CHARS) });
  }

  function onAssistantMessage(content, phase, ctx) {
    const parts = Array.isArray(content) ? content : [];
    let text = '';
    for (const part of parts) if (isObject(part) && typeof part.text === 'string') text += (text ? '\n' : '') + part.text;
    if (!text.trim()) return;
    const detail = { text: trunc(text, DETAIL_CHARS) };
    if (typeof phase === 'string' && phase) detail.phase = trunc(phase, 40);
    addStep(ctx, 'output', firstLine(text) || 'Output', detail);
  }

  function onReasoning(p, ctx) {
    const summary = Array.isArray(p.summary) ? p.summary : [];
    let text = '';
    for (const part of summary) if (isObject(part) && typeof part.text === 'string') text += (text ? '\n' : '') + part.text;
    addStep(ctx, 'thinking', 'Thinking', text ? { text: trunc(text, DETAIL_CHARS) } : {});
  }

  function argsOf(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > ARGS_PARSE_CHARS) return null;
    try { const a = JSON.parse(raw); return isObject(a) ? a : null; } catch { return null; }
  }

  function onToolCall(p, brief, ctx) {
    const name = typeof p.name === 'string' && p.name ? p.name : 'tool';
    let kind = 'tool';
    let label = brief ? `${name}: ${firstLine(brief)}` : name;
    const args = name === 'spawn_agent' || name === 'send_message' ? argsOf(p.arguments) : null;
    if (name === 'send_message') {
      // A message to another agent is an event on the sender's lane (its own output is the result string).
      kind = 'event';
      const to = args && typeof args.target === 'string' ? lastSegment(args.target) : '';
      label = `Message to ${to || 'an agent'}${brief ? ': ' + firstLine(brief) : ''}`;
    }
    const step = addStep(ctx, kind, label, { tool: trunc(name, 100), input: trunc(brief, DETAIL_CHARS) });
    if (step && name === 'spawn_agent' && args && typeof args.task_name === 'string' && args.task_name && shared.spawns.length < MAX_AGENT_LANES * 4) {
      shared.spawns.push({ laneId, ownPath, taskName: args.task_name, step, used: false });
    }
    if (step && typeof p.call_id === 'string' && p.call_id) {
      pendingTools.set(p.call_id, step);
      if (WAIT_TOOLS.has(name)) openWait = p.call_id;
      if (pendingTools.size > MAX_PENDING_TOOLS) pendingTools.delete(pendingTools.keys().next().value);
    }
  }

  function onToolOutput(p) {
    const step = typeof p.call_id === 'string' ? pendingTools.get(p.call_id) : null;
    if (!step) return;
    pendingTools.delete(p.call_id);
    if (openWait === p.call_id) openWait = null;
    const raw = textOfOutput(p.output);
    const result = trunc(raw, DETAIL_CHARS);
    const code = exitCodeOf(raw);
    step.detail.result = result;
    step.detail.status = code !== null && code !== 0 ? 'error' : 'ok';
    if (code !== null) step.detail.exitCode = code;
    // A failed call carries an outcome flag so a run of equivalent calls never swallows it (the layout keys on `detail.tool`).
    // Codex has no structured status, so the evidence is `heuristic`: the code is read out of the output text.
    if (code !== null && code !== 0) step.flags.push({ axis: 'outcome', code: 'tool-error', why: 'the output reports a non-zero exit code', evidence: 'heuristic' });
    grow(40 + result.length);
  }

  // A message between agents: `author` and `recipient` are agent paths. The metadata line before it says whether it starts
  // a turn of the receiving agent (`trigger_turn`): then it is that turn's prompt, started by another agent, not by the user.
  // Otherwise it is a message in, shown as an `agent` step; the first one per author is where that agent's result returns.
  // The echo of a message this lane sent itself is skipped (the `send_message` call is its step).
  function onAgentMessage(p, ctx) {
    const trigger = pendingTrigger;
    pendingTrigger = false;
    const author = typeof p.author === 'string' ? p.author : '';
    if (author && author === ownPath) return;
    const parts = Array.isArray(p.content) ? p.content : [];
    let text = '';
    for (const part of parts) if (isObject(part) && typeof part.text === 'string') text += (text ? '\n' : '') + part.text;
    const from = lastSegment(author);
    if (trigger) {
      turn += 1;
      openWait = null;
      requestFirst = null;
      addStep(ctx, 'prompt', firstLine(text) || 'Task from another agent', { text: trunc(text, DETAIL_CHARS), startedBy: 'agent', from });
      return;
    }
    const step = addStep(ctx, 'agent', `Message from ${from || 'an agent'}`, { text: trunc(text, DETAIL_CHARS), from });
    if (step && author && !messagesFrom.has(author)) messagesFrom.set(author, step);
  }

  function onResponseItem(p, ctx) {
    switch (p.type) {
      case 'message':
        if (p.role === 'user') onUserMessage(p.content, ctx);
        else if (p.role === 'assistant') onAssistantMessage(p.content, p.phase, ctx);
        break; // `developer` messages are the CLI's own instructions to the model
      case 'reasoning': onReasoning(p, ctx); break;
      case 'agent_message': onAgentMessage(p, ctx); break;
      case 'custom_tool_call': onToolCall(p, typeof p.input === 'string' ? p.input : '', ctx); break;
      case 'function_call': onToolCall(p, briefOfArguments(p.arguments), ctx); break;
      case 'custom_tool_call_output':
      case 'function_call_output': onToolOutput(p); break;
      default: break;
    }
  }

  function onTokenCount(p, ctx) {
    const info = p.info;
    if (!isObject(info) || !isObject(info.last_token_usage)) return; // a rate-limit-only record
    const input = info.last_token_usage.input_tokens;
    // The record after a compaction carries `input_tokens: 0`; taking it would read a full window as an empty one (spec 28).
    if (!Number.isFinite(input) || input <= 0) return;
    const total = isObject(info.total_token_usage) ? info.total_token_usage.total_tokens : null;
    // The same request reported again has the same running total and input; without a total nothing says so, so none is dropped.
    const signature = Number.isFinite(total) ? `${total}:${input}` : null;
    if (signature !== null && signature === lastSignature) return;
    lastSignature = signature;
    const window = info.model_context_window;
    const checkpoint = checkpointOf(input, window, 'Input of this request (last_token_usage.input_tokens; it already includes the cached part).');
    if (!firstRequestSeen) {
      firstRequestSeen = true;
      if (startStep) {
        startStep.tokens = evidence(input, 'tokens', 'measured', 'The first request\'s input; it also counts input the rollout does not list.');
        if (model) startStep.detail.model = model;
      }
    }
    if (pendingCompaction) {
      pendingCompaction.detail.after = input;
      pendingCompaction = null;
    }
    lastInput = input;
    lastWindow = window;
    const carrier = requestFirst || addStep(ctx, 'checkpoint', 'Request', {});
    requestFirst = null;
    if (carrier && !carrier.checkpoint) carrier.checkpoint = checkpoint;
  }

  function onCompacted(p, ctx) {
    if (pendingCompaction && pendingCompaction.detail.after === undefined) pendingCompaction.detail.after = 'unknown'; // two in a row: no request between them
    const detail = { before: lastInput == null ? 'unknown' : lastInput };
    if (Number.isFinite(p.window_number)) detail.windowNumber = p.window_number;
    const step = addStep(ctx, 'compaction', 'Compaction', detail);
    if (!step) return;
    // "Before" is the last non-zero request input ahead of the compaction, "after" the next non-zero one.
    if (lastInput != null) step.checkpoint = checkpointOf(lastInput, lastWindow, 'The last request input before the compaction.');
    pendingCompaction = step;
    lastInput = null; // a second compaction before any request has no reading before it
    lastSignature = null;
    requestFirst = null;
  }

  function onEvent(p, ctx) {
    if (p.type === 'token_count') onTokenCount(p, ctx);
    else if (p.type === 'turn_aborted') {
      const detail = typeof p.reason === 'string' && p.reason ? { reason: trunc(p.reason, 100) } : {};
      if (Number.isFinite(p.duration_ms)) detail.durationMs = p.duration_ms;
      addStep(ctx, 'interrupt', 'Interrupted', detail);
      openWait = null;   // the turn that was waiting is over
      requestFirst = null; // an aborted turn's steps get no later checkpoint
    }
  }

  function onLine(text, lineNo, offset) {
    let obj;
    try { obj = JSON.parse(text); } catch { return shared.stopReason !== null; }
    if (!isObject(obj)) return false;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const ctx = { lineNo, offset, part: 0, ts: Number.isFinite(ts) ? ts : null };
    if (ctx.ts !== null) { if (firstTs === null) firstTs = ctx.ts; if (lastTs === null || ctx.ts > lastTs) lastTs = ctx.ts; }
    const p = isObject(obj.payload) ? obj.payload : {};
    ensureStart(ctx);
    switch (obj.type) {
      case 'session_meta':
        if (threadId === null && typeof p.id === 'string' && p.id) threadId = p.id;
        break;
      case 'inter_agent_communication_metadata': pendingTrigger = p.trigger_turn === true; break;
      case 'turn_context': onTurnContext(p, ctx); break;
      case 'response_item': onResponseItem(p, ctx); break;
      case 'event_msg': onEvent(p, ctx); break;
      case 'compacted': onCompacted(p, ctx); break;
      default: break;
    }
    return shared.stopReason !== null;
  }

  function onOversize(lineNo, offset, bytes) {
    shared.skippedLines += 1;
    limitation('line-over-cap', 'A line exceeded the size cap and was skipped unread; the steps in it are missing.');
    const ctx = { lineNo, offset, part: 0, ts: null };
    ensureStart(ctx);
    const step = addStep(ctx, 'event', 'A line exceeded the size cap', { bytes });
    if (step) step.tokens = evidence(null, 'bytes', 'unknown', 'The line was not read.');
    return shared.stopReason !== null;
  }

  // The lane's LAST wait call has no output when the read ends, and no turn began or was aborted since: the lane is waiting.
  // Only an explicit wait call says so.
  function isWaiting() {
    return openWait !== null && pendingTools.has(openWait);
  }

  function close() {
    if (pendingCompaction && pendingCompaction.detail.after === undefined) pendingCompaction.detail.after = 'unknown';
    return steps;
  }

  return {
    onLine, onOversize, close, steps, hasStart: () => startStep !== null, isWaiting, messagesFrom,
    threadId: () => threadId, ownPath: () => ownPath, window: () => (firstTs !== null && lastTs !== null ? { lo: firstTs - WINDOW_SLACK_MS, hi: lastTs + WINDOW_SLACK_MS } : null),
  };
}

// --- Finding the subagents' rollouts (O2, spec 46) ---

async function sortedNames(dir, test) {
  try { return (await fs.promises.readdir(dir)).filter(test).sort(); } catch { return []; }
}

// A rollout's name begins with its start time in LOCAL time (`rollout-2026-01-01T13-00-00-<id>.jsonl`; measured against the
// header's UTC timestamp), so the sort is chronological and the time is known without opening the file.
function nameTime(name) {
  const m = NAME_TIME.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}
const two = (n) => String(n).padStart(2, '0');

/**
 * The date folders a window touches, as `{ dirs, capped }`. Codex files a rollout under `<root>/<year>/<month>/<day>/`, so the
 * folders are built from the calendar days of the window instead of listing the store; one that does not exist reads as empty.
 * A folder that does not follow that shape, or no window, is read alone.
 */
function scanDirs(first, window) {
  const day = pathMod.basename(first);
  const monthDir = pathMod.dirname(first);
  const month = pathMod.basename(monthDir);
  const yearDir = pathMod.dirname(monthDir);
  const year = pathMod.basename(yearDir);
  if (!window || !/^\d{2}$/.test(day) || !/^\d{2}$/.test(month) || !/^\d{4}$/.test(year)) return { dirs: [first], capped: false };
  const root = pathMod.dirname(yearDir);
  const dirs = [];
  const d = new Date(window.lo);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() <= window.hi) {
    if (dirs.length >= MAX_SCAN_DIRS) return { dirs, capped: true };
    dirs.push(pathMod.join(root, String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate())));
    d.setDate(d.getDate() + 1);
  }
  return { dirs, capped: false };
}

// What a lane needs out of a header line that is too long to hold or does not parse. `source` precedes the very large
// `base_instructions` (measured), so `id` and the flat `thread_spawn` object are inside the bytes already read; a bounded
// pattern match takes them. Null when either is missing.
function headerFromText(text) {
  const spawn = /"thread_spawn":(\{[^{}]*\})/.exec(text);
  const id = /"id":"([^"\\]+)"/.exec(text);
  if (!spawn || !id) return null;
  let thread;
  try { thread = JSON.parse(spawn[1]); } catch { return null; }
  return isObject(thread) ? { id: id[1], source: { subagent: { thread_spawn: thread } } } : null;
}

// A header that names a `thread_spawn` but whose fields could not be read at all: a lane may be missing, and the snapshot says so.
const UNREADABLE = Object.freeze({ unreadable: true });

function headerFallback(buf) {
  const text = buf.toString('utf8');
  return headerFromText(text) || (text.includes('"thread_spawn"') ? UNREADABLE : null);
}

/**
 * The `payload` of a rollout's first line (its `session_meta`), `null` when the file is not a spawned child, or UNREADABLE.
 * In a header `source` comes before the very large `base_instructions` (measured), so the first HEAD_BYTES say whether
 * `source` names a `thread_spawn`; only a candidate is read on, in steps up to HEADER_BYTES, and stops at the end of its
 * line. A head that does not show `source` at all is read on too. A line longer than HEADER_BYTES, or one that does not
 * parse, is read for the fields a lane needs instead (`headerFromText`).
 */
async function readHeader(file, stats) {
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    stats.read += 1;
    let have = Buffer.alloc(0);
    let end = -1;
    for (const limit of [HEAD_BYTES, HEAD_BYTES * 6, HEADER_BYTES]) {
      const want = limit - have.length;
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(chunk, 0, want, have.length);
      stats.bytes += bytesRead;
      const from = have.length;
      have = Buffer.concat([have, chunk.subarray(0, bytesRead)]);
      end = have.indexOf(10, from);
      if (end !== -1) break;
      if (bytesRead < want) { end = have.length; break; }   // the end of the file
      if (limit === HEAD_BYTES) {
        const head = have.toString('utf8');
        if (head.includes('"source"') && !head.includes('"thread_spawn"')) return null;
      }
    }
    if (end === -1) return headerFallback(have);   // a first line longer than HEADER_BYTES
    try {
      const obj = JSON.parse(have.subarray(0, end).toString('utf8'));
      return isObject(obj) && obj.type === 'session_meta' && isObject(obj.payload) ? obj.payload : null;
    } catch { return headerFallback(have.subarray(0, end)); }
  } catch { return null; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// The search for children: one object that keeps what is known across rounds, so a later round never reopens a rollout.
function newScan(mainFile, mainThreadId, signal, stats) {
  return {
    mainName: pathMod.basename(mainFile), dir: pathMod.dirname(mainFile), known: new Set([mainThreadId]), children: [],
    capped: false, unreadable: false, aborted: false, scannedHi: null, signal, stats,
  };
}

/**
 * Looks for children whose rollout NAME time lies in `[lo, hi]` (ms; both null = only the parent's folder, after the parent). A
 * child is spawned by a call of the parent, so its rollout starts while the parent runs: the date folders of the range are
 * built from the calendar and listed, and only a rollout named inside the range is opened. A rollout is a child when
 * `source.subagent.thread_spawn.parent_thread_id` names the session or a child already found; a parent always precedes its
 * children, so one pass in name order finds a whole tree. Everything else, a guardian's review included
 * (`source.subagent.other`), is skipped. The caller widens `hi` and calls again for a child that ran longer than the parent.
 */
async function scanRange(sc, lo, hi) {
  const range = lo === null ? null : { lo, hi };
  const plan = scanDirs(sc.dir, range);
  if (plan.capped) sc.capped = true;
  // The day cap holds for the whole search, not per widening round.
  const room = Math.max(0, MAX_SCAN_DIRS - sc.stats.dirs);
  if (plan.dirs.length > room) { plan.dirs = plan.dirs.slice(0, room); sc.capped = true; }
  sc.stats.dirs += plan.dirs.length;
  for (let i = 0; i < plan.dirs.length && !sc.capped; i++) {
    const all = await sortedNames(plan.dirs[i], (n) => ROLLOUT_FILE.test(n));
    sc.stats.listed += all.length;
    const names = all.filter((n) => {
      if (n === sc.mainName) return false;
      const t = nameTime(n);
      if (range) return t !== null && t >= range.lo && t <= range.hi;
      return n > sc.mainName;
    });
    for (const name of names) {
      if (sc.signal && sc.signal.aborted) { sc.aborted = true; return; }
      if (sc.stats.read >= MAX_SCAN_FILES || sc.children.length >= MAX_AGENT_LANES) { sc.capped = true; break; }
      const h = await readHeader(pathMod.join(plan.dirs[i], name), sc.stats);
      if (h === UNREADABLE) { sc.unreadable = true; continue; }
      const spawn = h && isObject(h.source) && isObject(h.source.subagent) ? h.source.subagent.thread_spawn : null;
      if (!isObject(spawn) || typeof spawn.parent_thread_id !== 'string' || !sc.known.has(spawn.parent_thread_id)) continue;
      if (typeof h.id !== 'string' || !h.id || sc.known.has(h.id)) continue;
      sc.known.add(h.id);
      sc.children.push({
        file: pathMod.join(plan.dirs[i], name),
        threadId: h.id,
        parentThreadId: spawn.parent_thread_id,
        agentPath: typeof spawn.agent_path === 'string' ? spawn.agent_path : '',
        nickname: typeof spawn.agent_nickname === 'string' ? spawn.agent_nickname : '',
        role: typeof spawn.agent_role === 'string' ? spawn.agent_role : '',
        depth: Number.isFinite(spawn.depth) ? spawn.depth : null,
      });
    }
  }
  sc.scannedHi = hi;
}

/**
 * Turns the child lanes read into the snapshot's lane list. The spawn anchor is the parent lane's `spawn_agent` call whose
 * `task_name`, appended to the parent's own path, is the child's `agent_path` (the call's output names no id, measured); the
 * return anchor is the first message from the child's path in the parent lane (`agent_message`, author = the child). A call
 * that matches nothing leaves the anchor null; a lane without a return stays open.
 */
function childLanes(read, main, mainId, shared) {
  const byThread = new Map(read.map(a => [a.threadId, a]));
  const anchor = (step) => (step ? { laneId: step.laneId, stepId: step.id } : null);
  const records = read.map((a) => {
    const parent = a.parentThreadId === mainId ? { laneId: LANE_ID, builder: main } : byThread.get(a.parentThreadId);
    const parentLane = parent ? parent.laneId : LANE_ID;
    const parentBuilder = parent ? parent.builder : main;
    const spawn = shared.spawns.find(sp => !sp.used && sp.laneId === parentLane && a.agentPath && `${sp.ownPath}/${sp.taskName}` === a.agentPath) || null;
    if (spawn) spawn.used = true;
    const ret = a.agentPath ? parentBuilder.messagesFrom.get(a.agentPath) : null;
    const name = a.nickname || lastSegment(a.agentPath) || 'Agent';
    const label = trunc([name, a.role].filter(Boolean).join(': '), LABEL_CHARS);
    const rec = {
      id: a.laneId, parentLaneId: parentLane, depth: 1, label, kind: 'agent',
      spawnAnchor: anchor(spawn && spawn.step), returnAnchor: anchor(ret || null), summaryOnly: false, sessionRef: null,
    };
    if (a.builder.isWaiting()) rec.waiting = true;
    return rec;
  });
  const byId = new Map(records.map(r => [r.id, r]));
  for (const r of records) {
    let depth = 1;
    let up = byId.get(r.parentLaneId);
    for (let hops = 0; up && up !== r && hops < MAX_LANE_DEPTH; hops++) {
      depth += 1;
      up = byId.get(up.parentLaneId);
    }
    // A loop or a chain too deep: hang it on main, and drop the anchors, which name steps of the lane it was taken from.
    if (up) { r.parentLaneId = LANE_ID; r.depth = 1; r.spawnAnchor = null; r.returnAnchor = null; } else r.depth = depth;
  }
  return records;
}

/**
 * The flow of one Codex session. `sources` is what `sessionFlow(row)` answered: the main rollout is the one with
 * `laneHint: 'main'` (else the first), and a source with `role: 'rollout-scan'` names the main rollout's folder, where the
 * children are looked for. Async: the files are streamed. Never rejects for a read problem: an unreadable file, an abort and
 * every cap end in a snapshot whose `complete` is false and whose limitations say why. The caps and the abort signal cover
 * the whole snapshot, not one file. `opts`: `signal`, `onScan(stats)` (counts of folders, rollouts listed and opened, bytes read), `onFiles(list)` (called with `{ file, size }` of each child rollout
 * read, so main can poll them: paths never enter the snapshot), and for tests `maxLineBytes`, `maxSteps`, `maxBytes`.
 */
async function readSessionFlow(sources, opts = {}) {
  const list = Array.isArray(sources) ? sources.filter(isObject) : [];
  const scanSource = list.find(s => s.role === 'rollout-scan' && typeof s.file === 'string') || null;
  const own = list.filter(s => s !== scanSource);
  const source = own.find(s => s.laneHint === 'main') || own[0] || null;
  const limits = { maxSteps: opts.maxSteps || MAX_STEPS, maxBytes: opts.maxBytes || MAX_SNAPSHOT_BYTES };
  const shared = { count: 0, size: 0, stopReason: null, skippedLines: 0, limitations: [], limitationIds: new Set(), spawns: [] };
  const main = makeBuilder(LANE_ID, source && source.sourceId ? source.sourceId : 'main', limits, shared, { startLabel: 'Session start', ownPath: MAIN_PATH });
  const limitation = (id, text) => {
    if (shared.limitationIds.has(id)) return;
    shared.limitationIds.add(id);
    shared.limitations.push({ id, text });
  };
  const readOpts = { maxLineBytes: opts.maxLineBytes || MAX_LINE_BYTES, signal: opts.signal };
  let aborted = false;
  let failed = false;
  let agentsIncomplete = false;
  const noSources = !source || typeof source.file !== 'string';
  const read = [];
  const files = [];

  if (!noSources) {
    try {
      const r = await readLines(source.file, readOpts, main.onLine, main.onOversize);
      aborted = r.aborted;
    } catch {
      failed = true;
    }
    const mainId = main.threadId();
    if (!aborted && !failed && scanSource && mainId && shared.stopReason === null) {
      const stats = { dirs: 0, listed: 0, read: 0, bytes: 0 };
      const sc = newScan(source.file, mainId, opts.signal, stats);
      const win = main.window();
      if (win) await scanRange(sc, win.lo - NAME_WIDEN_MS, win.hi); else await scanRange(sc, null, null);
      let next = 0;
      let hiMax = win ? win.hi : 0;
      for (let round = 0; ; round++) {
        if (sc.aborted) aborted = true;
        // read the children found since the last round
        for (; !aborted && next < sc.children.length; next++) {
          if (opts.signal && opts.signal.aborted) { aborted = true; break; }
          if (shared.stopReason !== null) break;
          const c = sc.children[next];
          const laneId = `agent:${c.threadId}`;
          const builder = makeBuilder(laneId, laneId, limits, shared, { startLabel: 'Agent start', ownPath: c.agentPath || undefined });
          try {
            const st = await fs.promises.stat(c.file);   // before the read, so growth during it still shows as growth
            files.push({ file: c.file, size: st.size });
            const r = await readLines(c.file, readOpts, builder.onLine, builder.onOversize);
            if (r.aborted) aborted = true;
          } catch {
            agentsIncomplete = true;
            limitation('agent-read-failed', 'A subagent rollout could not be read; its lane is missing or cut short.');
          }
          const w = builder.window();
          if (w && w.hi > hiMax) hiMax = w.hi;
          if (builder.steps.length) read.push({ ...c, laneId, builder });
        }
        // A child that ran past the window may have spawned one after it: look again up to its last line.
        if (aborted || shared.stopReason !== null || sc.capped || !win || !(hiMax > sc.scannedHi)) break;
        // Out of rounds with time still unsearched: a later grandchild may be missing, so say so.
        if (round >= MAX_SCAN_ROUNDS) { sc.capped = true; break; }
        const before = sc.children.length;
        await scanRange(sc, sc.scannedHi + 1, hiMax);
        if (sc.children.length === before && !sc.aborted) break;
      }
      if (sc.aborted) aborted = true;
      if (typeof opts.onScan === 'function') { try { opts.onScan(stats); } catch { /* the caller's problem */ } }
      if (sc.capped) {
        agentsIncomplete = true;
        limitation('agent-scan-cap', `The search for subagent rollouts hit a bound (${MAX_SCAN_FILES} rollouts opened, ${MAX_SCAN_DIRS} days, ${MAX_AGENT_LANES} subagents, ${MAX_SCAN_ROUNDS} widening rounds); some may be missing.`);
      }
      if (sc.unreadable) {
        agentsIncomplete = true;
        limitation('agent-header-unreadable', 'A subagent rollout\'s first line could not be read, so its lane may be missing.');
      }
    }
  }
  if (typeof opts.onFiles === 'function') { try { opts.onFiles(files); } catch { /* the caller's problem */ } }

  const mainSteps = main.close();
  for (const a of read) a.builder.close();
  const firstTs = (a) => { const t = a.builder.steps.find(x => Number.isFinite(x.ts)); return t ? t.ts : Infinity; };
  read.sort((a, b) => (firstTs(a) === firstTs(b) ? 0 : firstTs(a) < firstTs(b) ? -1 : 1) || (a.laneId < b.laneId ? -1 : 1));
  const steps = mainSteps.concat(...read.map(a => a.builder.steps));
  for (let i = 0; i < steps.length; i++) steps[i].ordinal = i;

  let complete = !aborted && !failed && !agentsIncomplete && shared.skippedLines === 0 && shared.stopReason === null;
  if (shared.stopReason === 'steps') limitation('step-cap', `The step cap (${limits.maxSteps}) was reached; later steps are not shown.`);
  if (shared.stopReason === 'bytes') limitation('size-cap', 'The snapshot size cap was reached; later steps are not shown.');
  if (aborted) limitation('aborted', 'The read was cancelled before the end of the rollout.');
  if (failed) limitation('read-failed', 'The rollout could not be read.');
  if (noSources) { limitation('nothing-read', 'Nothing was read from this session.'); complete = false; }
  else if (!failed && !main.hasStart()) limitation('empty-transcript', 'The rollout holds no lines yet.');
  const caps = {};
  for (const id of Object.keys(CAPABILITIES)) caps[id] = { ...CAPABILITIES[id] };
  const mainLane = {
    id: LANE_ID, parentLaneId: null, depth: 0, label: 'Main', kind: 'main',
    spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null,
  };
  if (main.isWaiting()) mainLane.waiting = true;
  return {
    schemaVersion: 1,
    snapshotId: `codex-${Date.now().toString(36)}`,
    fingerprint: null,
    capabilities: caps,
    limitations: LIMITATIONS.map(l => ({ ...l })).concat(shared.limitations),
    lanes: [mainLane].concat(childLanes(read, main, main.threadId(), shared)),
    steps,
    nextCursor: null,
    complete,
  };
}

module.exports = { readSessionFlow, MAX_AGENT_LANES, MAX_SCAN_DIRS, MAX_SCAN_FILES };
