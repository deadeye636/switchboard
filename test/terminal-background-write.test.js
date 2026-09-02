// Tests for the background-write optimisation in src/renderer/terminal/terminal-manager.js.
//
// Stage B: non-visible sessions use a slow flush cadence (BACKGROUND_FLUSH_INTERVAL_MS)
//          instead of MIN_FLUSH_INTERVAL_MS (~30 fps) so parse CPU is reduced.
// Stage A: non-visible sessions skip terminal.write() entirely; raw PTY chunks
//          accumulate in a rawReplayBuffers Map and are drained on (re)visibility.
//
// isSessionVisible(sessionId) is true when entry.element has the 'visible' CSS class —
// this covers both single view and grid mode (a grid card carries .grid-mode too, but the
// predicate only tests .visible) without
// gating on activeSessionId (which would break grid cards).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC_DIR = path.join(__dirname, '..', 'src');

function makeTerminalStub(spies) {
  return class TerminalStub {
    constructor(opts) {
      this.options = { ...opts };
      this.buffer = { active: { viewportY: 0, baseY: 0 } };
      // safeFit treats a fit as "measured" only when the render service reports a cell height;
      // without this it would spin its retry loop instead of resizing (#128 test).
      this._core = { _renderService: { dimensions: { css: { cell: { height: 17 } } } } };
      this.parser = { registerOscHandler: () => {} };
      this.unicode = { activeVersion: '' };
    }
    loadAddon() {}
    registerLinkProvider() {}
    open() {}
    dispose() { spies.dispose++; }
    refresh(a, b) { spies.refresh++; spies.lastRefresh = [a, b]; }
    write(_d, cb) { spies.write++; spies.lastWriteData = _d; if (cb) cb(); }
    focus() {}
    resize(cols, rows) { spies.resize++; spies.lastResize = [cols, rows]; this.cols = cols; this.rows = rows; }
    scrollToBottom() {}
    scrollLines() {}
    // `selected` is what a test sets to put a selection on the terminal (#459); nothing selects by
    // default, so every other test sees the old behaviour.
    hasSelection() { return this.selected === true; }
    getSelection() { return this.selected ? 'selected text' : ''; }
    clearSelection() { this.selected = false; spies.clearSelection++; }
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    onTitleChange() {}
    onBell() {}
  };
}

function setupDom({ fitDims = null } = {}) {
  // Mutable so a test can change what the next fit proposes — the width change is the whole
  // trigger for #459, and it has to happen between two fits of the same terminal.
  const fit = { dims: fitDims };
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminals"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // jsdom does no layout, so clientWidth/clientHeight are 0 for everything. safeFit's
  // #265 guard bails on a zero-size element (a hidden container can't be measured), so a
  // terminal-container must look laid-out for a fit to run. Report a real size for the
  // container only; other elements stay 0 as before.
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true, get() { return this.classList?.contains('terminal-container') ? 800 : 0; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true, get() { return this.classList?.contains('terminal-container') ? 600 : 0; },
  });
  const spies = { dispose: 0, write: 0, closeTerminal: 0, lastWriteData: null, resize: 0, refresh: 0, lastResize: null, lastRefresh: null, onContextLoss: null, clearSelection: 0 };

  window.api = new Proxy({ platform: 'linux' }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'closeTerminal') return () => { spies.closeTerminal++; };
      return () => Promise.resolve({ ok: true });
    },
  });

  spies.webglDispose = 0;
  const noopClass = class { dispose() {} onContextLoss() {} };
  const stubGlobals = {
    Terminal: makeTerminalStub(spies),
    FitAddon: { FitAddon: class { proposeDimensions() { return fit.dims; } fit() {} } },
    WebLinksAddon: { WebLinksAddon: noopClass },
    SearchAddon: { SearchAddon: class { clearDecorations() {} findNext() {} findPrevious() {} } },
    UnicodeGraphemesAddon: { UnicodeGraphemesAddon: noopClass },
    WebglAddon: { WebglAddon: class { dispose() { spies.webglDispose++; } onContextLoss(cb) { spies.onContextLoss = cb; } } },

    TERMINAL_THEME: { background: '#000000' },
    terminalsEl: window.document.getElementById('terminals'),
    openSessions: new Map(),
    gridCards: new Map(),
    sessionMap: new Map(),
    activePtyIds: new Set(),
    activeSessionId: null,
    gridViewActive: false,

    toggleGridView: () => {},
    syncTitleToAriaLabel: () => {},
    isSessionNavKey: () => false,
    handleSessionNavKey: () => false,
    matchShortcut: () => false,
    appShortcuts: {},
    focusGridCard: () => {},
    wrapInGridCard: () => {},
    showGridView: () => {},
    trackActivity: () => {},
    updatePtyTitle: () => {},
    openFileInPanel: () => {},
    setActiveSession: () => {},
    clearNotifications: () => {},
    // app.js's row lookup (#289): the sidebar highlight is applied to EVERY rendered row of a session.
    sessionRowEls: (sessionId, root = window.document) =>
      root.querySelectorAll(`.session-item[data-session-id="${sessionId}"]`),
    hidePlanViewer: () => {},
    showTerminalHeader: () => {},
    placeholder: window.document.createElement('div'),
    terminalHeader: window.document.createElement('div'),
    gridViewer: window.document.createElement('div'),
    gridViewerCount: window.document.createElement('span'),
  };

  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const ctx = dom.getInternalVMContext();
  for (const rel of ['renderer/lib/utils.js', 'renderer/shell/shortcuts.js',
                     // terminal-fit.js holds the pure helpers terminal-manager.js calls
                     // (clampRowsToContentBox / bottomRowClipped, and clearSelectionAfterReflow
                     // since #459) — reachable once a fit is "measured".
                     'renderer/terminal/terminal-fit.js',
                     'renderer/terminal/terminal-context-menu.js', 'renderer/terminal/terminal-manager.js',
                     'renderer/views/grid-view.js']) {
    const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
    vm.runInContext(src, ctx, { filename: path.basename(rel) });
  }

  const inCtx = (code) => vm.runInContext(code, ctx);
  return { window, spies, inCtx, setFitDims: (d) => { fit.dims = d; }, destroy: () => window.close() };
}

// ---------------------------------------------------------------------------
// isSessionVisible predicate
// ---------------------------------------------------------------------------

test('isSessionVisible: returns false for a session without the visible class', () => {
  const { window, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    // element starts without 'visible' (not yet shown)
    assert.strictEqual(window.isSessionVisible('s1'), false);
  } finally {
    destroy();
  }
});

test('isSessionVisible: returns true when entry.element has the visible class (single view)', () => {
  const { window, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible');
    assert.strictEqual(window.isSessionVisible('s1'), true);
  } finally {
    destroy();
  }
});

test('isSessionVisible: returns true for a grid card (visible + grid-mode classes)', () => {
  const { window, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible', 'grid-mode');
    assert.strictEqual(window.isSessionVisible('s1'), true);
  } finally {
    destroy();
  }
});

test('isSessionVisible: returns false for unknown session', () => {
  const { window, destroy } = setupDom();
  try {
    assert.strictEqual(window.isSessionVisible('no-such-session'), false);
  } finally {
    destroy();
  }
});

// ---------------------------------------------------------------------------
// Stage B — throttle: non-visible sessions use slow cadence
// ---------------------------------------------------------------------------

test('Stage B: flushTerminalBuffer uses background interval for non-visible sessions', () => {
  // A non-visible session that just had a flush should schedule with the slow
  // background timer, not the fast 33ms RAF path.
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    // entry.element has no 'visible' class → non-visible

    // Stamp lastFlushAt as just-now so scheduleFlush sees elapsed < MIN_FLUSH_INTERVAL_MS
    inCtx(`lastFlushAt.set('s1', performance.now())`);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['x'], rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    // The timer delay for a non-visible session must be >= BACKGROUND_FLUSH_INTERVAL_MS (2000 ms)
    // We can only verify a timer was set (not the value directly), but we can check
    // that BACKGROUND_FLUSH_INTERVAL_MS is defined and > MIN_FLUSH_INTERVAL_MS.
    assert.ok(buf.timerId !== 0, 'a timer is scheduled (not immediate RAF)');
    assert.ok(inCtx('BACKGROUND_FLUSH_INTERVAL_MS') > inCtx('MIN_FLUSH_INTERVAL_MS'),
      'BACKGROUND_FLUSH_INTERVAL_MS must be greater than MIN_FLUSH_INTERVAL_MS');
    assert.ok(inCtx('BACKGROUND_FLUSH_INTERVAL_MS') >= 1500,
      'background interval is at least 1500 ms — the constant is 2000');
  } finally {
    destroy();
  }
});

// Records what scheduleFlush asks setTimeout for. The delay IS the contract here, and nothing else
// in these isolated tests touches a timer.
function captureFlushDelays(inCtx) {
  inCtx(`globalThis.__delays = []; globalThis.__cleared = 0;
         globalThis.__realSetTimeout = setTimeout; globalThis.__realClearTimeout = clearTimeout;
         globalThis.setTimeout = (fn, ms) => { __delays.push(ms); return __realSetTimeout(fn, 100000); };
         globalThis.clearTimeout = (id) => { if (id) __cleared++; return __realClearTimeout(id); };`);
  return {
    delays: () => inCtx('__delays'),
    cleared: () => inCtx('__cleared'),
    restore: () => inCtx('globalThis.setTimeout = __realSetTimeout; globalThis.clearTimeout = __realClearTimeout;'),
  };
}

test('Stage B: a visible session waits for the settle, still inside the 33 ms cadence (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible'); // mark as visible

    // No prior flush. The old behaviour flushed on the very next animation frame, which is how the
    // first read of a redraw became a frame of its own — the cursor flickering between the prompt and
    // the redraw position (#513). It waits for the stream to go quiet instead.
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['y'], rafId: 0, timerId: 0, firstAt: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.strictEqual(buf.rafId, 0, 'no immediate rAF — the buffer waits for the settle first');
    assert.ok(buf.timerId !== 0, 'a settle timer is scheduled');
    // Compared value by value: the array comes out of the vm realm, so deepStrictEqual would fail on
    // the prototype alone and say nothing about the delay.
    assert.strictEqual(cap.delays().length, 1, 'exactly one wait was scheduled');
    assert.strictEqual(cap.delays()[0], inCtx('FLUSH_SETTLE_MS'), 'the wait is exactly the settle');
    assert.ok(inCtx('FLUSH_SETTLE_MS') < inCtx('MIN_FLUSH_INTERVAL_MS'),
      'the settle must stay under the visible cadence, or it would slow streaming down');
    assert.ok(inCtx('FLUSH_SETTLE_MS') < inCtx('BACKGROUND_FLUSH_INTERVAL_MS'),
      'a visible session must not fall onto the background cadence');
  } finally {
    cap.restore();
    destroy();
  }
});

test('Stage B: a following chunk REPLACES the pending flush rather than letting it fire (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible');

    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['a'], rafId: 0, timerId: 0, firstAt: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);
    const first = inCtx(`terminalWriteBuffers.get('s1').timerId`);

    // The second read of the same redraw. Returning early here — which is what it used to do — is what
    // let the first read be written on its own.
    inCtx(`terminalWriteBuffers.get('s1').chunks.push('b')`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);
    const second = inCtx(`terminalWriteBuffers.get('s1').timerId`);

    assert.ok(cap.cleared() >= 1, 'the pending flush was cleared, not left to fire');
    assert.notStrictEqual(second, first, 'the second chunk re-scheduled the flush');
    assert.strictEqual(cap.delays().length, 2, 'one wait per chunk');
  } finally {
    cap.restore();
    destroy();
  }
});

test('Stage B: the settle never pushes a flush past one interval from the first chunk (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible');

    // A buffer whose first chunk landed a full interval ago: a continuously streaming session. The
    // ceiling has to win over the settle here, or streaming would be delayed indefinitely by its own
    // steady arrival of data.
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['a'], rafId: 0, timerId: 0,
             firstAt: performance.now() - MIN_FLUSH_INTERVAL_MS })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.ok(buf.rafId !== 0, 'the ceiling is reached, so it flushes on the next frame');
    assert.strictEqual(buf.timerId, 0, 'no further settle once the ceiling is reached');
    assert.strictEqual(cap.delays().length, 0, 'no timer at all on the ceiling path');
  } finally {
    cap.restore();
    destroy();
  }
});

// ---------------------------------------------------------------------------
// #513 — a completed synchronized frame may expose a transient cursor at column 1
// ---------------------------------------------------------------------------

const SYNC_CURSOR_AT_COLUMN_ONE =
  '\x1b[?2026h\x1b[?25l\x1b[46;1H\x1b[?25h\x1b[?2026l';
const COMPOSER_CURSOR_CORRECTION =
  '\x1b[?25l \x1b[48;51H\x1b[?25h';

test('Stage B: recognizes a completed synchronized frame that exposes column 1 (#513)', () => {
  const { inCtx, destroy } = setupDom();
  try {
    const frame = JSON.stringify(SYNC_CURSOR_AT_COLUMN_ONE);
    assert.strictEqual(
      inCtx(`endsWithVisibleSynchronizedCursorAtColumnOne([${frame}])`),
      true,
      'the complete synchronized cursor frame needs the structural hold'
    );

    const split = [
      SYNC_CURSOR_AT_COLUMN_ONE.slice(0, 24),
      SYNC_CURSOR_AT_COLUMN_ONE.slice(24),
    ].map(JSON.stringify).join(',');
    assert.strictEqual(
      inCtx(`endsWithVisibleSynchronizedCursorAtColumnOne([${split}])`),
      true,
      'PTY chunk boundaries do not change the VT state'
    );
  } finally {
    destroy();
  }
});

test('Stage B: a later composer placement releases the transient cursor hold (#513)', () => {
  const { inCtx, destroy } = setupDom();
  try {
    const chunks = [SYNC_CURSOR_AT_COLUMN_ONE, COMPOSER_CURSOR_CORRECTION]
      .map(JSON.stringify).join(',');
    assert.strictEqual(
      inCtx(`endsWithVisibleSynchronizedCursorAtColumnOne([${chunks}])`),
      false,
      'the correction must make the combined buffer immediately eligible again'
    );
  } finally {
    destroy();
  }
});

test('Stage B: a partial following sync block does not hide the completed transient frame (#513)', () => {
  const { inCtx, destroy } = setupDom();
  try {
    const chunks = [SYNC_CURSOR_AT_COLUMN_ONE, '\x1b[?2026h\x1b[?25l']
      .map(JSON.stringify).join(',');
    assert.strictEqual(
      inCtx(`endsWithVisibleSynchronizedCursorAtColumnOne([${chunks}])`),
      true,
      'the opener paired with the last close matters, not the last opener overall'
    );
  } finally {
    destroy();
  }
});

test('Stage B: ordinary synchronized cursor placements keep the normal settle (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    window.openSessions.get('s1').element.classList.add('visible');
    const ordinary = JSON.stringify(
      '\x1b[?2026h\x1b[?25l\x1b[46;3H\x1b[?25h\x1b[?2026l'
    );
    inCtx(`terminalWriteBuffers.set('s1', { chunks: [${ordinary}], rafId: 0, timerId: 0, firstAt: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    assert.strictEqual(cap.delays()[0], inCtx('FLUSH_SETTLE_MS'),
      'a non-origin cursor frame must not pay the exceptional hold');
  } finally {
    cap.restore();
    destroy();
  }
});

test('Stage B: a transient cursor frame waits for its bounded correction window (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    window.openSessions.get('s1').element.classList.add('visible');
    const frame = JSON.stringify(SYNC_CURSOR_AT_COLUMN_ONE);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: [${frame}], rafId: 0, timerId: 0, firstAt: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    assert.strictEqual(cap.delays()[0], inCtx('TRANSIENT_CURSOR_FRAME_HOLD_MS'),
      'both settle and ceiling use the bounded structural hold');
  } finally {
    cap.restore();
    destroy();
  }
});

test('Stage B: a late correction makes the combined frame immediately eligible (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    window.openSessions.get('s1').element.classList.add('visible');
    const chunks = [SYNC_CURSOR_AT_COLUMN_ONE, COMPOSER_CURSOR_CORRECTION]
      .map(JSON.stringify).join(',');
    inCtx(`terminalWriteBuffers.set('s1', { chunks: [${chunks}], rafId: 0, timerId: 0,
             firstAt: performance.now() - MIN_FLUSH_INTERVAL_MS - 1 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.ok(buf.rafId !== 0, 'the expired ordinary ceiling releases both frames on the next rAF');
    assert.strictEqual(buf.timerId, 0, 'the correction is not held for another settle');
    assert.strictEqual(cap.delays().length, 0, 'no timeout remains once the correction is buffered');
  } finally {
    cap.restore();
    destroy();
  }
});

test('Stage B: an uncorrected column-1 frame is released at the safety bound (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    window.openSessions.get('s1').element.classList.add('visible');
    const frame = JSON.stringify(SYNC_CURSOR_AT_COLUMN_ONE);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: [${frame}], rafId: 0, timerId: 0,
             firstAt: performance.now() - TRANSIENT_CURSOR_FRAME_HOLD_MS })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.ok(buf.rafId !== 0, 'a legitimate column-1 placement is eventually presented');
    assert.strictEqual(buf.timerId, 0, 'the safety bound cannot reschedule itself indefinitely');
    assert.strictEqual(cap.delays().length, 0, 'the reached bound flushes without another timer');
  } finally {
    cap.restore();
    destroy();
  }
});

test('Stage B: hidden sessions keep their background cadence for the same VT frame (#513)', () => {
  const { window, inCtx, destroy } = setupDom();
  const cap = captureFlushDelays(inCtx);
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    inCtx(`lastFlushAt.set('s1', performance.now())`);
    const frame = JSON.stringify(SYNC_CURSOR_AT_COLUMN_ONE);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: [${frame}], rafId: 0, timerId: 0, firstAt: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    assert.ok(cap.delays()[0] >= 1500,
      'an invisible cursor must not shorten the background flush interval');
  } finally {
    cap.restore();
    destroy();
  }
});

// ---------------------------------------------------------------------------
// Stage A — skip write / buffer / replay
// ---------------------------------------------------------------------------

test('Stage A: flushTerminalBuffer does NOT call write() for a non-visible session', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    // Stage A is the BUFFERED path, and since #339 what selects it is the setting (or grid mode),
    // not "the display mode is not tabs" — with live render on, a mounted background session is
    // written to as its output arrives.
    window._setLiveRenderBackground(false);
    window.createTerminalEntry({ sessionId: 's1' });
    // No 'visible' class → non-visible

    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 0, 'write() must not be called for a non-visible session');
  } finally {
    destroy();
  }
});

test('Stage A: flushTerminalBuffer accumulates raw chunks in rawReplayBuffers for non-visible session', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    // Stage A is the BUFFERED path, and since #339 what selects it is the setting (or grid mode),
    // not "the display mode is not tabs" — with live render on, a mounted background session is
    // written to as its output arrives.
    window._setLiveRenderBackground(false);
    window.createTerminalEntry({ sessionId: 's1' });

    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['hello'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    inCtx(`terminalWriteBuffers.set('s1', { chunks: [' world'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    const replayArr = inCtx(`rawReplayBuffers.get('s1')`);
    assert.ok(Array.isArray(replayArr), 'rawReplayBuffers has an array for s1');
    assert.ok(replayArr.length >= 1, 'at least one chunk stored');
    // The combined data should contain both pieces
    const combined = replayArr.join('');
    assert.ok(combined.includes('hello'), 'first chunk accumulated');
    assert.ok(combined.includes(' world'), 'second chunk accumulated');
  } finally {
    destroy();
  }
});

test('Stage A: flushTerminalBuffer calls write() for a visible session (no regression)', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible');

    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 1, 'write() called for visible session');
  } finally {
    destroy();
  }
});

test('Stage A: showSession drains rawReplayBuffer via a single write() and clears it', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    // Stage A is the BUFFERED path, and since #339 what selects it is the setting (or grid mode),
    // not "the display mode is not tabs" — with live render on, a mounted background session is
    // written to as its output arrives.
    window._setLiveRenderBackground(false);
    window.createTerminalEntry({ sessionId: 's1' });

    // Simulate two background flushes accumulating data in replay buffer
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['first'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['second'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 0, 'no writes during background');

    const replayBefore = inCtx(`rawReplayBuffers.get('s1')`);
    assert.ok(Array.isArray(replayBefore) && replayBefore.length > 0, 'replay buffer has data');

    // Now make it visible (single view)
    window.showSession('s1');

    // Should have written (at least once to drain replay)
    assert.ok(spies.write >= 1, 'write() called during showSession drain');

    // Replay buffer must be cleared
    const replayAfter = inCtx(`rawReplayBuffers.get('s1')`);
    const isEmpty = replayAfter === undefined || (Array.isArray(replayAfter) && replayAfter.length === 0);
    assert.ok(isEmpty, 'rawReplayBuffers cleared after drain');
  } finally {
    destroy();
  }
});

test('Stage A: raw replay buffer cap drops oldest chunks when exceeded', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    const capBytes = inCtx('RAW_REPLAY_BUFFER_CAP_BYTES');
    assert.ok(typeof capBytes === 'number' && capBytes >= 1_000_000,
      'RAW_REPLAY_BUFFER_CAP_BYTES should be at least 1 MB');

    // Inject directly into rawReplayBuffers to bypass the write buffer path
    inCtx(`rawReplayBuffers.set('s1', [])`);
    // Call the internal accumulation function with an oversized payload
    inCtx(`
      (function() {
        const arr = rawReplayBuffers.get('s1');
        const sentinel = 'SENTINEL_START';
        arr.push(sentinel);
        const big = 'B'.repeat(${capBytes} + 100);
        arr.push(big);
        // Trigger cap enforcement by calling the helper used in flushTerminalBuffer
        enforceReplayBufferCap('s1');
      })()
    `);

    const arr = inCtx(`rawReplayBuffers.get('s1')`);
    const total = arr.reduce((s, c) => s + c.length, 0);
    assert.ok(total <= capBytes, 'total bytes after cap enforcement must be within cap');
    // The sentinel (pushed first) should have been dropped (oldest)
    const combined = arr.join('');
    assert.ok(!combined.includes('SENTINEL_START'), 'oldest chunk dropped when cap exceeded');
  } finally {
    destroy();
  }
});

test('Stage A: grid card (visible + grid-mode) still receives writes — activeSessionId trap does not regress', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 'grid-card-session' });
    const entry = window.openSessions.get('grid-card-session');
    // A grid card has BOTH visible and grid-mode classes — it IS visible.
    entry.element.classList.add('visible', 'grid-mode');

    // Even though it is NOT the activeSessionId, it should receive writes.
    window.activeSessionId = 'some-other-session';

    inCtx(`terminalWriteBuffers.set('grid-card-session', { chunks: ['grid data'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('grid-card-session');

    assert.strictEqual(spies.write, 1,
      'grid card (visible+grid-mode) must receive write() even when not the activeSessionId');
    assert.strictEqual(inCtx(`rawReplayBuffers.get('grid-card-session') === undefined || rawReplayBuffers.get('grid-card-session').length === 0`),
      true, 'no data buffered for visible grid card');
  } finally {
    destroy();
  }
});

test('Stage A: destroySession clears rawReplayBuffers entry', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    // Stage A is the BUFFERED path, and since #339 what selects it is the setting (or grid mode),
    // not "the display mode is not tabs" — with live render on, a mounted background session is
    // written to as its output arrives.
    window._setLiveRenderBackground(false);
    window.createTerminalEntry({ sessionId: 's1' });

    // Accumulate some data
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.ok(inCtx(`(rawReplayBuffers.get('s1') || []).length > 0`), 'replay buffer has data before destroy');

    window.destroySession('s1');

    assert.ok(!inCtx(`rawReplayBuffers.has('s1')`), 'rawReplayBuffers entry cleared on destroySession');
  } finally {
    destroy();
  }
});

// NOTE: the app-level DEC-2026 sync-block guard (ESC[?2026h/l → syncDepth) was removed
// (#85) — it was redundant with xterm 6's native synchronized-output handling and
// mis-counted mixed markers in one coalesced chunk. onTerminalData now always coalesces
// via scheduleFlush; there is no app-level sync buffering left to test. The B1 skip
// lives in flushTerminalBuffer and is covered by the Stage A/B tests above.

// ---------------------------------------------------------------------------
// WebGL context loss (#128)
// ---------------------------------------------------------------------------
// A lost GL context drops xterm onto its DOM renderer, whose cell metrics differ from
// WebGL's (xterm.js#6015). Without a re-fit the terminal keeps a fit computed for the old
// metrics and clips its bottom row. The handler defers one frame, because metrics are only
// reported after the renderer swap has painted.

// jsdom's rAF is real; one turn of the event loop is enough to let a queued frame run.
const nextFrame = (window) => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

test('#128: a lost WebGL context re-fits the terminal and repaints it', async () => {
  const { window, spies, inCtx, destroy } = setupDom({ fitDims: { cols: 100, rows: 40 } });
  try {
    inCtx(`createTerminalEntry({ sessionId: 's1' })`); // loads WebGL itself
    assert.ok(typeof spies.onContextLoss === 'function', 'the addon registered a loss handler');

    const before = { resize: spies.resize, refresh: spies.refresh, webglDispose: spies.webglDispose };
    spies.onContextLoss();
    assert.equal(spies.webglDispose, before.webglDispose + 1, 'the addon is disposed synchronously');
    assert.ok(!inCtx(`!!openSessions.get('s1').webglAddon`), 'the entry no longer holds the addon');
    assert.equal(spies.resize, before.resize, 'the re-fit is deferred, not synchronous');

    await nextFrame(window);
    assert.ok(spies.resize > before.resize, 're-fit ran on the next frame');
    assert.ok(spies.refresh > before.refresh, 'and forced a repaint');
    // Full viewport, not a partial range — the DOM renderer has to redraw everything.
    assert.deepEqual(spies.lastRefresh, [0, spies.lastResize[1] - 1]);
  } finally {
    destroy();
  }
});

test('#128: no re-fit when the session is gone before the frame runs', async () => {
  const { window, spies, inCtx, destroy } = setupDom({ fitDims: { cols: 100, rows: 40 } });
  try {
    inCtx(`createTerminalEntry({ sessionId: 's1' })`); // loads WebGL itself
    const before = { resize: spies.resize, refresh: spies.refresh };

    spies.onContextLoss();
    inCtx(`openSessions.delete('s1')`); // torn down between the loss and the frame
    await nextFrame(window);

    assert.equal(spies.resize, before.resize, 'no resize on a terminal that is gone');
    assert.equal(spies.refresh, before.refresh, 'no repaint either');
  } finally {
    destroy();
  }
});

test('#128: no re-fit when the id was reused by a different entry', async () => {
  const { window, spies, inCtx, destroy } = setupDom({ fitDims: { cols: 100, rows: 40 } });
  try {
    inCtx(`createTerminalEntry({ sessionId: 's1' })`); // loads WebGL itself
    const before = { resize: spies.resize, refresh: spies.refresh };

    spies.onContextLoss();
    // Same id, different entry object — the guard is an identity check, not a has() check,
    // so a session torn down and reopened under the same id must not be re-fitted by the
    // dead one's pending frame.
    inCtx(`openSessions.set('s1', { session: { sessionId: 's1' } })`);
    await nextFrame(window);

    assert.equal(spies.resize, before.resize, 'the replacement entry is left alone');
    assert.equal(spies.refresh, before.refresh);
  } finally {
    destroy();
  }
});

// ---------------------------------------------------------------------------
// #339 — the live/buffered decision is about the SESSION, not the display mode
// ---------------------------------------------------------------------------

test('#339: a mounted background session is written to live, whatever mode is on', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' }); // no 'visible' class → behind another one
    // No `display-mode-tabs` on the body. That used to be the whole condition, which is why panes
    // buffered: its background tabs are mounted and laid out exactly like tabs' are.
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 1, 'written as it arrives');
    assert.strictEqual(inCtx(`rawReplayBuffers.has('s1')`), false, 'so there is nothing to replay');
  } finally {
    destroy();
  }
});

test('#339: a grid card out of view still buffers', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    // Grid is the case that genuinely differs: a card scrolled out of its box is not laid out, so the
    // write buys nothing and the replay buffer is the cheaper place for the bytes.
    inCtx(`gridViewActive = true`);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 0);
    assert.strictEqual(inCtx(`rawReplayBuffers.get('s1').join('')`), 'data');
  } finally {
    destroy();
  }
});

test('#339: the switch still turns it off', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    window._setLiveRenderBackground(false);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 0, 'buffered on request, in every mode');
  } finally {
    destroy();
  }
});

// ---------------------------------------------------------------------------
// #459 — a selection does not survive a re-wrap
// ---------------------------------------------------------------------------
// Every fit that can change the terminal's width goes through safeFit: the font size, a window
// resize, a pane split, a UI zoom. A width change re-wraps the buffer under the selected cells, so
// copying afterwards returns text that was never selected. What safeFit owes the selection is to
// drop it — and only when the width actually moved, or a terminal would be unusable for copying.

test('#459: a width change on re-fit clears the selection', () => {
  const { window, spies, inCtx, setFitDims, destroy } = setupDom({ fitDims: { cols: 95, rows: 40 } });
  try {
    window.createTerminalEntry({ sessionId: 's1' }); // first fit settles the terminal at 95 columns
    const entry = window.openSessions.get('s1');
    entry.terminal.selected = true; // the user drags a selection across a wrapped line

    setFitDims({ cols: 74, rows: 40 }); // a larger font, a narrower pane — same thing to the grid
    inCtx(`safeFit(openSessions.get('s1'))`);

    assert.equal(entry.terminal.hasSelection(), false, 'the stale selection is gone');
    assert.equal(spies.clearSelection, 1, 'cleared through xterm, so onSelectionChange fires');
  } finally {
    destroy();
  }
});

test('#459: a height-only change leaves the selection alone', () => {
  const { window, spies, inCtx, setFitDims, destroy } = setupDom({ fitDims: { cols: 95, rows: 40 } });
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.terminal.selected = true;

    setFitDims({ cols: 95, rows: 30 }); // shorter box, same width — nothing re-wraps
    inCtx(`safeFit(openSessions.get('s1'))`);

    assert.equal(entry.terminal.hasSelection(), true, 'the selection still points at its own text');
    assert.equal(spies.clearSelection, 0);
  } finally {
    destroy();
  }
});

test('#459: a re-fit that changes nothing leaves the selection alone', () => {
  const { window, spies, inCtx, destroy } = setupDom({ fitDims: { cols: 95, rows: 40 } });
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.terminal.selected = true;

    inCtx(`safeFit(openSessions.get('s1'))`); // a repaint-driven refit with the same box
    inCtx(`safeFit(openSessions.get('s1'))`);

    assert.equal(entry.terminal.hasSelection(), true);
    assert.equal(spies.clearSelection, 0);
  } finally {
    destroy();
  }
});
