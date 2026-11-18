/**
 * vscode-tasks.js — a project's VS Code tasks, read-only, for the launch popover (#616 step 2).
 *
 * The popover's Custom commands flyout lists the user's saved launchers and, under them, the tasks the
 * project's `.vscode/tasks.json` declares. This module is the only place that knows that file: the
 * renderer asks `get-vscode-tasks` for a project and receives plain rows, never the format (E6).
 *
 * What a row is, from the decisions on #616:
 *   - E1  `.vscode/tasks.json` → `tasks[]` only. `launch.json` holds debug configurations, which are
 *         not command lines.
 *   - E2  A typed task (`npm`, `typescript`, …) has no literal command line. It is LISTED and disabled
 *         with the reason, because hiding it leaves the user hunting for a task that is in their file.
 *         No task type is translated.
 *   - E3  `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${pathSeparator}`,
 *         `${cwd}` and `${env:NAME}` are substituted. Any other variable disables the row and is named
 *         in its reason — there is no file, no selection and no input prompt in a launch popover.
 *   - E4  A file that does not parse yields an empty list. The popover opens as if it were not there.
 *   - E7  Nothing readable → no rows, and the caller draws no section.
 *
 * Nothing here writes the file (`Not in this issue`), and nothing here runs anything: an enabled row
 * carries the launcher fields (`command`, `args`, `cwd`, `env`) the ordinary in-app launcher path
 * already spawns, so a task runs exactly like a saved launcher would.
 *
 * A row that VS Code itself would hide from its task picker (`"hide": true`) is left out here too.
 *
 * Two limits that are deliberate:
 *   - A line break anywhere in a command, an argument, the working directory or an environment value
 *     disables the row. The launcher path types the line into a shell, where a break submits what came
 *     before it and runs the rest as a second command, one the popover's single-line preview never
 *     showed. `tasks.json` arrives with a cloned repository, so it is not the user's own text.
 *   - An environment value that is exactly `$NAME` or `${NAME}` is passed on as it stands, and the spawn
 *     path reads that shape as a REFERENCE (`src/backends/env-refs.js`): resolved from the app's
 *     environment, or dropped with a notice, where VS Code would pass it literally. It is the launchers'
 *     own rule for env values, so a task behaves like a saved launcher holding the same value.
 *
 * The project path comes from the renderer, so a network path is refused LEXICALLY before anything
 * touches it (`network-path.js`, through the guard main.js hands in): a stat of a share no project is on
 * would already be the SMB connection that rule exists to prevent.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse: parseJsonc } = require('jsonc-parser');
const { isInside } = require('./path-containment');
const { isForeignNetworkPath } = require('./network-path');

// A tasks file is a few kilobytes. A bigger one is not a tasks file anybody wrote by hand, and parsing it
// would be time the main process stands still while a menu waits for it.
const MAX_BYTES = 512 * 1024;

// VS Code's own per-platform override keys on a task (and at the top level).
const PLATFORM_KEY = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform] || null;

// The variables E3 substitutes. `env:` is handled separately because its name is part of it.
const SUBSTITUTED = new Set(['workspaceFolder', 'workspaceFolderBasename', 'userHome', 'pathSeparator', 'cwd']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The string of a `command`/`args` entry: a plain string, or VS Code's `{ value, quoting }` form. */
function stringOf(v) {
  if (typeof v === 'string') return v;
  if (isPlainObject(v) && typeof v.value === 'string') return v.value;
  if (isPlainObject(v) && Array.isArray(v.value)) return v.value.filter(x => typeof x === 'string').join(' ');
  return null;
}

/**
 * Substitute the E3 variables in one string. Returns `{ text, unsupported }`, where `unsupported` lists
 * every variable this cannot answer, spelled as the user wrote it (`${file}`, `${input:target}`).
 */
function substitute(text, projectPath, env) {
  const unsupported = [];
  const out = String(text).replace(/\$\{([^}]*)\}/g, (whole, name) => {
    if (name.startsWith('env:')) {
      const value = env[name.slice(4)];
      return typeof value === 'string' ? value : '';
    }
    if (!SUBSTITUTED.has(name)) { unsupported.push(whole); return whole; }
    switch (name) {
      case 'workspaceFolder': return projectPath;
      case 'workspaceFolderBasename': return path.basename(projectPath);
      case 'userHome': return os.homedir();
      case 'pathSeparator': return path.sep;
      // VS Code's `${cwd}` is the task runner's working directory, which for a task started here is
      // the project.
      case 'cwd': return projectPath;
      default: return whole;
    }
  });
  return { text: out, unsupported };
}

/** The task with its platform override applied, the way VS Code reads it. */
function withPlatform(task) {
  const own = PLATFORM_KEY && isPlainObject(task[PLATFORM_KEY]) ? task[PLATFORM_KEY] : null;
  if (!own) return task;
  const merged = { ...task, ...own };
  if (isPlainObject(task.options) || isPlainObject(own.options)) merged.options = mergeOptions(task.options, own.options);
  return merged;
}

/** Two `options` objects, the second winning key by key, and `env` variable by variable inside them. */
function mergeOptions(base, over) {
  const a = isPlainObject(base) ? base : {};
  const b = isPlainObject(over) ? over : {};
  const out = { ...a, ...b };
  if (isPlainObject(a.env) || isPlainObject(b.env)) {
    out.env = { ...(isPlainObject(a.env) ? a.env : {}), ...(isPlainObject(b.env) ? b.env : {}) };
  }
  return out;
}

const hasBreak = (v) => typeof v === 'string' && /[\r\n]/.test(v);

/** The name VS Code shows for a task: its label, the legacy `taskName`, or `<type>: <script/task>`. */
function taskName(task, index) {
  if (typeof task.label === 'string' && task.label.trim()) return task.label.trim();
  if (typeof task.taskName === 'string' && task.taskName.trim()) return task.taskName.trim();
  const type = typeof task.type === 'string' ? task.type : '';
  const detail = typeof task.script === 'string' ? task.script : (typeof task.task === 'string' ? task.task : '');
  if (type && detail) return `${type}: ${detail}`;
  return type ? `${type} task ${index + 1}` : `Task ${index + 1}`;
}

/**
 * One row from one raw task. Never throws on a strange entry: anything it cannot use becomes a disabled
 * row with a reason, or `null` for an entry that is not a task at all.
 */
function taskRow(raw, index, projectPath, defaults, env) {
  if (!isPlainObject(raw)) return null;
  if (raw.hide === true) return null;
  const task = withPlatform(raw);
  const name = taskName(task, index);
  const row = { id: `vscode-task-${index}`, name, disabled: false, reason: '', commandLine: '' };

  const type = typeof task.type === 'string' ? task.type : (typeof defaults.type === 'string' ? defaults.type : '');
  const command = stringOf(task.command !== undefined ? task.command : defaults.command);
  if (type && type !== 'shell' && type !== 'process') {
    row.disabled = true;
    row.reason = `A “${type}” task has no command line to run.`;
    return row;
  }
  if (!command || !command.trim()) {
    row.disabled = true;
    row.reason = Array.isArray(task.dependsOn) || typeof task.dependsOn === 'string'
      ? 'Runs other tasks (dependsOn) and has no command line of its own.'
      : 'Has no command line.';
    return row;
  }

  const rawArgs = Array.isArray(task.args) ? task.args : (task.command === undefined && Array.isArray(defaults.args) ? defaults.args : []);
  // Top-level `options` apply to every task; a task's own win key by key, its `env` variable by variable.
  const options = mergeOptions(defaults.options, task.options);
  const rawEnv = isPlainObject(options.env) ? options.env : null;

  const unsupported = [];
  const sub = (s) => { const r = substitute(s, projectPath, env); unsupported.push(...r.unsupported); return r.text; };

  const commandText = sub(command).trim();
  const args = [];
  for (const a of rawArgs) {
    const s = stringOf(a);
    if (s != null && s !== '') args.push(sub(s));
  }
  const cwd = typeof options.cwd === 'string' && options.cwd.trim() ? sub(options.cwd.trim()) : '';
  const launchEnv = {};
  if (rawEnv) {
    for (const [k, v] of Object.entries(rawEnv)) {
      const key = String(k).trim();
      if (key) launchEnv[key] = sub(v == null ? '' : String(v));
    }
  }

  row.commandLine = [commandText, ...args.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' ').replace(/[\r\n]+/g, ' ');

  if ([commandText, cwd, ...args, ...Object.values(launchEnv)].some(hasBreak)) {
    row.disabled = true;
    row.reason = 'Contains a line break, which the terminal shell would run as a second command.';
    return row;
  }

  if (unsupported.length) {
    const named = [...new Set(unsupported)];
    row.disabled = true;
    row.reason = `Uses ${named.join(', ')}, which has no value outside the editor.`;
    return row;
  }
  // A `process` task names a program, not a line for a shell. Typed into the terminal shell as it is,
  // a program path with a space in it is two words (PowerShell would even echo a quoted one back rather
  // than run it), so it is refused rather than run as something else.
  if ((type === 'process') && /\s/.test(commandText)) {
    row.disabled = true;
    row.reason = 'Its program path contains a space, which cannot be typed into the terminal shell as it is.';
    return row;
  }

  row.command = commandText;
  if (args.length) row.args = args;
  if (cwd) row.cwd = path.resolve(projectPath, cwd);
  if (Object.keys(launchEnv).length) row.env = launchEnv;
  return row;
}

/**
 * The rows for one parsed tasks file. Pure: the caller supplies the parsed value, the project and the
 * environment, so the suite can exercise it without a filesystem.
 */
function rowsFromTasksJson(doc, projectPath, env = process.env) {
  if (!isPlainObject(doc) || !Array.isArray(doc.tasks)) return [];
  const top = withPlatform(doc);
  const defaults = { type: top.type, command: top.command, args: top.args, options: top.options };
  const rows = [];
  doc.tasks.forEach((t, i) => {
    const row = taskRow(t, i, projectPath, defaults, env);
    if (row) rows.push(row);
  });
  return rows;
}

/** Parse the text of a tasks file. Any parse error answers `null` (E4). */
function parseTasksText(text) {
  if (typeof text !== 'string') return null;
  const errors = [];
  const value = parseJsonc(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length ? null : value;
}

/** Read a project's tasks as plain rows. Every failure answers `[]`. */
async function readVscodeTasks(projectPath, guards = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim() || !path.isAbsolute(projectPath)) return [];
  const file = path.join(projectPath, '.vscode', 'tasks.json');
  // Lexical, before any stat: a share no project is on is never touched (#780). Without main's guard,
  // every share counts as foreign.
  const foreign = typeof guards.isForeignNetworkFile === 'function'
    ? guards.isForeignNetworkFile
    : (p) => isForeignNetworkPath(p, []);
  if (foreign(file)) return [];
  try {
    // The REAL path has to be inside the project: a `.vscode` that is a link to somewhere else is not
    // this project's file (reflex 13).
    if (!isInside(file, projectPath)) return [];
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return [];
    const doc = parseTasksText(await fs.promises.readFile(file, 'utf8'));
    return doc ? rowsFromTasksJson(doc, projectPath) : [];
  } catch {
    return [];
  }
}

/** `guards.isForeignNetworkFile` is main.js's network-path guard, which knows the registered projects. */
function registerIpc(ipcMain, guards = {}) {
  ipcMain.handle('get-vscode-tasks', (_event, projectPath) => readVscodeTasks(projectPath, guards));
}

module.exports = { readVscodeTasks, rowsFromTasksJson, parseTasksText, substitute, registerIpc, MAX_BYTES };
