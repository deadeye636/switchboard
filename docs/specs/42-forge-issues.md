# 42 — A project's GitHub and GitLab issues in Tasks & notes

Issue #816. Status: **built**. The code is `src/app/forge-issues.js`; the view is `src/renderer/views/tasks-view.js`.

## What it does

A project's Tasks & notes view lists the project's open issues in a group of their own, marked read-only. The group
appears only in the project scope of that view, because a session's view is about that session. The session sidebar
(spec 43) lists them too, under its Tasks & notes group, and holds its own answer for 30 seconds per project. Nothing is written back to the
forge and nothing goes into the tasks table. A list stays in memory until the view next loads and is never stored.

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
- **Open issues only, at most 100.** The heading shows `100+` when the limit was reached.

## Measured

`gh` 2.103 against this repository: `issue list --json number,title,labels,author,updatedAt,url,body` answers the shape
`FORGES.github.fromRow` reads, with no working directory given. GitHub Enterprise, with or without a port, was not
measured.

`glab` 1.126 against a public project on gitlab.com: `issue list -R <url> --output json` answers the shape
`FORGES.gitlab.fromRow` reads. Its failure text can start with the bare word `ERROR`, so the reason is taken from the
next line. A self-hosted GitLab was not measured.

## Known gaps

- `forge-issues-list` takes a project path from the window and does not check it is a registered project. It refuses a
  foreign network path, and a local one only ever reaches `git -C` and a read.
