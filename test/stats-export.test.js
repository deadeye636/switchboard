'use strict';
// src/app/stats-export.js (#877, spec 48 V10): the file's bytes, the O6 rule and the dialog answers, with a fake stats module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const exporter = require('../src/app/stats-export');
const dialogDirs = require('../src/app/dialog-dirs');

const LOCAL = '/home/someone/work/proj-a';
const log = { warn() {}, debug() {}, error() {} };

function payload(over = {}) {
  return {
    range: { kind: '30d', from: '2026-10-01', to: '2026-10-30', days: 30, prevFrom: '2026-09-01', prevTo: '2026-09-30', includesToday: true },
    keyFigures: { cur: { sessions: 2, cost: { usd: 1.5, estimated: true } }, prev: null, change: {}, cacheExcluded: [] },
    projects: [
      { projectPath: LOCAL, name: 'proj-a', selectable: true, sessions: 2, messages: 5, tokens: -3, cost: { usd: 1.5, estimated: false } },
      { projectPath: '', name: '=cmd()', selectable: false, sessions: 1, messages: 1, tokens: 10, cost: null },
    ],
    models: [{ model: 'm,1', selectable: true, sessions: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tokens: 3, cost: null }],
    backends: [{ id: 'alpha', label: 'Alpha', colour: 'c', icon: 'i', selectable: true, sessions: 1, messages: 2, tokens: 3, input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: null, cacheRate: 0.5 }],
    sessions: [
      { sessionId: 's1', title: '+1 "quoted"\nline', projectPath: LOCAL, projectName: 'proj-a', openPath: LOCAL + '/wt', openable: true,
        backend: { id: 'alpha', label: 'Alpha' }, created: new Date(2026, 9, 2, 23, 30).toISOString(), lastDate: '2026-10-03', lastModel: '@m', messages: 3, tokens: 4, cost: null },
      { sessionId: 's2', title: '-x', projectPath: LOCAL, projectName: 'proj-a', openPath: LOCAL, backend: null, created: null, lastDate: null, lastModel: null, messages: 0, tokens: 0, cost: { usd: 0.25, estimated: true } },
    ],
    ...over,
  };
}

function setup({ canceled = false, pickedName = 'out.csv', data, writeDir } = {}) {
  const dir = writeDir || fs.mkdtempSync(path.join(os.tmpdir(), 'stats-export-'));
  const calls = { dialog: [], asked: [] };
  const store = {};
  dialogDirs.init({ getSetting: (k) => store[k], setSetting: (k, v) => { store[k] = v; }, log });
  exporter.init({
    log,
    now: () => new Date('2026-10-30T12:00:00Z'),
    getParentWindow: () => null,
    stats: { getExportData: (f, v) => { calls.asked.push([f, v]); return data || { ok: true, filter: { range: { kind: '30d' }, backend: null, project: LOCAL, model: null }, view: {}, payload: payload(), projectName: 'proj-a', sessionsCap: 500 }; } },
    dialog: { showSaveDialog: async (parent, opts) => { calls.dialog.push(opts); return canceled ? { canceled: true } : { canceled: false, filePath: path.join(dir, pickedName) }; } },
  });
  return { dir, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('csvCell: RFC 4180 quoting for comma, quote and line breaks', () => {
  assert.equal(exporter.csvCell('a,b'), '"a,b"');
  assert.equal(exporter.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(exporter.csvCell('l1\nl2'), '"l1\nl2"');
  assert.equal(exporter.csvCell('plain'), 'plain');
});

test('csvCell: the formula guard covers text cells, not numbers', () => {
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) assert.ok(exporter.csvCell(lead + 'x').replace(/^"/, '').startsWith("'" + lead), JSON.stringify(lead));
  assert.equal(exporter.csvCell(-5), '-5');
  assert.equal(exporter.csvCell(0.25), '0.25');
  assert.equal(exporter.csvCell(null), '');
  assert.equal(exporter.csvCell(undefined), '');
});

test('csv: BOM, CRLF, header, missing cost is an empty cell, never 0', async () => {
  const s = setup();
  try {
    const res = await exporter.exportStats({ format: 'csv', table: 'projects', filter: {}, view: {} }, { sender: { id: 1 } });
    assert.deepEqual(res, { ok: true, canceled: false, name: 'out.csv' });
    const buf = fs.readFileSync(path.join(s.dir, 'out.csv'));
    assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    const lines = buf.toString('utf8').slice(1).split('\r\n');
    assert.equal(lines[0], 'project,sessions,messages,tokens,cost_usd,cost_estimated');
    assert.equal(lines[1], 'proj-a,2,5,-3,1.5,false');
    assert.equal(lines[2], "'=cmd(),1,1,10,,");
    assert.equal(lines[3], '');
    assert.match(path.basename(s.calls.dialog[0].defaultPath), /^switchboard-stats-projects-2026-10-01_2026-10-30\.csv$/);
  } finally { s.cleanup(); }
});

test('csv: the sessions table carries titles guarded and quoted, dates as day keys, and no path', async () => {
  const s = setup({ pickedName: 's.csv' });
  try {
    await exporter.exportStats({ format: 'csv', table: 'sessions' }, null);
    const text = fs.readFileSync(path.join(s.dir, 's.csv'), 'utf8');
    assert.ok(text.includes('"\'+1 ""quoted""\nline"'));
    assert.ok(text.includes(',2026-10-02,2026-10-03,\'@m,'));
    assert.ok(text.includes("s2,'-x,proj-a,,,,"));
    assert.ok(!text.includes(LOCAL) && !text.includes('/wt'));
  } finally { s.cleanup(); }
});

test('a full sessions list says so in the file name', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ sessionId: 's' + i, title: 't', projectName: 'p', backend: null, messages: 1, tokens: 1, cost: null }));
  const s = setup({ data: { ok: true, filter: { range: { kind: '30d' } }, view: {}, payload: payload({ sessions: rows }), projectName: null, sessionsCap: 3, sessionsTruncated: true } });
  try {
    await exporter.exportStats({ format: 'csv', table: 'sessions' }, null);
    assert.match(path.basename(s.calls.dialog[0].defaultPath), /^switchboard-stats-sessions-top3-2026-10-01_2026-10-30\.csv$/);
  } finally { s.cleanup(); }
});

test('exactly the cap is not marked as cut, in the file name or in the JSON', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ sessionId: 's' + i, title: 't', projectName: 'p', backend: null, messages: 1, tokens: 1, cost: null }));
  const s = setup({ data: { ok: true, filter: { range: { kind: '30d' } }, view: {}, payload: payload({ sessions: rows }), projectName: null, sessionsCap: 3, sessionsTruncated: false } });
  try {
    await exporter.exportStats({ format: 'csv', table: 'sessions' }, null);
    assert.match(path.basename(s.calls.dialog[0].defaultPath), /^switchboard-stats-sessions-2026-10-01_2026-10-30\.csv$/);
  } finally { s.cleanup(); }
});

test('started is a local day key, like last_active', () => {
  const local = new Date(2026, 9, 2, 23, 30);   // late evening: the UTC date differs in a zone east of Greenwich
  const [row] = exporter.rowsOf('sessions', { sessions: [{ sessionId: 's', created: local.toISOString(), lastDate: '2026-10-03', cost: null }] });
  assert.equal(row.started, '2026-10-02');
  assert.equal(exporter.rowsOf('sessions', { sessions: [{ sessionId: 's', created: 'garbage' }] })[0].started, null);
  assert.equal(exporter.rowsOf('sessions', { sessions: [{ sessionId: 's', created: null }] })[0].started, null);
});

test('csv numbers are plain decimals, JSON keeps the number as it is', () => {
  assert.equal(exporter.csvCell(1e-7), '0.0000001');
  // A summed cost carries binary noise; 12 significant digits drop it, a whole number stays exact.
  assert.equal(exporter.csvCell(0.0020870000000000003), '0.002087');
  assert.equal(exporter.csvCell(0.1 + 0.2), '0.3');
  assert.equal(exporter.csvCell(12345678901234), '12345678901234');
  assert.equal(exporter.csvCell(-2.5e-7), '-0.00000025');
  assert.equal(exporter.csvCell(1.5e21), '1500000000000000000000');
  assert.ok(!/e/i.test(exporter.csvCell(0.000001234)));
  assert.equal(exporter.csvCell(12.5), '12.5');
  const doc = JSON.parse(exporter.buildJson({ filter: { range: {} }, payload: payload({ projects: [{ name: 'p', sessions: 1, messages: 1, tokens: 1, cost: { usd: 1e-7, estimated: false } }] }), sessionsCap: 500, sessionsTruncated: false }, 'now'));
  assert.equal(doc.tables.projects[0].cost.usd, 1e-7);
});

test('json: the schema shape, cost objects or null, project as display name, no local path', async () => {
  const s = setup({ pickedName: 'o.json' });
  try {
    const res = await exporter.exportStats({ format: 'json', filter: {}, view: {} }, null);
    assert.equal(res.ok, true);
    const text = fs.readFileSync(path.join(s.dir, 'o.json'), 'utf8');
    assert.ok(!text.includes(LOCAL) && !text.includes('openPath') && !text.includes('projectPath'));
    const doc = JSON.parse(text);
    assert.equal(doc.schema, 'switchboard.stats/1');
    assert.equal(doc.generatedAt, '2026-10-30T12:00:00.000Z');
    assert.equal(doc.filter.project, 'proj-a');
    assert.deepEqual(doc.range, { kind: '30d', from: '2026-10-01', to: '2026-10-30', days: 30 });
    assert.deepEqual(doc.previousRange, { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(Object.keys(doc.tables), ['projects', 'models', 'backends', 'sessions']);
    assert.deepEqual(doc.tables.projects[0].cost, { usd: 1.5, estimated: false });
    assert.equal(doc.tables.projects[1].cost, null);
    assert.equal(doc.tables.sessions[0].started, '2026-10-02');
    assert.deepEqual(doc.limits.sessions, { cap: 500, truncated: false });
    assert.equal(path.basename(s.calls.dialog[0].defaultPath), 'switchboard-stats-2026-10-01_2026-10-30.json');
  } finally { s.cleanup(); }
});

test('the filter and view go to main as given, and a bad format or table is refused before any dialog', async () => {
  const s = setup();
  try {
    await exporter.exportStats({ format: 'csv', table: 'models', filter: { a: 1 }, view: { b: 2 } }, null);
    assert.deepEqual(s.calls.asked[0], [{ a: 1 }, { b: 2 }]);
    s.calls.dialog.length = 0;
    assert.equal((await exporter.exportStats({ format: 'xml', table: 'models' }, null)).ok, false);
    assert.equal((await exporter.exportStats({ format: 'csv', table: 'nope' }, null)).ok, false);
    assert.equal(s.calls.dialog.length, 0);
  } finally { s.cleanup(); }
});

test('a canceled dialog writes nothing and says canceled', async () => {
  const s = setup({ canceled: true });
  try {
    const res = await exporter.exportStats({ format: 'json' }, null);
    assert.deepEqual(res, { ok: false, canceled: true });
    assert.deepEqual(fs.readdirSync(s.dir), []);
  } finally { s.cleanup(); }
});

test('a write error is translated, the raw message and the path never come back', async () => {
  const s = setup({ pickedName: 'blocker/out.csv' });
  try {
    fs.writeFileSync(path.join(s.dir, 'blocker'), 'a file where the folder should be');
    const res = await exporter.exportStats({ format: 'csv', table: 'models' }, null);
    assert.equal(res.ok, false);
    assert.equal(res.canceled, false);
    assert.ok(res.error.startsWith('The file could not be written.'));
    assert.ok(!res.error.includes(s.dir) && !/ENOENT|EISDIR|EEXIST|ENOTDIR/.test(res.error));
  } finally { s.cleanup(); }
});

test('a failed query answers its own sentence and opens no dialog', async () => {
  const s = setup({ data: { ok: false, error: 'The statistics could not be read.' } });
  try {
    const res = await exporter.exportStats({ format: 'json' }, null);
    assert.deepEqual(res, { ok: false, canceled: false, error: 'The statistics could not be read.' });
    assert.equal(s.calls.dialog.length, 0);
  } finally { s.cleanup(); }
});

test('the dialog folder is remembered under its own kind', async () => {
  const s = setup();
  try {
    await exporter.exportStats({ format: 'csv', table: 'projects' }, null);
    assert.equal(dialogDirs.lastDialogDir('statsExport'), s.dir);
    assert.equal(dialogDirs.lastDialogDir('flowExport'), undefined);
  } finally { s.cleanup(); }
});
