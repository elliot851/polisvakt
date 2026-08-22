# Polisvakt — ETT kommando. Fönstret, läsningen, skarpt läge.
#
# Det här är filen ägaren kör. Ingen annan.
#
#   Kör nu:              .\tools\polisvakt-brygga.ps1
#   Starta med Windows:  .\tools\polisvakt-brygga.ps1 -Installera
#   Sluta med Windows:   .\tools\polisvakt-brygga.ps1 -Avinstallera
#   Titta bara, skriv inget:
#                        .\tools\polisvakt-brygga.ps1 -Torr
#
#
# VARFÖR DEN FINNS
#
# Förut var det två steg varje gång: starta-bryggan.ps1 för fönstret, sedan
# brygg-daemon.ps1 för läsningen — och man skulle komma ihåg -Skarpt, annars
# skrev daemonen ingenting och sa det bara i en rad högst upp i loggen. Tre
# saker att minnas, varje omstart, för alltid. Det var det ägaren klagade på.
#
# Nu: daemonen öppnar bryggfönstret själv när porten är död (se
# Starta-Bryggfonstret i brygg-daemon.ps1), skarpt är förval, och
# Schemaläggaren startar alltihop vid inloggning. Den här filen är limmet och
# ska förbli tunn — all logik bor i daemonen, där den kan provas.
#
#
# VARFÖR SCHEMALÄGGAREN OCH INTE EN EGEN ÖVERVAKNINGSLOOP
#
# En egen loop som startar om daemonen när den dör är trettio rader kod som
# själv kan dö, och som ingen märker när den gör det. Schemaläggaren i Windows
# gör exakt samma sak, körs av operativsystemet, och överlever att den här
# filen kraschar. RestartCount och RestartInterval nedan gör jobbet.
#
# Uppgiften registreras för DEN INLOGGADE ANVÄNDAREN, inte som SYSTEM. Det är
# ett medvetet val:
#
#   * Nyckeln i %LOCALAPPDATA%\Polisvakt\nycklar.xml är DPAPI-krypterad och
#     låst till kontot. SYSTEM kan inte läsa den, och skulle mötas av en tyst
#     tom nyckel.
#   * Chrome behöver ett skrivbord att öppna sitt fönster på.
#   * Registreringen kräver då inte administratörsrättigheter.

[CmdletBinding()]
param(
  [switch]$Installera,
  [switch]$Avinstallera,

  # Skickas vidare till daemonen. Torrkörning skriver ingenting någonstans.
  [switch]$Torr,

  # TOMT = alla grupper som står i CONFIG.groupIds i tools\fb-bridge.user.js.
  #
  # Stod här fram till 2.4 ett hårdkodat '317968668373072', och det var fel så
  # fort bryggan kunde läsa fler än en grupp: flaggan pinnade daemonen vid
  # Västerås, så en nyss tillagd Stockholmsgrupp lästes aldrig — och
  # ingenting sa varför. Grupplistan bor i bryggfilen; den här flaggan är
  # bara ett filter för den som vill köra EN av grupperna för hand.
  #
  # Har du redan en registrerad uppgift i Schemaläggaren bär den det gamla
  # argumentet. Kör om med -Installera så skrivs den om.
  [string[]]$GruppId = @(),
  [int]$Felsokningsport = 9222,

  # Namnet på uppgiften i Schemaläggaren.
  [string]$Uppgift = 'Polisvakt-brygga'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$daemon = Join-Path $PSScriptRoot 'brygg-daemon.ps1'
if (-not (Test-Path $daemon)) {
  Write-Host "Hittar inte $daemon" -ForegroundColor Red
  exit 1
}

# =====================================================================
#  Avinstallera
# =====================================================================

if ($Avinstallera) {
  $fanns = Get-ScheduledTask -TaskName $Uppgift -ErrorAction SilentlyContinue
  if (-not $fanns) {
    Write-Host "Ingen uppgift som heter $Uppgift. Inget att ta bort." -ForegroundColor Yellow
    exit 0
  }
  Unregister-ScheduledTask -TaskName $Uppgift -Confirm:$false
  Write-Host "Uppgiften $Uppgift borttagen. Bryggan startar inte längre med Windows." -ForegroundColor Green
  Write-Host 'En daemon som kör just nu fortsätter tills du stänger dess fönster.' -ForegroundColor DarkGray
  exit 0
}

# =====================================================================
#  Argumenten till daemonen — samma i båda vägarna
# =====================================================================

$argument = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', $daemon,
  '-Felsokningsport', $Felsokningsport
)
# Flaggan skickas BARA när någon uttryckligen bett om ett filter. Skickas den
# alltid är den inte ett filter längre, den är en pinne.
foreach ($g in @($GruppId)) { if ($g) { $argument += @('-GruppId', $g) } }
if ($Torr) { $argument += '-Torr' }

# =====================================================================
#  Installera i Schemaläggaren
# =====================================================================

if ($Installera) {
  # Sökvägen citeras i uppgiften. Repot ligger under "Claude code 2GNDTN" —
  # två mellanslag — och en ociterad sökväg delas där. Det har redan kostat
  # en felsökning i det här projektet en gång, i Chromes kommandorad.
  # -File, och INGEN omdirigering. Båda delarna är valda efter att motsatsen
  # provats och gjort saken värre.
  #
  # FELET SOM FANNS: Schemaläggaren startar processen utan konsol. Logga
  # skrev Write-Host FÖRE filen, skrivningen hade ingen mottagare, och
  # daemonen blev stående med en levande process som inte lämnade en enda rad
  # — inte ens sin egen STARTrad. Sex minuters tystnad och ingenting att
  # felsöka på, eftersom felsökningen sker i loggen.
  #
  # RÄTTNINGEN SITTER I LOGGA, inte här: raden skrivs till disk först, och
  # Write-Host ligger i ett try som får misslyckas. Se brygg-daemon.ps1.
  #
  # VARFÖR INTE `*>` TILL EN FIL: det provades. Uppgiften startade då, men
  # daemonens EGEN logg slutade skrivas helt — allt hamnade i
  # omdirigeringsfilen i stället, i UTF-16, och den nollställs vid varje start.
  # Två loggar där den ena tyst ersätter den andra är sämre än en.
  # Uppgiften pekar på brygg-uppgiftsstart.ps1, inte på daemonen.
  # Hela skälet står i den filen — kort version: en process som
  # Schemaläggaren skapar saknar riktigt konsolfönster, och daemonen tystnade
  # helt av det. Mellanlagret startar den i ett eget fönster och väntar in den.
  $start = Join-Path $PSScriptRoot 'brygg-uppgiftsstart.ps1'
  if (-not (Test-Path $start)) { throw "Hittar inte $start" }

  $argstrang = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', ('"' + $start + '"'),
    '-Felsokningsport', $Felsokningsport
  )
  foreach ($g in @($GruppId)) { if ($g) { $argstrang += @('-GruppId', $g) } }
  if ($Torr) { $argstrang += '-Torr' }

  $handling = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($argstrang -join ' ')
  $utlosare = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)

  # Fördröjningen är inte pynt. Vid inloggning är nätet ofta inte uppe än, och
  # startproben skulle då bli röd på ett fel som går över av sig själv trettio
  # sekunder senare — och i skarpt läge VÄGRAR daemonen starta på en röd prob.
  # En minut räcker.
  $utlosare.Delay = 'PT1M'

  $installningar = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 2) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

  # ExecutionTimeLimit 0 = ingen tidsgräns. Förvalet är tre dagar, och en
  # brygga som ska gå för alltid får inte dödas av Schemaläggaren på dag tre.
  # MultipleInstances IgnoreNew är bälte till mutexens hängslen.
  #
  # RestartCount 10, inte 999. Omstarterna finns för en krasch, inte för en
  # felkonfiguration: en röd startprob får daemonen att VÄNTA och prova om var
  # femte minut i stället för att falla, just för att en fallande daemon under
  # Schemaläggaren blir en fönsterstorm. Tio omstarter räcker för det
  # omstarterna faktiskt är till för.

  $huvudman = New-ScheduledTaskPrincipal `
    -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

  $fanns = Get-ScheduledTask -TaskName $Uppgift -ErrorAction SilentlyContinue
  if ($fanns) { Unregister-ScheduledTask -TaskName $Uppgift -Confirm:$false }

  Register-ScheduledTask -TaskName $Uppgift -Action $handling -Trigger $utlosare `
    -Settings $installningar -Principal $huvudman `
    -Description 'Laser Facebook-gruppen och skickar polisvarningar till appen. Se docs/brygg-daemon.md.' | Out-Null

  Write-Host ''
  Write-Host "Uppgiften $Uppgift registrerad." -ForegroundColor Green
  Write-Host '  startar:  vid inloggning, en minut efter' -ForegroundColor DarkGray
  Write-Host '  läge:     ' -NoNewline -ForegroundColor DarkGray
  Write-Host $(if ($Torr) { 'TORRKÖRNING' } else { 'SKARPT' }) -ForegroundColor $(if ($Torr) { 'Red' } else { 'Green' })
  Write-Host '  startas om automatiskt om den dör, var annan minut' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host 'Startar den nu också.' -ForegroundColor Cyan
  Write-Host ''
}

# =====================================================================
#  Kör
# =====================================================================
#
# I samma fönster med flit. Loggen ska synas där man står, inte i ett fönster
# som poppar upp bakom. Vill man ha den i bakgrunden: -Installera, och logga
# ut och in.
#
# Dubbelstartsspärren sitter i daemonen (en namngiven mutex). Kör man den här
# filen medan uppgiften redan kör svarar daemonen att en redan kör och
# avslutar — den startar inte ett andra svep.

& powershell.exe @argument
exit $LASTEXITCODE
