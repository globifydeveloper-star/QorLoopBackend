# Restores the product rules saved by bulk-price-check.ps1 -Apply, through the existing audited endpoints
# (PUT/DELETE /api/products/:id/price-rule, any rule mode); each change queues the coalesced recon recompute.
#   powershell -ExecutionPolicy Bypass -File scripts\dev\bulk-price-revert.ps1 [-RevertFile D:\Qorloop-test\bulk-price-revert.json]
param(
    [string]$ApiBase = 'http://qorloop-demo.localhost:4000',
    [string]$Origin = 'http://qorloop-demo.localhost:3000',
    [string]$RevertFile = 'D:\Qorloop-test\bulk-price-revert.json',
    # Only queue a recon recompute (POST /api/recon/recompute), e.g. after scripts\dev\db-backup.ps1 -RestoreRulesFrom.
    [switch]$RecomputeOnly
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
        $code = $_.Exception.Response.StatusCode.value__
        $msg = try { ($_.ErrorDetails.Message | ConvertFrom-Json).error.message } catch { '' }
        throw "API $Method $Path failed: HTTP $code $msg"
    }
}

$saved = if ($RecomputeOnly) { @() } else { @(Get-Content -Path $RevertFile -Raw -Encoding utf8 | ConvertFrom-Json) }
try {
    $email = Read-Host 'Email (Owner, Admin or Catalogue Manager)'
    $loginBody = @{ email = $email; password = (Read-HiddenText 'Password') } | ConvertTo-Json -Compress
    try {
        $login = Invoke-RestMethod -Method Post -Uri "$ApiBase/api/auth/login" -Headers @{ Origin = $Origin } -ContentType 'application/json' -Body $loginBody -SessionVariable session
    } catch { throw 'Login failed. Response details suppressed.' }
    $loginBody = $null
    $csrf = $login.data.csrfToken
    if ($login.data.state -eq 'mfa_required') {
        $verified = Api 'POST' '/api/auth/mfa/verify' @{ code = (Read-Host 'Authenticator code (6 digits)') }
        $csrf = $verified.data.csrfToken
        if ($verified.data.state -ne 'authenticated') { throw 'MFA verification did not complete.' }
    } elseif ($login.data.state -ne 'authenticated') { throw "Login state is $($login.data.state)." }

    if ($RecomputeOnly) {
        $null = Api 'POST' '/api/recon/recompute'
        Write-Host 'Recon recompute queued; the summary updates once the worker has run it.'
        return
    }
    $restored = 0; $removed = 0
    foreach ($s in $saved) {
        if ($null -eq $s.rule) {
            try { $null = Api 'DELETE' "/api/products/$($s.productId)/price-rule"; $removed++ }
            catch { if ($_ -notmatch 'HTTP 404') { throw } } # already has no rule
        } else {
            $rule = if ($s.rule.mode -eq 'same') { @{ mode = 'same' } } else { @{ mode = $s.rule.mode; value = $s.rule.value } }
            $null = Api 'PUT' "/api/products/$($s.productId)/price-rule" $rule
            $restored++
        }
    }
    Write-Host ("Reverted {0} products: {1} rules restored, {2} rules removed. The recon recomputes in a few seconds." -f $saved.Count, $restored, $removed)
} finally {
    if ($null -ne $session -and $csrf) { try { $null = Api 'POST' '/api/auth/logout' } catch { } }
    $csrf = $null; $session = $null; $login = $null; $verified = $null
}
