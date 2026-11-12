# Read-only check of "copy from marketplace" on the demo store: previews copying -Source's current values into
# -Target's export values for the whole Review list (show=all), and prints the counts and the first rows. Nothing is
# written: only POST /api/marketplace-values/bulk/preview is called (it reads only), then the session logs out.
#   powershell -ExecutionPolicy Bypass -File scripts\dev\copy-from-marketplace-check.ps1 [-Target talabat] [-Source snoonu] [-Fields price,availability]
param(
    [string]$ApiBase = 'http://qorloop-demo.localhost:4000',
    [string]$Origin = 'http://qorloop-demo.localhost:3000',
    [ValidateSet('talabat', 'snoonu', 'rafeeq', 'keeta')][string]$Target = 'talabat',
    [ValidateSet('talabat', 'snoonu', 'rafeeq', 'keeta')][string]$Source = 'snoonu',
    [ValidateSet('price', 'availability')][string[]]$Fields = @('price', 'availability')
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
        $details = try { (($_.ErrorDetails.Message | ConvertFrom-Json).error.details | ForEach-Object { $_.message }) -join '; ' } catch { '' }
        throw "API $Method $Path failed: HTTP $code $msg $details"
    }
}
function Show([string]$Label, $Value) { if ($null -eq $Value) { '-' } else { "$Label$Value" } }

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

    $body = @{ marketplaceId = $Target; selection = @{ filter = @{ show = 'all' } }
               action = @{ type = 'copy_from_marketplace'; sourceMarketplaceId = $Source; fields = @($Fields) } }
    $p = (Api 'POST' '/api/marketplace-values/bulk/preview' $body).data
    Write-Host ("Copy {0} from {1} into {2} (reason: {3})" -f ($Fields -join '+'), $Source, $Target, $p.reason)
    Write-Host ("Source file: {0}  applied {1}" -f $p.source.latestFile.fileName, $p.source.latestFile.appliedAt)
    Write-Host ("selected={0} willChange={1} unchanged={2} blocked={3} notOnSource={4} pinnedKept={5} fromOlderFile={6}" -f
        $p.selected, $p.willChange, $p.unchanged, $p.blocked, $p.notOnSource, $p.pinnedKept, $p.fromOlderFile)
    $sum = $p.willChange + $p.unchanged + $p.blocked + $p.notOnSource + $p.pinnedKept
    Write-Host ("Counts add up to selected: {0}" -f $(if ($sum -eq $p.selected) { 'OK' } else { "NO ($sum)" }))
    foreach ($b in $p.blockedByReason) { Write-Host ("  blocked {0}: {1}" -f $b.count, $b.label) }
    foreach ($b in $p.notOnSourceByReason) { Write-Host ("  not on source {0}: {1}" -f $b.count, $b.label) }
    foreach ($r in $p.rows) {
        $changes = ($r.changes | ForEach-Object { "{0}: {1} -> {2}" -f $_.field, (Show '' $_.before.value), $_.after.value }) -join ', '
        $older = if ($r.source.isLatestFile) { '' } else { ' (older file)' }
        Write-Host ("  {0} {1}: {2}  [from {3}{4}]" -f $r.barcode, $r.nameEn, $changes, $r.source.fileName, $older)
    }
    Write-Host 'Preview only: nothing was written.'
} finally {
    if ($null -ne $session -and $csrf) { try { $null = Api 'POST' '/api/auth/logout' } catch { } }
    $csrf = $null; $session = $null; $login = $null; $verified = $null
}
