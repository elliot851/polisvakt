# Injicerar bryggan i det redan inloggade Chrome-fönstret via felsökningsporten.
#
# VARFÖR
#
# Fyra installationsvägar är uttömda: Tampermonkeys installationssida ligger
# på chrome-extension:// där automation är blockerad, --load-extension är
# borttaget ur Chrome, ett manuellt inläst tillägg registreras men injicerar
# aldrig, och sidan själv får inte hämta kod (Facebooks CSP).
#
# Det som återstår, och som fungerar: Chrome Devtools Protocol. Kod som körs
# via Runtime.evaluate lyder inte under sidans CSP, och PowerShell kan läsa
# bryggfilen från disk och skicka den över WebSocket. Koden behöver alltså
# aldrig passera genom vare sig sidan eller ett tillägg.
#
#   .\brygg-injicera.ps1            injicera och visa vad bryggan ser
#   .\brygg-injicera.ps1 -Bevaka    stanna kvar och rapportera var 30:e sekund
#
# Bryggan står i torrkörning. Ingenting skrivs till databasen.

param(
  [int]$Port = 9222,
  [switch]$Bevaka,
  [int]$BevakaSekunder = 30
)

$ErrorActionPreference = 'Stop'
$bryggfil = Join-Path $PSScriptRoot 'fb-bridge.user.js'
if (-not (Test-Path $bryggfil)) { throw "Hittar inte $bryggfil" }

function Hamta-Flik {
  param([int]$Port)
  $svar = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec 8
  $mal = $svar.Content | ConvertFrom-Json
  $mal | Where-Object { $_.type -eq 'page' -and $_.url -like '*facebook.com/groups/*' } | Select-Object -First 1
}

# Egen liten CDP-klient. Ett anrop, ett svar, stäng. Enkelt är bättre än
# långlivat här: varje anrop är oberoende och kan inte lämna en halvdöd socket
# efter sig.
function Kor-Cdp {
  param([string]$Ws, [string]$Uttryck, [int]$TimeoutMs = 20000)

  $klient = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [Threading.CancellationToken]::None
  try {
    if (-not $klient.ConnectAsync([Uri]$Ws, $ct).Wait($TimeoutMs)) { throw 'CDP: anslutning tog for lang tid' }

    $begaran = @{
      id     = 1
      method = 'Runtime.evaluate'
      params = @{
        expression    = $Uttryck
        returnByValue = $true
        awaitPromise  = $true
      }
    } | ConvertTo-Json -Depth 8 -Compress

    $ut = [Text.Encoding]::UTF8.GetBytes($begaran)
    if (-not $klient.SendAsync([ArraySegment[byte]]::new($ut), 'Text', $true, $ct).Wait($TimeoutMs)) { throw 'CDP: sandning tog for lang tid' }

    # Svaret kan komma i flera ramar. Bygg ihop tills EndOfMessage.
    $buf = New-Object byte[] 262144
    $sb = New-Object Text.StringBuilder
    do {
      $r = $klient.ReceiveAsync([ArraySegment[byte]]::new($buf), $ct)
      if (-not $r.Wait($TimeoutMs)) { throw 'CDP: svar tog for lang tid' }
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Result.Count))
    } while (-not $r.Result.EndOfMessage)

    $j = $sb.ToString() | ConvertFrom-Json
    if ($j.result.exceptionDetails) {
      return @{ fel = $j.result.exceptionDetails.exception.description }
    }
    return @{ varde = $j.result.result.value }
  }
  finally { $klient.Dispose() }
}

$flik = Hamta-Flik -Port $Port
if (-not $flik) {
  Write-Host 'Hittar ingen gruppflik pa felsokningsporten.' -ForegroundColor Red
  Write-Host 'Starta bryggan forst:  .\tools\polisvakt-brygga.ps1'
  exit 1
}
Write-Host "Flik: $($flik.url)"

# Redan injicerad? Da hoppar vi over, annars far vi tva uppsattningar timers.
$koll = Kor-Cdp -Ws $flik.webSocketDebuggerUrl -Uttryck 'typeof window.__polisvakt'
if ($koll.varde -eq 'object') {
  Write-Host 'Bryggan kor redan i fliken.' -ForegroundColor Green
} else {
  $kalla = [IO.File]::ReadAllText($bryggfil)
  Write-Host "Injicerar $($kalla.Length) tecken..."
  $svar = Kor-Cdp -Ws $flik.webSocketDebuggerUrl -Uttryck $kalla
  if ($svar.fel) { Write-Host "INJEKTIONSFEL: $($svar.fel)" -ForegroundColor Red; exit 1 }
  Start-Sleep -Seconds 6
  $koll2 = Kor-Cdp -Ws $flik.webSocketDebuggerUrl -Uttryck 'typeof window.__polisvakt'
  if ($koll2.varde -ne 'object') {
    Write-Host "Bryggan satte aldrig __polisvakt. Typ: $($koll2.varde)" -ForegroundColor Red
    exit 1
  }
  Write-Host 'Bryggan ar injicerad och igang.' -ForegroundColor Green
}

$rapport = @'
(() => {
  const p = window.__polisvakt;
  if (!p) return JSON.stringify({ fel: 'bryggan saknas' });
  const inlagg = (p.peek ? p.peek() : []).map(x => ({
    text: (x.text || '').replace(/\s+/g, ' ').slice(0, 90),
    id: x.id || null,
    alder: x.postedAt ? Math.round((Date.now() - x.postedAt) / 60000) + ' min' : 'OLASLIG'
  }));
  return JSON.stringify({ stats: p.stats ? p.stats() : null, antal: inlagg.length, inlagg }, null, 1);
})()
'@

function Visa-Rapport {
  param($Flik)
  $r = Kor-Cdp -Ws $Flik.webSocketDebuggerUrl -Uttryck $rapport
  if ($r.fel) { Write-Host "FEL: $($r.fel)" -ForegroundColor Red; return }
  Write-Host ''
  Write-Host "--- $(Get-Date -Format 'HH:mm:ss') ---" -ForegroundColor Cyan
  Write-Host $r.varde
}

Visa-Rapport -Flik $flik

if ($Bevaka) {
  Write-Host ''
  Write-Host "Bevakar var $BevakaSekunder sekund. Ctrl+C for att sluta." -ForegroundColor Yellow
  while ($true) {
    Start-Sleep -Seconds $BevakaSekunder
    $f = Hamta-Flik -Port $Port
    if (-not $f) { Write-Host 'Gruppfliken ar borta.' -ForegroundColor Red; break }
    # Sidan kan ha laddats om; injicera i sa fall igen.
    $k = Kor-Cdp -Ws $f.webSocketDebuggerUrl -Uttryck 'typeof window.__polisvakt'
    if ($k.varde -ne 'object') {
      Write-Host 'Sidan laddades om. Injicerar igen...' -ForegroundColor Yellow
      $kalla = [IO.File]::ReadAllText($bryggfil)
      Kor-Cdp -Ws $f.webSocketDebuggerUrl -Uttryck $kalla | Out-Null
      Start-Sleep -Seconds 6
    }
    Visa-Rapport -Flik $f
  }
}
