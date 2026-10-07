// document-card.js — the preview card of a document a tool read (#755).
//
// A backend stamps the neutral element `{ type: 'document', path, kind, name, pages }` first in a tool
// result's content array (src/backends/document-ref.js); this file draws ONE card for such a result instead
// of every page inline: a thumbnail of the first page, the file name, a page count, and — in a host that can
// act (the conversation view) — "Open in default app" and "Open in tab". It names no backend and no tool.
//
// Reads, at CALL time, from other classic scripts: documentPreviewMode / documentPreviewMaxBytes
// (jsonl/jsonl-viewer.js, which calls renderDocumentCard from renderToolResult), openDocumentViewer
// (jsonl/document-viewer.js), openFileInPanel (views/file-panel.js), showControlMessage
// (dialogs/control-dialogs.js, guarded). `window.api.openDocument` / `openInEditor` are the preload's.
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

function loadDocumentThumb(img) {
  const get = documentThumbSources.get(img);
  if (!get) return;
  documentThumbSources.delete(img);
  img.src = get();
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

  const openViewer = () => {
    const host = (ctx && ctx.host) || card.closest('#jsonl-viewer') || card.ownerDocument.body;
    openDocumentViewer({
      host,
      name,
      count: pages.length,
      srcAt: (i) => documentPageSrc(pages[i]),
      focusFallback: ctx && ctx.focusFallback,
    });
  };
  const activate = (e) => {
    if (pages.length) { openViewer(); return; }
    if (canAct) requestDocumentOpen(sessionIdNow(), doc.path, 'click', !!(e && (e.ctrlKey || e.metaKey)));
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
