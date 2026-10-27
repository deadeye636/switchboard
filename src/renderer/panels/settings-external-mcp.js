// settings-external-mcp.js — the project's `externalMcpServers` editor: cards over one JSON text area (#789, spec 36).
//
// The TEXT AREA is the store and the cards are a projection of it (slice B): a card operation (switch, remove)
// parses the text, changes the one RAW entry (never the validator's normalised copy), writes the list back as pretty
// JSON and redraws; a text edit redraws the cards on blur. The list is checked by the same validator the injection
// uses (shared/external-mcp-validate.js, loaded before this file); the cards and the form add no rule of their own.
// Add / Edit open one inline form (#sv-external-mcp-form) over shared/external-mcp-form.js (entryToForm / formToEntry,
// loaded before this file and read at call time): confirm splices the built entry into the parsed raw list, runs the
// WHOLE list through the validator and writes the text only when no entry is newly rejected.
//
// The panel owns the save: `read()` is called by persistSettings, which stores `list` on the project blob
// through the ordinary settings write and REFUSES the save when `problem` is set — an entry that would be
// dropped silently at launch is told to the user now. A literal-secret warning never blocks. Nothing persists
// before Save (the settings window is a snapshot). Loaded in settings.html only. It names no backend.
//
// Facts line (slice D, D-D10): each card shows what `window.api.checkExternalMcp` said about its command, variables and
// backends. The check runs after the backends load, after a card operation or form confirm, on the text area's blur and
// on "Check again"; a sequence number drops a stale reply, a failed one keeps the last facts, and nothing here feeds
// `read()` or `check()`, so the facts never block Save. Reason codes map to sentences in REASON_SENTENCES (no backend name).
//
// Backends chips: an entry's `backends` filter shows as chips on its card (none = every backend, said in words) and is
// edited as toggle chips in the form (none selected = no `backends` key). The choosable backends are every enabled
// non-profile backend `window.api.backends.list()` serves (id, label), fetched once in `bind`; cards draw first and redraw when
// the list resolves, and a failed call leaves the stored ids visible as raw chips. The id -> label mapping comes only
// from that list; a stored id the list does not know is shown as "unknown" and kept on every write.
//
// The GLOBAL scope's "MCP servers" category (#790, spec 38) lives here too (`bindAddons`), because it reuses this file's
// `reasonSentence`, `node` and `cardButton`. It reads the catalog module (shared/mcp-addon-catalog.js, loaded before this
// file: MCP_ADDON_CATALOG, commandLine, probeEntries, readProbe) at call time. Every catalog and registry string is set
// with textContent. The PATH check reuses `checkExternalMcp` with no project; the registry search is
// `window.api.searchMcpRegistry`, only on Search or Enter. It stores nothing and runs nothing.
(function () {
  'use strict';

  const SETTING_KEY = 'externalMcpServers';
  const PRUNE_KEY = 'externalMcpPrune';
  const PRUNE_ID = 'sv-external-mcp-prune';
  const PRUNE_LIST_ID = 'sv-external-mcp-prune-list';
  const TEXT_ID = 'sv-external-mcp';
  const STATUS_ID = 'sv-external-mcp-status';
  const CARDS_ID = 'sv-external-mcp-cards';
  const JSON_ID = 'sv-external-mcp-json';
  const ADD_ID = 'sv-external-mcp-add';
  const FORM_ID = 'sv-external-mcp-form';
  const CHECK_ID = 'sv-external-mcp-check';
  const CHECK_NOTE_ID = 'sv-external-mcp-check-note';

  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  // The backends the app serves, [{ id, label }], or null while unresolved / after a failed call.
  let choices = null;
  // Redraws the chips of the open form once the list resolves (null while no form is open).
  let formChipsRefresh = null;
  // What each served backend answers for the `mcpPrune` capability, [{ label, state, note }], or null while unresolved.
  let pruneRows = null;

  // The static check (D-D10): what main last said about each entry, keyed by the entry's own JSON so a reply never
  // lands on a card whose entry has since changed. `checkSeq` drops a stale reply; `checkFailed` keeps the last facts.
  let factsByKey = new Map();
  let checkSeq = 0;
  let checkFailed = false;
  let checkProjectPath = null;

  // Reason code -> sentence. The codes are main's closed sets (REASONS in src/app/external-mcp-check.js); a code this
  // file does not know gets the neutral sentence. Data only: no backend is named here, labels come from the reply.
  const NEUTRAL_REASON = 'the reason is not known to this version';
  const REASON_SENTENCES = {
    command: {
      'network': 'a folder on PATH is on a network share and was left alone',
      'unreadable': 'a folder on PATH could not be read',
      'timeout': 'looking through PATH took too long',
      'relative-path-entry': 'PATH has a relative folder, which this check does not search',
      'unexpanded-path-entry': 'PATH has a folder with an unexpanded %VARIABLE%, which this check does not search; fix it in the Windows PATH environment variable',
      'no-cwd': 'the command is a relative path and the project folder is not known',
      'empty-name': 'the command is empty',
      'unset-variable': 'the command uses a variable that is not set',
      'path-overridden': 'a backend variable or the server itself sets its own PATH, which was not searched',
      'backend-env-varies': 'the command or working directory depends on backend variables',
    },
    takes: {
      'entry-disabled': 'the server is switched off',
      'backend-filter': "the server's backend list leaves it out",
      'unset-variable': 'a variable it needs is not set',
      'transport': 'it does not take this kind of server',
      'cwd': 'it cannot set a working directory',
      'no-channel': 'it has no way to receive external servers',
    },
  };

  /** The sentence for a reason code of one kind ('command' | 'takes'); unknown codes get a neutral one. */
  function reasonSentence(kind, code) {
    const table = REASON_SENTENCES[kind];
    return table && typeof code === 'string' && Object.prototype.hasOwnProperty.call(table, code) ? table[code] : NEUTRAL_REASON;
  }

  const SAVED_VARIABLES = 'Checked against the saved global variables.';

  /** One result of the check -> [{ kind: 'command' | 'variables' | 'backends', text, tone: 'info' | 'warn' }]. */
  function factLines(r) {
    const out = [];
    if (!r || r.rejected) return out;
    const takes = Array.isArray(r.takes) ? r.takes.filter(t => t && typeof t.id === 'string') : [];
    const labelOf = (id) => { const t = takes.find(x => x.id === id); return String(t && t.label ? t.label : id); };

    const c = r.command || {};
    if (c.state === 'found') {
      const ext = typeof c.ext === 'string' && c.ext ? ' (' + c.ext + ')' : '';
      if (c.executable === false) out.push({ kind: 'command', text: 'Command: found' + ext + ', but the file is not marked as executable.', tone: 'info' });
      else out.push({ kind: 'command', text: 'Command: found' + ext + '.', tone: 'info' });
    } else if (c.state === 'missing') {
      out.push({ kind: 'command', text: 'Command: would not start (not found).', tone: 'warn' });
    } else if (c.state === 'unknown') {
      out.push({ kind: 'command', text: 'Command: not checked, ' + reasonSentence('command', c.reason) + '.', tone: 'info' });
    }

    const vars = Array.isArray(r.variables) ? r.variables.filter(v => v && typeof v.name === 'string') : [];
    if (vars.length) {
      const setNames = []; const unset = []; const unresolved = []; const defaulted = [];
      const add = (list, s) => { if (!list.includes(s)) list.push(s); };
      for (const v of vars) {
        if (v.state === 'unset') add(unset, v.name);
        else if (v.state === 'declared-unresolved') add(unresolved, v.name);
        else if (v.state === 'default') add(defaulted, v.name);
        else if (v.state === 'backend-env') {
          const ids = Array.isArray(v.backendIds) ? v.backendIds : [];
          add(setNames, ids.length ? `${v.name} (for ${ids.map(labelOf).join(', ')})` : v.name);
        } else add(setNames, v.name);
      }
      const parts = [];
      if (setNames.length) parts.push('set ' + setNames.join(', '));
      if (defaulted.length) parts.push(defaulted.map(n => n + ' (default used)').join(', '));
      if (unset.length) parts.push('unset ' + unset.join(', '));
      if (unresolved.length) parts.push('without a usable value ' + unresolved.join(', '));
      const note = (unresolved.length || r.envGap) ? ' ' + SAVED_VARIABLES : '';
      out.push({ kind: 'variables', text: 'Variables: ' + parts.join('; ') + '.' + note, tone: unset.length || unresolved.length ? 'warn' : 'info' });
    }

    if (takes.length) {
      const yes = takes.filter(t => t.takes === true).map(t => String(t.label || t.id));
      const no = takes.filter(t => t.takes !== true).map(t => `${t.label || t.id} (${reasonSentence('takes', t.reason)})`);
      const parts = [];
      if (yes.length) parts.push('taken by ' + yes.join(', '));
      if (no.length) parts.push('not taken by ' + no.join(', '));
      out.push({ kind: 'backends', text: 'Backends: ' + parts.join('; ') + '.', tone: 'info' });
    }
    return out;
  }

  /** The facts block for one raw entry, or null while there is nothing to say. -> { el, title } */
  function factsNode(raw) {
    const r = factsByKey.get(JSON.stringify(raw));
    const lines = factLines(r);
    if (!lines.length) return null;
    const el = node('div', 'sv-mcp-card-facts');
    for (const l of lines) el.appendChild(node('div', l.tone === 'warn' ? 'sv-mcp-warning' : 'settings-hint', l.text));
    const resolved = r.command && r.command.state === 'found' && typeof r.command.resolved === 'string' ? r.command.resolved : '';
    return { el, title: resolved };
  }

  /** Ask main for the facts of the listed entries. Last request wins; a failed one keeps what is shown and says so once. */
  async function runCheck(body, signal) {
    if (signal.aborted || !window.api || typeof window.api.checkExternalMcp !== 'function') return;
    const ta = body.querySelector('#' + TEXT_ID);
    if (!ta) return;
    const parsed = parseList(ta.value);
    if (parsed.error) return;
    const list = parsed.list;
    const seq = ++checkSeq;
    let res = null;
    try { res = await window.api.checkExternalMcp(checkProjectPath, list); } catch { res = null; }
    // The window may have closed while main answered; a panel no longer in a live document draws nothing.
    if (signal.aborted || seq !== checkSeq || !body.isConnected || !(body.ownerDocument && body.ownerDocument.defaultView)) return;
    if (res && res.ok === true && Array.isArray(res.results)) {
      const next = new Map();
      for (const r of res.results) {
        if (r && !r.rejected && Number.isInteger(r.index) && r.index >= 0 && r.index < list.length) next.set(JSON.stringify(list[r.index]), r);
      }
      factsByKey = next;
      checkFailed = false;
    } else {
      checkFailed = true;
    }
    const note = body.querySelector('#' + CHECK_NOTE_ID);
    if (note) {
      note.textContent = !checkFailed ? ''
        : factsByKey.size ? 'The check could not run. The facts shown are from the last check.' : 'The check could not run.';
    }
    // The facts are stored; while the user types in the JSON the cards are not redrawn under them (the blur draws).
    if (ta.ownerDocument.activeElement === ta) return;
    renderCards(body, signal);
  }

  // Unset and [] are blank; anything else is shown as it is, so a stored null or object is visible and fixable.
  const toText = (list) => (list === undefined || (Array.isArray(list) && !list.length) ? '' : JSON.stringify(list, null, 2));

  /** The text as a list the cards can show -> { list } | { error: sentence }. Blank is an empty list. */
  function parseList(text) {
    const raw = String(text || '').trim();
    if (!raw) return { list: [] };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { error: 'The text is not valid JSON' + (err && err.message ? ': ' + err.message : '') + '.' };
    }
    if (!Array.isArray(parsed)) return { error: 'The text is valid JSON but not a list (an array of servers).' };
    return { list: parsed };
  }

  /** Check the text -> { list, problems: string[], warnings: string[] }. Blank text is an empty list. */
  function check(text) {
    const raw = String(text || '').trim();
    if (!raw) return { list: [], problems: [], warnings: [] };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { list: null, problems: ['MCP servers is not valid JSON: ' + (err && err.message ? err.message : 'parse error')], warnings: [] };
    }
    const res = window.validateExternalMcpServers(parsed);
    const label = (r) => (r.index < 0 ? 'The list' : `Entry ${r.index + 1}${r.name ? ` ("${r.name}")` : ''}`);
    return {
      list: parsed,
      problems: res.rejected.map(r => `${label(r)}: ${r.reason}`),
      warnings: res.warnings.map(w => `Entry ${w.index + 1} ("${w.name}"): ${w.message}`),
    };
  }

  function showStatus(body, res) {
    const el = body.querySelector('#' + STATUS_ID);
    if (!el) return;
    el.textContent = '';
    const add = (lines, cls) => lines.forEach(line => {
      const div = document.createElement('div');
      div.textContent = line;
      div.className = cls;
      el.appendChild(div);
    });
    add(res.problems, 'sv-mcp-problem');
    add(res.warnings, 'sv-mcp-warning');
  }

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function cardButton(label, onClick, signal, opts) {
    const b = node('button', 'settings-action-btn' + (opts && opts.danger ? ' danger' : ''), label);
    b.type = 'button';
    if (opts && opts.disabled) b.disabled = true;
    else b.addEventListener('click', onClick, { signal });
    return b;
  }

  /** One card. `index` is the entry's place in the stored list; `reason`/`warnings` come from the one validator. */
  function buildCard(raw, index, reason, warnings, onToggle, onRemove, onEdit, signal) {
    const obj = isPlainObject(raw) ? raw : {};
    const card = node('div', 'sv-mcp-card' + (reason ? ' sv-mcp-card-rejected' : ''));
    const info = node('div', 'sv-mcp-card-info');
    const head = node('div', 'sv-mcp-card-head');
    head.appendChild(node('span', 'settings-label', typeof obj.name === 'string' && obj.name ? obj.name : '(no name)'));
    head.appendChild(node('span', 'sv-mcp-card-transport', obj.transport === 'http' || obj.transport === 'stdio' ? obj.transport : 'transport?'));
    info.appendChild(head);
    const ids = Array.isArray(obj.backends) ? obj.backends.filter(b => typeof b === 'string') : [];
    if (!ids.length) info.appendChild(node('div', 'settings-hint sv-mcp-card-backends', 'All backends'));
    else {
      const chips = node('div', 'sv-mcp-chips');
      for (const id of ids) {
        const known = choices && choices.find(c => c.id === id);
        chips.appendChild(known ? node('span', 'sv-mcp-chip', known.label)
          : node('span', 'sv-mcp-chip' + (choices ? ' sv-mcp-chip-unknown' : ''), choices ? id + ' (unknown)' : id));
      }
      info.appendChild(chips);
    }
    if (!reason) {
      const facts = factsNode(raw);
      if (facts) {
        info.appendChild(facts.el);
        if (facts.title) card.title = facts.title;
      }
    }
    if (reason) info.appendChild(node('div', 'sv-mcp-problem', 'Not used at launch: ' + reason));
    for (const w of warnings) info.appendChild(node('div', 'sv-mcp-warning', w));
    card.appendChild(info);

    const actions = node('div', 'sv-mcp-card-actions');
    if (!reason) {
      const sw = node('label', 'settings-toggle');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = obj.enabled !== false;
      cb.setAttribute('aria-label', 'Use ' + obj.name + ' in this project');
      cb.addEventListener('change', () => onToggle(index, cb.checked), { signal });
      sw.appendChild(cb);
      sw.appendChild(node('span', 'settings-toggle-slider'));
      actions.appendChild(sw);
    }
    actions.appendChild(cardButton('Edit', () => onEdit(index), signal));
    actions.appendChild(cardButton('Remove', () => onRemove(index), signal, { danger: true }));
    card.appendChild(actions);
    return card;
  }

  /** Draw the cards from the text area. A text that is not a list shows no cards, says why and opens the JSON view. */
  function renderCards(body, signal) {
    const region = body.querySelector('#' + CARDS_ID);
    const ta = body.querySelector('#' + TEXT_ID);
    if (!region || !ta) return;
    const addBtn = body.querySelector('#' + ADD_ID);
    const parsed = parseList(ta.value);
    region.textContent = '';
    // The nav count is the number of servers drawn (the entry is data-count-own, so the generic field walk skips it).
    const badge = body.querySelector('.settings-nav-item[data-cat="mcp"] .settings-nav-count');
    if (badge) {
      const n = parsed.error ? 0 : parsed.list.length;
      badge.textContent = n ? String(n) : '';
      badge.hidden = !n;
    }
    if (addBtn) addBtn.disabled = !!parsed.error; // the form is never reachable while the text is not a list
    const againBtn = body.querySelector('#' + CHECK_ID);
    if (againBtn) againBtn.disabled = !!parsed.error; // nothing to check while the text is not a list
    if (parsed.error) {
      closeForm(body);
      region.appendChild(node('div', 'sv-mcp-problem', 'Cards are unavailable. ' + parsed.error + ' Fix it in the JSON below.'));
      const details = body.querySelector('#' + JSON_ID);
      if (details) details.open = true;
      return;
    }
    if (!parsed.list.length) {
      region.appendChild(node('div', 'settings-hint sv-mcp-empty', 'No servers yet.'));
      return;
    }
    const res = window.validateExternalMcpServers(parsed.list);
    const reasons = new Map(res.rejected.map(r => [r.index, r.reason]));
    const warns = new Map();
    for (const w of res.warnings) warns.set(w.index, (warns.get(w.index) || []).concat(w.message));
    // A card operation re-parses the text, changes the raw entry and writes the list back: the text stays the store.
    const edit = (change) => {
      const now = parseList(ta.value);
      if (now.error) { renderCards(body, signal); return; }
      closeForm(body); // an open form holds an index a card operation may move
      change(now.list);
      ta.value = toText(now.list);
      showStatus(body, check(ta.value));
      renderCards(body, signal);
      runCheck(body, signal);
    };
    parsed.list.forEach((raw, i) => {
      region.appendChild(buildCard(raw, i, reasons.get(i) || '', warns.get(i) || [],
        (idx, on) => edit(list => { if (isPlainObject(list[idx])) list[idx].enabled = on; }),
        (idx) => edit(list => { list.splice(idx, 1); }),
        (idx) => openForm(body, signal, idx),
        signal));
    });
  }

  function closeForm(body) {
    const host = body.querySelector('#' + FORM_ID);
    if (host) host.textContent = '';
    formChipsRefresh = null;
  }

  /** Toggle chips for the backends filter -> { el, read(), refresh() }. Stored ids the list lacks stay selectable chips. */
  function backendChips(initial, signal) {
    const el = node('div', 'sv-mcp-chips');
    const stored = Array.from(new Set(initial));
    const selected = new Set(stored);
    const items = () => {
      const known = choices || [];
      const knownIds = new Set(known.map(c => c.id));
      return known.map(c => ({ id: c.id, label: c.label, unknown: false }))
        .concat(stored.filter(id => !knownIds.has(id)).map(id => ({ id, label: choices ? id + ' (unknown)' : id, unknown: !!choices })));
    };
    const draw = () => {
      el.textContent = '';
      for (const it of items()) {
        const b = node('button', 'settings-action-btn sv-mcp-chip' + (it.unknown ? ' sv-mcp-chip-unknown' : '') + (selected.has(it.id) ? ' active' : ''), it.label);
        b.type = 'button';
        b.setAttribute('aria-pressed', selected.has(it.id) ? 'true' : 'false');
        b.addEventListener('click', () => {
          if (selected.has(it.id)) selected.delete(it.id); else selected.add(it.id);
          draw();
        }, { signal });
        el.appendChild(b);
      }
    };
    draw();
    // Served order first, then the stored ids the list does not know, in their stored order.
    return { el, read: () => items().map(it => it.id).filter(id => selected.has(id)), refresh: draw };
  }

  function field(label, control, hint) {
    const f = node('div', 'sv-mcp-form-field');
    f.appendChild(node('span', 'settings-label', label));
    f.appendChild(control);
    if (hint) f.appendChild(node('div', 'settings-hint', hint));
    return f;
  }

  function textInput(value, placeholder) {
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'settings-input';
    i.spellcheck = false;
    i.value = value || '';
    if (placeholder) i.placeholder = placeholder;
    return i;
  }

  /** Rows of a name input (and a value input when `withValue`), Remove per row, an Add row control -> { el, read() }. */
  function rowList(rows, withValue, signal, placeholders) {
    const el = node('div', 'sv-mcp-rows');
    const list = node('div', 'sv-mcp-rows-list');
    const inputs = [];
    const addRow = (row) => {
      const line = node('div', 'sv-mcp-row');
      const name = textInput(row.name, placeholders[0]);
      const value = withValue ? textInput(row.value, placeholders[1]) : null;
      const entry = { name, value };
      inputs.push(entry);
      line.appendChild(name);
      if (value) line.appendChild(value);
      line.appendChild(cardButton('Remove', () => { line.remove(); inputs.splice(inputs.indexOf(entry), 1); }, signal, { danger: true }));
      list.appendChild(line);
    };
    rows.forEach(addRow);
    el.appendChild(list);
    el.appendChild(cardButton('Add row', () => addRow({ name: '', value: '' }), signal));
    return { el, read: () => inputs.map(r => ({ name: r.name.value, value: r.value ? r.value.value : '' })) };
  }

  /**
   * Open the inline form. `index` null = Add; a number = Edit that entry, seeded through entryToForm. An Add may carry
   * `seedEntry` (a raw entry, #790's catalog hand-off): the form starts from it, and nothing is written until Add.
   */
  function openForm(body, signal, index, seedEntry) {
    const host = body.querySelector('#' + FORM_ID);
    const ta = body.querySelector('#' + TEXT_ID);
    if (!host || !ta) return false;
    const parsed = parseList(ta.value);
    if (parsed.error || (index !== null && index >= parsed.list.length)) return false;
    const seed = window.entryToForm(index === null ? (seedEntry || {}) : parsed.list[index]);
    host.textContent = '';
    const formEl = node('div', 'sv-mcp-form');
    formEl.appendChild(node('div', 'settings-section-title', index === null ? 'Add server' : 'Edit server'));

    const name = textInput(seed.name, 'docs');
    const type = document.createElement('select');
    type.className = 'settings-select';
    [['stdio', 'STDIO'], ['http', 'Streamable HTTP']].forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      type.appendChild(o);
    });
    type.value = seed.transport;
    formEl.appendChild(field('Name', name));
    formEl.appendChild(field('Type', type));

    const stdio = node('div', 'sv-mcp-form-group');
    const command = textInput(seed.command, 'npx');
    const args = document.createElement('textarea');
    args.className = 'settings-input';
    args.spellcheck = false;
    args.rows = 3;
    args.value = seed.args;
    const env = rowList(seed.envRows, true, signal, ['NAME', 'value']);
    const pass = rowList(seed.passthrough.map(n => ({ name: n })), false, signal, ['NAME']);
    const cwd = textInput(seed.cwd);
    stdio.appendChild(field('Command', command));
    stdio.appendChild(field('Arguments', args, 'One argument per line. An argument with a space stays one line.'));
    stdio.appendChild(field('Environment variables', env.el, 'Keep secrets out: write a ${VAR} reference as the value.'));
    stdio.appendChild(field('Environment variable passthrough', pass.el, 'Names taken from the environment Switchboard runs in.'));
    stdio.appendChild(field('Working directory', cwd));

    const httpGroup = node('div', 'sv-mcp-form-group');
    const url = textInput(seed.url, 'https://example.com/mcp');
    const headers = rowList(seed.headerRows, true, signal, ['Header', 'value']);
    httpGroup.appendChild(field('URL', url));
    httpGroup.appendChild(field('Headers', headers.el, 'Keep secrets out: write a ${VAR} reference as the value.'));
    formEl.appendChild(stdio);
    formEl.appendChild(httpGroup);
    const chips = backendChips(seed.backends, signal);
    formEl.appendChild(field('Backends', chips.el, 'None selected means every backend.'));
    formChipsRefresh = chips.refresh;
    const syncType = () => {
      stdio.hidden = type.value !== 'stdio';
      httpGroup.hidden = type.value !== 'http';
    };
    type.addEventListener('change', syncType, { signal });
    syncType();

    const msg = node('div', 'sv-mcp-problem sv-mcp-form-msg');
    const confirm = () => {
      msg.textContent = '';
      const now = parseList(ta.value);
      if (now.error) { msg.textContent = now.error; return; }
      const entry = window.formToEntry({
        ...seed,
        name: name.value,
        transport: type.value,
        command: command.value,
        args: args.value,
        envRows: env.read(),
        passthrough: pass.read().map(r => r.name),
        cwd: cwd.value,
        url: url.value,
        headerRows: headers.read(),
        backends: chips.read(),
      });
      const next = now.list.slice();
      if (index === null) next.push(entry);
      else if (index < next.length) next[index] = entry;
      else { msg.textContent = 'That server is no longer in the list.'; return; }
      // The one validator over the whole resulting list: refuse when this write newly rejects any entry.
      // An entry is the same rejection by name and reason, not by index: an already-rejected entry keeps its index
      // when it is edited into a duplicate of a valid one, and that must still count as new.
      const rejectionKey = (r) => `${r.name === undefined ? '' : r.name}\u0000${r.reason}`;
      const before = new Set(window.validateExternalMcpServers(now.list).rejected.map(rejectionKey));
      const fresh = window.validateExternalMcpServers(next).rejected.filter(r => !before.has(rejectionKey(r)));
      if (fresh.length) {
        msg.textContent = fresh.map(r => (r.name ? `"${r.name}": ` : '') + r.reason).join('\n');
        return;
      }
      ta.value = toText(next);
      closeForm(body);
      showStatus(body, check(ta.value));
      renderCards(body, signal);
      runCheck(body, signal);
    };
    const actions = node('div', 'sv-mcp-form-actions');
    actions.appendChild(cardButton(index === null ? 'Add' : 'Save changes', confirm, signal));
    actions.appendChild(cardButton('Cancel', () => closeForm(body), signal));
    formEl.appendChild(msg);
    formEl.appendChild(actions);
    host.appendChild(formEl);
    return true;
  }

  /**
   * #790: open the Add form prefilled from a catalog entry (the seed a global "Add to project" sent). Only an id the
   * catalog knows opens anything; the entry comes from the catalog itself, never from the seed. -> opened or not.
   */
  function openSeeded(body, signal, id) {
    const item = typeof window.findCatalogItem === 'function' ? window.findCatalogItem(id) : null;
    if (!item || !openForm(body, signal, null, window.entryFromCatalog(item))) return false;
    const host = body.querySelector('#' + FORM_ID);
    if (host && typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    return true;
  }

  /** The section markup. `list` is the stored value (anything; shown as it is, so a bad stored value can be fixed). */
  function sectionHtml(list, prune) {
    const chev = '<svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>';
    return `
        <section class="settings-cat" data-cat="mcp">
        <div class="settings-cat-head"><h2>MCP servers</h2><p>External MCP servers every session of this project gets, whatever CLI is running.</p></div>
        <div class="settings-section">
          <div class="settings-section-title">MCP servers</div>
          <div id="${CARDS_ID}" class="sv-mcp-cards"></div>
          <div class="sv-mcp-add"><button type="button" class="settings-action-btn" id="${ADD_ID}" disabled>Add server</button> <button type="button" class="settings-action-btn" id="${CHECK_ID}">Check again</button> <span id="${CHECK_NOTE_ID}" class="settings-hint" style="padding-left:8px;"></span></div>
          <div id="${FORM_ID}"></div>
          <div class="settings-hint" style="padding-left:0;">The switch turns a server off for this project without deleting it. Add or edit a server with the form; the JSON view below holds the same list, and a change in either shows in the other. Leave Backends empty to give a server to every backend, or pick the ones that should get it. A server marked as not used at launch blocks Save until you fix or remove it. Changes are stored when you press Save.</div>
        </div>
        <div class="settings-section">
          <div class="settings-field">
            <div class="settings-field-info">
              <span class="settings-label">Start sessions with only this project's MCP servers</span>
              <div class="settings-description">Hides every MCP server the CLI would load itself, so only the servers added above remain. Takes effect on the next session you start. Nothing in the CLI's own settings or config is changed.</div>
            </div>
            <div class="settings-field-control">
              <label class="settings-toggle"><input type="checkbox" id="${PRUNE_ID}" ${prune === true ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
            </div>
          </div>
          <div id="${PRUNE_LIST_ID}" class="settings-hint" style="padding-left:0;"></div>
        </div>
        <details class="settings-adv" id="${JSON_ID}">
          <summary>${chev}Edit as JSON</summary>
          <div class="settings-section">
          <div class="settings-field settings-field-wide">
            <div class="settings-field-info">
              <span class="settings-label">Servers (JSON)</span>
              <div class="settings-description">A JSON array. Each entry has a <code>name</code> and a <code>transport</code>: <code>"stdio"</code> with a <code>command</code> (and optional <code>args</code>, <code>env</code>, <code>cwd</code>), or <code>"http"</code> with a <code>url</code> (and optional <code>headers</code>). Optional on both: <code>enabled</code>, <code>backends</code>.</div>
              <div class="settings-more">Keep secrets out of the list: write <code>\${VAR}</code> references in <code>env</code> and <code>headers</code>, not the value. A stdio entry is a command started at launch. Servers behind OAuth are not supported. Takes effect on the next session you start.</div>
            </div>
            <div class="settings-field-control">
              <textarea class="settings-input" id="${TEXT_ID}" spellcheck="false" placeholder='[{ "name": "docs", "transport": "http", "url": "https://example.com/mcp" }]' style="width:100%;min-height:180px;font-family:monospace;font-size:12px;line-height:1.5;resize:vertical;box-sizing:border-box;">${escapeHtml(toText(list))}</textarea>
              <div id="${STATUS_ID}" class="settings-hint" style="padding-left:0;margin-top:6px;"></div>
            </div>
          </div>
          </div>
        </details>
        </section>`;
  }

  /** Draw what each backend does with the switch, from the served capability answers. Nothing while unresolved. */
  function renderPruneList(body) {
    const host = body.querySelector('#' + PRUNE_LIST_ID);
    if (!host) return;
    host.textContent = '';
    if (!pruneRows) return;
    for (const r of pruneRows) {
      const text = r.state === 'yes' ? 'applied' : r.state === 'limited' ? 'partly applied' : 'not applied';
      host.appendChild(node('div', '', `${r.label}: ${text}${r.note ? ' (' + r.note + ')' : ''}`));
    }
  }

  /** Ask main which backends exist; the cards and an open form redraw when it answers. A failed call changes nothing. */
  async function loadChoices(body, signal) {
    try {
      const res = await window.api.backends.list();
      if (signal.aborted) return;
      const served = ((res && res.backends) || [])
        .filter(b => b && b.enabled && !b.isProfile && typeof b.id === 'string');
      choices = served.map(b => ({ id: b.id, label: String(b.label || b.id) }));
      pruneRows = served.map(b => {
        const a = b.capabilities && b.capabilities.mcpPrune;
        return a && typeof a.state === 'string'
          ? { label: String(b.label || b.id), state: a.state, note: typeof a.note === 'string' ? a.note : '' }
          : null;
      }).filter(Boolean);
    } catch { return; }
    renderPruneList(body);
    renderCards(body, signal);
    if (formChipsRefresh) formChipsRefresh();
  }

  /**
   * Wire the section. Check and redraw the cards on blur, so the message is there before Save. The static check
   * (facts line) runs after the backends load, after a card operation or form confirm, on blur and on "Check again"
   * (disabled while the text is not a list); its reply is not drawn while the JSON text area has focus.
   */
  function bind(body, signal, projectPath) {
    const ta = body.querySelector('#' + TEXT_ID);
    if (!ta) return;
    checkProjectPath = typeof projectPath === 'string' && projectPath ? projectPath : null;
    factsByKey = new Map();
    checkFailed = false;
    checkSeq++; // a reply for an earlier panel is stale
    const run = () => {
      showStatus(body, check(ta.value));
      renderCards(body, signal);
    };
    ta.addEventListener('blur', () => { closeForm(body); run(); runCheck(body, signal); }, { signal });
    const add = body.querySelector('#' + ADD_ID);
    if (add) add.addEventListener('click', () => openForm(body, signal, null), { signal });
    const again = body.querySelector('#' + CHECK_ID);
    if (again) again.addEventListener('click', () => runCheck(body, signal), { signal });
    choices = null;
    run();
    loadChoices(body, signal).then(() => runCheck(body, signal));
  }

  /**
   * What Save writes. -> { list, problem, prune } — `problem` is a sentence (or '') and, when set, the caller refuses
   * the save and `list` is not to be written.
   */
  function read(body) {
    const ta = body.querySelector('#' + TEXT_ID);
    const sw = body.querySelector('#' + PRUNE_ID);
    const prune = !!(sw && sw.checked);
    if (!ta) return { list: undefined, problem: '', prune };
    const res = check(ta.value);
    showStatus(body, res);
    return { list: res.list, problem: res.problems.length ? res.problems.join('\n') : '', prune };
  }

  // ---- The global "MCP servers" category (#790, spec 38): the reviewed catalog, whether it is on PATH, the commands.

  const ADDONS_HOST_ID = 'sv-mcp-addons';
  const COPY_FLASH_MS = 1200;
  const COPY_FAILED = 'Could not copy. Select the text and copy it by hand.';
  const CHECK_FAILED = 'The check could not run.';
  const SEARCH_FAILED = 'The registry could not be searched.';

  // The check and the search of the CURRENT panel build: a reply for an older build or an older request is dropped.
  let addonCheckSeq = 0;
  let addonSearchSeq = 0;

  /** Put `text` on the clipboard; the button says Copied, a failure is said on `msg`. */
  async function copyText(button, text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (msg) msg.textContent = COPY_FAILED;
      return;
    }
    if (msg) msg.textContent = '';
    const original = button.dataset.label || button.textContent;
    clearTimeout(Number(button.dataset.flashTimer) || 0);
    button.dataset.label = original;
    button.textContent = 'Copied';
    button.dataset.flashTimer = String(setTimeout(() => {
      button.textContent = original;
      delete button.dataset.flashTimer;
      delete button.dataset.label;
    }, COPY_FLASH_MS));
  }

  /** A line of text to copy: the text in a box, a Copy button beside it. */
  function copyLine(label, text, msg, signal) {
    const line = node('div', 'sv-addon-command');
    if (label) line.appendChild(node('span', 'sv-mcp-card-transport', label));
    line.appendChild(node('code', '', text));
    const b = cardButton('Copy', () => copyText(b, text, msg), signal);
    b.setAttribute('aria-label', `Copy ${label ? label + ': ' : ''}${text}`);
    line.appendChild(b);
    return line;
  }

  /** The words for one probe answer; `null` = not checked yet. "Missing" is said as what it means. */
  function stateWords(answer) {
    if (!answer) return { text: 'not checked yet', unknown: true };
    if (answer.state === 'found') return { text: 'found', unknown: false };
    if (answer.state === 'missing') return { text: 'not found on PATH', unknown: false };
    return { text: 'not checked: ' + reasonSentence('command', answer.reason), unknown: true };
  }

  /** One catalog row, wrapped in `.settings-field` so the settings search sees it. -> { el, setStates(states) } */
  function addonRow(item, msg, signal) {
    const row = node('div', 'settings-field settings-field-wide sv-addon');
    row.dataset.addon = item.id;
    const info = node('div', 'settings-field-info');
    info.appendChild(node('span', 'settings-label', item.name));
    info.appendChild(node('div', 'settings-description', item.summary));
    info.appendChild(node('div', 'settings-description', 'Licence: ' + item.licence));
    row.appendChild(info);
    const control = node('div', 'settings-field-control');
    control.appendChild(copyLine('Source', item.source, msg, signal));
    const chips = node('div', 'sv-mcp-chips');
    control.appendChild(chips);
    for (const r of item.runtimes) {
      control.appendChild(copyLine(`Install with ${r.runtime}`, window.commandLine(r.install), msg, signal));
      control.appendChild(copyLine(`Uninstall with ${r.runtime}`, window.commandLine(r.uninstall), msg, signal));
    }
    // Add to project: a project picker and the button (filled by bindAddons once the project list is read).
    const handoff = node('div', 'sv-mcp-row');
    const picker = document.createElement('select');
    picker.className = 'settings-select';
    picker.setAttribute('aria-label', `Project to add ${item.name} to`);
    const addTo = cardButton('Add to project', () => onAddToProject(item, picker, msg), signal);
    handoff.appendChild(picker);
    handoff.appendChild(addTo);
    control.appendChild(handoff);
    row.appendChild(control);
    const commands = item.runtimes.map(r => r.install[0]).concat(item.stdio.command);
    const setStates = (states) => {
      chips.textContent = '';
      for (const cmd of commands) {
        const w = stateWords(states && states[cmd]);
        chips.appendChild(node('span', 'sv-mcp-chip' + (w.unknown ? ' sv-mcp-chip-unknown' : ''), `${cmd}: ${w.text}`));
      }
    };
    setStates(null);
    return { el: row, setStates, picker, addTo };
  }

  /** One option per project, text set as text. `projects` null = still loading; a string = why there are none. */
  function fillPicker(picker, button, projects) {
    picker.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = projects === null ? 'Projects load when this category is shown'
      : typeof projects === 'string' ? projects : 'Choose a project…';
    picker.appendChild(first);
    for (const p of Array.isArray(projects) ? projects : []) {
      const o = document.createElement('option');
      o.value = p.path;
      o.textContent = p.label;
      o.title = p.path;
      picker.appendChild(o);
    }
    const ready = Array.isArray(projects) && projects.length > 0;
    picker.disabled = !ready;
    button.disabled = !ready;
  }

  // The projects a server can be handed to: on the project list (registered, not hidden), on disk, and not a worktree
  // (a worktree's settings are its project's). A project only a backend's config knows, or one removed, is not offered.
  function pickableProjects(res) {
    const rows = res && res.ok === true && Array.isArray(res.projects) ? res.projects : null;
    if (!rows) return null;
    return rows
      .filter(r => r && typeof r.projectPath === 'string' && r.projectPath && r.registered && !r.hidden && !r.missing && !r.worktreeRoot)
      .map(r => ({
        path: r.projectPath,
        label: typeof r.displayName === 'string' && r.displayName.trim() ? r.displayName.trim()
          : r.projectPath.split(/[\\/]/).filter(Boolean).pop() || r.projectPath,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Hand a catalog entry to a project (spec 38, D6, D11): warn that this window is replaced (O3), then ask main to open
   * the project's settings with the catalog id as the seed. Nothing is stored here or there until the user saves.
   */
  async function onAddToProject(item, picker, msg) {
    const path = picker.value;
    if (!path) { msg.textContent = 'Choose a project first.'; return; }
    const option = picker.selectedOptions && picker.selectedOptions[0];
    const ok = typeof showControlDialog === 'function' ? await showControlDialog({
      title: 'Open the project\'s settings',
      message: `This window switches to the project's settings, with the Add form filled in for ${item.name}. `
        + 'Changes here that you have not saved are lost. Nothing is added until you press Add and then Save there.',
      confirmLabel: 'Open project settings',
      tone: 'warning',
      details: { Server: item.name, Project: option ? option.textContent : path },
    }) : true;
    if (!ok || !window.api || typeof window.api.openSettingsWindow !== 'function') return;
    msg.textContent = '';
    window.api.openSettingsWindow('project', path, { addon: item.id });
  }

  /** One registry result, every string set as text. Marked Unverified; Copy at most. */
  function registryResult(r, msg, signal) {
    const card = node('div', 'sv-mcp-card');
    const info = node('div', 'sv-mcp-card-info');
    const head = node('div', 'sv-mcp-card-head');
    head.appendChild(node('span', 'settings-label', r.title ? `${r.title} (${r.name})` : r.name));
    head.appendChild(node('span', 'sv-mcp-chip sv-mcp-chip-unknown', 'Unverified'));
    info.appendChild(head);
    if (r.description) info.appendChild(node('div', 'settings-description', r.description));
    if (r.source) info.appendChild(copyLine('Source', r.source, msg, signal));
    for (const p of Array.isArray(r.packages) ? r.packages : []) {
      if (!p || typeof p.registry !== 'string' || typeof p.identifier !== 'string') continue;
      info.appendChild(node('div', 'settings-description', `${p.registry}: ${p.identifier}`));
      for (const c of Array.isArray(p.commands) ? p.commands : []) {
        info.appendChild(copyLine(`Install with ${c.runtime}`, c.install, msg, signal));
      }
    }
    card.appendChild(info);
    return card;
  }

  /**
   * Fill the global category's host. The catalog rows draw at once (the search must see them); the PATH check runs on
   * the category's first `settings-cat-shown` of this build, and again on Check again; the registry is asked only on
   * Search or Enter. Nothing here is stored (spec 38, D8). Loaded with the catalog module before this file.
   */
  function bindAddons(body, signal) {
    const host = body.querySelector('#' + ADDONS_HOST_ID);
    if (!host || !Array.isArray(window.MCP_ADDON_CATALOG)) return;
    host.textContent = '';
    // A reply still out for an earlier build is stale from here on.
    addonCheckSeq++;
    addonSearchSeq++;

    const catalog = node('div', 'settings-section');
    catalog.appendChild(node('div', 'settings-section-title', 'Catalog'));
    const msg = node('div', 'settings-hint sv-mcp-form-msg');
    msg.setAttribute('aria-live', 'polite');
    const rows = window.MCP_ADDON_CATALOG.map(item => addonRow(item, msg, signal));
    for (const r of rows) catalog.appendChild(r.el);
    // The category's own hint comes first: a settings search hides the first hint outside a field, and the line
    // beside Check again must stay with its button.
    catalog.appendChild(node('div', 'settings-hint',
      'Found means the program is on PATH; nothing was started. Copy a command and run it in your own terminal: '
      + 'Switchboard installs and removes nothing. uvx can run a server without installing it; that form is not checked here. '
      + 'Add to project opens that project\'s settings with the server filled in; installing is per machine, using it is per project.'));
    const actions = node('div', 'sv-mcp-add');
    const again = cardButton('Check again', () => runAddonsCheck(), signal);
    actions.appendChild(again);
    actions.appendChild(node('span', 'settings-hint', 'Checked against the PATH this app started with.'));
    catalog.appendChild(actions);
    catalog.appendChild(msg);
    host.appendChild(catalog);

    let states = null;
    async function runAddonsCheck() {
      if (signal.aborted || !window.api || typeof window.api.checkExternalMcp !== 'function') return;
      const probes = window.probeEntries();
      const mine = ++addonCheckSeq;
      let res = null;
      try { res = await window.api.checkExternalMcp(null, probes); } catch { res = null; }
      if (signal.aborted || mine !== addonCheckSeq || !host.isConnected) return;
      if (res && res.ok === true && Array.isArray(res.results)) {
        states = window.readProbe(res.results, probes);
        msg.textContent = '';
      } else {
        msg.textContent = states ? CHECK_FAILED + ' The states shown are from the last check.' : CHECK_FAILED;
      }
      for (const r of rows) r.setStates(states);
    }
    for (const r of rows) fillPicker(r.picker, r.addTo, null);
    async function loadProjects() {
      if (!window.api || typeof window.api.getProjectsAdmin !== 'function') return;
      let res = null;
      try { res = await window.api.getProjectsAdmin(); } catch { res = null; }
      if (signal.aborted || !host.isConnected) return;
      const projects = pickableProjects(res);
      const pickerChoices = projects === null ? 'The project list could not be read.'
        : projects.length ? projects : 'No project to add to yet.';
      for (const r of rows) fillPicker(r.picker, r.addTo, pickerChoices);
    }

    // The first sight of this panel build asks PATH and reads the project list once; a later show does not.
    let shown = false;
    const section = host.closest('.settings-cat');
    if (section) {
      section.addEventListener('settings-cat-shown', () => {
        if (shown) return;
        shown = true;
        runAddonsCheck();
        loadProjects();
      }, { signal });
    }

    const registry = node('div', 'settings-section');
    const field = node('div', 'settings-field settings-field-wide sv-addon-search');
    const rInfo = node('div', 'settings-field-info');
    rInfo.appendChild(node('span', 'settings-label', 'Search the MCP registry'));
    rInfo.appendChild(node('div', 'settings-description',
      'Results come from the official MCP Registry and are not reviewed. They are text to read and copy: nothing is '
      + 'installed, run or added to a project from here.'));
    field.appendChild(rInfo);
    const rControl = node('div', 'settings-field-control');
    const bar = node('div', 'sv-mcp-row');
    const input = node('input', 'settings-input');
    input.type = 'text';
    input.placeholder = 'Server name';
    input.setAttribute('aria-label', 'Search the MCP registry');
    input.autocomplete = 'off';
    input.spellcheck = false;
    const searchBtn = cardButton('Search', () => search(), signal);
    bar.appendChild(input);
    bar.appendChild(searchBtn);
    rControl.appendChild(bar);
    rControl.appendChild(node('div', 'settings-hint', 'Press Search to send this text to the registry.'));
    const rMsg = node('div', 'settings-hint sv-mcp-form-msg');
    rControl.appendChild(rMsg);
    const results = node('div', 'sv-mcp-cards');
    results.setAttribute('aria-live', 'polite');
    rControl.appendChild(results);
    field.appendChild(rControl);
    registry.appendChild(field);
    host.appendChild(registry);

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }, { signal });

    async function search() {
      if (signal.aborted || !window.api || typeof window.api.searchMcpRegistry !== 'function') return;
      const mine = ++addonSearchSeq;
      rMsg.textContent = 'Searching…';
      let res = null;
      try { res = await window.api.searchMcpRegistry(input.value); } catch { res = null; }
      if (signal.aborted || mine !== addonSearchSeq || !host.isConnected) return;
      results.textContent = '';
      if (!res || res.ok !== true || !Array.isArray(res.results)) {
        rMsg.textContent = res && typeof res.reason === 'string' ? res.reason : SEARCH_FAILED;
        return;
      }
      rMsg.textContent = res.results.length ? '' : 'No servers found.';
      for (const r of res.results) if (r && typeof r.name === 'string') results.appendChild(registryResult(r, rMsg, signal));
    }
  }

  window.settingsExternalMcp = { SETTING_KEY, PRUNE_KEY, sectionHtml, bind, read, check, reasonSentence, factLines, bindAddons, openSeeded };
})();
