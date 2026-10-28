# ExpressHome ss.ge relay - Windows installer. Run by the personalised
# ExpressHome-relay-setup.cmd downloaded from Settings (it sets EH_RELAY_URL and
# EH_RELAY_TOKEN), or by hand:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Url https://... -Token u.xxx.yyy
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# Compatible with Windows 7 SP1, Windows 8.1, and Windows 10+.
# Windows 7 / 8 get Node 16 (last release that runs there). Windows 8.1 gets
# Node 18. Windows 10+ gets Node 22. TLS 1.2 is enabled by number (3072)
# because older .NET has no Tls12 name.
#
# What it does (no admin rights needed, nothing outside the user's profile):
#   %LOCALAPPDATA%\ExpressHomeRelay\
#     node\node.exe      portable Node.js (downloaded from nodejs.org)
#     ssge-relay.cjs     the relay client (from <server>/relay/ssge-relay.cjs)
#     launcher.ps1       keeps the client running and self-updating
#     config.json        { url, token }
#     relay.log          what it is doing
#   Scheduled task "ExpressHome relay" (or a Startup shortcut if tasks are blocked).

param(
  [string]$Url = $env:EH_RELAY_URL,
  [string]$Token = $env:EH_RELAY_TOKEN,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# 4032 = Tls+Tls11+Tls12. The name Tls12 is missing on older .NET, so use the number.
try { [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 4032) } catch {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}
}
# Node 16 refuses to stay running on Windows 7/8 without this.
$env:NODE_SKIP_PLATFORM_CHECK = "1"

$TaskName = "ExpressHome relay"
$Dir = Join-Path $env:LOCALAPPDATA "ExpressHomeRelay"
$NodeDir = Join-Path $Dir "node"
$NodeExe = Join-Path $NodeDir "node.exe"
$Launcher = Join-Path $Dir "launcher.ps1"
$Client = Join-Path $Dir "ssge-relay.cjs"
$ConfigPath = Join-Path $Dir "config.json"
$StartupLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "ExpressHome relay.lnk"

function Step($msg) { Write-Host "  * $msg" }
function Ok($msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

function Get-WinBuild {
  try { return [int](Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").CurrentBuildNumber } catch { return 0 }
}

function Get-CpuArch {
  if ($env:PROCESSOR_ARCHITECTURE -eq "x86" -and -not $env:PROCESSOR_ARCHITEW6432) { return "x86" }
  return "x64"
}

# conhost --headless is Windows 10 1809+ (build 17763). Older Windows: hidden powershell.
function Get-StartInfo {
  $fileArg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Launcher`""
  $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
  if ((Test-Path $conhost) -and (Get-WinBuild) -ge 17763) {
    return @{ Exe = $conhost; Args = "--headless powershell.exe $fileArg" }
  }
  return @{
    Exe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    Args = "-WindowStyle Hidden $fileArg"
  }
}

# schtasks writes "file not found" to stderr when the task is not there yet.
# With ErrorActionPreference Stop, PowerShell turns that into a fatal error
# even if stderr is redirected, so the call goes through cmd.
function Invoke-QuietSchtasks([string]$line) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  cmd.exe /c "schtasks $line >nul 2>&1" | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return $code
}

function Remove-LegacyTasks {
  foreach ($name in @($TaskName, "$TaskName watchdog")) {
    [void](Invoke-QuietSchtasks "/Delete /TN `"$name`" /F")
  }
}

# Windows 7 has no Register-ScheduledTask. schtasks.exe is on every Windows
# since XP and does not need an admin prompt for the current user.
function Register-LegacyTasks($start) {
  $cmdPath = Join-Path $Dir "start-relay.cmd"
  $bat = "@echo off`r`nstart `"`" /MIN `"$($start.Exe)`" $($start.Args)`r`n"
  [IO.File]::WriteAllText($cmdPath, $bat, (New-Object Text.ASCIIEncoding))
  Remove-LegacyTasks
  if ((Invoke-QuietSchtasks "/Create /TN `"$TaskName`" /TR `"$cmdPath`" /SC ONLOGON /F") -ne 0) { return $false }
  if ((Invoke-QuietSchtasks "/Create /TN `"$TaskName watchdog`" /TR `"$cmdPath`" /SC MINUTE /MO 5 /F") -ne 0) { return $false }
  [void](Invoke-QuietSchtasks "/Run /TN `"$TaskName`"")
  return $true
}

function Stop-Relay {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Remove-LegacyTasks
  $procs = @()
  try { $procs = Get-CimInstance Win32_Process -ErrorAction Stop } catch {
    try { $procs = Get-WmiObject Win32_Process } catch { $procs = @() }
  }
  foreach ($p in $procs) {
    $path = [string]$p.ExecutablePath
    $cmd = [string]$p.CommandLine
    $kill = $false
    if ($p.Name -eq "node.exe" -and $path -and $path.Length -ge $Dir.Length -and $path.Substring(0, $Dir.Length).ToLower() -eq $Dir.ToLower()) { $kill = $true }
    if ($p.Name -match "powershell" -and $cmd -like "*$Launcher*" -and $p.ProcessId -ne $PID) { $kill = $true }
    if ($kill) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
  }
}

function Extract-NodeExe($zipPath, $destExe) {
  $extracted = $false
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      $entry = $null
      foreach ($e in $zip.Entries) { if ($e.Name -eq "node.exe") { $entry = $e; break } }
      if (-not $entry) { throw "node.exe not in zip" }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destExe, $true)
      $extracted = $true
    } finally { $zip.Dispose() }
  } catch {}
  if ($extracted) { return }
  $extractDir = Join-Path $env:TEMP "ExpressHomeRelay-node"
  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  $shell = New-Object -ComObject Shell.Application
  $zipNs = $shell.NameSpace((Resolve-Path $zipPath).Path)
  $destNs = $shell.NameSpace((Resolve-Path $extractDir).Path)
  $destNs.CopyHere($zipNs.Items(), 16)
  $deadline = (Get-Date).AddSeconds(60)
  $found = $null
  while ((Get-Date) -lt $deadline -and -not $found) {
    Start-Sleep -Seconds 1
    $found = Get-ChildItem -Path $extractDir -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $found) { throw "node.exe not found in $zipPath" }
  Copy-Item -Force $found.FullName $destExe
  Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
}

if ($Uninstall) {
  Step "Stopping relay"
  Stop-Relay
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  Remove-LegacyTasks
  if (Test-Path $StartupLnk) { Remove-Item -Force $StartupLnk }
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  Ok "ExpressHome relay removed."
  exit 0
}

if (-not $Url -or -not $Token) {
  Write-Host "Missing server URL or token. Download the setup file from ExpressHome -> Settings -> Platform accounts -> ss.ge relay." -ForegroundColor Red
  exit 1
}
$Url = $Url.TrimEnd("/")

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null

# --- 1. Portable Node.js ------------------------------------------------------------
# Node 22 needs Windows 10. Windows 8.1 can run Node 18. Windows 7 / 8 stop at Node 16.
Step "Node.js runtime"
$winBuild = Get-WinBuild
$haveNode = $false
$minMajor = 16
if ($winBuild -ge 9600) { $minMajor = 18 }
if ($winBuild -ge 10240) { $minMajor = 20 }
if (Test-Path $NodeExe) {
  try {
    $v = & $NodeExe --version 2>$null
    if ($v -match "^v(\d+)" -and [int]$Matches[1] -ge $minMajor) { $haveNode = $true; Ok "already present ($v)" }
  } catch {}
}
if (-not $haveNode) {
  $arch = Get-CpuArch
  $wc = New-Object Net.WebClient
  $zipName = $null
  $zipUrl = $null
  if ($winBuild -ge 10240) {
    try {
      $sums = $wc.DownloadString("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt")
      $pat = "node-v22\.[0-9.]+-win-$arch\.zip"
      if ($sums -match $pat) { $zipName = $Matches[0]; $zipUrl = "https://nodejs.org/dist/latest-v22.x/$zipName" }
    } catch {}
    if (-not $zipUrl) { $zipName = "node-v22.12.0-win-$arch.zip"; $zipUrl = "https://nodejs.org/dist/v22.12.0/$zipName" }
  } elseif ($winBuild -ge 9600) {
    $zipName = "node-v18.20.8-win-$arch.zip"
    $zipUrl = "https://nodejs.org/dist/v18.20.8/$zipName"
  } else {
    $zipName = "node-v16.20.2-win-$arch.zip"
    $zipUrl = "https://nodejs.org/dist/v16.20.2/$zipName"
  }
  $zipPath = Join-Path $env:TEMP $zipName
  Write-Host "    downloading $zipName (about 30 MB)..."
  try {
    $wc.DownloadFile($zipUrl, $zipPath)
  } catch {
    if ($winBuild -lt 9600) {
      throw "Could not download Node.js. Windows 7 needs Service Pack 1 and .NET Framework 4.5 or newer (TLS 1.2). $($_.Exception.Message)"
    }
    throw
  }
  Extract-NodeExe $zipPath $NodeExe
  Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
  $v = & $NodeExe --version 2>$null
  if ($v -notmatch "^v\d+") { throw "Node.js did not start on this Windows." }
  Ok "installed $v"
}

# --- 2. Relay files -------------------------------------------------------------------
Step "Relay client"
Stop-Relay
$wc = New-Object Net.WebClient
$stamp = Get-Random
$wc.DownloadFile("$Url/relay/ssge-relay.cjs?t=$stamp", $Client)
$wc.DownloadFile("$Url/relay/launcher.ps1?t=$stamp", $Launcher)
if ((Get-Item $Client).Length -lt 1000) { throw "downloaded relay client looks empty - is the server up to date?" }
$json = '{ "url": "' + $Url + '", "token": "' + $Token + '" }'
[IO.File]::WriteAllText($ConfigPath, $json, (New-Object Text.UTF8Encoding($false)))
Ok "downloaded to $Dir"

# --- 3. Auto-start ----------------------------------------------------------------------
Step "Auto-start at logon"
$start = Get-StartInfo
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute $start.Exe -Argument $start.Args
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  $registered = $true
  Ok "scheduled task '$TaskName' (logon + 5-minute watchdog)"
  if (Test-Path $StartupLnk) { Remove-Item -Force $StartupLnk }
} catch {
  Warn "scheduled task cmdlet is not on this Windows ($($_.Exception.Message))"
}
if (-not $registered) {
  if (Register-LegacyTasks $start) {
    $registered = $true
    Ok "scheduled task '$TaskName' (logon + 5-minute watchdog)"
    if (Test-Path $StartupLnk) { Remove-Item -Force $StartupLnk }
  }
}
if (-not $registered) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($StartupLnk)
  $lnk.TargetPath = $start.Exe
  $lnk.Arguments = $start.Args
  $lnk.WindowStyle = 7
  $lnk.Description = "ExpressHome ss.ge relay"
  $lnk.Save()
  Start-Process -FilePath $start.Exe -ArgumentList $start.Args -WindowStyle Hidden
  Ok "Startup shortcut created"
}

# --- 4. Verify ------------------------------------------------------------------------------
Step "Waiting for the relay to report in"
$online = $false
for ($i = 0; $i -lt 20 -and -not $online; $i++) {
  Start-Sleep -Seconds 3
  try {
    $wc2 = New-Object Net.WebClient
    $wc2.Headers.Add("Authorization", "Bearer $Token")
    $status = $wc2.DownloadString("$Url/api/internal/ssge-relay?status=1")
    if ($status -match '"online"\s*:\s*true') { $online = $true }
  } catch {}
}
Write-Host ""
if ($online) {
  Write-Host "  Done. The ExpressHome relay is running in the background and will start" -ForegroundColor Green
  Write-Host "  automatically every time this PC is turned on. You can close this window." -ForegroundColor Green
} else {
  Warn "The relay was installed but has not reported in yet."
  Write-Host "  Give it a minute, then check ExpressHome -> Settings -> Platform accounts."
  Write-Host "  Log file: $(Join-Path $Dir 'relay.log')"
}
exit 0
