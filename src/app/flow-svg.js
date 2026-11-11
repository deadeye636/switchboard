'use strict';
// flow-svg.js — the Flow export as one static SVG string (spec 46, #826, plan T18). Pure: a snapshot in, text out; no DOM,
// no fs, no clock. Main calls it from `flow-export.js` (the only caller), so it lives beside it and not in `src/shared/`,
// which holds what BOTH processes load (`.claude/rules/renderer.md`).
//
// WHAT IT DRAWS. The COMPLETE snapshot with every lane and every run of tool calls opened, whatever the view folded:
// the export must not hide a step. The geometry is the screen's: `FlowLayout` decides rows, columns, rails and spawn /
// return bars (`gutterWidth`, `connectorRects`), the graph lives in the left gutter and every card starts right of it,
// so no bar crosses a card. A card has two lines: the kind word, the turn, the lane tag and the checkpoint text on the
// first, the label on the second. An estimated checkpoint is drawn with a dashed outline AND carries the word
// "estimated" (`FlowText.checkpointInfo`, the one derivation), so colour is never the only signal. A label longer than
// the card is cut for the drawing and carried in a `<title>`, up to 2000 characters.
//
// THE FILE STANDS ALONE. Explicit colours (a print-friendly light theme, no CSS variables), a generic font stack, no
// script, no `on*` attribute, no `foreignObject`, no `href` of any kind. Every text goes through `esc`.
//
// BOUNDED. One pass over the rows, parts pushed to an array and joined once; the work follows the row count.

const FlowLayout = require('../shared/flow-layout');
const FlowText = require('../shared/flow-text');

const ROW_H = 40;
const CARD_W = 820;
const HEADER_PAD = 24;
const MAX_LABEL = 84;       // characters drawn on a card; the whole label rides in a <title>
const MAX_TITLE = 2000;
const WRAP = 130;
const HEAD_WRAP = 120;       // the 12 px header lines; the width of the page is gutter + card
const INDENT = 16;
const FONT = "'Segoe UI', Helvetica, Arial, sans-serif";
const LANE_COLORS = ['#3b5bdb', '#2b8a3e', '#c2410c', '#862e9c', '#0b7285', '#a61e4d', '#5c940d', '#495057'];
const BAR_COLOR = { spawn: '#2b8a3e', return: '#862e9c' };

// Characters XML 1.0 cannot carry are dropped, a lone surrogate is replaced, then the five markup characters are escaped.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
function esc(value) {
  let s = String(value == null ? '' : value).replace(INVALID_XML, '');
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function squash(text) { return String(text == null ? '' : text).replace(/\s+/g, ' '); }

function cut(text, max) {
  const chars = Array.from(squash(text));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

/** Word wrap to `width` characters; a single token longer than that (a URL, a long model name) is broken hard. */
function wrap(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let w of words) {
    while (w.length > width) {
      if (line) { lines.push(line); line = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; } else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

/** Every lane and every run of tool calls open: the state the export lays out with. */
function expandedState(snapshot) {
  const state = FlowLayout.emptyCollapseState();
  for (const l of snapshot.lanes || []) state.lanes[l.id] = true;
  for (const s of snapshot.steps || []) state.groups['g:' + s.id] = true;
  return state;
}

function textEl(x, y, size, fill, content, extra) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra || ''}>${esc(content)}</text>`;
}

const colorOfCol = (col) => LANE_COLORS[col % LANE_COLORS.length];

/**
 * Rails, bars, dots and cards for rows [from, to] pushed onto `out`; row `from` sits at y 0. `connectors` come from
 * `connectorsForRows` with their rows already counted from `from` (the page renderer shifts them; the whole-file
 * render passes from = 0). A row that opens its page shows its turn even when the turn began on an earlier page.
 */
function drawBody(out, lay, from, to, gutter, connectors) {
  const rows = lay.rows;
  // The graph: one rect per rail and per spawn / return bar (a handful, never one per step).
  for (const c of connectors) {
    for (const r of FlowLayout.connectorRects(c, ROW_H)) {
      const fill = r.kind === 'rail' ? colorOfCol(c.col) : BAR_COLOR[r.kind];
      out.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${fill}"${r.waiting ? ' opacity="0.45"' : ''}/>\n`);
    }
  }

  const turnStarts = new Set(lay.turns.map(t => t.startRow));
  for (let i = from; i <= to; i++) {
    const row = rows[i];
    const y0 = (i - from) * ROW_H;
    const isChild = row.depth || (row.kind === 'step' && row.step.parentStepId);
    const cx = gutter + (isChild ? INDENT : 0);
    const cw = CARD_W - (isChild ? INDENT : 0);
    out.push(`<circle cx="${FlowLayout.dotX(row.col) + 4}" cy="${y0 + ROW_H / 2}" r="4" fill="${colorOfCol(row.col)}"/>\n`);
    out.push(`<rect x="${cx}" y="${y0 + 3}" width="${cw}" height="${ROW_H - 6}" rx="5" fill="#f8fafc" stroke="#cbd5e1"/>\n`);
    const meta1 = [];
    if ((turnStarts.has(i) || i === from) && row.turn != null) meta1.push('turn ' + row.turn);
    if (row.laneStart) meta1.push(FlowText.laneTagInfo(lay.columns, row.laneId).text.replace(/^▾ /, 'lane: '));
    if (row.flags && row.flags.length) meta1.push(row.flags.length + (row.flags.length === 1 ? ' flag' : ' flags'));
    out.push(textEl(cx + 10, y0 + 16, 9, '#1d4ed8', FlowText.rowBadge(row).toUpperCase(), ' font-weight="bold"'), '\n');
    const cp = row.kind === 'step' ? FlowText.checkpointInfo(row.step) : null;
    if (meta1.length) {
      // The first line shares its width with the right-anchored checkpoint text: the meta gets what is left (about 5 px a character at 9 px).
      const room = Math.floor((cw - 86 - 10 - (cp ? cp.text.length * 5 + 12 : 0)) / 5);
      out.push(textEl(cx + 86, y0 + 16, 9, '#6b7280', cut(meta1.join('  ·  '), Math.max(4, room))), '\n');
    }
    if (cp) {
      out.push(textEl(cx + cw - 10, y0 + 16, 9, '#374151', cp.text, ' text-anchor="end"'), '\n');
      if (cp.pct != null) {
        const bx = cx + cw - 90;
        out.push(`<rect x="${bx}" y="${y0 + 22}" width="80" height="5" fill="#e5e7eb"${cp.estimated ? ' stroke="#374151" stroke-dasharray="3 2"' : ''}/>`
          + `<rect x="${bx}" y="${y0 + 22}" width="${(cp.pct * 0.8).toFixed(1)}" height="5" fill="${cp.estimated ? '#9ca3af' : '#4b5563'}"/>\n`);
      }
    }
    const full = (row.kind === 'group' ? '▾ ' : row.kind === 'lane' ? '▸ ' : '') + FlowText.rowText(row, lay.columns);
    const shown = cut(full, MAX_LABEL);
    const label = textEl(cx + 10, y0 + 32, 12, '#111827', shown);
    out.push(shown !== squash(full) ? `<g>${label}<title>${esc(cut(full, MAX_TITLE))}</title></g>\n` : label + '\n');
  }
}

/**
 * @param {object} snapshot a validated FlowSnapshot
 * @param {{ sessionId?: string, backendLabel?: string, exportedAt?: string, appVersion?: string }} [meta]
 * @returns {string} the SVG document
 */
function renderFlowSvg(snapshot, meta) {
  const m = meta || {};
  const lay = FlowLayout.layout(snapshot, expandedState(snapshot));
  const rows = lay.rows;
  const gutter = FlowLayout.gutterWidth(lay.stats.cols);
  const width = gutter + CARD_W + 16;

  // ----- header -----
  const head = [];
  let y = HEADER_PAD;
  const line = (size, fill, content, weight) => {
    for (const l of wrap(content, HEAD_WRAP)) {
      head.push(textEl(16, y, size, fill, l, weight ? ` font-weight="${weight}"` : ''));
      y += size + 6;
    }
  };
  const start = (snapshot.steps || []).find(s => s.kind === 'start');
  const model = start && start.detail && typeof start.detail.model === 'string' ? start.detail.model : '';
  line(18, '#111827', 'Session flow', 'bold');
  const id = m.sessionId ? String(m.sessionId).slice(0, 8) : '';
  line(12, '#374151', ['Session ' + (id || 'unknown'), m.backendLabel, model, 'exported ' + (m.exportedAt || ''), m.appVersion ? 'Switchboard ' + m.appVersion : '']
    .filter(Boolean).join('  ·  '));
  line(12, '#374151', (snapshot.steps || []).length + ' steps, ' + (snapshot.lanes || []).length + ' lanes  ·  '
    + (snapshot.complete === false ? 'PARTIAL: this read is not complete' : 'complete read'));
  const items = FlowText.bannerItems(snapshot);
  if (items.length) {
    y += 4;
    line(12, '#111827', 'Limitations (' + items.length + ')', 'bold');
    for (const it of items) {
      const lines = wrap((it.caps.length ? it.caps.join(', ') + ': ' : '') + it.text, WRAP);
      lines.forEach((l, i) => { head.push(textEl(i === 0 ? 20 : 30, y, 11, '#4b5563', (i === 0 ? '• ' : '') + l)); y += 15; });
    }
  }
  const headerH = y + 12;
  const height = headerH + rows.length * ROW_H + 16;

  // ----- body -----
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" role="img" aria-label="Session flow">\n`);
  out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>\n`);
  out.push(head.join('\n'), '\n');
  out.push(`<g transform="translate(0 ${headerH})">\n`);

  const { connectors } = FlowLayout.connectorsForRows(lay, 0, Math.max(0, rows.length - 1), 1e6);
  drawBody(out, lay, 0, rows.length - 1, gutter, connectors);
  out.push('</g>\n</svg>\n');
  return out.join('');
}

module.exports = { renderFlowSvg, drawBody, expandedState, colorOfCol, textEl, wrap, cut, esc, ROW_H, CARD_W, FONT, BAR_COLOR, WRAP, HEAD_WRAP };
