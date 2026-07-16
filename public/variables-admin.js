// Variables admin tab (#47) — session-independent CRUD for ALL saved variables
// (global + per-project), mirroring the projects-admin tab pattern. Rendered into
// #variables-admin-content in the main area. No Insert/Send here (that is a
// session action, handled by the terminal quick-pick / context menu).
//
// Secret values are shown masked in the edit dialog with a Windows-style eye
// toggle; the decrypted value is prefilled via get-saved-variable but never
// unmasked until the user clicks the eye.
//
// Depends on globals: escapeHtml (utils.js), showControlToast (control-dialogs.js),
// window.api (preload).

(function () {
  const container = document.getElementById('variables-admin-content');
  if (!container) return;

  let variables = [];     // all rows (list-all-saved-variables)
  let projects = [];      // [{ projectPath, displayName }]
  let scopeFilter = 'all'; // 'all' | 'global' | <projectPath>
  let search = '';

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

  function scopeOptions(selected) {
    const opts = [`<option value="all" ${selected === 'all' ? 'selected' : ''}>All projects</option>`,
      `<option value="global" ${selected === 'global' ? 'selected' : ''}>Global</option>`];
    for (const p of projects) {
      const val = p.projectPath;
      opts.push(`<option value="${escapeHtml(val)}" ${selected === val ? 'selected' : ''}>${escapeHtml(p.displayName || shortName(val))}</option>`);
    }
    return opts.join('');
  }

  function rowHtml(row) {
    const tags = (row.tags || []).map(t => `<span class="va-tag">${escapeHtml(t)}</span>`).join('');
    return `
      <tr data-id="${escapeHtml(row.id)}">
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
      : '<tr><td colspan="5" class="va-empty">No variables match.</td></tr>';
  }

  function render() {
    container.innerHTML = `
      <div class="va-header">
        <span class="va-title">Variables</span>
        <select class="va-scope-filter">${scopeOptions(scopeFilter)}</select>
        <input type="text" class="va-search" placeholder="Filter variables…" value="${escapeHtml(search)}">
        <button class="va-add" data-action="new">+ New variable</button>
        <button class="va-refresh" data-action="refresh" title="Reload">⟳</button>
      </div>
      <div class="va-table-wrap">
        <table class="va-table">
          <thead>
            <tr><th>Name</th><th>Scope</th><th>Secret</th><th>Tags</th><th>Actions</th></tr>
          </thead>
          <tbody>${rowsHtml()}</tbody>
        </table>
      </div>`;

    const filterSel = container.querySelector('.va-scope-filter');
    filterSel.addEventListener('change', () => {
      scopeFilter = filterSel.value;
      const tbody = container.querySelector('.va-table tbody');
      if (tbody) tbody.innerHTML = rowsHtml();
    });
    const searchInput = container.querySelector('.va-search');
    searchInput.addEventListener('input', () => {
      search = searchInput.value.trim().toLowerCase();
      const tbody = container.querySelector('.va-table tbody');
      if (tbody) tbody.innerHTML = rowsHtml();
    });
  }

  async function load() {
    container.innerHTML = '<div class="va-loading">Loading variables…</div>';
    try {
      const [vars, projRes] = await Promise.all([
        window.api.listAllSavedVariables(),
        window.api.getProjectsAdmin().catch(() => null),
      ]);
      variables = Array.isArray(vars) ? vars : [];
      projects = (projRes && Array.isArray(projRes.projects))
        ? projRes.projects.map(p => ({ projectPath: p.projectPath, displayName: p.displayName }))
        : [];
      render();
    } catch (err) {
      container.innerHTML = `<div class="va-loading">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // --- New / Edit dialog ---------------------------------------------------

  function defaultScopeValue() {
    // Pre-select the currently filtered project (if any) for a new variable.
    return (scopeFilter !== 'all' && scopeFilter !== 'global') ? scopeFilter : 'global';
  }

  async function openDialog(existing) {
    const isEdit = !!existing;
    let form = {
      id: existing ? existing.id : null,
      name: existing ? existing.name : '',
      value: '',
      secret: existing ? !!existing.secret : false,
      scopeValue: existing
        ? (existing.scope === 'project' ? existing.projectPath : 'global')
        : defaultScopeValue(),
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
          <label class="va-field"><span>Value</span>
            <div class="va-value-wrap">
              <textarea class="settings-input va-value-input" id="va-f-value" spellcheck="false" autocomplete="off">${escapeHtml(form.value)}</textarea>
              <button type="button" class="va-eye" id="va-f-eye" title="Show / hide value" aria-label="Show / hide value"></button>
            </div></label>
          <div class="va-form-row">
            <label class="va-field"><span>Scope</span>
              <select class="settings-select" id="va-f-scope">${scopeOptions(form.scopeValue)}</select></label>
            <label class="va-secret-toggle"><span>Secret</span>
              <label class="settings-toggle"><input type="checkbox" id="va-f-secret" ${form.secret ? 'checked' : ''}><span class="settings-toggle-slider"></span></label></label>
          </div>
          <label class="va-field"><span>Tags</span>
            <input type="text" class="settings-input" id="va-f-tags" value="${escapeHtml(form.tags)}" placeholder="comma,separated" autocomplete="off" spellcheck="false"></label>
          <label class="va-field"><span>Preset</span>
            <select class="settings-select" id="va-f-preset">
              <option value="">Default (auto)</option>
              <option value="{ref}">Shell value</option>
              <option value="{path}">Path only</option>
              <option value="-i '{path}'">SSH key</option>
              <option value="--defaults-extra-file='{path}'">MySQL defaults-file</option>
              <option value="PGSERVICEFILE='{path}' PGSERVICE=name">Postgres service</option>
              <option value="PGPASSFILE='{path}'">Postgres .pgpass</option>
              <option value="Bearer {ref}">API Bearer</option>
              <option value="__custom__">Custom</option>
            </select></label>
          <label class="va-field"><span>Insert template</span>
            <textarea class="settings-input va-template-input" id="va-f-template" rows="2" placeholder="Default (auto)" autocomplete="off" spellcheck="false">${escapeHtml(form.insertTemplate)}</textarea></label>
          <div class="va-field-help">Placeholders: <code>{path}</code> temp-file path · <code>{ref}</code> shell-native read of that file · <code>{value}</code> raw value. Empty = auto (secret → <code>{ref}</code>, plain → <code>{value}</code>).</div>
          <div class="va-status" id="va-f-status"></div>
          <div class="va-dialog-actions">
            <button type="button" class="va-secondary" id="va-f-cancel">Cancel</button>
            <button type="submit" class="va-primary">Save</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);

    const valueInput = overlay.querySelector('#va-f-value');
    const eyeBtn = overlay.querySelector('#va-f-eye');
    const secretInput = overlay.querySelector('#va-f-secret');
    const scopeSel = overlay.querySelector('#va-f-scope');
    const statusEl = overlay.querySelector('#va-f-status');
    let revealed = false;

    // 'all' is not a valid scope for a variable — drop it from the dialog's
    // scope select so a new variable defaults to Global rather than "All".
    const allOpt = scopeSel.querySelector('option[value="all"]');
    if (allOpt) allOpt.remove();
    // Editing a project-scoped variable whose project isn't in the current
    // projects list — keep its scope by adding the option so save doesn't drop it.
    if (form.scopeValue !== 'global' && form.scopeValue !== 'all'
        && !Array.from(scopeSel.options).some(o => o.value === form.scopeValue)) {
      const opt = document.createElement('option');
      opt.value = form.scopeValue;
      opt.textContent = shortName(form.scopeValue);
      scopeSel.appendChild(opt);
    }
    scopeSel.value = (form.scopeValue === 'all' || !form.scopeValue) ? 'global' : form.scopeValue;

    function applyMask() {
      const mask = form.secret && !revealed;
      valueInput.classList.toggle('secret-masked', mask);
      eyeBtn.style.display = form.secret ? '' : 'none';
      eyeBtn.classList.toggle('revealed', revealed);
    }
    applyMask();

    // Preset only prefills the template field; the value stays freely editable.
    const templateInput = overlay.querySelector('#va-f-template');
    const presetSel = overlay.querySelector('#va-f-preset');
    const CUSTOM = '__custom__';
    // Keep the dropdown honest: it reflects what the template field actually is —
    // '' → Default (auto), an exact preset value → that preset, anything else → Custom.
    function syncPresetFromTemplate() {
      const t = templateInput.value;
      if (t === '') { presetSel.value = ''; return; }
      for (const opt of presetSel.options) {
        if (opt.value !== CUSTOM && opt.value !== '' && opt.value === t) { presetSel.value = t; return; }
      }
      presetSel.value = CUSTOM;
    }
    presetSel.addEventListener('change', () => {
      // Custom just means "edit freely" — don't overwrite the field, focus it.
      if (presetSel.value === CUSTOM) { templateInput.focus(); return; }
      templateInput.value = presetSel.value; // '' clears (Default auto), else the preset
    });
    templateInput.addEventListener('input', syncPresetFromTemplate);
    syncPresetFromTemplate(); // initial dropdown state from the (possibly prefilled) template

    eyeBtn.addEventListener('click', () => { revealed = !revealed; applyMask(); });
    secretInput.addEventListener('change', () => {
      form.secret = secretInput.checked;
      revealed = false;
      applyMask();
    });

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.va-dialog-close').addEventListener('click', close);
    overlay.querySelector('#va-f-cancel').addEventListener('click', close);

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
      const res = await window.api.saveSavedVariable(payload);
      if (!res || !res.ok) {
        statusEl.textContent = res?.error || 'Save failed';
        statusEl.className = 'va-status error';
        return;
      }
      close();
      load();
    });

    overlay.querySelector('#va-f-name').focus();
  }

  // --- Row actions ---------------------------------------------------------

  function findRow(id) { return variables.find(v => v.id === id); }

  async function handleAction(action, id) {
    if (action === 'refresh') { load(); return; }
    if (action === 'new') { openDialog(null); return; }
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
    if (action === 'refresh' || action === 'new') { handleAction(action, null); return; }
    const tr = btn.closest('tr');
    handleAction(action, tr ? tr.dataset.id : null);
  });

  window.loadVariablesAdmin = load;
})();
