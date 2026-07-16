// Unit tests for the run-schedule-now path validation (issue #77).
// The pure validator gates which files run-schedule-now will execute — a
// compromised renderer must not be able to run an arbitrary X/commands/schedule-*.md
// with attacker-chosen frontmatter.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const { validateScheduleFilePath } = require('../src/servers/schedule-ipc');

test('accepts a schedule file under <project>/.claude/commands', () => {
  const p = path.join(path.sep, 'proj', '.claude', 'commands', 'schedule-daily.md');
  const r = validateScheduleFilePath(p);
  assert.equal(r.ok, true);
  assert.equal(path.basename(r.projectPath), 'proj');
});

test('allows the global ~/.claude/commands location', () => {
  const p = path.join(os.homedir(), '.claude', 'commands', 'schedule-x.md');
  assert.equal(validateScheduleFilePath(p).ok, true);
});

test('rejects a commands dir NOT under .claude (the core attack)', () => {
  const p = path.join(path.sep, 'tmp', 'evil', 'commands', 'schedule-x.md');
  const r = validateScheduleFilePath(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid/i);
});

test('rejects a non-schedule basename', () => {
  const p = path.join(path.sep, 'proj', '.claude', 'commands', 'notes.md');
  assert.equal(validateScheduleFilePath(p).ok, false);
});

test('rejects when the parent dir is not "commands"', () => {
  const p = path.join(path.sep, 'proj', '.claude', 'other', 'schedule-x.md');
  assert.equal(validateScheduleFilePath(p).ok, false);
});

test('rejects a bare filename with no .claude/commands ancestry', () => {
  assert.equal(validateScheduleFilePath('schedule-x.md').ok, false);
});
