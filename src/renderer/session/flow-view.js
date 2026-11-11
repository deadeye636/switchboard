// --- The Flow tab of the timeline viewer (spec 46, #826, T8 and T9) ---
//
// One lane of cards for one session, read from a neutral `FlowSnapshot` (src/shared/flow-snapshot.js) and laid out
// by `FlowLayout` (src/shared/flow-layout.js). It names no backend and knows no transcript format (CLAUDE.md reflex 5):
// whether Flow is offered comes from the backend's capability answer (`window._backendsById[id].capabilities`), what
// is drawn comes from the snapshot.
//
// SHAPE OF THE FILE. The whole body is wrapped and exports ONE global, `FlowView`, so the pure helpers can be tested
// in node (test/flow-view-logic.test.js) and the file adds no helper name to the renderer's shared scope. It only
// READS app.js state (never writes it, the #218 shadowing trap) and resolves every element at call time, so nothing
// here runs at parse time. It loads AFTER timeline-view.js, which calls `FlowView.attach(session)` at call time.
//
// PERFORMANCE (plan "Performance bounds", T8; owner constraint: nothing blocks the renderer)
//   - Fixed row height, windowing by index arithmetic from scrollTop: `computeSlice`. Overscan ~10.
//   - The passive scroll listener only records scrollTop and schedules ONE rAF; the rAF reads nothing from the DOM.
//     (The one property read per scroll event is scrollTop itself, on the event's own target, after layout.)
//   - The slice is built in a DocumentFragment and swapped with replaceChildren; the DOM holds ~2 x overscan + a
//     viewport of rows however many steps there are. `contain: layout paint` on the scroller (style.css).
//   - Connectors only through `FlowLayout.connectorsForRows` for the visible range; one lane = one rail element.
//   - Lanes (T12): git-log-graph shape. Rails, dots and spawn / return bars live in ONE gutter on the left
//     (`FlowLayout.gutterWidth`, set once per layout as `--flow-gutter`); a row holds ONE card, which starts right of
//     the gutter and is never shifted per column. There is no per-column DOM, so the node count follows the row window
//     and not the lane count. The bars are absolutely placed boxes from `FlowLayout.connectorRects`, drawn from the same
//     capped connector list.
//   - No CSS animation or transition anywhere in the Flow styles (#519: motion is paid by the frame).
//   - At most CACHE_MAX snapshots are held (a small LRU) and all are dropped when the viewer closes.
//   - The viewport height comes from a ResizeObserver that exists only while the viewer is open.
//
// STATUS POLL (T9). `getSessionFlowStatus` every POLL_MS, and only while `shouldPoll` says so: viewer open, Flow tab
// visible, window visible (`document.visibilityState` and `body.window-hidden`), and the session running (or it was
// running when last looked at, so ONE automatic refresh follows its end). A chain of setTimeouts, never an interval:
// the next is armed after the previous call returned, so calls cannot overlap. Everything is stopped on a tab
// switch, on close and on a session change.
//
// Free globals it reaches for (all at call time): app.js `activePtyIds`; backends/backend-registry.js
// `sessionBackendId` and `window._backendsById`; `window.api.getSessionFlow / cancelSessionFlow / getSessionFlowStatus / exportSessionFlow` (feature-detected); `showControlDialog`, `showControlToast` (dialogs/control-dialogs.js); `sessionBadgeBackendId` (dialogs/dialogs.js, the backend the sidebar badge names);
// FlowLayout (shared/flow-layout.js); loads AFTER shared/flow-text.js; FlowText (shared/flow-text.js, a parameter of the factory: the checkpoint figure, banner items, lane tag and row text, shared with the SVG export).
//
// Callers: session/timeline-view.js (`FlowView.attach` from showTimelineViewer).

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('../../shared/flow-text'));
  else root.FlowView = factory(root.FlowText);   // a classic <script> loaded before this one
})(typeof self !== 'undefined' ? self : this, function (FlowText) {
  const { bannerItems, bannerSummary, checkpointInfo, rowText, laneTagInfo, rowBadge } = FlowText;
  const ROW_H = 40;
  const OVERSCAN = 10;
  const POLL_MS = 5000;
  const CACHE_MAX = 2;
  const CONNECTOR_CAP = 200;
  const MIN_CARD_W = 420; // the cards keep at least this much room to the right of the gutter
  const FALLBACK_VIEWPORT_H = 600;

  // ---------- pure helpers (tested in node) ----------

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  /** The rows [start, end) to draw for a scroll position. Index arithmetic only. */
  function computeSlice(scrollTop, viewportH, rowH, total, overscan) {
    if (!(total > 0) || !(rowH > 0)) return { start: 0, end: 0 };
    const top = Math.max(0, scrollTop || 0);
    const first = Math.floor(top / rowH);
    const last = Math.ceil((top + Math.max(0, viewportH || 0)) / rowH);
    const start = clamp(first - overscan, 0, total);
    const end = clamp(last + overscan, start, total);
    return { start, end };
  }

  /**
   * step id -> row index, for every step of the snapshot, including steps hidden in a collapsed group or lane
   * (they map to the row that stands for them). `rows` is FlowLayout's row list for the same snapshot.
   * A step with a row of its own maps to it; the first step of a collapsed group to the group row; the rest of a
   * collapsed group (the next `count - 1` steps without a row of their own) to the same group row; a step of a
   * collapsed lane, or of a lane below one, to the summary row of the nearest collapsed ancestor (it never uses up a group's count).
   */
  function buildStepRowMap(snapshot, rows, order) {
    const map = new Map();
    // Row order, not snapshot order: with child lanes interleaved, a hidden group member follows its group in the
    // layout's order. FlowLayout hands that order back as `lay.order`.
    const steps = order || (snapshot && snapshot.steps) || [];
    const byKey = new Map();
    for (let i = 0; i < rows.length; i++) byKey.set(rows[i].key, i);
    // A step of a lane under a collapsed ancestor stands for that ancestor's summary row, found by walking parents.
    const parentOf = new Map();
    for (const l of (snapshot && snapshot.lanes) || []) parentOf.set(l.id, l.parentLaneId);
    const summaryOf = (laneId) => {
      let id = laneId;
      for (let hops = 0; id != null && hops <= parentOf.size; hops++) {
        const i = byKey.get('l:' + id);
        if (i !== undefined) return i;
        id = parentOf.get(id);
      }
      return undefined;
    };
    let group = -1;
    let remaining = 0;
    for (const s of steps) {
      let idx = byKey.get(s.id);
      if (idx !== undefined) { map.set(s.id, idx); continue; }
      idx = byKey.get('g:' + s.id);
      if (idx !== undefined) {
        map.set(s.id, idx);
        group = idx;
        remaining = Math.max(0, rows[idx].count - 1);
        continue;
      }
      idx = summaryOf(s.laneId);
      if (idx !== undefined) { map.set(s.id, idx); continue; }
      if (remaining > 0 && group >= 0) { map.set(s.id, group); remaining--; continue; }
    }
    return map;
  }

  /** The step the row at the top of the viewport stands for, with the pixel offset into that row. */
  function captureAnchor(snapshot, rows, scrollTop, rowH) {
    if (!rows || !rows.length || !(rowH > 0)) return null;
    const idx = clamp(Math.floor(Math.max(0, scrollTop || 0) / rowH), 0, rows.length - 1);
    const row = rows[idx];
    let ordinal = row.step && Number.isFinite(row.step.ordinal) ? row.step.ordinal : null;
    if (ordinal == null) {
      const found = ((snapshot && snapshot.steps) || []).find((s) => s.id === row.firstStepId);
      ordinal = found && Number.isFinite(found.ordinal) ? found.ordinal : null;
    }
    return { stepId: row.firstStepId, ordinal, offset: clamp((scrollTop || 0) - idx * rowH, 0, rowH - 1) };
  }

  /**
   * The row index a step-id (or, failing that, its nearest surviving ordinal) sits on in the new layout, or -1.
   * The id lookup is the `stepRows` map built once per layout (O(1)); the ordinal search runs over the SNAPSHOT's
   * steps, whose ordinals are monotonic, and only maps the step it lands on to its row, so it stays correct
   * although the rows are no longer in ordinal order.
   */
  function resolveRowForStep(snapshot, stepRows, stepId, ordinal) {
    if (stepId != null && stepRows.has(stepId)) return stepRows.get(stepId);
    const steps = (snapshot && snapshot.steps) || [];
    if (ordinal == null || !steps.length) return -1;
    // First step whose ordinal is >= the vanished one; the last step when none is.
    let lo = 0;
    let hi = steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid].ordinal < ordinal) lo = mid + 1; else hi = mid;
    }
    const s = steps[Math.min(lo, steps.length - 1)];
    return s && stepRows.has(s.id) ? stepRows.get(s.id) : -1;
  }

  /**
   * The row the selection sits on after a re-layout (a Refresh, an automatic refresh at the session's end, a fold): the
   * row with the selected key when it still exists, else the row that stands for the selected step, which is the
   * nearest collapsed ancestor lane's summary when the step's lane is folded now (`stepRows` is `buildStepRowMap`). -1 when
   * neither resolves. Lane ids (`agent:<id>`) and step ids are stable across reads, so no other state is needed.
   */
  function resolveSelection(snapshot, rows, stepRows, selectedKey, selectedStepId) {
    if (selectedKey != null) {
      for (let i = 0; i < rows.length; i++) if (rows[i].key === selectedKey) return i;
    }
    return selectedStepId != null ? resolveRowForStep(snapshot, stepRows, selectedStepId, null) : -1;
  }

  /** The scrollTop that puts the anchored step back where it was; `null` when the anchor can not be resolved. */
  function restoreAnchor(snapshot, rows, stepRows, anchor, rowH) {
    if (!anchor || !rows || !rows.length) return null;
    const idx = resolveRowForStep(snapshot, stepRows, anchor.stepId, anchor.ordinal);
    if (idx < 0) return null;
    return idx * rowH + clamp(anchor.offset || 0, 0, rowH - 1);
  }

  /** Should the status timer be armed. All five conditions, nothing else. */
  function shouldPoll(s) {
    return !!(s && s.viewerOpen && s.flowVisible && s.windowVisible && (s.running || s.endPending));
  }

  /** A reply that only says "this read was cancelled or replaced": it carries no steps and must not replace a good snapshot. */
  function isCancelledAnswer(snap) {
    return !!(snap && Array.isArray(snap.steps) && snap.steps.length === 0 && Array.isArray(snap.limitations)
      && snap.limitations.some((l) => l && l.id === 'read-cancelled'));
  }

  /** Does a status answer mean "there is more to read". */
  function statusMeansNewSteps(status) { return status === 'grew' || status === 'rewritten'; }

  // bannerItems, bannerSummary, checkpointInfo, rowText, laneTagInfo and rowBadge are the shared words (src/shared/flow-text.js).

  // ---------- the view (browser only; every DOM access is at call time) ----------

  const cache = new Map(); // sessionId -> entry; insertion order = LRU order
  let lastTab = 'events';
  let cur = null; // the session the viewer is showing
  let wired = false;
  let ro = null; // ResizeObserver, only while open
  let mo = null; // MutationObserver on the viewer's style, only while open
  let visHandler = null;
  let lastLayoutMs = 0;
  let connectorsTruncated = false; // the last window had more connectors than CONNECTOR_CAP (no silent drop: debugStats says so)

  const $ = (id) => document.getElementById(id);
  const api = () => (typeof window !== 'undefined' ? window.api : null);
  const flowApiThere = () => { const a = api(); return !!(a && typeof a.getSessionFlow === 'function'); };

  function isRunning(id) { return typeof activePtyIds !== 'undefined' && activePtyIds.has(id); }
  function windowVisible() {
    return document.visibilityState !== 'hidden' && !(document.body && document.body.classList.contains('window-hidden'));
  }
  // Open AND on top: in panes mode a hidden tab keeps its inline display and gets `pane-hosted-hidden` instead.
  function viewerOpen() { const v = $('timeline-viewer'); return !!v && v.style.display !== 'none' && !v.classList.contains('pane-hosted-hidden'); }

  function touch(id, entry) {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function newEntry() {
    return { snapshot: null, collapse: FlowLayout.emptyCollapseState(), lay: null, stepRows: new Map(), turnStarts: new Set(), selectedKey: null, selectedStepId: null, scrollTop: 0, bannerOpen: false };
  }

  function stepRowsOf(entry) {
    if (!entry.stepRows) entry.stepRows = buildStepRowMap(entry.snapshot, entry.lay.rows, entry.lay.order);
    return entry.stepRows;
  }

  function relayout(entry) {
    const t0 = performance.now();
    entry.lay = FlowLayout.layout(entry.snapshot, entry.collapse);
    entry.stepRows = null; // built on first use (selection / anchor); a plain scroll never needs it
    entry.turnStarts = new Set(entry.lay.turns.map((t) => t.startRow));
    lastLayoutMs = performance.now() - t0;
  }

  /** Is Flow offered for this session, and if not, why. Answered from the backend's capability row, never a read. */
  function availability(session) {
    if (!flowApiThere()) return { ok: false, reason: 'Flow is not available in this build.' };
    const b = typeof sessionBackendId === 'function' && window._backendsById ? window._backendsById[sessionBackendId(session)] : null;
    const ans = b && b.capabilities && b.capabilities.sessionFlow;
    if (ans && (ans.state === 'no' || ans.state === 'unknown')) {
      return { ok: false, reason: ans.note || 'This backend does not provide a session flow.' };
    }
    return { ok: true, reason: '' };
  }

  // ----- chrome: tabs -----

  function applyTabButtons() {
    const flowBtn = $('timeline-tab-flow');
    const evBtn = $('timeline-tab-events');
    if (!flowBtn || !evBtn || !cur) return;
    const can = cur.avail.ok && !cur.declined;
    flowBtn.disabled = !can;
    flowBtn.setAttribute('aria-disabled', can ? 'false' : 'true');
    flowBtn.title = can ? '' : (cur.declined ? cur.declineReason : cur.avail.reason);
    for (const [btn, name] of [[evBtn, 'events'], [flowBtn, 'flow']]) {
      const on = cur.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    }
  }

  function setTab(name) {
    if (!cur) return;
    if (name === 'flow' && !(cur.avail.ok && !cur.declined)) name = 'events';
    cur.tab = name;
    lastTab = name;
    const flow = name === 'flow';
    const body = $('timeline-viewer-body');
    const filters = $('timeline-viewer-filters');
    const view = $('flow-view');
    if (body) body.style.display = flow ? 'none' : '';
    if (filters) filters.style.display = flow ? 'none' : '';
    if (view) view.style.display = flow ? 'flex' : 'none';
    applyTabButtons();
    if (flow) {
      const sc = $('flow-scroller');
      if (sc) { cur.viewportH = sc.clientHeight || FALLBACK_VIEWPORT_H; sc.scrollTop = cur.scrollTop; } // a hidden scroller forgot its offset
      if (!cur.entry || !cur.entry.snapshot) refresh();
      else { markDirty(); render(); }
    }
    syncPoll();
  }

  // ----- the list -----

  function markDirty() { if (cur) cur.rendered = null; }

  function setStatusText(text) {
    const el = $('flow-status');
    if (el) el.textContent = text || '';
  }

  function showHint(on) {
    if (!cur) return;
    cur.hint = !!on;
    const el = $('flow-hint');
    if (el) el.hidden = !on;
    const btn = $('flow-refresh-btn');
    if (btn) btn.classList.toggle('flow-refresh-pending', !!on);
  }

  function renderBanner() {
    const el = $('flow-banner');
    if (!el) return;
    const items = cur && cur.entry ? bannerItems(cur.entry.snapshot) : [];
    if (!items.length) { el.replaceChildren(); el.hidden = true; return; }
    const open = !!(cur.entry && cur.entry.bannerOpen);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flow-banner-toggle';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = (open ? '▾ ' : '▸ ') + bannerSummary(items);
    const kids = [btn];
    if (open) {
      const list = document.createElement('div');
      list.className = 'flow-banner-list';
      for (const it of items) {
        const p = document.createElement('div');
        p.className = 'flow-banner-item';
        p.textContent = (it.caps.length ? it.caps.join(', ') + ': ' : '') + it.text;
        list.appendChild(p);
      }
      kids.push(list);
    }
    el.replaceChildren(...kids);
    el.hidden = false;
  }

  function buildRow(entry, index) {
    const lay = entry.lay;
    const row = lay.rows[index];
    const el = document.createElement('div');
    el.id = 'flow-row-' + index;
    el.setAttribute('role', 'option');
    el.dataset.index = String(index);
    const isChild = row.depth || (row.kind === 'step' && row.step.parentStepId);
    let cls = 'flow-row flow-row-' + row.kind + (isChild ? ' flow-row-member' : '');
    const selected = row.key === entry.selectedKey;
    if (selected) cls += ' selected';
    if (entry.turnStarts.has(index)) cls += ' flow-row-turn-start';
    el.className = cls;
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (row.kind !== 'step') el.setAttribute('aria-expanded', row.kind === 'group' && row.expanded ? 'true' : 'false');

    const dot = document.createElement('span');
    dot.className = 'flow-dot';
    if (!isChild) dot.style.left = FlowLayout.dotX(row.col) + 'px'; // members sit in the card area, their dot is styled in css
    const badge = document.createElement('span');
    badge.className = 'flow-badge';
    badge.textContent = rowBadge(row);
    const label = document.createElement('span');
    label.className = 'flow-label';
    const text = (row.kind === 'group' ? (row.expanded ? '▾ ' : '▸ ') : row.kind === 'lane' ? '▸ ' : '') + rowText(row, lay.columns);
    label.textContent = text;
    el.title = text;
    el.append(dot, badge);
    if (row.laneStart) {
      // The lane's name in words (colour is never the only signal), and the way to fold it again.
      const tag = document.createElement('span');
      tag.className = 'flow-lane-tag';
      const info = laneTagInfo(lay.columns, row.laneId);
      tag.textContent = info.text;
      tag.title = info.title;
      tag.setAttribute('aria-label', info.title);
      el.appendChild(tag);
      // The row's own label carries the lane tag and who started the lane, so a group row (whose keys fold the group) still says it.
      el.setAttribute('aria-label', text + '. ' + info.text + '. ' + info.title);
    }
    el.appendChild(label);

    if (entry.turnStarts.has(index) && row.turn != null) {
      const t = document.createElement('span');
      t.className = 'flow-turn';
      t.textContent = 'turn ' + row.turn;
      el.appendChild(t);
    }
    if (row.flags && row.flags.length) {
      const f = document.createElement('span');
      f.className = 'flow-flags';
      f.textContent = row.flags.length + (row.flags.length === 1 ? ' flag' : ' flags');
      el.appendChild(f);
    }
    const cp = row.kind === 'step' ? checkpointInfo(row.step) : null;
    if (cp) {
      const box = document.createElement('span');
      box.className = 'flow-cp' + (cp.estimated ? ' estimated' : '');
      if (cp.pct != null) {
        const bar = document.createElement('span');
        bar.className = 'flow-cp-bar';
        const fill = document.createElement('span');
        fill.className = 'flow-cp-fill';
        fill.style.width = cp.pct.toFixed(1) + '%';
        bar.appendChild(fill);
        box.appendChild(bar);
      }
      const t = document.createElement('span');
      t.className = 'flow-cp-text';
      t.textContent = cp.text;
      box.appendChild(t);
      el.appendChild(box);
    }
    return el;
  }

  function drawRails(entry, start, end) {
    const box = $('flow-rails');
    if (!box) return;
    const { connectors, truncated } = FlowLayout.connectorsForRows(entry.lay, start, Math.max(start, end - 1), CONNECTOR_CAP);
    connectorsTruncated = truncated;
    box.dataset.truncated = truncated ? '1' : '0';
    let n = 0;
    for (const c of connectors) {
      for (const r of FlowLayout.connectorRects(c, ROW_H)) {
        let el = box.children[n];
        if (!el) { el = document.createElement('div'); box.appendChild(el); }
        n++;
        el.className = r.kind === 'rail' ? (r.waiting ? 'flow-rail flow-rail-waiting' : 'flow-rail') : 'flow-edge flow-edge-' + r.kind;
        el.style.left = r.x + 'px';
        el.style.top = r.y + 'px';
        el.style.width = r.w + 'px';
        el.style.height = r.h + 'px';
      }
    }
    while (box.children.length > n) box.removeChild(box.lastChild);
  }

  function rowsFragment(entry, from, to) {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.appendChild(buildRow(entry, i));
    return frag;
  }

  /**
   * Draw the visible slice. Reads only cached state; the only DOM calls are writes. A scroll that moves the window
   * by a few rows removes the rows that left and adds the ones that entered; every other row node stays as it is.
   * A full rebuild (layout, selection, resize, a jump past the old window) clears `cur.rendered` first.
   */
  function render() {
    if (!cur || cur.tab !== 'flow') return;
    const slice = $('flow-slice');
    const spacer = $('flow-spacer');
    const scroller = $('flow-scroller');
    if (!slice || !spacer || !scroller) return;
    const entry = cur.entry;
    const rows = entry && entry.lay ? entry.lay.rows : [];
    const { start, end } = computeSlice(cur.scrollTop, cur.viewportH, ROW_H, rows.length, OVERSCAN);
    const r = cur.rendered;
    if (r && r.start === start && r.end === end) return;
    if (!rows.length) { spacer.style.height = '0px'; slice.replaceChildren(); cur.rendered = { start, end }; return; }
    if (r && start < r.end && end > r.start && slice.childElementCount === r.end - r.start) {
      for (let i = r.start; i < start; i++) slice.removeChild(slice.firstChild);
      for (let i = end; i < r.end; i++) slice.removeChild(slice.lastChild);
      if (start < r.start) slice.insertBefore(rowsFragment(entry, start, Math.min(r.start, end)), slice.firstChild);
      if (end > r.end) slice.appendChild(rowsFragment(entry, Math.max(r.end, start), end));
    } else {
      spacer.style.height = rows.length * ROW_H + 'px';
      slice.replaceChildren(rowsFragment(entry, start, end));
      cur.selIdx = entry.selectedKey != null ? FlowLayout.findRowIndex(entry.lay, entry.selectedKey) : -1;
    }
    if (cur.selIdx >= start && cur.selIdx < end) scroller.setAttribute('aria-activedescendant', 'flow-row-' + cur.selIdx);
    else scroller.removeAttribute('aria-activedescendant');
    slice.style.top = start * ROW_H + 'px';
    drawRails(entry, start, end);
    cur.rendered = { start, end };
  }

  function onScroll(ev) {
    if (!cur) return;
    cur.scrollTop = ev.target.scrollTop;
    if (cur.raf) return;
    cur.raf = requestAnimationFrame(() => { if (cur) { cur.raf = 0; render(); } });
  }

  function setScroll(top) {
    const sc = $('flow-scroller');
    if (!sc || !cur) return;
    cur.scrollTop = Math.max(0, top);
    sc.scrollTop = cur.scrollTop;
  }

  function currentRowIndex(entry) {
    if (!entry || !entry.lay) return -1;
    if (entry.selectedKey == null && entry.selectedStepId == null) return -1;
    const rows = entry.lay.rows;
    const direct = entry.selectedKey != null ? FlowLayout.findRowIndex(entry.lay, entry.selectedKey) : -1;
    if (direct >= 0) return direct;
    return resolveSelection(entry.snapshot, rows, stepRowsOf(entry), null, entry.selectedStepId);
  }

  /** Re-layout after a snapshot or a collapse change, keeping the scroll anchor and the selected step. */
  function relayoutKeepingPlace() {
    const entry = cur.entry;
    const anchor = entry.lay ? captureAnchor(entry.snapshot, entry.lay.rows, cur.scrollTop, ROW_H) : null;
    relayout(entry);
    const rows = entry.lay.rows;
    const spacer = $('flow-spacer');
    if (spacer) {
      spacer.style.height = rows.length * ROW_H + 'px';
      // The gutter is sized once per layout from the widest column in use; no DOM read, nothing changes while scrolling.
      const gutter = FlowLayout.gutterWidth(entry.lay.stats.cols);
      spacer.style.setProperty('--flow-gutter', gutter + 'px');
      spacer.style.minWidth = gutter + MIN_CARD_W + 'px'; // a very wide graph scrolls sideways
    }
    const sel = currentRowIndex(entry);
    if (sel >= 0) entry.selectedKey = rows[sel].key; else { entry.selectedKey = null; }
    const top = anchor ? restoreAnchor(entry.snapshot, rows, stepRowsOf(entry), anchor, ROW_H) : null;
    markDirty();
    if (top != null) setScroll(top);
    render();
  }

  function select(index, toggle) {
    const entry = cur && cur.entry;
    if (!entry || !entry.lay) return;
    const row = entry.lay.rows[index];
    if (!row) return;
    entry.selectedKey = row.key;
    entry.selectedStepId = row.firstStepId;
    if (toggle && row.kind !== 'step') {
      entry.collapse = row.kind === 'group'
        ? FlowLayout.setGroupExpanded(entry.collapse, row.groupKey, !row.expanded)
        : FlowLayout.setLaneExpanded(entry.collapse, row.laneId, true);
      relayoutKeepingPlace();
    } else {
      markDirty();
      render();
    }
  }

  /** Fold the lane whose first row this is (the row keeps the selection through the summary that replaces it). */
  function collapseLane(index) {
    const entry = cur && cur.entry;
    const row = entry && entry.lay && entry.lay.rows[index];
    if (!row || !row.laneStart) return;
    entry.selectedKey = row.key;
    entry.selectedStepId = row.firstStepId;
    entry.collapse = FlowLayout.setLaneExpanded(entry.collapse, row.laneId, false);
    relayoutKeepingPlace();
  }

  function ensureVisible(index) {
    const top = index * ROW_H;
    if (top < cur.scrollTop) setScroll(top);
    else if (top + ROW_H > cur.scrollTop + cur.viewportH) setScroll(top + ROW_H - cur.viewportH);
  }

  function onClick(ev) {
    const el = ev.target.closest && ev.target.closest('.flow-row');
    if (!el) return;
    if (ev.target.closest('.flow-lane-tag')) { collapseLane(Number(el.dataset.index)); return; }
    select(Number(el.dataset.index), true);
  }

  function onKey(ev) {
    const entry = cur && cur.entry;
    if (!entry || !entry.lay || !entry.lay.rows.length) return;
    const rows = entry.lay.rows;
    const at = currentRowIndex(entry);
    const page = Math.max(1, Math.floor(cur.viewportH / ROW_H) - 1);
    let next = null;
    switch (ev.key) {
      case 'ArrowDown': next = at < 0 ? 0 : Math.min(rows.length - 1, at + 1); break;
      case 'ArrowUp': next = at < 0 ? 0 : Math.max(0, at - 1); break;
      case 'PageDown': next = Math.min(rows.length - 1, Math.max(0, at) + page); break;
      case 'PageUp': next = Math.max(0, Math.max(0, at) - page); break;
      case 'Home': next = 0; break;
      case 'End': next = rows.length - 1; break;
      case 'Enter':
      case ' ':
      case 'ArrowRight':
      case 'ArrowLeft': {
        if (at < 0) return;
        const row = rows[at];
        if (row.kind === 'step') {
          if (row.laneStart && ev.key === 'ArrowLeft') { ev.preventDefault(); collapseLane(at); }
          return;
        }
        const wantOpen = ev.key === 'ArrowLeft' ? false : ev.key === 'ArrowRight' ? true : !(row.kind === 'group' && row.expanded);
        // A lane summary is only ever collapsed, so Left has nothing to do there; a group is left alone when it already is as asked.
        if ((row.kind === 'group' && row.expanded === wantOpen) || (row.kind === 'lane' && !wantOpen)) { ev.preventDefault(); return; }
        ev.preventDefault();
        select(at, true);
        return;
      }
      default: return;
    }
    ev.preventDefault();
    select(next, false);
    ensureVisible(next);
    render();
  }

  // ----- reading -----

  function showMessage(text) {
    const m = $('flow-message');
    if (m) { m.textContent = text || ''; m.hidden = !text; }
  }

  async function refresh(opts) {
    const c = cur;
    if (!c || c.loading) return;
    const a = api();
    if (!flowApiThere()) { showMessage('Flow is not available in this build.'); return; }
    c.loading = true;
    const gen = ++c.gen;
    const btn = $('flow-refresh-btn');
    if (btn) btn.disabled = true;
    setStatusText(opts && opts.auto ? 'Session ended, refreshing…' : 'Reading…');
    let snap = null;
    let failed = null;
    try { snap = await a.getSessionFlow(c.sessionId); } catch (e) { failed = e; }
    if (cur !== c || c.gen !== gen) return; // closed, or superseded
    c.loading = false;
    if (btn) btn.disabled = false;
    if (failed) {
      setStatusText('');
      showMessage('Could not read the flow' + (failed && failed.message ? ': ' + String(failed.message).slice(0, 200) : '.'));
      return;
    }
    if (snap == null) {
      c.declined = true;
      c.declineReason = 'This backend does not provide a session flow.';
      setStatusText('');
      applyTabButtons();
      showMessage(c.declineReason);
      if (c.tab === 'flow') setTab('events');
      return;
    }
    if (isCancelledAnswer(snap)) { setStatusText(''); return; } // replaced by a newer read: keep what is drawn
    showMessage('');
    const entry = c.entry || (c.entry = cache.get(c.sessionId) || newEntry());
    entry.snapshot = snap;
    touch(c.sessionId, entry);
    c.entry = entry;
    renderBanner();
    showHint(false);
    setStatusText(snap.complete === false ? 'Partial read' : '');
    relayoutKeepingPlace();
  }

  // ----- export -----

  function say(message) {
    if (typeof showControlToast === 'function') showControlToast({ message, timeoutMs: 4000 });
    else setStatusText(message);
  }

  /** The name the sidebar badge shows for this session's backend (`sessionBadgeBackendId` + the descriptor's label, as the badge's title does); '' when unknown. */
  function backendLabelFor(session) {
    if (!session || typeof sessionBadgeBackendId !== 'function') return '';
    const id = sessionBadgeBackendId(session);
    const d = id && window.getBackend ? window.getBackend(id) : null;
    return d && d.label ? String(d.label) : String(id || '');
  }

  /** Ask first (the file can hold prompts, commands and local paths), then let main read fresh, ask for a place and write. */
  async function exportFlow(format) {
    const c = cur;
    const a = api();
    if (!c || c.exporting || !a || typeof a.exportSessionFlow !== 'function') return;
    if (typeof showControlDialog === 'function') {
      const go = await showControlDialog({
        title: 'Export flow',
        message: 'The exported file can contain prompts, commands and local paths from this session. Check it before you share it.',
        confirmLabel: 'Choose file…',
      });
      if (!go) return;
    }
    c.exporting = true;
    const sel = $('flow-export-select');
    if (sel) sel.disabled = true;
    let res = null;
    try { res = await a.exportSessionFlow(c.sessionId, format, { backendLabel: backendLabelFor(c.session) }); } catch { res = null; }
    c.exporting = false;
    if (sel) sel.disabled = false;
    if (!res) say('The export failed.');
    else if (res.ok) say('Flow exported' + (res.name ? ' to ' + res.name : '') + '.');
    else if (!res.canceled) say(res.error || 'The export failed.');
  }

  // ----- polling -----

  function gateNow() {
    return shouldPoll({
      viewerOpen: viewerOpen(),
      flowVisible: !!cur && cur.tab === 'flow',
      windowVisible: windowVisible(),
      running: !!cur && isRunning(cur.sessionId),
      endPending: !!cur && cur.wasRunning,
    });
  }

  function stopTimer() {
    if (cur && cur.timer) { clearTimeout(cur.timer); cur.timer = 0; }
  }

  function syncPoll() {
    if (!cur) return;
    if (cur.tab === 'flow' && isRunning(cur.sessionId)) cur.wasRunning = true;
    if (!gateNow()) { stopTimer(); return; }
    if (!cur.timer && !cur.polling) cur.timer = setTimeout(tick, POLL_MS);
  }

  async function tick() {
    const c = cur;
    if (!c) return;
    c.timer = 0;
    if (!gateNow()) return;
    const running = isRunning(c.sessionId);
    if (c.wasRunning && !running && !c.loading) { // a manual read in flight at the end: the automatic one waits for it
      c.wasRunning = false; // exactly one automatic refresh at the end
      await refresh({ auto: true });
      if (cur === c) syncPoll();
      return;
    }
    if (running) c.wasRunning = true;
    const a = api();
    if (c.loading || c.polling || !a || typeof a.getSessionFlowStatus !== 'function') { syncPoll(); return; }
    c.polling = true;
    let status = 'unknown';
    try { status = await a.getSessionFlowStatus(c.sessionId); } catch { status = 'unknown'; }
    if (cur !== c) return;
    c.polling = false;
    if (statusMeansNewSteps(status)) showHint(true);
    syncPoll();
  }

  // ----- open / close -----

  function wireOnce() {
    if (wired) return;
    const sc = $('flow-scroller');
    const evBtn = $('timeline-tab-events');
    const flowBtn = $('timeline-tab-flow');
    const refreshBtn = $('flow-refresh-btn');
    if (!sc || !evBtn || !flowBtn || !refreshBtn) return;
    wired = true;
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('click', onClick);
    sc.addEventListener('keydown', onKey);
    evBtn.addEventListener('click', () => setTab('events'));
    flowBtn.addEventListener('click', () => { if (!flowBtn.disabled) setTab('flow'); });
    const tabKeys = (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const target = ev.key === 'ArrowRight' ? 'flow' : 'events';
      setTab(target);
      const btn = target === 'flow' ? flowBtn : evBtn;
      if (!btn.disabled) btn.focus();
    };
    evBtn.addEventListener('keydown', tabKeys);
    flowBtn.addEventListener('keydown', tabKeys);
    refreshBtn.addEventListener('click', () => { if (cur) refresh(); });
    const exportSel = $('flow-export-select');
    if (exportSel) exportSel.addEventListener('change', () => {
      const format = exportSel.value;
      exportSel.value = '';
      if (format) exportFlow(format);
    });
    const banner = $('flow-banner');
    if (banner) banner.addEventListener('click', (ev) => {
      if (!cur || !cur.entry || !ev.target.closest || !ev.target.closest('.flow-banner-toggle')) return;
      cur.entry.bannerOpen = !cur.entry.bannerOpen;
      renderBanner();
    });
  }

  function teardownSession() {
    if (!cur) return;
    const c = cur;
    stopTimer();
    if (c.entry) c.entry.scrollTop = c.scrollTop;
    const btn = $('flow-refresh-btn');
    if (btn) btn.disabled = false; // a read superseded by this switch would never re-enable it
    setStatusText('');
    if (c.raf) cancelAnimationFrame(c.raf);
    if (c.loading) {
      const a = api();
      if (a && typeof a.cancelSessionFlow === 'function') { try { Promise.resolve(a.cancelSessionFlow(c.sessionId)).catch(() => {}); } catch { /* best effort */ } }
    }
    c.gen++;
    cur = null;
  }

  /** The viewer closed: stop everything and drop every held snapshot. */
  function closeAll() {
    teardownSession();
    if (ro) { ro.disconnect(); ro = null; }
    if (mo) { mo.disconnect(); mo = null; }
    if (visHandler) { document.removeEventListener('visibilitychange', visHandler); visHandler = null; }
    cache.clear();
    const slice = $('flow-slice');
    if (slice) slice.replaceChildren();
    const banner = $('flow-banner');
    if (banner) banner.replaceChildren();
  }

  /** Called by showTimelineViewer once the Events list is drawn. Opens on the last used tab. */
  function attach(session) {
    if (!session || !session.sessionId) return;
    wireOnce();
    const viewer = $('timeline-viewer');
    if (!viewer || !$('flow-view')) return;
    if (cur && cur.sessionId !== session.sessionId) teardownSession();
    if (cur) cur.session = session;   // the row the export reads the badge's backend from
    if (!cur) {
      const id = session.sessionId;
      cur = {
        sessionId: id, session, tab: 'events', avail: availability(session), declined: false, declineReason: '',
        entry: cache.get(id) || null, gen: 0, loading: false, polling: false, timer: 0, raf: 0,
        wasRunning: false, hint: false, scrollTop: 0, viewportH: FALLBACK_VIEWPORT_H, rendered: null,
      };
      if (cur.entry) { touch(id, cur.entry); cur.scrollTop = cur.entry.scrollTop || 0; }
      // The previous session's rows, rails and offset must not show while this one is read.
      const slice = $('flow-slice');
      const rails = $('flow-rails');
      const sc = $('flow-scroller');
      if (slice) slice.replaceChildren();
      if (rails) rails.replaceChildren();
      if (sc) sc.scrollTop = cur.scrollTop;
      const sp = $('flow-spacer');
      if (sp) sp.style.height = '0px';
    }
    const view = $('flow-view');
    view.style.setProperty('--flow-row-h', ROW_H + 'px');
    if (!mo && typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(() => {
        if (viewer.style.display === 'none') closeAll(); else syncPoll(); // a pane tab sent behind another only pauses the poll
      });
      mo.observe(viewer, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    if (!ro && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const sc = $('flow-scroller');
        if (!cur || !sc || cur.tab !== 'flow') return;
        const h = sc.clientHeight;
        if (h && h !== cur.viewportH) { cur.viewportH = h; markDirty(); render(); }
      });
      ro.observe($('flow-scroller'));
    }
    if (!visHandler) {
      visHandler = () => syncPoll();
      document.addEventListener('visibilitychange', visHandler);
    }
    showHint(false);
    showMessage(cur.avail.ok ? '' : cur.avail.reason);
    renderBanner();
    setTab(lastTab === 'flow' && cur.avail.ok ? 'flow' : 'events');
  }

  /** The sidebar's running-state poll calls this: a session that was dormant at attach and starts now re-arms the poll. */
  function notifyRunningChanged() { if (cur && cur.tab === 'flow') syncPoll(); }

  /** Numbers for the click test (B1-B7): rows held, DOM nodes under the Flow view, timers, last layout time. */
  function debugStats() {
    const view = typeof document !== 'undefined' ? $('flow-view') : null;
    return {
      open: !!cur,
      tab: cur ? cur.tab : null,
      steps: cur && cur.entry && cur.entry.snapshot ? cur.entry.snapshot.steps.length : 0,
      rows: cur && cur.entry && cur.entry.lay ? cur.entry.lay.rows.length : 0,
      cols: cur && cur.entry && cur.entry.lay ? cur.entry.lay.stats.cols : 0,
      connectorsTruncated,
      nodes: view ? view.getElementsByTagName('*').length : 0,
      cached: cache.size,
      timerArmed: !!(cur && cur.timer),
      observers: { resize: !!ro, mutation: !!mo, visibility: !!visHandler },
      lastLayoutMs,
    };
  }

  return Object.freeze({
    ROW_H, OVERSCAN, POLL_MS, CACHE_MAX,
    computeSlice, buildStepRowMap, resolveSelection, captureAnchor, resolveRowForStep, restoreAnchor,
    laneTagInfo, shouldPoll, statusMeansNewSteps, isCancelledAnswer, bannerItems, bannerSummary, checkpointInfo, rowText,
    attach, refresh, notifyRunningChanged, debugStats,
  });
});
