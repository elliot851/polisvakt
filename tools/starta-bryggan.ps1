# Startar ett eget Chrome-fönster för Facebook-bryggan.
#
# VARFÖR DEN HÄR FILEN FINNS
#
# Den är en förbättring, inte ett krav. Bryggan fungerar i en vanlig
# bakgrundsflik sedan den slutade läsa Facebooks tidsstämpel och började
# tidsbestämma inlägg själv.
#
# Men Chrome strypar timers i bakgrundsflikar. Uppmätt i en riktig dold flik
# över tolv minuter: svepet håller tjugo sekunder i ungefär två minuter och
# går sedan till en gång i minuten, oavsett vad som står i scanIntervalMs.
# Det kostar upp till en minuts fördröjning på en varning som lever i trettio
# till sextio. Övertäckta fönster kan dessutom pausas helt.
#
# Flaggorna nedan tar bort båda sakerna, så svepet håller sina tjugo sekunder
# även när du gör något annat. Vill du slippa ett extra fönster fungerar en
# vanlig flik också — du får bara varningen en knapp minut senare.
#
# De tre flaggorna nedan stänger av precis det, och ingenting annat:
#
#   --disable-background-timer-throttling      timers går i full takt
#   --disable-backgrounding-occluded-windows   övertäckt fönster pausas inte
#   --disable-renderer-backgrounding           renderaren nedprioriteras inte
#
# Ingen av dem rör säkerhet, sandlåda eller certifikat. Det här är inte
# "kör Chrome osäkert" — det är "låt den här fliken fortsätta räkna".
#
# Egen profilmapp med flit. Bryggan får då sina egna kakor och sin egen
# Facebook-session, skild från den du surfar med. Det betyder också att du
# loggar in en gång här, och att ett eventuellt problem med kontot inte rör
# din vanliga profil.
#
#   Kör:              .\starta-bryggan.ps1
#   Annan grupp:      .\starta-bryggan.ps1 -GruppId 1234567890
#   Vanlig profil:    .\starta-bryggan.ps1 -AnvandVanligProfil
#
# Tampermonkey måste installeras en gång i det nya fönstret. Skriptet skriver
# ut adressen du ska öppna.

param(
  [string]$GruppId = '317968668373072',
  [int]$Felsokningsport = 9222,
  [switch]$AnvandVanligProfil
)

$ErrorActionPreference = 'Stop'

$kandidater = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $kandidater | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  Write-Host 'Hittar inte chrome.exe. Leta upp den och peka ut den i $kandidater.' -ForegroundColor Red
  exit 1
}

# OBS: --load-extension fungerar INTE längre.
#
# Chrome tog bort flaggan av säkerhetsskäl. Uppmätt på Chrome 151, egen
# profil, isolerat test: tillägget laddades inte, window.__polisvakt fanns
# inte. Flaggan skickas fortfarande med — den skadar inget och börjar
# fungera igen om Google ändrar sig — men förlita dig inte på den.
#
# Tillägget måste installeras EN gång via chrome://extensions:
#   Utvecklarläge på  ->  Läs in okomprimerat  ->  välj tools\brygg-tillagg
# Efter det ligger det kvar och laddas vid varje start, utan den här filen.
#
# Det den här startaren fortfarande gör nytta för är flaggorna mot
# timer-strypning. Se längre ned.
$tillagg = Join-Path $PSScriptRoot 'brygg-tillagg'
if (-not (Test-Path (Join-Path $tillagg 'manifest.json'))) {
  Write-Host "Hittar inte tillagget i $tillagg" -ForegroundColor Red
  exit 1
}

# Citattecken runt sokvagen, inte for snygghetens skull.
#
# Repot ligger under "Claude code 2GNDTN" — tva mellanslag. Utan citattecken
# delar Windows argumentet vid dem, och Chrome tolkade bitarna som adresser:
# den oppnade http://code/ och http://2gndtn/polisvakt/tools/brygg-tillagg
# som flikar och laddade aldrig tillagget. Felet syntes bara pa att bryggan
# var tyst, vilket ser likadant ut som allt annat som gar fel har.
$argument = @(
  "--load-extension=`"$tillagg`"",
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  # Felsokningsporten gor att bryggan gar att kontrollera utifran, i stallet
  # for att nagon maste oppna konsolen och titta. Den lyssnar bara pa
  # 127.0.0.1 och bara sa lange fonstret ar oppet.
  "--remote-debugging-port=$Felsokningsport",
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  "https://www.facebook.com/groups/$GruppId/"
)

if ($AnvandVanligProfil) {
  # Din vanliga profil: redan inloggad, alla tillagg kvar. Priset ar att
  # Chrome laser --load-extension bara vid uppstart, sa allt maste vara
  # stangt forst. Kollar det i stallet for att tyst starta en flik i den
  # instans som redan kor -- da hade flaggorna ignorerats och bryggan aldrig
  # laddats, vilket ser likadant ut som allt annat som gar fel har.
  $kor = Get-Process chrome -ErrorAction SilentlyContinue
  if ($kor) {
    Write-Host 'Chrome kor redan. Flaggorna ignoreras da och bryggan laddas INTE.' -ForegroundColor Red
    Write-Host 'Stang Chrome helt och kor om, eller kor utan -AnvandVanligProfil.'
    exit 1
  }
  Write-Host 'Profil: din vanliga (alla flikar och tillagg kvar)'
} else {
  $profil = Join-Path $env:LOCALAPPDATA 'Polisvakt\chrome-brygga'
  if (-not (Test-Path $profil)) { New-Item -ItemType Directory -Force -Path $profil | Out-Null }
  # Egen profil betyder egna tillagg. Utan den har raden skulle Chrome
  # ladda noll tillagg dar, vilket ar bra -- men bryggan maste undantas.
  $argument = @("--user-data-dir=`"$profil`"", "--disable-extensions-except=`"$tillagg`"") + $argument
  Write-Host "Profil: $profil"
}

Write-Host "Tillagg: $tillagg"
Start-Process -FilePath $chrome -ArgumentList $argument

Write-Host ''
Write-Host 'Bryggfönstret är startat.' -ForegroundColor Green
Write-Host ''
Write-Host 'FORSTA GANGEN maste tillagget las in for hand en gang:'
Write-Host '  1. Oppna chrome://extensions'
Write-Host '  2. Sla pa Utvecklarlage uppe till hoger'
Write-Host '  3. Las in okomprimerat -> valj mappen:'
Write-Host "     $tillagg" -ForegroundColor Cyan
Write-Host '  4. Ladda om gruppsidan'
Write-Host ''
Write-Host 'Chrome tog bort --load-extension av sakerhetsskal, sa det gar'
Write-Host 'inte att gora fran kommandoraden langre. Efter steg 1-3 ligger'
Write-Host 'tillagget kvar och laddas automatiskt varje gang.'
Write-Host ''
Write-Host 'Kontrollera i konsolen (F12) att det star:'
Write-Host "  [Polisvakt] Facebook-bryggan ar igang for grupp $GruppId"
Write-Host ''
Write-Host 'Skriptet star i torrkorning och skriver ingenting till databasen.'
Write-Host 'Vad det hade skickat ser du med:  __polisvakt.stats()'
Write-Host ''
Write-Host 'Fonstret far minimeras eller tackas over. Det far INTE stangas.'
Write-Host ''
Write-Host 'Forsta svepet efter varje sidladdning ar ett kalibreringssvep:'
Write-Host 'allt som redan ligger i flodet registreras men skickas aldrig.'
Write-Host 'Bara inlagg som dyker upp DAREFTER far en alder. Sa slipper du en'
Write-Host 'skur farska varningar ur ett veckogammalt flode vid varje omstart.'
