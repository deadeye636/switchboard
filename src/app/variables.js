// Saved variables (spec 12) and the materialization of their secrets.
//
// Two jobs that cannot be separated: the CRUD for named, reusable values, and turning one into the exact
// text that reaches a terminal — which for a secret means a 0600 temp file plus a shell substitution that
// reads it at exec time, never the plaintext itself.
//
// THE TRUST BOUNDARIES, all of which live in this file on purpose:
//  - A secret's plaintext must NEVER be typed into the terminal input. It would land in shell history, in
//    the scrollback and in the Claude transcript. {ref} is what avoids that; {value} is the deliberate,
//    documented exception.
//  - The shell family is taken from the SESSION, not from the caller. "Can this shell read a temp file
//    inline?" is the one security-relevant decision here, and main must KNOW it rather than be told.
//  - Ref safety is a property of the finished string, so it can only be checked after composition — hence
//    the unwind that deletes whatever the insert already wrote.
//  - Every failure path unlinks the temp files this insert created. A composed insert can write several
//    and then fail; the age sweep is opt-in and off by default, so nothing else would collect them.
//
// safeStorage, userData and the DB all come in through ctx rather than being required here — which keeps
// the module Electron-free and therefore loadable in `node --test`. That is what lets the encryption
// round-trip and the secret-ref lifecycle be tested at all: main.js needs Electron, so nothing could ever
// require it, and a source-text guard can find the line that says 0600 but not prove the mode is applied.
// (For the DB there is a second reason: db.js resolves DATA_DIR at module load, so a top-level require
// here would run before main.js sets it — see main.js:81-85 and test/main-modules-no-db.test.js.)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Never hand a thrown message to the renderer: an fs failure names the secret-ref file it was writing,
// and a store failure names the database (#457). The detail goes to the log instead.
const { readableError } = require('./readable-error');
// Pure insert-template helpers (no Electron deps — unit-tested separately).
// Lives under shared/ so the renderer can load it as a plain <script> too: the template editor's preview has
// to compose with the SAME code the insert runs, or it drifts from what it claims to show.
const {
  shellRefFor, shellQuotePath, sanitizeClipboardText, compose, parseVarRefs, finalTemplateFor,
  effectiveTemplate, resolveVarGraph, buildNameIndex, scanRefSafety, MAX_RESOLVED_NODES,
} = require('../shared/variable-insert');

let ctx = null;

// Track a materialized secret-ref temp file, optionally scoped to the session
// that inserted it (so it can be wiped when that session stops).
const secretRefFiles = new Set();
const secretRefBySession = new Map(); // sessionId -> Set<path>

/**
 * @param {object} context
 * @param {Map} context.activeSessions
 * @param {(key: string) => any} context.getSetting
 * @param {() => string} context.getSecretRefDir  where the 0600 temp files go. It hangs off userData,
 *   which a dev build separates from the installed app's (#216) — so this is resolved, not captured.
 * @param {object} context.safeStorage  Electron's; injected so this module needs no electron require.
 * @param {object} context.db  the saved-variable queries: list/listAll/get/save/delete/touch.
 * @param {object} context.log
 * @param {() => ({kind: string, path?: string, text?: string})} [context.clipboardInsert]  what the system
 *   clipboard holds, for a template naming {clipboard} (#491). Injected like everything else Electron owns,
 *   so this module stays loadable in `node --test`; absent means the token resolves to empty.
 */
function init(context) {
  ctx = context;
}

/** Every handler in this file answers a failure the same way: worded for the reader, detailed in the log. */
const failed = (err, sentence) => ({ ok: false, error: readableError(err, sentence, ctx && ctx.log) });

// --- CRUD ----------------------------------------------------------------------
// Named, reusable values shown in the terminal Saved Variables panel. Secret
// values are encrypted at-rest via Electron safeStorage; if the OS keychain is
// unavailable we fall back to plain storage (with a logged warning) rather than
// crash so the feature still works in headless/dev environments.
function normalizeSavedVariableTags(tags) {
  const raw = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    const tag = String(item || '').trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag.slice(0, 40));
    if (normalized.length >= 20) break;
  }
  return normalized;
}

function encryptSavedVariableValue(value, secret) {
  const stringValue = String(value ?? '');
  if (!secret) {
    return { value: stringValue, valueEncoding: 'plain' };
  }
  if (!ctx.safeStorage.isEncryptionAvailable()) {
    ctx.log.warn('[saved-variables] safeStorage unavailable — storing secret value as plain text');
    return { value: stringValue, valueEncoding: 'plain' };
  }
  return {
    value: ctx.safeStorage.encryptString(stringValue).toString('base64'),
    valueEncoding: 'safe-storage',
  };
}

function decryptSavedVariableValue(row) {
  if (!row) return '';
  if (row.valueEncoding === 'safe-storage') {
    if (!ctx.safeStorage.isEncryptionAvailable()) {
      throw new Error('System secret storage is unavailable');
    }
    return ctx.safeStorage.decryptString(Buffer.from(row.value || '', 'base64'));
  }
  return String(row.value ?? '');
}

function serializeSavedVariable(row, includeValue = false) {
  if (!row) return null;
  const serialized = {
    id: row.id,
    name: row.name,
    secret: !!row.secret,
    scope: row.scope || 'global',
    projectPath: row.projectPath || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    insertTemplate: row.insertTemplate || '',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    lastUsedAt: row.lastUsedAt || null,
  };
  if (includeValue) serialized.value = decryptSavedVariableValue(row);
  return serialized;
}

// --- Secret variable materialization (temp file + shell reference) -------------
// A secret's plaintext must NEVER be typed into the terminal input/prompt (it
// would land in shell history, scrollback, the Claude transcript, …). Instead we
// write the decrypted value to a 0600 temp file under userData/secret-refs and
// hand back a shell substitution that reads it at exec time. Files are swept by
// TTL on each create and wiped on quit.
function trackSecretRef(filePath, sessionId) {
  secretRefFiles.add(filePath);
  if (!sessionId) return;
  let s = secretRefBySession.get(sessionId);
  if (!s) { s = new Set(); secretRefBySession.set(sessionId, s); }
  s.add(filePath);
}

// Undo a track + delete the file. A composed insert can write several temp files and then fail — a nested
// ref on a shell that cannot read one, a quoted ref, a control character in the result — and it must not leave the
// secrets it already wrote lying around. The age sweep is opt-in and off by default, so nothing else would
// collect them until the session ends. Best-effort: an unlink that fails still gets untracked, since the
// quit-time directory sweep is the backstop.
function untrackSecretRef(filePath, sessionId) {
  try { fs.unlinkSync(filePath); } catch {}
  secretRefFiles.delete(filePath);
  const s = sessionId && secretRefBySession.get(sessionId);
  if (s) { s.delete(filePath); if (!s.size) secretRefBySession.delete(sessionId); }
}

// Delete a session's secret-ref temp files (called on its PTY exit when the
// cleanup-on-session-stop setting is on). Best-effort.
function cleanupSecretRefsForSession(sessionId) {
  const s = secretRefBySession.get(sessionId);
  if (!s) return;
  for (const p of s) { try { fs.unlinkSync(p); } catch {} secretRefFiles.delete(p); }
  secretRefBySession.delete(sessionId);
}

// Delete secret-ref temp files older than maxAgeMs (best-effort, tolerant).
// Opt-in: a missing/<=0 maxAgeMs is a no-op (age-sweep off).
function sweepSecretRefs(maxAgeMs) {
  if (!maxAgeMs || maxAgeMs <= 0) return;
  const dir = ctx.getSecretRefDir();
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.unlinkSync(p);
        secretRefFiles.delete(p);
      }
    } catch {}
  }
}

// Wipe every secret-ref temp file (tracked + any strays) — called on quit.
function cleanupSecretRefs() {
  for (const p of secretRefFiles) { try { fs.unlinkSync(p); } catch {} }
  secretRefFiles.clear();
  try {
    const dir = ctx.getSecretRefDir();
    for (const name of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
    }
  } catch {}
}

/**
 * Resolve a variable's insert-template into the exact text to place in the
 * terminal. Supersedes the raw-value / materialize-secret-ref paths: it applies
 * the variable's insertTemplate (or the secret/non-secret default), materializing
 * a 0600 temp file only when the template references it via {path}/{ref}.
 *   - {value}  → raw plaintext (leaves main only for non-secret defaults or an
 *                explicit {value} template — a deliberate, documented choice).
 *   - {path}   → path of a 0600 temp file holding the decrypted value.
 *   - {ref}    → shell-native inline read of that file; if the shell can't do it
 *                (cmd/unknown/WSL) we return { fallback:'copy', value } instead.
 * The shell family is taken from the SESSION, not from the caller. It used to be a renderer argument, which
 * made the one security-relevant decision here — "can this shell read a temp file inline?" — something main
 * was told rather than something it knew. It was also derived from the wrong setting: the renderer asked for
 * the PROJECT's CLI shell (`shellProfile`), while a plain terminal spawns with `terminalShellProfile`. Set
 * the two differently and main built a pwsh read for a bash session — which emits literal text and leaves the
 * secret's temp-file path in the terminal, and so in the transcript.
 * A template may also reference OTHER variables via {var:<name>} (#205), which is why this runs in two
 * phases. PHASE 1 decides everything using only the list rows — which carry the name, the secret flag and the
 * template, and deliberately not the value — so cycles, the node count and every "does this need a temp file
 * and can this shell read one?" question are settled while no plaintext has been decrypted and no file
 * exists. PHASE 2 then materializes, and any failure there unlinks whatever this insert already wrote.
 * Splitting it is what preserves the old handler's property: never leave a stray secret file behind.
 */
// The clipboard as ONE piece of text a terminal can be handed (#491).
//
// The ladder itself is `app/clipboard-insert.js` — file, then bitmap, then text. What is decided here is
// what each answer has to survive: a path becomes one quoted shell word, the way the paste route quotes
// every path it inserts; text is cleaned of everything a terminal would read as a command, because the
// composed insert is refused later if an ESC byte is still in it, and "insert my clipboard" must not fail
// on what happened to be copied.
//
// A clipboard this app cannot read at all resolves to empty — the missing-{value} convention — rather than
// failing the insert: a template usually names {clipboard} beside tokens that do have an answer.
function clipboardInsertValue(shellType) {
  if (!ctx.clipboardInsert) return '';
  let read = null;
  try { read = ctx.clipboardInsert(); } catch (err) {
    ctx.log.warn(`[variables] clipboard unreadable: ${err.message}`);
    return '';
  }
  if (!read) return '';
  if (read.kind === 'file' || read.kind === 'image') return shellQuotePath(shellType, read.path);
  return sanitizeClipboardText(read.text);
}

function resolveVariableInsert(id, sessionId) {
  const written = [];   // files THIS insert created — unwound on any failure below
  try {
    const session = ctx.activeSessions.get(sessionId);
    if (!session) return { ok: false, error: 'No running session for this insert' };
    const shellType = session.shellType || 'unknown';
    const root = ctx.db.getSavedVariable(id);
    if (!root) return { ok: false, error: 'Variable not found' };

    // ---- PHASE 1: decide (no plaintext, no files) ----
    // The applicable set for THIS session's project: globals ∪ that project's variables. The root is injected
    // because it need not be in that set — a variable scoped to another project can still be inserted here,
    // and its refs then resolve against the set the user is actually working in.
    const rows = ctx.db.listSavedVariables(session.projectPath || null) || [];
    const nodesById = new Map(rows.map((r) => [r.id, r]));
    nodesById.set(root.id, root);
    const nameIndex = buildNameIndex(rows);

    // Where THIS session's project keeps handoffs and plans, for a template naming one ({handoffDir} and
    // friends). Resolved once for the whole insert and handed to every node: a referenced variable that
    // names the directory must get the same answer the root does, or one insert describes two projects.
    const conventionDirs = ctx.conventionDirs ? ctx.conventionDirs(session.projectPath || null) : null;

    const graph = resolveVarGraph(root.id, nodesById, nameIndex);
    if (graph.cycle) {
      return { ok: false, error: `Variables reference each other in a loop: ${graph.cycle.join(' → ')}` };
    }
    if (graph.order.length > MAX_RESOLVED_NODES) {
      return { ok: false, error: `"${root.name}" pulls in ${graph.order.length} variables (limit ${MAX_RESOLVED_NODES})` };
    }

    // Per node: the template it will actually resolve with, and what that needs. Computed ONCE here and
    // reused in phase 2 — deciding it twice is how the capability check and the materialization end up
    // talking about different templates.
    const plan = graph.order.map((nodeId) => {
      const node = nodesById.get(nodeId);
      const tmpl = finalTemplateFor(node, nodeId === root.id);
      return {
        nodeId, node, tmpl,
        needsRef: tmpl.includes('{ref}'),
        needsPath: tmpl.includes('{path}'),
        // A secret's template does not get the clipboard (#491). Its insert is the one place the app
        // promises careful handling of what it composes, and a clipboard usually holds someone's last
        // password — pulling that into a secret's line puts it in the prompt, the scrollback and the
        // transcript, in the surface built to keep exactly that out of them.
        needsClipboard: tmpl.includes('{clipboard}') && !(node && node.secret),
      };
    });

    // A {ref} on a shell with no inline read cannot be inserted. For the ROOT alone this stays the old
    // clipboard fallback: the user asked for this variable, so handing them its value to paste is the
    // consent they already gave. A NESTED ref must not do that — they asked for the parent as one string,
    // and a partial composition on the clipboard is both a leak and garbage.
    if (shellRefFor(shellType, '') === null) {
      const nestedRef = plan.find((p) => p.needsRef && p.nodeId !== root.id);
      if (nestedRef) {
        return { ok: false, error: `"${nestedRef.node.name}" needs a shell that can read a file inline; this session's shell (${shellType}) cannot` };
      }
      const rootRef = plan.find((p) => p.needsRef && p.nodeId === root.id);
      if (rootRef) return { ok: false, fallback: 'copy', value: decryptSavedVariableValue(root) };
    }

    // ---- PHASE 2: materialize ----
    // What is on the clipboard, read ONCE for the whole insert and only when a template asks — the same
    // rule the convention directories follow. Reading it per node would let two nodes of one insert
    // describe two different clipboards, and reading it unasked would snapshot a bitmap to disk for a
    // template that never mentions it.
    const clipboardValue = plan.some((p) => p.needsClipboard)
      ? clipboardInsertValue(shellType)
      : null;

    // One sweep for the whole insert, not one per node.
    if (plan.some((p) => p.needsRef || p.needsPath)) {
      fs.mkdirSync(ctx.getSecretRefDir(), { recursive: true });
      sweepSecretRefs((Number(ctx.getSetting('global')?.secretRefSweepMinutes) || 0) * 60000);
    }

    // Resolve bottom-up (children first — that is what graph.order is), memoized per id so a diamond
    // A→x, A→y→x writes x's temp file once and composes its text once.
    const textById = new Map();
    const refOffsetsById = new Map();
    for (const p of plan) {
      // Re-read the FULL row here. Phase 1's nodes come from listSavedVariables, which deliberately does not
      // select `value` — that is what lets the graph walk decide everything without touching plaintext. Using
      // those same rows to materialize silently yields an empty value: a referenced variable composes to
      // nothing, and a referenced SECRET writes an empty temp file its ref then reads.
      const full = p.nodeId === root.id ? root : (ctx.db.getSavedVariable(p.nodeId) || p.node);
      const value = decryptSavedVariableValue(full);
      let filePath = null;
      if (p.needsRef || p.needsPath) {
        filePath = path.join(ctx.getSecretRefDir(), crypto.randomUUID());
        fs.writeFileSync(filePath, value, { mode: 0o600 });
        trackSecretRef(filePath, sessionId);
        written.push(filePath);
      }
      // A node's `value` is passed ONLY when its own template asks for it. The old handler passed it
      // unconditionally, which is exactly what let a child's stored text reach a parent's plaintext.
      const vars = {};
      const varRefOffsets = {};
      for (const name of parseVarRefs(p.tmpl)) {
        const childId = nameIndex[name];
        if (childId == null) continue;                    // unknown name → empty, like a missing {value}
        vars[name] = textById.get(childId) ?? '';
        varRefOffsets[name] = refOffsetsById.get(childId) || [];
      }
      const composed = compose(p.tmpl, {
        path: filePath,
        ref: p.needsRef ? shellRefFor(shellType, filePath) : null,
        value: p.tmpl.includes('{value}') ? value : null,
        clipboard: p.needsClipboard ? clipboardValue : null,
        dirs: conventionDirs,
        vars,
        varRefOffsets,
      });
      textById.set(p.nodeId, composed.text);
      refOffsetsById.set(p.nodeId, composed.refOffsets);
    }

    let text = textById.get(root.id) ?? '';
    const refOffsets = refOffsetsById.get(root.id) || [];

    // Ref safety is a property of the FINISHED string: shellRefFor returns a complete, pre-quoted shell
    // word, and the quote that breaks it can come from a resolved value rather than the template (a
    // username of `root'` is enough). So this can only run here, after composition — which is why the
    // unwind below exists.
    // Only a ref that arrived through {var:} is refused. A quoted {ref} in the author's OWN template is just
    // as broken, but it may predate cross-references entirely — hard-failing it now would break an install
    // for a feature its owner never used. Same reasoning that stops the name rules touching rows nobody
    // edited. The template editor is where that case gets told.
    const unsafe = scanRefSafety(text, refOffsets).filter((h) => h.nested);
    if (unsafe.length) {
      for (const f of written) untrackSecretRef(f, sessionId);
      const at = unsafe[0];
      const why = at.reason === 'unbalanced'
        ? 'a quote is left open around it'
        : `it ended up inside ${at.quote === "'" ? 'single' : 'double'} quotes`;
      return { ok: false, error: `A referenced variable resolves to a file reference, but ${why} — remove the quotes around it. The reference is already a complete shell word.` };
    }

    // An ESC byte stays refused: a control sequence has no safe way into a terminal, pasted or typed, and
    // nothing a user writes in a template needs one.
    if (/\x1b/.test(text)) {
      for (const f of written) untrackSecretRef(f, sessionId);
      return { ok: false, error: `"${root.name}" resolves to text containing a control character — remove it from the template.` };
    }

    // A line break used to be refused the same way, which made the ordinary case — a multi-line PROMPT in a
    // template that materializes nothing — impossible to insert at all. It is carried now: every insert path
    // PASTES (bracketed where the program supports it), so the breaks arrive as text rather than as Enter.
    // What still cannot carry one is an insert that wrote a temp file: {ref} composes a single shell word,
    // and a break inside that command line submits the half in front of it. Those collapse to spaces — the
    // insert lands either way, which is the point. The renderer collapses too where it cannot paste.
    if (written.length) text = text.replace(/[\r\n]+/g, ' ');

    // `lastUsedAt` used to be written by the `use-saved-variables` handler, which was this column's ONLY
    // writer and which nothing ever called — so the column has been dead data. This is the honest place
    // for it: the variable was actually used, at the moment its text reaches a terminal. Root only — the
    // user used the variable they picked, not whatever it happens to reference.
    ctx.db.touchSavedVariable(root.id);
    return { ok: true, text };
  } catch (err) {
    for (const f of written) { try { untrackSecretRef(f, sessionId); } catch {} }
    return failed(err, 'Could not prepare that variable for the terminal.');
  }
}

/**
 * @param {Electron.IpcMain} ipc  passed in, not required — see the header: this module stays Electron-free
 *   so the encryption round-trip and the secret-ref lifecycle can be tested.
 */
function registerIpc(ipc) {
  ipc.handle('list-saved-variables', (_event, projectPath) => {
    try {
      return ctx.db.listSavedVariables(typeof projectPath === 'string' ? projectPath : null)
        .map(row => serializeSavedVariable(row));
    } catch (err) {
      return failed(err, 'Could not read your saved variables.');
    }
  });

  ipc.handle('get-saved-variable', (_event, id) => {
    try {
      const row = ctx.db.getSavedVariable(id);
      if (!row) return { ok: false, error: 'Variable not found' };
      return { ok: true, variable: serializeSavedVariable(row, true) };
    } catch (err) {
      return failed(err, 'Could not read that variable.');
    }
  });

  /**
   * Tell every OTHER window showing Variables that the set moved (#382).
   *
   * There was no notification at all, which was invisible while one window could show the admin. Two
   * of them each held the set they loaded: delete an entry in one, save that same stale entry from
   * the other, and it is back. Writes are per record, so this is the whole of the exposure — but it is
   * the user's credential list, and a list that quietly disagrees with itself is not one to leave.
   *
   * The window that made the change is skipped: it already has the answer in its own reply, and
   * telling it to reload would race its own optimistic update.
   */
  function announceVariablesChanged(event) {
    const sender = event && event.sender;
    const asking = sender && ctx.BrowserWindow ? ctx.BrowserWindow.fromWebContents(sender) : null;
    const main = typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
    if (main && !main.isDestroyed() && main !== asking) {
      try { main.webContents.send('variables-changed'); } catch { /* going away */ }
    }
    if (typeof ctx.detachedWindowsShowingView !== 'function') return;
    try {
      for (const win of ctx.detachedWindowsShowingView('variables')) {
        if (win === asking || win.isDestroyed()) continue;
        win.webContents.send('variables-changed');
      }
    } catch { /* a notification is never worth taking a save down with it */ }
  }

  ipc.handle('save-saved-variable', (event, input = {}) => {
    try {
      const name = String(input.name || '').trim().slice(0, 120);
      if (!name) return { ok: false, error: 'Name is required' };

      // A name is how a template refers to a variable (`{var:<name>}`), and the grammar stops at a brace — so
      // a name holding one can never be referenced. Rejected only when the name is actually NEW or CHANGED:
      // rows predating cross-references may hold anything, and they still work for everything except being
      // referenced. Blocking a save because of a name the user did not touch would lock them out of editing
      // their own value — arriving, of all moments, while they are rotating a credential.
      const previous = input.id ? ctx.db.getSavedVariable(input.id) : null;
      const nameChanged = !previous || previous.name !== name;
      if (nameChanged && /[{}]/.test(name)) {
        return { ok: false, error: 'A name cannot contain { or } — it could not be referenced as {var:name}' };
      }

      const scope = input.scope === 'project' ? 'project' : 'global';
      const projectPath = scope === 'project' ? String(input.projectPath || '').trim() : null;
      if (scope === 'project' && !projectPath) {
        return { ok: false, error: 'Project scope requires an active project' };
      }

      const secret = !!input.secret;
      const encoded = encryptSavedVariableValue(input.value, secret);
      const row = ctx.db.saveSavedVariable({
        id: input.id || crypto.randomUUID(),
        name,
        value: encoded.value,
        valueEncoding: encoded.valueEncoding,
        secret,
        scope,
        projectPath,
        tags: normalizeSavedVariableTags(input.tags),
        insertTemplate: String(input.insertTemplate || '').slice(0, 2000),
      });

      announceVariablesChanged(event);
      return { ok: true, variable: serializeSavedVariable(row) };
    } catch (err) {
      return failed(err, 'Could not save that variable.');
    }
  });

  ipc.handle('delete-saved-variable', (event, id) => {
    try {
      ctx.db.deleteSavedVariable(id);
      announceVariablesChanged(event);
      return { ok: true };
    } catch (err) {
      return failed(err, 'Could not delete that variable.');
    }
  });

  // Which variables' templates reference `name` via {var:name}? Renaming or deleting one that others compose
  // with breaks them SILENTLY: a reference nobody resolves is empty, so the command still runs — with an empty
  // credential where the secret used to be. So the admin asks first.
  //
  // Matched in JS with the real grammar rather than a SQL LIKE. A LIKE would have to be
  // `'%{var:' || name || '}%'`, and a name containing % or _ is then a wildcard that over-matches — the table
  // has never constrained names. parseVarRefs cannot be fooled that way, and it agrees with the resolver by
  // construction because it IS the resolver's parser. It also honours the effective template, so a row with no
  // template of its own (default {ref}/{value}) correctly references nothing.
  ipc.handle('saved-variable-references', (_event, name) => {
    try {
      const target = String(name || '').trim();
      if (!target) return { ok: true, referencedBy: [] };
      const referencedBy = ctx.db.listAllSavedVariables()
        .filter((row) => parseVarRefs(effectiveTemplate(row)).includes(target))
        .map((row) => ({ id: row.id, name: row.name, scope: row.scope || 'global' }));
      return { ok: true, referencedBy };
    } catch (err) {
      return failed(err, 'Could not work out what references that variable.');
    }
  });

  // Full CRUD list for the Variables admin tab: every variable regardless of scope.
  ipc.handle('list-all-saved-variables', () => {
    try {
      return ctx.db.listAllSavedVariables().map(row => serializeSavedVariable(row));
    } catch (err) {
      return failed(err, 'Could not read your saved variables.');
    }
  });

  ipc.handle('resolve-variable-insert', (_event, id, sessionId) => resolveVariableInsert(id, sessionId));
}

module.exports = {
  init,
  registerIpc,
  // main.js's spawn exit + lifecycle call these.
  cleanupSecretRefsForSession,
  cleanupSecretRefs,
  // Exported for the tests: the encryption round-trip, the secret-ref lifecycle and the resolver are the
  // trust boundaries, and none of them was reachable while this lived in main.js.
  resolveVariableInsert,
  encryptSavedVariableValue,
  decryptSavedVariableValue,
  serializeSavedVariable,
  normalizeSavedVariableTags,
  trackSecretRef,
  untrackSecretRef,
  sweepSecretRefs,
};
