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
- On focusing a session, compute the summary from the timeline store + files map + `lastViewedTime`. If `hasChanges` and the session changed *while unfocused* (i.e. it was in `responseReadySessions`/`attentionSessions`, or had activity after `lastViewedAt`), render a compact card.
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

### Known gap: a window of its own sees no `WAITING_KINDS`

`cli-busy-state` is sent to the **main window only**, deliberately — the sidebar, the attention inbox
and the badges live there, and `sendToWindow` in `app/terminal/spawn.js` takes `getMainWindow()`. That
signal is what drives `shell/attention-engine.js`, which is what records `response-ready` and
`needs-attention`.

Those two are exactly the pair behind the "Waiting on you" badge. A session in a window of its own
(#2, #370) therefore **cannot show them**: that window's `sessionTimelineStore` never receives them.
What it can show is `started`, `exited`, `stopped`, `forked` and the files touched.

Not fixed here, and the reason is that the cheap fix is the wrong one: relaying `cli-busy-state` to
the owning window as well would also hand that window's attention engine a badge, a sidebar update and
a notification path, which is a second inbox by accident — the thing the presence decision above
exists to avoid. Fixing it properly means separating "record the timeline" from "raise attention",
which is its own change.

Three more things are per renderer and in memory, and a reload or a restart empties them:
`lastViewedTime`, `filesTouchedSinceViewed`, `sessionTimelineStore`.
