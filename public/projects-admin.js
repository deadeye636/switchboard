// Projects-admin tab (#32) — a large-viewport table of ALL projects with per-project
// management: trust (via ~/.claude.json), hidden, favorite, manual-mode allowlist,
// rename (display name), remap, remove. Read-only info columns: sessions, last activity,
// MCP-server count, allowedTools count, last cost. Classic <script> module (no framework),
// same pattern as plans-memory-view.js / stats-view.js.
//
// Depends on globals: escapeHtml, formatDate (utils.js), hideAllViewers (plans-memory-view.js),
// showControlDialog, showControlToast (control-dialogs.js), window.api (preload).

(function () {
  const viewer = document.getElementById('projects-viewer');

  let data = [];         // rows from get-projects-admin
  let autoAdd = true;    // whether project auto-add is on (allowlist irrelevant then)
  let filter = '';       // search substring (lowercased)

  function shortName(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/') || p || '';
  }

  function fmtCost(v) {
    if (v == null) return '';
    return '$' + Number(v).toFixed(2);
  }

  function fmtTokens(v) {
    if (v == null) return '';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      // formatDate (utils.js) expects a Date object, not a string.
      return typeof formatDate === 'function' ? formatDate(d) : d.toLocaleString();
    } catch { return ''; }
  }

  function matches(row) {
    if (!filter) return true;
    return (row.displayName || '').toLowerCase().includes(filter)
      || (row.projectPath || '').toLowerCase().includes(filter);
  }

  function trustCell(row) {
    if (row.trusted == null) {
      return '<span class="pa-trust-na" title="No entry in ~/.claude.json">—</span>';
    }
    const cls = row.trusted ? 'pa-trust-on' : 'pa-trust-off';
    const label = row.trusted ? 'Trusted' : 'Untrusted';
    return `<button class="pa-toggle ${cls}" data-action="trust" title="Toggle trust (~/.claude.json)">${label}</button>`;
  }

  function boolToggle(action, on, onLabel, offLabel, title) {
    const cls = on ? 'pa-toggle-on' : 'pa-toggle-off';
    return `<button class="pa-toggle ${cls}" data-action="${action}" title="${escapeHtml(title)}">${on ? onLabel : offLabel}</button>`;
  }

  function rowHtml(row) {
    const name = row.displayName || shortName(row.projectPath);
    const allowCol = autoAdd
      ? ''
      : `<td class="pa-center">${boolToggle('allowlist', !!row.inAllowlist, 'On', 'Off', 'Manual-mode allowlist (Off also hides)')}</td>`;
    const info = [
      row.mcpServersCount ? row.mcpServersCount + ' MCP' : '',
      row.allowedToolsCount ? row.allowedToolsCount + ' tools' : '',
      fmtCost(row.lastCost),
    ].filter(Boolean).join(' · ');
    return `
      <tr data-path="${escapeHtml(row.projectPath)}" class="${row.missing ? 'pa-missing' : ''}">
        <td class="pa-name">
          <span class="pa-name-text" title="${escapeHtml(row.projectPath)}">${escapeHtml(name)}</span>
          ${row.missing ? '<span class="pa-badge pa-badge-missing" title="Directory not found on disk">missing</span>' : ''}
          ${row.configOnly ? '<span class="pa-badge" title="Only in ~/.claude.json, no Switchboard sessions">config-only</span>' : ''}
          <div class="pa-path">${escapeHtml(row.projectPath)}</div>
        </td>
        <td class="pa-center">${row.sessionCount || 0}</td>
        <td class="pa-nowrap">${escapeHtml(fmtDate(row.lastActivity))}</td>
        <td class="pa-center">${trustCell(row)}</td>
        <td class="pa-center">${boolToggle('hidden', !!row.hidden, 'Hidden', 'Visible', 'Toggle hidden in sidebar')}${row.hidden && row.autoHidden ? '<span class="pa-auto-badge" title="Hidden automatically by inactivity">auto</span>' : ''}</td>
        <td class="pa-center">${boolToggle('favorite', !!row.favorite, '★', '☆', 'Toggle favorite')}</td>
        ${allowCol}
        <td class="pa-info">${escapeHtml(info)}</td>
        <td class="pa-actions">
          <button data-action="rename" title="Rename (display name)">Rename</button>
          <button data-action="remap" title="Remap to another folder">Remap</button>
          <button data-action="remove" class="pa-danger" title="Remove (hide + clear cache)">Remove</button>
        </td>
      </tr>`;
  }

  // Just the table rows for the current filter. Split out so a filter keystroke
  // can refresh only the <tbody> — a full re-render would replace the search
  // input element and steal its focus mid-typing.
  function rowsHtml() {
    const rows = data.filter(matches);
    return rows.length
      ? rows.map(rowHtml).join('')
      : `<tr><td colspan="10" class="pa-empty">No projects match.</td></tr>`;
  }

  function render() {
    const allowHeader = autoAdd ? '' : '<th>Allowlist</th>';
    viewer.innerHTML = `
      <div class="pa-header">
        <span class="pa-title">Projects</span>
        <input type="text" class="pa-search" placeholder="Filter projects…" value="${escapeHtml(filter)}">
        <span class="pa-mode">${autoAdd ? 'Auto-add: on' : 'Manual mode'}</span>
        <button class="pa-add" data-action="add">+ Add project</button>
        <button class="pa-refresh" data-action="refresh" title="Reload">⟳</button>
      </div>
      <div class="pa-table-wrap">
        <table class="pa-table">
          <thead>
            <tr>
              <th>Project</th><th>Sessions</th><th>Last activity</th>
              <th>Trust</th><th>Hidden</th><th>Favorite</th>${allowHeader}
              <th>Info</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml()}
          </tbody>
        </table>
      </div>`;

    const search = viewer.querySelector('.pa-search');
    if (search) {
      // Update only the tbody so the input keeps focus and caret while typing.
      search.addEventListener('input', () => {
        filter = search.value.trim().toLowerCase();
        const tbody = viewer.querySelector('.pa-table tbody');
        if (tbody) tbody.innerHTML = rowsHtml();
      });
    }
  }

  async function load() {
    viewer.innerHTML = '<div class="pa-loading">Loading projects…</div>';
    try {
      const res = await window.api.getProjectsAdmin();
      if (!res || res.error) {
        viewer.innerHTML = `<div class="pa-loading">Error: ${escapeHtml(res && res.error || 'unknown')}</div>`;
        return;
      }
      data = res.projects || [];
      autoAdd = res.autoAdd !== false;
      render();
    } catch (err) {
      viewer.innerHTML = `<div class="pa-loading">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function toast(msg) {
    if (typeof showControlToast === 'function') showControlToast({ message: msg });
  }

  // Remove dialog with two opt-in hard-delete checkboxes (reuses control-dialog CSS).
  // Resolves to { deleteDisk, deleteConfig } on confirm, or null on cancel.
  function confirmRemove(path) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'control-dialog-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'control-dialog control-dialog-danger';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = `
        <div class="control-dialog-kicker">Destructive Action</div>
        <h3>Remove project</h3>
        <p>Always hides the project and clears its Switchboard cache. Optionally also delete
        its data from Claude — these are irreversible.</p>
        <div class="control-dialog-details">
          <div class="control-dialog-detail-row">
            <span class="control-dialog-detail-label">Project</span>
            <span class="control-dialog-detail-value">${escapeHtml(shortName(path))}</span>
          </div>
        </div>
        <label class="pa-check-row"><input type="checkbox" id="pa-del-disk">
          Delete session history on disk (<code>~/.claude/projects</code>)</label>
        <label class="pa-check-row"><input type="checkbox" id="pa-del-config">
          Delete entry in <code>~/.claude.json</code> (trust, MCP, cost)</label>
        <div class="control-dialog-actions">
          <button type="button" class="control-dialog-cancel">Cancel</button>
          <button type="button" class="control-dialog-confirm">Remove</button>
        </div>`;
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const close = (result) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      };
      function onKey(e) { if (e.key === 'Escape') close(null); }
      dialog.querySelector('.control-dialog-cancel').addEventListener('click', () => close(null));
      dialog.querySelector('.control-dialog-confirm').addEventListener('click', () => close({
        deleteDisk: dialog.querySelector('#pa-del-disk').checked,
        deleteConfig: dialog.querySelector('#pa-del-config').checked,
      }));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey);
    });
  }

  function findRow(path) {
    return data.find(r => r.projectPath === path);
  }

  async function handleAction(action, path, tr) {
    const row = findRow(path);
    try {
      if (action === 'trust') {
        if (!row) return;
        const next = !row.trusted;
        if (next) {
          // Setting trust to TRUE bypasses Claude Code's security gate — warn first.
          const ok = await showControlDialog({
            tone: 'danger',
            title: 'Grant trust to this project?',
            message: 'Trusting a project lets Claude Code run its tools, hooks and commands without asking. Only do this for code you know and control.',
            details: [{ label: 'Project', value: shortName(path) }],
            confirmLabel: 'Grant trust',
            cancelLabel: 'Cancel',
          });
          if (!ok) return;
        }
        const res = await window.api.setProjectTrust(path, next);
        if (res && res.error) { toast('Trust: ' + res.error); return; }
      } else if (action === 'hidden') {
        if (row && row.hidden) await window.api.unhideProject(path);
        else await window.api.removeProject(path);
      } else if (action === 'favorite') {
        await window.api.toggleProjectFavorite(path);
      } else if (action === 'allowlist') {
        if (row && row.inAllowlist) await window.api.removeProject(path); // off also hides
        else await window.api.addProject(path);
      } else if (action === 'remove') {
        const choice = await confirmRemove(path);
        if (!choice) return;
        await window.api.removeProject(path); // always: hide + clear Switchboard cache
        if (choice.deleteDisk) {
          const r = await window.api.deleteProjectSessions(path);
          if (r && r.error) { toast('Delete disk: ' + r.error); }
        }
        if (choice.deleteConfig) {
          const r = await window.api.removeProjectConfig(path);
          if (r && r.error) { toast('Delete config: ' + r.error); }
        }
      } else if (action === 'remap') {
        const newPath = await window.api.browseFolder();
        if (!newPath) return;
        const res = await window.api.remapProject(path, newPath);
        if (res && res.error) { toast('Remap: ' + res.error); return; }
      } else if (action === 'rename') {
        startRename(path, tr);
        return; // rename refreshes itself on save
      } else if (action === 'add') {
        const newPath = await window.api.browseFolder();
        if (!newPath) return;
        const res = await window.api.addProject(newPath);
        if (res && res.error) { toast('Add: ' + res.error); return; }
      } else if (action === 'refresh') {
        // fall through to reload
      }
    } catch (err) {
      toast('Error: ' + err.message);
      return;
    }
    load();
  }

  // Inline rename: replace the name cell with an input; Enter saves, Esc cancels.
  function startRename(path, tr) {
    const row = findRow(path);
    const cell = tr && tr.querySelector('.pa-name');
    if (!cell) return;
    const current = row ? (row.displayName || '') : '';
    const placeholder = shortName(path);
    cell.innerHTML = `<input type="text" class="pa-rename-input" value="${escapeHtml(current)}" placeholder="${escapeHtml(placeholder)}">`;
    const input = cell.querySelector('input');
    input.focus();
    input.select();
    let done = false; // guard so Escape's re-render doesn't trigger a blur-commit
    const commit = async () => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      try {
        const settingsKey = 'project:' + path;
        const existing = (await window.api.getSetting(settingsKey)) || {};
        existing.displayName = val;
        await window.api.setSetting(settingsKey, existing);
      } catch (err) {
        toast('Rename: ' + err.message);
      }
      load();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; render(); }
    });
    input.addEventListener('blur', commit);
  }

  // Event delegation for all row/header actions.
  viewer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const tr = btn.closest('tr');
    const path = tr ? tr.dataset.path : null;
    if (action === 'refresh' || action === 'add') { handleAction(action, null, null); return; }
    if (!path) return;
    handleAction(action, path, tr);
  });

  // Public entry point, called from the tab handler in app.js.
  window.loadProjectsAdmin = load;
})();
