// backends/hook-events.js — WHEN a user's own command may be run, in words no CLI owns (#635).
//
// The same shape as `./tool-vocabulary.js`, one concept along. A CLI that lets a user attach a command to
// its own lifecycle names that lifecycle in its own words (Claude: `SessionStart`, `PostToolUse`, `Stop`),
// and a CLI that would run those commands has different words for the same moments (Pi: `session_start`,
// `tool_result`, `agent_settled`). A table from one set to the other would put a second backend's names in
// the first one's folder, which is the violation CLAUDE.md reflex 5 names. So the mapping meets here:
//
//   - a SOURCE maps its own event names onto these words (`hookDialect.eventWords` in `sharedResources`);
//   - a TARGET declares which of its own events is each word (Pi: `EVENT_FOR_WORD` in
//     `./pi/hooks-section.js`).
//
// A word neither side can answer is a moment that cannot be carried across, and the hook is not taken over
// — said with that reason rather than attached to the nearest moment instead. A hook that fires at almost
// the right time is worse than one that does not fire, because nothing on screen says it was the wrong
// moment.
//
// WHY THESE THREE AND NOT MORE. They are the ones both sides were MEASURED to have, and each is a moment
// that only REPORTS. Nothing here can block, refuse or rewrite: a hook that answers back is a permission
// surface, the approval gate is already that surface, and a second one is the second way to do one thing
// (#635, owner decision H3). Adding a word is a change to every backend declaring either half, and
// `test/hook-events.test.js` checks that no declaration names a word missing from this list.
'use strict';

const HOOK_EVENT_WORDS = Object.freeze([
  // The session has been opened and is ready for a first message.
  'session-start',
  // A tool call has finished. This is the moment that carries the most: what the tool was, what it was
  // given and what it answered — which is why the target's event has to be the one with the INPUT on it
  // and not merely the one at the end of the execution.
  'tool-finished',
  // The agent has stopped working and is waiting for the user again. Not "the turn ended": a turn can be
  // followed by a retry, a compaction or a queued continuation, and the moment a person means by "it is
  // done" is the one after all of those.
  'agent-idle',
]);

const WORDS = new Set(HOOK_EVENT_WORDS);
const isHookEventWord = (word) => typeof word === 'string' && WORDS.has(word);

module.exports = { HOOK_EVENT_WORDS, isHookEventWord };
