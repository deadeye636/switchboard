'use strict';
// #755 T3/T4 — the backends stamp the neutral `document` element into a `Read` result. Claude: history
// (`normalizeTranscriptEntries`), live (the decoder) and attach (`conversationEntries`) must give the same
// element; Pi: history and the one-message-at-a-time decoder, with a relative path made absolute. The core's
// `documentPathsOf` must find the element where the backends put it.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const claudeView = require('../src/backends/claude/transcript-view');
const claudeProtocol = require('../src/backends/claude-native/rpc-protocol');
const piView = require('../src/backends/pi/transcript-view');
const piProtocol = require('../src/backends/pi-native/rpc-protocol');
const { documentPathsOf } = require('../src/app/documents');
const { isDocumentElement } = require('../src/backends/document-ref');

const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } };

const call = (id, name, input) => ({
  type: 'assistant', uuid: `a-${id}`,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id, content, extra = {}) => ({
  type: 'user', uuid: `u-${id}`,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
});

const resultContent = (entry) => entry.message.content[0].content;
const elementsOf = (entry) => (Array.isArray(resultContent(entry)) ? resultContent(entry) : []).filter(c => c && c.type === 'document' && c.path);

// All three Claude paths over one conversation, so a difference between them is the failure.
function claudeAll(lines) {
  const history = claudeView.normalizeTranscriptEntries(lines);
  const d = claudeProtocol.createDecoder();
  const live = lines.flatMap(l => d.decode(l)).filter(o => o.op === 'append').map(o => o.entry);
  const attach = claudeProtocol.conversationEntries(lines);
  return { history, live, attach };
}
const lastOf = (list) => list[list.length - 1];

// Verifier L1: an image-kind file Claude reads back as text (an `.svg`) holds no picture, so no card.
test('claude: an svg read back as text gets no element', () => {
  const { history, live, attach } = claudeAll([call('t1', 'Read', { file_path: '/home/user/logo.svg' }), result('t1', '1\t<svg/>')]);
  for (const list of [history, live, attach]) assert.deepEqual(elementsOf(lastOf(list)), []);
});

test('claude: PDF read with pages -> element with the page image count, images kept after it', () => {
  const blocks = [{ type: 'text', text: 'PDF pages extracted: 2 page(s) from /home/user/x.pdf' }, IMG, IMG];
  const lines = [call('t1', 'Read', { file_path: '/home/user/x.pdf', pages: '1-2' }), result('t1', blocks)];
  const { history, live, attach } = claudeAll(lines);
  for (const entry of [lastOf(history), lastOf(live), lastOf(attach)]) {
    const content = resultContent(entry);
    assert.deepEqual(content[0], { type: 'document', path: '/home/user/x.pdf', kind: 'pdf', name: 'x.pdf', pages: 2, range: '1-2' });
    assert.deepEqual(content.slice(1), blocks, 'the result\'s own blocks follow, untouched and in order');
  }
  assert.deepEqual(resultContent(lastOf(history)), resultContent(lastOf(live)));
  assert.equal(lastOf(attach).uuid, 'u-t1', 'the key (uuid) does not move');
  assert.equal(blocks.length, 3, 'the input is not mutated');
  assert.equal(lines[1].message.content[0].content, blocks);
});

test('claude: whole-PDF read (a document block, no page images) -> element with pages 0', () => {
  const blocks = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } },
    { type: 'text', text: 'PDF file read: /home/user/x.pdf (12KB)' }];
  const { history, live, attach } = claudeAll([call('t1', 'Read', { file_path: '/home/user/x.pdf' }), result('t1', blocks)]);
  for (const entry of [lastOf(history), lastOf(live), lastOf(attach)]) {
    const els = elementsOf(entry);
    assert.equal(els.length, 1);
    assert.equal(els[0].pages, 0);
    assert.equal(els[0].kind, 'pdf');
    assert.deepEqual(resultContent(entry).slice(1), blocks);
  }
});

test('claude: PNG read -> image element with pages 1; Windows spelling of the path is kept', () => {
  const { history, live, attach } = claudeAll([call('t1', 'Read', { file_path: 'C:/example/x.png' }), result('t1', [IMG])]);
  for (const entry of [lastOf(history), lastOf(live), lastOf(attach)]) {
    assert.deepEqual(resultContent(entry)[0], { type: 'document', path: 'C:/example/x.png', kind: 'image', name: 'x.png', pages: 1 });
    assert.deepEqual(resultContent(entry)[1], IMG);
  }
});

test('claude: markdown read (a plain string result) -> element above the text, pages 0', () => {
  const text = '     1\t# Title\n     2\tbody';
  const { history, live, attach } = claudeAll([call('t1', 'Read', { file_path: '/home/user/NOTES.md' }), result('t1', text)]);
  for (const entry of [lastOf(history), lastOf(live), lastOf(attach)]) {
    assert.deepEqual(resultContent(entry), [
      { type: 'document', path: '/home/user/NOTES.md', kind: 'markdown', name: 'NOTES.md', pages: 0 },
      { type: 'text', text },
    ]);
  }
});

test('claude: an image from a tool that is not Read gets no element (O8)', () => {
  const lines = [call('t1', 'mcp__shots__capture', { file_path: '/home/user/shot.png' }), result('t1', [IMG])];
  const { history, live, attach } = claudeAll(lines);
  for (const entry of [lastOf(history), lastOf(live), lastOf(attach)]) {
    assert.deepEqual(resultContent(entry), [IMG]);
  }
});

test('claude: a Read with no file_path, a code file and a failed read get no element', () => {
  const cases = [
    [call('t1', 'Read', {}), result('t1', [IMG])],
    [call('t1', 'Read', { file_path: '/home/user/a.js' }), result('t1', 'console.log(1)')],
    [call('t1', 'Read', { file_path: '/home/user/x.pdf', pages: '1-30' }), result('t1', 'pages out of range', { is_error: true })],
  ];
  for (const lines of cases) {
    const { history, live, attach } = claudeAll(lines);
    for (const entry of [lastOf(history), lastOf(live), lastOf(attach)]) {
      assert.equal(JSON.stringify(entry).includes('"type":"document"'), false);
    }
    assert.equal(lastOf(history).message.content[0], lines[1].message.content[0], 'unchanged block, same object');
  }
});

test('claude: the core finds the path through documentPathsOf', () => {
  const { live } = claudeAll([call('t1', 'Read', { file_path: '/home/user/x.pdf', pages: '1' }),
    result('t1', [{ type: 'text', text: 'PDF pages extracted: 1 page(s)' }, IMG])]);
  assert.deepEqual(documentPathsOf(lastOf(live)), ['/home/user/x.pdf']);
});

test('claude: the live tool op still carries text only', () => {
  const d = claudeProtocol.createDecoder();
  d.decode(call('t1', 'Read', { file_path: '/home/user/x.pdf', pages: '1' }));
  const ops = d.decode(result('t1', [{ type: 'text', text: 'PDF pages extracted: 1 page(s)' }, IMG]));
  const tool = ops.find(o => o.op === 'tool');
  assert.equal(tool.output, 'PDF pages extracted: 1 page(s)');
});

// --- Pi ---

const piCall = (id, name, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
const piResult = (id, content, extra = {}) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content, isError: false, ...extra });
const PI_IMG = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
const piEntry = (message, i) => ({ type: 'message', id: `e${i}`, parentId: i ? `e${i - 1}` : null, message });

function piHistory(messages, cwd) {
  const entries = [{ type: 'session', version: 3, id: 's', cwd }, ...messages.map(piEntry)];
  return piView.normalizeTranscriptEntries(entries);
}
function piLive(messages, cwd) {
  const d = piProtocol.createDecoder({ cwd });
  return messages.flatMap(m => d.decode({ type: 'message_end', message: m })).filter(o => o.op === 'append').map(o => o.entry);
}
function piReset(messages, cwd) {
  return piProtocol.entriesFromMessages({ data: { messages } }, { cwd });
}
const piAll = (messages, cwd) => [piHistory(messages, cwd), piLive(messages, cwd), piReset(messages, cwd)].map(lastOf);

test('pi: a relative path is made absolute with the session cwd (POSIX and Windows cwd)', () => {
  const msgs = (p) => [piCall('c1', 'read', { path: p }), piResult('c1', [{ type: 'text', text: 'hello' }])];
  for (const entry of piAll(msgs('docs/NOTES.md'), '/home/user/proj')) {
    assert.deepEqual(resultContent(entry)[0], { type: 'document', path: '/home/user/proj/docs/NOTES.md', kind: 'markdown', name: 'NOTES.md', pages: 0 });
    assert.deepEqual(resultContent(entry)[1], { type: 'text', text: 'hello' });
  }
  for (const entry of piAll(msgs('docs\\NOTES.md'), 'C:\\work\\proj')) {
    assert.equal(resultContent(entry)[0].path, 'C:\\work\\proj\\docs\\NOTES.md');
  }
});

test('pi: an absolute path stays as the model spelled it, and needs no cwd', () => {
  const msgs = [piCall('c1', 'read', { path: '/home/user/NOTES.md' }), piResult('c1', [{ type: 'text', text: 'x' }])];
  for (const entry of [lastOf(piLive(msgs, undefined)), lastOf(piReset(msgs))]) {
    assert.equal(resultContent(entry)[0].path, '/home/user/NOTES.md');
  }
});

test('pi: a relative path with no cwd gets no element (no guess)', () => {
  const msgs = [piCall('c1', 'read', { path: 'NOTES.md' }), piResult('c1', [{ type: 'text', text: 'x' }])];
  for (const entry of [lastOf(piLive(msgs, undefined)), lastOf(piReset(msgs)), lastOf(piHistory(msgs, ''))]) {
    assert.equal(elementsOf(entry).length, 0);
  }
});

test('pi: image read -> image element with pages 1, the viewer\'s image block after it', () => {
  const msgs = [piCall('c1', 'read', { path: 'shot.png' }),
    piResult('c1', [{ type: 'text', text: 'Read image file [image/png]' }, PI_IMG])];
  for (const entry of piAll(msgs, '/home/user/proj')) {
    const content = resultContent(entry);
    assert.deepEqual(content[0], { type: 'document', path: '/home/user/proj/shot.png', kind: 'image', name: 'shot.png', pages: 1 });
    assert.equal(content[2].type, 'image');
    assert.equal(content[2].source.data, 'AAAA');
  }
});

test('pi: history, live and reset give the same entry content', () => {
  const msgs = [piCall('c1', 'read', { path: 'a.md' }), piResult('c1', [{ type: 'text', text: 'x' }])];
  const [h, l, r] = piAll(msgs, '/home/user/proj');
  assert.deepEqual(resultContent(h), resultContent(l));
  assert.deepEqual(resultContent(l), resultContent(r));
});

test('pi: a PDF read has no pages (O7) and gets no element; a non-read tool and an error get none', () => {
  const pdf = [piCall('c1', 'read', { path: '/home/user/x.pdf' }), piResult('c1', [{ type: 'text', text: '%PDF-1.4 ...' }])];
  const other = [piCall('c1', 'bash', { command: 'cat a.md' }), piResult('c1', [{ type: 'text', text: 'x' }], { toolName: 'bash' })];
  const failed = [piCall('c1', 'read', { path: '/home/user/a.md' }), piResult('c1', [{ type: 'text', text: 'ENOENT' }], { isError: true })];
  for (const msgs of [pdf, other, failed]) {
    for (const entry of piAll(msgs, '/home/user/proj')) assert.equal(elementsOf(entry).length, 0);
  }
});

test('pi: the core finds the path through documentPathsOf, and a partial turn registers nothing', () => {
  const entry = lastOf(piLive([piCall('c1', 'read', { path: 'a.md' }), piResult('c1', [{ type: 'text', text: 'x' }])], '/home/user/proj'));
  assert.deepEqual(documentPathsOf(entry), ['/home/user/proj/a.md']);
  assert.ok(isDocumentElement(resultContent(entry)[0]));

  const d = piProtocol.createDecoder({ cwd: '/home/user/proj' });
  d.decode({ type: 'message_start', message: { role: 'assistant' } });
  d.decode({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.md' } } } });
  const ops = d.decode({ type: 'message_end', message: piResult('c1', [{ type: 'text', text: 'x' }]) });
  assert.equal(elementsOf(ops.find(o => o.op === 'append').entry).length, 0, 'no assistant message_end yet, so no call was registered');
});

test('claude: a foreign document element with a path is dropped; the native document block stays (G3)', () => {
  const foreign = { type: 'document', path: '/home/user/evil.pdf', kind: 'pdf', name: 'evil.pdf', pages: 0 };
  const native = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } };
  const forged = [
    [call('t1', 'mcp__x__tool', {}), result('t1', [foreign, { type: 'text', text: 'hi' }])],
    [call('t1', 'Read', { file_path: '/home/user/x.pdf' }), result('t1', [foreign, native])],
  ];
  const a = claudeAll(forged[0]);
  for (const entry of [lastOf(a.history), lastOf(a.live), lastOf(a.attach)]) {
    assert.deepEqual(resultContent(entry), [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(documentPathsOf(entry), []);
  }
  const b = claudeAll(forged[1]);
  for (const entry of [lastOf(b.history), lastOf(b.live), lastOf(b.attach)]) {
    assert.deepEqual(documentPathsOf(entry), ['/home/user/x.pdf']);
    assert.deepEqual(resultContent(entry).slice(1), [native]);
  }
});

test('pi: a foreign document element with a path is dropped (G3)', () => {
  const foreign = { type: 'document', path: '/home/user/evil.pdf', kind: 'pdf', name: 'evil.pdf', pages: 0 };
  const other = [piCall('c1', 'bash', { command: 'x' }), piResult('c1', [foreign, { type: 'text', text: 'hi' }], { toolName: 'bash' })];
  const read = [piCall('c1', 'read', { path: '/home/user/a.md' }), piResult('c1', [foreign, { type: 'text', text: 'hi' }])];
  for (const entry of piAll(other, '/home/user/proj')) assert.deepEqual(documentPathsOf(entry), []);
  for (const entry of piAll(read, '/home/user/proj')) assert.deepEqual(documentPathsOf(entry), ['/home/user/a.md']);
});
