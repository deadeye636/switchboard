# Spec 03 — "What changed while I was away"

> Read `docs/specs/README.md` first.

**Status:** Implemented · **Roadmap:** Opportunity #3 (Phase 2) · **Independent:** Yes

## Problem & goal

When you come back to a session that ran while you were elsewhere, "Ready" only says it *stopped* —
not *what it did*. Re-orienting means scrolling terminal scrollback, which is slow and gets worse with
every extra agent.

**Goal:** when you return to the machine, one place answers *what happened while I was gone* — the
key events of the absence and the files that were touched, per session, without hiding a terminal.

The **attention inbox** answers a different question — *what wants me now* — and the two are kept
apart on purpose. See [Why it is like this](#why-it-is-like-this).

---

## How it works now

### Presence is one global fact — `src/app/presence.js`

The user is here if **any** Switchboard window has focus or is receiving input. Every window reports
focus and input, throttled to 15 s (this is a keystroke-rate path); `focus` clears the throttle before
reporting, because coming back IS the moment the answer changes.

Main derives an **absence**, not a state:

| | |
|---|---|
| **When** a recap appears | no focus and no input in any window for longer than `awayIdleMinutes`, then activity returns |
| **What** it lists | events since the absence BEGAN — everything before that happened while the user was present |
| **How often** | once per session per absence. Returning and opening four sessions gives four recaps; opening one again gives none |

`mousemove` is deliberately not a presence signal. The threshold has a **one-minute floor**.

The listeners (`keydown` / `pointerdown` / `wheel` / `focus` → `reportPresenceActivity()`) live in
`shell/away-overview-view.js`, beside the surface they feed. `test/presence-reporting.test.js` runs
that real file in a jsdom window and dispatches real events at it — it is the guard against both ways
of losing them (delete the block, the assertion fails; delete the file, it cannot load).

### The record is a table, written only by main — `#396`

| | |
|---|---|
| Table | `session_timeline`, written by `src/db/timeline-store.js` |
| Shape & retention | `src/db/timeline-record.js` — bounded at **500 events per session / 30 days** |
| The one writer | `src/app/timeline.js`, which sits **in front of** `detach.sendTimelineSignal` (that call deliberately sends nothing when the session lives in the main window, so recording behind it would record every session except the ordinary ones) |
| Kinds | `started`, `busy`, `idle`, `needs-attention`, `response-ready`, `exited`, `stopped`, `forked`, plus `viewed` and `file-touched` |

`response-ready` in the record means **the turn ended** — nothing about where the user was looking.

`viewed` is a **marker**: replaced rather than accumulated, because it is written every time the user
looks at a session and a stream of it would push the events that matter out of the per-session cap.
Neither `viewed` nor `file-touched` is listed by the recap or the timeline viewer — they are how it
decides, not what it says.

**What deletes a history:** deleting a project. `deleteCachedSession` / `deleteCachedFolder` are the
index rebuilding itself, **not** a deletion — hanging the history off them threw it away on an
ordinary scan (measured: a turn's events survived under a minute).

### The renderer holds a cache, not a record

A session's history is fetched once per window (`window.api.getSessionTimeline`) and kept current by a
`timeline-appended` broadcast to **every** window — which window draws which session changes while the
app runs. The cache carries a `loaded` set, so *not fetched yet* and *fetched, nothing there* stay
different answers.

Every former writer in the renderer is **removed**, not silenced. The one exception is a fact only the
UI can see — a handoff packet seeded into a session — which is NOTED through `timeline:note`; main
validates the kind and does the writing. A window cannot forge a busy edge or an exit.

### The surface: one inbox entry, one overview — `#402`

Returning from an absence produces **one** entry in the attention inbox. Opening it shows one overview
of every session that changed, each row expandable to that session's events and touched files, with a
*Go to session* button.

| | |
|---|---|
| The data | `getTimelineEventsSince(awaySince)` — ONE cross-session read (`timeline:since`), because the overview's job is to say WHICH sessions changed, and asking per session means knowing the answer first |
| The shaping | `buildAwayOverview` in `shell/away-summary.js`, beside the per-session `buildAwaySummary` it reuses per group. Pure, so grouping and caps are tested rather than clicked |
| The surface | `shell/away-overview-view.js` + `#away-overview-viewer`, a main-area viewer like the timeline one |
| Reaching a session | `reveal-session` (`app/detach.js`), which resolves the OWNER window per session. Always through main, even for a session this window renders — a row may be about a session in a window of its own, and mounting that locally is two xterms on one PTY |

**One surface across ALL windows is enforced, not assumed.** Every window loads the same shell, so a
singleton inside one renderer is not unique across several. Two things make it one: `raisesAttention()`
(#390) keeps the pending recap and the overview in the window that owns the inbox, and the
`awayOverview` view kind deliberately names **no loader**, which is what makes `canLeaveWindow` in
`views/panes-view.js` refuse to hand its tab to another window.

**Losing it is a decision.** The header ×, Escape or opening a session closes the view and leaves the
entry in the inbox; only the entry's own × throws the recap away. Every inbox row has that × — it
settles a row *without* stamping it as viewed, because "I do not care about this one" and "I read this
one" are different statements and only the second belongs in the record.

**A second absence replaces the first**, including when it found nothing (so the refresh can clear as
well as set). An open overview is updated in place rather than joined by a second one.

### It survives a reload — `#422`

`app/presence.js` holds the pending absence **and** the discard. The renderer asks for it on load
(`presence:pending-absence`) and rebuilds the summary from the record; `dismissAwayRecap` tells main
which absence it threw away (`presence:discard-absence`). Two things that shape has to get right:

- **Both halves move together.** Persisting only the absence brings the entry back after every reload
  *including* the ones the user dismissed it in — worse than losing it.
- **The discard names the absence it means.** A newer absence can end between the click and the
  message arriving; clearing whatever is held would throw away a recap nobody has seen.

The restore runs behind `raisesAttention()` like the live announcement (so a window of its own cannot
claim the recap by reloading) and behind the settings init (so a recap is not restored into a window
whose user switched the feature off).

### Settings

`awaySummary` (default on) turns the whole thing off. `awayIdleMinutes` (default 10) is the threshold.

---

## Why it is like this

**Presence is global, not per window.** While you are working, the attention inbox says what needs you
and where. The recap answers the other question. Making the recap window-aware would build a second
inbox. The first version measured "away" as a per-session `lastViewedTime`, so it fired while you sat
there switching sessions and stayed silent when you walked away from a window that stayed in front
(#386).

**`mousemove` is not presence, and the threshold has a floor.** A nudged desk is not a person; below a
minute every pause for thought is an absence — the original defect reached from the other side.

**The recap is an inbox entry, not a banner (#402).** The banner was the wrong shape and each of its
three costs showed on first real use: it appeared over the terminal of the session it was about, in
whichever window rendered it, so "what did I miss" meant visiting every window; a misplaced keystroke
destroyed it with no way to recall it; and five changed sessions produced five banners with nothing
saying how many were left. The app already had one place that answers *something wants you*.

**The record lives in main (#396).** In the renderer it was emptied by a reload, a window close and a
restart — exactly the span it exists to describe — and a session moved between windows handed its past
to a window that never had it.

**Recording is split from raising (#391).** That is why `response-ready` in the record can mean "the
turn ended" while **raising** a ready session — the inbox flag, the ready class, the badge — keeps its
focus condition. The old meaning ("the turn ended while you were not looking at THIS session") is a
per-window fact and a per-session record cannot hold one; the question it was really asking is the
absence, which presence already owns. The same split fixed the ordinary case: main's recap used to be
silent about the session that was in front when you left, because the record was written only for an
unfocused session.

**A window of its own gets a second channel, not a relay (#395).** Every source of "this session is
working / wants you" addressed the **main** window — the title-spinner heuristics in
`app/terminal/spawn.js`, the store-derived busy state in `watch/adopt.js`, the hook server's
`attention-signal` in `app/hooks.js`. All three feed `shell/attention-engine.js`, so a session in its
own window never learned a turn had ended there. Relaying `cli-busy-state` was rejected and stays
rejected: it hands that window a badge, a sidebar update and a notification path — a second inbox by
accident. The fact travels on `timeline-signal` → `recordAttentionSignal`, which writes that window's
timeline and status map and touches no attention set; `app/detach.js` sends it only when the owner is
not main, so main cannot double-record. What deliberately does **not** travel is "Ready for review" —
a statement that something waits for the user belongs where the inbox is. Such a window shows
*working*, and its recap can say *something finished while you were gone*. Routing rule:
`docs/specs/17-detached-windows.md` §2.

**Files touched follow the session.** `servers/mcp-bridge.js` used to capture one window, so
`recordFileTouched` never fired in a window of its own. #392 made the bridge resolve its window per
send and #393 made that the window that RENDERS the session; the handlers in `shell/session-ipc.js`
run in every window, so touched files land where the session is.

---

## Known limits

- **A busy session that stays busy sends no edge.** `session-reattached` therefore carries the busy
  state alongside `running` — otherwise a window taking a session mid-turn draws it as idle until the
  turn ends.
- **The pending absence is main-process memory, not a table.** A reload and a window close are what
  #422 is about; a recap that outlived a restart of the app would be reporting an absence from before
  it.
- **An absence in which nothing happened** clears the renderer's pending recap and leaves main's
  absence standing — on purpose. There is nothing to discard, the user was never shown an entry, and
  the record can still grow into that absence, in which case a reload correctly finds it.
- **Retention is 500 events per session / 30 days.** A long absence can be truncated.

## What this feature cost to get right

Two lessons outlived their code and live in `docs/ai/lessons.md`: *`onData` is not the user* (the
banner tore itself down on the terminal's own focus report) and *driving the producer answers a
different question than the one being asked* (presence reporting was deleted with the banner and no
absence was detectable for as long as that stood).
