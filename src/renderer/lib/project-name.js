// Pure helpers about a project GROUP as main sent it: the label shown for it, the display name a session
// inherits from it, and which group a session not yet in any belongs to. Custom displayName wins
// (trimmed); empty/whitespace falls back to the directory-derived shortName. Electron-free so it can be
// unit-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function projectDisplayLabel(displayName, shortName) {
    const custom = typeof displayName === 'string' ? displayName.trim() : '';
    return custom || shortName;
  }

  // Which display name belongs to which SESSION, built from the project lists main sends (#435).
  //
  // By session id first, which inherits main's canonical bucketing of one directory spelled two ways
  // (#245). By raw path for a session that is not in a bucket yet — and the path side is keyed by every
  // spelling main put into the bucket, not only the one the bucket carries (#667). A bucket carries
  // whichever spelling had sessions first, so a project whose seeded rows wrote its path with forward
  // slashes and whose Claude rows write backslashes is carried with the first; a session re-keyed by `/clear` is not in any
  // bucket until the index has read its new transcript, and a lookup by the bucket's spelling alone
  // then fell through to the folder name. The spellings of the session's own siblings are main's answer
  // to "is this the same directory", so nothing here compares two paths itself.
  //
  // Later lists win, so pass the archived list before the live one: a live bucket's name wins where a
  // directory appears in both.
  function projectDisplayNameIndex(projectLists) {
    const bySession = new Map();
    const byPath = new Map();
    for (const list of projectLists || []) {
      for (const project of list || []) {
        const name = project && typeof project.displayName === 'string' ? project.displayName.trim() : '';
        if (!name) continue;
        for (const spelling of bucketSpellings(project)) byPath.set(spelling, name);
        for (const session of project.sessions || []) {
          if (session && session.sessionId) bySession.set(session.sessionId, name);
        }
      }
    }
    return { bySession, byPath };
  }

  // The display name of the project a session belongs to, or ''. The callers pair it with the path tail
  // they already show through projectDisplayLabel, so an empty answer leaves them exactly as they were.
  function projectDisplayNameOf(index, session) {
    if (!index || !session) return '';
    return (index.bySession && index.bySession.get(session.sessionId))
      || (index.byPath && index.byPath.get(session.projectPath))
      || '';
  }

  // Every spelling main put into one bucket: the one the bucket carries, and each of its sessions' own.
  // Main bucketed those rows by `pathKey` (#245), so this set IS its answer to "same directory" — read,
  // never recomputed. The two lookups here and in findProjectGroup share it so they cannot drift.
  function bucketSpellings(project) {
    const out = new Set();
    if (!project) return out;
    if (project.projectPath) out.add(project.projectPath);
    for (const session of project.sessions || []) {
      if (session && session.projectPath) out.add(session.projectPath);
    }
    return out;
  }

  // The group in `list` that main already holds for the directory `projectPath` names, or null (#671).
  //
  // A session that is running but not indexed yet has no bucket of its own, so the sidebar has to place it.
  // Its spelling is the spawn's, and the group carries the spelling of the first row main read, so the two
  // can differ in slash direction or drive-letter case while naming one directory; an exact compare on the
  // group's spelling alone then opened a second group for it. The group's own spelling is tried first, then
  // every spelling of its sessions, gathered across `projectLists` (both lists main sent) so a group the
  // default list carries in another spelling than the archive-inclusive one is still found. Nothing here
  // compares two paths itself: a spelling no bucket holds matches nothing, and the caller opens a new group,
  // which is right for a directory whose first session this is.
  function findProjectGroup(list, projectPath, projectLists) {
    if (!list || !projectPath) return null;
    const exact = list.find(p => p && p.projectPath === projectPath);
    if (exact) return exact;
    const spellings = new Set([projectPath]);
    for (const other of projectLists || [list]) {
      for (const project of other || []) {
        const own = bucketSpellings(project);
        if (own.has(projectPath)) for (const spelling of own) spellings.add(spelling);
      }
    }
    return list.find(p => {
      for (const spelling of bucketSpellings(p)) if (spellings.has(spelling)) return true;
      return false;
    }) || null;
  }

  return { projectDisplayLabel, projectDisplayNameIndex, projectDisplayNameOf, findProjectGroup };
});
