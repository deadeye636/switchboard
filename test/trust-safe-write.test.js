'use strict';
// Both trust writers edit a file the CLI owns, so they write it the way every other such write goes
// (CLAUDE.md rule 11, #542).
//
// WHY THIS EXISTS:
//   Codex' `config.toml` and Pi's `trust.json` were written with a raw `fs.writeFileSync` into a temp file
//   and a rename. The rename is the property that was already there — a half-written config is impossible.
//   The other two were missing:
//
//   - No baseline. Both are read-modify-write over the WHOLE file, and the gap between the read and the
//     write is a user's reaction time in a dialog. Anything the CLI recorded in that gap is not overwritten
//     by a conflicting value — it is simply absent from the text handed back, and gone.
//   - No line endings. A `config.toml` that spells its lines CRLF came back LF, so trusting one project
//     rewrote every line of somebody else's configuration.
//
//   Neither shows up where the click happened: the trust level is set and the dialog closes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexTrust = require('../src/backends/codex/trust');
const piTrust = require('../src/backends/pi/trust');

/** Run `fn` with one environment variable set to a fresh directory, and clean both up afterwards. */
function withHome(varName, prefix, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = process.env[varName];
  process.env[varName] = home;
  try { return fn(home); } finally {
    if (prev === undefined) delete process.env[varName]; else process.env[varName] = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('Codex: a config.toml that spells its lines CRLF keeps them', () => {
  withHome('CODEX_HOME', 'codex-crlf-', (home) => {
    const file = path.join(home, 'config.toml');
    fs.writeFileSync(file, 'model = "x"\r\nsandbox = "unelevated"\r\n', 'utf8');

    assert.deepStrictEqual(codexTrust.set('d:\\p', true), { ok: true });

    const after = fs.readFileSync(file, 'utf8');
    assert.ok(!/(?<!\r)\n/.test(after), 'a CRLF config must not come back with LF lines');
    assert.strictEqual(codexTrust.parseTrust(after).size, 1, 'and the entry is still readable');
    assert.ok(after.includes('sandbox = "unelevated"'), 'the rest of the config survives');
  });
});

/**
 * Make the next read of `file` be followed by somebody else writing to it.
 *
 * The gap this closes exists only BETWEEN the writer's read and its write, so a test that writes before
 * calling the writer proves nothing — it just hands the writer newer text to read. `fs.readFileSync` is
 * patched for exactly one read of one path, which puts the other party's write inside the window.
 */
function otherWriterAfterNextRead(file, text) {
  const real = fs.readFileSync;
  let armed = true;
  fs.readFileSync = function (target, ...rest) {
    const out = real.call(fs, target, ...rest);
    if (armed && typeof target === 'string' && path.resolve(target) === path.resolve(file)) {
      armed = false;
      fs.writeFileSync(file, text, 'utf8');
    }
    return out;
  };
  return () => { fs.readFileSync = real; };
}

test('Codex: what the CLI wrote after our read is not overwritten', () => {
  withHome('CODEX_HOME', 'codex-race-', (home) => {
    const file = path.join(home, 'config.toml');
    fs.writeFileSync(file, 'model = "x"\n', 'utf8');

    // Codex recording something of its own AFTER we read and before we write — the window the baseline
    // exists for. Without it that entry is simply absent from the text we hand back.
    const restore = otherWriterAfterNextRead(file, 'model = "x"\n\n[mcp_servers.local]\ncommand = "node"\n');
    try {
      assert.deepStrictEqual(codexTrust.set('d:\\p', true), { ok: true });
    } finally { restore(); }

    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('[mcp_servers.local]'), "the CLI's own entry must still be there");
    assert.strictEqual(codexTrust.parseTrust(after).get('d:\\p'), 'trusted');
  });
});

test('Codex: no config yet is a create, not a refusal', () => {
  withHome('CODEX_HOME', 'codex-fresh-', (home) => {
    assert.deepStrictEqual(codexTrust.set('d:\\p', true), { ok: true });
    const after = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.strictEqual(codexTrust.parseTrust(after).get('d:\\p'), 'trusted');
  });
});

test('Pi: a write whose baseline no longer matches is refused, and the file is left alone', () => {
  withHome('PI_CODING_AGENT_DIR', 'pi-stale-', () => {
    const file = piTrust.trustPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const onDisk = '{\n  "/a": true\n}\n';
    fs.writeFileSync(file, onDisk, 'utf8');

    // A caller holding a baseline from before that text was written.
    const res = piTrust.writeTrustFile({ '/b': true }, file, { expectPrevious: '{}\n' });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stale, true, 'a moved file is reported as moved, not as a failure');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), onDisk, 'and nothing was written over it');
  });
});

test('Pi: set() re-derives against what the CLI wrote after our read', () => {
  withHome('PI_CODING_AGENT_DIR', 'pi-set-', () => {
    const file = piTrust.trustPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n', 'utf8');

    const theirs = path.resolve('/other');
    const restore = otherWriterAfterNextRead(file, JSON.stringify({ [theirs]: true }, null, 2) + '\n');
    const target = path.resolve('/target');
    try {
      assert.deepStrictEqual(piTrust.set(target, true), { ok: true });
    } finally { restore(); }

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after[target], true, 'our own answer landed');
    assert.strictEqual(after[theirs], true, 'and the one Pi recorded in the window survived');
  });
});

test('Pi: readTrustSource hands back the bytes it parsed', () => {
  // The baseline has to be the text the mutation was derived FROM. Reading the file a second time to get
  // it would be a second answer that can disagree with the first, which is the race this is meant to
  // close rather than reopen.
  withHome('PI_CODING_AGENT_DIR', 'pi-source-', () => {
    const file = piTrust.trustPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = '{\n  "/a": true\n}\n';
    fs.writeFileSync(file, text, 'utf8');

    const { raw, data } = piTrust.readTrustSource(file);
    assert.strictEqual(raw, text);
    assert.deepStrictEqual(data, { '/a': true });

    const missing = piTrust.readTrustSource(path.join(path.dirname(file), 'nope.json'));
    assert.strictEqual(missing.raw, null, 'no file is not empty text — it is no baseline at all');
    assert.deepStrictEqual(missing.data, {});
  });
});

test('neither trust writer reaches the filesystem on its own any more', () => {
  // A guard rather than a behaviour: the property this issue is about is invisible from the outside, and
  // the way it comes back is somebody adding a second write beside the safe one.
  const { stripComments } = require('./helpers/strip-comments');
  for (const rel of ['src/backends/codex/trust.js', 'src/backends/pi/trust.js']) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    assert.ok(!/fs\.writeFileSync|fs\.renameSync/.test(src),
      `${rel} must write through safe-write.js, not directly`);
    assert.ok(/writeTextFile/.test(src), `${rel} must use writeTextFile`);
  }
});
