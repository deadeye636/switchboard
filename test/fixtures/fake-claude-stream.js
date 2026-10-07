'use strict';
// A stand-in for `claude -p --input-format stream-json --output-format stream-json` (#660): the line shapes
// Claude Code 2.1.283 was measured writing, reduced to what `src/backends/claude-native/rpc-protocol.js` reads.
// It answers no turn line, replays the user's own line when its turn STARTS, opens every turn with a
// `system/init`, queues a line written while a turn runs, answers control requests under their `request_id`,
// asks for an approval over the control channel, and writes its user and assistant lines to a transcript under
// the same uuid it sends them with. An `interrupt` while a turn runs ends that turn the way the real CLI does:
// answered at once, then a `result` with `error_during_execution` and a diagnostic line.
//
// Environment:
//   FAKE_TRANSCRIPT_DIR  the directory the transcript goes in (`<session id>.jsonl`)
//   FAKE_SESSION         the id the session starts under
//   FAKE_TURN_MS         how long a turn takes before its reply (default 0)
//
// Turn texts that do something else:
//   'tool'    the reply calls a tool that needs an approval, and runs it once allowed
//   '/clear'  the conversation is reset and continues under a new id, as Claude's /clear does
//   '/cost'   a local command: not played back, answered by an assistant line whose model is `<synthetic>`
//   'agent'   the reply runs one foreground agent: its `task_started`, a `task_updated` that ends it and its
//             `task_notification` (#768, #769, measured on 2.1.293); 'agent-hang' starts one and then exits;
//             'agent-start' / 'agent-end' start and end a background agent in two turns
//
// Control requests answered with something: `initialize` (the command list), `interrupt`, and `mcp_status` (two
// servers, one with a `config` carrying a secret the app must not pass on), and the server actions of #728
// (`mcp_reconnect`, `mcp_toggle`, `mcp_authenticate`, `mcp_clear_auth`) for those two names.
const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_TRANSCRIPT_DIR || '';
let session = process.env.FAKE_SESSION || 'sess-1';
const turnMs = Number(process.env.FAKE_TURN_MS) || 0;
let n = 0;
let busy = false;
const queue = [];
let waitingApproval = null;
let turnTimer = null;

const emit = (obj) => process.stdout.write(JSON.stringify({ session_id: session, ...obj }) + '\n');
const record = (line) => { if (dir) fs.appendFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({ ...line, sessionId: session, entrypoint: 'sdk-switchboard' }) + '\n'); };
const uuid = () => `u${++n}`;

function assistantBlock(block, model) {
  const line = { type: 'assistant', uuid: uuid(), message: { role: 'assistant', model: model || 'fake', content: [block] } };
  record(line);
  emit({ ...line, parent_tool_use_id: null });
}

function streamText(text) {
  emit({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent_tool_use_id: null });
  assistantBlock({ type: 'text', text });
  emit({ type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null });
}

function finish() {
  emit({ type: 'result', subtype: 'success', is_error: false, result: '' });
  busy = false;
  if (queue.length) setImmediate(() => start(queue.shift()));
}

function start(text) {
  busy = true;
  if (text === '/clear') {
    emit({ type: 'conversation_reset' });
    session = `${session}-cleared`;
    emit({ type: 'system', subtype: 'init' });
    finish();
    return;
  }
  emit({ type: 'system', subtype: 'init' });
  // A local command is not played back (#718, measured on 2.1.284): the transcript keeps the typed command as
  // `<command-name>` markup and the output as a `system/local_command` line under the synthetic line's uuid.
  if (text.trim() === '/cost') {
    record({ type: 'user', uuid: uuid(), message: { role: 'user', content: '<command-name>/cost</command-name>\n            <command-message>cost</command-message>\n            <command-args></command-args>' } });
    const out = uuid();
    record({ type: 'system', subtype: 'local_command', uuid: out, content: '<local-command-stdout>Total cost: $0.00</local-command-stdout>' });
    emit({ type: 'assistant', uuid: out, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Total cost: $0.00' }] }, parent_tool_use_id: null });
    finish();
    return;
  }
  const user = { type: 'user', uuid: uuid(), message: { role: 'user', content: text } };
  record(user);
  emit({ ...user, isReplay: true, parent_tool_use_id: null });
  // A background agent that outlives its turn: 'agent-start' starts it, 'agent-end' ends it (#769).
  if (text === 'agent-start' || text === 'agent-end') {
    emit(text === 'agent-start'
      ? { type: 'system', subtype: 'task_started', task_id: 'agent-bg', description: 'Long', is_backgrounded: true, task_type: 'local_agent' }
      : { type: 'system', subtype: 'task_updated', task_id: 'agent-bg', patch: { status: 'completed' } });
    streamText('ok');
    finish();
    return;
  }
  if (text === 'agent' || text === 'agent-hang') {
    assistantBlock({ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'verifier', description: 'Review' } });
    emit({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_a', description: 'Review', subagent_type: 'verifier', is_backgrounded: false, task_type: 'local_agent' });
    if (text === 'agent-hang') { setTimeout(() => process.exit(0), 50); return; }
    setTimeout(() => {
      emit({ type: 'system', subtype: 'task_updated', task_id: 'agent-1', patch: { status: 'completed' } });
      emit({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', tool_use_id: 'toolu_a', status: 'completed', summary: 'ok' });
      streamText('finished');
      finish();
    }, 50);
    return;
  }
  if (text === 'tool') {
    assistantBlock({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } });
    waitingApproval = 'perm-1';
    emit({ type: 'control_request', request_id: waitingApproval, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'echo hi' }, description: 'Say hi' } });
    return;
  }
  turnTimer = setTimeout(() => { turnTimer = null; streamText(`echo: ${text}`); finish(); }, turnMs);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (msg.type === 'user') {
      const text = String(msg.message && msg.message.content);
      if (busy) queue.push(text);
      else start(text);
    } else if (msg.type === 'control_request') {
      const sub = msg.request && msg.request.subtype;
      // #728: a server action names its server; an unknown one is refused with the CLI's own sentence.
      if (['mcp_reconnect', 'mcp_toggle', 'mcp_authenticate', 'mcp_clear_auth'].includes(sub)) {
        const known = ['docs', 'remote'].includes(msg.request.serverName);
        emit({ type: 'control_response', response: known
          ? { subtype: 'success', request_id: msg.request_id, response: sub === 'mcp_authenticate' ? { authUrl: 'https://auth.example.invalid/authorize?state=s', requiresUserAction: true } : {} }
          : { subtype: 'error', request_id: msg.request_id, error: `Server not found: ${msg.request.serverName}` } });
        continue;
      }
      const response = sub === 'initialize' ? { commands: [{ name: 'compact', description: 'Clear the conversation  but keep a summary', argumentHint: '' }] }
        : sub === 'interrupt' ? { still_queued: [] }
          : sub === 'mcp_status' ? { mcpServers: [
            { name: 'docs', status: 'connected', scope: 'user', source: 'user', tools: [{ name: 'read' }, { name: 'write' }], config: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'secret-token' } } },
            { name: 'remote', status: 'failed', error: 'getaddrinfo ENOTFOUND example.invalid', scope: 'project', source: 'project', config: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer secret-token' } } },
          ] } : {};
      emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
      if (sub === 'interrupt' && turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
        emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], result: '' });
        busy = false;
        if (queue.length) setImmediate(() => start(queue.shift()));
      }
    } else if (msg.type === 'control_response' && waitingApproval && msg.response && msg.response.request_id === waitingApproval) {
      waitingApproval = null;
      const r = msg.response.response || {};
      const allowed = r.behavior === 'allow';
      const result = { type: 'user', uuid: uuid(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: allowed ? `ran ${JSON.stringify(r.updatedInput)}` : r.message, is_error: !allowed }] } };
      record(result);
      emit({ ...result, parent_tool_use_id: null });
      streamText(allowed ? 'done' : 'refused');
      finish();
    }
  }
});
