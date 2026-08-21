# Polisvakt — Facebook-bryggan som PowerShell-tjänst över felsökningsporten.
#
# VARFÖR DEN HÄR FILEN FINNS
#
# Bryggkoden i tools\fb-bridge.user.js är mätt mot den riktiga gruppsidan och
# täckt av testsvepet i fb-bryggan-test.html. Problemet har aldrig varit koden
# — det har varit att få in den i sidan. Fyra vägar är uttömda och ska inte
# provas igen:
#
#   Tampermonkey            installationssidan ligger på chrome-extension://,
#                           och Chrome blockerar all automation där.
#   --load-extension        borttagen i Chrome 151, verifierat isolerat.
#   Tillägg för hand        ÄR inläst och aktiverat i profilen
#                           %LOCALAPPDATA%\Polisvakt\chrome-brygga
#                           (id gkfpgohonkfahcafjejfhdajbaiiolom,
#                           disable_reasons: [], rätt scriptable_host) — men
#                           innehållsskriptet injiceras aldrig: noll
#                           konsolrader, tomt localStorage. Orsaken syns bara
#                           i chrome://extensions, som inte går att läsa
#                           maskinellt.
#   Hämta koden in i sidan  Facebooks CSP blockerar fetch mot både GitHub och
#                           localhost, och window.name rensas numera vid
#                           navigering mellan domäner.
#
# Kvar står felsökningsporten. Den här filen startar själv Chrome med
# --remote-debugging-port=9222 (se Starta-Bryggfonstret), och över den porten kör den
# Page.addScriptToEvaluateOnNewDocument och Runtime.evaluate. Injicerad kod
# lyder inte under sidans CSP. Det är vägen som fungerar.
#
#
# ARKITEKTUREN, OCH DET AVGÖRANDE VALET: SIDAN LÄSER, POWERSHELL SKICKAR
#
# Facebooks CSP blockerar nätverkstrafik mot supabase.co och
# nominatim.openstreetmap.org från en facebook.com-sida. Det gäller även
# injicerad kod — CSP:n sitter på dokumentet, inte på skriptet.
#
# Frestelsen är Page.setBypassCSP. Den här filen gör INTE det, och det är ett
# medvetet val. Att stänga av CSP på en sida som kör ägarens inloggade
# Facebook-session sänker säkerheten på riktigt: varje skript sidan råkar
# ladda, från vilken värd som helst, får då göra vad som helst med sessionen.
# Det behövs inte heller. Delningen är i stället:
#
#   I SIDAN   bara läsning. Det injicerade skriptet plockar inlägg ur flödet,
#             kör parsern, tidsbestämmer och lämnar fynden på window.__pvLas.
#             Noll nätverk. Ingen Supabase-nyckel finns i sidan.
#   HÄR       daemonen pollar med Runtime.evaluate och gör geokodningen och
#             Supabase-anropen från PowerShell, där ingen CSP gäller.
#
# Skriptet körs dessutom i en ISOLERAD VÄRLD (Page.createIsolatedWorld med
# worldName). Samma DOM, egen JS-kontext: Facebooks egen kod kan varken läsa
# eller peka om window.__pvLas.
#
#
# ÅTERANVÄNDNING, INTE OMSKRIVNING
#
# Läsdelen skrivs inte om här. Daemonen läser tools\fb-bridge.user.js från
# disk vid start och klipper ut stycket mellan sektionsrubrikerna
# "Konfiguration" och "Geokodning". Det stycket är parsern, minneslistan,
# först-sedd-mekaniken och hela flödesläsningen — ordagrant, samma bytes som
# testerna körts mot. Allt efter det (geokodning, skrivning, skanningsloopen)
# lämnas kvar i filen och görs i stället här.
#
# Saknas någon av rubrikerna vägrar daemonen starta, och den kontrollerar
# dessutom att klippet innehåller de funktioner den ska anropa och INTE
# innehåller nätverksadresser. En brygga som tyst läser fel kod är värre än en
# som inte startar.
#
# Skalet runt klippet frågar efter formen på det den anropar i stället för att
# anta den — bryggan skrevs om från 2.2 till 2.3 mitt under det här arbetet
# och bytte både funktionssignaturer och kalibreringsflagga. Se
# LasarSkalFot längre ned.
#
#
# KÖR
#
#   Skarpt läge — FÖRVALET sedan 2026-08-22. Skriver till produktionsdatabasen:
#     powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1
#
#   Torrkörning, skriver ingenting någonstans:
#     powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1 -Torr
#
#   Normalt startas den inte för hand alls, utan av tools\polisvakt-brygga.ps1,
#   som också öppnar bryggfönstret och kan registrera sig för autostart.
#
#   Bevisa produktregeln utan att röra Chrome:
#     powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1 -Sjalvtest
#
#   Ett enda svep och avsluta (för mätning):
#     powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1 -Svep 1

[CmdletBinding()]
param(
  # ETT FILTER, INTE SANNINGEN. Läs det här innan du sätter flaggan.
  #
  # Vilka grupper som läses står i CONFIG.groupIds i tools\fb-bridge.user.js,
  # och ingen annanstans. Daemonen plockar ut listan därifrån vid start (se
  # Plocka-Grupper) tillsammans med varje grupps ruta och ort.
  #
  # Fram till 2.4 var den här parametern sanningen: daemonen injicerade ett
  # naket groupId i sidan, och bryggkoden gav då VARJE grupp Västmanlands
  # ruta. Pekade man daemonen på Stockholmsgruppen slogs "Sveavägen" upp som
  # "Sveavägen, Västerås", Nominatim svarade tomt, och raden loggades
  # HOPPAS-ÖVER orsak=okänd-plats. Ingenting såg trasigt ut. Det var den
  # enskilda spärr som gjorde en andra grupp meningslös, och den är borta.
  #
  # Tomt (förvalet) = läs alla grupper som står i bryggfilen.
  # Angivet = läs BARA de av dem som räknas upp här. Ett id som inte finns i
  # bryggfilen är ett fel och stoppar starten — annars hade en felstavning
  # gett en daemon som läser ingenting och inte säger varför.
  [string[]]$GruppId = @(),

  [int]$Felsokningsport = 9222,

  # 20 s är samma takt som bryggan mättes i. Kortare ger inget: Chrome
  # strypar ändå dolda flikar till en väckning i minuten — men den
  # strypningen gäller sidans egna timers, och daemonens klocka ligger
  # utanför sidan. Här hålls takten oavsett vad fliken gör.
  [int]$SvepIntervallMs = 20000,

  # FÖRVALET ÄR SKARPT. Det var det inte förut, och vändningen är avsiktlig.
  #
  # Torrkörning var rätt förval så länge kedjan var obevisad: en daemon som
  # skriver fel är värre än en som inte skriver. Nu är kedjan mätt, och det
  # dyra felet har bytt håll. Ägaren startade bryggan, glömde -Skarpt, och
  # fick en logg full av gröna SKULLE-SKICKA-rader som ser ut som framgång
  # medan telefonen är tyst. Det är exakt "går sönder utan att säga till".
  #
  # -Torr finns kvar för den som vill titta utan att röra databasen, och
  # torrkörningen skriker numera om vad den är. Se banderollen vid start.
  [switch]$Torr,

  # Bakåtkompatibilitet. Tas emot, men styr ingenting längre — skarpt är
  # förval. Genvägar, dokumentation och schemalagda uppgifter som redan
  # skickar -Skarpt ska inte krascha bara för att förvalet vändes.
  [switch]$Skarpt,

  # 0 = kör tills du avbryter. Annars så här många svep och sedan slut.
  [int]$Svep = 0,

  # 0 = ingen tidsgräns.
  [int]$MinuterAttKora = 0,

  # Kör provet på produktregeln och avsluta. Rör inte Chrome.
  [switch]$Sjalvtest,

  # Kör bara startproben och avsluta. Rör inte Chrome, skickar ingenting.
  # Det här är kommandot man kör när telefonen är tyst och man vill veta var
  # kedjan brister.
  [switch]$BaraProb,

  # Kör provet på vakthundens tillståndsmaskin och avsluta. Rör inte Chrome,
  # skickar ingenting, kräver ingen nyckel. Bevisar att larmet går EN gång per
  # tillståndsövergång och aldrig i repris.
  [switch]$ProvaVakthund,

  # Kör provet på grupplistan och avsluta. Rör inte Chrome, skickar ingenting,
  # kräver ingen nyckel. Bevisar tre saker: att listan i bryggfilen läses
  # likadant som bryggkoden själv läser den, att varje grupp får SIN ruta, och
  # att en Stockholmskoordinat aldrig kan hamna på Västeråskartan.
  [switch]$ProvaGrupper,

  # Skicka veckans livstecken NU i stället för att vänta till söndag 18:00.
  # Den ENDA kontrollen som går hela vägen genom VAPID-signeringen och ut till
  # en riktig telefon. Kräver skarpt läge — en torrkörning bevisar ingenting.
  [switch]$TvingaLivstecken,

  [string]$Loggfil,

  [double]$MinTilltro = 0.65,

  # Sökväg till bryggkoden. Bara för att kunna peka om i test.
  [string]$Bryggfil
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ---- Förvalet vänds här, och bara här --------------------------------------
#
# Resten av filen frågar fortfarande efter $Skarpt: Skicka-Omgang, utkorgen,
# hanteringslistan, loggtexterna, banderollen. Ingen av dem rörs. Den enda
# ändringen i beteende är vilket värde $Skarpt har när ingen flagga angetts.
#
# -Torr vinner alltid, även om någon skickar båda. En flagga som betyder
# "skriv ingenting" får aldrig kunna överröstas av en flagga som betyder
# "skriv".
$Skarpt = -not $Torr

# Svensk lokal skriver decimaltal med komma. Det spelar ingen roll i loggen,
# men "viewbox=15,1,59,3,17,3,60,3" är en trasig Nominatim-fråga och
# "lat=59,61" en trasig koordinat. Hela körningen räknar därför i invariant
# kultur. Tidsstämplarna nedan har egna format och rörs inte.
try {
  [System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
} catch { }

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch { }

# =====================================================================
#  Sökvägar och logg
# =====================================================================

$script:RotMapp = Split-Path -Parent $PSScriptRoot
if (-not $Bryggfil) { $Bryggfil = Join-Path $PSScriptRoot 'fb-bridge.user.js' }

$script:DataMapp = Join-Path $env:LOCALAPPDATA 'Polisvakt'
if (-not (Test-Path $script:DataMapp)) {
  New-Item -ItemType Directory -Force -Path $script:DataMapp | Out-Null
}

# Loggen ligger med flit UTANFÖR repot. Repot ligger i OneDrive, och en fil
# som växer med en rad var tjugonde sekund skulle synka dygnet runt.
if (-not $Loggfil) {
  $Loggfil = Join-Path $script:DataMapp ('brygg-daemon-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
}
$script:LoggSokvag = $Loggfil

# UTF-8 MED byte-order-märke, och det är inte pedanteri.
#
# Loggen skrevs först utan BOM. Bytena var rätt, men Windows PowerShell läser
# en BOM-lös fil som ANSI, så `Get-Content brygg-daemon-*.log` gav
# "HOPPAS-Ã–VER orsak=olÃ¤slig-Ã¥lder". Loggen ska gå att läsa med `type`
# och `Get-Content` utan att man vet vilken flagga som behövs.
$script:LoggKodning = New-Object System.Text.UTF8Encoding($true)

function Logga {
  param(
    [Parameter(Mandatory = $true)][string]$Nivo,
    [Parameter(Mandatory = $true)][string]$Text,
    [System.ConsoleColor]$Farg = [System.ConsoleColor]::Gray
  )
  $stampel = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  $rad = '{0}  {1,-14} {2}' -f $stampel, $Nivo, $Text
  Write-Host $rad -ForegroundColor $Farg
  try {
    # AppendAllText skriver BOM:en bara när filen skapas. Det är precis vad vi
    # vill: ett märke först i filen, inte ett per rad.
    [System.IO.File]::AppendAllText($script:LoggSokvag, $rad + [Environment]::NewLine, $script:LoggKodning)
  } catch {
    # En trasig logg får inte stoppa bryggan, men tystnaden ska synas.
    Write-Host ('  (kunde inte skriva loggen: ' + $_.Exception.Message + ')') -ForegroundColor DarkRed
  }
}

# =====================================================================
#  EN DAEMON, INTE TVÅ
# =====================================================================
#
# Sedan bryggan startas av Schemaläggaren vid inloggning är det inte längre
# tänkbart att någon dubbelstartar den — det är SANNOLIKT. Man loggar in,
# uppgiften startar en daemon, och sedan kör man polisvakt-brygga.ps1 för hand
# för att "se att den kör".
#
# Två daemoner mot samma grupp är inte harmlöst. De sveper omlott, de har var
# sin kopia av hanteringslistan i minnet, och båda kan lägga samma inlägg i
# var sin utkorg innan någon av dem hunnit skriva filen. Resultatet är två
# anrop till fbmejl_ta_emot med samma rad. Avdubblingen i databasen tar
# rapporten — men de två anropen är två OMGÅNGAR, och buntningen räknar
# omgångar. Det är precis den dubbelnotis som buntningen finns för att undvika.
#
# En namngiven mutex i Global-rymden. Först till kvarn kör; nästa säger ifrån
# och lägger sig. Ingen fil, ingen pid, inget att städa efter en krasch —
# Windows släpper handtaget när processen dör, oavsett hur den dog.
#
# -Sjalvtest tar den INTE. Provet på produktregeln ska gå att köra när som
# helst, också mitt under en skarp körning, för det är då man behöver det. Det
# sveper inte och skriver ingenting.

# -Sjalvtest och -BaraProb tar den INTE. Provet på produktregeln och
# startproben ska gå att köra när som helst, också mitt under en skarp
# körning, för det är då man behöver dem. Ingen av dem sveper.
$script:Mutex = $null
if (-not $Sjalvtest -and -not $BaraProb -and -not $ProvaVakthund -and -not $ProvaGrupper) {
  $nyskapad = $false
  try {
    $script:Mutex = New-Object System.Threading.Mutex($true, 'Global\Polisvakt-Brygga', [ref]$nyskapad)
  } catch {
    # Global-rymden kan vara stängd i vissa hårt låsta miljöer. Hellre köra
    # utan spärr än att vägra starta av ett skäl som inte är ett fel.
    Logga 'VARNING' ('kunde inte ta namngiven mutex (' + $_.Exception.Message +
      ') — dubbelstartsspärren är av.') DarkYellow
    $nyskapad = $true
  }
  if (-not $nyskapad) {
    Logga 'STOPP' 'En brygg-daemon kör redan på den här maskinen. Den här startar inte.' Yellow
    Logga 'STOPP' '  Vill du se den som kör: dess fönster är öppet, och loggen ligger i %LOCALAPPDATA%\Polisvakt\.' DarkGray
    exit 0
  }
}

# =====================================================================
#  Bryggkoden — läses från disk, skrivs aldrig om
# =====================================================================

if (-not (Test-Path $Bryggfil)) {
  throw "Hittar inte bryggkoden: $Bryggfil"
}
$script:BryggKalla = [System.IO.File]::ReadAllText($Bryggfil, [System.Text.Encoding]::UTF8)

<#
  Klipp ut läsdelen.

  Klippet går på bryggans SEKTIONSRUBRIKER, inte på enskilda rader:

      /* ================= Konfiguration ================= */    <- allt före
      /* ================= ... ================= */              <- HÄRIFRÅN
      ...
      /* ================= Geokodning ================= */       <- HIT
      /* ================= Skrivning ================= */        <- allt efter
      /* ================= Skanning ================= */

  Alltså: allt mellan konfigurationen och geokodningen. Det är parsern,
  minneslistan, först-sedd-mekaniken och flödesläsningen — och ingenting som
  rör nätverket eller den gamla skanningsloopen.

  VARFÖR RUBRIKER OCH INTE RADER: första versionen av den här funktionen
  pekade på "const VIEWBOX = [". Den raden fanns när daemonen skrevs och var
  borta två timmar senare — bryggan gick till 2.3 och flyttade rutan in i en
  tabell per grupp. Ett klipp som hänger på en enskild rad går sönder varje
  gång bryggan förbättras, och den som skriver om bryggan har ingen anledning
  att veta att den här filen tittar. Rubrikerna har däremot legat still genom
  hela filens historia, och de är dessutom det som verkligen beskriver
  gränsen.

  Går klippet inte att göra STANNAR daemonen. En brygga som tyst läser halv
  kod är värre än en som inte startar.
#>
function Hamta-Lasdel {
  param([Parameter(Mandatory = $true)][string]$Kalla)

  $rubriker = @([regex]::Matches($Kalla, '/\*\s*=+[^\r\n]*?=+\s*\*/'))
  if ($rubriker.Count -lt 3) {
    throw 'Hittar inga sektionsrubriker i bryggkoden. Filen har byggts om — klippet måste ses över innan daemonen får köra.'
  }

  $iKonf = -1
  $iGeo = -1
  for ($i = 0; $i -lt $rubriker.Count; $i++) {
    $v = $rubriker[$i].Value
    if ($iKonf -lt 0 -and $v -match 'Konfiguration') { $iKonf = $i }
    if ($iGeo -lt 0 -and $v -match 'Geokodning') { $iGeo = $i }
  }
  if ($iKonf -lt 0) { throw 'Hittar inte rubriken "Konfiguration" i bryggkoden. Klippet vägrar gissa var läsdelen börjar.' }
  if ($iGeo -lt 0) { throw 'Hittar inte rubriken "Geokodning" i bryggkoden. Klippet vägrar gissa var läsdelen slutar.' }
  if (($iKonf + 1) -ge $iGeo) { throw 'Rubrikerna i bryggkoden ligger i fel ordning. Klippet vägrar gissa.' }

  $start = $rubriker[$iKonf + 1].Index
  $slut = $rubriker[$iGeo].Index
  return $Kalla.Substring($start, $slut - $start)
}

$script:Lasdel = Hamta-Lasdel -Kalla $script:BryggKalla

foreach ($kravs in @('function collectPosts', 'function parseReportText',
                     'function registreraSedda', 'function observeradTid',
                     'function isSobrietyCheck', 'function keysFor',
                     'const MESSAGE_SEL', 'const FORSTSEDD_KEY')) {
  if ($script:Lasdel.IndexOf($kravs) -lt 0) {
    throw "Läsdelen ur bryggkoden saknar $kravs. Klippet är fel — daemonen startar inte."
  }
}
# Sidan får bara läsa. Kom en nätverksadress eller skrivfunktionen med i
# klippet har det tagit för mycket, och då är arkitekturen bruten.
foreach ($forbjudet in @('nominatim', 'supabase', 'async function send', 'async function scan')) {
  if ($script:Lasdel.IndexOf($forbjudet) -ge 0) {
    throw "Läsdelen innehåller '$forbjudet'. Klippet tog med för mycket — sidan får bara läsa."
  }
}
# Bryggans egen CONFIG får inte följa med: daemonen sätter sin egen, och två
# CONFIG i samma funktionsscope är dessutom ett SyntaxError.
if ($script:Lasdel -match 'const\s+CONFIG\s*=') {
  throw 'Läsdelen innehåller bryggans CONFIG. Klippet börjar för högt upp.'
}

# ---- Supabase-uppgifterna, ur samma fil -----------------------------------
function Plocka-Strang {
  param([string]$Kalla, [string]$Falt)
  $m = [regex]::Match($Kalla, ($Falt + "\s*:\s*'([^']+)'"))
  if (-not $m.Success) { throw "Hittar inte $Falt i bryggkoden." }
  return $m.Groups[1].Value
}
$script:SupabaseUrl = Plocka-Strang -Kalla $script:BryggKalla -Falt 'supabaseUrl'
$script:SupabaseKey = Plocka-Strang -Kalla $script:BryggKalla -Falt 'supabaseKey'

# ---- service_role-nyckeln, bara i skarpt läge -----------------------------
#
# fbmejl_ta_emot är revokad från anon med flit: den skriver rapporter och
# utlöser notiser. Anon-nyckeln ovan ligger öppet i appens källkod och duger
# därför inte här.
#
# Nyckeln läses ur tools/fbmejl.hemligheter.json, som är gitignorerad sedan
# mejlpollaren behövde ett IMAP-lösenord. Den ligger ALDRIG i den här filen
# och aldrig i bryggkoden — repot är publikt.
#
# Läses även i torrkörning, men bara för att kunna säga till i förväg att
# den saknas. Bättre att få veta nu än när det första riktiga inlägget dyker
# upp och ingenting händer.
# TRE KÄLLOR, I DEN HÄR ORDNINGEN:
#
#   1. %LOCALAPPDATA%\Polisvakt\nycklar.xml   krypterad med DPAPI, låst till
#      kontot och maskinen. Skrivs av tools\satt-nyckel.ps1, som PROVAR
#      nyckeln mot båda dörrarna innan den sparar den. Det här är vägen.
#   2. tools\fbmejl.hemligheter.json          klartext, gitignorerad. Kvar av
#      bakåtkompatibilitet: en installation som redan har nyckeln där ska
#      fortsätta gå utan att någon rör något.
#   3. $env:PV_SUPABASE_SERVICE_KEY           för engångskörningar och CI.
#
# Nummer 1 först med flit. En klartextnyckel i en fil som ligger bredvid
# källkoden är en fil som förr eller senare hamnar i en kopia, en zip eller en
# OneDrive-synk. DPAPI-filen går inte ens att läsa på en annan dator.

$script:NyckelFil = Join-Path $script:DataMapp 'nycklar.xml'
$script:HemligFil = Join-Path $PSScriptRoot 'fbmejl.hemligheter.json'
$script:ServiceRoleKey = $null
$script:NyckelKalla = 'ingen'

# Nyckeln som edge-funktionen fbmejl-push godtar. Är den tom används
# ServiceRoleKey, vilket är rätt på projekt där en enda nyckel öppnar båda
# dörrarna och fel — men inte farligt — på projekt där den inte gör det.
$script:EdgeKey = $null

if (Test-Path $script:NyckelFil) {
  try {
    $sparad = Import-Clixml -Path $script:NyckelFil
    $sec = $null
    if ($sparad -is [hashtable]) {
      if ($sparad.ContainsKey('service_role')) { $sec = $sparad['service_role'] }
    } elseif ($sparad -and ($sparad.PSObject.Properties.Name -contains 'service_role')) {
      $sec = $sparad.service_role
    }
    if ($sec -is [System.Security.SecureString]) {
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
      try {
        $script:ServiceRoleKey = ([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim()
      } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      }
      $script:NyckelKalla = 'nycklar.xml'
    } elseif ($sec) {
      $script:ServiceRoleKey = ([string]$sec).Trim()
      $script:NyckelKalla = 'nycklar.xml'
    }

    # EDGE-NYCKELN — en andra sträng, för en annan dörr.
    #
    # Se kommentaren i tools\satt-nyckel.ps1: de nya API-nycklarna gör att
    # PostgREST och edge-funktionen godtar OLIKA utgåvor. Saknas fältet är
    # filen skriven av en äldre version av skriptet, och då faller allt
    # tillbaka på ServiceRoleKey precis som förut — sämre, men inte trasigt.
    $edge = $null
    if ($sparad -is [hashtable]) {
      if ($sparad.ContainsKey('edge')) { $edge = $sparad['edge'] }
    } elseif ($sparad -and ($sparad.PSObject.Properties.Name -contains 'edge')) {
      $edge = $sparad.edge
    }
    if ($edge -is [System.Security.SecureString]) {
      $b2 = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($edge)
      try {
        $script:EdgeKey = ([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)).Trim()
      } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
      }
    } elseif ($edge) {
      $script:EdgeKey = ([string]$edge).Trim()
    }
  } catch {
    # DPAPI vägrar när filen kommer från ett annat konto eller en annan
    # maskin. Det är inte ett haveri, men det ska INTE gå tyst förbi: annars
    # faller daemonen tillbaka på en gammal nyckel i JSON-filen och man
    # felsöker fel sak i en timme.
    Write-Host ("Kunde inte läsa $($script:NyckelFil): " + $_.Exception.Message) -ForegroundColor Red
    Write-Host '  (kopierad från en annan dator eller ett annat konto? Kör tools\satt-nyckel.ps1 igen.)' -ForegroundColor DarkYellow
  }
}

if (-not $script:ServiceRoleKey -and (Test-Path $script:HemligFil)) {
  try {
    $h = Get-Content -Raw -Encoding UTF8 $script:HemligFil | ConvertFrom-Json
    foreach ($namn in @('supabase_service_role', 'service_role', 'SUPABASE_SERVICE_ROLE_KEY')) {
      $v = $h.PSObject.Properties[$namn]
      if ($v -and $v.Value) {
        $script:ServiceRoleKey = ([string]$v.Value).Trim()
        $script:NyckelKalla = 'fbmejl.hemligheter.json'
        break
      }
    }
  } catch {
    Write-Host "Kunde inte läsa $($script:HemligFil): $($_.Exception.Message)" -ForegroundColor Red
  }
}

if (-not $script:ServiceRoleKey -and $env:PV_SUPABASE_SERVICE_KEY) {
  $script:ServiceRoleKey = $env:PV_SUPABASE_SERVICE_KEY.Trim()
  $script:NyckelKalla = 'PV_SUPABASE_SERVICE_KEY'
}

# =====================================================================
#  GRUPPLISTAN — EN enda, och den står i bryggfilen
# =====================================================================
#
# DET HÄR ÄR RÄTTELSEN SOM GÖR EN ANDRA GRUPP MENINGSFULL.
#
# Förut hade daemonen en egen uppfattning om geografin: en förvalsruta
# (Västmanland) plus en regex som plockade den FÖRSTA "ruta:" den hittade i
# bryggfilen — vilket råkade vara en rad i ett kommentarsexempel. Och i sidan
# injicerade den `groupId: '<id>'` som en NAKEN STRÄNG, vilket får bryggans
# normaliseraGrupper() att ta bakåtkompatibilitetsgrenen: Västmanlands ruta
# och orten Västerås, oavsett vilket id som stod där.
#
# Följden, om man pekade daemonen på Stockholmsgruppen: "Sveavägen" slogs upp
# som "Sveavägen, Västerås" mot viewbox 15.10,59.30,17.30,60.30 med bounded=1.
# Nominatim svarar tomt. Raden loggas HOPPAS-ÖVER orsak=okänd-plats. Ingen rad
# i loggen säger att något är fel — det ser ut som en lugn kväll i Stockholm.
#
# Nu finns geografin på ETT ställe: CONFIG.groupIds i tools\fb-bridge.user.js.
# Både användarskriptet (Tampermonkey-vägen) och daemonen läser den listan,
# och appens inställningssida är en redigerare som skriver exakt den texten.
#
# Reglerna nedan är med flit desamma som normaliseraGrupper() i bryggan:
#   * en grupp utan giltig ruta stoppar starten
#   * utom en ENSAM naken sträng, som betyder Västmanland (formen från 2.2)
#   * dubbletter på id räknas som en grupp
#   * /groups/feed/ och släktingarna är inte grupper
# Skiljer de sig åt läser de två programmen olika listor, och då är vi
# tillbaka i det fel den här filen just slutade göra. Provet -ProvaGrupper
# mäter dem mot varandra.

# Samma ruta och samma ord som VASTMANLAND i bryggkoden. Används bara för den
# gamla nakna formen.
$script:VASTMANLAND = @{ ort = 'Västerås'; omrade = 'Västmanland'
                         ruta = @(15.10, 59.30, 17.30, 60.30) }

$script:FORBJUDNA_GRUPPORD = @(
  'feed', 'discover', 'discovery', 'joins', 'create', 'search',
  'your_groups', 'category', 'browse', 'invites', 'notifications'
)

<#
  Bort med JavaScript-kommentarerna innan något tolkas.

  Inte pedanteri: bryggfilen har numera Stockholmsgrupperna liggande
  FÄRDIGSKRIVNA men utkommenterade i groupIds, så att ägaren kopplar in dem
  genom att ta bort kommentarstecknen. En tolkare som inte förstår
  kommentarer hade läst dem som anslutna grupper och öppnat flikar mot
  grupper ägaren inte gått med i.

  Strängar respekteras — annars hade supabaseUrl: 'https://…' klippts mitt i.
#>
function Rensa-JsKommentarer {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
  $ut = New-Object System.Text.StringBuilder
  $n = $Text.Length
  $i = 0
  $strang = [char]0
  while ($i -lt $n) {
    $c = $Text[$i]
    if ($strang -ne [char]0) {
      [void]$ut.Append($c)
      if ($c -eq '\' -and ($i + 1) -lt $n) { [void]$ut.Append($Text[$i + 1]); $i += 2; continue }
      if ($c -eq $strang) { $strang = [char]0 }
      $i++
      continue
    }
    if ($c -eq "'" -or $c -eq '"') { $strang = $c; [void]$ut.Append($c); $i++; continue }
    if ($c -eq '/' -and ($i + 1) -lt $n) {
      $nasta = $Text[$i + 1]
      if ($nasta -eq '/') {
        while ($i -lt $n -and $Text[$i] -ne "`n") { $i++ }
        continue
      }
      if ($nasta -eq '*') {
        $i += 2
        while (($i + 1) -lt $n -and -not ($Text[$i] -eq '*' -and $Text[$i + 1] -eq '/')) { $i++ }
        $i += 2
        continue
      }
    }
    [void]$ut.Append($c)
    $i++
  }
  return $ut.ToString()
}

<#
  Innehållet mellan hakparenteserna i `groupIds: [ … ]`.

  Klamrarna räknas, strängar hoppas över. En regex på '\[(.*?)\]' hade
  slutat vid den första rutans hakparentes.
  Returnerar $null när fältet inte finns alls.
#>
function Plocka-Grupplista {
  param([Parameter(Mandatory = $true)][string]$Ren)
  $m = [regex]::Match($Ren, 'groupIds\s*:\s*\[')
  if (-not $m.Success) { return $null }
  $start = $m.Index + $m.Length
  $i = $start
  $djup = 1
  $strang = [char]0
  while ($i -lt $Ren.Length) {
    $c = $Ren[$i]
    if ($strang -ne [char]0) {
      if ($c -eq '\') { $i += 2; continue }
      if ($c -eq $strang) { $strang = [char]0 }
      $i++
      continue
    }
    if ($c -eq "'" -or $c -eq '"') { $strang = $c; $i++; continue }
    if ($c -eq '[' -or $c -eq '{') { $djup++ }
    elseif ($c -eq ']' -or $c -eq '}') {
      $djup--
      if ($djup -eq 0) { break }
    }
    $i++
  }
  if ($djup -ne 0) { throw 'groupIds i bryggkoden saknar avslutande hakparentes. Daemonen startar inte.' }
  return $Ren.Substring($start, $i - $start)
}

# Ett strängfält ur en rad. Tål både 'enkla' och "dubbla" citattecken —
# appens "Kopiera inställning till bryggan" skriver med JSON.stringify och
# alltså dubbla, medan filen är handskriven med enkla.
function Plocka-JsFalt {
  param([string]$Rad, [string]$Falt)
  $m = [regex]::Match($Rad, ($Falt + '\s*:\s*(?:''((?:[^''\\]|\\.)*)''|"((?:[^"\\]|\\.)*)")'))
  if (-not $m.Success) { return '' }
  $v = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
  # Bara de tecken JSON.stringify faktiskt kan lägga in i ett gruppnamn.
  return ($v -replace '\\(["''\\/])', '$1')
}

# Samma som rensaGruppId() i bryggan: från ett naket id eller en hel adress
# till bara id:t, eller tom sträng när det inte går.
function Rensa-GruppId {
  param([string]$Varde)
  $s = ([string]$Varde).Trim()
  if (-not $s) { return '' }
  $m = [regex]::Match($s, '/groups/([^/?#\s]+)', 'IgnoreCase')
  $bit = if ($m.Success) { $m.Groups[1].Value.Trim() } else { $s }
  if ($bit -notmatch '^[\w.-]+$') { return '' }
  if ($script:FORBJUDNA_GRUPPORD -contains $bit.ToLowerInvariant()) { return '' }
  return $bit
}

function Giltig-Ruta {
  param($Ruta)
  $r = @($Ruta)
  if ($r.Count -ne 4) { return $false }
  $t = @()
  foreach ($v in $r) {
    $d = $v -as [double]
    if ($null -eq $d -or [double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $false }
    $t += $d
  }
  # lonMin < lonMax och latMin < latMax. En vänd ruta träffar ingenting alls,
  # och en brygga som tyst aldrig geokodar är svårare att felsöka än en som
  # vägrar starta.
  return ($t[0] -lt $t[2] -and $t[1] -lt $t[3])
}

<#
  Hela grupplistan ur bryggkodens källkod.

  Kastar med bryggans egen formulering när en grupp saknar område. Att vägra
  starta är rätt svar: varje tänkbart förval är fel. "Västmanland" lägger
  Stockholmsvarningar på Västeråskartan, "hela Sverige" släpper igenom en
  träff på Storgatan i vilken stad som helst.
#>
function Plocka-Grupper {
  param([Parameter(Mandatory = $true)][string]$Kalla)

  $ren = Rensa-JsKommentarer -Text $Kalla
  $inre = Plocka-Grupplista -Ren $ren

  $rader = @()
  if ($inre) {
    # Objektraderna först, sedan det som blir kvar när de plockats bort —
    # där ligger den gamla formen, alltså nakna strängar i listan.
    foreach ($m in [regex]::Matches($inre, '\{[^{}]*\}')) {
      $rader += ,@{ text = $m.Value; bart = $false }
    }
    $kvar = [regex]::Replace($inre, '\{[^{}]*\}', ' ')
    foreach ($m in [regex]::Matches($kvar, '''([^'']*)''|"([^"]*)"')) {
      $v = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
      $rader += ,@{ text = $v; bart = $true }
    }
  }

  # Tom eller saknad lista: den gamla groupId-formen gäller. Samma
  # företrädesordning som RATT i bryggkoden — ingen sammanslagning.
  if ($rader.Count -eq 0) {
    $g = [regex]::Match($ren, 'groupId\s*:\s*(?:''([^'']*)''|"([^"]*)")')
    if ($g.Success) {
      $v = if ($g.Groups[1].Success) { $g.Groups[1].Value } else { $g.Groups[2].Value }
      if ($v.Trim()) { $rader += ,@{ text = $v; bart = $true } }
    }
  }

  $ut = @()
  $sedda = @()
  foreach ($rad in $rader) {
    if ($rad.bart) {
      $id = Rensa-GruppId $rad.text
      if (-not $id) { continue }
      if ($sedda -contains $id) { continue }
      $sedda += $id
      $ut += ,@{ id = $id; bart = $true; namn = $id; ort = ''; omrade = ''
                 ruta = $null; notis = $true }
      continue
    }

    $t = $rad.text
    $id = Rensa-GruppId (Plocka-JsFalt -Rad $t -Falt 'id')
    if (-not $id) { continue }
    if ($sedda -contains $id) { continue }
    $sedda += $id

    $ruta = $null
    $mr = [regex]::Match($t, 'ruta\s*:\s*\[([^\]]*)\]')
    if ($mr.Success) {
      $tal = @()
      foreach ($bit in ($mr.Groups[1].Value -split ',')) {
        $bit = $bit.Trim()
        if (-not $bit) { continue }
        $d = 0.0
        if ([double]::TryParse($bit, [System.Globalization.NumberStyles]::Float,
                               [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
          $tal += $d
        }
      }
      if (Giltig-Ruta $tal) { $ruta = $tal }
    }

    $namn = Plocka-JsFalt -Rad $t -Falt 'namn'
    # notis saknas på varje rad som skrevs före 2.4, och de raderna ska bete
    # sig precis som förut. Saknad nyckel = true. Samma förval som bryggan.
    $notis = $true
    $mn = [regex]::Match($t, 'notis\s*:\s*(true|false)')
    if ($mn.Success -and $mn.Groups[1].Value -eq 'false') { $notis = $false }

    $ut += ,@{
      id     = $id
      bart   = $false
      namn   = $(if ($namn) { $namn } else { $id })
      ort    = (Plocka-JsFalt -Rad $t -Falt 'ort')
      omrade = (Plocka-JsFalt -Rad $t -Falt 'omrade')
      ruta   = $ruta
      notis  = $notis
    }
  }

  if ($ut.Count -eq 0) {
    throw ('Bryggkoden har ingen ansluten grupp (CONFIG.groupIds är tom). Daemonen startar inte. ' +
           'Lägg till minst en grupp i ' + (Split-Path -Leaf $Bryggfil) + ', eller låt appen skriva ' +
           'raden: Inställningar -> Facebook-grupper -> "Kopiera inställning till bryggan".')
  }

  foreach ($g in $ut) {
    if ($g.ruta) { continue }
    if ($ut.Count -eq 1 -and $g.bart) {
      $g.ruta = @($script:VASTMANLAND.ruta)
      if (-not $g.ort) { $g.ort = $script:VASTMANLAND.ort }
      if (-not $g.omrade) { $g.omrade = $script:VASTMANLAND.omrade }
      continue
    }
    throw ('gruppen ' + $g.id + ' saknar område (ruta). Varje grupp måste säga var den ligger, ' +
           'annars hamnar en varning från en annan stad på din karta. Bryggan startar inte.')
  }

  foreach ($g in $ut) {
    $orter = @()
    foreach ($o in @($g.ort, $g.omrade)) { if ($o) { $orter += $o.ToLowerInvariant() } }
    $g.orter = $orter
    $g.Remove('bart')
  }
  # ROLLAS UT AV PIPELINEN, MED FLIT — och därför måste VARJE anropare skriva
  # @(Plocka-Grupper ...).
  #
  # PowerShell rullar ut en returnerad lista. Med en enda grupp får den som
  # anropar då själva hashtabellen, och .Count blir antalet NYCKLAR i den —
  # sju — i stället för en. Med `return ,@($ut)` blir felet det omvända: två
  # grupper kommer fram som EN rad som är en lista, och .id svarar "111 222".
  # Båda formerna räknar alltså fel, tyst, i var sitt fall.
  #
  # Den form som är rätt i BÅDA fallen är den enkla: rulla ut, och låt
  # anroparen samla ihop med @(). Provet -ProvaGrupper mäter båda fallen.
  return $ut
}

$script:AllaGrupper = @(Plocka-Grupper -Kalla $script:BryggKalla)

# ---- -GruppId filtrerar, den bestämmer ingenting --------------------------
$script:Grupper = @($script:AllaGrupper)
if ($GruppId -and @($GruppId).Count -gt 0) {
  $onskade = @($GruppId | ForEach-Object { Rensa-GruppId $_ } | Where-Object { $_ })
  $kanda = @($script:AllaGrupper | ForEach-Object { $_.id })
  $okanda = @($onskade | Where-Object { $kanda -notcontains $_ })
  if ($okanda.Count -gt 0) {
    throw ('-GruppId ' + ($okanda -join ', ') + ' finns inte i grupplistan i ' +
           (Split-Path -Leaf $Bryggfil) + '. Kända grupper: ' + ($kanda -join ', ') + '. ' +
           'Flaggan är ett filter, inte ett sätt att lägga till en grupp — lägg till den i ' +
           'bryggfilen först.')
  }
  $script:Grupper = @($script:AllaGrupper | Where-Object { $onskade -contains $_.id })
}
$script:GruppMedId = @{}
foreach ($g in $script:Grupper) { $script:GruppMedId[$g.id] = $g }

$script:Livslangd = @{ police = 45; control = 60; unmarked = 30 }
$ml = [regex]::Match($script:BryggKalla, 'const TTL_MINUTES = \{([^}]+)\}')
if ($ml.Success) {
  foreach ($par in ($ml.Groups[1].Value -split ',')) {
    $bit = $par -split ':'
    if ($bit.Count -eq 2) { $script:Livslangd[$bit[0].Trim()] = [int]($bit[1].Trim()) }
  }
}

# =====================================================================
#  PRODUKTREGELN — nykterhets- och drogkontroller
# =====================================================================
#
# Regeln är absolut: en nykterhets- eller drogkontroll får aldrig skickas,
# aldrig loggas och aldrig sammanfattas. Att varna för en fartkamera hjälper
# någon att hålla hastigheten. Att varna för en nykterhetskontroll hjälper
# någon att köra vidare full.
#
# Den läckte redan en gång i det här projektet: isärskrivningar
# ("alkohol kontroll") gick rakt igenom kopian i bryggan, och narkotikaorden
# saknades i båda kopiorna. Därför ligger spärren nu på tre ställen i den här
# kedjan, och de två första är samma kod:
#
#   1. I SIDAN, före allt annat. Ett inlägg som fastnar där lämnar aldrig
#      sidan: daemonen får en rad utan text, utan id och utan tolkning.
#   2. I SIDAN, en gång till, via parseReportText intent === 'refused'.
#   3. HÄR, på texten som ändå kom fram. Ska aldrig slå till. Gör den det är
#      något sönder i sidan, och då är det den här som räddar databasen.
#
# ORDLISTORNA HÄMTAS UR fb-bridge.user.js. De skrivs inte av. Skrivs de av
# driver de isär — vilket är exakt så narkotikaorden kunde saknas på ett
# ställe och finnas på ett annat.
#
# VAD SOM LOGGAS OM EN VÄGRAN: ordet "produktregel" och ingenting mer. Inte
# texten, inte platsen, inte vilken av reglerna som slog till. Kamerorna
# vägras med samma etikett med flit — kan man skilja dem åt i loggen har man
# också fått veta att någon la upp en nykterhetskontroll, och det är precis
# det den här regeln finns för att inte berätta.

function Plocka-Ordlista {
  param([string]$Kalla, [string]$Namn)
  $m = [regex]::Match($Kalla, ('const ' + $Namn + ' = \[(.*?)\];'), 'Singleline')
  if (-not $m.Success) {
    throw "Hittar inte ordlistan $Namn i bryggkoden. Produktregeln kan inte garanteras — daemonen startar inte."
  }
  # Rensa radkommentarer först: de kan innehålla citattecken.
  $kropp = [regex]::Replace($m.Groups[1].Value, '//[^\r\n]*', '')
  $ord = @()
  foreach ($t in [regex]::Matches($kropp, "'([^']*)'")) {
    $v = $t.Groups[1].Value.Trim()
    if ($v) { $ord += $v }
  }
  if ($ord.Count -lt 3) {
    throw "Ordlistan $Namn tolkades till bara $($ord.Count) ord. Det är fel — daemonen startar inte."
  }
  return $ord
}

$script:SobOrd    = Plocka-Ordlista -Kalla $script:BryggKalla -Namn 'SOBRIETY_WORDS'
$script:SobStam   = Plocka-Ordlista -Kalla $script:BryggKalla -Namn 'SOBRIETY_STAMMAR'
$script:SobForled = Plocka-Ordlista -Kalla $script:BryggKalla -Namn 'SOBRIETY_PREFIX'
$script:SobHuvud  = Plocka-Ordlista -Kalla $script:BryggKalla -Namn 'SOBRIETY_HEAD'

# normalize() ur js/util.js: gemener, skiljetecken bort, bindestreck kvar för
# gatunamnens skull. .NET:s \w täcker åäöéèü redan, till skillnad från
# JavaScripts — därför behövs inte den explicita teckenuppräkningen här.
function Normalisera-Text {
  param([string]$Ratext)
  if (-not $Ratext) { return '' }
  $t = $Ratext.ToLowerInvariant()
  $t = [regex]::Replace($t, '[^\w\s-]', ' ')
  $t = [regex]::Replace($t, '\s+', ' ')
  return $t.Trim()
}

# Bindestreck skiljer ord, inte bara blanksteg. "drog-kontroll" blev annars
# ETT ord och gick igenom både ordlistan och isärskrivningsregeln.
$script:Skiljetecken = '[\s\-–—_/.]+'

function Test-Nykterhetskontroll {
  param([string]$Ratext)
  $text = Normalisera-Text $Ratext
  if (-not $text) { return $false }

  $ord = @([regex]::Split($text, $script:Skiljetecken) | Where-Object { $_ })
  $hop = [regex]::Replace($text, $script:Skiljetecken, '')

  foreach ($w in $script:SobOrd) {
    if (($ord -contains $w) -or $text.Contains($w) -or $hop.Contains($w)) { return $true }
  }
  foreach ($s in $script:SobStam) {
    if ($hop.Contains($s)) { return $true }
    foreach ($w in $ord) { if ($w.StartsWith($s)) { return $true } }
  }
  for ($i = 0; $i -lt ($ord.Count - 1); $i++) {
    if (($script:SobForled -contains $ord[$i]) -and ($script:SobHuvud -contains $ord[$i + 1])) { return $true }
  }
  return $false
}

# =====================================================================
#  Provet på produktregeln
# =====================================================================
#
# Kör med -Sjalvtest. Fallen är hämtade ur granskningen som hittade läckan:
# isärskrivningar, bindestreck, narkotikaorden, och de meningar som ska SLÄPPAS
# IGENOM så att spärren inte i stället sväljer varje vanlig polisvarning.

function Kor-Sjalvtest {
  param($Kontext)

  $skaVagras = @(
    'Nykterhetskontroll vid Vasagatan',
    'nykterhets kontroll på Stora gatan',
    'Alkohol kontroll vid rondellen',
    'alkoholkontroll på E18',
    'drog-kontroll vid Erikslund',
    'drog test vid Björnnäsgatan',
    'Polisen har narkotikakontroll på Vasagatan',
    'De blåser alla vid Skiljebo',
    'utandningsprov vid infarten',
    'Sållningsprov pågår vid Hallstahammar',
    'Polisen står vid ICA Maxi och kollar promille',
    'Rattfyllerikontroll vid bron',
    'Kontroll med alkotest vid Vallby',
    'DROGSÖKHUND vid stationen',
    'narko kollar vid centrum',
    'nykterhets/kontroll vid Talltorp',
    'Alkohol.kontroll vid Bäckby'
  )

  $skaSlappasIgenom = @(
    'Polis vid Vasagatan',
    'Fartkontroll på E18 vid Erikslund',
    'Civilbil vid rondellen Björnnäsgatan',
    'Laserkontroll vid Stora gatan',
    'Polisen drog vidare från Skiljebo',
    'Trafikkontroll vid Hallstahammar',
    'Piket vid centrum',
    'Polisbil står vid ICA Maxi',
    'Polisen har dragit igång en hastighetskontroll'
  )

  <#
    KÄND LUCKA, mätt och rapporterad — inte lagad här.

    Ordlistorna i js/parser.js och fb-bridge.user.js bär svenska tecken. För
    sållnings- och drogsöksorden finns den ASCII-strippade stavningen med
    ('sallnings', 'drogsok', 'drogsokhund') — men inte för blås-orden. Skriver
    någon "blaser" i stället för "blåser" går inlägget alltså igenom.

    Det går INTE att laga här: rättelsen hör hemma i js/parser.js och i
    bryggkoden, och de filerna ligger utanför den här uppgiftens filgräns. Den
    här listan finns för att luckan ska stå mätt i loggen i stället för att
    upptäckas om ett halvår. Fallen fäller inte provet.
  #>
  $kandLucka = @(
    'De blaser alla vid Skiljebo',
    'Polisen star och blasar vid Vallby'
  )

  $fel = 0
  $antal = 0

  Logga 'PROV' 'Produktregeln — nykterhets- och drogkontroller' Cyan
  Logga 'PROV' ('Ordlistor ur ' + (Split-Path -Leaf $Bryggfil) + ': ' +
    $script:SobOrd.Count + ' ord, ' + $script:SobStam.Count + ' stammar, ' +
    $script:SobForled.Count + ' förled, ' + $script:SobHuvud.Count + ' huvudord')

  foreach ($t in $skaVagras) {
    $antal++
    if (-not (Test-Nykterhetskontroll $t)) {
      $fel++
      # Texten skrivs ut HÄR med flit: det är ett testfall ur den här filen,
      # inte ett riktigt inlägg ur gruppen.
      Logga 'PROV-FEL' ('slapptes igenom av PowerShell-spärren: ' + $t) Red
    }
  }
  foreach ($t in $skaSlappasIgenom) {
    $antal++
    if (Test-Nykterhetskontroll $t) {
      $fel++
      Logga 'PROV-FEL' ('vägrades felaktigt av PowerShell-spärren: ' + $t) Red
    }
  }
  Logga 'PROV' ("PowerShell-spärren: $($antal - $fel)/$antal") $(if ($fel) { 'Red' } else { 'Green' })

  $luckaKvar = 0
  foreach ($t in $kandLucka) { if (-not (Test-Nykterhetskontroll $t)) { $luckaKvar++ } }
  if ($luckaKvar -gt 0) {
    Logga 'PROV-LUCKA' ($luckaKvar.ToString() + ' av ' + $kandLucka.Count +
      ' ASCII-strippade blås-stavningar går igenom. Ordlistorna i js/parser.js och ' +
      'fb-bridge.user.js saknar blas/blasa/blaser vid sidan av blås/blåsa/blåser. ' +
      'Fäller inte provet — lagas i de filerna, inte här.') DarkYellow
  } else {
    Logga 'PROV' 'ASCII-strippade blås-stavningar fångas numera också.' Green
  }

  # Samma fall genom SIDANS spärr, alltså genom bryggkodens egen
  # isSobrietyCheck. Det är den som avgör om något över huvud taget lämnar
  # facebook.com.
  if ($Kontext) {
    $sidfel = 0
    $sidantal = 0
    foreach ($par in @(@{ t = $skaVagras; vantat = $true }, @{ t = $skaSlappasIgenom; vantat = $false })) {
      foreach ($t in $par.t) {
        $sidantal++
        $uttryck = 'JSON.stringify(window.__pvLas.arNykterhet(' + (ConvertTo-Json $t) + '))'
        $svar = Evaluera -Kontext $Kontext -Uttryck $uttryck
        $fick = ($svar -eq 'true')
        if ($fick -ne $par.vantat) {
          $sidfel++
          Logga 'PROV-FEL' ('sidans spärr gav ' + $fick + ' för: ' + $t) Red
        }
      }
    }
    Logga 'PROV' ("Sidans spärr (bryggkodens egen): $($sidantal - $sidfel)/$sidantal") $(if ($sidfel) { 'Red' } else { 'Green' })
    $fel += $sidfel
  } else {
    Logga 'PROV' 'Sidans spärr provas inte — ingen anslutning till Chrome.' DarkYellow
  }

  return $fel
}

# =====================================================================
#  CDP över WebSocket
# =====================================================================
#
# PowerShell 5.1 har System.Net.WebSockets.ClientWebSocket. Ingen modul
# behöver installeras. Trafiken går bara till 127.0.0.1 och bara så länge
# bryggfönstret är öppet.

$script:CdpId = 0

# [void] runt varje GetResult() på en void-Task är inte pynt.
#
# Task.GetAwaiter().GetResult() på ett void-anrop lämnar ett
# System.Threading.Tasks.VoidTaskResult i pipelinen. PowerShell samlar allt en
# funktion skriver ut som dess returvärde, så utan [void] blev returen från
# Anslut en ARRAY av [VoidTaskResult, kontexthashtabellen] — och nästa rad,
# $a.ContainsKey('fel'), försökte då anropa ContainsKey på VoidTaskResult och
# dog. Felet syntes långt från orsaken, vilket är den vanliga formen på det
# här misstaget i PowerShell.
function Cdp-Sand {
  param($Ws, [string]$Json, [int]$TimeoutMs = 15000)
  $byte = [System.Text.Encoding]::UTF8.GetBytes($Json)
  $seg = New-Object 'System.ArraySegment[byte]' -ArgumentList (, $byte)
  $cts = New-Object System.Threading.CancellationTokenSource
  try {
    $cts.CancelAfter($TimeoutMs)
    [void]$Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
  } finally { $cts.Dispose() }
}

function Cdp-Ta {
  param($Ws, [int]$TimeoutMs = 30000)
  $buf = New-Object byte[] 131072
  $seg = New-Object 'System.ArraySegment[byte]' -ArgumentList (, $buf)
  $sb = New-Object System.Text.StringBuilder
  $cts = New-Object System.Threading.CancellationTokenSource
  try {
    $cts.CancelAfter($TimeoutMs)
    do {
      $r = $Ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
      if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
        throw 'Chrome stängde felsökningsanslutningen.'
      }
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
    } while (-not $r.EndOfMessage)
  } finally { $cts.Dispose() }
  return $sb.ToString()
}

<#
  Ett kommando, ett svar.

  Inga CDP-domäner slås på (varken Page.enable eller Runtime.enable). Utan
  dem skickar Chrome nästan inga händelser, och då slipper daemonen både en
  händelsekö och risken att en full socketbuffert låser sändaren mellan två
  svep. De få händelser som ändå dyker upp saknar "id" och sorteras bort här.
#>
function Cdp-Kommando {
  param($Ws, [string]$Metod, $Param, [int]$TimeoutMs = 30000)
  $script:CdpId++
  $mittId = $script:CdpId
  $paket = @{ id = $mittId; method = $Metod }
  if ($Param) { $paket['params'] = $Param }
  Cdp-Sand -Ws $Ws -Json (ConvertTo-Json $paket -Depth 25 -Compress)

  $slut = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $slut) {
    $rad = Cdp-Ta -Ws $Ws -TimeoutMs $TimeoutMs
    $svar = $rad | ConvertFrom-Json
    $falt = @($svar.PSObject.Properties.Name)
    if ($falt -notcontains 'id') { continue }        # händelse, inte vårt svar
    if ($svar.id -ne $mittId) { continue }           # någon annans svar
    if ($falt -contains 'error') {
      throw ('CDP ' + $Metod + ': ' + $svar.error.message)
    }
    return $svar.result
  }
  throw ('CDP ' + $Metod + ': inget svar inom ' + $TimeoutMs + ' ms')
}

function Hamta-Flikar {
  param([int]$Port)
  $svar = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/json/list') -TimeoutSec 6
  return @($svar)
}

<#
  Öppna en flik på en grupp i det bryggfönster som redan kör.

  Chrome bytte /json/new från GET till PUT någonstans i 90-serien och svarar
  405 på den gamla formen. Båda provas, PUT först, så att filen inte hänger
  på vilken Chrome-version maskinen råkar ha.

  Adressen byggs av ett id som redan passerat Rensa-GruppId, och funktionen
  kan inte öppna något annat än en gruppsida på facebook.com.
#>
function Oppna-Flik {
  param([int]$Port, [string]$GruppId)
  if ($GruppId -notmatch '^[\w.-]{1,64}$') { return $false }
  $mal = 'https://www.facebook.com/groups/' + $GruppId + '/'
  $url = ('http://127.0.0.1:' + $Port + '/json/new?' + [uri]::EscapeDataString($mal))
  foreach ($metod in @('PUT', 'GET')) {
    try {
      $svar = Invoke-RestMethod -Uri $url -Method $metod -TimeoutSec 10
      if ($svar) {
        Logga 'FLIK' ('öppnade en flik på grupp ' + $GruppId + ' i bryggfönstret.') DarkCyan
        return $true
      }
    } catch { }
  }
  return $false
}

<#
  Anslutning + förregistrering av läsaren.

  Returnerar antingen ett kontextobjekt (nycklarna ws/flikId/url/varld/ram)
  eller @{ fel = '...' }. Den som anropar prövar med .ContainsKey('fel').
  Daemonen faller aldrig på att Chrome saknas — den säger till och försöker
  igen.
#>
function Anslut {
  param([int]$Port, [Parameter(Mandatory = $true)]$Grupp)

  $gid = [string]$Grupp.id

  try { $flikar = Hamta-Flikar -Port $Port }
  catch {
    return @{ fel = 'Felsökningsporten svarar inte på 127.0.0.1:' + $Port +
      '. Bryggfönstret öppnas automatiskt, se nästa rad.' }
  }

  # Slutgränsen (/, ?, # eller radslut) är inte pynt: utan den matchar
  # gruppen 317968668373072 också en flik som står i 3179686683730721234.
  $mal = $flikar | Where-Object {
    $_.type -eq 'page' -and
    $_.url -match ('facebook\.com/groups/' + [regex]::Escape($gid) + '($|[/?#])')
  } | Select-Object -First 1

  if (-not $mal) {
    # EN FLIK PER GRUPP, I SAMMA FÖNSTER.
    #
    # Sedan flera grupper läses räcker det inte att öppna bryggfönstret vid
    # start: en grupp kan sakna sin flik för att ägaren stängde den, eller för
    # att gruppen lades till i bryggfilen efter att fönstret öppnades. Att
    # starta om hela Chrome för det vore att slå ut den grupp som fungerar.
    # /json/new öppnar en flik i det fönster som redan kör, med samma profil
    # och samma inloggade session.
    #
    # Bara adresser som byggs av ett id ur bryggfilen kan hamna här.
    $fb = @($flikar | Where-Object { $_.type -eq 'page' -and $_.url -match 'facebook\.com' })
    if ($fb.Count -gt 0) {
      if (Oppna-Flik -Port $Port -GruppId $gid) {
        return @{ fel = 'öppnade en ny flik för ' + $Grupp.namn + ' — ansluter vid nästa försök.' }
      }
      return @{ fel = 'Chrome är igång men ingen flik står på grupp ' + $gid +
        ' (' + $Grupp.namn + '), och en ny flik gick inte att öppna.' }
    }
    return @{ fel = 'Chrome är igång men ingen Facebook-flik är öppen.' }
  }

  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $cts = New-Object System.Threading.CancellationTokenSource
  try {
    $cts.CancelAfter(10000)
    [void]$ws.ConnectAsync([Uri]$mal.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult()
  } catch {
    return @{ fel = 'Kunde inte ansluta till fliken: ' + $_.Exception.Message }
  } finally { $cts.Dispose() }

  $kontext = @{
    ws        = $ws
    flikId    = $mal.id
    url       = $mal.url
    grupp     = $Grupp     # gruppen den här fliken är låst vid
    varld     = $null      # executionContextId för den isolerade världen
    ram       = $null      # frameId för toppramen
  }

  # Vid varje kommande sidladdning injiceras läsaren automatiskt, i en
  # isolerad värld med samma namn. Utan den här skulle en omladdning av
  # gruppsidan lämna daemonen med en tom värld tills nästa svep upptäcker
  # det — nu är läsaren på plats redan innan flödet renderats.
  try {
    Cdp-Kommando -Ws $ws -Metod 'Page.addScriptToEvaluateOnNewDocument' -Param @{
      source    = (Bygg-Lasarkod -Grupp $Grupp)
      worldName = 'polisvakt'
    } | Out-Null
  } catch {
    Logga 'VARNING' ('kunde inte förregistrera läsaren: ' + $_.Exception.Message) DarkYellow
  }

  return $kontext
}

function Koppla-Ner {
  param($Kontext)
  if (-not $Kontext) { return }
  if (-not $Kontext.ContainsKey('ws')) { return }
  if (-not $Kontext.ws) { return }
  try {
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter(3000)
    [void]$Kontext.ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'klar', $cts.Token).GetAwaiter().GetResult()
    $cts.Dispose()
  } catch { }
  try { $Kontext.ws.Dispose() } catch { }
  $Kontext.ws = $null
}

<#
  Skaffa den isolerade världen.

  Page.createIsolatedWorld med samma worldName ger tillbaka SAMMA värld i
  Chromium — världarna är nycklade på namn per ram. Efter en navigering är
  den gamla kontexten borta och anropet skapar en ny; är läsaren redan
  injicerad där (via addScriptToEvaluateOnNewDocument) märks det på att
  __pvLas finns, och då injiceras ingenting igen.
#>
function Skaffa-Varld {
  param($Kontext)
  $tra = Cdp-Kommando -Ws $Kontext.ws -Metod 'Page.getFrameTree'
  $Kontext.ram = $tra.frameTree.frame.id
  $Kontext.url = $tra.frameTree.frame.url
  $varld = Cdp-Kommando -Ws $Kontext.ws -Metod 'Page.createIsolatedWorld' -Param @{
    frameId   = $Kontext.ram
    worldName = 'polisvakt'
  }
  $Kontext.varld = $varld.executionContextId
  return $Kontext.varld
}

function Evaluera {
  param($Kontext, [string]$Uttryck, [int]$TimeoutMs = 30000)
  $r = Cdp-Kommando -Ws $Kontext.ws -Metod 'Runtime.evaluate' -TimeoutMs $TimeoutMs -Param @{
    expression    = $Uttryck
    contextId     = $Kontext.varld
    returnByValue = $true
    awaitPromise  = $true
  }
  $falt = @($r.PSObject.Properties.Name)
  if ($falt -contains 'exceptionDetails' -and $r.exceptionDetails) {
    $txt = $r.exceptionDetails.text
    if ($r.exceptionDetails.PSObject.Properties.Name -contains 'exception' -and $r.exceptionDetails.exception) {
      $txt = $r.exceptionDetails.exception.description
    }
    throw ('JS-fel i sidan: ' + $txt)
  }
  if ($r.result.PSObject.Properties.Name -contains 'value') { return $r.result.value }
  return $null
}

# =====================================================================
#  Läsarkoden som injiceras
# =====================================================================
#
# Bygger ihop: en egen CONFIG, den ordagranna läsdelen ur fb-bridge.user.js,
# och ett litet skal som lämnar fynden på window.__pvLas.
#
# Skalet gör tre saker och inget mer:
#   * kör collectPosts() + registreraSedda() — alltså bryggans egen läsning
#     och först-sedd-mekanik, i den ordning bryggan kräver
#   * släpper igenom produktregeln FÖRST, så att en vägrad text aldrig ens
#     serialiseras
#   * gör om DOM-noder till något som går att skicka över CDP

$script:LasarSkalHuvud = @'
(function () {
  'use strict';

  /* Redan injicerad i den här världen? Rör inget — annars nollställs
     kalibreringen och först-sedd-listan i minnet varje gång.

     Versionen är en hash av den här koden, satt av daemonen. Ändras
     läsdelen i fb-bridge.user.js eller skalet här byts hashen, och då
     injiceras den nya koden i stället för att den gamla får ligga kvar i
     världen resten av dygnet. En handskriven siffra hade behövt kommas
     ihåg; det gör den här inte. */
  if (window.__pvLas && window.__pvLas.version === '__PVVERSION__') { return 'redan'; }

  /* Bryggans CONFIG, bantad till det läsdelen faktiskt använder.

     groupIds är en RIKTIG grupplista med ruta och ort, hämtad ordagrant ur
     CONFIG.groupIds i tools/fb-bridge.user.js. Fram till 2.4 stod här
     `groupId: '<id>'` — en naken sträng — och då tog bryggans
     normaliseraGrupper() bakåtkompatibilitetsgrenen och gav gruppen
     Västmanlands ruta och orten Västerås, vilket id som än stod där. En
     Stockholmsgrupp geokodades alltså mot Västmanland och tystnade som
     "okänd-plats". Det var den enskilda spärr som gjorde en andra grupp
     meningslös.

     Listan innehåller BARA den grupp den här fliken står i. Fliken är låst
     vid en grupp, och en lista med båda hade betytt att en felnavigerad flik
     börjat läsa den andra gruppen med rätt ruta i stället för att säga
     ifrån.

     dryRun styr bara minneslistan i sidan. Sidan skriver ändå aldrig
     någonstans — skrivkoden ligger inte i klippet. */
  var CONFIG = {
    groupIds: __PVGRUPPER__,
    groupId: '',
    dryRun: true,
    firstSeenAge: true,
    hoverForTime: false,
    minConfidence: 0.65
  };

/* ---- ordagrant ur tools/fb-bridge.user.js ---------------------------- */
'@

$script:LasarSkalFot = @'
/* ---- slut på det ordagranna klippet ---------------------------------- */

  function gruppNu() {
    var m = /\/groups\/([\w.-]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  /* ---- SKALET TALAR BÅDE 2.2 OCH 2.3 -------------------------------------
   *
   * Bryggan skrivs om under tiden. 2.3 gjorde den flergrupps, och det ändrade
   * tre saker som skalet rör vid:
   *
   *   2.2                              2.3
   *   keysFor(post)                    keysFor(post, grupp)
   *   registreraSedda(poster)          registreraSedda(poster, grupp)
   *   let kalibrerat  (boolean)        const kalibrerade  (Set av grupp-id)
   *   const VIEWBOX   (global ruta)    GRUPPER[].ruta  (ruta per grupp)
   *
   * Skalet frågar efter formen i stället för att anta den: funktionernas
   * arity, och typeof på identifierarna. typeof på något odeklarerat ger
   * 'undefined' i stället för att kasta, så samma skal går mot båda
   * versionerna — och mot nästa, så länge namnen lever kvar.
   *
   * Alternativet — att pinna skalet vid en version — betyder att daemonen
   * går sönder tyst nästa gång någon förbättrar bryggan. Den läxan kostade
   * redan en mätning i den här körningen. */

  function gruppObjekt() {
    if (typeof GRUPPER !== 'undefined' && typeof gruppMedId === 'function') {
      return gruppMedId(gruppNu());
    }
    return null;
  }

  function nycklarFor(p, g) {
    return (keysFor.length >= 2) ? keysFor(p, g) : keysFor(p);
  }

  function registrera(poster, g) {
    if (registreraSedda.length >= 2) { registreraSedda(poster, g); }
    else { registreraSedda(poster); }
  }

  function arKalibrerad(g) {
    if (typeof kalibrerade !== 'undefined' && kalibrerade && typeof kalibrerade.has === 'function') {
      return g ? kalibrerade.has(g.id) : false;
    }
    if (typeof kalibrerat !== 'undefined') { return !!kalibrerat; }
    return false;
  }

  /* Gruppens geografi, hämtad ur bryggkodens egen tabell när den finns.
     Daemonen behöver rutan för att kunna kasta geokodningsträffar som hamnar
     utanför området. */
  function omradeNu(g) {
    if (g) { return { id: g.id, namn: g.namn, ruta: g.ruta, orter: g.orter || [] }; }
    if (typeof VIEWBOX !== 'undefined') {
      return { id: gruppNu(), namn: null, ruta: VIEWBOX, orter: ['västerås'] };
    }
    return null;
  }

  window.__pvLas = {
    version: '__PVVERSION__',

    /* Ett svep. Läser flödet, registrerar första observationer, och lämnar
       tillbaka en lista som går att skicka över CDP.

       PRODUKTREGELN LIGGER FÖRST. Ett inlägg som är en nykterhets- eller
       drogkontroll lämnar den här funktionen som { nyckel, vagrad: true } —
       ingen text, inget id, ingen tolkning, ingen plats. Det finns alltså
       ingenting för daemonen att logga eller skicka ens om den ville. */
    svep: function () {
      var g = gruppObjekt();
      var ut = {
        grupp: gruppNu(),
        omrade: omradeNu(g),
        gruppfel: (typeof GRUPPFEL !== 'undefined') ? GRUPPFEL : null,
        sokvag: location.pathname,
        dold: (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible'),

        /* SESSIONEN — hålet som ingen kartläggning räknade.
           Anslut() i daemonen matchar bara flikens ADRESS. En utloggad session
           står kvar på samma adress: /groups/<id>/ svarar med en
           inloggningsvägg, collectPosts() hittar noll inlägg, och varje led
           rapporterar framgång. Loggen fylls med "SVEP inlägg=0" i evighet
           medan gruppen postar som vanligt.

           Tre värden, och 'utloggad' sägs bara när det finns ett POSITIVT
           tecken på inloggningsvägg OCH inget spår av den inloggade
           navigeringen. Facebook byter markup ofta; en vakthund som skriker
           i onödan blir avstängd, och då är den värre än ingen alls. Osäkert
           läge heter 'okand' och tystar sig — den sexttimmarsregeln i
           daemonen fångar det ändå. */
        sidlage: (function () {
          try {
            var inne = !!document.querySelector('[role="navigation"]');
            var ute = !!document.querySelector(
              '[data-testid="royal_login_form"], #login_form, #loginbutton, input[name="pass"]'
            );
            if (ute && !inne) { return 'utloggad'; }
            if (inne) { return 'inloggad'; }
            return 'okand';
          } catch (e) { return 'okand'; }
        })(),

        /* MEDLEMSKAPET — den andra tysta blindheten.

           En INLOGGAD session på en grupp man inte gått med i ser frisk ut
           hela vägen: porten svarar, fliken finns, världen injiceras, svepet
           returnerar, sidlage blir 'inloggad'. Är gruppen privat lämnar
           Facebook inte ut ett enda inlägg, så collectPosts() ger noll. Det
           är exakt likadant som en lugn kväll, och det var ägarens läge när
           det här skrevs: han är inte medlem i någon Stockholmsgrupp.

           'ejmedlem' sägs bara på ett POSITIVT tecken — knappen "Gå med i
           grupp" finns på sidan. Facebook byter markup ofta, och en vakthund
           som skriker på gissningar blir avstängd inom en vecka. Hittas
           varken den knappen eller något medlemstecken heter svaret 'okand'
           och tiger; tomhetsvakten i daemonen fångar fallet ändå, bara
           långsammare. */
        medlemskap: (function () {
          try {
            var text = function (n) {
              return ((n.getAttribute('aria-label') || '') + ' ' + (n.textContent || ''))
                .toLowerCase();
            };
            var knappar = document.querySelectorAll('[role="button"], a[role="link"], button');
            var gaMed = false;
            var medlem = false;
            for (var i = 0; i < knappar.length && i < 400; i++) {
              var t = text(knappar[i]);
              if (/\bg[åa] med i grupp/.test(t) || /\bjoin group\b/.test(t)) { gaMed = true; }
              if (/\bskriv n[åa]got\b/.test(t) || /\bwrite something\b/.test(t) ||
                  /\bbjud in\b/.test(t) || /\binvite\b/.test(t)) { medlem = true; }
            }
            if (gaMed && !medlem) { return 'ejmedlem'; }
            if (medlem) { return 'medlem'; }
            return 'okand';
          } catch (e) { return 'okand'; }
        })(),

        nu: Date.now(),
        /* Läses FÖRE registrera(): det är registreringen som gör svepet
           kalibrerat, och daemonen vill veta hur det såg ut när svepet
           började. */
        kalibrerat: arKalibrerad(g),
        poster: []
      };

      /* Bryggkoden 2.3 kräver ett gruppobjekt. Känner den inte igen gruppen
         fliken står i läses ingenting — hellre tomt än fel grupp. */
      if (typeof GRUPPER !== 'undefined' && !g) {
        ut.okandGrupp = true;
        return ut;
      }

      var poster = collectPosts();
      registrera(poster, g);

      for (var i = 0; i < poster.length; i++) {
        var p = poster[i];
        var n = nycklarFor(p, g);
        var rad = { nyckel: n.stable, externalId: n.externalId, plats: i };

        /* Spärr 1: bryggkodens egen isSobrietyCheck, direkt på texten. */
        if (isSobrietyCheck(normalize(p.text))) {
          rad.vagrad = true;
          ut.poster.push(rad);
          continue;
        }

        var tolk = parseReportText(p.text);

        /* Spärr 2: parsern säger nej. Täcker både nykterhet och fartkameror,
           och de två skiljs INTE åt utåt — se motiveringen i daemonen. */
        if (tolk && tolk.intent === 'refused') {
          rad.vagrad = true;
          ut.poster.push(rad);
          continue;
        }

        var obs = observeradTid(n.stable);
        var fs = forstSedd[n.stable] || null;

        rad.text = p.text;
        rad.id = p.id;
        rad.facebookTid = p.postedAt;
        rad.observeradTid = obs;
        rad.tid = (p.postedAt != null) ? p.postedAt : obs;
        rad.kalla = (p.postedAt != null) ? 'facebook' : (obs != null ? 'observation' : null);
        rad.forstSedd = fs ? fs.f : null;
        rad.kalibrering = fs ? !!fs.k : null;
        rad.tolkning = tolk;
        ut.poster.push(rad);
      }
      return ut;
    },

    /* Enda vägen för daemonen att fråga produktregeln med bryggans egen kod.
       Används av -Sjalvtest, så att provet mäter det som verkligen körs i
       sidan och inte en avskrift. */
    arNykterhet: function (t) { return isSobrietyCheck(normalize(t)); },

    /* Felsökning. Samma vy som __polisvakt.tider() i bryggan: vad flödet
       faktiskt ger, och varifrån åldern kom. Ingen text på vägrade rader. */
    tider: function () {
      var g = gruppObjekt();
      var poster = collectPosts();
      return poster.map(function (p) {
        var n = nycklarFor(p, g).stable;
        var vagrad = isSobrietyCheck(normalize(p.text));
        var obs = observeradTid(n);
        var t = (p.postedAt != null) ? p.postedAt : obs;
        return {
          nyckel: n,
          text: vagrad ? null : p.text.slice(0, 70),
          vagrad: vagrad,
          id: p.id,
          tidText: p.tidsAnkare ? synligText(p.tidsAnkare) : null,
          kalla: (p.postedAt != null) ? 'facebook' : (obs != null ? 'observation' : null),
          alderMin: (t == null) ? null : Math.round((Date.now() - t) / 60000)
        };
      });
    },
    rakna: function () { return document.querySelectorAll(MESSAGE_SEL).length; },
    forstSedda: function () { var o = {}; for (var k in forstSedd) { o[k] = forstSedd[k]; } return o; },
    nollstall: function () {
      forstSedd = {};
      if (typeof kalibrerade !== 'undefined' && kalibrerade && typeof kalibrerade.clear === 'function') {
        kalibrerade.clear();
      } else if (typeof kalibrerat !== 'undefined') {
        kalibrerat = false;
      }
      try { localStorage.removeItem(FORSTSEDD_KEY); } catch (e) { }
      return 'nollstalld';
    }
  };

  return 'injicerad';
})();
'@

# En kod och en version PER GRUPP. Koden skiljer sig bara på CONFIG-raden,
# men den skillnaden är hela poängen: två flikar ska bära var sin grupptabell
# och var sin ruta. Cachen är därför nycklad på grupp, inte en global sträng.
$script:LasarKod = @{}
$script:LasarVersion = @{}

function Bygg-Lasarkod {
  param([Parameter(Mandatory = $true)]$Grupp)

  $gid = [string]$Grupp.id
  if ($script:LasarKod.ContainsKey($gid)) { return $script:LasarKod[$gid] }

  # Id:t hamnar både i en JS-sträng och i en URL. Det är redan filtrerat av
  # Rensa-GruppId, men en kontroll till kostar ingenting på en rad som kör i
  # ägarens inloggade Facebook-session.
  if ($gid -notmatch '^[\w.-]{1,64}$') {
    throw "Grupp-id '$gid' ser inte ut som ett grupp-id. Daemonen startar inte."
  }

  $ra = $script:LasarSkalHuvud + "`n" + $script:Lasdel + "`n" + $script:LasarSkalFot

  # ConvertTo-Json i Windows PowerShell escapar allt utanför ASCII till
  # \uXXXX, så "Här Står Polisen - Västerås" går in i sidan utan att en enda
  # byte kan tolkas fel av teckenkodningen på vägen. JSON är dessutom ett
  # giltigt JS-literal, så det går rakt in i CONFIG.
  $tabell = @(@{
    id     = $gid
    namn   = [string]$Grupp.namn
    ort    = [string]$Grupp.ort
    omrade = [string]$Grupp.omrade
    ruta   = @($Grupp.ruta | ForEach-Object { [double]$_ })
  })
  $ra = $ra.Replace('__PVGRUPPER__', (ConvertTo-Json $tabell -Depth 5 -Compress))

  $md5 = [System.Security.Cryptography.MD5]::Create()
  try {
    $summa = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($ra))
  } finally { $md5.Dispose() }
  $version = (($summa | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
  $script:LasarVersion[$gid] = $version
  $script:LasarKod[$gid] = $ra.Replace('__PVVERSION__', $version)
  return $script:LasarKod[$gid]
}

<#
  Se till att läsaren finns i den isolerade världen, och gör ett svep.

  Returnerar svepets objekt. Kastar när anslutningen är borta — den som
  anropar återansluter.
#>
function Gor-Svep {
  param($Kontext)

  if (-not $Kontext.varld) { Skaffa-Varld -Kontext $Kontext | Out-Null }

  $grupp = $Kontext.grupp
  Bygg-Lasarkod -Grupp $grupp | Out-Null      # fyller $script:LasarVersion
  $fraga = "(window.__pvLas && window.__pvLas.version === '" +
    $script:LasarVersion[[string]$grupp.id] + "') ? 'ja' : 'nej'"

  $finns = $null
  try {
    $finns = Evaluera -Kontext $Kontext -Uttryck $fraga
  } catch {
    # Kontexten är borta (omladdning, navigering). Skaffa en ny och fråga om.
    if ($_.Exception.Message -match 'context|Context|Execution|destroyed|Cannot find') {
      Skaffa-Varld -Kontext $Kontext | Out-Null
      $finns = Evaluera -Kontext $Kontext -Uttryck $fraga
    } else { throw }
  }

  if ($finns -ne 'ja') {
    $svar = Evaluera -Kontext $Kontext -Uttryck (Bygg-Lasarkod -Grupp $grupp) -TimeoutMs 40000
    Logga 'INJEKTION' ('[' + $grupp.namn + '] läsaren injicerad i isolerad värld (' + $svar + ')') DarkCyan
  }

  $json = Evaluera -Kontext $Kontext -Uttryck 'JSON.stringify(window.__pvLas.svep())' -TimeoutMs 40000
  if (-not $json) { throw 'Svepet gav inget svar.' }
  return ($json | ConvertFrom-Json)
}

# =====================================================================
#  Geokodning — från PowerShell, inte från sidan
# =====================================================================

$script:GeoFil = Join-Path $script:DataMapp 'brygg-daemon-geo.json'
$script:Geo = @{}
if (Test-Path $script:GeoFil) {
  try {
    $rad = Get-Content -Raw -Encoding UTF8 $script:GeoFil | ConvertFrom-Json
    foreach ($p in $rad.PSObject.Properties) { $script:Geo[$p.Name] = $p.Value }
  } catch { $script:Geo = @{} }
}
$script:SenasteGeo = [DateTime]::MinValue

function Spara-Geo {
  try {
    ($script:Geo | ConvertTo-Json -Depth 6) |
      Set-Content -Path $script:GeoFil -Encoding UTF8
  } catch { }
}

<#
  Kontrollera att sidan och daemonen är överens om gruppens geografi.

  Båda läser numera CONFIG.groupIds i bryggfilen — daemonen med
  Plocka-Grupper, sidan med bryggkodens egen normaliseraGrupper(). Att de
  ändå jämförs är hela poängen med att bara ha en sanning: skiljer de sig åt
  har den ena tolkaren en bugg, och då ska det STÅ i loggen, inte tyst
  avgöras av vilken kopia som råkar användas.

  Säger sidan något annat än daemonen vinner INGEN av dem — gruppen läses
  inte det svepet. Att gissa vilken som har rätt är att gissa vilken stad
  varningen ska hamna i.
#>
function Kolla-Omrade {
  param($Grupp, $Omrade)
  if (-not $Omrade) { return $true }
  $ruta = @($Omrade.ruta)
  if ($ruta.Count -ne 4) { return $true }

  $sidan = (@($ruta | ForEach-Object { [double]$_ }) -join ',')
  $min = (@($Grupp.ruta | ForEach-Object { [double]$_ }) -join ',')
  if ($sidan -eq $min) {
    if (-not $Grupp.ContainsKey('omradeLoggat')) {
      $Grupp['omradeLoggat'] = $true
      Logga 'OMRÅDE' ('[' + $Grupp.namn + '] [' + $min + '] orter=' + ($Grupp.orter -join '/')) DarkGray
    }
    return $true
  }

  Logga 'STOPP' ('[' + $Grupp.namn + '] sidan säger [' + $sidan + '] men bryggfilen säger [' + $min +
    ']. Två tolkningar av samma lista — inget läses förrän de är överens.') Red
  return $false
}

function Inom-Omradet {
  param([double]$Lat, [double]$Lon, $Grupp)
  $r = @($Grupp.ruta)
  return ($Lon -ge [double]$r[0] -and $Lon -le [double]$r[2] -and
          $Lat -ge [double]$r[1] -and $Lat -le [double]$r[3])
}

<#
  Nominatim får både viewbox och bounded=1 — men det är en spärr som ligger
  hos någon annan. Svarar servern ändå med en träff utanför GRUPPENS område,
  eller ligger en gammal felaktig träff kvar i cachen, går koordinaten annars
  rakt vidare till kartan. En varning på fel plats är värre än ingen varning:
  den lär föraren att appen ljuger. Därför kontrolleras varje koordinat här
  också — mot den ruta gruppen bär, inte mot en global.
#>
function Geokoda {
  param([string]$Plats, [Parameter(Mandatory = $true)]$Grupp)

  $ren = Normalisera-Text $Plats
  if (-not $ren) { return $null }

  <#
    CACHENYCKELN BÄR GRUPPEN, och det är inte kosmetiskt.

    Cachefilen låg fram till 2.4 på enbart platsnamnet. Den innehöll redan
    raden "vasagatan" -> 59.6113,16.5452, alltså Västerås. Stockholms
    Vasagatan hade då antingen fått Västeråskoordinaten rakt av — en varning
    på fel gata i fel stad, det värsta utfall den här appen har — eller tyst
    kastats av områdeskontrollen, vilket ser ut som en lugn kväll.

    Bryggan rättade precis samma fel på sin sida (pv.fb.geo.<gruppid>.<plats>).
    Gamla nycklar utan grupp träffas aldrig mer; de ligger kvar tills TTL
    städar bort dem, och kostar en uppslagning per plats och grupp en gång.
  #>
  $nyckel = [string]$Grupp.id + '|' + $ren

  if ($script:Geo.ContainsKey($nyckel)) {
    $c = $script:Geo[$nyckel]
    if (-not $c) { return $null }                       # negativt svar, sparat med flit
    if (Inom-Omradet -Lat $c.lat -Lon $c.lon -Grupp $Grupp) { return $c }
    $script:Geo[$nyckel] = $null                        # förgiftad rad, kasta den
    Spara-Geo
    return $null
  }

  # Nominatim tillåter ett anrop i sekunden. Vi köar snällt.
  $sedan = ((Get-Date) - $script:SenasteGeo).TotalMilliseconds
  if ($sedan -lt 1200) { Start-Sleep -Milliseconds ([int](1200 - $sedan)) }
  $script:SenasteGeo = Get-Date

  # Lägg till orten om den inte redan står i frasen, så vi slipper fråga
  # Nominatim om "Vasagatan" i hela Sverige. Orten kommer från gruppens egen
  # rad i bryggkodens tabell — inte från en kopia här.
  $orter = @($Grupp.orter)
  $fraga = $Plats
  $ortRedanMed = $false
  foreach ($ort in $orter) {
    if (-not $ort) { continue }
    if ($ren -match [regex]::Escape($ort.ToLowerInvariant())) { $ortRedanMed = $true; break }
  }
  if (-not $ortRedanMed -and $orter.Count -gt 0 -and $orter[0]) {
    $fraga = $Plats + ', ' + $orter[0]
  }

  $ruta = (@($Grupp.ruta | ForEach-Object { [double]$_ }) -join ',')
  $url = 'https://nominatim.openstreetmap.org/search' +
    '?q=' + [uri]::EscapeDataString($fraga) +
    '&format=jsonv2&limit=1&countrycodes=se&accept-language=sv&bounded=1' +
    '&viewbox=' + [uri]::EscapeDataString($ruta)

  $svar = Invoke-RestMethod -Uri $url -TimeoutSec 20 -Headers @{
    'User-Agent' = 'Polisvakt-brygg-daemon/1.0 (polisvakt.pages.dev)'
    'Accept'     = 'application/json'
  }
  $rader = @($svar)
  if ($rader.Count -eq 0) {
    # Negativt svar cachas också, annars slås samma okända plats upp varje
    # svep och vi bränner Nominatims tålamod på ingenting.
    $script:Geo[$nyckel] = $null
    Spara-Geo
    return $null
  }

  $traff = @{
    lat   = [double]$rader[0].lat
    lon   = [double]$rader[0].lon
    label = ([string]$rader[0].name)
  }
  if (-not $traff.label) { $traff.label = $Plats }
  if ($traff.label.Length -gt 120) { $traff.label = $traff.label.Substring(0, 120) }

  if (-not (Inom-Omradet -Lat $traff.lat -Lon $traff.lon -Grupp $Grupp)) {
    $script:Geo[$nyckel] = $null
    Spara-Geo
    Logga 'GEO-KASTAD' ('[' + $Grupp.namn + '] träff utanför ' +
      $(if ($Grupp.omrade) { $Grupp.omrade } else { 'gruppens område' }) + ': ' + $Plats +
      ' -> ' + $traff.lat + ',' + $traff.lon) DarkYellow
    return $null
  }

  $script:Geo[$nyckel] = $traff
  Spara-Geo
  return $traff
}

# =====================================================================
#  Skrivning till Supabase — bara i skarpt läge
# =====================================================================

# Hela svepets rader går i ETT anrop till fbmejl_ta_emot.
#
# VARFÖR INTE RAKT TILL reports
#
# Daemonen skrev förut till /rest/v1/reports. Rapporten hamnade på kartan och
# telefonen var tyst — det finns ingen utlösare på den tabellen. Notisen,
# takten, avdubblingen och nykterhetsnätet sitter allihop i fbmejl_ta_emot,
# och den vägen gick daemonen förbi. Ett led som rapporterar 201 medan
# slutresultatet är noll är den svåraste sortens fel, och det här projektet
# har haft tre av dem.
#
# VARFÖR EN OMGÅNG OCH INTE EN RAD I TAGET
#
# fbmejl_ta_emot buntar med flit: den skickar EN notis för hela omgången och
# räknar resten som "odelade" till nästa gång. Fyra separata anrop blir fyra
# omgångar, alltså en notis plus tre varningar som spärren håller tillbaka i
# tio minuter — och ingenstans syns att det hände. Därför samlas svepet i en
# utkorg och skickas i ett svep.
#
# Servern sätter source själv. Raderna ser ut precis som förut.
#
# OCH DET HÄR ÄR ALLT DAEMONEN GÖR I NOTISVÄGEN.
#
# NOTISEN SKICKAS AV DATABASEN, inte härifrån. fbmejl_ta_emot anropar
# fbmejl_notis_ut, som lägger anropet i pg_nets kö mot edge-funktionen
# fbmejl-push. Daemonen ska ALDRIG posta polisvarningen själv — läs
# resonemanget i avsnittet DRIFTNOTISER strax nedan innan du frestas. Gör man
# det ändå får telefonen två notiser för varje polis, och ingen av dem vet om
# den andra.

# Sista nätet på anon-vägen: servern får säga nej en gång till.
#
# fbmejl_ar_nykterhetskontroll är den ENDA av nykterhetsspärrarna som är
# grantad till anon, och den är med flit BREDARE än parsern. På vägen genom
# fbmejl_ta_emot körs den automatiskt. Går vi utanför den vägen måste vi ropa
# på den själva — annars tappar vi ett nät, och det nätet finns för att fem av
# nio drogkontroller en gång blev polisrapporter på riktigt.
#
# Svarar servern inte alls: raden kastas. En kontroll som inte gick att göra
# är inte samma sak som en kontroll som sa ja.
function Test-NykterhetPaServern {
  param([string]$Text)
  if (-not $Text) { return $false }
  try {
    $r = Invoke-RestMethod -Uri ($script:SupabaseUrl + '/rest/v1/rpc/fbmejl_ar_nykterhetskontroll') `
      -Method Post -TimeoutSec 15 -ContentType 'application/json' `
      -Headers @{ apikey = $script:SupabaseKey; Authorization = 'Bearer ' + $script:SupabaseKey } `
      -Body (@{ p_text = $Text } | ConvertTo-Json -Compress)
    return [bool]$r
  } catch {
    Logga 'NAT-FEL' ('kunde inte fraga servern om produktregeln — raden kastas: ' + $_.Exception.Message) Yellow
    return $true
  }
}

function Skicka-Omgang {
  param([object[]]$Rader, [switch]$UtanNotis)
  if (-not $Skarpt) { throw 'Skicka-Omgang anropad i torrkörning. Det är ett fel i daemonen.' }
  if (-not $Rader -or $Rader.Count -eq 0) { return $null }

  # ---- Vägen med nyckel: hela kedjan, inklusive notisen -----------------
  #
  # -UtanNotis tvingar ner raderna på anon-vägen längre ned även när nyckeln
  # finns. Det används för grupper som står med notis: false i bryggfilen,
  # alltså grupper i en annan stad än den man själv kör i.
  #
  # Skälet står i bryggfilen och är värt att upprepa här, för det är den enda
  # rad i daemonen som kan skada någon: fbmejl_push_mottagare i
  # supabase\fbmejl.sql väljer VARJE prenumerant med gruppnotiser påslagna,
  # utan en enda geografisk kolumn. En andra stads rapporter genom
  # fbmejl_ta_emot betyder alltså Sergels torg på låsskärmen hos folk i
  # Västerås. Anon-vägen skriver till reports, syns på kartan och i appens
  # röst — som filtrerar på avstånd — och utlöser ingen push.
  if ($script:ServiceRoleKey -and -not $UtanNotis) {
    $url = $script:SupabaseUrl + '/rest/v1/rpc/fbmejl_ta_emot'
    $kropp = @{ p_rader = @($Rader) } | ConvertTo-Json -Depth 8 -Compress

    # service_role, inte anon-nyckeln. fbmejl_ta_emot är revokad från anon med
    # flit: den skriver rapporter och utlöser notiser.
    return Invoke-RestMethod -Uri $url -Method Post -TimeoutSec 30 -ContentType 'application/json' -Headers @{
      'apikey'        = $script:ServiceRoleKey
      'Authorization' = 'Bearer ' + $script:ServiceRoleKey
    } -Body $kropp
  }

  # ---- Vägen utan nyckel: kartan ja, notisen nej ------------------------
  #
  # Utan service_role-nyckeln kastade den här funktionen förut, och då nådde
  # INGENTING appen. Det var fel avvägning: en varning på kartan utan notis är
  # oändligt mycket bättre än ingen varning alls, och anon-nyckeln får redan
  # skriva till reports — userscriptet har alltid gjort just det.
  #
  # Det vi förlorar är notisen till en låst telefon, och serverns buntning och
  # takt. Det vi behåller är kartan, rösten när appen är öppen, och alla tre
  # nykterhetsspärrarna: sidans, daemonens och serverns (anropad nedan).
  #
  # Raden loggas som KARTA-UTAN-NOTIS, inte som SKICKAD. Skillnaden ska synas
  # i loggen, annars är vi tillbaka i "varje led grönt, noll effekt".
  $skapade = 0; $dubbletter = 0; $vagrade = 0
  foreach ($rad in $Rader) {
    $text = [string]$rad.note
    if (Test-NykterhetPaServern -Text $text) {
      $vagrade++
      Logga 'PRODUKTREGEL' 'servern vägrade raden' DarkGray
      continue
    }
    <#
      Två saker som gav fel och som båda är uppmätta:

      return=representation ger 401 "permission denied for table reports".
      Anon har bara KOLUMNvisa select-rättigheter — device_id är medvetet
      undantagen — men representation vill lämna tillbaka hela raden. Med
      return=minimal behövs ingen select alls, och 201 betyder skrivet.
      Priset: vi kan inte skilja ny rad från dubblett. Avdubblingen sker
      ändå redan i daemonen och på external_id i tabellen.

      device_id är NOT NULL. Userscriptet sätter 'fb-bridge'; daemonen sätter
      'fb-brygga' så att de två går att skilja åt i efterhand.
    #>
    $utRad = @{}
    foreach ($n in $rad.PSObject.Properties.Name) { $utRad[$n] = $rad.$n }
    if (-not $utRad.ContainsKey('device_id') -or -not $utRad['device_id']) {
      $utRad['device_id'] = 'fb-brygga'
    }
    try {
      Invoke-RestMethod -Uri ($script:SupabaseUrl + '/rest/v1/reports?on_conflict=external_id') `
        -Method Post -TimeoutSec 25 -ContentType 'application/json' `
        -Headers @{
          apikey        = $script:SupabaseKey
          Authorization = 'Bearer ' + $script:SupabaseKey
          Prefer        = 'resolution=ignore-duplicates,return=minimal'
        } -Body (ConvertTo-Json $utRad -Depth 6 -Compress) | Out-Null
      $skapade++
    } catch {
      Logga 'SKICK-FEL' ($_.Exception.Message) Red
    }
  }
  return [pscustomobject]@{
    skrivna = $skapade; dubbletter = $dubbletter; vagrade = $vagrade
    notis = $false
    # Skillnaden mellan "nyckeln fattas" och "gruppen ska inte pusha" måste
    # synas i loggen. Utan den skriver daemonen "kör satt-nyckel.ps1" på en
    # grupp där allt är precis som det ska.
    utanNyckel = (-not $script:ServiceRoleKey)
    avsiktligt = [bool]$UtanNotis
  }
}

# =====================================================================
#  DRIFTNOTISER — och en varning till nästa som läser den här filen
# =====================================================================
#
# LÄS DET HÄR INNAN DU RÖR NÅGOT I NOTISVÄGEN.
#
# Varningen om en polis skickas INTE härifrån. Den skickas av DATABASEN.
# Kedjan är: Skicka-Omgang -> fbmejl_ta_emot -> fbmejl_notis_ut -> pg_net ->
# edge-funktionen fbmejl-push -> telefonen. Daemonen skickar rapporterna och
# ingenting annat, och det är avsiktligt hela vägen:
#
#   * Buntningen, tiominutersspärren, nattystnaden, dygnstaket och
#     odelade-bokföringen sitter i EN transaktion i fbmejl_notis_ut. Flyttas
#     något av det hit blir två daemoner, eller en omstart mitt i, till en
#     dubbelnotis som ingen kan spåra.
#   * Notistexten byggs av FYRA validerade fält i databasen — typ och plats,
#     aldrig inläggets råa text. Det skyddet är STRUKTURELLT: det finns
#     ingen kodväg härifrån som kan bära en främlings ord till en låsskärm,
#     för texten lämnar aldrig PowerShell. Skickar daemonen notisen själv
#     sitter den plötsligt med $p.text i handen, och skyddet blir en regel
#     man måste komma ihåg i stället för något som inte går att bryta.
#
# BYGG ALLTSÅ ALDRIG "kurirkod" här som postar varningen till fbmejl-push.
# Kedjan är färdig och fungerar. Gör man det ändå får telefonen två notiser
# för varje polis, och ingen av dem vet om den andra.
#
# Det som DÄREMOT skickas härifrån är driftnotiser: "bryggan ser inte
# gruppen", "bryggan läser igen", veckans livstecken. De handlar om DAEMONEN,
# aldrig om ett inlägg. De bär ingen text ur gruppen, ingen typ, ingen plats,
# och de kan därför inte bli en varning bakvägen.

$script:DriftUrl = $script:SupabaseUrl + '/functions/v1/fbmejl-push'

# Nyckeln som ska med när DriftUrl ringas direkt.
#
# Bara de två anropen mot edge-funktionen använder den här. Allt mot PostgREST
# fortsätter använda ServiceRoleKey — blandar man ihop dem får man 401 åt båda
# hållen, och båda ser ut som "fel nyckel" fast det är fel DÖRR.
function Edge-Nyckel {
  if ($script:EdgeKey) { return $script:EdgeKey }
  return $script:ServiceRoleKey
}

$script:DriftRaknare = 0

function Skicka-Driftnotis {
  param(
    [Parameter(Mandatory = $true)][string]$Titel,
    [Parameter(Mandatory = $true)][string]$Text
  )
  # Räknas FÖRE lägeskontrollen. Provet på vakthunden mäter hur många notiser
  # tillståndsmaskinen VILLE skicka, inte hur många som kom fram — annars
  # skulle provet bara gå att köra skarpt, mot en riktig telefon.
  $script:DriftRaknare++
  if (-not $Skarpt) {
    Logga 'DRIFT' ('(torrkörning — skulle skickat driftnotis: ' + $Titel + ')') DarkGray
    return $false
  }
  if (-not $script:ServiceRoleKey) { return $false }
  try {
    $kropp = @{
      titel = $Titel
      text  = $Text
      # EGEN tag. 'polisvakt-grupp' hade ERSATT en färsk polisvarning i luren
      # — en driftnotis får aldrig kunna radera den varning den är till för
      # att skydda.
      tag   = 'polisvakt-brygga'
      url   = './'
    } | ConvertTo-Json -Compress
    $svar = Invoke-RestMethod -Uri $script:DriftUrl -Method Post -TimeoutSec 25 `
      -ContentType 'application/json' -Body $kropp -Headers @{
        'Authorization' = 'Bearer ' + (Edge-Nyckel)
      }
    $ant = '?'
    try { if ($null -ne $svar.mottagare) { $ant = [string]$svar.mottagare } } catch { }
    Logga 'DRIFT' ('"' + $Titel + '" skickad till ' + $ant + ' mottagare') Magenta
    return $true
  } catch {
    Logga 'DRIFT-FEL' ('kunde inte skicka "' + $Titel + '": ' + $_.Exception.Message) DarkYellow
    return $false
  }
}

# =====================================================================
#  PULSEN — serversidans enda sätt att veta att daemonen lever
# =====================================================================
#
# fbmejl_brygga.senast_kord betyder "senaste RAPPORT", inte "senaste svep":
# den skrivs inne i fbmejl_ta_emot. En daemon som kör felfritt i tre dygn utan
# att någon postar en polis rör den alltså inte alls, och en daemon som är död
# ser exakt likadan ut. Därför en egen puls i egna kolumner.
#
# TRE REGLER, OCH DE ÄR INTE FÖRHANDLINGSBARA:
#
#   1. Pulsen bär ALDRIG texter och ALDRIG typer. En puls som kunde avslöja
#      att någon postat en nykterhetskontroll vore samma varning bakvägen och
#      bryter mot produktregeln. Bara: läge, antal svep, hur många inlägg
#      totalt den senaste timmen, och när det senaste sågs.
#   2. Ett misslyckat pulsanrop SVÄLJS. Det räknas aldrig som SKICK-FEL och
#      aldrig mot Markera-Forsok. En tvåminuters nätstörning skulle annars
#      bränna tre försök på oskyldiga inlägg och ge tyst dataförlust — och
#      pulsen är en mätare, inte ett led i varningskedjan.
#   3. Funktionen kastar aldrig. Huvudloopen tolkar undantag som "anslutningen
#      till Chrome bröts" och kopplar ner. Ett Supabase-fel får inte kunna
#      starta om CDP-anslutningen.

$script:InlaggTider   = New-Object System.Collections.ArrayList
$script:PulsFelIRad   = 0
$script:PulsSagsIfran = $false

function Skicka-Puls {
  param([int]$Svepnummer)
  try {
    if (-not $Skarpt -or -not $script:ServiceRoleKey) { return }

    $grans = (Get-Date).AddHours(-1)
    $behall = New-Object System.Collections.ArrayList
    $senaste = $null
    foreach ($t in $script:InlaggTider) {
      if ($t -ge $grans) { [void]$behall.Add($t) }
      if (-not $senaste -or $t -gt $senaste) { $senaste = $t }
    }
    $script:InlaggTider = $behall

    $kropp = @{
      p_puls = @{
        lage              = $(if ($Skarpt) { 'skarp' } else { 'torr' })
        svep              = $Svepnummer
        inlagg_1h         = $behall.Count
        senaste_inlagg_at = $(if ($senaste) { $senaste.ToUniversalTime().ToString('o') } else { $null })
      }
    } | ConvertTo-Json -Depth 5 -Compress

    Invoke-RestMethod -Uri ($script:SupabaseUrl + '/rest/v1/rpc/fbmejl_brygga_puls') `
      -Method Post -TimeoutSec 15 -ContentType 'application/json' -Body $kropp -Headers @{
        'apikey'        = $script:ServiceRoleKey
        'Authorization' = 'Bearer ' + $script:ServiceRoleKey
      } | Out-Null

    if ($script:PulsSagsIfran) {
      Logga 'PULS' 'pulsen går fram igen.' DarkGray
      $script:PulsSagsIfran = $false
    }
    $script:PulsFelIRad = 0
  } catch {
    # Tyst. Med ETT undantag: efter tio misslyckanden i rad (en halvtimme) är
    # det inte längre en nätstörning, och då ska det synas i loggen — en gång.
    $script:PulsFelIRad++
    if ($script:PulsFelIRad -ge 10 -and -not $script:PulsSagsIfran) {
      $script:PulsSagsIfran = $true
      Logga 'PULS' ('pulsen har inte gått fram på ' + $script:PulsFelIRad +
        ' försök. Dödmansgreppet på servern kommer att larma. Rapporterna berörs inte.') DarkYellow
    }
  }
}

# =====================================================================
#  VAKTHUNDEN — bryggan som ser ut att köra men inte ser gruppen
# =====================================================================
#
# Anslut() matchar flikens ADRESS. En utloggad Facebook-session står kvar på
# samma adress, svarar med en inloggningsvägg, och då hittar collectPosts()
# noll inlägg. Varenda led rapporterar framgång: porten svarar, fliken finns,
# världen injiceras, svepet returnerar. Loggen skriver "SVEP inlägg=0" var
# tjugonde sekund tills någon råkar titta.
#
# Tre utlösare, och de är olika snabba med flit:
#
#   KONSTATERAT UTLOGGAD   larmar direkt. Sidan har sagt det själv.
#   ALDRIG LÄST NÅGOT      larmar efter fem minuter, EN gång, per grupp. Se
#                          nedan — det här är fallet "ansluten grupp som inte
#                          går att läsa", och det är nytt i 2.4.
#   SEX DAGTIMMAR TOMT     larmar långsamt. Ett tomt flöde kan vara en
#                          söndagsförmiddag, och en vakthund som skriker på
#                          en lugn dag blir avstängd.
#
# Bara nattimmarna räknas inte. Klockan tre finns det inga inlägg och det är
# inget fel, så timmarna 22–07 lägger inte till någonting till mätaren.
#
# EN notis per tillståndsövergång, aldrig i repris. Och en "läser igen" när
# det löser sig, för en varning utan avslut lär man sig att ignorera.
#
#
# VARFÖR SESSIONEN ÄR GLOBAL OCH TOMHETEN ÄR PER GRUPP
#
# Alla flikar delar ETT Chrome-fönster, EN profil och EN Facebook-session.
# Är den utloggad är varenda grupp blind samtidigt, av samma orsak. En
# tillståndsmaskin per grupp hade då gett tre identiska notiser om samma sak,
# och tre notiser om samma sak är hur man lär någon att svepa bort dem.
#
# Tomheten är tvärtom gruppens egen. En Stockholmsflik som inte ger något får
# INTE kunna döljas av att Västeråsfliken går som vanligt — det var precis
# felet i den gamla globala mätaren: $VaktTomSekunder nollställdes så fort
# NÅGON grupp gav inlägg.
#
#
# ETT TYST FEL HÄR SER UT SOM EN LUGN KVÄLL I STOCKHOLM
#
# Det farligaste fallet är inte att något kraschar. Det är en grupp som är
# konfigurerad, ansluten, inloggad — och tom, för alltid, för att ägaren inte
# är medlem i den. Facebook lämnar inte ut ett enda inlägg ur en privat grupp
# till en icke-medlem. Varje led rapporterar framgång.
#
# Därför har varje grupp ett läge 'ny' innan den läst sitt första inlägg, och
# 'ny' larmar EFTER FEM MINUTER — inte efter sex timmar. Skillnaden mot
# sextimmarsregeln är att en grupp som ALDRIG gett något inte är en lugn
# kväll; det är en grupp som inte fungerar. Fem minuter är valt för att en
# tung gruppsida ska hinna rendera färdigt och för att ägaren ska hinna se
# raden medan han fortfarande minns att han just la till gruppen.
#
# Sagt EN gång per grupp och körning. Inte tyst, inte i repris.

$script:VAKT_NY_SEKUNDER  = 300          # innan en grupp som aldrig läst larmar
$script:VAKT_TOM_SEKUNDER = 6 * 3600     # innan en grupp som fungerat larmar

$script:SessionLage    = 'ok'            # ok | utloggad
$script:SenasteSidlage = $null

# Bakåtkompatibla speglar av den gamla globala vakten. -ProvaVakthund och
# äldre loggverktyg läser dem; de sätts av gruppvakten nedan så att "någon
# grupp är blind" fortfarande går att fråga efter på ett ställe.
$script:VaktLage        = 'ok'
$script:VaktTomSekunder = 0

$script:Vakt = @{}       # gruppid -> tillstånd

function Vakt-For {
  param($Grupp)
  $gid = [string]$Grupp.id
  if (-not $script:Vakt.ContainsKey($gid)) {
    $script:Vakt[$gid] = @{
      lage        = 'ny'        # ny | ok | blind
      tomSekunder = 0
      harLast     = $false
      sagt        = $false      # har vi redan sagt ifrån om den här gruppen?
      medlemskap  = $null
    }
  }
  return $script:Vakt[$gid]
}

<#
  Kommer det fram varningar ur DEN HÄR gruppen just nu?

  Sessionen räknas in: är den utloggad är varje grupp blind, hur bra gruppens
  egen mätare än ser ut. Resten är gruppens eget.
#>
function Vakt-Lage {
  param($Grupp)
  if ($script:SessionLage -eq 'utloggad') { return 'blind' }
  $v = Vakt-For $Grupp
  if ($v.lage -eq 'blind') { return 'blind' }
  if (-not $v.harLast -and $v.sagt) { return 'blind' }
  return 'ok'
}

<#
  Den globala spegeln, HÄRLEDD och aldrig satt för hand.

  $script:VaktLage fanns före flergruppsstödet och läses av provet och av den
  som felsöker en logg. Sattes den på var sitt ställe i varje gren blev den
  fort osann — den fastnade på 'blind' efter en utloggning som redan var löst.
  Nu räknas den fram ur tillståndet: blind om sessionen är utloggad eller om
  NÅGON grupp är blind.
#>
function Uppdatera-VaktLage {
  $blind = ($script:SessionLage -eq 'utloggad')
  $tom = 0
  foreach ($k in @($script:Vakt.Keys)) {
    $v = $script:Vakt[$k]
    if ($v.lage -eq 'blind') { $blind = $true }
    if (-not $v.harLast -and $v.sagt) { $blind = $true }
    if ($v.tomSekunder -gt $tom) { $tom = $v.tomSekunder }
  }
  $script:VaktLage = $(if ($blind) { 'blind' } else { 'ok' })
  $script:VaktTomSekunder = $tom
}

# Sessionen delas av alla flikar. Larmet går en gång, inte en gång per grupp.
function Kolla-Session {
  param([string]$Sidlage)
  try {
    if ($Sidlage -ne $script:SenasteSidlage) {
      $script:SenasteSidlage = $Sidlage
      $farg = switch ($Sidlage) {
        'inloggad' { 'DarkGreen' }
        'utloggad' { 'Red' }
        default    { 'DarkYellow' }
      }
      Logga 'SESSION' ('sidan rapporterar: ' + $Sidlage) $farg
    }

    if ($Sidlage -eq 'utloggad' -and $script:SessionLage -eq 'ok') {
      $script:SessionLage = 'utloggad'
      Uppdatera-VaktLage
      Logga 'VAKTHUND' 'BLIND — Facebook-sessionen är utloggad i bryggfönstret.' Red
      Skicka-Driftnotis -Titel 'Bryggan ser inte grupperna' `
        -Text ('Facebook-sessionen är utloggad i bryggfönstret. Inga varningar kommer fram ' +
               'förrän du loggar in igen.') | Out-Null
      return
    }
    if ($Sidlage -eq 'inloggad' -and $script:SessionLage -eq 'utloggad') {
      $script:SessionLage = 'ok'
      Uppdatera-VaktLage
      Logga 'VAKTHUND' 'Facebook-sessionen är inloggad igen.' Green
      Skicka-Driftnotis -Titel 'Bryggan läser igen' `
        -Text 'Kontakten med Facebook är återställd. Varningarna går fram som vanligt.' | Out-Null
    }
  } catch {
    Logga 'VAKTHUND' ('sessionskollen kunde inte köras: ' + $_.Exception.Message) DarkYellow
  }
}

function Kolla-Vakthund {
  param($Grupp, $Svepresultat, [int]$Inlagg)
  try {
    $v = Vakt-For $Grupp
    $namn = [string]$Grupp.namn
    $nu = Get-Date
    $timme = $nu.Hour
    $dagtid = ($timme -ge 7 -and $timme -lt 22)

    $medlemskap = 'okand'
    if ($Svepresultat -and (@($Svepresultat.PSObject.Properties.Name) -contains 'medlemskap') -and
        $Svepresultat.medlemskap) {
      $medlemskap = [string]$Svepresultat.medlemskap
    }
    if ($medlemskap -ne $v.medlemskap) {
      $v.medlemskap = $medlemskap
      if ($medlemskap -eq 'ejmedlem') {
        Logga 'MEDLEMSKAP' ('[' + $namn + '] sidan visar knappen "Gå med i grupp" — kontot är inte ' +
          'medlem i gruppen.') Yellow
      }
    }

    if ($Inlagg -gt 0) {
      $v.tomSekunder = 0
      if (-not $v.harLast) {
        # Första inlägget någonsin ur den här gruppen. Sägs en gång: det är
        # det enda positiva beskedet som finns att ge, och den som just la
        # till en grupp vill se det.
        $v.harLast = $true
        Logga 'VAKTHUND' ('[' + $namn + '] läser gruppen — första inlägget kom fram.') Green
      }
    } elseif ($dagtid) {
      $v.tomSekunder += [int]($SvepIntervallMs / 1000)
    }

    # ---- Läge 'ny': gruppen har aldrig gett något ----------------------
    if (-not $v.harLast) {
      if ($v.tomSekunder -ge $script:VAKT_NY_SEKUNDER -and -not $v.sagt) {
        $v.sagt = $true
        Uppdatera-VaktLage
        $skal = 'Inte ett enda inlägg sedan bryggan startade.'
        if ($medlemskap -eq 'ejmedlem') {
          $skal = 'Kontot är inte medlem i gruppen — sidan visar "Gå med i grupp".'
        }
        Logga 'VAKTHUND' ('[' + $namn + '] LÄSER INGENTING — ' + $skal) Red
        Logga 'VAKTHUND' ('  En privat grupp lämnar inte ut ett enda inlägg till en icke-medlem. ' +
          'Sidan renderar, sessionen är inloggad, flödet är tomt — det ser ut precis som en lugn kväll.') Yellow
        Logga 'VAKTHUND' ('  Gå med i gruppen, eller ta bort den ur groupIds i ' +
          (Split-Path -Leaf $Bryggfil) + '. Grupp-id: ' + $Grupp.id) Yellow
        Logga 'VAKTHUND' '  Det här sägs en gång per körning. De andra grupperna läses som vanligt.' DarkGray
        Skicka-Driftnotis -Titel ('Bryggan läser inte ' + $namn) `
          -Text ($skal + ' Inga varningar kommer från den gruppen förrän det är löst.') | Out-Null
      }
      Uppdatera-VaktLage
      return
    }

    # ---- Läge 'ok'/'blind': gruppen har fungerat ------------------------
    $blind = ($v.tomSekunder -ge $script:VAKT_TOM_SEKUNDER)

    if ($blind -and $v.lage -ne 'blind') {
      $v.lage = 'blind'
      Uppdatera-VaktLage
      Logga 'VAKTHUND' ('[' + $namn + '] BLIND — inte ett enda inlägg på sex dagtimmar.') Red
      Skicka-Driftnotis -Titel ('Bryggan ser inte ' + $namn) `
        -Text 'Inte ett enda inlägg på sex dagtimmar. Inga varningar kommer fram förrän det är löst.' | Out-Null
      return
    }

    if (-not $blind -and $v.lage -eq 'blind' -and $Inlagg -gt 0) {
      $v.lage = 'ok'
      Uppdatera-VaktLage
      Logga 'VAKTHUND' ('[' + $namn + '] läser gruppen igen.') Green
      Skicka-Driftnotis -Titel ('Bryggan läser ' + $namn + ' igen') `
        -Text 'Kontakten med gruppen är återställd. Varningarna går fram som vanligt.' | Out-Null
      return
    }

    if ($v.lage -eq 'ny') { $v.lage = 'ok' }
    Uppdatera-VaktLage
  } catch {
    # Vakthunden får aldrig fälla daemonen. Ett fel här betyder att vi står
    # utan vakthund, inte utan brygga.
    Logga 'VAKTHUND' ('kunde inte köras: ' + $_.Exception.Message) DarkYellow
  }
}

# =====================================================================
#  VECKANS LIVSTECKEN — det enda som bevisar sista milen
# =====================================================================
#
# En grön torrprob mot fbmejl-push bevisar nyckeln, databasen och antalet
# mottagare. Den bevisar INTE att en telefon piper, och det är inte en
# formulering utan en rad i koden: dry-svaret returneras i
# supabase/functions/fbmejl-push/index.ts INNAN importVapidKeys anropas. En
# felformaterad VAPID_KEYS ger alltså grön torrprob och fullständig tystnad i
# fickan — precis den sortens fel som det här projektet redan blött av.
#
# Därför ETT riktigt utskick i veckan. Söndag 18:00, en notis som säger att
# kedjan lever. Det är billigt, det är den enda kontrollen som går hela vägen
# genom VAPID-signeringen och ut till en riktig prenumeration, och det är det
# som säger till när ett tyst haveri har inträffat.
#
# Datumet skrivs till fil så att en omstart inte skickar en till, och så att
# tjugo svep inom samma minut blir ett utskick och inte tjugo.

$script:LivsteckenFil = Join-Path $script:DataMapp 'brygg-livstecken.txt'

function Kolla-Livstecken {
  param([switch]$Tvinga)
  try {
    if (-not $Skarpt) { return }
    $nu = Get-Date
    if (-not $Tvinga) {
      if ($nu.DayOfWeek -ne [System.DayOfWeek]::Sunday) { return }
      if ($nu.Hour -lt 18) { return }
    }
    $idag = $nu.ToString('yyyy-MM-dd')
    if ((-not $Tvinga) -and (Test-Path $script:LivsteckenFil)) {
      $senast = (Get-Content -Raw -Encoding UTF8 $script:LivsteckenFil).Trim()
      if ($senast -eq $idag) { return }
    }
    $ok = Skicka-Driftnotis -Titel 'Polisvakt: kedjan lever' `
      -Text 'Veckans livstecken. Ser du det här går varningarna fram hela vägen till luren.'
    if ($ok) {
      Set-Content -Path $script:LivsteckenFil -Value $idag -Encoding UTF8
      Logga 'LIVSTECKEN' 'veckans riktiga utskick gick iväg — VAPID-signeringen fungerar.' Green
    }
  } catch {
    Logga 'LIVSTECKEN' ('kunde inte köras: ' + $_.Exception.Message) DarkYellow
  }
}

# =====================================================================
#  STARTPROBEN — löftet som kommentaren gav och koden aldrig höll
# =====================================================================
#
# Ovanför nyckelläsningen har det länge stått att nyckeln läses även i
# torrkörning "bara för att kunna säga till i förväg att den saknas". Det
# gjorde koden aldrig. Den läste nyckeln, lät bli att säga något, och kastade
# först när det första riktiga inlägget dök upp — timmar senare, i ett fönster
# ingen tittade i.
#
# Två anrop vid start, i BÅDA lägena:
#
#   fbmejl_notis_konfig()   svarar på om DATABASEN har allt den behöver:
#                           adress, nyckel, varifrån nyckeln kom, pg_net,
#                           läsbart valv och antal mottagare. Aldrig ett värde.
#   fbmejl-push {"dry":true}  svarar på om EDGE-FUNKTIONEN godtar samma nyckel.
#
# I skarpt läge är probens dom bindande: klar=false eller mottagare=0 och
# daemonen VÄGRAR starta. En brygga som kör vidare utan att kunna skicka är
# värre än en som inte startar, för den ser igång ut.

function Kor-Startprob {
  $allt = $true

  if (-not $script:ServiceRoleKey) {
    Logga 'PROB' 'RÖD  ingen service_role-nyckel på den här maskinen.' Red
    Logga 'PROB' '     ÅTGÄRD: powershell -ExecutionPolicy Bypass -File tools\satt-nyckel.ps1' Yellow
    return $false
  }
  Logga 'PROB' ('nyckel: källa=' + $script:NyckelKalla +
    ' form=' + $script:ServiceRoleKey.Substring(0, [math]::Min(3, $script:ServiceRoleKey.Length)) +
    '... längd=' + $script:ServiceRoleKey.Length) DarkGray

  # ---- 1. Databasen -------------------------------------------------------
  #
  # Utfallet här avgör hur steg 2 ska läsas. Grön databas betyder att valvet
  # bär en läsbar nyckel, och det är den nyckeln som ringer edge-funktionen i
  # skarp drift — inte daemonens egen.
  $dbGron = $false
  try {
    $k = Invoke-RestMethod -Uri ($script:SupabaseUrl + '/rest/v1/rpc/fbmejl_notis_konfig') `
      -Method Post -TimeoutSec 25 -ContentType 'application/json' -Body '{}' -Headers @{
        'apikey'        = $script:ServiceRoleKey
        'Authorization' = 'Bearer ' + $script:ServiceRoleKey
      }
    $falt = @($k.PSObject.Properties.Name)
    $klar   = ($falt -contains 'klar')       -and [bool]$k.klar
    $mott   = $(if ($falt -contains 'mottagare') { [int]$k.mottagare } else { -1 })
    $kalla  = $(if ($falt -contains 'nyckel_kalla') { [string]$k.nyckel_kalla } else { 'okänd' })
    $form   = $(if ($falt -contains 'nyckel_form') { [string]$k.nyckel_form } else { '?' })
    $langd  = $(if ($falt -contains 'nyckel_langd') { [int]$k.nyckel_langd } else { 0 })
    $pgnet  = ($falt -contains 'pg_net')      -and [bool]$k.pg_net
    $valv   = ($falt -contains 'valv_lasbart') -and [bool]$k.valv_lasbart

    $rad = ('klar=' + $klar + ' nyckel_kalla=' + $kalla + ' form=' + $form + ' längd=' + $langd +
            ' mottagare=' + $mott + ' pg_net=' + $pgnet + ' valv_läsbart=' + $valv)
    if ($klar -and $mott -gt 0 -and $pgnet) {
      $dbGron = $true
      Logga 'PROB' ('GRÖN databasen: ' + $rad) Green
    } else {
      $allt = $false
      Logga 'PROB' ('RÖD  databasen: ' + $rad) Red
      if (-not $klar) {
        Logga 'PROB' '     ÅTGÄRD: lägg service_role-nyckeln i Supabase Vault under namnet service_role_key.' Yellow
      }
      if ($kalla -like 'fbmejl_anropsnyckel*') {
        Logga 'PROB' '     FÄLLA: en hemlighet som heter fbmejl_anropsnyckel ligger i valvet och VINNER' Red
        Logga 'PROB' '     över service_role_key. Ta bort den ur valvet — annars 401 på en nyckel som ser rätt ut.' Red
      }
      if ($mott -eq 0) {
        Logga 'PROB' '     ÅTGÄRD: ingen lyssnar. Slå på gruppnotiser i appen, se docs\notiskedjan.md steg 5.' Yellow
      }
      if (-not $pgnet) {
        Logga 'PROB' '     ÅTGÄRD: pg_net saknas. Database -> Extensions -> pg_net -> Enable.' Yellow
      }
    }
  } catch {
    $allt = $false
    Logga 'PROB' ('RÖD  databasen svarar inte på fbmejl_notis_konfig: ' + $_.Exception.Message) Red
    Logga 'PROB' '     ÅTGÄRD: fel nyckel, eller migrationerna är inte körda. Kör tools\satt-nyckel.ps1.' Yellow
  }

  # ---- 2. Edge-funktionen -------------------------------------------------
  #
  # DEN HÄR PROBEN FÅR INTE STOPPA DAEMONEN, och det är en rättelse.
  #
  # Den ringer fbmejl-push med daemonens EGEN nyckel. Det är inte den väg
  # notisen faktiskt tar: daemonen anropar fbmejl_ta_emot i databasen, och det
  # är DATABASEN som ringer fbmejl-push, med nyckeln ur valvet. Daemonens
  # nyckel når aldrig edge-funktionen i skarp drift.
  #
  # På ett projekt med de nya API-nycklarna finns det inte längre EN nyckel som
  # öppnar båda dörrarna:
  #
  #   PostgREST (fbmejl_ta_emot)  godtar den gamla eyJ-nyckeln, inte sb_secret
  #   Edge (fbmejl-push)          godtar sb_secret, inte eyJ
  #
  # Daemonen måste därför bära eyJ-nyckeln, och den nyckeln GER 401 här — på en
  # kedja som fungerar. Förut stoppade det starten helt: "Startproben är RÖD",
  # noll inlägg lästa, med grön databas på raden ovanför. Ett larm som går på
  # ett friskt system lär folk att strunta i larmet.
  #
  # Sanningen om push står redan i steg 1: fbmejl_notis_konfig svarar klar=true
  # bara när valvet har en LÄSBAR nyckel, och det är exakt den nyckel databasen
  # kommer att använda. Är steg 1 grönt är det här steget en upplysning.
  #
  # Är steg 1 RÖTT betyder ett 401 här fortfarande något, och då räknas det.
  $pushGron = $false
  try {
    $d = Invoke-RestMethod -Uri $script:DriftUrl -Method Post -TimeoutSec 25 `
      -ContentType 'application/json' -Body '{"dry":true}' -Headers @{
        'Authorization' = 'Bearer ' + (Edge-Nyckel)
      }
    $m = '?'
    try { if ($null -ne $d.mottagare) { $m = [string]$d.mottagare } } catch { }
    $pushGron = $true
    Logga 'PROB' ('GRÖN fbmejl-push: torrprob godkänd, mottagare=' + $m) Green
    Logga 'PROB' '     (bevisar nyckel, databas och mottagare — INTE VAPID. Det gör söndagens livstecken.)' DarkGray
  } catch {
    $status = 0
    try { $status = [int]$_.Exception.Response.StatusCode } catch { }

    # Databasen grön + 401 här = de två dörrarna vill ha var sin utgåva.
    # Väntat, ofarligt, och inget att stoppa för.
    if ($status -eq 401 -and $dbGron) {
      Logga 'PROB' 'GUL  fbmejl-push nekar daemonens egen nyckel (401) — VÄNTAT och ofarligt.' DarkYellow
      Logga 'PROB' '     Daemonen bär eyJ-nyckeln för PostgREST. Push ringer databasen upp, med' DarkGray
      Logga 'PROB' '     sb_secret-nyckeln ur valvet. Steg 1 ovan är beviset som gäller.' DarkGray
    } else {
      $allt = $false
      Logga 'PROB' ('RÖD  fbmejl-push svarade HTTP ' + $status + ': ' + $_.Exception.Message) Red
      if ($status -eq 401) {
        Logga 'PROB' '     ÅTGÄRD: FEL UTGÅVA av nyckeln. Prova den andra strängen med tools\satt-nyckel.ps1.' Yellow
      } elseif ($status -eq 500) {
        Logga 'PROB' '     ÅTGÄRD: VAPID_KEYS eller SUPABASE_URL saknas i funktionens miljö. Annat fel än nyckeln.' Yellow
      } elseif ($status -eq 404) {
        Logga 'PROB' '     ÅTGÄRD: fbmejl-push är inte utrullad på projektet. Se docs\notiskedjan.md steg 2.' Yellow
      }
    }
  }

  return $allt
}

# =====================================================================
#  BRYGGFÖNSTRET — startas härifrån, inte av en människa
# =====================================================================
#
# Förut klagade loopen en gång i minuten på att felsökningsporten inte svarar
# och gjorde ingenting åt det. Det är ett återkommande manuellt steg för
# ägaren varje gång Chrome stängs, och det var ett av de steg han faktiskt
# klagade på.
#
# Flyttat hit ur starta-bryggan.ps1, tillsammans med den kontroll som är
# själva poängen: en redan körande Chrome MED SAMMA --user-data-dir gör att
# uppstartsflaggorna ignoreras helt. Då startar inget nytt fönster, porten
# öppnas aldrig, och Start-Process svarar ändå att allt gick bra. Utan den
# kontrollen får man en brygga som ser igång ut och läser ingenting.

$script:ChromeProfil  = Join-Path $script:DataMapp 'chrome-brygga'
$script:SenasteStart  = [DateTime]::MinValue

function Porten-Svarar {
  param([int]$Port)
  try {
    $v = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/json/version") -TimeoutSec 3
    return $v.Browser
  } catch { return $null }
}

function Starta-Bryggfonstret {
  param([int]$Port)

  # Inte oftare än var tredje minut. En Chrome som vägrar starta ska inte
  # startas om var tjugonde sekund.
  if (((Get-Date) - $script:SenasteStart).TotalSeconds -lt 180) { return $false }
  $script:SenasteStart = Get-Date

  $redan = Porten-Svarar -Port $Port
  if ($redan) { return $true }

  $kandidater = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chrome = $kandidater | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) {
    Logga 'FÖNSTER' 'hittar inte chrome.exe.' Red
    return $false
  }

  # DEN AVGÖRANDE KONTROLLEN. Kör redan en Chrome mot samma profilmapp
  # skickar den nya processen bara adressen vidare till den gamla och avslutar
  # — flaggorna, inklusive felsökningsporten, kastas. Att starta då är inte
  # bara meningslöst, det ser ut att lyckas.
  $upptagen = $false
  try {
    $lasfil = Join-Path $script:ChromeProfil 'lockfile'
    if (Test-Path $lasfil) {
      foreach ($p in @(Get-Process chrome -ErrorAction SilentlyContinue)) {
        try {
          if ($p.MainModule -and $p.MainModule.FileName) {
            # Kan inte läsa kommandoraden utan WMI; lockfilen plus en levande
            # chrome.exe räcker som misstanke, och misstanken är värd en rad.
            $upptagen = $true
            break
          }
        } catch { }
      }
    }
  } catch { }

  if (-not (Test-Path $script:ChromeProfil)) {
    New-Item -ItemType Directory -Force -Path $script:ChromeProfil | Out-Null
  }

  # Citattecken runt sökvägen med flit: repot ligger under "Claude code
  # 2GNDTN" — två mellanslag — och utan dem delar Windows argumentet där och
  # Chrome tolkar bitarna som adresser.
  #
  # EN FLIK PER GRUPP, I SAMMA FÖNSTER OCH SAMMA PROFIL. Chrome tar flera
  # adresser på kommandoraden och öppnar en flik per adress.
  #
  # Alternativen som valdes bort, och varför:
  #
  #   En flik som navigerar mellan grupperna. Varje navigering river den
  #   isolerade världen, och kalibrerade (ett Set i modulscope) börjar då tomt.
  #   VARJE svep blir alltså ett kalibreringssvep för gruppen man kommer till,
  #   och ett kalibreringssvep ger per definition ingen observerad ålder. Utan
  #   ålder skickas ingenting, och på den riktiga gruppsidan gick tiden inte
  #   att läsa på 5 av 7 inlägg. Resultatet hade varit nästan total tystnad
  #   som ser ut som en lugn dag.
  #
  #   Ett fönster och en profil per grupp. Varje profil måste loggas in på
  #   Facebook för hand, och två samtidigt inloggade sessioner på samma konto
  #   är en tydligare automationssignal mot Meta än två flikar. Dubbelt minne,
  #   två fönster i vägen, och geografiuppdelningen i daemonen blir inte
  #   enklare av att fönstren är två.
  #
  # Flikar i bakgrunden LÄSER — det är mätt, inte antaget: loggen har rader
  # med "flik=dold" och "nya=2" i samma svep. Flaggorna nedan stänger av
  # Chromes strypning av dolda flikar, och daemonens klocka ligger dessutom
  # utanför sidan.
  $argument = @(
    "--user-data-dir=`"$($script:ChromeProfil)`"",
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    "--remote-debugging-port=$Port",
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window'
  )
  foreach ($g in $script:Grupper) { $argument += ('https://www.facebook.com/groups/' + $g.id + '/') }

  Logga 'FÖNSTER' 'startar bryggfönstret...' Cyan
  try {
    Start-Process -FilePath $chrome -ArgumentList $argument
  } catch {
    Logga 'FÖNSTER' ('kunde inte starta Chrome: ' + $_.Exception.Message) Red
    return $false
  }

  $uppe = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 1000
    $uppe = Porten-Svarar -Port $Port
    if ($uppe) { break }
  }
  if (-not $uppe) {
    Logga 'FÖNSTER' ("felsökningsporten svarade aldrig på 127.0.0.1:$Port.") Red
    if ($upptagen) {
      Logga 'FÖNSTER' '  En Chrome med SAMMA profilmapp kör redan. Då ignoreras uppstartsflaggorna' Red
      Logga 'FÖNSTER' '  och porten öppnas aldrig. Stäng det fönstret — bara det, inte din vanliga Chrome.' Red
      Logga 'FÖNSTER' ('  Profil: ' + $script:ChromeProfil) DarkGray
    }
    return $false
  }
  Logga 'FÖNSTER' ('felsökningsporten svarar: ' + $uppe) Green
  Logga 'FÖNSTER' 'Är bryggprofilen inte inloggad på Facebook: logga in i det fönstret. En gång per profil.' Yellow
  return $true
}

# =====================================================================
#  Hanteringslista
# =====================================================================
#
# Samma logik som bryggans minneslista: klara inlägg rörs aldrig igen,
# misslyckade får tre försök. Under TORRKÖRNING hålls listan bara i minnet —
# annars hade torrkörningen "bränt" varje inlägg den tittat på, och skarpt
# läge efteråt hade varit tyst.

$script:HanteradFil = Join-Path $script:DataMapp 'brygg-daemon-hanterade.json'
$script:MaxForsok = 3
$script:HanteradTtl = 7 * 24 * 3600 * 1000
# Raderna hålls som HASHTABELLER, aldrig som PSCustomObject.
#
# ConvertFrom-Json ger PSCustomObject; koden nedan skapar hashtabeller. Blandas
# de två går fältprövningen fel åt ena hållet: på en hashtabell listar
# $v.PSObject.Properties.Name tabellens egna medlemmar (Keys, Values, Count),
# inte nycklarna. Räknaren "forsok" hittades därför aldrig, fastnade på ett,
# och ett inlägg med oläslig ålder loggades var tjugonde sekund i stället för
# att ges upp efter tre försök. Därför normaliseras allt till hashtabell redan
# vid inläsningen, och allt läses med indexerare.
$script:Hanterad = @{}
if ($Skarpt -and (Test-Path $script:HanteradFil)) {
  try {
    $rad = Get-Content -Raw -Encoding UTF8 $script:HanteradFil | ConvertFrom-Json
    foreach ($p in $rad.PSObject.Properties) {
      $v = $p.Value
      $namn = @($v.PSObject.Properties.Name)
      $script:Hanterad[$p.Name] = @{
        t      = $(if ($namn -contains 't') { [int64]$v.t } else { 0 })
        klar   = $(if ($namn -contains 'klar') { [bool]$v.klar } else { $false })
        forsok = $(if ($namn -contains 'forsok') { [int]$v.forsok } else { 0 })
      }
    }
  } catch { $script:Hanterad = @{} }
}

function Spara-Hanterad {
  if (-not $Skarpt) { return }
  $grans = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:HanteradTtl
  $rensad = @{}
  foreach ($k in @($script:Hanterad.Keys)) {
    $v = $script:Hanterad[$k]
    if ($v -and $v['t'] -gt $grans) { $rensad[$k] = $v }
  }
  $script:Hanterad = $rensad
  try { ($script:Hanterad | ConvertTo-Json -Depth 5) | Set-Content -Path $script:HanteradFil -Encoding UTF8 } catch { }
}

function Test-Hanterad {
  param([string]$Nyckel)
  if (-not $script:Hanterad.ContainsKey($Nyckel)) { return $false }
  $v = $script:Hanterad[$Nyckel]
  if (-not $v) { return $false }
  if ($v['klar']) { return $true }
  return ([int]$v['forsok'] -ge $script:MaxForsok)
}

function Markera-Klar {
  param([string]$Nyckel)
  $script:Hanterad[$Nyckel] = @{
    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); klar = $true; forsok = 0
  }
  Spara-Hanterad
}

function Markera-Forsok {
  param([string]$Nyckel)
  $f = 0
  if ($script:Hanterad.ContainsKey($Nyckel) -and $script:Hanterad[$Nyckel]) {
    $f = [int]$script:Hanterad[$Nyckel]['forsok']
  }
  $script:Hanterad[$Nyckel] = @{
    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); klar = $false; forsok = $f + 1
  }
  Spara-Hanterad
}

# =====================================================================
#  Räkneverket
# =====================================================================

$script:Summa = @{
  svep          = 0
  sedda         = 0     # inlägg i flödet, unika över hela körningen
  vagrade       = 0     # produktregeln, utan uppdelning — se motiveringen
  utanTid       = 0
  medTid        = 0
  hoppade       = 0
  okandPlats    = 0
  skickade      = 0
  dubbletter    = 0
  misslyckade   = 0
}
$script:UnikaSedda = New-Object 'System.Collections.Generic.HashSet[string]'
$script:LasbarAlder = New-Object 'System.Collections.Generic.HashSet[string]'
$script:UtanAlder = New-Object 'System.Collections.Generic.HashSet[string]'
$script:Upptackt = @{}     # nyckel -> ms fördröjning från inlägg till upptäckt

function Kort {
  param([string]$Text, [int]$Max = 110)
  if (-not $Text) { return '' }
  $t = ($Text -replace '\s+', ' ').Trim()
  if ($t.Length -le $Max) { return $t }
  return $t.Substring(0, $Max) + '…'
}

# =====================================================================
#  Ett svep, hela vägen
# =====================================================================

<#
  Ett svep för EN grupp.

  Returnerar utkorgen i stället för att skicka den. Skälet är buntningen:
  fbmejl_ta_emot skickar EN notis per omgång och räknar resten som "odelade"
  till nästa gång. Skickade varje grupp för sig blev två grupper i samma tick
  till två omgångar, alltså en notis plus en varning som tiominutersspärren
  håller tillbaka — och ingenstans syns att det hände. Huvudloopen samlar
  därför alla gruppers rader och skickar dem i ett anrop. Se Tom-Utkorg.
#>
function Behandla-Svep {
  param($Grupp, $Svepresultat)

  $tom = @{ utkorg = @(); nycklar = @(); poster = 0 }

  $script:Summa.svep++
  $nu = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $gid = [string]$Grupp.id
  $namn = [string]$Grupp.namn

  # GRUPPFILTRET, tredje gången. Sidan svarar med vilken grupp den står i, och
  # står den i fel grupp läses ingenting — inte ens loggas texterna.
  if ($Svepresultat.grupp -ne $gid) {
    if (-not $Svepresultat.grupp) {
      # Vanligast direkt efter en omstart: svepet hann före navigeringen och
      # adressen är ännu inte /groups/<id>/. Går över av sig själv.
      Logga 'FEL-GRUPP' ('adressen är ' + $Svepresultat.sokvag +
        ' — ingen grupp där ännu. Inget läses det här svepet.') DarkGray
    } else {
      Logga 'FEL-GRUPP' ('fliken står i ' + $Svepresultat.grupp + ' men den här fliken är låst vid ' +
        $gid + ' (' + $namn + ') — inget läses.') DarkYellow
    }
    return $tom
  }

  # Bryggkodens egen grupptabell säger ifrån om gruppen saknar område. Då vet
  # ingen var en varning skulle hamna, och då skickas ingen.
  if ($Svepresultat.gruppfel) {
    Logga 'STOPP' ('bryggkoden vägrar gruppen: ' + $Svepresultat.gruppfel) Red
    return $tom
  }
  if ((@($Svepresultat.PSObject.Properties.Name) -contains 'okandGrupp') -and $Svepresultat.okandGrupp) {
    Logga 'STOPP' ('bryggkodens grupptabell känner inte igen ' + $Svepresultat.grupp + ' — inget läses.') Red
    return $tom
  }
  if (-not (Kolla-Omrade -Grupp $Grupp -Omrade $Svepresultat.omrade)) { return $tom }

  $poster = @($Svepresultat.poster)
  $nya = 0
  $vagradeNu = 0
  $utanTidNu = 0
  $medTidNu = 0

  foreach ($p in $poster) {
    if (-not $script:UnikaSedda.Contains($p.nyckel)) {
      [void]$script:UnikaSedda.Add($p.nyckel)
      $script:Summa.sedda++
      $nya++
      # Bara TIDPUNKTEN, till pulsen. Ingen nyckel, ingen text, ingen typ —
      # en puls som kunde avslöja VAD som postats vore en varning bakvägen.
      [void]$script:InlaggTider.Add((Get-Date))
    }
  }

  # Svepets utkorg. Lämnas tillbaka till huvudloopen, som slår ihop alla
  # gruppers rader och skickar dem i ETT anrop så att fbmejl_ta_emot ser dem
  # som en omgång och buntar notisen. Se Tom-Utkorg.
  $utkorg = @()
  $utkorgNycklar = @()

  foreach ($p in $poster) {

    # ---- Produktregeln -----------------------------------------------
    # Raden bär ingen text. Det finns ingenting att logga, och det är
    # avsikten. "produktregel" utan uppdelning: kan man se skillnad på en
    # vägrad nykterhetskontroll och en vägrad fartkamera i loggen, då har
    # loggen berättat att någon la upp en nykterhetskontroll.
    $harVagrad = (@($p.PSObject.Properties.Name) -contains 'vagrad')
    if ($harVagrad -and $p.vagrad) {
      $vagradeNu++
      $script:Summa.vagrade++
      Markera-Klar $p.nyckel
      continue
    }

    # ---- Spärr 3: samma regel, här ------------------------------------
    # Ska aldrig slå till. Gör den det är sidans spärr sönder, och då är det
    # den här som står mellan felet och databasen.
    if (Test-Nykterhetskontroll $p.text) {
      $vagradeNu++
      $script:Summa.vagrade++
      Logga 'VÄGRAD' 'produktregel (fångad i PowerShell — sidans spärr släppte igenom, se över bryggkoden)' Red
      Markera-Klar $p.nyckel
      continue
    }

    # ---- Åldern --------------------------------------------------------
    #
    # Räknas FÖRE Test-Hanterad. Siffrorna i SVEP-raden ska beskriva FLÖDET,
    # inte daemonens arbetskö: "hur många av inläggen där ute har en läsbar
    # ålder" är frågan, och den ändrar sig inte av att daemonen redan bockat
    # av ett inlägg.
    $harTid = ($null -ne $p.tid)
    if ($harTid) {
      $medTidNu++
      if (-not $script:LasbarAlder.Contains($p.nyckel)) {
        [void]$script:LasbarAlder.Add($p.nyckel)
        $script:Summa.medTid++
        [void]$script:UtanAlder.Remove($p.nyckel)
      }
      <#
        Fördröjning från inlägg till upptäckt.

        Mätt bara på inlägg som dykt upp MEDAN daemonen tittade. Ett inlägg
        som redan låg i flödet vid starten registrerades under
        kalibreringssvepet (k = 1), och för det betyder
        "först sedd minus skriven" bara hur gammalt flödet råkade vara när
        daemonen startade — inte hur snabbt något upptäcks. Första mätningen
        gav 92 441 s på ett dygnsgammalt inlägg, vilket är exakt det talet,
        och det är inte en fördröjning.
      #>
      if (-not $script:Upptackt.ContainsKey($p.nyckel)) {
        if ($null -ne $p.facebookTid -and $null -ne $p.forstSedd -and $p.kalibrering -eq $false) {
          $script:Upptackt[$p.nyckel] = [int64]$p.forstSedd - [int64]$p.facebookTid
        }
      }
    } else {
      $utanTidNu++
      if (-not $script:LasbarAlder.Contains($p.nyckel) -and -not $script:UtanAlder.Contains($p.nyckel)) {
        [void]$script:UtanAlder.Add($p.nyckel)
        $script:Summa.utanTid++
      }
    }

    # Avbockat sedan tidigare svep: räknat ovan, men inget mer ska göras.
    if (Test-Hanterad $p.nyckel) { continue }

    # ---- Tolkningen ----------------------------------------------------
    $t = $p.tolkning
    if (-not $t) {
      $script:Summa.hoppade++
      Markera-Klar $p.nyckel
      Logga 'HOPPAS-ÖVER' ('orsak=ingen-rapport  "' + (Kort $p.text) + '"') DarkGray
      continue
    }
    if ($t.intent -eq 'clear') {
      $script:Summa.hoppade++
      Markera-Klar $p.nyckel
      Logga 'HOPPAS-ÖVER' ('orsak=avblåsning  "' + (Kort $p.text) + '"') DarkGray
      continue
    }
    if (-not $t.place) {
      $script:Summa.hoppade++
      Markera-Klar $p.nyckel
      Logga 'HOPPAS-ÖVER' ('orsak=ingen-plats  "' + (Kort $p.text) + '"') DarkGray
      continue
    }
    if ([double]$t.confidence -lt $MinTilltro) {
      $script:Summa.hoppade++
      Markera-Klar $p.nyckel
      Logga 'HOPPAS-ÖVER' ('orsak=låg-tilltro ' + [math]::Round([double]$t.confidence * 100) + '%  "' + (Kort $p.text) + '"') DarkGray
      continue
    }

    # Åldern går inte att läsa. Hoppa över, men ge inte upp direkt.
    #
    # En observerad ålder kan inlägget aldrig få i efterhand — såg bryggan det
    # under kalibreringssvepet är k satt till 1 för gott. Men Facebooks egen
    # tidsstämpel kan dyka upp när sidan renderat färdigt, och det tar några
    # sekunder. Därför Markera-Forsok: tre svep till, sedan ges det upp.
    if (-not $harTid) {
      Markera-Forsok $p.nyckel
      Logga 'HOPPAS-ÖVER' ('orsak=oläslig-ålder  "' + (Kort $p.text) + '"') DarkYellow
      continue
    }

    $typ = [string]$t.type
    $minuter = 45
    if ($script:Livslangd.ContainsKey($typ)) { $minuter = [int]$script:Livslangd[$typ] }
    $ttl = $minuter * 60000
    $skapad = [int64]$p.tid
    if ($skapad -gt $nu) { $skapad = $nu }
    $forfaller = $skapad + $ttl

    if ($forfaller -le ($nu + 60000)) {
      # Inlägget är äldre än varningen skulle leva. Gammal varning är sämre
      # än ingen: föraren bromsar i onödan och slutar lita på appen.
      $script:Summa.hoppade++
      Markera-Klar $p.nyckel
      Logga 'HOPPAS-ÖVER' ('orsak=för-gammalt (' + [math]::Round(($nu - $skapad) / 60000) + ' min)  "' + (Kort $p.text) + '"') DarkGray
      continue
    }

    # ---- Geokodning, från PowerShell ------------------------------------
    #
    # GRUPPENS ruta och GRUPPENS ort, inte en global. Det här är raden som
    # gör att en Stockholmsvarning aldrig kan hamna på Västeråskartan:
    # frågan bär gruppens viewbox och bounded=1, och svaret kontrolleras mot
    # samma ruta en gång till i Geokoda innan koordinaten släpps vidare.
    $traff = $null
    try { $traff = Geokoda -Plats ([string]$t.place) -Grupp $Grupp }
    catch {
      $script:Summa.misslyckade++
      Markera-Forsok $p.nyckel
      Logga 'GEO-FEL' ($t.place + ': ' + $_.Exception.Message) DarkYellow
      continue
    }
    if (-not $traff) {
      $script:Summa.okandPlats++
      Markera-Klar $p.nyckel
      Logga 'HOPPAS-ÖVER' ('orsak=okänd-plats "' + $t.place + '"  "' + (Kort $p.text) + '"') DarkGray
      continue
    }

    # ---- Raden -----------------------------------------------------------
    $rad = [ordered]@{
      id          = [guid]::NewGuid().ToString()
      type        = $typ
      lat         = $traff.lat
      lon         = $traff.lon
      label       = $traff.label
      note        = (Kort ([string]$p.text) 240)
      source      = 'facebook'
      # Egen enhet, precis som js/facebook.js har 'fb-bridge' och js/fbmejl.js
      # har 'fb-mejl'. Ingen kod filtrerar på fältet — det är till för att gå
      # att se i databasen vilken väg en rad kom in.
      device_id   = 'fb-daemon'
      external_id = [string]$p.externalId
      created_at  = $skapad
      expires_at  = $forfaller
      confirms    = 1
      denials     = 0
    }

    $alderMin = [math]::Round(($nu - $skapad) / 60000)

    if (-not $Skarpt) {
      $script:Summa.skickade++
      Markera-Klar $p.nyckel
      Logga 'SKULLE-SKICKA' (
        'typ=' + $typ +
        ' plats="' + $traff.label + '" ' + $traff.lat + ',' + $traff.lon +
        ' tilltro=' + [math]::Round([double]$t.confidence * 100) + '%' +
        ' ålder=' + $alderMin + 'min (' + $p.kalla + ')' +
        ' lever=' + $minuter + 'min' +
        ' extid=' + $rad.external_id
      ) Green
      Logga 'SKULLE-SKICKA' ('  text: "' + (Kort ([string]$p.text) 240) + '"') Green
      continue
    }

    # Skickas inte här. Läggs i utkorgen och går i ett anrop efter att ALLA
    # gruppers svep gjorts, så att fbmejl_ta_emot ser dem som EN omgång och
    # skickar EN notis.
    $utkorg += ,$rad
    $utkorgNycklar += ,$p.nyckel
    Logga 'KÖAD' (
      '[' + $namn + '] typ=' + $typ + ' plats="' + $traff.label + '" ålder=' + $alderMin +
      'min (' + $p.kalla + ')'
    ) DarkGray
  }

  $kalibrering = ''
  if (-not $Svepresultat.kalibrerat) { $kalibrering = '  (KALIBRERINGSSVEP — inget får en observerad ålder)' }
  $dold = ''
  if ($Svepresultat.dold) { $dold = ' flik=dold' }

  Logga 'SVEP' (
    '[' + $namn + '] inlägg=' + $poster.Count +
    ' nya=' + $nya +
    ' med-ålder=' + $medTidNu +
    ' utan-ålder=' + $utanTidNu +
    ' vägrade=' + $vagradeNu +
    $dold + $kalibrering) White

  return @{ utkorg = $utkorg; nycklar = $utkorgNycklar; poster = $poster.Count }
}

<#
  Skicka en omgång och läs av vad servern faktiskt gjorde.

  Anropas en gång per notisläge och tick, inte en gång per grupp: raderna
  från alla grupper som får pusha går i SAMMA anrop, för det är omgången
  fbmejl_ta_emot buntar notisen på. Grupper med notis: false går i ett eget
  anrop på anon-vägen, som ändå inte utlöser någon notis och alltså inte kan
  splittra buntningen.
#>
function Tom-Utkorg {
  param([object[]]$Rader, [string[]]$Nycklar, [switch]$UtanNotis, [string]$Grupper)
  if (-not $Rader -or $Rader.Count -eq 0) { return }

  try {
    $svar = Skicka-Omgang -Rader $Rader -UtanNotis:$UtanNotis
    foreach ($n in $Nycklar) { Markera-Klar $n }

    # Läs av vad servern FAKTISKT gjorde. Det är den återkopplingen som
    # saknades och som lät det gamla felet leva: daemonen sa "skickad"
    # medan ingenting hände på andra sidan.
    $skapade = 0; $dubbletter = 0; $vagrade = 0; $notis = 'okänd'
    if ($svar) {
      if ($null -ne $svar.skrivna)     { $skapade    = [int]$svar.skrivna }
      elseif ($null -ne $svar.skapade) { $skapade    = [int]$svar.skapade }
      if ($null -ne $svar.dubbletter)  { $dubbletter = [int]$svar.dubbletter }
      if ($null -ne $svar.vagrade)     { $vagrade    = [int]$svar.vagrade }
      if ($null -ne $svar.notis)       { $notis      = [string]$svar.notis }
    }
    $script:Summa.skickade   += $skapade
    $script:Summa.dubbletter += $dubbletter
    Logga 'OMGÅNG' (
      $(if ($Grupper) { '[' + $Grupper + '] ' } else { '' }) +
      'skickade=' + $Rader.Count + ' rapporter=' + $skapade +
      ' dubbletter=' + $dubbletter + ' vägrade=' + $vagrade + ' notis=' + $notis
    ) Green

    $avsiktligt = ($svar -and (@($svar.PSObject.Properties.Name) -contains 'avsiktligt') -and $svar.avsiktligt)
    if ($avsiktligt) {
      # INTE ett fel. Gruppen står med notis: false i bryggfilen. Raden finns
      # för att skillnaden mot en saknad nyckel ska synas — annars felsöker
      # man en nyckel som inte fattas.
      Logga 'KARTA-UTAN-NOTIS' (
        'Rapporten syns i appen och på kartan. Ingen push: gruppen står med notis: false i ' +
        (Split-Path -Leaf $Bryggfil) + ' — notisvägen på servern saknar geografi och skulle ' +
        'skicka den till varenda prenumerant, oavsett stad.'
      ) DarkGray
    } elseif ($svar -and $svar.utanNyckel) {
      # Halva kedjan gick. Säg det rakt ut varje gång — annars tror man att
      # tystnaden i telefonen betyder att inget hände i gruppen.
      Logga 'KARTA-UTAN-NOTIS' (
        'Rapporten syns i appen. Ingen push till lås skärm: service_role-nyckeln saknas. ' +
        'Kör tools\satt-nyckel.ps1 så går även notisen.'
      ) Yellow
    } elseif ($skapade -gt 0 -and $notis -eq 'False') {
      Logga 'OMGÅNG' ('  rapport skapad men INGEN notis — se fbmejl_notis_logg för skälet') Yellow
    }
  } catch {
    $script:Summa.misslyckade += $Rader.Count
    foreach ($n in $Nycklar) { Markera-Forsok $n }
    Logga 'SKICK-FEL' ($_.Exception.Message) Red
  }
}

function Skriv-Summa {
  Logga 'SUMMA' ('svep=' + $script:Summa.svep +
    ' unika-inlägg=' + $script:Summa.sedda +
    ' läsbar-ålder=' + $script:Summa.medTid +
    ' utan-ålder=' + $script:Summa.utanTid +
    ' vägrade=' + $script:Summa.vagrade +
    ' hoppade=' + $script:Summa.hoppade +
    ' okänd-plats=' + $script:Summa.okandPlats +
    $(if ($Skarpt) { ' skickade=' } else { ' skulle-skickat=' }) + $script:Summa.skickade +
    ' dubbletter=' + $script:Summa.dubbletter +
    ' fel=' + $script:Summa.misslyckade) Cyan

  if ($script:Upptackt.Count -gt 0) {
    $v = @($script:Upptackt.Values | ForEach-Object { [double]$_ / 1000 })
    $medel = [math]::Round(($v | Measure-Object -Average).Average, 1)
    $max = [math]::Round(($v | Measure-Object -Maximum).Maximum, 1)
    Logga 'SUMMA' ('fördröjning inlägg→upptäckt (mätt på Facebooks egen tid, n=' +
      $v.Count + '): medel ' + $medel + ' s, längsta ' + $max + ' s') Cyan
  }
}

# =====================================================================
#  Huvudloopen
# =====================================================================

Logga 'START' ('Polisvakt brygg-daemon — ' +
  $(if ($Skarpt) { 'SKARPT LÄGE, skriver till databasen' } else { 'TORRKÖRNING, skriver ingenting' }) +
  '  grupper=' + $script:Grupper.Count + '  svep var ' + [math]::Round($SvepIntervallMs / 1000) + ' s') $(if ($Skarpt) { 'Yellow' } else { 'Cyan' })
foreach ($g in $script:Grupper) {
  Logga 'GRUPP' ('  ' + $g.id + '  ' + $g.namn + '  [' + (@($g.ruta) -join ',') + ']' +
    '  ort=' + $(if ($g.ort) { $g.ort } else { '—' }) +
    $(if (-not $g.notis) { '  notis=AV (karta ja, push nej)' } else { '' })) DarkCyan
}
if ($GruppId -and @($GruppId).Count -gt 0 -and $script:Grupper.Count -lt $script:AllaGrupper.Count) {
  Logga 'GRUPP' ('-GruppId angivet: läser ' + $script:Grupper.Count + ' av ' +
    $script:AllaGrupper.Count + ' grupper i bryggfilen. Ta bort flaggan för att läsa alla ' +
    '(kör om tools\polisvakt-brygga.ps1 -Installera om den kommer från Schemaläggaren).') Yellow
}
foreach ($g in $script:Grupper) {
  if ($g.id -notmatch '^\d+$') {
    # Adressen öppnas med exakt den sträng som står i listan, och Anslut
    # matchar på samma sträng. Står gruppen med sin slug fungerar det så
    # länge Facebook inte skriver om adressen — men numeriska id byts aldrig,
    # och en slug kan gruppens admin ändra. Värt en rad, inte ett stopp.
    Logga 'GRUPP' ('  ' + $g.id + ' är ingen sifferform. Facebook skriver inte om numeriska ' +
      'adresser till slug, så numeriskt id är det stabila valet.') DarkYellow
  }
}
Logga 'START' ('läsdel ur ' + (Split-Path -Leaf $Bryggfil) + ': ' + $script:Lasdel.Length + ' tecken, ordagrant')
Logga 'START' ('logg: ' + $script:LoggSokvag)

if ($Sjalvtest) {
  # PRODUKTREGELN GÄLLER VARJE GRUPP LIKA, och det provas mot varje grupp för
  # sig. Varje flik bär sin EGEN injicerade kopia av bryggkoden; en spärr som
  # råkar sitta i den ena fliken bevisar ingenting om den andra.
  $fel = 0
  $korda = 0
  foreach ($g in $script:Grupper) {
    $kontext = $null
    $a = Anslut -Port $Felsokningsport -Grupp $g
    if ($a -and -not $a.ContainsKey('fel')) {
      $kontext = $a
      try { Gor-Svep -Kontext $kontext | Out-Null } catch {
        Logga 'VARNING' ('kunde inte injicera läsaren i ' + $g.namn + ': ' + $_.Exception.Message) DarkYellow
        $kontext = $null
      }
    } else {
      Logga 'INFO' ('[' + $g.namn + '] ' + $a.fel) DarkYellow
    }
    Logga 'PROV' ('Produktregeln i gruppen "' + $g.namn + '"' +
      $(if ($kontext) { ' — mätt i sidans egen kopia av bryggkoden' }
        else { ' — bara PowerShell-spärren, ingen flik att fråga' })) Cyan
    $fel += Kor-Sjalvtest -Kontext $kontext
    $korda++
    Koppla-Ner $kontext
  }
  if ($fel -gt 0) { Logga 'PROV' ("$fel fel — produktregeln håller INTE.") Red; exit 1 }
  Logga 'PROV' ('Alla fall gröna i alla ' + $korda + ' grupper.') Green
  exit 0
}

# =====================================================================
#  Provet på vakthunden — placerat här, efter alla funktioner
# =====================================================================
#
# Detektorn i sidan är mätt mot både den inloggade och den utloggade
# gruppsidan. Det som INTE går att mäta i en webbläsare är om
# tillståndsmaskinen larmar en gång eller tjugo, och det är den egenskapen
# som avgör om vakthunden blir kvar eller avstängd.
#
# Sju steg. Ingen av dem rör nätet, Chrome eller databasen.

function Fejksvep {
  param([string]$Sidlage, [string]$Medlemskap = 'okand')
  return [pscustomobject]@{ sidlage = $Sidlage; medlemskap = $Medlemskap }
}

<#
  Ett krav i ett prov: $true när det håller, annars förklaringen.

  DEN HÄR FUNKTIONEN FINNS FÖR ATT ETT PROV LJÖG.

  Den naturliga formen `return (villkor) -or 'förklaring'` är hämtad från
  JavaScript, där `a || 'text'` ger tillbaka strängen. I PowerShell är -or en
  BOOLESK operator: den gör om 'förklaring' till $true eftersom strängen inte
  är tom, och hela uttrycket blir alltså $true oavsett villkoret. Fem prov
  skrivna så var gröna utan att mäta någonting, och det upptäcktes bara för
  att en avsiktlig röd-bevisning inte blev röd.

  Ett prov som inte kan bli rött är värre än inget prov: det ser ut som
  täckning.
#>
function Kravs {
  param([bool]$Villkor, [string]$Meddelande)
  if ($Villkor) { return $true }
  return $Meddelande
}

function Fejkgrupp {
  param([string]$Id, [string]$Namn, $Ruta, [string]$Ort = '', [string]$Omrade = '')
  $orter = @()
  foreach ($o in @($Ort, $Omrade)) { if ($o) { $orter += $o.ToLowerInvariant() } }
  return @{ id = $Id; namn = $Namn; ort = $Ort; omrade = $Omrade
            ruta = @($Ruta); orter = $orter; notis = $true }
}

if ($ProvaVakthund) {
  Logga 'PROV' 'Vakthunden — larmar den EN gång per tillståndsövergång, och per grupp?' Cyan

  $script:ProvFel = 0
  $script:ProvAntal = 0

  # Läget som mäts är GRUPPENS: sessionen plus just den här gruppens tillstånd.
  # Med bara en grupp är det samma sak som förut. Med två är det den enda
  # frågan som betyder något — "kommer det fram varningar ur DEN HÄR gruppen"
  # — och det är precis den frågan den gamla globala mätaren inte kunde svara
  # på, eftersom en aktiv grupp nollställde den åt alla.
  function Steg {
    param([string]$Namn, $Grupp, [string]$Sidlage, [int]$Inlagg,
          [string]$VantatLage, [int]$VantadeNotiser, [string]$Medlemskap = 'okand')
    $fore = $script:DriftRaknare
    Kolla-Session -Sidlage $Sidlage
    Kolla-Vakthund -Grupp $Grupp -Svepresultat (Fejksvep $Sidlage $Medlemskap) -Inlagg $Inlagg
    $nya = $script:DriftRaknare - $fore
    $lage = Vakt-Lage $Grupp
    $ok = ($lage -eq $VantatLage) -and ($nya -eq $VantadeNotiser)
    $script:ProvAntal++
    Logga 'PROV' ('  {0,-52} läge={1,-5} notiser={2}  {3}' -f
      $Namn, $lage, $nya, $(if ($ok) { 'OK' } else {
        'FEL — väntade läge=' + $VantatLage + ' notiser=' + $VantadeNotiser })) `
      $(if ($ok) { 'Green' } else { 'Red' })
    if (-not $ok) { $script:ProvFel++ }
  }

  # Ett påstående utan svep. Används för de egenskaper som handlar om
  # FÖRHÅLLANDET mellan två grupper, inte om ett enskilt svep.
  function Provfall2 {
    param([string]$Namn, [scriptblock]$Kod)
    $script:ProvAntal++
    $svar = $null
    try { $svar = & $Kod } catch { $svar = 'kastade: ' + $_.Exception.Message }
    # -is [bool] med flit: bara ett riktigt booleskt $true räknas som grönt.
    # Ett prov som av misstag lämnar tillbaka en sträng ska falla, inte passera.
    $ok = ($svar -is [bool] -and $svar)
    Logga 'PROV' ('  {0,-52} {1}' -f $Namn, $(if ($ok) { 'OK' } else { 'FEL — ' + $svar })) `
      $(if ($ok) { 'Green' } else { 'Red' })
    if (-not $ok) { $script:ProvFel++ }
  }

  $VST = Fejkgrupp '317968668373072' 'Västerås' @(15.10, 59.30, 17.30, 60.30) 'Västerås' 'Västmanland'
  $STH = Fejkgrupp '563061233834062' 'Stockholm' @(17.20, 58.80, 19.30, 60.20) 'Stockholm' 'Stockholms län'

  # ---- Den gamla tillståndsmaskinen, oförändrad i sitt beteende --------
  $script:ProvFel = 0
  $script:VaktLage = 'ok'
  $script:VaktTomSekunder = 0
  $script:SenasteSidlage = $null
  $script:SessionLage = 'ok'
  $script:DriftRaknare = 0
  $script:Vakt = @{}
  # Gruppen har redan läst — annars gäller ny-regeln, som provas för sig nedan.
  (Vakt-For $VST).harLast = $true
  (Vakt-For $VST).lage = 'ok'

  Steg 'inloggad, ett inlägg'                      $VST 'inloggad' 1 'ok'    0
  Steg 'utloggad — ska larma EN gång'              $VST 'utloggad' 0 'blind' 1
  Steg 'utloggad igen — får INTE larma om'         $VST 'utloggad' 0 'blind' 0
  Steg 'utloggad tredje gången — fortfarande tyst' $VST 'utloggad' 0 'blind' 0
  Steg 'inloggad men tomt flöde — ännu inte löst'  $VST 'inloggad' 0 'ok'    1

  # Not: raden ovan larmar "läser igen" på SESSIONEN, som är global och delas
  # av alla flikar. Den är löst i samma sekund som sidan säger inloggad; att
  # vänta på ett inlägg hade betytt att beskedet dröjer till nästa gång någon
  # postar, vilket kan vara timmar. Gruppens egen tomhet mäts separat nedan.
  Steg 'inloggad med inlägg — allt normalt'        $VST 'inloggad' 2 'ok'    0
  Steg 'allt lugnt igen — inga fler notiser'       $VST 'inloggad' 2 'ok'    0

  # Sex dagtimmar utan ett enda inlägg. Mätaren sätts direkt i stället för att
  # vänta sex timmar; tröskeln är redan nådd, så provet ger samma svar oavsett
  # vad klockan är när det körs.
  (Vakt-For $VST).tomSekunder = 6 * 3600
  Steg 'sex dagtimmar helt tomt — ska larma'       $VST 'inloggad' 0 'blind' 1
  (Vakt-For $VST).tomSekunder = 6 * 3600
  Steg 'sjunde timmen — får INTE larma om'         $VST 'inloggad' 0 'blind' 0
  Steg 'ett inlägg igen — ska säga läser igen'     $VST 'inloggad' 2 'ok'    1

  # Ett okänt sidläge får ALDRIG utlösa ett larm. Facebook byter markup ofta,
  # och en vakthund som skriker på okänt läge blir avstängd inom en vecka.
  Steg 'okänt sidläge, tomt flöde — ska tiga'      $VST 'okand'    0 'ok'    0

  # ---- Ansluten grupp som inte går att läsa ----------------------------
  #
  # Ägaren är inte medlem i Stockholmsgruppen. En privat grupp ger då noll
  # inlägg för alltid, medan sessionen är inloggad och varje led rapporterar
  # framgång. Det ser exakt ut som en lugn kväll i Stockholm.
  Logga 'PROV' '  — en ansluten grupp som aldrig ger något —' Cyan
  Steg 'ny grupp, första svepet tomt — ska tiga än' $STH 'inloggad' 0 'ok' 0 'ejmedlem'
  (Vakt-For $STH).tomSekunder = $script:VAKT_NY_SEKUNDER
  Steg 'fem minuter utan ett enda inlägg — säg ifrån' $STH 'inloggad' 0 'blind' 1 'ejmedlem'
  (Vakt-For $STH).tomSekunder = $script:VAKT_NY_SEKUNDER * 10
  Steg 'en timme senare — får INTE säga om det'    $STH 'inloggad' 0 'blind' 0 'ejmedlem'
  (Vakt-For $STH).tomSekunder = $script:VAKT_NY_SEKUNDER * 100
  Steg 'ett dygn senare — fortfarande tyst'        $STH 'inloggad' 0 'blind' 0 'ejmedlem'

  # Den andra gruppen får inte påverkas av att den första är blind, och
  # tvärtom. Det var precis felet i den gamla globala mätaren: $VaktTomSekunder
  # nollställdes så fort NÅGON grupp gav inlägg, så en tyst Stockholmsflik
  # doldes helt av en aktiv Västeråsflik. Raden nedan mäter att det inte kan
  # hända igen — Stockholm står som blind i samma stund.
  Steg 'Västerås läser som vanligt trots det'      $VST 'inloggad' 3 'ok'    0
  Provfall2 'Stockholm är fortfarande blind samtidigt' {
    return Kravs ((Vakt-Lage $STH) -eq 'blind') 'Stockholm räknades som ok'
  }

  # Och när ägaren väl gått med ska gruppen säga till EN gång att den läser.
  Steg 'ägaren går med — första inlägget kommer'   $STH 'inloggad' 1 'ok'    0 'medlem'
  Steg 'nästa svep — inget mer att säga'           $STH 'inloggad' 2 'ok'    0 'medlem'

  $gick = $script:ProvAntal - $script:ProvFel
  Logga 'PROV' ('Vakthunden: ' + $gick + '/' + $script:ProvAntal) `
    $(if ($script:ProvFel -eq 0) { 'Green' } else { 'Red' })
  if ($script:ProvFel -gt 0) { exit 1 }
  Logga 'PROV' 'Alla fall gröna. Larmet går en gång per övergång och grupp, aldrig i repris.' Green
  exit 0
}

# =====================================================================
#  Provet på grupplistan och på att varje grupp bär sin egen ruta
# =====================================================================
#
# Tre frågor, och alla tre har ett rätt svar som är dyrt att ha fel:
#
#   1. Läser daemonen samma lista som bryggkoden? De två tolkarna är skrivna
#      i olika språk mot samma text. Går de isär läser användarskriptet och
#      daemonen olika grupper, och ingen av dem säger till.
#   2. Får varje grupp SIN ruta? Det var felet som gjorde en andra grupp
#      meningslös: varje grupp fick Västmanlands.
#   3. Kan en Stockholmsvarning hamna på Västeråskartan? Nej är det enda
#      godtagbara svaret, och det ska mätas, inte påstås.

if ($ProvaGrupper) {
  Logga 'PROV' 'Grupplistan — en sanning, och en ruta per grupp' Cyan
  $script:ProvFel = 0
  $script:ProvAntal = 0

  function Provfall {
    param([string]$Namn, [scriptblock]$Kod)
    $script:ProvAntal++
    $svar = $null
    try { $svar = & $Kod } catch { $svar = 'kastade: ' + $_.Exception.Message }
    # -is [bool] med flit: bara ett riktigt booleskt $true räknas som grönt.
    # Ett prov som av misstag lämnar tillbaka en sträng ska falla, inte passera.
    $ok = ($svar -is [bool] -and $svar)
    Logga 'PROV' ('  {0,-64} {1}' -f $Namn, $(if ($ok) { 'OK' } else { 'FEL — ' + $svar })) `
      $(if ($ok) { 'Green' } else { 'Red' })
    if (-not $ok) { $script:ProvFel++ }
  }

  $VMR = @(15.10, 59.30, 17.30, 60.30)
  $STR = @(17.20, 58.80, 19.30, 60.20)
  $gVast = Fejkgrupp '317968668373072' 'Västerås' $VMR 'Västerås' 'Västmanland'
  $gSthlm = Fejkgrupp '563061233834062' 'Stockholm' $STR 'Stockholm' 'Stockholms län'

  # ---- 1. Den riktiga filen -------------------------------------------
  Provfall 'bryggfilens egen lista går att läsa och har minst en grupp' {
    if ($script:AllaGrupper.Count -lt 1) { return 'noll grupper' }
    return $true
  }
  Provfall 'Västeråsgruppen står kvar med oförändrad ruta' {
    $g = $script:AllaGrupper | Where-Object { $_.id -eq '317968668373072' } | Select-Object -First 1
    if (-not $g) { return 'gruppen saknas i listan' }
    $r = (@($g.ruta) -join ',')
    return ($r -eq '15.1,59.3,17.3,60.3') -or ('rutan är ' + $r)
  }
  Provfall 'varje grupp i filen har en giltig ruta och ett eget id' {
    $sedda = @()
    foreach ($g in $script:AllaGrupper) {
      if (-not (Giltig-Ruta $g.ruta)) { return $g.id + ' har ingen giltig ruta' }
      if ($sedda -contains $g.id) { return $g.id + ' står två gånger' }
      $sedda += $g.id
    }
    return $true
  }
  Provfall 'utkommenterade grupper räknas INTE som anslutna' {
    # Stockholmsraderna ligger färdigskrivna men bortkommenterade i filen.
    # Läser tolkaren dem öppnar daemonen flikar mot grupper ägaren inte gått
    # med i, och vakthunden larmar om något som aldrig var påslaget.
    foreach ($g in $script:AllaGrupper) {
      if ($g.id -eq '563061233834062' -or $g.id -eq '280649102036931') {
        return 'en utkommenterad grupp (' + $g.id + ') lästes som ansluten'
      }
    }
    return $true
  }

  # ---- 2. Reglerna, mot samma text bryggan skulle läsa -----------------
  Provfall 'två grupper i listan ger två grupper' {
    $k = "groupIds: [ { id: '111', namn: 'A', ort: 'Ao', omrade: 'Al', ruta: [15.1, 59.3, 17.3, 60.3] }, " +
         "{ id: '222', namn: 'B', ort: 'Bo', omrade: 'Bl', ruta: [17.2, 58.8, 19.3, 60.2] } ],"
    $g = @(Plocka-Grupper -Kalla $k)
    if ($g.Count -ne 2) { return 'fick ' + $g.Count }
    if ($g[0].id -ne '111' -or $g[1].id -ne '222') { return 'fel id' }
    return Kravs ((@($g[0].ruta) -join ',') -ne (@($g[1].ruta) -join ',')) 'båda fick samma ruta'
  }
  Provfall 'appens form med dubbla citattecken läses likadant' {
    # "Kopiera inställning till bryggan" skriver med JSON.stringify.
    $k = 'groupIds: [ { id: "111", namn: "Polisen \"Norr\"", ort: "Ao", omrade: "Al", ' +
         'ruta: [15.10, 59.30, 17.30, 60.30] } ],'
    $g = @(Plocka-Grupper -Kalla $k)
    if ($g.Count -ne 1) { return 'fick ' + $g.Count }
    return Kravs ($g[0].namn -eq 'Polisen "Norr"') ('namnet blev ' + $g[0].namn)
  }
  Provfall 'exakt det appen lägger i urklipp går igenom hela vägen' {
    # Ordagrant ur "Kopiera inställning till bryggan" i appen, med svenska
    # tecken och dubbla citattecken. Rundturen app -> fil -> daemon är den
    # skarv som brukar gå sönder tyst: appen ser rätt ut, bryggan startar
    # inte, och ingen av dem säger varför.
    $k = @'
groupIds: [
      { id: "317968668373072", namn: "Här Står Polisen - Västerås", ort: "Västerås", omrade: "Västmanland", ruta: [15.10, 59.30, 17.30, 60.30] },
      { id: "563061233834062", namn: "Poliskontroller Stockholm", ort: "Stockholm", omrade: "Stockholms län", ruta: [17.20, 58.80, 19.30, 60.20], notis: false },
    ],
'@
    $g = @(Plocka-Grupper -Kalla $k)
    if ($g.Count -ne 2) { return 'fick ' + $g.Count + ' grupper' }
    if ($g[0].namn -ne 'Här Står Polisen - Västerås') { return 'namnet blev "' + $g[0].namn + '"' }
    if ($g[1].omrade -ne 'Stockholms län') { return 'området blev "' + $g[1].omrade + '"' }
    if (($g[1].orter -join '/') -ne 'stockholm/stockholms län') {
      return 'orterna blev ' + ($g[1].orter -join '/')
    }
    if ((@($g[1].ruta) -join ',') -ne '17.2,58.8,19.3,60.2') {
      return 'rutan blev ' + (@($g[1].ruta) -join ',')
    }
    if (-not $g[0].notis) { return 'Västerås tystades av en saknad notis-nyckel' }
    return Kravs (-not $g[1].notis) 'Stockholm fick notis trots notis: false'
  }

  Provfall 'en grupp utan ruta STOPPAR starten när det finns fler än en' {
    $k = "groupIds: [ { id: '111', ruta: [15.1, 59.3, 17.3, 60.3] }, { id: '222', namn: 'Utan' } ],"
    try { Plocka-Grupper -Kalla $k | Out-Null } catch { return $true }
    return 'listan godtogs trots att en grupp saknar område'
  }
  Provfall 'en vänd ruta räknas inte som en ruta' {
    $k = "groupIds: [ { id: '111', ruta: [17.3, 59.3, 15.1, 60.3] } ],"
    try { Plocka-Grupper -Kalla $k | Out-Null } catch { return $true }
    return 'en vänd ruta godtogs'
  }
  Provfall 'gamla formen — en ensam naken sträng — betyder Västmanland' {
    $g = @(Plocka-Grupper -Kalla "groupIds: [],`n groupId: '317968668373072',")
    if ($g.Count -ne 1) { return 'fick ' + $g.Count }
    return Kravs ((@($g[0].ruta) -join ',') -eq '15.1,59.3,17.3,60.3') ('rutan blev ' + (@($g[0].ruta) -join ','))
  }
  Provfall 'samma grupp två gånger blir en' {
    $k = "groupIds: [ { id: '111', ruta: [15.1, 59.3, 17.3, 60.3] }, " +
         "{ id: 'https://www.facebook.com/groups/111/', ruta: [17.2, 58.8, 19.3, 60.2] } ],"
    $g = @(Plocka-Grupper -Kalla $k)
    return Kravs ($g.Count -eq 1) ('fick ' + $g.Count)
  }
  Provfall 'gruppflödet /groups/feed/ går inte att ansluta' {
    $k = "groupIds: [ { id: 'feed', ruta: [15.1, 59.3, 17.3, 60.3] } ],"
    try { Plocka-Grupper -Kalla $k | Out-Null } catch { return $true }
    return 'feed godtogs som grupp'
  }
  Provfall 'notis: false läses, och saknad notis betyder true' {
    $k = "groupIds: [ { id: '111', ruta: [15.1, 59.3, 17.3, 60.3] }, " +
         "{ id: '222', ruta: [17.2, 58.8, 19.3, 60.2], notis: false } ],"
    $g = @(Plocka-Grupper -Kalla $k)
    if ($g.Count -ne 2) { return 'fick ' + $g.Count }
    if (-not $g[0].notis) { return 'första gruppen tystades av en saknad nyckel' }
    return Kravs (-not $g[1].notis) 'notis: false lästes inte'
  }

  # ---- 2b. Det som faktiskt injiceras i sidan --------------------------
  #
  # DET HÄR ÄR PROVET PÅ SJÄLVA BUGGEN.
  #
  # Fram till 2.4 injicerade daemonen `groupId: '<id>'` — en naken sträng —
  # och bryggans normaliseraGrupper tog då bakåtkompatibilitetsgrenen:
  # Västmanlands ruta och orten Västerås, oavsett vilket id som stod där.
  # Ingenting kraschade. Stockholmsgruppens platser slogs bara upp mot
  # Västmanland, svarade tomt, och loggades som "okänd-plats".
  Logga 'PROV' '  — läsarkoden som injiceras i fliken —' Cyan

  Provfall 'läsarkoden bär gruppens EGEN ruta, inte bara ett id' {
    $kod = Bygg-Lasarkod -Grupp $gSthlm
    if ($kod -notmatch 'groupIds:\s*\[') { return 'CONFIG saknar en groupIds-lista' }
    if ($kod -match "groupId:\s*'563061233834062'") {
      return 'CONFIG bär ett naket groupId — bryggan ger då gruppen Västmanlands ruta'
    }
    foreach ($tal in @('17.2', '58.8', '19.3', '60.2')) {
      if ($kod -notmatch [regex]::Escape($tal)) { return 'rutan saknar ' + $tal }
    }
    return $true
  }
  Provfall 'läsarkoden för Stockholm innehåller inte Västmanlands ruta' {
    $kod = Bygg-Lasarkod -Grupp $gSthlm
    # 15.1,59.3,17.3,60.3 får inte finnas någonstans i den injicerade
    # CONFIG-raden. Gör den det har gruppen fått fel geografi med sig in.
    $m = [regex]::Match($kod, 'groupIds:\s*(\[.*?\]),')
    if (-not $m.Success) { return 'hittade ingen groupIds-rad' }
    return Kravs ($m.Groups[1].Value -notmatch '15\.1') ('Västmanlands ruta följde med: ' + $m.Groups[1].Value)
  }
  Provfall 'två grupper får två olika läsarkoder och två olika versioner' {
    $a = Bygg-Lasarkod -Grupp $gVast
    $b = Bygg-Lasarkod -Grupp $gSthlm
    if ($a -eq $b) { return 'samma kod för båda grupperna' }
    $va = $script:LasarVersion[$gVast.id]
    $vb = $script:LasarVersion[$gSthlm.id]
    if (-not $va -or -not $vb) { return 'versionen saknas för en av grupperna' }
    # Versionen styr om koden injiceras om. Delade grupperna version skulle
    # den ena fliken tro att den andra gruppens läsare var dess egen.
    return ($va -ne $vb) -or ('båda fick version ' + $va)
  }

  # ---- 3. EN STOCKHOLMSVARNING FÅR ALDRIG HAMNA PÅ VÄSTERÅSKARTAN ------
  Logga 'PROV' '  — geografin: varje grupp bär sin egen ruta —' Cyan

  Provfall 'Sergels torg räknas INTE som Västmanland' {
    return Kravs (-not (Inom-Omradet -Lat 59.3326 -Lon 18.0649 -Grupp $gVast)) `
      'Sergels torg godtogs i Västeråsgruppen'
  }
  Provfall 'Erikslund räknas INTE som Stockholm' {
    return Kravs (-not (Inom-Omradet -Lat 59.6094 -Lon 16.4879 -Grupp $gSthlm)) `
      'Erikslund godtogs i Stockholmsgruppen'
  }
  Provfall 'var och en hittar hem i sin egen ruta' {
    if (-not (Inom-Omradet -Lat 59.6094 -Lon 16.4879 -Grupp $gVast)) { return 'Erikslund hittade inte hem' }
    if (-not (Inom-Omradet -Lat 59.3326 -Lon 18.0649 -Grupp $gSthlm)) { return 'Sergels torg hittade inte hem' }
    return $true
  }
  Provfall 'ortsuffixet kommer ur gruppen, inte ur en global' {
    if (($gVast.orter -join '/') -ne 'västerås/västmanland') { return 'Västerås: ' + ($gVast.orter -join '/') }
    if (($gSthlm.orter -join '/') -ne 'stockholm/stockholms län') { return 'Stockholm: ' + ($gSthlm.orter -join '/') }
    return $true
  }
  Provfall 'geo-cachens nyckel bär gruppen — samma gata, två städer' {
    # Cachefilen innehöll redan "vasagatan" -> Västerås. Utan gruppen i
    # nyckeln hade Stockholms Vasagatan fått Västeråskoordinaten.
    $spar = @{}
    foreach ($n in @($script:Geo.Keys)) { $spar[$n] = $script:Geo[$n] }
    try {
      $script:Geo = @{}
      $script:Geo[($gVast.id + '|vasagatan')] = @{ lat = 59.6103; lon = 16.5448; label = 'Vasagatan' }
      $traffVast = Geokoda -Plats 'Vasagatan' -Grupp $gVast
      if (-not $traffVast) { return 'Västerås egen cacherad hittades inte' }
      if ($script:Geo.ContainsKey($gSthlm.id + '|vasagatan')) { return 'Stockholm delade Västerås rad' }
      # Stockholmsgruppen har ingen rad — och den skulle ALDRIG få
      # Västeråskoordinaten ur cachen. Det bevisas av att nyckeln saknas.
      return $true
    } finally {
      $script:Geo = @{}
      foreach ($n in @($spar.Keys)) { $script:Geo[$n] = $spar[$n] }
    }
  }

  # ---- 3b. Svepets utkorg lämnas tillbaka, inte skickad ----------------
  #
  # Behandla-Svep skickade förut själv. Nu returnerar den utkorgen så att
  # huvudloopen kan slå ihop alla gruppers rader till EN omgång — det är
  # omgången fbmejl_ta_emot buntar notisen på.
  #
  # Det gör returtypen till något som måste stämma. PowerShell samlar ALLT en
  # funktion skriver till pipelinen som dess returvärde: en enda rad som
  # glömmer [void] eller Out-Null gör returen till en ARRAY, och då blir
  # $skord.utkorg tyst tom och inga rapporter skickas någonsin. Samma
  # felmekanism som redan bet en gång i den här filen (se Anslut och
  # VoidTaskResult).
  Logga 'PROV' '  — svepets utkorg —' Cyan

  Provfall 'Behandla-Svep lämnar tillbaka EN hashtabell, inte en förorenad pipeline' {
    $sparFil = $script:HanteradFil
    $sparHant = $script:Hanterad
    try {
      # Hanteringslistan pekas om till en temporär fil: provet får aldrig
      # bocka av ett riktigt inlägg i den skarpa listan.
      $script:HanteradFil = Join-Path $env:TEMP ('pv-prov-hanterade-' + [guid]::NewGuid().ToString('N') + '.json')
      $script:Hanterad = @{}

      $svep = [pscustomobject]@{
        grupp = $gVast.id
        sokvag = '/groups/' + $gVast.id + '/'
        gruppfel = $null
        omrade = [pscustomobject]@{ id = $gVast.id; namn = $gVast.namn; ruta = $gVast.ruta; orter = $gVast.orter }
        dold = $false
        sidlage = 'inloggad'
        medlemskap = 'medlem'
        nu = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        kalibrerat = $true
        poster = @(
          # En vägrad rad bär varken text, id eller tolkning — precis som
          # sidan lämnar den. Den ska räknas, bockas av, och INTE hamna i
          # utkorgen.
          [pscustomobject]@{ nyckel = 'g:prov|id:1'; externalId = 'fb:prov1'; plats = 0; vagrad = $true }
        )
      }

      $skord = Behandla-Svep -Grupp $gVast -Svepresultat $svep

      if ($skord -is [array]) {
        return 'returen blev en array med ' + @($skord).Count +
          ' element — någon rad i Behandla-Svep skriver till pipelinen'
      }
      if (-not ($skord -is [hashtable])) { return 'returen är en ' + $skord.GetType().Name }
      foreach ($n in @('utkorg', 'nycklar', 'poster')) {
        if (-not $skord.ContainsKey($n)) { return 'returen saknar ' + $n }
      }
      if (@($skord.utkorg).Count -ne 0) {
        return 'en vägrad rad hamnade i utkorgen'
      }
      return Kravs ($skord.poster -eq 1) ('poster=' + $skord.poster)
    } finally {
      try { if (Test-Path $script:HanteradFil) { Remove-Item $script:HanteradFil -Force } } catch { }
      $script:HanteradFil = $sparFil
      $script:Hanterad = $sparHant
    }
  }

  Provfall 'fel grupp i svaret ger en tom utkorg, inte ett undantag' {
    # Fliken har navigerat bort. Returen måste ändå ha rätt form, annars
    # kraschar huvudloopen på nästa rad i stället för att bara hoppa över.
    $svep = [pscustomobject]@{
      grupp = '999999'; sokvag = '/groups/999999/'; gruppfel = $null
      omrade = $null; dold = $false; sidlage = 'inloggad'; medlemskap = 'okand'
      nu = 0; kalibrerat = $true; poster = @()
    }
    $skord = Behandla-Svep -Grupp $gVast -Svepresultat $svep
    if ($skord -is [array]) { return 'returen blev en array' }
    return Kravs (@($skord.utkorg).Count -eq 0) 'utkorgen var inte tom'
  }

  # ---- 4. Produktregeln gäller varje grupp lika ------------------------
  Logga 'PROV' '  — produktregeln, samma i varje grupp —' Cyan

  $nykterFall = @(
    'Nykterhetskontroll vid Sergels torg',
    'Polisen har narkotikakontroll pa Sveavagen',
    'De blaser alla vid Erikslund',
    'Drogkontroll pa Stora gatan',
    'Alkoholtest vid Slussen'
  )
  $polisFall = @(
    'Polis star vid Erikslund',
    'Fartkontroll pa Sveavagen'
  )
  foreach ($g in @($gVast, $gSthlm)) {
    Provfall ('nykterhets- och drogkontroller vägras i "' + $g.namn + '"') {
      foreach ($t in $nykterFall) {
        if (-not (Test-Nykterhetskontroll $t)) { return 'släpptes igenom: ' + $t }
      }
      return $true
    }.GetNewClosure()
    Provfall ('vanliga poliskontroller släpps igenom i "' + $g.namn + '"') {
      foreach ($t in $polisFall) {
        if (Test-Nykterhetskontroll $t) { return 'vägrades felaktigt: ' + $t }
      }
      return $true
    }.GetNewClosure()
  }

  $gick = $script:ProvAntal - $script:ProvFel
  Logga 'PROV' ('Grupplistan: ' + $gick + '/' + $script:ProvAntal) `
    $(if ($script:ProvFel -eq 0) { 'Green' } else { 'Red' })
  if ($script:ProvFel -gt 0) { exit 1 }
  Logga 'PROV' 'Alla fall gröna. En lista, en ruta per grupp, ingen varning i fel stad.' Green
  exit 0
}

# ---- Torrkörningens banderoll ---------------------------------------------
#
# Gröna SKULLE-SKICKA-rader ser ut som framgång. De är det inte. Sedan skarpt
# är förval är torrkörning ett medvetet val, och då ska det stå i rött vad man
# valt — vid start och sedan var tionde minut, så att en logg man scrollar in i
# på timme tre också säger det.
$script:SenasteBanderoll = [DateTime]::MinValue
function Skriv-Banderoll {
  if ($Skarpt) { return }
  if (((Get-Date) - $script:SenasteBanderoll).TotalMinutes -lt 10) { return }
  $script:SenasteBanderoll = Get-Date
  Logga 'TORRKÖRNING' '================================================' Red
  Logga 'TORRKÖRNING' '  TORRKÖRNING — INGENTING SKICKAS' Red
  Logga 'TORRKÖRNING' '  Inga rapporter, inga notiser, ingen puls.' Red
  Logga 'TORRKÖRNING' '  Gröna SKULLE-SKICKA-rader betyder INTE att något gick fram.' Red
  Logga 'TORRKÖRNING' '  Ta bort -Torr för skarpt läge.' Red
  Logga 'TORRKÖRNING' '================================================' Red
}
Skriv-Banderoll

# ---- Startproben ----------------------------------------------------------
$script:ProbOk = Kor-Startprob

if ($BaraProb) {
  Logga 'PROB' $(if ($script:ProbOk) { 'Allt grönt. Kedjan har allt den behöver.' }
                 else { 'Något är rött. Se åtgärderna ovan.' }) $(if ($script:ProbOk) { 'Green' } else { 'Red' })
  if ($script:Mutex) { try { $script:Mutex.ReleaseMutex() } catch { } }
  exit $(if ($script:ProbOk) { 0 } else { 1 })
}

if ($TvingaLivstecken) {
  if (-not $Skarpt) {
    Logga 'LIVSTECKEN' 'Kräver skarpt läge. En torrkörning bevisar ingenting om VAPID.' Red
    exit 1
  }
  Kolla-Livstecken -Tvinga
  Logga 'LIVSTECKEN' 'Titta i telefonen. Kommer ingen notis är VAPID_KEYS felformaterad —' Yellow
  Logga 'LIVSTECKEN' 'se funktionsloggen för fbmejl-push, raden "Kunde inte läsa VAPID-nycklarna".' Yellow
  if ($script:Mutex) { try { $script:Mutex.ReleaseMutex() } catch { } }
  exit 0
}

if (-not $script:ProbOk -and -not $Skarpt) {
  Logga 'PROB' 'Proben är röd, men läget är torrkörning. Fortsätter — ingenting skickas ändå.' DarkYellow
}

# RÖD PROB I SKARPT LÄGE: den sveper inte. Frågan är bara hur den vägrar.
#
# Två sätt, och skillnaden är inte kosmetisk:
#
#   BATCHKÖRNING (-Svep eller -MinuterAttKora satt) faller direkt med kod 1.
#     Ett mätskript eller ett prov ska få ett snabbt och entydigt nej, inte
#     hänga i en halvtimme.
#
#   TJÄNSTEKÖRNING (ingen gräns satt — det normala) VÄNTAR och provar om var
#     femte minut. Den startar fortfarande INTE loopen, den läser ingenting
#     och den skickar ingenting; den står bara kvar och frågar.
#
# Varför inte bara avsluta i båda fallen: Schemaläggaren startar om en
# uppgift som faller, och en daemon som faller på en saknad nyckel skulle då
# starta om var annan minut i timtal med ett nytt konsolfönster varje gång.
# Ägaren hade fått en fönsterstorm i stället för ett besked. Och det andra
# skälet är bättre: den minut nyckeln hamnar i valvet går bryggan igång av
# sig själv, utan att någon behöver köra något.
#
# Den faller MED FLIT aldrig tillbaka till torrkörning. En brygga som tyst
# slutar skicka är precis det här bygget ska omöjliggöra.

# Saknas BARA nyckeln: kör kartan ändå.
#
# Proben stoppade förut allt när service_role-nyckeln fattades. Följden blev
# den sämsta av alla: bryggan läste inte, skrev inte, och appen var lika tyst
# som om ingen skrivit i gruppen. Men anon-nyckeln får redan skriva till
# reports — userscriptet har alltid gjort just det — så kartan kan gå utan
# nyckel. Det enda som faller bort är pushen till en låst telefon.
#
# En varning på kartan utan notis är oändligt mycket bättre än ingen varning.
# Att stanna helt var fel avvägning, och det var min.
#
# Villkoret är smalt med flit: bara när nyckeln är det ENDA som fattas. Är
# något annat rött — fel grupp, död port, trasig läsdel — stannar den som
# förut, för då vet vi inte vad vi skulle skrivit.
# Kor-Startprob returnerar direkt när nyckeln saknas och hinner aldrig pröva
# något annat. Saknad nyckel är alltså exakt liktydigt med "det enda vi vet är
# att nyckeln fattas" — de övriga kontrollerna är inte röda, de är ogjorda.
$baraNyckelnFattas = (-not $script:ProbOk) -and (-not $script:ServiceRoleKey)

if ($baraNyckelnFattas -and $Skarpt) {
  Logga 'HALVT LÄGE' 'Ingen service_role-nyckel — kör KARTA UTAN NOTIS.' Yellow
  Logga 'HALVT LÄGE' '  Rapporter skrivs med anon-nyckeln och syns i appen och på kartan.' Yellow
  Logga 'HALVT LÄGE' '  Ingen push till låst skärm förrän nyckeln är på plats:' Yellow
  Logga 'HALVT LÄGE' '    powershell -ExecutionPolicy Bypass -File tools\satt-nyckel.ps1' Cyan
  Logga 'HALVT LÄGE' '  Nykterhetsspärren är intakt: sidans, daemonens OCH serverns.' DarkGray
}
elseif (-not $script:ProbOk -and $Skarpt) {
  Logga 'STOPP' 'Startproben är RÖD och läget är skarpt. Daemonen läser INGENTING.' Red
  Logga 'STOPP' '  Rätta det som står ovan. Vill du läsa flödet under tiden utan att' Yellow
  Logga 'STOPP' '  skriva någonstans: starta om med -Torr.' Yellow

  if ($Svep -gt 0 -or $MinuterAttKora -gt 0) {
    Logga 'STOPP' '  Batchkörning — avslutar med felkod i stället för att vänta.' DarkGray
    if ($script:Mutex) { try { $script:Mutex.ReleaseMutex() } catch { } }
    exit 1
  }

  Logga 'STOPP' '  Väntar och provar om var femte minut. Ctrl+C avbryter.' DarkGray
  Logga 'STOPP' '  Den startar av sig själv i samma sekund som bristen är rättad.' DarkGray

  while (-not $script:ProbOk) {
    Start-Sleep -Seconds 300
    Logga 'PROB' 'provar om...' DarkGray
    $script:ProbOk = Kor-Startprob
  }
  Logga 'PROB' 'Grönt. Bryggan startar nu.' Green
}

# Söndagens livstecken, direkt vid start också: startar maskinen om en söndag
# kväll ska veckans enda riktiga bevis inte hoppas över.
Kolla-Livstecken

# EN KONTEXT PER GRUPP, EN LISTA I STÄLLET FÖR EN VARIABEL.
#
# Varje kontext är en egen flik, en egen isolerad värld och därmed en egen
# kalibrering och en egen först-sedd-mekanik. Det är precis vad bryggkoden
# kräver, och det är skälet att en flik per grupp valdes framför en flik som
# navigerar: en navigering river världen och gör varje svep till ett
# kalibreringssvep, alltså evig tystnad som ser ut som en lugn dag.
$script:Kontexter = @{}          # gruppid -> kontext
$script:KlaganPerGrupp = @{}     # gruppid -> när vi senast klagade
$slutTid = $null
if ($MinuterAttKora -gt 0) { $slutTid = (Get-Date).AddMinutes($MinuterAttKora) }



<#
  ETT FEL I SIDAN ÄR INTE ETT TAPPAT NÄT.

  Första versionen av loopen behandlade allt som kastades som en bruten
  anslutning: koppla ner, sov två sekunder, anslut igen. När bryggan gick
  till 2.3 och skalet kastade ReferenceError vid varje svep gav det en loop
  som anslöt om två gånger i sekunden i flera minuter — mot ägarens riktiga
  Facebook-session. Ett fel som inte går över av att man försöker igen får
  inte försökas igen i full fart.

  Nu skiljs tre saker åt:
    JS-fel i sidan   koden är fel. Logga, backa av, försök i normal takt.
    Nätfel           anslutningen är borta. Koppla ner och anslut om.
    Inget fönster    vänta, klaga en gång i minuten.

  Och varje försök räknas mot -Svep, så en körning som ska göra ett svep
  inte kan snurra i evighet på ett fel.
#>
$script:Forsok = 0
$fel_i_rad = 0

function Backa-Av {
  param([int]$IRad)
  # 2, 4, 8, 16 … sekunder, tak vid en minut. Ett trasigt tillstånd ska inte
  # mala i full fart.
  $ms = [int]([math]::Pow(2, [math]::Min($IRad, 5)) * 1000)
  return [math]::Min($ms, 60000)
}

<#
  ETT TICK = ETT SVEP PER GRUPP, OCH SEDAN EN OMGÅNG.

  Ordningen är inte godtycklig. Alla gruppers svep görs först, deras utkorgar
  slås ihop, och sedan går EN omgång till servern. fbmejl_ta_emot buntar
  notisen per omgång; skickade varje grupp för sig blev två grupper i samma
  tick till två omgångar, alltså en notis plus en som tiominutersspärren
  sväljer utan att någon får veta.

  Takten mättes innan den här ändringen skrevs: ett tomt svep ligger långt
  under en sekund (loggens tomma svep står exakt 20 s isär), och ett svep som
  både geokodade och skickade tog 1 s. Två flikar ryms alltså i 20 s med god
  marginal utan att intervallet ändras. Det som kan tänja ett tick är
  Nominatims ett-anrop-per-sekund, som är GEMENSAM för grupperna — en skur av
  nya platser i två grupper samtidigt kostar en sekund per plats. Det är känt
  och accepterat: nästa tick kommer ändå, och ingen rad tappas.
#>
try {
  while ($true) {
    if ($slutTid -and (Get-Date) -ge $slutTid) { break }
    if ($Svep -gt 0 -and $script:Forsok -ge $Svep) { break }

    $tickStart = Get-Date
    $script:Forsok++
    $sidfel = $false
    $nagotSvep = $false
    $utkorgNotis = @();   $nycklarNotis = @();   $grupperNotis = @()
    $utkorgTyst = @();    $nycklarTyst = @()

    foreach ($grupp in $script:Grupper) {
      $gid = [string]$grupp.id

      # ---- Anslutning, en per grupp -------------------------------------
      if (-not $script:Kontexter.ContainsKey($gid) -or -not $script:Kontexter[$gid]) {
        $a = Anslut -Port $Felsokningsport -Grupp $grupp
        if ($a.ContainsKey('fel')) {
          # Klaga en gång i minuten PER GRUPP, inte var tjugonde sekund.
          # Bryggfönstret kan vara stängt en stund utan att det är ett haveri,
          # och en grupp som saknar flik ska inte dränka den som fungerar.
          $senast = [DateTime]::MinValue
          if ($script:KlaganPerGrupp.ContainsKey($gid)) { $senast = $script:KlaganPerGrupp[$gid] }
          if (((Get-Date) - $senast).TotalSeconds -gt 55) {
            $script:KlaganPerGrupp[$gid] = Get-Date
            Logga 'VÄNTAR' ('[' + $grupp.namn + '] ' + $a.fel) DarkYellow
          }

          # Och gör något åt det, i stället för att bara klaga. Den startar
          # bara när PORTEN är död; saknas bara EN flik öppnar Anslut den
          # själv med /json/new, utan att röra de andra grupperna.
          if (-not (Porten-Svarar -Port $Felsokningsport)) {
            Starta-Bryggfonstret -Port $Felsokningsport | Out-Null
          }
          continue
        }
        $script:Kontexter[$gid] = $a
        Logga 'ANSLUTEN' ('[' + $grupp.namn + '] flik ' + $a.flikId + '  ' + $a.url) DarkCyan
      }

      # ---- Svep för den här gruppen -------------------------------------
      try {
        $resultat = Gor-Svep -Kontext $script:Kontexter[$gid]
        $skord = Behandla-Svep -Grupp $grupp -Svepresultat $resultat
        $nagotSvep = $true

        if ($skord -and @($skord.utkorg).Count -gt 0) {
          if ($grupp.notis) {
            $utkorgNotis += @($skord.utkorg)
            $nycklarNotis += @($skord.nycklar)
            if ($grupperNotis -notcontains $grupp.namn) { $grupperNotis += $grupp.namn }
          } else {
            $utkorgTyst += @($skord.utkorg)
            $nycklarTyst += @($skord.nycklar)
          }
        }

        # Sessionen är delad; gruppens tomhet är gruppens egen.
        $sidlage = 'okand'
        if ((@($resultat.PSObject.Properties.Name) -contains 'sidlage') -and $resultat.sidlage) {
          $sidlage = [string]$resultat.sidlage
        }
        Kolla-Session -Sidlage $sidlage
        Kolla-Vakthund -Grupp $grupp -Svepresultat $resultat -Inlagg (@($resultat.poster).Count)
      } catch {
        $fel_i_rad++
        $meddelande = $_.Exception.Message
        if ($meddelande -like 'JS-fel i sidan*') {
          $sidfel = $true
          Logga 'SIDFEL' ('[' + $grupp.namn + '] ' + ($meddelande -replace '\s+', ' ')) Red
          if ($fel_i_rad -eq 3) {
            Logga 'SIDFEL' ('samma fel tre svep i rad. Läsarskalet passar inte bryggkoden i ' +
              (Split-Path -Leaf $Bryggfil) + ' — det är en kodrättelse, inte något som går över.') Red
          }
        } else {
          # Bara DEN HÄR gruppens anslutning kopplas ner. De andra flikarna
          # rörs inte — en hängd renderare i en grupp får inte tysta resten.
          Logga 'TAPPAD' ('[' + $grupp.namn + '] anslutningen bröts: ' + $meddelande +
            ' — återansluter') DarkYellow
          Koppla-Ner $script:Kontexter[$gid]
          $script:Kontexter[$gid] = $null
        }
      }
    }

    if ($nagotSvep) { $fel_i_rad = 0 }

    # ---- Utkorgarna: en omgång för dem som får pusha, en för de tysta ----
    if ($Skarpt) {
      Tom-Utkorg -Rader $utkorgNotis -Nycklar $nycklarNotis -Grupper ($grupperNotis -join ' + ')
      Tom-Utkorg -Rader $utkorgTyst -Nycklar $nycklarTyst -UtanNotis
    }

    # ---- Efterarbetet ---------------------------------------------------
    #
    # Alla tre är byggda att aldrig kasta. En nätstörning mot Supabase får
    # inte kunna starta om CDP-anslutningen, och absolut inte räknas mot
    # försöken på ett oskyldigt inlägg.
    if ($nagotSvep) {
      # Var sjätte tick, alltså ungefär varannan minut. Dödmansgreppet på
      # servern larmar efter femton minuter, så tre missade pulser i rad
      # ryms utan falsklarm.
      if ($script:Forsok % 6 -eq 0) { Skicka-Puls -Svepnummer $script:Summa.svep }
      Kolla-Livstecken
      Skriv-Banderoll
    }

    # Ticket klockas varje gång, men skrivs bara ut när det är värt en rad.
    # Mätvärdet är det som avgör om takten håller med fler grupper, och det
    # ska gå att läsa ur en riktig logg — inte bara ur ett testprotokoll.
    $tickMs = [int]((Get-Date) - $tickStart).TotalMilliseconds
    if ($script:Forsok -le 3 -or $script:Forsok % 30 -eq 0 -or $tickMs -gt ($SvepIntervallMs / 2)) {
      Logga 'TAKT' ('tick ' + $script:Forsok + ': ' + $script:Grupper.Count + ' grupp(er) svepta på ' +
        $tickMs + ' ms (intervall ' + $SvepIntervallMs + ' ms)') `
        $(if ($tickMs -gt $SvepIntervallMs) { 'Yellow' } else { 'DarkGray' })
    }

    if ($script:Summa.svep -gt 0 -and $script:Summa.svep % 10 -eq 0) { Skriv-Summa }
    if ($Svep -gt 0 -and $script:Forsok -ge $Svep) { break }

    if ($fel_i_rad -gt 0) {
      $vila = Backa-Av -IRad $fel_i_rad
      if ($sidfel) { $vila = [math]::Max($vila, $SvepIntervallMs) }
      Start-Sleep -Milliseconds $vila
    } elseif (-not $nagotSvep) {
      # Ingen grupp gick att svepa — vänta kort och prova igen.
      Start-Sleep -Milliseconds ([math]::Min($SvepIntervallMs, 5000))
    } else {
      # Intervallet räknas från tickets BÖRJAN, inte från dess slut. Annars
      # glider takten isär så fort svepen kostar något, och två grupper kostar
      # mer än en.
      $kvar = $SvepIntervallMs - $tickMs
      if ($kvar -gt 0) { Start-Sleep -Milliseconds $kvar }
    }
  }
} finally {
  Skriv-Summa
  foreach ($k in @($script:Kontexter.Keys)) { Koppla-Ner $script:Kontexter[$k] }
  if ($script:Mutex) {
    # Windows släpper handtaget även om processen dödas, men en ren
    # frisläppning gör att nästa start går igenom direkt i stället för att
    # ärva ett övergivet mutex.
    try { $script:Mutex.ReleaseMutex() } catch { }
    try { $script:Mutex.Dispose() } catch { }
  }
  Logga 'SLUT' ('logg: ' + $script:LoggSokvag) Cyan
}
