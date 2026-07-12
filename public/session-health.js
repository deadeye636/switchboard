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
    };
    return String(template == null ? '' : template)
      .replace(/\{(goal|project|sessionId|metrics)\}/g, (_m, key) => values[key]);
  }

  function buildHandoffRequestPrompt(session = {}) {
    return fillHandoffPrompt(DEFAULT_HANDOFF_PROMPT, session);
  }

  // Which prompt do we actually type into THIS backend's session?
  //
  //   1. the backend's OWN prompt, if the user set one on its settings page,
  //   2. else the global prompt,
  //   3. else the built-in default.
  //
  // The subtlety is slash commands. EVERY shipped CLI has them (Codex, Hermes and Pi all do, and all
  // turn installed skills into slash commands) — but the commands are each CLI's OWN. `/handoff` is a
  // Claude skill; it does not exist in Codex merely because Codex also has skills. Typed there it is
  // read as text or rejected as unknown, the agent produces no packet, and the capture step would then
  // offer its previous (or its error) message as the "fresh" handoff. Silently wrong.
  //
  // So:
  //   - a prompt set ON a backend may be any slash command — the user chose it FOR that CLI,
  //   - a GLOBAL slash command belongs to the CLI it was written for, i.e. the default backend. Sent to
  //     any other backend it is replaced by the prose default, and we say why (and where to fix it).
  //
  // `backend` = descriptor ({ id, label, slashCommands }); `settings` = the global settings blob.
  // Returns { prompt, usedFallback, reason }.
  function resolveHandoffPrompt(backend, settings = {}, { defaultBackendId = 'claude' } = {}) {
    const id = (backend && backend.id) || 'claude';
    const label = (backend && backend.label) || id;
    const pick = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

    const own = pick((settings.handoffPromptByBackend || {})[id]);
    const global = pick(settings.handoffPrompt);
    const isSlash = (t) => /^\/[^\s]/.test(t || '');

    // Explicitly set for THIS backend: send it, whatever it is.
    if (own) return { prompt: own, usedFallback: false, reason: null };

    if (global && isSlash(global)) {
      const command = global.split(/\s/)[0];

      // The backend cannot do slash commands at all (an unbuilt one, say).
      if (backend && backend.slashCommands === false) {
        return {
          prompt: DEFAULT_HANDOFF_PROMPT,
          usedFallback: true,
          reason: `${label} has no slash commands, so "${command}" would arrive as plain text. `
            + 'The standard handoff prompt was used instead.',
        };
      }
      // It does — but the command was written for another CLI, and commands do not carry across.
      if (id !== defaultBackendId) {
        return {
          prompt: DEFAULT_HANDOFF_PROMPT,
          usedFallback: true,
          reason: `"${command}" is a command of your default agent, and ${label} has its own. `
            + `The standard handoff prompt was used — set a handoff prompt on ${label}'s page to use one of its commands.`,
        };
      }
    }

    return { prompt: global || DEFAULT_HANDOFF_PROMPT, usedFallback: false, reason: null };
  }


  return {
    HEALTH_THRESHOLDS,
    getSessionHealth,
    buildHandoffTemplate,
    buildHandoffRequestPrompt,
    resolveHandoffPrompt,
    DEFAULT_HANDOFF_PROMPT,
    fillHandoffPrompt,
  };
});
