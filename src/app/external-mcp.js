// external-mcp.js — the per-project list of MCP servers a project's launched sessions get (#789, spec 36).
//
// Electron-free and db-free: the reader takes `getSetting` as an argument, the validator takes a value.
// It does NOT expand `${VAR}` (the source does, against the session's environment) and starts nothing.
//
// The key lives on the project blob `project:<settingsOwnerPath>` and is NOT a SETTING_DEFAULTS key, so it
// does not cascade; a worktree reads its project's list. It is also dropped on settings import
// (`settings-transfer.js`, IMPORT_DROPPED_KEYS): a stdio entry is a command run at launch.
'use strict';

const { settingsOwnerPath } = require('../shared/worktree-path');
const { validateExternalMcpServers } = require('../shared/external-mcp-validate');

const SETTING_KEY = 'externalMcpServers';

/**
 * Read a project's list through the settings owner (a worktree reads its project's blob). `getSetting` is the
 * db's `getSetting(key)`, passed in so this module touches no database.
 */
function readExternalMcpServers(getSetting, projectPath) {
  const owner = projectPath ? settingsOwnerPath(projectPath) : '';
  if (!owner) return validateExternalMcpServers(undefined);
  const blob = getSetting('project:' + owner);
  return validateExternalMcpServers(blob && typeof blob === 'object' && !Array.isArray(blob) ? blob[SETTING_KEY] : undefined);
}

module.exports = { SETTING_KEY, validateExternalMcpServers, readExternalMcpServers };
