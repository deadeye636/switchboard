// The Hermes changelog — the GitHub releases of NousResearch/hermes-agent.
//
// There is no changelog page; the releases API is the source, and it needs no parsing. Unauthenticated
// requests are rate-limited per IP (60/hour), which is plenty for a check that is run by hand — a 403
// is reported like any other source failure rather than retried.
'use strict';

const { fetchJson, githubReleaseEntries } = require('../changelog');

const changelogSource = {
  label: 'Hermes',
  url: 'https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=30',
  pageUrl: 'https://github.com/NousResearch/hermes-agent/releases',
  async load() {
    return githubReleaseEntries(await fetchJson(this.url), { url: this.pageUrl });
  },
};

module.exports = { changelogSource };
