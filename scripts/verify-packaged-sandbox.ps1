<# Build first with tauri build --bundles nsis. Only the new sandbox receives the installer. #>
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$Out = [IO.Path]::GetFullPath($Out)
if (Test-Path -LiteralPath $Out) { throw 'Choose a new acceptance output directory.' }
if (@((wsb list --raw | ConvertFrom-Json).WindowsSandboxEnvironments).Count) { throw 'A Windows Sandbox is already running; it will not be stopped by this test.' }
$share = Join-Path $Out 'share'; $logs = Join-Path $Out 'logs'
New-Item -ItemType Directory -Path $share,$logs | Out-Null
Copy-Item -LiteralPath $Installer -Destination (Join-Path $share 'setup.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/e2e/packaged-lifecycle.ps1') -Destination $share
$runtime = Get-ChildItem 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application' -Directory | Where-Object Name -Match '^\d+(\.\d+){3}$' | Sort-Object { [version]$_.Name } | Select-Object -Last 1
function Map-Folder([string]$HostPath, [string]$GuestPath, [string]$ReadOnly) {
  '<MappedFolder><HostFolder>' + [Security.SecurityElement]::Escape($HostPath) + '</HostFolder><SandboxFolder>' + $GuestPath + '</SandboxFolder><ReadOnly>' + $ReadOnly + '</ReadOnly></MappedFolder>'
}
$config = '<Configuration><Networking>Enable</Networking><MappedFolders>' + (Map-Folder $share 'C:\hx-share' 'true') + (Map-Folder $logs 'C:\hx-logs' 'false')
if ($runtime) { $config += Map-Folder $runtime.FullName 'C:\hx-webview' 'true' }
$config += '</MappedFolders></Configuration>'
$sandboxId = $null
$hostReport = @{ installer=$Installer; output=$Out; startedAt=[DateTime]::UtcNow.ToString('o'); passed=$false }
try {
  Write-Host 'Starting the disposable package acceptance sandbox'
  $sandboxId = (wsb start --config $config --raw | ConvertFrom-Json).Id
  if (-not $sandboxId) { throw 'Sandbox did not start.' }
  $hostReport.sandboxId = $sandboxId
  [IO.File]::WriteAllText((Join-Path $Out 'sandbox.id'), $sandboxId)
  Write-Host "Sandbox $sandboxId started; waiting for its user session"
  Start-Process wsb -ArgumentList 'connect','--id',$sandboxId -WindowStyle Hidden
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    # wsb writes native stderr until the interactive user session exists; this is expected during readiness.
    $ErrorActionPreference = 'Continue'
    wsb exec --id $sandboxId -c 'C:\Windows\System32\whoami.exe' -r ExistingLogin *> $null
    $probeExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($probeExit -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw 'Sandbox user session did not become ready.' }
  Write-Host 'Sandbox user ready; installing and checking the packaged app'
  wsb exec --id $sandboxId -c 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\hx-share\packaged-lifecycle.ps1 -Installer C:\hx-share\setup.exe -Out C:\hx-logs' -r ExistingLogin --raw
  $report = Get-Content -LiteralPath (Join-Path $logs 'packaged-lifecycle.json') -Raw | ConvertFrom-Json
  if (-not $report.passed) { throw "Packaged acceptance failed: $($report.error)" }
  $report.scenarios | Select-Object name,owner,trayCount,visibleWindows | Format-Table
  $hostReport.passed = $true
} catch {
  $hostReport.error = $_.Exception.Message
  throw
} finally {
  if ($sandboxId) { wsb stop --id $sandboxId --raw }
  $hostReport.finishedAt = [DateTime]::UtcNow.ToString('o')
  $hostReport | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Out 'runner.json') -Encoding utf8
}
