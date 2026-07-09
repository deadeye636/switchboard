// --- Terminal management ---
// Key bindings, write buffering, xterm instance lifecycle, drag-and-drop.
//
// Depends on globals: openSessions, activeSessionId, TERMINAL_THEME, terminalsEl,
// gridViewActive, gridCards, gridViewerCount, placeholder, terminalHeader,
// sessionMap, activePtyIds (app.js)
// Depends on: toggleGridView, isSessionNavKey, handleSessionNavKey, focusGridCard,
// wrapInGridCard, showGridView (grid-view.js)
// Depends on: shellEscape (utils.js)

// --- Terminal key bindings ---
// Shift+Enter → kitty protocol (CSI 13;2u) so Claude Code treats it as newline, not submit.
// Two layers needed:
//   1. attachCustomKeyEventHandler returning false — blocks xterm's key pipeline (onKey/onData)
//   2. preventDefault on capture-phase keydown — prevents browser inserting \n into textarea
const isMac = window.api.platform === 'darwin';
function setupTerminalKeyBindings(terminal, container, getSessionId, { onFind } = {}) {
  // Set when the Insert-variable shortcut (default Ctrl/Cmd+Shift+V) fires, so the
  // paste event that same keystroke also generates is swallowed once (#89).
  let suppressPasteOnce = false;
  terminal.attachCustomKeyEventHandler((e) => {
    // Note: Ctrl/Cmd +/-/0 are deliberately NOT handled here — they fall through
    // to Electron's whole-UI zoom. Terminal-only font zoom is via Ctrl+wheel
    // (below) and the Settings font-size field.

    // Cmd/Ctrl+F → open terminal search bar
    if (e.key === 'f' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (e.type === 'keydown' && onFind) onFind();
      return false;
    }

    // Toggle grid view (default Cmd/Ctrl+Shift+G)
    if (matchShortcut('gridToggle', e, isMac, appShortcuts)) {
      if (e.type === 'keydown') { e._handled = true; toggleGridView(); }
      return false;
    }

    // Bookmark shortcut (default Cmd/Ctrl+Shift+B). The live terminal has no
    // transcript message index, so here it opens the bookmark list; message-level
    // bookmarking happens in the transcript viewer.
    if (matchShortcut('toggleBookmark', e, isMac, appShortcuts)) {
      if (e.type === 'keydown') { e._handled = true; window.bookmarksTags?.handleBookmarkShortcut(); }
      return false;
    }

    // Create a task from the terminal selection (default Cmd/Ctrl+Shift+T).
    if (matchShortcut('createTask', e, isMac, appShortcuts)) {
      if (e.type === 'keydown') {
        e._handled = true;
        const sel = terminal.hasSelection() ? terminal.getSelection() : '';
        window.tasksView?.createFromSource({ sessionId: getSessionId(), quote: sel || undefined });
      }
      return false;
    }

    // Insert a saved variable at the cursor (default Cmd/Ctrl+Shift+V) — a picker
    // that works in every right-click mode (#89). Ctrl/Cmd+Shift+V also fires a
    // native paste; suppress that one paste so it doesn't dump the clipboard too.
    if (matchShortcut('insertVariable', e, isMac, appShortcuts)) {
      if (e.type === 'keydown') {
        e._handled = true;
        suppressPasteOnce = true;
        setTimeout(() => { suppressPasteOnce = false; }, 0); // clear if no paste follows
        if (typeof openTerminalVariablePicker === 'function') openTerminalVariablePicker(terminal, getSessionId());
      }
      return false;
    }

    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    if (isSessionNavKey(e)) {
      if (e.type === 'keydown') { e._handled = true; handleSessionNavKey(e); }
      return false;
    }

    // Shift+Enter → newline (kitty protocol CSI 13;2u) so Claude Code treats it as newline, not submit.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // Ctrl+Enter → newline on Windows/Linux (matches PowerShell convention).
    // Send the same Shift+Enter kitty sequence that Claude Code recognizes as newline.
    if (!isMac && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // On Windows/Linux, xterm maps Ctrl+V to a control character (0x16). Block
    // that so no stray ^V reaches the PTY. The actual paste is handled once by
    // the capture-phase 'paste' listener below — pasting here too would double
    // it, because the browser still fires a native paste event on Ctrl+V.
    if (!isMac && e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      return false;
    }

    // On Windows/Linux, Ctrl+C with a selection should copy instead of sending SIGINT.
    // When nothing is selected, Ctrl+C falls through to xterm (sends SIGINT as normal).
    if (!isMac && e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (terminal.hasSelection()) {
        if (e.type === 'keydown') {
          window.api.writeClipboard(terminal.getSelection());
        }
        return false;
      }
    }

    // Space → send directly on keydown (including key-repeat) to ensure reliable
    // delivery to the PTY. xterm.js's evaluateKeyboardEvent does not handle plain
    // Space in keydown (keyCode 32 < 48 threshold) and instead relies on the
    // deprecated 'keypress' event, which Electron/Chromium may not fire reliably
    // for key-repeat events. This fixes Claude Code's "Hold Space to record"
    // push-to-talk voice feature, which depends on rapid key-repeat characters
    // arriving at stdin to detect a held key.
    if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (e.type === 'keydown') {
        e.preventDefault();
        window.api.sendInput(getSessionId(), ' ');
      }
      return false;
    }

    return true;
  });

  const textarea = container.querySelector('.xterm-helper-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.shiftKey || (!isMac && e.ctrlKey)) && !e.altKey && !e.metaKey) {
        e.preventDefault();
      }
    }, { capture: true });
  }

  // Single paste path. Intercept the native paste event on the container (capture
  // phase, so it runs before xterm's own textarea paste handler) and route it
  // through pasteIntoTerminal exactly once. Without this, Ctrl+V (and OS
  // right-click paste) would paste twice — once from xterm, once from us — and
  // xterm's terminal.paste() also normalizes \n to \r, merging pasted lines on
  // resize. Handling it here keeps the bracketed multiline packet intact.
  container.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Swallow the paste that the Insert-variable shortcut (Ctrl/Cmd+Shift+V) emits.
    if (suppressPasteOnce) { suppressPasteOnce = false; return; }
    const cd = e.clipboardData;
    if (!cd) return;
    const text = cd.getData('text');
    const files = cd.files;
    const hasImageItem = Array.from(cd.items || [])
      .some(it => it.kind === 'file' && it.type && it.type.startsWith('image/'));

    const send = (s) => { if (s) pasteIntoTerminal(terminal, getSessionId(), s); };
    const filePaths = () => (files && files.length)
      ? Array.from(files).map(f => shellEscape(window.api.getPathForFile(f))).filter(Boolean).join(' ')
      : '';

    if (hasImageItem) {
      // A screenshot/bitmap → snapshot to a temp PNG and insert its path (Claude
      // Code shows it as [Image #N]). A copied image FILE has no bitmap, so the
      // save returns null and we fall back to its real path below.
      window.api.saveClipboardImage()
        .then((imgPath) => {
          if (imgPath) return send(shellEscape(imgPath) + ' ');
          const p = filePaths();
          send(p ? p + ' ' : text);
        })
        .catch(() => { const p = filePaths(); send(p ? p + ' ' : text); });
      return;
    }

    // Copied files (pdf/txt/exe/…) → insert absolute path(s), like drag-and-drop.
    const p = filePaths();
    if (p) { send(p + ' '); return; }

    // Plain text — bracketed multiline handled by pasteIntoTerminal.
    send(text);
  }, { capture: true });

  // Ctrl/Cmd + mouse wheel → terminal-only font zoom (VS Code / Windows Terminal
  // convention). Capture phase + passive:false so we intercept before xterm's
  // own viewport wheel handler (which would otherwise consume the event) and so
  // preventDefault can suppress both Chromium's page zoom and xterm's scroll.
  // Without the modifier we do nothing → the wheel scrolls as usual.
  container.addEventListener('wheel', (e) => {
    if (!(isMac ? e.metaKey : e.ctrlKey) || e.deltaY === 0) return;
    e.preventDefault();
    e.stopPropagation();
    window._nudgeTerminalFontSize?.(e.deltaY < 0 ? 1 : -1);
  }, { capture: true, passive: false });
}

// Check whether a terminal is scrolled to the bottom using xterm's buffer API.
function isAtBottom(terminal) {
  const buf = terminal.buffer.active;
  return buf.viewportY >= buf.baseY;
}

// Pure helper: clamp a FitAddon-proposed row count to what the container's
// content-box height can actually display.
//
// Problem: xterm's FitAddon.proposeDimensions() reads
//   getComputedStyle(container).height  ← the .terminal-container border-box
// and subtracts only the .xterm element's OWN padding (0 in Switchboard).
// Under the global `* { box-sizing: border-box }` rule, the computed height
// already includes the container's 8 px top + 8 px bottom padding, so those
// 16 px are counted as drawable area. Result: 1–2 extra rows are proposed and
// the bottom portion is clipped by overflow:hidden (measured: 16 px / ~1.14
// rows in both single and grid views).
//
// clampRowsToContentBox / bottomRowClipped are pure geometry helpers defined in
// terminal-fit.js (loaded before this script) and exposed as globals there, so
// node --test can exercise the math without a DOM.

// Cheap self-heal check: is the rendered grid overshooting its container's content
// box (bottom row clipped by overflow:hidden)? Reads the post-paint cell height from
// the render service — returns false while unmeasured so a fresh terminal never
// raises a false alarm. Callers re-fit when this is true (#59).
// Vertical padding that reduces the container's drawable height: the container's
// own padding (0 by default — see style.css) PLUS the .xterm element's padding,
// which is where the visual inset now lives (FitAddon subtracts exactly that).
function terminalVerticalPadding(el) {
  const cs = getComputedStyle(el);
  let pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const xt = el.querySelector('.xterm');
  if (xt) {
    const xs = getComputedStyle(xt);
    pad += (parseFloat(xs.paddingTop) || 0) + (parseFloat(xs.paddingBottom) || 0);
  }
  return pad;
}

function isBottomRowClipped(entry) {
  const el = entry && entry.element;
  if (!el || !entry.terminal) return false;
  const rsCellH = entry.terminal._core?._renderService?.dimensions?.css?.cell?.height || 0;
  if (rsCellH <= 0) return false;
  return bottomRowClipped(entry.terminal.rows, rsCellH, el.clientHeight, terminalVerticalPadding(el));
}

// Fit terminal to container, clamping rows to the container's true content-box
// height to avoid bottom-row clipping (see clampRowsToContentBox above).
function safeFit(entry) {
  const el = entry.element; // .terminal-container
  const dims = entry.fitAddon.proposeDimensions();
  // Was this fit clamped against a real, measured cell height? A brand-new
  // terminal hasn't painted yet, so cellH is 0 and the clamp is a no-op — the
  // proposed row count can overshoot by 1-2 rows.
  let measured = true;
  if (dims && dims.rows > 1) {
    const padV = terminalVerticalPadding(el);
    // The render-service metric is the accurate, post-paint cell height (the same
    // source FitAddon uses). The DOM fallback can return a PROVISIONAL row height
    // right after open() — before font metrics settle — which under-measures the
    // cell, inflates maxRows, and defeats the clamp. So use the fallback only for
    // the math, and treat the fit as "measured" ONLY when the render-service value
    // is present. Otherwise a fresh terminal caches an overshoot that survives
    // until an unrelated resize (a tab switch) re-fits it correctly.
    const rsCellH = entry.terminal._core?._renderService?.dimensions?.css?.cell?.height || 0;
    const cellH = rsCellH ||
      el.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height ||
      0;
    measured = rsCellH > 0;
    const clampedRows = clampRowsToContentBox(dims.rows, el.clientHeight, padV, cellH);
    entry.terminal.resize(dims.cols, clampedRows);
  } else {
    // proposeDimensions() returns undefined while the render service has no
    // cell metrics yet (fresh terminal, esp. during WebGL init) — fit() is a
    // no-op then too. Mark the fit unmeasured so the retry loop below runs;
    // caching this state would freeze a brand-new session at the 80x24
    // default (torn TUI layout) until a manual window resize.
    entry.fitAddon.fit();
    measured = false;
  }
  if (el && measured) {
    // Cache the container size this fit was computed for, so showSession can skip
    // a redundant resize (and its reflow) when the box hasn't changed on a tab
    // switch. Only cache a MEASURED fit.
    entry._fitW = el.clientWidth;
    entry._fitH = el.clientHeight;
    entry._refitTries = 0;
  } else if (!measured) {
    // The cell wasn't measured yet (fresh terminal, pre-paint): the row count may
    // overshoot and clip the last row below the viewport. Re-fit on the next frame
    // once painted. Keep retrying until the render service reports a real cell
    // height, but bounded to a ~30-frame (~500 ms) settle budget so a never-painted
    // terminal (hidden grid card) can't spin forever; a real show later re-fits it
    // anyway. The old 5-frame cap gave up too early on a busy main thread / large
    // scrollback, leaving a cached overshoot that only an unrelated resize healed (#59).
    entry._refitTries = (entry._refitTries || 0) + 1;
    if (entry._refitTries <= 30) {
      requestAnimationFrame(() => {
        if (openSessions.has(entry.session.sessionId)) safeFit(entry);
      });
    }
  }
}

// --- Late-settle refit guard (#59 follow-up: bottom row clipped after startup restore) ---
// A fit computed against transient metrics (window/layout still settling after
// auto-restore, statusbar appearing, DPI change) stays cached and clips the
// bottom row until an unrelated resize. Two gaps in the existing self-heal:
//   1. showSession's isBottomRowClipped check runs only on a switch — a box that
//      settles AFTER the last showSession is never re-checked. → Observe every
//      container's real box changes and refit (trailing debounce, no-op guarded).
//   2. Font metrics can settle after the first fit (font fallback resolves)
//      without any box change, so the observer can't see it. → One safeFit per
//      terminal once document.fonts.ready resolves (see createTerminalEntry).
const observedEntries = new WeakMap(); // container element → entry
const containerResizeObserver = (typeof ResizeObserver !== 'undefined')
  ? new ResizeObserver((entries) => {
      for (const en of entries) {
        const entry = observedEntries.get(en.target);
        if (entry) scheduleObservedRefit(entry);
      }
    })
  : null;

function scheduleObservedRefit(entry) {
  clearTimeout(entry._roTimer);
  // 100 ms trailing debounce: swallows the per-frame storm of an interactive
  // window drag (the resize handler covers live fitting) and fires once after
  // the box settles.
  entry._roTimer = setTimeout(() => {
    entry._roTimer = 0;
    if (!openSessions.has(entry.session.sessionId)) return;
    const el = entry.element;
    if (el.clientWidth === 0 || el.clientHeight === 0) return; // hidden — a real show refits anyway
    // No-op guard: box already matches the cached fit and nothing is clipped.
    if (Math.abs(el.clientWidth - (entry._fitW || 0)) < 1 &&
        Math.abs(el.clientHeight - (entry._fitH || 0)) < 1 &&
        !isBottomRowClipped(entry)) return;
    fitAndScroll(entry);
  }, 100);
}

// --- devicePixelRatio-change re-fit (#85) ---
// xterm's DOM renderer derives the device cell width from charWidth × devicePixelRatio
// (unfloored — xterm.js#6015, which upstream won't fix). On a DPR change (monitor switch,
// display-scaling change, Electron zoom, dock/undock) the cached cell geometry goes stale
// and text drifts ~1px/cell, accumulating across each row into scattered/garbled glyphs,
// until an unrelated resize re-measures. No container-box or font event fires for a pure
// DPR change, so none of the existing self-heals (ResizeObserver, fonts.ready, window
// resize) catch it — we had no DPR trigger at all. Watch DPR and re-fit every open
// terminal when it flips. matchMedia's resolution query is DPR-specific, so re-arm after
// each change.
function refitAllForDprChange() {
  for (const [, entry] of openSessions) {
    const t = entry && entry.terminal;
    if (!t) continue;
    const beforeCols = t.cols, beforeRows = t.rows;
    safeFit(entry);
    // safeFit no-ops when the CSS-px grid is unchanged (a pure DPR change with the same
    // box keeps cols/rows), so xterm's resize() early-returns and the device geometry is
    // never recomputed. Force it with a one-row resize dance so the DOM renderer re-derives
    // the cell width for the new devicePixelRatio.
    if (t.cols === beforeCols && t.rows === beforeRows && t.rows > 1) {
      try {
        t.resize(t.cols, t.rows - 1);
        t.resize(beforeCols, beforeRows);
      } catch { /* ignore */ }
    }
  }
}

function watchDevicePixelRatio() {
  if (typeof window.matchMedia !== 'function') return;
  const arm = () => {
    let mq;
    try {
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    } catch {
      return; // resolution media query unsupported — nothing to watch
    }
    const onChange = () => {
      mq.removeEventListener('change', onChange);
      refitAllForDprChange();
      arm(); // re-arm for the new devicePixelRatio
    };
    mq.addEventListener('change', onChange);
  };
  arm();
}
watchDevicePixelRatio();

// Fit a terminal that just became visible (from display:none or reparent).
// Flush the WebGL glyph atlas and force a full-row redraw. xterm's WebGL renderer
// caches a glyph texture atlas; on a hidden->visible transition WITHOUT a dimension
// change (tab switch, grid<->single) nothing triggers a repaint, so the stale atlas
// renders misaligned ("staircase") until the next incidental write. No-op / harmless
// on the DOM-renderer fallback.
function forceRepaint(entry) {
  if (!entry.webglAddon) return; // WebGL-atlas fix only; the DOM renderer repaints correctly on its own
  try {
    entry.webglAddon.clearTextureAtlas();
    entry.terminal.refresh(0, entry.terminal.rows - 1);
  } catch { /* ignore */ }
}

// --- WebGL ghost-line heal (#85) ---
// xterm's WebGL renderer occasionally leaves a stale duplicate of the prompt line
// on screen: the TUI rewrites the input row in place, but only parser-marked-dirty
// rows get repainted and the ghost row isn't flagged, so the old glyphs linger. A
// full-viewport refresh(0, rows-1) forces every row to repaint from the buffer —
// which holds the line only once — so the ghost clears. A manual resize heals it
// today for the same reason. Foreground session only (the ghost is user-visible
// there); throttled on the hot write path, plus an idle atlas flush for the case
// where output stops with the ghost still on screen. WebGL-only: the DOM renderer
// repaints correctly on its own (same rationale as forceRepaint).
const GHOST_REFRESH_THROTTLE_MS = 120;
const GHOST_IDLE_HEAL_MS = 180;

function scheduleGhostHeal(entry) {
  if (!entry.webglAddon) return; // DOM renderer needs no heal
  const term = entry.terminal;
  const doRefresh = () => {
    entry._ghostRefreshAt = performance.now();
    try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
  };
  // Option 1: throttled full-viewport refresh during active streaming.
  const now = performance.now();
  if (!entry._ghostRefreshAt || now - entry._ghostRefreshAt >= GHOST_REFRESH_THROTTLE_MS) {
    doRefresh();
  } else if (!entry._ghostRefreshPending) {
    // Coalesce a trailing refresh so the last frame of a burst isn't skipped.
    entry._ghostRefreshPending = true;
    setTimeout(() => { entry._ghostRefreshPending = false; doRefresh(); }, GHOST_REFRESH_THROTTLE_MS);
  }
  // Option 2: idle safety net — output stopped with a ghost still on screen. A
  // heavier atlas flush + refresh, debounced so it fires once after the stream settles.
  clearTimeout(entry._ghostIdleTimer);
  entry._ghostIdleTimer = setTimeout(() => {
    entry._ghostIdleTimer = 0;
    if (activeSessionId !== entry.session.sessionId) return;
    forceRepaint(entry);
  }, GHOST_IDLE_HEAL_MS);
}

// Defers to requestAnimationFrame so the container has dimensions.
function fitAndScroll(entry) {
  const wasAtBottom = isAtBottom(entry.terminal);
  requestAnimationFrame(() => {
    safeFit(entry);
    forceRepaint(entry);
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    }
  });
}

// --- Terminal font (size + family), terminal-only ---
// Live-adjustable; both new and existing terminals share these. Changing either
// alters the glyph cell size, so every change re-fits (recomputes cols/rows and
// resizes the PTY). This is xterm font config, NOT Electron zoomFactor — the
// latter would scale the whole UI (sidebar included), not just the terminal.
const DEFAULT_TERMINAL_FONT_FAMILY = "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace";
const DEFAULT_TERMINAL_FONT_SIZE = 12;
const TERMINAL_FONT_SIZE_MIN = 8;
const TERMINAL_FONT_SIZE_MAX = 28;
let terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE;
let terminalFontFamily = DEFAULT_TERMINAL_FONT_FAMILY;

function clampTerminalFontSize(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(TERMINAL_FONT_SIZE_MIN, Math.min(TERMINAL_FONT_SIZE_MAX, v));
}

function applyTerminalFontToAll() {
  for (const [, entry] of openSessions) {
    entry.terminal.options.fontSize = terminalFontSize;
    entry.terminal.options.fontFamily = terminalFontFamily;
    safeFit(entry);
  }
}

window._setTerminalFontSize = (n) => {
  terminalFontSize = clampTerminalFontSize(n);
  applyTerminalFontToAll();
  // Notify UI (statusbar zoom button #34) — covers every path: Ctrl+wheel, shortcuts,
  // settings, nudge — since they all funnel through here.
  try { window.dispatchEvent(new CustomEvent('terminal-font-changed', { detail: terminalFontSize })); } catch {}
  return terminalFontSize;
};

// Current terminal font size (for the statusbar zoom button initial render).
window._getTerminalFontSize = () => terminalFontSize;

window._setTerminalFontFamily = (family) => {
  terminalFontFamily = (typeof family === 'string' && family.trim()) ? family.trim() : DEFAULT_TERMINAL_FONT_FAMILY;
  applyTerminalFontToAll();
  return terminalFontFamily;
};

// Tabs mode "live render background tabs" setting (default on). When on, terminal
// output is written to xterm even while a tab is in the background instead of being
// buffered and replayed on show — the replay write + scroll snap was the source of
// the flicker when returning to a tab that produced output. Off = legacy buffering.
let tabsLiveRenderEnabled = true;
window._setTabsLiveRender = (v) => { tabsLiveRenderEnabled = v !== false; };

// Persist the zoomed size back into the global blob so it survives a restart.
// Merge-read so we never clobber other global keys.
async function persistTerminalFontSize(v) {
  try {
    const g = (await window.api.getSetting('global')) || {};
    g.terminalFontSize = v;
    await window.api.setSetting('global', g);
  } catch { /* best-effort */ }
}

// Ctrl/Cmd +/-/0 zoom (terminal-only). delta 0 ⇒ reset to default.
window._nudgeTerminalFontSize = (delta) => {
  const next = delta === 0 ? DEFAULT_TERMINAL_FONT_SIZE : terminalFontSize + delta;
  const v = window._setTerminalFontSize(next);
  persistTerminalFontSize(v);
  return v;
};

// --- Terminal write buffering ---
// Batch incoming terminal data to coalesce IPC chunks into fewer write() calls.
const terminalWriteBuffers = new Map(); // sessionId → { chunks, rafId, timerId }

// ~30 fps flush cap — halves paint/compositor work vs. 60 fps during streaming.
// Measured (JBR #64): compositor burns 40-60% of a core at 60 fps; a 33 ms
// minimum interval doubles parse-batch size and is imperceptible for streaming
// text (worst-case added latency: one frame ~33 ms).
const MIN_FLUSH_INTERVAL_MS = 33; // ~30 fps
// Under load (many visible terminals streaming at once — grid thumbnails), drop
// to ~15 fps: imperceptible on cards, halves parse+paint again (#81).
const MIN_FLUSH_INTERVAL_BUSY_MS = 66;
const ADAPTIVE_FLUSH_THRESHOLD = 4; // >N visible sessions with pending output

// Current minimum flush interval for a visible session, scaled by how many
// visible sessions have output pending right now.
function visibleFlushInterval() {
  let busy = 0;
  for (const sid of terminalWriteBuffers.keys()) {
    if (isSessionVisible(sid) && ++busy > ADAPTIVE_FLUSH_THRESHOLD) return MIN_FLUSH_INTERVAL_BUSY_MS;
  }
  return MIN_FLUSH_INTERVAL_MS;
}

// Background sessions (non-visible) flush much less often — no point parsing VT
// at 30 fps when the terminal is hidden (display:none or in a non-visible grid card).
// ~0.5 fps reduces parse CPU for idle background sessions without correctness risk.
const BACKGROUND_FLUSH_INTERVAL_MS = 2000;

const lastFlushAt = new Map(); // sessionId → performance.now() of last flush

// --- Terminal mouse-reporting toggle ---
// When false, strip the program's DEC private mouse-tracking mode set/reset
// sequences from the output stream so it never enables mouse reporting. Then a
// plain left-click+drag does local text selection again (the program loses mouse
// events — scroll/click in a TUI like Claude Code stop working). Default true
// (native behavior; select with Shift+drag while a program captures the mouse).
// Mouse mode (deadeye): 'native' (program gets mouse; select with Shift+drag),
// 'select' (mouse tracking stays ON so the wheel scrolls the TUI natively, but a
// left-button drag forces a LOCAL text selection — conhost/PowerShell feel; the
// program stops seeing left-clicks, links stay clickable), or 'off' (strip all
// mouse-tracking so a plain drag selects and the program gets no mouse events).
// Default 'select' (deadeye: PowerShell/conhost feel out of the box — left-drag
// selects, wheel still scrolls the TUI, links stay clickable).
let terminalMouseMode = 'select';
function normalizeMouseMode(mode) {
  if (mode === 'select' || mode === 'off') return mode;
  // Back-compat: legacy 'on' / true → native; anything else → native.
  return 'native';
}
// Mouse-tracking private modes only. Deliberately NOT 1004 (focus), 1049 (alt
// screen), 2004 (bracketed paste) or 25 (cursor) — those must pass through.
const MOUSE_TRACKING_MODES = new Set([1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
function stripMouseReporting(data) {
  if (data.indexOf('\x1b[?') === -1) return data;
  // Drop a private-mode set/reset only when ALL its params are mouse modes, so
  // combined sequences that also toggle a non-mouse mode are left intact.
  return data.replace(/\x1b\[\?([\d;]+)([hl])/g, (m, params) => {
    const nums = params.split(';').filter(Boolean).map(Number);
    return nums.length && nums.every(n => MOUSE_TRACKING_MODES.has(n)) ? '' : m;
  });
}
// 'select' mode: force a LOCAL selection on a left-button (button 0) drag by
// wrapping the internal SelectionService.shouldForceSelection. _core is internal
// xterm API — feature-detect everything and fall back silently (behaves like
// 'native') if the shape changes on upgrade. Re-check on the xterm-upgrade
// checklist. Wheel is untouched (separate CoreMouseService path) so it keeps
// flowing to the TUI natively — exactly like 'native'.
function applyTerminalSelectionOverride(terminal, enable) {
  try {
    const svc = terminal && terminal._core && terminal._core._selectionService;
    if (!svc || typeof svc.shouldForceSelection !== 'function') return;
    if (enable) {
      if (!svc.__deadeyeOrigForceSelection) {
        svc.__deadeyeOrigForceSelection = svc.shouldForceSelection.bind(svc);
      }
      const orig = svc.__deadeyeOrigForceSelection;
      svc.shouldForceSelection = (e) => (e && e.button === 0) || orig(e);
    } else if (svc.__deadeyeOrigForceSelection) {
      svc.shouldForceSelection = svc.__deadeyeOrigForceSelection;
    }
  } catch {
    // Reaches into xterm internals (_core._selectionService) — shape may change
    // across xterm versions; losing the override is acceptable, crashing is not.
  }
}
// Apply a mouse mode. 'off' strips tracking and resets open terminals so a
// program that already enabled tracking stops capturing immediately. 'select'
// keeps tracking but installs the local-selection override on every open
// terminal; 'native' removes it.
function setTerminalMouseReporting(mode) {
  terminalMouseMode = normalizeMouseMode(mode);
  if (terminalMouseMode === 'off') {
    const reset = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l';
    for (const [, entry] of openSessions) {
      try { entry.terminal.write(reset); } catch {}
    }
  }
  const forceSelect = terminalMouseMode === 'select';
  for (const [, entry] of openSessions) {
    applyTerminalSelectionOverride(entry.terminal, forceSelect);
  }
}

// --- Background write optimisation ---
// Stage A: non-visible sessions skip terminal.write() entirely. Raw PTY data is
// accumulated in rawReplayBuffers and drained in one batch on (re)visibility.
// This eliminates xterm's VT parse cost for hidden terminals — the dominant
// renderer CPU when many Claude sessions stream simultaneously.
//
// Safety notes:
// - OSC 0/9 (busy/attention badges) are parsed in main.js on raw PTY data before
//   the renderer, so skipping renderer writes does NOT break any badge or notification.
// - DEC-2026 synchronized output is handled natively by xterm; there is no app-level
//   sync buffering, so deferring background writes cannot desync rendering (#85).
// - OSC 52 (clipboard) sequences in skipped background data won't dispatch —
//   acceptable because clipboard writes only matter when the user is viewing a session.

// --- PTY flow control (#81) ---
// At extreme throughput (`cat` on a huge file) the PTY produces faster than
// xterm parses; unparsed data piles up in terminalWriteBuffers and xterm's own
// write queue, so latency and memory grow unbounded for VISIBLE sessions (the
// replay cap only guards hidden ones). Track bytes received but not yet parsed
// by xterm (write-callback acked); pause the PTY above the high-water mark and
// resume below the low one. No-ops gracefully when the main process doesn't
// expose pause/resume.
const FLOW_HIGH_WATER_BYTES = 1024 * 1024; // pause above ~1 MB in flight
const FLOW_LOW_WATER_BYTES = 256 * 1024;   // resume below ~256 KB
const flowState = new Map(); // sessionId -> { inFlight, paused }

function flowTrackReceived(sessionId, bytes) {
  let s = flowState.get(sessionId);
  if (!s) { s = { inFlight: 0, paused: false }; flowState.set(sessionId, s); }
  s.inFlight += bytes;
  if (!s.paused && s.inFlight > FLOW_HIGH_WATER_BYTES && typeof window.api.pauseSessionOutput === 'function') {
    s.paused = true;
    window.api.pauseSessionOutput(sessionId);
  }
}

function flowTrackParsed(sessionId, bytes) {
  const s = flowState.get(sessionId);
  if (!s) return;
  s.inFlight = Math.max(0, s.inFlight - bytes);
  if (s.paused && s.inFlight < FLOW_LOW_WATER_BYTES) {
    s.paused = false;
    if (typeof window.api.resumeSessionOutput === 'function') window.api.resumeSessionOutput(sessionId);
  }
}

// Per-session raw data accumulated while the terminal is not visible.
// Map<sessionId, string[]> — one entry per chunk coalesced from flushTerminalBuffer.
const rawReplayBuffers = new Map();

// Hard cap to avoid unbounded memory for long-background high-throughput sessions.
// Oldest chunks are dropped when total exceeds the cap (lossy, matching the
// existing scrollback LRU trade-off: the user accepted data loss on background eviction).
const RAW_REPLAY_BUFFER_CAP_BYTES = 2 * 1024 * 1024; // 2 MB

// Enforce the per-session cap: drop oldest chunks from the front until total ≤ cap.
function enforceReplayBufferCap(sessionId) {
  const arr = rawReplayBuffers.get(sessionId);
  if (!arr) return;
  let total = arr.reduce((s, c) => s + c.length, 0);
  while (total > RAW_REPLAY_BUFFER_CAP_BYTES && arr.length > 0) {
    const dropped = arr.shift();
    total -= dropped.length;
  }
}

// True when the session's terminal container is visible to the user:
// - Single view: entry.element has the 'visible' CSS class.
// - Grid view: entry.element has BOTH 'visible' and 'grid-mode' classes, AND the
//   card is on screen — off-screen cards (tracked by grid-view's
//   IntersectionObserver in gridOffscreenSessions) skip writes too; their data
//   accumulates in the replay buffer and drains when scrolled back in (#81).
// Using the .visible class as the canonical visibility signal avoids gating on
// activeSessionId, which would incorrectly treat every grid card except the
// focused one as "background" and freeze them in mosaic mode.
function isSessionVisible(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry) return false;
  if (typeof gridOffscreenSessions !== 'undefined' && gridOffscreenSessions.has(sessionId)) return false;
  return entry.element.classList.contains('visible');
}

// Drain the raw replay buffer for sessionId by writing all accumulated data to the
// terminal in a single coalesced write(). Called on (re)visibility.
// The write callback always scrolls to bottom for replayed data — the user expects
// to land at the current output when switching to a session.
function drainReplayBuffer(sessionId) {
  const arr = rawReplayBuffers.get(sessionId);
  if (!arr || arr.length === 0) {
    rawReplayBuffers.delete(sessionId);
    return;
  }
  const entry = openSessions.get(sessionId);
  if (!entry) {
    rawReplayBuffers.delete(sessionId);
    return;
  }
  const data = arr.join('');
  rawReplayBuffers.delete(sessionId);
  entry.terminal.write(data, () => {
    // Destroyed between write() and callback → terminal is disposed, don't touch it.
    if (openSessions.get(sessionId) !== entry) return;
    entry.terminal.scrollToBottom();
    // Self-heal: a flush that painted the grid may reveal a cached row overshoot
    // (bottom row clipped). Re-fit if so — cheap measurement at an existing hook (#59).
    if (isBottomRowClipped(entry)) safeFit(entry);
  });
}

const TERMINAL_LOCAL_FILE_RE = /(^|[\s(["'])((?:~\/|\/|[A-Za-z]:[\\/])(?:[^\s"'<>`|)]+?\.(?:html?|mdx?|markdown|json|txt|log|csv|xml|svg|css|jsx?|tsx?|py|ya?ml)))/gi;

// external=true (Ctrl/Cmd+click, #69) → open in the configured external editor;
// otherwise open in the integrated file panel.
function openTerminalFilePath(sessionId, filePath, external = false) {
  if (!filePath) return;
  if (external) { window.api.openInEditor(filePath); return; }
  if (typeof openFileInPanel !== 'function') return;
  openFileInPanel(sessionId, filePath);
}

function openTerminalFileUri(sessionId, uri, external = false) {
  try {
    const url = new URL(uri);
    let filePath = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
    openTerminalFilePath(sessionId, filePath, external);
  } catch {
    // Ignore malformed terminal hyperlinks.
  }
}

function findTerminalLocalFileLinks(lineText, bufferLineNumber, sessionId) {
  const links = [];
  // Reuse the module-level regex (compiling per scanned line is wasteful); reset
  // the g-flag cursor so a previous scan can't skew this one.
  const regex = TERMINAL_LOCAL_FILE_RE;
  regex.lastIndex = 0;
  let match;

  while ((match = regex.exec(lineText)) !== null) {
    const filePath = match[2];
    const startIndex = match.index + match[1].length;
    const endIndex = startIndex + filePath.length;

    links.push({
      range: {
        start: { x: startIndex + 1, y: bufferLineNumber },
        end: { x: endIndex, y: bufferLineNumber },
      },
      text: filePath,
      activate: (event) => openTerminalFilePath(sessionId, filePath, !!(event && (event.ctrlKey || event.metaKey))),
    });
  }

  return links;
}

function registerLocalFileLinkProvider(terminal, sessionId) {
  terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const lineText = line.translateToString(true);
      const links = findTerminalLocalFileLinks(lineText, bufferLineNumber, sessionId);
      callback(links.length ? links : undefined);
    },
  });
}

function flushTerminalBuffer(sessionId) {
  const buf = terminalWriteBuffers.get(sessionId);
  if (!buf) return;
  clearTimeout(buf.timerId);
  cancelAnimationFrame(buf.rafId);
  terminalWriteBuffers.delete(sessionId);

  const entry = openSessions.get(sessionId);
  if (!entry) {
    // Session closed with a flush still queued — drop the bytes but ack them so
    // flow control can't hold the PTY paused (this flush can race ahead of the
    // flowState cleanup in destroySession).
    flowTrackParsed(sessionId, buf.chunks.reduce((s, c) => s + c.length, 0));
    return;
  }

  let data = buf.chunks.join('');
  const rawLen = data.length; // flow accounting uses the pre-strip length
  if (terminalMouseMode === 'off') data = stripMouseReporting(data);
  lastFlushAt.set(sessionId, performance.now());

  // Live-render mode (tabs, default on): write output to background tabs too, so
  // there's nothing to replay on show → no catch-up write/scroll flicker when
  // returning to a tab that produced output. Off (or grid): buffer + replay.
  const liveRender = tabsLiveRenderEnabled && document.body.classList.contains('display-mode-tabs');

  // Stage A: skip write() for non-visible sessions; accumulate raw data for replay.
  if (!liveRender && !isSessionVisible(sessionId)) {
    let arr = rawReplayBuffers.get(sessionId);
    if (!arr) { arr = []; rawReplayBuffers.set(sessionId, arr); }
    arr.push(data);
    enforceReplayBufferCap(sessionId);
    // Counts as handled for flow control — the replay cap bounds memory here,
    // and a hidden session must not keep its PTY paused (#81).
    flowTrackParsed(sessionId, rawLen);
    return;
  }

  const wasAtBottom = isAtBottom(entry.terminal);
  const savedViewportY = entry.terminal.buffer.active.viewportY;
  entry.terminal.write(data, () => {
    flowTrackParsed(sessionId, rawLen);
    // The session may have been destroyed between write() and this callback —
    // don't touch a disposed terminal.
    if (openSessions.get(sessionId) !== entry) return;
    if (wasAtBottom) {
      // Follow the output even for a live-rendered background tab (invisible now),
      // so switching to it later lands on the latest line without a scroll snap.
      entry.terminal.scrollToBottom();
    } else if (sessionId === activeSessionId) {
      // Restore scroll position so redraws don't yank the user away.
      entry.terminal.scrollLines(savedViewportY - entry.terminal.buffer.active.viewportY);
    }
    // Clear any WebGL ghost of the in-place-rewritten prompt line (#85). Foreground only.
    if (sessionId === activeSessionId) scheduleGhostHeal(entry);
  });
}

function scheduleFlush(sessionId, buf) {
  // If a timer or rAF is already pending, don't stack another.
  if (buf.timerId || buf.rafId) return;

  const last = lastFlushAt.get(sessionId);
  const elapsed = last === undefined ? Infinity : performance.now() - last;

  // Stage B: use a longer flush interval for non-visible sessions to reduce VT
  // parse frequency. Visible sessions get the adaptive 33/66 ms budget (#81).
  const effectiveMin = isSessionVisible(sessionId) ? visibleFlushInterval() : BACKGROUND_FLUSH_INTERVAL_MS;

  if (elapsed >= effectiveMin) {
    // Enough time has passed — flush on the next animation frame (current behavior).
    buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
  } else {
    // Too soon — schedule a timer for the remaining interval, then rAF from there.
    // Reuses buf.timerId so destroySession/flushTerminalBuffer teardown works unchanged.
    const remaining = effectiveMin - elapsed;
    buf.timerId = setTimeout(() => {
      buf.timerId = 0;
      buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
    }, remaining);
  }
}

// --- LRU cap on live terminals ---
// Every open session keeps a live xterm (+ WebGL context) until destroyed,
// so renderer memory scales with the number of sessions ever opened in this
// window (measured: 462 MB renderer RSS). The LRU destroys the
// least-recently-shown *closed* session beyond the cap. Sessions with a live
// PTY — and the active session — are never evicted, so the cap is soft when
// more than TERMINAL_LRU_CAP sessions are actually running. An evicted
// closed session behaves exactly like the existing re-click flow
// (openSession finds no entry and relaunches); it just loses its exit
// banner earlier.
const TERMINAL_LRU_CAP = 12;
const lruOrder = []; // sessionIds, most-recently-shown first

function lruTouch(sessionId) {
  if (!openSessions.has(sessionId)) return;
  const i = lruOrder.indexOf(sessionId);
  if (i !== -1) lruOrder.splice(i, 1);
  lruOrder.unshift(sessionId);
  while (lruOrder.length > TERMINAL_LRU_CAP) {
    if (!lruEvictOne()) break; // nothing evictable right now — soft cap
  }
}

// Destroy the least-recently-shown evictable session. Returns false when no
// entry can be evicted (all running, active, or still open).
function lruEvictOne() {
  for (let i = lruOrder.length - 1; i >= 0; i--) {
    const sid = lruOrder[i];
    const entry = openSessions.get(sid);
    if (!entry) { lruOrder.splice(i, 1); return true; } // stale id — drop it
    if (sid === activeSessionId || activePtyIds.has(sid) || !entry.closed) continue;
    destroySession(sid); // also removes sid from lruOrder
    return true;
  }
  return false;
}

// --- Terminal lifecycle helpers ---

// Scrollback budget per view mode. A 10k-row buffer costs ~3 MB per terminal;
// grid cards are thumbnails and only need enough rows for context. showSession
// and showGridView switch the live value when the view mode changes.
const SCROLLBACK_SINGLE = 10000; // focused single-view terminal
const SCROLLBACK_GRID = 1000;    // grid card (thumbnail)

// Create an xterm instance, wire up IPC, and register in openSessions.
// Returns the entry. Does NOT make it visible or fit it — call showSession() for that.
function createTerminalEntry(session, opts = {}) {
  const { sessionId } = session;
  const container = document.createElement('div');
  container.className = 'terminal-container';
  terminalsEl.appendChild(container);

  // URI of the link currently under the cursor (set by the link hover/leave
  // callbacks below), so the right-click context menu can offer link actions.
  let hoveredLinkUri = null;

  const terminal = new Terminal({
    fontSize: terminalFontSize,
    fontFamily: terminalFontFamily,
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: opts.scrollback ?? (gridViewActive ? SCROLLBACK_GRID : SCROLLBACK_SINGLE),
    // Must stay false for a PTY-backed terminal: the PTY/ConPTY already emits
    // \r\n. With convertEol=true xterm appends a CR to every bare \n, so a TUI
    // that moves the cursor down with a lone \n (e.g. Claude onto an empty input
    // line) also snaps to column 0. Real terminals don't (LNM reset by default).
    convertEol: false,
    allowProposedApi: true,
    // On Windows, tell xterm the PTY backend (node-pty defaults to ConPTY on
    // Win10 1809+) and the OS build so it tracks ConPTY's reflow/wrapping
    // correctly. Without this, multi-line TUI redraws desync — the cursor jumps
    // a line up (esp. after a shorter wrapped line) and stale cell fragments
    // linger at line starts.
    ...(window.api.platform === 'win32'
      ? { windowsPty: { backend: 'conpty', buildNumber: window.api.windowsBuildNumber || undefined } }
      : {}),
    linkHandler: {
      activate: (event, uri) => {
        // xterm fires link activate on any mouseup button (no guard); only act
        // on a left-click so a right-click goes to the context menu instead of
        // re-opening the link.
        if (event && typeof event.button === 'number' && event.button !== 0) return;
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          openTerminalFileUri(sessionId, uri, !!(event && (event.ctrlKey || event.metaKey)));
        } else {
          window.api.openExternal(uri);
        }
      },
      hover: (_event, uri) => { hoveredLinkUri = uri; },
      leave: () => { hoveredLinkUri = null; },
      allowNonHttpProtocols: true,
    },
  });

  // OSC 52 — let the program inside the terminal set the system clipboard (this is how
  // Claude Code copies). xterm doesn't wire this up itself, so we do. Payload is
  // "<selection>;<base64>" (or "<selection>;?" for a read-back query, which we ignore).
  // Route through the main process — see writeClipboard — because the renderer clipboard
  // is unreliable on Wayland.
  terminal.parser.registerOscHandler(52, (payload) => {
    const sep = payload.indexOf(';');
    const b64 = sep === -1 ? payload : payload.slice(sep + 1);
    if (!b64 || b64 === '?') return true;
    try {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      window.api.writeClipboard(new TextDecoder().decode(bytes));
    } catch {
      return false;
    }
    return true;
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((event, url) => {
    if (event && typeof event.button === 'number' && event.button !== 0) return;
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      openTerminalFileUri(sessionId, url, !!(event && (event.ctrlKey || event.metaKey)));
    } else {
      window.api.openExternal(url);
    }
  }, { hover: (_event, url) => { hoveredLinkUri = url; }, leave: () => { hoveredLinkUri = null; } }));
  registerLocalFileLinkProvider(terminal, sessionId);
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
  terminal.open(container);
  container.style.backgroundColor = TERMINAL_THEME.background;
  // Pick up the current mouse mode for this fresh terminal (SelectionService
  // exists only after open()). No-op unless mode is 'select'.
  applyTerminalSelectionOverride(terminal, terminalMouseMode === 'select');

  // WebGL is loaded after the entry is assembled via loadTerminalWebgl(entry)
  // so its lifecycle (suspend off-screen / restore on show) can own the addon.
  // --- Terminal search bar (Cmd/Ctrl+F) ---
  const searchBar = document.createElement('div');
  searchBar.className = 'terminal-search-bar';
  searchBar.style.display = 'none';
  searchBar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  container.appendChild(searchBar);
  syncTitleToAriaLabel(searchBar);
  const searchInput = searchBar.querySelector('.terminal-search-input');
  const searchCount = searchBar.querySelector('.terminal-search-count');
  const searchOpts = { decorations: { matchBackground: '#515C6A', activeMatchBackground: '#EAA549', matchOverviewRuler: '#515C6A', activeMatchColorOverviewRuler: '#EAA549' } };

  function openSearchBar() {
    searchBar.style.display = 'flex';
    searchInput.focus();
    const sel = terminal.getSelection();
    if (sel) { searchInput.value = sel; searchAddon.findNext(sel, searchOpts); }
  }
  function closeSearchBar() {
    searchBar.style.display = 'none';
    searchAddon.clearDecorations();
    searchInput.value = '';
    searchCount.textContent = '';
    terminal.focus();
  }
  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    if (q) { searchAddon.findNext(q, searchOpts); } else { searchAddon.clearDecorations(); searchCount.textContent = ''; }
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearchBar(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { searchAddon.findPrevious(searchInput.value, searchOpts); e.preventDefault(); }
    else if (e.key === 'Enter') { searchAddon.findNext(searchInput.value, searchOpts); e.preventDefault(); }
  });
  searchBar.querySelector('.terminal-search-next').addEventListener('click', () => searchAddon.findNext(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-prev').addEventListener('click', () => searchAddon.findPrevious(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-close').addEventListener('click', closeSearchBar);

  const entry = { terminal, element: container, fitAddon, searchAddon, openSearchBar, closeSearchBar, session, closed: false, webglAddon: null };
  openSessions.set(sessionId, entry);
  lruTouch(sessionId);
  loadTerminalWebgl(entry);

  // Late-settle guards (see containerResizeObserver above): refit on real box
  // changes, and once after fonts are ready (already-resolved promise → an
  // immediate microtask for terminals created later).
  if (containerResizeObserver) {
    observedEntries.set(container, entry);
    containerResizeObserver.observe(container);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (openSessions.get(entry.session.sessionId) !== entry) return; // destroyed/re-keyed
      if (container.clientWidth > 0 && container.clientHeight > 0) safeFit(entry);
    });
  }

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId, { onFind: openSearchBar });
  setupTerminalContextMenu(container, terminal, () => entry.session.sessionId, () => hoveredLinkUri);
  setupDragAndDrop(container, () => entry.session.sessionId);
  terminal.onResize(({ cols, rows }) => {
    // #27: only the focused session gets the post-resize settle-repaint (the ConPTY
    // full-frame nudge that fixes the cursor after reflow). Background/grid cards
    // don't need the cursor fix, and nudging them made every visible card flash on a
    // window resize. Focused = the active single session, or the focused grid card.
    const sid = entry.session.sessionId;
    const focused = (typeof gridViewActive !== 'undefined' && gridViewActive)
      ? (typeof gridFocusedSessionId !== 'undefined' && gridFocusedSessionId === sid)
      : (activeSessionId === sid);
    window.api.resizeTerminal(sid, cols, rows, focused);
  });
  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === entry.session.sessionId) updatePtyTitle();
  });
  terminal.onBell(() => {
    trackActivity(entry.session.sessionId, '\x07');
  });

  // Tabs mode: the container is laid out the moment it's appended (visibility:hidden,
  // not display:none), so fit it now — before its first paint — and cache the size.
  // Otherwise the first showSession would run the initial fit and reflow the grid
  // once, a one-time text jump on the first switch to the session.
  if (document.body.classList.contains('display-mode-tabs') &&
      container.clientWidth > 0 && container.clientHeight > 0) {
    // z-index stack: the container is laid out immediately (no display:none), so fit
    // it now — before its first show — to avoid a one-time reflow on first reveal.
    safeFit(entry);
  }

  return entry;
}

// --- WebGL renderer lifecycle ---
// GPU-accelerated rendering via WebGL drops renderer+compositor CPU ~50-70%,
// but each addon holds a GL context and Chromium caps ~16 of them per
// process — past the cap, contexts are lost and terminals silently degrade.
// The grid view suspends the addon on off-screen cards (IntersectionObserver
// in grid-view.js) and restores it when they scroll back in; showSession
// restores it for single view. Loading must happen after terminal.open()
// (needs attached DOM); failure falls back to xterm's DOM renderer.
// Renderer selection — ports VSCode's `gpuAcceleration` model (auto | on | off):
//  - 'on'   : always try WebGL (measured 50-70% renderer+compositor CPU drop).
//  - 'off'  : always the DOM renderer.
//  - 'auto' : try WebGL until a context loss or init failure on ANY terminal, then fall
//             back to DOM for every subsequent terminal (VSCode's static
//             `_suggestedRendererType`). Stops a flaky GPU/driver (#87) from making each
//             new terminal re-attempt and re-corrupt WebGL. The suggestion resets on a
//             config change so switching the setting retries WebGL.
// Silent texture-atlas corruption emits no event, so 'auto' cannot auto-catch that case
// (same limitation as VSCode) — the user picks 'off' for it. GL-context budget (~16 per
// process) is still managed by tabs binding GL to the active terminal and the grid
// suspending off-screen cards; the stale-atlas "staircase" is handled by forceRepaint().
let gpuAcceleration = 'auto';   // 'auto' | 'on' | 'off'
let suggestedRenderer;          // undefined until a WebGL failure suggests 'dom' (VSCode parity)

function shouldLoadWebgl() {
  return (gpuAcceleration === 'auto' && suggestedRenderer === undefined) || gpuAcceleration === 'on';
}

// One WebGL failure (context loss or init throw) disables WebGL for all future terminals
// in 'auto' mode until the setting changes (VSCode parity).
function suggestDomRenderer(reason) {
  if (suggestedRenderer === 'dom') return;
  suggestedRenderer = 'dom';
  console.warn('[terminal] WebGL fell back to the DOM renderer for new terminals:', reason);
}

// Live renderer switch (auto | on | off). A config change resets the fallback suggestion
// so 'auto'/'on' retries WebGL.
window._setGpuAcceleration = (mode) => {
  gpuAcceleration = (mode === 'on' || mode === 'off' || mode === 'auto') ? mode : 'auto';
  suggestedRenderer = undefined;
  for (const [sessionId, entry] of openSessions) {
    if (shouldLoadWebgl()) loadTerminalWebgl(entry);
    else suspendTerminalWebgl(sessionId);
  }
};
window._getGpuAcceleration = () => gpuAcceleration;
// Back-compat with the old boolean toggle: on → 'on', off → 'off'.
window._setTerminalWebgl = (on) => window._setGpuAcceleration(on ? 'on' : 'off');

function loadTerminalWebgl(entry) {
  if (!shouldLoadWebgl() || !entry.terminal) return; // DOM renderer
  // Dispose an existing addon before recreating to avoid leaking a GL context (VSCode parity).
  if (entry.webglAddon) {
    try { entry.webglAddon.dispose(); } catch { /* ignore */ }
    entry.webglAddon = null;
  }
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => {
      try { webglAddon.dispose(); } catch { /* ignore */ }
      if (entry.webglAddon === webglAddon) entry.webglAddon = null;
      suggestDomRenderer('context loss'); // future terminals go DOM in 'auto'
    });
    entry.terminal.loadAddon(webglAddon);
    entry.webglAddon = webglAddon;
    // WebGL cell dimensions differ from the DOM renderer (xterm.js#6015), so re-fit after
    // loading to avoid a grid reflow/drift on the new renderer — VSCode fires a dimension
    // refresh here for the same reason.
    safeFit(entry);
  } catch (e) {
    suggestDomRenderer((e && e.message) || 'init failure');
  }
}

function suspendTerminalWebgl(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry || !entry.webglAddon) return;
  try { entry.webglAddon.dispose(); } catch { /* dispose on a lost GL context can throw */ }
  entry.webglAddon = null; // xterm falls back to its DOM renderer
}

function restoreTerminalWebgl(sessionId) {
  const entry = openSessions.get(sessionId);
  if (entry) loadTerminalWebgl(entry);
}

// Push the terminal's CURRENT dimensions to the PTY. The PTY spawns at a fixed
// 120x30 while xterm fits asynchronously; a resize event fired before the spawn
// finished is dropped in main (no session entry yet), and once xterm already
// holds its final size no further onResize fires — so the PTY would keep the
// spawn default and the TUI stays rendered for 120 cols until a manual window
// resize. Called after every successful openTerminal (also makes the reattach
// firstResize redraw-nudge deterministic).
function syncPtySize(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry || !entry.terminal) return;
  window.api.resizeTerminal(entry.session.sessionId, entry.terminal.cols, entry.terminal.rows, false);
}

// Clean up a closed session entry (dispose terminal, remove DOM, remove from maps).
function destroySession(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  // Tear down any open right-click menu for this session before disposing the
  // terminal — its action closures hold the (about-to-be-disposed) xterm.
  if (typeof closeTerminalContextMenuForSession === 'function') closeTerminalContextMenuForSession(sessionId);
  if (typeof closeSelectionBarForSession === 'function') closeSelectionBarForSession(sessionId);
  window.api.closeTerminal(sessionId);
  // Drop any pending write buffer before disposing — a scheduled rAF/timeout
  // flush would otherwise call terminal.write() on a disposed instance if
  // terminal-data IPC raced with the teardown.
  const buf = terminalWriteBuffers.get(sessionId);
  if (buf) {
    cancelAnimationFrame(buf.rafId);
    clearTimeout(buf.timerId);
    terminalWriteBuffers.delete(sessionId);
  }
  lastFlushAt.delete(sessionId);
  flowState.delete(sessionId); // PTY is closed with the session — no resume needed
  clearTimeout(entry._roTimer);
  if (containerResizeObserver) containerResizeObserver.unobserve(entry.element);
  // Drop any accumulated replay data — the terminal is being torn down so
  // there is no point draining it on a future showSession.
  rawReplayBuffers.delete(sessionId);
  // terminal.dispose() also disposes the parser and its registered OSC
  // handlers (the OSC-52 clipboard hook) and all onX emitters — no manual
  // cleanup needed for those. The DnD/search-bar listeners live on
  // entry.element, which is removed below and garbage-collected once the
  // entry leaves openSessions/gridCards.
  entry.terminal.dispose();
  entry.element.remove();
  openSessions.delete(sessionId);
  const li = lruOrder.indexOf(sessionId);
  if (li !== -1) lruOrder.splice(li, 1);
  if (destroyGridCard(sessionId) && gridViewActive) {
    // Keep the grid header count honest when a card disappears outside the
    // showGridView/showSession flows (e.g. LRU eviction of a closed session).
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }
  if (typeof window.refreshSessionTabs === 'function') window.refreshSessionTabs();
}

// Make a session visible in the current view mode (grid or single).
// Handles sidebar highlight, notifications, header, fit, and focus.
function showSession(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);

  // Update sidebar active state
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  setActiveSession(sessionId);
  clearNotifications(sessionId);
  lruTouch(sessionId);

  if (gridViewActive) {
    // Ensure grid layout is set up (e.g. on first session after startup restore)
    if (!terminalsEl.classList.contains('grid-layout')) {
      showGridView();
    }
    if (entry && gridCards.has(sessionId)) {
      // Already in grid — just focus it
      focusGridCard(sessionId);
    } else if (entry) {
      // Session isn't in the grid yet (e.g. opened from the attention inbox while
      // the grid group filter hides it). Rebuild the grid so the card lands in
      // its correct region instead of being appended loose to #terminals — the
      // ad-hoc wrap ignored grouping/filters and mis-placed grouped sessions.
      // If the active group filter would hide it, reset the filter so the click
      // still reveals the session in its own region (never changes membership).
      if (typeof getGridAllowedSessionIds === 'function' && !getGridAllowedSessionIds().has(sessionId)) {
        gridGroupFilter = 'all';
        localStorage.setItem('gridGroupFilter', gridGroupFilter);
      }
      showGridView();
      requestAnimationFrame(() => focusGridCard(sessionId));
    }
  } else {
    // Single terminal view
    placeholder.style.display = 'none';
    hidePlanViewer();
    if (session) showTerminalHeader(session);
    if (entry) {
      // Restore the full scrollback budget for the focused terminal (the grid
      // may have trimmed it — see showGridView). Growing the limit is lossless.
      entry.terminal.options.scrollback = SCROLLBACK_SINGLE;
      const el = entry.element;

      if (document.body.classList.contains('display-mode-tabs')) {
        // Tabs mode: z-index stack. Every open terminal stays mounted AND painted
        // (see the CSS — no display:none / visibility:hidden); switching just moves
        // the target on top (z-index via .visible) and enables its input. Because the
        // target was already painted underneath, there is no hidden->visible repaint,
        // so no "staircase"/reflow flicker even when it gained lines while inactive.
        // Refit only on a real size change (file panel width, window resize); a plain
        // switch keeps the box, so we skip the resize (sub-row jitter would otherwise
        // reflow ±1 row).
        const w = el.clientWidth, h = el.clientHeight;
        const REFIT_TOL = 8;
        if (w > 0 && h > 0 && (Math.abs(w - (entry._fitW || 0)) > REFIT_TOL || Math.abs(h - (entry._fitH || 0)) > REFIT_TOL)) {
          safeFit(entry); // records _fitW/_fitH
        }
        // Flush a pending coalesced chunk first — background sessions flush at
        // BACKGROUND_FLUSH_INTERVAL_MS (2 s), so without this the output tail
        // could stay stale for up to 2 s after the switch (#81).
        flushTerminalBuffer(sessionId);
        drainReplayBuffer(sessionId);
        // Promote this terminal on top; demote the others. Inactive containers get
        // pointer-events:none via CSS and only the active terminal is focused, so
        // input always lands on the visible one (no `inert` needed → no cross-mode
        // cleanup when switching to grid mode).
        document.querySelectorAll('.terminal-container.visible').forEach(c => {
          if (c !== el) c.classList.remove('visible');
        });
        el.classList.add('visible');
        // NOTE: no per-switch WebGL suspend/restore of OTHER tabs here. Swapping
        // the renderer DOM↔WebGL on every tab click changes the effective cell
        // height by a device-pixel rounding step (fractional display scaling),
        // invalidating the cached fit right after the clip self-heal ran with
        // stale metrics — the "half a row offscreen after a tab switch" bug.
        // All open tabs keep their GL context instead: the LRU cap (12) stays
        // under Chromium's ~16 context limit, and a lost context auto-falls
        // back to the DOM renderer. Only restore THIS terminal's GL if it lost
        // it earlier (grid off-screen suspend) — a one-time renderer switch,
        // followed by a deferred re-fit because the cell metrics may have
        // shifted and the render service reports them only after a frame.
        if (shouldLoadWebgl() && !entry.webglAddon) {
          restoreTerminalWebgl(sessionId);
          forceRepaint(entry);
          requestAnimationFrame(() => {
            if (openSessions.get(entry.session.sessionId) === entry) safeFit(entry);
          });
        }
        entry.terminal.focus();
        // Self-heal for the sub-REFIT_TOL case: a switch that skipped the re-fit
        // above (height delta ≤ 8px) can still leave the bottom row clipped. Catch
        // it directly instead of lowering REFIT_TOL (which would reintroduce ±1-row
        // tab-switch jitter) (#59).
        if (isBottomRowClipped(entry)) safeFit(entry);
      } else {
        // Grid mode, single view: inactive containers are display:none (not painted),
        // so reveal first (to gain layout), then drain + fit.
        restoreTerminalWebgl(sessionId);
        // Flush the pending coalesced chunk while still non-visible so it lands
        // BEHIND the accumulated replay data (order preserved), then reveal and
        // drain everything in one go (#81).
        flushTerminalBuffer(sessionId);
        document.querySelectorAll('.terminal-container.visible').forEach(c => c.classList.remove('visible'));
        el.classList.add('visible');
        drainReplayBuffer(sessionId);
        entry.terminal.focus();
        fitAndScroll(entry);
      }
    }
  }
  if (typeof window.refreshSessionTabs === 'function') window.refreshSessionTabs();
}

function setupDragAndDrop(container, getSessionId) {
  let dragCounter = 0;
  container.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    container.classList.add('drag-over');
  });
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      container.classList.remove('drag-over');
    }
  });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    container.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const paths = Array.from(files).map(f => shellEscape(window.api.getPathForFile(f)));
    window.api.sendInput(getSessionId(), paths.join(' '));
  });
}

