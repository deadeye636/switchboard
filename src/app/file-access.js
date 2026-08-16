/**
 * file-access.js — can this file be written? (#281)
 *
 * The internal viewer pins a file it cannot write to the read-only preview and
 * drops its save button. Every viewer reaches this through one handler rather
 * than through each read path's payload: the panel opens files that arrive from
 * four different readers (plans, memory, work files, the file panel), three of
 * which return a bare string, and a viewer that had to be told by its caller
 * would be read-only only where someone remembered to pass it.
 *
 * A missing file counts as writable — it is about to be created, not protected.
 * Anything the check cannot answer counts as writable too: the job here is to
 * avoid a save button that cannot work, not to guess at permissions, and a false
 * read-only would lock an editable file out of its editor.
 */

'use strict';

const fs = require('fs');

// EACCES is the POSIX answer, EPERM the one Windows gives for the read-only
// attribute. Everything else — ENOENT above all — is not a permission problem.
const DENIED = new Set(['EACCES', 'EPERM']);

function isReadOnly(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return false;
  } catch (err) {
    return DENIED.has(err && err.code);
  }
}

function registerIpc(ipcMain) {
  ipcMain.handle('is-file-read-only', (_event, filePath) => isReadOnly(filePath));
}

module.exports = { isReadOnly, registerIpc };
