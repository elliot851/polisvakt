# Startar om bryggan om den dött. Körs av Schemaläggaren var femte minut.
#
# ------------------------------------------------------------------------
# VARFÖR DEN FINNS
#
# 22 aug 2026 dog daemonen 20:17:43 — mitt i en rad, utan felmeddelande — och
# låg död i fyrtiofem minuter innan någon tittade. Ingenting startade om den.
# Autostart-mappen kör en gång vid inloggning, och den schemalagda uppgiften
# var avstängd eftersom en LÅNGKÖRANDE uppgift under Schemaläggaren blir tyst
# (se brygg-uppgiftsstart.ps1 för hela den utredningen).
#
# Den här filen är motsatsen till den: den lever i tre sekunder, kollar en
# sak och avslutar. En kortlivad uppgift drabbas inte av tystnaden, eftersom
# den aldrig behöver logga något under drift — den startar bara barnet i ett
# eget fönster, precis som ett dubbelklick, och det fungerar bevisligen.
#
# ------------------------------------------------------------------------
# PROCESSRÄKNINGEN, OCH FÄLLAN SOM REDAN LURAT EN GÅNG
#
# Att leta efter processer vars kommandorad innehåller 'brygg-daemon' hittar
# OCKSÅ den PowerShell som ställer frågan — söksträngen står ju i dess egen
# kommandorad. Den fällan gjorde att bryggan såg levande ut under två hela
# kontroller medan den i själva verket var död.
#
# Därför två villkor: kommandoraden ska innehålla filnamnet MED ändelse, och
# den får inte innehålla CimInstance. Och därför räknas alltid noll ut
# explicit i stället för att lita på att listan är tom.

param(
  # Torrkörning: säger vad den skulle gjort, gör ingenting.
  [switch]$Torr,

  # Gå runt för alltid i stället för att kolla en gång och avsluta.
  #
  # DET HÄR ÄR DET LÄGE SOM FAKTISKT ANVÄNDS, och skälet är mätt:
  # Schemaläggaren ger tysta barn. En daemon startad av en schemalagd uppgift
  # lever, drar CPU och skriver inte en rad — inte ens sin egen STARTrad.
  # Tystnaden ÄRVS: varken Start-Process eller cmd /c start från en
  # schemalagd förälder räddar barnet. Tre paketeringar provades, alla tysta.
  #
  # Autostart-mappen startas däremot av Utforskaren i den vanliga
  # interaktiva sessionen, och den vägen både startar och loggar. Alltså bor
  # vakten där, bredvid bryggan, som ett syskon i samma session — inte i
  # Schemaläggaren ovanför den.
  [switch]$Loop,

  [int]$IntervallSek = 60
)

$ErrorActionPreference = 'Stop'

$spar = Join-Path (Join-Path $env:LOCALAPPDATA 'Polisvakt') 'brygg-vakt.log'
function Notera([string]$t) {
  try {
    [System.IO.File]::AppendAllText($spar,
      ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $t + [Environment]::NewLine),
      (New-Object System.Text.UTF8Encoding($true)))
  } catch { }
}

# Loopläget: samma kontroll om och om igen, i EN process i den interaktiva
# sessionen. Startar om sig själv via anropet nedan, så all logik nedanför
# finns bara i ett exemplar.
if ($Loop) {
  Notera ('Vakten startad i loopläge, kollar var ' + $IntervallSek + ':e sekund.')
  $mig = $PSCommandPath
  while ($true) {
    try {
      & $mig   # en runda, utan -Loop
    } catch {
      Notera ('Vaktrundan kastade: ' + $_.Exception.Message)
    }
    Start-Sleep -Seconds $IntervallSek
  }
}

$levande = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object {
    $_.CommandLine -like '*brygg-daemon.ps1*' -and
    $_.CommandLine -notlike '*CimInstance*' -and
    $_.CommandLine -notlike '*brygg-vakt*'
  })

# Räknas ut explicit. Att lita på att en tom lista är falsk har redan lurat
# den här filens författare en gång: @() är falskt men $null.Count är 0 och
# en enstaka process är inte en array alls.
$antalLevande = $levande.Count

if ($antalLevande -gt 0) {
  # Ingen loggrad när allt är bra. En vakt som skriver en rad var femte minut
  # dygnet runt gör loggen oläslig, och det är loggen man går till när något
  # gått fel.
  exit 0
}

# ------------------------------------------------------------------------
# DEN DOG. Innan omstart: är kopian i Chrome-tillägget i takt?
#
# Daemonen vägrar starta när tools\brygg-tillagg\brygga.js glidit isär från
# tools\fb-bridge.user.js, eftersom det är kopian Chrome faktiskt kör. Det
# var exakt det som hände 22 aug: ett bygge uppdaterade bryggkoden, kopian
# lämnades kvar, och varje omstartsförsök dog på samma rad. En vakt som bara
# startar om hade snurrat i evighet på ett fel den kunnat laga på en rad.
$rot     = Split-Path -Parent $PSScriptRoot
$kalla   = Join-Path $PSScriptRoot 'fb-bridge.user.js'
$kopia   = Join-Path $PSScriptRoot 'brygg-tillagg\brygga.js'
$daemon  = Join-Path $PSScriptRoot 'brygg-daemon.ps1'

if ((Test-Path $kalla) -and (Test-Path $kopia)) {
  $a = (Get-FileHash -Algorithm MD5 $kalla).Hash
  $b = (Get-FileHash -Algorithm MD5 $kopia).Hash
  if ($a -ne $b) {
    if ($Torr) {
      Notera 'TORR: kopian i tillagget har glidit isar, skulle synkats.'
    } else {
      Copy-Item -Path $kalla -Destination $kopia -Force
      Notera 'Kopian i brygg-tillagg synkad mot fb-bridge.user.js.'
    }
  }
}

if ($Torr) {
  Notera 'TORR: bryggan ar dod, skulle startats.'
  exit 0
}

# STARTAS GENOM cmd /c start, INTE genom Start-Process. Provat, och skillnaden
# är hela funktionen.
#
# En process som Schemaläggaren skapar ger tysta barn: daemonen startar, lever,
# drar CPU och skriver inte en enda rad — inte ens sin egen STARTrad. Samma
# tystnad som utreddes i brygg-uppgiftsstart.ps1, och den ärvs nedåt. Ett
# Start-Process från vakten räckte inte: barnbarnet blev lika tyst.
#
# cmd:ets `start` skapar däremot en HELT NY konsol och kopplar loss barnet från
# förälderns. Det är exakt vad Autostart-filen gör, och den vägen både startar
# och loggar. Mätt 22 aug: Start-Process -> noll loggrader, cmd start -> full
# logg inom sekunder.
#
# Tomma "" är fönstertiteln och MÅSTE stå där. Utan den tolkar cmd den citerade
# sökvägen som titel och startar ingenting alls — ett tyst fel av precis den
# sort som redan kostat den här filen en runda.
$rad = 'start "Polisvakt-brygga" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $daemon + '"'
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $rad) `
  -WorkingDirectory $rot -WindowStyle Hidden

Notera 'Bryggan var dod. Startade om den.'
exit 0
