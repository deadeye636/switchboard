// A stand-in for `pi --mode rpc` (#568): reads one JSON command per line, answers the way Pi 0.84.4 was
// measured to answer, and plays one short turn per prompt. Used by test/agent-rpc.test.js so the pipe, the
// framing and the exit path are exercised against a real child process rather than a mock of one.
'use strict';

const { ASK_PREFIX, DISMISS_PREFIX, STATS_PREFIX, EXPORT_PREFIX, COPY_PREFIX, SHELL_PREFIX, COMPLETE_COMMAND, COMPLETIONS_PREFIX } = require('../../src/backends/pi-native/session-commands');

const SESSION_ID = 'fake-session';
const messages = [];
let buf = '';
let runningBash = null;   // { id, printed } of a shell line waiting to be stopped

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
      case 'get_commands':
        out({ id: cmd.id, type: 'response', command: 'get_commands', success: true, data: { commands: [
          { name: 'model', description: 'Switch the model', source: 'extension' },
          { name: COMPLETE_COMMAND, description: 'internal', source: 'extension' },
          { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt', location: 'project' },
          { name: 'skill:search', description: 'Search the web', source: 'skill' },
        ] } });
        break;
      case 'prompt':
        if (cmd.message.startsWith('/' + COMPLETE_COMMAND + ' ')) {
          // As measured: the extension command says its answer, THEN Pi answers the prompt.
          const req = JSON.parse(cmd.message.slice(COMPLETE_COMMAND.length + 2));
          out({ type: 'extension_ui_request', id: 'c-' + req.token, method: 'notify', message: COMPLETIONS_PREFIX + JSON.stringify({ token: req.token, items: [{ value: 'openai-codex/gpt-5.6-sol', description: 'GPT 5.6 (current)' }] }) });
          out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
          break;
        }
        out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        if (cmd.message === 'ask me') {
          out({ type: 'extension_ui_request', id: 'q1', method: 'select', title: 'Allow bash?', options: ['Allow once', 'Refuse'] });
        } else if (cmd.message === 'command ask') {
          // A question one of pi-native's own commands asks (#642): outside any run, and marked as such.
          out({ type: 'extension_ui_request', id: 'c1', method: 'select', title: ASK_PREFIX + JSON.stringify({ title: 'Pick', token: 't1' }), options: ['a', 'b'] });
        } else if (cmd.message === '/session') {
          // As measured for the completion command above: the extension command says its word, THEN Pi
          // answers the prompt. The word carries no figures — the client asks for those itself (#643).
          out({ type: 'extension_ui_request', id: 'n2', method: 'notify', message: STATS_PREFIX });
        } else if (cmd.message.startsWith('/export')) {
          // Same shape again: the command says what was typed after it and nothing more.
          out({ type: 'extension_ui_request', id: 'n3', method: 'notify', message: EXPORT_PREFIX + JSON.stringify({ args: cmd.message.slice('/export'.length).trim() }) });
        } else if (cmd.message === '/copy') {
          out({ type: 'extension_ui_request', id: 'n4', method: 'notify', message: COPY_PREFIX });
        } else if (cmd.message.startsWith('!')) {
          // Stands in for the runtime extension's `input` hook: a `!` line is answered with the marker and
          // never reaches the model.
          out({ type: 'extension_ui_request', id: 'n5', method: 'notify', message: SHELL_PREFIX + JSON.stringify({ command: cmd.message.slice(1).trim() }) });
        } else if (cmd.message === 'take it back') {
          // Pi stopped waiting on that question (a login's browser callback won), and the command says so.
          out({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: DISMISS_PREFIX + JSON.stringify({ token: 't1' }) });
        } else {
          turn(cmd.message);
        }
        break;
      case 'extension_ui_response':
        out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `answered ${cmd.value}` }], stopReason: 'stop', timestamp: 3 } });
        break;
      case 'get_session_stats':
        out({ id: cmd.id, type: 'response', command: 'get_session_stats', success: true, data: {
          sessionFile: undefined, sessionId: SESSION_ID,
          userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
          tokens: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, total: 150 },
          cost: 0.0021,
        } });
        break;
      case 'export_html':
        // Measured on Pi 0.85.1: the path it was given is echoed back, and an empty session is refused
        // with a sentence of Pi's own rather than an errno.
        if (!messages.length) { out({ id: cmd.id, type: 'response', command: 'export_html', success: false, error: 'Nothing to export yet - start a conversation first' }); break; }
        out({ id: cmd.id, type: 'response', command: 'export_html', success: true, data: { path: cmd.outputPath } });
        break;
      case 'get_last_assistant_text': {
        const last = [...messages].reverse().find(m => m.role === 'assistant');
        const text = last ? last.content.map(c => c.text).join('') : null;
        out({ id: cmd.id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text } });
        break;
      }
      case 'bash': {
        // `slow …` waits for abort_bash and answers nothing until then, which is how a long command
        // behaves; anything else streams one chunk and finishes, the way Pi was measured to.
        out({ type: 'bash_execution_update', id: cmd.id, delta: `ran ${cmd.command}\n` });
        if (/^slow\b/.test(String(cmd.command || ''))) { runningBash = { id: cmd.id, printed: `ran ${cmd.command}\n` }; break; }
        out({ id: cmd.id, type: 'response', command: 'bash', success: true, data: { output: `ran ${cmd.command}\n`, exitCode: 0, cancelled: false, truncated: false } });
        break;
      }
      case 'abort_bash':
        out({ id: cmd.id, type: 'response', command: 'abort_bash', success: true });
        if (runningBash) {
          // As measured on Pi 0.85.1: a stopped line KEEPS what it had already printed. An empty answer
          // means the command had printed nothing yet, not that the output was discarded.
          out({ id: runningBash.id, type: 'response', command: 'bash', success: true, data: { output: runningBash.printed, cancelled: true, truncated: false } });
          runningBash = null;
        }
        break;
      case 'abort':
        // As measured on Pi 0.85.1: an abort answers success and leaves a running shell line alone.
        out({ id: cmd.id, type: 'response', command: 'abort', success: true });
        break;
      default:
        out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'unknown' });
    }
  }
});
