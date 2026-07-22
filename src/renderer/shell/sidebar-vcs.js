// VCS chip renderer (#277). Loads after sidebar.js.
//
// The main-process poller (src/app/vcs.js) pushes `vcs-status-changed` with a normalized summary per
// working directory. This module keeps a renderer-side cache and reads it SYNCHRONOUSLY when a header is
// built (the tasksBtn/bookmarksBtn pattern in sidebar.js) — never a direct async DOM patch, which the
// next morphdom render would wipe (#229's trap). A push just updates the cache and requests a debounced
// re-render, so the header re-reads the fresh value.
//
// It owns no sidebar state: it appends a glyph button + a branch/counts pill to a header, and reports the
// on-screen repo cwds back to main via `vcsWatch` so main polls exactly what's visible (#277 F1).
(function () {
  'use strict';

  const cache = new Map();       // cwd -> summary | (absent = unknown/not-a-repo)
  let collecting = null;         // Set<cwd> being gathered during the current render pass
  let subscribed = false;
  let refreshTimer = null;

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const chipEnabled = () => (typeof vcsChipEnabled === 'undefined' ? true : !!vcsChipEnabled);
  // The branch/counts BADGE is opt-in (default off): the glyph button alone opens the window; the
  // badge just adds the at-a-glance branch + file counts (#277).
  const showBadge = () => (typeof vcsShowBadge === 'undefined' ? false : !!vcsShowBadge);

  const GLYPH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M18 10.5c0 4-6 3-6 7"/><path d="M6 8.5v7"/></svg>';
  const GLYPH_SM = '<svg class="vcs-pill-glyph" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M18 10.5c0 4-6 3-6 7"/><path d="M6 8.5v7"/></svg>';

  function ensureSubscribed() {
    if (subscribed) return;
    subscribed = true;
    if (window.api && typeof window.api.onVcsStatusChanged === 'function') {
      window.api.onVcsStatusChanged((payload) => {
        if (!payload || typeof payload.cwd !== 'string') return;
        if (payload.summary) cache.set(payload.cwd, payload.summary);
        else cache.delete(payload.cwd);
        patchCardChips(payload.cwd, payload.summary);   // live-update mounted grid cards
        // Coalesce a burst (many repos reporting at once) into one re-render.
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          if (typeof refreshSidebar === 'function') refreshSidebar();
        }, 150);
      });
    }
  }

  function status(cwd) { return cache.get(cwd) || null; }

  function dirtyCount(s) {
    return (s.staged || 0) + (s.unstaged || 0) + (s.conflicted || 0)
      + (typeof s.untracked === 'number' ? s.untracked : 0);
  }

  // Per-render collection: sidebar.js calls beginCollect() before building headers and endCollect()
  // after, so main is told the exact set of repo cwds currently on screen.
  function beginCollect() { ensureSubscribed(); collecting = new Set(); }
  function endCollect() {
    const cwds = collecting ? [...collecting] : [];
    collecting = null;
    if (window.api && typeof window.api.vcsWatch === 'function') {
      window.api.vcsWatch(chipEnabled() ? cwds : []);
    }
  }

  // The inner markup shared by the sidebar pill and the grid-card chip.
  function pillInner(s) {
    const st = s.state;
    const inProgress = st && st !== 'detached';
    let html = GLYPH_SM;
    if (inProgress) html += `<span class="vcs-state">${esc(st)}</span>`;
    else html += `<span class="vcs-br">${esc(s.branch || (st === 'detached' ? 'detached' : ''))}</span>`;
    const seg = [];
    if (s.conflicted > 0) seg.push(`<span class="vcs-conflict">✕${s.conflicted}</span>`);
    if (s.staged > 0) seg.push(`<span class="vcs-staged">+${s.staged}</span>`);
    if (s.unstaged > 0) seg.push(`<span class="vcs-unstaged">●${s.unstaged}</span>`);
    if (typeof s.untracked === 'number' && s.untracked > 0) seg.push(`<span class="vcs-untracked">?${s.untracked}</span>`);
    if (seg.length) html += seg.join('');
    else if (!inProgress) html += '<span class="vcs-clean">✓</span>';
    return { html, inProgress };
  }

  function buildPillRow(s) {
    const row = document.createElement('div');
    row.className = 'vcs-pill-row';
    const pill = document.createElement('span');
    pill.className = 'vcs-pill vcs-open';
    pill.title = 'Open changes';
    const { html, inProgress } = pillInner(s);
    if (inProgress) pill.classList.add('vcs-inprogress');
    pill.innerHTML = html;
    row.appendChild(pill);
    return row;
  }

  // Fill a card chip with either the full branch/counts badge or, when the badge is off, just the git
  // glyph (still a click target for the changes window).
  function renderChipContent(chip, s) {
    chip.classList.remove('vcs-inprogress', 'vcs-glyph-only', 'has-changes');
    if (showBadge()) {
      const { html, inProgress } = pillInner(s);
      if (inProgress) chip.classList.add('vcs-inprogress');
      chip.innerHTML = html;
    } else {
      chip.classList.add('vcs-glyph-only');
      chip.innerHTML = GLYPH_SM;
      if (dirtyCount(s) > 0 || (s.state && s.state !== 'detached')) chip.classList.add('has-changes');
    }
  }

  // A compact chip for a grid session card header. Reuses the pill markup; carries its own click
  // listener (the grid patches cards in place rather than via the sidebar's delegate). Returns null
  // when the cwd has no status yet (non-repo / first poll pending).
  function buildCardChip(cwd, label) {
    if (!chipEnabled() || !cwd) return null;
    const s = status(cwd);
    if (!s) return null;
    const chip = document.createElement('span');
    chip.className = 'vcs-pill vcs-open vcs-card-chip';
    chip.title = 'Open changes';
    chip.dataset.vcsCwd = cwd;
    chip.dataset.vcsLabel = label || (cwd.split('/').filter(Boolean).slice(-1)[0] || cwd);
    renderChipContent(chip, s);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.api && window.api.openChangesWindow) window.api.openChangesWindow(cwd, chip.dataset.vcsLabel);
    });
    return chip;
  }

  // Live-patch any already-mounted grid-card chips for this cwd (the grid keeps cards in place, so it
  // won't rebuild them on a status push the way the sidebar does).
  function patchCardChips(cwd, summary) {
    const chips = document.querySelectorAll('.vcs-card-chip[data-vcs-cwd="' + (window.CSS && CSS.escape ? CSS.escape(cwd) : cwd) + '"]');
    for (const chip of chips) {
      if (!summary) { chip.remove(); continue; }
      renderChipContent(chip, summary);
    }
  }

  // header  = the .project-header / .worktree-header element (gets the glyph button)
  // group   = the group container; the pill row is inserted before sessionsList
  function decorateHeader(header, group, sessionsList, cwd) {
    if (!chipEnabled() || !cwd || !header) return;
    if (collecting) collecting.add(cwd);

    const s = status(cwd);
    // Repo-ness is only known once a summary has arrived (main only pushes for detected repos). Until
    // then — and forever for a non-repo — show nothing.
    if (!s) return;

    const shortLabel = cwd.split('/').filter(Boolean).slice(-1)[0] || cwd;
    const btn = document.createElement('button');
    btn.className = 'project-vcs-btn vcs-open';
    btn.title = 'Open changes';
    btn.innerHTML = GLYPH;
    btn.dataset.vcsCwd = cwd;
    btn.dataset.vcsLabel = shortLabel;
    if (dirtyCount(s) > 0 || (s.state && s.state !== 'detached')) btn.classList.add('has-changes');
    // Sit just left of the New (+) button to match the mockup; else append.
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) header.insertBefore(btn, newBtn); else header.appendChild(btn);

    // The branch/counts badge is opt-in. The pill row is a SIBLING of the header (between it and the
    // session list), so its click can't be caught by a header-scoped delegate — it carries the cwd
    // itself, read by the top-level `.vcs-open` branch in sidebar-events.js.
    if (showBadge()) {
      const pill = buildPillRow(s);
      const pillEl = pill.querySelector('.vcs-pill');
      if (pillEl) { pillEl.dataset.vcsCwd = cwd; pillEl.dataset.vcsLabel = shortLabel; }
      if (group && sessionsList && sessionsList.parentNode === group) group.insertBefore(pill, sessionsList);
      else if (group) group.appendChild(pill);
    }
  }

  window.vcsView = { status, decorateHeader, buildCardChip, beginCollect, endCollect, _cache: cache };
})();
