# ExpressHome ss.ge relay - Windows installer. Run by the personalised
# ExpressHome-relay-setup.cmd downloaded from Settings (it sets EH_RELAY_URL and
# EH_RELAY_TOKEN), or by hand:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Url https://... -Token u.xxx.yyy
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# What it does (no admin rights needed, nothing outside the user's profile):
#   %LOCALAPPDATA%\ExpressHomeRelay\
#     node\node.exe      portable Node.js (downloaded from nodejs.org, ~30 MB zip)
#     ssge-relay.cjs     the relay client (from <server>/relay/ssge-relay.cjs)
#     launcher.ps1       keeps the client running and self-updating
#     config.json        { url, token }
#     relay.log          what it is doing
#   Scheduled task "ExpressHome relay": runs launcher.ps1 hidden at every logon
#   and re-checks every 5 minutes (watchdog). Fallback: a Startup-folder shortcut.

param(
  [string]$Url = $env:EH_RELAY_URL,
  [string]$Token = $env:EH_RELAY_TOKEN,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$TaskName = "ExpressHome relay"
$Dir = Join-Path $env:LOCALAPPDATA "ExpressHomeRelay"
$NodeDir = Join-Path $Dir "node"
$NodeExe = Join-Path $NodeDir "node.exe"
$Launcher = Join-Path $Dir "launcher.ps1"
$Client = Join-Path $Dir "ssge-relay.cjs"
$ConfigPath = Join-Path $Dir "config.json"
$StartupLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "ExpressHome relay.lnk"
$LauncherArgs = "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Launcher`""
$Conhost = "$env:SystemRoot\System32\conhost.exe"

function Step($msg) { Write-Host "  * $msg" }
function Ok($msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

function Stop-Relay {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  # Kill our node.exe and the launcher powershell (matched by path/argument).
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Launcher*" -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Step "Stopping relay"
  Stop-Relay
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
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

New-Item -ItemType Directory -Force -Path $Dir, $NodeDir | Out-Null

# --- 1. Portable Node.js ------------------------------------------------------------
Step "Node.js runtime"
$haveNode = $false
if (Test-Path $NodeExe) {
  try { $v = & $NodeExe --version 2>$null; if ($v -match "^v(\d+)" -and [int]$Matches[1] -ge 20) { $haveNode = $true; Ok "already present ($v)" } } catch {}
}
if (-not $haveNode) {
  $wc = New-Object Net.WebClient
  $zipName = $null
  try {
    $sums = $wc.DownloadString("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt")
    if ($sums -match "(node-v22\.[0-9.]+-win-x64\.zip)") { $zipName = $Matches[1] }
  } catch {}
  if ($zipName) { $zipUrl = "https://nodejs.org/dist/latest-v22.x/$zipName" }
  else { $zipName = "node-v22.12.0-win-x64.zip"; $zipUrl = "https://nodejs.org/dist/v22.12.0/$zipName" }
  $zipPath = Join-Path $env:TEMP $zipName
  Write-Host "    downloading $zipName (about 30 MB)..."
  $wc.DownloadFile($zipUrl, $zipPath)
  # Only node.exe is needed (it is self-contained); pull just that entry.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entry = $zip.Entries | Where-Object { $_.Name -eq "node.exe" } | Select-Object -First 1
    if (-not $entry) { throw "node.exe not found in $zipName" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $NodeExe, $true)
  } finally { $zip.Dispose() }
  Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
  $v = & $NodeExe --version
  Ok "installed $v"
}

# --- 2. Relay files -------------------------------------------------------------------
Step "Relay client"
Stop-Relay
$wc = New-Object Net.WebClient
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$wc.DownloadFile("$Url/relay/ssge-relay.cjs?t=$stamp", $Client)
$wc.DownloadFile("$Url/relay/launcher.ps1?t=$stamp", $Launcher)
if ((Get-Item $Client).Length -lt 1000) { throw "downloaded relay client looks empty - is the server up to date?" }
$config = @{ url = $Url; token = $Token } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($ConfigPath, $config, (New-Object Text.UTF8Encoding($false)))
Ok "downloaded to $Dir"

# --- 3. Auto-start ----------------------------------------------------------------------
Step "Auto-start at logon"
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute $Conhost -Argument $LauncherArgs
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
  Warn "scheduled task not allowed here ($($_.Exception.Message)) - using the Startup folder instead"
}
if (-not $registered) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($StartupLnk)
  $lnk.TargetPath = $Conhost
  $lnk.Arguments = $LauncherArgs
  $lnk.WindowStyle = 7
  $lnk.Description = "ExpressHome ss.ge relay"
  $lnk.Save()
  Start-Process -FilePath $Conhost -ArgumentList $LauncherArgs -WindowStyle Hidden
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
    $status = $wc2.DownloadString("$Url/api/internal/ssge-relay?status=1") | ConvertFrom-Json
    if ($status.online) { $online = $true }
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
