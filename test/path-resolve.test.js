'use strict';
// src/app/path-resolve.js over a fake `fs`: the answers, the cost (one readdir per directory), the budget and
// the network rule. Every path here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const { resolveCommand, resolveCommands, forgetListing } = require('../src/app/path-resolve');
const { isForeignNetworkPath } = require('../src/app/network-path');
const { stripComments } = require('./helpers/strip-comments');

const W = nodePath.win32;
const P = nodePath.posix;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * tree: { <dir>: [names] }. A dir that is absent from the tree answers ENOENT.
 * o.hang: dirs whose readdir never answers; o.fail: { <dir>: code }; o.stats: { <path>: { dir?, mode? } };
 * o.statFail: Set of paths whose stat throws EIO; o.latency: ms per readdir.
 */
function makeFs(tree, o = {}) {
  const calls = { readdir: [], stat: [] };
  let inflight = 0;
  let maxInflight = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  const promises = {
    async readdir(dir) {
      calls.readdir.push(dir);
      if (o.hang && o.hang.has(dir)) return new Promise(() => {});
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        if (o.latency) await sleep(o.latency);
        if (o.fail && o.fail[dir]) throw err(o.fail[dir]);
        if (!(dir in tree)) throw err('ENOENT');
        return tree[dir];
      } finally { inflight--; }
    },
    async stat(p) {
      calls.stat.push(p);
      if (o.statFail && o.statFail.has(p)) throw err('EIO');
      if (o.statAbsent && o.statAbsent.has(p)) throw err('ENOENT');
      const s = (o.stats && o.stats[p]) || {};
      return { isDirectory: () => !!s.dir, mode: s.mode === undefined ? 0o755 : s.mode };
    },
  };
  return { fs: { promises }, calls, maxInflight: () => maxInflight };
}

const win = (extra = {}) => ({ platform: 'win32', cacheMs: 0, ...extra });
// A POSIX PATH, built rather than written as one string.
const posixPath = (...dirs) => dirs.join(':');
const posix = (extra = {}) => ({ platform: 'linux', cacheMs: 0, ...extra });

test('posix: found in a later directory, with its execute bit', async () => {
  const f = makeFs({ '/opt/tools': ['other'], '/usr/local/bin': ['mytool'] });
  const a = await resolveCommand('mytool', posix({ fs: f.fs, env: { PATH: posixPath('/opt/tools', '/usr/local/bin') } }));
  assert.deepEqual(a, { state: 'found', resolved: '/usr/local/bin/mytool', ext: '', executable: true });
});

test('posix: no execute bit is found with executable false', async () => {
  const f = makeFs({ '/opt/tools': ['mytool'] }, { stats: { '/opt/tools/mytool': { mode: 0o644 } } });
  const a = await resolveCommand('mytool', posix({ fs: f.fs, env: { PATH: '/opt/tools' } }));
  assert.equal(a.state, 'found');
  assert.equal(a.executable, false);
});

test('missing needs every directory read or absent', async () => {
  const f = makeFs({ '/opt/tools': ['a'] }); // /opt/gone answers ENOENT: an absent directory, not a skip
  const a = await resolveCommand('mytool', posix({ fs: f.fs, env: { PATH: posixPath('/opt/tools', '/opt/gone') } }));
  assert.deepEqual(a, { state: 'missing' });
});

test('a directory carrying the command name is rejected, the search goes on', async () => {
  const f = makeFs({ '/opt/a': ['mytool'], '/opt/b': ['mytool'] }, { stats: { '/opt/a/mytool': { dir: true } } });
  const a = await resolveCommand('mytool', posix({ fs: f.fs, env: { PATH: posixPath('/opt/a', '/opt/b') } }));
  assert.equal(a.resolved, '/opt/b/mytool');
});

test('a hit whose stat fails still counts as found', async () => {
  const f = makeFs({ '/opt/a': ['mytool'] }, { statFail: new Set(['/opt/a/mytool']) });
  const a = await resolveCommand('mytool', posix({ fs: f.fs, env: { PATH: '/opt/a' } }));
  assert.equal(a.state, 'found');
  assert.equal(a.executable, undefined);
});

test('win32: PATHEXT default order, then the directory order wins over the extension', async () => {
  const dir = 'C:\\tools';
  const f = makeFs({ [dir]: ['tool.cmd', 'tool.exe'] });
  const a = await resolveCommand('tool', win({ fs: f.fs, env: { PATH: dir } }));
  assert.equal(a.resolved, W.join(dir, 'tool.EXE'));
  assert.equal(a.ext, '.EXE');
  const b = await resolveCommand('tool', win({ fs: f.fs, env: { PATH: dir, PATHEXT: '.CMD;.EXE' } }));
  assert.equal(b.ext, '.CMD');
  const g = makeFs({ 'C:\\one': ['tool.cmd'], 'C:\\two': ['tool.exe'] });
  const c = await resolveCommand('tool', win({ fs: g.fs, env: { PATH: 'C:\\one;C:\\two' } }));
  assert.equal(c.resolved, W.join('C:\\one', 'tool.CMD'));
});

test('win32: names fold, the env keys are case-insensitive, quotes and duplicates are dropped', async () => {
  const f = makeFs({ 'C:\\My Tools': ['Git.EXE'] });
  const a = await resolveCommand('git', win({ fs: f.fs, env: { Path: '"C:\\My Tools";;C:\\my tools', pathext: '.exe' } }));
  assert.equal(a.state, 'found');
  assert.equal(f.calls.readdir.length, 1); // the duplicate spelled in another case was dropped
});

test('win32: an extension already in PATHEXT is tried as typed', async () => {
  const f = makeFs({ 'C:\\tools': ['tool.exe'] });
  const a = await resolveCommand('tool.exe', win({ fs: f.fs, env: { PATH: 'C:\\tools' } }));
  assert.equal(a.state, 'found');
  assert.equal(a.ext, '.exe');
});

test('a throwing directory makes a miss unknown and a hit still found', async () => {
  const f = makeFs({ '/opt/a': [], '/opt/b': ['mytool'] }, { fail: { '/opt/a': 'EACCES' } });
  const env = { PATH: posixPath('/opt/a', '/opt/b') };
  assert.equal((await resolveCommand('mytool', posix({ fs: f.fs, env }))).state, 'found');
  assert.deepEqual(await resolveCommand('nothing', posix({ fs: f.fs, env })), { state: 'unknown', reason: 'unreadable' });
});

test('G4: a directory that never answers ends in unknown/timeout inside the budget', async () => {
  const f = makeFs({ '/opt/b': ['mytool'] }, { hang: new Set(['/opt/a']) });
  const env = { PATH: posixPath('/opt/a', '/opt/b') };
  const t0 = Date.now();
  const miss = await resolveCommand('nothing', posix({ fs: f.fs, env, budgetMs: 60 }));
  assert.deepEqual(miss, { state: 'unknown', reason: 'timeout' });
  assert.ok(Date.now() - t0 < 1500, 'returned within the budget plus slack');
  const hit = await resolveCommand('mytool', posix({ fs: f.fs, env, budgetMs: 60 }));
  assert.equal(hit.state, 'found');
});

test('G4: a hung read is not held for the next caller', async () => {
  const hang = new Set(['/opt/a']);
  const f = makeFs({ '/opt/a': ['mytool'] }, { hang });
  const env = { PATH: '/opt/a' };
  const o = { fs: f.fs, env, platform: 'linux', cacheMs: 5000 };
  forgetListing();
  assert.equal((await resolveCommand('mytool', { ...o, budgetMs: 40 })).reason, 'timeout');
  hang.clear();
  assert.equal((await resolveCommand('mytool', { ...o, budgetMs: 200 })).state, 'found');
  forgetListing();
});

test('G4: one readdir per directory for many names, shared across calls until forgotten or stale', async () => {
  const dirs = Array.from({ length: 100 }, (_, i) => `/opt/d${i}`);
  const tree = Object.fromEntries(dirs.map((d) => [d, ['x']]));
  tree['/opt/d99'] = ['n3'];
  const f = makeFs(tree);
  let clock = 1000;
  const o = { fs: f.fs, env: { PATH: dirs.join(':') }, platform: 'linux', now: () => clock, cacheMs: 5000 };
  forgetListing();
  const names = Array.from({ length: 20 }, (_, i) => `n${i}`);
  const res = await resolveCommands(names, o);
  assert.equal(f.calls.readdir.length, 100);
  assert.equal(new Set(f.calls.readdir).size, 100);
  assert.equal(res.get('n3').state, 'found');
  assert.equal(res.get('n4').state, 'missing');
  await resolveCommand('n1', o);
  assert.equal(f.calls.readdir.length, 100, 'second call is served from the listing');
  clock += 6000;
  await resolveCommand('n1', o);
  assert.equal(f.calls.readdir.length, 200, 'a stale listing is read again');
  forgetListing();
  await resolveCommand('n1', o);
  assert.equal(f.calls.readdir.length, 300, 'forgetListing drops it');
  forgetListing();
});

test('the concurrency cap holds', async () => {
  const dirs = Array.from({ length: 12 }, (_, i) => `/opt/d${i}`);
  const f = makeFs(Object.fromEntries(dirs.map((d) => [d, []])), { latency: 5 });
  await resolveCommand('nothing', posix({ fs: f.fs, env: { PATH: dirs.join(':') }, concurrency: 3 }));
  assert.equal(f.calls.readdir.length, 12);
  assert.ok(f.maxInflight() <= 3, `max in flight ${f.maxInflight()}`);
});

test('G5: a foreign share directory and a foreign command path never reach fs', async () => {
  const foreign = (p) => isForeignNetworkPath(p, []);
  const f = makeFs({ 'C:\\tools': ['tool.exe'] });
  const env = { PATH: '\\\\nas\\share\\bin;C:\\tools' };
  const hit = await resolveCommand('tool', win({ fs: f.fs, env, isForeignNetworkPath: foreign }));
  assert.equal(hit.state, 'found');
  const miss = await resolveCommand('nothing', win({ fs: f.fs, env, isForeignNetworkPath: foreign }));
  assert.deepEqual(miss, { state: 'unknown', reason: 'network' });
  assert.deepEqual(f.calls.readdir, ['C:\\tools', 'C:\\tools']);

  const g = makeFs({});
  const p = await resolveCommand('\\\\nas\\share\\bin\\tool.exe', win({ fs: g.fs, isForeignNetworkPath: foreign }));
  assert.deepEqual(p, { state: 'unknown', reason: 'network' });
  assert.deepEqual([g.calls.readdir, g.calls.stat], [[], []]);
});

test('G5: a share a project is on is checked', async () => {
  const known = (p) => isForeignNetworkPath(p, ['\\\\nas\\share\\proj']);
  const f = makeFs({ '\\\\nas\\share\\bin': ['tool.exe'] });
  const a = await resolveCommand('tool', win({ fs: f.fs, env: { PATH: '\\\\nas\\share\\bin' }, isForeignNetworkPath: known }));
  assert.equal(a.state, 'found');
  assert.equal(f.calls.readdir.length, 1);
});

test('a throwing network guard is read as foreign', async () => {
  const f = makeFs({ '/opt/a': ['mytool'] });
  const a = await resolveCommand('mytool', posix({ fs: f.fs, env: { PATH: '/opt/a' }, isForeignNetworkPath() { throw new Error('x'); } }));
  assert.deepEqual(a, { state: 'unknown', reason: 'network' });
  assert.equal(f.calls.readdir.length, 0);
});

test('a relative PATH entry is skipped and a miss becomes unknown; a hit elsewhere stays found', async () => {
  const f = makeFs({ '/opt/a': ['mytool'] });
  const env = { PATH: posixPath('bin', '/opt/a') };
  assert.equal((await resolveCommand('mytool', posix({ fs: f.fs, env }))).state, 'found');
  assert.deepEqual(await resolveCommand('nothing', posix({ fs: f.fs, env })), { state: 'unknown', reason: 'relative-path-entry' });
  assert.ok(!f.calls.readdir.includes('bin'));
});

test('a name with a separator is a path: relative against cwd, unknown without one', async () => {
  const f = makeFs({});
  assert.deepEqual(await resolveCommand('tools/run', posix({ fs: f.fs })), { state: 'unknown', reason: 'no-cwd' });
  const a = await resolveCommand('tools/run', posix({ fs: f.fs, cwd: '/work/proj' }));
  assert.equal(a.resolved, '/work/proj/tools/run');
  assert.equal(a.state, 'found');
  assert.deepEqual(f.calls.stat, ['/work/proj/tools/run']);
  assert.equal(f.calls.readdir.length, 0);
  const abs = await resolveCommand('/opt/tools/run', posix({ fs: f.fs }));
  assert.equal(abs.resolved, '/opt/tools/run');
});

test('a path that is not there is missing; one that cannot be stat\'ed is unknown', async () => {
  const gone = { promises: { stat: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } } };
  assert.deepEqual(await resolveCommand('/opt/tools/run', posix({ fs: gone })), { state: 'missing' });
  const f = makeFs({}, { statFail: new Set(['/opt/tools/run']) });
  assert.deepEqual(await resolveCommand('/opt/tools/run', posix({ fs: f.fs })), { state: 'unknown', reason: 'unreadable' });
});

test('win32 path with a drive: extension tried in PATHEXT order', async () => {
  const gone = Object.assign(new Error('x'), { code: 'ENOENT' });
  const seen = [];
  const fsx = { promises: { stat: async (p) => { seen.push(p); if (!p.endsWith('.BAT')) throw gone; return { isDirectory: () => false, mode: 0 }; } } };
  const a = await resolveCommand('C:\\tools\\run', win({ fs: fsx }));
  assert.equal(a.resolved, 'C:\\tools\\run.BAT');
  assert.deepEqual(seen, ['C:\\tools\\run.COM', 'C:\\tools\\run.EXE', 'C:\\tools\\run.BAT']);
});

test('an empty name is unknown', async () => {
  const f = makeFs({});
  for (const n of ['', '   ', undefined]) {
    assert.deepEqual(await resolveCommand(n, posix({ fs: f.fs })), { state: 'unknown', reason: 'empty-name' });
  }
});

test('M1 posix: a non-executable hit yields to a later executable copy, and stands alone otherwise', async () => {
  const tree = { '/a': ['tool'], '/b': ['tool'] };
  const stats = { '/a/tool': { mode: 0o644 }, '/b/tool': { mode: 0o755 } };
  const both = await resolveCommand('tool', posix({ fs: makeFs(tree, { stats }).fs, env: { PATH: posixPath('/a', '/b') } }));
  assert.deepEqual(both, { state: 'found', resolved: '/b/tool', ext: '', executable: true });
  const only = await resolveCommand('tool', posix({ fs: makeFs({ '/a': ['tool'] }, { stats }).fs, env: { PATH: posixPath('/a', '/b') } }));
  assert.deepEqual(only, { state: 'found', resolved: '/a/tool', ext: '', executable: false });
});

test('M2: a stat that says ENOENT is not a hit; unreadable or failing stats still are', async () => {
  const tree = { '/a': ['tool'], '/b': ['tool'] };
  const env = { PATH: posixPath('/a', '/b') };
  const gone = makeFs(tree, { statAbsent: new Set(['/a/tool']) });
  assert.equal((await resolveCommand('tool', posix({ fs: gone.fs, env }))).resolved, '/b/tool');
  const allGone = makeFs({ '/a': ['tool'] }, { statAbsent: new Set(['/a/tool']) });
  assert.deepEqual(await resolveCommand('tool', posix({ fs: allGone.fs, env: { PATH: '/a' } })), { state: 'missing' });
  const eio = makeFs(tree, { statFail: new Set(['/a/tool']) });
  assert.equal((await resolveCommand('tool', posix({ fs: eio.fs, env }))).resolved, '/a/tool');
});

test('L1 win32: a root-relative path is relative, as a PATH entry and as a command path', async () => {
  const f = makeFs({ 'C:\\tools': ['x.exe'] });
  const env = { PATH: '\\bin;C:\\tools' };
  const miss = await resolveCommand('nothing', win({ fs: f.fs, env }));
  assert.deepEqual(miss, { state: 'unknown', reason: 'relative-path-entry' });
  assert.ok(!f.calls.readdir.includes('\\bin'));
  assert.equal((await resolveCommand('x', win({ fs: f.fs, env }))).state, 'found');

  const g = makeFs({});
  assert.deepEqual(await resolveCommand('\\tools\\run', win({ fs: g.fs })), { state: 'unknown', reason: 'no-cwd' });
  assert.deepEqual(g.calls.stat, []);
  const a = await resolveCommand('\\tools\\run', win({ fs: g.fs, cwd: 'D:\\proj' }));
  assert.equal(a.resolved, 'D:\\tools\\run.COM');
});

test('L2 posix: an empty PATH entry means the current directory, so a miss is unknown', async () => {
  for (const PATH of [':/opt/a', '/opt/a:', '/opt/a::/opt/b']) {
    const f = makeFs({ '/opt/a': ['tool'], '/opt/b': [] });
    assert.equal((await resolveCommand('tool', posix({ fs: f.fs, env: { PATH } }))).state, 'found');
    assert.deepEqual(await resolveCommand('nothing', posix({ fs: f.fs, env: { PATH } })), { state: 'unknown', reason: 'relative-path-entry' });
  }
  const w = makeFs({ 'C:\\t': [] });
  assert.deepEqual(await resolveCommand('nothing', win({ fs: w.fs, env: { PATH: ';C:\\t;' } })), { state: 'missing' });
});

test('source: no synchronous fs call in the module', () => {
  const src = stripComments(fs.readFileSync(nodePath.join(__dirname, '..', 'src', 'app', 'path-resolve.js'), 'utf8'));
  assert.ok(src.length > 1000, 'the stripped source was actually read');
  assert.doesNotMatch(src, /Sync\s*\(/);
  assert.doesNotMatch(src, /child_process|require\(['"]electron['"]\)|db\/db/);
});
