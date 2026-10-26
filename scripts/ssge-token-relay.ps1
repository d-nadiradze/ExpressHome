# Windows launcher for the ss.ge token relay: keeps scripts/ssge-token-relay.ts
# running, restarting it if it exits, and appends its output to a log file.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ssge-token-relay.ps1
#
# Register it (no admin needed) to start at logon AND re-check every 5 minutes;
# the mutex below makes a duplicate exit at once, so the repeat is a watchdog:
#   powershell -ExecutionPolicy Bypass -File scripts\ssge-token-relay.ps1 -Install
#
# Log: %LOCALAPPDATA%\ExpressHome\ssge-relay.log

param([switch]$Install)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA "ExpressHome"
$log = Join-Path $logDir "ssge-relay.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if ($Install) {
  $taskName = "ExpressHome ss.ge token relay"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # Re-fire every 5 min indefinitely; a live instance holds the mutex and the
  # newcomer exits, so this only matters after a crash or Ctrl+C.
  $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Registered and started task '$taskName' (logon + every 5 min watchdog). Log: $log"
  exit 0
}

# Ctrl+C / console close must not take the launcher down with the child.
try { [Console]::TreatControlCAsInput = $true } catch {}

# One instance only.
$mutex = New-Object System.Threading.Mutex($false, "Global\ExpressHomeSsgeTokenRelay")
if (-not $mutex.WaitOne(0)) { exit 0 }

Set-Location $repo
while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
    Move-Item -Force $log "$log.1"
  }
  "$(Get-Date -Format s) launcher: starting relay" | Add-Content $log
  # cmd's append-redirect shares the file for reading, so the log can be
  # tailed while the relay runs (a PowerShell pipeline would hold it locked).
  & cmd /c "npx --no tsx scripts/ssge-token-relay.ts >> `"$log`" 2>&1"
  "$(Get-Date -Format s) launcher: relay exited, restarting in 15s" | Add-Content $log
  Start-Sleep -Seconds 15
}
