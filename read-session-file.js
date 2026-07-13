const path = require('path');
const fs = require('fs');
const { bucketFromIso, bucketKey } = require('./metrics-bucket');
const { sessionProjectPath } = require('./derive-project-path');

// Bump on ANY change to what this parser writes into a session row or its metrics. The scan compares
// this to the version recorded on the cached row (#152) and re-reads the session when they differ —
// which is the only reason a schema change ever reaches an existing user's charts without them being
// told to press Rebuild. Every backend carries one; Claude's lives here, next to the parser it versions.
//   v1: the original per-(date, model) metrics.
//   v2: per-(date, HOUR, model), bucketed in LOCAL time, with the two cost columns (#159).
//   v3: projectPath is decided PER SESSION, from the project root of the cwd it is working in (#157).
//       Without this bump the fix would land in an empty table: a session that moved wrote its last cwd
//       long ago, so its mtime never moves again and the scan would skip it forever.
const PARSER_SCHEMA_VERSION = 3;

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content?.text === 'string') return content.text;
  return '';
}

function countWords(text) {
  const matches = String(text || '').trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function addUsageTotals(totals, usage) {
  if (!usage || typeof usage !== 'object') return;
  totals.inputTokens += Number(usage.input_tokens || usage.inputTokens || 0);
  totals.outputTokens += Number(usage.output_tokens || usage.outputTokens || 0);
  totals.cacheCreationTokens += Number(usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || usage.cacheCreationTokens || 0);
  totals.cacheReadTokens += Number(usage.cache_read_input_tokens || usage.cacheReadInputTokens || usage.cacheReadTokens || 0);
}

/** Subagent transcripts land under <folder>/<parentSessionId>/subagents/agent-<agentId>.jsonl.
 *  We surface them as first-class rows with a synthetic sessionId so they're addressable
 *  exactly like top-level sessions (search, archive, rename, etc).
 */
function subagentSessionId(parentSessionId, agentId) {
  if (parentSessionId.includes(':')) throw new TypeError(`parentSessionId must not contain ':': ${parentSessionId}`);
  if (agentId.includes(':')) throw new TypeError(`agentId must not contain ':': ${agentId}`);
  return `sub:${parentSessionId}:${agentId}`;
}

/** Resolve the absolute jsonl path for a row from session_cache.
 *  Works for both top-level sessions and subagents. */
function resolveJsonlPath(projectsDir, row) {
  if (!row || !row.folder) return null;
  if (row.parentSessionId && row.agentId) {
    return path.join(projectsDir, row.folder, row.parentSessionId, 'subagents', `agent-${row.agentId}.jsonl`);
  }
  return path.join(projectsDir, row.folder, row.sessionId + '.jsonl');
}

/** Read sidecar { agentType, description } if present. */
function readSubagentMeta(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/** A user turn that contains ONLY tool_result blocks isn't a real message —
 *  it's the harness feeding tool output back to the model. Counting these
 *  inflates per-day message counts dramatically (observed 116991 msg/day).
 *  Returns true only when content is a non-empty array whose every item is a
 *  {type:'tool_result'} block. */
function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(c => c && c.type === 'tool_result');
}

/** Pure helper: given an array of raw JSONL lines (strings) and a fallback date
 *  (YYYY-MM-DD, used when a line has no usable timestamp), accumulate per-(date,
 *  model) metrics. Returns an array of:
 *    { date, model, messageCount, toolCallCount, inputTokens, outputTokens,
 *      cacheReadTokens, cacheCreationTokens }
 *  Tokens and tool calls are only attributed to assistant lines; synthetic /
 *  model-less assistant lines bucket under model '' (counted as a message but
 *  with zero tokens). User turns that are purely tool_result aren't counted as
 *  messages. Non-message line types are ignored entirely.
 */
function extractDailyMetrics(lines, fallbackDate) {
  const map = new Map();
  const bucket = (date, hour, model) => {
    const key = bucketKey(date, hour, model);
    let m = map.get(key);
    if (!m) {
      m = {
        date, hour, model,
        messageCount: 0, toolCallCount: 0,
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        // Claude reports no USD at all — not a zero, an absence. NULL keeps it out of the cost chart
        // instead of drawing a free day.
        estimatedCostUsd: null, actualCostUsd: null,
      };
      map.set(key, m);
    }
    return m;
  };

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    // LOCAL date + hour. This used to slice the ISO string, i.e. bucket by the UTC day — which put the
    // same evening's work a column away from Hermes' localtime buckets in a chart that stacks both.
    const { date, hour } = bucketFromIso(entry.timestamp, fallbackDate);

    const isAssistant = entry.type === 'assistant' ||
      (entry.type === 'message' && entry.role === 'assistant');
    const isUser = entry.type === 'user' ||
      (entry.type === 'message' && entry.role === 'user');

    if (isAssistant) {
      let model = entry.message?.model || '';
      if (model === '<synthetic>') model = '';
      const m = bucket(date, hour, model);
      m.messageCount += 1;
      if (model) {
        const usage = entry.message?.usage || {};
        m.inputTokens += usage.input_tokens | 0;
        m.outputTokens += usage.output_tokens | 0;
        m.cacheReadTokens += usage.cache_read_input_tokens | 0;
        m.cacheCreationTokens += usage.cache_creation_input_tokens | 0;
      }
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_use') m.toolCallCount += 1;
        }
      }
    } else if (isUser) {
      if (isToolResultOnly(entry.message?.content)) continue;
      bucket(date, hour, '').messageCount += 1;
    }
  }

  return Array.from(map.values());
}

// ── Shared per-line parse state ──────────────────────────────────────────────
// One mutable accumulator holds everything a single pass over JSONL lines
// derives. readSessionFile() runs it over the whole file in one go; the
// incremental path (readSessionFileIncremental) retains it between calls and
// feeds it only the newly-appended lines.
function createParseState() {
  return {
    summary: '',
    messageCount: 0,
    textContent: '',
    slug: null,
    customTitle: null,
    aiTitle: null,
    userMessageCount: 0,
    largestUserPromptWords: 0,
    startedAt: null,
    lastEntryAt: null,
    usageTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    agentId: null,
    sidechainSeen: false,
    // The last cwd seen — where this session is working NOW, which is not necessarily where it started
    // (#157). Tracked in the parse, so it costs no extra read, and it keeps working on the incremental
    // path: the appended lines are the newest ones.
    lastCwd: null,
  };
}

/** Fold one raw JSONL line into the parse state. Malformed lines are skipped:
 *  a JSONL file being written concurrently by a live Claude CLI session can
 *  have its tail captured mid-write — one truncated line should not invalidate
 *  the whole file. */
function applyEntryLine(st, line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  if (entry.timestamp) {
    const timestamp = new Date(entry.timestamp);
    if (!Number.isNaN(timestamp.getTime())) {
      const iso = timestamp.toISOString();
      if (!st.startedAt || timestamp < new Date(st.startedAt)) st.startedAt = iso;
      if (!st.lastEntryAt || timestamp > new Date(st.lastEntryAt)) st.lastEntryAt = iso;
    }
  }
  if (entry.cwd) st.lastCwd = entry.cwd;
  if (entry.slug && !st.slug) st.slug = entry.slug;
  if (entry.agentId && !st.agentId) st.agentId = entry.agentId;
  if (entry.isSidechain) st.sidechainSeen = true;
  if (entry.type === 'custom-title' && entry.customTitle) {
    st.customTitle = entry.customTitle;
  }
  if (entry.type === 'ai-title' && entry.aiTitle) {
    st.aiTitle = entry.aiTitle;
  }
  addUsageTotals(st.usageTotals, entry.usage);
  addUsageTotals(st.usageTotals, entry.message?.usage);
  if (entry.type === 'user' || entry.type === 'assistant' ||
      (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
    st.messageCount++;
  }
  const msg = entry.message;
  const text = typeof msg === 'string' ? msg : contentToText(msg?.content);
  if (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user')) {
    st.userMessageCount++;
    st.largestUserPromptWords = Math.max(st.largestUserPromptWords, countWords(text));
  }
  if (!st.summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
    // Skip local command messages (! prefix) — use the next real user message
    if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
      // Use scheduled task name if present
      const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
      st.summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
    }
  }
  if (text && st.textContent.length < 8000) {
    st.textContent += text.slice(0, 500) + '\n';
  }
}

/** Assemble the session row from an accumulated parse state + fresh stat.
 *  Returns null when the state doesn't (yet) describe a valid session. */
function buildSessionRow(st, stat, filePath, folder, projectPath, opts, dailyMetrics) {
  const fileBase = path.basename(filePath, '.jsonl');
  const isSubagent = Boolean(opts.parentSessionId);
  if (!st.summary || st.messageCount < 1) return null;

  // Which project this SESSION belongs to — not which project its folder stands for (#157). A session
  // that moved into a git worktree (or into another repo) follows the tree it is working in; one that
  // merely `cd`-ed into a subdirectory does not move at all, because the subdirectory's project root is
  // the same project. The folder keeps its own stable identity either way, so no sibling is dragged
  // along — which is what sank the first attempt at this.
  const rowProjectPath = sessionProjectPath(st.lastCwd, projectPath);
  const activeMinutes = st.startedAt && st.lastEntryAt
    ? Math.max(0, Math.round((new Date(st.lastEntryAt) - new Date(st.startedAt)) / 60000))
    : 0;

  if (isSubagent) {
    // Sidechain marker must be present — otherwise the file lives under a
    // subagents/ directory but isn't actually a subagent transcript. Bail.
    if (!st.sidechainSeen) return null;
    let agentId = st.agentId;
    if (!agentId) {
      // Fall back to filename: agent-<id>.jsonl
      const m = fileBase.match(/^agent-(.+)$/);
      if (m) agentId = m[1];
    }
    if (!agentId) return null;
    const meta = readSubagentMeta(filePath) || {};
    const subagentType = meta.agentType || null;
    const description = meta.description || null;
    return {
      sessionId: subagentSessionId(opts.parentSessionId, agentId),
      folder, projectPath: rowProjectPath,
      summary: description || st.summary,
      firstPrompt: st.summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount: st.messageCount,
      textContent: st.textContent,
      slug: st.slug, customTitle: st.customTitle, aiTitle: st.aiTitle,
      parentSessionId: opts.parentSessionId,
      agentId,
      subagentType,
      description,
      dailyMetrics,
    };
  }

  return {
    sessionId: fileBase, folder, projectPath: rowProjectPath,
    summary: st.summary, firstPrompt: st.summary,
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    messageCount: st.messageCount,
    textContent: st.textContent,
    slug: st.slug, customTitle: st.customTitle, aiTitle: st.aiTitle,
    userMessageCount: st.userMessageCount,
    largestUserPromptWords: st.largestUserPromptWords,
    startedAt: st.startedAt, lastEntryAt: st.lastEntryAt, activeMinutes,
    ...st.usageTotals,
    dailyMetrics,
  };
}

/** Parse a single .jsonl file into a session object (or null if invalid).
 *  opts.parentSessionId — if set, treat as a subagent transcript and stamp the
 *  parent reference into the returned row.
 */
function readSessionFile(filePath, folder, projectPath, opts = {}) {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const st = createParseState();
    for (const line of lines) applyEntryLine(st, line);
    if (!st.summary || st.messageCount < 1) return null;

    const fallbackDate = stat.mtime.toISOString().slice(0, 10);
    const dailyMetrics = extractDailyMetrics(lines, fallbackDate);
    return buildSessionRow(st, stat, filePath, folder, projectPath, opts, dailyMetrics);
  } catch {
    return null;
  }
}

// ── Incremental read (perf #74) ──────────────────────────────────────────────
// Merge a fresh extractDailyMetrics() result into a cumulative per-(date,model)
// map so incremental chunks add onto previously-seen totals.
function mergeDailyMetrics(map, add) {
  for (const m of add) {
    const key = `${m.date}|${m.model}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, m);
      continue;
    }
    cur.messageCount += m.messageCount;
    cur.toolCallCount += m.toolCallCount;
    cur.inputTokens += m.inputTokens;
    cur.outputTokens += m.outputTokens;
    cur.cacheReadTokens += m.cacheReadTokens;
    cur.cacheCreationTokens += m.cacheCreationTokens;
  }
}

// Fingerprint length for rewrite detection: the last N consumed bytes are
// remembered and re-checked before every delta read.
const INCREMENTAL_TAIL_CHECK = 32;

/** Incremental variant of readSessionFile for the watcher hot path. Instead of
 *  re-reading the whole transcript on every append (catastrophic for a live
 *  200+ MB session), it retains the parse state + a byte offset between calls
 *  and only reads the newly-appended bytes. Offsets always land on line
 *  boundaries: a partial trailing line is left unconsumed and re-read on the
 *  next call, so mid-write captures can't corrupt the state.
 *
 *  Rewrite detection: a file that shrank, or whose last consumed bytes no
 *  longer match the remembered fingerprint (in-place rewrite, e.g. a title
 *  edit), is fully re-read. A rewrite that changes neither size direction nor
 *  those tail bytes goes undetected — vanishingly unlikely for JSONL.
 *
 *  `prev` is the opaque `{ offset, tail, state, metrics }` returned as `next`
 *  by an earlier call (or null for the first read → full read). Only
 *  divergence from a fresh full read: timestamp-less lines keep the fallback
 *  date of the chunk that first read them (rare, cosmetic).
 *
 *  Returns { session, next } or null when the file isn't (yet) a valid session.
 */
function readSessionFileIncremental(filePath, folder, projectPath, opts = {}, prev = null) {
  try {
    const stat = fs.statSync(filePath);
    const fallbackDate = stat.mtime.toISOString().slice(0, 10);

    if (prev && prev.offset > 0 && stat.size >= prev.offset) {
      const fd = fs.openSync(filePath, 'r');
      let tailOk = false;
      let buf = null;
      let n = 0;
      try {
        // Verify the remembered fingerprint before trusting the offset.
        const checkLen = Math.min(INCREMENTAL_TAIL_CHECK, prev.offset);
        const check = Buffer.alloc(checkLen);
        const cn = fs.readSync(fd, check, 0, checkLen, prev.offset - checkLen);
        tailOk = cn === checkLen && prev.tail && check.equals(prev.tail);
        if (tailOk && stat.size > prev.offset) {
          buf = Buffer.alloc(stat.size - prev.offset);
          n = fs.readSync(fd, buf, 0, buf.length, prev.offset);
        }
      } finally {
        fs.closeSync(fd);
      }

      if (tailOk) {
        const lastNl = n > 0 ? buf.lastIndexOf(0x0A, n - 1) : -1;
        if (lastNl === -1) {
          // No new bytes, or only a partial line so far — rebuild the row so
          // stat-derived fields stay fresh; the partial line is consumed next time.
          const session = buildSessionRow(prev.state, stat, filePath, folder, projectPath, opts, Array.from(prev.metrics.values()));
          return session ? { session, next: prev } : null;
        }
        const consumed = buf.subarray(0, lastNl + 1);
        const lines = consumed.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) applyEntryLine(prev.state, line);
        mergeDailyMetrics(prev.metrics, extractDailyMetrics(lines, fallbackDate));
        const next = {
          offset: prev.offset + lastNl + 1,
          tail: incrementalTail(prev.tail, consumed),
          state: prev.state,
          metrics: prev.metrics,
        };
        const session = buildSessionRow(next.state, stat, filePath, folder, projectPath, opts, Array.from(next.metrics.values()));
        return session ? { session, next } : null;
      }
      // Fingerprint mismatch: fall through to the full read below.
    }

    // Full (re)read: no prior state, file shrank, or in-place rewrite detected.
    const fbuf = fs.readFileSync(filePath);
    const consumed = fbuf.lastIndexOf(0x0A) + 1; // 0 when no complete line exists yet
    const lines = fbuf.toString('utf8', 0, consumed).split('\n').filter(Boolean);
    const st = createParseState();
    for (const line of lines) applyEntryLine(st, line);
    const metrics = new Map();
    mergeDailyMetrics(metrics, extractDailyMetrics(lines, fallbackDate));
    const session = buildSessionRow(st, stat, filePath, folder, projectPath, opts, Array.from(metrics.values()));
    if (!session) return null;
    const next = {
      offset: consumed,
      tail: incrementalTail(null, fbuf.subarray(0, consumed)),
      state: st,
      metrics,
    };
    return { session, next };
  } catch {
    return null;
  }
}

/** New fingerprint after consuming `chunk`: the last INCREMENTAL_TAIL_CHECK
 *  bytes of prevTail+chunk, copied so no large parent buffer is retained. */
function incrementalTail(prevTail, chunk) {
  if (chunk.length >= INCREMENTAL_TAIL_CHECK || !prevTail) {
    return Buffer.from(chunk.subarray(Math.max(0, chunk.length - INCREMENTAL_TAIL_CHECK)));
  }
  const joined = Buffer.concat([prevTail, chunk]);
  return Buffer.from(joined.subarray(Math.max(0, joined.length - INCREMENTAL_TAIL_CHECK)));
}

/** Enumerate every jsonl in a project folder: top-level sessions plus any
 *  subagent transcripts under <folder>/<parentSessionId>/subagents/*.jsonl
 *  (or directly under <folder>/<parentSessionId>/*.jsonl for legacy layouts).
 *  Returns [{ filePath, sessionId, parentSessionId|null }]. */
function enumerateSessionFiles(folderPath) {
  const out = [];
  let topEntries;
  try {
    topEntries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch { return out; }

  // Top-level .jsonl files = ordinary sessions
  for (const e of topEntries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({
        filePath: path.join(folderPath, e.name),
        sessionId: path.basename(e.name, '.jsonl'),
        parentSessionId: null,
      });
    }
  }

  // UUID subdirs may hold subagent transcripts
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    const parentSessionId = e.name;
    const subDir = path.join(folderPath, parentSessionId);
    // Preferred layout: subagents/ subfolder
    const subagentsDir = path.join(subDir, 'subagents');
    try {
      if (fs.statSync(subagentsDir).isDirectory()) {
        for (const f of fs.readdirSync(subagentsDir)) {
          if (!f.endsWith('.jsonl')) continue;
          out.push({
            filePath: path.join(subagentsDir, f),
            sessionId: path.basename(f, '.jsonl'),
            parentSessionId,
          });
        }
        continue;
      }
    } catch {}
    // Fallback: jsonl directly in the UUID dir (older CLI versions)
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        out.push({
          filePath: path.join(subDir, f),
          sessionId: path.basename(f, '.jsonl'),
          parentSessionId,
        });
      }
    } catch {}
  }

  return out;
}

module.exports = { PARSER_SCHEMA_VERSION, readSessionFile, readSessionFileIncremental, subagentSessionId, resolveJsonlPath, readSubagentMeta, enumerateSessionFiles, extractDailyMetrics, isToolResultOnly };
