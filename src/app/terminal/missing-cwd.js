'use strict';
// A resume of a session whose working directory is gone (#862).
//
// Some CLIs ask what to do when the folder a session ran in no longer exists (Pi since 1.5.2: Continue, Fork or
// Cancel). A terminal stops at that question and a piped session has nobody to answer, so the app asks FIRST
// and launches the CLI in a way that never asks. This module is the neutral half: it decides "gone" and runs the
// continue; the descriptor's `resumeCwd` hook says where its CLI keeps the folder and how to move a session
// to another one, and a fork is the backend's ordinary fork (`supportsFork`, `buildLaunch({ forkFrom })`).
//
//   resumeCwd: {
//     read(file) -> string | null                         the folder the transcript has on record
//     continueIn({ file, storedCwd, cwd }) -> { ok, reason? }   make the session run in `cwd`
//   }
//
// Electron-free, so the decision is testable. The existence check is a DECISION, not a guard of access
// (CLAUDE.md reflex 13 is about the second), but it is still a touch of the filesystem: a network path that no
// project of the user's is on is never statted (#780). The registered projects and the one being resumed are the
// known ones, so a project that itself lives on a share keeps working.

const fs = require('fs');
const { isForeignNetworkPath } = require('../network-path');

/**
 * @param {object} p
 * @param {object} p.backend        the descriptor that opens the session
 * @param {object|null} p.row       the cached session row
 * @param {string} p.projectPath    where the resume would run
 * @param {string[]} [p.knownPaths] the user's registered projects: a network path on one of their shares may be checked
 * @param {(p: string) => boolean} [p.exists]
 * @returns {{state: 'ok'|'unknown'|'gone', file?: string, storedCwd?: string}}
 *   `ok` the folder is there (or the backend has no such hook), `unknown` it could not be told and was not
 *   touched (no record, or a network path of a share no project is on), `gone` it does not exist.
 */
function assess({ backend, row, projectPath, exists = fs.existsSync, knownPaths = [] } = {}) {
  const hook = backend && backend.resumeCwd;
  if (!hook || typeof hook.read !== 'function') return { state: 'ok' };
  let file = null;
  try { file = typeof backend.transcriptPathFor === 'function' ? backend.transcriptPathFor(row) : null; } catch { file = null; }
  if (!file) return { state: 'unknown' };
  let storedCwd = null;
  try { storedCwd = hook.read(file); } catch { storedCwd = null; }
  if (!storedCwd) return { state: 'unknown', file };
  if (isForeignNetworkPath(storedCwd, [projectPath, ...knownPaths])) return { state: 'unknown', file, storedCwd };
  let there = true;
  try { there = !!exists(storedCwd); } catch { there = true; }
  return there ? { state: 'ok', file, storedCwd } : { state: 'gone', file, storedCwd };
}

/** What the user is told, in the refusal's text — the dialog adds the choice, a tab that cannot ask shows this. */
function goneMessage(label, storedCwd) {
  return `${label} ran this session in a folder that no longer exists: ${storedCwd}. `
    + 'Continue it in this project\'s folder, or fork a copy there.';
}

/**
 * Continue a session in `cwd`. `ref` is what the launch resumes by (the transcript), because the backend's
 * own id lookup may be tied to where the file lies.
 * @returns {{ok: true, ref: string} | {ok: false, error: string}}
 */
function continueHere({ backend, file, storedCwd, cwd }) {
  const hook = backend && backend.resumeCwd;
  if (!hook || typeof hook.continueIn !== 'function') return { ok: false, error: 'This backend cannot continue a session in another folder.' };
  // The transcript can vanish between the question and the answer; resuming a file that is not there would start
  // a different session than the one the user chose.
  if (!fs.existsSync(file)) return { ok: false, error: 'The session file is no longer there.' };
  let res;
  try { res = hook.continueIn({ file, storedCwd, cwd }); } catch { res = { ok: false, reason: 'failed' }; }
  if (!res || !res.ok) return { ok: false, error: `The session could not be moved to this folder (${(res && res.reason) || 'failed'}).` };
  return { ok: true, ref: file };
}

module.exports = { assess, goneMessage, continueHere };
