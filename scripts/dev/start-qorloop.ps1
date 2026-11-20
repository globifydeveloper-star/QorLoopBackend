# Starts everything Qorloop needs on this PC, each in its own window, skipping what already runs.
# Usage: right-click > Run with PowerShell, or: powershell -ExecutionPolicy Bypass -File start-qorloop.ps1
# Optional: -SkipFrontend   (do not start Vite)
param(
    [ValidatePattern('^[a-z][a-z0-9-]{1,61}[a-z0-9]$')][string]$Store = 'qorloop-demo',
  [string]$Backend  = 'D:\Qorloop-backend',
  [string]$Frontend = 'D:\Qorloop',
  [string]$Weed     = 'C:\SeaweedFS\weed.exe',
  [string]$WeedData = 'D:\SeaweedFS\data',
  [string]$Mailpit  = 'C:\Mailpit\mailpit.exe',
  [switch]$SkipFrontend
)

$ErrorActionPreference = 'Continue'

function Test-Port([int]$Port) {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

function Start-Window([string]$Title, [string]$Command) {
  $full = "`$host.UI.RawUI.WindowTitle = '$Title'; $Command"
  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-Command', $full | Out-Null
  Write-Host "  started: $Title"
}

function Test-NodeCommand([string]$Pattern) {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -like $Pattern }
  return [bool]$p
}

Write-Host '1. Windows services (PostgreSQL, Memurai)'
foreach ($pattern in @('postgresql*', 'Memurai*')) {
  $svc = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like $pattern }
  if (-not $svc) { Write-Host "  WARNING: no service matching $pattern found"; continue }
  foreach ($s in $svc) {
    if ($s.Status -ne 'Running') {
      Write-Host "  $($s.Name) is $($s.Status); starting (needs an Administrator window)"
      try { Start-Service -Name $s.Name -ErrorAction Stop } catch { Write-Host "  could not start $($s.Name): run this script as Administrator once" }
    } else { Write-Host "  $($s.Name): running" }
  }
}

Write-Host '2. SeaweedFS (file storage, port 8333)'
if (Test-Port 8333) { Write-Host '  already running' }
elseif (-not (Test-Path $Weed)) { Write-Host "  NOT FOUND: $Weed" }
else { Start-Window 'Qorloop SeaweedFS' "& '$Weed' mini ('-dir=' + '$WeedData')"; Start-Sleep -Seconds 6 }

Write-Host '3. Mailpit (test inbox, http://127.0.0.1:8025)'
if (Test-Port 8025) { Write-Host '  already running' }
elseif (-not (Test-Path $Mailpit)) { Write-Host "  NOT FOUND: $Mailpit" }
else { Start-Window 'Qorloop Mailpit' "Set-Location '$(Split-Path $Mailpit)'; .\mailpit.exe --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025"; Start-Sleep -Seconds 2 }

Write-Host '4. API (port 4000)'
if (Test-Port 4000) { Write-Host '  already running' }
else { Start-Window 'Qorloop API' "Set-Location '$Backend'; npm run dev"; Start-Sleep -Seconds 3 }

Write-Host '5. Worker (background jobs)'
if (Test-NodeCommand '*worker*main.ts*') { Write-Host '  already running' }
else { Start-Window 'Qorloop Worker' "Set-Location '$Backend'; npm run dev:worker"; Start-Sleep -Seconds 2 }

if (-not $SkipFrontend) {
  Write-Host '6. Frontend (port 3000)'
  if (Test-Port 3000) { Write-Host '  already running' }
  else { Start-Window 'Qorloop Frontend' "Set-Location '$Frontend'; npm run dev" }
}

Write-Host ''
Write-Host 'Waiting for the API to answer (up to 90 seconds)...'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  $code = & curl.exe -s -o NUL -w '%{http_code}' "http://$Store.localhost:4000/health/ready" 2>$null
  if ($code -eq '200') { $ok = $true; break }
  Start-Sleep -Seconds 3
}
if ($ok) {
  Write-Host "READY: http://$Store.localhost:3000" -ForegroundColor Green
  Start-Process "http://$Store.localhost:3000"
} else {
  Write-Host 'The API did not answer. Look at the "Qorloop API" window for the error.' -ForegroundColor Yellow
}
