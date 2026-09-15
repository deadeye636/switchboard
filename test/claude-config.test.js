const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeClaudePath,
  cliProjectKey,
  claudeConfigPath,
  getProjectTrust,
  getProjectClaudeMeta,
  setProjectTrust,
  removeProjectEntry,
  renameProjectEntry,
} = require('../src/backends/claude/config');

// #241: an isolated (demo/sandbox) run must read and WRITE the isolated config, not the user's own. It
// did not — the Projects admin listed the real project catalogue inside a demo window, and Remove-entry
// from there would have edited the real file. The isolated CLI keeps its config INSIDE its home
// (`<home>/.claude.json`, measured on a real demo launch); the normal one keeps it beside `~/.claude`.
test('claudeConfigPath follows the isolated Claude home, and only then (#241)', () => {
  const saved = process.env.SWITCHBOARD_STORE_CLAUDE;
  try {
    delete process.env.SWITCHBOARD_STORE_CLAUDE;
    assert.equal(claudeConfigPath(), path.join(os.homedir(), '.claude.json'));

    process.env.SWITCHBOARD_STORE_CLAUDE = path.join('C:', 'demo', 'stores', 'claude', 'projects');
    const isolated = claudeConfigPath();
    assert.equal(isolated, path.join('C:', 'demo', 'stores', 'claude', '.claude.json'));
    assert.ok(!isolated.includes(os.homedir()), 'an isolated run must not resolve back into the real home');
  } finally {
    if (saved === undefined) delete process.env.SWITCHBOARD_STORE_CLAUDE;
    else process.env.SWITCHBOARD_STORE_CLAUDE = saved;
  }
});

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

test('getProjectTrust: the entry under the CLI key, false without the flag, null without an entry', () => {
  const file = makeTempConfig({
    userID: 'secret',
    projects: {
      '/home/u/a': { hasTrustDialogAccepted: true },
      '/home/u/b': { hasTrustDialogAccepted: false },
      '/home/u/c': {},
    },
  });
  const trust = getProjectTrust(['/home/u/a', '/home/u/b', '/home/u/c', '/home/u/d', '/home/u/a/'], file);
  assert.equal(trust.get('/home/u/a'), true);
  assert.equal(trust.get('/home/u/b'), false);
  assert.equal(trust.get('/home/u/c'), false);
  assert.equal(trust.get('/home/u/d'), null);
  assert.equal(trust.get('/home/u/a/'), true, 'a trailing slash is not part of the key');
});

// #627: measured on Claude Code 2.1.272 — the CLI keys trust by the real path with the drive letter as
// spelled, and looks it up exactly. Another spelling of the same directory is a key it never reads.
//
// Windows paths below are built from a letter and parts: they are invented, and CLAUDE.md rule 6 keeps a
// drive-letter path out of tracked files even as an example.
const winPath = (letter, ...parts) => `${letter}:\\${parts.join('\\')}`;
const keyPath = (letter, ...parts) => `${letter}:/${parts.join('/')}`;

test('cliProjectKey: forward slashes, no trailing slash, the drive letter as spelled', () => {
  assert.equal(cliProjectKey(winPath('Q', 'Example', 'missing-dir', '')), keyPath('Q', 'Example', 'missing-dir'));
  assert.equal(cliProjectKey(winPath('q', 'Example', 'missing-dir')), keyPath('q', 'Example', 'missing-dir'));
  assert.equal(cliProjectKey('/home/u/missing/'), '/home/u/missing');
  assert.equal(cliProjectKey(''), '');
  assert.equal(cliProjectKey(null), '');
});

test('the drive letter goes back as spelled only on the same drive, and a root keeps its slash (#627)', () => {
  const { _keyFromRealPath: keyOf } = require('../src/backends/claude/config');
  assert.equal(keyOf(winPath('Q', 'Work', 'Case-Dir'), winPath('q', 'work', 'case-dir')), keyPath('q', 'Work', 'Case-Dir'),
    'measured: same drive, spelled letter');
  assert.equal(keyOf(winPath('R', 'Work', 'real'), winPath('Q', 'link')), keyPath('R', 'Work', 'real'),
    'a junction to another drive keeps the resolved drive');
  assert.equal(keyOf(winPath('Q', 'real', 'x'), winPath('S', 'x')), keyPath('Q', 'real', 'x'), 'a subst drive resolves to its underlying one');
  assert.equal(keyOf(winPath('Q', ''), winPath('q', '')), keyPath('q', ''), 'a drive root');
  assert.equal(keyOf('\\\\host\\share\\p', winPath('Z', 'p')), '//host/share/p', 'a UNC path stays one');
});

test('a subst or mapped drive keeps its own letter, as the CLI keys it (#627)', () => {
  const { _keyFromRealPath: keyOf } = require('../src/backends/claude/config');
  // measured: a `subst` drive over a sandbox directory, and a session in a folder on it, wrote that drive's letter
  assert.equal(keyOf(winPath('Q', 'probe', 'Case-S'), winPath('T', 'Case-S'), winPath('Q', 'probe')), keyPath('T', 'Case-S'));
  // measured: a drive mapped to a share wrote the drive letter, not the share
  assert.equal(keyOf('\\\\host\\share\\Work\\Case-M', winPath('Y', 'Work', 'Case-M'), '\\\\host\\share'), keyPath('Y', 'Work', 'Case-M'));
  assert.equal(keyOf(winPath('Q', 'probe'), winPath('T', ''), winPath('Q', 'probe')), keyPath('T', ''), 'the substitute drive root itself');
  assert.equal(keyOf(winPath('R', 'elsewhere'), winPath('T', 'link'), winPath('Q', 'probe')), keyPath('R', 'elsewhere'),
    'a junction out of a substitute drive is keyed where it leads');
});

test('cliProjectKey on Windows keys a repository subdirectory by the root, in its on-disk case (#627)', { skip: process.platform !== 'win32' }, () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-repo-key-')));
  try {
    const repo = path.join(base, 'Repo-A');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'Sub-Dir'));
    assert.equal(cliProjectKey(path.join(repo, 'Sub-Dir').toUpperCase()), repo.replace(/\\/g, '/').slice(0, 1).toUpperCase() + repo.replace(/\\/g, '/').slice(1));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ancestorKeys: nearest first, up to the drive root, a share root or `/`', () => {
  const { _ancestorKeys: up } = require('../src/backends/claude/config');
  assert.deepEqual(up(keyPath('Q', 'a', 'b')), [keyPath('Q', 'a'), keyPath('Q', '')]);
  assert.deepEqual(up(keyPath('Q', '')), []);
  assert.deepEqual(up('//host/share/a/b'), ['//host/share/a', '//host/share']);
  assert.deepEqual(up('//host/share'), []);
  assert.deepEqual(up('/home/u/p'), ['/home/u', '/home', '/']);
});

test('describeProjectTrust elsewhere than Windows inherits nothing and keys the path as spelled (#627)', { skip: process.platform === 'win32' }, () => {
  const { describeProjectTrust } = require('../src/backends/claude/config');
  const file = makeTempConfig({ projects: { '/home/u': { hasTrustDialogAccepted: true } } });
  assert.deepEqual(describeProjectTrust(['/home/u/p'], file).get('/home/u/p'), { trusted: null, scope: 'own', gate: '/home/u/p' });
});

test('describeProjectTrust says when a folder further up is trusted too (#627)', { skip: process.platform !== 'win32' }, () => {
  const { describeProjectTrust } = require('../src/backends/claude/config');
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-above-')));
  try {
    const outer = path.join(base, 'Outer');
    const inner = path.join(outer, 'Inner');
    const leaf = path.join(inner, 'Leaf');
    fs.mkdirSync(leaf, { recursive: true });
    const file = makeTempConfig({ projects: { [cliProjectKey(outer)]: { hasTrustDialogAccepted: true }, [cliProjectKey(inner)]: { hasTrustDialogAccepted: true } } });
    assert.deepEqual(describeProjectTrust([leaf], file).get(leaf),
      { trusted: true, scope: 'inherited', gate: cliProjectKey(inner), trustedAbove: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('describeProjectTrust on Windows: an ancestor trusts a plain folder, never a repository; a worktree shares its root (#627)', { skip: process.platform !== 'win32' }, () => {
  const { describeProjectTrust, _resetTrustGateCache } = require('../src/backends/claude/config');
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-describe-')));
  try {
    const parent = path.join(base, 'Parent-F');
    const child = path.join(parent, 'Child-G');
    const repo = path.join(parent, 'Repo-I');
    const deep = path.join(repo, 'Deep-J');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(deep);
    _resetTrustGateCache();
    const k = (p) => cliProjectKey(p);
    const file = makeTempConfig({ projects: {
      [k(parent)]: { hasTrustDialogAccepted: true },
      [k(child)]: { hasTrustDialogAccepted: false },   // the CLI writes this itself, and it does not stop inheritance
    } });
    const d = describeProjectTrust([child, repo, deep, parent], file);
    assert.deepEqual(d.get(child), { trusted: true, scope: 'inherited', gate: k(parent), trustedAbove: false }, 'measured: the child of a trusted folder');
    assert.deepEqual(d.get(repo), { trusted: null, scope: 'own', gate: k(repo) }, 'measured: a repository inside a trusted folder asks');
    assert.deepEqual(d.get(deep), { trusted: null, scope: 'shared', gate: k(repo) }, 'measured: so does its subfolder, keyed by the root');
    assert.deepEqual(d.get(parent), { trusted: true, scope: 'own', gate: k(parent) });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('inside a git repository trust is keyed by the root, and a worktree by its main repository (#627)', () => {
  const { _gitTrustRoot: rootOf } = require('../src/backends/claude/config');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-git-'));
  try {
    const repo = path.join(base, 'Repo-A');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt-a'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'Sub', 'Deeper'), { recursive: true });
    // What `git worktree add` writes: a `.git` FILE naming the worktree's git dir, and `commondir` in there.
    const wt = path.join(base, 'Wt-A');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + path.join(repo, '.git', 'worktrees', 'wt-a').replace(/\\/g, '/') + '\n');
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt-a', 'commondir'), '../..\n');
    // A `.git` file with no `commondir` behind it (a submodule's shape) keys its own directory.
    const sub = path.join(base, 'Submodule');
    fs.mkdirSync(path.join(base, 'modules-dir'), { recursive: true });
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../modules-dir\n');
    const plain = path.join(base, 'Plain-B', 'Sub-Dir');
    fs.mkdirSync(plain, { recursive: true });

    assert.equal(rootOf(repo), repo);
    assert.equal(rootOf(path.join(repo, 'Sub', 'Deeper')), repo, 'measured: a subdirectory is keyed by the root');
    assert.equal(rootOf(wt), repo, 'measured: a worktree found its main repository already trusted');
    assert.equal(rootOf(sub), sub);
    // A bare repository's worktree: its common dir is not a `.git`, so there is no main checkout to key by.
    const bare = path.join(base, 'proj.git');
    fs.mkdirSync(path.join(bare, 'worktrees', 'bw'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'worktrees', 'bw', 'commondir'), '../..\n');
    const bareWt = path.join(base, 'Bare-Wt');
    fs.mkdirSync(bareWt);
    fs.writeFileSync(path.join(bareWt, '.git'), 'gitdir: ' + path.join(bare, 'worktrees', 'bw') + '\n');
    assert.equal(rootOf(bareWt), bare, 'measured: a bare repository\'s worktree is keyed by the bare repository\'s directory');
    // The walk stops at a substitute drive's root: a `subst` over a repository subfolder keys that drive.
    assert.equal(rootOf(path.join(repo, 'Sub', 'Deeper'), path.join(repo, 'Sub')), null);
    // Outside any repository there is no root — unless the temp directory itself sits inside one.
    const outer = rootOf(base);
    assert.equal(rootOf(plain), outer, 'measured: a plain directory is in no repository, so it keys itself');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cliProjectKey on Windows: on-disk case and a junction resolved, the spelled drive letter kept (#627)', { skip: process.platform !== 'win32' }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-key-')));
  try {
    const real = path.join(root, 'Case-Dir');
    fs.mkdirSync(real);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, 'junction');
    const expected = real.replace(/\\/g, '/');
    const lowerDrive = (s) => s[0].toLowerCase() + s.slice(1);

    assert.equal(cliProjectKey(real.toUpperCase()), expected.slice(0, 1).toUpperCase() + expected.slice(1),
      'every folder name in its on-disk case');
    assert.equal(cliProjectKey(lowerDrive(real.toLowerCase())), lowerDrive(expected), 'the drive letter stays as spelled');
    assert.equal(cliProjectKey(link), expected, 'a junction is keyed by its target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renameProjectEntry moves the block to the key the CLI reads, so trust survives a remap (#627)', { skip: process.platform !== 'win32' }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-rename-')));
  try {
    const target = path.join(root, 'New-Home');
    fs.mkdirSync(target);
    const file = makeTempConfig({ projects: { [keyPath('Q', 'Example', 'old-home')]: { hasTrustDialogAccepted: true, foo: 1 } } });
    // Spelled in another case than the directory is on disk, the way a remap dialog may hand it over.
    const spelled = target.toLowerCase();
    assert.equal(renameProjectEntry(winPath('Q', 'Example', 'old-home'), spelled, file).moved, true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(after.projects), [cliProjectKey(spelled)]);
    assert.equal(getProjectTrust([spelled], file).get(spelled), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectTrust: an entry under another spelling of the directory does not count (#627)', { skip: process.platform !== 'win32' }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-trust-')));
  try {
    const real = path.join(root, 'Case-Dir');
    fs.mkdirSync(real);
    const file = makeTempConfig({ projects: { [real.toLowerCase().replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } } });
    assert.equal(getProjectTrust([real], file).get(real), null, 'the CLI would show the trust dialog again');

    assert.equal(setProjectTrust(real, true, file).ok, true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.projects[cliProjectKey(real)].hasTrustDialogAccepted, true, 'written under the key the CLI reads');
    assert.equal(after.projects[real.toLowerCase().replace(/\\/g, '/')].hasTrustDialogAccepted, true, 'the other spelling is left alone');
    assert.equal(getProjectTrust([real], file).get(real), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  const res = setProjectTrust('D:\\Example\\new', true, file);
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Stored under forward-slash form.
  assert.equal(after.projects['D:/Example/new'].hasTrustDialogAccepted, true);
});

test('setProjectTrust: matches an existing key regardless of slash direction', () => {
  const file = makeTempConfig({
    projects: { 'D:/Example/switchboard': { hasTrustDialogAccepted: true, foo: 1 } },
  });
  // Pass Windows-style backslash path; must update the existing forward-slash key.
  const res = setProjectTrust('D:\\Example\\switchboard', false, file);
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(after.projects).length, 1, 'no duplicate key created');
  assert.equal(after.projects['D:/Example/switchboard'].hasTrustDialogAccepted, false);
  assert.equal(after.projects['D:/Example/switchboard'].foo, 1);
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
  const file = makeTempConfig({ projects: { 'D:/Example/x': { hasTrustDialogAccepted: true } } });
  const res = removeProjectEntry('D:\\Example\\x', file);
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

// --- #533: a concurrent CLI write must survive ours --------------------------------------------------
//
// Every helper above changes one field, but the unit that reaches the disk is the whole document. So a
// key Claude Code stored between our read and our write is not overwritten by a conflicting value — it is
// absent from what we hand back. Claude Code 2.1.259 fixed that between two of its own sessions; these
// stage the same race with Switchboard as the other party.
//
// The interference happens INSIDE the mutation, which is the only moment that is reliably between our read
// and our write — hence the test-only export.
const { _mutateClaudeConfig, _WRITE_ATTEMPTS } = require('../src/backends/claude/config');

test('a write re-derives against a config the CLI changed underneath it (#533)', () => {
  const file = makeTempConfig({
    oauthAccount: { secret: 'keep-me' },
    projects: { '/home/u/proj': { hasTrustDialogAccepted: false } },
  });

  let interfered = false;
  const res = _mutateClaudeConfig(file, (cfg) => {
    if (!interfered) {
      interfered = true;
      // The CLI, mid-turn: it records an MCP server and a cost on the same project.
      const theirs = JSON.parse(fs.readFileSync(file, 'utf8'));
      theirs.projects['/home/u/proj'].mcpServers = { ide: {} };
      theirs.projects['/home/u/proj'].lastCost = 0.42;
      fs.writeFileSync(file, JSON.stringify(theirs, null, 2));
    }
    cfg.projects['/home/u/proj'].hasTrustDialogAccepted = true;
    return { result: { ok: true } };
  });

  assert.deepEqual(res, { ok: true });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.projects['/home/u/proj'].hasTrustDialogAccepted, true, 'our own change landed');
  assert.deepEqual(after.projects['/home/u/proj'].mcpServers, { ide: {} }, "the CLI's write survived");
  assert.equal(after.projects['/home/u/proj'].lastCost, 0.42, "the CLI's write survived");
  assert.equal(after.oauthAccount.secret, 'keep-me');
});

test('a config rewritten on every attempt is reported, not spun on (#533)', () => {
  const file = makeTempConfig({ projects: { '/home/u/proj': { hasTrustDialogAccepted: false } } });

  let attempts = 0;
  const res = _mutateClaudeConfig(file, (cfg) => {
    attempts++;
    const theirs = JSON.parse(fs.readFileSync(file, 'utf8'));
    theirs.projects['/home/u/proj'].round = attempts;
    fs.writeFileSync(file, JSON.stringify(theirs, null, 2));
    cfg.projects['/home/u/proj'].hasTrustDialogAccepted = true;
    return { result: { ok: true } };
  });

  assert.equal(attempts, _WRITE_ATTEMPTS, 'it gave up after the declared number of attempts');
  assert.match(res.error, /kept changing/);
  assert.equal(res.ok, undefined);
  // The loser leaves the file as the other writer left it — never half of each.
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.projects['/home/u/proj'].round, _WRITE_ATTEMPTS);
  assert.equal(after.projects['/home/u/proj'].hasTrustDialogAccepted, false);
});

test('setProjectTrust keeps the line endings the file was written with (#533)', () => {
  // Now that the bytes go through safe-write, the file's own encoding is preserved. A CRLF config must not
  // come back LF-only — that is a diff of every line, in a file a CLI re-reads.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-eol-'));
  const file = path.join(dir, '.claude.json');
  const body = JSON.stringify({ projects: { '/home/u/proj': { hasTrustDialogAccepted: false } } }, null, 2);
  fs.writeFileSync(file, body.replace(/\n/g, '\r\n'));

  assert.equal(setProjectTrust('/home/u/proj', true, file).ok, true);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('\r\n'), 'CRLF kept');
  assert.equal(/(?<!\r)\n/.test(after), false, 'no LF-only line slipped in');
  assert.equal(JSON.parse(after).projects['/home/u/proj'].hasTrustDialogAccepted, true);
});

test('removeProjectEntry loses nothing the CLI wrote while it ran (#533)', () => {
  const file = makeTempConfig({
    projects: {
      '/home/u/gone': { hasTrustDialogAccepted: true },
      '/home/u/stays': { hasTrustDialogAccepted: true },
    },
  });

  let interfered = false;
  // Stage the race the same way: the interference has to happen between our read and our write, and the
  // only hook that sits there is the mutation itself.
  const res = _mutateClaudeConfig(file, (cfg) => {
    if (!interfered) {
      interfered = true;
      const theirs = JSON.parse(fs.readFileSync(file, 'utf8'));
      theirs.projects['/home/u/fresh'] = { hasTrustDialogAccepted: false };
      fs.writeFileSync(file, JSON.stringify(theirs, null, 2));
    }
    delete cfg.projects['/home/u/gone'];
    return { result: { ok: true, removed: 1 } };
  });

  assert.deepEqual(res, { ok: true, removed: 1 });
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
  assert.equal('/home/u/gone' in after, false, 'our removal landed');
  assert.equal('/home/u/stays' in after, true);
  assert.equal('/home/u/fresh' in after, true, "the CLI's new project survived");
});

test('renameProjectEntry merges once, not twice, across a retry (#533)', () => {
  // The mutation runs again on the second attempt. A move that merged its source into the target and then
  // saw its own output would produce a different answer the second time round.
  const file = makeTempConfig({
    projects: { '/home/u/old': { hasTrustDialogAccepted: true, lastCost: 9 } },
  });

  let interfered = false;
  const res = _mutateClaudeConfig(file, (cfg) => {
    if (!interfered) {
      interfered = true;
      const theirs = JSON.parse(fs.readFileSync(file, 'utf8'));
      theirs.projects['/home/u/new'] = { foo: 'bar' };   // the CLI creates the target meanwhile
      fs.writeFileSync(file, JSON.stringify(theirs, null, 2));
    }
    const src = cfg.projects['/home/u/old'];
    if (!src) return { skipWrite: true, result: { ok: true, moved: false } };
    cfg.projects['/home/u/new'] = { ...(cfg.projects['/home/u/new'] || {}), ...src };
    delete cfg.projects['/home/u/old'];
    return { result: { ok: true, moved: true } };
  });

  assert.deepEqual(res, { ok: true, moved: true });
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
  assert.equal('/home/u/old' in after, false);
  assert.equal(after['/home/u/new'].lastCost, 9, 'the move landed');
  assert.equal(after['/home/u/new'].foo, 'bar', "the CLI's target field survived");
});

test('.bak is taken once per call, not once per attempt (#533)', () => {
  // A copy per attempt would overwrite the fallback with the interloper's newer version — a .bak that
  // tracks the file it is a fallback for is not one.
  const file = makeTempConfig({ projects: { '/home/u/proj': { hasTrustDialogAccepted: false } } });

  let attempts = 0;
  _mutateClaudeConfig(file, (cfg) => {
    attempts++;
    const theirs = JSON.parse(fs.readFileSync(file, 'utf8'));
    theirs.projects['/home/u/proj'].round = attempts;
    fs.writeFileSync(file, JSON.stringify(theirs, null, 2));
    cfg.projects['/home/u/proj'].hasTrustDialogAccepted = true;
    return { result: { ok: true } };
  });

  assert.equal(attempts, _WRITE_ATTEMPTS);
  const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
  assert.equal(bak.projects['/home/u/proj'].round, 1, 'the backup is from the first attempt, not the last');
});
