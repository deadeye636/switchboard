// app/forge-issues.js — a project's GitHub or GitLab issues, read-only (#816, spec 42).
//
// Read through the `gh` and `glab` CLIs: the login stays with the CLI and the app stores no token. Asked when the
// Tasks & notes view or the session sidebar's group opens and on a refresh, never on a timer, and nothing is stored. The answer says why when
// there is no list, because a missing CLI, a missing login and a remote that fits nobody need different moves.
//
// Which provider, which remote and whether it is on come from the cascade; the binary paths are global only,
// because a path belongs to the machine. A binary is never started through a shell, which is why a `.cmd` shim is
// refused by name rather than failing as "not found".
//
// **A CLI is started WITHOUT the project as its working directory, and that is a security property.** On Windows the
// search for a bare `gh` looks in the child's cwd before PATH, so a repository holding its own `gh.exe` would have
// it run as soon as Tasks & notes opens. Measured under node and Electron. `-R` names the repository instead.
//
// The filters (#830): the state and the two "me" toggles go to the CLI, because the list is capped and a closed issue
// or someone else's never reaches a local filter. One answer per project and query is held for a short while here,
// so the sidebar, the Tasks view and every window share one CLI start. The text and the label filter in the window.
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { closeProbeStdin } = require('./terminal/shell-profiles');

const LIST_LIMIT = 100;
const BODY_LIMIT = 64 * 1024;
const CLI_TIMEOUT_MS = 20000;
const GIT_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 32 * 1024 * 1024;
// How long one answer per project and query is held, and how long a failed "who am I" is believed.
const CACHE_MS = 30000;
const ME_RETRY_MS = 5 * 60 * 1000;

const stringOr = (v) => (typeof v === 'string' ? v : '');
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : '');
const timeOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
// A user name goes into an argument, so one that could read as a flag is no name.
const userName = (v) => (typeof v === 'string' && /^[\w.][\w.-]*$/.test(v) ? v : '');

const STATES = ['open', 'closed', 'all'];
// What the window may ask for. Anything else is the default, so a stale or foreign value never reaches an argument.
function normalizeQuery(query) {
  const q = query && typeof query === 'object' ? query : {};
  return {
    state: STATES.includes(q.state) ? q.state : 'open',
    assignee: q.assignee === true,
    author: q.author === true,
  };
}

// An issue's state in the app's words; GitLab says `opened`, gh says `OPEN`.
function stateOf(v) {
  const s = stringOr(v).toLowerCase();
  if (s === 'open' || s === 'opened') return 'open';
  if (s === 'closed') return 'closed';
  return '';
}

const FORGES = {
  github: {
    label: 'GitHub',
    cli: 'gh',
    pathSetting: 'forgeGhPath',
    login: 'gh auth login',
    // gh takes exactly OWNER/REPO, with the host in front for anything but github.com.
    repoArg: ({ host, path: repo }) => (repo.split('/').length !== 2 ? null : host === 'github.com' ? repo : `${host}/${repo}`),
    // gh answers `@me` for both toggles itself, so it needs no name.
    needsMe: false,
    listArgs: (repo, query = normalizeQuery()) => [
      'issue', 'list', '-R', repo, '--state', query.state, '-L', String(LIST_LIMIT),
      ...(query.assignee ? ['--assignee', '@me'] : []),
      ...(query.author ? ['--author', '@me'] : []),
      '--json', 'number,title,labels,author,updatedAt,url,body,state',
    ],
    fromRow: (row) => ({
      number: row.number,
      title: row.title,
      labels: Array.isArray(row.labels) ? row.labels.map((l) => l && l.name) : [],
      author: row.author && row.author.login,
      updatedAt: row.updatedAt,
      url: row.url,
      body: row.body,
      state: row.state,
    }),
  },
  gitlab: {
    label: 'GitLab',
    cli: 'glab',
    pathSetting: 'forgeGlabPath',
    login: 'glab auth login',
    // glab takes a full URL, which is also what names a self-hosted instance and a nested group.
    repoArg: ({ host, path: repo, http }) => `${http ? 'http' : 'https'}://${host}/${repo}`,
    // glab's `--author` takes a user name and documents no `@me` (`--assignee` does), so "opened by me" needs the
    // name first. Without one the toggle is left out.
    needsMe: true,
    meArgs: (host) => ['api', 'user', '--hostname', host],
    meFrom: (stdout) => { try { return userName(JSON.parse(stdout).username); } catch { return ''; } },
    listArgs: (repo, query = normalizeQuery(), me = '') => [
      'issue', 'list', '-R', repo, '--output', 'json', '--per-page', String(LIST_LIMIT),
      ...(query.state === 'closed' ? ['--closed'] : query.state === 'all' ? ['--all'] : []),
      ...(query.assignee ? ['--assignee=@me'] : []),
      ...(query.author && userName(me) ? [`--author=${me}`] : []),
    ],
    fromRow: (row) => ({
      number: row.iid,
      title: row.title,
      labels: row.labels,
      author: row.author && row.author.username,
      updatedAt: row.updated_at,
      url: row.web_url,
      body: row.description,
      state: row.state,
    }),
  },
};

// Host and project path of a remote URL, or null. Credentials in a URL are dropped here and go nowhere. A segment
// out of a git config is input, so one that could read as a flag or leave the path is refused.
function parseRemoteUrl(url) {
  const text = String(url || '').trim();
  let host;
  let rawPath;
  let http = false;
  const scp = /^(?:[^@/\s]+@)?([\w.-]+):(?!\/)(.+)$/.exec(text);
  if (/^[a-z+]+:\/\//i.test(text)) {
    let u;
    try { u = new URL(text); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(u.protocol)) return null;
    host = /^https?:$/.test(u.protocol) ? u.host : u.hostname;
    http = u.protocol === 'http:';
    try { rawPath = decodeURIComponent(u.pathname); } catch { return null; }
  } else if (scp && scp[1].length > 1) { // one letter is a drive, not a host
    [, host, rawPath] = scp;
  } else {
    return null;
  }
  host = host.toLowerCase();
  // Each service's SSH-over-443 name is not where its web and its API live.
  if (host === 'ssh.github.com') host = 'github.com';
  if (host === 'altssh.gitlab.com') host = 'gitlab.com';
  const segments = rawPath.replace(/\.git\/?$/i, '').split('/').filter(Boolean);
  if (segments.length < 2 || !segments.every((s) => /^[\w.~-]+$/.test(s) && !s.startsWith('-') && s !== '.' && s !== '..')) return null;
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || host.startsWith('-')) return null;
  return http ? { host, path: segments.join('/'), http } : { host, path: segments.join('/') };
}

// What `auto` decides from a host; a self-hosted name that says neither needs the setting.
function providerForHost(host) {
  const name = String(host || '').split(':')[0];
  if (name === 'github.com' || name.endsWith('.github.com')) return 'github';
  if (name === 'gitlab.com' || /(^|[.-])gitlab([.-])/.test(name)) return 'gitlab';
  return null;
}

function normalizeRows(forge, rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const i = forge.fromRow(row || {});
    return {
      number: Number.isFinite(i.number) ? i.number : null,
      title: stringOr(i.title),
      labels: (Array.isArray(i.labels) ? i.labels : []).filter((l) => typeof l === 'string'),
      author: stringOr(i.author),
      updatedAt: timeOf(i.updatedAt),
      url: httpUrl(i.url),
      body: stringOr(i.body).slice(0, BODY_LIMIT),
      state: stateOf(i.state),
    };
  }).filter((i) => i.number != null && i.title);
}

// The binary to start, or a refusal. `.cmd` and `.bat` need a shell on Windows, and nothing here starts one. A
// relative path would mean something different depending on who is asking, so a path is absolute or a bare name.
function resolveBinary(forge, globalSettings) {
  const configured = stringOr((globalSettings || {})[forge.pathSetting]).trim();
  if (configured && (/[\\/]/.test(configured) || /^[a-z]:/i.test(configured)) && !path.isAbsolute(configured)) {
    return { reason: 'bad-path', message: `The ${forge.cli} path has to be absolute.` };
  }
  if (/\.(cmd|bat)$/i.test(configured)) {
    return { reason: 'shim', message: `A .cmd or .bat file cannot be started without a shell. Point the ${forge.cli} path at the executable.` };
  }
  return { file: configured || forge.cli };
}

// The user and password of a URL, up to the last @ before the path, because a password can hold one.
const withoutCredentials = (text) => text.replace(/\/\/[^\s/]*@/g, '//');

// Why a CLI run failed, in words that name no local path. A CLI's stderr can hold one, so its first line is used
// only when it does not look like one.
function classifyFailure(forge, err, stderr) {
  if (err && err.code === 'ENOENT') {
    return { reason: 'missing', message: `${forge.cli} was not found as an executable. Install it, or set its path in Settings > Projects & sidebar.` };
  }
  const text = stringOr(stderr);
  if (/auth login|not logged|\blog in\b|logged in|unauthori[sz]ed|\b401\b|authentication/i.test(text)) {
    return { reason: 'login', message: `${forge.cli} is not logged in here. Run: ${forge.login}` };
  }
  if (err && (err.killed || err.code === 'ETIMEDOUT')) {
    return { reason: 'failed', message: `${forge.cli} did not answer in time.` };
  }
  // glab's first line can be the bare word ERROR, with the reason below it.
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^(error|fatal|warning):?$/i.test(l)) || '';
  const clean = withoutCredentials(line);
  // A web URL is useful and stays. Anything else that reads as a path does not.
  const pathLike = /(^|[^a-z])[a-z]:[\\/]|\\|file:\/|(^|[^\w:/.-])\.{0,2}~?\/{1,2}[\w.-]+|(^|\w):\/(?!\/)[\w.-]+/i.test(clean.replace(/\bhttps?:\/\/\S+/gi, ''));
  return { reason: 'failed', message: clean && !pathLike ? `${forge.cli}: ${clean.slice(0, 200)}` : `${forge.cli} could not read the issues.` };
}

let ctx;
// Project and query to { at, promise }; a host's user name to { at, promise, name }. Both start empty with every init.
const answers = new Map();
const names = new Map();
function init(context) { ctx = context; answers.clear(); names.clear(); }

// execFile as a promise, its stdin closed (#541). Never with a `cwd`: see the header.
function run(file, args, timeout) {
  return new Promise((resolve) => {
    closeProbeStdin((ctx.execFile || execFile)(file, args, { windowsHide: true, maxBuffer: MAX_OUTPUT, timeout }, (err, stdout, stderr) => {
      if (err && ctx.log) ctx.log.debug('[forge-issues]', file, args[0], err.code ?? '', withoutCredentials(stringOr(stderr)).slice(0, 2000));
      resolve({ err, stdout: stringOr(stdout), stderr: stringOr(stderr) });
    }));
  });
}

// The refusal of a binary or a project on someone else's share (#780): starting or reading it is the SMB connection.
function binaryFor(forge, globalSettings) {
  const binary = resolveBinary(forge, globalSettings);
  if (binary.file && ctx.isForeignNetworkFile && /[\\/]/.test(binary.file) && ctx.isForeignNetworkFile(binary.file)) {
    return { reason: 'bad-path', message: `The ${forge.cli} path is on a network share this app has no project on.` };
  }
  return binary;
}

// The user name glab's `--author` needs, once per binary and host. A failure is believed for a while, so a project
// whose server cannot say is not asked again on every list; a name, once read, is kept. The reload button (`force`)
// asks again, which is what picks up a login or an account switch made in a terminal.
function nameFor(forge, file, host, force) {
  const key = `${file}\0${host}`;
  const held = names.get(key);
  if (held && !force && (held.name || Date.now() - held.at < ME_RETRY_MS)) return held.promise;
  const entry = { at: Date.now(), name: '' };
  entry.promise = run(file, forge.meArgs(host), CLI_TIMEOUT_MS).then((res) => {
    entry.name = res.err ? '' : forge.meFrom(res.stdout);
    return entry.name;
  });
  names.set(key, entry);
  return entry.promise;
}

// One answer per project and query for CACHE_MS, shared by every caller; `force` (the reload button) asks again. A
// failed answer is held only while it is in flight, so a login fixed in a terminal shows at the next open.
async function listIssues(projectPath, query, options) {
  const settings = ctx.effectiveSettings(projectPath);
  if (!projectPath || settings.forgeIssuesEnabled !== true) return { enabled: false };
  const q = normalizeQuery(query);
  // Read now: the await below can outlast the database at quit.
  const globalSettings = ctx.getSetting('global') || {};
  const key = JSON.stringify([projectPath, settings.forgeRemote, settings.forgeProvider,
    globalSettings.forgeGhPath, globalSettings.forgeGlabPath, q.state, q.assignee, q.author]);
  const now = Date.now();
  const held = answers.get(key);
  if (held && !(options && options.force === true) && now - held.at < CACHE_MS) return held.promise;
  for (const [k, v] of answers) if (now - v.at >= CACHE_MS) answers.delete(k);
  const force = !!(options && options.force === true);
  const promise = readIssues(projectPath, settings, globalSettings, q, force);
  answers.set(key, { at: now, promise });
  const drop = () => { if (answers.get(key) && answers.get(key).promise === promise) answers.delete(key); };
  promise.then((answer) => { if (!answer.ok) drop(); }, drop);
  return promise;
}

async function readIssues(projectPath, settings, globalSettings, query, force) {
  const refuse = (reason, message) => ({ enabled: true, ok: false, reason, message });
  if (ctx.isForeignNetworkFile && ctx.isForeignNetworkFile(projectPath)) return refuse('no-remote', 'This project is on a network share this app has no project on.');

  const remote = stringOr(settings.forgeRemote).trim() || 'origin';
  if (!/^[\w][\w./-]*$/.test(remote)) return refuse('no-remote', `"${remote}" is not a remote name.`);
  const got = await run('git', ['-C', projectPath, 'remote', 'get-url', remote], GIT_TIMEOUT_MS);
  if (got.err) return refuse('no-remote', `This project has no git remote "${remote}".`);
  const parsed = parseRemoteUrl(got.stdout.split(/\r?\n/)[0]);
  if (!parsed) return refuse('no-provider', `The remote "${remote}" is not a hosted repository.`);

  const providerId = settings.forgeProvider === 'github' || settings.forgeProvider === 'gitlab'
    ? settings.forgeProvider
    : providerForHost(parsed.host);
  if (!providerId) return refuse('no-provider', `Cannot tell whether ${parsed.host} is GitHub or GitLab. Choose the provider in this project's settings.`);
  const forge = FORGES[providerId];
  const repo = forge.repoArg(parsed);
  if (!repo) return refuse('no-provider', `The remote "${remote}" does not look like a ${forge.label} repository.`);

  const binary = binaryFor(forge, globalSettings);
  if (!binary.file) return refuse(binary.reason, binary.message);
  // The name is needed BEFORE the list only when the list filters by it; otherwise both run at once, so a slow
  // "who am I" does not hold up a list that does not use it.
  const naming = forge.needsMe ? nameFor(forge, binary.file, parsed.host, force) : Promise.resolve('');
  let me = '';
  let res;
  if (query.author) {
    me = await naming;
    res = await run(binary.file, forge.listArgs(repo, me || !forge.needsMe ? query : { ...query, author: false }, me), CLI_TIMEOUT_MS);
  } else {
    [me, res] = await Promise.all([naming, run(binary.file, forge.listArgs(repo, query, ''), CLI_TIMEOUT_MS)]);
  }
  // What this provider can filter on; a toggle it cannot answer is left out of the window and out of the argv.
  const supports = { state: true, assignee: true, author: !forge.needsMe || !!me };
  const asked = supports.author ? query : { ...query, author: false };
  if (res.err) return { enabled: true, ok: false, ...classifyFailure(forge, res.err, res.stderr) };
  let rows;
  try { rows = JSON.parse(res.stdout || '[]'); } catch { return refuse('failed', `${forge.cli} answered with something that is not a list of issues.`); }
  return {
    enabled: true, ok: true, provider: forge.label, repo: parsed.path, issues: normalizeRows(forge, rows),
    limit: LIST_LIMIT, query: asked, supports,
  };
}

// The test control in Settings. It runs the SAVED path and takes no path from the window, so this handler cannot
// be used to start an arbitrary file.
async function checkCli(providerId) {
  const forge = Object.prototype.hasOwnProperty.call(FORGES, providerId) ? FORGES[providerId] : null;
  if (!forge) return { ok: false, message: 'Unknown provider.' };
  const binary = binaryFor(forge, ctx.getSetting('global'));
  if (!binary.file) return { ok: false, message: binary.message };
  const res = await run(binary.file, ['--version'], CLI_TIMEOUT_MS);
  if (res.err) return { ok: false, message: classifyFailure(forge, res.err, res.stderr).message };
  return { ok: true, message: res.stdout.split(/\r?\n/)[0].slice(0, 120) };
}

function registerIpc(ipc) {
  ipc.handle('forge-issues-list', (_event, projectPath, query, options) => listIssues(projectPath, query, options));
  ipc.handle('forge-cli-check', (_event, providerId) => checkCli(providerId));
}

module.exports = {
  init, registerIpc, listIssues, checkCli,
  parseRemoteUrl, providerForHost, normalizeRows, normalizeQuery, resolveBinary, classifyFailure, FORGES,
};
