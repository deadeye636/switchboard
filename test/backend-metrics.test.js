// #154 — every backend feeds session_metrics, so the Stats charts stop being Claude-only.
//
// The charts (heatmap, daily bars, per-model tokens) are built from per-(date, model) buckets. Only the
// Claude read path used to write them, so a user with four backends saw charts that silently ignored
// three of them — while the totals right next to them counted all four.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexParser = require('../backends/codex/parser');
const piParser = require('../backends/pi/parser');

const PI_FIXTURE = path.join(__dirname, 'fixtures', 'pi-session.jsonl');

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { dir, file };
}

const sum = (buckets, key) => buckets.reduce((n, b) => n + (b[key] || 0), 0);

// --- Codex ---------------------------------------------------------------------------------------

test('Codex books tokens on the day they were spent, not all on the last one', () => {
  // Codex re-emits the RUNNING total, so a naive reader would credit the final report's whole total to
  // whatever day it landed on. A session that spans midnight would then book two days of work onto one.
  const { dir, file } = tmpFile([
    JSON.stringify({ timestamp: '2026-07-11T23:50:00.000Z', type: 'session_meta', payload: { id: 'sess-1', cwd: '/p', timestamp: '2026-07-11T23:50:00.000Z' } }),
    JSON.stringify({ timestamp: '2026-07-11T23:50:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ timestamp: '2026-07-11T23:51:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'day one' }] } }),
    JSON.stringify({ timestamp: '2026-07-11T23:52:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, total_tokens: 110 } } } }),
    // ...past midnight, the running total climbs to 300/40.
    JSON.stringify({ timestamp: '2026-07-12T00:05:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'day two' }] } }),
    JSON.stringify({ timestamp: '2026-07-12T00:06:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 40, cached_input_tokens: 0, total_tokens: 340 } } } }),
  ]);
  try {
    const row = codexParser.parseSession({ kind: 'file', path: file });
    const byDate = Object.fromEntries(row.dailyMetrics.map(b => [b.date, b]));

    assert.equal(byDate['2026-07-11'].inputTokens, 100, 'the first report is what was spent that day');
    assert.equal(byDate['2026-07-12'].inputTokens, 200, 'the second day gets the DELTA (300 - 100), not 300');
    assert.equal(byDate['2026-07-12'].outputTokens, 30);
    assert.equal(sum(row.dailyMetrics, 'inputTokens'), row.inputTokens, 'and the buckets add up to the session total');
    assert.equal(row.dailyMetrics.every(b => b.model === 'gpt-5.5'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex counts each message on its own day', () => {
  const { dir, file } = tmpFile([
    JSON.stringify({ timestamp: '2026-07-11T23:00:00.000Z', type: 'session_meta', payload: { id: 's', cwd: '/p' } }),
    JSON.stringify({ timestamp: '2026-07-11T23:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] } }),
    JSON.stringify({ timestamp: '2026-07-12T00:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] } }),
  ]);
  try {
    const row = codexParser.parseSession({ kind: 'file', path: file });
    const byDate = Object.fromEntries(row.dailyMetrics.map(b => [b.date, b]));
    assert.equal(byDate['2026-07-11'].messageCount, 1);
    assert.equal(byDate['2026-07-12'].messageCount, 1);
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
