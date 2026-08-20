# Lutning — telefonen får sitta snett

## Vad som var fel

Målsökningen krävde att telefonen hölls rak. Det stod ingenstans, och det var
ingen som bestämt det — det föll ut av hur sökningen mätte.

`skannaLjusa` plockade ut ljusa sammanhängande områden och bedömde dem på deras
**axelparallella omslutande låda**: kvot mellan 2,2 och 8, fyllnad över 0,45.
För en skylt som ligger rakt i bild är lådan skylten, och måtten stämmer. För en
skylt som lutar 30° är lådan nästan kvadratisk:

| | Rak skylt | Lutad 30° |
|---|---|---|
| Lådans kvot | 4,7 | **1,4** |
| Fyllnad (yta / låda) | 0,78 | **0,32** |

Båda filtren sa nej. Kandidaten fanns aldrig, siktet låste aldrig, och
textigenkänningen fick aldrig se skylten. Mätt före ändringen: **noll kandidater
vid 15°, 30°, 45° och ±90°.** Inte "läste fel" — det fanns ingenting att läsa.

En telefon i en bilhållare sitter sällan rak. Det var alltså ett krav på
verkligheten, precis som den fasta siktrutan var det innan målsökningen kom
(se `malsokning.md`). Samma sorts fel, en nivå längre in.

## Vilken väg som valdes, och varför

Två vägar fanns:

1. **Rotera arbetsbilden efter enhetens lutning** innan sökningen, med
   `DeviceOrientationEvent` eller `screen.orientation`.
2. **Göra detektionen rotationsokänslig** — mäta blobbens egentliga
   utsträckning i stället för dess omslutande låda.

Valet föll på **(2)**, av ett skäl som avgör: väg (1) kräver tillstånd. På iOS
måste rörelsedata begäras från ett riktigt knapptryck, och användaren kan säga
nej. Ett läsläge som bara fungerar efter ett knapptryck är inte ett läsläge som
fungerar. Kravet var uttryckligen att det ska fungera utan tillstånd också —
och den enda ärliga tolkningen av det är att sensorn inte får vara mekanismen.

Väg (1) har dessutom ett tystare problem: `screen.orientation` fångar bara de
diskreta 90°-lägena, och webbläsaren har oftast redan roterat videobilden efter
dem. Den kontinuerliga lutningen — telefonen som sitter 20° snett i hållaren —
syns inte där alls. Det är just det fallet som är det vanliga.

Sensorn finns kvar, men som **tillägg** och inte som förutsättning. Se
"Lutningsgivaren" nedan.

## Hur detektionen blev rotationsokänslig

### Andra ordningens moment

Under flödesfyllningen i `skannaLjusa` summeras redan varje pixel i blobben. Där
plockas nu också upp `Σx`, `Σy`, `Σx²`, `Σy²` och `Σxy` — fem additioner och tre
multiplikationer per pixel, i en slinga som ändå går igenom varenda pixel. Ingen
extra genomgång av bilden, ingen extra buffert.

Ur dem faller kovariansmatrisen kring blobbens tyngdpunkt, och ur den:

* **riktningen** på den långa axeln, `½·atan2(2·Cxy, Cxx − Cyy)`
* **längderna** längs de två axlarna. För en fylld rektangel är variansen längs
  en axel exakt `sida²/12`, alltså `sida = √(12λ)`.

Kvot och fyllnad mäts sedan mot den **vridna** lådan i stället för den
axelparallella. En lutad skylt får då samma mått som en rak, och passerar samma
oförändrade filter.

Uppskattningen är inte perfekt: blobben är skylten *minus* det mörka EU-fältet
och minus tecknen, så längden underskattas några procent. Mätt ger det kvot 4,1
i stället för 4,7 — mitt i det tillåtna spannet 2,2–8, och det är hela kravet.

### Dödband på 3°

Under 3° behandlas blobben som rak och går exakt den gamla vägen, med den
axelparallella lådan. Två skäl:

1. En skylt sedd **snett från sidan** är skjuvad, inte roterad. Skjuvning vrider
   huvudaxeln försumbart — en 15°-skjuvning ger 0,7° — och den hanteras redan av
   `uppskattaLutning` och `forbehandla({ lutning })`. Att börja rotera på den
   hade varit en andra mekanism för samma sak.
2. Allt som fungerade förut mäts bit för bit oförändrat. Poängen för de fem
   målsökningsfallen är identiska före och efter: 0,61 · 0,65 · 0,92 · 0,82 ·
   0,08.

### Teckenräkningen fick följa med

`raknaTeckenbyten` räknar hur många gånger en **vågrät** linje genom området
växlar mellan ljust och mörkt. Det är den enda faktorn som får döda en kandidat,
och den skiljer en skylt från en vit skåpbilsdörr.

En vågrät linje genom en skylt som står på snedden skär ett par tecken och en
massa botten. Svaret blir noll växlingar, alltså "slät yta", alltså kandidaten
dödad — samma fel som den omslutande lådan, en nivå längre in. Linjen måste luta
med skylten. `raknaTeckenbytenVriden` provar samma sak längs blobbens egna
axlar, med närmaste granne: vi räknar växlingar, inte pixlar, och en halv pixels
felplacering ändrar ingenting i det svaret.

Mätt ger det 13–15 växlingar på en lutad skylt, mot 12 på en rak. Samma
storleksordning, samma slutsats.

### Beskärningen roterar

Att hitta skylten räcker inte. Beskärs en 30°-lutad skylt till sin
axelparallella låda får motorn en nästan kvadratisk bild med skylten på
diagonalen och bakgrund i hörnen.

`forbehandla` tar därför emot `vridning` och beskär den **vridna** rektangeln:
mitten i `cx/cy`, sidorna i `rw/rh`, mätta längs skyltens egna axlar. Det sker i
samma enda `drawImage` som förut, bara under en annan matris — ingen extra
genomgång av pixlarna och ingen extra OCR-körning.

Skjuvning hade inte räckt här. En skjuvning rätar upp tecknens stammar men låter
textraden fortsätta gå på snedden, och motorn är inställd på att läsa **en rad**
(`tessedit_pageseg_mode: 7`). Det måste vara en riktig rotation. Skjuvningen
finns kvar och läggs ovanpå rotationen i samma matris, för de fall där skylten
både lutar och ses snett.

### Upp och ner

Huvudaxeln vet vilken linje skylten ligger längs, men inte åt vilket håll den
läses — en skylt och samma skylt vriden 180° ger identiska moment.

Vid små lutningar spelar det ingen roll: en bil som lutar 20° lutar 20°, den står
inte på taket. Vid liggande telefon gör det det, för då är +90° och −90° två helt
olika bilder. `lasRuta` provar därför en vänd beskärning — men bara när
lutningen är över 60° **och** första försöket inte gav någon giltig skylt. I
normalfallet kostar det ingenting.

## Lutningsgivaren

`Lutningsgivare` läser `devicemotion` och räknar ut hur telefonen lutar ur
tyngdkraften (`accelerationIncludingGravity`, inte rörelsen — en bil skakar,
tyngdkraften gör det inte), korrigerat med `screen.orientation.angle` eftersom
sensorns axlar följer höljet medan videobilden levereras i skärmens läge.

Tillståndsflaggorna lånas ur `js/impact.js`. Det är samma iOS-dialog och samma
händelse; att fråga två gånger för samma sak vore både påträngande och en andra
mekanism att hålla i synk.

Vad den används till: **exakt en sak.** Poängfaktorn `rakhet` straffar
kandidater som lutar, milt — en skylt i 45° behåller 84 %. Det är en
rangordning, inte ett filter: vid lika poäng ska den raka vinna, för en lutad
ljus stapel är oftare en dörrkarm eller en reflex än en skylt. Är givaren igång
mäts avvikelsen mot telefonens lutning i stället för mot noll.

Och den vägen kan **bara lyfta** en kandidat, aldrig sänka den:

```js
rakhet = Math.max(straff(vinkel), straff(vinkel − forvantadVinkel));
```

Utan tillstånd, med en sensor som inte svarat, eller med fel tecken på mätningen
blir svaret det samma som utan givare. Det är avsiktligt. Sensorn är ett tillägg
och får aldrig kunna göra läsaren sämre än den är utan.

Slås på med `reader.aktiveraLutning()`, som måste anropas från ett riktigt
knapptryck. Läget syns i `reader.lutningsinfo`.

## Mätning

Körs i `ocr-test.html`. Sex nya fall: hela scenen vriden 15°, 30°, 45°, +90° och
−90°, plus samma scen oroterad som kontroll.

| | Före | Efter |
|---|---|---|
| Rå bild rakt in i motorn | 6 av 10 | 6 av 10 |
| Pipeline (fast siktruta) | 8 av 10 | 8 av 10 |
| Målsökning (skylten var som helst) | 5 av 5 | 5 av 5 |
| **Lutning (bilden vriden)** | **1 av 6** | **6 av 6** |
| Integritet | 6 av 6 | 7 av 7 (en ny kontroll) |
| Kamera | fanns inte | 10 av 10 |

Den enda som gick igenom före var kontrollraden — den oroterade scenen.

### Lutningsfallen i detalj

| Fall | Kandidater före | Kandidater efter | Uppmätt vinkel | Lås vid bildruta | Läst |
|---|---|---|---|---|---|
| 15° | 0 | 1 | 15,0° | 8 | MLK907 |
| 30° | 0 | 1 | 29,9° | 8 | MLK907 |
| 45° | 0 | 1 | 44,9° | 8 | MLK907 |
| liggande +90° | 0 | 1 | 89,9° | 8 | MLK907 |
| liggande −90° | 0 | 1 | 89,9° | 8 | MLK907 |
| oroterad (kontroll) | 1 | 1 | 0° | 8 | MLK907 |

Vinkeln kommer ur bilden, inte ur någon sensor. Testet kör utan tillstånd och
utan `devicemotion` över huvud taget — det är hela poängen.

Poängen sjunker med lutningen, som `rakhet` är byggd för: 0,98 rak · 0,92 vid
15° · 0,86 vid 30° · 0,80 vid 45° · 0,53 liggande. Låsgränsen ligger på 0,16, så
även liggande har god marginal.

De två ±90-fallen är inte samma sak. Vid −90 är momentens gissning upp och ner,
och det är den vända beskärningen som räddar läsningen. Båda står med för att
just den vägen ska vara mätt och inte antagen.

### Kostnad

Sökning i en bildruta på 1920 × 1080, arbetsbredd 400, median över 81 körningar
på samma maskin:

| Scen | Före | Efter |
|---|---|---|
| Rak | 1,7 ms | 1,7 ms |
| Lutad 30° | 1,5 ms | 1,5 ms |
| Liggande 90° | 1,5 ms | 1,5 ms |

Skillnaden ligger under variationen mellan två körningar av samma kod
(±0,2 ms). Momenten kostar fem additioner per pixel i en slinga som redan
besöker varje pixel, och den vridna teckenräkningen körs bara för de blobbar
som faktiskt lutar — som mest en handfull per bildruta.

Taket på ~5 ms håller med marginal.

## Vad som fortfarande inte fungerar

* **Längden underskattas några procent.** Blobben är skylten minus EU-fältet och
  minus tecknen, och momenten mäter blobben. Kvoten blir 4,1 i stället för 4,7.
  Det spelar ingen roll för filtret, men den som jämför `forhallande` mot 4,7 rakt
  av kommer att bli förvånad.
* **Tyngdpunkten ligger något åt höger** av skyltens mitt, av samma skäl: det
  mörka EU-fältet sitter till vänster och räknas inte med. Beskärningen utgår
  från tyngdpunkten och tappar därför en bit av det vänstra fältet — vilket
  råkar vara precis det vi vill kapa. Det är tur, inte design, och det håller
  bara så länge svenska skyltar har EU-fältet till vänster.
* **En blob som inte är rektangulär** får fel längder. `√(12λ)` gäller för en
  fylld rektangel; en ellips eller en böjd ljusstrimma underskattas. Filtren tar
  hand om det i praktiken, men måtten är inte meningsfulla för sådana former.
* **Två skyltar som överlappar i bild** är fortfarande ett problem, och lutningen
  gör det inte mindre — nu kan de dessutom se ut som en enda lutad skylt med
  rätt kvot.
* **Sensorn ger inte absolut lutning i alla lägen.** `devicemotion` mäter
  tyngdkraften, och en telefon i en accelererande bil får ett litet fel som
  följer med accelerationen. Lågpassfiltret (0,08) dämpar det. Eftersom givaren
  bara får lyfta poäng och aldrig sänka den är felet ofarligt, men den som tänker
  bygga något mer på `lutningsinfo.vinkel` ska veta att den inte är en
  precisionsmätning.

## Kameran: 60 bildrutor i sekunden

Hör inte till lutningen men löser samma underliggande sak — att skylten är
suddig när den ska läsas.

`start()` ber om `frameRate: { ideal: 60 }`. Inte för att läsa fler bildrutor:
textigenkänningen kör ett par gånger i sekunden och sökningen åtta, så bildrutor
är det minsta vi saknar. Skälet är **exponeringstiden**. En kamera som ska hinna
med 60 rutor i sekunden kan aldrig exponera längre än 1/60 s per ruta, oftast
kortare. Vid 30 får den dubbelt så lång tid, och all den tiden rör sig bilen
framför. De två fall pipelinen fortfarande missar — "smutsig skylt" och "värsta
fallet" — handlar båda om att tecknen smetas ut.

`ideal`, aldrig `exact`. Ett hårt krav ger `OverconstrainedError` i stället för
det näst bästa, och då står läsaren helt still på en telefon som hade läst
skyltar alldeles utmärkt vid 30 bildrutor i 1080p.

### Kan högre bildfrekvens tvinga ner upplösningen?

**Ja.** `getUserMedia` väger alla `ideal`-önskemål mot varandra och väljer det
läge som sammanlagt ligger närmast. En telefon som klarar 1920 × 1080 vid 30 och
1280 × 720 vid 60 kan mycket väl svara med **1280 × 720** — den träffar då
bildfrekvensen exakt och missar upplösningen "bara" en bit. Det är en helt
rimlig avvägning för de flesta appar, och fel för den här.

**Vi väljer pixlar.** En skylt på 20 meters håll är runt 40 pixlar bred i 1080p
och under 30 i 720p, och under 24 pixlar slutar teckenräkningen svara ja eller
nej över huvud taget — den lägger sig mitt emellan för att inte döma ut varje
skylt på håll. Bildrutorna gör en suddig skylt skarpare; upplösningen avgör om
det finns en skylt att göra skarp. Att byta bort pixlar mot bildrutor är att
byta bort själva möjligheten mot en förbättring av den.

Därför: be om båda, **läs tillbaka vad vi fick**, och backa bildfrekvensen till
30 om upplösningen blev lidande. Gränsen ligger på 1280 px bredd
(`KAMERA.minBredd`) — får vi mindre än så och samtidigt mer än 30 b/s har
telefonen gjort det byte vi inte vill ha, och `applyConstraints` ber om samma
upplösning igen utan att pressa frekvensen. Resultatet behålls bara om det blev
bättre; vägrar kameran byta läge står vi kvar där vi var.

### Läs tillbaka, gissa inte

```js
reader.kamerainfo
// { bredd: 1920, hojd: 1080, bildfrekvens: 60,
//   begard: { bredd: 1920, hojd: 1080, bildfrekvens: 60, ... },
//   sanktForPixlar: false, maxExponeringMs: 17 }
```

`bildfrekvens` kommer ur `track.getSettings().frameRate` och är vad kameran
**gav**, inte vad vi bad om. En app som visar önskemålet i stället för utfallet
ljuger för den som felsöker. `sanktForPixlar` säger om vi fick backa, och
`maxExponeringMs` är taket på exponeringstiden — det bildfrekvensen faktiskt
köper. Skickas också som händelsen `'kamera'` när kameran startat.

`bildfrekvens` är `null` när webbläsaren inte rapporterar den. Det är inte ett
fel; visa "okänd" och gå vidare.

## Provläget

Hör till provkörning, inte till produkten.

Normalt skickas `'traff'` bara för ett av dina egna fordon. Allt annat som läses
slutar inuti `#rosta` och finns inte kvar efter att den funktionen returnerat —
en läsare som visar varje skylt den ser är en logg över främmande fordon, och
det är skillnaden mellan en läsare och ett spaningsverktyg.

Men den som provkör kan inte se om läsaren fungerar. Låset sitter, statusen går
`Låst på skylt — läser…` → `Bekräftar skylt…`, och sedan händer ingenting
synligt — vare sig läsningen blev rätt, fel eller uteblev.

`settings.provlage: true` låter `'traff'` skickas även för fordon som inte är
dina, med `egen: false`, `provlage: true` och **utan** `fordonId` och `etikett`.
Inget lagras, ingen lista förs, ingen historik byggs: samma kastas-direkt-
beteende som annars, skillnaden är enbart att appen får veta vad som lästes i
just det ögonblicket.

Det är alltså inte en vanlig inställning som en användare ska kunna slå på, och
den hör inte hemma på inställningssidan. Appen kopplar den till
`TESTLAGE_UTAN_INLOGGNING`, som redan är märkt "SKA SLÅS AV IGEN" — då försvinner
provläget av sig självt den dagen appen släpps, utan att någon behöver komma
ihåg det.

Förvalet är av, och det mäts (`ocr-test.html`, integritetstabellen).
