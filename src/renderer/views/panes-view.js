// --- Panes view: the DOM half of display mode `panes` (#309) ---
//
// VS-Code-style editor groups. `#terminals` becomes the host for a split tree
// (the model is views/pane-tree.js, pure and tested); every leaf renders as a
// pane with its own strip and body, and a session's terminal container is MOVED
// into the body of the pane that owns its tab. Moving the live container is what
// grid mode already does (grid-view.js `wrapInGridCard` / `unwrapGridCards`), so
// no terminal is ever rebuilt or reattached — it changes parent and gets refitted.
//
// Inside one pane the containers stack exactly as tabs mode stacks them: all
// mounted and painted, the active one raised by z-index (see the CSS). That is
// what keeps a switch free of the hidden→visible repaint that made text
// staircase in #20.
//
// The strip carries the session tools too (#309 O13/H2): messages, tasks,
// variables, the IDE-emulation chip and stop sit left of a separator, the pane's
// own `…` menu right of it (#309 O6/A). `#terminal-header` — the singleton those
// tools live in for the other modes — is hidden while panes mode is on.
//
// Depends on renderer globals: openSessions, sessionMap, activeSessionId,
// activePtyIds, terminalsEl, placeholder, terminalHeader (app.js) · showSession,
// openSession, destroySession, safeFit, flushTerminalBuffer, drainReplayBuffer,
// restoreTerminalWebgl, suspendTerminalWebgl, forceRepaint (terminal-manager.js) ·
// getSessionStatus, getSessionRuntimeState, SESSION_STATUS_CLASSES,
// subagentActiveSessions (session-status.js, app.js) · cleanDisplayName
// (utils.js) · confirmAndStopSession, showJsonlViewer, openTasksView (app.js) ·
// PaneTree (views/pane-tree.js) · and four hooks the file panel exposes for the
// view-tab half (#310): window.isMcpActiveForSession, window.filePanelTabLabel,
// window.closeFilePanel, window.filePanelRelayout (views/file-panel.js).

// The drag payload type for a pane tab. It is a LAYOUT drag, so every other drop
// target has to be able to recognise and ignore it — the terminal container reads
// this too (`isPaneTabDrag` in terminal-manager.js), otherwise it would claim the
// drop and paste the payload into the shell.
const PANE_TAB_MIME = 'application/x-switchboard-pane-tab';

// The same, for a SESSION dragged out of the sidebar (#373). A second type rather than a second
// meaning for the first: the two are told apart by a `types` check that runs on every dragover, and a
// shared type would make "is this a tab already in my tree?" a question asked at drop time, when the
// answer decides whether a pane splits. `isPaneTabDrag` in terminal-manager.js ignores both, for the
// reason spelled out there — a drop that reaches a terminal types its payload at the CLI prompt.
const SESSION_DRAG_MIME = 'application/x-switchboard-session';

// The session being dragged, or null. The MIME says "this is ours"; `dataTransfer.getData` is empty
// until the drop in Chromium, so the id has to live somewhere the dragover can read it — and the drag
// starts in another file, so that somewhere is here rather than in a module's private state.
window.__sessionDragId = null;

(function () {
  if (typeof document === 'undefined') return; // node test context

  const STORE_KEY = 'paneTree';
  const ACTIVE_KEY = 'paneActiveLeaf';
  const PERSIST_DEBOUNCE_MS = 400;
  // Below this the tools would crowd out the tabs, so they fold into the `…` menu.
  // One rule for the whole group — collapsing icon by icon reads as a glitch.
  const TOOLS_MIN_PANE_WIDTH = 420;

  let enabled = false;
  let tree = null;               // PaneTree node, null while the mode is off
  let activeLeafId = null;
  // Where the session tools sit (#310): 'bar' gives them a row of their own under
  // the tab strip, with the session's name and id beside them; 'strip' folds them
  // into the tab strip to save the 33 px. Both show the same actions.
  let toolsPlacement = 'bar';
  // Set by a mode switch, consumed by the next adoption (#369) — see `adoptOrphans`.
  let pendingAdoptOrder = null;
  let closeBehavior = 'closeView';     // closeView | stopSession (agent sessions)
  let terminalCloseBehavior = 'kill';  // kill | keep (plain terminals)
  let middleClickCloses = true;
  // VS Code's `closeEmptyGroups`, off by default (#352) — see `focusPane` for why it hangs on the
  // active pane changing rather than on focus leaving the pane.
  let closeEmptyPanes = false;
  // Lines a pane tab keeps while it is NOT the one on screen (#352). 0 = off, which is the default —
  // see `applyBackgroundScrollback` for why that default is the opinion.
  let backgroundScrollback = 0;
  let persistTimer = 0;

  // A terminal tab's id is derived from its session, never generated: the same
  // session always maps to the same tab, so a reload rebinds the stored tree to
  // the reopened sessions without a lookup table.
  const tabIdFor = (sessionId) => 'term:' + sessionId;
  const sessionOfTab = (tab) => (tab && tab.kind === 'terminal' ? tab.ref : null);
  const makeTerminalTab = (sessionId) => ({ id: tabIdFor(sessionId), kind: 'terminal', ref: sessionId });

  // --- View tabs (#310) ------------------------------------------------------
  // Everything that is not a terminal. Each of these kinds is a SINGLE element
  // the app already owns and shows full-area in the other modes; here the tab
  // hosts that element inside its pane instead. One element means one tab per
  // kind in the whole tree — the tab moves to the pane you opened it from rather
  // than being duplicated, which is what the underlying view can actually do.
  // `display` is how the takeover viewers announce themselves: their show
  // functions set it (and hide the terminal area, which the CSS neutralises in
  // this mode), `hideAllViewers` clears it. Watching that one property adopts all
  // of them without editing a show path in every viewer file. The file panel is
  // the exception — it toggles a class and a width, so showPanel/hidePanel call in
  // directly (`watched: false`).
  // `close` names which teardown the tab's × runs, and it is the same distinction the viewers' own
  // header buttons already make: `data-close-admin` for the three surfaces a SIDEBAR TAB drives, and
  // `data-close-viewer` for the rest. Hiding an admin surface without switching the sidebar tab back
  // leaves the sidebar asserting a view that is no longer on screen (#342).
  //
  // Every one of these is an earlier sibling of `#terminal-area` inside `#main`, all `position:
  // absolute; inset: 0`, all shown by setting `display`. In tabs and grid mode they take over by
  // hiding `#terminal-area`; in panes mode `display: flex !important` keeps that area alive, so the
  // takeover is neutralised and DOM order decides — the pane tree, being the last child, paints over
  // them. Measured: opening Projects put a `pane-sash` on top of it, both at `z-index: auto`. Hence
  // every main-area surface belongs in this table, not just the session-shaped ones (#342).
  const VIEW_KINDS = {
    // Instanced kinds (#311): there is no single host element to move, because a pane owns its own
    // preview or diff. `file-panel.js` builds one instance per thing shown and hands over its root; this
    // side only asks. Hence no `hostId`, no home to park at, and a tab id that carries the `ref`.
    preview: { instanced: true, title: 'Preview', watched: false },
    diff: { instanced: true, title: 'Diff', watched: false },
    jsonl: { hostId: 'jsonl-viewer', title: 'Messages', watched: true },
    plan: { hostId: 'plan-viewer', title: 'Plan', watched: true, load: 'loadPlans' },
    stats: { hostId: 'stats-viewer', title: 'Activity', watched: true, close: 'admin', load: 'loadStats' },
    memory: { hostId: 'memory-viewer', title: 'Memory', watched: true, load: 'loadMemories' },
    projects: { hostId: 'projects-viewer', title: 'Projects', watched: true, close: 'admin', load: 'loadProjectsAdmin' },
    variables: { hostId: 'variables-admin-content', title: 'Variables', watched: true, close: 'admin', load: 'loadVariablesAdmin' },
    // The viewer survived the tab (#448): a work file still opens in its own panel, the one that can
    // delete. Its loader is the Agent Files one, because that is the list work files are drawn in now.
    workFiles: { hostId: 'work-files-viewer', title: 'Work files', watched: true, load: 'loadMemories' },
    // `settings` was here. It hosted the overlay element, and the overlay is gone (#365): settings
    // open in a window of their own, which is not a surface a pane can adopt.
    tasks: { hostId: 'tasks-viewer', title: 'Tasks', watched: true },
    bookmarks: { hostId: 'bookmarks-viewer', title: 'Bookmarks', watched: true },
    timeline: { hostId: 'timeline-viewer', title: 'Timeline', watched: true },
    // The recap of an absence (#402). Names NO loader on purpose, which is what stops `canLeaveWindow`
    // from handing it to another window: there must be exactly one of these across ALL windows, and a
    // second one is precisely what dragging its tab across would create.
    awayOverview: { hostId: 'away-overview-viewer', title: 'While you were away', watched: true },
  };
  const isInstancedKind = (kind) => !!(VIEW_KINDS[kind] && VIEW_KINDS[kind].instanced);
  // A singleton kind has one tab; an instanced one has a tab per thing it shows, so its id carries the
  // ref — the file path for a preview, the diff id for a diff.
  const viewTabId = (kind, ref) => (isInstancedKind(kind) ? 'view:' + kind + ':' + String(ref) : 'view:' + kind);
  const isViewTab = (tab) => !!(tab && VIEW_KINDS[tab.kind]);
  // Which views may leave this window (#364), DERIVED rather than listed — a kind may travel exactly
  // when the window receiving it can put something in it:
  //
  //   * it must be a SINGLETON. An instanced kind's host is looked up, never created
  //     (`filePanelHostFor` is a plain map read), so an arriving preview or diff finds no host and
  //     renders nothing — while the sender has already closed its own. A diff must not travel anyway:
  //     it owes the CLI an answer only its own renderer can give (§4.3 of spec 16), and stranding
  //     that hangs the caller until the bridge times out ten minutes later.
  //   * it must NAME A LOADER. That is what fills it on arrival; the sidebar does it on the way in
  //     locally, and a window that was sent a view has nobody to. Messages, Settings, Tasks,
  //     Bookmarks and Timeline have none — they are per-session or per-scope, so a zero-argument
  //     loader cannot even express what they should show — and they stay until they can say.
  //
  // Derived, so the rule cannot drift from the capability: give a kind a loader and it travels; the
  // first version of this listed exceptions instead and let five kinds through that arrive blank.
  const canLeaveWindow = (tab) => !!(isViewTab(tab)
    && !isInstancedKind(tab.kind)
    && VIEW_KINDS[tab.kind].load);
  const hostElementFor = (kind, ref) => (isInstancedKind(kind)
    ? (typeof window.filePanelHostFor === 'function' ? window.filePanelHostFor(kind, ref) : null)
    : document.getElementById(VIEW_KINDS[kind].hostId));

  // Where each view element came from, remembered the first time it is adopted.
  // Guessing a home is not good enough: #file-panel lives inside #terminal-split
  // (file-panel.js builds that container at startup), and putting it back one
  // level up leaves the side-panel layout with nothing to size.
  const viewHomes = new Map(); // kind → { parent, next }

  function rememberHome(kind, host) {
    if (viewHomes.has(kind) || !host.parentElement) return;
    viewHomes.set(kind, { parent: host.parentElement, next: host.nextElementSibling });
  }

  // --- Where a hosted view was scrolled to, across a rebuild (#458) ----------------------------
  //
  // Every render builds a fresh `pane-body` and moves the hosted elements into it, and a tab that is
  // not on top is additionally `display: none` (`.pane-hosted-hidden`). Both take the scroll offset:
  // an element out of the DOM has none to keep, and one without a layout box has nowhere to keep it.
  // So a preview scrolled to line 100 came back at line 1 on the next tab switch.
  //
  // Nothing ELSE about the view is lost — the document, the caret and unsaved edits live in CodeMirror
  // and survive the move untouched (measured: `ViewerPanel.open` is not called on this path). The
  // scroll is the one piece of the view that lives in the DOM, which is why it is the one piece that
  // has to be carried by hand.
  //
  // Keyed by ELEMENT, and a WeakMap so a closed tab's instance takes its entry with it: the elements
  // are moved rather than rebuilt, so the reference on the far side of a render is the same object.
  const hostedScroll = new WeakMap();   // host element → how to put it back

  /** Is this element laid out right now? A hidden one reports 0 and must not overwrite a real value. */
  const isLaidOut = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  /**
   * Every scrolled element inside a hosted view, as raw offsets.
   *
   * Raw DOM offsets, deliberately, and not CodeMirror's `scrollSnapshot()`. The snapshot restores a
   * position by DOCUMENT coordinates, which sounds like the better answer — but it restores what the
   * editor believes it is showing, and that belief is not what is being lost here. Measured: with a
   * scroller sitting at 2500px, dispatching the snapshot on the far side of a rebuild put it back at
   * 0. What disappears is a DOM property, so a DOM property is what gets carried.
   *
   * READ at render time rather than recorded from a `scroll` listener, which was the other candidate
   * and is cheaper on paper: an occluded window fires no scroll events at all (measured — a scroller
   * driven from 0 to 1800 produced not one, on the element itself or on any ancestor), so a listener
   * would have nothing to record precisely where a window has been sitting in the background. Reading
   * the offsets costs ~1.8 ms per render on a two-pane layout with a document open.
   *
   * The same walk covers every hosted kind — a preview and the plan viewer scroll their editor's
   * `.cm-scroller`, a review scrolls its `.fp-body` — without naming any of them.
   */
  function scrollStateOf(host) {
    const scrollers = [];
    if (host.scrollTop || host.scrollLeft) scrollers.push({ el: host, top: host.scrollTop, left: host.scrollLeft });
    for (const el of host.querySelectorAll('*')) {
      if (el.scrollTop || el.scrollLeft) scrollers.push({ el, top: el.scrollTop, left: el.scrollLeft });
    }
    return scrollers.length ? { scrollers } : null;
  }

  /** Remember every hosted element that is on screen right now, just before the rebuild takes it apart. */
  function captureHostedScroll() {
    for (const host of document.querySelectorAll('.pane-hosted')) {
      // A hidden host reports zeros. Leaving its previous entry in place is the point: that entry is
      // from the last time it WAS on screen, which is exactly what to restore when it returns.
      if (!isLaidOut(host)) continue;
      const state = scrollStateOf(host);
      if (state) hostedScroll.set(host, state);
      else hostedScroll.delete(host);                      // genuinely at the top now
    }
  }

  /** Put it back, for the hosts that are on screen again. */
  function restoreHostedScroll() {
    for (const host of document.querySelectorAll('.pane-hosted')) {
      const state = hostedScroll.get(host);
      if (!state || !isLaidOut(host)) continue;
      for (const { el, top, left } of state.scrollers) {
        if (!el.isConnected) continue;
        el.scrollTop = top;
        el.scrollLeft = left;
      }
      // And tell any editor in there to measure again. CodeMirror renders a WINDOW of the document
      // around where it believes it is scrolled to; moving its scroller from outside does not change
      // that belief, and the pane came back showing empty space above the lines it had already drawn.
      // Measured, and it is why setting the offset alone is not the fix.
      for (const dom of host.querySelectorAll('.cm-editor')) {
        const view = (window.CMEditorView && window.CMEditorView.findFromDOM)
          ? window.CMEditorView.findFromDOM(dom)
          : null;
        try { if (view) view.requestMeasure(); } catch { /* went away with its tab */ }
      }
    }
  }

  // Leaf ids are `pane-N`, N one past the highest in the tree — deterministic, so
  // nothing here needs a random source and the tests can predict every id.
  function nextLeafId() {
    let max = 0;
    for (const leaf of PaneTree.leaves(tree)) {
      const m = /^pane-(\d+)$/.exec(leaf.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return 'pane-' + (max + 1);
  }

  function activeLeaf() {
    if (!tree) return null;
    const found = PaneTree.leaves(tree).find((l) => l.id === activeLeafId);
    if (found) return found;
    const first = PaneTree.leaves(tree)[0] || null;
    activeLeafId = first ? first.id : null;
    return first;
  }

  // --- Persistence (#309 O8) ------------------------------------------------
  // localStorage, like gridLayout/gridViewActive next door. Sizes are fractions,
  // so a layout saved on a 4K screen restores sanely on a laptop.

  // The ONE writer of the layout key, guard included (#344). A detached window must not write THIS
  // key (#2): it shares this origin's localStorage with the main window, so writing here would
  // overwrite the user's arrangement with the single pane it happens to show. The guard belongs to
  // the key, not to one of its writers — `disable()` used to write past it, and a display-mode change
  // with a detached window open replaced a three-pane layout with one session, with no undo. Ask the
  // URL, not `__detachedSessionId`: that one follows the window's session set since #325 and is empty
  // between a handover and the window closing — long enough to write.
  //
  // It does keep an arrangement since #372 — in the MAIN PROCESS, beside the rest of what that window
  // holds (`reportWindowViews`), which is exactly the place this key is not.
  function writeTree() {
    if (window.isDetachedWindow && window.isDetachedWindow()) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(PaneTree.serialize(tree)));
      // Which pane was focused, beside the tree (#352). Only the tree was stored, so after every
      // reload the active pane was `leaves(tree)[0]` again — and "a sidebar click opens in the
      // active pane" quietly meant "in pane 1". Its own key: the tree's shape is the serialised
      // model and nothing else belongs inside it.
      if (activeLeafId) localStorage.setItem(ACTIVE_KEY, activeLeafId);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch { /* best effort */ }
  }

  function persist() {
    clearTimeout(persistTimer);
    // A sash drag fires dozens of updates per gesture; write once it settles.
    persistTimer = setTimeout(() => {
      writeTree();
      // The one place every tree change funnels through, so it is where a detached window's
      // arrangement is handed to main (#372) — the half `writeTree` refuses to keep for it.
      reportWindowViews();
    }, PERSIST_DEBOUNCE_MS);
  }

  // --- Undo, and saved layouts (#352) ---------------------------------------
  //
  // The stack holds SERIALISED trees, not live ones: `PaneTree` operations return new objects but the
  // leaves inside them are shared, so keeping a reference would be keeping a thing that later changes.
  //
  // Only ARRANGEMENT is undoable — a split, a pane closed, a resize, a tab moved between panes. Not a
  // closed tab, and not a stopped session: those are the process's business, and an "undo" that
  // relaunched a CLI would be a very different promise from the one this menu makes.
  //
  // Deliberately no keyboard shortcut. Ctrl+Z belongs to whatever is running in the terminal, and a
  // layout undo that stole it would be the more surprising of the two.
  const UNDO_DEPTH = 20;
  const PRESETS_KEY = 'panePresets';
  let undoStack = [];

  // Snapshot BEFORE a change, from the caller that is about to make one. Passing the tree in rather
  // than reading `tree` keeps this honest at the one call site that snapshots after a re-resolve.
  function pushUndo(before = tree) {
    if (!before) return;
    undoStack.push(PaneTree.serialize(before));
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  }

  function undoLayout() {
    if (!enabled || !undoStack.length) return false;
    const restored = PaneTree.deserialize(undoStack.pop(), 'pane-1');
    // Prune the same way a stored layout is pruned on load: a session that ended while the undone
    // arrangement was on screen has no tab to come back to, and a tab naming it would be a chip that
    // does nothing.
    tree = PaneTree.pruneTabs(restored, (tab) => (isViewTab(tab)
      ? PaneTree.leafOfTab(tree, tab.id) !== null
      : !!sessionOfTab(tab) && (sessionMap.has(sessionOfTab(tab)) || openSessions.has(sessionOfTab(tab)))),
    { keepEmptyPanes: true });
    activeLeaf();
    render();
    persist();
    showActiveOrPlaceholder();
    announcePane('Layout restored');
    return true;
  }

  function readPresets() {
    try {
      const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && p.tree) : [];
    } catch { return []; }
  }

  function writePresets(list) {
    // Same rule as the layout itself (#344): a detached window shares this origin's localStorage and
    // owns no arrangement, so it must not write one here either.
    if (window.isDetachedWindow && window.isDetachedWindow()) return;
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); } catch { /* best effort */ }
  }

  async function saveLayoutPreset() {
    if (!enabled || !tree || typeof showControlDialog !== 'function') return;
    const existing = readPresets();
    const name = await showControlDialog({
      title: 'Save layout',
      message: 'Saved layouts remember the panes and their sizes, and which sessions were in them.',
      prompt: { placeholder: 'Layout name', maxLength: 40 },
      confirmLabel: 'Save',
    });
    if (!name) return;
    const at = existing.findIndex((p) => p.name === name);
    const entry = { name, tree: PaneTree.serialize(tree) };
    // Saving over a name replaces it. Two entries with one name would be two menu items the user
    // cannot tell apart, and the second would be unreachable in every way that matters.
    if (at >= 0) existing[at] = entry; else existing.push(entry);
    writePresets(existing);
    if (typeof showControlToast === 'function') showControlToast({ message: `Layout “${name}” saved` });
  }

  function applyLayoutPreset(name) {
    const preset = readPresets().find((p) => p.name === name);
    if (!preset || !enabled) return;
    pushUndo();
    // A preset is a layout, not a session list: it names sessions that may be gone, and the ones that
    // are still here but not in it are adopted into the active pane by the normal path. Both halves
    // are `loadTree`'s rules, and applying them anywhere else would be a second answer to one question.
    const loaded = PaneTree.deserialize(preset.tree, 'pane-1');
    const withoutViews = PaneTree.pruneTabs(loaded, (tab) => !isViewTab(tab));
    tree = PaneTree.pruneTabs(withoutViews, (tab) => {
      const sid = sessionOfTab(tab);
      return !!sid && (sessionMap.has(sid) || openSessions.has(sid));
    });
    activeLeaf();
    render();
    persist();
    showActiveOrPlaceholder();
    announcePane(`Layout ${name} restored`);
  }

  function deleteLayoutPreset(name) {
    writePresets(readPresets().filter((p) => p.name !== name));
  }

  function loadTree() {
    // The detached window starts as one pane with one session (#2) — it reads the same localStorage
    // as the main window, so loading the stored tree would rebuild the whole arrangement over there,
    // panes and foreign tabs and all. Anything else it holds arrives through `adoptOrphans`.
    if (window.isDetachedWindow && window.isDetachedWindow()) {
      // …with the session it was opened for. A window opened on a VIEW, or one the last run left
      // behind, has none (#370) — and a tab built from that `null` was a real tab: nameless, 49 px
      // wide, nothing behind it, sitting beside the view and written into the saved layout so every
      // restore made it again (#379). An empty leaf is a shape the tree already has; the main
      // window reaches it whenever pruning takes the last tab.
      const own = window.__detachedSessionId;
      return PaneTree.createTree('pane-1', own ? [makeTerminalTab(own)] : []);
    }
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { stored = null; }
    const loaded = PaneTree.deserialize(stored, 'pane-1');
    // Prune against the SESSION LIST, never against what is mounted right now.
    // At startup the mode is applied before the launch restore has mounted a
    // single terminal, so pruning by `openSessions` threw the whole saved layout
    // away and every restored session then piled into one pane (#309).
    // A view tab is never restored: its element is empty until something opens a
    // file, a plan or a transcript into it, and a tab onto an empty view is
    // furniture. Terminals do come back — the session is still there.
    const withoutViews = PaneTree.pruneTabs(loaded, (tab) => !isViewTab(tab));
    if (typeof sessionMap === 'undefined' || sessionMap.size === 0) return withoutViews;
    return PaneTree.pruneTabs(withoutViews, (tab) => {
      const sid = sessionOfTab(tab);
      return !!sid && (sessionMap.has(sid) || openSessions.has(sid));
    });
  }

  // Every mounted session needs a home: one that has no tab yet lands in the
  // active pane. This is the single place where a session enters the tree, so
  // the launch restore, a sidebar click and the attention inbox all agree.
  function adoptOrphans() {
    // `openSessions` is mount order, which is the right answer for everything except a mode switch:
    // arriving out of grid, the tabs should read the way the cards did (#369). The switch hands that
    // order in; anything it does not name keeps its place at the end, so a session mounted in the
    // meantime is never dropped.
    let order = [...openSessions.keys()];
    if (pendingAdoptOrder) {
      const named = pendingAdoptOrder.filter((id) => openSessions.has(id));
      const seen = new Set(named);
      order = [...named, ...order.filter((id) => !seen.has(id))];
      pendingAdoptOrder = null; // one switch, one use
    }
    for (const sessionId of order) {
      if (!PaneTree.leafOfTab(tree, tabIdFor(sessionId))) {
        tree = PaneTree.addTab(tree, activeLeaf().id, makeTerminalTab(sessionId));
      }
    }
  }

  // --- Rendering ------------------------------------------------------------

  // The launch restore mounts N sessions one after another, each calling
  // showSession. Rebuilding the whole tree N times would move every container N
  // times; one rebuild per frame is enough and settles on the final state.
  // A microtask, NOT requestAnimationFrame: Chromium throttles rAF in a window
  // that is not visible, so a session mounted while the app sits behind another
  // window would keep its container in #terminals — outside every pane — until
  // something else forced a render. A microtask always runs.
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued || !enabled) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; render(); });
  }

  function render() {
    if (!enabled || !tree) return;
    // A rebuild replaces every sash, so a drag in flight has already lost the element it was
    // holding. End it here — before the tree is walked, so the size it dragged to is the one drawn
    // — instead of leaving the gesture and its `pane-sashing` body class behind (#345).
    if (endSashDrag) endSashDrag();
    // Same reasoning for an inline rename (#358): the rebuild below replaces every action bar, so an
    // open edit has already lost the element it was typed into. `refreshChrome` can step around one; a
    // full render cannot, because the tree itself changed. Committing rather than discarding — the text
    // is the user's, and the alternative is a sentence that vanishes when a tab opens somewhere.
    if (window.isSessionRenaming?.()) window.endSessionRename?.(true);
    adoptOrphans();
    // Before anything moves (#458). Both steps below take a hosted element out of the DOM, and a
    // scroll offset does not survive that — see `scrollStateOf` for why it is the only part of a
    // hosted view that has to be carried by hand.
    captureHostedScroll();
    // Park every view element at home first. The rebuild below re-adopts the ones
    // that still have a tab; anything left inside the old pane DOM would be
    // destroyed with it by replaceChildren — and these are singletons, so that
    // would take the app's only preview panel with it.
    releaseAllViewElements();
    const root = buildNode(tree, []);
    // The containers were moved into the fresh panes above, so what is left in
    // #terminals is the previous (now empty) pane scaffolding.
    terminalsEl.replaceChildren(root);
    // The zoom lives on the DOM, not in the tree, so a rebuild has to re-assert it — and drop it
    // when the pane it pointed at is no longer there (#350).
    applyZoom();
    // Same for the move mode's marker (#356). It must SURVIVE a rebuild rather than end on one: this
    // mode renders constantly — a status tick, a session adopted, a settings change — so a mode that
    // gave up on any render would be unusable in the running app, which is exactly how it behaved
    // when it was first driven. Grid states the same rule from the other side (`gridInteracting`).
    markMoveModePane();
    // A selection names tabs; a rebuild is where tabs disappear (#356). Prune first, then paint — a
    // count that includes a tab nobody can see is a count the user cannot explain.
    pruneTabSelection();
    refreshSelectionUi();
    // Flush BEFORE anything becomes visible (#337). A background tab's output is buffered in this
    // mode, and the coalescing buffer can hold up to two seconds of it. Once the element carries
    // `.visible`, that pending chunk takes the write path immediately — and the drain in
    // `refitVisible` then puts the OLDER backlog on top of it, so the terminal shows newer output
    // above older. Flushing while the session is still non-visible parks the chunk behind the
    // backlog instead, which is what the tabs and grid reveal paths already do.
    flushBeforeReveal();
    applyVisibility();
    // Drain SYNCHRONOUSLY, in the same task as the reveal. It used to ride along in `refitVisible`'s
    // deferred frame, which left a window between "the element is visible" and "the backlog is
    // written": any flush landing in it takes the write path (the session now counts as visible) and
    // the deferred drain then puts older data on top — the same inversion, only narrower. Chromium
    // throttles rAF in an occluded window, which is exactly where that window is widest.
    drainRevealed();
    applyWebglPolicy();
    refitVisible();
    // AFTER refitVisible (#458): a re-fit changes the height a hosted view is scrolled within, and a
    // position restored before it would be measured against the old one.
    restoreHostedScroll();
    updateStripChrome();
    // A detached window is named after the tab it is showing (#366). This is the one place every
    // layout and active-tab change funnels through — `setActiveSession` is not, because selecting a
    // tab whose session is not running never reaches it (see `openFromTab`). A no-op in the main
    // window, which titles itself.
    if (typeof window.updateDetachedWindowTitle === 'function') window.updateDetachedWindowTitle();
    // LAST, and it has to be last (#425). `show()` only schedules this render, so the caller's
    // `terminal.focus()` runs while the tree is still the old one — and the rebuild below it moves the
    // terminal's container into its pane. A focused element that is re-parented is blurred by the DOM,
    // so the caret ended up nowhere and typing went into the void. It "worked sometimes" precisely when
    // the node happened not to move: switching tabs inside the pane that already held it.
    //
    // Only a pending request focuses, never every render: a resize, a sash drag and a status repaint all
    // render too, and stealing the caret out of the search bar on those would be a worse bug than the one
    // this fixes.
    applyPendingFocus();
  }

  // The session whose terminal should hold the caret once this render has settled, or null.
  let pendingFocusSessionId = null;

  /** Ask for the caret after the next render — the only way to survive the re-parenting above. */
  function requestFocus(sessionId) {
    pendingFocusSessionId = sessionId || null;
  }

  function applyPendingFocus() {
    const sessionId = pendingFocusSessionId;
    pendingFocusSessionId = null;
    if (!sessionId) return;
    const entry = openSessions.get(sessionId);
    if (!entry || entry.closed) return;
    // Only if that session is still the one on top of its pane. Between the request and this render the
    // user may have clicked elsewhere, and a queued focus that fires anyway would drag them back.
    const leaf = PaneTree.leafOfTab(tree, tabIdFor(sessionId));
    if (!leaf || leaf.activeTabId !== tabIdFor(sessionId)) return;
    try { entry.terminal.focus(); } catch { /* disposed between the request and the render */ }
  }

  /** Write out each revealed pane's replay backlog. Runs right after `applyVisibility`. */
  function drainRevealed() {
    if (typeof drainReplayBuffer !== 'function') return;
    for (const leaf of PaneTree.leaves(tree)) {
      const sessionId = sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId));
      if (!sessionId || !openSessions.has(sessionId)) continue;
      try { drainReplayBuffer(sessionId); } catch { /* one bad session must not stop the rest */ }
    }
  }

  /**
   * Push each pane's pending coalesced chunk into its replay buffer while the session is still
   * non-visible, so the replay stays in order. Deliberately the ACTIVE tab of every leaf: those are
   * the ones `applyVisibility` is about to reveal.
   */
  function flushBeforeReveal() {
    if (typeof flushTerminalBuffer !== 'function') return;
    for (const leaf of PaneTree.leaves(tree)) {
      const sessionId = sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId));
      if (!sessionId || !openSessions.has(sessionId)) continue;
      try { flushTerminalBuffer(sessionId); } catch { /* one bad session must not stop the rest */ }
    }
  }

  function buildNode(node, path) {
    if (PaneTree.isLeaf(node)) return buildPane(node);

    const el = document.createElement('div');
    el.className = 'pane-branch pane-' + node.orientation;
    node.children.forEach((child, i) => {
      if (i > 0) el.appendChild(buildSash(node, path, i - 1));
      const childEl = buildNode(child, path.concat(i));
      // The long form, not `flex: <size> 1 0` — identical to the browser, and readable in a test.
      // jsdom drops the shorthand entirely (`style.flex` reads back as ''), so `layoutSignature` was
      // comparing empty strings and the size half of every layout assertion silently passed (#352).
      childEl.style.flexGrow = String(child.size);
      childEl.style.flexShrink = '1';
      childEl.style.flexBasis = '0';
      el.appendChild(childEl);
    });
    return el;
  }

  // How far one arrow press moves a sash, as a fraction of the branch. Coarse enough to get
  // somewhere, fine enough to land where you meant; Shift makes it a nudge.
  const SASH_KEY_STEP = 0.05;
  const SASH_KEY_STEP_FINE = 0.01;

  function buildSash(branch, path, index) {
    const sash = document.createElement('div');
    sash.className = 'pane-sash pane-sash-' + branch.orientation;
    sash.setAttribute('role', 'separator');
    sash.setAttribute('aria-orientation', branch.orientation === 'row' ? 'vertical' : 'horizontal');
    // The role was there already, on an element with no tabindex and no key handling — an ARIA
    // promise with nothing behind it (#351). Now it is focusable and it resizes, and it reports the
    // share of the pane before it so the number a screen reader hears is the one that changes.
    sash.tabIndex = 0;
    sash.setAttribute('aria-label', 'Resize panes');
    // A keyboard resize rebuilds the tree, which destroys this element — so it has to be findable
    // again afterwards, or the focus would land back at the top of the document on the first press.
    sash.dataset.sash = path.join('.') + ':' + index;
    const before = branch.children[index];
    if (before) {
      sash.setAttribute('aria-valuenow', String(Math.round(before.size * 100)));
      sash.setAttribute('aria-valuemin', String(Math.round(PaneTree.MIN_PANE_FRACTION * 100)));
      sash.setAttribute('aria-valuemax', String(100 - Math.round(PaneTree.MIN_PANE_FRACTION * 100)));
    }
    sash.addEventListener('pointerdown', (e) => startSashDrag(e, sash, path, index, branch.orientation));
    sash.addEventListener('keydown', (e) => handleSashKey(e, branch.orientation, path, index));
    // Double-click resets this branch, the gesture every tiling UI has and the pointer path did not
    // (#352) — the same reset Home already gives the keyboard, so there is one answer to "put it
    // back", not two. The drag that necessarily precedes the second click moves nothing: the pointer
    // has not travelled, so `startSashDrag` applies a zero delta.
    sash.addEventListener('dblclick', (e) => {
      e.preventDefault();
      resetBranchSizes(path, index);
    });
    return sash;
  }

  /**
   * Give every open session a pane of its own, in a grid the window's width decides (#356).
   *
   * Grid's counterpart is a MODE that arranges continuously; this is a command that produces an
   * arrangement the user then owns and edits like any other. That difference is the whole reason panes
   * can have it without becoming grid.
   *
   * It replaces what is there, and that is safe because "Undo layout change" (#352) is one click away —
   * a confirm dialog for something a single click reverses is a question nobody wants asked.
   *
   * Nothing is mounted here. Tiling arranges sessions that are ALREADY open, so grid's auto-open seam
   * (`attachRunningSession`, and the guard that keeps a detached session from being mounted twice) is
   * not on this path at all.
   */
  function tileAllSessions() {
    if (!enabled || !tree) return false;
    // Keep the order the user already sees: tabs in visual order first, then anything mounted that has
    // no tab yet. Re-sorting here would move sessions for no reason the user could name.
    const seen = new Set();
    const tabs = [];
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) {
        const sessionId = sessionOfTab(tab);
        // View tabs are dropped: a tiling is about sessions, and a pane holding only a preview would
        // be a pane the command invented for something the user did not ask to see.
        if (!sessionId || seen.has(sessionId)) continue;
        seen.add(sessionId);
        tabs.push(tab);
      }
    }
    for (const sessionId of openSessions.keys()) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      tabs.push(makeTerminalTab(sessionId));
    }
    if (!tabs.length) return false;

    const width = (terminalsEl && terminalsEl.clientWidth) || 0;
    const height = (terminalsEl && terminalsEl.clientHeight) || 0;
    // `calculateTileColumnCount`, NOT grid's own: grid scrolls, so width alone can constrain it, while
    // a pane tree shares one viewport and every pane takes height from the others. Measured on a
    // 1020 × 952 area, grid's formula answered "one column" for seven sessions — seven six-row
    // terminals. The shared module owns both formulas (#350, #354); this one just picks the right one.
    const columns = (typeof calculateTileColumnCount === 'function' && width && height)
      ? calculateTileColumnCount({ width, height, count: tabs.length })
      : Math.ceil(Math.sqrt(tabs.length));

    pushUndo();
    tree = PaneTree.tileTabs(tabs, columns);
    activeLeafId = PaneTree.leaves(tree)[0].id;
    zoomedLeafId = null; // a zoom points at a pane that no longer exists
    render();
    persist();
    showActiveOrPlaceholder();
    announcePane(`Tiled ${tabs.length} session${tabs.length === 1 ? '' : 's'} into ${columns} column${columns === 1 ? '' : 's'}`);
    return true;
  }

  function distributeAllPanes() {
    if (!enabled || !tree) return;
    pushUndo();
    tree = PaneTree.distributeAllEvenly(tree);
    render();
    persist();
    announcePane('Panes distributed evenly');
  }

  function resetBranchSizes(path, index) {
    pushUndo();
    tree = PaneTree.distributeEvenly(tree, path);
    render();
    persist();
    refocusSash(path, index);
    announcePane('Panes distributed evenly');
  }

  // Resize from the keyboard. Home distributes the branch evenly again, which is also the "reset"
  // the pointer path has never had.
  // Put the focus back on the sash the user is holding, after the rebuild took the element away.
  function refocusSash(path, index) {
    const key = path.join('.') + ':' + index;
    const el = terminalsEl.querySelector('.pane-sash[data-sash="' + key + '"]');
    if (el && typeof el.focus === 'function') el.focus();
  }

  function handleSashKey(e, orientation, path, index) {
    const back = orientation === 'row' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = orientation === 'row' ? 'ArrowRight' : 'ArrowDown';
    const step = e.shiftKey ? SASH_KEY_STEP_FINE : SASH_KEY_STEP;
    let delta = 0;
    if (e.key === back) delta = -step;
    else if (e.key === fwd) delta = step;
    else if (e.key === 'Home') {
      e.preventDefault();
      resetBranchSizes(path, index);
      return;
    } else return;
    e.preventDefault();
    tree = PaneTree.resizeSash(tree, path, index, delta);
    render();
    persist();
    refocusSash(path, index);
    const branch = PaneTree.nodeAt(tree, path);
    const size = branch && branch.children[index] ? Math.round(branch.children[index].size * 100) : null;
    if (size !== null) announcePane('Pane ' + (index + 1) + ', ' + size + ' percent');
  }


  function buildPane(leaf) {
    const pane = document.createElement('div');
    pane.className = 'pane' + (leaf.id === activeLeafId ? ' pane-active' : '');
    pane.dataset.paneId = leaf.id;

    pane.appendChild(buildStrip(leaf));
    if (toolsPlacement === 'bar') {
      const bar = buildActionBar(leaf);
      if (bar) pane.appendChild(bar);
    }

    const body = document.createElement('div');
    body.className = 'pane-body';
    // The panel the tab list controls (#351). Labelled by whichever tab is on top, so a screen
    // reader moving into the body is told what it is looking at.
    body.setAttribute('role', 'tabpanel');
    if (leaf.activeTabId) body.setAttribute('aria-labelledby', domTabId(leaf.id, leaf.activeTabId));
    // Whether the tab on top is showing a review. A dormant session draws the launch placeholder, and
    // the placeholder is built last — so it painted over an open review, at full size, with nothing
    // hidden and nothing thrown (#403). The review wins that rect while it is open.
    let activeReview = false;
    for (const tab of leaf.tabs) {
      if (isViewTab(tab)) {
        // The element follows its TAB, active or not — parked out of sight when
        // the pane shows something else. Leaving it behind on a switch would hand
        // it to the next replaceChildren.
        const host = hostElementFor(tab.kind, tab.ref);
        if (host) {
          // An instanced element has no home to go back to: it is created with its tab and destroyed
          // with it. Remembering one would send it to a slot that was never its.
          if (!isInstancedKind(tab.kind)) rememberHome(tab.kind, host);
          host.classList.add('pane-hosted');
          host.classList.toggle('pane-hosted-hidden', tab.id !== leaf.activeTabId);
          body.appendChild(host);
        }
        continue;
      }
      const sessionId = sessionOfTab(tab);
      // A review rides with its session's tab rather than taking one of its own (#398). It goes in
      // FIRST, so it sits above the terminal it is answered in — reading on top, deciding underneath,
      // which is the arrangement it always had; what it no longer has is a tab that promised a separate
      // surface and showed the same session.
      const review = typeof window.filePanelReviewHostFor === 'function'
        ? window.filePanelReviewHostFor(sessionId)
        : null;
      if (review) {
        review.classList.add('pane-hosted');
        review.classList.toggle('pane-hosted-hidden', tab.id !== leaf.activeTabId);
        body.appendChild(review);
        if (tab.id === leaf.activeTabId) activeReview = true;
      }
      const entry = openSessions.get(sessionId);
      if (entry) body.appendChild(entry.element); // moves the live container, xterm and all
    }
    // A tab whose session is not mounted is not an error: the saved layout
    // outlives the sessions in it, and the restore may not have reopened this
    // one. The tab stays, and clicking it opens the session into this pane.
    const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    const activeMounted = activeTab && (isViewTab(activeTab) || openSessions.has(sessionOfTab(activeTab)));
    // …and it is skipped entirely under an open review, rather than drawn beneath it: `.pane-empty` and
    // the review host are both absolutely positioned over the same rect, so a later sibling simply wins.
    // What brings the placeholder back is `closePanelTab` re-rendering when a review goes — including
    // the case where the review was not the session's shown entry, which is the branch that pairs with
    // this one. Without that pairing, skipping the placeholder here leaves the rect empty.
    if ((!leaf.tabs.length || !activeMounted) && !activeReview) {
      body.appendChild(buildEmptyState(leaf, activeTab));
    }
    // Clicking anywhere in a pane makes it the one a sidebar click fills (O7).
    body.addEventListener('mousedown', () => focusPane(leaf.id), true);
    pane.appendChild(body);

    wireDropZones(pane, body, leaf.id);
    return pane;
  }

  // What an empty pane says. Three states: no tabs at all, a tab whose session is
  // still running elsewhere (a click attaches it — nothing to warn about), and a tab
  // whose session has no process. The last one carries the Launch button, because
  // that is the only case where opening it spawns a CLI (#318) — the button says so
  // instead of a tab click doing it silently.
  // Which project a "New session" from an EMPTY pane belongs to. The pane names none, so the active
  // session's is the honest guess — that is the project the user is in. Prefer the entry from the
  // project list: a bare path is enough for the popover, but the entry carries the name the button's
  // tooltip shows.
  function emptyPaneProject() {
    const session = (typeof activeSessionId !== 'undefined' && activeSessionId)
      ? sessionOfId(activeSessionId) : null;
    const projectPath = session && session.projectPath;
    if (!projectPath) return null;
    for (const list of [
      typeof cachedProjects !== 'undefined' ? cachedProjects : [],
      typeof cachedAllProjects !== 'undefined' ? cachedAllProjects : [],
    ]) {
      const found = (list || []).find((p) => p && p.projectPath === projectPath);
      if (found) return found;
    }
    return { projectPath };
  }

  function buildEmptyState(leaf, activeTab) {
    const empty = document.createElement('div');
    empty.className = 'pane-empty';
    if (!leaf.tabs.length) {
      // A split leaves this pane behind, and until #352 the sentence was all it had — so the two
      // things a user does next (fill it, or decide against it) both meant going somewhere else.
      // Neither button acts on its own: nothing here starts a process or removes a pane without a
      // click, which is the whole reason an empty pane is not simply closed for them.
      const text = document.createElement('div');
      text.textContent = 'Pick a session in the sidebar to open it here.';
      empty.appendChild(text);
      const actions = document.createElement('div');
      actions.className = 'pane-empty-actions';
      // "New session" needs a project, and an empty pane has none — the active session's is the
      // honest guess, because that is the project the user is working in. With nothing active there
      // is nothing to guess from, and a button that can never be pressed is furniture, so it is left
      // out rather than shown disabled.
      const project = emptyPaneProject();
      if (project && typeof showNewSessionPopover === 'function') {
        const create = document.createElement('button');
        create.type = 'button';
        create.className = 'new-session-secondary-btn';
        create.textContent = 'New session';
        create.title = 'New session in ' + (project.name || project.projectPath || 'this project');
        create.addEventListener('click', (e) => {
          e.stopPropagation();
          focusPane(leaf.id); // …so the session it launches lands in THIS pane (#309 O7)
          showNewSessionPopover(project, create);
        });
        actions.appendChild(create);
      }
      if (PaneTree.leaves(tree).length > 1) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'new-session-secondary-btn';
        close.textContent = 'Close pane';
        close.addEventListener('click', (e) => { e.stopPropagation(); closePane(leaf.id); });
        actions.appendChild(close);
      }
      if (actions.childElementCount) empty.appendChild(actions);
      return empty;
    }
    const sessionId = sessionOfTab(activeTab);
    if (!sessionId || sessionIsLive(sessionId)) {
      empty.textContent = 'This session is not open — click its tab to open it here.';
      return empty;
    }
    const session = sessionMap.get(sessionId);
    const text = document.createElement('div');
    text.textContent = 'This session is not running. Launching it starts the CLI again; its history stays either way.';
    empty.appendChild(text);
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'new-session-secondary-btn pane-empty-launch';
    launch.textContent = 'Launch';
    launch.disabled = !session;
    launch.addEventListener('click', (e) => {
      e.stopPropagation();
      focusPane(leaf.id);
      if (session && typeof openSession === 'function') openSession(session, undefined, { show: true });
    });
    empty.appendChild(launch);
    return empty;
  }

  // --- Accessibility (#351) -------------------------------------------------
  //
  // The strip was a row of unlabelled divs: no `role`, no `aria-selected`, `tabIndex -1`, and 93
  // focusable elements across the panes — almost all of them the `×` on each tab. So tabbing handed
  // the user a destroy button for every tab and no way to select one.
  //
  // The model is VS Code's editor tabs, which is also what a screen reader user will already know:
  // `role="tablist"` over `role="tab"` with `aria-selected`, the pane body as the tab panel, and a
  // ROVING TABINDEX — the whole strip is ONE tab stop, and arrows move inside it. That is what turns
  // the `×` buttons from tab stops into what they are, buttons you reach deliberately.

  const paneLiveRegion = document.getElementById('pane-live-region');
  function announcePane(message) {
    if (paneLiveRegion) paneLiveRegion.textContent = message;
  }

  // A DOM id for a tab element, so the pane body can point at the one that labels it. Tab ids carry
  // a colon (`term:<uuid>`), which is legal in an id but awkward everywhere it is later selected.
  const domTabId = (leafId, tabId) => 'pt-' + leafId + '-' + String(tabId).replace(/[^a-zA-Z0-9_-]/g, '_');

  // What a screen reader hears for a tab: the name plus the state a sighted user reads from the dot
  // and the dimming. Without the state it would announce a dead session and a running one alike.
  function tabAccessibleName(leaf, tab) {
    const label = tabLabel(leaf, tab);
    if (isViewTab(tab)) return label + ', view';
    const sessionId = sessionOfTab(tab);
    if (!openSessions.has(sessionId)) return label + (hasExited(sessionId) ? ', exited' : ', not open');
    return label + (sessionIsLive(sessionId) ? ', running' : ', stopped');
  }

  // Move focus inside the strip. Roving tabindex: exactly one tab is reachable by Tab, and the
  // arrows move both the focus and which one that is. Focus does NOT activate — a screen reader user
  // has to be able to walk past a tab without opening every session on the way.
  function focusTabAt(list, index) {
    const tabs = [...list.querySelectorAll('.session-tab')];
    if (!tabs.length) return;
    const at = Math.max(0, Math.min(index, tabs.length - 1));
    for (const [i, el] of tabs.entries()) el.tabIndex = i === at ? 0 : -1;
    tabs[at].focus();
    if (typeof tabs[at].scrollIntoView === 'function') tabs[at].scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function wireStripKeys(list, leaf) {
    list.addEventListener('keydown', (e) => {
      const tabs = [...list.querySelectorAll('.session-tab')];
      const at = tabs.indexOf(e.target.closest ? e.target.closest('.session-tab') : null);
      if (at < 0) return;
      const tab = leaf.tabs[at];
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); focusTabAt(list, at - 1); return;
        case 'ArrowRight': e.preventDefault(); focusTabAt(list, at + 1); return;
        case 'Home': e.preventDefault(); focusTabAt(list, 0); return;
        case 'End': e.preventDefault(); focusTabAt(list, tabs.length - 1); return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!tab) return;
          if (isViewTab(tab)) {
            tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
            activeLeafId = leaf.id;
            render();
            persist();
          } else {
            openFromTab(leaf, tab, sessionOfId(sessionOfTab(tab)));
          }
          announcePane(tabAccessibleName(leaf, tab) + ', selected');
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (tab) { announcePane(tabLabel(leaf, tab) + ', closed'); closeTabFromUi(leaf.id, tab); }
          return;
        default:
          // Shift+F10 and the menu key are the keyboard's context menu, on the FOCUSED tab — the
          // `…` button reaches the pane's menu, never a particular tab's.
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            const r = tabs[at].getBoundingClientRect();
            openPaneMenu({ x: r.left, y: r.bottom }, leaf.id, tab);
          }
      }
    });
  }

  function stripCtrl(text, title, onClick) {
    const b = document.createElement('button');
    b.className = 'session-tabs-ctrl';
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function buildStrip(leaf) {
    const strip = document.createElement('div');
    strip.className = 'pane-strip';

    const list = document.createElement('div');
    list.className = 'session-tabs-list';
    // The strip IS a tab list (#351) — it just never said so.
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-orientation', 'horizontal');
    list.setAttribute('aria-label', 'Tabs in this pane');
    const runtime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
    for (const tab of leaf.tabs) list.appendChild(buildTab(leaf, tab, runtime));
    wireStripKeys(list, leaf);
    list.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) { list.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    strip.appendChild(list);

    // The overflow set tabs mode already has (#349). Without it a strip that overflows offers a
    // mouse wheel and nothing else, so a tab scrolled out of sight is unreachable by any other
    // means — no arrows, no scrollbar, no list. Hidden until the tabs actually overflow.
    const controls = document.createElement('div');
    controls.className = 'session-tabs-controls';
    controls.appendChild(stripCtrl('◀', 'Scroll tabs left', () => list.scrollBy({ left: -200, behavior: 'smooth' })));
    controls.appendChild(stripCtrl('▶', 'Scroll tabs right', () => list.scrollBy({ left: 200, behavior: 'smooth' })));
    const allBtn = stripCtrl('▾', 'All tabs in this pane', () => openTabListMenu(allBtn, leaf.id));
    controls.appendChild(allBtn);
    strip.appendChild(controls);

    if (toolsPlacement === 'strip') {
      strip.appendChild(buildTools(leaf));
      const sep = document.createElement('span');
      sep.className = 'pane-strip-sep';
      strip.appendChild(sep);
    }

    const more = document.createElement('button');
    more.className = 'session-tabs-ctrl pane-more-btn';
    more.type = 'button';
    more.textContent = '…';
    more.title = 'Pane actions';
    more.setAttribute('aria-label', 'Pane actions');
    more.addEventListener('click', (e) => { e.stopPropagation(); openPaneMenu({ anchor: more }, leaf.id); });
    strip.appendChild(more);

    strip.addEventListener('mousedown', () => focusPane(leaf.id), true);
    // Right-click on the strip itself (the tabs stop propagation and add their own
    // items) — the pane actions without aiming at the `…` button.
    strip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openPaneMenu({ x: e.clientX, y: e.clientY }, leaf.id);
    });
    return strip;
  }

  // Did this session have a process that has since ended? `launchExitedSessions` is
  // the renderer's marker for exactly that (#290), and it is cleared again the moment
  // a live PTY turns up under the id — so a tab restored from a saved layout, whose
  // session never ran in this run, is not "exited" and still opens on click.
  function hasExited(sessionId) {
    return typeof launchExitedSessions !== 'undefined' && launchExitedSessions.has(sessionId);
  }

  // Clicking a session tab. Three cases, and only the third can start a process:
  // mounted → show it; not mounted but the PTY is alive → attach to it; neither →
  // opening it would SPAWN a fresh CLI. A tab looks like a view, not a launcher, so
  // that last one only selects the tab and lets the pane offer a Launch button
  // (#318). Without that, clicking a dead tab to be rid of it starts the very thing
  // the user was done with.
  function openFromTab(leaf, tab, session) {
    activeLeafId = leaf.id;
    const sessionId = sessionOfTab(tab);
    if (openSessions.has(sessionId)) { focusPane(leaf.id); showSession(sessionId); return; }
    if (!session || typeof openSession !== 'function') return;
    if (!sessionIsLive(sessionId)) {
      focusPane(leaf.id);
      tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
      render();
      persist();
      return;
    }
    // It already has a tab in THIS pane, so show() finds that leaf and the session
    // lands where the layout says.
    openSession(session, undefined, { show: true });
  }

  function sessionIsLive(sessionId) {
    return typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId);
  }

  const sessionOfId = (sessionId) =>
    sessionMap.get(sessionId) || (openSessions.get(sessionId) || {}).session || null;

  // The name a tab shows before anything is done about duplicates.
  function tabBaseName(tab) {
    if (isViewTab(tab)) return viewTabLabel(tab);
    const sessionId = sessionOfTab(tab);
    const session = sessionOfId(sessionId);
    return (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) : '')
      || String(sessionId || '').slice(0, 8);
  }

  // The last segment of a session's project path — what tells two same-named sessions apart. The
  // splitter lives in session-tabs.js, so the tab label and the tooltip cannot disagree about what a
  // project is called (#334, #349).
  function projectLabelOf(session) {
    return (typeof projectTailOf === 'function') ? projectTailOf(session && session.projectPath) : '';
  }

  // What a tab is CALLED. Two sessions with the same name in one pane rendered as two identical
  // chips with nothing to tell them apart (#349), so a duplicate is qualified by its project folder
  // — the same answer VS Code gives for two open files with the same name. Only duplicates pay the
  // extra width.
  function tabLabel(leaf, tab) {
    const base = tabBaseName(tab);
    const clashes = leaf.tabs.some((t) => t !== tab && tabBaseName(t) === base);
    if (!clashes) return base;
    const qualifier = projectLabelOf(sessionOfId(sessionOfTab(tab)));
    return qualifier ? `${base} — ${qualifier}` : base;
  }

  // The `×` on a tab. NOT its own tab stop (#351): ninety-three focusable elements in the panes were
  // almost all of these, so Tab offered a destroy button per tab and no way to select one. It stays
  // clickable and stays labelled; the keyboard route to it is Delete on the focused tab.
  function buildTabClose(leaf, tab, name) {
    const close = document.createElement('button');
    close.className = 'session-tab-close';
    close.type = 'button';
    close.title = 'Close tab';
    close.textContent = '×';
    close.tabIndex = -1;
    close.setAttribute('aria-label', 'Close ' + name);
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTabFromUi(leaf.id, tab); });
    return close;
  }

  function buildTab(leaf, tab, runtime) {
    if (isViewTab(tab)) return buildViewTab(leaf, tab);
    const sessionId = sessionOfTab(tab);
    const session = sessionOfId(sessionId);
    const name = tabLabel(leaf, tab);

    const el = document.createElement('div');
    const isActive = tab.id === leaf.activeTabId;
    el.className = 'session-tab' + (isActive ? ' active' : '');
    el.dataset.sessionId = sessionId;
    el.dataset.tabId = tab.id;
    el.dataset.paneId = leaf.id;
    el.draggable = true;
    // Roving tabindex (#351): the active tab is the strip's single tab stop, the rest are reachable
    // with the arrows once focus is inside.
    el.id = domTabId(leaf.id, tab.id);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(isActive));
    el.tabIndex = isActive ? 0 : -1;
    el.setAttribute('aria-label', tabAccessibleName(leaf, tab));

    // Status dot: the sidebar's classes verbatim, so colour and motion cannot
    // drift between the three places that show it (#257, #269).
    const status = (session && typeof getSessionStatus === 'function') ? getSessionStatus(session, runtime) : null;
    if (status) el.classList.add(status.className);
    // The subagent overlay is set HERE as well as in patchStatuses (#500). `refreshChrome` rebuilds the
    // whole strip on every status edge and runs right after the patcher, so a class only the patcher
    // sets dies with the old node — the pulse was never visible for longer than a frame. The sidebar
    // never had this because its row builder sets it too (sidebar-session-row.js).
    if (typeof subagentActiveSessions !== 'undefined' && subagentActiveSessions.has(sessionId)) {
      el.classList.add('subagent-active');
    }
    // Project · backend · state beside the name (#334). Built by the same helper the tabs-mode strip
    // uses, so the two cannot drift on what a tooltip says.
    el.title = (session && typeof window.tabTooltipFor === 'function' && window.tabTooltipFor(session, status)) || name;
    const dot = document.createElement('span');
    dot.className = 'session-tab-dot status-dot' + (status ? ' ' + status.className : '');
    // No store record for this session, so the dot can never say working or idle (#460). Muted rather
    // than coloured, and the sentence rides in the tooltip `tabTooltipFor` already built above.
    if (typeof noStoreRecordFor === 'function' && noStoreRecordFor(sessionId)) dot.classList.add('status-unpaired');
    el.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = name;
    el.appendChild(label);

    const mounted = openSessions.has(sessionId);
    if (!mounted) el.classList.add(hasExited(sessionId) ? 'session-tab-exited' : 'session-tab-dormant');
    if (!mounted && hasExited(sessionId)) el.title += '\nThis session has exited.';

    el.appendChild(buildTabClose(leaf, tab, name));

    el.addEventListener('click', (e) => {
      // A modified click selects rather than opens (#356) — the same pair every file manager and
      // editor uses, so nothing here has to be taught.
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleTabSelection(leaf, tab); return; }
      if (e.shiftKey) { e.preventDefault(); extendTabSelection(leaf, tab); return; }
      // A plain click on a tab is how you leave a selection: it is what "no, that one" means.
      if (selectedTabIds.size) clearTabSelection();
      openFromTab(leaf, tab, session);
    });
    el.addEventListener('auxclick', (e) => {
      if (middleClickCloses && e.button === 1) { e.preventDefault(); closeSessionTab(sessionId); }
    });
    wireTabContextMenu(el, leaf.id, tab);
    wireTabDrag(el, leaf.id, tab.id);
    return el;
  }

  // Right-click on a tab: the tab's own actions plus the pane's (#312). Propagation
  // stops here so the strip's handler does not answer with the pane-only menu.
  function wireTabContextMenu(el, leafId, tab) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPaneMenu({ x: e.clientX, y: e.clientY }, leafId, tab);
    });
  }

  // A tab for one of the app's views (#310). No status dot — a view has no
  // process — and closing it hands the element back rather than tearing anything
  // down, so reopening the same file lands in the same place.
  function buildViewTab(leaf, tab) {
    const el = document.createElement('div');
    const isActive = tab.id === leaf.activeTabId;
    el.className = 'session-tab session-tab-view' + (isActive ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.dataset.paneId = leaf.id;
    el.draggable = true;
    el.id = domTabId(leaf.id, tab.id);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(isActive));
    el.tabIndex = isActive ? 0 : -1;
    el.setAttribute('aria-label', tabAccessibleName(leaf, tab));

    // The same box a session tab's status dot occupies, carrying no state (#364). A view has no
    // process, so there is nothing to report — but leaving the slot out shifted every view tab's
    // label left of every session tab's, and the two sit side by side in one strip. The marker is
    // `session-tab-dot` without a status class: the shared sizing, none of the colour or motion.
    const dot = document.createElement('span');
    dot.className = 'session-tab-dot session-tab-dot-none';
    el.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = viewTabLabel(tab);
    el.title = label.textContent;
    el.appendChild(label);

    el.appendChild(buildTabClose(leaf, tab, label.textContent));

    el.addEventListener('click', () => {
      activeLeafId = leaf.id;
      tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
      render();
      persist();
    });
    wireTabContextMenu(el, leaf.id, tab);
    wireTabDrag(el, leaf.id, tab.id);
    return el;
  }

  // What a view tab is called. The view itself knows best (the file it shows, the
  // session whose transcript it is); the kind's own title is the fallback.
  function viewTabLabel(tab) {
    const spec = VIEW_KINDS[tab.kind];
    if (isInstancedKind(tab.kind) && typeof window.filePanelTabLabel === 'function') {
      return window.filePanelTabLabel(tab.kind, tab.ref) || spec.title;
    }
    return spec.title;
  }

  // Open (or re-target) the tab for a view. One tab per kind: the element is a
  // singleton, so the tab moves to the pane you opened it from instead of being
  // cloned into a second one. `nearSessionId` names the session it belongs to, so
  // the view lands beside the terminal that produced it.
  /**
   * Every view tab this window holds, with the file each one is showing.
   *
   * Instanced kinds are in the list too, which they were not when this only answered routing (#364).
   * They still steer themselves — a preview and a diff carry their own ref — but two of the three
   * questions main asks the list are about the WINDOW rather than the kind: whether it still has
   * something to show once its last session leaves (#370), and what it has to be given back when it
   * is restored (#371). A window holding nothing but a preview holds something.
   */
  function collectWindowViews() {
    const out = [];
    if (!enabled || !tree) return out;
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) {
        if (!isViewTab(tab)) continue;
        out.push({
          kind: tab.kind,
          ref: tab.ref == null ? null : tab.ref,
          // The open file, for the kinds that have one. A singleton has no ref to carry it in, so
          // without this a restored or relayed view arrives blank — which reads as half a move.
          file: (typeof currentViewFilePayload === 'function') ? currentViewFilePayload(tab.kind) : null,
        });
      }
    }
    return out;
  }

  /**
   * Tell main which of the app's own views this window is showing (#364, #370, #371).
   *
   * Reported, never inferred — main guessing from what it last sent is exactly the stale registry
   * this is meant not to become. The WHOLE list every time, rather than a per-kind delta: a delta is
   * a thing that can be missed, and one missed message leaves a window claiming a view it closed for
   * as long as it lives. Deriving the list from the tree also means no path can forget to report a
   * tab it removed — it only has to report *after* it changed the tree.
   *
   * `views` overrides that derivation for the one caller whose tree outlives its mode: leaving panes
   * mode takes every view tab with it while the tree is still standing.
   */
  function reportWindowViews(views) {
    if (typeof window.api?.windowViewsChanged !== 'function') return;
    // The ARRANGEMENT travels with it, from a detached window only (#372). That window owns no
    // localStorage layout on purpose — it shares the key with the main window and would overwrite the
    // user's own (#344) — so main is the only place its splits can be kept. The main window has its
    // key and sends nothing here; a tree per persist through IPC is not free.
    const detached = !!(window.isDetachedWindow && window.isDetachedWindow());
    const layout = (detached && enabled && tree)
      ? { tree: PaneTree.serialize(tree), activeLeafId: activeLeafId || null }
      : null;
    try { window.api.windowViewsChanged(views || collectWindowViews(), layout); } catch { /* older main */ }
  }

  /**
   * Put back the arrangement a restored window had when the app quit (#372).
   *
   * Applied BEFORE its sessions and views are put back, so each one lands in the pane it was in:
   * `openViewTab` and the mount both look for an existing tab first, and the layout is what puts
   * those tabs there. The other order works too, but it draws the window twice — once piled into one
   * pane, once rearranged — which reads as the restore correcting a mistake.
   *
   * Pruned on the way in, against the same two rules the rest of the restore obeys: a session that is
   * no longer in the index cannot come back, and neither can a view this window could not fill. What
   * is left can be empty, and then the layout is declined rather than applied — a window of empty
   * panes is worse than the single pane it would have had.
   */
  function applyRestoredLayout(serialized, activeId) {
    if (!enabled || !serialized) return false;
    const loaded = PaneTree.pruneTabs(PaneTree.deserialize(serialized, 'pane-1'), (tab) => {
      if (isViewTab(tab)) return canLeaveWindow(tab);
      const sid = sessionOfTab(tab);
      if (!sid) return false;
      return typeof sessionMap === 'undefined' || sessionMap.has(sid) || openSessions.has(sid);
    });
    if (!PaneTree.leaves(loaded).some((leaf) => leaf.tabs.length)) return false;
    tree = loaded;
    if (activeId && PaneTree.leaves(tree).some((leaf) => leaf.id === activeId)) activeLeafId = activeId;
    activeLeaf();
    render();
    return true;
  }

  function openViewTab(kind, { ref = null, nearSessionId = null, load = false } = {}) {
    if (!enabled || !VIEW_KINDS[kind]) return false;
    // `load` fills the view with its content (#364). The sidebar does this itself on the way in —
    // it is what "opening" one of these means there — but a view arriving from another window has
    // nobody to do it, and this window's element has never been filled. Without it the tab arrives
    // showing an empty panel, which reads as the move having half worked. Named on the kind rather
    // than branched on here, so a new view declares its own loader in one place.
    if (load && VIEW_KINDS[kind].load) {
      const fill = window[VIEW_KINDS[kind].load];
      if (typeof fill === 'function') { try { fill(); } catch { /* an empty view beats a dead tab */ } }
    }
    const tabId = viewTabId(kind, ref);
    const existing = PaneTree.leafOfTab(tree, tabId);
    const target = (nearSessionId && PaneTree.leafOfTab(tree, tabIdFor(nearSessionId))) || activeLeaf();
    if (!target) return false;

    if (existing) {
      // Stay where the user put it. Re-opening the same view (a session switch
      // re-asserts its file panel) must not drag the tab back out of the pane it
      // was dropped into — the drag would be undone by the next click.
      tree = PaneTree.setActiveTab(tree, existing.id, tabId);
      activeLeafId = existing.id;
      render();
      persist();
      return true;
    }
    tree = PaneTree.addTab(tree, target.id, { id: tabId, kind, ref });
    activeLeafId = target.id;
    reportWindowViews(); // #364 — a sidebar click for this kind now belongs here
    render();
    persist();
    return true;
  }

  // `closeTheView` says WHO is closing. The user clicking the tab's × wants the view itself told to
  // close; the observer calling this because the element was hidden must not tell it anything — the
  // app has already done it, and repeating the app's own close route here is actively wrong for the
  // sidebar-driven surfaces: switching from Projects to Variables hides Projects, and answering that
  // with `closeAdminView()` sent the sidebar back to the previous tab and undid the switch (#342).
  function closeViewTab(kind, { ref = null, closeTheView = false, cameFrom = null } = {}) {
    if (!enabled) return;
    const tabId = viewTabId(kind, ref);
    const leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) return;
    releaseViewElement(kind, ref);
    // Where to go back to (#388). A preview or a diff is always opened FROM a session, so that
    // session's tab is what closing it should reveal. `PaneTree.closeTab` picks the neighbour by
    // position — right for a terminal tab, and for a file it lands on whatever happened to sit next to
    // it. Asked BEFORE the instance is destroyed, because that is what forgets the answer.
    // A caller that already knows wins over the lookup, because the caller may be the reason the lookup
    // can no longer answer: the file panel's own close removes its entry before telling us (#421).
    const returnTo = cameFrom
      || (isInstancedKind(kind) ? (window.filePanelSessionFor?.(kind, ref) || null) : null);
    // An instanced view is destroyed, not hidden — its owner answers an unresolved diff on the way out.
    if (closeTheView && isInstancedKind(kind)) window.filePanelCloseInstance?.(kind, ref);
    else if (closeTheView) hideViewElement(kind);
    tree = PaneTree.closeTab(tree, leaf.id, tabId);
    // …and only if that session is still a tab in the SAME pane. Reaching into another pane would move
    // the user's focus somewhere they were not looking, which is the complaint one step on.
    if (returnTo) {
      const back = PaneTree.leafOfTab(tree, tabIdFor(returnTo));
      if (back && back.id === leaf.id) tree = PaneTree.setActiveTab(tree, back.id, tabIdFor(returnTo));
    }
    reportWindowViews(); // #364 — nothing here shows it any more
    activeLeaf();
    render();
    persist();
    showActiveOrPlaceholder();
  }

  // Put a view element back where the HTML had it. Every other display mode looks
  // for it there, so leaving it inside a pane would take the view with the pane.
  function releaseViewElement(kind, ref) {
    if (isInstancedKind(kind)) return; // nothing to put back — see `hostElementFor`
    const host = hostElementFor(kind, ref);
    const home = viewHomes.get(kind);
    if (!host || !home || !home.parent) return;
    host.classList.remove('pane-hosted', 'pane-hosted-hidden');
    if (host.parentElement === home.parent) return;
    // Back to the exact slot, not just the right parent: the side-panel layout is
    // a flex row, so the resize handle has to stay between the terminals and it.
    if (home.next && home.next.parentElement === home.parent) home.parent.insertBefore(host, home.next);
    else home.parent.appendChild(host);
  }

  function releaseAllViewElements() {
    for (const kind of Object.keys(VIEW_KINDS)) if (!isInstancedKind(kind)) releaseViewElement(kind);
  }

  // Closing the TAB has to close the VIEW. These four are shown by setting
  // `display` (that is also how panes-view learns about them), and nothing else
  // resets it on this path: without it the element goes home still visible and,
  // being `position:absolute; inset:0` in #main, covers the whole workspace with
  // no tab left to close it. `preview` is not here — it routes through the file
  // panel's own close, which owns its visibility.
  function hideViewElement(kind) {
    const spec = VIEW_KINDS[kind];
    if (isInstancedKind(kind)) return;
    const host = hostElementFor(kind);
    if (!spec || !spec.watched || !host) return;
    // A surface a sidebar tab drives has to close the way its own × does — through the tab (#342).
    // `hideAllViewers` would hide the element and leave the sidebar sitting on the tab that opened
    // it, asserting a view the user can no longer see. It also does not know
    // `variables-admin-content` at all.
    if (spec.close === 'admin' && typeof closeAdminView === 'function') { closeAdminView(); return; }
    // Otherwise through the app's own teardown: hideAllViewers also puts the terminal
    // area back and drains the transcript's file watches (#75), which setting `display`
    // alone would leave polling. Only one of these can be open at a time, so hiding all
    // of them costs nothing.
    if (typeof hideAllViewers === 'function') hideAllViewers();
    else host.style.display = 'none';
  }

  // --- Adopting the takeover viewers ----------------------------------------
  // One observer instead of a branch inside every viewer's show function: a
  // viewer that becomes visible gets a tab in the pane its session belongs to,
  // and one that hides again loses it. The viewers keep their own logic; all this
  // changes is where the element is on screen.

  let viewObserver = null;

  function startViewWatch() {
    if (viewObserver) return;
    viewObserver = new MutationObserver((records) => {
      if (!enabled) return;
      for (const rec of records) {
        const kind = watchedKindOf(rec.target);
        if (!kind) continue;
        const visible = rec.target.style.display !== 'none';
        const hasTab = !!PaneTree.leafOfTab(tree, viewTabId(kind, null));
        if (visible && !hasTab) {
          openViewTab(kind, {
            ref: activeSessionId || null,
            nearSessionId: activeSessionId || null,
          });
        } else if (!visible && hasTab) {
          closeViewTab(kind);
        }
      }
    });
    for (const [kind, spec] of Object.entries(VIEW_KINDS)) {
      if (!spec.watched) continue;
      const el = hostElementFor(kind);
      if (!el) continue;
      viewObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
      // An observer reports future mutations only. A viewer that was already open
      // when the mode was switched on would otherwise never be adopted and would
      // sit over the pane tree as an unmanaged overlay.
      if (el.style.display !== 'none' && el.style.display !== '') {
        openViewTab(kind, { ref: activeSessionId || null, nearSessionId: activeSessionId || null });
      }
    }
    // The file panel announces itself through a class, not `display`, so the loop
    // above cannot see it. Open in the previous mode means: still a fixed side
    // strip, squeezing the pane tree, with no tab — the one layout this mode is
    // supposed to end.
    const panel = document.getElementById('file-panel');
    if (panel && panel.classList.contains('open')) {
      panel.style.width = '';
      // Whatever it holds becomes a pane tab — since #311 that can be several things at once, and only
      // the file panel knows what they are.
      window.filePanelReopenInPanes?.();
    }
  }

  function stopViewWatch() {
    if (!viewObserver) return;
    viewObserver.disconnect();
    viewObserver = null;
  }

  function watchedKindOf(el) {
    for (const [kind, spec] of Object.entries(VIEW_KINDS)) {
      if (spec.watched && el && el.id === spec.hostId) return kind;
    }
    return null;
  }

  // The session tools of the pane's ACTIVE tab (#309 O13/H2). Same actions as the
  // singleton header they replace here, wired to this pane's session rather than
  // to `activeSessionId` — that is the whole point of moving them in.
  function buildTools(leaf) {
    const tools = document.createElement('div');
    tools.className = 'pane-tools';
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    const sessionId = sessionOfTab(tab);
    if (!sessionId) return tools;
    const session = sessionMap.get(sessionId) || (openSessions.get(sessionId) || {}).session || null;

    const btn = (title, svg, onClick) => {
      const b = document.createElement('button');
      b.className = 'session-tabs-ctrl pane-tool-btn';
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = svg;
      b.addEventListener('click', (e) => { e.stopPropagation(); focusPane(leaf.id); onClick(); });
      return b;
    };

    tools.appendChild(btn('View messages',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',
      () => { if (session && typeof showJsonlViewer === 'function') showJsonlViewer(session); }));

    tools.appendChild(btn('Tasks for this session',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
      () => {
        if (!session || typeof openTasksView !== 'function') return;
        openTasksView({ sessionId }, 'Session · ' + (session.name || session.aiTitle || session.summary || sessionId));
      }));

    const varsBtn = btn('Saved variables',
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M12 12l8.5-8.5"/><path d="M16 8l2 2"/><path d="M18.5 5.5l2 2"/></svg>',
      () => {
        window.showVariablesQuickPick?.({
          sessionId,
          projectPath: (session && session.projectPath) || null,
          running: activePtyIds.has(sessionId),
          anchor: varsBtn,
        });
      });
    tools.appendChild(varsBtn);

    // No IDE-emulation chip here (#321). It only ever appeared when the bridge was
    // ACTIVE — never a visible "off" — so the state worth knowing about was the one
    // it stayed silent for. It is a global setting, so with four panes it drew four
    // identical marks, and it toggles nothing where it stands. The single
    // `#terminal-header` chip keeps it for the other display modes.

    if (activePtyIds.has(sessionId)) {
      tools.appendChild(btn('Stop process',
        '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>',
        () => { if (typeof confirmAndStopSession === 'function') confirmAndStopSession(sessionId); }))
        .classList.add('pane-tool-stop');
    }
    return tools;
  }

  // The session's own bar under the tab strip (#310, variant H1): what the single
  // `#terminal-header` shows in the other modes, per pane and for the pane's
  // active session. Nothing to show for a view tab — a preview has no process.
  function buildActionBar(leaf) {
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    const sessionId = sessionOfTab(tab);
    const entry = sessionId ? openSessions.get(sessionId) : null;
    if (!sessionId) return null;
    const session = sessionMap.get(sessionId) || (entry || {}).session || null;

    const bar = document.createElement('div');
    bar.className = 'pane-actionbar';
    // The pane's own chrome answers a right-click with the pane actions, same as the
    // strip (#312). Under the default `paneToolsPlacement: bar` this row is most of
    // what the pane shows above its terminal, so leaving it out would mean aiming at
    // the thin strip to get a menu the bar is sitting right under.
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openPaneMenu({ x: e.clientX, y: e.clientY }, leaf.id);
    });

    const info = document.createElement('div');
    info.className = 'pane-actionbar-info';

    // The status dot leads the name, the way it does in the sidebar row and on the
    // tab (#321/#14). It belongs to the session, not to the actions — sitting among
    // the tool buttons it read as one more thing to click, and it was the only place
    // in the app where this signal was on the right.
    const running = activePtyIds.has(sessionId);
    const status = document.createElement('span');
    status.className = 'pane-status ' + (running ? 'running' : 'stopped');
    status.title = running ? 'Running' : 'Stopped';
    status.setAttribute('role', 'img');
    status.setAttribute('aria-label', status.title);
    info.appendChild(status);

    // The name, and after it the project — nothing twice (#358). What the row used to spell out beside
    // it (the terminal's own title, which is usually the same sentence again, and the full session id)
    // is in the tooltip, built by the same helper the tabs-mode header uses.
    const name = document.createElement('span');
    name.className = 'pane-actionbar-name';
    name.textContent = (typeof cleanDisplayName === 'function'
      ? cleanDisplayName(session && (session.name || session.aiTitle || session.summary)) : '') || sessionId;
    const barStatus = (session && typeof getSessionStatus === 'function')
      ? getSessionStatus(session, (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {})
      : null;
    const barTooltip = (session && typeof window.sessionBarTooltipFor === 'function')
      ? window.sessionBarTooltipFor(session, barStatus, entry && entry.ptyTitle) : '';
    name.title = [barTooltip || name.textContent, 'Click to rename'].filter(Boolean).join('\n');
    // Renaming here renames the session, not the pane: the same call the header makes, so an empty name
    // means the same thing in both places (back to following the AI title). `stopPropagation` keeps the
    // click from also reaching the row's own handlers.
    // `mousedown`, not `click`. Focusing a pane that is not the active one routes through `showSession`
    // → `panesView.show` → `scheduleRender`, and that render runs in a microtask — i.e. between mousedown
    // and click. A click whose mousedown target has since left the document never reaches that node's
    // listener, so on a background pane the first click only focused it and a second was needed to rename.
    name.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // middle/right belong to the row's own gestures
      focusPane(leaf.id);
      // Let the render the focus may have queued settle, then take the element that exists NOW — the one
      // this closure captured is the one the rebuild just threw away.
      queueMicrotask(() => {
        const fresh = terminalsEl.querySelector(
          '.pane[data-pane-id="' + leaf.id + '"] .pane-actionbar-name');
        if (fresh && typeof window.startSessionRename === 'function') {
          window.startSessionRename(fresh, sessionId);
        }
      });
    });
    info.appendChild(name);

    const projectLabel = (session && typeof window.sessionProjectLabel === 'function')
      ? window.sessionProjectLabel(session) : '';
    if (projectLabel) {
      const project = document.createElement('span');
      project.className = 'pane-actionbar-project';
      project.textContent = projectLabel;
      project.title = (session && session.projectPath) || projectLabel;
      info.appendChild(project);
    }

    bar.appendChild(info);
    bar.appendChild(buildTools(leaf));
    bar.addEventListener('mousedown', () => focusPane(leaf.id), true);
    return bar;
  }

  // Fold the tools away in a pane too narrow to carry them (they stay reachable
  // in the `…` menu). Measured after layout, so it survives a sash drag too.
  function updateToolsOverflow() {
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      pane.classList.toggle('pane-narrow', pane.clientWidth > 0 && pane.clientWidth < TOOLS_MIN_PANE_WIDTH);
    }
  }

  // Show the scroll arrows and the tab list only when the tabs actually overflow — the same test
  // tabs mode makes, so a pane with three tabs does not grow chrome it has no use for.
  function updateStripOverflow() {
    for (const strip of terminalsEl.querySelectorAll('.pane-strip')) {
      const list = strip.querySelector('.session-tabs-list');
      const controls = strip.querySelector('.session-tabs-controls');
      if (!list || !controls) continue;
      controls.classList.toggle('visible', list.scrollWidth > list.clientWidth + 1);
    }
  }

  // Bring each pane's active tab into view (#349). A strip holding 25 tabs showed the first sixteen
  // with nothing highlighted, and the only thing on screen naming the session you had just clicked
  // was the action bar. Runs after a rebuild — which is also what resets the scroll offset, so this
  // never fights a position the user still has.
  function revealActiveTabs() {
    for (const list of terminalsEl.querySelectorAll('.pane-strip .session-tabs-list')) {
      const active = list.querySelector('.session-tab.active');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
    }
  }

  // The three things every strip rebuild has to settle. One name, so a new render path cannot pick
  // up two of them and quietly miss the third.
  function updateStripChrome() {
    updateToolsOverflow();
    updateStripOverflow();
    revealActiveTabs();
  }

  // --- Visibility + fit -----------------------------------------------------

  function applyVisibility() {
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) {
        const entry = openSessions.get(sessionOfTab(tab));
        if (!entry) continue;
        const visible = tab.id === leaf.activeTabId;
        entry.element.classList.toggle('visible', visible);
        applyBackgroundScrollback(entry, visible);
      }
    }
  }

  /**
   * Shrink a background tab's scrollback, if the user asked for it (#352).
   *
   * OFF by default, and the default is the opinion: grid can trim its cards because a card is a
   * PREVIEW, while a background pane tab is a session the user is coming back to — and xterm cannot
   * restore lines a shrunk buffer dropped, so the trim is permanent the moment the tab loses focus.
   * Trading someone's history for memory without asking is the wrong way round.
   *
   * What it does buy, for whoever does ask: a 10 000-line buffer is roughly 3 MB per terminal, so a
   * window holding twenty background tabs is carrying ~60 MB of scrollback nobody is reading.
   *
   * Raising it back on reveal is free — the budget grows, and what was already dropped stays dropped.
   */
  function applyBackgroundScrollback(entry, visible) {
    if (!backgroundScrollback || !entry.terminal || !entry.terminal.options) return;
    const full = (typeof SCROLLBACK_SINGLE !== 'undefined') ? SCROLLBACK_SINGLE : 10000;
    const want = visible ? full : Math.min(backgroundScrollback, full);
    if (entry.terminal.options.scrollback !== want) entry.terminal.options.scrollback = want;
  }

  // Every terminal goes back to the full budget when the mode ends — leaving a shrunk buffer behind
  // would apply a panes-mode setting to tabs and grid, which have their own answers.
  function restoreScrollbackBudgets() {
    if (!backgroundScrollback) return;
    const full = (typeof SCROLLBACK_SINGLE !== 'undefined') ? SCROLLBACK_SINGLE : 10000;
    for (const entry of openSessions.values()) {
      if (entry && entry.terminal && entry.terminal.options) entry.terminal.options.scrollback = full;
    }
  }

  // Every terminal in the layout renders the same way — all WebGL, or all DOM (#320).
  //
  // This used to follow the focused pane, inherited from the grid (#140). Panes put
  // two full-height terminals side by side, and there the two renderers do not agree
  // on the cell box: at devicePixelRatio 2 the measured cell was 8.000 px under
  // WebGL and 8.2065 px under DOM, so the unfocused pane drew visibly heavier and
  // sat a line off. A renderer split you can see is worse than either renderer.
  //
  // …and with more than one terminal on screen, that renderer is the DOM one.
  //
  // #320 first gave every pane WebGL, on a measurement: two panes on WebGL, ~18 000
  // distinct codepoints flooded through each to recycle the shared atlas several
  // times over — no corruption. That measurement was too short. In daily use, two
  // terminals rendering ALTERNATELY over minutes, each with its own glyph set, do
  // reproduce #118: one recycles the atlas while the other has already read its
  // coordinates, and characters go missing until something repaints. The atlas
  // contention is real; only the context churn was fixed.
  //
  // So: one terminal on screen → WebGL, several → all DOM. Both failures this mode
  // has seen are gone in that state — no shared atlas to fight over, and no metric
  // split, since the split needs two renderers at once.
  //
  // What decides is how many terminals are VISIBLE AT ONCE — one per pane. Two tabs
  // in one pane are the tabs-mode case, where the atlas is shared too but only one
  // terminal is on screen and the reveal repaint (#118) heals it. Two panes have no
  // such moment: both are on screen, and the one nobody touched keeps the holes.
  //
  // The policy then applies to every mounted terminal, background tabs included —
  // they stay painted so a tab switch does not reflow (#20), so their contexts would
  // recycle the atlas under the visible ones.

  function applyWebglPolicy() {
    const mounted = [];
    let visible = 0;
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) {
        const sessionId = sessionOfTab(tab);
        const entry = sessionId ? openSessions.get(sessionId) : null;
        if (!entry) continue;
        const active = tab.id === leaf.activeTabId;
        if (active) visible++;
        mounted.push({ leafId: leaf.id, sessionId, entry, active });
      }
    }
    const wantGl = visible <= 1;
    for (const { sessionId, entry } of mounted) {
      // Only ACT on a difference. Recreating the addon on every render (a status
      // tick, a tab click) tore down and rebuilt the GL context each time and left
      // orphaned canvases stacked in the container, until the terminal painted
      // nothing at all.
      if (wantGl && !entry.webglAddon && typeof restoreTerminalWebgl === 'function') restoreTerminalWebgl(sessionId);
      else if (!wantGl && entry.webglAddon && typeof suspendTerminalWebgl === 'function') suspendTerminalWebgl(sessionId);
    }
    // A load can refuse — the setting is off, or WebGL gave up after repeated
    // context losses. Then some panes have GL and some do not, which is the split
    // this policy exists to prevent, so the ones that got it give it back.
    if (wantGl && mounted.some((m) => !m.entry.webglAddon)) {
      for (const { sessionId, entry } of mounted) {
        if (entry.webglAddon && typeof suspendTerminalWebgl === 'function') suspendTerminalWebgl(sessionId);
      }
      return;
    }
    // The active terminal just changed parent, and a moved WebGL canvas keeps a
    // texture atlas another terminal may have grown meanwhile (#118).
    const active = mounted.find((m) => m.leafId === activeLeafId && m.active);
    if (active && active.entry.webglAddon && typeof forceRepaint === 'function') forceRepaint(active.entry);
  }

  // Run `fn` after the layout has settled, in a window that may not be VISIBLE.
  //
  // Chromium does not fire `requestAnimationFrame` in a hidden or occluded window, and this file
  // already says so about `scheduleRender` — the fit that follows the render was left on a bare rAF
  // anyway. Measured with `document.hidden === true`: a pane zoomed to a 1043 px box kept a terminal
  // at 8 columns for six seconds and counting, because the frame never came. A TUI then wraps its
  // prompt at a width the box does not have, which looks exactly like text arriving with line breaks
  // nobody typed. Same family as #81 and #322.
  //
  // So: a frame if one comes, a timer if it does not, whichever is first — a fit needs measured
  // layout, so a microtask (what `scheduleRender` uses) would run too early.
  const HIDDEN_FRAME_MS = 32; // ~2 frames; only ever used when rAF is not running
  function afterLayout(fn) {
    let done = false;
    const run = () => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(run, HIDDEN_FRAME_MS);
    requestAnimationFrame(run);
  }

  // One pending pass at a time (#352). A window resize fires several events per frame and each one
  // used to queue a full pass over every visible pane — flush, drain and `safeFit` each — so a drag
  // of the window border ran the most expensive thing in this file dozens of times for one final
  // size. Coalescing is safe because the pass reads the layout as it is when it runs, not as it was
  // when it was asked for.
  let refitPending = false;
  function refitVisible() {
    if (refitPending) return;
    refitPending = true;
    afterLayout(() => {
      refitPending = false;
      for (const leaf of PaneTree.leaves(tree)) {
        const sessionId = sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId));
        const entry = sessionId ? openSessions.get(sessionId) : null;
        if (!entry) continue;
        // One terminal that cannot be fitted (disposed mid-frame, zero-sized box)
        // must not take the other panes' fits — or the chrome pass below — with it.
        try {
          // The flush that matters for ORDER happened before `applyVisibility` (#337). This one is
          // for the paths that reach here without a rebuild — a window resize, a sash drag — where
          // the session is already visible and a flush writes straight through. It must stay ahead of
          // the drain either way: with a pending chunk and a backlog both present, writing the chunk
          // second would show newer output above older.
          if (typeof flushTerminalBuffer === 'function') flushTerminalBuffer(sessionId);
          if (typeof drainReplayBuffer === 'function') drainReplayBuffer(sessionId);
          if (typeof safeFit === 'function') safeFit(entry);
        } catch { /* keep fitting the rest */ }
      }
      // A second pass: the fit above can change the pane's own metrics, and the fold-away threshold
      // has to see the settled width, not the one mid-reflow. Same scheduler, same reason.
      afterLayout(updateStripChrome);
    });
  }

  // --- Actions --------------------------------------------------------------

  /**
   * VS Code's `closeEmptyGroups`, off by default here (#352). `leftId` is the pane that was active
   * until a moment ago; it goes if it holds nothing.
   *
   * It hangs on the ACTIVE PANE changing and on nothing else, which is the whole care this needs: the
   * ordinary way to fill a fresh pane is to click a session in the sidebar, and that is a focus change
   * in the DOM but not a change of active pane — a rule written on document focus would close the pane
   * between the split and the click that was about to use it.
   *
   * Both routes that move the active pane call this: `focusPane` (a click on a pane, the keyboard) and
   * `show` (a sidebar click landing in the pane that already holds that session). Only wiring the
   * first left the setting doing nothing on the path people actually take.
   */
  function dropEmptyPaneLeft(leftId) {
    if (!closeEmptyPanes || !leftId || leftId === activeLeafId) return;
    const leaving = PaneTree.leaves(tree).find((l) => l.id === leftId);
    if (!leaving || leaving.tabs.length || PaneTree.leaves(tree).length === 1) return;
    tree = PaneTree.removeLeaf(tree, leftId);
    render();
    persist();
  }

  function focusPane(leafId) {
    if (!enabled || leafId === activeLeafId) return;
    if (!PaneTree.leaves(tree).some((l) => l.id === leafId)) return;
    const leaving = activeLeafId;
    activeLeafId = leafId;
    dropEmptyPaneLeft(leaving);
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      pane.classList.toggle('pane-active', pane.dataset.paneId === leafId);
    }
    // Focus follows the pane: the session shown there becomes the active one, so
    // the sidebar highlight and every activeSessionId-scoped action line up.
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const sessionId = leaf ? sessionOfTab(leaf.tabs.find((t) => t.id === leaf.activeTabId)) : null;
    if (sessionId && openSessions.has(sessionId) && sessionId !== activeSessionId) showSession(sessionId);
    // Since #320 the renderer no longer follows the focus — every pane has the same
    // one — so this is only here for the atlas repaint of the pane that just came
    // forward, and for the case a pane gained a mounted session without a rebuild.
    applyWebglPolicy();
    persist();
  }

  function splitActivePane(direction) {
    if (!enabled) return;
    const leaf = activeLeaf();
    if (!leaf) return;
    const newLeafId = nextLeafId();
    pushUndo();
    // A split while zoomed would put the new pane behind the zoomed one, where nothing points at it.
    zoomedLeafId = null;
    // The new pane starts EMPTY and takes focus: a terminal cannot be shown twice
    // (one PTY, one container), so there is nothing to duplicate into it. The next
    // sidebar click fills it, which is exactly what O7 promises.
    tree = PaneTree.splitLeaf(tree, leaf.id, direction, { newLeafId });
    activeLeafId = newLeafId;
    render();
    persist();
  }

  // Does closing this session's tab end its process? A plain terminal follows
  // `terminalCloseBehavior`, an agent session `tabCloseBehavior`. ONE reader for the decision,
  // because closing a pane has to answer it exactly as closing each of its tabs would (#347) — it
  // used to skip the question entirely and orphan every process in the pane, which is the opposite
  // of what the × on those same tabs does.
  function closeStopsProcess(sessionId) {
    const entry = openSessions.get(sessionId);
    if (!entry) return false;
    const isTerminal = !!(entry.session && entry.session.type === 'terminal');
    return isTerminal ? (terminalCloseBehavior === 'kill') : (closeBehavior === 'stopSession');
  }

  // Ask before a pane close ends processes — once, naming how many, not once per session. A pane
  // with nothing running must not gain a click, so this is only reached when something would stop.
  function confirmClosePane(stopping, keeping) {
    if (typeof showControlDialog !== 'function') return Promise.resolve(true);
    const what = stopping === 1 ? 'one running process' : `${stopping} running processes`;
    return showControlDialog({
      title: 'Close pane',
      message: keeping
        ? `Closing this pane stops ${what}. ${keeping === 1 ? 'One other session' : `${keeping} other sessions`} keep running.`
        : `Closing this pane stops ${what}.`,
      confirmLabel: 'Close pane',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
  }

  async function closePane(leafId) {
    let leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf) return;
    if (PaneTree.leaves(tree).length === 1) return; // the last pane stays

    // What this is about to do to the processes in the pane, decided before anything is torn down.
    const live = leaf.tabs.map(sessionOfTab).filter((id) => id && openSessions.has(id) && sessionIsLive(id));
    const stopping = live.filter(closeStopsProcess);
    if (stopping.length && !(await confirmClosePane(stopping.length, live.length - stopping.length))) return;
    // Re-resolve after the await. Every PaneTree operation returns a NEW tree, so `leaf` is a
    // snapshot: a session that exited while the dialog was open took its tab out of the real tree
    // and left it in this copy. Re-reading also settles a second click on the same pane — by then
    // the pane is gone and there is nothing left to close.
    leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf || PaneTree.leaves(tree).length === 1) return;
    // Snapshot for undo BEFORE the tabs go. Each `destroySession` below calls back into
    // `dropSession`, and the pane collapses the moment its last tab leaves — so a snapshot taken
    // further down would already be missing the pane this is about to remove (#352).
    pushUndo();
    // …and the answer about the processes has to come from the tree that is actually being closed.
    const keeping = leaf.tabs.map(sessionOfTab)
      .filter((id) => id && openSessions.has(id) && sessionIsLive(id) && !closeStopsProcess(id));

    // A session's own tab closing keeps its PTY or stops it depending on the settings; the pane
    // close now says the same thing. destroySession() calls back into dropSession(), which is what
    // takes each tab out of the tree — so this loop must not remove them a second time.
    for (const tab of leaf.tabs.slice()) {
      // A view tab in this pane loses its tab with the pane, so its view has to be
      // closed too — otherwise the element goes home still visible and covers the
      // workspace with nothing left to dismiss it.
      if (isViewTab(tab)) {
        // An instanced view is destroyed with its tab (#311); a singleton is hidden, so it goes home
        // invisible instead of covering the workspace with nothing left to dismiss it.
        if (isInstancedKind(tab.kind)) window.filePanelCloseInstance?.(tab.kind, tab.ref);
        else hideViewElement(tab.kind);
        continue;
      }
      const sessionId = sessionOfTab(tab);
      if (!sessionId) continue;
      // The pane going takes each session's review surface with it (#398) — same rule as closing one
      // tab, and unanswered here means a CLI blocked on a question nothing can show any more.
      window.filePanelCloseSessionReviews?.(sessionId);
      if (closeStopsProcess(sessionId)) { try { window.api.stopSession(sessionId); } catch { /* already gone */ } }
      if (typeof destroySession === 'function') destroySession(sessionId);
    }
    // Say what is still out there. Without this the sessions the settings deliberately keep alive
    // leave no trace on screen at all — the pane that pointed at them is what just went away.
    if (keeping.length && typeof showControlToast === 'function') {
      showControlToast({
        message: keeping.length === 1
          ? 'Pane closed — its session keeps running.'
          : `Pane closed — ${keeping.length} of its sessions keep running.`,
      });
    }
    // An empty pane is left behind when it had no tabs to begin with, or when the
    // last dropSession collapsed nothing because the pane was already the target.
    tree = PaneTree.removeLeaf(tree, leafId);
    // This path does not go through `closeViewTab`, so the report is made here (#364) — after the
    // pane is out of the tree, since the list is derived from it. A registry entry left behind sends
    // a sidebar pick at a window that no longer shows the view, and nothing about that is visible
    // until the click lands nowhere.
    reportWindowViews();
    activeLeaf();
    render();
    persist();
    showActiveOrPlaceholder();
  }

  // --- Moving a whole pane (#340) -------------------------------------------

  /**
   * Which of a pane's tabs can change window, and which cannot.
   *
   * Only terminal tabs travel, and the reason a view tab does not is not a gap waiting to be closed.
   * A singleton kind IS the app's one element of that kind — there is nothing to hand over, only
   * something to take away from this window. An instanced preview or diff (#311) is built by THIS
   * window's file-panel.js, and a diff additionally holds an MCP `tools/call` that only this renderer
   * can answer. So they stay where they are, and the action says so before it runs.
   */
  function splitPaneTabsForMove(leaf) {
    const moving = [];
    const views = [];
    const staying = [];
    for (const tab of leaf.tabs) {
      const sessionId = sessionOfTab(tab);
      if (sessionId) moving.push(sessionId);
      // A view travels now (#364) — it used to be left behind, so moving "the whole pane" quietly
      // moved only part of it. It goes AFTER the sessions, because the window it goes to is the one
      // the first session created. A diff still stays, and is still named before anything moves.
      else if (canLeaveWindow(tab)) views.push(tab);
      else staying.push(tab);
    }
    return { moving, views, staying };
  }

  // Can this pane be moved at all? A pane with nothing but view tabs has nothing that could travel,
  // and an entry that silently does nothing is the failure the requirement names.
  function paneCanMove(leaf) {
    return !!leaf && leaf.tabs.some((t) => !!sessionOfTab(t));
  }

  // Name what stays before the move runs, not after. Only reached when something would be left
  // behind — a pane of pure terminal tabs moves whole, and asking about that would be noise.
  function confirmMovePane(moving, staying, toMain) {
    if (typeof showControlDialog !== 'function') return Promise.resolve(true);
    const sessions = moving === 1 ? 'One session' : `${moving} sessions`;
    const names = staying.map(viewTabLabel).join(', ');
    const stays = staying.length === 1 ? `${names} stays` : `${names} stay`;
    return showControlDialog({
      title: 'Move pane',
      message: `${sessions} ${moving === 1 ? 'moves' : 'move'} to ${toMain ? 'the main window' : 'a new window'}. `
        + `${stays} in this pane — a view belongs to the window it was opened in.`,
      confirmLabel: moving === 1 ? 'Move session' : 'Move sessions',
      cancelLabel: 'Cancel',
    });
  }

  /**
   * Move every session in this pane into a window of its own — or back to the main window, which is
   * the only direction that exists from a detached one (`detachSession` lives in the main window's
   * half of detach-window.js, exactly as `appendWindowItems` offers "Return to main window" there).
   *
   * The first session is what CREATES the window; every one after it follows by window id, which is
   * why `detach-session` answers with one. The target needs nothing else: `loadTree` gives a detached
   * window a single pane and `adoptOrphans` puts each arrival into it, so a pane of N tabs arrives as
   * a pane of N tabs. A move landing while that window is still booting is caught by its
   * `adoptOwnedSessions` (#326, #331), and a dormant session travels like any other (#332).
   */
  async function movePaneToWindow(leafId) {
    if (!enabled || !tree) return false;
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf) return false;
    // Snapshot before the first await. Each release takes its tab out of the tree, so the leaf read
    // here is a stale copy the moment the first session lands elsewhere — the rule `closePane`
    // follows, for the same reason.
    const { moving, views, staying } = splitPaneTabsForMove(leaf);
    if (!moving.length) return false;
    const toMain = !!(window.isDetachedWindow && window.isDetachedWindow());
    if (staying.length && !(await confirmMovePane(moving.length, staying, toMain))) return false;

    let targetId = 'main';
    if (!toMain) {
      targetId = typeof window.detachSession === 'function' ? await window.detachSession(moving[0]) : null;
      // `detachSession` has already put the reason on screen; nothing moved, so there is nothing to
      // undo either.
      if (!targetId) return false;
    }
    for (const sessionId of toMain ? moving : moving.slice(1)) {
      // Stop at the first refusal rather than firing the rest at a window that just declined one.
      // What has moved stays moved: the sessions still here are the ones the user can see, and a
      // rollback would be a second round of moves with the same failure modes.
      const ok = typeof window.moveSessionToWindow === 'function'
        && await window.moveSessionToWindow(sessionId, targetId);
      if (!ok) break;
    }
    // The views follow the sessions into the same window (#364). After them, so the window exists and
    // has finished booting by the time a view is delivered to it.
    for (const tab of views) await moveViewToWindow(leafId, tab, targetId);
    // The pane's own sessions left through `releaseSession` → `dropSession`, which takes each tab out
    // and collapses a pane left empty (#309 O10). What is left on screen still has to be settled.
    showActiveOrPlaceholder();
    return true;
  }

  // Remove a tab from the layout without touching its session (a dormant tab).
  function dropTab(leafId, tabId) {
    tree = PaneTree.closeTab(tree, leafId, tabId);
    activeLeaf();
    render();
    persist();
    // Every other close path ends here; this one did not (#352). Dropping the last dormant tab of
    // the active pane left the main area showing whatever the closed tab had been in front of.
    showActiveOrPlaceholder();
  }

  // Close one session's tab. Mirrors tabs mode: the view goes, the PTY survives —
  // unless the close behaviour says otherwise for this kind of session.
  function closeSessionTab(sessionId) {
    // A review rides with this tab (#398), so closing the tab takes its surface away. Nothing else can
    // reach it afterwards — answer it here, or its CLI waits out the full timeout for a question the
    // user can no longer see. Before the teardown, because the CLI is blocked while it happens.
    window.filePanelCloseSessionReviews?.(sessionId);
    if (closeStopsProcess(sessionId)) { try { window.api.stopSession(sessionId); } catch { /* ignore */ } }
    if (typeof destroySession === 'function') destroySession(sessionId); // → dropSession()
    showActiveOrPlaceholder();
  }

  // After a close: show whatever the active pane now holds, or fall back to the
  // placeholder so the main area is never left blank.
  function showActiveOrPlaceholder() {
    const leaf = activeLeaf();
    const tabs = leaf ? leaf.tabs : [];
    const onTop = tabs.find((t) => t.id === leaf.activeTabId);
    const sessionId = sessionOfTab(onTop);
    if (sessionId && openSessions.has(sessionId)) { showSession(sessionId); return; }
    // A VIEW is on top of this pane. Clearing the active session here would look
    // harmless and is not: the file panel follows the active session, so clearing
    // it closes the panel — and with it the very preview tab that is on top (#310).
    // Keep the session; only a pane with nothing live in it falls back to the
    // placeholder.
    //
    // Two questions, and asking only the second one was a hole (#340): "is a view on top" is about
    // the TAB, and the check below is about the session that happens to be active. They agree while
    // that session survives, and part company the moment it does not — moving a pane's sessions to
    // another window leaves exactly that state, and the view tab the move promised to leave alone was
    // taken down by `clearActiveTerminalView` → `hideAllViewers` → the watcher's close route.
    if (isViewTab(onTop)) return;
    if (typeof activeSessionId !== 'undefined' && activeSessionId && openSessions.has(activeSessionId)) return;
    const fallback = tabs.map(sessionOfTab).find((id) => id && openSessions.has(id));
    if (fallback) showSession(fallback);
    else if (typeof window.clearActiveTerminalView === 'function') window.clearActiveTerminalView();
  }

  // --- Pane menu (#309 O6/A) ------------------------------------------------

  let activeMenu = null;
  let menuDismissHandlers = null;
  // Take the document listeners down with the menu. Leaving them to remove
  // themselves only works on the paths they detect — clicking an item closes the
  // menu directly, and the pair would linger for the rest of the session.
  function closePaneMenu() {
    if (menuDismissHandlers) {
      document.removeEventListener('mousedown', menuDismissHandlers.out, true);
      document.removeEventListener('keydown', menuDismissHandlers.esc, true);
      menuDismissHandlers = null;
    }
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }

  // Closing a tab from the UI — the × and the context menu take the same path, so a
  // view still gets told to close itself and a dormant session still leaves the
  // layout without touching anything live.
  function closeTabFromUi(leafId, tab) {
    if (isViewTab(tab)) {
      // Tell the VIEW to close, not just the layout: it owns the state that decides
      // whether it reappears, and a tab-only close would be undone by the next
      // session switch. Its own close path comes back through closeViewTab.
      closeViewTab(tab.kind, { ref: tab.ref, closeTheView: true });
      return;
    }
    const sessionId = sessionOfTab(tab);
    // Nothing to tear down for a tab whose session was never mounted — drop it from
    // the layout and leave the session alone.
    if (!openSessions.has(sessionId)) { dropTab(leafId, tab.id); return; }
    closeSessionTab(sessionId);
  }

  // Ask once before a bulk close ends processes, the way `confirmClosePane` does for a pane. Its own
  // wording, because this is about tabs and not about a pane, but the same counting.
  function confirmCloseTabs(stopping) {
    if (typeof showControlDialog !== 'function') return Promise.resolve(true);
    const what = stopping === 1 ? 'one running process' : `${stopping} running processes`;
    return showControlDialog({
      title: 'Close tabs',
      message: `Closing these tabs stops ${what}.`,
      confirmLabel: 'Close tabs',
      cancelLabel: 'Cancel',
      tone: 'danger',
    });
  }

  // Close a SET of tabs as one action (#349). Emptying a full pane used to be one click per tab on a
  // 12-px `×`. One question for the whole set, then each tab down the path its own `×` takes, so the
  // configured close behaviour still decides per session.
  async function closeTabs(tabs) {
    const live = tabs.map(sessionOfTab).filter((id) => id && openSessions.has(id) && sessionIsLive(id));
    const stopping = live.filter(closeStopsProcess);
    if (stopping.length && !(await confirmCloseTabs(stopping.length))) return;
    for (const tab of tabs) {
      // Re-read the owner each time: closing one tab can move or remove others (a pane collapses, an
      // exiting session drops its own tab), so a leaf id captured up front goes stale mid-loop.
      const owner = PaneTree.leafOfTab(tree, tab.id);
      if (!owner) continue;
      closeTabFromUi(owner.id, tab);
    }
  }

  // The tab half of the context menu. A view tab has no process, so it gets Close
  // and nothing else.
  function addTabItems(item, leafId, tab) {
    item('Close', () => closeTabFromUi(leafId, tab));
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const siblings = leaf ? leaf.tabs : [];
    const at = siblings.findIndex((t) => t.id === tab.id);
    const others = siblings.filter((t) => t.id !== tab.id);
    const toRight = at >= 0 ? siblings.slice(at + 1) : [];
    item('Close others', () => closeTabs(others), { disabled: !others.length });
    item('Close to the right', () => closeTabs(toRight), { disabled: !toRight.length });
    item('Close all', () => closeTabs(siblings.slice()), { disabled: !siblings.length });
    if (isViewTab(tab)) return;
    const sessionId = sessionOfTab(tab);
    item('Stop & close', () => {
      try { window.api.stopSession(sessionId); } catch { /* already gone */ }
      closeTabFromUi(leafId, tab);
    }, { danger: true, disabled: !activePtyIds.has(sessionId) });
    item('Relaunch', () => window.relaunchSession(sessionId), {
      disabled: typeof window.relaunchSession !== 'function',
    });
  }

  // Every tab in this pane, filterable — the panes counterpart of the "All open tabs" list in tabs
  // mode (#349). With a strip that overflows this is the only way to reach a tab that scrolled off.
  function openTabListMenu(anchor, leafId) {
    closePaneMenu();
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    if (!leaf) return;
    focusPane(leafId);

    const pop = document.createElement('div');
    pop.className = 'popover session-tabs-overflow';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-tabs-overflow-filter';
    input.placeholder = 'Filter tabs in this pane…';
    const listEl = document.createElement('div');
    listEl.className = 'session-tabs-overflow-list';
    pop.appendChild(input);
    pop.appendChild(listEl);

    const renderList = () => {
      const q = input.value.trim().toLowerCase();
      listEl.replaceChildren();
      for (const tab of leaf.tabs) {
        const label = tabLabel(leaf, tab);
        if (q && !label.toLowerCase().includes(q)) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'session-tabs-overflow-item' + (tab.id === leaf.activeTabId ? ' active' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          closePaneMenu();
          if (isViewTab(tab)) {
            tree = PaneTree.setActiveTab(tree, leaf.id, tab.id);
            activeLeafId = leaf.id;
            render();
            persist();
            return;
          }
          openFromTab(leaf, tab, sessionOfId(sessionOfTab(tab)));
        });
        listEl.appendChild(b);
      }
    };
    input.addEventListener('input', renderList);
    renderList();

    document.body.appendChild(pop);
    positionPaneMenu(pop, { anchor });
    activeMenu = pop;
    input.focus();
    armMenuDismiss(pop);
  }

  // Under the `…` button, or at the cursor for a right-click — clamped into the
  // viewport either way.
  function positionPaneMenu(pop, at) {
    pop.style.position = 'fixed';
    if (at && at.anchor) {
      const r = at.anchor.getBoundingClientRect();
      pop.style.top = (r.bottom + 4) + 'px';
      pop.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
      return;
    }
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(at.x, window.innerWidth - rect.width - 4)) + 'px';
    pop.style.top = Math.max(4, Math.min(at.y, window.innerHeight - rect.height - 4)) + 'px';
  }

  // The `…` button and a right-click show the same menu (#312). The button is the
  // discoverable entry point, the right-click the fast one, so neither may grow
  // items the other lacks — both come through here. `tab` is the tab that was
  // right-clicked; without one the menu is the pane's alone.
  function openPaneMenu(at, leafId, tab = null) {
    closePaneMenu();
    const pop = document.createElement('div');
    pop.className = 'popover session-tab-menu';
    const item = (label, handler, opts = {}) => {
      const b = document.createElement('button');
      b.className = 'session-tab-menu-item' + (opts.danger ? ' danger' : '');
      b.type = 'button';
      b.textContent = label;
      if (opts.disabled) b.disabled = true;
      // The event goes through to the handler: one entry (a saved layout, #352) means a different
      // thing with Shift held, and a second listener could not do it — listeners on the SAME element
      // run in registration order regardless of phase, so this one would always have fired first.
      else b.addEventListener('click', (e) => { closePaneMenu(); handler(e); });
      // `before` is for items that arrive late (the window list, #316) and still belong next to the
      // entry they extend, rather than after the destructive one at the bottom.
      if (opts.before && opts.before.parentElement === pop) pop.insertBefore(b, opts.before);
      else pop.appendChild(b);
      return b;
    };
    const separator = () => {
      const s = document.createElement('div');
      s.className = 'session-tab-menu-sep';
      pop.appendChild(s);
    };
    // What the entries below act on, said in words (#340). A separator alone leaves the reader to
    // work out that "Split right" and "Move to new window" have different subjects; the session's
    // group carries its NAME because which session it means is not otherwise on screen — a
    // right-click means the tab that was clicked, the `…` button means the pane's active tab.
    const groupLabel = (text, name) => {
      const el = document.createElement('div');
      el.className = 'session-tab-menu-label';
      el.textContent = text;
      if (name) {
        const who = document.createElement('span');
        who.className = 'session-tab-menu-label-name';
        // The separator is part of the TEXT, not a CSS `::before`: this line is read out as one
        // string, and "SessionAuth refactor" is what a decorative dot leaves behind.
        who.textContent = ' · ' + name;
        el.appendChild(who);
      }
      pop.appendChild(el);
    };

    focusPane(leafId);
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    // Whose session the tab actions and the detach act on: the right-clicked tab if
    // there is one, else the pane's active tab. Taking the active tab while the
    // menu points at another would act on a session the user never aimed at.
    const subject = tab || (leaf ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : null);
    if (tab) { addTabItems(item, leafId, tab); separator(); }

    groupLabel('Pane');
    item('Split right', () => splitActivePane('right'));
    item('Split down', () => splitActivePane('down'));
    // The whole arrangement back to even (#352). Per LEVEL, like VS Code's — see
    // `distributeAllEvenly`. Nothing to reset with one pane, and the entry says so rather than
    // disappearing between one right-click and the next.
    item('Distribute evenly', () => distributeAllPanes(), {
      disabled: PaneTree.leaves(tree).length === 1,
    });
    // The whole pane, with all of its tabs (#340) — a leaf has no split structure to lose, so what
    // arrives on the other side is the same pane. From a detached window the only direction is back,
    // the same asymmetry `appendWindowItems` draws for a single session.
    const detachedHere = !!(window.isDetachedWindow && window.isDetachedWindow());
    item(detachedHere ? 'Move pane to main window' : 'Move pane to new window',
      () => movePaneToWindow(leafId), { disabled: !paneCanMove(leaf) });
    // Closing the PANE is not a tab action: a right-click on a tab is about that tab,
    // and with one tab in the pane the two would read as the same thing. It stays on
    // the pane's own menus — the `…` button, the strip, the session bar.
    if (!tab) {
      item('Close pane', () => closePane(leafId), {
        danger: true,
        disabled: PaneTree.leaves(tree).length === 1,
      });
    }

    // The arrangement as a whole (#352) — its own group, because none of it is about THIS pane. Undo
    // has no keyboard shortcut on purpose: Ctrl+Z belongs to whatever runs in the terminal, and a
    // layout undo stealing it would be the more surprising of the two.
    const presets = readPresets();
    if (undoStack.length || presets.length || PaneTree.leaves(tree).length > 1 || openSessions.size > 1) {
      separator();
      groupLabel('Layout');
      item('Undo layout change', () => undoLayout(), { disabled: !undoStack.length });
      // One pane per open session, in a grid the window's width decides (#356) — a command, not a
      // mode. Nothing to tile with a single session already in its own pane.
      item('Tile all sessions', () => tileAllSessions(), {
        disabled: openSessions.size < 2 && PaneTree.leaves(tree).length < 2,
      });
      item('Save layout…', () => saveLayoutPreset());
      for (const preset of presets) {
        // Shift-click deletes, so a saved layout needs neither a submenu nor an editing mode to be
        // gone again. The tooltip says so, because nothing else on screen could.
        const el = item(`Restore “${preset.name}”`, (e) => {
          if (e && e.shiftKey) {
            deleteLayoutPreset(preset.name);
            if (typeof showControlToast === 'function') {
              showControlToast({ message: `Layout “${preset.name}” deleted` });
            }
            return;
          }
          applyLayoutPreset(preset.name);
        });
        el.title = 'Shift-click to delete this layout';
      }
    }

    // Where this SESSION renders (#2, #314, #316): a window of its own, or any window that already
    // exists. The shared helper builds the block (#327) — including the window list, which lives in
    // main and therefore arrives after the menu is on screen, inserted next to the entry it extends
    // rather than at the end of the menu. Its own group, because it is the only part of this menu
    // that does not act on the pane; a pane with no session in it does not get one at all, rather
    // than an entry disabled for a reason the heading would have to explain.
    //
    // Which session, though, is not simply "the subject": a view tab can be the one on top, and from
    // the `…` BUTTON the menu belongs to the pane — so the pane's sessions must not disappear behind
    // whatever it happens to be showing. The first terminal tab stands in, and the heading naming it
    // is what makes standing in readable. A right-click is the other case and keeps the stricter
    // rule: it named a tab, and answering with a different tab's session would act on something the
    // user never aimed at.
    const sessionSubject = sessionOfTab(subject) ? subject
      : (tab ? null : (leaf ? leaf.tabs.find((t) => !!sessionOfTab(t)) : null));
    const subjectId = sessionOfTab(sessionSubject);
    if (subjectId && typeof window.appendWindowItems === 'function') {
      separator();
      groupLabel('Session', tabBaseName(sessionSubject));
      window.appendWindowItems(subjectId, item, () => activeMenu === pop);
    }

    // A view named by a right-click can go to another window too (#364), or to one of its own
    // (#370) — the entry for that leads the block, the way the session block leads with its own.
    if (tab && canLeaveWindow(subject) && typeof window.appendViewWindowItems === 'function') {
      separator();
      groupLabel('View', viewTabLabel(subject));
      window.appendViewWindowItems(subject, (windowId) => moveViewToWindow(leaf.id, subject, windowId),
        item, () => activeMenu === pop);
    }

    document.body.appendChild(pop);
    positionPaneMenu(pop, at);
    activeMenu = pop;
    armMenuDismiss(pop);
  }

  // Arm the dismiss listeners for `pop` on the next tick, so the click that opened the menu does not
  // close it again. The test is `activeMenu !== pop`, not `!activeMenu`: a menu replaced within the
  // same tick would otherwise arm ITS pair into the single `menuDismissHandlers` slot on top of the
  // live menu's, and the overwritten pair could never be removed again.
  function armMenuDismiss(pop) {
    setTimeout(() => {
      if (activeMenu !== pop) return; // closed, or replaced, before the listeners went up
      const out = (e) => { if (activeMenu && !activeMenu.contains(e.target)) closePaneMenu(); };
      const esc = (e) => { if (e.key === 'Escape') closePaneMenu(); };
      menuDismissHandlers = { out, esc };
      document.addEventListener('mousedown', out, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
  }

  // --- Drag & drop (#309 W4) ------------------------------------------------
  // Dragging a tab: onto another tab → insert there; onto a pane body → the 10 %
  // edge zones split in that direction, the centre moves the tab into the pane.
  // The ratio is VS Code's for an editor drag (editorDropTarget.ts).

  const EDGE_RATIO = 0.1;
  let drag = null; // { tabId, fromLeafId }

  // Is this event our tab drag? The MIME is the authority (it survives the trip
  // through nested targets); the module state only carries the source.
  const isTabDrag = (e) => !!drag
    && !!e.dataTransfer
    && Array.prototype.includes.call(e.dataTransfer.types || [], PANE_TAB_MIME);

  /**
   * Is this a session dragged out of the sidebar (#373)?
   *
   * Beside `isTabDrag`, never inside it. That predicate is what keeps a foreign drag from splitting a
   * pane, and the two answers lead to different code — one moves a tab that exists, the other makes
   * one. Same shape though: the MIME is the authority, and the id comes from state, because
   * `dataTransfer.getData` is empty until the drop.
   */
  const isSessionDrag = (e) => !!window.__sessionDragId
    && !!e.dataTransfer
    && Array.prototype.includes.call(e.dataTransfer.types || [], SESSION_DRAG_MIME);

  /** Either of ours — the gate every drop target opens with. */
  const isOurDrag = (e) => isTabDrag(e) || isSessionDrag(e);

  // --- Asking the window under the pointer, while the drag is still held (#375) ---
  //
  // The last answer another window gave, and the drop reads it. One probe in flight at a time: a
  // `dragover` fires many times a second and each probe is an IPC round trip through a second
  // renderer, so a queue of them would arrive after the drop that was waiting for them.
  let remoteAim = null;
  let probeInFlight = false;

  function probeRemote(e) {
    if (probeInFlight || typeof window.api?.probeDropPoint !== 'function') return;
    const aim = pointerAim(e);
    if (!aim) return;
    // Inside our own window there is nothing to ask: our own handlers have already drawn the answer.
    if (!pointerOutsideWindow(e)) {
      if (remoteAim) { remoteAim = null; dropRemoteHints(); }
      return;
    }
    probeInFlight = true;
    window.api.probeDropPoint(aim.point, aim.box)
      .then((res) => { remoteAim = res && res.placement ? res : null; })
      .catch(() => { remoteAim = null; })
      .finally(() => { probeInFlight = false; });
  }

  /** Take the highlight off every other window. The answer they gave outlives this — see `dragend`. */
  function dropRemoteHints() {
    try { window.api?.clearRemoteDropHints?.(); } catch { /* older main process */ }
  }

  function wireTabDrag(el, leafId, tabId) {
    el.addEventListener('dragstart', (e) => {
      drag = { tabId, fromLeafId: leafId };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Only the custom type — a text/plain payload would be inserted into the
      // terminal by any drop that reached it.
      try { e.dataTransfer.setData(PANE_TAB_MIME, tabId); } catch { /* type refused */ }
    });
    // `drag` fires on the SOURCE for the whole gesture, including while the pointer is over another
    // window — where `dragover` never reaches us at all. It is the only hook that can ask the far
    // window what it would do (#375).
    el.addEventListener('drag', probeRemote);
    el.addEventListener('dragend', (e) => {
      const dragged = drag;
      drag = null;
      el.classList.remove('dragging');
      clearDropFeedback();
      // The hints go now; the ANSWER is still needed — `tearOffTab` below reads it to place the tab
      // inside the window it landed on (#375), and clearing both together would throw it away one
      // line before its only reader.
      dropRemoteHints();
      // Dropped on the desktop: give this tab a window of its own (#352). VS Code and Windows
      // Terminal both do this, and #340 built the menu route it shares.
      if (dragged && droppedOutOfWindow(e)) tearOffTab(dragged.fromLeafId, dragged.tabId, e);
      remoteAim = null;
    });
    el.addEventListener('dragover', (e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.stopPropagation();
      const gap = tabDropGap(el, leafId, tabId, e);
      showTabCaret(el.parentElement, gap.edge);
    });
    el.addEventListener('drop', (e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const sessionId = isSessionDrag(e) ? window.__sessionDragId : null;
      const index = tabDropGap(el, leafId, tabId, e).index;
      if (sessionId) dropSessionInto(sessionId, leafId, index);
      else applyMove(drag, leafId, index);
    });
  }

  /**
   * Did this drag end on the DESKTOP rather than anywhere in this window (#352)?
   *
   * Two conditions, and both are load-bearing. `dropEffect === 'none'` says no drop target took it —
   * but that is also what a drop on a non-target part of our OWN window reports, and tearing a tab
   * off for that would turn every mis-aimed drag into a new window. So the pointer's screen position
   * has to be outside the window box as well.
   *
   * A drop on ANOTHER application also reports `none` with a position outside this window, and reads
   * as a tear-off here. That is the same answer VS Code gives, and the alternative — asking the OS
   * what is under the cursor — is not something a renderer can do.
   *
   * Bails on a position it cannot trust: some platforms report 0/0 on `dragend`, and an untrusted
   * zero would detach a tab the user dropped in the middle of the window.
   */
  function droppedOutOfWindow(e) {
    if (!e || !e.dataTransfer || e.dataTransfer.dropEffect !== 'none') return false;
    return pointerOutsideWindow(e);
  }

  /**
   * Is the pointer outside this window's box? The geometry half of the answer above, on its own so a
   * drag still in flight can ask it (#375) — there `dropEffect` says nothing yet.
   *
   * Bails on a position it cannot trust, for the reason above: some platforms report 0/0, and treating
   * that as "outside" would send every drag off to another window.
   */
  function pointerOutsideWindow(e) {
    const x = Number(e && e.screenX);
    const y = Number(e && e.screenY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return false;
    const width = Number(window.outerWidth);
    const height = Number(window.outerHeight);
    if (!width || !height) return false;
    const left = Number(window.screenX) || 0;
    const top = Number(window.screenY) || 0;
    return x < left || x > left + width || y < top || y > top + height;
  }

  /**
   * The gesture's half of "move to new window" (#340's menu entry is the other).
   *
   * A view tab cannot go, for the reasons the pane move already states — the element belongs to this
   * renderer — and here that has to be SAID: a drag that visibly ends nowhere, with no window and no
   * explanation, reads as the app having dropped the tab.
   */
  async function tearOffTab(leafId, tabId, e) {
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const tab = leaf && leaf.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Did it land ON another Switchboard window (#360)? Only main can say: the far window is a second
    // renderer process and never sees this drag at all, so nothing here could have been told.
    const onto = await windowUnderPointer(e);
    if (onto === false) return; // could not be answered — see below

    // A view travels by being OPENED there and closed here (#364) — every window has its own copy of
    // the viewer elements, so there is nothing to hand over. Dropped on empty space it gets a window
    // of its own (#370), on the display it was dropped on: the same answer the gesture gives for a
    // session, which is what makes it a gesture rather than two.
    if (isViewTab(tab)) {
      // `typeof`, not `?.` — these are bare globals from another classic script, and optional
      // chaining on an undeclared name is a ReferenceError, not undefined.
      if (!canLeaveWindow(tab)) {
        // Say which of the two reasons it is, because they suggest different things to the reader:
        // one is "this will never move", the other is "nobody has taught it to yet".
        const why = isInstancedKind(tab.kind)
          ? 'belongs to this window'
          : 'cannot be filled in another window yet';
        if (typeof showControlToast === 'function') {
          showControlToast({ message: `${viewTabLabel(tab)} ${why}`, timeoutMs: 4000 });
        }
        return;
      }
      moveViewToWindow(leafId, tab, onto || null, onto ? null : pointerAim(e));
      return;
    }

    const sessionId = sessionOfTab(tab);
    if (!sessionId) return;
    if (onto) {
      // Where inside that window (#375): the answer it gave while the pointer was over it, which is
      // also what it highlighted. A window with no pane to offer answers `{ kind: 'window' }` and
      // frames itself (#377), so that landing is announced too; `null` is left for a window that
      // never replied, and the move then lands the way it always did, in their active pane.
      const placement = (remoteAim && remoteAim.windowId === onto) ? remoteAim.placement : null;
      if (typeof window.moveSessionToWindow === 'function') {
        window.moveSessionToWindow(sessionId, onto, placement);
      }
      return;
    }

    // Nothing under the pointer: the desktop, or another application. The session gets a window of
    // its own, and the drop point travels with it so that window opens on the display it was dragged
    // to (#362) rather than on the main window's.
    //
    // This is the same answer in EVERY window since #363. It used to be "back to the main window"
    // when asked from a detached one, which made one gesture mean two things depending on where the
    // drag started — and the main window is already reachable by name from the tab's own menu.
    if (typeof window.detachSession === 'function') window.detachSession(sessionId, pointerAim(e));
  }

  /**
   * Which window the drop landed on: a window id, `null` for none, or `false` for "cannot be answered".
   *
   * The three answers are deliberately distinct. `null` is a RESULT — the pointer was over the desktop
   * or another application — and the tear-off proceeds. `false` is a FAILURE (an older main process,
   * an IPC that threw), and there the session stays exactly where it is: a drop that cannot be resolved
   * must not be answered with a plausible guess, because the guess is what moves a session somewhere
   * the user did not aim at, which is the defect this fixes.
   */
  /**
   * Send a view to another window (#364): it opens its own, this one closes its own.
   *
   * The close comes SECOND and only on success. A view that failed to arrive and was closed here
   * anyway is a view the user has to find again, and the failure is silent — the far window either
   * went away between the drop and the message, or never existed.
   */
  async function moveViewToWindow(leafId, tab, windowId, at = null) {
    if (typeof window.api?.openViewInWindow !== 'function') return;
    // The open FILE travels too (#364). A singleton kind has no ref to carry it in, so a moved Memory
    // or Plan would arrive showing an empty editor — the move would look half done, which is exactly
    // what it felt like before this was added.
    const file = (typeof currentViewFilePayload === 'function') ? currentViewFilePayload(tab.kind) : null;
    let res = null;
    try {
      // A null window is a window that does not exist yet (#370): the view gets one of its own,
      // holding nothing else. `at` places it where it was dropped, exactly as a torn-off session's
      // window is placed; a menu entry sends none and main falls back to the pointer's display.
      res = windowId == null
        ? await window.api.openViewInNewWindow?.(tab.kind, tab.ref, file, at)
        : await window.api.openViewInWindow(windowId, tab.kind, tab.ref, file);
    } catch { res = null; }
    if (!res || !res.ok) {
      if (typeof showControlToast === 'function') {
        showControlToast({ message: 'Could not move this view', timeoutMs: 3000 });
      }
      return;
    }
    closeTabFromUi(leafId, tab);
  }

  /**
   * Where a drag ended, in the pair main needs to place it on the screen: the point, plus the box
   * this renderer measured for ITSELF. Main compares that box against the same window's real bounds,
   * which is what converts CSS pixels (zoomable) into screen DIPs — see `toScreenPoint` in
   * `app/detach.js`. Used both to hit-test other windows (#360) and to choose the display a torn-off
   * tab opens on (#362), so the two can never disagree about what the point meant.
   */
  function pointerAim(e) {
    if (!e) return null;
    return {
      point: { x: e.screenX, y: e.screenY },
      box: {
        x: Number(window.screenX) || 0,
        y: Number(window.screenY) || 0,
        width: Number(window.outerWidth) || 0,
        height: Number(window.outerHeight) || 0,
      },
    };
  }

  async function windowUnderPointer(e) {
    const aim = pointerAim(e);
    if (!aim || typeof window.api?.windowAtScreenPoint !== 'function') return false;
    try {
      const id = await window.api.windowAtScreenPoint(aim.point, aim.box);
      return id || null;
    } catch {
      return false;
    }
  }

  // Which gap a drop on this tab means, and where the caret marking it sits. The
  // cursor's half decides: left of the midpoint inserts before the tab, right of it
  // after — without that, a tab could never be dropped last (#313).
  function tabDropGap(el, leafId, tabId, e) {
    const leaf = PaneTree.leaves(tree).find((l) => l.id === leafId);
    const at = leaf ? leaf.tabs.findIndex((t) => t.id === tabId) : -1;
    const r = el.getBoundingClientRect();
    const after = e.clientX > r.left + (r.width / 2);
    return {
      index: at < 0 ? -1 : at + (after ? 1 : 0),
      edge: after ? el.offsetLeft + el.offsetWidth : el.offsetLeft,
    };
  }

  // Where the caret goes when the drop would append: past the last tab, or the very
  // start of an empty strip.
  function endCaretEdge(list) {
    // Not lastElementChild — the caret lives in this list too and would measure
    // itself.
    const tabs = list ? list.querySelectorAll('.session-tab') : [];
    const last = tabs[tabs.length - 1];
    return last ? last.offsetLeft + last.offsetWidth : 0;
  }

  /**
   * Which outer zone a point in the STRIP is in — and never one over the tabs themselves (#436).
   *
   * The strip sits along the top of the pane area, so #376's sliver of the outer band crosses the tab
   * row, and a reorder drag travels exactly along that line. The result was a root-split preview
   * across the whole area during a gesture that only means "put this tab in that gap". A drag over a
   * tab is a reorder and nothing else; the band keeps the strip's empty space, where no reorder
   * happens, so the top edge stays sayable.
   */
  function stripOuterZoneAt(list, point) {
    if (overTabRow(list, point)) return null;
    return outerZoneAt(point, OUTER_BAND_STRIP_PX);
  }

  /** Is this point inside some pane's strip? Then that strip reads it, not the container's band. */
  function insideAnyStrip(point) {
    if (!terminalsEl) return false;
    for (const strip of terminalsEl.querySelectorAll('.pane-strip')) {
      if (hits(strip, point.clientX, point.clientY)) return true;
    }
    return false;
  }

  /** Is this point over the tabs' own column, rather than the empty space beside them? */
  function overTabRow(list, point) {
    const tabs = list ? list.querySelectorAll('.session-tab') : [];
    if (!tabs.length) return false;
    // The whole column, not the tab boxes: the strip has padding above them, and a point there is
    // still aimed at the tab under it.
    const first = tabs[0].getBoundingClientRect();
    const last = tabs[tabs.length - 1].getBoundingClientRect();
    return point.clientX >= first.left && point.clientX <= last.right;
  }

  /**
   * The outer band, wired once on the CONTAINER (#376).
   *
   * The band runs along the edge of the whole area, and parts of that edge are not a pane: a sash
   * between two side-by-side panes crosses it, and a sash has no drop handling at all — so the bottom
   * few pixels under it were a dead strip, which is the fiddliness this issue is about in miniature.
   * Everything that is not claimed by a pane bubbles to here.
   *
   * `#terminals` survives every rebuild (`replaceChildren` swaps its child, not itself), so this is
   * attached once rather than per render. The pane handlers stop propagation on their own drops, so
   * this never runs twice for one gesture.
   */
  function wireOuterBand() {
    if (!terminalsEl || terminalsEl.__outerBandWired) return;
    terminalsEl.__outerBandWired = true;
    terminalsEl.addEventListener('dragover', (e) => {
      if (!enabled || !isOurDrag(e)) return;
      const outer = outerZoneAt(e);
      if (!outer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showOuterHint(outer);
    });
    terminalsEl.addEventListener('dragleave', (e) => {
      if (!terminalsEl.contains(e.relatedTarget)) clearOuterHint();
    });
    terminalsEl.addEventListener('drop', (e) => {
      if (!enabled || !isOurDrag(e)) return;
      const outer = outerZoneAt(e);
      if (!outer) return;
      e.preventDefault();
      const sessionId = isSessionDrag(e) ? window.__sessionDragId : null;
      clearDropFeedback();
      if (sessionId) dropSessionIntoRootSplit(sessionId, outer);
      else applyRootSplitMove(drag, outer);
    });
  }

  // --- Answering for a drag this window is not part of (#375) ------------------
  //
  // A drag never crosses a renderer process: the far window sees no `dragover` at all, and the near
  // one only knows the pointer left its box. So the far window is ASKED — where would a drop at this
  // point land, and show the user that answer while the pointer is still held.
  //
  // The two halves are deliberately one function: what the hint draws and what the drop does have to
  // be the same decision, or the window highlights one thing and does another.

  /** Where a drop at this point in THIS window would land, in the shape a placement travels in. */
  function dropTargetAt(clientX, clientY) {
    if (!enabled || !tree) return null;
    const point = { clientX, clientY };
    // A point in a STRIP is read by that strip, never by the container's band (#436). The band
    // reaches 36 px into an area whose top 35 are the strip, so asking it first answered "split
    // across everything" for points the strip itself takes — over a tab as a reorder, and past its
    // own 10 px sliver as an append. A local drag gives the strip that priority by claiming the
    // event; this is the same rule for the probe, which has no event to claim.
    const outer = insideAnyStrip(point) ? null : outerZoneAt(point);
    if (outer) return { kind: 'root', zone: outer };
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      const leafId = pane.dataset.paneId;
      if (!leafId) continue;
      const strip = pane.querySelector('.pane-strip');
      if (strip && hits(strip, clientX, clientY)) {
        // Same reading as a local drag over this strip (#436) — the far window has to answer what a
        // drop will do, and a probe that still said "root split" here would highlight one layout and
        // perform another.
        const stripOuter = stripOuterZoneAt(strip.querySelector('.session-tabs-list'), point);
        if (stripOuter) return { kind: 'root', zone: stripOuter };
        for (const el of strip.querySelectorAll('.session-tab')) {
          if (!hits(el, clientX, clientY)) continue;
          const tabId = el.dataset.tabId;
          if (!tabId) break;
          return { kind: 'tab', leafId, index: tabDropGap(el, leafId, tabId, point).index };
        }
        return { kind: 'tab', leafId, index: -1 };
      }
      const body = pane.querySelector('.pane-body');
      if (!body || !hits(body, clientX, clientY)) continue;
      const zone = dropZone(body, point);
      return zone === 'center' ? { kind: 'tab', leafId, index: -1 } : { kind: 'split', leafId, zone };
    }
    return null;
  }

  function hits(el, x, y) {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** Draw the hint for a placement this window was asked about, exactly as a local drag would. */
  function showPlacementHint(placement) {
    if (!enabled || !placement) { clearDropFeedback(); return; }
    // The whole-window landing is not a pane hint and is not drawn here (#377): it has to be drawable
    // in grid mode too, where this view is not even running. `detach-window.js` owns that one.
    if (placement.kind === 'window') { clearDropFeedback(); return; }
    if (placement.kind === 'root') { showOuterHint(placement.zone); return; }
    const pane = terminalsEl.querySelector('.pane[data-pane-id="' + placement.leafId + '"]');
    const body = pane && pane.querySelector('.pane-body');
    if (!body) { clearDropFeedback(); return; }
    if (placement.kind === 'split') { clearOuterHint(); showDropHint(body, placement.zone); return; }
    clearOuterHint();
    // A placement with a POSITION is a caret, not a pane highlight. Drawing the generic one for both
    // told the user "somewhere in this pane" where the drop meant "in this gap" — the far window
    // showing less than a local drag does, for the same gesture.
    const list = pane.querySelector('.pane-strip .session-tabs-list');
    if (list && placement.index >= 0) {
      const tabs = list.querySelectorAll('.session-tab');
      const at = tabs[placement.index];
      clearDropHint();
      showTabCaret(list, at ? at.offsetLeft : endCaretEdge(list));
      return;
    }
    showDropHint(body, 'center');
  }

  /**
   * Put a session where a drop in ANOTHER window said it should go (#375).
   *
   * The same three landings a local drop has, chosen by the same answer — the placement is what the
   * far window highlighted, so what arrives is what the user saw.
   */
  function applyPlacement(sessionId, placement, opts) {
    if (!enabled || !sessionId) return false;
    if (!placement) return false;
    // "This window, but no pane of it" (#377). The far window says so rather than staying silent, so
    // that it can DRAW the landing it is about to perform; placing it is still not this function's
    // job, and answering false hands the session to the same active-pane fallback a silent probe
    // used to reach. Without this the three lines below would address a leaf id of `undefined`.
    if (placement.kind === 'window') return false;
    // `mount: false` from the adopt (#375): the tab is made here, the terminal is attached by the
    // caller. Two mounts for one arrival is two xterms racing for one PTY — `mountOnce` cannot see a
    // bare `openSession` started beside it, so the two paths must not both start one.
    if (placement.kind === 'root') return dropSessionIntoRootSplit(sessionId, placement.zone, opts);
    if (placement.kind === 'split') return dropSessionIntoSplit(sessionId, placement.leafId, placement.zone, opts);
    return dropSessionInto(sessionId, placement.leafId, placement.index, opts);
  }

  function wireDropZones(pane, body, leafId) {
    // The strip's empty space takes a tab too — aiming at the tab row is the
    // obvious gesture, and without this it would land nowhere.
    const strip = pane.querySelector('.pane-strip');
    if (strip) {
      const list = strip.querySelector('.session-tabs-list');
      strip.addEventListener('dragover', (e) => {
        if (!isOurDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Claimed here, exactly as the drop below is (#436). Letting it bubble put the container's
        // 36 px band over the strip's own 10 px sliver, so the hint was drawn from one reading and
        // the drop performed the other.
        e.stopPropagation();
        // A sliver of the outer band reaches into the strip (#376) so the TOP edge of the area is
        // sayable at all — the strip covers it everywhere else. Only a sliver: the strip is a target
        // in its own right and the tabs have to stay easier to hit than the band above them.
        const outer = stripOuterZoneAt(list, e);
        if (outer) showOuterHint(outer);
        else { clearOuterHint(); showTabCaret(list, endCaretEdge(list)); }
      });
      strip.addEventListener('dragleave', (e) => {
        if (!strip.contains(e.relatedTarget)) { clearTabCaret(); clearOuterHint(); }
      });
      strip.addEventListener('drop', (e) => {
        if (!isOurDrag(e)) return;
        e.preventDefault();
        const sessionId = isSessionDrag(e) ? window.__sessionDragId : null;
        const outer = stripOuterZoneAt(list, e);
        clearDropFeedback();
        e.stopPropagation(); // handled here — the container's outer-band listener must not repeat it
        if (outer) {
          if (sessionId) dropSessionIntoRootSplit(sessionId, outer);
          else applyRootSplitMove(drag, outer);
        } else if (sessionId) dropSessionInto(sessionId, leafId, -1);
        else applyMove(drag, leafId, -1);
      });
    }

    body.addEventListener('dragover', (e) => {
      if (!isOurDrag(e)) return;
      // preventDefault is what makes this a drop target at all — the terminal
      // container inside deliberately does NOT do it for a tab drag (#309).
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // The outer band wins over this pane's own edge (#376): the two overlap on an outermost pane,
      // and the one that addresses the whole area is the one the user cannot express any other way.
      const outer = outerZoneAt(e);
      if (outer) showOuterHint(outer);
      else { clearOuterHint(); showDropHint(body, dropZone(body, e)); }
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) { clearDropHint(); clearOuterHint(); }
    });
    body.addEventListener('drop', (e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      // Read the session BEFORE the feedback is cleared: `clearDropFeedback` is also what a dragend
      // runs, and the two can race on a fast drop.
      const sessionId = isSessionDrag(e) ? window.__sessionDragId : null;
      const outer = outerZoneAt(e);
      const zone = outer || dropZone(body, e);
      clearDropHint();
      clearOuterHint();
      e.stopPropagation(); // handled here — the container's outer-band listener must not repeat it
      if (sessionId) {
        if (outer) dropSessionIntoRootSplit(sessionId, outer);
        else if (zone === 'center') dropSessionInto(sessionId, leafId, -1);
        else dropSessionIntoSplit(sessionId, leafId, zone);
      } else if (outer) applyRootSplitMove(drag, outer);
      else if (zone === 'center') applyMove(drag, leafId, -1);
      else applySplitMove(drag, leafId, zone);
    });
  }

  /**
   * How deep a pane's edge zone reaches (#376).
   *
   * A ratio alone is unhittable on a pane that is already narrow — a tenth of 200 px is 20 px, and
   * missing it means the tab is MOVED into the pane instead of splitting it, which takes a second
   * gesture to undo. So the ratio gets a floor in pixels. The cap is the other half of the same
   * thought: on a small pane a floor with no ceiling would leave no middle at all, and "move it into
   * this pane" is the more common intent of the two.
   */
  const EDGE_MIN_PX = 30;
  const EDGE_MAX_RATIO = 0.32;
  function edgeDepth(extent) {
    return Math.min(Math.max(extent * EDGE_RATIO, EDGE_MIN_PX), extent * EDGE_MAX_RATIO);
  }

  function dropZone(body, e) {
    const r = body.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const ex = edgeDepth(Math.max(1, r.width));
    const ey = edgeDepth(Math.max(1, r.height));
    if (dx < ex) return 'left';
    if (dx > r.width - ex) return 'right';
    if (dy < ey) return 'up';
    if (dy > r.height - ey) return 'down';
    return 'center';
  }

  // --- The outer band: a drop that addresses the whole area (#376) --------------
  //
  // With two panes side by side, the bottom edge of one of them splits THAT pane and gives a pane
  // under one column. "Put this one below both" had nowhere to be said: an edge zone belongs to the
  // leaf it is drawn on. The outermost band of the whole pane area is that place — a drop there
  // splits at the ROOT, so the new pane spans everything.
  //
  // Measured against the pane TREE's element rather than `#terminals`, which carries a -20px right
  // margin and therefore reaches past what the user can see.
  const OUTER_BAND_PX = 36;
  // Where a tab strip overlaps the band, only a sliver of it counts. The strip is a real drop target
  // with its own meaning ("append to this pane"), it is about 30 px tall, and a 20 px band would eat
  // most of it — reintroducing at the top the fiddliness this issue is about.
  const OUTER_BAND_STRIP_PX = 10;

  function paneAreaRect() {
    const root = terminalsEl && terminalsEl.firstElementChild;
    return root ? root.getBoundingClientRect() : null;
  }

  /** Which outer edge this point is in, or null for "inside" — `depth` is the band to test against. */
  function outerZoneAt(e, depth = OUTER_BAND_PX) {
    const r = paneAreaRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    const x = e.clientX;
    const y = e.clientY;
    if (x < r.left - depth || x > r.right + depth || y < r.top - depth || y > r.bottom + depth) return null;
    // Left and right first: at a corner the horizontal reading is the one that keeps a full-height
    // column, which is what the corner of a row of panes looks like it should give.
    if (x <= r.left + depth) return 'left';
    if (x >= r.right - depth) return 'right';
    if (y <= r.top + depth) return 'up';
    if (y >= r.bottom - depth) return 'down';
    return null;
  }

  let dropHint = null;
  function showDropHint(body, zone) {
    clearTabCaret(); // the body and the strip never mean the same drop
    if (!dropHint) {
      dropHint = document.createElement('div');
      dropHint.className = 'pane-drop-hint';
    }
    if (dropHint.parentElement !== body) body.appendChild(dropHint);
    dropHint.className = 'pane-drop-hint pane-drop-' + zone;
  }
  function clearDropHint() { if (dropHint) { dropHint.remove(); } }

  /**
   * The hint for an outer drop (#376): the same shape, drawn on the whole area rather than in a pane.
   *
   * It has to look different from an inner one, because the two produce different layouts from the
   * same pointer position — a hint that says "half of this pane" where the drop means "across
   * everything" is worse than none.
   */
  let outerHint = null;
  function showOuterHint(zone) {
    clearTabCaret();
    clearDropHint();
    const root = terminalsEl && terminalsEl.firstElementChild;
    if (!root) return;
    if (!outerHint) {
      outerHint = document.createElement('div');
    }
    outerHint.className = 'pane-drop-hint pane-drop-outer pane-drop-' + zone;
    // On #terminals, not on the tree: the tree is a flex box whose children are the panes, and a
    // positioned child of it would be laid out as one of them.
    if (outerHint.parentElement !== terminalsEl) terminalsEl.appendChild(outerHint);
  }
  function clearOuterHint() { if (outerHint) outerHint.remove(); }

  // The insertion caret in a tab strip (#313). It lives inside the scrolling tab
  // list, so it stays on its gap while the strip scrolls.
  let tabCaret = null;
  function showTabCaret(list, edge) {
    if (!list) return;
    clearDropHint();
    if (!tabCaret) {
      tabCaret = document.createElement('div');
      tabCaret.className = 'pane-tab-caret';
    }
    if (tabCaret.parentElement !== list) list.appendChild(tabCaret);
    tabCaret.style.left = Math.max(0, edge - 1) + 'px';
  }
  function clearTabCaret() { if (tabCaret) { tabCaret.remove(); } }
  function clearDropFeedback() { clearDropHint(); clearTabCaret(); clearOuterHint(); }

  function applyMove(from, toLeafId, index) {
    pushUndo();
    const next = PaneTree.moveTab(tree, { fromLeafId: from.fromLeafId, toLeafId, tabId: from.tabId, index });
    drag = null;
    clearDropFeedback();
    tree = next;
    activeLeafId = toLeafId;
    activeLeaf(); // the target can have collapsed away while the drop was in flight
    render();
    persist();
    showActiveOrPlaceholder();
  }

  /**
   * A session dragged out of the sidebar, landing in a pane (#373).
   *
   * The mirror of `applyMove`: that one moves a tab that exists, this one makes one that does not.
   * Same model, one call each — `PaneTree.addTab` has taken an index all along, which is why "it
   * should feel like a tab move" costs a branch rather than a mechanism.
   *
   * Three answers before it lands, and each one is a rule that already exists:
   *
   *  - a session ALREADY in this tree is not a new tab at all, it is a tab move (the drop is then the
   *    gesture the user would have used anyway, so it takes the same path);
   *  - a session rendered in ANOTHER window is refused by name. Mounting it here would be the second
   *    renderer on one PTY that spec 17 §3 exists to prevent, and the tab would be a phantom;
   *  - a session with no process is NOT started by the drop. Its tab is drawn as the "not running /
   *    Launch" placeholder (#318) — the same thing a tab restored from a saved layout gets — and
   *    starting the CLI stays a button the user presses.
   */
  function dropSessionInto(sessionId, toLeafId, index, { mount = true } = {}) {
    if (!enabled || !tree || !sessionId) return false;
    const existing = PaneTree.leafOfTab(tree, tabIdFor(sessionId));
    if (existing) {
      applyMove({ tabId: tabIdFor(sessionId), fromLeafId: existing.id }, toLeafId, index);
      return true;
    }
    if (!acceptsSessionDrop(sessionId)) return false;
    // The pane may be GONE. `addTab` answers a leaf it cannot find by returning the tree unchanged,
    // and reporting success for that would leave the caller believing a session it placed nowhere had
    // arrived. #375 is what made this reachable: a placement crosses a process boundary and an async
    // round trip, so the layout it names can change under it between the answer and the drop.
    const next = PaneTree.addTab(tree, toLeafId, makeTerminalTab(sessionId), index);
    if (!PaneTree.leafOfTab(next, tabIdFor(sessionId))) return false;
    pushUndo();
    tree = next;
    activeLeafId = toLeafId;
    render();
    persist();
    if (mount) mountDroppedSession(sessionId);
    return true;
  }

  /** The same, onto a pane EDGE: the pane splits and the session opens in the new one. */
  function dropSessionIntoSplit(sessionId, leafId, direction, { mount = true } = {}) {
    if (!enabled || !tree || !sessionId) return false;
    const existing = PaneTree.leafOfTab(tree, tabIdFor(sessionId));
    if (existing) {
      applySplitMove({ tabId: tabIdFor(sessionId), fromLeafId: existing.id }, leafId, direction);
      return true;
    }
    if (!acceptsSessionDrop(sessionId)) return false;
    const newLeafId = nextLeafId();
    // `splitLeaf` takes the tab for the new pane, so the split and the tab are one operation — a
    // split followed by an add would leave an empty pane on screen for a frame if the add refused.
    // Same check as above: a pane that is gone leaves the tree untouched, and that is not a success.
    const next = PaneTree.splitLeaf(tree, leafId, direction, { newLeafId, tab: makeTerminalTab(sessionId) });
    if (!PaneTree.leafOfTab(next, tabIdFor(sessionId))) return false;
    pushUndo();
    tree = next;
    activeLeafId = newLeafId;
    render();
    persist();
    if (mount) mountDroppedSession(sessionId);
    return true;
  }

  /** Can this session land here at all? Says why when it cannot, rather than doing nothing. */
  function acceptsSessionDrop(sessionId) {
    if (typeof sessionMap === 'undefined' || !sessionMap.has(sessionId)) return false;
    if (typeof window.isSessionDetached === 'function' && window.isSessionDetached(sessionId)) {
      if (typeof showControlToast === 'function') {
        showControlToast({ message: 'That session is open in another window', timeoutMs: 3000 });
      }
      return false;
    }
    return true;
  }

  /**
   * Attach to the dropped session if it has a process; leave it dormant if it has not.
   *
   * Called AFTER the tab is in the tree, which is what keeps the session in the pane it was dropped
   * on: `adoptOrphans` only places a session that has no tab yet, so it finds this one already home.
   */
  function mountDroppedSession(sessionId) {
    const running = typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId);
    if (!running) return; // the pane draws the Launch placeholder for it (#318)
    const session = sessionMap.get(sessionId);
    if (session && typeof openSession === 'function') openSession(session);
  }

  /** A dragged TAB dropped on the outer band: a pane across the whole area, and the tab in it (#376). */
  function applyRootSplitMove(from, direction) {
    if (!from) return;
    pushUndo();
    const newLeafId = nextLeafId();
    let next = PaneTree.splitRoot(tree, direction, { newLeafId });
    next = PaneTree.moveTab(next, { fromLeafId: from.fromLeafId, toLeafId: newLeafId, tabId: from.tabId });
    drag = null;
    tree = next;
    activeLeafId = newLeafId;
    clearDropFeedback();
    render();
    persist();
    showActiveOrPlaceholder();
  }

  /** The same for a session dragged out of the sidebar (#373 + #376). */
  function dropSessionIntoRootSplit(sessionId, direction, { mount = true } = {}) {
    if (!enabled || !tree || !sessionId) return false;
    const existing = PaneTree.leafOfTab(tree, tabIdFor(sessionId));
    if (existing) {
      applyRootSplitMove({ tabId: tabIdFor(sessionId), fromLeafId: existing.id }, direction);
      return true;
    }
    if (!acceptsSessionDrop(sessionId)) return false;
    const newLeafId = nextLeafId();
    // Same as the other two: `splitRoot` answers a direction it does not know by returning the tree
    // unchanged, and a caller told "placed" about a tree that did not move places nothing at all.
    const next = PaneTree.splitRoot(tree, direction, { newLeafId, tab: makeTerminalTab(sessionId) });
    if (!PaneTree.leafOfTab(next, tabIdFor(sessionId))) return false;
    pushUndo();
    tree = next;
    activeLeafId = newLeafId;
    render();
    persist();
    if (mount) mountDroppedSession(sessionId);
    return true;
  }

  function applySplitMove(from, leafId, direction) {
    pushUndo();
    const newLeafId = nextLeafId();
    let next = PaneTree.splitLeaf(tree, leafId, direction, { newLeafId });
    next = PaneTree.moveTab(next, { fromLeafId: from.fromLeafId, toLeafId: newLeafId, tabId: from.tabId });
    drag = null;
    tree = next;
    activeLeafId = newLeafId;
    render();
    persist();
    showActiveOrPlaceholder();
  }

  // --- Sash drag ------------------------------------------------------------
  //
  // The gesture outlives the element it starts on, so its listeners must too (#345). They used to
  // hang on the SASH, and the only thing that removed `pane-sashing` from <body> was its `pointerup`
  // — while every `render()` does `replaceChildren` and takes the sash with it. A background session
  // ending mid-drag (destroySession → dropSession → scheduleRender) was enough: the sash died before
  // it could be released, the class stayed, and `body.pane-sashing .terminal-container` kept
  // `pointer-events: none` on every terminal for the rest of the window's life. Nothing was
  // clickable, selectable or right-clickable, and the only way out was performing another complete
  // sash drag.
  //
  // Ways a pointer gesture ends. `pointerup` is the ordinary one; `pointercancel` arrives when the
  // browser takes the pointer away (a touch turning into a scroll, the window losing it), and
  // `lostpointercapture` when the capture goes — including the implicit release when the captured
  // element is removed from the document. Several of them can arrive for one gesture, so the ender
  // has to be idempotent.
  const SASH_END_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'];

  // The in-flight gesture's ender, or null. `render()` calls it: a rebuild takes the sash away, so
  // the drag has already lost its anchor and finishing it there is what keeps the class off <body>.
  let endSashDrag = null;

  function startSashDrag(e, sash, path, index, orientation) {
    if (e.button !== 0) return;
    e.preventDefault();
    // A second gesture cannot start on top of a live one — end the old one first, or its listeners
    // and the body class would outlive it.
    if (endSashDrag) endSashDrag();
    const branchEl = sash.parentElement;
    const extent = orientation === 'row' ? branchEl.clientWidth : branchEl.clientHeight;
    if (!extent) return;
    const start = orientation === 'row' ? e.clientX : e.clientY;
    // Capture keeps the drag alive when the pointer crosses a terminal; a pointer
    // id the element never saw (a synthesised event) throws, and the drag still
    // works without capture, so it must not abort here.
    try { sash.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    sash.classList.add('dragging');
    document.body.classList.add('pane-sashing');

    let pending = null;
    const onMove = (ev) => {
      const now = orientation === 'row' ? ev.clientX : ev.clientY;
      pending = (now - start) / extent;
      // Live feedback without a rebuild: only the two flex bases change, so the
      // xterms keep their DOM and the drag stays smooth.
      const branch = PaneTree.nodeAt(tree, path);
      const preview = PaneTree.resizeSash(tree, path, index, pending);
      const previewBranch = PaneTree.nodeAt(preview, path);
      if (!branch || !previewBranch) return;
      const kids = Array.from(branchEl.children).filter((c) => !c.classList.contains('pane-sash'));
      previewBranch.children.forEach((child, i) => {
        if (kids[i]) kids[i].style.flexGrow = String(child.size); // the long form — see `buildNode`
      });
    };
    const finish = () => {
      if (endSashDrag !== finish) return; // already ended — a second ender for the same gesture
      endSashDrag = null;
      window.removeEventListener('pointermove', onMove, true);
      for (const type of SASH_END_EVENTS) window.removeEventListener(type, finish, true);
      sash.classList.remove('dragging');
      // The one line this whole rework exists for: it runs no matter which way the gesture ended.
      document.body.classList.remove('pane-sashing');
      if (pending) {
        // Commit what was dragged rather than discarding it. When the ender is a rebuild, `render()`
        // calls this BEFORE it walks the tree, so the new sizes are the ones it draws.
        pushUndo();
        tree = PaneTree.resizeSash(tree, path, index, pending);
        persist();
      }
      // The panes changed size, so every visible terminal needs a fresh fit.
      refitVisible();
    };
    endSashDrag = finish;
    // On `window`, in the capture phase: the sash is the one element this gesture cannot rely on.
    window.addEventListener('pointermove', onMove, true);
    for (const type of SASH_END_EVENTS) window.addEventListener(type, finish, true);
  }

  // --- Mode lifecycle -------------------------------------------------------

  function enable() {
    if (enabled) return;
    enabled = true;
    document.body.classList.add('display-mode-panes');
    wireOuterBand(); // once per document — see the function (#376)
    tree = loadTree();
    // Restore the focused pane, not just the tree (#352). A detached window has its own one-pane
    // tree and must not read the main window's choice.
    if (!(window.isDetachedWindow && window.isDetachedWindow())) {
      try { activeLeafId = localStorage.getItem(ACTIVE_KEY) || null; } catch { activeLeafId = null; }
    }
    activeLeaf(); // falls back to the first leaf when the stored id is not in this tree
    // The tools moved into the strips (O13/H2) — the singleton header would only
    // repeat them, for one of the panes, above all of them.
    if (typeof terminalHeader !== 'undefined' && terminalHeader) terminalHeader.style.display = 'none';
    startViewWatch();
    render();
    showActiveOrPlaceholder();
  }

  function disable() {
    if (!enabled) return;
    // End an in-flight sash drag before the panes go (#345). This path removes the pane DOM without
    // going through `render()`, so its hook does not fire — and `body.pane-sashing .terminal-container
    // { pointer-events: none }` is NOT scoped to panes mode, so the class left behind here would go
    // on killing clicks in the mode being switched INTO. A settings change is broadcast to every
    // window, so this is reachable while the user is still holding the mouse down.
    if (endSashDrag) endSashDrag();
    // Leaving panes mode takes every view tab with it, and this path never reaches `closeViewTab`
    // (#364). Stated as an explicit empty list, because the tree it would otherwise be derived from
    // is still standing at this point — and unlike `closePane` there is no observer left afterwards
    // that could correct a stale entry.
    reportWindowViews([]);
    // Write the final state NOW rather than letting the debounce fire into a torn-down mode — but
    // through the one guarded writer, so a detached window still writes nothing (#344).
    clearTimeout(persistTimer);
    writeTree();
    closePaneMenu();
    // Off FIRST, before anything that can call back in. `filePanelRelayout` below
    // re-shows the panel, and while this still read as active that took the panes
    // branch, re-adopted the element into a pane — and the pane was then removed
    // with the element inside it.
    enabled = false;
    tabMoveMode = false; // the panes it was navigating are about to go
    selectedTabIds.clear();
    selectionAnchor = null;
    document.getElementById('pane-selection-bar')?.remove();
    // Hand every shrunk buffer its full budget back (#352) — the setting is a panes-mode one, and
    // tabs and grid decide this for themselves.
    restoreScrollbackBudgets();
    stopViewWatch();
    // An instanced view has no home to be released to: outside panes mode the side panel shows one
    // thing at a time, so everything past the one it will show is closed here — answering its diff
    // instead of leaving the entry unreachable and the CLI waiting (#311).
    window.filePanelCollapseToOne?.();
    releaseAllViewElements();
    // Hand every container back to #terminals before the panes go, or they would
    // be removed with their pane and the session would lose its terminal.
    for (const entry of openSessions.values()) {
      if (entry && entry.element) {
        entry.element.classList.remove('visible');
        terminalsEl.appendChild(entry.element);
      }
    }
    terminalsEl.querySelectorAll('.pane-branch, .pane').forEach((el) => el.remove());
    document.body.classList.remove('display-mode-panes');
    tree = null;
    activeLeafId = null;

    // The side panel sizes itself from its own state; hosting it in a pane took
    // its width and its resize handle away, and nothing else re-applies them.
    if (typeof window.filePanelRelayout === 'function') window.filePanelRelayout();

    // Hand the single view back a visible terminal. Every mode decides what is on
    // screen through `.visible`, and this teardown cleared it on all of them — the
    // mode we are switching INTO does not re-establish it on its own, so without
    // this the terminal area is left blank until the next click.
    const entry = (typeof activeSessionId !== 'undefined' && activeSessionId)
      ? openSessions.get(activeSessionId) : null;
    if (entry) {
      // Same order as any other reveal (#337): flush while still non-visible so the pending chunk
      // parks behind the backlog, then reveal, then drain. This session was a background tab in a
      // pane a moment ago, so it can carry both — and without the drain the backlog would sit there
      // until some later showSession wrote it AFTER newer output.
      if (typeof flushTerminalBuffer === 'function') flushTerminalBuffer(activeSessionId);
      entry.element.classList.add('visible');
      if (typeof drainReplayBuffer === 'function') drainReplayBuffer(activeSessionId);
      if (typeof restoreTerminalWebgl === 'function') restoreTerminalWebgl(activeSessionId);
      requestAnimationFrame(() => {
        if (openSessions.get(activeSessionId) === entry && typeof safeFit === 'function') safeFit(entry);
      });
    }
  }

  // --- Hooks the rest of the renderer calls ---------------------------------

  // showSession() routes here first in panes mode: activate the tab (adopting the
  // session into the active pane when it has no tab yet) and let the caller carry
  // on with the sidebar highlight, the fit and the focus.
  function show(sessionId) {
    if (!enabled || !openSessions.has(sessionId)) return false;
    const tabId = tabIdFor(sessionId);
    let leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) {
      tree = PaneTree.addTab(tree, activeLeaf().id, makeTerminalTab(sessionId));
      leaf = PaneTree.leafOfTab(tree, tabId);
    } else {
      tree = PaneTree.setActiveTab(tree, leaf.id, tabId);
    }
    const leaving = activeLeafId;
    activeLeafId = leaf.id;
    dropEmptyPaneLeft(leaving);
    // The caret belongs to the session being shown, and it has to be claimed AFTER the render that is
    // about to move its container — see `applyPendingFocus` (#425).
    requestFocus(sessionId);
    scheduleRender();
    persist();
    return true;
  }

  // A session moved into this window with no process (#332). It has no mount to hang a tab off, and
  // every other way into the tree needs one: `show` refuses a session that is not in `openSessions`,
  // and `adoptOrphans` walks that map. So this is the one path that puts an UNMOUNTED session into the
  // tree — and what it produces is nothing new, just the tab a saved layout restores: `buildTab` marks
  // it dormant and the pane body draws the "not running / Launch" placeholder (#318).
  //
  // It becomes the pane's active tab by default, like a mounted adopt does (`mountOnce(session, true)`):
  // the user moved this session here, so showing it is the feedback that the move happened. The boot
  // reconcile passes `{ activate: false }` — it is filling tabs in BEHIND whatever the window is already
  // showing, and stealing the front there would undo the choice the boot path just made.
  //
  // Refused without a session record. `buildTab` reads the name from `sessionMap`, so a tab without one
  // is an unnamed placeholder the user cannot identify — worse than the move being declined.
  function openDormantTab(sessionId, opts) {
    if (!enabled || !tree || !sessionId) return false;
    if (typeof sessionMap === 'undefined' || !sessionMap.has(sessionId)) return false;
    const activate = !opts || opts.activate !== false;
    const tabId = tabIdFor(sessionId);
    let leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) {
      const target = activeLeaf();
      // `addTab` makes what it adds the pane's active tab, so a non-activating call has to put the
      // previous choice back rather than the model growing a second way to add one.
      const wasActive = target.activeTabId;
      tree = PaneTree.addTab(tree, target.id, makeTerminalTab(sessionId));
      leaf = PaneTree.leafOfTab(tree, tabId);
      if (!leaf) return false;
      if (!activate && wasActive) tree = PaneTree.setActiveTab(tree, leaf.id, wasActive);
    }
    if (activate) {
      tree = PaneTree.setActiveTab(tree, leaf.id, tabId);
      activeLeafId = leaf.id;
    }
    scheduleRender();
    persist();
    return true;
  }

  // A live session moved to a new id (#346). `/clear` in a CLI is the everyday case: the CLI starts
  // a fresh session, main reports it, and the renderer re-keys openSessions/sessionMap onto the new
  // id. A tab id is DERIVED from the session id (`tabIdFor`), so without this the tree keeps naming
  // the retired one — the pane finds nothing mounted behind its own active tab and falls back to
  // the empty state, while `adoptOrphans` gives the session that IS running a fresh tab in whatever
  // pane happens to be active. Rename in place, so the session stays where the user put it.
  function rekeySession(oldId, newId) {
    if (!enabled || !tree || !oldId || !newId || oldId === newId) return false;
    const fromTabId = tabIdFor(oldId);
    const leaf = PaneTree.leafOfTab(tree, fromTabId);
    if (!leaf) return false;
    // The new id can already have a tab of its own — a dormant one from a saved layout. Then there
    // is nothing to rename onto: retire the old tab and leave the existing one where it is.
    tree = PaneTree.leafOfTab(tree, tabIdFor(newId))
      ? PaneTree.closeTab(tree, leaf.id, fromTabId)
      : PaneTree.replaceTab(tree, leaf.id, fromTabId, makeTerminalTab(newId));
    activeLeaf();
    scheduleRender();
    persist();
    return true;
  }

  // A session went away (closed tab, LRU eviction, exit auto-close). Its tab goes
  // with it; a pane emptied by that disappears (#309 O10).
  function dropSession(sessionId) {
    if (!enabled || !tree) return;
    const tabId = tabIdFor(sessionId);
    const leaf = PaneTree.leafOfTab(tree, tabId);
    if (!leaf) return;
    tree = PaneTree.closeTab(tree, leaf.id, tabId);
    activeLeaf();
    scheduleRender();
    persist();
  }

  // Repaint the tab dots from the live status without rebuilding the strips — a
  // rebuild on every busy edge would churn the DOM and cancel a drag (#124).
  function patchStatuses() {
    if (!enabled) return false;
    // Terminal tabs only. The selector used to take the view tabs too (#352) — they carry no
    // `data-session-id`, so every status tick ran `sessionMap.get(undefined)` once per view tab and
    // then stripped the status classes off an element that never had one.
    const tabs = terminalsEl.querySelectorAll('.pane-strip .session-tab[data-session-id]');
    if (!tabs.length) return false;
    const runtime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
    const statusClasses = (typeof SESSION_STATUS_CLASSES !== 'undefined') ? SESSION_STATUS_CLASSES : [];
    for (const tab of tabs) {
      const session = sessionMap.get(tab.dataset.sessionId);
      const status = (session && typeof getSessionStatus === 'function') ? getSessionStatus(session, runtime) : null;
      const dot = tab.querySelector('.session-tab-dot');
      if (statusClasses.length) {
        tab.classList.remove(...statusClasses);
        if (dot) dot.classList.remove(...statusClasses);
      }
      if (status) {
        tab.classList.add(status.className);
        if (dot) dot.classList.add(status.className);
      }
      tab.classList.toggle('subagent-active',
        typeof subagentActiveSessions !== 'undefined' && subagentActiveSessions.has(tab.dataset.sessionId));
      // The muting is not a status class, so the strip above does not take it off — and a session that
      // pairs with its record late must lose it (#460). The tooltip that carries the sentence is rebuilt
      // by refreshChrome, which every caller of this runs immediately after.
      if (dot) {
        dot.classList.toggle('status-unpaired',
          typeof noStoreRecordFor === 'function' && !!noStoreRecordFor(tab.dataset.sessionId));
      }
    }
    return true;
  }

  // Rebuild the strips only (tools follow the running state, so a process that
  // exits has to drop its stop button).
  function refreshChrome() {
    if (!enabled || !tree) return;
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      const leaf = PaneTree.leaves(tree).find((l) => l.id === pane.dataset.paneId);
      const strip = pane.querySelector('.pane-strip');
      if (!leaf || !strip) continue;
      pane.replaceChild(buildStrip(leaf), strip);
      const bar = pane.querySelector('.pane-actionbar');
      if (toolsPlacement !== 'bar') {
        if (bar) bar.remove();
        continue;
      }
      // A rename in flight lives in THIS bar's name element (#358), and this function runs on every
      // session's busy/idle edge — so rebuilding it would tear the edit out from under the user while
      // some other session merely started working. The bar carries a name, a project and a status dot;
      // none of them is worth a lost sentence, so the pane keeps its chrome until the edit ends.
      if (window.isSessionRenaming?.(bar?.querySelector('.pane-actionbar-name'))) continue;
      const next = buildActionBar(leaf);
      if (bar && next) pane.replaceChild(next, bar);
      else if (bar) bar.remove();
      else if (next) pane.insertBefore(next, pane.querySelector('.pane-body'));
    }
    // A chrome refresh rebuilds the strips, which resets their scroll offset — so the active tab has
    // to be brought back into view here too, not only after a full render.
    updateStripChrome();
  }

  function applySettings(g, opts) {
    g = g || {};
    // The order arriving sessions should become tabs in (#369). Handed in by the mode switch, which is
    // the only caller that knows one — coming out of grid, the tabs should follow the order the cards
    // were in on screen rather than the order they happened to be mounted in. Read once, by the
    // adoption below, and dropped: it describes THIS switch and nothing after it.
    pendingAdoptOrder = (opts && Array.isArray(opts.adoptOrder) && opts.adoptOrder.length)
      ? opts.adoptOrder.slice()
      : null;
    const prevPlacement = toolsPlacement;
    toolsPlacement = g.paneToolsPlacement === 'strip' ? 'strip' : 'bar';
    closeBehavior = g.tabCloseBehavior === 'stopSession' ? 'stopSession' : 'closeView';
    terminalCloseBehavior = g.terminalCloseBehavior === 'keep' ? 'keep' : 'kill';
    middleClickCloses = g.tabMiddleClickCloses !== false;
    closeEmptyPanes = g.paneCloseEmpty === true;
    const prevScrollback = backgroundScrollback;
    const wanted = Number(g.paneBackgroundScrollback);
    backgroundScrollback = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 0;
    // Turned OFF while the mode is running: nothing else would ever raise a shrunk buffer again,
    // because `applyBackgroundScrollback` returns early once the setting is 0.
    if (enabled && prevScrollback && !backgroundScrollback) {
      backgroundScrollback = prevScrollback;
      restoreScrollbackBudgets();
      backgroundScrollback = 0;
    }
    if (resolveSessionDisplayMode(g.sessionDisplayMode) === 'panes') {
      const wasEnabled = enabled;
      enable();
      // Moving the tools between the bar and the strip changes the pane's shape,
      // so an already-running mode has to rebuild (enable() no-ops when it is).
      if (wasEnabled && prevPlacement !== toolsPlacement) render();
    } else {
      disable();
    }
  }

  // Focus the n-th pane in render order (1-based) — the Ctrl/Cmd+Shift+1..9 chord.
  function focusPaneByIndex(n) {
    if (!enabled || !tree) return false;
    const leaf = PaneTree.leaves(tree)[n - 1];
    if (!leaf) return false;
    focusPane(leaf.id);
    return true;
  }

  // Move focus to the pane that lies in `direction` ON SCREEN (#350).
  //
  // This used to index `PaneTree.leaves()` in render order and wrap, which is not a direction: in an
  // L-shaped arrangement "up" from the top-right pane went left and "right" went down. Grid mode in
  // this same app measures bounding rectangles and gets it right, and `pickGridNeighbor` is that
  // geometry already factored out — dead zone on the primary axis, cross-axis distance weighted so
  // the same row or column wins ties. Panes gets the same answer from the same code.
  //
  // No wrap. An arrow that walks off the edge of the layout does nothing, which is what every tiling
  // window manager does; wrapping is how the old version turned "up" into "somewhere else".
  function focusNeighbourPane(direction) {
    const target = neighbourPaneId(direction);
    if (!target) return false;
    focusPane(target);
    return true;
  }

  // The pane that lies in `direction` from the active one, on screen. Shared with the move mode below,
  // so "which pane is to my left" has one answer whether you are moving the focus or a tab.
  function neighbourPaneId(direction) {
    if (!enabled || !tree) return null;
    const panes = [...terminalsEl.querySelectorAll('.pane')];
    if (panes.length < 2) return null;
    const at = panes.findIndex((p) => p.dataset.paneId === activeLeafId);
    if (at < 0) return null;
    const rects = panes.map((p) => p.getBoundingClientRect());
    const best = (typeof pickGridNeighbor === 'function') ? pickGridNeighbor(rects, at, direction) : -1;
    return best < 0 ? null : panes[best].dataset.paneId;
  }

  // --- Selection and bulk actions (#356) -------------------------------------
  //
  // Grid has no selection model — its "bulk actions" act on whatever the status chips admit — so this
  // is new rather than a port. It spans the whole TREE, not one pane: a bulk action is about sessions,
  // and which pane they happen to sit in is not part of the question.
  //
  // Only terminal tabs can be selected. A view tab has no process to stop and no session to tag, so
  // including one would mean every action explaining what it did not do to it.

  const selectedTabIds = new Set();
  // Where a Shift-click measures its range from: the last tab the user picked deliberately.
  let selectionAnchor = null;

  const isTabSelected = (tabId) => selectedTabIds.has(tabId);

  function selectableTabsOf(leaf) {
    return leaf ? leaf.tabs.filter((t) => !!sessionOfTab(t)) : [];
  }

  function toggleTabSelection(leaf, tab) {
    if (!sessionOfTab(tab)) return;
    if (selectedTabIds.has(tab.id)) selectedTabIds.delete(tab.id);
    else selectedTabIds.add(tab.id);
    selectionAnchor = selectedTabIds.has(tab.id) ? tab.id : null;
    refreshSelectionUi();
  }

  // Shift-click takes the range within ONE strip. Across panes there is no "between" a user could
  // predict — the tree is two-dimensional and the tabs of two panes have no shared order.
  function extendTabSelection(leaf, tab) {
    const tabs = selectableTabsOf(leaf);
    const to = tabs.findIndex((t) => t.id === tab.id);
    if (to < 0) return;
    const from = tabs.findIndex((t) => t.id === selectionAnchor);
    if (from < 0) { toggleTabSelection(leaf, tab); return; }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    for (let i = lo; i <= hi; i++) selectedTabIds.add(tabs[i].id);
    refreshSelectionUi();
  }

  function clearTabSelection() {
    if (!selectedTabIds.size) return;
    selectedTabIds.clear();
    selectionAnchor = null;
    refreshSelectionUi();
  }

  // Drop anything the tree no longer holds. Called after every rebuild: a session that exited took its
  // tab with it, and a selection naming a tab nobody can see is a count the user cannot explain.
  function pruneTabSelection() {
    if (!selectedTabIds.size) return;
    const live = new Set();
    for (const leaf of PaneTree.leaves(tree)) for (const t of leaf.tabs) live.add(t.id);
    for (const id of [...selectedTabIds]) if (!live.has(id)) selectedTabIds.delete(id);
    if (selectionAnchor && !live.has(selectionAnchor)) selectionAnchor = null;
  }

  /** The selected tabs, in visual order, as `{ leaf, tab }` — the shape every action needs. */
  function selectedEntries() {
    const out = [];
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) if (selectedTabIds.has(tab.id)) out.push({ leaf, tab });
    }
    return out;
  }

  function refreshSelectionUi() {
    for (const el of terminalsEl.querySelectorAll('.pane-strip .session-tab')) {
      el.classList.toggle('selected', selectedTabIds.has(el.dataset.tabId));
    }
    renderSelectionBar();
  }

  /**
   * The bar that appears ONLY while something is selected, so the mode loses no height at rest.
   *
   * It floats over the tree rather than taking a row from it: a bar that pushed the panes down would
   * resize every terminal in the window each time a selection started and ended.
   */
  function renderSelectionBar() {
    const existing = document.getElementById('pane-selection-bar');
    const entries = selectedEntries();
    if (!enabled || !entries.length) { if (existing) existing.remove(); return; }

    const bar = existing || document.createElement('div');
    bar.id = 'pane-selection-bar';
    bar.className = 'pane-selection-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Selected tabs');
    bar.replaceChildren();

    const running = entries.map(({ tab }) => sessionOfTab(tab)).filter((id) => id && sessionIsLive(id));
    const count = document.createElement('span');
    count.className = 'pane-selection-count';
    count.textContent = `${entries.length} selected`;
    bar.appendChild(count);

    const action = (label, handler, opts = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-session-secondary-btn' + (opts.danger ? ' danger' : '');
      b.textContent = label;
      if (opts.disabled) b.disabled = true;
      else b.addEventListener('click', handler);
      bar.appendChild(b);
      return b;
    };

    action('Stop', () => stopSelectedSessions(), {
      danger: true,
      // Nothing running in the selection: the button would ask a question with no answer.
      disabled: !running.length,
    });
    action('Close', () => closeSelectedTabs());
    action('Tag…', () => tagSelectedSessions());
    action('Clear', () => clearTabSelection());

    if (!existing) document.body.appendChild(bar);
  }

  async function stopSelectedSessions() {
    const ids = selectedEntries().map(({ tab }) => sessionOfTab(tab)).filter((id) => id && sessionIsLive(id));
    if (!ids.length) return;
    if (typeof showControlDialog === 'function') {
      const ok = await showControlDialog({
        title: 'Stop sessions',
        message: ids.length === 1
          ? 'This stops one running process. Its history stays either way.'
          : `This stops ${ids.length} running processes. Their history stays either way.`,
        confirmLabel: ids.length === 1 ? 'Stop session' : 'Stop sessions',
        cancelLabel: 'Cancel',
        tone: 'danger',
      });
      if (!ok) return;
    }
    for (const id of ids) {
      try { window.api.stopSession(id); } catch { /* already gone */ }
    }
    clearTabSelection();
  }

  // Down the path a single tab's × already takes, one question for the set — `closeTabs` is the
  // function #349 built for exactly this, so the configured close behaviour still decides per session.
  async function closeSelectedTabs() {
    const tabs = selectedEntries().map(({ tab }) => tab);
    if (!tabs.length) return;
    clearTabSelection();
    await closeTabs(tabs);
  }

  /**
   * Add a tag to every selected session (#356).
   *
   * ADD, not replace: tags are per session and the selection is a set of different ones, so writing a
   * single list over all of them would silently drop whatever each already had. The dialog says so.
   */
  async function tagSelectedSessions() {
    const ids = selectedEntries().map(({ tab }) => sessionOfTab(tab)).filter(Boolean);
    if (!ids.length || typeof showControlDialog !== 'function') return;
    const tag = await showControlDialog({
      title: ids.length === 1 ? 'Tag session' : `Tag ${ids.length} sessions`,
      message: 'The tag is added to what each session already has; nothing is replaced.',
      prompt: { placeholder: 'Tag name', maxLength: 40 },
      confirmLabel: 'Add tag',
    });
    if (!tag) return;
    let failed = 0;
    for (const id of ids) {
      try {
        const current = (await window.api.sessionTagsGet(id)) || [];
        if (!current.includes(tag)) await window.api.sessionTagsSet(id, current.concat(tag));
      } catch { failed++; }
    }
    clearTabSelection();
    if (typeof showControlToast === 'function') {
      showControlToast(failed
        ? { message: `Tagged ${ids.length - failed} of ${ids.length} sessions — ${failed} could not be written` }
        : { message: `Tagged ${ids.length} session${ids.length === 1 ? '' : 's'} “${tag}”` });
    }
    if (typeof refreshSidebar === 'function') refreshSidebar();
  }

  // --- Keyboard move mode (#356) --------------------------------------------
  //
  // Grid has one; panes had arrows, splits and drag, and no keyboard way to say "move this tab there".
  // Same shape as grid's so the gesture transfers: a chord enters it, arrows act, Escape or Enter
  // leaves, and every step is announced through the strip's live region (#351).
  //
  // What it moves is the ACTIVE TAB of the active pane — the same subject the rest of the pane
  // shortcuts act on, so there is no second notion of "the tab you mean".

  let tabMoveMode = false;

  const isTabMoveModeActive = () => tabMoveMode;

  // Put the marker back on whichever pane is active now. Called by every rebuild, so the class is a
  // projection of the state rather than the state itself.
  function markMoveModePane() {
    if (!enabled) return;
    for (const pane of terminalsEl.querySelectorAll('.pane-move-mode')) pane.classList.remove('pane-move-mode');
    if (!tabMoveMode) return;
    const pane = terminalsEl.querySelector('.pane[data-pane-id="' + activeLeafId + '"]');
    if (pane) pane.classList.add('pane-move-mode');
  }

  function enterTabMoveMode() {
    if (!enabled || !tree || tabMoveMode) return false;
    const leaf = activeLeaf();
    const tab = leaf && leaf.tabs.find((t) => t.id === leaf.activeTabId);
    if (!tab) return false;
    if (PaneTree.leaves(tree).length < 2) {
      announcePane('Move mode needs a second pane. Split this one first.');
      return false;
    }
    tabMoveMode = true;
    markMoveModePane();
    announcePane(`Move mode. ${tabBaseName(tab)}. Arrows move it to the pane in that direction, Escape leaves.`);
    return true;
  }

  function exitTabMoveMode({ announce = false } = {}) {
    if (!tabMoveMode) return;
    tabMoveMode = false;
    markMoveModePane();
    if (announce) announcePane('Move mode off.');
  }

  /**
   * Move the active tab into the pane that lies in `direction`, and follow it.
   *
   * Following is the point: the mode exists to place a tab, and a user who cannot see where it went
   * has to leave the mode to find out. The pane it left collapses if that was its last tab, which is
   * the same rule every other close path follows (#309 O10) — so the mode ends when the tree it was
   * navigating no longer has two panes.
   */
  function moveTabInDirection(direction) {
    if (!enabled || !tree || !tabMoveMode) return false;
    const leaf = activeLeaf();
    const tab = leaf && leaf.tabs.find((t) => t.id === leaf.activeTabId);
    const target = neighbourPaneId(direction);
    if (!tab || !target) {
      announcePane(`No pane to the ${direction}.`);
      return false;
    }
    pushUndo();
    tree = PaneTree.moveTab(tree, { fromLeafId: leaf.id, toLeafId: target, tabId: tab.id });
    activeLeafId = target;
    activeLeaf(); // the source pane can have collapsed away with its last tab
    render();
    persist();
    showActiveOrPlaceholder();
    const panes = PaneTree.leaves(tree);
    const at = panes.findIndex((l) => l.id === activeLeafId);
    announcePane(`${tabBaseName(tab)} moved ${direction}. Pane ${at + 1} of ${panes.length}.`);
    // Nothing left to move between: the source pane went with the tab.
    if (panes.length < 2) exitTabMoveMode({ announce: true });
    return true;
  }

  // --- Zoom (#350) ----------------------------------------------------------
  // A pane can only be read properly by dragging a sash, which has a 5 % floor and no reset. Zoom is
  // the answer every comparable tool has (tmux `prefix z`, Windows Terminal `togglePaneZoom`, iTerm2,
  // VS Code) and it is a VIEW state, not a layout change: the tree is untouched, so leaving zoom puts
  // the arrangement back exactly as it was. Nothing is persisted — a zoom is where you are, not how
  // your workspace is set up.
  let zoomedLeafId = null;

  function applyZoom() {
    const on = !!zoomedLeafId && PaneTree.leaves(tree || null).some((l) => l.id === zoomedLeafId);
    if (!on) zoomedLeafId = null;
    terminalsEl.classList.toggle('pane-zoomed', on);
    for (const pane of terminalsEl.querySelectorAll('.pane')) {
      pane.classList.toggle('pane-zoom-target', on && pane.dataset.paneId === zoomedLeafId);
    }
  }

  function toggleZoom(leafId) {
    if (!enabled || !tree) return false;
    const target = leafId || activeLeafId;
    if (!target || !PaneTree.leaves(tree).some((l) => l.id === target)) return false;
    zoomedLeafId = (zoomedLeafId === target) ? null : target;
    if (zoomedLeafId) focusPane(zoomedLeafId);
    applyZoom();
    // Both terminals just changed box: the one filling the area and the ones it covered.
    refitVisible();
    return true;
  }

  // Step through the ACTIVE PANE's own tabs. The bracket pair next to this one walks the sidebar
  // order across every pane, which is why it reads as a lie when you are looking at one strip.
  function navigateTabInPane(delta) {
    if (!enabled || !tree) return false;
    const leaf = activeLeaf();
    if (!leaf || leaf.tabs.length < 2) return false;
    const at = leaf.tabs.findIndex((t) => t.id === leaf.activeTabId);
    const next = leaf.tabs[((at < 0 ? 0 : at) + delta + leaf.tabs.length) % leaf.tabs.length];
    if (!next) return false;
    if (isViewTab(next)) {
      tree = PaneTree.setActiveTab(tree, leaf.id, next.id);
      render();
      persist();
      return true;
    }
    openFromTab(leaf, next, sessionOfId(sessionOfTab(next)));
    return true;
  }

  // Close the active pane's active tab — the keyboard route to the × on it.
  function closeActiveTab() {
    if (!enabled || !tree) return false;
    const leaf = activeLeaf();
    const tab = leaf && leaf.tabs.find((t) => t.id === leaf.activeTabId);
    if (!tab) return false;
    closeTabFromUi(leaf.id, tab);
    return true;
  }

  function closeActivePane() {
    if (!enabled || !tree || !activeLeafId) return false;
    if (PaneTree.leaves(tree).length === 1) return false;
    closePane(activeLeafId);
    return true;
  }

  /**
   * The session this window is SHOWING — the active pane's active tab (#366).
   *
   * Not the same question as `activeSessionId`, and the difference is the whole of #366: that global
   * only moves when a session is shown in a terminal, and selecting a tab whose session is not
   * running never gets that far (`openFromTab`). The layout knows anyway, because the tab is
   * selected in it either way. `null` when the active tab is one of the app's own views, which is
   * not a session and must not be named as one.
   */
  function shownSessionId() {
    const leaf = activeLeaf();
    if (!leaf) return null;
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    return tab && !isViewTab(tab) ? sessionOfTab(tab) : null;
  }

  /**
   * The label of the view tab that is showing, or null when a session is.
   *
   * `shownSessionId`'s counterpart, and it exists for the same reason: a window has to be named
   * after what it shows, and since #370 what it shows can be a view with no session anywhere near
   * it. The tab's own label, so the window says exactly what its tab says.
   */
  function shownViewLabel() {
    const leaf = activeLeaf();
    if (!leaf) return null;
    const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
    return tab && isViewTab(tab) ? viewTabLabel(tab) : null;
  }

  /** Every view tab's label, in tab order — the "+N" half of a view window's title (#370). */
  function viewTabLabels() {
    const out = [];
    if (!enabled || !tree) return out;
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) if (isViewTab(tab)) out.push(viewTabLabel(tab));
    }
    return out;
  }

  /**
   * Every session this window holds, in tab order. Dormant sessions included — a tab is a tab
   * whether or not it has a process, and a window that holds three must not call itself "+1".
   */
  function sessionIdsInLayout() {
    const ids = [];
    for (const leaf of PaneTree.leaves(tree)) {
      for (const tab of leaf.tabs) {
        if (isViewTab(tab)) continue;
        const id = sessionOfTab(tab);
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }

  window.panesView = {
    active: () => enabled,
    shownSessionId,
    sessionIdsInLayout,
    shownViewLabel,
    viewTabLabels,
    applyRestoredLayout,
    // A sidebar drag that ends nowhere leaves the hint standing — the pane never saw a drop, so it
    // never cleared it (#373). The sidebar's `dragend` is the only thing that knows.
    clearDropFeedback: () => clearDropFeedback(),
    // Exposed for the suite: the drop's two landings, without a DragEvent to synthesise.
    dropSessionInto,
    dropSessionIntoSplit,
    dropSessionIntoRootSplit,
    // The two questions a drop asks about a point, exposed so the suite can ask them without a
    // DragEvent: how deep a pane's edge reaches, and whether a point is in the area's outer band.
    edgeDepth,
    outerZoneAt: (point, depth) => outerZoneAt(point, depth),
    // What a drag in ANOTHER window asks of this one (#375).
    dropTargetAt,
    showPlacementHint,
    applyPlacement,
    // The sidebar's drag is a source like a tab is, so it asks the same question while it is held and
    // reads the same answer when it lands (#373 + #375).
    probeRemote: (e) => probeRemote(e),
    remoteAimFor: (windowId) => ((remoteAim && remoteAim.windowId === windowId) ? remoteAim.placement : null),
    dropRemoteHints,
    // What a kind is called, for a window that has to name itself before it holds any tab at all
    // (#370). Answered from `VIEW_KINDS`, so a new view is named in one place.
    viewKindTitle: (kind) => (VIEW_KINDS[kind] ? VIEW_KINDS[kind].title : null),
    // The file a view shows is not a tab change, so nothing above would report it (#371). The
    // openers say so themselves.
    reportViews: () => reportWindowViews(),
    // Exposed for the suite: the rule for which views may leave is derived from what a receiving
    // window could fill, and a rule that is derived is one a test should be able to ask about.
    viewCanLeaveWindow: (kind) => canLeaveWindow({ id: 'x', kind }),
    applySettings,
    show,
    openDormantTab,
    rekeySession,
    dropSession,
    patchStatuses,
    refreshChrome,
    render: () => render(),
    showActiveOrPlaceholder,
    openViewTab,
    closeViewTab,
    hasViewTab: (kind, ref) => !!(enabled && tree && PaneTree.leafOfTab(tree, viewTabId(kind, ref))),
    splitActivePane,
    closePane,
    closeActivePane,
    closeActiveTab,
    focusPaneByIndex,
    focusNeighbourPane,
    navigateTabInPane,
    toggleZoom,
    isZoomed: () => !!zoomedLeafId,
    undoLayout,
    tileAllSessions,
    selectTab: (tabId) => { selectedTabIds.add(tabId); refreshSelectionUi(); },
    selectedTabCount: () => selectedTabIds.size,
    clearTabSelection,
    enterTabMoveMode,
    exitTabMoveMode,
    isTabMoveModeActive,
    moveTabInDirection,
  };

  // A window resize changes every pane's box; refit what is on screen.
  window.addEventListener('resize', () => { if (enabled) refitVisible(); });
})();
