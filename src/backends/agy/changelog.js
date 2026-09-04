// The Antigravity changelog.
//
// One page for the whole product family, with tab buttons that filter it client-side — the IDE, the
// CLI and the SDK are all in the same markup. What names the product is each row's version link:
// a CLI release points at `/download#antigravity-cli`, an IDE release at a `/releases?tab=hub` URL.
// Switchboard runs the CLI, so that is the row we keep.
'use strict';

const { fetchText, htmlToText, firstText, splitAt, entry } = require('../changelog');

const CLI_MARKER = 'antigravity-cli';

function parse(html, { marker = CLI_MARKER, url = null } = {}) {
  const blocks = splitAt(html, /<div\b[^>]*\bdata-section-row\b[^>]*>/gi);
  const out = [];
  for (const { body } of blocks) {
    const link = body.match(/<a[^>]*class="version-link[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link || !link[1].includes(marker)) continue;
    const version = htmlToText(link[2]) || null;
    // The version block is "<a>1.0.0</a><br>January 1, 2026" — the date is what follows the link.
    const pin = body.match(/<div\b[^>]*\bdata-date-pin\b[^>]*>([\s\S]*?)<\/div>/i);
    const dateText = pin ? htmlToText(pin[1].replace(/<a[\s\S]*?<\/a>/i, '')) : '';
    out.push(entry({
      version,
      date: dateText.split('\n').map(s => s.trim()).filter(Boolean).pop() || null,
      title: firstText(body, /<h3[^>]*>([\s\S]*?)<\/h3>/i) || '',
      // Version, date and title are their own fields. Without dropping the block they came from, every
      // entry repeats its own header as the first line of its body.
      body: htmlToText((pin ? body.replace(pin[0], '') : body).replace(/<h3[\s\S]*?<\/h3>/i, '')),
      url,
    }));
  }
  return out;
}

const changelogSource = {
  label: 'Antigravity CLI',
  url: 'https://antigravity.google/changelog',
  pageUrl: 'https://antigravity.google/changelog',
  async load() {
    const html = await fetchText(this.url);
    return parse(html, { url: this.pageUrl });
  },
};

module.exports = { changelogSource, parse };
