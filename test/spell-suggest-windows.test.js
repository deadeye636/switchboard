// Corrections from the Windows spell checker (#818): the merge, the protocol through a fake, and the real thing where
// there is one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const suggestWindows = require('../src/app/spell-suggest-windows');

test('the OS comes first, no word twice, and the list is bounded', () => {
  assert.deepEqual(suggestWindows.mergeSuggestions(['Haus', 'Hausse'], ['Hausa', 'Haus']), ['Haus', 'Hausse', 'Hausa']);
  assert.deepEqual(suggestWindows.mergeSuggestions(null, undefined), []);
  assert.equal(suggestWindows.mergeSuggestions(['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']).length, suggestWindows.MAX_SUGGESTIONS);
  assert.deepEqual(suggestWindows.mergeSuggestions([1, '', 'x'], [null]), ['x']);
  assert.ok(suggestWindows.mergeSuggestions(['a', 'b', 'c', 'd', 'e', 'f'], ['house']).includes('house'), 'a full German list leaves room');
  assert.equal(suggestWindows.mergeSuggestions(['a', 'b', 'c', 'd', 'e', 'f'], []).length, 6);
});

function fakeChild(t, respond) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spell-suggest-'));
  t.after(() => { suggestWindows.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const spawned = [];
  suggestWindows.init({
    platform: 'win32',
    dataDir: () => dir,
    env: { SystemRoot: 'X:\\Win' },
    spawn: (file, args, options) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      child.stdin.on('data', (chunk) => respond(JSON.parse(String(chunk)), child));
      spawned.push({ file, args, options, child });
      return child;
    },
  });
  return { spawned, dir };
}

test('one process answers by id, with no project as its directory and no word on its command line', async (t) => {
  const { spawned, dir } = fakeChild(t, (q, child) => child.stdout.write(`${JSON.stringify({ id: q.id, words: [`${q.word}!`] })}\n`));
  assert.deepEqual(await suggestWindows.suggest('Hauss', ['de-DE']), ['Hauss!']);
  assert.deepEqual(await suggestWindows.suggest('Arbeitt', ['de-DE']), ['Arbeitt!']);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.cwd, dir);
  assert.ok(path.win32.isAbsolute(spawned[0].file), 'an absolute PowerShell');
  assert.ok(!spawned[0].args.join(' ').includes('Hauss'));
});

test('one word comes back from PowerShell as a plain string, and that still counts', async (t) => {
  fakeChild(t, (q, child) => child.stdout.write(`\uFEFF${JSON.stringify({ id: q.id, words: 'Haus' })}\n`));
  assert.deepEqual(await suggestWindows.suggest('Hauss', ['de-DE']), ['Haus']);
});

test('a process that worked and then dies answers nothing, and the next word starts another', async (t) => {
  let turn = 0;
  const { spawned } = fakeChild(t, (q, child) => {
    turn += 1;
    if (turn === 2) { child.emit('exit', 1); return; }
    child.stdout.write(`${JSON.stringify({ id: q.id, words: ['ok'] })}\n`);
  });
  assert.deepEqual(await suggestWindows.suggest('a', ['de-DE']), ['ok']);
  assert.deepEqual(await suggestWindows.suggest('b', ['de-DE']), []);
  assert.deepEqual(await suggestWindows.suggest('c', ['de-DE']), ['ok']);
  assert.equal(spawned.length, 2);
});

test('nothing starts off Windows, or without a word or a language', async (t) => {
  const { spawned } = fakeChild(t, () => {});
  assert.deepEqual(await suggestWindows.suggest('', ['de-DE']), []);
  assert.deepEqual(await suggestWindows.suggest('x', []), []);
  suggestWindows.init({ platform: 'linux', dataDir: () => '', spawn: () => { throw new Error('no'); } });
  assert.deepEqual(await suggestWindows.suggest('x', ['de-DE']), []);
  assert.equal(spawned.length, 0);
});

test('a process that never answers is ended and not tried again for a while, and a process with no checker goes', async (t) => {
  let clock = 1000;
  const spawned = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spell-suggest-'));
  t.after(() => { suggestWindows.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  let answer = (q, child) => child.emit('exit', 1);
  suggestWindows.init({
    platform: 'win32', dataDir: () => dir, env: { SystemRoot: 'X:\\Win' }, now: () => clock,
    spawn: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => { child.killed = true; };
      child.stdin.on('data', (chunk) => answer(JSON.parse(String(chunk)), child));
      spawned.push(child);
      return child;
    },
  });
  assert.deepEqual(await suggestWindows.suggest('a', ['de-DE']), []);
  assert.equal(spawned.length, 1);
  assert.deepEqual(await suggestWindows.suggest('b', ['de-DE']), []);
  assert.equal(spawned.length, 1, 'refused: one attempt, not one per click');
  assert.equal(suggestWindows.ready(['de-DE']), true, 'and nobody waits for it');
  clock += 11 * 60 * 1000;
  assert.equal(suggestWindows.ready(['de-DE']), false);
  answer = (q, child) => child.stdout.write(`${JSON.stringify({ id: q.id, words: [], supported: 0 })}\n`);
  assert.deepEqual(await suggestWindows.suggest('c', ['fr']), []);
  await new Promise((r) => setImmediate(r));
  assert.equal(spawned[1].killed, true, 'no checker for these languages');
  assert.equal(suggestWindows.ready(['fr']), true);
  assert.deepEqual(await suggestWindows.suggest('d', ['fr']), []);
  assert.equal(spawned.length, 2);
});

// What the script does is only known by running it (guards-and-scripts.md).
test('the real checker answers, in one list per turn', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spell-suggest-live-'));
  t.after(() => { suggestWindows.stop(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }, 500).unref(); });
  suggestWindows.init({ dataDir: () => dir, env: process.env });
  const words = await suggestWindows.suggest('Hauss', ['de-DE', 'en-US']);
  assert.ok(Array.isArray(words));
  assert.ok(suggestWindows.ready(['de-DE', 'en-US']), 'it answered, or found no checker, and did not die');
  // Only where this machine holds German; a machine without it answers an empty list above.
  if (words.length) assert.ok(words.includes('Haus'), words.join());
});
