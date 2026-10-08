// Measure what Claude Code says on claude-native's pipe about a shell that a SUBAGENT starts (#771). It starts one
// short `claude -p` session, asks the model to run one foreground agent, and has that agent run a Bash call long
// enough to become a task. It prints every `task_*` and `background_tasks_changed` system line with the time since
// the start, with the fields that tell an owner apart (`owned_by_subagent`, `parent_tool_use_id`, `tool_use_id`),
// and says whether a subagent's tool result named the shell's output file. After the session ends it reads the
// session's transcript and prints every line about a task notification with the task id it names. It costs two or
// three short model turns. Prompts, hook output and paths are left out of what it prints.
//
// Usage: node scripts/measure-claude-subagent-task.js <cwd> [wait|early|stop] [<model>]
//   <cwd>    a scratch directory the session runs in (created if missing), e.g. under the demo directory.
//   wait     (default) the agent waits for its background shell, with a long foreground shell, before it returns.
//   early    the agent returns at once and leaves its background shell running; the session is kept open
//            40 s past its turn so the shell's end can arrive.
//   stop     like wait, and `stop_task` is sent for the agent's background shell 5 s after its start.
//   <model>  defaults to `haiku`.
// Set CLAUDE_CONFIG_DIR to keep the transcript out of your real home (the demo's: `<demo>/stores/claude`). The
// session runs with `--dangerously-skip-permissions`, so keep <cwd> a scratch directory. The last measurement is
// in `docs/specs/32-claude-native.md` (Background tasks, #771).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cwd = process.argv[2];
if (!cwd) {
  console.error('usage: node scripts/measure-claude-subagent-task.js <cwd> [wait|early|stop] [<model>]');
  process.exit(2);
}
const MODES = ['wait', 'early', 'stop'];
const named = MODES.includes(process.argv[3]);
const mode = named ? process.argv[3] : 'wait';
const model = (named ? process.argv[4] : process.argv[3]) || 'haiku';
fs.mkdirSync(cwd, { recursive: true });

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', model, '--dangerously-skip-permissions'];
// A script started from inside a Claude Code session would hand the child that session's markers, and a child
// session writes no transcript (docs/ai/driving-the-app.md, "Measuring a CLI outside the app").
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));
const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
const write = (o) => child.stdin.write(JSON.stringify(o) + '\n');

const shell = '"Run the Bash command `node -e "setTimeout(() => {}, 20000)"` with run_in_background true and description '
  + '\'Wait 20 seconds with a node timer\', then ';
const afterShell = mode === 'early'
  ? 'reply at once with the single word done, without waiting for it." '
  : 'wait for it to finish (use the Bash command `node -e "setTimeout(() => {}, 25000)"` in the foreground with '
    + 'timeout 120000), then reply with the single word done." ';
const prompt = 'Call the Agent tool exactly once, in the FOREGROUND (run_in_background false), '
  + `subagent_type "general-purpose", model "${model}", description "shell probe", with this prompt: `
  + shell + afterShell
  + 'When the agent returns, reply with the single word finished. Do nothing else.';
write({ type: 'user', message: { role: 'user', content: prompt } });

const TASK_LINES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed']);
const KEEP = ['subtype', 'task_id', 'task_type', 'tool_use_id', 'parent_tool_use_id', 'owned_by_subagent',
  'is_backgrounded', 'description', 'status', 'patch', 'summary', 'tasks'];
let sessionId = null;
let stopSent = false;
let lingering = false;
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const s = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!s.trim()) continue;
    let m;
    try { m = JSON.parse(s); } catch { continue; }
    if (typeof m.session_id === 'string') sessionId = m.session_id;
    if (m.type === 'system' && TASK_LINES.has(m.subtype)) {
      const shown = {};
      for (const k of KEEP) if (k in m) shown[k] = m[k];
      console.log(ts(), m.subtype, JSON.stringify(shown));
      if (mode === 'stop' && !stopSent && m.subtype === 'task_started' && m.owned_by_subagent === true && m.is_backgrounded === true) {
        stopSent = true;
        setTimeout(() => {
          console.log(ts(), '>>> stop_task', m.task_id);
          write({ type: 'control_request', request_id: 'stop-1', request: { subtype: 'stop_task', task_id: m.task_id } });
        }, 5000);
      }
    } else if (m.type === 'control_response') {
      console.log(ts(), 'control_response', JSON.stringify(m.response));
    } else if (m.type === 'assistant') {
      for (const b of (m.message && m.message.content) || []) {
        if (b.type === 'tool_use') {
          console.log(ts(), 'tool_use', b.name, b.id, `parent=${m.parent_tool_use_id || '-'}`,
            `bg=${!!(b.input && b.input.run_in_background)}`);
        }
      }
    } else if (m.type === 'user' && m.parent_tool_use_id) {
      for (const b of (m.message && m.message.content) || []) {
        if (b && b.type === 'tool_result') {
          const named = /Output is being written to: /.test(JSON.stringify(b.content));
          console.log(ts(), 'subagent tool_result', b.tool_use_id, `names output file: ${named}`);
        }
      }
    } else if (m.type === 'user' && m.origin) {
      console.log(ts(), 'user line', JSON.stringify({ origin: m.origin }));
    } else if (m.type === 'result') {
      console.log(ts(), 'result', m.subtype, `is_error=${m.is_error}`, m.is_error ? String(m.result || '').slice(0, 160) : '');
      // `early` leaves the shell running past the turn: keep the session open for its end.
      if (mode !== 'early') child.stdin.end();
      else if (!lingering) { lingering = true; setTimeout(() => child.stdin.end(), 40000); }
    }
  }
});

// Every line of the session's own transcript about a task notification: which task ids reached it, and how.
function readTranscriptNotices() {
  if (!sessionId) return;
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const root = path.join(home, 'projects');
  let file = null;
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const f = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (!file) { console.log('transcript: not found'); return; }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('<task-notification>')) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const text = JSON.stringify(m.message ? m.message.content : m.content);
    const id = /<task-id>([^<]+)<\/task-id>/.exec(text);
    console.log('transcript notice', JSON.stringify({ type: m.type, operation: m.operation, reason: m.reason,
      origin: m.origin, isSidechain: m.isSidechain, taskId: id ? id[1] : null }));
  }
}

child.on('exit', (code) => { console.log(ts(), 'exit', code); clearTimeout(guard); readTranscriptNotices(); });
const guard = setTimeout(() => { console.log(ts(), 'gave up after 240 s'); child.kill(); }, 240000);
