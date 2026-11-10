'use strict';
// Claude's session-flow reader (spec 46, #826, plan T4/T5) on the hand-built fixture
// `test/fixtures/flow/claude-main.jsonl` (see its README for what is measured and what is guessed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSnapshot } = require('../src/shared/flow-snapshot');
const { readSessionFlow } = require('../src/backends/claude/flow-reader');
const { writeOversizedLine } = require('./helpers/flow-fixture-gen');

const FIXTURE = path.join(__dirname, 'fixtures', 'flow', 'claude-main.jsonl');
const src = (file) => [{ sourceId: 'main', role: 'transcript', laneHint: 'main', file }];

async function read(file, opts) {
  const snap = await readSessionFlow(src(file), opts || {});
  assert.deepEqual(validateSnapshot(snap).errors, [], 'every snapshot passes validateSnapshot');
  return snap;
}

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reader-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('kinds, order and ordinals follow the transcript', async () => {
  const snap = await read(FIXTURE);
  assert.deepEqual(snap.steps.map(s => s.kind), [
    'start', 'instructions', 'instructions', 'prompt', 'thinking', 'tool', 'mode', 'prompt', 'compaction', 'output', 'interrupt', 'event',
  ]);
  assert.deepEqual(snap.steps.map(s => s.ordinal), snap.steps.map((_, i) => i));
  assert.equal(snap.complete, true);
  assert.equal(snap.lanes.length, 1);
  assert.equal(snap.lanes[0].kind, 'main');
  // turn numbers: a prompt starts a turn; the start and instruction steps precede the first
  assert.deepEqual(snap.steps.map(s => s.turn), [null, null, null, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  assert.equal(snap.steps.find(s => s.kind === 'prompt').label, 'Add a greeting function.');
  assert.ok(snap.steps.every(s => s.ts === null || Number.isFinite(s.ts)));
});

test('a tool call and its result are one step, paired by id', async () => {
  const snap = await read(FIXTURE);
  const tools = snap.steps.filter(s => s.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.match(tools[0].label, /^Read: /);
  assert.equal(tools[0].detail.status, 'ok');
  assert.match(tools[0].detail.result, /module\.exports/);
});

test('a meta user line and the compaction summary are not prompts; the summary belongs to the compaction', async () => {
  const snap = await read(FIXTURE);
  assert.equal(snap.steps.filter(s => s.kind === 'prompt').length, 2);
  assert.ok(!snap.steps.some(s => /Summary:|fake meta note/.test(s.label)));
  const c = snap.steps.find(s => s.kind === 'compaction');
  assert.match(c.detail.summary, /fake greeting work/);
});

test('a mode step appears only on a change of permissionMode; a `mode` line is not a permission mode', async () => {
  const snap = await read(FIXTURE);
  const modes = snap.steps.filter(s => s.kind === 'mode');
  assert.equal(modes.length, 1);
  assert.deepEqual({ from: modes[0].detail.from, to: modes[0].detail.to }, { from: 'default', to: 'acceptEdits' });
  assert.equal(snap.steps[0].detail.mode, 'default');
  // a `mode` line carrying the prompt-input mode (measured: `normal`) changes nothing
  const t = tmpFile([
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', permissionMode: 'auto', message: { role: 'user', content: 'hi' } },
    { type: 'mode', mode: 'normal' },
    { type: 'user', timestamp: '2026-01-01T00:00:01Z', permissionMode: 'auto', message: { role: 'user', content: 'again' } },
  ]);
  try {
    const s = await read(t.file);
    assert.equal(s.steps.filter(x => x.kind === 'mode').length, 0);
  } finally { t.cleanup(); }
});

test('checkpoints come from message.usage against the request model window, and no step gets a delta', async () => {
  const snap = await read(FIXTURE);
  const withCp = snap.steps.filter(s => s.checkpoint && s.kind !== 'compaction');
  assert.deepEqual(withCp.map(s => s.checkpoint.input.value), [4510, 4512, 858]);
  for (const s of withCp) {
    assert.equal(s.checkpoint.input.basis, 'measured');
    assert.equal(s.checkpoint.window.basis, 'estimated', 'the window is inferred from the model name');
    assert.equal(typeof s.checkpoint.window.value, 'number');
    assert.equal(s.checkpoint.model, 'claude-fake-model');
  }
  // tokens exist only on start and instruction steps; nothing carries the difference of two checkpoints
  for (const s of snap.steps) {
    if (s.kind !== 'start' && s.kind !== 'instructions') assert.equal(s.tokens, null, `${s.kind} carries no token figure`);
  }
  assert.ok(!/delta/i.test(JSON.stringify(snap.steps)));
});

test('compaction carries the last input before it and the next input after it, not the summarising call', async () => {
  const snap = await read(FIXTURE);
  const c = snap.steps.find(s => s.kind === 'compaction');
  assert.equal(c.detail.before, 4512);
  assert.equal(c.detail.after, 858);
  assert.equal(c.detail.reportedPreTokens, 5044);
  assert.equal(c.detail.reportedPostTokens, 900);
  assert.equal(c.checkpoint.input.value, 4512);
  assert.equal(c.tokens, null);
});

test('an interrupt is its own step, not a prompt', async () => {
  const snap = await read(FIXTURE);
  const last = snap.steps.filter(s => s.kind === 'interrupt').pop();
  assert.ok(last);
  assert.match(last.label, /Request interrupted/);
});

test('instruction files are children of the start step: estimated per file, the total is the first request, measured', async () => {
  const snap = await read(FIXTURE);
  const start = snap.steps[0];
  const files = snap.steps.filter(s => s.kind === 'instructions');
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.equal(f.parentStepId, start.id);
    assert.equal(f.tokens.basis, 'estimated');
    assert.equal(f.tokens.value, Math.ceil(f.detail.characters / 4));
  }
  assert.equal(start.tokens.basis, 'measured');
  assert.equal(start.tokens.value, 4510);
  assert.notEqual(files.reduce((n, f) => n + f.tokens.value, 0), start.tokens.value, 'the files do not claim to sum to the total');
  assert.ok(snap.limitations.some(l => l.id === 'hidden-input' && /system prompt/.test(l.text)));
});

test('the start total is unknown before a first request', async () => {
  const t = tmpFile([
    { type: 'attachment', timestamp: '2026-01-01T00:00:00Z', attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', content: 'abcd' }] } },
    { type: 'user', timestamp: '2026-01-01T00:00:01Z', permissionMode: 'default', message: { role: 'user', content: 'hello' } },
  ]);
  try {
    const snap = await read(t.file);
    assert.equal(snap.steps[0].kind, 'start');
    assert.equal(snap.steps[0].tokens.basis, 'unknown');
    assert.equal(snap.steps[0].tokens.value, null);
    assert.equal(snap.steps[1].tokens.value, 1);
  } finally { t.cleanup(); }
});

test('stable ids are unchanged across a re-read and when the file grows at its end', async () => {
  const a = await read(FIXTURE);
  const b = await read(FIXTURE);
  assert.deepEqual(a.steps.map(s => s.id), b.steps.map(s => s.id));
  assert.equal(new Set(a.steps.map(s => s.id)).size, a.steps.length);
  const t = tmpFile(fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean));
  try {
    fs.appendFileSync(t.file, JSON.stringify({ type: 'user', timestamp: '2026-01-01T11:00:00Z', permissionMode: 'acceptEdits', message: { role: 'user', content: 'one more' } }) + '\n');
    const grown = await read(t.file);
    assert.deepEqual(grown.steps.slice(0, a.steps.length).map(s => s.id), a.steps.map(s => s.id));
    assert.equal(grown.steps.length, a.steps.length + 1);
  } finally { t.cleanup(); }
});

test('no path leaves the reader in a source, and the capabilities are the descriptor\'s', async () => {
  const snap = await read(FIXTURE);
  for (const s of snap.steps) assert.deepEqual(Object.keys(s.source).sort(), ['byteOffset', 'line', 'sourceId']);
  const answer = require('../src/backends').get('claude').sessionFlow({ filePath: FIXTURE, folder: 'x', sessionId: 'y' });
  assert.deepEqual(snap.capabilities, answer.capabilities);
});

test('an oversized line is skipped unparsed: one unknown step and a limitation, the lines around it are read', async () => {
  const big = writeOversizedLine(6 * 1024 * 1024);
  try {
    const snap = await read(big.path);
    assert.deepEqual(snap.steps.map(s => s.kind), ['start', 'prompt', 'event', 'prompt']);
    const event = snap.steps[2];
    assert.equal(event.label, 'A line exceeded the size cap');
    assert.equal(event.tokens.basis, 'unknown');
    assert.ok(event.detail.bytes > 6 * 1024 * 1024 - 100);
    assert.ok(snap.limitations.some(l => l.id === 'line-over-cap' && /exceeded the size cap/.test(l.text)));
    assert.equal(snap.complete, false);
  } finally { big.cleanup(); }
});

test('an oversized line is never concatenated, decoded or parsed', async () => {
  const big = writeOversizedLine(24 * 1024 * 1024);
  const realConcat = Buffer.concat;
  const realParse = JSON.parse;
  let maxConcat = 0;
  let maxParse = 0;
  Buffer.concat = function (list, total) {
    const n = Number.isFinite(total) ? total : list.reduce((a, b) => a + b.length, 0);
    maxConcat = Math.max(maxConcat, n);
    return realConcat.call(Buffer, list, total);
  };
  JSON.parse = function (text, ...rest) {
    maxParse = Math.max(maxParse, typeof text === 'string' ? text.length : 0);
    return realParse.call(JSON, text, ...rest);
  };
  try {
    const snap = await read(big.path);
    assert.equal(snap.steps.filter(s => s.kind === 'event').length, 1);
  } finally {
    Buffer.concat = realConcat;
    JSON.parse = realParse;
    big.cleanup();
  }
  assert.ok(maxConcat < 1024 * 1024, `a ${maxConcat} byte buffer was built`);
  assert.ok(maxParse < 1024 * 1024, `a ${maxParse} character string was parsed`);
});

test('the step cap stops the read with complete:false and a limitation', async () => {
  const snap = await read(FIXTURE, { maxSteps: 4 });
  assert.equal(snap.steps.length, 4);
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'step-cap'));
});

test('the size estimate cap stops the read with complete:false and a limitation', async () => {
  const snap = await read(FIXTURE, { maxBytes: 1200 });
  assert.ok(snap.steps.length >= 1 && snap.steps.length < 12);
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'size-cap'));
});

test('an aborted signal stops early, and says so', async () => {
  const ac = new AbortController();
  ac.abort();
  const snap = await read(FIXTURE, { signal: ac.signal });
  assert.equal(snap.steps.length, 0);
  assert.equal(snap.complete, false);
  assert.ok(snap.limitations.some(l => l.id === 'aborted'));
});

test('an abort during a long read stops before the end of the file', async () => {
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: `prompt ${i} ${'x'.repeat(200)}` } });
  const t = tmpFile(lines);
  try {
    const ac = new AbortController();
    setImmediate(() => ac.abort());
    const snap = await read(t.file, { signal: ac.signal, maxSteps: 100000 });
    assert.equal(snap.complete, false);
    assert.ok(snap.steps.length < 20001, 'the read ended before the last line');
  } finally { t.cleanup(); }
});

test('an unreadable file and no source give a valid, incomplete snapshot without a path', async () => {
  const missing = await read(path.join(os.tmpdir(), 'flow-reader-does-not-exist.jsonl'));
  assert.equal(missing.complete, false);
  const l = missing.limitations.find(x => x.id === 'read-failed');
  assert.ok(l && !l.text.includes(os.tmpdir()));
  const none = await readSessionFlow([], {});
  assert.deepEqual(validateSnapshot(none).errors, []);
  assert.ok(none.limitations.some(x => x.id === 'nothing-read'));
});

test('tool results, labels and details are truncated at the reader', async () => {
  const huge = 'y'.repeat(300000);
  const t = tmpFile([
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: huge } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-fake-model', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: huge } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] } },
  ]);
  try {
    const snap = await read(t.file);
    for (const s of snap.steps) {
      assert.ok(s.label.length <= 200);
      for (const v of Object.values(s.detail)) if (typeof v === 'string') assert.ok(v.length <= 2048);
    }
    assert.ok(JSON.stringify(snap).length < 20000);
  } finally { t.cleanup(); }
});

test('a slash command and its output are one event, not a prompt, and start no turn', async () => {
  const snap = await read(FIXTURE);
  assert.equal(snap.steps.filter(s => s.kind === 'prompt').length, 2);
  const cmd = snap.steps[snap.steps.length - 1];
  assert.equal(cmd.kind, 'event');
  assert.equal(cmd.label, '/model');
  assert.equal(cmd.turn, 2, 'the turn number is unchanged');
  assert.equal(cmd.detail.output, 'Set model to fake');
});

test('the window follows #620: base window, 1M when the model string says so, 1M when the request exceeds the base window', async () => {
  const line = (model, input) => ({ type: 'assistant', message: { id: `m${input}${model}`, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input } } });
  const t = tmpFile([
    line('claude-opus-4-6', 150000),
    line('claude-opus-4-6[1m]', 150000),
    line('claude-opus-4-6', 250000),
    line('claude-sonnet-5-5', 250000),
    line('some-other-model', 1000),
  ]);
  try {
    const cps = (await read(t.file)).steps.filter(s => s.checkpoint).map(s => s.checkpoint.window);
    assert.deepEqual(cps.map(w => w.value), [200000, 1000000, 1000000, 1000000, null]);
    assert.match(cps[2].note, /larger than the base window/);
    assert.equal(cps[4].basis, 'unknown');
    assert.equal(cps[0].basis, 'estimated');
  } finally { t.cleanup(); }
});

test('a subagent line (isSidechain) is not on the main lane', async () => {
  const t = tmpFile([
    { type: 'user', message: { role: 'user', content: 'main prompt' } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'agent prompt' } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-fake-model', content: [{ type: 'text', text: 'agent says' }], usage: { input_tokens: 5 } } },
  ]);
  try {
    const snap = await read(t.file);
    assert.deepEqual(snap.steps.map(s => s.kind), ['start', 'prompt']);
  } finally { t.cleanup(); }
});

test('a multibyte character split across the 64 KB chunk boundary, and CRLF lines, read correctly', async () => {
  const prefix = '{"pad":"';
  const pad = 'a'.repeat(65536 - prefix.length - 1); // the first 3-byte character starts one byte before the boundary
  const l1 = `${prefix}${pad}","type":"user","message":{"role":"user","content":"€€€ euro"}}`;
  const l2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } });
  const t = tmpFile([l1 + '\r', l2 + '\r']);
  try {
    const snap = await read(t.file);
    assert.deepEqual(snap.steps.filter(s => s.kind === 'prompt').map(s => s.label), ['€€€ euro', 'second']);
  } finally { t.cleanup(); }
});

test('truncation does not cut a surrogate pair', async () => {
  const t = tmpFile([{ type: 'user', message: { role: 'user', content: '😀'.repeat(300) } }]);
  try {
    const label = (await read(t.file)).steps.find(s => s.kind === 'prompt').label;
    assert.ok(label.length <= 200);
    assert.ok(!/[\uD800-\uDBFF]…$/.test(label), 'no lone high surrogate before the ellipsis');
  } finally { t.cleanup(); }
});

test('every tool step names its tool in detail.tool, and a failed call carries a structured outcome flag', async () => {
  const t = tmpFile([
    { type: 'assistant', message: { id: 'a', role: 'assistant', model: 'claude-fake-model', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls /nope' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'No such file' }] } },
  ]);
  try {
    const tools = (await read(t.file)).steps.filter(s => s.kind === 'tool');
    assert.deepEqual(tools.map(s => s.detail.tool), ['Bash', 'Bash']);
    assert.deepEqual(tools[0].flags, []);
    assert.deepEqual(tools[1].flags, [{ axis: 'outcome', code: 'tool-error', why: 'the tool reported an error', evidence: 'structured' }]);
    assert.equal(tools[1].detail.status, 'error');
  } finally { t.cleanup(); }
});

test('a window hint from the session settings outranks the model name, unless the request did not fit in it', async () => {
  const line = (input) => ({ type: 'assistant', message: { id: 'h' + input, role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input } } });
  const t = tmpFile([line(1000), line(300000)]);
  try {
    const snap = await read(t.file, { windowHint: { windowTokens: 1000000 } });
    const cps = snap.steps.filter(s => s.checkpoint).map(s => s.checkpoint.window);
    assert.equal(cps[0].value, 1000000);
    assert.equal(cps[0].basis, 'estimated');
    assert.match(cps[0].note, /session's settings/);
    const small = await read(t.file, { windowHint: { windowTokens: 200000 } });
    const sc = small.steps.filter(s => s.checkpoint).map(s => s.checkpoint.window);
    assert.equal(sc[0].value, 200000);
    assert.equal(sc[1].value, 1000000, 'a request over the hint falls back to the inference');
  } finally { t.cleanup(); }
});

// ---- instruction file labels and placement (owner changes after the T8 click test) ----

function instrTranscript(cwd, paths, extra) {
  return [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', cwd, permissionMode: 'default', message: { role: 'user', content: 'hello' } },
    { type: 'attachment', timestamp: '2026-01-01T00:00:01Z', cwd, attachment: { type: 'instructions', files: paths.map(p => ({ path: p, content: 'abcdefgh' })) } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', cwd, requestId: 'r1', message: { id: 'm1', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 1 } } },
  ].concat(extra || []);
}

test('instruction labels: relative to the working directory, ~ for the home directory, never an absolute path', async () => {
  const cwd = path.join(os.tmpdir(), 'proj-a');
  const home = os.homedir();
  const outside = path.join(path.parse(home).root, 'managed-dir', 'org', 'CLAUDE.md');
  const t = tmpFile(instrTranscript(cwd, [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, '.claude', 'rules', 'x.md'),
    path.join(home, '.claude', 'CLAUDE.md'),
    outside,
    'C:\\Users\\someone\\other\\CLAUDE.md',
    '/etc/org/CLAUDE.md',
  ]));
  try {
    const snap = await read(t.file);
    const labels = snap.steps.filter(s => s.kind === 'instructions').map(s => s.label);
    assert.deepEqual(labels.slice(0, 3), ['CLAUDE.md', '.claude/rules/x.md', '~/.claude/CLAUDE.md']);
    assert.equal(labels[3], '\u2026/org/CLAUDE.md');
    assert.equal(labels[4], '\u2026/other/CLAUDE.md');
    assert.equal(labels[5], '\u2026/org/CLAUDE.md');
    for (const l of labels) assert.ok(!/^([A-Za-z]:|\/|\\)/.test(l), `label is not absolute: ${l}`);
    assert.ok(!JSON.stringify(snap).includes('someone'), 'no full path anywhere in the snapshot');
  } finally { t.cleanup(); }
});

test('the first instruction attachment is moved directly behind the start step; ids and parents stay, a repeat stays put', async () => {
  const cwd = path.join(os.tmpdir(), 'proj-b');
  const repeat = { type: 'attachment', timestamp: '2026-01-01T00:00:09Z', cwd, attachment: { type: 'instructions', reason: 'compaction', files: [{ path: path.join(cwd, 'CLAUDE.md'), content: 'abcd' }] } };
  const t = tmpFile(instrTranscript(cwd, [path.join(cwd, 'CLAUDE.md'), path.join(cwd, 'A.md')], [repeat]));
  try {
    const snap = await read(t.file);
    const kinds = snap.steps.map(s => s.kind);
    assert.deepEqual(kinds.slice(0, 4), ['start', 'instructions', 'instructions', 'prompt']);
    const start = snap.steps[0];
    assert.deepEqual(snap.steps.map(s => s.ordinal), snap.steps.map((_, i) => i));
    const files = snap.steps.filter(s => s.kind === 'instructions');
    assert.equal(files.length, 3);
    for (const f of files) assert.equal(f.parentStepId, start.id);
    assert.equal(files[2].label, 'CLAUDE.md (compaction)');
    assert.equal(snap.steps.indexOf(files[2]), snap.steps.length - 1, 'the repeat stays where it happened');
    assert.equal(new Set(snap.steps.map(s => s.id)).size, snap.steps.length);
    // The ids derive from the source line: moving did not change them.
    assert.match(files[0].id, /:2:/);
  } finally { t.cleanup(); }
});
