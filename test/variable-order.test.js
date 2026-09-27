'use strict';
// The saved variables' manual order (#676): one order across every scope, set in the variables manager,
// shown by every picker.
//
// Three layers, tested where the suite can reach them:
//  - the renderer's pure helpers (src/renderer/lib/variable-order.js): a drag, a keyboard step, "Sort by
//    name", and putting rows into a given order;
//  - the store's rule for a STALE list (src/db/saved-variable-order.js) — nothing under test/ loads a
//    module that opens the database, so the rule lives beside the store, where both can use it;
//  - the IPC handler in src/app/variables.js, through its injected ctx.
// The SQL itself cannot run here (better-sqlite3 is built for Electron's ABI — .claude/rules/db.md), so the
// last block reads the store and the migration as text. That is a wiring guard, not a behaviour test: the
// migration is verified with scripts/db-migrate-probe.js against a copy of a real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./helpers/strip-comments');

const {
  moveVariableInOrder, stepVariableInOrder, variableIdsByName, orderVariableRows, sameVariableOrder,
} = require('../src/renderer/lib/variable-order');
const { mergeVariableOrder } = require('../src/db/saved-variable-order');
const variables = require('../src/app/variables');

const ROOT = path.join(__dirname, '..');

// --- the renderer's helpers ----------------------------------------------------------------------

test('#676: a drop puts the row directly before or after the row it landed on', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveVariableInOrder(ids, 'd', 'b', 'before'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveVariableInOrder(ids, 'd', 'b', 'after'), ['a', 'b', 'd', 'c']);
  assert.deepEqual(moveVariableInOrder(ids, 'a', 'd', 'after'), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveVariableInOrder(ids, 'a', 'c', 'before'), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd'], 'the input is not mutated');
});

test('#676: a drop that cannot move anything returns the order unchanged', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(moveVariableInOrder(ids, 'b', 'b', 'before'), ids, 'dropped on itself');
  assert.deepEqual(moveVariableInOrder(ids, 'x', 'b', 'before'), ids, 'unknown row');
  assert.deepEqual(moveVariableInOrder(ids, 'a', 'x', 'after'), ids, 'unknown target');
  assert.deepEqual(moveVariableInOrder(null, 'a', 'b', 'after'), []);
});

test('#676: under a scope filter, a drop keeps every hidden row where it was', () => {
  // g = global, p = project; the filter shows only the globals.
  const all = ['g1', 'p1', 'g2', 'p2', 'g3'];
  // Drop g3 before g2 (visible neighbours): p1 and p2 stay put relative to what they sat between.
  assert.deepEqual(moveVariableInOrder(all, 'g3', 'g2', 'before'), ['g1', 'p1', 'g3', 'g2', 'p2']);
});

test('#676: Alt+Up / Alt+Down steps past the neighbouring VISIBLE row, and does nothing at the ends', () => {
  const all = ['g1', 'p1', 'g2', 'p2', 'g3'];
  const shown = ['g1', 'g2', 'g3'];
  assert.deepEqual(stepVariableInOrder(all, shown, 'g2', -1), ['g2', 'g1', 'p1', 'p2', 'g3']);
  assert.deepEqual(stepVariableInOrder(all, shown, 'g2', +1), ['g1', 'p1', 'p2', 'g3', 'g2']);
  assert.equal(stepVariableInOrder(all, shown, 'g1', -1), null, 'already first');
  assert.equal(stepVariableInOrder(all, shown, 'g3', +1), null, 'already last');
  assert.equal(stepVariableInOrder(all, shown, 'p1', -1), null, 'not shown, so not movable');
  // Unfiltered it is a plain swap with the neighbour.
  assert.deepEqual(stepVariableInOrder(['a', 'b', 'c'], ['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
});

test('#676: Sort by name is the pre-#676 order — ASCII-lowercased name, then the newest edit first', () => {
  const rows = [
    { id: '1', name: 'beta', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '2', name: 'Alpha', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '3', name: 'alpha', updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: '4', name: '_under', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '5', name: 'Zed', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  // '_' (0x5F) sorts after the ASCII capitals and before the lowercase letters in SQLite's BINARY
  // compare, and LOWER() has already folded the capitals — so '_under' comes first.
  assert.deepEqual(variableIdsByName(rows), ['4', '3', '2', '1', '5']);
  assert.deepEqual(variableIdsByName(null), []);
});

test('#676: rows put into a given order keep any row the list does not name, after the named ones', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(orderVariableRows(rows, ['c', 'a']).map(r => r.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(orderVariableRows(rows, ['x', 'd', 'd']).map(r => r.id), ['d', 'a', 'b', 'c']);
  assert.ok(sameVariableOrder(['a', 'b'], ['a', 'b']));
  assert.ok(!sameVariableOrder(['a', 'b'], ['b', 'a']));
  assert.ok(!sameVariableOrder(['a'], ['a', 'b']));
});

// --- the store's rule for a stale list -----------------------------------------------------------

test('#676: the store renumbers in the requested order', () => {
  assert.deepEqual(mergeVariableOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('#676: a stale list — deleted ids are ignored, rows it never saw keep their order after the named ones', () => {
  // The table now holds a, b, c, n1, n2 (n1/n2 created in another window); the list still names x (deleted).
  const current = ['a', 'n1', 'b', 'c', 'n2'];
  assert.deepEqual(mergeVariableOrder(current, ['c', 'x', 'a', 'b']), ['c', 'a', 'b', 'n1', 'n2']);
});

test('#676: duplicates count once, and junk never reaches the table', () => {
  assert.deepEqual(mergeVariableOrder(['a', 'b'], ['b', 'b', 7, null, 'a']), ['b', 'a']);
  assert.deepEqual(mergeVariableOrder(['a', 'b'], 'not a list'), ['a', 'b']);
  assert.deepEqual(mergeVariableOrder(null, ['a']), []);
});

// --- the IPC handler -----------------------------------------------------------------------------

function setupIpc({ changed = true } = {}) {
  const calls = [];
  const sent = [];
  const main = { isDestroyed: () => false, webContents: { send: (ch) => sent.push(ch) } };
  variables.init({
    activeSessions: new Map(),
    getSetting: () => ({}),
    getSecretRefDir: () => path.join(ROOT, 'no-such-dir'),
    safeStorage: { isEncryptionAvailable: () => false },
    db: {
      reorderSavedVariables: (ids) => { calls.push(ids); return { order: ids.slice().reverse(), changed }; },
    },
    log: { info() {}, warn() {}, error() {} },
    getMainWindow: () => main,
  });
  const handlers = {};
  variables.registerIpc({ handle: (channel, fn) => { handlers[channel] = fn; } });
  return { handler: handlers['reorder-saved-variables'], calls, sent };
}

test('#676: reorder-saved-variables hands the store a list of ids and answers with the order it wrote', () => {
  const { handler, calls, sent } = setupIpc();
  assert.equal(typeof handler, 'function', 'the channel is registered by src/app/variables.js');
  const res = handler({ sender: null }, ['a', 3, 'b', null]);
  assert.deepEqual(calls, [['a', 'b']], 'only strings reach the store');
  assert.deepEqual(res, { ok: true, order: ['b', 'a'] });
  assert.deepEqual(sent, ['variables-changed'], 'the other windows are told the set moved');
});

test('#676: an order that did not move is not announced to the other windows', () => {
  const { handler, sent } = setupIpc({ changed: false });
  const res = handler({ sender: null }, ['a', 'b']);
  assert.equal(res.ok, true);
  assert.deepEqual(sent, [], 'nothing moved, so nothing to reload');
});

test('#676: reorder-saved-variables refuses anything that is not a list', () => {
  const { handler, calls, sent } = setupIpc();
  const res = handler({ sender: null }, 'a,b');
  assert.equal(res.ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, []);
});

test('#676: the preload binding exists and calls that channel', () => {
  const preload = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8'));
  assert.match(preload, /reorderSavedVariables:\s*\(ids\)\s*=>\s*ipcRenderer\.invoke\('reorder-saved-variables',\s*ids\)/);
});

// --- the SQL, read as text (see the header for why) ----------------------------------------------

test('#676: both list statements sort by the manual order first, with today\'s order as the tiebreak', () => {
  const store = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'db', 'settings-store.js'), 'utf8'));
  const orders = store.match(/ORDER BY [^\n`]*/g) || [];
  const listOrders = orders.filter(o => /sortOrder/.test(o));
  assert.ok(listOrders.length >= 3, 'savedVariablesList, savedVariablesListAll and the order read all use sortOrder');
  for (const o of listOrders) {
    assert.match(o, /ORDER BY sortOrder IS NULL, sortOrder, LOWER\(name\), updatedAt DESC/);
  }
  assert.doesNotMatch(store, /ORDER BY LOWER\(name\), updatedAt DESC/, 'no list statement still sorts by name first');
});

test('#676: a new variable goes to the end, and an edit never moves it', () => {
  const store = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'db', 'settings-store.js'), 'utf8'));
  const upsert = store.slice(store.indexOf('savedVariableUpsert'), store.indexOf('savedVariableOrderIds'));
  assert.match(upsert, /COALESCE\(MAX\(sortOrder\), 0\) \+ 1/, 'the insert takes the next place at the end');
  const onConflict = upsert.slice(upsert.indexOf('ON CONFLICT'));
  assert.doesNotMatch(onConflict, /sortOrder/, 'an edit must not touch the order');
});

test('#676: the migration backfills in exactly the order the list had before', () => {
  const { migrations } = require('../src/db/migrations');
  const found = migrations.map(fn => stripComments(fn.toString())).filter(s => /saved_variables ADD COLUMN sortOrder/.test(s));
  assert.equal(found.length, 1, 'exactly one migration adds the column');
  const src = found[0];
  assert.match(src, /ADD COLUMN sortOrder INTEGER/);
  assert.match(src, /ROW_NUMBER\(\) OVER \(ORDER BY LOWER\(name\), updatedAt DESC\)/);
});
