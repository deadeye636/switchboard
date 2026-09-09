// A session that has only run the command that opened it is named after the one it continues (#229).
//
// Three parts, and they are tested apart because they live apart on purpose. The READER decides what a
// session's summary is, and used to hand back the `/clear` markup itself — the sidebar rendered it as
// "/clear clear", the command that ENDED the previous session, on the row that had just replaced it. The
// BACKEND answers whether a stored row is still nothing but that command; the core asks the descriptor and
// passes the answer on, so no transcript grammar reaches the renderer. The RENDERER borrows the continued
// session's name while that answer stands.
//
// The transcript shapes below are taken from a live Claude transcript, not invented: the caveat block and
// the command block are SEPARATE user messages, which is why the reader's existing caveat test never saw
// this one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile, readSessionFileIncremental } = require('../src/backends/claude/session-reader');
const backends = require('../src/backends');
const { applyContinuationTitles, CONTINUATION_PREFIX } = require('../src/renderer/lib/continuation-title');
const { resolveRenameTarget } = require('../src/renderer/session/session-tabs');

const claude = backends.get('claude');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-clear-title-'));
}

function writeSession(dir, name, entries) {
  const file = path.join(dir, name + '.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

const CLEAR_MARKUP = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';

// A loaded renderer row, with the neutral field the core stamps — asked of the DESCRIPTOR rather than
// written by hand, so these tests fail if the two halves ever stop agreeing about one string.
function row(sessionId, summary, extra = {}) {
  return {
    sessionId,
    summary,
    openedWithCommand: claude.openedWithCommand({ summary }) || null,
    ...extra,
  };
}

function mapOf(sessions) {
  const map = new Map(sessions.map(s => [s.sessionId, s]));
  return { sessions, get: id => map.get(id) };
}

// --- The reader: what a session's summary is -----------------------------------------------------

test('the command that opened a session is not its summary — the next real prompt is', () => {
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-clear', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z', message: CLEAR_MARKUP },
      { type: 'user', timestamp: '2026-06-01T09:00:05.000Z', message: 'take another look at the parser' },
      { type: 'assistant', timestamp: '2026-06-01T09:00:09.000Z', message: { model: 'claude-opus-4-8', content: [] } },
    ]);
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s, 'session should parse');
    assert.equal(s.summary, 'take another look at the parser');
    assert.equal(s.firstPrompt, 'take another look at the parser');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a session that has ONLY run the command still yields a row, named after the command', () => {
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-fresh', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z', message: CLEAR_MARKUP },
    ]);
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s, 'a just-cleared session must still be a row — it is the one the re-key lands on');
    assert.equal(s.summary, '/clear');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a prompt that merely CONTAINS command markup is still the prompt', () => {
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-skill', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z', message: '<command-name>/git-commit</command-name>\ncommit the parser fix' },
    ]);
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s);
    assert.match(s.summary, /commit the parser fix/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a command the user gave ARGUMENTS to is a prompt — the arguments are the part they typed', () => {
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-args', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z',
        message: '<command-name>/mcp</command-name>\n<command-message>mcp</command-message>\n<command-args>reconnect all</command-args>' },
    ]);
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s);
    assert.match(s.summary, /reconnect all/, 'the only words the user wrote must survive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a self-closing args tag is still just the command, not the markup', () => {
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-selfclosing', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z',
        message: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args />' },
    ]);
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s);
    assert.equal(s.summary, '/clear');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a command that PRINTS is not titled after its own output', () => {
  // Measured shape: the command block, then the CLI's output as its own user message, then the prompt.
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-stdout', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z',
        message: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' },
      { type: 'user', timestamp: '2026-06-01T09:00:01.000Z',
        message: '<local-command-stdout>Set model to opus</local-command-stdout>' },
      { type: 'user', timestamp: '2026-06-01T09:00:30.000Z', message: 'now rewrite the parser' },
    ]);
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s);
    assert.equal(s.summary, 'now rewrite the parser');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a command that printed and nothing else is still titled after the command', () => {
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-stdout-only', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z',
        message: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' },
      { type: 'user', timestamp: '2026-06-01T09:00:01.000Z',
        message: '<local-command-stdout>Set model to opus</local-command-stdout>' },
    ]);
    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s, 'the row must still exist');
    assert.equal(s.summary, '/model');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the watcher path flips the title from the command to the first prompt as it arrives', () => {
  const tmp = mkTmp();
  try {
    const file = writeSession(tmp, 'sess-live', [
      { type: 'user', timestamp: '2026-06-01T09:00:00.000Z', message: CLEAR_MARKUP },
    ]);
    const first = readSessionFileIncremental(file, 'folder', '/some/project');
    assert.ok(first && first.session, 'the just-cleared session is a row from its first line on');
    assert.equal(first.session.summary, '/clear');

    fs.appendFileSync(file, JSON.stringify({
      type: 'user', timestamp: '2026-06-01T09:00:20.000Z', message: 'now check the scrollback',
    }) + '\n', 'utf8');

    const second = readSessionFileIncremental(file, 'folder', '/some/project', { memo: first.memo });
    assert.ok(second && second.session);
    assert.equal(second.session.summary, 'now check the scrollback');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- The descriptor: whose question this is ------------------------------------------------------

test("what the reader writes is what the backend's own hook recognises", () => {
  // One contract across two processes: every summary the reader can emit for a command-only message must
  // come back from the descriptor, or the row silently never borrows.
  const tmp = mkTmp();
  try {
    for (const cmd of ['/clear', '/caveman:caveman-help', '/it-admin:project_init', '/x.y-z']) {
      const file = writeSession(tmp, 'sess-' + cmd.replace(/[^a-z0-9]/gi, '_'), [
        { type: 'user', timestamp: '2026-06-01T09:00:00.000Z',
          message: `<command-name>${cmd}</command-name>\n<command-message>x</command-message>\n<command-args></command-args>` },
      ]);
      const s = readSessionFile(file, 'folder', '/some/project');
      assert.ok(s, cmd);
      assert.equal(s.summary, cmd);
      assert.equal(claude.openedWithCommand(s), cmd, `the descriptor must recognise ${cmd}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the descriptor answers null for anything a user wrote, and for a row it has never seen', () => {
  assert.equal(claude.openedWithCommand({ summary: 'rewrite the parser' }), null);
  assert.equal(claude.openedWithCommand({ summary: '/clear the build directory as well' }), null);
  assert.equal(claude.openedWithCommand({ summary: '' }), null);
  assert.equal(claude.openedWithCommand({}), null);
  assert.equal(claude.openedWithCommand(null), null);
});

test('a row an older parser wrote is still recognised, so a stale parent lends nothing', () => {
  // Until the v6 re-read reaches it, an already-indexed row holds the raw markup. Answering "that is a
  // name" would put "↳ /clear clear" on its child — the exact string this issue is about.
  assert.equal(claude.openedWithCommand({ summary: CLEAR_MARKUP }), '/clear');
});

// --- The renderer: what the row is called --------------------------------------------------------

test('a cleared session borrows the name of the session it continues', () => {
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit'),
    row('child', '/clear', { lineageParentId: 'parent', lineageKind: 'clear' }),
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('child').summary, CONTINUATION_PREFIX + 'debug the terminal fit');
  assert.equal(get('parent').summary, 'debug the terminal fit', 'the parent is left alone');
});

test('a run of clears borrows from the last session with a name of its own, and never stacks the marker', () => {
  const { sessions, get } = mapOf([
    row('root', 'debug the terminal fit'),
    row('mid', '/clear', { lineageParentId: 'root' }),
    row('leaf', '/clear', { lineageParentId: 'mid' }),
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('mid').summary, CONTINUATION_PREFIX + 'debug the terminal fit');
  assert.equal(get('leaf').summary, CONTINUATION_PREFIX + 'debug the terminal fit');
});

test("the parent's own title wins over its summary when it is lent out", () => {
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit', { aiTitle: 'Terminal fit investigation' }),
    row('child', '/clear', { lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('child').summary, CONTINUATION_PREFIX + 'Terminal fit investigation');
});

test('a session with a prompt of its own is never renamed, lineage or not', () => {
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit'),
    row('child', 'now check the scrollback', { lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('child').summary, 'now check the scrollback');
});

test('a backend that declines the question never has its rows renamed', () => {
  // Codex answers null for every row (its `/clear` starts a new rollout, so there is no command line to
  // mistake for a prompt). Such a row is left exactly as it is, whatever its summary looks like.
  assert.equal(backends.get('codex').openedWithCommand({ summary: '/clear' }), null);
  const { sessions, get } = mapOf([
    { sessionId: 'parent', summary: 'debug the terminal fit', openedWithCommand: null },
    { sessionId: 'child', summary: '/clear', lineageParentId: 'parent', openedWithCommand: null },
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('child').summary, '/clear');
});

test('a missing or unnamed parent leaves the command standing rather than blanking the row', () => {
  const gone = mapOf([row('child', '/clear', { lineageParentId: 'not-loaded' })]);
  applyContinuationTitles(gone.sessions, gone.get);
  assert.equal(gone.get('child').summary, '/clear');

  const unnamed = mapOf([
    row('parent', '/clear'),
    row('child', '/clear', { lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(unnamed.sessions, unnamed.get);
  assert.equal(unnamed.get('child').summary, '/clear');
});

test('a lineage cycle terminates instead of spinning', () => {
  const { sessions, get } = mapOf([
    row('a', '/clear', { lineageParentId: 'b' }),
    row('b', '/clear', { lineageParentId: 'a' }),
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('a').summary, '/clear');
  assert.equal(get('b').summary, '/clear');
});

test('what a session actually said stays reachable for anything that leaves the screen', () => {
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit'),
    row('child', '/clear', { lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(sessions, get);
  const child = get('child');
  assert.equal(child.summary, CONTINUATION_PREFIX + 'debug the terminal fit');
  assert.equal(child.summaryRaw, '/clear', 'a handoff heading or an agent prompt must not borrow');
  assert.equal(get('parent').summaryRaw, undefined, 'an untouched row grows no second field');
});

test('a second pass over the same rows changes nothing', () => {
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit'),
    row('child', '/clear', { lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(sessions, get);
  applyContinuationTitles(sessions, get);
  assert.equal(get('child').summary, CONTINUATION_PREFIX + 'debug the terminal fit');
  assert.equal(get('child').summaryRaw, '/clear');
});

test('confirming the rename box unchanged on a borrowed row stores no manual name (#358)', () => {
  // The prefill and the comparison must come from ONE source. When they differed, opening the rename on a
  // just-cleared row showed `/clear` while the comparison used the borrowed label, so pressing Enter
  // without typing stored `/clear` as a manual name — and a manual name switches the CLI's own title off
  // for good, which is the hand-over this whole route depends on.
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit'),
    row('child', '/clear', { lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(sessions, get);
  const child = get('child');
  const prefill = child.name || child.aiTitle || child.summaryRaw || child.summary;
  const fallback = child.aiTitle || child.summaryRaw || child.summary;
  assert.equal(resolveRenameTarget(prefill, fallback), null, 'unchanged confirm must store nothing');
  assert.equal(resolveRenameTarget('a name of my own', fallback), 'a name of my own');
});

test('a borrowed row that has gained the CLI’s own title is left alone', () => {
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit'),
    row('child', '/clear', { aiTitle: 'Scrollback check', lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(sessions, get);
  // The summary is still borrowed, but every display site prefers the aiTitle — that IS the hand-over.
  assert.equal(get('child').aiTitle || get('child').summary, 'Scrollback check');
});

// --- Who must NOT read the borrowed label ---------------------------------------------------------

// The pass rewrites `summary`, so every reader gets the borrowed name by default and the few that must
// not were opted out by hand. A hand-picked set with nothing naming it is how one gets forgotten, so the
// list lives here, by file, with the reason each is on it — and the guard fails when a named site stops
// asking for the row's own words.
//
// This is a WIRING guard: it reads source, so it cannot prove the value is right at run time, only that
// the site still asks the question. `test/clear-continuation-title.test.js`'s rename round-trip above is
// the behavioural half for the one of these three that writes to the database.
const READS_ITS_OWN_SUMMARY = [
  ['src/renderer/handoff/handoff.js', 'the suggested handoff name becomes a heading inside a written file'],
  ['src/renderer/session/session-health.js', 'the goal line is typed at an agent as what this session is doing'],
  ['src/renderer/shell/sidebar-session-row.js', 'an edited rename prefill is STORED as this session\'s manual name'],
];

test('every site that takes a summary off the screen reads the row\'s own words', () => {
  const { stripComments } = require('./helpers/strip-comments');
  for (const [rel, reason] of READS_ITS_OWN_SUMMARY) {
    const code = stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    assert.ok(code.includes('summaryRaw'), `${rel} must read summaryRaw before summary — ${reason}`);
    // …and it must come FIRST: `summary || summaryRaw` would answer with the borrowed label every time.
    assert.ok(/summaryRaw\s*\|\|\s*(?:session|s)\.summary/.test(code),
      `${rel} must spell it \`summaryRaw || …summary\`, in that order — ${reason}`);
  }
});

test('a row that has gained words of its own loses the borrowed-name marker with them', () => {
  // The renderer keeps ONE object per session across payloads, so a leftover `summaryRaw` is what the
  // handoff filename and the agent prompt read long after the row itself moved on.
  const { sessions, get } = mapOf([
    row('parent', 'debug the terminal fit'),
    row('child', '/clear', { lineageParentId: 'parent' }),
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('child').summaryRaw, '/clear');

  // The next payload: the session has typed something, so the backend answers null for it.
  const child = get('child');
  child.summary = 'now check the scrollback';
  child.openedWithCommand = null;
  applyContinuationTitles(sessions, get);
  assert.equal(child.summary, 'now check the scrollback');
  assert.equal(child.summaryRaw, undefined, 'the marker must not outlive the borrow');
});

test('a legacy row whose markup was sliced at 120 characters is still recognised', () => {
  // The reader stores at most 120 characters, so a row indexed before this landed can hold markup whose
  // tail is cut off. Recognising only the intact form let such a parent lend its markup to its child.
  const long = '<command-name>/it-admin:project_init</command-name>\n<command-message>it-admin:project_init</command-message>\n<command-args></command-args>'.slice(0, 120);
  assert.ok(!long.endsWith('>'), 'the fixture must actually be truncated');
  assert.equal(claude.openedWithCommand({ summary: long }), '/it-admin:project_init');

  const { sessions, get } = mapOf([
    { sessionId: 'stale', summary: long, openedWithCommand: claude.openedWithCommand({ summary: long }) },
    row('child', '/clear', { lineageParentId: 'stale' }),
  ]);
  applyContinuationTitles(sessions, get);
  assert.equal(get('child').summary, '/clear', 'a stale parent has no name to lend');
});

test('a first prompt that is nothing but a pasted path is not read as a command', () => {
  assert.equal(claude.openedWithCommand({ summary: '/usr/local/bin/foo' }), null);
  assert.equal(claude.openedWithCommand({ summary: '/etc/passwd' }), null);
});
