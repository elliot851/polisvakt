# Polisvakt — lägg service_role-nyckeln på plats, och PROVA den innan du tror på den.
#
# VARFÖR DEN HÄR FILEN FINNS
#
# Notiskedjan är färdigbyggd och utrullad. Den saknar inte kod, den saknar ett
# VÄRDE. Två ställen behöver samma sträng:
#
#   1. DAEMONEN på den här maskinen, för att få skriva till fbmejl_ta_emot.
#      fbmejl_ta_emot är revokad från anon med flit — den skriver rapporter
#      och utlöser notiser — så anon-nyckeln i js/config.js duger inte.
#
#   2. VALVET i Supabase, under namnet service_role_key, för att databasen
#      ska kunna legitimera sig mot edge-funktionen fbmejl-push.
#      public.fbmejl_anropsnyckel() faller redan tillbaka på just det namnet
#      (supabase/fbmejl.sql), och fbmejl-push godtar redan
#      SUPABASE_SERVICE_ROLE_KEY (supabase/functions/fbmejl-push/index.ts).
#      Ingen kod behöver alltså ändras. Bara värdet ska in.
#
# Skriptet gör BÅDA åt dig. Du klistrar in nyckeln en enda gång, i din egen
# terminal, och den provas mot båda dörrarna innan skriptet tror på den.
# Valvet skrivs över PostgREST genom public.fbmejl_valv_satt — ingen resa in i
# dashboarden, och därmed inget andra tillfälle att klistra fel sträng av de
# två utgåvor dashboarden visar.
#
#
# DEN FÄLLA SOM KOSTAR EN HEL KVÄLL: TVÅ UTGÅVOR AV SAMMA BEHÖRIGHET
#
# Projektet har nya API-nycklar. Dashboarden visar då BÅDE en ny hemlig nyckel
# (sb_secret_...) OCH en äldre JWT (eyJ...). Båda kallas "service role", båda
# ser rätt ut, och plattformen injicerar EN av dem i funktionens
# SUPABASE_SERVICE_ROLE_KEY. Lägger man den andra i valvet svarar fbmejl-push
# 401 på varenda anrop — med en nyckel som ser fullständigt korrekt ut i båda
# ändarna.
#
# Därför frågar det här skriptet efter FLERA strängar och provar var och en mot
# TVÅ dörrar:
#
#   DÖRR A   PostgREST:  POST /rest/v1/rpc/fbmejl_ta_emot  {"p_rader":[]}
#            Svarar 200 -> nyckeln duger för DAEMONEN.
#
#   DÖRR B   Edge:       POST /functions/v1/fbmejl-push    {"dry":true}
#            Svarar 200 -> nyckeln duger för VALVET.
#
# Ofta är det samma sträng. Ibland är det inte det. Det här skriptet är enda
# stället där man får veta vilket, utan att gissa.
#
#
# VAD SKRIPTET ALDRIG GÖR
#
#   * Skriver aldrig ut en nyckel. Bara FORM (tre första tecken) och LÄNGD.
#     Tre tecken skiljer eyJ från sb_ — alltså den enda förväxling som
#     faktiskt inträffar — och räcker inte till någonting annat.
#   * Sparar aldrig en nyckel i repot. Repot är publikt och ligger dessutom i
#     OneDrive. Filen hamnar i %LOCALAPPDATA%\Polisvakt\nycklar.xml, krypterad
#     med DPAPI (Export-Clixml på en SecureString) — låst till DITT konto på
#     DEN HÄR maskinen. Kopieras filen till en annan dator går den inte att
#     läsa.
#   * Skriver valvet genom public.fbmejl_valv_satt, som bara service_role får
#     anropa och som vägrar varje annat namn än service_role_key.
#
#
# KÖR
#
#   powershell -ExecutionPolicy Bypass -File tools\satt-nyckel.ps1
#
#   Bara prova det som redan är sparat, utan att skriva om något:
#   powershell -ExecutionPolicy Bypass -File tools\satt-nyckel.ps1 -BaraProva

[CmdletBinding()]
param(
  # Tom = läs ur tools\fb-bridge.user.js, samma väg som daemonen.
  [string]$SupabaseUrl,

  # Prova nyckeln som redan ligger i nycklar.xml. Frågar inte efter någon ny.
  [switch]$BaraProva,

  # Ta nyckeln ur urklipp i stället för att fråga efter den.
  #
  # VARFÖR DEN FINNS: inklistringen var momentet som gick sönder, om och om
  # igen. Urklipp rymmer en sträng i taget, och att kopiera KOMMANDOT som
  # startar skriptet skriver över nyckeln man nyss kopierade. Klistrar man
  # sedan in vid fel prompt hamnar hela hemligheten i klartext i fönstret och
  # i kommandohistoriken — precis det man försökte undvika.
  #
  # Med den här flaggan finns ingen inklistring alls: nyckeln kopieras i
  # dashboarden, skriptet startas UTAN att röra urklipp (Satt-nyckel.cmd på
  # skrivbordet), och skriptet hämtar den själv. Den skrivs aldrig ut.
  [switch]$FranUrklipp,

  # Var den krypterade filen hamnar. Bara för test.
  [string]$Nyckelfil
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch { }

function Skriv {
  param([string]$Text, [System.ConsoleColor]$Farg = [System.ConsoleColor]::Gray)
  Write-Host $Text -ForegroundColor $Farg
}

# =====================================================================
#  Var ligger projektet?
# =====================================================================

if (-not $SupabaseUrl) {
  $bryggfil = Join-Path $PSScriptRoot 'fb-bridge.user.js'
  if (-not (Test-Path $bryggfil)) {
    throw "Hittar varken -SupabaseUrl eller $bryggfil. Ange adressen med -SupabaseUrl."
  }
  $kalla = [System.IO.File]::ReadAllText($bryggfil, [System.Text.Encoding]::UTF8)
  $m = [regex]::Match($kalla, "supabaseUrl\s*:\s*'([^']+)'")
  if (-not $m.Success) { throw "Hittar inte supabaseUrl i $bryggfil." }
  $SupabaseUrl = $m.Groups[1].Value
}
$SupabaseUrl = $SupabaseUrl.TrimEnd('/')

$DataMapp = Join-Path $env:LOCALAPPDATA 'Polisvakt'
if (-not (Test-Path $DataMapp)) { New-Item -ItemType Directory -Force -Path $DataMapp | Out-Null }
if (-not $Nyckelfil) { $Nyckelfil = Join-Path $DataMapp 'nycklar.xml' }

Skriv ''
Skriv '  Polisvakt — service_role-nyckeln' Cyan
Skriv ('  projekt: ' + $SupabaseUrl) DarkGray
Skriv ('  sparas i: ' + $Nyckelfil) DarkGray
Skriv ''

# =====================================================================
#  Hjälpare: en klartextsträng ur en SecureString, och tillbaka igen
# =====================================================================
#
# Klartexten lever bara så länge anropet till dörren pågår, och nollställs
# sedan med ZeroFreeBSTR. Det är inte vattentätt — .NET-strängar går inte att
# radera säkert — men skillnaden mot att slänga runt en vanlig sträng är att
# den aldrig hamnar i en variabel som blir kvar i sessionen.

function Klartext {
  param([System.Security.SecureString]$Hemlig)
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Hemlig)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Form {
  param([string]$S)
  if (-not $S) { return 'ingen' }
  if ($S.Length -lt 3) { return $S }
  return $S.Substring(0, 3)
}

# =====================================================================
#  Dörrarna
# =====================================================================
#
# Invoke-RestMethod KASTAR på allt som inte är 2xx i Windows PowerShell, och
# statuskoden ligger då i undantagets Response. Utan den här inpackningen blir
# 401 och "nätet är nere" samma sak i utskriften — och det är precis den
# skillnaden man behöver se här.

function Anropa {
  param([string]$Url, [string]$Nyckel, [string]$Kropp, [switch]$MedApikey)

  $huvuden = @{ 'Authorization' = 'Bearer ' + $Nyckel }
  if ($MedApikey) { $huvuden['apikey'] = $Nyckel }

  try {
    $svar = Invoke-WebRequest -Uri $Url -Method Post -TimeoutSec 25 `
      -ContentType 'application/json' -Headers $huvuden -Body $Kropp -UseBasicParsing
    return @{ status = [int]$svar.StatusCode; kropp = [string]$svar.Content; fel = $null }
  } catch {
    $status = 0
    $kroppen = ''
    $r = $null
    try { $r = $_.Exception.Response } catch { }
    if ($r) {
      try { $status = [int]$r.StatusCode } catch { }
      try {
        $st = $r.GetResponseStream()
        $las = New-Object System.IO.StreamReader($st)
        $kroppen = $las.ReadToEnd()
        $las.Dispose()
      } catch { }
    }
    return @{ status = $status; kropp = $kroppen; fel = $_.Exception.Message }
  }
}

function Prova-DorrA {
  param([string]$Nyckel)
  # Tom lista. fbmejl_ta_emot skriver ingenting på noll rader — provet kostar
  # alltså inte en rad i databasen och kan köras hur många gånger som helst.
  $r = Anropa -Url ($SupabaseUrl + '/rest/v1/rpc/fbmejl_ta_emot') -Nyckel $Nyckel `
    -Kropp '{"p_rader":[]}' -MedApikey
  $r['dorr'] = 'A (PostgREST / fbmejl_ta_emot)'
  if ($r.status -eq 200) { $r['ok'] = $true; $r['dom'] = 'godkänd' }
  elseif ($r.status -eq 401) { $r['ok'] = $false; $r['dom'] = '401 — inte en giltig nyckel för PostgREST' }
  elseif ($r.status -eq 404) { $r['ok'] = $false; $r['dom'] = '404 — fbmejl_ta_emot finns inte. Migrationen är inte körd.' }
  elseif ($r.status -eq 403) { $r['ok'] = $false; $r['dom'] = '403 — nyckeln är giltig men saknar rätt att köra fbmejl_ta_emot' }
  elseif ($r.status -eq 0)   { $r['ok'] = $false; $r['dom'] = 'inget svar — nät eller adress: ' + $r.fel }
  else { $r['ok'] = $false; $r['dom'] = 'HTTP ' + $r.status }
  return $r
}

function Prova-DorrB {
  param([string]$Nyckel)
  # {"dry":true} returnerar INNAN någon push skickas. Ingen telefon piper.
  #
  # VIKTIGT ATT VETA VAD PROVET INTE BEVISAR: i index.ts ligger dry-svaret
  # efter nyckelkontrollen och efter hämtningen av mottagare, men FÖRE
  # importVapidKeys. Grön dörr B bevisar alltså nyckel, databas och
  # mottagarantal — men INTE att VAPID-nycklarna går att tolka. En
  # felformaterad VAPID_KEYS ger grön dörr B och tyst telefon. Det enda som
  # bevisar sista milen är ett riktigt utskick; se veckolivstecknet i
  # tools\brygg-daemon.ps1.
  $r = Anropa -Url ($SupabaseUrl + '/functions/v1/fbmejl-push') -Nyckel $Nyckel -Kropp '{"dry":true}'
  $r['dorr'] = 'B (edge / fbmejl-push)'
  if ($r.status -eq 200) {
    $r['ok'] = $true
    $mott = '?'
    try {
      $j = $r.kropp | ConvertFrom-Json
      if ($null -ne $j.mottagare) { $mott = [string]$j.mottagare }
    } catch { }
    $r['dom'] = 'godkänd, mottagare=' + $mott
    if ($mott -eq '0') { $r['dom'] += '  (INGEN lyssnar — slå på gruppnotiser, se docs\notiskedjan.md steg 5)' }
  }
  elseif ($r.status -eq 401) { $r['ok'] = $false; $r['dom'] = '401 Nekad — FEL UTGÅVA av nyckeln. Prova den andra strängen.' }
  elseif ($r.status -eq 404) { $r['ok'] = $false; $r['dom'] = '404 — fbmejl-push är inte utrullad på det här projektet' }
  elseif ($r.status -eq 500) {
    $r['ok'] = $false
    if ($r.kropp -match 'inte konfigurerad') {
      $r['dom'] = '500 "Servern är inte konfigurerad" — VAPID_KEYS eller SUPABASE_URL saknas i funktionens miljö. ANNAT FEL än nyckeln.'
    } else {
      $r['dom'] = '500 — ' + (($r.kropp -replace '\s+', ' ')).Trim()
    }
  }
  elseif ($r.status -eq 0)   { $r['ok'] = $false; $r['dom'] = 'inget svar — nät eller adress: ' + $r.fel }
  else { $r['ok'] = $false; $r['dom'] = 'HTTP ' + $r.status + ' ' + (($r.kropp -replace '\s+', ' ')).Trim() }
  return $r
}

# =====================================================================
#  Kandidaterna
# =====================================================================

$kandidater = @()

if ($BaraProva) {
  if (-not (Test-Path $Nyckelfil)) {
    Skriv "Det finns ingen sparad nyckel i $Nyckelfil." Red
    Skriv 'Kör skriptet utan -BaraProva för att lägga in en.' Yellow
    exit 1
  }
  $sparad = Import-Clixml -Path $Nyckelfil
  $kandidater += ,@{ namn = 'sparad'; hemlig = $sparad.service_role }
} else {
  Skriv 'Hämta nyckeln i Supabase Dashboard:' White
  Skriv '  Project Settings -> API Keys -> service_role  (klicka Reveal, kopiera)' DarkGray
  Skriv ''
  Skriv 'Visar dashboarden TVÅ service role-nycklar — en sb_secret_... och en eyJ...' Yellow
  Skriv '— klistra in BÅDA, en i taget. Skriptet talar om vilken som duger var.' Yellow
  Skriv ''
  # Den redan sparade nyckeln räknas med som kandidat.
  #
  # De två utgåvorna öppnar VAR SIN dörr på det här projektet: eyJ-nyckeln
  # godtas av PostgREST (dörr A) och sb_secret av edge-funktionen (dörr B).
  # Valvskrivningen behöver båda i SAMMA körning — den legitimerar sig med
  # A-vinnaren och lagrar B-vinnarens värde.
  #
  # Utan den här raden blev det en omöjlig uppgift för användaren: urklipp
  # rymmer en sträng i taget, och skriptet stod och väntade på nyckel 2 medan
  # den andra strängen låg kvar i en webbläsare. Nu bär körningen med sig det
  # som redan är sparat, och det räcker att klistra in DEN SOM SAKNAS.
  if (Test-Path $Nyckelfil) {
    try {
      $sparad = Import-Clixml -Path $Nyckelfil
      if ($sparad.service_role) {
        $kandidater += ,@{ namn = 'sparad'; hemlig = $sparad.service_role }
        Skriv 'Den redan sparade nyckeln provas också — du behöver bara klistra in den som saknas.' Green
        Skriv ''
      }
    } catch {
      Skriv ('Kunde inte läsa ' + $Nyckelfil + ' — den provas inte. ' + $_.Exception.Message) DarkYellow
      Skriv ''
    }
  }

  # Nyckeln ur urklipp — ingen inklistring, ingen prompt.
  #
  # Läses in i en SecureString direkt och nollställs sedan ur urklipp, så att
  # nästa kopiering inte råkar bära med sig en servernyckel. Värdet skrivs
  # aldrig ut; bara form och längd, precis som för de inskrivna kandidaterna.
  if ($FranUrklipp) {
    $urklipp = $null
    try { $urklipp = Get-Clipboard -Raw -ErrorAction Stop } catch { }
    $urklipp = if ($urklipp) { $urklipp.Trim() } else { '' }

    if (-not $urklipp) {
      Skriv 'Urklipp är tomt. Kopiera nyckeln i Supabase och kör igen.' Red
      exit 1
    }
    # En hel rad kommandotext i urklipp är det vanligaste misstaget här: man
    # kopierade kommandot som startar skriptet i stället för nyckeln. Säg det
    # rakt ut i stället för att prova en uppenbar icke-nyckel mot servern.
    if ($urklipp -match '\s' -or $urklipp.Length -lt 20) {
      Skriv ('Det i urklipp ser inte ut som en nyckel (' + $urklipp.Length +
             ' tecken' + $(if ($urklipp -match '\s') { ', innehåller mellanslag' } else { '' }) + ').') Red
      Skriv 'Kopierade du kommandot i stället för nyckeln? Kopiera nyckeln i Supabase och kör igen.' Yellow
      $urklipp = $null
      exit 1
    }

    $s = New-Object System.Security.SecureString
    foreach ($tecken in $urklipp.ToCharArray()) { $s.AppendChar($tecken) }
    $s.MakeReadOnly()
    $kandidater += ,@{ namn = 'urklipp'; hemlig = $s }

    Skriv ('Nyckeln hämtad ur urklipp (' + (Form $urklipp) + '..., ' + $urklipp.Length + ' tecken).') Green
    # Töm urklipp så att en servernyckel inte ligger kvar och väntar på att
    # klistras in någon annanstans.
    try { Set-Clipboard -Value ' ' } catch { }
    $urklipp = $null
    Skriv 'Urklipp tömt.' DarkGray
    Skriv ''
  }
  else {

  Skriv 'Klistra in en nyckel och tryck Enter. Tom rad = klar.' White
  Skriv '(Inmatningen syns inte medan du skriver. Det är meningen.)' DarkGray
  Skriv ''

  for ($i = 1; $i -le 5; $i++) {
    $s = Read-Host -Prompt ('  nyckel ' + $i) -AsSecureString
    if (-not $s -or $s.Length -eq 0) { break }
    $kandidater += ,@{ namn = ('nyckel ' + $i); hemlig = $s }
  }

  }  # slut på else — frågevägen

  if ($kandidater.Count -eq 0) {
    Skriv ''
    Skriv 'Ingen nyckel angiven. Ingenting ändrat.' Yellow
    exit 1
  }
}

# =====================================================================
#  Provet
# =====================================================================

Skriv ''
Skriv '  Provar varje nyckel mot båda dörrarna...' Cyan
Skriv ''

$rader = @()
$vinnareA = $null
$vinnareB = $null

foreach ($k in $kandidater) {
  $klar = Klartext -Hemlig $k.hemlig
  $form = Form $klar
  $langd = $klar.Length

  $a = Prova-DorrA -Nyckel $klar
  $b = Prova-DorrB -Nyckel $klar

  if ($a.ok -and -not $vinnareA) { $vinnareA = $k }
  if ($b.ok -and -not $vinnareB) { $vinnareB = $k }

  $rader += ,@{
    namn = $k.namn; form = $form; langd = $langd
    a_ok = $a.ok; a_dom = $a.dom
    b_ok = $b.ok; b_dom = $b.dom
  }

  # Klartexten slängs. Den finns kvar i .NET:s stränghög tills sophämtningen
  # tar den, men ingen variabel pekar på den längre.
  $klar = $null
}

Skriv ('  {0,-10} {1,-7} {2,-6} {3,-8} {4}' -f 'kandidat', 'form', 'längd', 'dörr', 'utfall') White
Skriv ('  ' + ('-' * 74)) DarkGray
foreach ($r in $rader) {
  Skriv ('  {0,-10} {1,-7} {2,-6} {3,-8} {4}' -f $r.namn, ($r.form + '...'), $r.langd, 'A', $r.a_dom) `
    $(if ($r.a_ok) { 'Green' } else { 'Red' })
  Skriv ('  {0,-10} {1,-7} {2,-6} {3,-8} {4}' -f '', '', '', 'B', $r.b_dom) `
    $(if ($r.b_ok) { 'Green' } else { 'Red' })
}
Skriv ''

# =====================================================================
#  Spara den som klarade dörr A
# =====================================================================

if ($vinnareA) {
  if ($BaraProva) {
    Skriv '  DAEMONEN: den sparade nyckeln duger. Ingenting skrivet om.' Green
  } else {
    # Export-Clixml på en SecureString krypterar med DPAPI: låst till det här
    # Windows-kontot på den här maskinen. Filen ligger utanför repot och
    # utanför OneDrive med flit.
    # BÅDA nycklarna sparas, och det är inte en dubbellagring av samma sak.
    #
    # På ett projekt med de nya API-nycklarna öppnar de var sin dörr:
    #   service_role  eyJ-nyckeln  -> PostgREST (fbmejl_ta_emot, valvet)
    #   edge          sb_secret    -> edge-funktionen fbmejl-push
    #
    # Daemonen behöver båda. Rapporter skrivs över PostgREST, men driftnotiser
    # och veckans livstecken ringer fbmejl-push DIREKT — och gjorde det med
    # PostgREST-nyckeln, vilket gav 401 på en kedja som fungerade. Bevisligen:
    # "DRIFT-FEL kunde inte skicka Polisvakt: kedjan lever ... (401)" medan
    # startproben på raden ovanför sa GRÖN databasen.
    #
    # Fältet heter 'edge' och inte 'service_role_2' för att namnet ska säga
    # VART nyckeln går, inte i vilken ordning den hittades.
    $attSpara = @{ service_role = $vinnareA.hemlig; satt = (Get-Date).ToString('s') }
    if ($vinnareB) { $attSpara['edge'] = $vinnareB.hemlig }
    $attSpara | Export-Clixml -Path $Nyckelfil -Force
    Skriv ('  DAEMONEN: sparad i ' + $Nyckelfil + ' (DPAPI, låst till ditt konto på den här maskinen).') Green
  }
} else {
  Skriv '  DAEMONEN: INGEN av nycklarna kom igenom dörr A.' Red
  Skriv '  Utan den kan daemonen inte skriva rapporter, och den VÄGRAR starta skarpt.' Red
  Skriv '  Vanligaste orsaken: du kopierade anon/publishable-nyckeln, inte service_role.' Yellow
}

Skriv ''

if ($vinnareB) {
  # ===================================================================
  #  VALVET — skriptet lägger in nyckeln självt
  #
  #  Fram till nu stod här en instruktion: gå till dashboarden, Project
  #  Settings, Vault, Add new secret, klistra, spara, kom tillbaka. Fem klick
  #  för att flytta en sträng som skriptet redan hade i minnet — och ett andra
  #  tillfälle att klistra FEL sträng av de två dashboarden visar. Ett sådant
  #  fel ger 401 på en nyckel som ser alldeles rätt ut, och det syns först den
  #  dag en polisrapport inte blir en notis.
  #
  #  Nu skrivs den in över PostgREST i stället, genom public.fbmejl_valv_satt
  #  (supabase/migrationer/2026-08-21-valvet-satts-av-skriptet.sql). Den
  #  funktionen är grantad till service_role och ingen annan, och vägrar varje
  #  annat namn än service_role_key.
  #
  #  TVÅ OLIKA NYCKLAR I SAMMA ANROP, och det är med flit:
  #    legitimation = $vinnareA  — den PostgREST godtar som service_role
  #    värdet       = $vinnareB  — den edge-funktionen faktiskt godtar
  #  Dashboarden visar två utgåvor, och det är inte givet att samma sträng
  #  duger på båda ställena. Provet ovan har redan avgjort vilken som är vilken.
  # ===================================================================
  if ($BaraProva) {
    Skriv '  VALVET: nyckeln duger mot edge-funktionen. Ingenting skrivet om (-BaraProva).' Green
  }
  elseif (-not $vinnareA) {
    Skriv '  VALVET: kan inte skrivas — ingen nyckel kom igenom dörr A.' Red
    Skriv '  Skrivningen sker över PostgREST och kräver en nyckel PostgREST godtar' Yellow
    Skriv '  som service_role. Läs dörr A-domen ovan först.' Yellow
  }
  else {
    $ka = Klartext -Hemlig $vinnareA.hemlig
    $kb = Klartext -Hemlig $vinnareB.hemlig

    # ConvertTo-Json på ett hashtable, inte stränghopslagning. En nyckel som
    # innehåller ett citattecken eller ett omvänt snedstreck skulle annars
    # bryta sönder kroppen och ge ett obegripligt 400.
    $kropp = @{ p_namn = 'service_role_key'; p_varde = $kb } | ConvertTo-Json -Compress

    # -MedApikey är inte valfritt mot PostgREST. Supabase-grinden kräver
    # apikey-huvudet och svarar 401 utan det — ett 401 som ser ut som en
    # nekad nyckel fast nyckeln är alldeles riktig. Samma flagga används av
    # Prova-DorrA av exakt samma skäl.
    $v = Anropa -Url ($SupabaseUrl + '/rest/v1/rpc/fbmejl_valv_satt') -Nyckel $ka -Kropp $kropp -MedApikey

    $ka = $null
    $kb = $null
    $kropp = $null

    if ($v.status -eq 200) {
      $svar = $null
      try { $svar = $v.kropp | ConvertFrom-Json } catch { }

      if ($svar -and $svar.klar) {
        $vad = if ($svar.ersatte) { 'ersatt' } else { 'inlagd' }
        Skriv ('  VALVET: nyckeln ' + $vad + ' som service_role_key (form ' +
               $svar.form + ', längd ' + $svar.langd + ').') Green
        Skriv '  Läst tillbaka genom samma väg som notiskedjan använder. Inget klistrande kvar.' DarkGray
      }
      elseif ($svar -and $svar.fel) {
        Skriv ('  VALVET: funktionen vägrade — ' + $svar.fel) Red
        if ($svar.varfor) { Skriv ('  ' + $svar.varfor) Yellow }
      }
      else {
        Skriv '  VALVET: oväntat svar. Kontrollera för hand i SQL Editor:' Red
        Skriv '    select public.fbmejl_notis_konfig();' White
      }
    }
    elseif ($v.status -eq 404) {
      Skriv '  VALVET: public.fbmejl_valv_satt finns inte i databasen än.' Red
      Skriv '  Kör den här filen i SQL Editor, sedan skriptet igen:' Yellow
      Skriv '    supabase\migrationer\2026-08-21-valvet-satts-av-skriptet.sql' White
      Skriv ''
      Skriv '  Tills dess går det för hand: Dashboard -> Project Settings -> Vault' DarkGray
      Skriv '    Name: service_role_key      <- exakt så, små bokstäver' DarkGray
    }
    else {
      Skriv ('  VALVET: skrivningen misslyckades — HTTP ' + $v.status) Red
      if ($v.kropp) { Skriv ('  ' + (($v.kropp -replace '\s+', ' ')).Trim()) DarkGray }
    }
  }

  Skriv ''
  Skriv '  Kontrollera när som helst, utan att se värdet:' DarkGray
  Skriv '    select public.fbmejl_notis_konfig();' White
  Skriv '  Ska ge klar:true och nyckel_kalla:"service_role_key/valv".' DarkGray
  Skriv ''
  Skriv '  STÅR DET "fbmejl_anropsnyckel/valv" i stället: en gammal hemlighet med det' Red
  Skriv '  namnet ligger kvar i valvet och VINNER över service_role_key. Ta bort den.' Red
} else {
  Skriv '  VALVET: INGEN av nycklarna kom igenom dörr B.' Red
  Skriv '  Läs domen på raderna ovan — 401 och 500 betyder helt olika saker:' Yellow
  Skriv '    401 Nekad                        fel utgåva av nyckeln, prova den andra' DarkGray
  Skriv '    500 Servern är inte konfigurerad  VAPID saknas i funktionen, inte ett nyckelfel' DarkGray
  Skriv '    404                               fbmejl-push är inte utrullad' DarkGray
}

Skriv ''
if ($vinnareA -and $vinnareB) {
  Skriv '  Klart — inget mer att klistra. Starta om bryggan så tar den nyckeln:' Cyan
  Skriv '    .\tools\polisvakt-brygga.ps1 -Installera' Cyan
  exit 0
}
exit 1
