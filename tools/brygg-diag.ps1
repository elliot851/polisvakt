# =====================================================================
#  Polisvakt — brygg-diag.ps1
#  Hälsokoll på hela bryggkedjan. Läser bara. Rör ingenting.
# =====================================================================
#
#  Kör den när som helst, också mitt under skarp drift:
#
#      powershell -NoProfile -File tools\brygg-diag.ps1
#
#  Den startar ingenting, stoppar ingenting, skriver ingen fil och
#  öppnar inget fönster. Enda utgående trafiken är ett GET mot Supabase
#  REST (hoppas över med -IngenNat) och ett GET mot den lokala
#  felsökningsporten.
#
# ---------------------------------------------------------------------
#  VARFÖR FILEN SER UT SÅ HÄR
# ---------------------------------------------------------------------
#
#  Den 5 sep 2026 låg bryggan död i sexton timmar och ingen märkte det.
#  Frågan "lever bryggan?" gick inte att svara på utan att öppna tre
#  loggar och en processlista, och svaret man fick av processlistan var
#  dessutom fel: processen levde, bryggan gjorde ingenting.
#
#  Därför mäter den här filen SEX saker och väger ihop dem till EN rad:
#
#    1. daemonprocessen      finns den?
#    2. felsökningsporten    svarar DevTools på 127.0.0.1:9222?
#    3. sista loggraden      hur gammal? (bevisar att processen kör kod)
#    4. sista svepet         hur gammal? (bevisar att den LÄSER gruppen)
#    5. Supabase REST        svarar backend, eller är projektet pausat?
#    6. vakten               finns det någon som startar om bryggan?
#
#  Punkt 3 och 4 är inte samma sak, och skillnaden är hela lärdomen från
#  5 sep: daemonen kan skriva "VÄNTAR" i timmar utan att läsa en enda
#  rad ur gruppen. Vaken är inte samma sak som seende.
#
#  Filen låg tidigare på en helt annan uppgift: den bevisade att
#  Schemaläggarens miljö inte var felet när daemonen startade tyst under
#  en schemalagd uppgift (samma användare, samma LOCALAPPDATA, skrivning
#  ok, Write-Host ok, Global-mutex ok). Den utredningen refereras från
#  Autostart-mappens .cmd och är för dyrköpt för att kastas — den ligger
#  kvar under flaggan -Miljoprov längst ner.
#
#  UTF-8 MED byte-order-märke. Utan BOM läser Windows PowerShell 5.1
#  filen som ANSI och varje å/ä/ö i utskriften blir mojibake. Det syns
#  fortfarande i gamla rader i brygg-vakt.log ("looplÃ¤ge").

param(
  # Hoppa över nätanropet mot Supabase. Praktiskt när man sitter utan
  # uppkoppling och bara vill veta om daemonen lever.
  [switch]$IngenNat,

  # Kör den gamla miljödiagnosen i stället: de fyra sakerna daemonen gör
  # INNAN sin första loggrad, en i taget, skrivna till fil före de körs.
  [switch]$Miljoprov,

  # Sekunder innan nätanropen ger upp.
  [int]$Tidsgrans = 15
)

$ErrorActionPreference = 'Continue'

$DataMapp   = Join-Path $env:LOCALAPPDATA 'Polisvakt'
$VaktLogg   = Join-Path $DataMapp 'brygg-vakt.log'
$Kallfil    = Join-Path $PSScriptRoot 'fb-bridge.user.js'
$Kopiefil   = Join-Path $PSScriptRoot 'brygg-tillagg\brygga.js'
$Port       = 9222

# Gränser. Samma tal som brygg-vakt.ps1 använder, med flit: de två
# verktygen ska aldrig kunna säga olika saker om samma brygga.
$TystnadMin      = 5
$SvepTystnadMin  = 15

# ---------------------------------------------------------------------
#  Utskrift
# ---------------------------------------------------------------------
$script:Varningar = 0
$script:Fel       = 0

function Rubrik {
  param([string]$T)
  Write-Host ''
  Write-Host ('  ' + $T) -ForegroundColor White
  Write-Host ('  ' + ('-' * 66)) -ForegroundColor DarkGray
}

# -RaknaEj: raden ritas med sin färg men räknas inte i sammanfattningen.
# Används för förklaringar och åtgärdsrader som hör till ett fel som redan
# är räknat. Utan den blir "8 fel" på en enda trasig brygga, och siffran
# slutar betyda något.
function Rad {
  param([string]$Niva, [string]$Etikett, [string]$Text, [switch]$RaknaEj)
  $f = 'Gray'
  $m = '     '
  switch ($Niva) {
    'GRÖN' { $f = 'Green';    $m = '  OK '; break }
    'GUL'  { $f = 'Yellow';   $m = '  ?  '; if (-not $RaknaEj) { $script:Varningar++ }; break }
    'RÖD'  { $f = 'Red';      $m = ' FEL '; if (-not $RaknaEj) { $script:Fel++ }; break }
    'INFO' { $f = 'DarkGray'; $m = '     '; break }
  }
  Write-Host ($m + ('{0,-22}' -f $Etikett) + $Text) -ForegroundColor $f
}

function Alder {
  param([DateTime]$T)
  $s = ((Get-Date) - $T).TotalSeconds
  if ($s -lt 90)   { return ('' + [math]::Round($s) + ' sekunder sedan') }
  if ($s -lt 5400) { return ('' + [math]::Round($s / 60, 1) + ' minuter sedan') }
  return ('' + [math]::Round($s / 3600, 1) + ' timmar sedan')
}

# ---------------------------------------------------------------------
#  Filläsning som inte krockar med daemonen
# ---------------------------------------------------------------------
function Las-Slutet {
  param([string]$Fil, [int]$MaxByte = 200000)
  $fs = $null
  try {
    # FileShare::ReadWrite — daemonen håller filen öppen i korta
    # ögonblick vid varje skrivning, och en diagnos får aldrig kunna
    # kasta bara för att den råkade titta i samma millisekund.
    $fs = New-Object System.IO.FileStream($Fil, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $start = 0
    if ($fs.Length -gt $MaxByte) { $start = $fs.Length - $MaxByte }
    [void]$fs.Seek($start, [System.IO.SeekOrigin]::Begin)
    $buf = New-Object byte[] ($fs.Length - $start)
    $n = $fs.Read($buf, 0, $buf.Length)
    $rader = @([System.Text.Encoding]::UTF8.GetString($buf, 0, $n) -split "`r?`n")
    if ($start -gt 0 -and $rader.Count -gt 1) { $rader = $rader[1..($rader.Count - 1)] }
    return $rader
  } catch { return @() } finally { if ($fs) { $fs.Dispose() } }
}

function Tid-Ur-Rad {
  param([string]$Rad)
  if ($Rad -match '^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)') {
    $t = [DateTime]::MinValue
    if ([DateTime]::TryParse($Matches[1], [ref]$t)) { return $t }
  }
  return $null
}

# =====================================================================
#  MILJÖPROVET (gamla filen) — bara med -Miljoprov
# =====================================================================
if ($Miljoprov) {
  $ut = Join-Path $env:TEMP 'polisvakt-diag.txt'
  function Not($t) {
    [System.IO.File]::AppendAllText($ut, ((Get-Date -Format 'HH:mm:ss') + '  ' + $t + [Environment]::NewLine),
      (New-Object System.Text.UTF8Encoding($true)))
  }
  # Varje steg skrivs FÖRE det utförs. Hänger något är det steget efter
  # den sista raden i filen som hänger — det är hela poängen med
  # ordningen, och det är så den ursprungliga tystnaden ringades in.
  [System.IO.File]::WriteAllText($ut, '', (New-Object System.Text.UTF8Encoding($true)))
  Not 'start'
  Not ('anvandare      = ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
  Not ('LOCALAPPDATA   = ' + $env:LOCALAPPDATA)
  Not ('TEMP           = ' + $env:TEMP)
  Not ('cwd            = ' + (Get-Location).Path)
  Not ('host           = ' + $Host.Name + ' ' + $Host.Version)

  Not 'steg 1: Console::OutputEncoding'
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Not '  ok' } catch { Not ('  kastade: ' + $_.Exception.GetType().Name) }

  Not 'steg 2: skriv i LOCALAPPDATA\Polisvakt'
  try {
    if (-not (Test-Path $DataMapp)) { New-Item -ItemType Directory -Force -Path $DataMapp | Out-Null }
    $p = Join-Path $DataMapp 'brygg-diag-prov.txt'
    [System.IO.File]::AppendAllText($p, 'prov ' + (Get-Date -Format 's') + [Environment]::NewLine,
      (New-Object System.Text.UTF8Encoding($true)))
    Not ('  ok, skrev ' + $p + ' (' + (Get-Item $p).Length + ' byte)')
  } catch { Not ('  kastade: ' + $_.Exception.GetType().Name + ' - ' + $_.Exception.Message) }

  Not 'steg 3: Write-Host'
  try { Write-Host 'diag'; Not '  ok' } catch { Not ('  kastade: ' + $_.Exception.GetType().Name) }

  Not 'steg 4: Global-mutex'
  try {
    $ny = $false
    $mx = New-Object System.Threading.Mutex($true, 'Global\Polisvakt-Diag', [ref]$ny)
    Not ('  ok, nyskapad=' + $ny)
    try { $mx.ReleaseMutex() } catch { }
    $mx.Dispose()
  } catch { Not ('  kastade: ' + $_.Exception.GetType().Name + ' - ' + $_.Exception.Message) }

  Not 'steg 5: las fb-bridge.user.js'
  try {
    $n = [System.IO.File]::ReadAllText($Kallfil, [System.Text.Encoding]::UTF8).Length
    Not ('  ok, ' + $n + ' tecken')
  } catch { Not ('  kastade: ' + $_.Exception.GetType().Name) }

  Not 'klar'
  Write-Host ''
  Write-Host ('  Miljoprovet klart. Resultatet ligger i ' + $ut) -ForegroundColor Cyan
  Get-Content $ut | ForEach-Object { Write-Host ('    ' + $_) -ForegroundColor DarkGray }
  exit 0
}

# =====================================================================
#  HÄLSOKOLLEN
# =====================================================================

Write-Host ''
Write-Host ('  ' + ('=' * 66)) -ForegroundColor Cyan
Write-Host '   POLISVAKT — HÄLSOKOLL PÅ BRYGGAN' -ForegroundColor Cyan
Write-Host ('   ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '   ' + $env:COMPUTERNAME) -ForegroundColor DarkCyan
Write-Host ('  ' + ('=' * 66)) -ForegroundColor Cyan

# ---------------------------------------------------------------------
#  1. Daemonprocessen
# ---------------------------------------------------------------------
Rubrik '1. DAEMONPROCESSEN — kör bryggan över huvud taget?'

$daemon = $null
try {
  # Filtret måste utesluta vår egen fråga: söksträngen står i frågans
  # egen kommandorad, så en naiv matchning räknar frågan som ett svar.
  # Det felet gjordes en gång i det här projektet och gav "levande" två
  # kontroller i rad medan bryggan låg död.
  $traff = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*brygg-daemon.ps1*' -and
      $_.CommandLine -notlike '*CimInstance*' -and
      $_.CommandLine -notlike '*brygg-vakt*' -and
      $_.CommandLine -notlike '*brygg-diag*'
    })
  if ($traff.Count -gt 0) { $daemon = $traff[0] }
  if ($traff.Count -gt 1) {
    Rad 'GUL' 'antal processer' ($traff.Count.ToString() + ' daemoner matchar. Bara en ska köra — mutexen brukar stoppa nummer två.')
  }
} catch {
  Rad 'RÖD' 'processfrågan' ('kastade: ' + $_.Exception.Message)
}

if ($daemon) {
  $start = $daemon.CreationDate
  Rad 'GRÖN' 'processen' ('lever, pid ' + $daemon.ProcessId)
  Rad 'INFO' 'startad'    ($start.ToString('yyyy-MM-dd HH:mm:ss') + '  (' + (Alder $start) + ')')
  Rad 'INFO' 'OBS'        'en levande process bevisar INGENTING om bryggan läser. Se punkt 3 och 4.'
} else {
  Rad 'RÖD' 'processen' 'finns inte. Bryggan kör inte.'
}

# ---------------------------------------------------------------------
#  2. Felsökningsporten
# ---------------------------------------------------------------------
Rubrik '2. FELSÖKNINGSPORTEN — svarar Chrome på 127.0.0.1:9222?'

$lyssnar = $false
try { $lyssnar = (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) } catch { }

$devtools = $null
if ($lyssnar) {
  try {
    $devtools = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/json/version') -TimeoutSec 5
  } catch { }
}

if ($devtools) {
  $b = ''
  try { $b = [string]$devtools.Browser } catch { }
  Rad 'GRÖN' 'port 9222' ('DevTools svarar. ' + $b)
  try {
    $flikar = @(Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/json/list') -TimeoutSec 5)
    $sidor  = @($flikar | Where-Object { $_.type -eq 'page' })
    $fb     = @($sidor  | Where-Object { $_.url -match 'facebook\.com' })
    $grupp  = @($fb     | Where-Object { $_.url -match 'facebook\.com/groups/\d' })
    $login  = @($fb     | Where-Object { $_.url -match 'facebook\.com/(login|checkpoint)' })
    Rad 'INFO' 'flikar' ($sidor.Count.ToString() + ' sidor, varav ' + $fb.Count + ' på facebook.com')
    if ($login.Count -gt 0) {
      Rad 'RÖD' 'Facebook' 'en flik står på login/checkpoint — kontot är UTLOGGAT. Ingen omstart i världen lagar det.'
    } elseif ($grupp.Count -gt 0) {
      Rad 'GRÖN' 'gruppflikar' ($grupp.Count.ToString() + ' flik(ar) står på en grupp.')
    } else {
      Rad 'GUL' 'gruppflikar' 'ingen flik står på en facebook.com/groups/<id>. Bryggan har inget att läsa.'
    }
  } catch {
    Rad 'GUL' 'fliklistan' ('gick inte att hämta: ' + $_.Exception.Message)
  }
} elseif ($lyssnar) {
  Rad 'GUL' 'port 9222' 'något lyssnar på porten men DevTools svarar inte med JSON.'
} else {
  Rad 'RÖD' 'port 9222' 'ingen lyssnare. Bryggfönstret är inte igång.'
}

$chrome = @(Get-Process chrome -ErrorAction SilentlyContinue)
Rad 'INFO' 'chrome.exe' ($chrome.Count.ToString() + ' processer på maskinen (alla Chrome-fönster, inte bara bryggans)')

# ---------------------------------------------------------------------
#  3 + 4. Loggen: sista raden och sista svepet
# ---------------------------------------------------------------------
Rubrik '3. LIVSTECKEN — hur gammal är sista raden i daemonloggen?'

# Snävt mönster med flit. brygg-daemon-*.log fångar också
# brygg-daemon-slutmatning.log, en engångsmätning från augusti, och den
# skulle få varje kontroll att tro att bryggan varit tyst i veckor.
$loggfil = $null
try {
  $l = @(Get-ChildItem -Path $DataMapp -Filter 'brygg-daemon-????-??-??.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
  if ($l.Count -gt 0) { $loggfil = $l[0] }
} catch { }

$sistaRad = $null; $sistaSvep = $null; $sistText = ''; $utloggad = $false
if ($loggfil) {
  Rad 'INFO' 'loggfil' ($loggfil.Name + '  (' + [math]::Round($loggfil.Length / 1KB) + ' kB)')
  $rader = Las-Slutet -Fil $loggfil.FullName
  for ($i = $rader.Count - 1; $i -ge 0; $i--) {
    $r = $rader[$i]
    if (-not $r) { continue }
    $t = Tid-Ur-Rad -Rad $r
    if (-not $t) { continue }
    if (-not $sistaRad) { $sistaRad = $t; $sistText = $r.Trim() }
    if (-not $sistaSvep -and $r -match '^\S+ \S+\s+(SVEP|SUMMA)\b') { $sistaSvep = $t }
    if ($sistaRad -and $sistaSvep) { break }
  }
  $svans = ($rader | Select-Object -Last 40) -join "`n"
  if ($svans -match 'utloggad|utloggat|VAKTHUND\s+BLIND') { $utloggad = $true }
}

if (-not $loggfil) {
  Rad 'RÖD' 'daemonloggen' ('ingen brygg-daemon-<datum>.log i ' + $DataMapp + '. Bryggan har aldrig kört här.')
} elseif (-not $sistaRad) {
  Rad 'RÖD' 'sista raden' 'loggen finns men innehåller ingen läsbar tidsstämpel.'
} else {
  $min = ((Get-Date) - $sistaRad).TotalMinutes
  $n = 'GRÖN'
  if ($min -gt $TystnadMin) { $n = 'RÖD' }
  Rad $n 'sista raden' ($sistaRad.ToString('yyyy-MM-dd HH:mm:ss') + '  (' + (Alder $sistaRad) + ')')
  if ($min -gt $TystnadMin) {
    Rad 'RÖD' -RaknaEj 'tolkning' ('tystare än ' + $TystnadMin + ' min. En frisk daemon skriver var 20:e sekund och en väntande var 55:e — det här är hängläge.')
  }
  Rad 'INFO' 'texten' $sistText
}

Rubrik '4. SVEPET — när läste bryggan gruppen senast?'

if (-not $sistaSvep) {
  if ($loggfil) {
    Rad 'RÖD' 'sista svepet' 'ingen SVEP- eller SUMMA-rad alls i loggen. Daemonen startade men läste aldrig gruppen.'
  } else {
    Rad 'RÖD' 'sista svepet' 'okänt — ingen logg att läsa.'
  }
} else {
  $min = ((Get-Date) - $sistaSvep).TotalMinutes
  $n = 'GRÖN'
  if ($min -gt $SvepTystnadMin) { $n = 'RÖD' }
  elseif ($min -gt 2) { $n = 'GUL' }
  Rad $n 'sista svepet' ($sistaSvep.ToString('yyyy-MM-dd HH:mm:ss') + '  (' + (Alder $sistaSvep) + ')')
  if ($min -gt $SvepTystnadMin) {
    Rad 'RÖD' -RaknaEj 'tolkning' 'daemonen kan vara vaken men den är blind. Ett svep går var 20:e sekund även när inget nytt finns.'
  }
}
if ($utloggad) {
  Rad 'RÖD' 'Facebook' 'loggen säger att sessionen är utloggad i bryggfönstret. Logga in för hand — omstart hjälper inte.'
}

# ---------------------------------------------------------------------
#  5. Supabase
# ---------------------------------------------------------------------
Rubrik '5. SUPABASE — svarar backend?'

if ($IngenNat) {
  Rad 'INFO' 'hoppades över' '-IngenNat angivet.'
} else {
  $url = $null; $nyckel = $null
  try {
    # Samma källa och samma regex som daemonen använder, så diagnosen
    # aldrig kan peka på en annan databas än den bryggan skriver till.
    $kod = [System.IO.File]::ReadAllText($Kallfil, [System.Text.Encoding]::UTF8)
    $m1 = [regex]::Match($kod, "supabaseUrl\s*:\s*'([^']+)'")
    $m2 = [regex]::Match($kod, "supabaseKey\s*:\s*'([^']+)'")
    if ($m1.Success) { $url = $m1.Groups[1].Value }
    if ($m2.Success) { $nyckel = $m2.Groups[1].Value }
  } catch { }

  if (-not $url -or -not $nyckel) {
    Rad 'RÖD' 'uppgifterna' ('hittar inte supabaseUrl/supabaseKey i ' + (Split-Path -Leaf $Kallfil) + '.')
  } else {
    Rad 'INFO' 'projekt' $url
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
    try {
      $t0 = Get-Date
      $svar = Invoke-WebRequest -Uri ($url + '/rest/v1/reports?select=id&limit=1') `
                -Headers @{ apikey = $nyckel; Authorization = ('Bearer ' + $nyckel) } `
                -TimeoutSec $Tidsgrans -UseBasicParsing
      $ms = [math]::Round(((Get-Date) - $t0).TotalMilliseconds)
      Rad 'GRÖN' 'REST' ('HTTP ' + $svar.StatusCode + ' på ' + $ms + ' ms — projektet är vaket.')
    } catch {
      $m = $_.Exception.Message
      # ASCII-only matchning med flit: en BOM-lös .ps1 läses som ANSI av
      # PowerShell 5.1, och ett å/ä/ö i en regex-literal matchar då inte
      # felsträngen. 'matcha' räcker för svenska "matcha fjärrnamnet".
      if ($m -match 'matcha|resolve|NameResolution|No such host|known') {
        Rad 'RÖD' 'REST' 'svarar inte på DNS. Projektet är PAUSAT eller raderat.'
        Rad 'RÖD' -RaknaEj 'åtgärd' 'logga in på supabase.com och tryck Restore. Nyckel och migrationer är INTE felet.'
      } else {
        Rad 'RÖD' 'REST' ('anropet misslyckades: ' + $m)
      }
    }
  }
}

# ---------------------------------------------------------------------
#  6. Vakten
# ---------------------------------------------------------------------
Rubrik '6. VAKTEN — finns det någon som startar om bryggan?'

$vakt = $null
try {
  $v = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*brygg-vakt*' -and
      $_.CommandLine -notlike '*CimInstance*' -and
      $_.CommandLine -notlike '*brygg-diag*'
    })
  if ($v.Count -gt 0) { $vakt = $v[0] }
} catch { }

if ($vakt) {
  $torr = ($vakt.CommandLine -notlike '*-Skarp*')
  Rad 'GRÖN' 'vaktprocessen' ('lever, pid ' + $vakt.ProcessId)
  if ($torr) {
    Rad 'GUL' 'läge' 'TORRKÖRNING — vakten loggar vad den skulle gjort men startar ingenting. Lägg till -Skarp när det ska bli skarpt.'
  } else {
    Rad 'GRÖN' 'läge' 'SKARPT — vakten startar om bryggan när den behöver det.'
  }
} else {
  Rad 'RÖD' 'vaktprocessen' 'ingen vakt kör. Dör bryggan nu är det ingen som märker det.'
}

if (Test-Path $VaktLogg) {
  $vr = @(Las-Slutet -Fil $VaktLogg -MaxByte 20000 | Where-Object { $_ })
  if ($vr.Count -gt 0) {
    $sista = $vr[$vr.Count - 1]
    $vt = Tid-Ur-Rad -Rad $sista
    if ($vt) {
      # Vakten skriver en rad per kontroll (var 60:e sekund i loopläge).
      # Har den inte skrivit på tio minuter är den död eller fastlåst,
      # oavsett vad processlistan säger.
      #
      # Kör ingen vakt alls är raden bara INFO. En färsk rad utan en
      # levande vakt betyder att någon körde en engångskontroll för hand
      # — det är inte bevakning, och det ska inte lysa grönt.
      $n = 'INFO'
      if ($vakt) {
        $n = 'GRÖN'
        if (((Get-Date) - $vt).TotalMinutes -gt 10) { $n = 'RÖD' }
      }
      Rad $n 'sista vaktraden' ($vt.ToString('yyyy-MM-dd HH:mm:ss') + '  (' + (Alder $vt) + ')' +
        $(if (-not $vakt) { '  — från en engångskörning, ingen loop bevakar just nu' } else { '' }))
    }
    Rad 'INFO' 'texten' $sista.Trim()
  }
} else {
  Rad 'GUL' 'vaktloggen' ('finns inte: ' + $VaktLogg)
}

# ---------------------------------------------------------------------
#  7. Bryggkodens kopia
# ---------------------------------------------------------------------
Rubrik '7. BRYGGKODEN — är Chromes kopia i takt med källan?'

if ((Test-Path $Kallfil) -and (Test-Path $Kopiefil)) {
  try {
    $a = (Get-FileHash -Algorithm MD5 $Kallfil).Hash
    $b = (Get-FileHash -Algorithm MD5 $Kopiefil).Hash
    if ($a -eq $b) {
      Rad 'GRÖN' 'brygg-tillagg' 'brygga.js är identisk med fb-bridge.user.js.'
    } else {
      Rad 'RÖD' 'brygg-tillagg' 'brygga.js har glidit isär från fb-bridge.user.js. Daemonen VÄGRAR starta tills den synkas.'
      Rad 'RÖD' -RaknaEj 'åtgärd' ('copy /Y "' + $Kallfil + '" "' + $Kopiefil + '"')
    }
  } catch {
    Rad 'GUL' 'brygg-tillagg' ('kunde inte jämföra: ' + $_.Exception.Message)
  }
} else {
  Rad 'GUL' 'brygg-tillagg' 'en av filerna saknas — inget att jämföra.'
}

# ---------------------------------------------------------------------
#  Sammanfattningen
# ---------------------------------------------------------------------
Write-Host ''
Write-Host ('  ' + ('=' * 66)) -ForegroundColor Cyan

$slutsats = 'GRÖN'
$mening   = 'Bryggan lever, sveper och backend svarar. Inget att göra.'
$farg     = 'Green'
$kod      = 0

if ($script:Fel -gt 0) {
  $slutsats = 'RÖD'
  $farg     = 'Red'
  $kod      = 2
  $mening   = 'Något är sönder. Varningarna ovan säger vad. Se docs\BRYGGA-DRIFT.md för åtgärden.'
} elseif ($script:Varningar -gt 0) {
  $slutsats = 'GUL'
  $farg     = 'Yellow'
  $kod      = 1
  $mening   = 'Fungerar, men något är inte som det ska. Titta på de gula raderna ovan.'
}

Write-Host ('   ' + $slutsats + '   ' + $mening) -ForegroundColor $farg
Write-Host ('   ' + $script:Fel + ' fel, ' + $script:Varningar + ' varningar.') -ForegroundColor DarkGray
Write-Host ('  ' + ('=' * 66)) -ForegroundColor Cyan
Write-Host ''

# Exitkod så den går att kedja: 0 grön, 1 gul, 2 röd.
exit $kod
