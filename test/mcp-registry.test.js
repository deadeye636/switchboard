// The MCP Registry search in main (#790 T3, spec 38). A fake fetch throughout: no request leaves the machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  searchRegistry, requestUrl, registerIpc, init, ENDPOINT, FAILED, EMPTY_TERM, LONG_TERM, MAX_TERM, MAX_RESULTS,
} = require('../src/app/mcp-registry');

// A server row in the shape spec 38 "Registry facts" recorded.
const row = (server) => ({ server, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } });
const pypi = (identifier) => ({ registryType: 'pypi', identifier, transport: { type: 'stdio' } });
const SAMPLE = {
  servers: [row({
    name: 'io.github.example/demo-mcp',
    title: 'Demo',
    description: 'A demo server.',
    version: '1.0.0',
    repository: { url: 'https://github.com/example/demo-mcp', source: 'github' },
    packages: [pypi('demo-mcp')],
  })],
  metadata: { count: 1 },
};

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return typeof answer === 'function' ? answer(url, opts) : answer;
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an empty or over-long term is refused with a fixed sentence and no request', async () => {
  for (const term of ['', '   ', null, undefined, 42, {}, '\u0000\u0007']) {
    const f = fakeFetch(json(SAMPLE));
    assert.deepEqual(await searchRegistry(term, { fetch: f }), { ok: false, reason: EMPTY_TERM }, JSON.stringify(term));
    assert.equal(f.calls.length, 0);
  }
  const f = fakeFetch(json(SAMPLE));
  assert.deepEqual(await searchRegistry('x'.repeat(MAX_TERM + 1), { fetch: f }), { ok: false, reason: LONG_TERM });
  assert.equal(f.calls.length, 0);
});

test('the request is one GET to the fixed https endpoint, the term encoded as its only variable part', async () => {
  const f = fakeFetch(json(SAMPLE));
  await searchRegistry('a&b=c #d e?f', { fetch: f });
  assert.equal(f.calls.length, 1);
  const url = new URL(f.calls[0].url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin + url.pathname, ENDPOINT);
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'search', 'version']);
  assert.equal(url.searchParams.get('search'), 'a&b=c #d e?f');
  assert.equal(url.searchParams.get('version'), 'latest');
  assert.equal(url.searchParams.get('limit'), String(MAX_RESULTS));
  const opts = f.calls[0].opts;
  assert.equal(opts.method, 'GET');
  assert.equal(opts.redirect, 'error');
  assert.match(opts.headers['user-agent'], /switchboard/);
  assert.ok(opts.signal);
  assert.equal(requestUrl('a&b=c #d e?f'), f.calls[0].url);
});

test('a well-shaped reply becomes results with a source and built commands', async () => {
  const res = await searchRegistry('demo', { fetch: fakeFetch(json(SAMPLE)) });
  assert.deepEqual(res, {
    ok: true,
    results: [{
      name: 'io.github.example/demo-mcp',
      title: 'Demo',
      description: 'A demo server.',
      source: 'https://github.com/example/demo-mcp',
      packages: [{
        registry: 'pypi',
        identifier: 'demo-mcp',
        commands: [{ runtime: 'uv', install: 'uv tool install demo-mcp' }, { runtime: 'pipx', install: 'pipx install demo-mcp' }],
      }],
    }],
  });
});

test('a redirect, a thrown fetch, a timeout, a non-JSON body, an over-size body and a non-200 give the fixed sentence', async () => {
  const cases = {
    'redirect status': fakeFetch(new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/' } })),
    'redirect refused by fetch': fakeFetch(() => { throw new TypeError('fetch failed: redirect mode is set to error'); }),
    'network error': fakeFetch(() => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }),
    'non-200': fakeFetch(json({ error: 'nope' }, 500)),
    'not JSON': fakeFetch(new Response('<html>hi</html>', { status: 200 })),
    'wrong shape': fakeFetch(json({ servers: 'many' })),
    'no body': fakeFetch({ status: 200, body: null }),
  };
  for (const [label, f] of Object.entries(cases)) {
    assert.deepEqual(await searchRegistry('demo', { fetch: f }), { ok: false, reason: FAILED }, label);
  }

  const big = fakeFetch(new Response('x'.repeat(5000), { status: 200 }));
  assert.deepEqual(await searchRegistry('demo', { fetch: big, maxBytes: 1000 }), { ok: false, reason: FAILED });

  const hang = fakeFetch((_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  assert.deepEqual(await searchRegistry('demo', { fetch: hang, timeoutMs: 20 }), { ok: false, reason: FAILED });

  // The headers arrived and the body stalls: the same timeout ends the read (a real fetch errors its body on abort).
  const stalled = fakeFetch((_url, opts) => ({
    status: 200,
    body: new ReadableStream({
      start(controller) { opts.signal.addEventListener('abort', () => controller.error(new Error('aborted'))); },
    }),
  }));
  assert.deepEqual(await searchRegistry('demo', { fetch: stalled, timeoutMs: 20 }), { ok: false, reason: FAILED });
});

test('the raw error goes to the log at debug, and the term is never logged', async () => {
  const lines = [];
  const log = { debug: (m) => lines.push(['debug', m]), info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) };
  await searchRegistry('secret-term', { fetch: fakeFetch(json({}, 503)), log });
  assert.ok(lines.some(([lvl, m]) => lvl === 'debug' && /503/.test(m)));
  await searchRegistry('secret-term', { fetch: fakeFetch(json(SAMPLE)), log });
  assert.ok(lines.every(([, m]) => !m.includes('secret-term')), JSON.stringify(lines));
  // An error page that echoes the query: the parse failure is worded here, so the body never reaches the log.
  await searchRegistry('secret-term', { fetch: fakeFetch(new Response('<p>No results for secret-term</p>', { status: 200 })), log });
  assert.ok(lines.every(([, m]) => !m.includes('secret-term')), JSON.stringify(lines));
  assert.ok(lines.every(([lvl]) => lvl === 'debug'));
});

test('every invisible character class is removed, and a cut never splits a surrogate pair', async () => {
  const cp = (...points) => String.fromCodePoint(...points);
  // a tag-character run spelling "hi", a soft hyphen, the Arabic letter mark, word joiner, BOM
  const hidden = cp(0xE0001, 0xE0068, 0xE0069, 0xE007F) + cp(0xAD) + cp(0x61C) + cp(0x2060) + cp(0xFEFF);
  const res = await searchRegistry('demo', { fetch: fakeFetch(json({ servers: [row({ name: 'a' + hidden + 'b' })] })) });
  assert.equal(res.results[0].name, 'ab');
  // A line or paragraph separator reads as a break between words, so it becomes a space like a newline does.
  const lines = await searchRegistry('demo', { fetch: fakeFetch(json({ servers: [row({ name: 'a' + cp(0x2028) + 'b' + cp(0x2029) + 'c' })] })) });
  assert.equal(lines.results[0].name, 'a b c');

  const emoji = cp(0x1F600);
  const long = await searchRegistry('demo', { fetch: fakeFetch(json({ servers: [row({ name: emoji.repeat(300) })] })) });
  const name = long.results[0].name;
  assert.equal(Array.from(name).length, 200);
  assert.ok(Array.from(name).slice(0, -1).every(ch => ch === emoji), 'no lone surrogate before the ellipsis');
});

test('markup in a name stays text, capped, without control or bidi characters', async () => {
  const name = '<img src=x onerror=alert(1)>\u0000\u001b[31m\u202Eevil\u200B' + 'n'.repeat(500);
  const res = await searchRegistry('demo', { fetch: fakeFetch(json({ servers: [row({ name, description: 'line\r\nbreak' })] })) });
  assert.equal(res.ok, true);
  const got = res.results[0];
  assert.ok(got.name.startsWith('<img src=x onerror=alert(1)>[31mevil'));
  assert.ok(got.name.length <= 200);
  assert.doesNotMatch(got.name, /[\u0000-\u001F\u202E\u200B]/);
  assert.equal(got.description, 'line break');
});

test('a command is built only for a pypi package with a safe identifier', async () => {
  const packages = [
    pypi('safe-name'),
    pypi('bad name'),
    pypi('x;rm'),
    pypi('$(whoami)'),
    pypi('@scope'),
    pypi('pkg[extra]'),
    pypi('-flag'),
    { registryType: 'npm', identifier: 'left-pad', transport: { type: 'stdio' }, runtimeHint: 'npx' },
    { registryType: 'pypi', identifier: 'hinted', runtimeHint: 'uvx', runtimeArguments: [{ value: '; rm -rf ~' }] },
    { registryType: 'oci', identifier: 'docker.io/x/y:1' },
    { registryType: 'pypi' },
    'not an object',
  ];
  // Two servers: one server keeps at most eight packages.
  const servers = [row({ name: 'n', packages: packages.slice(0, 6) }), row({ name: 'm', packages: packages.slice(6) })];
  const res = await searchRegistry('demo', { fetch: fakeFetch(json({ servers })) });
  const pk = res.results.flatMap(r => r.packages);
  const byId = Object.fromEntries(pk.map(p => [p.identifier, p]));
  assert.deepEqual(byId['safe-name'].commands.map(c => c.install), ['uv tool install safe-name', 'pipx install safe-name']);
  assert.deepEqual(byId.hinted.commands.map(c => c.install), ['uv tool install hinted', 'pipx install hinted']);
  for (const id of ['bad name', 'x;rm', '$(whoami)', '@scope', 'pkg[extra]', '-flag', 'left-pad', 'docker.io/x/y:1']) {
    assert.ok(byId[id], `${id} is kept as text`);
    assert.equal(byId[id].commands, undefined, `${id} gets no command`);
  }
  assert.equal(pk.length, 10, 'the package without an identifier and the non-object are dropped');
  assert.ok(pk.every(p => Object.keys(p).every(k => ['registry', 'identifier', 'commands'].includes(k))));
});

test('a source that is not https, or carries credentials, is dropped', async () => {
  // Built through URL so the test source holds no `name@host` literal.
  const withCredentials = new URL('https://github.com/x/y');
  withCredentials.username = 'user';
  withCredentials.password = 'pw';
  const servers = [
    row({ name: 'a', repository: { url: 'http://github.com/x/y' } }),
    row({ name: 'b', repository: { url: 'javascript:alert(1)' } }),
    row({ name: 'c', repository: { url: withCredentials.href } }),
    row({ name: 'd', repository: { url: 'file:///etc/passwd' } }),
    row({ name: 'e', repository: 'https://github.com/x/y' }),
    row({ name: 'f', repository: { url: 'https://github.com/x/f' } }),
  ];
  const res = await searchRegistry('demo', { fetch: fakeFetch(json({ servers })) });
  assert.deepEqual(res.results.map(r => [r.name, r.source]), [
    ['a', undefined], ['b', undefined], ['c', undefined], ['d', undefined], ['e', undefined], ['f', 'https://github.com/x/f'],
  ]);
});

test('a server keeps at most eight packages', async () => {
  const packages = Array.from({ length: 12 }, (_, i) => pypi(`p${i}`));
  const res = await searchRegistry('demo', { fetch: fakeFetch(json({ servers: [row({ name: 'n', packages })] })) });
  assert.deepEqual(res.results[0].packages.map(p => p.identifier), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
});

test('rows without a name are dropped and the count is capped', async () => {
  const servers = [{ server: {} }, { nope: 1 }, null, ...Array.from({ length: MAX_RESULTS + 10 }, (_, i) => row({ name: `s${i}` }))];
  const res = await searchRegistry('demo', { fetch: fakeFetch(json({ servers })) });
  assert.ok(res.results.length <= MAX_RESULTS);
  assert.ok(res.results.every(r => /^s\d+$/.test(r.name)));
});

test('nothing in the reply carries a header, the URL or an unknown field from the request or the registry', async () => {
  const server = { ...SAMPLE.servers[0].server, extra: 'leak', _meta: { x: 1 }, remotes: [{ type: 'sse', url: 'https://r.invalid' }] };
  const res = await searchRegistry('demo', { fetch: fakeFetch(json({ servers: [row(server)] })) });
  const text = JSON.stringify(res);
  for (const needle of ['switchboard-mcp-registry', 'leak', 'registry.modelcontextprotocol.io', 'r.invalid', 'isLatest']) {
    assert.ok(!text.includes(needle), needle);
  }
  assert.deepEqual(Object.keys(res.results[0]).sort(), ['description', 'name', 'packages', 'source', 'title']);
});

test('the IPC is one handler named after the module, and it uses the fetch init gave it', async () => {
  const handlers = {};
  registerIpc({ handle: (name, fn) => { handlers[name] = fn; } });
  assert.deepEqual(Object.keys(handlers), ['mcp-registry-search']);
  const f = fakeFetch(json(SAMPLE));
  init({ fetch: f, log: null });
  const res = await handlers['mcp-registry-search']({}, 'demo');
  assert.equal(res.ok, true);
  assert.equal(f.calls.length, 1);
  init({});
});
