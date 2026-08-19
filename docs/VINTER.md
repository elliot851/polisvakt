# Vinterläge

Polisvakt varnar för polis. Det är en ekonomisk risk. Vinterläget varnar för
det som faktiskt skadar folk på Västmanlands vägar mellan oktober och mars:
halka, underkylt regn, snöfall, snörök och vilt i skymningen.

All logik ligger i `js/vinter.js`. Modulen rör inte DOM och pratar inte själv —
den lämnar ifrån sig en nivå och en färdig svensk mening, och `js/alerts.js`
avgör när rösten används.

---

## 1. Källorna

### 1.1 SMHI punktprognos (väder)

**Viktigt att veta först:** det gamla pmp3g-API:et som all svensk hobbykod
använde lades ned **31 mars 2026**. Hela värden svarar numera 404, även på
`/api.json`. Efterträdaren heter **snow1g version 1** och ligger på samma
värdnamn.

```
https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1
  /geotype/point/lon/{lon}/lat/{lat}/data.json?parameters={lista}&timeseries={n}
```

Gratis, ingen nyckel, ingen registrering. `Access-Control-Allow-Origin: *`, så
appen kan anropa den direkt från webbläsaren.

Dataformatet är **inte** samma som i pmp3g. Där låg värdena i en lista med
`{ name, values: [] }`. I snow1g ligger de i ett platt objekt med läsbara
namn:

```json
{
  "createdTime": "2026-08-18T20:33:17Z",
  "referenceTime": "2026-08-18T20:15:00Z",
  "geometry": { "type": "Point", "coordinates": [16.550115, 59.605312] },
  "timeSeries": [
    {
      "time": "2026-08-18T21:00:00Z",
      "intervalParametersStartTime": "2026-08-18T20:00:00Z",
      "data": { "air_temperature": 15.0, "relative_humidity": 56, "...": 0 }
    }
  ]
}
```

Parametrar modulen hämtar, med enheter enligt
`/api/category/snow1g/version/1/parameter.json`:

| Fält | Enhet | Används till |
|---|---|---|
| `air_temperature` | °C, 2 m | grund för vägbanetemperatur |
| `relative_humidity` | % | ger daggpunkten |
| `cloud_area_fraction` | oktas 0–8 | hur mycket vägen strålar ut |
| `wind_speed` | m/s, 10 m | omblandning, snörök |
| `wind_speed_of_gust` | m/s, 10 m | snörök |
| `visibility_in_air` | km | snöbyar, snörök |
| `predominant_precipitation_type_at_surface` | kategori 0–12 | vad som faller |
| `precipitation_amount_mean` | mm/h | hur mycket |
| `precipitation_frozen_part` | % | hur mycket av det som är fruset |
| `probability_of_precipitation` | % | om modellen tror på det |
| `probability_of_frozen_precipitation` | andel 0–1 | reserv |
| `symbol_code` | 1–27 | reserv |

Nederbördstyperna, ur SMHI:s egen tabell — 0 ingen, 1 regn, 2 åska,
**3 underkylt regn**, 4 blandat/is, 5 snö, 6 blötsnö, 7 regn och snö,
8 iskorn, 9 snöhagel, 10 hagel, 11 duggregn, **12 underkylt duggregn**.

**Fallgropar i formatet, alla verifierade mot riktiga svar:**

- `9999` betyder saknat värde och kan dyka upp i vilket fält som helst.
  Allt som läses går genom en hjälpfunktion som gör om det till `null`.
- `precipitation_frozen_part` har dessutom sitt eget saknat-värde: **−9**
  betyder att det inte faller någon nederbörd alls. Tas det för 0 % ser
  torrväder ut som regn.
- `precipitation_amount_min` och `_max` är minsta och största värdet **bland
  de ensemblemedlemmar som har nederbörd**. En rad kan alltså visa
  `mean: 0.0` och `min: 0.2` samtidigt. De går inte att använda som spann, och
  modulen rör dem inte. Endast `mean` används.
- Tidsstämplarna betyder två olika saker. Allt utom nederbörden gäller
  momentant vid `time`. Nederbörden är fördelad över intervallet från
  `intervalParametersStartTime` fram till `time`. Vill man veta vad som faller
  just nu är det alltså den **kommande** raden som gäller, inte den passerade.
- Serien är timvis de första ~60 stegen och glesnar sedan till 3, 6 och 12
  timmar. Modulen ber om 14 steg och rör aldrig den glesa delen.
- Utanför modellområdet svarar API:et HTTP 404 med texten
  `Requested point is out of bounds`. Sverige ligger med god marginal innanför.

**Hämtning och cache.** SMHI kör om prognosen varje timme och lägger upp den
15–20 minuter över hel timme (svaret bär `Cache-Control: max-age=3600`).
Modulen hämtar därför på tre villkor, alla med ett absolut golv på fem minuter
mellan anrop:

| Villkor | Värde | Varför |
|---|---|---|
| Prognosen är äldre än | 30 min | fångar den nya körningen utan att fråga i onödan |
| Bilen har flyttat sig | 12 km | snöbyar är lokala; ~10 min landsväg, ~5 anrop Västerås–Stockholm |
| Golv mellan anrop | 5 min | skydd mot GPS-hopp och mot buggar i anropskedjan |

Svaret sparas i `localStorage` under `pv.vinter.v1`. Med parameterfiltret
väger det **6,1 kB** mot 69 kB för hela svaret. Cachen överlever omstart, så
appen fungerar offline på senast hämtade prognos — den innehåller fjorton
timmar framåt.

Misslyckas ett anrop händer ingenting dramatiskt: den gamla prognosen ligger
kvar och nästa försök skjuts upp med fördubblad väntan, från en minut upp till
trettio. **Efter tolv timmar slutar modulen lita på cachen** och går till nivå
noll istället för att varna på gammal data.

### 1.2 Vilt

**Det finns ingen datakälla, och det ska sägas rakt ut.**

Det existerar inget gratis realtidsflöde över var älg, rådjur och vildsvin
befinner sig. Nationella viltolycksrådet publicerar statistik i efterhand,
inte positioner. Modulen hittar därför **inte** på någon källa. Den räknar ut
när risken statistiskt sett är som högst och säger det en enda gång:

- **Tid** — de flesta viltolyckorna sker i gryning och skymning, när djuren
  rör sig och förarens ögon är som sämst. Räknat på **verklig soltid** för
  positionen via `sunTimes()` i `js/util.js` (samma NOAA-rutin som nattläget
  använder, ingen andra kopia), inte på klockslag. I Västerås går solen ner
  strax efter tre i december och strax före tio i juni.
- **Årstid** — vildsvin och rådjur toppar under hösten och vintern.
- **Vägtyp** — hastighetsgränsen från `SpeedLimitService` säger vad för väg det
  är. Landsväg med 90 är där olyckorna sker och där farten gör dem allvarliga.

Nivån är **takad till nivå 2** och kan aldrig bli 3. En statistisk sannolikhet
får inte låta som en observation. Säger appen "allvarlig fara" om något den
inte har sett urholkar den ordet inför den dagen det faktiskt ligger underkylt
regn på vägen.

---

## 2. Trösklarna, och varför just de

### 2.1 Uppskattad vägbanetemperatur — den viktigaste beräkningen

SMHI mäter luften två meter över marken. **Vägbanan är något annat.** En klar,
vindstilla natt strålar asfalten ut värme mot rymden utan att moln skickar
tillbaka något och utan att vind blandar om luften. Ytan hamnar då typiskt 3–5
grader under lufttemperaturen. Det är därför man kan åka på svartis medan
bilens display visar plus två.

```
vägbanetemp = lufttemp − 3,5 × klarhet × stiltje × natt
```

| Faktor | Går från 1 till 0 mellan | Motivering |
|---|---|---|
| klarhet | 0 oktas → 8 oktas | moln strålar tillbaka; helmulet ger ingen avkylning |
| stiltje | 1,5 m/s → 5 m/s | vind blandar om luftlagret närmast marken |
| natt | 1 h efter solnedgång → 1 h efter soluppgång, mjuk ramp | dagtid värmer solen asfalten mer än den strålar bort |

Rampen är mjuk med flit. Ett binärt omslag vid horisonten skulle få den
uppskattade vägbanetemperaturen att hoppa tre grader på en minut och dra med
sig varningsnivån.

Dagtid sätts avkylningen till noll. Den som gissar fel åt andra hållet varnar
för halka mitt på dagen i mars och blir ignorerad resten av vintern.

### 2.2 Halka utan nederbörd

Två saker måste vara sanna samtidigt: vägbanan under noll, **och** fukt som
kan lägga sig på den. Kall och torr asfalt är inte hal.

Grundvillkor: uppskattad vägbanetemperatur **≤ +0,5 °C**. Därutöver minst ett
av tre:

| # | Villkor | Varför |
|---|---|---|
| a | daggpunkt ≥ vägbanetemp − 0,5 °C | fukten fäller ut nu; det är rimfrosten som lägger sig medan bilen står parkerad |
| b | det har regnat inom fyra timmar | vägen är redan blöt och fryser till |
| c | daggpunkt ≤ 0 °C, ≤ 2 oktas moln, ≤ 3 m/s vind, natt | se nedan |

**Villkor (c) är svaret på "luften är inte vägen".** Utstrålningen slutar inte
när ytan når lufttemperaturen — den fortsätter tills ytan möter daggpunkten,
för det är först då kondensationen frigör värme och bromsar. Ligger
daggpunkten under noll betyder det att ytan är på väg under noll med fukt på
gång, och att det som fälls ut blir is och inte dagg. Därför räknas en klar,
stilla natt som halkrisk **även när termometern visar ett par plusgrader**.
Det är exakt den natten som lurar folk: bilens display säger +2 och rutan är
torr.

Nivå 2 vid vägbanetemp ≤ −1 °C eller blöt väg, annars nivå 1. Visar
lufttemperaturen samtidigt plusgrader byter meningen form och säger ut
skillnaden, eftersom föraren omöjligt kan gissa den själv:

> *"Halkrisk. Vägbanan kan ligga under noll trots plusgrader i luften. Broar
> och skuggpartier först."*

Daggpunkten räknas med Magnus-formeln (a = 17,62, b = 243,12). Kontrollvärde:
20 °C och 50 % RF ger 9,26 °C.

### 2.3 Underkylt regn

Nederbördstyp **3 eller 12** → nivå 3, alltid, utan sidovillkor. Regn som
fryser vid kontakt lägger en spegel över hela vägen samtidigt, inte i fläckar,
och sandning hinner sällan före. Det här är den enda varning som får bryta mot
tystnadsreglerna.

### 2.4 Snöfall

Kräver att modellen tror på nederbörden: **≥ 0,1 mm/h och ≥ 30 % sannolikhet**.
Sedan typ 5, 6 eller 9, eller minst 60 % fruset.

| Intensitet | Nivå | Varför |
|---|---|---|
| ≥ 1,2 mm/h, eller sikt < 1 km | 3 | lägger igen vägen fortare än plogen hinner |
| ≥ 0,4 mm/h | 2 | märks tydligt på väggreppet |
| därunder, vägbana ≤ 0 °C | 1 | visas men sägs inte |

Måttet är **millimeter vatten**, inte centimeter snö — ungefär tio gånger så
mycket snö i volym.

### 2.5 Snöblandat regn på kall vägbana

Typ 4, 7 eller 8 med nederbörd och vägbanetemp ≤ +1 °C → nivå 3. Blandad
nederbörd som landar på en yta runt noll ger modd som fryser underifrån.
Vanligt i Mälardalen och kraftigt underskattat.

### 2.6 Snörök

Kräver tre saker: vind **≥ 8 m/s eller byar ≥ 12 m/s**, temperatur **≤ −2 °C**
och att det har snöat. Nära noll packas snön och ligger kvar; under ett par
minusgrader är den torr och flyger. Nivå 3 vid byar ≥ 16 m/s och sikt < 2 km,
annars nivå 2.

Om det har snöat är en **gissning**, och den bygger på ett litet trick: en
cachad prognos innehåller rader som hunnit bli dåtid. Är cachen fyra timmar
gammal ser modulen fyra timmar bakåt gratis och tittar i fönstret −6 till +2
timmar. Är den nyss hämtad ser den bara framåt, och då blir bedömningen
svagare. Det får den vara — alternativet vore att hitta på.

### 2.7 Vilt

`poäng = fönster × årstid × vägtyp`. Nivå 2 vid ≥ 0,55, nivå 1 vid ≥ 0,30.

| Fönster | Vikt |
|---|---|
| 15 min före till 60 min efter solnedgång | 1,0 |
| 45 min före till 120 min efter solnedgång, i övrigt | 0,6 |
| 45 min före soluppgången till soluppgång | 0,9 |
| 75 min före till 30 min efter soluppgång, i övrigt | 0,55 |
| utanför dessa | 0 — helt tyst |

| Årstid | Vikt | | Hastighetsgräns | Vikt |
|---|---|---|---|---|
| okt, nov, dec, jan | 1,0 | | ≥ 90 | 1,0 |
| sep, feb | 0,85 | | 70–80 | 0,9 |
| mar, apr, maj | 0,7 | | 60 | 0,6 |
| jun, jul, aug | 0,5 | | ≤ 50 | 0,15 |
| | | | okänd | 0,6 |

Rådjuren har även en vårtopp i maj, men det här är ett vinterläge och bygger
inte varningen på den. I 40-zon i Västerås centrum varnar modulen aldrig, och
mitt på dagen eller mitt i natten är den helt tyst.

---

## 3. Varningsdisciplin

Den här delen är viktigare än väderdatan. En förare som får höra "halkrisk"
var nittionde sekund slutar lyssna, och då har appen gjort honom **mindre**
säker än om den varit tyst — nästa gång det verkligen gäller sitter varningen
redan i bakgrundsbruset.

Nivå 1 hörs aldrig. Den finns bara så gränssnittet kan visa något utan att
rösten går igång.

Väder och vilt är **två oberoende kanaler** med var sin hysteres. Ett snöfall
ska inte kunna tysta viltvarningen i skymningen för resten av kvällen, och
tvärtom. Tak och luckor delar de däremot, så föraren aldrig får två meningar
i rad.

### Regel A — varna vid övergång, inte vid tillstånd

Halka som pågår är inte en ny nyhet varje GPS-fix. Samma nivå på samma orsak
säger ingenting. En **sjunkande** risk säger aldrig någonting alls — "det är
mindre halt nu" är information ingen förare har bett om.

### Regel B — uppåt fort, nedåt långsamt

En ny bedömning blir inte officiell direkt.

| Riktning | Väntan | Motivering |
|---|---|---|
| uppåt | 2 min | prognosen byts ändå bara en gång i timmen, så väntan kostar inget mot vädret. Den skyddar mot att en enstaka hämtning eller en griddgräns knuffar oss över en tröskel och tillbaka |
| uppåt till nivå 3 | 30 s | underkylt regn får inte vänta två minuter |
| nedåt | 25 min | vägen torkar inte för att lufttemperaturen kröp över en tröskel |

**Asymmetrin är hela poängen.** Vore fallet lika snabbt som stigningen skulle
en temperatur som pendlar kring en tröskel ge en ny varning varje gång den
passerar, och det är precis den upplevelsen som lär föraren att stänga av
rösten.

### Regel C — karantän

| Spärr | Tid | Gäller |
|---|---|---|
| kategorikarantän | 45 min | samma sorts varning igen, om den inte blivit allvarligare |
| sidledes byte | 90 min | samma nivå men annan orsak |
| minsta lucka | 20 min | mellan två vintervarningar av vilket slag som helst |
| eskalering till nivå 3 | 8 min | får bryta luckan ovan, men bara ner hit |

**Sidledes byte** förtjänar en förklaring. Underkylt regn som övergår i
kraftigt snöfall är inte farligare än det var. Föraren har redan sänkt farten.
Utan den spärren blir ett långt oväder till en radioserie: modd, sedan snö,
sedan underkylt, sedan snö igen.

Vilt sägs **en gång per skymning eller gryning**, aldrig mer. Risken förändras
inte under fönstret, så en påminnelse fem minuter senare tillför exakt
ingenting.

En episod nollställs när kanalen faller under varningsnivå. Ett snöfall på
morgonen tystar alltså inte kvällens snöfall — men kategorikarantänen lever
vidare och ser till att "nästa gång" inte betyder om tio minuter.

### Regel D — hårt tak

**Tre varningar per rullande timme.** Regel A–C är mekanismen; taket är
skyddsnätet om mekanismen har en bugg.

Dessutom: står bilen still (under 20 km/h) sägs ingenting. Det finns ingen
fara att varna för, och föraren håller förmodligen på att ställa in appen.

### Verifierat beteende

Modulen kördes mot simulerade körningar med tio sekunders steg:

| Scenario | Uttalade varningar |
|---|---|
| Stabil halka, 3 timmars körning | **1** |
| Temperaturen studsar över tröskeln varje 3 min, 3 timmar | **1** |
| Halka som övergår i underkylt regn efter 40 min | **2** |
| Halka, bilen står stilla i 3 timmar | **0** |
| Snöfall → 2 h uppehåll → snöfall igen | **2** |
| 8 timmar där nederbördstypen kastar mellan underkylt, snö och modd varje halvtimme | **7** |
| Alla spärrar avstängda, ny orsak varje minut i 3 timmar | **9** — taket håller, aldrig fler än 3 per timme |
| Prognos saknas helt | **0** |
| 20 timmar gammal prognos med underkylt regn | **0** — cachen är för gammal för att lita på |

---

## 4. Det här kan modulen inte veta

Listan är avsiktligt rak. Varningarna ska läsas mot den.

- **Vägbanans faktiska temperatur.** Den mäts av Trafikverkets vägväderstationer,
  och den datan är inte fritt tillgänglig i den form vi behöver. Allt som står
  om vägbanetemperatur i den här modulen är en **beräknad uppskattning** ur
  lufttemperatur, molnighet, vind och tid på dygnet. Den kan slå fel åt båda
  hållen.
- **Om vägen är saltad, sandad eller plogad.** Halkbekämpning ändrar väglaget
  helt, och en saltad väg kan vara torr i två minusgrader. Modulen vet
  ingenting om var eller när Trafikverkets entreprenörer har kört. En varning
  som känns överdriven kan mycket väl bero på att just den sträckan är saltad.
- **Var djuren faktiskt är.** Viltvarningen är en statistisk sannolikhet
  räknad på soltid, årstid och vägtyp. Den betyder **aldrig** att något djur
  har observerats. Det finns inget flöde att observera dem i.
- **Om det ligger snö på marken.** Snörök kräver lös snö att blåsa upp.
  Modulen gissar utifrån om det snöat i den prognos den har sparad, och en
  nyss hämtad prognos ser ingenting bakåt alls.
- **Mikroklimat.** Broar, viadukter, vägbank över myr, skuggpartier och
  frostsläpp i svackor fryser tidigare än omgivningen — ibland flera grader.
  Prognospunkten är en griddruta på några kilometer och kan omöjligt fånga
  det. Därför nämner meningarna broar och skugga uttryckligen istället för att
  låtsas veta var det är halt.
- **Vad andra bilister gör.** Ingen del av det här ser trafik, köer eller
  olyckor.
- **Väglaget bakom nästa krön.** Prognosen gäller punkten bilen befinner sig i
  och hämtas om var tolfte kilometer. En snöby fem kilometer bort kan mycket
  väl saknas.

Och det som gäller allt ovan: **en prognos är en prognos.** Den beskriver vad
SMHI:s modell tror kommer att hända, inte vad som händer. Föraren är den enda
som ser vägen.

---

## 5. API

```js
import { WinterService } from './vinter.js';

const vinter = new WinterService();

// En gång per GPS-fix, precis som SpeedLimitService.update()
const { status, warnings } = vinter.update({
  lat, lon,
  speedKmh,
  speedLimit,          // från SpeedLimitService.current?.limit, används bara för vilt
});

// warnings är tom nästan alltid. Det är meningen.
for (const w of warnings) {
  // w.level     2 eller 3
  // w.key       'halka' | 'underkylt' | 'snofall' | 'snorok' | 'blandat' | 'vilt'
  // w.phrase    färdig svensk mening för uppläsning
  // w.priority  2 avbryter pågående tal, 1 ställer sig i kö (samma skala som alerts.js)
  // w.channel   'weather' | 'wildlife'
  // w.stale     true om prognosen börjar bli gammal
}
```

`status` är läget just nu och är till för gränssnittet — den innehåller inga
varningar och ska inte läsas upp:

```js
{
  weather:  { level, key, phrase },
  wildlife: { level, key, phrase },
  forecastAgeMs, stale, createdTime, offline, error
}
```

Övrigt: `vinter.enabled` slår av och på, `vinter.reset()` börjar en ny resa
(nollställer allt som gäller per körning men behåller prognosen), och
`vinter.setOptions({ ... })` skriver över trösklarna i `DEFAULTS`.

Händelser via `addEventListener`: `warning` (samma objekt som ovan), `status`
när en kanal byter officiell nivå, `forecast` när en ny prognos landat, och
`error` när en hämtning misslyckats.

De rena funktionerna `dewPoint()`, `estimateRoadTemp()`, `assessWeather()` och
`assessWildlife()` exporteras också. De har inga sidoeffekter och är avsedda
att gå att testa var för sig — all tidsberoende logik ligger samlad i klassen.
