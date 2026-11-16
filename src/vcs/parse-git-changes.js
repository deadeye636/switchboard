// Pure readers for the session-changes git calls (#870): `diff --numstat -z` and the NUL-separated
// `logRangeArgs` / `showCommitArgs` output. No process execution, no DOM — `git.js` spells the argv, this reads
// the output.
'use strict';

// `git diff --numstat -z --no-renames` -> [{ path, added, deleted, binary }]. Records are NUL-terminated,
// `<added>\t<deleted>\t<path>`; the path may itself hold a tab or ` => ` (it is the rest of the record). A
// binary file prints `-\t-\t<path>` and has null counts.
function parseNumstat(raw) {
  const out = [];
  for (const rec of String(raw || '').split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ''));
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    out.push({ path: m[3], added: binary ? null : Number(m[1]), deleted: binary ? null : Number(m[2]), binary });
  }
  return out;
}

// `logRangeArgs` output is a flat NUL-separated list, `fields` per commit (3: sha, time, subject), and
// `showCommitArgs` adds the body (4). A message cannot hold NUL, so it cannot shift a record. A record whose
// sha is not 40 or 64 hex digits or whose time is not an integer is refused whole, never repaired.
// -> [{ sha, time (epoch s), subject, body }]
function parseLog(raw, fields = 3) {
  const f = String(raw || '').split('\0');
  const out = [];
  for (let i = 0; i + fields <= f.length; i += fields) {
    const sha = f[i].replace(/^\n+/, '');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) || !/^\d+$/.test(f[i + 1])) continue;
    out.push({ sha, time: Number(f[i + 1]), subject: f[i + 2], body: fields > 3 ? f[i + 3].trim() : '' });
  }
  return out;
}

module.exports = { parseNumstat, parseLog };
