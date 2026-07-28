// Images the terminal inserts as a file path — out of main.js (#307).
//
// A coding CLI reads an image by PATH (Claude Code renders it as [Image #N]), so every image that
// reaches a terminal — a pasted clipboard bitmap, a dropped screenshot, an image dragged out of a
// web page — has to become a file on disk first. This module owns that: the temp directory, the
// three ways bytes arrive, and the pruning that keeps the directory from growing forever (#308).
//
// Nothing here touches Electron directly: `clipboard` and `net` arrive through ctx, which is what
// keeps the module loadable in `node --test` (see test/terminal-images.test.js).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let ctx = null;

// Kept at the historical name: this directory has held pasted clipboard snapshots since well before
// drops joined them, and renaming it would orphan the files an installed build already wrote.
const TMP_DIR = path.join(os.tmpdir(), 'switchboard-clipboard');
// ctx may point somewhere else (the tests do); main.js passes nothing and gets TMP_DIR.
function tmpDir() {
  return (ctx && ctx.tmpDir) || TMP_DIR;
}
// Only files this module wrote are ever pruned — the temp directory is a shared namespace and
// something else may have picked the same name.
const OURS = /^paste-\d+-\d+\.[a-z0-9]+$/i;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
};

// --- Retention (#308) ---
// A path is inserted into the terminal but read by the CLI whenever the user gets round to sending
// it, so age is the only safe signal: nothing younger than MIN_AGE_MS is a candidate no matter what
// the caps say. Beyond that, files expire by age first and by count/size second (oldest first).
const MIN_AGE_MS = 60 * 60 * 1000; // 1 h
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 d
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let seq = 0;
let lastPruneMs = 0;

/**
 * @param {object} context
 *   clipboard  Electron's clipboard (bitmap snapshots)
 *   net        Electron's net (fetching an image dragged out of a web page)
 *   log        electron-log
 */
function init(context) {
  ctx = context;
  // A run that never pastes an image still clears what earlier runs left behind.
  prune();
}

function normalizeExt(ext) {
  const clean = String(ext || '').replace(/^\./, '').toLowerCase();
  return ALLOWED_EXT.has(clean) ? clean : 'png';
}

function extFromMime(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[type] || 'png';
}

// Write bytes to a fresh temp file and return its absolute path, or null when there is nothing
// usable to write. Every path the renderer inserts comes from here.
function writeImage(bytes, ext) {
  let buf;
  try {
    buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  } catch {
    return null;
  }
  if (!buf.length) return null;
  if (buf.length > MAX_IMAGE_BYTES) {
    ctx.log.warn(`[terminal-image] refused ${buf.length} bytes (cap ${MAX_IMAGE_BYTES})`);
    return null;
  }
  try {
    fs.mkdirSync(tmpDir(), { recursive: true });
    const file = path.join(tmpDir(), `paste-${Date.now()}-${seq++}.${normalizeExt(ext)}`);
    fs.writeFileSync(file, buf);
    maybePrune();
    return file;
  } catch (err) {
    ctx.log.error(`[terminal-image] save failed: ${err.message}`);
    return null;
  }
}

// A clipboard bitmap (a screenshot, "Copy image" in a browser). Native clipboard-image paste isn't
// available everywhere (e.g. Windows), so the bitmap is snapshotted here and its path inserted.
// Returns null when the clipboard holds no bitmap — plain text or a copied FILE, both of which the
// renderer handles differently.
function saveClipboardImage() {
  try {
    const img = ctx.clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    const png = img.toPNG();
    if (!png || !png.length) return null;
    return writeImage(png, 'png');
  } catch (err) {
    ctx.log.error(`[terminal-image] clipboard read failed: ${err.message}`);
    return null;
  }
}

// Bytes the renderer already holds: an image File with no on-disk path (a dropped screenshot, a
// pasted bitmap on a platform where the clipboard snapshot came back empty, a decoded data: URL).
function saveImageBuffer(bytes, ext) {
  return writeImage(bytes, ext);
}

// Read a response body, aborting the moment it passes the cap. content-length is a claim, not a
// promise: a chunked response carries none, and a server is free to understate it — so the cap has
// to hold while the bytes arrive, not after main has already buffered all of them.
async function readCapped(res, controller) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    // No stream to read (an older shape). The content-length pre-check is all there is, so the
    // buffer still gets measured before it is written.
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_IMAGE_BYTES ? null : buf;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_IMAGE_BYTES) {
      try { controller.abort(); } catch { /* already finished */ }
      ctx.log.warn(`[terminal-image] aborted remote image past ${MAX_IMAGE_BYTES} bytes`);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// An image dragged out of a web page travels as a URL, not as bytes — Chromium hands the drop a
// text/uri-list and nothing else. Fetching it is therefore the only way to get a file, and it is
// deliberately narrow: http/https only (no file:, no custom scheme), an image content-type only,
// and the same size cap as every other writer.
async function saveImageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const controller = new AbortController();
  try {
    const res = await ctx.net.fetch(url, { signal: controller.signal });
    if (!res || !res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.toLowerCase().startsWith('image/')) return null;
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_IMAGE_BYTES) {
      ctx.log.warn(`[terminal-image] refused remote image of ${declared} bytes`);
      return null;
    }
    const body = await readCapped(res, controller);
    return body ? writeImage(body, extFromMime(type)) : null;
  } catch (err) {
    ctx.log.warn(`[terminal-image] fetch failed: ${err.message}`);
    return null;
  }
}

// Delete our own expired snapshots. Called on boot and, throttled, after every write.
function prune() {
  lastPruneMs = Date.now();
  const dir = tmpDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // the directory only exists once something has been pasted
  }
  const now = Date.now();
  const files = [];
  for (const name of names) {
    if (!OURS.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) files.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished under us — nothing to prune */ }
  }
  if (!files.length) return 0;

  let count = files.length;
  let bytes = files.reduce((sum, f) => sum + f.size, 0);
  // Oldest first, and only what is old enough to be safe.
  const candidates = files
    .filter(f => now - f.mtimeMs > MIN_AGE_MS)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const doomed = [];
  for (const f of candidates) {
    const expired = now - f.mtimeMs > MAX_AGE_MS;
    if (!expired && count <= MAX_FILES && bytes <= MAX_TOTAL_BYTES) continue;
    doomed.push(f);
    count--;
    bytes -= f.size;
  }

  let removed = 0;
  for (const f of doomed) {
    try {
      fs.unlinkSync(f.file);
      removed++;
    } catch { /* in use or already gone */ }
  }
  if (removed) ctx.log.info(`[terminal-image] pruned ${removed} temp image(s)`);
  return removed;
}

function maybePrune() {
  if (Date.now() - lastPruneMs > PRUNE_INTERVAL_MS) prune();
}

function registerIpc(ipc) {
  ipc.handle('save-clipboard-image', () => saveClipboardImage());
  ipc.handle('save-image-buffer', (_event, bytes, ext) => saveImageBuffer(bytes, ext));
  ipc.handle('save-image-url', (_event, url) => saveImageUrl(url));
}

module.exports = {
  init,
  registerIpc,
  saveClipboardImage,
  saveImageBuffer,
  saveImageUrl,
  prune,
  TMP_DIR,
  MAX_IMAGE_BYTES,
  MIN_AGE_MS,
  MAX_AGE_MS,
  MAX_FILES,
  MAX_TOTAL_BYTES,
};
