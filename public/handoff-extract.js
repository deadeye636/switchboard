// Pure helper: extract the text of the most recent assistant turn from raw Claude
// JSONL entries (as returned by window.api.readSessionJsonl(...).entries). Used to
// prefill the handoff review textarea so the user reviews/edits rather than retypes.
// Electron-free so it can be unit-tested. (Was part of the old handoff-flow.js state
// machine, which the linear runHandoff orchestrator no longer uses.)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Pure: tolerates malformed/missing entries and returns '' when none found.
  function extractLatestAssistantText(entries) {
    if (!Array.isArray(entries)) return '';
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry || entry.type !== 'assistant') continue;
      const message = entry.message || entry;
      const text = assistantContentToText(message && message.content);
      if (text) return text;
    }
    return '';
  }

  function assistantContentToText(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .filter(block => block && (block.type === 'text' || typeof block.text === 'string'))
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .join('')
      .trim();
  }

  return { extractLatestAssistantText };
});
