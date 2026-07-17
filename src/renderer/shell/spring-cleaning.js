// --- Spring cleaning: the archive-old-sessions dialog (#218) ---
//
// A modal that offers to archive what has gone stale — sessions past an age threshold, and the
// abandoned short ones that never went anywhere — with its own age presets, its own selection summary
// and its own nested render loop.
//
// Came out of sidebar.js, where it was 229 lines of modal sitting above the render path that never
// calls it. Its only entry point is app.js, from a toolbar click; the sidebar itself has no idea it
// exists. That is what made it a clean cut: it shares nothing with its old neighbours but the session
// data every part of the app reads.
//
// The rules that decide WHAT is stale are not here — they are in session/session-cleanup.js
// (getSpringCleaningCandidates, getAbandonedShortSessions, summarizeSpringCleaningSelection), which is
// require()-able and tested. This file is the dialog around them, and it is not.
//
// A classic <script>, like the file it came from: nothing runs at parse time, so its tag position is
// free — it only has to exist before the first click, and app.js's listener is what fires it.

function showSpringCleaningDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'spring-cleaning-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'spring-cleaning-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'spring-cleaning-title');

  let ageDays = DEFAULT_CLEANUP_AGE_DAYS;
  let candidates = [];
  let abandonedCandidates = [];
  let selectedIds = new Set();

  dialog.innerHTML = `
    <div class="spring-cleaning-header">
      <div>
        <div class="spring-cleaning-kicker">Spring Cleaning</div>
        <h3 id="spring-cleaning-title">Hide Old Sessions</h3>
        <p>Archive clutter from the sidebar: old stopped sessions, plus barely-used sessions that were abandoned early. Session files are not deleted, and you can undo immediately after cleanup.</p>
      </div>
      <button type="button" class="spring-cleaning-close-btn" aria-label="Close spring cleaning">&times;</button>
    </div>
    <div class="spring-cleaning-controls">
      <span>Older than</span>
      <div class="spring-cleaning-age-options" role="group" aria-label="Session age threshold"></div>
    </div>
    <div class="spring-cleaning-summary"></div>
    <div class="spring-cleaning-list"></div>
    <div class="spring-cleaning-actions">
      <button type="button" class="spring-cleaning-cancel-btn">Cancel</button>
      <button type="button" class="spring-cleaning-archive-btn">Archive Selected</button>
    </div>
  `;

  const ageOptionsEl = dialog.querySelector('.spring-cleaning-age-options');
  const summaryEl = dialog.querySelector('.spring-cleaning-summary');
  const listEl = dialog.querySelector('.spring-cleaning-list');
  const archiveBtn = dialog.querySelector('.spring-cleaning-archive-btn');

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function refreshCandidates() {
    // Abandoned-short is the more specific classification, so compute it first and
    // give it priority. A trivially-small stale session would otherwise also match
    // the generic age filter (its inactivity window overlaps), so we pull those out
    // of the age-based list rather than the other way around — otherwise the
    // abandoned category would be deduped to empty at the default age threshold.
    abandonedCandidates = getAbandonedShortSessions(getAllRenderableSessions(cachedAllProjects), {
      activePtyIds,
      lastActivityTime,
    });
    const abandonedIds = new Set(abandonedCandidates.map(item => item.session.sessionId));
    candidates = getSpringCleaningCandidates(cachedAllProjects, {
      ageDays,
      activePtyIds,
      lastActivityTime,
    }).filter(item => !abandonedIds.has(item.session.sessionId));
    selectedIds = new Set([
      ...candidates.map(item => item.session.sessionId),
      ...abandonedCandidates.map(item => item.session.sessionId),
    ]);
    renderBody();
  }

  function renderAgeOptions() {
    ageOptionsEl.innerHTML = '';
    for (const days of CLEANUP_AGE_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'spring-cleaning-age-btn' + (days === ageDays ? ' active' : '');
      button.textContent = `${days} days`;
      button.addEventListener('click', () => {
        ageDays = days;
        renderAgeOptions();
        refreshCandidates();
      });
      ageOptionsEl.appendChild(button);
    }
  }

  function renderCategoryRow(item, metaText) {
    const session = item.session;
    const row = document.createElement('label');
    row.className = 'spring-cleaning-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(session.sessionId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(session.sessionId);
      else selectedIds.delete(session.sessionId);
      renderBody();
    });
    row.appendChild(checkbox);

    const info = document.createElement('span');
    info.className = 'spring-cleaning-row-info';
    const title = document.createElement('span');
    title.className = 'spring-cleaning-row-title';
    title.textContent = shortSessionLabel(session);
    const meta = document.createElement('span');
    meta.className = 'spring-cleaning-row-meta';
    meta.textContent = metaText(item);
    info.appendChild(title);
    info.appendChild(meta);
    row.appendChild(info);

    return row;
  }

  function renderCategory(category) {
    if (category.items.length === 0) return;

    const section = document.createElement('section');
    section.className = 'spring-cleaning-category';

    const heading = document.createElement('div');
    heading.className = 'spring-cleaning-category-title';
    heading.innerHTML = `<span>${escapeHtml(category.label)} · ${category.items.length}</span>`;
    if (category.description) {
      heading.title = category.description;
      const desc = document.createElement('span');
      desc.className = 'spring-cleaning-category-desc';
      desc.textContent = category.description;
      heading.appendChild(desc);
    }
    section.appendChild(heading);

    const byProject = new Map();
    for (const item of category.items) {
      const key = item.projectPath || 'Other';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(item);
    }

    for (const [, items] of byProject) {
      const group = document.createElement('div');
      group.className = 'spring-cleaning-group';

      const header = document.createElement('div');
      header.className = 'spring-cleaning-group-title';
      header.textContent = `${items[0].projectLabel} · ${items.length}`;
      group.appendChild(header);

      for (const item of items) {
        group.appendChild(renderCategoryRow(item, category.metaText));
      }

      section.appendChild(group);
    }

    listEl.appendChild(section);
  }

  function renderBody() {
    const allCandidates = [...candidates, ...abandonedCandidates];
    const summary = summarizeSpringCleaningSelection(allCandidates, selectedIds);
    summaryEl.textContent = allCandidates.length
      ? `${summary.selectedCount} of ${allCandidates.length} sessions selected across ${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'}.`
      : `No stopped, unpinned sessions older than ${ageDays} days, and nothing abandoned early.`;
    archiveBtn.disabled = summary.selectedCount === 0;
    archiveBtn.textContent = summary.selectedCount === 0
      ? 'Archive Selected'
      : `Archive ${summary.selectedCount} Selected`;

    listEl.innerHTML = '';
    if (allCandidates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'spring-cleaning-empty';
      empty.textContent = 'Nothing to clean up right now.';
      listEl.appendChild(empty);
      return;
    }

    renderCategory({
      label: `Older than ${ageDays} days`,
      items: candidates,
      metaText: item => `${item.ageDays} days old · ${item.session.messageCount || 0} msgs`,
    });

    renderCategory({
      label: 'Abandoned short sessions',
      description: 'Barely-used sessions: few messages, few turns, and inactive for a couple of days.',
      items: abandonedCandidates,
      metaText: item => `${item.ageDays} days old · ${item.session.messageCount || 0} msgs · ${item.session.userMessageCount || 0} turns`,
    });
  }

  archiveBtn.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    for (const id of ids) {
      await window.api.archiveSession(id, 1);
      const session = sessionMap.get(id);
      if (session) session.archived = 1;
    }
    close();
    loadProjects();
    showControlToast({
      message: `Archived ${ids.length} old session${ids.length === 1 ? '' : 's'}.`,
      actionLabel: 'Undo',
      onAction: async () => {
        for (const id of ids) {
          await window.api.archiveSession(id, 0);
          const session = sessionMap.get(id);
          if (session) session.archived = 0;
        }
        loadProjects();
      },
    });
  });

  dialog.querySelector('.spring-cleaning-close-btn').addEventListener('click', close);
  dialog.querySelector('.spring-cleaning-cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  function onKey(event) { if (event.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  renderAgeOptions();
  refreshCandidates();
  dialog.querySelector('.spring-cleaning-close-btn').focus();
}
