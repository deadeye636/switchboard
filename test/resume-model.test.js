'use strict';
// #754: a resume launches on what the session last ran on. This file pins the core's half — the merge and its
// precedence in src/app/terminal/resume-options.js — against a fake descriptor, and that spawn.js feeds the
// merged options to buildLaunch. What a backend answers is its own test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveResumeOptions, withoutResumeMark } = require('../src/app/terminal/resume-options');

const fake = (hook) => ({ id: 'fake', resumeLaunchOptions: hook });
const answer = (model) => () => ({ options: { model }, label: model });
const run = (over) => resolveResumeOptions({ backend: fake(answer('last')), resume: true, row: { id: 's' }, projectPath: '/p', sessionOptions: {}, ...over });

test('the hook answer replaces the settings the renderer sent', async () => {
  const r = await run({ sessionOptions: { model: 'setting', effort: 'high' } });
  assert.deepEqual(r.options, { model: 'last', effort: 'high' });
  assert.deepEqual(r.applied, ['model']);
  assert.equal(r.label, 'last');
});

test('an explicit override beats the hook, and the mark never reaches the options', async () => {
  const r = await run({ sessionOptions: { model: 'chosen', resumeOverride: true } });
  assert.deepEqual(r.options, { model: 'chosen' });
  assert.deepEqual(r.applied, []);
});

test('an empty key under an explicit override is filled from the hook', async () => {
  for (const empty of [undefined, null, '']) {
    const r = await run({ sessionOptions: { model: empty, resumeOverride: true } });
    assert.equal(r.options.model, 'last');
    assert.ok(!('resumeOverride' in r.options));
  }
});

test('a launch that is not a resume does not ask, and still drops the mark', async () => {
  let asked = 0;
  const r = await run({ resume: false, backend: fake(() => { asked++; return answer('last')(); }), sessionOptions: { model: 's', resumeOverride: true } });
  assert.equal(asked, 0);
  assert.deepEqual(r.options, { model: 's' });
});

test('a hook that declines, throws, rejects, returns junk or is missing launches as before', async () => {
  const sent = { model: 'setting' };
  for (const hook of [() => null, () => undefined, () => { throw new Error('boom'); }, async () => { throw new Error('boom'); },
    () => 'x', () => ({ options: 'x' }), () => ({ options: [] }), () => ({ options: { model: '' } }), () => ({})]) {
    const r = await run({ backend: fake(hook), sessionOptions: sent });
    assert.deepEqual(r.options, sent);
  }
  assert.deepEqual((await run({ backend: { id: 'none' }, sessionOptions: sent })).options, sent);
  assert.deepEqual((await run({ backend: null, sessionOptions: sent })).options, sent);
});

test('a hook that is too slow is abandoned after the timeout', async () => {
  const t0 = Date.now();
  const r = await run({ backend: fake(() => new Promise((res) => setTimeout(() => res({ options: { model: 'late' } }), 2000).unref())), sessionOptions: { model: 's' }, timeoutMs: 30 });
  assert.deepEqual(r.options, { model: 's' });
  assert.ok(Date.now() - t0 < 1000, 'the launch did not wait for the hook');
});

test('a timeout is logged at debug, a plain decline is not, and the hook gets the env it was handed', async () => {
  const lines = [];
  const log = { debug: (m) => lines.push(m) };
  await run({ backend: fake(() => new Promise(() => {})), sessionOptions: { model: 's' }, timeoutMs: 20, log });
  assert.equal(lines.filter((l) => /timed out/.test(l)).length, 1);
  lines.length = 0;
  let seenEnv;
  await run({ backend: fake((row, ctx) => { seenEnv = ctx.env; return null; }), env: { ANTHROPIC_MODEL: 'm' }, log });
  assert.deepEqual(seenEnv, { ANTHROPIC_MODEL: 'm' });
  assert.deepEqual(lines, []);
});

test('an ownerless row and absent options are passed through', async () => {
  let seen;
  const r = await run({ row: null, sessionOptions: undefined, backend: fake((row, ctx) => { seen = { row, ctx }; return answer('last')(); }) });
  assert.equal(seen.row, null);
  assert.equal(seen.ctx.projectPath, '/p');
  assert.deepEqual(r.options, { model: 'last' });
});

test('withoutResumeMark copies and strips', () => {
  const src = { a: 1, resumeOverride: true };
  assert.deepEqual(withoutResumeMark(src), { a: 1 });
  assert.ok('resumeOverride' in src, 'the caller\'s object is untouched');
  assert.deepEqual(withoutResumeMark(null), {});
});

// spawn.js requires node-pty at load, so there is no seam to reach a spawn through: a source check, and it
// pins the regression that will actually happen — the merged options replaced by the raw ones again.
test('spawn.js hands the merged options, not the raw ones, to buildLaunch and records them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8');
  assert.match(src, /resolveResumeOptions\(\{/);
  assert.match(src, /!isNew && !resumeUnknown && !sessionOptions\?\.forkFrom/, 'a fork is not a resume');
  assert.match(src, /options: launchOptions,\s*\}\);/, 'buildLaunch gets the merged options');
  assert.match(src, /appliedOptions: spawnOptionsFor\(backend, projectPath, launchOptions\)/);
  assert.doesNotMatch(src, /options: sessionOptions \|\| \{\}/, 'no raw options left in a launch call');
});

// T4: only options the user chose for this launch carry the mark; settings-resolved ones never do. The renderer's
// openSession is not loadable here (app.js is the page's shell), so this is a source check of the one line.
test('openSession marks only the options the user chose for this launch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /if \(resumeOptions && customOptions\) resumeOptions\.resumeOverride = true;/);
  assert.equal((src.match(/resumeOverride = true/g) || []).length, 1, 'no other path sets the mark');
});
