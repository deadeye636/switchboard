// Pure helper: pick the label shown for a project.
// Custom displayName wins (trimmed); empty/whitespace falls back to the
// directory-derived shortName. Electron-free so it can be unit-tested.
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
        if (project.projectPath) byPath.set(project.projectPath, name);
        for (const session of project.sessions || []) {
          if (!session) continue;
          if (session.sessionId) bySession.set(session.sessionId, name);
          if (session.projectPath) byPath.set(session.projectPath, name);
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

  return { projectDisplayLabel, projectDisplayNameIndex, projectDisplayNameOf };
});
