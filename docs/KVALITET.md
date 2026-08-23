# Trovärdighet

All logik ligger i `js/kvalitet.js`. Modulen rör inte DOM, säger ingenting
högt och skriver inte till store. Den tar emot rapporter och lämnar ifrån sig
en graderad trovärdighet, en rekommenderad behandling och en färdig svensk
mening. `js/alerts.js` avgör när rösten används.

---

## 1. Varför den finns

En falsk varning kostar mer än en missad.

Missar appen en patrull händer ingenting. Föraren får aldrig veta att den
fanns, och tystnaden kostar noll i förtroende. Varnar appen för polis på en
väg där ingen polis står lär den istället föraren att den ljuger. Efter tre
sådana slutar folk tro på varningarna som faktiskt stämmer — och en app som
ingen tror på skyddar ingen, oavsett hur många riktiga rapporter den har.

Felen är alltså inte symmetriska, och koden får inte behandla dem som om de
vore det. Innan den här modulen fanns behandlade appen varje rapport som lika
sann i samma sekund den kom in.

Nästan inget av det som går fel beror på illvilja:

| Vad som händer | Vad som blir fel |
|---|---|
| Någon trycker fyra minuter efter passagen | Positionen är kilometer fel, rapporten är sann |
| Passagerare rapporterar i 110 km/h | Nålen hamnar drygt hundra meter efter patrullen |
| Röst eller Facebook-text geokodas | Rätt gatunamn, fel del av stan |
| Samma patrull rapporteras två gånger | Kartan visar två patruller där det finns en |
| Rapporten är gammal | Bilen åkte för tio minuter sedan |

Modulen försöker inte avgöra om en rapport är **sann**. Den avgör hur mycket
appen ska **påstå**. Det är en annan och mycket mer besvarbar fråga.

---

## 2. Poängmodellen

Poängen är ett tal mellan 0 och 1. Den börjar på ett utgångsläge som bestäms
av hur rapporten skapades, och justeras sedan additivt av sex faktorer. Allt
klipps till 0–1 på slutet.

```
poäng = utgångsläge
      + historik + fart + fördröjning + geokod + texttolkning
      + samstämmighet + röster + ålder
```

Additivt och inte multiplikativt, med flit: en additiv modell går att läsa
rad för rad i felsökningsvyn (`sammanfatta()`), och varje rad går att
argumentera emot separat. En multiplikativ eller log-odds-modell hade sett
mer statistisk ut utan att bli mer sann — se avsnitt 7.

### 2.1 Utgångsläge — hur rapporten skapades

| Källa | Start | Varför |
|---|---|---|
| `app` | **0,62** | Ett knapptryck i appen bär ett underförstått "jag är här och ser det nu". Positionen är telefonens egen. |
| `voice` | **0,56** | Samma sak plus ett taltolkningssteg som kan höra fel, och ofta en geokodning. |
| `facebook` | **0,46** | Okänd författare. Se nedan. |
| `import` | **0,42** | Okänd författare, okänd tidpunkt, ogranskad geokodning. Tre osäkerheter på en gång. |
| okänd | **0,45** | Vet vi inte vägen in vet vi inget alls. |

**Varför `facebook` flyttades från 0,42 till 0,46 (2026-08-23).** Talet 0,42
motiverades med tre okända: författare, tidpunkt och geokodning. Två av dem är
inte längre okända. Tidpunkten mäts — `createdAt` är inläggets egen
tidsstämpel, inte sveptidpunkten (`observeradTid` i `tools/fb-bridge.user.js`).
Geokodningen granskas — stadsspärren kastar en stad som svar på ett vägnamn,
och `geokod_typ` och `geokod_radius_m` läses ur svaret i stället för att gissas
ur frågan (avsnitt 2.5 och 3). Kvar av motiveringen är den okända författaren,
och det är skälet till att talet fortfarande ligger klart under `app` och
`voice`.

Det MÄTTA skälet: med 0,42 landade en aliasgeokodad grupprapport på 0,44 mot
hedgningsgränsen 0,48 och var alltså tyst utom under sina första minuter. Hela
tjänsten bygger på just de rapporterna. `import` rördes inte — den vägen är en
bulkinläsning utan tidsstämpel och utan granskat svar, alltså precis det 0,42
en gång beskrev.

### 2.2 Rapportörens historia

`js/reputation.js` belönar bekräftade rapporter (+3) och bestraffar
nedröstade (−4). Samma siffror läses baklänges här: någon vars rapporter
regelbundet röstas ner har antingen dålig position eller dålig bedömning, och
båda är skäl att hedga.

```
kvot  = (bekräftade + 6 · 0,55) / (bekräftade + nedröstade + 6)
delta = (kvot − 0,55) · 0,55        klippt till −0,25 … +0,20
```

**Varför pseudoräknaren 6 och nollpunkten 0,55.** Utan utjämning skulle en
enda nedröstning på en enda rapport ge kvoten 0 och göra en förstagångare som
hade otur permanent misstrodd. Sex pseudorapporter betyder att historiken
börjar väga först när den bygger på ungefär en veckas normalt rapporterande.
0,55 är vad en okänd rapportör antas ligga på — knappt över mitten, eftersom
de allra flesta rapporter är riktiga.

**Ingen historik ger noll, inte minus.** Det är ett medvetet val. En
förstagångare som rapporterar rätt är exakt det appen behöver mer av, och en
tröskel som straffar nya användare skulle göra det omöjligt att ta sig in.

**Tak vid 5 nedröstningar** (och fler nedröstade än bekräftade): poängen får
inte överstiga 0,65, det vill säga aldrig konstaterande formulering.

### 2.3 Fart vid inlämning

```
över 60 km/h:  delta = −((fart − 60) / 60) · 0,08     klippt vid −0,08
```

Farten flyttar framför allt **punkten**, och det hanteras separat i avsnitt 3.
Avdraget här handlar om något annat: i 120 km/h är en mörk kombi på vägrenen
en glimt, och glimtar blir feltolkade. Därför ett litet avdrag, inte ett
stort. 60 km/h som startpunkt för att stadstrafik under det ger gott om tid
att se efter.

### 2.4 Fördröjning mellan iakttagelse och inlämning

```
över 60 s:  delta = −(minuter / 10) · 0,20            klippt vid −0,20
över 5 min: flaggan "sen-inlamning"
```

Det här är det enda som fångar "jag tryckte när jag kom hem". Fältet är
valfritt och saknas oftast — appen vet det bara om den frågar, eller om ett
importerat inlägg har en tidsstämpel. **Se avsnitt 7.2.**

### 2.5 Geokodning

Två separata bidrag: hur positionen togs fram, och hur precist svaret blev.

| Metod | Delta | | Upplösning | Delta |
|---|---|---|---|---|
| `gps` egen position | **+0,10** | | `punkt` | +0,04 |
| `karta` utpekad | **+0,08** | | `adress` | +0,02 |
| `alias` handprovad söksträng | **+0,06** | | `vag` | 0 |
| `learned` inlärd plats | +0,05 | | `stadsdel` | 0 |
| `nominatim` / `cache` | +0,04 | | `ort` | **−0,22** |
| okänd | −0,15 | | `led` genomfartsväg | **−0,22** |
| | | | okänd | −0,10 |

**Stegen är ordnade efter hur mycket mänsklig kontroll som ligger bakom
koordinaten.** `gps` och `karta`: föraren var där eller pekade själv. `alias`:
en människa har skrivit söksträngen, ställt den till OSM och LÄST svaret innan
raden lades in i `data/aliases.vasteras.json`. `learned`: föraren pekade ut
platsen en gång. `nominatim`: ingen människa har sett svaret, men koden
granskar det.

**`alias` lyftes från 0,02 (2026-08-23).** Med 0,02 blev en aliasrad
0,42 + 0,02 + 0 = 0,44 och tystnade, medan samma rad utan alias fick 0,42.
Skillnaden mellan att höras och att tiga låg alltså på två hundradelar och
avgjordes av om någon råkat skriva in namnet i en lista. Se mätningen i
avsnitt 2.5.1: efter ändringen hamnar aliasraden och nominatimraden på SAMMA
sida om hedgningsgränsen för varje geokodtyp. Listan avgör inte längre om
föraren får höra något — den avgör bara hur säkert det sägs.

**`nominatim` lyftes från 0 till 0,04** därför att ordet betyder något annat
nu. Det var ett ogranskat genomsläpp av rad ett i svaret. Numera fälls svaret
av stadsspärren om det är en stad eller en kommun när frågan inte var ett
ortnamn, av områdeskontrollen om koordinaten ligger utanför gruppens ruta, och
typen och radien läses ur svaret i stället för ur frågan. `cache` är samma sak
en gång till och har samma tal.

**−0,22 för ortsnivå** är modellens hårdaste enskilda avdrag och finns för ett
enda fall: "polis vid Drottninggatan" som geokodas till kommunens mittpunkt.
Ett ortsnamn pekar på en kommun, inte på en väg, och en varning för en kommun
är ingen varning. Tillsammans med den grova standardradien (2 500 m, avsnitt
3) faller sådana rapporter genom hela skalan och hamnar på tyst kartnål.

**`led` är ny och gäller genomfartsvägarna** — E18, riksväg 66, riksväg 56.
Radien 8 000 m gör jobbet: rapporten passerar 3 000-metersgränsen och
undanhålls. Avdraget finns för att en rapport som bara säger "E18" inte ska
kunna klättra tillbaka på bekräftelser.

**`stadsdel` gick från −0,10 till 0, och det är inte en uppmjukning.**
Tabellen hade två jobb och gjorde dem otydligt: den sa både *hur brett* svaret
pekar och *hur troligt* det är att det pekar på rätt sak. Bredden mäts numera
ur svaret (avsnitt 3) och verkar genom positionsosäkerheten — den hedgar
platsen till "i området kring Bäckby", den tystar över 1 200 m och den slänger
nålen över 3 000 m. Att också dra av på poängen för samma sak var att räkna
bredden två gånger, och det var det som tystade varenda stadsdelsrapport i
gruppen. Kvar här är bara frågan om rätt objekt, och "Bäckby" är nästan alltid
rätt stadsdel. `ort` behåller sitt avdrag därför att det handlar om något
annat: ett kommunnamn i ett länsflöde är lika ofta ett samtalsämne som en
observation.

**`okand` sänktes från −0,06 till −0,10.** Med det höjda geokoddeltat hamnade
en färsk okänd träff på 0,49 och blev hörbar under sina första minuter. En
rapport där vi inte vet vad svaret pekar på ska inte sägas högt i någon ålder.

### 2.5.1 Mätt poängfördelning för verkliga gruppinlägg

Mätt 2026-08-23 med `bedomRapport()` på en ensam `facebook`-rad från bryggan
(`confirms: 1`, ingen `parser_confidence`, ingen `fordrojning_s` — se
`tools/fb-bridge.user.js`). Typ och radie är de värden OSM faktiskt svarade
med samma dag, för de platser gruppen skriver om.

| Inlägg | geokod | typ | radie | 0 min | 20 min | 60 min |
|---|---|---|---|---|---|---|
| Polis vid Dillos | alias | punkt | 15 m | 0,61 hedga | 0,56 hedga | 0,38 tyst |
| Polis vid Erikslund | alias | punkt | 301 m | 0,61 hedga | 0,56 hedga | 0,38 tyst |
| Polis vid Vallby golfklubb | alias | punkt | 990 m | 0,61 hedga | 0,56 hedga | 0,38 tyst |
| Polis vid Hälla | alias | stadsdel | 900 m | 0,57 hedga | 0,52 hedga | 0,34 tyst |
| Polis vid Norrleden | alias | vag | 250 m | 0,57 hedga | 0,52 hedga | 0,34 tyst |
| Polis vid Hantverkargatan | nominatim | vag | 250 m | 0,55 hedga | 0,50 hedga | 0,32 tyst |
| okänd plats | nominatim | okand | 1 200 m | 0,45 tyst | 0,40 tyst | 0,22 tyst |
| Polis i Sala | alias | ort | 2 500 m | 0,35 tyst | 0,30 tyst | 0,12 tyst |
| Polis på E18 österut | alias | led | 8 000 m | 0,35 undanhåll | 0,30 undanhåll | 0,12 undanhåll |

Och steget `alias` → `nominatim` vid samma geokodtyp och noll ålder, alltså
frågan "avgör listan om föraren hör något?":

| Typ | alias | nominatim | Samma behandling? |
|---|---|---|---|
| punkt | 0,61 hedga | 0,59 hedga | ja |
| adress | 0,59 hedga | 0,57 hedga | ja |
| vag | 0,57 hedga | 0,55 hedga | ja |
| stadsdel | 0,57 hedga | 0,55 hedga | ja |
| ort | 0,35 tyst | 0,33 tyst | ja |
| led | 0,35 undanhåll | 0,33 undanhåll | ja |
| okänd | 0,47 tyst | 0,45 tyst | ja |

Det är kravet på talen, och det är därför de ser ut som de gör: steget mellan
en handprovad och en ogranskad söksträng får synas i poängen, men det får inte
ensamt vända behandlingen. Ändras något av talen i 2.1 eller 2.5 ska den här
tabellen mätas om.

### 2.6 Texttolkningens egen bedömning

```
delta = (parserConfidence − 0,70) · 0,25              klippt till ±0,08
```

`parser.js` sätter redan ett förtroende på fritext utifrån om det finns en
tydlig platsfras och hur långt inlägget är. Det är riktig information och ska
inte kastas bort — men den bygger på ordräkning, så den får ett smalt
intervall. 0,70 som nollpunkt eftersom det är ungefär vad en normal, tydlig
rapport landar på i parsern.

### 2.7 Samstämmighet

| Oberoende rapporter om samma patrull | Delta |
|---|---|
| 0 | **0** |
| 1 | +0,12 |
| 2 | +0,20 |
| 3 eller fler | +0,25 |
| olika kanaler inblandade | +0,05 extra |
| oberoendet går inte att bevisa | taket sänks till +0,12 |

**Noll ger inget avdrag.** Den första rapporten om en verklig patrull är den
mest värdefulla som finns. Straffas ensamhet varnar appen aldrig först, och då
är den meningslös.

**Oberoende** betyder olika personer och olika iakttagelser. Tre saker gör att
en granne inte räknas: samma `device_id`, samma `external_id` (samma
Facebook-inlägg inläst två gånger), eller rapporten själv.

**Kanalbonusen** finns för att en app-rapport och ett Facebook-inlägg om samma
patrull är starkare bevis än två app-rapporter. Två personer i samma bil
trycker båda i appen; en person i en bil och en person i en Facebook-grupp
har inte tittat på varandra.

**Taket vid okänt oberoende** gäller ofta. Det publika flödet (`reports_feed`)
lämnar med flit inte ut `device_id` — se `supabase/schema.sql` — så klienten
kan i normalfallet inte bevisa att två rapporter kommer från olika personer.
Alternativet, att ignorera all samstämmighet, vore att kasta bort det
starkaste vi har. Halva bonusen och en flagga är den ärliga kompromissen.

### 2.8 Röster på rapporten

```
bekräftelser:   +0,08 styck, tak +0,16
nedröstningar:  −0,10 styck, tak −0,30
```

En röst väger mindre än en självständig rapport eftersom den är billigare: ett
tryck, ingen egen iakttagelse krävs. Två nedröstningar sätter dessutom ett
hårt tak (avsnitt 2.10).

### 2.9 Ålder

Skalan är rapportens egen livslängd från `js/store.js` — polis 45 min,
trafikkontroll 60, civil 30. Talen upprepas alltså inte här, och en civil bil
åldras automatiskt dubbelt så fort som en trafikkontroll.

| Andel av livslängden | Delta |
|---|---|
| under 15 % | +0,05 |
| 15–50 % | 0 |
| 50–80 % | −0,08 |
| över 80 % | −0,18, flaggan `gammal` |

Över 40 % nämns åldern högt i meningen (avsnitt 5).

### 2.10 Tak — gränser, inte avdrag

Ett avdrag går att kompensera bort med tillräckligt många plus. En gräns gör
det inte, och vissa saker ska inte gå att kompensera bort.

| Villkor | Tak | Varför |
|---|---|---|
| Ensam rapport | **0,88** | En persons ord är en persons ord. Skalan ska inte kunna påstå något annat, hur bra allt annat än ser ut. Taket ligger med flit **över** annonseringsgränsen — ensamma rapporter ska fortfarande läsas upp, bara inte räknas som bevisade. |
| Dålig historik | 0,65 | Aldrig konstaterande formulering från någon som regelbundet har fel. |
| Två eller fler nedröstningar | **0,45** | Två personer som säger "det står ingen där" väger tyngre än en som säger att det gör det — de har sett samma plats senare i tiden. Taket ligger under hedgningsgränsen, så rapporten sägs inte högt alls. |
| Inlägget var bara ett platsnamn | **nivå LÅG → tyst** | Se nedan. Ett tak på NIVÅN, inte på poängen: rapporten får synas på kartan men aldrig läsas upp. |

#### Platsen ensam: syns, hörs inte

`parser.js` läser ett kort gruppinlägg som bara pekar ut ett känt platsnamn
("Bäckby", "Dillos norrgående 11.15") som en polisobservation. Det är
gruppens egen konvention — man skriver enbart när man ser en poliskontroll —
och den är oftast rätt. Men **ingen har skrivit vad som står där**, vi läser
in det, och två saker följer:

1. Står ordet "nykterhetskontroll" i BILDEN eller i kommentarerna innehåller
   texten ingenting för nykterhetsspärren att gå på. Läser appen då upp
   "Polis vid Bäckby" har den varnat för en nykterhetskontroll — den enda
   regel i projektet som aldrig får brytas.
2. Även utan nykterhet är tolkningen svagare än allt annat: den bygger på en
   konvention, inte på ett påstående.

Det avdrag parsern redan gör (0,20 på tilliten, alltså 0,70 i stället för
0,90) räckte inte: formeln i 2.6 ger `(0,70 − 0,70) · 0,25 = 0` — exakt noll
just vid den punkt där avdraget behövdes. Därför ett tak.

Villkoret prövas genom att läsa OM inläggets text (`note`) med parsern i
gruppläge. Rapporten har ingen kolumn för hur den tolkades, men `note` bär
texten hela vägen genom databasen, så taket gäller också en rapport som kom
från bryggan till någon annans telefon. Bara källorna `facebook` och `import`
prövas: en knapptryckning i bilen har ofta ett platsnamn som etikett, och den
ska inte tystas för det.

---

## 3. Positionsosäkerhet

Poängen svarar på "stämmer det?". Osäkerheten svarar på "var?", och de två
felen är oberoende: en helt sann rapport kan ha en oanvändbar position.

Tre felkällor, adderade kvadratiskt eftersom de inte samvarierar — att GPS:en
är dålig gör inte fördröjningen längre:

```
iso   = √(gps² + geokodradie²)          minst 15 m
längs = (fart i m/s) · fördröjning      bara för egna GPS-positioner
total = √(iso² + längs²)
```

**`längs` ligger längs färdriktningen, inte runt om.** Den som passerade i
90 km/h och tryckte fyra sekunder senare hamnar hundra meter *efter*
patrullen, inte bredvid den. Den skillnaden är hela grunden för
dubbletthanteringen i avsnitt 6.

**Farten flyttar bara egna GPS-positioner.** Att rapportören körde fort
flyttar inte den gata som geokodningen pekade ut.

### Standardradier

Sedan 2026-08-23 är tabellen ett **golv**, inte hela sanningen: bryggan,
daemonen och appens egen geokodare skriver ett mätt `geokod_radius_m` ur
OSM-svaret, och `positionsOsakerhet()` föredrar det framför tabellen. Tabellen
svarar när ingen mätning finns.

| Geokodnivå | Radie | Varför |
|---|---|---|
| `punkt` | 15 m | Golvet. Se nedan. |
| `adress` | 40 m | En fastighet. |
| `vag` | 250 m | En namngiven gata i Västerås är i den storleksordningen. |
| `stadsdel` | 900 m | Ungefär en kilometer tvärs över. |
| `ort` | 2 500 m | En kommunmittpunkt. |
| `led` | 8 000 m | Genomfartsväg. Se nedan. |
| okänd | 1 200 m | Antas dålig när vi inte vet. |

**`led` — E18, riksväg 66, riksväg 56.** De är inte platser. E18 går tre mil
genom länet, och OSM svarar med ETT vägavsnitt på hundra meter — vilket avsnitt
beror på dagsformen i rankningen. 8 000 m är valt så att osäkerheten passerar
3 000-metersgränsen och rapporten faller bort i stället för att bli en
självsäker nål någonstans längs vägen. Vill man ha tillbaka E18-rapporterna
måste inlägget säga VAR på E18; "E18 vid Hälla" löses av aliasuppslaget till
Hälla, se `slaUppAlias`.

### Radien ur svaret

`typFranSvar()` och `radieFranSvar()` i `js/geocode.js` (med ordagranna kopior
i `tools/fb-bridge.user.js` och `tools/brygg-daemon.ps1`) läser vad OSM
faktiskt svarade i stället för att gissa ur frågan.

**Varför svaret och inte frågan.** Mätt 2026-08-23: "Erikslunds köpcentrum,
Västerås" gissas till `okand` (1 200 m) men svaret är en köpcentrumpolygon på
301 m. Åt andra hållet, som är den farliga: "Kristinagatan 8, Västerås" gissas
till `adress` (40 m) men svaret är HELA Kristinagatan, och "Björnövägen 12,
Västerås" svarar med ett avsnitt 4,4 km från det avsnitt gatunamnet utan
husnummer landar på. Båda fick 40 m, alltså nästan full poäng, uppläsning och
notis — med en nål som kunde stå fyra kilometer fel. Regeln är därför: ett HUS
är en adress, ingenting annat.

**Boundingboxen får bara BREDDA, aldrig smalna av.** Det låter bakvänt och är
mätt. En NOD får en påhittad ruta av Nominatim, skalad efter platsens rang —
'Vallby, Västerås' och 'Hälla, Västerås' fick exakt samma 2 254 x 4 453 m. En
VÄG:s ruta täcker bara det ena vägavsnitt som råkade svara — 'Björnövägen,
Västerås' gav 30 x 72 m på en gata som i tätorten sträcker sig 8,5 km. Att ta
rutan rakt av hade alltså gjort båda nålarna SÄKRARE än de är. Bara `way` och
`relation` har riktig geometri, och bara när den är större än tabellen säger
den något nytt. `ort` och `led` breddas inte alls: annars hade "Sala" (en nod,
2 500 m ur tabellen) och "Hallstahammar" (en kommunrelation, 14 616 m ur
polygonen) fått olika svar på samma sorts fråga, och den skillnaden finns inte
i verkligheten.

Antagen GPS-osäkerhet när telefonen inte rapporterar någon: **25 m**.

Antagen fördröjning när appen inte vet: **app 4 s, röst 8 s** (man hinner
formulera sig), **facebook och import 300 s** (inlägg skrivs typiskt några
minuter efter).

**Golvet på 15 m.** En punkt som pekats ut på kartan har formellt noll fel,
men bilen den beskriver står inte på en matematisk punkt och den som pekade
siktade inte perfekt. Noll är alltid en lögn, och den lögnen skulle sedan
användas som vikt i klustringen och göra en enda rapport oändligt tung.

### Gränser som osäkerheten sätter

| Gräns | Effekt | Varför |
|---|---|---|
| **250 m** | Platsen hedgas: "i området kring X" | Ungefär det längsta man kan peka ut i tätort utan att hamna på fel kvarter. Motsvarar fyra sekunders fördröjning i motorvägsfart. En vägnivå-geokodning (250 m) ligger precis på gränsen och hedgas inte — att säga "vid Stora gatan" om en punkt någonstans på Stora gatan är korrekt. |
| **1 200 m** | Max nivå `låg` — visas men sägs inte | Varningsradien i `alerts.js` är 1 500 m. En rapport med den osäkerheten kan trigga var som helst inom radien och säger inte längre *var*, bara *att*. |
| **3 000 m** | `undanhåll` — inte ens på kartan | En nål som står tre kilometer fel ser exakt lika trovärdig ut som en som står rätt, och föraren har inget sätt att se skillnaden. Då är ingen nål bättre. |

---

## 4. Nivåer och behandling

| Poäng | Nivå | Behandling | Vad som händer |
|---|---|---|---|
| ≥ 0,72 | `hog` | `annonsera` | Läses upp som ett konstaterande |
| 0,48–0,71 | `medel` | `hedga` | Läses upp som ett referat |
| 0,28–0,47 | `lag` | `tyst` | Visas på kartan, sägs inte |
| < 0,28 | `svag` | `undanhall` | Varken röst eller karta |

Gränserna är snedställda mot tystnad. Steget upp till `annonsera` kräver 0,72
därför att det är det enda steg som får appen att låta som om den **vet**.
Steget ner till kartan går redan vid 0,48, för en tyst kartnål har ingen
kostnad om den är fel.

### Kalibreringspunkten

Normalfallet — knapptryck i appen, egen GPS, måttlig fart, ingen historik —
landar på **0,77**, alltså strax över annonseringsgränsen.

Det är avsiktligt. Lagret är byggt för att **degradera** misstänkta rapporter,
inte för att befordra vanliga. Skulle den vardagliga rapporten hedgas skulle
allt hedgas, distinktionen sluta betyda något, och appen bli sämre än den var
utan lagret. Allt som drar ner den vardagliga rapporten — fart, dålig
geokodning, ålder, motsägelser — flyttar den till hedgat läge.

Några verkliga utfall ur testerna:

| Fall | Poäng | Nivå |
|---|---|---|
| Knapp, 50 km/h, 24 bekräftelser i historiken | 0,88 (tak) | annonsera |
| Knapp, 95 km/h, okänd rapportör | 0,72 | annonsera, precis |
| Knapp, 115 km/h, okänd rapportör | 0,70 | hedga |
| Samma som ovan men med en oberoende rapport | 0,89 | annonsera |
| Rapport 26 min gammal (58 % av livslängden) | 0,64 | hedga |
| Knapp men inlämnad 6 min efter passagen | 0,61, position 9 km | undanhåll |
| Två nedröstningar | 0,45 (tak) | tyst |
| Facebook-inlägg som geokodades till ortsnivå | 0,19 | undanhåll |

Lägg märke till raden med 6 minuters fördröjning: poängen är hygglig — det är
troligen en sann rapport — men positionen är nio kilometer osäker och gör den
oanvändbar. Poäng och position är två olika frågor, och båda måste vara
besvarade för att appen ska få säga något.

---

## 5. Formuleringen

Det här är hela poängen med modulen, och den enda delen föraren faktiskt möter.

En förare kan hantera *"polis rapporterad framför dig"* även när det visar sig
vara fel. Hen saktar ner, tittar efter, ser ingenting, kör vidare — och känner
sig inte lurad, för appen sa aldrig att den visste. Samma förare som fått höra
*"det står polis vid Stora gatan"* och inte ser någon polis vet att appen
påstod något som inte stämde.

Skillnaden mellan att referera och att gå i god ligger i ett enda ord, och det
ordet är det viktigaste i hela appen.

### Tre hedgningar som är oberoende av varandra

De misslyckas på olika sätt och måste därför gå att sätta var för sig.

**FAKTA** — `rapporterad` istället för ett konstaterande. Slås på så fort
appen inte skulle satsa pengar på uppgiften. Referatformen tappar också
ordet "Varning." helt: det ordet är appens eget påstående, och här påstår
appen ingenting, den vidarebefordrar.

**PLATS** — `i området kring X` istället för `vid X`. Slås på när punkten är
osäker, även om själva patrullen är trolig. Det här är det vanligaste felet av
alla, och det som annars låter mest exakt.

**ÅLDER** — `för tjugo minuter sedan` läggs till när rapporten hunnit bli
gammal. Ett gammalt fel är en annan sorts fel: uppgiften var sann men bilen
har åkt. Föraren hanterar det på ett annat sätt än en uppgift som aldrig
stämde, och behöver därför veta vilken sort det är.

### En regel till, lätt att missa

**När platsen är hedgad tas klockriktningen bort.** Att säga "klockan 2" om en
punkt vi är 400 meter osäkra på är en precision vi inte har. Falsk precision
är samma svek som ett falskt påstående, bara svårare att upptäcka.

### Exempel

| Läge | Mening |
|---|---|
| Hög, exakt position | **Varning. Polis vid Stora gatan, om 600 meter klockan 2.** |
| Medel, exakt position | **Polis rapporterad vid Stora gatan, om 600 meter klockan 2.** |
| Medel, osäker position | **Polis rapporterad i området kring Stora gatan, om 600 meter.** |
| Medel, gammal rapport | **Polis rapporterad vid Stora gatan för 26 minuter sedan, om 600 meter klockan 2.** |
| Medel, osäker, utan platsnamn | **Polis rapporterad någonstans här omkring, om 600 meter.** |
| Låg | *(inget sägs — nålen finns på kartan)* |
| Svag | *(ingenting alls)* |

### På kartan

`kortText()` ger den korta raden i listan och på nålen. Den visas även för
nivåer som inte sägs högt — hela poängen med `tyst` är att rapporten finns
att se för den som tittar.

```
Bekräftad av 3 · 4 min
Enskild rapport · 12 min · osäker
Obekräftad · 20 min · ungefärlig plats
```

---

## 6. Dubbletter

Den svåra avvägningen: två rapporter om samma patrull från olika positioner
ska bli en, men **två verkliga patruller på samma väg får aldrig bli en**. Det
andra misstaget är värre — det döljer en patrull som finns, och en dold
patrull är precis det appen ska förhindra.

### 6.1 Fyra villkor, alla måste hålla

**Typerna måste beskriva samma sak.** Släktskapet är en tabell, inte en
likhetsjämförelse:

| Par | Släktskap | Slås ihop |
|---|---|---|
| samma typ | 1,0 | ja |
| `police` + `control` | 0,6 | ja — en markerad bil vid en avspärrning och "trafikkontroll" är ofta samma händelse med olika ord |
| `police` + `unmarked` | 0,25 | **nej** — en civil bil och en markerad bil ser helt olika ut, och att slå ihop dem döljer den ena |
| `control` + `unmarked` | 0,25 | nej |

Gränsen går vid 0,5.

**Tiden.** Högst **typens trovärdighetstid** isär — polis 45 min,
trafikkontroll 60, civil 30 — med 12 minuter som golv för typer utan känd
livslängd. Den kortaste av de två typernas tid vinner: en civil bil är otrolig
redan efter 30 minuter, och att para ihop den med en polisrapport en timme
senare vore att låta den längre livslängden smitta den kortare.

Talet var ett fast 12-minutersfönster fram till 2026-08-23. Det var ofarligt så
länge en rapport bara levde 45-60 minuter — det fanns sällan mer än två
samtidiga rapporter om samma patrull att slå ihop. Med fyra timmars visningstid
(`VISNING_MINUTER` i `js/store.js`) ligger fyra Facebook-inlägg om samma polis
kvar samtidigt, och eftersom aliasuppslaget ger EXAKT samma koordinat för samma
platsnamn staplas nålarna ovanpå varandra så att bara den översta går att
trycka på. **Mätt** med `bedomFlodet()`: fyra inlägg om polis vid Hälla,
identisk koordinat, 0/20/45/80 minuter gamla, gav fyra kluster med en medlem
vardera. Med typens livslängd blir det två — {0, 20, 45} och {80} — vilket är
rätt svar: efter 45 minuter är det ett nytt tillfälle.

`store.add()` slog redan ihop på samma tal (`js/store.js`), men den spärren
gäller bara det som skrivs på den egna telefonen; bryggans rader kommer in via
`refresh()` och passerar den aldrig. Nu räknar båda likadant.

**Absolut avstånd.** Högst **700 meter**, oavsett vad osäkerhetsmatematiken
säger. Ett tak som inte går att argumentera bort.

**Riktningsuppdelat avstånd.** Se nedan.

### 6.2 Längs och tvärs

Det här är kärnan. Felet från fördröjningen ligger **längs vägen**, inte runt
om. Två rapporter som skiljer 200 m längs samma väg kan mycket väl vara samma
patrull sedd av två bilar med olika reaktionstid. Två som skiljer 200 m
**tvärs** vägen står på olika gator.

Känner vi rapportörens kurs delas separationen upp:

```
längs = |separation · cos(bäring − kurs)|
tvärs = |separation · sin(bäring − kurs)|

tillåtet längs = √(isoA² + isoB² + längsA² + längsB²) + 150 m
tillåtet tvärs = √(isoA² + isoB²)                     + 60 m
```

Bara längsleden får den generösa marginalen från fartberoende osäkerhet.
Tvärsleden får bara GPS- och geokodfelet plus 60 m, för åttio meter åt sidan
är en annan gata. **Ett runt avstånd hade slagit ihop parallellgator**, och
E18 med sina parallella lokalgator genom Västerås är exakt den geometri
appen körs i.

Känner vi ingen kurs blir toleransen rund — men utan att någon riktning får
längsmarginalen:

```
tillåtet = √(totalA² + totalB²) + 150 m
```

**Grundtilläggen.** 150 m längs är ungefär vad två förare skiljer sig åt i
reaktionstid vid samma iakttagelse. 60 m tvärs är smalare än avståndet mellan
två parallella körfältsgrupper med mittremsa, men bredare än en normal
GPS-avvikelse i tätort.

**Olika kända vägnamn krymper toleransen med 20 %.** Namnen kommer från omvänd
geokodning och är inte pålitliga nog att fälla avgörandet ensamma, så de
skruvar åt istället för att sätta stopp.

**Effekten av matematiken.** Två rapporter med 15 m GPS-fel vardera, båda
gjorda i 80 km/h, får en tvärstolerans på **81 m** och en längstolerans på
**277 m**. Samma två rapporter i stadsfart (30 km/h) får 81 m tvärs och
201 m längs. Toleransen längs vägen växer alltså med farten, precis som felet
gör — medan toleransen tvärs vägen står still, för den har ingenting med
farten att göra.

Precision tas därmed på orden: två väl placerade rapporter som ligger 100 m
isär **tvärs** färdriktningen förblir två saker även om de kom in samtidigt,
medan samma 100 m **längs** vägen blir en. Det är avsikten.

### 6.3 Ledarklustring, inte enkellänkad

Varje medlem måste likna **ledaren**, inte bara någon annan medlem.

Enkellänkad klustring kedjar: A liknar B, B liknar C, och plötsligt är hela
E18 genom Västerås en enda patrull trots att A och C ligger två kilometer
isär. Testet med sex rapporter jämnt fördelade 150 m isär över 750 m ger med
ledarklustring **tre kluster om två** — inte ett kluster om sex.

Utöver det finns en **diametervakt**: ingen medlem får ligga mer än 900 m från
någon annan medlem i samma kluster.

**Ledare blir den rapport som har säkrast position, inte högst trovärdighet.**
Positionen är det klustret ärver, så det är precisionen som ska styra vem som
får sätta punkten.

### 6.4 Klustrets position

Inversvariansviktat medelvärde: en rapport med 800 m osäkerhet väger ungefär
en hundradel av en med 80 m. Ett platt medelvärde hade låtit en grov
geokodning dra punkten flera hundra meter.

Klustrets osäkerhet sätts till `max(minsta enskilda osäkerhet, halva
diametern)`. Att kombinera tre mätningar matematiskt ger en snävare siffra —
men **bara om de mäter samma sak**, och det är precis vad vi har gissat oss
till, inte vetat. Att låta klustringen göra appen mer självsäker vore att
förstärka sitt eget antagande.

### 6.5 Ordningen spelar roll

`bedomFlodet()` grupperar **först** och bedömer **sedan**. Bedöms rapporterna
var för sig blir tre rapporter om samma patrull tre svaga varningar istället
för en stark.

---

## 7. Vad det här kan och inte kan

Det viktigaste avsnittet i dokumentet.

**Trovärdighetsbedömning på gles data är gissning med struktur, inte sanning.**
Talen ovan är inte mätta. De är resonerade fram ur hur bilar, telefoner och
människor beter sig, och de ser mer exakta ut än de är eftersom de skrivs med
två decimaler. En rapport som får 0,71 och en som får 0,73 skiljer sig inte
åt på något sätt som går att belägga — de hamnar bara på var sin sida om en
gräns någon har dragit. Strukturen är värd något ändå: den gör resonemanget
synligt, konsekvent och möjligt att argumentera emot. Det är hela anspråket.

### 7.1 Vad det fångar rimligt bra

* **Grova geokodningar.** Ett ortsnamn eller en stadsdel har en radie som är
  känd, och den radien räcker för att döma ut rapporten oavsett hur trovärdig
  författaren är.
* **Fartförskjutna nålar.** Fysik. Fart gånger tid är hundra meter i
  motorvägsfart, och det är inte en gissning.
* **Dubbletter från olika positioner längs samma väg.** Geometrin är den
  förväntade och toleranserna är byggda för just den.
* **Rapporter som andra aktivt sagt emot.** Två nedröstningar är riktig
  information från människor som varit på platsen efteråt.
* **Rapportörer med lång dålig historik.** Efter ungefär tio rapporter börjar
  historiken säga något verkligt.
* **Gamla rapporter.** Tiden är känd exakt.

### 7.2 Vad det inte fångar

* **En övertygad rapportör som har fel.** Någon som ser en vit skåpbil med
  antenner och rapporterar civil polis får full poäng. Ingenting i modellen
  kan skilja en säker felaktig iakttagelse från en säker riktig — det finns
  ingen signal att titta på.
* **Fördröjning som ingen berättar om.** Det största enskilda felet i hela
  kedjan — knapptrycket flera minuter efter passagen — upptäcks bara om
  `fordrojningS` skickas in. Utan det antas fyra sekunder, och en rapport som
  i själva verket är två kilometer fel behandlas som exakt. **Det här är
  modellens svagaste punkt**, och den går bara att fixa i gränssnittet, inte
  här: appen måste fråga, eller mäta tiden från att skärmen väcktes.
* **Oberoende när `device_id` saknas.** Det publika flödet lämnar inte ut
  fältet. Två rapporter från samma person ser då ut som två personer. Bonusen
  halveras och en flagga sätts, men gissningen kvarstår.
* **Samordnade falska rapporter.** Tre personer som kommer överens om att
  rapportera polis på en tom väg ser för modellen ut som det starkaste beviset
  som finns. Samstämmighet mäter enighet, inte sanning, och det finns ingen
  version av den här modulen som klarar det.
* **En patrull som flyttar sig.** En rapport 400 m från en annan tio minuter
  senare kan vara samma bil som körde dit. Modulen kallar dem två saker. Det
  är det säkra felet, men det är ett fel.
* **Två patruller på exakt samma plats.** De blir en. Sällsynt, och den
  varning som ges är ändå riktig.
* **Rapporter från vägar som inte finns i kartan.** Geokodningen kan inte
  vara bättre än sitt underlag.
* **Om patrullen fortfarande står kvar.** Åldern är en proxy för det, och en
  dålig sådan. En kontroll kan stå i två timmar eller åtta minuter.

### 7.3 Vad det medvetet inte försöker göra

* **Rangordna rapportörer mot varandra.** Historiken används bara som
  ja/nej-signal på om någon brukar ha fel, aldrig för att bygga en hierarki.
* **Lära sig.** Inga vikter justeras av utfall. En modell som tränar på sina
  egna varningar skulle förstärka sina egna misstag, och det finns ingen
  facitkälla — ingen rapporterar in att polisen faktiskt stod där.
* **Införa fler rapporttyper.** Nykterhetskontroller och fartkameror är
  aldrig användarrapporterbara. Regeln sitter i `js/parser.js`; den här
  modulen har bara ett skyddsnät (avsnitt 8) och lägger aldrig till något.

---

## 8. Skyddsnätet

Före all poängsättning körs regler som inte går att köpa sig förbi med hög
poäng:

| Regel | Utfall |
|---|---|
| Typen är inte `police`, `control` eller `unmarked`, och källan är inte en användarkälla | `ejTillamplig` — inte vår sak. Fartkameror ur den medföljande listan har känd koordinat och mätriktning, och `alerts.js` formulerar dem själv. |
| Typen är `camera` **och** källan är en användarkälla | `undanhåll` |
| Texten innehåller nykterhets- eller drogkontrollord | `undanhåll` |
| Koordinaten ligger utanför Sverige (samma gränser som `schema.sql`) | `undanhåll` |

De två mittersta raderna ska aldrig träffa. `parser.js` fångar båda innan det
blir en rapport. Nätet finns för att en framtida väg in i store — en import,
en delad länk, en ny knapp — inte tyst ska kunna öppna hålet.

---

## 9. API

```js
import {
  bedomRapport, grupperaRapporter, bedomFlodet, arSammaPatrull,
  positionsOsakerhet, byggMening, kortText, sammanfatta,
  BEHANDLING, NIVA, DEFAULTS,
} from './kvalitet.js';
```

| Funktion | Vad den gör |
|---|---|
| `bedomRapport(rapport, kontext, opts)` | Bedömer en rapport. Returnerar poäng, nivå, behandling, osäkerhet, hedgningsflaggor och en läsbar lista med skäl. |
| `grupperaRapporter(rapporter, kontext, opts)` | `{ kluster, index }` — vilka rapporter som är samma patrull. |
| `bedomFlodet(rapporter, kontext, opts)` | `{ grupper, index }` — hela kedjan, gruppering före bedömning. Det här är den som ska kopplas in. |
| `arSammaPatrull(a, b, opts)` | Parvis dom med motivering på svenska. |
| `positionsOsakerhet(rapport, opts)` | `{ total, iso, langs, delar }` i meter. |
| `byggMening(bedomning, rapport, visning)` | Meningen rösten ska säga, eller `null` om den ska tiga. |
| `kortText(bedomning, rapport, nu)` | Kort rad till karta och lista. |
| `sammanfatta(bedomning)` | Flerradig felsökningstext. Aldrig något föraren ser i körläge. |

**Fält som gärna får skickas in men är valfria** — modulen fungerar utan dem,
sämre: `gpsAccuracyM`, `fartKmh`, `kurs`, `fordrojningS`, `geokod`,
`geokodTyp`, `geokodRadiusM`, `parserConfidence`.

`fordrojningS` är den enskilt mest värdefulla av dem. Se 7.2.

`kontext` tar `nu`, `grannar` (andra rapporter att jämföra mot), `historik`
(`device_id` → `{ reports, confirmed, denied }`, som Map, objekt eller
funktion) och `osakerhetM` (används internt av `bedomFlodet` för att inte
dubbelräkna klustrets spridning).

Alla trösklar går att ändra per anrop genom `opts`, som slås ihop över
`DEFAULTS`.
