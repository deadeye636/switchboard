'use strict';
// Trust is per BACKEND (#171).
//
// The project manager had one button. It said "Trusted", it wrote Claude's ~/.claude.json — and Codex,
// which asks its own "Do you trust this directory?" and keeps the answer in its own config.toml, went on
// asking. The column spoke for everyone and answered for one.
//
// These pin Codex' side: reading and writing exactly one table of somebody else's TOML, without
// reformatting the rest of it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trust = require('../backends/codex/trust');
const backends = require('../backends');

// A config in the shape a real one has (read off a live install).
const REAL = `model = "gpt-5.5-codex"
sandbox = "unelevated"

[projects.'d:\\projekte\\example']
trust_level = "trusted"

[projects.'Z:\\temp']
trust_level = "trusted"

[marketplaces.openai-bundled]
last_updated = "2026-06-25T15:08:04Z"
source_type = "local"
`;

test('parseTrust reads every project table, verbatim', () => {
  const map = trust.parseTrust(REAL);
  assert.strictEqual(map.size, 2);
  assert.strictEqual(map.get('d:\\projekte\\example'), 'trusted');
  assert.strictEqual(map.get('Z:\\temp'), 'trusted');
});

test('parseTrust survives a config with no projects at all', () => {
  assert.strictEqual(trust.parseTrust('model = "x"\n').size, 0);
  assert.strictEqual(trust.parseTrust('').size, 0);
  assert.strictEqual(trust.parseTrust(null).size, 0);
});

test('setTrust adds a table without touching anything else', () => {
  const next = trust.setTrust(REAL, 'D:\\new\\project', true);

  // The new table is there...
  assert.match(next, /\[projects\.'D:\\new\\project'\]\ntrust_level = "trusted"/);
  // ...and every other line of somebody else's config survived, byte for byte.
  for (const line of ['model = "gpt-5.5-codex"', 'sandbox = "unelevated"', 'source_type = "local"',
    "[projects.'Z:\\temp']", '[marketplaces.openai-bundled]']) {
    assert.ok(next.includes(line), `must not lose: ${line}`);
  }
});

test('setTrust flips an existing table instead of adding a second one', () => {
  const next = trust.setTrust(REAL, 'Z:\\temp', false);
  const map = trust.parseTrust(next);

  assert.strictEqual(map.has('Z:\\temp'), false, 'the trust_level line is gone');
  assert.strictEqual((next.match(/\[projects\.'Z:\\temp'\]/g) || []).length, 1, 'and the table is not duplicated');
  // Untrusting REMOVES the level rather than writing "untrusted": the absence of a level is what Codex
  // reads as "ask me", and inventing a value it may not know is worse than saying nothing.
  assert.ok(!/trust_level\s*=\s*"untrusted"/.test(next));
  // The other project is untouched.
  assert.strictEqual(trust.parseTrust(next).get('d:\\projekte\\example'), 'trusted');
});

test('setTrust on a project that is not there, with trusted=false, changes nothing', () => {
  assert.strictEqual(trust.setTrust(REAL, 'D:\\never-seen', false), REAL);
});

test('a directory whose name contains an apostrophe does not corrupt somebody else\'s config', () => {
  // A TOML literal string cannot contain a single quote and has no escapes at all, so writing the table
  // header verbatim produced `[projects.'D:\Bob's stuff']` — not merely a wrong key, but INVALID TOML in
  // the middle of Codex' own config, which then fails to parse as a whole and takes every other setting
  // with it. Such a path goes in a basic string, where the backslashes are doubled.
  const p = "D:\\Bob's stuff";
  const next = trust.setTrust(REAL, p, true);

  assert.ok(!/\[projects\.'[^'\n]*'[^\]\n]/.test(next), 'no half-closed literal table header');
  assert.match(next, /\[projects\."D:\\\\Bob's stuff"\]/, 'a basic string, with the backslashes escaped');

  // And it reads back as the path it started as — not as the escaped text.
  assert.strictEqual(trust.parseTrust(next).get(p), 'trusted');

  // Flipping it finds the table it wrote, rather than appending a second one.
  const off = trust.setTrust(next, p, false);
  assert.strictEqual(trust.parseTrust(off).has(p), false);
  assert.strictEqual((off.match(/\[projects\."D:/g) || []).length, 1, 'no duplicate table');

  // Everything that was already in the file is still there.
  assert.strictEqual(trust.parseTrust(next).get('d:\\projekte\\example'), 'trusted');
});

test('the same directory in two spellings is one project', () => {
  // A real config carries BOTH `d:\projekte\x` and `D:\Projekte\x` — Codex writes whatever cwd it was
  // started with. Reading has to be case-insensitive on Windows, or a trusted project reads as untrusted
  // just because it was launched from a different shell.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), REAL);
    if (process.platform === 'win32') {
      assert.strictEqual(trust.get('D:\\Projekte\\Example'), true, 'same directory, other spelling');
    }
    assert.strictEqual(trust.get('d:\\projekte\\example'), true);
    assert.strictEqual(trust.get('D:\\not-in-there'), null, 'never asked is not the same as untrusted');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('set() writes atomically, keeps a .bak, and leaves the rest of the config alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust2-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const file = path.join(home, 'config.toml');
  try {
    fs.writeFileSync(file, "model = \"x\"\n\n[projects.'d:\\p']\ntrust_level = \"trusted\"\n");

    assert.deepStrictEqual(trust.set('d:\\p', false), { ok: true });

    const after = fs.readFileSync(file, 'utf8');
    assert.strictEqual(trust.parseTrust(after).size, 0, 'the project is no longer trusted');
    assert.ok(after.includes('model = "x"'), 'the rest of the config survives');
    assert.ok(fs.existsSync(file + '.bak'), 'a backup of somebody else\'s config, before we touch it');
    assert.ok(!fs.existsSync(file + '.tmp'), 'no temp file left behind');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('set() updates EVERY spelling of the path — on the platform where they are one directory', () => {
  // A real Windows config carries the same directory twice (`d:\projekte\x` and `D:\Projekte\x`) — Codex
  // writes whatever cwd it was started with. Untrusting only the spelling the user happened to click
  // would leave the project trusted through the other one.
  //
  // On a case-SENSITIVE filesystem those are two different directories, and treating them as one would
  // be the bug. So this is asserted where it is true, and the platform decides which that is — which is
  // exactly what `norm()` does.
  if (process.platform !== 'win32') return;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust3-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const file = path.join(home, 'config.toml');
  try {
    fs.writeFileSync(file, "model = \"x\"\n\n[projects.'d:\\p']\ntrust_level = \"trusted\"\n\n[projects.'D:\\P']\ntrust_level = \"trusted\"\n");

    assert.deepStrictEqual(trust.set('D:\\p', false), { ok: true });

    assert.strictEqual(trust.parseTrust(fs.readFileSync(file, 'utf8')).size, 0,
      'BOTH spellings are untrusted — leaving one behind would keep the project trusted for Codex');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- the contract ----------------------------------------------------------------------------------

test('a backend declares whether it HAS a project-trust gate — and only those that do, do', () => {
  // Claude keeps trust in ~/.claude.json, Codex in its config.toml. Pi has none (its settings.json
  // carries no trust), and Hermes has none (`trust_recent_files` is about files, not projects). A
  // backend that has no gate must not pretend to: the UI shows what is real.
  assert.strictEqual(typeof backends.get('claude').projectTrust?.get, 'function');
  assert.strictEqual(typeof backends.get('codex').projectTrust?.get, 'function');
  assert.strictEqual(backends.get('pi').projectTrust, undefined, 'Pi has no per-project trust');
  assert.strictEqual(backends.get('hermes').projectTrust, undefined, 'Hermes has none either');
});

test('every FILE backend can move a session to a new project path — and the db backend cannot', () => {
  // A remap has to move the whole project. Hermes keeps its cwd in a column of a database we open
  // read-only and may never write (#2914), so it declares nothing — and the manager says so instead of
  // silently leaving its sessions behind at the old path.
  for (const id of ['claude', 'codex', 'pi']) {
    assert.strictEqual(typeof backends.get(id).rewriteProjectPath, 'function', `${id} must be movable`);
  }
  assert.strictEqual(backends.get('hermes').rewriteProjectPath, undefined,
    'Hermes cannot be moved, and must not claim it can');
});

test('a template inherits its base backend\'s remap and delete — its sessions live in the base\'s store', () => {
  // An Axis-A template runs the base binary, which writes the base's format into the base's store. So the
  // base is also what can move those sessions and delete them. The template descriptor declared neither,
  // and the project manager therefore treated every template like Hermes: the remap left its sessions
  // behind at the old path, and the Remove dialog offered no switch for them while blaming a read-only
  // database that does not exist.
  const profile = { id: 'tpl-test', name: 'Test template', backendId: 'claude', options: {}, env: {} };
  const tpl = backends.profileToDescriptor(profile);
  const base = backends.get('claude');

  assert.strictEqual(tpl.rewriteProjectPath, base.rewriteProjectPath, 'the base moves the template\'s sessions');
  assert.strictEqual(tpl.deleteSessions, base.deleteSessions, 'and deletes them');

  // A template on a base that declares neither must not invent them.
  const onHermes = backends.profileToDescriptor({ id: 'tpl-h', name: 'On Hermes', backendId: 'hermes' });
  assert.strictEqual(onHermes.rewriteProjectPath, undefined);
  assert.strictEqual(onHermes.deleteSessions, undefined);
});
