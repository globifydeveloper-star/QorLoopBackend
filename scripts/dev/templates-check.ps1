param(
    [switch]$ReversibleEdit
)

# PowerShell 5.1. Checks GET /api/templates on the demo store. Enter credentials only into this local terminal, never into chat.
# No .env access and no credential, cookie or token output. The only write is the optional -ReversibleEdit: one optional
# Talabat field is unmapped and then restored (two new layout versions, two template.updated events).
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

function Get-Header($Mapping, [string]$Field) {
    $property = $Mapping.PSObject.Properties[$Field]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Show-Templates($Items) {
    foreach ($item in $Items) {
        Write-Output ('== ' + $item.label + ': ' + $item.status + $(if ($item.reason) { ' (' + $item.reason + ')' } else { '' }))
        foreach ($layout in $item.layouts) {
            Write-Output ('   layout "' + $layout.name + '" v' + $layout.version + '; usedByUploads=' + $layout.usedByUploads + '; lastUsedAt=' + $layout.lastUsedAt + '; editable=' + $layout.editable)
            foreach ($field in $item.fields) {
                $header = Get-Header $layout.mapping $field.key
                Write-Output ('     ' + $field.key + $(if ($field.required) { ' (required)' } else { '' }) + ' -> ' + $(if ($null -eq $header) { '(not mapped)' } else { '"' + $header + '"' }))
            }
            if (@($layout.missingRequired).Count) { Write-Output ('     MISSING REQUIRED: ' + (@($layout.missingRequired) -join ', ')) }
        }
        if ($null -ne $item.outgoing) {
            $o = $item.outgoing
            if ($o.columns) {
                Write-Output ('   outgoing: ' + $o.status + '; based on "' + $o.basedOn.fileName + '" applied ' + $o.basedOn.appliedAt + '; match by ' + $o.columns.matchBy.field + ' "' + $o.columns.matchBy.header + '"; price "' + $o.columns.price + '"; availability "' + $o.columns.availability + '"')
            } else { Write-Output ('   outgoing: ' + $o.status) }
            if ($o.reason) { Write-Output ('   outgoing reason: ' + $o.reason) }
            if ($o.basedOn -and $o.basedOn.layout -and -not $o.basedOn.layout.current) { Write-Output '   note: the applied file was read with an older layout version; generated files follow it until a newer file is applied.' }
        }
    }
}

$qorloopEmail = Read-Host 'Email (Owner or Admin; local terminal only)'
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
    $templates = Invoke-Qorloop 'GET' '/api/templates'
    Show-Templates $templates.items
    foreach ($source in @('erp', 'talabat', 'snoonu')) {
        $entry = @($templates.items | Where-Object { $_.source -eq $source })
        if ($entry.Count -ne 1 -or $entry[0].status -ne 'set_up') { throw "Expected a saved $source layout on the demo store. No data was changed." }
    }
    foreach ($source in @('rafeeq', 'keeta')) {
        $entry = @($templates.items | Where-Object { $_.source -eq $source })[0]
        Write-Output ($source + ': ' + $entry.status + ' (reported as found; not asserted)')
    }
    Write-Output 'PASS: ERP, Talabat and Snoonu layouts present.'

    if ($ReversibleEdit) {
        $talabat = @($templates.items | Where-Object { $_.source -eq 'talabat' })[0]
        $layout = @($talabat.layouts | Where-Object { $_.editable })[0]
        if ($null -eq $layout) { throw 'No editable Talabat layout; reversible edit skipped. No data was changed.' }
        $field = @('name', 'barcode2', 'barcode3') | Where-Object { $null -ne (Get-Header $layout.mapping $_) } | Select-Object -First 1
        if ($null -eq $field) {
            Write-Output 'The Talabat layout maps no optional field (name, barcode2, barcode3); reversible edit skipped. No data was changed.'
        } else {
            $original = Get-Header $layout.mapping $field
            $edited = $null
            try {
                $edited = Invoke-Qorloop 'PUT' '/api/templates/talabat' @{ name = $layout.name; expectedVersion = [int]$layout.version; fields = @{ $field = $null } }
                $editedLayout = @($edited.layouts | Where-Object { $_.name -eq $layout.name })[0]
                if ([int]$editedLayout.version -ne [int]$layout.version + 1 -or $null -ne (Get-Header $editedLayout.mapping $field)) { throw 'Edited layout did not match.' }
            } finally {
                if ($null -ne $edited) {
                    try {
                        $restored = Invoke-Qorloop 'PUT' '/api/templates/talabat' @{ name = $layout.name; expectedVersion = [int]$editedLayout.version; fields = @{ $field = $original } }
                        $restoredLayout = @($restored.layouts | Where-Object { $_.name -eq $layout.name })[0]
                        foreach ($f in $talabat.fields) {
                            if ((Get-Header $restoredLayout.mapping $f.key) -ne (Get-Header $layout.mapping $f.key)) { throw 'Restored mapping did not match.' }
                        }
                        Write-Output ('Reversible edit verified: talabat "' + $layout.name + '" v' + $layout.version + ' -> v' + $editedLayout.version + ' -> v' + $restoredLayout.version + ', field ' + $field + ' restored to "' + $original + '".')
                    } catch {
                        Write-Warning ('Automatic revert could not be confirmed. Restore Talabat layout "' + $layout.name + '" field ' + $field + ' to "' + $original + '" on the Templates screen; a concurrent edit may have occurred.')
                        throw 'Templates revert needs attention. No concurrent edit was overwritten.'
                    }
                }
            }
        }
    }
} finally {
    try { $null = Invoke-Qorloop 'POST' '/api/auth/logout' } catch { Write-Warning 'Check completed; logout could not be confirmed.' }
    $login = $null
    $script:qorloopCsrf = $null
    $qorloopSession = $null
}
