// --- File preview kind + MIME helpers (#49) ---
// Pure helpers shared by the renderer (viewer-panel.js, file-panel.js) and the
// main process (read-file-dataurl MIME) and node tests. No DOM/browser APIs.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests and main.js (module.exports).

const PREVIEW_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
const PREVIEW_HTML_EXTS = ['html', 'htm'];
const PREVIEW_MARKDOWN_EXTS = ['md', 'mdx'];
// A PDF is neither text nor an image: Chromium can display it, nothing can edit it here (#465). Its own
// kind, so the viewer opens a VIEW rather than decoding the bytes into the source editor — which is what
// it did, Save button and all, until this existed.
const PREVIEW_PDF_EXTS = ['pdf'];

const PREVIEW_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
};

// Classify a file extension into a preview kind: 'image' | 'pdf' | 'html' | 'markdown' | 'text'.
//
// 'text' is the fallback, and that is a decision with a cost: anything unknown lands in the source
// editor. For a binary format that means bytes read as UTF-8, shown as replacement characters, over a
// Save button that would write them back destroyed (#465). A binary kind Switchboard can display gets
// its own entry here; one it cannot should be refused rather than decoded.
function previewKindForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (PREVIEW_IMAGE_EXTS.includes(e)) return 'image';
  if (PREVIEW_PDF_EXTS.includes(e)) return 'pdf';
  if (PREVIEW_HTML_EXTS.includes(e)) return 'html';
  if (PREVIEW_MARKDOWN_EXTS.includes(e)) return 'markdown';
  return 'text';
}

// MIME type for an extension (for data URLs / <img>), or null if unknown.
function mimeForExt(ext) {
  return PREVIEW_MIME[String(ext || '').toLowerCase()] || null;
}

// Extract the lowercased extension from a path ("a/b/C.PNG" → "png").
function extOf(filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// file:// URL of a path's DIRECTORY, with a trailing slash, so an HTML preview's
// relative resources (<img src="x.png">) resolve via <base href>. Renderer-safe
// (no Node url module). Windows "D:/x/a.html" → "file:///D:/x/".
function fileDirUrl(filePath) {
  if (!filePath) return '';
  let p = String(filePath).replace(/\\/g, '/');
  const idx = p.lastIndexOf('/');
  let dir = idx >= 0 ? p.slice(0, idx + 1) : '';
  if (!dir) return '';
  if (!dir.startsWith('/')) dir = '/' + dir; // Windows drive path: /D:/x/
  return 'file://' + encodeURI(dir);
}

// Inject a <base href> into an HTML document so relative resources resolve
// against the file's own directory when rendered in a srcdoc iframe.
function htmlWithBase(html, dirUrl) {
  const h = String(html || '');
  if (!dirUrl) return h;
  const base = `<base href="${dirUrl}">`;
  if (/<head[^>]*>/i.test(h)) return h.replace(/<head[^>]*>/i, (m) => m + base);
  if (/<html[^>]*>/i.test(h)) return h.replace(/<html[^>]*>/i, (m) => m + base);
  return base + h;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PREVIEW_IMAGE_EXTS,
  PREVIEW_PDF_EXTS,
    PREVIEW_HTML_EXTS,
    PREVIEW_MARKDOWN_EXTS,
    previewKindForExt,
    mimeForExt,
    extOf,
    fileDirUrl,
    htmlWithBase,
  };
}
