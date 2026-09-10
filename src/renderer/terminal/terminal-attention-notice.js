// --- The terminal says a session is asking something (#615) ---
//
// Switchboard already knows a session is waiting on the user: the sidebar counts it, the attention inbox
// names it, the tab dot ripples. The one surface the user is looking at while they TYPE said nothing —
// and a Claude permission dialog swallows letters and digits while `Enter` confirms the highlighted
// option, so someone who switches to a tab and types their next instruction blind approves a request they
// never read and loses their prompt (#614 holds that measurement).
//
// So this draws a small caption across the top of the terminal saying what is wanted. Three properties,
// and each of them is the whole point rather than a detail:
//
//   * **IT COSTS NO LAYOUT.** The caption is the container's own `::after` (style.css,
//     `.terminal-container.terminal-attention`). Not a border, not a padding, not a wrapper, not even an
//     extra child node. FitAddon fits a terminal from `getComputedStyle(container).height`
//     and from `container.querySelector('.xterm')` (see `terminal-manager.js`, `terminalVerticalPadding`),
//     and an absolutely positioned pseudo-element is in neither answer — so nothing here can move a row,
//     reflow the screen, or cost a refit. `test/terminal-attention-notice.test.js` holds that claim
//     against the stylesheet, because a later hand could "tidy" this into something with a box and no
//     terminal test would say a word.
//
//     It began as a coloured frame around the terminal with the caption anchored to it. The frame was
//     dropped after the owner looked at it running: the caption alone says the same thing and a
//     perimeter around a terminal reads as a state of the app rather than a question from the session.
//     Nothing about the layout claim changed with it — the frame cost no layout either, and that is why
//     it could go without touching anything but the stylesheet.
//   * **IT NEVER TOUCHES INPUT.** The pseudo-element is `pointer-events: none`, nothing here listens
//     for a key, and the one write path (`clearTerminalAttentionNotice`) is called AFTER the bytes have
//     gone to the pty. This is deliberately not the guard #614 rejected: a permission dialog is answered
//     with Enter, arrows, Esc and Tab, so anything that intercepted keys would take away the only way to
//     answer the question it is describing.
//   * **IT IS BACKEND-NEUTRAL.** `needs-attention` is formed the same way for every backend, and no id
//     is named here or in the stylesheet. Where a backend states a reason, the caption is that reason;
//     where it states none, the caption is the neutral sentence below — which is how the qualifier "only
//     where the reason is measured" is carried, rather than by a per-backend list the renderer must not
//     hold.
//
// WHEN IT GOES: on the first write into that session, not when the status leaves `needs-attention`.
// That is a decision with a cost, recorded because the cost is real — someone who arrives at the tab and
// types blind loses the signal on the very keystroke that needed it. What the caption does for them is be
// there at the moment they arrive and look, which is the moment this exists for; a NEW attention event
// brings it back. The keystroke reaches here through `sendSessionInput` (`shell/prompt-staging.js`), the
// seam every renderer writer of a session's stdin goes through — so a paste and the seed insert take the
// caption down as readily as a key does, and this file needs no input tap of its own.
//
// THE RULE IS THE SEAM, not who typed it, and the two app-driven writes are why that has to be said
// plainly. The seed insert on a fresh session (`app.js`) is typed by the APP and DOES take the caption
// down, because it goes through the seam; `deliverStagedPrompts` (`shell/prompt-staging.js`) is typed by
// the app too and does NOT, because it calls the preload directly and says so at the call. An earlier
// version of this comment explained the difference as "nobody read the screen", which is true of both and
// therefore explains neither.
//
// What makes the split harmless rather than arbitrary: the seed is the FIRST thing a session ever
// receives, before anything can have been asked of it, so there is never a caption there to take down.
// The staged delivery can land at any point, including on top of an open dialog — so its bypass, which is
// #614's decision and not this feature's, is also the one that keeps the caption standing over it. If
// that delivery ever moves onto the seam, this becomes a real question and not a bookkeeping note.
//
// WHY IT IS ITS OWN STATE, and not a read of `attentionSessions`: focusing a session settles the inbox
// (`clearNotifications` → `settleAttentionState` in app.js), so by the time the user is looking at the
// terminal the session is no longer flagged. A caption that read the flag would be gone exactly when it is
// needed. The REASON, though, is not derived here — the caller hands one over. In the main window that is
// the value `applyAttention` reduced and stored in `attentionReason`, so the caption and the inbox row
// cannot drift apart; in a window of its own it is the signal's own reason, because such a window keeps no
// `attentionReason` to reduce against (see the call in `recordAttentionSignal`).
//
// INHERITED, not introduced here: `reduceAttention` keeps a structured reason over a later OSC-9 one, so
// where two questions are open the caption can name the FIRST of them. That is the same value the inbox
// row shows, and reading the same one is the decision this feature was given; a caption that reduced
// differently would be a second answer to "what is this session asking", which is the defect the decision
// exists to prevent. Change it in `shared/attention-source.js` for both surfaces or not at all.
//
// A plain classic script with no parse-time side effects, so where its tag sits is free.
// Reaches at call time: `openSessions` — declared in `app.js` (it is app.js state that the terminal
// manager works on, not the manager's own) — and nothing else.
// What calls INTO it, and nothing else does (`test/terminal-attention-notice.test.js` is that list in
// executable form — check it there rather than trusting this one):
//   shell/attention-engine.js, applyAttention          noteTerminalAttention        the signal
//   shell/attention-engine.js, recordAttentionSignal   noteTerminalAttention        …in a window of its own
//   shell/prompt-staging.js, sendSessionInput          clearTerminalAttentionNotice the keystroke
//   terminal/terminal-manager.js, destroySession       clearTerminalAttentionNotice the teardown
//   shell/session-ipc.js, onProcessExited              clearTerminalAttentionNotice the pty is gone
//   shell/session-ipc.js, rekeySessionState            rekeyTerminalAttentionNotice a fork
//   app.js, dismissAttentionItem                       clearTerminalAttentionNotice the user said "gone"
// The test enforces that list in BOTH directions — every call is there, and the names appear nowhere
// else under `src/renderer/**` — so "and nothing else does" is checked rather than asserted.

// What the caption says when the signal carried no reason of its own. Worded so it is honest for a
// backend whose reason has never been measured: it states that something is wanted and that the screen is
// where it says what — never what the answer is, and never which CLI is asking.
const TERMINAL_ATTENTION_NEUTRAL = 'This session is asking you something. Read the screen before you type.';

// A reason is arbitrary text from whatever the CLI sent (an OSC 9 payload is a raw string). The caption is
// one line across the top of a terminal, so it is collapsed to a single line and cut; that something is
// wanted is carried either way, and the screen underneath carries the detail.
const TERMINAL_ATTENTION_CAPTION_MAX = 160;

// sessionId → the caption its terminal is currently showing. Renderer memory for the life of this window,
// like every other per-session belief here: a window only captions the terminals it draws.
const terminalAttentionNotices = new Map();

/** The one line the caption prints, from whatever reason the signal carried (or none). */
function terminalAttentionCaption(reason) {
  const text = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
  if (!text) return TERMINAL_ATTENTION_NEUTRAL;
  if (text.length <= TERMINAL_ATTENTION_CAPTION_MAX) return text;
  return text.slice(0, TERMINAL_ATTENTION_CAPTION_MAX - 1).trimEnd() + '…';
}

/**
 * The `.terminal-container` this window holds for a session, or null.
 *
 * `openSessions` is the right map and `sessionIdsInThisWindow()` is not: what is being asked is "is there
 * an element to paint", and a panes-mode tab with no mounted terminal (#394) is in the second answer and
 * has nothing to paint. A session this window does not hold simply keeps its state until it mounts one.
 */
function terminalAttentionElement(sessionId) {
  if (typeof openSessions === 'undefined' || !openSessions) return null;
  const entry = openSessions.get(sessionId);
  return (entry && entry.element) || null;
}

/**
 * Put the recorded state onto a container. Idempotent, and safe to call for a session with no notice —
 * that is what takes the caption off again.
 *
 * `el` is passed by the mount path, which knows its own container before the entry is in `openSessions`.
 */
function paintTerminalAttentionNotice(sessionId, el) {
  const container = el || terminalAttentionElement(sessionId);
  if (!container) return;
  const caption = terminalAttentionNotices.get(sessionId);
  if (caption == null) {
    container.classList.remove('terminal-attention');
    delete container.dataset.attentionCaption;
    return;
  }
  // The caption is a data attribute the stylesheet prints with `content: attr(...)`, so it is text by
  // construction — a reason is arbitrary text from a CLI and must never reach the DOM as markup.
  container.dataset.attentionCaption = caption;
  container.classList.add('terminal-attention');
}

/**
 * This session is asking the user something — say so on its terminal.
 *
 * Called with the reason the attention engine already reduced, never with one derived here.
 *
 * **ONLY A WINDOW THAT HOLDS THE TERMINAL REMEMBERS IT**, and that gate is the whole answer to a session
 * moving between windows. `src/app/hooks.js` sends every `attention-signal` to the main window whether or
 * not it is the window drawing that session, so without this main kept a caption for a question answered
 * in a detached window minutes earlier — the paint was a no-op there, but the STATE survived, and the
 * next time the session came home it was repainted for a question long gone. Main never sees the
 * keystroke that answered it, because the seam that clears this is per window by construction (the same
 * reason `stagedPromptWindowOwnsTerminal` exists in `shell/prompt-staging.js`).
 *
 * It settles both directions on its own: a window that RELEASES a session destroys its terminal
 * (`shell/detach-window.js` → `destroySession`), which clears here, and a window that TAKES one starts
 * with nothing and waits for the next signal. Clearing on the re-adopt instead would have fixed only the
 * homeward half and left the map growing meanwhile.
 *
 * `openSessions` is the right map rather than `sessionIdsInThisWindow()` for the reason spelled out at
 * `terminalAttentionElement`: what is being asked is "are the writes that clear this mine", not "is this
 * session mine". A session with a live CLI is always in that map in whichever window holds it, so
 * nothing that can raise attention is turned away.
 *
 * That gate also BOUNDS the map: an entry can only exist while this window has a mounted terminal for it,
 * and every teardown path clears. So it is bounded by the terminals on screen, not by everything this
 * window has ever heard about.
 */
function noteTerminalAttention(sessionId, reason) {
  if (!sessionId) return;
  const container = terminalAttentionElement(sessionId);
  if (!container) return;
  terminalAttentionNotices.set(sessionId, terminalAttentionCaption(reason));
  paintTerminalAttentionNotice(sessionId, container);
}

/**
 * Take the caption down: the user wrote into this session, or its terminal is being torn down.
 *
 * It can never break input — the caller writes first and clears after, and a session with no notice is a
 * cheap Map miss, which matters because this sits on the keystroke path.
 */
function clearTerminalAttentionNotice(sessionId) {
  if (!sessionId) return;
  if (!terminalAttentionNotices.delete(sessionId)) return;
  paintTerminalAttentionNotice(sessionId);
}

/** What this window believes a session's terminal is saying, or null. Read by the tests and the paint. */
function terminalAttentionNoticeFor(sessionId) {
  const caption = terminalAttentionNotices.get(sessionId);
  return caption == null ? null : caption;
}

/**
 * A fork moved the session onto a new id; the notice moves with every other per-session belief.
 *
 * Without this the caption is stranded: the container is re-keyed under the new id, so no keystroke can
 * ever name the old one again and it would sit on that terminal for the life of the window.
 */
function rekeyTerminalAttentionNotice(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const caption = terminalAttentionNotices.get(oldId);
  terminalAttentionNotices.delete(oldId);
  if (caption != null) terminalAttentionNotices.set(newId, caption);
  paintTerminalAttentionNotice(newId);
}
