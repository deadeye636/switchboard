'use strict';
// flow-pages.js — the Flow export as paginated A4 pages (spec 46, #826, plan T19). Pure: a snapshot in, page SVGs and
// one static HTML document out; no DOM, no fs, no clock, no Electron. `flow-pdf.js` prints that document, and
// `flow-export.js` is the only caller.
//
// WHAT A PAGE IS. The COMPLETE snapshot laid out fully expanded (the same layout and drawing as `flow-svg.js`), cut into
// slices of whole rows. A row is one card and has a fixed height, so a card is never split: the cut falls between two
// rows. Every page repeats a header with the session line and the lane legend (swatch, kind and label as text, so colour is
// never the only signal); the first page also carries the counts, the limitations and, when the page cap bit, the notice.
// Later pages carry a short header with "page n of N".
//
// RAILS ACROSS A CUT. `connectorsForRows` clips every rail to the slice, so a lane that is active over a boundary is drawn
// from the top to the bottom of both pages: the rail continues. A spawn or return bar is drawn only on a page that holds
// BOTH of its rows and its gap row; otherwise the rail just continues and the bar is left out (a bar that ran off the
// page would point at nothing).
//
// BOUNDED. The cut follows the row count, one pass per page. `MAX_PAGES` caps the file; a snapshot beyond it is cut off
// and page 1 says so in words. The cap is a size decision made in the page count, not a hang guard (the timeout is in
// `flow-pdf.js`).

const FlowLayout = require('../shared/flow-layout');
const FlowText = require('../shared/flow-text');
const svg = require('./flow-svg');

const { ROW_H, CARD_W, FONT, WRAP, HEAD_WRAP, esc, textEl, wrap, cut, colorOfCol } = svg;

const MAX_PAGES = 300;
// A4 portrait, in millimetres. A page block is the whole sheet with 12 mm of padding; the SVG fills the padded area.
const SHEET_W_MM = 210;
const SHEET_H_MM = 296; // one millimetre short of 297, so rounding never pushes a blank page behind a full one
const PAD_MM = 12;
const BOX_W_MM = SHEET_W_MM - 2 * PAD_MM;
const BOX_H_MM = SHEET_H_MM - 2 * PAD_MM;
const MAX_LEGEND = 24;       // lanes named in the legend; the rest are counted
const MAX_LIMIT_Y_SHARE = 0.5; // limitations stop once the first-page header passes this share of the page
const BOTTOM_PAD = 8;
const MAX_ITEM_LINES = 6;    // one limitation never takes more lines than this; the rest is cut with an ellipsis

/**
 * Slice `rowCount` rows into pages: `firstCap` rows (possibly none) on page 1, `laterCap` on each later one. At least one page, every
 * row on exactly one page, in order. Inclusive bounds; an empty flow is one page with `to < from`.
 * @returns {{ from: number, to: number }[]}
 */
function paginate(rowCount, firstCap, laterCap) {
  const n = Math.max(0, Math.floor(rowCount) || 0);
  const c1 = Math.max(0, Math.floor(firstCap) || 0); // 0: the header fills page 1, rows start on page 2
  const c2 = Math.max(1, Math.floor(laterCap) || 1);
  const pages = [];
  let from = 0;
  let cap = c1;
  do {
    const to = Math.min(n, from + cap) - 1;
    pages.push({ from, to });
    from = to + 1;
    cap = c2;
  } while (from < n);
  return pages;
}

/** Page count for `rowCount` rows: 1 when they fit page 1, else 1 + ceil((rowCount - firstCap) / laterCap). */
function pageCountFor(rowCount, firstCap, laterCap) {
  const n = Math.max(0, rowCount);
  if (n <= firstCap) return 1;
  return 1 + Math.ceil((n - firstCap) / laterCap);
}

/** An edge is drawn on a page only when both its rows and its gap row are on that page. Rows are absolute. */
function edgeFitsPage(c, a, b) {
  const rows = [c.fromRow, c.toRow, c.gapRow];
  return rows.every(r => r >= a && r <= b);
}

/** The connectors of rows [a, b], counted from `a`: clipped rails, and bars whose whole span is on the page. */
function connectorsForPage(lay, a, b) {
  if (b < a) return [];
  const { connectors } = FlowLayout.connectorsForRows(lay, a, b, 1e6);
  const out = [];
  for (const c of connectors) {
    if (c.type === 'rail') {
      out.push({ ...c, fromRow: c.fromRow - a, toRow: c.toRow - a });
    } else if (edgeFitsPage(c, a, b)) {
      out.push({ ...c, fromRow: c.fromRow - a, toRow: c.toRow - a, gapRow: c.gapRow - a });
    }
  }
  return out;
}

function sessionLine(snapshot, meta) {
  const m = meta || {};
  const start = (snapshot.steps || []).find(s => s.kind === 'start');
  const model = start && start.detail && typeof start.detail.model === 'string' ? start.detail.model : '';
  const id = m.sessionId ? String(m.sessionId).slice(0, 8) : '';
  return ['Session ' + (id || 'unknown'), m.backendLabel, model, 'exported ' + (m.exportedAt || ''), m.appVersion ? 'Switchboard ' + m.appVersion : '']
    .filter(Boolean).join('  ·  ');
}

/** The lane legend: two entries a line, swatch + kind + label as text. Returns the parts and the y after it. */
function legendParts(lay, width, y) {
  const cols = lay.columns || [];
  const parts = [];
  if (!cols.length) return { parts, y };
  parts.push(textEl(16, y, 11, '#111827', 'Lanes', ' font-weight="bold"'));
  y += 6;
  const shown = cols.slice(0, MAX_LEGEND);
  const half = Math.floor((width - 32) / 2);
  shown.forEach((c, i) => {
    const x = 16 + (i % 2) * half;
    if (i % 2 === 0) y += 14;
    parts.push(`<rect x="${x}" y="${y - 8}" width="10" height="10" fill="${colorOfCol(c.col)}"/>`);
    const label = (c.kind || 'lane') + ': ' + (c.label || c.laneId);
    parts.push(textEl(x + 16, y, 10, '#374151', cut(label, Math.floor((half - 24) / 5.4))));
  });
  y += 8;
  if (cols.length > shown.length) {
    y += 8;
    parts.push(textEl(16, y, 10, '#6b7280', '+ ' + (cols.length - shown.length) + ' more lanes (the order is the order of the columns)'));
    y += 6;
  }
  return { parts, y: y + 6 };
}

/**
 * The header of one page: parts and height. Its height does not depend on the page number or the page total, so the
 * page capacities can be computed before the total is known.
 */
function headerOf(snapshot, lay, meta, width, height, first, pageNo, total, note) {
  const head = [];
  let y = first ? 24 : 20;
  const right = textEl(width - 16, y, 11, '#374151', 'Page ' + pageNo + ' of ' + total, ' text-anchor="end"');
  if (first) {
    const line = (size, fill, content, weight) => {
      for (const l of wrap(content, HEAD_WRAP)) {
        head.push(textEl(16, y, size, fill, l, weight ? ` font-weight="${weight}"` : ''));
        y += size + 6;
      }
    };
    head.push(right);
    line(18, '#111827', 'Session flow', 'bold');
    line(12, '#374151', sessionLine(snapshot, meta));
    line(12, '#374151', (snapshot.steps || []).length + ' steps, ' + (snapshot.lanes || []).length + ' lanes  ·  '
      + (snapshot.complete === false ? 'PARTIAL: this read is not complete' : 'complete read'));
    if (note) line(12, '#b91c1c', note, 'bold');
    const items = FlowText.bannerItems(snapshot);
    if (items.length) {
      y += 4;
      line(12, '#111827', 'Limitations (' + items.length + ')', 'bold');
      let shown = 0;
      for (const it of items) {
        if (y > height * MAX_LIMIT_Y_SHARE && shown > 0) break;
        let lines = wrap((it.caps.length ? it.caps.join(', ') + ': ' : '') + it.text, WRAP);
        if (lines.length > MAX_ITEM_LINES) { lines = lines.slice(0, MAX_ITEM_LINES); lines[MAX_ITEM_LINES - 1] = lines[MAX_ITEM_LINES - 1].slice(0, WRAP - 2) + ' …'; }
        lines.forEach((l, i) => { head.push(textEl(i === 0 ? 20 : 30, y, 11, '#4b5563', (i === 0 ? '• ' : '') + l)); y += 15; });
        shown++;
      }
      if (shown < items.length) {
        head.push(textEl(20, y, 11, '#4b5563', '… and ' + (items.length - shown) + ' more limitations (the JSON export lists all of them)'));
        y += 15;
      }
    }
    y += 4;
  } else {
    head.push(right);
    head.push(textEl(16, y, 12, '#111827', 'Session flow', ' font-weight="bold"'));
    const id = meta && meta.sessionId ? String(meta.sessionId).slice(0, 8) : 'unknown';
    head.push(textEl(110, y, 11, '#374151', cut('Session ' + id + (meta && meta.backendLabel ? '  ·  ' + meta.backendLabel : ''), 80)));
    y += 18;
  }
  const lg = legendParts(lay, width, y);
  return { parts: head.concat(lg.parts), height: lg.y + 6 };
}

/**
 * @param {object} snapshot a validated FlowSnapshot
 * @param {{ sessionId?: string, backendLabel?: string, exportedAt?: string, appVersion?: string }} [meta]
 * @param {{ maxPages?: number }} [opts]
 * @returns {{ pages: string[], pageCount: number, totalRows: number, shownRows: number, truncated: boolean }}
 */
function buildPages(snapshot, meta, opts) {
  const maxPages = Math.max(1, Math.floor(opts && opts.maxPages) || MAX_PAGES);
  const lay = FlowLayout.layout(snapshot, svg.expandedState(snapshot));
  const gutter = FlowLayout.gutterWidth(lay.stats.cols);
  const width = gutter + CARD_W + 16;
  const height = Math.floor(width * BOX_H_MM / BOX_W_MM);
  const totalRows = lay.rows.length;

  const h1 = headerOf(snapshot, lay, meta, width, height, true, 1, 1, '').height;
  const h2 = headerOf(snapshot, lay, meta, width, height, false, 1, 1, '').height;
  const cap1 = Math.max(0, Math.floor((height - h1 - BOTTOM_PAD - 40) / ROW_H)); // 40: room for the cap notice (two lines) on page 1; 0 when the header alone fills the page
  const cap2 = Math.max(1, Math.floor((height - h2 - BOTTOM_PAD) / ROW_H));

  let slices = paginate(totalRows, cap1, cap2);
  let truncated = false;
  if (slices.length > maxPages) { slices = slices.slice(0, maxPages); truncated = true; }
  const shownRows = slices.length ? slices[slices.length - 1].to + 1 : 0;
  const note = truncated
    ? `PAGE LIMIT: only the first ${shownRows} of ${totalRows} rows are in this PDF (${maxPages} pages). Export JSON or SVG for the complete flow.`
    : '';
  const total = slices.length;

  const pages = slices.map((s, i) => {
    const head = headerOf(snapshot, lay, meta, width, height, i === 0, i + 1, total, note);
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${BOX_W_MM}mm" height="${BOX_H_MM}mm" viewBox="0 0 ${width} ${height}" font-family="${FONT}" role="img" aria-label="Session flow, page ${i + 1} of ${total}">\n`);
    out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>\n`);
    out.push(head.parts.join('\n'), '\n');
    out.push(`<g transform="translate(0 ${head.height})">\n`);
    svg.drawBody(out, lay, s.from, s.to, gutter, connectorsForPage(lay, s.from, s.to));
    out.push('</g>\n</svg>\n');
    return out.join('');
  });
  return { pages, pageCount: total, totalRows, shownRows, truncated };
}

/** One static HTML document: each page in a block that ends with a page break. No script, no external reference. */
function renderHtml(pages) {
  const css = `@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #ffffff; }
.page { width: ${SHEET_W_MM}mm; height: ${SHEET_H_MM}mm; padding: ${PAD_MM}mm; box-sizing: border-box; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.page svg { display: block; }`;
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + `<title>${esc('Session flow')}</title><style>${css}</style></head><body>\n`
    + pages.map(p => `<div class="page">\n${p}</div>\n`).join('')
    + '</body></html>\n';
}

module.exports = { buildPages, renderHtml, paginate, pageCountFor, connectorsForPage, edgeFitsPage, MAX_PAGES, SHEET_W_MM, SHEET_H_MM };
