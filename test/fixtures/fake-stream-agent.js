'use strict';
// A stand-in for a runtime that is driven over a stream rather than over request/response RPC (#657): it
// does NOT answer a turn line, cannot be asked which session it is on or what its conversation is, ANNOUNCES
// a move of its own, answers control requests under a `request_id`, and writes its conversation to a
// transcript file that the app reads back. Nothing here is any real CLI's format; the protocol half that
// speaks it lives in `test/agent-rpc-stream.test.js`.
//
// Environment:
//   FAKE_TRANSCRIPT   the file the conversation is written to (one JSON entry per line)
//   FAKE_LAG=1        the assistant's reply reaches the pipe but not the file (a file one entry behind)
//   FAKE_IGNORE_EOF=1 a closed stdin is ignored, so only a kill ends the process
const fs = require('fs');

const file = process.env.FAKE_TRANSCRIPT || '';
const lag = process.env.FAKE_LAG === '1';
let n = 0;

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const record = (entry) => { if (file) fs.appendFileSync(file, JSON.stringify(entry) + '\n'); };
const entry = (role, text) => ({ uuid: `e${++n}`, type: role, message: { role, content: [{ type: 'text', text }] } });

function turn(text) {
  const user = entry('user', text);
  record(user);
  emit({ ev: 'append', entry: user });
  if (text === 'rename') emit({ ev: 'identity', id: 'renamed-session' });
  if (text === 'replace') { emit({ ev: 'reset' }); emit({ ev: 'result' }); return; }
  if (text === 'ask me') { emit({ ev: 'ask', id: 'a1', input: { path: 'x.txt' } }); return; }
  const reply = entry('assistant', `echo: ${text}`);
  if (!lag) record(reply);
  emit({ ev: 'append', entry: reply });
  emit({ ev: 'result' });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'user') turn(String(msg.text || ''));
    else if (msg.type === 'ctl') {
      if (msg.what === 'fail') emit({ type: 'ctl_response', request_id: msg.request_id, ok: false, error: 'nope' });
      else emit({ type: 'ctl_response', request_id: msg.request_id, ok: true, data: { what: msg.what } });
    } else if (msg.type === 'answer') {
      const reply = entry('assistant', `answered with ${JSON.stringify(msg.echoed)}`);
      record(reply);
      emit({ ev: 'append', entry: reply });
      emit({ ev: 'result' });
    }
  }
});
// A closed stdin is the request to stop: the last line is written to the file first, as a runtime that
// flushes its transcript on the way out would, and then the process leaves by itself.
process.stdin.on('end', () => {
  if (process.env.FAKE_IGNORE_EOF === '1') { setInterval(() => {}, 1000); return; }
  setTimeout(() => { if (file) fs.appendFileSync(file, JSON.stringify({ uuid: 'flushed', type: 'marker' }) + '\n'); process.exit(0); }, 200);
});
