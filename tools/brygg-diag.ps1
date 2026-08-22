# Diagnos: vad går sönder när Schemaläggaren startar bryggan?
#
# Startad från Schemaläggaren skrev daemonen ingen logg alls — inte ens sin
# egen STARTrad — samtidigt som processen levde och drog CPU. Den här filen
# gör exakt de fyra sakerna daemonen gör INNAN sin första loggrad, en i taget,
# och skriver resultatet med rå .NET-IO till en fil som ingen annan rör.
#
# Varje steg skrivs FÖRE det utförs. Hänger något är det steget efter den
# sista raden i filen som hänger — det är hela poängen med ordningen.

$ut = Join-Path $env:TEMP 'polisvakt-diag.txt'
function Not($t) {
  [System.IO.File]::AppendAllText($ut, ((Get-Date -Format 'HH:mm:ss') + '  ' + $t + [Environment]::NewLine),
    (New-Object System.Text.UTF8Encoding($true)))
}

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
  $m = Join-Path $env:LOCALAPPDATA 'Polisvakt'
  if (-not (Test-Path $m)) { New-Item -ItemType Directory -Force -Path $m | Out-Null }
  $p = Join-Path $m 'brygg-diag-prov.txt'
  [System.IO.File]::AppendAllText($p, 'prov ' + (Get-Date -Format 's') + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($true)))
  Not ('  ok, skrev ' + $p + ' (' + (Get-Item $p).Length + ' byte)')
} catch { Not ('  kastade: ' + $_.Exception.GetType().Name + ' — ' + $_.Exception.Message) }

Not 'steg 3: Write-Host'
try { Write-Host 'diag'; Not '  ok' } catch { Not ('  kastade: ' + $_.Exception.GetType().Name) }

Not 'steg 4: Global-mutex'
try {
  $ny = $false
  $mx = New-Object System.Threading.Mutex($true, 'Global\Polisvakt-Diag', [ref]$ny)
  Not ('  ok, nyskapad=' + $ny)
  try { $mx.ReleaseMutex() } catch { }
  $mx.Dispose()
} catch { Not ('  kastade: ' + $_.Exception.GetType().Name + ' — ' + $_.Exception.Message) }

Not 'steg 5: las fb-bridge.user.js'
try {
  $f = Join-Path $PSScriptRoot 'fb-bridge.user.js'
  $n = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8).Length
  Not ('  ok, ' + $n + ' tecken')
} catch { Not ('  kastade: ' + $_.Exception.GetType().Name) }

Not 'klar'
