// backends/pi/parser.js — Pi's JSONL transcript -> the normalised row session-cache consumes.
//
// Format (observed on a real install, docs/plans/multi_llm/research/pi-format.md):
//   line 1  {"type":"session","version":3,"id":…,"timestamp":…,"cwd":"Z:\\temp"}      <- authoritative
//   then    {"type":"model_change","provider":"anthropic","modelId":"claude-opus-4-7"}
//           {"type":"thinking_level_change",…}
//           {"type":"message","message":{role,content[],usage{…,cost{…,total}},model,provider,…}}
//
// Two things that differ from every other backend here:
//   1. the turn payload is nested one level down, under `.message` — not on the entry itself;
//   2. Pi is MULTI-PROVIDER within one session (it switched anthropic -> openai-codex mid-session in
//      the recon), so "the model" is the last one seen, and the totals span providers.
//
// Cost: `usage.cost` is an OBJECT (per-bucket breakdown + `.total`), not a number — the plan said
// otherwise. Summed across assistant messages it is Pi's own ESTIMATE, so it goes to estimatedCostUsd
// and never to actualCostUsd (D13/D16: a figure is settled only when the backend says it is, and Pi
// never says so).
//
// Same incremental-parse contract as the Codex parser (§5.10): resume from a byte offset + a tail
// fingerprint, with a schema version so any persisted state is dropped when this file changes.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { bucketFromIso, bucketKey } = require('../metrics-bucket');

//   v2: the parse state carries per-(date, model) metrics (#154)
//   v3: per-(date, HOUR, model), bucketed in LOCAL time, with cost booked on the turn that spent it (#159)
// 4 (#193): the session header's `parentSession` is read now. Existing rows were parsed without it and
// carry no lineage; bumping is what makes them re-read themselves — a parser change moves no mtime.
// 5 (#407): Pi's id/parentId tree and session_info entries decide the visible branch/title.
const PARSER_SCHEMA_VERSION = 5;

const FINGERPRINT_BYTES = 64;

function createParseState() {
  return {
    sessionId: null,
    cwd: null,
    // A fork's parent, as Pi writes it: the FULL PATH of the parent transcript (#193). Only a forked
    // session has it — which is exactly why it was missed until a real `pi --fork` session was read.
    parentSessionPath: null,
    startedAt: null,
    lastEntryAt: null,
    model: null,
    provider: null,
    messageCount: 0,
    userMessageCount: 0,
    largestUserPromptWords: 0,
    summary: '',
    textParts: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    hasCost: false,
    // Busy/idle input (state.js): the last assistant turn's stopReason. Pi emits no OSC and its
    // lifecycle events live only in --mode json, which excludes the TUI (T-6.3).
    lastStopReason: null,
    // Raw entries after the session header. Pi JSONL is a TREE, not an append-only linear chat: the last
    // appended entry is the current leaf, and the visible conversation is the parent walk back to root.
    // Keep the parsed entries so buildRow can reconstruct that active branch (and incremental parsing can
    // append to it) without teaching the core any Pi format.
    entries: [],
    sessionName: null,

    // Per-(date, hour, model) metrics -> session_metrics -> the Stats charts (#154, #159). Pi reports
    // usage AND cost per ASSISTANT MESSAGE, with a timestamp on the entry, so its buckets are exact —
    // tokens and money both land in the bucket they were actually spent in. Hermes cannot do this.
    // A plain object, because the incremental parse state is serialized.
    dailyMetrics: {},
  };
}

/** The bucket an entry belongs in. Pi puts the timestamp on the entry; older lines had it on the message. */
function entryBucket(entry, m) {
  const at = bucketFromIso(entry && entry.timestamp, null);
  if (at.date) return at;
  return bucketFromIso(m && m.timestamp, null);
}

function metricBucket(st, at, model) {
  const key = bucketKey(at.date, at.hour, model);
  let b = st.dailyMetrics[key];
  if (!b) {
    b = {
      date: at.date, hour: at.hour, model: model || '',
      messageCount: 0, toolCallCount: 0,
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      // Pi prices its own turns, so it DOES report money — but from its own price table, so it is an
      // estimate and never a settled amount. It stays NULL until a turn actually reports one: a session
      // whose turns all failed has no cost, which is not the same as costing nothing.
      estimatedCostUsd: null, actualCostUsd: null,
    };
    st.dailyMetrics[key] = b;
  }
  return b;
}

function countWords(text) {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

/** Pi's content is an array of parts ({type:'text',text}); a failed turn has an empty one. */
function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (c && typeof c.text === 'string') parts.push(c.text);
    else if (c && c.type === 'thinking' && typeof c.thinking === 'string') parts.push(c.thinking);
    else if (c && c.type === 'toolCall') parts.push([c.name, JSON.stringify(c.arguments || {})].filter(Boolean).join(' '));
  }
  return parts.join(' ');
}

function usageCost(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const cost = usage.cost;
  const total = (cost && typeof cost === 'object') ? Number(cost.total || 0)
    : (typeof cost === 'number' ? cost : 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function applyUsageTotals(st, usage, bucket) {
  if (!usage || typeof usage !== 'object') return;
  st.inputTokens += Number(usage.input || 0);
  st.outputTokens += Number(usage.output || 0);
  st.cacheReadTokens += Number(usage.cacheRead || 0);
  st.cacheCreationTokens += Number(usage.cacheWrite || 0);
  st.reasoningTokens += Number(usage.reasoning || 0);
  st.totalTokens += Number(usage.totalTokens || 0);
  if (bucket) {
    bucket.inputTokens += Number(usage.input || 0);
    bucket.outputTokens += Number(usage.output || 0);
    bucket.cacheReadTokens += Number(usage.cacheRead || 0);
    bucket.cacheCreationTokens += Number(usage.cacheWrite || 0);
  }
  const total = usageCost(usage);
  if (total > 0) {
    st.estimatedCostUsd += total;
    st.hasCost = true;
    if (bucket) bucket.estimatedCostUsd = (bucket.estimatedCostUsd || 0) + total;
  }
}

function activeEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const byId = new Map();
  let leaf = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.id) continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
  if (!leaf) return entries.slice();   // legacy v1-ish fixtures: linear entries without tree ids
  const out = [];
  const seen = new Set();
  for (let cur = leaf; cur && cur.id && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : null) {
    seen.add(cur.id);
    out.push(cur);
  }
  return out.reverse();
}

function applyEntry(st, entry) {
  if (!entry || typeof entry !== 'object') return;
  const { type } = entry;
  if (type !== 'session') st.entries.push(entry);
  if (typeof entry.timestamp === 'string' && entry.timestamp) {
    if (!st.startedAt) st.startedAt = entry.timestamp;
    st.lastEntryAt = entry.timestamp;
  }

  switch (type) {
    case 'session': {
      // The header. Identity and cwd come from HERE, never from the (cwd-encoded) folder name.
      if (typeof entry.id === 'string') st.sessionId = entry.id;
      if (typeof entry.cwd === 'string') st.cwd = entry.cwd;
      if (typeof entry.timestamp === 'string') st.startedAt = entry.timestamp;
      if (typeof entry.parentSession === 'string' && entry.parentSession) st.parentSessionPath = entry.parentSession;
      break;
    }
    case 'model_change': {
      // Last one wins — a session can switch model (and provider) mid-flight.
      if (typeof entry.modelId === 'string' && entry.modelId) st.model = entry.modelId;
      if (typeof entry.provider === 'string' && entry.provider) st.provider = entry.provider;
      break;
    }
    case 'session_info': {
      st.sessionName = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null;
      break;
    }
    case 'message': {
      const m = entry.message;
      if (!m || typeof m !== 'object') break;
      const text = messageText(m);

      const at = entryBucket(entry, m);

      if (m.role === 'user') {
        st.messageCount++;
        st.userMessageCount++;
        const words = countWords(text);
        if (words > st.largestUserPromptWords) st.largestUserPromptWords = words;
        if (!st.summary && text.trim()) st.summary = text.trim().slice(0, 200);
        if (text) st.textParts.push(text);
        // A user turn is a message, but carries no tokens and no model of its own.
        if (at.date) metricBucket(st, at, st.model).messageCount++;
        break;
      }

      if (m.role !== 'assistant') break;
      st.messageCount++;
      if (text) st.textParts.push(text);
      if (typeof m.model === 'string' && m.model) st.model = m.model;
      if (typeof m.provider === 'string' && m.provider) st.provider = m.provider;
      st.lastStopReason = typeof m.stopReason === 'string' ? m.stopReason : null;

      // The bucket is keyed on the model of THIS turn — Pi switches provider mid-session, so booking a
      // turn under the session's final model would credit one provider with another's tokens.
      const bucket = at.date ? metricBucket(st, at, m.model || st.model) : null;
      if (bucket) bucket.messageCount++;

      const u = m.usage;
      if (u && typeof u === 'object') {
        st.inputTokens += Number(u.input || 0);
        st.outputTokens += Number(u.output || 0);
        st.cacheReadTokens += Number(u.cacheRead || 0);
        st.cacheCreationTokens += Number(u.cacheWrite || 0);
        st.reasoningTokens += Number(u.reasoning || 0);
        st.totalTokens += Number(u.totalTokens || 0);
        if (bucket) {
          bucket.inputTokens += Number(u.input || 0);
          bucket.outputTokens += Number(u.output || 0);
          bucket.cacheReadTokens += Number(u.cacheRead || 0);
          bucket.cacheCreationTokens += Number(u.cacheWrite || 0);
        }
        // `cost` is an object with a `.total`; a number would be the plan's (wrong) shape — accept both
        // rather than silently reporting nothing if Pi ever changes it.
        const cost = u.cost;
        const total = (cost && typeof cost === 'object') ? Number(cost.total || 0)
          : (typeof cost === 'number' ? cost : 0);
        if (Number.isFinite(total) && total > 0) {
          st.estimatedCostUsd += total;
          st.hasCost = true;
          // Pi is the one backend that can place money EXACTLY: it prices each turn, and the turn has a
          // timestamp. So the cost lands in the bucket it was spent in — no booking a whole session onto
          // the day it happened to end.
          if (bucket) bucket.estimatedCostUsd = (bucket.estimatedCostUsd || 0) + total;
        }
      }
      break;
    }
    default:
      break;
  }
}

function applyLine(st, line) {
  const s = line.trim();
  if (!s) return;
  let entry;
  try { entry = JSON.parse(s); } catch { return; }   // a half-written live line is skipped, not fatal
  applyEntry(st, entry);
}

function fingerprintAt(fd, offset) {
  if (offset <= 0) return '';
  const len = Math.min(FINGERPRINT_BYTES, offset);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, offset - len);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Read from `startOffset`, folding COMPLETE lines only (a truncated tail stays unconsumed). */
function readFrom(filePath, st, startOffset) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (startOffset >= size) return { offset: startOffset, fingerprint: fingerprintAt(fd, startOffset), size };
    const len = size - startOffset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, startOffset);
    const chunk = buf.toString('utf8');

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

function visibleState(st) {
  const out = createParseState();
  out.sessionId = st.sessionId;
  out.cwd = st.cwd;
  out.parentSessionPath = st.parentSessionPath;
  out.startedAt = st.startedAt;
  out.lastEntryAt = st.lastEntryAt;
  const pathEntries = activeEntries(st.entries);

  for (const entry of pathEntries) {
    if (typeof entry.timestamp === 'string' && entry.timestamp) out.lastEntryAt = entry.timestamp;
    if (entry.type === 'model_change') {
      if (typeof entry.modelId === 'string' && entry.modelId) out.model = entry.modelId;
      if (typeof entry.provider === 'string' && entry.provider) out.provider = entry.provider;
      continue;
    }
    if (entry.type === 'session_info') {
      out.sessionName = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null;
      continue;
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      const text = entry.summary || '';
      if (text) out.textParts.push(text);
      const at = bucketFromIso(entry.timestamp, null);
      const bucket = at.date ? metricBucket(out, at, out.model) : null;
      applyUsageTotals(out, entry.usage, bucket);
      if (Array.isArray(entry.retainedTail)) {
        for (const m of entry.retainedTail) applyMessageToVisible(out, { type: 'message', timestamp: entry.timestamp, message: m });
      }
      continue;
    }
    if (entry.type === 'custom_message') {
      const text = messageText({ content: entry.content });
      if (text) out.textParts.push(text);
      continue;
    }
    if (entry.type === 'message') applyMessageToVisible(out, entry);
  }
  return out;
}

function applyMessageToVisible(st, entry) {
  const m = entry && entry.message;
  if (!m || typeof m !== 'object') return;
  const text = messageText(m);
  const at = entryBucket(entry, m);

  if (m.role === 'user') {
    st.messageCount++;
    st.userMessageCount++;
    const words = countWords(text);
    if (words > st.largestUserPromptWords) st.largestUserPromptWords = words;
    if (!st.summary && text.trim()) st.summary = text.trim().slice(0, 200);
    if (text) st.textParts.push(text);
    if (at.date) metricBucket(st, at, st.model).messageCount++;
    st.lastRole = 'user';
    return;
  }

  if (m.role === 'assistant') {
    st.messageCount++;
    if (text) st.textParts.push(text);
    if (typeof m.model === 'string' && m.model) st.model = m.model;
    if (typeof m.provider === 'string' && m.provider) st.provider = m.provider;
    st.lastStopReason = typeof m.stopReason === 'string' ? m.stopReason : null;
    const bucket = at.date ? metricBucket(st, at, m.model || st.model) : null;
    if (bucket) bucket.messageCount++;
    applyUsageTotals(st, m.usage, bucket);
    st.lastRole = 'assistant';
    return;
  }

  if (m.role === 'toolResult' || m.role === 'bashExecution' || m.role === 'custom' || m.role === 'branchSummary' || m.role === 'compactionSummary') {
    if (text) st.textParts.push(text);
    const bucket = at.date ? metricBucket(st, at, st.model) : null;
    applyUsageTotals(st, m.usage, bucket);
    st.lastRole = m.role;
  }
}

function buildRow(st, filePath, opts = {}) {
  if (!st.sessionId) return null;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const visible = visibleState(st);
  const activeMinutes = visible.startedAt && visible.lastEntryAt
    ? Math.max(0, Math.round((new Date(visible.lastEntryAt) - new Date(visible.startedAt)) / 60000))
    : 0;

  return {
    sessionId: visible.sessionId,
    backendId: 'pi',
    cwd: visible.cwd,                        // header value -> central project grouping (§5.9)
    // The parent transcript's PATH, untouched — turning it into a session id is the descriptor's job
    // (resolveLineage), because the id-in-the-filename convention is Pi's, not the core's (#193).
    lineageParentRef: visible.parentSessionPath,
    folder: opts.folder != null ? opts.folder : null,
    projectPath: opts.projectPath != null ? opts.projectPath : null,
    summary: visible.summary,
    firstPrompt: visible.summary,
    created: visible.startedAt || stat.birthtime.toISOString(),
    modified: visible.lastEntryAt || stat.mtime.toISOString(),
    messageCount: visible.messageCount,
    userMessageCount: visible.userMessageCount,
    largestUserPromptWords: visible.largestUserPromptWords,
    textContent: visible.textParts.join('\n'),   // FTS5 body
    slug: null, customTitle: visible.sessionName || null, aiTitle: null,
    startedAt: visible.startedAt,
    lastEntryAt: visible.lastEntryAt,
    activeMinutes,
    model: visible.model,
    inputTokens: visible.inputTokens,
    outputTokens: visible.outputTokens,
    cacheReadTokens: visible.cacheReadTokens,
    cacheCreationTokens: visible.cacheCreationTokens,
    reasoningTokens: visible.reasoningTokens,
    totalTokens: visible.totalTokens,
    // Pi PRICES its own turns, so it reports a cost like Hermes — but it is an estimate from Pi's price
    // table, never a settled amount. A session whose turns all failed has no cost at all (not a zero).
    estimatedCostUsd: visible.hasCost ? visible.estimatedCostUsd : null,
    actualCostUsd: null,
    costStatus: visible.hasCost ? 'estimated' : null,
    // Busy/idle input for state.js.
    lastStopReason: visible.lastStopReason,
    // Feeds session_metrics -> the Stats heatmap / daily bars / per-model tokens (#154).
    dailyMetrics: Object.values(visible.dailyMetrics),
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
 * Incremental parse (§5.10). `prev` = { version, offset, fingerprint, state } from a previous run.
 * The fingerprint guards against a rewritten/truncated file; a mismatch (or a version bump) falls back
 * to a full re-read.
 */
function parseSessionIncremental(handle, opts = {}, prev = null) {
  if (!handle || handle.kind !== 'file' || !handle.path) return { row: null, parseState: null };

  const usable = prev
    && prev.version === PARSER_SCHEMA_VERSION
    && prev.state
    && typeof prev.offset === 'number'
    && prev.offset > 0;

  let st;
  let start = 0;
  if (usable) {
    let fd;
    try { fd = fs.openSync(handle.path, 'r'); } catch { return { row: null, parseState: null }; }
    let ok = false;
    try {
      const size = fs.fstatSync(fd).size;
      ok = size >= prev.offset && fingerprintAt(fd, prev.offset) === prev.fingerprint;
    } catch { ok = false; } finally { fs.closeSync(fd); }
    if (ok) {
      st = { ...createParseState(), ...prev.state };
      st.textParts = Array.isArray(prev.state.textParts) ? prev.state.textParts.slice() : [];
      st.entries = Array.isArray(prev.state.entries) ? prev.state.entries.slice() : [];
      start = prev.offset;
    }
  }
  if (!st) st = createParseState();

  let res;
  try { res = readFrom(handle.path, st, start); } catch { return { row: null, parseState: null }; }

  return {
    row: buildRow(st, handle.path, opts),
    parseState: {
      version: PARSER_SCHEMA_VERSION,
      offset: res.offset,
      fingerprint: res.fingerprint,
      state: st,
    },
  };
}

module.exports = {
  PARSER_SCHEMA_VERSION,
  parseSession,
  parseSessionIncremental,
  createParseState,
  applyEntry,
};
