'use strict';
// #457 — a thrown message is not a message for the user, and a reviewer's memory is not a guard.
//
// #444 established the rule for one surface. The same defect was then found in four more places, all
// written the same way and all invisible to the suite: `catch (err) { return { ok: false, error:
// err.message } }`, where that object crosses IPC and lands in a dialog. The message names the file it
// failed on, which is always somewhere under the user's home.
//
// So the rule is DERIVED rather than listed. `test/store-isolation.test.js` learned this the hard way:
// a hand-written list of files silently stops covering the code, because a file added later is simply
// never looked at. This walks every source file instead, and an exemption has to be written down with
// a reason — which also means the exemption list cannot rot, because a file that stops matching is
// reported too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

/**
 * A returned field that carries a caught error's own text.
 *
 * Matched on the shape rather than on a name: `error:`/`reason:`/`message:` taking `<something>.message`
 * off an identifier that reads like a caught error, or the error itself. Interpolating it into a
 * template counts too — `` `failed: ${err.message}` `` is the same string with a prefix.
 */
const OFFENDER = /(?<![.\w'"])(?:error|reason|message)\s*:\s*(?:`[^`]*\$\{\s*)?(?:String\(\s*)?\b(?:err|error|e|ex|_err)\b(?:\s*&&\s*\b(?:err|error|e|ex|_err)\b)?\s*(?:\.message)?\s*(?:\)|\}|,|\?|$)/;

// A line that names one of these is not reporting a caught error, whatever it looks like.
const NOT_AN_ERROR_FIELD = /^\s*(?:\/\/|\*)/;

/**
 * Where a thrown message may still be forwarded, and why.
 *
 * Key is the repo-relative path; the value is the reason. An entry whose file no longer matches is
 * reported as a stale exemption — the list is not allowed to outlive what it covers.
 */
const ALLOWED = {
  'workers/search-query.js':
    'A worker answering its own client over postMessage. The message is logged by the index layer and '
    + 'never rendered — the search UI reports "no results", not a reason.',
  'db/compact.js':
    'Its result never reaches a window. `src/app/db-upkeep.js` is the only reader and it builds a log '
    + 'line out of it, so the SQLite message is already where a dropped message would have been sent.',
  'workers/scan-projects.js':
    'Same: a worker channel, not an IPC reply. What the renderer eventually sees is a project list that '
    + 'came back empty, and the reason belongs in the log beside it.',
};

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The bundle is generated, and the renderer never catches a main-process error in the first place.
      if (entry.name === 'node_modules' || entry.name === 'renderer') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function offendingLines(file) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const hits = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (NOT_AN_ERROR_FIELD.test(line)) return;
    if (OFFENDER.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
  return { rel, hits };
}

test('no main-process module hands a thrown message to the renderer', () => {
  const found = [];
  for (const file of sourceFiles(SRC)) {
    const { rel, hits } = offendingLines(file);
    if (!hits.length || ALLOWED[rel]) continue;
    found.push(...hits);
  }
  assert.deepEqual(found, [],
    'These put a caught error\'s own text into a result the renderer shows. It names the path it failed '
    + 'on. Word it through src/app/readable-error.js, or write the sentence yourself, or add the file to '
    + 'ALLOWED here with the reason:\n' + found.join('\n'));
});

test('every exemption still covers something', () => {
  const stale = [];
  for (const rel of Object.keys(ALLOWED)) {
    const full = path.join(SRC, rel);
    if (!fs.existsSync(full)) { stale.push(`${rel} — the file is gone`); continue; }
    if (!offendingLines(full).hits.length) stale.push(`${rel} — nothing in it matches any more`);
  }
  assert.deepEqual(stale, [],
    'An exemption that covers nothing is a claim nobody checks. Remove it:\n' + stale.join('\n'));
});

test('every exemption says why', () => {
  for (const [rel, reason] of Object.entries(ALLOWED)) {
    assert.ok(reason && reason.length > 30, `${rel} needs a reason, not a placeholder`);
  }
});

// The guard has to be able to fail, or it is decoration. These are the exact shapes found in the wild.
test('the pattern catches what it was written for', () => {
  const wild = [
    'return { ok: false, error: err.message };',
    'return { ok: false, reason: err && err.message ? err.message : \'fallback\' };',
    'return { ok: false, error: err.message, written };',
    'return { ok: false, error: String(err) };',
    'catch (e) { return { ok: false, error: e.message }; }',
    'return { ok: false, message: `could not write: ${err.message}` };',
  ];
  for (const line of wild) assert.ok(OFFENDER.test(line), `missed: ${line}`);

  const fine = [
    "return { ok: false, error: 'path outside a plans directory' };",
    "return { ok: false, error: readableError(err, 'Could not save that plan.') };",
    "return { ok: false, reason: 'That path is not a discovered resource for this backend.' };",
    'ctx.log.error(\'[settings] export failed:\', err.message);',
    "return { ok: false, error: `Codex' trust file could not be written (${err && err.code ? err.code : 'unknown error'}).` };",
  ];
  for (const line of fine) assert.ok(!OFFENDER.test(line), `false positive: ${line}`);
});
