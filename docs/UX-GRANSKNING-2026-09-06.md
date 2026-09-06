# UX-granskning inför lansering, 6 september 2026

Appen kördes i Browser-panelen mot `python -m http.server 8082`, i iPhone-format
375x812 (devicePixelRatio 2, mörkt färgschema). Hela flödet gicks igenom som en ny
förare: ansvarsfriskrivning, hemskärmsguide, behörighetsvägg, karta, dashcam med
skyltläsare, chatt, butik och inställningar. Ingen kod ändrades.

Platstjänster, mikrofon och kamera är blockerade i panelen. Det är en
miljöbegränsning och räknas inte som fynd. Däremot är det värt att notera att en
nekad behörighet är ett fullt realistiskt läge på en riktig telefon, särskilt
notiser, och flera av fynden nedan gäller just det läget.

Alla mått nedan är avlästa ur DOM:en i 375x812-vyn, inte uppskattade ur en bild.

---

## Sammanfattning

Grunden är stark. Kontrasten håller genomgående, rapportknapparna och
flikraden sitter där tummen är, och inställningarna är bättre organiserade än de
flesta appar i den här storleken. Det som drar ner är tre saker som alla går att
åtgärda på timmar, inte dagar, och två av dem sitter i det som är nytt.

| # | Fynd | Allvar |
| --- | --- | --- |
| 1 | Toasten ligger ovanpå och blockerar rapportknapparna Kontroll och Civil | BLOCKERANDE |
| 2 | Textrutan i "Lägg till bil" är vit och ostylad | BLOCKERANDE |
| 3 | Behörighetsremsorna döljer överkanten på fyra av fem vyer | VIKTIGT |
| 4 | "+ Bil" och "Idag" är 29x19 px textlänkar | VIKTIGT |
| 5 | Listgreppet är 42x5 px och enda sättet att öppna listan | VIKTIGT |
| 6 | "+ Bil"-dialogen säger aldrig vad en tillagd bil gör | VIKTIGT |
| 7 | Bekräftelsen efter "Lägg till" hinner knappt synas och lämnar inget spår | VIKTIGT |
| 8 | "Skicka" i chatten är avstängd men ritas som aktiv | VIKTIGT |
| 9 | Chattvyn: 280 px tomrum och "logga in" utan inloggningsknapp | VIKTIGT |
| 10 | Krysset i "Slå på plats" ligger ovanpå statustexten | VIKTIGT |
| 11 | Etiketten "Kontroll" är bredare än sin knapp | VIKTIGT |
| 12-19 | Puts (se nedan) | PUTS |

---

## BLOCKERANDE

### 1. Toasten lägger sig ovanpå rapportknapparna och äter tryck

**Vad jag såg.** `.toast` är `position: fixed; z-index: 1200;
bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 18px)` och saknar
`pointer-events: none` (css/app.css rad 780). I 375x812 hamnar rutan på
x 93-280, y 637-732. Rapportknapparna ligger på:

| Knapp | Rektangel |
| --- | --- |
| Polis | 12, 662, 71x76 |
| Kontroll | 91, 662, 71x76 |
| Civil | 171, 662, 71x76 |

`document.elementFromPoint()` mitt i varje knapp medan en toast visas svarar
`DIV#toast.toast` för både Kontroll och Civil. Bara Polis är kvar.

Det värsta exemplet är självrefererande: trycker man för kort på Polis får man
toasten "Håll knappen intryckt en stund för att rapportera." i 2,6 sekunder, och
under den tiden går det inte att trycka på Kontroll eller Civil alls. Samma sak
händer vid varje annan toast i appen, till exempel mikrofonmeddelandet.

**Varför det är ett problem för en förare.** Det här är appens enda egentliga
handling. Man ser polisen i backspegeln, sträcker sig mot rätt knapp och trycket
tas emot av en informationsruta som just sagt att man ska trycka. Man vet inte
ens att det är den som är i vägen, eftersom den ser ut som text och inte som en
yta.

**Förslag.** `pointer-events: none` på `.toast`. Flytta den samtidigt över
åtgärdsraden, till exempel `bottom: calc(var(--bar-total) + 96px)`, så att den
inte skymmer knapparna visuellt heller.

---

### 2. Textrutan i "Lägg till bil" är vit och ostylad

**Vad jag såg.** `#bilModalFalt` har webbläsarens standardutseende:

| Egenskap | "+ Bil"-modalen | Samma funktion i Inställningar (`#plNyaFordon`) |
| --- | --- | --- |
| background | `rgb(255, 255, 255)` | `rgb(33, 45, 59)` |
| color | `rgb(0, 0, 0)` | `rgb(238, 244, 250)` |
| font-family | `monospace` (webbläsarens) | `ui-monospace, "SF Mono", Menlo` |
| border-radius | `0px` | `var(--radius-3)` |
| bredd | 190 px (`cols` default) | 100 % |

Det är den enda vita ytan i hela appen. Jag gick igenom samtliga sjutton
inmatningsfält i dokumentet: alla utom detta ligger på `rgb(33, 45, 59)` eller
`rgb(21, 30, 40)`.

Grundorsaken är att `css/app.css` bara har `input, select, textarea { font-size:
16px; }` som generell regel plus en egen regel för `#plNyaFordon`. `#bilModalFalt`
träffas av ingen av dem. Kommentaren på rad 613 i samma fil beskriver exakt den
här buggen när den fixades förra gången, på `#plProva`, med uppmätt kontrast
1,11:1.

**Varför det är ett problem för en förare.** Det är en app som ska användas i
mörker. En vit ruta som fyller en tredjedel av dialogen är ett blänk i
vindrutan och i ögat. Och den ser trasig ut, vilket är illa på en dialog som
just har lanserats.

**Förslag.** Ge `#bilModalFalt` samma regel som `#plNyaFordon`, inklusive
`width: 100%` och `box-sizing: border-box`. Enklast: lägg till selektorn i den
befintliga `#plNyaFordon`-regeln.

---

## VIKTIGT

### 3. Behörighetsremsorna döljer överkanten på fyra av fem vyer

**Vad jag såg.** Två fasta remsor ligger överst:

| Element | Rektangel | z-index |
| --- | --- | --- |
| `.pv-ps-remsa` ("Plats är blockerad") | y 0-73 | 890 |
| `.pv-up-rad` ("Polisvakt är inte färdiginställd") | y 74-147 | 889 |

`.view` är `position: fixed; top: 0; padding-top: 0`, så vyernas innehåll börjar
under dem. Uppmätt i Dashcam-vyn:

- `Kameraläge` (rubriken) ligger på y 14-43. Helt dold.
- `1. Välj vad kameran ska göra:` ligger på y 55. Helt dold.

Vyn scrollar bara nedåt, så innehållet går aldrig att få fram. På skärmen står
det alltså "2. Tryck här, så startar kameran" utan att det finns något steg 1.
Samma sak i Chatt (rubriken "Chatt" på y 14 plus förklaringsraden på y 59),
i Butik och i Inställningar (rubriken på y 90).

**Varför det är ett problem för en förare.** 147 px är 18 procent av skärmen.
Att en app visar steg 2 utan steg 1 läser man som en bugg, inte som en
behörighetspåminnelse. Och remsorna är inte ett kantfall: väldigt många säger
nej till notiser första gången, och då står den gula remsan kvar för alltid.

**Förslag.** Låt remsorna knuffa innehållet i stället för att lägga sig över det.
Sätt en CSS-variabel för remshöjden när de visas och lägg den som `padding-top`
på `.view`, eller flytta remsorna in i flödet ovanför vyerna.

---

### 4. "+ Bil" och "Idag" är 29x19 px textlänkar

**Vad jag såg.** Båda knapparna i listhuvudet:

| Knapp | Storlek | Klass | Utseende |
| --- | --- | --- | --- |
| `#btnDagen` "Idag" | 27x19 px | `sheet-count` | 13 px, blå `#3d9dff`, vikt 650, ingen bakgrund, ingen ram, `padding: 0` |
| `#btnSnabbBil` "+ Bil" | 29x19 px | `sheet-count` | samma |
| `#sheetCount` (räknaren, inte klickbar) | | `sheet-count` | 13 px, grå, vikt 400, `padding: 0` |

De ligger 10 px från varandra (Idag slutar på x 311, + Bil börjar på x 321).

Två saker på en gång: ytan är mindre än en femtedel av Apples minimum på 44x44,
och de delar klass med den räknare som inte går att trycka på. Enda skillnaden
mot något som inte är en knapp är färgen och fetstilen.

**Varför det är ett problem för en förare.** 19 px hög yta träffar man inte i en
bil i rörelse. Och när man missar hamnar man i grannknappen, som öppnar en helt
annan dialog. Att lägga in en bil att bevaka i stället för att titta på dagens
rapporter är ett förvirrande felsteg mitt under körning.

**Förslag.** Ge båda en egen klass med `min-height: 44px`, `padding: 12px 10px`,
`gap: 8px` mellan dem, och en svag ram eller platta så att de skiljer sig från
räknaren. Höjden kostar inget: listhuvudet har redan luft under sig.

---

### 5. Listgreppet är 42x5 px och det enda sättet att öppna listan

**Vad jag såg.** `#sheetGrip` är 42x5 px (`css/app.css` rad 426:
`width: 42px; height: 5px`, `padding: 1px 6px`). Enda hanteraren är
`js/app.js` rad 4315: `$('sheetGrip').onclick = () => $('sheet').classList.toggle('collapsed')`.

Jag provade att klicka på rubrikraden `.sheet-head` i stället. Klassnamnet
ändrades inte alls. Det finns ingen svep- eller draghanterare på panelen.

**Varför det är ett problem för en förare.** Fem pixlar hög. Det är ungefär en
millimeter på en riktig telefon. Att fälla ihop listan för att se kartan, eller
fälla ut den för att se rapporterna, är en av de vanligaste sakerna man vill
göra, och det finns exakt ett sätt att göra det på.

**Förslag.** Låt hela rubrikraden (`I NÄRHETEN` + räknaren) vara klickbar, och
ge greppet en osynlig träffyta på minst 44 px höjd via `padding` och
`background-clip: content-box`. Lägg gärna till svep upp/ner ovanpå det.

---

### 6. "+ Bil"-dialogen säger aldrig vad en tillagd bil gör

**Vad jag såg.** Dialogen `#modalBil` innehåller rubriken "Lägg till bil" och
texten "Skriv registreringsnummer, ett per rad. Du kan skriva en notering efter
numret, till exempel ABC 123 grå skåpbil." Ingenting mer.

Knappen som öppnar den har `aria-label="Lägg till en bil att bevaka"`, men den
texten syns aldrig, och ordet "bevaka" finns inte i dialogen.

I Inställningar står hela förklaringen: "Skriv registreringsnummer på bilar att
hålla koll på ... Känner läsaren igen en bevakad bil slår larmet till." Den
meningen är precis det som saknas i snabbdialogen.

**Varför det är ett problem för en förare.** Man trycker på "+ Bil" i kartvyn,
får en ruta som ber om ett registreringsnummer, och har ingen aning om vad appen
tänker göra med det. Att det bara fungerar när skyltläsaren är igång i
Dashcam-vyn är inte gissningsbart.

**Förslag.** Lägg till en rad i dialogen: "Känner skyltläsaren igen bilen slår
larmet till. Läsaren startar du under Dashcam." Ett par ord räcker, men kopplingen
till Dashcam måste finnas där, annars lägger folk in bilar som aldrig larmar.

---

### 7. Bekräftelsen hinner knappt synas och lämnar inget spår

**Vad jag såg.** Jag lade till "XYZ 789 Grå skåpbil" och läste av tillståndet
varje hundradels sekund:

| Tid efter tryck | Modalen | Kvittot |
| --- | --- | --- |
| 0-600 ms | öppen | "✓ 1 bil tillagd" |
| 1000 ms och framåt | stängd | (skrivet, men i en dold modal) |

Kvittot är `rgb(185, 199, 214)`, 15 px, grå text, och syns i ungefär 800
millisekunder innan modalen stänger sig själv. Ingen toast tar över.

Efteråt finns ingenting i kartvyn som visar att bilen finns. Listhuvudet står
kvar som "I NÄRHETEN / Idag / + Bil". Ingen räknare, ingen lista, inget sätt att
ta bort. Bilarna sparades korrekt (jag hittade dem i `pv.fordon.v1` och
`pv.fordon.visning.v1`), men för att se dem måste man till
Inställningar, Bilen och utrustningen, Skyltläsare, Bevakade bilar.

**Varför det är ett problem för en förare.** Man ser en grå text i åttondels
sekunder och sedan är rutan borta. Tvivlar man på om det gick igenom finns inget
sätt att kontrollera det från den vy man står i. Många kommer att lägga in samma
bil två gånger.

**Förslag.** Låt kvittot ligga kvar som en toast efter att modalen stängt,
alternativt fördröj stängningen till 1,8 s. Och visa antalet på knappen:
"+ Bil (2)". Då blir bekräftelsen permanent och man ser att listan finns.

---

### 8. "Skicka" i chatten är avstängd men ritas som fullt aktiv

**Vad jag såg.** I Chatt utan inloggning:

- `#chattText` har `disabled = true`
- Skicka-knappen har `disabled = true`, men `opacity: 1` och
  `background-color: rgb(61, 157, 255)`, alltså exakt samma blå som varje aktiv
  primärknapp i appen.

Jämför med "Kom igång" i ansvarsfriskrivningen, som tydligt tonas ner medan
kryssrutan är otryckt. Mönstret finns alltså, det är bara inte använt här.

**Varför det är ett problem för en förare.** Man trycker på en knapp som ser
helt normal ut och ingenting händer. Det är samma symptom som en trasig app.

**Förslag.** Använd samma avstängda utseende som `#discAccept`, till exempel
`button[disabled] { opacity: .45; filter: saturate(.5); }` globalt.

---

### 9. Chattvyn: 280 px tomrum och "logga in" utan inloggningsknapp

**Vad jag såg.** Från rubriken (som ligger dold bakom remsorna, se fynd 3) till
texten längst ner är ungefär 280 CSS-pixlar helt tom svart yta. Först nästan
längst ner står "Chatten är bara för inloggade. Logga in så ser du vad andra
förare skriver i din trakt." i grå text, och under den en gul ruta "Logga in för
att skriva i chatten."

Jag räknade knapparna i vyn: det finns exakt en, och den heter "Skicka".
Ingen inloggningsknapp, ingen länk, ingen vägvisning till Inställningar.

**Varför det är ett problem.** Vyn ber om något och erbjuder inget sätt att göra
det. Man får leta sig till Inställningar, Konto, poäng och historik, Logga in
eller skapa konto. Under körning gör ingen det.

**Förslag.** Centrera budskapet i tomrummet och lägg en primärknapp
"Logga in eller skapa konto" direkt under, som öppnar samma dialog som i
inställningarna.

---

### 10. Krysset i "Slå på plats" ligger ovanpå statustexten

**Vad jag såg.** I `#uppstart`:

| Element | Rektangel |
| --- | --- |
| `.pv-up-stang` (krysset) | x 312-348, y 29-65 |
| Första `.pv-up-sluttext` ("Nekat") | x 300-333, y 45-62 |

Överlappet är 21 x 17 px. På skärmen läses det som "Nekat✕" ihopskrivet.
Krysset är dessutom 36x36 px, alltså under 44.

**Varför det är ett problem.** Det är den vy man möter varje gång man startat
appen efter att ha nekat plats, alltså vanligare än man tror. Det ser slarvigt
ut, och man riskerar att stänga rutan när man tänkte läsa statusen.

**Förslag.** Flytta ner statusraderna eller lägg krysset i en egen rad ovanför
dem, och sätt det till 44x44.

---

### 11. Etiketten "Kontroll" är bredare än sin knapp

**Vad jag såg.**

| Knapp | Knappens bredd | Etikettens bredd | Etikettens x |
| --- | --- | --- | --- |
| Polis | 71 px (x 12-84) | 44 px | 26-70 |
| Kontroll | 71 px (x 91-162) | **75 px** | **90-165** |
| Civil | 71 px (x 171-242) | 40 px | 188-228 |

Texten är 21 px och `overflow: visible`, så den rinner ut över kanten på båda
sidor och in i mellanrummet mot grannknapparna. På skärmbilden ser "Kontroll"
avklippt ut mot "Civil".

**Varför det är ett problem.** Det är en av tre knappar som ska gå att träffa med
en blick, och den ser trasig ut. Vid större systemtext (många förare kör med
förstorad text) blir det värre.

**Förslag.** Antingen kortare etikett ("Kontr." fungerar inte, men "Trafik" eller
"Kontroll" på två rader gör det), eller `font-size: clamp(16px, 5vw, 21px)` på
`.act span`, eller lite mindre `gap` så knapparna blir bredare.

---

## PUTS

12. **Versionsetiketten ligger ovanpå Karta-fliken.** `v135` ritas på x 4, y 754,
    19x9 px, `position: absolute`, opacitet 0,45, uppmätt kontrast 2,41:1.
    Karta-fliken upptar x 0-68, y 751-812. Flytta den till Inställningar,
    versionen står redan där.

13. **Två steg numrerade "1." i Dashcam.** Med Skyltläsare vald finns
    "1. Välj vad kameran ska göra:" (y 55) och "1. Hur ska den zooma in på
    skylten?" (y 256), följt av "2. Tryck här, så startar kameran:" (y 480).
    Numrera om till 1, 2, 3.

14. **Escape stänger inga modaler.** Testat på `#modalBil` och `#modalDagen`:
    klick utanför fungerar, Avbryt fungerar, Escape gör ingenting. Låg vikt på
    iPhone, men gratis att lägga till.

15. **Cirkulär text i mikrofontoasten.** Tryck på "Tala" med mikrofonen avstängd
    ger "Mikrofonen är avstängd. Tryck på Tala för att slå på den." Man tryckte
    just på Tala. Skriv om till vad som faktiskt behöver hända.

16. **"Klart" hamnar utanför skärmen i hemskärmsguiden.** Med iPhone valt är
    kortets höjd 884 px och knappen ligger på y 826-875 i en 812 px hög vy.
    Dialogen går att scrolla, så man kommer åt den, men på den enda telefonen
    guiden riktar sig till syns primärhandlingen inte. Sänk marginalerna eller
    lås knappraden längst ner i kortet.

17. **Version mot byggdatum går isär.** Kortet visar "Version 2026-09-06-135" och
    raden under "Du har senaste versionen. Byggd 19 augusti kl. 18:20."

18. **Utgångna rader i Idag ligger under AA.** Raden med "Borttagen" har
    `opacity: 0.62`, vilket ger 3,37:1 för texten och 3,13:1 för tidsstämpeln vid
    14-15 px. Kravet är 4,5. Höj till 0,75 så syns det fortfarande att raden är
    passé.

19. **Små träffytor utan direkt konsekvens.** Leaflets zoomknappar 30x30, chipsen
    GPS/Röst/Delat 33 px höga, remsornas knappar ("Så slår du på" 108x38,
    "Slå på" 66x38). Ingen av dem används under körning, men 38 till 44 är en
    billig ändring.

20. **Felmeddelandet börjar med en naken siffra.** Skriver man skräp får man
    `1 gick inte att läsa: "hej hopp"`. Skriv "Kunde inte läsa: hej hopp".

21. **Butiken har inget som går att köpa.** Båda produkterna är märkta
    "SNART I LAGER" med knappen "Meddela mig". Fungerar tekniskt, men fliken
    säljer ingenting på lanseringsdagen.

---

## Svar på de sju frågorna

**1. Första intrycket.** Nej, inte på tio sekunder. Det första man möter är sju
varningar under rubriken "Innan du börjar", ungefär 2,5 skärmar text, en kryssruta
och en avstängd knapp. Sedan hemskärmsguiden, sedan behörighetsdialogen. Tre
väggar innan kartan. Texterna i sig är utmärkta, ärliga och välskrivna, men
ingenstans står det vad appen ger en. Man får veta vad den inte gör innan man vet
vad den gör. Överväg en rad överst i friskrivningen som säger vad man får:
röstvarningar för polis och fartkameror på vägen framför dig.

Kryssrutan och knappen är däremot rätt gjorda: hela etiketten är 293x71 px och
"Kom igång" är avstängd tills man kryssat.

**2. Tumzonen.** Bra där det räknas, dåligt i listhuvudet.

| Element | Storlek | Omdöme |
| --- | --- | --- |
| Polis / Kontroll / Civil | 71x76 | Bra |
| TALA | 111x76 | Bra |
| Flikraden | 61-68 px hög | Bra |
| Sökfält i inställningar | 48 px hög | Bra |
| Grupprubriker i inställningar | 73 px höga | Bra |
| "Idag" / "+ Bil" | 27x19 / 29x19 | Underkänt |
| Listgreppet | 42x5 | Underkänt |
| Kryss i "Slå på plats" | 36x36 | Underkänt |
| Zoom, chips, remsknappar | 30-38 px | Under gränsen |

Allt viktigt sitter i nedre tredjedelen. Rapportraden ligger på y 662-738 och
flikraden på y 751-812, alltså i de nedersta 19 procenten av skärmen. Det är rätt.

**3. Läsbarhet i bil.** Genomgående mycket bra, och det ska sägas rakt ut. Jag
mätte kontrasten för varje textbärande element i hela dokumentet, med
ärvd opacitet inräknad, mot faktisk bakgrundsfärg. Endast fyra föll under AA, och
tre av dem är avsiktligt nedtonade (versionsetiketten och de två utgångna raderna
i Idag). Det fjärde var ett falskt utslag: TALA-knappens bakgrund är en
`linear-gradient` som min mätning inte fångade, faktisk kontrast är cirka 6,8:1.

Inget grått på grått. Brödtexten ligger på `rgb(185, 199, 214)` mot
`rgb(13, 18, 25)`, alltså 9,78:1. Varningsgult ligger på 9,2:1. Det enda som
faktiskt bryter mörkret är den vita textrutan i fynd 2.

**4. Vyerna.** Man hittar tillbaka överallt, flikraden är alltid synlig och
fliken man står på är markerad i blått. Ingenstans fastnade jag. Anmärkningarna
per vy:

- **Karta.** Fungerar. Håll-in-för-att-rapportera är ett bra val, se nedan.
  Tumzonen och toasten är problemen.
- **Dashcam.** Steg 1 är dolt bakom remsorna. Lägesväxlingen mellan Spela in och
  Skyltläsare fungerar rent, och beskrivningarna är bland det bästa i appen.
- **Skyltläsare.** Automatisk/Manuell är en tydlig segmenterad kontroll med bra
  knappstorlek. Numreringen börjar om på 1.
- **Chatt.** Tomt och utan väg vidare, se fynd 8 och 9.
- **Butik.** Fungerar. Produktkort, priser och "Meddela mig" är rena och stora.
  Inget att köpa.
- **Inställningar.** Se punkt 6.

**5. Nya funktionerna.** "+ Bil" fungerar tekniskt utmärkt men är svår att träffa
(fynd 4), förklarar inte sig själv (fynd 6), har en vit textruta (fynd 2) och en
bekräftelse som försvinner (fynd 7).

Avbryt fungerar. Klick utanför stänger. Escape gör det inte. Fältet får fokus
automatiskt när dialogen öppnas, vilket är rätt.

Felhanteringen förtjänar beröm och ska inte röras:

| Inmatning | Svar | Modalen |
| --- | --- | --- |
| Dubblett | "1 fanns redan" | Stannar öppen |
| "hej hopp" | `1 gick inte att läsa: "hej hopp"` | Stannar öppen |
| Tomt | "Skriv ett registreringsnummer först, till exempel ABC 123." | Stannar öppen |
| Giltigt | "✓ 1 bil tillagd" | Stänger efter 800 ms |

Tre skilda, begripliga svar på tre skilda fel, och dialogen stänger sig aldrig
med ett fel oläst. Att numren dessutom sparas som saltade hashar och bara
speglas lokalt för visning är genomtänkt.

**6. Inställningarna.** Grupperingen finns redan och den fungerar. Sju hopfällda
grupper med underrubriker, alla 73 px höga, plus "Öppna allt". Ovanför dem ett
sökfält på 48 px med platshållaren "Sök inställning, t.ex. regnr". Jag skrev
"regnr": alla grupper utom "Bilen och utrustningen" försvann, den fällde ut sig
själv, och det stod "1 träff." med ett kryss för att rensa. Det är bättre än de
flesta appar i den här storleken löser det. Ingen ytterligare gruppering behövs.

Det enda som stör är att rubriken "Inställningar" ligger dold bakom remsorna
(fynd 3).

**7. Tomma tillstånd.** Kartans tomma text är "Inga rapporter i närheten just
nu.", 15 px, kontrast 10,92:1. Formuleringen är neutral och läses inte som
trasig, men den bekräftar heller inte att appen faktiskt bevakar. Med
platstjänster av står det i stället "Väntar på GPS…" hur länge som helst, och där
kan man inte se skillnad på "lugnt" och "inte igång".

Förslag: skriv ut vad som bevakas, till exempel "Inget rapporterat i närheten.
Polisvakt bevakar 30 km runt dig." Radien finns redan i inställningen strax
ovanför, så siffran är gratis att fylla i, och meningen svarar på båda frågorna
samtidigt. Ge "Väntar på GPS…" en tidsgräns: står den kvar efter tio sekunder
byt till en rad som säger varför.

Idag-dialogen är ett bra tomt-tillstånd i motsatt riktning: den visade
"3 rapporter sedan midnatt. 2 räknas fortfarande som aktuella, 1 har passerat sin
tid." Det är precis den sortens mening kartan saknar.

---

## Det som är bra och inte ska röras

- **Kontrasten.** Hela dokumentet genomsökt, fyra avvikelser varav tre avsiktliga.
- **Håll-in-för-att-rapportera.** 600 ms hållning, fyllnadsanimation, vibration
  när den går igenom, ångra-knapp i sex sekunder, och en toast som förklarar när
  man tryckt för kort. Genomtänkt hela vägen. Det enda felet är att toasten
  ligger i vägen (fynd 1).
- **Karttemat.** Automatiskt, Mörkt och Ljust. Jag växlade till Mörkt och
  bekräftade att brickorna byts till Esris `World_Dark_Gray_Base`. Standardläget
  Automatiskt låg på dag när jag testade, vilket är rätt beteende.
- **Sökfältet i inställningarna.**
- **Rapportknapparnas och flikradens storlek och placering.**
- **Texterna.** Friskrivningen, förklaringarna i Dashcam och integritetstexten
  under Bevakade bilar är skrivna av någon som förstår vad de handlar om.
  De ska inte kortas.

---

## Vad jag skulle göra före lansering idag

Fyra ändringar, alla små:

1. `pointer-events: none` på `.toast` och flytta den ovanför åtgärdsraden.
2. Lägg `#bilModalFalt` i `#plNyaFordon`-regeln.
3. Ge `#btnDagen` och `#btnSnabbBil` 44 px höjd och lite mellanrum.
4. Låt remsorna knuffa `.view` i stället för att lägga sig över den.

Resten kan vänta till första uppdateringen efter lansering.
