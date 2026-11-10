// --- The neutral shape of a session's flow (spec 46, #826) ---
//
// What the Flow tab, the exports and the tests see. No vendor record and no vendor field name passes this
// module: each backend's `readSessionFlow` turns its own transcript into a `FlowSnapshot`, and everything
// downstream reads only that. The vocabulary (kinds, evidence bases, flag axes, capability states) is the
// part more than one process needs, so it is written once here.
//
// WHY `src/shared/` and not beside the backends: the readers run in main or a worker thread, and the layout
// (`src/shared/flow-layout.js`, T7) and the Flow panel run in the renderer; both sides need the same kinds
// and the same capability words, and two copies would be the drift `.claude/rules/renderer.md`
// ("src/shared/") exists to prevent. Pure data and string work: no fs, no path, no DOM, no crypto, so it
// loads in a worker too.
//
// UNTIL T7/T8 this is a main/worker-only module: no `<script>` tag and no entry in
// `test/fixtures/script-order.json`. That makes it a temporary third exception to the `src/shared/` rule
// ("both processes load"), recorded in spec 46. T7/T8 add the tag and the script-order entry when the
// renderer first loads it.
//
// The whole body is wrapped, so loading it as a classic script adds ONE global (`FlowSnapshot`) and none of
// the helper names below. (A top-level `const` in a classic script lands in the shared script scope, not on
// `window`, and a helper with a generic name would collide with a renderer file.) In main, a worker and the
// node tests it is `require()`d.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowSnapshot = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FLOW_SCHEMA_VERSION = 1;

  // A step's kind. The renderer draws by kind, never by a backend's record type.
  const FLOW_STEP_KINDS = Object.freeze([
    'start',        // the session's first request: model, mode, the totals at the start
    'instructions', // one instruction file (child of the start step) or the single block a backend only has
    'prompt',       // a user turn
    'thinking',
    'tool',         // a tool call with its result, when there is one
    'output',       // the assistant's text
    'interrupt',
    'compaction',   // carries before/after in `detail` and `checkpoint`
    'mode',         // a permission or approval mode change (on change only)
    'agent',        // a spawn or a return in another lane (or a collapsed call)
    'checkpoint',   // a measured request input with no event of its own
    'event',        // anything else worth a row that is none of the above
  ]);

  const FLOW_LANE_KINDS = Object.freeze(['main', 'agent', 'collapsedCall', 'session']);

  // How a figure is known. `measured` is read from the transcript for this request, `estimated` is derived
  // (about characters / 4 for an instruction file), `included` is a part of a figure counted elsewhere,
  // `unknown` is a figure the transcript does not give.
  const FLOW_EVIDENCE_BASES = Object.freeze(['measured', 'estimated', 'included', 'unknown']);

  // Flags are facts on separate axes and may coexist on one step.
  const FLOW_FLAG_AXES = Object.freeze(['risk', 'outcome', 'attention', 'lifecycle']);
  const FLOW_FLAG_EVIDENCE = Object.freeze(['structured', 'heuristic']);

  // What a backend can answer. `state` is yes | partial | no; `instructionFiles` says how, instead.
  const FLOW_CAPABILITY_IDS = Object.freeze([
    'agents', 'instructionFiles', 'contextCheckpoints', 'permissionMode',
    'approvals', 'compaction', 'interrupt', 'destructivePatterns', 'timestamps',
  ]);
  const FLOW_CAPABILITY_STATES = Object.freeze(['yes', 'partial', 'no']);
  const FLOW_INSTRUCTION_FILE_STATES = Object.freeze(['perFile', 'block', 'none']);

  // The keys a step's `source` may carry. A path never does: `sourceId` is opaque and the file stays in main.
  const SOURCE_KEYS = Object.freeze(['sourceId', 'line', 'byteOffset']);

  // Stop collecting after this many problems; a broken reader should not make the validator build a huge list.
  const MAX_ERRORS = 50;

  const NOTHING_READ = Object.freeze({ id: 'nothing-read', text: 'Nothing was read from this session.' });

  /**
   * A step's id, unique by construction: the lane, the source, the line, the byte offset and the step's
   * index within its line (`part`, for a line that yields several steps) in clear. Never a hash, never the
   * index in the rendered array, so the same line read twice, or after the file grew at its end, gives the
   * same id. The pieces are opaque ids and numbers; no path is among them.
   */
  function flowStepId(laneId, source, part) {
    const s = source || {};
    return ['s', laneId, s.sourceId, s.line, s.byteOffset, part || 0].join(':');
  }

  /**
   * A valid snapshot that holds nothing. Every capability that is not `yes` names a limitation (the rule
   * `validateSnapshot` enforces): the caller's, or one saying that nothing was read.
   */
  function emptyFlowSnapshot({ capabilities, limitations } = {}) {
    const lims = Array.isArray(limitations) && limitations.length ? limitations.slice() : [NOTHING_READ];
    const caps = {};
    for (const id of FLOW_CAPABILITY_IDS) {
      caps[id] = (capabilities && capabilities[id]) || { state: id === 'instructionFiles' ? 'none' : 'no', limitationId: lims[0].id };
    }
    return {
      schemaVersion: FLOW_SCHEMA_VERSION,
      snapshotId: 'empty',
      fingerprint: null,
      capabilities: caps,
      limitations: lims,
      lanes: [],
      steps: [],
      nextCursor: null,
      complete: true,
    };
  }

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /**
   * Checks a snapshot against the shape. Never throws, one pass over lanes and steps. `{ ok, errors }`,
   * with at most the first MAX_ERRORS problems. A version this code does not know is declined and nothing
   * else is checked (a reader of a newer version declines rather than guesses).
   */
  function validateSnapshot(snap) {
    const errors = [];
    let truncated = false;
    const add = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); else truncated = true; };
    const done = () => {
      if (truncated) errors.push(`more problems omitted after the first ${MAX_ERRORS}`);
      return { ok: errors.length === 0, errors };
    };
    const checkEvidence = (ev, where) => {
      if (!isObject(ev)) { add(`${where}: evidence must be an object`); return; }
      if (!FLOW_EVIDENCE_BASES.includes(ev.basis)) add(`${where}: evidence basis '${ev.basis}' is not one of ${FLOW_EVIDENCE_BASES.join(', ')}`);
    };

    if (!isObject(snap)) return { ok: false, errors: ['snapshot must be an object'] };
    if (snap.schemaVersion !== FLOW_SCHEMA_VERSION) {
      return { ok: false, errors: [`schemaVersion ${JSON.stringify(snap.schemaVersion)} is not supported (this code reads ${FLOW_SCHEMA_VERSION})`] };
    }
    if (typeof snap.snapshotId !== 'string' || !snap.snapshotId) add('snapshotId must be a non-empty string');
    if (snap.fingerprint !== null && typeof snap.fingerprint !== 'string' && !isObject(snap.fingerprint) && !Array.isArray(snap.fingerprint)) {
      add('fingerprint must be null, a string or an object');
    }
    if (typeof snap.complete !== 'boolean') add('complete must be a boolean');
    if (snap.nextCursor !== null && typeof snap.nextCursor !== 'string') add('nextCursor must be null or a string');

    const limitationIds = new Set();
    if (!Array.isArray(snap.limitations)) {
      add('limitations must be an array');
    } else {
      for (const [i, l] of snap.limitations.entries()) {
        if (!isObject(l) || typeof l.id !== 'string' || !l.id || typeof l.text !== 'string' || !l.text) { add(`limitations[${i}] needs a string id and a non-empty text`); continue; }
        if (limitationIds.has(l.id)) add(`limitations[${i}]: duplicate limitation id '${l.id}'`);
        limitationIds.add(l.id);
      }
    }

    // A capability that is not fully there says why: `limitationId` names an entry of `limitations`.
    if (!isObject(snap.capabilities)) {
      add('capabilities must be an object');
    } else {
      for (const id of FLOW_CAPABILITY_IDS) {
        const c = snap.capabilities[id];
        if (!isObject(c)) { add(`capabilities.${id} is missing`); continue; }
        const isFiles = id === 'instructionFiles';
        const allowed = isFiles ? FLOW_INSTRUCTION_FILE_STATES : FLOW_CAPABILITY_STATES;
        if (!allowed.includes(c.state)) { add(`capabilities.${id}.state '${c.state}' is not one of ${allowed.join(', ')}`); continue; }
        const full = isFiles ? c.state === 'perFile' : c.state === 'yes';
        if (c.limitationId != null && typeof c.limitationId !== 'string') add(`capabilities.${id}.limitationId must be a string or null`);
        else if (typeof c.limitationId === 'string' && !limitationIds.has(c.limitationId)) add(`capabilities.${id}.limitationId '${c.limitationId}' names no limitation`);
        else if (!full && c.limitationId == null) add(`capabilities.${id} is '${c.state}' and must carry a limitationId naming a limitation`);
      }
    }

    const laneIds = new Set();
    const lanes = Array.isArray(snap.lanes) ? snap.lanes : null;
    if (!lanes) {
      add('lanes must be an array');
    } else {
      for (const [i, lane] of lanes.entries()) {
        if (!isObject(lane) || typeof lane.id !== 'string') { add(`lanes[${i}] needs a string id`); continue; }
        if (laneIds.has(lane.id)) add(`lanes[${i}]: duplicate lane id '${lane.id}'`);
        laneIds.add(lane.id);
        if (!FLOW_LANE_KINDS.includes(lane.kind)) add(`lanes[${i}]: kind '${lane.kind}' is not one of ${FLOW_LANE_KINDS.join(', ')}`);
      }
    }

    const stepIds = new Set();
    if (!Array.isArray(snap.steps)) {
      add('steps must be an array');
    } else {
      for (const [i, step] of snap.steps.entries()) {
        const where = `steps[${i}]`;
        if (!isObject(step) || typeof step.id !== 'string') { add(`${where} needs a string id`); continue; }
        if (stepIds.has(step.id)) add(`${where}: duplicate step id '${step.id}'`);
        stepIds.add(step.id);
        if (!FLOW_STEP_KINDS.includes(step.kind)) add(`${where}: kind '${step.kind}' is not one of ${FLOW_STEP_KINDS.join(', ')}`);
        if (!laneIds.has(step.laneId)) add(`${where}: laneId '${step.laneId}' names no lane`);
        if (!Number.isFinite(step.ordinal)) add(`${where}: ordinal must be a number`);
        if (typeof step.label !== 'string') add(`${where}: label must be a string`);
        if (step.turn != null && !Number.isFinite(step.turn)) add(`${where}: turn must be null or a number`);
        if (step.ts != null && !Number.isFinite(step.ts)) add(`${where}: ts must be null or a number`);
        if (!isObject(step.source)) add(`${where}: source must be an object`);
        else {
          for (const k of Object.keys(step.source)) if (!SOURCE_KEYS.includes(k)) add(`${where}.source: key '${k}' is not one of ${SOURCE_KEYS.join(', ')} (no path leaves main)`);
        }
        if (step.tokens != null) checkEvidence(step.tokens, `${where}.tokens`);
        if (step.checkpoint != null) {
          if (!isObject(step.checkpoint)) add(`${where}.checkpoint must be null or an object`);
          else {
            checkEvidence(step.checkpoint.input, `${where}.checkpoint.input`);
            checkEvidence(step.checkpoint.window, `${where}.checkpoint.window`);
          }
        }
        if (!Array.isArray(step.flags)) add(`${where}.flags must be an array`);
        else {
          for (const [j, f] of step.flags.entries()) {
            if (!isObject(f) || !FLOW_FLAG_AXES.includes(f.axis)) add(`${where}.flags[${j}]: axis must be one of ${FLOW_FLAG_AXES.join(', ')}`);
            else if (!FLOW_FLAG_EVIDENCE.includes(f.evidence)) add(`${where}.flags[${j}]: evidence must be one of ${FLOW_FLAG_EVIDENCE.join(', ')}`);
          }
        }
      }
    }

    // Links between lanes and steps are checked last, when every id is known.
    // `parentStepId` is optional (an instruction file names its start step); present, it must name a step of this snapshot.
    if (Array.isArray(snap.steps)) {
      for (const [i, step] of snap.steps.entries()) {
        if (isObject(step) && step.parentStepId != null && !stepIds.has(step.parentStepId)) add(`steps[${i}]: parentStepId '${step.parentStepId}' names no step`);
      }
    }
    if (lanes) {
      const anchorOk = (a) => isObject(a) && laneIds.has(a.laneId) && stepIds.has(a.stepId);
      for (const [i, lane] of lanes.entries()) {
        if (!isObject(lane)) continue;
        if (lane.parentLaneId != null && !laneIds.has(lane.parentLaneId)) add(`lanes[${i}]: parentLaneId '${lane.parentLaneId}' names no lane`);
        if (lane.spawnAnchor != null && !anchorOk(lane.spawnAnchor)) add(`lanes[${i}]: spawnAnchor must name a lane and a step that exist`);
        if (lane.returnAnchor != null && !anchorOk(lane.returnAnchor)) add(`lanes[${i}]: returnAnchor must name a lane and a step that exist`);
      }
    }
    return done();
  }

  return Object.freeze({
    FLOW_SCHEMA_VERSION,
    FLOW_STEP_KINDS,
    FLOW_LANE_KINDS,
    FLOW_EVIDENCE_BASES,
    FLOW_FLAG_AXES,
    FLOW_FLAG_EVIDENCE,
    FLOW_CAPABILITY_IDS,
    FLOW_CAPABILITY_STATES,
    FLOW_INSTRUCTION_FILE_STATES,
    flowStepId,
    emptyFlowSnapshot,
    validateSnapshot,
  });
});
