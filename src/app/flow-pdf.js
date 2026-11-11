'use strict';
// flow-pdf.js — prints the Flow export's static HTML to PDF bytes in a hidden window (spec 46, #826, plan T19).
// `flow-export.js` is the only caller; it hands over the HTML from `flow-pages.js` and a window factory.
//
// THE WINDOW. Never shown, with `sandbox`, `contextIsolation`, no Node, no preload and `javascript: false`: the page is
// static SVG and has nothing to run, and a script that slipped in would not execute. Navigation and new windows are
// refused. The HTML goes to `page.html` in a fresh directory of ours under the system temp directory (never the project)
// because a data URL is capped near 2 MB by Chromium and a long flow is several times that. The directory is removed when
// the print ends, however it ends, and by `destroyPending()` at quit. It is written with plain `fs` and the flag `wx` on
// purpose (CLAUDE.md reflex 11): no CLI reads this file, nobody else writes it, and the directory is new, so there is
// no baseline to protect and nothing to rename over; `safe-write.js` would add nothing but a second temp file.
//
// ENDS. The window is destroyed on success, on failure and on the timeout (60 s by default), and `destroyPending()`
// destroys one that is still alive when the app quits. At most one print runs at a time; that gate lives in
// `flow-export.js`, which owns the "one PDF export at a time" answer.
//
// Electron arrives through the factory (`makeWindowFactory(BrowserWindow)`), so `node --test` drives this with a fake.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 60000;

/** The prints alive right now (at most one in practice): `{ win, dir }`. `destroyPending` empties it on quit. */
const pending = new Set();

function makeWindowFactory(BrowserWindow) {
  return () => {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true },
    });
    const wc = win.webContents;
    try { wc.setWindowOpenHandler(() => ({ action: 'deny' })); } catch { /* a window that is already going away */ }
    try { wc.on('will-navigate', (e) => e.preventDefault()); } catch { /* same */ }
    return win;
  };
}

function destroyWindow(win) {
  try { if (win && !(typeof win.isDestroyed === 'function' && win.isDestroyed())) win.destroy(); } catch { /* already gone */ }
}

/** Destroys the window and removes the temp directory. Synchronous, so it may run inside the quit teardown. */
function release(entry) {
  pending.delete(entry);
  destroyWindow(entry.win);
  if (entry.dir) { try { fs.rmSync(entry.dir, { recursive: true, force: true }); } catch { /* ours; a leftover is only a temp file */ } }
}

function destroyPending() {
  for (const entry of Array.from(pending)) release(entry);
}

/**
 * @param {string} html the document to print
 * @param {{ createWindow: () => any, tempDir?: string, timeoutMs?: number }} deps
 * @returns {Promise<Buffer>} the PDF bytes; rejects with `code: 'timeout' | 'write' | 'print'` after cleaning up
 */
async function htmlToPdf(html, deps) {
  const { createWindow } = deps;
  const timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const entry = { win: null, dir: null };
  let timer = null;
  try {
    try {
      entry.dir = fs.mkdtempSync(path.join(deps.tempDir || os.tmpdir(), 'switchboard-flow-'));
      pending.add(entry);
      fs.writeFileSync(path.join(entry.dir, 'page.html'), html, { encoding: 'utf8', flag: 'wx' });
    } catch (err) { throw Object.assign(new Error('write'), { code: 'write', cause: err }); }
    const file = path.join(entry.dir, 'page.html');
    const win = createWindow();
    entry.win = win;
    const work = (async () => {
      await win.loadFile(file);
      return win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' }, preferCSSPageSize: true });
    })();
    work.catch(() => { /* a print that ends after the timeout has no one left to tell */ });
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs);
    });
    return await Promise.race([work, limit]);
  } catch (err) {
    if (err && (err.code === 'timeout' || err.code === 'write')) throw err;
    throw Object.assign(new Error('print'), { code: 'print', cause: err });
  } finally {
    if (timer) clearTimeout(timer);
    release(entry);
  }
}

module.exports = { htmlToPdf, makeWindowFactory, destroyPending, DEFAULT_TIMEOUT_MS };
