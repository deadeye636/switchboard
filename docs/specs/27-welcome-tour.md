# 27 — The welcome tour

Issue: #146. Built: 0.7.16.
Written after the fact, as a design record.

The enforceable half is `test/welcome-tour.test.js`; what each setting means is
[`docs/settings-reference.md`](../settings-reference.md). This file says why the thing has the shape it
has, and — because most of what follows was arrived at by getting it wrong first — what the obvious
version does instead.

## The problem

A fresh installation is honest and silent, and several of its defaults read as bugs to somebody who has
just installed it.

- **Four of the five CLIs are switched off.** `isEnabled` answers `descriptor.id === 'claude'` for
  anything not explicitly stored, so a Codex user's sessions are never scanned — and nothing on screen
  says why. The only warning in the app fires when *every* backend is off.
- **The attention hooks are off**, and the switch is behind a gear whose tooltip says "Launch defaults
  for Claude". The README promises the behaviour they provide.
- **The sidebar trims itself** by three separate defaults at once, which on a machine with an existing
  `~/.claude` tree reads as "it lost my sessions".
- **The split gesture is invisible** until you are already dragging.
- **Closing a tab does not stop the session, and quitting does** — the mental model "tab = process" is
  wrong in both directions, and getting it wrong loses work.

None of that is a defect. Each is a decision with a reason, and each is a thing the app never says.

## What it is

Nine panes over one dialog, shown once on a profile whose global settings carry no `welcomeDismissed`,
and reachable again from **Settings → Maintenance**. Pane 0 is the welcome pane and carries #146's two
actions (Import settings, Open settings); the other eight are one topic each.

Two properties separate it from a splash screen, and both were asked for after the first draft:

**Every pane that names a setting also writes it.** A pane that says "switch this on" and then sends the
user looking for the switch has explained a problem and left it standing.

**Five panes draw what the setting does, and redraw as the controls change** — the split zones against an
equal-cell grid, the sidebar with its fold, the × on a tab against a still-running agent, the review panel
against a prompt in the terminal, the directories a plan and a handoff are written to.

## The decisions

### D1 — the panes are data, not markup

One array of descriptors (title, where-line, body, controls, figure) and one renderer. That is what keeps
nine panes consistent, and it is what makes the guard possible at all: a test can read the descriptors and
ask what they write.

### D2 — a control appears only where the pane's point IS that decision

Not "every setting mentioned". Pane 8 (F1 opens the palette) names a setting and deliberately carries no
control: rebinding needs the key capture in `settings-shortcuts.js`, which `index.html` does not load, so
a control there would be a button that cannot capture a key.

### D3 — the tour writes its own labels, and the guard matches KEYS

The first plan required the settings screen's label word for word, as an anti-drift device. That does not
survive contact: eight of fifteen labels would have to become the screen's wording, and one of them is
`IDE emulation (MCP bridge)`. A tour that has to speak the settings screen's shorthand is not an
introduction.

So the anti-drift job moved to something a guard can hold. **Every key the tour writes is also written by
the settings screen**, which stays the complete list — and each pane's where-line names the screen and
section its setting lives in, which is what stops two labels reading as two settings.

### D4 — there is no single door, and assuming one is the expensive mistake

`merge-setting` is a **shallow** spread and deliberately does not re-arm the backends. The settings screen
does not use it for any of these settings: it builds one full object and calls `set-setting`.

| Pane | Route | What the merge would have done |
|---|---|---|
| 1 — the CLIs | read the blob, patch `backendEnabled`, `set-setting` | replaced the whole map, dropping every other backend's state, and skipped the re-arm — a backend switched on would not be watched until relaunch |
| 2 — attention | the flag **plus** `configureAttentionHook` | stored an intent nothing acts on; the hook is a file in the CLI's own home |
| 3, 4, 5, 7 | `merge-setting` — flat keys | fine |
| 6 — the review panel | read-modify-write of `backendDefaults`, `set-setting` | wiped every other backend's defaults and every other option of this one |

### D5 — the window that writes is the one window the broadcast skips

`broadcastSettingsChanged` excludes the sender. The tour runs in the main window, so **it applies its own
change** (`reapplyGlobalSettings`) and then tells the others (`notifySettingsChanged`). Without the first
half, four panes appear to do nothing until the next launch — a defect no test can see, because the
setting IS written.

### D6 — it names no backend

Panes 2 and 6 are about a CLI's own options, and the tour is in `src/renderer/**`, where a backend id may
not appear (CLAUDE.md reflex 5). So the tour names a **capability** id — `attentionHooks`, `mcpEmulation`
— and asks the registry which backend declares it. A pane whose capability nothing installed declares is
skipped rather than rendered empty.

Two limits, so this is not read as more than it is. The **write** is not generic: `attentionHooks` needs
`configureAttentionHook`, keyed on that id in the settings screen too, so the tour keys on it as well — a
second copy of one special case, not a mechanism. And the resolution takes the FIRST backend that
declares the capability, which is unambiguous today and would not be if two declared the same option id.

### D7 — the figures are drawn, not photographed

A picture that has to answer to a number cannot be a PNG, and five of these do. They are inline SVG in the
module: crisp at any size, a fraction of a screenshot's weight, and they do not go stale when the app is
restyled. The plan called for pane 2's to be a real screenshot, since it is about *where* a control is
rather than what it does; it is drawn too, and the reason is in the code — a screenshot of the settings
screen has to be re-shot and re-checked for a stray project name every time the screen changes (rule 6).
**There is no image file and no `src/renderer/assets/`.**

### D8 — reopening opens the tour; it does not reset the flag

Resetting `welcomeDismissed` would make the tour reappear unasked on the next launch, which is the one
thing that flag exists to prevent. The button therefore opens it directly.

It lives under **Maintenance**, not About: About is a plate to read — version, lineage, license, runtime —
and this is a thing you do, beside the other things you do to an installation.

### D9 — the settings window cannot sit beside the tour

The settings window is a **snapshot editor**: seeded from the blob when it opens, and it never re-reads
(the renderer's only `onSettingsChanged` registration is in `app.js`, which `settings.html` does not
load). So its Save writes that snapshot back over anything a concurrent writer changed. Pane 0's **Open
settings** therefore closes the tour rather than opening a second editor beside it — which is also #146's
own shape: Import and Open settings are alternatives to the tour, not companions.

Neither of those two actions writes the flag. Cancelling an import file dialog must not cost the tour
permanently.

### D10 — four ways out

The × in the corner, a button labelled **Close the tour** (not "Skip", which reads as "skip this pane"
from pane 2 onwards), Escape, and a click on the backdrop; Done on the last pane is the fifth path to the
same place. It opens by itself in front of somebody who did not ask for it, so leaving is the half that
must be easy — and nothing in it holds work a stray click could lose, because every control writes as it
is changed.

**Escape is bound to the document, in the capture phase.** Bound to the overlay it fires only while focus
is inside it, and one click on the dialog's padding or on a figure moves `activeElement` off — after
which Escape reached the app's own handlers instead, and the tour had no keyboard dismissal at all.

## The trigger

The flag's **absence** is the trigger, so **every existing installation sees the tour once** after
updating. That is intended and belongs in the release notes rather than being discovered.

Two things about where the call sits:

- **After the session restore resolves.** `restoreOpenSessionsOnLaunch` ends in `showSession` →
  `terminal.focus()`, so a dialog opened before that has its focus taken by a terminal. It is chained onto
  the boot promise rather than placed inside the boot callback, which returns early on three paths.
- **Gated on `!isDetachedWindow()`.** Detached windows load the same shell (#390); without the gate an
  existing user with restored detached windows gets a copy in each of them.

`scripts/demo-settings.js` stamps the flag when it seeds a demo store, so a demo run does not boot behind
a modal — but only when the key is **absent**, because that script runs on every `demo:start` and would
otherwise undo any attempt to see the tour. Set `welcomeDismissed: false` to watch the first-launch path.

## Known gaps

- **A number field is capped but not validated against the screen's other rules.** Blank means the
  default (never 0, which means "no limit" for these keys), and the caps match the settings screen's;
  anything else the screen does to a value it does not do here.
- **The capability resolution takes the first declaring backend** (D6).
- **Pane 2 is the only surface in the app that shows a `devBlocked` hook** — the settings screen shows it
  too since #146/O19, but as a dialog rather than inline, because Save closes the panel and Apply rebuilds
  it 600 ms later.
- **The tour is not covered by a click test.** `test/welcome-tour.test.js` guards the wiring; the panes
  themselves are `node scripts/drive-app.js` territory, and a fresh store now opens the tour in front of
  whatever a script was about to click.
