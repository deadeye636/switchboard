'use strict';
// src/app/terminal/images.js — the temp files a terminal image insert leaves behind (#307/#308).
//
// The module is loadable here at all because clipboard/net arrive through ctx; the same ctx carries
// the temp directory, so every test below runs against its own directory and never touches the real
// one. What is worth pinning: the URL guard (a drop must not turn into a fetch of anything that is
// not an image over http/https) and the pruning rules, where being too eager deletes a path the user
// has not sent yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const images = require('../src/app/terminal/images');

const NOOP_LOG = { info() {}, warn() {}, error() {} };

function withDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-images-'));
  return dir;
}

function initWith(dir, extra = {}) {
  images.init({ log: NOOP_LOG, clipboard: null, net: null, tmpDir: dir, ...extra });
}

function ageFile(file, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

// A file the module itself wrote, aged by hand.
function seed(dir, ageMs, { size = 8, name } = {}) {
  const file = path.join(dir, name || `paste-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  ageFile(file, ageMs);
  return file;
}

test('saveImageBuffer writes the bytes and normalizes the extension', () => {
  const dir = withDir();
  initWith(dir);

  const png = images.saveImageBuffer(Buffer.from([1, 2, 3]), 'png');
  assert.equal(path.extname(png), '.png');
  assert.deepEqual([...fs.readFileSync(png)], [1, 2, 3]);

  assert.equal(path.extname(images.saveImageBuffer(Buffer.from([1]), 'JPG')), '.jpg');
  // Anything not in the allow-list becomes .png rather than reaching disk as-is: the extension is
  // renderer-supplied and ends up in a path that gets handed to a CLI.
  assert.equal(path.extname(images.saveImageBuffer(Buffer.from([1]), '../evil.exe')), '.png');
  assert.equal(path.extname(images.saveImageBuffer(Buffer.from([1]), '')), '.png');
});

test('saveImageBuffer refuses nothing-to-write and oversized bytes', () => {
  const dir = withDir();
  initWith(dir);

  assert.equal(images.saveImageBuffer(Buffer.alloc(0), 'png'), null);
  assert.equal(images.saveImageBuffer(Buffer.alloc(images.MAX_IMAGE_BYTES + 1), 'png'), null);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('saveImageUrl only fetches an http(s) image', async () => {
  const dir = withDir();
  const fetched = [];
  const net = {
    fetch: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => Uint8Array.from([9, 9]).buffer,
      };
    },
  };
  initWith(dir, { net });

  // A dragged link, a local scheme or junk must never reach the network.
  assert.equal(await images.saveImageUrl('file:///etc/passwd'), null);
  assert.equal(await images.saveImageUrl('javascript:alert(1)'), null);
  assert.equal(await images.saveImageUrl('not a url'), null);
  assert.equal(await images.saveImageUrl(''), null);
  assert.deepEqual(fetched, []);

  const saved = await images.saveImageUrl('https://example.test/a.jpg');
  assert.equal(path.extname(saved), '.jpg');
  assert.deepEqual([...fs.readFileSync(saved)], [9, 9]);
  assert.deepEqual(fetched, ['https://example.test/a.jpg']);
});

// A response that streams — the shape Electron's net.fetch really returns. content-length is left
// out on purpose: that is exactly the case the streaming cap exists for.
function streamingRes(chunks, type = 'image/png') {
  let i = 0;
  return {
    ok: true,
    headers: { get: (h) => (h === 'content-type' ? type : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: Uint8Array.from(chunks[i++]) }
          : { done: true, value: undefined }),
      }),
    },
  };
}

test('saveImageUrl streams the body and aborts past the cap', async () => {
  const dir = withDir();
  let aborted = false;
  const chunk = new Array(1024 * 1024).fill(7); // 1 MB per read
  initWith(dir, {
    net: {
      fetch: async (_url, opts) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => { aborted = true; });
        // More than the cap, and the response never declares a content-length.
        return streamingRes(new Array(30).fill(chunk));
      },
    },
  });

  assert.equal(await images.saveImageUrl('https://example.test/huge.png'), null);
  assert.equal(aborted, true, 'the fetch is cancelled instead of buffered to the end');
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('saveImageUrl keeps a streamed image that stays under the cap', async () => {
  const dir = withDir();
  initWith(dir, { net: { fetch: async () => streamingRes([[1, 2], [3]], 'image/webp') } });

  const saved = await images.saveImageUrl('https://example.test/a.webp');
  assert.equal(path.extname(saved), '.webp');
  assert.deepEqual([...fs.readFileSync(saved)], [1, 2, 3]);
});

test('saveImageUrl drops a non-image response and a too-large one', async () => {
  const dir = withDir();
  const reply = { type: 'text/html', length: '10' };
  initWith(dir, {
    net: {
      fetch: async () => ({
        ok: true,
        headers: { get: (h) => (h === 'content-type' ? reply.type : reply.length) },
        arrayBuffer: async () => Uint8Array.from([1]).buffer,
      }),
    },
  });

  assert.equal(await images.saveImageUrl('https://example.test/a.png'), null);

  reply.type = 'image/png';
  reply.length = String(images.MAX_IMAGE_BYTES + 1);
  assert.equal(await images.saveImageUrl('https://example.test/a.png'), null);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('prune deletes expired snapshots and leaves recent ones alone', () => {
  const dir = withDir();
  initWith(dir);

  const fresh = seed(dir, 0);
  const young = seed(dir, images.MIN_AGE_MS / 2);
  const expired = seed(dir, images.MAX_AGE_MS + 60_000);

  assert.equal(images.prune(), 1);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(young), true);
});

test('prune never touches a file younger than the safety window, whatever the caps say', () => {
  const dir = withDir();
  initWith(dir);

  // Far past the count cap, but all of it is too young to be a candidate: the path may already be
  // sitting in a prompt the user has not sent yet.
  const files = [];
  for (let i = 0; i < images.MAX_FILES + 20; i++) files.push(seed(dir, 1000, { name: `paste-1-${i}.png` }));

  assert.equal(images.prune(), 0);
  assert.equal(files.every(f => fs.existsSync(f)), true);
});

test('prune enforces the count cap on old files, oldest first', () => {
  const dir = withDir();
  initWith(dir);

  const old = [];
  for (let i = 0; i < images.MAX_FILES + 5; i++) {
    // Not expired (well under MAX_AGE), but old enough to be a candidate.
    old.push(seed(dir, images.MIN_AGE_MS + 1000 * (images.MAX_FILES + 5 - i), { name: `paste-2-${i}.png` }));
  }

  assert.equal(images.prune(), 5);
  // The five oldest are the ones that went.
  assert.equal(old.slice(0, 5).some(f => fs.existsSync(f)), false);
  assert.equal(old.slice(5).every(f => fs.existsSync(f)), true);
});

test('prune ignores files this module did not write', () => {
  const dir = withDir();
  initWith(dir);

  const foreign = path.join(dir, 'someone-elses-old-file.png');
  fs.writeFileSync(foreign, 'x');
  ageFile(foreign, images.MAX_AGE_MS * 10);
  const sub = path.join(dir, 'paste-1-1.png-dir');
  fs.mkdirSync(sub);

  assert.equal(images.prune(), 0);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.existsSync(sub), true);
});

test('prune survives a missing directory', () => {
  initWith(path.join(os.tmpdir(), 'sb-images-does-not-exist-' + process.pid));
  assert.equal(images.prune(), 0);
});
