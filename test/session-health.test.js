const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSessionFile } = require('../backends/claude/session-reader');
const sessionCache = require('../session-cache');
const {
  getSessionHealth,
  buildHandoffTemplate,
  buildHandoffRequestPrompt,
} = require('../src/renderer/session/session-health');

function writeJsonl(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-health-'));
  const filePath = path.join(dir, 'session-1.jsonl');
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return { dir, filePath };
}

test('readSessionFile derives usage and session-shape metrics from JSONL entries', () => {
  const { dir, filePath } = writeJsonl([
    {
      type: 'user',
      timestamp: '2026-06-15T08:00:00.000Z',
      message: { role: 'user', content: 'Start the work' },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-15T08:03:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Working' }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
      },
    },
    {
      type: 'user',
      timestamp: '2026-06-15T12:15:00.000Z',
      message: { role: 'user', content: 'one two three four five' },
    },
  ]);

  const session = readSessionFile(filePath, path.basename(dir), '/tmp/project');

  assert.equal(session.userMessageCount, 2);
  assert.equal(session.inputTokens, 10);
  assert.equal(session.outputTokens, 20);
  assert.equal(session.cacheCreationTokens, 30);
  assert.equal(session.cacheReadTokens, 40);
  assert.equal(session.largestUserPromptWords, 5);
  assert.equal(session.startedAt, '2026-06-15T08:00:00.000Z');
  assert.equal(session.lastEntryAt, '2026-06-15T12:15:00.000Z');
  assert.equal(session.activeMinutes, 255);
});

test('getSessionHealth ignores plain terminal sessions', () => {
  const result = getSessionHealth({ sessionId: 'terminal', type: 'terminal' });

  assert.equal(result.state, 'healthy');
  assert.equal(result.shouldWarn, false);
  assert.deepEqual(result.reasons, []);
});

test('getSessionHealth recommends handoff when multiple risk thresholds are crossed', () => {
  const result = getSessionHealth({
    sessionId: 'long-session',
    userMessageCount: 32,
    messageCount: 320,
    activeMinutes: 260,
    cacheReadTokens: 25_000_000,
    largestUserPromptWords: 2500,
  });

  assert.equal(result.state, 'handoff-recommended');
  assert.equal(result.label, 'Handoff Recommended');
  assert.equal(result.shouldWarn, true);
  assert.equal(result.tier, 'strong');
  assert.deepEqual(result.reasons.map(reason => reason.key), [
    'user-turns',
    'entries',
    'active-time',
    'cache-read',
    'big-paste',
  ]);
});

test('getSessionHealth does not recommend handoff for a single user prompt', () => {
  const result = getSessionHealth({
    sessionId: 'single-prompt-long-run',
    userMessageCount: 1,
    messageCount: 360,
    activeMinutes: 300,
    cacheReadTokens: 25_000_000,
    largestUserPromptWords: 2500,
  });

  assert.equal(result.state, 'marathon-risk');
  assert.equal(result.shouldWarn, true);
  assert.deepEqual(result.reasons.map(reason => reason.key), [
    'entries',
    'active-time',
    'cache-read',
    'big-paste',
  ]);
});

test('getSessionHealth still recommends handoff for multi-turn risky sessions below the user-turn threshold', () => {
  const result = getSessionHealth({
    sessionId: 'multi-turn-risky-run',
    userMessageCount: 2,
    messageCount: 360,
    activeMinutes: 300,
    cacheReadTokens: 25_000_000,
  });

  assert.equal(result.state, 'handoff-recommended');
  assert.equal(result.shouldWarn, true);
  assert.deepEqual(result.reasons.map(reason => reason.key), [
    'entries',
    'active-time',
    'cache-read',
  ]);
});

test('buildHandoffTemplate produces a copyable markdown packet from local facts', () => {
  const text = buildHandoffTemplate({
    sessionId: 's1',
    summary: 'Implement marathon guard',
    projectPath: '/Users/haydngynn/Projects/web/switchboard',
    userMessageCount: 42,
    cacheReadTokens: 1_800_000,
    activeMinutes: 300,
  });

  assert.match(text, /continuing from a long-running Switchboard session/);
  assert.match(text, /Implement marathon guard/);
  assert.match(text, /\/Users\/haydngynn\/Projects\/web\/switchboard/);
  assert.match(text, /42 user turns/);
  assert.match(text, /1\.8M cache-read tokens/);
  assert.match(text, /5h active time/);
});

test('buildHandoffRequestPrompt asks the running session to create a handoff', () => {
  const prompt = buildHandoffRequestPrompt({
    sessionId: 's1',
    summary: 'Implement marathon guard',
    projectPath: '/Users/haydngynn/Projects/web/switchboard',
    userMessageCount: 42,
    cacheReadTokens: 1_800_000,
    activeMinutes: 300,
  });

  assert.match(prompt, /Create a concise handoff/);
  assert.match(prompt, /Use your current session context/);
  assert.match(prompt, /Implement marathon guard/);
  assert.match(prompt, /42 user turns/);
  assert.match(prompt, /Do not continue implementing/);
});

test('buildProjectsFromCache exposes health metrics on renderer session rows', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-project-'));
  sessionCache.init({
    PROJECTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-projects-')),
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: console,
    db: {
      getAllMeta: () => new Map(),
      getAllCached: () => [{
        sessionId: 's1',
        folder: 'folder',
        projectPath,
        summary: 'Long session',
        firstPrompt: 'Long session',
        created: '2026-06-15T08:00:00.000Z',
        modified: '2026-06-15T12:15:00.000Z',
        messageCount: 320,
        userMessageCount: 32,
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationTokens: 300,
        cacheReadTokens: 25_000_000,
        largestUserPromptWords: 2500,
        startedAt: '2026-06-15T08:00:00.000Z',
        lastEntryAt: '2026-06-15T12:15:00.000Z',
        activeMinutes: 255,
      }],
      getSetting: () => null,
      setFolderMeta: () => {},
      // The sidebar is built from the register now (#167): a project that is not on it is not shown, so a
      // fake that knows nothing about it renders an empty list and the assertions below have nothing to
      // read. This one is on it.
      getProjectMeta: () => null,
      getProjectStates: () => new Map([[projectPath, { registered: 1 }]]),
    },
  });

  const projects = sessionCache.buildProjectsFromCache(false);
  const [session] = projects[0].sessions;

  assert.equal(session.userMessageCount, 32);
  assert.equal(session.cacheReadTokens, 25_000_000);
  assert.equal(session.largestUserPromptWords, 2500);
  assert.equal(session.activeMinutes, 255);
});
