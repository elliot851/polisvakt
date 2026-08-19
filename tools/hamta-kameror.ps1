<#
.SYNOPSIS
  Hämtar fartkameror från OpenStreetMap och uppdaterar data/cameras.json.

.DESCRIPTION
  Fartkameror är fysiska föremål vid vägen och finns därför kartlagda i
  OpenStreetMap som node[highway=speed_camera] — med mätriktning och platsnamn,
  utan API-nyckel. Det gör att appen kan varna för dem utan att vänta på ett
  konto hos Trafikverket.

  Skriptet skriver INTE över data/cameras.json av sig självt. Utan -Skriv gör
  det bara en hämtning och visar en diff mot filen som redan ligger där. Det är
  medvetet: en uppfunnen kamera får appen att varna för ingenting och urholkar
  förtroendet, och en tappad kamera är ett tyst fel. Båda ska synas innan de
  hamnar i produktion.

  Se docs/KAMEROR.md för källa, licens, uppdateringstakt och vad datan inte
  kan svara på.

.PARAMETER Omrade
  sverige (standard) · malardalen · vastmanland
  Se docs/KAMEROR.md för varför standarden är hela Sverige.

.PARAMETER Skriv
  Skriv resultatet till data/cameras.json. Utan den här flaggan visas bara
  diffen. Den gamla filen sparas som data/cameras.json.bak.

.PARAMETER Tvinga
  Skriv även om rimlighetskontrollerna slår larm (kraftigt tapp i antal).

.PARAMETER Ut
  Alternativ målfil. Standard: data/cameras.json.

.PARAMETER Forsok
  Antal hämtningsförsök innan skriptet ger upp. Standard 5.

.EXAMPLE
  .\tools\hamta-kameror.ps1
  Hämtar och visar diffen. Rör ingen fil.

.EXAMPLE
  .\tools\hamta-kameror.ps1 -Skriv
  Hämtar, visar diffen och skriver data/cameras.json.

.NOTES
  Windows PowerShell 5.1. Inga externa moduler.
#>

[CmdletBinding()]
param(
  [ValidateSet('sverige', 'malardalen', 'vastmanland')]
  [string]$Omrade = 'sverige',

  [switch]$Skriv,
  [switch]$Tvinga,
  [string]$Ut,
  [int]$Forsok = 5
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path $PSScriptRoot -Parent
if (-not $Ut) { $Ut = Join-Path $root 'data\cameras.json' }

# Overpass ber uttryckligen om att få veta vem som ringer, så att de kan höra
# av sig istället för att blockera. Ett skript utan avsändare är ett skript som
# förr eller senare blir bannlyst.
#
# Skriv inga domännamn här. overpass-api.de sitter bakom en Apache-regel som
# svarar 406 Not Acceptable så fort en URL eller ett värdnamn dyker upp i
# User-Agent — felet ser ut som ett trasigt anrop men är bara filtret.
$UA = 'Polisvakt-hamta-kameror/1.0 (fartkameradata till Polisvakt-appen)'

# Två instanser av samma databas, samma svar. Poängen är att en överbelastad
# instans inte ska stoppa hämtningen. Samma två som js/speedlimit.js använder.
#
# Lägg inte till overpass.osm.ch: den instansen har bara schweizisk data och
# svarar glatt med noll kameror på en fråga om Sverige.
$ENDPOINTS = @(
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
)

# Områdena anges med ISO 3166-2-koder istället för en ruta i grader. En ruta
# runt Västmanland tar med halva Södermanland på köpet — det var precis så den
# gamla listan på 136 kameror uppstod, varav bara 40 låg i länet.
$OMRADEN = @{
  'sverige'     = @{
    filter = 'area["admin_level"="2"]["ISO3166-1"="SE"]'
    namn   = 'Sverige'
  }
  'malardalen'  = @{
    filter = 'area["admin_level"="4"]["ISO3166-2"~"^SE-(U|C|AB|D|T|W)$"]'
    namn   = 'Malardalen (Vastmanland, Uppsala, Stockholm, Sodermanland, Orebro, Dalarna)'
  }
  'vastmanland' = @{
    filter = 'area["admin_level"="4"]["ISO3166-2"="SE-U"]'
    namn   = 'Vastmanlands lan'
  }
}

$valt = $OMRADEN[$Omrade]

$query = @"
[out:json][timeout:300];
$($valt.filter)->.omrade;
node["highway"="speed_camera"](area.omrade);
out body;
"@

function Skriv-Rad {
  param([string]$Text, [string]$Farg = 'Gray')
  Write-Host $Text -ForegroundColor $Farg
}

<#
  Ett HTTP-anrop mot Overpass, med teckenkodningen rättad.

  Invoke-RestMethod duger inte här. Den gissar teckenkodning fel i PowerShell
  5.1 när servern inte skickar charset i Content-Type, tolkar UTF-8-bytes som
  Latin-1 och gör "Västerås" till "VÃ¤sterÃ¥s". Felet syns inte förrän en
  förare hör appen läsa upp mojibake. Därför Invoke-WebRequest, råa bytes ut
  ur RawContentStream och en explicit UTF-8-avkodning.
#>
function Invoke-Overpass {
  param([string]$Url, [string]$Fraga, [int]$TimeoutSec = 300)

  $body = 'data=' + [uri]::EscapeDataString($Fraga)
  $resp = Invoke-WebRequest -Uri $Url -Method Post -Body $body `
            -ContentType 'application/x-www-form-urlencoded' `
            -UserAgent $UA `
            -TimeoutSec $TimeoutSec -UseBasicParsing

  return [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
}

<#
  Hämtar med återförsök. Overpass har ett begränsat antal samtidiga platser och
  svarar 429 när de är slut, 504 när frågan tog för lång tid. Att hamra vidare
  gör bara att man blir avstängd — så vi backar av, med respekt för Retry-After
  när servern skickar en sådan, och byter instans mellan försöken.
#>
function Hamta-MedBackoff {
  param([string]$Fraga, [int]$MaxForsok)

  $vantan = @(10, 30, 60, 120, 240)   # sekunder, växande

  for ($i = 0; $i -lt $MaxForsok; $i++) {
    $url = $ENDPOINTS[$i % $ENDPOINTS.Count]
    $vard = ([uri]$url).Host
    Skriv-Rad ("  Forsok {0}/{1} mot {2} ..." -f ($i + 1), $MaxForsok, $vard) 'DarkGray'

    $text = $null
    $status = 0
    $retryAfter = 0

    try {
      $text = Invoke-Overpass -Url $url -Fraga $Fraga
    } catch {
      $r = $null
      try { $r = $_.Exception.Response } catch {}
      if ($r) {
        try { $status = [int]$r.StatusCode } catch {}
        try {
          $ra = $r.Headers['Retry-After']
          if ($ra -and [int]::TryParse($ra, [ref]$null)) { $retryAfter = [int]$ra }
        } catch {}
      }
      if ($status -eq 429) {
        Skriv-Rad '    429 for manga anrop - Overpass har slut pa platser.' 'DarkYellow'
      } elseif ($status -eq 504 -or $status -eq 503) {
        Skriv-Rad ("    {0} servern hann inte / ar overbelastad." -f $status) 'DarkYellow'
      } else {
        Skriv-Rad ("    misslyckades: {0}" -f $_.Exception.Message) 'DarkYellow'
      }
    }

    if ($text) {
      # Overpass svarar ibland 200 med en HTML-sida eller med ett JSON-svar som
      # bara innehaller en "remark". Bada ar fel, trots 200.
      $t = $text.TrimStart()
      if (-not $t.StartsWith('{')) {
        Skriv-Rad '    svaret var inte JSON (troligen en felsida).' 'DarkYellow'
      } else {
        $parsed = $null
        try { $parsed = $t | ConvertFrom-Json } catch {
          Skriv-Rad '    kunde inte tolka JSON.' 'DarkYellow'
        }
        if ($parsed) {
          if ($parsed.PSObject.Properties.Name -contains 'remark' -and $parsed.remark) {
            Skriv-Rad ("    servern klagade: {0}" -f $parsed.remark) 'DarkYellow'
          } elseif ($null -eq $parsed.elements -or @($parsed.elements).Count -eq 0) {
            # Ett tomt svar behandlas som ett fel, inte som ett faktum. En
            # instans med bara regional data svarar med noll kameror utan att
            # klaga — och noll kameror är aldrig ett rimligt svar för Sverige.
            Skriv-Rad '    svaret innehöll noll element - provar nästa instans.' 'DarkYellow'
          } else {
            return $parsed
          }
        }
      }
    }

    if ($i -lt $MaxForsok - 1) {
      $s = if ($retryAfter -gt 0) { $retryAfter } else { $vantan[[Math]::Min($i, $vantan.Count - 1)] }
      $s = $s + (Get-Random -Minimum 0 -Maximum 6)   # jitter, så flera körningar inte synkar
      Skriv-Rad ("    vantar {0} s innan nasta forsok ..." -f $s) 'DarkGray'
      Start-Sleep -Seconds $s
    }
  }

  return $null
}

<#
  OSM-nod -> kameraobjekt i appens format.

  Schemat är detsamma som appen redan läser i js/app.js (loadCameras):
    id · lat · lon · name · bearing · speedLimit
  bearing och speedLimit får vara null. Ändra inte fältnamnen utan att ändra
  loadCameras och js/alerts.js samtidigt.
#>
function Konvertera-Nod {
  param($Nod)

  $t = $Nod.tags

  # Mätriktningen. Utan den varnar appen även den som kör åt andra hållet förbi
  # en kamera som bara mäter ett håll — se riktningskollen i js/alerts.js.
  # OSM har både "direction" och "camera:direction"; i Sverige används i
  # praktiken bara "direction", men vi läser båda.
  # Värdena "forward"/"backward" hoppas över med flit: de betyder "åt samma
  # håll som vägen ritats" och går inte att översätta till en kompasskurs utan
  # att också hämta vägens geometri. Hellre ingen riktning än fel riktning.
  $bearing = $null
  foreach ($kandidat in @($t.direction, $t.'camera:direction')) {
    if (-not $kandidat) { continue }
    $d = 0.0
    if ([double]::TryParse(($kandidat -replace ',', '.'), [Globalization.NumberStyles]::Float,
                           [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
      if ($d -ge 0 -and $d -le 360) { $bearing = [int][math]::Round($d) % 360; break }
    }
  }

  # Hastighetsgränsen kameran mäter mot. Bara ungefär var sjätte kamera har den
  # taggad, så appen får inte förutsätta att den finns.
  $limit = $null
  if ($t.maxspeed) {
    $m = [regex]::Match([string]$t.maxspeed, '^\s*(\d{2,3})')
    if ($m.Success) {
      $v = [int]$m.Groups[1].Value
      if ($v -ge 20 -and $v -le 130) { $limit = $v }
    }
  }

  $name = $null
  foreach ($kandidat in @($t.description, $t.name)) {
    if ($kandidat -and ([string]$kandidat).Trim()) { $name = ([string]$kandidat).Trim(); break }
  }

  # Datan använder Trafikverkets förkortningar: "Stockholmsv väster om
  # Åbylundsv". Det är obegripligt i en popup och omöjligt att läsa upp.
  # Bara sammansättningar som slutar på -sv, -sg eller -sl skrivs ut, så att
  # ord som "Berg" eller "Grav" inte blir "Berggatan" och "Gravägen".
  if ($name) {
    $name = [regex]::Replace($name, '(?<=\w)sv\b', 'svägen')
    $name = [regex]::Replace($name, '(?<=\w)sg\b', 'sgatan')
    $name = [regex]::Replace($name, '(?<=\w)sl\b', 'sleden')
  }

  return [ordered]@{
    id         = [string]$Nod.id
    lat        = [math]::Round([double]$Nod.lat, 6)
    lon        = [math]::Round([double]$Nod.lon, 6)
    name       = $name
    bearing    = $bearing
    speedLimit = $limit
  }
}

function Avstand-Meter {
  param([double]$Lat1, [double]$Lon1, [double]$Lat2, [double]$Lon2)
  $R = 6371000.0
  $f1 = $Lat1 * [math]::PI / 180
  $f2 = $Lat2 * [math]::PI / 180
  $df = ($Lat2 - $Lat1) * [math]::PI / 180
  $dl = ($Lon2 - $Lon1) * [math]::PI / 180
  $a = [math]::Sin($df / 2) * [math]::Sin($df / 2) +
       [math]::Cos($f1) * [math]::Cos($f2) * [math]::Sin($dl / 2) * [math]::Sin($dl / 2)
  return $R * 2 * [math]::Atan2([math]::Sqrt($a), [math]::Sqrt(1 - $a))
}

# ================= körningen börjar här =================

Skriv-Rad ''
Skriv-Rad ("Polisvakt - hamtar fartkameror fran OpenStreetMap") 'Cyan'
Skriv-Rad ("  omrade: {0}" -f $valt.namn) 'DarkGray'
Skriv-Rad ("  malfil: {0}" -f $Ut) 'DarkGray'
Skriv-Rad ''

$svar = Hamta-MedBackoff -Fraga $query -MaxForsok $Forsok

if (-not $svar) {
  Skriv-Rad ''
  Skriv-Rad 'Overpass svarade inte pa nagot av forsoken.' 'Red'
  Skriv-Rad 'Ingen fil har rorts. Kor igen senare - hitta inte pa data.' 'Red'
  Skriv-Rad ''
  exit 1
}

$noder = @($svar.elements | Where-Object { $_.type -eq 'node' })

if ($noder.Count -eq 0) {
  Skriv-Rad ''
  Skriv-Rad 'Svaret innehöll noll kameror. Det är nästan säkert ett fel i frågan,' 'Red'
  Skriv-Rad 'inte en tom verklighet. Ingen fil har rörts.' 'Red'
  exit 1
}

$nya = @()
foreach ($n in $noder) { $nya += (Konvertera-Nod -Nod $n) }
$nya = @($nya | Sort-Object { [double]$_.lat }, { [double]$_.lon })

$tidsstampel = $svar.osm3s.timestamp_osm_base

# ================= diff mot filen som redan ligger där =================

$gamla = @()
$fannsSedan = $false
if (Test-Path $Ut) {
  try {
    $g = [System.IO.File]::ReadAllText($Ut, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $gamla = @($g.cameras)
    $fannsSedan = $true
  } catch {
    Skriv-Rad ("  Kunde inte lasa befintlig {0}: {1}" -f $Ut, $_.Exception.Message) 'DarkYellow'
  }
}

$gamlaMap = @{}
foreach ($c in $gamla) { $gamlaMap[[string]$c.id] = $c }
$nyaMap = @{}
foreach ($c in $nya) { $nyaMap[[string]$c.id] = $c }

$tillagda  = @($nya   | Where-Object { -not $gamlaMap.ContainsKey([string]$_.id) })
$borttagna = @($gamla | Where-Object { -not $nyaMap.ContainsKey([string]$_.id) })

$flyttade = @(); $namnbyten = @(); $riktningsbyten = @(); $gransbyten = @()
foreach ($c in $gamla) {
  $id = [string]$c.id
  if (-not $nyaMap.ContainsKey($id)) { continue }
  $n = $nyaMap[$id]
  $m = Avstand-Meter ([double]$c.lat) ([double]$c.lon) ([double]$n.lat) ([double]$n.lon)
  if ($m -gt 25) { $flyttade += [pscustomobject]@{ id = $id; namn = $n.name; meter = [math]::Round($m) } }
  if ([string]$c.name -ne [string]$n.name) {
    $namnbyten += [pscustomobject]@{ id = $id; fran = $c.name; till = $n.name }
  }
  if (("$($c.bearing)") -ne ("$($n.bearing)")) {
    $riktningsbyten += [pscustomobject]@{ id = $id; namn = $n.name; fran = $c.bearing; till = $n.bearing }
  }
  if (("$($c.speedLimit)") -ne ("$($n.speedLimit)")) {
    $gransbyten += [pscustomobject]@{ id = $id; namn = $n.name; fran = $c.speedLimit; till = $n.speedLimit }
  }
}

function Visa-Lista {
  param([string]$Rubrik, $Rader, [string]$Farg, [int]$Max = 12)

  # En tom pipeline blir $null, och @($null).Count är 1 — inte 0. Utan den här
  # filtreringen rapporterar diffen "borttagna: 1" utan att kunna visa raden,
  # vilket är exakt den sortens falska larm som gör att man slutar läsa diffen.
  $Rader = @($Rader | Where-Object { $null -ne $_ })
  $antal = $Rader.Count
  Skriv-Rad ("  {0}: {1}" -f $Rubrik, $antal) $(if ($antal -gt 0) { $Farg } else { 'DarkGray' })
  if ($antal -eq 0) { return }
  $i = 0
  foreach ($r in $Rader) {
    if ($i -ge $Max) { Skriv-Rad ("      ... och {0} till" -f ($antal - $Max)) 'DarkGray'; break }
    Skriv-Rad ("      {0}" -f $r) 'DarkGray'
    $i++
  }
}

Skriv-Rad ''
Skriv-Rad ("Hamtat {0} kameror. OSM-data per {1}." -f $nya.Count, $tidsstampel) 'Green'
$medRiktning = @($nya | Where-Object { $null -ne $_.bearing }).Count
$medNamn     = @($nya | Where-Object { $null -ne $_.name }).Count
$medGrans    = @($nya | Where-Object { $null -ne $_.speedLimit }).Count
Skriv-Rad ("  {0} med matriktning, {1} med platsnamn, {2} med hastighetsgrans" -f $medRiktning, $medNamn, $medGrans) 'DarkGray'
Skriv-Rad ''

if ($fannsSedan) {
  Skriv-Rad ("Diff mot {0} ({1} kameror, uppdaterad {2}):" -f (Split-Path $Ut -Leaf), $gamla.Count, $g.uppdaterad) 'Cyan'
  Visa-Lista 'tillagda'  ($tillagda  | ForEach-Object { "$($_.id)  $($_.name)  $($_.lat),$($_.lon)" }) 'Green'
  Visa-Lista 'borttagna' ($borttagna | ForEach-Object { "$($_.id)  $($_.name)  $($_.lat),$($_.lon)" }) 'Red'
  Visa-Lista 'flyttade (>25 m)' ($flyttade | Sort-Object meter -Descending | ForEach-Object { "$($_.id)  $($_.namn)  $($_.meter) m" }) 'Yellow'
  Visa-Lista 'nytt namn'        ($namnbyten      | ForEach-Object { "$($_.id)  '$($_.fran)' -> '$($_.till)'" }) 'Yellow'
  Visa-Lista 'ny matriktning'   ($riktningsbyten | ForEach-Object { "$($_.id)  $($_.namn)  $($_.fran) -> $($_.till)" }) 'Yellow'
  Visa-Lista 'ny hastighetsgrans' ($gransbyten   | ForEach-Object { "$($_.id)  $($_.namn)  $($_.fran) -> $($_.till)" }) 'Yellow'
} else {
  Skriv-Rad 'Ingen tidigare fil att jamfora med.' 'DarkGray'
}
Skriv-Rad ''

# Rimlighetskontroll. Ett stort tapp beror nastan alltid pa en trasig fraga
# eller ett halvt svar, inte pa att kamerorna forsvunnit over natten.
$larm = $false
if ($fannsSedan -and $gamla.Count -gt 0) {
  $andel = $nya.Count / [double]$gamla.Count
  if ($andel -lt 0.5) {
    Skriv-Rad ("VARNING: nya listan har bara {0:P0} av gamla antalet." -f $andel) 'Red'
    Skriv-Rad 'Kontrollera omradet och fragan innan du skriver. -Tvinga skriver anda.' 'Red'
    $larm = $true
  }
}

if (-not $Skriv) {
  Skriv-Rad 'Torrkorning - ingen fil har skrivits. Kor om med -Skriv for att spara.' 'Cyan'
  Skriv-Rad ''
  exit 0
}

if ($larm -and -not $Tvinga) {
  Skriv-Rad 'Avbryter pa grund av rimlighetskontrollen. Anvand -Tvinga om det ar avsiktligt.' 'Red'
  Skriv-Rad ''
  exit 1
}

# ================= skriv filen =================

# Säkerhetskopian läggs i TEMP, inte bredvid filen. package.ps1 tar med allt i
# mappträdet utom en kort undantagslista, så en cameras.json.bak i data/ hade
# publicerats på sajten vid nästa paketering.
if (Test-Path $Ut) {
  $bakNamn = '{0}.{1}.bak' -f (Split-Path $Ut -Leaf), (Get-Date).ToString('yyyyMMdd-HHmmss')
  $bak = Join-Path $env:TEMP $bakNamn
  Copy-Item $Ut $bak -Force
  Skriv-Rad ("  Gamla filen sparad som {0}" -f $bak) 'DarkGray'
}

# En kamera per rad. ConvertTo-Json med indentering blir tre ganger sa stor,
# och filen precachas av service workern - varje anvandare laddar ner den.
# En rad per kamera ger dessutom lasbara git-diffar.
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('{')
[void]$sb.AppendLine('  "_om": "Fartkameror for Polisvakt. Hamtade fran OpenStreetMap (highway=speed_camera) via Overpass API. Uppdateras med tools/hamta-kameror.ps1 - se docs/KAMEROR.md.",')
[void]$sb.AppendLine('  "kalla": "OpenStreetMap-bidragsgivare, ODbL",')
[void]$sb.AppendLine(('  "omrade": {0},' -f (ConvertTo-Json $valt.namn -Compress)))
[void]$sb.AppendLine(('  "fraga": {0},' -f (ConvertTo-Json (($query -replace '\s+', ' ').Trim()) -Compress)))
[void]$sb.AppendLine(('  "osmTidsstampel": {0},' -f (ConvertTo-Json ([string]$tidsstampel) -Compress)))
[void]$sb.AppendLine(('  "uppdaterad": "{0}",' -f (Get-Date).ToString('yyyy-MM-dd')))
[void]$sb.AppendLine(('  "antal": {0},' -f $nya.Count))
[void]$sb.AppendLine('  "cameras": [')
for ($i = 0; $i -lt $nya.Count; $i++) {
  $rad = ($nya[$i] | ConvertTo-Json -Compress -Depth 3)
  $komma = if ($i -lt $nya.Count - 1) { ',' } else { '' }
  [void]$sb.AppendLine('    ' + $rad + $komma)
}
[void]$sb.AppendLine('  ]')
[void]$sb.Append('}')
[void]$sb.AppendLine()

# UTF-8 utan BOM. Filen laddas med fetch().json() i webblasaren.
[System.IO.File]::WriteAllText($Ut, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))

$kb = [math]::Round((Get-Item $Ut).Length / 1kb, 1)
Skriv-Rad ''
Skriv-Rad ("  {0} kameror skrivna till {1} ({2} kB)" -f $nya.Count, $Ut, $kb) 'Green'
Skriv-Rad '  Kom ihag att bumpa VERSION i sw.js sa filen nar ut till anvandarna.' 'DarkGray'
Skriv-Rad ''
