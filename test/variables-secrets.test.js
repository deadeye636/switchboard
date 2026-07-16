'use strict';
// The secret side of saved variables (spec 12): encryption at rest, and the 0600 temp files a {ref}
// materializes.
//
// None of this was reachable by a test until app/variables.js was split out of main.js (#213, extraction
// 4) — main.js needs Electron, so nothing could require it, and `test/variable-insert.test.js` only ever
// covered the pure template grammar in shared/. The handler that decides whether a plaintext credential
// reaches a terminal had no test at all.
//
// What is being protected, and why each of these exists:
//  - a serialized variable must not carry its value unless asked (the list feeds the renderer);
//  - the temp file holding a decrypted secret must be 0600;
//  - EVERY failure path must unlink what the insert already wrote — a composed insert writes several
//    files and can fail late, and the age sweep is off by default, so nothing else would collect them;
//  - a resolved value containing a newline or ESC must never be inserted: it would be typed as Enter and
//    run whatever precedes it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const variables = require('../src/app/variables');

// A stand-in for Electron's safeStorage: reversible, and inspectable so a test can prove the stored bytes
// are not the plaintext.
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('not our ciphertext');
      return s.slice(4);
    },
  };
}

function setup(t, { rows = [], available = true, session = { shellType: 'bash', projectPath: null } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const touched = [];
  const warnings = [];
  const ctx = {
    dir,
    touched,
    warnings,
    activeSessions: new Map(session ? [['sess-1', session]] : []),
    getSetting: () => ({}),
    getSecretRefDir: () => path.join(dir, 'secret-refs'),
    safeStorage: fakeSafeStorage(available),
    db: {
      // listSavedVariables deliberately does NOT return `value` — that is what lets phase 1 decide
      // without decrypting anything. Modelled here, because a test that hands out the value would hide
      // the bug where phase 2 forgets to re-read the full row.
      listSavedVariables: () => rows.map(({ value, valueEncoding, ...rest }) => rest),
      listAllSavedVariables: () => rows.map(({ value, valueEncoding, ...rest }) => rest),
      getSavedVariable: (id) => byId.get(id) || null,
      saveSavedVariable: (row) => row,
      deleteSavedVariable: () => {},
      touchSavedVariable: (id) => touched.push(id),
    },
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
  };
  variables.init(ctx);
  return ctx;
}

// What a secret looks like in the DB: fakeSafeStorage's ciphertext, base64'd — the encoding
// encryptSavedVariableValue stores and decryptSavedVariableValue reads back.
const enc = (plaintext) => Buffer.from('enc:' + plaintext, 'utf8').toString('base64');

const secretRow = (over = {}) => ({
  id: 'v1', name: 'token', secret: 1, scope: 'global',
  value: enc('hunter2'), valueEncoding: 'safe-storage', insertTemplate: '', ...over,
});

// --- encryption at rest --------------------------------------------------------

test('a secret is encrypted at rest, and comes back out intact', (t) => {
  setup(t);
  const stored = variables.encryptSavedVariableValue('hunter2', true);

  assert.equal(stored.valueEncoding, 'safe-storage');
  assert.ok(!stored.value.includes('hunter2'), 'the stored bytes are not the plaintext');
  assert.equal(variables.decryptSavedVariableValue(stored), 'hunter2');
});

test('a non-secret is stored as-is — encryption is for secrets', (t) => {
  setup(t);
  assert.deepEqual(variables.encryptSavedVariableValue('plain', false), { value: 'plain', valueEncoding: 'plain' });
});

test('no keychain: a secret degrades to plain storage rather than crashing, and says so', (t) => {
  const ctx = setup(t, { available: false });
  const stored = variables.encryptSavedVariableValue('hunter2', true);

  assert.deepEqual(stored, { value: 'hunter2', valueEncoding: 'plain' });
  assert.match(ctx.warnings.join(' '), /safeStorage unavailable/, 'the fallback is logged, not silent');
});

test('a keychain that disappears after the value was encrypted is an error, not an empty string', (t) => {
  setup(t, { available: false });
  assert.throws(() => variables.decryptSavedVariableValue({ value: 'x', valueEncoding: 'safe-storage' }),
    /System secret storage is unavailable/);
});

// --- what leaves main --------------------------------------------------------

test('serializing a variable does not carry its value unless asked', (t) => {
  setup(t);
  const row = secretRow();

  const listed = variables.serializeSavedVariable(row);
  assert.equal('value' in listed, false, 'the list feeds the renderer — no plaintext rides along');
  assert.equal(listed.secret, true);

  const opened = variables.serializeSavedVariable(row, true);
  assert.equal(opened.value, 'hunter2', 'the editor asks for it explicitly');
});

// --- materialization -----------------------------------------------------------

test('a {ref} writes the plaintext to a 0600 file and inserts a shell read, not the secret', (t) => {
  const ctx = setup(t, { rows: [secretRow({ insertTemplate: '{ref}' })] });

  const out = variables.resolveVariableInsert('v1', 'sess-1');
  assert.equal(out.ok, true);
  assert.ok(!out.text.includes('hunter2'), 'the plaintext never reaches the terminal');

  const files = fs.readdirSync(path.join(ctx.dir, 'secret-refs'));
  assert.equal(files.length, 1);
  const file = path.join(ctx.dir, 'secret-refs', files[0]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hunter2', 'the file holds the decrypted value');
  assert.ok(out.text.includes(file), 'and the inserted text reads that file');
  // POSIX only, and not out of convenience: on Windows the mode bits are not what protects the file
  // (NTFS ACLs are), so asserting them there would assert nothing. This one only bites on Linux/macOS —
  // where it is also the only thing standing between the file and every other user on the box.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only');
  }
  assert.deepEqual(ctx.touched, ['v1'], 'lastUsedAt is stamped when the text actually reaches a terminal');
});

test('a shell that cannot read a file inline gets the clipboard fallback, and no file is written', (t) => {
  const ctx = setup(t, {
    rows: [secretRow({ insertTemplate: '{ref}' })],
    session: { shellType: 'cmd', projectPath: null },
  });

  const out = variables.resolveVariableInsert('v1', 'sess-1');
  assert.equal(out.fallback, 'copy');
  assert.equal(out.value, 'hunter2', 'the user asked for this one — handing it over to paste is the consent they gave');
  assert.equal(fs.existsSync(path.join(ctx.dir, 'secret-refs')), false, 'nothing was materialized');
});

test('a value with a newline is refused, and the file it already wrote is gone', (t) => {
  const ctx = setup(t, {
    rows: [secretRow({ value: enc('line1\nrm -rf /'), insertTemplate: '{path} {value}' })],
  });

  const out = variables.resolveVariableInsert('v1', 'sess-1');
  assert.equal(out.ok, false);
  assert.match(out.error, /line break or control character/);
  assert.deepEqual(fs.readdirSync(path.join(ctx.dir, 'secret-refs')), [],
    'the unwind ran — a newline would be typed as Enter and run what precedes it');
});

test('an ESC byte is refused the same way — the quick-pick sends text to the PTY raw', (t) => {
  setup(t, { rows: [secretRow({ value: enc('a\x1b[31mb'), insertTemplate: '{value}' })] });
  const out = variables.resolveVariableInsert('v1', 'sess-1');
  assert.equal(out.ok, false);
  assert.match(out.error, /line break or control character/);
});

test('an insert with no running session resolves nothing', (t) => {
  setup(t, { rows: [secretRow()], session: null });
  assert.deepEqual(variables.resolveVariableInsert('v1', 'sess-1'),
    { ok: false, error: 'No running session for this insert' });
});

test('a variable that does not exist is not an insert', (t) => {
  setup(t);
  assert.deepEqual(variables.resolveVariableInsert('nope', 'sess-1'),
    { ok: false, error: 'Variable not found' });
});

// A variable composed out of another one (#205). This is the case spec 12 calls out as the trap, and it
// is the reason phase 2 re-reads the full row: phase 1's nodes come from listSavedVariables, which does
// not select `value`. Materialize from those and a referenced secret writes an EMPTY temp file that its
// own {ref} then reads — the command still runs, with no credential in it, and nothing says a word.
// It needs a graph to catch, so it needs a test that builds one.
test('a referenced secret materializes its REAL value, not an empty file', (t) => {
  const ctx = setup(t, {
    rows: [
      // No quotes around the {var:} — a ref IS a complete shell word already, and the test below is what
      // happens if you wrap one.
      { id: 'root', name: 'login', secret: 0, scope: 'global', value: enc(''), valueEncoding: 'safe-storage', insertTemplate: 'curl -H Auth:{var:token}' },
      secretRow({ id: 'v1', name: 'token', insertTemplate: '{ref}' }),
    ],
  });

  const out = variables.resolveVariableInsert('root', 'sess-1');
  assert.equal(out.ok, true, out.error);

  const dir = path.join(ctx.dir, 'secret-refs');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, 'the referenced secret got a temp file');
  assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), 'hunter2',
    'and it holds the decrypted value — an empty file here is the silent failure: an empty credential');

  assert.ok(out.text.startsWith('curl -H Auth:'), 'the parent composed around the child');
  assert.ok(out.text.includes(files[0]), 'and the child resolved to a read of its own file');
  assert.ok(!out.text.includes('hunter2'), 'still no plaintext in the terminal');
  assert.deepEqual(ctx.touched, ['root'], 'only the variable the user picked is touched, not what it pulls in');
});

// The other half of the same story. A ref is a finished, pre-quoted shell word; wrapping one in quotes
// breaks it — and the quote can come from a resolved VALUE, not just the template, so this can only be
// judged after composition. Which is why the unwind exists: by the time we know, the file is written.
test('a referenced ref that lands inside quotes is refused — and its temp file does not survive', (t) => {
  const ctx = setup(t, {
    rows: [
      { id: 'root', name: 'login', secret: 0, scope: 'global', value: enc(''), valueEncoding: 'safe-storage', insertTemplate: 'curl -H "Auth: {var:token}"' },
      secretRow({ id: 'v1', name: 'token', insertTemplate: '{ref}' }),
    ],
  });

  const out = variables.resolveVariableInsert('root', 'sess-1');
  assert.equal(out.ok, false);
  assert.match(out.error, /inside double quotes/);
  assert.deepEqual(fs.readdirSync(path.join(ctx.dir, 'secret-refs')), [],
    'the secret it had already written is gone again');
});

test('a reference to a plain variable composes its text, and writes no file at all', (t) => {
  const ctx = setup(t, {
    rows: [
      { id: 'root', name: 'greet', secret: 0, scope: 'global', value: enc(''), valueEncoding: 'safe-storage', insertTemplate: 'echo {var:who}' },
      { id: 'v2', name: 'who', secret: 0, scope: 'global', value: 'world', valueEncoding: 'plain', insertTemplate: '{value}' },
    ],
  });

  const out = variables.resolveVariableInsert('root', 'sess-1');
  assert.deepEqual(out, { ok: true, text: 'echo world' });
  assert.equal(fs.existsSync(path.join(ctx.dir, 'secret-refs')), false, 'nothing to materialize');
});

test('variables that reference each other in a loop are refused before anything is written', (t) => {
  const ctx = setup(t, {
    rows: [
      { id: 'a', name: 'a', secret: 0, scope: 'global', value: enc(''), valueEncoding: 'safe-storage', insertTemplate: '{var:b}' },
      { id: 'b', name: 'b', secret: 0, scope: 'global', value: enc(''), valueEncoding: 'safe-storage', insertTemplate: '{var:a}' },
    ],
  });

  const out = variables.resolveVariableInsert('a', 'sess-1');
  assert.equal(out.ok, false);
  assert.match(out.error, /reference each other in a loop/);
  assert.equal(fs.existsSync(path.join(ctx.dir, 'secret-refs')), false,
    'phase 1 decided this — no plaintext was decrypted and no file exists');
});

// --- the lifecycle of what was written -----------------------------------------

test('a session\'s secret files are wiped when it stops, and other sessions\' are not', (t) => {
  const ctx = setup(t);
  const dir = path.join(ctx.dir, 'secret-refs');
  fs.mkdirSync(dir, { recursive: true });
  const mine = path.join(dir, 'mine');
  const theirs = path.join(dir, 'theirs');
  fs.writeFileSync(mine, 'a');
  fs.writeFileSync(theirs, 'b');
  variables.trackSecretRef(mine, 'sess-1');
  variables.trackSecretRef(theirs, 'sess-2');

  variables.cleanupSecretRefsForSession('sess-1');
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(theirs), true, 'another session is still using its own');

  variables.cleanupSecretRefsForSession('sess-2');
  assert.equal(fs.existsSync(theirs), false);
});

test('quit wipes every secret file — including strays nobody tracked', (t) => {
  const ctx = setup(t);
  const dir = path.join(ctx.dir, 'secret-refs');
  fs.mkdirSync(dir, { recursive: true });
  const tracked = path.join(dir, 'tracked');
  const stray = path.join(dir, 'stray');
  fs.writeFileSync(tracked, 'a');
  fs.writeFileSync(stray, 'b');
  variables.trackSecretRef(tracked, 'sess-1');

  variables.cleanupSecretRefs();
  assert.deepEqual(fs.readdirSync(dir), [], 'the directory sweep is the backstop for anything untracked');
});

test('the age sweep is opt-in: no maxAge, no deletions', (t) => {
  const ctx = setup(t);
  const dir = path.join(ctx.dir, 'secret-refs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'old');
  fs.writeFileSync(file, 'a');
  fs.utimesSync(file, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));

  variables.sweepSecretRefs(0);
  assert.equal(fs.existsSync(file), true, 'off by default');

  variables.sweepSecretRefs(60_000);
  assert.equal(fs.existsSync(file), false, 'an hour old, swept at a one-minute TTL');
});

test('tags are normalized: trimmed, deduped case-insensitively, and capped', (t) => {
  setup(t);
  assert.deepEqual(variables.normalizeSavedVariableTags(' a , A ,b, ,b '), ['a', 'b']);
  assert.equal(variables.normalizeSavedVariableTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 20);
  assert.equal(variables.normalizeSavedVariableTags(['x'.repeat(60)])[0].length, 40);
});
