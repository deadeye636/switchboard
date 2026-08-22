// --- The PDF viewer's bundle entry (#465) ---
//
// Chromium's own PDF viewer is not available here, and that was measured rather than assumed: with
// `plugins: true` and a CSP that allows the blob, an `<embed type="application/pdf">` loads the
// document (`readyState: complete`, no CSP violation) and renders nothing, an `<iframe>` on the same
// file does the same with an empty body, and `window.open` on a PDF is refused. Electron ships the
// PDFium plugin's mime types but not the extension that draws the viewer around it.
//
// So the pages are drawn here, with pdf.js, into canvases the panel owns. That keeps the CSP as it was
// — no `object-src`, no `frame-src`, no window flag — and the document never becomes a frame with its
// own navigation. The four measurements behind that are in docs/specs/22-pdf-preview.md.
//
// Bundled by esbuild (`npm run bundle:pdf`) into `pdf-bundle.js`, the same arrangement CodeMirror uses:
// this file is the ONLY seam, the bundle is excluded from every lint environment, and the renderer
// reaches what it exports through `window.` rather than as a bare global.
//
// The WORKER is a second bundle beside this one (`npm run bundle:pdf` builds both). pdf.js refuses to
// parse anything without one — "No GlobalWorkerOptions.workerSrc specified" is what an attempt at
// running it on the main thread gets you — and the path is relative, so it resolves next to the page
// on the same file:// origin `script-src 'self'` already allows.
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = 'pdf-worker.js';

/** Devicepixel-aware: a canvas rendered at CSS pixels is soft on every display this app runs on. */
function renderPage(page, container, cssWidth) {
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth > 0 ? cssWidth / base.width : 1;
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const canvas = document.createElement('canvas');
  canvas.className = 'fp-pdf-page';
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';
  container.appendChild(canvas);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  return page.render({ canvasContext: context, viewport }).promise;
}

/**
 * Draw every page of `bytes` into `container`, top to bottom.
 *
 * Returns `{ ok, pages }`, or `{ ok: false, error }` — a PDF that cannot be parsed is an answer the
 * panel has to show, not an exception to swallow. The caller may pass a `token` and a `isCurrent`
 * predicate: a document arriving after the user moved on must not paint over the one they are looking
 * at, which is the same generation guard the source viewer uses.
 */
async function renderPdfInto(container, bytes, { isCurrent = () => true } = {}) {
  let doc = null;
  try {
    doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'This PDF could not be read.' };
  }
  if (!isCurrent()) { try { doc.destroy(); } catch { /* nothing to give back */ } return { ok: false, stale: true }; }
  container.innerHTML = '';
  const width = Math.max(120, container.clientWidth - 24);
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (!isCurrent()) break;
      const page = await doc.getPage(n);
      await renderPage(page, container, width);
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'This PDF could not be drawn.' };
  } finally {
    try { doc.destroy(); } catch { /* already gone */ }
  }
  return { ok: true, pages: doc.numPages };
}

window.renderPdfInto = renderPdfInto;
