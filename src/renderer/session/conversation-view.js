// session/conversation-view.js — the surface of a session that has no terminal (#568).
//
// A backend that declares `transport` is driven over a pipe (`src/app/agent-rpc.js`), so there is no PTY and
// no xterm. This file is what its tab shows instead: the conversation, drawn by the SAME functions the
// Message History viewer uses (`renderJsonlEntry`, `buildToolResultMap` — `jsonl/jsonl-viewer.js`), so a live
// session and its history read the same, plus what only a live session has — the turn being streamed, the
// tools running right now, a question the agent is waiting on.
//
// It knows no backend. What arrives is the app's own vocabulary (`agent-event` ops: reset / append /
// partial / tool / busy / queue / notice / ask / answered), produced from the backend's format in the backend's
// folder. Nothing here would change for a second backend driven the same way.
//
// THE ENTRY IS NOT A TERMINAL. `createTerminalEntry` hands such a session to `createConversationEntry`, and
// the entry it returns carries `terminal: null` and `conversation: <this view>`. Every place that assumed an
// xterm asks `entry.terminal` first; the ones that could not are listed in the PR that added this file and
// in `docs/specs/30-pi-native.md`.
//
// INPUT (step B of #568). A text field, not keystrokes into a PTY. Enter sends a turn — main queues it behind
// a running one, against its own busy state; Ctrl/Cmd+Enter STEERS a running turn (delivered between its tool calls); Escape stops it. The skill,
// plan, handoff and variable pickers open here on the same shortcuts as in a terminal, and what they pick
// lands in this field through `insertResolvedText` (terminal/terminal-context-menu.js), which asks the
// entry for a conversation before it reaches for a PTY.
//
// Free globals it reads at CALL time (none at parse time except `window.api`): renderJsonlEntry,
// buildToolResultMap, renderToolUse, escapeHtml (jsonl/jsonl-viewer.js, shell), openSessions (app.js), matchShortcut
// (shell/shortcuts.js), appShortcuts (shell/session-nav.js), isMac (terminal/terminal-manager.js), the
// four palette openers (terminal/*-palette.js), createComposerCompletion (session/composer-completion.js,
// read when a view is built), showBranchTreeDialog (session/branch-tree-dialog.js, #646),
// clearTerminalAttentionNotice (terminal/terminal-attention-notice.js, #666), terminalRightClickMode
// (terminal/terminal-context-menu.js, #690), and sessionHealthOptions (app.js, #691 — the handoff threshold
// the context fill turns warm at).

// How close to the bottom counts as "at the bottom" — the view follows new output only when the reader
// was already there, so scrolling up to read something is not undone by the next token.
const CONVERSATION_STICK_PX = 40;

// How much of a running tool's live output is shown. The whole output lands in the tool block when the
// tool finishes; this is only the "it is doing something" view.
const CONVERSATION_TOOL_TAIL_LINES = 12;

function conversationToolName(view, id) {
  const lists = [view.entries, view.partial ? [view.partial] : []];
  for (const list of lists) {
    for (const entry of list) {
      const blocks = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const b of blocks) if (b && b.type === 'tool_use' && b.id === id) return b.name || 'tool';
    }
  }
  return 'tool';
}

// A turn that is purely tool results renders nothing of its own: its results are drawn under the tool calls
// they answer. Which calls those are is what the renderer re-draws when one arrives.
function conversationResultIds(entry) {
  const blocks = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : null;
  if (!blocks || !blocks.length) return null;
  if (!blocks.every(b => b && b.type === 'tool_result')) return null;
  return blocks.map(b => b.tool_use_id).filter(Boolean);
}

function conversationOwnerIndex(view, toolUseId) {
  for (let i = view.entries.length - 1; i >= 0; i--) {
    const blocks = view.entries[i] && view.entries[i].message && view.entries[i].message.content;
    if (Array.isArray(blocks) && blocks.some(b => b && b.type === 'tool_use' && b.id === toolUseId)) return i;
  }
  return -1;
}

// `getSession` rather than the session: a re-key (the launch id becoming the id the runtime named) can hand
// the entry a new session object, and every request below must name the id the session has NOW.
function createConversationView(getSession, container) {
  const log = document.createElement('div');
  log.className = 'conversation-log';
  const partialEl = document.createElement('div');
  partialEl.className = 'conversation-partial';
  const activity = document.createElement('div');
  activity.className = 'conversation-activity';
  const status = document.createElement('div');
  status.className = 'conversation-status';
  // The session line (#691): the context fill, the model and the working state on the left, what runs in the
  // background on the right as buttons that open the Background list.
  const statusText = document.createElement('span');
  statusText.className = 'conversation-status-text';
  const bgChips = document.createElement('span');
  bgChips.className = 'conversation-bg-chips';
  status.appendChild(statusText);
  status.appendChild(bgChips);
  const bgPop = document.createElement('div');
  bgPop.className = 'conversation-bg-pop';
  bgPop.hidden = true;
  bgPop.tabIndex = -1;
  bgPop.setAttribute('role', 'dialog');
  bgPop.setAttribute('aria-label', 'Background tasks');
  log.appendChild(partialEl);
  log.appendChild(activity);
  // Messages sent from here that the runtime has not played back yet (#694), at the very end of the log.
  const pendingEl = document.createElement('div');
  pendingEl.className = 'conversation-pending-sends';
  log.appendChild(pendingEl);
  // Prompts main holds while a turn runs (#702), after the ones already on their way.
  const heldEl = document.createElement('div');
  heldEl.className = 'conversation-held-prompts';
  log.appendChild(heldEl);

  const composer = document.createElement('div');
  composer.className = 'conversation-composer';
  const input = document.createElement('textarea');
  input.className = 'conversation-input';
  input.rows = 3;
  const mod = (typeof isMac !== 'undefined' && isMac) ? 'Cmd' : 'Ctrl';
  input.placeholder = `Message the agent — / for commands, @ for files. Enter sends, Shift+Enter adds a line, ${mod}+Enter steers a running turn, Esc stops it`;
  const actions = document.createElement('div');
  actions.className = 'conversation-composer-actions';
  const makeButton = (label, title, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'new-session-secondary-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    actions.appendChild(b);
    return b;
  };
  const sendBtn = makeButton('Send', 'Send (Enter)', () => submit('prompt'));
  const steerBtn = makeButton('Steer', `Deliver between the running turn's tool calls (${mod}+Enter)`, () => submit('steer'));
  const stopBtn = makeButton('Stop', 'Stop the running turn (Esc)', () => stop());
  composer.appendChild(input);
  composer.appendChild(actions);
  // `/` commands, their arguments and `@` paths (#643, session/composer-completion.js). What it offers is the
  // backend's answer through main; the session id is read at call time, because a re-key moves it.
  const completion = typeof createComposerCompletion === 'function'
    ? createComposerCompletion(input, composer, {
      commands: async () => { const r = await window.api.agent.commands(getSession().sessionId); return r && r.ok ? r.commands : []; },
      arguments: async (command) => { const r = await window.api.agent.arguments(getSession().sessionId, command); return r && r.ok ? r.items : []; },
      paths: async (prefix) => { const r = await window.api.agent.paths(getSession().sessionId, prefix); return r && r.ok ? r.items : []; },
    })
    : null;

  // Images waiting to go out with the next turn (#662), drawn above the input with a way to take each back.
  const attachStrip = document.createElement('div');
  attachStrip.className = 'conversation-attachments';
  attachStrip.hidden = true;

  // Back to the end (#689): shown only while the log is scrolled away from it. It sits over the log's lower
  // edge, so the log goes into a positioned wrapper that takes its place in the column.
  const logWrap = document.createElement('div');
  logWrap.className = 'conversation-log-wrap';
  const jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.className = 'new-session-secondary-btn conversation-jump';
  jumpBtn.textContent = '↓ Latest';
  jumpBtn.title = `Back to the end (${mod}+End)`;
  jumpBtn.hidden = true;
  // Clickable so the page keys work from the log as well as from the input; -1 keeps it out of the Tab order.
  log.tabIndex = -1;
  logWrap.appendChild(log);
  logWrap.appendChild(jumpBtn);

  container.appendChild(logWrap);
  container.appendChild(attachStrip);
  container.appendChild(composer);
  container.appendChild(status);
  container.appendChild(bgPop);

  const view = {
    get session() { return getSession(); },
    container,
    entries: [],
    elements: [],            // parallel to entries; null where an entry draws nothing
    partial: null,
    tools: new Map(),        // tool call id -> { status, output }
    asks: new Map(),         // request id -> card element
    approvals: new Map(),    // tool call id -> { id, kind } of the card holding that call, while it is open
    busy: false,
    queue: { steering: [], followUp: [] },
    // Shell lines still running: the runtime's id -> { index, command }. See `localCommand`.
    localCommands: new Map(),
    // Images attached to the next turn: { mimeType, data (base64), name, url (a data: URL for the thumbnail),
    // label ('[Image #n]', the placeholder standing where it was attached — #688) }.
    attachments: [],
    exited: false,
    attached: false,
    attaching: false,        // an attach is in flight — see renderStatus
    busySince: null,         // when the running turn began, for its elapsed time; null when not known (#691)
    suggestion: null,        // the next prompt the runtime proposed, offered in the empty input (#693)
    pendingSends: [],        // messages sent from here that the runtime has not played back yet: { text, el, at } (#694)
    heldPrompts: { items: [], paused: false }, // prompts main holds while a turn runs: { id, text, images } (#702)
    tasks: [],               // what runs in the background: { id, kind, description, detail, toolUseId, startedAt } (#691)
    context: null,           // { percent, tokens, window, model } as the backend last read them (#691)
    mode: null,              // the permission mode, { id, label, symbol, tone } in the backend's words (#696)
    canSwitchMode: false,    // whether the backend can switch it — Pi has no such modes (#696)
  };

  // Whether the user is reading the end (#689). REMEMBERED from the user's own scrolling, not measured when an
  // entry arrives: a tab that is not on screen measures zero, so the old measure-then-follow always said
  // "at the end", scrolled a hidden log (which does nothing), and the tab came back where it was left. A log
  // with no height says nothing about where the user is, so it neither sets nor clears this.
  let stuck = true;
  // Where a reader who scrolled away was. A hidden tab loses its scroll position (measured in the app: back at
  // 0 after a tab switch), so the place is kept here and put back when the log is shown again.
  let readerTop = 0;
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < CONVERSATION_STICK_PX;
  const renderJump = () => { jumpBtn.hidden = stuck || !log.clientHeight; };
  const follow = () => { if (stuck && log.clientHeight) log.scrollTop = log.scrollHeight; };
  const restore = () => {
    if (!log.clientHeight) return;
    if (stuck) log.scrollTop = log.scrollHeight;
    else if (log.scrollTop !== readerTop) log.scrollTop = readerTop;
  };
  function toEnd() {
    stuck = true;
    log.scrollTop = log.scrollHeight;
    renderJump();
  }
  log.addEventListener('scroll', () => {
    if (!log.clientHeight) return;
    stuck = atBottom();
    readerTop = log.scrollTop;
    renderJump();
  });
  // Shown again (a tab switch, a pane resize): a reader at the end is put back at the end, whatever arrived
  // while nobody could see it. A reader who had scrolled up gets the place back.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { restore(); renderJump(); tick(); }).observe(log);
  }
  jumpBtn.addEventListener('click', () => { toEnd(); input.focus(); });

  // The CLI's keys for its history (#689): Ctrl+Home / Ctrl+End to either end, PageUp / PageDown a page at a
  // time. Taken from the input too, where Ctrl+Home/End would otherwise move the caret — a composer rarely
  // holds enough text for that to be the key's job, and the terminal view gives these keys to the history.
  function pageKey(e) {
    if (e.altKey || e.shiftKey) return false;
    // Cmd on a Mac, as the button's tooltip says; Ctrl elsewhere.
    const macNow = typeof isMac !== 'undefined' && isMac;
    const chord = macNow ? e.metaKey : e.ctrlKey;
    const other = macNow ? e.ctrlKey : e.metaKey;
    if (other) return false;
    const page = Math.max(40, log.clientHeight - 40);
    if (chord && e.key === 'End') { toEnd(); return true; }
    if (chord && e.key === 'Home') { log.scrollTop = 0; return true; }
    if (chord) return false;
    if (e.key === 'PageUp') { log.scrollTop -= page; return true; }
    if (e.key === 'PageDown') { log.scrollTop += page; return true; }
    return false;
  }
  container.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.target !== input && e.target !== log) return;
    if (e.target === input && completion && completion.isOpen && completion.isOpen()) return;
    if (pageKey(e)) e.preventDefault();
  });

  function renderOne(index) {
    const entry = view.entries[index];
    // A fresh map per draw: `renderJsonlEntry` CLAIMS the results it draws under a call by deleting them,
    // so a shared one would hand each result to whichever call happened to be drawn first.
    const el = renderJsonlEntry(entry, buildToolResultMap(view.entries));
    if (el) el.dataset.entryIndex = String(index);
    return el;
  }

  function insertEntryEl(index, el) {
    if (!el) return;
    // Before the partial/activity/asks tail, which always stays at the bottom of the log.
    log.insertBefore(el, partialEl);
  }

  // --- A sent message, until the runtime plays it back (#694) ---
  // The runtime returns a sent line when its turn STARTS (0.6 s later, 2 s on the first turn, a whole turn
  // later while one runs), so the view shows it at once, dimmed, at the end of the log. The played-back entry
  // takes its place wherever its turn runs; a refusal takes it away. A `!` shell line is not a turn and is
  // drawn as its own entry, so it gets none.
  const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  function userTextOf(entry) {
    const m = entry && entry.message;
    if (!m || m.role !== 'user') return null;
    if (typeof m.content === 'string') return m.content;
    if (!Array.isArray(m.content) || m.content.some(b => b && b.type === 'tool_result')) return null;
    return m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  }
  function addPendingSend(text, queued) {
    if (!normText(text) || /^\s*!/.test(text)) return null;
    const el = renderJsonlEntry({ type: 'user', message: { role: 'user', content: text } }, new Map());
    if (!el) return null;
    el.classList.add('conversation-pending');
    const tag = document.createElement('span');
    tag.className = 'conversation-pending-tag';
    tag.textContent = queued ? 'queued' : 'sending…';
    el.appendChild(tag);
    pendingEl.appendChild(el);
    const p = { text: normText(text), el, at: Date.now() };
    view.pendingSends.push(p);
    toEnd();
    return p;
  }
  // The held prompts (#702), each with what can be done to it: taken back into the input to rework it, or
  // withdrawn. After a Stop the queue waits for the user, and each prompt can be sent from here.
  function renderHeld() {
    heldEl.replaceChildren();
    const { items, paused } = view.heldPrompts;
    for (const item of items) {
      const el = renderJsonlEntry({ type: 'user', message: { role: 'user', content: item.text } }, new Map());
      if (!el) continue;
      el.classList.add('conversation-pending', 'conversation-held');
      el.dataset.heldId = item.id;
      const tag = document.createElement('span');
      tag.className = 'conversation-pending-tag';
      tag.textContent = (paused ? 'queued · paused' : 'queued') + (item.images ? ` · ${item.images} image${item.images === 1 ? '' : 's'}` : '');
      const actions = document.createElement('span');
      actions.className = 'conversation-held-actions';
      const act = (action, label, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'task-notice-output';
        b.dataset.heldAction = action;
        b.textContent = label;
        b.title = title;
        actions.appendChild(b);
      };
      if (paused) act('send', 'send now', 'Send this prompt now');
      act('edit', 'edit', 'Take it back into the input to rework it');
      act('withdraw', '×', 'Withdraw this prompt');
      tag.appendChild(actions);
      el.appendChild(tag);
      heldEl.appendChild(el);
    }
    if (items.length) toEnd();
  }
  heldEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-held-action]');
    const row = btn && btn.closest('[data-held-id]');
    if (!row) return;
    const action = btn.dataset.heldAction;
    // One press, one request: a second click on the same row while the first is out would only be told the
    // prompt is gone.
    if (row.dataset.busy) return;
    row.dataset.busy = '1';
    let res;
    try { res = await window.api.agent.held(view.session.sessionId, action === 'send' ? 'send' : 'withdraw', row.dataset.heldId); } catch { res = null; }
    delete row.dataset.busy;
    if (!res || !res.ok) { notice('error', (res && res.error) || 'The prompt could not be changed.'); return; }
    if (action === 'edit') takeBackHeld(res.text || '', res.images || []);
  });
  // A held prompt back in the input: appended after what is typed there, with its images attached again under
  // fresh numbers — the numbers it was written with may now belong to images already in the input.
  function takeBackHeld(text, images) {
    // The labels to hand out, one per image, taken before any is attached so none repeats.
    const labels = [];
    for (const img of images) {
      if (!img || !img.mimeType || !img.data) continue;
      const label = nextImageLabel();
      view.attachments.push({ mimeType: img.mimeType, data: img.data, name: 'Image', url: `data:${img.mimeType};base64,${img.data}`, label });
      labels.push(label);
    }
    // The n-th placeholder in the text is the n-th image (#688); one without a placeholder is added at the end.
    let next = 0;
    let body = String(text || '').replace(/\[Image #\d+\]/g, (m) => (next < labels.length ? labels[next++] : m));
    while (next < labels.length) body += (body ? ' ' : '') + labels[next++];
    input.value = input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n${body}` : body;
    renderAttachments();
    renderComposer();
    input.focus();
  }

  function dropPendingSend(p) {
    if (!p) return;
    p.el.remove();
    view.pendingSends = view.pendingSends.filter(x => x !== p);
  }
  function settlePendingSend(entry) {
    if (!view.pendingSends.length) return;
    const text = userTextOf(entry);
    if (text == null) return;
    // Equal, or beginning with what was sent: a `/` command a runtime answers by itself can come back as the
    // command followed by its output (claude-native point 6). The earliest match wins, so two identical
    // messages settle in the order they were sent.
    const played = normText(text);
    const p = view.pendingSends.find(x => played === x.text || played.startsWith(`${x.text} `));
    if (p) dropPendingSend(p);
  }

  function appendEntry(entry) {
    settlePendingSend(entry);
    const index = view.entries.push(entry) - 1;
    const resultIds = conversationResultIds(entry);
    if (resultIds) {
      view.elements[index] = null;
      for (const id of resultIds) {
        view.tools.delete(id);
        const owner = conversationOwnerIndex(view, id);
        if (owner < 0) continue;
        const old = view.elements[owner];
        const fresh = renderOne(owner);
        if (old && fresh) old.replaceWith(fresh);
        view.elements[owner] = fresh || old;
      }
      renderActivity();
      return;
    }
    const el = renderOne(index);
    view.elements[index] = el;
    insertEntryEl(index, el);
  }

  // A shell line the user ran (#643). It is an ORDINARY entry — it keeps the place it started in — and it
  // is replaced as its output grows, so the map only has to remember which entry belongs to which line.
  // Keyed by the runtime's id rather than drawn in the partial slot, because a shell line and an assistant
  // turn can be live at the same time and the partial slot holds one thing.
  //
  // The command text arrives once, with the first op; the ops after it carry output and status only, so it
  // is kept here rather than re-sent.
  function localCommand(op) {
    const id = String(op.id == null ? '' : op.id);
    if (!id) return;
    const known = view.localCommands.get(id);
    const command = op.command != null ? String(op.command) : (known ? known.command : '');
    const entry = { type: 'local-command', _localCmd: { cmd: command, output: String(op.output || '') } };
    const running = op.status === 'running';
    if (known) {
      view.entries[known.index] = entry;
      known.command = command;
      const fresh = renderOne(known.index);
      if (fresh && running) fresh.classList.add('conversation-streaming');
      const old = view.elements[known.index];
      if (old && fresh) old.replaceWith(fresh);
      view.elements[known.index] = fresh || old;
      if (!running) { view.localCommands.delete(id); renderComposer(); }
      return;
    }
    const index = view.entries.push(entry) - 1;
    view.localCommands.set(id, { index, command });
    const el = renderOne(index);
    if (el && running) el.classList.add('conversation-streaming');
    view.elements[index] = el;
    insertEntryEl(index, el);
    if (!running) view.localCommands.delete(id);
    // Stop appears and disappears with the command, and nothing else redraws the composer for it: a
    // shell line raises no busy edge, which is what `somethingRunning` exists to cover.
    renderComposer();
  }

  function reset(entries) {
    for (const el of view.elements) if (el) el.remove();
    // A message still waiting to be played back belongs to the conversation just replaced (#694).
    for (const p of view.pendingSends.slice()) dropPendingSend(p);
    // A notice has no place in the runtime's snapshot, so once the entries around it are redrawn it would
    // sit above the whole conversation (#654). A reset used to happen only on an empty log at mount; a
    // branch switch (#646) resets a log that has notices in it, and the one about the switch itself is sent
    // after the reset, so it still appears.
    for (const el of log.querySelectorAll(':scope > .conversation-notice')) el.remove();
    view.entries = [];
    view.elements = [];
    // A re-mount re-reads the conversation from the runtime, and a finished shell line is in it as an
    // ordinary entry — so nothing here may still claim an index into the list just thrown away.
    view.localCommands.clear();
    for (const entry of entries || []) appendEntry(entry);
    // A question still open stays open, below the conversation it is about — where it was before.
    for (const card of view.asks.values()) log.insertBefore(card, partialEl);
    renderComposer();
  }

  function renderPartial() {
    partialEl.replaceChildren();
    if (!view.partial) return;
    const el = renderJsonlEntry(view.partial, new Map());
    if (el) {
      el.classList.add('conversation-streaming');
      partialEl.appendChild(el);
    }
  }

  function renderActivity() {
    activity.replaceChildren();
    for (const [id, t] of view.tools) {
      if (t.status !== 'running') continue;
      const row = document.createElement('div');
      row.className = 'jsonl-entry jsonl-meta-entry conversation-tool-running';
      const head = document.createElement('div');
      // A call held by a card is not running yet, whatever the protocol says (spec 30). An approval holds
      // the call it is about; a questions or plan card IS the call, waiting on the user's reply (#666).
      const held = view.approvals.get(id);
      head.textContent = !held
        ? `Running ${conversationToolName(view, id)}…`
        : held.kind === 'questions' ? 'Waiting for your answer'
          : held.kind === 'plan' ? 'Waiting for you to review the plan'
            : `Waiting for your approval to run ${conversationToolName(view, id)}`;
      // How long it has been running (#691). A held call is waiting, not running, so it carries none.
      if (!held && t.startedAt) head.appendChild(elapsedEl(t.startedAt));
      row.appendChild(head);
      const lines = String(t.output || '').split('\n');
      const tail = lines.slice(-CONVERSATION_TOOL_TAIL_LINES).join('\n').trim();
      if (tail) {
        const pre = document.createElement('pre');
        pre.className = 'conversation-tool-output';
        pre.textContent = tail;
        row.appendChild(pre);
      }
      activity.appendChild(row);
    }
    tick();
  }

  // Enter and Send always ask for a plain turn. Whether it has to wait for a running one is decided in the
  // main process against the session's own busy state, which this window only hears about one op later — a
  // mode chosen here from that echo could queue a message behind a run that has already ended.

  let sending = false;
  // A send asked for while one is in flight (a skill picked mid-send) runs when that one is back, rather
  // than being dropped while the picker reports success.
  let submitAgain = null;
  async function submit(mode) {
    syncAttachmentsToText();
    const text = input.value;
    const attached = view.attachments.slice();
    if ((!text.trim() && !attached.length) || view.exited) return;
    if (sending) { submitAgain = mode; return; }
    // Focus goes back to the field afterwards only if it was here to begin with — in panes mode the user
    // may have moved to another pane while the send was in flight.
    const hadFocus = container.contains(document.activeElement);
    sending = true;
    renderComposer();
    const payload = { text, mode };
    // In attach order, which is the order of their numbers: the text says `[Image #n]` and the n-th image is
    // the one it means, the same pairing Claude's CLI relies on (#688).
    if (attached.length) payload.images = attached.map(a => ({ mimeType: a.mimeType, data: a.data }));
    // Shown at once (#694), before the runtime plays it back — made BEFORE the send, so a playback that
    // arrives before the send's answer still finds it to replace.
    const pending = addPendingSend(text, view.busy);
    let res;
    try { res = await window.api.agent.send(view.session.sessionId, payload); } catch { res = null; }
    sending = false;
    if (!(res && res.ok) || (res && res.held)) dropPendingSend(pending);
    if (res && res.ok) {
      // Only what was sent is taken away — something typed while the send was in flight stays, and so does
      // an image attached meanwhile.
      if (input.value.startsWith(text)) input.value = input.value.slice(text.length).replace(/^\s+/, '');
      if (attached.length) {
        view.attachments = view.attachments.filter(a => !attached.includes(a));
        renderAttachments();
      }
      settleAttentionCaption();
      // What was just sent is at the end, and so is the answer to it (#689).
      toEnd();
    } else {
      notice('error', (res && res.error) || 'The message did not reach the session.');
    }
    renderComposer();
    if (hadFocus) input.focus();
    if (submitAgain) { const next = submitAgain; submitAgain = null; submit(next); }
  }

  // What Stop and Escape can end. A turn is the obvious one; a shell line the user ran (#643) is the
  // other, and it is NOT a turn — it sets no busy state, because the agent is not working. Gating the
  // control on `busy` alone therefore left a running command with no way to stop it, which is the whole
  // of what the abort in main was built for.
  const somethingRunning = () => !!view.busy || view.localCommands.size > 0;

  async function stop() {
    if (!somethingRunning()) return;
    let res;
    try { res = await window.api.agent.abort(view.session.sessionId); } catch { res = null; }
    if (!res || !res.ok) notice('error', (res && res.error) || 'The session did not stop.');
    else settleAttentionCaption();
  }

  // The attention caption (#615, terminal/terminal-attention-notice.js) goes on the first write into a
  // terminal, through `sendSessionInput`. Nothing here passes that seam — a turn, a Stop and an answer go to
  // main over `window.api.agent.*` — so without this the caption sat over the view until something
  // unrelated took it down (#666). The view does what the keystroke does, at the three places the user
  // acts: a turn sent, a Stop taken, and a question no longer open (`answered`, whoever closed it).
  //
  // One difference from a terminal, and it is the view knowing more: a terminal cannot tell whether the
  // question is still on its screen, so any keystroke clears. The view holds every open question, so while
  // one still is — a second card, or a Stop whose drop has not arrived yet — the caption stays, and the
  // `answered` that closes the last card takes it down.
  function settleAttentionCaption() {
    if (view.asks.size || typeof clearTerminalAttentionNotice !== 'function') return;
    try { clearTerminalAttentionNotice(view.session.sessionId); } catch { /* never worth an answer */ }
  }

  function renderComposer() {
    const off = view.exited;
    input.disabled = off;
    sendBtn.disabled = off || sending;
    sendBtn.textContent = view.busy ? 'Queue' : 'Send';
    sendBtn.title = view.busy ? 'Send when the running turn is done (Enter)' : 'Send (Enter)';
    steerBtn.style.display = view.busy && !off ? '' : 'none';
    steerBtn.disabled = sending;
    stopBtn.style.display = somethingRunning() && !off ? '' : 'none';
    composer.classList.toggle('disabled', off);
  }

  // The pickers a terminal opens on the same chords. They are handed an ANCHOR where a terminal would go: the
  // palette sits in the lower half of `element`'s rectangle and hands the focus back through `focus()`,
  // which is all it asks of a terminal. What it picks comes back through `insertResolvedText` into this
  // field, which asks the entry for a conversation before it looks at the terminal it was given.
  // Handed to a picker where a terminal would go, and EXPOSED below: the command palette's insert rows
  // open the same pickers for this session (#637) and ask for this object rather than building a second
  // one, which is how the two would start to differ about where the popover sits.
  const paletteAnchor = { element: container, focus: () => input.focus() };
  const PALETTES = {
    insertVariable: () => (typeof openVariablePalette === 'function' ? openVariablePalette : null),
    insertPlan: () => (typeof openPlanPalette === 'function' ? openPlanPalette : null),
    insertHandoff: () => (typeof openHandoffPalette === 'function' ? openHandoffPalette : null),
    insertSkill: () => (typeof openSkillPalette === 'function' ? openSkillPalette : null),
  };

  input.addEventListener('keydown', (e) => {
    // An input method composing a character owns Enter and Escape until it is done (229 is Chromium's
    // composition keyCode, the same guard palette-core.js carries).
    if (e.isComposing || e.keyCode === 229) return;
    // An open suggestion list takes the arrows, Tab, Enter and Escape first — Escape then closes the list
    // rather than stopping the running turn.
    if (completion && completion.handleKey(e)) return;
    // A suggested next prompt (#693): Tab takes it, Escape throws it away — only while the input is empty,
    // which is the only time it is shown, and only when no modifier asks for something else.
    if (view.suggestion && !input.value && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === 'Tab') {
        e.preventDefault();
        input.value = view.suggestion;
        input.setSelectionRange(input.value.length, input.value.length);
        setSuggestion(null);
        return;
      }
      if (e.key === 'Escape' && !somethingRunning()) { e.preventDefault(); setSuggestion(null); return; }
    }
    if (typeof matchShortcut === 'function' && typeof appShortcuts !== 'undefined') {
      const macNow = typeof isMac !== 'undefined' && isMac;
      for (const [id, opener] of Object.entries(PALETTES)) {
        if (matchShortcut(id, e, macNow, appShortcuts)) {
          const open = opener();
          if (open) { e.preventDefault(); e.stopPropagation(); open(paletteAnchor, view.session.sessionId); }
          return;
        }
      }
    }
    if (e.key === 'Escape' && somethingRunning()) { e.preventDefault(); stop(); return; }
    // Shift+Tab switches the permission mode, as in the TUI (#696) — only where the backend has modes, so
    // anywhere else it keeps moving the focus back as in any text field.
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && view.canSwitchMode && !view.exited) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;   // a new line, as in any text field
    const chord = (typeof isMac !== 'undefined' && isMac) ? e.metaKey : e.ctrlKey;
    e.preventDefault();
    submit(chord && view.busy ? 'steer' : 'prompt');
  });

  // Text a picker chose, placed at the caret. `submit` sends the field as a turn right away, which is what a
  // skill invocation asks for in a terminal too.
  function insertText(text, { submit: andSend = false } = {}) {
    if (view.exited) { notice('error', 'The session has ended — nothing was inserted.'); return false; }
    if (typeof text !== 'string' || !text) return false;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    syncAttachmentsToText();
    if (andSend) submit('prompt');
    return true;
  }

  // --- Images for the next turn (#662) ---
  // Which images this session's backend takes, from the descriptor the renderer already caches: `{ types,
  // maxBytes }`, or null. The same declaration main checks every turn against, so nothing is attached here
  // that the send would refuse.
  function imagePolicy() {
    const id = typeof sessionBackendId === 'function' ? sessionBackendId(view.session) : '';
    const backend = id && typeof getBackend === 'function' ? getBackend(id) : null;
    return backend && backend.imageInput && Array.isArray(backend.imageInput.types) ? backend.imageInput : null;
  }

  // --- Where an image stands in the prompt (#688) ---
  // Attaching an image types `[Image #n]` at the caret, the way Claude's own CLI does, so the text can say
  // which picture it means. The placeholder and the thumbnail are one thing: deleting either removes the
  // other. Numbers count up within one draft and start again at 1 once nothing is attached.
  // Past every number in use — an attachment's, and one already standing in the text, typed or pasted — so a
  // new placeholder never repeats one and the × never takes out the wrong occurrence.
  function nextImageLabel() {
    let n = 0;
    for (const a of view.attachments) {
      const m = /#(\d+)\]$/.exec(a.label || '');
      if (m) n = Math.max(n, Number(m[1]));
    }
    for (const m of input.value.matchAll(/\[Image #(\d+)\]/g)) n = Math.max(n, Number(m[1]));
    return `[Image #${n + 1}]`;
  }

  function insertAtCaret(text) {
    const value = input.value;
    const start = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
    const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && /^\s/.test(after) ? '' : ' ';
    input.value = before + lead + text + trail + after;
    const caret = (before + lead + text + trail).length;
    input.setSelectionRange(caret, caret);
  }

  // Takes a placeholder out of the text along with one space beside it, so removing an image leaves no gap.
  function removeLabelText(label) {
    const at = input.value.indexOf(label);
    if (at < 0) return;
    let from = at;
    let to = at + label.length;
    if (input.value[to] === ' ') to++;
    else if (from > 0 && input.value[from - 1] === ' ') from--;
    input.value = input.value.slice(0, from) + input.value.slice(to);
    input.setSelectionRange(from, from);
  }

  // A placeholder deleted from the text takes its image with it. Run on every `input` event, and by the two
  // writers that set the value without one — a picker's `insertText` and, through `submit`, an accepted
  // completion — so no path leaves an image whose reference is gone.
  function syncAttachmentsToText() {
    const kept = view.attachments.filter(a => !a.label || input.value.includes(a.label));
    if (kept.length === view.attachments.length) return;
    view.attachments = kept;
    renderAttachments();
  }
  input.addEventListener('input', syncAttachmentsToText);

  // --- A suggested next prompt (#693) ---
  // Shown as the empty input's placeholder, greyed, with the key that takes it. Typing anything discards it,
  // as the TUI does; a turn starting discards it too.
  const basePlaceholder = input.placeholder;
  function setSuggestion(text) {
    view.suggestion = text && String(text).trim() ? String(text).trim() : null;
    renderSuggestion();
  }
  function renderSuggestion() {
    const on = !!view.suggestion && !input.value;
    input.placeholder = on ? `${view.suggestion}    — Tab to use it` : basePlaceholder;
    input.classList.toggle('has-suggestion', on);
  }
  input.addEventListener('input', () => { if (view.suggestion && input.value) setSuggestion(null); });

  function renderAttachments() {
    attachStrip.replaceChildren();
    attachStrip.hidden = !view.attachments.length;
    for (const a of view.attachments) {
      const item = document.createElement('div');
      item.className = 'conversation-attachment';
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = a.name || 'Attached image';
      img.title = [a.label, a.name].filter(Boolean).join(' ') || 'Attached image';
      item.appendChild(img);
      if (a.label) {
        const tag = document.createElement('span');
        tag.className = 'conversation-attachment-label';
        tag.textContent = a.label.replace(/^\[Image /, '').replace(/\]$/, '');
        item.appendChild(tag);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'viewer-header-close';
      remove.textContent = '×';
      remove.title = 'Remove this image';
      remove.setAttribute('aria-label', 'Remove this image');
      remove.addEventListener('click', () => {
        view.attachments = view.attachments.filter(x => x !== a);
        if (a.label) removeLabelText(a.label);
        renderAttachments();
        input.focus();
      });
      item.appendChild(remove);
      attachStrip.appendChild(item);
    }
  }

  const readAsDataUrl = (file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });

  // Attach the image files among `files`, refusing up front what the session would refuse on send.
  async function attachImages(files) {
    const images = [...files].filter(f => f && typeof f.type === 'string' && f.type.startsWith('image/'));
    if (!images.length || view.exited) return;
    const policy = imagePolicy();
    if (!policy) { notice('error', 'This session does not take images.'); return; }
    const kinds = policy.types.map(t => t.replace(/^image\//, '').toUpperCase()).join(', ');
    const limit = `${Math.round(Number(policy.maxBytes) / (1024 * 1024))} MB`;
    for (const file of images) {
      const name = file.name || 'Pasted image';
      if (!policy.types.includes(file.type)) { notice('error', `${name} was not attached: only ${kinds} images can be sent here.`); continue; }
      // The size the image will have as base64, which is what main checks (`imagesFor` in agent-rpc.js).
      if (Math.ceil(file.size / 3) * 4 > Number(policy.maxBytes)) { notice('error', `${name} was not attached: it is too large (the limit is ${limit} encoded, about ${Math.round(Number(policy.maxBytes) * 3 / 4 / (1024 * 1024) * 10) / 10} MB as a file).`); continue; }
      const url = await readAsDataUrl(file);
      const comma = url.indexOf(',');
      if (comma < 0) { notice('error', `${name} could not be read.`); continue; }
      const label = nextImageLabel();
      view.attachments.push({ mimeType: file.type, data: url.slice(comma + 1), name, url, label });
      insertAtCaret(label);
    }
    renderAttachments();
  }

  input.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const files = [...(data.items || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    // A copy that carries text pastes the text and nothing else. Excel and Word put a rendered picture of the
    // selection on the clipboard beside the text, so attaching the image too would add an unwanted
    // thumbnail to every paste of a few cells.
    if (data.getData('text/plain')) return;
    e.preventDefault();
    attachImages(files);
  });
  // The right-click setting a terminal session follows (#690, Settings > Terminal, `terminalRightClick`),
  // read from the same variable `terminal/terminal-context-menu.js` keeps. Three modes mean something for plain
  // text and a text field; the others keep the view's own behaviour, as the issue asks.
  const rightClickMode = () => (typeof terminalRightClickMode !== 'undefined' ? terminalRightClickMode : 'menu');
  function selectedText() {
    if (document.activeElement === input && input.selectionStart !== input.selectionEnd) {
      return input.value.slice(input.selectionStart, input.selectionEnd);
    }
    const sel = window.getSelection && window.getSelection();
    return sel && !sel.isCollapsed && log.contains(sel.anchorNode) ? sel.toString() : '';
  }
  function pasteIntoInput() {
    if (view.exited || !window.api || typeof window.api.readClipboard !== 'function') return;
    Promise.resolve(window.api.readClipboard()).then((text) => {
      if (!text || view.exited) return;
      input.focus();
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }).catch(() => {});
  }
  // A selection of only whitespace is a stray drag, and copying it would lose what the user meant to paste.
  const copy = (text) => { if (text && text.trim() && window.api && window.api.writeClipboard) window.api.writeClipboard(text); };
  // On the container, as the terminal does: a drag that starts in the log may end over the composer.
  container.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || rightClickMode() !== 'copy-on-select') return;
    // After the browser has settled the selection this mouseup ends.
    setTimeout(() => copy(selectedText()), 0);
  });
  container.addEventListener('contextmenu', (e) => {
    const mode = rightClickMode();
    if (mode === 'copy-paste') {
      e.preventDefault();
      const text = selectedText();
      // A whitespace-only selection counts as none, so the click pastes rather than doing nothing.
      if (text && text.trim()) {
        copy(text);
        const sel = window.getSelection && window.getSelection();
        if (sel && log.contains(sel.anchorNode)) sel.removeAllRanges();
      } else {
        pasteIntoInput();
      }
      return;
    }
    // In copy-on-select the selection was copied when it was made, so the right button only pastes.
    if (mode === 'paste' || mode === 'copy-on-select') { e.preventDefault(); pasteIntoInput(); }
  });

  const draggingFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
  container.addEventListener('dragover', (e) => {
    if (!draggingFiles(e) || view.exited) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('drop', (e) => {
    if (!draggingFiles(e) || view.exited) return;
    e.preventDefault();
    e.stopPropagation();
    const files = [...(e.dataTransfer.files || [])];
    if (files.length && !files.some(f => f && typeof f.type === 'string' && f.type.startsWith('image/'))) {
      notice('error', 'Only images can be dropped into the conversation.');
      return;
    }
    attachImages(files);
  });

  function renderStatus() {
    renderComposer();
    statusText.replaceChildren();
    const add = (node) => {
      if (statusText.childNodes.length) {
        const sep = document.createElement('span');
        sep.className = 'conversation-status-sep';
        sep.textContent = '·';
        statusText.appendChild(sep);
      }
      statusText.appendChild(node);
    };
    const span = (text, className) => {
      const s = document.createElement('span');
      if (className) s.className = className;
      s.textContent = text;
      return s;
    };
    // The permission mode first (#696), as the TUI's status line shows it; a click switches to the next one,
    // as Shift+Tab in the input does. Only where the backend has modes and one has been named.
    if (view.mode && view.mode.label) {
      const m = document.createElement('button');
      m.type = 'button';
      m.className = 'conversation-mode' + (view.mode.tone ? ` conversation-mode-${view.mode.tone}` : '');
      m.textContent = [view.mode.symbol, view.mode.label].filter(Boolean).join(' ');
      m.disabled = !view.canSwitchMode || !!view.exited;
      m.title = view.canSwitchMode ? 'Permission mode of this session — click or Shift+Tab to switch' : 'Permission mode of this session';
      // The line is rebuilt with the new mode, which takes the clicked button away — the caret goes back to the
      // input rather than to nowhere.
      m.addEventListener('click', () => { input.focus(); cycleMode(); });
      add(m);
    }
    // The context fill and the model (#691), as the backend read them. Warm once the fill reaches the handoff
    // threshold the sidebar's health badge uses (spec 28), so the two never disagree about "getting full".
    const c = view.context;
    if (c && Number.isFinite(c.percent)) {
      const ctxEl = span('', 'conversation-ctx');
      const meter = document.createElement('span');
      meter.className = 'conversation-ctx-meter';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(100, c.percent))}%`;
      meter.appendChild(fill);
      ctxEl.appendChild(meter);
      ctxEl.appendChild(document.createTextNode(`ctx ${Math.round(c.percent)} %`));
      const threshold = typeof sessionHealthOptions === 'function' ? Number(sessionHealthOptions().handoffPercent) || 80 : 80;
      ctxEl.classList.toggle('hot', c.percent >= threshold);
      // Where this figure can differ from the sidebar's, said where the two are compared (#697): the line asks the
      // session, the sidebar reads the last model reply in the transcript.
      const why = 'Asked from the running session. The sidebar reads the last reply in the transcript, so it shows nothing before the first turn and the size from before a compaction until the next reply.';
      ctxEl.title = Number.isFinite(c.tokens) && Number.isFinite(c.window)
        ? `${c.tokens.toLocaleString()} of ${c.window.toLocaleString()} tokens\n${why}`
        : why;
      add(ctxEl);
    }
    if (c && (c.model || Number.isFinite(c.window))) {
      add(span([c.model, Number.isFinite(c.window) ? `(${formatWindow(c.window)})` : ''].filter(Boolean).join(' ')));
    }
    const state = view.exited ? 'Session ended.'
      // A session held by a question is waiting on the reader, not working — the same line the inbox draws.
      : view.asks.size ? 'Waiting for your answer'
        : view.busy ? 'Working…'
          // A runtime may take a while to start reading (#647) — main waits that out rather than failing, and
          // this is what the user sees meanwhile instead of an empty conversation that looks finished.
          : view.attaching ? 'Waiting for the session…' : '';
    if (state) {
      const s = span(state, 'conversation-status-state');
      if (view.busy && !view.exited && !view.asks.size && view.busySince) s.appendChild(elapsedEl(view.busySince));
      add(s);
    }
    const waiting = view.queue.steering.length + view.queue.followUp.length;
    if (waiting) add(span(`${waiting} message${waiting === 1 ? '' : 's'} waiting`));
    status.classList.toggle('busy', !!view.busy && !view.exited);
    renderBackground();
    tick();
  }

  // --- Elapsed times (#691) ---
  // One timer for the view, running only while something on it counts up and the view is on screen.
  const formatElapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  };
  const formatWindow = (n) => (n >= 1000000 ? `${Math.round(n / 100000) / 10}M`.replace('.0M', 'M') : `${Math.round(n / 1000)}k`);
  function elapsedEl(since) {
    const e = document.createElement('span');
    e.className = 'conversation-elapsed';
    e.dataset.since = String(since);
    e.textContent = ` ${formatElapsed(Date.now() - since)}`;
    return e;
  }
  let ticker = null;
  function tick() {
    const counting = container.querySelectorAll('.conversation-elapsed[data-since]');
    for (const e of counting) e.textContent = ` ${formatElapsed(Date.now() - Number(e.dataset.since))}`;
    // Only while the view is on screen: a hidden tab has no height, and it is picked up again by `focus()`,
    // which every path that shows the view calls.
    const needed = counting.length > 0 && log.clientHeight > 0 && container.isConnected && !view.exited;
    if (needed && !ticker) ticker = setInterval(tick, 1000);
    if (!needed && ticker) { clearInterval(ticker); ticker = null; }
  }

  // --- Background tasks (#691) ---
  // The buttons count what the backend listed; a click opens the list, with Output / Open and Stop per task.
  const KIND_WORDS = { shell: ['shell', 'shells'], agent: ['agent', 'agents'], task: ['task', 'tasks'] };
  let bgSelected = 0;
  let bgOutputFor = null;   // the task whose output is shown under its row
  function renderBackground() {
    bgChips.replaceChildren();
    const tasks = view.exited ? [] : view.tasks;
    for (const kind of ['shell', 'agent', 'task']) {
      const n = tasks.filter(t => (KIND_WORDS[t.kind] ? t.kind : 'task') === kind).length;
      if (!n) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `conversation-bg-chip conversation-bg-${kind}`;
      chip.classList.toggle('on', !bgPop.hidden);
      chip.title = 'Show what runs in the background';
      const dot = document.createElement('span');
      dot.className = 'conversation-bg-dot';
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(`${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`));
      chip.addEventListener('click', () => toggleBackground());
      bgChips.appendChild(chip);
    }
    if (!tasks.length && !bgPop.hidden) closeBackground();
    if (!bgPop.hidden) renderBackgroundList();
  }
  function toggleBackground() {
    if (bgPop.hidden) openBackground(); else closeBackground();
  }
  function openBackground() {
    if (!view.tasks.length) return;
    bgPop.hidden = false;
    bgSelected = Math.min(bgSelected, view.tasks.length - 1);
    renderBackground();
    bgPop.focus();
  }
  function closeBackground() {
    bgPop.hidden = true;
    bgOutputFor = null;
    for (const chip of bgChips.children) chip.classList.remove('on');
    if (container.contains(document.activeElement) || document.activeElement === document.body) input.focus();
  }
  function renderBackgroundList() {
    bgPop.replaceChildren();
    const head = document.createElement('div');
    head.className = 'conversation-bg-head';
    const title = document.createElement('span');
    title.textContent = 'Background';
    const count = document.createElement('span');
    count.className = 'conversation-bg-count';
    count.textContent = [...bgChips.children].map(c => c.textContent).join(' · ');
    head.appendChild(title);
    head.appendChild(count);
    bgPop.appendChild(head);
    const groups = [['shell', 'Shells'], ['agent', 'Agents'], ['task', 'Other tasks']];
    let index = 0;
    for (const [kind, label] of groups) {
      const list = view.tasks.filter(t => (KIND_WORDS[t.kind] ? t.kind : 'task') === kind);
      if (!list.length) continue;
      const sec = document.createElement('div');
      sec.className = 'conversation-bg-section';
      sec.textContent = label;
      bgPop.appendChild(sec);
      for (const t of list) {
        const i = index++;
        const row = document.createElement('div');
        row.className = `conversation-bg-row conversation-bg-${kind}`;
        row.classList.toggle('sel', i === bgSelected);
        row.dataset.index = String(i);
        const dot = document.createElement('span');
        dot.className = 'conversation-bg-dot';
        const text = document.createElement('div');
        text.className = 'conversation-bg-text';
        const name = document.createElement('div');
        name.textContent = t.description || t.detail || t.id;
        const sub = document.createElement('div');
        sub.className = 'conversation-bg-detail';
        sub.textContent = t.detail && t.detail !== t.description ? t.detail : '';
        text.appendChild(name);
        text.appendChild(sub);
        const time = document.createElement('span');
        time.className = 'conversation-bg-time';
        if (t.startedAt) time.appendChild(elapsedEl(t.startedAt));
        const acts = document.createElement('span');
        acts.className = 'conversation-bg-acts';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'new-session-secondary-btn conversation-bg-btn';
        open.textContent = kind === 'agent' ? 'Open' : 'Output';
        open.title = kind === 'agent' ? 'Open this agent\'s transcript' : 'Show the end of this task\'s output';
        open.addEventListener('click', () => { bgSelected = i; openTask(t); });
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'new-session-secondary-btn conversation-bg-btn conversation-bg-stop';
        stopBtn.textContent = 'Stop';
        stopBtn.title = 'Stop this task; the others keep running';
        stopBtn.addEventListener('click', () => { bgSelected = i; stopTask(t); });
        acts.appendChild(open);
        acts.appendChild(stopBtn);
        row.appendChild(dot);
        row.appendChild(text);
        row.appendChild(time);
        row.appendChild(acts);
        row.addEventListener('click', (e) => { if (e.target.closest('button')) return; bgSelected = i; renderBackgroundList(); });
        bgPop.appendChild(row);
        if (bgOutputFor && bgOutputFor.id === t.id) {
          const pre = document.createElement('pre');
          pre.className = 'conversation-tool-output conversation-bg-output';
          pre.textContent = bgOutputFor.text;
          bgPop.appendChild(pre);
        }
      }
    }
    const foot = document.createElement('div');
    foot.className = 'conversation-bg-foot';
    foot.textContent = '↑/↓ select · Enter open · X stop · Esc close';
    bgPop.appendChild(foot);
  }
  // The sidebar row of the subagent a task names (#695): a row of this session whose `agentId` is the id the
  // backend stamped on the task. The backend answers which subagent it is; this only looks the row up.
  function subagentRowFor(subagentId) {
    if (!subagentId || typeof sessionMap === 'undefined') return null;
    const parent = view.session.sessionId;
    for (const s of sessionMap.values()) {
      if (s && s.parentSessionId === parent && s.agentId === subagentId) return s;
    }
    return null;
  }
  // An agent opens where a click on its subagent row opens it: its own transcript, tailed while it runs. Until
  // the scan has seen that row, the call that started the agent is the next best place, and the view says so.
  function openAgent(subagentId, toolUseId) {
    const row = subagentRowFor(subagentId);
    if (row && typeof showSubagentTranscript === 'function') {
      closeBackground();
      showSubagentTranscript(row);
      return;
    }
    const el = toolUseId ? log.querySelector(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`) : null;
    if (!el) { notice('info', 'This agent\'s transcript is not listed yet, and the call that started it is not in the conversation on screen.'); return; }
    closeBackground();
    el.scrollIntoView({ block: 'center' });
    el.classList.add('conversation-flash');
    setTimeout(() => el.classList.remove('conversation-flash'), 1200);
    notice('info', 'This agent\'s transcript is not listed yet — showing the call that started it instead.');
  }
  async function openTask(t) {
    if (t.kind === 'agent') { openAgent(t.subagentId, t.toolUseId); return; }
    if (bgOutputFor && bgOutputFor.id === t.id) { bgOutputFor = null; renderBackgroundList(); return; }
    let res;
    try { res = await window.api.agent.taskOutput(view.session.sessionId, t.id); } catch { res = null; }
    if (!res || !res.ok) { notice('error', (res && res.error) || 'The output could not be read.'); return; }
    const text = String(res.text || '').replace(/\s+$/, '');
    bgOutputFor = { id: t.id, text: (res.truncated ? '…\n' : '') + (text || '(no output yet)') };
    renderBackgroundList();
  }
  // One press, one switch: a second press while the first is still out is dropped rather than queued, so a
  // quick double press cannot land on a mode the user never saw.
  let modeSwitching = false;
  async function cycleMode() {
    if (modeSwitching || !view.canSwitchMode || view.exited) return;
    modeSwitching = true;
    let res;
    try { res = await window.api.agent.cycleMode(view.session.sessionId); } catch { res = null; } finally { modeSwitching = false; }
    if (!res || !res.ok) { notice('warning', (res && res.error) || 'The permission mode did not change.'); return; }
    if (res.mode) { view.mode = res.mode; renderStatus(); }
  }
  async function stopTask(t) {
    let res;
    try { res = await window.api.agent.stopTask(view.session.sessionId, t.id); } catch { res = null; }
    if (!res || !res.ok) notice('error', (res && res.error) || 'The task did not stop.');
  }
  bgPop.addEventListener('keydown', (e) => {
    const n = view.tasks.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBackground(); return; }
    if (!n) return;
    const ordered = [...bgPop.querySelectorAll('.conversation-bg-row')].map(r => Number(r.dataset.index));
    const tasksInOrder = ['shell', 'agent', 'task'].flatMap(k => view.tasks.filter(t => (KIND_WORDS[t.kind] ? t.kind : 'task') === k));
    if (e.key === 'ArrowDown') { e.preventDefault(); bgSelected = Math.min(ordered.length - 1, bgSelected + 1); renderBackgroundList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bgSelected = Math.max(0, bgSelected - 1); renderBackgroundList(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (tasksInOrder[bgSelected]) openTask(tasksInOrder[bgSelected]); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); if (tasksInOrder[bgSelected]) stopTask(tasksInOrder[bgSelected]); }
  });
  // A click anywhere else closes the list, as a menu does.
  container.addEventListener('mousedown', (e) => {
    if (bgPop.hidden || bgPop.contains(e.target) || bgChips.contains(e.target)) return;
    closeBackground();
  });
  // The Output button on a task's notice in the conversation (#691), drawn by jsonl-viewer.js.
  log.addEventListener('click', (e) => {
    // …and the Open button on an agent's notice (#695), the same way the Background list opens one.
    const openBtn = e.target.closest('.task-notice-open');
    if (openBtn && openBtn.dataset.subagentId) { openAgent(openBtn.dataset.subagentId, openBtn.dataset.toolUseId || ''); return; }
    const btn = e.target.closest('.task-notice-output');
    if (!btn || !btn.dataset.taskId) return;
    showNoticeOutput(btn);
  });
  async function showNoticeOutput(btn) {
    const card = btn.closest('.task-notice');
    const shown = card && card.nextElementSibling && card.nextElementSibling.classList.contains('task-notice-text') ? card.nextElementSibling : null;
    if (shown) { shown.remove(); return; }
    let res;
    try { res = await window.api.agent.taskOutput(view.session.sessionId, btn.dataset.taskId); } catch { res = null; }
    if (!res || !res.ok) { notice('error', (res && res.error) || 'The output could not be read.'); return; }
    const pre = document.createElement('pre');
    pre.className = 'conversation-tool-output task-notice-text';
    pre.textContent = (res.truncated ? '…\n' : '') + (String(res.text || '').replace(/\s+$/, '') || '(no output)');
    card.after(pre);
  }

  // `links` are pages to open — a login page is several hundred characters of query string, so it is a button
  // that hands the address to the OS browser rather than text to copy. Only http(s): main refuses anything else.
  //
  // `files` are files the app itself produced for this session (#643, `/export`). A separate field rather
  // than a `links` entry with a `file:` address, because the two go to different places for different
  // reasons: a page is handed to the OS browser, a file to the OS default application, and main guards
  // the second against sensitive paths. Neither field says which backend asked.
  function notice(level, text, links, files) {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry conversation-notice conversation-notice-' + (level || 'info');
    const line = document.createElement('div');
    line.textContent = String(text || '');
    div.appendChild(line);
    const pages = Array.isArray(links) ? links.filter(l => l && /^https?:\/\//i.test(String(l.url || ''))) : [];
    const docs = Array.isArray(files) ? files.filter(f => f && String(f.path || '')) : [];
    if (pages.length || docs.length) {
      const actions = document.createElement('div');
      actions.className = 'conversation-ask-actions';
      for (const l of pages) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'new-session-secondary-btn';
        b.textContent = String(l.label || 'Open the page');
        try { b.title = new URL(String(l.url)).host; } catch { /* the label says enough */ }
        b.addEventListener('click', () => { window.api.openExternal(String(l.url)); });
        actions.appendChild(b);
      }
      for (const f of docs) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'new-session-secondary-btn';
        b.textContent = String(f.label || 'Open the file');
        b.title = String(f.path);
        b.addEventListener('click', () => { window.api.openPath(String(f.path)); });
        actions.appendChild(b);
      }
      div.appendChild(actions);
    }
    log.insertBefore(div, partialEl);
  }

  // A question an extension is waiting on. The session stays blocked until it is answered, so it is drawn in
  // the conversation, where the user is looking, and cannot be dismissed by a stray click.
  function findToolUse(id) {
    if (!id) return null;
    const lists = [view.entries, view.partial ? [view.partial] : []];
    for (const list of lists) {
      for (const entry of list) {
        const blocks = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
        for (const b of blocks) if (b && b.type === 'tool_use' && b.id === id) return b;
      }
    }
    return null;
  }

  // A card that holds a tool call marks it, so the activity line says the call waits on the user rather than
  // that it runs. The approval card did this from the start; the questions and plan cards (#661) are the
  // call itself and did not, so a turn waiting on one read "Running …" (#666).
  function holdCall(request) {
    if (request.toolCallId) view.approvals.set(request.toolCallId, { id: request.id, kind: request.kind });
  }

  // The session's own extension asking before a tool that changes something runs (step C of #568). Drawn
  // with the call it is about — the command, the diff, the content — through the viewer's own tool
  // renderer, because "allow bash?" without the command is not a question anybody can answer.
  function renderApproval(request) {
    const card = document.createElement('div');
    card.className = 'jsonl-entry conversation-ask conversation-approval';
    const title = document.createElement('div');
    title.className = 'conversation-ask-title';
    // A command the user ran asks for itself; everything else is the agent's own call.
    title.textContent = request.requestedBy
      ? `Your command ${request.requestedBy} wants to run a shell line`
      : `The agent wants to run ${request.tool}`;
    card.appendChild(title);
    const block = findToolUse(request.toolCallId);
    if (block && typeof renderToolUse === 'function') {
      try {
        const shown = renderToolUse(block);
        if (shown) { shown.classList.add('conversation-approval-call'); card.appendChild(shown); }
      } catch { /* the question still stands without its picture */ }
    }
    // What the call allows that its input does not show, when the backend could say — plain text, drawn as
    // the ask's own message line.
    if (request.message) {
      const detail = document.createElement('div');
      detail.className = 'conversation-ask-message';
      detail.textContent = request.message;
      card.appendChild(detail);
    }
    // WHO is asking, and what the question is worth, is the backend's to say: one runtime's approvals are an
    // extension of this app's (a convenience, not a boundary), another's are the CLI's own permission rules.
    if (request.note) {
      const note = document.createElement('div');
      note.className = 'conversation-ask-message conversation-approval-note';
      note.textContent = String(request.note);
      card.appendChild(note);
    }
    const actions = document.createElement('div');
    actions.className = 'conversation-ask-actions';
    const answers = request.answers || {};
    const answer = (value) => {
      for (const b of card.querySelectorAll('button')) b.disabled = true;
      window.api.agent.answer(view.session.sessionId, request.id, { value }).then((res) => {
        if (!res || !res.ok) {
          for (const b of card.querySelectorAll('button')) b.disabled = false;
          notice('error', (res && res.error) || 'The answer did not reach the session.');
        }
      });
    };
    // "For this session" says what it allows when the backend can say it (a mode switch reaches every later
    // call, not only this one); the plain words otherwise.
    const sessionText = typeof request.sessionLabel === 'string' && request.sessionLabel ? request.sessionLabel : 'Allow for this session';
    // A lasting allow (#674) names what it allows, and its tooltip says where the rule lands and how it is
    // taken back — both the backend's words, since the rule is the CLI's.
    const projectText = typeof request.projectLabel === 'string' && request.projectLabel ? request.projectLabel : 'Always allow in this project';
    const titles = { project: typeof request.projectNote === 'string' ? request.projectNote : '' };
    for (const [key, label, primary] of [['once', 'Allow once', true], ['session', sessionText], ['project', projectText], ['refuse', 'Refuse']]) {
      if (!answers[key]) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-session-secondary-btn' + (primary ? ' conversation-ask-primary' : '');
      b.textContent = label;
      if (titles[key]) b.title = titles[key];
      b.addEventListener('click', () => answer(answers[key]));
      actions.appendChild(b);
    }
    card.appendChild(actions);
    view.asks.set(request.id, card);
    holdCall(request);
    log.insertBefore(card, partialEl);
    renderActivity();
  }

  // Sends one answer for a card and locks it until the answer is taken; a refused send unlocks it again, and
  // `unlocked` lets the card put back any control that has a condition of its own.
  function sendAnswer(card, request, payload, unlocked) {
    const controls = () => card.querySelectorAll('button, textarea, input');
    for (const c of controls()) c.disabled = true;
    window.api.agent.answer(view.session.sessionId, request.id, payload).then((res) => {
      if (!res || !res.ok) {
        for (const c of controls()) c.disabled = false;
        if (typeof unlocked === 'function') unlocked();
        notice('error', (res && res.error) || 'The answer did not reach the session.');
      }
    });
  }

  // The agent asking the user one or more questions at once (#661). Each question offers its options — one
  // of them, or several where it says so — and a free answer of the user's own; one Answer sends them all,
  // because the backend takes them as a single reply. What an answer becomes on the wire is the backend's.
  function renderQuestions(request) {
    const card = document.createElement('div');
    card.className = 'jsonl-entry conversation-ask conversation-questions';
    const title = document.createElement('div');
    title.className = 'conversation-ask-title';
    title.textContent = request.questions.length > 1 ? 'The agent is asking you some questions' : 'The agent is asking you a question';
    card.appendChild(title);
    const readers = [];
    const submit = document.createElement('button');
    // Answer waits until every question has one — the CLI takes them as a single reply.
    const refresh = () => { submit.disabled = !readers.every(r => r.value()); };
    request.questions.forEach((q, qi) => {
      const block = document.createElement('div');
      block.className = 'conversation-question';
      const head = document.createElement('div');
      head.className = 'conversation-question-text';
      if (q.header) {
        const chip = document.createElement('span');
        chip.className = 'conversation-question-header';
        chip.textContent = q.header;
        head.appendChild(chip);
      }
      head.appendChild(document.createTextNode(q.question));
      block.appendChild(head);
      const type = q.multiSelect ? 'checkbox' : 'radio';
      const name = `q-${request.id}-${qi}`;
      const choices = [];
      const addChoice = (labelText, description) => {
        const row = document.createElement('label');
        row.className = 'conversation-question-option';
        const box = document.createElement('input');
        box.type = type;
        box.name = name;
        box.addEventListener('change', refresh);
        row.appendChild(box);
        const text = document.createElement('span');
        text.className = 'conversation-question-label';
        text.textContent = labelText;
        row.appendChild(text);
        if (description) {
          const desc = document.createElement('span');
          desc.className = 'conversation-question-desc';
          desc.textContent = description;
          row.appendChild(desc);
        }
        block.appendChild(row);
        return box;
      };
      for (const opt of q.options) choices.push({ box: addChoice(opt.label, opt.description), label: opt.label });
      const otherBox = addChoice('Other');
      const other = document.createElement('input');
      other.type = 'text';
      other.className = 'conversation-ask-input conversation-question-other';
      other.placeholder = 'Your own answer';
      other.addEventListener('input', () => { if (other.value.trim()) otherBox.checked = true; refresh(); });
      block.appendChild(other);
      card.appendChild(block);
      // What this question's answer is right now, or '' — several choices joined the way the CLI reads them.
      const value = () => {
        const picked = choices.filter(c => c.box.checked).map(c => c.label);
        if (otherBox.checked && other.value.trim()) picked.push(other.value.trim());
        return picked.join(', ');
      };
      readers.push({ question: q.question, value });
    });
    const actions = document.createElement('div');
    actions.className = 'conversation-ask-actions';
    submit.type = 'button';
    submit.className = 'new-session-secondary-btn conversation-ask-primary';
    submit.textContent = 'Answer';
    submit.disabled = true;
    submit.addEventListener('click', () => {
      const answers = {};
      for (const r of readers) answers[r.question] = r.value();
      sendAnswer(card, request, { answers }, refresh);
    });
    actions.appendChild(submit);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'new-session-secondary-btn';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => sendAnswer(card, request, { cancelled: true }, refresh));
    actions.appendChild(dismiss);
    card.appendChild(actions);
    view.asks.set(request.id, card);
    holdCall(request);
    log.insertBefore(card, partialEl);
    renderActivity();
  }

  // The agent's plan, put to the user before it leaves plan mode (#661). Drawn as the markdown it is, through
  // the history viewer's own sanitized renderer; approving lets it start, keeping it planning ends the turn.
  function renderPlan(request) {
    const card = document.createElement('div');
    card.className = 'jsonl-entry conversation-ask conversation-plan';
    const title = document.createElement('div');
    title.className = 'conversation-ask-title';
    title.textContent = 'The agent has a plan';
    card.appendChild(title);
    const body = document.createElement('div');
    body.className = 'conversation-plan-body';
    if (typeof renderJsonlText === 'function') body.innerHTML = renderJsonlText(String(request.plan || ''));
    else body.textContent = String(request.plan || '');
    card.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'conversation-ask-actions';
    const answers = request.answers || {};
    for (const [key, label, primary] of [['approve', 'Approve', true], ['keep', 'Keep planning']]) {
      if (!answers[key]) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-session-secondary-btn' + (primary ? ' conversation-ask-primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => sendAnswer(card, request, { value: answers[key] }));
      actions.appendChild(b);
    }
    card.appendChild(actions);
    view.asks.set(request.id, card);
    holdCall(request);
    log.insertBefore(card, partialEl);
    renderActivity();
  }

  function renderAsk(request) {
    if (!request || view.asks.has(request.id)) return;
    if (request.kind === 'approval') { renderApproval(request); return; }
    if (request.kind === 'questions' && Array.isArray(request.questions) && request.questions.length) { renderQuestions(request); return; }
    if (request.kind === 'plan') { renderPlan(request); return; }
    const card = document.createElement('div');
    card.className = 'jsonl-entry conversation-ask';
    const title = document.createElement('div');
    title.className = 'conversation-ask-title';
    title.textContent = request.title || 'The agent is asking';
    card.appendChild(title);
    if (request.message) {
      const msg = document.createElement('div');
      msg.className = 'conversation-ask-message';
      msg.textContent = request.message;
      card.appendChild(msg);
    }
    const actions = document.createElement('div');
    actions.className = 'conversation-ask-actions';
    const answer = (payload) => {
      for (const b of card.querySelectorAll('button, textarea, input')) b.disabled = true;
      window.api.agent.answer(view.session.sessionId, request.id, payload).then((res) => {
        if (!res || !res.ok) {
          for (const b of card.querySelectorAll('button, textarea, input')) b.disabled = false;
          notice('error', (res && res.error) || 'The answer did not reach the session.');
        }
      });
    };
    const button = (label, payload, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-session-secondary-btn' + (primary ? ' conversation-ask-primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => answer(payload));
      actions.appendChild(b);
      return b;
    };
    if (request.method === 'select') {
      request.options.forEach((opt, i) => button(opt, { value: opt }, i === 0));
    } else if (request.method === 'confirm') {
      button('Yes', { confirmed: true }, true);
      button('No', { confirmed: false });
    } else {
      // A secret (an API key) goes in a masked one-line field: it is on screen while the user decides, and
      // somebody may be looking over their shoulder. It is never kept here — the answer goes straight out.
      const field = document.createElement(request.secret ? 'input' : 'textarea');
      field.className = 'conversation-ask-input';
      if (request.secret) {
        field.type = 'password';
        field.autocomplete = 'off';
        field.spellcheck = false;
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!field.disabled) answer({ value: field.value }); }
        });
      } else {
        field.rows = request.method === 'editor' ? 6 : 1;
      }
      field.placeholder = request.placeholder || '';
      field.value = request.prefill || '';
      card.appendChild(field);
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'new-session-secondary-btn conversation-ask-primary';
      ok.textContent = 'OK';
      ok.addEventListener('click', () => answer({ value: field.value }));
      actions.appendChild(ok);
    }
    button('Dismiss', { cancelled: true });
    card.appendChild(actions);
    view.asks.set(request.id, card);
    log.insertBefore(card, partialEl);
  }

  // Ops that arrive while an attach is in flight wait here, and only those newer than the snapshot are
  // applied after it — see `sendOp` in src/app/agent-rpc.js for the numbering.
  let pending = null;
  // The entries a snapshot read from a transcript already holds, by the key main stamped on them. The file
  // can be ahead of the pipe, so the op for one of them may still arrive after the snapshot; it is skipped
  // once and forgotten (`attachFromTranscript` in src/app/agent-rpc.js). Empty for a backend that names no
  // entries, and cleared by any replacement of the conversation.
  let snapshotKeys = new Set();

  function apply(op) {
    if (!op || typeof op !== 'object') return;
    if (pending && op.op !== 'reset') { pending.push(op); return; }
    switch (op.op) {
      case 'reset': snapshotKeys = new Set(); reset(op.entries); break;
      case 'append':
        if (op.key && snapshotKeys.delete(String(op.key))) return;
        appendEntry(op.entry);
        break;
      case 'partial': view.partial = op.entry || null; renderPartial(); break;
      case 'tool': {
        // When it started is kept across its updates, for the elapsed time on its row (#691).
        const prev = view.tools.get(op.id);
        view.tools.set(op.id, { status: op.status, output: op.output || '', startedAt: prev && prev.startedAt ? prev.startedAt : Date.now() });
        if (op.status !== 'running') view.tools.delete(op.id);
        renderActivity();
        break;
      }
      case 'busy':
        if (op.busy && !view.busy) view.busySince = Date.now();
        view.busy = !!op.busy;
        if (view.busy && view.suggestion) setSuggestion(null);
        if (!view.busy) { view.busySince = null; view.tools.clear(); renderActivity(); }
        renderStatus();
        break;
      case 'suggestion': setSuggestion(op.text); break;
      // What runs in the background, and the session's figures (#691).
      case 'tasks': view.tasks = Array.isArray(op.tasks) ? op.tasks : []; renderStatus(); break;
      case 'context': view.context = op.context || null; renderStatus(); break;
      case 'mode': view.mode = op.mode || null; renderStatus(); break;
      case 'queue': view.queue = { steering: op.steering || [], followUp: op.followUp || [] }; renderStatus(); break;
      case 'held': view.heldPrompts = { items: Array.isArray(op.items) ? op.items : [], paused: !!op.paused }; renderHeld(); break;
      case 'held-back': {
        // The session ended with prompts still held (#702): each back into the input, images included.
        const items = Array.isArray(op.items) ? op.items : [];
        for (const item of items) takeBackHeld(item.text || '', item.images || []);
        if (items.length) notice('info', `The session ended before ${items.length === 1 ? 'a queued prompt was' : `${items.length} queued prompts were`} sent. ${items.length === 1 ? 'It is' : 'They are'} back in the input.`);
        break;
      }
      case 'notice': notice(op.level, op.text, op.links, op.files); break;
      case 'localCommand': localCommand(op); break;
      case 'unsent': unsent(op.text); break;
      case 'draft': draft(op.text); break;
      case 'branchTree': openBranchTree(op); break;
      case 'ask': renderAsk(op.request); renderStatus(); break;
      case 'answered': {
        const card = view.asks.get(op.id);
        if (card) { card.remove(); view.asks.delete(op.id); }
        for (const [callId, held] of view.approvals) if (held.id === op.id) view.approvals.delete(callId);
        renderActivity();
        renderStatus();
        settleAttentionCaption();
        break;
      }
      default: return;
    }
    follow();
    renderJump();
  }

  // A turn written into the session from outside the composer — a seed prompt, a trigger, a launcher — that
  // the runtime refused (#648). It is handed back as something still unsent: into the input when that is
  // empty, so one press sends it, and otherwise quoted in the notice, because what the user is typing is
  // theirs and is not overwritten.
  function unsent(text) {
    const body = String(text || '');
    if (!body.trim() || view.exited) return;
    if (!input.disabled && !input.value.trim()) {
      input.value = body;
      renderComposer();
      notice('error', 'The session did not take this message. It is back in the input, unsent.');
      return;
    }
    notice('error', 'The session did not take this message, and it was not sent:\n' + body);
  }

  // A message handed back to be rewritten (#646): the user picked one of their own messages in the branch
  // tree, and the session now stands on the point before it. Into the input when that is empty; otherwise
  // quoted, because what the user is typing is theirs and is not overwritten — the same rule as `unsent`.
  function draft(text) {
    const body = String(text || '');
    if (!body.trim() || view.exited) return;
    if (!input.disabled && !input.value.trim()) {
      input.value = body;
      renderComposer();
      input.focus();
      return;
    }
    notice('info', 'The message you picked, to rewrite (the input was not empty, so it was not put there):\n' + body);
  }

  // The session's branch tree (#646). The rows are the backend's; the move is asked of main, and what it
  // did arrives as ops — a `reset` of the conversation and a notice — so nothing here waits on it.
  function openBranchTree(op) {
    if (view.exited || typeof showBranchTreeDialog !== 'function') return;
    showBranchTreeDialog({
      rows: op.rows || [],
      truncated: !!op.truncated,
      onSwitch: async (target, summarize) => {
        let res;
        try { res = await window.api.agent.navigate(view.session.sessionId, target, { summarize }); } catch { res = null; }
        if (!res || !res.ok) notice('error', (res && res.error) || 'The session did not switch.');
      },
    });
  }

  // The conversation so far comes from the running session itself — the transcript is the truth, and
  // there is no second log in this window to fall out of step with it.
  async function attach() {
    pending = [];
    view.attaching = true;
    renderStatus();
    let res;
    try { res = await window.api.agent.attach(view.session.sessionId); } catch { res = null; }
    const held = pending;
    pending = null;
    view.attaching = false;
    renderStatus();
    if (!res || !res.ok) {
      for (const op of held) apply(op);
      if (!view.exited) notice('error', (res && res.error) || 'The conversation could not be loaded.');
      return;
    }
    view.attached = true;
    apply({ op: 'reset', entries: res.entries || [] });
    snapshotKeys = new Set(Array.isArray(res.keys) ? res.keys.map(String) : []);
    view.partial = res.partial || null;
    renderPartial();
    view.busy = !!res.busy;
    view.queue = res.queue || { steering: [], followUp: [] };
    view.heldPrompts = res.held && Array.isArray(res.held.items) ? { items: res.held.items, paused: !!res.held.paused } : { items: [], paused: false };
    renderHeld();
    view.tasks = Array.isArray(res.tasks) ? res.tasks : [];
    view.context = res.context || null;
    view.mode = res.mode || null;
    view.canSwitchMode = !!res.canSwitchMode;
    setSuggestion(res.suggestion || null);
    for (const request of res.asks || []) renderAsk(request);
    renderStatus();
    toEnd();
    // What happened after the snapshot was taken, in order. Older ops are already in it.
    const since = Number(res.seq) || 0;
    // An `unsent` hand-back is never part of a snapshot, so its number decides nothing: a refusal that
    // arrived before the runtime answered the attach would otherwise be taken for "already in it" (#648).
    for (const op of held) if (op.op === 'unsent' || !(Number(op.seq) <= since)) apply(op);
  }

  function markExited(exitCode) {
    view.exited = true;
    view.busy = false;
    view.tools.clear();
    // A background task does not outlive the process that ran it (#691).
    view.tasks = [];
    if (!bgPop.hidden) closeBackground();
    // Nothing sent is played back by a process that has ended (#694), and no suggestion is taken (#693).
    for (const p of view.pendingSends.slice()) dropPendingSend(p);
    setSuggestion(null);
    // A shell line running when the session died can never report back, so it stops counting as running.
    // The disabled composer hides Stop anyway today; this is so that stays true if that gate is ever
    // relaxed, rather than leaving `somethingRunning()` permanently true for a dead session.
    view.localCommands.clear();
    renderActivity();
    for (const card of view.asks.values()) card.remove();
    view.asks.clear();
    view.approvals.clear();
    notice(exitCode ? 'error' : 'info', exitCode ? `The session ended (exit code ${exitCode}).` : 'The session ended.');
    renderStatus();
    follow();
    renderJump();
  }

  renderStatus();
  return {
    apply, attach, markExited, insertText,
    // Called from outside `apply` too (a launch error, `writeEntryError`), so it follows the end the same way.
    notice: (...args) => { notice(...args); follow(); renderJump(); },
    element: container, log, paletteAnchor,
    // Every path that shows this view calls it (showSession, focusGridCard, the panes' applyPendingFocus), and
    // a reveal can drop the log's scroll position without a resize or a scroll event — measured: re-showing
    // the active tab put it back at 0. So the place is put back here too (#689).
    focus: () => { if (!input.disabled) input.focus(); restore(); renderJump(); tick(); },
    dispose: () => {},
  };
}

/**
 * The openSessions entry for a session with no terminal. Same keys the rest of the renderer reads —
 * `terminal`, `fitAddon`, `searchAddon` are null, which is what every xterm-assuming site checks — plus
 * `conversation`, the view above.
 */
function createConversationEntry(session) {
  const container = document.createElement('div');
  container.className = 'terminal-container conversation-container';
  // The same background a terminal gets: in panes mode several containers stack in one pane, and one
  // without a background would show the terminal under it through its gaps.
  if (typeof TERMINAL_THEME !== 'undefined' && TERMINAL_THEME) container.style.backgroundColor = TERMINAL_THEME.background;
  terminalsEl.appendChild(container);
  let entry = null;
  const conversation = createConversationView(() => (entry ? entry.session : session), container);
  entry = {
    terminal: null, element: container, fitAddon: null, searchAddon: null,
    openSearchBar: () => {}, closeSearchBar: () => {},
    session, closed: false, webglAddon: null,
    conversation,
  };
  openSessions.set(session.sessionId, entry);
  if (typeof lruTouch === 'function') lruTouch(session.sessionId);
  if (typeof renderDefaultStatus === 'function') renderDefaultStatus();
  return entry;
}

// Does this session run without a terminal? Asked of the descriptor the renderer already caches — the same
// lookup `pageKeyTarget` and `newlineKeySequence` go through — so no backend is named here.
function sessionHasNoTerminal(session) {
  const id = typeof sessionBackendId === 'function' ? sessionBackendId(session) : '';
  const backend = id && typeof getBackend === 'function' ? getBackend(id) : null;
  return !!(backend && backend.transport);
}

// Where a stream of ops lands: the view of the session they belong to, if this window holds one.
if (window.api && typeof window.api.onAgentEvent === 'function') {
  window.api.onAgentEvent((sessionId, op) => {
    const entry = openSessions.get(sessionId);
    if (entry && entry.conversation) entry.conversation.apply(op);
    // The activity clock every other session gets from its terminal bytes (`trackActivity`).
    if (typeof lastActivityTime !== 'undefined') lastActivityTime.set(sessionId, new Date());
  });
}
