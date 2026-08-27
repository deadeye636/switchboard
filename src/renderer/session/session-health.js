(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const HEALTH_THRESHOLDS = {
    userMessageCount: 30,
    messageCount: 300,
    activeMinutes: 240,
    cacheReadTokens: 20_000_000,
    largestUserPromptWords: 2000,
  };

  const HEALTH_STATES = {
    healthy: {
      state: 'healthy',
      label: 'Healthy',
      className: 'health-healthy',
      tier: 'none',
      shouldWarn: false,
    },
    growing: {
      state: 'growing',
      label: 'Growing',
      className: 'health-growing',
      tier: 'soft',
      shouldWarn: false,
    },
    marathonRisk: {
      state: 'marathon-risk',
      label: 'Marathon Risk',
      className: 'health-marathon-risk',
      tier: 'warning',
      shouldWarn: true,
    },
    handoffRecommended: {
      state: 'handoff-recommended',
      label: 'Handoff Recommended',
      className: 'health-handoff-recommended',
      tier: 'strong',
      shouldWarn: true,
    },
  };

  function numberValue(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
  }

  function formatInteger(value) {
    return new Intl.NumberFormat('en').format(Math.round(numberValue(value)));
  }

  function formatCompact(value) {
    const number = numberValue(value);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
    return String(Math.round(number));
  }

  function formatDuration(minutes) {
    const value = numberValue(minutes);
    if (value >= 60) {
      const hours = value / 60;
      return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(/\.0$/, '')}h`;
    }
    return `${Math.round(value)}m`;
  }

  function healthReasons(session) {
    const checks = [
      {
        key: 'user-turns',
        label: `${formatInteger(session.userMessageCount)} user turns`,
        crossed: numberValue(session.userMessageCount) >= HEALTH_THRESHOLDS.userMessageCount,
      },
      {
        key: 'entries',
        label: `${formatInteger(session.messageCount)} entries`,
        crossed: numberValue(session.messageCount) >= HEALTH_THRESHOLDS.messageCount,
      },
      {
        key: 'active-time',
        label: `${formatDuration(session.activeMinutes)} active time`,
        crossed: numberValue(session.activeMinutes) >= HEALTH_THRESHOLDS.activeMinutes,
      },
      {
        key: 'cache-read',
        label: `${formatCompact(session.cacheReadTokens)} cache-read tokens`,
        crossed: numberValue(session.cacheReadTokens) >= HEALTH_THRESHOLDS.cacheReadTokens,
      },
      {
        key: 'big-paste',
        label: `${formatInteger(session.largestUserPromptWords)} words in largest prompt`,
        crossed: numberValue(session.largestUserPromptWords) >= HEALTH_THRESHOLDS.largestUserPromptWords,
      },
    ];
    return checks.filter(check => check.crossed).map(({ key, label }) => ({ key, label }));
  }

  function getSessionHealth(session = {}) {
    if (session.type === 'terminal') {
      return { ...HEALTH_STATES.healthy, reasons: [] };
    }

    const reasons = healthReasons(session);
    const hasEnoughUserTurnsForHandoff = numberValue(session.userMessageCount) > 1;
    if (hasEnoughUserTurnsForHandoff && reasons.length >= 2) return { ...HEALTH_STATES.handoffRecommended, reasons };
    if (reasons.length >= 1) return { ...HEALTH_STATES.marathonRisk, reasons };

    const growing = (
      numberValue(session.userMessageCount) >= HEALTH_THRESHOLDS.userMessageCount * 0.7 ||
      numberValue(session.messageCount) >= HEALTH_THRESHOLDS.messageCount * 0.7 ||
      numberValue(session.activeMinutes) >= HEALTH_THRESHOLDS.activeMinutes * 0.7 ||
      numberValue(session.cacheReadTokens) >= HEALTH_THRESHOLDS.cacheReadTokens * 0.7 ||
      numberValue(session.largestUserPromptWords) >= HEALTH_THRESHOLDS.largestUserPromptWords * 0.7
    );

    return { ...(growing ? HEALTH_STATES.growing : HEALTH_STATES.healthy), reasons };
  }

  function buildHandoffTemplate(session = {}) {
    const metrics = [
      session.userMessageCount ? `${formatInteger(session.userMessageCount)} user turns` : null,
      session.cacheReadTokens ? `${formatCompact(session.cacheReadTokens)} cache-read tokens` : null,
      session.activeMinutes ? `${formatDuration(session.activeMinutes)} active time` : null,
    ].filter(Boolean).join(', ') || 'metrics unavailable';
    const goal = session.name || session.aiTitle || session.summary || 'Continue the current task';
    const projectPath = session.projectPath || 'Unknown project';

    return `We are continuing from a long-running Switchboard session. Use this packet instead of re-reading the full old transcript.

Goal:
- ${goal}

Project:
- ${projectPath}
- Previous session: ${session.sessionId || 'unknown'}

Current state:
- Session shape: ${metrics}
- Completed: capture the key completed work from the previous session before continuing.
- In progress: continue from the most recent user-visible goal.
- Blocked/risky: avoid broad transcript re-reading unless a specific missing fact requires it.

Important files/context:
- Add only the files needed for the next step.

Next actions:
1. Restate the immediate goal in one sentence.
2. Inspect only the files needed for that goal.
3. Run the smallest relevant validation before broad checks.

Avoid:
- Loading all old transcript context
- Continuing unrelated tasks from the old session
- Re-reading broad directories unless needed
`;
  }

  // Editable handoff request prompt. The placeholders {goal} {project}
  // {sessionId} {metrics} are filled per-session by fillHandoffPrompt. Users can
  // override this whole text in Settings (or replace it with a skill like /handoff).
  const DEFAULT_HANDOFF_PROMPT = `Create a concise handoff for starting a fresh session.

Use your current session context to summarize the actual work state. Do not continue implementing.

Known local context from Switchboard:
- Goal/session title: {goal}
- Project: {project}
- Previous session: {sessionId}
- Session shape: {metrics}

Return only a markdown handoff with these sections:
- Goal
- Completed
- In progress
- Blocked or risky
- Important files/context
- Next actions
- Avoid
`;

  // The OTHER way to produce a handoff: a fresh agent reads the old session and writes the packet itself.
  //
  // Nothing has to be resumed, and no tokens are spent in the old session — the new one does the reading.
  // {transcript} is a path it can actually open: the session's own file, or, for a backend whose history
  // lives in a store rather than a file (Hermes today, and it will not be the last), a transcript
  // Switchboard exports for exactly this.
  const DEFAULT_HANDOFF_READ_PROMPT = `Read the previous session's transcript and write a handoff for continuing it.

Transcript: {transcript}

Known local context from Switchboard:
- Goal/session title: {goal}
- Project: {project}
- Previous session: {sessionId}
- Session shape: {metrics}

Read the transcript first. Do not continue the work yet. Then return only a markdown handoff with these sections:
- Goal
- Completed
- In progress
- Blocked or risky
- Important files/context
- Next actions
- Avoid
`;

  // Where this project keeps the document, as the prompt may name it. `{handoffDir}` / `{planDir}` are
  // project-relative ('.handoffs'), `{handoffPath}` / `{planPath}` absolute — an agent whose working
  // directory we do not know needs the second kind. All four come from the caller, which asks main for
  // the cascade (`project-convention-dirs`).
  //
  // Two kinds, one mechanic, because the problem is the same one twice: a slash command is a skill we did
  // not write, and it decides where it writes. What differs is only the noun.
  const DIR_HINT_KINDS = {
    handoff: { tokens: ['{handoffDir}', '{handoffPath}'], noun: 'handoff', what: 'the packet' },
    plan: { tokens: ['{planDir}', '{planPath}'], noun: 'plan', what: 'the plan' },
  };

  // Today as YYYY-MM-DD, in the LOCAL zone. `toISOString().slice(0,10)` is the tempting one-liner and it
  // is wrong for anyone east of UTC in the evening: it dates a plan written on Tuesday night as Wednesday.
  function localDateStamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // Is this prompt a slash command — a skill belonging to the CLI rather than a text we wrote?
  // The first non-empty line decides. A prompt that merely CONTAINS a slash somewhere is prose.
  function isSlashCommandPrompt(template) {
    const first = String(template == null ? '' : template).split('\n').find(line => line.trim());
    return !!first && first.trim().startsWith('/');
  }

  // Tell a skill where the document belongs.
  //
  // A slash command is the one prompt we cannot word: `/handoff` runs the CLI's own skill, and that skill
  // decides where it writes — its own home directory, as often as not, while Switchboard looks in the
  // project. Appending the directory as its own line is the only influence there is.
  //
  // Only for a slash command, and only when the template does not already name the directory itself: a
  // prompt someone wrote by hand is theirs, and a second sentence in it is noise. The line carries the
  // TOKEN rather than the path, so the one substitution point below stays the only one.
  function withDirHint(template, dirs = {}, kind = 'handoff') {
    const spec = DIR_HINT_KINDS[kind];
    const text = String(template == null ? '' : template);
    if (!spec) return text;
    const absolute = dirs[`${kind}Path`];
    const relative = dirs[`${kind}Dir`];
    if (!absolute && !relative) return text;
    if (!isSlashCommandPrompt(text)) return text;
    if (spec.tokens.some(token => text.includes(token))) return text;
    const token = absolute ? `{${kind}Path}` : `{${kind}Dir}`;
    return `${text.replace(/\s+$/, '')}

Switchboard: this project's ${spec.noun} directory is ${token} — write ${spec.what} there.
`;
  }

  // Substitute the {placeholders} in a prompt template with the session's local values. Templates
  // without placeholders (e.g. a bare "/handoff" skill command) pass through unchanged.
  //
  // One filler for every prompt the app types into an agent — the handoff pair and the plan prompt —
  // because a placeholder that works in one of them and not in the others is a trap nobody can see from
  // the settings field.
  function fillPromptTemplate(template, session = {}) {
    const metrics = [
      session.userMessageCount ? `${formatInteger(session.userMessageCount)} user turns` : null,
      session.cacheReadTokens ? `${formatCompact(session.cacheReadTokens)} cache-read tokens` : null,
      session.activeMinutes ? `${formatDuration(session.activeMinutes)} active time` : null,
    ].filter(Boolean).join(', ') || 'local metrics unavailable';
    const goal = session.name || session.aiTitle || session.summary || 'the current task';
    const values = {
      goal,
      project: session.projectPath || 'unknown',
      sessionId: session.sessionId || 'unknown',
      metrics,
      // Only set on the "a fresh agent reads the old session" route; empty elsewhere.
      transcript: session.transcriptPath || '',
      // Where a document belongs. Absent when the caller could not ask (no project, main unreachable) —
      // then the token resolves to empty rather than to a guess at a directory nobody keeps.
      handoffDir: session.handoffDir || '',
      handoffPath: session.handoffPath || '',
      planDir: session.planDir || '',
      planPath: session.planPath || '',
      // The date a document should carry, in the convention's own format. Local rather than UTC: a plan
      // written at half past midnight is dated the day its author would write on it, not the day the
      // clock in Greenwich is having.
      today: session.today || localDateStamp(),
    };
    return String(template == null ? '' : template)
      .replace(/\{(goal|project|sessionId|metrics|transcript|handoffDir|handoffPath|planDir|planPath|today)\}/g,
        (_m, key) => values[key]);
  }

  function buildHandoffRequestPrompt(session = {}) {
    return fillPromptTemplate(DEFAULT_HANDOFF_PROMPT, session);
  }

  // The prompt we type into THIS backend's session:
  //
  //   1. the backend's OWN prompt, if the user set one on its settings page,
  //   2. else the global prompt,
  //   3. else the built-in default.
  //
  // That is all. A slash command is that CLI's own — `/handoff` is a Claude skill and does not exist in
  // Codex just because Codex also has skills — but making the app second-guess that is not our job: the
  // per-backend field is exactly how the user says what each CLI should be sent. If a command is wrong
  // there, they fix it there.
  //
  // (What we DO still guard is the consequence, not the choice: if the agent answers nothing at all, the
  // handoff flow asks before offering its previous message as the "fresh" packet.)
  //   kind 'summarise' — sent to the OLD agent: "summarise the state you are holding".
  //   kind 'read'      — sent to the NEW agent: "read the old session's transcript and write the handoff".
  // Both are overridable globally and per backend; the per-backend value wins.
  function resolveHandoffPrompt(backend, settings = {}, kind = 'summarise') {
    // No backend named -> no PER-BACKEND override applies, and the lookups below fall through to the
    // global prompt on their own. It used to answer 'claude' here, which handed Claude's custom wording
    // to a session whose backend we did not know — including its slash commands, which another CLI reads
    // as plain text (#225). '' matches no key, which is exactly the intent.
    const id = (backend && backend.id) || '';
    const pick = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

    if (kind === 'read') {
      return pick((settings.handoffReadPromptByBackend || {})[id])
        || pick(settings.handoffReadPrompt)
        || DEFAULT_HANDOFF_READ_PROMPT;
    }
    return pick((settings.handoffPromptByBackend || {})[id])
      || pick(settings.handoffPrompt)
      || DEFAULT_HANDOFF_PROMPT;
  }

  // --- Asking for a plan (#486) ---------------------------------------------------------------------
  //
  // The mirror image of the handoff, and deliberately much smaller. The app writes no plan and reviews
  // none: a plan is the agent's document, `docs/plans-convention.md` says so, and the plan directories
  // are watched — so a plan an agent just wrote appears in the list on its own. All this side does is
  // type a prompt and get out of the way.
  //
  // The DEFAULT carries the convention, because nothing else will. A CLI that has a plan mode names its
  // own files (Claude's three word lists), and the ones that have no plan mode at all write whatever the
  // moment suggests. Neither reads our documentation. So the shape — the directory, the filename, the
  // first heading, the header block — is stated here, in the text the agent actually receives.
  const DEFAULT_PLAN_PROMPT = `Write a plan for the work we are about to do. Do not implement anything yet.

Write it as a markdown file in {planPath}, named <date>-<slug>.md — for example 2026-08-20-tariff-end-date.md.

The plan's title is its first heading, and a header block carries the state:

# Remove the end date from the tariff — it follows from the successor

> status: active · updated: {today}

Then the plan itself: what is to be done, in the order it should happen, and what would show that it
worked. Keep it short enough to be read before the work starts.

Known local context from Switchboard:
- Goal/session title: {goal}
- Project: {project}
`;

  // Which prompt this backend gets. The same cascade the handoff prompts use — the backend's own, else
  // the global one, else the built-in default.
  //
  // Per backend matters MORE here than it does for handoffs, and the reason is worth stating: Claude has
  // a plan mode with its own naming, Codex, Hermes and Pi have no plan mode at all. One wording cannot
  // fit both cases, and the per-backend field is where that gets said.
  function resolvePlanPrompt(backend, settings = {}) {
    const id = (backend && backend.id) || '';
    const pick = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;
    return pick((settings.planPromptByBackend || {})[id])
      || pick(settings.planPrompt)
      || DEFAULT_PLAN_PROMPT;
  }



  return {
    HEALTH_THRESHOLDS,
    getSessionHealth,
    buildHandoffTemplate,
    buildHandoffRequestPrompt,
    resolveHandoffPrompt,
    DEFAULT_HANDOFF_PROMPT,
    DEFAULT_HANDOFF_READ_PROMPT,
    DEFAULT_PLAN_PROMPT,
    resolvePlanPrompt,
    fillPromptTemplate,
    withDirHint,
    isSlashCommandPrompt,
    localDateStamp,
  };
});
