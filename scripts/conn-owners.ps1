param(
  [Parameter(Mandatory = $true)][string[]]$Address,
  [int]$Port = 0
)
# Which process holds a network connection to an address, and which process started it - for answering "why does
# Switchboard talk to <host>" with the actual owner. Windows only, read-only.
#
#   pwsh -NoProfile -File scripts/conn-owners.ps1 -Address 203.0.113.10
#   pwsh -NoProfile -File scripts/conn-owners.ps1 -Address 203.0.113.10,198.51.100.7 -Port 443
#
# Measured once (2026-11): the connections that looked like Switchboard's were the CLIs it starts, not the app.
# Each `claude.exe` session is a child of Switchboard.exe and talks to its provider's API itself; the app's own
# process held none. So the parent column is the point of this script.
#
# Paths are shortened to the part after the user's home so the output can be pasted without the account name.
$userHome = [Environment]::GetFolderPath('UserProfile')
function Short([string]$p) {
  if (-not $p) { return '' }
  if ($userHome -and $p.StartsWith($userHome, [StringComparison]::OrdinalIgnoreCase)) { return '~' + $p.Substring($userHome.Length) }
  return $p
}

$rows = Get-NetTCPConnection -ErrorAction SilentlyContinue |
  Where-Object { $Address -contains $_.RemoteAddress -and ($Port -eq 0 -or $_.RemotePort -eq $Port) }
if (-not $rows) { 'no connection to ' + ($Address -join ', ') + ' right now'; exit 0 }

$rows | ForEach-Object {
  $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue).ParentProcessId
  $pp = if ($parentId) { Get-Process -Id $parentId -ErrorAction SilentlyContinue } else { $null }
  [pscustomobject]@{
    Remote  = "$($_.RemoteAddress):$($_.RemotePort)"
    State   = $_.State
    Pid     = $_.OwningProcess
    Process = if ($p) { $p.ProcessName } else { '?' }
    Path    = if ($p) { Short $p.Path } else { '' }
    Parent  = if ($pp) { "$($pp.ProcessName) ($parentId) $(Short $pp.Path)" } else { "$parentId" }
  }
} | Sort-Object Parent, Pid -Unique | Format-Table -AutoSize | Out-String -Width 240
