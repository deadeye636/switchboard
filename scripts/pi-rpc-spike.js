// scripts/pi-rpc-spike.js — what Pi's RPC mode actually sends (#568).
//
//   node scripts/pi-rpc-spike.js [cwd] ["prompt"] [model]
//
// Spawns `pi --mode rpc` in `cwd` (default: the working directory), sends one prompt, and reports
// four things and nothing else:
//
//   1. every event type in arrival order, so a reader can see what a turn is really made of
//   2. the assistant message assembled from deltas alone — `message_update` carries a delta and no
//      cumulative snapshot, so a client that does not assemble sees nothing
//   3. every key anywhere in the events that names a suggestion or a next/follow-up prompt — how #814
//      found that Pi offers no suggested next prompt for the composer
//   4. the session the events belong to, and whether its file on disk is named the way
//      `backends/pi/turn-queue.js` expects
//
// It costs one real model call against whatever Pi is configured and authenticated for, so keep the
// prompt small and name the smallest model as `model` (e.g. `anthropic/claude-haiku-4-5`); it is passed
// as `--model` with thinking off. It writes nothing except what the prompt makes Pi write, and it is not
// part of the suite: it exists to be run by hand when a question about the protocol comes up.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CWD = process.argv[2] || process.cwd();
const PROMPT = process.argv[3] || 'Reply with exactly the word: pong';
const MODEL = process.argv[4] || '';
const TIMEOUT_MS = 120000;
const SUGGESTION_KEY = /suggest|next|follow/i;

// `shell: true` because pi is a `.cmd` shim on Windows, which Node cannot spawn directly.
const args = ['--mode', 'rpc'];
if (MODEL) args.push('--model', MODEL, '--thinking', 'off');
const child = spawn('pi', args, {
  cwd: CWD,
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const seen = [];
const counts = new Map();
let assembled = '';
let thinking = '';
const toolCalls = [];
let state = null;
let asked = false;
const suggestionKeys = new Set();

function findSuggestionKeys(value, at) {
  if (!value || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (SUGGESTION_KEY.test(key)) suggestionKeys.add(`${at}.${key}`);
    findSuggestionKeys(inner, `${at}.${key}`);
  }
}

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function note(type) {
  seen.push(type);
  counts.set(type, (counts.get(type) || 0) + 1);
}

// Split on \n ONLY. Pi's protocol is strict JSONL and a reader that also breaks on the Unicode
// separators is non-compliant.
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { console.log('[unparseable] ' + line.slice(0, 200)); continue; }
    handle(msg);
  }
});

function handle(msg) {
  findSuggestionKeys(msg, msg.type);
  if (msg.type === 'response') {
    console.log(`[response] command=${msg.command} success=${msg.success} id=${msg.id || ''}`);
    if (msg.command === 'get_state') { state = msg; finish(); }
    return;
  }
  note(msg.type);

  if (msg.type === 'message_update') {
    const ev = msg.assistantMessageEvent || {};
    if (ev.type === 'text_delta') assembled += ev.delta || '';
    else if (ev.type === 'thinking_delta') thinking += ev.delta || '';
    else if (ev.type && !seen.includes('ev:' + ev.type)) seen.push('ev:' + ev.type);
    return;
  }
  if (msg.type === 'tool_execution_start') {
    toolCalls.push(msg.toolName || msg.name || JSON.stringify(msg).slice(0, 80));
    return;
  }
  // Ask who we are only once the work has settled, so the answer cannot change under us.
  if (msg.type === 'agent_settled' || msg.type === 'agent_end') {
    if (!asked) { asked = true; send({ id: 'state-1', type: 'get_state' }); }
  }
}

child.stderr.on('data', (d) => process.stderr.write('[pi stderr] ' + d));
child.on('exit', (code) => { console.log(`\n[pi exited] code=${code}`); });

const timer = setTimeout(() => {
  console.log('\n[TIMEOUT] nothing settled within ' + TIMEOUT_MS + ' ms');
  report();
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

function finish() {
  clearTimeout(timer);
  report();
  child.kill();
  setTimeout(() => process.exit(0), 200);
}

function report() {
  console.log('\n===== SPIKE REPORT =====');
  console.log('\n1. EVENTS in order:');
  console.log('   ' + seen.join(' -> '));
  console.log('\n   counts: ' + JSON.stringify(Object.fromEntries(counts)));

  console.log('\n2. ASSEMBLED from deltas:');
  console.log('   text     : ' + JSON.stringify(assembled));
  console.log('   thinking : ' + JSON.stringify(thinking.slice(0, 120)));
  console.log('   tools    : ' + JSON.stringify(toolCalls));

  console.log('\n3. KEYS naming a suggestion or a next prompt:');
  console.log('   ' + (suggestionKeys.size ? [...suggestionKeys].join(', ') : '(none)'));

  console.log('\n4. SESSION mapping:');
  if (!state) { console.log('   no get_state answer'); return; }
  console.log('   get_state keys: ' + JSON.stringify(Object.keys(state).filter(k => k !== 'type')));
  const flat = JSON.stringify(state);
  const id = /"sessionId":"([^"]+)"/.exec(flat);
  const file = /"sessionFile":"([^"]*)"/.exec(flat);
  console.log('   sessionId   : ' + (id ? id[1] : '(not present)'));
  if (file && file[1]) {
    const base = path.basename(file[1]);
    console.log('   file exists : ' + fs.existsSync(file[1]));
    console.log('   basename    : ' + base);
    const ok = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]+\.jsonl$/i.test(base);
    console.log('   matches the store name pattern: ' + ok);
  } else {
    console.log('   sessionFile : (not present)');
  }
  console.log('\n========================\n');
}

child.stdin.on('error', () => {});
console.log(`[spike] cwd=${CWD}`);
console.log(`[spike] prompt=${JSON.stringify(PROMPT)}`);
console.log(`[spike] model=${MODEL || '(Pi default)'}`);
send({ id: 'req-1', type: 'prompt', message: PROMPT });
