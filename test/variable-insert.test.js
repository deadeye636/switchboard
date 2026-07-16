const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultInsertTemplate,
  shellRefFor,
  substituteInsertTemplate,
  effectiveTemplate,
  forceRefForNested,
  finalTemplateFor,
  parseVarRefs,
  resolveVarGraph,
  buildNameIndex,
  compose,
  scanRefSafety,
} = require('../public/variable-insert');

test('defaultInsertTemplate: secret → {ref}, non-secret → {value}', () => {
  assert.equal(defaultInsertTemplate(true), '{ref}');
  assert.equal(defaultInsertTemplate(false), '{value}');
  // Coerces truthy/falsy the same way (the handler passes !!row.secret).
  assert.equal(defaultInsertTemplate(1), '{ref}');
  assert.equal(defaultInsertTemplate(0), '{value}');
});

test('shellRefFor: bash/zsh/sh use "$(cat \'...\')" with POSIX quoting', () => {
  assert.equal(shellRefFor('bash', '/tmp/secret'), `"$(cat '/tmp/secret')"`);
  assert.equal(shellRefFor('zsh', '/tmp/secret'), `"$(cat '/tmp/secret')"`);
  assert.equal(shellRefFor('sh', '/tmp/secret'), `"$(cat '/tmp/secret')"`);
});

test('shellRefFor: bash escapes embedded single quotes as \'\\\'\'', () => {
  assert.equal(
    shellRefFor('bash', "/tmp/o'brien"),
    `"$(cat '/tmp/o'\\''brien')"`
  );
});

test('shellRefFor: pwsh/powershell use Get-Content -Raw with doubled-quote escaping', () => {
  assert.equal(
    shellRefFor('pwsh', 'C:\\secret-refs\\abc'),
    `(Get-Content -Raw 'C:\\secret-refs\\abc')`
  );
  assert.equal(
    shellRefFor('powershell', "C:\\o'brien"),
    `(Get-Content -Raw 'C:\\o''brien')`
  );
});

test('shellRefFor: cmd/unknown/WSL/empty return null (no inline ref)', () => {
  assert.equal(shellRefFor('cmd', '/tmp/x'), null);
  assert.equal(shellRefFor('unknown', '/tmp/x'), null);
  assert.equal(shellRefFor('wsl', '/tmp/x'), null);
  assert.equal(shellRefFor('', '/tmp/x'), null);
  assert.equal(shellRefFor(undefined, '/tmp/x'), null);
});

test('substituteInsertTemplate: replaces each placeholder', () => {
  assert.equal(
    substituteInsertTemplate('{path}', { path: '/tmp/f' }),
    '/tmp/f'
  );
  assert.equal(
    substituteInsertTemplate('{ref}', { ref: `"$(cat '/tmp/f')"` }),
    `"$(cat '/tmp/f')"`
  );
  assert.equal(
    substituteInsertTemplate('{value}', { value: 'hunter2' }),
    'hunter2'
  );
});

test('substituteInsertTemplate: real-world templates', () => {
  assert.equal(
    substituteInsertTemplate("-i '{path}'", { path: '/keys/id_rsa' }),
    "-i '/keys/id_rsa'"
  );
  assert.equal(
    substituteInsertTemplate("PGSERVICEFILE='{path}' PGSERVICE=mydb", { path: '/tmp/svc' }),
    "PGSERVICEFILE='/tmp/svc' PGSERVICE=mydb"
  );
});

test('substituteInsertTemplate: missing values become empty string', () => {
  assert.equal(substituteInsertTemplate('[{path}][{ref}][{value}]', {}), '[][][]');
  assert.equal(
    substituteInsertTemplate('{path}{value}', { path: '/tmp/f' }),
    '/tmp/f'
  );
  // null/undefined are treated as empty, not the literal strings.
  assert.equal(
    substituteInsertTemplate('{path}|{ref}', { path: null, ref: undefined }),
    '|'
  );
});

test('substituteInsertTemplate: multiple occurrences of the same placeholder', () => {
  assert.equal(
    substituteInsertTemplate('{path} then {path}', { path: '/tmp/f' }),
    '/tmp/f then /tmp/f'
  );
});

test('substituteInsertTemplate: substituted values with $ and \\ are inserted literally', () => {
  // split/join (not regex replace) — no $1/$& expansion, no escaping surprises.
  assert.equal(
    substituteInsertTemplate('{value}', { value: '$1 \\ & end' }),
    '$1 \\ & end'
  );
  // Windows path with backslashes survives verbatim (real secret-ref file path).
  assert.equal(
    substituteInsertTemplate("-i '{path}'", { path: 'C:\\Users\\me\\secret-refs\\abc' }),
    "-i 'C:\\Users\\me\\secret-refs\\abc'"
  );
});

test('substituteInsertTemplate: no placeholders passes template through; empty template → empty', () => {
  assert.equal(substituteInsertTemplate('plain text', { value: 'x' }), 'plain text');
  assert.equal(substituteInsertTemplate('', {}), '');
  assert.equal(substituteInsertTemplate(null, {}), '');
});

// --- the single-pass tokenizer: a substituted value is TEXT, never a template ----------------------------
//
// The old implementation chained split/join passes ({path} → {ref} → {value}), each re-scanning the previous
// pass's output. That was harmless only while every substituted value was system-generated. `{var:}` feeds
// user-authored values into the same chain, and then a value that merely CONTAINS a placeholder gets it
// honoured on the next pass. These pin the property that makes that impossible.

test('a substituted value containing {value} is NOT expanded — it is text', () => {
  // The attack this closes: a referenced child whose stored value is the literal string "{value}" would, on
  // a chained implementation, have that token replaced by the PARENT's plaintext on the following pass —
  // even though the parent's own template never said {value}. The handler passes `value` in unconditionally.
  assert.equal(
    substituteInsertTemplate('{path}', { path: '{value}', value: 'PARENT-SECRET' }),
    '{value}',
    'the {value} came from a value, so it stays inert text'
  );
});

test('a substituted value containing {ref} is NOT expanded — it cannot reach the parent temp file', () => {
  assert.equal(
    substituteInsertTemplate('{value}', { value: '{ref}', ref: '"$(cat \'/tmp/parent\')"' }),
    '{ref}',
    'a value that looks like a ref does not become one'
  );
});

test('a substituted var value containing {var:x} does NOT chain into another variable', () => {
  assert.equal(
    substituteInsertTemplate('{var:helper}', { vars: { helper: '{var:other}', other: 'CHAINED' } }),
    '{var:other}',
    'resolved child text is opaque — it is never re-scanned for further refs'
  );
});

test('every placeholder resolves exactly once, left to right, whatever the values contain', () => {
  assert.equal(
    substituteInsertTemplate('{value}-{path}-{ref}', { value: '{path}', path: '{ref}', ref: 'R' }),
    '{path}-{ref}-R'
  );
});

test('compose() is not poisoned by a previous .test() on a shared regex (the lastIndex trap)', () => {
  // matchAll/exec on a /g regex carry lastIndex between uses. If the token regex were hoisted to module
  // scope, one innocent TOKEN.test(tmpl) elsewhere would leave it set and the NEXT compose would silently
  // skip its first token, emitting it as literal text. Calling twice in a row proves the regex is per-call.
  const tmpl = '{value} and {ref}';
  const vals = { value: 'V', ref: 'R' };
  assert.equal(substituteInsertTemplate(tmpl, vals), 'V and R');
  assert.equal(substituteInsertTemplate(tmpl, vals), 'V and R', 'second call is identical — no state carried');
});

// --- effectiveTemplate: ONE definition, or the two phases decide about different templates --------------

test('effectiveTemplate: a whitespace-only template falls back to the default', () => {
  // The trap: `row.insertTemplate || default` resolves "  " to "  ". The handler has always trimmed, so a
  // second caller that does not is a phase-1/phase-2 disagreement about what is being resolved.
  assert.equal(effectiveTemplate({ insertTemplate: '  ', secret: true }), '{ref}');
  assert.equal(effectiveTemplate({ insertTemplate: '', secret: false }), '{value}');
  assert.equal(effectiveTemplate({ insertTemplate: null, secret: true }), '{ref}');
  assert.equal(effectiveTemplate({ insertTemplate: '-i {path}', secret: true }), '-i {path}');
});

// --- forceRefForNested: a secret reached via {var:} never inlines plaintext -----------------------------

test('forceRefForNested: a secret\'s {value} becomes {ref}; a non-secret is untouched', () => {
  // {value} on a secret consents to plaintext when inserting THAT variable, at its own row, with its Secret
  // pill. It does not consent to plaintext inside someone else's insert.
  assert.equal(forceRefForNested('{value}', true), '{ref}');
  assert.equal(forceRefForNested('Bearer {value}', true), 'Bearer {ref}');
  assert.equal(forceRefForNested('{value}', false), '{value}', 'a non-secret keeps its template');
});

test('forceRefForNested: {path}-only and no-placeholder templates are no-ops', () => {
  assert.equal(forceRefForNested('-i {path}', true), '-i {path}', 'a path is not plaintext');
  assert.equal(forceRefForNested('literal', true), 'literal');
  assert.equal(forceRefForNested('{value}{ref}', true), '{ref}{ref}');
});

// --- parseVarRefs --------------------------------------------------------------------------------------

test('parseVarRefs: finds names, trims them, ignores the other placeholders', () => {
  assert.deepEqual(parseVarRefs('{var:server} {value} {var: user } {path}'), ['server', 'user']);
  assert.deepEqual(parseVarRefs('no refs {ref}'), []);
  assert.deepEqual(parseVarRefs('{var:a:b}'), ['a:b'], 'a colon in a name is fine — the prefix anchors it');
  assert.deepEqual(parseVarRefs('{var:}'), [], 'an empty name does not match the grammar');
});

// --- scanRefSafety: Blocker A. A ref is a complete shell word; quoting it kills it ----------------------

test('scanRefSafety: a bare ref is safe; a ref inside quotes is not', () => {
  const bare = compose('mysql -p{ref}', { ref: "\"$(cat '/tmp/x')\"" });
  assert.deepEqual(scanRefSafety(bare.text, bare.refOffsets), [], 'adjacency is fine — this is the sanctioned form');

  const single = compose("mysql -p'{ref}'", { ref: "\"$(cat '/tmp/x')\"" });
  const hits = scanRefSafety(single.text, single.refOffsets);
  assert.ok(hits.length, "a ref inside single quotes is flagged — bash would hand over the literal string");
});

test('scanRefSafety: double quotes are flagged too — POSIX surviving them is an accident, not a contract', () => {
  // pwsh is fatal in BOTH quote kinds (it needs $(…), not (…), inside a string). Telling someone to unquote
  // is cheap; a silently wrong credential is not.
  const r = compose('--opt="{ref}"', { ref: "\"$(cat '/tmp/x')\"" });
  assert.ok(scanRefSafety(r.text, r.refOffsets).length);
});

test('scanRefSafety: the quote may come from a VALUE, not the template — an apostrophe is enough', () => {
  // The template leaves the ref bare. A sibling's value ends in an apostrophe and re-opens quoting around
  // it. This is why the scan runs on the COMPOSED text: a template-only check is structurally blind here.
  // Trigger: an apostrophe in a username. No adversary required.
  const r = compose('mysql -u {var:user} -p{ref}', {
    ref: "\"$(cat '/tmp/x')\"",
    vars: { user: "root'" },
  });
  assert.ok(scanRefSafety(r.text, r.refOffsets).length, 'the value-borne quote is caught');
});

test('scanRefSafety: refs inside a resolved child are tracked at their real offsets', () => {
  // A child's text can carry its own ref. Its offset in the parent shifts by where the child lands, or the
  // scan checks the wrong index and clears a quoted ref.
  const child = compose('{ref}', { ref: "\"$(cat '/tmp/child')\"" });
  const parent = compose("run '{var:c}'", {
    vars: { c: child.text },
    varRefOffsets: { c: child.refOffsets },
  });
  assert.ok(scanRefSafety(parent.text, parent.refOffsets).length,
    "the child's ref is quoted by the parent's template — caught");
});

test('scanRefSafety: no refs → nothing to flag, whatever the quoting', () => {
  const r = compose("mysql -p'{value}'", { value: 'plain' });
  assert.deepEqual(scanRefSafety(r.text, r.refOffsets), []);
});

test('scanRefSafety: an unbalanced quote around a ref is flagged even if the ref itself reads unquoted', () => {
  const r = compose("echo '{var:x} {ref}", { ref: "\"$(cat '/tmp/x')\"", vars: { x: 'a' } });
  assert.ok(scanRefSafety(r.text, r.refOffsets).some(h => h.reason === 'unbalanced' || h.reason === 'quoted'));
});

// --- resolveVarGraph: the walk that decides everything BEFORE anything is decrypted ---------------------

function node(id, name, opts = {}) {
  return { id, name, secret: !!opts.secret, insertTemplate: opts.tmpl || '', scope: opts.scope || 'global', createdAt: opts.createdAt || '2026-01-01T00:00:00.000Z' };
}
function graphFor(rows, rootId) {
  const byId = new Map(rows.map(r => [r.id, r]));
  return resolveVarGraph(rootId, byId, buildNameIndex(rows));
}

test('resolveVarGraph: children come before parents (bottom-up), each id once', () => {
  const rows = [
    node('a', 'a', { tmpl: '{var:b} {var:c}' }),
    node('b', 'b', { tmpl: '{var:c}' }),
    node('c', 'c'),
  ];
  const g = graphFor(rows, 'a');
  assert.ok(!g.cycle);
  assert.deepEqual(g.order, ['c', 'b', 'a'], 'c resolves first; a last');
});

test('resolveVarGraph: a diamond resolves the shared node ONCE', () => {
  // A→x and A→y→x. Without memoisation x would be composed twice and, if secret, get two temp files.
  const rows = [
    node('a', 'a', { tmpl: '{var:x} {var:y}' }),
    node('y', 'y', { tmpl: '{var:x}' }),
    node('x', 'x'),
  ];
  const g = graphFor(rows, 'a');
  assert.equal(g.order.filter(id => id === 'x').length, 1);
  assert.deepEqual(g.order, ['x', 'y', 'a']);
});

test('resolveVarGraph: a cycle is detected and named, and does not hang', () => {
  const rows = [
    node('a', 'a', { tmpl: '{var:b}' }),
    node('b', 'b', { tmpl: '{var:a}' }),
  ];
  const g = graphFor(rows, 'a');
  assert.ok(g.cycle, 'cycle reported');
  assert.ok(g.cycle.includes('a') && g.cycle.includes('b'), 'the path names the variables');
});

test('resolveVarGraph: a self-reference is a cycle', () => {
  const g = graphFor([node('a', 'a', { tmpl: 'x {var:a}' })], 'a');
  assert.ok(g.cycle);
});

test('resolveVarGraph: an unknown name is reported, not fatal (missing → empty)', () => {
  const g = graphFor([node('a', 'a', { tmpl: '{var:nope}' })], 'a');
  assert.ok(!g.cycle);
  assert.deepEqual(g.order, ['a']);
  assert.deepEqual(g.missing, ['nope']);
});

test('resolveVarGraph: a secret child is walked through its FORCED template, not its own', () => {
  // The secret's template says {value}; reached through a ref it resolves as {ref}. The graph must walk the
  // forced form, or a template that only references things via {value} would look ref-free to phase 1 —
  // and phase 1 is where the shell-capability check happens.
  const rows = [
    node('a', 'a', { tmpl: '{var:s}' }),
    node('s', 's', { secret: true, tmpl: '{value}' }),
  ];
  const g = graphFor(rows, 'a');
  assert.deepEqual(g.order, ['s', 'a']);
  assert.equal(finalTemplateFor(rows[1], false), '{ref}', 'nested → forced');
  assert.equal(finalTemplateFor(rows[1], true), '{value}', 'as the ROOT it keeps its own template');
});

// --- buildNameIndex: Decision 6 — a rule, not a UNIQUE constraint --------------------------------------

test('buildNameIndex: project scope beats global for the same name', () => {
  const rows = [
    node('g', 'server', { scope: 'global', createdAt: '2020-01-01T00:00:00.000Z' }),
    node('p', 'server', { scope: 'project', createdAt: '2026-01-01T00:00:00.000Z' }),
  ];
  assert.equal(buildNameIndex(rows).server, 'p', 'project wins even though it is newer');
});

test('buildNameIndex: within a scope the OLDEST wins, id breaks a createdAt tie', () => {
  const rows = [
    node('n', 'x', { createdAt: '2026-05-05T00:00:00.000Z' }),
    node('o', 'x', { createdAt: '2020-01-01T00:00:00.000Z' }),
  ];
  assert.equal(buildNameIndex(rows).x, 'o');

  // createdAt is a millisecond ISO string — ties are real, so the result must not depend on row order.
  const tied = [node('bbb', 'y'), node('aaa', 'y')];
  assert.equal(buildNameIndex(tied).y, 'aaa');
  assert.equal(buildNameIndex([...tied].reverse()).y, 'aaa', 'stable whatever the input order');
});

test('buildNameIndex: matching is case-SENSITIVE — Server and server are two variables', () => {
  const rows = [node('1', 'Server'), node('2', 'server')];
  const idx = buildNameIndex(rows);
  assert.equal(idx.Server, '1');
  assert.equal(idx.server, '2');
});
