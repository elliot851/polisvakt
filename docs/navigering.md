# Navigering — svängbeskrivningar som säger till i tid

`js/navigering.js` gör det [RUTT.md](RUTT.md) under rubriken *Vad det här inte
klarar* säger att ruttläget inte gör: den vet vad du ska göra härnäst, och den
säger det när det hjälper i stället för när det är för sent.

Modulen rör aldrig DOM, karta eller talsyntes. Skicka in en rutt och en
GPS-position, få ut ett tillstånd och noll eller en mening som **bör** sägas.
Vem som säger den, med vilken prioritet, och om den hunnit bli inaktuell på
vägen genom talkön avgör appen.

- Kod: [`js/navigering.js`](../js/navigering.js)
- Tester: [`navigering-test.html`](../navigering-test.html) — 61 av 61 gröna,
  inget nät, ingen karta
- Grannmodulen som varnar för polis längs samma rutt: [RUTT.md](RUTT.md)

---

## Innehåll

1. [Det viktigaste först: polisvarningar väger tyngre](#det-viktigaste-först-polisvarningar-väger-tyngre)
2. [En rutt, inte två](#en-rutt-inte-två)
3. [Att koppla in](#att-koppla-in)
4. [Att rita rutten i map.js](#att-rita-rutten-i-mapjs)
5. [Gränssnittet som behövs](#gränssnittet-som-behövs)
6. [API](#api)
7. [När något sägs](#när-något-sägs)
8. [Svenskan](#svenskan)
9. [Av rutten](#av-rutten)
10. [Externa tjänster — vad de faktiskt lovar](#externa-tjänster--vad-de-faktiskt-lovar)
11. [Vad det här inte är](#vad-det-här-inte-är)
12. [Testresultat i siffror](#testresultat-i-siffror)

---

## Det viktigaste först: polisvarningar väger tyngre

Det här är modulens centrala designbeslut och det är ett affärsbeslut lika
mycket som ett tekniskt.

En missad svängbeskrivning kostar tre till fem minuter — man kör till nästa
avfart och vänder. En missad fartkamera kostar en bot, och i förlängningen
körkortet. Appen säljs dessutom på polisvarningarna. En förare som får en bot
medan appen var på och tyst har inte fått ett sämre navigationsläge, hen har
fått ett bevis på att abonnemanget inte gör det det lovar. Det är den enda
felkategorin som är existentiell för produkten.

Därför:

| | Navigering | Ruttvarning (rutt.js) | Nära fara (alerts.js) |
|---|---|---|---|
| Prioritet till `Speaker.say()` | **0** | 1 (förvarning) | 2 (nära) |
| `interrupt` | **aldrig** | nej | ja på prioritet 2 |

`Speaker` i `js/voice.js` sorterar kön fallande på prioritet. Allt som lämnar
navigeringen hamnar alltså bakom varje polisvarning som redan står och väntar,
och en pågående polisvarning kan aldrig klippas av mitt i av "sväng höger in på
Drottninggatan". Konstanten heter `NAV_PRIORITET` och är exporterad — den ska
inte varieras per meningstyp.

### Priset, och hur det betalas

En svängbeskrivning kan bli stående i kön och komma ut flera sekunder för sent.
"Sväng höger nu" som sägs tolv sekunder efter korsningen är inte bara värdelös,
den är farlig: föraren tittar upp och letar efter en avtagsväg som inte finns.

Därför bär varje yttrande ett bäst-före, `giltigTillTs`. **Appen måste kasta
yttrandet i stället för att läsa upp det när den tiden passerat.**

```js
for (const y of t.tal) {
  if (Date.now() > y.giltigTillTs) continue;   // hann bli inaktuell i kön
  taltare.say(y.text, { priority: y.prioritet });
}
```

Livslängderna är avstämda mot hur kort horisont meningen handlar om: `nu`
6 sekunder, `snart` 15, `langt` 30, allt annat 60.

---

## En rutt, inte två

`rutt.js` hämtar sin rutt med `steps=false` — den behöver bara geometrin för
korridoren. Den här modulen behöver dessutom svängarna, alltså `steps=true`.

**Att låta båda hämta var sin rutt är den enkla vägen och ett otäckt fel.** OSRM
kan svara med två olika vägar på två anrop som ligger en sekund isär, och då
varnar appen för polis längs väg A medan rösten säger åt föraren att svänga in
på väg B.

Modulen är byggd för att återanvända geometrin i stället. `satt()` tar emot ett
valfritt `geometri`-objekt som bara behöver kunna fyra saker — `nearest`,
`nearestBetween`, `pointAt` och `lengthM` — och det är exakt vad `Route` i
`rutt.js` kan. Skickar man in `guide.route` projicerar båda modulerna mot samma
linje och kan per definition inte hamna på olika vägar.

### Rekommenderad ändring i rutt.js

Jag har inte rört filen. Tre rader gör att en enda hämtning räcker:

```js
// js/rutt.js, i #fetchRoute()
const qs = '?overview=full&geometries=geojson&alternatives=false&steps=true&annotations=false';
//                                                                     ^^^^ var false

// js/rutt.js, i #build(), direkt efter att this.route satts:
this.route.legs = raw.legs || [];
```

Sedan, där ruttläget startas:

```js
const rutt = await guide.setDestination(mal);          // ett OSRM-anrop
navigering.satt({
  punkter: guide.route.points,
  steg: guide.route.legs.flatMap(l => l.steps || []),
  geometri: guide.route,                                // samma linje, delad
  distanceM: guide.route.distanceM,
  durationS: guide.route.durationS,
  mal: guide.destination,
}, { nu: Date.now(), orsak: 'ny' });
```

Kostnaden för `steps=true` är att svaret blir ungefär två till tre gånger
större. På en tio mil lång rutt är det storleksordningen 150 kB i stället för
60 kB. Det är en gång per resa och tas över mobilnätet medan bilen står stilla.

### Tills dess: två anrop, med skyddsnät

Gör man inte ändringen fungerar modulen ändå — anropa `hamtaOsrmRutt()` separat.
Modulen upptäcker då själv om de två rutterna inte är samma väg: `byggStegIndex`
jämför summan av stegdistanserna med den uppmätta linjelängden, och avviker de
mer än tio procent sätts `nav.varning`:

> Vägbeskrivningen och kartlinjen kommer inte från samma rutt. Avstånden till
> svängarna kan vara fel.

**Visa den strängen om den finns.** Den betyder att avstånden till svängarna
kan vara vad som helst.

---

## Att koppla in

```js
import { Navigering, hamtaOsrmRutt, NavigeringsFel } from './js/navigering.js';

const navigering = new Navigering();

// 1. Starta en resa. Resmålet kommer från geocode.js searchPlaces(), precis
//    som för ruttvarningarna — sökrutan är redan byggd, se RUTT.md.
async function startaNavigering(mal, start) {
  const rutt = await hamtaOsrmRutt(start, mal);          // eller återanvänd guide.route
  const { tal } = navigering.satt({ ...rutt, mal }, { nu: Date.now(), orsak: 'ny' });
  sag(tal);
  karta.ritaRutt(navigering.publikRutt());
}

// 2. Varje GPS-fix. Samma fix-objekt som resten av appen använder.
function påFix(fix) {
  const nu = Date.now();
  const t = navigering.uppdatera(fix, nu);

  ritaNavigeringsPanel(t);            // se "Gränssnittet som behövs"
  sag(t.tal);

  if (t.begarOmberakning) räknaOm(t.begarOmberakning);
}

// 3. Omräkning. Modulen hämtar ALDRIG själv — den ber, appen gör.
let räknarOm = false;
async function räknaOm(från) {
  if (räknarOm) return;
  räknarOm = true;
  try {
    const rutt = await hamtaOsrmRutt(från, navigering.mal);
    sag(navigering.satt({ ...rutt, mal: navigering.mal },
                        { nu: Date.now(), orsak: 'omberakning' }).tal);
    karta.ritaRutt(navigering.publikRutt());
  } catch (e) {
    // e.kod: 'nat' | 'timeout' | 'svar' | 'ingen-vag' | 'for-lang'
    visaFel(e.kod === 'nat' || e.kod === 'timeout'
      ? 'Ingen kontakt med ruttjänsten. Navigeringen är pausad.'
      : e.message);
  } finally { räknarOm = false; }
}

function sag(tal) {
  for (const y of tal) {
    if (Date.now() > y.giltigTillTs) continue;
    taltare.say(y.text, { priority: y.prioritet });
  }
}
```

### Två saker som är lätta att göra fel

**`begarOmberakning` konsumeras när den läses.** Varje anrop till `uppdatera()`
eller `tillstand()` nollställer flaggan. Det är avsiktligt — appen ska hämta en
gång per begäran, inte en gång per avläsning. Läs den alltså på ett enda ställe.

**Klockan skickas in.** `uppdatera(fix, nu)` kastar `TypeError` om varken
`fix.ts` eller andra argumentet är ett tal. Modulen läser aldrig `Date.now()`
själv, och det är just det som gör att hela beslutslogiken går att provköra.

---

## Att rita rutten i map.js

`js/map.js` ritar ingen ruttlinje idag. Två metoder på `HazardMap` räcker.
Kartan skapas redan med `preferCanvas: true`, så polylinjerna ritas på canvas
och kostar ingenting att panorera.

```js
  /**
   * Rita rutten.
   *
   * Två linjer, inte en. Den mörka undre ("casing") är det som får rutten att
   * läsa som en väg i stället för som ett streck över kartan — utan den
   * försvinner den blå linjen i motorvägarnas egen gula färg. Samma knep som
   * alla navigationskartor använder.
   *
   * Linjerna hamnar i overlayPane, alltså UNDER markerPane där farornålarna
   * bor. Det är rätt ordning: en polisnål får aldrig döljas av rutten.
   */
  ritaRutt(rutt) {
    this.rensaRutt();
    if (!rutt?.punkter?.length) return;
    this._ruttLager = L.layerGroup([
      L.polyline(rutt.punkter, {
        color: '#0a1119', weight: 12, opacity: 0.85,
        lineJoin: 'round', lineCap: 'round', interactive: false,
      }),
      L.polyline(rutt.punkter, {
        color: '#3aa2ff', weight: 7, opacity: 0.95,
        lineJoin: 'round', lineCap: 'round', interactive: false,
      }),
    ]).addTo(this.map);
  }

  /**
   * Dämpa den del som redan är körd.
   *
   * Anropas när kartan ritas om, inte vid varje GPS-fix — se linjeDelad() i
   * navigering.js. Skillnaden i ljusstyrka är den snabbaste signalen om åt
   * vilket håll rutten går; föraren behöver inte leta reda på sin egen pil.
   */
  ritaFramsteg({ passerad, kvar }) {
    this.rensaRutt();
    const lager = [];
    if (passerad.length > 1) {
      lager.push(L.polyline(passerad, {
        color: '#2b3a4a', weight: 7, opacity: 0.6, interactive: false,
      }));
    }
    lager.push(
      L.polyline(kvar, { color: '#0a1119', weight: 12, opacity: 0.85,
                         lineJoin: 'round', lineCap: 'round', interactive: false }),
      L.polyline(kvar, { color: '#3aa2ff', weight: 7, opacity: 0.95,
                         lineJoin: 'round', lineCap: 'round', interactive: false }));
    this._ruttLager = L.layerGroup(lager).addTo(this.map);
  }

  rensaRutt() {
    if (this._ruttLager) { this.map.removeLayer(this._ruttLager); this._ruttLager = null; }
  }

  /** Zooma så att hela rutten syns. Anropas EN gång, vid start. */
  visaHelaRutten(rutt) {
    if (!rutt?.punkter?.length) return;
    this.follow = false;
    this.map.fitBounds(L.latLngBounds(rutt.punkter), { padding: [40, 60] });
  }
```

Kopplingen:

```js
karta.ritaRutt(navigering.publikRutt());          // vid start
karta.visaHelaRutten(navigering.publikRutt());    // vid start, en gång

// vid omritning (moveend/zoomend eller en egen 1 Hz-timer, INTE varje fix):
karta.ritaFramsteg(navigering.linjeDelad());
```

### Manövernålar

`publikRutt().manovrar` är en färdig lista med `{ index, s, punkt, typ, fras,
kort, symbol, vagnamn }` för varje sväng. `punkt` är `[lat, lon]` på linjen.
Symbolerna är pilar (`↰ ↱ ↗ ↖ ⭯ ⚑`) avsedda för `L.divIcon`.

**Rotationen.** Kartan kan vara vriden (`js/kartrotation.js`). Symbolerna måste
in i ett `<span class="pv-upright">` precis som farornålarna i `#hazardIcon`,
annars ligger pilarna på sidan så fort man kör åt söder.

### Attribution

`docs/RUTT.md` noterar redan att **OSRM behöver läggas till i kartans
attribution när ruttläget kopplas in**. Det gäller fortfarande, och nu också
för svängbeskrivningarna:

```js
attribution: TILES.night.attribution + ' | Rutt: <a href="http://project-osrm.org/">OSRM</a>'
```

---

## Gränssnittet som behövs

Modulen levererar all data. Det som saknas är fyra ytor.

### 1. Manöverskylten — det enda som får läsas i körning

Överst, stor, och med bara tre saker på sig:

| Element | Källa | Storlek |
|---|---|---|
| Pil | `t.nastaManover.symbol` | minst 56 px |
| Avstånd | `shortDistance(t.nastaManover.avstandM)` | minst 32 px |
| Gata | `t.nastaManover.vagnamn` | 18 px, en rad, klipp med ellips |

Kedjas två svängar ihop finns `t.efterfoljande` ("sedan sväng vänster") som en
liten rad under. Är den `null` ska raden bort helt, inte visas tom.

### 2. Resefältet

`shortDistance(t.kvarM)` · `Math.round(t.kvarS / 60)` min ·
`new Date(t.ankomstTs).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })`

Klockslaget är det som folk faktiskt läser. "Framme 14:32" svarar på frågan;
"38 min kvar" kräver huvudräkning i en bil.

### 3. Tillstånden som inte är "kör på"

| `t.lage` | Vad som ska synas |
|---|---|
| `avvikande` | "Räknar om…" över manöverskylten. Dölj avstånd och gata — de är fel just då. |
| `framme` | Ersätt panelen med en avslutningsruta och en stor **Avsluta**-knapp. |
| — | `nav.varning` som en gul rad om den är satt. |

### 4. Start och avslut

Sökrutan finns redan (`RouteGuide.suggest()` / `searchDestinations()`, se
RUTT.md). Det som behövs är en **Avsluta navigering**-knapp som är nåbar med
tummen utan att man tittar, och som anropar `navigering.rensa()` plus
`karta.rensaRutt()`.

---

## API

```js
import {
  Navigering, Ruttlinje, NavigeringsFel,
  hamtaOsrmRutt, tolkaOsrmRutt, beskrivManover,
  NAV_PRIORITET, NAV_STANDARD, OSRM_VARDAR,
} from './js/navigering.js';
```

### Fristående funktioner

| Signatur | Gör |
|---|---|
| `hamtaOsrmRutt(start, mal, opts?) → Promise<{punkter, steg, distanceM, durationS, kalla}>` | Enda funktionen som rör nätet. `opts`: `{ timeoutMs = 8000, forsok = 3, vardar, hamta }`. `hamta` byter ut `fetch` — det är så testerna kör den utan uppkoppling. |
| `tolkaOsrmRutt(raw) → {punkter, steg, distanceM, durationS}` | Plattar ut `j.routes[0]`, vänder `[lon,lat]` till `[lat,lon]`, slår ihop alla `legs`. |
| `beskrivManover(steg) → {fras, kort, symbol, typ, modifier, vagnamn, mal, avfart, handling}` | Ett OSRM-steg till svenska. Ren funktion, inget tillstånd. `handling: false` betyder ett rent namnbyte som aldrig annonseras. |

### `new Navigering(opts?)`

`opts` skriver över `NAV_STANDARD`.

| Metod | Gör |
|---|---|
| `satt(rutt, { nu, orsak })` | Sätter rutten. `rutt`: `{ punkter, steg, geometri?, distanceM?, durationS?, mal? }`. `orsak`: `'ny'` (standard) eller `'omberakning'`. Returnerar `{ rutt, tal }`. Kastar `NavigeringsFel` om vägbeskrivningen saknas. |
| `uppdatera(fix, nu?) → tillstånd` | En GPS-fix. `fix`: `{ lat, lon, accuracy?, speedKmh?, ts? }`. Kastar `TypeError` utan tid. |
| `tillstand(nu, tal?)` | Samma objekt utan att mata in en fix. Konsumerar `begarOmberakning`. |
| `utlosare(fartKmh?)` | `{ fartKmh, langtM, snartM, nuM }` för den farten. |
| `linjeDelad() → { passerad, kvar }` | Rutten delad vid bilen, för kartan. |
| `publikRutt()` | `{ punkter, distanceM, durationS, mal, manovrar[] }`. |
| `beskriv()` | En rad: `"Sväng höger om 800 m · 1,8 km kvar, 2 min"`. |
| `rensa()` | Allt bort. |

### Tillståndsobjektet

```js
{
  lage: 'ingen' | 'navigerar' | 'avvikande' | 'framme',
  framme: boolean,
  s: 1200,                    // meter längs rutten
  lateralM: 4,                // avstånd från mittlinjen
  kvarM: 1797,
  kvarS: 129,
  ankomstTs: 1700000129000,
  stegIndex: 0,
  steg: { …OSRM-steget vi kör på… },
  nastaManover: {
    fras: 'sväng höger in på Drottninggatan',
    kort: 'sväng höger',
    symbol: '↱',
    typ: 'turn', modifier: 'right',
    vagnamn: 'Drottninggatan', mal: '', avfart: null, handling: true,
    stegIndex: 1, avstandM: 798, s: 1998, punkt: [59.6099, 16.5807],
  },                          // alltid nästa SVÄNG — namnbyten hoppas över
  efterfoljande: null,        // 'sedan sväng vänster' vid kedjade svängar
  fart: { gpsKmh: 50.0, beslutKmh: 50.0 },
  utlosare: { fartKmh: 50, langtM: 764, snartM: 250, nuM: 56 },
  avvikFixar: 0,
  omberakningar: 0,
  begarOmberakning: null,     // eller { lat, lon } — konsumeras vid läsning
  varning: null,
  tal: [ /* 0–2 yttranden */ ],
}
```

### Yttrandet

```js
{
  typ: 'sväng' | 'resa' | 'start' | 'ankomst' | 'omberakning' | 'omberaknad' | 'uppgivet',
  fas: 'langt' | 'snart' | 'nu' | null,
  text: 'Om 250 meter, sväng höger in på Drottninggatan.',
  prioritet: 0,               // alltid NAV_PRIORITET
  avbryt: false,              // alltid
  skapadTs, giltigTillTs,
  stegIndex, avstandM, manover,
}
```

---

## När något sägs

Fast avstånd går inte att försvara. Tvåhundra meter är fjorton sekunder i
50 km/h — lagom för att hinna byta fil och bromsa in. Samma tvåhundra meter är
sex och en halv sekund i 110 km/h, ungefär den tid det tar att förstå meningen.
Vid det laget är avfarten redan förbi.

Horisonten räknas därför i **sekunder** och multipliceras med farten vid **varje
fix**. Golv och tak i meter håller den vettig i ytterlägena.

| Fas | Sekunder | Golv | Tak | 30 km/h | 50 km/h | 90 km/h | 110 km/h |
|---|---|---|---|---|---|---|---|
| `langt` | 55 | 500 m | 2500 m | 500 m | 764 m | 1375 m | 1681 m |
| `snart` | 18 | 120 m | 600 m | 150 m | **250 m** | 450 m | **550 m** |
| `nu` | 4 | 25 m | 120 m | 33 m | 56 m | 100 m | 120 m |

`snart` är huvudbeskedet. `langt` ger tid att lägga sig i rätt fil på motorväg.
`nu` är kort och utan gatunamn — vid femtiofem meters marginal finns det inte
tid att höra "in på Sankt Olofsgatan".

### Gatnätsregeln — varför staden och motorvägen låter olika

Ett steg som är 200 m långt kan inte förvarnas 550 m i förväg; beskedet skulle
komma före föregående sväng och föraren höra två motstridiga instruktioner
samtidigt. Ett besked fyrar därför bara om steget är minst 1,1 gånger så långt
som utlösningsavståndet.

Det är den regeln som gör att modulen beter sig rätt i Västerås centrum och på
E18 **utan att veta vilket den kör i**. I stan är stegen 150–300 m och bara `nu`
hinner fyra; på motorvägen är stegen kilometerlånga och alla tre fyrar. Att
beskeden faller bort i tätorten kompenseras av sammanlänkningen: ligger nästa
sväng inom 150 m sägs båda i samma mening — *"Om 250 meter, sväng höger in på
Kort gata, sedan sväng vänster."*

### Farten som besluten räknas på

Blandningen är `max(GPS-fart, vägens egen fart × 0,6, 20 km/h)`.

Vägens fart kommer ur OSRM:s egna steg (längd delat med tid). Poängen syns i kö
på motorvägen: GPS säger 4 km/h, men avfarten kommer att passera i hundra så
fort kön släpper, och en förvarning på hundra meter vore då för sent. **Uppmätt
i test:** GPS 4 km/h på ett steg OSRM tidsatt till 100 km/h ger beslutsfart
60 km/h och en förvarning på 300 m i stället för 120 m.

Golvet på 20 km/h är viktigare än det ser ut. Står man still vid rödljus är
farten noll, och noll gånger arton sekunder är noll meter — utan golv skulle
ingenting sägas och föraren stå kvar i fel fil.

### Namnbyten sägs aldrig

OSRM lägger in ett steg varje gång vägen byter namn, även när man kör rakt fram
utan att göra någonting. Första provkörningen Västerås → Drottninggatan
Stockholm gav sju stycken **"Fortsätt nu."** Det är precis den sortens brus som
får folk att stänga av rösten — och stänger man av rösten missar man
polisvarningarna, vilket är det enda som verkligen kostar pengar.

Manövrer av typen `new name` och `notification`, samt `continue` utan
riktningsmodifierare, annonseras därför aldrig. I stället räknas avståndet
**förbi** dem, hela vägen fram till nästa manöver som kräver att man vrider på
ratten. Det är också mer hjälpsamt: *"om 1,4 kilometer, håll vänster"* är sant
och användbart även om vägen hinner byta namn två gånger på vägen dit.

Samma sak gäller manöverskylten i gränssnittet: `t.nastaManover` pekar alltid på
nästa **sväng**, aldrig på ett namnbyte. En förare som ser "Fortsätt · 1,4 km"
har inte fått veta något.

`beskrivManover()` sätter `handling: false` på de här stegen om gränssnittet
behöver veta.

### Ankomsten har inget "nu"-läge

Framme-tröskeln (60 m) och `nu`-fönstret (upp till 120 m) överlappar, så i
högre fart fyrade båda och föraren hörde *"Du är framme."* och sedan *"Du är
framme vid Drottninggatan."* med några sekunders mellanrum. Manöverbeskedet är
det överflödiga och har tagits bort. *"Om 350 meter, du är framme, målet ligger
på höger sida"* finns kvar — den säger något det andra inte gör, nämligen att
börja titta åt höger.

### Att ingenting sägs två gånger

Varje `(steg, fas)` sägs högst en gång, någonsin. Fyrar `nu` markeras `snart`
och `langt` som avklarade i samma veva: hinner man ända fram utan att ha hört
förvarningen finns ingen anledning att säga den efteråt. Mellan besked är det
5 sekunders paus — utom för `nu`, som handlar om något som händer inom några
sekunder och aldrig får hållas tillbaka.

---

## Svenskan

OSRM:s modifierare betyder olika saker beroende på manövertyp. `left` efter en
`turn` är en korsning man svänger i; `left` efter en `fork` är en fil man lägger
sig i. Att säga "sväng vänster" i en vägdelning får folk att bromsa in mitt på
motorvägen.

| OSRM | Sägs |
|---|---|
| `turn` + `right` | sväng höger in på Drottninggatan |
| `turn` + `slight left` | håll till vänster in på … |
| `fork` + `slight left` | **håll vänster** mot E18 |
| `merge` + `left` | **fila in** till vänster på E18 |
| `off ramp` + `slight right` | ta avfarten till höger, avfart 132 mot Stockholm och Enköping |
| `on ramp` | ta påfarten till höger mot … |
| `roundabout` + `exit: 3` | kör av vid **tredje** avfarten i rondellen in på Vasagatan |
| `roundabout` utan `exit` | kör in i rondellen |
| `end of road` + `right` | sväng höger vid vägens slut in på … |
| `new name` | fortsätt på E18 |
| `arrive` + `left` | du är framme, målet ligger på vänster sida |
| okänd typ | fortsätt |

Tre val värda att motivera:

- **"Fila in", inte "smält samman".** Det senare är den ordagranna
  översättningen av `merge` och ingen svensk säger det. "Fila in" är vad en
  trafikskola säger.
- **Rondell utan `exit` gissar inte.** OSRM utelämnar ibland avfartsnumret. Att
  säga "första avfarten" när vi inte vet vore att hitta på, och en förare som
  svänger av en gång för tidigt på grund av oss litar aldrig på nästa besked.
- **Vägnummer sägs bara när gatunamn saknas.** Är båda satta blir "Vasagatan
  E18" två vägar i örat. Både `vagnamn` och `mal` finns i objektet, så
  gränssnittet får gärna visa mer än rösten säger.

---

## Av rutten

Kravet var att en enstaka dålig fix aldrig får utlösa en omräkning, och det går
inte att uppfylla med bara ett avstånd. En telefon i en tunnel eller mellan
höghus kan svara tre hundra meter fel, en gång, och sedan vara helt rätt igen.
Räknas det som en avfart får föraren "räknar om" mitt på raksträckan och slutar
lita på appen.

Fyra villkor måste vara uppfyllda **samtidigt**:

1. Sidoavståndet överstiger `max(50 m, noggrannhet × 1,5)`. En osäker fix höjer
   alltså ribban i stället för att sänka den.
2. Det har hänt **4 gånger i rad**.
3. Bilen har faktiskt förflyttat sig **80 m** sedan det började. Fyra dåliga
   fixar från en bil som står stilla är brus, inte en avfart.
4. Det har gått **4 sekunder**. Skyddar mot att en skur av fixar inom en sekund
   räknas som fyra oberoende observationer.

Fixar med sämre noggrannhet än **100 m** räknas varken upp eller ner. De säger
ingenting om var bilen är, och att låta dem nollställa räknaren vore lika fel
som att låta dem fylla den.

I praktiken: en missad avfart i 90 km/h upptäcks efter ungefär fyra sekunder. I
30 km/h i tätort tar det tio, vilket är rätt — där ligger gatorna tätt och en
tidig gissning blir ofta fel.

**Omräkningstakten** är minst 15 sekunder mellan begäranden och högst 10 per
resa. I en trafikplats är man "av rutten" varannan sekund; utan paus skulle OSRM
få femton anrop på en halv minut och föraren höra "räknar om" som en papegoja.
Uppmätt: 40 sekunder rakt ut i terrängen ger **3** begäranden, inte 40.

Slår taket i sägs *"Jag hittar inte tillbaka till rutten. Välj resmål igen när
du står stilla."* en gång, och sedan är det tyst. Att fortsätta mala hjälper
ingen.

Medan `lage === 'avvikande'` sägs **inga** svängbeskrivningar. Vi vet inte var
bilen är på rutten, och att gissa är sämre än att tiga. Kommer föraren tillbaka
på vägen av sig själv — vilket händer hela tiden i trafikplatser där rätt fil
ligger femtio meter från mittlinjen — släcks tillståndet utan omräkning och utan
att något sägs.

---

## Externa tjänster — vad de faktiskt lovar

Det här avsnittet finns för att ingen ska bli förvånad i produktion.

### OSRM:s demoserver har ingen SLA, och villkoren nämner betalande kunder

Villkor: <https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy>

Ordagrant ur policyn:

- *"We don't give any quality guarantees. The Demo Server is supplied on best
  effort basis."*
- *"Access to the Demo Server shall be withdrawn at any time and without giving
  a reason."*
- Om kommersiell användning: **"you may no longer be able to serve your paying
  customers if access is withdrawn"**.

Ingen sifferbegränsning är dokumenterad; formuleringen är "excessive use is not
allowed" och att man blockeras om man påverkar driftstabiliteten.

**Polisvakt tar 99 kr i månaden.** Den sista punkten är alltså inte en teoretisk
risk utan en beskrivning av vår situation. Vi driver en betaltjänst på en
gratisserver vars ägare uttryckligen har skrivit ned att de kan stänga av oss
utan förklaring, och som inte har lovat oss någonting.

#### Vad som händer i appen när den inte svarar

| Läge | Vad modulen gör | Vad föraren upplever |
|---|---|---|
| Nytt resmål, OSRM nere | `hamtaOsrmRutt` provar 3 gånger över 2 värdar med 8 s timeout var, kastar sedan `NavigeringsFel` med `kod: 'nat'` eller `'timeout'` | Upp till ~25 sekunders väntan och sedan ett felmeddelande. **Ingen rutt alls.** Polisvarningarna i radie-/stadsläge fungerar som vanligt. |
| Omräkning misslyckas | Rutten ligger kvar, `lage` förblir `avvikande` | **Tyst.** Inga svängbeskrivningar, ingen ny väg. Appen fortsätter varna för polis, men navigeringen är död tills föraren kör tillbaka på rutten eller väljer om. |
| Mitt i en resa, OSRM nere | Ingenting händer | **Allt fungerar.** Rutten är redan hämtad och all beslutslogik är lokal. Det är först vid en avvikelse det märks. |

Det sista är den enda goda nyheten här: modulen behöver nätet **en gång per
resa**. Kör man rätt märks ett OSRM-avbrott aldrig.

#### Vad som krävs för att det ska vara pålitligt på riktigt

I ordning efter hur mycket de kostar:

1. **Egen OSRM.** `osrm-backend` i en container med Sverige-extraktet från
   Geofabrik (ungefär 1,5 GB, förbehandling kräver ~8 GB RAM en gång). Kör man
   `MLD`-profilen går en VPS med 4 GB RAM och två kärnor bra för hela Sverige.
   Kostnad i storleksordningen 10–20 euro i månaden hos Hetzner eller motsvarande.
   Uppdatera extraktet en gång i månaden. **Det här är det rätta svaret** — det
   tar bort både SLA-problemet och takproblemet, och rutter är billiga att räkna.
2. **Betald tjänst med avtal.** Mapbox Directions, Google Routes, HERE eller
   Stadia. Kostar per anrop men ger körfältsanvisningar och trafik på köpet,
   vilket ingen självhostad OSRM ger. Kräver nyckel, och nyckeln får inte ligga
   i en statisk PWA utan måste gå via en proxy.
3. **Behåll demoservern, men bara som reserv.** Det som redan finns — två
   värdar, tre försök — är ungefär allt man kan göra utan att flytta.

Tills något av det är gjort bör produktbeskrivningen inte lova navigering som en
funktion man kan räkna med, bara som en funktion som finns.

### Nominatim — appen följer villkoren, och det är inte gratis i bekvämlighet

Villkor: <https://operations.osmfoundation.org/policies/nominatim/>

Kraven och vad appen gör, kontrollerat i `js/geocode.js`:

| Krav | Uppfylls? | Hur |
|---|---|---|
| Max 1 anrop/sekund | **Ja** | `nominatimSlot()` serialiserar *alla* anrop i hela appen genom en kö. Kön är global med flit: två moduler som var för sig håller gränsen bryter tillsammans mot den. |
| Identifiering (User-Agent **eller** Referer) | **Ja, via Referer** | Webbläsare tillåter inte att JavaScript sätter `User-Agent`. Referer är den andra godkända vägen och skickas av webbläsaren själv. Egna huvuden läggs medvetet inte på — de skulle utlösa en CORS-preflight som Nominatim inte svarar på. |
| Resultat måste cachas | **Ja** | Varje svar sparas i `localStorage` (`pv.geocache.v1`, `pv.searchcache.v1`). |
| **Autocomplete är förbjudet** | **Ja** | `searchPlaces()` får bara anropas på ett knapptryck och har dessutom en egen spärr mot samma fråga två gånger och mot oftare än var 1,5:e sekund. `localSuggestions()` svarar direkt ur cachen och de inlärda platserna utan att röra nätet. |

Priset betalas i gränssnittet: **sökrutan kan inte söka medan man skriver.**
Förslagen som dyker upp medan man knappar kommer bara från cachen och
aliasregistret för Västmanland. Det är inte en brist i implementationen, det är
villkoren. Vill man ha riktig autocomplete krävs en egen Photon- eller
Nominatim-instans, eller en betald geokodare.

Sanktionen för att bryta mot det är enligt policyn blockering, och den drabbar
hela appens IP-intervall — alltså alla användare samtidigt.

### Trafik finns inte. Alls.

Waze bygger halva sitt värde på trafik i realtid. **Vi har ingen trafikdata och
kan inte få någon.** Det ska sägas rakt ut i stället för att antydas bort.

Konkret betyder det:

- **ETA är skyltade hastigheter, inte verklighet.** Restiden kvar summerar
  OSRM:s egna stegtider, som bygger på vägtyp och skyltad hastighet. En
  fredagseftermiddag på E18 in mot Stockholm är den optimistisk med tiotals
  minuter. Modulen räknar korrekt på fel underlag.
- **Rutten väljs utan att veta om den är full.** OSRM ger den kortaste vägen i
  tid enligt kartan. Står det stilla på den vägen får vi aldrig veta det, och vi
  kommer inte att föreslå omvägen.
- **Ingen omdirigering vid olycka.** Vi kan inte säga "trafikstockning framför,
  ny väg sparar 12 minuter". Det är den funktionen folk mest förknippar med
  Waze och den är utom räckhåll.
- **Inga vägarbeten, avstängningar eller vägavgifter.** Kartan är så färsk som
  senaste OSM-extraktet. En avstängd gata dyker upp som en avvikelse och en
  omräkning, alltså som en bugg fast det inte är en.

Vad som **delvis** kompenserar: ETA:n räknas per steg i stället för linjärt över
hela rutten, så en rutt som blandar motorväg och stadstrafik får rätt fördelning
mellan dem. Uppmätt i test: med 8 km motorväg avklarad och 2 km stadstrafik kvar
svarar modulen **239 sekunder**; facit är 240, medan en linjär skalning av
totaltiden mot återstående sträcka hade svarat 106 — en och en halv minut fel.

---

## Vad det här inte är

Ärlig lista över var Waze är bättre och varför.

| | Waze | Polisvakt |
|---|---|---|
| Trafik i realtid | Ja, från miljontals bilar | **Nej.** Se ovan. |
| Omdirigering vid stockning | Ja | **Nej.** |
| Körfältsanvisning ("lägg dig i vänster fil") | Ja | **Nej.** OSRM har `intersections[].lanes` i svaret men det är oanvänt här. Det är byggbart — se nedan. |
| Hastighetsbegränsning i rutan | Ja | Delvis, `js/speedlimit.js` är en separat väg |
| 3D-vy och filbilder inför avfarter | Ja | **Nej.** Leaflet är en 2D-karta. |
| Alternativa rutter att välja mellan | Ja | **Nej.** `alternatives=false`. Kör man en annan väg upptäcks det som en avvikelse och rutten räknas om. |
| Mellanstopp | Ja | Modulen klarar flera `legs`, men gränssnittet för att lägga till dem finns inte. |
| Ankomsttid som delas med någon | Ja | **Nej.** |
| Fungerar i bakgrunden | Ja (native) | **Nej.** Se BEHORIGHETER.md — appen måste vara öppen och framme. Det gäller navigeringen precis som varningarna. |
| Sparade rutter mellan sessioner | Ja | **Nej.** Rutten ligger i minnet. Stängs appen är den borta. |
| Polisvarningar med korridorlogik | Grovt | **Ja, bättre.** Se RUTT.md. Det är här produkten faktiskt vinner. |

Ytterligare tre saker som är värda att veta:

**Tunnlar.** Utan GPS står positionen stilla på rutten och avstånden fryser. När
signalen kommer tillbaka hittar fönstersökningen rätt igen (den söker upp till
8 km framåt), men under tiden är beskeden fel. En avfart inne i en tunnel
kommer att missas.

**Rutter som passerar samma korsning två gånger.** Manövrarnas lägen räknas
aritmetiskt ur OSRM:s egna stegdistanser och inte genom att projicera
manöverpunkterna, just för att en slinga annars skulle kunna lägga en manöver på
fel varv. Det är löst. Men `Ruttlinje.nearest()` kan fortfarande välja fel varv
om appen legat i bakgrunden så länge att fönstersökningen ger upp mitt i en
slinga.

**Körfältsanvisning är närmare än man tror.** OSRM ger redan
`steps[].intersections[].lanes` med `valid`-flaggor per fil när man frågar med
`steps=true`, alltså finns datan i svaret vi redan hämtar. Det som saknas är en
tolkning till svenska ("lägg dig i någon av de två vänstra filerna") och en
grafisk fil-rad i gränssnittet. Det är ett avgränsat arbete och den enskilt
största upplevelseförbättringen som är kvar.

---

## Testresultat i siffror

`navigering-test.html`, körd mot `serve.ps1` på port 8251: **61 av 61 gröna, 0
misslyckade, 0 hoppade.** Inget nätverk, ingen karta, ingen riktig klocka.

### Provkörning mot riktig OSRM

Utöver enhetstesterna kördes hela kedjan mot den skarpa demoservern med
ägarens eget exempel — **Västerås centrum → Drottninggatan, Stockholm**:

| | |
|---|---|
| Svar från | `router.project-osrm.org` |
| Rutt | 106 km, 84 minuter, 19 steg, 1409 geometripunkter |
| Samstämmighetsvarning | ingen |
| Start | *"Rutt till Drottninggatan, 106 kilometer, ungefär 84 minuter."* + *"Kör ut på Erik Hahrs gata."* |
| Antal talade besked hela vägen | **23** i 90 km/h |
| Före namnbytesfixen | 26, varav 7 var *"Fortsätt nu."* |

Ett urval av vad som faktiskt sägs:

```
nu:    Sväng vänster nu, sedan sväng höger.
nu:    Ta påfarten till höger nu.
langt: Om 1,4 kilometer, håll vänster mot Kistapåfarten.
snart: Om 450 meter, håll vänster mot Kistapåfarten.
nu:    Håll vänster nu.
snart: Om 450 meter, fila in till vänster på Uppsalavägen.
snart: Om 450 meter, kör rakt fram in på Norrtullsavfarten, sedan håll vänster.
nu:    Sväng vänster nu, sedan är du framme.
ankomst: Du är framme vid Drottninggatan.
```

Provkörningen är också vad som avslöjade de två felen ovan — namnbytesbruset och
den dubbla ankomsten. Ingen av dem syntes i enhetstesterna, för ingen syntetisk
provbana innehöll ett namnbyte. **Kör om den mot skarp OSRM efter större
ändringar**, det är billigt och det hittar saker.

Uppmätt av testerna (`window.__resultat.matt`):

| Vad | Värde |
|---|---|
| Steg valt mitt på rutten | steg 0, 998 m till svängen (facit 1000) |
| Utlösningsavstånd 50 km/h | långt 764 m · snart 250 m · nu 56 m |
| Utlösningsavstånd 110 km/h | långt 1681 m · snart 550 m · nu 120 m |
| Förvarning fyrade faktiskt vid | 50 km/h: **248 m** · 110 km/h: **531 m** |
| Faser per sväng under en hel resa | `1:langt 1`, `1:snart 1`, `1:nu 1` — inga upprepningar |
| Rutt med två namnbyten före svängen | 0 besked innehåller "Fortsätt"; avståndet räknas förbi till 2996 m (facit 3000) |
| "Du är framme" i 90 km/h | exakt **1** besked, inte 2 |
| Tätortsbana (150 m mellan svängar) | endast fasen `nu` fyrade |
| Kedjat besked | "Om 250 meter, sväng höger in på Kort gata, sedan sväng vänster." |
| "Nu"-beskedet | "Sväng höger nu." på 53 m |
| Kö: GPS 4 km/h på 100-väg | beslutsfart 60 km/h, förvarning 300 m |
| En enstaka dålig fix | läge `navigerar`, räknare 1, ingen begäran |
| Verklig avvikelse | slog till vid fix **4**, efter **4,5 sekunder** |
| 40 s utanför rutten | **3** omräkningsbegäranden, **1** "räknar om"-besked |
| 10 fixar med 250 m osäkerhet | ingen avvikelse alls, räknare 0 |
| Nödbroms (tak satt till 2) | 2 begäranden, sedan 1 uppgivet-besked och tystnad |
| Avstånd kvar | 2997 m → 1497 m över 110 fixar, 109 minskningar, 0 ökningar |
| Restid kvar (8 km motorväg + 2 km stad) | **239 s** (facit 240; linjär skalning hade gett 106) |
| Ankomst | läge `framme`, exakt 1 besked: "Du är framme vid Drottninggatan." |
| Yttranden med fel prioritet | **0 av 8** |
| Serverbyte vid 503 | `router.project-osrm.org` → `routing.openstreetmap.de` |

### Att köra testerna

```powershell
Start-Process powershell -ArgumentList '-NoProfile','-File','.\serve.ps1','-Port','8251' `
  -WindowStyle Hidden -WorkingDirectory '<repo>'
# öppna http://localhost:8251/navigering-test.html
```

Resultatet ligger också i `window.__resultat` som `{ ok, fel, hopp, total, matt }`.
