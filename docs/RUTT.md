# Ruttvarningar — polis på vägen dit du ska

Appen varnar i dag för det som är **nära**. Den här modulen varnar för det som
ligger **framför dig på din väg**. Det låter som en liten skillnad men det är
det inte: en civilbil tvåhundra meter bort på en parallellgata du aldrig
kommer köra på är brus som får föraren att sluta lyssna, medan en kontroll
fyra kilometer fram på samma väg är det mest användbara appen kan säga.

Koden ligger i `js/rutt.js`. Resmålssökningen bor i `js/geocode.js`.
Modulen rör aldrig DOM och pratar aldrig själv — den räknar och skickar
händelser. Rösten äger `js/alerts.js`.

---

## Innehåll

1. [Så byggs rutten](#så-byggs-rutten)
2. [Korridoren — vad som räknas som "på min väg"](#korridoren)
3. [Framförhållning — när något sägs](#framförhållning)
4. [Överlämningen till alerts.js](#överlämningen)
5. [Avvikelse och omräkning](#avvikelse-och-omräkning)
6. [Position längs rutten](#position-längs-rutten)
7. [API och händelser](#api-och-händelser)
8. [Externa tjänster och deras gränser](#externa-tjänster)
9. [Vad det här inte klarar](#vad-det-här-inte-klarar)

---

## Så byggs rutten

Tre steg, i den ordningen:

**1. Resmålet slås upp** via Nominatim, hela Sverige men viktat mot föraren.
"Drottninggatan" finns i ett femtiotal svenska städer, och den i närheten är
nästan alltid den rätta. Se [Externa tjänster](#externa-tjänster) för hur
viktningen görs och varför det krävs två anrop ibland.

**2. Vägen räknas ut** av OSRM:

```
https://router.project-osrm.org/route/v1/driving/{lon},{lat};{lon},{lat}
  ?overview=full&geometries=geojson&alternatives=false&steps=false&annotations=false
```

`overview=full` är hela poängen. Standardsvaret ger en förenklad linje som
duger att rita men inte att mäta emot — den skär hörn, och i en avfartsslinga
hamnar den hundratals meter fel. Det är precis den storleksordning som hela
korridorlogiken arbetar i, så en förenklad linje hade gjort matchningen
värdelös. `steps` och `annotations` stängs av: de mångdubblar svaret utan att
tillföra något, vi behöver geometrin och inget annat.

En rutt Västerås–Stockholm blir ungefär **1 460 punkter över 106 km**, alltså
en punkt var sjuttionde meter.

**3. Index byggs en gång.** Vid ruttberäkningen räknas två saker fram som
sedan aldrig behöver räknas om:

- **Kumulativa avstånd** (`cum[i]` = meter längs rutten fram till punkt *i*).
  Det är den som gör "hur långt fram" till en subtraktion i stället för en
  summering.
- **Ett rutnät över segmenten**, celler på drygt en kilometer. Varje segment
  skrivs in i alla celler dess omslutande rektangel rör vid, så inget segment
  kan missas för att det korsar en cellgräns. En uppslagning tittar i cellen
  och dess åtta grannar.

---

## Korridoren

### Vad felet består av

Rutten från OSRM är vägens **mittlinje**. Avståndet från den till en rapport
består av tre fel som staplas på varandra:

| Felkälla | Storlek | Varför |
|---|---|---|
| Vägbredd | 30–40 m, trafikplats 100–150 m | Rapporten görs från vägrenen eller från andra körbanan. Svensk motorväg med mittremsa. |
| GPS-fel | 5–15 m öppet, 20–50 m i stadskärna | Signalen studsar mellan hus. Felet finns i **båda** ändar — i rapportens position och i förarens. |
| Geokodningsfel | upp till en kilometer | En röst- eller Facebook-rapport har ingen GPS. Nominatim svarar med en punkt någonstans på gatan. |

Uppåt begränsas korridoren av det den ska sortera bort: kvartersgator i en
svensk stadsplan ligger **60–120 m** isär, och parallellvägen bredvid en
större led ligger typiskt **80–150 m** bort.

### Valet

Det finns alltså ingen bredd som är rätt i båda ändarna. Valet blev:

```
bas          120 m     bred nog för båda körbanorna på en motorväg och en
                       rapport från vägrenen, smal nog att i regel inte
                       svälja grannkvarteret
+ GPS-fel    upp till 100 m, när rapporten bär sin egen felmarginal
+ geokodning +100 m, för rapporter med source 'voice' eller 'facebook'
tak          250 m
```

**Taket är den viktigaste av de tre siffrorna.** Utan det skulle en dåligt
geokodad rapport kunna göra hela innerstaden till "min väg".

Verifierat på en riktig rutt Västerås–Stockholm: en rapport 40 m vid sidan
(andra körbanan) fångas, en 200 m vid sidan (parallellväg) förkastas, och en
röstrapport 150 m vid sidan fångas tack vare påslaget.

### Flera passager

En rutt kan passera samma punkt flera gånger — en tur och retur, eller en
slinga runt ett kvarter. Därför sparas **alla** passager per rapport, inte
bara den närmaste. Frågan "hur långt fram" besvaras med **nästa** gång du kör
förbi, inte med den passage du redan är klar med.

På en tur-och-retur-rutt betyder det att en rapport en kilometer in på
utvägen först rapporteras som "1 km fram", och efter att du kört förbi den
som "6 km fram" — för du kommer faktiskt att passera den igen på hemvägen.

---

## Framförhållning

### Tid, inte meter

Fast avstånd fungerar inte. Fyra kilometer är två minuter på E18 och åtta
minuter i Västerås centrum. Horisonten räknas därför i **tid**, med golv och
tak i meter så den inte spårar ur i vare sig kö eller fri motorväg.

| | Tid | Golv | Tak | Vid 100 km/h |
|---|---|---|---|---|
| Förvarning | 120 s | 1 200 m | 5 000 m | 3,3 km |
| Nära-påminnelse | 30 s | 350 m | 1 000 m | 850 m |

**Två minuter** räcker för att byta fil, tänka om vid en avfart och lägga sig
rätt i hastighet — men är inte så tidigt att man hinner glömma bort det.

**Taket på fem kilometer** hänger ihop med hur länge en rapport lever. En
polisrapport gäller i 45 minuter (`TTL_MINUTES` i `store.js`), och något som
ligger längre bort hinner ofta bli inaktuellt innan man är framme.

### Talbudgeten

En tre mil lång rutt kan korsa ett dussin rapporter. Att läsa upp alla vid
start är obrukbart, och att upprepa var och en varje pollningscykel är aktivt
farligt i en bil. Fem regler:

1. **Högst en ruttvarning per 45 sekunder.** Blir flera aktuella samtidigt går
   den **närmaste** först — den är den föraren behöver agera på nu. Resten
   står kvar i tur och tas nästa varv.
2. **Varje rapport får högst en förvarning och en nära-påminnelse.** Aldrig
   mer, oavsett hur många GPS-fixar eller pollningar som passerar.
3. **Vid ruttstart sägs en sammanfattning** i stället för en varning per
   rapport: *"Rutt till Drottninggatan, 107 kilometer. Tre rapporter längs
   vägen. Närmast polis om 9 kilometer."* Allt som redan ligger inom
   horisonten räknas som förvarnat av sammanfattningen, men får sin
   nära-påminnelse när man faktiskt närmar sig.
4. **Inget sägs när bilen står stilla** (under 15 km/h).
5. **Inget sägs om rapporten hinner gå ut innan vi är framme.** Att säga "polis
   om fem kilometer" om något som försvinner om tre minuter lär föraren att
   varningarna inte stämmer. Bedömningen görs om varje varv — står man i kö
   när rapporten dyker upp är ETA:n tio minuter, men släpper kön är den två.

Resultat på en verifierad körning Västerås–Stockholm, 106 km, 86 minuter, med
fem rapporter på rutten: **tio repliker totalt**, alltså ungefär en var nionde
minut. Rapporten på parallellvägen nämndes aldrig.

### Sidan sägs inte högt

Händelsen bär `side: 'vänster' | 'höger'`, räknat ur korsprodukten mellan
segmentets riktning och rapportens läge. Den **sägs inte högt**. Punkten bär
både GPS-fel och geokodningsfel, och att säga "på höger sida" och ha fel är
sämre än att inte säga något alls: föraren tittar åt fel håll. Gränssnittet
får gärna visa det, rösten ska inte påstå det.

---

## Överlämningen

Det här är den svåraste delen, och den viktigaste.

`alerts.js` varnar för allt inom `hazardRadiusM` (1 500 m fågelvägen) oavsett
riktning. Skulle ruttmodulen varna i samma intervall hör föraren samma polis
**två gånger från två system**. Det är värre än att inte varna alls — man
slutar tro på appen.

Lösningen är att avståndet delas i två band med tydligt ägande, och att
ägandet bestäms **en gång per rapport**:

```
   ▲ avstånd fram längs rutten
   │
   │   ── horisont (3,3 km vid 100 km/h) ──────────────────────
   │                                            RUTT.JS ÄGER
   │   ── överlämning, 1 500 m ─────────────────────────────────
   │                                            ALERTS.JS ÄGER
   │   ── 0 m, du är framme vid faran ──────────────────────────
   ▼
```

- **Långt fält, bortom 1 500 m.** Ruttmodulen äger det, för den är den enda
  som vet att faran ligger på vägen och inte bara i närheten. Hinner den ta en
  rapport här *claimar* den rapporten — och tar då också nära-påminnelsen
  själv, med avstånd räknat längs vägen, vilket är rätt siffra.
- **Nära fält, innanför 1 500 m.** `alerts.js` äger det. Ser ruttmodulen en
  rapport först när den redan är där inne rör den inte den alls.

### Hur ägandet blir verkligt

`filterHazards(list)` filtrerar farolistan innan den går till närhetsmotorn.
Koppla in den där `coverage.filter(...)` redan sitter i `app.js`:

| Vad | Vad som händer | Varför |
|---|---|---|
| Fartkameror och annat `fixed` | **Går alltid igenom orörda** | `alerts.js` hanterar dem riktningsberoende och den logiken ska ruttläget aldrig peta i |
| Rapporter utanför korridoren | Faller bort | Hela poängen med ruttläget — parallellgatan är brus |
| Rapporter vi claimat | Faller bort | Vi har sagt till och tar påminnelsen själva |
| Rapporter vi kört förbi | Faller bort | Fågelvägen kan de ligga hundra meter bort, men de är avklarade |
| Resten | Går igenom | Dök upp när de redan var nära — då är närhetsvarningen helt rätt |

**Är rutten inte igång — ingen rutt, avvikelse, framme — släpps allt igenom
oförändrat.** Modulen får aldrig kunna tysta appen genom att gå sönder.

> **Viktigt vid inkoppling:** sätt `handoffM` till samma värde som appens
> `hazardRadiusM`. Ändrar föraren radien i inställningarna måste den här följa
> med, annars uppstår antingen en glipa där ingen varnar eller en överlappning
> där båda gör det.

---

## Avvikelse och omräkning

Att varna för en väg föraren har **lämnat** är det värsta felet modulen kan
göra. Tröskeln för att sluta lita på rutten är därför låg — men den kräver
uthållighet, för en enda tokig GPS-fix i en tunnel eller mellan höghus ska
inte räknas som en avfart.

Avvikelse kräver **tre saker samtidigt**:

```
sidoavstånd  >  max(60 m, GPS-noggrannhet × 1,5)
antal fixar  ≥  4 i rad
förflyttning ≥  120 m sedan det började
```

Att mäta mot `GPS-noggrannhet × 1,5` är avsiktligt: en dålig fix **höjer**
ribban i stället för att utlösa en omräkning.

Sedan händer det här:

1. `deviation` skickas.
2. **Alla varningar tystnar.** `update()` returnerar tomt medan `offRoute` är
   sant. Hellre tyst i tjugo sekunder än varningar om fel väg.
3. En ny rutt hämtas från nuvarande position till samma resmål, tidigast
   20 sekunder efter förra omräkningen och högst 12 gånger per resa (spärr mot
   att mala OSRM i en rondell).
4. Går hämtningen inte igenom ligger den gamla rutten kvar, men `offRoute`
   står kvar också — alltså fortsatt tystnad — tills nästa försök lyckas.
5. Kör föraren tillbaka in på rutten själv (vanligt i en trafikplats) släcks
   `offRoute` utan omräkning.

**Vid omräkning behålls minnet av vad föraren redan hört.** Det är samma
poliser som står där. Att tömma listan hade betytt att hela rutten läses upp
igen varje gång man missar en avfart. Ett **nytt resmål** nollställer däremot
allt.

---

## Position längs rutten

Det här körs för varje GPS-fix, i en telefon som samtidigt ritar karta och
spelar musik. Två saker gör det billigt:

**Ett fönster i stället för hela rutten.** Vi vet ungefär var vi var förra
sekunden och hur fort vi kör, alltså behöver bara ett kort stycke av rutten
testas — några tiotal segment i stället för tiotusen. Fönstret är generöst
framåt (tre gånger den sträcka farten medger, plus 200 m) så att en tappad
minut i en tunnel inte tappar bort oss, och kort bakåt eftersom man sällan
backar. Bara när fönstret inte ger en rimlig träff görs en rutnätssökning över
hela rutten.

**Projektionerna cachas per rutt.** En rapport står stilla och rutten ändras
inte, så var på rutten en rapport hör hemma räknas ut **en gång** per rapport
och rutt. Det enda som ändras varje sekund är var föraren är, och det är en
subtraktion.

All projektion görs i ett lokalt platt meterplan i stället för med trigonometri.
Över segment på tiotals till hundratals meter är felet från att ignorera
jordens krökning långt under en meter.

**Uppmätt:** 0,005 ms per GPS-fix över 3 787 fixar på en 106 km lång rutt med
sex rapporter. Att matcha om alla rapporter från grunden tar 0,6 ms.

---

## API och händelser

```js
import { RouteGuide } from './rutt.js';

const guide = new RouteGuide(store, { handoffM: settings.hazardRadiusM });
```

### Metoder

| Metod | Vad den gör |
|---|---|
| `suggest(text)` | Förslag **utan nätanrop**, ur cache och inlärda platser. Får anropas medan föraren skriver. |
| `await searchDestinations(text)` | Sök resmål. **Bara på ett knapptryck**, aldrig medan man skriver. |
| `await setDestination(dest, from?)` | Sätt resmål och räkna ut rutten. `dest` är en träff från sökningen eller en fri textsträng. |
| `await recalculate(from?)` | Räkna om till samma resmål. |
| `clearRoute()` | Släng rutten. |
| `update(fix)` | **Anropas för varje GPS-fix.** Returnerar `{ progress, alerts }`. |
| `onReportsChanged()` | Anropas när pollningen hämtat nya rapporter. Städar cachen. |
| `matches()` | Alla rapporter i korridoren framför, närmast först. |
| `aheadList(limit)` | Samma sak, formaterat för en lista i gränssnittet. |
| `filterHazards(list)` | Filtrera farolistan innan den går till `alerts.js`. Se [Överlämningen](#överlämningen). |
| `isClaimed(id)` | Har ruttvakten tagit ansvar för rapporten? |
| `noteFix(fix)` | Kom ihåg positionen. Anropas av `update()`, men behövs innan någon rutt finns så sökningen kan viktas. |
| `describe()` | Svensk statusrad. |
| `publicRoute()` | Serialiserbar bild av rutten, `points` i `[lat, lon]` — samma form som kartan vill ha. |

### Händelser

| Händelse | `detail` | När |
|---|---|---|
| `route` | `{ route, reason }` | Ny rutt. `reason` är `new`, `recalc` eller `rejoined`. |
| `route-cleared` | – | Rutten är borta. |
| `route-summary` | `{ spoken, count, distanceM, durationS, matches }` | En mening att säga vid start. |
| `route-alert` | `{ id, hazard, stage, distance, lateral, side, spoken, priority, onRoute }` | En varning ska läsas upp. `stage` är `ahead` eller `imminent`. `distance` är **längs rutten**. |
| `progress` | `{ s, remainingM, etaS, ahead, nextM }` | Varje GPS-tick. |
| `deviation` | `{ lateral, at }` | Föraren har lämnat rutten. |
| `recalculating` | `{ from }` | Ny rutt hämtas. |
| `arrived` | `{ destination }` | Under 150 m kvar. |
| `error` | `{ message, reason }` | Kunde inte hämta. `message` är på svenska och går att visa direkt. |

### Typer som aldrig ger en ruttvarning

`ROUTE_ALERT_TYPES` är `police`, `control` och `unmarked`. Det är en
**tillåtelselista med flit** — dyker en ny typ upp i databasen blir den tyst
här tills någon aktivt lägger till den.

- **Nykterhets- och drogkontroller** rapporteras inte i appen över huvud taget.
  Filtret sitter i `parser.js` och gäller rösten, knapparna och
  Facebook-flödet på en gång. Den här modulen öppnar ingen ny väg in.
- **Fartkameror** är undantagna även när de är riktiga och inlagda.
  `alerts.js` har redan en kameralogik som är bättre än allt en korridortest
  kan åstadkomma: den skalar avståndet med hastigheten och kollar att du
  faktiskt kör mot kamerans mätriktning. En andra kamerakälla ovanpå den hade
  bara gett dubbla varningar för något som står stilla.

### Att koppla in

Modulen är inte inkopplad. Den som gör det behöver:

1. Anropa `guide.update(fix)` i `geo`-lyssnaren i `app.js`.
2. Skicka `store.active()` genom `guide.filterHazards(...)` innan
   `engine.evaluate(...)`.
3. Lyssna på `route-alert` och `route-summary` och skicka `spoken` till
   `speaker.say(...)`.
4. Anropa `guide.onReportsChanged()` på `store`-händelsen `change`.
5. Rita `guide.publicRoute().points` på kartan.
6. **Lägga till `js/rutt.js` i filerna som `sw.js` cachar**, annars fungerar
   inte offline-läget för den här modulen.

---

## Externa tjänster

### Nominatim (OpenStreetMap) — resmålssökning

Gratis, drivs av donerade servrar.
Villkor: <https://operations.osmfoundation.org/policies/nominatim/>

| Krav | Hur appen håller det |
|---|---|
| **Max 1 anrop/sekund** | En **enda global kö** i `geocode.js` serialiserar alla anrop — sökning, rapportgeokodning och omvänd uppslagning. Kön är avsiktligt gemensam: två moduler som var för sig håller ett anrop per sekund bryter tillsammans mot gränsen. Uppmätt minsta mellanrum: 1,17 s. |
| **Identifiering krävs** | Webbläsare tillåter inte att JavaScript sätter `User-Agent`. Identifieringen sker via `Referer`, som webbläsaren själv skickar med appens adress — den andra av de två godkända vägarna i villkoren. Egna huvuden läggs medvetet **inte** på, de skulle utlösa en CORS-preflight som Nominatim inte svarar på. |
| **Cachning krävs** | Varje svar sparas i `localStorage` (`pv.searchcache.v1`, max 50 sökningar). Villkoren säger rakt ut att den som skickar samma fråga om och om igen kan bli blockerad. |
| **Autocomplete förbjudet** | Sökning medan man skriver är **uttryckligen otillåten**. Se nedan. |

#### Därför finns ingen sökning medan man skriver

Villkoren förbjuder autocomplete rakt av. Uppgiften bad om hårt debouncad
sökning-medan-man-skriver; det går inte att förena med villkoren, så det är
löst så här i stället:

- `localSuggestions()` / `guide.suggest()` svarar **direkt ur cachen och de
  inlärda platserna, utan att röra nätet**. Kostar noll, fungerar offline, och
  får anropas hur ofta som helst. Det är den ett sökfält ska koppla till
  `oninput`.
- `searchPlaces()` / `guide.searchDestinations()` går ut på nätet och får bara
  anropas på ett faktiskt knapptryck.
- Som skydd mot att någon ändå kopplar fel har `searchPlaces()` en **egen
  spärr**: samma fråga två gånger går aldrig ut på nätet, och två olika frågor
  tätare än 1,5 sekund gör det inte heller.

#### Viktningen mot föraren

Två rutor som gör olika saker:

- **Viktningsrutan**, ±1,2° latitud (≈13 mil), skickas med `bounded=0`. Ber
  Nominatim föredra träffar nära föraren utan att kasta bort resten.
- **Den lokala rutan**, satt att motsvara 40 km, skickas med `bounded=1`.

Viktningen ensam räcker inte. Nominatim rankar efter hur *viktig* en plats är
i världen, så en förare i Västerås som söker "Drottninggatan" får hela listan
fylld av Stockholm — Västerås egen Drottninggatan finns, men kommer inte med
bland de tio första. För en app som varnar i Västmanland är det nästan alltid
fel svar.

Därför: **när inget i första passet ligger inom fyra mil görs ett andra pass
låst till den lokala rutan**, och de träffarna läggs först.

Skyddet mot att göra det när det vore fel: har föraren **själv skrivit ut
orten** — "Drottninggatan Stockholm" — då nämner frågan en ort som redan finns
i svaren, och ordningen rörs inte. Att lyfta en gata i Västerås över den i
Stockholm när användaren uttryckligen bad om Stockholm vore mycket värre än
att ranka lite fel.

Verifierat:

```
"Drottninggatan"            från Västerås →  Drottninggatan, Jakobsberg, Västerås (1,0 km)
"Drottninggatan Stockholm"  från Västerås →  Drottninggatan, Klara, Norrmalm (91 km)
```

Det andra passet kostar ett extra anrop, men bara på en riktig sökning som
föraren startat, och kön håller ändå gränsen.

### OSRM — ruttberäkning

Gratis, ingen nyckel.
Villkor: <https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy>

- **Ingen dokumenterad sifferbegränsning**, men "excessive use is not allowed"
  och åtkomsten kan dras in när som helst utan förklaring. Appen anropar bara
  vid nytt resmål och vid avvikelse, med 20 sekunders spärr och högst 12
  omräkningar per resa.
- **Attribution krävs** — ODbL för data och OSRM som ruttmotor. Kartan visar
  redan OpenStreetMap-attribution; **OSRM behöver läggas till där när
  ruttläget kopplas in.**
- **Två värdar, tre försök.** Vid fel provas
  `routing.openstreetmap.de/routed-car` (FOSSGIS) som andra maskin. En rutt
  som inte går att räkna om är samma sak som ingen rutt alls.

---

## Vad det här inte klarar

**Sväng-för-sväng-navigering.** Modulen räknar inte ut vilken fil du ska ligga
i och säger inte "sväng höger om 200 meter". `steps` är avstängt i
OSRM-anropet. Den vet var du är på rutten, inte vad du ska göra härnäst.

**Trafik.** OSRM:s restid bygger på skyltade hastigheter, inte på hur det ser
ut just nu. ETA:n är en uppskattning, och i rusningstrafik en optimistisk
sådan. Det påverkar också horisonten: står du i kö tror modulen att du kör
fortare än du gör, tills GPS-farten hunnit ikapp.

**Alternativa vägar.** `alternatives=false`. Det finns en rutt, den OSRM anser
snabbast. Vill föraren köra en annan väg upptäcks det som en avvikelse och
rutten räknas om — vilket fungerar, men tar tjugo sekunder och en varningspaus.

**Rapporter som inte ligger på en väg.** Korridoren mäter mot vägens
mittlinje. En rapport som geokodats till mitten av ett bostadsområde tvåhundra
meter från leden hamnar utanför korridoren och nämns inte, även om polisen
faktiskt står vid infarten. Påslaget för geokodade rapporter mildrar det men
tar inte bort det.

**Vilken körriktning en rapport gäller.** Ligger polisen på motsatt körbana av
en motorväg räknas den som "på rutten", för korridoren på 120 m täcker båda
körbanorna med flit. Det är ett medvetet val: att missa en kontroll på din
egen sida är värre än att nämna en på andra sidan.

**Långa rutter är opålitliga i praktiken.** Systemet räknar korrekt på en
sträcka Malmö–Kiruna, men en polisrapport lever i 45 minuter. Allt som ligger
mer än en timmes körning bort kommer att ha gått ut innan du är framme, och
filtreras därför bort ur både sammanfattningen och varningarna. Ruttläget gör
verklig nytta på resor upp till ett par timmar.

**Tunnlar och parkeringshus.** Utan GPS står positionen stilla på rutten. När
signalen kommer tillbaka hittar fönstersökningen rätt igen (den söker upp till
6 km framåt), men under tiden är framförhållningen fel.

**Ingen persistens.** Rutten ligger i minnet. Stängs appen är den borta.
`publicRoute()` är serialiserbar för den som vill spara den, men modulen gör
det inte själv.
