// session/composer-completion.js — the autocomplete of a session's text input (#643).
//
// A session with no terminal has a text field instead of a CLI prompt (`conversation-view.js`), and a CLI's
// own prompt completes as you type. Three things complete here, each decided by the text before the caret:
//
//   `/na`            the session's commands, prompt templates and skills, from the backend's own list
//   `/model op`      one command's argument, where the backend says the command takes one it can list
//   `@src/ren`       the project's files and directories
//
// It knows no backend and no store. What it offers comes from `source`, which the view builds from
// `window.api.agent` — three calls the backend answers in its own words (`src/app/agent-rpc.js`):
//   source.commands()          -> [{ name, description, kind, arguments }]
//   source.arguments(command)  -> [{ value, description }]
//   source.paths(prefix)       -> [{ value, dir }]
// and it reads nothing else. The list reuses the palette's rows (`.variable-palette`, `.vpal-*`), so it is
// styled like every other picker in the app.
//
// KEYS. While the list is open it owns ArrowUp/ArrowDown, Tab, Enter and Escape: Tab or Enter takes the
// highlighted row, Escape closes the list — and only the list, so a running turn is not stopped by the key
// that dismissed a suggestion. With the list closed, every key goes where it went before.

// How long a fetched list is reused while typing. The commands and an argument list change rarely; this
// only saves a round trip per keystroke. An empty or failed answer is not kept — a `/` typed before the
// session has finished starting would otherwise find nothing for this long.
const COMPOSER_COMPLETION_REUSE_MS = 10000;
const COMPOSER_COMPLETION_ROWS = 50;

// What the text before the caret asks for, or null. Pure, so the tests can pin every shape.
function composerCompletionContext(before) {
  const text = String(before == null ? '' : before);
  // A path first: an `@` that starts a word, bare or opening a quote (a path with a space in it). Checked
  // before a command's argument, so `/skill:review @src/ap` completes the file it is given.
  let m = /(^|\s)@(?:"([^"]*)|([^\s"@]*))$/.exec(text);
  if (m) {
    const quoted = m[2] != null;
    const query = quoted ? m[2] : m[3];
    return { mode: 'path', query, start: text.length - query.length - (quoted ? 1 : 0) - 1 };
  }
  // A command: the whole field so far is `/` and a name — the way a CLI only reads a command at the start.
  m = /^\/([^\s/@]*)$/.exec(text);
  if (m) return { mode: 'command', query: m[1], start: 0 };
  // A command's argument: `/name ` and the start of one argument.
  m = /^\/([^\s/@]+) ([^\s@]*)$/.exec(text);
  if (m) return { mode: 'argument', command: m[1], query: m[2], start: text.length - m[2].length };
  return null;
}

// Rank what matches: a name that starts with the query first, then one that contains it, then one whose
// description does. Case does not matter; the order within a rank is the source's.
function composerCompletionRank(items, query, keyOf, descOf) {
  const q = String(query || '').toLowerCase();
  if (!q) return items.slice();
  const starts = [], has = [], described = [];
  for (const it of items) {
    const k = String(keyOf(it) || '').toLowerCase();
    if (k.startsWith(q)) starts.push(it);
    else if (k.includes(q)) has.push(it);
    // A description is searched only once the query says something — two letters match half of any prose.
    else if (q.length >= 3 && String((descOf && descOf(it)) || '').toLowerCase().includes(q)) described.push(it);
  }
  return [...starts, ...has, ...described];
}

// A path as it is typed after `@`: quoted when it has a space, because the space would end the word.
function composerPathToken(value) {
  const v = String(value || '');
  return /\s/.test(v) ? `@"${v}` + (v.endsWith('/') ? '' : '"') : `@${v}`;
}

function createComposerCompletion(input, anchor, source) {
  const doc = input.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'popover variable-palette composer-completion';
  box.setAttribute('role', 'listbox');
  box.style.display = 'none';
  const list = doc.createElement('div');
  list.className = 'vpal-list';
  box.appendChild(list);
  anchor.appendChild(box);

  const cache = { commands: null, commandsAt: 0, args: new Map() };
  let rows = [];          // [{ label, meta, desc, apply }]
  let active = 0;
  let open = false;
  let ticket = 0;         // the newest refresh; an older answer arriving late is dropped

  function close() {
    open = false;
    rows = [];
    box.style.display = 'none';
    list.replaceChildren();
  }

  function draw() {
    list.replaceChildren();
    if (!rows.length) { close(); return; }
    rows.forEach((r, i) => {
      const row = doc.createElement('div');
      row.className = 'vpal-row' + (i === active ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === active ? 'true' : 'false');
      const name = doc.createElement('span');
      name.className = 'vpal-name';
      name.textContent = r.label;
      if (r.desc) {
        const desc = doc.createElement('span');
        desc.className = 'composer-completion-desc';
        desc.textContent = r.desc;
        name.appendChild(desc);
      }
      row.appendChild(name);
      if (r.meta) {
        const meta = doc.createElement('span');
        meta.className = 'vpal-secret composer-completion-kind';
        meta.textContent = r.meta;
        row.appendChild(meta);
      }
      // mousedown, not click: a click would take the focus from the field first and close the list.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); take(i); });
      list.appendChild(row);
    });
    open = true;
    box.style.display = '';
    const current = list.children[active];
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }

  // Replace the word from `start` to its end with `text` — the rest of it too when the caret sits inside it,
  // or `@RE|A` would leave the `A` behind — and put the caret after it.
  function replace(start, text) {
    const caret = input.selectionStart ?? input.value.length;
    const end = caret + (/^[^\s"]*"?/.exec(input.value.slice(caret)) || [''])[0].length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const at = start + text.length;
    input.setSelectionRange(at, at);
    input.focus();
  }

  // A row is taken only if the text still asks what it answered: the caret can move without an `input`
  // event (a click, Home, an arrow), and replacing from a stale position would cut the user's text apart.
  function take(i) {
    const r = rows[i];
    if (!r) return;
    const caret = input.selectionStart ?? input.value.length;
    const now = composerCompletionContext(input.value.slice(0, caret));
    if (!now || now.mode !== r.ctx.mode || now.start !== r.ctx.start) { close(); refresh(); return; }
    r.apply();
    close();
    refresh();   // a command that takes arguments, or a directory, opens the next list at once
  }

  async function commandList() {
    const now = Date.now();
    if (cache.commands && now - cache.commandsAt < COMPOSER_COMPLETION_REUSE_MS) return cache.commands;
    let got = [];
    try { got = (await source.commands()) || []; } catch { got = []; }
    if (got.length) { cache.commands = got; cache.commandsAt = now; }
    return got;
  }

  async function argumentList(command) {
    const hit = cache.args.get(command);
    const now = Date.now();
    if (hit && now - hit.at < COMPOSER_COMPLETION_REUSE_MS) return hit.items;
    let got = [];
    try { got = (await source.arguments(command)) || []; } catch { got = []; }
    if (got.length) cache.args.set(command, { at: now, items: got });
    return got;
  }

  async function refresh() {
    const mine = ++ticket;
    const caret = input.selectionStart ?? input.value.length;
    const ctx = composerCompletionContext(input.value.slice(0, caret));
    if (!ctx) { close(); return; }
    let next = [];
    if (ctx.mode === 'command') {
      const commands = await commandList();
      if (mine !== ticket) return;
      next = composerCompletionRank(commands, ctx.query, c => c.name, c => c.description).map(c => ({
        label: '/' + c.name,
        desc: c.description,
        meta: c.kind === 'command' ? '' : c.kind,
        ctx,
        apply: () => replace(0, '/' + c.name + ' '),
      }));
    } else if (ctx.mode === 'argument') {
      const commands = await commandList();
      if (mine !== ticket) return;
      const cmd = commands.find(c => c.name === ctx.command);
      if (!cmd || !cmd.arguments) { close(); return; }
      const items = await argumentList(ctx.command);
      if (mine !== ticket) return;
      next = composerCompletionRank(items, ctx.query, i => i.value, i => i.description).map(i => ({
        label: i.value,
        desc: i.description,
        meta: '',
        ctx,
        apply: () => replace(ctx.start, i.value),
      }));
    } else {
      let items = [];
      try { items = (await source.paths(ctx.query)) || []; } catch { items = []; }
      if (mine !== ticket) return;
      next = items.map(i => ({
        label: i.value,
        desc: '',
        meta: i.dir ? 'dir' : '',
        ctx,
        // A directory keeps the word open, so the next list is its contents; a file ends it.
        apply: () => replace(ctx.start, composerPathToken(i.value) + (i.dir ? '' : ' ')),
      }));
    }
    // A list whose only row is exactly what is already typed has nothing to offer — Enter then sends.
    if (next.length === 1 && next[0].label === (ctx.mode === 'command' ? '/' + ctx.query : ctx.query)) next = [];
    rows = next.slice(0, COMPOSER_COMPLETION_ROWS);
    active = 0;
    draw();
  }

  input.addEventListener('input', () => { refresh(); });
  // The caret moved without the text changing: what the list answers may no longer be what is asked.
  input.addEventListener('click', () => { if (open) refresh(); });
  input.addEventListener('keyup', (e) => {
    if (open && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) refresh();
  });
  input.addEventListener('blur', () => { close(); });

  // Called by the view's own keydown handler FIRST; true means the key was used here.
  function handleKey(e) {
    if (!open || !rows.length) return false;
    if (e.isComposing || e.keyCode === 229) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      draw();
    } else if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
      take(active);
    } else if (e.key === 'Escape') {
      close();
    } else {
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  return { handleKey, refresh, close, isOpen: () => open, element: box };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { composerCompletionContext, composerCompletionRank, composerPathToken, createComposerCompletion };
}
