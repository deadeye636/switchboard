// live-markdown.js — Obsidian-style Live Preview for the internal editor (#281).
//
// The document is always Markdown. Nothing here rewrites it, nothing serialises
// anything back: the file on disk is exactly what the editor holds. What changes
// is only how CodeMirror DRAWS it — the syntax markers are hidden with
// `Decoration.replace` and the content they wrapped gets a class, so `**bold**`
// looks bold while still being six characters of Markdown.
//
// That is the whole trick, and it is the one Obsidian uses. It is why this costs
// a decoration plugin instead of a rich-text framework: there is no second
// document model to keep in sync, so there is no round trip to lose formatting
// in.
//
// THE RULE THAT MAKES IT USABLE: a line holding the cursor shows its markers
// again. Without it you cannot see what you are editing. Reveal is per LINE, not
// per node — landing anywhere on a line un-hides all of it — except inside a
// link, where the URL only appears once the cursor is in that link rather than
// merely on its line.
//
// Derived from the approach in two MIT-licensed CodeMirror 6 projects:
//   kenforthewin/atomic-editor  (src/inline-preview.ts)
//   blueberrycongee/codemirror-live-markdown  (its live-preview design notes)
// Written against them rather than copied wholesale; the node handling, the
// per-line replace splitting and the pointer freeze follow their solutions,
// which each exist because of a bug that is not obvious until it bites.

import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { StateEffect, StateField, Compartment, Facet } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';

// ── Pointer freeze ──────────────────────────────────────────────────
//
// Clicking a heading puts the cursor on its line, which reveals the `# ` prefix
// and shifts the text right — under the pointer that is still down. The click
// becomes a micro-drag and lands somewhere else than the user aimed at. So while
// a pointer is down, and for a moment after it lifts, no reveal happens.

// The directory URL a relative image path is resolved against. A facet rather
// than a module global because several viewer panels are open at once and each
// one shows a file from a different folder.
const imageBaseFacet = Facet.define({
  combine: (values) => (values.length ? values[values.length - 1] : ''),
});

function resolveImageSrc(base, src) {
  if (!src) return '';
  if (/^(https?:|data:|file:)/i.test(src)) return src;
  if (!base) return src;
  return base.replace(/\/$/, '') + '/' + src.replace(/^\.\//, '');
}

const FREEZE_TAIL_MS = 100;

const setFrozen = StateEffect.define();

const frozenField = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFrozen)) return effect.value;
    return value;
  },
});

const freezePlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.timer = null;
    this.onDown = (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      // Only the content, never the scrollbar: a scrollbar drag would otherwise
      // hold the whole document frozen and the syntax would pop in on release.
      if (!(target instanceof Node) || !view.contentDOM.contains(target)) return;
      if (this.timer != null) { window.clearTimeout(this.timer); this.timer = null; }
      view.dispatch({ effects: setFrozen.of(true) });
    };
    this.onUp = () => {
      if (this.timer != null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        view.dispatch({ effects: setFrozen.of(false) });
      }, FREEZE_TAIL_MS);
    };
    view.dom.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  destroy() {
    this.view.dom.removeEventListener('pointerdown', this.onDown, true);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    if (this.timer != null) window.clearTimeout(this.timer);
  }
});

// ── What each node becomes ──────────────────────────────────────────

const LINE_CLASS_BY_BLOCK = {
  ATXHeading1: 'cm-live-h1',
  ATXHeading2: 'cm-live-h2',
  ATXHeading3: 'cm-live-h3',
  ATXHeading4: 'cm-live-h4',
  ATXHeading5: 'cm-live-h5',
  ATXHeading6: 'cm-live-h6',
  SetextHeading1: 'cm-live-h1',
  SetextHeading2: 'cm-live-h2',
  Blockquote: 'cm-live-quote',
  FencedCode: 'cm-live-fence',
};

const INLINE_CLASS = {
  StrongEmphasis: 'cm-live-strong',
  Emphasis: 'cm-live-em',
  InlineCode: 'cm-live-code',
  Strikethrough: 'cm-live-strike',
  Link: 'cm-live-link',
};

// The tokens that disappear on an inactive line.
const HIDEABLE = new Set([
  'HeaderMark', 'EmphasisMark', 'CodeMark', 'CodeInfo',
  'LinkMark', 'LinkTitle', 'StrikethroughMark', 'QuoteMark',
]);

// These follow the cursor-inside-the-link rule instead of the line rule. The
// same token names appear under an Image, where the line rule is the better fit.
const LINK_CHILD = new Set(['LinkMark', 'URL', 'LinkTitle']);

// ── Widgets ─────────────────────────────────────────────────────────

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-bullet';
    span.textContent = '•';
    return span;
  }
  ignoreEvent() { return false; }
}
const BULLET = new BulletWidget();

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-rule';
    return span;
  }
  ignoreEvent() { return false; }
}
const RULE = new RuleWidget();

class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(other) { return other.src === this.src && other.alt === this.alt; }
  toDOM() {
    // A broken or remote image must not collapse the line to nothing — the alt
    // text stays as the fallback, which is also what the source said.
    const img = document.createElement('img');
    img.className = 'cm-live-image';
    img.src = this.src;
    img.alt = this.alt || '';
    img.setAttribute('contenteditable', 'false');
    return img;
  }
  ignoreEvent() { return false; }
}

class CodeLabelWidget extends WidgetType {
  constructor(lang) { super(); this.lang = lang; }
  eq(other) { return other.lang === this.lang; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-live-code-label';
    span.textContent = this.lang;
    return span;
  }
  ignoreEvent() { return false; }
}

class TaskWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(other) { return other.checked === this.checked; }
  toDOM(view) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-live-task';
    input.setAttribute('contenteditable', 'false');
    input.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    // Ticking the box edits the document — `- [ ]` becomes `- [x]`. That keeps
    // the checkbox honest: it is the source, not a view-only toggle.
    input.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(input);
      if (pos < 0) return;
      const current = view.state.doc.sliceString(pos, pos + 3);
      const next = /\[x\]/i.test(current) ? '[ ]' : '[x]';
      if (current === next) return;
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: next } });
    });
    return input;
  }
  ignoreEvent(event) { return event.type === 'mousedown' || event.type === 'click'; }
}

// ── Helpers ─────────────────────────────────────────────────────────

// A plugin-sourced `Decoration.replace` may not span a line break — CM6 throws
// "Decorations that replace line breaks may not be specified via plugins". Lezer
// happily emits tokens that do (a link title wrapped over two lines), so every
// replace is split per line before it is pushed.
function pushReplace(ranges, doc, from, to, spec = {}) {
  if (from >= to) return;
  const startLine = doc.lineAt(from);
  if (to <= startLine.to) {
    ranges.push(Decoration.replace(spec).range(from, to));
    return;
  }
  let cursor = from;
  let first = true;
  while (cursor < to) {
    const line = doc.lineAt(cursor);
    const end = Math.min(to, line.to);
    // Only the first segment carries the widget, or a wrapped list item would
    // grow a second bullet on its continuation line.
    if (end > cursor) { ranges.push(Decoration.replace(first ? spec : {}).range(cursor, end)); first = false; }
    cursor = line.to + 1;
  }
}

// `[label](url)` can hold two URL nodes when the label is itself a URL. Only the
// one after the closing `]` is destination syntax; hiding both makes the visible
// label vanish.
function linkDestination(link, doc) {
  const close = link.getChildren('LinkMark').find((m) => doc.sliceString(m.from, m.to) === ']');
  if (!close) return null;
  return link.getChildren('URL').find((u) => u.from >= close.to) || null;
}

// The four tags the formatting bar writes into Markdown. Lezer does not pair
// HTML tags, so these are matched over the text instead of over the tree — the
// same escape hatch the reference uses for maths.
const HTML_INLINE = [
  { re: /<u>([\s\S]*?)<\/u>/g, cls: 'cm-live-underline', open: 3, close: 4 },
  { re: /<mark(?:\s+style="background:([^"]*)")?>([\s\S]*?)<\/mark>/g, cls: 'cm-live-mark', mark: true },
  { re: /<span\s+style="color:([^"]*)">([\s\S]*?)<\/span>/g, cls: 'cm-live-color', color: true },
];

// This pass matches over the raw text, so unlike the tree walk it cannot tell a
// real tag from one QUOTED IN A CODE BLOCK. `<u>x</u>` inside a fence is an
// example of the syntax, not the syntax — hiding its tags eats the very thing
// the author was showing. Hence `codeRanges`: the spans the Markdown tree says
// are code, collected during the walk and skipped here.
function overlapsAny(spans, from, to) {
  for (const span of spans) if (from < span.to && to > span.from) return true;
  return false;
}

function decorateHtmlInline(ranges, doc, activeLines, text, codeRanges) {
  for (const rule of HTML_INLINE) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const from = m.index;
      const to = from + m[0].length;
      if (activeLines.has(doc.lineAt(from).number)) continue;
      if (overlapsAny(codeRanges, from, to)) continue;
      const body = rule.color || rule.mark ? m[2] : m[1];
      const bodyFrom = from + m[0].indexOf('>') + 1;
      const bodyTo = bodyFrom + body.length;
      const attrs = {};
      if (rule.color && m[1]) attrs.style = `color:${m[1]}`;
      if (rule.mark && m[1]) attrs.style = `background:${m[1]}`;
      pushReplace(ranges, doc, from, bodyFrom);
      if (bodyTo > bodyFrom) {
        ranges.push(Decoration.mark({ class: rule.cls, attributes: attrs }).range(bodyFrom, bodyTo));
      }
      pushReplace(ranges, doc, bodyTo, to);
    }
  }
}

// ── The decoration pass ─────────────────────────────────────────────

function buildDecorations(view) {
  const { state } = view;
  const { doc } = state;
  const ranges = [];

  // A line is active when it holds part of the selection — and only while the
  // editor has focus and no pointer is down. Without focus the whole document
  // stays rendered, which is what makes an unfocused panel read like a document.
  const activeLines = new Set();
  if (view.hasFocus && !state.field(frozenField, false)) {
    for (const r of state.selection.ranges) {
      const first = doc.lineAt(r.from).number;
      const last = doc.lineAt(r.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }
  }

  // Walk the WHOLE tree, not the viewport: decorating per-viewport means
  // rebuilding on every scroll, and new decorations landing at the top of the
  // viewport fight the scroll anchor. `ensureSyntaxTree` is what guarantees the
  // tree actually reaches the end — without it a long file renders raw `##`
  // past wherever the incremental parser stopped, forever, because nothing
  // rebuilds on scroll any more.
  const tree = ensureSyntaxTree(state, doc.length, 200) || syntaxTree(state);

  // Links whose range the cursor is inside. Recorded on the way in, because a
  // pre-order walk enters `Link` before its `LinkMark` / `URL` children.
  const activeLinks = new Set();

  // Everything the tree calls code. The HTML pass below matches over raw text
  // and would otherwise decorate a tag that is only being QUOTED.
  const codeRanges = [];

  tree.iterate({
    enter: (node) => {
      if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') {
        codeRanges.push({ from: node.from, to: node.to });
      }
      // Clicking any line of a fence activates the whole block, so its info
      // string and both fences reveal together.
      if (node.name === 'FencedCode') {
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(node.to).number;
        let any = false;
        for (let n = first; n <= last && !any; n++) if (activeLines.has(n)) any = true;
        if (any) for (let n = first; n <= last; n++) activeLines.add(n);
      }

      if (node.name === 'Link' && view.hasFocus) {
        for (const r of state.selection.ranges) {
          if (r.from <= node.to && r.to >= node.from) { activeLinks.add(node.from); break; }
        }
      }

      const lineClass = LINE_CLASS_BY_BLOCK[node.name];
      if (lineClass) {
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          ranges.push(Decoration.line({ class: lineClass }).range(doc.line(n).from));
        }
      }

      const inlineClass = INLINE_CLASS[node.name];
      if (inlineClass && node.from < node.to) {
        ranges.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
      }

      if (HIDEABLE.has(node.name) && node.from < node.to) {
        const lineNum = doc.lineAt(node.from).number;
        let hide;
        if (LINK_CHILD.has(node.name)) {
          let parent = node.node.parent;
          while (parent && parent.name !== 'Link' && parent.name !== 'Image') parent = parent.parent;
          hide = parent && parent.name === 'Link'
            ? !activeLinks.has(parent.from)
            : !activeLines.has(lineNum);
        } else {
          hide = !activeLines.has(lineNum);
        }
        if (hide) {
          let to = node.to;
          // `## ` and `> ` own the space after them, or the heading text would
          // start one column in from the margin.
          if (node.name === 'HeaderMark' || node.name === 'QuoteMark') {
            while (to < doc.length && doc.sliceString(to, to + 1) === ' ') to++;
          }
          pushReplace(ranges, doc, node.from, to);
        }
      }

      if (node.name === 'URL' && node.from < node.to) {
        const parent = node.node.parent;
        if (parent && parent.name === 'Link') {
          const dest = linkDestination(parent, doc);
          if (dest && dest.from === node.from && !activeLinks.has(parent.from)) {
            pushReplace(ranges, doc, node.from, node.to);
          }
        } else {
          // A bare URL is content, not syntax — style it, never hide it.
          ranges.push(Decoration.mark({ class: 'cm-live-link' }).range(node.from, node.to));
        }
      }

      if (node.name === 'HorizontalRule' && !activeLines.has(doc.lineAt(node.from).number)) {
        pushReplace(ranges, doc, node.from, node.to, { widget: RULE });
      }

      // `![alt](src)` becomes the picture. A local path is resolved against the
      // file's own directory by the panel, which is why the src comes back
      // through `imageSrcResolver` rather than being used raw.
      if (node.name === 'Image' && node.from < node.to) {
        if (!activeLines.has(doc.lineAt(node.from).number)) {
          const raw = doc.sliceString(node.from, node.to);
          const m = raw.match(/^!\[([^\]]*)\]\(([^)\s]+)/);
          if (m) {
            const src = resolveImageSrc(state.facet(imageBaseFacet), m[2]);
            pushReplace(ranges, doc, node.from, node.to, { widget: new ImageWidget(src, m[1]) });
          }
        }
      }

      // The fence's language, as a corner label. `CodeInfo` is hidden with the
      // rest of the fence syntax, so without this the language is simply gone.
      if (node.name === 'CodeInfo' && node.from < node.to) {
        if (!activeLines.has(doc.lineAt(node.from).number)) {
          const lang = doc.sliceString(node.from, node.to).trim().split(/\s+/)[0];
          if (lang) {
            ranges.push(Decoration.widget({ widget: new CodeLabelWidget(lang), side: 1 }).range(node.to));
          }
        }
      }

      // A GFM table keeps its pipes — they are the column boundaries and the one
      // thing that makes the source editable. What goes is the `| --- |` rule,
      // which is syntax and nothing else, plus a grid line per row.
      if (node.name === 'Table') {
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          ranges.push(Decoration.line({ class: 'cm-live-table' }).range(doc.line(n).from));
        }
      }
      if (node.name === 'TableDelimiter' && node.from < node.to) {
        const line = doc.lineAt(node.from);
        // Only the whole delimiter ROW disappears; a `|` inside a header or body
        // row is also a TableDelimiter and has to stay.
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line.text) && !activeLines.has(line.number)
            && node.from === line.from) {
          // A rule rather than nothing: replacing the row's text still leaves the
          // LINE, and an empty one under the header reads as a stray blank.
          pushReplace(ranges, doc, line.from, line.to, { widget: RULE });
        }
      }

      if (node.name === 'TaskMarker' && node.from < node.to) {
        if (!activeLines.has(doc.lineAt(node.from).number)) {
          const checked = /\[x\]/i.test(doc.sliceString(node.from, node.to));
          pushReplace(ranges, doc, node.from, node.to, { widget: new TaskWidget(checked) });
        }
      }

      if (node.name === 'ListMark' && node.from < node.to) {
        const lineNum = doc.lineAt(node.from).number;
        if (activeLines.has(lineNum)) return;
        const text = doc.sliceString(node.from, node.to);
        // An ordered marker stays as text — the number carries meaning that a
        // bullet glyph would throw away. A task item keeps its `- ` hidden with
        // no bullet, because the checkbox is its marker.
        if (/^\d/.test(text)) return;
        const line = doc.lineAt(node.from);
        const isTask = /^\s*[-*+]\s+\[[ xX]\]/.test(line.text);
        pushReplace(ranges, doc, node.from, node.to, isTask ? {} : { widget: BULLET });
      }
    },
  });

  decorateHtmlInline(ranges, doc, activeLines, doc.toString(), codeRanges);

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDecorations(view); }

  update(update) {
    // Selection, focus and the freeze flag all change what is hidden, so all of
    // them have to rebuild — not just document changes.
    const frozenChanged =
      update.startState.field(frozenField, false) !== update.state.field(frozenField, false);
    if (update.docChanged || update.selectionSet || update.focusChanged || frozenChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

// ── The extension ───────────────────────────────────────────────────

const liveMarkdownTheme = EditorView.theme({
  '.cm-live-h1': { fontSize: '1.9em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-live-h2': { fontSize: '1.55em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-live-h3': { fontSize: '1.3em', fontWeight: '600', lineHeight: '1.35' },
  '.cm-live-h4': { fontSize: '1.15em', fontWeight: '600' },
  '.cm-live-h5': { fontSize: '1.05em', fontWeight: '600' },
  '.cm-live-h6': { fontSize: '1em', fontWeight: '600', opacity: '0.85' },

  '.cm-live-quote': {
    borderLeft: '3px solid rgba(255,255,255,0.18)',
    paddingLeft: '10px',
    fontStyle: 'italic',
    opacity: '0.9',
  },

  '.cm-live-fence': { background: 'rgba(255,255,255,0.035)' },

  '.cm-live-strong': { fontWeight: '700' },
  '.cm-live-em': { fontStyle: 'italic' },
  '.cm-live-strike': { textDecoration: 'line-through', opacity: '0.7' },
  '.cm-live-underline': { textDecoration: 'underline' },
  '.cm-live-code': {
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '3px',
    padding: '0 3px',
  },
  '.cm-live-link': { color: '#8088ff', textDecoration: 'underline', cursor: 'pointer' },
  '.cm-live-mark': { borderRadius: '2px', padding: '0 1px', color: '#15151c' },

  '.cm-live-bullet': {
    display: 'inline-block',
    width: '1.2em',
    color: '#8088ff',
    fontWeight: '700',
  },

  '.cm-live-task': {
    verticalAlign: 'middle',
    margin: '0 0.45em 0 0',
    cursor: 'pointer',
  },

  '.cm-live-rule': {
    display: 'inline-block',
    width: '100%',
    borderTop: '1px solid rgba(255,255,255,0.18)',
    verticalAlign: 'middle',
  },

  '.cm-live-image': {
    maxWidth: '100%',
    maxHeight: '420px',
    borderRadius: '4px',
    verticalAlign: 'top',
  },

  '.cm-live-code-label': {
    marginLeft: '6px',
    padding: '0 5px',
    borderRadius: '3px',
    fontSize: '0.8em',
    color: '#9090a8',
    background: 'rgba(255,255,255,0.07)',
  },

  '.cm-live-table': {
    fontVariantNumeric: 'tabular-nums',
    background: 'rgba(255,255,255,0.03)',
  },
});

function liveMarkdown(imageBase = '') {
  return [imageBaseFacet.of(imageBase), frozenField, freezePlugin, livePreviewPlugin, liveMarkdownTheme];
}

// ── HTML ────────────────────────────────────────────────────────────
//
// The same idea over the HTML tree: hide the tags, style what they wrapped.
//
// WHERE THIS STOPS, on purpose: only INLINE elements and headings. A table, a
// grid of divs or anything driven by a stylesheet would mean laying out HTML
// inside a text editor — that is a browser, and there is one two clicks away in
// `preview`. What Live Preview buys in an HTML file is not seeing `<strong>`
// around every bold word; it was never going to be a page renderer.

const HTML_INLINE_CLASS = {
  strong: 'cm-live-strong',
  b: 'cm-live-strong',
  em: 'cm-live-em',
  i: 'cm-live-em',
  u: 'cm-live-underline',
  s: 'cm-live-strike',
  strike: 'cm-live-strike',
  del: 'cm-live-strike',
  code: 'cm-live-code',
  mark: 'cm-live-mark',
  span: '',
  a: 'cm-live-link',
};

const HTML_HEADING_CLASS = {
  h1: 'cm-live-h1', h2: 'cm-live-h2', h3: 'cm-live-h3',
  h4: 'cm-live-h4', h5: 'cm-live-h5', h6: 'cm-live-h6',
};

// The inline style the toolbar writes, and nothing else. Carrying an arbitrary
// style attribute into a decoration would let a document's own CSS reach into
// the editor chrome; colour and background are the two the buttons produce.
function safeInlineStyle(text) {
  const m = text.match(/style="(?:color|background):([^";]*)"/);
  if (!m) return null;
  return text.includes('background:') ? `background:${m[1]}` : `color:${m[1]}`;
}

function tagNameOf(node, doc) {
  const tag = node.getChild('TagName');
  return tag ? doc.sliceString(tag.from, tag.to).toLowerCase() : null;
}

function buildHtmlDecorations(view) {
  const { state } = view;
  const { doc } = state;
  const ranges = [];

  const activeLines = new Set();
  if (view.hasFocus && !state.field(frozenField, false)) {
    for (const r of state.selection.ranges) {
      const first = doc.lineAt(r.from).number;
      const last = doc.lineAt(r.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }
  }

  const tree = ensureSyntaxTree(state, doc.length, 200) || syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Element') return;
      const open = node.node.getChild('OpenTag');
      const close = node.node.getChild('CloseTag');
      if (!open || !close) return;

      const tag = tagNameOf(open, doc);
      if (!tag) return;

      const heading = HTML_HEADING_CLASS[tag];
      const inline = HTML_INLINE_CLASS[tag];
      if (!heading && inline === undefined) return;

      if (activeLines.has(doc.lineAt(node.from).number)) return;

      if (heading) {
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          ranges.push(Decoration.line({ class: heading }).range(doc.line(n).from));
        }
      } else if (inline) {
        if (close.from > open.to) {
          ranges.push(Decoration.mark({ class: inline }).range(open.to, close.from));
        }
      }

      // `<span style="color:…">` and `<mark style="background:…">` carry their
      // one declaration through — that is what the colour buttons wrote.
      const style = safeInlineStyle(doc.sliceString(open.from, open.to));
      if (style && close.from > open.to) {
        ranges.push(Decoration.mark({ attributes: { style } }).range(open.to, close.from));
      }

      pushReplace(ranges, doc, open.from, open.to);
      pushReplace(ranges, doc, close.from, close.to);
    },
  });

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(ranges, true);
}

const liveHtmlPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildHtmlDecorations(view); }

  update(update) {
    const frozenChanged =
      update.startState.field(frozenField, false) !== update.state.field(frozenField, false);
    if (update.docChanged || update.selectionSet || update.focusChanged || frozenChanged) {
      this.decorations = buildHtmlDecorations(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

function liveHtml() {
  return [frozenField, freezePlugin, liveHtmlPlugin, liveMarkdownTheme];
}

// `kind` is 'markdown', 'html', or anything else for off. `imageBase` is the
// directory URL a relative image path resolves against.
function livePreviewFor(kind, imageBase = '') {
  if (kind === 'markdown') return liveMarkdown(imageBase);
  if (kind === 'html') return liveHtml();
  return [];
}

export { liveMarkdown, liveHtml, livePreviewFor, resolveImageSrc, Compartment as LiveCompartment };
