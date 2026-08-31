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

// How much of the transcript's end to read. The queue moves at conversation speed — a handful of lines
// per prompt — so everything currently open is within a few kilobytes of the end. A transcript runs to
// megabytes and this is read at a turn boundary, so the whole file is never the right answer.
//
// Reading only the tail cannot under-report: an `enqueue` whose removal is out of frame is impossible
// (the removal always comes later), and a removal whose `enqueue` is out of frame is a pair that is
// already closed — which is what the clamp at zero below absorbs.
const QUEUE_TAIL_BYTES = 128 * 1024;

// Is this entry a TURN, as opposed to the machinery inside one? A tool result is written as a `user`
// entry, and treating that as "the user said something" would report a turn start on every tool call.
// A subagent's line is not this session's turn either.
function isTurnEntry(entry) {
  if (!entry || entry.isSidechain) return false;
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
  try { text = readFileTail(transcriptPath, size, QUEUE_TAIL_BYTES).text; } catch { return null; }

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
      // `dequeue` and `remove` each take one. The clamp is what makes a tail read safe: a removal whose
      // enqueue fell outside the window would otherwise drive the count negative and hide a real one.
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
