# Fartkameror — var datan kommer från och vad den inte vet

`data/cameras.json` är listan appen varnar för. Den här filen förklarar var
den kommer ifrån, hur man uppdaterar den, vad licensen kräver och — viktigast
— vad datan inte kan svara på.

Uppdatera med:

```powershell
.\tools\hamta-kameror.ps1          # hämtar och visar diffen, rör ingen fil
.\tools\hamta-kameror.ps1 -Skriv   # skriver data/cameras.json
```

---

## Källa

OpenStreetMap, via Overpass API. Fartkameror är fysiska föremål vid vägen, så
de är kartlagda i OSM som `node[highway=speed_camera]` — med mätriktning och
platsnamn, och utan API-nyckel.

Alternativet är Trafikverkets öppna data, som är den formella källan bakom de
svenska ATK-kamerorna. Det kräver registrering och en API-nyckel, och i
praktiken är OSM-datan en import av samma register: platsnamnen i OSM är
ordagrant Trafikverkets egna (`"Stockholmsv väster om Åbylundsv"`,
`"Kvicksund, norrgående"`). Vill man ändå gå direkt till källan finns
`tools/import-cameras.html`.

### Den exakta frågan

Det här är vad skriptet skickar för standardområdet (hela Sverige). Frågan
sparas också i fältet `fraga` inuti `data/cameras.json`, så att filen alltid
kan förklara sig själv:

```overpassql
[out:json][timeout:300];
area["admin_level"="2"]["ISO3166-1"="SE"]->.omrade;
node["highway"="speed_camera"](area.omrade);
out body;
```

De andra områdena byter bara ut `area`-raden:

| `-Omrade`     | area-filter                                              | antal (2026-08-19) |
|---------------|----------------------------------------------------------|--------------------|
| `sverige`     | `area["admin_level"="2"]["ISO3166-1"="SE"]`                | 2 466              |
| `malardalen`  | `area["admin_level"="4"]["ISO3166-2"~"^SE-(U\|C\|AB\|D\|T\|W)$"]` | 756          |
| `vastmanland` | `area["admin_level"="4"]["ISO3166-2"="SE-U"]`              | 40                 |

Områdena anges med ISO 3166-2-koder, inte med en ruta i grader. Det är en
poäng och inte pedanteri — se nästa avsnitt.

---

## Varför hela Sverige och inte bara Västmanland

Den gamla filen innehöll 136 kameror och beskrevs som "Västmanland". Det
stämde inte. Den var hämtad med rutan `59.30,15.10,60.30,17.30`, alltså en
fyrkant ritad runt länet, och en fyrkant runt Västmanland tar med bitar av
Södermanland, Örebro, Uppsala, Stockholm och Dalarna på köpet.

Av de 136 låg **40 i Västmanlands län**. De andra 96 låg utanför. Kartan lovade
alltså inte det den höll, och gränsen gick vid en godtycklig longitud som
ingen kan förklara för en användare.

Att i stället skära exakt på länsgränsen hade gett 40 kameror — en tredjedels
minskning av det appen faktiskt varnade för, och ett tyst tapp för alla som kör
över gränsen. Så det valet var uteslutet.

Det som avgjorde riktningen är `ROADMAP.md`:

- **Ruttläget** ("skriv Stockholm och få varningar längs vägen") är påbörjat.
  Den gamla rutan slutade vid longitud 17,30. Stockholm ligger på 18,07. En
  förare som körde E18 in mot stan fick alltså inga kameravarningar de sista
  fem milen, utan att något i appen antydde det. Det är precis den sortens
  tysta fel som är värre än ett synligt.
- **"Flera län"** är en betald nivå i prislistan (199 kr). Den kan inte byggas
  på en fil som inte innehåller flera län.
- **Expansion till Norge, Danmark och Finland** är planerad med "kameradata,
  platsnamn och språk som separata filer". En fil per land passar den modellen;
  en fil per godtycklig ruta gör det inte.

Och avgörande för att det är ofarligt: **`js/coverage.js` filtrerar redan
geometriskt.** Lägena `city`, `county`, `radius` och `route` avgör vad föraren
faktiskt hör. En kamera i Trelleborg finns i filen men når aldrig en förare i
Västerås. Bredare data ger alltså inte fler varningar — den gör bara att
varningarna inte tar slut vid en osynlig kant.

### Vad det kostar i storlek

Filen precachas av service workern (`sw.js`, `SHELL`), så varje användare
laddar ner den, och en gång till varje gång `VERSION` bumpas. Därför de exakta
siffrorna:

|                    | på disk   | gzip     | brotli   |
|--------------------|-----------|----------|----------|
| gammal (136 st)    | 43,7 kB   | 3,8 kB   | 3,0 kB   |
| ny (2 466 st)      | 283,2 kB  | 56,4 kB  | 43,8 kB  |

Netlify komprimerar med brotli, så **den verkliga kostnaden per användare och
version är cirka 41 kB extra** (3 → 44 kB). Det är mindre än en enda kartbricka,
och appen strömmar dussintals sådana per minut under körning.

Filen skrivs med **en kamera per rad** i stället för indenterad JSON. Samma
data indenterad hade blivit runt 790 kB. En rad per kamera ger dessutom
läsbara diffar.

Vill man ändå ha mindre finns `-Omrade malardalen` (756 kameror), som täcker
Västerås–Stockholm-stråket och grannlänen.

---

## Schemat

**Ändra inte fältnamnen utan att ändra `js/app.js` (`loadCameras`) och
`js/alerts.js` samtidigt.** Nästa utvecklare får annars jaga felet.

```json
{"id":"3717475485","lat":59.614219,"lon":16.594359,"name":"Stockholmsvägen öster om Ekevägen","bearing":90,"speedLimit":null}
```

| fält         | typ            | krävs | används till |
|--------------|----------------|-------|--------------|
| `id`         | sträng         | ja    | OSM-nodens id. Blir `cam-<id>` i appen. Stabilt över uppdateringar, så diffar fungerar. |
| `lat`, `lon` | tal, 6 dec.    | ja    | position. Sex decimaler ≈ 0,1 m, långt under GPS-felet. |
| `name`       | sträng / null  | nej   | `label` i appen, visas i popup. |
| `bearing`    | 0–359 / null   | nej   | mätriktning i kompassgrader. Se nedan. |
| `speedLimit` | 20–130 / null  | nej   | läses upp i varningen: "Fartkamera om 400 meter, 80". |

Toppnivån har `_om`, `kalla`, `omrade`, `fraga`, `osmTidsstampel`, `uppdaterad`
och `antal` innan `cameras`. `loadCameras()` läser bara `cameras` och ignorerar
resten, så metadata kan utökas fritt.

**Inga nya fält har lagts till.** De två som hade varit värda att lägga till —
mätriktning och hastighetsgräns — fanns redan som `bearing` och `speedLimit`.
Båda får vara `null` och appen hanterar det.

### Mätriktning: varför det är viktigare än det ser ut

`js/alerts.js` gör två riktningskollar innan den varnar. Den första är "kör vi
mot kameran" (`cameraConeDeg`). Den andra är den här:

```js
if (Number.isFinite(h.bearing)) {
  if (angleDiff(heading, h.bearing) > 90) return false;
}
```

En ATK-kamera mäter åt ett håll. Utan `bearing` varnar appen även den som kör
åt motsatt håll förbi den — en varning för ingenting, varje gång, på samma
ställe. Det är det snabbaste sättet att lära en förare att strunta i appen.

I OSM finns två taggar för det här: `direction` och `camera:direction`.
Skriptet läser båda. **I den svenska datan används i praktiken bara
`direction`** — `camera:direction` förekommer noll gånger på 2 466 kameror.
Täckningen är 2 411 av 2 466 (97,8 %).

Två noder har `direction=forward` respektive `direction=backward`. De
**hoppas över med flit**. De betyder "åt samma håll som vägen är ritad" och går
inte att översätta till en kompasskurs utan att också hämta vägens geometri.
Hellre ingen riktning (appen varnar åt båda hållen) än en påhittad riktning
(appen tiger åt rätt håll).

### Hastighetsgräns

Bara 381 av 2 466 kameror (15 %) har `maxspeed` taggad. Appen får aldrig
förutsätta att fältet finns — och gör det inte: `alerts.js` lägger bara till
gränsen i uppläsningen om den finns.

Hastighetsgränsen för vägen man kör på är en helt separat sak och kommer från
`js/speedlimit.js`, som hämtar vägdata i brickor. `speedLimit` här är bara den
gräns kameran mäter mot.

---

## Licens och attribution

Datan är © OpenStreetMap-bidragsgivare och licensierad under **ODbL 1.0**
(Open Database License).

ODbL ställer två krav på oss:

1. **Attribution.** Den som ser datan ska få veta att den kommer från OSM.
2. **Share-alike.** Distribuerar man en bearbetad version av databasen ska den
   också vara tillgänglig under ODbL.

**Uppfyller appen kraven? Ja — med ett fel som behöver rättas.**

Attributionen på kartan är korrekt och tillräcklig. `js/map.js` visar en
permanent attributionskontroll med `© OpenStreetMap` länkad till
`openstreetmap.org/copyright`, i både dag- och nattläge. Det är exakt den form
OSM själva anger som godtagbar, och den syns på samma skärm som kamerorna
ritas ut på. Något mer krävs inte för kartdelen.

Share-alike är också uppfyllt: `data/cameras.json` ligger öppet på sajten,
innehåller `"kalla": "OpenStreetMap-bidragsgivare, ODbL"` och den exakta
frågan i klartext. Vem som helst kan hämta filen och se både licensen och hur
den togs fram.

> **⚠️ Att rätta:** `index.html` (avsnittet "Om") säger
> `Kartdata © OpenStreetMap-bidragsgivare. Kameradata © Trafikverket.`
> Den andra meningen stämmer inte längre — kameradatan i `data/cameras.json`
> kommer från OpenStreetMap under ODbL, inte direkt från Trafikverket. Raden
> bör bli ungefär `Kartdata och kameradata © OpenStreetMap-bidragsgivare
> (ODbL).` Ändringen ligger i `index.html`, som inte hör till den här
> uppgiftens filer, så den är inte gjord.

---

## Hur ofta ska den uppdateras

**Var tredje månad räcker, plus efter en tidningsnotis om nya ATK-kameror.**

Trafikverket sätter upp några tiotal nya kameror per år i hela landet, och OSM
följer efter inom veckor till månader. Vid den här uppdateringen hade ingen av
de 136 gamla kamerorna flyttats eller tagits bort. Datan rör sig långsamt.

Det som talar för att köra oftare är att det är gratis och tar tio sekunder.
Det som talar emot att köra det automatiskt i en pipeline är att en tyst
automatisk uppdatering kan skjuta in ett fel utan att någon tittar. Därför
skriver skriptet ingenting utan `-Skriv`, och därför skriver det ut en diff
först.

Efter en uppdatering: **bumpa `VERSION` i `sw.js`**, annars ligger den gamla
filen kvar i service workerns cache hos alla befintliga användare.

---

## Vad datan inte kan svara på

Det här är den viktigaste delen av dokumentet. En kamera som appen varnar för
och som inte finns urholkar förtroendet; en som fattas är ett tyst fel. Datan
kan bara det den kan:

- **Mobila kameror och trafikpolis finns inte här.** Filen innehåller bara
  fasta ATK-skåp. Polisens laserkontroller, civila bilar och tillfälliga
  mätplatser är hela anledningen till att appen har användarrapporter och en
  Facebook-koppling. De två datakällorna löser olika halvor av problemet, och
  ingen av dem ersätter den andra.
- **Om skåpet är påslaget vet ingen.** Svenska ATK-skåp står ute året runt men
  är bara aktiva en del av tiden, och vilken del är inte offentligt. OSM vet
  att skåpet står där, inte om det mäter just nu. Appen ska därför aldrig
  påstå att man blir fotograferad — bara att det finns en kamera.
- **Sträckmätning (medelhastighet) hanteras inte.** En sträck-ATK mäter mellan
  två punkter, och det som spelar roll är snitthastigheten över hela sträckan,
  inte farten vid skåpet. I OSM modelleras det som en `relation[enforcement]`
  med separata `from`- och `to`-noder — inte som `highway=speed_camera`-noder.
  Frågan hämtar dem alltså inte, och appen skulle varna fel om den gjorde det:
  att sakta ner precis vid mätpunkten hjälper inte. Vill man stödja det är det
  en egen funktion, inte ett extra fält.
- **Kameror som ingen kartlagt finns inte.** OSM är frivilligarbete. En helt ny
  kamera kan stå månader innan någon lägger in den. Täckningen i Sverige är i
  praktiken god eftersom listan kommer från Trafikverkets register, men den
  garanterar ingenting.
- **`bearing` saknas på 55 kameror (2,2 %).** För dem varnar appen åt båda
  hållen. Det är avsiktligt — hellre en varning för mycket än att tiga åt rätt
  håll.
- **Hastighetsgränsen saknas på 85 %.** Se ovan.
- **Namnen är Trafikverkets fältnamn, inte adresser.** `"Törunda,
  södergående"`, `"VVIS efter Stålbergsvägen"`. Skriptet skriver ut de värsta
  förkortningarna (`Stockholmsv` → `Stockholmsvägen`) men gör inga adresser av
  dem.

---

## Fallgropar i hämtningen

Fyra saker som redan har kostat tid i det här projektet. Alla är hanterade i
`tools/hamta-kameror.ps1`, men den som skriver om skriptet ska känna till dem.

**1. `Invoke-RestMethod` förstör svenska tecken.** PowerShell 5.1 gissar
teckenkodning fel när servern inte skickar charset i `Content-Type`, tolkar
UTF-8-bytes som Latin-1 och gör `Västerås` till `VÃ¤sterÃ¥s`. Felet syns inte
förrän en förare hör appen läsa upp mojibake. Lösningen är
`Invoke-WebRequest -UseBasicParsing` och sedan avkoda själv:

```powershell
[System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
```

Den gamla filen bar faktiskt ett sådant spår: platsnamnet
`"Stockholmsvägen väster om Åbylundsvägen"` innehöll ett osynligt
kontrolltecken `U+0085` direkt efter `Å`. Det är rättat nu.

**2. Overpass svarar 429 när platserna är slut, och 504 när den är
överbelastad.** Att köra igen direkt gör bara att man blir avstängd. Skriptet
backar av med 10, 30, 60, 120, 240 sekunder plus slump, respekterar
`Retry-After` när servern skickar en sådan, och byter instans mellan försöken.
Under det här arbetet svarade `overpass-api.de` 504 två gånger på fem minuter
— det är normalt, inte ett fel i frågan.

**3. En URL i `User-Agent` ger 406 Not Acceptable.** `overpass-api.de` sitter
bakom en Apache-regel som avvisar anrop så fort ett värdnamn eller en URL dyker
upp i `User-Agent`. `Polisvakt/1.0 (https://polisvakt.netlify.app)` ger 406;
`Polisvakt-hamta-kameror/1.0 (fartkameradata till Polisvakt-appen)` går igenom.
Felet ser ut som en trasig fråga men är bara filtret.

**4. `overpass.osm.ch` har bara schweizisk data.** Den svarar glatt `200 OK`
med noll element på en fråga om Sverige. Därför behandlar skriptet ett tomt
svar som ett fel och provar nästa instans — noll kameror är aldrig ett rimligt
svar för ett helt land. Skriptet använder samma två instanser som
`js/speedlimit.js`: `overpass-api.de` och `overpass.kumi.systems`.

### Skyddsnät i skriptet

- Skriver aldrig utan `-Skriv`.
- Vägrar skriva om nya listan har mindre än hälften så många kameror som den
  gamla (`-Tvinga` går förbi). Ett stort tapp beror nästan alltid på en trasig
  fråga, inte på att kamerorna försvunnit över natten.
- Avbryter med felkod om ingen instans svarar. **Den hittar aldrig på data.**
- Säkerhetskopian läggs i `%TEMP%`, inte bredvid filen — `package.ps1` tar med
  allt i mappträdet utom en kort undantagslista, så en `cameras.json.bak` i
  `data/` hade publicerats på sajten.

---

## Ändringar 2026-08-19

Uppdaterat mot OSM per `2026-08-19T10:37:36Z`.

| | |
|---|---|
| tillagda | 2 330 |
| borttagna | 0 |
| flyttade > 25 m | 0 |
| ändrad mätriktning | 0 |
| ändrad hastighetsgräns | 0 |
| rättade namn | 1 (`U+0085` efter `Å`, se ovan) |

Ingen av de 136 gamla kamerorna hade tagits bort eller flyttats — den gamla
datan var alltså korrekt, bara godtyckligt avgränsad. Hela tillskottet kommer
av att området gick från en ruta runt Västmanland till hela Sverige.

Kvarstår: `VERSION` i `sw.js` behöver bumpas, och attributionsraden i
`index.html` behöver rättas. Båda ligger i filer som inte hörde till den här
uppgiften.
