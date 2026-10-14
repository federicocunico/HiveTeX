<#
 Windows installer regression checks. Run only on a disposable CI runner:
 old setup -> new setup, MSI -> setup, setup -> MSI, MSI upgrade and explicit uninstall of both types.
 Upgrades preserve app-owned data/credentials; explicit uninstalls remove them and keep external projects.
#>
param([Parameter(Mandatory)][string]$Bundle, [string]$Repo = 'federicocunico/HiveTeX')
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'Installer tests require a disposable CI runner (CI=true).' }
$work = Join-Path ([IO.Path]::GetTempPath()) "hivetex-upgrade-$([guid]::NewGuid().ToString('N'))"
$work = [IO.Path]::GetFullPath($work)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $work.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test path escaped the temporary directory' }
New-Item -ItemType Directory -Path $work | Out-Null
$env:HIVETEX_MAINTENANCE_LOG = Join-Path $work 'cleanup-error.log'
$owned = @(
  (Join-Path $env:APPDATA 'app.hivetex.desktop'), (Join-Path $env:LOCALAPPDATA 'app.hivetex.desktop'),
  (Join-Path $env:APPDATA 'app.p2platex.desktop'), (Join-Path $env:LOCALAPPDATA 'app.p2platex.desktop')
)
$credential = 'hivetex-uninstall-test.app.hivetex.desktop'
$legacyCredential = 'hivetex-uninstall-test.app.p2platex.desktop'
$external = Join-Path $work 'external-project'
New-Item -ItemType Directory -Path $external | Out-Null
Set-Content -LiteralPath (Join-Path $external 'main.tex') -Value 'external document'

function Invoke-Program([string]$exe, [string[]]$arguments) {
  Write-Host "Starting installer: $exe $($arguments -join ' ')"
  $msiLog = $null
  if ([IO.Path]::GetFileName($exe) -eq 'msiexec.exe') {
    $msiLog = Join-Path $work ("msi-" + [guid]::NewGuid().ToString('N') + '.log')
    $arguments += @('/L*v', ('"' + $msiLog + '"'))
  }
  # CreateProcess avoids ShellExecute/UAC handover blocking before a process handle exists.
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = if ([IO.Path]::IsPathRooted($exe)) { [IO.Path]::GetFullPath($exe) } else { $exe }
  $startInfo.Arguments = $arguments -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($work)
  $process = [Diagnostics.Process]::Start($startInfo)
  Write-Host "Installer PID: $($process.Id)"
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    if ($msiLog -and (Test-Path -LiteralPath $msiLog)) { Get-Content -LiteralPath $msiLog -Tail 100 | Write-Host }
    throw "Installer operation timed out: $exe"
  }
  $result = $process.ExitCode
  if ($result -notin @(0, 3010)) {
    if ($msiLog -and (Test-Path -LiteralPath $msiLog)) { Get-Content -LiteralPath $msiLog -Tail 150 | Write-Host }
    throw "Installer operation failed: $exe (exit $result)"
  }
  $process.Dispose()
  Write-Host "Installer completed: $exe (exit $result)"
}
function Get-Installed {
  foreach ($registry in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (Test-Path $registry) {
      Get-ChildItem $registry | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq 'HiveTeX' }
    }
  }
}
function Remove-All {
  foreach ($entry in @(Get-Installed)) {
    if ($entry.WindowsInstaller -eq 1) { Invoke-Program msiexec.exe @('/x', $entry.PSChildName, '/qn', '/norestart') }
    elseif ($entry.UninstallString -match '^"(?<exe>[^"]+\.exe)"') { Invoke-Program $Matches.exe @('/S') }
    elseif ($entry.UninstallString -match '^(?<exe>.+?\.exe)(?:\s|$)') { Invoke-Program $Matches.exe @('/S') }
    else { throw 'Unexpected HiveTeX uninstall registration' }
  }
  # NSIS first copies the uninstaller to a temporary process; the original exe exits before cleanup finishes.
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while (@(Get-Installed).Count -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (@(Get-Installed).Count) { throw 'HiveTeX is still registered after uninstall (120-second deadline)' }
}
function Assert-One([string]$scenario) {
  $found = @(Get-Installed)
  Write-Host "$scenario -> $($found.Count) HiveTeX entries"
  if ($found.Count -ne 1) { throw "$scenario expected exactly one HiveTeX installation" }
}
function Has-Credential([string]$target = $credential) {
  $output = cmdkey.exe "/list:$target"
  # The heading repeats the requested name even when no credential exists. Match only an actual Target row.
  $pattern = '^\s*Target:\s+(?:LegacyGeneric:target=)?' + [regex]::Escape($target) + '\s*$'
  return [bool](@($output | Where-Object { $_ -match $pattern }).Count)
}
function Seed-Data {
  Write-Host 'Seeding current/legacy profile and credential fixtures'
  foreach ($dir in $owned) {
    New-Item -ItemType Directory -Force (Join-Path $dir 'stores') | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dir 'tectonic-cache') | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'stores\project-marker') -Value 'retained document'
    Set-Content -LiteralPath (Join-Path $dir 'tectonic-cache\cache-marker') -Value 'old cache'
  }
  cmdkey.exe "/generic:$credential" '/user:hivetex-test' '/pass:fixture-only' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the credential fixture' }
  cmdkey.exe "/generic:$legacyCredential" '/user:hivetex-test' '/pass:fixture-only' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the legacy credential fixture' }
  New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HiveTeX' -Value 'fixture-only'
}
function Assert-Preserved {
  foreach ($dir in $owned) {
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'stores\project-marker'))) { throw 'Upgrade removed a retained project' }
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'tectonic-cache\cache-marker'))) { throw 'Upgrade removed compiler state' }
  }
  if (-not (Has-Credential) -or -not (Has-Credential $legacyCredential)) { throw 'Upgrade removed a saved credential' }
}
function Start-Installed {
  Write-Host 'Launching the installed app before uninstall'
  $entry = @(Get-Installed)[0]
  $programDir = $entry.InstallLocation
  if (-not $programDir) {
    $key = Get-Item 'HKCU:\Software\hivetex\HiveTeX'
    $programDir = $key.GetValue('InstallDir')
    if (-not $programDir) { $programDir = $key.GetValue('') }
  }
  $programDir = $programDir.Trim('"')
  $exe = Join-Path $programDir 'hivetex-desktop.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Installed executable is missing' }
  Set-Content -LiteralPath (Join-Path $env:APPDATA 'app.hivetex.desktop\startup.json') -Value '{"background":true}'
  $script:installedExe = $exe
  $app = Start-Process -FilePath $exe -ArgumentList '--background' -WindowStyle Hidden -PassThru
  $script:installedAppId = $app.Id
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $workers = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 -Filter "ParentProcessId=$($app.Id) AND Name='node.exe'")
    if ($workers.Count -eq 1) { return }
    if ($app.HasExited) { throw 'Installed app exited before starting its worker' }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Installed app did not start exactly one worker'
}
function Assert-Clean {
  Write-Host 'Checking complete profile, credential and process removal'
  if ($script:installedExe -and (Test-Path -LiteralPath $script:installedExe)) { throw 'Uninstall left the program executable' }
  if ($script:installedAppId) {
    if (Get-Process -Id $script:installedAppId -ErrorAction SilentlyContinue) { throw 'Uninstall left the running app' }
    if (@(Get-CimInstance Win32_Process -OperationTimeoutSec 5 -Filter "ParentProcessId=$script:installedAppId AND Name='node.exe'").Count) { throw 'Uninstall left the owned worker' }
  }
  foreach ($dir in $owned) { if (Test-Path -LiteralPath $dir) { throw "Uninstall left user data: $dir" } }
  if (Has-Credential) { throw 'Uninstall left an app credential' }
  if (Has-Credential $legacyCredential) { throw 'Uninstall left a legacy app credential' }
  if (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HiveTeX' -ErrorAction SilentlyContinue) { throw 'Uninstall left login startup enabled' }
  if ((Get-Content -LiteralPath (Join-Path $external 'main.tex') -Raw).Trim() -ne 'external document') { throw 'Uninstall damaged an external project' }
}

$newSetup = Get-ChildItem (Join-Path $Bundle 'nsis') -Filter '*-setup.exe' | Select-Object -First 1
$newMsi = Get-ChildItem (Join-Path $Bundle 'msi') -Filter '*.msi' | Select-Object -First 1
if (-not $newSetup -or -not $newMsi) { throw 'Both setup and MSI installers are required' }
if (@(Get-Installed).Count) { throw 'Runner already has HiveTeX installed; refusing to remove an existing installation' }
foreach ($dir in $owned) { if (Test-Path -LiteralPath $dir) { throw 'Runner already contains HiveTeX user data' } }

try {
  $headers = @{ Accept = 'application/vnd.github+json' }
  if ($env:GH_TOKEN) { $headers.Authorization = "Bearer $env:GH_TOKEN" }
  $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -like '*-setup.exe' } | Select-Object -First 1
  if ($asset) {
    $old = Join-Path $work ([IO.Path]::GetFileName($asset.name))
    Invoke-WebRequest $asset.browser_download_url -OutFile $old
    Invoke-Program $old @('/S')
    Assert-One "old setup ($($release.tag_name))"
    Seed-Data
    Invoke-Program $newSetup.FullName @('/S')
    Assert-One 'old setup -> new setup'
    Assert-Preserved
    Start-Installed
    Remove-All
    Assert-Clean
  }

  Invoke-Program msiexec.exe @('/i', "`"$($newMsi.FullName)`"", '/qn', '/norestart')
  Assert-One 'MSI installed'
  Seed-Data
  Invoke-Program $newSetup.FullName @('/S')
  Assert-One 'MSI -> setup'
  Assert-Preserved
  if (@(Get-Installed | Where-Object { $_.WindowsInstaller -eq 1 }).Count) { throw 'MSI remains listed after setup migration' }
  Start-Installed
  Remove-All
  Assert-Clean

  Invoke-Program $newSetup.FullName @('/S')
  $setupEntry = @(Get-Installed)[0]
  $priorSetupDir = $setupEntry.InstallLocation.Trim('"')
  Seed-Data
  Invoke-Program msiexec.exe @('/i', "`"$($newMsi.FullName)`"", '/qn', '/norestart')
  Assert-One 'setup -> MSI'
  $msiEntry = @(Get-Installed)[0]
  if ($msiEntry.WindowsInstaller -ne 1) { throw 'Setup migration did not leave an MSI installation' }
  $msiDir = [IO.Path]::GetFullPath($msiEntry.InstallLocation.Trim('"')).TrimEnd('\')
  $oldDir = [IO.Path]::GetFullPath($priorSetupDir).TrimEnd('\')
  if (-not $msiDir.Equals($oldDir, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath (Join-Path $priorSetupDir 'hivetex-desktop.exe'))) { throw 'Setup migration left the earlier program in a different directory' }
  if (Test-Path -LiteralPath (Join-Path $priorSetupDir 'uninstall.exe')) { throw 'Setup migration left the earlier uninstaller' }
  Assert-Preserved
  Invoke-Program msiexec.exe @('/i', "`"$($newMsi.FullName)`"", '/qn', '/norestart')
  Assert-One 'MSI reinstall'
  Assert-Preserved
  Start-Installed
  Remove-All
  Assert-Clean
  Write-Host 'All Windows upgrade/uninstall checks passed'
} catch {
  if (Test-Path -LiteralPath $env:HIVETEX_MAINTENANCE_LOG) { Get-Content -LiteralPath $env:HIVETEX_MAINTENANCE_LOG | Write-Host }
  Write-Error -Message $_.Exception.Message -ErrorAction Continue
  throw
} finally {
  try { Remove-All } catch { Write-Warning "Final runner cleanup failed: $($_.Exception.Message)" }
  # Resolved and checked against the temporary root before recursive removal.
  Remove-Item -LiteralPath $work -Recurse -Force
}
