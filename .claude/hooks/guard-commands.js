#!/usr/bin/env node
'use strict';
// PreToolUse guard: refuse three shell commands that CLAUDE.md only asks for in prose.
//
// A rule in an always-loaded file is advisory — it is read, and then a command runs anyway. These
// three are cheap to recognise and expensive to undo, so they are refused here instead:
//
//   1. taskkill /IM electron*  — kills the INSTALLED app and every other checkout's dev run, not
//      just this one. `npm run stop:dev` stops this checkout.
//   2. gh ... doctly           — the issue board is our fork. An issue or PR filed on the upstream
//      repo is public, addressed to someone else, and its edit history stays world-readable.
//   3. git push <read-only>    — every remote but `origin` is somebody else's repository, and each
//      one carries a push URL because git adds one by default.
//
// Reads the hook payload on stdin, answers on stdout. Anything it does not recognise is allowed by
// omission: a guard that fails closed on parse trouble would block work it was never about.

function readPayload() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let command = '';
    try {
      command = String(JSON.parse(raw).tool_input?.command || '');
    } catch {
      process.exit(0);  // not a payload we understand — not our business
    }

    const reason = firstProblem(command);
    if (!reason) process.exit(0);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  });
}

// Remotes this repo carries for reading other people's work. `origin` is the only one we own.
const READ_ONLY_REMOTES = ['upstream', 'haydng', 'jbr', 'brianstanley', 'kreaddis', 'aaaron', 'ivandobsky'];

function firstProblem(command) {
  if (/\btaskkill\b/i.test(command) && /\/im\s+"?electron/i.test(command)) {
    return 'taskkill /IM electron takes down the installed app and every other checkout, not just '
      + 'this dev run. Use `npm run stop:dev`, which stops this checkout only.';
  }

  if (/\bStop-Process\b/i.test(command) && /-Name\s+"?electron/i.test(command)) {
    return 'Stop-Process -Name electron takes down the installed app and every other checkout. Use '
      + '`npm run stop:dev`.';
  }

  if (/(^|[\s;|&(])gh\b/.test(command) && /\bdoctly\b/i.test(command)) {
    return 'This gh command names `doctly`, the upstream repository. The board is our fork '
      + '(`deadeye636/switchboard`) — issues, comments and their world-readable edit history belong '
      + 'there. `gh repo set-default` already pins it, so drop the explicit repo.';
  }

  const push = command.match(/\bgit\s+push\s+(?:--?\S+\s+)*(\S+)/);
  if (push) {
    const target = push[1].replace(/^["']|["']$/g, '');
    if (READ_ONLY_REMOTES.includes(target) || /\bdoctly\b/i.test(target)) {
      return `\`${target}\` is a remote we only READ from — it is somebody else's repository, and it `
        + 'carries a push URL only because git adds one by default. Push to `origin`.';
    }
  }

  return null;
}

module.exports = { firstProblem, READ_ONLY_REMOTES };

if (require.main === module) readPayload();
