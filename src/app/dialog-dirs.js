'use strict';
// Where a native file dialog opens (#843).
//
// Up to Electron 42 the operating system remembered the last folder a dialog opened, so a dialog shown without a
// `defaultPath` came back where the user left it. Since Electron 43 such a dialog opens in Downloads (or the home
// directory) every time. The app therefore remembers the folder itself, per kind of dialog, in the settings table
// under `lastDialogDir` — an internal key, not a user setting, so it is neither in the settings screen nor in a
// settings export (that carries the `global` blob only).
//
// A remembered folder is handed back only while it still exists, and never when it is spelled as a network path:
// stating `\\host\share` would be a connection to that host before the user did anything (the #780 class). Such a
// dialog then opens where Electron decides, which is what it did before this module. A mapped network DRIVE
// (`Z:\`) is spelled like a local one and is stated; the user picked it, and the dialog would touch it anyway.
//
// Electron-free and DB-free: the settings accessors arrive through `init`.

const fs = require('fs');
const path = require('path');
const { networkShareOf } = require('./network-path');

const KEY = 'lastDialogDir';

let ctx = null;

/**
 * @param {object} context
 * @param {(key: string) => any} context.getSetting
 * @param {(key: string, value: any) => void} context.setSetting
 * @param {object} [context.log]
 */
function init(context) {
  ctx = context;
}

function readAll() {
  try {
    const map = ctx && ctx.getSetting ? ctx.getSetting(KEY) : null;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch { return {}; }
}

/** The folder a dialog of this kind opened last, or `undefined` when there is none to use. */
function lastDialogDir(kind) {
  const dir = readAll()[kind];
  if (typeof dir !== 'string' || !dir || networkShareOf(dir)) return undefined;
  try { return fs.statSync(dir).isDirectory() ? dir : undefined; } catch { return undefined; }
}

/** A `defaultPath` for a save dialog: the file name inside the remembered folder, or the bare name. */
function defaultSavePath(kind, fileName) {
  const dir = lastDialogDir(kind);
  return dir ? path.join(dir, fileName) : fileName;
}

/**
 * Remember where the user went. `chosen` is what the dialog answered: a folder for a folder picker, a file
 * otherwise, whose folder is kept. Nothing is written for a cancelled dialog or an empty answer.
 */
function rememberDialogDir(kind, chosen, isDirectory = false) {
  if (typeof chosen !== 'string' || !chosen) return;
  const dir = isDirectory ? chosen : path.dirname(chosen);
  const all = readAll();
  if (all[kind] === dir) return;
  try { ctx.setSetting(KEY, { ...all, [kind]: dir }); } catch (err) {
    if (ctx.log && ctx.log.warn) ctx.log.warn(`[dialog-dirs] could not remember the folder: ${err.code || 'error'}`);
  }
}

module.exports = { init, lastDialogDir, defaultSavePath, rememberDialogDir, KEY };
