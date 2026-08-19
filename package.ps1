# Paketera Polisvakt för uppladdning.
#
# Använd INTE Compress-Archive till det här. PowerShell 5.1 skriver
# bakåtstreck som sökvägsseparator i zip-filen, och eftersom webbservrar kör
# Linux tolkas "css\app.css" då som ett filnamn i roten istället för en fil i
# mappen css. Resultatet blir en sajt där index.html laddar men all CSS och
# JavaScript ger 404 — sidan ser trasig ut fast koden är hel.
#
# Zip-standarden kräver snedstreck. Det här skriptet bygger arkivet för hand
# så att separatorerna blir rätt.
#
#   .\package.ps1                      -> polisvakt.zip bredvid skriptet
#   .\package.ps1 -Out C:\temp\a.zip

param(
  [string]$Out = (Join-Path $PSScriptRoot 'polisvakt.zip')
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot

# Filer som inte hör hemma på en publik sajt
$skip = @('polisvakt.zip', 'serve.ps1', 'package.ps1')
$skipDirs = @('.git', 'node_modules', '.claude')

if (Test-Path $Out) { Remove-Item $Out -Force }

$files = Get-ChildItem $root -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length + 1)
  $first = $rel.Split([char]92)[0]
  ($skip -notcontains $rel) -and ($skipDirs -notcontains $first)
}

$stream = [System.IO.File]::Open($Out, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)

foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1).Replace([char]92, '/')   # <- kärnan i fixen
  $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
  $es = $entry.Open()
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $es.Write($bytes, 0, $bytes.Length)
  $es.Close()
}

$archive.Dispose()
$stream.Close()

# Kontrollera att inga bakåtstreck slank med
$check = [System.IO.Compression.ZipFile]::OpenRead($Out)
$bad = @($check.Entries | Where-Object { $_.FullName.Contains([char]92) })
$count = $check.Entries.Count
$check.Dispose()

if ($bad.Count -gt 0) {
  Write-Host "FEL: $($bad.Count) poster har bakatstreck." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  $Out" -ForegroundColor Green
Write-Host "  $count filer, $([math]::Round((Get-Item $Out).Length/1kb)) kB, alla sokvagar med snedstreck." -ForegroundColor DarkGray
Write-Host ""
