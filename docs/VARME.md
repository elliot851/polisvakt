# Värmevakten — vad appen kan veta om att telefonen inte längre hinner med

Polisvakt kör i en bil, i ett vindrutefäste, ofta i solen. Samtidigt gör appen
fyra saker som var för sig är tunga:

- GPS på `enableHighAccuracy: true`, som håller radiomottagaren vaken,
- Wake Lock, som tvingar skärmen tänd på full ljusstyrka,
- en canvas som ritas om trettio gånger i sekunden med en eller två
  kameraströmmar och ett överlägg,
- MediaRecorder som kodar H.264 av samma canvas, kontinuerligt, i segment.

Telefoner klarar inte det i längden. De stryper — sänker klockfrekvenser,
dimmar skärmen, drar ned kamerans bildfrekvens och stänger till sist av
kameran helt. iPhone gör det tidigast och hårdast.

Innan den här modulen fanns märkte appen ingenting av det. Föraren upptäckte
det efteråt, när han skulle titta på filmen.

`js/varme.js` är svaret. Modulen mäter inte värme. Den mäter om appen
fortfarande hinner med sitt eget arbete, och gör något åt saken när den inte
gör det.

---

## 1. Det här kan inte mätas, och vi låtsas inte annat

**Webben har ingen termometer.** Det finns inget API i någon webbläsare som
säger hur varm en telefon är. Det finns inte heller något som säger "du blir
strypt om två minuter". Det närmaste som existerar gås igenom i avsnitt 3, och
inget av det finns på en telefon.

Därför står ordet *överhettad* ingenstans i den här modulen. Inte i koden, inte
i texten på skärmen, inte i det som sägs högt. Det vore ett påstående vi inte
kan belägga, och en app som gissar med bestämd röst blir trodd på fel grunder.

Det vi säger istället är det vi faktiskt vet:

> "Telefonen hinner inte med inspelningen."

Det är en mätning. "Telefonen är överhettad" hade varit en gissning.

Skillnaden spelar roll även praktiskt: en telefon kan halka efter för att den
är varm, men också för att en annan app maler i bakgrunden, för att telefonen
är i strömsparläge, eller för att det är en gammal telefon som aldrig klarat
det här. Symptomen är identiska och åtgärden är densamma. Orsaken vet vi inte
— så vi uttalar oss inte om den.

---

## 2. Vad som mäts på riktigt

Det här är avläsningar, inte slutsatser. Var och en är ett tal eller ett
tillstånd som webbläsaren lämnar ifrån sig.

### 2.1 Kamerans levererade bildrutor mot utlovade — huvudsignalen

Videoelementets egen räknare (`getVideoPlaybackQuality().totalVideoFrames`,
eller `webkitDecodedFrameCount` i Safari) säger hur många bildrutor som kommit
fram från kameraströmmen. Delat med tiden ger det uppnådd bildfrekvens.

Utlovad bildfrekvens läses ur `track.getSettings().frameRate`. Den siffran är
vad telefonen **gick med på** när strömmen förhandlades fram — inte vad den
levererar nu. Glappet mellan de två är exakt det vi letar efter.

Det här är den enda signalen som mäter *kameran* och inte oss själva, och den
enda som fungerar likadant i Safari och Chrome. Därför väger den tyngst.

Fallgrop som är hanterad i koden: står räknaren helt still returnerar modulen
`null`, inte noll. Noll hade betytt "kameran är död" och stoppat inspelningen.
Räknare kan stå still för att webbläsaren aldrig komponerar det två pixlar
stora videoelementet — se kommentaren om `requestVideoFrameCallback` i
`js/dashcam.js`.

### 2.2 Kameraspårets tillstånd — ett faktum, inte ett indicium

`track.muted` blir sant när iOS tar kameran ifrån appen. `track.readyState`
blir `'ended'` när den är borta för gott.

Det här är inte något att tolka. Det är haveriet modulen finns till för att
fånga: bilden slutar komma medan appen fortsätter påstå att den spelar in.
Signalen får därför gå förbi den långsamma bekräftelsetiden (`bekraftaHartMs`,
5 sekunder istället för 20).

### 2.3 Inspelarens dataflöde

`MediaRecorder` startas med `start(1000)`, alltså en databit i sekunden.
Bitarna hamnar i `dashcam.segmentChunks`, som töms vid segmentbyte. Modulen
läser bara längden: **växer** den kom det data, **krymper** den byttes segment
— båda är livstecken. Står den still i flera sekunder har kodaren hamnat efter.

Ingen ändring i `dashcam.js` behövdes för det här. `segmentChunks` är ett
publikt fält och läses aldrig destruktivt.

### 2.4 Kompositörens takt (`requestAnimationFrame`)

Intervallen mellan bildrutor mäts löpande. Ur medianen fås enhetens uppnådda
frekvens.

Den jämförs **inte** mot antagna 60 Hz. Baslinjen mäts upp under körningen —
högsta observerade takten blir referens. Det finns telefoner på 120 Hz och
sparlägen på 30 Hz, och en antagen siffra hade antingen friskförklarat varje
120-telefon eller dömt ut varje 30-telefon.

Hopp över en sekund kastas. Det är inte tappade bildrutor, det är ett avbrott:
sidan låg still, ett samtal kom in, användaren bytte app.

### 2.5 Timerdrift

En egen `setInterval` på 500 ms mäter hur mycket senare än beställt den
faktiskt vaknar. Det är samma sorts timer som driver dashcamens ritloop, på
samma tråd. Går vår halvsekundstimer 900 ms är det ingen gissning att
ritloopens 33-millisekunderstimer också halkat.

Svag för sig själv — en lång rendering av rapportlistan ger samma utslag — och
väger därför lätt.

### 2.6 Ritfrekvens mot beställd (frivillig inmatning)

`noteraBildruta()` finns för den som vill mata modulen från ritloopen. Det är
den ärligaste mätningen som finns: uppnått mot beställt, direkt.

Den är frivillig eftersom den kräver ett anrop inne i `dashcam.js`, som den här
modulen inte äger. **Uteblir matningen påstår modulen inte att ritfrekvensen är
bra — den räknar signalen som okänd** och lutar sig på kameraräknarna istället.
Det syns i `varme.lage.stod.ritmatning`.

---

## 3. Vad plattformen erbjuder — och var det inte finns

Undersökt mot MDN:s kompatibilitetsdata och Chromes egen dokumentation i
augusti 2026. Sammanfattningen är nedslående och värd att känna till innan
någon föreslår "kan vi inte bara läsa av temperaturen".

| API | Vad det ger | Var det finns | Slutsats |
|---|---|---|---|
| **Compute Pressure** (`PressureObserver`) | `nominal` / `fair` / `serious` / `critical` | **Chrome 125+ på dator.** Chrome för Android: nej. Safari: nej. Firefox: nej. | Det närmaste webben kommer en värmemätare — och det finns inte på en enda telefon. Läses ändå när det finns. |
| **Battery Status** (`navigator.getBattery`) | nivå, laddar/laddar ej | Chromium, inklusive Chrome för Android. Safari: aldrig. Firefox: borttaget. | Halva marknaden, och just iPhone saknar det. |
| `navigator.deviceMemory` | GB, avrundat | Chromium. Safari: nej. Firefox: nej. | Säger enhetens klass, inte dess tillstånd. |
| `navigator.hardwareConcurrency` | antal kärnor | Överallt, men **Safari klämmer värdet till 4 eller 8** oavsett verklighet. | Samma sak: klass, inte tillstånd. |
| `getVideoPlaybackQuality()` | levererade/tappade bildrutor | Överallt sedan 2019. Safari har dessutom `webkit`-varianterna. | Används som huvudsignal. |
| `requestVideoFrameCallback` | `presentedFrames`, `processingDuration` | Baseline sedan 2024. | **Används medvetet inte.** Den anropas inte alls för element webbläsaren inte komponerar, och dashcamens videoelement är två pixlar stora med `opacity: 0.01`. Det gav en riktig bugg en gång redan, se `#waitForFrame` i `dashcam.js`. |
| `PerformanceObserver('longtask')` | långa uppgifter på huvudtråden | Chromium. | Mäter samma sak som timerdriften och finns bara där vi ändå har mest data. Utelämnad för att hålla ytan liten. |

Två saker om Compute Pressure som lätt missförstås:

- Källan `"thermals"` finns i specifikationen men är **inte implementerad
  någonstans**. Bara `"cpu"` går att observera. Ser man `"thermals"` i ett
  kodexempel på nätet är exemplet önsketänkande.
- Den kräver säker kontext (HTTPS), vilket appen ändå har.

Modulen läser den ändå, av två skäl: den är gratis när den finns, och den gör
felsökning vid skrivbordet ärligare.

---

## 4. Vad som härleds

Slutsatser dragna av mätvärdena ovan. De är rimliga, men de är slutsatser.

**Att appen halkat efter beror på belastning.** Signalerna kan lika gärna
utlösas av strömsparläge eller av en annan app som stjäl processortid.
Åtgärden är densamma, så modulen behöver inte veta vilket — men det betyder
också att "telefonen halkar efter" aldrig får läsas som "telefonen är varm".

**Batteritakt som medhåll.** Nivån avrundas till hela procent av webbläsaren,
så det krävs minst en procents förändring och ett par minuter innan siffran
säger något. Därför används den bara som medhåll, aldrig som ensam anledning,
och ger som mest en poäng.

Ett undantag väger tyngre: **sjunker nivån medan telefonen laddar** drar den
mer än laddaren orkar leverera. Det är precis det läge man hamnar i med
telefonen i solen, full belastning och en billaddare — och det behöver ingen
tolkning.

**Att belastningen är borta när inspelningen är stoppad.** Ritloopen och
kodaren är faktiskt avstängda, så det är rimligt. Men det är inte mätt, och
det är just den slutsatsen som gör att dashcamen kan rekommenderas tillbaka
efter ett stopp.

---

## 5. Vad som är rena antaganden

Var ärlig om att det här är valda siffror, inte härledda:

- **Att 25 sekunders uppvärmning räcker.** Kamerastart, IndexedDB, canvas och
  MediaRecorder är alltid hackiga i början. Talet är valt för att täcka det
  med marginal — inte uppmätt.
- **Exakt var trösklarna går** (0,8 och 0,5 för kameratakten, 0,25 och 0,6 för
  driften). Ordningsföljden mellan dem är genomtänkt; de absoluta talen är
  rimliga startvärden som ska justeras när riktiga körningar finns.
- **Att tre minuters lugn räcker innan ett steg tas tillbaka.** Termisk
  återhämtning tar minuter, inte sekunder — men hur många minuter beror på
  telefon, fäste och sol.
- **Att 15 bilder per sekund är det lägsta användbara.** En bedömning om vad
  som går att tyda i efterhand, inte ett mätt värde.

---

## 6. Lägena och hysteresen

Tre lägen: **normal**, **warm**, **hot**. Namnen är interna; utåt talar appen
om att hinna med, aldrig om värme.

Varje signal ger 0, 1 eller 2 poäng. En **saknad signal ger ingenting alls** —
den drar varken upp eller ned och redovisas som okänd i felsökningsvyn.

| Signal | 1 poäng | 2 poäng |
|---|---|---|
| Kamerans takt mot utlovad | under 0,8 | under 0,5 |
| Kameraspåret | — | `muted` eller `ended` |
| Lucka i inspelningsdata | över 3 s | över 8 s |
| Ritfrekvens mot beställd | under 0,8 | under 0,5 |
| Kompositör mot egen baslinje | under 0,75 | under 0,5 |
| Timerdrift | över 25 % | över 60 % |
| Batteri | över 25 %/h (½ poäng) | — (max 1 totalt) |
| Systemtryck | `serious` | `critical` |

Poäng och inte procent, för att signalerna inte är jämförbara. En tyst kamera
är ett faktum, en batteritakt är ett indicium, ett tryckvärde är någon annans
bedömning. Att slå ihop dem till "73 % belastning" hade gett tre olika sorters
kunskap samma auktoritet.

**Trösklar in:** warm vid 2 poäng, hot vid 4.
**Trösklar ut:** warm lämnas vid 1, hot vid 2.

Att de skiljer sig är hela hysteresen. Utan det studsar bedömningen kring
tröskeln — två poäng, ett, två — och varje studs vill antingen sänka eller
höja kvaliteten. Resultatet blir en dashcam som byter upplösning varje
halvminut, vilket kostar mer än det sparar eftersom varje byte klipper ett
segment.

Tre spärrar till:

1. **Ett läge måste hålla i sig innan det tros på.** 20 sekunder uppåt, 120
   sekunder nedåt. Asymmetrin är avsiktlig: en telefon som blivit varm blir
   inte sval för att man kört in i en tunnel i tjugo sekunder.
2. **Hårda fakta får gå fortare** — 5 sekunder. Att kameraspåret tystnat finns
   inget att bekräfta bort.
3. **Aldrig mer än ett steg i taget**, och aldrig oftare än en gång per minut
   — utom uppåt på ett hårt faktum, för står kameran still ska ingen karens
   sitta i vägen. Hopp från hot rakt till normal betyder nästan alltid att en
   signal tillfälligt föll bort, inte att telefonen svalnat.

Simulerat: 20 minuter med belastningen växlande varje minut mellan 12 och 30
levererade bildrutor per sekund ger **ett** lägesbyte totalt.

---

## 7. Trappan, och varför den ser ut som den gör

Sju steg, minst skada först. De fem första får tas i **warm**; de två sista
kräver **hot**.

| # | Steg | Åtgärd | Kräver | Talas |
|---|---|---|---|---|
| 1 | Upplösning | 1080p → 720p | warm | ja |
| 2 | Upplösning | 720p → 480p | warm | nej |
| 3 | Bildfrekvens | 30 → 20 fps | warm | nej |
| 4 | Bildfrekvens | 20 → 15 fps | warm | nej |
| 5 | Kupékamera | av | warm | nej |
| 6 | GPS | `enableHighAccuracy: false` | **hot** | ja |
| 7 | Inspelning | stoppa | **hot** | ja |

**Varför upplösningen först.** Kostnaden för att rita och koda växer med
antalet pixlar; 1080p → 720p är mer än en halvering av arbetet. Priset är
detaljer i en film man förhoppningsvis aldrig behöver. Allt blir fortfarande
filmat, hela tiden, och en registreringsskylt går att läsa i 720p.

**Varför bildfrekvensen sedan.** Näst största besparingen, och filmen är
fortfarande sammanhängande. Ligger efter upplösningen därför att låg
bildfrekvens gör snabba förlopp — just de förlopp man filmar för — svårare att
tyda.

**Varför kupékameran först på femte plats,** trots att den sparar en hel
kamerapipeline och ett komponeringssteg: den är avstängd som standard. Har
föraren slagit på den vill han se kupén, och att tyst ta bort en påslagen
funktion är värre än att göra en kvarvarande funktion sämre.

**Varför GPS:en så sent.** Här börjar det kosta appens hela syfte. Polisvakt
varnar för polis och fartkameror; sämre positioner betyder senare varningar.
Dashcamen är bevis, GPS:en är själva funktionen. **Bevis får bli grynigt innan
funktionen får bli trubbig.**

**Varför stoppet sist.** Telefonen gör det åt oss om vi inte gör det själva.
Skillnaden är att när vi gör det säger vi till, och varningarna lever vidare.
En tyst avstannad dashcam är projektets värsta fel: föraren tror att han
filmar.

**Varför de två sista kräver hot.** Utan den spärren vandrar en lätt belastad
telefon steg för steg ända ned till avstängd dashcam och trubbig GPS, bara för
att den halkat efter en aning tillräckligt länge. Det är inte proportionerligt.

Takt: ett steg per 90 sekunder i warm, per 45 sekunder i hot.

### Vägen tillbaka

Ett steg per tre minuters lugn, aldrig allt på en gång. Höjer man tillbaka allt
i samma ögonblick är telefonen tillbaka i exakt den belastning som gjorde att
den halkade, och tio minuter senare står man där igen — fast nu har föraren
hört appen ändra sig fyra gånger.

Återställningen gissar inte vad inställningen stod på. Modulen skriver upp det
verkliga värdet innan den rekommenderar en ändring. Kupékameran är exemplet:
den är av som standard, och en återställning till "på" hade slagit på en
funktion föraren aldrig bett om, mitt under körning.

Efter ett stopp fortsätter vägen tillbaka att gå. Utan det vore stoppet
permanent: ingen inspelning → ingen mätning → ingen återgång → en dashcam som
är avstängd resten av resan.

---

## 8. Rösten

Disciplinen är hämtad rakt av från `js/vakthund.js`, och beteendet ska kännas
som samma app:

- **Ett besked i taget.** Två röstmeddelanden på raken hörs i en bil som ett
  enda otydligt.
- **Karens på tio minuter** för samma besked.
- **Återställning annonseras** — men bara om vi faktiskt sa ifrån. "Dashcamen
  är tillbaka på full kvalitet" utan föregående varning är obegripligt.
- **Rösten hänger på åtgärden, inte på läget.** Modulen säger aldrig "läget är
  hot". Den säger vad den gör åt saken, och bara när det spelar roll för
  föraren.

Det blir högst tre talade meningar under en hel resa:

1. *"Telefonen hinner inte med inspelningen. Jag sänker videokvaliteten så att
   den inte stannar."* — föraren tror sig ha 1080p på film; ändras det ska han
   veta om det.
2. *"Telefonen är hårt belastad. Jag sänker GPS-noggrannheten, så varningarna
   kan komma något senare."* — första steget som gör appen sämre på det den
   finns till för. Tystnad här hade varit ett löfte vi inte längre håller.
3. *"Telefonen orkar inte spela in mer. Jag stänger av dashcamen. Varningarna
   fortsätter."*

Steg 2–5 i trappan säger ingenting högt. De visas som text. Filmen fortsätter,
bara lite sämre, och en förare som får höra om varje sänkt bildruta stänger av
ljudet — och då tystnar polisvarningarna också.

---

## 9. Att koppla in den

Modulen **ändrar ingenting själv**. Den observerar dashcamen läsande och
skickar rekommendationer som händelser. Den som kopplar in appen bestämmer om
de ska följas. Det är medvetet: en modul som både bedömer läget och drar i
spakarna går inte att felsöka den dagen den drar i fel spak.

```js
import { Varmevakt } from './varme.js';

const varme = new Varmevakt();
varme.observera(dashcam);          // läses aldrig destruktivt
await varme.koppla();              // batteri + systemtryck där de finns

dashcam.addEventListener('start', () => varme.start());
dashcam.addEventListener('stop',  () => varme.stopp());

// Samma form som vakthunden, så inkopplingen ser likadan ut på båda ställena.
const sag = e => {
  const d = e.detail || {};
  if (d.spoken && settings.tts) speaker.say(d.spoken, { priority: 2 });
  if (d.text) toast(d.text, 7000);
};
varme.addEventListener('warning', sag);
varme.addEventListener('recovered', sag);
varme.addEventListener('note', e => toast(e.detail.text, 5000));

varme.addEventListener('rekommendation', e => {
  const { id, atgard } = e.detail;
  const ok = utfor(atgard);        // din kod: sätt inställningen, stoppa, m.m.
  varme.stegUtfort(id, ok);
});
varme.addEventListener('atergang', e => { /* samma, fast tillbaka */ });

setInterval(() => varme.kontrollera(), 10000);
```

`atgard` är data, inte kod:

```js
{ modul: 'dashcam', satt: 'quality', varde: 'medium' }
{ modul: 'dashcam', satt: 'fps',     varde: 20 }
{ modul: 'dashcam', satt: 'dual',    varde: false }
{ modul: 'dashcam', anrop: 'stop' }
{ modul: 'geo', satt: 'watchOptions', varde: { enableHighAccuracy: false, maximumAge: 5000, timeout: 20000 } }
```

### Två fällor för den som skriver `utfor()`

**`dashcam.setSetting('fps', 20)` räcker inte.** Ritloopen läser
`settings.fps` en enda gång, i `#loop()`, som bara anropas från `start()`. Att
sätta värdet ändrar ingenting förrän loopen startas om.

**`dashcam.setSetting('quality', 'medium')` räcker inte heller.** Bitrate-
getter läses vid nästa segmentstart, så kodningen sjunker vid segmentbytet —
men canvasens storlek ändras först när `#resizeCanvas()` körs, och det gör den
inte av sig själv.

Båda kräver alltså en liten ändring i `js/dashcam.js` (som ägs av någon annan):
låt `setSetting` reagera på `fps` och `quality`. Värmevakten kan inte göra det
åt dig, och ska inte kunna det.

**`geo` har ingen metod för att byta `watchPosition`-inställningar** i nuläget.
Steget kräver `stop()` följt av `start()` med nya optioner, vilket är den som
kopplar in appens sak att lösa.

---

## 10. Vad den här modulen inte kan veta

Läs den här listan innan du litar på modulen, och innan du bygger något ovanpå
den.

1. **Telefonens temperatur.** Inte i grader, inte i intervall, inte alls.
2. **Varför den halkar efter.** Värme, strömsparläge, en annan app, en gammal
   telefon — symptomen är identiska.
3. **Om strypningen är på väg.** Modulen ser den när den inträffat, aldrig
   innan. Det finns ingen förvarning att läsa av.
4. **Om telefonen är i strömsparläge.** Inget API säger det. iOS Low Power Mode
   sänker bland annat skärmuppdateringen till 30 Hz, vilket ser ut som
   strypning i signal 2.4 — det är därför baslinjen mäts upp löpande istället
   för att antas.
5. **Om solen ligger på.** Ingen ljussensor är tillgänglig för webben.
6. **Om åtgärden hjälpte.** Modulen ser att siffrorna kom tillbaka. Om det
   berodde på sänkningen eller på att bilen körde in i skuggan går inte att
   skilja åt.
7. **Om åtgärden ens genomfördes**, annat än genom `stegUtfort()`. Rapporteras
   inget fortsätter trappan ändå — annars hade en enda missad inkoppling
   fryst modulen för alltid.
8. **Vad som händer med skärmen släckt eller appen i bakgrunden.** Både `rAF`
   och timers stryps då av webbläsaren själv. Modulen kastar de proverna och
   **pausar bedömningen** — den hittar hellre ingenting än fel saker.
9. **Nästan lika mycket på iPhone som på Android.** Batteri-API, tryck-API och
   `deviceMemory` saknas alla i Safari. På den telefon som stryper hårdast har
   modulen tunnast underlag: i praktiken bara kameraräknarna, spårets status,
   dataflödet och driften.
10. **Måttlig försämring från en ensam signal.** Två poäng krävs, och en
    ensam måttlig signal ger en. Levererar kameran 20 bildrutor av utlovade 30
    och allt annat är friskt händer ingenting. Det är avsiktligt — 20 fps är
    användbar film och att sänka kvaliteten där hade varit att laga något som
    inte var trasigt — men det innebär att modulen hellre missar ett tidigt
    fall än flaggar ett falskt.
11. **Skillnad på processor och grafik.** Compute Pressure rapporterar `cpu`;
    kodning sker ofta i separat hårdvara. Vi ser resultatet, inte var det
    uppstod.
12. **Om lagringen är problemet istället.** Det ägs av `#fitBufferToQuota()` i
    `dashcam.js` och hör inte hit.

---

## 11. Felsökning

`varme.lage` ger allt på en gång:

```js
{
  niva: 'warm',
  poang: 2,
  steg: 'upplosning-1',
  signaler: { kameratakt: 0.62, spar: 'ok', dataluckaMs: 900,
              rittakt: null, rafFps: 58, rafKvot: 0.97,
              timerDrift: 0.08, batteri: null, tryck: null,
              synlig: true, enhetsklass: 'normal' },
  stod: { batteri: false, tryck: false, ritmatning: false }
}
```

`null` betyder **okänt**, aldrig noll och aldrig bra. `stod` säger vilka
plattformssignaler som faktiskt fanns att tillgå — är allt `false` kör du i
Safari, och då vilar bedömningen på fyra signaler istället för sju.
