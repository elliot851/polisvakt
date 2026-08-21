# Startar bryggfönstret: ett eget Chrome med felsökningsporten öppen.
#
# VAD DEN HÄR FILEN GÖR NUMERA
#
# Den startar Chrome med en egen profil, gruppen öppen och
# --remote-debugging-port. Den installerar INGENTING i webbläsaren, och den
# behöver inte göra det heller. Läsandet sköts av tools\brygg-daemon.ps1, som
# injicerar bryggkoden över felsökningsporten vid varje sidladdning.
#
#   1.  .\starta-bryggan.ps1        <- fönstret (den här filen)
#   2.  .\brygg-daemon.ps1          <- läsningen (torrkörning som förval)
#
# Med -Daemon startas båda i ett svep.
#
#
# VARFÖR INGET TILLÄGG OCH INGEN TAMPERMONKEY
#
# Fyra vägar att få in koden i sidan är uttömda och ska inte provas igen:
#
#   Tampermonkey        installationssidan ligger på chrome-extension://, och
#                       Chrome blockerar all automation där.
#   --load-extension    borttagen i Chrome 151. Verifierat isolerat: tillägget
#                       laddades inte, window.__polisvakt fanns inte.
#   Tillägg för hand    ÄR inläst och aktiverat i profilen nedan
#                       (id gkfpgohonkfahcafjejfhdajbaiiolom,
#                       disable_reasons: [], rätt scriptable_host) — men
#                       innehållsskriptet injiceras aldrig: noll konsolrader,
#                       tomt localStorage. Orsaken syns bara i
#                       chrome://extensions, som inte går att läsa maskinellt.
#   Hämta koden in      Facebooks CSP blockerar fetch mot både GitHub och
#                       localhost, och window.name rensas numera vid
#                       navigering mellan domäner.
#
# Uteslutet också: OneDrive-platshållare. Filerna är fullt lokala, kontrollerat.
#
# Kvar står felsökningsporten, och den fungerar. Page.addScriptToEvaluateOnNewDocument
# injicerar vid varje sidladdning och Runtime.evaluate kör kod nu. Injicerad
# kod lyder inte under sidans CSP.
#
#
# FLAGGORNA MOT TIMER-STRYPNING
#
# Chrome strypar timers i bakgrundsflikar. Uppmätt i en riktig dold flik över
# tolv minuter: ett svep på tjugo sekunder håller i ungefär två minuter och
# går sedan till en gång i minuten. Övertäckta fönster kan pausas helt.
#
#   --disable-background-timer-throttling      timers går i full takt
#   --disable-backgrounding-occluded-windows   övertäckt fönster pausas inte
#   --disable-renderer-backgrounding           renderaren nedprioriteras inte
#
# Ingen av dem rör säkerhet, sandlåda eller certifikat. Det här är inte "kör
# Chrome osäkert" — det är "låt den här fliken fortsätta räkna".
#
# Med daemonen betyder strypningen mindre än förut: svepklockan ligger numera
# i PowerShell, utanför sidan, och den stryps inte. Flaggorna är kvar för att
# sidans egen rendering och MutationObserver också ska hålla takten.
#
#
# EGEN PROFIL MED FLIT
#
# Bryggan får egna kakor och en egen Facebook-session, skild från den du
# surfar med. Du loggar in en gång här, och ett eventuellt problem med kontot
# rör inte din vanliga profil.
#
#   Kör:              .\starta-bryggan.ps1
#   Fönster + läsning: .\starta-bryggan.ps1 -Daemon
#   Annan grupp:      .\starta-bryggan.ps1 -GruppId 1234567890
#   Vanlig profil:    .\starta-bryggan.ps1 -AnvandVanligProfil

param(
  [string]$GruppId = '317968668373072',
  [int]$Felsokningsport = 9222,
  [switch]$AnvandVanligProfil,

  # Starta även tools\brygg-daemon.ps1 i ett eget fönster, i torrkörning.
  [switch]$Daemon
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

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

function Porten-Svarar {
  param([int]$Port)
  try {
    $v = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/json/version") -TimeoutSec 3
    return $v.Browser
  } catch { return $null }
}

# Svarar porten redan finns fönstret. Att starta ett till skulle inte hjälpa:
# Chrome skickar bara adressen vidare till den instans som redan kör, och
# flaggorna ignoreras. Förut startades ett andra fönster tyst, vilket ser
# likadant ut som allt annat som går fel här.
$redan = Porten-Svarar -Port $Felsokningsport
if ($redan) {
  Write-Host "Bryggfönstret kör redan ($redan) på 127.0.0.1:$Felsokningsport." -ForegroundColor Green
} else {

  $argument = @(
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    # Felsökningsporten är hela vägen in i sidan. Den lyssnar bara på
    # 127.0.0.1 och bara så länge fönstret är öppet.
    "--remote-debugging-port=$Felsokningsport",
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    "https://www.facebook.com/groups/$GruppId/"
  )

  # Tillägget läses in om mappen finns. Det gör i praktiken ingenting — se
  # listan över uttömda vägar högst upp — men flaggan skadar inte, och den
  # dag Google ändrar sig igen ligger den kvar. Att INTE kunna hitta mappen
  # är sedan daemonen finns inte längre ett skäl att vägra starta.
  $tillagg = Join-Path $PSScriptRoot 'brygg-tillagg'
  $harTillagg = Test-Path (Join-Path $tillagg 'manifest.json')

  if ($AnvandVanligProfil) {
    # Din vanliga profil: redan inloggad, alla flikar kvar. Priset är att
    # Chrome läser uppstartsflaggorna bara när processen startar, så allt
    # måste vara stängt först.
    $kor = Get-Process chrome -ErrorAction SilentlyContinue
    if ($kor) {
      Write-Host 'Chrome kör redan. Flaggorna ignoreras då, och felsökningsporten öppnas INTE.' -ForegroundColor Red
      Write-Host 'Stäng Chrome helt och kör om, eller kör utan -AnvandVanligProfil.'
      exit 1
    }
    Write-Host 'Profil: din vanliga (alla flikar och tillägg kvar)'
  } else {
    $profil = Join-Path $env:LOCALAPPDATA 'Polisvakt\chrome-brygga'
    if (-not (Test-Path $profil)) { New-Item -ItemType Directory -Force -Path $profil | Out-Null }
    # Citattecken runt sökvägen, inte för snygghetens skull. Repot ligger
    # under "Claude code 2GNDTN" — två mellanslag. Utan citattecken delar
    # Windows argumentet vid dem, och Chrome tolkade bitarna som adresser.
    $argument = @("--user-data-dir=`"$profil`"") + $argument
    if ($harTillagg) {
      $argument = @("--disable-extensions-except=`"$tillagg`"", "--load-extension=`"$tillagg`"") + $argument
    }
    Write-Host "Profil: $profil"
  }

  Start-Process -FilePath $chrome -ArgumentList $argument
  Write-Host 'Startar bryggfönstret...'

  # Vänta in porten i stället för att skriva "klart" och hoppas. Utan den här
  # slingan var enda sättet att veta om något gick fel att bryggan var tyst,
  # och tyst ser likadant ut som allt annat som går fel här.
  $uppe = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 1000
    $uppe = Porten-Svarar -Port $Felsokningsport
    if ($uppe) { break }
  }
  if (-not $uppe) {
    Write-Host "Felsökningsporten svarade aldrig på 127.0.0.1:$Felsokningsport." -ForegroundColor Red
    Write-Host 'Utan den kan daemonen inte läsa. Vanligaste orsaken: en Chrome med samma'
    Write-Host 'profil kör redan utan porten. Stäng den och kör om.'
    exit 1
  }
  Write-Host "Felsökningsporten svarar: $uppe" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Fönstret får minimeras eller täckas över. Det får INTE stängas.'
Write-Host ''
Write-Host 'Är du inte inloggad på Facebook i det här fönstret: logga in nu.'
Write-Host 'Det behöver bara göras en gång per profil.'
Write-Host ''

$daemonfil = Join-Path $PSScriptRoot 'brygg-daemon.ps1'

if ($Daemon) {
  if (-not (Test-Path $daemonfil)) {
    Write-Host "Hittar inte $daemonfil" -ForegroundColor Red
    exit 1
  }
  Write-Host 'Startar brygg-daemon.ps1 i ett eget fönster (torrkörning).' -ForegroundColor Cyan
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$daemonfil`"", '-GruppId', $GruppId, '-Felsokningsport', $Felsokningsport
  )
} else {
  Write-Host 'Läsningen startas separat:' -ForegroundColor Cyan
  Write-Host '  powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1' -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'Den står i torrkörning och skriver ingenting till databasen. Vad den'
  Write-Host 'HADE skickat står i loggen, med texten för varje inlägg. Först när du'
  Write-Host 'sett rätt saker i loggen: lägg till -Skarpt.'
}

Write-Host ''
Write-Host 'Första svepet efter varje sidladdning är ett kalibreringssvep: allt som'
Write-Host 'redan ligger i flödet registreras men får aldrig en observerad ålder.'
Write-Host 'Bara inlägg som dyker upp DÄREFTER tidsbestäms. Så slipper du en skur'
Write-Host 'färska varningar ur ett veckogammalt flöde vid varje omstart — och så'
Write-Host 'måste daemonen få ligga på för att fånga något.'
