# scripts/psql-env.ps1
#
# Run psql against the database named by DATABASE_URL in this repo's .env files, without pasting a
# connection string into the shell (or into your command history).
#
#   .\scripts\psql-env.ps1 -c "SELECT 1"
#   .\scripts\psql-env.ps1 -f db\unpaid-internships.sql
#
# WHY THIS EXISTS. `psql "$DATABASE_URL"` is bash syntax. PowerShell expands $DATABASE_URL to
# nothing, psql then falls back to its compiled-in default of localhost:5432, and the error reads
# "connection to server at localhost (::1), port 5432 failed: Connection refused" - which looks
# like the database is down when in fact no database was ever addressed. PowerShell's form is
# $env:DATABASE_URL, and that variable is per-window: it is empty in every new terminal unless
# something sets it, which is why a command that worked an hour ago fails now.
#
# The connection string is never printed. When it cannot be found this reports which KEY NAMES
# each .env file defines - names only, never values.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# Same order .dev-scripts/_db-url.mjs resolves in, plus Vercel's production files.
$candidates = @('.env.local', '.env.vercel.local', '.env.production.local', '.env.production', '.env')

$url = $null
$source = $null
foreach ($name in $candidates) {
    $path = Join-Path $repo $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    foreach ($line in (Get-Content -LiteralPath $path)) {
        if ($line -match '^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$') {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2) {
                $first = $value.Substring(0, 1)
                $last = $value.Substring($value.Length - 1, 1)
                if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
            }
            if ($value) { $url = $value; $source = $name; break }
        }
    }
    if ($url) { break }
}

if (-not $url) {
    Write-Host ("DATABASE_URL is not defined in any of: " + ($candidates -join ', ')) -ForegroundColor Red
    Write-Host ""
    foreach ($name in $candidates) {
        $path = Join-Path $repo $name
        if (Test-Path -LiteralPath $path) {
            $keys = @()
            foreach ($line in (Get-Content -LiteralPath $path)) {
                if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') { $keys += $Matches[1] }
            }
            Write-Host ("  {0,-26} defines: {1}" -f $name, ($keys -join ', '))
        }
        else {
            Write-Host ("  {0,-26} not present" -f $name)
        }
    }
    Write-Host ""
    Write-Host "Key names only are listed above - no values were read out. If the connection string"
    Write-Host "lives under a different key, set it for this window yourself:"
    Write-Host "    `$env:DATABASE_URL = '<paste the postgresql:// URL>'"
    exit 1
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Host "psql is not on PATH. Add the PostgreSQL client bin directory, e.g." -ForegroundColor Red
    Write-Host '    $env:PATH += ";C:\Program Files\PostgreSQL\16\bin"'
    exit 1
}

# The .sql files in db/ are UTF-8 and several write an em dash inside a string literal. Without an
# explicit client encoding, a console on a legacy code page hands psql mis-decoded bytes and what
# lands in the column is mojibake - which no page renders and no later query matches.
$env:PGCLIENTENCODING = 'UTF8'

Write-Host ("DATABASE_URL resolved from {0} ({1} chars; the value itself is never printed)." -f $source, $url.Length) -ForegroundColor DarkGray

# ON_ERROR_STOP goes first so a caller's own -v can still override it.
$psqlArgs = @('-v', 'ON_ERROR_STOP=1') + $args
& psql $url @psqlArgs
exit $LASTEXITCODE
