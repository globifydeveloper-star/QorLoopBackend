# Shared by the dev scripts (dot-source it): reads DATABASE_URL from a .env file WITHOUT [Uri] and without ever printing
# it. A password may contain '@' and ':', so the credentials end at the LAST '@':
#   postgres[ql]://user[:password]@host[:port][/database][?sslmode=...]
# Percent-escapes (%40) in user, password and database are decoded, as node-pg (and so the app) does.
# Every failure throws a fixed message: no exception text that could carry the value is ever passed on.

function ConvertFrom-PercentEncoding([string]$Text) {
    if ($Text -notmatch '%[0-9A-Fa-f]{2}') { return $Text }
    $bytes = New-Object 'System.Collections.Generic.List[byte]'
    $i = 0
    while ($i -lt $Text.Length) {
        if ($Text[$i] -eq '%' -and $i + 2 -lt $Text.Length -and $Text.Substring($i + 1, 2) -match '^[0-9A-Fa-f]{2}$') {
            $bytes.Add([Convert]::ToByte($Text.Substring($i + 1, 2), 16))
            $i += 3
        } else {
            $n = if ([char]::IsHighSurrogate($Text[$i]) -and $i + 1 -lt $Text.Length) { 2 } else { 1 }
            $bytes.AddRange([Text.Encoding]::UTF8.GetBytes($Text.Substring($i, $n)))
            $i += $n
        }
    }
    return [Text.Encoding]::UTF8.GetString($bytes.ToArray())
}

# The DATABASE_URL value as dotenv reads it: quoted up to the closing quote, unquoted up to a '#', trimmed.
function Read-DatabaseUrlValue([string]$EnvFile) {
    $lines = $null
    try { $lines = @(Get-Content -LiteralPath $EnvFile -Encoding UTF8 -ErrorAction Stop) }
    catch { throw "Could not read the env file $EnvFile." }
    $hits = @($lines | Where-Object { $_ -match '^\s*(export\s+)?DATABASE_URL\s*[=:]' })
    $lines = $null
    if ($hits.Count -ne 1) { throw "Expected exactly one DATABASE_URL line in $EnvFile, found $($hits.Count)." }
    try {
        $raw = $hits[0] -replace '^\s*(export\s+)?DATABASE_URL\s*[=:]\s*', ''
        $quote = if ($raw.Length -gt 0) { [string]$raw[0] } else { '' }
        if ($quote -eq '"' -or $quote -eq "'" -or $quote -eq '`') {
            $end = $raw.IndexOf($quote, 1)
            if ($end -lt 0) { throw 'unterminated' }
            return $raw.Substring(1, $end - 1)
        }
        return (($raw -split '#', 2)[0]).Trim()
    } catch {
        throw 'DATABASE_URL could not be read from the env file.'
    } finally {
        $hits = $null; $raw = $null
    }
}

# user, password, host, port, database and sslmode of a postgres URL; the credentials end at the LAST '@'.
function Split-DatabaseUrl([string]$Url) {
    try {
        $m = [regex]::Match($Url, '^(postgres(?:ql)?)://(.+)$')
        if (-not $m.Success) { throw 'scheme' }
        $rest = $m.Groups[2].Value
        $at = $rest.LastIndexOf('@')
        if ($at -lt 1) { throw 'user' }
        $userInfo = $rest.Substring(0, $at)
        $location = $rest.Substring($at + 1)
        $colon = $userInfo.IndexOf(':')
        $user = if ($colon -ge 0) { $userInfo.Substring(0, $colon) } else { $userInfo }
        $password = if ($colon -ge 0) { $userInfo.Substring($colon + 1) } else { '' }
        $h = [regex]::Match($location, '^(\[[^\]]+\]|[^:/?#\[\]]+)(?::(\d{1,5}))?(?:/([^?#]*))?(?:\?([^#]*))?$')
        if (-not $h.Success -or $user -eq '') { throw 'location' }
        $sslMode = $null
        foreach ($pair in ($h.Groups[4].Value -split '&')) {
            $kv = $pair -split '=', 2
            if ($kv.Count -eq 2 -and $kv[0] -eq 'sslmode') { $sslMode = $kv[1] }
        }
        $userName = ConvertFrom-PercentEncoding $user
        $database = ConvertFrom-PercentEncoding $h.Groups[3].Value
        return [pscustomobject]@{
            Host     = $h.Groups[1].Value.Trim('[', ']')
            Port     = if ($h.Groups[2].Success) { [int]$h.Groups[2].Value } else { 5432 }
            User     = $userName
            Password = ConvertFrom-PercentEncoding $password
            Database = if ($database) { $database } else { $userName }
            SslMode  = $sslMode
        }
    } catch {
        throw 'DATABASE_URL is not of the form postgresql://user:password@host:port/database.'
    } finally {
        $m = $null; $rest = $null; $userInfo = $null; $password = $null
    }
}

# Runs $Action with the libpq arguments --host --port --username --dbname (one array, its only argument). The password
# is in PGPASSWORD (and sslmode in PGSSLMODE) for this process and the tools it starts, and is restored afterwards.
function Invoke-WithDatabase([string]$EnvFile, [scriptblock]$Action) {
    $db = Split-DatabaseUrl (Read-DatabaseUrlValue $EnvFile)
    $connection = @("--host=$($db.Host)", "--port=$($db.Port)", "--username=$($db.User)", "--dbname=$($db.Database)")
    $saved = @{ PGPASSWORD = $env:PGPASSWORD; PGSSLMODE = $env:PGSSLMODE }
    try {
        $env:PGPASSWORD = $db.Password
        if ($db.SslMode) { $env:PGSSLMODE = $db.SslMode }
        $db = $null
        & $Action $connection
    } finally {
        $db = $null
        foreach ($name in 'PGPASSWORD', 'PGSSLMODE') {
            if ($null -eq $saved[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue } else { Set-Item "Env:$name" $saved[$name] }
        }
        $saved = $null
    }
}
