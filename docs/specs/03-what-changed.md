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

`isUserInput` in `shell/away-summary.js` is the filter, and it is deliberately a **whole-string match
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
