const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultInsertTemplate,
  shellRefFor,
  substituteInsertTemplate,
} = require('../variable-insert');

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
