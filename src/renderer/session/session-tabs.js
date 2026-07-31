// --- Session tabs: what panes mode kept ---
//
// The tab STRIP this file was written for — the retired tabs mode's VS-Code-style bar over the
// terminal area — is gone (#357 retired the mode, #367 took the strip out). With it went the tab
// builders, the drag-reorder, the overflow dropdown, the context menu and the `#session-tabs`
// element they rendered into.
//
// What is left is shared with panes mode: the pure `buildTabModel`, the tab and session-bar tooltips
// and the project-path splitter (#334), the auto-close rules, `closeTabNow`, and the display-mode
// settings apply. Panes calls them; nothing here renders panes' tabs.
//
// Loaded as a classic <script> (exposes window.* hooks) AND require()-d by node
// tests for the pure buildTabModel(). Keep buildTabModel free of DOM/globals.
//
// Depends on renderer globals: openSessions, activeSessionId, destroySession
// (terminal-manager.js), cleanDisplayName (utils.js), window.panesView, window.getBackend.

// Pure: order the open sessions into a tab list. `sessions` is a plain array of
// { sessionId, name, closed }; `order` is the persisted sessionId order (unknown
// ids keep their insertion order at the end). Returns [{ sessionId, name, active }].
function buildTabModel(sessions, activeId, order) {
  const pos = new Map((order || []).map((id, i) => [id, i]));
  return (sessions || [])
    // A closed (exited) session keeps its tab — the tab exists for as long as the session is mounted,
    // and leaves only via destroySession (the user closing it, or auto-close firing). Filtering closed
    // here made an exited tab vanish on the next unrelated rebuild, even with auto-close off (#256).
    .filter(s => s && s.sessionId)
    .map(s => ({ sessionId: s.sessionId, name: s.name || '', active: s.sessionId === activeId, closed: !!s.closed }))
    .sort((a, b) => {
      const ai = pos.has(a.sessionId) ? pos.get(a.sessionId) : Infinity;
      const bi = pos.has(b.sessionId) ? pos.get(b.sessionId) : Infinity;
      return ai - bi;
    });
}

// Pure: resolve the auto-close-on-exit mode from persisted settings.
// 'never' | 'onSuccess' | 'always'. Default 'always'.
function resolveAutoCloseMode(g) {
  const v = g && g.tabAutoCloseMode;
  return (v === 'never' || v === 'onSuccess' || v === 'always') ? v : 'always';
}

// Pure: resolve the auto-close delay in seconds. Default 5, floored at 0
// (0 = close immediately). Missing / non-numeric / negative → default 5.
function resolveAutoCloseDelaySec(g) {
  const n = g && g.tabAutoCloseDelaySec;
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return 5;
  return Math.floor(n);
}

// Pure: given the mode and a process exit code, should the tab auto-close?
function shouldAutoClose(mode, exitCode) {
  if (mode === 'always') return true;
  if (mode === 'onSuccess') return exitCode === 0;
  return false; // 'never' or unknown
}

// Pure: the tooltip a session's tab carries (#334). It used to be the name and nothing else — which
// is a tooltip that repeats what is already on screen, in the one place a truncated label can be read
// in full and the one place "which of these two is the one in the other project" can be answered.
// Empty parts are left out rather than shown blank: a backend that declares no label, or a session
// with no project, should cost a line, not an empty one.
function buildTabTooltip({ name, project, backend, state } = {}) {
  const title = String(name || '').trim();
  const detail = [project, backend, state].map((v) => String(v || '').trim()).filter(Boolean);
  return [title, detail.join(' · ')].filter(Boolean).join('\n');
}

// The tooltip for a session BAR — the row under the tabs, which shows the name and the project and
// nothing else (#358). Everything the row used to spell out moves in here: the AI title when the name
// shown is a rename over it, the terminal's own title, and the session id. Built on the tab's tooltip
// rather than beside it, so the first two lines say the same thing in both places.
//
// Each extra line is dropped when it repeats one already there. A row whose name IS the AI title would
// otherwise show the same sentence three times, which is the thing this issue removed from the row.
function buildSessionBarTooltip({ name, aiTitle, ptyTitle, sessionId, project, backend, state } = {}) {
  const head = buildTabTooltip({ name, project, backend, state });
  // Compared without a leading marker, because a CLI's own title is usually the AI title with an
  // activity glyph in front of it ("✳ Review the handoff"). Those are two different strings and one
  // sentence, and listing both is the repetition this issue removed one level up. Only the leading
  // run is stripped, and only for the comparison — what gets shown is what the CLI wrote.
  const key = (value) => String(value || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
  const shown = key(name);
  const lines = [];
  const seen = new Set([shown]);
  const add = (value) => {
    const text = String(value || '').trim();
    const k = key(value);
    if (!text || !k || seen.has(k)) return;
    seen.add(k);
    lines.push(text);
  };
  add(aiTitle);
  add(ptyTitle);
  // The id goes through the same filter: a session with no name of any kind is DISPLAYED as its id
  // (`tabTooltipFor` falls back to it), and printing it again under itself is the repetition this
  // whole change removed from the row.
  add(sessionId);
  return [head, ...lines].filter(Boolean).join('\n');
}

// What a typed name MEANS (#95, #358). Three surfaces rename a session — the sidebar row, the tabs-mode
// header and every pane's action row — and all three must agree, because the answer is not "store what
// was typed":
//
//   empty                     -> null: drop the override, follow the automatic title again. There is no
//                                such thing as a session with an empty name.
//   the automatic title       -> null as well. Otherwise confirming without editing anything freezes
//                                TODAY's AI title as a MANUAL name, and no better one can replace it.
//   anything else             -> the typed name.
//
// `fallback` is the automatic title AS DISPLAYED — `cleanDisplayName`'d. Against the raw string the
// second rule never matched for a title carrying a plan prefix or an XML-ish tag, so a rename that
// changed nothing silently switched the automatic title off. That was the sidebar's behaviour until
// #358, while the header compared the cleaned form: one rule, two answers.
function resolveRenameTarget(typed, fallback) {
  const name = String(typed == null ? '' : typed).trim();
  const auto = String(fallback == null ? '' : fallback).trim();
  return (name && name !== auto) ? name : null;
}

// The last segment of a project path — what tells two same-named sessions apart.
function projectTailOf(projectPath) {
  if (!projectPath) return '';
  const parts = String(projectPath).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildTabModel, resolveAutoCloseMode, resolveAutoCloseDelaySec, shouldAutoClose,
    buildTabTooltip, buildSessionBarTooltip, resolveRenameTarget, projectTailOf,
  };
}

(function () {
  if (typeof document === 'undefined') return; // node test context

  let displayMode = 'grid';        // grid | panes (#309, rendered by views/panes-view.js)
  let autoCloseMode = 'always';    // never | onSuccess | always
  let autoCloseDelaySec = 5;       // seconds; 0 = close immediately
  let initialized = false;         // first applySessionDisplaySettings = startup
  const autoCloseTimers = new Map(); // sessionId → pending auto-close timeout id

  // Tear down a session's view. Both callers gate on panes mode, and there panes owns what happens
  // next: `destroySession` has already taken the tab out of the tree (and the pane with it, if that
  // was its last one), so all that is left is to show what the active pane holds now.
  //
  // The tab-strip bookkeeping this used to carry — picking a neighbouring tab, rewriting `tabOrder`,
  // repainting the strip — went with the strip (#367). So did the close-behaviour branch: panes reads
  // `tabCloseBehavior` / `terminalCloseBehavior` itself, in one place, and a second copy here decided
  // nothing.
  function performClose(sessionId) {
    cancelTabAutoClose(sessionId);
    if (typeof destroySession === 'function') destroySession(sessionId);
    if (window.panesView) window.panesView.showActiveOrPlaceholder();
  }

  // Schedule an auto-close after the session's process exits. Only in tabs mode,
  // only when the mode/exit-code combination opts in. The timer no-ops if the
  // session was relaunched (a fresh, non-closed entry exists) or already torn down.
  function scheduleTabAutoClose(sessionId, exitCode) {
    // An exited session should not leave a dead tab sitting in a pane.
    if (displayMode !== 'panes') return;
    if (!shouldAutoClose(autoCloseMode, exitCode)) return;
    cancelTabAutoClose(sessionId);
    const t = setTimeout(() => {
      autoCloseTimers.delete(sessionId);
      const entry = (typeof openSessions !== 'undefined') ? openSessions.get(sessionId) : null;
      if (!entry || !entry.closed) return; // relaunched or gone — leave it be
      performClose(sessionId);
    }, autoCloseDelaySec * 1000);
    autoCloseTimers.set(sessionId, t);
  }

  function cancelTabAutoClose(sessionId) {
    const t = autoCloseTimers.get(sessionId);
    if (t) { clearTimeout(t); autoCloseTimers.delete(sessionId); }
  }

  // --- Settings apply ---

  function applySessionDisplaySettings(g) {
    g = g || {};
    const prevMode = displayMode;
    // 'grid' is the legacy mode (sidebar + grid overview / single view); stored
    // 'legacy' still maps there. 'panes' (#309) renders its own tree and shares
    // this mode switch, but nothing else in this file.
    // A stored 'tabs' resolves to 'panes' (#357) — one place decides that, in grid-layout.js.
    displayMode = resolveSessionDisplayMode(g.sessionDisplayMode);
    autoCloseMode = resolveAutoCloseMode(g);
    autoCloseDelaySec = resolveAutoCloseDelaySec(g);
    // `tabsLiveRender` is the retired name (#339): the setting stopped being about tabs when panes
    // started obeying it. A stored preference still counts — reading the old key second is what makes
    // the rename invisible to whoever had already turned it off.
    if (typeof window._setLiveRenderBackground === 'function') {
      const stored = g.liveRenderBackground !== undefined ? g.liveRenderBackground : g.tabsLiveRender;
      window._setLiveRenderBackground(stored !== false);
    }
    // Leaving grid FOR panes: the order the cards were in on screen, captured before anything tears
    // the mosaic down (#369). `unwrapGridCards` clears that map, so this is the last moment it can be
    // read — and panes adopts in mount order otherwise, which is not what the user was looking at.
    const leavingGrid = initialized && prevMode !== displayMode && displayMode === 'panes';
    const adoptOrder = (leavingGrid && typeof gridCards !== 'undefined' && gridCards && gridCards.size)
      ? [...gridCards.keys()]
      : null;

    // Panes mode owns the terminal area itself (#309): it enables on 'panes' and
    // hands every container back to #terminals on any other mode. Run it before
    // the grid scoping below, so a switch out of panes restores the single view
    // into a #terminals that already holds the containers again.
    if (window.panesView) window.panesView.applySettings(g, adoptOrder ? { adoptOrder } : undefined);

    // A mode switch carries the open sessions across (#369). Skip on the first apply (startup) — the
    // persisted `gridViewActive` already matches the mode, and forcing the mosaic there would override
    // what the user last left on screen.
    if (initialized && prevMode !== displayMode) {
      if (displayMode === 'panes') {
        // The mosaic belongs to grid alone: `#terminals` is the pane tree's host here, and a mosaic
        // switched on inside panes wrecks the layout for good (#343). The sessions are not lost by
        // this — panes adopts every mounted session that has no tab yet, into one pane, which is what
        // the arriving set should look like.
        if (typeof gridViewActive !== 'undefined' && gridViewActive && typeof toggleGridView === 'function') {
          toggleGridView(); // hide grid → single (persists gridViewActive=0)
        }
      } else if (typeof showGridView === 'function') {
        // …and coming back the other way, ALWAYS the mosaic. This used to restore grid's own last
        // mosaic/single preference, so a switch out of panes could land in the single view — where
        // there are no cards, and therefore nothing on screen to say that the other sessions are
        // still open. That is what made a mode switch look like it had thrown them away (#369).
        // Grid IS the overview; showing one session is not the reason anyone switches to it.
        showGridView();
      }
    }
    initialized = true;
  }

  // The tooltip for a session's tab, wherever that tab is (#334). Panes mode calls this too: the two
  // strips build their tabs from the same session data, and a tooltip that said different things in
  // the two modes would be worse than the name-only one it replaces. The state comes from
  // `getSessionStatus`, the same source the dot uses, so the two cannot disagree — and the backend is
  // its own declared label, never an id.
  window.tabTooltipFor = function (session, status) {
    if (!session) return '';
    const backend = (typeof window.getBackend === 'function') ? window.getBackend(session.backendId) : null;
    const name = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session.name || session.aiTitle || session.summary) : '') || session.sessionId;
    return buildTabTooltip({
      name,
      project: projectTailOf(session.projectPath),
      backend: backend && backend.label,
      state: status && status.label,
    });
  };

  // The session bar's tooltip and the project it shows beside the name (#358). Both surfaces that carry
  // a session bar — the pane's action row and the tabs-mode header — read them from here, for the same
  // reason `tabTooltipFor` exists: two compositions of the same facts is the pair that drifts.
  window.sessionBarTooltipFor = function (session, status, ptyTitle) {
    if (!session) return '';
    const backend = (typeof window.getBackend === 'function') ? window.getBackend(session.backendId) : null;
    const name = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session.name || session.aiTitle || session.summary) : '') || session.sessionId;
    return buildSessionBarTooltip({
      name,
      aiTitle: (typeof cleanDisplayName === 'function'
        ? cleanDisplayName(session.aiTitle || session.summary) : (session.aiTitle || session.summary)),
      ptyTitle,
      sessionId: session.sessionId,
      project: projectTailOf(session.projectPath),
      backend: backend && backend.label,
      state: status && status.label,
    });
  };
  window.sessionProjectLabel = (session) => projectTailOf(session && session.projectPath);

  window.scheduleTabAutoClose = scheduleTabAutoClose;
  window.cancelTabAutoClose = cancelTabAutoClose;
  // Close a tab immediately (deliberate stop/archive) — switches to a neighbour or
  // the placeholder. Panes mode has tabs too (#309/#310) and nothing else would ever
  // take that one down: the timed auto-close is the other branch, for a process that
  // ended on its own (#317). Grid/legacy manage their own view.
  window.closeTabNow = (sessionId) => {
    if (displayMode === 'panes') performClose(sessionId);
  };
  window._applySessionDisplaySettings = applySessionDisplaySettings;
})();
