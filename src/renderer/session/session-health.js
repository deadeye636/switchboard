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

  // Substitute the {placeholders} in a handoff prompt template with the session's
  // local values. Templates without placeholders (e.g. a bare "/handoff" skill
  // command) pass through unchanged.
  function fillHandoffPrompt(template, session = {}) {
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
    };
    return String(template == null ? '' : template)
      .replace(/\{(goal|project|sessionId|metrics|transcript)\}/g, (_m, key) => values[key]);
  }

  function buildHandoffRequestPrompt(session = {}) {
    return fillHandoffPrompt(DEFAULT_HANDOFF_PROMPT, session);
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



  return {
    HEALTH_THRESHOLDS,
    getSessionHealth,
    buildHandoffTemplate,
    buildHandoffRequestPrompt,
    resolveHandoffPrompt,
    DEFAULT_HANDOFF_PROMPT,
    DEFAULT_HANDOFF_READ_PROMPT,
    fillHandoffPrompt,
  };
});
