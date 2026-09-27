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
//   '/cost'   a local command: an assistant line whose model is `<synthetic>`
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
  const user = { type: 'user', uuid: uuid(), message: { role: 'user', content: text } };
  record(user);
  emit({ ...user, isReplay: true, parent_tool_use_id: null });
  if (text === '/cost') { assistantBlock({ type: 'text', text: 'Total cost: $0.00' }, '<synthetic>'); finish(); return; }
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
      const response = sub === 'initialize' ? { commands: [{ name: 'compact', description: 'Clear the conversation  but keep a summary', argumentHint: '' }] }
        : sub === 'interrupt' ? { still_queued: [] } : {};
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
