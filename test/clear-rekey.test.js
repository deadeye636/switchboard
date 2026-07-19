'use strict';
// #223: after `/clear` with ≥2 live Claude sessions in one project folder, the transition detector used to
// bail ("ambiguous") — the source stayed running and the tab kept the dead id.
//
// It now takes the parent from a CLAIM the backend reported ("terminal <tag> ended session <id> by
// clearing"), and falls back to the single-live-session rule when there is none. (An earlier attempt
// resolved it by an mtime freeze; that was measured wrong on real data and reverted — see
// session-lineage.js. Do not reinstate it.)
//
// This drives the REAL detectSessionTransitions against a temp folder: the claim path is what ships, so it
// is what has to be exercised here. Asserting it on the pure resolver alone would leave the assembly —
// candidate building, the tag lookup, the equality guard, the re-key itself and the claim release —
// untested, which is exactly the gap a verifier caught after the first cut.
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
function setup(files, { claim = null } = {}) {
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
  const released = [];
  const activeSessions = new Map();
  transitions.init({
    PROJECTS_DIR: projectsDir,
    activeSessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    rekeyMcpServer: (from, to) => rekeyedMcp.push([from, to]),
    rekeySessionBackend: (from, to) => rekeyedBackend.push([from, to]),
    recordLineage: (childId, folder, parentId) => lineage.push([childId, folder, parentId]),
    // The claim the hook ingest would have recorded. Handed in the same way main.js does, so the
    // detector's own lookup (liveTags built from the candidates' tags) is what decides.
    getClearClaim: ({ liveTags } = {}) => (claim && (!liveTags || liveTags.includes(claim.tag)) ? claim : null),
    releaseClearClaim: (tag) => released.push(tag),
  });
  const addSession = (id, over = {}) => activeSessions.set(id, {
    exited: false, isPlainTerminal: false, projectFolder: folder,
    knownJsonlFiles: new Set(['parent.jsonl', 'other.jsonl']),
    knownSubagents: new Map(), ...over,
  });
  return { projectsDir, folder, folderPath, activeSessions, sent, rekeyedMcp, rekeyedBackend, lineage, released, addSession,
    cleanup: () => fs.rmSync(projectsDir, { recursive: true, force: true }) };
}

test('two live sessions in one folder → neither re-keys (no mis-key), whatever their mtimes', () => {
  const now = Date.now();
  // Even the tempting shape — one frozen just before the birth, one long idle — is refused: a bystander
  // that just finished a turn is indistinguishable from the true parent by mtime, and the parent's
  // think-time usually puts ITS freeze outside any window. So the folder-local signal is not trusted at all
  // once more than one session is live.
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 20000 },    // true parent, idle 20s (think-time)
    'bystander.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 2000 },  // finished a turn 2s ago
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  });
  try {
    s.addSession('parent');
    s.addSession('bystander');

    transitions.detectSessionTransitions(s.folder);

    assert.equal(s.activeSessions.has('parent'), true, 'nothing re-keyed');
    assert.equal(s.activeSessions.has('bystander'), true, 'the bystander is NOT mis-keyed onto the child');
    assert.equal(s.activeSessions.has('child'), false, 'the child was not claimed by a guess');
    assert.equal(s.sent.some(([ch]) => ch === 'session-forked'), false, 'no fold pushed');
    assert.deepEqual(s.lineage, [], 'no lineage recorded on an ambiguous clear');
  } finally { s.cleanup(); }
});

test('a single live session re-keys onto its /clear child and records the lineage', () => {
  const now = Date.now();
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 300 },
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  });
  try {
    s.addSession('parent', { knownJsonlFiles: new Set(['parent.jsonl']) });

    transitions.detectSessionTransitions(s.folder);

    assert.equal(s.activeSessions.has('child'), true, 'the lone session re-keys');
    assert.equal(s.activeSessions.has('parent'), false, 'the dead source id is gone');
    assert.deepEqual(s.sent.find(([ch]) => ch === 'session-forked'), ['session-forked', 'parent', 'child']);
    assert.deepEqual(s.rekeyedMcp, [['parent', 'child']], 'the MCP server followed');
    assert.deepEqual(s.rekeyedBackend, [['parent', 'child']], 'the backend overlay followed');
    // #193: the clear child's provenance is recorded (child, folder, parent) for the sidebar thread.
    assert.deepEqual(s.lineage, [['child', s.folder, 'parent']], 'the /clear lineage is persisted');
  } finally { s.cleanup(); }
});

// --- the claim path: what #223 was actually filed for -------------------------------------------------

test('THE HEADLINE: two live sessions, a claim names one → that one re-keys, the other is untouched', () => {
  const now = Date.now();
  // Deliberately the shape that fooled the reverted heuristic: the true parent has been idle (think-time
  // before typing /clear), the bystander finished a turn a moment ago. mtime would pick the bystander.
  // The claim is a fact from the CLI, so it picks correctly regardless.
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 20000 },
    'bystander.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 2000 },
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  }, { claim: { tag: 'tag-parent', sessionId: 'parent' } });
  try {
    s.addSession('parent', { _terminalTag: 'tag-parent' });
    s.addSession('bystander', { _terminalTag: 'tag-bystander' });

    transitions.detectSessionTransitions(s.folder);

    assert.equal(s.activeSessions.has('child'), true, 'the terminal that cleared re-keys onto its child');
    assert.equal(s.activeSessions.has('parent'), false, 'the dead source id is gone');
    assert.equal(s.activeSessions.has('bystander'), true, 'the bystander keeps its own session');
    assert.deepEqual(s.sent.find(([ch]) => ch === 'session-forked'), ['session-forked', 'parent', 'child']);
    assert.deepEqual(s.rekeyedMcp, [['parent', 'child']], 'the MCP server followed');
    assert.deepEqual(s.rekeyedBackend, [['parent', 'child']], 'the backend overlay followed');
    assert.deepEqual(s.lineage, [['child', s.folder, 'parent']], 'the /clear lineage is persisted');
    assert.deepEqual(s.released, ['tag-parent'], 'the claim is consumed, so it cannot win a later pairing');
  } finally { s.cleanup(); }
});

test('a claim naming the OTHER terminal re-keys that one — not whichever the file system suggests', () => {
  const now = Date.now();
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 20000 },
    'bystander.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 2000 },
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  }, { claim: { tag: 'tag-bystander', sessionId: 'bystander' } });
  try {
    s.addSession('parent', { _terminalTag: 'tag-parent' });
    s.addSession('bystander', { _terminalTag: 'tag-bystander' });

    transitions.detectSessionTransitions(s.folder);

    assert.equal(s.activeSessions.has('child'), true);
    assert.equal(s.activeSessions.has('bystander'), false, 'the claimed terminal is the one that moved');
    assert.equal(s.activeSessions.has('parent'), true, 'the unclaimed one is untouched');
    assert.deepEqual(s.lineage, [['child', s.folder, 'bystander']]);
  } finally { s.cleanup(); }
});

test('a claim for a terminal that is not live in this folder changes nothing', () => {
  // Its PTY exited between the clear and the child appearing, or it belongs to another project. Acting on
  // it would re-key a dead row onto a stranger's transcript.
  const now = Date.now();
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 20000 },
    'bystander.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 2000 },
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  }, { claim: { tag: 'tag-gone', sessionId: 'someone-else' } });
  try {
    s.addSession('parent', { _terminalTag: 'tag-parent' });
    s.addSession('bystander', { _terminalTag: 'tag-bystander' });

    transitions.detectSessionTransitions(s.folder);

    assert.equal(s.activeSessions.has('child'), false, 'nothing claimed the child');
    assert.equal(s.activeSessions.has('parent'), true);
    assert.equal(s.activeSessions.has('bystander'), true);
    assert.deepEqual(s.released, [], 'and no claim was consumed');
  } finally { s.cleanup(); }
});

test('sessions started before the binding existed carry no tag — a claim must not match them', () => {
  const now = Date.now();
  const s = setup({
    'parent.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 20000 },
    'bystander.jsonl': { content: '{"type":"user"}\n', mtimeMs: now - 2000 },
    'child.jsonl': { content: CLEAR_LINE + '\n' },
  }, { claim: { tag: 'tag-parent', sessionId: 'parent' } });
  try {
    s.addSession('parent');       // no _terminalTag
    s.addSession('bystander');
    transitions.detectSessionTransitions(s.folder);
    assert.equal(s.activeSessions.has('child'), false, 'an untagged session cannot be claimed');
    assert.equal(s.activeSessions.has('parent'), true);
  } finally { s.cleanup(); }
});

test('an ambiguous clear is RE-CHECKED, so a claim that arrives late still lands (#223 race)', () => {
  // The claim comes over HTTP from the CLI; this detection runs off an fs event. They race, and the file
  // event can win. If the child were marked "known" on that first pass, the claim would arrive to find
  // nothing left to pair with, and the terminal would keep a dead id for good.
  const now = Date.now();
  let claim = null;
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-clear-race-'));
  try {
    const folder = 'proj';
    fs.mkdirSync(path.join(projectsDir, folder));
    const write = (name, content, mtimeMs) => {
      const p = path.join(projectsDir, folder, name);
      fs.writeFileSync(p, content);
      if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    };
    write('parent.jsonl', '{"type":"user"}\n', now - 20000);
    write('bystander.jsonl', '{"type":"user"}\n', now - 2000);
    write('child.jsonl', CLEAR_LINE + '\n');

    const activeSessions = new Map();
    const released = [];
    transitions.init({
      PROJECTS_DIR: projectsDir,
      activeSessions,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
      log: { info() {}, warn() {}, debug() {}, error() {} },
      rekeyMcpServer: () => {},
      rekeySessionBackend: () => {},
      recordLineage: () => {},
      getClearClaim: ({ liveTags } = {}) => (claim && (!liveTags || liveTags.includes(claim.tag)) ? claim : null),
      releaseClearClaim: (t) => released.push(t),
    });
    const add = (id, tag) => activeSessions.set(id, {
      exited: false, isPlainTerminal: false, projectFolder: folder,
      knownJsonlFiles: new Set(['parent.jsonl', 'bystander.jsonl']),
      knownSubagents: new Map(), _terminalTag: tag,
    });
    add('parent', 'tag-parent');
    add('bystander', 'tag-bystander');

    // Pass 1: the child is there, the claim is not.
    transitions.detectSessionTransitions(folder);
    assert.equal(activeSessions.has('child'), false, 'nothing is guessed on the first pass');

    // The POST lands, and the next watcher event re-checks the same file.
    claim = { tag: 'tag-parent', sessionId: 'parent' };
    transitions.detectSessionTransitions(folder);

    assert.equal(activeSessions.has('child'), true, 'the late claim still re-keys the right terminal');
    assert.equal(activeSessions.has('parent'), false);
    assert.equal(activeSessions.has('bystander'), true);
    assert.deepEqual(released, ['tag-parent']);
  } finally { fs.rmSync(projectsDir, { recursive: true, force: true }); }
});
