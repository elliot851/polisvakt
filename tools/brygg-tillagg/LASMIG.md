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

`--load-extension` går förbi båda. Chrome laddar mappen vid start, och
`world: "MAIN"` gör att koden kör i sidans egen värld — exakt som ett
användarskript, så `__polisvakt` finns i konsolen som vanligt.

## Kör

```
powershell -ExecutionPolicy Bypass -File tools\starta-bryggan.ps1
```

Startaren pekar ut den här mappen åt Chrome. Du behöver inte röra
`chrome://extensions`.

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

## Torrkörning

`dryRun: true` står i koden. Bryggan läser och loggar men skriver ingenting
till databasen. Vad den *hade* skickat ser du med `__polisvakt.stats()` i
konsolen på gruppsidan.
