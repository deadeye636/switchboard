'use strict';
// The per-spawn prompt-template directory Switchboard writes for Pi (#569) — what actually reaches the
// disk and what actually reaches the argv, as opposed to the text of one template.
//
// Nothing else in the tree reads these files: Pi loads the directory named by `--prompt-template` in its
// own process and offers whatever it finds as a slash command. So a directory handed to the wrong kind, a
// flag pointing at the parent instead of the directory that was made, a refusal that throws inside a
// launch, or a spawn that inherits its neighbour's convention directories are all silent everywhere —
// the session starts, Pi says nothing, and `/handoff` either writes into the wrong place or does not
// exist. These assertions are the whole safety net for that.
//
// Sibling of `pi-live-binding.test.js`, which covers the same shape one flag along.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promptTemplates = require('../src/backends/pi/prompt-templates');
const { KINDS, OPTION_ID, buildPromptTemplate, writePromptTemplates, removePromptTemplates } = promptTemplates;

// Every directory this file makes is removed again when the file is done: the suite runs these in
// parallel with everything else, and a test that leaves a tree behind in the system temp directory is a
// leak nobody attributes to it later.
const MADE = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  MADE.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of MADE) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// The module declares its own file names; nothing here spells them, so a rename shows up as a failing
// comparison rather than as a test that quietly agrees with itself.
function declaredFileNames() {
  return KINDS.map(kind => buildPromptTemplate(kind, 'a-directory').fileName).sort();
}

// The only two methods the module ever calls on a log, and a record of what it said.
function recordingLog() {
  const warn = [];
  const debug = [];
  return { warn: (m) => warn.push(String(m)), debug: (m) => debug.push(String(m)), warned: warn, debugged: debug };
}

const DIRS = { handoffDir: '.handoffs', planDir: '.plans' };

test('it writes both templates and hands Pi the directory it made', () => {
  const dir = tempDir('pi-prompts-happy-');
  const log = recordingLog();
  const written = writePromptTemplates({ dir, tag: 'terminal-tag-1', dirs: DIRS, log });

  assert.ok(written, 'a usable pair is offered');
  assert.equal(written.args[0], '--prompt-template');
  assert.equal(written.args.length, 2);
  // The flag names the directory that was created for this spawn, never the parent it was handed — a
  // parent holds the live-binding extension and whatever else the spawn wrote, and Pi would read it all.
  assert.equal(written.args[1], written.cleanup);
  assert.notEqual(written.cleanup, dir);
  assert.equal(path.dirname(written.cleanup), dir);
  assert.ok(written.cleanup.includes('terminal-tag-1'), 'the directory is named after the spawn');

  assert.deepEqual(fs.readdirSync(written.cleanup).sort(), declaredFileNames());
  for (const name of declaredFileNames()) {
    const text = fs.readFileSync(path.join(written.cleanup, name), 'utf8');
    assert.ok(text.trim().length > 0, `${name} is not empty`);
  }
  assert.equal(log.warned.length, 0, 'and nothing is complained about');
});

test('the handoff directory and the plan directory reach their own file and not the other', () => {
  // The mapping that would be silently wrong if the two were swapped: both files would still be written,
  // both commands would still be offered, and every packet would land in the plans directory. Different
  // names on the two sides are what makes the swap visible at all.
  const dir = tempDir('pi-prompts-mapping-');
  const written = writePromptTemplates({
    dir,
    tag: 'terminal-tag-2',
    dirs: { handoffDir: '.packets', planDir: 'docs/plans' },
  });
  assert.ok(written);

  const handoff = fs.readFileSync(path.join(written.cleanup, 'handoff.md'), 'utf8');
  const plan = fs.readFileSync(path.join(written.cleanup, 'plan.md'), 'utf8');

  assert.ok(handoff.includes('.packets'), 'the handoff template names the handoff directory');
  assert.equal(handoff.includes('docs/plans'), false, 'and not the plan directory');
  assert.ok(plan.includes('docs/plans'), 'the plan template names the plan directory');
  assert.equal(plan.includes('.packets'), false, 'and not the handoff directory');
});

test('cleanup removes the directory and its contents, twice and when it is already gone', () => {
  const dir = tempDir('pi-prompts-cleanup-');
  const written = writePromptTemplates({ dir, tag: 'terminal-tag-3', dirs: DIRS });
  assert.ok(fs.existsSync(written.cleanup));

  removePromptTemplates(written.cleanup);
  assert.equal(fs.existsSync(written.cleanup), false, 'the directory and the files in it are gone');

  // A second removal is the ordinary case after a crash or a double shutdown, not an error.
  removePromptTemplates(written.cleanup);
  removePromptTemplates(path.join(dir, 'a-directory-that-was-never-made'));
  removePromptTemplates(undefined);
});

test('it declines without a directory or without a tag, and writes nothing on the way out', () => {
  const dir = tempDir('pi-prompts-declines-');
  assert.equal(writePromptTemplates({ dir, dirs: DIRS }), null, 'no tag');
  assert.equal(writePromptTemplates({ tag: 'terminal-tag-4', dirs: DIRS }), null, 'no directory');
  assert.equal(writePromptTemplates(), null, 'nothing at all');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the option switches it off, and saying nothing means on', () => {
  // `OPTION_ID` is read off the module rather than spelled here: the core hands this hook the session's
  // resolved options and names neither the key nor this backend, so a rename that does not reach the
  // cascade has to fail somewhere, and this is the somewhere.
  const off = tempDir('pi-prompts-off-');
  assert.equal(writePromptTemplates({ dir: off, tag: 'terminal-tag-5', dirs: DIRS, options: { [OPTION_ID]: false } }), null);
  assert.deepEqual(fs.readdirSync(off), [], 'a refused option writes nothing');

  // The field defaults ON and the cascade stores only what somebody marked as set, so an absent key is
  // "nobody said anything" and has to mean yes.
  const absent = tempDir('pi-prompts-absent-');
  assert.ok(writePromptTemplates({ dir: absent, tag: 'terminal-tag-6', dirs: DIRS, options: {} }));
  const none = tempDir('pi-prompts-nooptions-');
  assert.ok(writePromptTemplates({ dir: none, tag: 'terminal-tag-7', dirs: DIRS }));

  const on = tempDir('pi-prompts-on-');
  assert.ok(writePromptTemplates({ dir: on, tag: 'terminal-tag-8', dirs: DIRS, options: { [OPTION_ID]: true } }));
});

test('one unusable directory leaves the other command offered', () => {
  // Pi has no escape for argument substitution, so a directory named `$1` cannot be written into a
  // template at all. The answer is to leave that one command unoffered — not to offer it pointing at a
  // directory the agent will never find, and not to take the other one down with it.
  const dir = tempDir('pi-prompts-one-bad-');
  const log = recordingLog();
  const written = writePromptTemplates({
    dir,
    tag: 'terminal-tag-9',
    dirs: { handoffDir: '$1-packets', planDir: 'docs/plans' },
    log,
  });

  assert.ok(written, 'the survivor is still offered');
  assert.deepEqual(fs.readdirSync(written.cleanup), ['plan.md']);
  assert.equal(fs.existsSync(path.join(written.cleanup, 'handoff.md')), false);
  assert.equal(written.args[1], written.cleanup);

  assert.equal(log.warned.length, 1, 'and the refusal is reported rather than swallowed');
  assert.match(log.warned[0], /handoff/);
  assert.match(log.warned[0], /argument-substitution/);
  assert.equal(log.debugged.length, 1, 'the write itself is reported at debug');
});

test('when neither directory can be written it answers null', () => {
  const dir = tempDir('pi-prompts-both-bad-');
  const log = recordingLog();
  assert.equal(
    writePromptTemplates({ dir, tag: 'terminal-tag-10', dirs: { handoffDir: '$ARGUMENTS', planDir: '${2:-elsewhere}' }, log }),
    null,
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'and no directory is left behind for a spawn that gets nothing');
  assert.equal(log.warned.length, 2, 'both refusals are named');
});

test('a directory that cannot be created is warned about, not thrown', () => {
  // The launch must never fail over this, so the write is wrapped and the caller gets `null`. A file
  // standing where the per-spawn directory would go is the cheapest way to make the write fail for real.
  const dir = tempDir('pi-prompts-unwritable-');
  const tag = 'terminal-tag-11';
  fs.writeFileSync(path.join(dir, `pi-prompts-${tag}`), 'not a directory', 'utf8');

  const log = recordingLog();
  assert.equal(writePromptTemplates({ dir, tag, dirs: DIRS, log }), null);
  assert.equal(log.warned.length, 1);
  assert.match(log.warned[0], /could not write/);
});

test('it tolerates a log with neither method, and no log at all', () => {
  const dir = tempDir('pi-prompts-nolog-');
  assert.ok(writePromptTemplates({ dir, tag: 'terminal-tag-12', dirs: DIRS, log: {} }));

  const bad = tempDir('pi-prompts-nolog-bad-');
  assert.equal(
    writePromptTemplates({ dir: bad, tag: 'terminal-tag-13', dirs: { handoffDir: '$@', planDir: '$@' }, log: {} }),
    null,
  );

  const gone = tempDir('pi-prompts-nolog-cleanup-');
  removePromptTemplates(path.join(gone, 'never-made'), {});
});

test('two tags do not share a directory', () => {
  // One directory per spawn, so two sessions in two projects cannot hand each other their neighbour's
  // convention directories — and so cleanup can remove a directory rather than pick files out of a
  // shared one.
  const dir = tempDir('pi-prompts-two-tags-');
  const first = writePromptTemplates({ dir, tag: 'terminal-tag-14', dirs: { handoffDir: '.packets', planDir: '.plans' } });
  const second = writePromptTemplates({ dir, tag: 'terminal-tag-15', dirs: { handoffDir: '.handoffs', planDir: 'docs/plans' } });

  assert.notEqual(first.cleanup, second.cleanup);
  assert.ok(fs.readFileSync(path.join(first.cleanup, 'handoff.md'), 'utf8').includes('.packets'));
  assert.ok(fs.readFileSync(path.join(second.cleanup, 'handoff.md'), 'utf8').includes('.handoffs'));

  // And removing one spawn's directory leaves the other spawn running with its own.
  removePromptTemplates(first.cleanup);
  assert.equal(fs.existsSync(first.cleanup), false);
  assert.ok(fs.existsSync(path.join(second.cleanup, 'plan.md')));
});
