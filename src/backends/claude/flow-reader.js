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
const { flowStepId } = require('../../shared/flow-snapshot');
const { LIMITATIONS, CAPABILITIES } = require('./flow-capabilities');
const { resolveClaudeVariant } = require('./model-windows');

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// O5 (spec 46): the largest local transcripts hold a few thousand assistant steps. 20 000 steps is several times
// that, and the size estimate below is the bound that actually protects the worker's heap and the reply.
const MAX_STEPS = 20000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const LABEL_CHARS = 200;
const DETAIL_CHARS = 2048;
const MAX_INSTRUCTION_FILES = 200;
const MAX_PENDING_TOOLS = 5000;
const STEP_OVERHEAD = 400;

const LANE_ID = 'main';
const INTERRUPT_PREFIX = '[Request interrupted by user';

function trunc(value, max) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (s.length <= max) return s;
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1; // do not cut a surrogate pair in half
  return s.slice(0, end) + '…';
}

function firstLine(value) {
  const s = typeof value === 'string' ? value : '';
  for (const raw of s.split('\n', 8)) {
    const t = raw.trim();
    if (t) return trunc(t, LABEL_CHARS);
  }
  return '';
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Reads `file` as lines. `onLine(text, lineNo, byteOffset)` returns true to stop; `onOversize(lineNo, byteOffset,
 * bytes)` is called for a line over the cap, which was never held in memory beyond one chunk. Resolves
 * `{ aborted }`. Rejects on a read error.
 */
async function readLines(file, { maxLineBytes, signal }, onLine, onOversize) {
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK_BYTES });
  let pieces = [];
  let pieceBytes = 0;
  let skipping = false;
  let skippedBytes = 0;
  let lineNo = 0;
  let lineStart = 0;
  let chunkPos = 0;
  let stopped = false;

  const finishLine = () => {
    lineNo += 1;
    let stop = false;
    if (skipping) {
      stop = onOversize(lineNo, lineStart, skippedBytes) === true;
    } else if (pieceBytes > 0) {
      const text = pieces.length === 1 ? pieces[0].toString('utf8') : Buffer.concat(pieces, pieceBytes).toString('utf8');
      stop = onLine(text, lineNo, lineStart) === true;
    }
    pieces = [];
    pieceBytes = 0;
    skipping = false;
    skippedBytes = 0;
    return stop;
  };

  try {
    for await (const chunk of stream) {
      if (signal && signal.aborted) return { aborted: true };
      let start = 0;
      while (start < chunk.length) {
        const nl = chunk.indexOf(10, start);
        const end = nl === -1 ? chunk.length : nl;
        const len = end - start;
        if (skipping) {
          skippedBytes += len;
        } else if (pieceBytes + len > maxLineBytes) {
          skipping = true;
          skippedBytes = pieceBytes + len;
          pieces = [];
          pieceBytes = 0;
        } else if (len > 0) {
          pieces.push(chunk.subarray(start, end));
          pieceBytes += len;
        }
        if (nl === -1) break;
        const next = chunkPos + nl + 1;
        const stop = finishLine();
        lineStart = next;
        if (stop) { stopped = true; break; }
        start = nl + 1;
      }
      if (stopped) break;
      chunkPos += chunk.length;
    }
    if (!stopped && (pieceBytes > 0 || skipping)) finishLine();
  } finally {
    stream.destroy();
  }
  return { aborted: false };
}

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

function detailSize(detail) {
  let n = 0;
  for (const k in detail) n += 24 + (typeof detail[k] === 'string' ? detail[k].length : 8);
  return n;
}

function evidence(value, unit, basis, note) {
  return { value, unit, basis, note: note || '' };
}

function makeBuilder(sourceId, limits) {
  const steps = [];
  const dynamicLimitations = [];
  const limitationIds = new Set();
  const pendingTools = new Map();
  let turn = 0;
  let size = 0;
  let stopReason = null; // 'steps' | 'bytes'
  let startStep = null;
  let mode = null;
  let lastInput = null;
  let lastModel = null;
  let lastRequestId = null;
  let firstRequestSeen = false;
  let pendingCompaction = null;
  let lastCompaction = null;
  let lastCommand = null;
  let skippedLines = 0;

  const limitation = (id, text) => {
    if (limitationIds.has(id)) return;
    limitationIds.add(id);
    dynamicLimitations.push({ id, text });
  };

  // `ctx` is one line: { lineNo, offset, part, ts }. A line may yield several steps; `part` keeps their ids apart.
  function addStep(ctx, kind, label, detail, extra) {
    if (steps.length >= limits.maxSteps) {
      stopReason = stopReason || 'steps';
      return null;
    }
    const source = { sourceId, line: ctx.lineNo, byteOffset: ctx.offset };
    const step = {
      id: flowStepId(LANE_ID, source, ctx.part),
      laneId: LANE_ID,
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
    size += STEP_OVERHEAD + step.label.length + detailSize(step.detail);
    if (size > limits.maxBytes) stopReason = stopReason || 'bytes';
    return step;
  }

  function ensureStart(ctx) {
    if (startStep) return;
    startStep = addStep(ctx, 'start', 'Session start', {});
    if (startStep) {
      startStep.tokens = evidence(null, 'tokens', 'unknown', 'No request has been made yet, so the total is not known.');
      if (mode) startStep.detail.mode = mode;
    }
  }

  // The window of the request's model, decided by the same function the health badge uses (#620/#621): the bare
  // window of the model, a `[1m]` suffix if the model string carries one, and the floor: a request that sent more
  // than 200 000 tokens cannot have run in a 200 000 window, so it is read as the 1M variant. Always an inference.
  function windowEvidence(model, input) {
    const variant = typeof model === 'string'
      ? resolveClaudeVariant({ lastModel: model, lastModelSpec: /\[1m\]\s*$/i.test(model) ? model : null, lastInputTokens: input })
      : null;
    if (!variant || variant.windowTokens == null) return evidence(null, 'tokens', 'unknown', 'The model is not one with a known window.');
    const why = variant.source === 'floor'
      ? 'Inferred: the request was larger than the base window, so the 1M variant is assumed.'
      : variant.oneM ? 'Inferred from the model string, which names the 1M variant.'
        : 'Inferred from the model name; a 1M variant selected outside the transcript is not recorded.';
    return evidence(variant.windowTokens, 'tokens', 'estimated', why);
  }

  function checkpointOf(input, model, note) {
    return {
      input: evidence(input, 'tokens', 'measured', note),
      window: windowEvidence(model, input),
      model: typeof model === 'string' ? model : null,
    };
  }

  function noteMode(next, ctx) {
    if (typeof next !== 'string' || !next) return;
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

  function onInstructions(attachment, ctx) {
    const files = attachment.files;
    if (!startStep) return;
    const n = Math.min(files.length, MAX_INSTRUCTION_FILES);
    for (let i = 0; i < n; i++) {
      const f = files[i];
      if (!isObject(f)) continue;
      const chars = typeof f.content === 'string' ? f.content.length : 0;
      const detail = { characters: chars };
      if (typeof attachment.reason === 'string') detail.reason = attachment.reason; // a re-attachment: `compaction`, `session_start`, ...
      const step = addStep(ctx, 'instructions', typeof f.path === 'string' && f.path ? f.path : 'Instruction file',
        detail, { parentStepId: startStep.id });
      if (!step) return;
      step.tokens = evidence(Math.ceil(chars / 4), 'tokens', 'estimated', 'About characters / 4, not a measured count.');
    }
    if (files.length > n) limitation('instruction-files-cap', `Only the first ${MAX_INSTRUCTION_FILES} instruction files are listed.`);
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
        size += 40 + lastCommand.detail.output.length;
        if (size > limits.maxBytes) stopReason = stopReason || 'bytes';
      }
      return true;
    }
    return false;
  }

  function onUserText(text, ctx) {
    if (onCommandText(text, ctx)) return;
    if (text.startsWith(INTERRUPT_PREFIX)) {
      addStep(ctx, 'interrupt', firstLine(text) || 'Interrupted', {});
      return;
    }
    turn += 1;
    addStep(ctx, 'prompt', firstLine(text) || 'Prompt', { text: trunc(text, DETAIL_CHARS) });
  }

  function onToolResult(block) {
    const step = pendingTools.get(block.tool_use_id);
    if (!step) return;
    pendingTools.delete(block.tool_use_id);
    const result = trunc(textOfResult(block.content), DETAIL_CHARS);
    step.detail.result = result;
    step.detail.status = block.is_error === true ? 'error' : 'ok';
    // A failed call carries an outcome flag so a run of equivalent calls never swallows it (the layout keys on `detail.tool`).
    if (block.is_error === true) step.flags.push({ axis: 'outcome', code: 'tool-error', why: 'the tool reported an error', evidence: 'structured' });
    size += 40 + result.length;
    if (size > limits.maxBytes) stopReason = stopReason || 'bytes';
  }

  function onUser(obj, ctx) {
    noteMode(obj.permissionMode, ctx);
    if (obj.isCompactSummary) {
      const summary = obj.message && obj.message.content;
      if (lastCompaction && lastCompaction.detail.summary === undefined && typeof summary === 'string') {
        lastCompaction.detail.summary = trunc(summary, DETAIL_CHARS);
        size += 40 + lastCompaction.detail.summary.length;
        if (size > limits.maxBytes) stopReason = stopReason || 'bytes';
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
      if (b.type === 'tool_result') onToolResult(b);
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
        if (step && typeof b.id === 'string') {
          pendingTools.set(b.id, step);
          if (pendingTools.size > MAX_PENDING_TOOLS) pendingTools.delete(pendingTools.keys().next().value);
        }
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        step = addStep(ctx, 'output', firstLine(b.text) || 'Output', { text: trunc(b.text, DETAIL_CHARS) });
      }
      if (step && !first) first = step;
      if (stopReason) break;
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
    try { obj = JSON.parse(text); } catch { return stopReason !== null; }
    if (!isObject(obj)) return false;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    // A subagent's lines (`isSidechain`) belong to its own lane; the main lane skips them until the agent lanes are built (T11).
    if (obj.isSidechain === true) return false;
    const ctx = { lineNo, offset, part: 0, ts: Number.isFinite(ts) ? ts : null };
    ensureStart(ctx);
    switch (obj.type) {
      case 'attachment':
        if (isObject(obj.attachment) && obj.attachment.type === 'instructions' && Array.isArray(obj.attachment.files)) onInstructions(obj.attachment, ctx);
        break;
      case 'user': onUser(obj, ctx); break;
      case 'assistant': onAssistant(obj, ctx); break;
      // A `mode` line is NOT a permission mode: measured, it carries the prompt-input mode (`normal`) only, while the
      // permission mode is `permissionMode` on the user lines. Reading it would flip the mode on every line.
      case 'system':
        if (obj.subtype === 'compact_boundary') onCompaction(obj, ctx);
        break;
      default: break;
    }
    return stopReason !== null;
  }

  function onOversize(lineNo, offset, bytes) {
    skippedLines += 1;
    limitation('line-over-cap', 'A line exceeded the size cap and was skipped unread; the steps in it are missing.');
    const ctx = { lineNo, offset, part: 0, ts: null };
    ensureStart(ctx);
    const step = addStep(ctx, 'event', 'A line exceeded the size cap', { bytes });
    if (step) step.tokens = evidence(null, 'bytes', 'unknown', 'The line was not read.');
    return stopReason !== null;
  }

  function finish({ aborted, failed, noSources }) {
    if (pendingCompaction && pendingCompaction.detail.after === undefined) pendingCompaction.detail.after = 'unknown';
    let complete = !aborted && !failed && skippedLines === 0 && stopReason === null;
    if (stopReason === 'steps') limitation('step-cap', `The step cap (${limits.maxSteps}) was reached; later steps are not shown.`);
    if (stopReason === 'bytes') limitation('size-cap', 'The snapshot size cap was reached; later steps are not shown.');
    if (aborted) limitation('aborted', 'The read was cancelled before the end of the transcript.');
    if (failed) limitation('read-failed', 'The transcript could not be read.');
    if (noSources) { limitation('nothing-read', 'Nothing was read from this session.'); complete = false; }
    else if (!failed && !startStep) limitation('empty-transcript', 'The transcript holds no lines yet.');
    const caps = {};
    for (const id of Object.keys(CAPABILITIES)) caps[id] = { ...CAPABILITIES[id] };
    return {
      schemaVersion: 1,
      snapshotId: `claude-${Date.now().toString(36)}`,
      fingerprint: null,
      capabilities: caps,
      limitations: LIMITATIONS.map(l => ({ ...l })).concat(dynamicLimitations),
      lanes: [{
        id: LANE_ID, parentLaneId: null, depth: 0, label: 'Main', kind: 'main',
        spawnAnchor: null, returnAnchor: null, summaryOnly: false, sessionRef: null,
      }],
      steps,
      nextCursor: null,
      complete,
    };
  }

  return { onLine, onOversize, finish, stopped: () => stopReason !== null };
}

/**
 * The flow of one Claude session. `sources` is what `sessionFlow(row)` answered (the main transcript is the one
 * with `laneHint: 'main'`, else the first). Async: the file is streamed. Never rejects for a read problem: an
 * unreadable file, an abort and every cap end in a snapshot whose `complete` is false and whose limitations say
 * why. `opts`: `signal`, and for tests `maxLineBytes`, `maxSteps`, `maxBytes`.
 */
async function readSessionFlow(sources, opts = {}) {
  const source = (Array.isArray(sources) && (sources.find(s => s && s.laneHint === 'main') || sources[0])) || null;
  const limits = {
    maxSteps: opts.maxSteps || MAX_STEPS,
    maxBytes: opts.maxBytes || MAX_SNAPSHOT_BYTES,
  };
  const builder = makeBuilder(source && source.sourceId ? source.sourceId : 'main', limits);
  if (!source || typeof source.file !== 'string') return builder.finish({ noSources: true });
  let aborted = false;
  let failed = false;
  try {
    const r = await readLines(source.file, { maxLineBytes: opts.maxLineBytes || MAX_LINE_BYTES, signal: opts.signal }, builder.onLine, builder.onOversize);
    aborted = r.aborted;
  } catch {
    failed = true;
  }
  return builder.finish({ aborted, failed });
}

module.exports = { readSessionFlow, MAX_STEPS, MAX_LINE_BYTES, MAX_SNAPSHOT_BYTES };
