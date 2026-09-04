// backends/changelog.js — the shared half of "what changed in this CLI since I last looked".
//
// Each backend declares WHERE its changelog lives and HOW its own page is shaped
// (`changelogSource` in its folder); this module holds the parts that are the same for all of them,
// the way file-store.js holds the shared file-mode walk. Nothing here knows a backend id.
//
// An entry is the unit the report and the seen-marker both work on:
//
//   { key, version, date, title, body, url }
//
// `key` is what "have I seen this?" is answered with, so it must survive a page re-render: a version
// where the source has one, otherwise date + title. It is deliberately NOT a hash of the body — a
// typo fix in an old entry would resurface the whole entry as new.
'use strict';

const DEFAULT_TIMEOUT_MS = 20000;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

// HTML fragment -> readable plain text. Block ends become newlines and list items keep their bullet,
// because a changelog entry read without its list structure is a wall of text nobody reviews.
function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    // `</li>` is deliberately absent: the next `<li>` already opens its own line, and closing one too
    // puts a blank line between every bullet.
    .replace(/<\/(p|div|h[1-6]|ul|ol|section|summary|details|tr)>/gi, '\n')
    // Quote-aware: an attribute value may itself contain `>` (Tailwind's `[&>pre]:mb-0` does), and a
    // `<[^>]+>` stops inside it, leaking the rest of the attribute into the text.
    .replace(/<[a-zA-Z!/][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text of the first match of `re` in `html`, tags stripped. `null` when it does not match. */
function firstText(html, re) {
  const m = String(html).match(re);
  return m ? htmlToText(m[1]) : null;
}

// Split a document at every occurrence of `re` and hand back [{ head, body }] — the shape every
// HTML/Markdown source here needs, because a changelog is a heading followed by everything until the
// next heading. `re` must be global; its first capture group is the head.
function splitAt(text, re) {
  const s = String(text);
  const out = [];
  const marks = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    marks.push({ at: m.index, head: m[1] !== undefined ? m[1] : m[0], end: m.index + m[0].length });
    if (m[0] === '') re.lastIndex++;
  }
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].at : s.length;
    out.push({ head: marks[i].head, body: s.slice(marks[i].end, stop) });
  }
  return out;
}

/** `## 1.2.3` sections of a plain CHANGELOG.md. */
function markdownEntries(text, { url = null, level = 2 } = {}) {
  const hashes = '#'.repeat(level);
  const re = new RegExp(`^${hashes} +(.+)$`, 'gm');
  return splitAt(text, re).map(({ head, body }) => {
    const title = head.trim();
    const version = (title.match(/\d+\.\d+[.\d]*/) || [null])[0];
    return entry({ version, title, body: body.trim(), url });
  });
}

/** The GitHub releases API (`/repos/<owner>/<repo>/releases`). */
function githubReleaseEntries(json, { url = null } = {}) {
  const list = Array.isArray(json) ? json : [];
  return list.filter(r => r && !r.draft).map(r => entry({
    version: r.tag_name || r.name || null,
    date: (r.published_at || r.created_at || '').slice(0, 10) || null,
    title: r.name || r.tag_name || 'release',
    body: String(r.body || '').trim(),
    url: r.html_url || url,
    prerelease: !!r.prerelease,
  }));
}

/** Normalise one entry and derive its `key`. */
function entry({ version = null, date = null, title = '', body = '', url = null, ...rest }) {
  const clean = String(title).replace(/\s+/g, ' ').trim();
  return {
    key: version ? `v:${version}` : `d:${date || '?'}|${clean}`,
    version: version || null,
    date: date || null,
    title: clean,
    body: String(body).trim(),
    url: url || null,
    ...rest,
  };
}

// Fetch with a timeout and a UA that says who is calling. A changelog host that hangs must not hang
// the whole run, so the caller catches per source and reports the failure next to the others.
async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'switchboard-changelog-check', accept: '*/*', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, { ...opts, headers: { accept: 'application/vnd.github+json', ...(opts && opts.headers) } }));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  decodeEntities, htmlToText, firstText, splitAt,
  markdownEntries, githubReleaseEntries, entry,
  fetchText, fetchJson,
};
