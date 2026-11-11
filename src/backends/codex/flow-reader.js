'use strict';
// Codex's session-flow reader: one rollout file in, one neutral `FlowSnapshot` out (spec 46, #826, plan T14). This is
// where Codex's FORMAT lives (CLAUDE.md reflex 5): `response_item` payload types, `event_msg` `token_count` and
// `turn_aborted`, the top-level `compacted` line, `turn_context`. Nothing past the snapshot sees a vendor field.
//
// Loaded LAZILY by the descriptor's `readSessionFlow` (and by the worker), never at descriptor load. Pure apart from
// reading the file: no Electron, no database, no `fs.*Sync`, so it runs in a worker thread.
//
// One lane (`main`). A subagent's rollout is its own file; reading it is plan T15, so a spawn call is an ordinary tool
// step here. A guardian rollout is not a session and never reaches this reader.
//
// BOUNDED the same way Claude's reader is, by the same primitives (`../flow-lines`): 64 KB chunks, a per-line byte cap
// (a longer line becomes ONE `unknown` step and a limitation), truncated strings, a step cap and a size-estimate cap
// (the read stops with `complete: false` and says why), an AbortSignal honoured between chunks.
//
// What it never does: assign the difference between two checkpoints to a step, or read the `compacted` line's
// `latest_token_usage_record` (that is the summarising call, not a request of the session: spec 28).

const { flowStepId } = require('../../shared/flow-snapshot');
const {
  MAX_STEPS, MAX_LINE_BYTES, MAX_SNAPSHOT_BYTES, LABEL_CHARS, DETAIL_CHARS, STEP_OVERHEAD,
  trunc, firstLine, isObject, readLines, detailSize, evidence,
} = require('../flow-lines');
const { LIMITATIONS, CAPABILITIES } = require('./flow-capabilities');

const LANE_ID = 'main';
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
function makeBuilder(laneId, sourceId, limits, shared) {
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
    startStep = addStep(ctx, 'start', 'Session start', {});
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

  function onToolCall(p, brief, ctx) {
    const name = typeof p.name === 'string' && p.name ? p.name : 'tool';
    const step = addStep(ctx, 'tool', brief ? `${name}: ${firstLine(brief)}` : name, { tool: trunc(name, 100), input: trunc(brief, DETAIL_CHARS) });
    if (step && typeof p.call_id === 'string' && p.call_id) {
      pendingTools.set(p.call_id, step);
      if (pendingTools.size > MAX_PENDING_TOOLS) pendingTools.delete(pendingTools.keys().next().value);
    }
  }

  function onToolOutput(p) {
    const step = typeof p.call_id === 'string' ? pendingTools.get(p.call_id) : null;
    if (!step) return;
    pendingTools.delete(p.call_id);
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

  function onResponseItem(p, ctx) {
    switch (p.type) {
      case 'message':
        if (p.role === 'user') onUserMessage(p.content, ctx);
        else if (p.role === 'assistant') onAssistantMessage(p.content, p.phase, ctx);
        break; // `developer` messages are the CLI's own instructions to the model
      case 'reasoning': onReasoning(p, ctx); break;
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
      requestFirst = null; // an aborted turn's steps get no later checkpoint
    }
  }

  function onLine(text, lineNo, offset) {
    let obj;
    try { obj = JSON.parse(text); } catch { return shared.stopReason !== null; }
    if (!isObject(obj)) return false;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const ctx = { lineNo, offset, part: 0, ts: Number.isFinite(ts) ? ts : null };
    const p = isObject(obj.payload) ? obj.payload : {};
    ensureStart(ctx);
    switch (obj.type) {
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

  function close() {
    if (pendingCompaction && pendingCompaction.detail.after === undefined) pendingCompaction.detail.after = 'unknown';
    return steps;
  }

  return { onLine, onOversize, close, steps, hasStart: () => startStep !== null };
}

/**
 * The flow of one Codex session. `sources` is what `sessionFlow(row)` answered: the main rollout is the one with
 * `laneHint: 'main'` (else the first). Async: the file is streamed. Never rejects for a read problem: an unreadable
 * file, an abort and every cap end in a snapshot whose `complete` is false and whose limitations say why. `opts`:
 * `signal`, and for tests `maxLineBytes`, `maxSteps`, `maxBytes`.
 */
async function readSessionFlow(sources, opts = {}) {
  const list = Array.isArray(sources) ? sources.filter(isObject) : [];
  const source = list.find(s => s.laneHint === 'main') || list[0] || null;
  const limits = { maxSteps: opts.maxSteps || MAX_STEPS, maxBytes: opts.maxBytes || MAX_SNAPSHOT_BYTES };
  const shared = { count: 0, size: 0, stopReason: null, skippedLines: 0, limitations: [], limitationIds: new Set() };
  const main = makeBuilder(LANE_ID, source && source.sourceId ? source.sourceId : 'main', limits, shared);
  const limitation = (id, text) => {
    if (shared.limitationIds.has(id)) return;
    shared.limitationIds.add(id);
    shared.limitations.push({ id, text });
  };
  let aborted = false;
  let failed = false;
  const noSources = !source || typeof source.file !== 'string';

  if (!noSources) {
    try {
      const r = await readLines(source.file, { maxLineBytes: opts.maxLineBytes || MAX_LINE_BYTES, signal: opts.signal }, main.onLine, main.onOversize);
      aborted = r.aborted;
    } catch {
      failed = true;
    }
  }

  const steps = main.close();
  let complete = !aborted && !failed && shared.skippedLines === 0 && shared.stopReason === null;
  if (shared.stopReason === 'steps') limitation('step-cap', `The step cap (${limits.maxSteps}) was reached; later steps are not shown.`);
  if (shared.stopReason === 'bytes') limitation('size-cap', 'The snapshot size cap was reached; later steps are not shown.');
  if (aborted) limitation('aborted', 'The read was cancelled before the end of the rollout.');
  if (failed) limitation('read-failed', 'The rollout could not be read.');
  if (noSources) { limitation('nothing-read', 'Nothing was read from this session.'); complete = false; }
  else if (!failed && !main.hasStart()) limitation('empty-transcript', 'The rollout holds no lines yet.');
  const caps = {};
  for (const id of Object.keys(CAPABILITIES)) caps[id] = { ...CAPABILITIES[id] };
  return {
    schemaVersion: 1,
    snapshotId: `codex-${Date.now().toString(36)}`,
    fingerprint: null,
    capabilities: caps,
    limitations: LIMITATIONS.map(l => ({ ...l })).concat(shared.limitations),
    lanes: [{
      id: LANE_ID, parentLaneId: null, depth: 0, label: 'Main', kind: 'main',
      spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null,
    }],
    steps,
    nextCursor: null,
    complete,
  };
}

module.exports = { readSessionFlow };
