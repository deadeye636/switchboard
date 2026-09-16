const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { conventionDirs } = require('../src/app/convention-dirs');

// The one answer to "where does this project keep handoffs / plans", for the two features that NAME a
// directory rather than read one: the handoff prompt an agent is sent, and an insert template's
// {handoffDir}/{planDir}. A second implementation is how a prompt and a template end up naming different
// directories, and nobody finds out until a packet is missing.

const ROOT = path.resolve('/projects/shop');

test('the defaults come from the settings blob, relative and absolute', () => {
  const dirs = conventionDirs(ROOT, {});
  assert.equal(dirs.handoffDir, '.handoffs');
  assert.equal(dirs.planDir, '.plans');
  assert.equal(dirs.handoffPath, path.join(ROOT, '.handoffs'));
  assert.equal(dirs.planPath, path.join(ROOT, '.plans'));
});

test('a project setting wins, and the absolute path follows it', () => {
  const dirs = conventionDirs(ROOT, { handoffDir: 'docs/handoffs', planDir: 'docs/plans' });
  assert.equal(dirs.handoffDir, 'docs/handoffs');
  assert.equal(dirs.handoffPath, path.join(ROOT, 'docs/handoffs'));
  assert.equal(dirs.planPath, path.join(ROOT, 'docs/plans'));
});

test('whitespace is not a directory — it falls back to the default', () => {
  const dirs = conventionDirs(ROOT, { handoffDir: '   ', planDir: '' });
  assert.equal(dirs.handoffDir, '.handoffs');
  assert.equal(dirs.planDir, '.plans');
});

// A prompt naming a directory outside the project sends an agent to write outside the tree it was opened
// on. The setting is refused here rather than passed on, the same rule the write path applies (#474).
test('a directory that escapes the project is refused, not passed on', () => {
  const dirs = conventionDirs(ROOT, { handoffDir: '../packets', planDir: '..' });
  assert.equal(dirs.handoffDir, '.handoffs');
  assert.equal(dirs.planDir, '.plans');
  assert.equal(dirs.handoffPath, path.join(ROOT, '.handoffs'));
});

test('no project — the names still answer, the paths are empty rather than guessed', () => {
  const dirs = conventionDirs(null, { handoffDir: 'docs/handoffs' });
  assert.equal(dirs.handoffDir, 'docs/handoffs');
  assert.equal(dirs.handoffPath, '');
  assert.equal(dirs.planPath, '');
});

test('settings that are not settings do not throw', () => {
  assert.equal(conventionDirs(ROOT, null).handoffDir, '.handoffs');
  assert.equal(conventionDirs(ROOT, { handoffDir: 42 }).handoffDir, '.handoffs');
});

// An absolute setting pointing INSIDE the project is legal and nothing forbids one. It used to be handed
// back as it was, and `path.join(root, '<root>/packets')` is then the two roots one after the other — so
// the prompt named a directory that does not exist while the save resolved the same setting correctly.
// That is exactly the divergence #623 closed for the escaping case, in the one shape it left behind.
test('an absolute setting inside the project is spelled back out relative (#623)', () => {
  const inside = path.join(ROOT, 'docs', 'packets');
  const dirs = conventionDirs(ROOT, { handoffDir: inside, planDir: ROOT });
  assert.equal(dirs.handoffDir, path.join('docs', 'packets'));
  assert.equal(dirs.handoffPath, inside);
  assert.equal(dirs.planDir, '.', 'the project root itself is a legal answer, spelled as one');
  assert.equal(dirs.planPath, ROOT);
});

// CLAUDE.md reflex 12: this module is the one reader of those two keys. The rule has been broken twice —
// the handoff writer (#623) and the plan directory, which is still open — and both times it was found by
// somebody reading, not by a test. So the second readings are a NAMED list: a new one fails by file, and
// one that goes away has to be struck off here.
const SECOND_READERS = {
  'app/plans-memory.js':
    'planDirFor and planConventionPreview read `eff.planDir` themselves, and the preview REFUSES an escaping '
    + 'value while the plan prompt beside it falls back to `.plans` — the handoff divergence of #623, one '
    + 'setting over. Tracked as #630; strike this entry when it moves to conventionDirs.',
};

test('nothing outside convention-dirs.js reads handoffDir or planDir (#623)', () => {
  const fs = require('node:fs');
  const { stripComments } = require('./helpers/strip-comments');
  const SRC = path.join(__dirname, '..', 'src');
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); }
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  // A caller of conventionDirs()/dirsFor() reads those fields off the ANSWER — the identifier before the dot
  // is then a call, not a settings object — and the settings panel WRITES them, which is its job. What this
  // looks for is the shape that went wrong twice: a settings blob asked for the directory directly.
  const reads = /\b(?:eff|effective|effectiveSettings|settings|blob|values)\w*\s*(?:\([^)]*\))?\s*\.\s*(?:handoffDir|planDir)\b(?!\s*=[^=])/;
  const found = [];
  const seen = new Set();
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === 'app/convention-dirs.js') continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const lines = src.split(/\r?\n/).filter((l) => reads.test(l));
    if (!lines.length) continue;
    seen.add(rel);
    if (SECOND_READERS[rel]) continue;
    found.push(`${rel}  ${lines[0].trim()}`);
  }
  assert.deepEqual(found, [],
    'These ask the settings blob where a project keeps its documents. src/app/convention-dirs.js is the one '
    + 'answer (CLAUDE.md reflex 12) — call conventionDirs(projectPath, eff), or add the file here with the '
    + 'reason:\n' + found.join('\n'));
  const stale = Object.keys(SECOND_READERS).filter((rel) => !seen.has(rel));
  assert.deepEqual(stale, [], 'An entry that covers nothing is a claim nobody checks. Remove it:\n' + stale.join('\n'));

  // The pattern is a second copy of the thing it audits, so it is checked in BOTH directions rather than
  // only against a tree that happens to be clean today.
  const violations = [
    "const dir = eff.handoffDir || '.handoffs';",
    'const value = eff && typeof eff.planDir === \'string\' ? eff.planDir.trim() : \'\';',
    "const name = settings.handoffDir;",
    'const name = effectiveSettings(projectPath).planDir;',
  ];
  for (const line of violations) assert.ok(reads.test(line), `the sweep would miss: ${line}`);
  const fine = [
    'return conventionDirs(projectPath, eff).handoffDir || DEFAULT_WRITE_DIR;',
    "if (svPlanDir) settings.planDir = (svPlanDir.value || '').trim() || '.plans';",
    'const { handoffDir, handoffPath } = dirsFor(projectPath);',
    'handoffDir: session.handoffDir || \'\',',
  ];
  for (const line of fine) assert.ok(!reads.test(line), `false positive: ${line}`);
});
