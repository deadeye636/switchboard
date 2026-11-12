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

// --- Holding the Activity order under the pointer (#867) ---
// A session in another project writing moves that project to the top, and the row under the pointer slides
// away mid-click. While the list is in use (the pointer over it, a menu or popover from it open, keyboard focus
// in it) renderProjects asks applyProjectOrderHold for the order to draw: the one already on screen, with
// everything else in the rows still updating. The render is NOT skipped: a skipped render would freeze status,
// counts and new sessions. Once the list is free again the held order is released with one ordinary render.
// An explicit `resort` (the Refresh button, a sort or filter change) is never held: the user asked for it.
const PROJECT_ORDER_RELEASE_MS = 300;
// A popover opened from a row of the list lives in <body>; dialogs.js marks it `data-project-list`. A bare
// `.popover` is NOT counted: other surfaces keep hidden ones around (the composer's completion box).
const PROJECT_LIST_MENU_SELECTOR = '[data-project-list]';
let _projectOrderPending = false;
let _projectOrderTimer = null;
let _projectOrderReleasing = false;

function isProjectListInUse() {
  if (typeof sidebarContent === 'undefined' || !sidebarContent) return false;
  if (sidebarContent.matches(':hover')) return true;
  // Keyboard focus only: a row clicked with the mouse keeps focus afterwards, and that must not hold forever.
  const ae = document.activeElement;
  if (ae && ae !== document.body && sidebarContent.contains(ae) && ae.matches(':focus-visible')) return true;
  return [...document.querySelectorAll(PROJECT_LIST_MENU_SELECTOR)]
    .some(el => el.isConnected && !el.hidden && getComputedStyle(el).display !== 'none');
}

function clearProjectOrderTimer() {
  _projectOrderPending = false;
  if (_projectOrderTimer !== null) { clearTimeout(_projectOrderTimer); _projectOrderTimer = null; }
}

function isWindowHidden() {
  return document.hidden || document.body.classList.contains('window-hidden');
}

function scheduleProjectOrderRelease() {
  _projectOrderPending = true;
  clearTimeout(_projectOrderTimer);
  _projectOrderTimer = setTimeout(() => {
    _projectOrderTimer = null;
    // A hidden window re-arms nothing; the visibilitychange listener below resumes it.
    if (isWindowHidden()) return;
    if (isProjectListInUse()) { scheduleProjectOrderRelease(); return; }
    _projectOrderPending = false;
    _projectOrderReleasing = true;
    try { refreshSidebar(); } finally { _projectOrderReleasing = false; }
  }, PROJECT_ORDER_RELEASE_MS);
}

// `sorted` is sortProjects' answer. Returns the list to draw.
function applyProjectOrderHold(sorted, resort) {
  const holding = !resort && !_projectOrderReleasing && projectSortMode === 'activity'
    && typeof holdProjectOrder === 'function' && sortedOrder.length > 0 && isProjectListInUse();
  if (!holding) {
    clearProjectOrderTimer(); // this render draws the sorted order, so nothing is pending any more
    return sorted;
  }
  // A group whose spelling changed since the last draw is still the same group (#671): ask findProjectGroup
  // for its current spelling rather than comparing the raw paths.
  const heldPaths = sortedOrder.map(e => {
    const g = typeof findProjectGroup === 'function' ? findProjectGroup(sorted, e.projectPath, [sorted]) : null;
    return g ? g.projectPath : e.projectPath;
  });
  const held = holdProjectOrder(sorted, heldPaths, { favoritesFirst: !favoritesOwnList });
  if (held.some((p, i) => p !== sorted[i])) scheduleProjectOrderRelease();
  else clearProjectOrderTimer();
  return held;
}

// The pointer leaving is the usual end of a hold: restart the delay from there.
sidebarContent.addEventListener('mouseleave', () => {
  if (_projectOrderPending) scheduleProjectOrderRelease();
});
// A hidden window stops the release timer; coming back to it resumes a pending release.
document.addEventListener('visibilitychange', () => {
  if (_projectOrderPending && !isWindowHidden()) scheduleProjectOrderRelease();
});

// --- Gliding re-ordered projects into place (#868) ---
// FLIP: measure every project group before morphdom, let morphdom move them (it keeps the elements, keyed by
// id), measure again, and play a transform from the old place to the new. TRANSIENT on purpose: each animation
// ends in ~180 ms and leaves nothing running (renderer.md, "Motion is paid for BY THE FRAME"). It also plays
// for the order #867 held back, because that release is an ordinary render through finalizeSidebar.
const PROJECT_GLIDE_MS = 180;

function projectGroupsOf(container) {
  return [...container.children].filter(el => el.classList.contains('project-group') && el.id);
}

// Called by finalizeSidebar before morphdom with the new tree; returns null (no glide) or a function to call
// after morphdom.
function beginProjectGlide(newSidebar) {
  if (typeof shouldGlideProjects !== 'function' || typeof sidebarContent === 'undefined') return null;
  const before = projectGroupsOf(sidebarContent);
  const reducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!shouldGlideProjects({
    mode: projectSortMode,
    reducedMotion,
    hidden: document.hidden || document.body.classList.contains('window-hidden'),
    prevIds: before.map(el => el.id),
    nextIds: projectGroupsOf(newSidebar).map(el => el.id),
  })) return null;
  // A glide still running from the render before would be measured mid-transform: cancel it first, so the old
  // places are the real ones.
  for (const el of before) if (typeof el.getAnimations === 'function') el.getAnimations().forEach(a => a.cancel());
  const tops = new Map(before.map(el => [el.id, el.getBoundingClientRect().top]));
  return () => {
    for (const el of projectGroupsOf(sidebarContent)) {
      if (!tops.has(el.id) || typeof el.animate !== 'function') continue;
      const dy = tops.get(el.id) - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: PROJECT_GLIDE_MS, easing: 'ease-out' });
    }
  };
}
