// document-viewer.js — the overlay a document card opens over the conversation (#755).
//
// `openDocumentViewer({ host, name, count, srcAt })` appends ONE overlay inside `host` (the conversation root,
// never document.body, so it follows its pane through tabs, panes, grid and a detached window) and shows the
// page `srcAt(i)` builds. The pages are not held here: `srcAt` builds a data URL for the current page only and
// the previous one is dropped when the page changes, so a page nobody opens is never decoded (D9, R3).
//
// Keys (ArrowLeft/Right, Home/End, +/-/0, Esc, Tab) are handled by a listener on the overlay element itself —
// never on `document` — so while the viewer is closed nothing listens, and the composer's keys cannot be
// shadowed. Focus moves into the overlay on open, is trapped there, and returns to what had it on close.
//
// Reads `isMac` (terminal/terminal-manager.js) at call time, guarded. `opts.focusFallback`, when given, takes the
// focus on close if what had it is gone. The card (jsonl/document-card.js) is its only caller.

const DOCUMENT_ZOOM_MIN = 0.25;
const DOCUMENT_ZOOM_MAX = 4;
const DOCUMENT_ZOOM_STEP = 0.25;

function openDocumentViewer(opts) {
  const host = opts.host;
  const count = Math.max(0, opts.count | 0);
  if (!host || !count) return null;
  // One viewer per host: a second open replaces the first.
  const prior = host.querySelector(':scope > .document-viewer');
  if (prior && prior._close) prior._close();

  const returnFocus = document.activeElement;
  const hostPosition = host.style.position;
  if (typeof getComputedStyle === 'function' && getComputedStyle(host).position === 'static') host.style.position = 'relative';

  let index = 0;
  let zoom = 1;

  const overlay = document.createElement('div');
  overlay.className = 'document-viewer';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', opts.name || 'Document');

  const bar = document.createElement('div');
  bar.className = 'document-viewer-bar';
  const title = document.createElement('span');
  title.className = 'document-viewer-title';
  title.textContent = opts.name || '';
  bar.appendChild(title);

  const btn = (label, text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'new-session-secondary-btn document-viewer-btn';
    b.textContent = text;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  };

  const prev = btn('Previous page (←)', '‹', () => go(index - 1));
  const next = btn('Next page (→)', '›', () => go(index + 1));
  const counter = document.createElement('span');
  counter.className = 'document-viewer-counter';
  const pager = document.createElement('span');
  pager.className = 'document-viewer-group document-viewer-pager';
  pager.append(prev, counter, next);
  if (count > 1) bar.appendChild(pager);

  const zoomOut = btn('Zoom out (−)', '−', () => setZoom(zoom - DOCUMENT_ZOOM_STEP));
  const zoomLabel = btn('Reset zoom (0)', '100%', () => setZoom(1));
  const zoomIn = btn('Zoom in (+)', '+', () => setZoom(zoom + DOCUMENT_ZOOM_STEP));
  const zoomGroup = document.createElement('span');
  zoomGroup.className = 'document-viewer-group document-viewer-zoom';
  zoomGroup.append(zoomOut, zoomLabel, zoomIn);
  bar.appendChild(zoomGroup);

  const closeBtn = btn('Close (Esc)', '✕', () => close());
  bar.appendChild(closeBtn);

  const stage = document.createElement('div');
  stage.className = 'document-viewer-stage';
  const img = document.createElement('img');
  img.className = 'document-viewer-img';
  img.alt = '';
  img.decoding = 'async';
  stage.appendChild(img);

  overlay.append(bar, stage);

  function render() {
    img.src = opts.srcAt(index);
    counter.textContent = `${index + 1} / ${count}`;
    prev.disabled = index <= 0;
    next.disabled = index >= count - 1;
    img.alt = `${opts.name || 'Document'}, page ${index + 1} of ${count}`;
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
  }
  function applyZoom() {
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    img.classList.toggle('document-viewer-img-zoomed', zoom !== 1);
    img.style.width = zoom === 1 ? '' : `${zoom * 100}%`;
    zoomOut.disabled = zoom <= DOCUMENT_ZOOM_MIN;
    zoomIn.disabled = zoom >= DOCUMENT_ZOOM_MAX;
  }
  function go(i) {
    const n = Math.min(count - 1, Math.max(0, i));
    if (n === index) return;
    index = n;
    render();
  }
  function setZoom(z) {
    zoom = Math.min(DOCUMENT_ZOOM_MAX, Math.max(DOCUMENT_ZOOM_MIN, Math.round(z * 100) / 100));
    applyZoom();
  }

  function close() {
    overlay.removeEventListener('keydown', onKey);
    overlay.remove();
    overlay._close = null;
    host.style.position = hostPosition;
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
    else if (typeof opts.focusFallback === 'function') opts.focusFallback();
  }
  overlay._close = close;

  function onKey(e) {
    // Nothing that starts inside the overlay reaches the conversation's handlers; only the keys the viewer
    // uses are also prevented.
    if (e.ctrlKey || e.metaKey || e.altKey) { e.stopPropagation(); return; }
    let handled = true;
    switch (e.key) {
      case 'Escape': close(); break;
      case 'ArrowLeft': go(index - 1); break;
      case 'ArrowRight': go(index + 1); break;
      case 'Home': go(0); break;
      case 'End': go(count - 1); break;
      case '+': case '=': setZoom(zoom + DOCUMENT_ZOOM_STEP); break;
      case '-': case '_': setZoom(zoom - DOCUMENT_ZOOM_STEP); break;
      case '0': setZoom(1); break;
      case 'Tab': {
        const items = Array.from(overlay.querySelectorAll('button')).filter(b => !b.disabled);
        if (!items.length) break;
        const at = items.indexOf(document.activeElement);
        const to = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1);
        items[to].focus();
        break;
      }
      default: handled = false;
    }
    if (handled) e.preventDefault();
    e.stopPropagation();
  }
  overlay.addEventListener('keydown', onKey);

  // Ctrl (Cmd on a Mac) + wheel zooms; a plain wheel scrolls the zoomed page. The modifier test is the
  // conversation container's own, so the wheel it would turn into a font-size nudge stops here.
  stage.addEventListener('wheel', (e) => {
    const macNow = typeof isMac !== 'undefined' && isMac;
    if (!(macNow ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    e.stopPropagation();
    setZoom(zoom + (e.deltaY < 0 ? DOCUMENT_ZOOM_STEP : -DOCUMENT_ZOOM_STEP));
  }, { passive: false });
  // A click on the empty backdrop closes, a click on the page or a control does not.
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === stage) close(); });

  render();
  applyZoom();
  host.appendChild(overlay);
  overlay.focus();
  return { close, el: overlay };
}
