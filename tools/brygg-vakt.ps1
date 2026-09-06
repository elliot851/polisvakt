# =====================================================================
#  Polisvakt — brygg-vakt.ps1
#  Vakthund över brygg-daemon.ps1. Mäter LIVSTECKEN, inte processer.
# =====================================================================
#
# ---------------------------------------------------------------------
#  VARFÖR DEN SKREVS OM (5 sep 2026)
# ---------------------------------------------------------------------
#
# Bryggan dog 2026-09-05 15:51:45 och låg död i sexton timmar utan att
# någon märkte det. Vakten körde hela tiden. Den sa ingenting.
#
# Så här gick det till, rad för rad ur loggarna:
#
#   15:50:11  datorn startade om
#   15:51:41  Autostart-mappen startade vakten (loopläge, var 60:e sekund)
#   15:51:42  Autostart-mappen startade daemonen
#   15:51:45  daemonen: "Felsökningsporten svarar inte på 127.0.0.1:9222.
#             Bryggfönstret öppnas automatiskt, se nästa rad."
#             — och nästa rad kom aldrig. Anropet till Starta-Bryggfonstret
#             returnerade aldrig. Processen levde vidare, tyst.
#   16 timmar ingenting, i BÅDA loggarna.
#
# FYRA fel samverkade, och varenda ett räcker för att döda bevakningen:
#
#   1. FEL MÅTT. Den gamla vakten räknade processer med Get-CimInstance.
#      En hängd daemon ÄR en process. Kontrollen svarade "levande" var
#      minut i sexton timmar medan bryggan inte läste en enda rad.
#
#   2. TYSTNAD SOM DESIGN. Den gamla filen hade en kommentar som sa att
#      man med flit inte loggar när allt är bra, för att hålla loggen
#      läsbar. Följden: loggen kunde inte skilja "vakten kollade, allt
#      var bra" från "vakten är död sedan i förrgår". En tyst vakt är
#      inte en vakt — den är ett antagande.
#
#   3. ÖMSESIDIG BEVAKNING SOM HÄNGER IHOP MED SIG SJÄLV. Daemonen har
#      Kolla-Vaktens-Puls som startar om vakten. Men den funktionen körs
#      från daemonens huvudloop. Hänger daemonen hänger också den kollen.
#      Och vakten godkände just den hängda daemonen. Båda "vaktade"
#      varandra och båda tittade åt fel håll samtidigt. Den schemalagda
#      uppgiften "Polisvakt-vakt" är dessutom Disabled, så det fanns inget
#      utanför sessionen som kunde upptäcka det.
#
#   4. INGEN SPÄRR MOT FLERA VAKTER. 15:45:18 och 15:46:22 startade
#      bryggan om två gånger på en minut. Ingen backoff, ingen
#      enkelinstans-spärr.
#
#   Och en femte, som gjorde loggen halvläslig: filen saknade BOM.
#   Windows PowerShell 5.1 läser en BOM-lös .ps1 som ANSI, så
#   "loopläge" blev "looplÃ¤ge" i vaktens egen logg. Den här filen är
#   sparad som UTF-8 MED byte-order-märke. Rör inte det.
#
# ---------------------------------------------------------------------
#  VAD DEN GÖR I STÄLLET
# ---------------------------------------------------------------------
#
#   * LIVSTECKEN, inte processräkning. Måttet är daemonens egen logg:
#     hur länge sedan skrevs den senaste raden, och hur länge sedan
#     skrevs den senaste SVEP/SUMMA-raden. En frisk daemon skriver SVEP
#     var tjugonde sekund. En daemon som väntar på bryggfönstret skriver
#     VÄNTAR var femtiofemte. Skriver den ingenting alls är den död,
#     oavsett vad processlistan påstår.
#
#   * EN RAD I LOGGEN VID VARJE KONTROLL, även "allt bra". Loggen ska
#     kunna svara på frågan "kollade någon klockan 03:00 i natt?".
#     Filen trimmas automatiskt när den passerar 1 MB, så läsbarheten
#     löses av trimningen och inte av tystnad.
#
#   * DÖDAR INNAN DEN STARTAR OM. En hängd daemon håller fortfarande den
#     namngivna mutexen Global\Polisvakt-Brygga. Startar man en ny utan
#     att stoppa den gamla säger den bara "En brygg-daemon kör redan" och
#     avslutar — omstarten ser ut att lyckas och ingenting händer. Den
#     gamla vakten slapp problemet eftersom den bara startade om när
#     processen redan var borta.
#
#   * EXPONENTIELL BACKOFF: 1, 2, 4, 8, 16, 32, 60, 60 ... minuter
#     mellan omstartsförsök, nollställd så fort en kontroll blir GRÖN.
#
#   * ENKELINSTANS via Global\Polisvakt-Vakt i loopläge.
#
#   * TORRKÖRNING SOM STANDARD. Se nästa stycke.
#
# ---------------------------------------------------------------------
#  TORRKÖRNING — PÅ SOM STANDARD, OCH HUR MAN SLÅR AV DEN
# ---------------------------------------------------------------------
#
#  Just nu gör vakten ALLT utom att faktiskt röra en process: den mäter,
#  bedömer, loggar exakt vad den skulle gjort — och stannar där. Ingen
#  Chrome öppnas, inget fönster dyker upp, ingenting startas.
#
#  SÅ HÄR SLÅR MAN AV TORRKÖRNINGEN, tre vägar, välj en:
#
#    1. För ett enstaka skarpt körtillfälle — lägg till -Skarp:
#         powershell -NoProfile -File tools\brygg-vakt.ps1 -Skarp
#
#    2. Permanent för loopen i Autostart-mappen — lägg till -Skarp i
#       %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
#       Polisvakt-brygga.cmd, på raden som startar brygg-vakt.ps1:
#         ... -File "...\tools\brygg-vakt.ps1" -Loop -Skarp
#
#    3. Permanent i den här filen — sätt $TORRKORNING_SOM_STANDARD till
#       $false. Den står strax NEDANFÖR param-blocket, eftersom
#       PowerShell kräver att param() är det första som inte är en
#       kommentar i filen. Då blir skarpt läge standard igen och
#       -Torrkor behövs för att få tillbaka torrkörningen.
#
#  -Torrkor vinner alltid över -Skarp. Det är med flit: ska man prova
#  något är det säkrare att en flagga för mycket ger tystnad än att en
#  flagga för mycket öppnar fönster.

param(
  # Gör allt utom att faktiskt stoppa/starta något. PÅ som standard, se ovan.
  [switch]$Torrkor,

  # Slår av torrkörningen för den här körningen.
  [switch]$Skarp,

  # Gammalt namn på -Torrkor. Behålls så att äldre genvägar inte tystnar.
  [switch]$Torr,

  # Gå runt för alltid i stället för att kolla en gång och avsluta.
  #
  # DET HÄR ÄR DET LÄGE SOM FAKTISKT ANVÄNDS, och skälet är mätt:
  # Schemaläggaren ger tysta barn. En daemon startad av en schemalagd
  # uppgift lever, drar CPU och skriver inte en rad — inte ens sin egen
  # STARTrad. Tystnaden ÄRVS: varken Start-Process eller cmd /c start
  # från en schemalagd förälder räddar barnet. Tre paketeringar provades,
  # alla tysta. Autostart-mappen startas däremot av Utforskaren i den
  # vanliga interaktiva sessionen, och den vägen både startar och loggar.
  # Alltså bor vakten där, bredvid bryggan, som ett syskon i samma
  # session — inte i Schemaläggaren ovanför den.
  [switch]$Loop,

  [int]$IntervallSek = 60,

  # Så länge får daemonens logg vara helt tyst innan det räknas som
  # hängläge. En frisk daemon skriver var 20:e sekund, en väntande var
  # 55:e. Fem minuter är alltså sju gånger den längsta normala tystnaden.
  [int]$TystnadMin = 5,

  # Så länge får det gå utan ett enda SVEP/SUMMA innan det räknas som
  # blind daemon: den skriver, men den läser inte gruppen. Längre än
  # tystnadsgränsen, eftersom omladdning och sidfel kan äta några minuter
  # utan att något är trasigt.
  [int]$SvepTystnadMin = 15,

  # Taket för backoffen i minuter.
  [int]$BackoffTakMin = 60
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------
#  TORRKÖRNINGENS STANDARDVÄRDE — den enda raden man behöver ändra för
#  att släppa vakten skarp permanent. Se det långa stycket i filhuvudet.
# ---------------------------------------------------------------------
$TORRKORNING_SOM_STANDARD = $true      # <-- $false = skarpt läge som standard

# ---------------------------------------------------------------------
#  Vad gäller: torrkörning eller skarpt?
# ---------------------------------------------------------------------
$Torrt = $TORRKORNING_SOM_STANDARD
if ($Skarp)   { $Torrt = $false }
if ($Torrkor) { $Torrt = $true }   # -Torrkor vinner, med flit
if ($Torr)    { $Torrt = $true }   # gamla namnet

# ---------------------------------------------------------------------
#  Sökvägar
# ---------------------------------------------------------------------
$DataMapp   = Join-Path $env:LOCALAPPDATA 'Polisvakt'
if (-not (Test-Path $DataMapp)) { New-Item -ItemType Directory -Force -Path $DataMapp | Out-Null }

$VaktLogg   = Join-Path $DataMapp 'brygg-vakt.log'
$Tillstand  = Join-Path $DataMapp 'brygg-vakt-tillstand.json'
$RotMapp    = Split-Path -Parent $PSScriptRoot
$DaemonFil  = Join-Path $PSScriptRoot 'brygg-daemon.ps1'
$Kallfil    = Join-Path $PSScriptRoot 'fb-bridge.user.js'
$Kopiefil   = Join-Path $PSScriptRoot 'brygg-tillagg\brygga.js'
$Felsokningsport = 9222

# UTF-8 MED byte-order-märke. Samma skäl som i daemonen: utan BOM läser
# Windows PowerShell filen som ANSI och `type brygg-vakt.log` ger
# "looplÃ¤ge". AppendAllText skriver märket bara när filen skapas.
$Kodning = New-Object System.Text.UTF8Encoding($true)

# =====================================================================
#  Loggning — en rad per kontroll, och filen trimmar sig själv
# =====================================================================

function Notera {
  param([string]$Niva, [string]$Text)
  $rad = ('{0}  {1,-5} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Niva, $Text)
  # Tre försök. Loggen skrivs av två processer (vakten och daemonens
  # omstart av vakten) och en krock får inte kosta en kontroll.
  for ($i = 0; $i -lt 3; $i++) {
    try { [System.IO.File]::AppendAllText($VaktLogg, $rad + [Environment]::NewLine, $Kodning); break }
    catch { Start-Sleep -Milliseconds 120 }
  }
  try { Write-Host $rad } catch { }
}

function Trimma-Loggen {
  # En rad per minut dygnet runt blir 1440 rader om dagen. Det är priset
  # för att kunna bevisa att vakten levde, och det är värt det — men
  # filen får inte växa i evighet. Över 1 MB: behåll de sista 3000
  # raderna. Ungefär två dygns kontroller, vilket räcker för varje
  # felsökning som gjorts i det här projektet.
  try {
    if (-not (Test-Path $VaktLogg)) { return }
    if ((Get-Item $VaktLogg).Length -lt 1MB) { return }
    $rader = [System.IO.File]::ReadAllLines($VaktLogg, [System.Text.Encoding]::UTF8)
    if ($rader.Count -le 3000) { return }
    $behall = $rader[($rader.Count - 3000)..($rader.Count - 1)]
    [System.IO.File]::WriteAllLines($VaktLogg, $behall, $Kodning)
    Notera 'INFO' ('Loggen trimmad: behöll de 3000 senaste raderna av ' + $rader.Count + '.')
  } catch { }
}

# =====================================================================
#  Mätningarna
# =====================================================================

<#
  Daemonprocessen.

  FILTRET MÅSTE UTESLUTA VÅR EGEN FRÅGA. Kommandoraden i en CIM-träff
  innehåller söksträngen, så en naiv matchning räknar frågan som ett
  svar. Det felet har redan gjorts en gång i det här projektet: bryggan
  rapporterades levande två gånger medan den låg död, eftersom räkningen
  räknade sina egna kontroller.

  Observera att en träff här INTE betyder att bryggan mår bra. Det var
  hela missen 5 sep. Processen är bara halva svaret; andra halvan är
  loggens ålder längre ner.
#>
function Hitta-Daemon {
  $traff = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*brygg-daemon.ps1*' -and
      $_.CommandLine -notlike '*CimInstance*' -and
      $_.CommandLine -notlike '*brygg-vakt*' -and
      $_.CommandLine -notlike '*brygg-diag*'
    })
  # Räknas ut explicit. Att lita på att en tom lista är falsk har redan
  # lurat den här filens författare en gång: @() är falskt men $null.Count
  # är 0 och en enstaka process är inte en array alls.
  if ($traff.Count -eq 0) { return $null }
  return $traff[0]
}

<#
  Nyaste daemonloggen.

  Mönstret är avsiktligt snävt: brygg-daemon-????-??-??.log. Ett brett
  brygg-daemon-*.log fångar också brygg-daemon-slutmatning.log, som är
  en gammal engångsmätning från augusti och som skulle få varje kontroll
  att tro att bryggan varit tyst i två veckor.
#>
function Hitta-Daemonlogg {
  $f = @(Get-ChildItem -Path $DataMapp -Filter 'brygg-daemon-????-??-??.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
  if ($f.Count -eq 0) { return $null }
  return $f[0]
}

<#
  Läser slutet av en fil som någon annan skriver i just nu.

  FileShare::ReadWrite är inte pynt. Daemonen håller filen öppen i korta
  ögonblick vid varje AppendAllText, och en läsning utan delning kastar
  IOException just då. En vakt som kastar var tjugonde kontroll är en
  vakt man slutar tro på.
#>
function Las-Slutet {
  param([string]$Fil, [int]$MaxByte = 65536)
  $fs = $null
  try {
    $fs = New-Object System.IO.FileStream($Fil, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $start = 0
    if ($fs.Length -gt $MaxByte) { $start = $fs.Length - $MaxByte }
    [void]$fs.Seek($start, [System.IO.SeekOrigin]::Begin)
    $buf = New-Object byte[] ($fs.Length - $start)
    $n = $fs.Read($buf, 0, $buf.Length)
    $txt = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
    $rader = @($txt -split "`r?`n")
    # Hoppade vi in mitt i filen är första raden avhuggen, möjligen mitt
    # i ett tecken. Kasta den.
    if ($start -gt 0 -and $rader.Count -gt 1) { $rader = $rader[1..($rader.Count - 1)] }
    return $rader
  } catch {
    return @()
  } finally {
    if ($fs) { $fs.Dispose() }
  }
}

function Tid-Ur-Rad {
  param([string]$Rad)
  if ($Rad -match '^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)') {
    $t = [DateTime]::MinValue
    if ([DateTime]::TryParse($Matches[1], [ref]$t)) { return $t }
  }
  return $null
}

<#
  Själva livstecknet.

  Två tal, och skillnaden mellan dem är hela poängen:

    sistaRad   — någon rad alls. Bevisar att processen kör kod.
    sistaSvep  — en SVEP- eller SUMMA-rad. Bevisar att den faktiskt
                 LÄSER gruppen. En daemon som skriver VÄNTAR var
                 femtiofemte sekund i timmar är vaken men blind, och det
                 är precis lika värdelöst för den som ska varnas.
#>
function Mat-Livstecken {
  $svar = @{
    logg      = $null
    sistaRad  = $null
    sistaSvep = $null
    utloggad  = $false
    sistText  = ''
  }
  $f = Hitta-Daemonlogg
  if (-not $f) { return $svar }
  $svar.logg = $f

  $rader = Las-Slutet -Fil $f.FullName
  for ($i = $rader.Count - 1; $i -ge 0; $i--) {
    $r = $rader[$i]
    if (-not $r) { continue }
    $t = Tid-Ur-Rad -Rad $r
    if (-not $t) { continue }
    if (-not $svar.sistaRad) { $svar.sistaRad = $t; $svar.sistText = $r.Trim() }
    if (-not $svar.sistaSvep -and $r -match '^\S+ \S+\s+(SVEP|SUMMA)\b') { $svar.sistaSvep = $t }
    if ($svar.sistaRad -and $svar.sistaSvep) { break }
  }

  # ASCII-ONLY matchning med flit, samma skäl som i supabase-keepalive:
  # matchningen ska överleva även om någon råkar spara om den här filen
  # utan BOM. 'utloggad'/'utloggat' och 'BLIND' räcker.
  $svans = ($rader | Select-Object -Last 40) -join "`n"
  if ($svans -match 'utloggad|utloggat|VAKTHUND\s+BLIND') { $svar.utloggad = $true }

  return $svar
}

function Porten-Lyssnar {
  param([int]$Port)
  # Billig lokal kontroll: finns det en lyssnare alls? Om DevTools svarar
  # med giltig JSON är en annan fråga, och den ställer brygg-diag.ps1 —
  # den här körs var minut och ska inte kosta en HTTP-tur.
  try {
    $t = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    return ($t.Count -gt 0)
  } catch { return $false }
}

# =====================================================================
#  Backoff — tillstånd på disk, inte i minnet
# =====================================================================
#
# I minnet hade räknaren nollställts varje gång vakten själv startades om,
# och det är just när den startas om ofta som backoffen behövs. På disk
# överlever den både vakten och en omstart av datorn.

function Las-Tillstand {
  $t = @{ misslyckadeIRad = 0; senasteAtgard = [DateTime]::MinValue }
  try {
    if (Test-Path $Tillstand) {
      $j = Get-Content -Path $Tillstand -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.PSObject.Properties.Name -contains 'misslyckadeIRad') { $t.misslyckadeIRad = [int]$j.misslyckadeIRad }
      if ($j.PSObject.Properties.Name -contains 'senasteAtgard') {
        $d = [DateTime]::MinValue
        if ([DateTime]::TryParse([string]$j.senasteAtgard, [ref]$d)) { $t.senasteAtgard = $d }
      }
    }
  } catch { }
  return $t
}

function Skriv-Tillstand {
  param($T)
  try {
    $o = [pscustomobject]@{
      misslyckadeIRad = $T.misslyckadeIRad
      senasteAtgard   = $T.senasteAtgard.ToString('yyyy-MM-dd HH:mm:ss')
    }
    [System.IO.File]::WriteAllText($Tillstand, ($o | ConvertTo-Json), $Kodning)
  } catch { }
}

function Backoff-Minuter {
  param([int]$Antal)
  if ($Antal -le 0) { return 0 }
  $m = [math]::Pow(2, ($Antal - 1))
  if ($m -gt $BackoffTakMin) { $m = $BackoffTakMin }
  return [int]$m
}

# =====================================================================
#  Åtgärden
# =====================================================================

function Synka-Tillagget {
  # Daemonen VÄGRAR starta när tools\brygg-tillagg\brygga.js glidit isär
  # från tools\fb-bridge.user.js, eftersom det är kopian Chrome faktiskt
  # kör. Det var exakt det som hände 22 aug: ett bygge uppdaterade
  # bryggkoden, kopian lämnades kvar, och varje omstartsförsök dog på
  # samma rad. En vakt som bara startar om hade snurrat i evighet på ett
  # fel den kunnat laga på en rad.
  if (-not ((Test-Path $Kallfil) -and (Test-Path $Kopiefil))) { return }
  try {
    $a = (Get-FileHash -Algorithm MD5 $Kallfil).Hash
    $b = (Get-FileHash -Algorithm MD5 $Kopiefil).Hash
    if ($a -eq $b) { return }
    if ($Torrt) {
      Notera 'TORR' 'Kopian i brygg-tillagg har glidit isär från fb-bridge.user.js. Skulle synkat den.'
    } else {
      Copy-Item -Path $Kallfil -Destination $Kopiefil -Force
      Notera 'INFO' 'Kopian i brygg-tillagg synkad mot fb-bridge.user.js.'
    }
  } catch {
    Notera 'FEL' ('Kunde inte jämföra tilläggets kopia: ' + $_.Exception.Message)
  }
}

<#
  Stoppa en hängd daemon och starta en ny.

  ORDNINGEN ÄR INTE VALFRI. Daemonen tar en namngiven mutex,
  Global\Polisvakt-Brygga, och släpper den först när processen dör.
  Startar man en ny medan den hängda lever säger den nya bara "En
  brygg-daemon kör redan på den här maskinen" och avslutar — i loggen ser
  det ut som att omstarten gjordes, och ingenting har hänt. Därför:
  stoppa först, vänta tills processen verkligen är borta, starta sedan.
#>
function Starta-Om-Bryggan {
  param($Process, [string]$Skal)

  if ($Torrt) {
    $vad = 'TORRKÖRNING: skulle startat om bryggan (' + $Skal + ').'
    if ($Process) { $vad = 'TORRKÖRNING: skulle stoppat pid ' + $Process.ProcessId + ' och startat om bryggan (' + $Skal + ').' }
    Notera 'TORR' $vad
    Notera 'TORR' '        Inget öppnades. Slå av torrkörningen med -Skarp, se filhuvudet i brygg-vakt.ps1.'
    return $false
  }

  if ($Process) {
    try {
      Notera 'ÅTGÄRD' ('Stoppar hängd daemon, pid ' + $Process.ProcessId + '.')
      Stop-Process -Id $Process.ProcessId -Force -ErrorAction Stop
    } catch {
      Notera 'FEL' ('Kunde inte stoppa pid ' + $Process.ProcessId + ': ' + $_.Exception.Message)
    }
    # Vänta ut mutexen. Tio sekunder räcker gott; dör den inte då är
    # något så fel att en ny daemon ändå inte hjälper, och nästa runda
    # får försöka igen med längre backoff.
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (-not (Hitta-Daemon)) { break }
    }
    if (Hitta-Daemon) {
      Notera 'FEL' 'Den hängda daemonen lever fortfarande. Startar INTE en till — den hade bara stoppats av mutexen.'
      return $false
    }
  }

  if (-not (Test-Path $DaemonFil)) {
    Notera 'FEL' ('Hittar inte ' + $DaemonFil + '. Kan inte starta om.')
    return $false
  }

  # STARTAS GENOM cmd /c start, INTE genom Start-Process. Provat, och
  # skillnaden är hela funktionen.
  #
  # En process som Schemaläggaren skapar ger tysta barn: daemonen startar,
  # lever, drar CPU och skriver inte en enda rad — inte ens sin egen
  # STARTrad. Tystnaden ärvs nedåt, och ett Start-Process från vakten
  # räckte inte: barnbarnet blev lika tyst. cmd:ets `start` skapar
  # däremot en HELT NY konsol och kopplar loss barnet från förälderns.
  # Mätt 22 aug: Start-Process -> noll loggrader, cmd start -> full logg
  # inom sekunder.
  #
  # Tomma fönstertiteln "Polisvakt-brygga" MÅSTE stå där. Utan en titel
  # tolkar cmd den citerade sökvägen som titel och startar ingenting alls
  # — ett tyst fel av precis den sort som redan kostat den här filen en
  # runda.
  #
  # -Felsokningsport 9222 skrivs ut trots att det är standardvärdet, så
  # att raden här är ordagrant densamma som i Autostart-mappens .cmd.
  # Två startvägar som skiljer sig i det tysta är en felkälla man betalar
  # för senare.
  $rad = 'start "Polisvakt-brygga" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' +
         $DaemonFil + '" -Felsokningsport ' + $Felsokningsport
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $rad) `
      -WorkingDirectory $RotMapp -WindowStyle Hidden
    Notera 'ÅTGÄRD' ('Startade om bryggan (' + $Skal + ').')
    return $true
  } catch {
    Notera 'FEL' ('Omstarten kastade: ' + $_.Exception.Message)
    return $false
  }
}

# =====================================================================
#  En kontroll
# =====================================================================

function Kor-En-Runda {
  Trimma-Loggen

  $lage = if ($Torrt) { 'torr' } else { 'skarp' }
  $t = Las-Tillstand
  $proc = $null
  try { $proc = Hitta-Daemon } catch { Notera 'FEL' ('Processfrågan kastade: ' + $_.Exception.Message) }
  $liv  = Mat-Livstecken
  $port = Porten-Lyssnar -Port $Felsokningsport

  # ---- bygg beskrivningen som varje rad slutar med ----
  $bitar = @()
  if ($proc) { $bitar += ('pid=' + $proc.ProcessId) } else { $bitar += 'pid=saknas' }
  if ($liv.sistaRad) {
    $bitar += ('sista-rad=' + [math]::Round(((Get-Date) - $liv.sistaRad).TotalMinutes, 1) + ' min')
  } else { $bitar += 'sista-rad=ingen' }
  if ($liv.sistaSvep) {
    $bitar += ('sista-svep=' + [math]::Round(((Get-Date) - $liv.sistaSvep).TotalMinutes, 1) + ' min')
  } else { $bitar += 'sista-svep=inget' }
  if ($port) { $bitar += 'port9222=lyssnar' } else { $bitar += 'port9222=tyst' }
  $bitar += ('läge=' + $lage)
  $svans = '[' + ($bitar -join '  ') + ']'

  # ---- bedömningen ----
  #
  # Ordningen är medvetet den här. Utloggad Facebook kollas FÖRE
  # hängläget, för en omstart lagar inte en utloggad session — den
  # bränner bara backoffen och öppnar fönster i onödan. Det är också
  # exakt vad loggen visade 15:46 den 5 sep: SESSION utloggad, VAKTHUND
  # BLIND, och två omstarter på en minut som inte kunde hjälpa.

  $tystMin = $null
  if ($liv.sistaRad)  { $tystMin  = ((Get-Date) - $liv.sistaRad).TotalMinutes }
  $svepMin = $null
  if ($liv.sistaSvep) { $svepMin = ((Get-Date) - $liv.sistaSvep).TotalMinutes }

  $bedomning = 'GRÖN'
  $skal      = ''
  $atgarda   = $false

  if (-not $proc -and -not $liv.logg) {
    $bedomning = 'RÖD'; $skal = 'bryggan har aldrig körts på den här maskinen — ingen process och ingen daemonlogg'
    $atgarda = $true
  }
  elseif (-not $proc) {
    $bedomning = 'RÖD'; $skal = 'daemonprocessen finns inte'
    $atgarda = $true
  }
  elseif ($null -eq $tystMin) {
    $bedomning = 'RÖD'; $skal = 'processen lever men loggen saknar läsbara rader'
    $atgarda = $true
  }
  elseif ($tystMin -gt $TystnadMin) {
    $bedomning = 'RÖD'
    $skal = ('processen lever men loggen har tigit i ' + [math]::Round($tystMin, 1) +
             ' min (gräns ' + $TystnadMin + ') — hängläge, inte drift')
    $atgarda = $true
  }
  elseif ($liv.utloggad) {
    $bedomning = 'GUL'
    $skal = 'daemonen skriver, men Facebook-sessionen är utloggad i bryggfönstret. Omstart lagar inte det — logga in för hand.'
  }
  elseif ($null -eq $svepMin) {
    $bedomning = 'GUL'; $skal = 'daemonen skriver men har inte svept en enda gång ännu'
  }
  elseif ($svepMin -gt $SvepTystnadMin) {
    $bedomning = 'RÖD'
    $skal = ('daemonen skriver men har inte svept på ' + [math]::Round($svepMin, 1) +
             ' min (gräns ' + $SvepTystnadMin + ') — vaken men blind')
    $atgarda = $true
  }
  elseif (-not $port) {
    $bedomning = 'GUL'; $skal = 'sveper, men ingen lyssnare på 9222 — bryggfönstret håller troligen på att komma upp'
  }

  # ---- logga, oavsett utfall. Tyst vakt = ingen vakt. ----
  if ($bedomning -eq 'GRÖN') {
    Notera 'GRÖN' ('bryggan lever och sveper  ' + $svans)
    if ($t.misslyckadeIRad -ne 0) {
      $t.misslyckadeIRad = 0
      Skriv-Tillstand $t
      Notera 'INFO' 'Backoffen nollställd — en kontroll blev grön.'
    }
    return 0
  }

  Notera $bedomning ($skal + '  ' + $svans)
  if ($liv.sistText) { Notera 'INFO' ('        sista raden i daemonloggen: ' + $liv.sistText) }

  if (-not $atgarda) { return 1 }

  # ---- backoff ----
  $vanta = Backoff-Minuter -Antal $t.misslyckadeIRad
  if ($t.misslyckadeIRad -gt 0 -and $t.senasteAtgard -ne [DateTime]::MinValue) {
    $gatt = ((Get-Date) - $t.senasteAtgard).TotalMinutes
    if ($gatt -lt $vanta) {
      Notera 'PAUS' ('Backoff: väntar ' + [math]::Round($vanta - $gatt, 1) + ' min till innan nästa försök (' +
                     $t.misslyckadeIRad + ' misslyckade i rad, taket är ' + $BackoffTakMin + ' min).')
      return 1
    }
  }

  Synka-Tillagget
  [void](Starta-Om-Bryggan -Process $proc -Skal $skal)

  # Räknaren höjs även i torrkörning. Annars hade torrläget loggat
  # "skulle startat om" var sextionde sekund i evighet, och den loggen
  # blir omöjlig att läsa när den väl behövs.
  $t.misslyckadeIRad = $t.misslyckadeIRad + 1
  $t.senasteAtgard   = Get-Date
  Skriv-Tillstand $t
  Notera 'INFO' ('Nästa försök tidigast om ' + (Backoff-Minuter -Antal $t.misslyckadeIRad) + ' min.')
  return 1
}

# =====================================================================
#  Körningen
# =====================================================================

if (-not $Loop) {
  $kod = Kor-En-Runda
  exit $kod
}

# ---- loopläget ----
#
# ENKELINSTANS. Den 5 sep står "Vakten startad i loopläge" nio gånger på
# ett dygn utan en enda "vakten stannar" emellan. Flera loopar samtidigt
# betyder flera omstarter av samma brygga inom samma minut — 15:45:18 och
# 15:46:22 är exakt det. Mutexen släpps av Windows när processen dör,
# oavsett hur den dog, så det finns ingen pid-fil att städa.
$nyskapad = $false
$mutex = $null
try {
  $mutex = New-Object System.Threading.Mutex($true, 'Global\Polisvakt-Vakt', [ref]$nyskapad)
} catch {
  # Global-rymden kan vara stängd i hårt låsta miljöer. Hellre köra utan
  # spärr än att vägra vakta.
  Notera 'INFO' ('Kunde inte ta mutexen (' + $_.Exception.Message + ') — dubbelstartsspärren är av.')
  $nyskapad = $true
}
if (-not $nyskapad) {
  Notera 'INFO' 'En vakt kör redan i loopläge. Den här avslutar.'
  exit 0
}

Notera 'START' ('Vakten startad i loopläge. Kollar var ' + $IntervallSek + ':e sekund. Läge: ' +
  $(if ($Torrt) { 'TORRKÖRNING — startar ingenting, loggar bara vad den skulle gjort.' } else { 'SKARPT — startar om bryggan när den behöver det.' }))
Notera 'START' ('        Gränser: tystnad > ' + $TystnadMin + ' min = hängläge, inget svep > ' +
  $SvepTystnadMin + ' min = blind. Backofftak ' + $BackoffTakMin + ' min.')

try {
  while ($true) {
    try { [void](Kor-En-Runda) }
    catch { Notera 'FEL' ('Vaktrundan kastade: ' + $_.Exception.Message) }
    Start-Sleep -Seconds $IntervallSek
  }
} finally {
  # Vakten ska säga när den slutar vakta. Den raden saknades helt förut,
  # och därför gick det inte att se i efterhand OM vakten dog eller BARA
  # var tyst. Fångar inte en hårt dödad process (taskkill /f, avstängning
  # mitt i), men fångar stängt fönster och Ctrl+C.
  Notera 'SLUT' 'Vakten stannar. Bryggan är obevakad tills någon startar vakten igen.'
  if ($mutex) { try { $mutex.ReleaseMutex() } catch { } ; $mutex.Dispose() }
}
