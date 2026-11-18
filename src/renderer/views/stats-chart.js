// --- Stats chart ---
// The main chart of the Stats page (#877, spec 48, owner decisions O5, O8, O9): stacked bars per bucket, drawn by hand as
// SVG, no library. Two halves in one file:
//   - a PURE half (scale, layout, bucket label) that `node --test` loads through `require`, and
//   - a DRAW half that turns a layout into SVG and HTML and wires the tooltip, the bar click and the resize redraw.
// It formats nothing itself: the caller hands in the page's own formatters (`fmtTokens`, `formatUsd`, `fmtCount` in
// stats-view.js), so there is exactly one way a number is written. It names no backend: a key's label and colour come from
// the payload; a key that arrives without a colour takes one from a small neutral palette, "Other" is drawn neutral.
//
// Loaded as a classic <script> before views/stats-view.js; its exports land on the global object (the UMD shape the other
// pure renderer modules use). Depends on nothing else.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Colours for keys the payload gives none (models, projects, the single "Total" series). Not a backend table.
  const PALETTE = ['#8088ff', '#3ecf5a', '#f59e0b', '#38bdf8', '#e879a8', '#a3e635', '#c084fc', '#fb923c'];
  const DEFAULT_WIDTH = 720;
  const DEFAULT_HEIGHT = 260;
  const MARGIN = { top: 22, right: 10, bottom: 36, left: 40 };
  const LABEL_SLOT_PX = 48;

  // --- pure half ------------------------------------------------------------------------------------------------------

  function niceStep(raw) {
    const exp = Math.floor(Math.log10(raw));
    const f = raw / Math.pow(10, exp);
    const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return m * Math.pow(10, exp);
  }

  /**
   * A "nice" axis for values 0..maxValue: `{ max, step, ticks: [{ value, label }] }`. `max` is rounded up to a multiple of a
   * 1-2-5 step, so there are at most `target` steps. Zero, a negative or a non-finite maximum gives the axis 0..1. The tick
   * values are rounded so a decimal step (0.001) never shows float noise; labels come from `format`.
   */
  function statsChartScale(maxValue, { target = 5, format } = {}) {
    const fmt = typeof format === 'function' ? format : String;
    const top = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 0;
    let step = 1;
    let max = 1;
    if (top > 0) {
      step = niceStep(top / Math.max(1, target));
      max = Math.ceil(top / step - 1e-9) * step;
    }
    const count = Math.round(max / step);
    const ticks = [];
    for (let i = 0; i <= count; i++) {
      const value = Number((i * step).toPrecision(12));
      ticks.push({ value, label: fmt(value) });
    }
    return { max: Number(max.toPrecision(12)), step, ticks };
  }

  /** The short x-axis label of a bucket: the day or the week start as "MM-DD", a month as its key. */
  function statsBucketLabel(bucket, kind) {
    const key = String((bucket && bucket.bucket) || '');
    return kind === 'month' ? key : key.slice(5);
  }

  /**
   * Stack the series into bars. `series` is the payload's `series`; `width` and `height` the SVG size in px. Keys keep the
   * payload's order from the bottom up, with the "Other" key last (on top) whatever its place in the list; a key with no
   * value in a bucket draws no segment. Returns `{ width, height, plot, scale, bars, labelEvery, keys }`, where `bars[i]` has
   * `{ index, bucket, x, w, total, partial, segments: [{ key, label, value, colour, other, y, h }] }`. Pure geometry: bounded
   * by the number of buckets (the payload caps it), no DOM.
   */
  function statsChartLayout(series, { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, format, colourOf } = {}) {
    const buckets = (series && series.buckets) || [];
    const rawKeys = (series && series.keys) || [];
    const keys = [];
    // A payload colour is the descriptor's colour TOKEN (the key the backend icons use), not a CSS colour: the caller's
    // `colourOf` turns it into one. Without a resolver, or with a token it does not know, the key takes the palette.
    const resolve = (token) => (token && typeof colourOf === 'function' ? colourOf(token) || null : null);
    rawKeys.forEach((k, i) => keys.push({ ...k, colour: resolve(k.colour) || (k.other ? null : PALETTE[i % PALETTE.length]) }));
    const order = keys.filter(k => !k.other).concat(keys.filter(k => k.other));

    const totalOf = (b) => order.reduce((s, k) => s + Math.max(0, Number((b.values || {})[k.key]) || 0), 0);
    const maxTotal = buckets.reduce((m, b) => Math.max(m, totalOf(b)), 0);
    const scale = statsChartScale(maxTotal, { format });

    const widest = scale.ticks.reduce((m, t) => Math.max(m, String(t.label).length), 1);
    const left = Math.max(MARGIN.left, Math.round(widest * 6.5 + 14));
    const plot = { left, top: MARGIN.top, right: Math.max(left + 1, width - MARGIN.right), bottom: Math.max(MARGIN.top + 1, height - MARGIN.bottom) };
    const plotW = plot.right - plot.left;
    const plotH = plot.bottom - plot.top;
    const n = buckets.length;
    const slot = n ? plotW / n : plotW;
    const w = Math.max(1, slot * 0.72);

    const bars = buckets.map((b, i) => {
      let used = 0;
      const segments = [];
      for (const k of order) {
        const value = Math.max(0, Number((b.values || {})[k.key]) || 0);
        if (!value) continue;
        const h = (value / scale.max) * plotH;
        used += h;
        segments.push({ key: k.key, label: k.label, value, colour: k.colour, other: !!k.other, y: plot.bottom - used, h });
      }
      return {
        index: i, bucket: b, x: plot.left + i * slot + (slot - w) / 2, w, total: totalOf(b), partial: !!b.partial, segments,
      };
    });
    const perLabel = Math.max(1, Math.floor(plotW / LABEL_SLOT_PX));
    return { width, height, plot, scale, bars, labelEvery: Math.max(1, Math.ceil(n / perLabel)), keys: order };
  }

  // --- draw half ------------------------------------------------------------------------------------------------------

  function svgEl(name, attrs, cls) {
    const el = document.createElementNS(SVG_NS, name);
    if (cls) el.setAttribute('class', cls);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
  }

  function fillSegment(rect, seg) {
    if (seg.other) rect.classList.add('stats-chart-other');
    else rect.style.fill = seg.colour;
  }

  function tipRow(label, value, colour, other) {
    const row = document.createElement('div');
    row.className = 'stats-chart-tip-row';
    if (colour !== undefined) {
      const sw = document.createElement('span');
      sw.className = 'chart-legend-swatch' + (other ? ' stats-chart-other-swatch' : '');
      if (colour) sw.style.background = colour;
      row.appendChild(sw);
    }
    const l = document.createElement('span');
    l.className = 'stats-chart-tip-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'stats-chart-tip-value';
    v.textContent = value;
    row.append(l, v);
    return row;
  }

  /**
   * Draw the chart into `host` (replacing what it holds): the SVG with the y axis (unit on top), the x axis, the stacked bars
   * and the grid; a tooltip for the bar under the pointer or the focus; the legend below. Options: `format` (axis labels),
   * `formatValue` (tooltip, defaults to `format`), `unit` (axis caption), `title` (the SVG's <title>), `rangeText({start, end})`
   * (the bucket range as text), `onBarClick(bucket)` (the O5 click), `width`/`height`. A partial bucket is drawn lighter and
   * called "so far" (O8).
   */
  function drawStatsChart(host, series, opts = {}) {
    const format = opts.format || String;
    const formatValue = opts.formatValue || format;
    const rangeText = opts.rangeText || ((b) => (b.start === b.end ? b.start : `${b.start} – ${b.end}`));
    const width = Math.max(240, Math.round(opts.width || host.clientWidth || DEFAULT_WIDTH));
    const height = opts.height || DEFAULT_HEIGHT;
    const lay = statsChartLayout(series, { width, height, format, colourOf: opts.colourOf });
    const kind = series && series.bucket;

    const wrap = document.createElement('div');
    wrap.className = 'stats-chart';
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'stats-chart-svg' });
    const title = svgEl('title');
    title.textContent = opts.title || 'Chart';
    svg.appendChild(title);

    const tip = document.createElement('div');
    tip.className = 'stats-chart-tip';
    tip.hidden = true;

    // y axis: grid line and label per tick, the unit on top.
    const { plot, scale } = lay;
    const plotH = plot.bottom - plot.top;
    for (const t of scale.ticks) {
      const y = plot.bottom - (t.value / scale.max) * plotH;
      svg.appendChild(svgEl('line', { x1: plot.left, x2: plot.right, y1: y, y2: y }, 'stats-chart-grid'));
      const text = svgEl('text', { x: plot.left - 6, y: y + 3, 'text-anchor': 'end' }, 'stats-chart-axis');
      text.textContent = t.label;
      svg.appendChild(text);
    }
    if (opts.unit) {
      const unit = svgEl('text', { x: 4, y: 11 }, 'stats-chart-unit');
      unit.textContent = opts.unit;
      svg.appendChild(unit);
    }

    const showTip = (bar) => {
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'stats-chart-tip-head';
      head.textContent = rangeText(bar.bucket) + (bar.partial ? ' · so far' : '');
      tip.appendChild(head);
      for (const seg of bar.segments.slice().reverse()) tip.appendChild(tipRow(seg.label, formatValue(seg.value), seg.other ? '' : seg.colour, seg.other));
      const total = tipRow('Total', formatValue(bar.total));
      total.classList.add('stats-chart-tip-total');
      tip.appendChild(total);
      tip.hidden = false;
      const cx = bar.x + bar.w / 2;
      tip.style.top = '8px';
      if (cx > width * 0.6) { tip.style.left = ''; tip.style.right = `${Math.max(0, width - cx + 10)}px`; }
      else { tip.style.right = ''; tip.style.left = `${cx + 10}px`; }
    };
    const hideTip = () => { tip.hidden = true; };

    for (const bar of lay.bars) {
      const b = bar.bucket;
      const label = `${rangeText(b)}${bar.partial ? ' (so far)' : ''}: ${formatValue(bar.total)}`;
      const g = svgEl('g', { tabindex: 0, role: 'button', 'aria-label': label, 'data-bucket': b.bucket }, 'stats-chart-bar' + (bar.partial ? ' is-partial' : ''));
      // A full-height hit area, so a short bar is as easy to hover and click as a tall one.
      g.appendChild(svgEl('rect', { x: bar.x, y: plot.top, width: bar.w, height: plotH }, 'stats-chart-hit'));
      for (const seg of bar.segments) {
        const r = svgEl('rect', { x: bar.x, y: seg.y, width: bar.w, height: Math.max(0.5, seg.h), 'data-key': seg.key }, 'stats-chart-seg');
        fillSegment(r, seg);
        g.appendChild(r);
      }
      g.addEventListener('mouseenter', () => showTip(bar));
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('focus', () => showTip(bar));
      g.addEventListener('blur', hideTip);
      if (opts.onBarClick) {
        g.addEventListener('click', () => opts.onBarClick(b));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onBarClick(b); } });
      }
      svg.appendChild(g);

      if (bar.index % lay.labelEvery === 0) {
        const t = svgEl('text', { x: bar.x + bar.w / 2, y: plot.bottom + 14, 'text-anchor': 'middle' }, 'stats-chart-axis');
        t.textContent = statsBucketLabel(b, kind);
        svg.appendChild(t);
      }
      if (bar.partial) {
        const t = svgEl('text', { x: bar.x + bar.w, y: plot.bottom + 27, 'text-anchor': 'end' }, 'stats-chart-axis stats-chart-sofar');
        t.textContent = 'so far';
        svg.appendChild(t);
      }
    }

    wrap.append(svg, tip);
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    for (const k of lay.keys) {
      const item = document.createElement('span');
      item.className = 'chart-legend-item';
      const sw = document.createElement('span');
      sw.className = 'chart-legend-swatch' + (k.other ? ' stats-chart-other-swatch' : '');
      if (!k.other && k.colour) sw.style.background = k.colour;
      item.append(sw, document.createTextNode(k.label));
      legend.appendChild(item);
    }
    wrap.appendChild(legend);
    host.replaceChildren(wrap);
    return { width, layout: lay };
  }

  /** End the resize observer of a mounted chart. Safe on a host that never had one. */
  function unmountStatsChart(host) {
    if (host && host._statsChartObserver) { host._statsChartObserver.disconnect(); host._statsChartObserver = null; }
  }

  /**
   * `drawStatsChart` plus a redraw when the host's width changes (a window resize, the sidebar, a panes split). One observer
   * per host, redrawn on the next frame and only for a width that moved by a pixel or more: no per-frame work.
   */
  function mountStatsChart(host, series, opts = {}) {
    unmountStatsChart(host);
    let drawn = drawStatsChart(host, series, opts);
    if (typeof ResizeObserver !== 'function') return drawn;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // A host that left the document (the page was rebuilt or closed) has nothing to redraw and nothing to watch.
        if (!host.isConnected) { unmountStatsChart(host); return; }
        const w = Math.round(host.clientWidth);
        if (!w || Math.abs(w - drawn.width) < 1) return;
        drawn = drawStatsChart(host, series, opts);
      });
    });
    observer.observe(host);
    host._statsChartObserver = observer;
    return drawn;
  }

  return { statsChartScale, statsChartLayout, statsBucketLabel, drawStatsChart, mountStatsChart, unmountStatsChart };
});
