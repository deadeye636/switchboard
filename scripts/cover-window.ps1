param([int]$Seconds = 20)
# Covers this checkout's dev or demo window with an opaque topmost window for $Seconds (#723), so the cost of a
# covered window can be measured without asking anyone to move windows around. Windows only.
#
#   pwsh -NoProfile -File scripts/cover-window.ps1 -Seconds 120
#
# The cover has a taskbar entry on purpose: a tool window laid over the app did NOT make it count as covered
# (measured, docs/ai/driving-the-app.md). The page turns `hidden` about six seconds after the cover appears.
# Only electron.exe from this checkout's node_modules is matched, never the installed app.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CoverWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
# Physical pixels, the same unit GetWindowRect answers in.
[CoverWin]::SetProcessDPIAware() | Out-Null
$electronDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules\electron\dist'
$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($electronDir, [StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $proc) { Write-Output 'No window of this checkout is running.'; exit 1 }
$r = New-Object CoverWin+RECT
[CoverWin]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$f = New-Object System.Windows.Forms.Form
$f.Text = 'switchboard cover'
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.TopMost = $true
$f.ShowInTaskbar = $true
$f.BackColor = [System.Drawing.Color]::Black
$f.Bounds = New-Object System.Drawing.Rectangle(($r.L - 20), ($r.T - 20), ($r.R - $r.L + 40), ($r.B - $r.T + 40))
$f.Show()
Write-Output ('covered ' + ($r.R - $r.L) + 'x' + ($r.B - $r.T) + ' for ' + $Seconds + ' s')
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
$f.Close()
Write-Output 'uncovered'
