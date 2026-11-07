// Measure when a pipe session's MCP servers have settled, and what `get_context_usage` answers around that (#758): at
// the start, once `mcp_status` names no server `pending`, after one short turn, and after `/clear`. It prints timings
// and counts only: nothing it prints names a path, a server or the conversation. It costs one short model turn.
//
// Usage: node scripts/measure-claude-mcp-settle.js [<model>]
//   Run it from the directory the session should start in, one you trust: Windows looks up the bare `claude` there first.
//   <model>  defaults to `haiku`.
// The last measurement is in `docs/specs/32-claude-native.md` ("The session's figures").
'use strict';

const { spawn } = require('child_process');

const model = process.argv[2] || 'haiku';
const POLL_MS = 500;
const MAX_POLLS = 120;

const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio', '--no-session-persistence', '--model', model], { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (err) => { console.error(`could not start claude: ${err.code}`); process.exit(1); });

const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const send = (line) => child.stdin.write(`${JSON.stringify(line)}\n`);
const control = (id, subtype) => send({ type: 'control_request', request_id: id, request: { subtype } });
const prompt = (content) => send({ type: 'user', message: { role: 'user', content } });
const timer = setTimeout(() => { console.error('no end after 180 s'); child.kill(); }, 180000);

function fill(id, r) {
  const m = r.messageBreakdown || {};
  console.log(`${at()} ${id}: total ${r.totalTokens}, apiUsage ${JSON.stringify(r.apiUsage)}, user ${m.userMessageTokens}, `
    + `assistant ${m.assistantMessageTokens}, attachments ${m.attachmentTokens}, mcpTools ${(r.mcpTools || []).length}`);
}

let polls = 0;
let stage = 'servers';

function answered(id, r) {
  if (id === 'servers') {
    const servers = r.mcpServers || [];
    const counts = {};
    for (const s of servers) counts[s.status] = (counts[s.status] || 0) + 1;
    polls += 1;
    // An empty list is waited on here, because a server may not be listed yet; the core reads it as nothing to wait for.
    const settled = servers.length && !servers.some((s) => s.status === 'pending');
    if (!settled && polls < MAX_POLLS) {
      setTimeout(() => control('servers', 'mcp_status'), POLL_MS);
      return;
    }
    console.log(`${at()} ${settled ? 'settled' : 'gave up'} after ${polls} looks: ${JSON.stringify(counts)}`);
    control('settled', 'get_context_usage');
    return;
  }
  fill(id, r);
  if (id === 'settled') { stage = 'turn'; prompt('Answer with the single word: ok'); }
  if (id === 'after-turn') {
    stage = 'clear';
    prompt('/clear');
  }
  if (id === 'after-clear') { clearTimeout(timer); child.stdin.end(); child.kill(); }
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
    if (m.type === 'result' && stage === 'turn') { stage = 'turned'; control('after-turn', 'get_context_usage'); }
    if (m.type === 'result' && stage === 'clear') { stage = 'cleared'; control('after-clear', 'get_context_usage'); }
    if (m.type === 'control_response' && m.response) answered(m.response.request_id, m.response.response || m.response);
  }
});

control('start', 'get_context_usage');
control('servers', 'mcp_status');
