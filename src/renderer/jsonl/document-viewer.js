// document-viewer.js — the overlay a document card opens over the conversation (#755).
//
// `openDocumentViewer({ host, name, count, srcAt, content, actions, focusFallback })` — `content` and `actions` are
// described below — appends ONE overlay inside `host` (the conversation root,
// never document.body, so it follows its pane through tabs, panes, grid and a detached window) and shows the
// page `srcAt(i)` builds. The pages are not held here: `srcAt` builds a data URL for the current page only and
// the previous one is dropped when the page changes, so a page nobody opens is never decoded (D9, R3).
//
// Keys (ArrowLeft/Right, Home/End, +/-/0, Esc, Tab) are handled by a listener on the overlay element itself —
// never on `document` — so while the viewer is closed nothing listens, and the composer's keys cannot be
// shadowed. Focus moves into the overlay on open, is trapped there, and returns to what had it on close.
//
// `opts.content = { kind, text, dirUrl }` (#764) shows ONE rendered text document instead of pages: Markdown through
// marked + DOMPurify, HTML in a sandboxed iframe with no scripts — the two renderings of the file view
// (views/viewer-panel.js `_renderPreview`). There is no pager, zoom scales the text, and the arrow and page keys
// and Home/End are left to the scroll: Markdown's stage takes the focus, an HTML frame takes it once loaded and its
// document hands the viewer's own keys and Ctrl+wheel back (the only listeners not on the overlay element). The
// scroller (stage or frame) is part of the Tab cycle.
//
// `opts.actions = [{ label, run }]` (#765) puts the card's open actions in the bar; each closes the viewer and then
// runs. The card passes them only where it shows its own buttons, so the history viewer has none here either.
//
// Reads `isMac` (terminal/terminal-manager.js), `htmlWithBase` (shared/preview-kind.js) and `DOMPurify` /
// `window.marked` (their own tags in index.html) at call time, guarded. `opts.focusFallback`, when given, takes the
// focus on close if what had it is gone. The card (jsonl/document-card.js) is its only caller.

const DOCUMENT_ZOOM_MIN = 0.25;
const DOCUMENT_ZOOM_MAX = 4;
const DOCUMENT_ZOOM_STEP = 0.25;

// The rendered text of `content` as one element for the stage: a sanitized Markdown block or a sandboxed frame.
function documentTextElement(content) {
  if (content.kind === 'html') {
    const frame = document.createElement('iframe');
    frame.className = 'document-viewer-frame';
    frame.setAttribute('sandbox', 'allow-same-origin'); // NO allow-scripts, as in the file view
    frame.srcdoc = typeof htmlWithBase === 'function' ? htmlWithBase(content.text, content.dirUrl || '') : content.text;
    return frame;
  }
  const md = document.createElement('div');
  md.className = 'document-viewer-text markdown-preview';
  const html = window.marked ? window.marked.parse(String(content.text || '')) : '';
  if (html && typeof DOMPurify !== 'undefined') md.innerHTML = DOMPurify.sanitize(html);
  else md.textContent = String(content.text || '');
  return md;
}

function openDocumentViewer(opts) {
  const host = opts.host;
  const content = opts.content && typeof opts.content.text === 'string' ? opts.content : null;
  const count = content ? 1 : Math.max(0, opts.count | 0);
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

  // The card's open actions (#765), when the card has them: each closes the viewer first, then runs.
  const actions = Array.isArray(opts.actions) ? opts.actions.filter(a => a && a.label && typeof a.run === 'function') : [];
  if (actions.length) {
    const group = document.createElement('span');
    group.className = 'document-viewer-group document-viewer-actions';
    for (const a of actions) group.appendChild(btn(a.label, a.label, () => { close(); a.run(); }));
    bar.appendChild(group);
  }

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
  // Text mode draws its document once and never pages; page mode swaps the src of one image.
  const textEl = content ? documentTextElement(content) : null;
  const img = content ? null : document.createElement('img');
  if (content) {
    stage.classList.add('document-viewer-stage-text');
    stage.tabIndex = -1;
    stage.appendChild(textEl);
  } else {
    img.className = 'document-viewer-img';
    img.alt = '';
    img.decoding = 'async';
    stage.appendChild(img);
  }

  overlay.append(bar, stage);

  function render() {
    if (content) return;
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
    zoomOut.disabled = zoom <= DOCUMENT_ZOOM_MIN;
    zoomIn.disabled = zoom >= DOCUMENT_ZOOM_MAX;
    if (content) {
      // A frame scales as a whole; Markdown scales its text and reflows to the stage's width.
      textEl.style.zoom = zoom === 1 ? '' : String(zoom);
      return;
    }
    img.classList.toggle('document-viewer-img-zoomed', zoom !== 1);
    img.style.width = zoom === 1 ? '' : `${zoom * 100}%`;
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
    // `body` means nothing had the focus — the card that did may have been redrawn while its file was read (#766).
    if (returnFocus && returnFocus !== document.body && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
    else if (typeof opts.focusFallback === 'function') opts.focusFallback();
  }
  overlay._close = close;

  function onKey(e) {
    // Nothing that starts inside the overlay reaches the conversation's handlers; only the keys the viewer
    // uses are also prevented.
    if (e.ctrlKey || e.metaKey || e.altKey) { e.stopPropagation(); return; }
    // A text document has no pages: the arrows and Home/End scroll it.
    if (content && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.stopPropagation(); return; }
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
        // A text document's scroller (the stage, or the HTML frame) is in the cycle too, so the keys can get back
        // to scrolling after a Tab.
        const scroller = content ? (textEl.tagName === 'IFRAME' ? textEl : stage) : null;
        const items = (scroller ? [scroller] : []).concat(Array.from(overlay.querySelectorAll('button')).filter(b => !b.disabled));
        if (!items.length) break;
        const at = items.indexOf(document.activeElement);
        const to = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1);
        if (items[to].tagName === 'IFRAME') {
          try { items[to].contentWindow.focus(); } catch { items[to].focus(); }
        } else items[to].focus();
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
  function onWheel(e) {
    const macNow = typeof isMac !== 'undefined' && isMac;
    if (!(macNow ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    e.stopPropagation();
    setZoom(zoom + (e.deltaY < 0 ? DOCUMENT_ZOOM_STEP : -DOCUMENT_ZOOM_STEP));
  }
  stage.addEventListener('wheel', onWheel, { passive: false });
  // A click on the empty backdrop or the stage beside the page or the text closes; a click on the page, the text
  // or a control does not. The press must have started there too: a text selection dragged out of the Markdown
  // column ends in a click on the stage, and that must not close the viewer.
  let pressedOn = null;
  overlay.addEventListener('mousedown', (e) => { pressedOn = e.target; });
  overlay.addEventListener('click', (e) => {
    const outside = (t) => t === overlay || t === stage;
    if (outside(e.target) && (pressedOn === null || outside(pressedOn))) close();
    pressedOn = null;
  });
  // An HTML document scrolls inside its frame, and keys and the wheel pressed there stay in the frame's document.
  // So the frame takes the focus, and its document hands the viewer's keys (Esc, zoom, the Tab trap) and Ctrl+wheel
  // to the same handlers; the scroll keys stay with the frame. These listeners die with the frame's document.
  const frame = content && textEl.tagName === 'IFRAME' ? textEl : null;
  if (frame) {
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        doc.addEventListener('keydown', onKey);
        doc.addEventListener('wheel', onWheel, { passive: false });
        if (overlay.isConnected) frame.contentWindow.focus();
      } catch { /* a frame we cannot reach keeps the viewer's own keys */ }
    });
  }

  render();
  applyZoom();
  host.appendChild(overlay);
  (content ? stage : overlay).focus();
  return { close, el: overlay };
}
