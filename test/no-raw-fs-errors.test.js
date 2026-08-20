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
 * Every way a caught error's own text has been seen reaching a reader.
 *
 * Three patterns rather than one, because the first version of this guard had exactly one and an
 * adversarial review walked past it twice:
 *
 *   FIELD    `error: err.message` and its family — the shape the original sweep was written for.
 *   JOINED   `'Scan failed: ' + msg.error` and `` `died: ${err.message}` `` — string building, which
 *            never has a field colon in front of it. This is not hypothetical: it was the live leak
 *            the first guard missed, painting a scandir error into the status bar.
 *   SPLIT    a field and its value on separate lines. Nothing in the tree does this today, but a
 *            formatter rewrapping one of these blocks would have silently left the guard's coverage.
 *
 * The file is scanned as a whole for SPLIT, line by line for the other two, so a report can name a line.
 */
const FIELD = /(?<![.\w'"])(?:error|reason|message)\s*:\s*(?:`[^`]*\$\{\s*)?(?:String\(\s*)?\b(?:err|error|e|ex|_err|msg)\b(?:\s*&&\s*\b(?:err|error|e|ex|_err|msg)\b)?\s*(?:\.(?:message|error))?\s*(?:\)|\}|,|\?|$)/;
const JOINED = /(?:\+\s*|\$\{\s*)\b(?:err|error|e|ex|_err|msg)\b\s*(?:&&\s*\b(?:err|error|e|ex|_err|msg)\b\s*)?\.(?:message|stack|error)\b/;
const SPLIT = /(?<![.\w'"])(?:error|reason|message)\s*:\s*\r?\n\s*\b(?:err|error|e|ex|_err|msg)\b\s*(?:&&[^\n]*)?\.(?:message|error)\b/;

// A comment, or a line whose only mention of the error goes to a logger. The log is where the raw text
// is SUPPOSED to end up, so flagging it would make the guard argue against its own remedy.
const NOT_A_LEAK = /^\s*(?:\/\/|\*)|(?:\blog\.\w+\(|\bconsole\.\w+\(|\bctx\.log\.\w+\()/;

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
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (NOT_A_LEAK.test(line)) return;
    if (FIELD.test(line) || JOINED.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
  // The split shape spans lines, so it is looked for in the whole file and reported by offset.
  const split = SPLIT.exec(src);
  if (split) {
    const line = src.slice(0, split.index).split(/\r?\n/).length;
    hits.push(`${rel}:${line}  ${split[0].replace(/\s+/g, ' ')}`);
  }
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

// The guard has to be able to fail, or it is decoration. Every line below was in the tree at some point;
// the JOINED ones are the shapes the first version of this guard walked straight past, one of which was
// painting a scandir error into the status bar while the guard reported success.
const catches = (line) => FIELD.test(line) || JOINED.test(line);

test('the patterns catch what they were written for', () => {
  const wild = [
    // FIELD
    'return { ok: false, error: err.message };',
    'return { ok: false, reason: err && err.message ? err.message : \'fallback\' };',
    'return { ok: false, error: err.message, written };',
    'return { ok: false, error: String(err) };',
    'catch (e) { return { ok: false, error: e.message }; }',
    'return { ok: false, message: `could not write: ${err.message}` };',
    // JOINED — no field colon anywhere, which is why the first guard could not see them
    "sendStatus('Scan failed: ' + msg.error, 'error');",
    "sendStatus('Worker error: ' + err.message, 'error');",
    "return { error: 'Cannot read ~/.claude.json: ' + err.message };",
    'throw new Error(`Failed to read the trust store: ${err.message}`);',
    "toast('Error: ' + e.message);",
    'return { ok: false, error: `spawn failed: ${err.stack}` };',
  ];
  for (const line of wild) assert.ok(catches(line), `missed: ${line}`);

  const fine = [
    "return { ok: false, error: 'path outside a plans directory' };",
    "return { ok: false, error: readableError(err, 'Could not save that plan.') };",
    "return { ok: false, reason: 'That path is not a discovered resource for this backend.' };",
    "return { ok: false, error: `Codex' trust file could not be written (${err && err.code ? err.code : 'unknown error'}).` };",
  ];
  for (const line of fine) assert.ok(!catches(line), `false positive: ${line}`);

  // A logger is where the raw text is SUPPOSED to go, so these must not be flagged even though they
  // match a shape. A guard that argues against its own remedy gets switched off.
  const logs = [
    'ctx.log.error(\'[settings] export failed:\', err.message);',
    "log.warn('[launcher] external launch failed: ' + err.message);",
    "console.error('Worker error:', err.message);",
    "ctx.log.warn('[db-upkeep] pass failed:', err && err.message ? err.message : err);",
  ];
  for (const line of logs) assert.ok(NOT_A_LEAK.test(line), `wrongly flagged a log call: ${line}`);
});

test('the split-across-lines shape is caught too', () => {
  // Nothing in the tree is written this way today. The point is that a formatter rewrapping one of the
  // FIELD lines above must not carry it out of the guard's sight.
  const wrapped = 'try { x(); } catch (err) {\n  return {\n    ok: false,\n    error:\n      err.message,\n  };\n}';
  assert.ok(SPLIT.test(wrapped));
  assert.ok(!SPLIT.test('const error =\n  buildMessage();'), 'an ordinary wrapped assignment is not this');
});
