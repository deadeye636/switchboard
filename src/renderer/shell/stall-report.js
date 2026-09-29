// --- Renderer stalls, reported to main's log (#707) ---
//
// `[loop-lag]` (src/perf.js) watches the MAIN process's event loop. A window whose own thread is busy —
// drawing a whole conversation, a morphdom pass over a large sidebar — freezes that window while main stays
// on time, and nothing in the log says so. This is the renderer's half: Chromium reports every task that ran
// 50 ms or more as a `longtask` entry, and one of `STALL_MS` or more is sent to main, which logs it.
//
// Like the main half, a long task says THAT the thread was held, never by what: its attribution names the
// window, not the code. So the likely causes leave a breadcrumb (`window.noteRendererWork(label)`) when they
// start, and the report names the ones that started inside the task. A report naming none came from
// somewhere not yet instrumented, and that is the next thing to know.
//
// A PLAIN CLASSIC SCRIPT in an IIFE, loaded early in index.html so the breadcrumb exists before anything
// calls it. Callers reach it as `window.noteRendererWork?.(…)`, so a page without this file costs nothing.
//
//   preload                  reportRendererStall
(function () {
  'use strict';

  const STALL_MS = 500;
  const NOTE_RING_SIZE = 32;
  const notes = [];

  function noteRendererWork(label) {
    const text = String(label).slice(0, 80);
    const at = performance.now();
    // A hot caller (a terminal write, a conversation op) notes itself per chunk; a repeat of the newest label
    // moves it rather than pushing every other breadcrumb out of the ring — the same rule as main's `noteWork`.
    // The coalesced note keeps the span it covers, not only its newest moment: a long task is reported after
    // it ran, and by then the same label may have been noted again — a moved single timestamp would fall
    // outside the very task it explains.
    const last = notes[notes.length - 1];
    if (last && last.label === text) last.last = at;
    else notes.push({ label: text, first: at, last: at });
    if (notes.length > NOTE_RING_SIZE) notes.shift();
  }
  window.noteRendererWork = noteRendererWork;

  // The breadcrumbs that started inside the task or just before it, oldest first, each once. The window
  // opens LOOKBACK_MS early because some work is only scheduled by the code that notes it and runs in the
  // next task — xterm parses a `write` that way — so its breadcrumb lands shortly before the task it causes.
  const LOOKBACK_MS = 50;
  function workIn(entry) {
    const from = entry.startTime - LOOKBACK_MS;
    const to = entry.startTime + entry.duration;
    const seen = [];
    for (const n of notes) {
      if (n.last >= from && n.first <= to && !seen.includes(n.label)) seen.push(n.label);
    }
    return seen.slice(-8);
  }

  const Observer = window.PerformanceObserver;
  if (typeof Observer !== 'function') return;
  try {
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < STALL_MS) continue;
        try {
          window.api?.reportRendererStall?.({
            ms: Math.round(entry.duration),
            work: workIn(entry),
            hidden: document.visibilityState === 'hidden',
          });
        } catch { /* an older main process */ }
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch { /* a runtime without long-task entries reports nothing */ }
})();
