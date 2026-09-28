// backends/claude-native/rpc-protocol.js — Claude Code's stream-json protocol, spoken in Claude's words and
// answered in neutral ones (#660).
//
// `claude -p --input-format stream-json --output-format stream-json` takes one JSON line per user turn or
// control request on stdin and writes messages, stream events and control traffic to stdout. This file is the
// only place that knows what those lines mean. What leaves it is the app's own vocabulary — the ops
// `src/app/agent-rpc.js` moves and the conversation view draws, listed at the top of
// `../pi-native/rpc-protocol.js` — so neither the core nor the renderer learns a Claude event name.
//
// The entries are Claude's own transcript lines (`{ type: 'user'|'assistant', uuid, message }`), which the
// Message History viewer already draws, so a live session and its history look the same and there is no
// second mapping of Claude's message format.
//
// What the protocol does that decides the code below, all measured against Claude Code 2.1.283 rather than
// read off the SDK's source:
//
//   1. A turn line is never answered. The core writes it and takes the write as the turn's start
//      (`sendAcknowledged: false`), and `result` is its end.
//   2. A turn the core did not write still starts: a line queued behind a running turn runs after that
//      turn's `result` with nothing written in between. Every turn opens with a `system/init`, so that is
//      the busy edge for it — for a turn the core wrote, the core has already said busy and this repeats it.
//   3. The user's own line comes back only with `--replay-user-messages`, and it comes back when its turn
//      STARTS, not when it was written — so a queued follow-up is drawn where it ran, not where it was typed.
//   4. Each finished content block arrives as an `assistant` line of its own, under the uuid the transcript
//      gives the same line. So the uuid is the entry's key, unique for the conversation, and the streamed
//      partial is emptied as each block lands rather than when the model's message ends.
//   5. `/clear` answers with `conversation_reset` and then continues under a new session id; `/compact`
//      keeps the id. The id is read off every line, so either move — and a `--fork-session` launch, whose
//      first line names the fork — reaches the core as one `identity` op.
//   6. A local slash command (`/cost`, `/context`, `/login`) answers with an assistant line whose model is
//      `<synthetic>` and an ordinary `result`. It is an entry like any other, NOT a `localCommand` op — that
//      op is a `!` shell line of the core's own and is dropped for an id the core did not start.
//      The TRANSCRIPT writes the same output differently (#681, measured on 2.1.283 with `/cost`): a
//      `type: 'system'`, `subtype: 'local_command'` line whose top-level `content` is the text wrapped in
//      `<local-command-stdout>`, under the SAME uuid as the synthetic assistant line. The typed command is a
//      user line of `<command-name>` markup the stream does not replay. So an attach turns that system line
//      into the entry the stream sent (`localCommandEntry`), and the key matches without a second mapping.
//   7. A tool that needs an approval asks over the control channel (`control_request`, `can_use_tool`) only
//      with `--permission-prompt-tool stdio`. The answer echoes the tool's input back as `updatedInput`, which
//      is why `answerCommand` is handed the question it answers. A request the CLI withdraws
//      (`control_cancel_request`) must not be answered.
//   8. Stop (`interrupt`) is answered at once and ends the running turn with an ordinary `result` whose
//      subtype is `error_during_execution`, `is_error` set and a diagnostic line as its `errors` — the same
//      shape a turn that really failed has. So the decoder hears what the core wrote (`noteSent`) and reads
//      that result, when it follows a Stop, as the stop it is. The session takes the next turn as usual.
//   9. Three kinds of approval (#661), all `can_use_tool`:
//      - An ordinary tool may carry `permission_suggestions` — only when no rule of the user's matched
//        (measured: a Bash call under an `ask` rule carried none, a Write carried `setMode acceptEdits` for
//        the session, `mkdir` carried an allow rule for `localSettings` beside two for the session). Handed
//        back as `updatedPermissions`, the CLI applies them — a `localSettings` rule by writing it into the
//        project's `.claude/settings.local.json` itself (#674, measured).
//      - `AskUserQuestion` is a question, not a permission. Its answer is an allow whose `updatedInput`
//        carries `answers: { <question>: <text> }`; a multi-select answer is the labels joined with ", ",
//        and any text is taken as a free answer (both measured).
//      - `ExitPlanMode` carries the plan as markdown and NO permission suggestions. Approving is a plain
//        allow (the session goes back to its mode before planning); "keep planning" is a deny with
//        `interrupt: true`, which ends the turn with the same `error_during_execution` result a Stop gets —
//        so `noteSent` reads that answer the way it reads a Stop.
'use strict';

// IMAGE_INPUT is the images a turn may carry (#662), shared with pi-native because both answer to the same
// limits; re-exported below, where the descriptor takes it from.
const crypto = require('crypto');
const { textOf, argsFromText, oneLineDescription, NOTICES, IMAGE_INPUT } = require('../rpc-shared');
// Claude's slash-command grammar, from Claude's own reader — one copy of it, beside the transcript format
// it belongs to (#229, #680).
const { typedCommand, localCommandOutput } = require('../claude/session-reader');

// The answers an approval card offers. "For this session" only where the CLI suggested something for the
// session (point 9). "In this project" only where it suggested an allow rule for the project's LOCAL settings
// (#674, which narrowed #661 E17): Claude writes that rule into `.claude/settings.local.json` itself, and a
// suggestion for the shared project settings or the user's settings is still not offered — one click must not
// change the rules for a whole team or for every project on the machine.
const ALLOW = 'allow';
const ALLOW_SESSION = 'allow-session';
const ALLOW_PROJECT = 'allow-project';
const REFUSE = 'deny';

// The two answers of a plan (point 9). No "approve and accept edits": measured working, left out by the
// owner's decision (#661 E16).
const APPROVE_PLAN = 'approve';
const KEEP_PLANNING = 'keep';

// What Claude is told when the user refuses a tool. The model reads it, so it says what happened.
const REFUSED_MESSAGE = 'The user refused this tool call in Switchboard.';
const KEEP_PLANNING_MESSAGE = 'The user wants to keep planning. Stay in plan mode and wait for their next message.';
const UNANSWERED_MESSAGE = 'The user dismissed the question without answering it.';

// Claude's own tools that ask the user something rather than asking to do something (point 9).
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';

// Which subagent an agent task is (#695). Measured on 2.1.283, for a background and a foreground agent alike:
// the `task_id` Claude gives a `local_agent` task IS the `agentId` its subagent transcript carries
// (`subagents/agent-<id>.jsonl`, and the same id in every line of it), so the task names its subagent row
// with no lookup. A shell or another task has none.
const subagentIdOf = (taskId, kind) => (kind === 'agent' && taskId ? taskId : null);

// A stream event, a message or a result that belongs to a subagent's own conversation carries the tool call
// that started it. Those are the subagent's, drawn under that call by Claude's history reader, not turns of
// this conversation.
const ofSubagent = (msg) => !!(msg && msg.parent_tool_use_id);

// The questions of an `AskUserQuestion` call as the card draws them, or [] when the input is not that shape.
function questionsOf(input) {
  const list = input && Array.isArray(input.questions) ? input.questions : [];
  const out = [];
  for (const q of list) {
    if (!q || typeof q.question !== 'string' || !q.question) continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter(o => o && typeof o.label === 'string' && o.label)
      .map(o => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' }));
    out.push({ question: q.question, header: typeof q.header === 'string' ? q.header : '', options, multiSelect: q.multiSelect === true });
  }
  return out;
}

// The suggestions an approval may hand back for "this session": only those whose destination IS the session.
// One naming a settings file would outlive the session and write a file of the user's (#661 E17).
function sessionPermissions(suggestions) {
  return (Array.isArray(suggestions) ? suggestions : []).filter(s => s && typeof s === 'object' && s.destination === 'session');
}

// The suggestions "in this project" hands back (#674): allow rules for the project's local settings, nothing
// else. Measured on 2.1.283: handed back as `updatedPermissions`, Claude wrote `Bash(mkdir -p <dir>)` into
// `.claude/settings.local.json`, and a new session ran that command without asking while a different one
// still asked.
function projectPermissions(suggestions) {
  return (Array.isArray(suggestions) ? suggestions : []).filter(s => s && typeof s === 'object'
    && s.destination === 'localSettings' && s.type === 'addRules' && s.behavior === 'allow'
    && Array.isArray(s.rules) && s.rules.length);
}

// The button names what it allows, because the rule outlasts the session: the command for a rule with
// content, the tool for a rule without.
const rulesOf = (permissions) => permissions.flatMap(p => p.rules).filter(r => r && typeof r.toolName === 'string' && r.toolName);
// A rule as Claude spells it in its settings: `Tool(content)`, or the bare tool for a rule without content.
const ruleText = (r) => (typeof r.ruleContent === 'string' && r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
function projectLabel(permissions) {
  const rules = rulesOf(permissions);
  if (rules.length !== 1) return 'Always allow these in this project';
  const r = rules[0];
  // A rule without content allows every call of the tool, and the button says so.
  if (!(typeof r.ruleContent === 'string' && r.ruleContent)) return `Always allow every ${r.toolName} call in this project`;
  // A Bash rule reads best as the command alone; any other tool's content (a domain, a path glob) says nothing
  // without the tool, so it is shown the way the settings file spells it.
  const what = r.toolName === 'Bash' ? r.ruleContent : ruleText(r);
  return `Always allow “${what.length > 60 ? what.slice(0, 57) + '…' : what}” in this project`;
}
// Where the rule lands and how it is taken back — the app does not show it again once it is written. The full
// rule leads, because the label may have cut a long command short.
function projectNote(permissions) {
  return `Rule: ${rulesOf(permissions).map(ruleText).join(', ')}. Claude Code writes it into .claude/settings.local.json in the project. Remove it there, or with /permissions in Claude.`;
}

// What "for this session" actually allows, in the button's own words. A mode switch reaches every later call,
// not just this one — `acceptEdits` lets every edit through for the rest of the session — and a card that only
// said "allow for this session" would hide that. Claude's own terminal words the same suggestion this way.
const MODE_LABELS = {
  acceptEdits: 'Allow all edits for this session',
  bypassPermissions: 'Allow everything for this session',
  plan: 'Switch to plan mode for this session',
};
function sessionLabel(permissions) {
  const mode = permissions.find(p => p.type === 'setMode');
  if (mode && MODE_LABELS[mode.mode]) return MODE_LABELS[mode.mode];
  if (permissions.length && permissions.every(p => p.type === 'addRules')) return 'Always allow this for this session';
  return 'Allow for this session';
}

// One stream line as the entry the viewer draws: Claude's own shape, and the uuid the transcript has for it.
function entryOf({ type, uuid, timestamp, message }) {
  return {
    type,
    uuid: typeof uuid === 'string' ? uuid : undefined,
    timestamp: typeof timestamp === 'string' ? timestamp : new Date().toISOString(),
    message,
  };
}

// The text of a user line, when it is plain text: a string, or a single text block. Anything else (tool
// results, images, several blocks) is never command markup and is left alone.
function plainUserText(message) {
  if (!message || typeof message !== 'object') return null;
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length === 1 && c[0] && c[0].type === 'text' && typeof c[0].text === 'string') return c[0].text;
  return null;
}

// --- background tasks (#691) ---
//
// Measured on 2.1.283 (spec 32, "Background tasks and session figures"): a background shell or agent is
// reported as `system` lines — `background_tasks_changed` with the whole running list, `task_started`,
// `task_updated`, `task_notification` — and when one ends Claude starts a turn of its own and puts a user line
// into the conversation whose `origin.kind` is `task-notification` and whose text is a block of tags. What
// leaves this file is the app's own vocabulary: a `tasks` op with the running list, and a `task-notice` entry
// in place of that user line.

// Claude's tool names for the two kinds the app shows; anything else is a task of no known kind.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const kindOfTaskType = (t) => (t === 'local_bash' ? 'shell' : t === 'local_agent' ? 'agent' : 'task');
const kindOfTool = (name) => (SHELL_TOOLS.has(name) ? 'shell' : AGENT_TOOLS.has(name) ? 'agent' : 'task');

const tagOf = (text, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1].trim() : '';
};

// Is this user line the notification Claude injects when a task ends? Its `origin` says so; the text is the
// fallback for a line that carries no origin.
function isTaskNotification(line) {
  if (line && line.origin && line.origin.kind === 'task-notification') return true;
  const text = plainUserText(line && line.message);
  return typeof text === 'string' && text.trimStart().startsWith('<task-notification>');
}

// The notification as the view draws it: which task, how it ended, what it was called, and for an agent what
// it cost. `kind` is resolved by the caller from the call that started the task (`toolKinds`), because the
// notification itself does not say. The output file's path stays out of the entry — the view asks for the
// output by task id, and the core reads it from what the decoder heard (`taskOutputFile`).
function taskNoticeEntry(line, toolKinds) {
  const text = plainUserText(line.message) || '';
  const summary = tagOf(text, 'summary');
  const toolUseId = tagOf(text, 'tool-use-id');
  const quoted = /"([^"]+)"/.exec(summary);
  const exit = /exit code (-?\d+)/.exec(summary);
  const usage = tagOf(text, 'usage');
  const num = (tag) => { const v = Number(tagOf(usage, tag)); return Number.isFinite(v) && tagOf(usage, tag) !== '' ? v : null; };
  const id = tagOf(text, 'task-id');
  const kind = (toolKinds && toolKinds.get(toolUseId)) || 'task';
  return {
    type: 'task-notice',
    uuid: typeof line.uuid === 'string' ? line.uuid : undefined,
    timestamp: typeof line.timestamp === 'string' ? line.timestamp : new Date().toISOString(),
    _task: {
      id,
      toolUseId,
      kind,
      subagentId: subagentIdOf(id, kind),
      status: tagOf(text, 'status'),
      description: quoted ? quoted[1] : summary,
      summary,
      result: tagOf(text, 'result'),
      exitCode: exit ? Number(exit[1]) : null,
      tokens: num('subagent_tokens'),
      toolUses: num('tool_uses'),
      durationMs: num('duration_ms'),
    },
  };
}

// A subagent's final report, or a message another session sent (#701). Claude injects it as a user line whose
// `origin.kind` is `peer`, with `from`, `senderTaskId` and `body` beside it, and `handback: true` for a subagent's
// report (measured over the transcripts of 2.1.261–2.1.283, some 700 lines, all this shape; `handback` since
// 2.1.267). The text is the same message wrapped for the model — "Another Claude session sent a message:" and an
// `<agent-message from="…">` block — and is the fallback for a line that carries no origin.
function isPeerMessage(line) {
  if (line && line.origin && line.origin.kind === 'peer') return true;
  // The text alone is asked for the whole wrapping, not its first words: a prompt the user types may begin
  // with the same sentence, and no measured line lacked its origin.
  const text = plainUserText(line && line.message);
  return typeof text === 'string' && text.trimStart().startsWith('Another Claude session sent a message')
    && /<agent-message from="/.test(text);
}

// A hand-back's body opens with a paragraph the harness writes for the model — the report is model output, not
// the user's words — and ends it with this sentence; the report follows with every line indented two spaces.
const REPORT_FOLLOWS = /The report follows:\r?\n/;

function peerReportText(line) {
  const origin = line.origin || {};
  let body = typeof origin.body === 'string' ? origin.body : '';
  if (!body) {
    const text = plainUserText(line.message) || '';
    const m = /<agent-message[^>]*>\r?\n?([\s\S]*?)(?:<\/agent-message>|$)/.exec(text);
    body = m ? m[1] : text;
  }
  const follows = REPORT_FOLLOWS.exec(body);
  if (follows) body = body.slice(follows.index + follows[0].length).replace(/^ {2}/gm, '');
  return body.trim();
}

// The report as the view draws it: who sent it, which subagent to open, and the report itself. The harness's
// framing stays out — it is addressed to the model.
//
// `kind` says who wrote it, by what the line carries (measured): `report` is a subagent's final hand-back,
// `agent` is the session's own subagent writing mid-task (a `senderTaskId` without `handback`), and `session` is
// another session writing in (no sender task). `toolUseId` is the call that started the sender, where the caller
// knows it, so Open can fall back to that call while the subagent's row is not listed yet.
function peerReportEntry(line, toolUseIdOf) {
  const origin = line.origin || {};
  const text = plainUserText(line.message) || '';
  const fromTag = /<agent-message from="([^"]*)"/.exec(text);
  const from = typeof origin.from === 'string' ? origin.from : (fromTag ? fromTag[1] : '');
  const sender = typeof origin.senderTaskId === 'string' ? origin.senderTaskId : '';
  return {
    type: 'agent-report',
    uuid: typeof line.uuid === 'string' ? line.uuid : undefined,
    timestamp: typeof line.timestamp === 'string' ? line.timestamp : new Date().toISOString(),
    _report: {
      from,
      name: typeof origin.name === 'string' ? origin.name : '',
      kind: origin.handback === true ? 'report' : sender ? 'agent' : 'session',
      handback: origin.handback === true,
      subagentId: sender || null,
      toolUseId: (sender && typeof toolUseIdOf === 'function' && toolUseIdOf(sender)) || null,
      text: peerReportText(line),
    },
  };
}

// Where a background shell writes its output, as the tool result that started it says (measured: "Command
// running in background with ID: <id>. Output is being written to: <path>"). The notification names the same
// file when the task ends; this is what makes it readable while the task still runs.
const OUTPUT_PATH = /Output is being written to: (.+?\.output)\b/;

// A user line as the conversation view should read it (#680). Claude records a slash command as a user
// line of nothing but `<command-name>`/`<command-message>`/`<command-args>` tags, and a local command's
// output as one wrapped in `<local-command-stdout>`. The terminal shows neither as markup, so neither does
// the view: the command reads as what the user typed (arguments included), the output as its text. `null` means the line says
// nothing — a local command that printed nothing — and is left out. Every other line comes back unchanged.
function displayedLine(line) {
  if (!line || line.type !== 'user') return line;
  const text = plainUserText(line.message);
  if (text == null) return line;
  const command = typedCommand(text);
  if (command) return { ...line, message: { ...line.message, content: command } };
  const output = localCommandOutput(text);
  if (output == null) return line;
  if (!output) return null;
  return { ...line, message: { ...line.message, content: output } };
}

/**
 * One decoder per running session: it holds the assistant message being streamed and the session id the
 * CLI last named. `decode(line)` takes one parsed stdout record and answers the ops it amounts to.
 */
function createDecoder() {
  // The content blocks of the model message being streamed, by the index the stream gives them. A block that
  // finished has already arrived as an `assistant` line and been taken out (point 4 above).
  let partial = null;
  let sessionId = null;
  // A Stop — or an answer that interrupts, "keep planning" — went out and the turn it ended has not ended
  // yet (points 8 and 9 above). Holds the sentence that result is drawn as. Cleared by the result that ends
  // that turn, and by a turn starting — a Stop sent while nothing ran ends nothing, and must not turn the
  // next turn's real failure into "Stopped.".
  let stopping = null;
  // Background tasks (#691). `running` is the list Claude last sent, in its order, enriched from
  // `task_started` and from the call that started each one. The rest outlives a task's end: which kind a call
  // was (for the notice that arrives after it), what it ran, and where each task wrote its output.
  let running = [];
  const started = new Map();      // task id -> { toolUseId, description, detail, startedAt }
  const toolKinds = new Map();    // tool_use id -> 'shell' | 'agent' | 'task'
  const toolDetails = new Map();  // tool_use id -> the command a shell ran, or an agent's type
  const toolOutputs = new Map();  // tool_use id -> the output file its tool result named
  const taskOutputs = new Map();  // task id -> the output file
  const noticed = new Set();      // task ids whose end has been drawn
  // The notice for a task that ended, from the `task_notification` system line (see its case below). Its
  // `summary` is Claude's sentence about a shell ("Background command "x" completed (exit code 0)") and an
  // agent's own result; the description comes from the start, where the list gave one.
  function liveTaskNotice(msg) {
    const id = msg.task_id;
    const s = started.get(id) || {};
    const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : (s.toolUseId || '');
    const kind = (toolUseId && toolKinds.get(toolUseId)) || 'task';
    const summary = typeof msg.summary === 'string' ? msg.summary : '';
    const quoted = /"([^"]+)"/.exec(summary);
    const exit = /exit code (-?\d+)/.exec(summary);
    const u = msg.usage && typeof msg.usage === 'object' ? msg.usage : {};
    const num = (v) => (Number.isFinite(v) ? v : null);
    return {
      type: 'task-notice',
      timestamp: new Date().toISOString(),
      _task: {
        id,
        toolUseId,
        kind,
        subagentId: subagentIdOf(id, kind),
        status: typeof msg.status === 'string' ? msg.status : '',
        description: s.description || (quoted ? quoted[1] : summary),
        summary,
        result: kind === 'agent' ? summary : '',
        exitCode: exit ? Number(exit[1]) : null,
        tokens: num(u.total_tokens),
        toolUses: num(u.tool_uses),
        durationMs: num(u.duration_ms),
      },
    };
  }
  const tasksOp = () => ({
    op: 'tasks',
    tasks: running.map((t) => {
      const s = started.get(t.id) || {};
      return {
        id: t.id,
        kind: t.kind,
        description: t.description || s.description || '',
        detail: (s.toolUseId && toolDetails.get(s.toolUseId)) || s.detail || '',
        toolUseId: s.toolUseId || null,
        subagentId: subagentIdOf(t.id, t.kind),
        startedAt: s.startedAt || null,
      };
    }),
  });
  function taskOutputFile(taskId) {
    const id = String(taskId || '');
    if (taskOutputs.has(id)) return taskOutputs.get(id);
    const s = started.get(id);
    return (s && s.toolUseId && toolOutputs.get(s.toolUseId)) || null;
  }

  const partialEntry = () => {
    if (!partial) return null;
    const content = partial.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b;
      const { _argText, ...rest } = b;
      return rest;
    });
    return content.length ? { type: 'assistant', message: { role: 'assistant', content } } : null;
  };
  const partialOp = () => ({ op: 'partial', entry: partialEntry() });

  function onStreamEvent(ev) {
    if (!ev || typeof ev !== 'object') return [];
    switch (ev.type) {
      case 'message_start':
        partial = [];
        return [partialOp()];
      case 'content_block_start': {
        if (!partial) partial = [];
        const b = ev.content_block && typeof ev.content_block === 'object' ? { ...ev.content_block } : null;
        if (!b || !Number.isInteger(ev.index)) return [];
        if (b.type === 'text') b.text = typeof b.text === 'string' ? b.text : '';
        if (b.type === 'thinking') b.thinking = typeof b.thinking === 'string' ? b.thinking : '';
        if (b.type === 'tool_use') { b.input = {}; b._argText = ''; }
        partial[ev.index] = b;
        return [partialOp()];
      }
      case 'content_block_delta': {
        const b = partial && Number.isInteger(ev.index) ? partial[ev.index] : null;
        const d = ev.delta || {};
        if (!b) return [];
        if (d.type === 'text_delta' && b.type === 'text') b.text += d.text || '';
        else if (d.type === 'thinking_delta' && b.type === 'thinking') b.thinking += d.thinking || '';
        else if (d.type === 'input_json_delta' && b.type === 'tool_use') {
          b._argText += d.partial_json || '';
          b.input = argsFromText(b._argText);
        } else return [];
        return [partialOp()];
      }
      case 'message_stop':
        partial = null;
        return [{ op: 'partial', entry: null }];
      default:
        return [];
    }
  }

  // The id the CLI is on, read off any line that names one. A change is announced once, as the core's
  // `identity` op; the first id seen is announced too, and the core's re-key ignores an id it already holds.
  function followId(msg) {
    const id = msg && typeof msg.session_id === 'string' ? msg.session_id : '';
    if (!id || id === sessionId) return [];
    sessionId = id;
    return [{ op: 'identity', sessionId: id }];
  }

  function onAssistant(msg) {
    const m = msg.message;
    if (!m || typeof m !== 'object') return [];
    const ops = [];
    // The block this line carries is finished; the partial keeps only what is still being written.
    if (partial) { partial = partial.map(() => undefined); ops.push({ op: 'partial', entry: null }); }
    ops.push({ op: 'append', entry: entryOf(msg) });
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_use' && b.id) {
        ops.push({ op: 'tool', id: b.id, status: 'running', output: '' });
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        toolKinds.set(b.id, kindOfTool(b.name));
        const detail = typeof input.command === 'string' ? input.command : typeof input.subagent_type === 'string' ? input.subagent_type : '';
        if (detail) toolDetails.set(b.id, detail);
      }
    }
    // A failed model call (a lapsed login, an exhausted account) arrives as an assistant line with an
    // `error` and a sentence as its text. Said as a notice too, so it is not read as an ordinary reply.
    if (msg.error) ops.push({ op: 'notice', level: 'error', text: textOf(m.content) || NOTICES.modelFailed });
    return ops;
  }

  function onUser(msg) {
    const m = msg.message;
    // A subagent's report or another session's message (#701): its own entry, not a line the user typed. Asked
    // before the `isMeta` gate, because the transcript writes this line with `isMeta: true` (measured on 2.1.283
    // in a session this app drove) — it is still the one place the report reaches the conversation.
    if (m && typeof m === 'object' && isPeerMessage(msg)) {
      return [{ op: 'append', entry: peerReportEntry(msg, (taskId) => (started.get(taskId) || {}).toolUseId) }];
    }
    if (!m || typeof m !== 'object' || msg.isMeta) return [];
    // A task ending (#691): drawn as a notice of its own, not as the tags Claude wrote for the model — once,
    // whichever of the two lines about it arrives first.
    if (isTaskNotification(msg)) {
      const entry = taskNoticeEntry(msg, toolKinds);
      if (entry._task.id && noticed.has(entry._task.id)) return [];
      if (entry._task.id) noticed.add(entry._task.id);
      return [{ op: 'append', entry }];
    }
    const shown = displayedLine(msg);
    if (!shown) return [];
    const ops = [{ op: 'append', entry: entryOf(shown) }];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_result' && b.tool_use_id) {
        const output = textOf(b.content);
        ops.push({ op: 'tool', id: b.tool_use_id, status: b.is_error ? 'error' : 'done', output });
        // Only a shell call's result names its output file; nothing else's text is read for a path.
        const file = toolKinds.get(b.tool_use_id) === 'shell' ? OUTPUT_PATH.exec(output || '') : null;
        if (file) toolOutputs.set(b.tool_use_id, file[1]);
      }
    }
    return ops;
  }

  function onResult(msg) {
    const ops = [];
    if (partial) { partial = null; ops.push({ op: 'partial', entry: null }); }
    const stopped = stopping && msg.subtype === 'error_during_execution' ? stopping : null;
    stopping = null;
    if (stopped) {
      ops.push({ op: 'notice', level: 'info', text: stopped });
    } else if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
      // `errors` is the CLI's own sentences about what went wrong; `result` is the reply text, which for a
      // failed turn is usually the same sentence. Neither is a thrown message naming a path.
      const why = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.map(String).join(' ')
        : (typeof msg.result === 'string' && msg.result ? msg.result : '');
      ops.push({ op: 'notice', level: 'error', text: why || 'The turn ended with an error.' });
    }
    ops.push({ op: 'busy', busy: false });
    return ops;
  }

  function onSystem(msg) {
    switch (msg.subtype) {
      // Every turn opens with it — the busy edge for a turn nothing of ours started (point 2 above).
      // It names the permission mode as well (#696).
      case 'init': {
        stopping = null;
        const mode = modeInfo(msg.permissionMode);
        return mode ? [{ op: 'busy', busy: true }, { op: 'mode', mode }] : [{ op: 'busy', busy: true }];
      }
      case 'status': {
        // A status line follows every change of the permission mode (#696).
        const out = msg.status === 'compacting' ? [{ op: 'notice', level: 'info', text: NOTICES.compacting }] : [];
        const mode = modeInfo(msg.permissionMode);
        if (mode) out.push({ op: 'mode', mode });
        return out;
      }
      case 'compact_boundary':
        return [{ op: 'notice', level: 'info', text: NOTICES.compacted }];
      case 'api_retry':
        return [{ op: 'notice', level: 'warning', text: 'The model call failed and is being retried.' }];
      case 'permission_denied':
        return [{ op: 'notice', level: 'warning', text: `A ${msg.tool_name ? `${msg.tool_name} ` : ''}call was refused by the permission rules.` }];
      // Background tasks (#691). The list is the truth about what runs; a start only adds what the list
      // does not carry (the call behind it, when it began).
      case 'task_started': {
        const id = typeof msg.task_id === 'string' ? msg.task_id : '';
        if (!id) return [];
        started.set(id, {
          toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : null,
          description: typeof msg.description === 'string' ? msg.description : '',
          detail: typeof msg.subagent_type === 'string' ? msg.subagent_type : '',
          startedAt: Date.now(),
        });
        return running.some(t => t.id === id) ? [tasksOp()] : [];
      }
      case 'background_tasks_changed':
        running = (Array.isArray(msg.tasks) ? msg.tasks : [])
          .filter(t => t && typeof t.task_id === 'string')
          .map(t => ({ id: t.task_id, kind: kindOfTaskType(t.task_type), description: typeof t.description === 'string' ? t.description : '' }));
        return [tasksOp()];
      case 'task_notification': {
        const id = typeof msg.task_id === 'string' ? msg.task_id : '';
        if (!id) return [];
        if (typeof msg.output_file === 'string' && msg.output_file) taskOutputs.set(id, msg.output_file);
        // The user line Claude injects for the model is NOT sent on the pipe (measured in the app: the turn it
        // starts arrives, the line does not), only written to the transcript. So the live notice is drawn from
        // this line, and an injected line for the same task — replayed after all, or read back — is dropped.
        if (noticed.has(id)) return [];
        noticed.add(id);
        return [{ op: 'append', entry: liveTaskNotice(msg) }];
      }
      default:
        return [];
    }
  }

  function onControlRequest(msg) {
    const r = msg.request || {};
    if (r.subtype !== 'can_use_tool' || msg.request_id == null) return [];
    const input = r.input && typeof r.input === 'object' ? r.input : {};
    const base = {
      id: String(msg.request_id),
      tool: String(r.tool_name || ''),
      toolCallId: r.tool_use_id ? String(r.tool_use_id) : '',
      method: 'select',
      title: '',
      requestedBy: '',
      options: [],
      // Kept for the answer: an allow hands the tool's input back as `updatedInput` (point 7 above).
      input,
    };
    if (r.tool_name === QUESTION_TOOL) {
      const questions = questionsOf(input);
      // A question the card could not draw is still an approval: better "allow AskUserQuestion?" than nothing.
      if (questions.length) return [{ op: 'ask', request: { ...base, kind: 'questions', questions } }];
    }
    if (r.tool_name === PLAN_TOOL && typeof input.plan === 'string') {
      return [{ op: 'ask', request: { ...base, kind: 'plan', plan: input.plan, answers: { approve: APPROVE_PLAN, keep: KEEP_PLANNING } } }];
    }
    const permissions = sessionPermissions(r.permission_suggestions);
    const project = projectPermissions(r.permission_suggestions);
    const answers = { once: ALLOW };
    if (permissions.length) answers.session = ALLOW_SESSION;
    if (project.length) answers.project = ALLOW_PROJECT;
    answers.refuse = REFUSE;
    return [{
      op: 'ask',
      request: {
        ...base,
        kind: 'approval',
        // Claude's own words about the call, where it gave some (a Bash call's description).
        message: typeof r.description === 'string' ? r.description : '',
        answers,
        // What this question is worth, for the card: Claude asks it under its own permission rules, the same
        // question its terminal would put, and a tool its rules allow never reaches this card.
        note: 'Claude Code asks this under its own permission rules, as it would in a terminal.',
        permissions,
        ...(permissions.length ? { sessionLabel: sessionLabel(permissions) } : {}),
        ...(project.length ? { projectPermissions: project, projectLabel: projectLabel(project), projectNote: projectNote(project) } : {}),
      },
    }];
  }

  function decode(msg) {
    if (!msg || typeof msg !== 'object') return [];
    if (ofSubagent(msg)) return [];
    const ops = followId(msg);
    switch (msg.type) {
      case 'stream_event': return ops.concat(onStreamEvent(msg.event));
      // A next prompt the CLI proposes after a turn (#693, `--prompt-suggestions`; spec 32). The text only.
      case 'prompt_suggestion':
        return typeof msg.suggestion === 'string' && msg.suggestion.trim()
          ? ops.concat([{ op: 'suggestion', text: msg.suggestion.trim() }]) : ops;
      case 'assistant': return ops.concat(onAssistant(msg));
      case 'user': return ops.concat(onUser(msg));
      case 'result': return ops.concat(onResult(msg));
      case 'system': return ops.concat(onSystem(msg));
      case 'control_request': return ops.concat(onControlRequest(msg));
      case 'control_cancel_request':
        return msg.request_id == null ? ops : ops.concat([{ op: 'answered', id: String(msg.request_id) }]);
      case 'conversation_reset':
        // `/clear`: the conversation on screen is over. The new id arrives on the next line.
        partial = null;
        return ops.concat([{ op: 'partial', entry: null }, { op: 'reset', entries: [] }]);
      default:
        return ops;
    }
  }

  // A line the core wrote. Only what ends the running turn matters here: a Stop (point 8 above), and an
  // answer that interrupts, which is "keep planning" (point 9).
  function noteSent(line) {
    if (!line) return;
    if (line.type === 'control_request' && line.request && line.request.subtype === 'interrupt') stopping = NOTICES.stopped;
    const answer = line.type === 'control_response' && line.response && line.response.response;
    if (answer && answer.behavior === 'deny' && answer.interrupt === true) stopping = 'Kept planning. Say what to change.';
  }

  return { decode, noteSent, currentPartial: partialEntry, taskOutputFile };
}

// --- commands ---

// How a line of input reaches the agent (M8 of the plan). `prompt` is a turn of its own — queued by the CLI
// behind a running one, which is what a plain line written while it runs does anyway. `steer` goes into the
// running turn at its next tool boundary (`next`); `follow_up` waits until it is done (`later`). Claude's
// third priority, `now`, cuts the running turn off and is not offered.
const PRIORITIES = { steer: 'next', follow_up: 'later' };

// A turn with images is a content array: the text first, then the images in their order, which is what
// Claude Code's own TUI writes (measured in its transcripts: one text block carrying `[Image #1]`, `[Image
// #2]` where each was pasted, then the image blocks). The conversation view types the same placeholders
// (#688), so the n-th image is the one the text calls `[Image #n]`. It used to be images first, the order
// Anthropic's documentation recommends; the CLI's own pairing won, because it is what the model sees from
// the TUI every day. A turn without images stays a plain string, as it always was.
function sendCommand({ text, mode, images } = {}) {
  const body = String(text == null ? '' : text);
  const list = Array.isArray(images) ? images : [];
  const content = list.length
    ? [...(body.trim() ? [{ type: 'text', text: body }] : []),
      ...list.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } }))]
    : body;
  const line = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  };
  if (PRIORITIES[mode]) line.priority = PRIORITIES[mode];
  return line;
}

const control = (id, request) => ({ type: 'control_request', request_id: String(id), request });

// Stop is a control request, not a signal: the turn ends and the process stays.
const abortCommand = (id) => control(id, { subtype: 'interrupt' });

// One background task, not the turn (#691). Measured: the task ends at once (`task_updated` killed, a
// `task_notification` stopped), the other tasks keep running, and a task that has already ended answers
// success too.
const stopTaskCommand = (id, taskId) => control(id, { subtype: 'stop_task', task_id: String(taskId) });

// The session's figures for the line under the input (#691): `get_context_usage` answers `totalTokens`,
// `maxTokens`, `percentage` and `model` (measured). The model id becomes the name the TUI shows for it.
const contextCommand = (id) => control(id, { subtype: 'get_context_usage' });

// The permission mode of the running session (#696), measured on 2.1.283:
//   - `{ subtype: 'set_permission_mode', mode }` answers success with `{ mode }` and is followed at once by a
//     `system/status` line carrying `permissionMode`; every turn's `system/init` names the mode too. A change
//     applies to the RUNNING turn: set to `acceptEdits` while a Write waited on a card, the next Write of the
//     same turn asked nothing.
//   - A mode the session cannot enter is REFUSED and changes nothing: `auto` on a model without it
//     (`auto_mode_model`, on Haiku; Sonnet and Opus accepted it), `bypassPermissions` on a session not launched
//     so that it may (`bypass_not_launched`). So the cycle tries the next mode and skips a refusal, which is the
//     TUI's "skip what is unavailable" answered by the CLI itself rather than guessed here.
// The cycle is the TUI's Shift+Tab order, read from the binary: default → acceptEdits → plan → bypassPermissions
// (where allowed) → auto (where available) → default. `dontAsk` is never entered by the cycle; from it the next
// press goes to default. The labels and glyphs are the TUI's status-line words for each mode.
const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
const PERMISSION_MODES = {
  default: { label: 'manual mode', symbol: '⏸', tone: '' },
  acceptEdits: { label: 'accept edits', symbol: '⏵⏵', tone: 'accept' },
  plan: { label: 'plan mode', symbol: '⏸', tone: 'plan' },
  bypassPermissions: { label: 'bypass permissions', symbol: '⏵⏵', tone: 'danger' },
  dontAsk: { label: 'don\'t ask', symbol: '⏵⏵', tone: 'danger' },
  auto: { label: 'auto mode', symbol: '⏵⏵', tone: 'warn' },
};
// A mode as the view draws it: `{ id, label, symbol, tone }` in the app's words. A mode this table does not
// know is shown by its own name, so a new one in a later CLI is still visible.
function modeInfo(mode) {
  const id = typeof mode === 'string' ? mode : '';
  if (!id) return null;
  const m = PERMISSION_MODES[id];
  return m ? { id, ...m } : { id, label: id, symbol: '', tone: '' };
}
const setModeCommand = (id, mode) => control(id, { subtype: 'set_permission_mode', mode: String(mode) });

// `claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-opus-5-5[1m]` → `Opus 5.5`, `Haiku 4.5`. An id of
// another shape is shown as it is.
function modelLabel(model) {
  const id = String(model || '').replace(/\[[^\]]*\]$/, '');
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] != null ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

function contextFromResponse(response) {
  const d = response && response.success !== false && response.data && typeof response.data === 'object' ? response.data : null;
  if (!d) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const tokens = num(d.totalTokens);
  const window = num(d.maxTokens);
  const percent = num(d.percentage) != null ? num(d.percentage) : (tokens != null && window ? Math.round((tokens / window) * 100) : null);
  return { percent, tokens, window, model: typeof d.model === 'string' ? modelLabel(d.model) : '' };
}

// The commands a `/` can complete to. `initialize` answers them, and it may be sent again (measured: two in a
// row both answered, before and without a turn), so asking for the list is asking it once more. Nothing else
// in the protocol lists them with their descriptions.
const commandsCommand = (id) => control(id, { subtype: 'initialize' });

function commandsFromResponse(response) {
  const list = response && response.data && response.data.commands;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    out.push({
      name: c.name,
      description: oneLineDescription(c.description),
      kind: 'command',
      arguments: false,
    });
  }
  return out;
}

// The answer to an approval (`ask`). `answer` is the app's: `{ value }` with one of the card's answers, or
// `{ cancelled: true }` for a card dismissed without one, which refuses — a tool nobody allowed does not run.
//
// Per kind (point 9): a `questions` ask answers `{ answers: { <question>: <text> } }`; a `plan` ask answers
// `{ value }` with approve or keep; an `approval` answers `{ value }` with one of its card's answers.
function answerCommand(requestId, answer = {}, ask = null) {
  const input = (ask && ask.input && typeof ask.input === 'object') ? ask.input : {};
  const reply = (response) => ({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response } });
  const kind = ask && ask.kind;
  if (kind === 'questions') {
    const answers = {};
    const given = !answer.cancelled && answer.answers && typeof answer.answers === 'object' ? answer.answers : {};
    for (const q of Array.isArray(ask.questions) ? ask.questions : []) {
      const text = given[q.question];
      if (typeof text === 'string' && text.trim()) answers[q.question] = text.trim();
    }
    return Object.keys(answers).length
      ? reply({ behavior: 'allow', updatedInput: { ...input, answers } })
      : reply({ behavior: 'deny', message: UNANSWERED_MESSAGE });
  }
  if (kind === 'plan') {
    // Anything but an approval keeps planning — a plan nobody approved is not carried out.
    return !answer.cancelled && answer.value === APPROVE_PLAN
      ? reply({ behavior: 'allow', updatedInput: input })
      : reply({ behavior: 'deny', message: KEEP_PLANNING_MESSAGE, interrupt: true });
  }
  if (!answer.cancelled && answer.value === ALLOW_SESSION && ask && Array.isArray(ask.permissions) && ask.permissions.length) {
    return reply({ behavior: 'allow', updatedInput: input, updatedPermissions: ask.permissions });
  }
  // "In this project" hands back only the local-settings allow rules the card offered, re-filtered here so an
  // ask that somehow carries more can never write a shared or user settings file (#674).
  const project = ask ? projectPermissions(ask.projectPermissions) : [];
  if (!answer.cancelled && answer.value === ALLOW_PROJECT && project.length) {
    return reply({ behavior: 'allow', updatedInput: input, updatedPermissions: project });
  }
  return !answer.cancelled && answer.value === ALLOW
    ? reply({ behavior: 'allow', updatedInput: input })
    : reply({ behavior: 'deny', message: REFUSED_MESSAGE });
}

// Which line answers a request of the core's: a `control_response` under the `request_id` it was sent with.
// A refusal carries `subtype: 'error'` and the CLI's sentence.
function responseOf(msg) {
  if (!msg || msg.type !== 'control_response' || !msg.response || typeof msg.response !== 'object') return null;
  const r = msg.response;
  if (r.request_id == null) return null;
  return r.subtype === 'success'
    ? { id: String(r.request_id), payload: { success: true, data: r.response || {} } }
    : { id: String(r.request_id), payload: { success: false, error: typeof r.error === 'string' && r.error ? r.error : 'refused' } };
}

// What an attach draws from the transcript file: the lines of this conversation that the stream sends as
// entries too — user and assistant turns, and a local command's output in the shape the stream gives it
// (point 6), not a subagent's, not the CLI's own bookkeeping (`isMeta`). The
// file holds more kinds of line (attachments, queue operations, titles), which the history viewer shows and
// a live conversation never sends; keeping them out is what makes a mounted view read like a live one.
function conversationEntries(lines) {
  const out = [];
  // Which kind each call was, for the task notices below (#691): the notification names the call, not the tool.
  const toolKinds = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const content = line && line.type === 'assistant' && line.message && Array.isArray(line.message.content) ? line.message.content : [];
    for (const b of content) if (b && b.type === 'tool_use' && b.id) toolKinds.set(b.id, kindOfTool(b.name));
  }
  for (const line of Array.isArray(lines) ? lines : []) {
    if (line && line.type === 'user' && !line.isSidechain && !line.isMeta && typeof line.uuid === 'string' && isTaskNotification(line)) {
      out.push(taskNoticeEntry(line, toolKinds));
      continue;
    }
    // A report is written with `isMeta: true`, so it is taken before the filter below drops that (#701).
    if (line && line.type === 'user' && !line.isSidechain && typeof line.uuid === 'string' && isPeerMessage(line)) {
      out.push(peerReportEntry(line));
      continue;
    }
    if (line && line.type === 'system' && line.subtype === 'local_command') {
      const entry = localCommandEntry(line);
      if (entry) out.push(entry);
      continue;
    }
    if (!line || (line.type !== 'user' && line.type !== 'assistant')) continue;
    if (line.isSidechain || line.isMeta || !line.message || typeof line.uuid !== 'string') continue;
    const shown = displayedLine(line);
    if (shown) out.push(shown);
  }
  return out;
}

// A local command's output as the transcript keeps it (a `system/local_command` line, point 6) turned into
// the entry the live stream sends for it: an assistant line from the `<synthetic>` model, same uuid, the
// output as its text. `null` for an output that is empty or a line without a uuid — nothing to draw, and
// nothing a key could match.
function localCommandEntry(line) {
  if (typeof line.uuid !== 'string' || !line.uuid || line.isSidechain || line.isMeta) return null;
  const content = typeof line.content === 'string' ? line.content : '';
  // A command typed while a turn ran is written as a system/local_command line of `<command-name>` markup
  // too (the queued `/model` case, see Claude's session-reader). It reads as what the user typed, the same
  // as the idle-prompt form, which is a user line.
  const typed = typedCommand(content);
  if (typed) {
    return {
      type: 'user',
      uuid: line.uuid,
      timestamp: typeof line.timestamp === 'string' ? line.timestamp : undefined,
      message: { role: 'user', content: typed },
    };
  }
  const text = localCommandOutput(content);
  if (!text) return null;
  return {
    type: 'assistant',
    uuid: line.uuid,
    timestamp: typeof line.timestamp === 'string' ? line.timestamp : undefined,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
  };
}

// The key the core stamps on an `append` and an attach answers for its snapshot: the line's uuid, which the
// stream and the transcript share (point 4 above).
//
// A task's notice is keyed by the TASK (#691), not by a line: the live one is built from a system line that has
// no uuid of its own, and the one read back from the transcript comes from the injected user line, whose uuid
// the live stream never saw. One key for both is what lets an attach keep a live notice the file has not
// caught up with yet, and not draw it twice once the file has.
const entryKey = (entry) => {
  if (entry && entry.type === 'task-notice' && entry._task && entry._task.id) return `task-notice:${entry._task.id}`;
  // A report is keyed by its sender and its text (#701), for the same reason: it is an injected line, and nothing
  // measured says the stream and the file give it the same uuid. One sender can write several messages, so the
  // sender alone would merge them; its text tells them apart and is the same on both paths.
  if (entry && entry.type === 'agent-report' && entry._report) {
    const r = entry._report;
    const hash = crypto.createHash('sha1').update(String(r.text || '')).digest('hex').slice(0, 16);
    return `agent-report:${r.subagentId || r.from || ''}:${hash}`;
  }
  return entry && typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : null;
};

module.exports = {
  createDecoder,
  responseOf,
  sendCommand,
  abortCommand,
  stopTaskCommand,
  contextCommand,
  contextFromResponse,
  setModeCommand,
  modeInfo,
  MODE_CYCLE,
  commandsCommand,
  commandsFromResponse,
  answerCommand,
  conversationEntries,
  entryKey,
  IMAGE_INPUT,
  ALLOW,
  ALLOW_SESSION,
  ALLOW_PROJECT,
  REFUSE,
  APPROVE_PLAN,
  KEEP_PLANNING,
};
