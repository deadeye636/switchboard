// session/servers-dialog.js — a session's MCP servers, and what can be done to one (#728).
//
// `/mcp` in a session driven over a runtime protocol opens this instead of the one-off card of #719. Main hands
// the rows the BACKEND built (`servers` op — `name`, `group`, `groupOrder`, `state`, `tone`, `tools`,
// `toolList`, `error`, `needsSignIn`, `actions`), and this dialog draws them the way the CLI's own `/mcp` does:
// a list grouped by where each server is configured, a server's details, and its actions as a numbered menu. It
// knows no backend and reads no format. An action is the backend's word (`actions[].id`), sent back as it came;
// `tools` is the one the dialog answers itself, from the list it already holds.
//
// Keyboard as in the CLI: ↑/↓ move, Enter picks, Esc goes back one level and closes from the list. A number
// runs that action on the details page. The mouse does the same by click.
//
// Nothing is held here that the user cannot get back, so a backdrop click and Escape close it like a question.
// The state is read again after every action and while a server is still connecting — the runtime pushes no
// change on its own — and a sign-in is followed until the server has one, then reconnected (owner decision O3).
//
// Free globals read at call time: trapControlDialogFocus, controlDialogId (dialogs/control-dialogs.js).

// How often the list is read again while something is expected to move, and for how long a sign-in in the
// browser is waited on before the dialog stops asking.
const SERVERS_POLL_MS = 2000;
const SERVERS_SIGN_IN_WAIT_MS = 5 * 60 * 1000;

const SERVERS_TONE_ICON = { ok: '✓', failed: '✗', waiting: '○' };

/**
 * @param {{ list: object, load: () => Promise<object>, act: (name: string, action: string, extra?: object) => Promise<object>,
 *   openUrl: (url: string) => void, onClose?: () => void }} options
 */
function showServersDialog({ list, load, act, openUrl, onClose } = {}) {
  let rows = [];
  let title = 'MCP servers';
  let view = 'list';        // list | detail | tools | confirm | callback
  let selected = null;      // the server's name
  let actionAt = 0;         // the selected entry of the details menu, or of the confirm menu
  let busy = '';            // the action running, as its label
  let message = null;       // { tone: 'ok' | 'failed' | 'info', text }
  let signIn = null;        // { name, since } while a sign-in is given in the browser
  let pollTimer = null;
  let closed = false;

  const titleId = controlDialogId('servers-title');
  const overlay = document.createElement('div');
  overlay.className = 'control-dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'control-dialog servers-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  const body = document.createElement('div');
  body.className = 'servers-body';
  const status = document.createElement('p');
  status.className = 'servers-message';
  status.setAttribute('aria-live', 'polite');
  const hint = document.createElement('div');
  hint.className = 'servers-hint';
  // Described by what the last action did and by the keys that work on this page.
  status.id = controlDialogId('servers-status');
  hint.id = controlDialogId('servers-hint');
  dialog.setAttribute('aria-describedby', `${status.id} ${hint.id}`);
  const actions = document.createElement('div');
  actions.className = 'control-dialog-actions';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'control-dialog-secondary';
  backBtn.textContent = 'Back';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'control-dialog-cancel';
  closeBtn.textContent = 'Close';
  actions.append(backBtn, closeBtn);
  dialog.append(body, status, hint, actions);
  overlay.appendChild(dialog);

  function take(next) {
    if (!next || !Array.isArray(next.rows)) return;
    title = next.title || title;
    rows = next.rows.filter(r => r && typeof r.name === 'string' && r.name)
      .map((r, i) => ({ ...r, _i: i }))
      .sort((a, b) => ((Number(a.groupOrder) || 0) - (Number(b.groupOrder) || 0)) || (a._i - b._i));
    if (selected && !rows.some(r => r.name === selected)) {
      selected = null;
      if (view !== 'list') view = 'list';
    }
    if (!selected && rows.length) selected = rows[0].name;
  }

  const current = () => rows.find(r => r.name === selected) || null;
  const rowActions = (row) => (row && Array.isArray(row.actions) ? row.actions.filter(a => a && a.id && a.label) : []);
  // The details menu: the backend's actions, plus the pasted redirect while a sign-in for this server runs.
  function menuOf(row) {
    const out = rowActions(row);
    if (row && signIn && signIn.name === row.name) out.push({ id: 'callback', label: 'Paste the redirect address' });
    return out;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function heading(kicker, text) {
    const k = el('div', 'control-dialog-kicker', kicker);
    const h = el('h3', '', text);
    h.id = titleId;
    return [k, h];
  }

  function renderList() {
    const connected = rows.filter(r => r.tone === 'ok').length;
    body.append(...heading(title, rows.length === 1 ? '1 server' : `${rows.length} servers`));
    const count = el('p', 'servers-count', rows.length ? `${connected} of ${rows.length} connected` : 'No servers are configured for this session.');
    body.appendChild(count);
    const listEl = el('div', 'servers-list');
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-labelledby', titleId);
    listEl.tabIndex = 0;
    let group = null;
    for (const r of rows) {
      if (r.group !== group) {
        group = r.group;
        listEl.appendChild(el('div', 'servers-group', group || ''));
      }
      const row = el('div', 'servers-row servers-tone-' + (SERVERS_TONE_ICON[r.tone] ? r.tone : 'waiting'));
      row.setAttribute('role', 'option');
      row.dataset.name = r.name;
      const on = r.name === selected;
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      row.append(
        el('span', 'servers-icon', SERVERS_TONE_ICON[r.tone] || SERVERS_TONE_ICON.waiting),
        el('span', 'servers-name', r.name),
        el('span', 'servers-meta', r.tone === 'ok' && Number.isFinite(r.tools) ? `${r.tools} ${r.tools === 1 ? 'tool' : 'tools'}` : (r.state || '')),
      );
      row.addEventListener('click', () => { selected = r.name; openDetail(); });
      listEl.appendChild(row);
    }
    body.appendChild(listEl);
    hint.textContent = '↑/↓ to move · Enter to open · Esc to close';
    backBtn.hidden = true;
    return listEl;
  }

  function field(label, value, cls) {
    const line = el('div', 'servers-field');
    line.append(el('span', 'servers-field-label', label), el('span', 'servers-field-value' + (cls ? ' ' + cls : ''), value));
    return line;
  }

  function renderDetail() {
    const row = current();
    if (!row) { view = 'list'; return renderList(); }
    body.append(...heading(title, row.name));
    const fields = el('div', 'servers-fields');
    fields.appendChild(field('Status', `${SERVERS_TONE_ICON[row.tone] || SERVERS_TONE_ICON.waiting} ${row.state || ''}`, 'servers-tone-' + (row.tone || 'waiting')));
    if (row.error) fields.appendChild(field('Error', row.error, 'servers-error'));
    // The tool count and nothing of the server's command or configuration (owner decision O2).
    if (Number.isFinite(row.tools)) fields.appendChild(field('Tools', `${row.tools} ${row.tools === 1 ? 'tool' : 'tools'}`));
    fields.appendChild(field('Configured in', row.group || ''));
    body.appendChild(fields);
    const menu = menuOf(row);
    if (actionAt >= menu.length) actionAt = Math.max(0, menu.length - 1);
    const menuEl = el('div', 'servers-menu');
    menuEl.setAttribute('role', 'listbox');
    menuEl.setAttribute('aria-label', `What to do with ${row.name}`);
    menuEl.tabIndex = 0;
    menu.forEach((a, i) => {
      const item = el('div', 'servers-action', `${i + 1}. ${a.label}`);
      item.setAttribute('role', 'option');
      item.dataset.action = a.id;
      const on = i === actionAt;
      item.classList.toggle('selected', on);
      item.setAttribute('aria-selected', on ? 'true' : 'false');
      if (busy) item.classList.add('disabled');
      item.addEventListener('click', () => { actionAt = i; run(a); });
      menuEl.appendChild(item);
    });
    if (!menu.length) menuEl.appendChild(el('div', 'servers-empty', 'Nothing can be done to this server from here.'));
    body.appendChild(menuEl);
    hint.textContent = '↑/↓ to move · Enter or a number to pick · Esc to go back';
    backBtn.hidden = false;
    return menuEl;
  }

  function renderTools() {
    const row = current();
    if (!row) { view = 'list'; return renderList(); }
    body.append(...heading(title, `${row.name} — tools`));
    const listEl = el('div', 'servers-list servers-tools');
    listEl.tabIndex = 0;
    const tools = Array.isArray(row.toolList) ? row.toolList : [];
    for (const t of tools) {
      const line = el('div', 'servers-row');
      line.appendChild(el('span', 'servers-name', t.name));
      const tags = [t.readOnly ? 'read-only' : '', t.destructive ? 'destructive' : ''].filter(Boolean).join(' · ');
      if (tags) line.appendChild(el('span', 'servers-meta' + (t.destructive ? ' servers-error' : ''), tags));
      listEl.appendChild(line);
    }
    if (!tools.length) listEl.appendChild(el('div', 'servers-empty', 'The server lists no tools.'));
    body.appendChild(listEl);
    hint.textContent = 'Esc to go back';
    backBtn.hidden = false;
    return listEl;
  }

  function renderConfirm() {
    const row = current();
    const a = row && rowActions(row).find(x => x.id === pendingConfirm);
    if (!row || !a) { view = 'detail'; pendingConfirm = null; actionAt = 0; return renderDetail(); }
    body.append(...heading(title, `${a.label} ${row.name}?`));
    body.appendChild(el('p', 'servers-confirm', a.confirm || ''));
    const choices = [{ id: 'yes', label: a.label }, { id: 'no', label: 'Cancel' }];
    const menuEl = el('div', 'servers-menu');
    menuEl.setAttribute('role', 'listbox');
    menuEl.tabIndex = 0;
    choices.forEach((c, i) => {
      const item = el('div', 'servers-action', `${i + 1}. ${c.label}`);
      item.setAttribute('role', 'option');
      const on = i === actionAt;
      item.classList.toggle('selected', on);
      item.setAttribute('aria-selected', on ? 'true' : 'false');
      item.addEventListener('click', () => { actionAt = i; confirmChoice(); });
      menuEl.appendChild(item);
    });
    body.appendChild(menuEl);
    hint.textContent = '↑/↓ to move · Enter to pick · Esc to cancel';
    backBtn.hidden = false;
    return menuEl;
  }

  let callbackInput = null;
  function renderCallback() {
    const row = current();
    if (!row) { view = 'list'; return renderList(); }
    body.append(...heading(title, `Sign in to ${row.name}`));
    body.appendChild(el('p', 'servers-confirm',
      'If the browser could not return to the app after you signed in, copy the address it ended on and paste it here.'));
    callbackInput = el('input', 'servers-input');
    callbackInput.type = 'text';
    callbackInput.placeholder = 'http://localhost:…/callback?code=…';
    callbackInput.setAttribute('aria-label', 'The address the browser ended on');
    body.appendChild(callbackInput);
    const send = el('button', 'control-dialog-confirm servers-send', 'Send');
    send.type = 'button';
    send.addEventListener('click', submitCallback);
    body.appendChild(send);
    hint.textContent = 'Enter to send · Esc to go back';
    backBtn.hidden = false;
    return callbackInput;
  }

  let pendingConfirm = null;
  function render(focus = true) {
    if (closed) return;
    // A poll must not rebuild the page the user is pasting into: that would empty the field under them.
    if (!focus && view === 'callback' && callbackInput && body.contains(callbackInput)) {
      paintStatus();
      return;
    }
    const had = dialog.contains(document.activeElement);
    body.replaceChildren();
    const target = view === 'detail' ? renderDetail()
      : view === 'tools' ? renderTools()
        : view === 'confirm' ? renderConfirm()
          : view === 'callback' ? renderCallback()
            : renderList();
    paintStatus();
    if (target && (focus || had)) target.focus();
    const sel = body.querySelector('.selected');
    if (sel && typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'nearest' });
  }

  function paintStatus() {
    status.textContent = busy ? `${busy}…` : (message ? message.text : '');
    status.className = 'servers-message' + (!busy && message ? ' servers-message-' + message.tone : '');
  }

  async function reload() {
    let res;
    try { res = await load(); } catch { res = null; }
    if (closed) return;
    if (res && res.ok && res.list) take(res.list);
    else if (!busy) message = { tone: 'failed', text: (res && res.error) || 'The session did not list its MCP servers.' };
    followSignIn();
    render(false);
    schedulePoll();
  }

  // Asked again while a server is still connecting or a sign-in is being given; otherwise the list stands.
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (closed) return;
    const moving = rows.some(r => r.tone === 'waiting' && r.state === 'connecting');
    if (!moving && !signIn) return;
    pollTimer = setTimeout(reload, SERVERS_POLL_MS);
  }

  // A sign-in ends when the server no longer waits for one. Then it is reconnected (owner decision O3), unless the
  // runtime already brought it up; a sign-in nobody finished is given up after a while.
  function followSignIn() {
    if (!signIn) return;
    const row = rows.find(r => r.name === signIn.name);
    if (!row) { signIn = null; return; }
    if (!row.needsSignIn) {
      const name = signIn.name;
      signIn = null;
      if (row.tone === 'ok') { message = { tone: 'ok', text: `Signed in to ${name}.` }; return; }
      doAction(name, { id: 'reconnect', label: 'Reconnect' }, {}, `Signed in to ${name}.`);
      return;
    }
    if (Date.now() - signIn.since > SERVERS_SIGN_IN_WAIT_MS) {
      signIn = null;
      message = { tone: 'info', text: `No sign-in arrived for ${row.name}. Pick Authenticate to try again.` };
    }
  }

  async function doAction(name, a, extra, doneText) {
    busy = `${a.label} ${name}`;
    message = null;
    render(false);
    let res;
    try { res = await act(name, a.id, extra || {}); } catch { res = null; }
    if (closed) return;
    busy = '';
    if (!res || !res.ok) {
      message = { tone: 'failed', text: (res && res.error) || `${a.label} did not work.` };
    } else if (a.id === 'authenticate' && res.authUrl) {
      signIn = { name, since: Date.now() };
      openUrl(res.authUrl);
      message = { tone: 'info', text: `Finish signing in to ${name} in your browser. The server is reconnected once you have.` };
    } else {
      message = { tone: 'ok', text: doneText || `${a.label}: done.` };
      if (a.id === 'callback') view = 'detail';
    }
    await reload();
  }

  function run(a) {
    const row = current();
    if (!row || !a || busy) return;
    if (a.id === 'tools') { view = 'tools'; render(); return; }
    if (a.id === 'callback') { view = 'callback'; render(); return; }
    if (a.confirm) { pendingConfirm = a.id; actionAt = 1; view = 'confirm'; render(); return; }
    doAction(row.name, a);
  }

  function confirmChoice() {
    const row = current();
    const a = row && rowActions(row).find(x => x.id === pendingConfirm);
    const yes = actionAt === 0;
    view = 'detail';
    pendingConfirm = null;
    actionAt = 0;
    if (yes && a) doAction(row.name, a);
    else render();
  }

  function submitCallback() {
    const row = current();
    const url = callbackInput ? callbackInput.value.trim() : '';
    if (!row || !url || busy) return;
    doAction(row.name, { id: 'callback', label: 'Sign in' }, { callbackUrl: url }, `Signed in to ${row.name}.`);
  }

  function openDetail() { view = 'detail'; actionAt = 0; message = null; render(); }

  function back() {
    if (view === 'list') { close(); return; }
    if (view === 'detail') view = 'list';
    else if (view === 'confirm') { view = 'detail'; pendingConfirm = null; actionAt = 0; }
    else view = 'detail';
    render();
  }

  function moveList(delta) {
    if (!rows.length) return;
    const at = rows.findIndex(r => r.name === selected);
    const next = !Number.isFinite(delta) ? (delta > 0 ? rows.length - 1 : 0)
      : at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta));
    selected = rows[next].name;
    render();
  }

  function moveMenu(delta, size) {
    if (!size) return;
    actionAt = !Number.isFinite(delta) ? (delta > 0 ? size - 1 : 0) : Math.max(0, Math.min(size - 1, actionAt + delta));
    render();
  }

  const releaseFocus = trapControlDialogFocus(overlay, dialog);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(pollTimer);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    releaseFocus();
    if (typeof onClose === 'function') onClose();
  }

  // What Tab walks through on this page: its list, menu or field, then the buttons. The shared trap knows only
  // buttons and inputs, so a focused list would let Shift+Tab leave the dialog.
  function tabStops() {
    const main = body.querySelector('.servers-list, .servers-menu, .servers-input');
    return [main, ...body.querySelectorAll('button'), backBtn.hidden ? null : backBtn, closeBtn].filter(Boolean);
  }

  function onKey(event) {
    if (closed) return;
    // Only while this dialog is the top one: a dialog opened over it keeps its own keys.
    const overlays = document.querySelectorAll('.control-dialog-overlay');
    if (overlays[overlays.length - 1] !== overlay) return;
    if (event.key === 'Tab') {
      const stops = tabStops();
      const at = stops.indexOf(document.activeElement);
      const next = stops[(at < 0 ? 0 : at + (event.shiftKey ? stops.length - 1 : 1)) % stops.length];
      event.preventDefault();
      event.stopPropagation();
      if (next) next.focus();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); return; }
    if (view === 'callback') {
      if (event.key === 'Enter' && event.target === callbackInput) { event.preventDefault(); submitCallback(); }
      return;
    }
    // A chord belongs to the app's shortcuts, never to this menu: Ctrl+2 must not sign anyone out.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // A button with the focus keeps its own Enter and Space.
    if (event.target && event.target.closest && event.target.closest('button')) return;
    const key = event.key;
    const nav = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[key];
    if (view === 'list') {
      if (nav !== undefined) { event.preventDefault(); moveList(nav); }
      else if (key === 'Enter' && current()) { event.preventDefault(); openDetail(); }
      return;
    }
    if (view === 'tools') return;
    const size = view === 'confirm' ? 2 : menuOf(current()).length;
    if (nav !== undefined) { event.preventDefault(); moveMenu(nav, size); return; }
    const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
    if (key === 'Enter' || (digit >= 0 && digit < size)) {
      event.preventDefault();
      if (digit >= 0) actionAt = digit;
      if (view === 'confirm') confirmChoice();
      else run(menuOf(current())[actionAt]);
    }
  }

  backBtn.addEventListener('click', back);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  // Capture, so the conversation behind the dialog (its Escape stops a turn) never sees these keys.
  document.addEventListener('keydown', onKey, true);

  take(list);
  document.body.appendChild(overlay);
  render();
  schedulePoll();
  return { close };
}
