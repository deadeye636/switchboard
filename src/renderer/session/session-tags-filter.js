// --- Session tags: pure filter logic (#164) ---
//
// The mirror of project-tags-filter.js, one axis down. A PROJECT tag drops whole projects; a SESSION tag
// drops session ROWS, and a project disappears as a consequence of having none left — not as the cause.
// That is the whole difference between the two, and it is why they can be selected together: "sessions
// tagged `bug` IN projects tagged `kunde`" is an AND across the two kinds, and it is the reason both live
// in one chip bar rather than behind a switch.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d by node tests
// (module.exports). Keep this file free of DOM references.

// Build a sessionId -> Set<tag> lookup from the flat rows returned by
// window.api.sessionTagsAll() ([{ sessionId, tag, color, hidden, disabled }, ...]).
function buildSessionTagMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.sessionId || !row.tag) continue;
    let set = map.get(row.sessionId);
    if (!set) { set = new Set(); map.set(row.sessionId, set); }
    set.add(row.tag);
  }
  return map;
}

// Keep only sessions whose tag set includes EVERY selected tag (AND match, like the project filter), and
// drop the projects left with nothing — an empty project row here would say "this project has no sessions",
// which is not what the filter found. An empty selection is a no-op (returns the projects untouched).
function filterProjectSessionsByTags(projects, tagMap, activeTags) {
  const active = Array.from(activeTags || []);
  const list = Array.isArray(projects) ? projects : [];
  if (active.length === 0) return list;
  const lookup = tagMap instanceof Map ? tagMap : new Map();

  const out = [];
  for (const project of list) {
    const sessions = (project && Array.isArray(project.sessions) ? project.sessions : []).filter((s) => {
      const tags = s && lookup.get(s.sessionId);
      if (!tags || tags.size === 0) return false;
      return active.every((t) => tags.has(t));
    });
    if (sessions.length === 0) continue;
    out.push({ ...project, sessions });
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildSessionTagMap,
    filterProjectSessionsByTags,
  };
}
