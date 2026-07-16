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
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'backend-icons.js'), 'utf8');
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

test('backendBadgeHtml gives every backend a badge without knowing the backend (descriptor-driven)', () => {
  const w = loadBadges();
  // The views pass whatever `backendId` the row carries — no branching, no list. An id the icon table has
  // never heard of must still produce a badge (a derived monogram), or a new backend would render blank.
  for (const id of ['claude', 'codex', 'hermes', 'pi', 'agy', 'some-future-cli']) {
    assert.match(w.backendBadgeHtml(id, 12), /^<svg[\s\S]*<\/svg>$/, `${id} renders a badge`);
  }
});
