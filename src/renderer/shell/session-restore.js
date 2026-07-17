// --- Session restore: persist the open sessions across an ordinary quit, and bring them back (#218) ---
//
// The DOM half of the restore. The PURE half already lives in shell/update-restart.js — the localStorage
// keys, collectUpdateRestartState, selectRestorableSessions, resolveRestoreFocusId — which is UMD, so it
// is require()-able and tested. This file is what that half cannot be: it mounts terminals, drives the
// progress bar in the placeholder, and reads the renderer's live session state. It came out of app.js.
//
// THIS FILE IS A PLAIN CLASSIC SCRIPT ON PURPOSE — no IIFE, no UMD factory. Everything it reaches for is
// a top-level declaration of some OTHER classic script, so it lives in the shared global lexical scope and
// resolves at CALL time — which is why this is a move and not a rewrite, and why no ctx is needed.
// Wrapping it in a UMD factory would be the mistake #218 measured on grid-gestures.js: the names would
// resolve against the factory's scope and window properties instead of the bindings, and the suite would
// stay green while the app misbehaved.
//
// What it reaches into, by file — it is THREE, not just app.js, and the header is the only import graph
// this renderer has:
//   app.js                     openSessions, activeSessionId, gridViewActive, sessionMap,
//                              appGlobalSettings, restoreProgressEl, openSession,
//                              refreshSessionStatusViews
//   views/grid-view.js         showGridView
//   terminal/terminal-manager.js   showSession
//   shell/update-restart.js    OPEN_SESSIONS_STATE_KEY, collectUpdateRestartState,
//                              hasRestorableUpdateSessions, selectRestorableSessions,
//                              resolveRestoreFocusId (UMD → window properties)
//
// It reads app.js's state; it writes none of it. Everything it changes is the DOM, localStorage, or
// window.__restoringOpenSessions.
//
// LOAD ORDER: this file must be parsed before app.js RUNS, not before it parses. app.js's only call is
// `await restoreOpenSessionsOnLaunch()` inside its boot chain, so call-time resolution carries it either
// way. The two window listeners at the bottom register at PARSE time, which is safe precisely because
// beforeunload/pagehide cannot fire during boot — unlike an IPC listener, which is why the IPC cluster in
// app.js is NOT a candidate for the same treatment.

// --- Persist & restore open sessions across an ordinary quit → relaunch ---
// Mirrors the auto-update restart flow but uses a durable localStorage key that
// we refresh on every normal quit (not a one-shot). PTYs die when the app quits,
// so "persist" means re-open/resume the same sessions on next launch — exactly
// what the update path does.
function restoreOpenSessionsEnabled() {
  // Default ON: only an explicit `false` disables it.
  return !(appGlobalSettings && appGlobalSettings.restoreSessionsOnLaunch === false);
}

// Synchronous (runs from beforeunload/pagehide) — must not await anything.
function saveOpenSessionsState() {
  if (typeof collectUpdateRestartState !== 'function') return;
  if (!restoreOpenSessionsEnabled()) {
    try { localStorage.removeItem(OPEN_SESSIONS_STATE_KEY); } catch {}
    return;
  }
  const state = collectUpdateRestartState(openSessions, { activeSessionId, gridViewActive });
  try {
    if (typeof hasRestorableUpdateSessions === 'function' && hasRestorableUpdateSessions(state)) {
      localStorage.setItem(OPEN_SESSIONS_STATE_KEY, JSON.stringify(state));
    } else {
      localStorage.removeItem(OPEN_SESSIONS_STATE_KEY);
    }
  } catch {}
}

// Determinate restore progress shown inside the placeholder. The restore knows
// the total up front and mounts sequentially, so this is a real "done of total"
// bar, not a spinner pretending. A single session gets just the spinner + label
// (a bar that jumps 0→100 once and vanishes reads as noise).
function setRestoreProgress(done, total) {
  if (!restoreProgressEl) return;
  const multi = total > 1;
  const title = restoreProgressEl.querySelector('.restore-title');
  const count = restoreProgressEl.querySelector('.restore-count');
  const track = restoreProgressEl.querySelector('.restore-track');
  const fill = restoreProgressEl.querySelector('.restore-fill');
  if (title) title.textContent = multi ? 'Restoring sessions' : 'Restoring session…';
  if (count) { count.textContent = multi ? `${done} of ${total}` : ''; count.style.display = multi ? '' : 'none'; }
  if (track) track.style.display = multi ? '' : 'none';
  if (fill) fill.style.transform = `scaleX(${total > 0 ? done / total : 0})`;
}

async function restoreOpenSessionsOnLaunch() {
  if (typeof hasRestorableUpdateSessions !== 'function') return false;
  // Read the live setting (the cached copy may not be populated yet at boot).
  let tabsMode = false;
  try {
    const global = await window.api.getSetting('global');
    if (global && global.restoreSessionsOnLaunch === false) return false;
    tabsMode = global?.sessionDisplayMode === 'tabs';
  } catch {}

  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(OPEN_SESSIONS_STATE_KEY) || 'null');
  } catch {}
  // Durable key — left in place so a crash/forced-kill still restores next time;
  // it is refreshed on the next normal quit.
  if (!hasRestorableUpdateSessions(state)) return false;

  // Don't restore the grid mosaic in tabs mode (single-view only) — a stale grid
  // flag would otherwise leave gridViewActive=true in tabs and desync the
  // tab→grid restore. Read the mode from settings, not the <body> class: the
  // class is set by a separate async chain (_applySessionDisplaySettings) that can
  // lose the race against this one, which would let the flag leak into tabs mode.
  if (state.gridViewActive && !tabsMode) {
    localStorage.setItem('gridViewActive', '1');
    if (!gridViewActive) showGridView();
  }

  const uniqueSessions = selectRestorableSessions(state, {
    lookup: (id) => sessionMap.get(id),
    isOpen: (id) => openSessions.has(id),
  });

  // Mount them all first, switch the view exactly once. The flag suppresses the
  // per-session status churn (refreshSessionStatusViews returns early) and keeps
  // the tab strip empty, so tabs don't fill in one by one and the sidebar/grid
  // don't re-render N times — everything settles once, at the end.
  window.__restoringOpenSessions = true;
  // Tabs mode paints every mounted terminal (only `.visible` is lifted on top),
  // so each session mounted below would flash over the previous one. Hide the
  // stack behind the placeholder until the focus target is picked. `visibility`,
  // never `display` — a container without layout measures 0×0 and safeFit would
  // fit the terminal to garbage dimensions.
  document.body.classList.add('restoring-sessions');
  setRestoreProgress(0, uniqueSessions.length);
  try {
    let done = 0;
    for (const session of uniqueSessions) {
      await openSession(session, null, { show: false });
      setRestoreProgress(++done, uniqueSessions.length);
    }
  } finally {
    window.__restoringOpenSessions = false;
    document.body.classList.remove('restoring-sessions');
  }

  const focusId = resolveRestoreFocusId(state, uniqueSessions, (id) => openSessions.has(id));
  if (focusId) showSession(focusId);
  else if (typeof window.refreshSessionTabs === 'function') window.refreshSessionTabs();
  // Statuses were gated for the whole restore — bring the sidebar, tabs and grid
  // up to date once now that the full set is open.
  refreshSessionStatusViews();
  return uniqueSessions.length > 0;
}

// Persist on the renderer unload that accompanies an ordinary quit. localStorage
// writes are synchronous and durable, so the blob survives to the next launch.
window.addEventListener('beforeunload', saveOpenSessionsState);
window.addEventListener('pagehide', saveOpenSessionsState);
