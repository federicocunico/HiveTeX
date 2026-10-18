<#
  Records the UDP endpoints and TCP listeners of a test run and reports those not on loopback (docs/testing.md,
  "Tests and the firewall"). A local test run must show none: a UDP endpoint or a TCP listener on a real interface (or
  on 0.0.0.0 / ::) is what makes Windows ask about the firewall. Outgoing TCP connections are listed, not judged.
  Sampling reads netstat -ano: the same tables as Get-NetUDPEndpoint / Get-NetTCPConnection, which take seconds per call.

    powershell -File apps/desktop/e2e/endpoints.ps1 -Command 'cargo test --locked --lib -- --test-threads=1' -Cwd apps/desktop/src-tauri
    powershell -File apps/desktop/e2e/endpoints.ps1 -Command 'pnpm --filter @hivetex/sync test'

  The command runs under cmd.exe. The sockets of every process in its tree are sampled every -IntervalMs (the tree is
  refreshed every -TreeMs) until it exits. -Out writes the distinct endpoints as JSON. Exit code: the command's, or 3
  when a non-loopback endpoint was seen.
#>
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$Cwd = (Get-Location).Path,
  [int]$IntervalMs = 100,
  [int]$TreeMs = 1000,
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath cmd.exe -ArgumentList '/d', '/s', '/c', "`"$Command`"" -WorkingDirectory $Cwd -NoNewWindow -PassThru
$null = $p.Handle # keeps the exit code readable after exit
$seen = @{}
$samples = 0
$ids = @{}
$treeAt = [datetime]::MinValue
$pending = @{} # rows of processes not yet known to be in the tree: attributed at the next tree refresh

function Tree([int]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $t = @{ $root = 'cmd.exe' }
  do {
    $n = $t.Count
    foreach ($q in $all) { if ($t.ContainsKey([int]$q.ParentProcessId) -and -not $t.ContainsKey([int]$q.ProcessId)) { $t[[int]$q.ProcessId] = $q.Name } }
  } while ($t.Count -ne $n)
  $t
}
function Loopback([string]$a) { $a -like '127.*' -or $a -eq '::1' }
function Note($r) {
  $k = "$($r.proto) $($r.process) $($r.local) $($r.state)"
  if (-not $seen.ContainsKey($k)) { $seen[$k] = $r }
}

while (-not $p.HasExited) {
  if (([datetime]::Now - $treeAt).TotalMilliseconds -ge $TreeMs) {
    $ids = Tree $p.Id
    $treeAt = [datetime]::Now
    foreach ($o in @($pending.Keys)) { if ($ids.ContainsKey($o)) { foreach ($r in $pending[$o]) { $r.process = $ids[$o]; Note $r } } }
    $pending = @{}
  }
  $samples++
  foreach ($line in (netstat -ano)) {
    $f = -split $line
    if ($f.Count -lt 4 -or ($f[0] -ne 'TCP' -and $f[0] -ne 'UDP')) { continue }
    $proto = $f[0].ToLower()
    $state = if ($proto -eq 'tcp') { $f[3] } else { '' }
    $owner = [int]$f[-1]
    $addr = ($f[1] -replace ':[0-9]+$', '').Trim('[', ']') -replace '%[0-9]+$', ''
    $r = [pscustomobject]@{ proto = $proto; process = ''; local = $f[1]; state = $state; outgoing = ($proto -eq 'tcp' -and $state -ne 'LISTENING'); loopback = (Loopback $addr) }
    if ($ids.ContainsKey($owner)) { $r.process = $ids[$owner]; Note $r }
    elseif ($owner -gt 0) { if (-not $pending.ContainsKey($owner)) { $pending[$owner] = @() }; $pending[$owner] += $r }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
$p.WaitForExit()
$code = $p.ExitCode
$list = @($seen.Values | Sort-Object proto, process, local)
$bad = @($list | Where-Object { -not $_.loopback -and -not $_.outgoing })
# Ports are not interesting: how many sockets of which process on which address.
$summary = $list | Group-Object proto, process, { $_.local -replace ':[0-9]+$', '' }, state | ForEach-Object {
  $g = $_.Group[0]
  '{0,-5} {1,-64} {2}' -f $_.Count, $_.Name, $(if ($g.outgoing) { 'outgoing' } elseif ($g.loopback) { 'loopback' } else { 'NOT LOOPBACK' })
}
Write-Host "endpoints: $samples samples, $($list.Count) distinct sockets, $($bad.Count) not on loopback (command exit $code)"
$summary | ForEach-Object { Write-Host "  $_" }
if ($Out) { [pscustomobject]@{ command = $Command; samples = $samples; exit = $code; notLoopback = $bad.Count; endpoints = $list } | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $Out }
if ($code -ne 0) { exit $code }
if ($bad.Count -gt 0) { exit 3 }
exit 0
