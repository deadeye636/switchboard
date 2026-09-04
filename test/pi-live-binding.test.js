'use strict';
// The Pi extension Switchboard writes for one spawn — the only thing that reports what a Pi session is
// doing, and the only file here that is never executed by the suite.
//
// It is generated TypeScript that Pi loads in its own process, so a wrong event name, a missing argument
// or a typo inside the template is silent everywhere: the extension loads, the handler never fires, and
// the session simply reports nothing. Nothing else in the tree reads this file, so these assertions are
// the whole safety net.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const liveBinding = require('../src/backends/pi/live-binding');

function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bind-'));
  const written = liveBinding.writeBindingExtension({
    dir,
    tag: 'terminal-tag-1',
    sessionUrl: 'http://127.0.0.1:1/switchboard-session-bind?t=token&tag=terminal-tag-1',
  });
  return { dir, written, source: fs.readFileSync(written.cleanup, 'utf8') };
}

test('the generated extension reports every lifecycle edge it claims to', () => {
  const { source } = generate();
  for (const event of ['session_start', 'turn_start', 'turn_end', 'agent_settled', 'session_info_changed']) {
    assert.ok(source.includes(`pi.on("${event}"`), `${event} is subscribed`);
  }
});

test('a blocking UI prompt is reported as waiting, and its end as busy (#529)', () => {
  // `ui_prompt_end` is busy rather than idle on purpose: answering a prompt returns the agent to the turn
  // it was in the middle of. The turn's own `turn_end` / `agent_settled` still ends it.
  const { source } = generate();
  assert.match(source, /pi\.on\("ui_prompt_start", async \(event: any, ctx\) => \{ await post\(ctx, "waiting", event\?\.kind\); \}\);/);
  assert.match(source, /pi\.on\("ui_prompt_end", async \(_event, ctx\) => \{ await post\(ctx, "busy"\); \}\);/);
});

test('the prompt KIND is sent and its title is not (#529)', () => {
  // The title is arbitrary text from whatever the agent is running and it would be rendered in the
  // attention inbox. The kind is a closed set and says enough to word the reason.
  const { source } = generate();
  assert.match(source, /body: JSON\.stringify\(\{ session_id: id, kind, prompt_kind: promptKind \}\)/);
  assert.equal(/title/i.test(source), false, 'no prompt title reaches the payload');
});

test('the extension posts to the per-spawn URL and nothing else', () => {
  // The URL carries the token that is the only thing between this and any local process forging signals.
  const { source } = generate();
  const urls = source.match(/https?:\/\/[^"']+/g) || [];
  assert.deepEqual(urls, ['http://127.0.0.1:1/switchboard-session-bind?t=token&tag=terminal-tag-1']);
});

test('writeBindingExtension declines without the three things it needs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bind-none-'));
  assert.equal(liveBinding.writeBindingExtension({ dir, tag: 't' }), null);
  assert.equal(liveBinding.writeBindingExtension({ dir, sessionUrl: 'http://x' }), null);
  assert.equal(liveBinding.writeBindingExtension({ tag: 't', sessionUrl: 'http://x' }), null);
  assert.deepEqual(fs.readdirSync(dir), [], 'and writes nothing on the way out');
});

test('the extension is handed to Pi as an --extension argument and can be removed again', () => {
  const { written } = generate();
  assert.deepEqual(written.args, ['--extension', written.cleanup]);
  assert.ok(fs.existsSync(written.cleanup));
  liveBinding.removeBindingExtension(written.cleanup);
  assert.equal(fs.existsSync(written.cleanup), false);
  // A second removal is the ordinary case after a crash, not an error.
  liveBinding.removeBindingExtension(written.cleanup);
});
