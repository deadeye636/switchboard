// scripts/demo-content.js — seed the DEMO instance's DATABASE content: project tags, session tags
// and tasks.
//
// `seed-demo.js` writes files (transcripts, project dirs, git repos); everything here lives in
// `switchboard.db` instead and therefore cannot be seeded the same way. Without it the tag filter
// bar and the task list are empty in the demo, which is exactly what a screenshot of them must not
// show.
//
// Runs UNDER ELECTRON-AS-NODE for the same reason `demo-settings.js` does — `better-sqlite3` is
// built against Electron's ABI:
//
//   ELECTRON_RUN_AS_NODE=1 <electron> scripts/demo-content.js
//
// `scripts/demo-start.js` does that before launching. Idempotent: it writes nothing once any tag
// definition exists, so tags you rename or recolour by hand in the demo survive a reseed.
'use strict';

const path = require('path');
// The demo root resolves in exactly ONE place — seed-demo.js owns the default, and duplicating the
// literal here would be a second thing to keep in step.
const { resolveDemoDir } = require('./seed-demo');

const dataDir = process.env.SWITCHBOARD_DATA_DIR || '';
const demoDir = resolveDemoDir();

// GUARD: identical to demo-settings.js — this writes rows, so it must never run against a real
// install. Being inside the demo tree is the test; a set SWITCHBOARD_DATA_DIR alone is not.
const normalized = dataDir.replace(/\\/g, '/');
if (!normalized || !normalized.toLowerCase().startsWith(demoDir.toLowerCase())) {
  console.error(`[demo-content] refusing: SWITCHBOARD_DATA_DIR (${dataDir || 'unset'}) is not inside ${demoDir}`);
  process.exit(1);
}

// Required AFTER the guard, and only ever here: db.js resolves DATA_DIR at module load.
const db = require('../src/db/db');
const { IDS } = require('./seed-demo');


// Project paths exactly as the transcripts record them — NATIVE separators, because a project
// bucket is keyed on the cwd string (see the note in seed-demo.js).
const project = (name) => path.join(demoDir.replace(/\//g, path.sep), 'projects', name);

// Display names (#) — a project renders as its full working directory unless one is set, so the
// sidebar showed five truncated working-directory rows that say nothing about the project. The
// name lives in the per-project settings blob (`project:<path>.displayName`), which is what
// `getProjectDisplayNames()` reads.
const DISPLAY_NAMES = {
  'demo-alpha': 'Alpha Service',
  'demo-beta': 'Beta API',
  'demo-mixed': 'Mixed Stack',
  'demo-chain': 'Chain Migration',
  'demo-older': 'Legacy Archive',
};

// Two separate vocabularies on purpose: `demo` is a PROJECT tag and a SESSION tag at once, which is
// the point the glyphs in the filter bar make — the same word in both namespaces is two tags.
const PROJECT_TAGS = {
  'demo-alpha': [{ tag: 'client', color: '#7c9cff' }, { tag: 'active', color: '#4ec9a7' }],
  'demo-beta': [{ tag: 'internal', color: '#c586c0' }],
  'demo-mixed': [{ tag: 'client', color: '#7c9cff' }, { tag: 'demo', color: '#d7ba7d' }],
  'demo-chain': [{ tag: 'archive', color: '#8a8f98' }],
};

const SESSION_TAGS = {
  [IDS.claudeParent]: [{ tag: 'setup', color: '#4ec9a7' }],
  [IDS.claudeChild]: [{ tag: 'refactor', color: '#7c9cff' }],
  [IDS.mixClaude]: [{ tag: 'review', color: '#d7ba7d' }],
  [IDS.codex]: [{ tag: 'bug', color: '#f14c4c' }],
  [IDS.pi]: [{ tag: 'demo', color: '#c586c0' }],
};

// One of each scope (project / session / message) and one of each status, so the task list and the
// badges have every state to render.
const TASKS = [
  { project: 'demo-alpha', title: 'Wire the metrics collector into the start path', status: 'in_progress', note: 'Half done — startMetrics() is called, the collector itself is still a stub.' },
  { project: 'demo-alpha', sessionId: IDS.claudeParent, title: 'Document the config schema', status: 'open' },
  { project: 'demo-alpha', sessionId: IDS.claudeParent, entryIndex: 1, title: 'Check the port default against the deploy config', status: 'open', quote: 'Created the project skeleton: added README.md and a starter config.' },
  { project: 'demo-alpha', title: 'Drop the unused routes module', status: 'done' },
  { project: 'demo-beta', sessionId: IDS.codex, title: 'Health endpoint returns 200 before the DB is up', status: 'open', note: 'Reported against the seeded Codex session.' },
  { project: 'demo-mixed', title: 'Reconcile the API surface with the CI matrix', status: 'open' },
  { project: 'demo-mixed', sessionId: IDS.mixClaude, title: 'Old idea: split the API per backend', status: 'dropped' },
  { project: 'demo-chain', title: 'Archive the migration plan once it lands', status: 'open' },
];

// ── Activity metrics ─────────────────────────────────────────────────────────
// The Stats page reads `session_metrics`, which the SCANNER derives from a transcript. The seeded
// transcripts are two lines each, so every chart on that page rendered as an empty grid with a
// legend under it — technically correct and useless to look at.
//
// So the demo gets a synthetic work history: each seeded session contributes a handful of
// (date, hour, model) buckets spread over the past twelve weeks. Unlike `seed-demo.js` this is
// deliberately relative to TODAY — a heatmap seeded to a fixed date drifts out of its own window
// within weeks and ends up showing nothing again.
//
// Deterministic without a random source: every number comes from a small integer hash of the
// session id and the bucket index, so a reseed of a wiped demo reproduces the same history.
const METRIC_MODELS = {
  claude: 'claude-opus-4-6',
  codex: 'gpt-5-codex',
  pi: 'claude-opus-4-7',
};

/** A stable pseudo-random integer in [0, max) from a string and an index. */
function hashInt(str, index, max) {
  let h = 2166136261 ^ index;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return Math.abs(h) % max;
}

/** Every session id the seed creates, with the model each one should report. */
function metricSessions() {
  const rows = [
    [IDS.showcase, 'claude'], [IDS.claudeParent, 'claude'], [IDS.claudeChild, 'claude'],
    [IDS.chainA, 'claude'], [IDS.chainB, 'claude'], [IDS.chainC, 'claude'],
    [IDS.mixClaude, 'claude'], [IDS.mixCodex, 'codex'], [IDS.mixPi, 'pi'],
    [IDS.codex, 'codex'], [IDS.pi, 'pi'],
  ];
  // The eighteen demo-older sessions — same id scheme seed-demo.js builds them with.
  for (let rank = 1; rank <= 18; rank++) {
    const pad = String(rank).padStart(2, '0');
    rows.push([`ba5e${pad}00-0000-4000-8000-${pad.padStart(12, '0')}`, 'claude']);
  }
  return rows;
}

function seedMetrics() {
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const [sessionId, backend] of metricSessions()) {
    const buckets = 5 + hashInt(sessionId, 0, 8);        // 5–12 buckets per session
    // Work CLUSTERS: a session starts somewhere in the past twelve weeks and then runs on nearby
    // days, rather than scattering one bucket per random day. Scattered buckets produced a heatmap of
    // isolated squares — the shape of a cron job, not of somebody working.
    // Claude has 25 of the 29 sessions and can spread over the full twelve weeks. The one Codex and
    // the two Pi sessions cannot: pushed to a random start they all landed outside the 30-day window,
    // and the "tokens by backend" chart — the whole point of which is that there is more than one
    // backend — came out single-coloured. They start inside the last four weeks.
    const start = backend === 'claude' ? hashInt(sessionId, 99, 80) : 6 + hashInt(sessionId, 99, 20);
    const rows = [];
    for (let i = 0; i < buckets; i++) {
      let daysAgo = start - i - hashInt(sessionId, i + 1, 2);
      if (daysAgo < 0) daysAgo += 80;
      const hour = 8 + hashInt(sessionId, i + 40, 11);    // a working day, 08:00–18:00
      const d = new Date(today.getTime() - daysAgo * dayMs);
      if (d.getDay() === 0 || d.getDay() === 6) continue;  // weekends stay light, not empty-by-accident
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (rows.some(r => r.date === date && r.hour === hour)) continue;  // the PK is (session, date, hour, model)
      const input = 1800 + hashInt(sessionId, i + 80, 9000);
      const output = 300 + hashInt(sessionId, i + 120, 2400);
      rows.push({
        date,
        hour,
        model: METRIC_MODELS[backend],
        messageCount: 4 + hashInt(sessionId, i + 160, 22),
        toolCallCount: 2 + hashInt(sessionId, i + 200, 30),
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: input * 6,
        cacheCreationTokens: hashInt(sessionId, i + 240, 2000),
        // Only a backend that reports money gets a figure — NULL everywhere else, because "no figure"
        // must not render as "free". Codex is the one that reports an estimate here.
        estimatedCostUsd: backend === 'codex' ? Number(((input + output) / 900000).toFixed(4)) : null,
        actualCostUsd: null,
      });
    }
    db.replaceSessionMetrics(sessionId, rows);
  }
  return metricSessions().length;
}

function main() {
  // Idempotency is per BLOCK, not for the script as a whole: a single "did this ever run" flag means a
  // block added later never runs at all on an already-seeded demo, which is exactly what happened when
  // the display names were added after the tags.
  const done = [];

  const missingNames = Object.entries(DISPLAY_NAMES)
    .filter(([name]) => !((db.getSetting(`project:${project(name)}`) || {}).displayName));
  for (const [name, displayName] of missingNames) {
    const key = `project:${project(name)}`;
    db.setSetting(key, { ...(db.getSetting(key) || {}), displayName });
  }
  if (missingNames.length) done.push(`${missingNames.length} display name(s)`);

  // Tags: any definition at all means this ran before (or the user made their own) — leave them be,
  // renames and recolours in the demo must survive a reseed.
  if (![...db.listTagDefs('project'), ...db.listTagDefs('session')].length) {
    for (const [name, tags] of Object.entries(PROJECT_TAGS)) db.setProjectTags(project(name), tags);
    for (const [sessionId, tags] of Object.entries(SESSION_TAGS)) db.setSessionTags(sessionId, tags);
    done.push(`tags on ${Object.keys(PROJECT_TAGS).length + Object.keys(SESSION_TAGS).length} project(s)/session(s)`);
  }

  if (!db.listTasks().length) {
    for (const t of TASKS) {
      db.createTask({
        projectPath: project(t.project),
        sessionId: t.sessionId || null,
        entryIndex: t.entryIndex != null ? t.entryIndex : null,
        title: t.title,
        note: t.note || null,
        quote: t.quote || null,
        status: t.status,
      });
    }
    done.push(`${TASKS.length} task(s)`);
  }

  // Metrics need their own marker rather than a "is the table empty" test: the scanner fills that
  // table too, so "empty" is only ever true before the very first scan.
  if (!db.getSetting('demo:metricsSeeded')) {
    const n = seedMetrics();
    db.setSetting('demo:metricsSeeded', { at: new Date().toISOString(), sessions: n });
    done.push(`activity metrics for ${n} session(s)`);
  }

  console.log(done.length ? `[demo-content] seeded ${done.join(', ')}` : '[demo-content] already seeded — nothing written');
}

main();
