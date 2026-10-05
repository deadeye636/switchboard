// VCS chip renderer (#277). Loads after sidebar.js.
//
// The main-process poller (src/app/vcs.js) pushes `vcs-status-changed` with a normalized summary per
// working directory. This module keeps a renderer-side cache and reads it SYNCHRONOUSLY when a header is
// built (the tasksBtn/bookmarksBtn pattern in sidebar.js). THE CACHE IS THE SOURCE OF TRUTH, and that is
// the whole of #229's trap: a DOM patch written where the render cannot re-derive it is wiped by the next
// morphdom pass and never comes back.
//
// A push therefore updates the cache FIRST and only then touches the DOM — `patchSidebarChips` and
// `patchCardChips` write what the next render would produce anyway, so a rebuild is idempotent rather
// than corrective. A rebuild is asked for only when the chip has to appear or disappear, because that
// changes what the row contains rather than what it says (#515).
//
// It owns no sidebar state: it appends a glyph button + a branch/counts pill to a header, and reports the
// on-screen repo cwds back to main via `vcsWatch` so main polls exactly what's visible (#277 F1).
//
// Since #742 the badge lives in the project second line (#741): it shows only while that line is on, a
// main project carries it INSIDE the line and drops the header button (the badge is the click-through
// now), and a worktree keeps its button plus the pill row under its header. `headerLayout` is the one
// answer to "what does this header carry", asked by the render and by the patch alike.
(function () {
  'use strict';

  const cache = new Map();       // cwd -> summary | (absent = unknown/not-a-repo)
  let collecting = null;         // Set<cwd> being gathered during the current render pass
  let subscribed = false;
  let refreshTimer = null;

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const chipEnabled = () => (typeof vcsChipEnabled === 'undefined' ? true : !!vcsChipEnabled);
  // The branch/counts BADGE is opt-in (default off): the glyph button alone opens the window; the
  // badge just adds the at-a-glance branch + file counts (#277). It REQUIRES the project second line
  // (#742) — the settings screen greys the switch out while the line is off, so a value stored from
  // before must not keep drawing the badge somewhere the screen says it has no effect.
  const secondLineOn = () => (typeof sidebarProjectSecondLine === 'undefined' ? false : !!sidebarProjectSecondLine);
  const showBadge = () => (typeof vcsShowBadge === 'undefined' ? false : !!vcsShowBadge) && secondLineOn();

  // What a decorated header carries. `mainProject` is a top-level project header; a worktree header is
  // not one. The render (`decorateHeader`, `secondLinePill`) and the patch (`patchSidebarChips`) both ask
  // this, so the patch can never expect a shape the render stopped drawing.
  function headerLayout(mainProject) {
    const badge = showBadge();
    const inSecondLine = badge && !!mainProject;
    return { button: !inSecondLine, pill: badge, pillInSecondLine: inSecondLine };
  }

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
        // A status change moves numbers inside a chip that is already on screen, and rebuilding the
        // whole sidebar for that cost 120-500 ms of main thread every time a repo reported (#515).
        // Patch it where it stands; only a chip that has to appear or disappear needs the rebuild,
        // and that is what the patch reports back.
        if (patchSidebarChips(payload.cwd, payload.summary)) return;
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

  // "Does this repo want the user's eye?" — counts, or a state like a rebase in progress. THREE places
  // ask (the card chip, the header glyph, and the patch that updates the glyph), and while the pill's
  // markup is shared through `pillInner`, this used to be the same expression written out three times.
  // The patch path is only safe as long as it paints what a rebuild would, so the derivation has to be
  // one function rather than three copies someone keeps in step by hand.
  function isDirty(s) {
    return dirtyCount(s) > 0 || !!(s.state && s.state !== 'detached');
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

  const shortLabelOf = (cwd) => cwd.split('/').filter(Boolean).slice(-1)[0] || cwd;

  // The sidebar's branch/counts pill. It carries the cwd itself: it sits OUTSIDE the header (in the pill
  // row or the second line), so a header-scoped delegate cannot catch its click — the top-level
  // `.vcs-open` branch in sidebar-events.js reads it.
  function buildPill(s, cwd) {
    const pill = document.createElement('span');
    pill.className = 'vcs-pill vcs-open';
    pill.title = 'Open changes';
    const { html, inProgress } = pillInner(s);
    if (inProgress) pill.classList.add('vcs-inprogress');
    pill.innerHTML = html;
    pill.dataset.vcsCwd = cwd;
    pill.dataset.vcsLabel = shortLabelOf(cwd);
    return pill;
  }

  function buildPillRow(s, cwd) {
    const row = document.createElement('div');
    row.className = 'vcs-pill-row';
    row.appendChild(buildPill(s, cwd));
    return row;
  }

  // The pill for a main project's second line (#742), or null when that header does not carry one there
  // (chip off, badge off, second line off, no status yet). The sidebar puts it into the line it builds.
  function secondLinePill(cwd) {
    if (!chipEnabled() || !cwd) return null;
    const s = status(cwd);
    if (!s || !headerLayout(true).pillInSecondLine) return null;
    return buildPill(s, cwd);
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
      if (isDirty(s)) chip.classList.add('has-changes');
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

  // Live-patch the sidebar's own chip for this cwd — the glyph button in the header, and the
  // branch/counts pill under it when the badge is on. The same move `patchCardChips` makes for a grid
  // card and `patchSidebarStatuses` (#80) makes for a busy/idle edge: a change that only moves numbers
  // inside a rendered row does not need the row rebuilt.
  //
  // The cache stays the source of truth — `decorateHeader` reads it synchronously on the next full
  // render — and both paths derive what they paint from the SAME two functions, `pillInner` and
  // `isDirty`. That is what makes this safe rather than the trap in this file's header: not that a patch
  // happens to agree with a rebuild today, but that there is no second copy of the derivation to fall
  // out of step with.
  //
  // Returns false when the change is STRUCTURAL — the chip has to appear or disappear — and the caller
  // must fall back to the full render.
  function patchSidebarChips(cwd, summary) {
    // The same gate `decorateHeader` opens with: with the chip switched off there is nothing this may
    // touch, and the render is the one that takes the chips away.
    if (!chipEnabled() || !cwd) return false;
    const sel = '[data-vcs-cwd="' + (window.CSS && CSS.escape ? CSS.escape(cwd) : cwd) + '"]';
    const headers = document.querySelectorAll('[data-vcs-header="' + (window.CSS && CSS.escape ? CSS.escape(cwd) : cwd) + '"]');
    // No chip on screen for this cwd yet (a repo reporting for the first time), or one that now has to
    // go: both change what the row contains, not just what it says.
    if (!summary || headers.length === 0) return false;
    // Exactly the buttons and pills the render would draw for these headers (`headerLayout`). Anything
    // else means a setting changed under us, or a header rendered without its chip — rebuild rather
    // than guess.
    let wantButtons = 0;
    let wantPills = 0;
    for (const header of headers) {
      const layout = headerLayout(header.classList.contains('project-header'));
      if (layout.button) wantButtons++;
      if (layout.pill) wantPills++;
    }
    const btns = document.querySelectorAll('.project-vcs-btn' + sel);
    const pills = document.querySelectorAll('.vcs-pill-row .vcs-pill' + sel + ', .project-second-line .vcs-pill' + sel);
    if (btns.length !== wantButtons || pills.length !== wantPills) return false;

    for (const btn of btns) btn.classList.toggle('has-changes', isDirty(summary));
    for (const pill of pills) {
      const { html, inProgress } = pillInner(summary);
      pill.classList.toggle('vcs-inprogress', inProgress);
      pill.innerHTML = html;
    }
    return true;
  }

  // header      = the .project-header / .worktree-header element (gets the glyph button)
  // group       = the group container; the pill row is inserted before sessionsList
  // mainProject = a top-level project header: its pill goes into the second line (`secondLinePill`, built
  //               by the sidebar before this runs), and it then carries no glyph button (#742)
  function decorateHeader(header, group, sessionsList, cwd, { mainProject = false } = {}) {
    if (!chipEnabled() || !cwd || !header) return;
    if (collecting) collecting.add(cwd);

    const s = status(cwd);
    // Repo-ness is only known once a summary has arrived (main only pushes for detected repos). Until
    // then — and forever for a non-repo — show nothing.
    if (!s) return;

    // The patch finds every decorated header by this, so it can compare what is on screen with what
    // `headerLayout` says the render draws.
    header.dataset.vcsHeader = cwd;
    const layout = headerLayout(mainProject);

    if (layout.button) {
      const btn = document.createElement('button');
      btn.className = 'project-vcs-btn vcs-open';
      btn.title = 'Open changes';
      btn.innerHTML = GLYPH;
      btn.dataset.vcsCwd = cwd;
      btn.dataset.vcsLabel = shortLabelOf(cwd);
      if (isDirty(s)) btn.classList.add('has-changes');
      // Sit just left of the New (+) button to match the mockup; else append.
      const newBtn = header.querySelector('.project-new-btn');
      if (newBtn) header.insertBefore(btn, newBtn); else header.appendChild(btn);
    }

    // A worktree's badge keeps its own row, a SIBLING of the header between it and the session list.
    if (layout.pill && !layout.pillInSecondLine) {
      const row = buildPillRow(s, cwd);
      if (group && sessionsList && sessionsList.parentNode === group) group.insertBefore(row, sessionsList);
      else if (group) group.appendChild(row);
    }
  }

  window.vcsView = { status, decorateHeader, secondLinePill, buildCardChip, patchSidebarChips, beginCollect, endCollect, _cache: cache };
})();
