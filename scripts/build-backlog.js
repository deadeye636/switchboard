#!/usr/bin/env node
// Generates docs/BACKLOG.md and docs/BACKLOG.jsonl from the OPEN GitHub issues
// (deadeye636/switchboard). The issues are the single source of truth — both files
// are read-only mirrors: BACKLOG.md for fast in-context grepping, BACKLOG.jsonl for
// machine consumption by agents (one issue per line: number, title, prio, labels,
// url, refs, body). Do NOT hand-edit either file.
//
//   node scripts/build-backlog.js
//
// Needs the `gh` CLI (authenticated). Default repo via `gh repo set-default`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'deadeye636/switchboard';
const OUT = path.join(__dirname, '..', 'docs', 'BACKLOG.md');
const OUT_JSONL = path.join(__dirname, '..', 'docs', 'BACKLOG.jsonl');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 24 });
}

const ISSUE_LIMIT = 200;
const issues = JSON.parse(gh([
  'issue', 'list', '-R', REPO, '--state', 'open', '--limit', String(ISSUE_LIMIT),
  '--json', 'number,title,labels,body',
]));
if (issues.length >= ISSUE_LIMIT) {
  console.warn(`WARNING: hit the gh --limit ${ISSUE_LIMIT} cap — the backlog mirror may be truncated. Raise the limit or paginate (#82).`);
}

const prioOf = i => (i.labels.find(l => /^P[123]$/.test(l.name)) || {}).name || 'P?';
const tags = i => i.labels.map(l => l.name).filter(n => !/^P[123]$/.test(n)).join(', ');

const order = { P1: 0, P2: 1, P3: 2, 'P?': 3 };
issues.sort((a, b) => (order[prioOf(a)] - order[prioOf(b)]) || (a.number - b.number));

const groups = { P1: [], P2: [], P3: [], 'P?': [] };
for (const i of issues) groups[prioOf(i)].push(i);

const labels = { P1: 'P1 — next up', P2: 'P2 — after that', P3: 'P3 — someday', 'P?': 'No priority' };
const url = n => `https://github.com/${REPO}/issues/${n}`;

const out = [];
out.push('<!-- GENERATED from open GitHub issues via `node scripts/build-backlog.js`.');
out.push('     Do NOT hand-edit — the issues are the source of truth. -->', '');
out.push('# Switchboard — Backlog', '');
out.push(`Read-only mirror of the **open** [GitHub issues](https://github.com/${REPO}/issues) ` +
         `(${issues.length} open). The board is maintained via \`gh issue\`, not here.`, '');
out.push(`**As of:** ${new Date().toISOString().slice(0, 10)}`, '');

for (const p of ['P1', 'P2', 'P3', 'P?']) {
  if (!groups[p].length) continue;
  out.push('', `## ${labels[p]}`, '');
  for (const i of groups[p]) {
    const t = tags(i);
    out.push(`- [#${i.number}](${url(i.number)}) ${i.title}${t ? ` · _${t}_` : ''}`);
  }
}
out.push('');

fs.writeFileSync(OUT, out.join('\n'));

// Machine-readable mirror: one JSON object per line, sorted like the MD (prio, then
// number). `refs` = other issue numbers mentioned in the body (cross-links).
const jsonl = issues.map(i => JSON.stringify({
  number: i.number,
  title: i.title,
  prio: prioOf(i),
  labels: i.labels.map(l => l.name).filter(n => !/^P[123]$/.test(n)),
  url: url(i.number),
  refs: [...new Set([...(i.body || '').matchAll(/#(\d+)\b/g)].map(m => Number(m[1])))]
    .filter(n => n !== i.number),
  body: i.body || '',
})).join('\n');
fs.writeFileSync(OUT_JSONL, jsonl + '\n');
console.log(`docs/BACKLOG.md + BACKLOG.jsonl written — ${issues.length} open issues.`);
