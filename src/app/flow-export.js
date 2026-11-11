'use strict';
// flow-export.js — the Flow tab's export (spec 46, #826, plan T17). A session id and a format in, one file out.
//
// The renderer names a SESSION and a FORMAT, never a path and never a snapshot: main re-reads the transcript through
// session-flow's worker path (so the file holds a fresh, complete read and not the renderer's held copy), asks the
// user for a place with the native save dialog, and writes through `safe-write.js` (reflex 11). The answer is
// `{ ok, canceled, error }`, with `name` (the file's base name) on success so the renderer can word a toast. No
// path and no raw error text goes back (#444).
//
// FORMATS is the one table a new format joins: SVG, PDF and Mermaid (T18-T20) add an entry with their extension and a
// `build(snapshot, meta)` that answers the file's text. PDF is the one `binary` entry: its `build` is async and answers
// bytes, it runs AFTER the save dialog (a cancel costs nothing), and only one runs at a time. An unknown format is refused before any dialog opens.
//
// WHAT THE JSON HOLDS: `{ exportVersion, exportedAt, app, snapshot }`, the snapshot being the validated neutral
// `FlowSnapshot` and nothing else: no `sources`, no transcript path, no fingerprint (its size and mtime describe a
// file on this machine), no vendor record. Step labels and details are the session's own text and may hold prompts,
// commands and local paths; that is why the renderer asks before it calls this.

const path = require('path');
const sessionFlow = require('./session-flow');
const { renderFlowSvg } = require('./flow-svg');
const { renderFlowMermaid } = require('./flow-mermaid');
const flowPages = require('./flow-pages');
const flowPdf = require('./flow-pdf');
const dialogDirs = require('./dialog-dirs');
const safeWrite = require('./safe-write');
const { validateSnapshot } = require('../shared/flow-snapshot');

const EXPORT_VERSION = 1;
const APP_NAME = 'Switchboard';

const FORMATS = {
  json: {
    ext: 'json',
    filterName: 'JSON',
    build(snapshot, meta) {
      // `sources` are absolute transcript paths; the fingerprint is the size, mtime and head hash of a local file. Neither is part of the neutral shape.
      const { sources, ...rest } = snapshot;
      const neutral = { ...rest, fingerprint: null };
      return JSON.stringify({
        exportVersion: EXPORT_VERSION,
        exportedAt: meta.exportedAt,
        app: { name: APP_NAME, version: meta.appVersion },
        snapshot: neutral,
      }, null, 2) + '\n';
    },
  },
  svg: {
    ext: 'svg',
    filterName: 'SVG',
    build: (snapshot, meta) => renderFlowSvg(snapshot, meta),
  },
  mermaid: {
    ext: 'mmd',
    filterName: 'Mermaid',
    build: (snapshot, meta) => renderFlowMermaid(snapshot, meta),
  },
  pdf: {
    ext: 'pdf',
    filterName: 'PDF',
    binary: true,
    async build(snapshot, meta) {
      const { pages } = flowPages.buildPages(snapshot, meta);
      const createWindow = ctx.createPdfWindow || (ctx.BrowserWindow ? flowPdf.makeWindowFactory(ctx.BrowserWindow) : null);
      if (!createWindow) throw Object.assign(new Error('print'), { code: 'print' });
      return flowPdf.htmlToPdf(flowPages.renderHtml(pages), { createWindow, tempDir: ctx.tempDir, timeoutMs: ctx.pdfTimeoutMs });
    },
  },
};
Object.freeze(FORMATS);

let ctx = null;

function init(context) { ctx = context; }

function fail(error) { return { ok: false, canceled: false, error }; }

/** Distinct from any window's own key in session-flow, so an export never supersedes or is superseded by a view's read. */
const senderKeyOf = (event) => -(((event && event.sender && event.sender.id) || 0) + 1);

const MAX_LABEL = 80;
/** The backend name the view hands over: a string, trimmed, control characters dropped, capped; anything else is no label. */
function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim()).slice(0, MAX_LABEL).join('').trim();
}

let pdfBusy = false;

async function exportFlow({ sessionId, format, backendLabel } = {}, event) {
  const fmt = typeof format === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, format) ? FORMATS[format] : null;
  if (!fmt) return fail('This export format is not available.');
  if (!ctx || typeof sessionId !== 'string' || !sessionId) return fail('This session is not known.');
  if (!fmt.binary) return runExport(fmt, { sessionId, backendLabel }, event);
  // One PDF at a time: a print holds a window and the whole page text in memory.
  if (pdfBusy) return fail('Another PDF export is still running. Try again when it has finished.');
  pdfBusy = true;
  try { return await runExport(fmt, { sessionId, backendLabel }, event); } finally { pdfBusy = false; }
}

async function runExport(fmt, { sessionId, backendLabel }, event) {

  const read = ctx.readFlow || sessionFlow.getSessionFlow;
  let snapshot = null;
  try { snapshot = await read(sessionId, senderKeyOf(event), { remember: false }); } catch { snapshot = null; }
  // A newer read of the same key, or a quit, ended this one; the window that asked may be gone too. Neither is a failure to word.
  if (snapshot && Array.isArray(snapshot.limitations) && snapshot.limitations.some(l => l && l.id === 'read-cancelled')) return { ok: false, canceled: true };
  if (event && event.sender && typeof event.sender.isDestroyed === 'function' && event.sender.isDestroyed()) return { ok: false, canceled: true };
  if (!snapshot || !Array.isArray(snapshot.steps) || !snapshot.steps.length) return fail('There is no flow to export for this session.');
  const checked = validateSnapshot(snapshot);
  if (!checked.ok) return fail('The flow could not be validated, so nothing was written.');

  const meta = {
    exportedAt: new Date().toISOString(),
    sessionId,
    backendLabel: cleanLabel(backendLabel),
    appVersion: typeof ctx.getAppVersion === 'function' ? ctx.getAppVersion() : '',
  };
  const text = fmt.binary ? null : fmt.build(snapshot, meta);

  let parent;
  try { parent = typeof ctx.getParentWindow === 'function' && event ? ctx.getParentWindow(event.sender) : undefined; } catch { parent = undefined; }
  const picked = await ctx.dialog.showSaveDialog(parent, {
    title: 'Export flow',
    defaultPath: dialogDirs.defaultSavePath('flowExport', `${sessionId.slice(0, 8)}-flow.${fmt.ext}`),
    filters: [{ name: fmt.filterName, extensions: [fmt.ext] }],
  });
  if (!picked || picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  dialogDirs.rememberDialogDir('flowExport', picked.filePath);

  let res;
  if (fmt.binary) {
    let bytes = null;
    try { bytes = await fmt.build(snapshot, meta); } catch (err) {
      if (ctx.log && ctx.log.warn) ctx.log.warn(`[flow-export] pdf failed: ${err && err.code ? err.code : 'unknown'}`);
      return fail(err && err.code === 'timeout' ? 'The PDF took too long to create, so nothing was written.' : 'The PDF could not be created.');
    }
    res = safeWrite.writeBinaryFile(picked.filePath, bytes);
  } else {
    res = safeWrite.writeTextFile(picked.filePath, text, { mustExist: false, keepEncoding: false });
  }
  if (!res.ok) {
    if (ctx.log && ctx.log.warn) ctx.log.warn(`[flow-export] write refused: ${res.code}`);
    return fail('The file could not be written.');
  }
  return { ok: true, canceled: false, name: path.basename(picked.filePath) };
}

/** @param {Electron.IpcMain} ipc */
function registerIpc(ipc) {
  ipc.handle('flow-export', (event, req) => exportFlow(req || {}, event));
}

module.exports = { init, registerIpc, exportFlow, FORMATS, EXPORT_VERSION };
