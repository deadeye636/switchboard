// --- Saved variables panel ---

(function () {
  let overlay = null;
  let state = null;
  let refs = {};

  function html(value) {
    return escapeHtml(String(value ?? ''));
  }

  function shortProjectName(projectPath) {
    if (!projectPath) return 'Global';
    const parts = projectPath.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join('/') || projectPath;
  }

  function blankForm(projectPath) {
    return {
      id: null,
      name: '',
      value: '',
      secret: false,
      scope: projectPath ? 'project' : 'global',
      tags: '',
    };
  }

  function closePanel() {
    if (!overlay) return;
    document.removeEventListener('keydown', onDocumentKeydown);
    overlay.remove();
    overlay = null;
    state = null;
    refs = {};
  }

  function onDocumentKeydown(event) {
    if (event.key === 'Escape') closePanel();
  }

  function setStatus(message, tone = '') {
    if (!refs.status) return;
    refs.status.textContent = message || '';
    refs.status.className = 'variables-status' + (tone ? ' ' + tone : '');
  }

  function selectedIds() {
    return Array.from(state.selectedIds);
  }

  function filteredVariables() {
    const query = state.query.trim().toLowerCase();
    if (!query) return state.variables;
    return state.variables.filter(variable => {
      const haystack = [
        variable.name,
        variable.scope,
        variable.projectPath,
        ...(variable.tags || []),
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      return ok;
    }
  }

  async function loadVariables() {
    const result = await window.api.listSavedVariables(state.projectPath);
    if (Array.isArray(result)) {
      state.variables = result;
      const validIds = new Set(result.map(variable => variable.id));
      for (const id of Array.from(state.selectedIds)) {
        if (!validIds.has(id)) state.selectedIds.delete(id);
      }
      return true;
    }
    state.variables = [];
    setStatus(result?.error || 'Could not load variables', 'error');
    return false;
  }

  function renderList() {
    const variables = filteredVariables();
    if (!variables.length) {
      refs.list.innerHTML = '<div class="variables-empty">No variables</div>';
      renderActions();
      return;
    }

    refs.list.innerHTML = variables.map(variable => {
      const checked = state.selectedIds.has(variable.id) ? 'checked' : '';
      const scopeLabel = variable.scope === 'project' ? shortProjectName(variable.projectPath) : 'Global';
      const tags = (variable.tags || []).map(tag => `<span class="variable-tag">${html(tag)}</span>`).join('');
      return `
        <div class="variable-row" data-id="${html(variable.id)}">
          <label class="variable-check">
            <input type="checkbox" data-variable-select="${html(variable.id)}" ${checked}>
          </label>
          <div class="variable-row-main">
            <div class="variable-name-line">
              <span class="variable-name">${html(variable.name)}</span>
              ${variable.secret ? '<span class="variable-secret-pill">Secret</span>' : ''}
            </div>
            <div class="variable-meta-line">
              <span class="variable-scope">${html(scopeLabel)}</span>
              ${tags}
            </div>
          </div>
          <div class="variable-row-actions">
            <button type="button" data-variable-action="copy" title="Copy value" aria-label="Copy value"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
            <button type="button" data-variable-action="edit" title="Edit" aria-label="Edit"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
            <button type="button" data-variable-action="delete" title="Delete" aria-label="Delete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg></button>
          </div>
        </div>
      `;
    }).join('');
    renderActions();
  }

  function renderForm() {
    const form = state.form;
    const hasProject = !!state.projectPath;
    const title = form.id ? 'Edit Variable' : 'New Variable';
    refs.form.innerHTML = `
      <div class="variables-form-title">${title}</div>
      <label class="variables-field">
        <span>Name</span>
        <input type="text" class="settings-input" id="variable-name-input" value="${html(form.name)}" autocomplete="off" spellcheck="false">
      </label>
      <label class="variables-field">
        <span>Value</span>
        <textarea class="settings-input variable-value-input" id="variable-value-input" spellcheck="false" autocomplete="off">${html(form.value)}</textarea>
      </label>
      <div class="variables-form-row">
        <label class="variables-field">
          <span>Scope</span>
          <select class="settings-select" id="variable-scope-input">
            <option value="project" ${form.scope === 'project' ? 'selected' : ''} ${hasProject ? '' : 'disabled'}>${html(shortProjectName(state.projectPath))}</option>
            <option value="global" ${form.scope === 'global' ? 'selected' : ''}>Global</option>
          </select>
        </label>
        <label class="variables-secret-toggle">
          <span>Secret</span>
          <label class="settings-toggle"><input type="checkbox" id="variable-secret-input" ${form.secret ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
        </label>
      </div>
      <label class="variables-field">
        <span>Tags</span>
        <input type="text" class="settings-input" id="variable-tags-input" value="${html(form.tags)}" autocomplete="off" spellcheck="false">
      </label>
      <div class="variables-form-actions">
        <button type="button" class="variables-secondary-action" id="variable-clear-btn">Clear</button>
        <button type="submit" class="variables-primary-action">Save</button>
      </div>
    `;

    refs.form.querySelector('#variable-name-input').addEventListener('input', event => {
      state.form.name = event.target.value;
    });
    refs.form.querySelector('#variable-value-input').addEventListener('input', event => {
      state.form.value = event.target.value;
    });
    refs.form.querySelector('#variable-scope-input').addEventListener('change', event => {
      state.form.scope = event.target.value;
    });
    refs.form.querySelector('#variable-secret-input').addEventListener('change', event => {
      state.form.secret = event.target.checked;
    });
    refs.form.querySelector('#variable-tags-input').addEventListener('input', event => {
      state.form.tags = event.target.value;
    });
    refs.form.querySelector('#variable-clear-btn').addEventListener('click', () => {
      state.form = blankForm(state.projectPath);
      renderForm();
      setStatus('');
    });
  }

  function renderActions() {
    const hasSelection = state.selectedIds.size > 0;
    refs.copySelected.disabled = !hasSelection;
    refs.insertSelected.disabled = !hasSelection || !state.running || !state.sessionId;
    refs.sendSelected.disabled = !hasSelection || !state.running || !state.sessionId;
  }

  async function fetchVariable(id) {
    const result = await window.api.getSavedVariable(id);
    if (!result?.ok) throw new Error(result?.error || 'Could not load variable');
    return result.variable;
  }

  async function handleRowAction(action, id) {
    try {
      if (action === 'copy') {
        const variable = await fetchVariable(id);
        const copied = await copyText(variable.value || '');
        setStatus(copied ? 'Copied' : 'Copy failed', copied ? '' : 'error');
        return;
      }
      if (action === 'edit') {
        const variable = await fetchVariable(id);
        state.form = {
          id: variable.id,
          name: variable.name || '',
          value: variable.value || '',
          secret: !!variable.secret,
          scope: variable.scope || 'global',
          tags: (variable.tags || []).join(', '),
        };
        renderForm();
        setStatus('');
        return;
      }
      if (action === 'delete') {
        const variable = state.variables.find(item => item.id === id);
        if (!confirm(`Delete ${variable?.name || 'variable'}?`)) return;
        const result = await window.api.deleteSavedVariable(id);
        if (!result?.ok) throw new Error(result?.error || 'Delete failed');
        state.selectedIds.delete(id);
        if (state.form.id === id) state.form = blankForm(state.projectPath);
        await loadVariables();
        renderList();
        renderForm();
        setStatus('Deleted');
      }
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  async function handleUse(mode) {
    const ids = selectedIds();
    if (!ids.length) return;

    try {
      const result = await window.api.useSavedVariables(ids);
      if (!result?.ok) throw new Error(result?.error || 'Could not load variables');

      if (mode === 'copy') {
        const copied = await copyText(result.text || '');
        setStatus(copied ? 'Copied' : 'Copy failed', copied ? '' : 'error');
      } else {
        if (!state.running || !state.sessionId) {
          setStatus('No running terminal', 'error');
          return;
        }
        window.api.sendInput(state.sessionId, result.text + (mode === 'send' ? '\n' : ''));
        window._openSessions?.get(state.sessionId)?.terminal?.focus();
        setStatus(mode === 'send' ? 'Sent' : 'Inserted');
      }

      await loadVariables();
      renderList();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  async function saveForm(event) {
    event.preventDefault();
    setStatus('');

    const payload = {
      id: state.form.id || undefined,
      name: state.form.name,
      value: state.form.value,
      secret: state.form.secret,
      scope: state.form.scope,
      projectPath: state.form.scope === 'project' ? state.projectPath : null,
      tags: state.form.tags,
    };

    const result = await window.api.saveSavedVariable(payload);
    if (!result?.ok) {
      setStatus(result?.error || 'Save failed', 'error');
      return;
    }

    state.form = blankForm(state.projectPath);
    await loadVariables();
    renderList();
    renderForm();
    setStatus('Saved');
  }

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'new-session-overlay variables-dialog-overlay';
    overlay.innerHTML = `
      <div class="variables-dialog" role="dialog" aria-modal="true" aria-label="Saved variables">
        <div class="variables-dialog-header">
          <div>
            <h3>Saved Variables</h3>
            <div class="variables-dialog-subtitle">${html(shortProjectName(state.projectPath))}</div>
          </div>
          <button type="button" class="skills-dialog-close variables-close-btn" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="variables-toolbar">
          <input type="search" class="settings-input variables-search" placeholder="Search" autocomplete="off">
          <button type="button" class="variables-new-btn">New</button>
        </div>
        <div class="variables-body">
          <div class="variables-list"></div>
          <form class="variables-form"></form>
        </div>
        <div class="variables-footer">
          <div class="variables-status"></div>
          <div class="variables-footer-actions">
            <button type="button" class="variables-secondary-action" data-use-mode="copy">Copy</button>
            <button type="button" class="variables-secondary-action" data-use-mode="insert">Insert</button>
            <button type="button" class="variables-primary-action" data-use-mode="send">Send</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    refs = {
      dialog: overlay.querySelector('.variables-dialog'),
      list: overlay.querySelector('.variables-list'),
      form: overlay.querySelector('.variables-form'),
      status: overlay.querySelector('.variables-status'),
      search: overlay.querySelector('.variables-search'),
      copySelected: overlay.querySelector('[data-use-mode="copy"]'),
      insertSelected: overlay.querySelector('[data-use-mode="insert"]'),
      sendSelected: overlay.querySelector('[data-use-mode="send"]'),
    };

    overlay.addEventListener('click', event => {
      if (event.target === overlay) closePanel();
    });
    overlay.querySelector('.variables-close-btn').addEventListener('click', closePanel);
    overlay.querySelector('.variables-new-btn').addEventListener('click', () => {
      state.form = blankForm(state.projectPath);
      renderForm();
      setStatus('');
      refs.form.querySelector('#variable-name-input')?.focus();
    });
    refs.search.addEventListener('input', event => {
      state.query = event.target.value;
      renderList();
    });
    refs.list.addEventListener('change', event => {
      const checkbox = event.target.closest('[data-variable-select]');
      if (!checkbox) return;
      if (checkbox.checked) state.selectedIds.add(checkbox.dataset.variableSelect);
      else state.selectedIds.delete(checkbox.dataset.variableSelect);
      renderActions();
    });
    refs.list.addEventListener('click', event => {
      const actionButton = event.target.closest('[data-variable-action]');
      if (actionButton) {
        const row = actionButton.closest('.variable-row');
        handleRowAction(actionButton.dataset.variableAction, row.dataset.id);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.target.closest('input,button')) return;
      const row = event.target.closest('.variable-row');
      if (!row) return;
      const id = row.dataset.id;
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
      renderList();
    });
    refs.form.addEventListener('submit', saveForm);
    overlay.querySelectorAll('[data-use-mode]').forEach(button => {
      button.addEventListener('click', () => handleUse(button.dataset.useMode));
    });
    document.addEventListener('keydown', onDocumentKeydown);
  }

  async function showSavedVariablesPanel(context = {}) {
    closePanel();
    state = {
      sessionId: context.sessionId || null,
      projectPath: context.projectPath || null,
      running: !!context.running,
      variables: [],
      selectedIds: new Set(),
      query: '',
      form: null,
    };
    state.form = blankForm(state.projectPath);
    createOverlay();
    renderForm();
    setStatus('Loading');
    const loaded = await loadVariables();
    renderList();
    if (loaded) setStatus('');
    refs.search.focus();
  }

  window.showSavedVariablesPanel = showSavedVariablesPanel;
})();
