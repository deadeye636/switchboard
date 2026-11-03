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
   *   renderDetail(row, container, back),                     // fills the detail page
   * }
   * Returns { refresh(nextView), showList(), openDetail(key), root }.
   */
  function mountView(host, view) {
    const doc = host.ownerDocument;
    let current = view;
    let detailKey = null;
    let filterText = '';
    let lastFocusKey = null;

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

    const body = el(doc, 'div', 'plugins-sections');
    listPage.append(head, filterRow, body);

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

    function drawList() {
      const query = filterText.trim().toLowerCase();
      const match = current.match || defaultMatch;
      body.replaceChildren();
      let total = 0;
      let shown = 0;
      for (const section of sectionsOf(current)) {
        const rows = section.rows || [];
        total += rows.length;
        const visible = query ? rows.filter(r => match(r, query, current)) : rows;
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
      countEl.textContent = query ? `${shown} of ${total}` : String(total);
      if (!shown) {
        body.appendChild(el(doc, 'div', 'plugins-empty settings-description',
          query ? 'Nothing matches the filter.' : (current.emptyText || 'Nothing here yet.')));
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

    filter.addEventListener('input', () => { filterText = filter.value; drawList(); });

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
      // Drop the view's own filter text (the settings search runs over every row, not the filtered few).
      clearFilter() {
        if (!filterText) return;
        filterText = '';
        filter.value = '';
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
