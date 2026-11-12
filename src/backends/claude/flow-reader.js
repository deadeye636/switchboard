'use strict';
// Claude's session-flow reader: one transcript file in, one neutral `FlowSnapshot` out (spec 46, #826, plan T4/T5).
// This is where Claude's FORMAT lives (CLAUDE.md reflex 5): record types, `message.usage`, `compact_boundary`,
// the `instructions` attachment. Nothing past the snapshot sees a vendor field.
//
// Loaded LAZILY by the descriptor's `readSessionFlow` (and by the worker), never at descriptor load. Pure apart
// from reading the file: no Electron, no database, no `fs.*Sync`, so it runs in a worker thread.
//
// BOUNDED, because a transcript can be tens of megabytes with single lines of several (measured, one machine:
// largest file 59 MB, 4016 lines):
//   - a line reader of its own, not `readline`: 64 KB chunks, split on 0x0A in the Buffer, a per-line byte cap.
//     A longer line is never concatenated and never parsed; it becomes ONE `unknown` step and a limitation;
//   - every string is truncated here (labels, details), so the snapshot's size follows the step count;
//   - a step cap and a serialised-size estimate cap; at either the read stops with `complete: false` and a
//     limitation that says so;
//   - an AbortSignal is honoured between chunks.
//
// What it never does: assign the difference between two checkpoints to a step. A checkpoint is one measured
// request input; a step carries it only as that request's reading.

const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { flowStepId } = require('../../shared/flow-snapshot');
const {
  MAX_STEPS, MAX_LINE_BYTES, MAX_SNAPSHOT_BYTES, LABEL_CHARS, DETAIL_CHARS, STEP_OVERHEAD,
  instructionLabel, trunc, firstLine, isObject, readLines, detailSize, evidence, flagSize,
} = require('../flow-lines');
const { LIMITATIONS, CAPABILITIES } = require('./flow-capabilities');
const { resolveClaudeVariant, windowFor, parseSpec, specNamesModel } = require('./model-windows');
const { modelCommandSpec } = require('./session-reader');
const { commandFlags, modeFlag, resultFlags, attachmentEvent } = require('./flow-flags');

const MAX_INSTRUCTION_FILES = 200;
const MAX_PENDING_TOOLS = 5000;
// Subagents (T11): the cap bounds the readdir answer and the lanes held; the meta file is a few hundred bytes.
const MAX_AGENT_LANES = 200;
const MAX_AGENT_REFS = 5000;
const MAX_LANE_DEPTH = 8;
const META_BYTES = 16 * 1024;
// The spawn tool: `Agent` in every transcript measured; `Task` is its older name, so both are accepted.
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const LANE_ID = 'main';
const INTERRUPT_PREFIX = '[Request interrupted by user';

function inputOf(usage) {
  if (!isObject(usage)) return 0;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
}

function briefOf(input) {
  if (!isObject(input)) return '';
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']) {
    if (typeof input[key] === 'string' && input[key]) return input[key];
  }
  return '';
}

function textOfResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (isObject(b) && b.type === 'text' && typeof b.text === 'string') {
      out += (out ? '\n' : '') + b.text.slice(0, DETAIL_CHARS);
      if (out.length >= DETAIL_CHARS) break;
    }
  }
  return out;
}

// One lane's builder. `shared` is the snapshot-wide state every lane writes to, so the caps apply to the whole snapshot
// across all files: `{ count, size, stopReason ('steps' | 'bytes'), skippedLines, limitations, limitationIds, spawns,
// agents, results }`. `spawns` maps a spawn tool call's id to its step, `agents` an `agentId` to the parent step whose
// `tool_result` named it. `opts`: `sidechain` (a subagent's lane reads the `isSidechain` lines the main lane
// skips), `startLabel`, `useHint` (the session settings' window belongs to the main lane's model only).
function makeBuilder(laneId, sourceId, limits, shared, opts) {
  const steps = [];
  const pendingTools = new Map();
  let turn = 0;
  let startStep = null;
  let mode = null;
  let lastInput = null;
  let lastModel = null;
  let lastRequestId = null;
  let firstRequestSeen = false;
  let pendingCompaction = null;
  let lastCompaction = null;
  let lastCommand = null;
  let cwd = null; // the session's working directory, from the first transcript line that names one
  let instructionLines = 0;
  const startFiles = []; // the first instruction attachment: it belongs to the start, whatever line it came on
  const home = os.homedir();
  let modelSpec = null;        // the argument of the last `/model <spec>` in this lane (#852); the session reader's rule
  let pendingSpec = null;      // `{ spec }`: typed inside a running turn, it applies from the next turn
  let turnOpen = false;
  const hinted = [];   // main lane: checkpoints whose window waits for the lane's current model (settleHints)

  const limitation = (id, text) => {
    if (shared.limitationIds.has(id)) return;
    shared.limitationIds.add(id);
    shared.limitations.push({ id, text });
  };

  // A flag's sentence counts toward the snapshot's size estimate like the rest of a step.
  function addFlag(step, f) {
    step.flags.push(f);
    shared.size += flagSize(f);
    if (shared.size > limits.maxBytes) shared.stopReason = shared.stopReason || 'bytes';
  }

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
    shared.size += STEP_OVERHEAD + step.label.length + detailSize(step.detail);
    if (shared.size > limits.maxBytes) shared.stopReason = shared.stopReason || 'bytes';
    return step;
  }

  function ensureStart(ctx) {
    if (startStep) return;
    startStep = addStep(ctx, 'start', opts.startLabel, {});
    if (startStep) {
      startStep.tokens = evidence(null, 'tokens', 'unknown', 'No request has been made yet, so the total is not known.');
      if (mode) startStep.detail.mode = mode;
    }
  }

  // The window of the request's model, decided by the same function the health badge uses (#620/#621): the bare
  // window of the model, the `[1m]` of the `/model <spec>` in force for the request, and the floor: a request that sent more
  // than 200 000 tokens cannot have run in a 200 000 window, so it is read as the 1M variant. Always an inference.
  function windowEvidence(model, input, spec) {
    const variant = typeof model === 'string'
      ? resolveClaudeVariant({ lastModel: model, lastModelSpec: spec || null, lastInputTokens: input })
      : null;
    // The session's own settings (the caller's `windowHint`, resolved like the health badge) outrank the model name, but
    // never a request that did not fit in them: the floor below still applies. The hint is the session's CURRENT window, so
    // it is not applied here: `settleHints` does it when the lane ends and the current model is known (#852).
    if (!variant || variant.windowTokens == null) return { ...evidence(null, 'tokens', 'unknown', 'The model is not one with a known window.'), explicit: true };
    const why = variant.source === 'floor'
      ? 'Inferred: the request was larger than the base window, so the 1M variant is assumed.'
      : variant.oneM ? 'Inferred from the `/model` spec in force, which names the 1M variant.'
        : 'Inferred from the model name; a 1M variant selected outside the transcript is not recorded.';
    return evidence(variant.windowTokens, 'tokens', 'estimated', why);
  }

  // The `/model <spec>` in force for a request on `model`: one that names the model (else it has expired, the session
  // reader's rule, #622).
  function specFor(model) {
    if (!modelSpec || typeof model !== 'string') return null;
    return specNamesModel(modelSpec, model) ? modelSpec : null;
  }

  function checkpointOf(input, model, note) {
    const spec = specFor(model);
    const cp = {
      input: evidence(input, 'tokens', 'measured', note),
      window: windowEvidence(model, input, spec),
      model: typeof model === 'string' ? model : null,
    };
    if (opts.useHint && limits.windowHint) hinted.push({ cp, model, input, oneM: !!(spec && /\[1m\]\s*$/i.test(spec)), exactBare: exactBareSpec(spec, model) });
    return cp;
  }

  // A spec that names the request's model by its exact id, without `[1m]`: the CLI's own switch to the base window.
  function exactBareSpec(spec, model) {
    if (!spec || /\[1m\]\s*$/i.test(spec)) return false;
    const p = parseSpec(spec);
    const m = parseSpec(model);
    return !!(p && m && !p.family && p.model === m.model);
  }

  // `/model <spec>` as the session reader reads it (the same function): a user line at an idle prompt, or a system
  // `local_command` line inside a turn. No argument opens the picker, whose choice the transcript does not spell out.
  function noteModelCommand(text) {
    const spec = modelCommandSpec(text);
    if (spec === null) return;
    if (turnOpen) pendingSpec = { spec: spec || null };
    else { modelSpec = spec || null; pendingSpec = null; }
  }

  // A turn ended (or a prompt began one): a switch typed inside the last turn takes effect.
  function endTurn() {
    turnOpen = false;
    if (pendingSpec) { modelSpec = pendingSpec.spec; pendingSpec = null; }
  }

  // The hint is the window of one model: the one the stored row's last turn ran on, or a pending `/model` switch (the
  // caller's `hintModel`; the lane's last model when it names none). It may stand only for a checkpoint whose own
  // request ran on that model and fit in it. A checkpoint whose request ran under a `/model` spec with `[1m]` is 1M on
  // that evidence. Any other checkpoint keeps the model-name answer where that is certain (a 1M spec, a bare exact-id spec, the size
  // floor, a model with no larger variant) and otherwise says the window is not known: whether it ran with `[1m]` is not
  // in the transcript (#852).
  function settleHints() {
    if (!hinted.length) return;
    const hintModel = limits.hintModel || lastModel;
    const target = hintModel ? parseSpec(hintModel) : null;
    for (const { cp, model, input, oneM, exactBare } of hinted) {
      const mine = typeof model === 'string' ? parseSpec(model) : null;
      if (oneM) continue;
      if (mine && target && mine.model === target.model && input <= limits.windowHint) {
        cp.window = evidence(limits.windowHint, 'tokens', 'estimated', "Estimated from the session's settings.");
      } else if (mine && !exactBare && !(target && mine.model === target.model) && cp.window.basis !== 'unknown' && !windowIsCertain(model, input)) {
        cp.window = { ...evidence(null, 'tokens', 'unknown', "The window is not known for this request: the model differs from the one the session's settings describe, and whether it ran with the 1M variant is not recorded."), explicit: true };
      }
    }
  }

  // Is the model-name answer for this request the only one possible? The size floor, or a model whose `[1m]` variant has
  // the same window as the bare one. (A `[1m]` in the model string or in the spec in force is `oneM` above.)
  function windowIsCertain(model, input) {
    const v = resolveClaudeVariant({ lastModel: model, lastModelSpec: null, lastInputTokens: input });
    return !v || v.source === 'floor' || windowFor(v.model, true) === windowFor(v.model, false);
  }

  function noteMode(next, ctx) {
    if (typeof next !== 'string' || !next) return;
    if (mode === null) {
      mode = next;
      if (startStep) {
        startStep.detail.mode = next;
        const f = modeFlag(next); // a session that STARTS in a prompt-skipping mode has no mode step to carry it
        if (f) addFlag(startStep, f);
      }
      return;
    }
    if (next === mode) return;
    const from = mode;
    mode = next;
    const step = addStep(ctx, 'mode', `Mode: ${next}`, { from, to: next });
    const f = modeFlag(next); // on the mode step only, not repeated on the tool steps that follow
    if (step && f) addFlag(step, f);
  }

  function onInstructions(attachment, ctx) {
    const files = attachment.files;
    if (!startStep) return;
    const n = Math.min(files.length, MAX_INSTRUCTION_FILES);
    const first = instructionLines++ === 0;
    for (let i = 0; i < n; i++) {
      const f = files[i];
      if (!isObject(f)) continue;
      const chars = typeof f.content === 'string' ? f.content.length : 0;
      const detail = { characters: chars };
      if (typeof attachment.reason === 'string') detail.reason = attachment.reason; // a re-attachment: `compaction`, `session_start`, ...
      let label = instructionLabel(f.path, cwd, home);
      if (!first && detail.reason) label += ` (${detail.reason})`; // a repeat names why it came again
      const step = addStep(ctx, 'instructions', label, detail, { parentStepId: startStep.id });
      if (!step) return;
      if (first) startFiles.push(step);
      step.tokens = evidence(Math.ceil(chars / 4), 'tokens', 'estimated', 'About characters / 4, not a measured count.');
    }
    if (files.length > n) limitation('instruction-files-cap', `Only the first ${MAX_INSTRUCTION_FILES} instruction files are listed.`);
  }

  // `hook_cancelled` and `command_permissions` are facts of their own (flow-flags.js): an event step carrying the flag.
  function onAttachmentEvent(attachment, ctx) {
    const ev = attachmentEvent(attachment);
    if (!ev) return;
    const step = addStep(ctx, 'event', ev.label, ev.detail);
    if (step) for (const f of ev.flags) addFlag(step, f);
  }

  // A slash command is written as a user line of markup (`<command-name>` ...) and its output as another
  // (`<local-command-stdout>`); neither is something the user said to the model, so neither starts a turn.
  function onCommandText(text, ctx) {
    const t = text.trimStart();
    if (t.startsWith('<command-name>')) {
      const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t);
      const args = /<command-args>([^<]*)<\/command-args>/.exec(t);
      lastCommand = addStep(ctx, 'event', name && name[1] ? name[1] : 'Command', args && args[1].trim() ? { args: trunc(args[1].trim(), DETAIL_CHARS) } : {});
      return true;
    }
    if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) {
      if (lastCommand && lastCommand.detail.output === undefined) {
        lastCommand.detail.output = trunc(t.replace(/<\/?local-command-std(?:out|err)>/g, '').trim(), DETAIL_CHARS);
        shared.size += 40 + lastCommand.detail.output.length;
        if (shared.size > limits.maxBytes) shared.stopReason = shared.stopReason || 'bytes';
      }
      return true;
    }
    return false;
  }

  function onUserText(text, ctx) {
    if (onCommandText(text, ctx)) {
      noteModelCommand(text);
      // Another slash command starts a turn too, which ends the wait of a `/model` typed in the last one (the session reader's rule).
      if (text.trimStart().startsWith('<command-name>') && modelCommandSpec(text) === null) { endTurn(); turnOpen = true; }
      return;
    }
    endTurn();
    turnOpen = true;   // a prompt starts a turn
    if (text.startsWith(INTERRUPT_PREFIX)) {
      addStep(ctx, 'interrupt', firstLine(text) || 'Interrupted', {});
      return;
    }
    turn += 1;
    addStep(ctx, 'prompt', firstLine(text) || 'Prompt', { text: trunc(text, DETAIL_CHARS) });
  }

  // A spawn call's result names the agent in `toolUseResult.agentId` on the user line (measured). A background launch
  // (`isAsync`, status `async_launched`) answers at once, long before the agent ends, so it is no return.
  // Keyed by the call's id (the meta file names the same id), so a later result line that carries the same `agentId`
  // (a continued agent) is never taken for the spawn call's return; `agents` keeps the first result that named an agent.
  function noteAgentResult(obj, step, toolUseId) {
    const r = obj.toolUseResult;
    if (!isObject(r) || typeof r.agentId !== 'string' || !r.agentId || shared.agents.size >= MAX_AGENT_REFS) return;
    const ref = { step, returned: r.isAsync !== true && r.status !== 'async_launched' };
    if (typeof toolUseId === 'string') shared.results.set(toolUseId, ref);
    if (!shared.agents.has(r.agentId)) shared.agents.set(r.agentId, ref);
  }

  function onToolResult(block, obj) {
    const step = pendingTools.get(block.tool_use_id);
    if (!step) return;
    pendingTools.delete(block.tool_use_id);
    noteAgentResult(obj, step, block.tool_use_id);
    const result = trunc(textOfResult(block.content), DETAIL_CHARS);
    step.detail.result = result;
    step.detail.status = block.is_error === true ? 'error' : 'ok';
    // A failed, blocked or denied call carries an outcome flag so a run of equivalent calls never swallows it (the layout keys on `detail.tool`).
    for (const f of resultFlags(block.is_error, result)) addFlag(step, f);
    shared.size += 40 + result.length;
    if (shared.size > limits.maxBytes) shared.stopReason = shared.stopReason || 'bytes';
  }

  function onUser(obj, ctx) {
    noteMode(obj.permissionMode, ctx);
    if (obj.isCompactSummary) {
      const summary = obj.message && obj.message.content;
      if (lastCompaction && lastCompaction.detail.summary === undefined && typeof summary === 'string') {
        lastCompaction.detail.summary = trunc(summary, DETAIL_CHARS);
        shared.size += 40 + lastCompaction.detail.summary.length;
        if (shared.size > limits.maxBytes) shared.stopReason = shared.stopReason || 'bytes';
      }
      return;
    }
    if (obj.isMeta || obj.isVisibleInTranscriptOnly) return;
    const content = obj.message && obj.message.content;
    if (typeof content === 'string') {
      if (content) onUserText(content, ctx);
      return;
    }
    if (!Array.isArray(content)) return;
    let text = '';
    let sawImage = false;
    for (const b of content) {
      if (!isObject(b)) continue;
      if (b.type === 'tool_result') onToolResult(b, obj);
      else if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
      else if (b.type === 'image') sawImage = true;
    }
    if (text) onUserText(text, ctx);
    else if (sawImage) onUserText('[image]', ctx);
  }

  function onAssistant(obj, ctx) {
    const message = obj.message;
    if (!isObject(message)) return;
    const model = typeof message.model === 'string' ? message.model : null;
    const id = typeof message.id === 'string' && message.id ? message.id : null;
    const isNewRequest = !(id && id === lastRequestId);
    lastRequestId = id;
    const input = inputOf(message.usage);
    let checkpoint = null;
    if (input > 0 && isNewRequest) {
      checkpoint = checkpointOf(input, model, 'Input of this request: input + cache read + cache creation.');
      if (!firstRequestSeen) {
        firstRequestSeen = true;
        if (startStep) {
          startStep.tokens = evidence(input, 'tokens', 'measured', 'The first request\'s input; it also counts input the transcript does not list.');
          if (model) startStep.detail.model = model;
        }
      }
      if (pendingCompaction) {
        pendingCompaction.detail.after = input;
        pendingCompaction = null;
      }
      lastInput = input;
      if (model) lastModel = model;
      if (modelSpec && typeof model === 'string' && !specNamesModel(modelSpec, model)) modelSpec = null;   // expired (#622)
      turnOpen = true;
    }

    const content = message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    let first = null;
    for (const b of blocks) {
      if (!isObject(b)) continue;
      let step = null;
      if (b.type === 'thinking') {
        const t = typeof b.thinking === 'string' ? b.thinking : '';
        step = addStep(ctx, 'thinking', 'Thinking', t ? { text: trunc(t, DETAIL_CHARS) } : {});
      } else if (b.type === 'tool_use') {
        const brief = briefOf(b.input);
        const name = typeof b.name === 'string' && b.name ? b.name : 'tool';
        step = addStep(ctx, 'tool', brief ? `${name}: ${firstLine(brief)}` : name, { tool: trunc(name, 100), input: trunc(brief, DETAIL_CHARS) });
        if (step) for (const f of commandFlags(name, b.input)) addFlag(step, f);
        if (step && typeof b.id === 'string') {
          if (SPAWN_TOOLS.has(name) && shared.spawns.size < MAX_AGENT_REFS) shared.spawns.set(b.id, step);
          pendingTools.set(b.id, step);
          if (pendingTools.size > MAX_PENDING_TOOLS) pendingTools.delete(pendingTools.keys().next().value);
        }
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        step = addStep(ctx, 'output', firstLine(b.text) || 'Output', { text: trunc(b.text, DETAIL_CHARS) });
      }
      if (step && !first) first = step;
      if (shared.stopReason) break;
    }
    if (checkpoint) {
      if (!first) first = addStep(ctx, 'checkpoint', 'Request', {});
      if (first) first.checkpoint = checkpoint;
    }
  }

  function onCompaction(obj, ctx) {
    const meta = isObject(obj.compactMetadata) ? obj.compactMetadata : {};
    const detail = {
      trigger: typeof meta.trigger === 'string' ? meta.trigger : 'unknown',
      before: lastInput == null ? 'unknown' : lastInput,
    };
    if (Number.isFinite(meta.preTokens)) detail.reportedPreTokens = meta.preTokens;
    if (Number.isFinite(meta.postTokens)) detail.reportedPostTokens = meta.postTokens;
    if (Number.isFinite(meta.durationMs)) detail.durationMs = meta.durationMs;
    const step = addStep(ctx, 'compaction', `Compaction (${detail.trigger})`, detail);
    if (!step) return;
    // "Before" is the last non-zero request input ahead of the compaction, "after" the next non-zero one. The
    // boundary line's own figures stay as reported values; the summarising call's usage is never read.
    if (lastInput != null) step.checkpoint = checkpointOf(lastInput, lastModel, 'The last request input before the compaction.');
    pendingCompaction = step;
    lastCompaction = step;
  }

  function onLine(text, lineNo, offset) {
    let obj;
    try { obj = JSON.parse(text); } catch { return shared.stopReason !== null; }
    if (!isObject(obj)) return false;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    // A subagent's lines (`isSidechain`) belong to its own lane: the main lane skips them, a subagent's lane reads its own file whole.
    if (obj.isSidechain === true && !opts.sidechain) return false;
    const ctx = { lineNo, offset, part: 0, ts: Number.isFinite(ts) ? ts : null };
    if (cwd === null && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
    ensureStart(ctx);
    switch (obj.type) {
      case 'attachment':
        if (isObject(obj.attachment) && obj.attachment.type === 'instructions' && Array.isArray(obj.attachment.files)) onInstructions(obj.attachment, ctx);
        else onAttachmentEvent(obj.attachment, ctx);
        break;
      case 'user': onUser(obj, ctx); break;
      case 'assistant': onAssistant(obj, ctx); break;
      // A `mode` line is NOT a permission mode: measured, it carries the prompt-input mode (`normal`) only, while the
      // permission mode is `permissionMode` on the user lines. Reading it would flip the mode on every line.
      case 'system':
        if (obj.subtype === 'compact_boundary') onCompaction(obj, ctx);
        else if (obj.subtype === 'turn_duration') endTurn();
        else if (obj.subtype === 'local_command' && typeof obj.content === 'string') noteModelCommand(obj.content);
        break;
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

  // The first instruction attachment arrives after the first prompt in a real transcript, but it is part of the
  // session's start: move it right behind the start step (a stable partition) and renumber the ordinals. Ids derive
  // from the source line, so they do not change. A repeat (a later attachment) stays where it happened.
  function moveStartFilesUp() {
    if (!startFiles.length || steps.length < 2 || steps[0] !== startStep) return;
    const moved = new Set(startFiles);
    const rest = steps.slice(1).filter((x) => !moved.has(x));
    steps.splice(1, steps.length - 1, ...startFiles, ...rest);
    for (const x of startFiles) x.turn = startStep.turn;
    for (let i = 0; i < steps.length; i++) steps[i].ordinal = i;
  }

  // Ends the lane and hands back its steps (ordinals are renumbered across the whole snapshot by the caller).
  function close() {
    moveStartFilesUp();
    settleHints();
    if (pendingCompaction && pendingCompaction.detail.after === undefined) pendingCompaction.detail.after = 'unknown';
    return steps;
  }

  return { onLine, onOversize, close, steps, hasStart: () => startStep !== null };
}

function newShared() {
  return { count: 0, size: 0, stopReason: null, skippedLines: 0, limitations: [], limitationIds: new Set(), spawns: new Map(), agents: new Map(), results: new Map() };
}

/** A subagent's `.meta.json` (agent type, description, the spawn call's id), read bounded; `{}` when it is missing or unreadable. */
async function readAgentMeta(file) {
  let fh = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.allocUnsafe(META_BYTES);
    const { bytesRead } = await fh.read(buf, 0, META_BYTES, 0);
    const o = JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
    if (!isObject(o)) return {};
    const str = (v) => (typeof v === 'string' ? v : '');
    return { agentType: trunc(str(o.agentType), 100), description: firstLine(str(o.description)), toolUseId: str(o.toolUseId), parentAgentId: str(o.parentAgentId) };
  } catch { return {}; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

const AGENT_FILE = /^agent-(.+)\.jsonl$/;

/** The agent ids of a session's `subagents` directory, sorted. An absent directory (nothing spawned) is no agents. */
async function listAgentIds(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const ids = [];
  for (const n of names) {
    const m = AGENT_FILE.exec(n);
    if (m) ids.push(m[1]);
  }
  return ids.sort();
}

/**
 * Turns the lanes read into the snapshot's lane list: the spawn anchor is the parent's spawn call (found by the id the
 * meta file names, else by the `agentId` its result carried), the return anchor the parent step whose result carried
 * the `agentId` and was no background launch. The parent lane is the lane of the spawn step (depth one more), else the
 * main lane, or, with no spawn call found, the lane the meta file's `parentAgentId` names. A lane without a return stays open.
 */
function agentLanes(read, shared) {
  const anchor = (step) => (step ? { laneId: step.laneId, stepId: step.id } : null);
  const laneIds = new Set(read.map(a => a.laneId));
  const records = read.map((a) => {
    const ref = (a.meta.toolUseId && shared.results.get(a.meta.toolUseId)) || shared.agents.get(a.id) || null;
    const spawn = (a.meta.toolUseId && shared.spawns.get(a.meta.toolUseId)) || (ref && ref.step) || null;
    // No spawn call found: the meta file's `parentAgentId` names the parent lane, when that lane was read.
    const viaMeta = a.meta.parentAgentId && laneIds.has(`agent:${a.meta.parentAgentId}`) ? `agent:${a.meta.parentAgentId}` : null;
    const label = trunc([a.meta.agentType, a.meta.description].filter(Boolean).join(': ') || 'Agent', LABEL_CHARS);
    return {
      id: a.laneId, parentLaneId: spawn && spawn.laneId !== a.laneId ? spawn.laneId : (!spawn && viaMeta && viaMeta !== a.laneId ? viaMeta : LANE_ID), depth: 1, label, kind: 'agent',
      spawnAnchor: anchor(spawn), returnAnchor: ref && ref.returned ? anchor(ref.step) : null, summaryOnly: false, sessionRef: null,
    };
  });
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) {
    let depth = 1;
    let up = byId.get(r.parentLaneId);
    for (let hops = 0; up && up !== r && hops < MAX_LANE_DEPTH; hops++) {
      depth += 1;
      up = byId.get(up.parentLaneId);
    }
    if (up) { r.parentLaneId = LANE_ID; r.depth = 1; } else r.depth = depth;   // a spawn loop or a chain too deep: hang it on main
  }
  return records;
}

/**
 * The flow of one Claude session. `sources` is what `sessionFlow(row)` answered: the main transcript is the one
 * with `laneHint: 'main'` (else the first), and a source with `role: 'subagents-dir'` names the session's `subagents`
 * directory, read here (async) into one lane per `agent-<id>.jsonl`. Async: the files are streamed. Never rejects for a
 * read problem: an unreadable file, an abort and every cap end in a snapshot whose `complete` is false and whose
 * limitations say why. The caps and the abort signal cover the whole snapshot, not one file. `opts`: `signal`,
 * `windowHint` (`{ windowTokens }`, main's answer from the session's settings, used for the main lane's model only),
 * and for tests `maxLineBytes`, `maxSteps`, `maxBytes`.
 */
async function readSessionFlow(sources, opts = {}) {
  const list = Array.isArray(sources) ? sources.filter(isObject) : [];
  const dirSource = list.find(s => s.role === 'subagents-dir' && typeof s.file === 'string') || null;
  const own = list.filter(s => s !== dirSource);
  const source = own.find(s => s.laneHint === 'main') || own[0] || null;
  const limits = {
    maxSteps: opts.maxSteps || MAX_STEPS,
    maxBytes: opts.maxBytes || MAX_SNAPSHOT_BYTES,
    windowHint: opts.windowHint && Number(opts.windowHint.windowTokens) > 0 ? Number(opts.windowHint.windowTokens) : null,
    // The model the hint was resolved for (the stored row's, or the pending `/model` switch's); absent: the lane's last model.
    hintModel: opts.windowHint && typeof opts.windowHint.model === 'string' && opts.windowHint.model ? opts.windowHint.model : null,
  };
  const readOpts = { maxLineBytes: opts.maxLineBytes || MAX_LINE_BYTES, signal: opts.signal };
  const shared = newShared();
  const main = makeBuilder(LANE_ID, source && source.sourceId ? source.sourceId : 'main', limits, shared,
    { sidechain: false, startLabel: 'Session start', useHint: true });
  const limitation = (id, text) => {
    if (shared.limitationIds.has(id)) return;
    shared.limitationIds.add(id);
    shared.limitations.push({ id, text });
  };
  let aborted = false;
  let failed = false;
  let agentsIncomplete = false;
  const noSources = !source || typeof source.file !== 'string';
  const read = [];   // the agent lanes that were read: { id, laneId, meta, builder }

  if (!noSources) {
    try {
      const r = await readLines(source.file, readOpts, main.onLine, main.onOversize);
      aborted = r.aborted;
    } catch {
      failed = true;
    }
    if (!aborted && !failed && dirSource && shared.stopReason === null) {
      let ids = await listAgentIds(dirSource.file);
      if (ids.length > MAX_AGENT_LANES) {
        const total = ids.length;
        ids = ids.slice(0, MAX_AGENT_LANES);   // by id: a start time would need every file opened first
        agentsIncomplete = true;
        limitation('agent-lanes-cap', `Only ${MAX_AGENT_LANES} of ${total} subagents are shown (chosen by id, not by start time).`);
      }
      for (const id of ids) {
        if (opts.signal && opts.signal.aborted) { aborted = true; break; }
        if (shared.stopReason !== null) break;
        const meta = await readAgentMeta(pathMod.join(dirSource.file, `agent-${id}.meta.json`));
        const laneId = `agent:${id}`;
        const builder = makeBuilder(laneId, laneId, limits, shared, { sidechain: true, startLabel: 'Agent start', useHint: false });
        try {
          const r = await readLines(pathMod.join(dirSource.file, `agent-${id}.jsonl`), readOpts, builder.onLine, builder.onOversize);
          if (r.aborted) aborted = true;
        } catch {
          agentsIncomplete = true;
          limitation('agent-read-failed', 'A subagent transcript could not be read; its lane is missing or cut short.');
        }
        if (builder.steps.length) read.push({ id, laneId, meta, builder });
        if (aborted) break;
      }
    }
  }

  const mainSteps = main.close();
  for (const a of read) a.builder.close();
  // Agent lanes in the order they started, then by id; a lane whose time is unknown goes last.
  const firstTs = (a) => { const t = a.builder.steps.find(x => Number.isFinite(x.ts)); return t ? t.ts : Infinity; };
  read.sort((a, b) => (firstTs(a) === firstTs(b) ? 0 : firstTs(a) < firstTs(b) ? -1 : 1) || (a.id < b.id ? -1 : 1));
  const steps = mainSteps.concat(...read.map(a => a.builder.steps));
  for (let i = 0; i < steps.length; i++) steps[i].ordinal = i;

  let complete = !aborted && !failed && !agentsIncomplete && shared.skippedLines === 0 && shared.stopReason === null;
  if (shared.stopReason === 'steps') limitation('step-cap', `The step cap (${limits.maxSteps}) was reached; later steps are not shown.`);
  if (shared.stopReason === 'bytes') limitation('size-cap', 'The snapshot size cap was reached; later steps are not shown.');
  if (aborted) limitation('aborted', 'The read was cancelled before the end of the transcript.');
  if (failed) limitation('read-failed', 'The transcript could not be read.');
  if (noSources) { limitation('nothing-read', 'Nothing was read from this session.'); complete = false; }
  else if (!failed && !main.hasStart()) limitation('empty-transcript', 'The transcript holds no lines yet.');
  const caps = {};
  for (const id of Object.keys(CAPABILITIES)) caps[id] = { ...CAPABILITIES[id] };
  return {
    schemaVersion: 1,
    snapshotId: `claude-${Date.now().toString(36)}`,
    fingerprint: null,
    capabilities: caps,
    limitations: LIMITATIONS.map(l => ({ ...l })).concat(shared.limitations),
    lanes: [{
      id: LANE_ID, parentLaneId: null, depth: 0, label: 'Main', kind: 'main',
      spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null,
    }].concat(agentLanes(read, shared)),
    steps,
    nextCursor: null,
    complete,
  };
}

module.exports = { readSessionFlow, MAX_STEPS, MAX_LINE_BYTES, MAX_SNAPSHOT_BYTES, MAX_AGENT_LANES };
