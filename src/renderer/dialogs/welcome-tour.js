// welcome-tour.js — the first-launch tour (#146).
//
// Nine panes over one dialog: a welcome pane and eight things a fresh installation does not explain by
// itself. Shown once, on the first launch of a profile that has no `welcomeDismissed` in its global
// settings, and reachable afterwards from Settings → About.
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
//
//   IT NAMES NO BACKEND. Pane 2's toggle is resolved by asking the registry which backend DECLARES an
//   integration field with that id, and pane 6's by asking which one declares that config option. Both
//   panes disappear when no installed backend declares theirs. The ids named here (`attentionHooks`,
//   `mcpEmulation`) are capability ids, not backend ids — reflex 5.
//
// The figures are drawn here rather than shipped as images, because five of them answer to the pane's
// own controls: pick Grid and the picture shows Grid, type a directory name and the tree shows it. A
// picture that has to follow a number cannot be a PNG. The plan called for pane 2's to be a real
// screenshot, since it is about WHERE a control is rather than what it does; it is drawn too, and
// `FIG_GEAR` carries the argument. **There is no image file and no `assets/` directory.**
//
// Depends on renderer globals: window.api · window.isDetachedWindow (shell/detach-window.js) ·
// window._backendsById (backends/backend-registry.js) · window.backendBadgeHtml (backends/backend-icons.js) ·
// reapplyGlobalSettings (app.js).

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

  function figDirs(planDir, handoffDir) {
    const today = new Date().toISOString().slice(0, 10);
    const p = esc(planDir || '?');
    const h = esc(handoffDir || '?');
    const line = (y, text, colour) =>
      `<text x="194" y="${y}" font-family="ui-monospace, Consolas, monospace" font-size="12" fill="${colour}">${text}</text>`;
    return `<svg viewBox="0 0 640 200" role="img" aria-label="Where a plan and a handoff are written inside the project">
        <rect x="150" y="20" width="340" height="160" rx="8" fill="#1a1a24" stroke="rgba(255,255,255,0.08)"/>
        ${line(52, 'my-project/', '#e0e0f0')}
        ${line(78, '├─ ' + p + '/', '#8088ff')}
        ${line(100, '│&#160;&#160;└─ ' + today + '-plan.md', '#7a7a90')}
        ${line(126, '└─ ' + h + '/', '#8088ff')}
        ${line(148, '&#160;&#160;&#160;└─ ' + today + '-handoff.md', '#7a7a90')}
        <text x="320" y="176" font-family="sans-serif" font-size="10" fill="#5a5a70" text-anchor="middle">both inside the project, both plain Markdown</text>
      </svg>`;
  }

  // ── The panes ──────────────────────────────────────────────────────────────────────────────────
  //
  // `setting` says how a control is written, and there are four shapes because there are four shapes in
  // the code (see the header). `backendOption` and `integration` name a CAPABILITY id and are resolved
  // through the registry, so no backend is named here.

  const PANES = [
    {
      rail: 'Welcome',
      intro: true,
      title: 'Welcome to Switchboard',
      body: `<p>Switchboard finds the coding-CLI sessions already on this machine, groups them by project,
        and keeps them running side by side. Nothing here starts a session on its own.</p>
        <p>Eight short panes cover what a fresh installation does not explain by itself. Every one of them
        lets you change the setting it talks about, right here. Settings → About brings the tour back at
        any time.</p>`,
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
      <div class="wt-prose">${pane.body}</div>
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
      const commit = async () => {
        let result = null;
        try {
          result = await writeValue(control.setting, readEl());
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
      };
      el.addEventListener('change', () => { drawFigure(pane, root); commit(); });
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
        out.push(Object.assign({}, pane, {
          controls: list.map((b) => ({
            kind: 'toggle',
            label: b.label || b.id,
            desc: b.available === false ? (b.unavailableReason || 'Not installed on this machine.') : '',
            badge: typeof window.backendBadgeHtml === 'function'
              ? window.backendBadgeHtml(b.icon || b.id, 20, { monogram: b.monogram, colour: b.colour })
              : '',
            setting: { type: 'backendEnabled', backendId: b.id, fallback: b.enabled !== false },
          })),
        }));
        continue;
      }
      // A pane whose control nothing installed declares is not a pane — it would explain a switch the
      // user does not have.
      const needsIntegration = (pane.controls || []).find((c) => c.setting && c.setting.type === 'integration');
      if (needsIntegration && !backendDeclaringIntegration(needsIntegration.setting.field)) continue;
      const needsOption = (pane.controls || []).find((c) => c.setting && c.setting.type === 'backendOption');
      if (needsOption && !backendDeclaringOption(needsOption.setting.option)) continue;
      out.push(pane);
    }
    return out;
  }

  async function open() {
    if (isOpen()) { overlay.querySelector('.wt-next')?.focus(); return; }
    settings = (await window.api.getSetting('global')) || {};
    panes = buildPanes();
    if (!panes.length) return;
    current = 0;
    seen = new Set([0]);
    previousFocus = document.activeElement;

    overlay = document.createElement('div');
    overlay.className = 'new-session-overlay wt-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Welcome to Switchboard');
    overlay.innerHTML = `
      <div class="new-session-dialog wt-dialog">
        <nav class="wt-rail">
          <div class="wt-rail-title">Getting started</div>
          ${panes.map((p, i) => `<button type="button" class="wt-rail-item" data-wt-go="${i}">
              <span class="wt-rail-num">${i === 0 ? '·' : i}</span><span>${esc(p.rail)}</span>
            </button>`).join('')}
        </nav>
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
      // Four ways out, on purpose: the × in the corner, Skip, Escape, and a click on the backdrop.
      // Nothing here holds work that a stray click could lose — every control writes as it is changed —
      // and the way back is one button in Settings → About. A tour that is hard to leave is a tour
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
    renderPane(current);
  });

  window.welcomeTour = { open, close, maybeShowOnLaunch, isOpen };
})();
