# Runs inside the probe sandbox as the signed-in user (sandbox-probe.ps1 probe). Everything goes to C:\hx-logs.
$o = 'C:\hx-logs\probe.txt'
function Say([string]$t) { $t | Out-File -Append -Encoding utf8 $o }
"probe $(Get-Date -Format o) user=$(whoami)" | Out-File -Encoding utf8 $o

Say '== OS'
$nt = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
Say "$($nt.DisplayVersion) build $([Environment]::OSVersion.Version) LCU $($nt.LCUVer)"

Say '== WMI/CIM (sandbox-sync scripts avoid it; recorded here)'
try { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Out-Null; Say 'CIM: ok' } catch { Say "CIM: $_" }

Say '== Firewall (netsh)'
netsh advfirewall show allprofiles state | Where-Object { $_ -match 'Profile|State' } | ForEach-Object { Say "   $($_.Trim())" }

Say '== WebView2 registration'
$root = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'
foreach ($k in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
               'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') {
  $p = Get-ItemProperty $k -ErrorAction SilentlyContinue
  Say "$k -> pv=$($p.pv) location=$($p.location)"
}
$pv = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv
Say "registered version folder exists: $([bool]($pv -and (Test-Path "$root\$pv\msedgewebview2.exe")))"
Say "runtime folders: $((Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', ')"
Say "host runtime mapped (C:\hx-webview): $(Test-Path C:\hx-webview\msedgewebview2.exe)"
$own = Get-ChildItem "$root\*\msedgewebview2.exe" -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Directory.Name } | Select-Object -Last 1
if ($own) { Say "newest: $($own.FullName) version=$($own.VersionInfo.FileVersion) signature=$((Get-AuthenticodeSignature $own.FullName).Status)" }

Say '== App launches (8 s each)'
if (-not (Test-Path C:\hx-share\app\hivetex-desktop.exe)) { Say 'no app in C:\hx-share\app'; Say 'done'; return }
New-Item -ItemType Directory -Force C:\hx-app | Out-Null
Copy-Item -Recurse -Force C:\hx-share\app\* C:\hx-app\
$variants = [ordered]@{
  default    = ''
  ownFolder  = $(if ($own) { $own.DirectoryName } else { '' })
  hostFolder = 'C:\hx-webview'
}
foreach ($name in $variants.Keys) {
  if ($variants[$name]) { $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $variants[$name] } else { Remove-Item env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER -ErrorAction SilentlyContinue }
  if ($name -ne 'default' -and -not $variants[$name]) { Say "$name : skipped (no folder)"; continue }
  $env:RUST_BACKTRACE = '1'
  $p = Start-Process -FilePath C:\hx-app\hivetex-desktop.exe -ArgumentList '--ignore-system-tex' -PassThru `
       -RedirectStandardError "C:\hx-logs\app-$name-err.txt" -RedirectStandardOutput "C:\hx-logs\app-$name-out.txt"
  Start-Sleep 8
  Say "$name : folder=$($variants[$name]) alive=$(-not $p.HasExited) exit=$(if ($p.HasExited) { $p.ExitCode }) webview2procs=$(@(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count)"
  $err = Get-Content "C:\hx-logs\app-$name-err.txt" -ErrorAction SilentlyContinue | Select-String -Pattern 'panicked|error' | Select-Object -First 2
  if ($err) { Say "   $($err -join ' | ')" }
  Stop-Process -Name hivetex-desktop, msedgewebview2 -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
}
Remove-Item env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER -ErrorAction SilentlyContinue
Say 'done'
