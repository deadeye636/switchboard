#!/usr/bin/env node
// What the upstreams (haydng + jbr) have done since anyone last looked: branches that are new or
// have moved, and the commits behind them. The marker lives in .git/upstream-seen.json, which is
// not versioned — it records what THIS checkout has reviewed, not what the project has.
//
//   npm run upstream:check   -> fetch, then report what is new since the last "seen"
//   npm run upstream:seen    -> mark the current state as seen, once a review is done
//
// The upstreams are public HTTPS remotes, so this needs no SSH key and no agent.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REMOTES = ['haydng', 'jbr', 'brianstanley', 'kreaddis', 'aaaron', 'ivandobsky', 'upstream'];
const OURS = 'main'; // unsere Linie
const SEEN_FILE = path.join(__dirname, '..', '.git', 'upstream-seen.json');
const APPLY = process.argv.includes('--seen');

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return null; }
}

// Branch-Tips eines Remotes: { branch: sha }
function remoteHeads(remote) {
  const out = git(['ls-remote', '--heads', remote]);
  const map = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    map[ref.replace('refs/heads/', '')] = sha;
  }
  return map;
}

// The commit lines in oldSha..newSha — empty when old is missing or the two are the same.
function commitsBetween(oldSha, newSha) {
  if (!oldSha || oldSha === newSha) return [];
  try {
    const out = git(['log', '--oneline', '--no-decorate', `${oldSha}..${newSha}`]);
    return out ? out.split('\n') : [];
  } catch { return []; }
}

console.log('Fetch ' + REMOTES.join(' + ') + ' …');
for (const r of REMOTES) {
  try { execFileSync('git', ['fetch', r, '--prune'], { stdio: 'ignore' }); }
  catch (e) { console.error(`  ! fetch ${r} fehlgeschlagen: ${e.message}`); }
}

const seen = loadSeen();
const current = {};
for (const r of REMOTES) current[r] = remoteHeads(r);

if (!seen) {
  // Erstlauf: Baseline setzen, nichts als "neu" spammen.
  fs.writeFileSync(SEEN_FILE, JSON.stringify(current, null, 2));
  console.log('\nBaseline initialisiert (.git/upstream-seen.json). Aktuelle Branches:');
  for (const r of REMOTES) {
    console.log(`\n[${r}] ${Object.keys(current[r]).length} Branch(es): ${Object.keys(current[r]).join(', ')}`);
    const ahead = commitsBetween(OURS, `${r}/main`);
    console.log(`  ${r}/main vs ${OURS}: ${ahead.length} commit(s) not in ${OURS}` + (ahead.length ? ` (e.g. ${ahead[0]})` : ''));
  }
  console.log('\nKuenftige `npm run upstream:check` zeigen nur Neues seit jetzt.');
  process.exit(0);
}

// Delta-Report
let anything = false;
for (const r of REMOTES) {
  const prev = seen[r] || {};
  const now = current[r];
  const newBranches = [];
  const updated = [];
  for (const [branch, sha] of Object.entries(now)) {
    if (!(branch in prev)) newBranches.push({ branch, sha });
    else if (prev[branch] !== sha) updated.push({ branch, oldSha: prev[branch], sha });
  }
  const goneBranches = Object.keys(prev).filter(b => !(b in now));

  if (!newBranches.length && !updated.length && !goneBranches.length) continue;
  anything = true;
  console.log(`\n=== ${r} ===`);

  for (const { branch, sha } of newBranches) {
    console.log(`  + NEUER Branch ${branch} (${sha.slice(0, 9)})`);
  }
  for (const { branch, oldSha, sha } of updated) {
    const commits = commitsBetween(oldSha, sha);
    console.log(`  ~ ${branch}: ${commits.length} neue Commit(s)`);
    for (const c of commits.slice(0, 12)) console.log(`      ${c}`);
    if (commits.length > 12) console.log(`      … +${commits.length - 12} weitere`);
  }
  for (const branch of goneBranches) console.log(`  - Branch ${branch} entfernt`);
}

if (!anything) {
  console.log('\nKeine neue Upstream-Aktivitaet seit letztem `upstream:seen`.');
}

if (APPLY) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(current, null, 2));
  console.log('\nMerker aktualisiert — aktueller Stand gilt jetzt als gesehen.');
} else if (anything) {
  console.log('\nNach Review: `npm run upstream:seen` markiert diesen Stand als gesehen.');
}
