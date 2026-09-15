// #620: a guard over the shape of `cacheUpsert` in src/db/session-store.js.
//
// No test can load db.js (better-sqlite3 is built against Electron's ABI, `.claude/rules/db.md`), so the
// one statement every scanned session goes through is otherwise checked by nothing until a probe runs under
// Electron. This reads the statement as text and pins the two properties a later edit most easily breaks:
//
//   - the INSERT names exactly as many columns as it has placeholders, and every column but the key is
//     updated on conflict — a column added to one list and not the other is a silently misaligned row;
//   - the last-turn columns are assigned from `excluded` directly. They describe the transcript as it reads
//     NOW, and a compaction or a `/model` picker legitimately takes them back to 0 or NULL; a COALESCE
//     there would keep the stale value forever.
//
// What it cannot see: the ORDER of the `.run(` arguments against the column list. Two swapped arguments
// store values in each other's columns without an error. It is a wiring guard, not a behaviour test — the
// round trip itself was measured with a column probe on a copy of a real database and on an empty one.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const SOURCE = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'session-store.js'), 'utf8'));
const LAST_TURN_COLUMNS = ['lastInputTokens', 'lastModel', 'lastModelSpec', 'lastProvider', 'contextWindowReported'];

function upsertSql(source) {
  const m = /cacheUpsert:\s*db\.prepare\(`([\s\S]*?)`\)/.exec(source);
  if (!m) return null;
  // SQL line comments live INSIDE the template, where the JS stripper rightly leaves them alone.
  return m[1].replace(/--[^\n]*/g, ' ');
}

/** Every way the statement's shape is wrong, as messages; empty when it holds. */
function shapeProblems(source) {
  const sql = upsertSql(source);
  if (!sql) return ['cacheUpsert is not a db.prepare over a template literal'];
  const problems = [];
  const cols = /INSERT INTO session_cache \(([\s\S]*?)\)\s*VALUES/.exec(sql);
  const values = /VALUES \(([\s\S]*?)\)/.exec(sql);
  const set = /DO UPDATE SET([\s\S]*)$/.exec(sql);
  if (!cols || !values || !set) return ['the INSERT, its VALUES or its DO UPDATE SET is missing'];
  const columns = cols[1].split(',').map((c) => c.trim()).filter(Boolean);
  const placeholders = values[1].split(',').map((c) => c.trim()).filter(Boolean);
  if (placeholders.length !== columns.length) problems.push(`${columns.length} columns, ${placeholders.length} placeholders`);
  if (!placeholders.every((p) => p === '?')) problems.push('a VALUES entry is not a placeholder');
  const assigned = [...set[1].matchAll(/(\w+)\s*=/g)].map((m) => m[1]).sort();
  const expected = columns.filter((c) => c !== 'sessionId').sort();
  if (JSON.stringify(assigned) !== JSON.stringify(expected)) problems.push('the conflict update does not assign every non-key column once');
  for (const col of LAST_TURN_COLUMNS) {
    if (!new RegExp(`\\b${col}\\s*=\\s*excluded\\.${col}\\s*(,|$)`).test(set[1].trim())) problems.push(`${col} is not taken from excluded as it is`);
  }
  return problems;
}

test('cacheUpsert has one placeholder per column, updates every non-key column, and never coalesces the last turn (#620)', () => {
  assert.deepEqual(shapeProblems(SOURCE), []);
});

// The guard is checked against broken copies of the REAL source, so it is known to fail on what it claims.
test('the guard fails on a coalesced last-turn column, a dropped placeholder and a dropped update', () => {
  const coalesced = SOURCE.replace('lastModel = excluded.lastModel', 'lastModel = COALESCE(excluded.lastModel, session_cache.lastModel)');
  assert.notEqual(coalesced, SOURCE, 'the mutation applied');
  assert.ok(shapeProblems(coalesced).some((p) => p.startsWith('lastModel')));

  const dropped = SOURCE.replace(/VALUES \(\?, /, 'VALUES (');
  assert.notEqual(dropped, SOURCE, 'the mutation applied');
  assert.ok(shapeProblems(dropped).some((p) => p.includes('placeholders')));

  const noUpdate = SOURCE.replace(/\s*lastProvider = excluded\.lastProvider,/, '');
  assert.notEqual(noUpdate, SOURCE, 'the mutation applied');
  assert.ok(shapeProblems(noUpdate).length > 0);
});
