// settings-external-mcp.js — the project's `externalMcpServers` editor: one JSON text area (#789, spec 36, slice A).
//
// A minimal surface on purpose: the list as pretty JSON, checked by the same validator the injection uses
// (shared/external-mcp-validate.js, loaded before this file). The cards/tabs manager is slice B.
//
// The panel owns the save: `read()` is called by persistSettings, which stores `list` on the project blob
// through the ordinary settings write and REFUSES the save when `problem` is set — an entry that would be
// dropped silently at launch is told to the user now. A literal-secret warning never blocks.
// Loaded in settings.html only. It names no backend.
(function () {
  'use strict';

  const SETTING_KEY = 'externalMcpServers';
  const TEXT_ID = 'sv-external-mcp';
  const STATUS_ID = 'sv-external-mcp-status';

  const toText = (list) => (Array.isArray(list) && list.length ? JSON.stringify(list, null, 2) : '');

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
    const add = (lines, color) => lines.forEach(line => {
      const div = document.createElement('div');
      div.textContent = line;
      div.style.color = color;
      el.appendChild(div);
    });
    add(res.problems, '#e06c75');
    add(res.warnings, '#e5c07b');
  }

  /** The section markup. `list` is the stored value (anything; shown as it is, so a bad stored value can be fixed). */
  function sectionHtml(list) {
    return `
        <section class="settings-cat" data-cat="mcp">
        <div class="settings-cat-head"><h2>MCP servers</h2><p>External MCP servers every session of this project gets, whatever CLI is running.</p></div>
        <div class="settings-section">
          <div class="settings-section-title">MCP servers</div>
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
        </section>`;
  }

  /** Check on blur, so the message is there before Save. */
  function bind(body, signal) {
    const ta = body.querySelector('#' + TEXT_ID);
    if (!ta) return;
    const run = () => showStatus(body, check(ta.value));
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
