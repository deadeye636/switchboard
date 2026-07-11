// public/backend-icons.js — monogram badge SVGs for backends/profiles (vanilla renderer).
// Built with createElementNS + textContent (never innerHTML) so a user-supplied profile name/icon
// slug can never inject markup (XSS-safe). Ported from ivandobsky profile-icons.js, generalized to
// backends. Exposes window.renderBackendIcon(key, size) -> SVGElement and a colour lookup.
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Per-backend/preset badge colour tokens (also used by the CSS badge classes). A key with no
  // entry falls back to a neutral slate.
  var COLOURS = {
    claude: '#d97757',
    codex: '#10a37f',
    hermes: '#8b5cf6',
    pi: '#f59e0b',
    gemini: '#4285f4',
    anthropic: '#d97757',
    deepseek: '#4d6bfe',
    glm: '#2f6df6',
    openrouter: '#64748b',
    _default: '#64748b',
  };

  // Short glyph shown inside the badge, keyed by backend/preset id.
  var MONOGRAMS = {
    claude: 'C', codex: 'Cx', hermes: 'H', pi: 'Pi', gemini: 'G',
    anthropic: 'A', deepseek: 'DS', glm: 'GL', openrouter: 'OR',
  };

  function colourFor(key) {
    return COLOURS[key] || COLOURS._default;
  }

  function monogramFor(key, explicit) {
    if (explicit) return String(explicit);
    if (MONOGRAMS[key]) return MONOGRAMS[key];
    // Derive from the key: first two alnum chars, capitalized.
    var s = String(key || '?').replace(/[^A-Za-z0-9]/g, '');
    return (s.slice(0, 2) || '?').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  // Render a rounded-square monogram badge. `key` = backend/preset id (drives colour + default
  // glyph); optional `opts.monogram` overrides the glyph, `opts.colour` the fill.
  function renderBackendIcon(key, size, opts) {
    opts = opts || {};
    var s = size || 20;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('viewBox', '0 0 ' + s + ' ' + s);
    svg.setAttribute('class', 'backend-icon backend-icon-' + String(key || 'default'));

    var rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', String(s));
    rect.setAttribute('height', String(s));
    rect.setAttribute('rx', String(Math.round(s * 0.25)));
    rect.setAttribute('fill', opts.colour || colourFor(key));
    svg.appendChild(rect);

    var glyph = monogramFor(key, opts.monogram);
    var text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '50%');
    text.setAttribute('y', '50%');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', String(Math.round(s * (glyph.length > 1 ? 0.42 : 0.55))));
    text.setAttribute('font-weight', '600');
    text.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
    text.textContent = glyph; // textContent, never innerHTML — XSS-safe
    svg.appendChild(text);

    return svg;
  }

  window.renderBackendIcon = renderBackendIcon;
  window.backendIconColour = colourFor;
  window.backendMonogram = monogramFor;
})();
