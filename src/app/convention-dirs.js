// The convention directories a project keeps — handoffs and plans — answered in ONE place, for everyone
// who has to NAME one rather than read one.
//
// Two features ask the same question from opposite ends. A handoff prompt tells an agent where the packet
// belongs, and when that prompt is a slash command the sentence we append is the only influence we have
// over a skill we did not write. An insert template resolves `{handoffDir}` for whatever project the
// terminal happens to be in. Both need the setting, the project root and the same answer; a second
// implementation is how a prompt and a template end up naming different directories, and nobody finds out
// until a packet is missing.
//
// Escaping is settled here rather than by each caller. `handoffDir: '../packets'` is a path that leaves
// the project, and a prompt naming it sends an agent to write outside the tree it was opened on — so such
// a setting falls back to the default instead of being passed on. `path-containment.js` answers that,
// because a junction is spelled inside a project it is not in (#474).
//
// Electron-free and DB-free on purpose: the pure part is `conventionDirs(projectPath, effectiveSettings)`,
// which `node --test` can call with a plain object.
'use strict';

const path = require('path');
const { isAtOrInside } = require('./path-containment');
const { SETTING_DEFAULTS } = require('./settings');

let ctx = null;

/** @param {object} context @param {(p: string|null) => object} context.effectiveSettings */
function init(context) {
  ctx = context;
}

/** The default a blank, whitespace-only or escaping setting falls back to. One definition: the settings blob's. */
function defaultName(key) {
  const value = SETTING_DEFAULTS && SETTING_DEFAULTS[key];
  return (typeof value === 'string' && value.trim()) || (key === 'planDir' ? '.plans' : '.handoffs');
}

/** The project-relative name for one setting, with the escape guard applied. */
function dirName(projectPath, eff, key) {
  const fallback = defaultName(key);
  const raw = eff && typeof eff[key] === 'string' ? eff[key].trim() : '';
  const name = raw || fallback;
  if (!projectPath) return name;
  // Asked about the DIRECTORY, and before any stat: it need not exist yet, and a guard placed after one
  // never sees a path that escaped and had nothing at the end of it (#474, #476).
  return isAtOrInside(path.resolve(projectPath, name), projectPath) ? name : fallback;
}

/**
 * Both directories for one project, relative AND absolute.
 *
 * Relative is what a human reads and what the settings hold; absolute is what an agent can act on without
 * us knowing its working directory. Callers get both and pick — which is why the handoff prompt's appended
 * line uses the absolute one while the settings page shows the relative.
 *
 * Pure: `eff` is the already-cascaded settings object.
 */
function conventionDirs(projectPath, eff) {
  const root = projectPath ? path.resolve(projectPath) : '';
  const handoffDir = dirName(root, eff, 'handoffDir');
  const planDir = dirName(root, eff, 'planDir');
  return {
    handoffDir,
    planDir,
    handoffPath: root ? path.join(root, handoffDir) : '',
    planPath: root ? path.join(root, planDir) : '',
  };
}

/** The same answer, with the cascade resolved through ctx. Never throws — a prompt is not worth a failure. */
function dirsFor(projectPath) {
  try {
    const eff = ctx && ctx.effectiveSettings ? ctx.effectiveSettings(projectPath || null) : null;
    return conventionDirs(projectPath, eff);
  } catch {
    return conventionDirs(projectPath, null);
  }
}

function registerIpc(ipc) {
  ipc.handle('project-convention-dirs', (_event, projectPath) => dirsFor(projectPath));
}

module.exports = { init, registerIpc, conventionDirs, dirsFor };
