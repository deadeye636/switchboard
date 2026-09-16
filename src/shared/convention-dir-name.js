// --- Is this a convention directory name usable at all, with no project to ask about? (#630) ---
//
// `src/app/convention-dirs.js` is the ONE answer to where a project keeps its handoffs and its plans, and
// when it has a project it decides against the REAL path of both sides, because a junction is spelled
// inside a project it is not in (#474). That answer needs a project and it needs the filesystem.
//
// Two callers have neither. The welcome tour edits the GLOBAL setting, before any project exists, and
// draws a figure of where the next plan and the next handoff will land — synchronously, on every
// keystroke, so it cannot ask the main process and cannot stat anything. Left to itself it drew
// `my-project/ ├─ ../plans/`, a tree no project will ever have, under a caption promising that is where
// the file goes. And `conventionDirs(null, eff)` is asked the same question by an insert template for a
// session with no project.
//
// So the LEXICAL rule lives here, where both processes load it: what a name means when there is nothing
// to resolve it against. Write a second copy of it in the renderer and the tour starts promising a
// directory the app does not use, which is the whole of #623 and #630 one surface over.
//
// **It is NOT a pre-check for the project case, and that was tried.** `../<the project's own name>/.plans`
// climbs out and lands back in — lexically it escapes, on disk it does not, and `isInside` accepts it. A
// lexical veto in front of that check refuses a setting that works, silently. So where there is a project,
// the filesystem decides alone; this answers only where nothing else can.
//
// Deliberately NO judgement on an absolute name: one pointing inside its project is legal and is spelled
// back out relative (#623), and whether it points inside is a question about a project that does not exist
// here. It says so — `'absolute'` — rather than guessing, and each caller decides what to do about it.

/**
 * What a `handoffDir`/`planDir` value means with no project to resolve it against.
 *
 * `''` — nothing lexical is wrong with it.
 * `'blank'` — not a name at all.
 * `'escapes'` — climbs out before it enters, so it names something beside the project.
 * `'root'` — resolves to the project itself, which is neither feature's directory.
 * `'absolute'` — cannot be judged without a project; see the note above.
 */
function conventionDirNameProblem(name) {
  if (typeof name !== 'string') return 'blank';
  const trimmed = name.trim();
  if (!trimmed) return 'blank';
  // The drive-letter test reads `X:foo` as absolute, which on POSIX is a legal relative name containing a
  // colon. Same trade as the separator below, and with the same reasoning: this runs where there is no
  // project and therefore no platform to ask, and nobody names a directory that way.
  if (/^[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) return 'absolute';
  // Split on both separators. A backslash IS a legal filename character on POSIX, so this can misread a
  // name that contains one — accepted knowingly: the alternative is a renderer that has to know which
  // platform the project is on, and a directory named `..\x` is not a thing anybody has.
  const parts = trimmed.split(/[\\/]+/).filter(part => part !== '' && part !== '.');
  if (!parts.length) return 'root';                       // `.`, `./`, `.//.`
  let depth = 0;
  for (const part of parts) {
    if (part !== '..') { depth += 1; continue; }
    if (depth === 0) return 'escapes';                    // climbs past the project before it enters it
    depth -= 1;
  }
  return depth === 0 ? 'root' : '';                       // `docs/..` lands back on the root
}

/** The same answer as a yes/no, for a caller that only has to decide whether to use the value. */
function unusableConventionDirName(name) {
  const problem = conventionDirNameProblem(name);
  return problem !== '' && problem !== 'absolute';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { conventionDirNameProblem, unusableConventionDirName };
}
