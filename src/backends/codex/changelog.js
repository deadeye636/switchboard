// The Codex changelog.
//
// One page covers every Codex surface — the app, the mobile client, the CLI — and each entry carries
// its own `data-codex-topics`, which is what the page's own filter buttons read. We keep the CLI
// topics and drop the rest: an app-only release is not a Switchboard question.
'use strict';

const { fetchText, htmlToText, firstText, splitAt, entry } = require('../changelog');

// `general` is deliberately out. It is the bucket for model and account announcements, and letting it
// in turned the report into a product feed. `--topics` on the script overrides this per run.
const CLI_TOPICS = ['codex-cli'];

function parse(html, { topics = CLI_TOPICS, url = null } = {}) {
  const blocks = splitAt(html, /<li\b([^>]*\bdata-codex-topics="[^"]*"[^>]*)>/gi);
  const out = [];
  for (const { head, body } of blocks) {
    const declared = (head.match(/data-codex-topics="([^"]*)"/i) || [, ''])[1].split(',').map(s => s.trim());
    if (!declared.some(t => topics.includes(t))) continue;
    const title = firstText(body, /<h3[^>]*>([\s\S]*?)<\/h3>/i) || '';
    const date = (body.match(/<time[^>]*>([^<]*)<\/time>/i) || [, ''])[1].trim() || null;
    // The heading is "Codex CLI 0.153.2" — the version is the last token, when there is one.
    const version = (title.match(/(\d+\.\d+[.\d]*)\s*$/) || [, null])[1];
    const anchor = (head.match(/\bid="([^"]+)"/i) || [, null])[1];
    out.push(entry({
      version, date, title,
      // The date and the heading are reported as their own fields; leaving them in the body prints
      // each entry's first two lines twice.
      body: htmlToText(body.replace(/<h3[\s\S]*?<\/h3>/i, '').replace(/<time[\s\S]*?<\/time>/i, '')),
      url: anchor && url ? `${url}#${anchor}` : url,
    }));
  }
  return out;
}

const changelogSource = {
  label: 'Codex CLI',
  url: 'https://learn.chatgpt.com/docs/changelog',
  pageUrl: 'https://learn.chatgpt.com/docs/changelog',
  topics: CLI_TOPICS,
  async load({ topics } = {}) {
    const html = await fetchText(this.url);
    return parse(html, { topics: topics && topics.length ? topics : this.topics, url: this.pageUrl });
  },
};

module.exports = { changelogSource, parse };
