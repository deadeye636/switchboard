// settings-external-mcp.js — the project's `externalMcpServers` editor: cards over one JSON text area (#789, spec 36).
//
// The TEXT AREA is the store and the cards are a projection of it (slice B): a card operation (switch, remove)
// parses the text, changes the one RAW entry (never the validator's normalised copy), writes the list back as pretty
// JSON and redraws; a text edit redraws the cards on blur. The list is checked by the same validator the injection
// uses (shared/external-mcp-validate.js, loaded before this file); the cards add no rule of their own. The Add/Edit
// form (shared/external-mcp-form.js) is not wired here yet, so those controls are drawn disabled.
//
// The panel owns the save: `read()` is called by persistSettings, which stores `list` on the project blob
// through the ordinary settings write and REFUSES the save when `problem` is set — an entry that would be
// dropped silently at launch is told to the user now. A literal-secret warning never blocks. Nothing persists
// before Save (the settings window is a snapshot). Loaded in settings.html only. It names no backend.
(function () {
  'use strict';

  const SETTING_KEY = 'externalMcpServers';
  const TEXT_ID = 'sv-external-mcp';
  const STATUS_ID = 'sv-external-mcp-status';
  const CARDS_ID = 'sv-external-mcp-cards';
  const JSON_ID = 'sv-external-mcp-json';
  const ADD_ID = 'sv-external-mcp-add';

  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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
  function buildCard(raw, index, reason, warnings, onToggle, onRemove, signal) {
    const obj = isPlainObject(raw) ? raw : {};
    const card = node('div', 'sv-mcp-card' + (reason ? ' sv-mcp-card-rejected' : ''));
    const info = node('div', 'sv-mcp-card-info');
    const head = node('div', 'sv-mcp-card-head');
    head.appendChild(node('span', 'settings-label', typeof obj.name === 'string' && obj.name ? obj.name : '(no name)'));
    head.appendChild(node('span', 'sv-mcp-card-transport', obj.transport === 'http' || obj.transport === 'stdio' ? obj.transport : 'transport?'));
    info.appendChild(head);
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
    actions.appendChild(cardButton('Edit', null, signal, { disabled: true }));
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
    if (addBtn) addBtn.disabled = true; // the form Add opens is wired in the next step; never reachable on a bad list
    if (parsed.error) {
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
      change(now.list);
      ta.value = toText(now.list);
      showStatus(body, check(ta.value));
      renderCards(body, signal);
    };
    parsed.list.forEach((raw, i) => {
      region.appendChild(buildCard(raw, i, reasons.get(i) || '', warns.get(i) || [],
        (idx, on) => edit(list => { if (isPlainObject(list[idx])) list[idx].enabled = on; }),
        (idx) => edit(list => { list.splice(idx, 1); }),
        signal));
    });
  }

  /** The section markup. `list` is the stored value (anything; shown as it is, so a bad stored value can be fixed). */
  function sectionHtml(list) {
    const chev = '<svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>';
    return `
        <section class="settings-cat" data-cat="mcp">
        <div class="settings-cat-head"><h2>MCP servers</h2><p>External MCP servers every session of this project gets, whatever CLI is running.</p></div>
        <div class="settings-section">
          <div class="settings-section-title">MCP servers</div>
          <div id="${CARDS_ID}" class="sv-mcp-cards"></div>
          <div class="sv-mcp-add"><button type="button" class="settings-action-btn" id="${ADD_ID}" disabled>Add server</button></div>
          <div class="settings-hint" style="padding-left:0;">The switch turns a server off for this project without deleting it. Changes are stored when you press Save.</div>
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

  /** Check and redraw the cards on blur, so the message is there before Save. */
  function bind(body, signal) {
    const ta = body.querySelector('#' + TEXT_ID);
    if (!ta) return;
    const run = () => {
      showStatus(body, check(ta.value));
      renderCards(body, signal);
    };
    ta.addEventListener('blur', run, { signal });
    run();
  }

  /**
   * What Save writes. -> { list, problem } — `problem` is a sentence (or '') and, when set, the caller refuses
   * the save and `list` is not to be written.
   */
  function read(body) {
    const ta = body.querySelector('#' + TEXT_ID);
    if (!ta) return { list: undefined, problem: '' };
    const res = check(ta.value);
    showStatus(body, res);
    return { list: res.list, problem: res.problems.length ? res.problems.join('\n') : '' };
  }

  window.settingsExternalMcp = { SETTING_KEY, sectionHtml, bind, read, check };
})();
