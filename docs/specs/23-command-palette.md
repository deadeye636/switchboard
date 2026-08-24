# Command palette

Issue: #274. Built: Ctrl/Cmd+K opens one ranked list over the sessions, the projects and the actions the
app can run.

## What was missing

Reaching a session meant finding it in the sidebar, which is a tree with filters, folds and an "N older"
group in every project. Reaching an action meant remembering which toolbar it lives on. Both are the
problem a command palette solves, and the app had three keyboard pickers already — for variables, plans
and skills — none of which could answer either question, because all three are anchored in a terminal.

## It is a fourth picker, not a second popover

`palette-core.js` (#462) already owns the popover: the keyboard loop, the focus recovery, the
outside-click and scrollbar rules, the listbox semantics, and the epoch that keeps two opens apart. Every
one of those was paid for in bugs. So the command palette is a **description** like the other three, and
the core gained the three things it lacked:

- **A second geometry.** `paletteGeometry` puts a picker in the lower half of its terminal's rectangle;
  `centeredGeometry` puts a palette that belongs to no terminal near the top of the window. One flag,
  two pure functions, both unit-tested — not a general "anchor provider" abstraction for one caller.
- **A return-focus target.** `closePalette` hands focus back to the terminal. With no terminal it hands
  it back to whatever held it when the palette opened; without that the focus falls to `<body>` and the
  app is keyboard-dead until something is clicked.
- **A backdrop.** The core's outside-click closes the palette but lets the click through to the UI
  underneath, so dismissing it could open a session on the way out. A `centered` palette gets a backdrop
  that swallows the click.

**And the modal swallows the app's chords.** `onKey` claimed four keys and let every modifier chord
bubble to the document-level dispatcher in app.js. With the palette open and focused, Ctrl/Cmd+Shift+G
switched the whole view underneath it and Ctrl/Cmd+Shift+B bookmarked the session behind it. A centered
palette now calls `stopPropagation` on those — stopped, not prevented, so copy and paste in the filter
box keep working.

**`setActiveSession` closes any open palette on a session switch** (#207 — a picker captured one terminal
and its Enter would aim at the session the user just left). The command palette is exempt: it captured no
terminal, and it is often what *caused* the switch, so closing it there would shut it on its own pick.

## Ranking is its own module, not the sidebar's search

`shell/command-palette-rank.js`, pure and DOM-free. The sidebar's search is a trigram FTS query dispatched
to the index worker over IPC, with a three-character floor imposed by the tokenizer, and it knows only
about sessions. A palette has to answer the first keystroke over three kinds of thing at once.

Subsequence-with-bonuses, the shape every command palette uses: the query's characters must appear in
order, and where they appear decides the score — a word start is worth more than a letter in the middle,
an unbroken run more than the same characters scattered, the first character most of all, and a short
name beats a long one that matched the same way.

**The gap penalty is not decoration.** Without it a long sentence wins on boundary bonuses alone: every
word start it happens to contain pays, so "Some window that is chaotic" outscored "Switchboard" for the
query `switch`. Uncapped, though, it buries the initials match the boundary bonus exists to reward
(`tso` → "Toggle session overview"), so it is capped.

An empty query is not a search but a starting point: the most recent sessions first.

## The actions are not a table

A central list of what the app can do is a file every new feature has to remember to edit, and one whose
author forgot leaves a gap nobody sees — the shape `.claude/rules/renderer.md` already forbids for
per-backend tables. So `shell/command-actions.js` defines `registerCommandAction`, each owner declares
its own at the tail of its file (the sidebar fold in `sidebar-collapse.js`, the overview in
`grid-view.js`), and `available()` is asked per open, because whether the grid applies depends on the
display mode and on whether this window is a detached one.

Registration happens at parse time into a function defined earlier in the script order — the safe
direction under the renderer's load-order rules.

## What a row does

| Kind | Enter |
|---|---|
| Action | runs it; the palette is already closed |
| Session | opens it, through the ordinary `openSession` |
| Project | scrolls its group into view, unfolds it, and marks it briefly — the sidebar IS the project view, and a project the palette jumped to that stayed folded looks like nothing happened |

The fold is written through the same store a manual toggle uses, so it survives the next render exactly
as if it had been clicked (#278's explicit-wins rule).

## Tests

`test/command-palette-rank.test.js` covers the ranking, including the two ordering cases above.
`test/palette-core.test.js` gained the centred geometry and now scans `shell/` as well as `terminal/` for
picker configs — scanning only `terminal/` left the fourth picker unguarded.

The keyboard path has no test and cannot have a useful one: `node scripts/drive-app.js` is what proves
Ctrl/Cmd+K opens it from a focused terminal, that the same chord closes it, and that a chord no longer
reaches the app while it is open.
