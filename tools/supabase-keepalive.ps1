# =====================================================================
#  Polisvakt - Supabase keepalive
# =====================================================================
#
# VARFOR FILEN FINNS
#
# Gratis-tier hos Supabase pausar ett projekt efter ca en veckas
# inaktivitet, och nar det pausas slutar projektets subdoman att resolva i
# DNS - hela appen dor tyst. Det hande 2026-09-01: sista lyckade svep 29 aug,
# forsta DNS-felet 1 sep 23:33, och "Fungerar Sverige?" var nej.
#
# Bryggan hittar normalt Supabase var 5:e minut och HALLER darmed projektet
# vaket - sa lange bryggan gar. Det har ar reservremmen: aven de dygn bryggan
# ligger nere ska databasen fa minst ett anrop, sa den aldrig hinner idla ihjal
# sig. Ett enda latt GET mot ett publikt REST-anrop racker; det aterstaller
# Supabases inaktivitetsklocka.
#
# Den KAN inte vacka ett redan pausat projekt - det kraver agarens
# Restore-knapp i dashboarden en gang. Den ser till att det inte pausas IGEN.
#
# Kors av en schemalagd uppgift (dagligen). Loggar bredvid bryggans loggar sa
# allt om backend-halsan ligger pa ett stalle.

$ErrorActionPreference = 'Stop'

$Url    = 'https://livvehyqowmcafnisxho.supabase.co/rest/v1/reports?select=id&limit=1'
$Nyckel = 'sb_publishable_6Oz7vhMd2b-kWB_DVftsmg_VwclVG5Q'

$DataMapp = Join-Path $env:LOCALAPPDATA 'Polisvakt'
if (-not (Test-Path $DataMapp)) { New-Item -ItemType Directory -Force -Path $DataMapp | Out-Null }
$Logg = Join-Path $DataMapp 'supabase-keepalive.log'

function Skriv($niva, $text) {
  $rad = ('{0}  {1,-5} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $niva, $text)
  # UTF-8 med BOM sa Windows PowerShell laser a/a/o ratt med `type`.
  $enc = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::AppendAllText($Logg, $rad + "`r`n", $enc)
}

try {
  $svar = Invoke-WebRequest -Uri $Url -Headers @{ apikey = $Nyckel; Authorization = "Bearer $Nyckel" } `
                            -TimeoutSec 30 -UseBasicParsing
  Skriv 'OK' ("ping HTTP {0} - projektet ar vaket" -f $svar.StatusCode)
  exit 0
}
catch {
  $m = $_.Exception.Message
  # ASCII-ONLY matchning med flit. Windows PowerShell 5.1 laser en BOM-los .ps1
  # som ANSI, sa ett a/a/o i en regex-literal blir mojibake och matchar inte
  # felstrangen (BOM-fallan, se minnet). 'matcha' racker for svenska
  # "matcha fjarrnamnet", och de engelska varianterna tacks separat.
  if ($m -match 'matcha|resolve|NameResolution|No such host|known') {
    Skriv 'NERE' ("projektet svarar inte pa DNS - PAUSAT eller raderat. Restore i supabase.com kravs. ({0})" -f $m)
  } else {
    Skriv 'PROB' ("ping misslyckades: {0}" -f $m)
  }
  # Icke-noll sa Schemalaggaren markerar korningen som misslyckad och det syns
  # i uppgiftshistoriken, inte bara i loggen.
  exit 1
}
