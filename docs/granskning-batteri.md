# Granskning: vad Polisvakt kostar i batteri

Frågan ingen ställt förrän nu: **vad kostar appen i batteri, och vad händer när
skärmen slocknar eller appen hamnar i bakgrunden?**

Det avgör om appen går att ha på under en hel resa. En varningsapp som föraren
stänger av för att telefonen blir varm och tom varnar för ingenting — samma
resonemang som roadmapen har om att en app man glömmer starta är värdelös.

Mätsidan finns i `batteri-test.html`. Kör den med `.\serve.ps1` och öppna
`/batteri-test.html`. Den tar knappt tre minuter och lämnar allt maskinläsbart
i `window.__resultat`.

---

## 0. Vad som är uppmätt och vad som är uppskattat

**Uppmätt** (i den här granskningen, på en Windows-dator i Chrome):

* Vilka `setInterval` som finns, var de registreras och hur ofta de faktiskt
  fyrar. Fil och radnummer är lästa ur anropsstacken vid registreringen, inte
  ur en lista skriven för hand.
* Hur mycket huvudtrådsarbete varje timer utför, i millisekunder per minut.
* Nätverksanrop per minut per ändpunkt (`PerformanceObserver`, typ `resource`).
* Långa uppgifter över 50 ms (`PerformanceObserver`, typ `longtask`).
* Vilka moduler som pausar sig själva när fliken döljs — avläst genom att
  modulen anropar `clearInterval`, vilket är det enda hårda beviset.
* Vad webbläsaren gör med timers i en verkligt dold flik.
* Kostnaden i ritloopen och i skyltläsarens bildbehandling, genom att tidta
  appens riktiga kod på en syntetisk bild.

**Går inte att mäta härifrån, och står därför som uppskattat:**

* Milliampere. Det finns ingen webb-API som mäter det. `navigator.getBattery()`
  ger laddningsnivå i hela procent på en dator som dessutom satt i väggen
  (uppmätt förändring under hela mätningen: 0 %).
* Radion, GPS-mottagaren, skärmens bakgrundsbelysning och videokodningen i
  hårdvara. Alla fyra kostar batteri utan att synas som en enda millisekund på
  huvudtråden, och de tre första är i praktiken de dyraste posterna på en
  telefon.
* Överförda byte. Supabase skickar inget `Timing-Allow-Origin`, så
  `transferSize` rapporteras som noll för varje anrop. Anropen räknas i
  stället — och det är ändå uppvaknandet, inte storleken, som väcker modemet.
* GPS i drift. Datorn har ingen GPS; `watchPosition` gav felkod 1 och noll
  positioner. Att prenumerationen startas och med vilka inställningar är
  uppmätt; vad den kostar är det inte.
* Kartbrickor i drift. Kartan stod still eftersom ingen position kom in. I en
  rullande bil hämtas nya brickor kontinuerligt.
* Att `requestAnimationFrame` fryser när telefonens skärm slocknar. Det är
  dokumenterat beteende och hela skälet till att `dashcam.js` och `plate.js`
  valde timers framför rAF, men det gick inte att framkalla på skrivbordet:
  en iframe som togs ur uppritning fortsatte få ~8 000 rAF-anrop i minuten.

---

## 1. Fynden, dyrast först

### Fynd 1 — Skärmlåset. Största posten, och det syns inte i någon millisekund

**Uppmätt:** appen begär `wakeLock.request('screen')` direkt vid uppstart,
från `js/app.js:3740`. Under en enda mätning på tre minuter kom **sex**
begäranden: två från `app.js:3740` och fyra från `app.js:3743`.

`settings.keepAwake` har `true` som förvalt värde (`js/app.js:62`). Föraren
behöver alltså inte välja något — skärmen hålls tänd så fort appen öppnas.

**Varför det är största posten:** skärmen är den överlägset dyraste delen i en
telefon. En 6-tums OLED på medelljus drar i storleksordningen 0,6–1,0 W, och en
telefon i en bilhållare i solljus tvingas upp mot maxljus, 1,5–2,5 W. Ingen
annan post i den här granskningen kommer i närheten. (Uppskattat — se avsnitt 0.)

**Bonusfynd i samma funktion:** `requestWakeLock()` registrerar en ny
`visibilitychange`-lyssnare varje gång den anropas (`js/app.js:3741`), och tar
aldrig bort någon. Funktionen anropas både vid uppstart (`app.js:235`) och
varje gång inställningen slås om (`app.js:2814`). Det är därför mätningen såg
fyra utlösningar från `app.js:3743` — lyssnarna staplas. Samma mönster finns i
`dashcam.js:919`, men där städas det upp i `#releaseWakeLock` (`dashcam.js:930`).

**Åtgärd:**
1. Flytta `visibilitychange`-lyssnaren ut ur `requestWakeLock()` så den
   registreras en gång, och avregistrera i `releaseWakeLock()`.
2. Inför ett mörkt körläge: efter en tid utan beröring, släck ner gränssnittet
   till nästan svart (behåll varningsbanderollen och rösten) och släpp
   skärmlåset. Varningarna hänger på GPS och ljud, inte på att skärmen lyser.
   Det är den enda ändringen i hela dokumentet som kan halvera förbrukningen.

---

### Fynd 2 — Dashcamens ritloop: 31 % av en processorkärna

**Uppmätt (syntetiskt, appens riktiga ritarbete):** att rita en bildruta på
1280 × 720 med tidsöverlägg, hastighet och bild-i-bild tar **10,2 ms** på den
här datorn. `js/dashcam.js:495` kör den loopen på `1000 / fps` millisekunder,
med 30 bilder i sekunden som standard.

30 × 10,2 ms = **18 400 ms huvudtrådsarbete per minut = 31 % av en kärna**, på
en stationär dator. På en telefon räkna med tre till fem gånger mer, alltså
att en kärna i praktiken går för fullt. Ovanpå det kommer kameran,
H.264-kodningen och skrivningen till IndexedDB, som inte mäts här.

Att ritloopen är en `setInterval` och inte en `requestAnimationFrame` är
medvetet och rätt — kommentaren på `dashcam.js:478` förklarar varför, och den
förklaringen håller. Men konsekvensen är att kostnaden inte försvinner när
skärmen slocknar. Det är hela poängen med en dashcam, och samtidigt hela
problemet.

**Åtgärd:**
1. Sänk standardvärdet för `fps` från 30 till 20. Det är en tredjedel mindre
   arbete och ingen ser skillnaden på en dashcamfilm.
2. När `mode === 'direct'` (kameraströmmen spelas in rakt av, se
   `dashcam.js:620`) behövs ingen ritloop alls. Stäng av den då — nu ritas
   canvasen även när ingen spelar in den.
3. Låt värmevakten sänka `fps` innan den sänker upplösningen. Bildfrekvens
   kostar linjärt; upplösning kostar kvadratiskt men syns mer.

---

### Fynd 3 — Skyltläsaren: ungefär en sekund av varje minut, utan kameran

**Uppmätt:** `hittaPlat` ur `js/plate.js` tar **1,11 ms** per sökning, och
`plate.js:879` kör den var 120:e millisekund → **554 ms/min**. `forbehandla`
tar **5,24 ms** per bild, och `plate.js:874` kör den var 700:e millisekund →
**449 ms/min**. Summa **ungefär 1 000 ms per minut** — och då är varken
kameraströmmen, videoavkodningen eller själva OCR-motorn medräknad. Den
tillkommer.

Dessutom kör `plate.js:875` en ren ritloop var 100:e millisekund (600
utlösningar per minut) enbart för att måla sökrutan.

**Åtgärd:**
1. Ritloopen på `plate.js:875` behöver inte gå 10 gånger i sekunden när
   sökningen bara ger ett nytt resultat 8,3 gånger i sekunden. Rita från
   `#sok` i stället och ta bort timern helt.
2. Sänk sökfrekvensen när ingen kandidat har synts på flera sekunder. Full
   takt behövs när något är på väg in i bild, inte när vägen är tom.

---

### Fynd 4 — `renderHazards` var tjugonde sekund, oavsett om någon tittar

**Uppmätt:** `js/app.js:237` — `setInterval(renderHazards, 20000)`. Uppmätt
takt 2,9–3,0 utlösningar per minut och **16–35 ms huvudtrådsarbete per minut**
över fyra körningar. Det är den enskilt dyraste timern i appen; alla övriga
tillsammans ligger under 5 ms/min.

Varje varv gör `renderHazards` (`app.js:1449`) tre tunga saker: kör hela
flödet genom kvalitetsgraderingen (`allHazards` på `app.js:1412`, som anropar
`Kvalitet.bedomFlodet`), ritar om alla kartmarkörer (`map.render`,
`js/map.js:222`) och bygger om hela listan i DOM:en med `innerHTML = ''`.

Timern har **ingen** koppling till `visibilitychange`. Den fyrade i full takt
i varenda mätfas — synlig, logiskt dold och ej uppritad.

Att bygga om en lista ingen tittar på, och att rita om kartmarkörer på en karta
som inte visas, är rent slöseri. Rapporterna kommer dessutom redan in via
`store`-händelsen `change` (`app.js:183`), så tjugosekunderstimern behövs bara
för att relativa tider ("för 3 min sedan") ska åldras.

**Åtgärd:**
1. Pausa timern när `document.visibilityState === 'hidden'`, och kör en gång
   direkt när fliken kommer fram igen.
2. Dela isär det som måste ske från det som bara är kosmetik: låt
   varningsmotorn (`engine.evaluate`, som körs på GPS-återanrop) vara ensam om
   varningarna, och låt tjugosekunderstimern bara uppdatera tidstexterna.
3. Rita inte om kartmarkörerna om varken positionen eller listan ändrats.

---

### Fynd 5 — Rapportpollningen väcker modemet varannan minut även i bakgrunden

**Uppmätt:** `js/store.js:141` — `setInterval(() => this.refresh(), 30000)`.
Uppmätt: 1,9 utlösningar per minut och **1,9 nätverksanrop per minut till
`supabase · reports_feed`**, oförändrat i den dolda fasen.

`store.start()` (`store.js:138`) registrerar visserligen en
`visibilitychange`-lyssnare, men den gör bara det motsatta av att pausa: den
hämtar en gång *extra* när fliken kommer fram (`store.js:143`). Timern rör den
aldrig.

Varje anrop väcker modemet och håller det vaket i flera sekunder efteråt,
oavsett hur få byte det gällde. Det är radion, inte processorn, som kostar
här.

**Jämför med `chatt.js`, som gör rätt:** `chatt.js:573–586` sätter
pollintervallet till noll när fliken är dold och anropar `clearInterval`.
Uppmätt: timern på `chatt.js:585` står som **avregistrerad** i den dolda fasen,
och anropen till `supabase · chatt_flode` gick från 1,0/min till **0**. Det är
exakt rätt beteende, och det är redan skrivet — i fel fil.

**Åtgärd:** kopiera `chatt.js:573–586` rakt av till `store.js`. Konkret: låt
`pollMs` returnera 0 när fliken är dold, avregistrera timern då, och hämta en
gång vid återkomst (det sista finns redan). Det som talar emot är att
rapporter ska nå fram medan man kör med släckt skärm — men det argumentet
faller på fynd 8: i en bakgrundsflik körs timern ändå inte i den takt någon
tror.

---

### Fynd 6 — Fem timers som går dygnet runt utan att någon behöver dem

Alla fem är uppmätta som levande och fyrande i varje fas, inklusive dold flik.
De kostar lite var för sig; poängen är att de aldrig tar paus.

| Rad | Intervall | Uppmätt /min | Vad den gör |
|---|---|---|---|
| `app.js:872` | 5 s | 12,6 | frågar värmevakten om den är aktiv — den är avstängd tills dashcamen startar |
| `app.js:804` | 10 s | 5,8 | vakthunden kollar synkstatus |
| `app.js:618` | 60 s | 1,0 | körvanor: är vi inne i ett inlärt fönster? |
| `app.js:238` | 60 s | 1,0 | ska betalväggen visas? |
| `app.js:239` | 120 s | 0,5 | statistik + omritning av statistikvyn |

`app.js:872` sticker ut: den vaknar 12 gånger i minuten enbart för att läsa av
`varmevakt.aktiv`, som är falskt så länge dashcamen står still. Den kostade
0–0,2 ms/min uppmätt, alltså nästan ingenting i arbete — men tolv uppvaknanden
i minuten hindrar processorn från att gå ner i djupt viloläge, och det syns
inte som millisekunder.

`app.js:239` är värst principiellt: statistik och topplista räknas om var
annan minut och vyn ritas om, oavsett om vyn ens är öppen.

**Åtgärd:**
1. `app.js:872`: starta timern i `dashcam`-händelsen `start` och stoppa den i
   `stop`, i stället för att låta den gå alltid. Kroppen kollar redan
   `varmevakt.aktiv` — flytta bara den kollen ut till livscykeln.
2. `app.js:238` och `app.js:239`: pausa vid `hidden`. Betalvägg och statistik
   har inget ärende i en dold flik.
3. `app.js:618` (körpåminnelsen) kollar redan `appFramme` i sin kropp
   (`app.js:622`). Låt den kolla `visibilityState` i livscykeln i stället, så
   slipper den vakna alls.
4. `app.js:804` (vakthunden) bör fortsätta — den bevakar att varningarna
   fungerar, och det är hela produkten. Lämna den.

---

### Fynd 7 — Rattknapparna stänger av webbläsarens energisparande helt

**Läst i koden, inte uppmätt** (kräver ett riktigt knapptryck för att aktiveras):
`js/remote.js:85–90` startar ett `Audio`-element med en tyst slinga och
`loop = true` för att kunna ta över mediakontrollerna i bilen.

En sida som spelar ljud räknas av webbläsaren som "audible" och undantas då
från all bakgrundsstrypning. Slår föraren på rattknapparna försvinner alltså
hela besparingen i fynd 8 — appen kör på full takt i bakgrunden, för alltid.

Det är förmodligen precis vad man vill ha under en resa. Men det är ett stort,
osynligt beslut som fattas av en knapp som heter något helt annat.

**Åtgärd:** skriv ut det i gränssnittet vid knappen ("håller appen igång i
bakgrunden — drar mer batteri"), och släpp ljudslingan automatiskt när
`driving.driving` varit falskt en längre stund.

---

### Fynd 8 — Det obekväma: i en bakgrundsflik slutar appen i praktiken att köra

Det här är det viktigaste enskilda mätvärdet i granskningen, och det pekar åt
motsatt håll mot alla fynd ovan.

**Uppmätt** i en körning där fliken låg verkligt dold i 51 sekunder, ungefär
fem minuter efter att appen laddats:

| Mätvärde | Synlig | Verkligt dold |
|---|---|---|
| Sond, 100 ms-timer (nominellt 600/min) | 600/min | **1,0–1,2/min** |
| Appens egna timers, alla intervall | 21,9/min | **8,2/min, alla på ~1,2/min** |
| Andel av nominell takt | ~100 % | **~5 %** |

Det är inte ett golv på en sekund. Det är Chromes hårda bakgrundsstrypning, som
slår till efter ungefär fem minuter och då klämmer ner **alla** timers till
ungefär ett uppvaknande i minuten, oavsett vilket intervall de bad om. En timer
på fem sekunder och en på två minuter blir samma sak.

Konsekvenser:

* Besparingen i fynd 5 och 6 är mindre än den ser ut i en dold flik — men
  större i det läge som faktiskt gäller under en resa, nämligen **appen framme
  med skärmen tänd**. Det är där alla siffror i fynd 1–6 gäller, och det är
  där föraren har appen.
* Allt som drivs av `setInterval` och som *måste* fungera under körning är
  redan opålitligt i bakgrunden. Det gäller inte varningarna — de hänger på
  `geo`-händelsen `position` (`app.js:273`), och GPS-återanrop är inte timers.
  Det är tur, men det är inte skrivet någonstans att det är ett medvetet val.
* Undantaget är fynd 7: med rattknapparna på gäller ingen strypning alls.

**Åtgärd:** skriv ner beroendet. Varningskedjan måste gå
`watchPosition → engine.evaluate`, aldrig genom en timer. Lägg ett test i
`test.html` som går sönder om någon flyttar `engine.evaluate` in i en
`setInterval`.

---

### Fynd 9 — GPS på hög noggrannhet, alltid

**Uppmätt:** `js/geo.js:23` startar `watchPosition` med
`{ enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }`. En enda
prenumeration, korrekt uppstädad i `geo.stop()` — inga läckor.

`enableHighAccuracy: true` betyder GPS-mottagaren i stället för nät- och
wifi-positionering, alltså en av de dyraste enskilda posterna på en telefon
efter skärmen. `maximumAge: 1000` säger dessutom åt telefonen att aldrig
återanvända en position äldre än en sekund.

För en app som varnar för polis i rörelse är det rätt val. Värmevakten kan
redan sänka den när telefonen blir varm (`app.js:844–849`), och det är bra
byggt: den startar om prenumerationen med `highAccuracy: false`.

**Åtgärd:** låt samma nedsänkning ske på tid, inte bara på värme. Står bilen
still (`driving.driving === false`) i mer än några minuter behövs ingen
meterprecision — sänk till `enableHighAccuracy: false` och höj `maximumAge`.
Höj tillbaka så fort farten går över noll.

---

### Fynd 10 — Småsaker, för fullständighetens skull

| Rad | Intervall | Bedömning |
|---|---|---|
| `app.js:3841` | 30 min | letar efter ny version. Fyrade aldrig under mätfönstren. Oproblematisk. |
| `app.js:1068` | 1 s | nedräkning vid utelåst inloggning. Avslutar sig själv. Oproblematisk. |
| `app.js:2681` | 1 s | inspelningstid i gränssnittet. Går bara medan dashcamen spelar in, men ritar en textsträng varje sekund även när vyn inte visas — pausa vid `hidden`. |
| `dashcam.js:200` | 100 ms | väntar på första bildrutan, städas i `finish()`. Tidsbegränsad. Oproblematisk. |
| `plate.js:1174` | 100 ms | samma sak för skyltläsaren, med räknare som tar slut. Oproblematisk. |
| `varme.js:457` | 500 ms | mäter timerdrift. Går bara medan värmevakten är aktiv, alltså under dashcam. Kroppen hoppar över mätningen när fliken är dold (`varme.js:459`) men timern fortsätter vakna — avregistrera den i stället. |

`varme.js` gör för övrigt rätt i det som är svårast: den stoppar sin
rAF-loop när fliken döljs och kastar mätvärdena (`varme.js:396–408`), just för
att inte förväxla webbläsarens energisparande med att telefonen blivit varm.
Den kommentaren är värd att läsa innan någon ändrar i den.

---

## 2. `visibilitychange`: vem pausar, vem gör det inte, vem borde

**Pausar i dag (uppmätt):**

* `chatt.js:527–538, 573–586` — avregistrerar timern helt när fliken döljs.
  Uppmätt: 1,0 nätanrop/min → 0.
* `varme.js:396–415` — stoppar rAF-loopen och nollställer mätvärdena.

**Gör något annat än att pausa:**

* `store.js:143–144` — hämtar en gång extra vid återkomst, men rör aldrig
  timern.
* `app.js:3741` — försöker ta tillbaka skärmlåset. Läcker en lyssnare per
  anrop.
* `app.js:3842` — letar efter ny version vid återkomst. Rimligt.
* `dashcam.js:919–930` — tar tillbaka skärmlåset under inspelning. Korrekt
  uppstädat.

**Måste fortsätta i bakgrunden — rör inte:**

* GPS-prenumerationen i `geo.js:23`. Varningarna hänger på den.
* Varningsmotorn `engine.evaluate`, som körs på GPS-återanrop (`app.js:292`).
* Vakthunden `app.js:804`, som märker om varningarna slutat fungera.
* Dashcamens ritloop och segmenttimer under pågående inspelning.
* Skyltläsarens timers under pågående läsning.

**Borde pausa och gör det inte:**

| Rad | Vad | Varför den kan pausa |
|---|---|---|
| `app.js:237` | `renderHazards` var 20:e s | ritar om en lista och en karta som ingen ser |
| `store.js:141` | rapportpollning var 30:e s | väcker modemet för data ingen läser just nu |
| `app.js:239` | statistik var 120:e s | topplista och statistik är inte tidskritiska |
| `app.js:238` | betalvägg var 60:e s | en betalvägg i en dold flik är meningslös |
| `app.js:618` | körpåminnelse var 60:e s | kollar redan `appFramme` i kroppen |
| `app.js:872` | värmevakt var 5:e s | ska styras av dashcamens livscykel, inte av en klocka |
| `app.js:2681` | inspelningstid varje s | bara text i gränssnittet |
| `varme.js:457` | timerdrift var 500:e ms | kroppen hoppar redan över när dold |

---

## 3. Vad som pollar nätet

Uppmätt med `PerformanceObserver` under 62-sekundersfönster:

| Ändpunkt | Synlig | Dold (app) | Källa |
|---|---|---|---|
| `supabase · reports_feed` | 1,9–2,9 /min | 1,9 /min | `store.js:141`, var 30:e s |
| `supabase · chatt_flode` | 1,0 /min | **0** | `chatt.js:585`, var 60:e s när chattvyn inte visas, var 8:e s när den visas (`chatt.js:123–125`) |
| Kartbrickor (carto) | gick inte att mäta | – | Leaflet, `map.js:15`. Hämtas när kartan panorerar, alltså kontinuerligt i en rullande bil |
| Overpass (hastighetsgränser) | ingen under mätningen | – | `speedlimit.js:162`. Hämtas en bricka i taget, cachas 30 dygn i IndexedDB (`speedlimit.js:134`) och som mest 12 brickor sparas (`speedlimit.js:184`). Väluppfostrad. |
| met.no (vinterväder) | ingen under mätningen | – | `vinter.js:591`, som mest var 30:e minut och aldrig oftare än var 5:e (`vinter.js:136–138`). Väluppfostrad. |
| OSRM (ruttdragning) | ingen under mätningen | – | `rutt.js:590`, bara när en rutt sätts eller räknas om |
| Prenumerationsstatus | ingen periodisk | – | `billing.js:95` anropas vid inloggning och köp, inte på klocka. Bra. |

Med chattvyn öppen blir chatten den dominerande nätposten: var åttonde sekund
är 7,5 anrop i minuten, alltså fyra gånger allt annat tillsammans. Det är
avsiktligt och kommenterat i `chatt.js:566–572`, och rimligt så länge vyn
faktiskt är framme — vilket den inte får vara medan man kör.

**Åtgärd:** ge `store.js` samma paus som chatten har (fynd 5), och överväg att
höja `pollMs` från 30 till 60 sekunder när `driving.driving` är falskt. En
parkerad bil behöver inte veta om polis två gånger i minuten.

---

## 4. Vad som håller igång utan användaren

| Sak | Uppmätt | Kommentar |
|---|---|---|
| GPS-prenumeration | 1 st, `enableHighAccuracy: true`, från `geo.js:23` | den dyraste posten efter skärmen |
| Skärmlås | 6 begäranden under 3 minuter, från `app.js:3740` och `app.js:3743` | lyssnarläcka, se fynd 1 |
| Kameraström | 0 | startas bara av dashcam (`dashcam.js:273`) och skyltläsare (`plate.js:850`) |
| Ljudkontexter | 0 i vila | `ljud.js` delar en enda kontext med flit (`ljud.js:12`). `plate.js:1332` skapar däremot en **ny** `AudioContext` per pip och stänger den efter 400 ms — det är rätt sätt att göra fel: kontexterna städas, men ett pip per skyltträff bygger och river en ljudkedja i onödan |
| Uppläsning | 0 i vila | `speechSynthesis` körs bara på varningar |
| Långa uppgifter | **0 per minut i samtliga faser** | ingen enskild uppgift blockerade huvudtråden över 50 ms. Appen är ryckfri; kostnaden ligger i frekvens, inte i klumpar |
| Service worker | inga timers alls i `sw.js` | bra |

---

## 5. Hur länge räcker batteriet i en bil?

**Detta är uppskattat, inte uppmätt.** Modellen är ett batteri på 4 500 mAh vid
3,85 V ≈ 17 Wh, och effektsiffror i storleksordningen från allmänt kända
mätningar av mobil hårdvara. Den uppmätta delen är hur mycket arbete appen
utför; översättningen till watt är en uppskattning och kan vara fel med en
faktor två åt vardera hållet.

| Läge | Uppskattad effekt | Uppskattad tid på fullt batteri |
|---|---|---|
| Bara varningar, skärmen tänd på låg ljusstyrka, GPS hög, karta på | 1,5–2,2 W | **8–11 timmar** |
| Samma, men i direkt solljus (skärmen tvingas upp) | 2,5–3,5 W | **5–7 timmar** |
| Med dashcam igång (1280 × 720, 30 fps) | 3,5–5 W | **3,5–5 timmar** |
| Med dashcam **och** skyltläsare | 5–6,5 W | **2,5–3,5 timmar** |
| Skärmen släckt, appen i bakgrunden | 0,4–0,8 W | **20+ timmar, men appen kör då på ~5 % av sin takt** (fynd 8) |

En billaddare på 10–15 W täcker samtliga lägen med marginal — men bara om
telefonen inte blir så varm att den slutar ta emot laddning, vilket är precis
det scenario `varme.js` finns till för.

**Svaret på frågan:** en typisk resa på en till tre timmar klarar appen i
vilket läge som helst. En hel dag klarar den bara utan dashcam. Med dashcam och
skyltläsare igång är telefonen tom efter ungefär tre timmar utan laddare, och i
solen troligen tidigare än så eftersom värmevakten då börjar sänka kvaliteten
för att telefonen ska orka alls.

**Den enskilt största posten är skärmen, som appen själv håller tänd.** Det är
ingen kod som syns i en profilering, det står inte i någon millisekund, och det
är ändå större än allting annat i det här dokumentet tillsammans. Näst största
är dashcamens ritloop på 31 % av en kärna, och därefter GPS på hög noggrannhet.

---

## 6. De tre åtgärder som ger mest

1. **Mörkt körläge som släpper skärmlåset.** Största posten, störst effekt,
   och den enda ändringen som kan nästan halvera förbrukningen under en resa.
   Fixa lyssnarläckan i `app.js:3741` samtidigt.
2. **Sänk dashcamens standard-`fps` från 30 till 20 och hoppa över ritloopen i
   `direct`-läge.** En tredjedel mindre huvudtrådsarbete i det dyraste läget,
   utan att filmen blir sämre på något sätt som spelar roll.
3. **Ge `store.js` samma pausning som `chatt.js` redan har, och pausa
   `renderHazards`.** Tillsammans tar de bort den dyraste timern (16–35 ms/min)
   och två modemuppvaknanden i minuten när ingen tittar.
