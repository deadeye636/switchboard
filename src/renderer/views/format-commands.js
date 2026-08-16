// --- Formatting commands for the internal editor's toolbar (#281) ---
//
// Every button in the viewer's format bar is one of these: a pure function from
// (doc, from, to) to a single CodeMirror change spec. No DOM, no CodeMirror, no
// editor state — the toolbar builds the change and dispatches it, this file only
// decides what the text should become.
//
// Two tables, one per previewable kind. They are separate on purpose rather than
// parameterised: Markdown formats blocks with a LINE PREFIX and HTML formats them
// by NESTING A TAG, so a list command shares nothing between them but its name.
// The inline commands genuinely are the same function with different markers.
//
// The four HTML commands in the Markdown table (underline, colour, highlight,
// alignment) write tags the Markdown preview already renders: `marked` passes raw
// HTML through and DOMPurify's default allowlist keeps <u>, <mark>, <span style>
// and <div align> while stripping event handlers. They add no sanitiser surface —
// they only make it easier to write what a hand-typed tag already does. Colour and
// highlight draw from a fixed palette so no free-form CSS ever reaches a file
// (#49 stays as narrow as it is).
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM/browser APIs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A change spec, in CodeMirror's shape plus the selection to restore:
  //   { from, to, insert, anchor, head }
  // `anchor`/`head` are absolute offsets in the document AFTER the change.

  const TEXT_COLORS = [
    { value: '#e5484d', label: 'Red' },
    { value: '#f76b15', label: 'Orange' },
    { value: '#ffb224', label: 'Amber' },
    { value: '#30a46c', label: 'Green' },
    { value: '#0091ff', label: 'Blue' },
    { value: '#8e4ec6', label: 'Purple' },
    { value: '#e93d82', label: 'Pink' },
    { value: '#889096', label: 'Grey' },
  ];

  const HIGHLIGHT_COLORS = [
    { value: '#fff3a3', label: 'Yellow' },
    { value: '#c9f0d4', label: 'Green' },
    { value: '#cfe4ff', label: 'Blue' },
    { value: '#f3d9ff', label: 'Purple' },
    { value: '#ffd7e0', label: 'Pink' },
    { value: '#ffe0c2', label: 'Orange' },
    { value: '#d9f2f5', label: 'Teal' },
    { value: '#e6e8eb', label: 'Grey' },
  ];

  const HEADING_OPTIONS = [
    { value: 1, label: 'Heading 1' },
    { value: 2, label: 'Heading 2' },
    { value: 3, label: 'Heading 3' },
    { value: 4, label: 'Heading 4' },
    { value: 5, label: 'Heading 5' },
    { value: 6, label: 'Heading 6' },
    { value: 0, label: 'No heading' },
  ];

  const ALIGN_OPTIONS = [
    { value: 'left', label: 'Align left' },
    { value: 'center', label: 'Align centre' },
    { value: 'right', label: 'Align right' },
  ];

  // ── Text helpers ───────────────────────────────────────────────────────────

  function lineStartOf(doc, pos) {
    const nl = doc.lastIndexOf('\n', pos - 1);
    return nl < 0 ? 0 : nl + 1;
  }

  function lineEndOf(doc, pos) {
    const nl = doc.indexOf('\n', pos);
    return nl < 0 ? doc.length : nl;
  }

  // An empty selection inside a word behaves as if the word were selected —
  // clicking Bold with the caret in "word" is meant to embolden that word, not
  // to drop an empty pair of markers into it.
  function expandToWord(doc, from, to) {
    if (from !== to) return [from, to];
    const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch);
    let s = from;
    let e = to;
    while (s > 0 && isWord(doc[s - 1])) s--;
    while (e < doc.length && isWord(doc[e])) e++;
    return [s, e];
  }

  function keep(from, to, insert) {
    return { from, to, insert, anchor: from, head: from + insert.length };
  }

  function selectedBlock(doc, from, to) {
    const start = lineStartOf(doc, from);
    const end = lineEndOf(doc, to);
    return { start, end, text: doc.slice(start, end) };
  }

  function mapSelectedLines(doc, from, to, mapper) {
    const { start, end, text } = selectedBlock(doc, from, to);
    const insert = mapper(text.split('\n')).join('\n');
    return keep(start, end, insert);
  }

  // ── Inline wrapping (shared by both kinds) ─────────────────────────────────

  // Toggles: the markers come off when they are already there, whether they sit
  // inside the selection ("**bold**" selected) or just outside it ("bold" selected
  // between two existing asterisk pairs).
  //
  // The `uniform` guard is what keeps italic off a bold pair: "*" matches the
  // outer character of "**word**" too, and without the check clicking Italic on
  // that word would quietly turn bold into italic instead of adding it.
  function wrapSelection(doc, from, to, open, close) {
    close = close === undefined ? open : close;
    const [f, t] = expandToWord(doc, from, to);
    const sel = doc.slice(f, t);
    const uniform = open === close && /^(.)\1*$/.test(open);
    const ch = open[0];

    if (sel.length >= open.length + close.length
        && sel.startsWith(open) && sel.endsWith(close)
        && !(uniform && (sel[open.length] === ch || sel[sel.length - close.length - 1] === ch))) {
      const inner = sel.slice(open.length, sel.length - close.length);
      return keep(f, t, inner);
    }

    if (f >= open.length
        && doc.slice(f - open.length, f) === open
        && doc.slice(t, t + close.length) === close
        && !(uniform && (doc[f - open.length - 1] === ch || doc[t + close.length] === ch))) {
      return keep(f - open.length, t + close.length, sel);
    }

    const insert = open + sel + close;
    const anchor = f + open.length;
    return { from: f, to: t, insert, anchor, head: anchor + sel.length };
  }

  const wrapper = (open, close) => (doc, from, to) => wrapSelection(doc, from, to, open, close);

  const colorWrapper = (tag) => (doc, from, to, color) => (tag === 'mark'
    ? wrapSelection(doc, from, to, `<mark style="background:${color}">`, '</mark>')
    : wrapSelection(doc, from, to, `<span style="color:${color}">`, '</span>'));

  const mdTextColor = colorWrapper('span');
  const mdHighlight = colorWrapper('mark');

  // ── Markdown: line commands ────────────────────────────────────────────────

  const LIST_PREFIX = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+\. )/;
  const HEADING_PREFIX = /^(\s*)#{1,6} /;

  const BULLET_MATCH = /^(\s*)[-*+] (?!\[[ xX]\] )/;
  const ORDERED_MATCH = /^(\s*)\d+\. /;
  const TASK_MATCH = /^(\s*)[-*+] \[[ xX]\] /;
  const QUOTE_MATCH = /^(\s*)> /;

  function stripListPrefix(line) {
    return line.replace(LIST_PREFIX, '$1');
  }

  function mdBulletList(doc, from, to) {
    return mapSelectedLines(doc, from, to, (lines) => {
      const on = lines.every((l) => BULLET_MATCH.test(l));
      return lines.map((l) => (on
        ? l.replace(BULLET_MATCH, '$1')
        : stripListPrefix(l).replace(/^(\s*)/, '$1- ')));
    });
  }

  function mdOrderedList(doc, from, to) {
    return mapSelectedLines(doc, from, to, (lines) => {
      const on = lines.every((l) => ORDERED_MATCH.test(l));
      return lines.map((l, i) => (on
        ? l.replace(ORDERED_MATCH, '$1')
        : stripListPrefix(l).replace(/^(\s*)/, `$1${i + 1}. `)));
    });
  }

  function mdTaskList(doc, from, to) {
    return mapSelectedLines(doc, from, to, (lines) => {
      const on = lines.every((l) => TASK_MATCH.test(l));
      return lines.map((l) => (on
        ? l.replace(TASK_MATCH, '$1')
        : stripListPrefix(l).replace(/^(\s*)/, '$1- [ ] ')));
    });
  }

  // Quotes stack with lists on purpose — "> - item" is valid and meant.
  function mdBlockquote(doc, from, to) {
    return mapSelectedLines(doc, from, to, (lines) => {
      const on = lines.every((l) => QUOTE_MATCH.test(l));
      return lines.map((l) => (on ? l.replace(QUOTE_MATCH, '$1') : l.replace(/^(\s*)/, '$1> ')));
    });
  }

  // level 0 removes the heading. Asking for the level every selected line already
  // has removes it too, so the same menu entry toggles.
  function mdHeading(doc, from, to, level) {
    return mapSelectedLines(doc, from, to, (lines) => {
      const want = `${'#'.repeat(level)} `;
      const already = level > 0 && lines.every((l) => l.replace(/^\s*/, '').startsWith(want));
      const effective = already ? 0 : level;
      return lines.map((l) => {
        const bare = l.replace(HEADING_PREFIX, '$1');
        return effective > 0 ? bare.replace(/^(\s*)/, `$1${'#'.repeat(effective)} `) : bare;
      });
    });
  }

  // ── Markdown: insertions ───────────────────────────────────────────────────

  function mdLink(doc, from, to) {
    const sel = doc.slice(from, to);
    if (sel) {
      const insert = `[${sel}](url)`;
      const anchor = from + sel.length + 3;
      return { from, to, insert, anchor, head: anchor + 3 };
    }
    return { from, to, insert: '[text](url)', anchor: from + 1, head: from + 5 };
  }

  const MD_TABLE = [
    '| Column 1 | Column 2 | Column 3 |',
    '| --- | --- | --- |',
    '|  |  |  |',
    '|  |  |  |',
  ].join('\n');

  // Both of these own their line: inserting a table into the middle of a paragraph
  // produces a paragraph, not a table.
  function insertBlock(doc, from, to, block) {
    const { start, end, text } = selectedBlock(doc, from, to);
    const lead = text.trim() ? `${text}\n` : '';
    return keep(start, end, `${lead}${block}`);
  }

  const mdTable = (doc, from, to) => insertBlock(doc, from, to, MD_TABLE);
  const mdHorizontalRule = (doc, from, to) => insertBlock(doc, from, to, '---');

  // ── Alignment (block-level HTML, used by both kinds) ───────────────────────

  const ALIGN_BLOCK = /^<div align="(left|center|right)">\n([\s\S]*)\n<\/div>$/;

  function alignBlock(doc, from, to, align) {
    const { start, end, text } = selectedBlock(doc, from, to);
    const m = text.match(ALIGN_BLOCK);
    if (m) {
      // Same alignment again unwraps; a different one is a re-tag, not a nest.
      return keep(start, end, m[1] === align ? m[2] : `<div align="${align}">\n${m[2]}\n</div>`);
    }
    return keep(start, end, `<div align="${align}">\n${text}\n</div>`);
  }

  // ── HTML: block commands ───────────────────────────────────────────────────

  function htmlBlockWrap(doc, from, to, tag, attrs) {
    const { start, end, text } = selectedBlock(doc, from, to);
    const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
    const closed = new RegExp(`^<${tag}(?:\\s[^>]*)?>\\n([\\s\\S]*)\\n</${tag}>$`);
    const m = text.match(closed);
    if (m) return keep(start, end, m[1]);
    return keep(start, end, `${open}\n${text}\n</${tag}>`);
  }

  const HTML_HEADING = /^<h([1-6])>([\s\S]*)<\/h\1>$/;

  function htmlHeading(doc, from, to, level) {
    return mapSelectedLines(doc, from, to, (lines) => {
      const parsed = lines.map((l) => l.match(HTML_HEADING));
      const already = level > 0 && parsed.every((m) => m && Number(m[1]) === level);
      const effective = already ? 0 : level;
      return lines.map((l, i) => {
        const bare = parsed[i] ? parsed[i][2] : l;
        return effective > 0 ? `<h${effective}>${bare}</h${effective}>` : bare;
      });
    });
  }

  const HTML_LIST_ITEM = /^\s*<li>([\s\S]*)<\/li>\s*$/;

  // A list is a wrapper plus one <li> per line, so it cannot be a per-line prefix
  // the way Markdown's is. Two consequences the Markdown version does not have:
  // toggling off has to drop the wrapper as well, and switching ul↔ol has to
  // REPLACE it — wrapping again would nest one list inside the other.
  function htmlList(doc, from, to, tag) {
    const { start, end, text } = selectedBlock(doc, from, to);
    const lines = text.split('\n');
    const openTag = lines[0].trim().match(/^<(ul|ol)>$/);
    const closeTag = lines[lines.length - 1].trim().match(/^<\/(ul|ol)>$/);
    const wrapped = lines.length >= 3 && openTag && closeTag && openTag[1] === closeTag[1];

    const body = wrapped ? lines.slice(1, -1) : lines;
    if (wrapped && openTag[1] === tag) {
      return keep(start, end, body.map((l) => {
        const m = l.match(HTML_LIST_ITEM);
        return m ? m[1] : l;
      }).join('\n'));
    }

    const items = body.map((l) => {
      const m = l.match(HTML_LIST_ITEM);
      return `  <li>${m ? m[1] : l}</li>`;
    });
    return keep(start, end, [`<${tag}>`, ...items, `</${tag}>`].join('\n'));
  }

  function htmlLink(doc, from, to) {
    const sel = doc.slice(from, to);
    const label = sel || 'text';
    const insert = `<a href="url">${label}</a>`;
    const anchor = from + 9;
    return { from, to, insert, anchor, head: anchor + 3 };
  }

  const HTML_TABLE = [
    '<table>',
    '  <tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr>',
    '  <tr><td></td><td></td><td></td></tr>',
    '  <tr><td></td><td></td><td></td></tr>',
    '</table>',
  ].join('\n');

  const htmlTable = (doc, from, to) => insertBlock(doc, from, to, HTML_TABLE);
  const htmlRule = (doc, from, to) => insertBlock(doc, from, to, '<hr>');

  // ── Clear formatting ───────────────────────────────────────────────────────

  const TAG_STRIPPERS = [
    [/<span style="color:[^"]*">([\s\S]*?)<\/span>/g, '$1'],
    [/<mark style="background:[^"]*">([\s\S]*?)<\/mark>/g, '$1'],
    [/<mark>([\s\S]*?)<\/mark>/g, '$1'],
    [/<(u|strong|em|b|i|s|code)>([\s\S]*?)<\/\1>/g, '$2'],
    [/<h([1-6])>([\s\S]*?)<\/h\1>/g, '$2'],
  ];

  const MD_STRIPPERS = [
    [/\*\*([\s\S]*?)\*\*/g, '$1'],
    [/__([\s\S]*?)__/g, '$1'],
    [/~~([\s\S]*?)~~/g, '$1'],
    [/\*([\s\S]*?)\*/g, '$1'],
    [/_([\s\S]*?)_/g, '$1'],
    [/`([^`]*?)`/g, '$1'],
  ];

  function clearWith(strippers, stripPrefixes) {
    // With no selection this clears the caret's line — an empty selection would
    // otherwise be a no-op button, which reads as broken.
    return function clearFormatting(doc, from, to) {
      const f = from === to ? lineStartOf(doc, from) : from;
      const t = from === to ? lineEndOf(doc, to) : to;
      const lines = doc.slice(f, t).split('\n').map((line) => {
        let out = line;
        if (stripPrefixes) {
          out = stripListPrefix(out.replace(HEADING_PREFIX, '$1').replace(QUOTE_MATCH, '$1'));
        }
        for (const [re, rep] of strippers) out = out.replace(re, rep);
        return out;
      });
      return keep(f, t, lines.join('\n'));
    };
  }

  const mdClearFormatting = clearWith([...TAG_STRIPPERS, ...MD_STRIPPERS], true);
  const htmlClearFormatting = clearWith(TAG_STRIPPERS, false);

  // ── The command tables the toolbar renders ─────────────────────────────────
  //
  // `row` is the format bar's row (1 = characters, 2 = blocks), `html` marks the
  // commands `editorToolbarHtmlTags: off` removes, `group` draws the separators.

  const MD_COMMANDS = [
    { id: 'undo', row: 1, group: 'history', label: 'Undo', kind: 'history' },
    { id: 'redo', row: 1, group: 'history', label: 'Redo', kind: 'history' },

    { id: 'bold', row: 1, group: 'inline', label: 'Bold', run: wrapper('**') },
    { id: 'italic', row: 1, group: 'inline', label: 'Italic', run: wrapper('*') },
    { id: 'strikethrough', row: 1, group: 'inline', label: 'Strikethrough', run: wrapper('~~') },
    { id: 'underline', row: 1, group: 'inline', label: 'Underline', html: true, run: wrapper('<u>', '</u>') },
    { id: 'code', row: 1, group: 'inline', label: 'Inline code', run: wrapper('`') },

    {
      id: 'color', row: 1, group: 'color', label: 'Text colour', html: true,
      kind: 'menu', options: TEXT_COLORS, swatch: true, run: mdTextColor,
    },
    {
      id: 'highlight', row: 1, group: 'color', label: 'Highlight', html: true,
      kind: 'menu', options: HIGHLIGHT_COLORS, swatch: true, run: mdHighlight,
    },

    { id: 'clear', row: 1, group: 'clear', label: 'Clear formatting', run: mdClearFormatting },

    { id: 'heading', row: 2, group: 'heading', label: 'Heading', kind: 'menu', options: HEADING_OPTIONS, run: mdHeading },

    { id: 'bullet-list', row: 2, group: 'list', label: 'Bullet list', run: mdBulletList },
    { id: 'ordered-list', row: 2, group: 'list', label: 'Numbered list', run: mdOrderedList },
    { id: 'task-list', row: 2, group: 'list', label: 'Task list', run: mdTaskList },
    { id: 'blockquote', row: 2, group: 'list', label: 'Blockquote', run: mdBlockquote },

    { id: 'link', row: 2, group: 'insert', label: 'Link', run: mdLink },
    { id: 'table', row: 2, group: 'insert', label: 'Table', run: mdTable },
    { id: 'rule', row: 2, group: 'insert', label: 'Horizontal rule', run: mdHorizontalRule },

    { id: 'align', row: 2, group: 'align', label: 'Alignment', html: true, kind: 'menu', options: ALIGN_OPTIONS, run: alignBlock },
  ];

  // No task list here: HTML has no native one, and the checkbox input a plugin
  // would emit is a control, not formatting.
  const HTML_COMMANDS = [
    { id: 'undo', row: 1, group: 'history', label: 'Undo', kind: 'history' },
    { id: 'redo', row: 1, group: 'history', label: 'Redo', kind: 'history' },

    { id: 'bold', row: 1, group: 'inline', label: 'Bold', run: wrapper('<strong>', '</strong>') },
    { id: 'italic', row: 1, group: 'inline', label: 'Italic', run: wrapper('<em>', '</em>') },
    { id: 'strikethrough', row: 1, group: 'inline', label: 'Strikethrough', run: wrapper('<s>', '</s>') },
    { id: 'underline', row: 1, group: 'inline', label: 'Underline', run: wrapper('<u>', '</u>') },
    { id: 'code', row: 1, group: 'inline', label: 'Inline code', run: wrapper('<code>', '</code>') },

    {
      id: 'color', row: 1, group: 'color', label: 'Text colour',
      kind: 'menu', options: TEXT_COLORS, swatch: true, run: mdTextColor,
    },
    {
      id: 'highlight', row: 1, group: 'color', label: 'Highlight',
      kind: 'menu', options: HIGHLIGHT_COLORS, swatch: true, run: mdHighlight,
    },

    { id: 'clear', row: 1, group: 'clear', label: 'Clear formatting', run: htmlClearFormatting },

    { id: 'heading', row: 2, group: 'heading', label: 'Heading', kind: 'menu', options: HEADING_OPTIONS, run: htmlHeading },

    { id: 'bullet-list', row: 2, group: 'list', label: 'Bullet list', run: (d, f, t) => htmlList(d, f, t, 'ul') },
    { id: 'ordered-list', row: 2, group: 'list', label: 'Numbered list', run: (d, f, t) => htmlList(d, f, t, 'ol') },
    { id: 'blockquote', row: 2, group: 'list', label: 'Blockquote', run: (d, f, t) => htmlBlockWrap(d, f, t, 'blockquote') },

    { id: 'link', row: 2, group: 'insert', label: 'Link', run: htmlLink },
    { id: 'table', row: 2, group: 'insert', label: 'Table', run: htmlTable },
    { id: 'rule', row: 2, group: 'insert', label: 'Horizontal rule', run: htmlRule },

    { id: 'align', row: 2, group: 'align', label: 'Alignment', kind: 'menu', options: ALIGN_OPTIONS, run: alignBlock },
  ];

  const TABLES = { markdown: MD_COMMANDS, html: HTML_COMMANDS };

  /**
   * The commands the format bar shows for a preview kind.
   *
   * `htmlTags: false` drops the commands that would write raw HTML into a
   * Markdown file. It is a portability switch, not a safety one, and it does
   * nothing for the HTML table — there, tags are the file's own format.
   */
  function formatCommandsFor(kind, { htmlTags = true } = {}) {
    const table = TABLES[kind];
    if (!table) return [];
    return table.filter((c) => htmlTags || !c.html);
  }

  return {
    MD_COMMANDS,
    HTML_COMMANDS,
    formatCommandsFor,
    FORMAT_TEXT_COLORS: TEXT_COLORS,
    FORMAT_HIGHLIGHT_COLORS: HIGHLIGHT_COLORS,
    wrapSelection,
    mdTextColor,
    mdHighlight,
    mdBulletList,
    mdOrderedList,
    mdTaskList,
    mdBlockquote,
    mdHeading,
    mdLink,
    mdTable,
    mdHorizontalRule,
    mdClearFormatting,
    alignBlock,
    htmlBlockWrap,
    htmlHeading,
    htmlList,
    htmlLink,
    htmlTable,
    htmlRule,
    htmlClearFormatting,
  };
});
