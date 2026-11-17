'use strict';

// The unified-diff drawing the changes window and the session Details window share (#870). It was cut out of
// `changed-files.js` unchanged, so the first test holds the OLD implementation (copied here as the reference) against the new
// one over the shapes a diff carries; the rest pin what a diff line must never do (reach the page unescaped).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderDiff, diffBarHtml, DIFF_WINDOW_THRESHOLD } = require('../src/renderer/diff-render');

// What `changed-files.js` drew before the extraction: the reference the factored function must agree with.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function referenceRenderDiff(text) {
  if (!text || !text.trim()) return '<div class="diff-empty">No textual changes.</div>';
  const lines = text.split('\n').slice(0, 4000);
  const html = lines.map((l) => {
    const e = esc(l);
    if (l.startsWith('+++') || l.startsWith('---')) return '<span class="d-meta">' + e + '</span>';
    if (l[0] === '+') return '<span class="d-add">' + e + '</span>';
    if (l[0] === '-') return '<span class="d-del">' + e + '</span>';
    if (l.startsWith('@@')) return '<span class="d-hunk">' + e + '</span>';
    if (/^(diff |index |new file|deleted |rename |similarity |Binary )/.test(l)) return '<span class="d-meta">' + e + '</span>';
    return e;
  }).join('\n');
  return '<pre class="diff-pre">' + html + '</pre>';
}
function referenceBar(text) {
  const lineCount = text ? text.split('\n').length : 0;
  return lineCount > 200
    ? '<div class="diff-bar"><span class="diff-bar-info">' + lineCount + ' lines</span>'
      + '<button class="diff-expand" title="Open this diff in a side-by-side window">Open in window ⤢</button></div>'
    : '';
}

const FIXTURES = {
  modified: 'diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@ fn()\n keep\n-old\n+new\n',
  added: 'diff --git a/n.js b/n.js\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1 @@\n+hello\n',
  renamed: 'diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n',
  binary: 'Binary files a/i.png and b/i.png differ\n',
  markup: '+<script>alert("x")</script>\n-<img src=x onerror=1>\n context & more',
  empty: '',
  blank: '   \n  ',
  untracked: '+line one\n+line two',
};

test('the factored renderDiff draws exactly what changed-files.js drew before', () => {
  for (const [name, text] of Object.entries(FIXTURES)) assert.equal(renderDiff(text), referenceRenderDiff(text), name);
  assert.equal(renderDiff(null), referenceRenderDiff(null));
});

test('a line that is markup is escaped, in every colour class', () => {
  const html = renderDiff(FIXTURES.markup);
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  assert.match(html, /<span class="d-add">\+&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<\/span>/);
  assert.match(html, /<span class="d-del">-&lt;img src=x onerror=1&gt;<\/span>/);
  assert.match(html, /context &amp; more/);
});

test('a diff is cut at 4000 lines, as before', () => {
  const text = Array.from({ length: 5000 }, (_, i) => '+l' + i).join('\n');
  assert.equal(renderDiff(text), referenceRenderDiff(text));
  assert.ok(!renderDiff(text).includes('+l4000<'));
});

test('the large-diff bar appears above the threshold only, with the same markup', () => {
  assert.equal(DIFF_WINDOW_THRESHOLD, 200);
  const small = Array.from({ length: 200 }, () => '+x').join('\n');
  const large = Array.from({ length: 201 }, () => '+x').join('\n');
  assert.equal(diffBarHtml(small), '');
  assert.equal(diffBarHtml(small), referenceBar(small));
  assert.equal(diffBarHtml(large), referenceBar(large));
  assert.match(diffBarHtml(large), /201 lines/);
  assert.equal(diffBarHtml(''), '');
  assert.equal(diffBarHtml(undefined), '');
});
