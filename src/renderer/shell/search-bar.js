// --- The sidebar search bar (debounced, per-tab FTS) (#218, #228) ---
//
// The search-as-you-type box above the sidebar: the debounce, the 3-char floor, the per-tab dispatch
// (sessions / plans / memory / work-files), and the Enter/refresh reindex. Came out of app.js.
//
// A PLAIN CLASSIC SCRIPT — no IIFE, no UMD factory — that reads app.js's bindings at call time through the
// shared global scope. Two of them it WRITES: `searchMatchIds` and `searchMatchProjectPaths` (declared at
// app.js:284-285), the filter state app.js's own sidebar render reads. They stay in app.js because that
// reader is there — the counting-readers rule — and this file assigns them the way sidebar.js assigns
// `sortedOrder`: same lexical binding, at call time, never wrapped.
//
// LOAD ORDER: this file must load AFTER app.js, and it is the first #218/#228 cut that does. Its five
// parse-time side effects (four addEventListener calls, one getSetting IIFE) touch app.js's DOM handles
// `searchInput` / `searchBar` / `searchClear` / `searchTitlesToggle` (app.js:11/34 and the two the block
// declared) — and `searchInput`/`searchBar` are app.js consts that app.js also uses for the tab-placeholder
// logic, so they cannot move here. If this file parsed BEFORE app.js, those consts would be in their TDZ
// and every addEventListener would throw. Loading after app.js, they are already bound. app.js needs
// nothing from this file at its own parse time (no external caller of clearSearch/runSearchQuery/…), so
// after-app.js is safe both ways.
//
// What it reaches into, by file:
//   app.js                 searchInput, searchBar, searchClear (DOM handles), activeTab, cachedAllProjects,
//                          cachedPlans, refreshSidebar, and it WRITES searchMatchIds / searchMatchProjectPaths
//   views/plans-memory-view.js, views/*  renderPlans, renderMemories, renderWorkFiles

// --- Search (debounced, per-tab FTS) ---
// Trigram tokenizer makes 1-2 char queries the most expensive (they match
// enormous row sets). Treat any query shorter than this as "no filter".
const MIN_SEARCH_CHARS = 3;

let searchDebounceTimer = null;
const searchClear = document.getElementById('search-clear');
const searchTitlesToggle = document.getElementById('search-titles-toggle');
let searchTitlesOnly = false;

// Load persisted preference
(async () => {
  const saved = await window.api.getSetting('searchTitlesOnly');
  if (saved) {
    searchTitlesOnly = true;
    searchTitlesToggle.classList.add('active');
  }
})();

searchTitlesToggle.addEventListener('click', async () => {
  searchTitlesOnly = !searchTitlesOnly;
  searchTitlesToggle.classList.toggle('active', searchTitlesOnly);
  await window.api.setSetting('searchTitlesOnly', searchTitlesOnly);
  // Re-run current search if there's a query
  const query = searchInput.value.trim();
  if (query) {
    searchInput.dispatchEvent(new Event('input'));
  }
});

function clearSearch() {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    // resort: true — sortedOrder was overwritten during the search render to
    // contain only matched projects; resorting from data is required to restore
    // the correct full-list order.
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  } else if (activeTab === 'work-files') {
    renderWorkFiles();
  }
}

// Reset search filter state without clearing the input text.
// Used when the query drops below MIN_SEARCH_CHARS while the user is still
// typing — we want no results filter applied, but we must not wipe the
// partially-typed text.
function resetSearchFilter() {
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    // resort: true — same reason as clearSearch: sortedOrder may be stale if a
    // prior 3+ char search ran (and overwrote it with the filtered subset).
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  } else if (activeTab === 'work-files') {
    renderWorkFiles();
  }
}

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

// Extracted so the rebuild-cache button and Enter handler can call it too.
async function runSearchQuery() {
  const query = searchInput.value.trim();
  if (!query) {
    clearSearch();
    return;
  }
  // 1-2 char queries are the most expensive for the trigram tokenizer (they
  // match enormous row sets). Treat them as "no filter" and show the full
  // unfiltered list — but do NOT call clearSearch(), which would wipe the
  // partially-typed text; instead use resetSearchFilter() to reset only the
  // filter state.
  if (query.length < MIN_SEARCH_CHARS) {
    resetSearchFilter();
    return;
  }
  try {
    if (activeTab === 'sessions') {
      const results = await window.api.search('session', query, searchTitlesOnly);
      searchMatchIds = new Set(results.map(r => r.id));
      searchMatchProjectPaths = null;
      // Also match projects by name — the custom display name or the path
      // short-name (case-insensitive) — so typing a project name surfaces it,
      // not just sessions with matching content. Runs in every search mode (#96).
      const lowerQ = query.toLowerCase();
      for (const p of cachedAllProjects) {
        const shortName = p.projectPath.split('/').filter(Boolean).slice(-2).join('/');
        const displayName = p.displayName || '';
        if (shortName.toLowerCase().includes(lowerQ) || displayName.toLowerCase().includes(lowerQ)) {
          if (!searchMatchProjectPaths) searchMatchProjectPaths = new Set();
          searchMatchProjectPaths.add(p.projectPath);
        }
      }
      refreshSidebar({ resort: true });
    } else if (activeTab === 'plans') {
      const results = await window.api.search('plan', query, searchTitlesOnly);
      const matchIds = new Set(results.map(r => r.id));
      renderPlans(cachedPlans.filter(p => matchIds.has(p.filename)));
    } else if (activeTab === 'memory') {
      const results = await window.api.search('memory', query, searchTitlesOnly);
      const matchIds = new Set(results.map(r => r.id));
      renderMemories(matchIds);
    } else if (activeTab === 'work-files') {
      const results = await window.api.search('work-file', query, searchTitlesOnly);
      const matchIds = new Set(results.map(r => r.id));
      renderWorkFiles(matchIds);
    }
  } catch {
    if (activeTab === 'sessions') {
      searchMatchIds = null;
      searchMatchProjectPaths = null;
      refreshSidebar({ resort: true });
    }
  }
}

// Debounced search-as-you-type. Bumped from 200ms to 350ms — gentler under
// heavy workloads (many active subagents) and gives the user time to finish
// a word before searching. Explicit triggers (Enter, refresh button) bypass
// the debounce.
searchInput.addEventListener('input', () => {
  searchBar.classList.toggle('has-query', searchInput.value.length > 0);
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    runSearchQuery();
  }, 350);
});

// Enter in the search field = "I want fresh results": trigger a full worker
// reindex (which rewrites search_fts with the live content of active session
// JSONLs), then re-run the query. Pending debounce gets cancelled.
searchInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  await triggerRebuildAndSearch();
});

// Refresh button in the search bar — same behavior as pressing Enter.
const searchRefreshBtn = document.getElementById('search-refresh-btn');
if (searchRefreshBtn) {
  searchRefreshBtn.addEventListener('click', () => triggerRebuildAndSearch());
}

let rebuildInFlight = false;
async function triggerRebuildAndSearch() {
  if (rebuildInFlight) return;
  rebuildInFlight = true;
  if (searchRefreshBtn) searchRefreshBtn.classList.add('spinning');
  try {
    await window.api.rebuildCache();
  } catch {}
  finally {
    rebuildInFlight = false;
    if (searchRefreshBtn) searchRefreshBtn.classList.remove('spinning');
  }
  // After reindex, refire the current query so the user sees fresh hits.
  await runSearchQuery();
}
