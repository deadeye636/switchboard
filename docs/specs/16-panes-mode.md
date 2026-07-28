# 16 — Panes mode (VS-Code-style editor groups)

**Status: built** (#309 the mode and the tree, #310 the typed views). One gap is open by decision:
views are one instance per kind, not one per pane — #311. Written *before* the build, so its job is
different from specs 01–15: it is the **record of the layout options and why one was chosen**, and a
later rework should read it before re-running the argument.

**As built.** `views/pane-tree.js` (pure model, 39 tests) + `views/panes-view.js` (the DOM half) ship
the tree, the per-pane strip, the `…` pane menu (A), tab drag with the 10 % edge split, sashes,
localStorage persistence and the two shortcuts (#309). The typed views followed (#310): preview and
diff, plus message history, plan, activity and memory, are pane tabs.

Three later fixes belong to the record:

- **The pane actions also answer a right-click** (#312) — on a tab together with that tab's own
  actions, on the strip or the session bar alone. All three entry points build their items in one
  place, and the subject is the tab that was clicked, not whichever one is active.
- **A tab drag shows where it will land** (#313). The caret needed a model fix: `moveTab` read its
  `index` as a position *after* the dragged tab was lifted out, while its only caller meant the gap it
  could see — so every rightward drag landed one tab too far and dropping a tab last was impossible.
- **An exited session does not leave a live-looking tab** (#317, #318). A deliberate stop closes the
  tab in panes mode too (`closeTabNow` was guarded on tabs mode alone). And clicking a tab whose
  session has no process no longer opens it — that path spawns a fresh CLI, which is the opposite of
  what clicking a dead tab means. The pane says so instead and offers a **Launch** button: the one
  empty state that carries an action, because it is the one case where opening costs a process. A tab
  whose session is still running elsewhere is unaffected — clicking it attaches, as before.

Two things diverge from the plan above and are load-bearing:

- **H2 became a setting, not a decision.** `paneToolsPlacement` picks `bar` (default — the session
  tools on a row of their own, §4.2 H1) or `strip` (H2). Seeing H2 in place is what changed the call;
  both render paths are cheap, so the choice moved to the user.
- **One instance per view kind, not one per pane.** Each of these views is a single element with
  module-wide state, so the tab moves to the pane you opened it from instead of being duplicated.
  Two previews or two diffs side by side therefore do not work yet — that is #311, scoped to preview
  and diff and sequenced after detach (#2). Message history, plan, activity and memory stay
  single-instance deliberately: they are read, not compared, and the transcript viewer's state
  (current session, search hits, bookmarks, subagent watches) would have to be unpicked for no gain.

Issue: #309 · builds the ownership model that detachable windows (#2) then consume.

## 1 · Problem

Sessions render either as a **grid mosaic** (all sessions auto-tiled, column count from window width)
or in **single view**, and `sessionDisplayMode = tabs` puts a tab strip over that single view. Neither
lets someone arrange *chosen* sessions side by side: grid decides the arrangement, tabs show one at a
time. On a wide screen that wastes the screen; on a narrow one grid collapses to a long vertical list.

Panes mode adds the third possibility: a tiled split tree the way VS Code lays out editor groups.

## 2 · The model

Taken from VS Code's `vs/base/browser/ui/grid/grid.ts` and `editorDropTarget.ts`:

- A **branch** node has an orientation (`row`/`col`) and children; a **leaf** is one pane holding a tab
  list and an active tab. The root carries the orientation. Sizes are fractions, never pixels.
- Adding in a direction: if the direction matches the parent's orientation, insert at an index;
  otherwise wrap the leaf in a new perpendicular branch. That single rule produces every layout.
- Serialised shape is the same tree — `{type: 'branch'|'leaf', size, …}` — so persistence is the model,
  not a second format.
- Drag & drop: an editor-style drag uses a **10 % edge zone per axis**. Edge = split in that direction,
  centre = move the tab into that pane.

**A tab is a typed view, not a session id** (see O11/O12 below). `{id, kind, ref}` with
`kind ∈ terminal | preview | diff | plan | stats | memory | jsonl`. This is the decision with the
longest reach: it is what lets a preview sit next to the terminal it belongs to, and what makes a
detached window (#2) "a tree with one leaf" instead of a separate mechanism.

## 3 · Decision record

| ID | Decision | Note |
|---|---|---|
| O1 | Third mode `panes` beside `legacy` and `tabs` | `legacy` stays the default; non-breaking |
| O2 | Grid stays a mode of its own | grid = *automatic overview of all sessions*; panes = *manually arranged workspace*. See §4.4 |
| O3 | Tiled split tree, no free-floating windows inside the main area | |
| O4 | No cap on simultaneously rendered terminals | |
| O6 | Pane actions live in the `…` menu | variant **A**, §4.1 |
| O7 | A sidebar click opens in the **active** pane | |
| O8 | Tree persists in localStorage, sizes as fractions | next to `gridLayout`; debounced writes |
| O10 | Closing a pane's last tab removes the pane, the neighbour takes the space | |
| O11 | Plan, stats, memory and JSONL views may live in panes | |
| O12 | Preview and diff are ordinary tabs | variant **P2**, §4.3 |
| O13 | Session tools merge into the pane's tab strip | variant **H2**, §4.2 |

Chosen combination: **A + H2 + P2**.

## 4 · The variants

Sketches use one pane strip, 34 px tall, the same geometry as `.session-tab` today.

### 4.1 Pane actions — where split / detach / close-pane live

```
A (chosen)   [ tab ][ tab ]                        ▾ │ …
B            [ tab ][ tab ]                    ▾ │ ⫽ ⤢ …
C            [ tab ][ tab ]                    ▾ │ (⫽ ⤢ … only on hover)
D            [ tab ][ tab ]                     ▾ │ ⫽▾ …
```

| | What it is | Trade-off |
|---|---|---|
| **A** *(chosen)* | Only `…`; split, move-to-new-window and close-pane are menu entries | **+** maximum tab width, and pane width is the scarce resource once the strip also carries session tools (H2). **−** split and detach are not discoverable without opening the menu — softened by #312, which put the same items on a right-click |
| B | Permanent split + detach icons, VS Code's own layout | **+** one click, self-explaining. **−** ~72 px per pane, on top of H2's tools |
| C | B, but the icons appear only on the hovered/active pane | **+** quiet at eight panes. **−** the space must stay reserved anyway or tabs jump on hover; nothing is discoverable without moving the mouse |
| D | A split button with a direction dropdown, detach into `…` | **+** middle ground. **−** two clicks to split anyway, unless a default direction is defined |

A won because H2 already spends the strip's right-hand space on the session tools. B's icons would have
to fold away at the width where they matter most.

### 4.2 The session bar — `#terminal-header` stops being a singleton

Today one bar serves the active session: name / pty title / id / shell, then messages, tasks,
variables, status, IDE-emulation chip, stop. With several panes each pane has its own active session.

```
H1   [ tab ][ tab ]                                  ▾ │ …
     api-gateway  4a2f  pwsh        ✉ ☑ ⚿  ● Running  IDE  ■      ← extra 33 px row
H2   [ tab ][ tab ]           ✉ ☑ ⚿ IDE ■ │ ▾ │ …               ← one 34 px row
H3   api-gateway  4a2f  pwsh                     ● Running  IDE ■  ← one bar above the whole tree
     [ tab ] │ [ tab ]
```

| | Chrome per pane | Trade-off |
|---|---|---|
| **H2** *(chosen)* | 34 px | **+** halves the chrome; everything that acts on a terminal sits above that terminal. **−** below ~420 px pane width the tools must fold into `…`; name, pty title, id and shell lose their place (tab label + tooltip carry them) |
| H1 | 67 px (34 + 33) | **+** the bar keeps its current content and position. **−** four stacked panes spend 268 px on chrome |
| H3 | 0 px extra | **+** almost no work. **−** the bar looks global but acts on one pane — a stop hitting the wrong process cannot be undone, and the distance to the meant terminal grows with every pane |

The running state is already carried by the tab dot, so H2 drops the word "Running" and shortens the
chip to "IDE".

### 4.3 Preview and diff

Today `file-panel.js` builds `#terminal-split` at startup, moves `#terminals` into it and puts the
preview/diff panel beside it (width in `filePanelWidth`).

| | | Trade-off |
|---|---|---|
| **P2** *(chosen)* | Preview and diff are tabs in the tree | **+** one layout system; a preview can sit beside the pane it belongs to; detach comes for free. **−** every view must become instantiable per pane and per window — the real cost driver, larger than the tree itself. Built in #310 as **one instance per kind** (the element moves to the pane you opened it from); per-pane instances for preview and diff are #311 |
| P1 | The panel stays fixed beside the whole tree | **+** no rework, no risk to the diff viewer. **−** with four panes nothing says which pane the preview belongs to; two layout systems run side by side |
| P3 | P1 first, P2 later | Only viable if the tree is typed from day one — otherwise the switch is a second rebuild. P2 makes it moot |

### 4.4 Why grid is not folded in

Grid was considered as "auto-arranged panes" and kept separate. It carries features panes do not have
an equivalent for: auto-tiling of *all* sessions with a column count derived from the window width, the
status filter, bulk actions over card selection, and the card chrome. VS Code has no counterpart —
"Arrange Groups: Grid" is even-sizing, not an overview. Folding grid in would mean moving filter and
bulk actions to the sidebar and rebuilding the a11y move mode on the tree; that is its own issue, not a
side effect of this one. The tree model is pure, so the option stays open.

## 5 · Constraints the code imposes

| Finding | Consequence |
|---|---|
| Grid already moves a live terminal container into a card and back (`grid-view.js` `wrapInGridCard` / `unwrapGridCards`) | Reparenting a running xterm is proven, not a research question. Refit after every move |
| `file-panel.js` builds `#terminal-split` at startup | Splitting the main area is precedent; under P2 this container goes away in panes mode |
| Tabs mode stacks all terminals in one box and switches by z-index (`style.css`, `body.display-mode-tabs`) | Same trick per pane — a switch inside a pane still causes no repaint |
| `addMcpToggle()` injects the IDE chip into a single `#terminal-header-controls` id | Needs a per-pane mount point, or the chip lands in the first pane only |
| Bare `Ctrl+\` is `0x1c` (SIGQUIT) to the pty; bare `Ctrl+3..8` are ESC/FS/GS/RS/US/DEL | Split and pane-focus shortcuts go on `Ctrl/Cmd+Shift+…`, matching every other binding in `shortcuts.js`. Pane navigation reuses `sessionNavArrows` rather than Alt+arrows, which are the terminal's word jump |
| The layout must exist before `session-restore` mounts terminals | Otherwise the first fit measures a box that is about to change |
| The display mode is applied **before** the restore mounts anything | So the stored layout can only be validated against the session list, never against `openSessions` — see `docs/ai/lessons.md` |
| The terminal container claims every drop it is offered | A tab drag has to carry its own MIME type so the container can ignore it |
| `WebglAddon.dispose()` leaves its canvases in the DOM | They cover the DOM renderer's rows; a demoted terminal shows nothing until they are removed |
| Several live WebGL terminals share one texture atlas (#118, #262) | WebGL follows the focused pane, exactly as it follows the focused grid card |

## 6 · Risks

| | Risk | Mitigation |
|---|---|---|
| R1 | WebGL — reparenting plus many visible terminals is the corner of #118 (stale atlas), #128 (context loss / stale fit) and #262 (atlas contention). Panes make grid's exceptional case the normal one | Reuse the existing context-loss/refit path; verify at eight panes before calling it done |
| R2 | Status drift — sidebar, tab and grid card already drifted apart four times (#124, #253, #257, #269); panes multiply the tab case | One render path for a tab's status, shared with `.status-dot.status-*` |
| R3 | Every `terminal-header*` lookup assumes a singleton | Convert them in one pass, `addMcpToggle()` included |
| R4 | Typed views (P2) touch every view module | Terminal tabs first; the tab type exists from day one so nothing is rebuilt later |

## 7 · Related

- **#2** — detachable windows, built after this and on top of it. A detached window loads the same
  `index.html?detached=<id>` and gets a tree with exactly one leaf, so it inherits the strip, the
  session bar and every terminal fix; the ghost tab #2's own plan proposed turned out to be
  unnecessary. The one thing panes had to learn: a detached window shares this origin's localStorage,
  so it neither loads nor writes the saved layout — otherwise popping a session out would overwrite
  the user's arrangement with a single pane.
- **Spec 08** — flexible grid layout. The pure-module shape (`grid-layout.js`: order, spans, pointer
  geometry, keyboard move mode, all DOM-free and require-able) is the template for `pane-tree.js`.
- **Spec 06** — grid bulk actions. One of the features that keeps grid a mode of its own (§4.4).
