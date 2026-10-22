// backends/claude/mcp-prune.js — tells a terminal Claude session to see ONLY the MCP servers Switchboard gives it
// (spec 36, plan 789 T4).
//
// One JSON file is already passed by ./mcp-inject.js through `--mcp-config`. `--strict-mcp-config` makes Claude
// load ONLY that file and drop every server it would otherwise load itself: the user's own servers, a project
// `.mcp.json`, plugin servers and claude.ai connectors. It is passed only when the project opts in
// (`externalMcpPrune`); the injection file never passes it.
//
// A prune is launch arguments alone: no file is written, so there is no release half.
'use strict';

function buildMcpPrune() {
  return { args: ['--strict-mcp-config'], env: null };
}

module.exports = { buildMcpPrune };
