'use strict';
// Message History may need backend-specific parsing, but the renderer/core must not learn backend ids.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const VIEWER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'jsonl', 'jsonl-viewer.js'), 'utf8');
const VIEWER_CODE = VIEWER.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('read-session-jsonl applies an optional backend transcript normalizer', () => {
  assert.match(MAIN, /function normalizeTranscriptResult\(backend, result\)/,
    'the seam is named at the read-session-jsonl boundary');
  assert.match(MAIN, /typeof backend\.normalizeTranscriptEntries !== 'function'/,
    'the hook is optional, so existing backends keep their raw entries');
  assert.match(MAIN, /backend\.normalizeTranscriptEntries\(result\.entries\)/,
    'a declaring backend can map raw transcript entries before the renderer sees them');
  assert.match(MAIN, /normalizeTranscriptResult\(b, await readJsonlEntries\(row\.filePath\)\)/,
    'file-mode backends use the same hook');
  assert.match(MAIN, /normalizeTranscriptResult\(b, \{ entries: b\.readMessages\(sessionId\) \|\| \[\] \}\)/,
    'export-mode backends use the same hook if they ever need it');
});

test('the renderer consumes neutral transcript-meta entries, not backend-specific roles', () => {
  assert.match(VIEWER, /entry\.type === 'transcript-meta'/,
    'backend adapters can expose metadata without adding renderer backend branches');
  assert.doesNotMatch(VIEWER_CODE, /toolCall|bashExecution|branch_summary|custom_message|session_info/,
    'Pi vocabulary stays in the Pi adapter, not the renderer');
});
