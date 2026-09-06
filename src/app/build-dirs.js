// app/build-dirs.js — the directories a walk or a watch must not go into, and the one file kind it
// must not even stat (#483).
//
// WHY THE SECOND HALF IS IN THIS FILE. Both were learned from one defect and neither is guessable, so
// separating them would leave the expensive half of the lesson with nothing to attach to.
//
// The measurement, on Electron 41, one process, one file each time, then `fs.unlinkSync`:
//
//   readdirSync(parent, {withFileTypes:true})   -> deleted, no handle
//   existsSync / statSync / lstatSync /
//   realpathSync / openSync   on `x.asar`       -> EBUSY, for the life of the process
//
// The `open` that threw ENOENT left the handle behind too. That is Electron's asar layer: a path whose
// last component ends in `.asar` is treated as an ARCHIVE ROOT, so any fs call on it builds an `Archive`,
// and the archive is cached with its descriptor open and never released. There is no API to close it —
// `process.noAsar` only changes what the NEXT call does, and in a packaged build turning it on would cut
// the main process off from its own code. So "read it and let go" is not available for these files: the
// only way not to hold one open is not to touch it, which is what `isAsarArchive` is for.
//
// That is how `npm run build:win` failed while a dev instance of the same checkout ran: electron-builder
// could not `unlink dist/win-unpacked/resources/app.asar`, and only that one file survived a recursive
// delete of the directory around it — a handle, not a permission. The holder was the DEV Electron's main
// process (Restart Manager), and what put the stat there was `electron-reloader`: with `watchRenderer`
// it hands chokidar the whole repository, whose only exclusions are dotfiles, `node_modules` and source
// maps. An installed build never loads it (`electron-is-dev`), which is why building while the INSTALLED
// app runs was always fine.
//
// The list itself is the plain answer to a second question the same defect asked: none of these
// directories ever holds an agent file, a plan or a work file, and walking one costs a directory that
// can hold a hundred thousand entries. It is a list of GENERATED output and FETCHED dependencies —
// nothing a person writes by hand — plus the three version-control stores, which are the same kind of
// "never a document" and were already skipped by name in several walks.
//
// The cost, stated because a list like this can only ever be approximately right: a file a project
// deliberately keeps under one of these names stops appearing in the lists that walk it. `dist/notes.md`
// is gone from Agent Files. That is a deliberate trade and it is not configurable — a setting here would
// be a control nobody could form an opinion about until it had already bitten them.
'use strict';

/**
 * Directories a walk does not enter and a watch does not follow.
 *
 * Lowercase, and matched case-insensitively: the two platforms this ships on both have case-insensitive
 * filesystems, and `Dist` on the third is the same directory to everyone reading it.
 */
const BUILD_DIR_NAMES = [
  // version control stores
  '.git', '.hg', '.svn',
  // fetched dependencies
  'node_modules', 'bower_components', 'vendor',
  // build output
  'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.gradle',
  // tool output
  'coverage', '.nyc_output',
  // python
  '__pycache__', '.venv', 'venv',
];

const _byName = new Set(BUILD_DIR_NAMES);

/** Is this directory NAME (not a path) generated output, a fetched dependency or a VCS store? */
function isBuildDir(name) {
  return typeof name === 'string' && _byName.has(name.toLowerCase());
}

/**
 * Is this name one Electron would hold open forever if anything statted it?
 *
 * Asked about the NAME, before the path is built, because the cheapest place to not touch a file is
 * before the `path.join`. A DIRECTORY called `x.asar` answers true as well, and that is right: every
 * path underneath it would carry `.asar` into the same archive lookup.
 */
function isAsarArchive(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.asar');
}

module.exports = { BUILD_DIR_NAMES, isBuildDir, isAsarArchive };
