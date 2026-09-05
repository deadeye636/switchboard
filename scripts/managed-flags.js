'use strict';
// Which flags does this app actually put on a CLI's command line? #548 — ASK THE DESCRIPTOR, never a list.
//
// Every `scripts/check-*-help.js` used to hold a hand-typed `MANAGED` set beside its `AUDITED_EXCLUDED`
// one, and that is how `hermes --checkpoints` survived: the flag was missing from the CLI **and** missing
// from the list at the same time, so the audit compared two things that agreed with each other and stayed
// green while every session launched with that toggle died at spawn. A list somebody types answers "did
// the CLI grow a flag we have not looked at". It cannot answer "does everything we send still exist".
//
// So the managed set is derived here from what the backend WOULD send: `buildLaunch` at every launch shape
// and with every declared option at a value that reaches the argv, plus `buildLiveBinding` for the backends
// that hand the CLI a per-spawn file (Claude's `--settings`, Pi's `--extension`). A flag the app starts
// sending is in scope for the audit the moment it is written, with nothing to remember.
//
// The second half is `definitionFlags`: a flag counts as advertised only where the help DEFINES it, not
// where another flag's description happens to mention it. Scraping every `--word` off every line made
// `--add-dir`, `--settings`, `--tools` and `--worktree` "advertised" by Claude's prose alone — the CLI
// could have dropped any of them and the audit would still have passed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The launch context the probes run in. Invented values: nothing here touches a real project. */
const CTX = { cwd: '/project', resume: false, sessionId: 'SESSION-ID' };

/** A value that will actually show up in the argv for a field of this type (same shape the contract test uses). */
function probeValue(field) {
  if (field.type === 'toggle') return true;
  if (field.type === 'select') {
    const choices = (field.choices || []).filter(Boolean);
    return choices.find(c => c !== field.default) || choices[0] || '';
  }
  if (field.type === 'number') return 42;
  return 'PROBE-VALUE';
}

/** The flags in an argv — a token that looks like an option, never a value we passed in. */
function flagsIn(args) {
  return (args || [])
    .map(a => String(a))
    .filter(a => /^--?[a-z0-9][a-z0-9-]*$/i.test(a));
}

/**
 * An options object that answers every question with a usable value, so every `if (opts.x)` branch in a
 * `buildLaunch` is taken at once. `configFields` is not the whole story: Claude's `buildLaunch` honours
 * `appendSystemPrompt`, which no field declares, and a set built from the declared fields alone would
 * have called that flag unmanaged. What buildLaunch READS is the question, not what the settings page shows.
 */
const EVERY_OPTION = new Proxy({}, {
  get: (_target, prop) => (typeof prop === 'string' ? 'PROBE-VALUE' : undefined),
  has: () => true,
});

/**
 * Every launch this backend can build. A SELECT gets every one of its choices, not one probe value:
 * Claude's `permissionMode` emits `--permission-mode` for most of them and
 * `--dangerously-skip-permissions` for one, and Pi's `approval` emits two different flags — a single
 * probe value would audit whichever branch it happened to land in. The launch SHAPES are separate
 * variants for the same reason: resume, fork and a new session are three mutually exclusive branches.
 */
function launchVariants(backend) {
  const variants = [
    { ...CTX, options: {} },
    { ...CTX, resume: true, options: {} },
    { ...CTX, forkFrom: 'PARENT-SESSION-ID', options: {} },
    { ...CTX, options: EVERY_OPTION },
    { ...CTX, resume: true, options: EVERY_OPTION },
  ];
  for (const field of backend.configFields || []) {
    // Applied at the spawn site rather than in the argv — it has no flag of its own to audit.
    if (field.appliesAt === 'spawn') continue;
    const base = field.requires ? { [field.requires]: true } : {};
    const values = field.type === 'select'
      ? (field.choices || []).filter(Boolean)
      : [probeValue(field)];
    for (const value of values) variants.push({ ...CTX, options: { ...base, [field.id]: value } });
  }
  return variants;
}

/**
 * The per-spawn file some backends hand their CLI (#223/#303). It is a real flag on a real command line,
 * so it belongs in the audit — Pi's `--extension` sat in its EXCLUDED list until this derivation found it.
 * The hook WRITES the file, so it gets a throwaway directory and the backend's own release hook.
 */
function bindingFlags(backend) {
  if (typeof backend.buildLiveBinding !== 'function') return [];
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-flag-audit-'));
    const binding = backend.buildLiveBinding({
      dir,
      tag: 'FLAG-AUDIT',
      url: 'http://127.0.0.1:1/clear',
      sessionUrl: 'http://127.0.0.1:1/session',
    });
    if (!binding) return [];
    if (binding.cleanup && typeof backend.releaseLiveBinding === 'function') {
      try { backend.releaseLiveBinding(binding.cleanup); } catch { /* the temp dir goes anyway */ }
    }
    return flagsIn(binding.args);
  } catch {
    // A binding we could not build tells us nothing about the flags — say nothing rather than assert none.
    return [];
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/** Every flag this backend can put on its CLI's command line, derived — not written down. */
function managedFlags(backend) {
  const flags = new Set(bindingFlags(backend));
  for (const variant of launchVariants(backend)) {
    let launch;
    try { launch = backend.buildLaunch(variant); } catch { continue; }
    for (const flag of flagsIn(launch && launch.args)) flags.add(flag);
  }
  return [...flags].sort();
}

/**
 * The flags one help line DEFINES. A definition sits at the left of its line and ends where the
 * description begins (a run of two or more spaces); anything after that is prose, and prose naming a
 * flag is not the CLI advertising it.
 *
 * Both halves matter. Without the indent limit a wrapped description line that happens to start with a
 * flag counts as a definition; without the signature cut, `-c  Short alias for --continue` would advertise
 * `--continue` from a line that defines `-c`.
 */
function definitionFlags(line, { maxIndent = 6 } = {}) {
  const plain = String(line == null ? '' : line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
  const body = plain.replace(/^\s+/, '');
  if (!body.startsWith('-')) return [];
  if (plain.length - body.length > maxIndent) return [];
  const signature = body.split(/\s{2,}/)[0];
  return [...signature.matchAll(/(?<![\w-])--?[a-z0-9][a-z0-9-]*/gi)].map(m => m[0]);
}

/**
 * The audit itself, from the definition GROUPS a help's options section yields (one array of flags per
 * definition line, so `-m, --model` stays one option with two spellings).
 *
 * Two questions, one pass:
 *   unknown — the CLI advertises an option nobody here has decided about.
 *   missing — we send something this CLI does not define. #548's failure, and the direction a
 *             hand-written MANAGED could not ask.
 *
 * A short flag is answered through its own line's long spelling, because that is where the help puts it:
 * we send `hermes -r`, the CLI documents `--resume SESSION, -r SESSION`, and dropping `-r` from that line
 * is what the audit has to notice.
 */
function auditFlags({ backend, groups, excluded, alsoSent }) {
  const advertised = new Set();
  const longFor = new Map();
  for (const group of groups) {
    const longs = group.filter(f => f.startsWith('--'));
    for (const long of longs) advertised.add(long);
    for (const flag of group) {
      if (flag.startsWith('--')) continue;
      if (longs.length) longFor.set(flag, longs[0]);
      else advertised.add(flag);
    }
  }

  // `alsoSent` is for a flag the CORE adds, outside the descriptor's launch hooks — Claude's `--ide` after
  // the MCP bridge starts, Pi's `--list-models` in its model probe. Each caller names its own, with the
  // reason beside it; they are audited in both directions exactly like a derived one.
  const sent = [...new Set([...managedFlags(backend), ...(alsoSent || [])])].sort();

  const managed = new Set();
  const missing = [];
  for (const flag of sent) {
    if (advertised.has(flag)) { managed.add(flag); continue; }
    const long = longFor.get(flag);
    if (long) { managed.add(long); continue; }
    missing.push(flag);
  }

  const excludedSet = excluded instanceof Set ? excluded : new Set(excluded || []);
  const unknown = [...advertised]
    .filter(flag => flag.startsWith('--') && !managed.has(flag) && !excludedSet.has(flag))
    .sort();

  return { advertised: [...advertised].sort(), managed: [...managed].sort(), unknown, missing: missing.sort() };
}

module.exports = { managedFlags, definitionFlags, auditFlags, flagsIn, probeValue };
