# Nattlogg — 18/19 augusti 2026

Löpande logg över autonom körning. En rad per avklarad sak.

| Tid | Vad | Filer |
|---|---|---|
| 22:15 | SQL-migrering körd skarpt: schema, användarnamn, dölj-enhets-id, push, grupper. Verifierad mot REST. | supabase/KOR-ALLT.sql |
| 22:40 | Sju moduler inkopplade i appen och utrullade som v18 | js/app.js, index.html, sw.js, css/app.css |
| 23:05 | Roadmap uppdaterad till verkligt läge (11/17), v19 | js/roadmap.js |
| 00:20 | Talknappen: hittade att `body.is-night .act` skrev över `.act-mic` — knappen var nästan svart med nästan svart text i nattläge. Lagad, samt två konkurrerande .act-mic-regler sammanslagna. | css/app.css |
| 00:35 | Mikrofon nekad ger nu en dialog med "Slå på" och plattformsspecifik instruktion, istället för en toast och en död knapp. Flaggan överlever omstart. | js/app.js, index.html, css/app.css |
| 00:50 | VAPID-nyckelpar genererat lokalt med .NET ECDsa (P-256). Publik nyckel inlagd i appen. | js/config.js |
| 01:26 | Edge-funktionen `send-reminder` deployad via dashboardens editor. Deploy-knappen låg under loggpanelen — löst genom att maximera fönstret och koppla bort överliggande lagers klickyta. | supabase/functions/send-reminder/index.ts |
| 01:33 | Hemligheter satta: VAPID_SUBJECT, VAPID_KEYS, CRON_SECRET. Överförda via privat storage-fil så de aldrig passerade chatten. Filen raderad direkt efteråt, verifierat 400. | — |
| 01:38 | JWT-grinden avstängd för funktionen. Den skyddar sig själv med CRON_SECRET, vilket är bättre än att lägga en servernyckel i ett cron-jobb. | — |
| 01:40 | **Hela kedjan verifierad skarpt:** `{"ok":true,"antal":0}`. Nycklarna importeras, databasen svarar, noll att skicka eftersom ingen prenumererar än. | — |
| 01:42 | Cron-jobb `polisvakt-paminnelser` var 5:e minut, active=true. | — |
| 01:55 | v20 utrullad. `capabilities().supported === true` i skarpa appen. | js/config.js, sw.js |

## Beslut jag fattade själv

- **Produktionen lämnas alltid verifierad.** Efter varje utrullning kontrollerar
  jag att appen bootar, att service workern tagit den nya cachen och att det
  går att klicka. Du ska kunna sätta dig i bilen imorgon utan att fundera.
- **Hemligheter passerar inte chatten.** VAPID-nyckeln och cron-hemligheten
  gick via en privat storage-fil som raderades direkt. Det kostade några extra
  steg men höll den privata nyckeln utanför loggen.
- **Push-notiser stängde jag inte av JWT för lättvindigt.** Funktionen har en
  egen hemlighet i headern; alternativet hade varit att lägga service-nyckeln
  i klartext i ett databasjobb, vilket är sämre.

## Kartan — rotorsak och fix (02:30)

Symptom: kartan svart, "laddar inte in förrän efter ett tag".

Mätning visade att brickorna var snabba (median 166 ms) men att bara **6**
laddades, och att de täckte y −155 till 101 på en 658 px hög karta. Allt under
101 px var svart och förblev svart.

Orsak: Leaflet läser containerns höjd en enda gång, vid skapandet. Kartan
skapades innan flexlayouten var färdigräknad, fick i praktiken höjden noll och
laddade en enda rad brickor. Ingenting bad den någonsin mäta om.

Fix, två delar: `.pv-map` fick explicit `position:absolute; inset:0` så rutan
har storlek redan vid första layouten, och `HazardMap` mäter om efter två
bildrutor plus via en `ResizeObserver` (täcker även skärmvridning).

Resultat live: 6 → **18 brickor**, full täckning, kartan målad efter **506 ms**.
(Första laddningen efter en ny version är långsammare, ~1,9 s, eftersom service
workern samtidigt hämtar hem hela appskalet. Det är engångskostnaden.)

## Dashcamen — två riktiga buggar (03:10)

Testad med en syntetisk kameraström genom hela kedjan (kameran är blockerad i
testpanelen, men allt utom själva kameraåtkomsten går att köra).

**Bugg 1: dashcamen vägrade starta.** `start()` kastade "Kameran startade men
skickade ingen bild" trots att strömmen levererade 30 bilder i sekunden.
Orsaken var att `#waitForFrame` bara hade två vägar att upptäcka en bildruta,
och båda kan tiga: `requestVideoFrameCallback` fyrar aldrig för ett
videoelement som webbläsaren inte komponerar — och våra videoelement är två
pixlar stora med opacity 0.01 just för att inte synas. Reservvägen använde
`requestAnimationFrame`, som ligger stilla när sidan inte ritas upp. Nu pollas
det med en timer, som stryps i bakgrunden men aldrig slutar gå.

**Bugg 2: inspelningen frös när skärmen släcktes.** `#loop()` ritade
bildrutorna via `requestAnimationFrame`. Eftersom det är canvasen som spelas
in blev filmen en frusen bild så fort telefonen låste skärmen eller appen
hamnade i bakgrunden — alltså under nästan hela en riktig bilfärd. Nu drivs
ritandet av en timer.

Verifierat efter fixen: `start()` OK, inspelning igång, canvas 1080×1920,
bilden rör sig (ljusstyrka 35→38→36 istället för konstant 0), och ett sparat
klipp går att spela upp: 1,75 MB, MP4/H.264, 1080×1920.

**Kvar att kontrollera på riktig telefon:** att bakkameran väljs och inte
selfiekameran, att två kameror samtidigt fungerar eller faller tillbaka snyggt,
och hur varm telefonen blir över tid. Det går inte att avgöra härifrån.

## Kameraval låst till rätt håll (03:40)

Ägaren påpekade att huvudbilden bara får vara bakkameran, och att frontkameran
enbart hör hemma på kupéspåret. Det fanns tre vägar runt det:

1. `start()` föll tillbaka på `facingMode: 'environment'` utan `exact`. Det är
   ett önskemål, inte ett krav — telefonen fick lämna vad som helst, och en del
   lämnar selfiekameran. Kommentaren i koden varnade för exakt detta medan
   koden en rad senare gjorde det. Nu kontrolleras spåret efteråt och avvisas
   med ett tydligt fel istället för att filma förarens ansikte hela resan.
2. `useCamera()` accepterade vilken kamera som helst som huvudbild.
3. Kameraväxlaren i gränssnittet stegade igenom alla kameror, selfiekameran
   inkluderad.

Kupéspåret begär nu `facingMode: { exact: 'user' }` av samma skäl åt andra
hållet — med `ideal` kunde telefonen lämna bakkameran igen, och då spelades
vägen in två gånger medan kupén inte filmades alls.

Verifierat i tre fall: selfiekamera erbjuden som huvudbild → vägrad; bakkamera
→ accepterad och spelar in; byte till selfiekameran under inspelning → vägrad
med förklaring.

## Lösa trådar knutna (04:15)

**facebook.js var aldrig inkopplad.** Modulen låg i repot och precachades, men
`window.polisvakt.ingest` körde fortfarande en förenklad variant skriven direkt
i app.js — utan dubblettkoll, utan åldersgräns på inlägg, utan redovisning av
vad som sorterades bort och utan torrkörning. Nu går allt genom modulen.

Torrkörningen är den viktiga delen: `polisvakt.ingest(inlägg, { dryRun: true })`
visar exakt vad som *hade* hänt utan att skriva något. Ett oläst flöde som
släpps lös fyller kartan med skräp för alla andra användare, och det går inte
att ta tillbaka.

Verifierat med fyra inlägg: polisrapport → skulle skapats, nykterhetskontroll →
vägrad, fartkamera → vägrad, brus → bortsorterat. Båda produktreglerna håller
alltså även när texten kommer utifrån och inte från rösten.

**Attribution saknades för två tjänster.** Appen använder OSRM för ruttberäkning
och Nominatim för adressökning. Båda är gratis och båda kräver att man anger
källan. Vi angav bara OpenStreetMap och CARTO. Nu står alla fyra i kartans
hörn. Det är inte en detalj — det är villkoret för att få fortsätta använda dem.

## PlateVision klar (04:30)

25 Swift-filer, ~4 930 rader, i en egen mapp helt skild från Polisvakt.
Kontrollerat av mig, inte bara rapporterat:

- **Gränsen håller.** Enda förekomsten av ordet "polis" i hela projektet är
  README:ns egen sektion om vad appen inte gör.
- **Ingen nätverkskod alls.** Noll träffar på URLSession, URLRequest eller
  http. Bildanalysen kan inte lämna telefonen ens av misstag.
- **Ingen skrivväg till listan.** Pipelinen ser bara ett protokoll med en enda
  läsmetod. Att spara skyltar som inte matchar är inte förbjudet i en policy —
  det går strukturellt inte att göra.
- **Skyltformatet stämmer.** Tillåtna bokstäver A–Z utan I, Q och V; sista
  positionen dessutom utan O. Det är inte en gissning utan regeln som gör att
  O/0-förväxlingen går att lösa i just den position där den annars vore
  omöjlig.
- **Mätvärdestabellen är tom med flit**, med skälet utskrivet: en påhittad
  siffra som ser rimlig ut är värre än ingen, för då trimmar man mot fantasi.

Ingenting är kompilerat. README:n leder med det och listar 15 punkter att
kontrollera i tur och ordning på en Mac.

## Vakthund — tystnad är ett besked (05:00)

Hela appen bygger på att föraren inte tittar på skärmen. Då betyder tystnad
"fritt fram". Men exakt samma tystnad uppstod när GPS:en tappats, när servern
inte svarade och när telefonen höll på att dö — appen märkte det och bytte
färg på en prick föraren blivit tillsagd att inte titta på.

Det är den farligaste sortens fel. En app som inte varnar är ofarlig. En app
som *slutat* varna utan att säga det är sämre än ingen app alls, eftersom den
först lärt föraren att lita på tystnaden.

`js/vakthund.js` bevakar tre saker och säger till högt — och lika viktigt när
de fungerar igen, för utan återställningsbeskedet vågar man aldrig lita på
appen efter första felet.

En bugg hittades och lagades under testningen: efter en återställning varnade
den om igen utan karens. En GPS som flappar i tunnlar hade gett en ström av
"borta / tillbaka / borta", och en förare som tröttnar stänger av rösten —
varpå appen slutar varna för allt. Karensen gäller nu även efter återställning.

Verifierat: still telefon en timme → 0 besked. Kör och tappar GPS → 1 varning.
Lokalt läge → tyst om synk. Batteri 8 % → varnar även stillastående.

## Rösten kunde avbryta sig själv (05:35)

Appen har numera sju system som kan tala: närhetsvarningar, rutt, vinter,
vakthund, krockdetektering, hastighet och bekräftelser. Fyra av dem använder
prioritet 2 med `interrupt: true`, och `interrupt` avbröt ovillkorligt — även
en lika viktig mening mitt i ett ord.

Resultatet i bil: "Polis rapporterad två kilo— jag har tappat GPS." Föraren
fick ingen av dem, i exakt det ögonblick båda var som viktigast.

Regeln är nu att avbrott bara sker mot något som är MINDRE viktigt. Lika
viktigt får vänta sin tur — kön är prioritetssorterad, så det kommer näst. En
fördröjd mening är oändligt mycket bättre än en halv.

Verifierat med attrapp-talsyntes: två prio 2 → första läses helt, andra köas,
noll avbrott. Krockvarning över hastighetsbesked → hastigheten avbryts korrekt.

## Tre spår inkopplade (06:30)

**Rapportkvalitet.** En falsk varning kostar mer än en missad. Rapporter graderas
nu och behandlas i fyra steg: annonsera, hedga, tyst, undanhåll.

Integrationen höll på att bli en katastrof och testet räddade den. Graderaren
vill ha `gpsAccuracyM`, `fartKmh`, `fordrojningS` och `geokod` — och `store.add`
satte inget av dem. Varje riktig rapport hade fått drygt en kilometers antagen
osäkerhet och tystats. Appen hade i praktiken slutat prata, utan att något
såg trasigt ut.

Två antaganden är nu uttalade i koden istället för underförstådda: `geokod:'gps'`
för knapptryck (telefonen stod på platsen — ingen geokodning inblandad), och
`fordrojningS: 15` som ett ANTAGANDE, inte en mätning. Tiden mellan att se
polisen och nå telefonen går inte att mäta, men att anta värsta fallet gör
appen stum.

**Värmevakt.** Inkopplad så rekommendationerna faktiskt utförs. Den avslöjade
en bugg i dashcam.js: `setSetting('fps')` och `setSetting('quality')` skrev
bara in värdet i objektet — ritloopen läser bildfrekvensen bara i start(), och
canvasstorleken sätts bara av #resizeCanvas(). En sänkning under pågående
inspelning gjorde alltså ingenting. En rekommendation som tyst ignoreras är
värre än ingen: både appen och föraren tror att något gjordes.

**Betalning.** js/betalning.js inkopplad i startCheckout, med enhets-id i varje
kassalänk. Utan det kommer betalningen fram men webhooken vet inte vems
prenumeration den ska förlänga — kunden betalar och får ingenting.

## Regressionen jag själv orsakade — och hittade (07:10)

Efter v27 fungerade mina egna rapporter perfekt. Andras var tysta.

Kvalitetsgraderingen behöver veta hur en rapport kom till. Jag fyllde i de
fälten när appen SKAPAR en rapport, men glömde att rapporter från andra förare
kommer via servern — och kolumnerna fanns inte där. Varje rapport utifrån fick
alltså drygt en kilometers antagen osäkerhet och tystades.

Det syntes inte som ett fel. Appen bootade, kartan fylldes med nålar, rösten
bara teg. Vakthunden hade inte fångat det heller, för ingenting var trasigt.

Tre åtgärder:

1. `supabase/kvalitetsfalt.sql` — sju nullbara kolumner på reports, med i
   reports_feed och med kolumnrättigheter. Kört skarpt, verifierat: alla sju
   läsbara, device_id fortfarande dolt.
2. `store.js` skickar fälten vidare — och skickar om utan dem vid 400, så att
   en klient som rullas ut före sin migrering inte gör det omöjligt att
   rapportera alls.
3. `harledKvalitet()` i app.js härleder `geokod:'gps'` ur `source:'app'` för
   rader som saknar fälten. Gamla rapporter finns kvar i timmar efter en
   migrering, och de ska inte tystas under tiden.

Lärdomen: när en modul börjar kräva ny data räcker det inte att fylla i den
där data skapas. Den måste följa hela vägen — skapas, sparas, hämtas, läsas.
Jag testade tre av fyra led.

## Testsvep — och det hittade ett regelhål direkt (08:00)

`test.html` kör mot samma moduler som appen och täcker det som faktiskt gör
ont: de två produktreglerna, kvalitetsfältens hela rundtur, vakthundens
tystnad, röstprioriteten och geometrin.

Första körningen: 16 av 19. Ett av felen var en **riktig produktregelsbrist**.

`"alkohol kontroll vid rondellen"` — isärskrivet — gick rakt igenom och blev en
vanlig kontroll på kartan för alla användare. Spärren mot nykterhetskontroller
letade bara efter det sammanskrivna ordet. Svenskan skrivs ihop, men folk
särskriver hela tiden, och röstigenkänning gör det nästan alltid. Regeln fanns
alltså men var mycket lättare att gå runt än den såg ut.

Lagat med förled + huvudord som separata ord: alkohol/nykterhets/promille/
rattfylleri/drog/utandnings + kontroll/test/prov/koll.

Två av de tre felen var buggar i testkoden själv — den väntade inte in
asynkrona tester och rapporterade "[object Promise]" som appfel. Ett testverktyg
som ljuger om appen är värre än inget testverktyg. Lagat.

Efter fix: **19 av 19**.

Rutinen framöver: kör test.html innan varje paketering.

## Kameradatan var felmärkt, inte gammal (08:45)

De "136 fartkamerorna för Västmanland" hämtades med en rektangel runt länet:
59.30,15.10 – 60.30,17.30. Två fel följde:

**Bara 40 av 136 låg i Västmanland.** Resten låg i Södermanland, Örebro,
Uppsala, Stockholm och Dalarna. Filen kallades ändå Västmanland.

**Rutan slutade vid longitud 17.30. Stockholm ligger på 18.07.** Förare på E18
österut fick alltså inga kameravarningar de sista fem milen — tyst, utan att
appen antydde att den slutat titta. Exakt den sortens fel jag byggde
vakthunden för, fast i datan istället för i koden.

Nu 2 466 kameror, hela Sverige, longitud 11,2–23,9. Ingen av de gamla
försvann; 2 330 tillkom. Kostnaden är +41 kB brotli per användare, mindre än
en kartbricka. `js/coverage.js` filtrerar ändå geometriskt, så en kamera i
Trelleborg når aldrig en förare i Västerås — bredare data ger inte fler
varningar, den tar bort en osynlig kant.

Ett namn hade ett gömt U+0085 efter ett Å, kvar sedan en tidigare
teckenkodningsmiss. Testsvepet har nu en kontroll för styrtecken.

**Attributionen var faktiskt fel.** Två ställen i index.html krediterade
Trafikverket. Datan kommer från OpenStreetMap under ODbL, och fel källa i en
licensuppgift är inte en detalj. Rättat på båda ställena.

`tools/fetch-cameras.ps1` var det som skapade problemet. Omdöpt till
`.ERSATT` med förklaringen överst — kördes den igen skrevs riksdatan över med
de felmärkta 136.

Testsvepet: **24 av 24**, inklusive fem nya kontroller för kameradatan.

## PlateVision kompilerar — och finns som app-fil (13:50)

Repot ligger publikt på github.com/elliot851/PlateVision. GitHub CLI installerad
och auktoriserad via engångskod, koden pushad, byggen körda på en macOS-runner.

**Första bygget: ett enda kompileringsfel på 4 931 rader.**

`DetectionViewModel.swift:81` — `call to main actor-isolated initializer 'init()'
in a synchronous nonisolated context`. Klassen och `CameraManager` är båda
`@MainActor`, men ett standardvärde i en parameterlista beräknas i ANROPARENS
kontext, inte i initialiserarens. `CameraManager()` som standardvärde räknades
därför som ett anrop utanför huvudaktören. Konstruktionen flyttad in i kroppen.

**Andra bygget: lyckat.** arm64, iOS 17.0, bundle-id `se.platevision.app`,
Xcode 16.4. Osignerad app-fil på 354 kB ligger som artefakt. 14 varningar, alla
om Sendable i AVFoundation-typer — inget som stoppar bygget.

Kostnad: 0 kr. Publikt repo ger obegränsade macOS-minuter.

Kvar för att få appen i telefonen: ladda ner artefakten och signera med
Sideloadly och ett gratis Apple-ID. Se PlateVision/BYGGA-UTAN-MAC.md.

## Prestandamätning — och en optimering jag INTE gjorde (14:10)

Tio nya moduler på en natt är värt att mäta innan man lägger till fler.

| | Kall start | Varm start |
|---|---|---|
| 36 moduler laddade | 1 449 ms | **136 ms** |
| DOM interaktiv | 1 318 ms | **47 ms** |
| Kartan målad | — | 328 ms |
| Minne | 8 MB | 10 MB |

Jag tänkte göra de icke-kritiska modulerna till dynamiska importer för att
korta startkedjan. Mätningen visade att det hade varit att lösa ett problem som
inte finns: service workern har ändå allt lokalt, och 136 ms är inte något en
förare märker. Optimeringen hade kostat komplexitet och risk utan vinst.

Största filen är `data/cameras.json` på 277 kB, men den är ~44 kB komprimerad
och hämtas en gång per version.

Roadmapen i appen uppdaterad med det som faktiskt byggts: vakthunden,
rapportkvaliteten, kartrotationen och värmevakten. **15 av 21 klara, 71 %.**
PlateVision lades medvetet INTE in — den är en egen app, och `anpr` står kvar
som "byggs inte" för Polisvakt.

Testsvepet: 24 av 24. v31 paketerad.

## PlateVision granskad mot Apples dokumentation (15:40)

Fyndet som räddade första testet: `recognitionLanguages = ["sv-SE", "en-US"]`.
**Svenska finns inte i Visions textigenkänning** — inte i någon revision. Apple
har själva bekräftat i sitt forum att WWDC-videon som påstod det var fel.

Att sätta ett språk modellen inte kan är inte harmlöst: Vision kan avvisa hela
begäran. I den här pipelinen hade varje bildruta då hamnat i en catch-gren som
bara loggar på notice-nivå. Symptomet på skärmen: appen hittar fordon, ritar
rutor, och läser aldrig en enda skylt. Ingen felruta, ingen ledtråd.

Fyra fel till, alla sådana som bara syns när man kör appen:
- Tryck-för-fokus fokuserade ~90° fel. `focusPointOfInterest` ligger alltid i
  osnurrat sensorkoordinatsystem, inte i Visions.
- Tryckpunkten kom från en GeometryReader innanför skyddsområdet medan
  förhandsvisningen ritas över hela skärmen — förskjuten med statusradens höjd.
- `minimumSize` 0.08 krävde en skylt ~400 px bred för att ens övervägas.
- Överbelastningsvarningen räknade normal drift och hade legat kvar på skärmen
  permanent från en halv sekund efter start.

Verifierat som KORREKT med källhänvisning: aspektkvotens konvention
(kortsida/långsida), att rotationen går till rätt anslutningar, att buffertarna
faktiskt roteras i hårdvara, och koordinattransformens matematik punkt för punkt.

Bygget är grönt. Ny IPA nedladdad — den tidigare hade läst noll skyltar.

## Klippet satt fast i telefonen (16:05)

Dashcamen hade en nedladdningsknapp. På iPhone gör den ingenting.

`<a download>` ignoreras av Safari på iOS för blob-länkar — videon öppnas i en
ny vy och användaren står kvar utan fil. Det spelar ingen roll i vardagen, men
allt i det ögonblick det betyder något: har du krockat och ska lämna filmen
till försäkringsbolaget eller polisen går den inte att få ut.

En dashcam vars inspelningar inte kan lämna telefonen är en dashcam som är
värdelös exakt när den behövs.

Nu används Web Share med en `File`, vilket öppnar systemets delningsmeny —
spara i Bilder, spara i Filer, maila, skicka. Det är så en app på iPhone lämnar
ifrån sig en fil. Nedladdningsknappen är kvar för dator och Android men döljs
där delning finns, så att den inte ser ut som vägen framåt där den inte leder
någonstans.

Testsvepet har nu en kontroll för det. 25 av 26, en hoppad (testdatorn saknar
delningsstöd — korrekt hoppad, inte ett fel).

## Två kameralägen, ett i taget (17:00)

Ägarens design: föraren väljer antingen inspelning eller skyltavläsning, aldrig
båda. Det är inte en smakfråga — bara en app åt gången kan hålla kameran, och
låter man båda se påslagna ut slutar det ena tyst att fungera.

**Polisvakt** fick en lägesväljare överst i dashcam-vyn. Väljer man
Bilingenkännaren stoppas inspelningen först, kameran släpps, och PlateVision
öppnas via `platevision://`.

**PlateVision** fick URL-schemat. Verifierat i den BYGGDA appens binära
Info.plist, inte bara i källkoden — `CFBundleURLSchemes` och `platevision`
finns där, tillsammans med kameratexten.

Att fråga iOS om en app är installerad går inte, och det är avsiktligt från
Apples sida. Vi försöker öppna och tittar om sidan doldes. Blev vi kvar efter
1,5 sekunder gissar vi att appen saknas — och texten säger "verkar inte vara
installerad", inte "är inte installerad". Ett tvärsäkert påstående blir fel så
fort systemet är långsamt, och då tror användaren att filen är trasig.

Verifierat i webbläsaren, hela kedjan: dashcamen spelade in, lägesbytet
stoppade den, dialogen öppnades, försöket att starta appen sa ifrån korrekt när
den saknades, och avbryt återgick till inspelningsläget.

Testsvepet: 29 av 30, en hoppad (testdatorn saknar delningsstöd).

## Mätning: kan webbläsaren läsa skyltar? (17:30)

Ägaren frågade varför skyltavläsningen inte kan vara en funktion i webbappen,
och påpekade att PWA:er installeras via "lägg till på hemskärmen". Han har rätt
i det senare — men hemskärmen ändrar hur appen startar, inte vad den kan.
Vision och Core ML är native-API:er.

Istället för att hävda det en fjärde gången mätte jag. `ocr-test.html` kör
Tesseract — den enda textigenkänning som går att köra i Safari på iPhone — mot
syntetiska svenska skyltar under förhållanden snällare än verkligheten.

**2 av 6 rätt.**

| Fall | Läste |
|---|---|
| Perfekt, stillastående | ABC123 ✓ |
| Nya serien | XKF42**8** — B blev 8 |
| Liten i bild (60 px) | ingenting |
| Svag vinkel 12° | ABC**A**23 |
| Lätt rörelseoskärpa | ABC123 ✓ |
| **Vinkel + oskärpa (körning)** | **"C"** |

Det sista fallet är verkligheten, och det gav en bokstav av sex.

**Jag hade fel om hastigheten.** Jag sa "sekunder per bildruta". Det blev 126 ms
i snitt. Hastigheten är alltså inte problemet — träffsäkerheten är. Och de här
bilderna är rena: ingen smuts, inget motljus, inget regn, inget mörker.

Slutsatsen står sig men av rätt skäl: det går att köra OCR i webbläsaren, det
går bara inte att lita på resultatet. En bilingenkännare som läser fel skylt är
sämre än ingen alls.
