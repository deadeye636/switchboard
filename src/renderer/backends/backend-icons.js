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
    agy: '#4285f4',
    anthropic: '#d97757',
    deepseek: '#4d6bfe',
    glm: '#2f6df6',
    openrouter: '#64748b',
    _default: '#64748b',
  };

  // Short glyph shown inside the badge, keyed by backend/preset id.
  var MONOGRAMS = {
    claude: 'C', codex: 'Cx', hermes: 'H', pi: 'Pi', agy: 'Ag',
    anthropic: 'A', deepseek: 'DS', glm: 'GL', openrouter: 'OR',
  };

  // Real artwork, for the keys that HAVE a logo — keyed the same way COLOURS and MONOGRAMS are, so a
  // backend gets one by declaring `icon: '<key>'` on its descriptor and nothing else has to know (#212).
  // A key with no entry renders the monogram badge below, which stays the norm.
  //
  // This exists because the launch popover used to carry Anthropic's logo as a raw SVG string, emitted
  // only when the backend id read `claude` — the last hardcoded backend in dialogs.js. The logo was
  // worth keeping; the special case was not.
  //
  // `d` is OUR path data, never user input: the lookup is by exact key against this fixed map, so a
  // profile slug either names an entry we wrote or falls through to the monogram. The path is still
  // built with createElementNS + setAttribute rather than innerHTML, for the reason backendBadgeHtml
  // spells out below — do not turn this into string concatenation.
  var ART = {
    anthropic: {
      viewBox: '0 0 1200 1200',
      fill: '#d97757',
      d: 'M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z',
    },
  };

  // OWN properties only. These maps are keyed by a slug that is USER-SUPPLIED for an Axis-A profile, and
  // a plain object answers to every name on Object.prototype: `ART['constructor']` is truthy, so a
  // profile with `icon: 'constructor'` would take the artwork branch and draw a path of "undefined".
  // Nothing injects (setAttribute escapes), but the icon breaks. Look up by own property and unknown
  // slugs fall through to the derived monogram, which is what they should do.
  function own(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }

  function colourFor(key) {
    return own(COLOURS, key) || COLOURS._default;
  }

  // A logo from ART: the artwork's own viewBox, scaled to `size`, with no badge rect behind it — these
  // are drawn to sit on the surface, not inside a coloured square. Built node by node, like the badge.
  function renderArt(key, art, s) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('viewBox', art.viewBox);
    svg.setAttribute('class', 'backend-icon backend-icon-art backend-icon-' + String(key || 'default'));
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', art.d);
    path.setAttribute('fill', art.fill);
    path.setAttribute('stroke', 'none');
    svg.appendChild(path);
    return svg;
  }

  function monogramFor(key, explicit) {
    if (explicit) return String(explicit);
    if (own(MONOGRAMS, key)) return own(MONOGRAMS, key);
    // Derive from the key: first two alnum chars, capitalized.
    var s = String(key || '?').replace(/[^A-Za-z0-9]/g, '');
    return (s.slice(0, 2) || '?').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  // Render a backend's icon: its real logo when ART has one for `key`, otherwise a rounded-square
  // monogram badge. `key` = backend/preset id or the descriptor's declared `icon` slug (drives artwork,
  // colour and default glyph); optional `opts.monogram` overrides the glyph, `opts.colour` the fill.
  function renderBackendIcon(key, size, opts) {
    opts = opts || {};
    var s = size || 20;
    var art = own(ART, key);
    if (art) return renderArt(key, art, s);

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

  /**
   * The same badge as MARKUP, for the views that build their rows as HTML strings rather than DOM
   * (tasks-view / bookmarks-view render a template string into innerHTML). Returns '' for no key, so a
   * caller can concatenate it unconditionally.
   *
   * Still XSS-safe, and the reason is worth stating precisely: the badge is BUILT as a DOM tree above
   * (createElementNS + textContent) and only then serialized. Serialization escapes the `"` that would
   * end an attribute (and `&`), so a profile id like `"><img onerror=…>` comes back sealed INSIDE the
   * class value — its characters survive, but it can never become markup. (Attribute serialization does
   * NOT escape `<`/`>`; it does not need to. `test/backend-badge-html.test.js` pins the real property:
   * re-parsing injects no node and no handler.) What would NOT be safe is assembling the same SVG by
   * string concatenation — don't refactor it into that.
   */
  function backendBadgeHtml(key, size, opts) {
    if (!key) return '';
    return renderBackendIcon(key, size, opts).outerHTML;
  }

  window.renderBackendIcon = renderBackendIcon;
  window.backendBadgeHtml = backendBadgeHtml;
  window.backendIconColour = colourFor;
  window.backendMonogram = monogramFor;
})();
