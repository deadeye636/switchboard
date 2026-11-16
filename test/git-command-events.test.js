'use strict';
// #870 T2: git's command and output language, driven by the Claude change-event fixtures (the command string and the result
// text are what the extractors will hand over; nothing here reads a backend parser).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gitCommandsIn, commitFrom, pushFrom, MAX_COMMAND_CHARS, MAX_OUTPUT_CHARS } = require('../src/backends/git-command-events');

const DIR = path.join(__dirname, 'fixtures', 'change-events', 'claude');
function load(name) {
  const lines = fs.readFileSync(path.join(DIR, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const call = lines[0].message.content[0];
  const result = lines[1].message.content[0];
  return { tool: call.name, command: call.input.command, output: result.content, isError: result.is_error === true };
}
const dialectOf = (f) => (f.tool === 'PowerShell' ? 'powershell' : 'posix');

test('a plain commit is found and read from its bracket line', () => {
  const f = load('bash-git-commit.jsonl');
  assert.deepEqual(gitCommandsIn(f.command), [{ kind: 'commit', amend: false }]);
  assert.deepEqual(commitFrom(f.output), { sha: '9f3c2ab', subject: 'fix: handle empty input', branch: 'main' });
});

test('root commit, detached HEAD, branch with a slash, PowerShell CRLF', () => {
  assert.deepEqual(commitFrom(load('bash-git-commit-root.jsonl').output), { sha: '1a2b3c4', subject: 'chore: first commit', branch: 'main' });
  assert.deepEqual(commitFrom('[detached HEAD 5d6e7f8] wip\n 1 file changed'), { sha: '5d6e7f8', subject: 'wip', branch: 'detached HEAD' });
  const dir = load('bash-git-commit-dir.jsonl');
  assert.deepEqual(gitCommandsIn(dir.command), [{ kind: 'commit', amend: false }]); // git -C <dir> commit
  assert.equal(commitFrom(dir.output).branch, 'feature/x');
  const ps = load('powershell-git-commit.jsonl');
  assert.deepEqual(gitCommandsIn(ps.command, { dialect: dialectOf(ps) }), [{ kind: 'commit', amend: false }]);
  assert.deepEqual(commitFrom(ps.output), { sha: '5b6c7d8', subject: 'fix: handle empty input', branch: 'main' });
});

test('an amend is the command\'s flag, the sha is the new one', () => {
  const f = load('bash-git-commit-amend.jsonl');
  const [cmd] = gitCommandsIn(f.command);
  assert.equal(cmd.amend, true);
  assert.deepEqual(commitFrom(f.output, { amend: cmd.amend }), { sha: '4d5e6f7', subject: 'fix: handle empty input', branch: 'main', amend: true });
  assert.equal(commitFrom(f.output).amend, undefined);
});

test('chained add && commit finds one commit; pipelines are cut into stages', () => {
  assert.equal(gitCommandsIn(load('bash-git-commit.jsonl').command).length, 1);
  assert.deepEqual(gitCommandsIn('git add -A; git commit -m x | cat'), [{ kind: 'commit', amend: false }]);
  assert.deepEqual(gitCommandsIn('echo hi | git commit -F -'), [{ kind: 'commit', amend: false }]);
});

test('quoted text is data: echo "git commit" is not a commit', () => {
  const f = load('bash-echo-git-commit.jsonl');
  assert.deepEqual(gitCommandsIn(f.command), []);
  assert.equal(commitFrom(f.output), null); // the echoed text does not start with a bracket
  assert.deepEqual(gitCommandsIn('echo "git push" && printf \'git commit\''), []);
  assert.deepEqual(gitCommandsIn('git log --grep "git commit"'), []);
  assert.deepEqual(gitCommandsIn('git commit -m "git push now"'), [{ kind: 'commit', amend: false }]);
});

test('wrappers: a shell -c payload is looked into once', () => {
  assert.deepEqual(gitCommandsIn('bash -c "git add . && git commit -m x"'), [{ kind: 'commit', amend: false }]);
  assert.deepEqual(gitCommandsIn("pwsh -Command 'git push origin main'", { dialect: 'powershell' }), [{ kind: 'push', force: false }]);
});

test('hook failure, nothing to commit, tail-cut: no commit line, no commit', () => {
  for (const name of ['bash-git-commit-hook-failed.jsonl', 'bash-git-commit-nothing.jsonl', 'bash-git-commit-nothing-staged.jsonl']) {
    const f = load(name);
    assert.equal(gitCommandsIn(f.command).length, 1, name);
    assert.equal(commitFrom(f.output), null, name);
    assert.equal(f.isError, true, name);
  }
  const cut = load('bash-git-commit-tail-cut.jsonl');
  assert.deepEqual(gitCommandsIn(cut.command), [{ kind: 'commit', amend: false }]); // the `| tail -1` stage does not hide the git stage
  assert.equal(commitFrom(cut.output), null);
});

test('a commit is NOT decided by the error flag: commit ok, push refused', () => {
  const f = load('bash-commit-ok-push-refused.jsonl');
  assert.equal(f.isError, true);
  assert.deepEqual(gitCommandsIn(f.command), [{ kind: 'commit', amend: false }, { kind: 'push', force: false }]);
  assert.deepEqual(commitFrom(f.output), { sha: '8c9d0e1', subject: 'chore: x', branch: 'feat/x' });
  assert.deepEqual(pushFrom(f.output), { ok: false, summary: 'push failed' });
});

test('commit then push in one result yields both', () => {
  const f = load('bash-commit-then-push.jsonl');
  assert.deepEqual(gitCommandsIn(f.command).map((c) => c.kind), ['commit', 'push']);
  assert.equal(commitFrom(f.output).sha, '9f3c2ab');
  assert.deepEqual(pushFrom(f.output), { ok: true, summary: 'updated main', fromSha: '55c3c1f', toSha: '9f3c2ab' });
});

test('push outcomes: ok, new branch, up-to-date, force-with-lease, rejected', () => {
  assert.deepEqual(pushFrom(load('bash-git-push-ok.jsonl').output), { ok: true, summary: 'updated main', fromSha: '55c3c1f', toSha: '9f3c2ab' });
  assert.deepEqual(pushFrom(load('bash-git-push-new-branch.jsonl').output), { ok: true, summary: 'new branch feat/x' });
  assert.deepEqual(pushFrom(load('bash-git-push-uptodate.jsonl').output), { ok: true, summary: 'up-to-date', upToDate: true });
  const fwl = load('bash-git-push-force-with-lease.jsonl');
  assert.deepEqual(gitCommandsIn(fwl.command), [{ kind: 'push', force: true }]);
  assert.deepEqual(pushFrom(fwl.output), { ok: true, summary: 'forced update feat/x', fromSha: '78e3ef3', toSha: '9e3e85b' });
  const rej = load('bash-git-push-rejected.jsonl');
  assert.deepEqual(pushFrom(rej.output), { ok: false, summary: 'rejected main (fetch first)' });
  assert.deepEqual(gitCommandsIn('git push origin main'), [{ kind: 'push', force: false }]);
  assert.deepEqual(gitCommandsIn('git push origin +main'), [{ kind: 'push', force: true }]);
});

test('a push summary never carries the remote url', () => {
  for (const n of ['bash-git-push-ok.jsonl', 'bash-git-push-rejected.jsonl', 'bash-git-push-new-branch.jsonl']) {
    assert.doesNotMatch(pushFrom(load(n).output).summary, /example|http/);
  }
});

test('dry runs and other subcommands are not invocations', () => {
  assert.deepEqual(gitCommandsIn('git push --dry-run'), []);
  assert.deepEqual(gitCommandsIn('git push -n origin main'), []);
  assert.deepEqual(gitCommandsIn('git commit --dry-run'), []);
  assert.deepEqual(gitCommandsIn('git commit-tree abc'), []);
  assert.deepEqual(gitCommandsIn('git status && git diff'), []);
  assert.deepEqual(gitCommandsIn('git -c user.name=x -C "my dir" --no-pager commit -m x'), [{ kind: 'commit', amend: false }]);
  assert.deepEqual(gitCommandsIn('GIT_AUTHOR_NAME=x git commit -m y'), [{ kind: 'commit', amend: false }]);
  assert.deepEqual(gitCommandsIn('"C:\\Program Files\\Git\\bin\\git.exe" push', { dialect: 'powershell' }), [{ kind: 'push', force: false }]);
  assert.deepEqual(gitCommandsIn(''), []);
  assert.deepEqual(gitCommandsIn(null), []);
});

test('pushFrom: output without a push result is null', () => {
  assert.equal(pushFrom(''), null);
  assert.equal(pushFrom(undefined), null);
  assert.equal(pushFrom('Everything is fine\n'), null);
  assert.equal(pushFrom('[main 9f3c2ab] subject'), null);
  assert.deepEqual(pushFrom('fatal: The current branch x has no upstream branch.'), { ok: false, summary: 'push failed' });
});

test('input is bounded: a huge command and output stay fast and are cut', () => {
  const big = 'a '.repeat(MAX_COMMAND_CHARS) + '; git commit -m x';
  assert.deepEqual(gitCommandsIn(big), []); // the commit lies past the cut
  const start = Date.now();
  commitFrom(('x'.repeat(100) + '\n').repeat(100000));
  pushFrom(' '.repeat(MAX_OUTPUT_CHARS * 2));
  commitFrom('[' + 'a '.repeat(50000));
  gitCommandsIn("git commit -m '" + 'a'.repeat(100000));
  assert.ok(Date.now() - start < 1000);
  assert.equal(gitCommandsIn('git commit -m x; '.repeat(50)).length, 8);
});

test('a hook that prints 500 lines before the commit line does not hide the commit', () => {
  const noise = Array.from({ length: 500 }, (_, i) => `hook: checking file ${i}`).join('\n');
  assert.equal(commitFrom(`${noise}\n[main 9f3c2ab] fix: x\n 1 file changed`).sha, '9f3c2ab');
  assert.deepEqual(pushFrom(`${noise}\n   55c3c1f..9f3c2ab  main -> main`), { ok: true, summary: 'updated main', fromSha: '55c3c1f', toSha: '9f3c2ab' });
});

test('an output over the cap is read as its head half and its tail half', () => {
  const filler = 'x'.repeat(99) + '\n';
  const body = filler.repeat(Math.ceil((MAX_OUTPUT_CHARS * 3) / 100));
  assert.equal(commitFrom(`[main 1111111] head\n${body}`).sha, '1111111');           // in the head
  assert.equal(commitFrom(`${body}[main 2222222] tail\n 1 file changed`).sha, '2222222'); // in the tail
  assert.equal(commitFrom(`${body}[main 3333333] middle\n${body}`), null);             // in the dropped middle: an under-report
});

test('a localized commit line parses: any parenthesised label, a multi-word detached label', () => {
  assert.deepEqual(commitFrom('[main (commit racine) 1a2b3c4] premier'), { sha: '1a2b3c4', subject: 'premier', branch: 'main' });
  assert.deepEqual(commitFrom('[Wurzel-Commit (Hauptzweig) 1a2b3c4] x'), { sha: '1a2b3c4', subject: 'x', branch: 'Wurzel-Commit' });
  assert.deepEqual(commitFrom('[HEAD détachée 5d6e7f8] wip'), { sha: '5d6e7f8', subject: 'wip', branch: 'HEAD détachée' });
  assert.equal(commitFrom('[1] not a commit'), null);
  assert.equal(commitFrom('[main zzzzzzz] not a sha'), null);
  assert.equal(commitFrom('[main 9f3c2ab]'), null);
  assert.equal(commitFrom('[main 9f3c2ab] '), null);
});

test('a partial push says ok:false and moved:true, and names the refused ref first', () => {
  const out = '   111aaaa..222bbbb  fix -> fix\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'u\'';
  assert.deepEqual(pushFrom(out), { ok: false, summary: 'rejected main (fetch first) +1 more', moved: true, fromSha: '111aaaa', toSha: '222bbbb' });
  assert.equal(pushFrom(load('bash-git-push-rejected.jsonl').output).moved, undefined); // nothing moved
  assert.equal(pushFrom(load('bash-git-push-ok.jsonl').output).moved, undefined);
});

test('push SHAs: the first moved ref decides; forced "...", new branch, deleted, up-to-date and a bad range give none (#870)', () => {
  const sha = (o) => { const r = pushFrom(o); return [r.fromSha, r.toSha]; };
  assert.deepEqual(sha('   1234567..89abcde  main -> main'), ['1234567', '89abcde']);
  assert.deepEqual(sha(' + 1234567...89abcde feat/x -> feat/x (forced update)'), ['1234567', '89abcde']);
  // several refs: the first one that moved, the ones after it are ignored
  assert.deepEqual(sha(' * [new branch]      a -> a\n   1234567..89abcde  b -> b'), [undefined, undefined]);
  assert.deepEqual(sha('   1234567..89abcde  a -> a\n   fedcba9..7654321  b -> b'), ['1234567', '89abcde']);
  // up-to-date ref and a refused ref are not moved refs
  assert.deepEqual(sha(' = [up to date]      a -> a\n   1234567..89abcde  b -> b'), ['1234567', '89abcde']);
  assert.deepEqual(sha(' ! [rejected]        a -> a (fetch first)\n   1234567..89abcde  b -> b'), ['1234567', '89abcde']);
  assert.deepEqual(sha(' - [deleted]         feat/x'), [undefined, undefined]);
  assert.deepEqual(sha('Everything up-to-date'), [undefined, undefined]);
  // not hex, too short: no SHA
  assert.deepEqual(sha('   zzzzzzz..89abcde  main -> main'), [undefined, undefined]);
  assert.deepEqual(sha('   123456..89abcde  main -> main'), [undefined, undefined]);
});

test('a deleted ref has no arrow and still reads', () => {
  assert.deepEqual(pushFrom('To https://example.invalid/<owner>/<repo>.git\n - [deleted]         feat/x'), { ok: true, summary: 'deleted feat/x' });
});

test('porcelain output and a localized push are not read (an under-report, not a wrong claim)', () => {
  assert.equal(pushFrom('To remote\n*\trefs/heads/x:refs/heads/x\t[new branch]\nDone'), null);
  assert.equal(pushFrom('Tout est à jour'), null);
});

test('the POSIX escape rule: a Windows program path in double quotes keeps its backslashes', () => {
  assert.deepEqual(gitCommandsIn('"C:\\Program Files\\Git\\bin\\git.exe" commit -m x'), [{ kind: 'commit', amend: false }]);
  assert.deepEqual(gitCommandsIn('git commit -m "say \\"hi\\" \\$HOME"'), [{ kind: 'commit', amend: false }]);
});

test('leading shell words are skipped: ( { ! then do else xargs', () => {
  const one = [{ kind: 'commit', amend: false }];
  assert.deepEqual(gitCommandsIn('(git commit -m x)'), one);
  assert.deepEqual(gitCommandsIn('( git commit -m x )'), one);
  assert.deepEqual(gitCommandsIn('{ git commit -m x; }'), one);
  assert.deepEqual(gitCommandsIn('if true; then git commit -m x; fi'), one);
  assert.deepEqual(gitCommandsIn('for f in a; do git commit -m x; done'), one);
  assert.deepEqual(gitCommandsIn('echo a | xargs git commit -m x'), one);
  assert.deepEqual(gitCommandsIn('! git push'), [{ kind: 'push', force: false }]);
});
