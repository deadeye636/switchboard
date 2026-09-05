const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeClaudePath,
  claudeConfigPath,
  getProjectTrustMap,
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
  const res = setProjectTrust('D:\\Example\\new', true, file);
  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Stored under forward-slash form.
  assert.equal(after.projects['D:/Example/new'].hasTrustDialogAccepted, true);
});

test('setProjectTrust: matches an existing key regardless of slash/case', () => {
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
