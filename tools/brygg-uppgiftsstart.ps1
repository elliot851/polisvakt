# Startas av Schemaläggaren. Startar i sin tur daemonen — i ETT EGET FÖNSTER.
#
# ------------------------------------------------------------------------
# VARFÖR DET HÄR MELLANLAGRET FINNS
#
# Uppgiften pekade förut rakt på brygg-daemon.ps1. Den startade, processen
# levde, den drog CPU — och den skrev inte en enda rad i loggen. Inte ens sin
# egen STARTrad. Startad för hand med exakt samma argument, samma användare
# och samma arbetskatalog gick allt igenom.
#
# Miljön uteslöts med tools\brygg-diag.ps1, som körs som en egen uppgift och
# gör precis det daemonen gör innan sin första loggrad:
#
#   användare      GNUGGDATORN2\ellio        (samma)
#   LOCALAPPDATA   C:\Users\ellio\AppData\Local  (samma)
#   Console::OutputEncoding                   ok
#   skrivning i LOCALAPPDATA\Polisvakt        ok
#   Write-Host                                ok
#   Global-mutex                              ok, nyskapad
#   läsning av fb-bridge.user.js              ok, 85483 tecken
#
# Allt grönt. Skillnaden sitter alltså inte i rättigheter, sökvägar eller
# teckenkodning, utan i själva processen Schemaläggaren skapar — den saknar
# ett riktigt konsolfönster, och något i den långa körningen tystnar av det.
#
# Att omdirigera med `*>` provades också. Uppgiften startade då, men daemonens
# egen logg slutade skrivas helt: allt hamnade i omdirigeringsfilen, i UTF-16,
# och den nollställs vid varje start. Två loggar där den ena tyst ersätter den
# andra är sämre än en.
#
# ------------------------------------------------------------------------
# LÖSNINGEN
#
# Start-Process ger barnet ett eget, riktigt konsolfönster — samma sorts
# process som när man startar bryggan för hand, vilket bevisligen fungerar.
#
# -Wait är inte valfritt. Utan det avslutas den här processen direkt,
# uppgiften räknas som klar, och Schemaläggarens "starta om om den dör" har
# ingenting kvar att vaka över. Med -Wait lever uppgiften exakt så länge
# daemonen gör, och omstarterna fungerar som de ska.
#
# Fönstret startas minimerat. Inte dolt: ett dolt fönster har redan kostat
# den här kodbasen en felsökning, eftersom Chrome-automation beter sig annor-
# lunda när fönstret aldrig ritas. Minimerat är synligt för Windows och ur
# vägen för människan.

param(
  [int]$Felsokningsport = 9222,
  [string[]]$GruppId = @(),
  [switch]$Torr
)

$ErrorActionPreference = 'Stop'

$daemon = Join-Path $PSScriptRoot 'brygg-daemon.ps1'
if (-not (Test-Path $daemon)) { throw "Hittar inte $daemon" }

# Sökvägen MÅSTE citeras. Start-Process fogar ihop -ArgumentList med mellanslag
# och citerar ingenting åt en, och repot ligger under "Claude code 2GNDTN".
# Ociterad blev raden `-File C:\Users\ellio\OneDrive\Claude` och PowerShell
# avslutade på en tusendel utan att skriva någonstans. Det såg ut som att
# daemonen tystnade igen, fast den aldrig startade. Samma fälla har redan
# kostat det här projektet en felsökning i Chromes kommandorad.
$arg = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', ('"' + $daemon + '"'),
  '-Felsokningsport', [string]$Felsokningsport
)
foreach ($g in @($GruppId)) { if ($g) { $arg += @('-GruppId', $g) } }
if ($Torr) { $arg += '-Torr' }

# Spår för den dag även DET HÄR steget tystnar. Rå .NET-IO, ingen logg-
# funktion, inget som kan vara trasigt.
$spar = Join-Path (Join-Path $env:LOCALAPPDATA 'Polisvakt') 'brygg-uppgiftsstart.txt'
try {
  [System.IO.File]::AppendAllText($spar,
    ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  startar daemonen' + [Environment]::NewLine),
    (New-Object System.Text.UTF8Encoding($true)))
} catch { }

Start-Process -FilePath 'powershell.exe' -ArgumentList $arg `
  -WorkingDirectory (Split-Path -Parent $PSScriptRoot) `
  -WindowStyle Minimized -Wait

try {
  [System.IO.File]::AppendAllText($spar,
    ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  daemonen avslutades' + [Environment]::NewLine),
    (New-Object System.Text.UTF8Encoding($true)))
} catch { }
