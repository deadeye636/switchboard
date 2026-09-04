#!/usr/bin/env node
// Reports what the backend CLIs changed since the last accepted run (#528).
//
//   npm run backends:changelog-check              -> fetch + report what is new
//   node scripts/check-backend-changelogs.js --seen   -> mark the current state as reviewed
//
// The seen-marker lives in .git/backend-changelog-seen.json — same place and same reason as
// upstream-check.js: it is one developer's review position, not a fact about the repo.
//
// The script does NOT judge relevance. It says what appeared; deciding whether an entry is worth an
// issue is a conversation, and a script that filtered by keyword would drop exactly the entry nobody
// thought to grep for.
//
// Flags:
//   --seen              accept everything currently listed as reviewed (writes the marker)
//   --backend <id>      one backend only (repeatable)
//   --all               ignore the marker and print what the sources hold right now
//   --limit <n>         at most n entries per backend (default 10, 0 = no cap)
//   --full              print each entry's whole body instead of its first lines
//   --topics <a,b>      override a source's own entry filter (Codex' product topics)
'use strict';

const fs = require('fs');
const path = require('path');

const backends = require('../src/backends');

const SEEN_FILE = path.join(__dirname, '..', '.git', 'backend-changelog-seen.json');
// A source page shows a window, not its whole history. Remembering more keys than any page can hold
// keeps an entry that scrolled off from coming back as "new" if the page later shows it again.
// The marker keeps the keys it has SEEN, not the page's current window, and the cap has to clear the
// longest source by a wide margin — Claude's CHANGELOG.md alone lists several hundred versions, and a
// cap under that turns every run into "185 new entries" as the oldest keys fall off the end.
const KEYS_KEPT = 2000;
const BODY_LINES = 12;

function parseArgs(argv) {
  const opts = { seen: false, all: false, full: false, limit: 10, ids: [], topics: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seen') opts.seen = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--backend') opts.ids.push(String(argv[++i] || '').trim());
    else if (a === '--topics') opts.topics = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return null; }
}

function saveSeen(state) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(state, null, 2));
}

/** Every registered backend that declares a changelog source, `planned` dummies and templates aside. */
function sources(ids) {
  return backends.list()
    .filter(b => !b.isProfile && b.status === 'ready' && b.changelogSource && typeof b.changelogSource.load === 'function')
    .filter(b => !ids.length || ids.includes(b.id));
}

function indent(text, prefix, maxLines) {
  const lines = String(text).split('\n').filter(l => l.trim() !== '');
  const shown = maxLines > 0 ? lines.slice(0, maxLines) : lines;
  const out = shown.map(l => prefix + l).join('\n');
  const rest = lines.length - shown.length;
  return rest > 0 ? `${out}\n${prefix}… ${rest} more line${rest === 1 ? '' : 's'} (--full)` : out;
}

function printEntry(e, opts) {
  const head = [e.version || e.title, e.date].filter(Boolean).join('  ');
  console.log(`\n  ${head}`);
  if (e.version && e.title && e.title !== e.version) console.log(`  ${e.title}`);
  if (e.url) console.log(`  ${e.url}`);
  if (e.body) console.log(indent(e.body, '    ', opts.full ? 0 : BODY_LINES));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    // The header comment IS the help text — one place to keep current. It ends where the comments do,
    // so adding a flag below cannot leave the printed list one flag short.
    const head = fs.readFileSync(__filename, 'utf8').split('\n').slice(1);
    const doc = head.slice(0, head.findIndex(l => !l.startsWith('//')));
    console.log(doc.map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }

  const list = sources(opts.ids);
  if (!list.length) {
    console.error(opts.ids.length ? `No changelog source for: ${opts.ids.join(', ')}` : 'No backend declares a changelog source.');
    return 1;
  }

  const seen = loadSeen();
  // Two states, because they are accepted on different terms: `nextSeen` is what `--seen` would write
  // (everything just listed), `baselineSeen` only carries backends that had no marker at all. A first
  // run for one backend must not silently accept another backend's unreviewed entries.
  const nextSeen = { ...(seen || {}) };
  const baselineSeen = { ...(seen || {}) };
  let failures = 0;
  let newTotal = 0;
  let baselined = 0;

  // Sequential on purpose: five hosts, and a readable report beats a fast one. A failure is reported
  // next to the others rather than taking the run down — one unreachable page is not a reason to lose
  // the other four.
  for (const b of list) {
    const src = b.changelogSource;
    let entries;
    try {
      entries = await src.load({ topics: opts.topics });
    } catch (err) {
      failures++;
      console.log(`\n=== ${src.label || b.label || b.id} — FAILED: ${err.message}`);
      console.log(`    ${src.pageUrl || src.url}`);
      continue;
    }

    // Baseline is decided PER BACKEND, not per run. A run limited to one backend would otherwise
    // write a marker that makes the other four look like they published their entire history at once.
    const firstForThis = !opts.all && !(seen && seen[b.id]);
    if (firstForThis) baselined++;
    const known = new Set((seen && seen[b.id] && seen[b.id].keys) || []);
    const fresh = opts.all || firstForThis ? entries : entries.filter(e => !known.has(e.key));
    // Union with what was already known, newest first: a page shows a window, and an entry that has
    // scrolled off it must not come back as new the day the source re-lists it.
    const merged = [...new Set([...entries.map(e => e.key), ...known])].slice(0, KEYS_KEPT);
    const mark = { keys: merged, at: new Date().toISOString() };
    nextSeen[b.id] = mark;
    if (firstForThis) baselineSeen[b.id] = mark;

    const label = `${src.label || b.label || b.id}`;
    if (!fresh.length) {
      console.log(`\n=== ${label} — nothing new (${entries.length} entries listed)`);
      continue;
    }
    // Neither a baseline nor an `--all` dump is a review backlog: counting them makes the closing line
    // say "385 new entries" about a run where nothing was new.
    if (!firstForThis && !opts.all) newTotal += fresh.length;
    const capped = opts.limit > 0 ? fresh.slice(0, opts.limit) : fresh;
    const suffix = capped.length < fresh.length ? `, showing ${capped.length}` : '';
    console.log(`\n=== ${label} — ${fresh.length} ${firstForThis || opts.all ? 'entries' : 'new'}${suffix}`);
    console.log(`    ${src.pageUrl || src.url}`);
    for (const e of capped) printEntry(e, opts);
  }

  if (opts.seen) {
    saveSeen(nextSeen);
    console.log(`\nMarked as reviewed: ${SEEN_FILE}`);
  } else {
    if (baselined) {
      saveSeen(baselineSeen);
      console.log(`\nBaseline written for ${baselined} backend${baselined === 1 ? '' : 's'} — their next run reports only what appeared after this one.`);
    }
    if (newTotal) {
      console.log(`\n${newTotal} new entr${newTotal === 1 ? 'y' : 'ies'}. Run with --seen once they have been reviewed.`);
    }
  }

  return failures ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
