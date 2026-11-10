# 42 — A project's GitHub and GitLab issues in Tasks & notes

Issues #816 and #830 (the filters). Status: **built**. The code is `src/app/forge-issues.js`; the views are
`src/renderer/views/tasks-view.js` and `src/renderer/session/session-sidebar.js`, with their shared pure half in
`src/renderer/views/tasks-logic.js`.

## What it does

A project's Tasks & notes view lists the project's issues in a group of their own, marked read-only, open ones unless
the filter says otherwise. The group appears only in the project scope of that view, because a session's view is about
that session. The session sidebar (spec 43) lists them too, under its Tasks & notes group. Main holds one answer per
project and query for 30 seconds, shared by both views and every window. Nothing is written back to the forge and
nothing goes into the tasks table. A list stays in memory and is never stored; the filter is (see "Filters").

## Decided by the owner (2026-11-06)

- **E2:** the `gh` and `glab` CLIs, not REST with a token of our own. There is no token handling here. The cost is that
  the CLI must be installed and logged in.
- **E3:** a group of its own, so that read-only stays recognisable.
- **Off by default.** It starts a CLI that talks to a server, so a user has to ask for it.
- **The binary paths are global only**, because a path belongs to the machine. Active state and provider cascade from
  global to project. The remote is chosen per project.

## How a list is reached

1. The cascade says whether the feature is on. If not, no process starts.
2. `git remote get-url <remote>` names the repository. A remote name that could read as a flag reaches no process.
3. `parseRemoteUrl` takes the host and path and drops any credentials in the URL. A local path is no hosted repository.
4. `forgeProvider` decides, and `auto` decides from the host. A self-hosted name that says neither gets a message
   asking for a choice rather than a guess.
5. The CLI runs with `-R` and **without the project as its working directory**. On Windows the search for a bare `gh`
   looks in the child's cwd before `PATH`, so a repository holding a `gh.exe` would have it run when the view opens.
   This was reproduced under node and Electron, and only with `NoDefaultCurrentDirectoryInExePath` unset, which is why
   a shell started by an agent harness can hide it.

Each way of having no list has its own message: no remote, no provider, a missing CLI, a missing login, a `.cmd` or
`.bat` path, a relative path, a path or project on a foreign network share, no answer in time, output that does not
parse.

## Choices worth keeping

- **Asked when the view or the sidebar's group opens and on a refresh, never on a timer.** A CLI start and a server request per project
  per interval would be paid whether anyone looks or not.
- **`execFile`, never a shell.** On Windows a `.cmd` shim cannot start without one, so a configured one is refused by
  name. One found on `PATH` is not seen at all, and the message says "not found as an executable".
- **The test control runs the saved path**, and its handler takes only a provider id.
- **The binary paths do not travel in a settings import.** A file must not choose what runs when a view opens, which is
  the reason `externalMcpServers` is dropped too. An export still carries them.
- **The description is plain text.** Issue text is foreign. Rendering it as Markdown would also let an image in an issue
  make the app fetch from another host. A link in an issue is opened only through the card's own button, and only an
  http or https URL gets one.
- **At most 100 per query.** The count shows `N of 100+` when the limit was reached. Until #830 the list held open
  issues only; the state is now a filter (below).

## Filters (#830)

Decisions are on the issue (three comments of 2026-11-09). What was built:

- **Hybrid.** The state (open, closed, all) and the two toggles "Assigned to me" and "Opened by me" go to the CLI as
  arguments, because the list is capped and a closed issue or someone else's would never reach a local filter. The
  free text and the label filter what was read, in the window.
- **Each toggle is one argument.** gh takes `--assignee @me` and `--author @me`. glab takes `--assignee=@me`, but its
  `--author` documents a user name only, so "Opened by me" first reads the name with `glab api user --hostname
  <host>`, once per binary and host. Without a name the answer says `supports.author: false`, no `--author` is sent,
  and the toggle is not drawn; a toggle stored as on stays visible, pressed, so it can be switched off. The reload
  button reads the name again, which picks up a login or an account switch made in a terminal.
- **One cache, in main.** `listIssues(projectPath, query, { force })` holds one answer per project, query, remote,
  provider and binary path for 30 seconds. A failed answer is held only while it is in flight. The sidebar's own
  renderer-side cache went away.
- **The filter is stored per project, in a row of its own**: `forgeIssueFilter:<owner>`, `<owner>` being
  `settingsOwnerPath`, so a worktree shares its project's filter. It holds state, the two toggles and the label; the
  free text is never stored. It is not in the `project:<path>` blob, because the project settings window replaces that
  blob on Save and would erase a key it does not show, and every write there rebuilds the project list.
  `docs/settings-reference.md` has the shape.
- **A change writes only the changed field**, merged in main (`merge-setting`), so a window holding an older copy
  cannot write it back over another window's change.
- **Both views in one window follow each other** through a window event. Another window reads the row the next time its
  list loads; there is no live push across windows, because the only broadcast there is reruns every window's global
  settings for a click on a filter.
- **The count reads "N of M"**: how many match out of how many were read, with a `+` when the read hit the cap. A
  closed issue carries a "Closed" mark whenever the list can hold one.
- **The label choice** offers the labels of the issues that were read; a stored label the list no longer carries stays
  on offer so it can be taken back.
- **In the sidebar** a text field and a "Filter" button hold the row; the button opens a popover with the state, the
  label and the toggles, and Escape closes it. The project view shows all of them in one row, with a text field of its
  own (the tasks' field filters the tasks only).

## Measured

`gh` 2.103 against this repository: `issue list --json number,title,labels,author,updatedAt,url,body` answers the shape
`FORGES.github.fromRow` reads, with no working directory given. GitHub Enterprise, with or without a port, was not
measured.

`glab` 1.126 against a public project on gitlab.com: `issue list -R <url> --output json` answers the shape
`FORGES.gitlab.fromRow` reads. Its failure text can start with the bare word `ERROR`, so the reason is taken from the
next line. A self-hosted GitLab is measured below (#830).

For #830, against this repository through the app (2026-11-09): `gh --json …,state` answers `OPEN` / `CLOSED`;
`--state closed`, `--state all` and `--author @me` filter as documented. A second ask inside the cache window answered
in about 3 ms against about 0.9 s for a CLI start. The flags of both CLIs were read from their local `--help`.

For #830 on GitLab (2026-11-10): `glab` 1.126 against a project on a self-hosted instance (HTTPS on the default port,
nested group path), in an isolated demo instance, read calls only. Every query the app sent returned the same count as
the same `glab issue list` run by hand: open, `--closed` and `--all` (the last two at the 100 cap, shown as `100+`),
`--assignee=@me`, and `--author=<name>` with the name from `glab api user --hostname <host>`, on its own and with
`--all`. In the Tasks view the label and text filters narrowed the list read to the expected counts, alone and
together; the Closed badge marked exactly the closed rows under "Closed" and "Open and closed" and none under "Open";
state, label and both toggles were back after the view was reopened, the text was not. The session sidebar was not
driven against this project (it would have meant starting a CLI in it); it shares the query and the stored filter with
the Tasks view and was clicked against GitHub at #830.

## Known gaps

- `forge-issues-list` takes a project path from the window and does not check it is a registered project. It refuses a
  foreign network path, and a local one only ever reaches `git -C` and a read.
- A filter change in one window shows in another window only when that window's list next loads (see "Filters").
- `glab api user --hostname` with a host that carries a port was not measured (the self-hosted host measured at #830
  runs on the default port).
