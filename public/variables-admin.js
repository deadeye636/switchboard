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
          ${/[{}]/.test(form.name) ? `<div class="va-field-help va-name-warn">This name contains <code>{</code> or <code>}</code>, so it cannot be referenced from another variable's template as <code>{var:name}</code>. It works everywhere else — rename it if you want to reference it.</div>` : ''}
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
          <div class="va-field">
            <div class="va-template-head">
              <span>Insert template</span>
              <div class="va-chips">
                <button type="button" class="va-chip" data-tok="{value}" title="Insert the raw value inline">{value}</button>
                <button type="button" class="va-chip" data-tok="{path}" title="Path of a temp file holding the value — quote this one">{path}</button>
                <button type="button" class="va-chip" data-tok="{ref}" title="The shell reads the temp file. A complete shell word — never quote it">{ref}</button>
                <button type="button" class="va-chip va-chip-var" data-varpick="1" title="Reference another variable">Variable…</button>
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
            <textarea class="settings-input va-template-input" id="va-f-template" rows="3" autocomplete="off" spellcheck="false">${escapeHtml(form.insertTemplate)}</textarea>
          </div>
          <div class="va-preview-head">
            <span>Preview</span>
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
      renderPreview();
    });

    // --- the chips: insert a token at the caret -----------------------------------------------------
    overlay.querySelectorAll('.va-chip[data-tok]').forEach((chip) => {
      chip.addEventListener('click', () => {
        insertAtCaret(templateInput, chip.dataset.tok);
        renderPreview();
      });
    });
    overlay.querySelector('.va-chip[data-varpick]').addEventListener('click', (e) => {
      openVarPicker(e.currentTarget, (name) => {
        insertAtCaret(templateInput, `{var:${name}}`);
        renderPreview();
      });
    });

    function insertAtCaret(el, text) {
      const at = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? at;
      el.setRangeText(text, at, end, 'end');
      el.focus();
    }

    // --- the variable picker ------------------------------------------------------------------------
    // Lists what THIS row could reference: globals plus, for a project-scoped row, that project's. The row
    // being edited is excluded — a self-reference is an instant cycle, so it is not offered.
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
               <span class="va-var-scope">${v.scope === 'project' ? 'Project' : 'Global'}</span>
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
    let previewShell = (navigator.platform || '').toLowerCase().startsWith('win') ? 'pwsh' : 'bash';
    const previewEl = overlay.querySelector('#va-f-preview');
    const notesEl = overlay.querySelector('#va-f-notes');
    const flagsEl = overlay.querySelector('#va-f-flags');
    const shellToggle = overlay.querySelector('#va-f-shell');

    shellToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-shell]');
      if (!btn) return;
      previewShell = btn.dataset.shell;
      renderPreview();
    });

    function previewRowFor(name) {
      const scopeValue = scopeSel.value;
      const rows = variables.filter((v) => v.scope !== 'project' || (scopeValue !== 'global' && v.projectPath === scopeValue));
      const id = VI.buildNameIndex(rows)[name];
      return { row: rows.find((v) => v.id === id) || null, ambiguous: rows.filter((v) => v.name === name).length > 1 };
    }

    function renderPreview() {
      shellToggle.querySelectorAll('[data-shell]').forEach((b) => b.classList.toggle('active', b.dataset.shell === previewShell));
      const row = { insertTemplate: templateInput.value, secret: secretInput.checked };
      const tmpl = VI.effectiveTemplate(row);
      templateInput.placeholder = secretInput.checked
        ? 'Default: {ref} — the shell reads a temp file'
        : 'Default: {value} — inserts the raw value';

      const notes = [];
      let touchesSecret = !!secretInput.checked && tmpl.includes('{value}');
      const vars = {};
      const varRefOffsets = {};
      for (const name of VI.parseVarRefs(tmpl)) {
        const { row: ref, ambiguous } = previewRowFor(name);
        if (!ref) { notes.push(['error', `{var:${name}} — no such variable`]); vars[name] = ''; continue; }
        const childTmpl = VI.finalTemplateFor(ref, false);
        if (ref.secret) {
          touchesSecret = true;
          if (VI.effectiveTemplate(ref).includes('{value}')) {
            notes.push(['info', `${name} is a secret — inserted as a file read, never as plaintext`]);
          }
        }
        const child = VI.compose(childTmpl, {
          path: SYNTH_PATH,
          ref: childTmpl.includes('{ref}') ? VI.shellRefFor(previewShell, SYNTH_PATH) : null,
          value: childTmpl.includes('{value}') ? `⟨value of ${name}⟩` : null,
        });
        vars[name] = child.text;
        varRefOffsets[name] = child.refOffsets;
        notes.push([ambiguous ? 'warn' : 'ok',
          ambiguous
            ? `{var:${name}} — more than one variable is called this; bound to the ${ref.scope === 'project' ? 'project' : 'global'} one`
            : `{var:${name}} → ${ref.scope === 'project' ? 'Project' : 'Global'}`]);
      }

      const own = VI.compose(tmpl, {
        path: SYNTH_PATH,
        ref: tmpl.includes('{ref}') ? VI.shellRefFor(previewShell, SYNTH_PATH) : null,
        value: tmpl.includes('{value}')
          ? (secretInput.checked ? '⟨value⟩' : (valueInput.value || '⟨value⟩'))
          : null,
        vars,
        varRefOffsets,
      });

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
      if (/[\n\r]/.test(own.text)) notes.push(['error', 'The result contains a line break — use {path} for multi-line content. The insert will refuse this.']);
      if (/\{var:(?![^{}]+\})/.test(tmpl)) notes.push(['warn', '{var: without a closing brace is treated as literal text.']);

      previewEl.innerHTML = highlightRefs(own.text, own.refOffsets, unsafe);
      flagsEl.innerHTML = touchesSecret ? '<span class="va-secret-pill" title="This insert reads secret temp files.">Secret</span>' : '';
      notesEl.innerHTML = notes.map(([tone, text]) => `<div class="va-note va-note-${tone}">${escapeHtml(text)}</div>`).join('');
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
    scopeSel.addEventListener('change', renderPreview);

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
    if (action === 'refresh' || action === 'new') { handleAction(action, null); return; }
    const tr = btn.closest('tr');
    handleAction(action, tr ? tr.dataset.id : null);
  });

  window.loadVariablesAdmin = load;
})();
