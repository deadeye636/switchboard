// A project's forge issues (#816): the remote, the provider, the two CLIs' rows and every way there is no list.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const forgeIssues = require('../src/app/forge-issues');
const { parseRemoteUrl, providerForHost, normalizeRows, resolveBinary, classifyFailure, FORGES } = forgeIssues;

test('a remote URL gives host and path, in every shape git writes', () => {
  const want = { host: 'github.com', path: 'owner/repo' };
  for (const url of [
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo',
    'git\u0040github.com:owner/repo.git',
    'ssh://git\u0040github.com/owner/repo.git',
    'ssh://git\u0040ssh.github.com:443/owner/repo.git',
  ]) assert.deepEqual(parseRemoteUrl(url), want, url);
  assert.deepEqual(parseRemoteUrl('git\u0040gitlab.example.org:group/sub/repo.git'), { host: 'gitlab.example.org', path: 'group/sub/repo' });
  assert.deepEqual(parseRemoteUrl('https://gitlab.example.org:8443/group/repo'), { host: 'gitlab.example.org:8443', path: 'group/repo' });
});

test('credentials in a remote URL go nowhere', () => {
  const parsed = parseRemoteUrl('https://user:secret-token\u0040github.com/owner/repo.git');
  assert.deepEqual(parsed, { host: 'github.com', path: 'owner/repo' });
  assert.ok(!JSON.stringify(parsed).includes('secret'));
});

test('a service\'s SSH-over-443 name becomes its real host, and plain http stays plain', () => {
  assert.deepEqual(parseRemoteUrl('ssh://git\u0040altssh.gitlab.com:443/o/r.git'), { host: 'gitlab.com', path: 'o/r' });
  assert.deepEqual(parseRemoteUrl('git+ssh://git\u0040github.com/o/r.git'), { host: 'github.com', path: 'o/r' });
  const http = parseRemoteUrl('http://git.example.org/o/r');
  assert.equal(FORGES.gitlab.repoArg(http), 'http://git.example.org/o/r');
});

test('a local path, or a segment that could read as a flag, is no hosted repository', () => {
  for (const url of ['', 'C' + ':/repos/project.git', 'https://github.com/o/%zz', '../other', '/srv/git/project.git', 'file:///srv/project.git',
    'https://github.com/only-owner', 'https://github.com/-R/repo', 'git\u0040github.com:owner/-x', 'https://github.com/owner/..']) {
    assert.equal(parseRemoteUrl(url), null, url);
  }
});

test('auto decides from the host, and a name that says neither decides nothing', () => {
  assert.equal(providerForHost('github.com'), 'github');
  assert.equal(providerForHost('gitlab.com'), 'gitlab');
  assert.equal(providerForHost('gitlab.example.org:8443'), 'gitlab');
  assert.equal(providerForHost('git.example.org'), null);
  assert.equal(providerForHost('notgitlab.example.org'), null);
});

test('gh names a host only where it is not github.com, and takes OWNER/REPO alone', () => {
  const { repoArg } = FORGES.github;
  assert.equal(repoArg({ host: 'github.com', path: 'o/r' }), 'o/r');
  assert.equal(repoArg({ host: 'ghe.example.org', path: 'o/r' }), 'ghe.example.org/o/r');
  assert.equal(repoArg({ host: 'github.com', path: 'a/b/c' }), null);
  assert.equal(FORGES.gitlab.repoArg({ host: 'gitlab.com', path: 'a/b/c' }), 'https://gitlab.com/a/b/c');
});

test('both CLIs read open issues only and carry no write verb', () => {
  for (const forge of Object.values(FORGES)) {
    const args = forge.listArgs('o/r');
    assert.deepEqual(args.slice(0, 2), ['issue', 'list']);
    assert.ok(!/create|close|edit|delete|comment/.test(args.join(' ')));
  }
  assert.ok(FORGES.github.listArgs('o/r').includes('open'));
  assert.ok(!FORGES.gitlab.listArgs('o/r').some((a) => /closed|--all/.test(a)), 'glab lists open issues unless told otherwise');
});

test('a row of either CLI becomes the same issue', () => {
  const when = '2026-11-06T10:22:19Z';
  const gh = normalizeRows(FORGES.github, [{ number: 7, title: 'T', labels: [{ name: 'bug' }], author: { login: 'a' }, updatedAt: when, url: 'https://x/7', body: 'B' }]);
  const gl = normalizeRows(FORGES.gitlab, [{ iid: 7, title: 'T', labels: ['bug'], author: { username: 'a' }, updated_at: when, web_url: 'https://x/7', description: 'B' }]);
  assert.deepEqual(gh, gl);
  assert.deepEqual(gh[0], { number: 7, title: 'T', labels: ['bug'], author: 'a', updatedAt: Date.parse(when), url: 'https://x/7', body: 'B' });
});

test('a foreign row cannot carry a link that is not web, and a broken row is dropped', () => {
  const [row] = normalizeRows(FORGES.github, [{ number: 1, title: 'T', url: 'javascript:alert(1)', labels: 'x', body: null }]);
  assert.equal(row.url, '');
  assert.deepEqual(row.labels, []);
  assert.equal(row.body, '');
  assert.deepEqual(normalizeRows(FORGES.github, [{ title: 'no number' }, { number: 2 }, null]), []);
  assert.deepEqual(normalizeRows(FORGES.github, 'not a list'), []);
});

test('a shim is refused by name, an empty path means PATH', () => {
  assert.deepEqual(resolveBinary(FORGES.github, {}), { file: 'gh' });
  assert.deepEqual(resolveBinary(FORGES.gitlab, { forgeGlabPath: ' /opt/glab ' }), { file: '/opt/glab' });
  const refused = resolveBinary(FORGES.github, { forgeGhPath: '/opt/gh.CMD' });
  assert.equal(refused.reason, 'shim');
  assert.equal(refused.file, undefined);
  assert.equal(resolveBinary(FORGES.github, { forgeGhPath: 'tools/gh' }).reason, 'bad-path');
  assert.equal(resolveBinary(FORGES.github, { forgeGhPath: 'C:gh.exe' }).reason, 'bad-path');
});

test('each failure has its own reason, and a path in stderr is not repeated', () => {
  const f = FORGES.github;
  assert.equal(classifyFailure(f, { code: 'ENOENT' }, '').reason, 'missing');
  assert.equal(classifyFailure(f, { code: 1 }, 'To get started, please run: gh auth login').reason, 'login');
  assert.equal(classifyFailure(f, { code: 1 }, 'HTTP 401: Bad credentials').reason, 'login');
  assert.match(classifyFailure(f, { killed: true }, '').message, /did not answer/);
  assert.match(classifyFailure(f, { code: 1 }, 'the repository has disabled issues').message, /disabled issues/);
  assert.match(classifyFailure(f, { code: 1 }, 'ERROR\n\n404 Not Found').message, /404 Not Found/);
  for (const text of ['open C' + ':\\Users\\someone\\x: denied', 'open "/home/someone/x": denied', 'config=/home/someone/x', 'read ~/.config/someone', 'no //nas/someone/x',
    'config:/home/someone/x', 'file:///home/someone/x', '[/home/someone/x]', 'at \\Users\\someone\\x', 'at ..\\someone\\x']) {
    assert.ok(!classifyFailure(f, { code: 1 }, text).message.includes('someone'), text);
  }
  assert.match(classifyFailure(f, { code: 1 }, 'cannot reach https://gitlab.example.org/x').message, /gitlab\.example\.org/, 'a URL is not a local path');
  assert.ok(!classifyFailure(f, { code: 1 }, 'cannot reach https://user:token\u0040host.example/x').message.includes('token'));
  assert.ok(!classifyFailure(f, { code: 1 }, 'cannot reach https://user:pa\u0040ss\u0040host.example/x').message.includes('ss\u0040'));
  for (const text of ['GraphQL: Could not resolve to a Repository with the name \'o/r\'', 'HTTP 404: Not Found (https://api.github.com/repos/o/r/issues)', 'dial tcp: lookup host.example: no such host']) {
    assert.ok(classifyFailure(f, { code: 1 }, text).message.includes(text.slice(0, 12)), text);
  }
  assert.equal(classifyFailure(f, { code: 1 }, 'catalog invalid').reason, 'failed');
});

test('the filter reads number, title, author, labels and description', () => {
  const { filterIssues } = require('../src/renderer/views/tasks-logic');
  const rows = [
    { number: 7, title: 'Crash', author: 'a', labels: ['bug'], body: 'on start' },
    { number: 8, title: 'Idea', author: 'b', labels: [], body: '' },
  ];
  assert.equal(filterIssues(rows, '').length, 2);
  for (const q of ['#7', 'CRASH', 'bug', 'on start']) assert.deepEqual(filterIssues(rows, q).map((r) => r.number), [7], q);
  assert.deepEqual(filterIssues(rows, 'nothing'), []);
});

// The whole path through fakes: execFile records what would start, so nothing here runs a CLI.
function fake({ settings = {}, global = {}, remote = 'https://github.com/o/r.git', answers = {} } = {}) {
  const calls = [];
  forgeIssues.init({
    effectiveSettings: () => ({ forgeIssuesEnabled: true, forgeProvider: 'auto', forgeRemote: 'origin', ...settings }),
    getSetting: () => global,
    execFile: (file, args, options, cb) => {
      calls.push({ file, args, options });
      if (file === 'git') { setImmediate(() => cb(remote ? null : new Error('no'), `${remote}\n`, '')); return {}; }
      const a = answers[file] || { stdout: '[]' };
      setImmediate(() => cb(a.err || null, a.stdout || '', a.stderr || ''));
      return {};
    },
  });
  return calls;
}

test('off by default answers without starting anything', async () => {
  const calls = fake({ settings: { forgeIssuesEnabled: false } });
  assert.deepEqual(await forgeIssues.listIssues('<project>'), { enabled: false });
  assert.deepEqual(calls, []);
});

// A bare `gh` is looked up in the child's cwd before PATH on Windows, so a cwd would run a repository's own gh.exe.
test('no process gets the project as its working directory', async () => {
  const calls = fake({ answers: { gh: { stdout: '[]' } } });
  await forgeIssues.listIssues('<project>');
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.options.cwd, undefined, c.file);
});

test('a project or a binary on someone else\'s share starts nothing', async () => {
  const calls = fake();
  forgeIssues.init({
    effectiveSettings: () => ({ forgeIssuesEnabled: true }),
    getSetting: () => ({ forgeGhPath: '//host/share/gh.exe' }),
    isForeignNetworkFile: (p) => /host/.test(p),
    execFile: (file, args, options, cb) => { calls.push({ file }); setImmediate(() => cb(null, 'https://github.com/o/r\n', '')); return {}; },
  });
  assert.equal((await forgeIssues.listIssues('//host/share/p')).reason, 'no-remote');
  assert.deepEqual(calls, []);
  assert.equal((await forgeIssues.listIssues('<project>')).reason, 'bad-path');
  assert.deepEqual(calls.map((c) => c.file), ['git']);
  assert.equal((await forgeIssues.checkCli('github')).ok, false);
});

test('a settings import cannot choose the binary', () => {
  const { validateImportPayload, buildExportPayload } = require('../src/app/settings-transfer');
  const payload = buildExportPayload({ forgeGhPath: '/opt/gh', forgeGlabPath: '/opt/glab', forgeIssuesEnabled: true }, 'now', []);
  assert.equal(payload.global.forgeGhPath, '/opt/gh', 'an export still carries them');
  const check = validateImportPayload(payload);
  assert.equal(check.ok, true);
  assert.equal(check.global.forgeGhPath, undefined);
  assert.equal(check.global.forgeGlabPath, undefined);
  assert.equal(check.global.forgeIssuesEnabled, true);
});

// The guard is optional on ctx, so a wiring that forgets it would fail open with nothing to notice.
test('main hands the module its network guard', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /forgeIssues\.init\(\{[^}]*isForeignNetworkFile/);
});

test('a GitHub remote is read through gh, without a shell, for the chosen remote', async () => {
  const calls = fake({ settings: { forgeRemote: 'upstream' }, answers: { gh: { stdout: JSON.stringify([{ number: 1, title: 'T' }]) } } });
  const res = await forgeIssues.listIssues('<project>');
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'GitHub');
  assert.equal(res.issues[0].number, 1);
  assert.deepEqual(calls[0].args, ['-C', '<project>', 'remote', 'get-url', 'upstream']);
  assert.equal(calls[1].file, 'gh');
  assert.ok(calls.every((c) => !c.options.shell));
});

test('the provider setting beats the host, and the saved binary path is what starts', async () => {
  const calls = fake({ settings: { forgeProvider: 'gitlab' }, remote: 'https://git.example.org/o/r.git', global: { forgeGlabPath: '/opt/glab' }, answers: { '/opt/glab': { stdout: '[]' } } });
  const res = await forgeIssues.listIssues('<project>');
  assert.equal(res.provider, 'GitLab');
  assert.equal(calls[1].file, '/opt/glab');
});

test('no remote, an unknown host, a bad remote name and bad output each say so', async () => {
  fake({ remote: '' });
  assert.equal((await forgeIssues.listIssues('<project>')).reason, 'no-remote');
  fake({ remote: 'https://git.example.org/o/r.git' });
  assert.equal((await forgeIssues.listIssues('<project>')).reason, 'no-provider');
  const calls = fake({ settings: { forgeRemote: '--upload-pack=x' } });
  assert.equal((await forgeIssues.listIssues('<project>')).reason, 'no-remote');
  assert.deepEqual(calls, [], 'a remote name that reads as a flag reaches no process');
  fake({ answers: { gh: { stdout: 'not json' } } });
  assert.equal((await forgeIssues.listIssues('<project>')).reason, 'failed');
});

test('the test control runs the saved binary and takes no path', async () => {
  const calls = fake({ global: { forgeGhPath: '/opt/gh' }, answers: { '/opt/gh': { stdout: 'gh version 2\nmore' } } });
  assert.deepEqual(await forgeIssues.checkCli('github'), { ok: true, message: 'gh version 2' });
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal((await forgeIssues.checkCli('__proto__')).ok, false);
  fake({ answers: { gh: { err: { code: 'ENOENT' } } } });
  assert.match((await forgeIssues.checkCli('github')).message, /not found/);
});
