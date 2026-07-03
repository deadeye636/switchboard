#!/usr/bin/env node
// Generiert docs/BACKLOG.md aus den OFFENEN GitHub-Issues (deadeye636/switchboard).
// Issues sind die Single Source of Truth — BACKLOG.md ist ein read-only Mirror fürs
// schnelle In-Context-Grepping. NICHT von Hand editieren.
//
//   node scripts/build-backlog.js
//
// Braucht die `gh` CLI (authentifiziert). Default-Repo via `gh repo set-default`.
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

const labels = { P1: 'P1 — als Nächstes', P2: 'P2 — danach', P3: 'P3 — irgendwann', 'P?': 'Ohne Priorität' };
const url = n => `https://github.com/${REPO}/issues/${n}`;

const out = [];
out.push('<!-- GENERIERT aus offenen GitHub-Issues via `node scripts/build-backlog.js`.');
out.push('     NICHT von Hand editieren — Issues sind die Quelle. -->', '');
out.push('# Switchboard — Backlog', '');
out.push(`Read-only Mirror der **offenen** [GitHub-Issues](https://github.com/${REPO}/issues) ` +
         `(${issues.length} offen). Board wird über \`gh issue\` gepflegt, nicht hier.`, '');
out.push(`**Stand:** ${new Date().toISOString().slice(0, 10)}`, '');

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
console.log(`docs/BACKLOG.md geschrieben — ${issues.length} offene Issues.`);
