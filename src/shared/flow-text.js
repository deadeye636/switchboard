// --- The words of the session flow (spec 46, #826) ---
//
// The pure text helpers the Flow tab (`session/flow-view.js`) and the SVG export (`src/app/flow-svg.js`) both draw
// with: the checkpoint figure, the limitations behind the banner, the lane tag and a row's text. The flag helpers
// (`flagWord`, `flagLines`, `flagChips`: glyph, axis word, code in words, evidence; T24) are used by the Flow tab only, the
// SVG export still draws a flag count. They read only the
// neutral shape (`src/shared/flow-snapshot.js`, `flow-layout.js`) and name no backend (CLAUDE.md reflex 5). One copy
// here, so the screen and the export cannot word the same step two ways.
//
// LOADING. `require()`d in main and in node tests, a classic `<script>` in the renderer (`index.html`, before
// `session/flow-view.js`; `test/fixtures/script-order.json`). The whole body is wrapped, so it adds ONE global
// (`FlowText`) and no helper name.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowText = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Neutral vocabulary: what a capability id is called in the banner.
  const CAP_LABELS = {
    agents: 'Agents',
    instructionFiles: 'Instruction files',
    contextCheckpoints: 'Context checkpoints',
    permissionMode: 'Permission mode',
    approvals: 'Approvals',
    compaction: 'Compaction',
    interrupt: 'Interrupts',
    destructivePatterns: 'Risky-command patterns',
    timestamps: 'Timestamps',
  };

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  // A flag's axis in a glyph AND a word (spec 46: colour is never the only signal). Axes outside the four keep a neutral mark.
  const AXES = Object.freeze({
    risk: { glyph: '▲', word: 'risk', order: 0 },
    outcome: { glyph: '■', word: 'outcome', order: 1 },
    attention: { glyph: '●', word: 'attention', order: 2 },
    lifecycle: { glyph: '◆', word: 'lifecycle', order: 3 },
  });
  const OTHER_AXIS = Object.freeze({ glyph: '•', word: 'flag', order: 4 });
  const axisOf = (f) => (f && Object.prototype.hasOwnProperty.call(AXES, f.axis) ? AXES[f.axis] : OTHER_AXIS);

  /** A flag's code in words: `destructive:git-force-push` reads `destructive: git force push`. The code is data from a reader. */
  function flagWord(f) {
    const code = f && typeof f.code === 'string' ? f.code : '';
    return code.replace(/-/g, ' ').replace(/:\s*/g, ': ').trim() || 'flag';
  }

  /**
   * One line per flag, for the detail panel (and the input `flagChips` builds a card's marks from): glyph, axis word, the code in words, the evidence, the
   * reader's sentence and a count (a lane summary's flags carry one). Risk first, then outcome, attention, lifecycle;
   * otherwise in the order given.
   */
  function flagLines(flags) {
    const list = Array.isArray(flags) ? flags.map((f, i) => ({ f, i })) : [];
    list.sort((a, b) => (axisOf(a.f).order - axisOf(b.f).order) || (a.i - b.i));
    return list.map(({ f }) => {
      const ax = axisOf(f);
      const count = Number.isFinite(f.count) && f.count > 1 ? f.count : 1;
      return {
        axis: ax.word, glyph: ax.glyph, word: flagWord(f), evidence: f.evidence === 'heuristic' ? 'heuristic' : 'structured',
        why: typeof f.why === 'string' ? f.why : '', count,
      };
    });
  }

  /**
   * The marks a card shows: at most `max` (default 2) chips, each a glyph and a word, and how many more there are. A chip
   * from a heuristic says so in its text (`~`) and its title; the title holds the sentence.
   */
  function flagChips(flags, max) {
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2;
    const lines = flagLines(flags);
    const chips = lines.slice(0, limit).map((l) => ({
      axis: l.axis,
      heuristic: l.evidence === 'heuristic',
      text: l.glyph + ' ' + (l.evidence === 'heuristic' ? '~' : '') + l.word + (l.count > 1 ? ' ×' + l.count : ''),
      title: l.axis + ', ' + l.evidence + (l.why ? ': ' + l.why : ''),
    }));
    return { chips, more: Math.max(0, lines.length - chips.length) };
  }

  /** The limitations to show, each with the capabilities that point at it. Everything, never an empty banner by accident. */
  function bannerItems(snapshot) {
    const out = [];
    if (!snapshot) return out;
    const caps = snapshot.capabilities || {};
    const labelsBy = new Map();
    for (const id of Object.keys(caps)) {
      const c = caps[id];
      if (!c) continue;
      const full = id === 'instructionFiles' ? c.state === 'perFile' : c.state === 'yes';
      if (full || !c.limitationId) continue;
      if (!labelsBy.has(c.limitationId)) labelsBy.set(c.limitationId, []);
      labelsBy.get(c.limitationId).push(CAP_LABELS[id] || id);
    }
    for (const l of snapshot.limitations || []) {
      if (!l || !l.text) continue;
      out.push({ id: l.id, text: l.text, caps: labelsBy.get(l.id) || [] });
    }
    return out;
  }

  function fmtTokens(n) {
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1e6).toFixed(1) + 'M';
  }

  /**
   * How a step's checkpoint is drawn: `{ pct, text, estimated }` or null. Fill is the input against the window;
   * a value that is `unknown` or `included` says so in words; an estimated one is flagged (dashed + the word).
   */
  function checkpointInfo(step) {
    const cp = step && step.checkpoint;
    if (!cp) return tokensInfo(step);
    const inp = cp.input;
    const win = cp.window;
    const val = (e) => (e && e.basis !== 'unknown' && Number.isFinite(e.value) ? e.value : null);
    const i = val(inp);
    const w = val(win);
    const estimated = [inp, win].some((e) => e && e.basis === 'estimated');
    if (i == null) return { pct: null, text: inp && inp.basis === 'included' ? 'included' : 'input unknown', estimated: false };
    const pct = w ? clamp((i / w) * 100, 0, 100) : null;
    let text = fmtTokens(i) + (w ? ' / ' + fmtTokens(w) : '') + (pct != null ? ' · ' + Math.round(pct) + '%' : '');
    if (estimated) text += ' estimated';
    return { pct, text, estimated };
  }

  /** A step with its own token figure and no checkpoint (an instruction file): characters and tokens, estimates worded. */
  function tokensInfo(step) {
    const t = step && step.tokens;
    if (!t || t.basis === 'unknown' || !Number.isFinite(t.value)) return null;
    const chars = step.detail && Number.isFinite(step.detail.characters) ? step.detail.characters : null;
    const estimated = t.basis === 'estimated';
    let text = (chars != null ? fmtTokens(chars) + ' chars · ' : '') + (estimated ? '~' : '') + fmtTokens(t.value) + ' tokens';
    if (estimated) text += ' · estimated';
    else if (t.basis === 'included') text += ' · included';
    return { pct: null, text, estimated };
  }

  /** The collapsed banner line: the count, plus the context-window limitation when it is short. */
  function bannerSummary(items) {
    const n = items.length;
    let line = n + (n === 1 ? ' limitation' : ' limitations');
    const key = items.find((it) => it.caps.includes(CAP_LABELS.contextCheckpoints));
    if (key && key.text.length <= 90) line += ': ' + key.text;
    return line;
  }

  function rowText(row, columns) {
    if (row.kind === 'step') return row.step.label;
    if (row.kind === 'group') return row.quiet ? row.count + ' steps without a highlight' : row.count + ' × ' + (row.tool || 'tool');
    const col = (columns || []).find((c) => c.laneId === row.laneId);
    return row.count + ' steps' + (col && col.label ? ' in ' + col.label : '');
  }

  /**
   * The lane tag in words: `{ text, title }`. The depth shows when it is more than 1 and the title names the lane
   * that started this one, so nesting and siblings read apart without colour or column position.
   */
  function laneTagInfo(columns, laneId) {
    const list = columns || [];
    const col = list.find((c) => c.laneId === laneId);
    if (!col) return { text: '▾ agent', title: 'Collapse this lane' };
    const parent = col.parentLaneId != null ? list.find((c) => c.laneId === col.parentLaneId) : null;
    const parentLabel = parent ? (parent.label || parent.laneId) : 'main';
    // The depth leads, so the tag's ellipsis cuts the label rather than the depth.
    const depth = col.depth > 1 ? 'depth ' + col.depth + ' · ' : '';
    return { text: '▾ ' + depth + (col.label || 'agent'), title: 'Started by ' + parentLabel + '. Click to collapse this lane.' };
  }

  function rowBadge(row) {
    if (row.kind === 'step') return row.step.kind;
    if (row.kind === 'group') return row.quiet ? 'steps' : 'tool';
    return 'agent';
  }

  return Object.freeze({ CAP_LABELS, bannerItems, bannerSummary, checkpointInfo, rowText, laneTagInfo, rowBadge, flagWord, flagLines, flagChips });
});
