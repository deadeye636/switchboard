# 16 — Panes mode (VS-Code-style editor groups)

**Status: built** (#309 the mode and the tree, #310 the typed views, #311 per-pane preview and diff).
The other view kinds are one instance per kind by decision, not by omission — see §4.3. Written *before*
the build, so its job is
different from specs 01–15: it is the **record of the layout options and why one was chosen**, and a
later rework should read it before re-running the argument.

**As built.** `views/pane-tree.js` (pure model) + `views/panes-view.js` (the DOM half) ship
the tree, the per-pane strip, the `…` pane menu (A), tab drag with the 10 % edge split, sashes,
localStorage persistence and the two shortcuts (#309). The typed views followed (#310): preview and
diff, plus message history, plan, activity and memory, are pane tabs.

Four later fixes belong to the record:

- **The pane actions also answer a right-click** (#312) — on a tab together with that tab's own
  actions, on the strip or the session bar alone. All three entry points build their items in one
  place, and the subject is the tab that was clicked, not whichever one is active.
- **A tab drag shows where it will land** (#313). The caret needed a model fix: `moveTab` read its
  `index` as a position *after* the dragged tab was lifted out, while its only caller meant the gap it
  could see — so every rightward drag landed one tab too far and dropping a tab last was impossible.
- **The bar's indicators moved out of the tools** (#321). The status is a dot in front of the session
  name, as in the sidebar and on the tab; the IDE-emulation mark left the pane for the sidebar row.
  §4.2 has the reasoning.
- **An exited session does not leave a live-looking tab** (#317, #318). A deliberate stop closes the
  tab in panes mode too (`closeTabNow` was guarded on tabs mode alone). And clicking a tab whose
  session has no process no longer opens it — that path spawns a fresh CLI, which is the opposite of
  what clicking a dead tab means. The pane says so instead and offers a **Launch** button: the one
  empty state that carries an action, because it is the one case where opening costs a process. A tab
  whose session is still running elsewhere is unaffected — clicking it attaches, as before. The tab
  reads as ended (dimmed, struck through) when `launchExitedSessions` says so — a marker cleared the
  moment a live PTY appears under the id, so a tab restored from a saved layout whose session never ran
  *this run* is not "exited". Its menu also gained **Stop & close** and **Relaunch** (#312).

Two things diverge from the plan above and are load-bearing:

- **H2 became a setting, not a decision.** `paneToolsPlacement` picks `bar` (default — the session
  tools on a row of their own, §4.2 H1) or `strip` (H2). Seeing H2 in place is what changed the call;
  both render paths are cheap, so the choice moved to the user.
- **One instance per view kind, not one per pane** — except preview and diff. Each of these views is a
  single element with module-wide state, so the tab moves to the pane you opened it from instead of
  being duplicated. Preview and diff got an instance per tab in #311 (§4.3), which is what two diffs
  side by side needed. Message history, plan, activity and memory stay single-instance deliberately:
  they are read, not compared, and the transcript viewer's state (current session, search hits,
  bookmarks, subagent watches) would have to be unpicked for no gain. **Neither flavour can change
  window** — see O16.

### The audit pass (#343–#352)

Two agents read and drove the mode against VS Code, Windows Terminal, tmux, iTerm2 and Zed. Nothing
below was found by the suite — **no test loaded `panes-view.js` at all** until this pass, which is
the finding behind all the others. `test/helpers/panes-dom.js` is the jsdom harness that ended it.

Four defects that outlived whatever caused them:

- **The grid mosaic could be switched on inside panes mode** (#343) and pulled every terminal
  container out of its pane. The gate was a tabs-only test copied to four entry paths; it now sits in
  `showGridView()`, the funnel all five run through, and the boot heal clears the runtime flag as
  well as the stored one.
- **A detached window overwrote the layout on teardown** (#344) — `disable()` wrote past the guard
  `persist()` has. One writer, one check, per spec 17 §4.
- **A sash drag could never end** (#345). Its listeners hung on the sash, which every rebuild
  destroys, so `pane-sashing` stayed on `<body>`. Listeners live on `window` now, `pointercancel`
  and `lostpointercapture` end it, and both paths that destroy the sash finish the gesture first.
  Note for whoever reads that CSS: `body.pane-sashing .terminal-container` LOSES on specificity to
  `body.display-mode-panes .terminal-container.visible`, so the rule does nothing for the terminal
  you can see — the drag survives a terminal because of `setPointerCapture`, not because of it.
- **A `/clear` orphaned the pane tab** (#346). A tab id is derived from its session id, so an id move
  left the tree naming a retired one. `PaneTree.replaceTab` renames it in place.

Behaviour the mode was missing, and now has:

- **Closing a pane follows the same close behaviour as closing its tabs** (#347). It used to skip it
  entirely and orphan every process in the pane — the opposite of what the `×` on those tabs does. It
  asks once when it would stop processes, and says so when the settings keep them running.
- **The strip can show, reach and clear its tabs** (#349): the active tab scrolls into view, arrows
  and a filterable list appear when the tabs overflow, only inactive tabs shrink, duplicate names are
  qualified by project, and the tab menu closes others / to the right / all.
- **A keyboard model** (#350). Pane arrows are spatial — they were indexing the leaves in render
  order and wrapping, so "up" could go left. Plus zoom, split down, tab navigation within a pane, and
  close tab / close pane. `docs/settings-reference.md` lists every binding.
- **The strip is a tab list** (#351): roles, `aria-selected`, roving tabindex, a focusable sash that
  resizes and resets from the keyboard, and a live region of its own.

And the follow-ups that came out of it:

- **The split chord could not be pressed** (#353). `paneSplit` asked for Shift plus the character
  `\`, which cannot happen together — the Backslash key reports `|` under Shift on a US layout and
  does not exist on a German one. Dead since #309, and it survived a live check because a scripted
  keydown sets `key` directly. Bindings can now name a **physical key**; splitting gained its other
  two directions in the same pass.
- **Direction is decided by overlap, not by centres** (#354). A pane taller than yours could have a
  lower centre while sitting beside you, so "down" moved sideways. Shared geometry, so the grid got
  the same fix.
- **Every main-area surface is a pane tab** (#342). `#terminal-area` is the LAST child of `#main` and
  the viewers are earlier siblings at `z-index: auto` — in the other modes they take over by hiding
  that area, which this mode deliberately prevents, so DOM order put the pane tree on top of them.
  Extending `VIEW_KINDS` was chosen over a takeover layer, because Activity already worked that way
  and because the "admin vs session" line does not cut cleanly (Tasks and Timeline are opened
  session-scoped). Two close routes, matching the `data-close-admin` / `data-close-viewer` split the
  viewers' own headers already use — and only a **user** close runs one, or hiding Projects to show
  Variables sends the sidebar back and undoes the switch.

**#352 is closed.** Its last boxes landed as decisions rather than patches, and both are worth knowing:

- **The LRU still does not bound the live terminal count**, and that is deliberate. `lruEvictOne` skips
  everything with a live PTY, because discarding a running session's scrollback while it keeps
  producing output is a visible loss, not a cache decision. What was missing is that the limit was
  invisible until Chromium began dropping GPU contexts — so the status bar counts live terminals from
  24 up (`shell/terminal-pressure.js`), amber there and red at 30.
- **Trimming a background tab's scrollback is a setting, off by default** (`paneBackgroundScrollback`).
  The reasoning for the default stands: grid can trim because a card is a preview, while a background
  pane tab is a session the user will switch back to, and xterm cannot restore lines a shrunk buffer
  dropped. Whoever keeps twenty panes open can now make that trade knowingly.

Also from that pass: undo for layout changes and named layouts, "Distribute evenly" and a
double-click sash reset, actions on an empty pane (plus `paneCloseEmpty`), and a tab dragged out of
the window to detach it (spec 17 §2b carries the window half, including #360).

Issue: #309 · builds the ownership model that detachable windows (#2) then consume.

## 1 · Problem

Sessions render either as a **grid mosaic** (all sessions auto-tiled, column count from window width)
or in **single view**, and `sessionDisplayMode = tabs` put a tab strip over that single view. Neither
let someone arrange *chosen* sessions side by side: grid decides the arrangement, tabs showed one at a
time. On a wide screen that wastes the screen; on a narrow one grid collapses to a long vertical list.

Panes mode adds the third possibility: a tiled split tree the way VS Code lays out editor groups —
and since #357 it has **absorbed** tabs mode, which a single-leaf tree renders exactly: same strip,
same session bar, same tools. Two modes drawing the same thing meant every tab feature had to be
built twice, and the audit (#343–#355) kept finding the second one lagging.

**It is the DEFAULT since #374.** Having absorbed tabs it is now the ordinary single-session view as
well as the split one, and everything the app has grown since is built on it — the strips, the session
bar, the tools, the view tabs (§4.2), a window of its own (spec 17). Grid is the mosaic, which is a
thing you switch *to*. The rule is stated once, in `resolveSessionDisplayMode`: an explicit `grid`
choice is grid, everything else — an unknown value, and above all a missing one — is panes. Nothing is
rewritten in the database, so an install that never opened settings is served by the same rule as one
that did; an install that HAS saved settings carries its own answer and keeps it.

## 2 · The model

Taken from VS Code's `vs/base/browser/ui/grid/grid.ts` and `editorDropTarget.ts`:

- A **branch** node has an orientation (`row`/`col`) and children; a **leaf** is one pane holding a tab
  list and an active tab. The root carries the orientation. Sizes are fractions, never pixels.
- Adding in a direction: if the direction matches the parent's orientation, insert at an index;
  otherwise wrap the leaf in a new perpendicular branch. That single rule produces every layout.
- Serialised shape is the same tree — `{type: 'branch'|'leaf', size, …}` — so persistence is the model,
  not a second format.
- Drag & drop: an editor-style drag uses a **10 % edge zone per axis, with a 30 px floor and a 32 %
  ceiling** (#376). Edge = split in that direction, centre = move the tab into that pane. The ratio
  alone was unhittable on a narrow pane — a tenth of 200 px is 20 px, and missing it *moved* the tab
  instead of splitting, which takes a second gesture to undo. The ceiling is the other half of the same
  thought: a floor with no cap leaves a small pane with no middle, and "move it into this pane" is the
  commoner intent.
- **The outer band addresses the whole area** (#376). An edge zone belongs to the leaf it is drawn on,
  so with two panes side by side the bottom edge of one of them gave a pane under one column — "put
  this one below **both**" had nowhere to be said. The outermost 36 px of the pane area is that place:
  a drop there splits at the **root** (`PaneTree.splitRoot`), so the new pane spans everything. The
  rule is `splitLeaf`'s one level up — an axis the root already has means a sibling at that end (a
  full-height column beside a row), anything else wraps the whole tree.
  - The band is wired **once on `#terminals`**, not per pane, because parts of the edge are not a pane:
    a sash between two panes crosses it and has no drop handling at all, which left a dead strip
    exactly where this gesture aims. The pane handlers stop propagation on their own drops, so the
    container never repeats one.
  - Where a **tab strip** overlaps the band only 10 px of it count. The strip is a target in its own
    right ("append to this pane"), it is about 30 px tall, and the full band would eat most of it —
    reintroducing at the top the fiddliness the rest of this fixes.
  - The hint is drawn on the whole area and is deliberately brighter than the in-pane one: the two
    produce different layouts from the same pointer position, so a hint that could be mistaken for the
    other is worse than none.

**A session dragged out of the SIDEBAR lands the same way** (#373). Clicking one opens it in the
active pane, which decides for the user; the drag lets them say where. It is deliberately the same
gesture rather than a second one — the drop targets, the hint and the caret are the tab drag's, and
the model call is its mirror: `moveTab` for a tab that exists, `addTab`/`splitLeaf` for one that does
not. Both have taken a position all along (`addTab(tree, leafId, tab, index)`,
`splitLeaf(…, { tab })`), which is why "make it feel like a tab move" cost a branch rather than a
mechanism.

Four rules it inherits rather than restates:

- a session **already in this tree** is not a new tab, it is a tab move, and takes that path;
- a session rendered in **another window** is refused by name — mounting it here is the second
  renderer on one PTY that spec 17 §3 exists to prevent;
- a session with **no process** is not started by the drop. It arrives as the dormant tab with its
  Launch button (#318), because a drag is not a launch;
- the drag is a **second MIME beside the tab's**, never a second meaning for it. `isTabDrag` requires
  the pane-tab type *and* the module's own drag state, which is what keeps a foreign drag from
  splitting a pane; the session predicate goes beside it. The terminal container has to ignore both
  (`isPaneTabDrag` in terminal-manager.js) or a drop that reaches a terminal types the payload at the
  CLI prompt — and for the same reason the payload carries **no `text/plain`**.

Dropped on another WINDOW it lands where it was dropped there too (#375). The far window never sees
the drag, so it is ASKED — `dropTargetAt` answers with the same placement a local drop would produce
and `showPlacementHint` draws it, which is why what arrives is what the user saw. Spec 17 §2d carries
the mechanism; what matters here is that the three landings are one set of rules, used by a local
drop, a sidebar drag and a drag from another window alike.

**Where a restored session lands** (#357). The saved tree carries the tab-to-pane assignment, so
`loadTree` puts a session back in the pane it was in, and `activeLeafId` is persisted too — "the
active pane" after a launch is the one the user left active, not `leaves(tree)[0]`. What is left to
decide is only where a session with **no** stored tab goes: `adoptOrphans` puts it in the **active
pane**, and that stays. It is what a sidebar click does, so a restore behaves like the user's own
opening rather than like a mechanism of its own. It matters more now than it did as one mode of
three — with tabs retired this is the only tabbed mode, so "everything piled into one pane" would be
the first thing seen after a launch.

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
| O4 | No cap on simultaneously rendered terminals | Still true — from two panes up they all render, on the DOM renderer (O14) |
| O14 | One renderer for the whole layout: WebGL only while a single terminal is visible, every terminal on DOM from two panes up (#320) | A split renderer is a split cell metric, visible at dpr ≠ 1. And two visible WebGL terminals share one glyph atlas with no reveal repaint to heal it — measured wrong once, see §6 R1 |
| O15 | "Close pane" is not a tab action (#312) | A right-click on a tab is about that tab; with one tab in the pane the two entries would read as the same thing. It stays on the `…`/strip/bar menus |
| O6 | Pane actions live in the `…` menu | variant **A**, §4.1 |
| O7 | A sidebar click opens in the **active** pane | |
| O8 | Tree persists in localStorage, sizes as fractions | next to `gridLayout`; debounced writes |
| O10 | Closing a pane's last tab removes the pane, the neighbour takes the space | |
| O11 | Plan, stats, memory and JSONL views may live in panes | |
| O12 | Preview and diff are ordinary tabs | variant **P2**, §4.3 |
| O13 | Session tools merge into the pane's tab strip | variant **H2**, §4.2 |
| O16 | The `…` menu groups its entries by subject, and a whole pane can be moved to a window of its own (#340) | Headings, not just a separator — the two subjects were indistinguishable. Only terminal tabs travel; a view tab is named before anything moves. §4.1 |

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

**What the menu contains, and who it acts on (#340).** A grew two subjects and nothing between them:
split and close-pane are about the PANE, "Move to new window" and the window list about the active
SESSION. Each group now carries a heading (`.session-tab-menu-label`), and the session's names the
session it means — with a right-click that is the tab that was clicked, from the `…` button the pane's
active tab, and until then nothing on screen said which.

```
Close · Close others · Close to the right · Close all · Stop & close · Relaunch   ← only on a right-click
──────────
PANE       Split right · Split down · Move pane to new window · Close pane
──────────
SESSION · <name>       Move to new window · Move to "<window>"
```

**Moving the whole pane** needs no mechanism of its own: detaching the first terminal tab creates the
window (`detach-session` answers with its id for exactly this), and every further tab follows through
`move-session-to-window`, which has gone in any direction since #316. A leaf has no split structure to
lose, and the target window builds a single pane (`loadTree`) that `adoptOrphans` fills — so N tabs
arrive as one pane with N tabs. From a detached window the entry reads **Move pane to main window**,
the same asymmetry the single-session block already has.

**Nothing is silently left behind.** Only terminal tabs travel. A singleton view is the app's one
element of its kind, and an instanced preview or diff belongs to the renderer that built it — a diff
additionally holds an MCP `tools/call` only that renderer can answer. So a pane holding view tabs asks
first, naming them, and they stay in the pane; a pane with no terminal tab at all has the entry
disabled rather than doing nothing when clicked.

### 4.2 The session bar — `#terminal-header` stops being a singleton

Today one bar serves the active session: name / pty title / id / shell, then messages, tasks,
variables, status, IDE-emulation chip, stop. With several panes each pane has its own active session.

```
H1   [ tab ][ tab ]                                  ▾ │ …
     ● api-gateway  4a2f  pwsh              ✉ ☑ ⚿  ■      ← extra 33 px row (as built, #321)
H2   [ tab ][ tab ]               ✉ ☑ ⚿ ■ │ ▾ │ …               ← one 34 px row
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

**Since #321 neither indicator is in the tools at all.** The state is a dot leading the session name —
where the sidebar row and the tab already put it, and where it stops reading as one more thing to
click among the buttons. The IDE-emulation mark left the pane entirely: it only ever rendered when the
bridge was ACTIVE, so the state worth telling the user about was the one it stayed silent for; it is a
global setting, so every pane drew the same mark; and it toggles nothing where it stood. It is a badge
on the sidebar row now, beside the status it qualifies, once per session instead of once per pane. The
singleton `#terminal-header` chip is unchanged for the other display modes.

**What the row says, since #358: the name, then the project.** It used to carry the name, the terminal's
own title and the full session id — and the pty title is usually the AI title with an activity glyph in
front of it, so the row read as the same sentence twice, in the space the project needed. The project is
the fact that tells two sessions with the same summary apart, and it was the one thing the row never
showed. The id is a string to copy, not to read.

Everything that left moved into the name's tooltip, built by `buildSessionBarTooltip` beside the tab's
own builder, so the first two lines say the same thing in both places. It drops any line that repeats
one already there, compared with a leading non-alphanumeric run stripped — otherwise a renamed session
shows *Review the handoff* and *✳ Review the handoff* under each other on every tooltip.

**Clicking the name renames the session.** Not a new mechanism: `startSessionRename` in `app.js` is the
tabs-mode header's inline rename, generalised to take an element and a session id. What a typed name
*means* is `resolveRenameTarget` beside the tooltip builders, and it is shared by all three surfaces
(sidebar row, header, pane bar) because the answer is not "store what was typed": empty stores `null`,
and so does the automatic title itself — otherwise confirming a rename that changed nothing freezes
today's AI title as a manual name and no better one can ever replace it. The sidebar's own copy had
drifted: it compared against the RAW automatic title while its field showed the cleaned one, so a
no-op rename of any session with a plan prefix or an XML-ish tag in its title silently switched the
automatic title off.

Three things a rename in a pane has to survive, and two of them were defects the tests could not see:

- **`refreshChrome` must not rebuild a bar that is mid-edit.** It runs on any session's busy/idle edge,
  so an unrelated session starting work tore the edit out from under the user — losing the text and
  leaving the rename flag set, which killed every later rename *and* the header's AI-title refresh until
  the renderer restarted.
- **A full `render` ends the edit rather than orphaning it**, the same way it ends a sash drag two lines
  above (#345). It commits: the text is the user's, and the alternative is a sentence that vanishes
  because a tab opened somewhere.
- **The press is `mousedown`, not `click`.** Focusing a pane that is not the active one routes through
  `showSession` → `show` → `scheduleRender`, whose microtask runs *between* mousedown and click — and a
  click whose mousedown target has left the document never reaches that node's listener. So a title in a
  background pane took two clicks. The handler also re-resolves the element after that render settles,
  rather than handing the edit the node its closure captured.

**The two surfaces differ in exactly one place, and it is not an oversight.** The tabs-mode header keeps
its pty-title span: `onTerminalNotification` writes the CLI's OSC-9 notification text into it
(`shell/session-ipc.js`), so removing it would drop a signal nobody asked to remove. The header loses
the id and gains the project like the pane bar does.

### 4.2b A view tab may leave its window (#364)

A view tab drags like a session tab: onto another window it opens there, and dropping it on empty
space says why it cannot yet — a window boots around a session, so one holding nothing but a view does
not exist. Nothing is handed over. Every window loads the same `index.html`, so each already has its
own `#jsonl-viewer`, `#projects-viewer` and the rest; the **singleton is per window, not per app**. The
target opens its own element and the source closes its own, which is why this is a message
(`open-view-in-window`) and not the release/re-register/adopt dance a session move needs.

**Not every kind may go, and the rule is DERIVED rather than listed.** A view travels exactly when the
window receiving it can put something in it: it must be a **singleton**, and it must **name a loader**.
An instanced kind's host is looked up and never created (`filePanelHostFor` is a plain map read), so an
arriving preview finds no host and renders nothing while the sender has already closed its own. A kind
with no loader arrives blank, because the sidebar is what fills these surfaces locally and a delivered
view has nobody to do it — Messages, Settings, Tasks, Bookmarks and Timeline are per-session or
per-scope, so a zero-argument loader cannot express what they should show, and they stay until it can.
The first cut of this listed exceptions instead and let five kinds through that arrived empty; deriving
it from the capability is what stops the rule drifting from what the code can actually do.

Two things had to be added for it to arrive at all, and both were found by clicking:

- **The view arrives empty otherwise.** The sidebar fills these surfaces on the way in — that is what
  "opening" one means there. A view arriving from elsewhere has nobody to do it, so a kind that travels
  names its own loader (`load` in `VIEW_KINDS`) and the arrival calls it.
- **`webContents.send` to a window that is still loading is dropped, silently, by Electron.** A window
  made by the same gesture is exactly that window. Main waits for `did-finish-load` before delivering —
  no amount of retrying in the target helps when nothing ever reaches it, and the sender has already let
  go of its own tab.

**A diff never leaves.** It holds an unresolved MCP `tools/call` that only the renderer showing it can
answer (§4.3: every path that drops one must answer it, or the CLI hangs until the bridge times out ten
minutes later). Handing it over would strand that obligation in a renderer that never took it on — so it
stays, and "Move pane to new window" names it before anything moves, which is what that question is for.
Everything else in the pane travels with the pane, views included; before #364 they were silently left
behind, so moving "the whole pane" moved only part of it.

**The open file travels with a singleton view.** An instanced kind carries its subject in the tab id
(`<kind>:<ref>`), a singleton has nowhere to put it — so a moved Memory or Plan arrived showing an empty
editor. The mover asks the view which file it has open and sends it along, and the receiving side opens
it through the same function the relay below uses.

**Memory, Plans and Work files are steered from the sidebar, and a detached window has none** (§2 of
spec 17 puts it in the main window on purpose). They travel anyway, and main relays the sidebar's pick
to whichever window holds the view (`window-views-changed` to register, `route-view-file` to deliver).
The registry is deliberately not `detachedWindows`: that one answers "where do this session's bytes go"
and is verified constantly by output the user can see, while this answers a rare question whose
staleness is invisible. So an entry is dropped the moment the window says so or the window dies — never
inferred, never repaired by guessing. "The window says so" has to mean **every** path that takes a view
down, not just the tab's own close: closing a whole pane and leaving panes mode both bypass
`closeViewTab`, and both report for themselves. The second is the one that cannot self-heal — it tears
down the observer that would otherwise notice. A pick that was delivered elsewhere says so in the window
it was made in, because a click whose effect lands on another monitor and says nothing reads as a click
that did nothing.

**What is reported is the whole LIST, not a per-kind delta** (#370, #371). It began as
`view-host-changed(kind, hosting)`, which is a delta — and a delta is a thing that can be missed, once,
after which the window claims a view it closed for as long as it lives. Deriving the list from the tree
means a path only has to report *after* it changed the tree, not remember which kinds it took. It also
answers two questions a kind→window map cannot, both about the window rather than the kind: whether it
still has something to show once its last session leaves (spec 17 §2b), and what it has to be given back
when it is restored (spec 17 §5b). Instanced kinds are in the list for that reason, though they are
still never routed — a window holding nothing but a preview holds something.

The alternative was to make those three self-contained the way Projects and Activity are — list, filter
and editor in one surface — which also fixes "two files side by side", which the relay does not. It was
considered at length and not chosen: the file list stays where the user already looks for it. The cost
is one relay and its edge cases instead of three rebuilt views.

**A view can also be given a window of ITS OWN** (#370). "Move to new window" leads the block, and a
view tab dropped on empty space means the same thing a session tab does there — a window on the display
it was dropped on. That entry was absent until then, and the reason it was absent is spec 17 §2c: a
window was built around a session, so one holding nothing but a view could not boot at all.

### 4.3 Preview and diff

Today `file-panel.js` builds `#terminal-split` at startup, moves `#terminals` into it and puts the
preview/diff panel beside it (width in `filePanelWidth`).

| | | Trade-off |
|---|---|---|
| **P2** *(chosen)* | Preview and diff are tabs in the tree | **+** one layout system; a preview can sit beside the pane it belongs to; detach comes for free. **−** every view must become instantiable per pane and per window — the real cost driver, larger than the tree itself. Built in #310 as one instance per kind (the element moves to the pane you opened it from); preview and diff became one instance per TAB in #311, the rest stay singletons |
| P1 | The panel stays fixed beside the whole tree | **+** no rework, no risk to the diff viewer. **−** with four panes nothing says which pane the preview belongs to; two layout systems run side by side |
| P3 | P1 first, P2 later | Only viable if the tree is typed from day one — otherwise the switch is a second rebuild. P2 makes it moot |

**Built in #311, in two steps.** Step 1 pulled the panel body out of module-level singletons addressed by
element id (`#file-panel-viewer`, `#file-panel-body`, `#diff-title`, …) into `createPanelInstance` — an id
is unique, so there could only ever be one of each, which IS the symptom. Step 2 made it a registry:

- **`panelTabs`, keyed `<kind>:<ref>`** — the file path for a preview, the diff id for a diff. A natural
  key, because the MCP bridge re-sends the same file on every session switch and a counter would stack
  duplicates nobody asked for; re-opening lands on the tab that already has it.
- **One model in every display mode.** The mode decides one thing only: outside panes the side panel shows
  one entry per session, so opening closes the previous — which is what tabs and grid always promised. In
  panes nothing closes.
- **`diff` is its own kind now.** It used to render through the `preview` host because both were
  `#file-panel`.
- **Every path that drops a diff answers it**, except the two where the CLI already decided (`close_tab`,
  `closeAllDiffTabs`). Displacing one in the side panel, closing its pane, and leaving panes mode all
  reject it — otherwise the CLI's `tools/call` hangs until the bridge's ten-minute timeout. Leaving panes
  mode is the one a review caught: the pane teardown had already taken the DOM, so an entry left behind
  was unreachable *and* unanswered.
- **An entry carries its own `sessionId`**, because that is what answers the bridge — so a re-key (`/clear`,
  an accepted plan) has to move the entries too, or a `close_tab` under the new id matches nothing.
- **Instanced elements never go through `viewHomes`.** They have no home: they are created with their tab
  and destroyed with it. The singletons still must be parked before a rebuild, or `replaceChildren` takes
  the app's only preview panel with it (#310, #342).

### 4.4 Why grid is not folded in

Grid was considered as "auto-arranged panes" and kept separate. It carries features panes do not have
an equivalent for: auto-tiling of *all* sessions with a column count derived from the window width, the
status filter, bulk actions over card selection, and the card chrome. VS Code has no counterpart —
"Arrange Groups: Grid" is even-sizing, not an overview. Folding grid in would mean moving filter and
bulk actions to the sidebar and rebuilding the a11y move mode on the tree; that is its own issue, not a
side effect of this one. The tree model is pure, so the option stays open.

### 4.5 What panes gained so grid could be retired without loss (#356)

Grid is an overview, and four things hung off that framing with no counterpart on a tree. Three were
built; the fourth was struck after reading the code rather than deferred:

- **Tiling all open sessions** — a COMMAND that builds a tree, not a mode. It replaces the arrangement
  and asks nothing, because undo (§4.6) is one click away. Its column count is **not** grid's:
  `calculateTileColumnCount` takes the height as well, because grid scrolls while a pane tree shares one
  viewport. Measured: grid's formula answered "one column" for seven sessions on 1020 × 952 — seven
  panes of 136 px, six terminal rows each.
- **A keyboard move mode** — the chord enters it on the active tab, arrows move that tab into the pane
  in that direction (`pickGridNeighbor`, shared geometry), Escape leaves. Its marker is a projection of
  the state, re-asserted by every render: built the other way round it ended on the first rebuild, and
  this mode rebuilds constantly.
- **A selection, and bulk actions over it** — Ctrl-click marks, Shift-click takes a range inside one
  strip (two panes' tabs have no order a user could predict), a plain click leaves. Stop, Close and Tag
  act on the set; Close goes down the same path a single `×` takes, so the close behaviour still decides
  per session. **Grid has no selection model at all** — its "bulk actions" act on what the status chips
  admit — so this is the one capability panes has and grid does not.
- **A status filter — struck.** It already exists elsewhere: the sidebar's attention inbox carries it
  with a Focus-next button, and every pane tab shows its status dot. A filter here would be a third
  place for what is stated in two, and a hand-arranged tree is the wrong thing to hide panes from.

### 4.6 Why the layout is still hand-rolled (#359)

Evaluated against dockview-core (7.0.4, MIT, zero dependencies, 291 KB minified) and `@lumino/widgets`
(2.9.0, BSD-3, eleven packages, 186 KB). Golden Layout is out — no release since February 2023 — and
flexlayout-react and rc-dock are React-only, which this renderer is not.

**Both candidates pass the test that decides it.** A throwaway harness moved a live `@xterm/xterm`
between groups in each: same DOM node, same terminal instance, buffer unchanged, 24 rows before and
after. Both also answer "how many are visible" (2 split, 1 stacked), which is what #320's renderer
policy is built on — Dockview per panel, Lumino only through `layoutModified`. A WebGL context survives
the reparent as well: no context-loss events, `isContextLost()` false afterwards.

So it is not a capability question, and the answer rests on what the trade is: **946 lines out**
(`pane-tree.js` entire, plus 461 of `panes-view.js`'s 2833 — sixteen per cent) against 186–291 KB of
third-party code, a second bundle in a renderer that has one, a one-way migration of the saved
`localStorage` tree, and re-securing every behaviour the audit paid for (#310, #311, #320, #342, #354,
#355) on a model we do not own, with 183 tests rewritten because they are written against ours.

**Kept.** If the question ever returns, Dockview is the candidate — zero dependencies against eleven,
and per-panel visibility events are what the WebGL policy needs.

## 5 · Constraints the code imposes

| Finding | Consequence |
|---|---|
| Grid already moves a live terminal container into a card and back (`grid-view.js` `wrapInGridCard` / `unwrapGridCards`) | Reparenting a running xterm is proven, not a research question. Refit after every move |
| `file-panel.js` builds `#terminal-split` at startup | Splitting the main area is precedent; under P2 this container goes away in panes mode |
| Tabs mode stacked all terminals in one box and switched by z-index | The same trick per pane — a switch inside a pane still causes no repaint. It is panes' own now (`style.css`, `body.display-mode-panes .terminal-container`): the mode this was learned from is retired (#357), and the selector it named went with it |
| `addMcpToggle()` injects the IDE chip into a single `#terminal-header-controls` id | Needs a per-pane mount point, or the chip lands in the first pane only |
| Bare `Ctrl+\` is `0x1c` (SIGQUIT) to the pty; bare `Ctrl+3..8` are ESC/FS/GS/RS/US/DEL | Split and pane-focus shortcuts go on `Ctrl/Cmd+Shift+…`, matching every other binding in `shortcuts.js`. Pane navigation reuses `sessionNavArrows` rather than Alt+arrows, which are the terminal's word jump |
| The layout must exist before `session-restore` mounts terminals | Otherwise the first fit measures a box that is about to change |
| The display mode is applied **before** the restore mounts anything | So the stored layout can only be validated against the session list, never against `openSessions` — see `docs/ai/lessons.md` |
| The terminal container claims every drop it is offered | A tab drag has to carry its own MIME type so the container can ignore it |
| `WebglAddon.dispose()` leaves its canvases in the DOM | They cover the DOM renderer's rows; a demoted terminal shows nothing until they are removed |
| Several live WebGL terminals share one texture atlas (#118, #262) | Every terminal renders the same way, and from two visible panes up that way is DOM (#320). Following the focus, as grid does, split the *metric*: at dpr 2 the cell is 8.000 px under WebGL and 8.2065 px under DOM, so the unfocused pane drew heavier and a line off |

## 6 · Risks

| | Risk | Mitigation |
|---|---|---|
| R1 | WebGL — reparenting plus many visible terminals is the corner of #118 (stale atlas), #128 (context loss / stale fit) and #262 (atlas contention). Panes make grid's exceptional case the normal one | **Real, and it cost two attempts.** #320 first read #140's corruption as context *churn* — which it partly was, and `loadTerminalWebgl` is idempotent now — and cleared the atlas on a bench test: two WebGL terminals, ~18 000 codepoints flooded through each, no corruption. Daily use disproved that within hours: two panes rendering **alternately over minutes** drop glyphs, because there is no reveal repaint to heal them. Final rule: WebGL only while ONE terminal is visible, everything on DOM from two panes up. All-or-nothing either way — a mixed layout splits the cell metric visibly at dpr ≠ 1 |
| R5 | With tabs retired (#357), **splitting** is what costs the GPU renderer, and panes is now the only tabbed mode | Accepted as the trade, and said out loud in the Display mode setting. A user who never splits loses nothing: one pane means one visible terminal, which is exactly the case that keeps WebGL. The direction that actually favoured retiring tabs is the opposite one — tabs kept a context per OPEN terminal with **nothing** bounding the count (`lruEvictOne` skips everything running), and Chromium starts dropping contexts past roughly 32. Panes' two-visible rule bounds it structurally |
| R2 | Status drift — sidebar, tab and grid card already drifted apart four times (#124, #253, #257, #269); panes multiply the tab case | One render path for a tab's status, shared with `.status-dot.status-*` |
| R3 | Every `terminal-header*` lookup assumes a singleton | Convert them in one pass, `addMcpToggle()` included |
| R4 | Typed views (P2) touch every view module | Terminal tabs first; the tab type exists from day one so nothing is rebuilt later |

## 7 · Related

- **#2** — detachable windows, built after this and on top of it. A detached window loads the same
  `index.html?detached=<id>` and gets a tree with exactly one leaf, so it inherits the strip, the
  session bar and every terminal fix; the ghost tab #2's own plan proposed turned out to be
  unnecessary. The one thing panes had to learn: a detached window shares this origin's localStorage,
  so it neither loads nor writes the saved layout — otherwise popping a session out would overwrite
  the user's arrangement with a single pane. Since **#332** the dormant tab is load-bearing for detach
  as well: a session with no process can be moved between windows, and a pane is the only place that
  can show one, because a tab whose session is not mounted is a state panes mode already renders (#318).
  `panesView.openDormantTab` exists for that one caller — the choke point `show` deliberately still
  refuses an unmounted session, so a stray `showSession` cannot conjure a tab.
- **Spec 08** — flexible grid layout. The pure-module shape (`grid-layout.js`: order, spans, pointer
  geometry, keyboard move mode, all DOM-free and require-able) is the template for `pane-tree.js`.
- **Spec 06** — grid bulk actions. One of the features that keeps grid a mode of its own (§4.4).
