// Pure helper: extract the text of the most recent assistant turn from a session's raw entries (as
// returned by window.api.readSessionJsonl(...).entries). Used to prefill the handoff review textarea so
// the user reviews/edits rather than retypes.
//
// It must understand EVERY backend's transcript, because a handoff is not a Claude feature (#148) —
// each one nests the turn differently:
//   Claude  {type:'assistant',      message:{content:[…]}}
//   Pi      {type:'message',        message:{role:'assistant', content:[{type:'text',text}]}}
//   Codex   {type:'response_item',  payload:{type:'message', role:'assistant', content:[…]}}
//   Hermes  {type:'message',        message:{role:'assistant', content:'…'}}   (synthesized from its DB)
// Getting this wrong is silent: the review dialog just falls back to an empty template, and the user
// retypes what the agent already wrote.
// Electron-free so it can be unit-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Is this entry an assistant turn, whatever backend wrote it? Returns its content, or null.
  function assistantContentOf(entry) {
    if (!entry || typeof entry !== 'object') return null;

    // Claude: the entry TYPE is the role.
    if (entry.type === 'assistant') {
      const message = entry.message || entry;
      return message ? message.content : null;
    }
    // Pi / Hermes: {type:'message', message:{role, content}}
    if (entry.type === 'message' && entry.message && entry.message.role === 'assistant') {
      return entry.message.content;
    }
    // Codex: {type:'response_item', payload:{type:'message', role, content}}
    if (entry.type === 'response_item' && entry.payload
        && entry.payload.type === 'message' && entry.payload.role === 'assistant') {
      return entry.payload.content;
    }
    return null;
  }

  // Pure: tolerates malformed/missing entries and returns '' when none found.
  function extractLatestAssistantText(entries) {
    if (!Array.isArray(entries)) return '';
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const content = assistantContentOf(entries[i]);
      if (content == null) continue;
      const text = assistantContentToText(content);
      if (text) return text;
    }
    return '';
  }

  function assistantContentToText(content) {
    if (typeof content === 'string') return content.trim();   // Hermes stores plain text
    if (!Array.isArray(content)) return '';
    return content
      // Codex calls its text blocks `output_text`; the `typeof block.text` check covers it and anything
      // else that carries text, without having to enumerate every block type each CLI invents.
      .filter(block => block && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
      .trim();
  }

  return { extractLatestAssistantText, assistantContentOf };
});
