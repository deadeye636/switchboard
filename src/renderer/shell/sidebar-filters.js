// --- The sidebar's tag-filter and toggle controller (#218, #228) ---
//
// The interaction half of the sidebar filter toolbar: the tag-chip bar (project + session tags, #98/#164),
// the archive/star/running/today filter toggles, and the favorite-projects toggle. It builds the chips,
// handles the clicks, and flips the filter flags. Came out of app.js. This is one of three controllers
// #228 called the "filter toolbar"; the collapse and sort controllers are their own files.
//
// A PLAIN CLASSIC SCRIPT that LOADS AFTER app.js — like search-bar.js, and forced for the same reason: its
// parse-time tail binds click listeners to app.js's toggle consts (archiveToggle etc., app.js:9-22), which
// would be in their TDZ before app.js. app.js reaches back at two points, both guarded because this loads
// later (line numbers drift, so by role): _refreshProjectTagFilter via `window._refreshProjectTagFilter?.()`
// from the loadProjects boot callback and from the top of reapplyGlobalSettings; applyProjectTagFilterVisibility
// via a `typeof` guard from the tab switcher. window._refreshProjectTagFilter is assigned here and also
// called from settings-panel.js/settings-tags.js when tags change — call-time, so load-after is fine.
//
// THE FILTER STATE STAYS IN app.js because the sidebar RENDER reads it (app.js:808-815, filterProjectsByTags
// / filterProjectSessionsByTags). This controller WRITES it through the shared scope, the way sidebar.js
// writes sortedOrder — never wrapped in a factory (that would shadow the binding, #218):
//   projectTagMap, sessionTagMap                     reassigned in _refreshProjectTagFilter (foreign let write)
//   activeProjectTagFilter, activeSessionTagFilter   Sets, mutated in place
//   showArchived, showStarredOnly, showRunningOnly,
//   showTodayOnly, showFavoritedProjectsOnly         flags, flipped in the toggle handlers (foreign let
//                                                    writes; sidebar.js reads them too)
//
// Globals it also uses at call time: projectTagFilters (DOM), refreshSidebar, buildProjectTagMap /
// buildSessionTagMap and escapeHtml (lib/utils.js + the tag-map builders), ICONS for the toggle glyphs.

// --- The tag filter chip bar (#98 project tags, #164 session tags) ---
//
// ONE bar, two kinds: project chips, a separator, session chips. They are not the same thing — a project
// chip drops whole PROJECTS, a session chip drops session ROWS and a project disappears only as a
// consequence — and their names live in separate namespaces, so the same word can be both. A separator
// alone would leave two identical-looking chips doing different things, with position carrying the whole
// distinction; each chip therefore says what it is (a folder glyph, or a #).
//
// Selected together they AND across the kinds: "sessions tagged bug IN projects tagged kunde". That cross
// filter is exactly why both live in one bar instead of behind a Projects/Sessions switch.
const TAG_KIND_GLYPH = {
  // A folder for the project kind, a # for the session kind. Deliberately small — the tag's colour is
  // still what you read first.
  project: '<svg class="tag-chip-glyph" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a1 1 0 0 1 .8.4l1.2 1.6H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  session: '<span class="tag-chip-glyph tag-chip-hash">#</span>',
};

// Tag state (#138): a *disabled* tag renders no chip anywhere, so it leaves the matching map too. A
// *hidden* tag keeps its chips on the cards but drops out of the filter bar — it is still attached, just
// not something you filter by any more.
function _tagBarSlice(rows, activeSet) {
  const assigned = (rows || []).filter(r => r && r.tag && !r.disabled);
  const tags = [...new Set(assigned.filter(r => !r.hidden).map(r => r.tag))].sort();
  // Drop selections whose tag is gone, hidden or disabled — otherwise a filter stays active with no chip
  // left to switch it off.
  for (const t of [...activeSet]) {
    if (!tags.includes(t)) activeSet.delete(t);
  }
  // Colour comes from the tag def (#138), so every row for a tag carries the same value.
  const colorByTag = new Map();
  for (const r of assigned) {
    if (r.color && !colorByTag.has(r.tag)) colorByTag.set(r.tag, r.color);
  }
  return { assigned, tags, colorByTag };
}

function _tagChipsHtml(kind, tags, colorByTag, activeSet) {
  const pickColor = (window.bookmarksTags && typeof window.bookmarksTags.pickColor === 'function')
    ? window.bookmarksTags.pickColor
    : () => '#61afef';
  return tags.map(tag => {
    const color = colorByTag.get(tag) || pickColor(tag);
    const active = activeSet.has(tag);
    const style = active
      ? `background:${color};border-color:${color};color:#1a1a1a`
      : `background:${color}1a;border-color:${color};color:${color}`;
    return `<button type="button" class="project-tag-chip${active ? ' active' : ''}" data-kind="${kind}"`
      + ` data-tag="${escapeHtml(tag)}" style="${style}" aria-pressed="${active}"`
      + ` title="${kind === 'project' ? 'Project tag — filters projects' : 'Session tag — filters sessions'}">`
      + `${TAG_KIND_GLYPH[kind]}<span>${escapeHtml(tag)}</span></button>`;
  }).join('');
}

async function _refreshProjectTagFilter() {
  let projectRows = [];
  let sessionRows = [];
  try { projectRows = await window.api.projectTagsAll(); } catch { projectRows = []; }
  try { sessionRows = await window.api.sessionTagsAll(); } catch { sessionRows = []; }

  const proj = _tagBarSlice(projectRows, activeProjectTagFilter);
  const sess = _tagBarSlice(sessionRows, activeSessionTagFilter);

  projectTagMap = (typeof buildProjectTagMap === 'function') ? buildProjectTagMap(proj.assigned) : new Map();
  sessionTagMap = (typeof buildSessionTagMap === 'function') ? buildSessionTagMap(sess.assigned) : new Map();

  if (!projectTagFilters) return;
  if (proj.tags.length === 0 && sess.tags.length === 0) {
    projectTagFilters.innerHTML = '';
    applyProjectTagFilterVisibility();
    return;
  }

  // The separator only exists when it separates something.
  const sep = (proj.tags.length > 0 && sess.tags.length > 0) ? '<span class="tag-filter-sep" aria-hidden="true"></span>' : '';
  projectTagFilters.innerHTML =
    _tagChipsHtml('project', proj.tags, proj.colorByTag, activeProjectTagFilter)
    + sep
    + _tagChipsHtml('session', sess.tags, sess.colorByTag, activeSessionTagFilter);
  applyProjectTagFilterVisibility();
}
window._refreshProjectTagFilter = _refreshProjectTagFilter;

// The chips filter the project list, so they belong to the Sessions tab only —
// they were left standing over Plans / Memory / Work files, where nothing they
// filter is even on screen (#133). Sole owner of the bar's display state: the
// renderer above and the tab switcher both defer to it.
function applyProjectTagFilterVisibility() {
  if (!projectTagFilters) return;
  const hasChips = projectTagFilters.children.length > 0;
  projectTagFilters.style.display = (hasChips && activeTab === 'sessions') ? 'flex' : 'none';
}

if (projectTagFilters) {
  projectTagFilters.addEventListener('click', (e) => {
    const chip = e.target.closest('.project-tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    // The chip says which kind it is; the two selections are separate sets and AND together (#164).
    const active = chip.dataset.kind === 'session' ? activeSessionTagFilter : activeProjectTagFilter;
    if (active.has(tag)) active.delete(tag);
    else active.add(tag);
    _refreshProjectTagFilter();
    refreshSidebar({ resort: true });
  });
}

// --- Archive toggle ---
archiveToggle.innerHTML = ICONS.archive(18);
archiveToggle.addEventListener('click', () => {
  showArchived = !showArchived;
  archiveToggle.classList.toggle('active', showArchived);
  refreshSidebar({ resort: true });
});

// --- Star filter toggle ---
starToggle.addEventListener('click', () => {
  showStarredOnly = !showStarredOnly;
  if (showStarredOnly) { showRunningOnly = false; runningToggle.classList.remove('active'); }
  starToggle.classList.toggle('active', showStarredOnly);
  refreshSidebar({ resort: true });
});

// --- Running filter toggle ---
runningToggle.addEventListener('click', () => {
  showRunningOnly = !showRunningOnly;
  if (showRunningOnly) { showStarredOnly = false; starToggle.classList.remove('active'); }
  runningToggle.classList.toggle('active', showRunningOnly);
  refreshSidebar({ resort: true });
});

// --- Today filter toggle ---
todayToggle.addEventListener('click', () => {
  showTodayOnly = !showTodayOnly;
  todayToggle.classList.toggle('active', showTodayOnly);
  refreshSidebar({ resort: true });
});

// --- Favorite-projects filter toggle (project-level, not session-level) ---
if (favoriteToggle) {
  favoriteToggle.addEventListener('click', () => {
    showFavoritedProjectsOnly = !showFavoritedProjectsOnly;
    favoriteToggle.classList.toggle('active', showFavoritedProjectsOnly);
    refreshSidebar({ resort: true });
  });
}
// The star filter only makes sense when favorites are a separate list. When they
// are pinned on top (favoritesOwnList off) the filter is redundant → hide it (and
// drop any active filter so the pinned list shows).
function updateFavoriteToggleVisibility() {
  if (!favoriteToggle) return;
  if (favoritesOwnList) {
    favoriteToggle.style.display = '';
  } else {
    favoriteToggle.style.display = 'none';
    if (showFavoritedProjectsOnly) {
      showFavoritedProjectsOnly = false;
      favoriteToggle.classList.remove('active');
    }
  }
}
updateFavoriteToggleVisibility();
