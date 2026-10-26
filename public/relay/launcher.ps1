# ExpressHome ss.ge relay - launcher (installed by install.ps1 into
# %LOCALAPPDATA%\ExpressHomeRelay, started hidden by a scheduled task at logon
# and re-checked every 5 minutes).
#
# Keeps ssge-relay.cjs running with the portable node.exe next to it, restarts
# it when it exits, appends its output to relay.log, and before every start
# pulls the latest ssge-relay.cjs / launcher.ps1 from the server so installs
# update themselves (the client exits on its own when a new build is published).

$ErrorActionPreference = "Continue"
$dir = $PSScriptRoot
$log = Join-Path $dir "relay.log"
$node = Join-Path $dir "node\node.exe"
$client = Join-Path $dir "ssge-relay.cjs"
$configPath = Join-Path $dir "config.json"

function Log($msg) { "$(Get-Date -Format s) launcher: $msg" | Add-Content $log }

# Ctrl+C / console close must not take the launcher down with the child.
try { [Console]::TreatControlCAsInput = $true } catch {}

# One instance only (per machine).
$mutex = New-Object System.Threading.Mutex($false, "Global\ExpressHomeSsgeRelayClient")
if (-not $mutex.WaitOne(0)) { exit 0 }

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Read-ServerUrl {
  try { return ((Get-Content $configPath -Raw | ConvertFrom-Json).url).TrimEnd("/") } catch { return $null }
}

# Download $url to $target only if the content differs. Returns $true when replaced.
function Update-File($url, $target) {
  $tmp = "$target.new"
  try {
    (New-Object Net.WebClient).DownloadFile("$url`?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())", $tmp)
  } catch {
    Log "update check failed for $(Split-Path $target -Leaf): $($_.Exception.Message)"
    return $false
  }
  if ((Get-Item $tmp).Length -lt 100) { Remove-Item -Force $tmp; return $false }
  $same = (Test-Path $target) -and ((Get-FileHash $tmp -Algorithm SHA256).Hash -eq (Get-FileHash $target -Algorithm SHA256).Hash)
  if ($same) { Remove-Item -Force $tmp; return $false }
  Move-Item -Force $tmp $target
  Log "updated $(Split-Path $target -Leaf)"
  return $true
}

while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item -Force $log "$log.1" }

  $server = Read-ServerUrl
  if ($server) {
    [void](Update-File "$server/relay/ssge-relay.cjs" $client)
    if (Update-File "$server/relay/launcher.ps1" $PSCommandPath) {
      # Hand over to the new launcher and leave.
      Log "launcher updated - restarting itself"
      $mutex.ReleaseMutex() | Out-Null
      Start-Process -FilePath "$env:SystemRoot\System32\conhost.exe" -ArgumentList "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -WindowStyle Hidden
      exit 0
    }
  }

  if (-not (Test-Path $node)) { Log "node.exe missing at $node - run the installer again"; Start-Sleep -Seconds 300; continue }
  if (-not (Test-Path $client)) { Log "ssge-relay.cjs missing - waiting for download"; Start-Sleep -Seconds 60; continue }

  Log "starting relay"
  Set-Location $dir
  # Append per line so the file is never held open and can be read while running.
  & $node $client 2>&1 | ForEach-Object { Add-Content -Path $log -Value "$_" }
  Log "relay exited, restarting in 15s"
  Start-Sleep -Seconds 15
}
