// The Sessions tab's pixel icon (#383) — the one tab icon that says whether anything is working.
//
// Reaches into nothing. app.js drives it through two entry points: applyPixelSessionIcon() when the
// global settings are applied, setPixelSessionIconWorking() when a session's status changes. The
// element is built lazily on the first enable and then kept.
//
// The artwork is written as a 20x20 grid of strings, so it can be read and edited as a picture. Each
// frame becomes ONE `<path>` (horizontal runs per row), and the `<svg>` carries
// shape-rendering="crispEdges" so cell edges snap to device pixels instead of blurring at the 125% /
// 150% Windows display scales.
//
// Six frames in four groups (PHASES): idle open / blinking, one still per walk step, and the two
// typing frames. This file owns WHICH group is visible, because the walk is a timed sequence and CSS
// alone cannot play one once and hold — the CSS only owns the two looping animations inside a group.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GRID = 20;

  // '#' is a filled cell, anything else is empty. Rows top to bottom.
  //
  // It is a small octopus. The same nine-wide dome carries both states, so it stays one character:
  // centred with its tentacles hanging while nothing is working, turned to the side at a laptop while
  // something is. Everything is one colour, so shapes are told apart by the gaps between them — never
  // by overlapping.
  const PIXEL_ICON_FRAMES = {
    // Idle: the octopus sits square to the viewer — one solid body, four short stubby legs, eyes as
    // two holes in the upper half.
    idle: [
      '....................',
      '....................',
      '...##############...',
      '.##################.',
      '.##################.',
      '.##################.',
      '.####..######..####.',
      '.####..######..####.',
      '.##################.',
      '.##################.',
      '.##################.',
      '.##################.',
      '..################..',
      '..################..',
      '..##...##..##...##..',
      '..##...##..##...##..',
      '..##...##..##...##..',
      '..##...##..##...##..',
      '....................',
      '....................',
    ],
    // The blink: the upper eye row closes, the lower one stays open.
    idleBlink: [
      '....................',
      '....................',
      '...##############...',
      '.##################.',
      '.##################.',
      '.##################.',
      '.##################.',
      '.####..######..####.',
      '.##################.',
      '.##################.',
      '.##################.',
      '.##################.',
      '..################..',
      '..################..',
      '..##...##..##...##..',
      '..##...##..##...##..',
      '..##...##..##...##..',
      '..##...##..##...##..',
      '....................',
      '....................',
    ],
    // The two steps between the states, played forwards on the way to the laptop and backwards on the
    // way home — one set of art, symmetric both ways. First the octopus shifts aside…
    walk1: [
      '....................',
      '....................',
      '..##############....',
      '##################..',
      '##################..',
      '##################..',
      '####..######..####..',
      '####..######..####..',
      '##################..',
      '##################..',
      '##################..',
      '##################..',
      '.################...',
      '.################...',
      '.##...##..##...##...',
      '.##...##..##...##...',
      '.##...##..##...##...',
      '.##...##..##...##...',
      '....................',
      '....................',
    ],
    // …then it is standing where it works and the laptop is sliding in from the right.
    walk2: [
      '....................',
      '....................',
      '..############......',
      '.##############.....',
      '################....',
      '################....',
      '####..####..####....',
      '####..####..####....',
      '################...#',
      '################...#',
      '################...#',
      '.##############....#',
      '.##############....#',
      '.##..##..##..##....#',
      '.##..##..##..##....#',
      '.##..##..##..##....#',
      '.##..##..##..##..###',
      '.##..##..##..##..###',
      '....................',
      '....................',
    ],
    // Working: the same octopus stands at a laptop — screen upright on the right, base under it. Three
    // legs stay put, the fourth reaches across with its tip held off the keys.
    work: [
      '....................',
      '....................',
      '..############......',
      '.##############.....',
      '################....',
      '################....',
      '####..####..####....',
      '####..####..####....',
      '################.###',
      '################.###',
      '################.###',
      '.##############..###',
      '.##############..###',
      '.##..##..#######.###',
      '.##..##..##......###',
      '.##..##..##......###',
      '.##..##..##.########',
      '.##..##..##.########',
      '....................',
      '....................',
    ],
    // The second typing frame: that leg reaches two rows further down, onto the keys.
    workAlt: [
      '....................',
      '....................',
      '..############......',
      '.##############.....',
      '################....',
      '################....',
      '####..####..####....',
      '####..####..####....',
      '################.###',
      '################.###',
      '################.###',
      '.##############..###',
      '.##############..###',
      '.##..##..#######.###',
      '.##..##..##...##.###',
      '.##..##..##...##.###',
      '.##..##..##.########',
      '.##..##..##.########',
      '....................',
      '....................',
    ],
  };

  // A grid to one `d`. Cells are merged into horizontal runs first: fewer subpaths, and no seam
  // between two cells that sit next to each other in the same row.
  function pixelGridToPath(rows) {
    const parts = [];
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      let x = 0;
      while (x < row.length) {
        if (row[x] !== '#') { x++; continue; }
        let width = 1;
        while (row[x + width] === '#') width++;
        parts.push(`M${x} ${y}h${width}v1h-${width}z`);
        x += width;
      }
    }
    return parts.join('');
  }

  function svgEl(doc, name, attrs) {
    const el = doc.createElementNS(SVG_NS, name);
    for (const key of Object.keys(attrs)) el.setAttribute(key, attrs[key]);
    return el;
  }

  function sessionsTabEl(doc) {
    return doc.querySelector('.sidebar-tab[data-tab="sessions"]');
  }

  // Builds the icon into the Sessions tab, once. Returns the element, or null when there is no tab
  // (the standalone windows have no sidebar) or it is already there.
  function buildPixelSessionIcon(doc) {
    const button = sessionsTabEl(doc);
    if (!button || button.querySelector('.tab-icon-pixel')) return null;
    const svg = svgEl(doc, 'svg', {
      class: 'tab-icon-pixel',
      width: '20',
      height: '20',
      viewBox: `0 0 ${GRID} ${GRID}`,
      fill: 'currentColor',
      'shape-rendering': 'crispEdges',
      'aria-hidden': 'true',
    });
    for (const phase of PHASES) {
      const group = svgEl(doc, 'g', { class: 'pi-' + phase.name });
      for (const [index, frame] of phase.frames.entries()) {
        group.appendChild(svgEl(doc, 'path', {
          class: index === 0 ? 'pi-frame-a' : 'pi-frame-b',
          d: pixelGridToPath(PIXEL_ICON_FRAMES[frame]),
        }));
      }
      svg.appendChild(group);
    }
    button.appendChild(svg);
    return svg;
  }

  // The walk between the two states. Index 0 is home, the last index is the desk; the two in between
  // are the transition, played in whichever direction the current index has to travel.
  const PHASES = [
    { name: 'idle', frames: ['idle', 'idleBlink'] },
    { name: 'walk1', frames: ['walk1'] },
    { name: 'walk2', frames: ['walk2'] },
    { name: 'work', frames: ['work', 'workAlt'] },
  ];
  const WORK_PHASE = PHASES.length - 1;
  const STEP_MS = 120;
  // Busy is partly an OSC-spinner guess and can flip inside a second. Without this the octopus would
  // turn round mid-walk on every spike and never arrive anywhere.
  const SETTLE_MS = 300;

  let desiredWorking = false;
  let phaseIndex = 0;
  let settleTimer = null;
  let stepTimer = null;

  function applyPhase() {
    const button = typeof document !== 'undefined' && sessionsTabEl(document);
    if (!button) return;
    PHASES.forEach((phase, i) => button.classList.toggle('pi-phase-' + phase.name, i === phaseIndex));
    // `.working` stays the outward state, so anything else keying off it sees the destination, not the
    // walk. It flips on arrival, not on departure.
    button.classList.toggle('working', phaseIndex === WORK_PHASE);
  }

  function step() {
    stepTimer = null;
    // The target is re-read every step, so a state that flips mid-walk turns the octopus round from
    // wherever it is rather than queueing a second trip.
    const target = desiredWorking ? WORK_PHASE : 0;
    if (phaseIndex === target) return;
    phaseIndex += phaseIndex < target ? 1 : -1;
    applyPhase();
    if (phaseIndex !== target) stepTimer = setTimeout(step, STEP_MS);
  }

  // On/off for the whole thing. Off leaves the classic mark in place; the pixel element is only built
  // the first time it is actually wanted, and it appears already in the right state — the walk is for
  // a change the user watches, not for one they caused by opening a settings panel.
  function applyPixelSessionIcon(enabled) {
    if (typeof document === 'undefined' || !document.body) return;
    if (enabled) {
      buildPixelSessionIcon(document);
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
      phaseIndex = desiredWorking ? WORK_PHASE : 0;
      applyPhase();
    }
    document.body.classList.toggle('pixel-session-icon', !!enabled);
  }

  // Idle ⇄ working. Called on every status edge, so it does nothing at all unless the answer changed.
  function setPixelSessionIconWorking(working) {
    if (typeof document === 'undefined') return;
    working = !!working;
    if (working === desiredWorking) return;
    desiredWorking = working;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(function () {
      settleTimer = null;
      if (!stepTimer) step();
    }, SETTLE_MS);
  }

  return {
    PIXEL_ICON_FRAMES,
    pixelGridToPath,
    buildPixelSessionIcon,
    applyPixelSessionIcon,
    setPixelSessionIconWorking,
  };
});
