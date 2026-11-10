// Print the KEY NAMES (never values) of the Claude Code transcript records the session-flow reader depends on (#826, spec
// 46): the compaction boundary, the compact summary line, a subagent's tool result and a subagent's `.meta.json`, plus the
// distinct `message.model` names on assistant lines (model names only). Used to check the hand-built fixtures in
// `test/fixtures/flow/` against what the CLI really writes, before a reader is built on them.
//
// Usage: node scripts/probe-claude-keys.js [--files=N]
//   Reads the newest N transcripts under 5 MB (default 300) of the Claude store (`SWITCHBOARD_STORE_CLAUDE`, else
//   `~/.claude/projects`), streamed line by line; a line over 2 M characters is skipped. Prints no text, no path.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/probe-claude-keys.js [--files=N]   (key and model names only; no text, no paths)');
  process.exit(0);
}
const filesArg = args.find((a) => a.startsWith('--files='));
const unknown = args.filter((a) => a !== filesArg);
if (unknown.length) { console.error('Unknown option. Usage: node scripts/probe-claude-keys.js [--files=N]'); process.exit(1); }
const maxFiles = filesArg ? Number(filesArg.slice('--files='.length)) : 300;
if (!Number.isInteger(maxFiles) || maxFiles < 1) { console.error('--files must be a positive whole number'); process.exit(1); }

const root = process.env.SWITCHBOARD_STORE_CLAUDE || path.join(os.homedir(), '.claude', 'projects');

// Key names, one level deep for nested objects; arrays and values are never printed.
function keys(o, depth = 0) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 1) return '';
  return Object.keys(o).sort().map((k) => {
    const v = o[k];
    return v && typeof v === 'object' && !Array.isArray(v) && depth < 1 ? `${k}{${keys(v, depth + 1)}}` : k;
  }).join(',');
}

async function main() {
  let dirs;
  try { dirs = await fs.promises.readdir(root); } catch (err) { console.error(`The store could not be read (${err.code || 'error'}).`); process.exit(1); }
  const files = [];
  for (const d of dirs) {
    let names;
    try { names = await fs.promises.readdir(path.join(root, d)); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const st = await fs.promises.stat(path.join(root, d, f));
        if (st.size < 5e6) files.push({ file: path.join(root, d, f), mtime: st.mtimeMs });
      } catch { /* gone meanwhile */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const seen = {};
  const models = new Map();
  let unreadable = 0;
  for (const { file } of files.slice(0, maxFiles)) {
    try {
      for await (const line of readline.createInterface({ input: fs.createReadStream(file) })) {
        if (line.length > 2e6) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (!m || typeof m !== 'object') continue;
        if (m.type === 'system' && m.subtype === 'compact_boundary' && !seen.compactBoundary) seen.compactBoundary = keys(m);
        if (m.isCompactSummary && !seen.compactSummary) seen.compactSummary = keys(m);
        if (m.toolUseResult && m.toolUseResult.agentId && !seen.subagentToolResult) seen.subagentToolResult = keys(m.toolUseResult);
        if (m.type === 'assistant' && m.message && typeof m.message.model === 'string') models.set(m.message.model, (models.get(m.message.model) || 0) + 1);
      }
    } catch { unreadable++; continue; }
    if (!seen.subagentMeta) {
      const sub = path.join(file.slice(0, -'.jsonl'.length), 'subagents');
      try {
        const meta = (await fs.promises.readdir(sub)).find((x) => x.endsWith('.meta.json'));
        if (meta) seen.subagentMeta = keys(JSON.parse(await fs.promises.readFile(path.join(sub, meta), 'utf8')));
      } catch { /* no subagents here */ }
    }
  }
  console.log(JSON.stringify({ filesRead: Math.min(files.length, maxFiles), unreadable, ...seen }, null, 1));
  console.log('assistant message.model names:');
  for (const [name, count] of [...models].sort((a, b) => b[1] - a[1])) console.log(`  ${name}: ${count}`);
}

main().catch((err) => { console.error(`Failed: ${err.code || 'error'}`); process.exit(1); });
