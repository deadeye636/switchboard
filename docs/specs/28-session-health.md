# 28 — Session health from the context fill

> Read `docs/specs/README.md` first.

**Status:** Built · **Issue:** #620 · **Independent:** No — the readers of three backends, one migration,
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
`contextWindowReported`). The upsert does not coalesce them, because a compaction or a `/model` picker can
legitimately take them back to 0 or NULL.

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
`fable` → `claude-fable-5-1`.

`src/backends/claude/model-windows.js` holds the table and `resolveClaudeWindow`:

1. **A `/model <spec>` in the transcript decides at once**, even before the new model has run a turn. The
   CLI applies a switch immediately: right after `/model claude-sonnet-4-5` its status line read 23 % of
   200 000. An alias only names a family, though: a turn inside that family keeps its own id. A spec that
   yields no window (an unknown alias such as `opusplan`) falls back to the turn's model. A `/model` without
   an argument clears the recorded spec, because the picker's choice is not spelled out in the transcript.
2. **Otherwise the variant comes from the first configured spec naming the turn's model**, in the CLI's own
   order: the stored launch `model` option (it reaches the CLI as `--model`), then `ANTHROPIC_MODEL`, then
   the settings files (project-local, project, user). Measured with both set, the CLI ran the turn on the
   `--model` value. The CLI also saves a `/model` switch into the user settings, so that file follows
   switches too.
3. **Floor:** a turn above 200 000 tokens cannot have run in a 200 000 window, so an inferred 200k becomes
   1M. The floor is not applied against a transcript spec, unless that spec is an alias of the turn's own
   family (then the variant was inferred, like a configured one).
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
resolving its directory: 18.6 ms with the fill against 9.9 ms without, on the same 2 000 rows.

## What this takes away

- A long session with room left in its window no longer gets Handoff Recommended. Anyone reading the badge
  as "this session is old" sees it less often; Marathon Risk still says that.
- Hermes and agy sessions lose their health badge and their metrics text in the sidebar.

## Not taken

- **Reading the CLI's status line.** Claude's status-line input carries `context_window_size` and
  `used_percentage` for a running session, `[1m]` and `/model` included — the CLI's own answer. It was
  rejected (E8): a settings scope has one `statusLine`, so the app would have to write a command into a
  CLI-owned settings file and chain the user's own status line through it, with a dev-build guard like the
  attention hook's. Deriving the window writes nothing, and is exact for every model with no opt-in 1M.
- **Estimating Hermes' fill from its cumulative totals** (E6). The difference between two readings of the
  session totals averages every API call in between; with several tool calls per turn it reads too low, so
  Hermes gets no fill rather than a wrong one.

## Known gaps

Each gap below reads a 1M session against 200k, so a turn between 160k and 200k can raise a FALSE badge —
the failure #620 was filed about, narrowed to these cases:

- **A Claude model whose 1M window is opt-in** (Sonnet 4.5/4.6, Opus 4.6) reads as 200k when `[1m]` is named
  nowhere the app can see. A one-off Configure override is not stored, and a `$VAR` reference to one of
  Switchboard's saved variables is not followed. The floor catches the case once a turn passes 200k.
- **A bare alias higher in the cascade outranks an exact `[1m]` spec lower down**, because the first spec
  naming the model decides.
- **A `/model <id>` left in the transcript outlives a later launch with another variant.** The spec in the
  transcript decides first (E9), so a session that typed `/model claude-sonnet-4-5` and was later resumed
  with a stored `claude-sonnet-4-5[1m]` still reads 200k.
- **Configuration is read as it is NOW, not as it was at launch.** Claude's user settings are global and the
  CLI writes a `/model` switch into them, so a switch typed in one session changes what every other session's
  cascade reads; a stored launch option changed after a session started applies to it too.
- **`ANTHROPIC_DEFAULT_*_MODEL`** is not read. The family rule covers the measured case (an alias remapped
  to another model of its family); a remap to another family would not be seen.

The rest err the other way, remove the fill, or are cosmetic:

- **Model ids in a cloud-provider form** (`us.anthropic.claude-…`) are not `claude-*` ids, so they get no
  window and no badge.
- **Old `claude-3-*` ids read as 1M** under the unknown-model rule, so their badge comes late.
- **The percent is rounded before the compare**, so 79.5 % already counts as 80.
- **The `/model` picker's transcript form was not measured.** The reader treats any `/model` without an
  argument as clearing the spec.
- **Hermes and agy** could get a fill if their stores ever expose per-turn input; both hooks decline today.
- The settings caches expire after five seconds, so a changed settings file shows on the next payload after
  that.
