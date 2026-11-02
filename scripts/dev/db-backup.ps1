# Backup of the development database, and (fallback revert of a bulk price change) restore of the product rules only.
#   Backup:  powershell -ExecutionPolicy Bypass -File scripts\dev\db-backup.ps1
#   Restore: powershell -ExecutionPolicy Bypass -File scripts\dev\db-backup.ps1 -RestoreRulesFrom <the .dump file>
# DATABASE_URL is read from .env by database-url.ps1 (no [Uri]); nothing is printed: pg_dump, pg_restore and psql get
# --host --port --username --dbname and the password through PGPASSWORD in this process only.
param(
    [string]$EnvFile = (Join-Path $PSScriptRoot '..\..\.env'),
    [string]$BackupDir = 'D:\Qorloop-test\backups',
    [string]$RestoreRulesFrom = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'database-url.ps1')
$EnvFile = [IO.Path]::GetFullPath($EnvFile)

Invoke-WithDatabase $EnvFile {
    param($conn)
    if (-not $RestoreRulesFrom) {
        $null = New-Item -ItemType Directory -Path $BackupDir -Force
        $out = Join-Path $BackupDir ("qorloop-before-bulk-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        & pg_dump @conn --format=custom --no-owner "--file=$out"
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)." }
        $tables = & pg_restore --list $out | Select-String 'TABLE DATA public (products|product_price_rules|audit_events|recon_rows) '
        Write-Host ("Backup: {0} ({1:N0} bytes); table data entries found: {2} (expected 4)" -f $out, (Get-Item $out).Length, @($tables).Count)
    } else {
        # Product rules only, atomically: TRUNCATE and the dumped rows in ONE transaction (every store in this database).
        $sql = Join-Path $env:TEMP ("qorloop-rules-{0}.sql" -f [guid]::NewGuid())
        & pg_restore --data-only --table=product_price_rules "--file=$sql" $RestoreRulesFrom
        if ($LASTEXITCODE -ne 0) { throw "pg_restore failed (exit $LASTEXITCODE)." }
        try {
            & psql @conn --no-psqlrc --quiet -v ON_ERROR_STOP=1 --single-transaction -c 'TRUNCATE product_price_rules' -f $sql
            if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE); nothing was changed (one transaction)." }
        } finally { Remove-Item $sql -ErrorAction SilentlyContinue }
        Write-Host 'Product rules restored from the backup. Queue a recompute: scripts\dev\bulk-price-revert.ps1 -RecomputeOnly'
    }
}
