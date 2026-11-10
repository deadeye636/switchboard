// --- Layout and collapse for the session flow (spec 46, #826) ---
//
// A `FlowSnapshot` (src/shared/flow-snapshot.js) plus the user's collapse state in; rows, columns, turns
// and connector descriptions out. Pure: no DOM, no fs, no clock. The Flow panel, the SVG export, the PDF
// pages and the Mermaid text all read this one model, so none of them decides collapsing for itself.
// It reads only the neutral shape (CLAUDE.md reflex 5): no backend id, no vendor record, no vendor field.
//
// WHAT COLLAPSES (spec 46 req. 7, O7 and O9 decided)
//   - A run of equivalent tool calls: same tool, same lane, same turn, no flags, adjacent (adjacent = next
//     in the snapshot's step order, which is the row order). Only a `tool` step can join a run, so a prompt,
//     a mode change, a compaction, an agent spawn or return and an interrupt each end it by what they ARE.
//     A failure ends it because a failure is a flag (axis `outcome`) and a flagged step never joins. That
//     puts a duty on the readers: a failed tool call must carry an outcome flag, or it will collapse.
//   - A finished agent lane (kind `agent` with a `returnAnchor`) is one summary row in its column. A lane
//     below a collapsed lane has no column and no row; its steps are only counted.
//   - A collapsed lane summary inherits the union of its members' flags (axis, code and evidence kept, with
//     a count). A group of equivalent tool calls inherits nothing today: O7 admits no flagged member, so
//     its union is empty by construction.
//
// COLLAPSE STATE (O9: in memory per session, no setting). `{ groups: {key: bool}, lanes: {laneId: bool} }`,
// `true` = expanded. A missing entry means the default: groups collapsed, finished agent lanes collapsed.
// The helpers return a new object; they never mutate the one they are given.
//
// KEYS. A step row's key is the step id. A group's key is `g:` + its FIRST member's id, a lane summary's is
// `l:` + the lane id: none depends on the rendered index, so selection and the scroll anchor survive a
// re-layout. (A group that grows at its end keeps its key; a lone call that becomes a group changes row key.)
//
// PERFORMANCE (owner constraint: nothing blocks the renderer). One linear pass over `steps`; a collapsed
// child costs a counter bump and a flag union, no row object. Connectors are NOT one path per step: a lane is
// one rail, the layout holds a handful of spawn/return edges, and `connectorsForRows` returns only those
// touching the visible row window, capped. Measured numbers live in test/flow-layout.test.js and the T7 report.
//
// LOADING. UNTIL T8 this is loaded by node tests only: no `<script>` tag and no entry in
// `test/fixtures/script-order.json` (T8 adds both when the renderer first loads it). The whole body is
// wrapped, so as a classic script it adds ONE global (`FlowLayout`) and none of the helper names below.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_CONNECTOR_CAP = 200;
  const EMPTY_FLAGS = Object.freeze([]);

  // Collapse maps have no prototype and are read only through `own`, so an id such as `constructor` or `__proto__` is an
  // ordinary key and not a property of Object.prototype.
  function emptyCollapseState() { return { groups: Object.create(null), lanes: Object.create(null) }; }
  function own(map, key) { return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined; }

  function withEntry(state, field, key, value) {
    const base = state || {};
    const next = { groups: base.groups || Object.create(null), lanes: base.lanes || Object.create(null) };
    const copy = Object.create(null);
    const from = next[field];
    for (const k of Object.keys(from)) copy[k] = from[k];
    copy[key] = !!value;
    next[field] = copy;
    return next;
  }
  /** New state with one group expanded or collapsed; every other entry is carried over untouched. */
  function setGroupExpanded(state, groupKey, expanded) { return withEntry(state, 'groups', groupKey, expanded); }
  /** New state with one lane expanded or collapsed. */
  function setLaneExpanded(state, laneId, expanded) { return withEntry(state, 'lanes', laneId, expanded); }

  // The tool a `tool` step stands for. The neutral shape has no dedicated field, so a reader that has the
  // tool name puts it in `detail.tool`; a reader that does not leaves it to the label.
  function toolKey(step) {
    const d = step.detail;
    return d && typeof d.tool === 'string' && d.tool ? d.tool : step.label;
  }

  /**
   * Per lane: its column, whether it is hidden under a collapsed ancestor, and whether it is itself a
   * collapsed summary. One pass over the lanes (not the steps).
   */
  function resolveLanes(lanes, state) {
    const lanesState = (state && state.lanes) || {};
    const byId = new Map();
    for (const lane of lanes) byId.set(lane.id, { lane, ownCollapsed: false, under: false, owner: null, col: -1, row: null, visiting: false, done: false, first: -1, last: -1, count: 0, flags: null, summary: null });
    const resolve = (m) => {
      if (m.done || m.visiting) return m; // a parent cycle is read as "no parent": validateSnapshot would have named it
      m.visiting = true;
      const lane = m.lane;
      const explicit = own(lanesState, lane.id);
      m.ownCollapsed = lane.kind === 'main' ? false
        : (explicit !== undefined ? !explicit : lane.kind === 'agent' && lane.returnAnchor != null);
      const parent = lane.parentLaneId != null ? byId.get(lane.parentLaneId) : null;
      if (parent) {
        resolve(parent);
        m.under = parent.ownCollapsed || parent.under;
      }
      m.owner = m.under ? parent.owner || (parent.ownCollapsed ? parent : null)
        : (m.ownCollapsed ? m : null);
      m.visiting = false;
      m.done = true;
      return m;
    };
    let col = 0;
    for (const m of byId.values()) {
      resolve(m);
      if (!m.under) m.col = col++;
    }
    return byId;
  }

  /**
   * Snapshot + collapse state in; rows, columns, turns, rails and edges out.
   *
   * Row: { key, index, kind: 'step' | 'group' | 'lane', col, laneId, turn, depth, step, firstStepId, tool,
   *        count, expanded, groupKey, flags }
   * `step` is set on step rows only; a group or lane row names its first step in `firstStepId`.
   * `depth` is 1 for a member row under an expanded group, else 0.
   */
  function layout(snapshot, state) {
    const steps = (snapshot && snapshot.steps) || [];
    const lanes = (snapshot && snapshot.lanes) || [];
    const groupsState = (state && state.groups) || {};
    const metas = resolveLanes(lanes, state);

    // Only the steps the edges point at need their row remembered; the rest of the pass keeps no per-step map.
    const anchorIds = new Set();
    for (const lane of lanes) {
      if (lane.spawnAnchor && lane.spawnAnchor.stepId != null) anchorIds.add(lane.spawnAnchor.stepId);
      if (lane.returnAnchor && lane.returnAnchor.stepId != null) anchorIds.add(lane.returnAnchor.stepId);
    }
    const anchorRows = new Map();

    const rows = [];
    const turns = [];
    const summaries = [];
    const stats = { steps: steps.length, rows: 0, groups: 0, hiddenSteps: 0 };
    let curTurn; // `undefined` until the first row
    let run = null;

    const colOf = (laneId) => { const m = metas.get(laneId); return m && m.col >= 0 ? m.col : 0; };
    const push = (row, laneId) => {
      row.index = rows.length;
      rows.push(row);
      const last = turns.length ? turns[turns.length - 1] : null;
      if (!last || row.turn !== curTurn) { turns.push({ turn: row.turn, startRow: row.index, endRow: row.index }); curTurn = row.turn; }
      else last.endRow = row.index;
      const m = metas.get(laneId);
      if (m) { if (m.first < 0) m.first = row.index; m.last = row.index; }
      return row;
    };
    const noteAnchor = (stepId, rowIndex) => { if (anchorIds.size && anchorIds.has(stepId)) anchorRows.set(stepId, rowIndex); };

    const stepRow = (step, depth, groupKey) => {
      const row = push({
        key: step.id, index: 0, kind: 'step', col: colOf(step.laneId), laneId: step.laneId, turn: step.turn == null ? null : step.turn,
        depth, step, firstStepId: step.id, tool: null, count: 1, expanded: false, groupKey: groupKey || null,
        flags: step.flags && step.flags.length ? step.flags : EMPTY_FLAGS,
      }, step.laneId);
      noteAnchor(step.id, row.index);
      return row;
    };

    const flush = () => {
      if (!run) return;
      const r = run;
      run = null;
      if (r.count === 1) { stepRow(steps[r.first], 0, null); return; }
      const first = steps[r.first];
      const key = 'g:' + first.id;
      const expanded = own(groupsState, key) === true;
      stats.groups++;
      const head = push({
        key, index: 0, kind: 'group', col: colOf(first.laneId), laneId: first.laneId, turn: first.turn == null ? null : first.turn,
        depth: 0, step: null, firstStepId: first.id, tool: r.tool, count: r.count, expanded, groupKey: key, flags: EMPTY_FLAGS,
      }, first.laneId);
      if (expanded) {
        noteAnchor(first.id, head.index);
        for (const i of r.idxs) stepRow(steps[i], 1, key);
      } else if (anchorIds.size) {
        for (const i of r.idxs) noteAnchor(steps[i].id, head.index);
      }
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const meta = metas.get(step.laneId);

      // A step in a collapsed lane (or below one) is counted into its summary; no row of its own.
      const owner = meta && meta.owner;
      if (owner) {
        if (!owner.summary) {
          flush();
          owner.flagMap = null;
          owner.summary = push({
            key: 'l:' + owner.lane.id, index: 0, kind: 'lane', col: owner.col, laneId: owner.lane.id,
            turn: step.turn == null ? null : step.turn, depth: 0, step: null, firstStepId: step.id, tool: null, count: 0,
            expanded: false, groupKey: null, flags: EMPTY_FLAGS,
          }, owner.lane.id);
          summaries.push(owner);
        }
        owner.summary.count++;
        stats.hiddenSteps++;
        if (step.flags && step.flags.length) {
          const map = owner.flagMap || (owner.flagMap = new Map());
          for (const f of step.flags) {
            const k = f.axis + '|' + f.code + '|' + f.evidence;
            const have = map.get(k);
            if (have) have.count++;
            else map.set(k, { axis: f.axis, code: f.code, why: f.why, evidence: f.evidence, count: 1 });
          }
        }
        noteAnchor(step.id, owner.summary.index);
        continue;
      }

      const equivalent = step.kind === 'tool' && !(step.flags && step.flags.length);
      if (equivalent) {
        const tool = toolKey(step);
        if (run && run.laneId === step.laneId && run.turn === step.turn && run.tool === tool) {
          if (!run.idxs) run.idxs = [run.first, i]; else run.idxs.push(i);
          run.count++;
        } else {
          flush();
          run = { first: i, laneId: step.laneId, turn: step.turn, tool, count: 1, idxs: null };
        }
      } else {
        flush();
        stepRow(step, 0, null);
      }
    }
    flush();

    for (const m of summaries) {
      if (m.flagMap) m.summary.flags = Array.from(m.flagMap.values());
      m.flagMap = null;
    }
    stats.rows = rows.length;

    // Columns: every lane not hidden under a collapsed one, in lane order.
    const columns = [];
    for (const lane of lanes) {
      const m = metas.get(lane.id);
      if (!m || m.under) continue;
      columns.push({ col: m.col, laneId: lane.id, label: lane.label == null ? '' : lane.label, kind: lane.kind, depth: lane.depth || 0, collapsed: m.ownCollapsed });
    }

    // One rail per lane that has rows; a handful of spawn/return edges. Nothing here scales with steps.
    const rails = [];
    const edges = [];
    for (const lane of lanes) {
      const m = metas.get(lane.id);
      if (!m || m.under || m.first < 0) continue;
      rails.push({ laneId: lane.id, col: m.col, fromRow: m.first, toRow: m.last });
      const sa = lane.spawnAnchor;
      if (sa && anchorRows.has(sa.stepId)) {
        edges.push({ kind: 'spawn', laneId: lane.id, fromRow: anchorRows.get(sa.stepId), fromCol: colOf(sa.laneId), toRow: m.first, toCol: m.col });
      }
      const ra = lane.returnAnchor;
      if (ra && anchorRows.has(ra.stepId)) {
        edges.push({ kind: 'return', laneId: lane.id, fromRow: m.last, fromCol: m.col, toRow: anchorRows.get(ra.stepId), toCol: colOf(ra.laneId) });
      }
    }

    return { rows, columns, turns, rails, edges, stats };
  }

  /**
   * The connectors a window of rows [a, b] needs, at most `cap` (default ~200). A rail is clipped to the
   * window; a spawn or return edge is listed when either end lies inside it. Reads the small rail and edge
   * lists the layout already holds, so it costs the number of lanes, not of steps or rows.
   * Returns `{ connectors, truncated }`.
   */
  function connectorsForRows(lay, a, b, cap) {
    const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CONNECTOR_CAP;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const inside = (r) => r >= lo && r <= hi;
    const connectors = [];
    let truncated = false;
    const add = (c) => { if (connectors.length < limit) connectors.push(c); else truncated = true; };
    for (const r of (lay && lay.rails) || []) {
      if (r.toRow >= lo && r.fromRow <= hi) add({ type: 'rail', laneId: r.laneId, col: r.col, fromRow: Math.max(r.fromRow, lo), toRow: Math.min(r.toRow, hi) });
    }
    for (const e of (lay && lay.edges) || []) {
      if (inside(e.fromRow) || inside(e.toRow)) add({ type: e.kind, laneId: e.laneId, fromRow: e.fromRow, fromCol: e.fromCol, toRow: e.toRow, toCol: e.toCol });
    }
    return { connectors, truncated };
  }

  /** The row with this key, or -1. Linear; for selection restore on a re-layout, not for the scroll path. */
  function findRowIndex(lay, key) {
    const rows = (lay && lay.rows) || [];
    for (let i = 0; i < rows.length; i++) if (rows[i].key === key) return i;
    return -1;
  }

  return Object.freeze({
    DEFAULT_CONNECTOR_CAP,
    emptyCollapseState,
    setGroupExpanded,
    setLaneExpanded,
    layout,
    connectorsForRows,
    findRowIndex,
  });
});
