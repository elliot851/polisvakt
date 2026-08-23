# Bryggan som Chrome-tillägg

Samma kod som `tools/fb-bridge.user.js`, men paketerad så att Chrome laddar
den själv. **Tampermonkey behövs inte.**

## Varför den här mappen finns

Tampermonkey-vägen fastnade på två spärrar som ingen av oss kunde ta oss
förbi på distans:

1. Installationssidan ligger på `chrome-extension://`, där Chrome blockerar
   all automation. Den kräver ett mänskligt klick, med flit — ett skript ska
   inte kunna installera sig självt.
2. Chrome kräver sedan en extra växel, *Tillåt användarskript*, som är av
   som förval. Utan den installeras skriptet men körs aldrig, helt tyst.

Ett vanligt tillägg går förbi båda. `world: "MAIN"` gör att koden kör i
sidans egen värld — exakt som ett användarskript, så `__polisvakt` finns i
konsolen som vanligt.

## Installera en gång

Chrome tog bort `--load-extension` av säkerhetsskäl — uppmätt på Chrome 151:
tillägget laddades inte, `window.__polisvakt` fanns inte. Det går alltså inte
längre att ladda ett tillägg från kommandoraden.

Installera i stället en gång, tre klick:

1. Öppna `chrome://extensions`
2. Slå på **Utvecklarläge** uppe till höger
3. **Läs in okomprimerat** → välj mappen `tools\brygg-tillagg`

Efter det ligger tillägget kvar och laddas vid varje start. Ingen
Tampermonkey, ingen `.user.js`-fångst, ingen växel för användarskript.


## Startaren

```
powershell -ExecutionPolicy Bypass -File tools\starta-bryggan.ps1
```

Den installerar ingenting — det gjorde den innan Chrome tog bort flaggan.
Kvar gör den nytta för flaggorna mot timer-strypning, som håller svepet på
tjugo sekunder i stället för sextio när fönstret ligger i bakgrunden.

## Hålls synkad för hand

`brygga.js` är en **kopia** av `tools/fb-bridge.user.js`. Ändras originalet
måste kopian uppdateras:

```
copy tools\fb-bridge.user.js tools\brygg-tillagg\brygga.js
```

Kopia och inte symlänk, eftersom Chrome läser mappen som den ser ut på disk
och symlänkar beter sig olika på Windows beroende på rättigheter. Testerna
i `fb-bryggan-test.html` körs mot originalet — kör dem efter varje kopiering
så att de två inte glider isär.

**Glidningen kan inte längre bli tyst.** `tools\brygg-daemon.ps1` jämför vid
start läsdelen i de två filerna och VÄGRAR STARTA om de skiljer sig, med
kommandot ovan i felmeddelandet. Det står här för att det hände: när
ordmatchningen breddades 2026-08-22 uppdaterades originalet men inte kopian,
och eftersom det är kopian Chrome kör försvann inläggen precis som förut i den
fil som står närmast flödet. "Samma kod som originalet" i en text är inte
samma sak som samma kod på disk.

## Torrkörning

`dryRun: true` står i koden. Bryggan läser och loggar men skriver ingenting
till databasen. Vad den *hade* skickat ser du med `__polisvakt.stats()` i
konsolen på gruppsidan.
