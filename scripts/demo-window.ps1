param(
  [ValidateSet('show', 'move', 'maximize', 'minimize', 'restore')][string]$Action = 'show',
  [int]$X = 140, [int]$Y = 90, [int]$Width = 1180, [int]$Height = 760,
  [string]$Title = 'Switchboard'
)
# Places this checkout's dev or demo MAIN window the way a user would, through Win32, and prints where it is - for
# checking that a window's size, position and display mode come back after a restart (#846). Windows only.
#
#   pwsh -NoProfile -File scripts/demo-window.ps1 -Action move -X 140 -Y 90 -Width 1180 -Height 760
#   pwsh -NoProfile -File scripts/demo-window.ps1 -Action maximize
#   pwsh -NoProfile -File scripts/demo-window.ps1            # show: prints the rectangle and whether it is maximized
#
# The renderer cannot move or maximize its own window, so a click test needs this. It walks every top-level window
# of electron.exe from this checkout's node_modules with the given title ("Switchboard" is the main window; a
# detached window carries its session's title). The installed app runs from another path and is never matched.
# A minimized window reports -32000,-32000 160x28: that is Windows' own answer, not a position.
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DemoWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static List<IntPtr> Find(uint[] pids, string title) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString() == title) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$electronDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules\electron\dist'
$pids = [uint32[]]@(Get-Process -Name electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($electronDir, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { [uint32]$_.Id })
$h = [DemoWin]::Find($pids, $Title) | Select-Object -First 1
if (-not $h) { "no window titled '$Title' from this checkout's Electron"; exit 1 }

# ShowWindow commands: 9 restore, 3 maximize, 6 minimize.
switch ($Action) {
  'move'     { [void][DemoWin]::ShowWindow($h, 9); [void][DemoWin]::MoveWindow($h, $X, $Y, $Width, $Height, $true) }
  'maximize' { [void][DemoWin]::ShowWindow($h, 3) }
  'minimize' { [void][DemoWin]::ShowWindow($h, 6) }
  'restore'  { [void][DemoWin]::ShowWindow($h, 9) }
}
Start-Sleep -Milliseconds 400
$r = New-Object DemoWin+RECT
[void][DemoWin]::GetWindowRect($h, [ref]$r)
'{0} rect={1},{2} {3}x{4} maximized={5} minimized={6}' -f $Action, $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T),
  [DemoWin]::IsZoomed($h), [DemoWin]::IsIconic($h)
