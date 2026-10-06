# Prints the priority class and base priority of this checkout's Electron processes, by process type (#723).
# Windows only. A covered or minimised window's renderer drops to Idle (base 4 instead of 8), and everything
# it does then takes several times as long (measured, docs/ai/driving-the-app.md).
#
#   pwsh -NoProfile -File scripts/renderer-priority.ps1
$electronDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules\electron\dist'
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($electronDir, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object {
    $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p) { '{0,-8} {1,-14} {2,-12} base={3}' -f $_.ProcessId, $type, $p.PriorityClass, $p.BasePriority }
  }
