# Stops the Qorloop dev servers (API, worker, Vite), Mailpit and SeaweedFS.
# It does NOT stop PostgreSQL or Memurai (they are Windows services).
# Usage: powershell -ExecutionPolicy Bypass -File stop-qorloop.ps1

Write-Host 'Stopping Qorloop node processes (API, worker, Vite)...'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like '*Qorloop*' }
foreach ($p in $procs) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host "  stopped node $($p.ProcessId)" } catch {}
}

Write-Host 'Stopping Mailpit...'
Stop-Process -Name mailpit -ErrorAction SilentlyContinue

Write-Host 'Stopping SeaweedFS (gently)...'
Stop-Process -Name weed -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2
Write-Host 'Done. Close the leftover PowerShell windows if any remain.'
Write-Host 'Ports 3000 and 4000 should now be free:'
Get-NetTCPConnection -LocalPort 3000, 4000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess

