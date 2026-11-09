// Measure how long Pi's prompt cache lives and what a hit looks like (#827, spec 45): three parallel sessions send
// one-word turns after set gaps, and each turn's cache read is compared with the previous turn's prompt
// (input + read + write). Parallel sessions send the same text, and identical text can share a cache, so the samples are
// not independent: `--gaps` runs one session alone. It prints figures only, keeps no session, and costs about a dozen
// short turns on the smallest model, over about 15 minutes. The last measurement is in `docs/backend-formats.md`.
//
// Usage: node scripts/measure-pi-cache-bound.js [--gaps=<s,s,...>] [--scale=<factor>]
//   Run it from an empty directory you trust: Windows looks up a bare program there first. --scale shortens the gaps for
//   a check of the script itself; the figures then say nothing about the bound.
'use strict';

const { spawn, execFile } = require('child_process');
const readline = require('readline');

const scaleArg = process.argv.slice(2).find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Number(scaleArg.slice('--scale='.length)) : 1;
if (!Number.isFinite(SCALE) || SCALE <= 0) { console.error('--scale takes a positive number'); process.exit(1); }

// Seconds between one turn's end and the next one's send, per session. About the same total, so all end together.
// --gaps=<s,s,...> runs one session with those gaps instead.
const gapsArg = process.argv.slice(2).find((a) => a.startsWith('--gaps='));
const SESSIONS = gapsArg
  ? { solo: gapsArg.slice('--gaps='.length).split(',').map(Number) }
  : { A: [60, 180, 270, 330], B: [240, 285, 315], C: [300, 300, 240] };
if (Object.values(SESSIONS).flat().some((n) => !Number.isFinite(n) || n < 0)) { console.error('--gaps takes seconds, comma separated'); process.exit(1); }
const started = Date.now();
const COMMAND = 'pi --mode rpc --no-session --provider anthropic --model claude-haiku-4-5';
const TURN_TIMEOUT_MS = 120000;
const STOP_TIMEOUT_MS = 10000;
const MAX_ERROR_CHARS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function session(name, gaps) {
  // A shell because Pi is a `.cmd` shim on Windows. The command line is a constant, nothing is interpolated.
  const child = spawn(COMMAND, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  let done = null;
  let usage = null;
  let model = null;
  let stopReason = null;
  let refusal = null;
  let timer = null;
  const finish = (value) => { if (done) { const d = done; done = null; clearTimeout(timer); d(value); } };
  child.once('exit', () => finish(false));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'response' && msg.success === false) { refusal = String(msg.error).slice(0, MAX_ERROR_CHARS); finish(false); }
    if (msg.type === 'message_end' && msg.message && msg.message.role === 'assistant') {
      usage = msg.message.usage || null;
      model = msg.message.model;
      stopReason = msg.message.stopReason;
    }
    if (msg.type === 'agent_settled') finish(true);
  });
  const turn = (word) => new Promise((resolve) => {
    done = resolve;
    usage = null;
    child.stdin.write(`${JSON.stringify({ type: 'prompt', message: `Reply with the single word: ${word}` })}\n`);
    timer = setTimeout(() => finish(false), TURN_TIMEOUT_MS);
  });

  let prompt = 0;
  let ok = await turn('start');
  const report = (gap) => {
    const u = usage || {};
    const read = u.cacheRead || 0;
    const ratio = prompt ? (read / prompt).toFixed(3) : '-';
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`at=${elapsed}s session=${name} gap=${gap}s input=${u.input || 0} output=${u.output || 0} read=${read} write=${u.cacheWrite || 0} previousPrompt=${prompt} ratio=${ratio} write1h=${u.cacheWrite1h || 0} cost=${u.cost ? u.cost.total : '-'} model=${model} stopReason=${stopReason} answered=${ok}${refusal ? ` refusal="${refusal}"` : ''}`);
    prompt = (u.input || 0) + read + (u.cacheWrite || 0);
  };
  report(0);
  for (const gap of gaps) {
    if (!ok) break;
    await sleep(gap * 1000 * SCALE);
    ok = await turn(`after ${gap}`);
    report(gap);
  }
  child.stdin.end();
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  if (!(await Promise.race([exited, sleep(STOP_TIMEOUT_MS).then(() => false)]))) {
    if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], () => {});
    else child.kill();
  }
  return ok;
}

Promise.all(Object.entries(SESSIONS).map(([name, gaps]) => session(name, gaps)))
  .then((answers) => process.exit(answers.every(Boolean) ? 0 : 1));
