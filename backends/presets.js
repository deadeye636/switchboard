// backends/presets.js — provider PRESETS for a template. Source of truth (main process).
//
// A preset is a starting point for a TEMPLATE: a name/icon + an env bundle whose auth is a `$VAR`
// reference (resolved at spawn, never on disk). It is not a backend until a user instantiates a
// template from it (the editor's "Add from template").
//
// Every preset here declares `backendId: 'claude'`, and that is not decoration (#161). These are
// `ANTHROPIC_*` bundles: they re-point the SAME `claude` binary at an Anthropic-compatible endpoint —
// zero per-provider code (00 §3). They mean nothing on a Codex or Pi base, which have no such variables.
// A template can now name any backend it runs on; the preset list a user is offered belongs to the base
// they picked, not to one global list.
//
// Cross-cutting rules baked into every preset (01-providers §"Cross-cutting rules"):
//   - Prefer ANTHROPIC_AUTH_TOKEN ($VAR) over ANTHROPIC_API_KEY.
//   - Blank the inherited host ANTHROPIC_API_KEY ("") so it can't shadow the token / leak the host key.
//   - Redirect the haiku/small-fast model to the endpoint (an unredirected haiku call hits Anthropic,
//     FAILS, and leaks the host key). ANTHROPIC_SMALL_FAST_MODEL is deprecated -> ANTHROPIC_DEFAULT_HAIKU_MODEL.
//   - Set CLAUDE_CODE_SUBAGENT_MODEL (else subagents 400/404).
//   - Set both stability flags.
//
// The structured "Model" field (UX#4): the editor shows ONE model box; `applyModel` writes the whole
// consistent var set (primary + opus/sonnet/haiku + subagent) with haiku redirected, so a user can't
// leave one model var pointing at Anthropic and leak the host key. Raw env rows stay available as advanced.
'use strict';

const STABILITY = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
};

const PRESETS = [
  {
    id: 'anthropic',
    name: 'Anthropic (default)',
    icon: 'anthropic',
    axis: 'A',
    backendId: 'claude',   // these are ANTHROPIC_* bundles: they only mean anything on a Claude base (#161)
    // The plain Claude passthrough — no endpoint redirect, host auth. Provided as the "blank-ish"
    // template; a user rarely needs a profile for this (the built-in `claude` backend covers it).
    model: '',
    haikuModel: '',
    env: { ...STABILITY },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: 'deepseek',
    axis: 'A',
    backendId: 'claude',   // these are ANTHROPIC_* bundles: they only mean anything on a Claude base (#161)
    model: 'deepseek-v4-pro',
    haikuModel: 'deepseek-v4-flash',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
      // DeepSeek validated metadata.user_id against ^[A-Za-z0-9_-]+$; CC's default id fails -> mid-session
      // 400s once a subagent spawns. Shallow-merged into every request body. Harmless insurance.
      CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"user_id":"switchboard-deepseek"}}',
      ...STABILITY,
    },
  },
  {
    id: 'glm',
    name: 'GLM (Z.ai)',
    icon: 'glm',
    axis: 'A',
    backendId: 'claude',   // these are ANTHROPIC_* bundles: they only mean anything on a Claude base (#161)
    model: 'glm-4.6',
    haikuModel: 'glm-4.6',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.6',
      CLAUDE_CODE_SUBAGENT_MODEL: 'glm-4.6',
      API_TIMEOUT_MS: '3000000',
      ...STABILITY,
    },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: 'openrouter',
    axis: 'A',
    backendId: 'claude',   // these are ANTHROPIC_* bundles: they only mean anything on a Claude base (#161)
    model: 'anthropic/claude-sonnet-4.6',
    haikuModel: 'anthropic/claude-haiku-latest',
    env: {
      // NOTE: /api NOT /api/v1 — Claude Code appends /v1/messages itself.
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: '$OPENROUTER_API_KEY',
      ANTHROPIC_API_KEY: '', // empty is a HARD requirement for OpenRouter
      ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4.6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-sonnet-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-latest',
      CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/claude-haiku-latest',
      ...STABILITY,
    },
  },
];

// The env keys the structured Model field owns. Writing the model box rewrites ALL of these so no
// single var is left pointing at Anthropic (host-key-leak guard).
const MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

// Apply a chosen model (and haiku redirect) to an env bundle, writing the whole consistent set.
// Returns a NEW bundle. An empty model leaves the vars untouched (Anthropic passthrough).
function applyModel(env, model, haikuModel) {
  const out = { ...(env || {}) };
  if (!model) return out;
  const haiku = haikuModel || model;
  out.ANTHROPIC_MODEL = model;
  out.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  out.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  out.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  out.CLAUDE_CODE_SUBAGENT_MODEL = haiku;
  return out;
}

function getPreset(id) {
  return PRESETS.find(p => p.id === id) || null;
}

module.exports = { PRESETS, MODEL_VARS, applyModel, getPreset };
