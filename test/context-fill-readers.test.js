// #620: every reader that can say how full a session's context window is keeps the LAST turn's input and
// the model it ran on — not a sum. The measurements behind each rule are on the issue: a compaction drops
// the next turn's input, Codex reports 0 on the first token_count after one, and Pi wrote a zero record on
// an aborted turn. A zero must never become the last value, or a full window reads as an empty one.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('../src/backends/claude/session-reader');
const codex = require('../src/backends/codex/parser');
const pi = require('../src/backends/pi/parser');

const line = (o) => JSON.stringify(o) + '\n';

function tmpFile(prefix, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, file: path.join(dir, name) };
}

// ── Claude ─────────────────────────────────────────────────────────────────────────────────────────

const claudeUser = (text) => ({ type: 'user', timestamp: '2026-09-15T10:00:00.000Z', message: { role: 'user', content: text } });
const claudeTurn = (model, usage) => ({
  type: 'assistant', timestamp: '2026-09-15T10:00:01.000Z',
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage },
});

test('Claude: the last turn counts input plus both cache halves, and the model it ran on', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'a.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('first prompt'))
      + line(claudeTurn('claude-opus-5', { input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 90, output_tokens: 4 }))
      + line(claudeUser('second prompt'))
      + line(claudeTurn('claude-sonnet-5', { input_tokens: 2, cache_read_input_tokens: 35686, cache_creation_input_tokens: 10682, output_tokens: 4 })));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastInputTokens, 2 + 35686 + 10682);
    assert.equal(row.lastModel, 'claude-sonnet-5', 'the model of the LAST turn, not the first');
    assert.equal(row.cacheReadTokens, 500 + 35686, 'the running totals are untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: after a compaction the next turn\'s smaller input wins', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'b.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('prompt'))
      + line(claudeTurn('claude-opus-5', { input_tokens: 1, cache_read_input_tokens: 966000, cache_creation_input_tokens: 911 }))
      + line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 967317 } })
      + line(claudeTurn('claude-opus-5', { input_tokens: 5, cache_read_input_tokens: 70000, cache_creation_input_tokens: 7990 })));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastInputTokens, 77995);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a zero-input turn and a <synthetic> message never replace the last real turn', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'c.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('prompt'))
      + line(claudeTurn('claude-opus-5', { input_tokens: 3, cache_read_input_tokens: 120000, cache_creation_input_tokens: 0 }))
      + line(claudeTurn('claude-opus-5', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))
      + line(claudeTurn('<synthetic>', { input_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastInputTokens, 120003);
    assert.equal(row.lastModel, 'claude-opus-5');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const modelCommand = (args) => `<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${args}</command-args>`;

test('Claude: the argument of the last `/model <spec>` is kept, and prose beside the markup is not one', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'd.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(claudeUser(modelCommand('claude-sonnet-4-5[1m]')))
      + line(claudeUser('<local-command-stdout>Set model to `Sonnet 4.5 (1M context)`</local-command-stdout>'))
      // Prose beside the markup is a prompt, not the command.
      + line(claudeUser(modelCommand('claude-haiku-4-5') + ' and also explain why')));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastModelSpec, 'claude-sonnet-4-5[1m]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: another command leaves the argument alone, and output in the same message still counts as the command', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'h.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(claudeUser(modelCommand('claude-opus-4-6[1m]')))
      + line(claudeUser('<command-name>/compact</command-name><command-message>compact</command-message><command-args>keep notes</command-args>')));
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, 'claude-opus-4-6[1m]');

    fs.appendFileSync(file, line(claudeUser(modelCommand('claude-sonnet-4-5')
      + '<local-command-stdout>Set model to `Sonnet 4.5`</local-command-stdout>')));
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, 'claude-sonnet-4-5');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a `/model` without an argument clears an older argument instead of letting it outlive the switch', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'g.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(claudeUser(modelCommand('claude-sonnet-4-5[1m]')))
      + line(claudeTurn('claude-sonnet-4-5', { input_tokens: 1, cache_read_input_tokens: 150000, cache_creation_input_tokens: 0 }))
      // The picker: the choice is not in the transcript, so the `[1m]` claim above must not survive it.
      + line(claudeUser(modelCommand('')))
      + line(claudeTurn('claude-sonnet-4-5', { input_tokens: 1, cache_read_input_tokens: 170000, cache_creation_input_tokens: 0 })));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastModelSpec, null);
    assert.equal(row.lastInputTokens, 170001);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a subagent row carries none of the fill fields — the badge belongs to the session', () => {
  const { dir } = tmpFile('ctxfill-claude-', 'unused');
  const file = path.join(dir, 'agent-a1.jsonl');
  try {
    fs.writeFileSync(file,
      line({ ...claudeUser('delegated task'), isSidechain: true, agentId: 'a1' })
      + line({ ...claudeTurn('claude-haiku-4-5', { input_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }), isSidechain: true }));
    const row = claude.readSessionFile(file, 'folder', '/some/project', { parentSessionId: 'parent' });
    assert.ok(row, 'a subagent row was built');
    assert.equal('lastInputTokens' in row, false);
    assert.equal('lastModel' in row, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a session with no usage at all reports 0 and null, not a guess', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'e.jsonl');
  try {
    fs.writeFileSync(file, line(claudeUser('only a prompt so far')));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastInputTokens, 0);
    assert.equal(row.lastModel, null);
    assert.equal(row.lastModelSpec, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: the incremental read agrees with a full read', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'f.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('prompt'))
      + line(claudeTurn('claude-opus-5', { input_tokens: 1, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 })));
    const first = claude.readSessionFileIncremental(file, 'folder', '/some/project', {}, null);
    assert.equal(first.session.lastInputTokens, 40001);

    fs.appendFileSync(file, line(claudeTurn('claude-fable-5-1', { input_tokens: 2, cache_read_input_tokens: 50000, cache_creation_input_tokens: 10 })));
    const second = claude.readSessionFileIncremental(file, 'folder', '/some/project', {}, first.next);
    const full = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(second.session.lastInputTokens, full.lastInputTokens);
    assert.equal(second.session.lastModel, 'claude-fable-5-1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// #622: a `/model` spec that a later turn contradicts must stop picking the window.
const turnAt = (model, cached) => claudeTurn(model, { input_tokens: 1, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 });

test('Claude: a `/model` spec expires once a later turn ran on a model it does not name (#622)', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'i.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(claudeUser(modelCommand('claude-opus-4-5')))
      + line(turnAt('claude-opus-4-5', 90000)));
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, 'claude-opus-4-5', 'a turn on the named model keeps it');

    // Resumed later with `--model claude-opus-5`: no `/model` in the transcript, the turns say so.
    fs.appendFileSync(file, line(claudeUser('continue')) + line(turnAt('claude-opus-5', 170000)));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastModelSpec, null);
    assert.deepEqual(require('../src/backends/claude/model-windows').resolveClaudeWindow(row),
      { windowTokens: 1000000, source: 'model' }, '170k on Opus 5 is 17 % of 1M, not 85 % of Opus 4.5\'s 200k');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a switch no turn has followed yet still decides — only a LATER turn expires it (E9)', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'l.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(turnAt('claude-opus-5', 46000))
      + line(claudeUser(modelCommand('claude-opus-4-5'))));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastModelSpec, 'claude-opus-4-5', 'the turn on Opus 5 came BEFORE the switch');
    assert.deepEqual(require('../src/backends/claude/model-windows').resolveClaudeWindow(row),
      { windowTokens: 200000, source: 'transcript-spec' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a `/model` held back until the turn ended is read from its system entry too', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'n.jsonl');
  // The shape CLI 2.1.272 wrote for `/model claude-sonnet-4-5` typed while a turn was streaming: the turn
  // first, then the command and its output as `system` / `local_command` entries.
  const localCommand = (content) => ({ type: 'system', subtype: 'local_command', content, level: 'info', timestamp: '2026-09-15T10:00:02.000Z' });
  try {
    fs.writeFileSync(file,
      line(claudeUser('write a story'))
      + line(turnAt('claude-opus-4-5-20251101', 35707))
      + line({ type: 'system', subtype: 'turn_duration', timestamp: '2026-09-15T10:00:02.000Z' })
      + line(localCommand(modelCommand('claude-sonnet-4-5')))
      + line(localCommand('<local-command-stdout>Set model to `Sonnet 4.5` and saved as your default for new sessions</local-command-stdout>')));
    const row = claude.readSessionFile(file, 'folder', '/some/project');
    assert.equal(row.lastModelSpec, 'claude-sonnet-4-5', 'the output entry beside it is not a command and changes nothing');
    assert.equal(row.messageCount, 2, 'a system entry is not a message');

    fs.appendFileSync(file, line(localCommand(modelCommand(''))));
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, null, 'the picker form clears it here too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a sidechain entry on another model in the main transcript does not expire the spec', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'm.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(claudeUser(modelCommand('claude-opus-4-6[1m]')))
      + line({ ...turnAt('claude-haiku-4-5', 9000), isSidechain: true }));
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, 'claude-opus-4-6[1m]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: a spec is kept for a turn it names by a dated id or by its family, and for turns that are not turns', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'j.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(claudeUser(modelCommand('claude-sonnet-4-5[1m]')))
      + line(turnAt('claude-sonnet-4-5-20250929', 150000))
      + line(claudeTurn('claude-haiku-4-5', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))
      + line(claudeTurn('<synthetic>', { input_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })));
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, 'claude-sonnet-4-5[1m]',
      'a dated id names the model; a zero-input record and a <synthetic> message say nothing about it');

    fs.appendFileSync(file, line(claudeUser(modelCommand('sonnet[1m]'))) + line(turnAt('claude-sonnet-4-6', 120000)));
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, 'sonnet[1m]', 'an alias names its whole family');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: the incremental read expires a stale spec the same way a full read does', () => {
  const { dir, file } = tmpFile('ctxfill-claude-', 'k.jsonl');
  try {
    fs.writeFileSync(file,
      line(claudeUser('real prompt'))
      + line(claudeUser(modelCommand('claude-opus-4-6')))
      + line(turnAt('claude-opus-4-6', 60000)));
    const first = claude.readSessionFileIncremental(file, 'folder', '/some/project', {}, null);
    assert.equal(first.session.lastModelSpec, 'claude-opus-4-6');

    fs.appendFileSync(file, line(turnAt('claude-opus-5', 80000)));
    const second = claude.readSessionFileIncremental(file, 'folder', '/some/project', {}, first.next);
    assert.equal(second.session.lastModelSpec, null);
    assert.equal(claude.readSessionFile(file, 'folder', '/some/project').lastModelSpec, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Codex ──────────────────────────────────────────────────────────────────────────────────────────

const codexHead = (id) => ({ timestamp: '2026-09-15T10:00:00Z', type: 'session_meta', payload: { id, cwd: '/some/project', timestamp: '2026-09-15T10:00:00Z' } });
const codexPrompt = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'fix it' }] } };
const codexModel = (model) => ({ type: 'turn_context', payload: { model } });
const codexTokens = (lastInput, window = 258400) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 }, last_token_usage: { input_tokens: lastInput }, model_context_window: window } },
});

test('Codex: the last non-zero last_token_usage wins, and the zero after a compaction is skipped', () => {
  const { dir, file } = tmpFile('ctxfill-codex-', 'rollout.jsonl');
  try {
    fs.writeFileSync(file,
      line(codexHead('C1')) + line(codexModel('gpt-5.6-sol')) + line(codexPrompt)
      + line(codexTokens(229845))
      + line({ type: 'event_msg', payload: { type: 'context_compacted' } })
      + line(codexTokens(0)));
    let row = codex.parseSession({ kind: 'file', path: file });
    assert.equal(row.lastInputTokens, 229845, 'the zero report did not empty the window');
    assert.equal(row.lastModel, 'gpt-5.6-sol');
    assert.equal(row.contextWindow, 258400);

    fs.appendFileSync(file, line(codexTokens(95080)));
    row = codex.parseSession({ kind: 'file', path: file });
    assert.equal(row.lastInputTokens, 95080, 'the real figure after the compaction replaces it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex: the incremental read keeps the last value across a resume', () => {
  const { dir, file } = tmpFile('ctxfill-codex-', 'rollout.jsonl');
  try {
    fs.writeFileSync(file, line(codexHead('C2')) + line(codexModel('gpt-5.5')) + line(codexPrompt) + line(codexTokens(120000)));
    const first = codex.parseSessionIncremental({ kind: 'file', path: file }, {}, null);
    fs.appendFileSync(file, line(codexTokens(0)));
    const second = codex.parseSessionIncremental({ kind: 'file', path: file }, {}, first.parseState);
    const full = codex.parseSession({ kind: 'file', path: file });
    assert.equal(second.row.lastInputTokens, 120000);
    assert.equal(second.row.lastModel, 'gpt-5.5');
    assert.equal(second.row.lastInputTokens, full.lastInputTokens, 'the resume agrees with a full read');
    assert.equal(second.row.lastModel, full.lastModel);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex: the window stored with the fill is the one reported with that same request', () => {
  const { dir, file } = tmpFile('ctxfill-codex-', 'rollout.jsonl');
  try {
    fs.writeFileSync(file,
      line(codexHead('C4')) + line(codexModel('gpt-5.5')) + line(codexPrompt) + line(codexTokens(150000, 258400))
      // A new model, and a zero-input report carrying ITS window: skipped for the fill, so it must not
      // lend that window to a figure measured on the previous model.
      + line(codexModel('gpt-6-astra')) + line(codexTokens(0, 400000)));
    const row = codex.parseSession({ kind: 'file', path: file });
    assert.equal(row.lastInputTokens, 150000);
    assert.equal(row.lastContextWindow, 258400);
    assert.equal(row.contextWindow, 400000, 'the latest report is still what `contextWindow` says');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex: a model switch after the last report does not relabel that report', () => {
  const { dir, file } = tmpFile('ctxfill-codex-', 'rollout.jsonl');
  try {
    fs.writeFileSync(file,
      line(codexHead('C3')) + line(codexModel('gpt-5.5')) + line(codexPrompt) + line(codexTokens(150000))
      // The next turn's context names another model, but no request has run on it yet.
      + line(codexModel('gpt-5.6-sol')));
    const row = codex.parseSession({ kind: 'file', path: file });
    assert.equal(row.lastInputTokens, 150000);
    assert.equal(row.lastModel, 'gpt-5.5', 'the figure belongs to the model it was measured on');
    assert.equal(row.model, 'gpt-5.6-sol', 'the session model still follows the last turn_context');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Pi ─────────────────────────────────────────────────────────────────────────────────────────────

const piHead = (id) => ({ type: 'session', version: 3, id, timestamp: '2026-09-15T10:00:00.000Z', cwd: '/some/project' });
const piUser = (id, parentId) => ({ type: 'message', id, parentId, timestamp: '2026-09-15T10:00:01.000Z', message: { role: 'user', content: 'prompt' } });
const piTurn = (id, parentId, provider, model, usage) => ({
  type: 'message', id, parentId, timestamp: '2026-09-15T10:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider, model, stopReason: 'stop', usage },
});

test('Pi: the last assistant turn counts input plus both cache halves, with its provider and model', () => {
  const { dir, file } = tmpFile('ctxfill-pi-', 'p.jsonl');
  try {
    fs.writeFileSync(file,
      line(piHead('P1'))
      + line(piUser('u1', null))
      + line(piTurn('a1', 'u1', 'anthropic', 'claude-opus-5', { input: 10, cacheRead: 1000, cacheWrite: 5, output: 1 }))
      + line(piUser('u2', 'a1'))
      + line(piTurn('a2', 'u2', 'openai-codex', 'gpt-5.6-sol', { input: 247, cacheRead: 1536, cacheWrite: 0, output: 14 })));
    const row = pi.parseSession({ kind: 'file', path: file });
    assert.equal(row.lastInputTokens, 247 + 1536);
    assert.equal(row.lastProvider, 'openai-codex');
    assert.equal(row.lastModel, 'gpt-5.6-sol');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Pi: a zero record, a compaction\'s own usage and an abandoned branch never become the last turn', () => {
  const { dir, file } = tmpFile('ctxfill-pi-', 'q.jsonl');
  try {
    fs.writeFileSync(file,
      line(piHead('P2'))
      + line(piUser('u1', null))
      + line(piTurn('a1', 'u1', 'anthropic', 'claude-opus-5', { input: 1, cacheRead: 30000, cacheWrite: 0 }))
      // An abandoned branch off u1 with a bigger figure: not on the visible path.
      + line(piTurn('old', 'u1', 'anthropic', 'claude-opus-5', { input: 1, cacheRead: 900000, cacheWrite: 0 }))
      // The summarising call's usage carries the pre-compaction context; it is not a turn.
      + line({ type: 'compaction', id: 'c1', parentId: 'a1', timestamp: '2026-09-15T10:00:03.000Z', summary: 's', usage: { input: 256000, cacheRead: 0, cacheWrite: 0 } })
      + line(piUser('u2', 'c1'))
      + line(piTurn('a2', 'u2', 'anthropic', 'claude-opus-5', { input: 0, cacheRead: 0, cacheWrite: 0 })));
    const row = pi.parseSession({ kind: 'file', path: file });
    assert.equal(row.lastInputTokens, 30001);
    assert.equal(row.lastModel, 'claude-opus-5');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Pi: the incremental read matches a full read', () => {
  const { dir, file } = tmpFile('ctxfill-pi-', 'r.jsonl');
  try {
    fs.writeFileSync(file, line(piHead('P3')) + line(piUser('u1', null))
      + line(piTurn('a1', 'u1', 'anthropic', 'claude-sonnet-5', { input: 4, cacheRead: 2000, cacheWrite: 0 })));
    const first = pi.parseSessionIncremental({ kind: 'file', path: file }, {}, null);
    fs.appendFileSync(file, line(piUser('u2', 'a1'))
      + line(piTurn('a2', 'u2', 'anthropic', 'claude-sonnet-5', { input: 6, cacheRead: 26000, cacheWrite: 475 })));
    const second = pi.parseSessionIncremental({ kind: 'file', path: file }, {}, first.parseState);
    const full = pi.parseSession({ kind: 'file', path: file });
    assert.equal(second.row.lastInputTokens, full.lastInputTokens);
    assert.equal(second.row.lastInputTokens, 26481);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
