# Spec 03 — "What changed while I was away"

> Read `docs/specs/README.md` first.

**Status:** Implemented · **Roadmap:** Opportunity #3 (Phase 2) · **Independent:** Yes

## Problem & goal

When you return to a session that ran while you were elsewhere, "Ready" only tells you it *stopped* — not *what it did*. You then scroll terminal scrollback to re-orient, which is slow and error-prone across many agents.

**Goal:** When you come back to the machine, show a compact, dismissible **"While you were away"**
summary on the session you open: key timeline events from the absence, and the files it touched.
Never hide the live terminal.

> **The rest of this file below "Current state" is the ORIGINAL PLAN, kept for its reasoning.** Two
> things in it were wrong about what the feature should do, and #384/#386 changed them — read
> **[As built](#as-built-384-386)** at the end for what is true now. Where the two disagree, the
> as-built section wins.

## Current state (grounded)

- Per-session event log exists: `src/renderer/session/session-timeline.js` (`createTimelineStore`, `addTimelineEvent`, `getTimelineEvents`, `filterTimelineEvents`). Events are recorded throughout `app.js` via `recordTimelineEvent(sessionId, kind, label, detail)` (~line 168) — kinds include `started`, `busy`, `idle`, `needs-attention`, `response-ready`, `exited`, `stopped`, `forked`.
- The full timeline UI is `#timeline-viewer` (`index.html:72`) rendered by `renderTimelineViewer` in `app.js`.
- File activity is observable from IDE-emulation diffs/opens: `onMcpOpenDiff` / `onMcpOpenFile` (`preload.js:92–99`, `src/servers/mcp-bridge.js`). Each diff/open carries a file path per session.
- Focus/active session is `activeSessionId`; focusing happens via `showSession` / `setActiveSession` / `focusGridCard`, and `clearNotifications(sessionId)` runs on focus.
- There is **no** "last viewed" marker per session today.

## Scope

**In:** track a per-session "last viewed" timestamp; collect files-touched per session; a pure selector for "events + files since last-viewed"; a compact summary surface shown on return for sessions that changed while unfocused; dismiss.
**Out:** semantic/LLM summarization of the work (future); changing the full timeline viewer.

## Design

### Track "last viewed"
- Add `lastViewedTime: Map<sessionId, Date>` to `app.js` runtime state (near line 125).
- Set it whenever a session becomes the focused/active one (in the same place `clearNotifications` is called on focus — single choke point; also when window regains focus for the active session).

### Track files touched
- Add `filesTouchedSinceViewed: Map<sessionId, Map<path, {at, kind}>>` updated in the `onMcpOpenDiff`/`onMcpOpenFile` handlers (and optionally when a diff is accepted). Cleared for a session when its summary is shown/dismissed.

### Pure selector: `src/renderer/shell/away-summary.js` (UMD, Electron-free, tested)
```js
// buildAwaySummary({ events, filesTouched, lastViewedAt, now, maxEvents = 8 })
//   events: timeline events for the session (newest-first, as stored)
//   filesTouched: [{ path, at, kind }]
//   returns {
//     hasChanges: bool,
//     sinceText: 'You were away 12m',
//     events: [{ time, label, detail, kind }],   // since lastViewedAt, capped, de-noised
//     files:  [{ path, kind }],                   // unique, since lastViewedAt
//     waitingOnYou: bool                          // any needs-attention/response-ready since
//   }
// Rules: filter events to at > lastViewedAt; drop noise kinds (busy/idle churn) — keep
//   started/needs-attention/response-ready/exited/stopped/forked; dedupe files by path.
```

### Surface (renderer)
- On focusing a session, compute the summary from the timeline store + files map + `lastViewedTime`. If `hasChanges`, render a compact card. *(As built this reads the timeline alone — the two attention Sets named here are the RAISE state, and since #391 they are deliberately not what decides whether something was waiting.)*
- Placement: a dismissible banner at the top of `#terminal-area` (or an overlay strip above the terminal), styled like `control-toast`/timeline rows. Must not cover or unmount the terminal. Include a "View full timeline" link that opens `#timeline-viewer` for that session.
- Auto-dismiss on next user input to that terminal, or via an explicit ✕. Reset `filesTouchedSinceViewed` for the session on dismiss.
- Respect `prefers-reduced-motion` for any entrance animation.

## Files to touch
- **New:** `src/renderer/shell/away-summary.js`, `test/away-summary.test.js`.
- **Modified:** `src/renderer/app.js` (add `lastViewedTime` + `filesTouchedSinceViewed` maps near ~125; set last-viewed at the focus choke point; update files maps in MCP handlers; render/dismiss summary), `src/renderer/index.html` (script tag before `app.js`), `src/renderer/style.css` (summary card styles), optionally `src/renderer/shell/sidebar.js` if adding a small "changed since last view" affordance.

## Tests (`test/away-summary.test.js`)
- Events before `lastViewedAt` excluded; events after included and capped at `maxEvents`.
- Noise kinds (busy/idle) filtered out; meaningful kinds retained.
- Files deduped by path; `waitingOnYou` true when a needs-attention/ready event exists since.
- `hasChanges` false when nothing happened since last view → no card shown.
- `sinceText` formats elapsed duration sensibly.

## Acceptance criteria
- Leave a session running, focus another, come back → a "While you were away" card lists what happened + files touched, with a link to the full timeline.
- Card is dismissible and never hides the terminal.
- A session with no changes since last view shows no card.
- `npm test`, `ReadLints`, Electron smoke run pass.

## Risks / notes
- Timeline store caps at 80 events/session (`session-timeline.js`); long absences may truncate — that's acceptable, surface "+N earlier events" linking to the full viewer.
- Keep the selector pure; all Map/DOM/Electron interaction stays in `app.js`.

---

## As built (#384, #386)

Two things the plan got wrong, both found by using the feature rather than by testing it. It shipped
working and was almost never seen.

### 1 · It dismissed itself before it could be read (#384)

The plan says *"auto-dismiss on next user input to that terminal"*, and the code did exactly that:

```js
entry.terminal.onData(() => dismissAwaySummary(sessionId));
```

`onData` is xterm's **bytes bound for the PTY** — the user's keystrokes, but also everything the
terminal answers on its own. Revealing a session necessarily moves focus, so with focus reporting on
(DECSET 1004) the terminal replied `ESC [ O` and the banner tore itself down in the same beat it was
rendered. Measured in a running instance: one focus switch, nothing typed, one payload.

*(`isUserInput` was removed with the banner in #402 — §5. It is described here in the present tense
because the lesson is about believing `onData` is the user, and that outlives the function.)*

`isUserInput` in `shell/away-summary.js` was the filter, and it was deliberately a **whole-string match
against the shapes a terminal sends unprompted** — focus in/out, cursor-position and device-status
replies, device attributes, mouse in X10 and SGR. A bare `ESC` (the Escape key), the arrows in either
mode, and a bracketed paste all stay input, because those are the user acting.

### 2 · "Away" meant a focus change, not an absence (#386)

The plan's trigger was *"focus a session that was active while unfocused"*, measured with a
per-session `lastViewedTime`. So it fired while you sat there switching sessions, and stayed silent
when you walked away from a window that stayed in front. `sinceText` said "You were away 12m" about
the gap between two focus events.

**Presence is one global fact, and that is the decision this feature turns on.** Any Switchboard
window focused, or receiving input, means you are here. It is deliberately *not* per window:

> While you are working, the **attention inbox** is the surface that says what needs you and where.
> The recap answers the other question — what happened while I was gone. Two surfaces, two questions;
> making the recap window-aware would build a second inbox.

`src/app/presence.js` owns it, because no renderer can see the others: each window has its own
`windowFocused`. Every window reports focus and input (throttled to 15 s — this is a keystroke-rate
path), and main reports an **absence**, not a state:

| | |
|---|---|
| **When** the recap shows | no focus and no input in any window for longer than `awayIdleMinutes`, then activity returns |
| **What** it lists | events since the absence BEGAN — everything before that happened while you were present |
| **How often** | once per session per absence. Returning and opening four sessions gives four recaps; opening one of them again gives none |

`mousemove` is deliberately not a presence signal: a nudged desk is not a person. The threshold has a
one-minute floor — below that every pause for thought is an absence, which is the original defect
reached from the other side.

Settings: `awaySummary` (on) turns the whole thing off; `awayIdleMinutes` (10) is the threshold.

### 3 · A window of its own had almost nothing to recap (#395)

Every source of "this session is working / this session wants you" addressed the **main window**, and
there are **three**, not one — a fix that touches only the first leaves the recap silently
backend-dependent:

| Source | Where |
|---|---|
| the title-spinner and progress heuristics → `cli-busy-state` | `app/terminal/spawn.js` (`sendToWindow` takes `getMainWindow()`) |
| the store-derived busy state, for the backends that name their own sessions | `watch/adopt.js` |
| the hook server's `attention-signal` | `app/hooks.js` |

Those feed `shell/attention-engine.js`, which is what records `response-ready` and `needs-attention` —
exactly the pair behind the "Waiting on you" badge. A session in a window of its own (#2, #370) never
got them, so that window's `sessionTimelineStore` never learned a turn had ended there. It was left
with the **lifecycle kinds** — `started`, `exited`, `stopped`, `forked` — which do reach it
(`process-exited` is addressed to the owner as well as to main, and a re-key is recorded locally). So
its recap was not dead, but it rendered only when one of those happened, and could never say that
something was waiting.

**The files touched were missing too, and that half is fixed as a side effect.** `servers/mcp-bridge.js`
addressed the main window, so `recordFileTouched` never fired in a window of its own — this section once
claimed that window could show the files, which was never true. #392 made the bridge resolve its window
per send instead of capturing one, and #393 made that window the one that RENDERS the session. Since the
handlers in `shell/session-ipc.js` run in every window, the touched files now land where the session is.

**The fix, and why not the cheap one.** Relaying `cli-busy-state` itself was rejected and stays
rejected: it hands that window's engine a badge, a sidebar update and a notification path — a second
inbox by accident, the thing the presence decision above exists to avoid. Instead the fact travels on
a **second channel with a second contract**, `timeline-signal` → `recordAttentionSignal`, which writes
that window's timeline and status map and touches no attention set. `app/detach.js` sends it only when
the owner is not main, so main cannot double-record, and all three producers echo.

The seam it needed was already there: #391 split recording a turn's end from raising it, and #390
gated announcing to the main window. `docs/specs/17-detached-windows.md` §2 has the routing rule.

What deliberately does **not** travel is "Ready for review" — a statement that something waits for the
user belongs where the inbox is. Such a window shows *working*, and its recap can now say *something
finished while you were gone*.

Two things still hold, and one is a real limit: a session that is busy and **stays** busy sends no
edge, so `session-reattached` carries the busy state along with `running` — otherwise a window taking
one mid-turn draws it as idle until the turn ends. And the timeline is still per renderer and in
memory (below), so a reload empties what the recap would have shown.

One more consequence of that split, worth stating plainly: the **main** window's recap used to be
silent about the session that was in front when you left, because the record was written only for an
unfocused session. That was the same defect reached from the ordinary path, and #391 fixed it.

Three more things are per renderer and in memory, and a reload or a restart empties them:
`lastViewedTime`, `filesTouchedSinceViewed`, `sessionTimelineStore`.

### 4 · The record is moving out of the renderer (#396, in progress)

The three above are the subject of [#396](https://github.com/deadeye636/switchboard/issues/396): the
record the recap reads is emptied by a reload, a window close and a restart — exactly the span it
exists to describe — and a session moved between windows hands its past to a window that never had it.

Two steps have landed. **The record itself** is a `session_timeline` table written by the main process
(`src/db/timeline-store.js`, shape and retention in `src/db/timeline-record.js`, both bounded by a
stated 500-events-per-session / 30-day pair rather than by the renderer's undecided 80). **The
producers** now write it: `src/app/timeline.js` sits in front of `detach.sendTimelineSignal` — in
FRONT, because that call deliberately sends nothing when the session lives in the main window, so
recording behind it would record every session except the ordinary ones.

**One meaning changed, and it is the decision the issue turns on.** In the record, `response-ready`
now means *the turn ended* — nothing about where the user was looking. The old meaning ("the turn
ended while you were not looking at THIS session") is a per-window fact and a per-session record
cannot hold one; the question it was really asking is answered by the absence, which `app/presence.js`
already owns as one global fact. **Raising** a ready session — the inbox flag, the ready class, the
badge — keeps its focus condition exactly as §1 of this file describes. #391 split recording from
raising, and this uses that seam rather than cutting a new one.

**The renderer no longer keeps a record of its own.** It holds a read-through CACHE of what main has:
a session's history is fetched once per window and kept current by a `timeline-appended` broadcast to
every window, because which window draws which session changes while the app runs. The cache carries a
`loaded` set, so "not fetched yet" and "fetched, nothing there" stay different answers — answering the
first as if it were the second is how a recap ends up empty for the one absence it was built for.

Every former writer in the renderer is **removed**, not silenced. The one exception is a fact only the
UI can see — a handoff packet seeded into a session — and it is NOTED through `timeline:note`, which
accepts a short list of kinds and lets main do the writing. A window cannot forge a busy edge or an exit.

The recap's last two memories moved with it. `viewed` and `file-touched` are kinds in the record rather
than tables of their own; `viewed` is a MARKER, replaced rather than accumulated, because it is written
every time the user looks at a session and a stream of it would push the events that matter out of the
per-session cap. Neither is listed by the recap or the timeline viewer: they are how it decides, not
what it says.

**What deletes a history, and what must not.** `deleteCachedSession` / `deleteCachedFolder` are the
INDEX rebuilding itself, not a deletion — hanging the history off them threw it away on an ordinary
scan (measured: a turn's events survived under a minute). Deleting a project is the real deletion path.

### 5 · One inbox entry and one overview — the banner is gone (#402)

The banner was the **wrong shape**, and every one of its three costs was felt the first time the
feature was used in earnest rather than tested:

- **It was spread out.** It appeared over the terminal of the session it was about, in whichever
  window happened to render it. With sessions across several windows, "what did I miss" meant
  visiting each window and focusing each session in turn. Nothing answered the question once.
- **A misplaced keystroke destroyed it.** Dismissing on real input was deliberate — §1 is the story of
  getting that filter right — but it meant the recap could be gone before it was read, with no way to
  recall it.
- **It was per session.** Five sessions that changed produced five banners, one focus change at a
  time, and nothing said how many were still waiting.

Meanwhile the app already had one place that answers *something wants you*: the attention inbox,
addressed to the main window on purpose. The recap was the one attention-shaped thing not using it.

**As built.** Returning from an absence produces ONE entry in the inbox. Opening it shows one
overview of every session that changed while the user was gone, each row expandable to the events and
touched files the banner used to show, with a *Go to session* button beside it.

| | |
|---|---|
| The data | `getTimelineEventsSince(awaySince)` — ONE cross-session read (`timeline:since`), because the overview's job is to say WHICH sessions changed, and asking per session means knowing the answer first |
| The shaping | `buildAwayOverview` in `shell/away-summary.js`, beside the per-session `buildAwaySummary` it reuses per group. Pure, so the grouping and the caps are tested rather than clicked |
| The surface | `shell/away-overview-view.js` + `#away-overview-viewer`, a main-area viewer like the timeline one |
| Reaching a session | `reveal-session` (`app/detach.js`), which resolves the OWNER window per session. Always through main, even for a session this window renders — a row here may be about a session in a window of its own, and mounting that locally is two xterms on one PTY |

**One surface across ALL windows had to be enforced, not assumed.** Every window loads the same
shell, so a singleton inside one renderer is not unique across several. Two things make it one:
`raisesAttention()` (#390) — the same answer that decides whether a window may badge, chime or notify
— keeps the pending recap and the overview in the window that owns the inbox; and the `awayOverview`
view kind deliberately names **no loader**, which is what makes `canLeaveWindow` in `views/panes-view.js`
refuse to hand its tab to another window. A recap dragged across would arrive blank *and* leave a
second surface behind.

**Losing it is now a decision.** Closing the view — the header ×, Escape, opening a session — leaves
the entry in the inbox to be opened again; only the entry's own × throws the recap away. Every inbox
row got that × in the same pass: dismissing a session settles it *without* stamping it as viewed,
because "I do not care about this one" and "I read this one" are different statements and only the
second belongs in the record.

**A second absence replaces the first** — including when it found nothing, which is why the refresh
can clear as well as set. An open overview is updated in place rather than joined by a second one, and
leaving the previous one standing would have the inbox asserting "you were away 12m" about an absence
that ended two absences ago.

**And the entry survives a reload (#422).** The record behind it had since #396; the fact that an
absence just ended had not, because it arrived as one `presence-returned` event in one renderer and
nothing asked for it again — so a dev reload, or the app's own restart path, dropped the recap while
the data it was built from sat untouched. `app/presence.js` holds the pending absence now, and the
discard with it: the renderer asks for the absence on load (`presence:pending-absence`) and rebuilds
the summary from the record, and `dismissAwayRecap` tells main which absence it threw away
(`presence:discard-absence`). Two things that shape has to get right, and both are load-bearing:

- **Both halves move together.** Persisting only the absence brings the entry back after every reload
  *including* the ones the user dismissed it in, which is worse than losing it.
- **The discard names the absence it means.** A newer absence can end between the click and the
  message arriving; clearing whatever is held would throw away a recap nobody has seen.

One asymmetry on purpose: an absence during which *nothing happened* clears the renderer's pending
recap and leaves main's absence standing. There is nothing to discard — the user was never shown an
entry — and the record can still grow into that absence, in which case a reload correctly finds it.

The restore runs behind `raisesAttention()` like the live announcement, so a window of its own cannot
claim the recap by reloading, and behind the settings init, so a recap is not restored into a window
whose user has switched the feature off. It is main-process memory, not a table: a reload and a window
close are what the issue is about, and a recap that outlived a restart of the app would be reporting an
absence from before it.

What went with the banner: `shell/away-summary-banner.js`, the `#away-summary` styles, and
`isUserInput` with the whole `TERMINAL_REPORT` table §1 is about. That filter existed solely because
the banner dismissed on terminal traffic; the overview is never dismissed by a keystroke, so the
problem it solved no longer exists. §1 stays as the record of why — the lesson is about believing
`onData` is the user, not about the regex.

Settings keep their meaning exactly: `awaySummary` (on) turns the whole thing off, `awayIdleMinutes`
(10) is the threshold.

### 6 · …and it took the presence reporting with it (#426)

The banner deleted in §5 held one thing that was not about banners: the throttled `keydown` /
`pointerdown` / `wheel` / `focus` listeners that call `reportPresenceActivity()`. Nothing took them
over. So `lastActivityAt` in `app/presence.js` never left null, `absenceEnded` always answered null,
and **no absence was ever detected** — the inbox entry of §5 and its survival across a reload above are
both correct and were both unreachable from ordinary use for as long as this stood.

What made it invisible is worth more than the fix: every check of the recap, in both issues, had
called `reportPresenceActivity()` itself. Driving the producer is the natural way to test a consumer,
and it answers a different question than the one being asked — *does the app produce this* was never
put to the app. The measurement that finally settled it was two real key presses through
`Input.dispatchKeyEvent`, 85 s apart, with the harness touching nothing else.

The listeners live in `shell/away-overview-view.js` now, beside the surface they feed, and
`test/presence-reporting.test.js` runs the real file in a jsdom window and dispatches real events at
it. That test is the guard on both ways of losing this again: drop the block and its assertion fails,
delete the file and it cannot even load. A source-regex guard would have passed against a file that
registers a listener and sends nothing.

`mousemove` stayed out, deliberately: it fires while a hand rests on a desk that gets nudged, which is
exactly the presence this must not infer. `focus` clears the throttle before reporting — coming back
IS the moment the answer changes, and that is the one report that must not be skipped.
