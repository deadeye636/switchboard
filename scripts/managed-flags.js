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
 * `buildLaunch` is taken at once. `configFields` is not the whole story, and the audit must not assume it
 * is: Claude's `buildLaunch` honoured an undeclared `appendSystemPrompt` for months, and a set built from
 * the declared fields alone would have called that flag unmanaged. What buildLaunch READS is the question,
 * not what the settings page shows.
 *
 * The gap between the two answers is itself a defect, not just a coverage detail — an option that reaches
 * the argv and no field declares is a launch option nothing offers (#562). `declaredFlags` below is the
 * other half, so a test can subtract one set from the other and name what is left.
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
function launchVariants(backend, { undeclaredOptions = true } = {}) {
  const variants = [
    { ...CTX, options: {} },
    { ...CTX, resume: true, options: {} },
    { ...CTX, forkFrom: 'PARENT-SESSION-ID', options: {} },
  ];
  if (undeclaredOptions) {
    variants.push({ ...CTX, options: EVERY_OPTION }, { ...CTX, resume: true, options: EVERY_OPTION });
  }
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
function managedFlags(backend, opts) {
  const flags = new Set(bindingFlags(backend));
  for (const variant of launchVariants(backend, opts)) {
    let launch;
    try { launch = backend.buildLaunch(variant); } catch { continue; }
    for (const flag of flagsIn(launch && launch.args)) flags.add(flag);
  }
  return [...flags].sort();
}

/**
 * The same derivation with the undeclared-option probe left out: the flags the launch SHAPES (new, resume,
 * fork), the live-binding hook and the DECLARED `configFields` entries can produce between them — in other
 * words, everything a reader of the settings screen and the descriptor could account for.
 *
 * `managedFlags(backend)` minus this is a flag `buildLaunch` emits for an option key nothing declares
 * (#562). The two sets are built the same way on purpose: the launch shapes and the binding file appear in
 * both, so they cancel and only the undeclared option survives the subtraction.
 */
const declaredFlags = (backend) => managedFlags(backend, { undeclaredOptions: false });

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
 * The options section cut into one block per DEFINITION line: the flags that line defines, plus every line
 * that belongs to it (its own, then each following line until the next definition).
 *
 * `definitionFlags` answers what an option is CALLED, which is all the flag audit needs. A question about
 * what an option ACCEPTS needs the description too, because that is where a CLI prints its enum — and it
 * prints it on the definition line for one CLI and four lines below it for another.
 */
function optionBlocks(lines, opts) {
  const blocks = [];
  for (const raw of lines || []) {
    const plain = String(raw == null ? '' : raw).replace(/\x1b\[[0-9;]*m/g, '');
    const flags = definitionFlags(plain, opts);
    if (flags.length) { blocks.push({ flags, lines: [plain] }); continue; }
    if (blocks.length) blocks[blocks.length - 1].lines.push(plain);
  }
  return blocks;
}

/**
 * The values a CLI DECLARES an option accepts, or null when it declares none.
 *
 * Three spellings, and all three are the argument parser's own declaration rather than a sentence
 * somebody wrote:
 *   clap, inline   `[possible values: read-only, workspace-write, danger-full-access]`
 *   clap, block    `Possible values:` and then one `- <value>: <description>` line each
 *   commander      `(choices: "acceptEdits", "auto", "plan")`, wrapped over as many lines as it needs
 *
 * Everything else is PROSE — "Set thinking level: off, minimal, low…", "(lmstudio or ollama)" — and prose
 * is deliberately not parsed. A list scraped out of a description is a guess about a sentence, and a guess
 * that goes wrong here either invents a dead value or hides a real one. A field whose CLI only writes prose
 * is excluded by name in that backend's help check, with its reason, the way an unaudited flag is.
 *
 * `null`, not an empty set: "declares no enum" and "declares an empty enum" are different answers, and
 * only the first one happens.
 */
function possibleValues(blockLines) {
  const text = (blockLines || []).join('\n');

  const inline = /\[possible values:\s*([^\]]+)\]/i.exec(text);
  if (inline) {
    const values = inline[1].split(',').map(v => v.trim()).filter(Boolean);
    if (values.length) return new Set(values);
  }

  const commander = /\(choices:\s*([^)]+)\)/i.exec(text);
  if (commander) {
    // Commander keeps going after the list inside the SAME parenthesis — the installed Claude CLI prints
    // `(choices: "host", "none", default: "host")` on one option and `preset: …` on another — so the list
    // ends at the first `word:` that follows a comma, whatever that word is. Cutting at the one keyword
    // somebody had measured left the second one producing a value spelled `preset: "true`, which is the
    // same defect one CLI release later. Splitting the whole parenthetical on commas was the original.
    const values = commander[1].split(/,\s*[A-Za-z][A-Za-z-]*:\s/)[0]
      .split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    if (values.length) return new Set(values);
  }

  const listed = new Set();
  let inBlock = false;
  for (const line of blockLines || []) {
    if (/^\s*possible values:\s*$/i.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    const m = /^\s*-\s+([A-Za-z0-9][A-Za-z0-9._-]*):/.exec(line);
    if (m) listed.add(m[1]);
    // Anything else inside the block is a wrapped description line, belonging to the entry above it.
  }
  return listed.size ? listed : null;
}

/**
 * Which flag each SELECT choice actually puts on the command line, and with what value — DERIVED by
 * building the launch with that one choice set, never written down (#548's rule applied to values).
 *
 * A choice that produces no value token is left out, and that is the interesting half: Claude's
 * `dangerously-skip` becomes a bare `--dangerously-skip-permissions`, Pi's `approve` becomes `--approve`,
 * and an empty choice means "say nothing at all". None of those is a value the CLI has to know, and the
 * flags they DO emit are audited by `auditFlags` already. So the audit asks only about the choices that
 * reach the argv as the value of a flag — which is exactly where a retired enum kills a session.
 *
 * Two things it does NOT do quietly, because the whole point of this audit is to know what it covers:
 *
 * - **Every launch SHAPE is built**, not only a new session. `launchVariants` above makes the same point
 *   about flags: new, resume and fork are three mutually exclusive branches, and a choice that only
 *   reaches the argv on one of them would otherwise be audited in whichever branch this happened to pick.
 * - **A choice that changes the argv without appearing in it is REPORTED** (`flag: null`). That is a
 *   choice mapped to some other token — `'plan' -> --mode planMode` — and it is exactly the shape that
 *   would slip through as "nothing to check here" while the value the CLI sees is never compared to
 *   anything. No backend does it today, which is the reason to write the branch now rather than after one
 *   does.
 */
function selectChoiceArgs(backend) {
  const isFlag = (token) => /^--?[a-z0-9][a-z0-9-]*$/i.test(String(token));
  const shapes = [{}, { resume: true }, { forkFrom: 'PARENT-SESSION-ID' }];
  const build = (shape, options) => {
    try { return ((backend.buildLaunch({ ...CTX, ...shape, options }) || {}).args || []).map(String); }
    catch { return null; }
  };

  const seen = new Set();
  const out = [];
  for (const field of (backend && backend.configFields) || []) {
    if (!field || field.type !== 'select' || field.appliesAt === 'spawn') continue;
    const base = field.requires ? { [field.requires]: true } : {};
    for (const raw of field.choices || []) {
      const choice = String(raw == null ? '' : raw);
      if (!choice) continue;
      for (const shape of shapes) {
        const args = build(shape, { ...base, [field.id]: raw });
        const bare = build(shape, base);
        if (!args || !bare) continue;

        // What this ONE option added to the command line, as a multiset difference against the same launch
        // built without it. Everything below reads only those positions: a scan of the whole argv for a
        // token equal to the choice takes the first match, and a `buildLaunch` that puts the same literal
        // somewhere else — a default it always sends, a session id that happens to collide — would then
        // attribute the choice to the wrong flag and report a dead value against an enum it never touches.
        // No backend does that today; the point of a guard is that its verdict can be trusted without
        // checking whether one does.
        const rest = [...bare];
        const addedAt = args.map(a => { const at = rest.indexOf(a); if (at < 0) return true; rest.splice(at, 1); return false; });
        const added = args.filter((_, i) => addedAt[i]);
        if (!added.length) continue;                       // the choice says nothing at all

        let flag = null;
        for (let i = 0; i < args.length && !flag; i++) {
          if (!addedAt[i]) continue;
          if (args[i] === choice && i > 0 && isFlag(args[i - 1])) flag = args[i - 1];
          const joined = /^(--?[a-z0-9][a-z0-9-]*)=(.*)$/i.exec(args[i]);
          if (joined && joined[2] === choice) flag = joined[1];
        }

        // A choice that became a flag of its own carries no value for the CLI to enumerate, and the flag
        // it emits is `auditFlags`' business. Anything else that changed the argv without appearing in it
        // is reported (`flag: null`) rather than passed over.
        if (!flag && added.every(isFlag)) continue;

        const key = `${field.id} | ${choice} | ${flag || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ field: field.id, choice, flag });
      }
    }
  }
  return out;
}

/**
 * The choices audit (#617). `auditFlags` asks whether an option still EXISTS; this asks whether the values
 * we offer for it are still values it takes. Codex dropped `untrusted` and `on-failure` from
 * `--ask-for-approval` and the flag audit stayed green through it, because the flag itself never moved —
 * while every session launched on either value died at spawn with exit code 2.
 *
 * Three answers, and the second and third are what keep it honest:
 *   dead          — a choice the CLI no longer lists. The failure this exists for.
 *   unenumerated  — the CLI declares no machine-readable values for that flag and nothing excludes the
 *                   field, so the audit would be claiming a coverage it does not have. It says so once,
 *                   and the backend's own script records the decision with its reason.
 *   stale         — an exclusion whose field is gone, or whose CLI has started declaring its values after
 *                   all. An exclusion list that only ever grows is a place to silence a finding.
 *
 * A flag the help does not define at all is skipped: that is `auditFlags`' `missing`, and reporting one
 * defect twice in two vocabularies helps nobody.
 */
function auditChoices({ backend, blocks, excluded }) {
  const excludedSet = excluded instanceof Set ? excluded : new Set(excluded || []);
  const known = new Set();
  const longFor = new Map();
  const valuesFor = new Map();
  for (const block of blocks || []) {
    const longs = block.flags.filter(f => f.startsWith('--'));
    for (const flag of block.flags) {
      known.add(flag);
      if (!flag.startsWith('--') && longs.length) longFor.set(flag, longs[0]);
    }
    const key = longs[0] || block.flags[0];
    const values = possibleValues(block.lines);
    if (key && values) valuesFor.set(key, values);
  }

  const longOf = (flag) => (flag.startsWith('--') ? flag : (longFor.get(flag) || flag));

  const sends = new Set();          // fields whose choices reach the argv at all — the stale test's subject
  const revived = [];
  const dead = [];
  const checked = new Map();
  const unenumerated = new Map();
  const excludedFields = new Map();
  for (const { field, choice, flag } of selectChoiceArgs(backend)) {
    sends.add(field);
    if (flag && !known.has(flag)) continue;   // the flag itself is gone — auditFlags reports that, once
    if (excludedSet.has(field)) { excludedFields.set(field, flag && longOf(flag)); continue; }
    if (!flag) {
      unenumerated.set(field, { flag: null, why: 'its choices change the argv without appearing in it, so nothing can be compared' });
      continue;
    }
    const long = longOf(flag);
    const values = valuesFor.get(long);
    if (!values) { unenumerated.set(field, { flag: long, why: `${long} declares no possible values` }); continue; }
    checked.set(field, long);
    if (!values.has(choice)) dead.push({ field, choice, flag: long, values: [...values].sort() });

    // A retired value the CLI has taken BACK. `retiredChoices` is the one declaration here that can only
    // grow — a rewrite that keeps moving a value the CLI accepts again is a setting the user cannot choose
    // and nothing would say so. The exclusion lists are checked for staleness in both directions; this is
    // the same property for the descriptor's own list.
    const retired = (backend.configFields || []).find(f => f.id === field);
    for (const gone of Object.keys((retired && retired.retiredChoices) || {})) {
      if (values.has(gone) && !revived.some(r => r.field === field && r.choice === gone)) {
        revived.push({ field, choice: gone, flag: long });
      }
    }
  }
  for (const field of unenumerated.keys()) checked.delete(field);   // one field, one answer

  // A stale exclusion, both ways round: the field sends nothing at all any more (it is gone, or it stopped
  // being a select), or the CLI has started declaring the values the exclusion says it does not.
  //
  // Asked against `sends` rather than against what survived the loop, deliberately. An excluded field whose
  // FLAG the CLI has dropped is not a stale exclusion — it is `auditFlags`' `missing`, and answering it here
  // reported the wrong defect in the wrong vocabulary and hid the right one behind an earlier exit.
  const stale = [];
  for (const field of excludedSet) {
    if (sends.has(field)) continue;
    stale.push({ field, why: 'no select choice of this backend reaches the command line as a value' });
  }
  for (const [field, long] of excludedFields) {
    if (long && valuesFor.get(long)) stale.push({ field, why: `${long} declares its values now — drop the exclusion and audit it` });
  }
  for (const { field, choice, flag } of revived) {
    stale.push({ field, why: `${flag} takes "${choice}" again — drop it from this field's retiredChoices and offer it` });
  }

  return {
    dead,
    unenumerated: [...unenumerated].map(([field, entry]) => ({ field, ...entry })),
    stale,
    checked: [...checked].map(([field, flag]) => ({ field, flag })),
    excluded: [...excludedFields.keys()].sort(),
  };
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

module.exports = {
  managedFlags, declaredFlags, definitionFlags, auditFlags, flagsIn, probeValue,
  optionBlocks, possibleValues, selectChoiceArgs, auditChoices,
};
