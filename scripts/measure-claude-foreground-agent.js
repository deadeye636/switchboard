// Measure what Claude Code says on claude-native's pipe about a FOREGROUND agent (#768). It starts one short
// `claude -p` session, asks the model to run one agent in the foreground that waits about 30 s, and prints every
// `task_*` and `background_tasks_changed` system line with the time since the start, plus the agent call and its
// result. With `stop` it sends `stop_task` for that agent 8 s after its `task_started` and prints the answer.
// It costs two short model turns (the session's and the agent's). Hook output and the agent's prompt are left out,
// so nothing it prints names a path.
//
// Usage: node scripts/measure-claude-foreground-agent.js <cwd> [stop] [<model>]
//   <cwd>    a scratch directory the session runs in (created if missing), e.g. under the demo directory.
//   stop     stop the agent while it runs instead of letting it finish.
//   <model>  defaults to `haiku`.
// The session runs with `--dangerously-skip-permissions`, so no approval has to be answered: keep <cwd> a scratch
// directory. The last measurement is in `docs/specs/32-claude-native.md` (Background tasks, #768).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const cwd = process.argv[2];
if (!cwd) {
  console.error('usage: node scripts/measure-claude-foreground-agent.js <cwd> [stop] [<model>]');
  process.exit(2);
}
const rest = process.argv.slice(3);
const doStop = rest[0] === 'stop';
const model = (doStop ? rest[1] : rest[0]) || 'haiku';
fs.mkdirSync(cwd, { recursive: true });

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', model, '--dangerously-skip-permissions'];
// A script started from inside a Claude Code session would hand the child that session's markers, and a child
// session behaves differently (docs/ai/driving-the-app.md, "Measuring a CLI outside the app").
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));
const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
const write = (o) => child.stdin.write(JSON.stringify(o) + '\n');

const prompt = 'Call the Agent tool exactly once, in the FOREGROUND (run_in_background false), '
  + `subagent_type "general-purpose", model "${model}", description "slow probe", with this prompt: `
  + '"Run the Bash command `node -e "setTimeout(() => {}, 30000)"` in the foreground with timeout 120000, '
  + 'then reply with the single word done." When the agent returns, reply with the single word finished. Do nothing else.';
write({ type: 'user', message: { role: 'user', content: prompt } });

const TASK_LINES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed']);
let stopSent = false;
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
    if (m.type === 'system' && TASK_LINES.has(m.subtype)) {
      const shown = { ...m };
      for (const k of ['session_id', 'uuid', 'prompt', 'output_file']) delete shown[k];
      console.log(ts(), m.subtype, JSON.stringify(shown));
      if (doStop && !stopSent && m.subtype === 'task_started' && m.task_type === 'local_agent') {
        stopSent = true;
        setTimeout(() => {
          console.log(ts(), '>>> stop_task', m.task_id);
          write({ type: 'control_request', request_id: 'stop-1', request: { subtype: 'stop_task', task_id: m.task_id } });
        }, 8000);
      }
    } else if (m.type === 'control_response') {
      console.log(ts(), 'control_response', JSON.stringify(m.response));
    } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
      for (const b of (m.message && m.message.content) || []) {
        if (b.type === 'tool_use') console.log(ts(), 'tool_use', b.name, b.id, `run_in_background=${!!(b.input && b.input.run_in_background)}`);
      }
    } else if (m.type === 'user' && !m.parent_tool_use_id) {
      for (const b of (m.message && m.message.content) || []) {
        if (b.type === 'tool_result') console.log(ts(), 'tool_result', b.tool_use_id, JSON.stringify(b.content).slice(0, 100));
      }
    } else if (m.type === 'result') {
      console.log(ts(), 'result', m.subtype, `is_error=${m.is_error}`);
      child.stdin.end();
    }
  }
});
child.on('exit', (code) => { console.log(ts(), 'exit', code); clearTimeout(guard); });
const guard = setTimeout(() => { console.log(ts(), 'gave up after 180 s'); child.kill(); }, 180000);
