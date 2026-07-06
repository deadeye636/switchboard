const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionTransitions = require('../session-transitions');
const { detectSubagentTransitions, detectSessionTransitions, init, readNewSessionSignals } = sessionTransitions;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-st-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a mock mainWindow that records every webContents.send call. */
function makeMockWindow() {
  const events = [];
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => events.push({ channel, payload }),
    },
    _events: events,
  };
}

/** Initialize the module with mocks. Returns the recorded-events array. */
function setupModule() {
  const win = makeMockWindow();
  init({
    PROJECTS_DIR: '/unused',
    activeSessions: new Map(),
    getMainWindow: () => win,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    rekeyMcpServer: () => {},
  });
  return win._events;
}

/** Create N agent jsonl files under <folder>/<sessionId>/subagents/ and
 *  set their mtimes to (now - ageMs). Returns the subagents dir. */
function seedAgents(folder, sessionId, agents) {
  const subDir = path.join(folder, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  for (const { id, ageMs = 0, content = '' } of agents) {
    const filePath = path.join(subDir, `agent-${id}.jsonl`);
    fs.writeFileSync(filePath, content, 'utf8');
    if (ageMs) {
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(filePath, t, t);
    }
  }
  return subDir;
}

test('readNewSessionSignals keeps earlier signals when the last line is truncated (issue #76)', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 's.jsonl');
    // Valid fork signal + a snapshot, then a truncated (invalid JSON) last line —
    // the fixed 512 KB read almost always truncates the tail. The old code threw
    // on the bad line and discarded forkedFrom; per-line try/catch must keep it.
    const lines = [
      JSON.stringify({ forkedFrom: { sessionId: 'parent-123' }, slug: 'my-slug' }),
      JSON.stringify({ type: 'file-history-snapshot' }),
      '{"type":"user","message":{"role":"user","content":"hel',  // truncated
    ];
    fs.writeFileSync(file, lines.join('\n'), 'utf8');

    const sig = readNewSessionSignals(file);
    assert.equal(sig.forkedFrom, 'parent-123');
    assert.equal(sig.slug, 'my-slug');
    assert.equal(sig.hasSnapshots, true);
  } finally {
    cleanup(dir);
  }
});

test('bootstrap call with 5 pre-existing subagents emits zero events and populates the map', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent-session';
    seedAgents(tmp, sessionId, [
      { id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }, { id: 'a5' },
    ]);

    const session = {}; // knownSubagents undefined → bootstrap
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0, 'bootstrap must not emit IPC');
    assert.ok(session.knownSubagents instanceof Map);
    assert.equal(session.knownSubagents.size, 5);
  } finally {
    cleanup(tmp);
  }
});

test('bootstrap marks an old-mtime agent (>60s) as completed: true', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'oldie', ageMs: 120_000 }]); // 2 minutes old

    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0);
    const entry = session.knownSubagents.get('oldie');
    assert.ok(entry, 'expected an entry for oldie');
    assert.equal(entry.completed, true);
    assert.ok(entry._completedAt, 'expected _completedAt to be stamped');
  } finally {
    cleanup(tmp);
  }
});

test('bootstrap marks a fresh-mtime agent as completed: false (lifecycle continues)', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'fresh', ageMs: 5_000 }]); // 5s old, well under 60s

    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0, 'bootstrap must still be silent for fresh agents');
    const entry = session.knownSubagents.get('fresh');
    assert.ok(entry);
    assert.equal(entry.completed, false);
    assert.equal(entry._completedAt, null);
  } finally {
    cleanup(tmp);
  }
});

test('post-bootstrap: a brand-new agent file emits exactly one subagent-spawned event', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    // First, bootstrap with empty subagents dir
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.length, 0);
    assert.equal(session.knownSubagents.size, 0);

    // Now drop in a new agent file and re-run
    seedAgents(tmp, sessionId, [{ id: 'newcomer' }]);
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
    assert.equal(events[0].channel, 'subagent-spawned');
    assert.equal(events[0].payload.parentSessionId, sessionId);
    assert.equal(events[0].payload.agentId, 'newcomer');
    assert.equal(session.knownSubagents.get('newcomer').completed, false);
  } finally {
    cleanup(tmp);
  }
});

test('post-bootstrap with no new agents emits zero events (IPC-flood regression)', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    const session = {};
    // Bootstrap absorbs all three silently
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.length, 0);

    // Subsequent flushes with no new files must stay silent
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0, 'no events should fire when nothing changed');
  } finally {
    cleanup(tmp);
  }
});

// --- detectSessionTransitions: /clear (and fork regression) ---

/** Init the module against a real tmp PROJECTS_DIR. Returns controllable state. */
function initSessions(projectsDir) {
  const events = [];
  const rekeys = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, ...args) => events.push({ channel, args }) },
  };
  const activeSessions = new Map();
  init({
    PROJECTS_DIR: projectsDir,
    activeSessions,
    getMainWindow: () => win,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    rekeyMcpServer: (oldId, newId) => rekeys.push([oldId, newId]),
  });
  return { events, rekeys, activeSessions };
}

function makeFolder(projectsDir, folder) {
  const p = path.join(projectsDir, folder);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Write a fresh session file whose head carries a SessionStart:<source> marker. */
function writeSessionStartFile(folderPath, newId, source = 'clear') {
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: newId }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', isSnapshotUpdate: false }),
    JSON.stringify({ type: 'attachment', parentUuid: null, attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'SessionStart:' + source } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  ];
  fs.writeFileSync(path.join(folderPath, newId + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

function registerPtySession(activeSessions, id, folder, known, extra = {}) {
  const session = {
    exited: false, isPlainTerminal: false, projectFolder: folder,
    knownJsonlFiles: new Set(known), forkFrom: null, ...extra,
  };
  activeSessions.set(id, session);
  return session;
}

test('clear: single active PTY session in folder → rekeys to the new session id', () => {
  const tmp = mkTmp();
  try {
    const folder = 'proj';
    const folderPath = makeFolder(tmp, folder);
    const oldId = 'old-sess', newId = 'new-sess';
    fs.writeFileSync(path.join(folderPath, oldId + '.jsonl'), '{"type":"user"}\n', 'utf8');

    const { events, rekeys, activeSessions } = initSessions(tmp);
    const session = registerPtySession(activeSessions, oldId, folder, [oldId + '.jsonl']);
    writeSessionStartFile(folderPath, newId, 'clear');

    detectSessionTransitions(folder);

    assert.deepEqual(rekeys, [[oldId, newId]], 'MCP server must be re-keyed old→new');
    assert.ok(activeSessions.has(newId) && !activeSessions.has(oldId), 'map re-keyed');
    assert.equal(session.realSessionId, newId);
    const forked = events.filter(e => e.channel === 'session-forked');
    assert.equal(forked.length, 1);
    assert.deepEqual(forked[0].args, [oldId, newId]);
  } finally {
    cleanup(tmp);
  }
});

test('clear: SessionStart:startup (not :clear) does not rekey', () => {
  const tmp = mkTmp();
  try {
    const folder = 'proj';
    const folderPath = makeFolder(tmp, folder);
    const oldId = 'old-sess', newId = 'new-sess';
    fs.writeFileSync(path.join(folderPath, oldId + '.jsonl'), '{"type":"user"}\n', 'utf8');

    const { events, rekeys, activeSessions } = initSessions(tmp);
    registerPtySession(activeSessions, oldId, folder, [oldId + '.jsonl']);
    writeSessionStartFile(folderPath, newId, 'startup');

    detectSessionTransitions(folder);

    assert.equal(rekeys.length, 0, 'startup is not a clear — no rekey');
    assert.ok(activeSessions.has(oldId) && !activeSessions.has(newId));
    assert.equal(events.filter(e => e.channel === 'session-forked').length, 0);
  } finally {
    cleanup(tmp);
  }
});

test('clear: no active Switchboard session in the folder (external clear) is ignored', () => {
  const tmp = mkTmp();
  try {
    const clearFolder = 'proj', otherFolder = 'other';
    const clearPath = makeFolder(tmp, clearFolder);
    makeFolder(tmp, otherFolder);
    const newId = 'new-sess';

    const { rekeys, activeSessions } = initSessions(tmp);
    // Only active session lives in a DIFFERENT folder.
    registerPtySession(activeSessions, 'unrelated', otherFolder, ['unrelated.jsonl']);
    writeSessionStartFile(clearPath, newId, 'clear');

    detectSessionTransitions(clearFolder);

    assert.equal(rekeys.length, 0, 'external clear must not touch unrelated sessions');
    assert.ok(!activeSessions.has(newId));
  } finally {
    cleanup(tmp);
  }
});

test('clear: two active sessions in same folder is ambiguous → skip (no rekey)', () => {
  const tmp = mkTmp();
  try {
    const folder = 'proj';
    const folderPath = makeFolder(tmp, folder);
    const idA = 'sess-a', idB = 'sess-b', newId = 'new-sess';
    fs.writeFileSync(path.join(folderPath, idA + '.jsonl'), '{"type":"user"}\n', 'utf8');
    fs.writeFileSync(path.join(folderPath, idB + '.jsonl'), '{"type":"user"}\n', 'utf8');

    const { rekeys, activeSessions } = initSessions(tmp);
    const known = [idA + '.jsonl', idB + '.jsonl'];
    registerPtySession(activeSessions, idA, folder, known);
    registerPtySession(activeSessions, idB, folder, known);
    writeSessionStartFile(folderPath, newId, 'clear');

    detectSessionTransitions(folder);

    assert.equal(rekeys.length, 0, 'ambiguous → must not guess');
    assert.ok(activeSessions.has(idA) && activeSessions.has(idB) && !activeSessions.has(newId));
  } finally {
    cleanup(tmp);
  }
});

test('fork regression: forkedFrom pointing at the active session still rekeys', () => {
  const tmp = mkTmp();
  try {
    const folder = 'proj';
    const folderPath = makeFolder(tmp, folder);
    const oldId = 'old-sess', newId = 'new-sess';
    fs.writeFileSync(path.join(folderPath, oldId + '.jsonl'), '{"type":"user"}\n', 'utf8');
    const forkLines = [
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', isSnapshotUpdate: false }),
      JSON.stringify({ forkedFrom: { sessionId: oldId }, type: 'user', sessionId: newId, message: { role: 'user', content: 'hi' } }),
    ];
    fs.writeFileSync(path.join(folderPath, newId + '.jsonl'), forkLines.join('\n') + '\n', 'utf8');

    const { rekeys, activeSessions } = initSessions(tmp);
    const session = registerPtySession(activeSessions, oldId, folder, [oldId + '.jsonl'], { forkFrom: oldId });

    detectSessionTransitions(folder);

    assert.deepEqual(rekeys, [[oldId, newId]]);
    assert.equal(session.realSessionId, newId);
  } finally {
    cleanup(tmp);
  }
});

test('completion: agent alive on call N, stable mtime for >30s on call N+1, emits subagent-completed', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    const subDir = seedAgents(tmp, sessionId, [{ id: 'slow' }]);
    const filePath = path.join(subDir, 'agent-slow.jsonl');
    const mtimeMs = fs.statSync(filePath).mtimeMs;

    // Pre-seed knownSubagents as if a prior call already saw this agent alive
    // and started the stability timer 31 seconds ago. This skips bootstrap mode
    // since knownSubagents is already defined.
    const session = { knownSubagents: new Map() };
    session.knownSubagents.set('slow', {
      mtimeMs, // same as file's actual mtime → "mtime stable"
      completed: false,
      _stableStart: Date.now() - 31_000, // stability started >30s ago
    });

    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 1, `expected 1 completion event, got ${events.length}: ${JSON.stringify(events)}`);
    assert.equal(events[0].channel, 'subagent-completed');
    assert.equal(events[0].payload.parentSessionId, sessionId);
    assert.equal(events[0].payload.agentId, 'slow');
    assert.equal(session.knownSubagents.get('slow').completed, true);
  } finally {
    cleanup(tmp);
  }
});
