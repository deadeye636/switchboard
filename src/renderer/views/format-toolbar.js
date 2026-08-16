/**
 * format-toolbar.js — the viewer's formatting bar (#281).
 *
 * Renders whatever command table it is handed (format-commands.js) and hands
 * clicks back through onCommand — it owns no text logic of its own, so a command's
 * behaviour stays testable without a DOM.
 *
 * Three placements, one bar:
 *   bar        a strip under the viewer's toolbar row, wrapping when it must
 *   overlay    the same strip floating over the editor, which scrolls beneath it
 *   selection  a popup beside the selection, character commands shown and block
 *              commands behind an overflow button
 *
 * The overflow list is flat on purpose: a nested menu inside a popup that is
 * itself anchored to a moving selection is two positioning problems stacked, and
 * "Heading 2" reads no worse than "Heading ▸ 2".
 *
 * Depends on: viewer-toolbar.js (button styling classes), format-commands.js.
 */

// The icon set. Small inline SVGs in the same 14×14 stroke style as
// viewer-toolbar.js, or a styled glyph where a letter reads better than a
// pictogram (B, I, S, U, A, H).
const FMT_SVG = (d, extra = '') => `<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" xmlns="http://www.w3.org/2000/svg">${d}${extra}</svg>`;

const FMT_GLYPH = (text, cls) => `<span class="viewer-format-glyph ${cls || ''}">${text}</span>`;

const FORMAT_ICONS = {
  undo: FMT_SVG('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.3 2.5L3 13"/>'),
  redo: FMT_SVG('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6.3 2.5L21 13"/>'),
  bold: FMT_GLYPH('B', 'is-bold'),
  italic: FMT_GLYPH('I', 'is-italic'),
  strikethrough: FMT_GLYPH('S', 'is-strike'),
  underline: FMT_GLYPH('U', 'is-underline'),
  code: FMT_SVG('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  color: FMT_GLYPH('A'),
  highlight: FMT_SVG('<path d="m15 5 4 4"/><path d="M13 7 8.7 2.7a2 2 0 0 0-2.8 0L4.7 3.9a2 2 0 0 0 0 2.8L9 11"/><path d="M11 13 6.7 17.3a2 2 0 0 0 0 2.8l1.2 1.2a2 2 0 0 0 2.8 0L15 17"/>'),
  clear: FMT_SVG('<path d="M20 20H8.5L3.4 14.9a2 2 0 0 1 0-2.8l8-8a2 2 0 0 1 2.8 0l6 6a2 2 0 0 1 0 2.8L14 19"/>'),
  heading: FMT_GLYPH('H', 'is-bold'),
  'bullet-list': FMT_SVG('<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  'ordered-list': FMT_SVG('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/>', '<g stroke-width="1" font-family="monospace" font-size="8" text-anchor="middle"><text x="4" y="8">1</text><text x="4" y="15">2</text><text x="4" y="21">3</text></g>'),
  'task-list': FMT_SVG('<path d="m3 6 1.5 1.5L7 5"/><path d="m3 13 1.5 1.5L7 12"/><line x1="11" y1="6" x2="21" y2="6"/><line x1="11" y1="13" x2="21" y2="13"/><line x1="11" y1="20" x2="21" y2="20"/>'),
  blockquote: FMT_SVG('<path d="M4 5v14"/><line x1="9" y1="8" x2="20" y2="8"/><line x1="9" y1="13" x2="20" y2="13"/><line x1="9" y1="18" x2="16" y2="18"/>'),
  link: FMT_SVG('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/>'),
  table: FMT_SVG('<rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="20"/><line x1="15" y1="9" x2="15" y2="20"/>'),
  // One plain line: three would read as the alignment icon two buttons along.
  rule: FMT_SVG('<line x1="3" y1="12" x2="21" y2="12"/>'),
  align: FMT_SVG('<line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>'),
  more: FMT_SVG('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
};

const FORMAT_CARET = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" width="8" height="8" xmlns="http://www.w3.org/2000/svg"><path d="m6 9 6 6 6-6"/></svg>';

const FORMAT_PLACEMENTS = ['bar', 'overlay', 'selection'];

/**
 * Create the formatting bar.
 *
 * @param {Object} opts
 * @param {Function} opts.onCommand - (command, value) => void, value only for menus
 * @returns {Object}
 *   .el                    - the bar element
 *   .setCommands(list)     - render a command table; an empty list empties the bar
 *   .setPlacement(name)    - 'bar' | 'overlay' | 'selection'
 *   .setDisabled(bool)     - grey every control out (a file that cannot be written)
 *   .showAt(left, top)     - selection placement: reveal the popup at these
 *                            coordinates, relative to the bar's offset parent
 *   .hidePopup()           - selection placement: dismiss it
 *   .closeMenu()           - dismiss an open dropdown
 *   .destroy()             - drop the document-level listeners
 */
function createFormatBar(opts = {}) {
  const el = document.createElement('div');
  el.className = 'viewer-format-bar is-bar';

  const row = document.createElement('div');
  row.className = 'viewer-format-row';
  el.appendChild(row);

  let openMenu = null;
  let disabled = false;
  let placement = 'bar';
  let commands = [];
  const buttons = [];

  function closeMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
  }

  // Clicking anywhere else dismisses the dropdown. Registered once per bar and
  // dropped in destroy(), so a torn-down viewer leaves no listener behind.
  const onDocPointerDown = (e) => {
    if (openMenu && !openMenu.contains(e.target) && !el.contains(e.target)) closeMenu();
  };
  const onDocKeyDown = (e) => { if (e.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown);

  // Keep the editor's selection: a plain click would blur CodeMirror first, and
  // the command would then run against a selection the user can no longer see.
  const keepSelection = (node) => node.addEventListener('mousedown', (e) => e.preventDefault());

  function makeButton(command) {
    const btn = document.createElement('button');
    btn.className = 'fp-toolbar-btn fp-icon-btn viewer-format-btn';
    btn.dataset.command = command.id;
    btn.title = command.label;
    btn.innerHTML = (FORMAT_ICONS[command.id] || FMT_GLYPH(command.label[0]))
      + (command.kind === 'menu' ? `<span class="viewer-format-caret">${FORMAT_CARET}</span>` : '');

    if (command.swatch) {
      const swatch = document.createElement('span');
      swatch.className = 'viewer-format-swatch';
      swatch.style.background = command.options[0].value;
      btn.appendChild(swatch);
      btn._swatch = swatch;
    }

    keepSelection(btn);
    btn.addEventListener('click', () => {
      if (disabled) return;
      if (command.kind === 'menu') { toggleMenu(btn, command); return; }
      closeMenu();
      opts.onCommand?.(command);
    });

    buttons.push(btn);
    return btn;
  }

  // The overflow button of the selection popup. Its entries are flattened: a
  // command with its own menu contributes one line per option, so nothing here
  // opens a second level.
  function makeOverflowButton(blockCommands) {
    const entries = [];
    for (const command of blockCommands) {
      if (command.kind === 'menu') {
        for (const option of command.options) entries.push({ command, value: option.value, label: option.label });
      } else {
        entries.push({ command, value: undefined, label: command.label });
      }
    }

    const btn = document.createElement('button');
    btn.className = 'fp-toolbar-btn fp-icon-btn viewer-format-btn';
    btn.dataset.command = 'more';
    btn.title = 'More formatting';
    btn.innerHTML = FORMAT_ICONS.more;
    keepSelection(btn);
    btn.addEventListener('click', () => {
      if (disabled) return;
      const wasOpen = openMenu && openMenu._ownerId === 'more';
      closeMenu();
      if (wasOpen) return;
      openMenu = buildMenu('more', entries.map((entry) => ({
        label: entry.label,
        onPick: () => opts.onCommand?.(entry.command, entry.value),
      })));
      positionMenu(btn);
    });
    buttons.push(btn);
    return btn;
  }

  function buildMenu(ownerId, items, { swatches = false } = {}) {
    const menu = document.createElement('div');
    menu.className = 'viewer-format-menu';
    menu._ownerId = ownerId;
    if (swatches) menu.classList.add('is-swatches');

    for (const item of items) {
      const node = document.createElement('button');
      node.className = swatches ? 'viewer-format-swatch-item' : 'fp-toolbar-btn viewer-format-menu-item';
      node.title = item.label;
      if (swatches) {
        node.style.background = item.color;
        node.setAttribute('aria-label', item.label);
      } else {
        node.textContent = item.label;
      }
      keepSelection(node);
      node.addEventListener('click', () => {
        closeMenu();
        item.onPick();
      });
      menu.appendChild(node);
    }

    el.appendChild(menu);
    return menu;
  }

  // Positioned against the bar, not the document, so it travels with a panel
  // that lives inside a pane (#310) rather than at a fixed viewport offset.
  function positionMenu(btn) {
    if (!openMenu) return;
    openMenu.style.left = `${btn.offsetLeft}px`;
    openMenu.style.top = `${btn.offsetTop + btn.offsetHeight + 2}px`;
  }

  function toggleMenu(btn, command) {
    const wasOpen = openMenu && openMenu._ownerId === command.id;
    closeMenu();
    if (wasOpen) return;

    openMenu = buildMenu(command.id, command.options.map((option) => ({
      label: option.label,
      color: option.value,
      onPick: () => {
        if (btn._swatch) btn._swatch.style.background = option.value;
        opts.onCommand?.(command, option.value);
      },
    })), { swatches: !!command.swatch });
    positionMenu(btn);
  }

  function render() {
    closeMenu();
    buttons.length = 0;
    row.replaceChildren();

    if (!commands.length) {
      el.classList.remove('has-commands');
      return;
    }

    // In the popup the character commands are shown and the block ones move
    // behind the overflow button; everywhere else the whole table is one
    // wrapping row, so a wide window shows a single line and a narrow one
    // breaks by itself.
    const shown = placement === 'selection' ? commands.filter((c) => c.row === 1) : commands;
    const overflow = placement === 'selection' ? commands.filter((c) => c.row !== 1) : [];

    let lastGroup = null;
    for (const command of shown) {
      if (lastGroup && lastGroup !== command.group) {
        const sep = document.createElement('span');
        sep.className = 'viewer-format-sep';
        row.appendChild(sep);
      }
      lastGroup = command.group;
      row.appendChild(makeButton(command));
    }

    if (overflow.length) {
      const sep = document.createElement('span');
      sep.className = 'viewer-format-sep';
      row.appendChild(sep);
      row.appendChild(makeOverflowButton(overflow));
    }

    el.classList.add('has-commands');
    if (typeof syncTitleToAriaLabel === 'function') syncTitleToAriaLabel(el);
    for (const btn of buttons) btn.disabled = disabled;
  }

  return {
    el,

    setCommands(list) {
      commands = Array.isArray(list) ? list : [];
      render();
    },

    setPlacement(name) {
      const next = FORMAT_PLACEMENTS.includes(name) ? name : 'bar';
      if (next === placement) return;
      placement = next;
      for (const p of FORMAT_PLACEMENTS) el.classList.toggle(`is-${p}`, p === next);
      el.classList.remove('is-open');
      // `bar` is in the flow but still position:relative — a left over from the
      // popup would shift the whole strip.
      el.style.top = '';
      el.style.left = '';
      render();
    },

    get placement() { return placement; },

    // The overlay is positioned against the panel, whose top edge is the toolbar
    // row — so the caller has to say how tall that row currently is, or the tile
    // covers the title and the mode control instead of the text.
    setOverlayTop(px) {
      if (placement === 'overlay') el.style.top = `${px}px`;
    },

    showAt(left, top) {
      if (placement !== 'selection' || !el.classList.contains('has-commands')) return;
      el.style.left = `${Math.max(0, left)}px`;
      el.style.top = `${Math.max(0, top)}px`;
      el.classList.add('is-open');
    },

    hidePopup() {
      closeMenu();
      el.classList.remove('is-open');
    },

    setDisabled(value) {
      disabled = !!value;
      closeMenu();
      el.classList.toggle('is-disabled', disabled);
      for (const btn of buttons) btn.disabled = disabled;
    },

    closeMenu,

    destroy() {
      closeMenu();
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeyDown);
    },
  };
}

window.createFormatBar = createFormatBar;
