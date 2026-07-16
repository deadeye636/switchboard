'use strict';

// Pure helpers for the Saved Variables insert-template mechanism.
//
// No Electron / fs dependencies live here on purpose: the substitution and shell-reference logic is the
// security-sensitive core (it decides how a secret's value reaches the terminal), so it must be unit-testable
// without spinning up the app. main.js requires this module and wires it to the `resolve-variable-insert` IPC
// handler.
//
// It lives under public/ and carries the dual-mode guard at the bottom so the RENDERER can require it too
// (via a plain <script> tag — the renderer has no `require`). That is not tidiness: the template editor's
// preview must compose with the exact same code the insert runs, or it drifts from what it claims to show —
// and a preview that disagrees with the resolver is worse than no preview at all.

// Default template for a variable that has none set. Secrets reference a temp file (so the plaintext never
// enters the prompt/transcript); non-secrets inline their raw value — this preserves the pre-template
// behaviour.
function defaultInsertTemplate(secret) {
  return secret ? '{ref}' : '{value}';
}

// The template a row actually resolves with. ONE definition, because two callers deciding this differently
// is a real bug class: a whitespace-only template must fall back to the default, not resolve to whitespace.
function effectiveTemplate(row) {
  const t = row && row.insertTemplate;
  return (t && String(t).trim()) || defaultInsertTemplate(!!(row && row.secret));
}

// A secret reached through {var:} may honour its own template EXCEPT {value}. Setting {value} on a secret
// consents to "inline my plaintext when I insert THIS variable" — decided at that row, with its Secret pill,
// behind the masked dialog. It does not consent to inlining the plaintext into some other variable's insert,
// months later, from a quick-pick row showing no pill at all — where it would land in shell history,
// scrollback, and the transcript that gets uploaded to the provider.
function forceRefForNested(tmpl, isSecret) {
  if (!isSecret) return String(tmpl ?? '');
  return String(tmpl ?? '').split('{value}').join('{ref}');
}

// Shell-appropriate substitution that reads a temp file's contents inline at exec time. Returns null for
// shells with no safe inline-read (cmd / unknown / WSL — a WSL shell can't cat a Windows path directly); the
// caller then falls back to clipboard copy.
//
// NOTE what this returns: a COMPLETE, already-quoted shell word. It must never be placed inside quotes —
// see scanRefSafety.
function shellRefFor(shellType, filePath) {
  const p = String(filePath ?? '');
  if (shellType === 'bash' || shellType === 'zsh' || shellType === 'sh') {
    // POSIX single-quote the path (escape embedded single quotes as '\'').
    return `"$(cat '${p.replace(/'/g, "'\\''")}')"`;
  }
  if (shellType === 'pwsh' || shellType === 'powershell') {
    // PowerShell single-quote the path (escape embedded single quotes as '').
    return `(Get-Content -Raw '${p.replace(/'/g, "''")}')`;
  }
  return null;
}

// The one token grammar. `var:` names may hold anything but braces; the name is trimmed at lookup so
// `{var: x }` finds `x`. Case-SENSITIVE on purpose — the ORDER BY LOWER(name) in the list queries will tempt
// someone into case-insensitive matching, and then `Server` and `server`, two legitimately distinct rows,
// become one ambiguous reference.
const TOKEN_SOURCE = '\\{(path|ref|value|var:[^{}]+)\\}';

// Which variables does this template reference? Pure, so the graph can be walked (and cycles found) before
// anything is decrypted or written.
function parseVarRefs(template) {
  const re = new RegExp(TOKEN_SOURCE, 'g');   // constructed per call — see compose()
  const out = [];
  let m;
  while ((m = re.exec(String(template ?? ''))) !== null) {
    if (m[1].startsWith('var:')) out.push(m[1].slice(4).trim());
  }
  return out;
}

// The template a node resolves with, once its position is known. The ROOT keeps its own template; every node
// reached THROUGH a reference has a secret's {value} forced to {ref} (see forceRefForNested).
function finalTemplateFor(node, isRoot) {
  const t = effectiveTemplate(node);
  return isRoot ? t : forceRefForNested(t, !!(node && node.secret));
}

// Walk the reference graph from a root, WITHOUT touching a value.
//
// This is why the graph phase can be pure: everything it needs — a name, the secret flag, the template — is
// in the rows the list query already returns, and that query deliberately does not select `value`. So cycles,
// the node count and every "does this need a temp file?" decision are settled before anything is decrypted.
//
//   nodesById  — id -> { id, name, secret, insertTemplate }; MUST contain the root, which may not be in the
//                applicable set (a root can belong to another project; the handler injects it).
//   nameIndex  — name -> id, already collapsed by the binding rule (project beats global, then oldest).
//
// Returns { order, missing } with `order` bottom-up (children before parents, each id once), or { cycle }
// naming the path. A reference to a name nobody has resolves to empty later — the missing-{value}
// convention — so it is reported, not fatal.
function resolveVarGraph(rootId, nodesById, nameIndex = {}) {
  const get = (id) => (nodesById instanceof Map ? nodesById.get(id) : nodesById[id]);
  const lookup = (name) => (nameIndex instanceof Map ? nameIndex.get(name) : nameIndex[name]);
  const order = [];
  const done = new Set();
  const visiting = [];
  const missing = [];

  function walk(id, isRoot) {
    if (done.has(id)) return null;
    if (visiting.includes(id)) return visiting.slice(visiting.indexOf(id)).concat(id);
    const node = get(id);
    if (!node) return null;
    visiting.push(id);
    for (const name of parseVarRefs(finalTemplateFor(node, isRoot))) {
      const childId = lookup(name);
      if (childId == null) { missing.push(name); continue; }
      const cycle = walk(childId, false);
      if (cycle) return cycle;
    }
    visiting.pop();
    done.add(id);
    order.push(id);          // children are already in — this is the bottom-up order
    return null;
  }

  const cycle = walk(rootId, true);
  if (cycle) return { cycle: cycle.map((id) => (get(id) || {}).name || id) };
  return { order, missing };
}

// Compose a template into its final text.
//
// SINGLE PASS, and that is the whole point. The old implementation chained split/join passes — {path}, then
// {ref}, then {value} — each one re-scanning the previous pass's output. That was harmless only because path
// and ref are system-generated. The moment a {var:} pass feeds USER-CONTROLLED text into the chain it turns
// into an injection: a referenced variable whose stored VALUE is the literal string `{value}` would have that
// token replaced by the PARENT's plaintext on the next pass — even when the parent's own template never said
// {value}. Likewise a value containing `{ref}` would pick up the parent's `$(cat …)` and read its temp file.
//
// Here every placeholder is resolved exactly once and its result is concatenated into the OUTPUT, never back
// into the scanned input. Whatever a resolved value contains is inert text.
//
// Concatenation, never String.replace(): `$&` / `$1` in a replacement string are interpreted as
// replacement-pattern syntax, which is why the original used split/join and why the `$` / `\` literal-ness
// tests exist. They guard this too.
//
// Returns { text, refOffsets } — refOffsets are the indices in `text` where a {ref} expansion begins.
// scanRefSafety needs them: whether a ref is safe is a property of the FINISHED string, not of the template.
function compose(template, values = {}) {
  // The regex is built here, per call, and never hoisted to module scope. `matchAll`/`exec` on a /g regex
  // carry `lastIndex` between uses: one innocent `TOKEN.test(tmpl)` elsewhere would leave it set, and the
  // next compose() would silently skip its first token and emit it as literal text.
  const re = new RegExp(TOKEN_SOURCE, 'g');
  const s = String(template ?? '');
  const v = values || {};
  const vars = v.vars || {};
  let out = '';
  let last = 0;
  const refOffsets = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index);
    const token = m[1];
    let resolved;
    if (token === 'path') resolved = v.path == null ? '' : String(v.path);
    else if (token === 'ref') {
      resolved = v.ref == null ? '' : String(v.ref);
      if (resolved) refOffsets.push(out.length);
    } else if (token === 'value') resolved = v.value == null ? '' : String(v.value);
    else {
      // {var:name} — the caller passes already-resolved, opaque child text. A name we were given nothing for
      // resolves to empty, matching the missing-{value} convention.
      const name = token.slice(4).trim();
      const child = vars[name];
      resolved = child == null ? '' : String(child);
      // A child's text may itself contain refs; their offsets shift by where the child lands.
      if (Array.isArray(v.varRefOffsets && v.varRefOffsets[name])) {
        for (const o of v.varRefOffsets[name]) refOffsets.push(out.length + o);
      }
    }
    out += resolved;
    last = m.index + m[0].length;
  }
  return { text: out + s.slice(last), refOffsets };
}

// The back-compatible shape: the composed text only. Every existing caller and test keeps working, against
// ONE implementation.
function substituteInsertTemplate(template, values = {}) {
  return compose(template, values).text;
}

// Is any ref sitting inside quotes in the FINISHED text?
//
// shellRefFor returns a complete, already-quoted shell word. Put it inside the user's own quotes and it dies:
// `mysql -p'{ref}'` composes to `-p'"$(cat '/tmp/x')"'`, which bash hands over as the LITERAL string
// -p"$(cat /tmp/x)" — wrong credential, and the secret's temp-file path now in history/scrollback/transcript.
//
// This has to run on the composed string rather than on the template, because the quote does not have to come
// from the template at all: a sibling `{var:user}` whose value is `root'` re-opens quoting around a ref that
// the template itself left perfectly bare. An apostrophe in a username is enough. No adversary required.
//
// Conservative by design: it flags a ref inside single OR double quotes, for every shell. POSIX double quotes
// happen to survive (empty-string concat plus expansion) — that is an accident, not a contract, and pwsh is
// fatal in both quote kinds because it needs $(…) rather than (…) inside a string. Telling someone to unquote
// is cheap; a silently wrong credential is not.
//
// Returns [{ offset, reason }] — empty means safe.
function scanRefSafety(text, refOffsets = []) {
  const s = String(text ?? '');
  const offsets = Array.isArray(refOffsets) ? refOffsets : [];
  if (!offsets.length) return [];

  // Quote state at every index: which quote char (if any) encloses it.
  const state = new Array(s.length + 1).fill(null);
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    state[i] = quote;
    const c = s[i];
    if (quote === null && (c === "'" || c === '"')) quote = c;
    else if (quote === c) quote = null;
  }
  state[s.length] = quote;

  const out = [];
  for (const o of offsets) {
    if (state[o]) out.push({ offset: o, reason: 'quoted', quote: state[o] });
  }
  // An unbalanced quote at the end means everything after it is quoted by accident — a ref anywhere in that
  // text is unreliable even if the scan above cleared it.
  if (quote !== null) out.push({ offset: s.length, reason: 'unbalanced', quote });
  return out;
}

// Collapse the applicable rows to ONE id per name — deterministically, because `{var:x}` must mean the same
// row today and tomorrow.
//
// Duplicate names are possible (the table has never constrained them) and this is deliberately NOT solved
// with a unique index: nothing in cross-referencing requires uniqueness, and a constraint would mean
// rewriting names in databases we cannot see. A rule costs nothing and breaks nobody's data.
//
//   1. project scope beats global — the same precedence the settings cascade uses, and the same set the
//      list query already returns;
//   2. within a scope, oldest wins: createdAt ASC, then id ASC. `createdAt` is a millisecond ISO string, so
//      ties are real; `id` is the tie-break that keeps this stable across runs. `updatedAt` would identify
//      "recently touched", not "the one you meant" — and it moves whenever either duplicate is edited.
//
// Names are matched case-SENSITIVELY: `Server` and `server` are two legitimate rows, and the `LOWER(name)`
// in the list query's ORDER BY must not be mistaken for a matching rule.
function buildNameIndex(rows = []) {
  const best = new Map();
  for (const r of rows) {
    if (!r || !r.name) continue;
    const cur = best.get(r.name);
    if (!cur || beatsForBinding(r, cur)) best.set(r.name, r);
  }
  const index = {};
  for (const [name, row] of best) index[name] = row.id;
  return index;
}

function beatsForBinding(a, b) {
  const aProject = a.scope === 'project';
  const bProject = b.scope === 'project';
  if (aProject !== bProject) return aProject;                    // project beats global
  const ac = String(a.createdAt || '');
  const bc = String(b.createdAt || '');
  if (ac !== bc) return ac < bc;                                 // oldest wins
  return String(a.id) < String(b.id);                            // stable tie-break
}

// How many variables one insert may pull in. A cycle guard stops infinite descent but bounds nothing else:
// a wide graph would materialize a temp file per secret and compose a command nobody meant to write. Twenty
// is far past any honest template and far below anything that could hurt.
const MAX_RESOLVED_NODES = 20;

const api = {
  defaultInsertTemplate,
  effectiveTemplate,
  forceRefForNested,
  finalTemplateFor,
  shellRefFor,
  parseVarRefs,
  resolveVarGraph,
  buildNameIndex,
  compose,
  substituteInsertTemplate,
  scanRefSafety,
  MAX_RESOLVED_NODES,
};

// Dual mode: `require()` in main, a global in the renderer (which has no require — plain <script> tags).
// Same pattern as terminal-context-menu.js.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.variableInsert = api;
