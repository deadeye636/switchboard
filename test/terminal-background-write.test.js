// Tests for the background-write optimisation in public/terminal-manager.js.
//
// Stage B: non-visible sessions use a slow flush cadence (BACKGROUND_FLUSH_INTERVAL_MS)
//          instead of MIN_FLUSH_INTERVAL_MS (~30 fps) so parse CPU is reduced.
// Stage A: non-visible sessions skip terminal.write() entirely; raw PTY chunks
//          accumulate in a rawReplayBuffers Map and are drained on (re)visibility.
//
// isSessionVisible(sessionId) is true when entry.element has the 'visible' CSS class —
// this covers both single view (.visible) and grid mode (.visible.grid-mode) without
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
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    onTitleChange() {}
    onBell() {}
  };
}

function setupDom({ fitDims = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminals"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const spies = { dispose: 0, write: 0, closeTerminal: 0, lastWriteData: null, resize: 0, refresh: 0, lastResize: null, lastRefresh: null, onContextLoss: null };

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
    FitAddon: { FitAddon: class { proposeDimensions() { return fitDims; } fit() {} } },
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
                     // terminal-fit.js holds the pure geometry helpers terminal-manager.js calls
                     // (clampRowsToContentBox / bottomRowClipped) — reachable once a fit is "measured".
                     'renderer/terminal/terminal-fit.js',
                     'renderer/terminal/terminal-context-menu.js', 'renderer/terminal/terminal-manager.js',
                     'renderer/views/grid-view.js']) {
    const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
    vm.runInContext(src, ctx, { filename: path.basename(rel) });
  }

  const inCtx = (code) => vm.runInContext(code, ctx);
  return { window, spies, inCtx, destroy: () => window.close() };
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
    // The timer delay for a non-visible session must be >= BACKGROUND_FLUSH_INTERVAL_MS (1500 ms)
    // We can only verify a timer was set (not the value directly), but we can check
    // that BACKGROUND_FLUSH_INTERVAL_MS is defined and > MIN_FLUSH_INTERVAL_MS.
    assert.ok(buf.timerId !== 0, 'a timer is scheduled (not immediate RAF)');
    assert.ok(inCtx('BACKGROUND_FLUSH_INTERVAL_MS') > inCtx('MIN_FLUSH_INTERVAL_MS'),
      'BACKGROUND_FLUSH_INTERVAL_MS must be greater than MIN_FLUSH_INTERVAL_MS');
    assert.ok(inCtx('BACKGROUND_FLUSH_INTERVAL_MS') >= 1500,
      'background interval is at least 1500 ms');
  } finally {
    destroy();
  }
});

test('Stage B: visible session uses the fast 33ms cadence (no regression)', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible'); // mark as visible

    // No prior flush → elapsed is infinite → must take rAF path immediately
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['y'], rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.ok(buf.rafId !== 0, 'rAF scheduled for visible session (fast path)');
    assert.strictEqual(buf.timerId, 0, 'no slow timer for visible session');
  } finally {
    destroy();
  }
});

// ---------------------------------------------------------------------------
// Stage A — skip write / buffer / replay
// ---------------------------------------------------------------------------

test('Stage A: flushTerminalBuffer does NOT call write() for a non-visible session', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
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
