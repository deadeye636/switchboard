'use strict';
// Pi's session-flow reader: one session file in, one neutral `FlowSnapshot` out (spec 46, #826, plan T16). This is where
// Pi's FORMAT lives (CLAUDE.md reflex 5): `message` entries with `user` / `assistant` / `toolResult` / `system` roles,
// `toolCall` / `thinking` / `text` blocks, `usage`, the `compaction` entry, the transport `custom` entry. Nothing past the
// snapshot sees a vendor field.
//
// Loaded LAZILY by the descriptor's `readSessionFlow` (and by the worker), never at descriptor load. Pure apart from reading
// the file and the model catalog (two small JSON files, held a few seconds by `./model-windows`): no Electron, no
// database, so it runs in a worker thread. pi-native reads the same file, so it resolves through this reader.
//
// One lane. Pi has no nested agents: the app's own `subagent` tool starts a child with `--no-session`, so there is no
// child transcript and the call is one collapsed node with the summary line the tool writes into its result.
//
// BOUNDED the same way the other readers are, by the same primitives (`../flow-lines`): 64 KB chunks, a per-line byte cap
// (a longer line becomes ONE `event` step and a limitation), truncated strings, a step cap and a size-estimate cap, an
// AbortSignal honoured between chunks.
//
// The ACTIVE branch only (G1): Pi stores a session as a tree and shows the chain from the last entry back to the root
// (`./active-branch`, the walk the parser and the transcript view use). One pass keeps each entry's `id -> parentId` and
// the entry each step came from; `close()` drops the steps of abandoned branches and renumbers the rest. Abandoned steps
// still count against the step and size caps while the file is read.
//
// What it never does: assign the difference between two checkpoints to a step, or read a `compaction` entry's `usage`
// (that is the summarising call, not a request of the session: spec 28).

const os = require('node:os');
const { flowStepId } = require('../../shared/flow-snapshot');
const {
  MAX_STEPS, MAX_LINE_BYTES, MAX_SNAPSHOT_BYTES, LABEL_CHARS, DETAIL_CHARS, STEP_OVERHEAD,
  instructionLabel, trunc, firstLine, isObject, readLines, detailSize, evidence, flagSize,
} = require('../flow-lines');
const { LIMITATIONS, CAPABILITIES } = require('./flow-capabilities');
const { transportFromEntry } = require('./transport-marker');
const modelWindows = require('./model-windows');
const { activeChain } = require('./active-branch');

const LANE_ID = 'main';
const MAX_PENDING_TOOLS = 5000;
const RESULT_CHARS = 64 * 1024;   // how much of a tool result is joined before the summary line is searched for
const PROJECT_INSTRUCTIONS = /<project_instructions\s+path="([^"]*)"\s*>([\s\S]*?)<\/project_instructions>/g;
// Argument keys that say what a tool call is about, in the order they are tried.
const BRIEF_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task', 'agent'];
// The app's own delegation tool (`../pi/subagent-tool.js`) ends its result with `[subagent <name>: N turns, I in / O out
// tokens, $C, <model>]`; the model is absent when the child named none.
const SUBAGENT_TOOL = 'subagent';
const SUBAGENT_LINE = /\[subagent ([^:\]\n]*): (\d+) turns?, (\d+) in \/ (\d+) out tokens, \$(\d+(?:\.\d+)?)(?:, ([^\]\n]+))?\]/g;

function briefOfArguments(args) {
  if (!isObject(args)) return '';
  for (const key of BRIEF_KEYS) if (typeof args[key] === 'string' && args[key]) return args[key];
  return '';
}

// A tool result's content is a string or a list of `{ type, text }` blocks. Bounded.
function textOfContent(content, max) {
  if (typeof content === 'string') return content.slice(0, max);
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string') {
      out += (out ? '\n' : '') + part.text.slice(0, max);
      if (out.length >= max) break;
    }
  }
  return out;
}

// The last summary line in a delegation's result, as numbers, or null.
function subagentSummary(text) {
  let last = null;
  SUBAGENT_LINE.lastIndex = 0;
  for (let m = SUBAGENT_LINE.exec(text); m; m = SUBAGENT_LINE.exec(text)) last = m;
  if (!last) return null;
  const summary = { turns: Number(last[2]), inputTokens: Number(last[3]), outputTokens: Number(last[4]), costUsd: Number(last[5]) };
  if (last[6]) summary.model = trunc(last[6], 100);
  return summary;
}

// Pi writes `type`, `id` and `parentId` first on every entry line (measured, including the lines over the line cap), so the
// link of a line that could not be parsed or was skipped unread can be read from its head. Null when the head shows none.
const ENTRY_HEAD = /^\{"type":"[^"\\]*","id":"([^"\\]+)","parentId":(?:null|"([^"\\]*)")/;
function linkOf(head) {
  const m = ENTRY_HEAD.exec(typeof head === 'string' ? head : '');
  return m ? { id: m[1], parent: m[2] || null } : null;
}

function entryTime(obj, message) {
  const t = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  if (Number.isFinite(t)) return t;
  return message && Number.isFinite(message.timestamp) ? message.timestamp : null;
}

function makeBuilder(sourceId, limits, shared) {
  const steps = [];
  const pendingTools = new Map();
  const home = os.homedir();
  let turn = 0;
  let startStep = null;
  let cwd = null;
  let model = null;
  let provider = null;
  const parentOf = new Map();       // entry id -> parent id, for the branch walk
  const stepEntry = new Map();      // step -> the id of the entry it came from
  let leafId = null;                // the last entry with an id: the leaf
  let gapFrom = null;               // the leaf when a line was skipped unread (over the cap): the link the skipped entry held
  let gapOpen = false;              // a skipped line has not yet been followed by an entry
  let instructionsSeen = false;
  let transport = null;

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
    if (ctx.entryId) stepEntry.set(step, ctx.entryId);
    ctx.part += 1;
    steps.push(step);
    shared.count += 1;
    grow(STEP_OVERHEAD + step.label.length + detailSize(step.detail));
    return step;
  }

  // Terminal Pi has no approval step; a session driven over the pipe has the app's gate. The marker entry says which, and
  // it comes early, so the start step is updated when it is seen.
  function approvalNote() {
    return transport === null
      ? 'Terminal Pi has no approval step: every call runs without being asked.'
      : 'Driven over the pipe: the app\'s gate asks before a gated call. An answer is not recorded; a refusal shows as a refused call.';
  }

  function ensureStart(ctx) {
    if (startStep) return;
    startStep = addStep(ctx, 'start', 'Session start', { approvals: approvalNote() });
    if (startStep) startStep.tokens = evidence(null, 'tokens', 'unknown', 'No request has been made yet, so the total is not known.');
  }

  function windowOf() {
    const w = modelWindows.contextWindow({ lastProvider: provider, lastModel: model });
    return w && w.windowTokens > 0 ? w.windowTokens : null;
  }

  function checkpointOf(input, window, note) {
    return {
      input: evidence(input, 'tokens', 'measured', note),
      window: window > 0
        ? evidence(window, 'tokens', 'measured', 'The context window of this model in Pi\'s own catalog.')
        : evidence(null, 'tokens', 'unknown', 'Pi\'s model catalog lists no window for this model.'),
      model,
    };
  }

  function onInstructions(sections, ctx) {
    instructionsSeen = true;
    const pc = typeof sections.project_context === 'string' ? sections.project_context : '';
    PROJECT_INSTRUCTIONS.lastIndex = 0;
    for (let m = PROJECT_INSTRUCTIONS.exec(pc); m; m = PROJECT_INSTRUCTIONS.exec(pc)) {
      const chars = m[2].length;
      const step = addStep(ctx, 'instructions', instructionLabel(m[1], cwd, home), { characters: chars }, { parentStepId: startStep ? startStep.id : undefined });
      if (step) step.tokens = evidence(Math.ceil(chars / 4), 'tokens', 'estimated', 'About characters / 4, not a measured count. The file is part of the first request\'s input.');
      if (step && !startStep) delete step.parentStepId;
    }
  }

  function onUser(content, ctx) {
    const text = textOfContent(content, DETAIL_CHARS * 2);
    if (!text.trim()) return;
    turn += 1;
    addStep(ctx, 'prompt', firstLine(text) || 'Prompt', { text: trunc(text, DETAIL_CHARS) });
  }

  // The user's own `!` shell line: an action of theirs, shown as an event, starting no turn.
  function onShell(m, ctx) {
    const cmd = typeof m.command === 'string' ? m.command : '';
    const first = firstLine(cmd);
    addStep(ctx, 'event', first ? `Shell command: ${first}` : 'Shell command', { text: trunc(cmd, DETAIL_CHARS) });
  }

  function onToolCall(block, ctx) {
    const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
    const args = isObject(block.arguments) ? block.arguments : {};
    const brief = briefOfArguments(args);
    const detail = { tool: trunc(name, 100), input: trunc(brief, DETAIL_CHARS) };
    if (name === SUBAGENT_TOOL) {
      detail.kind = 'agent';
      if (typeof args.agent === 'string' && args.agent) detail.agent = trunc(args.agent, 100);
    }
    const step = addStep(ctx, 'tool', brief ? `${name}: ${firstLine(brief)}` : name, detail);
    if (step && typeof block.id === 'string' && block.id) {
      pendingTools.set(block.id, step);
      if (pendingTools.size > MAX_PENDING_TOOLS) pendingTools.delete(pendingTools.keys().next().value);
    }
    return step;
  }

  function onAssistant(m, ctx) {
    if (typeof m.model === 'string' && m.model) model = m.model;
    if (typeof m.provider === 'string' && m.provider) provider = m.provider;
    const u = isObject(m.usage) ? m.usage : {};
    const sum = (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
    let hasStep = false;
    let carrier = null;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!isObject(b)) continue;
      let step = null;
      if (b.type === 'thinking') {
        const text = typeof b.thinking === 'string' ? b.thinking : '';
        step = addStep(ctx, 'thinking', 'Thinking', text ? { text: trunc(text, DETAIL_CHARS) } : {});
      } else if (b.type === 'text') {
        if (typeof b.text === 'string' && b.text.trim()) step = addStep(ctx, 'output', firstLine(b.text) || 'Output', { text: trunc(b.text, DETAIL_CHARS) });
      } else if (b.type === 'toolCall') {
        step = onToolCall(b, ctx);
      }
      if (step) { hasStep = true; if (!carrier) carrier = step; }
    }
    if (sum > 0) {
      // The usage of a request is its input: what was sent, the cached part included (spec 28).
      const checkpoint = checkpointOf(sum, windowOf(), 'Input of this request (input + cacheRead + cacheWrite).');
      if (!hasStep) carrier = addStep(ctx, 'checkpoint', 'Request', {});
      if (carrier && !carrier.checkpoint) carrier.checkpoint = checkpoint;
    }
    // A stopped turn writes a record with no usage (measured, spec 28): it is an interrupt, never an empty window.
    if (m.stopReason === 'aborted') addStep(ctx, 'interrupt', 'Interrupted', { reason: 'aborted' });
    else if (m.stopReason === 'error') addStep(ctx, 'event', 'The model call failed', typeof m.errorMessage === 'string' && m.errorMessage ? { text: trunc(m.errorMessage, DETAIL_CHARS) } : {});
  }

  function onToolResult(m) {
    const id = typeof m.toolCallId === 'string' ? m.toolCallId : '';
    const step = id ? pendingTools.get(id) : null;
    if (!step) return;
    pendingTools.delete(id);
    const raw = textOfContent(m.content, RESULT_CHARS);
    const result = trunc(raw, DETAIL_CHARS);
    step.detail.result = result;
    step.detail.status = m.isError === true ? 'error' : 'ok';
    if (m.isError === true) {
      // Pi records the failure itself, so the evidence is `structured`.
      const flag = { axis: 'outcome', code: 'tool-error', why: 'the tool result is marked as an error', evidence: 'structured' };
      step.flags.push(flag);
      grow(flagSize(flag));
      // The pi-native gate's refusal is the one result with exactly this text (`../pi-native/runtime-extension.js`).
      if (raw.trim() === `The user did not allow this ${step.detail.tool} call.`) step.detail.refused = true;
    }
    if (step.detail.tool === SUBAGENT_TOOL) {
      const summary = subagentSummary(raw);
      if (summary) Object.assign(step.detail, summary);
    }
    grow(40 + result.length + 60);
  }

  function onCompaction(obj, ctx) {
    // "Before" is `tokensBefore`; the entry's own `usage` is the summarising call and is never read. "After" is filled in
    // `close()`, from the next request on the active branch.
    const before = Number.isFinite(obj.tokensBefore) && obj.tokensBefore > 0 ? obj.tokensBefore : null;
    const step = addStep(ctx, 'compaction', 'Compaction', { before: before === null ? 'unknown' : before });
    if (step && before !== null) step.checkpoint = checkpointOf(before, windowOf(), 'The context size Pi recorded before the compaction (tokensBefore).');
  }

  function onMessage(obj, ctx) {
    const m = isObject(obj.message) ? obj.message : null;
    if (!m) return;
    switch (m.role) {
      case 'system':
        if (isObject(m.sections)) onInstructions(m.sections, ctx);
        break;
      case 'user': onUser(m.content, ctx); break;
      case 'assistant': onAssistant(m, ctx); break;
      case 'toolResult': onToolResult(m); break;
      case 'bashExecution': onShell(m, ctx); break;
      default: break;
    }
  }

  // A skipped line: its head gives the real link when it can; else the next entry's unknown parent is bridged.
  function noteSkipped(link) {
    if (link) {
      parentOf.set(link.id, link.parent);
      leafId = link.id;
      gapOpen = false;
    } else {
      gapOpen = true;
      gapFrom = leafId;
    }
  }

  // An unparsable line is counted only once a line follows it: the last line of a transcript being written may be half a line.
  let pendingBad = null;
  function commitBad() {
    if (!pendingBad) return;
    const link = pendingBad.link;
    pendingBad = null;
    shared.skippedLines += 1;
    limitation('line-unparsed', 'A line could not be parsed and was skipped; the steps in it are missing.');
    noteSkipped(link);
  }

  function onLine(text, lineNo, offset) {
    commitBad();
    let obj;
    try { obj = JSON.parse(text); } catch {
      pendingBad = { link: linkOf(text.slice(0, 512)) };
      return shared.stopReason !== null;
    }
    if (!isObject(obj)) return false;
    const ctx = { lineNo, offset, part: 0, ts: entryTime(obj, isObject(obj.message) ? obj.message : null) };
    if (obj.type !== 'session' && typeof obj.id === 'string' && obj.id) {
      ctx.entryId = obj.id;
      const parent = typeof obj.parentId === 'string' && obj.parentId ? obj.parentId : null;
      // A line was skipped (over the cap, or unparsable) and its head showed no link, so an entry may name a parent this pass
      // never saw. Such an entry was almost always the next one after the skipped line: bridge the unknown id to the entry
      // before the gap, or the walk would stop there and cut all earlier history (measured: two skipped image lines hid
      // 1 300 of 1 600 steps).
      if (gapOpen && parent && !parentOf.has(parent)) parentOf.set(parent, gapFrom);
      gapOpen = false;
      parentOf.set(obj.id, parent);
      leafId = obj.id;
    }
    ensureStart(ctx);
    switch (obj.type) {
      case 'session':
        if (cwd === null && typeof obj.cwd === 'string') cwd = obj.cwd;
        break;
      case 'model_change':
        if (typeof obj.modelId === 'string' && obj.modelId) model = obj.modelId;
        if (typeof obj.provider === 'string' && obj.provider) provider = obj.provider;
        break;
      case 'custom': {
        const t = transportFromEntry(obj);
        if (t) {
          transport = t;
          if (startStep) startStep.detail.approvals = approvalNote();
        }
        break;
      }
      case 'message': onMessage(obj, ctx); break;
      case 'compaction': onCompaction(obj, ctx); break;
      default: break;
    }
    return shared.stopReason !== null;
  }

  function onOversize(lineNo, offset, bytes, head) {
    commitBad();
    shared.skippedLines += 1;
    const link = linkOf(head);
    noteSkipped(link);
    limitation('line-over-cap', 'A line exceeded the size cap and was skipped unread; the steps in it are missing.');
    const ctx = { lineNo, offset, part: 0, ts: null };
    if (link) ctx.entryId = link.id;   // the marker step belongs to its entry's branch
    ensureStart(ctx);
    const step = addStep(ctx, 'event', 'A line exceeded the size cap', { bytes });
    if (step) step.tokens = evidence(null, 'bytes', 'unknown', 'The line was not read.');
    return shared.stopReason !== null;
  }

  // Keeps the steps of the active branch (the ones not tied to an entry stay), renumbers `ordinal` and `turn`, and fills in
  // what depends on the order: a compaction's `after` and the start step's first-request total.
  function close() {
    let keep = steps;
    if (leafId !== null) {
      const on = new Set(activeChain((id) => parentOf.get(id) || null, leafId));
      keep = steps.filter(st => !stepEntry.has(st) || on.has(stepEntry.get(st)));
    }
    let turn = 0;
    let pending = null;
    let first = true;
    keep.forEach((st, i) => {
      st.ordinal = i;
      if (st.kind === 'prompt') turn += 1;
      st.turn = turn || null;
      if (st.kind === 'compaction') {
        if (pending) pending.detail.after = 'unknown'; // two in a row: no request between them
        pending = st;
      } else if (st.checkpoint) {
        const input = st.checkpoint.input.value;
        if (pending) { pending.detail.after = input; pending = null; }
        if (first && startStep) {
          startStep.tokens = evidence(input, 'tokens', 'measured', "The first request's input; it also counts input the transcript does not list (system prompt, tool definitions).");
        }
        first = false;
      }
    });
    if (pending) pending.detail.after = 'unknown';
    if (startStep && !instructionsSeen) {
      limitation('instructions-not-recorded', 'This session records no instruction files (a Pi version before the system message was stored), so none are shown.');
    }
    if (keep !== steps) { steps.length = 0; for (const st of keep) steps.push(st); }
    return steps;
  }

  return { onLine, onOversize, close, steps, hasStart: () => startStep !== null };
}

/**
 * The flow of one Pi session. `sources` is what `sessionFlow(row)` answered; the main transcript is the one with
 * `laneHint: 'main'` (else the first). Async: the file is streamed. Never rejects for a read problem: an unreadable file, an
 * abort and every cap end in a snapshot whose `complete` is false and whose limitations say why. `opts`: `signal`, and for
 * tests `maxLineBytes`, `maxSteps`, `maxBytes`.
 */
async function readSessionFlow(sources, opts = {}) {
  const list = Array.isArray(sources) ? sources.filter(isObject) : [];
  const source = list.find(s => s.laneHint === 'main') || list[0] || null;
  const limits = { maxSteps: opts.maxSteps || MAX_STEPS, maxBytes: opts.maxBytes || MAX_SNAPSHOT_BYTES };
  const shared = { count: 0, size: 0, stopReason: null, skippedLines: 0, limitations: [], limitationIds: new Set() };
  const main = makeBuilder(source && source.sourceId ? source.sourceId : 'main', limits, shared);
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
  if (aborted) limitation('aborted', 'The read was cancelled before the end of the transcript.');
  if (failed) limitation('read-failed', 'The transcript could not be read.');
  if (noSources) { limitation('nothing-read', 'Nothing was read from this session.'); complete = false; }
  else if (!failed && !main.hasStart()) limitation('empty-transcript', 'The transcript holds no lines yet.');
  const caps = {};
  for (const id of Object.keys(CAPABILITIES)) caps[id] = { ...CAPABILITIES[id] };
  return {
    schemaVersion: 1,
    snapshotId: `pi-${Date.now().toString(36)}`,
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
