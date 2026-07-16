# Spec 02 — Next-attention hotkey + alert sound

> Read `docs/specs/README.md` first.

**Status:** Implemented · **Roadmap:** Opportunity #2 (Phase 1) · **Independent:** Mostly — shares `src/renderer/panels/settings-panel.js` and the `global.notifications` settings blob with Spec 01. If 01 isn't merged yet, create the settings section; otherwise extend it.

> **As built:** the hotkey lives outside the central `shortcuts.js` registry — a dedicated `nextAttentionBinding` in `src/renderer/app.js` reads the override from `global.shortcuts.nextAttention`, with the key predicate in `src/renderer/shell/alert-sound.js`. The alert sound uses the WebAudio oscillator variant (no bundled audio file).

## Problem & goal

Power users juggling many agents need to move between them without the mouse, and need an audible cue when an agent needs them. Today there's an in-app **"Focus next"** button in the attention inbox but **no keyboard shortcut** and **no sound**.

**Goal:** A configurable global-ish hotkey that focuses the next session needing attention, plus an optional alert sound when a session enters "Needs You".

## Current state (grounded)

- `getNextAttentionInboxItem(sessions, runtime, currentSessionId)` exists and is tested (`public/session-status.js:91`); already wired to the inbox "Focus next" button (`public/sidebar.js:725`, handler ~729).
- The renderer keydown handler is in `src/renderer/app.js` ~line 1229 and currently handles only grid toggle (`Cmd/Ctrl+Shift+G`) + delegates to `handleSessionNavKey` (`public/grid-view.js:411`). xterm key handling: `isSessionNavKey` (`grid-view.js:403`) is used to let global shortcuts through the terminal — mirror that pattern so the hotkey works while a terminal is focused.
- No audio anywhere in the app.

## Scope

**In:** in-app keyboard shortcut to focus next attention session; optional alert sound on attention; settings toggles; respect quiet/reduced-motion preferences for sound.
**Out:** OS-global (system-wide) hotkey via Electron `globalShortcut` — keep it in-app only to avoid clobbering other apps (note as a possible future).

## Design

### Hotkey (`src/renderer/app.js`, keydown handler ~1229)
- Add a default binding: **`Cmd/Ctrl+Shift+A`** ("Attention"). Make it data-driven so it's easy to change; read an override from `global.shortcuts?.nextAttention` if present.
- On trigger: compute `getNextAttentionInboxItem(getAllKnownSessionsForStatus(), runtime, activeSessionId)`; if found, open/focus that session (reuse the inbox button's existing focus logic — extract it into a shared `focusAttentionItem(item)` helper so both the button and hotkey call it). Wrap-around is already handled by the helper.
- Make it work while a terminal is focused: add the combo to `isSessionNavKey`-style passthrough so xterm doesn't swallow it (`grid-view.js` `isSessionNavKey`, and the `before-input-event` logic in `src/main.js` ~206 if needed).
- If Spec 01 is merged, also implement `window.api.onFocusNextAttention(() => focusNextAttention())` so the tray menu item works.

### Alert sound
- Pure helper `src/renderer/shell/alert-sound.js` (UMD, tested for the *decision*, not playback): `shouldPlayAttentionSound({ prev, next, settings })` → boolean (a session newly entered attention AND `settings.sound` on). Keep DOM/audio out of the tested function.
- Playback in `app.js`: a small `playAttentionSound()` using `new Audio()` or a WebAudio beep. Bundle a short asset (e.g. `public/sounds/attention.mp3`) or synthesize a tone to avoid a binary asset. Respect `window.matchMedia('(prefers-reduced-motion: reduce)')` is **not** the right gate for sound — instead gate purely on the explicit sound setting.
- Funnel through the same transition point Spec 01 uses (`refreshSessionStatusViews`/transition region) — if 01 isn't merged, add a minimal transition snapshot locally and reconcile when 01 lands.

### Settings (`src/renderer/panels/settings-panel.js`)
Add to the Notifications section (shared with Spec 01): **Alert sound on attention** (default off). Optionally surface the next-attention shortcut as read-only help text. Persist under `global.notifications.sound` and `global.shortcuts.nextAttention`.

## Files to touch
- **New:** `src/renderer/shell/alert-sound.js`, `test/alert-sound.test.js`, optionally `public/sounds/attention.mp3`.
- **Modified:** `src/renderer/app.js` (keydown ~1229, extract `focusAttentionItem`, sound playback), `src/renderer/shell/sidebar.js` (use the extracted `focusAttentionItem` from the inbox button so logic isn't duplicated), `src/renderer/views/grid-view.js` (`isSessionNavKey` passthrough), `src/renderer/panels/settings-panel.js` (toggle), `src/renderer/index.html` (script tag).

## Tests
- `getNextAttentionInboxItem` is already covered; add a test that the keydown→action mapping picks the right combo (extract the key-matching into a tiny pure predicate, e.g. `isNextAttentionKey(e)`).
- `shouldPlayAttentionSound`: plays only on new attention + sound enabled; not on ready; not when already in set; not when disabled.

## Acceptance criteria
- Pressing the hotkey (even with a terminal focused) focuses the next session needing attention, wrapping around.
- With sound enabled, a new "Needs You" plays the cue once (coalesced, not per-session-spam).
- Toggles persist; default sound is off.
- `npm test`, `ReadLints`, Electron smoke run pass.

## Risks / notes
- Coordinate the Notifications settings section with Spec 01 to avoid a merge conflict — whoever lands second extends rather than recreates.
- Avoid system-global shortcuts; in-app only.
