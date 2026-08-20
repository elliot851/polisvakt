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

$argument = @(
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--new-window',
  "https://www.facebook.com/groups/$GruppId/"
)

if (-not $AnvandVanligProfil) {
  $profil = Join-Path $env:LOCALAPPDATA 'Polisvakt\chrome-brygga'
  if (-not (Test-Path $profil)) { New-Item -ItemType Directory -Force -Path $profil | Out-Null }
  $argument = @("--user-data-dir=$profil") + $argument
  Write-Host "Profil: $profil"
}

Start-Process -FilePath $chrome -ArgumentList $argument

Write-Host ''
Write-Host 'Bryggfönstret är startat.' -ForegroundColor Green
Write-Host ''
Write-Host 'Forsta gangen, i det nya fonstret:'
Write-Host '  1. Logga in pa Facebook.'
Write-Host '  2. Installera Tampermonkey fran Chrome Web Store.'
Write-Host '  3. Oppna adressen nedan och tryck Installera:'
Write-Host '     https://raw.githubusercontent.com/elliot851/polisvakt/main/tools/fb-bridge.user.js' -ForegroundColor Cyan
Write-Host '  4. Ladda om gruppsidan.'
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
