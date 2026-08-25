# Where handoffs live

A handoff is a packet an agent writes about its own work: what the goal was, what has been decided, what
is half-finished, what to do next. Switchboard produces one when a session has grown expensive, and seeds
a fresh session with it.

Those packets used to be rows in Switchboard's database. Nothing outside the app could reach them — not an
editor, not version control, not the agent supposed to read one, and not the same person on their other
machine. Meanwhile the handoff skills that ship with several coding CLIs write markdown straight into the
project, and Switchboard saw none of it.

A handoff is a file in its project now, and this is where it goes.

## One directory per project

The default is `.handoffs/` at the project root, and the dot is deliberate: a packet quotes paths, machine
names and whatever the session happened to be looking at. Keeping it out of the repository by default is
the setting that cannot leak. Point it at `docs/handoffs/` if you want the packets tracked, and take on the
review that comes with it.

Switchboard also reads `docs/handoffs/`, `handoffs/` and `.agent/handoffs/` without being asked, plus
whatever directory each installed CLI declares as its own — `.claude/handoffs/` for Claude, which is where
its handoff skills write. A project that already keeps packets somewhere is listed as it is.

Two settings under **Handoffs**, both with a global default and a per-project override:

- **Handoff directories** — the comma-separated list that is read. Discovery only; nothing is created.
- **Save handoffs to** — the one directory a new packet is written to, created on the first save.

They are separate on purpose. If the write target were "the first entry of the read list", reordering that
list would quietly move where future packets land. Both are relative to the project root, and a path that
escapes it is refused.

## What a handoff looks like

The first heading is the title. Under it, a header block carries the rest:

```markdown
# Tariff end date — the successor implies it

> created: 2026-08-24T09:12:00Z · backend: claude

## State
The migration is written and unreviewed. …
```

`created` is when the packet was written; `backend` is the CLI that wrote it, which is what the resume
picker preselects. Both are optional. A packet a skill wrote knowing nothing about this is still a
handoff — then the file's own timestamp answers the date, and nothing answers the backend, which is the
honest result rather than a guess.

Packets Switchboard writes are named `<date>-<slug>.md`. Nothing depends on that name: rename a file and
it is the same handoff, because everything worth knowing about it is in the content.

If the directory a packet lands in is not ignored by version control, the app says so once, when the
packet is saved. It is a note and not a refusal: some teams do commit their handoffs on purpose. It is
worth reading before the first one goes in, because a packet quotes paths, machine names and whatever the
session happened to be looking at.

## What you can do with one

- **Resume it** — the new-session menu's *Resume from handoff* starts a fresh session seeded with the
  packet. Pick any backend: a handoff is context, not a continuation, so it is not tied to the CLI that
  wrote it.
- **Hand it to a session you are already in** — the handoff picker (Ctrl/Cmd+Shift+H) inserts a reference
  at the cursor. A reference, not the packet: it runs to hundreds of lines and belongs in the agent's
  context through the agent's own file tools.
- **Read and edit it** — handoff directories appear in Agent Files like any other group, and a packet can
  be deleted from there as well as from the resume picker.

## Coming from an older version

Packets saved before this were moved into their projects the first time the new version started, and the
old table was dropped afterwards. A packet whose project directory was gone stayed in the database instead
of being thrown away; put the folder back and the next start finishes the job.
