// --- Transcript in-viewer search (#86) ---
// A search bar in the message viewer: highlights every occurrence of a term,
// steps through them (prev/next), lists the matching messages (click to jump),
// and filters by message type (LLM / Prompt). Pure match logic lives in
// jsonl-search-logic.js (shared with node tests); this file is DOM wiring only.
//
// Depends on: #jsonl-viewer* DOM, searchTranscript (jsonl-search-logic.js),
// window.bookmarksTags.scrollToJsonlEntry (bookmarks-tags.js).

(function () {
  const body = document.getElementById('jsonl-viewer-body');
  const input = document.getElementById('jsonl-search-input');
  const typeSel = document.getElementById('jsonl-search-type');
  const countEl = document.getElementById('jsonl-search-count');
  const prevBtn = document.getElementById('jsonl-search-prev');
  const nextBtn = document.getElementById('jsonl-search-next');
  const listToggle = document.getElementById('jsonl-search-toggle-list');
  const listEl = document.getElementById('jsonl-search-list');
  if (!body || !input || !typeSel || !listEl) return;

  let hits = [];        // <mark> elements in document order
  let activeHit = -1;
  let matches = [];     // per-message summaries { entryIndex, role, count, snippet }

  // Read the rendered transcript as plain data. Message elements carry the
  // role class (jsonl-user / jsonl-assistant) and a stable data-entry-index.
  function collectMessages() {
    const out = [];
    for (const el of body.querySelectorAll('.jsonl-user, .jsonl-assistant')) {
      if (el.dataset.entryIndex == null) continue;
      out.push({
        entryIndex: Number(el.dataset.entryIndex),
        role: el.classList.contains('jsonl-assistant') ? 'assistant' : 'user',
        text: el.textContent || '',
        el,
      });
    }
    return out;
  }

  function clearHighlights() {
    for (const mark of body.querySelectorAll('mark.jsonl-search-hit')) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
    hits = [];
    activeHit = -1;
  }

  // Wrap every case-insensitive occurrence of `term` in this element's text nodes.
  function highlightIn(el, term) {
    const lower = term.toLowerCase();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue && node.nodeValue.toLowerCase().includes(lower)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const targets = [];
    let n; while ((n = walker.nextNode())) targets.push(n);
    for (const node of targets) {
      const text = node.nodeValue;
      const low = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let i = 0, at;
      while ((at = low.indexOf(lower, i)) !== -1) {
        if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
        const mark = document.createElement('mark');
        mark.className = 'jsonl-search-hit';
        mark.textContent = text.slice(at, at + term.length);
        frag.appendChild(mark);
        hits.push(mark);
        i = at + term.length;
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  function roleLabel(role) { return role === 'assistant' ? 'LLM' : 'Prompt'; }

  function renderList() {
    if (!matches.length) { listEl.innerHTML = '<div class="jsonl-search-empty">No matches.</div>'; return; }
    listEl.innerHTML = matches.map((m) =>
      `<button class="jsonl-search-item" data-entry="${m.entryIndex}">` +
        `<span class="jsonl-search-item-role jsonl-search-role-${m.role}">${roleLabel(m.role)}</span>` +
        `<span class="jsonl-search-item-snippet"></span>` +
        (m.count > 1 ? `<span class="jsonl-search-item-count">${m.count}</span>` : '') +
      `</button>`).join('');
    // Set snippets via textContent so transcript text can't inject markup.
    const snips = listEl.querySelectorAll('.jsonl-search-item-snippet');
    matches.forEach((m, i) => { if (snips[i]) snips[i].textContent = m.snippet; });
  }

  function updateCount() {
    if (hits.length) countEl.textContent = `${activeHit + 1}/${hits.length}`;
    else countEl.textContent = input.value.trim() ? '0' : '';
  }

  function setActive(i) {
    if (!hits.length) return;
    if (hits[activeHit]) hits[activeHit].classList.remove('jsonl-search-hit-active');
    activeHit = (i % hits.length + hits.length) % hits.length;
    const mark = hits[activeHit];
    mark.classList.add('jsonl-search-hit-active');
    // Scroll within the body only (mirrors scrollToJsonlEntry rationale).
    const bodyRect = body.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    body.scrollTop += (markRect.top - bodyRect.top) - body.clientHeight / 2;
    updateCount();
  }

  function run() {
    clearHighlights();
    const t = input.value.trim();
    if (!t) { matches = []; listEl.innerHTML = ''; listEl.style.display = 'none'; countEl.textContent = ''; return; }
    const msgs = collectMessages();
    matches = searchTranscript(
      msgs.map((m) => ({ entryIndex: m.entryIndex, role: m.role, text: m.text })),
      t, typeSel.value);
    const matched = new Set(matches.map((m) => m.entryIndex));
    for (const m of msgs) { if (matched.has(m.entryIndex)) highlightIn(m.el, t); }
    renderList();
    if (hits.length) setActive(0); else updateCount();
  }

  let debounce = null;
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(run, 150); });
  typeSel.addEventListener('change', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (hits.length) setActive(activeHit + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Escape') { e.preventDefault(); if (input.value) { input.value = ''; run(); } }
  });
  if (prevBtn) prevBtn.addEventListener('click', () => setActive(activeHit - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => setActive(activeHit + 1));
  if (listToggle) listToggle.addEventListener('click', () => {
    listEl.style.display = listEl.style.display === 'none' ? 'block' : 'none';
  });
  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.jsonl-search-item');
    if (!item) return;
    const idx = Number(item.dataset.entry);
    if (window.bookmarksTags && typeof window.bookmarksTags.scrollToJsonlEntry === 'function') {
      window.bookmarksTags.scrollToJsonlEntry(idx);
    }
    listEl.style.display = 'none';
  });

  // Reset on a fresh transcript render (body is rebuilt → old marks are gone).
  window._jsonlSearchReset = () => {
    input.value = '';
    typeSel.value = 'all';
    matches = []; hits = []; activeHit = -1;
    listEl.innerHTML = ''; listEl.style.display = 'none';
    countEl.textContent = '';
  };
})();
