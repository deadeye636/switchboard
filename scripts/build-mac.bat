@echo off
REM ---------------------------------------------------------------------------
REM Build the macOS installer on GitHub Actions and drop the artifacts in dist\.
REM build.yml runs only manually or on a v* tag; this triggers the mac target,
REM waits for it, then downloads the result into the repo's dist\ folder.
REM Requires the GitHub CLI, authenticated:  gh auth status
REM ---------------------------------------------------------------------------
setlocal
set REPO=deadeye636/switchboard
REM Work from the repo root (this script lives in scripts\).
cd /d "%~dp0.."

where gh >nul 2>nul
if errorlevel 1 (
  echo [!] GitHub CLI ^(gh^) not found. Install from https://cli.github.com/
  pause
  exit /b 1
)

echo Triggering macOS build on %REPO% ...
gh workflow run build.yml --repo %REPO% -f platform=mac
if errorlevel 1 (
  echo [!] Failed to start the workflow. Check: gh auth status
  pause
  exit /b 1
)

REM Give the run a moment to register, then grab its id (newest manual run).
timeout /t 6 /nobreak >nul
set RUN=
for /f "usebackq delims=" %%i in (`gh run list --repo %REPO% --workflow build.yml --event workflow_dispatch --limit 1 --json databaseId --jq ".[0].databaseId"`) do set RUN=%%i
if "%RUN%"=="" (
  echo [!] Could not determine the run id. See: gh run list --repo %REPO%
  pause
  exit /b 1
)

echo Run %RUN% started. Watching until it finishes ^(mac build ~10-20 min^) ...
gh run watch %RUN% --repo %REPO% --exit-status
if errorlevel 1 (
  echo [!] Build run %RUN% failed. Logs: gh run view %RUN% --repo %REPO% --log-failed
  pause
  exit /b 1
)

if not exist dist mkdir dist
REM gh run download refuses to overwrite — clear prior mac artifacts first.
del /q "dist\*.dmg" "dist\*.dmg.blockmap" "dist\*.zip" "dist\*.zip.blockmap" "dist\latest-mac.yml" >nul 2>nul
echo Downloading mac artifacts into dist\ ...
gh run download %RUN% --repo %REPO% --name dist-mac --dir dist
if errorlevel 1 (
  echo [!] Download failed. Try manually: gh run download %RUN% --repo %REPO% --name dist-mac --dir dist
  pause
  exit /b 1
)

echo.
echo Done. macOS installer is in:  %CD%\dist
dir /b dist
pause
endlocal
