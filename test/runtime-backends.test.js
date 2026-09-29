// The runtime-driven backends (#664): every backend whose descriptor declares `transport` is driven over a
// pipe by `src/app/agent-rpc.js`, and keeps only its protocol translator, its launch and its marker (#653 E7).
// The pipe's line reader, the open-question registry and the busy/owed tracking are the core's, once.
//
// These guards run over every such backend, derived from the registry, so a third one is covered the day it
// is registered:
//
//   1. What its protocol module exports, the descriptor hands to the core (identity, not name).
//   2. What the descriptor's `rpc` half declares, the core READS — derived from agent-rpc.js's own source.
//      A backend that grows an `asks()`, an `isBusy()` or an `onData` there declares something the core never
//      calls, and fails by name. The same for the object `createDecoder()` returns.
//   3. Every op its folder emits is one the core or the conversation view handles — also derived.
//   4. Its folder defines none of the helpers in `src/backends/rpc-shared.js` again, and an approval it asks
//      carries every field the approval card reads (`APPROVAL_ASK_KEYS`).
//
// What these do NOT see is private state inside a closure — a busy flag nobody exports — and a helper copied
// inline without its name (the definition scan matches names). Those limits were accepted when the guard's
// shape was chosen (#664); spec 32 says so.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripComments } = require('./helpers/strip-comments');
const backends = require('../src/backends');
const rpcShared = require('../src/backends/rpc-shared');

const ROOT = path.join(__dirname, '..');
const RUNTIME = backends.list().filter(b => b.status === 'ready' && !b.isProfile && b.transport);
const folderOf = (id) => path.join(ROOT, 'src', 'backends', id);
const readStripped = (file) => stripComments(fs.readFileSync(file, 'utf8'));
// Every `.js` file under a backend's folder, subfolders included.
const jsFilesOf = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return jsFilesOf(p);
  return d.name.endsWith('.js') ? [p] : [];
});
// The body of one nested function of a file, from its declaration to the next one at the same depth. The
// scans below ask what a particular function handles, not what the whole file happens to spell.
function bodyOf(src, declaration) {
  const start = src.indexOf(declaration);
  assert.ok(start >= 0, `the scan finds ${declaration}`);
  const next = src.indexOf('\n  function ', start + declaration.length);
  return src.slice(start, next < 0 ? undefined : next);
}

test('the runtime-driven backends are found', () => {
  assert.ok(RUNTIME.length >= 2, 'pi-native (#568) and claude-native (#653) are registered with a transport');
});

// The descriptor's `rpc` object is copied out of the protocol module by hand, and the core reaches the protocol
// ONLY through it — so a function added to the module and forgotten there is unreachable, with no error
// anywhere: the core's feature checks read as "this backend cannot do that" and the feature is simply absent.
// `statsCommand` shipped that way for one test run (#643). This used to be two copies of one test, one per
// backend; it is one loop now.
const NOT_HANDED_OVER = {
  'pi-native': {},
  'claude-native': {
    // The filter an attach applies to the transcript; the core is handed `entriesFromTranscript`, which uses it.
    conversationEntries: 'used by entriesFromTranscript, which is what the core is given',
  },
};

test('every part of a runtime protocol the core could use is handed to it', () => {
  assert.deepEqual(Object.keys(NOT_HANDED_OVER).sort(), RUNTIME.map(b => b.id).sort(),
    'NOT_HANDED_OVER has one entry per runtime-driven backend, empty when nothing is withheld');
  for (const b of RUNTIME) {
    const protocol = require(path.join(folderOf(b.id), 'rpc-protocol.js'));
    const exempt = NOT_HANDED_OVER[b.id];
    const exported = Object.keys(protocol).filter(k => typeof protocol[k] === 'function');
    // The IDENTITY, not the name: `statsCommand: protocol.stateCommand` passes a name check and would send the
    // core to the wrong command, which is the failure this guard exists to make loud.
    const missing = exported.filter(k => b.rpc[k] !== protocol[k] && !Object.prototype.hasOwnProperty.call(exempt, k));
    assert.deepEqual(missing, [],
      `${b.id}: rpc-protocol.js exports these and the descriptor's \`rpc\` does not pass them on: ${missing.join(', ')}. `
      + 'Add them there, or name them in NOT_HANDED_OVER with the reason the core must not call them.');
    const stale = Object.keys(exempt).filter(k => !exported.includes(k));
    assert.deepEqual(stale, [], `${b.id}: NOT_HANDED_OVER names something the protocol no longer exports: ${stale.join(', ')}`);
  }
});

// What the core reads off an object, from its own source with the prose dropped (CLAUDE.md reflex 14): a name
// mentioned only in a comment is not read by anything.
const CORE = readStripped(path.join(ROOT, 'src', 'app', 'agent-rpc.js'));
function membersRead(src, object) {
  return new Set([...src.matchAll(new RegExp(`\\b${object}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map(m => m[1]));
}

test('the member scan finds what it has to, so a green run is not a blind one', () => {
  // Written down before trusting the tree (`.claude/rules/guards-and-scripts.md`): the shapes the scan must see.
  assert.deepEqual([...membersRead('state.rpc.responseOf(msg); x = rpc.sendAcknowledged', 'rpc')].sort(),
    ['responseOf', 'sendAcknowledged']);
  assert.ok(membersRead(CORE, 'rpc').has('createDecoder'), 'agent-rpc.js reads the decoder factory off the rpc half');
  assert.ok(membersRead(CORE, 'decoder').has('decode'), 'and decode off the decoder');
});

test('a runtime\'s rpc half declares nothing the core does not read', () => {
  const read = membersRead(CORE, 'rpc');
  for (const b of RUNTIME) {
    const unread = Object.keys(b.rpc).filter(k => !read.has(k));
    assert.deepEqual(unread, [],
      `${b.id}: its rpc half declares ${unread.join(', ')}, which src/app/agent-rpc.js never reads. A line reader, an `
      + 'ask registry or a busy tracker belongs to the core; a new optional hook is read there first and listed in '
      + '.claude/rules/backends.md ("What the rpc half declares").');
  }
});

test('a runtime\'s decoder offers nothing the core does not call', () => {
  const read = membersRead(CORE, 'decoder');
  for (const b of RUNTIME) {
    const decoder = b.rpc.createDecoder();
    const unread = Object.keys(decoder).filter(k => !read.has(k));
    assert.deepEqual(unread, [], `${b.id}: its decoder offers ${unread.join(', ')}, which src/app/agent-rpc.js never calls`);
    assert.deepEqual(decoder.decode(null), [], `${b.id}: a decoder answers a record it cannot read with no ops`);
    assert.deepEqual(decoder.decode({}), [], `${b.id}: and an empty one too`);
  }
});

// Every op a translator emits reaches somebody: the core handles it (agent-rpc.js's `handleOp`, plus the
// ones it answers itself), or it is forwarded and the conversation view applies it. An op nobody handles is
// forwarded and silently dropped by the view.
function casesIn(src) {
  return new Set([...src.matchAll(/\bcase\s+'([A-Za-z]+)'\s*:/g)].map(m => m[1]));
}
const VIEW = readStripped(path.join(ROOT, 'src', 'renderer', 'session', 'conversation-view.js'));

test('every op a runtime emits is one the core or the conversation view handles', () => {
  // Only the two op switches count — a `case 'select':` for a dialog method elsewhere in either file is not an
  // op anybody handles.
  const known = new Set([...casesIn(bodyOf(CORE, 'function handleOp(')), ...casesIn(bodyOf(VIEW, 'function apply('))]);
  for (const op of ['append', 'partial', 'ask', 'identity', 'notice', 'tool']) {
    assert.ok(known.has(op), `the op scan finds '${op}' among the handled ops`);
  }
  assert.ok(!known.has('select') && !known.has('confirm'), 'and not the dialog methods the view switches on elsewhere');
  for (const b of RUNTIME) {
    for (const file of jsFilesOf(folderOf(b.id))) {
      for (const m of readStripped(file).matchAll(/\bop:\s*'([A-Za-z]+)'/g)) {
        assert.ok(known.has(m[1]),
          `${path.relative(ROOT, file)} emits op '${m[1]}', which neither src/app/agent-rpc.js nor the conversation view handles`);
      }
    }
  }
});

// The helpers both translators need live once, in `src/backends/rpc-shared.js`. A folder that writes one of
// them again is where two copies start to drift — the `/` list's 200-character cap was written twice before.
//
// A definition counts only where it starts a line of this file's own code. Pi's per-spawn extensions are
// TypeScript written out of string literals (`session-commands.js` builds one with a `const textOf = …` line
// of its own), and that code runs inside Pi's process, where this module cannot be required — so a copy
// there is not the defect this guard is about.
test('no runtime folder defines a helper of rpc-shared.js again', () => {
  const defines = (src, name) => new RegExp(`^[ \\t]*(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`, 'm').test(src);
  assert.ok(defines('function textOf(c) {}', 'textOf') && defines('  const argsFromText = () => {};', 'argsFromText'),
    'the definition scan sees both shapes');
  assert.ok(!defines("    '      const textOf = (c: any) => c;',", 'textOf'), 'and not a line of generated TypeScript in a string');
  const names = Object.keys(rpcShared).filter(k => typeof rpcShared[k] === 'function');
  assert.ok(names.includes('textOf') && names.includes('argsFromText'), 'the shared helpers are found');
  for (const b of RUNTIME) {
    for (const file of jsFilesOf(folderOf(b.id))) {
      const src = readStripped(file);
      for (const name of names) {
        assert.ok(!defines(src, name),
          `${path.relative(ROOT, file)} defines ${name} again — take it from src/backends/rpc-shared.js`);
      }
    }
  }
});

// One record per runtime that makes its decoder ask an ordinary tool approval. A new runtime-driven backend
// fails here until it has one, which is the point: the approval card reads these fields whoever asked.
const APPROVAL_SAMPLES = {
  'pi-native': () => {
    const { APPROVAL_PREFIX, CHOICES } = require('../src/backends/pi-native/runtime-extension');
    return { type: 'extension_ui_request', id: 'q1', method: 'select',
      title: APPROVAL_PREFIX + JSON.stringify({ tool: 'bash', id: 'call_1' }), options: Object.values(CHOICES) };
  },
  'claude-native': () => ({ type: 'control_request', request_id: 'r1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: { command: 'ls' } } }),
};

// Fields the card reads that a runtime may leave out, with the reason.
const APPROVAL_OPTIONAL = {
  sessionLabel: 'only where "for this session" is offered and the runtime can say what it allows; the card has its own words otherwise',
  projectLabel: 'only where a lasting allow for the project is offered (#674); the card has its own words otherwise',
  projectNote: 'only beside a lasting allow (#674): where the rule lands and how it is taken back, shown as the button\'s tooltip',
  reason: 'only where the runtime says why it asks (claude-native: a matched ask rule, a decision reason); pi-native\'s gate asks every time for the same reason',
};

test('APPROVAL_ASK_KEYS is what the approval card reads', () => {
  // Derived from `renderApproval`, so a field the card starts reading fails here until the list names it.
  const reads = new Set([...bodyOf(VIEW, 'function renderApproval(').matchAll(/\brequest\.([A-Za-z]+)/g)].map(m => m[1]));
  reads.add('kind');   // read by `renderAsk`, which routes an approval to the card
  for (const k of Object.keys(APPROVAL_OPTIONAL)) reads.delete(k);
  assert.deepEqual([...reads].sort(), [...rpcShared.APPROVAL_ASK_KEYS].sort(),
    'src/backends/rpc-shared.js APPROVAL_ASK_KEYS and the fields renderApproval reads differ');
});

test('an approval carries every field the approval card reads, whichever runtime asked', () => {
  assert.deepEqual(Object.keys(APPROVAL_SAMPLES).sort(), RUNTIME.map(b => b.id).sort(),
    'APPROVAL_SAMPLES has one record per runtime-driven backend');
  for (const b of RUNTIME) {
    const ops = b.rpc.createDecoder().decode(APPROVAL_SAMPLES[b.id]());
    const ask = ops.find(o => o.op === 'ask');
    assert.ok(ask, `${b.id}: the sample record is asked as an approval`);
    assert.equal(ask.request.kind, 'approval', `${b.id}: of kind approval`);
    const missing = rpcShared.APPROVAL_ASK_KEYS.filter(k => ask.request[k] === undefined);
    assert.deepEqual(missing, [], `${b.id}: its approval lacks ${missing.join(', ')}`);
  }
});

test('the shared helpers answer as both translators relied on', () => {
  assert.equal(rpcShared.textOf('plain'), 'plain');
  assert.equal(rpcShared.textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(rpcShared.textOf(null), '');
  assert.deepEqual(rpcShared.argsFromText(''), {});
  assert.deepEqual(rpcShared.argsFromText('{"a":1}'), { a: 1 });
  const { isPartialArgs, PARTIAL_ARGS_KEY } = require('../src/shared/partial-args');
  const half = rpcShared.argsFromText('{"command":"ec');
  assert.ok(isPartialArgs(half));
  assert.equal(half[PARTIAL_ARGS_KEY], '{"command":"ec');
  assert.ok(!isPartialArgs({ command: 'echo' }));
  assert.equal(rpcShared.oneLineDescription('  two\n\nlines  '), 'two lines');
  assert.equal(rpcShared.oneLineDescription('x'.repeat(300)).length, 200);
  assert.equal(rpcShared.oneLineDescription(undefined), '');
});
