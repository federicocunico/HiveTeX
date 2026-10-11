<#
 Checks that installing a new HiveTeX Windows build leaves exactly one HiveTeX installed (Apps list).
   scripts/verify-upgrade.ps1 -Bundle apps/desktop/src-tauri/target/release/bundle [-Repo owner/name]
 Scenario A: the last published setup is installed, then the new setup.  Scenario B: the new MSI, then the new setup.
 Silent installs; needs a machine where installing software is fine (a CI runner). Exits non-zero on failure.
#>
param(
  [Parameter(Mandatory)][string]$Bundle,
  [string]$Repo = 'federicocunico/HiveTeX'
)
$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) "hivetex-upgrade-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $work | Out-Null

function Get-Installed {
  $roots = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    Get-ChildItem $r | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq 'HiveTeX' }
  }
}
function Remove-All {
  foreach ($e in @(Get-Installed)) {
    if ($e.WindowsInstaller -eq 1) { Start-Process msiexec -ArgumentList '/x', $e.PSChildName, '/qn', '/norestart' -Wait }
    elseif ($e.UninstallString) {
      $exe = $e.UninstallString.Trim('"') -replace '"?\s*$', ''
      Start-Process -FilePath $exe -ArgumentList '/S' -Wait
    }
  }
}
function Assert-One([string]$what) {
  $found = @(Get-Installed)
  Write-Host "$what -> $($found.Count) HiveTeX entries: $(($found | ForEach-Object { $_.DisplayVersion }) -join ', ')"
  if ($found.Count -ne 1) { throw "$what : expected exactly one HiveTeX, found $($found.Count)" }
}

$newSetup = Get-ChildItem (Join-Path $Bundle 'nsis') -Filter '*-setup.exe' | Select-Object -First 1
$newMsi = Get-ChildItem (Join-Path $Bundle 'msi') -Filter '*.msi' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $newSetup) { throw "No setup executable under $Bundle\nsis" }

try {
  Remove-All

  # A: previous published setup -> new setup
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' }
  $asset = $rel.assets | Where-Object { $_.name -like '*-setup.exe' } | Select-Object -First 1
  if ($asset) {
    $old = Join-Path $work $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $old
    Start-Process $old -ArgumentList '/S' -Wait
    Assert-One "old setup ($($rel.tag_name)) installed"
    Start-Process $newSetup.FullName -ArgumentList '/S' -Wait
    Assert-One 'after upgrading with the new setup'
    Remove-All
  } else { Write-Host "No published setup in $Repo yet: scenario A skipped" }

  # B: MSI -> new setup
  if ($newMsi) {
    Start-Process msiexec -ArgumentList '/i', "`"$($newMsi.FullName)`"", '/qn', '/norestart' -Wait
    Assert-One 'MSI installed'
    Start-Process $newSetup.FullName -ArgumentList '/S' -Wait
    Assert-One 'after running the new setup over the MSI'
    $left = @(Get-Installed | Where-Object { $_.WindowsInstaller -eq 1 })
    if ($left.Count) { throw 'The MSI installation is still listed' }
  } else { Write-Host 'No MSI in the bundle: scenario B skipped' }
  Write-Host 'Upgrade check passed'
} finally {
  Remove-All
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
