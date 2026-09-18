// backends/tool-vocabulary.js — what an agent's tools DO, in words no CLI owns (#639).
//
// An agent definition written for one CLI names that CLI's tools (`Read`, `Glob`, `Bash`), and a CLI that
// runs the agent knows only its own (`read`, `find`, `bash`). A table from one set of names to the other
// would put a second backend's names into the first one's folder, which is the violation CLAUDE.md reflex 5
// names. So the mapping has two halves that meet here:
//
//   - a SOURCE maps its tool names onto these words (`agentDialect.toolWords` in its `sharedResources`);
//   - a TARGET declares which of its own tools does each word (Pi: `TOOL_FOR_WORD` in
//     `./pi/subagent-tool.js`).
//
// The words are named after what a tool does, not after any CLI: where two CLIs name one tool
// differently, neither name is used. A word no target declares is a tool that target cannot give an agent, and it is
// dropped with that reason rather than widened into something else.
//
// A word is added here only when a source and a target both have such a tool. Adding one is a change to
// every backend that declares either half, and `test/tool-vocabulary.test.js` checks that no declaration
// names a word missing from this list.
'use strict';

const TOOL_WORDS = Object.freeze([
  'read',          // read one file
  'write',         // write a whole file
  'edit',          // change part of a file
  'search-text',   // search file contents
  'find-files',    // find files by name or pattern
  'list-dir',      // list a directory
  'shell',         // run a shell command
]);

function isToolWord(word) {
  return typeof word === 'string' && TOOL_WORDS.includes(word);
}

module.exports = { TOOL_WORDS, isToolWord };
