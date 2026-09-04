// The Claude Code changelog.
//
// The human-facing page is code.claude.com/docs/en/changelog, but that is a 3 MB documentation shell
// around the same list. The CLI publishes the list itself as a plain CHANGELOG.md, so we read that:
// one `## <version>` heading per release, no markup to guess at.
'use strict';

const { fetchText, markdownEntries } = require('../changelog');

const changelogSource = {
  label: 'Claude Code',
  // Where a person should look. The report prints it, so a new entry can be opened in a browser.
  pageUrl: 'https://code.claude.com/docs/en/changelog',
  url: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
  async load() {
    const text = await fetchText(this.url);
    return markdownEntries(text, { url: this.pageUrl });
  },
};

module.exports = { changelogSource };
