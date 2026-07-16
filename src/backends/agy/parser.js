// backends/agy/parser.js — read one Antigravity CLI conversation `.db` into our normalised session row.
//
// Format (reconned from a real install, v1.1.1 — docs/backend-formats.md "agy"): one SQLite DB per
// conversation, `<conversation-id>.db`. The content is PROTOBUF blobs, not text, in a `steps` table
// (agy calls a conversation a *trajectory*). There is no schema shipped, so we do NOT decode the full
// protobuf — we read what we need by extracting the embedded strings from the blobs:
//
//   - cwd     — `trajectory_metadata_blob.data` begins with the workspace as a `file://` URI
//               (`file:///C:/proj` -> `C:\proj`). Authoritative; never trust `last_conversations.json`.
//   - roles   — `steps.step_type` 14 = a user prompt, 15 = a model message, 9 = a tool call/result,
//               23/98 = lifecycle/title steps. Turn/message count is the 14/15 rows.
//   - title   — agy generates one ("Fix the build"); it lands in a step_type 23 blob.
//               Fall back to the first user prompt (step 14) when absent.
//   - model   — a display string in the blobs (`Gemini 3.5 Flash (Medium)`, matching what `agy models`
//               lists), also id forms (`gemini-3.5-flash-low`); the LAST one used wins. Best-effort —
//               a miss is "unknown", never an error.
//
// No timestamp lives in the DB blobs (scanned — none in the 2026 epoch-ms range), so the change marker
// is the `.db` file mtime, and identity is the filename: `sessionId` = the basename, no header parse.
//
// SQLite is read with the shared dual driver (better-sqlite3 in Electron, node:sqlite under
// `node --test`), read-only / query_only / short-lived — the same rules Hermes reads under.
'use strict';

const fs = require('fs');
const path = require('path');
const { driver } = require('../sqlite-driver');

// Bump on ANY behavioural change here — persisted parse-state keyed on it is dropped (§5.10) and every
// agy session already in the cache re-reads itself, so a change reaches the UI without a manual Rebuild.
//   v1: first real parser (cwd, title, model, message/user counts)
const PARSER_SCHEMA_VERSION = 1;

// A conversation is a handful of turns; the blobs we care about hold SHORT strings (a cwd URI, a title,
// a prompt, a model name), so a single-byte protobuf length prefix (<= 127 bytes) recovers them exactly.
const MAX_PROTO_STRING = 127;

/** Open a short-lived READ-ONLY connection. null when the file is gone or momentarily unreadable —
 *  a reader must never throw a scan down, and never block agy writing. */
function openDb(dbPath) {
  const d = driver();
  if (!d) return null;
  try {
    return d.open(dbPath);
  } catch {
    return null;                     // locked/corrupt -> degrade quietly
  }
}

function asBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}

/**
 * Length-delimited protobuf strings: for each position, if a single length byte is followed by exactly
 * that many printable-ASCII bytes, that run is one string. This recovers a proto string at its EXACT
 * length (a raw printable-run scan would swallow the next field's tag byte into the value — e.g. a title
 * would come back as "Fix the buildH").
 */
function protoStrings(buf, minLen = 3) {
  const out = [];
  if (!buf) return out;
  const n = buf.length;
  let i = 0;
  while (i + 1 < n) {
    const len = buf[i];
    if (len >= minLen && len <= MAX_PROTO_STRING && i + 1 + len <= n) {
      let printable = true;
      for (let j = i + 1; j <= i + len; j++) {
        const c = buf[j];
        if (c < 0x20 || c > 0x7e) { printable = false; break; }
      }
      if (printable) {
        out.push(buf.toString('latin1', i + 1, i + 1 + len));
        i = i + 1 + len;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Every printable-ASCII run of at least `minLen` — used for model hunting, where we do not need exact
 *  boundaries (a regex anchors the value) but do want to see strings the length-prefixed scan skips
 *  (the model display string lives in gen_metadata, not always length-prefixed the same way). */
function printableRuns(buf, minLen = 4) {
  const out = [];
  if (!buf) return out;
  let run = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c <= 0x7e) {
      run.push(c);
    } else {
      if (run.length >= minLen) out.push(Buffer.from(run).toString('latin1'));
      run = [];
    }
  }
  if (run.length >= minLen) out.push(Buffer.from(run).toString('latin1'));
  return out;
}

/** `file:///C:/proj` -> `C:\proj`; `file:///home/x` -> `/home/x`. */
function fileUriToPath(uri) {
  let p = String(uri).replace(/^file:\/\//i, '');
  try { p = decodeURIComponent(p); } catch { /* leave as-is */ }
  if (/^\/[A-Za-z]:/.test(p)) {                 // Windows drive URI: '/C:/proj'
    p = p.slice(1).replace(/\//g, '\\');        // -> 'C:\proj'
  }
  return p;
}

// A generated title is a short Title-Case phrase — multiple words, no path/uuid/JSON punctuation.
function looksLikeTitle(s) {
  if (!s || s.length < 4 || s.length > 100) return false;
  if (/[\/:\\$@{}<>"]/.test(s)) return false;   // paths, uuids-with-$, JSON, tags
  if (!/\s/.test(s)) return false;              // must be more than one word
  if (!/^[A-Z]/.test(s)) return false;          // agy titles are Title Case
  return /^[A-Za-z0-9 .,'()!?-]+$/.test(s);
}

// A user prompt is human text: not a uuid/hash, path, or structural token.
function looksLikePrompt(s) {
  if (!s || s.length < 2 || s.length > 500) return false;
  if (/[\/\\$@{}]|file:/.test(s)) return false;
  if (/^[0-9a-f]{8,}$/i.test(s.replace(/-/g, ''))) return false;   // uuid / hex id
  if (/^-?\d+$/.test(s)) return false;
  if (/^(sessionID|write_file|list_dir|read_file|command|unsandboxed|MODEL_|auto)/i.test(s)) return false;
  return /[A-Za-z]/.test(s);
}

// Model: prefer a DISPLAY string (matches `agy models`, ends in a parenthetical); else an id form that
// carries a version digit (so `gemini-default` is not mistaken for a model). The LAST match wins.
const DISPLAY_MODEL_RE = /(?:Gemini|Claude|GPT)[A-Za-z0-9 .+-]{0,40}?\([A-Za-z ]+\)/gi;
const ID_MODEL_RE = /\b(?:gemini|claude|gpt)-[a-z0-9.]*\d[a-z0-9.-]*/gi;

function extractModel(text) {
  const disp = text.match(DISPLAY_MODEL_RE);
  if (disp && disp.length) return disp[disp.length - 1].trim();
  const id = text.match(ID_MODEL_RE);
  if (id && id.length) return id[id.length - 1].trim();
  return null;
}

/** Read all the blobs once and fold them into the facts we report. */
function readConversation(db) {
  const facts = {
    cwd: null,
    title: null,
    firstPrompt: null,
    model: null,
    messageCount: 0,
    userMessageCount: 0,
    lastRole: null,      // 'user' | 'assistant' — the last 14/15 step
  };

  // cwd — the first `file://` string in the trajectory metadata blob (proto field 1.1).
  try {
    const rows = db.all('SELECT data FROM trajectory_metadata_blob');
    for (const r of rows) {
      const buf = asBuffer(r.data);
      const uri = protoStrings(buf, 3).find(s => /^file:\/\//i.test(s));
      if (uri) { facts.cwd = fileUriToPath(uri); break; }
    }
  } catch { /* no metadata blob -> cwd stays null (session falls into the backend bucket) */ }

  // steps — counts, roles, title, first prompt, and model hunting text.
  const modelText = [];
  try {
    const steps = db.all('SELECT idx, step_type AS stepType, step_payload AS payload, metadata FROM steps ORDER BY idx');
    for (const s of steps) {
      const type = Number(s.stepType);
      const payload = asBuffer(s.payload);
      const meta = asBuffer(s.metadata);

      if (type === 14 || type === 15) {
        facts.messageCount++;
        facts.lastRole = type === 14 ? 'user' : 'assistant';
        if (type === 14) {
          facts.userMessageCount++;
          if (!facts.firstPrompt) {
            const p = protoStrings(payload, 2).find(looksLikePrompt);
            if (p) facts.firstPrompt = p.slice(0, 500);
          }
        }
      }

      if (type === 23 && !facts.title) {
        const t = protoStrings(payload, 4).find(looksLikeTitle);
        if (t) facts.title = t;
      }

      // Model can appear in any step's blobs; collect the printable text for the hunt.
      if (payload) modelText.push(...printableRuns(payload, 5));
      if (meta) modelText.push(...printableRuns(meta, 5));
    }
  } catch { /* steps unreadable -> report what we have */ }

  // gen_metadata also carries the model (the `model_enum` block) — include it in the hunt. Optional
  // table: a fixture without it must not fail.
  try {
    const gen = db.all('SELECT data FROM gen_metadata');
    for (const r of gen) modelText.push(...printableRuns(asBuffer(r.data), 5));
  } catch { /* no gen_metadata -> model may stay null */ }

  facts.model = extractModel(modelText.join('\n'));
  return facts;
}

/** Build the normalised row session-cache consumes (the shape codex/pi return). */
function buildRow(facts, dbPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(dbPath); } catch { return null; }

  // The `.db` basename IS the conversation id — the same id `agy --conversation <id>` resumes.
  const sessionId = path.basename(dbPath).replace(/\.db$/i, '');
  if (!sessionId) return null;

  // No timestamp lives in the blobs, so the file's own times are the honest source. The scan buckets by
  // `modified`; busy/idle rides on `lastEntryAt` (state.js) with the file mtime as the last-activity edge.
  const modifiedIso = stat.mtime.toISOString();
  const createdIso = stat.birthtime.toISOString();

  const summary = facts.title || facts.firstPrompt || '';
  return {
    sessionId,
    backendId: 'agy',
    cwd: facts.cwd,                    // the scanner buckets by this via central derive-project-path
    folder: opts.folder != null ? opts.folder : null,
    projectPath: opts.projectPath != null ? opts.projectPath : null,
    summary,
    firstPrompt: facts.firstPrompt || summary,
    created: createdIso,
    modified: modifiedIso,
    messageCount: facts.messageCount,
    userMessageCount: facts.userMessageCount,
    largestUserPromptWords: 0,
    // FTS body: the title and first prompt. We deliberately do NOT dump every extracted proto string
    // (uuids, tool scaffolding, field names) into search — it would be low-signal noise.
    textContent: [facts.title, facts.firstPrompt].filter(Boolean).join('\n'),
    slug: null, customTitle: null, aiTitle: null,
    startedAt: null,                  // no timestamp in the store
    lastEntryAt: modifiedIso,         // the file mtime stands in for last activity (state.js)
    activeMinutes: 0,
    model: facts.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    // Busy/idle input for state.js: the role of the last message step. A trailing USER step means a turn
    // is running; a trailing MODEL step means the turn is answered.
    lastRole: facts.lastRole,
    lastStopReason: null,
    // No per-day metrics: the store carries no timestamps and no per-turn token counts, so there is
    // nothing honest to book onto a day. An empty list, not invented zeros.
    dailyMetrics: [],
  };
}

// --- transcript export (the viewer + handoff read THIS, not the raw binary file) ---
//
// agy's `.db` is a binary SQLite/protobuf file, so `transcriptAccess: 'export'`: the message viewer and
// the handoff extractor cannot read it as JSONL. They call `readMessages`, which walks the steps and
// pulls the human text out of each turn's protobuf blob — the same contract Hermes exports.
//
// Pulling prose out of an undecoded protobuf reliably needs a real (if shallow) field walk, NOT the
// length-prefixed string scan used for the short identity fields: a model REPLY is one length-delimited
// field whose value contains newlines and markdown, and a naive byte scan splits it at every 0x0a and
// re-matches partial windows at any byte that happens to look like a wire-type-2 tag. So walk the wire
// format: descend into nested messages, and emit a field's bytes as text only when they are ALL text
// (no stray C0 control bytes — those are protobuf structure).

/** A protobuf varint at `i` -> [value, nextOffset]; [null, i] if it runs off the end. */
function readVarint(buf, i) {
  let shift = 0;
  let result = 0;
  let pos = i;
  while (pos < buf.length && shift < 64) {
    const b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);   // Math.pow avoids 32-bit << overflow on long fields
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
  }
  return [null, i];
}

/** Are these bytes pure text (a proto STRING), or a nested message? A nested message carries field
 *  tags/lengths in the C0 control range; genuine text has none but \t \n \r (high bytes are UTF-8). */
function isTextBytes(buf) {
  if (buf.length === 0) return false;
  for (let k = 0; k < buf.length; k++) {
    const c = buf[k];
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20) return false;
  }
  return true;
}

/** Walk a protobuf message, collecting every string-valued leaf field (recursing into sub-messages). */
function walkProtoText(buf, out, depth = 0) {
  if (depth > 12) return;
  let i = 0;
  while (i < buf.length) {
    const [tag, afterTag] = readVarint(buf, i);
    if (tag === null || afterTag === i) return;
    const wire = tag & 0x07;
    i = afterTag;
    if (wire === 0) {                       // varint
      const [, next] = readVarint(buf, i);
      if (next === i) return;
      i = next;
    } else if (wire === 1) {                // 64-bit
      i += 8;
    } else if (wire === 5) {                // 32-bit
      i += 4;
    } else if (wire === 2) {                // length-delimited: a string, bytes, or a nested message
      const [len, afterLen] = readVarint(buf, i);
      if (len === null || len < 0 || afterLen + len > buf.length) return;
      const sub = buf.slice(afterLen, afterLen + len);
      if (isTextBytes(sub)) out.push(sub.toString('utf8'));
      else walkProtoText(sub, out, depth + 1);
      i = afterLen + len;
    } else {
      return;                               // group / unknown wire type -> stop at this level
    }
  }
}

// Is a leaf string an actual MESSAGE, versus an id / path / tool-call / structural token?
function messageish(t) {
  if (!t || t.length < 2) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (/^[{[]/.test(t)) return false;                          // JSON / tool-call payload
  if (/^file:/i.test(t)) return false;                        // a bare URI
  if (/^([A-Za-z]:[\\/]|\\\\|\/)\S+$/.test(t)) return false;  // a bare filesystem path (no spaces)
  if (/^[$]?[0-9a-f-]{8,}$/i.test(t)) return false;           // uuid / hex id
  if (!/\s/.test(t)) {                                        // a single token, no spaces:
    if (!/^[a-zäöüß]{2,20}$/i.test(t)) return false;          //   only a plain word (a short prompt)
    if (/[A-Z]/.test(t) && /[a-z]/.test(t)) return false;     //   not a camelCase identifier
  }
  return true;
}

/** The one human message a step's blob carries: the LONGEST message-like text leaf (a reply dwarfs the
 *  ids and tool scaffolding around it). null when the step carries no prose (a pure tool-call turn). */
function extractMessageText(payload) {
  if (!payload) return null;
  const out = [];
  try { walkProtoText(payload, out, 0); } catch { return null; }
  const cands = out.map(s => s.trim()).filter(messageish);
  if (!cands.length) return null;
  cands.sort((a, b) => b.length - a.length);
  return cands[0];
}

/**
 * The conversation's turns, in the shape the transcript viewer and the handoff extractor speak — the
 * SAME shape Hermes returns (backends/hermes/reader.js): one `{ type:'message', timestamp, message }`
 * per turn. agy's store has no per-turn timestamp, so `timestamp` is null.
 *
 * `dbPath` is the conversation `.db` (the descriptor resolves a sessionId to it via the file store).
 * Read-only, short-lived. Never throws — returns [] on any failure, like every other reader here.
 */
function readMessages(dbPath, opts = {}) {
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const steps = db.all('SELECT step_type AS stepType, step_payload AS payload FROM steps ORDER BY idx');
    const out = [];
    for (const s of steps) {
      const type = Number(s.stepType);
      if (type !== 14 && type !== 15) continue;   // skip tool (9) and lifecycle (23, 98) steps
      const text = extractMessageText(asBuffer(s.payload));
      if (!text) continue;                        // no clean prose (a tool-call turn) -> skip, not empty
      out.push({
        type: 'message',
        timestamp: null,
        message: { role: type === 14 ? 'user' : 'assistant', content: text },
      });
    }
    const limit = Number(opts.limit) || 0;
    return limit > 0 ? out.slice(-limit) : out;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Full parse of a {kind:'file'} handle (the `.db`) -> normalised row (or null). */
function parseSession(handle, opts = {}) {
  if (!handle || handle.kind !== 'file' || !handle.path) return null;
  const db = openDb(handle.path);
  if (!db) return null;
  try {
    const facts = readConversation(db);
    return buildRow(facts, handle.path, opts);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/**
 * Incremental re-entry (§5.10). SQLite is NOT tail-readable — there is no byte offset to resume from and
 * no cheap "what changed" — so this does a full `parseSession` and returns a null parse-state. It exists
 * to satisfy the same `{ row, parseState }` shape every file-mode backend exposes (backend-parity), not
 * to be genuinely incremental; the scan's staleness gate (mtime + PARSER_SCHEMA_VERSION) is what keeps a
 * re-read from happening when nothing moved.
 */
function parseSessionIncremental(handle, opts = {}, _prev = null) {
  if (!handle || handle.kind !== 'file' || !handle.path) return { row: null, parseState: null };
  return { row: parseSession(handle, opts), parseState: null };
}

module.exports = {
  PARSER_SCHEMA_VERSION,
  parseSession,
  parseSessionIncremental,
  readMessages,
  // exported for the unit test / reuse
  protoStrings,
  printableRuns,
  fileUriToPath,
  extractModel,
  extractMessageText,
  readConversation,
  openDb,
};
