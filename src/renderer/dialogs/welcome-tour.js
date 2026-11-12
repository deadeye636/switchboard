// welcome-tour.js — the first-launch tour (#146).
//
// A welcome pane and one pane per thing a fresh installation does not explain by itself, over one dialog.
// `PANES` is the list; nothing here writes down how many there are. Shown once, on the first launch of a
// profile that has no `welcomeDismissed` in its global settings, and reachable afterwards from
// Settings → Maintenance.
//
// Three things about it are decisions rather than taste, and they are the ones to keep:
//
//   THE CONTROLS ARE REAL. A pane that says "switch this on" and then sends the user looking for the
//   switch has explained a problem and left it standing. Every pane that names a setting also writes it.
//   What keeps that from becoming a second settings screen is the where-line: each pane names the screen
//   and section its setting lives in, and Settings stays the complete list. `test/welcome-tour.test.js`
//   holds the other half — every key written here is also written by settings-panel.js.
//
//   THERE IS NO SINGLE DOOR. `merge-setting` is a SHALLOW spread (src/app/settings.js:386) and it does
//   not re-arm the backends. So a nested value (`backendDefaults.<id>.<opt>`, `shortcuts.<id>`) and
//   anything needing the re-arm (`backendEnabled`) go through a read-modify-write on `set-setting`, the
//   way settings-panel.js does it. A shallow merge of `backendEnabled` drops every other backend's state.
//   A CLI's mode select (#761) writes every id of the CLI in that same one write, and moves a stored
//   `defaultLaunchTarget` that pointed at a mode now off — the values the Backends list writes, because
//   both ask `backendModes` (src/shared/backend-modes.js) for them.
//
//   IT NAMES NO BACKEND. The attention pane's toggle is resolved by asking the registry which backend
//   DECLARES an integration field with that id, the review pane's by asking which one declares that config
//   option, and the keep-warm pane's by asking which installed, enabled one answers the `idleMaintenance`
//   capability (the projection of the descriptor hook of that name). Each pane disappears when no backend
//   declares its own. The ids named here (`attentionHooks`, `mcpEmulation`, `idleMaintenance`) are
//   capability ids, not backend ids — reflex 5. The CLIs pane groups through `backendModes.cliGroups`.
//
// The figures are drawn here rather than shipped as images, because five of them answer to the pane's
// own controls: pick Grid and the picture shows Grid, type a directory name and the tree shows it. A
// picture that has to follow a number cannot be a PNG. The plan called for pane 2's to be a real
// screenshot, since it is about WHERE a control is rather than what it does; it is drawn too, and
// `FIG_GEAR` carries the argument. **There is no image file and no `assets/` directory.**
//
// Depends on renderer globals: window.api · window.isDetachedWindow (shell/detach-window.js) ·
// window._backendsById, window._defaultBackendId (backends/backend-registry.js) · window.backendBadgeHtml (backends/backend-icons.js) ·
// reapplyGlobalSettings (app.js) · backendModes (shared/backend-modes.js) · SESSION_SIDEBAR_GROUP_NAMES
// (lib/sidebar-groups.js) · conventionDirNameProblem (shared/convention-dir-name.js). All read at call time;
// the section names are asked with `typeof` first, and `backendModes` only once the registry has a backend.

(function () {
  const FLAG = 'welcomeDismissed';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  // ── The figures ────────────────────────────────────────────────────────────────────────────────
  // Every one is a schematic. They carry no real path, project or session name — the app they draw is
  // an invented one, which is also what keeps them safe to ship in a public repo.

  const FIG_PANES = `
    <svg viewBox="0 0 640 240" role="img" aria-label="A pane with four edge drop zones that split it and a centre zone that moves the tab">
      <rect x="120" y="20" width="400" height="200" rx="10" fill="#1a1a24" stroke="rgba(255,255,255,0.10)"/>
      <g fill="rgba(128,136,255,0.14)" stroke="rgba(128,136,255,0.45)" stroke-dasharray="4 4">
        <rect x="128" y="28" width="384" height="44" rx="6"/>
        <rect x="128" y="168" width="384" height="44" rx="6"/>
        <rect x="128" y="76" width="86" height="88" rx="6"/>
        <rect x="426" y="76" width="86" height="88" rx="6"/>
      </g>
      <rect x="222" y="76" width="196" height="88" rx="6" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.14)" stroke-dasharray="4 4"/>
      <g font-family="sans-serif" font-size="11" fill="#8088ff" text-anchor="middle">
        <text x="320" y="55">split above</text>
        <text x="320" y="195">split below</text>
        <text x="171" y="124">split left</text>
        <text x="469" y="124">split right</text>
      </g>
      <text x="320" y="124" font-family="sans-serif" font-size="11" fill="#9090a8" text-anchor="middle">move here</text>
      <rect x="24" y="96" width="80" height="26" rx="5" fill="#242433" stroke="rgba(255,255,255,0.14)"/>
      <circle cx="38" cy="109" r="3.6" fill="#3ecf5a"/>
      <text x="50" y="113" font-family="sans-serif" font-size="10.5" fill="#c8c8d8">session</text>
      <path d="M108 109 H 148" stroke="#8088ff" stroke-width="1.6" stroke-dasharray="4 4" fill="none"/>
      <path d="M142 104 l7 5 -7 5" fill="none" stroke="#8088ff" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;

  // The one pane whose figure is about WHERE something is rather than what it does. It is drawn, not
  // photographed: a screenshot of the settings screen goes stale on the next restyle, has to be re-shot
  // and re-checked for a stray project name every time (rule 6), and would be the only binary asset the
  // renderer has. The schematic says the one thing the sentence cannot — that the gear opens more than
  // launch defaults.
  const FIG_GEAR = `
    <svg viewBox="0 0 640 220" role="img" aria-label="The Backends list with the gear on a backend row circled, and the Integrations page it opens">
      <rect x="14" y="16" width="290" height="188" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.08)"/>
      <text x="28" y="40" fill="#7a7a90" font-family="sans-serif" font-size="10" letter-spacing="1.2">BACKENDS</text>
      <g font-family="sans-serif" font-size="11.5">
        <rect x="26" y="52" width="266" height="34" rx="6" fill="rgba(128,136,255,0.10)" stroke="rgba(128,136,255,0.35)"/>
        <text x="40" y="73" fill="#e0e0f0">your CLI</text>
        <circle cx="268" cy="69" r="12" fill="none" stroke="#8088ff" stroke-width="1.5"/>
        <circle cx="268" cy="69" r="3.4" fill="none" stroke="#8088ff" stroke-width="1.4"/>
        <g stroke="#8088ff" stroke-width="1.4" stroke-linecap="round">
          <path d="M268 62.4v-2.6M268 78.2v-2.6M274.6 69h2.6M258.8 69h2.6"/>
        </g>
        <rect x="26" y="92" width="266" height="30" rx="6" fill="rgba(255,255,255,0.03)"/>
        <rect x="26" y="126" width="266" height="30" rx="6" fill="rgba(255,255,255,0.03)"/>
        <rect x="26" y="160" width="266" height="30" rx="6" fill="rgba(255,255,255,0.03)"/>
      </g>
      <path d="M300 69 H 336" stroke="#8088ff" stroke-width="1.6" fill="none" stroke-dasharray="4 4"/>
      <path d="M330 64 l7 5 -7 5" fill="none" stroke="#8088ff" stroke-width="1.6" stroke-linejoin="round"/>
      <rect x="344" y="16" width="282" height="188" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.08)"/>
      <g font-family="sans-serif" font-size="11.5">
        <text x="358" y="40" fill="#7a7a90" font-size="10" letter-spacing="1.2">THAT BACKEND</text>
        <text x="358" y="64" fill="#6a6a80">Launch defaults</text>
        <rect x="356" y="76" width="256" height="4" rx="2" fill="rgba(255,255,255,0.05)"/>
        <rect x="356" y="90" width="200" height="4" rx="2" fill="rgba(255,255,255,0.05)"/>
        <text x="358" y="124" fill="#8088ff" font-weight="600">Integrations</text>
        <rect x="356" y="136" width="256" height="46" rx="6" fill="rgba(128,136,255,0.08)" stroke="rgba(128,136,255,0.3)"/>
        <text x="370" y="156" fill="#e0e0f0" font-size="10.5">Hooks for attention</text>
        <text x="370" y="171" fill="#7a7a90" font-size="10">Off until you switch it on</text>
        <rect x="566" y="150" width="30" height="17" rx="8.5" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.18)"/>
        <circle cx="574.5" cy="158.5" r="6" fill="#6a6a80"/>
      </g>
    </svg>`;

  const FIG_GRID = `
    <svg viewBox="0 0 640 240" role="img" aria-label="Grid mode: four sessions in equal cells, arranged by the app">
      <rect x="120" y="20" width="400" height="200" rx="10" fill="#1a1a24" stroke="rgba(255,255,255,0.10)"/>
      <g fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.10)">
        <rect x="132" y="32" width="184" height="84" rx="6"/>
        <rect x="324" y="32" width="184" height="84" rx="6"/>
        <rect x="132" y="124" width="184" height="84" rx="6"/>
        <rect x="324" y="124" width="184" height="84" rx="6"/>
      </g>
      <g font-family="sans-serif" font-size="10" fill="#7a7a90">
        <circle cx="146" cy="48" r="3.4" fill="#3ecf5a"/><text x="156" y="52">session</text>
        <circle cx="338" cy="48" r="3.4" fill="#3ecf5a"/><text x="348" y="52">session</text>
        <circle cx="146" cy="140" r="3.4" fill="#6a6a80"/><text x="156" y="144">session</text>
        <circle cx="338" cy="140" r="3.4" fill="#6a6a80"/><text x="348" y="144">session</text>
      </g>
      <g fill="rgba(255,255,255,0.06)">
        <rect x="144" y="64" width="140" height="6" rx="2"/><rect x="144" y="78" width="104" height="6" rx="2"/>
        <rect x="336" y="64" width="150" height="6" rx="2"/><rect x="336" y="78" width="88" height="6" rx="2"/>
        <rect x="144" y="156" width="120" height="6" rx="2"/><rect x="144" y="170" width="146" height="6" rx="2"/>
        <rect x="336" y="156" width="132" height="6" rx="2"/><rect x="336" y="170" width="96" height="6" rx="2"/>
      </g>
      <text x="320" y="236" font-family="sans-serif" font-size="11" fill="#7a7a90" text-anchor="middle">equal cells, arranged for you — nothing to drag</text>
    </svg>`;

  // The sidebar's real rule, from shell/sidebar.js: a session stays listed when it is running or pinned,
  // OR when it is inside BOTH the count and the age. 0 means "no limit" for either (#144) — the figure
  // has to say that, because a 0 that reads as "none" is the exact misunderstanding this pane exists for.
  const DEMO_SESSIONS = [
    { running: true, age: 0 }, { running: true, age: 0 }, { running: false, age: 0 },
    { running: false, age: 1 }, { running: false, age: 2 }, { running: false, age: 2 },
    { running: false, age: 4 }, { running: false, age: 5 }, { running: false, age: 7 },
    { running: false, age: 9 }, { running: false, age: 11 }, { running: false, age: 14 },
    { running: false, age: 21 }, { running: false, age: 30 },
  ];

  function figSidebar(maxAgeDays, shown) {
    const maxAge = Number(maxAgeDays);
    const limit = Number(shown);
    const visible = [];
    let count = 0;
    for (const item of DEMO_SESSIONS) {
      const withinCount = limit === 0 || count < limit;
      const withinAge = maxAge === 0 || item.age <= maxAge;
      if (item.running || (withinCount && withinAge)) { visible.push(item); count++; }
    }
    const hidden = DEMO_SESSIONS.length - visible.length;
    const drawn = visible.slice(0, 6);
    const rows = drawn.map((item, i) => {
      const y = 74 + i * 22;
      return `<circle cx="242" cy="${y}" r="3.6" fill="${item.running ? '#3ecf5a' : '#6a6a80'}"/>
        <rect x="254" y="${y - 4}" width="${118 - (i % 3) * 16}" height="7" rx="2" fill="rgba(255,255,255,0.08)"/>
        <text x="404" y="${y + 3}" font-family="sans-serif" font-size="9" fill="#5a5a70" text-anchor="end">${item.running ? 'running' : item.age + 'd'}</text>`;
    }).join('');
    const more = visible.length > drawn.length
      ? `<text x="254" y="${74 + drawn.length * 22 + 3}" font-family="sans-serif" font-size="10" fill="#6a6a80">… ${visible.length - drawn.length} more listed</text>`
      : '';
    const foldY = 74 + (drawn.length + (more ? 1 : 0)) * 22;
    const fold = hidden > 0
      ? `<text x="254" y="${foldY + 3}" font-family="sans-serif" font-size="10.5" fill="#8088ff">+ ${hidden} older</text>`
      : `<text x="254" y="${foldY + 3}" font-family="sans-serif" font-size="10.5" fill="#6a6a80">nothing folded away</text>`;
    return `<svg viewBox="0 0 640 240" role="img" aria-label="A project in the sidebar with ${visible.length} sessions listed and ${hidden} folded away">
        <rect x="212" y="20" width="216" height="200" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.08)"/>
        <text x="236" y="46" font-family="sans-serif" font-size="10" fill="#7a7a90" letter-spacing="1.2">PROJECTS</text>
        <path d="M236 62 l6 5 -6 5" fill="none" stroke="#8088ff" stroke-width="1.4" stroke-linejoin="round"/>
        <text x="252" y="71" font-family="sans-serif" font-size="11.5" fill="#e0e0f0" font-weight="600">my-project</text>
        ${rows}${more}${fold}
        <text x="320" y="234" font-family="sans-serif" font-size="10" fill="#5a5a70" text-anchor="middle">14 sessions, 2 of them running · 0 in either field means no limit</text>
      </svg>`;
  }

  function figClose(stopSession) {
    return `<svg viewBox="0 0 640 200" role="img" aria-label="Closing a session tab: ${stopSession ? 'the session stops' : 'the view closes and the session keeps running'}">
        <rect x="30" y="52" width="200" height="96" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.08)"/>
        <rect x="42" y="64" width="120" height="24" rx="5" fill="#242433" stroke="rgba(255,255,255,0.14)"/>
        <circle cx="56" cy="76" r="3.6" fill="#3ecf5a"/>
        <text x="68" y="80" font-family="sans-serif" font-size="10.5" fill="#c8c8d8">session</text>
        <g stroke="#e06c75" stroke-width="1.6" stroke-linecap="round">
          <path d="M144 72 l10 8 M154 72 l-10 8"/>
        </g>
        <text x="42" y="112" font-family="sans-serif" font-size="10" fill="#6a6a80">you click the ×</text>
        <path d="M246 100 H 306" stroke="#8088ff" stroke-width="1.6" stroke-dasharray="4 4" fill="none"/>
        <path d="M300 95 l7 5 -7 5" fill="none" stroke="#8088ff" stroke-width="1.6" stroke-linejoin="round"/>
        <rect x="322" y="52" width="288" height="96" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.08)"/>
        <text x="336" y="76" font-family="sans-serif" font-size="10" fill="#7a7a90" letter-spacing="1.2">SIDEBAR</text>
        <circle cx="340" cy="102" r="4" fill="${stopSession ? '#6a6a80' : '#3ecf5a'}"/>
        <rect x="354" y="97" width="130" height="8" rx="2" fill="rgba(255,255,255,0.10)"/>
        <text x="354" y="128" font-family="sans-serif" font-size="11" fill="${stopSession ? '#e0a34a' : '#3ecf5a'}">${stopSession ? 'the agent was stopped' : 'the agent keeps running'}</text>
      </svg>`;
  }

  function figEdits(inside) {
    if (inside) {
      return `<svg viewBox="0 0 640 210" role="img" aria-label="The change opens in a review panel inside Switchboard">
          <rect x="60" y="20" width="520" height="170" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.10)"/>
          <text x="76" y="42" font-family="sans-serif" font-size="10" fill="#7a7a90" letter-spacing="1.2">SWITCHBOARD</text>
          <rect x="76" y="54" width="240" height="120" rx="6" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)"/>
          <g fill="rgba(255,255,255,0.07)">
            <rect x="90" y="72" width="180" height="7" rx="2"/><rect x="90" y="88" width="140" height="7" rx="2"/>
            <rect x="90" y="104" width="204" height="7" rx="2"/><rect x="90" y="120" width="120" height="7" rx="2"/>
          </g>
          <text x="90" y="164" font-family="sans-serif" font-size="10" fill="#5a5a70">terminal</text>
          <rect x="328" y="54" width="236" height="120" rx="6" fill="rgba(128,136,255,0.07)" stroke="rgba(128,136,255,0.30)"/>
          <text x="342" y="74" font-family="sans-serif" font-size="10" fill="#8088ff" letter-spacing="1">REVIEW</text>
          <g transform="translate(342,86)">
            <rect x="0" y="0" width="118" height="7" rx="2" fill="rgba(224,108,117,0.25)"/>
            <rect x="0" y="14" width="96" height="7" rx="2" fill="rgba(62,207,90,0.25)"/>
            <rect x="0" y="28" width="110" height="7" rx="2" fill="rgba(62,207,90,0.25)"/>
          </g>
          <rect x="342" y="140" width="66" height="18" rx="5" fill="rgba(62,207,90,0.14)" stroke="rgba(62,207,90,0.35)"/>
          <text x="375" y="153" font-family="sans-serif" font-size="10" fill="#3ecf5a" text-anchor="middle">Accept</text>
          <rect x="416" y="140" width="66" height="18" rx="5" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)"/>
          <text x="449" y="153" font-family="sans-serif" font-size="10" fill="#9090a8" text-anchor="middle">Reject</text>
        </svg>`;
    }
    // Off, no bridge starts and no --ide is passed, so the CLI asks the way it does with no editor
    // attached: as text, in the terminal. It does NOT go to the user's own editor — that was wrong in
    // an earlier draft of this pane and is the kind of thing a picture makes permanent.
    return `<svg viewBox="0 0 640 210" role="img" aria-label="With the review panel off, the CLI asks in the terminal as text">
        <rect x="60" y="20" width="520" height="170" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.10)"/>
        <text x="76" y="42" font-family="sans-serif" font-size="10" fill="#7a7a90" letter-spacing="1.2">SWITCHBOARD</text>
        <rect x="76" y="54" width="488" height="120" rx="6" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)"/>
        <g font-family="ui-monospace, Consolas, monospace" font-size="11">
          <text x="92" y="76" fill="#7a7a90">Edit src/example.js</text>
          <text x="92" y="94" fill="#e06c75">- const enabled = value;</text>
          <text x="92" y="110" fill="#3ecf5a">+ const enabled = value === true;</text>
          <text x="92" y="134" fill="#c8c8d8">Do you want to make this edit?</text>
          <text x="92" y="152" fill="#8088ff">&gt; 1. Yes&#160;&#160;&#160;2. No, tell me what to do differently</text>
        </g>
        <text x="564" y="188" font-family="sans-serif" font-size="9.5" fill="#5a5a70" text-anchor="end">the terminal, nothing else</text>
      </svg>`;
  }

  // The session sidebar's section names, from lib/sidebar-groups.js — the list the sidebar and the settings
  // screen read. Never a copy here: a section added there is drawn and named here on the same day.
  function sidebarSectionLabels() {
    return typeof SESSION_SIDEBAR_GROUP_NAMES !== 'undefined' && Array.isArray(SESSION_SIDEBAR_GROUP_NAMES)
      ? SESSION_SIDEBAR_GROUP_NAMES.map((g) => g.label)
      : [];
  }

  function figSessionSidebar(open) {
    const labels = sidebarSectionLabels();
    const termRight = open ? 352 : 524;
    const lines = [150, 210, 120, 186, 96, 230, 140].map((w, i) => {
      const width = Math.min(w, termRight - 128);
      return `<rect x="116" y="${66 + i * 18}" width="${width}" height="6" rx="2" fill="rgba(255,255,255,0.07)"/>`;
    }).join('');
    const side = open
      ? `<rect x="364" y="52" width="164" height="144" rx="6" fill="rgba(128,136,255,0.07)" stroke="rgba(128,136,255,0.30)"/>
        ${labels.slice(0, 7).map((label, i) => `<path d="M376 ${68 + i * 18} l4 3 -4 3" fill="none" stroke="#8088ff" stroke-width="1.2" stroke-linejoin="round"/>
          <text x="388" y="${74 + i * 18}" font-family="sans-serif" font-size="10" fill="#c8c8d8">${esc(label)}</text>`).join('')}`
      : '';
    return `<svg viewBox="0 0 640 220" role="img" aria-label="A session with its sidebar ${open ? 'open on the right' : 'closed'}">
        <rect x="100" y="16" width="440" height="188" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.10)"/>
        <circle cx="116" cy="32" r="3.6" fill="#3ecf5a"/>
        <text x="128" y="36" font-family="sans-serif" font-size="10.5" fill="#c8c8d8">session</text>
        <rect x="506" y="23" width="22" height="18" rx="4" fill="${open ? 'rgba(128,136,255,0.18)' : 'rgba(255,255,255,0.04)'}" stroke="${open ? '#8088ff' : 'rgba(255,255,255,0.18)'}"/>
        <rect x="511" y="27" width="12" height="10" rx="1.5" fill="none" stroke="${open ? '#8088ff' : '#7a7a90'}" stroke-width="1.2"/>
        <path d="M519 27 V 37" stroke="${open ? '#8088ff' : '#7a7a90'}" stroke-width="1.2"/>
        ${lines}${side}
      </svg>`;
  }

  // A timeline from the user's last turn. Every mark on it is a model turn the app sends, so each is drawn
  // and labelled — the point of the pane is that none of them is free.
  function figIdle(mode) {
    const warm = mode === 'warm' || mode === 'warm-compact';
    const compact = mode === 'compact' || mode === 'warm-compact';
    const ticks = warm ? [170, 260, 350] : [];
    const compactAt = mode === 'compact' ? 300 : 460;
    const tickMarks = ticks.map((x) => `<circle cx="${x}" cy="96" r="5" fill="#d8a657"/>
        <text x="${x}" y="80" font-family="sans-serif" font-size="10" fill="#d8a657" text-anchor="middle">refresh</text>`).join('');
    const compactMark = compact
      ? `<rect x="${compactAt - 6}" y="90" width="12" height="12" rx="2" fill="#e06c75" transform="rotate(45 ${compactAt} 96)"/>
        <text x="${compactAt}" y="80" font-family="sans-serif" font-size="10" fill="#e06c75" text-anchor="middle">compact</text>`
      : '';
    const note = mode === 'off'
      ? 'nothing is sent while the session is idle'
      : 'each mark is a model turn that costs tokens';
    return `<svg viewBox="0 0 640 170" role="img" aria-label="What happens after your last turn while the session is idle: ${esc(note)}">
        <path d="M70 96 H 570" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
        <circle cx="70" cy="96" r="6" fill="#3ecf5a"/>
        <text x="70" y="122" font-family="sans-serif" font-size="10" fill="#7a7a90" text-anchor="middle">your last turn</text>
        <path d="M570 86 V 106" stroke="rgba(255,255,255,0.30)" stroke-width="1.5"/>
        <text x="570" y="122" font-family="sans-serif" font-size="10" fill="#7a7a90" text-anchor="middle">nothing after this</text>
        ${tickMarks}${compactMark}
        <text x="320" y="154" font-family="sans-serif" font-size="10.5" fill="${mode === 'off' ? '#5a5a70' : '#d8a657'}" text-anchor="middle">${esc(note)}</text>
      </svg>`;
  }

  // A name the app will not use is drawn as the directory it will use instead (#630). The figure promises
  // where the next plan and the next handoff go, and `../plans` or `.` is a value every project replaces —
  // so drawing it as typed made the tour the one surface still claiming the setting applied. The rule is
  // `unusableConventionDirName` in `src/shared/`, the same function `convention-dirs.js` asks, because a
  // second copy here is exactly how this divergence keeps coming back (CLAUDE.md reflex 12).
  // The wording per problem. The shared rule decides WHICH problem — a first attempt tested for `..` here
  // and called `docs/..` "outside the project" when it is the root, which is what a second derivation of a
  // rule looks like even when it is three words long.
  const DIR_PROBLEM_WORDS = {
    escapes: 'outside the project — the default is used instead',
    root: 'the project itself — the default is used instead',
    // The tour has no project, so it genuinely cannot say where an absolute path lands — and a figure that
    // drew it as a child of `my-project/` would be making exactly the claim this pane was fixed to stop.
    absolute: 'an absolute path is resolved per project, so it cannot be drawn here',
  };

  // When the two fields have DIFFERENT problems there is one caption and two things to say, so it stops
  // naming the reason. Taking the first — which is what `plan.why || handoff.why` did — left the second
  // value silently replaced with nothing on screen about it, a smaller version of the defect this figure
  // was fixed for. Both rows still draw their own fallback either way.
  //
  // "could be drawn" and not "can be used", because the two classes are not the same thing: a value that
  // leaves the project is one the app will not use, while an absolute one may be perfectly good and is
  // simply not placeable in a figure with no project behind it. One sentence has to be true of both.
  const TWO_PROBLEMS = 'neither value could be drawn here — the defaults are shown instead';

  function effectiveDirName(value, fallback) {
    const problem = conventionDirNameProblem(value);
    if (!problem) return { name: (value || '').trim(), why: '', problem: '' };
    return { name: fallback, why: DIR_PROBLEM_WORDS[problem] || '', problem: DIR_PROBLEM_WORDS[problem] ? problem : '' };
  }

  /**
   * One caption for two fields.
   *
   * When both fail the same way, or only one fails, that problem's own wording is the honest answer. When
   * they fail DIFFERENTLY there is no reason that covers both, so it names neither and says only that the
   * defaults are what is drawn.
   */
  function figCaption(plan, handoff) {
    if (plan.problem && handoff.problem && plan.problem !== handoff.problem) return TWO_PROBLEMS;
    return plan.why || handoff.why;
  }

  function figDirs(planDir, handoffDir) {
    const today = new Date().toISOString().slice(0, 10);
    const plan = effectiveDirName(planDir, '.plans');
    const handoff = effectiveDirName(handoffDir, '.handoffs');
    const p = esc(plan.name);
    const h = esc(handoff.name);
    const why = figCaption(plan, handoff);
    const line = (y, text, colour) =>
      `<text x="194" y="${y}" font-family="ui-monospace, Consolas, monospace" font-size="12" fill="${colour}">${text}</text>`;
    return `<svg viewBox="0 0 640 200" role="img" aria-label="Where a plan and a handoff are written inside the project">
        <rect x="150" y="20" width="340" height="160" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.08)"/>
        ${line(52, 'my-project/', '#e0e0f0')}
        ${line(78, '├─ ' + p + '/', '#8088ff')}
        ${line(100, '│&#160;&#160;└─ ' + today + '-plan.md', '#7a7a90')}
        ${line(126, '└─ ' + h + '/', '#8088ff')}
        ${line(148, '&#160;&#160;&#160;└─ ' + today + '-handoff.md', '#7a7a90')}
        <text x="320" y="176" font-family="sans-serif" font-size="10" fill="${why ? '#d8a657' : '#5a5a70'}" text-anchor="middle">${why
          ? esc(why)
          : 'both inside the project, both plain Markdown'}</text>
      </svg>`;
  }

  // ── The panes ──────────────────────────────────────────────────────────────────────────────────
  //
  // `setting` says how a control is written, and there is one shape per shape in the code (see the
  // header). `backendOption` and `integration` name a CAPABILITY id and are resolved through the registry,
  // so no backend is named here; `backendEnabled` and `backendMode` are built from the registry at open time.
  // A pane's `capability` names a capability row an installed, enabled backend has to answer for the pane
  // to be shown. A `body` may be a function, read when the pane is drawn.

  const PANES = [
    {
      rail: 'Welcome',
      intro: true,
      title: 'Welcome to Switchboard',
      body: `<p>Switchboard finds the coding-CLI sessions already on this machine, groups them by project,
        and keeps them running side by side. Nothing here starts a session on its own.</p>
        <p>The short panes that follow cover what a fresh installation does not explain by itself. Each
        one that names a setting lets you change it, right here. Settings → Maintenance brings the tour
        back at any time.</p>`,
    },
    {
      rail: 'Your CLIs',
      title: 'Switch on the CLIs you use',
      where: 'Settings → Backends',
      body: `<p>A fresh installation has <b>one CLI enabled and nothing else</b>. A backend that is off
        cannot be launched and is not scanned, so on a new machine its sessions never turn up and nothing
        on screen says why.</p>
        <p>Switch on the ones you work with before you go looking for their sessions. Switching one off
        later deletes nothing — it stops launching and re-scanning, it does not throw anything away.</p>`,
      controls: 'backends',   // built from the registry at open time
    },
    {
      rail: 'Attention',
      title: 'Let your CLI tell you when it needs you',
      where: 'Settings → Backends → the gear on the backend → Integrations',
      body: `<p>Switchboard can mark a session as waiting the moment the CLI asks for something. That runs
        off the CLI's own hooks, and <b>the hooks are off until you turn them on</b>.</p>
        <p>Without them the inbox falls back to reading the terminal title, which misses a permission
        prompt. The switch is one level in: the gear beside the backend's row, then Integrations.</p>`,
      controls: [{ kind: 'toggle', label: 'Hooks for attention', setting: { type: 'integration', field: 'attentionHooks' } }],
      figure: { svg: FIG_GEAR, cap: 'The gear on a backend row opens more than launch defaults — Integrations lives behind it.' },
    },
    {
      rail: 'Keep warm',
      title: 'Idle sessions can be kept warm or compacted',
      where: 'Settings → Session idle maintenance · the Idle button on a session',
      body: `<p>A session driven over a pipe can be looked after while you are away: its prompt cache kept
        warm so your next turn costs less, its context compacted, or both.</p>
        <p><b>Every refresh and every compaction is a real model turn</b>, counted against your plan or
        your API bill. A compaction cannot be undone. That is why this is off until you choose it.</p>
        <p>A project can set its own mode in its project settings. The Idle button on a running session
        changes it for that session alone.</p>`,
      // Shown only when an installed, enabled backend answers the `idleMaintenance` capability.
      capability: 'idleMaintenance',
      controls: [{
        kind: 'select',
        label: 'While a session sits idle',
        options: [
          { value: 'off', label: 'Off' }, { value: 'warm', label: 'Keep warm' },
          { value: 'compact', label: 'Compact only' }, { value: 'warm-compact', label: 'Warm then compact' },
        ],
        setting: { type: 'flat', key: 'idleMaintenanceMode', fallback: 'off' },
      }],
      figureOf: (v) => ({
        svg: figIdle(v[0]),
        cap: ({
          warm: 'Keep warm — a few refreshes after your last turn, then nothing.',
          compact: 'Compact only — one compaction once the session has sat idle for a while.',
          'warm-compact': 'Warm then compact — the refreshes first, then one compaction.',
        })[v[0]] || 'Off — nothing is sent while a session sits idle.',
      }),
    },
    {
      rail: 'Splitting',
      title: 'Drag a tab to an edge to split the view',
      where: 'Any session tab · Settings → Layout & tabs',
      body: `<p>Drop a tab on the <b>top, bottom, left or right edge</b> of a pane and the pane splits, with
        the dropped session taking the new half. Drop it in the middle and it simply moves there.</p>
        <p>The hint only appears once you are already dragging, which is why it is easy to use Switchboard
        for weeks without finding it.</p>
        <p>Splitting belongs to <b>Panes</b>. <b>Grid</b> is the other arrangement: every session gets an
        equal cell, arranged for you, with nothing to drag.</p>`,
      controls: [{
        kind: 'select',
        label: 'How sessions are arranged',
        desc: 'Panes: you split and size them. Grid: equal cells, arranged for you.',
        options: [{ value: 'panes', label: 'Panes' }, { value: 'grid', label: 'Grid' }],
        setting: { type: 'flat', key: 'sessionDisplayMode', fallback: 'panes' },
      }],
      figureOf: (v) => (v[0] === 'grid'
        ? { svg: FIG_GRID, cap: 'Grid — every session gets an equal cell and the app arranges them.' }
        : { svg: FIG_PANES, cap: 'Panes — four edges split, the centre moves.' }),
    },
    {
      rail: 'Sidebar',
      title: 'The sidebar trims itself',
      where: 'Settings → Projects & sidebar · Settings → Layout & tabs',
      body: `<p>Three defaults keep the list short. Sessions older than a few days fold behind “+N older”,
        each project shows only its most recent, and a project nobody has touched for a while starts
        collapsed.</p>
        <p>Nothing is deleted, and a running session never folds. If a session you expected is missing, it
        is behind one of those three — and a 0 in either number means no limit at all.</p>`,
      controls: [
        { kind: 'number', label: 'Fold sessions older than', desc: 'Days. 0 means no age limit.', unit: 'days', max: 365, setting: { type: 'flat', key: 'sessionMaxAgeDays', fallback: 3 } },
        { kind: 'number', label: 'Sessions shown per project', desc: 'The rest sit behind “+N older”. 0 means no limit.', max: 100, setting: { type: 'flat', key: 'visibleSessionCount', fallback: 10 } },
        { kind: 'number', label: 'Collapse a project untouched for', desc: 'Days. A project whose newest session is older than this starts folded.', unit: 'days', max: 365, setting: { type: 'flat', key: 'sidebarCollapseAgeDays', fallback: 3 } },
      ],
      figureOf: (v) => ({
        svg: figSidebar(v[0], v[1]),
        cap: 'A project with 14 sessions, folded by the two numbers above. A running session never folds.',
      }),
    },
    {
      rail: 'Session sidebar',
      title: 'Each session has a sidebar of its own',
      where: 'The sidebar button on a session · Settings → Sessions',
      // A function, so the section names are read from lib/sidebar-groups.js when the pane is drawn.
      body: () => {
        const labels = sidebarSectionLabels().map(esc);
        const list = labels.length > 1
          ? `: ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
          : '';
        return `<p>Next to every session sits a sidebar with what belongs to it${list}.</p>
        <p>The sidebar button on the session opens and closes it, and each session keeps its own choice.
        Drag a section by its grip to change the order, and right-click a section's heading to choose which
        ones are shown. Both apply to every session.</p>`;
      },
      controls: [{
        kind: 'select',
        label: 'In a new session, the sidebar starts',
        desc: 'A session you have already opened or closed it in keeps its own state.',
        options: [{ value: 'closed', label: 'Closed' }, { value: 'open', label: 'Open' }],
        setting: { type: 'flat', key: 'sessionSidebarDefault', fallback: 'closed' },
      }],
      figureOf: (v) => ({
        svg: figSessionSidebar(v[0] === 'open'),
        cap: v[0] === 'open'
          ? 'Open — a new session shows its sidebar on the right from the start.'
          : 'Closed — a new session starts without it; the button on the session opens it.',
      }),
    },
    {
      rail: 'Closing',
      title: 'Closing a tab does not stop the session',
      where: 'Settings → Layout & tabs · Settings → Terminal · Settings → Sessions',
      body: `<p>The × on a session tab closes the <b>view</b>. The agent keeps running, and the session is
        still in the sidebar to open again. Quitting Switchboard is what ends its child processes — you
        are asked first while sessions are still running.</p>
        <p>A plain terminal is the other way round: closing its tab ends it, because there is nothing to
        come back to.</p>`,
      controls: [
        {
          kind: 'select',
          label: 'Closing a session tab',
          options: [{ value: 'closeView', label: 'Close view' }, { value: 'stopSession', label: 'Stop session' }],
          setting: { type: 'flat', key: 'tabCloseBehavior', fallback: 'closeView' },
        },
        {
          kind: 'select',
          label: 'Closing a terminal tab',
          options: [{ value: 'kill', label: 'Kill the shell' }, { value: 'keep', label: 'Keep running' }],
          setting: { type: 'flat', key: 'terminalCloseBehavior', fallback: 'kill' },
        },
        {
          kind: 'toggle',
          label: 'Ask before quitting with sessions running',
          setting: { type: 'flat', key: 'confirmQuitWithRunningSessions', fallback: true },
        },
      ],
      figureOf: (v) => ({
        svg: figClose(v[0] === 'stopSession'),
        cap: v[0] === 'stopSession'
          ? 'With Stop session, the × ends the agent as well.'
          : 'With Close view, the × takes the tab away and leaves the agent working.',
      }),
    },
    {
      rail: 'Edits',
      title: 'Proposed edits land in a review panel',
      where: 'Settings → Backends → the gear on the backend',
      body: `<p>Switchboard can register itself as the CLI's editor, so a proposed change opens as a diff
        with accept and reject instead of as a question in the terminal.</p>
        <p>This is on by default. Switched off, the CLI falls back to asking in the terminal, the way it
        does when no editor is attached. The change applies to the next session you launch.</p>`,
      controls: [{
        kind: 'toggle',
        label: 'Review proposed edits inside Switchboard',
        desc: 'Off leaves the accept/reject prompt in the terminal. Applies at the next launch.',
        setting: { type: 'backendOption', option: 'mcpEmulation' },
      }],
      figureOf: (v) => ({
        svg: figEdits(v[0]),
        cap: v[0]
          ? 'On — the change opens as a review panel of its own, with accept and reject.'
          : 'Off — the same question, asked as text in the terminal.',
      }),
    },
    {
      rail: 'Documents',
      title: 'Plans and handoffs are files in your repo',
      where: 'Settings → Documents',
      body: `<p>A plan is written to <code>.plans/</code> and a handoff packet to <code>.handoffs/</code>
        inside the project itself — plain Markdown, readable by any CLI, and worth a line in
        <code>.gitignore</code> if you would rather not commit them.</p>
        <p>For plans there is one more step per project: <b>Point this project's CLIs at it</b> makes the
        agents write their plans into that directory. Without it a CLI keeps writing them into its own
        home instead. Handoffs need nothing — Switchboard writes those itself.</p>`,
      controls: [
        { kind: 'path', label: 'Plans directory', setting: { type: 'flat', key: 'planDir', fallback: '.plans' } },
        { kind: 'path', label: 'Handoffs directory', setting: { type: 'flat', key: 'handoffDir', fallback: '.handoffs' } },
      ],
      ctlNote: 'Point this project’s CLIs at it stays where it is — it is set per project, and the tour runs before there is a project to set it on.',
      figureOf: (v) => ({
        svg: figDirs(v[0], v[1]),
        cap: 'Where the next plan and the next handoff will be written, as you type the names.',
      }),
    },
    {
      rail: 'Palette',
      title: 'F1 opens the command palette',
      where: 'Settings → Hotkeys',
      body: `<p>One key to jump to a session or project, start a launcher, write a plan or write a handoff.
        It is <b>F1</b>, not Ctrl+K — Ctrl+K is kill-line in every shell, and a terminal has to keep it.</p>
        <p>Rebindable, like every shortcut in the app.</p>`,
      ctlNote: 'Rebinding stays in Settings → Hotkeys, where the key capture lives.',
    },
  ];

  // ── State ──────────────────────────────────────────────────────────────────────────────────────

  let overlay = null;          // the dialog, or null when closed
  let current = 0;
  let seen = new Set();
  let settings = {};           // the blob as it was when this pane was rendered
  let panes = [];              // PANES with pane 1's controls resolved
  let previousFocus = null;
  let escapeHandler = null;
  // The mode a CLI had when its toggle was switched off in this tour, so switching it on brings that mode
  // back (D14 of #761, the Backends list's `rememberedModes`). Not stored: a reopened tour starts empty.
  let rememberedModes = {};

  const isOpen = () => !!overlay;

  // ── Reading and writing a control's value ──────────────────────────────────────────────────────

  function backendsList() {
    const byId = window._backendsById || {};
    return Object.values(byId).filter((b) => b && !b.isProfile);
  }

  // Which backend DECLARES this integration field / config option? Asked of the registry so this file
  // names no backend id (reflex 5). Returns null when nothing installed declares it, and the pane that
  // needed it is then skipped.
  function backendDeclaringIntegration(fieldId) {
    return backendsList().find((b) =>
      b.integrations && Array.isArray(b.integrations.fields)
      && b.integrations.fields.some((f) => f && f.id === fieldId)) || null;
  }

  function backendDeclaringOption(optionId) {
    return backendsList().find((b) =>
      Array.isArray(b.configFields) && b.configFields.some((f) => f && f.id === optionId)) || null;
  }

  // Is this backend switched on in this blob? The stored flag, else what the registry answered.
  function enabledIn(blob, b) {
    const stored = ((blob && blob.backendEnabled) || {})[b.id];
    return stored === undefined ? b.enabled !== false : stored !== false;
  }

  // Which installed, enabled backend answers this capability row with yes or limited? The row is the
  // descriptor's own declaration, projected through `backends-list` (`capabilities`), so a backend whose
  // hook is there only to decline answers no and does not count.
  function backendDeclaringCapability(capabilityId) {
    return backendsList().find((b) => {
      const answer = b.capabilities && b.capabilities[capabilityId];
      return b.status === 'ready' && b.available !== false && enabledIn(settings, b)
        && !!answer && (answer.state === 'yes' || answer.state === 'limited');
    }) || null;
  }

  // One CLI's `backendEnabled` values in this blob, one boolean per id of its group.
  function groupEnabledIn(blob, group) {
    const out = {};
    for (const b of [group.owner, ...group.drivers]) out[b.id] = enabledIn(blob, b);
    return out;
  }

  // What switching a CLI on enables when no mode is remembered: the owner alone, as the Backends list does.
  const ownerOnly = (group) => Object.fromEntries(group.ids.map((id) => [id, id === group.owner.id]));

  function readValue(setting) {
    if (!setting) return null;
    if (setting.type === 'flat') {
      const v = settings[setting.key];
      return v === undefined ? setting.fallback : v;
    }
    if (setting.type === 'backendEnabled') {
      const map = settings.backendEnabled || {};
      const stored = map[setting.backendId];
      return stored === undefined ? !!setting.fallback : stored !== false;
    }
    if (setting.type === 'backendMode') {
      return groupEnabledIn(settings, setting.group);
    }
    if (setting.type === 'integration') {
      return settings[setting.field] === true;
    }
    if (setting.type === 'backendOption') {
      const backend = backendDeclaringOption(setting.option);
      if (!backend) return null;
      const declared = (backend.configFields || []).find((f) => f.id === setting.option);
      const stored = ((settings.backendDefaults || {})[backend.id] || {})[setting.option];
      return stored === undefined ? !!(declared && declared.default) : stored !== false;
    }
    return null;
  }

  /**
   * Write one control's value.
   *
   * Four routes, because the code has four. A flat key is a `merge-setting`. Everything nested, and
   * everything that needs the backend re-arm, is a read-modify-write on `set-setting` — the same thing
   * settings-panel.js does, and the reason is in this file's header.
   */
  async function writeValue(setting, value) {
    if (setting.type === 'flat') {
      await window.api.mergeSetting('global', { [setting.key]: value });
      settings[setting.key] = value;
      return;
    }

    if (setting.type === 'integration') {
      // The flag alone stores an intent nothing acts on: the hook has to be written into the CLI's own
      // settings file, and that is a second call. It can decline (an unpackaged build cannot install a
      // hook that points at a packaged binary) — the pane says so rather than claiming success.
      await window.api.mergeSetting('global', { [setting.field]: value });
      settings[setting.field] = value;
      let result = null;
      try { result = await window.api.configureAttentionHook(value); } catch { /* reported below */ }
      return result;
    }

    // set-setting takes the WHOLE blob, so re-read it first: anything written between this dialog
    // opening and this click would otherwise be rolled back by our stale copy.
    const fresh = (await window.api.getSetting('global')) || {};

    if (setting.type === 'backendEnabled') {
      fresh.backendEnabled = Object.assign({}, fresh.backendEnabled, { [setting.backendId]: value });
    } else if (setting.type === 'backendMode') {
      // A CLI with more than one mode (#761): `true`/`false` from its toggle, a choice value from its select.
      // The values are the Backends list's: off writes every id false, on brings back the mode remembered
      // in this tour or the owner alone (D14), a choice writes `enabledForChoice`. The default target in the
      // group follows the mode (D6). With none stored (a first launch) it starts from the target the app
      // resolved — what the Backends list's select shows — and is written only when it moves; otherwise
      // `getDefaultLaunchTarget` would fall to the first enabled backend instead of this CLI's other mode.
      const group = setting.group;
      let next;
      if (value === true) {
        next = rememberedModes[group.owner.id] || ownerOnly(group);
      } else if (value === false) {
        rememberedModes[group.owner.id] = groupEnabledIn(fresh, group);
        next = Object.fromEntries(group.ids.map((id) => [id, false]));
      } else {
        next = backendModes.enabledForChoice(group, value);
      }
      fresh.backendEnabled = Object.assign({}, fresh.backendEnabled, next);
      const target = fresh.defaultLaunchTarget || window._defaultBackendId || '';
      const moved = target ? backendModes.targetAfterModeChange(target, group, next) : target;
      if (moved !== target) fresh.defaultLaunchTarget = moved;
    } else if (setting.type === 'backendOption') {
      const backend = backendDeclaringOption(setting.option);
      if (!backend) return null;
      const defaults = Object.assign({}, fresh.backendDefaults);
      defaults[backend.id] = Object.assign({}, defaults[backend.id], { [setting.option]: value });
      fresh.backendDefaults = defaults;
    }

    await window.api.setSetting('global', fresh);
    settings = fresh;
    return null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────────────────────────

  function controlWidget(control, id) {
    const value = readValue(control.setting);
    if (control.kind === 'toggle') {
      return `<label class="settings-toggle">
          <input type="checkbox" id="${id}" ${value ? 'checked' : ''}>
          <span class="settings-toggle-slider"></span>
        </label>`;
    }
    if (control.kind === 'mode') {
      // The Backends list's row controls (#761): the mode select, then the CLI's toggle. While the toggle is
      // off the select shows the mode switching on would bring back, and is disabled. A combination the
      // select cannot offer is shown as it is, never rewritten (D13).
      const group = control.setting.group;
      const on = group.ids.some((gid) => value[gid] === true);
      const shown = backendModes.choiceFor(group, value)
        || backendModes.choiceFor(group, rememberedModes[group.owner.id] || ownerOnly(group));
      const extra = shown && shown.readOnly
        ? `<option value="${esc(shown.value)}" disabled selected>${esc(shown.label)}</option>` : '';
      const opts = extra + backendModes.modeChoices(group).map((c) =>
        `<option value="${esc(c.value)}" ${shown && !shown.readOnly && shown.value === c.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
      return `<select class="settings-select" id="${id}" aria-label="Mode of ${esc(control.label)}" ${on ? '' : 'disabled'}>${opts}</select>
        <label class="settings-toggle">
          <input type="checkbox" id="${id}-on" aria-label="Enable ${esc(control.label)}" ${on ? 'checked' : ''}>
          <span class="settings-toggle-slider"></span>
        </label>`;
    }
    if (control.kind === 'select') {
      const opts = control.options.map((o) =>
        `<option value="${esc(o.value)}" ${String(value) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
      return `<select class="settings-select" id="${id}">${opts}</select>`;
    }
    if (control.kind === 'number') {
      return `<input class="settings-input settings-input-compact" type="number" min="0"${control.max ? ` max="${control.max}"` : ''} id="${id}" value="${esc(value)}">`
        + (control.unit ? `<span class="wt-unit">${esc(control.unit)}</span>` : '');
    }
    return `<input class="settings-input wt-input-path" type="text" id="${id}" value="${esc(value)}">`;
  }

  function renderControls(pane) {
    if (!pane.controls || !pane.controls.length) {
      return pane.ctlNote ? `<div class="wt-note">${pane.ctlNote}</div>` : '';
    }
    const rows = pane.controls.map((control, n) => `
      <div class="wt-row">
        <div class="wt-row-info">
          ${control.badge ? `<span class="wt-row-icon">${control.badge}</span>` : ''}
          <div>
            <label class="wt-row-label" for="wt-ctl-${n}">${esc(control.label)}</label>
            ${control.desc ? `<div class="wt-row-desc">${esc(control.desc)}</div>` : ''}
          </div>
        </div>
        <div class="wt-row-control">${controlWidget(control, 'wt-ctl-' + n)}</div>
      </div>`).join('');
    return `<div class="wt-rows">${rows}</div>`
      + (pane.ctlNote ? `<div class="wt-note">${pane.ctlNote}</div>` : '')
      + '<div class="wt-status" hidden></div>';
  }

  function currentValues(root) {
    return [...root.querySelectorAll('.wt-rows input, .wt-rows select')]
      .map((el) => (el.type === 'checkbox' ? el.checked : el.value));
  }

  function drawFigure(pane, root) {
    const holder = root.querySelector('.wt-figure-slot');
    if (!holder) return;
    const fig = pane.figureOf ? pane.figureOf(currentValues(root)) : pane.figure;
    if (!fig) { holder.innerHTML = ''; return; }
    const media = fig.img
      ? `<img src="${esc(fig.img)}" alt="${esc(fig.cap)}">`
      : fig.svg;
    holder.innerHTML = `<figure class="wt-figure">${media}<figcaption>${esc(fig.cap)}</figcaption></figure>`;
  }

  function renderPane(index) {
    current = index;
    seen.add(index);
    const pane = panes[index];
    const body = overlay.querySelector('.wt-body');
    body.innerHTML = `
      <h3 class="wt-title">${esc(pane.title)}</h3>
      ${pane.where ? `<div class="wt-where">${esc(pane.where)}</div>` : ''}
      <div class="wt-prose">${typeof pane.body === 'function' ? pane.body() : pane.body}</div>
      <div class="wt-controls">${renderControls(pane)}</div>
      ${pane.intro ? `<div class="wt-intro-actions">
          <button class="new-session-secondary-btn" type="button" data-wt-import>Import settings</button>
          <button class="new-session-secondary-btn" type="button" data-wt-settings>Open settings</button>
        </div>` : ''}
      <div class="wt-figure-slot"></div>`;

    wireControls(pane, body);
    drawFigure(pane, body);

    overlay.querySelectorAll('.wt-rail-item').forEach((el, n) => {
      el.setAttribute('aria-current', n === index ? 'true' : 'false');
      el.classList.toggle('seen', seen.has(n) && n !== index);
    });

    const count = overlay.querySelector('.wt-count');
    count.textContent = index === 0 ? '' : `${index} of ${panes.length - 1}`;
    overlay.querySelector('.wt-back').disabled = index === 0;
    const next = overlay.querySelector('.wt-next');
    next.textContent = index === panes.length - 1 ? 'Done' : (index === 0 ? 'Start' : 'Next');
  }

  function wireControls(pane, root) {
    (pane.controls || []).forEach((control, n) => {
      const el = root.querySelector('#wt-ctl-' + n);
      if (!el) return;
      const readEl = () => {
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'number') {
          // Blank means THE DEFAULT, never 0 — 0 means "no limit" for these keys, so clearing the field
          // to retype would otherwise commit an unlimited sidebar on the way past. Same answer
          // `parseLimit` gives in settings-panel.js, and the same caps the settings screen applies.
          const raw = Number(el.value);
          if (el.value.trim() === '' || !Number.isFinite(raw) || raw < 0) return control.setting.fallback;
          return control.max ? Math.min(raw, control.max) : raw;
        }
        return el.value;
      };
      const commit = async (value, focusId) => {
        let result = null;
        try {
          result = await writeValue(control.setting, value);
        } catch (err) {
          showStatus(root, 'That setting could not be saved: ' + (err && err.message ? err.message : 'unknown error'));
          return;
        }
        // The one honest failure a control here can have: the hook could not be installed. Nothing else
        // in the app says so today — the settings screen discards this answer — so the tour would be
        // claiming a switch took effect when it did not.
        if (result && result.devBlocked) {
          showStatus(root, 'Saved, but the hook was not installed: an unpackaged build cannot point a hook at itself. It will install from the packaged app.');
        } else if (result && result.error) {
          showStatus(root, 'Saved, but the hook could not be written: ' + result.error);
        } else {
          showStatus(root, '');
        }
        if (typeof reapplyGlobalSettings === 'function') {
          // The window that WRITES a setting is the one window the settings broadcast skips
          // (src/app/windows.js), so the tour applies its own change or four of these panes would
          // appear to do nothing until the next launch.
          try { await reapplyGlobalSettings(); } catch { /* a failed re-apply must not eat the write */ }
        }
        // …and the OTHER windows are told, because a detached window loads the same shell (#390) and
        // does listen. Free of a double apply: the broadcast excludes the sender, which is us.
        try { window.api.notifySettingsChanged?.(); } catch { /* best-effort */ }
        // A CLI switched on or off changes what the row shows (the select follows the toggle) and which
        // panes apply (keep warm needs an enabled backend that answers it), so the tour is rebuilt from
        // the blob just written.
        if (control.setting.type === 'backendMode' || control.setting.type === 'backendEnabled') rebuildPanes(focusId);
      };
      el.addEventListener('change', () => { drawFigure(pane, root); commit(readEl(), el.id); });
      const onEl = control.kind === 'mode' ? root.querySelector('#wt-ctl-' + n + '-on') : null;
      if (onEl) onEl.addEventListener('change', () => commit(onEl.checked, onEl.id));
      if (el.type === 'number' || el.type === 'text') {
        el.addEventListener('input', () => drawFigure(pane, root));
      }
    });
  }

  function showStatus(root, text) {
    const el = root.querySelector('.wt-status');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ── Open / close ───────────────────────────────────────────────────────────────────────────────

  function buildPanes() {
    const out = [];
    for (const pane of PANES) {
      if (pane.controls === 'backends') {
        // `ready` only: a backend that is declared but not built answers "not built yet" in the settings
        // screen and refuses to enable (src/backends/index.js), so a toggle for it here would be one
        // that can never take effect.
        const list = backendsList().filter((b) => b.status === 'ready');
        if (!list.length) continue;
        // One entry per CLI (#761), grouped by the module the Backends list asks: a CLI with more than one
        // mode gets the mode select beside its toggle, a CLI with one mode exactly the toggle it had.
        out.push(Object.assign({}, pane, {
          controls: backendModes.cliGroups(list).map((g) => {
            const b = g.owner;
            const multi = g.modes.length > 1;
            const missing = g.modes
              .map((m) => ({ m, d: m.id === b.id ? b : g.drivers.find((x) => x.id === m.id) }))
              .filter((x) => x.d && x.d.available === false);
            return {
              kind: multi ? 'mode' : 'toggle',
              label: b.label || b.id,
              desc: missing.map((x) => (multi ? `${x.m.label}: ` : '')
                + (x.d.unavailableReason || 'Not installed on this machine.')).join(' '),
              // The SAME badge the settings screen draws BESIDE A TOGGLE — `backends-panel.js`'s enable
              // list, which spells the key `colour || id` and deliberately NOT `icon`. The per-backend
              // page header uses `icon` first and therefore shows Claude's Anthropic mark; the enable
              // list shows a monogram for every backend, so the column reads as one set. This pane is
              // that list, so it takes that key. Two earlier spellings both looked right on their own and
              // put a different badge next to the same backend in the two places: passing `colour` as an
              // OPTION (it overrides the fill the key would have chosen), and reaching for `icon` first.
              badge: typeof window.backendBadgeHtml === 'function'
                ? window.backendBadgeHtml(b.colour || b.id, 20, { monogram: b.monogram })
                : '',
              setting: multi
                ? { type: 'backendMode', group: g }
                : { type: 'backendEnabled', backendId: b.id, fallback: b.enabled !== false },
            };
          }),
        }));
        continue;
      }
      // A pane whose control nothing installed declares is not a pane — it would explain a switch the
      // user does not have.
      if (pane.capability && !backendDeclaringCapability(pane.capability)) continue;
      const needsIntegration = (pane.controls || []).find((c) => c.setting && c.setting.type === 'integration');
      if (needsIntegration && !backendDeclaringIntegration(needsIntegration.setting.field)) continue;
      const needsOption = (pane.controls || []).find((c) => c.setting && c.setting.type === 'backendOption');
      if (needsOption && !backendDeclaringOption(needsOption.setting.option)) continue;
      out.push(pane);
    }
    return out;
  }

  function railHtml() {
    return `<div class="wt-rail-title">Getting started</div>
          ${panes.map((p, i) => `<button type="button" class="wt-rail-item" data-wt-go="${i}">
              <span class="wt-rail-num">${i === 0 ? '·' : i}</span><span>${esc(p.rail)}</span>
            </button>`).join('')}`;
  }

  // The panes again, from the blob as it is now: a CLI switched on or off can add or drop a pane whose
  // capability only an enabled backend answers. The pane on screen and the panes already seen are kept by
  // their rail label, because their indices can move.
  function rebuildPanes(focusId) {
    if (!overlay) return;
    const railOf = (i) => panes[i] && panes[i].rail;
    const onScreen = railOf(current);
    const seenRails = new Set([...seen].map(railOf));
    panes = buildPanes();
    if (!panes.length) { close(); return; }
    seen = new Set(panes.map((p, i) => (seenRails.has(p.rail) ? i : -1)).filter((i) => i >= 0));
    overlay.querySelector('.wt-rail').innerHTML = railHtml();
    const at = panes.findIndex((p) => p.rail === onScreen);
    renderPane(at >= 0 ? at : Math.min(current, panes.length - 1));
    if (focusId) overlay.querySelector('#' + focusId)?.focus();
  }

  async function open() {
    if (isOpen()) { overlay.querySelector('.wt-next')?.focus(); return; }
    settings = (await window.api.getSetting('global')) || {};
    panes = buildPanes();
    if (!panes.length) return;
    current = 0;
    seen = new Set([0]);
    rememberedModes = {};
    previousFocus = document.activeElement;

    overlay = document.createElement('div');
    overlay.className = 'new-session-overlay wt-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Welcome to Switchboard');
    overlay.innerHTML = `
      <div class="new-session-dialog wt-dialog">
        <nav class="wt-rail">${railHtml()}</nav>
        <section class="wt-pane">
          <button class="va-dialog-close wt-close" type="button" aria-label="Close the tour" title="Close the tour">&times;</button>
          <div class="wt-body"></div>
          <div class="wt-actions">
            <button class="new-session-cancel-btn wt-skip" type="button">Close the tour</button>
            <span class="wt-spacer"></span>
            <span class="wt-count"></span>
            <button class="new-session-secondary-btn wt-back" type="button">Back</button>
            <button class="new-session-start-btn wt-next" type="button">Start</button>
          </div>
        </section>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      // Four ways out, on purpose: the × in the corner, Close the tour, Escape, and a click on the backdrop (Done on the last pane is a fifth).
      // Nothing here holds work that a stray click could lose — every control writes as it is changed —
      // and the way back is one button in Settings → Maintenance. A tour that is hard to leave is a tour
      // people learn to resent.
      if (e.target === overlay) { dismiss(); return; }
      const go = e.target.closest('[data-wt-go]');
      if (go) { renderPane(Number(go.dataset.wtGo)); return; }
      if (e.target.closest('.wt-close') || e.target.closest('.wt-skip')) { dismiss(); return; }
      if (e.target.closest('.wt-back')) { renderPane(Math.max(0, current - 1)); return; }
      if (e.target.closest('.wt-next')) {
        if (current === panes.length - 1) dismiss();
        else renderPane(current + 1);
        return;
      }
      // These two REPLACE the tour, they do not dismiss it: the flag stays unwritten, so somebody who
      // opened the settings (or cancelled the import file dialog) meets the tour again next launch
      // instead of losing it to a click they did not mean as an answer.
      if (e.target.closest('[data-wt-import]')) { close(); window.api.importSettings?.(); return; }
      if (e.target.closest('[data-wt-settings]')) {
        // The settings window is seeded from the blob when it opens and never redraws, so its Save would
        // write a stale copy back over anything changed here. It replaces the tour rather than joining it.
        close();
        window.api.openSettingsWindow?.('global', null);
      }
    });

    // Escape has to work wherever the focus sits — a click on the dialog's padding or on a figure moves
    // `activeElement` off the overlay, and a listener bound to the overlay then never fires. So it is
    // bound to the DOCUMENT, in the capture phase, and stops there: the app's other Escape handlers are
    // document-level too (they close a viewer, or an admin tab), and an Escape that reaches a terminal is
    // an interrupt to whatever the CLI is doing.
    escapeHandler = (e) => {
      if (e.key !== 'Escape' || !isOpen()) return;
      e.stopPropagation();
      e.preventDefault();
      dismiss();
    };
    document.addEventListener('keydown', escapeHandler, true);


    renderPane(0);
    overlay.querySelector('.wt-next')?.focus();
  }

  function close() {
    if (!overlay) return;
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler, true);
      escapeHandler = null;
    }
    overlay.remove();
    overlay = null;
    try { previousFocus?.focus?.(); } catch { /* the element may be gone */ }
    previousFocus = null;
  }

  async function dismiss() {
    close();
    try { await window.api.mergeSetting('global', { [FLAG]: true }); } catch { /* nothing to do about it */ }
  }

  /**
   * First launch: no flag in the global settings means the tour has never been dismissed.
   *
   * Called after the boot's session restore has resolved — a dialog opened before that has its focus
   * taken by the terminal `showSession` focuses. Detached windows load the same shell (#390) and must
   * not each open their own copy.
   */
  async function maybeShowOnLaunch() {
    if (typeof window.isDetachedWindow === 'function' && window.isDetachedWindow()) return;
    if (isOpen()) return;
    let global = null;
    try { global = await window.api.getSetting('global'); } catch { return; }
    if (global && global[FLAG]) return;
    await open();
  }

  // An import landing while the tour is open rewrites every value under it, and the panes are rendered
  // from a snapshot taken in `open()`. Registered ONCE, at parse time, rather than per open:
  // `onSettingsChanged` is a plain `ipcRenderer.on` with no unsubscribe, so a per-open registration
  // would stack a listener for every time the tour was opened.
  window.api?.onSettingsChanged?.(async () => {
    if (!isOpen()) return;
    try { settings = (await window.api.getSetting('global')) || settings; } catch { return; }
    rebuildPanes(null);
  });

  window.welcomeTour = { open, close, maybeShowOnLaunch, isOpen };
})();
