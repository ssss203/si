# Launch the packaged build and prove it actually reached runtime-ready.
# Usage: powershell -NoProfile -File tools/verify-dist.ps1 -Exe "release\win-unpacked\pet.exe" -WaitSeconds 12
# (ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI,
#  so CJK text in this file would break parsing. The data dir name is built from its codepoint.)
#
# Two traps this script handles for you:
#   1. ELECTRON_RUN_AS_NODE=1 in the parent environment turns the app exe into plain Node:
#      it runs, prints nothing, and exits 0 -- looks like a silent failure. Always clear it.
#   2. The app holds a single-instance lock. A leftover process from an earlier run makes the
#      new one exit immediately with code 0. Kill stragglers first.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$WaitSeconds = 12,
  [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'

# trap 1: Electron must not be launched as Node
if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE
  Write-Host 'NOTE: cleared ELECTRON_RUN_AS_NODE from the environment'
}

$petName = [string][char]0x8086                       # the pet's name, one CJK char
$dataRoot = Join-Path $env:APPDATA $petName           # %APPDATA%\<pet>
$log = Join-Path $dataRoot 'logs\app.jsonl'

# trap 2: no leftover instance may hold the single-instance lock
$stragglers = @(Get-Process | Where-Object { $_.ProcessName -eq $petName })
if ($stragglers.Count -gt 0) {
  Write-Host "NOTE: stopping $($stragglers.Count) leftover process(es) holding the single-instance lock"
  $stragglers | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

$before = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
Write-Host "LOG=$log baselineLines=$before"

$proc = Start-Process -FilePath $Exe -PassThru
Write-Host "STARTED pid=$($proc.Id)"

Start-Sleep -Seconds $WaitSeconds
$alive = -not $proc.HasExited
Write-Host "ALIVE_AFTER_${WaitSeconds}s=$alive"
if (-not $alive) { Write-Host "EXIT_CODE=$($proc.ExitCode)" }

Start-Sleep -Seconds 5
$alive2 = -not $proc.HasExited
Write-Host "ALIVE_AFTER_$($WaitSeconds + 5)s=$alive2"
if (-not $alive2) { Write-Host "EXIT_CODE=$($proc.ExitCode)" }

$all = if (Test-Path $log) { Get-Content $log } else { @() }
Write-Host "LOG_LINES_NOW=$($all.Count)"
$new = if ($all.Count -gt $before) { $all[$before..($all.Count - 1)] } else { @() }
Write-Host "NEW_LOG_LINES=$($new.Count)"
$ready = $new | Where-Object { $_ -like '*runtime-ready*' }
if ($ready) {
  Write-Host 'RUNTIME_READY=yes'
  $ready | Select-Object -Last 1
} else {
  Write-Host 'RUNTIME_READY=no'
  $new | Select-Object -Last 20
}

if (-not $KeepRunning) {
  Get-Process | Where-Object { $_.ProcessName -eq $petName } | ForEach-Object {
    Write-Host "STOPPING pid=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3
  $left = @(Get-Process | Where-Object { $_.ProcessName -eq $petName })
  Write-Host "LEFTOVER_PROCESSES=$($left.Count)"
}
Write-Host 'VERIFY_DONE'
