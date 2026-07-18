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
};

// ── Small fs helpers ─────────────────────────────────────────────────────────
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

  // The two project working dirs, addressed with forward slashes INSIDE the JSON (avoids the \t escape
  // trap and matches how the CLIs record cwd on Windows).
  const projectAlpha = `${fwd}/projects/demo-alpha`;
  const projectBeta = `${fwd}/projects/demo-beta`;

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

  // The two extra standard projects (see docs/demo-env.md for the full catalogue).
  const projectMixed = `${fwd}/projects/demo-mixed`;
  const projectChain = `${fwd}/projects/demo-chain`;
  paths.projectMixed = path.join(demoDir, 'projects', 'demo-mixed');
  paths.projectChain = path.join(demoDir, 'projects', 'demo-chain');

  // Project working dirs + context files.
  for (const [dir, name] of [
    [paths.projectAlpha, 'demo-alpha'], [paths.projectBeta, 'demo-beta'],
    [paths.projectMixed, 'demo-mixed'], [paths.projectChain, 'demo-chain'],
  ]) {
    ensureDir(dir);
    writeIfAbsent(path.join(dir, 'README.md'), readmeFor(name), created, skipped);
    writeIfAbsent(path.join(dir, 'CLAUDE.md'), claudeMdFor(name), created, skipped);
    writeIfAbsent(path.join(dir, 'AGENTS.md'), agentsMdFor(name), created, skipped);
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
