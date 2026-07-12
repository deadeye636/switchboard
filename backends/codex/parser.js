// backends/codex/parser.js — parse a Codex "rollout" JSONL into our normalised session row.
//
// Codex writes a two-layer JSONL (research/codex-cli-recon.md §2): every line is
//   { timestamp, type, payload }
// where `type` is one of:
//   session_meta   line 1 only — the header: { id, cwd, timestamp, cli_version, git, base_instructions }
//   turn_context   per turn — carries the per-turn `model` (take the LAST one)
//   response_item  the conversation items; payload.type == 'message' has role + content[].text
//   event_msg      lifecycle/telemetry; payload.type == 'token_count' carries the running usage
//                  (emitted many times — take the LAST total_token_usage), plus task_started/task_complete
//
// Notes that bite:
//   - `base_instructions` is a huge system-prompt blob in the header — never fold it into textContent.
//   - The file is appended LIVE, so the final line can be truncated mid-write: tolerate it and do NOT
//     consume it (the next read re-reads that line once it is complete).
//   - The filename UUID == the session id, but we take the id from session_meta (authoritative).
//
// Incremental-parse contract (invariant §5.10): the state is serializable and the read is re-enterable
// from a saved byte offset + tail fingerprint. PARSER_SCHEMA_VERSION is bumped whenever this parser
// changes, so any persisted cold-start state (T-4.7 / #127) keyed on backendId+version is dropped.
'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Bump on ANY behavioural change to this parser — persisted parse-state keyed on it is then dropped.
const PARSER_SCHEMA_VERSION = 2;   // v2: the parse state carries per-(date, model) metrics (#154)

// Bytes of the already-consumed tail we fingerprint to detect a rewritten/truncated file.
const FINGERPRINT_BYTES = 64;

function createParseState() {
  return {
    sessionId: null,
    cwd: null,
    startedAt: null,
    lastEntryAt: null,
    model: null,
    cliVersion: null,
    gitBranch: null,
    messageCount: 0,
    userMessageCount: 0,
    largestUserPromptWords: 0,
    summary: '',
    fallbackSummary: '',   // first user message, even if it's injected context (better than nothing)
    textParts: [],
    // last token_count wins (Codex re-emits the running total)
    usageTotals: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    reasoningTokens: 0,
    totalTokens: 0,
    contextWindow: 0,
    // rollout tail state for busy/idle (deriveState reads these)
    lastTaskEvent: null, // 'task_started' | 'task_complete' | null

    // Per-(date, model) metrics — what the Stats charts are built from (#154). Codex re-emits RUNNING
    // totals, so a bucket gets the DELTA since the previous token_count, attributed to the day and
    // model that were current when it arrived. Serializable (a plain object), because the incremental
    // parse state is persisted.
    dailyMetrics: {},                                   // "date|model" -> bucket
    lastCumulative: { input: 0, output: 0, cacheRead: 0 },
    lastDate: null,                                     // YYYY-MM-DD of the last entry seen
  };
}

function dayOf(timestamp) {
  if (typeof timestamp !== 'string' || timestamp.length < 10) return null;
  return timestamp.slice(0, 10);
}

function metricBucket(st, date, model) {
  const key = `${date}|${model || ''}`;
  let b = st.dailyMetrics[key];
  if (!b) {
    b = {
      date, model: model || '',
      messageCount: 0, toolCallCount: 0,
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    };
    st.dailyMetrics[key] = b;
  }
  return b;
}

function countWords(text) {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

// Pull the plain text out of a response_item message payload: content[] entries with a .text.
// Codex's FIRST "user" message is usually not the user's prompt at all: it's injected context —
// the project's AGENTS.md, an <INSTRUCTIONS>/<environment_context> block. Taking it as the session
// title puts "# AGENTS.md instructions for D:\..." in the sidebar for every Codex session. Skip
// those and use the first REAL prompt; if a session only ever has injected turns, fall back to it
// rather than showing nothing.
function looksLikeInjectedContext(text) {
  const head = text.slice(0, 300);
  if (/<\/?(INSTRUCTIONS|user_instructions|environment_context|system_context)>/i.test(head)) return true;
  if (/^\s*#.*\b(AGENTS\.md|instructions)\b/i.test(head)) return true;
  return false;
}

function messageText(payload) {
  const content = payload && payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (c && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join(' ');
}

/** Fold one parsed rollout line into the state. Unknown types are ignored. */
function applyEntry(st, entry) {
  if (!entry || typeof entry !== 'object') return;
  const { type, payload, timestamp } = entry;
  if (typeof timestamp === 'string' && timestamp) {
    if (!st.startedAt) st.startedAt = timestamp;
    st.lastEntryAt = timestamp;
    const d = dayOf(timestamp);
    if (d) st.lastDate = d;
  }
  if (!payload || typeof payload !== 'object') return;

  switch (type) {
    case 'session_meta': {
      // Authoritative identity. NOTE: skip payload.base_instructions (huge system prompt).
      st.sessionId = payload.id || payload.session_id || st.sessionId;
      if (typeof payload.cwd === 'string') st.cwd = payload.cwd;
      if (typeof payload.timestamp === 'string') st.startedAt = payload.timestamp;
      if (typeof payload.cli_version === 'string') st.cliVersion = payload.cli_version;
      if (payload.git && typeof payload.git.branch === 'string') st.gitBranch = payload.git.branch;
      break;
    }
    case 'turn_context': {
      // Per-turn config snapshot — the LAST one wins (the session's effective model).
      if (typeof payload.model === 'string' && payload.model) st.model = payload.model;
      break;
    }
    case 'response_item': {
      if (payload.type !== 'message') break;
      const text = messageText(payload);
      st.messageCount++;
      const injected = payload.role === 'user' && looksLikeInjectedContext(text);
      if (payload.role === 'user') {
        st.userMessageCount++;
        const words = countWords(text);
        if (words > st.largestUserPromptWords) st.largestUserPromptWords = words;
        // The session title = the first REAL user prompt, not Codex's injected AGENTS.md context.
        if (text) {
          if (!st.fallbackSummary) st.fallbackSummary = text.slice(0, 500);
          if (!st.summary && !injected) st.summary = text.slice(0, 500);
        }
      }
      // Keep the injected context OUT of the search body too: it is the same AGENTS.md text in every
      // Codex session of a project, so indexing it makes any term from that file match all of them.
      if (text && !injected) st.textParts.push(text);
      if (st.lastDate) metricBucket(st, st.lastDate, st.model).messageCount++;
      break;
    }
    case 'event_msg': {
      if (payload.type === 'token_count') {
        const info = payload.info || {};
        const t = info.total_token_usage;
        if (t && typeof t === 'object') {
          // Codex re-emits the RUNNING total, so assign (don't accumulate) — last wins.
          st.usageTotals.inputTokens = Number(t.input_tokens || 0);
          st.usageTotals.outputTokens = Number(t.output_tokens || 0);
          // Codex's "cached_input_tokens" is a cache READ (no cache-creation concept).
          st.usageTotals.cacheReadTokens = Number(t.cached_input_tokens || 0);
          st.reasoningTokens = Number(t.reasoning_output_tokens || 0);
          st.totalTokens = Number(t.total_tokens || 0);

          // The per-day bucket needs what was spent SINCE the last report, not the running total —
          // otherwise a session spanning midnight would book its whole history onto its last day.
          if (st.lastDate) {
            const b = metricBucket(st, st.lastDate, st.model);
            b.inputTokens += Math.max(0, st.usageTotals.inputTokens - st.lastCumulative.input);
            b.outputTokens += Math.max(0, st.usageTotals.outputTokens - st.lastCumulative.output);
            b.cacheReadTokens += Math.max(0, st.usageTotals.cacheReadTokens - st.lastCumulative.cacheRead);
          }
          st.lastCumulative = {
            input: st.usageTotals.inputTokens,
            output: st.usageTotals.outputTokens,
            cacheRead: st.usageTotals.cacheReadTokens,
          };
        }
        if (typeof info.model_context_window === 'number') st.contextWindow = info.model_context_window;
      } else if (payload.type === 'task_started' || payload.type === 'task_complete') {
        // Busy/idle signal for deriveState (rollout tail).
        st.lastTaskEvent = payload.type;
      }
      break;
    }
    default:
      break;
  }
}

/** Fold a raw line. A malformed line (truncated live write) is skipped, not fatal. */
function applyLine(st, line) {
  const s = line.trim();
  if (!s) return;
  let entry;
  try { entry = JSON.parse(s); } catch { return; }
  applyEntry(st, entry);
}

function fingerprintAt(fd, offset) {
  if (offset <= 0) return '';
  const len = Math.min(FINGERPRINT_BYTES, offset);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, offset - len);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * Read a rollout file from `startOffset`, folding complete lines into `st`.
 * Returns the offset AFTER the last COMPLETE line — a truncated tail line is left unconsumed so the
 * next read picks it up whole.
 */
function readFrom(filePath, st, startOffset) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (startOffset >= size) return { offset: startOffset, fingerprint: fingerprintAt(fd, startOffset), size };
    const len = size - startOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, startOffset);
    const chunk = buf.toString('utf8');

    // Only consume up to the last newline; anything after it is an incomplete line.
    const lastNl = chunk.lastIndexOf('\n');
    const consumable = lastNl >= 0 ? chunk.slice(0, lastNl + 1) : '';
    const consumedBytes = Buffer.byteLength(consumable, 'utf8');

    for (const line of consumable.split('\n')) applyLine(st, line);

    const offset = startOffset + consumedBytes;
    return { offset, fingerprint: fingerprintAt(fd, offset), size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Build the normalised row session-cache consumes (same shape as read-session-file's). */
function buildRow(st, filePath, opts = {}) {
  if (!st.sessionId || st.messageCount < 1) return null;
  const summary = st.summary || st.fallbackSummary || '';
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const activeMinutes = st.startedAt && st.lastEntryAt
    ? Math.max(0, Math.round((new Date(st.lastEntryAt) - new Date(st.startedAt)) / 60000))
    : 0;
  return {
    sessionId: st.sessionId,
    backendId: 'codex',
    cwd: st.cwd,                       // the scanner buckets by this via the central derive-project-path
    folder: opts.folder != null ? opts.folder : null,
    projectPath: opts.projectPath != null ? opts.projectPath : null,
    summary,
    firstPrompt: summary,
    created: st.startedAt || stat.birthtime.toISOString(),
    modified: st.lastEntryAt || stat.mtime.toISOString(),
    messageCount: st.messageCount,
    userMessageCount: st.userMessageCount,
    largestUserPromptWords: st.largestUserPromptWords,
    textContent: st.textParts.join('\n'),   // FTS5 body
    slug: null, customTitle: null, aiTitle: null,
    startedAt: st.startedAt,
    lastEntryAt: st.lastEntryAt,
    activeMinutes,
    model: st.model,
    ...st.usageTotals,
    reasoningTokens: st.reasoningTokens,
    totalTokens: st.totalTokens,
    contextWindow: st.contextWindow,
    // Feeds session_metrics -> the Stats heatmap / daily bars / per-model tokens (#154).
    dailyMetrics: Object.values(st.dailyMetrics),
  };
}

/** Full parse of a {kind:'file'} handle -> normalised row (or null). */
function parseSession(handle, opts = {}) {
  if (!handle || handle.kind !== 'file' || !handle.path) return null;
  const st = createParseState();
  try { readFrom(handle.path, st, 0); } catch { return null; }
  return buildRow(st, handle.path, opts);
}

/**
 * Incremental re-entry (§5.10). `prev` = { offset, fingerprint, state, version } from a previous call.
 * A version/fingerprint mismatch, or a file that SHRANK, forces a full re-read (a wrong cached row is
 * worse than a slow scan). Returns { row, parseState } where parseState is serializable.
 */
function parseSessionIncremental(handle, opts = {}, prev = null) {
  if (!handle || handle.kind !== 'file' || !handle.path) return { row: null, parseState: null };
  const filePath = handle.path;

  let st;
  let startOffset = 0;
  const canResume = prev
    && prev.version === PARSER_SCHEMA_VERSION
    && prev.state
    && typeof prev.offset === 'number'
    && prev.offset > 0;

  if (canResume) {
    let ok = false;
    try {
      const size = fs.statSync(filePath).size;
      if (size >= prev.offset) {
        const fd = fs.openSync(filePath, 'r');
        try { ok = fingerprintAt(fd, prev.offset) === prev.fingerprint; } finally { fs.closeSync(fd); }
      }
      // size < prev.offset -> the file shrank/was rewritten -> full re-read
    } catch { ok = false; }
    if (ok) {
      st = { ...prev.state };
      st.usageTotals = { ...prev.state.usageTotals };
      st.textParts = prev.state.textParts.slice();
      startOffset = prev.offset;
    }
  }
  if (!st) { st = createParseState(); startOffset = 0; }

  let res;
  try { res = readFrom(filePath, st, startOffset); } catch { return { row: null, parseState: null }; }

  return {
    row: buildRow(st, filePath, opts),
    parseState: { version: PARSER_SCHEMA_VERSION, offset: res.offset, fingerprint: res.fingerprint, state: st },
  };
}

module.exports = {
  PARSER_SCHEMA_VERSION,
  parseSession,
  parseSessionIncremental,
  createParseState,
  applyLine,
  buildRow,
};
