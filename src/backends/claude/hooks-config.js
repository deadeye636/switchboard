// backends/claude/hooks-config.js — the hooks Claude has configured, as neutral rows another backend may
// take over (#635, "Resources from").
//
// Claude keeps them under `hooks` in its settings files, and which file a hook comes from decides whether
// it may leave:
//   - `~/.claude/settings.json` and `~/.claude/settings.local.json` — the user's own, every project;
//   - `<project>/.claude/settings.json` — typically committed, so anybody who writes the repository
//     writes it;
//   - `<project>/.claude/settings.local.json` — conventionally this machine only, and conventionally
//     gitignored. It is still reported as `project` scope, because NOTHING enforces that convention: a
//     repository can ship the file, and the core's trust rule is the only thing standing between a
//     checkout and a command running on this machine. Being strict costs one trust prompt; being lax
//     costs everything.
//
// ONLY `type: "command"` HOOKS TRAVEL, and that is also what keeps Switchboard's own attention hook out
// (#635, H1). The app writes `type: "http"` entries into this very file (`src/app/hooks.js`), and a Pi
// session that also reported busy and idle through a taken-over copy of them would announce every turn
// twice. Filtering by TYPE rather than by our own URL is the structural version of that rule: a hook of
// ours is not a command, so it cannot be mistaken for one, and nothing here has to know what our sentinel
// looks like.
//
// A MATCHER NAMES CLAUDE'S TOOLS, and the neutral words are what the target understands
// (`../tool-vocabulary.js`, the same seam an agent's tools use since #639). A matcher this file cannot map
// means the hook is NOT taken over: it is reported with that reason instead, because a hook attached to a
// wider set of tools than the user wrote would run their command where they did not ask for it.
//
// Nothing here decides whether a hook RUNS. These are rows; `src/app/resource-sources.js` applies the
// trust rule and the toggle, and the target runs them.
'use strict';

const fs = require('fs');
const path = require('path');

// Claude's own event names, onto the neutral words. A name not here has no counterpart to carry it to —
// `PreToolUse`, `UserPromptSubmit` and `PreCompact` are left out on purpose (owner decision H2): each of
// them can answer back, and answering back is the approval gate's job, not this feature's.
const EVENT_WORDS = Object.freeze({
  SessionStart: 'session-start',
  PostToolUse: 'tool-finished',
  Stop: 'agent-idle',
});

// The tool names come from the descriptor's `agentDialect.toolWords`, handed in by the factory below:
// a matcher and an agent's `tools` line name the same things, and a second table here would drift from it.
const { isToolWord } = require('../tool-vocabulary');

// A matcher that means "every tool". Claude treats an absent or empty matcher that way, and `*` and `.*`
// are how people write it.
const ALL_TOOLS = new Set(['', '*', '.*']);

// Claude's default when a hook declares none (its documented hook timeout, in seconds).
const DEFAULT_TIMEOUT_SEC = 60;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The neutral tool words a matcher names, or a REASON it cannot be carried.
 * Answers `{ tools: null }` for "every tool", `{ tools: [...] }`, or `{ reason }`.
 */
function matcherTools(matcher, toolWords) {
  const raw = String(matcher == null ? '' : matcher).trim();
  if (ALL_TOOLS.has(raw)) return { tools: null };
  const names = raw.split('|').map(s => s.trim()).filter(Boolean);
  if (!names.length) return { tools: null };
  const words = [];
  for (const name of names) {
    const word = toolWords[name];
    // A name that is not plainly one of Claude's tools is a pattern, and a pattern cannot be narrowed
    // into a tool list without guessing which tools it would have matched. `isToolWord` is the second
    // half: a declaration naming something the shared vocabulary does not have is a mistake in the
    // declaration, and carrying it would put an unknown word in front of the target.
    if (!word || !isToolWord(word)) return { reason: `the matcher names ${name}, which has no counterpart` };
    if (!words.includes(word)) words.push(word);
  }
  return { tools: words };
}

function hookRows(blob, meta, toolWords) {
  const out = [];
  if (!isObject(blob) || !isObject(blob.hooks)) return out;
  for (const [claudeEvent, groups] of Object.entries(blob.hooks)) {
    const event = EVENT_WORDS[claudeEvent];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      // A MATCHER ONLY NAMES TOOLS ON THE TOOL EVENT. On `SessionStart` this CLI's matcher is `startup`,
      // `resume`, `clear` or `compact` — which side of a session it is — and on `Stop` there is none at
      // all. Reading one as a tool list refused the commonest `SessionStart` configuration there is, with
      // the sentence "the matcher names startup, which has no counterpart": true, and about the wrong
      // question. What a session-side matcher SELECTS is not carried: the target reaches its own start
      // once, however this one was reached.
      const matched = event === 'tool-finished' ? matcherTools(group.matcher, toolWords) : { tools: null };
      for (const hook of group.hooks) {
        if (!isObject(hook)) continue;
        // Ours, and anything else that is not a command line. See the header.
        if (hook.type !== 'command') continue;
        const command = typeof hook.command === 'string' ? hook.command.trim() : '';
        if (!command) continue;
        // `sourceEvent`, NOT `origin`: everywhere else in this family `origin` says where a thing is
        // CONFIGURED (user / local / project), and the preview prints it in the scope pill — a hook
        // labelled "PostToolUse" there would hide which dropped hooks came out of the repository.
        const row = { ...meta, command, sourceEvent: claudeEvent };
        // Worded without naming who is taking it: this folder is a source for ANY target, and a sentence
        // naming one of them is both wrong for the next and a backend id outside its own folder
        // (CLAUDE.md reflex 5). It reaches the user through `dropped[].note`.
        if (!event) { row.declined = `${claudeEvent} has no counterpart to run it on`; out.push(row); continue; }
        if (matched.reason) { row.event = event; row.declined = matched.reason; out.push(row); continue; }
        row.event = event;
        row.tools = matched.tools;
        const timeout = Number(hook.timeout);
        row.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout * 1000) : DEFAULT_TIMEOUT_SEC * 1000;
        out.push(row);
      }
    }
  }
  return out;
}

/**
 * @param {() => string} claudeHome  resolved per call — an isolated instance has its own (#241).
 * @param {() => object} toolWords   the descriptor's own `agentDialect.toolWords`, so there is one table.
 */
function createListSharedHooks({ claudeHome, toolWords }) {
  return function listSharedHooks({ projectPath = null } = {}) {
    const words = toolWords();
    const rows = [];
    const home = claudeHome();
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.join(home, name);
      rows.push(...hookRows(readJson(file), { scope: 'global', file }, words));
    }
    if (projectPath) {
      for (const name of ['settings.json', 'settings.local.json']) {
        const file = path.join(projectPath, '.claude', name);
        rows.push(...hookRows(readJson(file), { scope: 'project', file }, words));
      }
    }
    return { ok: true, hooks: rows };
  };
}

module.exports = { createListSharedHooks, EVENT_WORDS, DEFAULT_TIMEOUT_SEC, _matcherTools: matcherTools };
