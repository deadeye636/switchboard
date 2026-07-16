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
  let trustable = [];    // the backends that HAVE a per-project trust gate (#171): Claude, Codex — not Pi/Hermes
  let filter = '';       // search substring (lowercased)
  let unlistedOnly = false;  // show only projects that have sessions but are not on the list (#183)

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
    // Opened from the sidebar's "not on your list" notice (#183): show only those projects, so the one
    // the user came here for is not a needle in the full table.
    if (unlistedOnly && (row.inAllowlist || !row.sessionCount)) return false;
    if (!filter) return true;
    return (row.displayName || '').toLowerCase().includes(filter)
      || (row.projectPath || '').toLowerCase().includes(filter);
  }

  // Trust is per BACKEND (#171). It used to be one button that said "Trusted" and wrote Claude's config
  // — so Codex, which has its own "Do you trust this directory?" gate in its own config, kept asking.
  // One chip per backend that HAS such a gate; Pi and Hermes have none and appear here at all.
  function trustCell(row) {
    if (!trustable.length) return '<span class="pa-trust-na">—</span>';
    return trustable.map(b => {
      const state = row.trust ? row.trust[b.id] : null;
      const cls = state === true ? 'pa-trust-on' : (state === false ? 'pa-trust-off' : 'pa-trust-na');
      const label = state === true ? 'Trusted' : (state === false ? 'Untrusted' : 'Not asked');
      return `<button class="pa-toggle pa-trust-chip ${cls}" data-action="trust" data-backend="${escapeHtml(b.id)}"`
        + ` title="${escapeHtml(b.label)}: ${label} — click to toggle">${escapeHtml(monogramOf(b.id))}</button>`;
    }).join('');
  }

  // Which backends actually have sessions in this project. The manager showed a Claude-and-Codex project
  // exactly like a Claude one — `session_cache.backendId` knew all along.
  function backendsCell(row) {
    const ids = row.backends || [];
    if (!ids.length) return '<span class="pa-trust-na">—</span>';
    return ids.map(id =>
      `<span class="pa-backend-badge backend-${escapeHtml(id)}" title="${escapeHtml(labelOf(id))}">${escapeHtml(monogramOf(id))}</span>`
    ).join('');
  }

  function backendMeta(id) {
    try { return (window._backendsById || {})[id] || null; } catch { return null; }
  }
  function monogramOf(id) {
    const b = backendMeta(id);
    return (b && b.monogram) || String(id).slice(0, 2);
  }
  function labelOf(id) {
    const b = backendMeta(id);
    return (b && b.label) || id;
  }

  function boolToggle(action, on, onLabel, offLabel, title) {
    const cls = on ? 'pa-toggle-on' : 'pa-toggle-off';
    return `<button class="pa-toggle ${cls}" data-action="${action}" title="${escapeHtml(title)}">${on ? onLabel : offLabel}</button>`;
  }

  // The same warning triangle the sidebar shows for an unavailable project (#135),
  // and it re-checks on click like that one does — this is where the user decides
  // between remap and delete, so "the drive was merely unmounted" has to be one
  // click away, not a dead text badge.
  function missingIcon() {
    return '<button type="button" class="pa-missing-icon" data-action="recheck" title="Unavailable — click to re-check (e.g. after mounting the drive)" aria-label="Unavailable — re-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></button>';
  }

  // An eye, like Favorite's star — a glyph, not a sentence. The cell used to spell out "Hidden"/"Visible"
  // and hang an "auto" badge next to it: three words in a column that answers a yes/no question, in a
  // table that already says everything else in one symbol.
  //
  // Auto-hidden is a THIRD state, not a footnote on the second (#167): the machine hid it because it went
  // stale, and activity brings it back by itself — which a hide the user made never does. So it gets its
  // own eye (dashed, dimmer), not a badge bolted onto the same one.
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  // Hiding is a property of a LISTED project. A project that is not on the list is not hidden — it is
  // simply not there, and offering the toggle would write a flag that nothing shows and nothing clears
  // (and that would ambush the user the day discovery registers the project). Use the "Listed" toggle.
  function hiddenCell(row) {
    if (!row.registered) {
      return '<span class="pa-dash" title="Not on the project list, so there is nothing to hide. Put it on the list first — see Listed.">—</span>';
    }

    // The same pill the Favorite and Listed toggles sit in — only the content is a glyph instead of a
    // word. Each state says what it MEANS, not just what it is: what brings the project back is the
    // whole difference between the three, and it is the thing a user cannot guess.
    let cls = 'pa-toggle pa-eye pa-eye-shown';
    let icon = EYE;
    let title = 'Shown in the sidebar.\n\nClick to hide it: it stays on the list and its sessions keep being '
      + 'indexed, you just stop seeing it. Useful for a project you are done with but do not want to remove.';
    let label = 'Shown — click to hide';

    if (row.autoHidden) {
      cls = 'pa-toggle pa-eye pa-eye-auto';
      icon = EYE_OFF;
      title = 'Hidden AUTOMATICALLY — nothing has happened here for a while (Settings → auto-hide).\n\n'
        + 'It un-hides itself the moment you work in it again. Click to bring it back now.';
      label = 'Hidden automatically (inactive) — click to show';
    } else if (row.hidden) {
      cls = 'pa-toggle pa-eye pa-eye-hidden';
      icon = EYE_OFF;
      title = 'Hidden BY YOU — and it stays hidden: new sessions here do NOT bring it back. That is the '
        + 'point of hiding.\n\nClick to show it again.';
      label = 'Hidden — click to show';
    }

    return `<button type="button" class="${cls}" data-action="hidden" title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
  }

  // On the list, or not — in BOTH modes (#167). It used to appear only in manual mode, because the list
  // was a derivation and this was a subtractive filter over it; a project with a config but no sessions
  // was badged `config-only` and there was no control anywhere to put it in the sidebar.
  //
  // A tick, filled or hollow — the same shape either way, exactly as Favorite is ★ and ☆. It said "On" /
  // "Off" before, which is a switch with no subject: on WHAT? Every other column in this row shows a
  // STATE (a star, an eye, a backend's initial); this one showed that something, somewhere, was enabled.
  const TICK_ON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 14.6L6.6 12.4 8 11l2.8 2.8L16 8.6l1.4 1.4-6.6 6.6z"/></svg>';
  const TICK_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/></svg>';

  function listedCell(row) {
    const on = !!row.inAllowlist;
    const title = on
      ? 'On Switchboard\'s project list.\n\nClick to REMOVE it: it leaves the list and its cached sessions '
        + 'are cleared. No transcript is deleted — they stay on disk. A NEW session in this folder brings '
        + 'the project back, with all of its history. The old sessions alone do not.'
      : 'NOT on the list, so Switchboard ignores it.\n\nClick to add it — even if it has no sessions at all '
        + '(a project you are about to start work in).';
    const label = on ? 'On the list — click to remove' : 'Not on the list — click to add';
    const cls = on ? 'pa-toggle pa-tick pa-tick-on' : 'pa-toggle pa-tick pa-tick-off';

    return `<button type="button" class="${cls}" data-action="allowlist" title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}">${on ? TICK_ON : TICK_OFF}</button>`;
  }

  function rowHtml(row) {
    const name = row.displayName || shortName(row.projectPath);
    const allowCol = `<td class="pa-center">${listedCell(row)}</td>`;
    const info = [
      row.mcpServersCount ? row.mcpServersCount + ' MCP' : '',
      row.allowedToolsCount ? row.allowedToolsCount + ' tools' : '',
      fmtCost(row.lastCost),
    ].filter(Boolean).join(' · ');
    return `
      <tr data-path="${escapeHtml(row.projectPath)}" class="${row.missing ? 'pa-missing' : ''}">
        <td class="pa-name">
          ${row.missing ? missingIcon() : ''}
          <div class="pa-name-main">
            <span class="pa-name-text" title="${escapeHtml(row.projectPath)}">${escapeHtml(name)}</span>
            ${row.configOnly ? '<span class="pa-badge" title="Only in ~/.claude.json, no Switchboard sessions">config-only</span>' : ''}
            <div class="pa-path">${escapeHtml(row.projectPath)}</div>
          </div>
        </td>
        <td class="pa-center">${row.sessionCount || 0}</td>
        <td class="pa-center">${backendsCell(row)}</td>
        <td class="pa-nowrap">${escapeHtml(fmtDate(row.lastActivity))}</td>
        <td class="pa-info">${escapeHtml(info)}</td>
        <td class="pa-center">${trustCell(row)}</td>
        <td class="pa-center">${hiddenCell(row)}</td>
        <td class="pa-center">${boolToggle('favorite', !!row.favorite, '★', '☆', row.favorite
          ? 'A favourite: it sits at the top of the sidebar, ahead of every other project.\n\nClick to remove it from the favourites.'
          : 'Click to make it a favourite — favourites are pinned to the top of the sidebar, ahead of every other project.')}</td>
        ${allowCol}
        <td class="pa-actions">
          <button data-action="settings" title="Open this project's settings">Settings</button>
          <button data-action="rename" title="Rename (display name)">Rename</button>
          <button data-action="remap" title="Remap to another folder">Remap</button>
          <button data-action="remove" class="pa-danger" title="Remove from Switchboard (off the list, cached sessions cleared)">Remove</button>
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
      : `<tr><td colspan="11" class="pa-empty">No projects match.</td></tr>`;
  }

  function render() {
    // The two columns answer DIFFERENT questions, and confusing them is what this feature was built to
    // stop (#167): "Listed" is whether the project exists for Switchboard at all; "Hidden" is whether you
    // want to look at it. So each header says what the column is FOR, not what it toggles.
    const allowHeader = '<th title="Is this project on Switchboard\'s list at all?'
      + '&#10;&#10;Off = removed: it leaves the list and its cached sessions are cleared — but no transcript is deleted.'
      + ' A NEW session in that folder brings the project back with its full history; the old sessions alone do not.'
      + '&#10;&#10;A project can be on the list with NO sessions at all — add one before you start working in it.">Listed</th>';
    viewer.innerHTML = `
      <div class="pa-header">
        <span class="pa-title">Projects</span>
        <input type="text" class="pa-search" placeholder="Filter projects…" value="${escapeHtml(filter)}">
        ${unlistedOnly ? '<button type="button" class="pa-chip" data-action="clear-unlisted" title="Showing only projects that have sessions but are not on the list. Click the tick under “Listed” to add one.">Not on the list &times;</button>' : ''}
        <span class="pa-mode">${autoAdd ? 'Auto-add: on' : 'Manual mode'}</span>
        <button class="pa-add" data-action="add">+ Add project</button>
        <button class="pa-refresh" data-action="refresh" title="Reload">⟳</button>
      </div>
      <div class="pa-table-wrap">
        <table class="pa-table">
          <thead>
            <tr>
              <th>Project</th><th>Sessions</th><th title="Which backends have sessions in this project">Backends</th><th>Last activity</th>
              <th title="What ~/.claude.json knows about this project: MCP servers, allowed tools, and what its last session cost">Info</th>
              <th title="Trust is per backend — Claude keeps it in ~/.claude.json, Codex in its own config">Trust</th><th title="Do you want to SEE this project? It stays on the list either way, and its sessions keep being indexed — hiding is about the sidebar, not about the data.&#10;&#10;A hide you make yourself STAYS: new sessions here do not bring it back, only you do.&#10;&#10;A dashed, blue eye means the app hid it because it went stale — that one un-hides itself as soon as you work in the project again.">Hidden</th><th title="A favourite is pinned to the top of the sidebar, ahead of every other project — however old it is.">Favorite</th>${allowHeader}
              <th>Actions</th>
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
    // Set by the sidebar's "not on your list" notice (#183) right before it switches to this tab.
    // Consumed once: opening the manager again shows everything, as it always did.
    if (window._paUnlistedOnly) {
      unlistedOnly = true;
      window._paUnlistedOnly = false;
    }
    viewer.innerHTML = '<div class="pa-loading">Loading projects…</div>';
    try {
      const res = await window.api.getProjectsAdmin();
      if (!res || res.error) {
        viewer.innerHTML = `<div class="pa-loading">Error: ${escapeHtml(res && res.error || 'unknown')}</div>`;
        return;
      }
      data = res.projects || [];
      autoAdd = res.autoAdd !== false;
      trustable = res.trustable || [];
      render();
    } catch (err) {
      viewer.innerHTML = `<div class="pa-loading">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Re-read the project list and swap just this row (#135). A full load() would
  // replace the table with a "Loading…" placeholder and scroll the manager back to
  // the top — heavy-handed for the availability re-check, which only ever changes
  // one row. Falls back to load() when the row is gone or the table isn't built.
  async function refreshRow(path, tr) {
    if (!tr || !tr.parentNode) { await load(); return; }
    let res;
    try {
      res = await window.api.getProjectsAdmin();
    } catch (err) {
      toast('Re-check: ' + err.message);
      return;
    }
    if (!res || res.error) { toast('Re-check: ' + ((res && res.error) || 'unknown')); return; }

    data = res.projects || [];
    autoAdd = res.autoAdd !== false;

    const fresh = findRow(path);
    if (!fresh) { await load(); return; } // project vanished — the table is stale
    tr.outerHTML = rowHtml(fresh);
  }

  function toast(msg) {
    if (typeof showControlToast === 'function') showControlToast({ message: msg });
  }

  // Remove dialog with two opt-in hard-delete checkboxes (reuses control-dialog CSS).
  // Resolves to { deleteDisk, deleteConfig } on confirm, or null on cancel.
  // The Remove dialog asks WHICH backends' history to delete (#171).
  //
  // It used to offer one checkbox — "delete session history on disk" — and clear `~/.claude/projects`.
  // A project's Codex rollouts and Pi transcripts survived it untouched; the user simply stopped seeing
  // them, because the project was hidden in the same breath, and they came back the day it was unhidden.
  //
  // A backend that CANNOT be cleared (Hermes keeps its sessions in a database we may only read) is shown
  // and disabled, with the reason — rather than offered a switch that does nothing.
  async function confirmRemove(path) {
    let backends = [];
    try { backends = await window.api.projectDeletableBackends(path) || []; } catch { backends = []; }

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'control-dialog-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'control-dialog control-dialog-danger';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      const backendRows = backends.length
        ? backends.map(b => (b.deletable
          ? `<label class="pa-check-row"><input type="checkbox" class="pa-del-backend" data-backend="${escapeHtml(b.id)}">
               Delete ${escapeHtml(b.label)}'s session history <span class="pa-check-note">${b.sessions} session${b.sessions === 1 ? '' : 's'}</span></label>`
          : `<label class="pa-check-row pa-check-disabled"><input type="checkbox" disabled>
               ${escapeHtml(b.label)}'s history cannot be deleted <span class="pa-check-note">${escapeHtml(b.reason || '')}</span></label>`
        )).join('')
        : '<div class="pa-check-note">This project has no cached sessions.</div>';

      dialog.innerHTML = `
        <div class="control-dialog-kicker">Destructive Action</div>
        <h3>Remove project</h3>
        <p>Always hides the project and clears its Switchboard cache. Deleting a backend's session
        history removes those transcripts from disk — that is irreversible.</p>
        <div class="control-dialog-details">
          <div class="control-dialog-detail-row">
            <span class="control-dialog-detail-label">Project</span>
            <span class="control-dialog-detail-value">${escapeHtml(shortName(path))}</span>
          </div>
        </div>
        ${backendRows}
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
        deleteBackends: [...dialog.querySelectorAll('.pa-del-backend:checked')].map(c => c.dataset.backend),
        deleteConfig: dialog.querySelector('#pa-del-config').checked,
      }));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey);
    });
  }

  function findRow(path) {
    return data.find(r => r.projectPath === path);
  }

  async function handleAction(action, path, tr, trustBackendId) {
    const row = findRow(path);
    try {
      if (action === 'recheck') {
        await refreshRow(path, tr);
        return;
      }
      if (action === 'trust') {
        if (!row) return;
        // WHICH backend's trust — the chip says so (#171). Claude and Codex each keep their own answer,
        // in their own config; granting one has never granted the other, and the single button used to
        // hide that.
        const bid = trustBackendId || 'claude';
        const label = labelOf(bid);
        const next = !(row.trust && row.trust[bid] === true);
        if (next) {
          // Granting trust bypasses that CLI's own security gate — warn first, and name the CLI.
          const ok = await showControlDialog({
            tone: 'danger',
            title: `Grant trust to this project — for ${label}?`,
            message: `Trusting a project lets ${label} run its tools, hooks and commands without asking. Only do this for code you know and control. It applies to ${label} alone.`,
            details: [{ label: 'Project', value: shortName(path) }, { label: 'Backend', value: label }],
            confirmLabel: 'Grant trust',
            cancelLabel: 'Cancel',
          });
          if (!ok) return;
        }
        const res = await window.api.setProjectTrust(path, bid, next);
        if (res && res.error) { toast('Trust: ' + res.error); return; }
      } else if (action === 'hidden') {
        // Hide means hide now (#167). It used to call removeProject, because the two were the same act.
        if (row && (row.hidden || row.autoHidden)) await window.api.unhideProject(path);
        else await window.api.hideProject(path);
      } else if (action === 'favorite') {
        await window.api.toggleProjectFavorite(path);
      } else if (action === 'settings') {
        // The same viewer the sidebar's project-settings button opens (#203) — one panel, one path, no
        // new IPC. settings-panel.js exposes it globally and loads before this view.
        if (typeof window.openSettingsViewer === 'function') window.openSettingsViewer('project', path);
        return; // opening a panel changes no row — skip the table reload below
      } else if (action === 'allowlist') {
        // On the list, or not. This is what "add a project" finally means — a project with no sessions
        // can be on it, and adding one used to do nothing at all unless discovery had already found it.
        if (row && row.registered) await window.api.removeProject(path);
        else await window.api.addProject(path);
      } else if (action === 'remove') {
        const choice = await confirmRemove(path);
        if (!choice) return;
        // The order matters: delete the transcripts BEFORE removing the project, because the delete
        // reads the project's cached rows to find them — and removing the project clears those rows.
        if (choice.deleteBackends && choice.deleteBackends.length) {
          const r = await window.api.deleteProjectSessions(path, choice.deleteBackends);
          if (r && r.error) { toast('Delete sessions: ' + r.error); }
          else if (r) {
            const what = Object.entries(r.deleted || {}).map(([id, n]) => `${labelOf(id)}: ${n}`).join(', ');
            // What did NOT go has to be said too. A backend that cannot hand over its history was dropped
            // in silence, and the toast then read as "all of it is gone" when some of it was still there.
            const kept = (r.refused || []).join(', ');
            if (what && kept) toast(`Deleted — ${what}. Kept: ${kept} (its history cannot be deleted).`);
            else if (what) toast('Deleted — ' + what);
            else if (kept) toast(`Nothing deleted — ${kept} cannot be deleted.`);
          }
        }
        await window.api.removeProject(path); // always: off the list + clear Switchboard's cache
        if (choice.deleteConfig) {
          const r = await window.api.removeProjectConfig(path);
          if (r && r.error) { toast('Delete config: ' + r.error); }
        }
      } else if (action === 'remap') {
        const newPath = await window.api.browseFolder();
        if (!newPath) return;
        const res = await window.api.remapProject(path, newPath);
        if (res && res.error) { toast('Remap: ' + res.error); return; }
        // A backend whose store Switchboard may only read keeps its sessions at the OLD path. The handler
        // has always reported that; nobody showed it, so the project simply looked half-moved afterwards.
        const stuck = (res && res.cannotMove) || [];
        if (stuck.length) {
          const n = Object.values((res && res.moved) || {}).reduce((a, b) => a + b, 0);
          toast(`Remapped ${n} session(s). ${stuck.join(', ')} could not be moved — those sessions stay at the old path.`);
        }
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
    if (action === 'clear-unlisted') { unlistedOnly = false; render(); return; }   // #183
    if (action === 'refresh' || action === 'add') { handleAction(action, null, null); return; }
    if (!path) return;
    // A trust chip carries the backend it speaks for (#171) — there is one per backend that has a
    // trust gate, so the click has to say WHICH.
    handleAction(action, path, tr, btn.dataset.backend || null);
  });

  // Public entry point, called from the tab handler in app.js.
  window.loadProjectsAdmin = load;
})();
