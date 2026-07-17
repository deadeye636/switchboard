// --- The sidebar's project-sort controller (#218, #228) ---
//
// The third and last controller #228 bundled as "filter toolbar". It owns the project sort: the saved
// mode from settings, the View menu's session-only override (#181), the manual drag order, and the Refresh
// button. It is a small API surface the View menu drives — _getSortView / _setSortOverride /
// _resetSortOverride — plus _applyProjectSortSettings (from settings) and _persistProjectOrder (from a
// sidebar drag). Came out of app.js.
//
// A PLAIN CLASSIC SCRIPT that LOADS AFTER app.js, like the filter and collapse controllers: its parse-time
// tail binds a click listener to resortBtn (an app.js const), and its window._* API must be assigned
// before view-menu.js (which also loads after app.js) calls it — call-time, so order beyond "after app.js"
// does not matter. Every app.js caller of this controller is already guarded because it loads later:
// _applyProjectSortSettings via window?.() and typeof at the two settings-apply sites; applyEffectiveSort
// has no app.js caller outside this file (view-menu.js calls it at click time).
//
// THE SORT STATE STAYS IN app.js because other files read the shared-scope bindings DIRECTLY — sidebar.js,
// sidebar-events.js and sidebar-filters.js do. (project-sort.js, view-menu.js and settings-panel.js also
// depend on the sort, but indirectly — through opts params, the _getSortView() return, and the settings
// blob respectively — so they do not pin the lets to this scope; the direct readers do.) This controller
// WRITES them through the shared scope (plain assignment onto the app.js binding, never a factory/window
// shadow — the #218 trap):
//   savedProjectSortMode, savedFavoritesOwnList   the settings mirror (also localStorage-cached)
//   projectSortMode, favoritesOwnList             the effective values the render sorts by
//   sortOverride                                  the View menu's this-session override
//   projectOrder                                  the manual drag order (also localStorage)
//
// Globals it also uses at call time: refreshSidebar, loadProjects, resortBtn (DOM); updateFavoriteToggleVisibility
// (shell/sidebar-filters.js, typeof-guarded) and window._renderViewMenu / window._updateViewMenuBtn
// (shell/view-menu.js, typeof-guarded).

// --- Project sort settings (#17) ---
// projectSortMode + favoritesOwnList live in the global settings blob (chosen in
// the Session Display settings). Mirror them into the render-time vars (+ a
// localStorage cache for the first paint) and re-render when they change.
window._applyProjectSortSettings = (g) => {
  if (!g) return;
  savedProjectSortMode = (g.projectSortMode === 'alpha' || g.projectSortMode === 'manual') ? g.projectSortMode : 'activity';
  savedFavoritesOwnList = !!g.favoritesOwnList;
  localStorage.setItem('projectSortMode', savedProjectSortMode);
  localStorage.setItem('favoritesOwnList', savedFavoritesOwnList ? '1' : '0');
  applyEffectiveSort();
};

// --- The View menu's sort override (#181) ---
// Settings holds the sort. The View menu in the sidebar can put a different one in front of you for
// THIS RUN of the app — never written anywhere, so a restart is back to what Settings says, and a Save
// in Settings is never something the sidebar did behind your back.
function applyEffectiveSort() {
  projectSortMode = sortOverride ? sortOverride.projectSortMode : savedProjectSortMode;
  favoritesOwnList = sortOverride ? sortOverride.favoritesOwnList : savedFavoritesOwnList;
  if (typeof updateFavoriteToggleVisibility === 'function') updateFavoriteToggleVisibility();
  if (typeof window._renderViewMenu === 'function') window._renderViewMenu();
  if (typeof window._updateViewMenuBtn === 'function') window._updateViewMenuBtn();
  if (typeof refreshSidebar === 'function') refreshSidebar({ resort: true });
}

// What the View menu shows and edits. `overridden` is the difference between the two, and it is what the
// menu has to say out loud — an order you cannot tell from the saved one is how you end up "fixing" a
// setting that was never wrong.
window._getSortView = () => ({
  projectSortMode,
  favoritesOwnList,
  savedProjectSortMode,
  savedFavoritesOwnList,
  overridden: !!sortOverride
    && (sortOverride.projectSortMode !== savedProjectSortMode
      || sortOverride.favoritesOwnList !== savedFavoritesOwnList),
});

// A patch from the menu. It always lands in the override — even when it happens to equal the saved value,
// because "I chose this" and "nobody said otherwise" are different states, and only the reset clears it.
window._setSortOverride = (patch) => {
  const next = {
    projectSortMode: projectSortMode,
    favoritesOwnList: favoritesOwnList,
    ...(patch || {}),
  };
  sortOverride = next;
  applyEffectiveSort();
};

window._resetSortOverride = () => {
  sortOverride = null;
  applyEffectiveSort();
};
// Persist the manual project order (written by drag-reorder in the sidebar).
window._persistProjectOrder = (arr) => {
  projectOrder = Array.isArray(arr) ? arr.slice() : [];
  localStorage.setItem('projectOrder', JSON.stringify(projectOrder));
};

// --- Refresh button ---
// Reloads the project list from main (filesystem reconcile + backend scan) and
// rebuilds the order from it. The only sidebar control that goes back to main —
// the filter and view toggles re-sort the already-loaded data (#180).
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});
