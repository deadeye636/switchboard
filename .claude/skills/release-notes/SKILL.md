---
name: release-notes
description: Write the GitHub release notes for a Switchboard version from the commits and the issues closed since the last tag. Groups by what the reader will notice, not by commit; every entry names its issue. Trigger - "/release-notes", "release notes", "changelog", "notes für das release", "draft notes".
---

# Release notes for Switchboard

Turns the commits and closed issues since the last tag into the body of a GitHub release.

**Who reads this:** people who run four coding CLIs side by side and installed a desktop app to keep
them straight. They are developers. So the notes may — and should — be **technical**: name the symptom,
name the cause in half a sentence, link the issue. What they must never be is a `git log` in prose.

## The rules that make the difference

**Never guess from the subject line.** A subject is fifty characters and often says less than it seems.
For every `feat`/`fix` that is not self-evident, read `git show <sha> --stat` — the body and the touched
files decide both the wording and the section it belongs in. A commit titled `fix(projects): …` that only
touches `src/db/db.js` is not a project fix.

**One line per thing the reader will NOTICE — never one line per commit.** Six commits that hardened one
feature are one line. A commit that changed nothing a user can see is not a line at all.

**Lead with the symptom, not the fix.** "The Stats page came back empty as soon as one template ran on a
backend" tells the reader whether it ever bit them. "Fixed backendFilterIds flattening" does not.

**Collapse the plumbing.** `chore`, `refactor`, `test`, `docs`, build changes: **one** collected line under
*Under the hood*, or nothing. Never a bullet each.

**Every entry carries its issue** (`#167`). That is the technical depth this audience wants, and it is
free — the issue already holds the reasoning.

## Steps

### 1. Find the range — do not cache it

```
git describe --tags --abbrev=0            # the previous tag
git log <prev-tag>..HEAD --format='%h %s'
gh issue list --state closed --limit 100 --json number,title,labels,closedAt
```

Run `git log` **immediately before writing**, not from a list pulled earlier in the session: commits land
while you work, and a stale list silently drops them.

Then check `git status --short`. If something is uncommitted, ASK whether it belongs in this release
before assuming either way.

### 2. Read the ones that matter

For every non-obvious `feat`/`fix`: `git show <sha> --stat`. The commit bodies in this repo are long on
purpose — they say what was broken and why. That is the raw material; the note is its short form.

Pull the closed issues too. Their titles are already written from the reader's side ("Stats: a backend
filter shows an empty page as soon as a template runs on that backend") and are usually a better first
sentence than anything the commit says.

### 3. Group by what the reader notices

Fixed sections, fixed order. Leave out a section that would be empty — never pad it.

| Section | What goes in it |
|---|---|
| *(lead)* | Two or three sentences: what this release is ABOUT. No heading. |
| **What's new** | `feat` — a capability that did not exist. |
| **Fixes** | `fix` — symptom first, cause in half a sentence, then `(#nr)`. |
| **Behaviour changes** | Anything that will surprise someone who knew the old behaviour. Its own section, because a fix that changes how a control acts is not "a fix" to the person it surprises. |
| **On first start** | **Mandatory** when the release carries a DB migration or a `PARSER_SCHEMA_VERSION` bump: say what runs once, and roughly how long. Grep the diff for `migrations` / `PARSER_SCHEMA_VERSION` — do not rely on memory. |
| **Under the hood** | One collected line. Chores, refactors, tests, build. |

### 4. Two gates before it goes anywhere

**Privacy.** These notes land on a PUBLIC repo. No absolute paths, no machine names, no customer or
private project names — not in the notes, not in a screenshot attached to them. The guard hook blocks a
leak, but the point is not to write one.

**The build has to have been INSTALLED.** A release whose installer was never run is not tested: install
it, start it, and — if the release carries a migration — point it at a COPY of a real database and check
the sidebar looks the same afterwards. (Where the installer goes and how to fetch it: CLAUDE.md,
"Release artifacts".)

This is not a formality. 0.7.5's first draft shipped without `backends/` and the app died on its first
`require`. The repo ran, `npm start` ran, 1244 tests passed; only the installer was missing anything, and
nobody had ever installed their own build.

### 5. Show it, then write it

Show the finished markdown to the user for approval. Only then:

```
gh release list                                  # the draft is ALREADY there — confirm it
gh release edit v<version> --notes-file <file>
gh release edit v<version> --title "<version>"   # title is 0.7.6 — no `v`. The TAG is v0.7.6.
```

**EDIT. Never `gh release create`.** Pushing the tag fires `.github/workflows/build.yml`, which builds all
three platforms and creates the draft itself, with 19 assets — including the `latest*.yml` files the
auto-updater needs. A release you create yourself is a **second** release on the same tag, carrying only
what you attached by hand: no `latest*.yml`, so auto-update from it cannot work, and the releases page
shows the wrong one. In 0.7.6 that is exactly what happened, and it surfaced as *"why is there only a
Windows build?"* — the answer being that the real release had all of them, one click away.

If you must reach for `gh api -X PATCH …/releases/<id>`, pass `tag_name` with it: omitting it **resets the
release's tag to an `untagged-…` placeholder**.

The release stays a **draft** until the user says otherwise — publishing is a separate, explicit decision
(and one the assistant asks for by name, never in passing).

## Worked example — what the shapes look like

**A fix.** Symptom, cause, issue:

> - **Stats came back empty for a backend** as soon as one template ran on it — the filter expands to
>   "the backend plus its templates", and the query layer was flattening that list into a single string
>   that matched nothing. (#168)

**A behaviour change.** Say what the reader knew, and what is true now:

> - **"Remove" now removes.** It used to be a permanent hide — the transcripts stay on disk, so the next
>   scan simply derived the project back. It takes the project off the list and clears its cached rows;
>   no transcript is deleted, and a *new* session in that folder brings the project back. To keep the old
>   behaviour, use **Hide**.

**Under the hood.** One line, not seven:

> Project management moved out of `src/main.js` into a module with tests (#170), the shared file-store walk is
> no longer copied per backend (#156), and the cold scan now reports how long it took.

## Counter-examples

- ❌ `fix(stats): a backend filter is a LIST of ids, and db.js was flattening it` — the commit subject,
  pasted. It names the internals and not the symptom.
- ❌ A bullet for `chore(backlog): regenerate mirror` — the reader has no backlog mirror.
- ❌ Seven bullets for the seven commits that built one feature.
- ❌ A "Fixes" entry with no issue number when an issue exists.
- ❌ Notes written from the commit list alone, without reading a single body — that is how a two-line
  subject becomes a wrong sentence.
