# Windows launcher for the ss.ge token relay: keeps scripts/ssge-token-relay.ts
# running, restarting it if it exits, and appends its output to a log file.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ssge-token-relay.ps1
#
# Register it to start at logon (run once, from the repo root):
#   schtasks /Create /F /TN "ExpressHome ss.ge token relay" /SC ONLOGON /RL LIMITED `
#     /TR "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"$PWD\scripts\ssge-token-relay.ps1\""
#   schtasks /Run /TN "ExpressHome ss.ge token relay"
#
# Log: %LOCALAPPDATA%\ExpressHome\ssge-relay.log

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA "ExpressHome"
$log = Join-Path $logDir "ssge-relay.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# One instance only.
$mutex = New-Object System.Threading.Mutex($false, "Global\ExpressHomeSsgeTokenRelay")
if (-not $mutex.WaitOne(0)) { exit 0 }

Set-Location $repo
while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
    Move-Item -Force $log "$log.1"
  }
  "$(Get-Date -Format s) launcher: starting relay" | Add-Content $log
  & npx --no tsx scripts/ssge-token-relay.ts 2>&1 | ForEach-Object { "$_" } | Add-Content $log
  "$(Get-Date -Format s) launcher: relay exited, restarting in 15s" | Add-Content $log
  Start-Sleep -Seconds 15
}
