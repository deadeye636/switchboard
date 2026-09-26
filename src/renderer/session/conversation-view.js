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
// read when a view is built), and showBranchTreeDialog (session/branch-tree-dialog.js, #646).

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
  log.appendChild(partialEl);
  log.appendChild(activity);

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

  container.appendChild(log);
  container.appendChild(composer);
  container.appendChild(status);

  const view = {
    get session() { return getSession(); },
    container,
    entries: [],
    elements: [],            // parallel to entries; null where an entry draws nothing
    partial: null,
    tools: new Map(),        // tool call id -> { status, output }
    asks: new Map(),         // request id -> card element
    approvals: new Map(),    // tool call id -> request id, while an approval for that call is open
    busy: false,
    queue: { steering: [], followUp: [] },
    // Shell lines still running: the runtime's id -> { index, command }. See `localCommand`.
    localCommands: new Map(),
    exited: false,
    attached: false,
    attaching: false,        // an attach is in flight — see renderStatus
  };

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < CONVERSATION_STICK_PX;
  const follow = (wasAtBottom) => { if (wasAtBottom) log.scrollTop = log.scrollHeight; };

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

  function appendEntry(entry) {
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
      // A call held by an approval question is not running yet, whatever the protocol says (spec 30).
      head.textContent = view.approvals.has(id)
        ? `Waiting for your approval to run ${conversationToolName(view, id)}`
        : `Running ${conversationToolName(view, id)}…`;
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
  }

  // Enter and Send always ask for a plain turn. Whether it has to wait for a running one is decided in the
  // main process against the session's own busy state, which this window only hears about one op later — a
  // mode chosen here from that echo could queue a message behind a run that has already ended.

  let sending = false;
  // A send asked for while one is in flight (a skill picked mid-send) runs when that one is back, rather
  // than being dropped while the picker reports success.
  let submitAgain = null;
  async function submit(mode) {
    const text = input.value;
    if (!text.trim() || view.exited) return;
    if (sending) { submitAgain = mode; return; }
    // Focus goes back to the field afterwards only if it was here to begin with — in panes mode the user
    // may have moved to another pane while the send was in flight.
    const hadFocus = container.contains(document.activeElement);
    sending = true;
    renderComposer();
    let res;
    try { res = await window.api.agent.send(view.session.sessionId, { text, mode }); } catch { res = null; }
    sending = false;
    if (res && res.ok) {
      // Only what was sent is taken away — something typed while the send was in flight stays.
      if (input.value.startsWith(text)) input.value = input.value.slice(text.length).replace(/^\s+/, '');
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
    if (andSend) submit('prompt');
    return true;
  }

  function renderStatus() {
    renderComposer();
    const parts = [];
    if (view.exited) parts.push('Session ended.');
    // A session held by a question is waiting on the reader, not working — the same line the inbox draws.
    else if (view.asks.size) parts.push('Waiting for your answer');
    else if (view.busy) parts.push('Working…');
    // A runtime may take a while to start reading (#647) — main waits that out rather than failing, and this
    // is what the user sees meanwhile instead of an empty conversation that looks finished.
    else if (view.attaching) parts.push('Waiting for the session…');
    const waiting = view.queue.steering.length + view.queue.followUp.length;
    if (waiting) parts.push(`${waiting} message${waiting === 1 ? '' : 's'} waiting`);
    status.textContent = parts.join(' · ');
    status.classList.toggle('busy', !!view.busy && !view.exited);
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
    const note = document.createElement('div');
    note.className = 'conversation-ask-message conversation-approval-note';
    note.textContent = 'Asked by Switchboard inside this session. A convenience, not a security boundary: '
      + 'the same agent started outside Switchboard asks nothing.';
    card.appendChild(note);
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
    for (const [key, label, primary] of [['once', 'Allow once', true], ['session', 'Allow for this session'], ['refuse', 'Refuse']]) {
      if (!answers[key]) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-session-secondary-btn' + (primary ? ' conversation-ask-primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => answer(answers[key]));
      actions.appendChild(b);
    }
    card.appendChild(actions);
    view.asks.set(request.id, card);
    if (request.toolCallId) view.approvals.set(request.toolCallId, request.id);
    log.insertBefore(card, partialEl);
    renderActivity();
  }

  function renderAsk(request) {
    if (!request || view.asks.has(request.id)) return;
    if (request.kind === 'approval') { renderApproval(request); return; }
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
    const wasAtBottom = atBottom();
    switch (op.op) {
      case 'reset': snapshotKeys = new Set(); reset(op.entries); break;
      case 'append':
        if (op.key && snapshotKeys.delete(String(op.key))) return;
        appendEntry(op.entry);
        break;
      case 'partial': view.partial = op.entry || null; renderPartial(); break;
      case 'tool':
        view.tools.set(op.id, { status: op.status, output: op.output || '' });
        if (op.status !== 'running') view.tools.delete(op.id);
        renderActivity();
        break;
      case 'busy': view.busy = !!op.busy; if (!view.busy) { view.tools.clear(); renderActivity(); } renderStatus(); break;
      case 'queue': view.queue = { steering: op.steering || [], followUp: op.followUp || [] }; renderStatus(); break;
      case 'notice': notice(op.level, op.text, op.links, op.files); break;
      case 'localCommand': localCommand(op); break;
      case 'unsent': unsent(op.text); break;
      case 'draft': draft(op.text); break;
      case 'branchTree': openBranchTree(op); break;
      case 'ask': renderAsk(op.request); renderStatus(); break;
      case 'answered': {
        const card = view.asks.get(op.id);
        if (card) { card.remove(); view.asks.delete(op.id); }
        for (const [callId, reqId] of view.approvals) if (reqId === op.id) view.approvals.delete(callId);
        renderActivity();
        renderStatus();
        break;
      }
      default: return;
    }
    follow(wasAtBottom);
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
    for (const request of res.asks || []) renderAsk(request);
    renderStatus();
    log.scrollTop = log.scrollHeight;
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
  }

  renderStatus();
  return {
    apply, attach, markExited, notice, insertText,
    element: container, log, paletteAnchor,
    focus: () => { if (!input.disabled) input.focus(); },
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
