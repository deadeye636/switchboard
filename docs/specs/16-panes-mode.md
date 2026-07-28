# 16 — Panes mode (VS-Code-style editor groups)

**Status: planned, not implemented.** Tracked as #309; the working plan lives in the issue's comment.
Unlike specs 01–15 this one is written *before* the build, so its job is different: it is the **record
of the layout options and why one was chosen**. When #309 lands, add the "As built" note; when a later
rework revisits the layout, this file is what keeps it from re-running the same argument.

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
| **A** *(chosen)* | Only `…`; split, move-to-new-window and close-pane are menu entries | **+** maximum tab width, and pane width is the scarce resource once the strip also carries session tools (H2). **−** split and detach are not discoverable without opening the menu |
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
| **P2** *(chosen)* | Preview and diff are tabs in the tree | **+** one layout system; a preview can sit beside the pane it belongs to; detach comes for free. **−** every view must become instantiable per pane and per window — the real cost driver of #309, larger than the tree itself |
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

## 6 · Risks

| | Risk | Mitigation |
|---|---|---|
| R1 | WebGL — reparenting plus many visible terminals is the corner of #118 (stale atlas), #128 (context loss / stale fit) and #262 (atlas contention). Panes make grid's exceptional case the normal one | Reuse the existing context-loss/refit path; verify at eight panes before calling it done |
| R2 | Status drift — sidebar, tab and grid card already drifted apart four times (#124, #253, #257, #269); panes multiply the tab case | One render path for a tab's status, shared with `.status-dot.status-*` |
| R3 | Every `terminal-header*` lookup assumes a singleton | Convert them in one pass, `addMcpToggle()` included |
| R4 | Typed views (P2) touch every view module | Terminal tabs first; the tab type exists from day one so nothing is rebuilt later |

## 7 · Related

- **#2** — detachable windows. Runs *after* this: with the tree owned by the window, a detached session
  is a tree with one leaf, and the ghost tab from #2's plan is no longer needed.
- **Spec 08** — flexible grid layout. The pure-module shape (`grid-layout.js`: order, spans, pointer
  geometry, keyboard move mode, all DOM-free and require-able) is the template for `pane-tree.js`.
- **Spec 06** — grid bulk actions. One of the features that keeps grid a mode of its own (§4.4).
