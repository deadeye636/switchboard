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

"Away" means away from the **machine**, not from Switchboard (#673). The user is here while there is
input anywhere on the machine, and two sources report it:

| Source | What it sees | How fast |
|---|---|---|
| The operating system's idle time — main polls `powerMonitor.getSystemIdleTime()` every 20 s (`SYSTEM_IDLE_POLL_MS`) | input in **any** application, dated to when it happened (`now − idle`) | a return is noticed on the next poll |
| Every Switchboard window — main, detached, settings, changes and diff | focus and input in that window, throttled to 15 s (a keystroke-rate path); `focus` reports past the throttle, because coming back IS the moment the answer changes, and does not use it up, so the first keystroke after an input-less focus reports at once | at once — the fast path |

A poll records its input only when it is newer than the last sign of life, so it never moves that
backwards past a window's report, and a return a window already announced is not announced twice.
Input from before the poll started is not recorded while nothing else has been: an untouched relaunch
(a crash restart, an update) would otherwise stamp its start as a sign of life, and the first return
would be "away since the app started" — which is no absence anyone had from the app.

Three rules keep the two sources from disagreeing:

- **A window's report asks the OS first** (`recordWindowActivity`), so input elsewhere since the last
  reading is recorded before the report measures a gap from it — and a report the OS contradicts is not
  input. A focus the app caused itself (a detached window closing hands the main one the focus) arrives
  while nobody touched anything; when that reading says the machine has been idle for more than a few
  seconds, the report adds nothing and the reading's own input time stays the last sign of life. So it
  neither ends an absence with nobody there nor dates a later one late.
- **A gap counts only as far as the OS vouched for it** (`gapIsConfirmed`). The idle time answers "since
  the LAST input", so input between two readings that is followed by more input is never seen: nine and
  a half minutes of reading, a line typed in an IDE just after a poll and a keystroke in Switchboard
  before the next one would otherwise measure ten minutes away. An absence is reported only when the
  span from the last sign of life to the previous reading reaches the threshold. The same rule vetoes a
  wall clock that jumps forward (a restored VM, an NTP step) while the user works elsewhere: the reading
  before the jump covered seconds of quiet, whatever the clock says now.
- **Gaps are measured in wall time, and a reading vouches only while the poll kept firing.** A suspend is
  time away, and the monotonic clocks stop through one on a Mac or Linux, so they cannot measure it. The
  monotonic clock answers one question only: did the poll keep running since the last reading? A reading
  more than two intervals old on that clock, or one taken before `powerMonitor` reported a `resume`,
  vouches for nothing, and the wall-clock gap stands. The resume is asked for rather than inferred,
  because a suspend on a stopped clock and a forward wall jump look the same from the clocks alone. It
  only says the time asleep was real; it neither starts nor ends an absence.

Main derives an **absence**, not a state:

| | |
|---|---|
| **When** a recap appears | no input anywhere on the machine, and no focus or input in any window, for longer than `awayIdleMinutes`, then activity returns |
| **What** it lists | events since the absence BEGAN — everything before that happened while the user was present |
| **How often** | once per session per absence. Returning and opening four sessions gives four recaps; opening one again gives none |

The windows deliberately do not listen for `mousemove`. The OS idle time does not make that
distinction — any mouse movement resets it — so at the machine level a moved mouse IS a sign of life
(see Known limits). The threshold has a **one-minute floor**.

The listeners (`keydown` / `pointerdown` / `wheel` / `focus` → `reportPresenceActivity()`) live in
`shell/presence-report.js`, which every page loads — `index.html`, `settings.html`, `changed-files.html`
and `diff-window.html`. They lived in `shell/away-overview-view.js` until #673, which only the main and
the detached windows load, so review in the other three counted as time away.
`test/presence-reporting.test.js` runs that real file in a jsdom window and dispatches real events at
it — the guard against both ways of losing them (delete the block, the assertion fails; delete the
file, it cannot load) — and checks that every page names it. The poll's decisions are driven without
Electron in `test/presence.test.js`: the idle reader arrives through ctx.

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

Every former writer in the renderer is **removed**, not silenced. What survives is the class of fact only
the UI can see, NOTED through `timeline:note` — main validates the kind against `NOTEABLE_KINDS` and does
the writing, so a window cannot forge a busy edge or an exit. Three kinds are on that list, not one:
`started`, `viewed` and `file-touched`. The last two are what lets the away recap survive a reload with
the rest of the record (#396) — they are how it decides, not what it says.

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

`awaySummary` (default on) turns the whole thing off. `awayIdleMinutes` (default 10) is the threshold:
how long the machine goes without input before the time counts as away.

---

## Why it is like this

**Presence is global, not per window.** While you are working, the attention inbox says what needs you
and where. The recap answers the other question. Making the recap window-aware would build a second
inbox. The first version measured "away" as a per-session `lastViewedTime`, so it fired while you sat
there switching sessions and stayed silent when you walked away from a window that stayed in front
(#386).

**Presence is the machine, not the app (#673).** Until then only input in Switchboard's own windows
counted, on purpose — #386 defined "away from Switchboard" as away. In practice that made an hour in an
IDE or a browser, with the app on a second monitor, an hour away, and the recap then listed what the
user had been watching all along; the settings, changes and diff windows did not even report. The OS
idle time answers the question the setting always claimed to ask. Chosen over two alternatives: counting
a visible or focused window as presence (a window in front with nobody there is exactly #386's case,
and "visible" on a second monitor would never report an absence), and keeping the model with a higher
default (the reported problem stays). Lock and suspend as the definite start of an absence were left out
deliberately: the last input starts the absence either way.

**The windows ignore `mousemove`, and the threshold has a floor.** A nudged desk is not a person, so no
window infers presence from a moved pointer. The OS source cannot be told the same: its idle time is
reset by any input, a moved mouse included, and there is no finer reading to ask for (Known limits).
Below a minute every pause for thought is an absence — the original defect reached from the other side.

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
- **Reading without touching anything is away.** After `awayIdleMinutes` with no input on the machine,
  the time counts as an absence even if the user was at the screen — the same as before #673, now for
  the whole machine rather than one app.
- **An OS that cannot answer reads as present.** On some Linux setups (Wayland) the idle time comes back
  as 0, so every poll finds fresh input and no absence is ever detected from it; the windows' own reports
  cannot produce one either, since the poll keeps the last sign of life current. The safe direction:
  no recap, rather than a false one.
- **A nudged mouse ends an absence.** The OS idle time counts any mouse movement, so a desk bumped
  while the user is away ends the absence there — and a real return within the threshold after it gets
  no recap, because that return is measured from the nudge. The windows' own listeners still ignore
  `mousemove`; the OS source cannot.
- **A return within one poll interval of the threshold may go unreported.** An absence is confirmed by
  the span the OS last vouched for, which can be up to a poll interval shorter than the real one.
- **A lock or a suspend does not start an absence by itself.** The absence starts at the last input; a
  lock shorter than the threshold is no absence.
- **A night can be lost when the resume is late or missing.** On macOS and Linux nothing orders
  `powerMonitor`'s `resume` before the first report after waking, and on Linux without logind it may never
  fire; if the last reading was taken shortly before the lid closed, that reading still vouches and the
  night is dropped as no absence.

## What this feature cost to get right

Two lessons outlived their code and live in `docs/ai/lessons.md`: *`onData` is not the user* (the
banner tore itself down on the terminal's own focus report) and *driving the producer answers a
different question than the one being asked* (presence reporting was deleted with the banner and no
absence was detectable for as long as that stood).
