// --- Staging a prompt, and typing it in when the session can take it (#614) ---
//
// The wiring half of `shell/prompt-queue.js`. That file decides; this one measures the live app, keeps
// the state, draws the count and delivers. Split for the reason the issue asks for: the rules are worth
// unit tests of their own (`test/prompt-queue.test.js`).
//
// **This half is tested too, and it had to be** — `test/prompt-delivery.test.js` builds the renderer's
// shared scope in a `vm` and drives `deliverStagedPrompts` against a stubbed `sendInput`. Before it
// existed, turning the gate's dirty check into a constant `false` left the entire suite green: the gate
// is assembled HERE out of live answers, so the pure module's tests cannot see it and the wiring guard
// only reads this file as text.
//
// A classic <script> with two parse-time constraints, both load-order: `createPromptQueue()` runs on the
// first line below, so `shell/prompt-queue.js` has to be loaded already, and the command-palette
// registration at the tail needs `shell/command-actions.js`. Everything else runs on call — including
// `sendSessionInput`, which every writer of a session's stdin calls and which therefore has to be in the
// scope of every page that has one. It is: all of them live in `index.html`, which loads this file.
//
// Reaches at parse time: registerCommandAction (shell/command-actions.js).
// Reaches at call time: the pure module's exports (window globals via its UMD wrapper); getSessionStatus
// (session/session-status.js); getSessionRuntimeState (shell/sidebar.js); focusedActionSession,
// sessionMap, openSessions, refreshSidebar, cleanDisplayName (app.js); showControlDialog,
// showControlToast (dialogs/control-dialogs.js); clearTerminalAttentionNotice
// (terminal/terminal-attention-notice.js — the seam is also how the attention caption learns it was typed
// into, #615).
//
// What calls INTO this file, and nothing else does — `test/prompt-staging-wiring.test.js` is the list in
// executable form, so check it there rather than trusting this one:
//   app.js, refreshSessionStatusViews          deliverStagedPrompts        the delivery trigger
//   terminal/terminal-manager.js, teardown     clearPromptLineState        the belief dies with the term
//   shell/session-ipc.js, onProcessExited      discardStagedPromptsOnExit  the exit discard
//   shell/session-ipc.js, rekeySessionState    rekeyStagedPrompts          a fork moves the queue
//   shell/sidebar-session-row.js               stagedPromptCountFor        the chip's count
//   shell/sidebar-session-row.js               stagedPromptHeldByLine      the chip's waiting state
//   shell/sidebar-session-row.js               reviewStagedPrompts         the chip's click
// …and `sendSessionInput` below, which is the opposite shape: not a hook this feature asks for, but the
// renderer's one way into a session's stdin, which EVERY writer calls and which happens to live here
// because the prompt-line state it records does.

// Renderer memory only, for the life of this window — see the pure module's header. A window of its own
// (#390) therefore keeps its own staged items, which is right: it is the window the user staged them in.
let stagedPrompts = createPromptQueue();

// Sessions whose prompt line has something unsent in it.
const stagedPromptDirtyLines = new Set();

/**
 * --- THE ONE WAY into a session's stdin from the renderer ---
 *
 * Every renderer writer of a session's input calls this, and `test/prompt-staging-wiring.test.js` refuses
 * a `window.api.sendInput(` anywhere else under `src/renderer/**`. It forwards to the preload and records
 * what the write did to that session's prompt line.
 *
 * **Why a helper and not a wrapper on `window.api.sendInput`.** That was tried and it is impossible, not
 * merely inelegant: `src/preload.js` publishes the API with `contextBridge.exposeInMainWorld`, and every
 * window runs `contextIsolation: true` (`src/app/windows.js`, `src/app/detach.js`). A contextBridge object
 * is immutable from the renderer, so `window.api.sendInput = wrapped` **silently does nothing** — no
 * throw, no warning. Measured in a live window: the property still read `function () { [native code] }`,
 * the dirty set stayed empty while typing, and the staged prompt merged into the line again. A vm test
 * harness cannot show this, because there `window.api` is an ordinary object and the assignment works.
 *
 * **Why the signal cannot live at `terminal.onData` either** — the defect before that one. `onData` is one
 * writer out of several: the context menu's paste and paste-and-submit
 * (`terminal/terminal-context-menu.js`), the seed insert on a fresh session (`app.js`), the newline chord
 * and the space key (`terminal/terminal-manager.js`). Two of those leave text in the line WITHOUT
 * submitting it, which is precisely the state this rule exists to detect, and a prompt staged while the
 * agent was busy was submitted on top of one of them: the transcript ran the two sentences together and
 * the CLI itself said the message looked like it got sent mid-typing.
 *
 * So the seam is a function every writer passes through by convention, held to it by a guard. That is
 * weaker than a wrapper — a new writer CAN reach past it — which is exactly why the guard is not optional.
 *
 * Two properties, and each is a bug without it:
 *   * it forwards FIRST and classifies after. Nothing here delivers today, but the ordering is not
 *     bookkeeping: a classification that ever regains the power to send must not overtake the write it
 *     was triggered by, and getting that back to front reorders what the user sent;
 *   * it can never break input. A throw on the keystroke path would stop the user typing, which is far
 *     worse than a staged prompt sitting still, so the signal is caught and dropped.
 *
 * The delivery below does NOT come through here — it calls the preload directly, and says so at the call.
 */
function sendSessionInput(sessionId, data) {
  window.api.sendInput(sessionId, data);
  try {
    markPromptLineFromInput(sessionId, data);
  } catch { /* the line signal is never worth breaking the user's typing over */ }
  try {
    // …and the terminal's attention caption comes down on the first write into the session (#615). It hangs
    // off this seam rather than off a listener of its own for the reason the seam exists: a paste and the
    // seed insert put text into the line without a keydown, and a caption that only watched the keyboard
    // would sit there over a session the user has already started answering. Its own try, so a throw in
    // either signal cannot cost the other one — and after the write, like the line signal, because
    // nothing observing the user's typing may ever reorder or block it.
    clearTerminalAttentionNotice(sessionId);
  } catch { /* an overlay is never worth breaking the user's typing over */ }
}

const REDELIVERY_GAP_MS = 5000;

// The unhurried re-check, for a queue that is staged and cannot move. The ordinary delivery rides a
// status edge — `refreshSessionStatusViews` runs on every busy, ready, attention and pty-set change, so a
// session going ready is answered within a frame — and this timer is for the two states that produce NO
// such edge at all:
//
//   * the user left something in the prompt line and never submitted it, or submitted something that
//     started no turn (a bare Enter into a CLI that ignores it, a `/help` answered from memory). Since
//     only a submit clears the line, this is the ONLY way a hold ever ends without a status edge, so
//     the fallback carries more weight than it did when Esc was believed to release one;
//   * the terminal is not in THIS window, so the gate below refuses and nothing in this window will
//     change its answer — the delivery has to wait for the window that owns it, or for it to come back.
//
// Fifteen seconds because nothing here is time-critical and this is the fallback, not the mechanism: it
// is slow enough that a stuck queue costs one wakeup every quarter minute, and quick enough that a user
// who submitted their line and looked away does not sit staring at a chip. It exists only while something
// is staged — `syncStagedPromptRecheck` arms it and takes it away again with the last item.
const STAGED_PROMPT_RECHECK_MS = 15000;

const stagedPromptLastDelivery = new Map();
let stagedPromptRetryTimer = null;
let stagedPromptRetryDelay = 0;
let deliveringStagedPrompts = false;

/** The session record behind an id, from either map that holds one. */
function stagedPromptSession(sessionId) {
  if (typeof sessionMap !== 'undefined') {
    const session = sessionMap.get(sessionId);
    if (session) return session;
  }
  if (typeof openSessions !== 'undefined') {
    const entry = openSessions.get(sessionId);
    if (entry && entry.session) return entry.session;
  }
  return null;
}

// THE one answer to "what is this session doing" — `getSessionStatus`, the same helper the sidebar dot,
// the tab dot and the grid card read. Deliberately not re-derived from `activePtyIds` / `sessionBusyState`
// here: a second derivation of a status is how two surfaces start disagreeing (#254).
function stagedPromptStatusKey(session) {
  if (!session || typeof getSessionStatus !== 'function') return '';
  const runtime = (typeof getSessionRuntimeState === 'function') ? getSessionRuntimeState() : {};
  return promptQueueStatusKey(getSessionStatus(session, runtime));
}

/**
 * Does THIS window hold the session's terminal?
 *
 * The dirty-line signal is per WINDOW, because the seam it comes from is: `sendSessionInput` records into
 * this window's own set, so a window only learns about writes made through ITSELF — and the writes into a
 * session's line are made by the window showing that session's terminal. `sessionMap` and the status model, by contrast, are
 * the same in every window. So a window that detached the session away, or closed its tab on a session
 * whose pty lives on, reads `running` with a clean line for a session somebody is typing into somewhere
 * else, and would submit on top of it.
 *
 * `openSessions` is the right map here rather than `sessionIdsInThisWindow()`, and the difference is the
 * whole point: that helper deliberately includes a panes-mode tab with NO mounted terminal (#394), which
 * is exactly the case with no dirty tracking behind it. What is being asked is not "is this session mine"
 * but "am I the window those writes would have gone through".
 *
 * Staging for a session that is not open here stays out of scope (#275) — the items simply wait.
 */
function stagedPromptWindowOwnsTerminal(sessionId) {
  if (typeof openSessions === 'undefined' || !openSessions) return false;
  return openSessions.has(sessionId);
}

/** How many prompts are staged for this session — what the sidebar row's chip prints. */
function stagedPromptCountFor(sessionId) {
  return promptQueueCount(stagedPrompts, sessionId);
}

/**
 * Is something staged for this session being HELD by the user's own prompt line?
 *
 * The chip says so, because a delivery that is blocked and silent is the failure this feature would
 * otherwise ship: an arrow key over a full-screen TUI dirties the line (see the trade in
 * `prompt-queue.js`), and without a visible waiting state the user is left watching a count that never
 * goes down with nothing on screen saying why or what clears it.
 *
 * Only the line is reported, not the status. "Working" and "waiting for you" are already drawn on the row
 * by the status dot, and a chip repeating them would say nothing the row does not; the dirty line is the
 * one blocker no other surface shows.
 */
function stagedPromptHeldByLine(sessionId) {
  return stagedPromptCountFor(sessionId) > 0 && stagedPromptDirtyLines.has(sessionId);
}

/** What is staged for this session, for the discard dialog. */
function stagedPromptsFor(sessionId) {
  return promptQueueFor(stagedPrompts, sessionId);
}

// A count changed, so the row that prints it has to be rebuilt. The full render rather than a patch:
// staging, discarding and delivering are user-paced events, not the per-frame edges `patchSidebarStatuses`
// exists for.
function refreshStagedPromptViews() {
  if (typeof refreshSidebar === 'function') refreshSidebar();
}

/**
 * Can a prompt be staged for this session at all?
 *
 * Two exclusions, both for the same reason the plan action has them. A plain terminal is a shell, and a
 * sentence submitted into one is a command it will try to run. And a session that is `idle` or `exited`
 * has no live process, so nothing staged for it could ever be delivered — staging for a session that is
 * not open is #275.
 *
 * **Deliberately NOT asked here: does this window hold the terminal.** That is the delivery's question
 * (`stagedPromptWindowOwnsTerminal`), and asking it at staging time would refuse a prompt the user has
 * every right to leave for a session they detached to a second monitor. What the split costs is honest
 * and bounded: the queue lives in the window that staged it (renderer memory, #390), so an item staged
 * from a window that never mounts that terminal waits until the session comes back to this window — the
 * fallback re-check keeps asking, and the row still shows the count. It is not lost and it is not
 * delivered behind the user's back, which is the pair that matters.
 */
function canStagePromptFor(session) {
  if (!session || !session.sessionId) return false;
  if (session.type === 'terminal') return false;
  const status = stagedPromptStatusKey(session);
  return status !== '' && status !== 'idle' && status !== 'exited';
}

/** Stage `text` for a session, then see whether it can go straight out. */
function stagePromptForSession(sessionId, text) {
  const before = stagedPrompts;
  stagedPrompts = enqueuePrompt(stagedPrompts, sessionId, text, { at: Date.now() });
  if (stagedPrompts === before) return false;   // blank text stages nothing
  // Deliver FIRST and paint once. The ordinary case for a session that is ready is that the item goes
  // straight out, and repainting before the delivery meant two full sidebar renders back to back for one
  // gesture — the first drawing a chip that the second immediately took away again. `refreshSidebar` is
  // the whole tree, so the redundant one is not free (`.claude/rules/renderer.md`).
  if (!deliverStagedPrompts()) refreshStagedPromptViews();
  return true;
}

/** Throw away everything staged for a session. Returns how many items went. */
function discardStagedPrompts(sessionId) {
  const count = stagedPromptCountFor(sessionId);
  if (count === 0) return 0;
  stagedPrompts = clearQueuedPrompts(stagedPrompts, sessionId);
  stagedPromptLastDelivery.delete(sessionId);
  syncStagedPromptRecheck(false);
  refreshStagedPromptViews();
  return count;
}

/**
 * The session exited — its staged prompts go with it (#614), rather than waiting for a relaunch that
 * would deliver them into a different conversation.
 *
 * It says so out loud: a prompt the user staged and never saw arrive is exactly the silent loss this
 * feature exists to prevent, and the session's own exit banner says nothing about it.
 */
function discardStagedPromptsOnExit(sessionId) {
  const count = discardStagedPrompts(sessionId);
  // …and so does what this window believed about the prompt line. A backend that adopts its own id keeps
  // it across a relaunch, and `activePtyIds` heals on the next poll — so a session left `dirty` from
  // before the exit would come back up already blocked, with a fresh process that has nothing in its line
  // and no keystroke coming to clear the flag. Half-typed input dies with the process that held it.
  clearPromptLineState(sessionId);
  if (count > 0 && typeof showControlToast === 'function') {
    showControlToast({
      message: count === 1
        ? 'The session exited — its staged prompt was discarded.'
        : `The session exited — its ${count} staged prompts were discarded.`,
    });
  }
  return count;
}

/** A fork moved the session onto a new id; its queue moves with every other per-session map. */
function rekeyStagedPrompts(oldId, newId) {
  stagedPrompts = rekeyQueuedPrompts(stagedPrompts, oldId, newId);
  if (stagedPromptDirtyLines.delete(oldId)) stagedPromptDirtyLines.add(newId);
  stagedPromptLastDelivery.delete(oldId);
}

/**
 * Something was written into a session's prompt line. Reached from `sendSessionInput` above — every
 * renderer writer of that line, not just the keyboard — and from nowhere else.
 *
 * It OBSERVES the bytes on their way to the pty and never touches them, which is the whole difference
 * between this feature and the keystroke buffering #614 rejected. It runs AFTER the write has gone out,
 * so nothing it does can reorder what the user sent.
 */
function markPromptLineFromInput(sessionId, data) {
  if (!sessionId) return;
  const wasDirty = stagedPromptDirtyLines.has(sessionId);
  if (promptLineDirtyAfter(wasDirty, data)) stagedPromptDirtyLines.add(sessionId);
  else stagedPromptDirtyLines.delete(sessionId);
  const nowDirty = stagedPromptDirtyLines.has(sessionId);
  // Asked BEFORE the delivery below, because a delivery changes the count this reads.
  const waitingStateChanged = wasDirty !== nowDirty && stagedPromptCountFor(sessionId) > 0;

  // **Nothing is delivered from here, and there used to be.** An "abandoned line" branch fired on Esc,
  // Ctrl-C and Ctrl-U, on the belief that those empty the composer and start no turn — so a staged prompt
  // could go out with no status edge to wait for. A live session disproved the belief for Esc and the
  // delivery merged into the line that was still there (`shell/prompt-queue.js` has the transcript). With
  // only a submit clearing the line, there is no keystroke left that releases a hold: a submit starts a
  // turn, and the busy edge that follows is what the delivery trigger already listens for. Re-checking the
  // gate here would race that edge and put a staged prompt on top of the turn the user just began.
  //
  // What remains is the repaint. The chip's waiting state changed, so the row that draws it has to be
  // rebuilt. This is a full sidebar render on a KEYSTROKE path, which is why every part of the condition
  // matters: it fires only for a session that has something staged (rare), and only on the EDGE — the
  // first key of a line and the submit that ends it — never per character.
  if (waitingStateChanged) refreshStagedPromptViews();
}

/**
 * Forget what this window believed about a session's prompt line.
 *
 * Called on the two events that make the belief meaningless: the process exited, and the terminal was
 * torn down. Both are the same failure if it is skipped — the flag outlives what it described, and a
 * relaunch or a re-mount that reuses the session id starts out blocked by a line that no longer exists,
 * with nothing on the way to clear it (only a submit clears the line, and the user has no reason to send
 * one into a session they believe is fresh).
 */
function clearPromptLineState(sessionId) {
  if (!sessionId) return;
  stagedPromptDirtyLines.delete(sessionId);
}

/**
 * Arm or disarm the fallback re-check (see `STAGED_PROMPT_RECHECK_MS`).
 *
 * `soon` asks for the short interval instead: something was just delivered into this session, or the hold
 * after a delivery has not expired, and the wakeup that matters is the end of that hold rather than a
 * quarter of a minute later.
 */
function syncStagedPromptRecheck(soon) {
  const pending = Object.keys(stagedPrompts).length > 0;
  if (!pending) {
    // Nothing staged anywhere: the timer has nothing left to re-check, and a renderer that keeps waking
    // up for an empty queue is the poll this feature was built to avoid.
    if (stagedPromptRetryTimer) clearTimeout(stagedPromptRetryTimer);
    stagedPromptRetryTimer = null;
    stagedPromptRetryDelay = 0;
    return;
  }
  const delay = soon ? REDELIVERY_GAP_MS : STAGED_PROMPT_RECHECK_MS;
  if (stagedPromptRetryTimer) {
    // One timer at a time, and the SHORTER interval wins. A queue that sat blocked has the long fallback
    // armed; the moment a delivery goes out, what matters is the end of that delivery's hold, and leaving
    // the long one in place would make the second item of a queue wait out the fallback for no reason.
    // Never the other way round — a timer already due sooner than asked for is not worth replacing.
    if (stagedPromptRetryDelay <= delay) return;
    clearTimeout(stagedPromptRetryTimer);
    stagedPromptRetryTimer = null;
  }
  stagedPromptRetryDelay = delay;
  stagedPromptRetryTimer = setTimeout(() => {
    stagedPromptRetryTimer = null;
    stagedPromptRetryDelay = 0;
    deliverStagedPrompts();
  }, delay);
}

/**
 * Hand each session with something staged its next item, if the gate lets it.
 *
 * Called from `refreshSessionStatusViews` (app.js) — the choke point EVERY busy, ready, attention and
 * pty-set change funnels through — so the gate is re-asked exactly when its answer can have changed,
 * with no poll of this feature's own. Also called straight after staging, and from the fallback
 * re-check — those two plus the status edges are the whole set, because no keystroke releases a hold.
 *
 * Returns whether anything went out, which is also whether the sidebar was repainted — the staging path
 * reads that to avoid painting the same gesture twice.
 */
function deliverStagedPrompts() {
  if (deliveringStagedPrompts) return false;
  const sessionIds = Object.keys(stagedPrompts);
  if (sessionIds.length === 0) {
    syncStagedPromptRecheck(false);   // takes the fallback timer away with the last item
    return false;
  }

  deliveringStagedPrompts = true;
  let delivered = false;
  let holding = false;
  try {
    for (const sessionId of sessionIds) {
      // Our own submit is not instantly visible in the status model: the busy edge comes from the CLI's
      // own output (a title spinner, a hook, a store write), and until it arrives the session still reads
      // `running` with a clean line. A status refresh inside that window would hand the next staged item
      // to the turn we just started, so a session just delivered into is held — and one re-check is
      // scheduled for the end of the hold, which is also what lets a backend that never announces busy
      // drain a queue at all. It is a timer only while something is staged.
      const last = stagedPromptLastDelivery.get(sessionId) || 0;
      if (Date.now() - last < REDELIVERY_GAP_MS) { holding = true; continue; }

      const session = stagedPromptSession(sessionId);
      if (!session) continue;   // this window does not know the session; leave the items staged

      // …and knowing the session is not enough: only the window holding its TERMINAL can see whether the
      // user is mid-line in it. See `stagedPromptWindowOwnsTerminal` for why this is `openSessions`.
      if (!stagedPromptWindowOwnsTerminal(sessionId)) continue;

      const item = nextDeliverable(stagedPrompts, sessionId, {
        status: stagedPromptStatusKey(session),
        dirty: stagedPromptDirtyLines.has(sessionId),
      });
      if (!item) continue;

      // The existing input path, and the only one — no new IPC surface. The submit is a CARRIAGE RETURN
      // for the reason seedSessionWhenReady spells out: Enter is 0x0D on a terminal, and 0x0A would leave
      // the prompt sitting in the input unsent.
      //
      // **Straight to the preload, deliberately NOT through `sendSessionInput`** — this is the one write
      // in the renderer that is not the user's prompt line, and routing it through the seam would have it
      // classify its own submit. The guard in `test/prompt-staging-wiring.test.js` allows this call and
      // this one only.
      window.api.sendInput(sessionId, item.text + '\r');
      stagedPrompts = removeQueuedPrompt(stagedPrompts, sessionId, item.id);
      stagedPromptLastDelivery.set(sessionId, Date.now());
      // The gate above already refused a dirty line, so this is belt and braces rather than a state
      // change — kept because the alternative is a delivery whose correctness depends on a condition
      // checked twenty lines earlier, and because our own write deliberately goes around the seam that
      // would otherwise have said so.
      stagedPromptDirtyLines.delete(sessionId);
      delivered = true;
      if (promptQueueCount(stagedPrompts, sessionId) > 0) holding = true;
    }
  } finally {
    deliveringStagedPrompts = false;
  }

  // Armed on every pass that leaves something staged, not only after a delivery. `holding` only chooses
  // the interval; whether a timer exists at all is decided by whether the queue is empty, because the
  // states with no status edge behind them (a dirty line the user never submits, a terminal in another
  // window) would otherwise wait for a change that is not coming.
  syncStagedPromptRecheck(holding);
  if (delivered) refreshStagedPromptViews();
  return delivered;
}

/** The name a dialog or a toast calls this session, the way every other surface spells it. */
function stagedPromptSessionLabel(session) {
  if (!session) return '';
  const name = (typeof cleanDisplayName === 'function')
    ? cleanDisplayName(session.name || session.aiTitle || session.summary)
    : (session.name || session.aiTitle || session.summary || '');
  return name || session.sessionId;
}

/**
 * Ask for the prompt and stage it.
 *
 * A dialog rather than a field in the terminal: staging has to be an act of its own, with its own input,
 * or it is the keystroke interception this issue exists to avoid.
 */
async function promptForStagedPrompt(session) {
  if (!canStagePromptFor(session) || typeof showControlDialog !== 'function') return;
  const label = stagedPromptSessionLabel(session);
  const text = await showControlDialog({
    title: 'Stage a prompt',
    message: `It is delivered to “${label}” as soon as that session is ready for it — never while it is `
      + 'working, waiting for you, or while you have something half-typed in its own prompt line.',
    prompt: { placeholder: 'What should this session do next?', maxLength: 2000 },
    confirmLabel: 'Stage',
    // It holds typed work, so a backdrop click or a reflexive Escape must not throw it away
    // (`.claude/rules/renderer.md`). Cancel is the way out and it is labelled.
    dismissible: false,
  });
  if (!text) return;

  // Asked again: the dialog was open while the session could have ended.
  const still = stagedPromptSession(session.sessionId) || session;
  if (!canStagePromptFor(still)) {
    if (typeof showControlToast === 'function') {
      showControlToast({ message: `“${label}” is no longer running — nothing was staged.` });
    }
    return;
  }
  if (stagePromptForSession(session.sessionId, text) && typeof showControlToast === 'function') {
    showControlToast({ message: `Staged for “${label}”. It goes in as soon as the session is ready.` });
  }
}

/**
 * Show what is staged and offer to throw it away — the "visible somewhere and can be discarded" half.
 *
 * The chip prints a count; this is where the TEXT is readable, which is the thing a user has to see
 * before deciding. Opened from the chip on the session row.
 *
 * **The text goes in the MESSAGE, not in detail rows.** A detail row is one ellipsised line by design —
 * `white-space: nowrap` with no `title` — and the input that produced this accepts 2000 characters, so a
 * review dialog built out of them showed the user the first few words of what they are being asked to
 * throw away. The message is a paragraph that wraps, which is the smaller of the two honest fixes: the
 * alternative is teaching the shared dialog a second kind of detail row, and every other caller's rows
 * are short labelled values that are right as they are.
 */
async function reviewStagedPrompts(sessionId) {
  const items = stagedPromptsFor(sessionId);
  if (items.length === 0 || typeof showControlDialog !== 'function') return;
  const label = stagedPromptSessionLabel(stagedPromptSession(sessionId));
  const held = stagedPromptHeldByLine(sessionId)
    ? ' Held: you have something unsent in that session’s own prompt line. Submitting that line'
      + ' releases this.'
    : '';
  // Numbered only when there is more than one: a single prompt reads as itself, and a lone "1." in front
  // of it is markup for a list that is not there. The blank line between items is what separates them —
  // `.control-dialog p` keeps newlines for exactly this (`pre-line`).
  const body = items.length === 1
    ? items[0].text
    : items.map((item, i) => `${i + 1}. ${item.text}`).join('\n\n');
  const confirmed = await showControlDialog({
    title: items.length === 1 ? 'Staged prompt' : `${items.length} staged prompts`,
    message: `Waiting for “${label}” to be ready. Delivered oldest first, one per turn.${held}\n\n${body}`,
    tone: 'danger',
    confirmLabel: items.length === 1 ? 'Discard it' : 'Discard all',
    cancelLabel: 'Keep',
  });
  if (confirmed === true) discardStagedPrompts(sessionId);
}

// Registered at the tail of the file that owns the doing, the way sidebar-collapse.js and
// plans-memory-view.js do — the palette holds no table of actions (#274). Guarded because several test
// harnesses load this file on its own, where the registry is not in scope.
if (typeof registerCommandAction === 'function') registerCommandAction({
  id: 'prompt.stage',
  // It NAMES the session, for the reason handoff.create and plan.create do: the action follows the app's
  // focus (#473), which can be a session whose terminal is not the thing on screen.
  title: () => {
    const session = typeof focusedActionSession === 'function' ? focusedActionSession() : null;
    const label = session ? stagedPromptSessionLabel(session) : '';
    return label ? `Stage a prompt for “${label}”` : 'Stage a prompt';
  },
  group: 'Session',
  keywords: 'stage queue prompt later deliver when ready busy waiting send next',
  available: () => canStagePromptFor(typeof focusedActionSession === 'function' ? focusedActionSession() : null),
  run: () => {
    // Asked again rather than closed over: the palette may have been open while the session ended.
    const session = typeof focusedActionSession === 'function' ? focusedActionSession() : null;
    if (session) return promptForStagedPrompt(session);
  },
});
