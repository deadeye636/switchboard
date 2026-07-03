@echo off
REM ---------------------------------------------------------------------------
REM Trigger a macOS installer build on GitHub Actions (manual workflow_dispatch).
REM build.yml builds only manually or on a v* tag; this kicks off the mac target.
REM Requires the GitHub CLI, authenticated:  gh auth status
REM ---------------------------------------------------------------------------
setlocal
set REPO=deadeye636/switchboard

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

echo.
echo Started. Recent runs:
gh run list --repo %REPO% --workflow build.yml --limit 3
echo.
echo Watch live:  gh run watch --repo %REPO%
echo Artifacts land under the run's "Artifacts" section when done.
pause
endlocal
