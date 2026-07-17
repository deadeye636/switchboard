'use strict';
// #223: after `/clear` with ≥2 live Claude sessions in one project folder, the transition detector used to
// bail ("ambiguous") — the source stayed running and the tab kept the dead id. It now resolves the parent
// by the mtime freeze (session-lineage.js) and re-keys ONLY on high confidence. This drives the real
// detectSessionTransitions against a temp folder with two live sessions and a fresh /clear child, and
// asserts the correct one re-keys while the unrelated one is untouched.
//
// session-transitions.js takes its context through init(ctx) and requires no Electron, so this is a real
// integration test in node --test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const transitions = require('../src/session/session-transitions');

const CLEAR_LINE = JSON.stringify({ type: 'attachment', attachment: { hookEvent: 'SessionStart', hookName: 'SessionStart:clear' } });

// Build a temp PROJECTS_DIR/<folder> with the given files, set each file's mtime, and wire the detector.
function setup(files) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-clear-'));
  const folder = 'proj';
  const folderPath = path.join(projectsDir, folder);
  fs.mkdirSync(folderPath);
  for (const [name, { content, mtimeMs }] of Object.entries(files)) {
    const p = path.join(folderPath, name);
    fs.writeFileSync(p, content);
    if (mtimeMs != null) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  }
  const sent = [];
  const rekeyedMcp = [];
  const rekeyedBackend = [];
  const lineage = [];
  const activeSessions = new Map();
  transitions.init({
    PROJECTS_DIR: projectsDir,
    activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    rekeyMcpServer: (from, to) => rekeyedMcp.push([from, to]),
    rekeySessionBackend: (from, to) => rekeyedBackend.push([from, to]),
    recordLineage: (childId, folder, parentId) => lineage.push([childId, folder, parentId]),
  });
  const addSession = (id, over = {}) => activeSessions.set(id, {
    exited: false, isPlainTerminal: false, projectFolder: folder,
    knownJsonlFiles: new Set(['parent.jsonl', 'other.jsonl']),
    knownSubagents: new Map(), ...over,
  });
  return { projectsDir, folder, folderPath, activeSessions, sent, rekeyedMcp, rekeyedBackend, lineage, addSession,
    cleanup: () => fs.rmSync(projectsDir, { recursive: true, force: true }) };
}

test('the session frozen at the child\'s birth re-keys; the unrelated live session is untouched', () => {
  const now = Date.now();
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 300 },       // stopped just before the clear
    'other.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 10 * 60000 }, // unrelated, idle 10 min
    'child.jsonl': { content: CLEAR_LINE + '\n' },                              // fresh /clear child (birth ~now)
  });
  try {
    s.addSession('parent');
    s.addSession('other');

    transitions.detectSessionTransitions(s.folder);

    // The parent re-keyed onto the clear child.
    assert.equal(s.activeSessions.has('parent'), false, 'the dead source id is gone');
    assert.equal(s.activeSessions.has('child'), true, 're-keyed onto the clear child');
    assert.equal(s.activeSessions.get('child').realSessionId, 'child');
    assert.deepEqual(s.sent.find(([ch]) => ch === 'session-forked'), ['session-forked', 'parent', 'child'],
      'the renderer is told to fold the row onto the new id');
    assert.deepEqual(s.rekeyedMcp, [['parent', 'child']], 'the MCP server followed');
    assert.deepEqual(s.rekeyedBackend, [['parent', 'child']], 'the backend overlay followed');
    // #193: the clear child's provenance is recorded (child, folder, parent) for the sidebar thread.
    assert.deepEqual(s.lineage, [['child', s.folder, 'parent']], 'the /clear lineage is persisted');

    // The unrelated session is left exactly as it was.
    assert.equal(s.activeSessions.has('other'), true, 'the parallel session is untouched');
  } finally { s.cleanup(); }
});

test('two sessions both frozen at the birth stay ambiguous — neither re-keys (no mis-key)', () => {
  const now = Date.now();
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 200 },
    'other.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 400 }, // also frozen in the window
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  });
  try {
    s.addSession('parent');
    s.addSession('other');

    transitions.detectSessionTransitions(s.folder);

    // Genuine ambiguity → the deliberate bail holds; both rows stay, nothing re-keys.
    assert.equal(s.activeSessions.has('parent'), true);
    assert.equal(s.activeSessions.has('other'), true);
    assert.equal(s.activeSessions.has('child'), false, 'the child was not claimed by a guess');
    assert.equal(s.sent.some(([ch]) => ch === 'session-forked'), false, 'no fold was pushed');
  } finally { s.cleanup(); }
});

test('a single live session still re-keys (the pre-existing safe case)', () => {
  const now = Date.now();
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 300 },
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  });
  try {
    s.addSession('parent', { knownJsonlFiles: new Set(['parent.jsonl']) });

    transitions.detectSessionTransitions(s.folder);

    assert.equal(s.activeSessions.has('child'), true, 'the lone session re-keys as before');
    assert.equal(s.activeSessions.has('parent'), false);
  } finally { s.cleanup(); }
});
