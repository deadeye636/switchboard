// The sidebar/admin projects view, split out of session-cache.js (#199 step 4).
//
// Read side only: it turns cached rows + the project register into what the renderer paints. No writes to
// the index (buildProjectsAdmin does one incremental folder-meta backfill for empty dirs, which is the
// only DB write here, exactly as before).

const fs = require('fs');
const path = require('path');
const { deriveProjectPath, normPath } = require('../session/derive-project-path');
const { encodeProjectPath } = require('../session/encode-project-path');
const { parseWorktreePath, worktreeRootOf } = require('../shared/worktree-path');
const registry = require('../projects/project-registry');

let PROJECTS_DIR, activeSessions;
let getAllMeta, getAllCached, getAllFolderMeta, setFolderMeta;
// #282: store folders whose head carried no derivable cwd (snapshot-only fork/clear transcripts).
// buildProjectsAdmin runs on the 10s auto-hide throttle; without this a headless folder was re-derived
// — a 256 KB `openSync`+`readSync` — on every pass. In-memory (not persisted) so a restart re-tries once,
// and the reconcile stamps the real path in folder_meta the moment the folder holds a parseable session.
const _headlessFolders = new Set();
let getFavoritedProjects, getProjectDisplayNames, getProjectStates;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getAllMeta = ctx.db.getAllMeta;
  getAllCached = ctx.db.getAllCached;
  getAllFolderMeta = ctx.db.getAllFolderMeta;
  setFolderMeta = ctx.db.setFolderMeta;
  getFavoritedProjects = ctx.db.getFavoritedProjects;
  getProjectDisplayNames = ctx.db.getProjectDisplayNames;
  getProjectStates = ctx.db.getProjectStates;
}

// The later of two timestamps, either of which may be absent. Compared as dates rather than strings
// because the two sides can reach us in different ISO spellings.
function newerOf(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

/**
 * Build the sidebar's projects from THE REGISTER (#167), with the cached sessions layered onto it.
 *
 * It used to be the other way round: the list was derived from the transcripts, so a project without one
 * could not appear however often you added it, and "remove" could only ever be faked as a permanent
 * hide. Now the register says which projects exist and which are shown; the sessions are what is IN them.
 */
function buildProjectsFromCache(showArchived) {
  const metaMap = getAllMeta();
  const cachedRows = getAllCached();
  const states = typeof getProjectStates === 'function' ? getProjectStates() : new Map();
  // A project is shown when it is on the list and neither hidden by the user nor auto-hidden by staleness.
  //
  // Keyed on the CANONICAL path, exactly like the buckets below (#245). It used to be the raw string, and
  // that half-normalization was the bug: a row whose cwd is spelled differently from the registered path —
  // `C:\x\y` against `C:/x/y`, or a different drive-letter case, which real transcripts do contain — was
  // dropped HERE, before it ever reached the bucket that would have merged it. The session was indexed and
  // invisible: no row, in a project the sidebar was already showing.
  // A Map, not a Set: the canonical key is what every lookup compares on, but the loop over registered
  // projects further down still needs the REGISTERED spelling to reach `states` (and to display).
  const visible = new Map();
  for (const [projectPath, state] of states) {
    if (registry.isVisible(state)) visible.set(normPath(projectPath), projectPath);
  }
  // A WORKTREE has no registration of its own — discovery stopped writing one, because a worktree is a
  // sub-unit of its project rather than a project beside it. So its visibility is its project's, walked
  // up through however many levels of worktree sit in between.
  //
  // Its own row still gets a say in one direction: a worktree CAN carry `hidden` (the header's hide
  // button writes it) and that flag is the one thing that overrules an otherwise visible parent. It
  // cannot carry `registered`, which is why `hideProject` grew an exception for exactly this shape.
  //
  // For anything that is not a worktree this is the old one-line answer, reached on the first pass.
  const stateByKey = new Map([...states].map(([p, st]) => [normPath(p), st]));
  // Memoised per build: this is asked twice for every cached row, and a worktree costs a `normPath` per
  // level rather than the single map lookup the old one-liner was. `pathKey` memoises too, but the walk
  // and the two map lookups are ours.
  const visibleMemo = new Map();
  const isVisiblePath = (p) => {
    if (visibleMemo.has(p)) return visibleMemo.get(p);
    const answer = resolveVisible(p);
    visibleMemo.set(p, answer);
    return answer;
  };
  const resolveVisible = (p) => {
    let cur = p;
    for (let depth = 0; depth < 16; depth++) {
      const own = stateByKey.get(normPath(cur));
      if (own && (own.hidden || own.autoHidden)) return false;
      // A worktree does not answer this for itself even when a row for it exists — one written before
      // discovery stopped making them, or one a user added by hand through the project manager. Two
      // answers to one question is what this walk exists to remove, so the project has the only one.
      const wt = parseWorktreePath(cur);
      if (!wt) return visible.has(normPath(cur));
      cur = wt.parentPath;
    }
    return false;
  };

  // Group by projectPath, not on-disk folder name. Multiple ~/.claude/projects/<folder>/ directories can
  // resolve to the same projectPath, so we merge them into a single sidebar group to avoid duplicate-id
  // collisions in the morphdom render. Only insert a project entry once we have a session that survives
  // the archive filter.
  const knownIds = new Set();
  const shownIds = new Set();
  for (const row of cachedRows) {
    if (!row.projectPath) continue;
    knownIds.add(row.sessionId);
    if (!isVisiblePath(row.projectPath)) continue;
    if (!showArchived && metaMap.get(row.sessionId)?.archived) continue;
    shownIds.add(row.sessionId);
  }

  const projectMap = new Map();
  // Track the newest session activity per projectPath across ALL cached rows (archived included). This is
  // the PROJECT's own last-activity date: every session hands its timestamp to its project, and hiding one
  // of those sessions never takes the date back (#306).
  const lastActivityByPath = new Map();
  for (const row of cachedRows) {
    if (!row.projectPath) continue;
    // ONE canonical key per row (#245), used for all three things below — visibility, activity and the
    // bucket. They must agree, and deriving it three times is both slower and easier to get out of step.
    const key = normPath(row.projectPath);
    // Not on the list, or on it and not shown: its sessions belong to no visible group. Through the same
    // function the pass above uses — a raw `visible.has` here was a SECOND reading of the question, and it
    // is the one that answered "no" for every worktree once a worktree stopped being registered.
    if (!isVisiblePath(row.projectPath)) continue;
    if (row.modified) {
      const prev = lastActivityByPath.get(key);
      if (!prev || row.modified > prev) lastActivityByPath.set(key, row.modified);
    }
    const meta = metaMap.get(row.sessionId);
    const s = {
      sessionId: row.sessionId,
      summary: row.summary,
      firstPrompt: row.firstPrompt,
      created: row.created,
      modified: row.modified,
      messageCount: row.messageCount,
      userMessageCount: row.userMessageCount || 0,
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheCreationTokens: row.cacheCreationTokens || 0,
      cacheReadTokens: row.cacheReadTokens || 0,
      largestUserPromptWords: row.largestUserPromptWords || 0,
      startedAt: row.startedAt || null,
      lastEntryAt: row.lastEntryAt || null,
      activeMinutes: row.activeMinutes || 0,
      projectPath: row.projectPath,
      slug: row.slug || null,
      aiTitle: row.aiTitle || null,
      parentSessionId: row.parentSessionId || null,
      agentId: row.agentId || null,
      subagentType: row.subagentType || null,
      description: row.description || null,
      // Authoritative backend provenance (§5.7) — drives the sidebar's provider badge. A row written
      // before the multi-LLM columns existed (NULL) is Claude by definition. (The row's filePath is NOT
      // sent: it would bloat every sidebar paint.)
      backendId: row.backendId || 'claude',
      // v12 cost + lineage (T-5.5). Null on every token-only backend. `costStatus` says whether the
      // figure is an estimate or a settled amount. `lineageParentId` is a backend's OWN parent link
      // (Hermes' parent_session_id), deliberately separate from `parentSessionId` = Claude subagent.
      estimatedCostUsd: row.estimatedCostUsd == null ? null : Number(row.estimatedCostUsd),
      actualCostUsd: row.actualCostUsd == null ? null : Number(row.actualCostUsd),
      costStatus: row.costStatus || null,
      lineageParentId: row.lineageParentId || null,
      // How that parent link was established (#193): 'fork'/'parent'/'compaction' are hard (the backend
      // recorded it), 'clear' is the soft mtime-freeze guess — the sidebar labels a guess as a guess.
      lineageKind: row.lineageKind || null,
      // Which tool this session was imported from, as a label (#552). Null for everything nobody
      // imported, which is nearly every row. It rides to the sidebar because the same work can be in the
      // list twice — once from the tool's own store, once from the store it was imported into — and this
      // is what makes the second copy legible instead of confusing.
      importedFrom: row.importedFrom || null,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
    };
    if (!showArchived && s.archived) continue;
    // #129: a subagent follows its parent into the archive. Asked as "did the parent make it into the
    // sidebar?" rather than "does the meta row say archived?" (#173): whatever keeps the parent out keeps
    // the child out with it. A parent the store has never heard of is a genuine orphan and still shows.
    if (!showArchived && s.parentSessionId
        && knownIds.has(s.parentSessionId) && !shownIds.has(s.parentSessionId)) continue;
    // Bucketed by that canonical key (`normPath` is the REAL path of the directory since #563, with case
    // ignored where the filesystem ignores it), so the same directory spelled two ways by different
    // backends does not render as two projects (#8). The value keeps the raw spelling
    // as the display projectPath; the session loop runs first, so the spelling that has sessions wins.
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        folder: encodeProjectPath(row.projectPath),
        projectPath: row.projectPath,
        missing: !fs.existsSync(row.projectPath),
        sessions: [],
      });
    }
    projectMap.get(key).sessions.push(s);
  }

  // Every REGISTERED project that has no session to show — the one the user just added and has never run
  // anything in, and the one whose sessions are all archived.
  for (const [key, projectPath] of visible) {
    if (projectMap.has(key)) continue;   // a registered spelling of a project already shown → same project (#8)
    const state = states.get(projectPath) || {};
    projectMap.set(key, {
      folder: encodeProjectPath(projectPath),
      projectPath,
      missing: !fs.existsSync(projectPath),
      sessions: [],
      // Its recency: the last real activity when its sessions are merely archived; otherwise the moment
      // it was put on the list.
      lastActivity: lastActivityByPath.get(key) || state.registeredAt || null,
    });
  }

  // Inject active plain terminal sessions so they participate in sorting. A terminal open in a project
  // the user has hidden stays hidden — starting one is not an unhide.
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || !session.isPlainTerminal) continue;
    if (!session.projectPath) continue;
    if (!isVisiblePath(session.projectPath)) continue;
    const key = normPath(session.projectPath);
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        folder: encodeProjectPath(session.projectPath),
        projectPath: session.projectPath,
        sessions: [],
      });
    }
    const proj = projectMap.get(key);
    if (!proj.sessions.some(s => s.sessionId === sessionId)) {
      proj.sessions.push({
        sessionId, summary: 'Terminal', firstPrompt: '', projectPath: session.projectPath,
        name: null, starred: 0, archived: 0, messageCount: 0,
        modified: new Date(session._openedAt).toISOString(),
        created: new Date(session._openedAt).toISOString(),
        type: 'terminal',
      });
    }
  }

  const favorited = typeof getFavoritedProjects === 'function' ? getFavoritedProjects() : new Set();
  const displayNames = typeof getProjectDisplayNames === 'function' ? getProjectDisplayNames() : new Map();

  // Canonical lookups (#245): a star and a display name are stored against the spelling the user acted
  // on, while a bucket carries whichever spelling had sessions. Comparing raw strings lost both.
  const favoritedKeys = new Set([...favorited].map(normPath));
  const displayNameByKey = new Map([...displayNames].map(([k, v]) => [normPath(k), v]));

  const projects = [];
  for (const [key, proj] of projectMap) {
    proj.sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    proj.favorited = favoritedKeys.has(key);
    proj.displayName = displayNameByKey.get(key) || '';
    // Every project carries its own date, not only the ones with nothing left to show (#306). The branch
    // above already stamped the registered-but-empty ones (which may fall back to `registeredAt`).
    if (proj.lastActivity == null) proj.lastActivity = lastActivityByPath.get(key) || null;
    projects.push(proj);
  }

  projects.sort((a, b) => {
    // Favorited projects go to the top (before any other ordering).
    if (a.favorited && !b.favorited) return -1;
    if (!a.favorited && b.favorited) return 1;
    // Missing projects go to the bottom
    if (a.missing && !b.missing) return 1;
    if (!a.missing && b.missing) return -1;
    // Effective recency: the newest VISIBLE session, or the project's own last activity across all its
    // sessions — whichever is NEWER (#306). It used to be `visible || known`, and archiving the newest
    // session therefore threw the project back to its second-newest one and reordered the sidebar.
    // Archiving hides a row; it is not a statement that the project went quiet.
    // Only projects with no recency at all sink to the bottom.
    const aDate = newerOf(a.sessions[0]?.modified, a.lastActivity);
    const bDate = newerOf(b.sessions[0]?.modified, b.lastActivity);
    if (!aDate && bDate) return 1;
    if (!bDate && aDate) return -1;
    return new Date(bDate) - new Date(aDate);
  });

  // Which project a worktree belongs to, answered HERE and not in the renderer (#596).
  //
  // The pairing itself is #582 — one pattern, both separators, three layouts. What it hands back is a
  // path SPELLING, and the renderer used to compare that spelling against a project row with `===`. Every
  // other identity question in this file goes through `normPath`, because a bucket exposes a DISPLAY
  // spelling that is whichever source filled it: a registered project takes the register's, a worktree
  // takes its session rows'. One directory therefore reaches the renderer spelled two ways, the raw
  // compare misses, and the worktree is drawn nowhere at all — it is already excluded from the top level
  // for being a worktree, so a parent that is not found is a row that does not exist.
  //
  // `worktreeOf` is the parent's own display spelling, so the renderer can key on it directly and asks
  // no path question of its own. It is null when the pattern does not match, and also when the parent is
  // not in this payload — a parent that is hidden draws no header, and a worktree still has nothing to
  // nest under. That case is #591, not this one, and it keeps the behaviour it had.
  // NOT called `worktreeOf`, and the collision is worth the clumsier name: `unlistedProjects` in
  // `src/projects/projects.js` already ships a `worktreeOf`, and it answers a different question — the
  // raw parent path, set whether or not that parent is anywhere in view (#583). This one is the row to
  // NEST UNDER, canonically matched, and null when there is none.
  //
  // `worktreeRootOf`, not `parseWorktreePath` (#586): the row to nest under is the TOP-MOST project, so a
  // worktree created inside a worktree lands beside its own parent rather than under it. The one-level
  // answer put it under a row that is itself excluded from the top level, and the nesting pass only runs
  // for top-level projects — so a nested worktree was attached to nothing and drawn nowhere at all, with
  // its sessions still indexed and searchable. The alternative was a recursive pass one rail deeper,
  // which costs ~34 px of a 340 px panel per level; what carries the relationship instead is the row's
  // NAME (`worktreeLabelOf`), which spells every level between the checkout and its project.
  const byKey = new Map(projects.map(p => [normPath(p.projectPath), p.projectPath]));
  for (const proj of projects) {
    const root = worktreeRootOf(proj.projectPath);
    proj.nestUnder = root ? (byKey.get(normPath(root)) || null) : null;
  }
  // No allowlist filter any more. The mode now decides who may WRITE to the register (see
  // project-registry.js); by the time we get here, the register is the list, in both modes.
  return projects;
}

// Aggregate view of ALL projects for the Projects-admin tab (#32). Unlike buildProjectsFromCache this
// does NOT drop hidden projects and does NOT apply any allowlist filter — the admin UI needs to see (and
// act on) everything. Returns lightweight rows (counts only, no per-session objects).
function buildProjectsAdmin() {
  // The admin sees the register AND what is not on it: a project with sessions or a store folder but no
  // entry is exactly what the "add to sidebar" action is for.
  const states = typeof getProjectStates === 'function' ? getProjectStates() : new Map();
  const favorited = typeof getFavoritedProjects === 'function' ? getFavoritedProjects() : new Set();
  const displayNames = typeof getProjectDisplayNames === 'function' ? getProjectDisplayNames() : new Map();

  // Keyed on the CANONICAL path (#245). With the raw string as the key, one directory spelled two ways —
  // `C:\x\y` from a live CLI against `C:/x/y` from a seed or an older record — listed TWICE, and only one
  // of the two carried the register entry. The value keeps a display spelling: the first one seen, unless a
  // REGISTERED one shows up later, because that is the one the user's actions are stored against.
  const statesByKey = new Map([...states].map(([k, v]) => [normPath(k), v]));
  // Same canonicalisation for the two user-owned attributes (#245): a star or a rename is stored against
  // the spelling the user acted on, which need not be the one this entry ended up displaying.
  const favoritedKeysAdmin = new Set([...favorited].map(normPath));
  const displayNameByKeyAdmin = new Map([...displayNames].map(([k, v]) => [normPath(k), v]));
  const map = new Map(); // canonical key -> { projectPath, sessionCount, lastActivity, lastStartedAt }
  const ensure = (projectPath, registered) => {
    const key = normPath(projectPath);
    if (!map.has(key)) map.set(key, { projectPath, sessionCount: 0, lastActivity: null, lastStartedAt: null });
    const entry = map.get(key);
    if (registered) entry.projectPath = projectPath;
    return entry;
  };

  for (const row of getAllCached()) {
    if (!row.projectPath) continue;
    const e = ensure(row.projectPath);
    e.sessionCount++;
    const mod = row.modified || null;
    if (mod && (!e.lastActivity || new Date(mod) > new Date(e.lastActivity))) e.lastActivity = mod;
    // The newest session START, kept apart from the recency (#575). `unlistedProjects` asks the register
    // the same question the register asks itself, and the register judges a tombstone on the start — so
    // an admin row that carried only a recency would make the offer contradict the list.
    const st = row.startedAt || null;
    if (st && (!e.lastStartedAt || new Date(st) > new Date(e.lastStartedAt))) e.lastStartedAt = st;
  }

  // Include empty project directories (no sessions yet), like buildProjectsFromCache.
  try {
    const folderMeta = getAllFolderMeta();
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      let projectPath = folderMeta.get(d.name)?.projectPath;
      if (!projectPath && !folderMeta.has(d.name) && !_headlessFolders.has(d.name)) {
        projectPath = deriveProjectPath(path.join(PROJECTS_DIR, d.name));
        if (projectPath) setFolderMeta(d.name, projectPath, 0);
        else _headlessFolders.add(d.name);   // #282: don't re-read a headless folder on every admin build
      }
      if (projectPath) ensure(projectPath);
    }
  } catch {}

  // ...and every registered project, including one that has neither sessions nor a store folder.
  for (const [projectPath, state] of states) {
    if (state.registered) ensure(projectPath, true);
  }

  const rows = [];
  for (const [key, e] of map) {
    const projectPath = e.projectPath;
    const state = states.get(projectPath) || statesByKey.get(key) || {};
    rows.push({
      projectPath,
      // The project this row belongs to when it is a worktree, walked to the TOP (#582, #596). The
      // auto-hide sweep folds a worktree's activity into it, and it is what the project manager needs to
      // say whose sub-unit a row is. Null for an ordinary project.
      worktreeRoot: worktreeRootOf(projectPath),
      folder: encodeProjectPath(projectPath),
      displayName: displayNames.get(projectPath) || displayNameByKeyAdmin.get(key) || '',
      sessionCount: e.sessionCount,
      lastActivity: e.lastActivity,
      lastStartedAt: e.lastStartedAt,
      missing: !fs.existsSync(projectPath),
      // On the list at all — what tells "hidden" (on it, unseen) apart from "not added" (not on it).
      registered: !!state.registered,
      hidden: !!state.hidden,
      autoHidden: !!state.autoHidden,
      removedAt: state.removedAt || null,
      favorite: favorited.has(projectPath) || favoritedKeysAdmin.has(key),
    });
  }
  return rows;
}

// Pure predicate for #57 auto-hide — kept dependency-free so it's unit-testable without Electron.
// `effectiveActivityMs` is max(newest session activity, autoHideResetAt) for the project; auto-hide fires
// only when the feature is on (days > 0) and the project has been inactive for longer than `days`.
function shouldAutoHide(effectiveActivityMs, nowMs, days) {
  if (!(days > 0)) return false;
  return (nowMs - effectiveActivityMs) > days * 86400000;
}

module.exports = {
  init,
  buildProjectsFromCache,
  buildProjectsAdmin,
  shouldAutoHide,
};
