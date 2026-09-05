'use strict';
// #468 — a handoff is a file in its project. What is guarded here is what a row became: the file's
// format, the name it is written under, and the one-way trip out of the database.
//
// The module is Electron-free (ctx carries everything main.js owns), so it runs under `node --test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handoffs = require('../src/app/handoffs');
const {
  _parseHeader: parseHeader,
  _handoffFilename: handoffFilename,
  _handoffFileText: handoffFileText,
} = handoffs;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A ctx with one visible project and no backends — enough for everything below. */
function contextFor(projectPath, { legacy = [], settings = {} } = {}) {
  const dropped = { value: false };
  // A live copy: `deleteLegacyHandoff` removes from it exactly as the real store deletes the row, so a
  // second `init()` sees what the first one left behind rather than the original list again.
  const rows = [...legacy];
  return {
    ctx: {
      backends: { list: () => [] },
      db: {
        getProjectStates: () => new Map([[projectPath, { registered: true }]]),
        getProjectDisplayNames: () => new Map(),
        readLegacyHandoffs: () => [...rows],
        deleteLegacyHandoff: (id) => {
          const i = rows.findIndex(r => r.id === id);
          if (i >= 0) rows.splice(i, 1);
        },
        dropLegacyHandoffTable: () => { dropped.value = true; return true; },
      },
      log: noopLog,
      effectiveSettings: () => settings,
    },
    dropped,
    rows,
  };
}

function tempProject(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

test('the header block carries what the row used to hold', () => {
  const header = parseHeader(['', '> created: 2026-08-24T09:00:00Z · backend: codex', '', 'body text']);
  assert.equal(header.created, '2026-08-24T09:00:00Z');
  assert.equal(header.backend, 'codex');
});

test('a file with no header block is still a handoff', () => {
  // A packet a handoff skill wrote before Switchboard knew about any of this has no header. It must not
  // be excluded — the filesystem answers the date and nothing answers the backend.
  assert.deepEqual(parseHeader(['Just prose, no header.', '> not: reached']), {});
});

test('the filename is dated, slugged, and never collides', () => {
  const first = handoffFilename('Tariff end date · 24.08. 09:12', '2026-08-24T09:12:00Z', []);
  assert.equal(first, '2026-08-24-tariff-end-date-24-08-09-12.md');
  const second = handoffFilename('Tariff end date · 24.08. 09:12', '2026-08-24T09:12:00Z', [first]);
  assert.equal(second, '2026-08-24-tariff-end-date-24-08-09-12-2.md');
  // Nothing may depend on the name, so a label with nothing usable in it still produces one.
  assert.equal(handoffFilename('····', '2026-08-24T09:12:00Z', []), '2026-08-24-handoff.md');
});

test('the file leads with its heading and its header, then the packet', () => {
  const text = handoffFileText('Tariff end date', '## State\n\nHalf done.\n', '2026-08-24T09:00:00Z', 'claude');
  assert.equal(text.split('\n')[0], '# Tariff end date');
  assert.match(text, /^> created: 2026-08-24T09:00:00Z · backend: claude$/m);
  assert.match(text, /## State/);
  assert.ok(text.endsWith('\n'), 'a file a CLI reads ends with a newline');
});

test('a packet whose backend is unknown says nothing rather than guessing one', () => {
  const text = handoffFileText('Packet', 'body', '2026-08-24T09:00:00Z', null);
  assert.match(text, /^> created: 2026-08-24T09:00:00Z$/m);
  assert.ok(!/backend:/.test(text));
});

test('saving writes into the project, and reading it back finds it', () => {
  const project = tempProject('sb-handoff-');
  const { ctx } = contextFor(project);
  handoffs.init(ctx);

  const saved = handoffs.saveHandoff({
    projectPath: project, label: 'Tariff end date', content: 'Half done.', backendId: 'codex',
  });
  assert.equal(saved.ok, true);
  assert.equal(path.dirname(saved.filePath), path.join(project, '.handoffs'));

  const rows = handoffs.getHandoffs(project);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Tariff end date');
  assert.equal(rows[0].backendId, 'codex');
  assert.equal(rows[0].projectPath, project);
  assert.match(rows[0].content, /Half done\./);

  fs.rmSync(project, { recursive: true, force: true });
});

test('a directory outside the project is refused, whoever picked it', () => {
  const project = tempProject('sb-handoff-out-');
  const { ctx } = contextFor(project);
  handoffs.init(ctx);
  const res = handoffs.saveHandoff({
    projectPath: project, label: 'Escape', content: 'x', dir: os.tmpdir(),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /inside its project/);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a path outside a handoff directory can be neither read nor deleted', () => {
  const project = tempProject('sb-handoff-guard-');
  const stray = path.join(project, 'README.md');
  fs.writeFileSync(stray, '# not a handoff\n');
  const { ctx } = contextFor(project);
  handoffs.init(ctx);

  assert.equal(handoffs.readHandoff(stray).filePath, '');
  assert.equal(handoffs.deleteHandoff(stray).ok, false);
  assert.ok(fs.existsSync(stray), 'the refused delete left the file alone');
  fs.rmSync(project, { recursive: true, force: true });
});

test('the project decides where its packets are read from', () => {
  const project = tempProject('sb-handoff-dirs-');
  fs.mkdirSync(path.join(project, 'docs', 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'handoffs', 'x.md'), '# From a skill\n\nbody\n');
  const { ctx } = contextFor(project, { settings: { handoffDirNames: ['docs/handoffs'] } });
  handoffs.init(ctx);

  const rows = handoffs.getHandoffs(project);
  assert.deepEqual(rows.map(r => r.title), ['From a skill']);
  assert.equal(rows[0].sourceDir, 'docs/handoffs');
  fs.rmSync(project, { recursive: true, force: true });
});

test('every old row becomes a file, and only then does the table go', () => {
  const project = tempProject('sb-handoff-migrate-');
  const { ctx, dropped } = contextFor(project, {
    legacy: [
      { id: 1, projectPath: project, label: 'First', content: 'one', createdAt: '2026-08-01T10:00:00Z', backendId: 'claude' },
      { id: 2, projectPath: project, label: 'Second', content: 'two', createdAt: '2026-08-02T10:00:00Z', backendId: null },
    ],
  });
  handoffs.init(ctx);

  assert.equal(dropped.value, true, 'the table is dropped once every row is on disk');
  const rows = handoffs.getHandoffs(project);
  assert.deepEqual(rows.map(r => r.title).sort(), ['First', 'Second']);
  assert.equal(rows.find(r => r.title === 'First').backendId, 'claude');
  assert.equal(rows.find(r => r.title === 'Second').backendId, null);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a stuck row does not make every other packet be written again', () => {
  // The first version exported the whole batch on every start until all of it had landed, so one row
  // with a missing project directory meant every OTHER row was written again — under a `-2`, `-3`, …
  // name — each time the app started. Silent duplication in somebody's project.
  const project = tempProject('sb-handoff-again-');
  const gone = path.join(project, 'gone');
  const { ctx, dropped, rows } = contextFor(project, {
    legacy: [
      { id: 1, projectPath: project, label: 'Exportable', content: 'one', createdAt: '2026-08-01T10:00:00Z' },
      { id: 2, projectPath: gone, label: 'Orphan', content: 'two', createdAt: '2026-08-02T10:00:00Z' },
    ],
  });

  handoffs.init(ctx);
  handoffs.init(ctx);   // a second start, with the orphan still stuck
  handoffs.init(ctx);   // and a third

  const written = handoffs.getHandoffs(project).filter(h => h.title === 'Exportable');
  assert.equal(written.length, 1, 'the exported packet was written once, not once per start');
  assert.deepEqual(rows.map(r => r.id), [2], 'the exported row is gone; the stuck one waits');
  assert.equal(dropped.value, false, 'and the table stays while anything is left in it');
  fs.rmSync(project, { recursive: true, force: true });
});

test('a save says when the directory it landed in would be committed', () => {
  const project = tempProject('sb-handoff-ignore-');
  fs.mkdirSync(path.join(project, '.git'));
  const { ctx } = contextFor(project);
  handoffs.init(ctx);

  const warned = handoffs.saveHandoff({ projectPath: project, label: 'Packet', content: 'body' });
  assert.equal(warned.ok, true);
  assert.match(warned.note, /not ignored by version control/);

  // …and says nothing once the directory is ignored, or the project has no version control at all.
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n.handoffs\n');
  const quiet = handoffs.saveHandoff({ projectPath: project, label: 'Second', content: 'body' });
  assert.equal(quiet.ok, true);
  assert.equal(quiet.note, null);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a row whose project is gone keeps the table alive', () => {
  const project = tempProject('sb-handoff-orphan-');
  const missing = path.join(project, 'gone');
  const { ctx, dropped } = contextFor(project, {
    legacy: [{ id: 1, projectPath: missing, label: 'Orphan', content: 'x', createdAt: '2026-08-01T10:00:00Z' }],
  });
  handoffs.init(ctx);

  // Nothing is discarded and nothing is invented: the packet waits for its folder to come back.
  assert.equal(dropped.value, false);
  assert.ok(!fs.existsSync(missing), 'a missing project directory is not created to hold a packet');
  fs.rmSync(project, { recursive: true, force: true });
});

// --- #577: one clock, and it is the file's ---------------------------------------------------------

/** Write a packet and give it the mtime it is supposed to have — the whole point of the set below. */
function packet(dir, name, body, mtimeIso) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body);
  const when = new Date(mtimeIso);
  fs.utimesSync(filePath, when, when);
  return filePath;
}

/**
 * A MIXED set, because the defect only shows in one: a header newer than the mtime, a mtime newer than
 * the header, and a file with no header at all. Ordered by the header the first two come back the other
 * way round, and the third one is sorted against them by a different clock entirely.
 */
function mixedProject() {
  const project = tempProject('sb-handoff-order-');
  const dir = path.join(project, '.handoffs');
  fs.mkdirSync(dir, { recursive: true });
  packet(dir, 'header-ahead.md',
    '# Header ahead\n\n> created: 2026-03-01T09:00:00Z\n\nbody\n', '2026-01-10T09:00:00Z');
  packet(dir, 'file-ahead.md',
    '# File ahead\n\n> created: 2026-01-05T09:00:00Z\n\nbody\n', '2026-03-10T09:00:00Z');
  packet(dir, 'no-header.md', '# No header\n\nbody\n', '2026-02-10T09:00:00Z');
  return project;
}

test('the handoff list is ordered by the date its rows show, whatever the header says', () => {
  const project = mixedProject();
  const { ctx } = contextFor(project);
  handoffs.init(ctx);

  const rows = handoffs.getHandoffs(project);
  assert.deepEqual(rows.map(r => r.title), ['File ahead', 'No header', 'Header ahead'],
    'newest first by mtime — by the header this order is reversed');
  // …and the key it was sorted on is the field every surface renders.
  const shown = rows.map(r => r.modified);
  assert.deepEqual([...shown].sort().reverse(), shown, 'the date on the row descends down the list');
  fs.rmSync(project, { recursive: true, force: true });
});

test('a packet with no header sorts against one with a header by the same clock', () => {
  // The mixed-clock defect: `createdAt` used to fall back to the mtime, so a file without a header was
  // ordered by when it was last written while its neighbour was ordered by when the work was handed over.
  const project = mixedProject();
  const { ctx } = contextFor(project);
  handoffs.init(ctx);

  const rows = handoffs.getHandoffs(project);
  const bare = rows.find(r => r.title === 'No header');
  assert.equal(bare.createdAt, null, 'no header means no creation date, not the mtime wearing its name');
  assert.equal(bare.modified, '2026-02-10T09:00:00.000Z');
  // The header is still parsed and still returned for the packets that carry one.
  assert.equal(rows.find(r => r.title === 'Header ahead').createdAt, '2026-03-01T09:00:00.000Z');
  fs.rmSync(project, { recursive: true, force: true });
});

test('the Agent Files group and the picker agree about the order of one directory', () => {
  const project = mixedProject();
  const { ctx } = contextFor(project);
  handoffs.init(ctx);

  const groups = handoffs.handoffGroups(project);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].files.map(f => f.filename),
    handoffs.getHandoffs(project).map(h => h.filename),
    'one directory read through two surfaces comes back in one order',
  );
  fs.rmSync(project, { recursive: true, force: true });
});
