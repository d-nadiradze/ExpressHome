# ExpressHome ss.ge relay - launcher (installed by install.ps1 into
# %LOCALAPPDATA%\ExpressHomeRelay, started hidden by a scheduled task at logon
# and re-checked every 5 minutes).
#
# Compatible with Windows 8.1 / PowerShell 4 (no Tls12 enum, no
# DateTimeOffset.ToUnixTimeSeconds, no Get-FileHash on some builds).

$ErrorActionPreference = "Continue"
if (-not $PSScriptRoot) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$dir = $PSScriptRoot
$log = Join-Path $dir "relay.log"
$node = Join-Path $dir "node\node.exe"
$client = Join-Path $dir "ssge-relay.cjs"
$configPath = Join-Path $dir "config.json"

function Log($msg) { "$(Get-Date -Format s) launcher: $msg" | Add-Content $log }

try { [Console]::TreatControlCAsInput = $true } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}

$mutex = New-Object System.Threading.Mutex($false, "Global\ExpressHomeSsgeRelayClient")
if (-not $mutex.WaitOne(0)) { exit 0 }

function Read-ServerUrl {
  try {
    $raw = [IO.File]::ReadAllText($configPath)
    if ($raw -match '"url"\s*:\s*"([^"]+)"') { return $Matches[1].TrimEnd("/") }
  } catch {}
  return $null
}

function Get-Sha256($path) {
  try {
    return (Get-FileHash $path -Algorithm SHA256).Hash
  } catch {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $fs = [IO.File]::OpenRead($path)
      try { return [BitConverter]::ToString($sha.ComputeHash($fs)).Replace("-", "") } finally { $fs.Close() }
    } finally { $sha.Dispose() }
  }
}

function Update-File($url, $target) {
  $tmp = "$target.new"
  try {
    (New-Object Net.WebClient).DownloadFile("$url`?t=$(Get-Random)", $tmp)
  } catch {
    Log "update check failed for $(Split-Path $target -Leaf): $($_.Exception.Message)"
    return $false
  }
  if ((Get-Item $tmp).Length -lt 100) { Remove-Item -Force $tmp; return $false }
  $same = $false
  if (Test-Path $target) {
    try { $same = (Get-Sha256 $tmp) -eq (Get-Sha256 $target) } catch { $same = $false }
  }
  if ($same) { Remove-Item -Force $tmp; return $false }
  Move-Item -Force $tmp $target
  Log "updated $(Split-Path $target -Leaf)"
  return $true
}

function Get-Relaunch {
  $fileArg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`""
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
    if (Update-File "$server/relay/launcher.ps1" $PSCommandPath) {
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
  & $node $client 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  Log "relay exited, restarting in 15s"
  Start-Sleep -Seconds 15
}
