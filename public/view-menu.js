// view-menu.js — the sidebar's View popover (#181).
//
// The project order used to live in the settings dialog alone. It is a "how does my list look right now"
// decision, taken while looking at the list, and it cost a trip through Settings and a Save every time —
// and there was no way to try an order without committing to it.
//
// So the menu writes NOTHING. What it sets is an override that lives for this run of the app: Settings
// stays the source of truth and the fallback, a restart is back to it, and the menu says out loud when
// what you are looking at is not what is saved. An order you cannot tell from the saved one is how you
// end up "fixing" a setting that was never wrong.
//
// State lives in app.js (window._getSortView / _setSortOverride / _resetSortOverride); this file is the
// popover and nothing else.
(function () {
  const btn = document.getElementById('view-menu-btn');
  if (!btn) return;

  let menu = null;

  const SORTS = [
    { id: 'activity', label: 'Activity', hint: 'newest first' },
    { id: 'alpha', label: 'A–Z', hint: 'by name' },
    { id: 'manual', label: 'Manual', hint: 'as you dragged them' },
  ];

  const sortLabel = (id) => (SORTS.find(s => s.id === id) || SORTS[0]).label;

  function close() {
    if (!menu) return;
    menu.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onDocClick(e) {
    if (!menu) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    close();
  }

  function onKey(e) {
    if (e.key === 'Escape' && menu) { e.preventDefault(); close(); }
  }

  function render() {
    if (!menu) return;
    const view = (typeof window._getSortView === 'function') ? window._getSortView() : null;
    if (!view) return;

    const rows = SORTS.map(s => `
      <button type="button" class="view-menu-item${view.projectSortMode === s.id ? ' on' : ''}"
              data-sort="${s.id}" role="menuitemradio" aria-checked="${view.projectSortMode === s.id}">
        <span class="view-menu-tick">${view.projectSortMode === s.id ? '&#10003;' : ''}</span>
        <span class="view-menu-label">${s.label}</span>
        <span class="view-menu-hint">${s.hint}</span>
      </button>`).join('');

    menu.innerHTML = `
      <div class="view-menu-head">Sort projects</div>
      ${rows}
      <div class="view-menu-sep"></div>
      <label class="view-menu-check">
        <input type="checkbox" id="view-menu-fav" ${view.favoritesOwnList ? 'checked' : ''}>
        <span>Favourites in their own list</span>
      </label>
      ${view.overridden
        // Only when what you are looking at is not what Settings holds. The button carries a dot for the
        // same reason: an order you cannot tell from the saved one is how you end up "fixing" a setting
        // that was never wrong. The Reset says the rest.
        ? `<div class="view-menu-foot">
             <button type="button" class="view-menu-reset" data-reset="1"
                     title="Back to the sort saved in Settings (${sortLabel(view.savedProjectSortMode)})">Reset to saved</button>
           </div>`
        : ''}`;

    menu.querySelectorAll('[data-sort]').forEach(el => {
      el.addEventListener('click', () => {
        window._setSortOverride({ projectSortMode: el.dataset.sort });   // re-renders through applyEffectiveSort
      });
    });
    const fav = menu.querySelector('#view-menu-fav');
    if (fav) fav.addEventListener('change', () => window._setSortOverride({ favoritesOwnList: fav.checked }));
    const reset = menu.querySelector('[data-reset]');
    if (reset) reset.addEventListener('click', () => window._resetSortOverride());
  }

  function open() {
    close();
    menu = document.createElement('div');
    menu.className = 'view-menu';
    menu.setAttribute('role', 'menu');
    btn.parentElement.appendChild(menu);   // the filter bar is positioned; the menu hangs off the button
    btn.setAttribute('aria-expanded', 'true');
    render();
    // Bound in the capture phase so a click anywhere — including on another sidebar control — closes it
    // before that control acts on it.
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) close(); else open();
  });

  // app.js calls this whenever the effective sort changes, so the open menu never shows a stale tick —
  // including when the change came from Settings while the menu was open.
  window._renderViewMenu = () => { if (menu) render(); };
  // The button wears a dot while an override is in effect: the sidebar is not sorted the way Settings says,
  // and that has to be visible without opening anything.
  window._updateViewMenuBtn = () => {
    const view = (typeof window._getSortView === 'function') ? window._getSortView() : null;
    btn.classList.toggle('has-override', !!(view && view.overridden));
    btn.title = view && view.overridden
      ? `View — sorted by ${sortLabel(view.projectSortMode)} just for now (saved: ${sortLabel(view.savedProjectSortMode)})`
      : 'View — how the project list is sorted';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('data-tooltip', btn.title);
  };
  window._updateViewMenuBtn();
})();
