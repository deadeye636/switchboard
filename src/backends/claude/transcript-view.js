// backends/claude/transcript-view.js — Claude's transcript lines as the app's neutral entries (#705).
//
// Claude writes lines into the user's role that the user never typed: a background task's end, a subagent's
// report, a slash command's markup and what it printed. Two views draw a Claude conversation — the conversation
// view (claude-native, live and on an attach) and the message history viewer — and both have to read those
// lines the same way. The derivations live here, beside Claude's reader, because Claude's format is this
// folder's; claude-native's decoder imports them, and the history viewer gets them through the descriptor's
// `normalizeTranscriptEntries`, the hook Pi's `../pi/transcript-view.js` answers for Pi. What leaves this file
// is the app's own vocabulary (`task-notice`, `agent-report`, a user line with plain text), so the renderer
// reads no Claude markup.
'use strict';

const { typedCommand, localCommandOutput } = require('./session-reader');

// The text of a user line, when it is plain text: a string, or a single text block. Anything else (tool
// results, images, several blocks) is never command markup and is left alone.
function plainUserText(message) {
  if (!message || typeof message !== 'object') return null;
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length === 1 && c[0] && c[0].type === 'text' && typeof c[0].text === 'string') return c[0].text;
  return null;
}

// Which subagent an agent task is (#695). Measured on 2.1.283, for a background and a foreground agent alike:
// the `task_id` Claude gives a `local_agent` task IS the `agentId` its subagent transcript carries
// (`subagents/agent-<id>.jsonl`, and the same id in every line of it), so the task names its subagent row
// with no lookup. A shell or another task has none.
const subagentIdOf = (taskId, kind) => (kind === 'agent' && taskId ? taskId : null);

// Claude's tool names for the two kinds the app shows; anything else is a task of no known kind.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
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
// notification itself does not say. The output file's path stays out of the entry — the history viewer hands
// its entries straight to the renderer. A live conversation adds it through `taskOutputFileOf` below, and the
// core takes it off again before the view sees the entry (#725).
// The file a notification names for the task's output (`<output-file>`, measured on 2.1.276: an absolute path
// under Claude's temporary directory, ending `.output`), or '' when it names none.
function taskOutputFileOf(line) {
  return tagOf(plainUserText(line && line.message) || '', 'output-file');
}

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

// The answer to an `AskUserQuestion` call as the user's entry (#724). Claude keeps what was asked and what was
// chosen on the line that carries the call's result: `toolUseResult` in the transcript, `tool_use_result` on the
// stream, the same shape under the same uuid (measured on 2.1.289): `{ questions, answers: { <question>: <text> },
// annotations?: { <question>: { preview?, notes? } } }`, a multi-select answer being the labels joined with ", ".
// A declined question ("Chat about this", dismissed) has a string there and no answers, so it draws nothing.
// The entry is keyed on the line's uuid with a suffix, so the stream and an attach give it the same key and the
// tool result under the plain uuid keeps its own. It carries `prompt: true`: it is the user's own input, and the
// turn that follows answers it. `null` when the line holds no answered question.
function questionAnswerEntry(line) {
  const r = line && (line.toolUseResult || line.tool_use_result);
  if (!r || typeof r !== 'object' || !Array.isArray(r.questions) || !r.answers || typeof r.answers !== 'object') return null;
  if (typeof line.uuid !== 'string' || !line.uuid) return null;
  const annotations = r.annotations && typeof r.annotations === 'object' ? r.annotations : {};
  // A line break inside an answer or a note would end the list item it is in.
  const indented = (text, by) => text.trim().split(/\r?\n/).join(`\n${by}`);
  const items = [];
  for (const q of r.questions) {
    if (!q || typeof q.question !== 'string' || !q.question) continue;
    const answer = r.answers[q.question];
    if (typeof answer !== 'string' || !answer.trim()) continue;
    items.push(`- ${indented(q.question, '  ')} → ${indented(answer, '  ')}`);
    const a = annotations[q.question];
    const note = a && typeof a.notes === 'string' ? a.notes.trim() : '';
    if (note) items.push(`  - Note: ${indented(note, '    ')}`);
  }
  if (!items.length) return null;
  return {
    type: 'user',
    uuid: `${line.uuid}:answer`,
    timestamp: typeof line.timestamp === 'string' ? line.timestamp : new Date().toISOString(),
    message: { role: 'user', content: items.join('\n') },
    prompt: true,
  };
}

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

// A local command's output as the transcript keeps it (a `system/local_command` line, point 6 in claude-native's protocol header) turned into
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

// The message history viewer's reading of a Claude transcript (#705): the lines above become the entries the
// conversation view draws for them, and everything else stays as it was — the viewer shows the whole file,
// bookkeeping included, which the conversation view deliberately does not. A task notice from history has no
// running session to read its output from, so it is marked `historic` and the viewer offers no Output for it.
const EMPTY_ENTRY = (line) => ({
  type: 'user', uuid: line && line.uuid, timestamp: line && line.timestamp, message: { role: 'user', content: '' },
});

function normalizeTranscriptEntries(lines) {
  const list = Array.isArray(lines) ? lines : [];
  // Which kind each call was, for the notices (#691): the notification names the call, not the tool.
  const toolKinds = new Map();
  // Which call started each subagent, so a report's Open can fall back to it: the Agent call's result
  // carries `toolUseResult.agentId`, the id the report names as its `senderTaskId` (measured on 2.1.284).
  const agentCalls = new Map();
  for (const line of list) {
    const content = line && line.type === 'assistant' && line.message && Array.isArray(line.message.content) ? line.message.content : [];
    for (const b of content) if (b && b.type === 'tool_use' && b.id) toolKinds.set(b.id, kindOfTool(b.name));
    const agentId = line && line.type === 'user' && line.toolUseResult && typeof line.toolUseResult.agentId === 'string' ? line.toolUseResult.agentId : '';
    const blocks = line && line.message && Array.isArray(line.message.content) ? line.message.content : [];
    const result = agentId ? blocks.find(b => b && b.type === 'tool_result' && b.tool_use_id) : null;
    if (result) agentCalls.set(agentId, result.tool_use_id);
  }
  // `isSidechain` is not asked here, unlike in the conversation view: the viewer shows a whole file, and in a
  // subagent's own transcript every line carries it (#717) — skipping those would leave its notices raw.
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const line = list[i];
    if (line && line.type === 'user' && isPeerMessage(line)) {
      out.push(peerReportEntry(line, (id) => agentCalls.get(id)));
      continue;
    }
    if (line && line.type === 'user' && isTaskNotification(line)) {
      const entry = taskNoticeEntry(line, toolKinds);
      out.push({ ...entry, _task: { ...entry._task, historic: true } });
      continue;
    }
    // The caveat Claude writes before a local command's output, for the model ("the messages below were
    // generated by the user while running local commands…"): bookkeeping, `isMeta`, and not the user's words.
    // The conversation view leaves it out with every `isMeta` line; here it keeps its place, empty.
    // Before a `!` shell line the caveat stays as it is: the viewer folds caveat, `<bash-input>` and its output
    // into one entry, and an empty caveat left beside that group would shift every position after it by one
    // (measured: 2 of 213 caveats over one real store open such a group).
    if (line && line.type === 'user' && line.isMeta && /^\s*<local-command-caveat>/.test(plainUserText(line.message) || '')
      && !/<bash-input>/.test(plainUserText((list[i + 1] || {}).message) || '')) {
      out.push(EMPTY_ENTRY(line));
      continue;
    }
    // A local command's output as a `system/local_command` line — the form most of them take (measured: 202
    // of 225 over one real store) — reads as the conversation view reads it, its terminal codes gone (#714).
    if (line && line.type === 'system' && line.subtype === 'local_command') {
      out.push(localCommandEntry({ ...line, isSidechain: false }) || EMPTY_ENTRY(line));
      continue;
    }
    // One entry out for every line in: the viewer keys its bookmarks on the entry's position, so a line that
    // says nothing (a local command that printed nothing) stays as an empty entry, which draws nothing.
    const shown = displayedLine(line);
    out.push(shown || EMPTY_ENTRY(line));
  }
  return out;
}

module.exports = {
  plainUserText,
  subagentIdOf,
  kindOfTool,
  isTaskNotification,
  taskNoticeEntry,
  taskOutputFileOf,
  isPeerMessage,
  peerReportEntry,
  questionAnswerEntry,
  displayedLine,
  localCommandEntry,
  normalizeTranscriptEntries,
};
