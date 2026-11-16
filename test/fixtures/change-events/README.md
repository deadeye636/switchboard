# Change-event fixtures (#870, spec 47)

What each backend writes for a file edit, a shell command and a `git commit` / `git push` result. One shape per file,
named for it. Hand-built from shapes measured on local transcripts and stores (key and type names, output grammar);
every path, id, SHA, URL and subject is invented. The measurement and the per-backend decision are in
`docs/backend-formats.md`, "File edits, commits and pushes".

Consumed by the tests of the change-event extractors (`test/change-events.test.js`, `test/git-command-events.test.js`,
`test/<backend>-change-events.test.js`). Lines are in file order, so a test derives the byte offsets itself.

**Synthetic** below means the shape was not found in any local transcript: it follows the CLI's documented tool list or
git's own output. Everything else follows a measured shape.

## claude/ (JSONL, `type: "user"` / `"assistant"` lines)

| File | Shape |
|---|---|
| `edit-ok.jsonl` | `Edit` call + result without `is_error` |
| `edit-error.jsonl` | `Edit` result with `is_error: true`, `<tool_use_error>` text |
| `edit-permission-denied.jsonl` | `Edit` result denied by a permission rule, `is_error: true` (wording shortened) |
| `write-ok.jsonl` / `write-error.jsonl` | `Write` created a file / refused (not read first) |
| `multiedit-ok.jsonl`, `notebookedit-ok.jsonl` | **Synthetic.** `MultiEdit` (`file_path`, `edits[]`) and `NotebookEdit` (`notebook_path`); result texts invented |
| `bash-git-commit.jsonl` | `Bash` chained `git add && git commit`, output `[main 9f3c2ab] subject` |
| `bash-git-commit-root.jsonl` | `[main (root-commit) 1a2b3c4] subject` |
| `bash-git-commit-amend.jsonl` | `--amend`, bracket line then ` Date:` |
| `bash-git-commit-hook-failed.jsonl` | `is_error`, `Exit code 1`, hook text, no bracket line |
| `bash-git-commit-nothing.jsonl` / `bash-git-commit-nothing-staged.jsonl` | `nothing to commit` / `no changes added to commit`, both `is_error` |
| `bash-git-commit-tail-cut.jsonl` | `\| tail -1` removed the bracket line: no commit can be read |
| `bash-git-commit-dir.jsonl` | `git -C <dir> commit`, branch with a `/` |
| `bash-echo-git-commit.jsonl` | negative: `echo "git commit …"` and its echoed output are data, not a commit |
| `powershell-git-commit.jsonl` | the `PowerShell` tool, `\r\n` in the output |
| `bash-git-push-ok.jsonl`, `-new-branch`, `-uptodate`, `-force-with-lease` | `old..new  main -> main`; ` * [new branch]`; `Everything up-to-date`; ` + a...b … (forced update)` |
| `bash-git-push-rejected.jsonl` | **Synthetic.** ` ! [rejected]` + `error: failed to push some refs`, `is_error` |
| `bash-commit-then-push.jsonl` | one result holds the commit line and the push ref line |
| `bash-commit-ok-push-refused.jsonl` | `is_error` result that still holds the commit line (pre-push hook refusal after a good commit) |
| `api-request-blob.jsonl` | an `api-request-blob` line repeating the `tool_result`: must not count twice |
| `subagent-edit.jsonl` | the lines of a subagent file: `isSidechain: true`, `agentId` |

## codex/ (JSONL, `response_item` payloads)

| File | Shape |
|---|---|
| `apply-patch-add.jsonl`, `apply-patch-update-delete.jsonl`, `apply-patch-move.jsonl` | `exec` script calling `tools.apply_patch(patch)`; `*** Add File:`, `*** Update File:` + `*** Delete File:`, `*** Update File:` + `*** Move to:` (the move is **synthetic**); output `Script completed` + `{}` |
| `apply-patch-failed.jsonl` | A failed patch: the output starts `Script failed` (header shape measured on a local rollout; path and error text invented) |
| `exec-git-commit.jsonl`, `exec-git-push-ok.jsonl` | **Synthetic.** `tools.exec_command({ cmd, workdir })` + `text(r.output)`; no commit or push exists in the local rollouts |
| `exec-git-commit-failed.jsonl`, `exec-git-push-rejected.jsonl` | **Synthetic.** `Script completed` over a failed command: the header gives no exit code |
| `exec-two-commands.jsonl` | **Synthetic.** two `exec_command` calls in one script, two printed parts: no way to pair by id |
| `function-call-shell-commit.jsonl` | **Synthetic.** the older `function_call` `shell` (argv list) + string output with `Exit code: N` |

## pi/ (JSONL, `type: "message"`)

| File | Shape |
|---|---|
| `edit-ok.jsonl`, `edit-error.jsonl` | `edit` (`path`, `edits[]`) with `details.diff`; `isError: true` for a non-unique match |
| `write-ok.jsonl` | `write` (`path`, `content`) |
| `bash-git-commit.jsonl`, `-amend`, `-hook-failed`, `-nothing` | `bash` (`command`); a failure is `isError: true` + `Command exited with code 1` (the `-nothing` and `-hook-failed` wording is **synthetic**) |
| `bash-git-commit-ok-later-step-failed.jsonl` | `isError` result that still holds the commit line |
| `bash-git-push-ok.jsonl`, `-uptodate`, `-force-with-lease`, `-rejected` | as for Claude; `-uptodate`, `-force-with-lease` and `-rejected` are **synthetic** in Pi's wrapper (the git text is measured elsewhere, `-rejected` is documented only) |

## agy/ (JSON: the readable strings of one `steps` row, not protobuf)

`replace-file-ok.json`, `replace-file-failed.json` (`status` 7 + error text), `write-to-file-ok.json`,
`run-command-git-commit.json`, `run-command-git-push.json`, `run-command-exit1.json` (**synthetic** wording on a commit).
`idx` is the ordering key, `status` 3 is a completed step. The real row is a binary blob and is not committed.

## hermes/

`read-file-tool-rows.json`: the only tool-call shape the local store holds (an assistant row with `tool_calls`, a `tool`
row). No edit or shell call was ever seen, so there is nothing else to record; the decision is `no`.
