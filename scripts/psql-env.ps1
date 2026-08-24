# scripts/psql-env.ps1
#
# Run psql against the database named by DATABASE_URL in this repo's .env files, without pasting a
# connection string into the shell (or into your command history).
#
#   .\scripts\psql-env.ps1 -c "SELECT 1"
#   .\scripts\psql-env.ps1 -f db\unpaid-internships.sql
#
# WHY THIS EXISTS. `psql "$DATABASE_URL"` is bash syntax. In PowerShell that argument is dropped
# entirely - psql receives no conninfo at all, falls back to libpq's compiled-in defaults, and
# reports "connection to server at localhost (::1), port 5432 failed: Connection refused". That
# names a host which appears nowhere in a Supabase connection string. PowerShell's form is
# $env:DATABASE_URL, and it is per-window: empty in every new terminal unless something sets it.
#
# The connection string is never printed. What IS printed is the masked form
# (postgresql://***:***@host:port/db) because this repo has THREE files defining DATABASE_URL and
# they do not all point at the same database - .env still carries an older one. Before a write you
# should be able to see which host you are about to write to.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# Vercel's pulled files first (they hold the live production URL), then the older local ones.
$candidates = @('.env.production.local', '.env.production', '.env.vercel.local', '.env.local', '.env')

# Parsed by splitting on the first '=' rather than by regex. An earlier regex version failed on
# these very files while its sibling regex found the key name, so the format carries something a
# '^\s*KEY\s*=\s*(.+?)\s*$' pattern does not survive - a BOM, a zero-width character, a quoted key,
# a stray non-breaking space. IndexOf does not care.
$url = $null
$source = $null
$present = @()   # files where the key exists but its value is empty

# An already-set $env:DATABASE_URL wins over every file. Without this the script ignored the very
# fallback its own failure message tells you to use, which is the worst kind of dead end.
if ($env:DATABASE_URL) {
    $url = $env:DATABASE_URL
    $source = 'the current shell ($env:DATABASE_URL)'
}

foreach ($name in $candidates) {
    if ($url) { break }
    $path = Join-Path $repo $name
    if (-not (Test-Path -LiteralPath $path)) { continue }

    foreach ($line in (Get-Content -LiteralPath $path)) {
        $text = $line.Trim()
        if ($text -eq '' -or $text.StartsWith('#')) { continue }

        $eq = $text.IndexOf('=')
        if ($eq -lt 1) { continue }

        # Normalise the key: drop an `export ` prefix and any character that cannot be part of an
        # environment variable name (BOM, zero-width space, quotes someone wrapped the key in).
        $key = $text.Substring(0, $eq).Trim()
        if ($key -match '^\s*export\s+') { $key = $key -replace '^\s*export\s+', '' }
        $key = $key -replace '[^A-Za-z0-9_]', ''
        if ($key -ne 'DATABASE_URL') { continue }

        $value = $text.Substring($eq + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1)
            $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2).Trim()
            }
        }
        # A value that is quoted but unterminated means the URL wraps onto the next line.
        if ($value.Length -ge 1 -and ($value.StartsWith('"') -or $value.StartsWith("'"))) {
            $value = $value.Substring(1).Trim()
        }

        if ($value) { $url = $value; $source = $name; break }
        $present += $name
    }
    if ($url) { break }
}

if (-not $url) {
    Write-Host "Could not take a DATABASE_URL value from any of: $($candidates -join ', ')" -ForegroundColor Red
    Write-Host ""
    if ($present.Count -gt 0) {
        Write-Host ("The key EXISTS in: " + ($present -join ', ') + " but its value came out empty.")
        Write-Host "That means the line is there with nothing after the '=', or the value is on the next line."
    }
    foreach ($name in $candidates) {
        $path = Join-Path $repo $name
        if (-not (Test-Path -LiteralPath $path)) { Write-Host ("  {0,-26} not present" -f $name); continue }
        $hit = $false
        $lineNo = 0
        foreach ($line in (Get-Content -LiteralPath $path)) {
            $lineNo++
            if ($line -notmatch 'DATABASE_URL') { continue }
            $hit = $true
            # Shape only: length, where the '=' is, and the first two characters after it. Two
            # characters cannot disclose a credential and they say whether the value is quoted.
            $eq = $line.IndexOf('=')
            $after = ''
            if ($eq -ge 0 -and $line.Length -gt $eq + 2) { $after = $line.Substring($eq + 1, 2) }
            $codes = (([char[]]$after) | ForEach-Object { [int]$_ }) -join ','
            Write-Host ("  {0,-26} line {1}: length {2}, '=' at {3}, next 2 chars as codes [{4}]" -f $name, $lineNo, $line.Length, $eq, $codes)
        }
        if (-not $hit) { Write-Host ("  {0,-26} no DATABASE_URL line" -f $name) }
    }
    Write-Host ""
    Write-Host "Only lengths and character codes are shown - no value was printed."
    Write-Host ""
    Write-Host "An empty value is what `"vercel env pull`" writes for a variable marked SENSITIVE in"
    Write-Host "the Vercel dashboard: the value is never handed back, so these files cannot supply it."
    Write-Host "Take the connection string from Supabase (Project > Connect > session pooler, 5432),"
    Write-Host "then either:"
    Write-Host ""
    Write-Host "    `$env:DATABASE_URL = '<paste the postgresql:// URL>'"
    Write-Host "    .\scripts\psql-env.ps1 -f db\unpaid-internships.sql"
    Write-Host ""
    Write-Host "or skip psql entirely: paste db/unpaid-internships-editor.sql into the Supabase SQL"
    Write-Host "editor, ONE SECTION PER RUN - an editor paste is a single implicit transaction."
    exit 1
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Host "psql is not on PATH. Add the PostgreSQL client bin directory, e.g." -ForegroundColor Red
    Write-Host '    $env:PATH += ";C:\Program Files\PostgreSQL\16\bin"'
    exit 1
}

# The .sql files in db/ are UTF-8 and several write an em dash inside a string literal. Without an
# explicit client encoding, a console on a legacy code page hands psql mis-decoded bytes and what
# lands in the column is mojibake - no error, a success report, and silently wrong data.
$env:PGCLIENTENCODING = 'UTF8'

$masked = $url -replace '://[^@]*@', '://***:***@'
Write-Host ("DATABASE_URL from {0}" -f $source) -ForegroundColor DarkGray
Write-Host ("  target: {0}" -f $masked) -ForegroundColor DarkGray

# ON_ERROR_STOP goes first so a caller's own -v can still override it.
$psqlArgs = @('-v', 'ON_ERROR_STOP=1') + $args
& psql $url @psqlArgs
exit $LASTEXITCODE
