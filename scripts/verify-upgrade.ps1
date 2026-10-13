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
$owned = @((Join-Path $env:APPDATA 'app.hivetex.desktop'), (Join-Path $env:LOCALAPPDATA 'app.hivetex.desktop'))
$credential = 'hivetex-uninstall-test.app.hivetex.desktop'
$external = Join-Path $work 'external-project'
New-Item -ItemType Directory -Path $external | Out-Null
Set-Content -LiteralPath (Join-Path $external 'main.tex') -Value 'external document'

function Invoke-Program([string]$exe, [string[]]$arguments) {
  $process = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(120000)) { Stop-Process -Id $process.Id -Force; throw "Installer operation timed out: $exe" }
  if ($process.ExitCode -notin @(0, 3010)) { throw "Installer operation failed: $exe (exit $($process.ExitCode))" }
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
  if (@(Get-Installed).Count) { throw 'HiveTeX is still registered after uninstall' }
}
function Assert-One([string]$scenario) {
  $found = @(Get-Installed)
  Write-Host "$scenario -> $($found.Count) HiveTeX entries"
  if ($found.Count -ne 1) { throw "$scenario expected exactly one HiveTeX installation" }
}
function Has-Credential {
  $output = cmdkey.exe "/list:$credential"
  return ($output -join "`n") -match [regex]::Escape($credential)
}
function Seed-Data {
  foreach ($dir in $owned) {
    New-Item -ItemType Directory -Force (Join-Path $dir 'stores') | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dir 'tectonic-cache') | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'stores\project-marker') -Value 'retained document'
    Set-Content -LiteralPath (Join-Path $dir 'tectonic-cache\cache-marker') -Value 'old cache'
  }
  cmdkey.exe "/generic:$credential" '/user:hivetex-test' '/pass:fixture-only' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the credential fixture' }
  New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HiveTeX' -Value 'fixture-only'
}
function Assert-Preserved {
  foreach ($dir in $owned) {
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'stores\project-marker'))) { throw 'Upgrade removed a retained project' }
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'tectonic-cache\cache-marker'))) { throw 'Upgrade removed compiler state' }
  }
  if (-not (Has-Credential)) { throw 'Upgrade removed the saved credential' }
}
function Start-Installed {
  $entry = @(Get-Installed)[0]
  $programDir = $entry.InstallLocation
  if (-not $programDir) {
    $key = Get-Item 'HKCU:\Software\hivetex\HiveTeX'
    $programDir = $key.GetValue('InstallDir')
    if (-not $programDir) { $programDir = $key.GetValue('') }
  }
  $exe = Join-Path $programDir 'hivetex-desktop.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Installed executable is missing' }
  Set-Content -LiteralPath (Join-Path $env:APPDATA 'app.hivetex.desktop\startup.json') -Value '{"background":true}'
  $app = Start-Process -FilePath $exe -ArgumentList '--background' -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $workers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($app.Id) AND Name='node.exe'")
    if ($workers.Count -eq 1) { return }
    if ($app.HasExited) { throw 'Installed app exited before starting its worker' }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Installed app did not start exactly one worker'
}
function Assert-Clean {
  foreach ($dir in $owned) { if (Test-Path -LiteralPath $dir) { throw "Uninstall left user data: $dir" } }
  if (Has-Credential) { throw 'Uninstall left an app credential' }
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
  Seed-Data
  Invoke-Program msiexec.exe @('/i', "`"$($newMsi.FullName)`"", '/qn', '/norestart')
  Assert-One 'setup -> MSI'
  Assert-Preserved
  Invoke-Program msiexec.exe @('/i', "`"$($newMsi.FullName)`"", '/qn', '/norestart')
  Assert-One 'MSI reinstall'
  Assert-Preserved
  Start-Installed
  Remove-All
  Assert-Clean
  Write-Host 'All Windows upgrade/uninstall checks passed'
} finally {
  Remove-All
  # Resolved and checked against the temporary root before recursive removal.
  Remove-Item -LiteralPath $work -Recurse -Force
}
