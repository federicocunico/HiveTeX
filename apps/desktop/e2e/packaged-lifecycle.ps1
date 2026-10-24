<# Runs inside a disposable Windows Sandbox, against the actual production-identity NSIS package. #>
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw 'This acceptance requires the disposable Windows Sandbox user.' }
if (Get-Process hivetex-desktop -ErrorAction SilentlyContinue) { throw 'An app is already running.' }
$profilePath = Join-Path $env:APPDATA 'app.hivetex.desktop'
if (Test-Path -LiteralPath $profilePath) { throw 'Refusing an existing production profile.' }
$program = 'C:\hivetex-packaged'
if (Test-Path -LiteralPath $program) { throw 'Refusing an existing program directory.' }
New-Item -ItemType Directory -Force $Out | Out-Null
Start-Transcript -Path (Join-Path $Out 'packaged-transcript.txt') | Out-Null
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HxWindow {
  public long Handle; public uint Pid; public string Class; public string Title; public bool Visible;
  delegate bool Callback(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static HxWindow[] All() {
    var rows = new List<HxWindow>();
    EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h,out p); var c=new StringBuilder(256); var t=new StringBuilder(256);
      GetClassName(h,c,256); GetWindowText(h,t,256); rows.Add(new HxWindow { Handle=h.ToInt64(), Pid=p, Class=c.ToString(), Title=t.ToString(), Visible=IsWindowVisible(h) }); return true;
    },IntPtr.Zero); return rows.ToArray();
  }
}
'@
$report = @{ startedAt = [DateTime]::UtcNow.ToString('o'); identifier = 'app.hivetex.desktop'; installerSha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLower(); scenarios = @(); passed = $false }
$primary = $null
$captures = @()
function Start-Hidden([string]$Path, [string]$Arguments = '', [string]$LogName = '') {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Path; $start.Arguments = $Arguments
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  if ($LogName) { $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true }
  $process = [Diagnostics.Process]::Start($start)
  # Keep the native process handle: PowerShell Start-Process can lose ExitCode for fast secondaries.
  $null = $process.Handle
  if ($LogName) { $script:captures += @{ name=$LogName; stdout=$process.StandardOutput.ReadToEndAsync(); stderr=$process.StandardError.ReadToEndAsync() } }
  return $process
}
if (Test-Path 'C:\hx-webview\msedgewebview2.exe') { $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = 'C:\hx-webview' }
$report.webviewOverride = $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
function Wait-For([scriptblock]$Condition, [string]$Description) {
  $end = [DateTime]::UtcNow.AddSeconds(40)
  do { if (& $Condition) { return }; Start-Sleep -Milliseconds 300 } while ([DateTime]::UtcNow -lt $end)
  throw "Timed out: $Description"
}
function Record([string]$Name, [int]$OwnerId, [int]$Visible) {
  $owners = @(Get-Process hivetex-desktop -ErrorAction SilentlyContinue)
  if ($owners.Count -ne 1 -or $owners[0].Id -ne $OwnerId) { throw "${Name}: not one owning application" }
  $windows = @([HxWindow]::All() | Where-Object Pid -eq $OwnerId)
  # tray-icon 0.25.1 creates one native tray_icon_app window for every registered icon.
  $trays = @($windows | Where-Object Class -eq 'tray_icon_app')
  $main = @($windows | Where-Object { $_.Visible -and $_.Title -eq 'HiveTeX' })
  if ($trays.Count -ne 1 -or $main.Count -ne $Visible) { throw "${Name}: trays=$($trays.Count), visible main windows=$($main.Count)" }
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$OwnerId" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath)
  if (@($children | Where-Object Name -eq 'node.exe').Count -ne 1) { throw "${Name}: not one bundled sync worker" }
  $report.scenarios += @{ name=$Name; owner=$OwnerId; path=$owners[0].Path; windows=$windows; trayCount=$trays.Count; visibleWindows=$main.Count; children=$children }
}
try {
  $setup = Start-Hidden $Installer "/S /D=$program"
  if (-not $setup.WaitForExit(180000) -or $setup.ExitCode -ne 0) { throw 'Package installation failed or timed out.' }
  $exe = Join-Path $program 'hivetex-desktop.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Installed executable missing.' }
  $report.version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
  $report.exeSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
  $check = Start-Hidden $exe '--self-check' 'self-check'
  if (-not $check.WaitForExit(90000) -or $check.ExitCode -ne 0) { throw "Packaged self-check failed (exit $($check.ExitCode))." }
  $report.selfCheck = $captures[-1].stdout.Result
  $copyDir = Join-Path $env:TEMP 'hivetex-cross-path'
  New-Item -ItemType Directory -Path $copyDir | Out-Null
  $copy = Join-Path $copyDir 'hivetex-desktop.exe'; Copy-Item -LiteralPath $exe -Destination $copy
  $primary = Start-Hidden $exe '' 'app'
  Wait-For {
    $mutex = $null
    $held = [Threading.Mutex]::TryOpenExisting('app.hivetex.desktop-sim', [ref]$mutex)
    if ($mutex) { $mutex.Dispose() }
    $held
  } 'primary acquired the production instance mutex'
  $burst = @(0..11 | ForEach-Object { Start-Hidden $(if ($_ % 2) { $copy } else { $exe }) })
  foreach ($secondary in $burst) { if (-not $secondary.WaitForExit(15000) -or $secondary.ExitCode -ne 0) { throw "Secondary $($secondary.Id) failed to hand over (exit $($secondary.ExitCode))." } }
  Wait-For { @([HxWindow]::All() | Where-Object { $_.Pid -eq $primary.Id -and $_.Visible -and $_.Title -eq 'HiveTeX' }).Count -eq 1 } 'primary main window'
  Wait-For { @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($primary.Id) AND Name='node.exe'").Count -eq 1 } 'bundled worker'
  Record '12 concurrent launches from two paths' $primary.Id 1
  foreach ($round in 1..3) {
    $main = @([HxWindow]::All() | Where-Object { $_.Pid -eq $primary.Id -and $_.Visible -and $_.Title -eq 'HiveTeX' })[0]
    [HxWindow]::PostMessage([IntPtr]$main.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Wait-For { @([HxWindow]::All() | Where-Object { $_.Pid -eq $primary.Id -and $_.Visible -and $_.Title -eq 'HiveTeX' }).Count -eq 0 } 'closed to tray'
    Record "closed to tray $round" $primary.Id 0
    $secondary = Start-Hidden $copy
    if (-not $secondary.WaitForExit(15000) -or $secondary.ExitCode -ne 0) { throw 'Reopen secondary failed.' }
    Wait-For { @([HxWindow]::All() | Where-Object { $_.Pid -eq $primary.Id -and $_.Visible -and $_.Title -eq 'HiveTeX' }).Count -eq 1 } 'reopened main window'
    Record "reopened $round" $primary.Id 1
  }
  if (-not (Test-Path -LiteralPath $profilePath)) { throw 'Production identity profile missing.' }
  $report.passed = $true
} catch {
  $report.error = $_.Exception.Message
  $report.failureProcesses = @(Get-Process hivetex-desktop -ErrorAction SilentlyContinue | Select-Object Id,Path,MainWindowTitle)
  $report.failureWindows = @([HxWindow]::All() | Where-Object { $_.Pid -in $report.failureProcesses.Id })
  throw
}
finally {
  # This process and its entire disposable sandbox are owned by this test. No host profile is mapped here.
  if ($primary -and -not $primary.HasExited) { taskkill /PID $primary.Id /T /F | Out-Null }
  foreach ($capture in $captures) {
    foreach ($stream in 'stdout','stderr') {
      if ($capture[$stream].Wait(3000)) { [IO.File]::WriteAllText((Join-Path $Out ($capture.name + '-' + $stream + '.txt')), $capture[$stream].Result) }
    }
  }
  $report.finishedAt = [DateTime]::UtcNow.ToString('o')
  $report | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath (Join-Path $Out 'packaged-lifecycle.json') -Encoding utf8
  Stop-Transcript | Out-Null
}
