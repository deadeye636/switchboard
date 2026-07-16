// public/launchers-panel.js — Settings → Terminal → "Terminal tools": the user-managed list of
// Tier-3 custom launchers (T-3.10).
//
// Lives under the TERMINAL category (where users look for terminal things), not "Sessions & CLI".
// Built on the existing settings primitives (.settings-section / .settings-field / .settings-input)
// and the env-row styles the backend editor already uses, so it reads like the rest of Settings.
//
// Settings key: `customLaunchers` — an ARRAY of launcher entries, in both scopes:
//   global  -> a template for every project
//   project -> overrides a global entry (matched by id) or adds a project-only one
// The effective list a project sees = mergeCustomLaunchers(global, project) (custom-launchers.js);
// this panel edits the list of ONE scope and hands it back to settings-panel.js at save time.
//
// It owns the DOM of the section: settings-panel.js mounts it and calls read() on Save.
(function () {
  'use strict';

  const esc = (s) => (typeof escapeHtml === 'function'
    ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  const RUN_MODE_LABEL = {
    'in-app': 'Terminal tab',
    external: 'External window',
  };

  async function confirmDialog(options) {
    if (typeof showControlDialog === 'function') return showControlDialog(options);
    return window.confirm(`${options.title}\n\n${options.message}`);
  }

  const ENV_REF_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
  const envRefName = (value) => {
    const m = ENV_REF_RE.exec(String(value == null ? '' : value).trim());
    return m ? m[1] : null;
  };

  // ---------------------------------------------------------------------------
  // The launcher editor modal. Resolves to the edited entry, or null on cancel.
  // ---------------------------------------------------------------------------
  function openEditor(seed, takenIds) {
    return new Promise((resolve) => {
      let env = Object.assign({}, (seed && seed.env) || {});

      const overlay = document.createElement('div');
      overlay.className = 'new-session-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'new-session-dialog launcher-editor';
      overlay.appendChild(dialog);

      dialog.innerHTML = `
        <h3>${seed && seed.id ? 'Edit terminal tool' : 'New terminal tool'}</h3>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Name</span>
            <div class="settings-description">Shown in the launch menu.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="lc-name" maxlength="100" value="${esc((seed && seed.name) || '')}" placeholder="Dev server">
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Command</span>
            <div class="settings-description">Any command or script — <code>npm run dev</code>, <code>git fetch --all</code>, <code>./scripts/seed.ps1</code>, a bare exe. It runs in your terminal shell, exactly as if you typed it.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="lc-command" value="${esc((seed && seed.command) || '')}" spellcheck="false" placeholder="npm run dev">
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Run in</span>
            <div class="settings-description">A terminal tab is monitored like any other session. An external window is launch-and-forget — Switchboard does not watch it.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="lc-run-mode">
              <option value="in-app" ${(seed && seed.runMode) === 'external' ? '' : 'selected'}>Terminal tab (monitored)</option>
              <option value="external" ${(seed && seed.runMode) === 'external' ? 'selected' : ''}>External window</option>
            </select>
          </div>
        </div>
        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <span class="settings-label">Working directory</span>
            <div class="settings-description">Empty = the project the tool is launched from.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="lc-cwd" value="${esc((seed && seed.cwd) || '')}" spellcheck="false" placeholder="the project directory">
          </div>
        </div>
        <details class="settings-adv backend-env-adv">
          <summary><svg class="settings-adv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>Environment variables</summary>
          <div class="backend-env-hint">Secrets belong in a <code>$VAR</code> reference (e.g. <code>$MY_TOKEN</code>), resolved from your environment when the tool starts. Switchboard never writes a secret to disk.</div>
          <div class="backend-env-rows" id="lc-env-rows"></div>
          <button type="button" class="backend-btn" id="lc-env-add">+ Add variable</button>
        </details>
        <div class="backend-editor-error" id="lc-error" hidden></div>
        <div class="settings-btn-row">
          <button class="settings-cancel-btn" id="lc-cancel">Cancel</button>
          <button class="settings-save-btn" id="lc-save">Save tool</button>
        </div>`;

      document.body.appendChild(overlay);

      const nameInput = dialog.querySelector('#lc-name');
      const commandInput = dialog.querySelector('#lc-command');
      const rowsBox = dialog.querySelector('#lc-env-rows');
      const errorBox = dialog.querySelector('#lc-error');
      const showError = (html) => { errorBox.innerHTML = html; errorBox.hidden = false; };

      function renderRows() {
        const keys = Object.keys(env);
        rowsBox.innerHTML = keys.length
          ? keys.map(k => `
            <div class="backend-env-row" data-key="${esc(k)}">
              <input type="text" class="settings-input backend-env-key" value="${esc(k)}" spellcheck="false" placeholder="MY_VAR">
              <input type="text" class="settings-input backend-env-value" value="${esc(env[k])}" spellcheck="false" placeholder="$MY_TOKEN">
              <span class="backend-env-status" data-state="literal">literal</span>
              <button type="button" class="backend-btn danger backend-env-remove" aria-label="Remove ${esc(k)}">&times;</button>
            </div>`).join('')
          : '<div class="backend-env-empty">No environment variables.</div>';
        refreshResolveStatus();
      }

      // Presence-only check (never values): an unresolved $VAR is DROPPED at spawn, so say so here.
      async function refreshResolveStatus() {
        const rows = Array.from(rowsBox.querySelectorAll('.backend-env-row'));
        const refs = [];
        rows.forEach(row => {
          const ref = envRefName(row.querySelector('.backend-env-value').value);
          if (ref) refs.push(ref);
        });
        let presence = {};
        if (refs.length && window.api && typeof window.api.checkEnvRefs === 'function') {
          try { presence = (await window.api.checkEnvRefs(refs)) || {}; } catch { presence = {}; }
        }
        rows.forEach(row => {
          const status = row.querySelector('.backend-env-status');
          const ref = envRefName(row.querySelector('.backend-env-value').value);
          if (!ref) {
            status.dataset.state = 'literal';
            status.textContent = 'literal';
            status.title = 'A plain value, stored as-is. Never put a secret here.';
            return;
          }
          const ok = !!presence[ref];
          status.dataset.state = ok ? 'ok' : 'missing';
          status.textContent = ok ? 'resolves ✓' : 'not set ✗';
          status.title = ok
            ? `$${ref} is set in your environment.`
            : `$${ref} is not set — it would be dropped when the tool starts.`;
        });
      }

      function syncEnvFromRows() {
        const next = {};
        rowsBox.querySelectorAll('.backend-env-row').forEach(row => {
          const k = row.querySelector('.backend-env-key').value.trim();
          if (!k) return;
          next[k] = row.querySelector('.backend-env-value').value;
        });
        env = next;
      }

      let statusTimer = null;
      rowsBox.addEventListener('input', (e) => {
        if (!e.target.classList.contains('backend-env-value') && !e.target.classList.contains('backend-env-key')) return;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(refreshResolveStatus, 250);
      });
      rowsBox.addEventListener('click', (e) => {
        if (!e.target.closest('.backend-env-remove')) return;
        e.target.closest('.backend-env-row').remove();
        syncEnvFromRows();
        renderRows();
      });
      dialog.querySelector('#lc-env-add').addEventListener('click', () => {
        syncEnvFromRows();
        let k = 'NEW_VAR';
        let n = 2;
        while (env[k] !== undefined) k = `NEW_VAR_${n++}`;
        env[k] = '';
        renderRows();
      });
      renderRows();

      const close = (entry) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(entry);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      dialog.querySelector('#lc-cancel').addEventListener('click', () => close(null));

      dialog.querySelector('#lc-save').addEventListener('click', () => {
        errorBox.hidden = true;
        syncEnvFromRows();
        const name = nameInput.value.trim();
        const command = commandInput.value.trim();
        if (!command) { showError('Give the tool a command to run.'); commandInput.focus(); return; }

        const id = (seed && seed.id)
          || (window.launcherId ? window.launcherId(name || command, takenIds || new Set()) : String(Date.now()));
        const entry = window.normalizeLauncher({
          id,
          name: name || command,
          command,
          cwd: dialog.querySelector('#lc-cwd').value.trim(),
          env,
          runMode: dialog.querySelector('#lc-run-mode').value,
          // args/icon are part of the entry shape but not exposed in this form — an entry that
          // carries them (edited by hand, or seeded elsewhere) keeps them.
          args: (seed && seed.args) || undefined,
          icon: (seed && seed.icon) || undefined,
        });
        if (!entry) { showError('Give the tool a command to run.'); return; }
        close(entry);
      });

      nameInput.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // The section itself.
  // ---------------------------------------------------------------------------

  // ctx = { isProject, settings, globalSettings, useGlobalCheckbox(key) }
  function mount(root, ctx) {
    // custom-launchers.js owns the shape + the cascade; without it there is nothing to edit.
    if (!root || typeof window.mergeCustomLaunchers !== 'function') return;
    const isProject = !!ctx.isProject;
    const globalList = window.normalizeLauncherList(((ctx.globalSettings || {}).customLaunchers) || []);
    // The scope's OWN list — what this panel edits and what read() hands back on Save. In the
    // project scope an absent list means "inherit the global template" (the use-global checkbox).
    const own = window.normalizeLauncherList(((ctx.settings || {}).customLaunchers) || []);
    const inherit = isProject && (
      (ctx.settings || {}).customLaunchers === undefined || (ctx.settings || {}).customLaunchers === null
    );

    const box = document.createElement('div');
    box.className = 'launchers-panel';
    box._list = own.slice();          // working copy, read back by read()
    box._globalList = globalList;

    function rowHtml(entry, origin, disabled) {
      const pill = origin === 'global'
        ? '<span class="launcher-pill">global</span>'
        : (origin === 'override' ? '<span class="launcher-pill override">overrides global</span>' : '');
      const actions = origin === 'global'
        ? `<button type="button" class="backend-btn" data-act="override" data-id="${esc(entry.id)}" ${disabled}>Override here</button>`
        : `<button type="button" class="backend-btn" data-act="edit" data-id="${esc(entry.id)}" ${disabled}>Edit</button>
           <button type="button" class="backend-btn danger" data-act="delete" data-id="${esc(entry.id)}" ${disabled}>${origin === 'override' ? 'Reset' : 'Delete'}</button>`;
      return `
        <div class="settings-field launcher-row" data-id="${esc(entry.id)}">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">${esc(entry.name)}</span>
              <span class="launcher-pill mode">${esc(RUN_MODE_LABEL[entry.runMode] || RUN_MODE_LABEL['in-app'])}</span>
              ${pill}
            </div>
            <div class="settings-description launcher-cmd"><code>${esc(entry.command)}</code></div>
          </div>
          <div class="settings-field-control">${actions}</div>
        </div>`;
    }

    function render() {
      // What this project actually sees in its launch menu: global ⊕ own (own wins by id).
      const effective = isProject
        ? window.mergeCustomLaunchers(globalList, inherit ? [] : box._list)
        : box._list;
      const disabled = inherit ? 'disabled' : '';

      const rows = effective.length
        ? effective.map(e => rowHtml(
            e,
            isProject ? window.launcherOrigin(e.id, globalList, inherit ? [] : box._list) : 'own',
            disabled
          )).join('')
        : `<div class="settings-field"><div class="settings-field-info"><div class="settings-description launcher-empty">${isProject
            ? 'No terminal tools yet. Add one here, or define a global tool that every project inherits.'
            : 'No terminal tools yet. Add one — it becomes available in every project\'s launch menu.'}</div></div></div>`;

      box.innerHTML = `
        <div class="settings-section">
          <div class="settings-section-title launcher-head">
            <span>Terminal tools</span>
            ${isProject && ctx.useGlobalCheckbox ? ctx.useGlobalCheckbox('customLaunchers') : ''}
          </div>
          <div class="settings-hint">${isProject
            ? 'Saved commands for this project\'s launch menu. Global tools are inherited; overriding one here changes it for this project only.'
            : 'Saved commands — any script or command line — offered in every project\'s launch menu, under Terminal. A project can override an entry or add its own.'}</div>
          ${rows}
          <div class="settings-field">
            <div class="settings-field-control">
              <button type="button" class="backend-btn" data-act="add" ${disabled}>+ Add tool</button>
            </div>
          </div>
        </div>`;
    }

    render();
    root.replaceChildren(box);

    // The project scope's "use global default" checkbox gates the whole panel.
    root.addEventListener('change', (e) => {
      const cb = e.target.closest && e.target.closest('.use-global-cb');
      if (!cb || cb.dataset.field !== 'customLaunchers') return;
      box.querySelectorAll('.backend-btn').forEach(b => { b.disabled = cb.checked; });
    });

    box.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      // The checkbox lives inside the re-rendered box, so re-read it every time.
      const useGlobal = box.querySelector('.use-global-cb[data-field="customLaunchers"]');
      const keepChecked = !!(useGlobal && useGlobal.checked);
      const taken = new Set([...globalList.map(g => g.id), ...box._list.map(l => l.id)]);

      if (act === 'add') {
        const entry = await openEditor({}, taken);
        if (!entry) return;
        box._list.push(entry);
      } else if (act === 'override') {
        // Copy the inherited global entry into the project list — same id, so it REPLACES it there.
        const source = globalList.find(g => g.id === btn.dataset.id);
        if (!source) return;
        const entry = await openEditor(Object.assign({}, source), taken);
        if (!entry) return;
        box._list = box._list.filter(l => l.id !== entry.id).concat([entry]);
      } else if (act === 'edit') {
        const source = box._list.find(l => l.id === btn.dataset.id);
        if (!source) return;
        const entry = await openEditor(Object.assign({}, source), taken);
        if (!entry) return;
        box._list = box._list.map(l => (l.id === entry.id ? entry : l));
      } else if (act === 'delete') {
        const source = box._list.find(l => l.id === btn.dataset.id);
        if (!source) return;
        const isOverride = globalList.some(g => g.id === source.id);
        const go = await confirmDialog({
          title: isOverride ? `Reset “${source.name}”?` : `Delete “${source.name}”?`,
          message: isOverride
            ? 'This project goes back to the global tool of the same name.'
            : 'The tool is removed from the launch menu. Nothing else is touched.',
          confirmLabel: isOverride ? 'Reset' : 'Delete',
          cancelLabel: 'Cancel',
          tone: 'danger',
        });
        if (!go) return;
        box._list = box._list.filter(l => l.id !== source.id);
      } else {
        return;
      }

      render();
      // Re-render wipes the checkbox state — restore it, and the disabled state with it.
      const cb = box.querySelector('.use-global-cb[data-field="customLaunchers"]');
      if (cb) {
        cb.checked = keepChecked;
        box.querySelectorAll('.backend-btn').forEach(b => { b.disabled = keepChecked; });
      }
    });
  }

  /**
   * The scope's own list, at Save time. Returns null when the section never mounted, so a save
   * can't clobber the stored launchers with an empty array.
   */
  function read(root) {
    const box = root && root.querySelector('.launchers-panel');
    if (!box) return null;
    return window.normalizeLauncherList(box._list || []);
  }

  window.launchersPanel = { mount, read, openEditor };
})();
