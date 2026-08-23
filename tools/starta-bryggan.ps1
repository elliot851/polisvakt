# ERSATT — den här filen pekar bara vidare numera.
#
# Bryggfönstret startas inte längre av en människa. tools\brygg-daemon.ps1
# öppnar det själv när felsökningsporten är död (se Starta-Bryggfonstret i den
# filen), inklusive kontrollen som förut bara fanns här: en redan körande
# Chrome med SAMMA profilmapp gör att uppstartsflaggorna ignoreras, porten
# öppnas aldrig, och man får ett fönster som ser rätt ut och läser ingenting.
#
# Filen är kvar med FLIT och ska inte raderas. Den står i README, i
# MANUELLT.md, i NIGHT_LOG.md, i felmeddelanden och sannolikt i en genväg på
# ägarens skrivbord. En kvarliggande fil som pekar rätt är ofarlig; en raderad
# fil gör varje sådan rad till en återvändsgränd.
#
# Buggen som fanns här är samtidigt borta: -Daemon startade daemonen utan att
# skicka -Skarpt vidare, så "starta allt" gav en tyst torrkörning.
#
#
# GÖR SÅ HÄR I STÄLLET
#
#   Kör nu:              .\tools\polisvakt-brygga.ps1
#   Starta med Windows:  .\tools\polisvakt-brygga.ps1 -Installera
#
# Alla flaggor som betydde något här tas emot nedan och skickas vidare.

param(
  # TOMT = alla grupper i CONFIG.groupIds i tools\fb-bridge.user.js.
  #
  # Stod här ett hårdkodat id fram till 2.4, och den här filen skickade det
  # ALLTID vidare. Följden efter att bryggan blev flergrupps hade varit att
  # varje start via den här genvägen tyst pinnade daemonen vid Västerås, så en
  # nyss tillagd Stockholmsgrupp aldrig lästes. En genväg som tar bort
  # funktioner man just lagt till är värre än en genväg som inte finns.
  [string[]]$GruppId = @(),
  [int]$Felsokningsport = 9222,

  # Fanns förut. Betyder ingenting längre: fönstret och läsningen startas
  # alltid tillsammans.
  [switch]$Daemon,

  # Fanns förut. Bryggan kör numera alltid i sin egen profil — det är den
  # profil DPAPI-nyckeln, kakorna och den inloggade sessionen hör ihop med.
  [switch]$AnvandVanligProfil,

  # Torrkörning, skickas vidare.
  [switch]$Torr
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Write-Host ''
Write-Host '  starta-bryggan.ps1 är ersatt av polisvakt-brygga.ps1.' -ForegroundColor Yellow
Write-Host '  Ett kommando startar numera både fönstret och läsningen, skarpt som förval.' -ForegroundColor DarkGray
Write-Host ''

if ($AnvandVanligProfil) {
  Write-Host '  -AnvandVanligProfil finns inte längre. Bryggan kör i sin egen profil:' -ForegroundColor Yellow
  Write-Host ('  ' + (Join-Path $env:LOCALAPPDATA 'Polisvakt\chrome-brygga')) -ForegroundColor DarkGray
  Write-Host '  Är den inte inloggad på Facebook loggar du in i fönstret som öppnas. En gång.' -ForegroundColor DarkGray
  Write-Host ''
}

$nasta = Join-Path $PSScriptRoot 'polisvakt-brygga.ps1'
if (-not (Test-Path $nasta)) {
  Write-Host "Hittar inte $nasta" -ForegroundColor Red
  exit 1
}

$argument = @{
  Felsokningsport = $Felsokningsport
}
# Skickas bara när någon uttryckligen bett om ett filter.
if (@($GruppId | Where-Object { $_ }).Count -gt 0) {
  $argument['GruppId'] = @($GruppId | Where-Object { $_ })
}
if ($Torr) { $argument['Torr'] = $true }

& $nasta @argument
exit $LASTEXITCODE
