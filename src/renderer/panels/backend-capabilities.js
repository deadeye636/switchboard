// panels/backend-capabilities.js — the capability matrix overlay (#439).
//
// Reads: nothing. Everything it draws arrives in the `backends-list` payload — the rows and their
// labels as `capabilityCatalog`, the answers as each backend's `capabilities`. This file holds no
// capability labels, no backend ids and no answers of its own, so a new backend or a new row is
// complete without editing the renderer.
//
// Opened from backends-panel.js (the button on the Built-in section). Kept apart from that file
// because it is the second-largest panel in the app already, and because the pure half below is
// testable in `node --test` only while it stays free of the panel's DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // How each state reads in the table. `unknown` is not one of the three answers a backend may give —
  // it is what arrives when a backend said nothing about a row, and it is drawn as a visible gap rather
  // than folded into "no", because a forgotten row and a deliberate no are different facts.
  const CAPABILITY_STATE_DISPLAY = {
    yes: { glyph: '✓', label: 'Supported', cls: 'cap-yes' },
    limited: { glyph: '~', label: 'Limited', cls: 'cap-limited' },
    no: { glyph: '·', label: 'Not supported', cls: 'cap-no' },
    unknown: { glyph: '?', label: 'Not declared', cls: 'cap-unknown' },
  };

  function capabilityStateDisplay(state) {
    return CAPABILITY_STATE_DISPLAY[state] || CAPABILITY_STATE_DISPLAY.unknown;
  }

  // The columns: the backends that exist as their own binary. Templates are left out on purpose — a
  // template runs its base's binary and inherits its answers, so a column would be a copy of the base's
  // under a different name. A backend the user has switched OFF keeps its column, marked: the matrix
  // says what a backend can do, not whether it is currently in use.
  function capabilityColumns(backends) {
    return (Array.isArray(backends) ? backends : [])
      .filter(b => b && !b.isProfile && b.status === 'ready')
      .map(b => ({
        id: b.id,
        label: b.label || b.id,
        disabled: b.enabled === false,
        unavailable: b.available === false,
        answers: (b && b.capabilities) || {},
      }));
  }

  // Catalog rows, bucketed into the groups the catalog declares, in the catalog's own order. A row
  // whose group is unknown still appears — dropping it would hide a capability because of a typo.
  function capabilityRowGroups(catalog) {
    const groups = (catalog && Array.isArray(catalog.groups)) ? catalog.groups : [];
    const rows = (catalog && Array.isArray(catalog.rows)) ? catalog.rows : [];
    const known = new Map(groups.map(g => [g.id, { id: g.id, label: g.label || g.id, rows: [] }]));
    const out = [...known.values()];
    for (const row of rows) {
      let bucket = known.get(row && row.group);
      if (!bucket) {
        bucket = { id: (row && row.group) || 'other', label: 'Other', rows: [] };
        known.set(bucket.id, bucket);
        out.push(bucket);
      }
      bucket.rows.push(row);
    }
    return out.filter(g => g.rows.length);
  }

  function answerFor(column, rowId) {
    const raw = column && column.answers ? column.answers[rowId] : null;
    const state = raw && raw.state ? raw.state : 'unknown';
    return { state, note: (raw && raw.note) || null };
  }

  function capabilityCellHtml(column, row) {
    const answer = answerFor(column, row.id);
    const display = capabilityStateDisplay(answer.state);
    const title = answer.note
      ? `${display.label} — ${answer.note}`
      : display.label;
    return `
      <td class="cap-cell ${display.cls}" title="${escapeHtml(title)}">
        <span class="cap-glyph" aria-hidden="true">${display.glyph}</span>
        <span class="cap-sr">${escapeHtml(display.label)}</span>
        ${answer.note ? `<span class="cap-note">${escapeHtml(answer.note)}</span>` : ''}
      </td>`;
  }

  function capabilityMatrixHtml(catalog, columns) {
    if (!columns.length) return '<div class="settings-hint">No backend is installed.</div>';
    const head = columns.map(c => `
      <th scope="col" class="cap-col${c.disabled ? ' cap-col-off' : ''}">
        ${escapeHtml(c.label)}
        ${c.disabled ? '<span class="backend-pill soon">off</span>' : ''}
        ${c.unavailable ? '<span class="backend-pill soon">not installed</span>' : ''}
      </th>`).join('');

    const body = capabilityRowGroups(catalog).map(group => {
      const groupRow = `
        <tr class="cap-group-row">
          <th scope="colgroup" colspan="${columns.length + 1}">${escapeHtml(group.label)}</th>
        </tr>`;
      const rows = group.rows.map(row => `
        <tr>
          <th scope="row" class="cap-row-head">
            <span class="cap-row-label">${escapeHtml(row.label || row.id)}</span>
            ${row.description ? `<span class="cap-row-desc">${escapeHtml(row.description)}</span>` : ''}
          </th>
          ${columns.map(c => capabilityCellHtml(c, row)).join('')}
        </tr>`).join('');
      return groupRow + rows;
    }).join('');

    return `
      <div class="cap-table-scroll">
        <table class="cap-table">
          <thead><tr><th scope="col" class="cap-row-head"></th>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  // The overlay. Built here rather than through showControlDialog: that helper escapes its own content
  // and has no slot for a table, so passing markup to it would either be escaped or force a content
  // hole into a confirmation dialog every other caller relies on.
  function openBackendCapabilityMatrix({ backends, catalog } = {}) {
    const columns = capabilityColumns(backends);

    const titleId = controlDialogId('capability-matrix-title');
    const descId = controlDialogId('capability-matrix-desc');
    const overlay = document.createElement('div');
    overlay.className = 'control-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'control-dialog capability-matrix-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    // The sentence under the heading says what the table is for, so it is part of what this dialog
    // announces rather than something only a sighted reader gets (#505).
    dialog.setAttribute('aria-describedby', descId);
    dialog.innerHTML = `
      <div class="control-dialog-kicker">Backends</div>
      <h3 id="${titleId}">What each backend supports</h3>
      <p id="${descId}">Every backend covers a different part of what Switchboard can do. Hover a cell for the detail
        behind a limited or missing answer. Templates are not listed: a template runs its backend's
        binary, so it can do exactly what that backend can.</p>
      <div class="cap-legend">
        <span class="cap-legend-item cap-yes"><span class="cap-glyph">✓</span> Supported</span>
        <span class="cap-legend-item cap-limited"><span class="cap-glyph">~</span> Limited</span>
        <span class="cap-legend-item cap-no"><span class="cap-glyph">·</span> Not supported</span>
      </div>
      ${capabilityMatrixHtml(catalog, columns)}
      <div class="control-dialog-actions">
        <button type="button" class="control-dialog-confirm capability-matrix-close">Close</button>
      </div>`;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // The shared Tab cycle and focus hand-back (#505). Every `.control-dialog-overlay` has to trap, or the
    // "topmost overlay wins" rule the others rely on is false whenever this one is open.
    const releaseFocus = trapControlDialogFocus(overlay, dialog);

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      releaseFocus();
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    // Nothing here holds work the user could lose, so a backdrop click and Escape both close it.
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    dialog.querySelector('.capability-matrix-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    dialog.querySelector('.capability-matrix-close').focus();
    return close;
  }

  return {
    capabilityStateDisplay,
    capabilityColumns,
    capabilityRowGroups,
    capabilityMatrixHtml,
    openBackendCapabilityMatrix,
  };
});
