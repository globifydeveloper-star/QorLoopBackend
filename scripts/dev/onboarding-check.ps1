# Read-only business-data check. Reuses an existing browser session; never logs in or writes demo data.
# Enter the value of the qorloop cookie only into the hidden local prompt. Do not paste it into chat.
$ErrorActionPreference = 'Stop'
$qorloopApi = 'http://qorloop-demo.localhost:4000'
$qorloopSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$qorloopSecureCookie = Read-Host 'Existing demo Owner/Admin qorloop cookie value (hidden)' -AsSecureString
try {
    $qorloopCookieValue = (New-Object System.Net.NetworkCredential('', $qorloopSecureCookie)).Password
    $qorloopCookie = New-Object System.Net.Cookie('qorloop', $qorloopCookieValue, '/', 'qorloop-demo.localhost')
    $qorloopSession.Cookies.Add($qorloopCookie)
} catch {
    throw 'Could not load the session cookie; no request was sent.'
} finally {
    $qorloopCookieValue = $null
    $qorloopCookie = $null
    $qorloopSecureCookie.Dispose()
}

try {
    try {
        $qorloopResponse = Invoke-WebRequest -UseBasicParsing -Method Get `
            -Uri ($qorloopApi + '/api/onboarding') -WebSession $qorloopSession `
            -Headers @{ Accept = 'application/json' } -ErrorAction Stop
        $qorloopProgress = ($qorloopResponse.Content | ConvertFrom-Json).data
    } catch {
        $qorloopStatus = 'network error'
        if ($_.Exception.Response) { $qorloopStatus = [string][int]$_.Exception.Response.StatusCode }
        throw "GET /api/onboarding failed ($qorloopStatus). Use a current fully authenticated demo Owner/Admin session."
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
    $qorloopSession = $null
    $qorloopResponse = $null
}
