const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeClaudePath,
  getProjectTrustMap,
  getProjectClaudeMeta,
  setProjectTrust,
  removeProjectEntry,
  renameProjectEntry,
} = require('../claude-config');

test('normalizeClaudePath: backslashes -> forward slashes, trailing slash stripped', () => {
  assert.equal(normalizeClaudePath('C:\\Users\\x\\proj\\'), normalizeClaudePath('C:/Users/x/proj'));
  assert.equal(normalizeClaudePath('/home/u/proj/'), '/home/u/proj');
});

test('normalizeClaudePath: empty/nullish -> empty string', () => {
  assert.equal(normalizeClaudePath(''), '');
  assert.equal(normalizeClaudePath(null), '');
  assert.equal(normalizeClaudePath(undefined), '');
});

test('normalizeClaudePath: drive letter case-insensitive on all platforms', () => {
  assert.equal(normalizeClaudePath('D:/a/b'), normalizeClaudePath('d:/a/b'));
});

function makeTempConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'));
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

test('getProjectTrustMap: maps normalized path -> hasTrustDialogAccepted', () => {
  const file = makeTempConfig({
    userID: 'secret',
    projects: {
      '/home/u/a': { hasTrustDialogAccepted: true },
      '/home/u/b': { hasTrustDialogAccepted: false },
      '/home/u/c': {},
    },
  });
  const map = getProjectTrustMap(file);
  assert.equal(map.get(normalizeClaudePath('/home/u/a')), true);
  assert.equal(map.get(normalizeClaudePath('/home/u/b')), false);
  assert.equal(map.get(normalizeClaudePath('/home/u/c')), false);
});

test('getProjectClaudeMeta: counts MCP servers / allowedTools, reads cost + tokens', () => {
  const file = makeTempConfig({
    projects: {
      '/home/u/a': {
        mcpServers: { one: {}, two: {} },
        allowedTools: ['Read', 'Edit', 'Bash'],
        lastCost: 1.234,
        lastTotalInputTokens: 5000,
        lastTotalOutputTokens: 200,
      },
    },
  });
  const m = getProjectClaudeMeta(file).get(normalizeClaudePath('/home/u/a'));
  assert.equal(m.mcpServersCount, 2);
  assert.equal(m.allowedToolsCount, 3);
  assert.equal(m.lastCost, 1.234);
  assert.equal(m.inputTokens, 5000);
  assert.equal(m.outputTokens, 200);
});

test('setProjectTrust: flips only the one field, preserves secrets, writes .bak', () => {
  const file = makeTempConfig({
    userID: 'SECRET-should-survive',
    oauthAccount: { token: 'keep-me' },
    projects: {
      '/home/u/a': { hasTrustDialogAccepted: true, allowedTools: ['Read'] },
      '/home/u/b': { hasTrustDialogAccepted: true },
    },
  });

  const res = setProjectTrust('/home/u/a', false, file);
  assert.equal(res.ok, true);
  assert.equal(res.trusted, false);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Target field changed…
  assert.equal(after.projects['/home/u/a'].hasTrustDialogAccepted, false);
  // …everything else preserved 1:1.
  assert.deepEqual(after.projects['/home/u/a'].allowedTools, ['Read']);
  assert.equal(after.projects['/home/u/b'].hasTrustDialogAccepted, true);
  assert.equal(after.userID, 'SECRET-should-survive');
  assert.deepEqual(after.oauthAccount, { token: 'keep-me' });
  // .bak holds the pre-write state.
  assert.equal(fs.existsSync(file + '.bak'), true);
  const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
  assert.equal(bak.projects['/home/u/a'].hasTrustDialogAccepted, true);
});

test('setProjectTrust: creates a minimal entry when the project is absent', () => {
  const file = makeTempConfig({ projects: {} });
  const res = setProjectTrust('D:\\Projekte\\new', true, file);
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Stored under forward-slash form.
  assert.equal(after.projects['D:/Projekte/new'].hasTrustDialogAccepted, true);
});

test('setProjectTrust: matches an existing key regardless of slash/case', () => {
  const file = makeTempConfig({
    projects: { 'D:/Projekte/switchboard': { hasTrustDialogAccepted: true, foo: 1 } },
  });
  // Pass Windows-style backslash path; must update the existing forward-slash key.
  const res = setProjectTrust('D:\\Projekte\\switchboard', false, file);
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(after.projects).length, 1, 'no duplicate key created');
  assert.equal(after.projects['D:/Projekte/switchboard'].hasTrustDialogAccepted, false);
  assert.equal(after.projects['D:/Projekte/switchboard'].foo, 1);
});

test('setProjectTrust: errors gracefully on missing config file', () => {
  const res = setProjectTrust('/x', true, path.join(os.tmpdir(), 'does-not-exist-xyz.json'));
  assert.ok(res.error);
});

test('removeProjectEntry: deletes the entry, preserves others + secrets, writes .bak', () => {
  const file = makeTempConfig({
    userID: 'KEEP',
    projects: {
      '/home/u/a': { hasTrustDialogAccepted: true },
      '/home/u/b': { hasTrustDialogAccepted: false },
    },
  });
  const res = removeProjectEntry('/home/u/a', file);
  assert.equal(res.ok, true);
  assert.equal(res.removed, 1);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('/home/u/a' in after.projects, false);
  assert.equal('/home/u/b' in after.projects, true);
  assert.equal(after.userID, 'KEEP');
  assert.equal(fs.existsSync(file + '.bak'), true);
});

test('removeProjectEntry: matches slash/case variants, removed=0 when absent', () => {
  const file = makeTempConfig({ projects: { 'D:/Projekte/x': { hasTrustDialogAccepted: true } } });
  const res = removeProjectEntry('D:\\Projekte\\x', file);
  assert.equal(res.ok, true);
  assert.equal(res.removed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, {});

  const file2 = makeTempConfig({ projects: { '/home/u/a': {} } });
  const res2 = removeProjectEntry('/home/u/other', file2);
  assert.equal(res2.ok, true);
  assert.equal(res2.removed, 0);
});

test('renameProjectEntry: moves the block to the new key, preserving values', () => {
  const file = makeTempConfig({
    userID: 'KEEP',
    projects: {
      '/home/u/old': { hasTrustDialogAccepted: true, mcpServers: { a: {} }, lastCost: 2 },
    },
  });
  const res = renameProjectEntry('/home/u/old', '/home/u/new', file);
  assert.equal(res.ok, true);
  assert.equal(res.moved, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('/home/u/old' in after.projects, false);
  assert.equal(after.projects['/home/u/new'].hasTrustDialogAccepted, true);
  assert.deepEqual(after.projects['/home/u/new'].mcpServers, { a: {} });
  assert.equal(after.projects['/home/u/new'].lastCost, 2);
  assert.equal(after.userID, 'KEEP');
});

test('renameProjectEntry: no-op when source absent', () => {
  const file = makeTempConfig({ projects: { '/home/u/a': {} } });
  const res = renameProjectEntry('/home/u/missing', '/home/u/new', file);
  assert.equal(res.ok, true);
  assert.equal(res.moved, false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects), ['/home/u/a']);
});

test('renameProjectEntry: merges over an existing target (source wins overlaps)', () => {
  const file = makeTempConfig({
    projects: {
      '/home/u/old': { hasTrustDialogAccepted: true, lastCost: 9 },
      '/home/u/new': { hasTrustDialogAccepted: false, foo: 'bar' },
    },
  });
  const res = renameProjectEntry('/home/u/old', '/home/u/new', file);
  assert.equal(res.moved, true);
  const p = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
  assert.equal('/home/u/old' in p, false);
  assert.equal(p['/home/u/new'].hasTrustDialogAccepted, true); // source won
  assert.equal(p['/home/u/new'].lastCost, 9);
  assert.equal(p['/home/u/new'].foo, 'bar');                    // target field kept
});
