#!/usr/bin/env node
// Structure probe for the Codex and Pi stores (#826). Codex: line kinds, tool names, session sources and the
// risk/outcome enum of guardian verdicts. Pi: the stored system sections next to usage, and the compaction
// shape. Prints counts, type names and key names only: no message text, no file contents, no paths or names.
// Streams every file line by line and reads at most --max-files files per backend (newest first). A line over
// 16 M characters is skipped unparsed (readline still buffers it). An unreadable file is counted and reported
// by error code only (a message would name a path); the run goes on.
//
//   node scripts/probe-flow-codex-pi.js [--only=codex|pi] [--max-files=N]
//
// Store roots follow the app: SWITCHBOARD_STORE_CODEX, else CODEX_HOME/sessions, else ~/.codex/sessions;
// SWITCHBOARD_STORE_PI, else PI_CODING_AGENT_SESSION_DIR, else ~/.pi/agent/sessions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const MAX_LINE = 16 * 1024 * 1024;
const count = (m, k) => { m[k] = (m[k] || 0) + 1; };

function usage() {
  console.log('Usage: node scripts/probe-flow-codex-pi.js [--only=codex|pi] [--max-files=N]');
  console.log('  --only=codex|pi   probe one backend (default: both)');
  console.log('  --max-files=N     newest N files per backend (default 200)');
  console.log('Roots: SWITCHBOARD_STORE_CODEX / CODEX_HOME, SWITCHBOARD_STORE_PI / PI_CODING_AGENT_SESSION_DIR,');
  console.log('else the CLI default home. Prints counts, type names and key names only.');
  console.log('Any of the options above starts a run; no arguments prints this text. An unknown option prints it and exits 1.');
}

function codexRoot() {
  return process.env.SWITCHBOARD_STORE_CODEX
    || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}
function piRoot() {
  return process.env.SWITCHBOARD_STORE_PI
    || process.env.PI_CODING_AGENT_SESSION_DIR
    || path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

async function walk(dir, out = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

async function newest(root, max) {
  const files = await walk(root);
  const stat = await Promise.all(files.map(async f => {
    try { return { f, t: (await fs.promises.stat(f)).mtimeMs }; } catch { return null; }
  }));
  return stat.filter(Boolean).sort((a, b) => b.t - a.t).slice(0, max).map(s => s.f);
}

// Yields parsed lines; unparsable, oversize and non-object lines yield {} so the position stays stable.
async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw) continue;
    if (raw.length > MAX_LINE) { yield {}; continue; }
    let o;
    try { o = JSON.parse(raw); } catch { yield {}; continue; }
    yield o && typeof o === 'object' ? o : {};
  }
}

const unreadable = {};
const noteUnreadable = e => count(unreadable, (e && e.code) || 'unreadable');

async function probeCodex(max) {
  const files = await newest(codexRoot(), max);
  const kinds = {}, calls = {}, sources = {}, verdicts = [];
  for (const f of files) {
    let first = true, src, lastAssistant = null;
    try {
    for await (const o of lines(f)) {
      const p = o.payload || {};
      if (first) {
        first = false;
        src = p.source;
        count(sources, typeof src === 'string' ? src : Object.keys(src?.subagent || {}).join(',') || 'other');
      }
      count(kinds, o.type + '|' + (p.type || ''));
      if (/call$/.test(p.type || '')) count(calls, p.type + ':' + p.name);
      if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant') lastAssistant = p;
    }
    } catch (e) { noteUnreadable(e); continue; }
    if (src?.subagent?.other === 'guardian' && lastAssistant) {
      try {
        const j = JSON.parse((lastAssistant.content || []).map(c => c.text || '').join(''));
        verdicts.push({ risk_level: j.risk_level, outcome: j.outcome });
      } catch { /* not a verdict */ }
    }
  }
  console.log('codex files', files.length);
  console.log({ kinds, calls, sources, verdicts, unreadable });
}

async function probePi(max) {
  const files = await newest(piRoot(), max);
  let n = 0;
  for (const f of files) {
    n++;
    let sys = null, used = false, comp = null;
    try {
    for await (const o of lines(f)) {
      const m = o.message;
      if (!sys && m?.role === 'system' && m.sections) sys = m;
      if (!used && m?.usage && (m.usage.input + m.usage.cacheRead + m.usage.cacheWrite) > 0) used = true;
      if (!comp && o.type === 'compaction') comp = o;
    }
    } catch (e) { noteUnreadable(e); continue; }
    if (sys || comp) {
      console.log(`pi session #${n}`, {
        sections: sys ? Object.keys(sys.sections) : null, used, compactionKeys: comp ? Object.keys(comp) : null,
      });
    }
  }
  console.log('pi files', files.length, 'unreadable', unreadable);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { usage(); return 0; }
  const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
  const maxArg = Number((args.find(a => a.startsWith('--max-files=')) || '').slice(12));
  const max = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : 200;
  const known = args.every(a => /^--only=(codex|pi)$/.test(a) || /^--max-files=\d+$/.test(a));
  if (!known) { usage(); return 1; }
  if (!only || only === 'codex') await probeCodex(max);
  if (!only || only === 'pi') await probePi(max);
  return 0;
}

main().then(code => { process.exitCode = code; }, err => { console.error(err && err.code ? 'Failed: ' + err.code : 'Failed.'); process.exitCode = 1; });
