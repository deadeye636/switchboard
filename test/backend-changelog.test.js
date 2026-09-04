// The changelog seam (#528): the shared parsers, and each backend's own reading of its page.
//
// Every fixture here is a shortened copy of the real markup, kept small enough to read but with the
// attributes the parser actually keys on left intact — a fixture that dropped them would pass while
// the parser it guards no longer matched anything on the live page. Nothing in this file touches the
// network; the parse half is pure, and the fetch half is the script's problem.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const changelog = require('../src/backends/changelog');
const codexChangelog = require('../src/backends/codex/changelog');
const agyChangelog = require('../src/backends/agy/changelog');
const piChangelog = require('../src/backends/pi/changelog');

test('htmlToText keeps list structure and decodes entities', () => {
  const text = changelog.htmlToText('<p>Head &amp; shoulders</p><ul><li>one</li><li>two &#39;quoted&#39;</li></ul>');
  // A blank line after the paragraph, none between the bullets.
  assert.equal(text, 'Head & shoulders\n\n- one\n- two \'quoted\'');
});

test('htmlToText does not leak an attribute that contains a bare >', () => {
  // Tailwind writes `[&>pre]:mb-0` into class attributes; a `<[^>]+>` stripper ends the tag inside the
  // attribute and prints the rest of it as content. This is the exact string that did it.
  const text = changelog.htmlToText('<div class="[&>pre]:w-full [&>pre]:mb-0 pt-4">visible</div>');
  assert.equal(text, 'visible');
});

test('markdownEntries splits a CHANGELOG.md at its version headings', () => {
  const entries = changelog.markdownEntries('# Changelog\n\n## 2.1.2\n\n- fixed a thing\n\n## 2.1.1\n\n- added a thing\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, '2.1.2');
  assert.equal(entries[0].key, 'v:2.1.2');
  assert.equal(entries[0].body, '- fixed a thing');
  assert.equal(entries[1].version, '2.1.1');
});

test('githubReleaseEntries drops drafts and dates from the publish time', () => {
  const entries = changelog.githubReleaseEntries([
    { tag_name: 'v1.2.0', name: 'Agent v1.2.0', published_at: '2026-08-31T10:00:00Z', body: '# notes', html_url: 'https://example.invalid/r/1' },
    { tag_name: 'v1.3.0', name: 'draft', draft: true, body: '' },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, '2026-08-31');
  assert.equal(entries[0].version, 'v1.2.0');
  assert.equal(entries[0].url, 'https://example.invalid/r/1');
});

test('an entry without a version keys on date + title, so a body edit does not resurface it', () => {
  const a = changelog.entry({ date: '2026-01-01', title: 'Startup fix', body: 'one' });
  const b = changelog.entry({ date: '2026-01-01', title: 'Startup fix', body: 'one, expanded' });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, changelog.entry({ date: '2026-01-02', title: 'Startup fix' }).key);
});

const CODEX_PAGE = `
<h2 id="month-2026-09" data-changelog-month>September 2026</h2>
<ul>
<li id="github-release-1" data-product="codex" data-codex-topics="codex-cli">
  <time class="text-sm">2026-09-03</time>
  <h3><span>Codex CLI<span class="text-tertiary"> 0.153.2</span></span></h3>
  <div><ul><li>Corrected a tier description.</li></ul></div>
</li>
<li id="github-release-2" data-product="codex" data-codex-topics="codex-app">
  <time>2026-09-02</time>
  <h3><span>Codex app 1.4</span></h3>
  <div>App-only release.</div>
</li>
</ul>`;

test('codex keeps CLI entries and drops the other product surfaces', () => {
  const entries = codexChangelog.parse(CODEX_PAGE, { url: 'https://example.invalid/changelog' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, '0.153.2');
  assert.equal(entries[0].date, '2026-09-03');
  assert.equal(entries[0].title, 'Codex CLI 0.153.2');
  assert.equal(entries[0].url, 'https://example.invalid/changelog#github-release-1');
  // The heading and the date are their own fields — printing them inside the body too is the bug this
  // pins, not a cosmetic preference.
  assert.ok(!entries[0].body.includes('Codex CLI'));
  assert.ok(!entries[0].body.includes('2026-09-03'));
});

test('codex topics are overridable per run', () => {
  const entries = codexChangelog.parse(CODEX_PAGE, { topics: ['codex-app'] });
  assert.deepEqual(entries.map(e => e.version), ['1.4']);
});

const AGY_PAGE = `
<div class="section-row-wrapper" data-section-row>
  <div class="version" data-date-pin><p><a class="version-link" href="/download#antigravity-cli" title="View release 1.1.25">1.1.25</a><br>September 3, 2026</p></div>
  <div class="description" data-content-ref><h3 data-h3-pin>Workspace-grouped resume view</h3>
  <div class="changes"><p>Adds an opt-in grouped view.</p></div></div>
</div>
<div class="section-row-wrapper" data-section-row>
  <div class="version" data-date-pin><p><a class="version-link" href="/releases?tab=hub&amp;version=2.12.2">2.12.2</a><br>September 2, 2026</p></div>
  <div class="description" data-content-ref><h3 data-h3-pin>IDE release</h3><div class="changes"><p>Not the CLI.</p></div></div>
</div>`;

test('agy keeps the CLI rows the shared page mixes with the IDE and SDK ones', () => {
  const entries = agyChangelog.parse(AGY_PAGE, { url: 'https://example.invalid/changelog' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, '1.1.25');
  assert.equal(entries[0].date, 'September 3, 2026');
  assert.equal(entries[0].title, 'Workspace-grouped resume view');
  assert.equal(entries[0].body, 'Adds an opt-in grouped view.');
});

const PI_PAGE = `
<section class="news-feed">
<article class="surface-panel content-card news-feed-card"><div class="content-card-body">
  <div class="news-feed-meta"><a class="meta-chip news-source-chip" href="/news/releases">Release notes</a><time dateTime="2026-09-04T00:00:00.000Z">Sep 4, 2026</time></div>
  <h2><a class="news-feed-link" href="/news/releases/0.85.0">Pi 0.85.0</a></h2>
  <div class="news-release-summary"><section><h3>New Features</h3><ul><li>Persistent thinking effort.</li></ul></section></div>
</div></article>
<article class="surface-panel content-card news-feed-card"><div class="content-card-body">
  <div class="news-feed-meta"><a class="meta-chip news-source-chip" href="/news/releases">Release notes</a><time dateTime="2026-08-28T00:00:00.000Z">Aug 28, 2026</time></div>
  <h2><a class="news-feed-link" href="/news/releases/0.84.4">Pi 0.84.4</a></h2>
  <div class="news-release-summary"><p>Smaller release.</p></div>
</div></article>
</section>`;

test('pi reads one entry per release card, dated from the machine-readable attribute', () => {
  const entries = piChangelog.parse(PI_PAGE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, '0.85.0');
  assert.equal(entries[0].date, '2026-09-04');
  assert.equal(entries[0].url, 'https://pi.dev/news/releases/0.85.0');
  assert.ok(entries[0].body.startsWith('New Features'), entries[0].body);
  assert.equal(entries[1].version, '0.84.4');
});
