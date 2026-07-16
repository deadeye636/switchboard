// public/backend-presets.js — renderer copy of the Axis-A preset templates (vanilla, no bundler).
// Mirrors backends/presets.js (main). The editor's "Add from template" list reads these; selecting
// one pre-fills the profile editor (name + icon + env bundle). Auth is always a $VAR ref — presets
// never carry a literal key. Keep this in sync with backends/presets.js.
(function () {
  'use strict';

  var STABILITY = {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  };

  var BACKEND_PRESETS = [
    {
      id: 'anthropic', name: 'Anthropic (default)', icon: 'anthropic', axis: 'A',
      model: '', haikuModel: '',
      env: Object.assign({}, STABILITY),
    },
    {
      id: 'deepseek', name: 'DeepSeek', icon: 'deepseek', axis: 'A',
      model: 'deepseek-v4-pro', haikuModel: 'deepseek-v4-flash',
      env: Object.assign({
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"user_id":"switchboard-deepseek"}}',
      }, STABILITY),
    },
    {
      id: 'glm', name: 'GLM (Z.ai)', icon: 'glm', axis: 'A',
      model: 'glm-4.6', haikuModel: 'glm-4.6',
      env: Object.assign({
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.6',
        CLAUDE_CODE_SUBAGENT_MODEL: 'glm-4.6',
        API_TIMEOUT_MS: '3000000',
      }, STABILITY),
    },
    {
      id: 'openrouter', name: 'OpenRouter', icon: 'openrouter', axis: 'A',
      model: 'anthropic/claude-sonnet-4.6', haikuModel: 'anthropic/claude-haiku-latest',
      env: Object.assign({
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: '$OPENROUTER_API_KEY',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: 'anthropic/claude-sonnet-4.6',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-sonnet-4.6',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-latest',
        CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/claude-haiku-latest',
      }, STABILITY),
    },
  ];

  var MODEL_VARS = [
    'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  ];

  // Write the whole consistent model var set (haiku redirected) into a bundle. Empty model = no-op.
  function applyPresetModel(env, model, haikuModel) {
    var out = Object.assign({}, env || {});
    if (!model) return out;
    var haiku = haikuModel || model;
    out.ANTHROPIC_MODEL = model;
    out.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    out.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    out.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
    out.CLAUDE_CODE_SUBAGENT_MODEL = haiku;
    return out;
  }

  window.BACKEND_PRESETS = BACKEND_PRESETS;
  window.BACKEND_MODEL_VARS = MODEL_VARS;
  window.applyPresetModel = applyPresetModel;
})();
