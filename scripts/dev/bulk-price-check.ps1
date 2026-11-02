# Real-data check of the bulk price change (ADR 013) on the demo store. Preview only, unless -Apply is given.
#   powershell -ExecutionPolicy Bypass -File scripts\dev\bulk-price-check.ps1 [-Marketplace talabat] [-Count 5] [-Apply]
# Picks the first -Count price mismatches (Marketplace reference) on -Marketplace, previews "match marketplace price"
# for them and, with -Apply, applies it, replays the same idempotency key, and waits for the recompute.
# Before applying it saves each product's current own rule to -RevertFile (bulk-price-revert.ps1 restores them).
param(
    [string]$ApiBase = 'http://qorloop-demo.localhost:4000',
    [string]$Origin = 'http://qorloop-demo.localhost:3000',
    [ValidateSet('talabat', 'snoonu', 'rafeeq', 'keeta')][string]$Marketplace = 'talabat',
    [ValidateRange(1, 50)][int]$Count = 5,
    [string]$RevertFile = 'D:\Qorloop-test\bulk-price-revert.json',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$session = $null
$csrf = $null

function Read-HiddenText([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); $secure.Dispose() }
}
function Api([string]$Method, [string]$Path, $Payload = $null) {
    $a = @{ Method = $Method; Uri = "$ApiBase$Path"; WebSession = $session; Headers = @{ Origin = $Origin; 'X-CSRF-Token' = $csrf }; ErrorAction = 'Stop' }
    if ($null -ne $Payload) { $a.ContentType = 'application/json'; $a.Body = ConvertTo-Json -InputObject $Payload -Compress -Depth 10 }
    try { return Invoke-RestMethod @a }
    catch {
        # error code and message only (never cookies or request bodies)
        $code = $_.Exception.Response.StatusCode.value__
        $msg = try { ($_.ErrorDetails.Message | ConvertFrom-Json).error.message } catch { '' }
        throw "API $Method $Path failed: HTTP $code $msg"
    }
}
function PriceIssues() {
    $s = Api 'GET' '/api/recon/summary?reference=marketplace'
    $m = @{}
    foreach ($x in $s.data.marketplaces) { $m[$x.marketplaceId] = $x.price }
    return @{ computedAt = $s.data.computedAt; byMarketplace = $m }
}

try {
    $email = Read-Host 'Email (Owner, Admin or Catalogue Manager)'
    $loginBody = @{ email = $email; password = (Read-HiddenText 'Password') } | ConvertTo-Json -Compress
    try {
        $login = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/login" -Headers @{ Origin = $Origin } -ContentType 'application/json' -Body $loginBody -SessionVariable session
    } catch { throw 'Login failed. Response details suppressed.' }
    $loginBody = $null
    $csrf = $login.data.csrfToken
    if ($login.data.state -eq 'mfa_required') {
        $code = Read-Host 'Authenticator code (6 digits)'
        $verified = Api 'POST' '/api/auth/mfa/verify' @{ code = $code }
        $csrf = $verified.data.csrfToken
        if ($verified.data.state -ne 'authenticated') { throw 'MFA verification did not complete.' }
    } elseif ($login.data.state -ne 'authenticated') { throw "Login state is $($login.data.state); finish MFA enrolment in the app first." }

    $before = PriceIssues
    Write-Host ("Recon (Marketplace reference) price issues before: {0}  computedAt={1}" -f (($before.byMarketplace.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '), $before.computedAt)

    $rows = Api 'GET' "/api/recon/rows?marketplaceId=$Marketplace&type=price&reference=marketplace&limit=$Count"
    $ids = @($rows.data.items | ForEach-Object { $_.productId })
    if ($ids.Count -eq 0) { throw "No price mismatches on $Marketplace against the Marketplace reference; try another -Marketplace." }
    Write-Host ("Selected {0} price mismatches on {1}" -f $ids.Count, $Marketplace)

    $body = @{ marketplaceId = $Marketplace; selection = @{ productIds = $ids }; action = @{ type = 'match_marketplace' } }
    $p = (Api 'POST' '/api/pricing/bulk/preview' $body).data
    Write-Host ("Preview: selected={0} willChange={1} unchanged={2} blocked={3}" -f $p.selected, $p.willChange, $p.unchanged, $p.blocked)
    foreach ($b in $p.blockedReasons) { Write-Host ("  blocked {0}: {1}" -f $b.count, $b.message) }
    foreach ($o in $p.otherMarketplaces) { Write-Host ("  also moves on {0}: {1} products" -f $o.marketplaceId, $o.products) }
    foreach ($r in $p.rows) { Write-Host ("  {0} {1}: {2} ({3}) -> {4}" -f $r.barcode, $r.nameEn, $r.oldPrice, $r.oldSource, $r.newPrice) }
    if (-not $Apply) { Write-Host 'Preview only: nothing written. Run again with -Apply to apply.'; return }
    if ($p.willChange -eq 0) { Write-Host 'Nothing would change; not applying.'; return }

    # Revert data first: every selected product's current own rule (null = none).
    $revert = foreach ($id in $ids) {
        $d = (Api 'GET' "/api/products/$id").data
        $rule = $d.pricing.productRule
        [pscustomobject]@{ productId = $id; rule = if ($null -eq $rule) { $null } else { [pscustomobject]@{ mode = $rule.mode; value = $rule.value } } }
    }
    $null = New-Item -ItemType Directory -Path (Split-Path $RevertFile) -Force
    ConvertTo-Json -InputObject @($revert) -Depth 5 | Set-Content -Path $RevertFile -Encoding utf8
    Write-Host "Saved the current rules to $RevertFile"

    $key = [guid]::NewGuid().ToString()
    $applied = (Api 'POST' '/api/pricing/bulk/apply' ($body + @{ idempotencyKey = $key; previewToken = $p.previewToken })).data
    Write-Host ("Applied: operationId={0} willChange={1} created={2} replaced={3} replayed={4}" -f $applied.operationId, $applied.willChange, $applied.created, $applied.replaced, $applied.replayed)
    $again = (Api 'POST' '/api/pricing/bulk/apply' ($body + @{ idempotencyKey = $key })).data
    Write-Host ("Same key again: replayed={0} operationId={1} (expected True and the same id)" -f $again.replayed, $again.operationId)

    $after = $null
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        $after = PriceIssues
        if ($after.computedAt -and ([datetime]$after.computedAt) -gt ([datetime]$applied.appliedAt)) { break }
    }
    if (-not ($after.computedAt -and ([datetime]$after.computedAt) -gt ([datetime]$applied.appliedAt))) { throw 'No recompute after 3 minutes: is the worker running (npm run dev:worker)?' }
    $expected = $before.byMarketplace[$Marketplace] - $applied.willChange
    Write-Host ("Recon after: {0}  computedAt={1}" -f (($after.byMarketplace.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '), $after.computedAt)
    Write-Host ("{0} price issues: {1} -> {2} (expected {3}) {4}" -f $Marketplace, $before.byMarketplace[$Marketplace], $after.byMarketplace[$Marketplace], $expected, $(if ($after.byMarketplace[$Marketplace] -eq $expected) { 'OK' } else { 'DIFFERENT: another change ran meanwhile?' }))
} finally {
    if ($null -ne $session -and $csrf) { try { $null = Api 'POST' '/api/auth/logout' } catch { } }
    $csrf = $null; $session = $null; $login = $null; $verified = $null
}
