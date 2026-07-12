// #154 — every backend feeds session_metrics, so the Stats charts stop being Claude-only.
//
// The charts (heatmap, daily bars, per-model tokens) are built from per-(date, hour, model) buckets.
// Only the Claude read path used to write them, so a user with four backends saw charts that silently
// ignored three of them — while the totals right next to them counted all four.
//
// The bucket key is LOCAL (#159, metrics-bucket.js), so these tests must not hardcode a date derived
// from a UTC timestamp: on any machine east of Greenwich that is a different day. They ask the same
// helper the parsers use, which is also what keeps them honest about the thing being tested — that a
// session crossing a day boundary SPLITS, not which calendar day it happens to land on here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexParser = require('../backends/codex/parser');
const piParser = require('../backends/pi/parser');
const { bucketFromIso } = require('../metrics-bucket');

const PI_FIXTURE = path.join(__dirname, 'fixtures', 'pi-session.jsonl');

/** The local day an ISO timestamp falls on — the same answer the parser reaches. */
const dayOf = (iso) => bucketFromIso(iso).date;
/** The local hour an ISO timestamp falls on. */
const hourOf = (iso) => bucketFromIso(iso).hour;

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { dir, file };
}

const sum = (buckets, key) => buckets.reduce((n, b) => n + (b[key] || 0), 0);

// --- Codex ---------------------------------------------------------------------------------------

// Midday, 24h apart: two different LOCAL days in every timezone on earth. A 23:50 / 00:05 pair looked
// like "spans midnight" but only does so in UTC — an hour east of Greenwich it is one local evening, and
// the test would have been asserting nothing.
const DAY_ONE = '2026-07-11T12:00:00.000Z';
const DAY_TWO = '2026-07-12T12:00:00.000Z';

test('Codex books tokens on the day they were spent, not all on the last one', () => {
  // Codex re-emits the RUNNING total, so a naive reader would credit the final report's whole total to
  // whatever day it landed on. A session spanning two days would then book both days' work onto one.
  const { dir, file } = tmpFile([
    JSON.stringify({ timestamp: DAY_ONE, type: 'session_meta', payload: { id: 'sess-1', cwd: '/p', timestamp: DAY_ONE } }),
    JSON.stringify({ timestamp: DAY_ONE, type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: DAY_ONE, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'day one' }] } }),
    JSON.stringify({ timestamp: DAY_ONE, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, total_tokens: 110 } } } }),
    // ...the next day, the running total climbs to 300/40.
    JSON.stringify({ timestamp: DAY_TWO, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'day two' }] } }),
    JSON.stringify({ timestamp: DAY_TWO, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 40, cached_input_tokens: 0, total_tokens: 340 } } } }),
  ]);
  try {
    const row = codexParser.parseSession({ kind: 'file', path: file });
    const byDate = {};
    for (const b of row.dailyMetrics) {
      const acc = byDate[b.date] || (byDate[b.date] = { inputTokens: 0, outputTokens: 0 });
      acc.inputTokens += b.inputTokens;
      acc.outputTokens += b.outputTokens;
    }

    assert.equal(byDate[dayOf(DAY_ONE)].inputTokens, 100, 'the first report is what was spent that day');
    assert.equal(byDate[dayOf(DAY_TWO)].inputTokens, 200, 'the second day gets the DELTA (300 - 100), not 300');
    assert.equal(byDate[dayOf(DAY_TWO)].outputTokens, 30);
    assert.equal(sum(row.dailyMetrics, 'inputTokens'), row.inputTokens, 'and the buckets add up to the session total');
    assert.equal(row.dailyMetrics.every(b => b.model === 'gpt-5.5'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex counts each message on its own day', () => {
  const { dir, file } = tmpFile([
    JSON.stringify({ timestamp: DAY_ONE, type: 'session_meta', payload: { id: 's', cwd: '/p' } }),
    JSON.stringify({ timestamp: DAY_ONE, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] } }),
    JSON.stringify({ timestamp: DAY_TWO, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] } }),
  ]);
  try {
    const row = codexParser.parseSession({ kind: 'file', path: file });
    const byDate = {};
    for (const b of row.dailyMetrics) byDate[b.date] = (byDate[b.date] || 0) + b.messageCount;
    assert.equal(byDate[dayOf(DAY_ONE)], 1);
    assert.equal(byDate[dayOf(DAY_TWO)], 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// #159 — the hour is what the activity grid is built from. Without it the grid would have to place
// every message at midnight, which is a claim about the user's working habits that nobody made.
test('Codex stamps each bucket with the LOCAL hour it happened in', () => {
  const { dir, file } = tmpFile([
    JSON.stringify({ timestamp: DAY_ONE, type: 'session_meta', payload: { id: 's', cwd: '/p' } }),
    JSON.stringify({ timestamp: DAY_ONE, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] } }),
  ]);
  try {
    const row = codexParser.parseSession({ kind: 'file', path: file });
    assert.equal(row.dailyMetrics.length, 1);
    assert.equal(row.dailyMetrics[0].hour, hourOf(DAY_ONE));
    assert.equal(row.dailyMetrics[0].date, dayOf(DAY_ONE));
    // Codex reports no money. NULL, not 0 — "free" is a different claim from "no figure".
    assert.equal(row.dailyMetrics[0].estimatedCostUsd, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- Pi ------------------------------------------------------------------------------------------

test('Pi books each turn under the model that actually produced it', () => {
  // Pi switches provider mid-session (the real fixture does exactly that). Booking every turn under the
  // session's FINAL model would credit one provider with another's tokens.
  const row = piParser.parseSession({ kind: 'file', path: PI_FIXTURE });
  assert.ok(row.dailyMetrics.length, 'the fixture produces buckets');

  const byModel = {};
  for (const b of row.dailyMetrics) byModel[b.model] = (byModel[b.model] || 0) + b.inputTokens;
  assert.ok(byModel['gpt-5.5'] > 0, 'the turns gpt-5.5 answered are booked to gpt-5.5');

  assert.equal(sum(row.dailyMetrics, 'inputTokens'), row.inputTokens, 'buckets add up to the session total');
  assert.equal(sum(row.dailyMetrics, 'outputTokens'), row.outputTokens);
  assert.equal(sum(row.dailyMetrics, 'messageCount'), row.messageCount);
});

test('a parser bumps its schema version when its state shape changes', () => {
  // The incremental parse state is persisted and keyed on this. Carrying metrics in the state without
  // bumping it would resume an old parse into the new shape.
  assert.ok(codexParser.PARSER_SCHEMA_VERSION >= 2);
  assert.ok(piParser.PARSER_SCHEMA_VERSION >= 2);
});

test('the incremental parse keeps the buckets consistent with a cold read', () => {
  const lines = fs.readFileSync(PI_FIXTURE, 'utf8').split('\n').filter(Boolean);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-inc-'));
  const file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file, lines.slice(0, 6).join('\n') + '\n');
    const first = piParser.parseSessionIncremental({ kind: 'file', path: file }, {}, null);
    fs.appendFileSync(file, lines.slice(6).join('\n') + '\n');
    const second = piParser.parseSessionIncremental({ kind: 'file', path: file }, {}, first.parseState);

    const cold = piParser.parseSession({ kind: 'file', path: PI_FIXTURE });
    assert.equal(sum(second.row.dailyMetrics, 'inputTokens'), sum(cold.dailyMetrics, 'inputTokens'));
    assert.equal(sum(second.row.dailyMetrics, 'messageCount'), sum(cold.dailyMetrics, 'messageCount'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
