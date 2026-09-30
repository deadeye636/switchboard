// Variables admin tab (#47) — session-independent CRUD for ALL saved variables
// (global + per-project), mirroring the projects-admin tab pattern. Rendered into
// #variables-admin-content in the main area. No Insert/Send here (that is a
// session action, handled by the terminal quick-pick / context menu).
//
// Secret values are shown masked in the edit dialog with a Windows-style eye
// toggle; the decrypted value is prefilled via get-saved-variable but never
// unmasked until the user clicks the eye.
//
// The list is the user's MANUAL order (#676) — one order across every scope, and the same order every
// picker shows. This tab is where it is set: drag a row by its grip — only the grip starts a drag, so text
// in the table stays selectable (a real HTML5 drag, so `scripts/drive-app.js drag` can test it), or Alt+ArrowUp / Alt+ArrowDown on a focused row. "Sort by name"
// puts the whole list back into alphabetical order in one step, with an Undo on the toast. While the text
// filter holds anything, none of the three is offered: a drop between two rows that are not neighbours in
// the full list has no one right answer. A SCOPE filter keeps them, because a moved row lands directly
// before or after the row it was dropped on and every hidden row keeps its place (lib/variable-order.js).
//
// Depends on globals: escapeHtml (utils.js), showControlToast / showControlDialog / showControlMessage (control-dialogs.js),
// moveVariableInOrder / stepVariableInOrder / variableIdsByName / orderVariableRows / sameVariableOrder
// (lib/variable-order.js), window.api (preload) — reorderSavedVariables among them.

(function () {
  const container = document.getElementById('variables-admin-content');
  if (!container) return;

  let variables = [];     // all rows (list-all-saved-variables)
  let projects = [];      // [{ projectPath, displayName }]
  let scopeFilter = 'all'; // 'all' | 'global' | <projectPath>
  let search = '';
  let loaded = false;     // has fetchData ever populated variables/projects (for ensureLoaded)
  let reorderSeq = 0;     // the latest reorder request; an older reply must not repaint over a newer move
  let dragId = null;      // the row in flight during a drag
  let armedRow = null;    // the row whose grip the pointer is down on — the only row that may start a drag
  let undoToast = null;   // the "sorted by name — Undo" toast while it is on screen
  let previewOpen = false; // the editor's preview fold — closed by default, kept while the app runs

  function shortName(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/') || p || '';
  }

  function scopeLabel(row) {
    return row.scope === 'project' ? shortName(row.projectPath) : 'Global';
  }

  function toast(msg) {
    if (typeof showControlToast === 'function') showControlToast({ message: msg, timeoutMs: 3000 });
  }

  function matches(row) {
    if (scopeFilter === 'global' && row.scope !== 'global') return false;
    if (scopeFilter !== 'all' && scopeFilter !== 'global') {
      // A specific project: show that project's variables plus globals (the
      // applicable set for that project).
      if (!(row.scope === 'global' || (row.scope === 'project' && row.projectPath === scopeFilter))) return false;
    }
    if (search) {
      const hay = [row.name, scopeLabel(row), ...(row.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }

  // The scope choices as data (not <option> markup): Global plus every registered project. The filter also
  // offers "All projects"; the dialog does not (a variable is either Global or one project).
  function scopeItems(includeAll) {
    const items = [];
    if (includeAll) items.push({ value: 'all', label: 'All projects' });
    items.push({ value: 'global', label: 'Global' });
    for (const p of projects) items.push({ value: p.projectPath, label: p.displayName || shortName(p.projectPath) });
    return items;
  }

  // A type-to-filter combobox that replaces a native <select> for scope — the project list can be long and a
  // native select has no search. items: [{ value, label }]. Returns { el, getValue, setValue }; fires
  // onChange(value) on pick. Built from the same visual language as the .va-var-picker.
  function makeScopeCombobox({ items, value, onChange, placeholder }) {
    const wrap = document.createElement('div');
    wrap.className = 'va-combo';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'va-combo-input';
    input.setAttribute('role', 'combobox');
    input.autocomplete = 'off';
    input.spellcheck = false;
    const list = document.createElement('div');
    list.className = 'va-combo-list';
    list.style.display = 'none';
    wrap.appendChild(input);
    wrap.appendChild(list);

    let current = value;
    let open = false;

    const labelFor = (val) => { const it = items.find(i => i.value === val); return it ? it.label : (val || ''); };
    function getValue() { return current; }
    function setValue(val) { current = val; input.value = labelFor(val); }

    function renderRows(q) {
      const query = String(q || '').trim().toLowerCase();
      const shown = query ? items.filter(i => i.label.toLowerCase().includes(query)) : items;
      list.innerHTML = shown.length
        ? shown.map(i => `<button type="button" class="va-combo-row${i.value === current ? ' active' : ''}" data-value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</button>`).join('')
        : '<div class="va-combo-empty">No match</div>';
    }
    function openList() {
      if (open) return;
      open = true;
      renderRows('');                 // show everything on open, not just the current label
      input.value = '';               // clear so typing filters fresh; reverted on close if no pick
      input.placeholder = labelFor(current) || placeholder || 'Select…';
      list.style.display = '';
      document.addEventListener('mousedown', onAway, true);
    }
    function closeList() {
      if (!open) return;
      open = false;
      list.style.display = 'none';
      input.value = labelFor(current); // revert display to the selected label
      document.removeEventListener('mousedown', onAway, true);
    }
    function onAway(e) { if (!wrap.contains(e.target)) closeList(); }

    input.addEventListener('focus', openList);
    input.addEventListener('click', openList);
    input.addEventListener('input', (e) => {
      // Do not let filtering bubble as a form 'input' — the dialog's dirty-check hangs off that, and typing to
      // search is not an edit. A real change fires through onChange below, which marks dirty itself.
      e.stopPropagation();
      if (!open) openList();
      renderRows(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open) { e.stopPropagation(); closeList(); }
    });
    list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.va-combo-row');
      if (!row) return;
      e.preventDefault();
      const val = row.dataset.value;
      const changed = val !== current;
      setValue(val);
      closeList();
      if (changed && onChange) onChange(val);
    });

    setValue(value);
    return { el: wrap, getValue, setValue };
  }

  // The same six-dot grip the sidebar's project drag handle draws.
  const GRIP_SVG = '<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="3" r="1.3"/><circle cx="8.5" cy="3" r="1.3"/><circle cx="3.5" cy="7" r="1.3"/><circle cx="8.5" cy="7" r="1.3"/><circle cx="3.5" cy="11" r="1.3"/><circle cx="8.5" cy="11" r="1.3"/></svg>';

  // Reordering is off while the TEXT filter holds anything — see the header.
  function reorderLocked() { return !!search; }
  const LOCKED_HINT = 'Clear the filter to reorder';

  function rowHtml(row) {
    const tags = (row.tags || []).map(t => `<span class="va-tag">${escapeHtml(t)}</span>`).join('');
    const locked = reorderLocked();
    return `
      <tr data-id="${escapeHtml(row.id)}" tabindex="0"${locked ? ' class="va-reorder-locked"' : ''}>
        <td class="va-grip" title="${locked ? LOCKED_HINT : 'Drag to reorder (Alt+Up / Alt+Down)'}">${GRIP_SVG}</td>
        <td class="va-name">${escapeHtml(row.name)}</td>
        <td class="va-scope">${escapeHtml(scopeLabel(row))}</td>
        <td class="va-center">${row.secret ? '<span class="va-secret-pill">Secret</span>' : ''}</td>
        <td class="va-tags">${tags}</td>
        <td class="va-actions">
          <button data-action="edit" title="Edit">Edit</button>
          <button data-action="copy" title="Copy value">Copy</button>
          <button data-action="delete" class="va-danger" title="Delete">Delete</button>
        </td>
      </tr>`;
  }

  function rowsHtml() {
    const rows = variables.filter(matches);
    return rows.length
      ? rows.map(rowHtml).join('')
      : '<tr><td colspan="6" class="va-empty">No variables match.</td></tr>';
  }

  function render() {
    container.innerHTML = `
      <div class="va-header">
        <span class="va-title">Variables</span>
        <span class="va-scope-mount"></span>
        <input type="text" class="va-search" placeholder="Filter variables…" value="${escapeHtml(search)}">
        <button class="va-add" data-action="new">+ New variable</button>
        <button class="va-sort" data-action="sort-name">Sort by name</button>
        <button class="va-refresh" data-action="refresh" title="Reload">⟳</button>
        <button class="viewer-header-close" data-close-admin title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <div class="va-table-wrap">
        <table class="va-table">
          <thead>
            <tr><th class="va-grip-col" aria-label="Order"></th><th>Name</th><th>Project</th><th>Secret</th><th>Tags</th><th>Actions</th></tr>
          </thead>
          <tbody>${rowsHtml()}</tbody>
        </table>
      </div>`;

    const filterCombo = makeScopeCombobox({
      items: scopeItems(true),
      value: scopeFilter,
      placeholder: 'All projects',
      onChange: (val) => {
        scopeFilter = val;
        renderRows();
      },
    });
    container.querySelector('.va-scope-mount').replaceWith(filterCombo.el);
    const searchInput = container.querySelector('.va-search');
    searchInput.addEventListener('input', () => {
      search = searchInput.value.trim().toLowerCase();
      renderRows();
    });
    syncSortButton();
  }

  // Repaint the rows only — the header, the filter box and its caret stay as they are.
  function renderRows() {
    const tbody = container.querySelector('.va-table tbody');
    if (tbody) tbody.innerHTML = rowsHtml();
    syncSortButton();
  }

  function syncSortButton() {
    const btn = container.querySelector('.va-sort');
    if (!btn) return;
    const locked = reorderLocked();
    btn.disabled = locked || variables.length < 2;
    btn.title = locked ? LOCKED_HINT : 'Put the whole list into alphabetical order';
  }

  async function fetchData() {
    const [vars, projRes] = await Promise.all([
      window.api.listAllSavedVariables(),
      window.api.getProjectsAdmin().catch(() => null),
    ]);
    variables = Array.isArray(vars) ? vars : [];
    projects = (projRes && Array.isArray(projRes.projects))
      ? projRes.projects.map(p => ({ projectPath: p.projectPath, displayName: p.displayName }))
      : [];
    loaded = true;
  }

  async function load() {
    container.innerHTML = '<div class="va-loading">Loading variables…</div>';
    try {
      await fetchData();
      render();
    } catch (err) {
      container.innerHTML = `<div class="va-loading">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // The dialog can be opened from a session (window.openVariableDialog) before the admin tab ever ran load(),
  // so variables/projects would be empty — the scope combobox and the variable picker need them. Populate
  // without rendering the admin table.
  async function ensureLoaded() {
    if (loaded) return;
    try { await fetchData(); } catch {}
  }

  // --- New / Edit dialog ---------------------------------------------------

  function defaultScopeValue(preScope) {
    // Opened from a session → default to that session's project. Otherwise pre-select the currently
    // filtered project (if any) for a new variable.
    if (preScope) return preScope;
    return (scopeFilter !== 'all' && scopeFilter !== 'global') ? scopeFilter : 'global';
  }

  async function openDialog(existing, opts = {}) {
    const isEdit = !!existing;
    let form = {
      id: existing ? existing.id : null,
      name: existing ? existing.name : '',
      value: '',
      secret: existing ? !!existing.secret : false,
      scopeValue: existing
        ? (existing.scope === 'project' ? existing.projectPath : 'global')
        : defaultScopeValue(opts.preScope),
      tags: existing ? (existing.tags || []).join(', ') : '',
      insertTemplate: existing ? (existing.insertTemplate || '') : '',
    };

    // Prefill the decrypted value on edit (kept masked in the UI for secrets).
    if (isEdit) {
      try {
        const res = await window.api.getSavedVariable(existing.id);
        if (res && res.ok && res.variable) form.value = res.variable.value || '';
      } catch {}
    }

    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay';
    overlay.innerHTML = `
      <div class="va-dialog" role="dialog" aria-modal="true">
        <div class="va-dialog-header">
          <h3>${isEdit ? 'Edit Variable' : 'New Variable'}</h3>
          <button type="button" class="va-dialog-close" title="Close" aria-label="Close">&times;</button>
        </div>
        <form class="va-dialog-body">
          <label class="va-field"><span>Name</span>
            <input type="text" class="settings-input" id="va-f-name" value="${escapeHtml(form.name)}" autocomplete="off" spellcheck="false"></label>
          ${/[{}]/.test(form.name) ? `<div class="va-field-help va-name-warn">This name contains <code>{</code> or <code>}</code>, so it cannot be referenced from another variable's template as <code>{var:name}</code>. It works everywhere else — rename it if you want to reference it.</div>` : ''}
          <label class="va-field"><span>Value</span>
            <div class="va-value-wrap">
              <textarea class="settings-input va-value-input" id="va-f-value" spellcheck="false" autocomplete="off">${escapeHtml(form.value)}</textarea>
              <button type="button" class="va-eye" id="va-f-eye" title="Show / hide value" aria-label="Show / hide value"></button>
            </div></label>
          <div class="va-form-row">
            <label class="va-field"><span>Project</span>
              <span class="va-scope-mount" id="va-f-scope-mount"></span></label>
            <label class="va-secret-toggle"><span>Secret</span>
              <label class="settings-toggle"><input type="checkbox" id="va-f-secret" ${form.secret ? 'checked' : ''}><span class="settings-toggle-slider"></span></label></label>
          </div>
          <label class="va-field"><span>Tags</span>
            <input type="text" class="settings-input" id="va-f-tags" value="${escapeHtml(form.tags)}" placeholder="comma,separated" autocomplete="off" spellcheck="false"></label>
          <div class="va-field va-template-field">
            <div class="va-template-head">
              <span title="What an insert puts into the terminal">Template</span>
              <div class="va-chips">
                <button type="button" class="va-chip" data-tok="{value}" title="Insert the raw value inline">{value}</button>
                <button type="button" class="va-chip" data-tok="{path}" title="Path of a temp file holding the value — quote this one">{path}</button>
                <button type="button" class="va-chip" data-tok="{ref}" title="The shell reads the temp file. A complete shell word — never quote it">{ref}</button>
                <button type="button" class="va-chip" data-tok="{clipboard}" title="Whatever is on the clipboard when you insert: text, or the path of a copied file or screenshot">{clipboard}</button>
                <button type="button" class="va-chip va-chip-var" data-varpick="1" title="Reference another variable">Variable…</button>
                <button type="button" class="va-chip" data-tok="{handoffPath}" title="This project's handoff directory, full path. {handoffDir} gives it relative to the project">{handoffPath}</button>
                <button type="button" class="va-chip" data-tok="{planPath}" title="This project's plan directory, full path. {planDir} gives it relative to the project">{planPath}</button>
                <select class="settings-select va-preset-sel" id="va-f-preset" title="Prefill a template">
                  <option value="">Presets…</option>
                  <option value="{ref}">Read from temp file — {ref}</option>
                  <option value="{path}">Temp-file path — {path}</option>
                  <option value="-i '{path}'">SSH key flag</option>
                  <option value="--defaults-extra-file='{path}'">MySQL defaults file</option>
                  <option value="PGSERVICEFILE='{path}' PGSERVICE=name">Postgres service (edit the name)</option>
                  <option value="PGPASSFILE='{path}'">Postgres .pgpass</option>
                  <option value="Bearer {ref}">API Bearer token</option>
                </select>
              </div>
            </div>
            <textarea class="settings-input va-template-input" id="va-f-template" rows="6" autocomplete="off" spellcheck="false">${escapeHtml(form.insertTemplate)}</textarea>
          </div>
          <div class="va-preview-head">
            <button type="button" class="va-chip va-chip-var" id="va-f-preview-toggle" aria-controls="va-f-preview"></button>
            <div class="va-shell-toggle" id="va-f-shell">
              <button type="button" class="va-chip" data-shell="bash">bash</button>
              <button type="button" class="va-chip" data-shell="pwsh">pwsh</button>
            </div>
            <span class="va-preview-flags" id="va-f-flags"></span>
          </div>
          <div class="va-preview" id="va-f-preview"></div>
          <div class="va-preview-notes" id="va-f-notes"></div>
          <div class="va-status" id="va-f-status"></div>
          <div class="va-dialog-actions">
            <button type="button" class="va-secondary" id="va-f-cancel">Cancel</button>
            <button type="submit" class="va-primary">Save</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('#va-f-name');
    const valueInput = overlay.querySelector('#va-f-value');
    const eyeBtn = overlay.querySelector('#va-f-eye');
    const secretInput = overlay.querySelector('#va-f-secret');
    const statusEl = overlay.querySelector('#va-f-status');
    let revealed = false;

    // The scope picker: a filterable combobox (no 'all' — a variable is Global or one project). Editing a
    // project-scoped variable whose project has left the list keeps its scope by adding a row, so save does
    // not drop it. onChange re-renders the preview, exactly as the old <select> change did.
    const startScope = (form.scopeValue === 'all' || !form.scopeValue) ? 'global' : form.scopeValue;
    const dialogScopeItems = scopeItems(false);
    if (startScope !== 'global' && !dialogScopeItems.some(i => i.value === startScope)) {
      dialogScopeItems.push({ value: startScope, label: shortName(startScope) });
    }
    const scopeCombo = makeScopeCombobox({
      items: dialogScopeItems,
      value: startScope,
      placeholder: 'Global',
      onChange: () => { dirty = true; renderPreview(); },
    });
    overlay.querySelector('#va-f-scope-mount').replaceWith(scopeCombo.el);
    const scopeSel = { get value() { return scopeCombo.getValue(); } }; // a read-through shim for the code below

    function applyMask() {
      const mask = form.secret && !revealed;
      valueInput.classList.toggle('secret-masked', mask);
      eyeBtn.style.display = form.secret ? '' : 'none';
      eyeBtn.classList.toggle('revealed', revealed);
    }
    applyMask();

    // A preset prefills the template field; the value stays freely editable. The dropdown no longer mirrors
    // the field — the preview below is what tells the user which state they are in, so there is nothing left
    // for a "Custom" entry to say.
    const templateInput = overlay.querySelector('#va-f-template');
    const presetSel = overlay.querySelector('#va-f-preset');
    presetSel.addEventListener('change', () => {
      if (!presetSel.value) return;
      const preset = presetSel.value;
      templateInput.value = preset;
      presetSel.value = '';
      templateInput.focus();
      // Select a placeholder word the user is meant to replace, so typing overwrites it. Without this,
      // whoever trusts the Postgres preset ships PGSERVICE=name verbatim.
      const editable = preset.match(/PGSERVICE=(name)/);
      if (editable) {
        const at = preset.indexOf('PGSERVICE=') + 'PGSERVICE='.length;
        templateInput.setSelectionRange(at, at + editable[1].length);
      }
      // Assigning .value fires nothing — same trap as setRangeText. The input listener re-renders the
      // preview and marks the dialog dirty; both must happen, and neither does on its own.
      templateInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // --- the chips: insert a token at the caret -----------------------------------------------------
    // insertAtCaret fires an input event, which is what re-renders the preview and marks the dialog dirty.
    overlay.querySelectorAll('.va-chip[data-tok]').forEach((chip) => {
      chip.addEventListener('click', () => insertAtCaret(templateInput, chip.dataset.tok));
    });
    overlay.querySelector('.va-chip[data-varpick]').addEventListener('click', (e) => {
      openVarPicker(e.currentTarget, (name) => insertAtCaret(templateInput, `{var:${name}}`));
    });

    function insertAtCaret(el, text) {
      const at = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? at;
      el.setRangeText(text, at, end, 'end');
      el.focus();
      // setRangeText fires nothing. Without this the chips would change the template without marking the
      // dialog dirty — and closing it afterwards would discard that silently, which is the exact case the
      // dirty check exists for.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // --- the variable picker ------------------------------------------------------------------------
    // Lists what THIS row could reference: globals plus, for a project-scoped row, that project's. The row
    // being edited is excluded — a self-reference is an instant cycle, so it is not offered. One list in the
    // manual order (#676), each row badged with its scope; which one a `{var:name}` binds to is still the
    // resolver's rule (project over global), never the position in this list.
    function openVarPicker(anchor, onPick) {
      const existingPop = overlay.querySelector('.va-var-picker');
      if (existingPop) { existingPop.remove(); return; }
      const scopeValue = scopeSel.value;
      const candidates = variables.filter((v) => {
        if (form.id && v.id === form.id) return false;
        if (v.scope !== 'project') return true;
        return scopeValue !== 'global' && v.projectPath === scopeValue;
      });
      const pop = document.createElement('div');
      pop.className = 'va-var-picker';
      pop.innerHTML = candidates.length
        ? `<input type="text" class="settings-input va-var-filter" placeholder="Filter…" spellcheck="false">
           <div class="va-var-list">${candidates.map((v) => `
             <button type="button" class="va-var-row" data-name="${escapeHtml(v.name)}">
               <span class="va-var-name">${escapeHtml(v.name)}</span>
               ${v.secret ? '<span class="va-secret-pill">Secret</span>' : ''}
               <span class="va-tag va-scope-badge">${v.scope === 'project' ? 'Project' : 'Global'}</span>
             </button>`).join('')}</div>`
        : '<div class="va-var-empty">No other variables to reference.</div>';
      anchor.parentElement.appendChild(pop);
      const filter = pop.querySelector('.va-var-filter');
      if (filter) {
        filter.focus();
        filter.addEventListener('input', () => {
          const q = filter.value.toLowerCase();
          pop.querySelectorAll('.va-var-row').forEach((r) => {
            r.style.display = r.dataset.name.toLowerCase().includes(q) ? '' : 'none';
          });
        });
      }
      pop.addEventListener('click', (ev) => {
        const row = ev.target.closest('.va-var-row');
        if (!row) return;
        onPick(row.dataset.name);
        pop.remove();
      });
      setTimeout(() => {
        const away = (ev) => {
          if (!pop.contains(ev.target) && ev.target !== anchor) { pop.remove(); document.removeEventListener('mousedown', away); }
        };
        document.addEventListener('mousedown', away);
      }, 0);
    }

    // --- the preview --------------------------------------------------------------------------------
    // Composed with the SAME pure functions the insert runs (public/variable-insert.js), so it cannot drift
    // from what will actually be produced. It needs no IPC and no plaintext: the admin list carries `secret`
    // and `insertTemplate` but never values, so a referenced variable renders as a placeholder — and a ref
    // renders against a synthetic path. No temp file is ever written from this dialog.
    const VI = window.variableInsert;
    const SYNTH_PATH = '<secret-file>';
    // The convention directories render as themselves: which project answers them is decided at insert
    // time, so any concrete path here would be a preview of one project pretending to be the rule.
    // One placeholder PER TOKEN, not per directory: `{handoffDir}` and `{handoffPath}` differ by exactly
    // the thing a preview is for — whether what lands in the command is a bare name or a full path.
    // Rendering both as the same text hides the one mistake this preview exists to catch.
    const SYNTH_DIRS = { handoffDir: '<handoff-dir>', handoffPath: '<handoff-path>', planDir: '<plan-dir>', planPath: '<plan-path>' };
    // What {clipboard} stands for while the dialog is open. The REAL clipboard is deliberately not read
    // here (#491): a preview that repaints on every keystroke would show whatever the user last copied —
    // often a password — in a panel they are not inserting from, and a dialog is no reason to put it on
    // screen. The token stands in for itself, like a convention directory does.
    const SYNTH_CLIPBOARD = '<clipboard>';
    let previewShell = (navigator.platform || '').toLowerCase().startsWith('win') ? 'pwsh' : 'bash';
    const previewEl = overlay.querySelector('#va-f-preview');
    const notesEl = overlay.querySelector('#va-f-notes');
    const flagsEl = overlay.querySelector('#va-f-flags');
    const shellToggle = overlay.querySelector('#va-f-shell');
    const previewToggle = overlay.querySelector('#va-f-preview-toggle');

    shellToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-shell]');
      if (!btn) return;
      previewShell = btn.dataset.shell;
      renderPreview();
    });

    // The preview is folded away by default so the template gets the room; the notes that say the insert
    // will FAIL or misbehave stay visible either way, because the preview is where the quoting rule is
    // enforced (spec 12) and a fold must not hide a refusal. Only the explanations fold with it.
    function applyPreviewOpen() {
      previewToggle.textContent = previewOpen ? 'Hide preview' : 'Show preview';
      previewToggle.setAttribute('aria-expanded', String(previewOpen));
      previewEl.hidden = !previewOpen;
      shellToggle.hidden = !previewOpen;
    }
    previewToggle.addEventListener('click', () => {
      previewOpen = !previewOpen;
      applyPreviewOpen();
      renderPreview();
    });
    applyPreviewOpen();

    function paintNotes(notes) {
      const shown = previewOpen ? notes : notes.filter(([tone]) => tone === 'error' || tone === 'warn');
      notesEl.innerHTML = shown.map(([tone, text]) => `<div class="va-note va-note-${tone}">${escapeHtml(text)}</div>`).join('');
    }

    // Past the limit the save keeps only the start. Said here before the save, and by the save afterwards.
    function lengthNote() {
      const len = templateInput.value.length;
      const max = VI.MAX_TEMPLATE_CHARS;
      if (len > max) return ['error', `The template is ${len.toLocaleString()} characters — only the first ${max.toLocaleString()} are saved.`];
      if (len > max * 0.9) return ['warn', `${len.toLocaleString()} of ${max.toLocaleString()} characters.`];
      return null;
    }

    // The rows this template may reference, and the same name→id binding the resolver applies.
    function applicableRows() {
      const scopeValue = scopeSel.value;
      return variables.filter((v) => v.scope !== 'project' || (scopeValue !== 'global' && v.projectPath === scopeValue));
    }

    const ROOT_ID = '__editing__';

    function renderPreview() {
      shellToggle.querySelectorAll('[data-shell]').forEach((b) => b.classList.toggle('active', b.dataset.shell === previewShell));
      templateInput.placeholder = secretInput.checked
        ? 'Default: {ref} — the shell reads a temp file'
        : 'Default: {value} — inserts the raw value';

      const notes = [];
      const tooLong = lengthNote();
      if (tooLong) notes.push(tooLong);
      const rows = applicableRows();
      const nameIndex = VI.buildNameIndex(rows);
      // The row being edited is the graph's root, under a synthetic id: it may be brand new, and its
      // template is whatever is in the textarea right now, not what is stored.
      const root = { id: ROOT_ID, name: nameInput.value || '(this variable)', secret: secretInput.checked, insertTemplate: templateInput.value };
      const nodesById = new Map(rows.map((v) => [v.id, v]));
      nodesById.set(ROOT_ID, root);

      // Walk the WHOLE graph, exactly as the resolver does — not just the direct references. A one-level
      // walk was the first version of this, and it made the preview lie in the one place it must not: a
      // secret two hops away (through a non-secret wrapper) showed no pill and rendered as empty text,
      // while the real insert would refuse it.
      const graph = VI.resolveVarGraph(ROOT_ID, nodesById, nameIndex);
      if (graph.cycle) {
        previewEl.innerHTML = '<span class="va-preview-empty">(cannot resolve)</span>';
        flagsEl.innerHTML = '';
        notes.push(['error', `Variables reference each other in a loop: ${graph.cycle.join(' → ')}. The insert will refuse this.`]);
        paintNotes(notes);
        return;
      }
      if (graph.order.length > VI.MAX_RESOLVED_NODES) {
        notes.push(['error', `This pulls in ${graph.order.length} variables (limit ${VI.MAX_RESOLVED_NODES}). The insert will refuse this.`]);
      }
      for (const missing of new Set(graph.missing || [])) {
        notes.push(['error', `{var:${missing}} — no such variable`]);
      }

      // Bottom-up, memoized per id — the resolver's shape, so a diamond composes once and a grandchild's
      // refs keep their real offsets in the finished string.
      const textById = new Map();
      const offsetsById = new Map();
      let touchesSecret = false;
      // Does any node write a temp file? That is the same question the insert answers with `written.length`,
      // and it is what decides whether a line break can survive: a {ref} is one shell word on one command
      // line, so there the breaks collapse to spaces.
      let materializes = false;
      for (const nodeId of graph.order) {
        const node = nodesById.get(nodeId);
        const isRoot = nodeId === ROOT_ID;
        const tmpl = VI.finalTemplateFor(node, isRoot);
        if (node.secret) touchesSecret = true;
        if (tmpl.includes('{path}') || tmpl.includes('{ref}')) materializes = true;
        if (!isRoot && node.secret && VI.effectiveTemplate(node).includes('{value}')) {
          notes.push(['info', `${node.name} is a secret — inserted as a file read, never as plaintext`]);
        }
        const vars = {};
        const varRefOffsets = {};
        for (const name of VI.parseVarRefs(tmpl)) {
          const childId = nameIndex[name];
          if (childId == null) continue;
          vars[name] = textById.get(childId) ?? '';
          varRefOffsets[name] = offsetsById.get(childId) || [];
          if (isRoot) {
            const bound = nodesById.get(childId);
            const ambiguous = rows.filter((v) => v.name === name).length > 1;
            notes.push([ambiguous ? 'warn' : 'ok',
              ambiguous
                ? `{var:${name}} — more than one variable is called this; bound to the ${bound.scope === 'project' ? 'project' : 'global'} one`
                : `{var:${name}} → ${bound.scope === 'project' ? 'Project' : 'Global'}`]);
          }
        }
        const composed = VI.compose(tmpl, {
          path: SYNTH_PATH,
          ref: tmpl.includes('{ref}') ? VI.shellRefFor(previewShell, SYNTH_PATH) : null,
          // Never a real value: the root's own is on screen one field up anyway (masked for a secret), and
          // a referenced variable's value is not something an editor may fetch to paint a picture.
          value: tmpl.includes('{value}')
            ? (isRoot
              ? (secretInput.checked ? '⟨value⟩' : (valueInput.value || '⟨value⟩'))
              : `⟨value of ${node.name}⟩`)
            : null,
          // Same reasoning for the clipboard, plus one of its own: a secret's template does not get it at
          // all, so the preview must not show it resolving there either.
          clipboard: (tmpl.includes('{clipboard}') && !node.secret) ? SYNTH_CLIPBOARD : null,
          // A convention directory belongs to the project the INSERT happens in, which this dialog cannot
          // know — a global variable is inserted in every project there is. So the preview shows the token
          // standing in for itself rather than picking one project's answer and calling it the result.
          dirs: SYNTH_DIRS,
          vars,
          varRefOffsets,
        });
        textById.set(nodeId, composed.text);
        offsetsById.set(nodeId, composed.refOffsets);
      }

      const own = { text: textById.get(ROOT_ID) ?? '', refOffsets: offsetsById.get(ROOT_ID) || [] };
      const tmpl = VI.finalTemplateFor(root, true);

      // The rule is not taught in a help line nobody reads — it is enforced, visibly, with the reason in the
      // message. This is the SAME check the insert hard-fails on, so the editor shows the future error.
      const unsafe = VI.scanRefSafety(own.text, own.refOffsets);
      for (const hit of unsafe) {
        const what = hit.reason === 'unbalanced' ? 'a quote is left open around it' : 'it sits inside quotes';
        notes.push([hit.nested ? 'error' : 'warn',
          `A file reference is broken: ${what}. Remove the quotes — the reference is already a complete shell word.`
          + (hit.nested ? ' The insert will refuse this.' : '')]);
      }
      if (VI.shellRefFor(previewShell, '') === null) notes.push(['warn', `This shell cannot read a file inline — {ref} falls back to a clipboard copy.`]);
      if (/[\n\r]/.test(own.text)) {
        notes.push(materializes
          ? ['warn', 'The result contains a line break and also reads a temp file — the insert collapses the breaks to spaces, so the command stays on one line.']
          : ['info', 'The result contains line breaks. The insert pastes it as one block, so nothing is submitted; a program without bracketed-paste support gets the breaks as spaces.']);
      }
      if (/\{var:(?![^{}]+\})/.test(tmpl)) notes.push(['warn', '{var: without a closing brace is treated as literal text.']);
      if (tmpl.includes('{clipboard}')) {
        notes.push(secretInput.checked
          ? ['warn', '{clipboard} resolves to nothing on a secret. A clipboard usually holds someone else\'s password, and this insert is the one that keeps plaintext out of the prompt.']
          : ['info', '{clipboard} — whatever is on the clipboard when you insert. A copied file or screenshot inserts its path as one quoted word; text is inserted with control characters removed.']);
      }
      for (const token of VI.DIR_TOKENS) {
        if (!tmpl.includes(`{${token}}`)) continue;
        const what = token.startsWith('handoff') ? 'handoff' : 'plan';
        notes.push(['info', `{${token}} — this project's ${what} directory, resolved where the insert happens`
          + `${token.endsWith('Path') ? ' (the full path)' : ' (relative to the project)'}. A path with spaces needs quoting.`]);
      }

      previewEl.innerHTML = highlightRefs(own.text, own.refOffsets, unsafe);
      flagsEl.innerHTML = touchesSecret ? '<span class="va-secret-pill" title="This insert reads secret temp files.">Secret</span>' : '';
      paintNotes(notes);
    }

    // Render the composed string verbatim, marking each ref so "one complete shell word" is visible rather
    // than stated. Built from escaped segments — the dialog is innerHTML-based, and CSP is defence in depth,
    // not permission to skip escaping.
    function highlightRefs(text, refOffsets, unsafe) {
      if (!text) return '<span class="va-preview-empty">(nothing)</span>';
      const bad = new Set(unsafe.filter(h => h.reason === 'quoted').map(h => h.offset));
      const marks = [...refOffsets].sort((a, b) => a.offset - b.offset);
      let out = '';
      let at = 0;
      for (const m of marks) {
        const refText = VI.shellRefFor(previewShell, SYNTH_PATH) || '';
        if (m.offset < at || !refText) continue;
        out += escapeHtml(text.slice(at, m.offset));
        out += `<span class="va-preview-ref${bad.has(m.offset) ? ' va-preview-ref-bad' : ''}">${escapeHtml(text.substr(m.offset, refText.length))}</span>`;
        at = m.offset + refText.length;
      }
      return out + escapeHtml(text.slice(at));
    }

    templateInput.addEventListener('input', renderPreview);
    valueInput.addEventListener('input', renderPreview);
    // The scope combobox re-renders the preview via its onChange (above) — no listener on the shim.

    eyeBtn.addEventListener('click', () => { revealed = !revealed; applyMask(); });
    secretInput.addEventListener('change', () => {
      form.secret = secretInput.checked;
      revealed = false;
      applyMask();
      renderPreview();   // the default template flips with it — the strongest teacher in the dialog
    });
    renderPreview();

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    // This dialog holds work that cannot be recovered — a value the user typed, possibly a credential in the
    // middle of a rotation. It used to discard that on Escape or a stray backdrop click, with no
    // confirmation. A backdrop click no longer closes it at all, and Escape asks once it is dirty.
    let dirty = false;
    overlay.querySelector('.va-dialog-body').addEventListener('input', () => { dirty = true; });
    async function tryClose() {
      if (!dirty) { close(); return; }
      const discard = await showControlDialog({
        title: 'Discard changes?',
        message: 'This variable has unsaved edits.',
        confirmLabel: 'Discard',
        tone: 'danger',
      });
      if (discard) close();
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); tryClose(); } }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.va-dialog-close').addEventListener('click', tryClose);
    overlay.querySelector('#va-f-cancel').addEventListener('click', tryClose);

    overlay.querySelector('.va-dialog-body').addEventListener('submit', async (e) => {
      e.preventDefault();
      const scopeValue = scopeSel.value;
      const scope = scopeValue === 'global' ? 'global' : 'project';
      const payload = {
        id: form.id || undefined,
        name: overlay.querySelector('#va-f-name').value,
        value: valueInput.value,
        secret: secretInput.checked,
        scope,
        projectPath: scope === 'project' ? scopeValue : null,
        tags: overlay.querySelector('#va-f-tags').value,
        insertTemplate: overlay.querySelector('#va-f-template').value,
      };
      // A rename is a silent break for anything composing with the old name — ask before, not after.
      const renamedFrom = (form.id && form.name && form.name !== payload.name) ? form.name : null;
      if (renamedFrom) {
        const warning = await referenceWarning(renamedFrom, `Renaming "${renamedFrom}"`);
        if (warning) {
          const go = await showControlDialog({
            title: `Rename ${renamedFrom} to ${payload.name}?`,
            message: warning + ' Update those templates afterwards.',
            confirmLabel: 'Rename',
            tone: 'danger',
          });
          if (!go) return;
        }
      }
      const res = await window.api.saveSavedVariable(payload);
      if (!res || !res.ok) {
        statusEl.textContent = res?.error || 'Save failed';
        statusEl.className = 'va-status error';
        return;
      }
      close();
      if (res.templateCut) {
        const { kept, dropped } = res.templateCut;
        showControlMessage({
          title: 'Template shortened',
          message: `The variable was saved, but its template was too long. Only the first ${kept.toLocaleString()} characters were kept; the last ${dropped.toLocaleString()} were not saved.`,
          tone: 'warning',
        });
      }
      opts.onSaved?.();  // e.g. the session quick-pick re-opens itself so the new variable shows at once
      load();
    });

    overlay.querySelector('#va-f-name').focus();
  }

  // --- Row actions ---------------------------------------------------------

  // Warn when other variables compose with this one. Renaming or deleting it breaks them SILENTLY: a
  // reference nobody resolves is empty, so the command still runs — with an empty credential where the
  // secret used to be. Returns a sentence for the confirm dialog, or '' when nothing references it.
  async function referenceWarning(name, what) {
    try {
      const res = await window.api.savedVariableReferences(name);
      const users = (res && res.ok && res.referencedBy) || [];
      if (!users.length) return '';
      const list = users.map(u => u.name).join(', ');
      return `${what} will break ${users.length === 1 ? 'a template that references' : 'templates that reference'} it: ${list}. `
        + `The reference then resolves to nothing, so the command still runs — with an empty value.`;
    } catch { return ''; }
  }

  function findRow(id) { return variables.find(v => v.id === id); }

  // --- The manual order (#676) ------------------------------------------------------------------------

  // Show `ids` at once, then store it. The store answers with the order it actually wrote — it drops an id
  // another window deleted meanwhile and keeps a row this window never saw — and that answer is shown, unless
  // a newer move has been made since, in which case that one's answer is the one that counts.
  async function applyOrder(ids, { focusId = null } = {}) {
    // Any move — including the Undo itself — ends the Undo on offer: it restores the order from BEFORE the
    // sort, so pressing it after a later move would silently revert that move too.
    dismissUndo();
    const seq = ++reorderSeq;
    variables = orderVariableRows(variables, ids);
    renderRows();
    if (focusId) focusRow(focusId);
    let res = null;
    try { res = await window.api.reorderSavedVariables(ids); } catch (err) { res = { ok: false, error: err && err.message }; }
    if (seq !== reorderSeq) return !!(res && res.ok);
    if (!res || !res.ok) {
      toast('Reorder: ' + (res?.error || 'failed'));
      await load();
      if (focusId) focusRow(focusId);
      return false;
    }
    if (Array.isArray(res.order) && !sameVariableOrder(res.order, variables.map(v => v.id))) {
      variables = orderVariableRows(variables, res.order);
      renderRows();
      if (focusId) focusRow(focusId);
    }
    return true;
  }

  function focusRow(id) {
    const tr = [...container.querySelectorAll('.va-table tbody tr[data-id]')].find(r => r.dataset.id === id);
    if (tr) tr.focus();
  }

  function dismissUndo() {
    if (undoToast) { undoToast.remove(); undoToast = null; }
  }

  async function sortByName() {
    if (reorderLocked()) return;
    const before = variables.map(v => v.id);
    const sorted = variableIdsByName(variables);
    if (sameVariableOrder(before, sorted)) { toast('Already in name order'); return; }
    const ok = await applyOrder(sorted);
    const seq = reorderSeq;
    // A move made while the sort was on its way is newer than the sort: no Undo for it then.
    if (!ok || seq !== reorderSeq || typeof showControlToast !== 'function') return;
    undoToast = showControlToast({
      message: 'Variables sorted by name',
      actionLabel: 'Undo',
      onAction: () => { undoToast = null; return applyOrder(before); },
      timeoutMs: 8000,
    });
  }

  function clearDropMarks() {
    container.querySelectorAll('.va-drop-before, .va-drop-after').forEach(el => el.classList.remove('va-drop-before', 'va-drop-after'));
  }

  function dropPlace(tr, clientY) {
    const r = tr.getBoundingClientRect();
    return clientY < r.top + r.height / 2 ? 'before' : 'after';
  }

  function rowOf(target) {
    return (target && target.closest) ? target.closest('.va-table tbody tr[data-id]') : null;
  }

  // Only the GRIP starts a drag. A row is made draggable while the pointer is down on its grip and not
  // otherwise, so pressing on a name or a button and moving selects text as it always did. The row stays the
  // drag source (a real HTML5 drag, which `scripts/drive-app.js drag '<grip>' '<row>' top|bottom` performs
  // from the grip's centre).
  function disarmRow() {
    if (armedRow) { armedRow.removeAttribute('draggable'); armedRow = null; }
  }

  container.addEventListener('pointerdown', (e) => {
    disarmRow();
    if (e.button !== 0 || reorderLocked()) return;
    const grip = e.target.closest && e.target.closest('.va-grip');
    const tr = grip ? rowOf(grip) : null;
    if (!tr) return;
    tr.setAttribute('draggable', 'true');
    armedRow = tr;
    window.addEventListener('pointerup', disarmRow, { once: true });
  });

  container.addEventListener('dragstart', (e) => {
    const tr = rowOf(e.target);
    if (!tr) return;
    if (reorderLocked() || tr !== armedRow) { e.preventDefault(); dragId = null; return; }
    dragId = tr.dataset.id;
    tr.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    } catch {}
  });

  container.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const tr = rowOf(e.target);
    if (!tr) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    clearDropMarks();
    if (tr.dataset.id === dragId) return;
    tr.classList.add(dropPlace(tr, e.clientY) === 'before' ? 'va-drop-before' : 'va-drop-after');
  });

  container.addEventListener('dragleave', (e) => {
    if (!dragId) return;
    if (!container.contains(e.relatedTarget)) clearDropMarks();
  });

  container.addEventListener('drop', (e) => {
    if (!dragId) return;
    const tr = rowOf(e.target);
    const moved = dragId;
    dragId = null;
    clearDropMarks();
    if (!tr) return;
    e.preventDefault();
    const before = variables.map(v => v.id);
    const next = moveVariableInOrder(before, moved, tr.dataset.id, dropPlace(tr, e.clientY));
    if (!sameVariableOrder(before, next)) applyOrder(next);
  });

  container.addEventListener('dragend', () => {
    dragId = null;
    disarmRow();
    clearDropMarks();
    container.querySelectorAll('.va-table tbody tr.dragging').forEach(el => el.classList.remove('dragging'));
  });

  // Alt+ArrowUp / Alt+ArrowDown moves the focused row one place among the rows shown, and the focus goes
  // with it. Plain arrows are left alone: they scroll the table.
  container.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const tr = rowOf(e.target);
    if (!tr || e.target !== tr) return;
    e.preventDefault();
    if (reorderLocked()) { toast(LOCKED_HINT); return; }
    const id = tr.dataset.id;
    const all = variables.map(v => v.id);
    const shown = variables.filter(matches).map(v => v.id);
    const next = stepVariableInOrder(all, shown, id, e.key === 'ArrowUp' ? -1 : 1);
    if (!next || sameVariableOrder(all, next)) return;
    applyOrder(next, { focusId: id });
  });

  async function handleAction(action, id) {
    if (action === 'refresh') { load(); return; }
    if (action === 'new') { openDialog(null); return; }
    if (action === 'sort-name') { sortByName(); return; }
    const row = findRow(id);
    if (!row) return;
    if (action === 'edit') { openDialog(row); return; }
    if (action === 'copy') {
      try {
        const res = await window.api.getSavedVariable(id);
        if (!res || !res.ok || !res.variable) throw new Error(res?.error || 'Variable not found');
        await window.api.writeClipboard(res.variable.value || '');
        toast('Copied');
      } catch (err) { toast('Copy: ' + err.message); }
      return;
    }
    if (action === 'delete') {
      // App control dialog instead of native confirm (issue #78).
      const ok = await showControlDialog({
        title: `Delete ${row.name}?`,
        message: await referenceWarning(row.name, 'Deleting it'),
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!ok) return;
      const res = await window.api.deleteSavedVariable(id);
      if (!res || !res.ok) { toast('Delete: ' + (res?.error || 'failed')); return; }
      load();
    }
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'refresh' || action === 'new' || action === 'sort-name') { handleAction(action, null); return; }
    const tr = btn.closest('tr');
    handleAction(action, tr ? tr.dataset.id : null);
  });

  window.loadVariablesAdmin = load;

  // Open the New-variable dialog from outside the admin tab (the session quick-pick). Ensures the scope/
  // reference data is loaded first, since the admin tab may never have been opened. opts: { preScope,
  // onSaved }.
  window.openVariableDialog = async (opts = {}) => {
    await ensureLoaded();
    openDialog(null, opts);
  };
})();
