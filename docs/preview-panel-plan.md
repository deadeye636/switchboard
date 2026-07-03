<!--
  Detailplan — von Hand pflegen. preview-panel-plan.html ist Generat
  (scripts/build-docs.js, `npm run docs:build`, pre-commit). Das .html NICHT editieren.
-->

# Plan #49 — Preview-Panel: HTML + Bild-Vorschau

**Status:** Geplant (nicht gestartet) · **Quelle:** brianstanley `bbc9e52` (nur Vorlage, kein Cherry-Pick) · Branch (geplant) `port/preview-panel`

## Ziel

Das File-Panel (`ViewerPanel`) neben dem bestehenden **Markdown**-Preview auch
**HTML** gerendert und **Bilder** als Bild anzeigen — statt Bild-Bytes als Text-Müll im
CodeMirror-Editor (aufgefallen beim #48-Test: geklickter Bildpfad öffnet intern, wird aber
als Text dargestellt).

## Ausgangslage — warum kein Cherry-Pick

Unsere `public/viewer-panel.js` ist von brianstanleys Base stark divergiert:

- **`open()` ist async** — Editor-Erzeugung ist hinter `loadCodeMirrorBundle().then()` gestellt,
  mit `_openGen`-Generation-Guard gegen veraltete Closures (ein zweites `open()` vor Bundle-Resolve
  gewinnt). brianstanleys `open()` ist synchron.
- Wir haben **`_isJsonish` + Format-Button** (`.json`/`.jsonl`), einen `_format()`-Pfad.
- MD-Preview läuft über den Helper **`toggleMarkdownPreview`**, und die MD-innerHTML-Stelle ist
  **DOMPurify-gewrappt** (`viewer-panel.js:397`, unser #46-XSS-Fix).
- `destroy()` bumpt `_openGen`.

brianstanleys `bbc9e52` ersetzt genau `open`, `_togglePreview`, `_setPreview`, `destroy` und den
Reload-Pfad durch `_showPreview`/`_showEditor`/`_previewKind`/`_languageKey`/`_destroyEditor`.
Ein `git cherry-pick` würde in `open()` massiv kollidieren → **manuelle Nachimplementierung**,
Diff nur als Vorlage.

## Architektur / Ansatz

### Preview-Arten

Neuer Klassifikator `_previewKind(filePath) → 'markdown' | 'html' | 'image' | 'none'`:

| Kind | Extensions | Render |
|---|---|---|
| `markdown` | `md`, `mdx`, `markdown` | `DOMPurify.sanitize(marked.parse(content))` → `innerHTML` (**#46 erhalten**) |
| `html` | `html`, `htm` | sandboxed `<iframe>` (s.u.) |
| `image` | `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg` | `<img>` aus Data-URL (SVG bewusst als `<img>`, **nicht** iframe — im `<img>` geladenes SVG führt kein Script aus) |
| `none` | sonst | kein Preview-Button |

### `open()`-Anpassung (async-Struktur erhalten)

- `previewKind` früh bestimmen. Preview-Button-Sichtbarkeit = `previewKind !== 'none'`.
- **Bild-Zweig überspringt CodeMirror komplett:** kein `loadCodeMirrorBundle`, kein `_createEditor`.
  Stattdessen sofort Data-URL holen (async IPC) + `<img>` rendern, Editor-/Wrap-/Format-/Save-Buttons aus.
  `_openGen`-Guard **auch hier** anwenden (Bild-Fetch ist async → veraltete Öffnungen verwerfen).
- Markdown/HTML-Zweig: bestehender async-Editor-Pfad bleibt; nach Editor-Erzeugung optional in Preview
  wechseln (`_shouldOpenPreview()` = `storageKey`-Wert bzw. `preferPreview`-Opt).
- `_isJsonish`/Format-Button-Logik unverändert daneben bestehen lassen.

### Preview-Umschaltung — `_showPreview` / `_showEditor`

brianstanleys unified Modell übernehmen, aber:
- **Markdown-Branch mit DOMPurify** (nicht rohes `marked` wie im Diff — sonst #46-Regression).
- **HTML-Branch** = `_renderHtmlPreview(content)` (iframe).
- **Image-Branch** = `_renderImagePreview(dataUrl)`.
- Prüfen, ob `toggleMarkdownPreview` (Helper) noch woanders genutzt wird (`grep`); wenn nur hier →
  durch `_showPreview`/`_showEditor` ersetzen, sonst Helper lassen und intern ansteuern.

### HTML-Preview (`_renderHtmlPreview`)

- `<iframe class="html-preview-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" srcdoc="…">`.
- **Kein `allow-scripts`** → kein JS-Exec in der Vorschau.
- `_htmlWithBase(content)`: `<base href="file://<dir>/">` injizieren, damit relative Ressourcen laden;
  `_escapeAttr` für den href.
- **Security-Notiz:** Sub-Ressourcen (`<img>`/`<link>`) lädt der iframe direkt über `file://` →
  **umgeht den #46-Denylist-Guard**. Ohne Scripts kein Exfil-Pfad (nur Anzeige). Bewusst akzeptiert;
  alternativ `allow-same-origin` weglassen und prüfen, ob relative Ressourcen dann noch nötig sind.

### Bild-Preview + Binär-Transport

`read-file-for-panel` liest **nur UTF-8** → untauglich für Binär. Neuer IPC:

- **`read-file-dataurl(filePath)`** (`main.js`): `resolvePanelFilePath` → `isSensitivePath`-Guard →
  `fs.statSync` Size-Cap (**Default 15 MB**, darüber `{ok:false, error:'file too large'}`) →
  `fs.readFileSync` (Buffer) → `data:<mime>;base64,<…>`. MIME aus Extension-Map
  (`png→image/png`, `svg→image/svg+xml`, …).
- **preload**: Binding `readFileDataUrl` (`ipcRenderer.invoke`).
- Renderer: `_renderImagePreview(dataUrl)` setzt `<img class="fp-image-preview" src=dataUrl>` in `previewEl`.

### Watch / Reload je Kind

- `markdown` → re-sanitize+parse (wie heute).
- `html` → `_renderHtmlPreview(newContent)`.
- `image` → Data-URL neu holen, `<img src>` tauschen (nutzt `_openGen`-Guard-Muster).

### `destroy()`

`_openGen` weiter bumpen; `previewEl.innerHTML=''` (räumt iframe/img); `previewKind='none'`.

## Toolbar (`viewer-toolbar.js`)

- Preview-Button-Titel je Kind: „Toggle markdown preview" / „Toggle HTML preview" / (Bild: Button ganz aus,
  Auto-Preview). Aktiv-Zustand → „Back to editor" (bei Bild kein Editor → Button versteckt).
- Für `image`: Save/Format/Wrap-Buttons aus.

## CSS (`style.css`)

- `.html-preview` / `.html-preview-frame` (aus Diff): Flex, weißer iframe-Background, Border.
- Neu `.fp-image-preview`: `max-width:100%`, `object-fit:contain`, zentriert, Schachbrett-BG optional.

## Sicherheit

- **#46 nicht regressieren:** beide MD-innerHTML-Stellen (`_showPreview` + Reload) DOMPurify-gewrappt.
- HTML-iframe ohne `allow-scripts`; `file://`-Sub-Ressourcen umgehen den Denylist-Guard (nur Anzeige,
  kein Script) — akzeptiert.
- Binär-IPC durch `isSensitivePath` + Size-Cap gedeckt (kein `file://`-Direktload im Renderer → Guard bleibt autoritativ).
- SVG als `<img>` (kein iframe) → kein aktives Script.

## Tests (`node --test`, kein DOM)

- Pure Helfer testbar auslagern: `previewKindForExt(ext)`, `mimeForExt(ext)`, `htmlWithBase(html, dirUrl)`,
  `fileDirUrl(path)` → eigenes Modul `public/preview-kind.js` (analog `variable-insert.js`), unit-getestet.
- IPC `read-file-dataurl`: Guard-/Size-Cap-Verhalten über bestehendes main-Test-Muster prüfen.
- Volle Suite grün halten (aktuell 507/0).

## Offene Entscheidungen (Defaults vorgeschlagen)

1. Size-Cap Bilder: **15 MB** (verwerfbar).
2. HTML `allow-same-origin`: **behalten** (relative Ressourcen) — oder strenger ohne, falls unnötig.
3. `preferPreview` für Bilder: **immer Auto-Preview** (kein sinnvoller Editor-Modus).
4. `toggleMarkdownPreview`-Helper: ersetzen vs. behalten — nach `grep`-Usage entscheiden.

## Dateien

- `public/viewer-panel.js` — Kern-Umbau (previewKind, open-Zweige, _showPreview/_showEditor, iframe, img, reload).
- `public/viewer-toolbar.js` — Button-Titel/-Sichtbarkeit je Kind.
- `public/file-panel.js` — ggf. `preferPreview: true` setzen (wie Diff).
- `public/preview-kind.js` — **neu**, pure Helfer (testbar).
- `public/style.css` — `.html-preview*`, `.fp-image-preview`.
- `main.js` — IPC `read-file-dataurl` (Guard + Size-Cap + MIME-Map).
- `preload.js` — Binding `readFileDataUrl`.
- `test/preview-kind.test.js` — **neu**.

## Umsetzungsschritte

1. `port/preview-panel` von `main`.
2. `preview-kind.js` + Test (pure Helfer) — grün.
3. IPC `read-file-dataurl` + preload-Binding.
4. `ViewerPanel`: previewKind, Bild-Zweig (Editor-Skip) zuerst — löst den konkreten Schmerz.
5. `_showPreview/_showEditor` unified + HTML-iframe; **DOMPurify** an beiden MD-Stellen sichern.
6. Toolbar + CSS.
7. Volle Suite grün, in App verifizieren (MD, HTML, PNG, SVG, `~/`-Pfad, große Datei → Cap-Fehler).
8. `--ff-only` nach `main`, Roadmap #49 → Erledigt.
