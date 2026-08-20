# Skyltläsaren och personuppgifterna

Det här dokumentet beskriver exakt vad Polisvakts skyltläsare lagrar, var, i
vilken form, och vad den inte lagrar. Det är skrivet för att gå att visa för
någon som granskar, och sista avsnittet handlar med flit om det som *inte* är
löst.

Koden finns i `js/plate.js`. Mätningen som styrker påståendena finns i
`ocr-test.html` och körs mot exakt samma modul som appen använder.

## Kort version

| Sak | Var | Form |
| --- | --- | --- |
| Dina egna fordon | `localStorage["pv.fordon.v1"]` på telefonen | slumpat salt + saltade SHA-256-hashar |
| Etikett per fordon | samma nyckel | läsbar text du själv skrivit ("Volvon"), eller "Fordon 1" |
| Skyltar läsaren ser | ingenstans | kastas i samma bildrutecykel |
| Bildrutor från kameran | ingenstans | lämnar aldrig telefonen, sparas aldrig |
| Träfflogg, historik, inspelning | finns inte | — |

Ingenting av detta lämnar enheten. Skyltläsaren gör inga nätverksanrop alls
efter att textigenkänningsmotorn laddats ner första gången.

## Det som lagras

### En enda nyckel

All fordonsdata ligger under `localStorage["pv.fordon.v1"]`. Den ligger med
flit **utanför** appens `settings`-objekt (`localStorage["pv.settings.v1"]`).

Skälet är konkret: appen har en Supabase-backend, och inställningar är precis
den sorts objekt som förr eller senare synkas till ett konto. Ligger fordonen i
ett eget fack kan de aldrig råka följa med. Det är inte en teoretisk risk — den
gamla lagringen var `settings.plEgna`, med registreringsnumren i klartext, i det
objekt som är närmast att synka.

### Innehållet

```json
{
  "v": 1,
  "salt": "hDp2…44 tecken base64…",
  "raknare": 2,
  "fordon": [
    {
      "id": "3f342de432154bf8",
      "etikett": "Bilen",
      "skapad": 1755640000000,
      "hashar": ["9b29dc4e…64 hex…", "74b64fc7…64 hex…"]
    }
  ]
}
```

* **salt** — 32 slumpade byte från `crypto.getRandomValues`, genererade en gång
  per installation. Två telefoner får olika salt, så samma registreringsnummer
  ger olika hashar på olika enheter. Hasharna är därför inte en identifierare
  som går att slå upp mot någon annans installation.
* **hashar** — `SHA-256("polisvakt-fordon-v1|" + salt + "|" + NUMMER)`, hex.
  Första hashen i listan är numret självt, resten är förgenererade felläsningar
  (se nedan). Domänsträngen fram gör att hasharna inte kan jämföras mot en
  tabell som räknats fram över samma salt för något annat ändamål.
* **etikett** — läsbar, men det är din text, inte ett registreringsnummer.
  Skriver du inte något blir den "Fordon 1", "Fordon 2".
* **id** — 8 slumpade byte. Härleds inte ur numret, så det bär ingen
  information om fordonet.

Registreringsnumret finns som text i en lokal variabel medan du matar in det,
och är borta när inmatningsfunktionen returnerat. Det skrivs aldrig någonstans.

## Förgenererade OCR-varianter

Hashar går bara att jämföra exakt. Textigenkänning läser fel ibland. Det går
inte ihop, så gissandet flyttas till inmatningen: när numret matas in räknas
alla rimliga felläsningar fram och hashas de också.

Vilka tecken som förväxlas är inte gissat. `js/plate.js` har sedan tidigare två
tabeller, `TILL_BOKSTAV` och `TILL_SIFFRA`, som säger vilka tecken som ser
likadana ut i skyltfonten. Varianterna byggs ur dem, lästa åt båda hållen och
sammanslagna till visuella klasser: `0 O D Q` är en klass, `1 I L` en annan,
sedan paren `2 Z`, `4 A`, `5 S`, `6 G`, `7 T`, `8 B`.

Två saker begränsar hur många varianter det blir:

1. **Formatet.** Bara kombinationer som är giltiga svenska skyltar behålls. En
   etta i en siffrposition kan läsas som `L`, men `ABL23` är ingen skylt — och
   läsaren rättar redan sådana korsningar mellan bokstav och siffra innan de når
   uppslagningen. Att hasha dem vore att lagra strängar som aldrig kan dyka upp.
2. **Två bytta tecken.** Samma tak som läsarens egen rättning redan har, av
   samma skäl: en läsning som skiljer sig på tre tecken är inte en felläsning av
   ditt nummer, det är ett annat fordon.

Det som blir kvar är två verkliga fall: `O` mot `D` i bokstavspositionerna, och
sista positionen, som får vara både siffra och bokstav och därför inte går att
rätta på formatet.

Uppmätta utfall (`window.__ocr.integritet.varianter`):

| Nummer | Varianter |
| --- | --- |
| ABC 123 | 1 — `ABC123` |
| XKF 42B | 2 — `XKF42B`, `XKF428` |
| ODO 12D | 11 — värsta fallet, ett nummer nästan enbart av O och D |

**Priset ska sägas rakt ut: varje variant är ett riktigt registreringsnummer som
appen kommer att kalla ditt.** Kör den bilen förbi pipar appen och säger "ditt
fordon". Av knappt 38,9 miljoner giltiga svenska skyltar (23³ × 10² × 32) blir
som mest elva stycken dina, alltså i storleksordningen tre på tio miljoner. Det
är därför taket är två byten och inte fyra. Fler varianter hade fångat fler
felläsningar och samtidigt gjort funktionen mindre trovärdig.

Tabellerna täcker inte förväxlingar mellan två bokstäver som inte båda liknar
samma siffra — `M` mot `N` till exempel. Sådana läsningar missar helt enkelt.
Det som räddar dem är kravet att två bildrutor ska vara överens innan något
räknas.

## Det som inte lagras

### Ingen lista över lästa skyltar

Tidigare byggde läsaren en lista över allt den läst och visade den i
gränssnittet under "Lästa skyltar". Den listan är borta. Den var en logg över
främmande fordon, oavsett att den bara låg i minnet och tömdes när man lämnade
läget.

Så här går en läsning till nu:

1. En bildruta beskärs, förbehandlas och läses. Bildrutan återanvänds direkt och
   sparas aldrig.
2. Resultatet normaliseras till ett giltigt svenskt registreringsnummer, annars
   kastas det.
3. Numret hashas med enhetens salt.
4. **Rösträkningen sker på hashen, inte på numret.** Kravet att två bildrutor
   ska vara överens är kvar, men det enda som korsar en bildrutegräns är en
   saltad hash.
5. Är hashen ett av dina fordon skickas en händelse med numret, och appen pipar.
6. Är den inte det händer ingenting alls. Numret finns bara som ett argument i
   en funktion, och är borta när funktionen returnerat.

Statusraden sa förut "Ser ABC 123 — bekräftar…". Den skrev alltså främmande
registreringsnummer rakt in i gränssnittet. Den säger nu "Bekräftar skylt…".

### Ingen förteckning i minnet heller

Två samlingar behövs för rösträkningen, och båda gallras på tid:

* `senaste` — hashar från de senaste 6 sekunderna, för att kunna se att två
  läsningar är överens.
* `sedd` — hashar sedda de senaste 8 sekunderna, för att inte pipa två gånger
  för samma bil.

Poster äldre än så tas bort vid varje läsning, och båda töms när kameran
stoppas. Utan den gallringen hade `sedd` blivit en liggande förteckning över
varje fordon som passerat sedan appen startade — hashad, men ändå en
förteckning.

Den enda siffra som lever kvar under en session är `antalLasta`, ett heltal över
hur många skyltar som bekräftats. Det är en räknare, inte en logg: den innehåller
inga nummer, inga tider och inga hashar, och nollas när kameran stoppas.

## Migreringen av befintliga användare

Användare som redan har appen har sina nummer i klartext i
`settings.plEgna`. Vid start körs `migreraKlartext()`, som hashar in dem i det
nya registret. Därefter raderar appen `settings.plEgna`.

* **Idempotent.** Ett nummer som redan finns läggs inte till igen — uppslagningen
  sker på exakt samma hash. Funktionen får köras vid varje start.
* **Tappar inga fordon.** Klartexten raderas först när migreringen svarat
  `ok: true`. Vägrar lagringen skrivningen är den gamla listan det enda som är
  kvar av fordonen, och då lämnas den orörd.
* Rader som inte är svenska registreringsnummer rapporteras separat men
  blockerar inte — de hade ändå aldrig kunnat matcha något.

## Visningen, och vad den kostar

Här finns en verklig försämring, och den ska inte gömmas.

**Listan i inställningarna kan inte visa dig vilka registreringsnummer du lagt
in.** Den visar en etikett per fordon — din egen text, eller "Fordon 1" — och
antalet varianter. Det är allt som finns att visa, eftersom numret aldrig
lagrats.

Alternativet hade varit att spara en del av numret, till exempel de tre sista
tecknen, så att listan blir läsbar. Det valdes bort: det är klartext, det krymper
sökrymden till några tusen möjligheter, och det hade gjort påståendet "vi lagrar
inga registreringsnummer" till en halvsanning. Hellre en sämre lista än ett
påstående som inte håller.

Två saker finns istället:

* **Ta bort** fungerar på etikett och id, utan att numret behövs.
* **Prova ett nummer.** Skriv in ett registreringsnummer och få svar på om det
  ligger i registret. Uppslagningen är exakt densamma som läsaren gör, och den
  lagrar ingenting.

## Backup

Kravet är att datan hålls utanför iCloud- och Google-backup i den mån det går.
Den ärliga beskrivningen av "i den mån det går" är denna:

* **En webbsida kan inte märka lagring som "exkludera från backup".** Flaggan
  `NSURLIsExcludedFromBackupKey` på iOS finns inte tillgänglig för webbinnehåll,
  och Android har ingen motsvarighet en sida kan sätta. `localStorage` för en
  sparad webbapp följer med i en fullständig enhetsbackup, och det går inte att
  förhindra från appens sida. Att påstå något annat vore fel.
* **Det som följer med är oläsbart.** En backup innehåller ett slumptal och en
  rad hashar. Där finns inget registreringsnummer att läsa.
* **Kontosynk är en annan sak än enhetsbackup, och där gör vi något åt saken.**
  iCloud Safari och Chrome Sync synkar bokmärken, flikar och lösenord — inte
  `localStorage`. Och genom att fordonen ligger under en egen nyckel istället för
  i `settings` kan de inte följa med om appens inställningar någon gång börjar
  synkas till ett konto.
* Ingen fordonsdata rör IndexedDB, Cache Storage eller cookies, och ingenting
  skickas till en server.

## Det som återstår

* **En hashad lista hindrar inte att någon lägger in ett främmande fordon.**
  Vem som helst kan skriva in vilket registreringsnummer som helst och få appen
  att pipa när den bilen passerar. Tekniken kan inte skilja på "min bil" och
  "min grannes bil", och det här bytet ändrar inte det. Det är en begränsning i
  hela funktionen, inte i lagringen.
* **Hashningen är inte ett brute force-skydd.** Det finns knappt 39 miljoner
  giltiga svenska skyltar. Den som har telefonen, saltet och hasharna kan hasha
  alla och läsa ut numren på sekunder. En enkel SHA-256 är för snabb för att
  hindra det. Vad hashningen faktiskt gör: inget nummer går att *läsa* — inte i
  lagringen, inte i en backup, inte i en felrapport, inte om någon lånar
  telefonen, och inte av appen själv. Vill man ha ett verkligt brute
  force-skydd är vägen PBKDF2 med hög iterationsräkning i samma
  `crypto.subtle`, och priset är hundratals millisekunder per uppslagning —
  alltså per läst skylt, i en loop som redan går var 700:e millisekund.
* **Grupperingen läcker en liten smula.** Hasharna ligger grupperade per fordon,
  så antalet varianter syns. Ett fordon med elva hashar har nästan säkert ett
  nummer fullt av O och D. Det säger inte vilket nummer det är, men det är
  information som inte hade behövt finnas.
* **Etiketten är fritext och kontrolleras inte.** Skriver användaren sitt
  registreringsnummer som etikett ligger det i klartext. Gränssnittet bör inte
  föreslå det, och exempeltexten i fältet ska vara ett namn ("Volvon"), inte ett
  nummer.
* **Textigenkänningsmotorn hämtas från ett CDN** (`cdn.jsdelivr.net`) första
  gången läsaren startas. Det anropet avslöjar att någon startat skyltläsaren,
  men innehåller inga bilder och inga skyltar. Efter nedladdningen sker inga
  nätverksanrop alls.
