# Spec 04 — One-click handoff

> Read `docs/specs/README.md` first.

**Status:** Ready to build · **Roadmap:** Opportunity #4 (Phase 3) · **Independent:** Yes

## Problem & goal

Session health already detects **"Handoff Recommended"** for long/expensive sessions and can generate a handoff packet, but the human still has to manually: click the health chip, copy the prompt, paste it, wait, then fork a fresh session and paste the result. That friction means people don't hand off and sessions drag on (slow + expensive).

**Goal:** Turn "Handoff Recommended" into a single guided action: request the handoff packet from the current session → fork a fresh session pre-seeded with it → switch to the new session. Each step is inspectable and cancelable; nothing spends tokens silently.

## Current state (grounded)

- Health model + templates: `getSessionHealth`, `buildHandoffTemplate(session)`, `buildHandoffRequestPrompt(session)` in `public/session-health.js` (handoff state thresholds at ~108–122).
- Current handoff UI: `showHandoffPrompt(session)` in `public/dialogs.js:32` — a control dialog with two paths: (a) "secondary" sends `buildHandoffRequestPrompt` to the running session (`window.api.sendInput`) and toasts; (b) confirm copies `buildHandoffTemplate` to the clipboard. Triggered from the grid health chip (`grid-view.js:106`) and sidebar (`sidebar.js:1021`).
- Fork mechanism: `forkSession(session, project)` in `public/dialogs.js:26` sets `options.forkFrom = session.sessionId` and opens a new terminal; `open-terminal` IPC accepts `sessionOptions` (`main.js:1037`, `preload.js:21`). Fork is recorded in the timeline (`app.js:315`, `864`).
- `sendInput(id, data)` writes to a session's PTY (`preload.js:43`).

## Scope

**In:** a guided "Hand off" flow that chains request → fork → seed → switch, building on existing helpers; clear inspectable steps; cancel at any point.
**Out:** changing health thresholds; auto-handoff without user action (explicitly disallowed by guardrails).

## Design

### Flow (orchestrated in `public/dialogs.js`, new `runHandoff(session, project)`)
1. **Confirm** via `showControlDialog`: explain it will ask the current agent to summarize, then start a fresh session with that summary. Tone `default`. Buttons: **Hand off** / Cancel. Show health reasons (`getSessionHealth(session).reasons`) as detail rows.
2. **Request packet:** send `buildHandoffRequestPrompt(session)` to the current session via `window.api.sendInput`. The prompt already instructs the agent to return *only* a markdown handoff and not continue work.
3. **Capture the packet:** the agent's reply lands in the terminal. Two viable capture strategies — pick the simpler robust one:
   - **(Recommended) Manual confirm:** after sending, show a follow-up dialog with a textarea prefilled by attempting to read the latest assistant message from the session JSONL (`window.api.readSessionJsonl(sessionId)` → last assistant text). User reviews/edits, clicks **Start fresh session**. This keeps the human in the loop and avoids brittle terminal scraping.
   - (Alt, future) auto-detect completion via busy→idle transition then parse JSONL.
4. **Fork + seed:** call the fork path (`forkSession`-style: `open-terminal` with `sessionOptions.forkFrom = session.sessionId` OR a clean new session in the same project — see note) and, once open, `sendInput(newId, packet + "\n")` to seed the new session with the handoff as its first message.
5. **Switch:** focus the new session; toast "Handed off → new session".

> **Fork vs fresh note:** the *point* of handoff is to escape a bloated context. Forking (`--resume`/`forkFrom`) may inherit the old context. Confirm whether `forkFrom` resumes history; if it does, prefer starting a **new** session in the same project (`open-terminal(tempId, projectPath, /*isNew*/ true)`) seeded with the packet, so the new session starts lean. Decide this during implementation by checking `main.js` `open-terminal` handling of `forkFrom` vs `isNew`.

### Entry points
- Replace/augment the existing health-chip action so "Handoff Recommended" offers **Hand off (guided)** in addition to the current copy/send options. Keep the old copy-to-clipboard as a secondary path.

## Files to touch
- **Modified:** `public/dialogs.js` (`runHandoff` orchestration; reuse `showControlDialog`, `forkSession`), `public/grid-view.js` (health chip → offer guided handoff) and/or `public/sidebar.js:1021`, `public/app.js` (only if a new helper is needed to focus/seed a freshly-opened session; the fork-open + first-input seeding may need a hook after `session-detected`/`session-forked`).
- **New (optional):** `public/handoff-flow.js` (UMD) if you want the step/state machine pure-tested (recommended): `nextHandoffStep(state)` returning the next action; keep `sendInput`/dialogs in `dialogs.js`.
- **Tests:** `test/handoff-flow.test.js` if the pure module is added; otherwise extend coverage of `buildHandoffRequestPrompt`/`buildHandoffTemplate` for the seeding text.

## Tests
- If `handoff-flow.js` added: state machine transitions confirm → requested → captured → forked → switched, with cancel from any state.
- `buildHandoffRequestPrompt`/`buildHandoffTemplate` produce seed text containing goal/project/session id (already partially covered — extend).

## Acceptance criteria
- From a "Handoff Recommended" session, one action walks through: ask agent → review packet → start fresh session seeded with it → focus new session.
- Every token-spending step (sending the request, seeding the new session) is behind explicit user confirmation.
- Cancel at any step leaves both sessions untouched.
- New session starts lean (verify it doesn't drag the old context if "fresh" path chosen).
- `npm test`, `ReadLints`, Electron smoke run pass.

## Risks / notes
- Capturing the agent's reply from the terminal is the fragile part — the recommended JSONL-read + manual-confirm avoids ANSI scraping.
- Be explicit in UI copy about token cost.
