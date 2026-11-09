// Measure what the two pipe-driven backends report about the prompt cache across turns (#827): three one-word turns in
// one process, the third after a wait that outlasts a 5-minute cache. It prints the usage figures only, never the
// conversation or a path, and persists no session. It costs three short model turns per backend, on the smallest model.
//
// Usage: node scripts/measure-cache-across-turns.js [--wait=<seconds>]
//   Run it from an empty directory you trust: Windows looks up a bare program there first, and a project's own settings
//   change the prompt. It exits 1 when a turn got no answer, because a failed probe has measured nothing (#546).
//   --wait  defaults to 390. The last measurement is in `docs/backend-formats.md` ("What a turn says about the prompt cache").
'use strict';

const { spawn, execFile } = require('child_process');
const readline = require('readline');

const waitArg = process.argv.slice(2).find((a) => a.startsWith('--wait='));
const WAIT_MS = (waitArg ? Number(waitArg.slice('--wait='.length)) : 390) * 1000;
if (!Number.isFinite(WAIT_MS) || WAIT_MS < 0) { console.error('--wait takes a number of seconds'); process.exit(1); }
const TURN_TIMEOUT_MS = 120000;
const STOP_TIMEOUT_MS = 10000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const BACKENDS = [
  {
    name: 'claude-native',
    // No user settings and no MCP servers: their hooks and tools are not what this measures.
    command: 'claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --setting-sources project',
    turnLine: (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }),
    model: null,
    read(msg, say) {
      if (msg.type === 'system' && msg.subtype === 'init') this.model = msg.model;
      if (msg.type !== 'result') return false;
      const u = msg.usage || {};
      const written = u.cache_creation || {};
      say({ model: this.model, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, write5m: written.ephemeral_5m_input_tokens, write1h: written.ephemeral_1h_input_tokens, input: u.input_tokens, costSoFar: msg.total_cost_usd, error: msg.is_error });
      return true;
    },
  },
  {
    name: 'pi-native',
    command: 'pi --mode rpc --no-session --provider anthropic --model claude-haiku-4-5',
    turnLine: (text) => ({ type: 'prompt', message: text }),
    read(msg, say) {
      if (msg.type === 'response' && msg.success === false) { say({ refused: true }); return true; }
      if (msg.type === 'message_end' && msg.message && msg.message.role === 'assistant') {
        const u = msg.message.usage || {};
        say({ model: msg.message.model, read: u.cacheRead, write: u.cacheWrite, write1h: u.cacheWrite1h, input: u.input, cost: u.cost && u.cost.total, stopReason: msg.message.stopReason });
      }
      return msg.type === 'agent_settled'; // not `agent_end`: a retry or a compaction can follow that one
    },
  },
];

async function probe(backend) {
  const say = (turn, figures) => console.log(`${backend.name} ${turn} ${JSON.stringify(figures)}`);
  // A shell because Pi is a `.cmd` shim on Windows. Both command lines are the constants above, nothing is interpolated.
  const child = spawn(backend.command, { env, shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let done = null;
  let turn = '-';
  child.on('error', (err) => say('-', { spawnError: err.code }));
  child.stdin.on('error', () => {}); // a child that has died; its `exit` below reports it
  // With a shell a missing binary fires no `error`: the shell starts, and exits non-zero.
  child.once('exit', (code) => {
    if (!done) return;
    const finish = done;
    done = null;
    say(turn, { exitedDuringTurn: code });
    finish(false);
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (backend.read(msg, (figures) => say(turn, figures)) && done) { const finish = done; done = null; finish(true); }
  });
  const send = (id, text) => new Promise((resolve) => {
    turn = id;
    done = resolve;
    child.stdin.write(`${JSON.stringify(backend.turnLine(text))}\n`);
    setTimeout(() => { if (done === resolve) { done = null; say(id, { timeout: true }); resolve(false); } }, TURN_TIMEOUT_MS);
  });
  let answered = false;
  try {
    if (await send('T1', 'Reply with the single word: one') && await send('T2', 'Reply with the single word: two')) {
      await sleep(WAIT_MS);
      answered = await send('T3', 'Reply with the single word: three');
    }
  } finally {
    child.stdin.end();
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
    if (!(await Promise.race([exited, sleep(STOP_TIMEOUT_MS).then(() => false)]))) {
      if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => {});
      else child.kill();
    }
  }
  return answered;
}

Promise.all(BACKENDS.map(probe)).then((answers) => process.exit(answers.every(Boolean) ? 0 : 1));
