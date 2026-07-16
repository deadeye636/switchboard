'use strict';
// Codex keeps the name a user gave a thread OUTSIDE the rollout, in session_index.jsonl (#153). So a
// session's title cannot be read from its own transcript — which is why the parser never had it.
//
// The load-bearing fact is not that the file exists, it is that it is nearly EMPTY: measured on a real
// install, four entries against nine rollout files, last written three months ago. Codex writes one only
// for a thread the user bothered to name and never backfills the rest, so "no entry" is the common case.
// An implementation that treated the index as the title source would leave most sessions untitled.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parser = require('../src/backends/codex/parser');
const threadNames = require('../src/backends/codex/thread-names');

function withCodexHome(entries, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  threadNames._resetCache();
  try {
    if (entries !== null) {
      fs.writeFileSync(path.join(home, 'session_index.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
    return body(home);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    threadNames._resetCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A rollout in the shape Codex really writes (docs/backend-formats.md). */
function writeRollout(dir, id, prompt) {
  const file = path.join(dir, `rollout-2026-07-13T12-00-00-${id}.jsonl`);
  fs.writeFileSync(file,
    JSON.stringify({ timestamp: '2026-07-13T12:00:00.000Z', type: 'session_meta', payload: { id, cwd: 'D:\\Projekte\\x' } }) + '\n'
    + JSON.stringify({ timestamp: '2026-07-13T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }) + '\n');
  return file;
}

test('a named thread is titled by its name', () => {
  const ID = '019daeed-e058-7b80-a70d-7d27edfcf2e9';
  withCodexHome([{ id: ID, thread_name: 'Rework the permission system', updated_at: '2026-04-21T07:25:57Z' }], (home) => {
    const file = writeRollout(home, ID, 'have a look at the permissions, they are a mess');
    const row = parser.parseSession({ kind: 'file', path: file });

    assert.strictEqual(row.summary, 'Rework the permission system');
    assert.strictEqual(row.firstPrompt, 'have a look at the permissions, they are a mess',
      'the prompt stays the prompt — the thread name only titles it');
  });
});

test('an UNnamed thread keeps its first prompt — which is the common case, not the exception', () => {
  const ID = '019db431-d4f6-7490-b775-53b8070c25b0';
  withCodexHome([{ id: 'someone-else', thread_name: 'Not this session', updated_at: '2026-04-22T07:58:46Z' }], (home) => {
    const file = writeRollout(home, ID, 'fix the flaky test in the scheduler');
    const row = parser.parseSession({ kind: 'file', path: file });

    assert.strictEqual(row.summary, 'fix the flaky test in the scheduler');
    assert.strictEqual(row.firstPrompt, 'fix the flaky test in the scheduler');
  });
});

test('no index file at all is normal, not an error', () => {
  const ID = '019db6e8-e982-7650-b12c-ea1d1cf6c07a';
  withCodexHome(null, (home) => {
    const file = writeRollout(home, ID, 'add a health check');
    const row = parser.parseSession({ kind: 'file', path: file });
    assert.strictEqual(row.summary, 'add a health check');
  });
});

test('a half-written last line does not take the whole index with it', () => {
  // It is an append-only file, so meeting it mid-write is normal.
  const ID = '019daeed-e058-7b80-a70d-7d27edfcf2e9';
  withCodexHome([{ id: ID, thread_name: 'Rework the permission system' }], (home) => {
    fs.appendFileSync(path.join(home, 'session_index.jsonl'), '{"id":"019db431-d4f6-74');
    threadNames._resetCache();

    assert.strictEqual(threadNames.threadName(ID), 'Rework the permission system',
      'the complete entries still read');
  });
});

test('an entry with no name is not a name', () => {
  const ID = '019daeed-e058-7b80-a70d-7d27edfcf2e9';
  withCodexHome([{ id: ID, thread_name: '   ', updated_at: 'x' }], (home) => {
    const file = writeRollout(home, ID, 'the actual prompt');
    assert.strictEqual(parser.parseSession({ kind: 'file', path: file }).summary, 'the actual prompt');
  });
});

test('the parser version is bumped, or the change lands in nothing', () => {
  // A parser change moves no file's mtime, so without a bump every session already in the cache keeps the
  // title the old parser gave it, for ever (#152).
  assert.ok(parser.PARSER_SCHEMA_VERSION >= 4, 'v4 = the thread-name overlay');
});
