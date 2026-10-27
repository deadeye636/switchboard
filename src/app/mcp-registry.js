'use strict';
// The search in the official MCP Registry behind the global settings' "MCP servers" category (#790, spec 38).
//
// One fixed host over https, one GET, made only when the user presses Search (D4). The search term is the one
// variable part of the request and the only thing that leaves the machine. Everything that comes back is
// third-party data: it is validated field by field against the shape recorded in spec 38 ("Registry facts"), and
// whatever does not fit is dropped, never passed through. Strings are stripped of control characters and capped here;
// the renderer still sets them as text.
//
// A result gets install commands only when main builds them itself (D10): a `pypi` package whose identifier passes
// the PyPI name rule AND the catalog's token rule (`commandLine`, D9). No command text from the registry is ever
// forwarded. Nothing is run.
//
// Electron-free and db-free: `fetch` and `log` arrive through `init` or the options of `searchRegistry`, so
// `node --test` loads it with a fake fetch and no network.

const { commandLine } = require('../shared/mcp-addon-catalog');
const { readableError } = require('./readable-error');

const ENDPOINT = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const USER_AGENT = 'switchboard-mcp-registry';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 1024 * 1024;
const MAX_TERM = 100;
const MAX_RESULTS = 30;
const MAX_PACKAGES = 8;
// Text caps count code points (`cleanText`); `identifier` and `source` are checked by `.length`, since a valid one is
// ASCII and anything longer is dropped rather than cut.
const CAPS = { name: 200, title: 200, description: 600, identifier: 214, source: 500, registry: 32 };

const FAILED = 'The registry could not be searched.';
const EMPTY_TERM = 'Type a name to search for.';
const LONG_TERM = `A search may be at most ${MAX_TERM} characters long.`;

// The PyPI project-name rule (PEP 508 / packaging's canonical form before normalisation).
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// Control (C0, DEL, C1), format (zero-width, bidi, soft hyphen, the tag characters used to smuggle ASCII) and the line
// and paragraph separators: anything that is invisible or can make a name read as something else.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

let ctx = { fetch: null, log: null };

function init(deps = {}) {
  ctx = {
    fetch: typeof deps.fetch === 'function' ? deps.fetch : null,
    log: deps.log || null,
  };
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A registry string -> one line of text with no control characters, trimmed and capped; anything else -> ''. */
function cleanText(v, cap) {
  if (typeof v !== 'string') return '';
  const text = v.replace(/[\t\n\r\p{Zl}\p{Zp}]+/gu, ' ').replace(CONTROL, '').trim();
  const chars = Array.from(text);   // by code point, so a cut never splits a surrogate pair
  return chars.length > cap ? chars.slice(0, cap - 1).join('') + '…' : text;
}

/** An `https` URL as a string, or '' — never another scheme, never credentials in it. */
function httpsUrl(v) {
  if (typeof v !== 'string' || v.length > CAPS.source) return '';
  try {
    const url = new URL(v);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** The install commands main builds for one package, or none (D10). */
function commandsFor(registry, identifier) {
  if (registry !== 'pypi' || !PYPI_NAME.test(identifier)) return [];
  try {
    return [
      { runtime: 'uv', install: commandLine(['uv', 'tool', 'install', identifier]) },
      { runtime: 'pipx', install: commandLine(['pipx', 'install', identifier]) },
    ];
  } catch {
    return [];
  }
}

function packageOf(raw) {
  if (!isPlainObject(raw)) return null;
  const registry = cleanText(raw.registryType, CAPS.registry);
  const identifier = typeof raw.identifier === 'string' ? raw.identifier.replace(CONTROL, '').trim() : '';
  if (!registry || !identifier || identifier.length > CAPS.identifier) return null;
  const pkg = { registry, identifier };
  const commands = commandsFor(raw.registryType, identifier);
  if (commands.length) pkg.commands = commands;
  return pkg;
}

/** One `{ server, _meta }` row -> a result, or null when it lacks a name. */
function resultOf(row) {
  const server = isPlainObject(row) && isPlainObject(row.server) ? row.server : null;
  if (!server) return null;
  const name = cleanText(server.name, CAPS.name);
  if (!name) return null;
  const result = { name };
  const title = cleanText(server.title, CAPS.title);
  if (title) result.title = title;
  const description = cleanText(server.description, CAPS.description);
  if (description) result.description = description;
  const source = isPlainObject(server.repository) ? httpsUrl(server.repository.url) : '';
  if (source) result.source = source;
  const packages = (Array.isArray(server.packages) ? server.packages : []).slice(0, MAX_PACKAGES).map(packageOf).filter(Boolean);
  result.packages = packages;
  return result;
}

/** The request URL: the fixed endpoint, the term as the only variable part. */
function requestUrl(term) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('search', term);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(MAX_RESULTS));
  return url.href;
}

/** A response body as text, read as a stream and refused past `max` bytes. */
async function readCapped(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') throw new Error('response has no readable body');
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try { await reader.cancel(); } catch { /* the cap is the answer either way */ }
      throw new Error(`response over ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Search the registry. -> { ok: true, results } | { ok: false, reason }. Never throws.
 * @param {string} term
 * @param {{ fetch?: Function, log?: object, timeoutMs?: number, maxBytes?: number }} [opts]
 */
async function searchRegistry(term, opts = {}) {
  const log = opts.log || null;
  const text = typeof term === 'string' ? term.replace(CONTROL, '').trim() : '';
  if (!text) return { ok: false, reason: EMPTY_TERM };
  if (text.length > MAX_TERM) return { ok: false, reason: LONG_TERM };
  const doFetch = opts.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, reason: FAILED };

  const ctl = new AbortController();
  // Not unref'd: it is cleared in `finally`, and it is what ends a request that would otherwise wait forever.
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const res = await doFetch(requestUrl(text), {
      method: 'GET',
      redirect: 'error',
      signal: ctl.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (!res || res.status !== 200 || res.redirected) throw new Error(`registry answered ${res && res.status}`);
    const raw = await readCapped(res, opts.maxBytes || MAX_BYTES);
    let body;
    // A fixed message: a parse error quotes the body, and an error page may echo the term.
    try { body = JSON.parse(raw); } catch { throw new Error('registry reply is not JSON'); }
    if (!isPlainObject(body) || !Array.isArray(body.servers)) throw new Error('registry reply is not { servers: [] }');
    const results = body.servers.slice(0, MAX_RESULTS).map(resultOf).filter(Boolean);
    if (log && log.debug) log.debug(`[mcp-registry] search answered ${results.length} result(s)`);
    return { ok: true, results };
  } catch (err) {
    // The raw error goes to the log at debug; the reply is a fixed sentence. The term is never logged.
    return { ok: false, reason: readableError(err, FAILED, log || undefined) };
  } finally {
    clearTimeout(timer);
  }
}

function registerIpc(ipc) {
  ipc.handle('mcp-registry-search', (_event, term) => searchRegistry(term, { fetch: ctx.fetch || undefined, log: ctx.log }));
}

module.exports = { init, registerIpc, searchRegistry, requestUrl, ENDPOINT, FAILED, EMPTY_TERM, LONG_TERM, MAX_TERM, MAX_RESULTS };
