# CI / Autobuild (GitHub Actions) — Plan

> **[← Roadmap](ROADMAP.md)** · Stand 2026-07-03 · Status: 🟢 Erledigt (#19)
>
> **Umgesetzt:** Test-CI `ci.yml` (Linux, auto bei Push/PR + manuell). Build `build.yml`
> **nur explizit** — `workflow_dispatch` (Plattform-Wahl) + Tag `v*` → Draft-Release; der
> frühere `pull_request`-Auto-Build wurde **entfernt** (Kostenzähmung, mac 10×). Publish steht
> bereits auf `deadeye636`. Mac manuell anstoßen: `scripts/build-mac.bat`. Offene Entscheidungen
> unten sind damit beantwortet (Auslöser: manuell+Tag; Test-CI: nur Linux).

Automatischer Build für **Windows + macOS + Linux** über GitHub Actions, plus Test-CI.
Möglich geworden durch den eigenen `origin` (deadeye636) — vorher als jbr-Katalog **5.2**
(„läuft nie, kein Remote") zurückgestellt.

## Rahmen (GitHub Actions, Free-Tier)

- Actions ist **im Free-Plan enthalten, auch für private Repos** — **nicht** Enterprise-only.
- **Kontingent privat:** 2.000 CI-Minuten/Monat, 500 MB Artifact-Storage.
- **Runner:** `ubuntu-latest`, `windows-latest`, `macos-latest` (Matrix).
- **Minuten-Multiplikator:** Linux **1×**, Windows **2×**, **macOS 10×** → mac frisst das
  Kontingent am schnellsten (2.000 → effektiv ~200 mac-Minuten). Daher mac sparsam triggern.

## Bezug jbr-Katalog

- **5.2 „GitHub-Actions npm test"** (Commit `249749e`) — **Basis fürs Test-Job**; adaptieren
  (Pfade/Node-Version) statt 1:1 cherry-picken.
- **5.1 c8-Coverage-Gate** (`59712a6`, PR #51) — **Folgeschritt** nach #19, wenn CI steht.
- 5.3 (eslint) + 5.4 (pre-commit fährt Tests) bleiben **Skip**.

---

## 19a Test-CI

**Ziel:** `npm test` läuft bei Push/PR auf allen drei OS (oder mind. Linux), hält `main` grün.

- Workflow `.github/workflows/ci.yml`: Matrix `os: [ubuntu, windows, macos]`, `npm ci` +
  `npm test`.
- Native Module (`better-sqlite3`, `node-pty`) werden via `postinstall`
  (`electron-builder install-app-deps` + `patch-package`) je Runner gebaut.
- **trigger-watcher.test.js** (~5 min, echte `fs.watch`/Timer) → CI-Timeout großzügig oder
  diesen Test in CI separat/optional.
- Kosten zähmen: für reine Test-CI evtl. nur **Linux** (1×), die OS-Matrix nur im Build-Job.

## 19b Autobuild (Artifacts)

**Ziel:** Installer/Pakete je OS bauen und als **Run-Artifacts** zum Download anbieten.

- Workflow `.github/workflows/build.yml`: Matrix win/mac/linux, `electron-builder` (jeweils
  `--win` / `--mac` / `--linux`), `actions/upload-artifact`.
- **Caveats Windows:** lokale Workarounds (node-gyp 13 override, Spectre-Patch via
  patch-package, `NoDefaultCurrentDirectoryInExePath` unset) sind auf **VS2026** getuned.
  GitHubs `windows-latest` = **VS2022** → node-gyp-override + patch-package greifen, aber
  ggf. kleines Tuning nötig; das env-unset ggf. als Workflow-Step.
- **macOS:** unsigniert baut; Signing/Notarization optional (Apple-ID-Secrets), für privat
  zunächst ohne.

## 19c Release (Tag → GitHub Releases)

**Ziel:** bei Tag `v*` bauen + Artefakte in ein **GitHub Release** publishen.

- `electron-builder --publish always` nutzt `package.json` → `build.publish`.
- **⚠ Blocker:** `build.publish` zeigt aktuell auf `owner: HaydnG, repo: switchboard` →
  **muss auf `deadeye636`** geändert werden, sonst pusht der Release ins falsche/fremde Repo.
- Trigger: `on: push: tags: ['v*']`. Token: das automatische `GITHUB_TOKEN` reicht für
  Releases im eigenen Repo.

---

## Offene Entscheidungen

1. **Auslöser:** nur Tag/manuell (spart Minuten, empfohlen) vs. jeder Push auf `main`.
2. **OS-Umfang v1:** alle drei, oder erst **Windows + Linux** (mac später wegen 10×-Kosten).
3. **Output:** nur **Artifacts** (Download aus Run) vs. gleich **GitHub Release** bei Tag.
4. **Test-CI-Matrix:** alle OS testen oder nur Linux (Build separat).

**Empfehlung v1:** Test-CI nur Linux bei Push/PR · Autobuild win+linux als Artifacts, manuell
(`workflow_dispatch`) + bei Tag · mac + Release als zweiter Schritt, sobald grün.

## Verify

- Workflow-Run grün je Job; Artifacts ladbar.
- Release-Build: Tag setzen → Release erscheint im **eigenen** Repo (nicht HaydnG).
- `package.json build.publish` auf deadeye636 umgestellt + lokal `npm run build:win` bleibt grün.
