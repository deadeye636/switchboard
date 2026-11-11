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
// ROW ORDER (T12). The snapshot lists the main lane first and every other lane after it, so the rows are NOT the
// snapshot order: `orderSteps` merges the lanes. A lane becomes active when its spawn anchor step has been emitted;
// among the active lanes the one whose next step has the smaller `ts` goes first, and with no usable `ts` on one
// side the lane that became active LAST goes first (the child runs to its end before the parent resumes, git log
// style); two root lanes (no parent) keep their snapshot order instead, so main stays first. Order inside one lane
// is never changed, so `ordinal` stays authoritative per lane. A lane whose spawn
// step is not in the snapshot is appended after the lanes that could be placed. One row holds one card, so a row
// belongs to exactly one lane and a turn band belongs to the main lane: a row of a child lane takes the turn of
// the band it sits in (`row.turn`; the step keeps its own number in `step.turn`).
//
// COLUMNS (T12). A lane takes the lowest column that is at least one right of its parent's and is free over the
// lane's whole span, where the span runs to the lane's last row or its last descendant's, whichever is later (so a
// connector along the parent's rail never runs over another lane's rail or dot). Sequential agents therefore share a
// column and overlapping ones sit side by side. Spans are measured in step positions of the merged order.
// Nothing here is virtualised by column: a row holds one card, so the DOM follows the row window, not the lane
// count (lane cap 200); the gutter is sized for the whole layout, once per layout.
//
// GRAPH GUTTER AND CONNECTORS (git log --graph shape). Every rail, dot and connector bar lives in one gutter on the
// left of the rows, `gutterWidth(stats.cols)` wide; a lane's rail and its rows' dots sit at its column's x
// (`railX` / `dotX`), and every card starts right of the gutter, so nothing of the graph can enter a card and a
// card is not shifted per column. A spawn leaves the parent's rail, turns in the gap above the child's first row
// (`gapRow` = that row) and the child's own rail carries on; a return leaves the child's last row, turns in the
// gap below it (`gapRow` = last row + 1) and runs along the parent's rail to the return row. `connectorRects` is the
// pure description of the boxes, so a test proves they stay inside the gutter. A return anchor that is the spawn step
// (what Claude has: call and result are one step) is a return row ABOVE the child, so the vertical runs upward.
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
// LOADING. Since T8 the renderer loads it (`<script>` tag in `index.html`, entry in `test/fixtures/script-order.json`);
// `session/flow-view.js` is its reader. The whole body is wrapped, so as a classic script it adds ONE global
// (`FlowLayout`) and none of the helper names below.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_CONNECTOR_CAP = 200;
  // Graph gutter geometry (px). Every rail, dot and connector bar lives in the gutter on the left of the rows; a
  // card starts at `gutterWidth(cols)` and nothing of the graph ever enters it.
  const COL_W = 18;
  const RAIL_X = 21; // x of a column's rail inside the gutter; its dot is centred on it
  const RAIL_W = 2;
  const DOT_X = 18; // left edge of an 8 px dot centred on the rail
  const GUTTER_PAD = 20;
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
    for (const lane of lanes) byId.set(lane.id, { lane, ownCollapsed: false, under: false, child: false, owner: null, col: -1, sFirst: -1, sEnd: -1, row: null, visiting: false, done: false, first: -1, last: -1, count: 0, flags: null, summary: null });
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
        m.child = true;
        m.under = parent.ownCollapsed || parent.under;
      }
      m.owner = m.under ? parent.owner || (parent.ownCollapsed ? parent : null)
        : (m.ownCollapsed ? m : null);
      m.visiting = false;
      m.done = true;
      return m;
    };
    for (const m of byId.values()) resolve(m);
    return byId;
  }

  /**
   * The steps in row order and each lane's span in that order (see ROW ORDER above). One pass; with a single lane
   * the snapshot's own array comes back untouched and `span` is null.
   */
  function orderSteps(steps, lanes) {
    if (lanes.length <= 1) return { order: steps, span: null };
    const byLane = new Map();
    for (const s of steps) {
      let b = byLane.get(s.laneId);
      if (!b) byLane.set(s.laneId, b = { id: s.laneId, steps: [], pos: 0, seq: -1, first: -1, last: -1 });
      b.steps.push(s);
    }
    const known = new Set();
    for (const lane of lanes) known.add(lane.id);
    const childIds = new Set();
    const spawnAt = new Map(); // spawn step id -> buckets it activates
    for (const lane of lanes) {
      const b = byLane.get(lane.id);
      if (!b || lane.parentLaneId == null || !known.has(lane.parentLaneId)) continue;
      childIds.add(lane.id);
      const sa = lane.spawnAnchor;
      if (!sa || sa.stepId == null) continue;
      const list = spawnAt.get(sa.stepId);
      if (list) list.push(b); else spawnAt.set(sa.stepId, [b]);
    }
    const order = new Array(steps.length);
    let n = 0;
    let seq = 0;
    const active = [];
    const activate = (b) => { if (b.seq < 0) { b.seq = seq++; active.push(b); } };
    const prefer = (a, b) => {
      const ta = a.steps[a.pos].ts;
      const tb = b.steps[b.pos].ts;
      if (typeof ta === 'number' && typeof tb === 'number' && ta !== tb) return ta < tb;
      if (a.root && b.root) return a.seq < b.seq; // two root lanes keep snapshot order
      return a.seq > b.seq;
    };
    for (const b of byLane.values()) if (!childIds.has(b.id)) { b.root = true; activate(b); }
    for (;;) {
      while (active.length) {
        let best = 0;
        for (let k = 1; k < active.length; k++) if (prefer(active[k], active[best])) best = k;
        const b = active[best];
        const s = b.steps[b.pos++];
        if (b.first < 0) b.first = n;
        b.last = n;
        order[n++] = s;
        if (b.pos >= b.steps.length) { active[best] = active[active.length - 1]; active.pop(); }
        const kids = spawnAt.get(s.id);
        if (kids) for (const c of kids) activate(c);
      }
      let orphan = null;
      for (const b of byLane.values()) if (b.seq < 0) { orphan = b; break; }
      if (!orphan) break;
      activate(orphan);
    }
    return { order, span: byLane };
  }

  /** Columns for every lane that is not hidden under a collapsed one (see COLUMNS above). Sets `m.col`. */
  function assignColumns(lanes, metas, span) {
    if (!span) {
      let col = 0;
      for (const lane of lanes) { const m = metas.get(lane.id); if (m && !m.under) m.col = col++; }
      return;
    }
    const list = [];
    for (const lane of lanes) {
      const m = metas.get(lane.id);
      const sp = span.get(lane.id);
      if (!m || m.under || !sp) continue;
      m.sFirst = sp.first;
      m.sEnd = m.ownCollapsed ? sp.first : sp.last; // a summary stands on its first row only
      list.push(m);
    }
    list.sort((a, b) => a.sFirst - b.sFirst);
    for (let i = list.length - 1; i >= 0; i--) { // children start after their parent: bottom-up
      const m = list[i];
      const p = m.lane.parentLaneId != null ? metas.get(m.lane.parentLaneId) : null;
      if (p && p.sFirst >= 0 && m.sEnd > p.sEnd) p.sEnd = m.sEnd;
    }
    const colEnd = [];
    for (const m of list) {
      const p = m.lane.parentLaneId != null ? metas.get(m.lane.parentLaneId) : null;
      let c = p && p.col >= 0 ? p.col + 1 : 0;
      while (c < colEnd.length && colEnd[c] >= m.sFirst) c++;
      m.col = c;
      colEnd[c] = m.sEnd;
    }
  }

  /**
   * Snapshot + collapse state in; rows, columns, turns, rails and edges out.
   *
   * Row: { key, index, kind: 'step' | 'group' | 'lane', col, laneId, turn, depth, step, firstStepId, tool,
   *        count, expanded, groupKey, flags, laneStart }
   * `step` is set on step rows only; a group or lane row names its first step in `firstStepId`.
   * `depth` is 1 for a member row under an expanded group, else 0. `turn` is the band's turn (a child lane's
   * rows take the band they sit in). `laneStart` marks the first row of an expanded child lane, where its header
   * text and its collapse control are drawn.
   * Also returned: `order`, the steps in row order (the snapshot's own array for a single lane).
   */
  function layout(snapshot, state) {
    const lanes = (snapshot && snapshot.lanes) || [];
    const groupsState = (state && state.groups) || {};
    const metas = resolveLanes(lanes, state);
    const ordered = orderSteps((snapshot && snapshot.steps) || [], lanes);
    const steps = ordered.order;
    assignColumns(lanes, metas, ordered.span);

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
      const m = metas.get(laneId);
      if (m && m.child && rows.length) row.turn = curTurn; // a child lane never opens or splits a turn band
      row.index = rows.length;
      if (m && m.child && m.first < 0 && row.kind !== 'lane') row.laneStart = true;
      rows.push(row);
      const last = turns.length ? turns[turns.length - 1] : null;
      if (!last || row.turn !== curTurn) { turns.push({ turn: row.turn, startRow: row.index, endRow: row.index }); curTurn = row.turn; }
      else last.endRow = row.index;
      if (m) { if (m.first < 0) m.first = row.index; m.last = row.index; }
      return row;
    };
    const noteAnchor = (stepId, rowIndex) => { if (anchorIds.size && anchorIds.has(stepId)) anchorRows.set(stepId, rowIndex); };

    const stepRow = (step, depth, groupKey) => {
      const row = push({
        key: step.id, index: 0, kind: 'step', col: colOf(step.laneId), laneId: step.laneId, turn: step.turn == null ? null : step.turn,
        depth, step, firstStepId: step.id, tool: null, count: 1, expanded: false, groupKey: groupKey || null,
        flags: step.flags && step.flags.length ? step.flags : EMPTY_FLAGS, laneStart: false,
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
        depth: 0, step: null, firstStepId: first.id, tool: r.tool, count: r.count, expanded, groupKey: key, flags: EMPTY_FLAGS, laneStart: false,
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
            expanded: false, groupKey: null, flags: EMPTY_FLAGS, laneStart: false,
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

      // A step a lane starts or returns at is a spawn / return and ends a run by what it IS (spec 46 req. 7), whatever its kind.
      const equivalent = step.kind === 'tool' && !(step.flags && step.flags.length) && !(anchorIds.size && anchorIds.has(step.id));
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
    let maxCol = 0;
    for (const lane of lanes) {
      const m = metas.get(lane.id);
      if (!m || m.under) continue;
      if (m.col > maxCol) maxCol = m.col;
      columns.push({ col: m.col, laneId: lane.id, label: lane.label == null ? '' : lane.label, kind: lane.kind, depth: lane.depth || 0, parentLaneId: lane.parentLaneId == null ? null : lane.parentLaneId, collapsed: m.ownCollapsed });
    }
    stats.cols = maxCol + 1;

    // One rail per lane that has rows; a handful of spawn/return edges. Nothing here scales with steps.
    const rails = [];
    const edges = [];
    for (const lane of lanes) {
      const m = metas.get(lane.id);
      if (!m || m.under || m.first < 0) continue;
      const rail = { laneId: lane.id, col: m.col, fromRow: m.first, toRow: m.last };
      // A lane that is waiting: a reader sets `waiting` only for an explicit wait call that has no answer yet (Codex's
      // `wait_agent` / `wait`). Omitted when false so the common rail stays small.
      if (lane.waiting === true) rail.waiting = true;
      rails.push(rail);
      const sa = lane.spawnAnchor;
      if (m.child && sa && anchorRows.has(sa.stepId)) {
        edges.push({ kind: 'spawn', laneId: lane.id, fromRow: anchorRows.get(sa.stepId), fromCol: colOf(sa.laneId), toRow: m.first, toCol: m.col, gapRow: m.first });
      }
      const ra = lane.returnAnchor;
      if (m.child && ra && anchorRows.has(ra.stepId)) {
        edges.push({ kind: 'return', laneId: lane.id, fromRow: m.last, fromCol: m.col, toRow: anchorRows.get(ra.stepId), toCol: colOf(ra.laneId), gapRow: m.last + 1 });
      }
    }

    return { rows, columns, turns, rails, edges, stats, order: steps };
  }

  /**
   * The connectors a window of rows [a, b] needs, at most `cap` (default ~200). A rail is clipped to the
   * window; a spawn or return edge is listed when the span between its two rows touches it. Reads the small rail and edge
   * lists the layout already holds, so it costs the number of lanes, not of steps or rows.
   * Returns `{ connectors, truncated }`; `truncated` is true when the cap dropped something, and edges are kept before rails.
   */
  function connectorsForRows(lay, a, b, cap) {
    const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CONNECTOR_CAP;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const connectors = [];
    let truncated = false;
    const add = (c) => { if (connectors.length < limit) connectors.push(c); else truncated = true; };
    // Edges first: when the cap bites it is a rail that is dropped (it can be redrawn by the next window), never a spawn or return.
    for (const e of (lay && lay.edges) || []) {
      // Listed when any part of it (its two rows or the gap it turns in) lies in the window, so a long
      // vertical that passes through is still drawn. Its endpoints stay unclipped: the caller clips.
      const top = Math.min(e.fromRow, e.toRow);
      const bottom = Math.max(e.fromRow, e.toRow);
      if (bottom >= lo && top <= hi) add({ type: e.kind, laneId: e.laneId, fromRow: e.fromRow, fromCol: e.fromCol, toRow: e.toRow, toCol: e.toCol, gapRow: e.gapRow });
    }
    for (const r of (lay && lay.rails) || []) {
      if (r.toRow >= lo && r.fromRow <= hi) {
        const c = { type: 'rail', laneId: r.laneId, col: r.col, fromRow: Math.max(r.fromRow, lo), toRow: Math.min(r.toRow, hi) };
        if (r.waiting) c.waiting = true;
        add(c);
      }
    }
    return { connectors, truncated };
  }

  function railX(col) { return col * COL_W + RAIL_X; }
  function dotX(col) { return col * COL_W + DOT_X; }
  /** Width of the graph gutter for `cols` columns; the cards start here. */
  function gutterWidth(cols) { return Math.max(1, cols || 1) * COL_W + GUTTER_PAD; }

  /**
   * The boxes (`{ kind, x, y, w, h, waiting? }`, px, y from the top of the first row) one connector from
   * `connectorsForRows` is drawn as: one for a rail, up to two for a spawn or a return. Pure, so a test can prove
   * every box lies inside the gutter and meets no card.
   */
  function connectorRects(c, rowH) {
    if (c.type === 'rail') {
      const r = { kind: 'rail', x: railX(c.col), y: c.fromRow * rowH, w: RAIL_W, h: (c.toRow - c.fromRow + 1) * rowH };
      if (c.waiting) r.waiting = true;
      return [r];
    }
    const out = [];
    const gapY = c.gapRow * rowH - 1; // the bar sits on the border between two rows
    const fromX = railX(c.fromCol);
    const toX = railX(c.toCol);
    if (fromX !== toX) out.push({ kind: c.type, x: Math.min(fromX, toX), y: gapY, w: Math.abs(fromX - toX) + RAIL_W, h: RAIL_W });
    if (c.type === 'spawn') {
      const y0 = c.fromRow * rowH + rowH / 2;
      if (gapY > y0) out.push({ kind: 'spawn', x: fromX, y: y0, w: RAIL_W, h: gapY - y0 });
    } else {
      const y1 = c.toRow * rowH + rowH / 2;
      out.push({ kind: 'return', x: toX, y: Math.min(gapY, y1), w: RAIL_W, h: Math.abs(gapY - y1) + RAIL_W });
    }
    return out;
  }

  /** The row with this key, or -1. Linear; for selection restore on a re-layout, not for the scroll path. */
  function findRowIndex(lay, key) {
    const rows = (lay && lay.rows) || [];
    for (let i = 0; i < rows.length; i++) if (rows[i].key === key) return i;
    return -1;
  }

  return Object.freeze({
    DEFAULT_CONNECTOR_CAP,
    COL_W,
    DOT_X,
    railX,
    dotX,
    gutterWidth,
    connectorRects,
    emptyCollapseState,
    setGroupExpanded,
    setLaneExpanded,
    layout,
    connectorsForRows,
    findRowIndex,
  });
});
