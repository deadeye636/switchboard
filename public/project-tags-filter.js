// --- Project tags: pure filter logic (#98) ---
// AND-match filter for the sidebar project-tag filter, free of DOM/browser APIs
// so the renderer (sidebar.js / app.js) and node tests share one implementation.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM references.

// Build a projectPath -> Set<tag> lookup from the flat rows returned by
// window.api.projectTagsAll() ([{ projectPath, tag, color }, ...]).
function buildProjectTagMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.projectPath || !row.tag) continue;
    let set = map.get(row.projectPath);
    if (!set) { set = new Set(); map.set(row.projectPath, set); }
    set.add(row.tag);
  }
  return map;
}

// Keep only projects whose tag set includes EVERY selected tag (AND match,
// VSCode Project Manager style). An empty selection is a no-op (returns all).
// tagMap: Map<projectPath, Set<tag>>; activeTags: iterable of selected tags.
function filterProjectsByTags(projects, tagMap, activeTags) {
  const active = Array.from(activeTags || []);
  if (active.length === 0) return Array.isArray(projects) ? projects : [];
  const lookup = tagMap instanceof Map ? tagMap : new Map();
  return (Array.isArray(projects) ? projects : []).filter((project) => {
    const tags = project && lookup.get(project.projectPath);
    if (!tags || tags.size === 0) return false;
    return active.every((t) => tags.has(t));
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildProjectTagMap,
    filterProjectsByTags,
  };
}
