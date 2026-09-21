// backends/pi/command-bridge.js — another CLI's commands as Pi commands (#632, "Resources from").
//
// Pi's `--prompt-template` reads a Claude command file and expands `$ARGUMENTS` and `$1`, but leaves
// `` !`cmd` `` and `@file` as text (measured, spec 30). So a source's commands are not handed to Pi as
// templates. This file writes a section of the per-spawn resources extension (`./resources-extension.js`)
// that registers each command with `pi.registerCommand` and expands it itself before sending it as the
// user's message.
//
// WHAT A COMMAND MEANS IS THE SOURCE'S DATA. The source backend declares a `commandDialect` in its own
// descriptor (Claude's is in `../claude/index.js`), and this section only carries out what that data says:
// which token is "all arguments", whether `$1…` are positional arguments, which markers enclose an inline
// shell command and which frontmatter key permits one, which prefix marks a file reference, and how a
// subdirectory affects a command's name. Nothing below names a backend or hard-wires its syntax.
//
// PI'S OWN COMMANDS WIN. Extension commands are dispatched BEFORE prompt templates (`agent-session.js`
// `prompt()`), so registering a name Pi already has would shadow the user's own template. Commands are
// therefore registered at `session_start`, when Pi's templates are loaded, and a name Pi already has is
// skipped and reported. The exception is the app's own per-spawn templates (#569): a source's `/handoff` is
// the user's own, and it wins over ours — the rule #569 already states for a template the user keeps.
//
// AN INLINE SHELL COMMAND RUNS ONLY WHEN THE FILE PERMITS IT (owner decision O4), the rule the source CLI
// applies: its permission key must name the shell tool, bare (anything) or with a pattern covering this
// command. A command that chains or redirects (`;`, `&&`, `|`, `>`, `$(`…) is refused unless the tool is
// permitted bare, because a prefix pattern would otherwise let `git status && <anything>` through. A refused
// command stays in the text as written and the user is told. None of this is asked about: the file's own
// permission is the answer, as it is in the source CLI.
'use strict';

const fs = require('fs');
const path = require('path');

// The imports the generated section needs; the composer merges them with the other sections' imports.
const IMPORTS = [
  'import { spawn } from "node:child_process";',
  'import * as fs from "node:fs";',
  'import * as path from "node:path";',
  'import { getShellConfig, parseFrontmatter } from "@earendil-works/pi-coding-agent";',
];

// ── The expander ────────────────────────────────────────────────────────────────────────────────────
// Plain functions, no types and no closure over this module: each is written into the generated extension
// with `toString()`, and the tests call the same functions directly — one implementation, not two.
// Only `fs` and `path` are referenced, which are imports in the extension and requires here.

// The registry symbol under which the runtime-driven backend's approval gate publishes its question
// (`../pi-native/runtime-extension.js` reads the key from here). Owner decision F3: where that gate is on,
// a permitted inline shell line is still asked about, because a conversation with the gate on must not run
// a shell command nobody was asked about. Where no gate is published, the file's permission is the answer.
// "Allow for this session" there covers that one command's lines only (N1) — never the agent's `bash` tool,
// which a harmless `git status` in the user's own command must not unlock.
const APPROVAL_ASK_KEY = 'switchboard.approval.ask';

const FILE_CAP = 256 * 1024;
const OUTPUT_CAP = 64 * 1024;
const SHELL_TIMEOUT_MS = 30 * 1000;

/** Words of an argument string, keeping a quoted span as one word. */
function splitArgs(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(text || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** The body with the dialect's argument tokens replaced. Unknown positions become empty, as in the source CLI. */
function substituteArgs(body, argText, dialect) {
  let text = String(body || '');
  const args = splitArgs(argText);
  if (dialect && dialect.positionalArguments) {
    text = text.replace(/\$(\d+)/g, (_m, n) => {
      const i = Number(n);
      return i >= 1 && i <= args.length ? args[i - 1] : '';
    });
  }
  if (dialect && dialect.allArguments) text = text.split(dialect.allArguments).join(String(argText || '').trim());
  return text;
}

/** A frontmatter permission value as a list of entries (a comma-separated string or a YAML list). */
function permissionEntries(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/,(?![^()]*\))/) : [];
  return raw.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/**
 * Whether `entries` permit running `command` with the dialect's shell tool.
 *   `<tool>`                   — any command;
 *   `<tool>(<prefix><suffix>)` — the command is the prefix, or starts with it followed by a space;
 *   `<tool>(<glob>)`           — the whole command matches, `wildcard` standing for any run of characters;
 *   `<tool>(<exact>)`          — the command is exactly that.
 * A command that chains, pipes, redirects or substitutes is permitted only by the bare tool.
 */
function permitsShell(command, entries, rule) {
  if (!rule || !rule.tool) return false;
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (entries.includes(rule.tool)) return true;
  if (/[;&|<>\n\r`]|\$\(/.test(cmd)) return false;
  const open = rule.tool + '(';
  for (const entry of entries) {
    if (!entry.startsWith(open) || !entry.endsWith(')')) continue;
    const pattern = entry.slice(open.length, -1).trim();
    if (!pattern) continue;
    if (rule.prefixSuffix && pattern.endsWith(rule.prefixSuffix)) {
      const prefix = pattern.slice(0, -rule.prefixSuffix.length).trim();
      if (prefix && (cmd === prefix || cmd.startsWith(prefix + ' '))) return true;
      continue;
    }
    if (rule.wildcard && pattern.includes(rule.wildcard)) {
      const re = new RegExp('^' + pattern.split(rule.wildcard)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (re.test(cmd)) return true;
      continue;
    }
    if (cmd === pattern) return true;
  }
  return false;
}

/** The inline shell spans of a body, in order: `[{ start, end, command }]`. */
function inlineShellSpans(body, shell) {
  const spans = [];
  if (!shell || !shell.open || !shell.close) return spans;
  const text = String(body || '');
  let from = 0;
  for (;;) {
    const start = text.indexOf(shell.open, from);
    if (start === -1) break;
    const inner = start + shell.open.length;
    const end = text.indexOf(shell.close, inner);
    if (end === -1) break;
    const command = text.slice(inner, end);
    if (!/[\r\n]/.test(command)) spans.push({ start, end: end + shell.close.length, command });
    from = end + shell.close.length;
  }
  return spans;
}

/**
 * The body with each `<marker><path>` that names a readable file replaced by that file's content.
 *
 * A reference runs to the next space, so whatever the sentence around it CLOSES with travels with the
 * path and has to come off again before it is resolved — quotes included (#644): a command that writes
 * `say "the notes, @notes.md"` means the file, and the source CLI reads it. The run that came off is put
 * back after the content, so the sentence is unchanged.
 *
 * What OPENS the reference is a different question and stays strict: the marker has to follow whitespace,
 * so `X=@notes.md` is not a reference and neither is a marker glued to an opening quote. That half is not
 * an oversight — the source CLI does the same (measured against Claude Code v2.1.278, which reads a
 * reference written after a space and leaves `X=@notes.md` as text).
 */
function expandFileRefs(body, marker, cwd, cap) {
  if (!marker) return String(body || '');
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|\\s)' + esc + '([^\\s]+)', 'g');
  return String(body || '').replace(re, (whole, lead, ref) => {
    const clean = ref.replace(/[.,;:!?)\]"']+$/, '');
    const trail = ref.slice(clean.length);
    const file = path.resolve(cwd || '.', clean);
    let content;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > cap) return whole;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      return whole;
    }
    const fence = content.includes('```') ? '````' : '```';
    return lead + clean + ':\n' + fence + '\n' + content.replace(/\s+$/, '') + '\n' + fence + trail;
  });
}

/**
 * A command body split into what is sent as text and what would run, BEFORE anything runs:
 * `[{ text }]` and `[{ command, permitted, original }]`, in order.
 *
 * The order is the security of it. Spans are found in the file's RAW body, so arguments can neither add a
 * span nor cut one short; arguments are then substituted into each span's command, whose permission is
 * judged on the result. File references are expanded only in the file's own text, with the arguments held
 * as placeholders meanwhile, so an argument cannot name a file to inline and a file's content is not
 * searched for argument tokens. Shell output is never expanded at all — it goes back as it came.
 */
function planCommand(body, argText, dialect, entries, cwd, cap) {
  const raw = String(body || '');
  const d = dialect || {};
  const args = splitArgs(argText);
  const all = String(argText || '').trim();
  const textPart = (segment) => {
    const held = [];
    const hold = (value) => { held.push(value); return '\u0000' + (held.length - 1) + '\u0000'; };
    let t = segment;
    if (d.positionalArguments) {
      t = t.replace(/\$(\d+)/g, (_m, n) => {
        const i = Number(n);
        return hold(i >= 1 && i <= args.length ? args[i - 1] : '');
      });
    }
    if (d.allArguments) t = t.split(d.allArguments).join(hold(all));
    // Split on the placeholders: file references are expanded in the file's own pieces only, and each
    // placeholder is put back by position — so an inlined file is never searched for one.
    return t.split(/(\u0000\d+\u0000)/).map((piece) => {
      const m = /^\u0000(\d+)\u0000$/.exec(piece);
      if (m && Number(m[1]) < held.length) return held[Number(m[1])];
      return d.fileReference ? expandFileRefs(piece, d.fileReference, cwd, cap) : piece;
    }).join('');
  };
  const parts = [];
  let at = 0;
  for (const span of d.inlineShell ? inlineShellSpans(raw, d.inlineShell) : []) {
    if (span.start > at) parts.push({ text: textPart(raw.slice(at, span.start)) });
    const command = substituteArgs(span.command, argText, d);
    parts.push({
      command,
      permitted: permitsShell(command, entries || [], d.inlineShell),
      original: d.inlineShell.open + command + d.inlineShell.close,
    });
    at = span.end;
  }
  if (at < raw.length) parts.push({ text: textPart(raw.slice(at)) });
  return parts;
}

/** Every command file under `dir`, as `[{ name, file, label }]`, sorted, first of two equal names kept. */
function listCommandFiles(dir, dialect) {
  const out = [];
  const seen = new Set();
  const walk = (current, rel, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4 && dialect && dialect.subdirectories) walk(full, rel ? rel + '/' + entry.name : entry.name, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const base = entry.name.slice(0, -3);
      const name = dialect && dialect.subdirectories === 'name' && rel ? rel.split('/').join(':') + ':' + base : base;
      if (!/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, file: full, label: rel || '' });
    }
  };
  walk(dir, '', 0);
  return out;
}

const EXPANDER = [splitArgs, substituteArgs, permissionEntries, permitsShell, inlineShellSpans, expandFileRefs, planCommand, listCommandFiles];

/**
 * The generated section: the expander, the commands this spawn carries, and `registerSourceCommands(pi)`.
 * `commands` is `[{ path, scope, dialect }]` as the core resolved it; `ownTemplatePrefix` names the app's
 * per-spawn template directories, whose commands a source's may replace.
 */
function commandSection({ commands, ownTemplatePrefix } = {}) {
  const data = (commands || []).map((c) => ({ dir: c.path, scope: c.scope, dialect: c.dialect || {} }));
  return [
    '// Another CLI\'s commands, expanded the way that CLI declares them (#632). See command-bridge.js.',
    `const SOURCE_COMMANDS: any[] = ${JSON.stringify(data)};`,
    `const OWN_TEMPLATE_PREFIX: string = ${JSON.stringify(ownTemplatePrefix || '')};`,
    `const COMMAND_FILE_CAP = ${FILE_CAP};`,
    `const COMMAND_OUTPUT_CAP = ${OUTPUT_CAP};`,
    `const COMMAND_SHELL_TIMEOUT_MS = ${SHELL_TIMEOUT_MS};`,
    `const APPROVAL_ASK_KEY: string = ${JSON.stringify(APPROVAL_ASK_KEY)};`,
    ...EXPANDER.map((fn) => fn.toString()),
    RUNTIME,
  ].join('\n\n') + '\n';
}

// The part that only makes sense inside Pi: running a permitted shell command, and registering. Written as
// text because it needs Pi's API; everything it decides is in the functions above.
const RUNTIME = [
  'function runShell(command: string, cwd: string): Promise<string> {',
  '  return new Promise((resolve) => {',
  '    let cfg: any;',
  '    try { cfg = getShellConfig(); } catch (err) { resolve("[shell unavailable: " + String((err && (err as any).message) || err) + "]"); return; }',
  '    const viaStdin = cfg.commandTransport === "stdin";',
  '    const args = viaStdin ? cfg.args : [...cfg.args, command];',
  '    let out = "";',
  '    let done = false;',
  '    let timer: any = null;',
  '    const finish = (text: string) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(text); } };',
  '    let proc: any;',
  '    try { proc = spawn(cfg.shell, args, { cwd, shell: false, windowsHide: true, stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"] }); }',
  '    catch (err) { finish("[could not run: " + String((err && (err as any).message) || err) + "]"); return; }',
  '    const add = (d: any) => { if (out.length < COMMAND_OUTPUT_CAP) out += d.toString(); };',
  '    proc.stdout.on("data", add);',
  '    proc.stderr.on("data", add);',
  '    proc.on("error", (err: any) => finish("[could not run: " + String((err && err.message) || err) + "]"));',
  '    proc.on("close", () => finish(out.slice(0, COMMAND_OUTPUT_CAP).replace(/\\s+$/, "")));',
  '    if (viaStdin) { try { proc.stdin.end(command); } catch {} }',
  '    const kill = () => {',
  '      if (process.platform === "win32" && proc.pid) { try { spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); return; } catch {} }',
  '      try { proc.kill(); } catch {}',
  '    };',
  '    timer = setTimeout(() => { kill(); finish(out.replace(/\\s+$/, "") + "\\n[timed out]"); }, COMMAND_SHELL_TIMEOUT_MS);',
  '    if (timer && typeof timer.unref === "function") timer.unref();',
  '  });',
  '}',
  '',
  'async function expandCommandFile(entry: any, dialect: any, argText: string, cwd: string, notify: (m: string) => void, cctx: any): Promise<string | null> {',
  '  let raw = "";',
  '  try { raw = fs.readFileSync(entry.file, "utf-8"); } catch { notify("/" + entry.name + ": the command file could not be read."); return null; }',
  '  let parsed: any;',
  '  try { parsed = parseFrontmatter(raw); } catch { parsed = { frontmatter: {}, body: raw }; }',
  '  const fm = (parsed && parsed.frontmatter) || {};',
  '  const shell = dialect.inlineShell;',
  '  const entries = shell && shell.permissionKey ? permissionEntries(fm[shell.permissionKey]) : [];',
  '  const parts = planCommand(String((parsed && parsed.body) || ""), argText, dialect, entries, cwd, COMMAND_FILE_CAP);',
  '  let text = "";',
  '  const refused: string[] = [];',
  '  for (const part of parts) {',
  '    if (part.text !== undefined) text += part.text;',
  '    else if (part.permitted) {',
  '      const g: any = globalThis;',
  '      const askGate = g[Symbol.for(APPROVAL_ASK_KEY)];',
  '      const allowed = typeof askGate !== "function" || await askGate("bash", part.command, cctx, { key: "command:" + entry.name, by: "/" + entry.name });',
  '      if (allowed) text += await runShell(part.command, cwd);',
  '      else { text += part.original; refused.push(part.command + " (you refused it)"); }',
  '    }',
  '    else { text += part.original; refused.push(part.command); }',
  '  }',
  '  if (refused.length) notify("/" + entry.name + ": not run: " + refused.join(" · "));',
  '  return text.trim() ? text : null;',
  '}',
  '',
  'function registerSourceCommands(pi: any) {',
  '  const mine = new Set<string>();',
  '  pi.on("session_start", async (_event: any, ctx: any) => {',
  '    const taken = new Set<string>();',
  '    let listed: any[] = [];',
  '    try { listed = pi.getCommands() || []; } catch {}',
  '    for (const c of listed) {',
  '      if (!c || !c.name || mine.has(c.name)) continue;',
  '      const where = String((c.sourceInfo && c.sourceInfo.path) || "");',
  '      const parts = where.split(/[\\\\/]/);',
  '      const own = !!OWN_TEMPLATE_PREFIX && parts.length > 1 && parts[parts.length - 2].startsWith(OWN_TEMPLATE_PREFIX);',
  '      if (!own) taken.add(c.name);',
  '    }',
  '    const skipped: string[] = [];',
  '    for (const source of SOURCE_COMMANDS) {',
  '      for (const entry of listCommandFiles(source.dir, source.dialect)) {',
  '        if (mine.has(entry.name)) continue;',
  '        if (taken.has(entry.name)) { skipped.push("/" + entry.name); continue; }',
  '        let description = "";',
  '        try {',
  '          const fm = (parseFrontmatter(fs.readFileSync(entry.file, "utf-8")) as any).frontmatter || {};',
  '          const d = source.dialect.descriptionKey ? fm[source.dialect.descriptionKey] : undefined;',
  '          const hint = source.dialect.argumentHintKey ? fm[source.dialect.argumentHintKey] : undefined;',
  '          description = [typeof d === "string" ? d : "", typeof hint === "string" ? hint : ""].filter(Boolean).join(" ");',
  '        } catch {}',
  '        if (entry.label) description = (description ? description + " " : "") + "(" + entry.label + ")";',
  '        mine.add(entry.name);',
  '        pi.registerCommand(entry.name, {',
  '          description: description || undefined,',
  '          handler: async (args: string, cctx: any) => {',
  '            const cwd = (cctx && cctx.cwd) || process.cwd();',
  '            const notify = (m: string) => { try { cctx.ui.notify(m, "warning"); } catch {} };',
  '            const text = await expandCommandFile(entry, source.dialect, args || "", cwd, notify, cctx);',
  '            if (!text) return;',
  '            const idle = !cctx || typeof cctx.isIdle !== "function" || cctx.isIdle();',
  '            if (idle) pi.sendUserMessage(text);',
  '            else pi.sendUserMessage(text, { deliverAs: "followUp" });',
  '          },',
  '        });',
  '      }',
  '    }',
  '    if (skipped.length) { try { ctx.ui.notify("Not taken over, because Pi already has a command of that name: " + skipped.join(", "), "info"); } catch {} }',
  '  });',
  '}',
].join('\n');

module.exports = {
  IMPORTS,
  APPROVAL_ASK_KEY,
  commandSection,
  // The expander, for the tests — the same functions the generated section carries.
  splitArgs, substituteArgs, permissionEntries, permitsShell, inlineShellSpans, expandFileRefs, planCommand, listCommandFiles,
};
