# 12 — Saved Variables: how a secret reaches a terminal

**Status:** as-built. Cross-references (`{var:}`), the composed-text ref scan, the two-phase resolver and the
template editor are implemented. Issues [#205] (cross-references), [#204] (the editor's room).
Known gaps at the end.

This is the design record for the part of Saved Variables that is not obvious: **the rules that decide
whether a secret's plaintext leaves the main process, and why each one is shaped the way it is.** The
user-facing feature list lives in the README; this is the "why is it like this".

---

## The gate

`resolve-variable-insert` (main.js) turns a variable into the exact text placed in a terminal. What it may
emit is decided entirely by that variable's **insert template**:

| Placeholder | Emits | Plaintext leaves main? |
|---|---|---|
| `{value}` | the raw value, inline | **yes** |
| `{path}` | the path of a 0600 temp file holding the value | no |
| `{ref}` | a shell expression that reads that file at exec time (`"$(cat …)"` / `(Get-Content -Raw …)`) | no |

Default: `secret ? '{ref}' : '{value}'`.

**The property:** a secret's plaintext leaves main **only when its template says `{value}`**. Otherwise the
terminal receives a shell expression, so the plaintext is not in shell history, not in scrollback, and not in
the CLI transcript.

That last one is why this matters more than it looks: **a Claude session's transcript is uploaded to the
provider.** A secret typed into a prompt is a secret sent to a third party.

**Threat model:** `saved_variables` is written only through the app's own dialog. There is no import, no
sync, no CLI writer, no MCP surface — **every value and template is user-authored, so there is no second
party.** None of the rules below defend against an attacker. They exist because the failure modes fire on
**ordinary content** — an apostrophe in a password is enough — and their effect is exactly the harm the gate
exists to prevent.

> **If a future feature ever imports, syncs or shares variables, this changes.** Name shadowing and the
> value-dependence below become genuine cross-party leaks, and cross-references must be re-gated.

---

## `{ref}` is a complete shell word — never quote it

`shellRefFor` returns an **already-quoted, self-contained word**. Put it inside quotes and it dies:

```
template   mysql -p'{ref}'
composed   mysql -p'"$(cat '/tmp/abc')"'
bash sees  argv[1] = -p"$(cat /tmp/abc)"     ← LITERAL
```

The credential is silently wrong **and the temp-file path is now in the transcript**. `{path}` is the
opposite: it is a path and it *must* usually be quoted (`-i '{path}'`). The two sit next to each other in the
preset dropdown, which is exactly how someone learns the wrong lesson.

**Ref safety is a property of the COMPOSED string, not of the template.** Two reasons, both found by review
rather than by reasoning:

1. **A name-based predicate is depth-1.** "Is the referenced variable a secret?" is defeated by one level of
   indirection: a **non-secret** wrapper whose template is `{var:the-secret}`. And `needsRef` never depended
   on `secret` anyway — a non-secret may carry a `{ref}` template.
2. **The quote need not come from the template.** A sibling `{var:user}` whose value ends in an apostrophe
   (`root'`) re-opens quoting around a ref the template left perfectly bare:

   ```
   mysql -u {var:user} -p{var:db-pass}     ← ref unquoted, the sanctioned form
   → argv: [-u] [root -p"$(cat /tmp/abc)"] ← the apostrophe swallowed the ref
   ```

So `compose()` records the byte offset of every ref it emits, and `scanRefSafety` runs **once over the
finished string**. Conservative on purpose: it flags a ref inside single **or** double quotes for every
shell. POSIX double quotes happen to survive; that is an accident, not a contract, and PowerShell is fatal in
both (it needs `$(…)`, not `(…)`, inside a string).

**Only a ref reached through `{var:}` is refused.** A quoted `{ref}` in the author's own template is just as
broken — but it may have been sitting there since v0.7.3, and hard-failing it would break an install for a
feature (`{var:}`) its owner never used. Cross-references are new ground, so refusing them breaks nobody.
The editor is where the author's own case gets told.

---

## A secret reached through `{var:}` never inlines plaintext

`{value}` on secret x consents to *"x inlines plaintext **when I insert x**"* — decided at x's row, with its
Secret pill, behind the masked dialog. `{var:x}` moves that plaintext into the insertion of a **different**
variable, which the quick-pick shows with **no pill**, months later, by someone who has forgotten x's
template.

**Rule:** a secret reached via `{var:}` honours its template **except `{value}`**, which is forced to `{ref}`
(`forceRefForNested`). Inserted directly, it still honours it.

The asymmetry is deliberate: insert x → plaintext; reference x → `$(cat …)`. It is defensible only together
with the quoting rule above — which is why that rule's enforcement is not optional.

A parent that transitively references a secret carries the Secret pill in the editor. The insert really does
materialize secret temp files; a UI saying "no secret involved" is what the rule exists to answer.

---

## Substitution is a single pass

`substituteInsertTemplate` used to chain `split/join` passes — `{path}`, then `{ref}`, then `{value}` — each
re-scanning the previous pass's output. Harmless while every substituted value was system-generated.
`{var:}` feeds a **stored value** into the same chain:

```
parent  = secret, template {ref}          → should be $(cat …)
parent template:  mysql -p{var:helper}
helper  = NON-secret, its stored VALUE is the literal string  {value}

after the {var:} pass  →  mysql -p{value}
after the {value} pass →  mysql -pS3CRET   ← the PARENT secret's plaintext
```

…although the parent's template never said `{value}`, because the handler passed `value` in unconditionally.

`compose()` walks the template **once** and concatenates each resolved token into the output, never back into
the scanned input. Resolved text is inert.

Two invariants that look like style and are not:

- **Concatenate, never `String.replace()`.** `$&`/`$1` in a replacement string are interpreted. That is why
  the original used split/join; the `$`/`\` literal-ness tests guard the tokenizer too.
- **Build the regex per call, never at module scope.** `matchAll`/`exec` on a `/g` regex carry `lastIndex`.
  One innocent `TOKEN.test(tmpl)` elsewhere and the next `compose()` silently skips its first token.
- **A node's `value` is passed only when its own final template contains `{value}`** — the mechanism above.

---

## Two phases

```
PHASE 1 — decide (no plaintext, no files)
  projectPath ← from the SESSION, never the caller
  nodes       ← listSavedVariables()          — carries name/secret/insertTemplate, NOT value
  graph       ← resolveVarGraph()             → cycle? → fail
  per node    : finalTemplateFor()            → needsRef / needsPath
  capability  : can this shell read a file inline?  → fail NOW, before any file exists
  node count > 20 → fail
  one sweep of old refs

PHASE 2 — materialize
  per node    : re-read the FULL row, decrypt, write a 0600 temp file, track it
  resolve bottom-up, memoized per id (a diamond writes ONE file)
  scanRefSafety on the finished text → a NESTED quoted ref → fail
  \n / \r / \x1b in the result → fail
  on ANY failure: unlink AND untrack every file this insert wrote
```

Phase 1 exists to preserve the property the single-variable handler always had: **never leave a stray secret
file behind**. A naive per-node loop writes files 1..k and then fails at k+1 — and the age sweep that would
collect them is opt-in and off by default.

**The list rows carry no value — that is what makes phase 1 honest, and it is a trap.** Using those same rows
in phase 2 silently yields an empty value: a referenced variable composes to nothing, and a referenced
*secret* writes an **empty temp file** whose ref then reads it. Phase 2 re-reads the full row. Unit tests
cannot see this (they never touch the DB); it took running the app.

**The shell family comes from the session**, recorded at spawn. It used to be an argument from the renderer —
so the one security-relevant question here ("can this shell read a file inline?") was something main was
*told*. It was also derived from the wrong setting: the project's CLI shell (`shellProfile`) answers for a
plain terminal that spawned with `terminalShellProfile`.

**Multi-line and control characters are refused.** A composed newline is typed as Enter and runs whatever
precedes it; an ESC byte reaches the PTY raw (the quick-pick sends resolved text through `sendInput` with no
bracketed-paste guard). Multi-line content is what `{path}` is for. *This means composing a multi-line ssh
key inline is not supported — it never was safe.*

**Fallback on a shell with no inline read** (cmd/WSL/unknown): the **root's** own `{ref}` still falls back to
a clipboard copy — the user asked for that variable, so handing them its value to paste is the consent they
already gave. A **nested** ref hard-fails: they asked for the parent as one string, and a partial composition
on the clipboard is both a leak and garbage.

---

## Names bind by rule, not by a constraint

`{var:x}` must mean the same row today and tomorrow. Duplicate names are possible — the table has never
constrained them.

1. **project scope beats global** (the settings cascade's precedence);
2. within a scope, **oldest wins**: `createdAt ASC, id ASC`. `createdAt` is a millisecond string, so ties are
   real. `updatedAt` would identify "recently touched", not "the one you meant", and it moves whenever either
   duplicate is edited.

Matching is **case-sensitive**: `Server` and `server` are two legitimate rows. (The `LOWER(name)` in the list
queries' ORDER BY is a sort, not a matching rule.)

**Deliberately NOT a `UNIQUE` index.** Nothing in cross-referencing requires uniqueness; a constraint would
mean **renaming rows in databases we cannot see** (the feature shipped in v0.7.3–v0.7.6, so installed users
hold real data), and adding one to a populated table risks a migration that throws at startup — which, given
the runner bumps `db_version` only after the whole loop, would re-throw on every launch. A rule costs nothing
and breaks nobody. See "Known gaps".

**Grammar:** `\{var:([^{}]+)\}`. A name may not contain `{`/`}` — **checked only when the name is new or
changed**. Rows predating this still work for everything except being referenced; blocking their save would
lock someone out of editing their own value, arriving while they rotate a credential.

**Rename/delete of a referenced variable warns**, naming the templates that would break. A reference nobody
resolves is empty, so the command still runs — with an empty value where the credential was. The scan uses
`parseVarRefs`, not a SQL `LIKE`: `'%{var:' || name || '}%'` turns a name containing `%` or `_` into a
wildcard that over-matches, and the parser agrees with the resolver by construction because it *is* the
resolver's parser.

---

## The editor

`src/shared/variable-insert.js` lives under `public/` behind a **UMD wrapper** so main requires it and the
renderer loads it as a plain `<script>`. Not tidiness: the preview must compose with the **same functions**
the insert runs, or it drifts from what it claims to show — and a preview that disagrees with the resolver is
worse than none.

*(The wrapper is also load-bearing: a classic script's top-level `const api` collides with `window.api` — the
contextBridge surface is a non-configurable global — and the file dies with a SyntaxError before its first
line. The only symptom is a preview that renders nothing.)*

The preview needs **no IPC and no plaintext**: the admin list carries `secret` and `insertTemplate` but never
values, so a referenced variable renders as a placeholder and every ref against a synthetic `<secret-file>`
path. **No temp file is ever written from a dialog** — a preview IPC that reuses the real resolver "for
accuracy" is exactly how that would happen. Don't.

The quoting rule is **not taught, it is enforced visibly**: the preview runs `scanRefSafety` — the same check
the insert fails on — and renders the result as a sentence with the rule inside it. Nobody recognises
`-p'"$(cat …)"'` as wrong; it looks impressively shell-like, which is worse than opaque. Rules users must not
violate belong to machines, not to memory.

**The empty state is the centre of gravity.** Most users should never type a template: the placeholder states
the current default in words and flips with the Secret toggle, and the preview shows what the default
produces. They never meet the language.

**The mini-language stays.** A mode picker ("raw value / file path / shell read") covers the two common cases
with no language at all, but collapses the moment a path needs surrounding text (`-i `), and a composed
command is irreducibly textual. The language is right; what was missing was an interpreter.

**Logging: the resolver's output must never be logged, at any level.** A well-meaning `log.debug` of the
composed string would inline `{value}` plaintext into `main.log`.

---

## Known gaps

- **The editor's scan uses placeholder child values**, so the value-borne quote (the `root'` case) is only
  catchable at insert time. The preview does not claim completeness.
- **Unique names + a de-dup migration** were cut deliberately (see above). If it is ever wanted, the window
  is *before* `{var:}` is widely used: nothing could reference a name until this shipped, so de-duplicating
  breaks no template — and that argument expires as templates accumulate. It must not live in the migrations
  array (a swallowed error there is permanent and silent, and the save path's duplicate prevention would BE
  the index); it belongs in the idempotent DDL block with an existence guard, renaming collisions rather than
  deleting them.
- **PowerShell's ref is not bash's.** `(Get-Content -Raw …)` preserves a trailing newline where `$(cat …)`
  strips it, so the same secret composes to different values per shell. Untested against a live pwsh session.
- **The clipboard fallback puts a secret's plaintext on the clipboard** (pre-existing, and consented — the
  user asked for that variable). On Windows, clipboard history (Win+V) persists and cloud-syncs it.
- **The resolver's guards are verified live, not by unit test** — the handler lives in `src/main.js`, which
  cannot load under `node --test`. The pure core (`src/shared/variable-insert.js`) is thoroughly covered;
  the unwind, the node cap and the multi-line refusal are not.
