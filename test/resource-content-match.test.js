'use strict';
// #823 T4 — the content filter's main half (spec 44, spec 40): which listed items hold a text. Pins that a hit inside
// a body that the name does not carry is found, that the bounds hold (query length, per-file bytes, file count, text
// extensions), that a changed file is re-read and an unchanged one is not, and that an id outside the inventory is
// never produced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resmatch-'));
for (const id of ['claude', 'codex', 'hermes', 'pi', 'agy']) {
  const store = path.join(root, id, 'store');
  fs.mkdirSync(store, { recursive: true });
  process.env['SWITCHBOARD_STORE_' + id.toUpperCase()] = store;
}
const claudeHome = path.dirname(process.env.SWITCHBOARD_STORE_CLAUDE);

const backends = require('../src/backends');
const inventory = require('../src/app/resource-inventory');

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const noLog = { debug() {}, warn() {}, error() {}, info() {} };
const init = () => inventory.init({ backends, log: noLog });
const idOf = (view, name) => inventory.getResourceInventory({ view }).rows.find(r => r.name === name).id;

test('a word only in the body finds the item; the name is not needed', async () => {
  init();
  write(path.join(claudeHome, 'commands', 'ship.md'), 'Run the Frobnicate step first.\n');
  write(path.join(claudeHome, 'commands', 'plain.md'), 'nothing here\n');
  const res = await inventory.matchResourceContent({ view: 'commands', query: 'FROBNICATE' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ids, [idOf('commands', 'ship')]);
  assert.ok(!JSON.stringify(res).includes('Frobnicate'), 'no file text in the answer');
});

test('a short query, an unknown view and an unlisted project read nothing', async () => {
  init();
  assert.deepEqual((await inventory.matchResourceContent({ view: 'commands', query: 'f' })).ids, []);
  assert.equal((await inventory.matchResourceContent({ view: 'nope', query: 'ff' })).ok, false);
  assert.equal((await inventory.matchResourceContent({ view: 'commands', projectPath: path.join(root, 'x'), query: 'ff' })).ok, false);
});

test('an id the window invents is ignored: only the current listing is read', async () => {
  init();
  const res = await inventory.matchResourceContent({ view: 'rules', query: 'frobnicate' });
  assert.deepEqual(res.ids, [], 'the commands file is not a rule');
});

test('limits: only the first bytes of a file, text extensions only, at most `files` files', async () => {
  const dir = path.join(root, 'limits');
  const big = write(path.join(dir, 'big.md'), 'a'.repeat(100) + 'needle');
  const bin = write(path.join(dir, 'blob.bin'), 'needle');
  const ok = write(path.join(dir, 'ok.md'), 'needle');
  const files = [big, bin, ok].map((filePath, i) => ({ id: 'f' + i, filePath }));
  // The memo is keyed by path, so the small-cap run reads copies of its own.
  const copies = [big, bin, ok].map((f, i) => ({ id: 'f' + i, filePath: write(path.join(dir, 'small', path.basename(f)), fs.readFileSync(f)) }));
  const small = { ...inventory.CONTENT_LIMITS, fileBytes: 50 };
  assert.deepEqual((await inventory._matchFiles(copies, 'needle', small)).sort(), ['f2'], 'past the byte cap and a .bin are not read');
  assert.deepEqual((await inventory._matchFiles(files, 'needle')).sort(), ['f0', 'f2'], 'the default cap sees the first, never the .bin');
  const one = { ...inventory.CONTENT_LIMITS, files: 1 };
  assert.deepEqual(await inventory._matchFiles([files[2], files[0]], 'needle', one), ['f2'], 'the second file is beyond the count');
});

test('a changed file is re-read, an unchanged one is served from the memo', async () => {
  const file = write(path.join(root, 'memo', 'a.md'), 'first body');
  const pin = () => fs.utimesSync(file, 1700000000, 1700000000);
  pin();
  const files = [{ id: 'm', filePath: file }];
  assert.deepEqual(await inventory._matchFiles(files, 'first'), ['m']);
  // Same size and mtime, different bytes behind it: the memo answers, which proves no second read happened.
  fs.writeFileSync(file, 'other body');
  pin();
  assert.deepEqual(await inventory._matchFiles(files, 'first'), ['m'], 'unchanged stat: no read');
  fs.writeFileSync(file, 'second body, longer');
  assert.deepEqual(await inventory._matchFiles(files, 'first'), [], 'a changed size re-reads');
  assert.deepEqual(await inventory._matchFiles(files, 'second'), ['m']);
});

test('the memo stays within its byte bound', async () => {
  const files = [];
  for (let i = 0; i < 6; i++) files.push({ id: 'k' + i, filePath: write(path.join(root, 'lru', `f${i}.md`), 'x'.repeat(400) + i) });
  const before = inventory._memoSize();
  const tight = { ...inventory.CONTENT_LIMITS, cacheBytes: 2000 };
  await inventory._matchFiles(files, 'xx', tight);
  // 401 chars * 2 = 802 bytes per entry: at most two fit in 2000.
  assert.ok(inventory._memoSize() <= 2, `evicted down to the bound, was ${before} before`);
});

test('a binary behind an extensionless name is not matched (NUL byte); extensionless text is', async () => {
  const dir = path.join(root, 'nul');
  const bin = write(path.join(dir, 'blob'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]));
  const txt = write(path.join(dir, '.cursorrules'), 'needle');
  const found = await inventory._matchFiles([{ id: 'b', filePath: bin }, { id: 't', filePath: txt }], 'needle');
  assert.deepEqual(found, ['t']);
});
