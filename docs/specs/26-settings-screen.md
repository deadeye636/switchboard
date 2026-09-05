# 26 — The settings screen

Status: **built** (#471, #472, #490).
Written after the fact, as a design record.

The enforceable half is the *settings screen* section of [`.claude/rules/renderer.md`](../../.claude/rules/renderer.md);
that file says what to do, this one says why. What each setting means is
[`docs/settings-reference.md`](../settings-reference.md).

## The problem

The screen had grown by accretion. Both scopes had, and neither could answer the question it was opened
with.

- **A heading meant "roughly this area", not a subject.** Terminal had collected documents, editor
  settings and secrets, because each one had once been *about* the terminal. The nav said it held ten
  fields. It held twenty-six.
- **The counts were written into the markup**, so they were wrong long before anyone looked at them.
- **Project settings were one column**, a screen and a half long, with no nav at all — while the global
  ones had had one since #471.
- **A backend and its own files were never on screen together.** The project scope drew every backend's
  launch defaults first and every backend's resources after them, as two flat lists. To see what Claude
  was configured to do *and* what Claude reads, you scrolled past four other backends.
- **Opening the screen walked the filesystem five times.** Each backend's resource block listed a
  directory on render, for lists nobody had asked to see.

## A category is a subject, and the nav is generic

`settings-global-html.js` holds one `<section class="settings-cat" data-cat="…">` per category and a nav
button per section. Nothing about the switching knows what a category *is*, which is what makes adding one
those two edits and nothing else.

**The counts are counted** (#471). `settings-panel.js` fills each badge from its section's
`.settings-field` elements after the markup is in. A category another module fills in later — Backends,
Tags, Custom launchers — counts nothing and shows nothing, which is honest: the panel cannot count what it
has not been given yet.

The rule that comes with it, and the reason the grouping is worth writing down: **a field goes where its
subject is.** Terminal is what a terminal does, not what happens to be reachable from one.

## Closed by default, because open costs something (#472)

Per-backend blocks are disclosures, and a disclosure fetches on `toggle` rather than on render
(`bindLazyResources`). Five installed backends meant five directory walks per open before this, and the
question "what does this project override" did not need a single one of them answered.

**Closed is closed for everyone** — no remembered per-user state, so two people looking at one project see
one screen. What a collapsed thing must never stop saying is whether the project overrides anything: a
screen that hides the answer to its own question is worse than a long one.

## Project settings get the same shell, and one wiring serves both (#490)

The nav moved to the project scope unchanged in look and different in one way that matters: **its entries
are not all knowable when the markup is written.** Every ready backend is an entry, and which backends
exist is answered by main, after the panel has already rendered.

So `wireTwoPane` in `settings-panel.js` is the one implementation for both scopes, and it:

- **queries `.settings-nav-item` and `.settings-cat` on every use** rather than capturing them in arrays,
- **delegates the clicks** to the nav container,

because a list captured at wiring time would leave every backend entry dead. `addBackendNav` builds the
BACKENDS group from what `backendsPanel.mount` reports through `onBackendPanes` — never from a list written
into the markup, which would be a guess about the machine the app is running on.

**Panes, not scroll anchors.** The alternative was one long page with the nav scrolling to a heading. It
was rejected on cost, not taste: the active-entry highlight needs an observer that does not exist here, and
the search hides fields, so "which section am I in" stops having an answer exactly when a hit is being
looked at. Panes reuse the switching that was already there.

## A backend's page holds its defaults AND its resources

This is the point of #490 rather than a side effect. The pairing replaced two flat lists, and three things
had to move for it:

- **The shared "Launch defaults" heading is gone**, and the sentence under it — the one explaining that an
  option falls back to the global default, and that enabling a backend and the default launch target stay
  global — sits on **each** backend's page and names that backend. There is no landing page left to put it
  on: every entry under BACKENDS goes straight to a backend. The repetition reads as being about this one.
- **The per-backend collapse is gone**, because the page is the disclosure now.
- **The "N overrides" marker moved onto the nav entry.** It was on the collapsed summary, and without it
  "what does this project change" would mean opening every backend in turn. `data-count-own="1"` keeps the
  generic field counter off that badge: every backend has roughly the same number of launch options, so
  counting them says nothing, and counting the overrides says everything.

**Resources stay lazy through a different door.** `showCat` fires `settings-cat-shown`, the backend's page
opens its own disclosure, and the existing `toggle` fetch does the rest. One backend's walk, when that
backend is looked at.

## The search is the hole in laziness, and it is guarded

`applyGlobalSearch` force-opens every `details.settings-adv` so a hit inside one is visible. A resources
block **is** a `settings-adv`. With every backend's page in the DOM from the first render, that meant the
first keystroke in the project search box walked the filesystem once per backend — the exact cost #472 had
removed, coming back through the search box #490 added, in code that had never heard of either.

It now force-opens a resources disclosure only when `dataset.loaded === '1'`: one already read has nothing
left to pay and is searched, one nobody has opened stays closed and is not. A search that silently costs
five directory walks is not a search anybody asked for.

**The general shape of the defect is the part worth keeping:** a blanket operation over a shared DOM
defeats a rule it was never told about. Anything future that opens, expands or measures "everything" in the
settings tree has to answer this question again — see
[`docs/ai/lessons.md`](../ai/lessons.md).

## What it cost, and what caught it

The suite stayed green through the whole change, including through that defect: nothing tests
`applyGlobalSearch`, and the project scope's search box did not exist before this issue. It was found by a
reading verifier and confirmed in a running app, which is the same shape as every other entry in
`docs/ai/lessons.md` that starts with "all tests passed".

## An action that takes the subject away closes the screen (#565)

Hide Project and Remove Project sit on the project page's button row, and both take the project the page
is about off the list. What happened next had been written for the in-app overlay: hide the viewer, show
`#placeholder`. There has been no overlay since #365 — `settings-panel.js` is loaded by `settings.html`
alone, and that page carries no `#placeholder` at all. So the first line blanked the window and the second
threw on a null. Pressing a destructive button produced an empty window that said nothing either way,
which is also what kept the failure in #566 out of sight.

The screen closes instead, and the alternative was weighed rather than skipped. Going back to a project
list is not something this window can do: the scope is settled once, from the URL, while the window loads
(`settings-window.js`), and the list of projects lives in the main window. Landing on one here would mean
building a surface that does not exist. Staying is worse than closing, not better — every field writes to
`project:<path>` and every entry under BACKENDS describes a project that has just left the list. Closing
also lands the user in front of the only project list there is: the main window's sidebar, where the row
is now gone, so the result of the action is visible rather than asserted.

What replaces the blank window is the button that was pressed: the green flash the Save button already
uses, worded for the action, and then the close. The failure side had the same hole from the same cause —
the error branch called `toast`, which belongs to app.js and is not loaded here, so a refused Hide or
Remove reported itself to nobody. It says so through `showControlMessage` now, the way the rest of the
panel does.

`test/settings-project-action-close.test.js` loads the panel the way `settings.html` does — every script
that page names, in order, into one jsdom vm context — and clicks both buttons. It is the first harness
that reaches this file's click-time surface; `settings-modules-smoke.test.js` is a load-time guard and
says so.

## Known gaps

- **No test covers the search.** The fix is a one-line condition in `settings-panel.js`. The harness that
  arrived with #565 clicks the two project buttons and could be pointed at the search box, but nothing
  does that yet; until then the guard against a regression is the rule and this document.
- **The nav is built in `settings-panel.js` for the project scope** and in `settings-global-html.js` for
  the global one. Two markup sources, one wiring. Splitting the project markup out the way #218 split the
  global one is the obvious follow-up, and was left alone here because the change was already large.
- **`data-count-own` is a convention, not a type.** A future entry that wants its own badge has to know
  the attribute exists.
