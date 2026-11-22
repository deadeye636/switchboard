// Measure a CLI's MCP tool-call timeout (#808, spec 41 P3/P4): a stub MCP server (streamable HTTP, JSON answers) with one
// tool, `sleep`, that answers after N seconds. It logs when a `tools/call` arrives, when the client closes the request
// before the answer, and any `notifications/cancelled`, so the timeout is read off the log. It never starts a CLI itself.
//
// Usage: node scripts/measure-mcp-tool-timeout.js <port> <logfile> [<token>]
//   With a token, every request without `Authorization: Bearer <token>` is answered 401 (and logged), as the app's own
//   endpoint does. Then, from an empty project folder, one turn on the CLI's smallest model asking for `sleep` with
//   seconds above the expected limit (620 was used):
//   Codex (one command line, wrapped here):
//     SLEEPSTUB_TOKEN=<token> codex exec --skip-git-repo-check -s read-only -m <model>
//       -c 'mcp_servers.sleepstub.url="http://127.0.0.1:<port>/mcp"'
//       -c 'mcp_servers.sleepstub.bearer_token_env_var="SLEEPSTUB_TOKEN"' "<prompt>"
//   agy:    a workspace plugin bundle as src/backends/agy/mcp-inject.js writes it (`.agents/plugins.json`, a bundle with
//           `plugin.json` and `mcp_config.json` naming the url and the Authorization header), then, as one command line:
//           agy --model <model> --output-format stream-json
//             --settings '{"permissions":{"allow":["mcp(<bundle>_sleepstub/sleep)"]}}' -p "<prompt>"
//           (headless agy denies an MCP call without an allow rule; `--settings` is for that session only).
// The last measurement is in `docs/specs/41-task-sessions.md` ("Measured: MCP tool-call timeouts").
'use strict';
const http = require('http');
const fs = require('fs');

const port = Number(process.argv[2] || 47811);
const logFile = process.argv[3] || 'stub.log';
const token = process.argv[4] || '';
const t0 = Date.now();
function log(msg) {
  const line = `${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`;
  fs.appendFileSync(logFile, line + '\n');
  console.log(line);
}

const TOOL = {
  name: 'sleep',
  description: 'Waits the given number of seconds, then answers "slept N s". Used to measure a timeout.',
  inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
};

http.createServer((req, res) => {
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    log(`401 ${req.method} ${req.url} auth=${req.headers.authorization ? 'wrong' : 'none'}`);
    res.writeHead(401); res.end(); return;
  }
  if (req.method !== 'POST') { log(`${req.method} ${req.url} -> 405`); res.writeHead(405); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'stub-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.id === undefined) {
      log(`notification ${msg.method} ${JSON.stringify(msg.params || {})}`);
      res.writeHead(202); res.end(); return;
    }
    log(`request ${msg.method} id=${msg.id}`);
    if (msg.method === 'initialize') {
      return reply({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'sleepstub', version: '1.0.0' } });
    }
    if (msg.method === 'tools/list') return reply({ tools: [TOOL] });
    if (msg.method === 'tools/call') {
      const secs = Number(msg.params && msg.params.arguments && msg.params.arguments.seconds) || 0;
      const started = Date.now();
      log(`call sleep(${secs}) id=${msg.id} started`);
      let done = false;
      res.on('close', () => {
        if (!done) log(`call id=${msg.id} CLIENT CLOSED after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      });
      setTimeout(() => {
        done = true;
        if (res.destroyed || res.writableEnded) { log(`call id=${msg.id} finished at ${secs}s, nobody listening`); return; }
        log(`call id=${msg.id} answered after ${((Date.now() - started) / 1000).toFixed(1)}s`);
        reply({ content: [{ type: 'text', text: `slept ${secs} s` }] });
      }, secs * 1000);
      return;
    }
    if (msg.method === 'ping') return reply({});
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }));
  });
}).listen(port, '127.0.0.1', () => log(`listening on ${port}`));
