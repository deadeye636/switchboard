# Document preview in the conversation view

Issue: #755. Built: a file an agent reads (a PDF, an image, Markdown, HTML) is drawn in the conversation
view as one preview card, and the card opens a viewer over the conversation. Claude (native) and Pi (native)
draw it live, and the Message History viewer draws it from the same data.

What each CLI really returns for a read is in [`docs/backend-formats.md`](../backend-formats.md) ("Document
reads (#755)", in the Claude and the Pi section). This spec does not copy it; it records what was decided on
top of those measurements.

## The problem

A `Read` of a PDF page range or an image comes back as image blocks, and the viewer drew every block inline:
a six-page range was six full-width pages in the log, each one clickable into a bare fullscreen overlay. There
was no page count, no file name, no way to open the file, and a long log became a wall of pages. The issue asked
for one card per document, a viewer with a pager and zoom, and the same "open" choice the terminal's file links
already have.

## The neutral element

A backend that knows a tool result is "the document at this path" stamps one element into that result's content
array, first, with the result's own blocks after it unchanged:

```
{ type: 'document', path, kind, name, pages, range? }
```

`kind` is `pdf`, `image`, `markdown` or `html`. `src/backends/document-ref.js` is the only constructor
(`documentElement`) and the only validator (`isDocumentElement`); it takes the kind from
`src/shared/preview-kind.js`, so the extension lists live in one place. It answers `null` without a usable path
or for an extension that has no document kind, so a backend cannot build an element for an image that has no file
behind it (O8: a screenshot from any other tool stays inline).

Why inside the content array and not on the entry: the conversation view pairs a call with its result through a map
that keeps only `block.content`. A field on the `tool_result` block is lost; an element of the array survives. The
shape is also not `_task`-style, because the result is a separate entry from the call.

Who stamps, and where the path comes from. None of the results names its file; the call does, so each stamper keeps
a map from call id to path and reads it when the result goes by.

| Backend | Stamped in | Path from | Pages |
|---|---|---|---|
| Claude, live (claude-native) | the decoder and `entriesFromTranscript`, through `stampDocuments` | `Read` input `file_path` | images held |
| Claude, history (also claude-native's attach) | `normalizeTranscriptEntries`, `src/backends/claude/transcript-view.js` | same | same |
| Pi, history | `src/backends/pi/transcript-view.js` | `read` argument `path`, made absolute with the session's cwd | images held |
| Pi, live (pi-native) | `src/backends/pi-native/rpc-protocol.js` calls the same normaliser one message at a time, with its own call map | same | same |

The stampers never change the input line; the copied line keeps its `uuid`, so `entryKey` does not move and a
stream entry and a transcript entry for the same result are equal. A `document` element that arrives with a path
is not trusted and is dropped (Claude's own `document` block, the base64 PDF, has no path and passes through
untouched). Only a successful read is stamped.

What the stampers decide per kind:

- **Claude PDF with `pages`**: the result holds the page images; `pages` is their count and `range` is the call's
  `pages` string when it is short and plain digits, dashes and commas. The card says "pages 1-3", not "3 pages",
  because the document's total is never in the result (T1; `RANGE` in `document-ref.js` keeps a label from carrying
  anything else).
- **Claude PDF without `pages`**: one `document` block, no page images. The element is stamped with `pages: 0` and
  the card has no thumbnail (O10).
- **Claude image**: one image block, `pages` 1. An image-kind file read back as text (a Claude `.svg`) holds no
  image, so it gets no element and no card.
- **Markdown, HTML**: the element, no images; the text result stays.
- **Pi**: images and text kinds only. Pi's `read` of a PDF is the file's raw bytes as text, so a PDF read gets no
  element at all. A relative path with no cwd to resolve it against also gets none; nothing is guessed.
- **Codex, Hermes, agy** do not stamp. They have no transcript normaliser in the shape the viewer reads and no pipe;
  their images stay inline as before. The card is emitted only where a backend stamps.

The two rpc contract additions this needs are in `.claude/rules/backends.md`: the core hands the decoder its
session's cwd (`createDecoder({ cwd })`) and `entriesFromMessages(res, { cwd })`.

## The per-session registry and the narrow open IPC

"Open in default app" must not become an open-anything IPC, and the two that exist (`open-path`,
`open-in-editor`) take any path and refuse only sensitive ones. They are grandfathered and not used here. The new
one is `document-open`, in `src/app/documents.js`, bound as `window.api.openDocument(sessionId, filePath, how,
invert)`.

The core already sees every entry on its way to the view, so it keeps what the view could not be trusted to name:

- `src/app/agent-rpc.js` gives each running session a registry (`state.documents`, from `createRegistry`). It
  notes the document paths of an `append` entry, and on a `reset` and on both attach routes it clears and notes the
  whole conversation read back. The registry holds at most `REGISTRY_CAP` paths (oldest dropped) and reads only
  the content arrays a result can carry.
- `documentRegistryOf(sessionId)` is what `src/main.js` hands `documents.init` as `registryFor`.

`openDocument` then checks, in this order, and each check has its reason:

1. The session is running and its registry holds the exact path. Reason: the renderer names only what this
   session's backend reported, so a compromised or buggy renderer cannot ask for an arbitrary file. A session that
   has ended has no registry, so its card's open buttons are refused (G6, see below).
2. Absolute, and not `\\host\share` or `//host/share` as spelled, refused before any `stat`. Reason: a stat of a
   network path reaches that host and hands it a Windows login.
3. No NTFS alternate data stream (`file.exe:x.pdf` reads as a PDF to an extension check).
4. The extension has a document kind. Reason: `shell.openPath` runs an executable, so a registered `.exe` or `.lnk`
   is refused all the same.
5. Not a sensitive path (`isSensitivePath` stays in `main.js` and arrives through ctx).
6. The real path (links and junctions resolved by `realPathish`) passes 2 to 5 again. Reason: a link named `a.pdf`
   that points at a key, an executable or a share is not a document.
7. A regular file.

There is no project containment root (O6): an agent legitimately reads documents from a downloads folder, and the
registry stands in for the root.

`how` is `default`, `tab` or `click`. `default` opens the real path in the system's program inside main. `tab`
answers `{ ok: true, action: 'tab', path }` and the renderer opens its own file view. `click` follows the user's
`fileClickTarget` with the terminal's Ctrl/Cmd inversion and answers `tab`, `default` or `editor` (O4, below). The
refusal wording is the module's own; a thrown error goes through `readable-error.js`.

## The card

`src/renderer/jsonl/document-card.js` draws it; `renderToolResult` in `src/renderer/jsonl/jsonl-viewer.js` asks for
it and seats it above the collapsible tool body, so a collapsed call still shows its card. The card names no
backend and no tool: it reads the element and the image blocks that follow.

- **Thumbnail**: the first page, when there is one and its encoded size is within the bound. Otherwise a box with
  the kind's label ("PDF", "Markdown"). The name and the page label sit beside it.
- **Label**: `pages <range>` when the element carries one, else `N pages` for a PDF, else the kind name. An image is
  never "1 page".
- **Open buttons** ("Open in default app", "Open in tab"): only in the conversation view, which passes
  `ctx = { sessionId, host, focusFallback }`. `sessionId` is a string or a function; the conversation view passes a
  function (`() => getSession().sessionId`) and the card calls it when it is drawn and at each click, so a re-key
  after the draw is followed. `focusFallback` is the composer's focus. "Open in default app" is `how: 'default'`, "Open in tab" is `how: 'tab'`; neither
  consults `fileClickTarget`.
- **Card click** (also Enter and Space, the card is a button): with page images it opens the viewer. Without them
  (a whole-PDF read, Markdown, HTML) it asks main for `how: 'click'`.
- **Markdown and HTML (O3)**: card above a collapsed "Text" result, so the text is still there.
- **Whole-PDF read (O10)**: name and "PDF", no thumbnail; the click opens the file in the file view, which already
  pages and zooms through pdf.js ([`22-pdf-preview.md`](22-pdf-preview.md)). Rendering the first page in the
  renderer was left for its own issue.
- **Message History (O5)**: no `ctx`. A card appears only when the result holds page images, with the viewer and
  its pager and no open buttons. Markdown, HTML and a whole-PDF read draw as they did before, because a card with
  nothing to open would be a dead control.

## The viewer

`src/renderer/jsonl/document-viewer.js`: one overlay appended inside the conversation root (`ctx.host`), never the
body, so it follows its pane through tabs, panes, grid and a detached window. One viewer per host; opening a second
replaces the first.

- Pager: buttons, ArrowLeft/ArrowRight, Home/End; hidden for a single page. A counter reads "n / total".
- Zoom: 25 % to 400 % in 25 % steps, `+`/`-`/`0`, Ctrl+wheel (Cmd on a Mac, the conversation's own test; the wheel stops at the stage so it never nudges
  the app font size); the label button resets to 100 %.
- Esc, the close button and a click on the empty backdrop close it.
- **Keys are handled by a listener on the overlay element only, never on `document`.** While the viewer is closed
  no listener exists, so the composer's keys cannot be shadowed by construction. Focus moves into the overlay on
  open, Tab is trapped between its buttons, and focus returns to the element that had it on close. When that
  element is no longer connected, the caller's `focusFallback` takes it (the conversation view: the composer; the
  history viewer passes none and focus stays). No key that starts inside the overlay reaches the conversation's
  handlers; only the keys the viewer uses are also `preventDefault`ed.
- Only the current page has a `src`; changing the page replaces it. The card hands the viewer a function that builds
  a data URL, not a copy of the pages.

Controls reuse existing styling (`.new-session-secondary-btn`); the overlay is modelled on
`.jsonl-screenshot-fullscreen`. A real mouse-and-keyboard check in tabs, panes and grid was the plan's T10 and is
recorded in the issue, not here.

## Settings

Two global settings, in the Sessions category beside "Show tool calls expanded". Both are in
[`docs/settings-reference.md`](../settings-reference.md), which holds the defaults.

- `documentPreview` (`card` or `inline`): `inline` draws the tool output as it was before this feature, including
  inline images. Read at draw time, so a change applies to what is drawn next.
- `documentPreviewMaxKB` (64 to 65536): the largest first page, as encoded characters of its base64 data, that a
  card draws a thumbnail for. Above it the card keeps its name and buttons and shows the kind box. The bound applies
  only in card mode; inline mode has no bound and draws what it always drew.

## Click routing, `fileClickTarget` and O4

The card body follows `fileClickTarget` exactly as `openTerminalFilePath` does for a terminal file link, with
Ctrl/Cmd inverting it, but the decision is made in main (`how: 'click'`), not by calling that renderer helper. That
keeps one reading of the setting next to the checks, and it lets main refuse before anything is opened.

`fileClickTarget: external` means "the configured external editor", which for a PDF would be a code editor. So
with `external`, a PDF, an image or an HTML file goes to the system's default program, and Markdown goes to the
configured editor (O4, the owner's decision; the issue said "exactly as the terminal does"). With `internal` the
answer is `tab` and the renderer calls `openFileInPanel`.

The click only reaches this route for a card with no page images. A card with pages opens the viewer on click and
leaves "which target" to the two explicit buttons.

## Performance

- **Lazy thumbnail (D9).** The card keeps a getter for the first page's data URL and sets `img.src` on the first
  `IntersectionObserver` hit (immediately where there is no observer, as in jsdom), with `decoding="async"`. The
  string lives in a `WeakMap`, so a card nobody scrolls to holds no second copy of the page.
- **Hidden views** still defer drawing (`drawable` / `flushDeferred` in the conversation view); the card is drawn
  with its entry, not earlier.
- **Bound.** A page above `documentPreviewMaxKB` is never decoded for the card.
- The pages already crossed IPC inside the entry; the card and the viewer add no copy of them. The entry holds them
  for as long as it is held (#721).
- No timing was measured for this feature; the claims above are about what is and is not built, not about
  milliseconds.

## Security notes

- **G4 (accepted, O6).** "Open in default app" on an `.html`, `.htm` or `.svg` opens a browser, which runs the
  file's scripts. The file is one the agent read and the user clicked; the registry and the extension list narrow it,
  they do not make an HTML file inert.
- **G5.** A local link that resolves to a share is refused after resolving it, which touches the link's target once
  while resolving. The agent's own `Read` had reached it already. A path spelled as a network path is refused before
  any stat.
- **G6.** The registry lives on the running session's state. After the session exits its card's buttons are refused
  ("This session is not running"), "Open in tab" included, even though the file is still there. Reopening the
  session reads the conversation back and rebuilds the registry.
- The element's `range` is data for a label only: digits, dashes and commas, short, never parsed into anything.

## Known gaps

- **L4: Pi after a compaction.** A `toolResult` whose `read` call fell out of the window gets no element, on the
  attach or reset path and in history (`retainedTail`): the result names its call only by id, and the call is gone.
- **L1.** An image-kind file read back as text, a Claude `.svg`, gets no card.
- **M1.** Another `pages` spelling than digits, dashes and commas (lists with spaces are tolerated, open ranges are
  not measured) gets `N pages` and no range.
- **Codex, Hermes and agy** do not stamp the element, so their images stay inline whatever the setting says.
- **Page total.** The document's own page count is never in a Claude result, so a partial read cannot say "3 of 40".
- **Whole-PDF thumbnail.** No first page without rendering the PDF; deferred.
- The two older open-anything IPCs (`open-path`, `open-in-editor`) are untouched and still take any non-sensitive
  path; this feature only avoids adding a third.

## What this takes away

- In card mode a PDF page range is no longer all on screen; one click shows it. `documentPreview: inline` keeps the
  old drawing.
- A stamped image read is a card, so enlarging it is a click on the card and not on the image. An image from any
  other tool is unchanged.

## What was measured

T1 ran against Claude Code 2.1.292 (Haiku) and Pi 0.85.1; the tables are in `docs/backend-formats.md`. The facts that
shaped this design: Claude sends a whole small PDF as one `document` block and page images only when the call
carries `pages`; the result never names the path; the stream and the transcript carry the same content; Pi returns
no PDF pages and may spell the path relative to the session. Pi was measured on `openai-codex` / `gpt-5.5`, not on a
small model, because the Anthropic login in Pi was not usable on that machine; the tool's result shape does not
depend on the provider.

## Files

| Area | What is there |
|---|---|
| `src/backends/document-ref.js` | the element's constructor and validator |
| `src/backends/claude/transcript-view.js` | `noteReadCalls`, `stampDocuments` |
| `src/backends/claude-native/rpc-protocol.js` | stamps live and on attach |
| `src/backends/pi/transcript-view.js`, `src/backends/pi-native/rpc-protocol.js` | Pi's stamping, with the cwd and a call map |
| `src/app/documents.js` | the registry and `document-open` |
| `src/app/agent-rpc.js` | notes the paths per session, exposes the registry |
| `src/renderer/jsonl/document-card.js`, `src/renderer/jsonl/document-viewer.js` | card and viewer |
| `src/renderer/jsonl/jsonl-viewer.js`, `src/renderer/session/conversation-view.js` | the hook and the `ctx` |
| `test/document-ref.test.js`, `test/document-card-backends.test.js`, `test/documents.test.js`, `test/document-card.test.js`, `test/document-viewer.test.js`, `test/document-settings.test.js` | the guards |
