// document-card.js — the preview card of a document a tool read (#755).
//
// A backend stamps the neutral element `{ type: 'document', path, kind, name, pages }` first in a tool
// result's content array (src/backends/document-ref.js); this file draws ONE card for such a result instead
// of every page inline: a thumbnail of the first page, the file name, a page count, and — in a host that can
// act (the conversation view) — "Open in default app" and "Open in tab". It names no backend and no tool.
//
// Reads, at CALL time, from other classic scripts: documentPreviewMode / documentPreviewMaxBytes / documentPdfThumbnailsOn
// (jsonl/jsonl-viewer.js, which calls renderDocumentCard from renderToolResult), claimInlineOpen / isLatestInlineOpen
// (jsonl/jsonl-viewer.js, guarded), openDocumentViewer
// (jsonl/document-viewer.js), openFileInPanel (views/file-panel.js), showControlMessage
// (dialogs/control-dialogs.js, guarded), fileDirUrl (shared/preview-kind.js, guarded). `window.api.openDocument` /
// `readDocument` / `openInEditor` are the preload's.
//
// A whole-PDF card reads its file once it scrolls into view to draw a first-page thumbnail (#782), unless
// `documentPdfThumbnails` is off; `window.renderPdfFirstPage` (views/pdf-setup.js) draws it.
//
// A card without pages (a whole PDF, Markdown, HTML) opens the viewer on a click with the file read then and drawn
// there — Markdown and HTML rendered (#764), a PDF by the preview tab's renderer (#781) — and keeps the
// `fileClickTarget` open for Ctrl/Cmd-click. Any other kind without pages follows `fileClickTarget` on a click.
//
// The page images stay in the result the entry already holds. The card keeps a reference to that result and
// builds a data URL only for the page it is about to show (the thumbnail when visible, a page in the
// viewer) — nothing is copied up front (R3 of the plan).

// A page image of a result: the content blocks that carry base64 data. Same shape extractImages reads.
function documentPageBlocks(data) {
  if (!Array.isArray(data)) return [];
  return data.filter(b => b && b.type === 'image' && b.source && b.source.data);
}

function documentPageSrc(block) {
  return `data:${block.source.media_type || 'image/jpeg'};base64,${block.source.data}`;
}

// Mirrors RANGE and isDocumentElement in src/backends/document-ref.js (CommonJS, so not loadable here) exactly.
const DOCUMENT_RANGE = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?){0,7}$/;
function isDocumentElementShape(el) {
  return !!el && typeof el === 'object' && el.type === 'document'
    && typeof el.path === 'string' && el.path !== ''
    && ['pdf', 'image', 'markdown', 'html'].includes(el.kind)
    && typeof el.name === 'string'
    && Number.isInteger(el.pages) && el.pages >= 0
    && (el.range === undefined || (typeof el.range === 'string' && DOCUMENT_RANGE.test(el.range)));
}

// The document element of a result, or null. Only an array can carry one.
function documentElementOfResult(data) {
  if (!Array.isArray(data)) return null;
  return data.find(isDocumentElementShape) || null;
}

function documentBaseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s;
}

const DOCUMENT_KIND_LABELS = { pdf: 'PDF', image: 'Image', markdown: 'Markdown', html: 'HTML' };
// The kinds the viewer shows as rendered text, read on the click (#764). Mirrors TEXT_KINDS in src/app/documents.js.
const DOCUMENT_TEXT_KINDS = ['markdown', 'html'];
// …and what else the viewer reads on the click: a PDF whose result carries no page images (#781).
const DOCUMENT_READ_KINDS = DOCUMENT_TEXT_KINDS.concat(['pdf']);

// A `range` ("1-3", the call's page argument) marks a partial read; else the pages held, else the kind.
function documentCardSubtitle(kind, pageCount, range) {
  if (typeof range === 'string' && range) return `pages ${range}`;
  // An image is one picture, not "1 page".
  if (pageCount > 0 && kind !== 'image') return `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`;
  return DOCUMENT_KIND_LABELS[kind] || 'Document';
}

// Thumbnails are given a src only when they scroll into view (D9). The src text lives in a WeakMap, not in
// an attribute, so a card nobody scrolls to holds no second copy of the page.
const documentThumbSources = new WeakMap();
let documentThumbObserver = null;

// The getter answers a src for a page image, or does its own work and answers nothing (a PDF thumbnail, #782).
function loadDocumentThumb(img) {
  const get = documentThumbSources.get(img);
  if (!get) return;
  documentThumbSources.delete(img);
  const src = get();
  if (typeof src === 'string') img.src = src;
}

// #782: the first page of a PDF whose result carries no page images, read when its card scrolls into view
// (`documentPdfThumbnails`, default on; off keeps #764's read-on-click-only rule). One at a time, so a scroll past
// twenty cards parses twenty PDFs in turn rather than at once, and once per path for the life of the window: a file
// that cannot be drawn is remembered too, so it is not re-read on every redraw — a refused read is not, so the next
// draw tries again. Keyed by session and path, not by the file's time — a file rewritten while the window is open
// keeps its first thumbnail; the viewer and the open read it fresh.
//
// pdf.js draws on animation frames, which a hidden window does not run, so a job started there waits until the
// window is shown and then finishes — its card gets the thumbnail late, never lost. A job that takes longer than
// DOCUMENT_PDF_THUMB_TIMEOUT_MS of VISIBLE time only lets the queue move on; its card still gets whatever it ends with.
const DOCUMENT_PDF_THUMB_WIDTH = 84; // .document-card-thumb's width, in CSS pixels
const DOCUMENT_PDF_THUMB_CAP = 200; // a PNG of 84 px x devicePixelRatio, ~20-130 KB each: a few MB at most
const DOCUMENT_PDF_THUMB_TIMEOUT_MS = 20000;
const DOCUMENT_PDF_THUMB_TICK_MS = 500;
const documentPdfThumbs = new Map(); // `${sessionId}\n${path}` -> Promise<string|null>
let documentPdfThumbQueue = Promise.resolve();

// Resolves once `ms` have passed while the document was visible, or when `done` settles first.
function documentVisibleDelay(ms, done) {
  return new Promise((resolve) => {
    let seen = 0;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) seen += DOCUMENT_PDF_THUMB_TICK_MS;
      if (seen >= ms) { clearInterval(timer); resolve(); }
    }, DOCUMENT_PDF_THUMB_TICK_MS);
    done.finally(() => { clearInterval(timer); resolve(); });
  });
}

function documentPdfThumb(sessionId, path) {
  // With the session: a refusal because a session was not running must not stick to the next one.
  const key = `${sessionId}\n${path}`;
  if (documentPdfThumbs.has(key)) return documentPdfThumbs.get(key);
  let refused = false;
  const work = async () => {
    let res = null;
    // A refused read — or one the IPC itself failed — is not remembered: the session may be relaunched under the
    // same id, or the file come back.
    try { res = await window.api.readDocument(sessionId, path); } catch { refused = true; return null; }
    if (!res || res.ok !== true) { refused = true; return null; }
    if (res.kind !== 'pdf' || !res.bytes || !res.bytes.length) return null;
    // The viewer bundle not loading is the app's failure, not the file's: not remembered either (loadPdfBundle
    // itself lets the next call try again).
    try { await window.loadPdfBundle(); } catch { refused = true; return null; }
    if (typeof window.renderPdfFirstPage !== 'function') { refused = true; return null; }
    return (await window.renderPdfFirstPage(res.bytes, DOCUMENT_PDF_THUMB_WIDTH)) || null;
  };
  let started;
  const begun = new Promise((r) => { started = r; });
  // The card waits on the work itself; the queue waits on the work or the visible-time bound, whichever comes first.
  const job = begun.then(() => work()).catch(() => null).then((src) => {
    if (refused && !src && documentPdfThumbs.get(key) === job) documentPdfThumbs.delete(key);
    return src;
  });
  documentPdfThumbQueue = documentPdfThumbQueue.then(() => {
    started();
    return documentVisibleDelay(DOCUMENT_PDF_THUMB_TIMEOUT_MS, job);
  });
  documentPdfThumbs.set(key, job);
  if (documentPdfThumbs.size > DOCUMENT_PDF_THUMB_CAP) documentPdfThumbs.delete(documentPdfThumbs.keys().next().value);
  return job;
}

function watchDocumentThumb(img, getSrc) {
  documentThumbSources.set(img, getSrc);
  if (typeof IntersectionObserver !== 'function') { loadDocumentThumb(img); return; }
  if (!documentThumbObserver) {
    documentThumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        documentThumbObserver.unobserve(e.target);
        loadDocumentThumb(e.target);
      }
    });
  }
  documentThumbObserver.observe(img);
}

// What the renderer finishes after main answered `openDocument`: 'default' was opened by main itself.
function finishDocumentOpen(sessionId, res) {
  if (!res || res.ok !== true) {
    const msg = res && res.error ? res.error : 'The document could not be opened.';
    if (typeof showControlMessage === 'function') showControlMessage({ title: 'Cannot open document', message: msg });
    return;
  }
  if (res.action === 'tab' && res.path && typeof openFileInPanel === 'function') openFileInPanel(sessionId, res.path);
  else if (res.action === 'editor' && res.path) window.api.openInEditor(res.path);
}

async function requestDocumentOpen(sessionId, path, how, invert) {
  let res = null;
  try { res = await window.api.openDocument(sessionId, path, how, !!invert); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
  finishDocumentOpen(sessionId, res);
}

// The card for a tool result, or null when the result is drawn as it always was: no document element, or
// nothing a card could do (no page images and a host that cannot act). `ctx = { sessionId, host, focusFallback }`
// comes from the conversation view only; without it the card shows the pages and the viewer but no open buttons
// (O5). `sessionId` is a string or a function, read when the card is drawn and again at every click, because a
// re-key moves it; `focusFallback` takes the focus when the viewer closes and what had it is gone.
function renderDocumentCard(resultData, ctx) {
  const doc = documentElementOfResult(resultData);
  if (!doc) return null;
  const pages = documentPageBlocks(resultData);
  const sessionIdNow = () => {
    const s = ctx && ctx.sessionId;
    return typeof s === 'function' ? s() : s;
  };
  const canAct = !!sessionIdNow();
  if (!pages.length && !canAct) return null;

  const card = document.createElement('div');
  card.className = 'document-card';
  card.dataset.kind = doc.kind || '';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'document-card-thumb';
  // No thumbnail past the size bound, or with no page images (a whole PDF, Markdown, HTML).
  if (pages.length && pages[0].source.data.length <= documentPreviewMaxBytes()) {
    const img = document.createElement('img');
    img.className = 'document-card-img';
    img.alt = '';
    img.decoding = 'async';
    watchDocumentThumb(img, () => documentPageSrc(pages[0]));
    thumbWrap.appendChild(img);
  } else {
    thumbWrap.classList.add('document-card-thumb-empty');
    thumbWrap.textContent = DOCUMENT_KIND_LABELS[doc.kind] || 'Document';
    // A whole PDF (#782): its first page, drawn once the card is on screen; the kind box stays until then, and
    // when the file cannot be read or drawn (a refused read is tried again by the next draw of the card).
    if (doc.kind === 'pdf' && !pages.length && canAct && documentPdfThumbnailsOn()) {
      watchDocumentThumb(thumbWrap, () => {
        documentPdfThumb(sessionIdNow(), doc.path).then((src) => {
          if (!src) return;
          const img = document.createElement('img');
          img.className = 'document-card-img';
          img.alt = '';
          img.decoding = 'async';
          img.src = src;
          thumbWrap.classList.remove('document-card-thumb-empty');
          thumbWrap.replaceChildren(img);
        });
        return null;
      });
    }
  }
  card.appendChild(thumbWrap);

  const name = doc.name || documentBaseName(doc.path);
  const meta = document.createElement('div');
  meta.className = 'document-card-meta';
  const nameEl = document.createElement('div');
  nameEl.className = 'document-card-name';
  nameEl.textContent = name;
  nameEl.title = name;
  const subEl = document.createElement('div');
  subEl.className = 'document-card-sub';
  subEl.textContent = documentCardSubtitle(doc.kind, pages.length || doc.pages, doc.range);
  meta.appendChild(nameEl);
  meta.appendChild(subEl);

  if (canAct) {
    const actions = document.createElement('div');
    actions.className = 'document-card-actions';
    const mk = (label, how) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'new-session-secondary-btn document-card-btn';
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        requestDocumentOpen(sessionIdNow(), doc.path, how, false);
      });
      return b;
    };
    actions.appendChild(mk('Open in default app', 'default'));
    actions.appendChild(mk('Open in tab', 'tab'));
    meta.appendChild(actions);
  }
  card.appendChild(meta);

  // The same two actions in the viewer's bar (#765), only where the card shows them.
  const viewerActions = canAct ? [
    { label: 'Open in default app', run: () => requestDocumentOpen(sessionIdNow(), doc.path, 'default', false) },
    { label: 'Open in tab', run: () => requestDocumentOpen(sessionIdNow(), doc.path, 'tab', false) },
  ] : [];

  // A document and an agent share the one viewer per host (#787): each open claims its turn, so an agent's
  // transcript still being read gives way to a document opened after it, and the other way round.
  const claim = (host) => (typeof claimInlineOpen === 'function' ? claimInlineOpen(host) : 0);
  const stale = (host, seq) => !!seq && typeof isLatestInlineOpen === 'function' && !isLatestInlineOpen(host, seq);
  const openViewer = () => {
    const host = (ctx && ctx.host) || card.closest('#jsonl-viewer') || card.ownerDocument.body;
    claim(host);
    openDocumentViewer({
      host,
      name,
      count: pages.length,
      srcAt: (i) => documentPageSrc(pages[i]),
      actions: viewerActions,
      focusFallback: ctx && ctx.focusFallback,
    });
  };
  // A Markdown, HTML or page-less PDF card reads its file for the viewer on the click (a PDF's thumbnail is its own
  // earlier read, #782), and shows it drawn (#764,
  // #781). Ctrl/Cmd keeps what a plain click did before: the `fileClickTarget` open, not inverted.
  let reading = false;
  const openTextViewer = async () => {
    if (reading) return;
    reading = true;
    // The host is taken now: the view may redraw its entries while the read is out (an attach, a deferred
    // draw), and the card clicked is then no longer in the document — the conversation still is (#766).
    const host = (ctx && ctx.host) || card.closest('#jsonl-viewer') || card.ownerDocument.body;
    const seq = claim(host);
    let res = null;
    try { res = await window.api.readDocument(sessionIdNow(), doc.path); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    reading = false;
    if (stale(host, seq)) return;
    if (!res || res.ok !== true) {
      const msg = res && res.error ? res.error : 'The document could not be read.';
      if (typeof showControlMessage === 'function') showControlMessage({ title: 'Cannot show document', message: msg });
      return;
    }
    if (!host.isConnected) return;
    // A viewer given no bytes opens nothing; say why instead of a click that does nothing.
    if (res.kind === 'pdf' && !(res.bytes && res.bytes.length)) {
      if (typeof showControlMessage === 'function') showControlMessage({ title: 'Cannot show document', message: 'That PDF could not be read.' });
      return;
    }
    const content = res.kind === 'pdf'
      ? { kind: 'pdf', bytes: res.bytes }
      : { kind: res.kind, text: res.text, dirUrl: typeof fileDirUrl === 'function' ? fileDirUrl(doc.path) : '' };
    openDocumentViewer({
      host,
      name,
      content,
      actions: viewerActions,
      focusFallback: ctx && ctx.focusFallback,
    });
  };
  const activate = (e) => {
    if (pages.length) { openViewer(); return; }
    if (!canAct) return;
    const modified = !!(e && (e.ctrlKey || e.metaKey));
    if (DOCUMENT_READ_KINDS.includes(doc.kind)) {
      if (modified) requestDocumentOpen(sessionIdNow(), doc.path, 'click', false);
      else openTextViewer();
      return;
    }
    requestDocumentOpen(sessionIdNow(), doc.path, 'click', modified);
  };
  card.classList.add('document-card-clickable');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open ${name}`);
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    activate(e);
  });
  card.addEventListener('keydown', (e) => {
    if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    activate(e);
  });
  return card;
}
