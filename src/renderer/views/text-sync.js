// views/text-sync.js — applying someone else's edit to an open document without losing the reader's place.
//
// The reload used to replace the whole document: `{ from: 0, to: doc.length, insert: newText }`. Every
// position inside a fully replaced range maps to its boundary, so the cursor jumped and the view scrolled
// away — against an agent that saves every few seconds the document simply could not be read. The panel
// already knew this mattered: switching view modes was deliberately built as a reconfigure so that "the
// undo history, the scroll position and the selection survive". The reload path never got the same care.
//
// A rewrite usually changes a paragraph, not a file. Trimming the shared head and tail leaves exactly the
// span that moved, and everything outside it keeps its position for free.
//
// Pure on purpose: this is where the off-by-one lives, and it can be checked with strings instead of with
// an editor.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A code point above the BMP is two units in a JS string. Cutting between them produces a lone
  // surrogate — a character that renders as a replacement box and compares unequal to itself in any
  // later diff. So a boundary that lands inside a pair is walked back one unit.
  function isHighSurrogate(code) { return code >= 0xD800 && code <= 0xDBFF; }
  function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }

  /**
   * The one change that turns `oldText` into `newText`, or null when they are already the same.
   *
   * Returns `{ from, to, insert }` in the old text's coordinates — the shape a CodeMirror transaction
   * takes. `from === to` is an insertion, `insert === ''` a deletion.
   */
  function textSyncChange(oldText, newText) {
    const a = String(oldText == null ? '' : oldText);
    const b = String(newText == null ? '' : newText);
    if (a === b) return null;

    const max = Math.min(a.length, b.length);
    let start = 0;
    while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
    // Do not start inside a surrogate pair.
    if (start > 0 && isLowSurrogate(a.charCodeAt(start)) && isHighSurrogate(a.charCodeAt(start - 1))) start--;

    // The tail is measured from both ends and may not reach back past the head we already matched, or an
    // insertion of text that repeats its surroundings would produce a negative-length range.
    let end = 0;
    const maxEnd = Math.min(a.length - start, b.length - start);
    while (end < maxEnd && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
    if (end > 0 && isHighSurrogate(a.charCodeAt(a.length - end)) && isLowSurrogate(a.charCodeAt(a.length - end + 1))) end--;

    return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
  }

  /**
   * Where the cursor should sit after that change.
   *
   * Before the change it does not move. After it, it shifts by the change in length. Inside it there is
   * nothing left to point at, so it goes to the end of what was inserted — which is where a reader
   * following along would be looking anyway.
   */
  function mapPosition(pos, change) {
    if (!change) return pos;
    const p = Math.max(0, Number(pos) || 0);
    if (p <= change.from) return p;
    const delta = change.insert.length - (change.to - change.from);
    if (p >= change.to) return Math.max(0, p + delta);
    return change.from + change.insert.length;
  }

  /**
   * Is this reader still at the bottom?
   *
   * A document being appended to — a plan growing while it is written — should follow the writer if the
   * reader was already at the end, and hold still if they were reading further up. The tolerance is there
   * because "at the bottom" is a few pixels wide in practice, not exact.
   */
  function isPinnedToBottom(scrollTop, clientHeight, scrollHeight, tolerance = 24) {
    const top = Number(scrollTop) || 0;
    const view = Number(clientHeight) || 0;
    const total = Number(scrollHeight) || 0;
    if (total <= view) return true; // nothing to scroll: the end is always in sight
    return (total - (top + view)) <= tolerance;
  }

  return { textSyncChange, mapPosition, isPinnedToBottom };
});
