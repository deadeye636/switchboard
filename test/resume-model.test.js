'use strict';
// #754: a resume launches on what the session last ran on. This file pins the core's half — the merge and its
// precedence in src/app/terminal/resume-options.js — against a fake descriptor, and that spawn.js feeds the
// merged options to buildLaunch. What a backend answers is its own test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { stripComments } = require('./helpers/strip-comments');
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

const pair = (model, provider) => () => ({ options: { model, provider }, label: model });

test('a patch is applied as a unit: an override that sets any key drops the whole patch', async () => {
  const r = await run({ backend: fake(pair('last', 'p-last')), sessionOptions: { model: 'chosen', resumeOverride: true } });
  assert.deepEqual(r.options, { model: 'chosen' });
  assert.deepEqual(r.applied, []);
  const r2 = await run({ backend: fake(pair('last', 'p-last')), sessionOptions: { provider: 'chosen-p', resumeOverride: true } });
  assert.deepEqual(r2.options, { provider: 'chosen-p' });
});

test('an override that sets nothing of the patch takes the full patch', async () => {
  const r = await run({ backend: fake(pair('last', 'p-last')), sessionOptions: { effort: 'high', model: '', resumeOverride: true } });
  assert.deepEqual(r.options, { effort: 'high', model: 'last', provider: 'p-last' });
  assert.deepEqual(r.applied, ['model', 'provider']);
});

test('without the mark every key of the patch replaces the settings', async () => {
  const r = await run({ backend: fake(pair('last', 'p-last')), sessionOptions: { model: 's', provider: 'sp' } });
  assert.deepEqual(r.options, { model: 'last', provider: 'p-last' });
});

test('a null value clears the key; undefined and empty string leave it alone', async () => {
  const r = await run({ backend: fake(pair('last', null)), sessionOptions: { model: 's', provider: 'sp', effort: 'high' } });
  assert.deepEqual(r.options, { model: 'last', effort: 'high' });
  assert.ok(!('provider' in r.options));
  assert.deepEqual(r.applied, ['model', 'provider']);
  const r2 = await run({ backend: fake(() => ({ options: { model: 'last', provider: undefined, effort: '' } })), sessionOptions: { provider: 'sp', effort: 'high' } });
  assert.deepEqual(r2.options, { model: 'last', provider: 'sp', effort: 'high' });
  // a lone null that clears nothing is no answer
  const r3 = await run({ backend: fake(() => ({ options: { provider: null } })), sessionOptions: { model: 's' } });
  assert.deepEqual(r3.options, { model: 's' });
  assert.deepEqual(r3.applied, []);
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
  // #760: the mark is the dialog's list of changed fields when it sent one, else `true`.
  assert.match(src, /if \(resumeOptions && customOptions\) \{[^}]*resumeOptions\.resumeOverride = chosen \|\| true;/);
  assert.equal((src.match(/resumeOverride = /g) || []).length, 1, 'no other path sets the mark');
  assert.match(src, /delete resumeOptions\.resumeChosen;/, 'the list never reaches main under its own name');
});

// #760: the Resume-with-config dialog sends every field and names the ones the user changed.
test('a list mark counts only the keys it names as chosen', async () => {
  const kept = await run({ sessionOptions: { model: 'shown', effort: 'high', resumeOverride: ['effort'] } });
  assert.deepEqual(kept.options, { model: 'last', effort: 'high' }, 'a model left as it was shown does not beat the hook');
  const chosen = await run({ sessionOptions: { model: 'chosen', resumeOverride: ['model'] } });
  assert.deepEqual(chosen.options, { model: 'chosen' });
  assert.deepEqual(chosen.applied, []);
  const pairPart = await run({ backend: fake(pair('last', 'p-last')), sessionOptions: { model: 'shown', provider: 'chosen-p', resumeOverride: ['provider'] } });
  assert.deepEqual(pairPart.options, { model: 'shown', provider: 'chosen-p' }, 'one chosen key of the patch still drops it whole');
  const none = await run({ sessionOptions: { model: 'shown', resumeOverride: [] } });
  assert.equal(none.options.model, 'last');
  assert.ok(!('resumeOverride' in none.options));
});

test('the preview answers what a plain resume would apply, with a cleared key as null, or null', async () => {
  const { previewResumeOptions } = require('../src/app/terminal/resume-options');
  const ask = (hook, sessionOptions) => previewResumeOptions({ backend: fake(hook), row: { id: 's' }, projectPath: '/p', env: {}, sessionOptions });
  assert.deepEqual(await ask(answer('last')), { options: { model: 'last' }, label: 'last' });
  // Asked with the settings a plain resume sends: a key it clears is shown as cleared.
  assert.deepEqual(await ask(pair('last', null), { model: 's', provider: 'sp' }), { options: { model: 'last', provider: null }, label: 'last' });
  // The hook sees those settings (a backend may answer by them), never the mark.
  let seen = null;
  await ask((_row, c) => { seen = c.launchOptions; return null; }, { model: 'opus[1m]', resumeOverride: ['model'] });
  assert.deepEqual(seen, { model: 'opus[1m]' });
  assert.equal(await ask(() => null), null);
  assert.equal(await ask(() => { throw new Error('x'); }), null);
});

// T8: the backend words the notice; the core relays it, only for an answer that was applied.
const noted = (notice, extra = {}) => fake(() => ({ options: { model: 'last' }, label: 'last', notice, ...extra }));

test('the core shows the hook notice as given and composes no text of its own', async () => {
  assert.equal((await run({ backend: noted('  Resumed on X  '), sessionOptions: { model: 'setting' } })).notice, 'Resumed on X');
  assert.equal((await run({ sessionOptions: { model: 'setting' } })).notice, null, 'a hook with no notice says nothing, however the model differs');
  for (const bad of ['', '   ', 5, {}, null]) assert.equal((await run({ backend: noted(bad), sessionOptions: {} })).notice, null);
});

test('no notice when the hook declines, is overridden, only clears, or it is not a resume', async () => {
  assert.equal((await run({ backend: fake(() => null), sessionOptions: { model: 's' } })).notice, null);
  assert.equal((await run({ backend: noted('N'), sessionOptions: { model: 'chosen', resumeOverride: true } })).notice, null);
  assert.equal((await run({ backend: fake(() => ({ options: { provider: null }, notice: 'N' })), sessionOptions: {} })).notice, null, 'nothing to clear: nothing applied');
  assert.equal((await run({ backend: noted('N'), resume: false, sessionOptions: { model: 's' } })).notice, null);
  assert.equal((await run({ backend: fake(() => { throw new Error('x'); }), sessionOptions: {} })).notice, null);
});

test('an empty override key filled from the hook carries the hook notice', async () => {
  const r = await run({ backend: noted('N'), sessionOptions: { model: '', resumeOverride: true } });
  assert.equal(r.notice, 'N');
});

test('the core hands the hook the options that were sent, without the mark', async () => {
  let seen;
  await run({ backend: fake((row, ctx) => { seen = ctx.launchOptions; return null; }), sessionOptions: { model: 'm', resumeOverride: true } });
  assert.deepEqual(seen, { model: 'm' });
});

test('resume-options.js words nothing itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'resume-options.js'), 'utf8');
  assert.ok(!/Resumed on|last used/.test(stripComments(src)), 'no sentence in code');
});

test('spawn.js says the notice through the session notice op or the buffer, once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'terminal', 'spawn.js'), 'utf8');
  assert.match(src, /resumeModelNotice = resumed\.notice;/);
  assert.match(src, /ptyProcess\.notice\('info', resumeModelNotice\)/);
  assert.match(src, /\} else if \(resumeModelNotice\) \{/, 'a terminal gets it through the buffer');
});
