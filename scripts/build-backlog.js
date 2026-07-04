#!/usr/bin/env node
// Generates docs/BACKLOG.md from the OPEN GitHub issues (deadeye636/switchboard).
// The issues are the single source of truth — BACKLOG.md is a read-only mirror for
// fast in-context grepping. Do NOT hand-edit.
//
//   node scripts/build-backlog.js
//
// Needs the `gh` CLI (authenticated). Default repo via `gh repo set-default`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'deadeye636/switchboard';
const OUT = path.join(__dirname, '..', 'docs', 'BACKLOG.md');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 24 });
}

const issues = JSON.parse(gh([
  'issue', 'list', '-R', REPO, '--state', 'open', '--limit', '200',
  '--json', 'number,title,labels',
]));

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
console.log(`docs/BACKLOG.md written — ${issues.length} open issues.`);
