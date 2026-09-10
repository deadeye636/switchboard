// --- Staged prompts: the structure and the two rules over it (#614) ---
//
// A user can hand Switchboard a prompt for a session that cannot take it yet — one whose agent is
// working, or one sitting on a permission dialog — and the app types it in once the session can. This
// file is the whole of the DECIDING half: a plain serializable state and pure functions over it. No
// timers, no DOM, no `window.api`. The caller (shell/prompt-staging.js) answers the questions about the
// live app and passes the answers in.
//
// **Staging is explicit and it is not keystroke buffering.** Measured on a real permission dialog, the
// keys that answer one are Enter, the arrows, Esc and Tab — so a buffer that caught what the user types
// would take away the only way out of the dialog it was meant to help with. The prompt comes from a
// surface of its own instead; nothing here ever sees terminal input except as the dirty-line signal
// below, which observes and never intercepts.
//
// **State lives in renderer memory only.** Nothing is written to the database or the settings blob, so a
// restart drops every staged item. Persistence across restarts, reordering and editing are #275.
//
// Shape: `{ [sessionId]: [{ id, text, at }] }` — JSON all the way down, so #275 can persist it as it
// stands. A session with nothing staged holds no key at all rather than an empty array, which is what
// lets the delivery loop skip the whole thing with one `Object.keys` test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // The two statuses a staged prompt may be typed into, from `session/session-status.js`'s vocabulary.
  //
  // `running` is a session that holds a live PTY and is not busy — which is exactly what a session that
  // has just finished a turn reports, and it is the ordinary case this feature exists for. The other four
  // all block, and `idle` blocks for the OPPOSITE reason to the rest: it is the fall-through for a session
  // that is neither open nor pending, so there is no live process to deliver into at all. (#275's original
  // wording said "idle or response-ready" and would therefore have fired for nothing that could listen.)
  const PROMPT_QUEUE_DELIVERABLE_STATUSES = ['running', 'response-ready'];

  function createPromptQueue() {
    return {};
  }

  // Callers hold either a status object from `getSessionStatus` or a bare key; take both, so nothing
  // downstream has to remember which.
  function promptQueueStatusKey(status) {
    if (!status) return '';
    if (typeof status === 'string') return status;
    return typeof status.key === 'string' ? status.key : '';
  }

  function promptQueueDeliverableStatus(status) {
    return PROMPT_QUEUE_DELIVERABLE_STATUSES.indexOf(promptQueueStatusKey(status)) !== -1;
  }

  /** What is staged for this session, oldest first. Always a fresh array — never the stored one. */
  function promptQueueFor(state, sessionId) {
    const items = state && sessionId ? state[sessionId] : null;
    return Array.isArray(items) ? items.slice() : [];
  }

  function promptQueueCount(state, sessionId) {
    return promptQueueFor(state, sessionId).length;
  }

  // Derived from the state rather than from a counter this module keeps, so the function stays pure and a
  // test can predict the id it is about to get.
  function nextPromptId(state, sessionId) {
    let max = 0;
    for (const item of promptQueueFor(state, sessionId)) {
      const m = /#(\d+)$/.exec(String((item && item.id) || ''));
      if (m) max = Math.max(max, Number(m[1]));
    }
    return sessionId + '#' + (max + 1);
  }

  /**
   * Stage `text` for `sessionId`, at the back of that session's queue.
   *
   * Blank text stages nothing: an empty prompt submitted into an agent is a bare Enter, which answers
   * whatever the CLI happens to be asking. The state is returned unchanged in that case, so a caller can
   * compare identities to see whether anything happened.
   */
  function enqueuePrompt(state, sessionId, text, options) {
    const opts = options || {};
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!sessionId || !clean) return state || createPromptQueue();
    const base = state || createPromptQueue();
    const items = promptQueueFor(base, sessionId);
    items.push({
      id: opts.id || nextPromptId(base, sessionId),
      text: clean,
      at: Number.isFinite(opts.at) ? opts.at : 0,
    });
    const next = Object.assign({}, base);
    next[sessionId] = items;
    return next;
  }

  /** Drop one item. A session left with nothing loses its key entirely (see the shape note above). */
  function removeQueuedPrompt(state, sessionId, id) {
    const base = state || createPromptQueue();
    if (!Object.prototype.hasOwnProperty.call(base, sessionId)) return base;
    const items = promptQueueFor(base, sessionId).filter(item => item.id !== id);
    const next = Object.assign({}, base);
    if (items.length === 0) delete next[sessionId];
    else next[sessionId] = items;
    return next;
  }

  /** Drop everything staged for one session — the discard button, and the session's own exit. */
  function clearQueuedPrompts(state, sessionId) {
    const base = state || createPromptQueue();
    if (!Object.prototype.hasOwnProperty.call(base, sessionId)) return base;
    const next = Object.assign({}, base);
    delete next[sessionId];
    return next;
  }

  /** Move a session's queue onto a new id — a fork re-keys every other per-session map the same way. */
  function rekeyQueuedPrompts(state, oldId, newId) {
    const base = state || createPromptQueue();
    if (!oldId || !newId || oldId === newId) return base;
    if (!Object.prototype.hasOwnProperty.call(base, oldId)) return base;
    const next = Object.assign({}, base);
    next[newId] = promptQueueFor(base, oldId).concat(promptQueueFor(base, newId));
    delete next[oldId];
    return next;
  }

  /**
   * The item to deliver right now, or null.
   *
   * `gate` is what the caller measured about the live session: `{ status, dirty }`. Both halves have to
   * hold, and each blocks for its own reason:
   *
   *   status — only `running` and `response-ready` can hear anything (see the constant above).
   *   dirty  — the user has unsent input sitting in the session's own prompt line, so typing into it
   *            would merge our sentence with theirs.
   *
   * One item, the oldest: the next one waits for the session to be deliverable again.
   */
  function nextDeliverable(state, sessionId, gate) {
    const items = promptQueueFor(state, sessionId);
    if (items.length === 0) return null;
    const g = gate || {};
    if (!promptQueueDeliverableStatus(g.status)) return null;
    if (g.dirty) return null;
    return items[0];
  }

  // --- The dirty prompt line ---
  //
  // Switchboard cannot read a CLI's input buffer: the line the user is halfway through typing exists only
  // inside the CLI. So the line is TRACKED from the bytes that were sent to it, and this is where the
  // rule for what each byte means lives — beside its tests rather than beside the terminal.
  //
  // **ONLY A SUBMIT CLEARS THE LINE. Nothing else does — not Esc, not Ctrl-C, not Ctrl-U.**
  //
  // This rule used to say that Esc and Ctrl-C "abandon what was typed" and Ctrl-U "kills the line", and
  // that is a claim about one CLI's input widget rather than about terminals. **Claude Code 2.1.267
  // disproves it for Esc**, measured in a live session: a prompt was staged, `half typed by hand` was left
  // in the composer, Esc was pressed, the gate released — and the delivery merged into what was still
  // there. The turn the CLI actually answered was
  //
  //     half typed by handow summarise what you counted in one sentence.
  //
  // and it remarked that the message looked like it got cut off mid-typing. So Esc did not empty that
  // composer; it did something else (dismissed a hint, changed a mode), and the line survived it.
  //
  // We cannot make the claim for the other CLIs either — nobody has measured Codex, Hermes, Pi or agy —
  // and asking each backend would put a CLI's input grammar in the renderer, which CLAUDE.md reflex 5
  // forbids. A carriage return is different in kind: 0x0D is Enter for a program reading a line, and a
  // CLI that has taken the line has by definition left the composer empty. That is a property of the
  // terminal, not of one widget, so it is the one thing this rule may assert.
  //
  // **The direction is deliberate and asymmetric.** A hold that lasts too long is visible (the row's chip
  // says the prompt is held) and one keystroke ends it. A merge is neither: it is silent, it spends the
  // user's tokens on a sentence they did not write, and there is no undo for a turn a CLI has answered.
  //
  // (0x0A only moves the cursor down, but a CLI reading a line takes either, so both count as a submit.)
  //
  // **A submit is the END of a chunk, not a chunk of its own**, and reading it as an exact match was
  // wrong the moment the signal moved to `window.api.sendInput` (`shell/prompt-staging.js`). A keystroke
  // arrives alone, but a WRITER arrives whole: the seed insert sends `\x1b[200~<text>\x1b[201~\r` in one
  // call, and the context menu's paste-and-submit sends the text and then the return. Classifying the
  // first as "type" would have left the line dirty forever over text that was submitted before anyone
  // could look at it — a staged prompt held for the life of the session, silently.
  //
  // The one shape that ends in a return and does NOT submit is the newline chord: Shift+Enter sends the
  // backend's declared sequence, and Codex's is `\x1b\r` (the others send the kitty protocol's
  // `\x1b[13;2u`, which ends in `u` and needs no exception). So the test is the byte BEFORE the return:
  // an ESC there makes it an escape sequence, and a composer that inserts a newline has left the line
  // fuller than it found it. This is a SHAPE, not a table of backend strings — the descriptor's
  // declaration stays in the backend where it belongs, and a new CLI whose chord is `\x1b\n` is covered
  // on the day it is written.
  //
  // An arrow key is on the "leaves something" side for the same reason everything else is. It moves
  // within a line the user is already editing, or it pulls history INTO the line, and neither is a
  // moment to type over. The cost of being wrong here is a delayed delivery, which the next submit
  // clears; the cost of being wrong the other way is two prompts merged into one.
  //
  // **And the channel this rule reads carries more than the user's keys.** The terminal answers the CLI
  // by itself on that same path, and every one of those answers used to read as "the user typed
  // something" and blocked delivery for good:
  //
  //   \x1b[?…c  \x1b[>…c   device attributes, primary and secondary — the CLI asks what it is talking to
  //   \x1b[…n   \x1b[…R    device status and cursor position — the CLI asks where the cursor is
  //   \x1b[<…M  \x1b[<…m   SGR mouse reports; the default mouse mode keeps tracking on, so ONE WHEEL
  //                        NOTCH over a terminal sent one of these and held a staged prompt forever
  //   \x1b[M…              the older X10 mouse encoding, three bytes of coordinates
  //   \x1b[I    \x1b[O     focus in/out. `terminal-manager.js` already drops these before they reach the
  //                        pty at all; the family belongs here, which is the point — that filter is this
  //                        same idea and it stopped at the one member of the family it had seen.
  //
  // None of these is a keystroke and none of them touches the line, so they are 'none': the line is left
  // exactly as it was. Matched as a whole string with `+` because a terminal can answer twice in one
  // chunk; anything with a single real byte mixed in falls through to the ordinary rules, which is the
  // safe direction.
  //
  // **The arrow keys stay dirty even so**, and that is a deliberate trade rather than an oversight: on the
  // alternate screen the wheel is translated into arrow keys, so scrolling a full-screen TUI still marks
  // the line and can still delay a delivery. Widening the rule to cover it would mean guessing that a
  // given `\x1b[A` was a wheel notch and not a history recall, which is the one mistake that merges two
  // prompts into one. A delay is the acceptable failure — and it is only acceptable because it is
  // VISIBLE: the row's chip says the prompt is being held (`shell/prompt-staging.js`).
  //
  // One shape in here is genuinely ambiguous and it is xterm's own ambiguity, not this rule's: a cursor
  // position report is `\x1b[<row>;<col>R`, and a modified F3 is `\x1b[1;2R` — the same bytes. It is read
  // as the report, because that is what arrives thousands of times more often, and the cost of being
  // wrong is a function key that does not mark the line. Function keys do not put text in a line anyway,
  // so that direction is harmless; reading every cursor report as typing was not.
  const TERMINAL_REPLY_ONLY_RE =
    /^(?:\x1b\[(?:\?[0-9;]*c|>[0-9;]*c|[0-9;]*[nR]|[IO]|<[0-9;]*[Mm]|M[\s\S]{3}))+$/;

  // A chunk that ENDS the line by submitting it: the last byte is a return, and it is not the second half
  // of an escape sequence (the newline chord — see above).
  function endsWithSubmit(data) {
    const last = data.charAt(data.length - 1);
    if (last !== '\r' && last !== '\n') return false;
    return data.charAt(data.length - 2) !== '\x1b';
  }

  /**
   * What did this chunk do to the prompt line? Three answers, and there are deliberately only three:
   *
   *   'none'    the terminal answering the CLI by itself, or nothing at all — the line is untouched.
   *   'submit'  the chunk ends in a return, so the CLI has taken the line and the composer is empty.
   *   'type'    anything else. It may have added to the line, and we cannot know that it did not.
   *
   * There is no 'cancel' and no 'kill'. Those existed, they cleared the line, and a live session showed
   * that Esc does not empty Claude's composer — see the note above. A key that MIGHT have left the line
   * as it was is indistinguishable here from one that added to it, and only one of those two readings
   * can merge a staged prompt into a user's sentence.
   */
  function promptLineEffectOf(data) {
    if (typeof data !== 'string' || data === '') return 'none';
    if (TERMINAL_REPLY_ONLY_RE.test(data)) return 'none';
    if (endsWithSubmit(data)) return 'submit';
    return 'type';
  }

  /** Is the line dirty after `data` was sent to it, given that it was `dirty` before? */
  function promptLineDirtyAfter(dirty, data) {
    const effect = promptLineEffectOf(data);
    if (effect === 'none') return !!dirty;
    return effect === 'type';
  }

  return {
    PROMPT_QUEUE_DELIVERABLE_STATUSES,
    createPromptQueue,
    promptQueueStatusKey,
    promptQueueDeliverableStatus,
    promptQueueFor,
    promptQueueCount,
    enqueuePrompt,
    removeQueuedPrompt,
    clearQueuedPrompts,
    rekeyQueuedPrompts,
    nextDeliverable,
    promptLineEffectOf,
    promptLineDirtyAfter,
  };
});
