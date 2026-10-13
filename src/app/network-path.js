'use strict';
// Is this path on a network share, and may the app touch it (#780)?
//
// Touching a network path — a stat, a read, a watch — makes Windows open an SMB connection to its host,
// and that connection can hand over the user's NTLM hash. The panel readers get their paths from content
// the user did not write (file links in terminal output, files an MCP client asks to open), so a path that
// names someone else's host must be refused BEFORE anything touches it. Lexical on purpose: resolving or
// stat-ing the path to decide would already be the connection this exists to prevent.
//
// A project that itself lives on a share keeps working: a network path on the same `\\host\share` as a
// project the app knows is allowed. Same host and share, compared without case — a user who opened a project
// there has already decided to talk to that host.
//
// Electron-free and DB-free: the caller hands in the project paths. Used by main.js's panel readers and
// writer, and through ctx by `file-watch.js`.

// `\\host\share\…`, `//host/share/…` and any mix of the two; `\\?\UNC\host\share\…`. A device path
// (`\\.\…`, `\\?\…` that is not a drive) is answered as a share of its own, so it is refused unless a project
// lives there, which none does.
function networkShareOf(p) {
  if (typeof p !== 'string') return null;
  let s = p.replace(/\//g, '\\');
  const unc = /^\\\\\?\\UNC\\(.*)$/i.exec(s);
  if (unc) s = '\\\\' + unc[1];
  else if (/^\\\\[?.]\\[A-Za-z]:\\/.test(s)) return null; // `\\?\C:\…` is a local long path
  if (!/^\\\\/.test(s)) return null;
  const parts = s.slice(2).split('\\').filter(Boolean);
  if (!parts.length) return '\\\\';
  return ('\\\\' + parts.slice(0, 2).join('\\')).toLowerCase();
}

// True when `p` is a network path whose share no known project lives on.
function isForeignNetworkPath(p, projectPaths) {
  const share = networkShareOf(p);
  if (!share) return false;
  for (const project of projectPaths || []) {
    if (networkShareOf(project) === share) return false;
  }
  return true;
}

// Fails closed on purpose where the lexical compare cannot see two names for one place: `\\nas` against
// `\\nas.corp`, an IP address against a host name, a home directory that is itself on a share. Each is a
// refused file, never a connection to a host nobody chose.
const FOREIGN_NETWORK_REASON = 'That file is on a network share no project of yours is on, so it is not opened here.';
const FOREIGN_NETWORK_SAVE_REASON = 'That file is on a network share no project of yours is on, so it is not saved from here.';

module.exports = { networkShareOf, isForeignNetworkPath, FOREIGN_NETWORK_REASON, FOREIGN_NETWORK_SAVE_REASON };
