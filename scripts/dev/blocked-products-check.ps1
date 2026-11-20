# Run from the repo root: powershell -File scripts/dev/blocked-products-check.ps1
# PowerShell 5.1. READ-ONLY checks of blocked products (docs/products-api.md, "Blocked products"). Needs migration 202611170001.
# Enter credentials only into this local terminal, never into chat. No .env access; no credential, cookie or token output.
# Only GET requests and one block PREVIEW (writes nothing), apart from signing in and out.
param([ValidatePattern('^[a-z][a-z0-9-]{1,61}[a-z0-9]$')][string]$Store = 'qorloop-demo')
$ErrorActionPreference = 'Stop'
$qorloopApi = "http://$Store.localhost:4000"
$qorloopOrigin = "http://$Store.localhost:3000"
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
        throw "Qorloop request failed ($status) for $Method $Path. Request ID: $requestId"
    }
}

$qorloopEmail = Read-Host 'Email (Owner, Admin or Catalogue Manager: the preview needs products.block; local terminal only)'
$qorloopPassword = Read-QorloopSecret 'Password (hidden; do not paste into chat)'
try { $login = Invoke-Qorloop 'POST' '/api/auth/login' @{ email = $qorloopEmail; password = $qorloopPassword } }
finally { $qorloopPassword = $null }
$script:qorloopCsrf = $login.csrfToken
if ($login.state -eq 'mfa_required') {
    $qorloopCode = Read-QorloopSecret 'Authenticator code (hidden; do not paste into chat)'
    try { $login = Invoke-Qorloop 'POST' '/api/auth/mfa/verify' @{ code = $qorloopCode } }
    finally { $qorloopCode = $null }
    $script:qorloopCsrf = $login.csrfToken

try {
    # 1. Default list (blocked=exclude): no blocked item; counts.blocked is the Blocked tab number.
    $plain = Invoke-Qorloop 'GET' '/api/products?limit=50'
    if ($null -eq $plain.counts.blocked) { throw 'FAIL: counts.blocked missing (is the API on feature/blocked-products, migration applied?).' }
    if (@($plain.items | Where-Object { $_.isBlocked }).Count -gt 0) { throw 'FAIL: a blocked product in the default list.' }
    Write-Output ('== Catalogue (blocked excluded): ' + $plain.counts.all + ' products; blocked: ' + $plain.counts.blocked)

    # 2. blocked=only: every item blocked, with a reason; counts.all equals counts.blocked.
    $only = Invoke-Qorloop 'GET' '/api/products?limit=50&blocked=only'
    if (@($only.items | Where-Object { -not $_.isBlocked -or -not $_.blockedReason }).Count -gt 0) { throw 'FAIL: blocked=only returned an unblocked item or one without a reason.' }
    if ($only.counts.all -ne $plain.counts.blocked) { throw 'FAIL: the Blocked tab count differs from counts.blocked.' }

    # 3. blocked=include: the two add up.
    $all = Invoke-Qorloop 'GET' '/api/products?limit=1&blocked=include'
    if ($all.counts.all -ne ($plain.counts.all + $only.counts.all)) { throw 'FAIL: include is not exclude + only.' }
    Write-Output ('   blocked=only: ' + $only.counts.all + '; blocked=include: ' + $all.counts.all)

    # 4. A block PREVIEW of the first listed products (writes nothing).
    $ids = @($plain.items | Select-Object -First 3 | ForEach-Object { $_.id })
    if ($ids.Count -gt 0) {
        $p = Invoke-Qorloop 'POST' '/api/products/block/preview' @{ productIds = $ids; reason = 'other' }
        Write-Output ('   preview of ' + $ids.Count + ': toBlock ' + $p.toBlock + ', alreadyBlocked ' + $p.alreadyBlocked + ', active offers to end ' + $p.activeOffersToEnd)
        $again = Invoke-Qorloop 'GET' '/api/products?limit=1'
        if ($again.counts.blocked -ne $plain.counts.blocked) { throw 'FAIL: the preview changed the blocked count.' }
    }
    Write-Output 'PASS: blocked products answered (read-only).'
} finally {
    try { [void](Invoke-Qorloop 'POST' '/api/auth/logout') } catch { Write-Output 'Sign-out failed; the session expires on its own.' }
}
