// --- JSONL Message History Viewer ---
// Depends on globals: escapeHtml (utils.js), hideAllViewers, placeholder,
// terminalArea, jsonlViewer, jsonlViewerTitle, jsonlViewerSessionId, jsonlViewerBody (app.js)

// Current viewer session — set once per showJsonlViewer call, read by Agent renderer
let currentViewerSessionId = null;
// Counter for matching identical (description, subagentType) blocks in fanout scenarios
// Reset on each showJsonlViewer call. Key: "<contextSessionId>|<desc>|<type>"
let agentMatchCounters = {};

// --- Live subagent tracking ---
// Map<"<parentSessionId>:<agentId>", 'hook' | 'scan' | 'exact'> — which source vouches for
// this agent still running. Edge rules live in subagent-live.js (#121).
const liveSubagents = new Map();
// Exposed so the sidebar can seed the running-subagent indicator on (re)render (#111).
window._isSubagentLive = (parentSessionId, agentId) => isSubagentLive(liveSubagents, parentSessionId, agentId);
// How many subagents are live under a parent — feeds the parent's two-color overlay (#112).
window._liveSubagentCount = (parentSessionId) => liveSubagentCount(liveSubagents, parentSessionId);
// Parents with at least one live subagent — lets the overlay be rebuilt when the
// setting is toggled back on (#112).
window._liveSubagentParents = () => liveSubagentParents(liveSubagents);

// Single mutation point for the live set, fed by three sources (#119, #769):
//   'hook' — SubagentStart/SubagentStop, exact on both edges
//   'scan' — the JSONL spawn/complete heuristic, the fallback when hooks are off
//   'exact' — a runtime's own task lines over a pipe (#769), which no scan guess retracts
// The scan may not retract a hook-tracked agent: a subagent inside a long tool call
// writes nothing, so the stable-mtime heuristic would call it finished mid-run (#121).
function setSubagentLive(parentSessionId, agentId, isLive, source = 'scan') {
  if (!applySubagentEdge(liveSubagents, parentSessionId, agentId, isLive, source)) return;
  if (typeof window._updateSubagentLive === 'function') {
    window._updateSubagentLive(parentSessionId, agentId, isLive);
  }
  if (!isLive) {
    // Let an open watch container stop its watch and hide its indicator — a little after the end, because an
    // exact end (#769) can arrive before the agent's last lines reach the file, and the watch polls once a second.
    const key = parentSessionId + ':' + agentId;
    setTimeout(() => {
      if (isSubagentLive(liveSubagents, parentSessionId, agentId)) return;
      document.querySelectorAll('[data-subagent-watch-key="' + key + '"]').forEach(el => {
        el.dispatchEvent(new CustomEvent('subagent-completed-internal'));
      });
    }, 2500);
  }
}
window._setSubagentLive = setSubagentLive;

// Active subagent file watches for the currently-rendered viewer. Each entry
// is a stopWatch closure created when an Agent block expands and starts a
// live tail. Drained on viewer dismissal so we don't leak fs.watchFile polls.
// Attached to `window` so the cross-file hideAllViewers() (in plans-memory-view.js)
// can drain via the function declaration below — top-level `const` in classic
// scripts isn't global.
window.__activeViewerWatches = window.__activeViewerWatches || new Set();
const activeViewerWatches = window.__activeViewerWatches;
function drainViewerWatches() {
  for (const stop of activeViewerWatches) {
    try { stop(); } catch {}
  }
  activeViewerWatches.clear();
}

// Live-tail one subagent transcript (#232). Both places that render a subagent — the sidebar's
// read-only view and the inline Agent-block expansion — go through here, so there is ONE start,
// one teardown and one live marker.
//
// The IPC for this existed on both sides since #76 and had no caller at all: nothing set
// `data-subagent-watch-key`, so the `subagent-watch-data` event this module dispatches (see
// initSubagentListeners) landed nowhere, `activeWatchId` stayed null, and every subagent transcript
// in the app was a snapshot that looked finished.
//
// container    — gets the watch key; it is what onSubagentWatchEvent targets.
// indicatorHost — where the "live" marker is appended (the escape banner, or the Agent block).
// entries      — what is already rendered. Kept so the tool-result map spans the whole transcript:
//                a tool_result arriving in a later append must still find its tool_use.
// renderInto   — called with (freshEntries, toolResultMap) to append the new entries.
// Returns its own stop function, already registered in activeViewerWatches.
function attachSubagentLiveTail({ container, indicatorHost, parentSessionId, agentId, entries, renderInto }) {
  const noop = () => {};
  if (!window.api || typeof window.api.startSubagentWatch !== 'function') return noop;
  if (!parentSessionId || !agentId) return noop;

  const all = (entries || []).slice();
  let watchId = null;
  let stopped = false;

  const indicator = document.createElement('span');
  indicator.className = 'jsonl-subagent-live-indicator';
  indicator.textContent = 'live';
  // Only claim "live" when something vouches for it. An append is itself proof (see onData), so a
  // transcript that starts growing while open picks the marker up without waiting for the scan.
  if (indicatorHost && typeof isSubagentLive === 'function'
      && isSubagentLive(liveSubagents, parentSessionId, agentId)) {
    indicatorHost.appendChild(indicator);
  }

  function onData(ev) {
    const payload = ev && ev.detail;
    if (!payload || !payload.entries || !payload.entries.length) return;
    const fresh = mergeLocalCommandEntries(payload.entries);
    all.push(...fresh);
    if (indicatorHost && !indicator.isConnected) indicatorHost.appendChild(indicator);
    try { renderInto(fresh, buildToolResultMap(all)); } catch {}
  }

  function stopWatch() {
    if (stopped) return;
    stopped = true;
    container.removeEventListener('subagent-watch-data', onData);
    container.removeEventListener('subagent-completed-internal', stopWatch);
    delete container.dataset.subagentWatchKey;
    indicator.remove();
    activeViewerWatches.delete(stopWatch);
    // The id may not have arrived yet — the invoke below stops it in that case.
    if (watchId !== null) {
      window.api.stopSubagentWatch(watchId).catch(() => {});
      watchId = null;
    }
  }

  container.dataset.subagentWatchKey = parentSessionId + ':' + agentId;
  container.addEventListener('subagent-watch-data', onData);
  // setSubagentLive fires this at the falling edge, so a finished subagent stops polling itself.
  container.addEventListener('subagent-completed-internal', stopWatch);
  activeViewerWatches.add(stopWatch);

  window.api.startSubagentWatch(parentSessionId, agentId).then(res => {
    if (stopped) {
      // Torn down while the invoke was in flight — release the watcher main just created.
      if (res && res.watchId != null) window.api.stopSubagentWatch(res.watchId).catch(() => {});
      return;
    }
    if (res && res.watchId != null) watchId = res.watchId;
    else stopWatch();   // the backend declined (no subagents, no file) — no marker, no poll
  }).catch(() => stopWatch());

  return stopWatch;
}

// Register IPC listeners for subagent lifecycle events (called once at module load).
(function initSubagentListeners() {
  if (!window.api) return; // guard for non-Electron contexts
  window.api.onSubagentSpawned((payload) => setSubagentLive(payload.parentSessionId, payload.agentId, true, 'scan'));
  // `final` marks the completion the scan stood by long enough to outrank a hook edge that never came
  // (#518) — the ordinary guess still may not retract a hook-tracked agent.
  window.api.onSubagentCompleted((payload) => setSubagentLive(payload.parentSessionId, payload.agentId, false, payload.final ? 'scan-final' : 'scan'));
  window.api.onSubagentWatchEvent((payload) => {
    const key = payload.parentSessionId + ':' + payload.agentId;
    document.querySelectorAll('[data-subagent-watch-key="' + key + '"]').forEach(el => {
      el.dispatchEvent(new CustomEvent('subagent-watch-data', { detail: payload }));
    });
  });
})()

// marked comes from its own <script> tag in index.html (#686); every caller of `window.marked` shares these
// options. They used to be set inside the lazy codemirror bundle, so until a file viewer opened nothing
// rendered as markdown at all.
if (window.marked && typeof window.marked.setOptions === 'function') window.marked.setOptions({ breaks: true, gfm: true });

// Two things in a transcript's text that markdown would change, each carried past `marked` as a private-use
// character and put back afterwards (#711). A stand-in rather than an escape: `marked` takes a code span or a
// code block literally and escapes an `&` there once more, so an `&lt;` written in before the parse showed
// as `&lt;` inside code. A private-use character is plain text everywhere, code included, and becomes the
// entity only after the parse.
// - `<tag>`-shaped text shows as text and is never read as HTML (the sanitising below is the XSS guard;
//   this is only about what the reader sees). The stand-in is not punctuation, so `_foo_<b>` no longer
//   closes the emphasis the way the old `&lt;` did — a price taken for code showing what was written.
// - A backslash inside a Windows path stays: CommonMark reads `\.` as an escaped dot, so `~\.claude\skills`
//   lost the backslash before `.claude` and named another directory. A run is a path when it starts with a
//   drive, `~\`, `%VAR%\` or `\\`, or holds two backslashes of which one starts a segment (`\skills`). A
//   run of escapes only (`my\_var`, `\_\_init\_\_`) is left to markdown, because that is the spelling of an
//   escape. Where the two collide, the path wins.
//   The stand-in goes IN FRONT of the backslash, which stays and keeps escaping the next character: outside
//   code `marked` eats the backslash and the stand-in brings it back, inside code both survive and the pair
//   becomes one backslash again. `restoreMarkdownText` therefore tells code from prose in marked's OUTPUT,
//   where a code span or block is an unambiguous `<code>` element.
// A stand-in inside a link is percent-encoded by `marked`, so it is put back in that form too. Text that
// already holds one of these three characters has it turned into the thing it stands for.
const MD_LT = String.fromCharCode(0xE000);
const MD_GT = String.fromCharCode(0xE001);
const MD_BACKSLASH = String.fromCharCode(0xE002);
const MD_ENCODED = [['%EE%80%80', '%3C'], ['%EE%80%81', '%3E'], ['%EE%80%82', '%5C']];
const MD_PATH_RUN = /(?:\\\S|[^\s`'"()<>[\]\\])+/g;
const MD_PATH_START = /^(?:[A-Za-z]:\\|~\\|%\w+%\\|\\\\[A-Za-z0-9])/;
// A URL is never a path here: `marked` does not unescape inside an autolink, so a stand-in there would leave a
// doubled backslash in the link and its text.
const MD_URL_START = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
function protectMarkdownText(text) {
  return text
    .replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?)\>/g, MD_LT + '$1' + MD_GT)
    .replace(MD_PATH_RUN, (run) => {
      if (MD_URL_START.test(run)) return run;
      if (!MD_PATH_START.test(run) && (run.split('\\').length < 3 || !/\\[A-Za-z0-9]/.test(run))) return run;
      return run.replace(/\\(?=[!-/:-@[-`{-~])/g, MD_BACKSLASH + '\\');
    });
}
function restoreMarkdownText(html) {
  const tags = (s) => s.split(MD_LT).join('&lt;').split(MD_GT).join('&gt;');
  let out = html;
  for (const [encoded, plain] of MD_ENCODED) out = out.split(encoded).join(plain);
  return out.split(/(<code\b[^>]*>[\s\S]*?<\/code>)/).map((part, i) => (i % 2
    ? tags(part.split(MD_BACKSLASH + '\\').join('\\').split(MD_BACKSLASH).join('\\'))
    : tags(part.split(MD_BACKSLASH).join('\\')))).join('');
}

function renderJsonlText(text) {
  if (window.marked) {
    const html = restoreMarkdownText(window.marked.parse(protectMarkdownText(text)));
    // `protectMarkdownText` only keeps <tag>-shaped text from being read as HTML, not marked-generated
    // hrefs such as [x](javascript:...). Sanitize like the sibling viewers
    // (viewer-panel.js / viewer-toolbar.js); fall back to escaped plain text if
    // DOMPurify isn't loaded — never depend on load order for XSS safety.
    return window.DOMPurify ? window.DOMPurify.sanitize(html) : escapeHtml(text);
  }
  // Fallback if marked isn't loaded
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="jsonl-code-block"><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="jsonl-inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = (ms / 1000).toFixed(1);
  return s + 's';
}

function makeInlineContent(className, bodyContent) {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const body = document.createElement('pre');
  body.className = 'jsonl-tool-body';
  body.style.display = '';
  if (typeof bodyContent === 'string') {
    body.textContent = bodyContent;
  } else {
    try { body.textContent = JSON.stringify(bodyContent, null, 2); } catch { body.textContent = String(bodyContent); }
  }
  wrapper.appendChild(body);
  return wrapper;
}

function makeCollapsible(className, headerText, bodyContent, startExpanded) {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const header = document.createElement('div');
  header.className = 'jsonl-toggle' + (startExpanded ? ' expanded' : '');
  header.textContent = headerText;
  const body = document.createElement('pre');
  body.className = 'jsonl-tool-body';
  body.style.display = startExpanded ? '' : 'none';
  if (typeof bodyContent === 'string') {
    body.textContent = bodyContent;
  } else {
    try { body.textContent = JSON.stringify(bodyContent, null, 2); } catch { body.textContent = String(bodyContent); }
  }
  header.onclick = () => {
    const showing = body.style.display !== 'none';
    body.style.display = showing ? 'none' : '';
    header.classList.toggle('expanded', !showing);
  };
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}

// --- Tool use rendering ---
// Renders tool calls in a bullet + indented content style matching Claude Code's terminal.

// Whether a tool call's body — its input and its output — starts open (#687). Global setting, default OFF:
// in a long session the tool output is most of the screen. Read at draw time, so a change applies to what is
// drawn next. `appGlobalSettings` belongs to app.js; a page or a test without it gets the default.
function toolOutputStartsExpanded() {
  return typeof appGlobalSettings !== 'undefined' && !!appGlobalSettings && appGlobalSettings.expandToolOutput === true;
}

// #755: how a document a tool wrote or read is drawn, and how large one may be before its card draws no
// thumbnail. Both read at call time from the global settings; junk or a missing value gets the default.
const DOCUMENT_PREVIEW_MAX_KB_DEFAULT = 2048;
function documentPreviewMode() {
  const s = typeof appGlobalSettings !== 'undefined' ? appGlobalSettings : null;
  return s && s.documentPreview === 'inline' ? 'inline' : 'card';
}
function documentPreviewMaxBytes() {
  const s = typeof appGlobalSettings !== 'undefined' ? appGlobalSettings : null;
  const kb = s ? s.documentPreviewMaxKB : undefined;
  const ok = typeof kb === 'number' && Number.isFinite(kb) && kb >= 64 && kb <= 65536;
  return Math.floor(ok ? kb : DOCUMENT_PREVIEW_MAX_KB_DEFAULT) * 1024;
}

// A header click, remembered by tool_use id: the result arriving redraws the whole entry (the conversation
// view replaces its element), and a call the user just opened must not snap shut under them.
const toolExpandChoices = new Map();

function makeToolCollapsible(toolEl, toolUseId) {
  // An Agent block in the history viewer opens and closes on a click of its own — it fetches the subagent's
  // transcript — and a second toggle on the same click would do both at once. Only where that click was wired:
  // the conversation view has no viewer session to fetch against, so there the block collapses like any other.
  if (toolEl.dataset.ownToggle === '1') return;
  const header = toolEl.querySelector(':scope > .jsonl-tool-header');
  const content = toolEl.querySelector(':scope > .jsonl-tool-content');
  if (!header || !content) return;
  const expanded = toolUseId && toolExpandChoices.has(toolUseId)
    ? toolExpandChoices.get(toolUseId)
    : toolOutputStartsExpanded();
  toolEl.classList.add('jsonl-tool-collapsible');
  toolEl.classList.toggle('jsonl-tool-collapsed', !expanded);
  // A call whose header says only its name (Bash keeps its command in the body) would read as a bare
  // "Bash" once closed, so the header carries the command's first line — shown only while closed.
  const cmd = content.querySelector(':scope > .jsonl-tool-cmd-block');
  if (cmd && !header.querySelector('.jsonl-tool-summary')) {
    const line = (cmd.textContent || '').split('\n')[0].trim();
    if (line) {
      const peek = document.createElement('span');
      peek.className = 'jsonl-tool-summary jsonl-tool-peek';
      const code = document.createElement('code');
      code.textContent = line;
      peek.appendChild(code);
      header.appendChild(peek);
    }
  }
  header.addEventListener('click', (e) => {
    // A link in the summary keeps its own click, and a drag that selected text is a copy, not a toggle.
    if (e.target.closest('a, button')) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && header.contains(sel.anchorNode)) return;
    const nowExpanded = toolEl.classList.toggle('jsonl-tool-collapsed') === false;
    if (toolUseId) toolExpandChoices.set(toolUseId, nowExpanded);
  });
}

function toolBlock(color, label, summary, content) {
  const el = document.createElement('div');
  el.className = 'jsonl-tool-block';
  const header = document.createElement('div');
  header.className = 'jsonl-tool-header';
  header.innerHTML = '<span class="jsonl-tool-bullet" style="color:' + color + '">●</span>'
    + '<span class="jsonl-tool-name">' + escapeHtml(label) + '</span>'
    + (summary ? '<span class="jsonl-tool-summary">' + summary + '</span>' : '');
  el.appendChild(header);
  if (content) {
    const body = document.createElement('div');
    body.className = 'jsonl-tool-content';
    if (typeof content === 'string') {
      body.innerHTML = content;
    } else {
      body.appendChild(content);
    }
    el.appendChild(body);
  }
  return el;
}

function renderToolUse(block) {
  const name = block.name || 'unknown';
  const input = block.input || {};
  // Arguments still streaming (`src/shared/partial-args.js`): the text so far, not a renderer handed half an
  // object — a Write would draw with no path and no content until the call finished.
  if (isPartialArgs(input)) {
    return toolBlock('#8888a0', name, '', makeCollapsible('jsonl-tool-result', 'Input', input[PARTIAL_ARGS_KEY], true));
  }
  const renderer = toolRenderers[name];
  if (renderer) {
    try { return renderer(input, block); } catch {}
  }
  // MCP / computer-use tools with an action field
  if (input.action) {
    try { return renderMcpAction(name, input, block); } catch {}
  }
  // Default: collapsible JSON
  return toolBlock('#8888a0', name, '', makeCollapsible('jsonl-tool-result', 'Input', input, true));
}

function renderMcpAction(name, input, block) {
  const action = input.action;
  // Short display name: strip mcp__ prefix, take last segment
  const shortName = name.replace(/^mcp__/, '').split('__').pop();
  const actionLabels = {
    type: 'Type',
    screenshot: 'Screenshot',
    click: 'Click',
    scroll: 'Scroll',
    hover: 'Hover',
    drag: 'Drag',
    key: 'Key',
    wait: 'Wait',
    javascript_exec: 'JS Exec',
    navigate: 'Navigate',
  };
  const label = actionLabels[action] || action;
  let summary = '<span class="jsonl-tool-detail">' + escapeHtml(shortName) + '</span>';
  let content = null;

  if (action === 'type' && input.text) {
    summary += ' <code>' + escapeHtml(input.text.length > 80 ? input.text.slice(0, 80) + '...' : input.text) + '</code>';
  } else if (action === 'click' && (input.x != null || input.selector)) {
    const target = input.selector || `(${input.x}, ${input.y})`;
    summary += ' <code>' + escapeHtml(target) + '</code>';
  } else if (action === 'key' && input.key) {
    summary += ' <code>' + escapeHtml(input.key) + '</code>';
  } else if (action === 'navigate' && input.url) {
    summary += ' <code>' + escapeHtml(input.url.length > 80 ? input.url.slice(0, 80) + '...' : input.url) + '</code>';
  } else if (action === 'scroll') {
    const dir = input.direction || (input.deltaY > 0 ? 'down' : 'up');
    summary += ' <span class="jsonl-tool-detail">' + escapeHtml(dir) + '</span>';
  } else if (action === 'javascript_exec' && input.text) {
    const pre = document.createElement('pre');
    pre.className = 'jsonl-tool-cmd-block';
    pre.textContent = input.text;
    content = pre;
  }

  return toolBlock('#c090e0', label, summary, content);
}

function shortPath(p) {
  return (p || '').split('/').slice(-3).join('/');
}

const toolRenderers = {
  Read(input) {
    const path = input.file_path || '';
    let range = '';
    if (input.offset || input.limit) {
      const start = input.offset || 0;
      range = input.limit ? `:${start}-${start + input.limit}` : `:${start}`;
    }
    return toolBlock('#8888a0', 'Read', '<code>' + escapeHtml(shortPath(path) + range) + '</code>', null);
  },

  Edit(input) {
    const path = input.file_path || '';
    let content = null;
    if (input.old_string != null && input.new_string != null) {
      const diff = document.createElement('pre');
      diff.className = 'jsonl-tool-diff';
      let html = '';
      for (const line of input.old_string.split('\n')) {
        html += '<span class="jsonl-diff-del">- ' + escapeHtml(line) + '</span>\n';
      }
      for (const line of input.new_string.split('\n')) {
        html += '<span class="jsonl-diff-add">+ ' + escapeHtml(line) + '</span>\n';
      }
      diff.innerHTML = html;
      content = diff;
    }
    return toolBlock('#e0a040', 'Edit', '<code>' + escapeHtml(shortPath(path)) + '</code>', content);
  },

  Write(input) {
    const path = input.file_path || '';
    const lines = (input.content || '').split('\n').length;
    const detail = '<code>' + escapeHtml(shortPath(path)) + '</code> <span class="jsonl-tool-detail">' + lines + ' lines</span>';
    let content = null;
    if (input.content) {
      content = makeCollapsible('jsonl-tool-result', 'Content', input.content, true);
    }
    return toolBlock('#60c060', 'Write', detail, content);
  },

  Bash(input) {
    const cmd = input.command || '';
    const pre = document.createElement('pre');
    pre.className = 'jsonl-tool-cmd-block';
    pre.textContent = cmd;
    return toolBlock('#80c0e0', 'Bash', null, pre);
  },

  Grep(input) {
    const pattern = input.pattern || '';
    const path = input.path || '';
    const sp = path ? shortPath(path) : '';
    const summary = '<code>' + escapeHtml(pattern) + (sp ? ' in ' + escapeHtml(sp) : '') + '</code>';
    return toolBlock('#c090e0', 'Grep', summary, null);
  },

  Glob(input) {
    const pattern = input.pattern || '';
    return toolBlock('#c090e0', 'Glob', '<code>' + escapeHtml(pattern) + '</code>', null);
  },

  Agent(input, block) {
    const desc = input.description || '';
    const type = input.subagent_type || '';
    const caretSpan = '<span class="jsonl-agent-caret">&#9658;</span> ';
    const summary = caretSpan
      + (type ? '<span class="jsonl-tool-detail">' + escapeHtml(type) + '</span> ' : '')
      + escapeHtml(desc);
    const el = toolBlock('#f0a050', 'Agent', summary, null);
    el.classList.add('jsonl-agent-expandable');
    // Capture context at render time
    const parentSessionId = currentViewerSessionId;
    if (!parentSessionId) return el;

    // Determine which Nth match this block is for fanout deduplication
    const counterKey = parentSessionId + '|' + desc + '|' + type;
    if (agentMatchCounters[counterKey] === undefined) agentMatchCounters[counterKey] = 0;
    const matchIndex = agentMatchCounters[counterKey]++;

    let expanded = false;
    let nestedContainer = null;
    let stopWatch = null;
    // Says that this block opens on a click of its own (below), so `makeToolCollapsible` leaves it alone.
    el.dataset.ownToggle = '1';

    el.addEventListener('click', async () => {
      if (expanded && nestedContainer) {
        // Collapse — and stop the tail with it, or the poll outlives what it was feeding.
        if (stopWatch) { stopWatch(); stopWatch = null; }
        nestedContainer.remove();
        nestedContainer = null;
        expanded = false;
        const caret = el.querySelector('.jsonl-agent-caret');
        if (caret) caret.innerHTML = '&#9658;';
        return;
      }
      // Fetch subagent list for this parent
      const subagents = await window.api.listSubagents(parentSessionId);
      const matches = subagents.filter(s =>
        (s.description || '') === desc && (s.subagentType || '') === type
      );
      const match = matches[matchIndex] || matches[0];
      if (!match) return;

      const result = await window.api.readSubagentJsonl(parentSessionId, match.agentId);
      if (result.error || !result.entries) return;

      nestedContainer = document.createElement('div');
      nestedContainer.className = 'jsonl-subagent-nested';

      const subSessionId = match.sessionId;
      const rawNested = result.entries;
      const nestedEntries = mergeLocalCommandEntries(rawNested);

      const nestedResultMap = buildToolResultMap(nestedEntries);

      // Nested entries render in the SUBAGENT's session context (its own agent blocks resolve
      // against it), so the swap has to wrap every render — the live tail below included.
      function renderNested(list, map) {
        const prev = currentViewerSessionId;
        currentViewerSessionId = subSessionId;
        for (const entry of list) {
          const entryEl = renderJsonlEntry(entry, map);
          if (entryEl) nestedContainer.appendChild(entryEl);
        }
        currentViewerSessionId = prev;
      }
      renderNested(nestedEntries, nestedResultMap);

      el.after(nestedContainer);
      expanded = true;
      const caret = el.querySelector('.jsonl-agent-caret');
      if (caret) caret.innerHTML = '&#9660;';

      stopWatch = attachSubagentLiveTail({
        container: nestedContainer,
        indicatorHost: el,
        parentSessionId,
        agentId: match.agentId,
        entries: nestedEntries,
        renderInto: renderNested,
      });
    });

    return el;
  },
};

// Render a local command (! prefix) as a tool block
function renderLocalCommand({ cmd, output }) {
  const pre = document.createElement('pre');
  pre.className = 'jsonl-tool-cmd-block';
  pre.textContent = cmd;

  const el = toolBlock('#80c0e0', 'Bash', '<span class="jsonl-tool-detail">local</span>', pre);

  if (output) {
    let contentEl = el.querySelector('.jsonl-tool-content');
    if (!contentEl) {
      contentEl = document.createElement('div');
      contentEl.className = 'jsonl-tool-content';
      el.appendChild(contentEl);
    }
    const resultPre = document.createElement('pre');
    resultPre.className = 'jsonl-tool-cmd-block';
    resultPre.textContent = output;
    contentEl.appendChild(resultPre);
  }

  return el;
}

// Merge consecutive local command entries (separate JSONL entries for caveat, bash-input, stdout/stderr)
function mergeLocalCommandEntries(entries) {
  const result = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const text = getEntryText(entry);

    // Look for a local-command-caveat or bash-input entry
    if (text && (/<local-command-caveat>/.test(text) || /<bash-input>/.test(text))) {
      // Gather consecutive entries that are part of this local command
      let combined = '';
      const start = i;
      while (i < entries.length) {
        const t = getEntryText(entries[i]);
        if (!t) break;
        // Stop if we hit a non-local-command entry (no XML tags we recognize)
        if (i > start && !/<bash-input>|<bash-stdout>|<bash-stderr>|<local-command-caveat>/.test(t)) break;
        combined += t + '\n';
        i++;
        // Stop after we've seen stdout or stderr (end of command)
        if (/<\/bash-stdout>|<\/bash-stderr>/.test(t)) break;
      }

      const inputMatch = combined.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
      if (inputMatch) {
        const cmd = inputMatch[1].trim();
        const stdoutMatch = combined.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
        const stderrMatch = combined.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
        const stdout = stdoutMatch ? stdoutMatch[1].trim() : '';
        const stderr = stderrMatch ? stderrMatch[1].trim() : '';
        const output = [stdout, stderr].filter(Boolean).join('\n');
        // Create a synthetic entry
        result.push({ _localCmd: { cmd, output }, type: 'local-command' });
      } else {
        // Couldn't parse, keep original entries
        for (let j = start; j < i; j++) result.push(entries[j]);
      }
    } else {
      result.push(entry);
      i++;
    }
  }
  return result;
}

function getEntryText(entry) {
  if (!entry) return null;
  const content = entry.message?.content || entry.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return null;
}

// Merge local command blocks within a single entry's text blocks
function mergeLocalCommandBlocks(blocks) {
  // Check if any text block contains <bash-input>
  const hasLocalCmd = blocks.some(b => b.type === 'text' && b.text && /<bash-input>/.test(b.text));
  if (!hasLocalCmd) return blocks;

  // Concatenate all text blocks to find the full command structure
  let combined = '';
  for (const b of blocks) {
    if (b.type === 'text' && b.text) combined += b.text + '\n';
  }

  const inputMatch = combined.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (!inputMatch) return blocks;

  const cmd = inputMatch[1].trim();
  const stdoutMatch = combined.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
  const stderrMatch = combined.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
  const stdout = stdoutMatch ? stdoutMatch[1].trim() : '';
  const stderr = stderrMatch ? stderrMatch[1].trim() : '';
  const output = [stdout, stderr].filter(Boolean).join('\n');

  // Replace all text blocks with a single merged one
  const merged = { type: 'text', text: combined, _localCmd: { cmd, output } };
  const result = [];
  let replacedText = false;
  for (const b of blocks) {
    if (b.type === 'text') {
      if (!replacedText) {
        result.push(merged);
        replacedText = true;
      }
      // skip other text blocks
    } else {
      result.push(b);
    }
  }
  return result;
}

// Build tool_use_id → result content map so results render under their tool
// call. Shared by the main viewer, the subagent transcript, and nested Agent
// block expansion (#79).
function buildToolResultMap(entries) {
  const toolResultMap = new Map();
  for (const entry of entries) {
    const blocks = entry.message?.content || entry.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        toolResultMap.set(block.tool_use_id, block.content || block.output || '');
      }
    }
  }
  return toolResultMap;
}

// Fullscreen image overlay (click anywhere to dismiss) — shared by inline tool
// screenshots and the post-render clickable-image wiring (#79).
function openImageFullscreen(src) {
  const overlay = document.createElement('div');
  overlay.className = 'jsonl-screenshot-fullscreen';
  const fullImg = document.createElement('img');
  fullImg.src = src;
  overlay.appendChild(fullImg);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// Render a tool result into a container, handling images, text, and mixed content
// `ctx = { sessionId, host }` is given by the conversation view only. A result stamped with a document element
// (#755) is drawn as ONE card in card mode: the card is RETURNED, not appended, so the caller can seat it outside
// the collapsible body (a collapsed call still shows its card); Markdown and HTML keep their text, collapsed,
// inside the body. Anything else draws as it always did and returns null.
function renderToolResult(resultData, container, ctx) {
  if (documentPreviewMode() === 'card' && typeof renderDocumentCard === 'function') {
    const card = renderDocumentCard(resultData, ctx);
    if (card) {
      const kind = card.dataset.kind;
      const text = (kind === 'markdown' || kind === 'html') ? extractResultText(resultData) : null;
      if (text) container.appendChild(makeCollapsible('jsonl-tool-result', 'Text', text, false));
      return card;
    }
  }
  // Try to extract image data from the result
  const images = extractImages(resultData);
  const textParts = extractResultText(resultData);

  if (textParts) {
    container.appendChild(makeInlineContent('jsonl-tool-result', textParts));
  }
  for (const img of images) {
    const imgEl = document.createElement('img');
    imgEl.className = 'jsonl-tool-screenshot';
    imgEl.src = img.src;
    if (img.alt) imgEl.alt = img.alt;
    imgEl.onclick = () => openImageFullscreen(img.src);
    container.appendChild(imgEl);
  }
  return null;
}

function extractImages(data) {
  const images = [];
  if (!data) return images;

  // String result — may contain JSON with image data
  if (typeof data === 'string') {
    // Look for {"type":"image","source":... } JSON in the string
    const imgMatches = data.matchAll(/\{"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*"data"\s*:\s*"([^"]+)"[^}]*\}/g);
    for (const m of imgMatches) {
      const base64 = m[1];
      // Detect media type from the JSON or default to jpeg
      const mediaMatch = m[0].match(/"media_type"\s*:\s*"([^"]+)"/);
      const mediaType = mediaMatch ? mediaMatch[1] : 'image/jpeg';
      images.push({ src: `data:${mediaType};base64,${base64}` });
    }
    return images;
  }

  // Array of content blocks
  if (Array.isArray(data)) {
    for (const block of data) {
      if (block.type === 'image' && block.source?.data) {
        const mediaType = block.source.media_type || 'image/jpeg';
        images.push({ src: `data:${mediaType};base64,${block.source.data}` });
      }
    }
  }
  return images;
}

function extractResultText(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    // Strip the image JSON blobs from the display text
    const cleaned = data.replace(/\{"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*\}\s*\}/g, '').trim();
    return cleaned || null;
  }
  if (Array.isArray(data)) {
    const texts = data.filter(b => b.type === 'text' || b.text).map(b => b.text || JSON.stringify(b));
    return texts.length ? texts.join('\n') : null;
  }
  return JSON.stringify(data, null, 2);
}

function renderJsonlEntry(entry, toolResultMap, ctx) {
  // Synthetic local command entry from mergeLocalCommandEntries
  if (entry._localCmd) {
    return renderLocalCommand(entry._localCmd);
  }

  const ts = entry.timestamp;
  const timeStr = ts ? new Date(ts).toLocaleTimeString() : '';

  // --- custom-title ---
  if (entry.type === 'custom-title') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    div.innerHTML = '<span class="jsonl-meta-icon">T</span> Title set: <strong>' + escapeHtml(entry.customTitle || '') + '</strong>';
    return div;
  }

  // --- a background task that ended (#691) ---
  // A backend-neutral entry: the backend turns its own notification into `{ type: 'task-notice', _task }`,
  // so nothing here reads a CLI's markup. The Output button is answered by the conversation view, which knows
  // the session and opens the text inside this card; it is offered for a shell or a task of no known kind, not
  // for an agent, whose result is here and whose transcript the Open button below reaches.
  if (entry.type === 'task-notice' && entry._task) {
    const t = entry._task;
    const div = document.createElement('div');
    const stopped = t.status === 'stopped' || t.status === 'killed';
    const failed = t.status === 'failed' || (Number.isFinite(t.exitCode) && t.exitCode !== 0);
    div.className = 'jsonl-entry task-notice' + (stopped ? ' stopped' : failed ? ' failed' : '');
    const icon = document.createElement('span');
    icon.className = 'task-notice-icon';
    icon.textContent = stopped ? '■' : failed ? '✗' : '✓';
    const what = document.createElement('span');
    what.className = 'task-notice-what';
    const kind = { shell: 'Shell', agent: 'Agent' }[t.kind] || 'Task';
    const name = document.createElement('b');
    name.textContent = t.description || t.summary || '';
    what.appendChild(document.createTextNode(kind + ' '));
    what.appendChild(name);
    what.appendChild(document.createTextNode(' ' + (stopped ? 'stopped' : failed ? 'failed' : 'finished')));
    const meta = document.createElement('span');
    meta.className = 'task-notice-meta';
    const parts = [];
    if (Number.isFinite(t.exitCode)) parts.push('exit ' + t.exitCode);
    if (Number.isFinite(t.durationMs)) parts.push(formatDuration(t.durationMs));
    if (Number.isFinite(t.tokens)) parts.push(t.tokens.toLocaleString() + ' tokens');
    meta.textContent = parts.join(' · ');
    div.appendChild(icon);
    div.appendChild(what);
    div.appendChild(meta);
    // Only where the core found output to show (#725) — never for a notice read back from history (#705), where
    // no running session is there to read it from, and not for a task whose file is empty or gone.
    if (t.id && t.kind !== 'agent' && t.hasOutput && !t.historic) {
      const out = document.createElement('button');
      out.type = 'button';
      out.className = 'task-notice-output';
      out.dataset.taskId = t.id;
      out.textContent = 'output';
      out.title = 'Show the end of this task\'s output';
      div.appendChild(out);
    }
    // An agent whose subagent the backend named (#695) opens its transcript; the conversation view answers it in
    // its log, `openAgentFromHistory` in the history viewer (#705).
    if (t.kind === 'agent' && t.subagentId) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'task-notice-output task-notice-open';
      open.dataset.subagentId = t.subagentId;
      if (t.toolUseId) open.dataset.toolUseId = t.toolUseId;
      open.textContent = 'open';
      open.title = 'Open this agent\'s transcript';
      div.appendChild(open);
    }
    if (t.kind === 'agent' && t.result) div.title = t.result;
    return div;
  }

  // --- a subagent's report, or another session's message (#701, #729) ---
  // Backend-neutral like the notice above: the backend hands `{ type: 'agent-report', _report }` with the
  // report already out of its wrapping. Drawn as a card of its own, ALWAYS closed to one line saying what it is
  // and who sent it (#729): drawn open in the reply's style, it read as the main session answering. The line
  // opens it in place, by mouse or by Enter/Space. It keeps `jsonl-assistant` for the history search, which
  // opens a closed card around a hit. Its Open button is the notice's, answered the same two ways.
  if (entry.type === 'agent-report' && entry._report) {
    const r = entry._report;
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-assistant agent-report' + (r.text ? ' agent-report-closed' : '');
    const head = document.createElement('div');
    head.className = 'agent-report-head';
    const label = document.createElement('span');
    label.className = 'task-notice-what';
    label.appendChild(document.createTextNode(
      r.kind === 'report' || (!r.kind && r.handback) ? 'Agent report'
        : r.kind === 'agent' ? 'Message from an agent' : 'Message from another session'));
    const who = r.name || r.from;
    if (who) {
      const name = document.createElement('b');
      name.textContent = ' ' + who;
      label.appendChild(name);
    }
    head.appendChild(label);
    if (r.subagentId) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'task-notice-output task-notice-open';
      open.dataset.subagentId = r.subagentId;
      if (r.toolUseId) open.dataset.toolUseId = r.toolUseId;
      open.textContent = 'open';
      open.title = 'Open this agent\'s transcript';
      head.appendChild(open);
    }
    div.appendChild(head);
    if (r.text) {
      const textEl = document.createElement('div');
      textEl.className = 'jsonl-text agent-report-text';
      textEl.innerHTML = renderJsonlText(r.text);
      div.appendChild(textEl);
      head.classList.add('agent-report-toggle');
      head.tabIndex = 0;
      head.setAttribute('role', 'button');
      head.setAttribute('aria-expanded', 'false');
      head.title = 'Show or hide the report';
      const toggle = () => {
        const open = div.classList.toggle('agent-report-closed') === false;
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      head.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        toggle();
      });
      head.addEventListener('keydown', (e) => {
        if (e.target !== head || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        toggle();
      });
    }
    return div;
  }

  // --- backend-normalized metadata entries ---
  if (entry.type === 'transcript-meta') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    const detail = entry.detail ? ' <span class="jsonl-tool-detail">' + escapeHtml(entry.detail) + '</span>' : '';
    div.innerHTML = '<span class="jsonl-meta-icon">' + escapeHtml(entry.icon || 'i') + '</span> '
      + '<strong>' + escapeHtml(entry.label || 'Transcript event') + '</strong>' + detail
      + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    if (entry.content) {
      div.appendChild(makeCollapsible('jsonl-tool-result', 'Details', entry.content, false));
    }
    return div;
  }

  // --- system entries ---
  if (entry.type === 'system') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    if (entry.subtype === 'turn_duration') {
      div.innerHTML = '<span class="jsonl-meta-icon">&#9201;</span> Turn duration: <strong>' + formatDuration(entry.durationMs) + '</strong>'
        + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    } else {
      // A local command's system line is the backend's to read (#705): Claude's normaliser turns it into the
      // command as typed and its output as text, so nothing here parses that markup.
      return null;
    }
    return div;
  }

  // --- progress entries ---
  if (entry.type === 'progress') {
    const data = entry.data;
    if (!data || typeof data !== 'object') return null;
    const dt = data.type;
    if (dt === 'bash_progress') {
      const div = document.createElement('div');
      div.className = 'jsonl-entry jsonl-meta-entry';
      const elapsed = data.elapsedTimeSeconds ? ` (${data.elapsedTimeSeconds}s, ${data.totalLines || 0} lines)` : '';
      div.innerHTML = '<span class="jsonl-meta-icon">&#9658;</span> Bash output' + escapeHtml(elapsed);
      if (data.output || data.fullOutput) {
        const output = data.fullOutput || data.output || '';
        div.appendChild(makeCollapsible('jsonl-tool-result', 'Output', output, toolOutputStartsExpanded()));
      }
      return div;
    }
    // Skip noisy progress types
    return null;
  }

  // --- user / assistant messages ---
  let role = null;
  let contentBlocks = null;

  // Every backend nests the turn differently, and getting this wrong renders a BLANK panel behind a
  // button we cheerfully offer on the row:
  //   Claude  {type:'user'|'assistant', message:{content}}
  //   Pi      {type:'message',      message:{role, content:[…]}}
  //   Codex   {type:'response_item', payload:{type:'message', role, content:[…]}}
  const entryRole = entry.role || entry.message?.role || entry.payload?.role || null;
  const isCodexMessage = entry.type === 'response_item' && entry.payload?.type === 'message';
  const nested = entry.message?.content || entry.payload?.content || entry.content;

  if (entry.type === 'user' || ((entry.type === 'message' || isCodexMessage) && entryRole === 'user')) {
    role = 'user';
    contentBlocks = nested;
  } else if (entry.type === 'assistant' || ((entry.type === 'message' || isCodexMessage) && entryRole === 'assistant')) {
    role = 'assistant';
    contentBlocks = nested;
  } else {
    return null;
  }

  if (!contentBlocks) return null;
  if (typeof contentBlocks === 'string') {
    contentBlocks = [{ type: 'text', text: contentBlocks }];
  }
  if (!Array.isArray(contentBlocks)) return null;

  // Detect local command execution across multiple text blocks and merge
  contentBlocks = mergeLocalCommandBlocks(contentBlocks);

  // User messages that are purely tool results get assistant styling
  const isToolResultOnly = role === 'user' && Array.isArray(contentBlocks) &&
    contentBlocks.every(b => b.type === 'tool_result');
  const visualRole = isToolResultOnly ? 'assistant' : role;

  const div = document.createElement('div');
  div.className = 'jsonl-entry ' + (visualRole === 'user' ? 'jsonl-user' : 'jsonl-assistant');


  for (const block of contentBlocks) {
    // A text block is one that CARRIES text. Codex calls its blocks `output_text` / `input_text`, so
    // matching on `type === 'text'` rendered a Codex transcript as "No messages found" — while the
    // handoff extractor read those very turns without trouble. One definition of "text", in both places.
    const isTextBlock = block.type !== 'thinking' && typeof block.text === 'string' && block.text.trim();

    if (block.type === 'thinking' && block.thinking) {
      div.appendChild(makeCollapsible('jsonl-thinking', 'Thinking', block.thinking, false));
    } else if (isTextBlock) {
      // Render merged local command as a tool block
      if (block._localCmd) {
        div.appendChild(renderLocalCommand(block._localCmd));
        continue;
      }
      // Render [Image: source: /path] as an inline image if the entire block is just
      // that. The transcript is agent-processed third-party content, so only load a
      // path that looks like a real image file (absolute, image extension, no
      // traversal); anything else falls through to plain text rather than pointing a
      // file:// <img> at an arbitrary local file (issue #77).
      const imgMatch = block.text.trim().match(/^\[Image:\s*source:\s*([^\]]+)\]$/);
      if (imgMatch) {
        const rawPath = imgMatch[1].trim();
        const isSafeImagePath = /\.(png|jpe?g|gif|webp|bmp)$/i.test(rawPath)
          && !rawPath.includes('..')
          && (rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath));
        if (isSafeImagePath) {
          const imgEl = document.createElement('img');
          imgEl.className = 'jsonl-tool-screenshot jsonl-clickable-img';
          imgEl.src = 'file://' + rawPath;
          div.appendChild(imgEl);
          continue;
        }
      }
      const textEl = document.createElement('div');
      textEl.className = 'jsonl-text';
      textEl.innerHTML = renderJsonlText(block.text.trim());
      div.appendChild(textEl);
    } else if (block.type === 'image') {
      const data = block.source?.data || block.data;
      if (data) {
        const mediaType = block.source?.media_type || block.source?.mimeType || block.mimeType || 'image/png';
        const imgEl = document.createElement('img');
        imgEl.className = 'jsonl-tool-screenshot jsonl-clickable-img';
        imgEl.src = `data:${mediaType};base64,${data}`;
        div.appendChild(imgEl);
      }
    } else if (block.type === 'tool_use') {
      const toolEl = renderToolUse(block);
      // Attach matched tool result into the tool block's content area
      if (block.id && toolResultMap && toolResultMap.has(block.id)) {
        const resultData = toolResultMap.get(block.id);
        toolResultMap.delete(block.id); // mark as claimed
        let contentEl = toolEl.querySelector('.jsonl-tool-content');
        if (!contentEl) {
          contentEl = document.createElement('div');
          contentEl.className = 'jsonl-tool-content';
          toolEl.appendChild(contentEl);
        }
        const docCard = renderToolResult(resultData, contentEl, ctx);
        if (docCard) contentEl.parentNode.insertBefore(docCard, contentEl);
      }
      makeToolCollapsible(toolEl, block.id);
      // Where a background agent's "Open" lands (#691, session/conversation-view.js).
      if (block.id) toolEl.dataset.toolUseId = block.id;
      div.appendChild(toolEl);
    } else if (block.type === 'tool_result') {
      // Skip if already claimed by a tool_use above
      if (block.tool_use_id && toolResultMap && !toolResultMap.has(block.tool_use_id)) continue;
      const resultContent = block.content || block.output || '';
      div.appendChild(makeCollapsible('jsonl-tool-result',
        'Tool Result',
        resultContent,
        false));
    }
  }

  // Skip entries with no visible content
  if (!div.children.length) return null;

  return div;
}

// The Open button on a task notice or a subagent's report (#705) in the history viewer: the subagent's row,
// the way a click on that row opens it, or — while the scan has not listed it — the call that started it.
// The conversation view answers the same button for its own log; this is the history viewer's answer.
function openAgentFromHistory(btn) {
  const parent = currentViewerSessionId;
  const id = btn.dataset.subagentId;
  if (typeof sessionMap !== 'undefined') {
    for (const s of sessionMap.values()) {
      if (s && s.parentSessionId === parent && s.agentId === id) { showSubagentTranscript(s); return; }
    }
  }
  const call = btn.dataset.toolUseId
    ? jsonlViewerBody.querySelector(`[data-tool-use-id="${CSS.escape(btn.dataset.toolUseId)}"]`) : null;
  if (!call) return;
  call.scrollIntoView({ block: 'center' });
  call.classList.add('conversation-flash');
  setTimeout(() => call.classList.remove('conversation-flash'), 1200);
}
let historyOpenWired = false;

async function showJsonlViewer(session) {
  // Drain any watches from the previously-rendered viewer first — the new
  // render replaces the DOM and we'd otherwise keep polling files for blocks
  // the user no longer sees.
  drainViewerWatches();
  if (!historyOpenWired) {
    historyOpenWired = true;
    jsonlViewerBody.addEventListener('click', (e) => {
      const btn = e.target.closest('.task-notice-open');
      if (btn && btn.dataset.subagentId) openAgentFromHistory(btn);
    });
  }
  const result = await window.api.readSessionJsonl(session.sessionId);
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  jsonlViewer.style.display = 'flex';

  // Set viewer context for Agent block expansion
  currentViewerSessionId = session.sessionId;
  agentMatchCounters = {};

  const displayName = session.name || session.aiTitle || session.summary || session.sessionId;
  jsonlViewerTitle.textContent = displayName;
  jsonlViewerSessionId.textContent = session.sessionId;
  jsonlViewerBody.innerHTML = '';

  if (result.error) {
    jsonlViewerBody.innerHTML = '<div class="plans-empty">Error loading messages: ' + escapeHtml(result.error) + '</div>';
    return;
  }

  const rawEntries = result.entries || [];

  // Merge consecutive local command entries (caveat + bash-input + stdout/stderr)
  const entries = mergeLocalCommandEntries(rawEntries);

  const toolResultMap = buildToolResultMap(entries);

  let rendered = 0;
  let entryIndex = 0;
  for (const entry of entries) {
    const el = renderJsonlEntry(entry, toolResultMap);
    if (el) {
      // entryIndex = position in the entries array (stable across re-renders) —
      // the anchor bookmarks are keyed on, since deadeye JSONL has no per-message uuid.
      el.dataset.entryIndex = entryIndex;
      jsonlViewerBody.appendChild(el);
      window._decorateJsonlEntry?.(el, entry, session.sessionId, entryIndex);
      rendered++;
    }
    entryIndex++;
  }

  if (rendered === 0) {
    jsonlViewerBody.innerHTML = '<div class="plans-empty">No messages found in this session.</div>';
  } else {
    window._jsonlAfterRender?.(session.sessionId);
  }

  // Click-to-fullscreen for inline images
  jsonlViewerBody.querySelectorAll('.jsonl-clickable-img').forEach(img => {
    img.onclick = () => openImageFullscreen(img.src);
  });

  // Scroll to the bottom so the most recent messages are visible
  jsonlViewerBody.scrollTop = jsonlViewerBody.scrollHeight;

  // Reset the in-viewer search bar for the freshly rendered transcript (#86).
  if (typeof window._jsonlSearchReset === 'function') window._jsonlSearchReset();
}

// --- Subagent transcript view ---
// Renders a read-only transcript for a subagent session.
// Routing decision: the click handler in sidebar.js discriminates on
// session.parentSessionId (present only on subagent rows) and calls this
// function instead of openSession(). Doing the branch at the click-handler
// layer — where we already have the full session object — avoids an extra
// IPC round-trip and keeps the IPC layer ignorant of UI routing concerns.
async function showSubagentTranscript(session) {
  const result = await window.api.readSubagentJsonl(session.parentSessionId, session.agentId);
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  jsonlViewer.style.display = 'flex';

  // Set viewer context for nested Agent block expansion
  currentViewerSessionId = session.sessionId;
  agentMatchCounters = {};

  const displayName = session.description || session.summary || session.aiTitle || session.sessionId;
  const subagentLabel = session.subagentType ? '[' + session.subagentType + '] ' : '[subagent] ';
  jsonlViewerTitle.textContent = subagentLabel + displayName;
  jsonlViewerSessionId.textContent = session.sessionId;
  jsonlViewerBody.innerHTML = '';

  // Escape hatch: let the user resume this session in a terminal tab if needed
  const escapeBanner = document.createElement('div');
  escapeBanner.className = 'jsonl-subagent-escape-banner';
  escapeBanner.innerHTML = '<span class="jsonl-subagent-escape-label">Read-only transcript — subagents cannot be re-entered.</span>';
  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'jsonl-subagent-resume-btn';
  resumeBtn.textContent = 'Resume in terminal anyway';
  resumeBtn.addEventListener('click', () => openSession(session));
  escapeBanner.appendChild(resumeBtn);
  jsonlViewerBody.appendChild(escapeBanner);

  if (result.error) {
    const errEl = document.createElement('div');
    errEl.className = 'plans-empty';
    errEl.textContent = 'Error loading transcript: ' + result.error;
    jsonlViewerBody.appendChild(errEl);
    return;
  }

  const rawEntries = result.entries || [];
  const entries = mergeLocalCommandEntries(rawEntries);

  const toolResultMap = buildToolResultMap(entries);

  let rendered = 0;
  let entryIndex = 0;
  function renderEntries(list, map) {
    for (const entry of list) {
      const el = renderJsonlEntry(entry, map);
      if (el) {
        // Stable anchor for the in-viewer search jump (#86), same as the main viewer.
        el.dataset.entryIndex = entryIndex;
        jsonlViewerBody.appendChild(el);
        rendered++;
      }
      entryIndex++;
    }
  }
  renderEntries(entries, toolResultMap);

  // Follow the file while this view is open (#232). Appended entries land at the bottom; the
  // watch is registered in activeViewerWatches, so leaving the viewer drains it.
  attachSubagentLiveTail({
    container: jsonlViewerBody,
    indicatorHost: escapeBanner,
    parentSessionId: session.parentSessionId,
    agentId: session.agentId,
    entries,
    renderInto: (fresh, map) => {
      const atBottom = jsonlViewerBody.scrollHeight - jsonlViewerBody.scrollTop - jsonlViewerBody.clientHeight < 40;
      // The "no messages" placeholder is a lie the moment something arrives.
      if (rendered === 0) jsonlViewerBody.querySelectorAll('.plans-empty').forEach(el => el.remove());
      renderEntries(fresh, map);
      // Only chase the tail if the user was already at it — otherwise reading scrollback fights back.
      if (atBottom) jsonlViewerBody.scrollTop = jsonlViewerBody.scrollHeight;
    },
  });

  if (rendered === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'plans-empty';
    emptyEl.textContent = 'No messages found in this subagent transcript.';
    jsonlViewerBody.appendChild(emptyEl);
  }

  // Click-to-fullscreen for inline images
  jsonlViewerBody.querySelectorAll('.jsonl-clickable-img').forEach(img => {
    img.onclick = () => openImageFullscreen(img.src);
  });

  jsonlViewerBody.scrollTop = jsonlViewerBody.scrollHeight;

  // Reset the in-viewer search bar for the freshly rendered transcript (#86).
  if (typeof window._jsonlSearchReset === 'function') window._jsonlSearchReset();
}
