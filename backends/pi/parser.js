// backends/pi/parser.js — Pi's JSONL transcript -> the normalised row session-cache consumes.
//
// Format (observed on a real install, docs/plans/research/pi-format.md):
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
const { bucketFromIso, bucketKey } = require('../../metrics-bucket');

//   v2: the parse state carries per-(date, model) metrics (#154)
//   v3: per-(date, HOUR, model), bucketed in LOCAL time, with cost booked on the turn that spent it (#159)
const PARSER_SCHEMA_VERSION = 3;

const FINGERPRINT_BYTES = 64;

function createParseState() {
  return {
    sessionId: null,
    cwd: null,
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
  }
  return parts.join(' ');
}

function applyEntry(st, entry) {
  if (!entry || typeof entry !== 'object') return;
  const { type } = entry;
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
      break;
    }
    case 'model_change': {
      // Last one wins — a session can switch model (and provider) mid-flight.
      if (typeof entry.modelId === 'string' && entry.modelId) st.model = entry.modelId;
      if (typeof entry.provider === 'string' && entry.provider) st.provider = entry.provider;
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

function buildRow(st, filePath, opts = {}) {
  if (!st.sessionId) return null;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const activeMinutes = st.startedAt && st.lastEntryAt
    ? Math.max(0, Math.round((new Date(st.lastEntryAt) - new Date(st.startedAt)) / 60000))
    : 0;

  return {
    sessionId: st.sessionId,
    backendId: 'pi',
    cwd: st.cwd,                        // header value -> central project grouping (§5.9)
    folder: opts.folder != null ? opts.folder : null,
    projectPath: opts.projectPath != null ? opts.projectPath : null,
    summary: st.summary,
    firstPrompt: st.summary,
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
    inputTokens: st.inputTokens,
    outputTokens: st.outputTokens,
    cacheReadTokens: st.cacheReadTokens,
    cacheCreationTokens: st.cacheCreationTokens,
    reasoningTokens: st.reasoningTokens,
    totalTokens: st.totalTokens,
    // Pi PRICES its own turns, so it reports a cost like Hermes — but it is an estimate from Pi's price
    // table, never a settled amount. A session whose turns all failed has no cost at all (not a zero).
    estimatedCostUsd: st.hasCost ? st.estimatedCostUsd : null,
    actualCostUsd: null,
    costStatus: st.hasCost ? 'estimated' : null,
    // Busy/idle input for state.js.
    lastStopReason: st.lastStopReason,
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
