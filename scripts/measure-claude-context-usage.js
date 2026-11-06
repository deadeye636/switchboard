// Measure what `get_context_usage` answers in a pipe session around its first turn (#758): before any prompt, just
// after one was sent, and after its result. It prints the total, `apiUsage`, the message breakdown, the categories and
// how many rows each list holds. Counts only: nothing it prints names a path or the conversation. It costs one short
// model turn, or none with `--no-turn`.
//
// Usage: node scripts/measure-claude-context-usage.js [--no-turn] [--wait=<seconds>] [<model>]
//   Run it from the directory the session should start in, one you trust: Windows looks up the bare `claude` there first.
//   --wait     seconds before the first question. MCP servers connect after the start, so an early answer has no MCP
//              categories or tools.
//   <model>    defaults to `haiku`.
// The last measurement is in `docs/specs/32-claude-native.md` ("The session's figures").
'use strict';

const { spawn } = require('child_process');

const args = process.argv.slice(2);
const noTurn = args.includes('--no-turn');
const waitArg = args.find((a) => a.startsWith('--wait='));
const waitMs = waitArg ? (Number(waitArg.slice('--wait='.length)) || 0) * 1000 : 0;
const model = args.find((a) => !a.startsWith('--')) || 'haiku';

const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio', '--no-session-persistence', '--model', model], { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (err) => { console.error(`could not start claude: ${err.code}`); process.exit(1); });
const timer = setTimeout(() => { console.error('no answer after 120 s'); child.kill(); }, 120000 + waitMs);

const ask = (id) => child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'get_context_usage' } })}\n`);
const finish = () => { clearTimeout(timer); child.stdin.end(); child.kill(); };

function report(id, r) {
  const { toolCallsByType, attachmentsByType, ...messages } = r.messageBreakdown || {};
  console.log(`--- ${id}: total ${r.totalTokens} of ${r.maxTokens}, model ${r.model}`);
  console.log(`apiUsage ${JSON.stringify(r.apiUsage)}`);
  console.log(`messages ${JSON.stringify(messages)}`);
  console.log(`categories ${(r.categories || []).map((c) => `${c.id}:${c.tokens}:${c.kind}`).join(' ')}`);
  console.log(`rows memoryFiles:${(r.memoryFiles || []).length} agents:${(r.agents || []).length} `
    + `skills:${((r.skills && r.skills.skillFrontmatter) || []).length} mcpTools:${(r.mcpTools || []).length}`);
}

let buffered = '';
child.stdout.on('data', (chunk) => {
  buffered += chunk;
  let end;
  while ((end = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'result') ask('after');
    if (m.type !== 'control_response' || !m.response) continue;
    const id = m.response.request_id;
    report(id, m.response.response || m.response);
    if (id === 'after' || noTurn) finish();
    else if (id === 'before') {
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Answer with the single word: ok' } })}\n`);
      setTimeout(() => ask('during'), 300);
    }
  }
});

setTimeout(() => ask('before'), waitMs);
