/**
 * readable-error.js — what a thrown filesystem error is allowed to say to the user (#444).
 *
 * Every one of these messages ends up on screen. A filesystem error carries the path it failed on —
 * `EACCES: permission denied, open '<home>/.claude/commands/x.md'` — and that is a home directory, a
 * user name and a layout the reader never asked to publish, in a line they may well screenshot into a
 * bug report. It also tells them nothing to act on that the code alone does not.
 *
 * So the errno is TRANSLATED and the rest of the message is dropped. Not shortened, not scrubbed of the
 * quoted path — dropped: a message this module has not recognised may carry anything, and there is no
 * way to tell from here. An unrecognised error is answered with the caller's own sentence and nothing
 * else, which is honest about the app not knowing more.
 *
 * The dropped detail is not lost, it is MOVED: `log` gets the code and the raw message, so a failure
 * nobody can explain from the screen is still explainable from the log file. Dropping it in both places
 * is how a support question becomes unanswerable.
 *
 * Reasons a backend or a module AUTHORED (`{ ok: false, error: 'path outside a plans directory' }`) are
 * not errors and never come through here — they are already written for a reader.
 *
 * It lives in its own file because two areas need it and neither owns it: backend resource discovery
 * reads files, the Plans and Agent Files tabs write and delete them, and both surface the answer in the
 * same viewer.
 */

'use strict';

const ERRNO_WORDS = {
  EACCES: 'Permission was denied.',
  EPERM: 'Permission was denied.',
  EROFS: 'That location is read-only.',
  ENOENT: 'It is no longer there.',
  ENOTDIR: 'Part of that path is not a directory.',
  EISDIR: 'That is a directory, not a file.',
  ELOOP: 'The path leads through too many symbolic links.',
  ENAMETOOLONG: 'The path is too long for this system.',
  EINVAL: 'The system rejected that path.',
  EMFILE: 'Too many files are open on this system right now.',
  ENFILE: 'Too many files are open on this system right now.',
  ENOSPC: 'The disk is full.',
  EBUSY: 'Another program is holding it.',
  EIO: 'The disk reported a read error.',
  // Windows answers UNKNOWN for a whole family of things a user CAN act on — a disconnected network
  // share, a file an antivirus scanner has open, a path on a drive that went away.
  UNKNOWN: 'The system could not say what went wrong. A network drive or another program holding the file is the usual cause.',
};

/**
 * @param {any} err       what was thrown
 * @param {string} fallback  the caller's own sentence, always part of the answer
 * @param {{error?: Function, debug?: Function}} [log]  where the dropped detail goes
 */
function readableError(err, fallback, log) {
  const code = err && err.code ? String(err.code) : null;
  const words = code ? ERRNO_WORDS[code] : null;
  if (log && typeof log.debug === 'function') {
    // At debug, not info: this fires per failed action, and the state change worth an info line is the
    // one the caller logs. The raw message is the whole point of the entry.
    log.debug(`[readable-error] ${fallback} code=${code || 'none'} raw=${(err && err.message) || err}`);
  }
  return words ? `${fallback} ${words}` : fallback;
}

module.exports = { readableError, ERRNO_WORDS };
