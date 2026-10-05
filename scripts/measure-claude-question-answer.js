// Measure how Claude Code reports an answered AskUserQuestion over claude-native's pipe (#724). It starts one
// short `claude -p` session with the flags claude-native uses, asks the model to call AskUserQuestion with two
// questions, answers them the way the question card does (an allow whose `updatedInput` carries `answers` and
// a note in `annotations`), and prints:
//   1. the keys of the stream's user line that carries the call's result, its `tool_use_result` and its uuid;
//   2. the `toolUseResult` and uuid of the same line in the transcript Claude wrote.
// It costs one short model turn. Nothing it prints names a path; the session's own prompt is the only content.
//
// Usage: node scripts/measure-claude-question-answer.js <cwd> [<model>]
//   <cwd>    a scratch directory the session runs in (created if missing), e.g. under the demo directory.
//   <model>  defaults to `haiku`.
// The transcript is read from `$CLAUDE_CONFIG_DIR/projects` when that is set, else `~/.claude/projects`.
// The last measurement is in `docs/specs/32-claude-native.md` (Approvals and questions, #724).
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cwd = process.argv[2];
if (!cwd) {
  console.error('usage: node scripts/measure-claude-question-answer.js <cwd> [<model>]');
  process.exit(2);
}
const model = process.argv[3] || 'haiku';
fs.mkdirSync(cwd, { recursive: true });

const sessionId = crypto.randomUUID();
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--replay-user-messages', '--permission-prompt-tool', 'stdio', `--session-id=${sessionId}`, '--model', model];
const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const write = (o) => child.stdin.write(JSON.stringify(o) + '\n');

// The card's answer: the first option of a single choice, the first two of a multi-select, a note on the first.
function answerOf(input) {
  const answers = {};
  const annotations = {};
  (Array.isArray(input.questions) ? input.questions : []).forEach((q, n) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    answers[q.question] = q.multiSelect ? opts.slice(0, 2).map(o => o.label).join(', ') : (opts[0] || {}).label;
    if (n === 0) annotations[q.question] = { notes: 'a note from the probe' };
  });
  return { ...input, answers, annotations };
}

const seen = [];
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
    seen.push(m);
    if (m.type === 'control_request' && m.request && m.request.subtype === 'can_use_tool') {
      const asks = m.request.tool_name === 'AskUserQuestion';
      write({ type: 'control_response', response: { subtype: 'success', request_id: String(m.request_id),
        response: asks ? { behavior: 'allow', updatedInput: answerOf(m.request.input || {}) } : { behavior: 'deny', message: 'Not part of this probe.' } } });
    }
    if (m.type === 'result') child.stdin.end();
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('error', (err) => { console.error(`could not start claude: ${err.code || err.message}`); process.exit(1); });
child.on('exit', () => {
  for (const m of seen) {
    const c = m.type === 'user' && m.message && m.message.content;
    if (!Array.isArray(c) || !c.some(b => b && b.type === 'tool_result')) continue;
    console.log('stream user line keys:', Object.keys(m).sort().join(','));
    console.log('stream tool_use_result:', JSON.stringify(m.tool_use_result));
    console.log('stream uuid:', m.uuid);
  }
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const folder = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const file = path.join(home, 'projects', folder, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) { console.log('transcript: not found under the projects folder for <cwd>'); return; }
  for (const s of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!s.includes('"toolUseResult"')) continue;
    const l = JSON.parse(s);
    console.log('transcript uuid:', l.uuid);
    console.log('transcript toolUseResult:', JSON.stringify(l.toolUseResult));
  }
});

write({ type: 'user', parent_tool_use_id: null, session_id: '', message: { role: 'user', content:
  'Call the AskUserQuestion tool exactly once with two questions: "Pick a colour" (options Red, Blue; single choice) '
  + 'and "Pick fruits" (options Apple, Pear, Plum; multiSelect true). After the answer, reply with one word: done.' } });
