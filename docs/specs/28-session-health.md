# 28 — Session health from the context fill

> Read `docs/specs/README.md` first.

**Status:** Built · **Issue:** #620, #621, #622 · **Independent:** No — the readers of three backends, one migration,
a descriptor hook on every backend, the sidebar payload and the renderer's health rule.

## The problem

The health badge (Healthy → Growing → Marathon Risk → Handoff Recommended) was computed from fixed
thresholds: user turns, transcript entries, active time, cache-read tokens and the largest single prompt.
Two crossed meant Handoff Recommended. The rule was the same for every backend and every model.

None of those numbers says how full the context window is. The cache-read total was the worst of them: every
turn re-sends the whole cached context, so the sum grows by the window's contents on each turn. On a 1M
model it passed its 20M threshold long before the window was anywhere near full. A Claude session with 76 %
of its window free was flagged Handoff Recommended, and that report is what #620 was filed about.

## The rule

- **Handoff Recommended comes from the fill alone:** the input tokens of the session's last turn, divided by
  the context window of the model that turn ran on, at or above a global threshold (default 80 %). No
  minimum number of turns.
- **The old thresholds stay.** On their own they raise Marathon Risk at most; Growing is unchanged.
- **A session whose backend cannot measure the fill shows no health badge at all**, neither Marathon Risk
  nor Growing. Without the fill, any badge would be the guess #620 complained about.
- **"No badge" is the healthy state with no reasons** (O4), not a fourth state: every consumer (the sidebar
  chip and row class, the grid card, the handoff dialog) already drew nothing for healthy.
- **The fill can be shown as text** in the session row, before the active time ("62 % context · 4h active").
  It is on by default and switchable globally.
- **There is no per-model override of the window.** Every window the app uses is either reported by a CLI,
  read from a CLI's own catalog, or was measured.

`getSessionHealth(session, { handoffPercent })` in `src/renderer/session/session-health.js` is the rule.
Callers pass the threshold through `sessionHealthOptions()` in `app.js`; the module reads no setting of its
own because `settings.html` loads it too.

## Why the LAST turn, and never a sum

A fill is a property of one request: what was sent the last time the model was asked. The readers therefore
keep the last usage record with a **non-zero** input, not a total. The zero is a measured trap: Codex reports
`input_tokens: 0` on the first `token_count` after a compaction and the real figure follows, and Pi wrote a
zero record on an aborted turn. Taking either would read a full window as an empty one.

After a compaction the next turn's input drops, measured on Claude (966 912 → 77 995) and on Pi (about
260k → 30k), so no special handling is needed there.

| Backend | Numerator | Where it is read |
|---|---|---|
| Claude | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the last assistant turn; `<synthetic>` messages are skipped | `src/backends/claude/session-reader.js` |
| Codex | `info.last_token_usage.input_tokens` (it already includes the cached part) | `src/backends/codex/parser.js` |
| Pi | `input + cacheRead + cacheWrite` of the last assistant message on the visible branch; a compaction entry's own usage is the summarising call and does not count | `src/backends/pi/parser.js` |
| Hermes | not available: the store keeps token totals per session, and `messages.token_count` was empty in every measured row | — |
| agy | not available: per-generation metadata is an unschema'd protobuf blob | — |

The values are stored in `session_cache` (`lastInputTokens`, `lastModel`, `lastModelSpec`, `lastProvider`,
`contextWindowReported`). The upsert does not coalesce them, because the transcript can legitimately take a
value back to NULL: a `/model` picker clears `lastModelSpec`, and so does a later turn that expires it (#622).

## Which window: the `contextWindow` hook

Every descriptor answers `contextWindow(row, { env, launchOptions })` with `{ windowTokens, source }` or
null, and the capability matrix carries a `contextFill` row. `src/index/projects-view.js` asks the hook per
row and stamps `contextFill: { usedTokens, windowTokens, percent }` onto the sidebar payload. The renderer
reads that field and nothing else.

- **Codex** reports the window itself with every `token_count`. The one reported with the same request as
  the fill is stored and returned. The CLI's number wins over any catalog: it read 258 400 for a family a
  catalog lists at 272 000.
- **Pi** looks the provider and model up in its own catalog (`models-store.json`, and the user's `models.json`,
  which wins). Pi's compactions on a 272 000 model triggered at 256–279k, which is consistent with it.
- **Hermes** and **agy** decline.
- **Claude** is the hard case, below.

`percent` is not capped. After a `/model` switch to a smaller window the fill can pass 100 %, which is also
what the CLI's own status line shows until it compacts.

### Claude: the transcript names the model, never the window

`message.model` never carries the `[1m]` variant, and for some models that variant decides the window. The
variant does appear in `cost-state` entries, but the CLI writes those at the end of a session, and a running
session is exactly the one the badge is for.

Every window below was measured with `claude -p --model <spec> --output-format json`, reading
`modelUsage.<model>.contextWindow`, CLI 2.1.270, against an isolated home. No value comes from a catalog.
Pi's catalog lists Sonnet 4.5 and Opus 4.6 at 1M, which is their `[1m]` value and not what the CLI gives the
bare spec.

| Model | Bare spec | `[1m]` |
|---|---|---|
| `claude-opus-5` (`opus[1m]` measured), `claude-sonnet-5` (`sonnet[1m]` measured) | 1 000 000 | 1 000 000 |
| `claude-fable-5`, `claude-fable-5-1`, `claude-opus-4-8`, `claude-opus-4-7` | 1 000 000 | — |
| `claude-opus-4-6`, `claude-sonnet-4-5` | 200 000 | 1 000 000 |
| `claude-sonnet-4-6` | 200 000 | refused on the measuring account (429 "Usage credits required for 1M context"); the CLI names it 1M |
| `claude-opus-4-5`, `claude-haiku-4-5` | 200 000 | — |

The aliases resolved to `opus` → `claude-opus-5`, `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5`,
`fable` → `claude-fable-5-1`. `default` names no model and counts as no spec.

`src/backends/claude/model-windows.js` holds the table and `resolveClaudeWindow`:

1. **A `/model <spec>` in the transcript decides the model at once**, even before the new model has run a
   turn. The CLI applies a switch immediately: right after `/model claude-sonnet-4-5` its status line read
   23 % of 200 000. An alias only names a family, though: a turn inside that family keeps its own id. A spec
   that yields no window (an unknown alias such as `opusplan`) falls back to the turn's model. A `/model`
   without an argument clears the recorded spec, because the picker's choice is not spelled out in the
   transcript. **The spec also expires once a later turn with input runs on a model it does not name**, by id
   or by its family's alias (#622). A sidechain entry in the main transcript is a subagent's request and does
   not expire it; none of the measured transcripts had one, so that exception is defensive. The switch
   is applied at once, so such a turn means the model changed after it, for example through a resume with
   another `--model`, and a spec kept past it would go on picking its own model's window for every turn that
   follows. Two of 331 measured transcripts changed model between turns with no `/model` in them.
   **The command comes in two forms**, both read, measured on CLI 2.1.272. At an idle prompt it is a user
   message of command markup, as before. Typed while a turn runs, it is held back until that turn ends and
   then written as a `system` entry (`subtype: 'local_command'`) carrying the same markup — reader v8 did not
   see that form at all. Either way the CLI first asks to confirm a switch in a conversation that has a cache
   ("Switch model? … Yes, switch / No, go back"), and nothing is written until the user says yes. Because a
   held-back switch is written after the turn that was running, that turn cannot expire it.
2. **The variant comes from every spec naming that model, and the larger window wins** (E12). The specs are
   the transcript's and the configured ones: the stored launch `model` option (it reaches the CLI as
   `--model`), `ANTHROPIC_MODEL`, and the settings files (project-local, project, user). The CLI applies them
   in that order, and measured with both set it ran the turn on the `--model` value. The app still does not
   take the first one, because it reads configuration as it is now, not as it was at launch, and a bare spec
   may be stale: a `/model <id>` typed before a later `[1m]` launch, a bare alias higher in the cascade, a
   switch another session wrote into the global user settings. Each of those used to read a 1M session
   against 200k. Taking the larger window can only make a badge late, the same trade as rule 4's unknown
   model. The order still breaks a tie, and that is what `source` reports.
   **A configured alias that names the model only by its family steps aside when a configured spec naming the
   model by its exact id outranks it** (#621). An alias names a whole family because it can be remapped inside
   it, so `opus[1m]` as a user default used to count for a session its launch or project settings pinned to
   `claude-opus-4-6`, although the alias resolves to `claude-opus-5` today. If that session ran at 200k, its
   fill read against 1M and its badge never showed. Here rank decides, not staleness: the CLI took the pin
   above the alias. An alias ABOVE the pin still counts, because the CLI applied it, and a turn on the pinned
   model under it means the alias was remapped there. An alias with no exact spec above it still counts, and a
   transcript spec pushes no alias aside. Each of those can only make a badge late.
3. **Floor:** a turn above 200 000 tokens cannot have run in a 200 000 window, so an inferred 200k becomes
   1M. The floor is not applied when the 200k comes from the CLI's own switch: a transcript spec that names
   the model outright, by id or by an alias resolving to exactly that id. A transcript alias that only
   shares the turn's family is inferred like a configured spec, and the floor applies to it.
4. **Unknowns:** an unknown `claude-*` model counts as 1M. That errs toward a late badge and never a false
   one. A model from another provider (a template pointing the CLI elsewhere) has no window.

What the hook is asked with matches the launch. `projects-view` passes the user's per-backend variables
(`backendEnv`), resolved the way `spawn.js` resolves them and keyed on a template's base backend. It also
passes the stored launch options in the cascade the launch dialog uses: global, project (through
`settingsOwnerPath`), a legacy template-id entry, then the template record. Without the variables an
`ANTHROPIC_MODEL=…[1m]` set in Switchboard read a 1M session against 200k, which would have been a false
badge again.

## Around the badge

- **Metrics text:** a sidebar row shows "N turns · X cache · Y active" when it has a badge, or when it has a
  measured fill and the fill text is on.
- **Handoff dialog:** it leaves out the "Recommendation" row for a session without a fill, instead of
  calling a session nobody can measure "Healthy".
- **Grid card:** a card built while its session was healthy grows the health chip on the next status update.
  Before, it only tinted the card. A settings change updates the grid at once.
- **Settings:** `contextFillHandoffPercent` and `showContextFill` are global only, under Projects & sidebar →
  Session health. See `docs/settings-reference.md`.

## Cost

The hook runs once per row of every sidebar payload. The first version spread `process.env` on every call
and cost 299 ms against 10 ms for 2 000 rows. It now reads the one variable it needs, memoises the settings
cascade per project (dated by its oldest file read, five-second TTL), and Pi checks its catalog's TTL before
resolving its directory: 18.6 ms with the fill against 9.9 ms without, on the same 2 000 rows. Those numbers
were taken before E12 and #621 made the Claude resolver parse every configured spec and build a candidate
list per row; they have not been re-measured since.

## What this takes away

- A long session with room left in its window no longer gets Handoff Recommended. Anyone reading the badge
  as "this session is old" sees it less often; Marathon Risk still says that.
- Hermes and agy sessions lose their health badge and their metrics text in the sidebar.
- Their health chip was also a click route into the handoff dialog. The sidebar row's handoff button and the
  command palette still offer it (E7), but a Hermes or agy grid card now has no handoff control of its own.

## Not taken

- **Reading the CLI's status line.** Claude's status-line input carries `context_window_size` and
  `used_percentage` for a running session, `[1m]` and `/model` included — the CLI's own answer. It was
  rejected (E8): a settings scope has one `statusLine`, so the app would have to write a command into a
  CLI-owned settings file and chain the user's own status line through it, with a dev-build guard like the
  attention hook's. Deriving the window writes nothing, and is exact for every model with no opt-in 1M.
- **Estimating Hermes' fill from its cumulative totals** (E6). The difference between two readings of the
  session totals averages every API call in between; with several tool calls per turn it reads too low, so
  Hermes gets no fill rather than a wrong one.
- **Other rules for a family alias** (#621). Counting an alias only for the model it resolves to today
  breaks the remap it names a family for: a 1M session under `opus[1m]` remapped to `claude-opus-4-6`, with
  nothing pinned, would read against 200k. Setting an alias aside for an exact spec ANYWHERE, rank ignored,
  gave two false badges: an alias above the pin that the CLI applied, and a `/model <id>` in the transcript,
  where the floor does not help either. Reading `ANTHROPIC_DEFAULT_*_MODEL` would answer the remap directly;
  it stays a known gap below, because the variable can also live in a settings file's `env` block, which
  the app does not read for `ANTHROPIC_MODEL` either.

## Known gaps

Each gap below reads a 1M session against 200k, so a turn between 160k and 200k can raise a FALSE badge —
the failure #620 was filed about, narrowed to these cases:

- **A Claude model whose 1M window is opt-in** (Sonnet 4.5/4.6, Opus 4.6) reads as 200k when `[1m]` is named
  nowhere the app can see. A one-off Configure override is not stored, and a `$VAR` reference to one of
  Switchboard's saved variables is not followed. The floor catches the case once a turn passes 200k.
- **A prompt queued before a held-back `/model` was not measured.** Rule 1 expires a switch once a later
  turn runs on another model. If the CLI starts a prompt that was queued before the `/model` on the old
  model, and writes that turn after the switch entry, the switch is dropped: the old model's window then
  applies until a turn on the new model runs, and after it the configured specs answer (the CLI saved the
  switch into the user settings). Measured was only one running turn with nothing queued behind it.
- **Configuration is read as it is NOW, not as it was at launch.** Since E12 a bare spec can no longer take
  away a `[1m]` that any other place still names. What is left: when the only `[1m]` was in Claude's user
  settings, which are global, a `/model` switch typed in another session overwrites it for every session;
  and a stored launch option changed after a session started applies to it too. That includes a bare pin
  added above an alias the session really ran under (#621): rule 2 then sets the alias aside, and with a
  `/model <id>` in the transcript the floor does not apply either, so the false badge is not limited to 160k–200k.
- **`ANTHROPIC_DEFAULT_*_MODEL`** is not read. The family rule covers a remap to another model of the same
  family, as long as no exact spec outranks the alias (#621); a remap to another family would not be seen.
  The remap itself was measured (CLI 2.1.272): with `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6`,
  `--model opus[1m]` ran as `claude-opus-4-6[1m]` at 1 000 000 and `--model opus` as `claude-opus-4-6` at
  200 000, so an alias's `[1m]` does travel with the remap, which is what the family rule assumes.

The rest err the other way, remove the fill, or are cosmetic:

- **Model ids in a cloud-provider form** (`us.anthropic.claude-…`) are not `claude-*` ids, so they get no
  window and no badge.
- **Old `claude-3-*` ids read as 1M** under the unknown-model rule, so their badge comes late.
- **A `[1m]` that no longer applies still counts** (E12). A session launched with `claude-sonnet-4-5[1m]` that
  then typed `/model claude-sonnet-4-5` runs at 200k, but the stored launch option still names the 1M
  variant, so the fill reads against 1M and the badge comes late.
- **A family alias with `[1m]` still counts where no exact spec outranks it** (#621). A `/model claude-opus-4-6`
  in the transcript beside a launch option `opus[1m]`, or `opus[1m]` ranked above a bare `claude-opus-4-6`,
  reads a session that runs at 200k against 1M, and the badge comes late or not at all.
- **The percent is rounded before the compare**, so 79.5 % already counts as 80.
- **The `/model` picker's transcript form was not measured.** The reader treats any `/model` without an
  argument as clearing the spec.
- **Hermes and agy** could get a fill if their stores ever expose per-turn input; both hooks decline today.
- The settings caches expire after five seconds, so a changed settings file shows on the next payload after
  that.
