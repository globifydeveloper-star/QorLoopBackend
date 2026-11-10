param(
    [string]$Marketplace = 'talabat'
)
# PowerShell 5.1. READ-ONLY checks of the catalogue product list with marketplace values (docs/products-api.md).
# Enter credentials only into this local terminal, never into chat. No .env access; no credential, cookie or token output.
# Only GET requests, apart from signing in and out. No migration needed.
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
        throw "Qorloop request failed ($status) for $Method $Path. Request ID: $requestId"
    }
}

$qorloopEmail = Read-Host 'Email (any role; local terminal only)'
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
    # 1. Without marketplaceId the list is unchanged: no marketplace object.
    $plain = Invoke-Qorloop 'GET' '/api/products?limit=5'
    if (@($plain.items | Where-Object { $null -ne $_.marketplace }).Count -gt 0) { throw 'FAIL: marketplace object present without marketplaceId.' }
    Write-Output ('== Catalogue: ' + $plain.counts.all + ' products')

    # 2. With marketplaceId: every item carries the marketplace object with exactly these keys.
    $expected = 'available,comparison,inFile,marketplaceId,price,priceIssue,reference,sourceUploadedAt,stockIssue'
    $page = Invoke-Qorloop 'GET' ('/api/products?limit=20&marketplaceId=' + $Marketplace)
    foreach ($i in @($page.items)) {
        $keys = (($i.marketplace.PSObject.Properties | ForEach-Object { $_.Name }) | Sort-Object) -join ','
        if ($keys -ne $expected) { throw ('FAIL: unexpected marketplace keys for ' + $i.barcode + ': ' + $keys) }
        if (-not $i.marketplace.inFile -and ($null -ne $i.marketplace.price -or $null -ne $i.marketplace.available)) { throw ('FAIL: values for a product not in the file: ' + $i.barcode) }
    }
    if ($page.counts.all -ne $plain.counts.all) { throw 'FAIL: marketplaceId alone changed the counts.' }
    $first = @($page.items) | Select-Object -First 1
    $reference = if ($first) { $first.marketplace.reference } else { 'n/a' }
    Write-Output ('== ' + $Marketplace + ' (reference ' + $reference + '), first ' + @($page.items).Count + ' products')
    foreach ($i in @($page.items) | Select-Object -First 10) {
        $m = $i.marketplace
        Write-Output ('   ' + $i.barcode + ' "' + $i.nameEn + '": ' + $m.comparison + '; in file ' + $m.inFile + '; available ' + $m.available + '; price ' + $m.price + '; stock ' + $m.stockIssue + '; price issue ' + $m.priceIssue + '; file uploaded ' + $m.sourceUploadedAt)
    }

    # 3. Each filter: every item has that comparison; the three counts never exceed the catalogue.
    $total = 0
    foreach ($status in @('mismatch', 'in_sync', 'not_in_file')) {
        $f = Invoke-Qorloop 'GET' ('/api/products?limit=50&marketplaceId=' + $Marketplace + '&marketplaceStatus=' + $status)
        if (@($f.items | Where-Object { $_.marketplace.comparison -ne $status }).Count -gt 0) { throw ('FAIL: marketplaceStatus=' + $status + ' returned another comparison.') }
        $total += $f.counts.all
        Write-Output ('   ' + $status + ': ' + $f.counts.all + ' products')
    }
    if ($total -gt $plain.counts.all) { throw 'FAIL: filtered counts add up to more than the catalogue.' }
    Write-Output ('   not_applicable (new, no upload, not recomputed): ' + ($plain.counts.all - $total))
    Write-Output 'PASS: catalogue marketplace columns answered (read-only).'
} finally {
    try { [void](Invoke-Qorloop 'POST' '/api/auth/logout') } catch { Write-Output 'Sign-out failed; the session expires on its own.' }
}
