<#
  One Windows Sandbox kept running for diagnosis, instead of a full sandbox-sync run per hypothesis (docs/testing.md).
  It maps the same app share as sandbox-sync (SANDBOX_OUT, default %TEMP%\p2platex-sandbox: run sandbox-sync once to
  stage the app) and the host's newest WebView2 runtime folder as C:\hx-webview.

    powershell -File apps/desktop/e2e/sandbox-probe/sandbox-probe.ps1 start   # sandbox + session, then the probe
    powershell -File apps/desktop/e2e/sandbox-probe/sandbox-probe.ps1 probe   # rerun probe-inside.ps1 (seconds)
    powershell -File apps/desktop/e2e/sandbox-probe/sandbox-probe.ps1 run 'Get-ChildItem C:\hx-app'   # one command, as the user
    powershell -File apps/desktop/e2e/sandbox-probe/sandbox-probe.ps1 run -System 'netsh advfirewall show allprofiles'
    powershell -File apps/desktop/e2e/sandbox-probe/sandbox-probe.ps1 stop

  Output and state live in %TEMP%\hivetex-sandbox-probe (probe.txt, app-<variant>-err.txt, one.txt).
#>
param([ValidateSet('start', 'probe', 'run', 'stop')][string]$Action = 'probe', [string]$Command = '', [switch]$System)
$ErrorActionPreference = 'Continue' # wsb writes to stderr while the sandbox session is still starting
$scripts = $PSScriptRoot
$work = Join-Path $env:TEMP 'hivetex-sandbox-probe'
$logs = Join-Path $work 'logs'
$idFile = Join-Path $work 'sandbox.id'
$share = Join-Path ($(if ($env:SANDBOX_OUT) { $env:SANDBOX_OUT } else { Join-Path $env:TEMP 'p2platex-sandbox' })) 'share'
New-Item -ItemType Directory -Force $logs | Out-Null

function Id { if (Test-Path $idFile) { (Get-Content $idFile).Trim() } else { throw 'no probe sandbox: run start first' } }
function InSb([string]$cmd, [string]$as) { wsb exec --id (Id) -c $cmd -r $as | Out-Null; if ($LASTEXITCODE -ne 0) { Write-Warning "wsb exec exited $LASTEXITCODE" } }

switch ($Action) {
  'start' {
    if (-not (Test-Path (Join-Path $share 'app\hivetex-desktop.exe'))) { throw "no staged app in ${share}: run make sandbox-sync once (SCENARIOS=basic)" }
    $webview = Get-ChildItem 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application' -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^\d+(\.\d+){3}$' } | Sort-Object { [version]$_.Name } | Select-Object -Last 1
    foreach ($e in ((wsb list --raw | ConvertFrom-Json).WindowsSandboxEnvironments)) { wsb stop --id $e.Id | Out-Null }
    $map = { param($h, $s, $ro) "<MappedFolder><HostFolder>$h</HostFolder><SandboxFolder>$s</SandboxFolder><ReadOnly>$ro</ReadOnly></MappedFolder>" }
    $cfg = '<Configuration><Networking>Enable</Networking><MappedFolders>' +
      (& $map $share 'C:\hx-share' 'true') + (& $map $scripts 'C:\hx-probe' 'true') + (& $map $work 'C:\hx-work' 'true') +
      (& $map $logs 'C:\hx-logs' 'false') + $(if ($webview) { & $map $webview.FullName 'C:\hx-webview' 'true' }) +
      '</MappedFolders></Configuration>'
    $id = (wsb start --config $cfg --raw | ConvertFrom-Json).Id
    if (-not $id) { throw 'wsb start returned no id' }
    Set-Content $idFile $id
    Start-Process wsb -ArgumentList 'connect', '--id', $id # a signed-in session is needed for app windows
    for ($i = 0; $i -lt 90; $i++) { wsb exec --id $id -c 'C:\Windows\System32\whoami.exe' -r ExistingLogin *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 2 }
    "probe sandbox $id ready (host WebView2 $($webview.Name))"
    & $PSCommandPath probe
  }
  'probe' {
    InSb 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\hx-probe\probe-inside.ps1' 'ExistingLogin'
    Get-Content (Join-Path $logs 'probe.txt')
  }
  'run' {
    if (-not $Command) { throw 'run needs a command' }
    "& { $Command } *>&1 | Out-File -Encoding utf8 C:\hx-logs\one.txt" | Set-Content -Encoding utf8 (Join-Path $work 'one.ps1')
    InSb 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\hx-work\one.ps1' $(if ($System) { 'System' } else { 'ExistingLogin' })
    Get-Content (Join-Path $logs 'one.txt')
  }
  'stop' { wsb stop --id (Id); Remove-Item $idFile }
}
