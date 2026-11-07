// plugins-kit.js — the list-to-detail interaction every view of the Plugins manager uses (#803 T6, spec 40).
//
// One module so the five views (Plugins, Apps, MCPs, Skills, Marketplace) cannot drift apart. Owner decisions
// D1, D2 and D7: an overview is a compact list — one line per item, grouped into labelled sections inside one
// rounded container with thin separators — under a page head (title, subtitle, header actions) and a filter
// box with a count. A row says its name and one short meta text, may carry an enable switch, and opens its
// own detail page (the row's name button or its settings icon); everything verbose lives on that page, which
// replaces the list and has a Back control. Back restores the list, the filter text and focus on the row.
//
// Keyboard: Up/Down move between rows, Home/End jump, Enter opens (a real <button>), Escape or Backspace go
// back from a detail page — never while focus is in a text field or an editor, which own those keys. A view
// holding unsaved work answers `canLeave()` and can refuse (an answer only — `onLeave()` releases the page once it
// really goes); a refresh never redraws an open detail page or moves focus. A row may be disabled with a reason; the reason is its meta text and its title.
//
// A view may also hand a `rowGroups(row)` hook (with a `filterKey`): the kit then draws a row of toggle chips, one
// per group (a CLI), with counts, ANDed with the text filter and kept per view across a re-mount (#824, below).
// `chipSets` draws several such rows, ANDed with each other (the Instructions page: CLI and kind, spec 44).
//
// A view may also hand an async `rowMatch(query) -> Promise<Set|Array of row keys>` (#823 T4): the rows whose CONTENT
// holds the text, decided by the view (in main; the window never gets file text). A row then passes the filter when its
// name matches OR its key is in the answer. The kit calls it only for a non-empty filter of two or more characters,
// 200 ms after the last keystroke, and draws an answer only if it is still the latest and for the text now typed.
//
// Every string goes in with textContent (catalog and registry text is external input). Each row is a
// `.settings-field`, so the settings search sees it. The kit knows no view, no backend and no IPC: a view hands
// it rows and three callbacks. Loaded in settings.html, before the views that use it; UMD so jsdom tests can
// require it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.pluginsKit = factory();
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // The settings icon on a row. Inline, because the icon module is not loaded in settings.html; parsed once per
  // document and cloned per row (renderer rule: an icon is markup, and markup is parsed).
  const GEAR = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>';
  const gearTemplates = new WeakMap();
  function gearIcon(doc) {
    let tpl = gearTemplates.get(doc);
    if (!tpl) {
      tpl = doc.createElement('template');
      tpl.innerHTML = GEAR;
      gearTemplates.set(doc, tpl);
    }
    return tpl.content.firstChild.cloneNode(true);
  }

  function el(doc, tag, cls, text) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function isTextField(node) {
    if (!node) return false;
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'textarea' || node.isContentEditable) return true;
    // An editor (CodeMirror) keeps its own keys: Escape closes its search or completion there.
    if (typeof node.closest === 'function' && node.closest('.cm-editor')) return true;
    if (tag !== 'input') return false;
    const type = (node.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit'].includes(type);
  }

  function defaultMatch(row, query, view) {
    const hay = [view.rowLabel(row), view.rowMeta ? view.rowMeta(row) : ''].join(' ').toLowerCase();
    return hay.includes(query);
  }

  // The chip choice per view (#824), outside any mount: a view that re-mounts (the settings screen rebuilds its
  // views after Apply, a category can be drawn again) keeps what the user picked while the window is open. Keyed
  // by the spec's `filterKey` (fallback: its title); a Set of group keys. Not persisted beyond the window.
  const chipSelections = new Map();

  // How long the filter text rests before the view's `rowMatch` is asked (#823 T4), and the shortest text it is asked for.
  const CONTENT_DEBOUNCE_MS = 200;
  const CONTENT_MIN_QUERY = 2;

  /**
   * Mount one view into `host` (its previous content is replaced).
   *
   * view = {
   *   title, subtitle, filterPlaceholder, emptyText,
   *   actions: [{ label, onClick, danger? }],                 // header buttons
   *   sections: [{ title, rows: [...] }],                     // or `rows` for one untitled section
   *   rowKey(row), rowLabel(row), rowMeta(row)?,               // the one line
   *   rowSwitch(row)? -> { checked, disabled?, label, onChange(checked) } | null
   *   rowDisabled(row)? -> reason string | null,
   *   match(row, query)?,                                     // filter; default: label + meta
   *   rowMatch(query)? -> Promise<Set|Array>,                 // keys of the rows whose content holds `query` (#823 T4)
   *   rowGroups(row)? -> [{ key, label }],                    // chips (#824): the groups a row belongs to, e.g. its CLI
   *   chipSets?: [{ id, label, rowGroups(row) }],             // several chip rows instead (spec 44): e.g. CLI, then kind
   *   filterKey?,                                             // names the view in the chip store (default: title)
   *   renderDetail(row, container, back),                     // fills the detail page
   * }
   *
   * Group chips (#824), only when the view has `rowGroups`: one chip per distinct key over all rows, labelled
   * with the first label seen and counted over all rows (not narrowed by the text). Several chips may be on; none
   * on means every row; the chips AND with the text filter, and a row matches when ANY of its groups is on. A row
   * whose `rowGroups` is empty applies to every group: it passes whatever is on and is counted under no chip. The
   * chip row exists only while there are two or more groups. The choice lives in a store keyed by `filterKey`, so
   * a re-mount restores it; a chip whose group is gone is ignored (kept in the store, not applied). `clearFilter`
   * clears the text only. The settings search, which looks over every row, calls `suspendGroups(true)` instead:
   * the chips narrow nothing while it runs, and the stored choice applies again on `suspendGroups(false)`. The kit never interprets a key or a label.
   * `chipSets` draws one such row per set, in its order, each with its own label (the row's aria-label) and its own
   * stored choice; `rowGroups` alone is the one-set case. The sets AND with each other: a row must pass every set that
   * has a chip on. The first set keeps the view's old store key, a later one is stored under `filterKey:id`.
   * Returns { refresh(nextView), showList(), openDetail(key), root }.
   */
  function mountView(host, view) {
    const doc = host.ownerDocument;
    let current = view;
    let detailKey = null;
    let filterText = '';
    let lastFocusKey = null;
    // The settings-wide search looks over every row, so while it runs the chips narrow nothing (#824).
    let groupsSuspended = false;
    // The answer of `rowMatch` for the text it was asked about: { query, keys: Set } or null. A token makes a stale
    // answer draw nothing; the timer is the debounce.
    let contentHit = null;
    let contentToken = 0;
    let contentTimer = null;
    // The first set keeps the store key a view had before there were several sets, so a choice made then still applies.
    const selKey = (set) => String(current.filterKey || current.title || '') + (set.store ? `:${set.store}` : '');
    const selection = (set) => {
      const k = selKey(set);
      if (!chipSelections.has(k)) chipSelections.set(k, new Set());
      return chipSelections.get(k);
    };

    const rootEl = el(doc, 'div', 'plugins-view');
    host.replaceChildren(rootEl);

    const listPage = el(doc, 'div', 'plugins-list-page');
    const detailPage = el(doc, 'div', 'plugins-detail-page');
    detailPage.hidden = true;
    rootEl.append(listPage, detailPage);

    const head = el(doc, 'div', 'plugins-head');
    const headText = el(doc, 'div', 'plugins-head-text');
    const titleEl = el(doc, 'div', 'plugins-title');
    const subtitleEl = el(doc, 'div', 'plugins-subtitle settings-description');
    headText.append(titleEl, subtitleEl);
    const actionsEl = el(doc, 'div', 'plugins-head-actions');
    head.append(headText, actionsEl);

    const filterRow = el(doc, 'div', 'plugins-filter-row');
    const filter = el(doc, 'input', 'settings-input plugins-filter');
    filter.type = 'search';
    const countEl = el(doc, 'span', 'plugins-count settings-description');
    countEl.setAttribute('aria-live', 'polite');
    filterRow.append(filter, countEl);

    // One chip row per chip set, made on first use and kept in the order the view names its sets.
    const chipBox = el(doc, 'div', 'plugins-chip-sets');
    const chipRows = new Map();
    function chipRowFor(set) {
      let row = chipRows.get(set.id);
      if (!row) {
        row = el(doc, 'div', 'sv-mcp-chips plugins-chip-row');
        row.setAttribute('role', 'group');
        row.dataset.chipSet = set.id;
        row.hidden = true;
        chipRows.set(set.id, row);
      }
      row.setAttribute('aria-label', set.label || 'Filter by group');
      return row;
    }

    const body = el(doc, 'div', 'plugins-sections');
    listPage.append(head, filterRow, chipBox, body);

    function sectionsOf(v) {
      if (Array.isArray(v.sections)) return v.sections;
      return [{ title: '', rows: Array.isArray(v.rows) ? v.rows : [] }];
    }

    function allRows() {
      return sectionsOf(current).flatMap(s => s.rows || []);
    }

    function rowButtons() {
      return [...body.querySelectorAll('.plugins-row-open')];
    }

    function drawHead() {
      titleEl.textContent = current.title || '';
      subtitleEl.textContent = current.subtitle || '';
      subtitleEl.hidden = !current.subtitle;
      actionsEl.replaceChildren();
      for (const a of current.actions || []) {
        const b = el(doc, 'button', 'settings-action-btn' + (a.danger ? ' danger' : ''), a.label);
        b.type = 'button';
        b.addEventListener('click', () => a.onClick && a.onClick());
        actionsEl.appendChild(b);
      }
      // A view inside a category that already has a heading passes no title and no actions: no empty head.
      head.hidden = !current.title && !current.subtitle && !(current.actions || []).length;
      filter.placeholder = current.filterPlaceholder || 'Filter';
      filter.setAttribute('aria-label', current.filterPlaceholder || 'Filter');
    }

    // The view's chip sets: `chipSets`, or `rowGroups` alone as the one set it was before (#824).
    function chipSets() {
      // By declared position, before anything is skipped: only the set declared first takes the old store key. An id
      // used twice is made unique, so two sets never share a row or a stored choice.
      if (Array.isArray(current.chipSets)) {
        const seen = new Set();
        const out = [];
        current.chipSets.forEach((s, i) => {
          if (!s || typeof s.rowGroups !== 'function') return;
          let id = String(s.id || i);
          if (seen.has(id)) id = `${id}-${i}`;
          seen.add(id);
          out.push({ id, store: i === 0 ? '' : id, label: s.label || '', rowGroups: s.rowGroups });
        });
        return out;
      }
      return typeof current.rowGroups === 'function' ? [{ id: '', store: '', label: '', rowGroups: current.rowGroups }] : [];
    }

    function groupsOf(set, row) {
      const g = set.rowGroups(row);
      return Array.isArray(g) ? g.filter(x => x && x.key != null) : [];
    }

    // The distinct groups of one set over every row, in first-seen order, with their counts. Fewer than two: no chips.
    function groupList(set) {
      const seen = new Map();
      for (const row of allRows()) {
        const own = new Set();
        for (const g of groupsOf(set, row)) {
          const key = String(g.key);
          if (own.has(key)) continue;
          own.add(key);
          const at = seen.get(key);
          if (at) at.count += 1;
          else seen.set(key, { key, label: String(g.label != null ? g.label : g.key), count: 1 });
        }
      }
      return [...seen.values()];
    }

    function drawChips(set, groups) {
      const chipRow = chipRowFor(set);
      chipRow.replaceChildren();
      chipRow.hidden = groups.length < 2;
      if (chipRow.hidden) return chipRow;
      const sel = selection(set);
      for (const g of groups) {
        const on = sel.has(g.key);
        const chip = el(doc, 'button', 'settings-action-btn sv-mcp-chip' + (on ? ' active' : ''), `${g.label} ${g.count}`);
        chip.type = 'button';
        chip.dataset.group = g.key;
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        chip.addEventListener('click', () => {
          if (sel.has(g.key)) sel.delete(g.key); else sel.add(g.key);
          drawList();
          // The chips are redrawn with the list: the keyboard user stays on the chip just toggled.
          const again = [...chipRow.querySelectorAll('.sv-mcp-chip')].find(c => c.dataset.group === g.key);
          if (again) again.focus();
        });
        chipRow.appendChild(chip);
      }
      return chipRow;
    }

    function drawRow(row) {
      const key = String(current.rowKey(row));
      const reason = current.rowDisabled ? current.rowDisabled(row) : null;
      const item = el(doc, 'div', 'settings-field plugins-row' + (reason ? ' plugins-row-disabled' : ''));
      item.setAttribute('role', 'listitem');
      item.dataset.key = key;

      const open = el(doc, 'button', 'plugins-row-open');
      open.type = 'button';
      open.dataset.key = key;
      const name = el(doc, 'span', 'plugins-row-name settings-label', current.rowLabel(row));
      const metaText = reason || (current.rowMeta ? current.rowMeta(row) : '');
      const meta = el(doc, 'span', 'plugins-row-meta settings-description', metaText || '');
      if (!metaText) meta.hidden = true;
      open.append(name, meta);
      if (reason) open.title = reason;
      open.addEventListener('click', () => openDetail(key));
      item.appendChild(open);

      const sw = current.rowSwitch ? current.rowSwitch(row) : null;
      if (sw) {
        const label = el(doc, 'label', 'settings-toggle plugins-row-switch');
        const input = el(doc, 'input');
        input.type = 'checkbox';
        input.checked = !!sw.checked;
        input.disabled = !!sw.disabled || !!reason;
        input.setAttribute('aria-label', sw.label || ('Enable ' + current.rowLabel(row)));
        input.addEventListener('change', () => sw.onChange && sw.onChange(input.checked));
        label.append(input, el(doc, 'span', 'settings-toggle-slider'));
        item.appendChild(label);
      }

      const gear = el(doc, 'button', 'plugins-row-gear');
      gear.type = 'button';
      gear.tabIndex = -1;   // the row's name button is the one tab stop; the icon is the same action
      gear.setAttribute('aria-label', 'Details for ' + current.rowLabel(row));
      gear.appendChild(gearIcon(doc));
      gear.addEventListener('click', () => openDetail(key));
      item.appendChild(gear);
      return item;
    }

    function cancelContent() {
      contentToken += 1;
      if (contentTimer) { clearTimeout(contentTimer); contentTimer = null; }
    }
    function dropContent() {
      cancelContent();
      contentHit = null;
    }

    // Ask the view which rows hold the text, once the typing rests. Never for an empty or one-character filter. The
    // previous answer stays applied while the next is on its way (no flicker); it goes on clear or below two characters.
    function scheduleContent() {
      cancelContent();
      const query = filterText.trim().toLowerCase();
      if (typeof current.rowMatch !== 'function' || query.length < CONTENT_MIN_QUERY) { contentHit = null; return; }
      const token = contentToken;
      contentTimer = setTimeout(async () => {
        contentTimer = null;
        let keys = null;
        try { keys = await current.rowMatch(query); } catch { keys = null; }
        if (token !== contentToken || !rootEl.isConnected) return;
        contentHit = { query, keys: new Set(keys ? [...keys].map(String) : []) };
        if (!detailKey) drawList();
      }, CONTENT_DEBOUNCE_MS);
    }

    function drawList() {
      const query = filterText.trim().toLowerCase();
      const byName = current.match || defaultMatch;
      const byContent = contentHit && query ? contentHit.keys : null;
      const match = (r, q, v) => byName(r, q, v) || !!(byContent && byContent.has(String(current.rowKey(r))));
      body.replaceChildren();
      // Per set, only keys that are still a chip count; with fewer than two groups a set has no chip row and no filter.
      const sets = chipSets().map((set) => {
        const groups = groupList(set);
        const active = new Set(groupsSuspended || groups.length < 2 ? [] : groups.filter(g => selection(set).has(g.key)).map(g => g.key));
        return { set, groups, active };
      });
      const narrowing = sets.filter(s => s.active.size);
      // Every set with a choice must agree (AND); within a set, any of its chips will do (OR).
      const inGroup = (r) => narrowing.every(({ set, active }) => {
        const g = groupsOf(set, r);
        return !g.length || g.some(x => active.has(String(x.key)));
      });
      let total = 0;
      let shown = 0;
      for (const section of sectionsOf(current)) {
        const rows = section.rows || [];
        total += rows.length;
        const visible = (query || narrowing.length)
          ? rows.filter(r => inGroup(r) && (!query || match(r, query, current)))
          : rows;
        shown += visible.length;
        if (!visible.length) continue;
        const block = el(doc, 'div', 'plugins-section');
        if (section.title) block.appendChild(el(doc, 'div', 'plugins-section-title settings-section-title', section.title));
        const list = el(doc, 'div', 'plugins-rows');
        list.setAttribute('role', 'list');
        if (section.title) list.setAttribute('aria-label', section.title);
        for (const row of visible) list.appendChild(drawRow(row));
        block.appendChild(list);
        body.appendChild(block);
      }
      const narrowed = !!query || narrowing.length > 0;
      countEl.textContent = narrowed ? `${shown} of ${total}` : String(total);
      chipBox.replaceChildren(...sets.map(({ set, groups }) => drawChips(set, groups)));
      if (!shown) {
        body.appendChild(el(doc, 'div', 'plugins-empty settings-description',
          narrowed ? 'Nothing matches the filter.' : (current.emptyText || 'Nothing here yet.')));
      }
    }

    function focusRow(key) {
      const target = rowButtons().find(b => b.dataset.key === key) || rowButtons()[0];
      if (target) target.focus();
    }

    // Leaving a detail page asks the view first (`canLeave`), so a page holding unsaved work is not
    // dismissed by a stray Back, Escape or Backspace (renderer rule: work must not be dismissible by accident).
    // `focus: false` for a caller that is not the user coming back (the settings search, a Cancel): focus stays
    // where the user has it rather than jumping to the row.
    function leaveDetail(opts) {
      if (detailKey && current.canLeave && current.canLeave() === false) return false;
      showList(!(opts && opts.focus === false));
      return true;
    }

    function showList(returnFocus) {
      // The view releases what its page held (an editor) only now that the page really goes; its `canLeave` is
      // asked without a move and must not release anything.
      if (detailKey && current.onLeave) current.onLeave();
      detailKey = null;
      detailPage.hidden = true;
      detailPage.replaceChildren();
      listPage.hidden = false;
      filter.value = filterText;
      drawList();
      // Focus goes back to the row only when the user comes back from its page, never on a refresh.
      if (returnFocus && lastFocusKey) focusRow(lastFocusKey);
    }

    function openDetail(key) {
      const row = allRows().find(r => String(current.rowKey(r)) === String(key));
      if (!row) return;
      detailKey = String(key);
      lastFocusKey = detailKey;
      listPage.hidden = true;
      detailPage.hidden = false;
      detailPage.replaceChildren();
      const back = el(doc, 'button', 'settings-action-btn plugins-back', 'Back');
      back.type = 'button';
      back.addEventListener('click', () => leaveDetail());
      const title = el(doc, 'div', 'plugins-title', current.rowLabel(row));
      const container = el(doc, 'div', 'plugins-detail');
      detailPage.append(back, title, container);
      if (current.renderDetail) current.renderDetail(row, container, () => leaveDetail());
      back.focus();
    }

    filter.addEventListener('input', () => { filterText = filter.value; scheduleContent(); drawList(); });

    body.addEventListener('keydown', (e) => {
      const buttons = rowButtons();
      const at = buttons.indexOf(doc.activeElement);
      if (at === -1) return;
      let next = -1;
      if (e.key === 'ArrowDown') next = Math.min(buttons.length - 1, at + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = buttons.length - 1;
      if (next === -1) return;
      e.preventDefault();
      buttons[next].focus();
    });

    detailPage.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || isTextField(e.target)) return;
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        leaveDetail();
      }
    });

    drawHead();
    drawList();

    const handle = {
      root: rootEl,
      // Whether the view may go back to its list, without moving it: false while a detail page refuses. A caller
      // that moves several views asks each of them first, so a refusal leaves every view where it was. A view's
      // own `canLeave` therefore only answers; what it releases on the way out belongs in `onLeave`.
      canLeave: () => !detailKey || !current.canLeave || current.canLeave() !== false,
      // Back to the list from a detail page; on the list already, nothing moves. -> false while the page refuses.
      showList: (opts) => (detailKey ? leaveDetail(opts) : true),
      // The settings search is on (or over): the chips stop narrowing the list while it runs; the stored choice stays.
      suspendGroups(on) {
        if (groupsSuspended === !!on) return;
        groupsSuspended = !!on;
        if (!detailKey) drawList();
      },
      // Drop the view's own filter text (the settings search runs over every row, not the filtered few).
      clearFilter() {
        if (!filterText) return;
        filterText = '';
        filter.value = '';
        dropContent();
        if (!detailKey) drawList();
      },
      openDetail,
      // A view's data changed. On the list: redraw it, keeping the filter and where focus is. On an open detail
      // page whose row is still there: nothing is redrawn — the page may hold the user's work, and the view
      // updates its own detail if it needs to; the list picks the new data up on Back. A detail page whose row
      // is gone returns to the list.
      refresh(nextView) {
        current = nextView || current;
        drawHead();
        // The rows may have changed (a new item, a deleted one): what the content answer said is asked again.
        if (contentHit || contentTimer) scheduleContent();
        if (detailKey) {
          if (allRows().some(r => String(current.rowKey(r)) === detailKey)) return;
          // The row is gone. A page holding unsaved work stays, and its view says what happened.
          if (current.canLeave && current.canLeave() === false) return;
          showList(false);
          return;
        }
        // Where focus was inside the list — which row, and its name button or its switch — survives the
        // redraw, so a keyboard user who toggles a switch that refreshes the view keeps their place.
        const active = doc.activeElement;
        let keep = null;
        if (active && body.contains(active)) {
          const item = active.closest('.plugins-row');
          if (item) keep = { key: item.dataset.key, onSwitch: !!active.closest('.plugins-row-switch') };
        }
        drawList();
        if (keep) {
          const item = [...body.querySelectorAll('.plugins-row')].find(r => r.dataset.key === keep.key);
          const target = item && (keep.onSwitch ? item.querySelector('.plugins-row-switch input') : item.querySelector('.plugins-row-open'));
          if (target) target.focus();
        }
      },
    };
    // The handle rides on the view's own root, so whoever holds the page — the settings screen asking every view
    // before a search or a Cancel — finds each mounted view without a list of its own to keep in step.
    rootEl.pluginsKitView = handle;
    return handle;
  }

  /** Every mounted view's handle under `root`, in document order. */
  function viewsIn(root) {
    return [...root.querySelectorAll('.plugins-view')].map(n => n.pluginsKitView).filter(Boolean);
  }

  return { mountView, viewsIn };
}));
