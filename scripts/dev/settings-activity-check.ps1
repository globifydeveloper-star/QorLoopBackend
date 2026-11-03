param(
    [Guid]$ProductId = [Guid]::Empty,
    [switch]$ReversibleEdit
)

# PowerShell 5.1. Enter credentials only into this local terminal, never into chat.
# No .env access, credential output, cookie output, real uploads or price-rule edits.
$ErrorActionPreference = 'Stop'
$qorloopApi = 'http://qorloop-demo.localhost:4000'
$qorloopOrigin = 'http://qorloop-demo.localhost:3000'
$qorloopSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$script:qorloopCsrf = $null

function Read-QorloopSecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    try { return (New-Object System.Net.NetworkCredential('', $secure)).Password }
    finally { $secure.Dispose() }
}

function Invoke-Qorloop([string]$Method, [string]$Path, $Body = $null) {
    $headers = @{ Origin = $qorloopOrigin; Accept = 'application/json' }
    if ($script:qorloopCsrf) { $headers['X-CSRF-Token'] = $script:qorloopCsrf }
    $parameters = @{ Uri = $qorloopApi + $Path; Method = $Method; WebSession = $qorloopSession; Headers = $headers; UseBasicParsing = $true; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $parameters['ContentType'] = 'application/json'
        $parameters['Body'] = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 15 -Compress))
    }
    try {
        $response = Invoke-WebRequest @parameters
        return ($response.Content | ConvertFrom-Json).data
    } catch {
        # Never print the original exception, submitted body, cookies or auth response.
        $status = 'network error'
        $requestId = 'unavailable'
        if ($_.Exception.Response) {
            $status = [string][int]$_.Exception.Response.StatusCode
            $requestId = [string]$_.Exception.Response.Headers['X-Request-ID']
        }
        throw "Qorloop request failed ($status). Request ID: $requestId"
    }
}

$qorloopEmail = Read-Host 'Email (local terminal only)'
$qorloopPassword = Read-QorloopSecret 'Password (hidden; do not paste into chat)'
try { $login = Invoke-Qorloop 'POST' '/api/auth/login' @{ email = $qorloopEmail; password = $qorloopPassword } }
finally { $qorloopPassword = $null }
$script:qorloopCsrf = $login.csrfToken
if ($login.state -eq 'mfa_required') {
    $qorloopCode = Read-QorloopSecret 'Authenticator code (hidden; do not paste into chat)'
    try { $login = Invoke-Qorloop 'POST' '/api/auth/mfa/verify' @{ code = $qorloopCode } }
    finally { $qorloopCode = $null }
    $script:qorloopCsrf = $login.csrfToken
}
if ($login.state -ne 'authenticated') { throw 'Complete MFA enrollment in the app, then rerun this check.' }

try {
    $sessionState = Invoke-Qorloop 'GET' '/api/auth/session'
    Write-Output ('Session: ' + $sessionState.state + '; next action: ' + $sessionState.nextAction)
    $settings = Invoke-Qorloop 'GET' '/api/settings'
    Write-Output 'Settings (Asia/Qatar and QAR are read-only):'
    Write-Output ($settings | ConvertTo-Json -Depth 15)
    Write-Output 'Enabled marketplaces and applied-upload ages:'
    Write-Output ((Invoke-Qorloop 'GET' '/api/settings/marketplaces') | ConvertTo-Json -Depth 10)
    Write-Output 'Latest activity:'
    Write-Output ((Invoke-Qorloop 'GET' '/api/activity?limit=5') | ConvertTo-Json -Depth 15)
    Write-Output 'Price activity:'
    Write-Output ((Invoke-Qorloop 'GET' '/api/activity?eventType=price&limit=5') | ConvertTo-Json -Depth 15)

    if ($ProductId -eq [Guid]::Empty) {
        $products = Invoke-Qorloop 'GET' '/api/products?limit=1'
        if ($products.items.Count -gt 0) { $ProductId = [Guid]$products.items[0].id }
    }
    if ($ProductId -ne [Guid]::Empty) {
        Write-Output ('History for product ' + $ProductId.ToString() + ':')
        Write-Output ((Invoke-Qorloop 'GET' ('/api/products/' + $ProductId.ToString() + '/history?limit=5')) | ConvertTo-Json -Depth 15)
    } else { Write-Output 'No product exists; product history check skipped.' }

    if ($ReversibleEdit) {
        $settings = Invoke-Qorloop 'GET' '/api/settings'
        $originalHours = [int]$settings.thresholds.staleHours
        $nextHours = $originalHours + 1
        if ($originalHours -ge 8760) { $nextHours = 8759 }
        $edited = $null
        try {
            $edited = Invoke-Qorloop 'PUT' '/api/settings' @{ expectedRevision = $settings.revision; thresholds = @{ staleHours = $nextHours } }
            if ([int]$edited.thresholds.staleHours -ne $nextHours) { throw 'Edited stale-hours value did not match.' }
            Write-Output ('Reversible edit verified: staleHours ' + $originalHours + ' -> ' + $nextHours)
        } finally {
            if ($null -ne $edited) {
                try {
                    $restored = Invoke-Qorloop 'PUT' '/api/settings' @{ expectedRevision = $edited.revision; thresholds = @{ staleHours = $originalHours } }
                    if ([int]$restored.thresholds.staleHours -ne $originalHours) { throw 'Restored value did not match.' }
                    Write-Output ('Restored staleHours: ' + $originalHours)
                } catch {
                    Write-Warning ('Automatic revert could not be confirmed. Original staleHours was ' + $originalHours + '. Reload Settings and restore it; a concurrent edit may have occurred.')
                    throw 'Settings revert needs attention. No concurrent setting was overwritten.'
                }
            }
        }
    }
} finally {
    try { $null = Invoke-Qorloop 'POST' '/api/auth/logout' } catch { Write-Warning 'Check session completed; logout could not be confirmed.' }
    $login = $null
    $script:qorloopCsrf = $null
    $qorloopSession = $null
}
