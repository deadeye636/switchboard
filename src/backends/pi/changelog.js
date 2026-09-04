// The Pi changelog — pi.dev/news/releases.
//
// One `<article class="news-feed-card">` per release, each with the release date in a `<time>` and
// the version in its own heading link. The page shows the most recent releases only, so a long gap
// between runs can drop older ones off the end; the report says what it found, not what it missed.
'use strict';

const { fetchText, htmlToText, firstText, splitAt, entry } = require('../changelog');

const ORIGIN = 'https://pi.dev';

function parse(html, { url = null } = {}) {
  const blocks = splitAt(html, /<article\b[^>]*\bnews-feed-card\b[^>]*>/gi);
  const out = [];
  for (const { body } of blocks) {
    const head = body.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    if (!head) continue;
    const title = htmlToText(head[2]);
    out.push(entry({
      version: (title.match(/\d+\.\d+[.\d]*/) || [null])[0],
      date: (body.match(/<time[^>]*datetime="([^"]*)"/i) || [, ''])[1].slice(0, 10) || firstText(body, /<time[^>]*>([\s\S]*?)<\/time>/i),
      title,
      // The meta block holds the date and a "Release notes" source chip, both of which are reported as
      // fields of their own — left in, every entry starts with the same two throwaway lines.
      body: htmlToText(body
        .replace(/<div\b[^>]*\bnews-feed-meta\b[^>]*>[\s\S]*?<\/div>/i, '')
        .replace(/<h2[\s\S]*?<\/h2>/i, '')),
      url: head[1] ? (head[1].startsWith('http') ? head[1] : ORIGIN + head[1]) : url,
    }));
  }
  return out;
}

const changelogSource = {
  label: 'Pi',
  url: 'https://pi.dev/news/releases',
  pageUrl: 'https://pi.dev/news/releases',
  async load() {
    const html = await fetchText(this.url);
    return parse(html, { url: this.pageUrl });
  },
};

module.exports = { changelogSource, parse };
