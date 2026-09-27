'use strict';
// Which scripts does a renderer page load, and in what order? (#677)
//
// Several tests read one of the renderer's own HTML pages to find the scripts it loads: to build the same
// environment in jsdom, to resolve a basename to its folder, or to assert that a page loads a file at all.
// Each used to carry its own copy of a pattern over the whole tag, `<script src="…"></script>`, and CodeQL
// flags every such copy as `js/bad-tag-filter` ("Bad HTML filtering regexp") — code-scanning alerts #4, #15,
// #16 and #17 were that one pattern, each dismissed as "used in tests", and each new copy raised another.
//
// The input is the repo's own page and nothing is ever rendered, so those alerts were false positives. What
// the copies really had in common was the chance to drift apart: two of them required exactly one space
// before `src`, one allowed any whitespace, and none would have seen a tag with a second attribute. So the
// pattern lives here once, reads only the OPENING tag, and accepts any attribute order and spacing.
// `test/page-scripts.test.js` refuses a copy anywhere else under `test/`.

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

// The `src` of a `<script>` or the `href` of a `<link>`, in document order. Only the opening tag is read,
// which is all a list of references needs; the value may be double-quoted, single-quoted or bare.
const REF = /<(script|link)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Every `<script src>` and `<link href>` in `html`, in document order: `[{ tag, ref }]`. */
function pageRefsOf(html) {
  const out = [];
  for (const m of String(html).matchAll(REF)) {
    const ref = m[2] ?? m[3] ?? m[4];
    if (ref) out.push({ tag: m[1].toLowerCase(), ref });
  }
  return out;
}

/** The `src` of every `<script>` in `html`, in document order. */
function scriptSrcsOf(html) {
  return pageRefsOf(html).filter(r => r.tag === 'script').map(r => r.ref);
}

/** The scripts a page under `src/renderer/` loads, in order — `pageScripts('settings.html')`. */
function pageScripts(page) {
  return scriptSrcsOf(fs.readFileSync(path.join(RENDERER, page), 'utf8'));
}

/** Every page under `src/renderer/`, read from the directory so a page added tomorrow is covered today. */
function rendererPages() {
  return fs.readdirSync(RENDERER).filter(f => f.endsWith('.html')).sort();
}

module.exports = { pageRefsOf, scriptSrcsOf, pageScripts, rendererPages, RENDERER };
