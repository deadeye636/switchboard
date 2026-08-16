// Tests for the internal editor's formatting commands (#281).
//
// These are the whole toolbar: every button dispatches exactly one of these
// change specs. They are pure string functions, so the button behaviour is
// testable without CodeMirror, without a DOM and without Electron — which is
// the point of keeping them in their own file.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../src/renderer/views/format-commands');

// Apply a change spec to a document the way CodeMirror would, and report where
// the selection ends up. Every assertion below goes through this, so a spec that
// computes the right text but the wrong offsets still fails.
function apply(doc, from, to, fn, ...args) {
  const c = fn(doc, from, to, ...args);
  const next = doc.slice(0, c.from) + c.insert + doc.slice(c.to);
  return { text: next, anchor: c.anchor, head: c.head, selected: next.slice(c.anchor, c.head) };
}

const cmd = (kind, id) => fmt.formatCommandsFor(kind).find((c) => c.id === id).run;

// --- inline wrapping --------------------------------------------------------

test('bold wraps the selection and keeps it selected', () => {
  const r = apply('hello world', 6, 11, cmd('markdown', 'bold'));
  assert.equal(r.text, 'hello **world**');
  assert.equal(r.selected, 'world');
});

test('bold with a caret inside a word takes the word', () => {
  const r = apply('hello world', 8, 8, cmd('markdown', 'bold'));
  assert.equal(r.text, 'hello **world**');
  assert.equal(r.selected, 'world');
});

test('bold on an empty line leaves the caret between the markers', () => {
  const r = apply('', 0, 0, cmd('markdown', 'bold'));
  assert.equal(r.text, '****');
  assert.equal(r.anchor, 2);
  assert.equal(r.head, 2);
});

test('bold twice removes the markers again (selection outside)', () => {
  const r = apply('hello **world**', 8, 13, cmd('markdown', 'bold'));
  assert.equal(r.text, 'hello world');
  assert.equal(r.selected, 'world');
});

test('bold removes the markers when they are inside the selection', () => {
  const r = apply('hello **world**', 6, 15, cmd('markdown', 'bold'));
  assert.equal(r.text, 'hello world');
  assert.equal(r.selected, 'world');
});

test('italic, strikethrough and inline code use their own markers', () => {
  assert.equal(apply('a b', 2, 3, cmd('markdown', 'italic')).text, 'a *b*');
  assert.equal(apply('a b', 2, 3, cmd('markdown', 'strikethrough')).text, 'a ~~b~~');
  assert.equal(apply('a b', 2, 3, cmd('markdown', 'code')).text, 'a `b`');
});

test('italic does not mistake a bold pair for its own markers', () => {
  // The selection sits inside **word**; the neighbours are '*', so a naive
  // outside-check would unwrap half of the bold pair.
  const r = apply('**word**', 2, 6, cmd('markdown', 'italic'));
  assert.equal(r.text, '***word***');
});

// --- the HTML four in a Markdown file ---------------------------------------

test('underline writes a <u> pair and toggles it off', () => {
  const u = cmd('markdown', 'underline');
  const once = apply('a word', 2, 6, u);
  assert.equal(once.text, 'a <u>word</u>');
  assert.equal(apply(once.text, once.anchor, once.head, u).text, 'a word');
});

test('text colour and highlight write the palette value, never free-form CSS', () => {
  assert.equal(
    apply('a word', 2, 6, cmd('markdown', 'color'), '#e5484d').text,
    'a <span style="color:#e5484d">word</span>',
  );
  assert.equal(
    apply('a word', 2, 6, cmd('markdown', 'highlight'), '#fff3a3').text,
    'a <mark style="background:#fff3a3">word</mark>',
  );
});

test('the palettes are fixed lists of hex values', () => {
  for (const c of [...fmt.FORMAT_TEXT_COLORS, ...fmt.FORMAT_HIGHLIGHT_COLORS]) {
    assert.match(c.value, /^#[0-9a-f]{6}$/);
    assert.ok(c.label.length > 0);
  }
});

test('alignment wraps the block, re-tags a different value and unwraps the same one', () => {
  const once = apply('centre me', 0, 9, fmt.alignBlock, 'center');
  assert.equal(once.text, '<div align="center">\ncentre me\n</div>');

  const retag = apply(once.text, 0, once.text.length, fmt.alignBlock, 'right');
  assert.equal(retag.text, '<div align="right">\ncentre me\n</div>');

  const off = apply(retag.text, 0, retag.text.length, fmt.alignBlock, 'right');
  assert.equal(off.text, 'centre me');
});

// --- Markdown line commands -------------------------------------------------

test('bullet list prefixes every selected line and toggles them all off', () => {
  const doc = 'one\ntwo\nthree';
  const on = apply(doc, 0, doc.length, fmt.mdBulletList);
  assert.equal(on.text, '- one\n- two\n- three');
  assert.equal(apply(on.text, 0, on.text.length, fmt.mdBulletList).text, doc);
});

test('numbered list renumbers rather than repeating "1."', () => {
  const doc = 'one\ntwo\nthree';
  assert.equal(apply(doc, 0, doc.length, fmt.mdOrderedList).text, '1. one\n2. two\n3. three');
});

test('switching list type replaces the marker instead of stacking it', () => {
  const bullets = apply('one\ntwo', 0, 7, fmt.mdBulletList).text;
  const numbers = apply(bullets, 0, bullets.length, fmt.mdOrderedList).text;
  assert.equal(numbers, '1. one\n2. two');
  assert.equal(apply(numbers, 0, numbers.length, fmt.mdTaskList).text, '- [ ] one\n- [ ] two');
});

test('a task list is not read as a bullet list', () => {
  // Bullet toggle must not strip the checkbox — it would silently destroy state.
  const tasks = '- [ ] one\n- [ ] two';
  assert.equal(apply(tasks, 0, tasks.length, fmt.mdBulletList).text, '- one\n- two');
});

test('blockquote stacks with a list on purpose', () => {
  const list = '- one\n- two';
  assert.equal(apply(list, 0, list.length, fmt.mdBlockquote).text, '> - one\n> - two');
});

test('a line command started mid-line still takes the whole line', () => {
  assert.equal(apply('one\ntwo', 5, 5, fmt.mdBulletList).text, 'one\n- two');
});

test('heading sets a level, replaces a different one and toggles the same one off', () => {
  assert.equal(apply('Title', 0, 5, fmt.mdHeading, 2).text, '## Title');
  assert.equal(apply('## Title', 0, 8, fmt.mdHeading, 1).text, '# Title');
  assert.equal(apply('## Title', 0, 8, fmt.mdHeading, 2).text, 'Title');
  assert.equal(apply('## Title', 0, 8, fmt.mdHeading, 0).text, 'Title');
});

// --- Markdown insertions ----------------------------------------------------

test('link puts the caret on the URL, with or without a selection', () => {
  const withSel = apply('see docs', 4, 8, fmt.mdLink);
  assert.equal(withSel.text, 'see [docs](url)');
  assert.equal(withSel.selected, 'url');

  const empty = apply('', 0, 0, fmt.mdLink);
  assert.equal(empty.text, '[text](url)');
  assert.equal(empty.selected, 'text');
});

test('table and rule take a line of their own', () => {
  assert.equal(apply('', 0, 0, fmt.mdHorizontalRule).text, '---');
  assert.equal(apply('para', 4, 4, fmt.mdHorizontalRule).text, 'para\n---');

  const table = apply('', 0, 0, fmt.mdTable);
  assert.equal(table.text.split('\n').length, 4);
  assert.ok(table.text.startsWith('| Column 1 '));
});

// --- clear formatting -------------------------------------------------------

test('clear formatting strips inline markers and the line prefix', () => {
  const doc = '## **Bold** and *it* and `code`';
  assert.equal(apply(doc, 0, doc.length, fmt.mdClearFormatting).text, 'Bold and it and code');
});

test('clear formatting strips the HTML the toolbar writes', () => {
  const doc = '<u>a</u> <span style="color:#e5484d">b</span> <mark style="background:#fff3a3">c</mark>';
  assert.equal(apply(doc, 0, doc.length, fmt.mdClearFormatting).text, 'a b c');
});

test('clear formatting with no selection clears the caret line only', () => {
  const doc = '**one**\n**two**';
  assert.equal(apply(doc, 0, 0, fmt.mdClearFormatting).text, 'one\n**two**');
});

test('the HTML table clears tags but leaves Markdown markers alone', () => {
  // A literal '*' in an HTML file is an asterisk, not emphasis — stripping it
  // there would silently eat the author's text.
  const doc = '<strong>a</strong> *not emphasis*';
  assert.equal(apply(doc, 0, doc.length, fmt.htmlClearFormatting).text, 'a *not emphasis*');
});

// --- the HTML kind ----------------------------------------------------------

test('HTML inline commands write tags, not Markdown markers', () => {
  assert.equal(apply('a b', 2, 3, cmd('html', 'bold')).text, 'a <strong>b</strong>');
  assert.equal(apply('a b', 2, 3, cmd('html', 'italic')).text, 'a <em>b</em>');
  assert.equal(apply('a b', 2, 3, cmd('html', 'code')).text, 'a <code>b</code>');
});

test('HTML heading wraps each line and toggles the same level off', () => {
  const on = apply('Title', 0, 5, fmt.htmlHeading, 2);
  assert.equal(on.text, '<h2>Title</h2>');
  assert.equal(apply(on.text, 0, on.text.length, fmt.htmlHeading, 3).text, '<h3>Title</h3>');
  assert.equal(apply(on.text, 0, on.text.length, fmt.htmlHeading, 2).text, 'Title');
});

test('HTML list nests items in a wrapper and removes the wrapper when toggled off', () => {
  const doc = 'one\ntwo';
  const on = apply(doc, 0, doc.length, fmt.htmlList, 'ul');
  assert.equal(on.text, '<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>');
  assert.equal(apply(on.text, 0, on.text.length, fmt.htmlList, 'ul').text, doc);
});

test('switching an HTML list type does not nest one list inside the other', () => {
  const ul = apply('one\ntwo', 0, 7, fmt.htmlList, 'ul').text;
  const ol = apply(ul, 0, ul.length, fmt.htmlList, 'ol').text;
  assert.equal(ol.split('<ul>').length, 1, 'the <ul> wrapper must be gone');
  assert.ok(ol.startsWith('<ol>'));
  assert.equal(ol.match(/<li>/g).length, 2);
});

test('HTML blockquote wraps the block and unwraps it again', () => {
  const on = apply('quoted', 0, 6, fmt.htmlBlockWrap, 'blockquote');
  assert.equal(on.text, '<blockquote>\nquoted\n</blockquote>');
  assert.equal(apply(on.text, 0, on.text.length, fmt.htmlBlockWrap, 'blockquote').text, 'quoted');
});

test('HTML link selects the href placeholder', () => {
  const r = apply('see docs', 4, 8, fmt.htmlLink);
  assert.equal(r.text, 'see <a href="url">docs</a>');
  assert.equal(r.selected, 'url');
});

test('HTML rule and table own their line', () => {
  assert.equal(apply('para', 4, 4, fmt.htmlRule).text, 'para\n<hr>');
  assert.ok(apply('', 0, 0, fmt.htmlTable).text.startsWith('<table>'));
});

// --- the command tables -----------------------------------------------------

test('every command declares a row and either a run or a history kind', () => {
  for (const table of [fmt.MD_COMMANDS, fmt.HTML_COMMANDS]) {
    for (const c of table) {
      assert.ok(c.id, 'command needs an id');
      assert.ok(c.row === 1 || c.row === 2, `${c.id}: row must be 1 or 2`);
      assert.ok(c.label, `${c.id}: needs a label`);
      assert.ok(typeof c.run === 'function' || c.kind === 'history', `${c.id}: needs run() or kind history`);
      if (c.kind === 'menu') assert.ok(Array.isArray(c.options) && c.options.length, `${c.id}: menu needs options`);
    }
  }
});

test('command ids are unique within each table', () => {
  for (const table of [fmt.MD_COMMANDS, fmt.HTML_COMMANDS]) {
    const ids = table.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('editorToolbarHtmlTags off drops exactly the four HTML commands from Markdown', () => {
  const all = fmt.formatCommandsFor('markdown', { htmlTags: true }).map((c) => c.id);
  const plain = fmt.formatCommandsFor('markdown', { htmlTags: false }).map((c) => c.id);
  assert.deepEqual(all.filter((id) => !plain.includes(id)).sort(), ['align', 'color', 'highlight', 'underline']);
});

test('the switch does not touch the HTML table — there, tags are the format', () => {
  const on = fmt.formatCommandsFor('html', { htmlTags: true }).map((c) => c.id);
  const off = fmt.formatCommandsFor('html', { htmlTags: false }).map((c) => c.id);
  assert.deepEqual(on, off);
});

test('a kind with no toolbar gets no commands', () => {
  assert.deepEqual(fmt.formatCommandsFor('text'), []);
  assert.deepEqual(fmt.formatCommandsFor(undefined), []);
});

test('no Markdown command writes an HTML tag unless it is marked html', () => {
  // The guard that keeps the sanitiser surface where #49 left it: a new command
  // that emits a tag has to declare itself, or this fails.
  const doc = 'sample text';
  for (const c of fmt.MD_COMMANDS) {
    if (typeof c.run !== 'function') continue;
    const arg = c.kind === 'menu' ? c.options[0].value : undefined;
    const out = c.run(doc, 0, doc.length, arg).insert;
    if (/<[a-z]/i.test(out)) {
      assert.ok(c.html === true, `${c.id} emits HTML but is not marked html: true`);
    }
  }
});
