# Switchboard Productivity Roadmap

> **[← Roadmap](ROADMAP.md)** · Stand 2026-06-30 · Status: teils erledigt (#08 Notifications/Tray, #09 „Während du weg warst", #10 Gruppen, #11 Folder-First) · offen: #03 One-Click-Handoff, #04 Grid-Layout 5B, #05 Detection-Härtung/Bulk
>
> Strategie- und Detaildokument. Der laufende Status steht im [Board](ROADMAP.md).

**North Star:** Boost a human's productivity at *managing* Claude Code sessions — minimize the time and attention cost of supervising many agents at once.

**Framing:** Switchboard already has a strong supervision layer (attention inbox, status model, timeline, session health, usage monitoring). The biggest wins now come from getting that intelligence **out of the app window** and **shortening every context switch**, rather than adding new surfaces.

---

## Audit: what already exists

Confirmed in the codebase so we don't rebuild it:

- **Status model** — `public/session-status.js`: `Needs You → Ready → Working → Running → Exited → Idle`, with inbox membership, priorities, counts, and filtering.
- **Attention inbox** — `public/sidebar.js` (`buildAttentionInbox`) renders the prioritized list with a working "Focus next" button (`getNextAttentionInboxItem`).
- **Attention detection** — `public/app.js:401` matches iTerm2 OSC 9 output against `/attention|approval|permission|needs your|wants to enter/i`.
- **Response-ready detection** — `setActivity()` flips a session to "Ready" when the agent stops producing output and the session is not focused.
- **Session health** — `public/session-health.js`: `Healthy → Growing → Marathon Risk → Handoff Recommended`, plus `buildHandoffTemplate()` and `buildHandoffRequestPrompt()`.
- **Usage monitoring** — `public/usage-status.js`: 5h / weekly / Opus / Sonnet / extra-usage quota.
- **Timeline** — per-session event log (started, busy, needs-attention, ready, exited, stopped, forked).
- **Scheduling** — `schedule-runner.js`: cron-driven scheduled tasks from `schedule-*.md`.
- **Accessibility** — live-region announcements, focus-visible styles, reduced-motion support.

## Audit: confirmed gaps

- **No native OS signal.** `main.js` contains zero `Notification`, `setBadgeCount`/`setBadge`, `flashFrame`, `setOverlayIcon`, or `Tray` usage. All attention state dies at the renderer boundary.
- **No sound/alert** option for attention.
- **No global hotkey** for "jump to next session needing you" — only an in-app button. The renderer keydown handler (`app.js:1229`) wires only grid-toggle and session navigation.
- **No "what changed while I was away"** summary; "Ready" tells you an agent stopped, not what it did.
- **Handoff is manual** — health recommends it and generates the prompt, but the human still copies/pastes/runs and forks by hand.
- **Attention detection is heuristic** — regex over OSC-9 terminal text; can miss states it wasn't tuned for.

---

## Prioritized opportunities

| # | Opportunity | Job-to-be-done | Impact | Effort |
|---|-------------|----------------|--------|--------|
| 1 | Native notifications + dock/taskbar badge + tray | "Tell me when an agent needs me, even when I look away" | High | Low–Med |
| 2 | Global hotkey + alert sound for next-attention | "Let me jump between agents without the mouse" | Med–High | Low |
| 3 | "What changed while I was away" per-session summary | "Re-orient me instantly when I return" | Med–High | Med |
| 4 | One-click handoff | "Keep long sessions cheap and fast" | Med–High | Med |
| 5 | Reliable attention detection via Claude Code hooks | "Never miss a prompt" | Med | Med |
| 6 | Bulk actions from the grid | "Manage many agents at once" | Med | Med–High |
| 7 | Session groups (visual folders) + flexible grid layout | "Organise many agents on one project so I can read the room" | Med–High | Med–High |

---

## Phase 1: Notify me even when I look away  *(Opportunity #1 + #2)*

**Goal:** The supervision intelligence reaches the human regardless of whether Switchboard is the focused window. This is the single highest-leverage change because the signal already exists internally — it just needs an exit door.

- [ ] Track window focus/visibility in the renderer (`document.hidden` / `visibilitychange` / `blur`/`focus`).
- [ ] On a session entering **Needs You** while the window is unfocused, emit a native OS notification (title = project/session, body = reason). Clicking it focuses the window and that session.
- [ ] On **Ready** while unfocused, emit a lower-priority notification (coalesced — see below).
- [ ] Maintain a **dock/taskbar badge count** = number of sessions currently in the inbox (Needs You + Ready), cleared as they're attended to.
- [ ] Add a **tray icon** with a summary tooltip and a menu: open Switchboard, "focus next attention", quick counts.
- [ ] **Coalesce/throttle** notifications so 5 agents finishing at once doesn't produce 5 toasts — batch into "3 sessions need you".
- [ ] Add **Global Settings** toggles: notifications on/off, sound on/off, notify-on-Ready vs only-Needs-You.
- [ ] Add an optional **alert sound** on Needs You (respect the sound setting and reduced-motion/quiet preferences).
- [ ] Add a **global hotkey** to focus the next attention session (wraps existing `getNextAttentionInboxItem`); make it configurable, default off to avoid clashes.
- [ ] IPC: renderer → main to fire notifications and set badge/tray; main → renderer on notification click to focus the session.
- [ ] Tests: a pure helper that decides *whether* to notify (focus state + status transition + settings + coalescing window) so the decision logic is unit-tested without Electron.
- [ ] Validate: `npm test`, `ReadLints`, Electron smoke run, and a manual "unfocus → trigger attention → see notification + badge → click → focuses session" pass.

**Why first:** Converts the existing attention model into real-world productivity with mostly plumbing, not new product surface. De-risks everything else.

## Phase 2: Shorten the return trip  *(Opportunity #3)*

**Goal:** When you come back to a session, you understand what happened in seconds instead of scrolling scrollback.

- [ ] Mark a "last viewed" point per session (timestamp or scrollback offset) when it loses focus.
- [ ] On return / on a Ready session, surface a compact **"While you were away"** summary: key events from the timeline since last-viewed, files touched (from IDE-emulation diffs), and whether it's waiting on you.
- [ ] Make the summary dismissible and non-blocking; never hide the live terminal.
- [ ] Tests for the pure "events since last-viewed" selector.

## Phase 3: One-click handoff  *(Opportunity #4)*

**Goal:** Turn "Handoff Recommended" from advice into an action.

- [ ] When health is `handoff-recommended`, expose a single action: request the handoff packet from the current session, fork a fresh session pre-seeded with it, and switch to the new session.
- [ ] Reuse `buildHandoffRequestPrompt()` / `buildHandoffTemplate()`; wire into the existing fork flow.
- [ ] Make each step inspectable/cancelable (don't silently spend tokens).

## Phase 4: Harden detection & scale supervision  *(Opportunities #5 + #6)*

**Goal:** Fewer missed prompts; manage many agents with one gesture.

- [ ] Investigate Claude Code hooks (e.g. permission / PreToolUse) as a more reliable attention signal than OSC-9 regex; fall back to current heuristic.
- [ ] Add safe **bulk actions** from the grid command center (e.g. focus-through-queue, dismiss-all-ready). Keep anything token-spending or destructive behind explicit confirmation, consistent with the existing styled-dialog pattern.

---

## Phase 5: Organise sessions into groups + flexible grid layout  *(Opportunity #7)*

**Goal:** When several agents work on the same project, let the human create named visual groups ("folders") so the sidebar and grid stay readable, and let them arrange the grid to match how they actually watch the work.

This is two related-but-separable features. Ship **5A (groups)** first — it delivers the readability win on its own and is lower-risk. **5B (flexible layout)** builds on it.

### Why this isn't already solved

- The sidebar groups by **project** (automatic) and by **slug** (`buildSlugGroup` — forks / scheduled tasks sharing a slug). Neither is **user-defined**: there's no way to say "these 3 agents are my 'checkout refactor' crew."
- The grid (`grid-view.js` / `grid-layout.js`) is a **uniform CSS auto-grid** — equal-size cards in sidebar order, columns derived from width. There's **no visual group boundary, no drag, and no resize**.

### Design notes / decisions to make

- **Group model:** `{ id, name, color, order, collapsed, sessionIds[] }`. Recommend **one group per session** initially (simpler mental model + rendering) with multi-group as a later option.
- **Scope:** allow a group to span sessions within a project (primary use case) but don't *forbid* cross-project membership — store a project label per card so mixed groups still read clearly.
- **Persistence:** reuse an existing pattern — either a `get-setting`/`set-setting` blob (`groups`) or a DB table mirroring `toggle-star`/`archive-session`. DB is more robust for membership lookups; a setting blob is faster to ship. Recommend the setting blob for 5A, migrate to DB only if needed.
- **Grouping vs project headers:** groups render *within* their project section (or as a top-level band for cross-project groups), visually distinct via the group color — built on the existing collapsible `slug-group` pattern.

### Phase 5A: Session groups

- [ ] Add a pure `groups-model.js` helper (create/rename/recolor/reorder/assign/unassign, membership lookups, ordering) with full unit tests — keep it Electron-free, matching the `*-status.js` / `*-health.js` pattern.
- [ ] Persist groups (setting blob or DB) and load on startup.
- [ ] Sidebar: render a collapsible **group section** (name + color + count + collapse state) above/within its project, reusing `slug-group` styling.
- [ ] Assign sessions to a group: context-menu / drag-into-group in the sidebar, plus an explicit "New group from selection".
- [ ] Grid: render each group as a **labeled bounded region** (colored header + border) containing its cards; ungrouped sessions fall into a default region.
- [ ] Add a **group filter** to the grid status-filter bar (alongside All / Needs You / Ready / Running).
- [ ] Roll group **status counts** up to the group header (e.g. "2 need you" on the group) so a collapsed group still signals attention.
- [ ] Preserve existing keyboard navigation; ensure 2D grid nav (`navigateGrid`) still works across group boundaries.
- [ ] Validate: `npm test`, `ReadLints`, Electron smoke run (create group, assign, collapse, filter, restart-persistence).

### Phase 5B: Flexible grid layout (resize / drag)

Recommended approach: **snap-to-grid spans + drag-to-reorder**, not a free-form absolute canvas — it preserves the existing CSS-grid architecture and keeps terminal `fitAndScroll` clean on every geometry change.

- [ ] **Resize:** let a card span columns/rows (e.g. 1×1, 2×1, 2×2) by dragging a corner handle; snap to the grid; persist span per session. Call `fitAndScroll` after the span changes so the terminal reflows.
- [ ] **Drag-to-reorder:** drag a card to a new slot (and into/out of a group); persist order. Reuse the group-assignment drag interaction from 5A.
- [ ] Persist per-session layout (span + order + group) so the grid restores across restarts, like `gridViewActive` / `gridStatusFilter`.
- [ ] Add a "reset layout" affordance.
- [ ] Keep performance sane: debounce `fitAndScroll`, batch DOM writes, respect `prefers-reduced-motion` for any drag animation.
- [ ] Validate: `npm test`, `ReadLints`, Electron smoke run with several live terminals (resize/drag/reorder, confirm terminals stay fit and scrollback intact).
- [ ] **Stretch (separate spike):** fully free-form absolute-positioned canvas with x/y/w/h per card. Higher cost (collision, persistence, fit recalculation); only pursue if span-based layout proves too rigid in real use.

---

## Success signals

- Time-to-acknowledge a "Needs You" event when Switchboard is unfocused drops sharply.
- Users keep Switchboard in the background (tray/badge) instead of foregrounded — proof it's doing the watching for them.
- Fewer "stuck waiting" agents sitting idle on an unanswered permission prompt.
- More long sessions handed off at the recommended point rather than dragging on.

## Guardrails

- Never spend tokens without an explicit user action.
- Notifications must be coalesced and silenceable — annoyance kills adoption.
- Keep pure decision logic unit-testable and out of Electron-specific code, matching the repo's existing `*-status.js` / `*-health.js` pattern.
- Per the existing UX plan: build in small, testable slices; validate each with `npm test`, `ReadLints`, and an Electron smoke run.
