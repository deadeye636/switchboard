// Rich paste (#779): a copy that carries text AND pictures only in its HTML — a mail from Outlook or a web
// mail, a Word passage — read as one ordered list of text and image segments, so a session gets the whole
// thing in one paste with every picture where it stood.
//
// Such a copy offers no image file: Outlook puts each picture into `text/html` as a `data:` URI, classic
// Outlook and Word as a `file:///` link to a temp file. Without this the conversation view pasted the
// plain text and dropped the pictures, and the terminal pasted the first picture's path and dropped the text.
//
// What counts:
//   - an `<img>` whose source is a PNG, JPEG, GIF, WebP or BMP `data:` URI, or a LOCAL `file:///` path to
//     such a file. A network path (however it is spelled, see localFilePath), `https:`, `cid:` and SVG are
//     not taken — those were never part of the copy's bytes, and fetching one is not what a paste does.
//   - not a picture that declares a side under MIN_IMAGE_SIDE: a signature logo or a tracking pixel.
//   - at most MAX_RICH_IMAGES; the rest are dropped and counted.
// The result is `null` unless at least one picture is taken AND there is text or a second picture, so a
// copy of a single picture, of plain text, or of Excel cells (whose picture is a bitmap beside the HTML,
// never in it) keeps the paste path it always had.
//
// Electron-free (UMD). Parsing needs a DOMParser: the renderer's global, or `opts.parser` in a test.
// Called by: insertFromDataTransfer (terminal/terminal-manager.js), the composer's paste handler
// (session/conversation-view.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MAX_RICH_IMAGES = 10;
  const MIN_IMAGE_SIDE = 32;

  // Elements whose content is never text the user copied. `v:`/`w:` are Office's VML and Word markup; the
  // VML twin of each Outlook picture usually sits in a conditional comment, which the walk skips anyway.
  const SKIP = new Set(['head', 'style', 'script', 'title', 'template', 'noscript', 'meta', 'link', 'xml', 'object', 'iframe', 'svg']);
  const BLOCK = new Set([
    'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main', 'blockquote', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'tr', 'hr',
    'figure', 'figcaption', 'address', 'center',
  ]);
  const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

  // Private-use characters that cannot come from the copy's text: they hold places through the whitespace
  // normalisation below. SOFT is a block edge, PRE_SPACE a space inside <pre>, IMG_OPEN/CLOSE an image,
  // EMPTY_LINE a block that stands for an empty line.
  const SOFT = '\u0001';
  const PRE_SPACE = '\uE002';
  const IMG_OPEN = '\uE000';
  const IMG_CLOSE = '\uE001';
  const EMPTY_LINE = '\uE003';

  // Inline styles only: what a stylesheet hides is not knowable here. The source app's plain text, which a
  // rich paste replaces, would not carry text hidden this way either. Not `font-size:0` or `opacity:0`: mail
  // templates set the first on a column wrapper whose children set their own size again, so judging it
  // here would drop text and pictures the mail shows.
  function hidden(el) {
    const style = (el.getAttribute && el.getAttribute('style')) || '';
    return /display\s*:\s*none|mso-hide\s*:\s*all|visibility\s*:\s*hidden/i.test(style)
      || (el.hasAttribute && el.hasAttribute('hidden'));
  }

  // A local `file:///` URL to its path, or '' — `file:///C:/x` is `C:/x`, `file:///home/x` is `/home/x`.
  // Judged on the DECODED path: `file:///%5Cserver%5Cshare` and `file:///%2Fserver/share` decode to a
  // network path (`\\server\share`), and reading one is an SMB connection to whoever named it — the same
  // loophole #77 closed for transcript images. So: a drive letter with one separator, or exactly one leading
  // slash, and no `..` segment.
  function localFilePath(src) {
    if (!/^file:\/\/\//i.test(src)) return '';
    let p;
    try { p = decodeURIComponent(new URL(src).pathname); } catch { return ''; }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    const local = /^[A-Za-z]:[\\/](?![\\/])/.test(p) || /^\/(?![\\/])/.test(p);
    if (!local || /(^|[\\/])\.\.([\\/]|$)/.test(p)) return '';
    return p;
  }

  // What a session can read as a picture. SVG is markup, not a picture: web pages inline their icons as
  // `data:image/svg+xml`, and taking those would scatter them through every paste of page text.
  const IMAGE_MIME_RE = /^image\/(png|jpeg|gif|webp|bmp)$/i;

  function takeableSource(src) {
    const m = /^data:([^;,]+);base64,/i.exec(src);
    if (m) return IMAGE_MIME_RE.test(m[1]);
    const p = localFilePath(src);
    return !!p && IMAGE_FILE_RE.test(p);
  }

  // A declared side in pixels — a plain number, so `width="10%"` declares nothing.
  function tooSmall(img) {
    for (const attr of ['width', 'height']) {
      const v = String(img.getAttribute(attr) || '').trim();
      if (!/^\d+(?:px)?$/i.test(v)) continue;
      const n = parseInt(v, 10);
      if (n > 0 && n < MIN_IMAGE_SIDE) return true;
    }
    return false;
  }

  // `html` → { segments: [{ type: 'text', text } | { type: 'image', src }], dropped } or null.
  function richPasteSegments(html, opts = {}) {
    if (typeof html !== 'string' || !/<img\b/i.test(html)) return null;
    const parser = opts.parser || (typeof DOMParser !== 'undefined' ? new DOMParser() : null);
    if (!parser) return null;
    let doc;
    try { doc = parser.parseFromString(html, 'text/html'); } catch { return null; }
    if (!doc || !doc.body) return null;

    const images = [];
    let dropped = 0;
    let out = '';

    const walk = (node, pre) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          let s = String(child.nodeValue || '').replace(/\u00a0/g, ' ');
          s = pre ? s.replace(/ /g, PRE_SPACE) : s.replace(/[ \t\r\n\f]+/g, ' ');
          out += s;
          continue;
        }
        if (child.nodeType !== 1) continue; // comments — Outlook's conditional VML among them
        const tag = String(child.localName || '').toLowerCase();
        if (SKIP.has(tag) || /^[vw]:/.test(tag) || hidden(child)) continue;
        if (tag === 'br') { out += '\n'; continue; }
        if (tag === 'img') {
          const src = String(child.getAttribute('src') || '').trim();
          if (!takeableSource(src) || tooSmall(child)) continue;
          if (images.length >= MAX_RICH_IMAGES) { dropped++; continue; }
          out += IMG_OPEN + images.length + IMG_CLOSE;
          images.push(src);
          continue;
        }
        if ((tag === 'td' || tag === 'th') && child.previousElementSibling) out += '\t';
        const block = BLOCK.has(tag);
        if (block) out += SOFT;
        if (tag === 'li') {
          const list = child.parentElement;
          if (list && String(list.localName).toLowerCase() === 'ol') {
            const items = Array.from(list.children).filter(c => String(c.localName).toLowerCase() === 'li');
            out += `${items.indexOf(child) + 1}. `;
          } else {
            out += '- ';
          }
        }
        const mark = out.length;
        walk(child, pre || tag === 'pre');
        // `<p>&nbsp;</p>` is how Outlook spaces paragraphs, `<div><br></div>` how an editor does: an empty
        // line, which the block-edge collapsing below would otherwise swallow.
        if (block && !/[^\s\u0001]/.test(out.slice(mark))
          && (String(child.textContent || '').includes(' ') || child.querySelector('br'))) {
          out = out.slice(0, mark) + EMPTY_LINE;
        }
        if (block) out += SOFT;
      }
    };
    walk(doc.body, false);

    if (!images.length) return null;

    const text = out
      .replace(/ {2,}/g, ' ')
      // A run of block edges is one line break; a <br> that ends a block adds none of its own.
      .replace(new RegExp(`(?:\\n *)?${SOFT}[${SOFT} ]*`, 'g'), '\n')
      .replace(new RegExp(EMPTY_LINE, 'g'), '')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      // After the trim, so a <pre> that opens the copy keeps its first line's indentation.
      .replace(new RegExp(PRE_SPACE, 'g'), ' ');

    const segments = [];
    const parts = text.split(new RegExp(`${IMG_OPEN}(\\d+)${IMG_CLOSE}`));
    for (let i = 0; i < parts.length; i++) {
      if (i % 2) segments.push({ type: 'image', src: images[Number(parts[i])] });
      else if (parts[i]) segments.push({ type: 'text', text: parts[i] });
    }
    const hasText = segments.some(s => s.type === 'text' && s.text.trim());
    if (!hasText && images.length < 2) return null;
    return { segments, dropped };
  }

  // The bytes of one image segment, or null. `api` is `window.api` (a `file:` source is read by main through
  // `readFileDataUrl`, which refuses a sensitive path); `maxBytes` is measured before anything is decoded.
  async function richPasteImageBytes(src, api, maxBytes) {
    let dataUrl = src;
    const p = localFilePath(src);
    if (p) {
      if (!api || typeof api.readFileDataUrl !== 'function') return null;
      let res = null;
      try { res = await api.readFileDataUrl(p); } catch { return null; }
      if (!res || !res.ok || typeof res.dataUrl !== 'string') return null;
      dataUrl = res.dataUrl;
    }
    const comma = dataUrl.indexOf(',');
    const head = comma < 0 ? '' : dataUrl.slice(0, comma);
    const m = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(head);
    if (!m || !IMAGE_MIME_RE.test(m[1])) return null;
    const b64 = dataUrl.slice(comma + 1).replace(/\s+/g, '');
    // 4 base64 chars carry 3 bytes — measure before decoding, not after.
    if (!b64 || (maxBytes && (b64.length / 4) * 3 > maxBytes)) return null;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.length ? { bytes, mime: m[1].toLowerCase() } : null;
    } catch { return null; }
  }

  return { richPasteSegments, richPasteImageBytes, MAX_RICH_IMAGES, MIN_IMAGE_SIDE };
});
