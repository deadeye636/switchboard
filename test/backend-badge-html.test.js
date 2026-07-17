// backend-icons.js — `backendBadgeHtml`, the MARKUP form of the badge (#202).
//
// Why this file exists: the badge is deliberately built as a DOM tree (createElementNS + textContent) so a
// user-supplied id can never inject markup. `backendBadgeHtml` serializes that tree with `outerHTML` and
// hands the string to a view that renders it into innerHTML (tasks-view / bookmarks-view build their rows
// as template strings). That is safe ONLY because the serializer escapes on the way out — so it is worth a
// test rather than a comment. A refactor to string concatenation would keep every other test green.
//
// An Axis-A profile id IS user-named, so this is a real input, not a hypothetical one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function loadBadges() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'backends', 'backend-icons.js'), 'utf8');
  vm.runInContext(src, ctx);
  return dom.window;
}

test('backendBadgeHtml returns markup for a key and nothing for none', () => {
  const w = loadBadges();
  const html = w.backendBadgeHtml('codex', 12);
  assert.match(html, /^<svg/, 'a key yields an svg');
  assert.match(html, /width="12"/, 'the requested size is honoured');
  assert.match(html, />Cx</, "codex' monogram is in the markup");

  // A caller concatenates this unconditionally (`badge + escapeHtml(name)`), so "no backend" must be an
  // empty string, not "undefined" or a default badge that would claim the wrong CLI.
  assert.equal(w.backendBadgeHtml(null, 12), '', 'no key -> no badge');
  assert.equal(w.backendBadgeHtml('', 12), '', 'empty key -> no badge');
});

test('backendBadgeHtml cannot break out of the markup — a hostile id injects nothing (XSS)', () => {
  const w = loadBadges();
  // A profile named like this is what the createElementNS/textContent design exists for. It reaches the
  // badge as BOTH a class attribute and (via the derived monogram) text.
  const evil = '"><img src=x onerror=alert(1)>';
  const html = w.backendBadgeHtml(evil, 12);

  // The guarantee is NOT "the payload's characters are absent" — HTML attribute serialization escapes only
  // `&`, `"` and NBSP, so `<img …>` stays literal INSIDE the quoted class value. What makes that inert is
  // that the quote which would END the attribute is escaped, so the payload can never become markup.
  assert.ok(html.includes('&quot;'), 'the quote that would terminate the attribute is escaped');

  // The property that actually matters: rendered the way tasks-view/bookmarks-view render it, it injects
  // nothing and wires no handler.
  const dom = new JSDOM('<!DOCTYPE html><body><div id="meta"></div></body>');
  const doc = dom.window.document;
  doc.getElementById('meta').innerHTML = html;
  assert.equal(doc.querySelectorAll('img').length, 0, 'no element was injected');
  assert.equal(doc.querySelectorAll('svg').length, 1, 'only the badge itself rendered');
  assert.equal(doc.querySelectorAll('[onerror]').length, 0, 'no event handler was parsed into the DOM');
  // The payload survives only as inert text of the class attribute — never as a node.
  assert.match(doc.querySelector('svg').getAttribute('class'), /<img/, 'it is attribute TEXT, not markup');
});

// --- the artwork branch (#212) -----------------------------------------------------------------
// A backend with a real logo declares `icon: '<slug>'` and backend-icons.js draws it from ART; every
// other key still gets the monogram badge. This replaced the last hardcoded backend in dialogs.js,
// where Anthropic's logo was a raw SVG string emitted only when the id read `claude`.

test('a key with artwork renders the logo, not a monogram badge', () => {
  const w = loadBadges();
  const svg = w.renderBackendIcon('anthropic', 16);
  assert.equal(svg.querySelectorAll('path').length, 1, 'the artwork path is drawn');
  assert.equal(svg.querySelectorAll('rect').length, 0, 'a logo carries no badge square behind it');
  assert.equal(svg.querySelectorAll('text').length, 0, 'a logo carries no monogram glyph');
  assert.equal(svg.getAttribute('viewBox'), '0 0 1200 1200', "the artwork's own viewBox is used, not the size box");
  assert.equal(svg.getAttribute('width'), '16', 'the requested size is honoured');
  assert.match(svg.querySelector('path').getAttribute('d'), /^M 233\.959793/, 'the path data actually reached the node');
});

test('a key without artwork still renders the monogram badge — that stays the norm', () => {
  const w = loadBadges();
  for (const id of ['codex', 'hermes', 'pi', 'agy', 'some-future-cli']) {
    const svg = w.renderBackendIcon(id, 16);
    assert.equal(svg.querySelectorAll('rect').length, 1, `${id} keeps its badge square`);
    assert.equal(svg.querySelectorAll('text').length, 1, `${id} keeps its glyph`);
  }
});

// The icon slug is USER-SUPPLIED for an Axis-A profile, and a plain object answers to every name on
// Object.prototype. Without an own-property check `ART['constructor']` is truthy, so this profile would
// take the artwork branch and draw <path d="undefined"> — a broken icon, silently, for a name a user can
// actually type into the profile editor. Same for COLOURS and MONOGRAMS.
test('a slug that names an Object.prototype member falls through to the monogram', () => {
  const w = loadBadges();
  for (const slug of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const svg = w.renderBackendIcon(slug, 16);
    assert.equal(svg.querySelectorAll('path').length, 0, `"${slug}" must not reach the artwork branch`);
    assert.equal(svg.querySelectorAll('rect').length, 1, `"${slug}" renders an ordinary badge`);
    const fill = svg.querySelector('rect').getAttribute('fill');
    assert.match(fill, /^#[0-9a-f]{6}$/i, `"${slug}" resolves to a real colour, not a stringified function (got ${fill})`);
    const glyph = svg.querySelector('text').textContent;
    assert.ok(glyph.length <= 2, `"${slug}" derives a short glyph, not a stringified prototype member (got ${glyph.slice(0, 40)})`);
  }
});

test('backendBadgeHtml gives every backend a badge without knowing the backend (descriptor-driven)', () => {
  const w = loadBadges();
  // The views pass whatever `backendId` the row carries — no branching, no list. An id the icon table has
  // never heard of must still produce a badge (a derived monogram), or a new backend would render blank.
  for (const id of ['claude', 'codex', 'hermes', 'pi', 'agy', 'some-future-cli']) {
    assert.match(w.backendBadgeHtml(id, 12), /^<svg[\s\S]*<\/svg>$/, `${id} renders a badge`);
  }
});
