// scripts/seed-demo.js — seed a permanent, isolated demo store tree so the app can be launched against
// realistic-but-fake data that never touches ~/.claude, ~/.codex, ~/.pi or the real ~/.switchboard*.
//
// It writes ONLY under SWITCHBOARD_DEMO_DIR (default C:/temp/switchboard), the allowed test sandbox.
// Everything is IDEMPOTENT: a file that already exists is left exactly as it is — a rerun never
// overwrites, so hand-edits to the demo transcripts survive.
//
// The transcripts are minimal but VALID for each backend's real parser (see docs/backend-formats.md and
// each src/backends/<id>/parser.js). Seeded backends: Claude, Codex, Pi (the FILE backends). Hermes and
// agy stores are created EMPTY on purpose — an absent/empty store must degrade gracefully, and we do not
// fabricate a SQLite schema for them.
//
// Timestamps are derived from a FIXED base constant (no Date.now()) so the seed is deterministic: the same
// filenames and contents on every run, which is what makes idempotency exact.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeProjectPath } = require('../src/session/encode-project-path');

// ── Deterministic clock ──────────────────────────────────────────────────────
// Fixed base time — NOT Date.now(). Lines are spread a few seconds apart from here.
const BASE_MS = Date.parse('2026-07-15T10:00:00.000Z');
const iso = (offsetSec) => new Date(BASE_MS + offsetSec * 1000).toISOString();

// Fixed, valid-looking ids so reruns land on identical paths (part of idempotency).
const IDS = {
  claudeParent: '11111111-1111-4111-8111-111111111111',
  claudeChild: '22222222-2222-4222-8222-222222222222',
  pi: '33333333-3333-4333-8333-333333333333',
  codex: '44444444-4444-4444-8444-444444444444',
  // demo-chain: a three-deep Claude fork chain (head C forks B forks A) -> a "2 earlier" lineage thread.
  chainA: '55555555-5555-4555-8555-555555555555',
  chainB: '66666666-6666-4666-8666-666666666666',
  chainC: '77777777-7777-4777-8777-777777777777',
  // demo-mixed: three backends in ONE project (multi-backend badges + mixed provenance in one group).
  mixClaude: '88888888-8888-4888-8888-888888888888',
  mixCodex: '99999999-9999-4999-8999-999999999999',
  mixPi: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  // The one session with a transcript worth LOOKING at — thinking blocks, tool calls and results, and
  // a story that matches the working-tree state seedRepo leaves behind. Everything else here is two
  // lines long, which is enough to be indexed and not enough to be read.
  showcase: 'cafe0001-0000-4000-8000-000000000001',
};

// demo-alpha's Claude parent spawns three subagents of DIFFERENT types, so the subagent-row layouts and
// the per-type colour coding (#230/#231) are visible in the demo: general-purpose (grey), explore (green),
// review (blue). Each is agent-<id>.jsonl + an agent-<id>.meta.json sidecar under <parent>/subagents/.
const SUBAGENTS = [
  { id: 'gp01', type: 'general-purpose', task: 'Audit the demo-alpha config for gaps', msgs: 46 },
  { id: 'ex01', type: 'explore', task: 'Map the demo-alpha module layout', msgs: 18 },
  { id: 'rv01', type: 'review', task: 'Review the demo-alpha test coverage', msgs: 12 },
];

// demo-older exists to make the "+ N older" toggle appear at all: a project needs more sessions than the
// visible limit (10) before anything folds away. Eighteen sessions put eight below the fold, and three of
// those eight carry subagents — the shape #249 needs, because the subagent caret and its container are
// inserted into that same list as siblings, so counting the list's children counts them too.
//
// The sidebar sorts and ages sessions by the file's MTIME, not by the timestamps inside the transcript,
// so these get their mtime stamped from the same fixed base (below). Every one of them is older than the
// default 3-day age cut — set "Hide sessions older than (days)" to 0 in the demo to see the count limit
// do the folding instead, which is the interesting case.
const OLDER_COUNT = 18;
const OLDER_SUBAGENTS = { 11: 2, 13: 2, 15: 2 }; // rank (1 = newest) → how many subagents

// ── Small fs helpers ─────────────────────────────────────────────────────────
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Stamp a file's mtime from the fixed base — the sidebar sorts and ages on it, not on the transcript. */
function touch(filePath, offsetSec) {
  const d = new Date(BASE_MS + offsetSec * 1000);
  try { fs.utimesSync(filePath, d, d); } catch {}
}

/** Write only if absent. Returns 'created' or 'skipped' so the run can report what it did. */
function writeIfAbsent(filePath, content, created, skipped) {
  if (fs.existsSync(filePath)) {
    skipped.push(filePath);
    return 'skipped';
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  created.push(filePath);
  return 'created';
}

/** One JSON object per line, trailing newline — the JSONL shape every file backend appends. */
function jsonl(lines) {
  return lines.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

// ── Backend line builders (shapes verified against the real parsers) ─────────
// Claude: session id comes from the FILENAME; cwd + usage come from the lines. A user line sets the
// summary, an assistant line carries model + usage. A fork names its origin via forkedFrom.sessionId.
function claudeSession({ cwd, model, prompt, reply, t0, forkedFrom }) {
  const userLine = {
    type: 'user',
    cwd,
    timestamp: iso(t0),
    message: { role: 'user', content: prompt },
  };
  if (forkedFrom) userLine.forkedFrom = { sessionId: forkedFrom };
  return jsonl([
    userLine,
    {
      type: 'assistant',
      cwd,
      timestamp: iso(t0 + 4),
      message: {
        role: 'assistant',
        model,
        content: [{ type: 'text', text: reply }],
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100,
        },
      },
    },
  ]);
}

// Codex: two-layer { timestamp, type, payload }. Identity + cwd from session_meta; model from the LAST
// turn_context; usage from the LAST token_count; task_complete leaves the tail idle.
function codexRollout({ id = IDS.codex, cwd, model, prompt, reply, t0 }) {
  return jsonl([
    { timestamp: iso(t0), type: 'session_meta', payload: { id, cwd, timestamp: iso(t0), cli_version: '0.142.2', git: { branch: 'main' } } },
    { timestamp: iso(t0), type: 'turn_context', payload: { model } },
    { timestamp: iso(t0 + 2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: prompt }] } },
    { timestamp: iso(t0 + 6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: reply }] } },
    { timestamp: iso(t0 + 7), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2100, output_tokens: 560, cached_input_tokens: 400, total_tokens: 3060 }, model_context_window: 258000 } } },
    { timestamp: iso(t0 + 8), type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
}

// Pi: line 1 is the {type:'session'} header (authoritative id + cwd); turn payload is nested under
// .message; cost is an OBJECT with .total; the last assistant stopReason leaves the tail idle.
function piSession({ id = IDS.pi, cwd, model, provider, prompt, reply, t0 }) {
  return jsonl([
    { type: 'session', version: 3, id, timestamp: iso(t0), cwd },
    { type: 'model_change', provider, modelId: model, timestamp: iso(t0) },
    { type: 'message', timestamp: iso(t0 + 2), message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    {
      type: 'message',
      timestamp: iso(t0 + 5),
      message: {
        role: 'assistant',
        model,
        provider,
        stopReason: 'stop',
        content: [{ type: 'text', text: reply }],
        usage: {
          input: 1500,
          output: 420,
          cacheRead: 600,
          cacheWrite: 80,
          totalTokens: 2600,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0315 },
        },
      },
    },
  ]);
}

// The showcase transcript — a full Claude turn sequence: thinking, tool_use/tool_result pairs and a
// closing summary. It exists because every other seeded session is a two-liner: enough to be indexed,
// nothing to read. The work it describes is the SAME work `seedRepo` leaves in demo-alpha's working
// tree, so the transcript, the changes window and the task list all tell one story.
function showcaseSession({ cwd, model, t0 }) {
  const uid = (n) => `cafe${String(n).padStart(4, '0')}-0000-4000-8000-000000000001`;
  const user = (content, i) => ({
    parentUuid: i > 0 ? uid(i - 1) : null, isSidechain: false, type: 'user', cwd, uuid: uid(i),
    timestamp: iso(t0 + i * 12), message: { role: 'user', content },
  });
  const assistant = (content, i, usage) => ({
    parentUuid: uid(i - 1), isSidechain: false, type: 'assistant', cwd, uuid: uid(i),
    timestamp: iso(t0 + i * 12),
    message: { role: 'assistant', model, content, usage: usage || { input_tokens: 4200, output_tokens: 310, cache_read_input_tokens: 18400, cache_creation_input_tokens: 0 } },
  });
  const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const toolResult = (id, content) => [{ type: 'tool_result', tool_use_id: id, content }];

  return jsonl([
    user('Add a metrics collector to demo-alpha and wire it into start(). Keep it behind a config flag.', 0),
    assistant([
      { type: 'thinking', thinking: 'start() reads config.features, so a metrics flag belongs next to health rather than as a new top-level key. Read the entry point first — the shape of config decides where the call goes.' },
      { type: 'text', text: "I'll read the entry point and the config before changing anything." },
      toolUse('toolu_01', 'Read', { file_path: 'src/app.js' }),
    ], 1),
    user(toolResult('toolu_01', "'use strict';\n\n// demo-alpha entry point — fake demo code.\nfunction start(config) {\n  console.log('demo-alpha starting on port ' + config.port);\n  return { ok: true };\n}\n\nmodule.exports = { start };"), 2),
    assistant([
      { type: 'text', text: 'Straightforward. The collector goes in its own module so `start()` only has to decide whether to call it.' },
      toolUse('toolu_02', 'Write', { file_path: 'src/metrics.js', content: "'use strict';\n\nfunction collect() {\n  return { uptime: 0, requests: 0 };\n}\n\nmodule.exports = { collect };\n" }),
    ], 3),
    user(toolResult('toolu_02', 'File created successfully at: src/metrics.js'), 4),
    assistant([
      toolUse('toolu_03', 'Edit', { file_path: 'src/app.js', old_string: '  return { ok: true };', new_string: '  if (config.features.metrics) startMetrics(config);\n  return { ok: true, startedAt: null };' }),
    ], 5),
    user(toolResult('toolu_03', 'The file src/app.js has been updated successfully.'), 6),
    assistant([
      { type: 'text', text: 'Wired up. `features.metrics` is off in the committed config, so nothing changes until it is switched on.' },
      toolUse('toolu_04', 'Bash', { command: 'node -e "require(\'./src/app\').start(require(\'./src/config.json\'))"', description: 'Smoke-test the entry point' }),
    ], 7),
    user(toolResult('toolu_04', 'demo-alpha starting on port 8080\nmetrics enabled for demo-alpha'), 8),
    assistant([
      { type: 'text', text: 'Done:\n\n- `src/metrics.js` — the collector, staged.\n- `src/app.js` — calls it when `features.metrics` is set.\n- `src/config.json` — flag added, on for local runs.\n\nThe routes module is now unreferenced. Want me to drop it?' },
    ], 9),
    user('Yes, drop it. And move the notes file into docs/design-notes.md while you are there.', 10),
    assistant([
      toolUse('toolu_05', 'Bash', { command: 'git mv docs/notes.md docs/design-notes.md && rm src/routes.js', description: 'Rename the notes file and remove the unused routes module' }),
    ], 11),
    user(toolResult('toolu_05', ''), 12),
    assistant([
      { type: 'text', text: 'Both done. The working tree now holds two modified files, one staged addition, one untracked test, a rename and a deletion — nothing committed yet, so you can review the whole change set before it lands.' },
    ], 13, { input_tokens: 5100, output_tokens: 240, cache_read_input_tokens: 31200, cache_creation_input_tokens: 1800 }),
  ]);
}

// A Claude subagent transcript (a sidechain): `isSidechain` + `agentId` mark it as one, messageCount comes
// from the message lines, and the type + task live in the agent-<id>.meta.json sidecar the reader reads.
function subagentTranscript({ agentId, cwd, model, task, reply, t0 }) {
  return jsonl([
    { type: 'user', isSidechain: true, agentId, cwd, timestamp: iso(t0), message: { role: 'user', content: task } },
    { type: 'assistant', isSidechain: true, agentId, cwd, timestamp: iso(t0 + 3),
      message: { role: 'assistant', model, content: [{ type: 'text', text: reply }], usage: { input_tokens: 400, output_tokens: 120 } } },
  ]);
}

// ── Project working-dir context files (so the Memory tab has something once #227 lands) ──────────────
function readmeFor(name) {
  return `# ${name}\n\nA demo project working directory for Switchboard's isolated demo environment.\nIt holds no real code — it exists so the app has a project to render sessions and memory against.\n`;
}
function claudeMdFor(name) {
  return `# CLAUDE.md\n\nGuidance for AI agents working in the ${name} demo project. This is fake demo content.\n\n- Keep changes minimal.\n- This directory is disposable; it lives under the demo sandbox.\n`;
}
function agentsMdFor(name) {
  return `# AGENTS.md\n\nAgent instructions for the ${name} demo project. This is fake demo content used only to\npopulate Switchboard's Memory tab in the demo environment.\n`;
}

// ── Demo git repositories (#277 / the changes window) ────────────────────────
// A session's working directory is usually a repo, and the VCS glyph, the branch badge and the
// changes window have nothing to show unless one is there. So two of the demo projects ARE repos,
// each with a first commit and then a deliberate working-tree state that covers every row the
// window renders: modified, added (untracked), staged, renamed and deleted.
//
// The commits are made with an EXPLICIT demo identity (`-c user.name=…`), never the machine's git
// config: the demo tree is screenshot material for a public README, and the committer is the one
// piece of personal data git would otherwise put there without being asked. The address is a bare
// word rather than a domain — git does not require one, and a demo has no mailbox to point at.
const GIT_ID = ['-c', 'user.name=Switchboard Demo', '-c', 'user.email=demo'];

/** Extra tracked sources per repo project, so a diff has something to be a diff OF. */
const REPO_FILES = {
  'demo-alpha': {
    'src/app.js': "'use strict';\n\n// demo-alpha entry point — fake demo code.\nfunction start(config) {\n  console.log('demo-alpha starting on port ' + config.port);\n  return { ok: true };\n}\n\nmodule.exports = { start };\n",
    'src/config.json': '{\n  "name": "demo-alpha",\n  "port": 8080,\n  "features": {\n    "health": true\n  }\n}\n',
    'src/routes.js': "'use strict';\n\n// Route table for demo-alpha.\nconst routes = [\n  { method: 'GET', path: '/', handler: 'index' },\n];\n\nmodule.exports = { routes };\n",
    'docs/notes.md': '# Notes\n\nScratch notes for the demo-alpha project. Nothing here is real.\n',
  },
  'demo-mixed': {
    'src/api.js': "'use strict';\n\n// demo-mixed API surface — fake demo code.\nmodule.exports = { list: () => [], get: (id) => ({ id }) };\n",
    'ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo demo\n',
  },
};

/**
 * The working-tree state each repo is left in — what the changes window paints.
 * `edit` rewrites a tracked file (modified), `add` writes an untracked one, `stage` writes and
 * `git add`s it, `rename` is a staged `git mv`, `remove` deletes a tracked file.
 */
const REPO_STATE = {
  'demo-alpha': [
    { op: 'edit', file: 'src/app.js', content: "'use strict';\n\n// demo-alpha entry point — fake demo code.\nfunction start(config) {\n  console.log('demo-alpha starting on port ' + config.port);\n  if (config.features.metrics) startMetrics(config);\n  return { ok: true, startedAt: null };\n}\n\nfunction startMetrics(config) {\n  console.log('metrics enabled for ' + config.name);\n}\n\nmodule.exports = { start, startMetrics };\n" },
    { op: 'edit', file: 'src/config.json', content: '{\n  "name": "demo-alpha",\n  "port": 8080,\n  "features": {\n    "health": true,\n    "metrics": true\n  }\n}\n' },
    { op: 'stage', file: 'src/metrics.js', content: "'use strict';\n\n// Metrics collector for demo-alpha — staged, not yet committed.\nfunction collect() {\n  return { uptime: 0, requests: 0 };\n}\n\nmodule.exports = { collect };\n" },
    { op: 'add', file: 'src/metrics.test.js', content: "'use strict';\n\n// Untracked: a test for the metrics collector.\nconst { collect } = require('./metrics');\nconsole.log(collect());\n" },
    { op: 'rename', file: 'docs/notes.md', to: 'docs/design-notes.md' },
    { op: 'remove', file: 'src/routes.js' },
  ],
  'demo-mixed': [
    { op: 'edit', file: 'src/api.js', content: "'use strict';\n\n// demo-mixed API surface — fake demo code.\nmodule.exports = {\n  list: () => [],\n  get: (id) => ({ id }),\n  create: (body) => ({ id: 'new', ...body }),\n};\n" },
    { op: 'add', file: 'src/api.test.js', content: "'use strict';\n\n// Untracked: covers the new create() route.\nconsole.log(require('./api').create({ name: 'demo' }));\n" },
  ],
};

/** Run git in `cwd`. Returns true on success, false if git is absent or the command failed. */
function git(cwd, args) {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a seeded project dir into a git repo with a first commit and a dirty working tree.
 * Idempotent by the same rule as everything else here: a project that already has `.git` is left
 * exactly as it is, so hand-made demo commits survive a reseed.
 */
function seedRepo(dir, name, created, skipped) {
  const extras = REPO_FILES[name] || {};
  if (fs.existsSync(path.join(dir, '.git'))) {
    skipped.push(path.join(dir, '.git'));
    return;
  }

  // The committed baseline.
  for (const [rel, content] of Object.entries(extras)) {
    writeIfAbsent(path.join(dir, rel), content, created, skipped);
  }
  if (!git(dir, ['init', '-b', 'main'])) return; // no git on PATH — the rest of the seed still stands
  git(dir, ['add', '-A']);
  git(dir, [...GIT_ID, 'commit', '-m', `chore: seed the ${name} demo project`]);

  // The working-tree state on top of it.
  for (const step of REPO_STATE[name] || []) {
    const abs = path.join(dir, step.file);
    if (step.op === 'edit' || step.op === 'add' || step.op === 'stage') {
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, step.content);
      if (step.op === 'stage') git(dir, ['add', '--', step.file]);
    } else if (step.op === 'rename') {
      git(dir, ['mv', '--', step.file, step.to]);
    } else if (step.op === 'remove') {
      try { fs.unlinkSync(abs); } catch { /* already gone */ }
    }
  }
  created.push(path.join(dir, '.git'));
}

// ── The seed ─────────────────────────────────────────────────────────────────
function resolveDemoDir() {
  return (process.env.SWITCHBOARD_DEMO_DIR || 'C:/temp/switchboard').replace(/\\/g, '/');
}

/**
 * Build the demo layout under `demoDir`. Returns { demoDir, paths, created, skipped }.
 * Never overwrites — see writeIfAbsent.
 */
function seedDemo(demoDir = resolveDemoDir()) {
  const fwd = demoDir.replace(/\\/g, '/');

  // The project working dirs as they appear in the transcripts' `cwd`. NATIVE separators, because that is
  // what the real CLI writes — measured (#241): a live Claude session in the demo records the demo dir
  // with BACKSLASHES, and the forward-slash form this used to seed made the SAME folder look like two
  // different projects (a project bucket is keyed on the cwd string). The seeded sessions sat in one group
  // and anything actually launched in the demo in another, unregistered one that the sidebar never showed.
  // JSON.stringify escapes the backslashes; the `\t` trap the old comment feared is not a real one.
  const projectAlpha = path.join(demoDir, 'projects', 'demo-alpha');
  const projectBeta = path.join(demoDir, 'projects', 'demo-beta');

  const paths = {
    demoDir: fwd,
    storeClaude: path.join(demoDir, 'stores', 'claude', 'projects'),
    storeCodex: path.join(demoDir, 'stores', 'codex', 'sessions'),
    storePi: path.join(demoDir, 'stores', 'pi'),
    storeHermes: path.join(demoDir, 'stores', 'hermes'),
    storeAgy: path.join(demoDir, 'stores', 'agy'),
    projectAlpha: path.join(demoDir, 'projects', 'demo-alpha'),
    projectBeta: path.join(demoDir, 'projects', 'demo-beta'),
  };

  const created = [];
  const skipped = [];

  // Store roots (Hermes + agy stay empty on purpose).
  for (const dir of [paths.storeClaude, paths.storeCodex, paths.storePi, paths.storeHermes, paths.storeAgy]) {
    ensureDir(dir);
  }

  // The extra standard projects (see docs/demo-env.md for the full catalogue).
  const projectMixed = path.join(demoDir, 'projects', 'demo-mixed');
  const projectChain = path.join(demoDir, 'projects', 'demo-chain');
  const projectOlder = path.join(demoDir, 'projects', 'demo-older');
  paths.projectMixed = path.join(demoDir, 'projects', 'demo-mixed');
  paths.projectChain = path.join(demoDir, 'projects', 'demo-chain');
  paths.projectOlder = path.join(demoDir, 'projects', 'demo-older');

  // Project working dirs + context files.
  for (const [dir, name] of [
    [paths.projectAlpha, 'demo-alpha'], [paths.projectBeta, 'demo-beta'],
    [paths.projectMixed, 'demo-mixed'], [paths.projectChain, 'demo-chain'],
    [paths.projectOlder, 'demo-older'],
  ]) {
    ensureDir(dir);
    writeIfAbsent(path.join(dir, 'README.md'), readmeFor(name), created, skipped);
    writeIfAbsent(path.join(dir, 'CLAUDE.md'), claudeMdFor(name), created, skipped);
    writeIfAbsent(path.join(dir, 'AGENTS.md'), agentsMdFor(name), created, skipped);
    if (REPO_FILES[name]) seedRepo(dir, name, created, skipped);
  }

  // Placement helpers (same layout each backend's real store uses).
  const claudeFile = (project, sid) => path.join(paths.storeClaude, encodeProjectPath(project), `${sid}.jsonl`);
  const piFile = (project, sid, tSec) =>
    path.join(paths.storePi, encodeProjectPath(project), `${iso(tSec).replace(/:/g, '-').replace('.', '-')}_${sid}.jsonl`);
  const codexFile = (sid, tSec) => {
    const d = new Date(BASE_MS + tSec * 1000);
    const dir = path.join(paths.storeCodex, String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    return path.join(dir, `rollout-${iso(tSec).slice(0, 19).replace(/:/g, '-')}-${sid}.jsonl`);
  };

  // Claude: two sessions under demo-alpha, the second a FORK of the first (lineage "▶ earlier" thread).
  const claudeFolder = path.join(paths.storeClaude, encodeProjectPath(projectAlpha));
  writeIfAbsent(
    path.join(claudeFolder, `${IDS.claudeParent}.jsonl`),
    claudeSession({
      cwd: projectAlpha,
      model: 'claude-opus-4-6',
      prompt: 'Set up the demo-alpha project skeleton with a README and a config file.',
      reply: 'Created the project skeleton: added README.md and a starter config.',
      t0: 0,
    }),
    created, skipped,
  );
  writeIfAbsent(
    path.join(claudeFolder, `${IDS.claudeChild}.jsonl`),
    claudeSession({
      cwd: projectAlpha,
      model: 'claude-opus-4-6',
      prompt: 'Fork of the setup session: add a small test harness to demo-alpha.',
      reply: 'Forked the earlier session and wired up a minimal test harness.',
      t0: 600,
      forkedFrom: IDS.claudeParent,
    }),
    created, skipped,
  );

  // The showcase session — newest in demo-alpha (8 days past the base) so it sorts to the top of the
  // sidebar, which is where a reader's eye lands first.
  const showcaseT0 = 8 * 24 * 3600;
  const showcaseFile = path.join(claudeFolder, `${IDS.showcase}.jsonl`);
  if (writeIfAbsent(
    showcaseFile,
    showcaseSession({ cwd: projectAlpha, model: 'claude-opus-4-6', t0: showcaseT0 }),
    created, skipped,
  ) === 'created') touch(showcaseFile, showcaseT0 + 200);

  // Codex: one session under demo-beta, in the YYYY/MM/DD bucket its start time falls in.
  const bkt = new Date(BASE_MS);
  const codexDateDir = path.join(
    paths.storeCodex,
    String(bkt.getUTCFullYear()),
    String(bkt.getUTCMonth() + 1).padStart(2, '0'),
    String(bkt.getUTCDate()).padStart(2, '0'),
  );
  const codexStamp = iso(0).slice(0, 19).replace(/:/g, '-'); // 2026-07-15T10-00-00
  writeIfAbsent(
    path.join(codexDateDir, `rollout-${codexStamp}-${IDS.codex}.jsonl`),
    codexRollout({
      cwd: projectBeta,
      model: 'gpt-5-codex',
      prompt: 'Add a health-check endpoint to demo-beta.',
      reply: 'Added a /health route that returns 200 OK.',
      t0: 0,
    }),
    created, skipped,
  );

  // Pi: one session under demo-alpha. Folder name is cosmetic (Pi reads cwd from the header), so we reuse
  // the same central encoding for a tidy tree.
  const piStamp = iso(0).replace(/:/g, '-').replace('.', '-'); // 2026-07-15T10-00-00-000Z
  const piFolder = path.join(paths.storePi, encodeProjectPath(projectAlpha));
  writeIfAbsent(
    path.join(piFolder, `${piStamp}_${IDS.pi}.jsonl`),
    piSession({
      cwd: projectAlpha,
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      prompt: 'Explain the demo-alpha architecture in two sentences.',
      reply: 'demo-alpha is a minimal demo project. It holds a README plus CLAUDE.md and AGENTS.md context files.',
      t0: 0,
    }),
    created, skipped,
  );

  // demo-mixed: Claude + Codex + Pi in the SAME project — the multi-backend badges and mixed provenance in
  // one sidebar group.
  writeIfAbsent(
    claudeFile(projectMixed, IDS.mixClaude),
    claudeSession({ cwd: projectMixed, model: 'claude-opus-4-6', prompt: 'Draft the demo-mixed API surface.', reply: 'Sketched the API surface for demo-mixed.', t0: 0 }),
    created, skipped,
  );
  writeIfAbsent(
    codexFile(IDS.mixCodex, 120),
    codexRollout({ id: IDS.mixCodex, cwd: projectMixed, model: 'gpt-5-codex', prompt: 'Wire demo-mixed CI.', reply: 'Added a CI workflow to demo-mixed.', t0: 120 }),
    created, skipped,
  );
  writeIfAbsent(
    piFile(projectMixed, IDS.mixPi, 240),
    piSession({ id: IDS.mixPi, cwd: projectMixed, model: 'claude-opus-4-7', provider: 'anthropic', prompt: 'Review the demo-mixed changes.', reply: 'Reviewed - the API and CI look consistent.', t0: 240 }),
    created, skipped,
  );

  // demo-chain: a three-deep Claude fork chain (C forks B forks A) — the folded "2 earlier" lineage thread.
  writeIfAbsent(
    claudeFile(projectChain, IDS.chainA),
    claudeSession({ cwd: projectChain, model: 'claude-opus-4-6', prompt: 'Start the demo-chain migration plan.', reply: 'Outlined the migration plan.', t0: 0 }),
    created, skipped,
  );
  writeIfAbsent(
    claudeFile(projectChain, IDS.chainB),
    claudeSession({ cwd: projectChain, model: 'claude-opus-4-6', prompt: 'Fork: refine the migration plan.', reply: 'Refined the plan and added rollback steps.', t0: 300, forkedFrom: IDS.chainA }),
    created, skipped,
  );
  writeIfAbsent(
    claudeFile(projectChain, IDS.chainC),
    claudeSession({ cwd: projectChain, model: 'claude-opus-4-6', prompt: 'Fork again: execute the migration.', reply: 'Executed the migration per the refined plan.', t0: 600, forkedFrom: IDS.chainB }),
    created, skipped,
  );

  // Subagents under demo-alpha's Claude parent — three types so the row layouts + colour coding show (#231).
  const subDir = path.join(paths.storeClaude, encodeProjectPath(projectAlpha), IDS.claudeParent, 'subagents');
  SUBAGENTS.forEach((s, i) => {
    writeIfAbsent(
      path.join(subDir, `agent-${s.id}.jsonl`),
      subagentTranscript({ agentId: s.id, cwd: projectAlpha, model: 'claude-opus-4-6', task: s.task, reply: `Completed: ${s.task}.`, t0: 30 + i * 5 }),
      created, skipped,
    );
    writeIfAbsent(
      path.join(subDir, `agent-${s.id}.meta.json`),
      JSON.stringify({ agentType: s.type, description: s.task }, null, 2) + '\n',
      created, skipped,
    );
  });

  // demo-older: eighteen Claude sessions, one per hour walking backwards from the base, so the sidebar
  // has more than the visible limit and folds the rest behind "+ N older".
  const olderFolder = path.join(paths.storeClaude, encodeProjectPath(projectOlder));
  for (let rank = 1; rank <= OLDER_COUNT; rank++) {
    const pad = String(rank).padStart(2, '0');
    const sid = `ba5e${pad}00-0000-4000-8000-${pad.padStart(12, '0')}`;
    const t0 = -rank * 3600;
    const file = claudeFile(projectOlder, sid);
    if (writeIfAbsent(
      file,
      claudeSession({
        cwd: projectOlder,
        model: 'claude-opus-4-6',
        prompt: `Demo session ${pad}: a routine change in demo-older.`,
        reply: `Handled demo session ${pad}. Nothing here is real work.`,
        t0,
      }),
      created, skipped,
    ) === 'created') touch(file, t0);

    // Subagents only on ranks that fall below the fold — that is what #249 needs to reproduce.
    const subCount = OLDER_SUBAGENTS[rank] || 0;
    for (let n = 1; n <= subCount; n++) {
      const agentId = `d${pad}${n}`;
      const subFile = path.join(olderFolder, sid, 'subagents', `agent-${agentId}.jsonl`);
      if (writeIfAbsent(
        subFile,
        subagentTranscript({
          agentId,
          cwd: projectOlder,
          model: 'claude-opus-4-6',
          task: `Sub-task ${n} of demo session ${pad}`,
          reply: `Finished sub-task ${n} of demo session ${pad}.`,
          t0: t0 + n * 60,
        }),
        created, skipped,
      ) === 'created') touch(subFile, t0 + n * 60);
      writeIfAbsent(
        path.join(olderFolder, sid, 'subagents', `agent-${agentId}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose', description: `Sub-task ${n} of demo session ${pad}` }, null, 2) + '\n',
        created, skipped,
      );
    }
  }

  return { demoDir: fwd, paths, created, skipped };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
function printReport({ demoDir, created, skipped }) {
  console.log(`demo seed → ${demoDir}`);
  console.log(`  created: ${created.length} file(s)`);
  console.log(`  skipped: ${skipped.length} existing file(s) (idempotent — never overwritten)`);
  for (const f of created) console.log(`    + ${f}`);
  if (created.length === 0) console.log('    (nothing new — the demo is already seeded)');
}

if (require.main === module) {
  try {
    printReport(seedDemo());
  } catch (err) {
    console.error(`seed-demo failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { seedDemo, resolveDemoDir, BASE_MS, IDS };
