// session/conversation-view.js — the surface of a session that has no terminal (#568).
//
// A backend that declares `transport` is driven over a pipe (`src/app/agent-rpc.js`), so there is no PTY and
// no xterm. This file is what its tab shows instead: the conversation, drawn by the SAME functions the
// Message History viewer uses (`renderJsonlEntry` — `jsonl/jsonl-viewer.js`), so a live
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
// renderToolUse, escapeHtml (jsonl/jsonl-viewer.js, shell), openSessions (app.js), matchShortcut
// (shell/shortcuts.js), appShortcuts (shell/session-nav.js), isMac (terminal/terminal-manager.js), the
// four palette openers (terminal/*-palette.js), createComposerCompletion (session/composer-completion.js,
// read when a view is built), composerPathToken (session/composer-completion.js, #699 — how a pasted or
// dropped file is named), showBranchTreeDialog (session/branch-tree-dialog.js, #646),
// clearTerminalAttentionNotice (terminal/terminal-attention-notice.js, #666), terminalRightClickMode
// (terminal/terminal-context-menu.js, #690), and sessionHealthOptions (app.js, #691 — the handoff threshold
// the context fill turns warm at).

// How close to the bottom counts as "at the bottom" — the view follows new output only when the reader
// was already there, so scrolling up to read something is not undone by the next token.
const CONVERSATION_STICK_PX = 40;
// How far below the log's top edge the pinned prompt reaches over the text (#709): about its two lines.
const CONVERSATION_PIN_BAND_PX = 44;

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

// The tool results a conversation has so far, by the call they answer (#707): the pairs `buildToolResultMap`
// collects, kept up to date one entry at a time. Rebuilding that map over every entry for every entry drawn
// made loading a conversation quadratic — about a second of renderer time at 1280 entries, before any DOM.
const conversationBlocksOf = (entry) => {
  const blocks = entry && ((entry.message && entry.message.content) || entry.content);
  return Array.isArray(blocks) ? blocks : [];
};
function conversationNoteResults(results, entry) {
  for (const b of conversationBlocksOf(entry)) {
    if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b.content || b.output || '');
  }
}
// What one entry's draw may see: the results for its own calls and its own result blocks — the only ids
// `renderJsonlEntry` asks the map about. A fresh map each time, because the draw CLAIMS what it uses by
// deleting it.
function conversationEntryResults(results, entry) {
  const map = new Map();
  for (const b of conversationBlocksOf(entry)) {
    const id = b && (b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : null);
    if (id && results.has(id)) map.set(id, results.get(id));
  }
  return map;
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
  const defaultPlaceholder = input.placeholder;
  // The key that reaches an open question card from anywhere in the view (#704).
  const CARD_KEY = 'Alt+A';
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
  // The prompt of the turn being read (#709): over the log's top edge while the reader is away from the end
  // and that prompt has scrolled out above. A click goes back to it. See `renderPinned`.
  const pinnedBtn = document.createElement('button');
  pinnedBtn.type = 'button';
  pinnedBtn.className = 'new-session-secondary-btn conversation-pinned-prompt';
  pinnedBtn.hidden = true;
  // The text sits in a span of its own: a button lays its content out in an inner box, where a line clamp set
  // on the button itself does not reach.
  const pinnedText = document.createElement('span');
  pinnedText.className = 'conversation-pinned-prompt-text';
  pinnedBtn.appendChild(pinnedText);
  logWrap.appendChild(log);
  logWrap.appendChild(pinnedBtn);
  logWrap.appendChild(jumpBtn);

  // Where a card waiting on the user sits (#704, P1): in the input's place, as in the CLI, which puts a question
  // or an approval where the prompt was until it is answered. One at a time; the next one follows. The input
  // keeps what was typed in it, hidden, and comes back when the last card closes.
  const askDock = document.createElement('div');
  askDock.className = 'conversation-ask-dock';
  askDock.hidden = true;

  container.appendChild(logWrap);
  container.appendChild(attachStrip);
  // Ctrl/Cmd + wheel sets the font size, as it does over a terminal (#720): the one setting both follow.
  // Without the modifier the wheel scrolls as usual.
  container.addEventListener('wheel', (e) => {
    const macNow = typeof isMac !== 'undefined' && isMac;
    if (!(macNow ? e.metaKey : e.ctrlKey) || e.deltaY === 0) return;
    e.preventDefault();
    window._nudgeTerminalFontSize?.(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  container.appendChild(askDock);
  container.appendChild(composer);
  container.appendChild(status);
  container.appendChild(bgPop);

  const view = {
    get session() { return getSession(); },
    container,
    entries: [],
    elements: [],            // parallel to entries; null where an entry draws nothing
    results: new Map(),      // tool call id -> its result, over `entries` (#707)
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
  // 0 after a tab switch), and in panes mode every render re-parents the containers, which drops it too — so
  // the place is kept here and put back when the log is shown again.
  let readerTop = 0;
  // Whether the log is on screen (#723). The CLASS is asked first and decides alone when it says no: a hidden
  // container keeps its size now (`content-visibility: hidden` instead of `display: none`), and reading the
  // log's height inside it would make the browser lay out the very content it is skipping — per arriving
  // entry, while nobody can see it. `clientHeight` is still asked after that, for a container that is shown but
  // has no size yet (the restore at launch, a pane still being built).
  const shown = () => container.classList.contains('visible') && log.clientHeight > 0;
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < CONVERSATION_STICK_PX;
  const renderJump = () => { jumpBtn.hidden = stuck || !shown(); schedulePinned(); };

  // The prompts in the conversation, by entry index, kept up to date as entries arrive (#709). Which entry is
  // the user's own line is the BACKEND's answer, carried as `prompt: true` — the view reads that field and no
  // CLI's markup, so a line the CLI injected under the user's role never counts. An entry that drew nothing is
  // skipped, since the search below needs an element for every index it holds. Held, queued and still-sending
  // prompts sit outside `view.entries` and never count.
  const promptCache = { entries: null, scanned: 0, indices: [] };
  function promptIndices() {
    if (promptCache.entries !== view.entries || promptCache.scanned > view.entries.length) {
      promptCache.entries = view.entries;
      promptCache.scanned = 0;
      promptCache.indices = [];
    }
    for (let i = promptCache.scanned; i < view.entries.length; i++) {
      const e = view.entries[i];
      if (e && e.prompt === true && view.elements[i]) promptCache.indices.push(i);
    }
    promptCache.scanned = view.entries.length;
    return promptCache.indices;
  }
  let pinnedIndex = -1;
  let pinnedEntry = null;
  let pinnedFrame = 0;
  function schedulePinned() {
    if (pinnedFrame) return;
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);
    pinnedFrame = frame(() => { pinnedFrame = 0; renderPinned(); });
  }
  // Which prompt the reader is under: the last one that starts above the log's top edge. Shown only when it
  // has scrolled out entirely — a prompt still partly on screen needs no reminder — and never at the end.
  // The edge sits a band below the log's top, where the bar would lie over the text: a prompt starting in
  // that band (one the bar has just scrolled to, flush with the top) is the one being read, and on screen.
  function renderPinned() {
    let index = -1;
    if (!stuck && shown()) {
      const edge = log.getBoundingClientRect().top;
      const top = edge + CONVERSATION_PIN_BAND_PX;
      const list = promptIndices();
      let lo = 0, hi = list.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = view.elements[list[mid]];
        if (el && el.isConnected && el.getBoundingClientRect().top < top) { index = list[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      const el = index >= 0 ? view.elements[index] : null;
      if (!el || el.getBoundingClientRect().bottom > edge) index = -1;
    }
    // By the entry, not only its index: a replaced conversation (a branch switch) can put another prompt there.
    const entry = index >= 0 ? view.entries[index] : null;
    if (entry === pinnedEntry) return;
    pinnedIndex = index;
    pinnedEntry = entry;
    pinnedBtn.hidden = !entry;
    if (!entry) return;
    const text = normText(userTextOf(entry)) || '(image)';
    pinnedText.textContent = text;
    pinnedBtn.title = `Back to this prompt\n\n${text.length > 500 ? text.slice(0, 500) + '…' : text}`;
  }
  // Only the log moves: `scrollIntoView` would scroll every scrollable ancestor too, a pane or a grid card.
  pinnedBtn.addEventListener('click', () => {
    const el = pinnedIndex >= 0 ? view.elements[pinnedIndex] : null;
    if (el && el.isConnected) log.scrollTop += el.getBoundingClientRect().top - log.getBoundingClientRect().top;
  });
  // An entry just appended is laid out at its placeholder size first (`content-visibility: auto`, #723) and takes
  // its real height in a later rendering update, which moves no box the ResizeObserver watches. So a reader at
  // the end is followed once more two frames on, or a tall entry would stay cut off until the next one arrived.
  let followFrame = 0;
  const follow = () => {
    if (!(stuck && shown())) return;
    log.scrollTop = log.scrollHeight;
    if (followFrame) return;
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);
    followFrame = frame(() => frame(() => {
      followFrame = 0;
      if (stuck && shown()) log.scrollTop = log.scrollHeight;
    }));
  };
  const restore = () => {
    if (!shown()) return;
    if (stuck) log.scrollTop = log.scrollHeight;
    else if (log.scrollTop !== readerTop) log.scrollTop = readerTop;
  };
  function toEnd() {
    stuck = true;
    log.scrollTop = log.scrollHeight;
    renderJump();
  }
  log.addEventListener('scroll', () => {
    if (!shown()) return;
    stuck = atBottom();
    readerTop = log.scrollTop;
    renderJump();
  });
  // Shown again (a tab switch, a pane resize): a reader at the end is put back at the end, whatever arrived
  // while nobody could see it. A reader who had scrolled up gets the place back.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { restore(); renderJump(); tick(); }).observe(log);
  }
  // …and shown again without changing size (#723): a hidden container keeps its box now, so the observer above
  // does not fire on a tab switch. The `.visible` class is what both display modes set on show — panes, and
  // grid in its single view and on its cards.
  if (typeof MutationObserver === 'function') {
    let wasShown = container.classList.contains('visible');
    new MutationObserver(() => {
      const now = container.classList.contains('visible');
      if (now === wasShown) return;
      wasShown = now;
      if (now) { restore(); renderJump(); tick(); }
    }).observe(container, { attributes: true, attributeFilter: ['class'] });
  }
  jumpBtn.addEventListener('click', () => { toEnd(); focusView(); });

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
    // Alt+A reaches the oldest open card from anywhere in the view (#704).
    // By its code, not its character: on macOS Option+A types "å".
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyA' || e.key === 'a' || e.key === 'A')) {
      const card = openCards()[0];
      if (card && focusCard(card)) { e.preventDefault(); return; }
    }
    // Tab from the log (#716): the log takes the focus from any click into it, and the browser's next stop
    // would be the first link or button inside it — often far above what is on screen, which it scrolls into
    // view. The reader's place is kept, and the key goes where keys go in the CLI: back to the input, or to the
    // card standing in its place.
    // Only when there is somewhere to go: an ended session has no input and no card, and taking the key then
    // would leave the keyboard nowhere to move the focus.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && log.contains(e.target)) {
      const from = document.activeElement;
      focusView();
      if (document.activeElement !== from) { e.preventDefault(); return; }
    }
    if (e.target !== input && e.target !== log) return;
    if (e.target === input && completion && completion.isOpen && completion.isOpen()) return;
    if (pageKey(e)) e.preventDefault();
  });

  function renderOne(index) {
    const entry = view.entries[index];
    // A fresh map per draw: `renderJsonlEntry` CLAIMS the results it draws under a call by deleting them,
    // so a shared one would hand each result to whichever call happened to be drawn first.
    const el = renderJsonlEntry(entry, conversationEntryResults(view.results, entry));
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
    // Equal, or beginning with what was sent: slash-command markup can read as the command followed by its
    // output. A runtime that never plays a line back must send the user's entry for it itself — claude-native
    // does for a local command (its point 12, #718), or this line would wait here for good. The earliest match
    // wins, so two identical messages settle in the order they were sent.
    const played = normText(text);
    const p = view.pendingSends.find(x => played === x.text || played.startsWith(`${x.text} `));
    if (p) dropPendingSend(p);
  }

  function appendEntry(entry) {
    settlePendingSend(entry);
    const index = view.entries.push(entry) - 1;
    conversationNoteResults(view.results, entry);
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
    // A breadcrumb for a renderer stall report (shell/stall-report.js): a whole conversation is drawn here.
    window.noteRendererWork?.(`conversation-reset:${Array.isArray(entries) ? entries.length : 0}`);
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
    view.results = new Map();
    // A re-mount re-reads the conversation from the runtime, and a finished shell line is in it as an
    // ordinary entry — so nothing here may still claim an index into the list just thrown away.
    view.localCommands.clear();
    for (const entry of entries || []) appendEntry(entry);
    // A question still open stays open, in the dock, where it was before.
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
    // While a card waits on the user it stands in the input's place (#704, P1), and nothing is sent past it — a
    // send that still arrives (a picker's "insert and send", a steer chord) goes to the card instead, and what
    // it would have sent stays in the input for after.
    const waiting = view.exited ? null : openCards()[0];
    if (waiting) { focusCard(waiting); return; }
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
    // A send asked for meanwhile is dropped if a card arrived since: it would only be turned into a focus move,
    // and that one without asking whether the user is typing elsewhere.
    if (submitAgain) { const next = submitAgain; submitAgain = null; if (!openCards().length) submit(next); }
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
    // While a card waits on the user it stands in the input's place (#704, P1): the input and its Send and Steer
    // go, what was typed stays in it for later, and Stop stays — the turn can still be stopped from here.
    const docked = !off && openCards().length > 0;
    composer.classList.toggle('docked', docked);
    input.hidden = docked;
    if (docked) { sendBtn.style.display = 'none'; steerBtn.style.display = 'none'; } else sendBtn.style.display = '';
    renderSuggestion();
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
    saidKeptBehindCard();
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
  function setSuggestion(text) {
    view.suggestion = text && String(text).trim() ? String(text).trim() : null;
    renderSuggestion();
  }
  function renderSuggestion() {
    const on = !!view.suggestion && !input.value;
    input.placeholder = on ? `${view.suggestion}    — Tab to use it` : defaultPlaceholder;
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

  // --- Files pasted or dropped (#662, #699) ---
  //
  // What a terminal session does with the same file: an image the session takes is attached and stands in
  // the text as `[Image #n]`; every other file — and an image the session refuses — is NAMED in the text as
  // `@<path>`, the form the `@` completion writes, for the CLI (or the model) to read. Whether the content
  // reaches the turn is the backend's: measured, Claude expands the reference and Pi does not (spec 32).
  const isImageFile = (f) => !!(f && typeof f.type === 'string' && f.type.startsWith('image/'));
  // The file's place on disk, or '' for one that has none — a bitmap from the clipboard, an image dragged out
  // of a browser. Only such a file can be named.
  function diskPathOf(file) {
    try { return (window.api.getPathForFile && window.api.getPathForFile(file)) || ''; } catch { return ''; }
  }

  // Attach the image files among `files`, refusing up front what the session would refuse on send. Returns
  // the refused ones that have a path, so the caller names them instead; a refusal says which happened.
  async function attachImages(files) {
    const images = [...files].filter(isImageFile);
    const named = [];
    if (!images.length || view.exited) return named;
    const refuse = (file, why) => {
      const name = file.name || 'Pasted image';
      if (diskPathOf(file)) { named.push(file); notice('error', `${name} was not attached: ${why}. Its path was inserted instead.`); }
      else notice('error', `${name} was not attached: ${why}.`);
    };
    const policy = imagePolicy();
    if (!policy) {
      for (const file of images) refuse(file, 'this session does not take images');
      return named;
    }
    const kinds = policy.types.map(t => t.replace(/^image\//, '').toUpperCase()).join(', ');
    const limit = `${Math.round(Number(policy.maxBytes) / (1024 * 1024))} MB`;
    for (const file of images) {
      const name = file.name || 'Pasted image';
      if (!policy.types.includes(file.type)) { refuse(file, `only ${kinds} images can be sent here`); continue; }
      // The size the image will have as base64, which is what main checks (`imagesFor` in agent-rpc.js).
      if (Math.ceil(file.size / 3) * 4 > Number(policy.maxBytes)) { refuse(file, `it is too large (the limit is ${limit} encoded, about ${Math.round(Number(policy.maxBytes) * 3 / 4 / (1024 * 1024) * 10) / 10} MB as a file)`); continue; }
      const url = await readAsDataUrl(file);
      const comma = url.indexOf(',');
      if (comma < 0) { refuse(file, 'it could not be read'); continue; }
      const label = nextImageLabel();
      view.attachments.push({ mimeType: file.type, data: url.slice(comma + 1), name, url, label });
      insertAtCaret(label);
    }
    renderAttachments();
    return named;
  }

  // Everything a paste or a drop hands over: images first, then one reference per file to be named, in one
  // insert so they stand together. Several files, several references.
  async function takeFiles(files) {
    if (view.exited) return;
    const list = [...files].filter(Boolean);
    const refused = new Set(await attachImages(list));
    const refs = [];
    // In the order they were handed over, so the references read the way the files were picked.
    for (const file of list.filter(f => !isImageFile(f) || refused.has(f))) {
      const p = diskPathOf(file);
      if (p) refs.push(composerPathToken(p));
      else notice('error', `${file.name || 'The file'} could not be named: it has no path on disk.`);
    }
    if (refs.length) insertAtCaret(refs.join(' '));
    // A write of the value fires no `input` event, so the suggestion's own clearing never runs.
    if (view.suggestion && input.value) setSuggestion(null);
  }

  input.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const files = [...(data.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    // A copy that carries text pastes the text and nothing else. Excel and Word put a rendered picture of the
    // selection on the clipboard beside the text, so attaching the image too would add an unwanted
    // thumbnail to every paste of a few cells. That picture has no place on disk; a file copied in a file
    // manager does, so a copy holding one is a copy of files whatever text rides along.
    if (data.getData('text/plain') && !files.some(diskPathOf)) return;
    e.preventDefault();
    takeFiles(files);
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
      saidKeptBehindCard();
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
    takeFiles([...(e.dataTransfer.files || [])]);
    input.focus(); // what was dropped is in the text now, so the text is where the user goes on
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
    // Only while the view is on screen (`shown`), and it is picked up again on show — by `focus()`, which every
    // path that shows the view calls, and by the `.visible` observer.
    const needed = counting.length > 0 && shown() && container.isConnected && !view.exited;
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
    if (container.contains(document.activeElement) || document.activeElement === document.body) focusView();
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
    // WHY it is asked, when the backend could say — which rule, and why nothing lasting is offered. Plain text.
    if (request.reason) {
      const why = document.createElement('div');
      why.className = 'conversation-ask-message conversation-approval-note';
      why.textContent = String(request.reason);
      card.appendChild(why);
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
    placeCard(card);
    // Enter allows once; Escape refuses, as declining is what the CLI's Escape does.
    armCard(card, {
      primary: () => { if (answers.once) answer(answers.once); },
      escape: () => { if (answers.refuse) answer(answers.refuse); },
    });
    renderActivity();
  }

  // Sends one answer for a card and locks it until the answer is taken; a refused send unlocks it again, and
  // `unlocked` lets the card put back any control that has a condition of its own.
  function sendAnswer(card, request, payload, unlocked) {
    const controls = () => card.querySelectorAll('button, textarea, input');
    for (const c of controls()) c.disabled = true;
    return window.api.agent.answer(view.session.sessionId, request.id, payload).then((res) => {
      if (!res || !res.ok) {
        for (const c of controls()) c.disabled = false;
        if (typeof unlocked === 'function') unlocked();
        notice('error', (res && res.error) || 'The answer did not reach the session.');
      }
      return res;
    });
  }

  // The agent asking the user one or more questions at once (#661), laid out the way the CLI lays them out
  // (#704, read from 2.1.283 in a terminal): one question at a time behind a row of tabs, a tab of its own to
  // review and submit, the options numbered with their description under the label, and the text graphic an
  // option may carry (`preview`) beside the list for the option in focus. Each single-choice option has a
  // "note" button that opens a note field under it (the CLI's `n`); "Type something" is the free answer, its
  // field shown once it is chosen. One Answer sends every question, because the backend takes them as a single
  // reply. What an answer becomes on the wire is the backend's.
  function renderQuestions(request) {
    const card = document.createElement('div');
    card.className = 'jsonl-entry conversation-ask conversation-questions';
    const title = document.createElement('div');
    title.className = 'conversation-ask-title';
    title.textContent = request.questions.length > 1 ? 'The agent is asking you some questions' : 'The agent is asking you a question';
    card.appendChild(title);

    const many = request.questions.length > 1;
    const readers = [];
    const panels = [];
    const tabs = [];
    let active = 0;
    const submit = document.createElement('button');
    const dismiss = document.createElement('button');
    const summary = document.createElement('div');
    summary.className = 'conversation-question-summary';

    const tabBar = many ? document.createElement('div') : null;
    if (tabBar) {
      tabBar.className = 'conversation-question-tabs';
      tabBar.setAttribute('role', 'tablist');
      card.appendChild(tabBar);
    }

    request.questions.forEach((q, qi) => {
      const panel = document.createElement('div');
      panel.className = 'conversation-question';
      const head = document.createElement('div');
      head.className = 'conversation-question-text';
      if (q.header) {
        const chip = document.createElement('span');
        chip.className = 'conversation-question-header';
        chip.textContent = q.header;
        head.appendChild(chip);
      }
      head.appendChild(document.createTextNode(q.question));
      panel.appendChild(head);

      const body = document.createElement('div');
      body.className = 'conversation-question-body';
      const list = document.createElement('div');
      list.className = 'conversation-question-list';
      body.appendChild(list);
      const hasPreview = q.options.some(o => o.preview);
      const preview = hasPreview ? document.createElement('pre') : null;
      if (preview) { preview.className = 'conversation-question-preview'; body.appendChild(preview); }
      panel.appendChild(body);

      const type = q.multiSelect ? 'checkbox' : 'radio';
      const name = `q-${request.id}-${qi}`;
      const choices = [];
      // One note per question, as the CLI keeps it; it moves under the option whose button opened it.
      const noteField = q.multiSelect ? null : document.createElement('input');
      if (noteField) {
        noteField.type = 'text';
        noteField.className = 'conversation-ask-input conversation-question-note';
        noteField.placeholder = 'Note on your choice';
        noteField.hidden = true;
      }
      const showPreview = (text) => {
        if (!preview) return;
        preview.textContent = text || 'No preview for this option.';
        preview.classList.toggle('empty', !text);
      };
      const addChoice = (n, labelText, description, previewText, { note = true } = {}) => {
        const row = document.createElement('div');
        row.className = 'conversation-question-option';
        const label = document.createElement('label');
        label.className = 'conversation-question-pick';
        const box = document.createElement('input');
        box.type = type;
        box.name = name;
        box.addEventListener('change', refresh);
        label.appendChild(box);
        const text = document.createElement('span');
        text.className = 'conversation-question-label';
        text.textContent = `${n}. ${labelText}`;
        label.appendChild(text);
        row.appendChild(label);
        if (noteField && note) {
          const noteBtn = document.createElement('button');
          noteBtn.type = 'button';
          noteBtn.className = 'task-notice-output conversation-question-note-btn';
          noteBtn.textContent = 'note';
          noteBtn.title = 'Add a note to this choice (n)';
          noteBtn.addEventListener('click', () => openNote(row, box));
          row.appendChild(noteBtn);
        }
        if (description) {
          const desc = document.createElement('div');
          desc.className = 'conversation-question-desc';
          desc.textContent = description;
          row.appendChild(desc);
        }
        const show = () => showPreview(previewText);
        box.addEventListener('focus', show);
        box.addEventListener('change', () => { if (box.checked) show(); });
        row.addEventListener('mouseenter', show);
        list.appendChild(row);
        return { box, row };
      };
      const openNote = (row, box) => {
        if (!noteField) return;
        if (box.type === 'radio' && !box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
        row.after(noteField);
        noteField.hidden = false;
        noteField.focus();
      };
      q.options.forEach((opt, i) => {
        const { box, row } = addChoice(i + 1, opt.label, opt.description, opt.preview || '');
        choices.push({ box, row, label: opt.label, preview: opt.preview || '' });
      });
      // The free answer, as the CLI names it; its field appears once it is chosen.
      const otherChoice = addChoice(q.options.length + 1, 'Type something', '', '', { note: false });
      const other = document.createElement('input');
      other.type = 'text';
      other.className = 'conversation-ask-input conversation-question-other';
      other.placeholder = 'Your own answer';
      other.hidden = true;
      otherChoice.row.appendChild(other);
      // Shown while it is chosen (kept in step by `refresh`, since unticking a radio fires no change on it), and
      // focused only when it was chosen by a click or Enter — an arrow passing over it must not trap the focus.
      otherChoice.box.addEventListener('click', () => setTimeout(() => { if (otherChoice.box.checked) other.focus(); }, 0));
      other.addEventListener('input', refresh);
      if (noteField) list.appendChild(noteField);
      // The preview of what is picked, until the focus moves over another option.
      const selected = choices.find(c => c.box.checked);
      showPreview(selected ? selected.preview : (choices[0] && choices[0].preview) || '');

      // What this question's answer is right now, or '' — several choices joined the way the CLI reads them.
      const value = () => {
        const picked = choices.filter(c => c.box.checked).map(c => c.label);
        if (otherChoice.box.checked && other.value.trim()) picked.push(other.value.trim());
        return picked.join(', ');
      };
      readers.push({
        question: q.question,
        header: q.header || `Question ${qi + 1}`,
        multi: !!q.multiSelect,
        value,
        note: () => (noteField && !noteField.hidden ? noteField.value.trim() : ''),
        boxes: () => [...choices.map(c => c.box), otherChoice.box],
        otherBox: otherChoice.box,
        otherField: other,
        syncOther: () => { other.hidden = !otherChoice.box.checked; },
        noteFor: (target) => {
          const row = target && target.closest ? target.closest('.conversation-question-option') : null;
          const box = row && row.querySelector('input[type="radio"], input[type="checkbox"]');
          if (row && box && box !== otherChoice.box) openNote(row, box);
        },
      });
      panels.push(panel);
      card.appendChild(panel);
      if (tabBar) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'conversation-question-tab';
        tab.setAttribute('role', 'tab');
        tab.addEventListener('click', () => show(qi));
        tabs.push(tab);
        tabBar.appendChild(tab);
      }
    });

    // The review: every question with its answer, the gap said out loud, then Answer and Dismiss. With several
    // questions it is a tab of its own, as in the CLI; with one it sits under the question.
    const review = document.createElement('div');
    review.className = 'conversation-question-review';
    if (many) review.appendChild(summary);
    const actions = document.createElement('div');
    actions.className = 'conversation-ask-actions';
    submit.type = 'button';
    submit.className = 'new-session-secondary-btn conversation-ask-primary';
    submit.textContent = many ? 'Submit answers' : 'Answer';
    submit.disabled = true;
    actions.appendChild(submit);
    dismiss.type = 'button';
    dismiss.className = 'new-session-secondary-btn';
    dismiss.textContent = 'Dismiss';
    actions.appendChild(dismiss);
    review.appendChild(actions);
    card.appendChild(review);
    // "Chat about this" (#704), the CLI's last row under a question: the questions are declined and what the user
    // writes goes to the agent instead. Its field opens on a click or `c`; Enter sends, Shift+Enter adds a line.
    const chatRow = document.createElement('div');
    chatRow.className = 'conversation-question-chat';
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'task-notice-output';
    chatBtn.textContent = 'Chat about this';
    chatBtn.title = 'Decline the questions and write to the agent instead (c)';
    const chatBox = document.createElement('textarea');
    chatBox.className = 'conversation-ask-input conversation-question-chat-input';
    chatBox.rows = 2;
    chatBox.placeholder = 'What would you like to clarify? Enter sends, Shift+Enter adds a line';
    chatBox.hidden = true;
    chatRow.appendChild(chatBtn);
    chatRow.appendChild(chatBox);
    card.appendChild(chatRow);
    function openChat() { chatBox.hidden = false; chatBox.focus(); }
    chatBtn.addEventListener('click', openChat);
    chatBox.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      const text = chatBox.value.trim();
      if (text) card._chat(text);
    });
    // The keys, as the CLI prints them under its questions.
    const hint = document.createElement('div');
    hint.className = 'conversation-question-hint';
    const notes = request.questions.some(q => !q.multiSelect);
    hint.textContent = `1–9 or ↑/↓ to choose · Enter to select${many ? ' · Tab or ←/→ to switch questions' : ''}${notes ? ' · n to add a note' : ''} · c to chat about this · Esc to dismiss`;
    card.appendChild(hint);
    if (tabBar) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'conversation-question-tab conversation-question-tab-submit';
      tab.setAttribute('role', 'tab');
      tab.textContent = 'Submit';
      tab.addEventListener('click', () => show(panels.length));
      tabs.push(tab);
      tabBar.appendChild(tab);
    }

    function refresh() {
      for (const r of readers) r.syncOther();
      const all = readers.every(r => r.value());
      submit.disabled = !all;
      readers.forEach((r, i) => { if (tabs[i]) tabs[i].textContent = `${r.value() ? '☑' : '☐'} ${r.header}`; });
      if (!many) return;
      summary.replaceChildren();
      for (const r of readers) {
        const line = document.createElement('div');
        line.className = 'conversation-question-summary-line';
        line.textContent = `${r.header}: ${r.value() || '(not answered)'}`;
        summary.appendChild(line);
      }
      if (!all) {
        const warn = document.createElement('div');
        warn.className = 'conversation-question-summary-warn';
        warn.textContent = 'Not every question is answered yet.';
        summary.appendChild(warn);
      }
    }
    // Which question is shown: an index into the panels, or `panels.length` for the review tab.
    function show(index, { focus = true } = {}) {
      if (!many) return;
      active = Math.max(0, Math.min(panels.length, index));
      panels.forEach((p, i) => { p.hidden = i !== active; });
      review.hidden = active !== panels.length;
      tabs.forEach((t, i) => t.classList.toggle('active', i === active));
      if (!focus || !card.contains(document.activeElement)) return;
      const first = active === panels.length ? submit.disabled ? dismiss : submit : readers[active].boxes()[0];
      if (first) first.focus();
    }
    refresh();
    show(0, { focus: false });

    // Everything the card holds right now, for the answer and for a "Chat about this".
    const collect = () => {
      const answers = {};
      const notes = {};
      for (const r of readers) {
        answers[r.question] = r.value();
        if (r.note()) notes[r.question] = r.note();
      }
      return { answers, notes };
    };
    // One decline at a time: a second Enter while the first is out would only be refused.
    card._chat = async (text) => {
      if (card._chatting) return null;
      card._chatting = true;
      try { return await sendAnswer(card, request, { ...collect(), chat: text }, refresh); } finally { card._chatting = false; }
    };
    submit.addEventListener('click', () => sendAnswer(card, request, collect(), refresh));
    dismiss.addEventListener('click', () => sendAnswer(card, request, { cancelled: true }, refresh));
    view.asks.set(request.id, card);
    holdCall(request);
    placeCard(card);

    // The CLI's keys for this card, before the ones every card shares: Tab and the side arrows switch between
    // the questions, `n` opens the note of the option in focus, and Enter on an option picks it and moves on.
    const scopeOf = () => (many && active < panels.length ? panels[active] : many ? review : card);
    armCard(card, {
      primary: () => {
        if (many && active < panels.length) { show(active + 1); return; }
        if (!submit.disabled) submit.click();
      },
      escape: () => dismiss.click(),
      scope: scopeOf,
      keys: (e, inText) => {
        if (many && !inText && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Tab')) {
          const back = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey);
          show((active + (back ? -1 : 1) + panels.length + 1) % (panels.length + 1));
          return true;
        }
        if (!inText && (e.key === 'n' || e.key === 'N') && (!many || active < panels.length)) {
          readers[many ? active : 0].noteFor(e.target);
          return true;
        }
        if (!inText && (e.key === 'c' || e.key === 'C')) { openChat(); return true; }
        const option = e.target && (e.target.type === 'radio' || e.target.type === 'checkbox');
        if (e.key === 'Enter' && !e.shiftKey && option) {
          const r = readers[many ? Math.min(active, readers.length - 1) : 0];
          // The free answer is picked and its field takes the focus; nothing moves on while it is empty.
          if (e.target === r.otherBox) {
            if (!e.target.checked) { e.target.checked = true; e.target.dispatchEvent(new Event('change', { bubbles: true })); }
            r.otherField.focus();
            return true;
          }
          // A single choice is made by picking. Several are made by ticking with Space; Enter only moves on,
          // it does not tick or untick the option it is on.
          if (e.target.type === 'radio' && !e.target.checked) { e.target.checked = true; e.target.dispatchEvent(new Event('change', { bubbles: true })); }
          if (many) show(active + 1);
          else if (!submit.disabled) submit.click();
          return true;
        }
        return false;
      },
    });
    renderActivity();
  }

  // --- the cards and the keyboard (#704) ---
  //
  // Every card can be answered without the mouse. When one appears it takes the focus only when nobody is
  // typing anywhere else: the focus is on this view's input (and that is empty) or on its log, or on nothing at
  // all — never out of another pane's terminal or a settings field, where the next Enter would answer a card the
  // user has not read (V1 of #704). Otherwise its title says which key reaches it: Alt+A, from anywhere in the
  // view. Inside a card: a digit picks the n-th option of the question in view, or presses the n-th button when
  // the focus is on one; the arrows move between the options; Enter answers; Escape dismisses or refuses, and
  // never stops the turn — only in the input does it. In a text field Escape only leaves the field.
  function cardControls(card, scope, target) {
    const root = scope || card;
    const buttonFocused = target && target.tagName === 'BUTTON' && target.closest('.conversation-ask-actions');
    const boxes = buttonFocused ? [] : [...root.querySelectorAll('input[type="radio"], input[type="checkbox"]')].filter(b => !b.disabled && !b.closest('[hidden]'));
    // The buttons are numbered as they stand, disabled ones included, so a digit always means the same button.
    return boxes.length ? boxes : [...root.querySelectorAll('.conversation-ask-actions button')];
  }
  function focusCard(card) {
    if (!card || !card.isConnected) return false;
    const scope = typeof card._scope === 'function' ? card._scope() : card;
    // A card with options starts on its first option; a dialog that asks for text is answered in its field, not
    // on its OK; anything else starts on its first button that can be pressed.
    const controls = cardControls(card, scope);
    const choices = controls[0] && controls[0].tagName === 'INPUT';
    const field = choices ? null : scope.querySelector('textarea.conversation-ask-input:not([hidden]), input.conversation-ask-input:not([hidden])');
    const first = choices ? controls[0] : (field || controls.find(b => !b.disabled) || card.querySelector('button'));
    if (!first) return false;
    first.focus();
    if (typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'nearest' });
    return document.activeElement === first;
  }
  function openCards() { return [...view.asks.values()].filter(c => c && c.isConnected); }
  // Where the view's focus goes when it is handed one (a tab switched to, a grid card, a pane): the card waiting
  // on the user when there is one — the input is hidden behind it — and the input otherwise.
  function focusView() {
    if (focusCard(openCards()[0])) return;
    if (!input.disabled && !input.hidden) input.focus();
  }
  // Something typed into the input while a card stands in its place lands there unseen (#704, P1): said, so an
  // insert does not look like it failed.
  function saidKeptBehindCard() {
    if (input.hidden && openCards().length) notice('info', 'Kept in the input for when the card is answered.');
  }
  // A click anywhere in the view outside the cards means the user has moved on: a card that closes after that
  // does not pull the focus back. A click on something that cannot take the focus leaves no other trace.
  container.addEventListener('pointerdown', (e) => {
    for (const c of openCards()) if (!c.contains(e.target)) c._hadFocus = false;
  });
  // A card goes into the dock (P1 of #704); the first open one is shown and the next follows it.
  function placeCard(card) {
    askDock.appendChild(card);
    renderDock();
  }
  function renderDock() {
    const cards = openCards();
    askDock.hidden = !cards.length || view.exited;
    cards.forEach((c, i) => { c.hidden = i !== 0; });
    let more = askDock.querySelector(':scope > .conversation-ask-more');
    if (cards.length > 1) {
      if (!more) { more = document.createElement('div'); more.className = 'conversation-ask-more'; askDock.prepend(more); }
      more.textContent = `1 of ${cards.length} waiting for you`;
    } else if (more) more.remove();
    renderComposer();
  }
  // Whether a new card may take the focus: see the paragraph above.
  function mayTakeFocus() {
    // What is typed in the input stays there, hidden behind the dock (P1), so its text is no reason to hold back;
    // only where the focus is decides.
    const at = document.activeElement;
    if (at !== input && at !== log && at !== document.body && at !== null) return false;
    // Shown is the `.visible` class, not the computed display (#723): a hidden container is `flex` now and only
    // skipped, and a card focused inside it would lay out the whole log it is skipping.
    return container.isConnected && !container.closest('[hidden]') && container.classList.contains('visible');
  }
  function armCard(card, { primary, escape, scope, keys }) {
    if (typeof scope === 'function') card._scope = scope;
    // Whether the focus is in this card, kept as it moves rather than guessed at when the card closes: sending an
    // answer locks the card's controls, which drops the focus to the page with nothing leaving the card.
    card.addEventListener('focusin', () => { card._hadFocus = true; });
    card.addEventListener('focusout', (e) => { if (e.relatedTarget && !card.contains(e.relatedTarget)) card._hadFocus = false; });
    card.addEventListener('keydown', (e) => {
      if (e.isComposing || e.defaultPrevented) return;
      const inText = !!e.target && (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'password')));
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (inText) { e.target.blur(); focusCard(card); return; }
        if (typeof escape === 'function') escape();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typeof keys === 'function' && keys(e, inText)) { e.preventDefault(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        // A button with the focus is pressed by Enter anyway; everywhere else Enter is the card's answer.
        if (e.target && e.target.tagName === 'BUTTON') return;
        if (e.target && e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        primary();
        return;
      }
      if (inText) return;
      const root = typeof scope === 'function' ? scope() : card;
      const controls = cardControls(card, root, e.target);
      if (/^[1-9]$/.test(e.key)) {
        const target = controls[Number(e.key) - 1];
        if (!target || target.disabled) return;
        e.preventDefault();
        target.focus();
        target.click();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const at = controls.indexOf(e.target);
        if (at < 0) return;
        e.preventDefault();
        const next = controls[(at + (e.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length];
        next.focus();
        // A radio follows the focus, as radios do; a checkbox and a button wait for Space or Enter. Set, not
        // clicked, so passing over "Type something" does not move the focus into its field.
        if (next.type === 'radio' && !next.checked) { next.checked = true; next.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });
    const title = card.querySelector('.conversation-ask-title');
    // The card shown is the first one; a new card behind it waits, and the one in view is what takes the focus.
    if (mayTakeFocus() && focusCard(openCards()[0])) { renderComposer(); return; }
    if (title) title.appendChild(Object.assign(document.createElement('span'), { className: 'conversation-ask-key', textContent: ` · ${CARD_KEY} to answer` }));
    renderComposer();
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
    placeCard(card);
    // Enter approves. Escape does nothing here (V2 of #704): "keep planning" ends the turn the way a Stop does,
    // which is too much for a key pressed to get out of a card. It is the second button, so 2 or a click.
    armCard(card, {
      primary: () => { if (answers.approve) sendAnswer(card, request, { value: answers.approve }); },
      escape: null,
    });
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
    const dismissBtn = button('Dismiss', { cancelled: true });
    card.appendChild(actions);
    view.asks.set(request.id, card);
    placeCard(card);
    armCard(card, {
      primary: () => { const p = actions.querySelector('.conversation-ask-primary'); if (p && !p.disabled) p.click(); },
      escape: () => { if (!dismissBtn.disabled) dismissBtn.click(); },
    });
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
        // A card that had the focus hands it back to the input, so the keyboard does not end up nowhere.
        // Sending locks the card's controls, and a locked control drops the focus to the page — so the page
        // holding it is the card's focus lost that way.
        const at = document.activeElement;
        const hadFocus = !!(card && (card.contains(at) || (card._hadFocus && (at === document.body || at === null))));
        if (card) { card.remove(); view.asks.delete(op.id); }
        for (const [callId, held] of view.approvals) if (held.id === op.id) view.approvals.delete(callId);
        renderActivity();
        renderStatus();
        renderDock();
        if (hadFocus && !view.exited && !focusCard(openCards()[0])) input.focus();
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
      saidKeptBehindCard();
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
    renderDock();
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
    focus: () => { focusView(); restore(); renderJump(); tick(); },
    // The font size changed (#720), and with it every entry's height. The log itself is not zoomed, so no
    // resize reaches the observer: a reader's kept place is scaled with the text, and a reader at the end stays
    // there. Hidden or shown alike — a hidden tab puts `readerTop` back when it is shown.
    rescale: (ratio) => {
      if (!(ratio > 0) || ratio === 1) return;
      readerTop *= ratio;
      if (!shown()) return;
      if (stuck) follow(); else log.scrollTop = readerTop;
      renderJump();
    },
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
    // A breadcrumb for a renderer stall report (shell/stall-report.js, #707).
    window.noteRendererWork?.(`conversation-op:${(op && op.op) || 'unknown'}`);
    const entry = openSessions.get(sessionId);
    if (entry && entry.conversation) entry.conversation.apply(op);
    // The activity clock every other session gets from its terminal bytes (`trackActivity`).
    if (typeof lastActivityTime !== 'undefined') lastActivityTime.set(sessionId, new Date());
  });
}
