// A stand-in for `pi --mode rpc` (#568): reads one JSON command per line, answers the way Pi 0.84.4 was
// measured to answer, and plays one short turn per prompt. Used by test/agent-rpc.test.js so the pipe, the
// framing and the exit path are exercised against a real child process rather than a mock of one.
'use strict';

const SESSION_ID = 'fake-session';
const messages = [];
let buf = '';

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function turn(text) {
  const user = { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'pong' }], stopReason: 'stop', timestamp: 2 };
  out({ type: 'agent_start' });
  out({ type: 'message_start', message: user });
  out({ type: 'message_end', message: user });
  out({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'po' } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ng' } });
  out({ type: 'message_end', message: assistant });
  messages.push(user, assistant);
  out({ type: 'agent_end', messages: [user, assistant] });
  out({ type: 'agent_settled' });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    switch (cmd.type) {
      case 'get_state':
        out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { sessionId: SESSION_ID, isStreaming: false } });
        break;
      case 'get_messages':
        out({ id: cmd.id, type: 'response', command: 'get_messages', success: true, data: { messages } });
        break;
      case 'prompt':
        out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        if (cmd.message === 'ask me') {
          out({ type: 'extension_ui_request', id: 'q1', method: 'select', title: 'Allow bash?', options: ['Allow once', 'Refuse'] });
        } else {
          turn(cmd.message);
        }
        break;
      case 'extension_ui_response':
        out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `answered ${cmd.value}` }], stopReason: 'stop', timestamp: 3 } });
        break;
      case 'abort':
        out({ id: cmd.id, type: 'response', command: 'abort', success: true });
        break;
      default:
        out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'unknown' });
    }
  }
});
