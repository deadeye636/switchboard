// The unified-diff drawing both diff surfaces share: the changes window (#277, `changed-files.js`) and the session
// Details window (#870, `session-changes.js`). Electron-free (UMD), no IPC. Every diff line is escaped, because a diff
// carries somebody else's text. The markup uses the classes `.diff-pre`, `.d-add`, `.d-del`, `.d-hunk`, `.d-meta`,
// `.diff-bar`, `.diff-bar-info`, `.diff-expand` and `.diff-empty`, which each page styles in its own `<style>` block.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Above this many lines the inline pane is cramped, so it offers "open in a window" (#287).
  const DIFF_WINDOW_THRESHOLD = 200;
  // Lines drawn inline; the side-by-side window has the whole file.
  const DIFF_INLINE_LINES = 4000;

  const diffEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function renderDiff(text) {
    if (!text || !text.trim()) return '<div class="diff-empty">No textual changes.</div>';
    const lines = text.split('\n').slice(0, DIFF_INLINE_LINES);
    const html = lines.map((l) => {
      const e = diffEsc(l);
      if (l.startsWith('+++') || l.startsWith('---')) return '<span class="d-meta">' + e + '</span>';
      if (l[0] === '+') return '<span class="d-add">' + e + '</span>';
      if (l[0] === '-') return '<span class="d-del">' + e + '</span>';
      if (l.startsWith('@@')) return '<span class="d-hunk">' + e + '</span>';
      if (/^(diff |index |new file|deleted |rename |similarity |Binary )/.test(l)) return '<span class="d-meta">' + e + '</span>';
      return e;
    }).join('\n');
    return '<pre class="diff-pre">' + html + '</pre>';
  }

  // The "N lines / Open in window" bar of a large diff (#287); empty for a short one.
  function diffBarHtml(text) {
    const lineCount = text ? text.split('\n').length : 0;
    return lineCount > DIFF_WINDOW_THRESHOLD
      ? '<div class="diff-bar"><span class="diff-bar-info">' + lineCount + ' lines</span>'
        + '<button class="diff-expand" title="Open this diff in a side-by-side window">Open in window ⤢</button></div>'
      : '';
  }

  return { DIFF_WINDOW_THRESHOLD, renderDiff, diffBarHtml };
});
