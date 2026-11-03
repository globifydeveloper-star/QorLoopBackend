# Logs in with a web session, then checks onboarding with GET only; never writes demo business data.
# Enter credentials only into the local prompts. Password and authenticator code are hidden.
$ErrorActionPreference = 'Stop'
$qorloopApi = 'http://qorloop-demo.localhost:4000'
$qorloopOrigin = 'http://qorloop-demo.localhost:3000'
$qorloopSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Read-HiddenText([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); $secure.Dispose() }
}

try {
    $qorloopEmail = Read-Host 'Email (Owner or Admin)'
    try {
        $qorloopPassword = Read-HiddenText 'Password'
        $qorloopLoginBody = @{ email = $qorloopEmail; password = $qorloopPassword } | ConvertTo-Json -Compress
        $qorloopLogin = Invoke-RestMethod -Method Post -Uri ($qorloopApi + '/api/auth/login') `
            -WebSession $qorloopSession -Headers @{ Origin = $qorloopOrigin } `
            -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($qorloopLoginBody))
    } catch {
        throw 'Login failed. Response details suppressed.'
    } finally {
        $qorloopPassword = $null
        $qorloopLoginBody = $null
    }
    if ($qorloopLogin.data.state -eq 'mfa_required') {
        try {
            $qorloopCode = Read-HiddenText 'Authenticator code (6 digits)'
            $qorloopVerifyBody = @{ code = $qorloopCode } | ConvertTo-Json -Compress
            $qorloopLogin = Invoke-RestMethod -Method Post -Uri ($qorloopApi + '/api/auth/mfa/verify') `
                -WebSession $qorloopSession -Headers @{ Origin = $qorloopOrigin; 'X-CSRF-Token' = $qorloopLogin.data.csrfToken } `
                -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($qorloopVerifyBody))
        } catch {
            throw 'MFA verification failed. Response details suppressed.'
        } finally {
            $qorloopCode = $null
            $qorloopVerifyBody = $null
        }
    }
    if ($qorloopLogin.data.state -ne 'authenticated') {
        throw 'Login did not complete. Finish MFA enrollment in the app first, then rerun this check.'
    }
    $qorloopLogin = $null
    # Authentication is complete. All remaining HTTP requests are GET; do not log out with a POST.
    try {
        $qorloopResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
            -Uri ($qorloopApi + '/api/onboarding') -WebSession $qorloopSession `
            -Headers @{ Accept = 'application/json' } -ErrorAction Stop
        $qorloopProgress = ($qorloopResponse.Content | ConvertFrom-Json).data
    } catch {
        $qorloopStatus = 'network error'
        if ($_.Exception.Response) { $qorloopStatus = [string][int]$_.Exception.Response.StatusCode }
        throw "GET /api/onboarding failed ($qorloopStatus). Use a fully authenticated demo Owner/Admin account."
    }
    Write-Output ('percent={0}; complete={1}; nextStepId={2}' -f $qorloopProgress.percent, $qorloopProgress.complete, $(if ($null -eq $qorloopProgress.nextStepId) { 'null' } else { $qorloopProgress.nextStepId }))
    $qorloopProgress.steps | Select-Object id, required, status, doneAt, @{ Name = 'target'; Expression = { $_.action.target } } | Format-Table -AutoSize
    $qorloopProgress.marketplaces | Select-Object marketplaceId, applied, doneAt | Format-Table -AutoSize
    $qorloopRequiredIds = @('owner_mfa', 'erp_upload', 'marketplace_upload', 'first_comparison')
    foreach ($qorloopId in $qorloopRequiredIds) {
        $qorloopStep = @($qorloopProgress.steps | Where-Object { $_.id -eq $qorloopId })
        if ($qorloopStep.Count -ne 1 -or $qorloopStep[0].status -ne 'done') {
            throw "Expected demo required step is not done: $qorloopId. No business data was changed."
        }
    }
    if ($qorloopProgress.percent -ne 100 -or -not $qorloopProgress.complete -or $null -ne $qorloopProgress.nextStepId) {
        throw 'Expected percent=100, complete=true and nextStepId=null. No business data was changed.'
    }
    foreach ($qorloopMarketplace in @('talabat', 'snoonu')) {
        if (-not @($qorloopProgress.marketplaces | Where-Object { $_.marketplaceId -eq $qorloopMarketplace -and $_.applied }).Count) {
            throw "Expected demo applied marketplace is missing: $qorloopMarketplace. No business data was changed."
        }
    }
    Write-Output 'PASS: all four required steps done; Talabat and Snoonu applied. Optional rows show real remaining work.'
} finally {
    $qorloopLogin = $null
    $qorloopPassword = $null
    $qorloopLoginBody = $null
    $qorloopCode = $null
    $qorloopVerifyBody = $null
    $qorloopSession = $null
    $qorloopResponse = $null
}
