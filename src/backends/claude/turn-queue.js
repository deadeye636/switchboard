// backends/claude/turn-queue.js — "does this CLI still owe a turn?" (#495).
//
// WHY THIS EXISTS. Claude fires `UserPromptSubmit` when a prompt is ENQUEUED, not when it is sent. Type
// while the agent is working and the hook arrives at once — Switchboard marks the session busy, the
// prompt waits its turn, and everything lines up. But if the agent finishes BEFORE the queue is drained,
// the order becomes the one measured on a real session:
//
//   19:19:54.369  enqueue                → UserPromptSubmit → busy
//   19:20:35.093  Stop (the OLD turn)    → ready            ← wins, 72 ms too early
//   19:20:35.131  dequeue                → no hook fires
//   19:20:35.165  the queued prompt runs, and announces nothing
//
// The session then worked for another fifteen minutes while its row said "Ready". No later hook could
// heal it: the only event that would have announced that turn had already fired 41 seconds earlier and
// been overwritten by the `Stop` of the turn before it.
//
// SO THE TRANSCRIPT IS ASKED INSTEAD. Claude records the queue in the transcript, one line per movement,
// and it is exactly regular enough to count — measured over 116 transcripts carrying 1625 enqueues:
//
//   {"type":"queue-operation","operation":"enqueue","sessionId":"…","content":"<the prompt>"}
//   {"type":"queue-operation","operation":"remove","sessionId":"…","content":"<the prompt>"}   consumed
//   {"type":"queue-operation","operation":"dequeue","sessionId":"…"}                           flushed
//   {"type":"queue-operation","operation":"popAll","sessionId":"…"}                            emptied
//
// Every `enqueue` is followed by exactly one of the other three (1625 against 1617, the difference being
// prompts still queued when the file was read). So the depth is countable, and a `Stop` that arrives with
// a depth above zero is a `Stop` with another turn behind it.
//
// The second question this answers is what releases a held `Stop`. A queue can also be emptied WITHOUT
// running — the user changes their mind — and no further hook would ever arrive to say so. `turnStarted`
// is the evidence that the queued prompt actually ran: an entry newer than the `Stop` that is a turn
// rather than a tool result.
'use strict';

const fs = require('fs');

const { readFileTail } = require('../file-store');

// How much of the transcript's end to read before giving up on the shortcut. Most transcripts fit in
// this whole, and then the answer is exact for free.
//
// A TAIL ALONE CANNOT ANSWER THIS QUESTION, and the first draft of this file claimed it could. The depth
// is enqueues minus closures over the WHOLE history, and a window can cut that history in two places
// that both mislead: an `enqueue` that is still open can be pushed out of view by the very turn that is
// still running — measured over 1570 real enqueue/closure pairs, 7 of them are more than 128 KB apart
// and the widest is 985 KB — and, because the queue is FIFO, a closure seen in the window takes the
// OLDEST queued prompt rather than the one whose enqueue is beside it. Either way a prompt that is
// genuinely still queued reads as none, no hold is taken, and the bug this file exists to close is back
// with no safety net behind it. So a partial read is not trusted: the file is counted in full.
const QUEUE_TAIL_BYTES = 128 * 1024;

// Is this entry a TURN, as opposed to the machinery inside one?
//
// Three things wear `type: 'user'` and are not the user starting a turn. A tool result is one, and
// reading those as a turn would report one on every tool call. A subagent's line belongs to its own
// transcript's conversation, not to this one. And an INJECTED entry — a skill's body, a system reminder —
// is written as a user message with an ordinary text block: 452 of them in the store this was measured
// against, each of which would have counted as a turn starting. That one matters more than it looks: a
// false `turnStarted` releases a held signal WITHOUT delivering it, betting on a turn that never began,
// and the timeout that would otherwise have rescued the session is gone with the hold.
function isTurnEntry(entry) {
  if (!entry || entry.isSidechain || entry.isMeta) return false;
  if (entry.type === 'assistant') return true;
  if (entry.type !== 'user') return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.some(block => block && block.type !== 'tool_result');
}

/**
 * `{ queued, turnStarted }` for one transcript, or null when it cannot be read.
 *
 * @param {string} transcriptPath  the session's own .jsonl
 * @param {number} sinceMs         epoch ms; `turnStarted` answers about entries NEWER than this. Zero
 *                                 (the default) asks nothing and always answers false.
 */
function readTurnQueue(transcriptPath, sinceMs = 0) {
  if (!transcriptPath) return null;
  let size;
  try { size = fs.statSync(transcriptPath).size; } catch { return null; }

  let text;
  try {
    const tail = readFileTail(transcriptPath, size, QUEUE_TAIL_BYTES);
    // A partial view can only under-report the depth (see QUEUE_TAIL_BYTES), and under-reporting is the
    // one error that costs the whole feature. This runs at a turn boundary, not on a timer, so paying
    // for the file when it does not fit is the right trade.
    text = tail.partial ? fs.readFileSync(transcriptPath, 'utf8') : tail.text;
  } catch { return null; }

  let queued = 0;
  let turnStarted = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch { continue; }                        // a half-written trailing line — the CLI is mid-append

    if (entry.type === 'queue-operation') {
      if (entry.operation === 'enqueue') queued++;
      else if (entry.operation === 'popAll') queued = 0;
      // `dequeue` and `remove` each take one. The clamp costs nothing over a full count and keeps a
      // truncated or rotated file from driving the total negative, which would hide a real enqueue.
      else queued = Math.max(0, queued - 1);
      continue;
    }

    if (turnStarted || !sinceMs) continue;
    const at = Date.parse(entry.timestamp || '');
    if (Number.isFinite(at) && at > sinceMs && isTurnEntry(entry)) turnStarted = true;
  }

  return { queued, turnStarted };
}

module.exports = { readTurnQueue, isTurnEntry, QUEUE_TAIL_BYTES };
