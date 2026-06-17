# Spec 03 — "What changed while I was away"

> Read `docs/specs/README.md` first.

**Status:** Ready to build · **Roadmap:** Opportunity #3 (Phase 2) · **Independent:** Yes

## Problem & goal

When you return to a session that ran while you were elsewhere, "Ready" only tells you it *stopped* — not *what it did*. You then scroll terminal scrollback to re-orient, which is slow and error-prone across many agents.

**Goal:** When you return to / focus a session that was active while unfocused, show a compact, dismissible **"While you were away"** summary: key timeline events since you last looked, and the files it touched. Never hide the live terminal.

## Current state (grounded)

- Per-session event log exists: `public/session-timeline.js` (`createTimelineStore`, `addTimelineEvent`, `getTimelineEvents`, `filterTimelineEvents`). Events are recorded throughout `app.js` via `recordTimelineEvent(sessionId, kind, label, detail)` (~line 168) — kinds include `started`, `busy`, `idle`, `needs-attention`, `response-ready`, `exited`, `stopped`, `forked`.
- The full timeline UI is `#timeline-viewer` (`index.html:72`) rendered by `renderTimelineViewer` in `app.js`.
- File activity is observable from IDE-emulation diffs/opens: `onMcpOpenDiff` / `onMcpOpenFile` (`preload.js:92–99`, `mcp-bridge.js`). Each diff/open carries a file path per session.
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

### Pure selector: `public/away-summary.js` (UMD, Electron-free, tested)
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
- **New:** `public/away-summary.js`, `test/away-summary.test.js`.
- **Modified:** `public/app.js` (add `lastViewedTime` + `filesTouchedSinceViewed` maps near ~125; set last-viewed at the focus choke point; update files maps in MCP handlers; render/dismiss summary), `public/index.html` (script tag before `app.js`), `public/style.css` (summary card styles), optionally `public/sidebar.js` if adding a small "changed since last view" affordance.

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
