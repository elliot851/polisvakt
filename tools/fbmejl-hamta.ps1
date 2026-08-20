<#
.SYNOPSIS
  Läser Facebooks gruppnotismejl ur postlådan över IMAP och lägger dem i
  Polisvakts kö i Supabase.

.DESCRIPTION
  Tredje vägen in från Facebook-gruppen "Här står polisen", och den enda som
  inte kräver att någon annan människa vill något. Facebook skickar själv ett
  mejl när det kommer ett nytt inlägg i en grupp man följer. Det här skriptet
  läser ägarens EGEN postlåda, hos ägarens egen leverantör, och skickar det
  vidare till ägarens egen databas. Ingen inloggning kringgås, ingenting
  skrapas, ingen tredje part behöver vilja något.

  Skriptet TOLKAR INGENTING. Det läser rubriker och brödtext, och lägger
  råtexten i kön (public.fbmejl_ko). Tolkningen görs i js/fbmejl.js, som
  anropar samma js/parser.js som rösten och knapparna — och som därmed äger
  nykterhetsfiltret. Att låta PowerShell leta efter ordet "polis" hade gett en
  andra ordlista, och en av dem hade varit produktregel nummer ett. Det får
  aldrig hända. Se supabase/fbmejl.sql och docs/fbmejl.md.

  IMAP talas direkt över TcpClient + SslStream. Inga moduler, inget att
  installera, ingen NuGet — samma hållning som resten av tools/.

.PARAMETER Server
  IMAP-server. Standard imap.strato.de (Strato). Kan även sättas i
  hemlighetsfilen.

.PARAMETER Port
  IMAP-port för implicit TLS. Standard 993.

.PARAMETER Anvandare
  Postlådans användarnamn, oftast hela mejladressen.

.PARAMETER Brevlada
  Vilken mapp som läses. Standard INBOX.

.PARAMETER Hemligheter
  Sökväg till json-filen med lösenord och nycklar. Standard
  tools\fbmejl.hemligheter.json. Filen MÅSTE vara gitignorerad — skriptet
  vägrar köra om den inte är det.

.PARAMETER Intervall
  Sekunder mellan varje pollning när -Loop används. Standard 30.

.PARAMETER Loop
  Kör om och om igen istället för en gång. Används av Uppgiftsschemaläggaren
  bara om du hellre vill ha en process som ligger kvar än ett schemalagt
  anrop varje minut.

.PARAMETER Torrkor
  Läs mejlen och visa vad som hade skickats, men rör inte databasen. Flyttar
  inte heller fram UID:t. Kör alltid det här först.

.PARAMETER Fran
  Läs om från ett visst UID istället för där förra körningen slutade. Med 0
  läses hela brevlådan om. Avdubblingen i databasen gör det ofarligt, bara
  långsamt.

.PARAMETER Spara
  Skriv de råa mejlen till en mapp som .eml-filer. Det här är verktyget för
  att VERIFIERA FORMATET — se docs/fbmejl.md. Kör det en gång, öppna filerna,
  och rätta mönstren i js/fbmejl.js efter vad som faktiskt står i dem.

.EXAMPLE
  .\tools\fbmejl-hamta.ps1 -Torrkor
  Läser de senaste mejlen och visar vad som hade lagts i kön. Rör ingenting.

.EXAMPLE
  .\tools\fbmejl-hamta.ps1 -Fran 0 -Spara .\fbmejl-prov -Torrkor
  Sparar hela brevlådan som .eml-filer att granska formatet mot.

.EXAMPLE
  .\tools\fbmejl-hamta.ps1
  En pollning. Det här är det Uppgiftsschemaläggaren ska köra varje minut.

.NOTES
  Windows PowerShell 5.1. Inga externa moduler.

  LÖSENORD OCH NYCKLAR STÅR ALDRIG I DEN HÄR FILEN. De läses ur
  miljövariabler eller ur en gitignorerad json-fil. Repot är publikt.
#>

[CmdletBinding()]
param(
  [string]$Server,
  [int]$Port = 993,
  [string]$Anvandare,
  [string]$Brevlada = 'INBOX',
  [string]$Hemligheter,
  [int]$Intervall = 30,
  [switch]$Loop,
  [switch]$Torrkor,
  [int]$Fran = -1,
  [string]$Spara
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path $PSScriptRoot -Parent
if (-not $Hemligheter) { $Hemligheter = Join-Path $PSScriptRoot 'fbmejl.hemligheter.json' }

function Skriv-Rad {
  param([string]$Text, [string]$Farg = 'Gray')
  Write-Host $Text -ForegroundColor $Farg
}

# =====================================================================
#  HEMLIGHETER
# =====================================================================
#
#  Tre saker behövs och ingen av dem får någonsin hamna i git:
#
#    IMAP-lösenordet         läser hela postlådan
#    service_role-nyckeln    skriver förbi radsäkerheten i Supabase
#    projektets URL          harmlös, men hör ihop med nyckeln
#
#  Miljövariabler först, fil sedan. Miljövariabler är bättre för ett
#  schemalagt jobb — de finns bara i processen och följer inte med om mappen
#  synkas till OneDrive, vilket den här mappen faktiskt gör.
#
#  Sätt dem så här, en gång, i ett PowerShell-fönster som administratör:
#
#    [Environment]::SetEnvironmentVariable('PV_IMAP_LOSEN',   'xxx', 'User')
#    [Environment]::SetEnvironmentVariable('PV_IMAP_ANVANDARE','polisvakt@dindoman.se', 'User')
#    [Environment]::SetEnvironmentVariable('PV_SUPABASE_URL', 'https://xxx.supabase.co', 'User')
#    [Environment]::SetEnvironmentVariable('PV_SUPABASE_SERVICE_KEY', 'eyJ...', 'User')
#
#  Vill du hellre ha en fil, se docs/fbmejl.md för formatet — och lägg till
#  raden i .gitignore INNAN du skapar den.

function Las-Hemligheter {
  param([string]$Fil)

  $ut = @{
    Server    = $env:PV_IMAP_SERVER
    Anvandare = $env:PV_IMAP_ANVANDARE
    Losen     = $env:PV_IMAP_LOSEN
    SupaUrl   = $env:PV_SUPABASE_URL
    SupaKey   = $env:PV_SUPABASE_SERVICE_KEY
    Grupp     = $env:PV_FB_GRUPP
  }

  if (Test-Path $Fil -PathType Leaf) {
    # En hemlighetsfil som råkar bli incheckad är ett läckt lösenord till en
    # postlåda och en nyckel som går förbi all radsäkerhet i databasen. Repot
    # är publikt. Alltså: vägra köra hellre än att lita på att någon kom ihåg.
    $ignorerad = $false
    try {
      & git -C $root check-ignore -q -- $Fil 2>$null
      $ignorerad = ($LASTEXITCODE -eq 0)
    } catch {
      # Inget git installerat, eller ingen repo. Då kan vi inte veta, och då
      # varnar vi istället för att stoppa.
      $ignorerad = $null
    }

    if ($ignorerad -eq $false) {
      Skriv-Rad ''
      Skriv-Rad "  STOPP: $Fil ar INTE gitignorerad." 'Red'
      Skriv-Rad '  Filen innehaller ett postlade-losenord och service_role-nyckeln.' 'Red'
      Skriv-Rad '  Repot ar publikt. Lagg till raden nedan i .gitignore och kor igen:' 'Yellow'
      Skriv-Rad ''
      Skriv-Rad '    tools/fbmejl.hemligheter.json' 'Cyan'
      Skriv-Rad ''
      throw 'Hemlighetsfilen ar inte gitignorerad.'
    }
    if ($null -eq $ignorerad) {
      Skriv-Rad '  Kunde inte kontrollera att hemlighetsfilen ar gitignorerad (git svarade inte).' 'DarkYellow'
    }

    $j = Get-Content -Path $Fil -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($n in @('Server', 'Anvandare', 'Losen', 'SupaUrl', 'SupaKey', 'Grupp')) {
      if (-not $ut[$n] -and $j.PSObject.Properties.Name -contains $n) { $ut[$n] = $j.$n }
    }
  }

  return $ut
}

# =====================================================================
#  IMAP
# =====================================================================
#
#  Vi talar protokollet rakt av. Det är tio kommandon totalt och det finns
#  inget bibliotek i Windows att luta sig mot.
#
#  Det som gör en enkel IMAP-klient trasig är nästan alltid samma två saker,
#  och båda hanteras nedan:
#
#    literals   servern svarar "* 12 FETCH (BODY[] {45213}" och skickar sedan
#               exakt 45213 bytes RÅTT, utan radbrytning på slutet. Läser man
#               rad för rad hamnar man ur synk och allt efter det blir skräp.
#
#    tags       varje kommando får en egen tagg, och svaret är slut först när
#               en rad börjar med den taggen. Allt annat är mellansvar. Läser
#               man bara en rad tror man att man är klar och skickar nästa
#               kommando in i ett halvläst svar.

class ImapKlient {
  [System.Net.Sockets.TcpClient]$Tcp
  [System.Net.Security.SslStream]$Strom
  [System.IO.StreamWriter]$Ut
  [int]$Nr = 0

  [void] Anslut([string]$Server, [int]$Port) {
    $this.Tcp = New-Object System.Net.Sockets.TcpClient
    $this.Tcp.ReceiveTimeout = 60000
    $this.Tcp.SendTimeout    = 60000
    $this.Tcp.Connect($Server, $Port)

    $this.Strom = New-Object System.Net.Security.SslStream($this.Tcp.GetStream(), $false)
    $this.Strom.AuthenticateAsClient($Server)
    $this.Strom.ReadTimeout  = 60000
    $this.Strom.WriteTimeout = 60000

    $this.Ut = New-Object System.IO.StreamWriter($this.Strom, [System.Text.Encoding]::ASCII)
    $this.Ut.AutoFlush = $true
    $this.LasRad() | Out-Null      # serverns halsning
  }

  # En rad, byte för byte fram till CRLF. Inte StreamReader: den buffrar, och
  # en buffrad byte är en byte som saknas när nasta literal ska läsas rått.
  [string] LasRad() {
    $bytes = New-Object System.Collections.Generic.List[byte]
    while ($true) {
      $b = $this.Strom.ReadByte()
      if ($b -lt 0) { break }
      if ($b -eq 10) { break }
      if ($b -ne 13) { $bytes.Add([byte]$b) }
    }
    return [System.Text.Encoding]::UTF8.GetString($bytes.ToArray())
  }

  [string] LasExakt([int]$Antal) {
    $buf = New-Object byte[] $Antal
    $lasta = 0
    while ($lasta -lt $Antal) {
      $n = $this.Strom.Read($buf, $lasta, $Antal - $lasta)
      if ($n -le 0) { break }
      $lasta += $n
    }
    # Mejl är i praktiken alltid ASCII på transportnivån (8bit förekommer,
    # men UTF-8-avkodning klarar båda och trasiga bytes blir ersättningstecken
    # istället för ett kastat undantag).
    return [System.Text.Encoding]::UTF8.GetString($buf, 0, $lasta)
  }

  # Skickar ett kommando och läser hela svaret. Returnerar raderna.
  [string[]] Kor([string]$Kommando) {
    $this.Nr++
    $tag = 'A{0:D4}' -f $this.Nr
    $this.Ut.Write("$tag $Kommando`r`n")

    $rader = New-Object System.Collections.Generic.List[string]
    while ($true) {
      $rad = $this.LasRad()
      if ($null -eq $rad) { break }

      # Literal: raden slutar på {N}. Läs exakt N bytes rått efter den.
      $m = [regex]::Match($rad, '\{(\d+)\}$')
      if ($m.Success) {
        $antal = [int]$m.Groups[1].Value
        $data = $this.LasExakt($antal)
        $rader.Add($rad)
        $rader.Add("`0LITERAL`0" + $data)
        continue
      }

      $rader.Add($rad)
      if ($rad.StartsWith("$tag ")) {
        if (-not ($rad -match "^$tag OK")) {
          throw "IMAP svarade: $rad  (pa kommandot: $($Kommando -replace 'LOGIN .*', 'LOGIN ***'))"
        }
        break
      }
    }
    return $rader.ToArray()
  }

  [void] Stang() {
    try { $this.Kor('LOGOUT') | Out-Null } catch {}
    try { $this.Strom.Dispose() } catch {}
    try { $this.Tcp.Close() } catch {}
  }
}

# IMAP kräver att specialtecken i strängar antingen escapas eller skickas som
# literal. Lösenord innehåller ofta både citattecken och bakstreck.
function Imap-Strang {
  param([string]$S)
  return '"' + ($S -replace '\\', '\\\\' -replace '"', '\"') + '"'
}

# =====================================================================
#  MIME
# =====================================================================

<#
  Avkodar =?UTF-8?Q?...?= och =?UTF-8?B?...?= i rubriker.

  Facebook skickar nästan garanterat ämnesraden kodad, eftersom den innehåller
  namn med å, ä och ö. Utan det här steget blir "Här står polisen" till
  "=?UTF-8?Q?H=C3=A4r_st=C3=A5r_polisen?=" och gruppfiltret hittar ingenting.
#>
function Avkoda-Rubrik {
  param([string]$Text)
  if (-not $Text) { return '' }

  # Två kodade ord i rad separerade av blanksteg ska sättas ihop utan
  # mellanrum. Det är RFC 2047 och det syns direkt om man missar det.
  $t = [regex]::Replace($Text, '\?=\s+=\?', '?==?')

  $matcher = [regex]::Matches($t, '=\?([^?]+)\?([QqBb])\?([^?]*)\?=')
  foreach ($m in $matcher) {
    $teckenupps = $m.Groups[1].Value
    $typ = $m.Groups[2].Value.ToUpper()
    $data = $m.Groups[3].Value
    $klar = $null
    try {
      $enc = [System.Text.Encoding]::GetEncoding($teckenupps)
      if ($typ -eq 'B') {
        $klar = $enc.GetString([Convert]::FromBase64String($data))
      } else {
        $bytes = New-Object System.Collections.Generic.List[byte]
        $i = 0
        while ($i -lt $data.Length) {
          $c = $data[$i]
          if ($c -eq '_') { $bytes.Add([byte]32); $i++ }
          elseif ($c -eq '=' -and $i + 2 -lt $data.Length) {
            $bytes.Add([Convert]::ToByte($data.Substring($i + 1, 2), 16)); $i += 3
          } else { $bytes.Add([byte][char]$c); $i++ }
        }
        $klar = $enc.GetString($bytes.ToArray())
      }
    } catch { $klar = $null }
    if ($null -ne $klar) { $t = $t.Replace($m.Value, $klar) }
  }
  return $t
}

<#
  Plockar ut ett rubrikvärde ur ett mejlhuvud, med fortsättningsrader.

  Rubriker får brytas över flera rader så länge fortsättningen börjar med
  blanksteg. Ett Message-ID som brutits på mitten och läses som en rad blir en
  avkortad nyckel — och en avkortad nyckel är en avdubbling som inte fungerar.
#>
function Rubrik {
  param([string]$Huvud, [string]$Namn)
  $rader = $Huvud -split "`r?`n"
  $traff = $null
  for ($i = 0; $i -lt $rader.Count; $i++) {
    if ($rader[$i] -imatch "^$([regex]::Escape($Namn))\s*:\s*(.*)$") {
      $traff = $Matches[1]
      $j = $i + 1
      while ($j -lt $rader.Count -and $rader[$j] -match '^[ \t]') {
        $traff += ' ' + $rader[$j].Trim()
        $j++
      }
      break
    }
  }
  return (Avkoda-Rubrik $traff).Trim()
}

<#
  Message-ID pa den KANONISKA formen: gemener, utan vinkelparenteser, trimmad.

  Det har ar ett KONTRAKT, inte en stadning, och det stod fel en gang.

  Pollaren skickade Message-ID ratt som det stod i mejlet, alltsa med
  vinkelparenteser: "<abc@facebookmail.com>". js/fbmejl.js normaliserar
  (normaliseraMessageId) och skickar tillbaka "abc@facebookmail.com". SQL:ens
  fem "update ... where message_id = ..." jamforde de tva formerna med
  varandra, traffade noll rader varje gang, och kon tomdes darfor aldrig.

  Kanonisk form ar den normaliserade. Den satts HAR, innan raden lamnar
  maskinen, sa att kon lagrar ratt form fran borjan. Samma tre steg i samma
  ordning som js/fbmejl.js normaliseraMessageId(): trimma, ta bort < och >,
  trimma igen, gor om till gemener, kapa vid 200 tecken.
#>
function Normalisera-MessageId {
  param([string]$Id)
  if (-not $Id) { return '' }
  $s = $Id.Trim()
  if ($s.StartsWith('<')) { $s = $s.Substring(1) }
  if ($s.EndsWith('>'))   { $s = $s.Substring(0, $s.Length - 1) }
  $s = $s.Trim().ToLowerInvariant()
  if ($s.Length -gt 200) { $s = $s.Substring(0, 200) }
  return $s
}

<#
  Quoted-printable -> lasbar text.

  Utan det har steget lagras rataxten som Facebook skickade den, och da hander
  tva saker: "V=C3=A4ster=C3=A5s" istallet for "Vasteras", och — vardre —
  lankarna ar brutna av mjuka radbrott (=CRLF) mitt i parametrarna. En
  skrubbning som slutar vid radbrottet lamnar halva mejladressen kvar:

    &n_m=3Delliot=
    %40exempel.se

  Avkodningen maste alltsa ske FORE skrubbningen, precis som i js/fbmejl.js
  (plockaInlagg: avkodaQuotedPrintable -> saneraLankar).

  Samma grind som js-sidan: bara om texten faktiskt SER ut som
  quoted-printable ror vi den. Ett vanligt inlagg som rakar innehalla "=" ska
  inte forstoras.
#>
function Avkoda-QuotedPrintable {
  param([string]$Text)
  if (-not $Text) { return $Text }
  if ($Text -notmatch '=\r?\n' -and $Text -notmatch '=[0-9A-Fa-f]{2}') { return $Text }

  $utan = [regex]::Replace($Text, '=\r?\n', '')
  $bytes = New-Object System.Collections.Generic.List[byte]
  $i = 0
  while ($i -lt $utan.Length) {
    $c = $utan[$i]
    if ($c -eq '=' -and ($i + 2) -lt $utan.Length -and
        [regex]::IsMatch($utan.Substring($i + 1, 2), '^[0-9A-Fa-f]{2}$')) {
      $bytes.Add([Convert]::ToByte($utan.Substring($i + 1, 2), 16))
      $i += 3
    } else {
      foreach ($b in [System.Text.Encoding]::UTF8.GetBytes([string]$c)) { $bytes.Add($b) }
      $i++
    }
  }
  return [System.Text.Encoding]::UTF8.GetString($bytes.ToArray())
}

<#
  Plockar ut den läsbara delen av brevet.

  Vi bryr oss inte om att bygga ett riktigt MIME-träd. js/fbmejl.js klarar
  både text och HTML, avkodar quoted-printable själv och kastar allt som ser
  ut som knappar och foten. Det den behöver av oss är råtexten, inte en
  perfekt sönderdelning.

  Tre saker görs ändå här:
    text/plain-delen föredras när den finns — den är kortare och renare.
    base64-kodade delar avkodas, för dem klarar js-sidan inte.
    quoted-printable avkodas, och det är ett INTEGRITETSKRAV, inte kosmetika:
      mjuka radbrott mitt i en länk gör att skrubbningen nedan slutar mitt i
      mottagarens mejladress och lämnar resten kvar. Se Avkoda-QuotedPrintable.
#>
function Plocka-Brodtext {
  param([string]$Rabrev)

  $delar = $Rabrev -split "`r?`n`r?`n", 2
  if ($delar.Count -lt 2) { return '' }
  $kropp = $delar[1]

  $granspunkt = [regex]::Match($delar[0], 'boundary\s*=\s*"?([^";\r\n]+)"?', 'IgnoreCase')
  if (-not $granspunkt.Success) {
    $kod = (Rubrik $delar[0] 'Content-Transfer-Encoding')
    if ($kod -match 'base64') {
      try { return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($kropp -replace '\s', ''))) } catch { return $kropp }
    }
    if ($kod -match 'quoted-printable') { return (Avkoda-QuotedPrintable $kropp) }
    # Ingen rubrik som sager nagot, men mjuka radbrott i texten. Samma grind
    # som js/fbmejl.js avkodaQuotedPrintable() anvander.
    if ($kropp -match '=\r?\n') { return (Avkoda-QuotedPrintable $kropp) }
    return $kropp
  }

  $grans = '--' + $granspunkt.Groups[1].Value
  $bitar = $kropp -split [regex]::Escape($grans)

  $text = ''
  $html = ''
  foreach ($bit in $bitar) {
    $bd = $bit -split "`r?`n`r?`n", 2
    if ($bd.Count -lt 2) { continue }
    $bhuvud = $bd[0]
    $bkropp = $bd[1]

    if ($bhuvud -imatch 'Content-Transfer-Encoding\s*:\s*base64') {
      try { $bkropp = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($bkropp -replace '\s', ''))) } catch {}
    } elseif ($bhuvud -imatch 'Content-Transfer-Encoding\s*:\s*quoted-printable' -or
              $bkropp -match '=\r?\n') {
      $bkropp = Avkoda-QuotedPrintable $bkropp
    }

    if ($bhuvud -imatch 'text/plain' -and -not $text) { $text = $bkropp }
    elseif ($bhuvud -imatch 'text/html' -and -not $html) { $html = $bkropp }
  }

  if ($text.Trim()) { return $text }
  if ($html.Trim()) { return $html }
  return $kropp
}

<#
  Skrubbar bort de känsliga parametrarna ur Facebooks länkar.

  Det här är ett integritetskrav, inte en städning, och det här ledet är det
  som räknas mest: det är sista stället texten finns kvar innan den lämnar
  ägarens egen maskin.

    n_m       innehåller MOTTAGARENS mejladress i klartext, procentkodad.
              Utan skrubbningen hamnar den i fbmejl_ko.brodtext hos Supabase
              och därmed i varje backup.
    notif_id  ger LÄSÅTKOMST till notisens innehåll utan lösenord.
    bcode     samma sorts kvitto.

  Sökvägen lämnas intakt, så grupp-id och inläggs-id går fortfarande att läsa
  ut. mid= lämnas också kvar — den är en dedupnyckel och avslöjar ingenting
  om mottagaren.

  Samma skrubbning görs en gång till i js/fbmejl.js (saneraLankar) och en
  tredje gång i fbmejl_ko_in(). Att den finns i tre exemplar är avsiktligt:
  till skillnad från nykterhetsfiltret kan en avvikelse här bara betyda att
  ett led skrubbar MER än ett annat, och det är ofarligt.

  MÖNSTRET STOD FÖR SNÄVT EN GÅNG, och det var det dyraste felet i bryggan.
  Det krävde ?, & , %3F eller %26 OMEDELBART före parameternamnet. Men
  Facebooks notismejl ÄR HTML-brev, och i giltig HTML skrivs en href med
  &amp; mellan parametrarna — tecknet före n_m är då ';' och ingenting
  matchade:

    &n_m=elliot%40exempel.se       skrubbades
    &amp;n_m=elliot%40exempel.se   skrubbades INTE

  Efter en vecka hade ägarens mejladress legat i klartext i varje rad i
  fbmejl_ko.brodtext och i varje databasbackup. Precis det avsnittet
  INTEGRITET säger aldrig får hända.

  [?&](?:amp;)* täcker &, &amp; och dubbelkodat &amp;amp;. Mjuka radbrott i
  värdet är också med, som andra försvarslinje — normalt är de redan borta,
  eftersom Plocka-Brodtext avkodar quoted-printable innan skrubbningen.
#>
function Sanera-Lankar {
  param([string]$Text)
  if (-not $Text) { return $Text }
  $t = $Text
  $sep = '([?&](?:amp;)*|&#0*38;|&#[xX]0*26;|%3F|%26|%253F|%2526)'
  $varde = '(?:=\r?\n|[^&\s"''<>])*'
  foreach ($p in @('n_m', 'notif_id', 'bcode', 'aref', 'nid')) {
    $t = [regex]::Replace($t, "$sep$p(?:=|%3D|%253D)$varde", "`$1$p=BORTTAGET",
                          [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  }
  return $t
}

# =====================================================================
#  SUPABASE
# =====================================================================

function Anropa-Rpc {
  param([hashtable]$H, [string]$Funktion, $Kropp)

  $url = "$($H.SupaUrl.TrimEnd('/'))/rest/v1/rpc/$Funktion"
  $json = $Kropp | ConvertTo-Json -Depth 8 -Compress

  $svar = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing `
            -Headers @{
              'apikey'        = $H.SupaKey
              'Authorization' = "Bearer $($H.SupaKey)"
              'Content-Type'  = 'application/json'
            } `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) `
            -TimeoutSec 60

  $text = [System.Text.Encoding]::UTF8.GetString($svar.RawContentStream.ToArray())
  if (-not $text) { return $null }
  try { return $text | ConvertFrom-Json } catch { return $text }
}

# =====================================================================
#  EN POLLNING
# =====================================================================

function Kor-Pollning {
  param([hashtable]$H)

  $klient = [ImapKlient]::new()
  $lagt = 0

  try {
    $klient.Anslut($H.Server, $Port)
    $klient.Kor("LOGIN $(Imap-Strang $H.Anvandare) $(Imap-Strang $H.Losen)") | Out-Null

    $valj = $klient.Kor("SELECT $(Imap-Strang $Brevlada)")
    $uidvalidity = 0
    foreach ($r in $valj) {
      if ($r -match 'UIDVALIDITY\s+(\d+)') { $uidvalidity = [int64]$Matches[1] }
    }

    # Var stod vi? Databasen äger svaret, inte en fil på disken — byter man
    # dator ska bryggan fortsätta där den var, inte läsa om hela inkorgen.
    $senaste = 0
    $sparadValidity = 0
    if ($Fran -ge 0) {
      $senaste = $Fran
      Skriv-Rad "  Laser om fran UID $senaste (angivet med -Fran)." 'DarkYellow'
    } elseif (-not $Torrkor -or $H.SupaUrl) {
      try {
        $lage = Anropa-Rpc -H $H -Funktion 'fbmejl_lage' -Kropp @{}
        if ($lage) {
          $senaste = [int64]$lage.senaste_uid
          $sparadValidity = [int64]$lage.uidvalidity
        }
      } catch {
        Skriv-Rad "  Kunde inte lasa lage fran databasen: $($_.Exception.Message)" 'DarkYellow'
      }
    }

    # UIDVALIDITY har ändrats = postlådan har byggts om och UID börjar om från
    # ett. Ett sparat UID på 4711 skulle då hoppa över allt nytt för alltid.
    if ($sparadValidity -ne 0 -and $uidvalidity -ne 0 -and $sparadValidity -ne $uidvalidity) {
      Skriv-Rad "  UIDVALIDITY andrad ($sparadValidity -> $uidvalidity). Laser om fran borjan." 'Yellow'
      $senaste = 0
    }

    # Bara mejl från Facebook. Filtret sitter på servern så vi inte drar hem
    # hela inkorgen — men det är INTE säkerheten: From går att förfalska, och
    # det riktiga skyddet är DKIM/SPF hos leverantören plus en postlåda som
    # inte används till något annat. Se docs/fbmejl.md.
    #
    # Sök på DOMÄNEN, aldrig på hela adressen. Facebook använder VERP och
    # lokaldelen är slumpad per mottagare — riktiga avsändare ser ut som
    # notification+meynbxsa@facebookmail.com. En sökning på
    # "notification@facebookmail.com" hade gett noll träffar för alltid, och
    # felet hade sett ut som att Facebook inte skickar några mejl.
    $sok = "UID SEARCH UID $([int64]$senaste + 1):* FROM `"facebookmail.com`""
    $svar = $klient.Kor($sok)

    $uids = @()
    foreach ($r in $svar) {
      if ($r -match '^\*\s+SEARCH\s*(.*)$') {
        $uids = ($Matches[1].Trim() -split '\s+') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int64]$_ }
      }
    }
    # "UID n:*" ger alltid minst det högsta UID:t tillbaka, även när det redan
    # är läst. Filtrera bort det som ligger på eller under vattenmärket.
    $uids = @($uids | Where-Object { $_ -gt $senaste } | Sort-Object)

    if ($uids.Count -eq 0) {
      Skriv-Rad "  Inga nya mejl (star pa UID $senaste)." 'DarkGray'
      if (-not $Torrkor) {
        Anropa-Rpc -H $H -Funktion 'fbmejl_satt_lage' `
          -Kropp @{ p_uidvalidity = $uidvalidity; p_uid = $senaste; p_fel = $null } | Out-Null
      }
      return 0
    }

    Skriv-Rad "  $($uids.Count) nya mejl (UID $($uids[0])-$($uids[-1]))." 'Cyan'

    # Ta högst 50 åt gången. En inkorg som legat och samlat i en vecka ska
    # inte försöka gå igenom på en gång och timeouta mitt i — nästa körning
    # tar resten om en halv minut.
    if ($uids.Count -gt 50) { $uids = $uids[0..49] }

    $paket = New-Object System.Collections.Generic.List[object]
    $hogsta = $senaste

    foreach ($uid in $uids) {
      $rader = $klient.Kor("UID FETCH $uid (BODY.PEEK[])")
      $ra = ''
      foreach ($r in $rader) {
        if ($r.StartsWith("`0LITERAL`0")) { $ra = $r.Substring(9); break }
      }
      if (-not $ra) { $hogsta = [Math]::Max($hogsta, $uid); continue }

      if ($Spara) {
        # OBS: den här filen sparas OSKRUBBAD, med flit — den finns för att du
        # ska kunna se exakt vad Facebook skickar. Den innehåller därför din
        # egen mejladress (n_m=) och ett notif_id som ger läsåtkomst till
        # notisen. Lagg fbmejl-prov/ i .gitignore och radera mappen efterat.
        if (-not (Test-Path $Spara)) { New-Item -ItemType Directory -Path $Spara -Force | Out-Null }
        [System.IO.File]::WriteAllText((Join-Path $Spara "uid-$uid.eml"), $ra, [System.Text.Encoding]::UTF8)
      }

      $huvud = ($ra -split "`r?`n`r?`n", 2)[0]
      # KANONISK form direkt. Kon ska lagra samma strang som js/fbmejl.js
      # senare skickar tillbaka, annars traffar SQL:ens update noll rader och
      # kon tomms aldrig. Se Normalisera-MessageId.
      $mid = Normalisera-MessageId (Rubrik $huvud 'Message-ID')
      if (-not $mid) { $mid = "uid-$uid@lokal.polisvakt" }

      $datum = Rubrik $huvud 'Date'
      $iso = $null
      if ($datum) {
        try { $iso = ([datetimeoffset]::Parse($datum)).ToUniversalTime().ToString('o') } catch {}
      }
      if (-not $iso) { $iso = (Get-Date).ToUniversalTime().ToString('o') }

      $brod = Plocka-Brodtext $ra
      # Kapa. Ett Facebook-mejl i HTML kan vara hundra kilobyte boilerplate,
      # och inlägget står alltid i början. Databasen kapar också, men att
      # skicka 100 kB per mejl över nätet varje minut är onödigt.
      if ($brod.Length -gt 20000) { $brod = $brod.Substring(0, 20000) }

      # Avsändaren: From i första hand, Return-Path i andra. De är samma sak i
      # äkta Facebook-mejl (From == Return-Path == Errors-To), och Return-Path
      # är den enda som överlever vissa vidarebefordringar.
      #
      # Reply-To läses ALDRIG. Den är noreply@facebookmail.com i varje mejl —
      # en kontroll mot den hade sett likadant ut för alla avsändare och
      # därmed inte kontrollerat någonting.
      $fran = Rubrik $huvud 'From'
      if (-not $fran) { $fran = Rubrik $huvud 'Return-Path' }

      $paket.Add([ordered]@{
        message_id = $mid
        from       = $fran
        subject    = (Sanera-Lankar (Rubrik $huvud 'Subject'))
        body       = (Sanera-Lankar $brod)
        date       = $iso
        uid        = $uid
      })

      $hogsta = [Math]::Max($hogsta, $uid)
    }

    if ($Torrkor) {
      Skriv-Rad ''
      Skriv-Rad "  TORRKORNING - ingenting skickas till databasen." 'Yellow'
      foreach ($p in $paket) {
        Skriv-Rad ''
        Skriv-Rad "  UID $($p.uid)  $($p.date)" 'DarkGray'
        Skriv-Rad "  Fran:  $($p.from)"
        Skriv-Rad "  Amne:  $($p.subject)"
        $forsta = ($p.body -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 6) -join ' | '
        Skriv-Rad "  Text:  $($forsta.Substring(0, [Math]::Min(300, $forsta.Length)))" 'DarkGray'
      }
      Skriv-Rad ''
      return $paket.Count
    }

    $svar = Anropa-Rpc -H $H -Funktion 'fbmejl_ko_in' -Kropp @{ p_mejl = $paket.ToArray() }
    if ($svar) {
      Skriv-Rad ("  Kon: nya {0}, dubbletter {1}, vagrade {2}, ogiltiga {3}" -f `
                 $svar.nya, $svar.dubbletter, $svar.vagrade, $svar.ogiltiga) 'Green'
      $lagt = [int]$svar.nya
    }

    # Vattenmärket flyttas fram OAVSETT vad som hände med mejlen. Ett mejl som
    # inte gick att tolka ska inte spelas om i evighet och blockera allt som
    # kom efter det — kön och avdubblingen i databasen är det som skyddar mot
    # dubbletter, inte det här talet.
    Anropa-Rpc -H $H -Funktion 'fbmejl_satt_lage' `
      -Kropp @{ p_uidvalidity = $uidvalidity; p_uid = $hogsta; p_fel = $null } | Out-Null

  } finally {
    $klient.Stang()
  }

  return $lagt
}

# =====================================================================
#  HUVUDPROGRAM
# =====================================================================

$H = Las-Hemligheter -Fil $Hemligheter
if ($Server)    { $H.Server = $Server }
if ($Anvandare) { $H.Anvandare = $Anvandare }
if (-not $H.Server) { $H.Server = 'imap.strato.de' }

$saknas = @()
if (-not $H.Anvandare) { $saknas += 'PV_IMAP_ANVANDARE' }
if (-not $H.Losen)     { $saknas += 'PV_IMAP_LOSEN' }
if (-not $Torrkor) {
  if (-not $H.SupaUrl) { $saknas += 'PV_SUPABASE_URL' }
  if (-not $H.SupaKey) { $saknas += 'PV_SUPABASE_SERVICE_KEY' }
}

if ($saknas.Count -gt 0) {
  Skriv-Rad ''
  Skriv-Rad "  Saknar: $($saknas -join ', ')" 'Red'
  Skriv-Rad "  Satt dem som miljovariabler eller i $Hemligheter." 'Yellow'
  Skriv-Rad '  Se docs/fbmejl.md. Ingenting av detta far sta i repot.' 'Yellow'
  Skriv-Rad ''
  exit 1
}

Skriv-Rad ''
Skriv-Rad "  Polisvakt - mejlbryggan" 'Green'
Skriv-Rad "  $($H.Anvandare) @ $($H.Server):$Port / $Brevlada" 'DarkGray'
if ($Torrkor) { Skriv-Rad '  Torrkorning: databasen ror vi inte.' 'Yellow' }
Skriv-Rad ''

if (-not $Loop) {
  try {
    Kor-Pollning -H $H | Out-Null
  } catch {
    Skriv-Rad "  FEL: $($_.Exception.Message)" 'Red'
    # Felet skrivs till databasen så fbmejl_halsa kan svara på frågan "varfor
    # kommer det inget?" utan att någon behover leta i en logg pa en dator som
    # kanske star avstangd.
    if (-not $Torrkor -and $H.SupaUrl -and $H.SupaKey) {
      try {
        Anropa-Rpc -H $H -Funktion 'fbmejl_satt_lage' `
          -Kropp @{ p_uidvalidity = 0; p_uid = 0; p_fel = $_.Exception.Message } | Out-Null
      } catch {}
    }
    exit 1
  }
  exit 0
}

# Loopläget. Backar av vid fel istället för att hamra vidare: en postlåda som
# svarar 'too many connections' blir inte gladare av fler försök.
$fel = 0
while ($true) {
  try {
    Kor-Pollning -H $H | Out-Null
    $fel = 0
  } catch {
    $fel++
    Skriv-Rad "  FEL ($fel): $($_.Exception.Message)" 'Red'
    if (-not $Torrkor -and $H.SupaUrl -and $H.SupaKey) {
      try {
        Anropa-Rpc -H $H -Funktion 'fbmejl_satt_lage' `
          -Kropp @{ p_uidvalidity = 0; p_uid = 0; p_fel = $_.Exception.Message } | Out-Null
      } catch {}
    }
  }

  $vanta = if ($fel -gt 0) { [Math]::Min($Intervall * [Math]::Pow(2, [Math]::Min($fel, 5)), 900) } else { $Intervall }
  Start-Sleep -Seconds ([int]$vanta)
}
