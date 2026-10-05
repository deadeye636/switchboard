// Measure agy's subagent link against a real store (#739). READ-ONLY, and it prints COUNTS only — no ids,
// no paths, no conversation content — so its output can go into an issue or a doc as it is.
//
// What it answers:
//   1. how many conversation `.db` files carry a `parent_cascade_id` / `root_cascade_id` key in gen_metadata,
//      and how many bytes sit between a key and the conversation id after it (the parser tolerates 0-8);
//   2. what this checkout's parser makes of each file: subagent, root, or no row;
//   3. how that compares with agy's own `conversation_summaries.db` (`conversation_id`,
//      `parent_conversation_id`, `nesting_depth`), the independent answer to the same question.
//
// Usage: node scripts/measure-agy-subagent-links.js [<agy-home>]
//   <agy-home> defaults to ~/.gemini/antigravity-cli. Both databases are opened read-only through the
//   shared driver (node:sqlite under plain node).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const repo = path.join(__dirname, '..');
const parser = require(path.join(repo, 'src', 'backends', 'agy', 'parser.js'));
const { driver } = require(path.join(repo, 'src', 'backends', 'sqlite-driver.js'));

const base = process.argv[2] || path.join(os.homedir(), '.gemini', 'antigravity-cli');
const convDir = path.join(base, 'conversations');
let files;
try {
  files = fs.readdirSync(convDir).filter((f) => /\.db$/i.test(f));
} catch {
  console.log('no conversations directory under the given agy home');
  process.exit(0);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const KEY_RE = /(parent|root)_cascade_id/g;
const gaps = {};
let withKey = 0, parsedSub = 0, parsedRoot = 0, parseNull = 0, keyButRoot = 0;
const parsed = new Map();   // conversation id (lower case) -> parsed as a subagent?

for (const f of files) {
  const p = path.join(convDir, f);
  const id = f.replace(/\.db$/i, '').toLowerCase();
  let hasKey = false;
  const db = parser.openDb(p);
  if (db) {
    try {
      for (const r of db.all('SELECT data FROM gen_metadata')) {
        const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data || []);
        const text = buf.toString('latin1');
        KEY_RE.lastIndex = 0;
        let m;
        while ((m = KEY_RE.exec(text))) {
          hasKey = true;
          const after = text.slice(m.index + m[0].length, m.index + m[0].length + 64);
          const u = after.match(UUID_RE);
          const k = u ? String(u.index) : 'none<64';
          gaps[k] = (gaps[k] || 0) + 1;
        }
      }
    } catch { /* no gen_metadata table */ }
    try { db.close(); } catch { /* already closed */ }
  }
  if (hasKey) withKey++;
  const row = parser.parseSession({ kind: 'file', path: p });
  if (!row) { parseNull++; continue; }
  const isSub = !!row.parentSessionId;
  if (isSub) parsedSub++; else parsedRoot++;
  if (hasKey && !isSub) keyButRoot++;
  parsed.set(id, isSub);
}

console.log('db files:', files.length);
console.log('files with a cascade key in gen_metadata:', withKey);
console.log('gap bytes key->id (histogram):', JSON.stringify(gaps));
console.log('parser: subagent', parsedSub, '| root', parsedRoot, '| null', parseNull);
console.log('key present but parsed as root (e.g. a self-pointing root_cascade_id):', keyButRoot);

// The independent answer: agy's own summaries store.
const sumPath = path.join(base, 'conversation_summaries.db');
if (!fs.existsSync(sumPath)) { console.log('no conversation_summaries.db'); process.exit(0); }
const d = driver();
let sdb = null;
try { sdb = d && d.open ? d.open(sumPath) : null; } catch { sdb = null; }
if (!sdb) { console.log('conversation_summaries.db could not be opened; cross-check skipped'); process.exit(0); }
try {
  const cols = sdb.all('PRAGMA table_info(conversation_summaries)').map((c) => c.name);
  console.log('summaries columns:', cols.join(','));
  const rows = sdb.all('SELECT * FROM conversation_summaries');
  // The column holding the conversation's own id: the one whose values match the most `.db` basenames.
  let idCol = null, best = 0;
  for (const c of cols) {
    const hits = rows.filter((r) => typeof r[c] === 'string' && parsed.has(r[c].toLowerCase())).length;
    if (hits > best) { best = hits; idCol = c; }
  }
  console.log('summaries rows:', rows.length, '| id column:', idCol, '| matched to db files:', best);
  if (!idCol || !cols.includes('nesting_depth')) process.exit(0);
  let tp = 0, tn = 0, fp = 0, fn = 0, unmatched = 0;
  for (const r of rows) {
    const k = String(r[idCol]).toLowerCase();
    if (!parsed.has(k)) { unmatched++; continue; }
    const truthSub = Number(r.nesting_depth) > 0 || (!!r.parent_conversation_id && r.parent_conversation_id !== '');
    const isSub = parsed.get(k);
    if (truthSub && isSub) tp++;
    else if (!truthSub && !isSub) tn++;
    else if (!truthSub && isSub) fp++;
    else fn++;
  }
  console.log('vs summaries: subagent-correct', tp, '| root-correct', tn,
    '| false positive (root parsed as subagent)', fp, '| missed subagent', fn, '| summary rows without a db', unmatched);
} finally {
  try { sdb.close(); } catch { /* already closed */ }
}
