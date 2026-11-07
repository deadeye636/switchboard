// Measure whether a pipe session's first turn waits for an MCP server that is still connecting (#758 follow-up). It
// starts one throwaway stdio server that answers `initialize` only after a delay, starts `claude` with that server
// alone (`--strict-mcp-config`), and sends the first prompt at once. It prints, in seconds from the start: when the
// server was asked and when it answered, what `mcp_status` said over time, what the `init` message listed, when the
// first assistant message and the result came, and whether the model saw the server's tool. Nothing it prints names a
// path, a user server or the conversation. It costs one short model turn.
//
// Usage: node scripts/measure-claude-mcp-first-turn.js [<delaySeconds>] [<model>]
//   Run it from the directory the session should start in, one you trust: Windows looks up the bare `claude` there first.
//   <delaySeconds>  how long the server holds back its `initialize` answer, default 20. 0 is the control run.
//   <model>         defaults to `haiku`.
// The last measurement is in `docs/specs/32-claude-native.md` ("The session's figures").
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const delaySeconds = Number(process.argv[2] ?? 20);
const model = process.argv[3] || 'haiku';
const POLL_MS = 500;

// The server: newline-delimited JSON-RPC on stdio, one tool. It writes when it was asked and when it answered to a
// log beside it, because its stderr belongs to claude.
const STUB = `'use strict';
const fs = require('fs');
const [, , delayMs, logFile] = process.argv;
const note = (what) => fs.appendFileSync(logFile, JSON.stringify({ what, at: Date.now() }) + '\\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let end;
  while ((end = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, end); buf = buf.slice(end + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      note('initialize');
      setTimeout(() => { note('initialized'); reply(m.id, { protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1.0.0' } }); }, Number(delayMs));
    } else if (m.method === 'tools/list') {
      reply(m.id, { tools: [{ name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} } }] });
    } else if (m.id !== undefined && m.method) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }) + '\\n');
    }
  }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-first-turn-'));
const stubFile = path.join(dir, 'stub.js');
const logFile = path.join(dir, 'stub.log');
const configFile = path.join(dir, 'mcp.json');
fs.writeFileSync(stubFile, STUB);
fs.writeFileSync(logFile, '');
fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { slow: {
  type: 'stdio', command: process.execPath, args: [stubFile, String(delaySeconds * 1000), logFile] } } }));

function cleanUp() {
  for (const f of [stubFile, logFile, configFile]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  try { fs.rmdirSync(dir); } catch { /* not empty or gone */ }
}

const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio', '--no-session-persistence', '--model', model,
  '--mcp-config', configFile, '--strict-mcp-config'], { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (err) => { console.error(`could not start claude: ${err.code}`); cleanUp(); process.exit(1); });

const started = Date.now();
const secs = (t) => `${((t - started) / 1000).toFixed(1)}s`;
const at = () => secs(Date.now());
const send = (line) => child.stdin.write(`${JSON.stringify(line)}\n`);
const control = (id, subtype) => send({ type: 'control_request', request_id: id, request: { subtype } });

let lastStatus = '';
let polling = true;
let answer = '';
const timer = setTimeout(() => { console.error('no end after 180 s'); finish(); }, 180000);

function finish() {
  polling = false;
  clearTimeout(timer);
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line);
    console.log(`${secs(e.at)} server: ${e.what}`);
  }
  console.log(`answer: ${JSON.stringify(answer.trim().slice(0, 40))}`);
  try { child.stdin.end(); } catch { /* closed */ }
  child.kill();
  cleanUp();
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
    if (m.type === 'system' && m.subtype === 'init') {
      const servers = (m.mcp_servers || []).map((s) => s.status).join(',') || 'none';
      const tool = (m.tools || []).some((t) => /slow.*ping/.test(t));
      console.log(`${at()} init: servers [${servers}], ping tool listed: ${tool}`);
    }
    if (m.type === 'assistant') {
      for (const c of (m.message && m.message.content) || []) if (c.type === 'text') answer += c.text;
      console.log(`${at()} assistant message`);
    }
    if (m.type === 'result') { console.log(`${at()} result (${m.subtype})`); finish(); }
    if (m.type === 'control_response' && m.response && m.response.request_id === 'servers' && polling) {
      const r = m.response.response || m.response;
      const status = (r.mcpServers || []).map((s) => s.status).join(',') || 'none';
      if (status !== lastStatus) { console.log(`${at()} mcp_status: [${status}]`); lastStatus = status; }
      setTimeout(() => { if (polling) control('servers', 'mcp_status'); }, POLL_MS);
    }
  }
});

control('servers', 'mcp_status');
send({ type: 'user', message: { role: 'user', content:
  'Is there a tool whose name contains both "slow" and "ping" in your tool list right now? Answer only yes or no.' } });
