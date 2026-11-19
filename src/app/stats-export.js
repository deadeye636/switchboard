'use strict';
// stats-export.js — the Stats page's export (#877, spec 48 V10). A format and a table in, one file out.
//
// The renderer names a FORMAT, a TABLE and the filter and view it holds; it never sends rows and never a path. Main re-runs
// the query through `stats.getExportData` (the same sanitise and payload path as `stats-get`, with the full row set instead of
// the on-screen top 50), asks the native save dialog and writes through `safe-write.js` (reflex 11). The answer is
// `{ ok, canceled, error, name }`, `name` being the file's base name on success; no path and no raw error text goes back (#444).
//
// O6, display names only: every row is built field by field from the folded payload, so the session's `openPath`, a
// project's `projectPath` and the filter's `project` path cannot reach a file by accident; the project is its display name.
//
// CSV: RFC 4180 (CRLF, a header row, a field quoted when it holds a comma, a quote or a line break) with a UTF-8 byte order
// mark, so a spreadsheet reads the text as UTF-8; `writeTextFile` cannot write one, so the file goes out as bytes through
// `writeBinaryFile`. A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`
// (OWASP CSV injection); a number is never touched, so a negative one stays a number, and is written in plain decimal notation (no exponent). A missing cost is an empty cell.
// The Sessions list is cut at `sessionsCap`: when it was cut (more existed) the file name says so (`sessions-top500`), because RFC 4180 has
// no place for a note inside the data. JSON carries it as `limits.sessions`.
//
// Electron-free and db-free: the dialog, the stats module and the clock arrive through `init`.

const path = require('path');
const dialogDirs = require('./dialog-dirs');
const safeWrite = require('./safe-write');
const { readableError } = require('./readable-error');
const { localDayKey } = require('./stats');

const SCHEMA = 'switchboard.stats/1';
const TABLES = ['projects', 'models', 'backends', 'sessions'];
const FORMATS = {
  csv: { ext: 'csv', filterName: 'CSV' },
  json: { ext: 'json', filterName: 'JSON' },
};
const BOM = '﻿';
const GUARDED = /^[=+\-@\t\r]/;

let ctx = null;

function init(context) { ctx = context; }

function fail(error) { return { ok: false, canceled: false, error }; }

// --- the rows: whitelisted, display names only --------------------------------------------------------------------------

const costOf = (c) => (c && Number.isFinite(c.usd) ? { usd: c.usd, estimated: !!c.estimated } : null);

/** A stored timestamp as the LOCAL day it falls on, like `last_active` (a local day key); null when there is none or it does not parse. */
function localDayOf(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : localDayKey(d);
}

function rowsOf(table, payload) {
  if (table === 'projects') {
    return (payload.projects || []).map(r => ({ project: r.name, sessions: r.sessions, messages: r.messages, tokens: r.tokens, cost: costOf(r.cost) }));
  }
  if (table === 'models') {
    return (payload.models || []).map(r => ({
      model: r.model, sessions: r.sessions, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
      tokens: r.tokens, cost: costOf(r.cost),
    }));
  }
  if (table === 'backends') {
    return (payload.backends || []).map(r => ({
      backend: r.label, backendId: r.id, sessions: r.sessions, messages: r.messages, input: r.input, output: r.output,
      cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, tokens: r.tokens, cacheHitRate: r.cacheRate == null ? null : r.cacheRate,
      cost: costOf(r.cost),
    }));
  }
  return (payload.sessions || []).map(r => ({
    sessionId: r.sessionId, title: r.title, project: r.projectName, backend: r.backend ? r.backend.label : null,
    started: localDayOf(r.created), lastActive: r.lastDate || null, lastModel: r.lastModel,
    messages: r.messages, tokens: r.tokens, cost: costOf(r.cost),
  }));
}

/** CSV columns per table: header, and how to read the cell out of a row. A cost is two columns: the figure and whether it is an estimate. */
const costCols = [
  { h: 'cost_usd', get: r => (r.cost ? r.cost.usd : null) },
  { h: 'cost_estimated', get: r => (r.cost ? r.cost.estimated : null) },
];
const plain = (h, key) => ({ h, get: r => r[key] });
const COLUMNS = {
  projects: [plain('project', 'project'), plain('sessions', 'sessions'), plain('messages', 'messages'), plain('tokens', 'tokens'), ...costCols],
  models: [
    plain('model', 'model'), plain('sessions', 'sessions'), plain('input_tokens', 'input'), plain('output_tokens', 'output'),
    plain('cache_read_tokens', 'cacheRead'), plain('cache_write_tokens', 'cacheWrite'), plain('tokens', 'tokens'), ...costCols,
  ],
  backends: [
    plain('backend', 'backend'), plain('backend_id', 'backendId'), plain('sessions', 'sessions'), plain('messages', 'messages'),
    plain('input_tokens', 'input'), plain('output_tokens', 'output'), plain('cache_read_tokens', 'cacheRead'),
    plain('cache_write_tokens', 'cacheWrite'), plain('tokens', 'tokens'), plain('cache_hit_rate', 'cacheHitRate'), ...costCols,
  ],
  sessions: [
    plain('session_id', 'sessionId'), plain('title', 'title'), plain('project', 'project'), plain('backend', 'backend'),
    plain('started', 'started'), plain('last_active', 'lastActive'), plain('last_model', 'lastModel'),
    plain('messages', 'messages'), plain('tokens', 'tokens'), ...costCols,
  ],
};

// --- CSV --------------------------------------------------------------------------------------------------------------------

/** A number in plain decimal notation: a small cost is `0.0000001`, never `1e-7` (a spreadsheet may read that as text or a date). */
function plainNumber(n) {
  // A fraction is a sum of floats (cost): 12 significant digits drop the binary noise (0.0020870000000000003) and keep
  // every digit a price carries. A whole number (tokens, counts) is written exactly.
  const v = Number.isInteger(n) ? n : Number(n.toPrecision(12));
  const s = String(v);
  if (!/e/i.test(s)) return s;
  return v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

/** One cell. Only a STRING is guarded: a number (a negative one included) is written as it is, a missing value as nothing. */
function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? plainNumber(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = String(value);
  if (GUARDED.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(table, rows) {
  const cols = COLUMNS[table];
  const lines = [cols.map(c => csvCell(c.h)).join(',')];
  for (const r of rows) lines.push(cols.map(c => csvCell(c.get(r))).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

// --- JSON -------------------------------------------------------------------------------------------------------------------

function buildJson(data, generatedAt) {
  const { filter, payload } = data;
  const r = payload.range;
  const tables = {};
  for (const t of TABLES) tables[t] = rowsOf(t, payload);
  const doc = {
    schema: SCHEMA,
    generatedAt,
    // The filter's project is a path in the app; the file carries its display name.
    filter: { range: filter.range, backend: filter.backend, project: data.projectName, model: filter.model },
    range: { kind: r.kind, from: r.from, to: r.to, days: r.days },
    previousRange: r.prevFrom ? { from: r.prevFrom, to: r.prevTo } : null,
    keyFigures: payload.keyFigures,
    tables,
    limits: { sessions: { cap: data.sessionsCap, truncated: !!data.sessionsTruncated } },
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

// --- the handler ------------------------------------------------------------------------------------------------------------

function fileNameOf(format, table, data, truncated) {
  const r = data.payload.range;
  const span = `${r.from}_${r.to}`;
  if (format === 'json') return `switchboard-stats-${span}.json`;
  return `switchboard-stats-${table}${table === 'sessions' && truncated ? `-top${data.sessionsCap}` : ''}-${span}.csv`;
}

async function exportStats({ format, table, filter, view } = {}, event) {
  const fmt = typeof format === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, format) ? FORMATS[format] : null;
  if (!fmt) return fail('This export format is not available.');
  if (format === 'csv' && !TABLES.includes(table)) return fail('This table is not available for export.');
  if (!ctx || !ctx.stats) return fail('The statistics are not ready.');

  const data = ctx.stats.getExportData(filter, view);
  if (!data || !data.ok) return fail((data && data.error) || 'The statistics could not be read.');

  const generatedAt = (ctx.now ? ctx.now() : new Date()).toISOString();
  let text;
  let truncated = false;
  if (format === 'csv') {
    const rows = rowsOf(table, data.payload);
    truncated = !!data.sessionsTruncated;
    text = buildCsv(table, rows);
  } else {
    text = buildJson(data, generatedAt);
  }

  let parent;
  try { parent = typeof ctx.getParentWindow === 'function' && event ? ctx.getParentWindow(event.sender) : undefined; } catch { parent = undefined; }
  const picked = await ctx.dialog.showSaveDialog(parent, {
    title: 'Export statistics',
    defaultPath: dialogDirs.defaultSavePath('statsExport', fileNameOf(format, table, data, truncated)),
    filters: [{ name: fmt.filterName, extensions: [fmt.ext] }],
  });
  if (!picked || picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  dialogDirs.rememberDialogDir('statsExport', picked.filePath);

  // Bytes, not `writeTextFile`: that one writes LF and no byte order mark, and a CSV wants both CRLF and the mark.
  const res = safeWrite.writeBinaryFile(picked.filePath, Buffer.from(text, 'utf8'));
  if (!res.ok) {
    if (ctx.log && ctx.log.warn) ctx.log.warn(`[stats-export] write refused: ${res.code}`);
    return fail(readableError(res.cause, 'The file could not be written.', ctx.log));
  }
  return { ok: true, canceled: false, name: path.basename(picked.filePath) };
}

/** @param {Electron.IpcMain} ipc */
function registerIpc(ipc) {
  ipc.handle('stats-export', (event, req) => exportStats(req || {}, event));
}

module.exports = { init, registerIpc, exportStats, csvCell, buildCsv, buildJson, rowsOf, SCHEMA, TABLES, FORMATS };
