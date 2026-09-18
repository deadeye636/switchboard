// backends/pi/transcript-view.js — Pi JSONL -> backend-neutral Message History entries.
//
// The renderer understands a small Claude/Codex-shaped surface: messages with text/tool_use/tool_result,
// custom-title entries, local command blocks, and generic transcript-meta rows. Pi's on-disk format is a
// richer tree of AgentMessage entries, so the descriptor normalises it here instead of teaching the core
// or renderer what a Pi role is.
'use strict';

const { TRANSPORT_MARKER_TYPE } = require('./transport-marker');

function activeEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const header = list.find(e => e && e.type === 'session') || null;
  const body = list.filter(e => e && e.type !== 'session');
  const byId = new Map();
  let leaf = null;
  for (const entry of body) {
    if (!entry || typeof entry !== 'object' || !entry.id) continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
  if (!leaf) return header ? [header, ...body] : body.slice();

  const path = [];
  const seen = new Set();
  for (let cur = leaf; cur && cur.id && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : null) {
    seen.add(cur.id);
    path.push(cur);
  }
  path.reverse();
  return header ? [header, ...path] : path;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.thinking === 'string') return block.thinking;
    if (block.type === 'image') return '[Image]';
    return '';
  }).filter(Boolean).join('\n');
}

// Pi's built-in tools, in the vocabulary the viewer has renderers for (#568, step C): a command as a
// command block, an edit as a diff, a write with its content. The viewer's names happen to be the ones
// another CLI uses; what matters is that the answer is given HERE, in Pi's folder, from Pi's own argument
// shapes (measured in Pi 0.84.4's tool schemas) — the renderer learns no Pi tool. A tool this does not know
// keeps its own name and arguments and is drawn as generic JSON, which is what every tool got before.
const EDIT_SEPARATOR = '…';
// Pi accepts an edit's replacements in more than one shape and normalises them before it runs the tool
// (`prepareEditArguments` in Pi 0.84.4's edit tool): a JSON STRING some models send instead of an array, a
// single object instead of a one-element array, and the legacy top-level `oldText`/`newText`. The transcript
// keeps what the model sent, so the same normalisation happens here — an approval card for an edit is
// exactly where a missing diff hurts.
function editList(a) {
  let edits = a.edits;
  if (typeof edits === 'string') { try { edits = JSON.parse(edits); } catch { edits = null; } }
  const one = (e) => e && typeof e === 'object' && typeof e.oldText === 'string' && typeof e.newText === 'string';
  if (one(edits)) edits = [edits];
  const list = Array.isArray(edits) ? edits.slice() : [];
  if (typeof a.oldText === 'string' && typeof a.newText === 'string') list.push({ oldText: a.oldText, newText: a.newText });
  return list;
}

const PI_TOOLS = {
  bash: (a) => ({ name: 'Bash', input: { command: a.command || '', timeout: a.timeout } }),
  // Pi's Windows shell takes the same arguments as its bash tool.
  powershell: (a) => ({ name: 'Bash', input: { command: a.command || '', timeout: a.timeout } }),
  read: (a) => ({ name: 'Read', input: { file_path: a.path || '', offset: a.offset, limit: a.limit } }),
  write: (a) => ({ name: 'Write', input: { file_path: a.path || '', content: typeof a.content === 'string' ? a.content : '' } }),
  // One call may carry several replacements; they are drawn as one diff with a marker line between them.
  edit: (a) => {
    const edits = editList(a);
    if (!edits.length) return null;
    return {
      name: 'Edit',
      input: {
        file_path: a.path || '',
        old_string: edits.map(e => String((e && e.oldText) || '')).join(`\n${EDIT_SEPARATOR}\n`),
        new_string: edits.map(e => String((e && e.newText) || '')).join(`\n${EDIT_SEPARATOR}\n`),
      },
    };
  },
  grep: (a) => ({ name: 'Grep', input: { pattern: a.pattern || '', path: a.path || '' } }),
  find: (a) => ({ name: 'Glob', input: { pattern: a.pattern || '', path: a.path || '' } }),
};

function toolUse(block) {
  const args = block.arguments && typeof block.arguments === 'object' ? block.arguments : {};
  const mapped = !args._partial && PI_TOOLS[block.name] ? PI_TOOLS[block.name](args) : null;
  // An optional argument Pi did not send stays absent rather than arriving as `undefined`.
  if (mapped) for (const k of Object.keys(mapped.input)) if (mapped.input[k] === undefined) delete mapped.input[k];
  return {
    type: 'tool_use',
    id: block.id,
    name: mapped ? mapped.name : (block.name || 'unknown'),
    input: mapped ? mapped.input : args,
  };
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'toolCall') return toolUse(block);
    if (block.type === 'image' && block.data) {
      return { type: 'image', source: { data: block.data, media_type: block.mimeType || 'image/png' } };
    }
    return block;
  }).filter(Boolean);
}

function messageEntry(entry, role, content) {
  return {
    ...entry,
    type: 'message',
    message: {
      role,
      content,
    },
  };
}

function metaEntry(entry, label, content, detail) {
  return {
    type: 'transcript-meta',
    timestamp: entry && entry.timestamp,
    icon: 'i',
    label,
    detail: detail || '',
    content: content || '',
  };
}

function normalizeMessage(entry) {
  const m = entry && entry.message;
  if (!m || typeof m !== 'object') return null;
  switch (m.role) {
    case 'user':
    case 'assistant':
      return messageEntry(entry, m.role, contentBlocks(m.content));
    case 'toolResult':
      return messageEntry(entry, 'user', [{
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: contentBlocks(m.content),
        is_error: !!m.isError,
      }]);
    case 'bashExecution': {
      const status = m.cancelled ? 'cancelled' : (m.exitCode == null ? '' : `exit ${m.exitCode}`);
      const output = [m.output || '', status ? `[${status}]` : '', m.truncated ? '[truncated]' : '']
        .filter(Boolean).join('\n');
      return { type: 'local-command', timestamp: entry.timestamp, _localCmd: { cmd: m.command || '', output } };
    }
    case 'custom':
      if (m.display === false) return null;
      return metaEntry(entry, `Extension message${m.customType ? `: ${m.customType}` : ''}`, textFromContent(m.content));
    case 'branchSummary':
      return metaEntry(entry, 'Branch summary', m.summary || '', m.fromId ? `from ${m.fromId}` : '');
    case 'compactionSummary':
      return metaEntry(entry, 'Compaction summary', m.summary || '', m.tokensBefore ? `${m.tokensBefore} tokens before` : '');
    default:
      return metaEntry(entry, `Message: ${m.role || 'unknown'}`, textFromContent(m.content));
  }
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  switch (entry.type) {
    case 'session':
      return null;
    case 'message':
      return normalizeMessage(entry);
    case 'session_info':
      return { type: 'custom-title', timestamp: entry.timestamp, customTitle: entry.name || '' };
    case 'compaction': {
      const out = [metaEntry(entry, 'Compaction', entry.summary || '', entry.tokensBefore ? `${entry.tokensBefore} tokens before` : '')];
      if (Array.isArray(entry.retainedTail)) {
        for (const message of entry.retainedTail) {
          const normalized = normalizeMessage({ ...entry, type: 'message', message });
          if (normalized) out.push(normalized);
        }
      }
      return out;
    }
    case 'branch_summary':
      return metaEntry(entry, 'Branch summary', entry.summary || '', entry.fromId ? `from ${entry.fromId}` : '');
    case 'custom_message':
      if (entry.display === false) return null;
      return metaEntry(entry, `Extension message${entry.customType ? `: ${entry.customType}` : ''}`, textFromContent(entry.content));
    case 'custom':
      // The runtime-driven backend's marker (#568) is bookkeeping for the index, not something that
      // happened in the conversation — and it would appear once in every session that backend ran.
      if (entry.customType === TRANSPORT_MARKER_TYPE) return null;
      return metaEntry(entry, `Extension data${entry.customType ? `: ${entry.customType}` : ''}`, JSON.stringify(entry.data || {}, null, 2));
    case 'label':
      return metaEntry(entry, 'Label', entry.label || 'cleared', entry.targetId ? `on ${entry.targetId}` : '');
    case 'model_change':
      return metaEntry(entry, 'Model changed', [entry.provider, entry.modelId].filter(Boolean).join('/'));
    case 'thinking_level_change':
      return metaEntry(entry, 'Thinking level changed', entry.thinkingLevel || '');
    default:
      return entry;
  }
}

function normalizeTranscriptEntries(entries) {
  const out = [];
  for (const entry of activeEntries(entries)) {
    const normalized = normalizeEntry(entry);
    if (Array.isArray(normalized)) out.push(...normalized.filter(Boolean));
    else if (normalized) out.push(normalized);
  }
  return out;
}

module.exports = {
  normalizeTranscriptEntries,
  activeEntries,
};
