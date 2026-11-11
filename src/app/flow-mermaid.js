'use strict';
// flow-mermaid.js — the Flow export as Mermaid `flowchart TD` text (spec 46, #826, plan T20). Pure: a snapshot in, text
// out; no DOM, no fs, no clock. `flow-export.js` is the only caller, so it lives beside it and not in `src/shared/`.
//
// WHAT IT DRAWS. Every lane open, every run of equivalent tool calls folded into ONE node ("tool: 2 × Read"), because
// Mermaid renders a few hundred edges at most (its default limit is 500 and is not measured here). One node per layout
// row with the id `n<index>`; the main lane at the top level, every other lane a `subgraph` nested by its parent lane.
// Edges: in order inside a lane (`-->`), spawn from the parent's anchor row to the child's first row (`-->|spawn|`) and
// return from the child's last row to the parent's anchor row (dashed, `-.->|return|`). A checkpoint figure rides on the
// node as plain text; an estimated one carries the word "estimated" (`FlowText.checkpointInfo`, the one derivation).
//
// SAFE TO PASTE. A label is a quoted string with every character that Mermaid, HTML or a markdown string could read
// replaced by a numeric entity (`#91;`), control characters dropped and newlines folded to a space. The output holds no
// `click`, `href`, `call`, `%%{init}` or any other directive: a line is a comment, `flowchart TD`, a `subgraph` / `end`,
// a node or an edge, and nothing a renderer could execute.
//
// BOUNDED, AND NEVER SILENT. When the edge count passes `MAX_EDGES` the nodes are folded again to one per lane and turn
// ("turn 3: 12 steps") and a `%%` comment says so; when that is still too many the diagram is cut at the node where the
// budget ends and a `%% truncated` comment says how much is left out.

const FlowLayout = require('../shared/flow-layout');
const FlowText = require('../shared/flow-text');

const MAX_EDGES = 450;
const MAX_LABEL = 60;
const MAX_COMMENT = 240;

const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]', 'g');

function squash(text) { return String(text == null ? '' : text).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(); }

function cut(text, max) {
  const chars = Array.from(squash(text));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

/** A string for a quoted Mermaid label: markup-significant characters become numeric entities, the quote `#quot;`. */
function label(text) {
  return squash(text).replace(/["#%&;<>\[\]{}()|\\`]/g, (ch) => (ch === '"' ? '#quot;' : '#' + ch.charCodeAt(0) + ';'));
}

/**
 * A `%%` comment body: one line, no control characters, capped, and no brace. Mermaid reads a `%%{…}%%` directive
 * anywhere in the text, comment lines included, and the model name and limitation texts come from the transcript, so
 * a brace would let a session's content set the renderer's config (`themeCSS`). Braces become parentheses.
 */
function comment(text) { return cut(text, MAX_COMMENT).replace(/\{/g, '(').replace(/\}/g, ')'); }

function nodeLabel(row, columns) {
  const text = FlowText.rowBadge(row) + ': ' + cut(FlowText.rowText(row, columns), MAX_LABEL);
  const cp = row.kind === 'step' ? FlowText.checkpointInfo(row.step) : null;
  return cp ? text + ' (' + cp.text + ')' : text;
}

function stepsIn(row) { return row.kind === 'group' ? row.count : row.kind === 'lane' ? row.count : 1; }

/** Nodes: one per row, or (folded) one per run of consecutive rows of the same lane and turn. */
function makeNodes(lay, folded) {
  const nodes = [];
  const nodeOfRow = new Array(lay.rows.length);
  for (const row of lay.rows) {
    const prev = nodes[nodes.length - 1];
    if (folded && prev && prev.laneId === row.laneId && prev.turn === row.turn) {
      prev.steps += stepsIn(row);
      nodeOfRow[row.index] = nodes.length - 1;
      continue;
    }
    nodes.push({ laneId: row.laneId, turn: row.turn, steps: stepsIn(row), text: folded ? null : nodeLabel(row, lay.columns) });
    nodeOfRow[row.index] = nodes.length - 1;
  }
  if (folded) {
    for (const n of nodes) {
      n.text = (n.turn == null ? 'before the first turn' : 'turn ' + n.turn) + ': ' + n.steps + (n.steps === 1 ? ' step' : ' steps');
    }
  }
  return { nodes, nodeOfRow };
}

/** Edges as `{ from, to, kind }` over node indexes, in a stable order. */
function makeEdges(lay, nodes, nodeOfRow) {
  const edges = [];
  const last = new Map();
  nodes.forEach((n, i) => {
    if (last.has(n.laneId)) edges.push({ from: last.get(n.laneId), to: i, kind: 'seq' });
    last.set(n.laneId, i);
  });
  for (const e of lay.edges || []) {
    const from = nodeOfRow[e.fromRow];
    const to = nodeOfRow[e.toRow];
    if (from == null || to == null || from === to) continue;
    edges.push({ from, to, kind: e.kind });
  }
  return edges;
}

/**
 * @param {object} snapshot a validated FlowSnapshot
 * @param {{ sessionId?: string, backendLabel?: string, exportedAt?: string, appVersion?: string }} [meta]
 * @param {{ maxEdges?: number }} [opts]
 * @returns {string} the Mermaid text
 */
function renderFlowMermaid(snapshot, meta, opts) {
  const m = meta || {};
  const maxEdges = Math.max(1, Math.floor(opts && opts.maxEdges) || MAX_EDGES);
  const state = FlowLayout.emptyCollapseState();
  for (const l of snapshot.lanes || []) state.lanes[l.id] = true; // lanes open; runs of calls stay folded
  const lay = FlowLayout.layout(snapshot, state);

  let { nodes, nodeOfRow } = makeNodes(lay, false);
  let edges = makeEdges(lay, nodes, nodeOfRow);
  const notes = [];
  if (edges.length > maxEdges) {
    const before = edges.length;
    ({ nodes, nodeOfRow } = makeNodes(lay, true));
    edges = makeEdges(lay, nodes, nodeOfRow);
    notes.push(`folded to one node per lane and turn: ${before} edges would pass the limit of ${maxEdges}`);
  }
  let keep = nodes.length;
  if (edges.length > maxEdges) {
    // Keep the first nodes whose edges fit the budget; an edge needs both of its ends.
    const byEnd = new Array(nodes.length).fill(0);
    for (const e of edges) byEnd[Math.max(e.from, e.to)]++;
    let used = 0;
    keep = 0;
    while (keep < nodes.length && used + byEnd[keep] <= maxEdges) { used += byEnd[keep]; keep++; }
    keep = Math.max(1, keep);
    notes.push(`truncated: the first ${keep} of ${nodes.length} nodes are shown (edge limit ${maxEdges}); export JSON or SVG for the complete flow`);
    edges = edges.filter(e => e.from < keep && e.to < keep);
  }

  // ----- header -----
  const out = [];
  const start = (snapshot.steps || []).find(s => s.kind === 'start');
  const model = start && start.detail && typeof start.detail.model === 'string' ? start.detail.model : '';
  const items = FlowText.bannerItems(snapshot);
  const id = m.sessionId ? String(m.sessionId).slice(0, 8) : 'unknown';
  out.push('%% ' + comment(['Session ' + id, m.backendLabel, model, 'exported ' + (m.exportedAt || ''), m.appVersion ? 'Switchboard ' + m.appVersion : '',
    items.length + (items.length === 1 ? ' limitation' : ' limitations')].filter(Boolean).join(' · ')));
  out.push('%% ' + (snapshot.steps || []).length + ' steps, ' + (snapshot.lanes || []).length + ' lanes, '
    + (snapshot.complete === false ? 'PARTIAL: this read is not complete' : 'complete read'));
  for (const it of items) out.push('%% limitation: ' + comment((it.caps.length ? it.caps.join(', ') + ': ' : '') + it.text));
  for (const n of notes) out.push('%% ' + comment(n));
  out.push('flowchart TD');

  // ----- lanes: the main lane at the top level, every other lane a subgraph inside its parent's -----
  const nodesOf = new Map();
  for (let i = 0; i < keep; i++) {
    if (!nodesOf.has(nodes[i].laneId)) nodesOf.set(nodes[i].laneId, []);
    nodesOf.get(nodes[i].laneId).push(i);
  }
  const columns = lay.columns || [];
  const known = new Set(columns.map(c => c.laneId));
  const children = new Map();
  const roots = [];
  for (const c of columns) {
    if (c.parentLaneId != null && known.has(c.parentLaneId)) {
      if (!children.has(c.parentLaneId)) children.set(c.parentLaneId, []);
      children.get(c.parentLaneId).push(c);
    } else roots.push(c);
  }
  const hasContent = (c) => nodesOf.has(c.laneId) || (children.get(c.laneId) || []).some(hasContent);
  const laneIds = new Map(columns.map((c, i) => [c.laneId, 'l' + i]));
  const emit = (c, depth) => {
    if (!hasContent(c)) return;
    const pad = '  '.repeat(depth);
    const box = c.kind !== 'main';
    if (box) out.push(`${pad}subgraph ${laneIds.get(c.laneId)}["${label((c.kind || 'lane') + ': ' + (c.label || c.laneId))}"]`);
    const inner = box ? depth + 1 : depth;
    for (const i of nodesOf.get(c.laneId) || []) out.push(`${'  '.repeat(inner)}n${i}["${label(nodes[i].text)}"]`);
    for (const ch of children.get(c.laneId) || []) emit(ch, inner);
    if (box) out.push(`${pad}end`);
  };
  for (const r of roots) emit(r, 1);

  // ----- edges -----
  for (const e of edges) {
    const arrow = e.kind === 'spawn' ? '-->|spawn|' : e.kind === 'return' ? '-.->|return|' : '-->';
    out.push(`  n${e.from} ${arrow} n${e.to}`);
  }
  return out.join('\n') + '\n';
}

module.exports = { renderFlowMermaid, label, MAX_EDGES };
