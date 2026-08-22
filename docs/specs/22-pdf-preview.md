# PDF preview

Issue: #465. Built: PDFs are shown in the internal viewer, and no binary file lands in the source
editor by mistake.

## What was wrong

`previewKindForExt` knew four kinds — image, html, markdown, text — and text was the fallback. A PDF is
none of the first three, so it was read with `readFileSync(path, 'utf8')` and handed to CodeMirror. An
uncompressed PDF showed up as its own object syntax, a real one as replacement characters.

The display was the visible half. The dangerous half was the toolbar that came with it: **a Save button
over bytes read as UTF-8 writes the file back destroyed.** Images had been right since #49 —
`_openImage` tears the editor down and hides everything that offers to edit — and a PDF simply never
got the same treatment.

## Chromium's own viewer does not work here

The obvious fix is an `<embed type="application/pdf">`; Electron ships Chromium, Chromium displays
PDFs. It was tried first, and it does not work in this renderer. Measured, in that order:

1. `<embed>` with a blob URL, CSP untouched → console: *Framing 'blob:…' violates … "default-src
   'self'"*. So the embed is a FRAME, and `object-src` alone would not have been enough.
2. `object-src 'self' blob:` **and** `frame-src 'self' blob:`, plus `webPreferences.plugins: true` on
   the window → no CSP violation, `navigator.pdfViewerEnabled` is true, the plugin list names five PDF
   viewers — and the embed renders nothing at all.
3. `<iframe src="file:///…pdf">` → loads (`readyState: complete`), empty body.
4. `window.open` on the same file → refused.

Electron ships PDFium's mime types without the extension that draws the viewer around them. The flag
and the two CSP directives were reverted; `test/pdf-viewer.test.js` fails if either comes back, because
each of them widens what the renderer may load for a feature that never used them.

## What it does instead

`src/renderer/views/pdf-setup.js` is an esbuild entry that wraps pdf.js and puts one function on
`window`: draw every page of a byte array into a container as canvases. The panel owns those canvases,
so the document never becomes a frame with its own navigation and the CSP stays exactly as narrow as it
was.

Three consequences worth knowing:

- **Two bundles, not one.** pdf.js refuses to parse without a worker — *"No
  GlobalWorkerOptions.workerSrc specified"* is what running it on the main thread gets you — so the
  worker is a bundle of its own beside the viewer's, loaded by a relative path from the same origin
  `script-src 'self'` already allows. `bundle:pdf` builds both, and every pipeline that bundles
  CodeMirror bundles these too.
- **Loaded when a PDF is opened, never at start-up.** Same pattern as the CodeMirror bundle: 400 KB of
  viewer plus 1.1 MB of worker parsed for a file most sessions never open is a cost with no payer.
- **Canvases at device pixel ratio.** A canvas drawn at CSS pixels is soft on every display this app
  runs on. The ratio is capped at 3 — beyond that the memory per page grows faster than anyone can see
  the difference.

## The rule this leaves behind

Text is still the fallback kind, and that is a decision with a cost: anything unknown lands in the
source editor. For a binary format that means bytes as replacement characters over a Save button. A
binary kind Switchboard can display gets its own entry in `preview-kind.js`; one it cannot should be
refused rather than decoded.

## Files

| Area | What is there |
|---|---|
| `src/shared/preview-kind.js` | the `pdf` kind and its mime type |
| `src/renderer/views/pdf-setup.js` | the bundle entry — pdf.js, the worker path, the page loop |
| `src/renderer/views/viewer-panel.js` | `_openPdf`: bytes, the bundle loader, the generation guard |
| `src/renderer/views/file-panel.js` | which reader a file gets: data URL for image and pdf, text for the rest |
| `package.json`, `scripts/demo-start.js` | both bundles, in every pipeline |
