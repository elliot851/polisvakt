# Liten lokal webbserver för att testa Polisvakt.
#
# Appen består av ES-moduler och en service worker. Båda kräver http:// —
# öppnar man index.html direkt från filsystemet blockerar webbläsaren dem.
# Den här servern använder .NET som redan finns i Windows, så inget behöver
# installeras.
#
#   Kör:            .\serve.ps1
#   Annan port:     .\serve.ps1 -Port 8090
#   Nå från mobil:  .\serve.ps1 -Lan     (kräver att du startar PowerShell som administratör)

param(
  [int]$Port = 8080,
  [switch]$Lan
)

$root = $PSScriptRoot
$prefix = if ($Lan) { "http://+:$Port/" } else { "http://localhost:$Port/" }

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.webm' = 'video/webm'
  '.mp4'  = 'video/mp4'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Host "Kunde inte starta pa $prefix" -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($Lan) { Write-Host "Kor PowerShell som administrator for -Lan." -ForegroundColor Yellow }
  exit 1
}

Write-Host ""
Write-Host "  Polisvakt kor pa $prefix" -ForegroundColor Green
if ($Lan) {
  $ips = Get-NetIPAddress -AddressFamily IPv4 |
         Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' }
  foreach ($ip in $ips) { Write-Host "  Fran mobilen:  http://$($ip.IPAddress):$Port/" -ForegroundColor Cyan }
  Write-Host ""
  Write-Host "  OBS: GPS, mikrofon och kamera kraver https i webblasaren." -ForegroundColor Yellow
  Write-Host "  Over vanlig http fungerar de bara pa localhost. Lagg appen pa" -ForegroundColor Yellow
  Write-Host "  Netlify eller Vercel for att testa i mobilen pa riktigt." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Ctrl+C for att stoppa." -ForegroundColor DarkGray
Write-Host ""

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch { break }

  $req = $ctx.Request
  $res = $ctx.Response

  try {
    # Chrome skickar en forfragan i forvag innan en sida pa internet far
    # hamta nagot fran datorn (Private Network Access). Svarar vi inte pa
    # den hanger anropet. Anvands for att mata in SQL i Supabase-editorn.
    if ($req.HttpMethod -eq 'OPTIONS') {
      $res.Headers.Add('Access-Control-Allow-Origin', '*')
      $res.Headers.Add('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      $res.Headers.Add('Access-Control-Allow-Headers', '*')
      $res.Headers.Add('Access-Control-Allow-Private-Network', 'true')
      $res.Headers.Add('Access-Control-Max-Age', '600')
      $res.StatusCode = 204
      $res.Close(); continue
    }

    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }

    $path = Join-Path $root $rel
    if (Test-Path $path -PathType Container) { $path = Join-Path $path 'index.html' }

    # Slapp inte ut nagot utanfor projektmappen
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root))) {
      $res.StatusCode = 403; $res.Close(); continue
    }

    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.Headers.Add('Service-Worker-Allowed', '/')
      # Lokal utvecklingsserver: tillat att filer hamtas fran andra sidor.
      # Anvands for att mata in SQL i Supabase-editorn utan att klistra.
      $res.Headers.Add('Access-Control-Allow-Origin', '*')
      $res.Headers.Add('Access-Control-Allow-Private-Network', 'true')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host ("  200  " + $rel) -ForegroundColor DarkGray
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - hittades inte: $rel")
      $res.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host ("  404  " + $rel) -ForegroundColor DarkYellow
    }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.Close()
  }
}

$listener.Stop()
