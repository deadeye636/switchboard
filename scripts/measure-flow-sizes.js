#!/usr/bin/env node
// How large are real transcripts? (#826, open point O5: the cap on flow steps.) Per backend it prints the file
// count, the size spread over all files, and for the N largest files the line and step counts. Numbers only:
// no text, no file names, no paths. Reads each of the N files once as a stream; every other file is only stat'ed.
// A line over 16 M characters is skipped unparsed (readline still buffers it). An unreadable file is counted and
// reported by error code only (a message would name a path); the run goes on.
//
//   node scripts/measure-flow-sizes.js [--top=N] [--only=claude|codex|pi]
//
// A "step" is one model-side action: Claude `assistant` lines, Codex assistant messages plus function and
// custom tool calls, Pi assistant messages. Subagent files are counted as files of their own.
// Store roots follow the app: SWITCHBOARD_STORE_<BACKEND>, else the CLI's default home (CODEX_HOME and
// PI_CODING_AGENT_SESSION_DIR honoured as the CLIs do).
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const MAX_LINE = 16 * 1024 * 1024;

const BACKENDS = {
  claude: {
    root: () => process.env.SWITCHBOARD_STORE_CLAUDE || path.join(os.homedir(), '.claude', 'projects'),
    isStep: o => o.type === 'assistant',
  },
  codex: {
    root: () => process.env.SWITCHBOARD_STORE_CODEX
      || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
    isStep: o => {
      const p = o.payload || {};
      return o.type === 'response_item'
        && ((p.type === 'message' && p.role === 'assistant') || p.type === 'function_call' || p.type === 'custom_tool_call');
    },
  },
  pi: {
    root: () => process.env.SWITCHBOARD_STORE_PI
      || process.env.PI_CODING_AGENT_SESSION_DIR
      || path.join(os.homedir(), '.pi', 'agent', 'sessions'),
    isStep: o => o.message?.role === 'assistant',
  },
};

function usage() {
  console.log('Usage: node scripts/measure-flow-sizes.js [--top=N] [--only=claude|codex|pi]');
  console.log('  --top=N     measure the N largest transcripts per backend (default 5)');
  console.log('  --only=ID   one backend (default: all three)');
  console.log('Prints file counts, size percentiles and per-file line and step counts. No text, no names, no paths.');
  console.log('Either option starts a run; no arguments prints this text. An unknown option prints it and exits 1.');
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

async function sizes(root) {
  const files = await walk(root);
  const out = await Promise.all(files.map(async f => {
    try { return { f, size: (await fs.promises.stat(f)).size }; } catch { return null; }
  }));
  return out.filter(Boolean).sort((a, b) => b.size - a.size);
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

async function measureFile(file, isStep) {
  let lines = 0, steps = 0, oversize = 0, error = null;
  try {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw) continue;
    lines++;
    if (raw.length > MAX_LINE) { oversize++; continue; }
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (isStep(o)) steps++;
  }
  } catch (e) { error = (e && e.code) || 'unreadable'; }
  return { lines, steps, oversize, error };
}

async function measure(id, top) {
  const b = BACKENDS[id];
  const all = await sizes(b.root());
  console.log(`${id}: ${all.length} files`);
  if (!all.length) return;
  const asc = all.map(x => x.size).reverse();
  const kb = n => Math.round(n / 1024);
  console.log(`  size KB  p50=${kb(pct(asc, 0.5))} p90=${kb(pct(asc, 0.9))} p99=${kb(pct(asc, 0.99))} max=${kb(asc[asc.length - 1])}`);
  let rank = 0;
  for (const { f, size } of all.slice(0, top)) {
    const m = await measureFile(f, b.isStep);
    rank++;
    if (m.error) { console.log(`  #${rank} sizeKB=${kb(size)} unreadable=${m.error}`); continue; }
    console.log(`  #${rank} sizeKB=${kb(size)} lines=${m.lines} steps=${m.steps}${m.oversize ? ` oversize=${m.oversize}` : ''}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { usage(); return 0; }
  const topArg = Number((args.find(a => a.startsWith('--top=')) || '').slice(6));
  const top = Number.isFinite(topArg) && topArg > 0 ? topArg : 5;
  const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
  const known = args.every(a => /^--top=\d+$/.test(a) || /^--only=(claude|codex|pi)$/.test(a));
  if (!known) { usage(); return 1; }
  for (const id of only ? [only] : Object.keys(BACKENDS)) await measure(id, top);
  return 0;
}

main().then(code => { process.exitCode = code; }, err => { console.error(err && err.code ? 'Failed: ' + err.code : 'Failed.'); process.exitCode = 1; });
