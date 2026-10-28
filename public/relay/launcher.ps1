# ExpressHome ss.ge relay - launcher (installed by install.ps1 into
# %LOCALAPPDATA%\ExpressHomeRelay, started hidden by a scheduled task at logon
# and re-checked every 5 minutes).
#
# Compatible with Windows 7 SP1 / PowerShell 2, Windows 8.1, and Windows 10+.

$ErrorActionPreference = "Continue"
# $PSScriptRoot and $PSCommandPath do not exist on Windows 7 (PowerShell 2).
# Using $PSCommandPath there made every launch look like a launcher update,
# so the script restarted itself and never started Node.
$scriptPath = $MyInvocation.MyCommand.Path
if (-not $scriptPath) { $scriptPath = $MyInvocation.MyCommand.Definition }
if (-not $PSScriptRoot) { $PSScriptRoot = Split-Path -Parent $scriptPath }
$dir = $PSScriptRoot
if (-not $scriptPath) { $scriptPath = Join-Path $dir "launcher.ps1" }
$log = Join-Path $dir "relay.log"
$node = Join-Path $dir "node\node.exe"
$client = Join-Path $dir "ssge-relay.cjs"
$configPath = Join-Path $dir "config.json"

function Log($msg) { "$(Get-Date -Format s) launcher: $msg" | Add-Content $log }

try { [Console]::TreatControlCAsInput = $true } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 4032) } catch {}
# Node 16 exits immediately on Windows 7/8 unless this is set. The relay never
# reaches the server without it, which is the "installed but has not reported in" case.
$env:NODE_SKIP_PLATFORM_CHECK = "1"

# A Global mutex needs a privilege normal users do not have on Windows 7.
# Fall back to a per-user mutex, which is enough for one interactive session.
$mutex = $null
try {
  $mutex = New-Object System.Threading.Mutex($false, "Global\ExpressHomeSsgeRelayClient")
} catch {
  $mutex = New-Object System.Threading.Mutex($false, "Local\ExpressHomeSsgeRelayClient")
}
if (-not $mutex.WaitOne(0)) { exit 0 }

function Read-ServerUrl {
  try {
    $raw = [IO.File]::ReadAllText($configPath)
    if ($raw -match '"url"\s*:\s*"([^"]+)"') { return $Matches[1].TrimEnd("/") }
  } catch {}
  return $null
}

# MD5CryptoServiceProvider is in .NET 2, so this works on Windows 7 PowerShell 2.
# Get-FileHash and HashAlgorithm.Dispose() are not. A thrown compare used to be
# treated as "file changed", which re-downloaded and restarted on every launch.
function Get-FileDigest($path) {
  $hash = ""
  $md5 = $null
  $fs = $null
  try {
    $md5 = New-Object System.Security.Cryptography.MD5CryptoServiceProvider
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $bytes = $md5.ComputeHash($fs)
    $hash = ([System.BitConverter]::ToString($bytes)).Replace("-", "")
  } catch {
    $hash = ""
  }
  if ($null -ne $fs) { try { $fs.Close() } catch {} }
  if ($null -ne $md5) { try { $md5.Clear() } catch {} }
  return $hash
}

function Same-File($a, $b) {
  $ha = Get-FileDigest $a
  $hb = Get-FileDigest $b
  if ($ha -and $hb) { return ($ha -eq $hb) }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  cmd.exe /c "fc /b `"$a`" `"$b`" >nul 2>&1" | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -eq 0) { return $true }
  if ($code -eq 1) { return $false }
  # Can't tell. Assume unchanged so a compare failure cannot restart forever.
  return $true
}

function Update-File($url, $target) {
  if (-not $target) { return $false }
  $leaf = Split-Path $target -Leaf
  if (-not $leaf) { return $false }
  $tmp = "$target.new"
  try {
    (New-Object Net.WebClient).DownloadFile("$url`?t=$(Get-Random)", $tmp)
  } catch {
    Log "update check failed for ${leaf}: $($_.Exception.Message)"
    return $false
  }
  if ((Get-Item $tmp).Length -lt 100) { Remove-Item -Force $tmp; return $false }
  if ((Test-Path $target) -and (Same-File $tmp $target)) { Remove-Item -Force $tmp; return $false }
  Move-Item -Force $tmp $target
  Log "updated $leaf"
  return $true
}

function Get-Relaunch {
  $fileArg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
  $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
  $build = 0
  try { $build = [int](Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").CurrentBuildNumber } catch {}
  if ((Test-Path $conhost) -and $build -ge 17763) {
    return @{ Exe = $conhost; Args = "--headless powershell.exe $fileArg" }
  }
  return @{
    Exe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    Args = "-WindowStyle Hidden $fileArg"
  }
}

while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5242880)) { Move-Item -Force $log "$log.1" }

  $server = Read-ServerUrl
  if ($server) {
    [void](Update-File "$server/relay/ssge-relay.cjs" $client)
    if (Update-File "$server/relay/launcher.ps1" $scriptPath) {
      Log "launcher updated - restarting itself"
      try { $mutex.ReleaseMutex() | Out-Null } catch {}
      $re = Get-Relaunch
      Start-Process -FilePath $re.Exe -ArgumentList $re.Args -WindowStyle Hidden
      exit 0
    }
  }

  if (-not (Test-Path $node)) { Log "node.exe missing at $node - run the installer again"; Start-Sleep -Seconds 300; continue }
  if (-not (Test-Path $client)) { Log "ssge-relay.cjs missing - waiting for download"; Start-Sleep -Seconds 60; continue }

  Log "starting relay"
  Set-Location $dir
  $major = 0
  try {
    $ver = & $node --version 2>$null
    if ($ver -match "^v(\d+)") { $major = [int]$Matches[1] }
  } catch {}
  # Node 16 (Windows 7 / 8) only exposes fetch behind this flag. Node 18+ rejects it.
  if ($major -ge 1 -and $major -lt 18) {
    & $node --experimental-fetch $client 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  } else {
    & $node $client 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  }
  Log "relay exited, restarting in 15s"
  Start-Sleep -Seconds 15
}
