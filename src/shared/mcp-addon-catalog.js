// mcp-addon-catalog.js — the reviewed catalog of external MCP servers the global settings offer (#790, spec 38).
//
// A classic <script> in settings.html (its exports land on `window`) AND require()d by main (a seed id is checked
// against it) and the node tests, like external-mcp-form.js. Pure value work: no fs, no DOM, no settings read. It names
// servers, never a backend. Switchboard runs none of these commands (spec 38, D1): they are shown and copied.
//
// item: { id, name, summary, source, licence, runtimes: [{ runtime, install, uninstall }], stdio: { command, args } }
//   id         the card name a project gets (the validator's name rule)
//   source     the upstream project, `https` only
//   licence    as upstream states it, a non-open one included (D7)
//   install, uninstall  argument lists; every token is in SAFE_TOKEN, so the joined line reads the same in every
//              shell (D9). `install[0]` is the runtime's executable, which detection looks up on PATH.
//   stdio      what the project card gets; `command` is the executable the install puts on PATH
// When an entry is added or changed, the "Catalog verification" table in spec 38 gets its row and date.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // A leading `@` is refused: PowerShell reads `@name` as an argument as splatting (O10).
  const SAFE_TOKEN = /^(?!@)[A-Za-z0-9._\-@:+=/]+$/;
  const RUNTIMES = ['uv', 'pipx'];   // installed forms only; the zero-install `uvx` form is not catalogued (O7)

  // The terms the three upstream LICENSE files share, worded as they read them (D7).
  const DUAL_USE_TERMS = 'free for non-commercial use; commercial use, including any use within a for-profit company or organization, needs a paid license';

  function pyTool(pkg) {
    return [
      { runtime: 'uv', install: ['uv', 'tool', 'install', pkg], uninstall: ['uv', 'tool', 'uninstall', pkg] },
      { runtime: 'pipx', install: ['pipx', 'install', pkg], uninstall: ['pipx', 'uninstall', pkg] },
    ];
  }

  const MCP_ADDON_CATALOG = Object.freeze([
    {
      id: 'jcodemunch',
      name: 'jCodeMunch',
      summary: 'Indexes the symbols of a codebase so an agent can look code up by name instead of reading whole files.',
      source: 'https://github.com/jgravelle/jcodemunch-mcp',
      licence: 'jCodeMunch-MCP Dual-Use License: ' + DUAL_USE_TERMS,
      runtimes: pyTool('jcodemunch-mcp'),
      stdio: { command: 'jcodemunch-mcp', args: [] },
    },
    {
      id: 'jdocmunch',
      name: 'jDocMunch',
      summary: 'Indexes documentation by section so an agent can search and read one section instead of a whole file.',
      source: 'https://github.com/jgravelle/jdocmunch-mcp',
      licence: 'jDocMunch-MCP Dual-Use License: ' + DUAL_USE_TERMS,
      runtimes: pyTool('jdocmunch-mcp'),
      stdio: { command: 'jdocmunch-mcp', args: [] },
    },
    {
      id: 'jdatamunch',
      name: 'jDataMunch',
      summary: 'Indexes tabular data files so an agent can query columns and rows without loading the file.',
      source: 'https://github.com/jgravelle/jdatamunch-mcp',
      licence: 'jDataMunch-MCP Dual-Use License: ' + DUAL_USE_TERMS,
      runtimes: pyTool('jdatamunch-mcp'),
      stdio: { command: 'jdatamunch-mcp', args: [] },
    },
  ]);

  /** What is wrong with an argument list under D9, worded, or null when every token is safe. */
  function commandProblem(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return 'a command needs at least one token';
    const bad = argv.find(token => typeof token !== 'string' || !SAFE_TOKEN.test(token));
    return bad === undefined ? null : `unsafe command token: ${JSON.stringify(bad)}`;
  }

  /** An argument list -> the one line a user pastes. Throws on a token outside the safe set (D9). */
  function commandLine(argv) {
    const problem = commandProblem(argv);
    if (problem) throw new Error(problem);
    return argv.join(' ');
  }

  /** A catalog id -> its item, or null. Only a string that is an id finds anything. */
  function findCatalogItem(id, catalog) {
    if (typeof id !== 'string') return null;
    return (catalog || MCP_ADDON_CATALOG).find(item => item.id === id) || null;
  }

  /** A catalog item -> one raw `externalMcpServers` entry, as the project's Add form would write it. */
  function entryFromCatalog(item) {
    const entry = { name: item.id, transport: 'stdio', command: item.stdio.command };
    if (item.stdio.args.length) entry.args = item.stdio.args.slice();
    return entry;
  }

  /**
   * The executables detection asks PATH about (spec 38, Detection): every runtime's and every server's, once each, as
   * throwaway stdio entries for `checkExternalMcp`. A reply's `index` is the position in this list.
   */
  function probeEntries(catalog) {
    const commands = [];
    for (const item of catalog || MCP_ADDON_CATALOG) {
      for (const r of item.runtimes) if (!commands.includes(r.install[0])) commands.push(r.install[0]);
      if (!commands.includes(item.stdio.command)) commands.push(item.stdio.command);
    }
    return commands.map((command, i) => ({ name: `probe-${i + 1}`, transport: 'stdio', command }));
  }

  // The reason a probe carries when the reply says nothing usable about it. Not one of main's codes, so the renderer's
  // `reasonSentence` gives its neutral sentence.
  const NO_ANSWER = 'no-answer';
  const PROBE_STATES = ['found', 'missing', 'unknown'];

  /**
   * The check's `results` for `probeEntries()` -> { <command>: { state: 'found' | 'missing' | 'unknown', reason? } }.
   * Every probe gets an answer: a rejected, absent or unexpected result is `unknown` with NO_ANSWER, never `missing`
   * (spec 36 slice D: missing only with evidence). Only the command fact is read.
   */
  function readProbe(results, probes) {
    const list = probes || probeEntries();
    const byIndex = new Map();
    for (const r of Array.isArray(results) ? results : []) {
      if (r && typeof r === 'object' && Number.isInteger(r.index) && !byIndex.has(r.index)) byIndex.set(r.index, r);
    }
    const out = {};
    list.forEach((probe, i) => {
      const r = byIndex.get(i);
      const fact = r && !r.rejected && r.name === probe.name && r.command && typeof r.command === 'object' ? r.command : null;
      if (!fact || !PROBE_STATES.includes(fact.state)) { out[probe.command] = { state: 'unknown', reason: NO_ANSWER }; return; }
      const answer = { state: fact.state };
      if (fact.state === 'unknown') answer.reason = typeof fact.reason === 'string' ? fact.reason : NO_ANSWER;
      out[probe.command] = answer;
    });
    return out;
  }

  /** Every rule a catalog has to keep -> [message]. Empty means it holds. The test runs this over the real catalog. */
  function catalogProblems(catalog) {
    const problems = [];
    const seen = new Set();
    const tokensOk = (argv, what) => {
      const problem = commandProblem(argv);
      if (problem) problems.push(`${what}: ${problem}`);
      return !problem;
    };
    for (const [i, item] of (Array.isArray(catalog) ? catalog : []).entries()) {
      const at = `entry ${i} (${item && item.id})`;
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.id)) { problems.push(`${at}: bad id`); continue; }
      if (seen.has(item.id)) problems.push(`${at}: duplicate id`);
      seen.add(item.id);
      for (const key of ['name', 'summary', 'licence']) {
        if (typeof item[key] !== 'string' || item[key].trim() === '') problems.push(`${at}: ${key} is missing`);
      }
      if (typeof item.source !== 'string' || !/^https:\/\/[^\s]+$/.test(item.source)) problems.push(`${at}: source is not https`);
      if (!item.stdio || !Array.isArray(item.stdio.args)) { problems.push(`${at}: stdio is missing`); continue; }
      if (tokensOk([item.stdio.command], `${at} stdio.command`) && /[/\\]/.test(item.stdio.command)) {
        problems.push(`${at}: stdio.command is a path, not a name on PATH`);
      }
      if (item.stdio.args.length) tokensOk(item.stdio.args, `${at} stdio.args`);
      if (!Array.isArray(item.runtimes) || item.runtimes.length === 0) { problems.push(`${at}: no runtime`); continue; }
      for (const r of item.runtimes) {
        if (!RUNTIMES.includes(r && r.runtime)) { problems.push(`${at}: runtime ${r && r.runtime} is not one of ${RUNTIMES.join(', ')}`); continue; }
        for (const kind of ['install', 'uninstall']) {
          if (tokensOk(r[kind], `${at} ${r.runtime} ${kind}`) && r[kind][0] !== r.runtime) {
            problems.push(`${at}: ${r.runtime} ${kind} does not start with ${r.runtime}`);
          }
        }
      }
    }
    return problems;
  }

  return { MCP_ADDON_CATALOG, commandLine, findCatalogItem, entryFromCatalog, probeEntries, readProbe, catalogProblems };
});
