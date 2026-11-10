#!/usr/bin/env node
// Structure-only summary of one JSONL transcript (#826). Prints line kinds, content block types, usage key
// names and where instruction files are named. Never prints message text, file contents or paths.
// Streams the file line by line, so a multi-MB transcript is never held in memory.
//
//   node scripts/probe-transcript-shape.js <transcript.jsonl>
//
// Works on Claude, Codex and Pi transcripts alike. A line over 16 M characters is skipped unparsed (readline
// still buffers that line). A read error is reported as its code only, never its message (which names a path).
const fs = require('fs');
const readline = require('readline');

const MAX_LINE = 16 * 1024 * 1024;
const MEM_FILE = /(CLAUDE\.md|AGENTS\.md|AGENT\.md)/gi;

function usage() {
  console.log('Usage: node scripts/probe-transcript-shape.js <transcript.jsonl>');
  console.log('Prints line kinds, content block types, usage key names and instruction-file mentions.');
  console.log('No message text, file contents or paths are printed.');
}

async function main() {
  const file = process.argv[2];
  if (!file || file === '--help' || file === '-h') { usage(); return 0; }
  if (!fs.existsSync(file)) { console.error('File not found.'); return 1; }

  const kinds = {};
  const memHits = [];
  const usageSamples = [];
  let total = 0;
  let oversize = 0;
  let unparsable = 0;
  let readError = null;

  try {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw) continue;
    const i = total++;
    if (raw.length > MAX_LINE) { oversize++; continue; }
    let o;
    try { o = JSON.parse(raw); } catch { unparsable++; continue; }
    if (!o || typeof o !== 'object') { unparsable++; continue; }
    const p = o.payload || {};
    const msg = o.message || p.message || o;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    const blocks = content.map(b => b && b.type).filter(Boolean).join('+');
    const key = [o.type, o.subtype || p.type || '', msg?.role || '', o.attachment?.type || '', blocks,
      o.isMeta ? 'meta' : '', o.isSidechain ? 'side' : ''].join('|');
    kinds[key] = (kinds[key] || 0) + 1;
    const m = raw.match(MEM_FILE);
    if (m && memHits.length < 12) memHits.push(`#${i} ${key} -> ${[...new Set(m)].join(',')}`);
    const u = msg?.usage || p.info?.total_token_usage || p.info?.last_token_usage || o.usage;
    if (u && typeof u === 'object' && usageSamples.length < 3) usageSamples.push(`#${i} ${Object.keys(u).join(',')}`);
  }
  } catch (e) { readError = (e && e.code) || 'unreadable'; }

  console.log('lines', total, oversize ? `(oversize skipped: ${oversize})` : '', unparsable ? `(unparsable: ${unparsable})` : '');
  console.log('kinds:');
  Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, n]) => console.log(' ', n, k));
  console.log('instruction file mentions:');
  memHits.forEach(h => console.log(' ', h));
  console.log('usage:');
  usageSamples.forEach(h => console.log(' ', h));
  if (readError) { console.log('read error:', readError); return 1; }
  return 0;
}

main().then(code => { process.exitCode = code; }, err => { console.error(err && err.code ? 'Failed: ' + err.code : 'Failed.'); process.exitCode = 1; });
