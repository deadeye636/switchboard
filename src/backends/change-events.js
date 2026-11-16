'use strict';
// The neutral accumulator behind a session's `row.changes` (#870, spec 47 section 1). A backend's extractor feeds it what it
// found in a transcript (an edit, a commit, a push) and the parser reads `toRow()` when `revision` moved. It knows no backend
// id, tool name or transcript format (CLAUDE.md reflex 5) and requires nothing, so a worker and the registry can load it.
//
// What counts:
//   - An EDIT counts only when its result has arrived and is not an error. `noteEdit(path, { callId })` parks it in a
//     bounded pending map; `resolve(callId, { error })` applies or drops it. Without a `callId` the edit counts at once.
//   - A COMMIT or a PUSH is decided by the shell output the extractor read, never by the call's error flag (a chained commit
//     whose push was refused is still a commit), so `noteCommit` / `notePush` count at once.
//   - `position` is the ordering key (spec 47: a byte offset for a file backend, a row id for a store). It is stored as given.
//
// Caps are named constants; a row over a cap says `truncated`. `revision` moves only when the aggregate changed, so a parser
// emits `changes` only when it has something new to say.

const MAX_FILES = 500;            // distinct paths per session
const MAX_COMMITS = 200;          // commit events per session
const MAX_PUSHES = 100;           // push events per session
const MAX_SNAPSHOT_FILES = MAX_FILES; // files in one push snapshot: as many as the session holds, so a snapshot loses nothing the row keeps
const MAX_PENDING = 256;          // calls waiting for their result
const MAX_PATH_CHARS = 1024;
const MAX_SUBJECT_CHARS = 200;
const MAX_BRANCH_CHARS = 200;
const MAX_SUMMARY_CHARS = 120;
const MAX_CALL_ID_CHARS = 256;
const SHA_RE = /^[0-9a-f]{7,64}$/;

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');

function createAccumulator() {
  const files = new Map();        // path -> { path, count, first, last, at }
  const commits = [];
  const commitShas = new Set();
  const pushes = [];
  const pending = new Map();      // call id -> { path, position, at } (insertion order = age)
  let truncated = false;
  let revision = 0;

  const markTruncated = () => {
    if (truncated) return false;
    truncated = true;
    return true;
  };

  function applyEdit(path, position, at) {
    let entry = files.get(path);
    if (!entry) {
      if (files.size >= MAX_FILES) {
        if (markTruncated()) revision++;
        return;
      }
      entry = { path, count: 0, first: position, last: position, at };
      files.set(path, entry);
    }
    entry.count++;
    entry.last = position;
    entry.at = at;
    revision++;
  }

  function noteEdit(path, opts) {
    if (typeof path !== 'string' || !path || path.length > MAX_PATH_CHARS) return false;
    const o = opts || {};
    const position = num(o.position);
    const at = num(o.at);
    const callId = typeof o.callId === 'string' || typeof o.callId === 'number' ? String(o.callId).slice(0, MAX_CALL_ID_CHARS) : '';
    if (!callId) { applyEdit(path, position, at); return true; }
    pending.delete(callId); // a re-sent id is a newer call: refresh its age
    pending.set(callId, { path, position, at });
    while (pending.size > MAX_PENDING) {
      pending.delete(pending.keys().next().value); // evict the oldest call: its edit may be lost, so the row says truncated
      if (markTruncated()) revision++;
    }
    return true;
  }

  /** The result of a call arrived. Returns false for an id that is not pending (never noted, already resolved, evicted). */
  function resolve(callId, opts) {
    const key = typeof callId === 'string' || typeof callId === 'number' ? String(callId).slice(0, MAX_CALL_ID_CHARS) : '';
    const call = pending.get(key);
    if (!call) return false;
    pending.delete(key);
    const o = opts || {};
    if (o.error) return true;
    const position = o.position !== undefined ? num(o.position) : call.position;
    const at = o.at !== undefined ? num(o.at) : call.at;
    applyEdit(call.path, position, at);
    return true;
  }

  function noteCommit(c) {
    if (!c || typeof c.sha !== 'string' || !SHA_RE.test(c.sha) || commitShas.has(c.sha)) return false;
    if (commits.length >= MAX_COMMITS) {
      if (markTruncated()) revision++;
      return false;
    }
    commitShas.add(c.sha);
    const ev = {
      sha: c.sha,
      subject: str(c.subject, MAX_SUBJECT_CHARS),
      branch: str(c.branch, MAX_BRANCH_CHARS),
      position: num(c.position),
      at: num(c.at),
    };
    if (c.amend === true) ev.amend = true;
    commits.push(ev);
    revision++;
    return true;
  }

  // D4: a push that moved something records the per-file counts at its position (capped), so a block's counts are a
  // difference of two snapshots. A failed (nothing moved) or up-to-date push cuts nothing and carries no snapshot; a partial push (`moved`) does.
  function notePush(p) {
    if (!p || typeof p !== 'object') return false;
    if (pushes.length >= MAX_PUSHES) {
      if (markTruncated()) revision++;
      return false;
    }
    const ev = { ok: p.ok === true, summary: str(p.summary, MAX_SUMMARY_CHARS), position: num(p.position), at: num(p.at) };
    if (p.upToDate === true) ev.upToDate = true;
    if (p.force === true) ev.force = true;
    if (typeof p.toSha === 'string' && SHA_RE.test(p.toSha)) ev.sha = p.toSha; // the pushed tip, from the ref line (#870)
    if (p.moved === true) ev.moved = true; // a partial push (one ref refused, another moved) still cuts a block
    if ((ev.ok && !ev.upToDate) || ev.moved) {
      const snap = [];
      for (const f of files.values()) {
        if (snap.length >= MAX_SNAPSHOT_FILES) { ev.truncated = true; markTruncated(); break; }
        snap.push([f.path, f.count]);
      }
      ev.files = snap;
    }
    pushes.push(ev);
    revision++;
    return true;
  }

  function toRow() {
    return {
      files: Array.from(files.values(), (f) => ({ path: f.path, count: f.count, first: f.first, last: f.last, at: f.at })),
      commits: commits.map((c) => ({ ...c })),
      pushes: pushes.map((p) => (p.files ? { ...p, files: p.files.map((x) => x.slice()) } : { ...p })),
      truncated,
    };
  }

  return {
    noteEdit,
    resolve,
    noteCommit,
    notePush,
    toRow,
    get revision() { return revision; },
    get pendingSize() { return pending.size; },
  };
}

/**
 * A cursor over the lines of a Buffer, for the byte offset of the n-th non-empty line (the same lines
 * `text.split('\n').filter(Boolean)` yields). `base` is the file offset of the buffer's first byte. It walks the raw
 * bytes with `indexOf(0x0A)` and only as far as the last line asked for, and never re-encodes a line.
 */
function createLineCursor(buf, base) {
  let pos = 0;
  let line = -1;
  let start = 0;
  const cursor = {
    index: 0,
    offset() {
      while (line < cursor.index) {
        while (pos < buf.length && buf[pos] === 0x0A) pos++;
        start = pos;
        let end = buf.indexOf(0x0A, pos);
        if (end === -1) end = buf.length;
        pos = end;
        line++;
      }
      return base + start;
    },
  };
  return cursor;
}

module.exports = {
  createAccumulator, createLineCursor,
  MAX_FILES, MAX_COMMITS, MAX_PUSHES, MAX_SNAPSHOT_FILES, MAX_PENDING,
  MAX_PATH_CHARS, MAX_SUBJECT_CHARS, MAX_BRANCH_CHARS, MAX_SUMMARY_CHARS, SHA_RE,
};
