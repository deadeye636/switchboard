// --- Neutral "this result is the document at <path>" element (#755) ---
// Pure helper shared by the backend folders (they stamp it into a tool result's content) and read by the
// core and the renderer as a plain shape. No fs, no electron: the kind comes from the extension alone,
// through src/shared/preview-kind.js (the one place the extension lists live).
//
// The element is `{ type: 'document', path, kind, name, pages }` and it exists ONLY for a result that names
// a file (a Read with its file_path). `documentElement` is the single constructor and answers `null` without
// a usable path, so a backend cannot build one for an image that has no file behind it.

const { previewKindForExt, extOf } = require('../shared/preview-kind');

// The kinds a card can show. previewKindForExt's 'text' fallback is "unknown extension", not a kind.
const DOCUMENT_KINDS = ['pdf', 'image', 'markdown', 'html'];

// Last path segment, for either separator ("D:\x\a.pdf" and "/x/a.pdf" are both file names on every host).
function nameOfPath(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}

// Preview kind of a path, or null when its extension is not one a document card shows.
function kindOfPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const name = nameOfPath(filePath);
  if (!name) return null; // trailing separator: a directory, not a file
  const kind = previewKindForExt(extOf(name));
  return DOCUMENT_KINDS.includes(kind) ? kind : null;
}

// Build the element, or null. A missing/blank path, a path whose extension has no document kind, or a
// `kind` that contradicts the extension all answer null — never a guess.
// A page range as a CLI asks for one (`"2"`, `"1-3"`, `"1-3,5"`): digits, dashes and commas only, and short —
// it is drawn as a label, never parsed into anything else.
const RANGE = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?){0,7}$/;

function documentElement({ path, kind, pages, range } = {}) {
  const derived = kindOfPath(path);
  if (!derived) return null;
  if (kind !== undefined && kind !== null && kind !== derived) return null;
  const el = {
    type: 'document',
    path,
    kind: derived,
    name: nameOfPath(path),
    pages: Number.isInteger(pages) && pages >= 0 ? pages : 0,
  };
  // The pages a partial read asked for (#755 T1-4): the card says "pages 1-3", not "3 pages" of a longer file.
  const r = typeof range === 'string' ? range.replace(/\s+/g, '') : '';
  if (r && RANGE.test(r)) el.range = r;
  return el;
}

function isDocumentElement(el) {
  return !!el && typeof el === 'object' && el.type === 'document'
    && typeof el.path === 'string' && el.path !== ''
    && DOCUMENT_KINDS.includes(el.kind)
    && typeof el.name === 'string'
    && Number.isInteger(el.pages) && el.pages >= 0
    && (el.range === undefined || (typeof el.range === 'string' && RANGE.test(el.range)));
}

module.exports = { DOCUMENT_KINDS, kindOfPath, documentElement, isDocumentElement };
