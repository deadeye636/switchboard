// backends/agy/resources.js — read-only discovery of Antigravity CLI resources.
//
// agy keeps account credentials, logs, crash reports and binary conversation stores next to user-facing
// configuration. Surface only safe settings/instruction/resource directories; never auth, logs, history,
// conversations, cache, tmp, scratch or crash data.
'use strict';

const fs = require('fs');
const path = require('path');

const { createExpandResource } = require('../resource-expand');

// One level into each listed directory (#440), keyed by the `source` its listing entry carries.
const EXPAND_RULES = {
  'builtin-resources': { mode: 'flatFiles', kind: 'resource', keepExtension: true },
  'implicit-resources': { mode: 'flatFiles', kind: 'resource', keepExtension: true },
  'knowledge-directory': { mode: 'flatFiles', kind: 'memory-store', exts: ['.md'] },
  'plugins-directory': { mode: 'dirs', kind: 'plugin' },
  'project-gemini-directory': { mode: 'flatFiles', kind: 'settings', keepExtension: true },
};

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function add(out, item) {
  if (!item || !item.path) return;
  out.push({
    kind: item.kind,
    scope: item.scope || 'global',
    name: item.name || path.basename(item.path),
    path: item.path,
    source: item.source || null,
    description: item.description || null,
  });
}

function addFile(out, base, rel, kind, source, scope = 'global') {
  const p = path.join(base, rel);
  if (isFile(p)) add(out, { kind, scope, name: path.basename(p), path: p, source });
}

function addDir(out, base, rel, kind, source, scope = 'global') {
  const p = path.join(base, rel);
  if (isDir(p)) add(out, { kind, scope, name: path.basename(p), path: p, source });
}

function createListResources({ conversationsRoot }) {
  return function listResources({ projectPath } = {}) {
    const conversations = conversationsRoot();
    const agyHome = path.dirname(conversations);
    const geminiHome = path.dirname(agyHome);
    const resources = [];

    // Shared Gemini/Antigravity user configuration that is not credential material.
    addFile(resources, geminiHome, 'GEMINI.md', 'memory', 'global-instructions');
    addFile(resources, geminiHome, 'settings.json', 'settings', 'gemini-settings');

    // agy's own configuration and user-facing resource directories. Deliberately not included:
    // conversations/, conversation_summaries.db, history.jsonl, log/, crashes/, cache/, tmp/, scratch/,
    // google_accounts.json, oauth_creds.json, state.json or trustedFolders.json.
    addFile(resources, agyHome, 'settings.json', 'settings', 'agy-settings');
    addDir(resources, agyHome, 'builtin', 'resource', 'builtin-resources');
    addDir(resources, agyHome, 'implicit', 'resource', 'implicit-resources');
    addDir(resources, agyHome, 'knowledge', 'memory-store', 'knowledge-directory');
    addDir(resources, agyHome, 'plugins', 'plugin', 'plugins-directory');

    if (projectPath) {
      addFile(resources, projectPath, 'GEMINI.md', 'memory', 'project-instructions', 'project');
      addDir(resources, projectPath, '.gemini', 'settings', 'project-gemini-directory', 'project');
    }

    const seen = new Set();
    return {
      ok: true,
      resources: resources.filter(r => {
        const key = [r.scope, r.kind, r.path, r.source || ''].join('\0');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  };
}

const expandResource = createExpandResource(EXPAND_RULES);

module.exports = { createListResources, expandResource, EXPAND_RULES };
