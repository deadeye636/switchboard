// Pi live binding through a per-spawn extension.
//
// Pi owns its session id and can switch it in-place (/new, /resume, /fork). The core already has a
// backend-neutral terminal binding URL for "terminal <tag> is now on session <id>" (#303); this adapter
// writes a tiny Pi extension that posts that fact on session lifecycle events. Pi-specific event names and
// ctx.sessionManager access stay here, under the backend descriptor.
//
// **Waiting is not working** (#529). Pi 0.84.4 added `ui_prompt_start` / `ui_prompt_end`, which separate
// active agent work from time spent blocked on a `ctx.ui` prompt. Without them the two are one state and
// a session sat on "Working" while it was actually holding a question nobody had seen — the row said the
// agent was busy, and the inbox said nothing at all.
//
// **A Pi TURN is one model round, not one piece of work** (#573). This posted `idle` on `turn_end`, which
// reads a turn as everything done for one user prompt. It is not: `turn_start` / `turn_end` bracket ONE
// LLM response plus its tool calls, and Pi's own lifecycle diagram loops them "while LLM calls tools", so
// a prompt that makes the agent call ten tools ended ten turns while it was still working. Pi says which
// event a host is meant to read, in the same document: "Use `agent_settled` for status integrations that
// need to know Pi will not continue running automatically." So this posts `busy` on `turn_start` and
// `idle` on `agent_settled` alone — `turn_end` is not an edge anyone outside Pi can use.
//
// Verified in Pi 0.84.4's own `dist/core/agent-session.js` rather than assumed, because the whole busy
// state now hangs off one event: `_emitAgentSettled()` is called from the `finally` of `_runAgentPrompt`,
// so an aborted run, a failed one and a completed one all reach it, and it is the only thing that clears
// `_isAgentRunActive` (which is what `ctx.isIdle()` reports). `agent_settled` also long predates the
// `ui_prompt_*` events this template already requires, so nothing that can load this extension lacks it.
//
// What the old `turn_end` idle bought, since a fix has to say what it takes away: it was an accidental
// second chance at the busy latch. If a post is dropped — the fetch fails, the extension is unloaded
// mid-run — the row now stays "Working" until something else clears it. Two things still do, so this is
// not a one-signal state: `pi/state.js` derives busy/idle from the transcript tail on every watcher flush
// and reports an edge from there, and the PTY exiting drops the session's state outright.
//
// **`ui_prompt_end` answers with whichever state the prompt interrupted**, which is why the template
// carries an `inRun` flag — and it tracks the RUN, not the round, or a prompt answered between two model
// rounds would post the `idle` this issue removes. Answering a prompt raised inside a run returns the
// agent to work, and that run's own `agent_settled` still ends it. But an extension may prompt from a
// slash command or from its own `turn_end` handler, and there `busy` would be the last word anyone says
// about the session: no run follows to correct it, and nothing else in the app clears a busy edge that a
// backend stated exactly. The row would read "Working" until the next real turn.
//
// The prompt's TITLE is deliberately not sent. It is arbitrary text from whatever the agent happens to be
// running, and it would be rendered in the attention inbox; the prompt KIND is a closed set
// (select / confirm / input / editor / custom) and says enough to word the reason. The wording itself is
// `shared/attention-source.js`, with every other source's.
//
// **KNOW WHAT THIS COVERS, measured in Pi 0.84.4's own bundle.** The events are emitted by `withUIPrompt`,
// which wraps only the UI context handed to EXTENSIONS — `ctx.ui.select/confirm/input/editor/custom`. Pi's
// own dialogs do not go through it, so a tool-permission prompt or a model picker raises nothing here.
// What this reports is a session blocked on a prompt some extension opened, which is a real state and
// costs two lines to report, but it is not "any Pi session waiting for you". Do not read a quiet inbox as
// proof the binding is broken, and do not extend this by guessing at Pi's internal dialogs: the only
// honest widening is an event Pi emits for them.
//
// Also measured: in `--print` mode the whole UI context is a no-op stub, `confirm` returns immediately and
// no event is emitted at all. These fire in the interactive TUI, which is the mode Switchboard spawns.
//
// **`pending` rides along on every post** (#530). `ctx.hasPendingMessages()` is the only reachable answer
// to "does this session still owe a turn" — the `clear_queue` RPC the issue named lives in a headless mode
// Switchboard does not run, and consumes the queue it reports. `backends/pi/turn-queue.js` is what
// remembers it and what a null answer means.
//
// The `typeof` guard covers a Pi too old to have the method, where `undefined` drops out of the JSON and
// nothing is claimed. It does NOT cover the other shape, and this is worth knowing rather than assuming:
// in Pi's own runner the default is `hasPendingMessagesFn = () => false`, so a version that HAS the method
// but no bound core answers a flat `false` — a claim that nothing is queued. That is the safe direction
// (no hold, today's behaviour) but it is not the guard doing the work.
//
// **Everything the context is asked for sits inside the try.** Both `sessionManager` and
// `hasPendingMessages` go through `assertActive()`, which throws "stale after session replacement" — the
// `/new` `/resume` `/fork` case #303 exists for — and optional chaining does not save a caller from a
// getter that throws. A binding post is best-effort; it must never take a handler down with it.
'use strict';

const fs = require('fs');
const path = require('path');

function jsString(value) {
  return JSON.stringify(String(value || ''));
}

function writeBindingExtension({ dir, tag, sessionUrl, log } = {}) {
  if (!dir || !tag || !sessionUrl) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pi-live-${tag}.ts`);
  const source = `// Generated by Switchboard for one Pi spawn. Safe to delete.\n` +
`import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";\n\n` +
`const URL = ${jsString(sessionUrl)};\n\n` +
`async function post(ctx: any, kind?: \"busy\" | \"idle\" | \"waiting\", promptKind?: string, turnStart?: boolean) {\n` +
`  try {\n` +
`    const id = ctx?.sessionManager?.getSessionId?.();\n` +
`    if (!id) return;\n` +
`    const pending = typeof ctx?.hasPendingMessages === \"function\" ? ctx.hasPendingMessages() : undefined;\n` +
`    await fetch(URL, {\n` +
`      method: \"POST\",\n` +
`      headers: { \"content-type\": \"application/json\" },\n` +
`      body: JSON.stringify({ session_id: id, kind, prompt_kind: promptKind, pending, turn_start: turnStart }),\n` +
`    });\n` +
`  } catch {}\n` +
`}\n\n` +
`export default function(pi: ExtensionAPI) {\n` +
`  let inRun = false;\n` +
`  pi.on(\"session_start\", async (_event, ctx) => { inRun = false; await post(ctx); });\n` +
`  pi.on(\"turn_start\", async (_event, ctx) => { inRun = true; await post(ctx, \"busy\", undefined, true); });\n` +
`  pi.on(\"ui_prompt_start\", async (event: any, ctx) => { await post(ctx, \"waiting\", event?.kind); });\n` +
`  pi.on(\"ui_prompt_end\", async (_event, ctx) => { await post(ctx, inRun ? \"busy\" : \"idle\"); });\n` +
`  pi.on(\"agent_settled\", async (_event, ctx) => { inRun = false; await post(ctx, \"idle\"); });\n` +
`  pi.on(\"session_info_changed\", async (_event, ctx) => { await post(ctx); });\n` +
`}\n`;
  fs.writeFileSync(file, source, 'utf8');
  if (log && typeof log.debug === 'function') log.debug(`[pi-live-bind] wrote ${file}`);
  return { args: ['--extension', file], cleanup: file };
}

function removeBindingExtension(file, log) {
  if (!file) return;
  try { fs.rmSync(file, { force: true }); }
  catch (err) { if (log && typeof log.warn === 'function') log.warn(`[pi-live-bind] cleanup failed: ${err.message}`); }
}

module.exports = { writeBindingExtension, removeBindingExtension };
