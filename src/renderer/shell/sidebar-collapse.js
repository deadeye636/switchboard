// --- The sidebar's collapse/expand-all controller (#218, #228) ---
//
// The one toolbar button that folds or unfolds every collapsible section in the session overview
// (project and worktree headers, auto-slug groups — all share the `.collapsed` class), plus the startup
// collapse default. Came out of app.js. Feature, not wiring: nothing outside app.js drives it.
//
// A PLAIN CLASSIC SCRIPT that LOADS AFTER app.js. Its parse-time tail binds a click listener to
// `collapseAllToggle` — an app.js const (app.js:75) — so parsed before app.js that const would be in its
// TDZ. app.js reaches back into this controller at two points, both guarded because this file loads later:
// updateCollapseAllToggle (app.js:819, `typeof` guard, pre-existing) and applyCollapseDefault (app.js:2320,
// guarded here to match). Both are call-time; neither runs at app.js parse.
//
// What it reaches into app.js at call time: sidebarContent, collapseAllToggle (DOM handles),
// saveExpandedSlugs (app.js:167). It writes none of app.js's state — it only toggles a DOM class.

// --- Collapse / expand all ---
// Operates on every collapsible section in the session overview: project and
// worktree headers, and auto slug groups. They all share the `.collapsed` class,
// so "collapse all" adds it everywhere and "expand all" removes it. Slug collapse
// state is persisted via its existing helpers; project/worktree headers persist
// across re-renders via morphdom.
const COLLAPSIBLE_SECTION_SELECTOR = '.project-header, .worktree-header, .slug-group';

function getCollapsibleSections() {
  return Array.from(sidebarContent.querySelectorAll(COLLAPSIBLE_SECTION_SELECTOR));
}

function updateCollapseAllToggle() {
  if (!collapseAllToggle) return;
  const sections = getCollapsibleSections();
  // "All collapsed" only when there is something to collapse and nothing is open.
  const allCollapsed = sections.length > 0 && sections.every(s => s.classList.contains('collapsed'));
  collapseAllToggle.classList.toggle('all-collapsed', allCollapsed);
  collapseAllToggle.disabled = sections.length === 0;
  collapseAllToggle.title = allCollapsed ? 'Expand all' : 'Collapse all';
  collapseAllToggle.setAttribute('aria-label', collapseAllToggle.title);
  collapseAllToggle.setAttribute('data-tooltip', collapseAllToggle.title);
  collapseAllToggle.innerHTML = allCollapsed
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 5 12 11 18 5"/><polyline points="6 13 12 19 18 13"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 11 12 5 18 11"/><polyline points="6 19 12 13 18 19"/></svg>';
}

// Apply the startup collapse default (sidebarCollapseDefault setting):
// 'expanded' / 'collapsed' force all sections; 'remember' leaves the persisted
// state alone. Called once after the initial sidebar render.
function applyCollapseDefault(mode) {
  if (mode !== 'expanded' && mode !== 'collapsed') return; // 'remember' = persisted state
  const sections = getCollapsibleSections();
  if (sections.length === 0) return;
  const collapse = mode === 'collapsed';
  for (const section of sections) section.classList.toggle('collapsed', collapse);
  saveExpandedSlugs();
  if (typeof updateCollapseAllToggle === 'function') updateCollapseAllToggle();
}

function toggleCollapseAllSections() {
  const sections = getCollapsibleSections();
  if (sections.length === 0) return;
  // Collapse everything unless it's already all collapsed (then expand).
  const collapse = sections.some(s => !s.classList.contains('collapsed'));
  for (const section of sections) section.classList.toggle('collapsed', collapse);
  saveExpandedSlugs();
  updateCollapseAllToggle();
}

if (collapseAllToggle) {
  collapseAllToggle.addEventListener('click', toggleCollapseAllSections);
  updateCollapseAllToggle();
}
