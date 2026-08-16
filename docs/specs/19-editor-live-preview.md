# 19 — Live Preview and the formatting bar in the internal editor

**Status:** built (#281). Written after the fact, as a design record.

The internal viewer used to edit Markdown as source in CodeMirror with a rendered preview behind a
two-state toggle. Formatting meant typing the syntax; checking the result meant leaving the editor.
This spec records what replaced that, and — more usefully — the two turns the design took, because
both were arrived at by being wrong first.

---

## 1. The requirement, and the thing it is not

"Edit the rendered document, like Obsidian."

That reads as WYSIWYG, and the first pass here declined it on those grounds: a rich-text editor over
Markdown needs a second document model, a serialiser back to source, and a fork to maintain — and the
round trip loses formatting choices the author made (which emphasis marker, which list character,
where the lines wrap).

**That reasoning was applied to the wrong thing.** Obsidian's Live Preview is not WYSIWYG. It is
CodeMirror 6 editing the **Markdown source**, with decorations that hide the syntax markers and style
what they wrapped. The document is Markdown at every moment. There is no second model, so there is no
round trip, so there is nothing to lose.

Everything below follows from that one fact. If a future change reintroduces a serialiser, it has
left this design, not extended it.

---

## 2. Three modes

| Mode | What it is |
|---|---|
| `live` | the source editor **drawn as the rendered document**, plus the formatting bar |
| `preview` | the rendered document, read-only |
| `text` | the source as it is, every marker visible, no bar |

The same three Obsidian has (Live Preview / Reading view / Source mode), and for the same reasons.
All three hold one text: the file's own.

`live` and `text` are the **same editor**. Switching between them reconfigures a CodeMirror
compartment rather than building a new view, so the undo history, the scroll position and the
selection survive the switch.

**Naming history:** `live` was called `edit` in the first implementation, when it was a plain source
editor with a toolbar. A stored `edit` migrates to `live`, alongside the older `true` / `false` the
preview toggle used to write. Both migrations live in `_resolveViewMode` in
`src/renderer/views/viewer-panel.js`.

---

## 3. How Live Preview works

`src/renderer/jsonl/live-markdown.js`, bundled into `codemirror-bundle.js`. A `ViewPlugin` walks the
Lezer tree and builds a `DecorationSet`:

- **`Decoration.replace({})`** over the syntax tokens — `**`, `#`, `>`, `` ` ``, the link brackets and
  URL. They stop being drawn; they are still in the document.
- **`Decoration.mark({class})`** over the content those tokens wrapped — bold, italic, code, link.
- **`Decoration.line({class})`** for the block kinds — heading sizes, the blockquote rule, the fenced
  block's background.
- **`Decoration.replace({widget})`** where a token has to become an element — the list bullet, the
  task checkbox, the horizontal rule, an image, a table's delimiter row.

### 3.1 The reveal rule is the feature

A line holding part of the selection shows its markers again. Without it you cannot see what you are
editing, and the mode is unusable rather than merely imperfect.

Reveal is per **line**, with one exception: a link's URL reveals only when the cursor is inside that
link, not merely on its line. A URL is long enough that revealing it on every visit to the line makes
the text jump around.

Reveal is also **off entirely when the editor has no focus**, which is what makes an unfocused panel
read as a document.

### 3.2 Three bugs that are not obvious until they bite

Each of these was solved in the MIT-licensed references this implementation derives from
(`kenforthewin/atomic-editor`, `blueberrycongee/codemirror-live-markdown`), and each one is a
regression waiting to be reintroduced by someone simplifying the code:

1. **Pointer freeze.** Clicking a heading puts the cursor on its line, which reveals the `# ` prefix
   and shifts the text right — under a pointer that is still down. The click becomes a micro-drag and
   lands elsewhere. So while a pointer is down, and briefly after it lifts, nothing reveals.
2. **`Decoration.replace` may not cross a line break** when it comes from a plugin — CM6 throws.
   Lezer emits tokens that do (a link title wrapped over two lines). Every replace goes through
   `pushReplace`, which splits per line and puts the widget only on the first segment, or a wrapped
   list item grows a second bullet.
3. **`ensureSyntaxTree(state, doc.length, 200)`, not `syntaxTree`.** The whole tree is walked rather
   than the viewport, because a viewport walk rebuilds on every scroll and the new decorations fight
   the scroll anchor. But then nothing rebuilds on scroll — so if the tree stops short of the end,
   everything past that point renders as raw `##` **forever**.

### 3.3 What HTML gets, and where it stops

The same idea over the HTML tree: inline elements and headings — `<strong>`, `<em>`, `<u>`, `<code>`,
`<mark>`, `<a>`, `<h1>`–`<h6>` — have their tags hidden and their content styled. `<span style>` and
`<mark style>` carry their one declaration through, and only `color` / `background`, which are the two
the toolbar writes.

**Block layout is deliberately not rendered.** A table, a grid of divs, anything driven by a
stylesheet would mean laying out HTML inside a text editor. That is a browser, and `preview` already
is one.

---

## 4. The formatting bar

`src/renderer/views/format-commands.js` (pure) and `format-toolbar.js` (DOM).

Every button is a pure function `(doc, from, to) => { from, to, insert, anchor, head }`. No DOM, no
CodeMirror, no editor state — which is why the commands are covered by `node --test` without a
harness. The panel dispatches exactly one change per click.

**Two command tables, not one parameterised table.** Markdown formats a block with a **line prefix**;
HTML formats it by **nesting a tag**. A list command shares nothing between them but its name. The
character commands genuinely are one function with different markers, and are written that way.

`editorToolbarHtmlTags` drops the four Markdown commands that write raw HTML (underline, colour,
highlight, alignment). This is a **portability** switch, not a security one — see §6.

### 4.1 Placement

`bar` (a strip under the toolbar row), `overlay` (a tile over the editor), `selection` (a popup beside
the selection). One wrapping row in all three, so width decides where it breaks.

The popup forced one decision: **the block commands have no selection to attach to.** Heading, lists,
quote, table, rule and alignment cannot live in a bar that only exists while text is selected. They
sit behind an overflow button as a **flat** list — "Heading 2", "Align centre" — rather than a nested
menu, because a submenu inside a popup anchored to a moving selection is two positioning problems
stacked.

Two things found by driving the app rather than by testing it:

- The overlay is positioned against the panel, whose top edge **is** the toolbar row, so it covered
  the title and the mode control until the panel started telling it how tall that row is.
- `editorToolbarVisibility: hover` must reveal on **focus** as well as pointer (`:focus-within`
  beside `:hover`), or the bar cannot be reached from the keyboard at all.

---

## 5. Read-only files

A file the app cannot write opens in `preview` and is pinned there: `live` and `text` are disabled,
saving is gone (button **and** the Cmd/Ctrl+S path), and the bar is greyed out.

**The forced mode is never persisted.** Storing it would let one unwritable file set the mode for
every other file the viewer opens — the same trap #279 documented for the global default seeding
itself into a per-viewer override.

Writability is answered by `src/app/file-access.js` through one IPC handler, asked per open. Not by
each reader's payload: the viewer opens files from four readers (plans, memory, work files, the file
panel) and three of them return a bare string, so a caller-supplied flag would be correct only where
someone remembered to pass it.

---

## 6. The sanitiser question, measured

The first re-scope kept colour and alignment out of the command set because they "would widen the
sanitiser's surface (#49)". That half was never measured, and it is **not true**.

The Markdown preview is `DOMPurify.sanitize(marked.parse(content))` with DOMPurify in its default
configuration. `marked` passes raw HTML through, and the default allowlist keeps `<u>`, `<mark>`,
`<span style>` and `<div align>` while stripping event handlers. Anyone who types `<u>` into a `.md`
today already sees it rendered.

So the buttons add no attack surface — they make it easier to write what the preview already renders.
Two guards remain: colour and highlight write from a **fixed palette**, so no free-form CSS reaches a
file, and **this feature adds no `ADD_TAGS` or `ALLOWED_ATTR` anywhere**. If a future change needs
one, it has left the ground this decision stands on.

---

## 7. Files

| Path | What it holds |
|---|---|
| `src/renderer/jsonl/live-markdown.js` | the decoration plugins, the widgets, the freeze, the theme |
| `src/renderer/views/format-commands.js` | both command tables; pure, `require()`-able |
| `src/renderer/views/format-toolbar.js` | the bar's DOM, the three placements, the menus |
| `src/renderer/views/viewer-panel.js` | the three modes, persistence, read-only, the dispatch |
| `src/renderer/views/viewer-toolbar.js` | the segmented control and the read-only badge |
| `src/app/file-access.js` | can this file be written |
| `test/format-commands.test.js` | every command, both kinds, offsets included |
| `test/viewer-view-modes.test.js` | mode resolution, migration, read-only, placement |
| `test/live-preview-wiring.test.js` | the wiring the decorations hang from |

**The decorations themselves are not unit-tested.** They are bundled ESM over CodeMirror, and
asserting on decoration ranges without a layout engine tests the mock. The wiring is guarded; the
behaviour is verified by driving the running app, which is the rule for any renderer change anyway.

---

## 8. Deliberately out of scope

- **WYSIWYG / a serialiser back to source.** See §1 — the whole design exists to avoid it.
- **A user-configurable toolbar layout.** Needs a command registry, a drag-sortable settings UI and
  its own persistence. Worth its own issue if the fixed row turns out to be wrong.
- **Block-level HTML rendering in `live`.** See §3.3.
