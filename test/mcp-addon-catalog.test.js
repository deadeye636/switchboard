// The reviewed MCP addon catalog (#790 T2 and T4, spec 38): every entry keeps the shape the settings screen and the
// project form rely on, every command is one string for every shell (D9), and detection reads the static check's reply
// back per command, with "missing" only where the check had evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MCP_ADDON_CATALOG, commandLine, findCatalogItem, entryFromCatalog, probeEntries, readProbe, catalogProblems,
} = require('../src/shared/mcp-addon-catalog');
const { entryToForm, formToEntry } = require('../src/shared/external-mcp-form');
const { validateExternalMcpServers } = require('../src/shared/external-mcp-validate');

// What each upstream `pyproject.toml` names: the package and its `[project.scripts]` executable. Spec 38's
// "Catalog verification" table records when this was read.
const UPSTREAM = {
  jcodemunch: { pkg: 'jcodemunch-mcp', exe: 'jcodemunch-mcp' },
  jdocmunch: { pkg: 'jdocmunch-mcp', exe: 'jdocmunch-mcp' },
  jdatamunch: { pkg: 'jdatamunch-mcp', exe: 'jdatamunch-mcp' },
};

const clone = v => JSON.parse(JSON.stringify(v));

test('the real catalog keeps every rule', () => {
  assert.deepEqual(catalogProblems(MCP_ADDON_CATALOG), []);
});

test('the catalog holds exactly the entries spec 38 verified', () => {
  assert.deepEqual(MCP_ADDON_CATALOG.map(i => i.id).sort(), Object.keys(UPSTREAM).sort());
});

test('each entry installs the upstream package and runs the executable that install puts on PATH', () => {
  for (const item of MCP_ADDON_CATALOG) {
    const up = UPSTREAM[item.id];
    assert.equal(item.stdio.command, up.exe, item.id);
    assert.deepEqual(item.runtimes.map(r => r.runtime).sort(), ['pipx', 'uv'], item.id);
    for (const r of item.runtimes) {
      assert.equal(r.install[r.install.length - 1], up.pkg, `${item.id} ${r.runtime} install`);
      assert.equal(r.uninstall[r.uninstall.length - 1], up.pkg, `${item.id} ${r.runtime} uninstall`);
    }
  }
});

test('ids are valid card names and unique; sources are https', () => {
  const res = validateExternalMcpServers(MCP_ADDON_CATALOG.map(entryFromCatalog));
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
  assert.equal(new Set(MCP_ADDON_CATALOG.map(i => i.id)).size, MCP_ADDON_CATALOG.length);
  for (const item of MCP_ADDON_CATALOG) assert.match(item.source, /^https:\/\//);
});

test('entryFromCatalog passes the validator and round-trips through the form unchanged', () => {
  for (const item of MCP_ADDON_CATALOG) {
    const entry = entryFromCatalog(item);
    assert.deepEqual(entry, { name: item.id, transport: 'stdio', command: item.stdio.command });
    assert.deepEqual(formToEntry(entryToForm(entry)), entry, item.id);
    assert.equal(validateExternalMcpServers([entry]).rejected.length, 0, item.id);
  }
});

test('entryFromCatalog carries args when an entry has them', () => {
  const item = { ...clone(MCP_ADDON_CATALOG[0]), stdio: { command: 'x-mcp', args: ['--stdio', 'serve'] } };
  const entry = entryFromCatalog(item);
  assert.deepEqual(entry.args, ['--stdio', 'serve']);
  assert.deepEqual(formToEntry(entryToForm(entry)), entry);
});

test('commandLine joins safe tokens with single spaces', () => {
  assert.equal(commandLine(['uv', 'tool', 'install', 'jcodemunch-mcp']), 'uv tool install jcodemunch-mcp');
  assert.equal(commandLine(['pipx', 'install', 'pkg==1.2.3', 'a/b:c@d+e_f.g']), 'pipx install pkg==1.2.3 a/b:c@d+e_f.g');
  for (const item of MCP_ADDON_CATALOG) {
    for (const r of item.runtimes) {
      assert.equal(commandLine(r.install), r.install.join(' '));
      assert.equal(commandLine(r.uninstall), r.uninstall.join(' '));
    }
  }
});

test('commandLine throws on a token outside the safe set, an empty list or a non-string', () => {
  for (const bad of ['@args', '@x/y', 'a b', 'a;b', 'a&b', 'a|b', '$x', '"x"', "'x'", '`x`', 'a\\b', 'a>b', 'a<b', '(x)', '%X%', '', 'a\nb']) {
    assert.throws(() => commandLine(['uv', bad]), /unsafe command token/, JSON.stringify(bad));
  }
  assert.throws(() => commandLine([]), /at least one token/);
  assert.throws(() => commandLine('uv tool install x'), /at least one token/);
  assert.throws(() => commandLine(['uv', 1]), /unsafe command token/);
});

test('a catalog with a duplicate id fails', () => {
  const bad = clone(MCP_ADDON_CATALOG);
  bad.push(clone(bad[0]));
  assert.ok(catalogProblems(bad).some(p => /duplicate id/.test(p)));
});

test('a catalog whose command holds a shell character fails', () => {
  for (const ch of [' ', ';', '&', '|', '$', '"', "'", '`']) {
    const install = clone(MCP_ADDON_CATALOG);
    install[0].runtimes[0].install[3] = `jcodemunch${ch}mcp`;
    assert.ok(catalogProblems(install).some(p => /unsafe command token/.test(p)), `install ${JSON.stringify(ch)}`);
    const uninstall = clone(MCP_ADDON_CATALOG);
    uninstall[1].runtimes[1].uninstall[2] = `x${ch}`;
    assert.ok(catalogProblems(uninstall).some(p => /unsafe command token/.test(p)), `uninstall ${JSON.stringify(ch)}`);
    const stdio = clone(MCP_ADDON_CATALOG);
    stdio[2].stdio.args = ['ok', `a${ch}b`];
    assert.ok(catalogProblems(stdio).some(p => /unsafe command token/.test(p)), `args ${JSON.stringify(ch)}`);
  }
});

test('a catalog fails on a runtime other than uv or pipx, a mismatched runtime, a path command or a non-https source', () => {
  const uvx = clone(MCP_ADDON_CATALOG);
  uvx[0].runtimes.push({ runtime: 'uvx', install: ['uvx', 'jcodemunch-mcp'], uninstall: ['uvx', 'jcodemunch-mcp'] });
  assert.ok(catalogProblems(uvx).some(p => /runtime uvx is not one of/.test(p)));

  const mismatch = clone(MCP_ADDON_CATALOG);
  mismatch[0].runtimes[0].install[0] = 'pip';
  assert.ok(catalogProblems(mismatch).some(p => /does not start with uv/.test(p)));

  const pathCmd = clone(MCP_ADDON_CATALOG);
  pathCmd[0].stdio.command = '/usr/bin/jcodemunch-mcp';
  assert.ok(catalogProblems(pathCmd).some(p => /is a path/.test(p)));

  const varCmd = clone(MCP_ADDON_CATALOG);
  varCmd[0].stdio.command = '${HOME}/x';
  assert.ok(catalogProblems(varCmd).some(p => /unsafe command token/.test(p)));

  const http = clone(MCP_ADDON_CATALOG);
  http[0].source = 'http://github.com/x/y';
  assert.ok(catalogProblems(http).some(p => /source is not https/.test(p)));

  const badId = clone(MCP_ADDON_CATALOG);
  badId[0].id = 'j code';
  assert.ok(catalogProblems(badId).some(p => /bad id/.test(p)));
});

test('findCatalogItem finds an id and nothing else', () => {
  assert.equal(findCatalogItem('jdocmunch').id, 'jdocmunch');
  for (const miss of ['nope', '', 'JDOCMUNCH', null, undefined, 42, {}, ['jdocmunch']]) {
    assert.equal(findCatalogItem(miss), null, JSON.stringify(miss));
  }
});

test('probeEntries asks once per distinct executable, as valid stdio entries', () => {
  const probes = probeEntries();
  const commands = probes.map(p => p.command);
  assert.equal(new Set(commands).size, commands.length);
  const want = new Set(['uv', 'pipx', ...MCP_ADDON_CATALOG.map(i => i.stdio.command)]);
  assert.deepEqual(new Set(commands), want);
  const res = validateExternalMcpServers(probes);
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
});

// --- Detection (T4): the probe reply mapped back per command, over hand-made replies and the real check. ---

const commandsOf = (probes) => probes.map(p => p.command);
const reply = (probes, commandFor) => probes.map((p, index) => {
  const command = commandFor(p.command, index);
  return command === undefined ? undefined : { index, name: p.name, enabled: true, transport: 'stdio', command, variables: [], takes: [], envGap: false };
}).filter(Boolean);

test('readProbe maps found, missing and unknown with each reason code, keyed by command', () => {
  const probes = probeEntries();
  // Main's own list, so a reason code added there is covered here without an edit.
  const { REASONS } = require('../src/app/external-mcp-check');
  const facts = [{ state: 'found', resolved: '/bin/x' }, { state: 'missing' }, ...REASONS.command.map(reason => ({ state: 'unknown', reason }))];
  // One pass per fact, every probe answered by it: there are fewer probes than facts.
  for (const f of facts) {
    const out = readProbe(reply(probes, () => f), probes);
    assert.deepEqual(Object.keys(out).sort(), commandsOf(probes).sort());
    const want = f.state === 'unknown' ? { state: 'unknown', reason: f.reason } : { state: f.state };
    for (const c of commandsOf(probes)) assert.deepEqual(out[c], want, `${c} ${JSON.stringify(f)}`);
  }
});

test('readProbe answers unknown, never missing, for a rejected, absent, short, mismatched or odd reply', () => {
  const probes = probeEntries();
  const unknown = { state: 'unknown', reason: 'no-answer' };
  for (const results of [undefined, null, 'nope', {}, []]) {
    for (const c of commandsOf(probes)) assert.deepEqual(readProbe(results, probes)[c], unknown, JSON.stringify(results));
  }
  const rejected = probes.map((_p, index) => ({ index, rejected: true }));
  assert.ok(Object.values(readProbe(rejected, probes)).every(a => a.state === 'unknown'));

  const short = reply(probes, () => ({ state: 'found' })).slice(0, 2);
  const outShort = readProbe(short, probes);
  assert.deepEqual(outShort[probes[0].command], { state: 'found' });
  assert.deepEqual(outShort[probes[probes.length - 1].command], unknown);

  const swapped = reply(probes, () => ({ state: 'missing' })).map(r => ({ ...r, name: 'someone-else' }));
  assert.ok(Object.values(readProbe(swapped, probes)).every(a => a.state === 'unknown'));

  const odd = reply(probes, (_c, i) => [{ state: 'not-applicable' }, { state: 'gone' }, null, { state: 'unknown' }][i % 4]);
  const outOdd = readProbe(odd, probes);
  for (const c of commandsOf(probes)) assert.deepEqual(outOdd[c], unknown, c);
});

test('the real check, with no project, reads present, absent and unreadable PATH entries as found, missing and unknown', async () => {
  const { checkEntries } = require('../src/app/external-mcp-check');
  const { forgetListing } = require('../src/app/path-resolve');
  const errno = (code) => Object.assign(new Error(code), { code });
  const fakeFs = (dirs) => ({
    promises: {
      async readdir(dir) {
        const v = dirs[dir];
        if (v instanceof Error) throw v;
        if (!v) throw errno('ENOENT');
        return v;
      },
      async stat() { return { isDirectory: () => false, mode: 0o755 }; },
    },
  });
  const probes = probeEntries();
  const run = async (PATH, dirs) => {
    forgetListing();
    const results = await checkEntries(probes, { projectPath: null, env: { PATH }, backendEnv: {}, backends: [], platform: 'linux', fs: fakeFs(dirs) });
    return readProbe(results, probes);
  };

  const readable = await run('/bin1', { '/bin1': ['uv', 'jcodemunch-mcp'] });
  assert.deepEqual(readable.uv, { state: 'found' });
  assert.deepEqual(readable['jcodemunch-mcp'], { state: 'found' });
  assert.deepEqual(readable.pipx, { state: 'missing' });
  assert.deepEqual(readable['jdocmunch-mcp'], { state: 'missing' });

  const unreadable = await run('/bin1:/bin2', { '/bin1': ['uv'], '/bin2': errno('EACCES') });
  assert.deepEqual(unreadable.uv, { state: 'found' });
  assert.deepEqual(unreadable.pipx, { state: 'unknown', reason: 'unreadable' });
  assert.deepEqual(unreadable['jdatamunch-mcp'], { state: 'unknown', reason: 'unreadable' });
  forgetListing();
});
