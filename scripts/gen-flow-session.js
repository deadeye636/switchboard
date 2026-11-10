// Write a synthetic, large Claude Code transcript into the DEMO store, to measure the Flow tab (#826, spec 46) on a session
// far bigger than any real one: prompts, Read tool calls with their results, answers and usage on every request, a
// permission-mode change now and then. Shapes follow `test/fixtures/flow/claude-main.jsonl`; nothing in it is real.
//
// Usage: node scripts/gen-flow-session.js <existing demo session id or prefix> [turns]
//   The new session goes into the same project folder as the named demo session, so the app files it under that
//   project. Only the demo store is ever written (`SWITCHBOARD_DEMO_DIR`, default `C:/temp/switchboard`, as
//   `scripts/demo-start.js` uses it). Prints the new session id. 3000 turns give about 11 000 flow steps.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveDemoDir } = require('./seed-demo');

const [prefix, turnsArg] = process.argv.slice(2);
if (!prefix || prefix === '--help') {
  console.log('Usage: node scripts/gen-flow-session.js <existing demo session id or prefix> [turns]');
  process.exit(prefix ? 0 : 1);
}
const turns = Number(turnsArg) || 3000;
if (!Number.isInteger(turns) || turns < 1 || turns > 50000) {
  console.error('turns must be a whole number between 1 and 50000');
  process.exit(1);
}

const root = path.join(resolveDemoDir(), 'stores', 'claude', 'projects');
let dir = null;
let sampleFile = null;
try {
  for (const d of fs.readdirSync(root)) {
    const hit = fs.readdirSync(path.join(root, d)).find((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
    if (hit) { dir = path.join(root, d); sampleFile = path.join(dir, hit); break; }
  }
} catch (err) {
  console.error(`The demo store could not be read (${err.code || 'error'}). Run npm run demo:start once first.`);
  process.exit(1);
}
if (!dir) { console.error('No demo session matches that id.'); process.exit(1); }

// The working directory the app files the session under: the one the named demo session carries.
let cwd = null;
for (const line of fs.readFileSync(sampleFile, 'utf8').split('\n')) {
  try { const m = JSON.parse(line); if (m && typeof m.cwd === 'string') { cwd = m.cwd; break; } } catch { /* next line */ }
}

const id = crypto.randomUUID();
const out = fs.createWriteStream(path.join(dir, `${id}.jsonl`));
let parent = null;
let t = Date.parse('2026-11-01T08:00:00Z');
const write = (fields) => {
  const uuid = crypto.randomUUID();
  t += 1500;
  out.write(JSON.stringify({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.318', timestamp: new Date(t).toISOString(), uuid, ...fields }) + '\n');
  parent = uuid;
};
const usage = (read) => ({ input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 50, output_tokens: 20 });

for (let i = 1; i <= turns; i++) {
  write({ type: 'user', permissionMode: i % 500 === 0 ? 'plan' : 'default', message: { role: 'user', content: `Synthetic prompt ${i}: read two files and summarise.` } });
  for (let k = 0; k < 2; k++) {
    const toolId = `toolu_${i}_${k}`;
    write({ type: 'assistant', message: { id: `msg_${i}_${k}`, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: `<project>/file${k}.txt` } }], usage: usage(1000 + i * 30) } });
    write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'synthetic file content '.repeat(20) }] } });
  }
  write({ type: 'assistant', message: { id: `msg_${i}_x`, model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: `Synthetic answer ${i}` }], usage: usage(1100 + i * 30) } });
}
out.end(() => console.log(id));
