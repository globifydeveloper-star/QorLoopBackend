param(
    [string]$Marketplace = 'talabat'
)

# PowerShell 5.1. READ-ONLY checks of ERP change review and catalogue stock (ADR 017) on the demo store.
# Enter credentials only into this local terminal, never into chat. No .env access; no credential, cookie or token output.
# Only GET requests, apart from signing in and out. Needs migration 202611060001_erp_changes_catalogue_stock applied.
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
    # 1. The latest applied ERP upload and what it changed.
    $erp = @(Invoke-Qorloop 'GET' '/api/uploads' | Where-Object { $_.source -eq 'erp' -and $_.status -eq 'applied' }) | Select-Object -First 1
    if ($null -eq $erp) { Write-Output 'No applied ERP upload on this store.' }
    else {
        $changes = Invoke-Qorloop 'GET' ('/api/uploads/' + $erp.id + '/changes?pageSize=10')
        Write-Output ('== Latest applied ERP upload "' + $erp.fileName + '" applied ' + $erp.appliedAt + '; changesRecorded=' + $changes.changesRecorded)
        Write-Output ('   counts: ' + (($changes.counts.PSObject.Properties | ForEach-Object { $_.Name + '=' + $_.Value }) -join ', '))
        foreach ($r in @($changes.rows)) {
            Write-Output ('   row ' + $r.rowNumber + ' ' + $r.barcode + ' ' + $r.kind + ' ' + $r.field + ': ' + $r.old + ' -> ' + $r.new + $(if ($r.stockConflict) { '  [STOCK CONFLICT]' } else { '' }) + $(if ($r.fixedPriceRule) { '  [fixed price still applies]' } else { '' }))
        }
        if (-not $changes.changesRecorded) { Write-Output '   note: applied before ADR 017; apply a new ERP file to record a change list.' }
        $s = $erp.summary
        Write-Output ('   review summary: price=' + $s.priceChanges + ' stock=' + $s.stockChanges + ' name=' + $s.nameChanges + ' cost=' + $s.costChanges + ' predictedConflicts=' + $s.stockConflicts + ' new=' + $s.newProducts + ' missing=' + $s.missingFromFile)
    }

    # 2. Open stock conflicts: the dashboard badge and the first page.
    $count = Invoke-Qorloop 'GET' '/api/catalogue/stock/conflicts/count'
    $conflicts = Invoke-Qorloop 'GET' '/api/catalogue/stock/conflicts?pageSize=10'
    Write-Output ('== Stock conflicts: ' + $count.count + ' (value in effect while open: ' + $conflicts.inEffect + ')')
    foreach ($c in @($conflicts.rows)) {
        Write-Output ('   ' + $c.barcode + ' "' + $c.nameEn + '": owner ' + $c.ownerStock + ' (set against ERP ' + $c.erpStockAtEdit + ') vs ERP now ' + $c.erpStock + '; in effect ' + $c.catalogueStock)
    }
    $summary = Invoke-Qorloop 'GET' '/api/recon/summary'
    if ($summary.stockConflicts -ne $count.count) { throw 'FAIL: recon summary stockConflicts differs from the conflict count.' }

    # 3. Recon rows: catalogue stock next to ERP stock, each reference's stock issue.
    $rows = Invoke-Qorloop 'GET' ('/api/recon/rows?marketplaceId=' + $Marketplace + '&type=stock&limit=10')
    Write-Output ('== ' + $Marketplace + ' stock issues (reference ' + $rows.reference + ', urgent first)')
    foreach ($r in @($rows.items)) {
        Write-Output ('   ' + $r.barcode + ' ERP stock ' + $r.erpStock + ' / catalogue stock ' + $r.catalogueStock + ' (' + $r.catalogueStockSource + ')' + '; vs catalogue: ' + $r.stockIssueVsCatalogue + '; vs ERP: ' + $r.stockIssueVsErp + '; listed available: ' + $r.actualAvailable)
    }
    Write-Output 'PASS: catalogue stock endpoints answered (read-only).'
} finally {
    try { [void](Invoke-Qorloop 'POST' '/api/auth/logout') } catch { Write-Output 'Sign-out failed; the session expires on its own.' }
}
