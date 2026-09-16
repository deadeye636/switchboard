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

// …and with no project there is nothing to resolve against, so the LEXICAL rule answers — the one the
// welcome tour draws from. An insert template for a session with no project used to paste `../packets`
// into a prompt (#630). Nothing else pins the order of those two checks, and getting it wrong is silent.
test('no project — a name nothing could use still falls back (#630)', () => {
  for (const name of ['../packets', '..', '.', 'docs/..', '   ']) {
    assert.equal(conventionDirs(null, { handoffDir: name }).handoffDir, '.handoffs', name);
  }
  // An absolute one is NOT judged: it may point inside the project this template is pasted into, and
  // without a project nothing here can say. It goes through as written.
  const absolute = path.resolve('/srv/projects/shop/.handoffs');
  assert.equal(conventionDirs(null, { handoffDir: absolute }).handoffDir, absolute);
});

// The lexical rule is deliberately NOT asked when there IS a project. It would refuse this, and the
// filesystem does not: the name climbs out of the project and lands back inside it.
test('a name that climbs out and back in is decided by the filesystem, not lexically (#630)', () => {
  const project = path.resolve(ROOT);
  const name = '../' + path.basename(project) + '/docs/packets';
  assert.equal(conventionDirs(project, { handoffDir: name }).handoffDir, name,
    'a lexical veto in front of isInside would have replaced a setting that works');
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
  const dirs = conventionDirs(ROOT, { handoffDir: inside, planDir: 'docs/plans' });
  assert.equal(dirs.handoffDir, path.join('docs', 'packets'));
  assert.equal(dirs.handoffPath, inside);
  assert.equal(dirs.planDir, 'docs/plans', 'a relative spelling is left exactly as it was written');
});

// Strictly inside, so the project root is not an answer either (#630). Neither feature means "the whole
// project is the directory": the handoff write target joins the read/delete guard — handoffDirs adds it
// and isAllowedHandoffPath asks isInside — so a `.` there made every .md at any depth in the project
// readable and deletable through the handoff IPC, and the plan-convention setup refuses the root outright
// because Claude does.
test('the project root itself falls back like any other unusable value (#630)', () => {
  for (const spelling of ['.', './', ROOT, path.join(ROOT, 'docs', '..')]) {
    const dirs = conventionDirs(ROOT, { handoffDir: spelling, planDir: spelling });
    assert.equal(dirs.handoffDir, '.handoffs', `handoffDir for ${spelling}`);
    assert.equal(dirs.planDir, '.plans', `planDir for ${spelling}`);
  }
});

// CLAUDE.md reflex 12: this module is the one reader of those two keys. The rule has been broken twice —
// the handoff writer (#623) and the plan directory (#630) — and both times it was found by
// somebody reading, not by a test. So a second reading is a NAMED exemption: a new one fails by file, and
// one that goes away has to be struck off here — which is what #630 did with the only entry this ever had.
// It is empty on purpose. An addition to it is a claim that one more surface may answer this question
// itself, and that claim has been wrong both times it was made.
const SECOND_READERS = {};

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
  //
  // Three alternatives, because a read takes three shapes and no single "identifier dot key" pattern sees
  // more than the first. A false positive here costs one reviewed line; a false negative is the entire
  // failure mode this guard exists for, so where the two trade off this takes the noisy one
  // (`.claude/rules/guards-and-scripts.md`).
  const BLOB = String.raw`(?:eff|effective|effectiveSettings|settings|blob|values)\w*`;
  const KEY = String.raw`(?:handoffDir|planDir)`;
  const ANSWER = String.raw`(?:conventionDirs|dirsFor)`;
  // `settings.planDir = …` is the settings panel writing the blob, which is its job, not a second reader.
  const NOT_A_WRITE = String.raw`(?!\s*=[^=])`;
  const reads = new RegExp([
    // 1. The blob is NAMED and the key hangs off it: `eff.planDir`, `eff?.planDir`, `eff['planDir']`,
    //    `effectiveSettings(projectPath).planDir`. Both spellings of the access, because `?.` and a
    //    bracket are the same read and a guard that only knows the dot is a guard for one spelling — and
    //    so is the two TOGETHER, `eff?.['planDir']`, which is why the optional part sits outside both.
    String.raw`\b${BLOB}\s*(?:\([^)]*\))?\s*(?:\?\.)?\s*(?:\.?\s*${KEY}\b(?![\w'"])|\[\s*['"]${KEY}['"]\s*\])${NOT_A_WRITE}`,
    // 2. Destructuring puts the key on the LEFT of the object — `const { planDir } = eff;` — so nothing
    //    precedes it and alternative 1 is structurally blind to it. The right-hand side has to be
    //    blob-ish, which is what keeps `const { handoffDir } = dirsFor(p)` — reading the ANSWER — legal.
    //    The exemption covers the WHOLE right-hand side, not the character after the `=`: written the
    //    short way the engine matches `\s*` as nothing, finds a space rather than `conventionDirs` in
    //    front of the lookahead, and flags `const { planDir } = conventionDirs(p, eff)` — the shape this
    //    guard exists to send people to, with an exemption list the comment above declares closed.
    String.raw`\{[^{}]*\b${KEY}\b[^{}]*\}\s*=\s*(?![^;]*\b${ANSWER}\s*\()[^;]*\b${BLOB}\b`,
    // 3. The receiver is not the blob's name: `(ctx.effectiveSettings(p) || {}).planDir`, `(eff || {})
    //    .planDir`, or an alias a statement later. `(<getter> || {}).<key>` is this codebase's house style
    //    for another key in src/app/terminal/spawn.js, so this is the realistic next violation rather than
    //    a hypothetical one. Naming the receiver is exactly what cannot be done, so this alternative asks
    //    the LINE instead: a settings blob is named somewhere on it and one of the keys is taken off
    //    something. The price is that a line already calling the approved helper is exempted by name — and
    //    only those two names, so a third route to the answer is caught until somebody adds it here.
    String.raw`^(?=.*\b${BLOB}\b)(?!.*\b${ANSWER}\s*\().*\.\s*${KEY}\b${NOT_A_WRITE}`,
  ].join('|'));
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
  // Written down BEFORE the tree needs them: the five below the first four were all MISSED by the pattern
  // this guard shipped with, and the tree was green either way. A narrowing that loses one of them fails
  // here by name instead of going quiet.
  const violations = [
    "const dir = eff.handoffDir || '.handoffs';",
    'const value = eff && typeof eff.planDir === \'string\' ? eff.planDir.trim() : \'\';',
    "const name = settings.handoffDir;",
    'const name = effectiveSettings(projectPath).planDir;',
    'const dir = eff?.planDir;',                         // optional chaining is the same read
    'const { planDir } = eff;',                          // the key sits left of the object
    'const dir = (ctx.effectiveSettings(p) || {}).planDir;', // house style elsewhere for another key
    "const dir = eff['planDir'];",                       // a bracket is the same read as a dot
    'const s = ctx.effectiveSettings(p); s.planDir;',    // the receiver is an alias, not the blob's name
    "const dir = eff?.['planDir'];",                     // optional chain AND bracket, which is one read
    'const dir = (eff || {}).planDir;',                  // the same house style with no getter call on the line
  ];
  for (const line of violations) assert.ok(reads.test(line), `the sweep would miss: ${line}`);
  // The other direction, and it is not decoration: every line here is in the tree today and is correct —
  // reading the answer, writing the blob, destructuring the answer, a session row carrying its own field.
  const fine = [
    'return conventionDirs(projectPath, eff).handoffDir || DEFAULT_WRITE_DIR;',
    "if (svPlanDir) settings.planDir = (svPlanDir.value || '').trim() || '.plans';",
    'const { handoffDir, handoffPath } = dirsFor(projectPath);',
    // The shape this whole guard exists to send people to. It carries a blob on the line — the cascade it
    // hands over — so every alternative has to let it through, and the first version of alternative 2 did
    // not: a closed exemption list plus a false positive here is a red guard with no legitimate door.
    'const { planDir } = conventionDirs(p, eff);',
    'const { handoffDir, planDir } = conventionDirs(projectPath, eff);',
    'const { planDir } = conventionDirs(projectPath, effectiveSettings(p));',
    'handoffDir: session.handoffDir || \'\',',
  ];
  for (const line of fine) assert.ok(!reads.test(line), `false positive: ${line}`);
});
