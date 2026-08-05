// Telling "no projects" apart from "we could not find out" (#431).
//
// The distinction is the whole issue. `get-projects` used to answer a failed read with `[]`, which is
// also what a fresh install answers, so the renderer replaced a populated sidebar with nothing and said
// nothing about it. Rejecting made the two distinguishable — this is where the renderer decides what
// each one means, kept pure so both branches can be pinned without an app.
//
// Electron-free, like every other module in this folder.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // This module held two more functions — a three-state classifier and a "may this replace the list"
  // predicate — and a verifier pointed out that nothing called them. `loadProjects` expresses the same
  // rule as control flow (the failure path returns before it assigns), which is the honest place for it,
  // and the tests over the unused pair would have stayed green through a break in the real thing. Better
  // no abstraction than one that only exists to be tested.
  //
  // What the user is told. Short enough for the sidebar's one line; the cause rides in the tooltip,
  // because it is a developer's sentence and the line above it has to stay readable.
  //
  // `hadList` changes what is TRUE, not just the wording: with a list on screen the reassuring half is
  // accurate, and on a first load that failed it would be a lie about an empty sidebar.
  function projectsFailureNotice(err, hadList) {
    const cause = (err && (err.message || err.toString())) || 'unknown error';
    return hadList
      ? {
        text: 'Could not read the project list — showing what was last loaded',
        title: cause + '\n\nThe list is not gone, it could not be re-read. Click to try again; it also clears itself on the next successful load.',
      }
      : {
        text: 'Could not read the project list',
        title: cause + '\n\nNothing has loaded yet, so the sidebar is empty for that reason and not because there is nothing. Click to try again.',
      };
  }

  return { projectsFailureNotice };
});
