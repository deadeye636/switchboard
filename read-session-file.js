const path = require('path');
const fs = require('fs');

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content?.text === 'string') return content.text;
  return '';
}

function countWords(text) {
  const matches = String(text || '').trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function addUsageTotals(totals, usage) {
  if (!usage || typeof usage !== 'object') return;
  totals.inputTokens += Number(usage.input_tokens || usage.inputTokens || 0);
  totals.outputTokens += Number(usage.output_tokens || usage.outputTokens || 0);
  totals.cacheCreationTokens += Number(usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || usage.cacheCreationTokens || 0);
  totals.cacheReadTokens += Number(usage.cache_read_input_tokens || usage.cacheReadInputTokens || usage.cacheReadTokens || 0);
}

/** Parse a single .jsonl file into a session object (or null if invalid) */
function readSessionFile(filePath, folder, projectPath) {
  const sessionId = path.basename(filePath, '.jsonl');
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    let userMessageCount = 0;
    let largestUserPromptWords = 0;
    let startedAt = null;
    let lastEntryAt = null;
    const usageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        const timestamp = new Date(entry.timestamp);
        if (!Number.isNaN(timestamp.getTime())) {
          const iso = timestamp.toISOString();
          if (!startedAt || timestamp < new Date(startedAt)) startedAt = iso;
          if (!lastEntryAt || timestamp > new Date(lastEntryAt)) lastEntryAt = iso;
        }
      }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      addUsageTotals(usageTotals, entry.usage);
      addUsageTotals(usageTotals, entry.message?.usage);
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg : contentToText(msg?.content);
      if (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user')) {
        userMessageCount++;
        largestUserPromptWords = Math.max(largestUserPromptWords, countWords(text));
      }
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        // Skip local command messages (! prefix) — use the next real user message
        if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
          // Use scheduled task name if present
          const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
        }
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    if (!summary || messageCount < 1) return null;
    const activeMinutes = startedAt && lastEntryAt
      ? Math.max(0, Math.round((new Date(lastEntryAt) - new Date(startedAt)) / 60000))
      : 0;
    return {
      sessionId, folder, projectPath,
      summary, firstPrompt: summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle,
      userMessageCount, largestUserPromptWords, startedAt, lastEntryAt, activeMinutes,
      ...usageTotals,
    };
  } catch {
    return null;
  }
}

module.exports = { readSessionFile };
