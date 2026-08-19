# Rösten i Polisvakt — hur mikrofonknappen fungerar och vad den förstår

Den här filen beskriver `js/voice.js`: strömbrytaren, vilka meningar som går
fram, vad appen vägrar rapportera, och var taligenkänningen faktiskt går
sönder i en bil i 100 km/h. Läs **avsnitt 5** innan du lovar någon att rösten
är det snabbaste sättet att rapportera. Det stämmer ibland, och inte alltid.

---

## 1. Knappen är en strömbrytare

**Ett tryck startar. Ett tryck stoppar. Ingenting annat stänger mikrofonen.**

Föraren ska kunna trycka på knappen, titta upp på vägen, fundera i tre
sekunder och sedan säga sin mening. Det låter självklart, men det är precis
vad webbläsarens taligenkänning inte klarar av på egen hand.

```
Tryck 1                                                        Tryck 2
   │                                                              │
   ▼                                                              ▼
 lyssnar ─── paus i talet ──▶ webbläsaren stänger ──▶ vi startar om ─── klart
                              (onend/no-speech)        texten ligger kvar
```

`SpeechRecognition` avslutar sessionen på eget bevåg: vid en paus i talet, vid
tystnad, ibland via ett `onend` utan orsak, och på vissa telefoner efter en
fast tid oavsett vad som händer. Varje sådan avslutning startar `Listener` om
igenkänningen och **behåller det som redan hörts**. En mening som delas mitt
itu av en omstart blir alltså ett enda yttrande:

| Session | Hörs                | Samlad text                      |
|---------|---------------------|----------------------------------|
| 1       | "det står"          | det står                         |
| 2       | "en civil bil"      | det står en civil bil            |
| 3       | "vid Eriks lund"    | det står en civilbil vid erikslund |

När föraren trycker av tolkas hela raden som en mening.

### Tillstånd som gränssnittet kan rita

`Listener` rör aldrig DOM. Den håller två egenskaper och skickar händelser:

| `state`      | Betyder                                                 |
|--------------|---------------------------------------------------------|
| `idle`       | Mikrofonknappen är av                                    |
| `listening`  | Lyssnar. `detail.interim` är det som hörs just nu        |
| `processing` | Föraren har tryckt av, sista ordet hämtas hem            |
| `error`      | Något gick fel. `errorMessage` är förklaringen på svenska |

| Händelse    | När                                                        |
|-------------|------------------------------------------------------------|
| `state`     | Varje gång tillståndet eller interimtexten ändras           |
| `heard`     | Något hördes (interim eller slutligt) — för knappens text   |
| `command`   | Ett färdigt yttrande, städat och redo för parsern           |
| `timeout`   | Sessionen tog slut utan yttrande (tyst, avbrott eller fel)  |
| `denied`    | Mikrofonen nekades                                          |
| `error`     | Hårt fel med `error` och ett svenskt `message`              |
| `wake`      | Väckningsordet hördes                                       |
| `stopped`   | Avbruten av föraren, ingenting tolkas                       |

### Fel behandlas olika, för de betyder olika saker

Att svara likadant på alla fel ger antingen en mikrofon som dör tyst eller en
omstartsloop som aldrig ger upp. Därför:

| Fel                  | Vad appen gör                                                   |
|----------------------|------------------------------------------------------------------|
| `no-speech`          | Ingenting. Föraren tänker. Vi startar om och behåller texten.     |
| `aborted`            | Vi själva, eller ett inkommande samtal. Tillbaka när det går.     |
| `audio-capture`      | Två nya försök (headset kopplas i och ur), sedan besked.          |
| `network`            | Backar av i 0,6–2,4 s. Täckning kommer och går längs vägen.       |
| `not-allowed`        | **Slår av knappen** och säger varför. Fler försök ger samma nej.  |
| Döda sessioner i rad | Sex sessioner som dör direkt = något är fel. Slutar snurra.       |

Det sista är viktigt: utan den spärren blir "starta om när den slutar" en
evighetsloop som äter batteri utan att någonsin höra ett ord.

### Väckningsordet är undantaget

Säger man "hej vakt" finns ingen knapp att trycka av med. Där, och bara där,
avslutas yttrandet av tystnad (2,8 s) med ett tak på 14 sekunder. Slås
väckningsordet på i inställningarna ligger mikrofonen och lyssnar i bakgrunden
och går tillbaka dit efter varje kommando.

---

## 2. Meningar som fungerar

Prata som du pratar. Appen är byggd för hela meningar, inte sökord.

```
Polis står vid rondellen på Norrleden
Det står en civil polisbil vid infarten till köpcentret
Trafikkontroll på riksväg 66 strax norr om avfarten
Polisen står på bron precis innan avfarten
Civil bil vid busshållplatsen på Bergslagsvägen
Poliskontroll i rondellen vid järnvägsstationen
Polis vid Dillos
Snuten står vid Erikslund
```

**Faran är över** — säg det med samma ord som du använder i verkligheten:

```
Polisen är borta från Hammarby
De har åkt från Norrleden
Fritt vid Erikslund nu
```

**Systemkommandon** går före allt annat:

```
Tyst          → inga varningar på 15 minuter (akuta hörs ändå)
Ljud på       → tillbaka
```

### Vad som händer med texten innan parsern får den

Taligenkänningen levererar text utan skiljetecken, med siffror ibland som ord
och ibland som siffror, och med sammansättningar särskrivna. Parsern jämför
ord mot ord. Röstlagret putsar därför texten först — och bara texten:

| Hörs                          | Blir                        |
|-------------------------------|-----------------------------|
| "Polis, vid Dill os!"         | `polis vid dillos`          |
| "trafik kontroll"             | `trafikkontroll`            |
| "riksväg sextiosex"           | `riksväg 66`                |
| "E arton västerut"            | `e18 västerut`              |
| "sextiosexan"                 | `66an`                      |
| "Bäck by"                     | `bäckby`                    |
| "polis vid polis vid Hammarby"| `polis vid hammarby`        |
| "öh polis vid Vallby"         | `polis vid vallby`          |

Ortnamnen kommer från `data/aliases.vasteras.json` — samma fil som geokodningen
använder, plus de platser föraren själv lärt appen genom att peka på kartan.
Lägg alltså in en ny ort på ett enda ställe, så förstår både rösten och kartan
den. Ett ord som står direkt efter "vid", "på" eller "mot" och nästan stavas
som ett känt ortnamn rättas dit ("pilgatn" → "pilgatan"). Bara där — annars
skulle "polis" kunna rättas till något helt annat och en varning byta innebörd.

### Flera gissningar, inte bara den första

Igenkänningen lämnar upp till fem gissningar per mening. Den översta är ofta
"kollis vid dillos" medan den tredje är "polis vid dillos" — samma ljud, men
bara den ena betyder något. Går den översta inte att tolka provas de övriga,
och den som faktiskt blir en rapport lämnas över.

Två spärrar sitter runt det:

* Går den översta gissningen att tolka används den. Ett lågt alternativ kan
  aldrig ändra en mening som redan gick fram.
* Ett yttrande på ett eller två ord ("tyst") jagar aldrig alternativ. Annars
  skulle ett systemkommando kunna bli en polisrapport för att någon gissning
  råkade låta som "polis".

---

## 3. Två saker rapporteras aldrig

Filtret sitter i `js/parser.js` och gäller allt på en gång: rösten, knapparna
och det som kommer in från Facebook-gruppen. Röstlagret har ingen egen
tolkning och kan därför inte gå runt det. Det kan bara skicka in text.

**Nykterhets- och drogkontroller.** Att varna för en fartkamera hjälper någon
att hålla hastigheten. Att varna för en nykterhetskontroll hjälper någon att
köra vidare full. Det är inte samma sak, och en app som gör det andra
förtjänar inte att finnas. Appen svarar rakt ut att den inte gör det.

**Fartkameror.** De står still, de finns redan i appen med rätt koordinat och
mätriktning, och en handmarkerad kamera hamnar nästan alltid några hundra
meter fel — vilket är sämre än ingen markering alls.

Att vägran inte går att prata sig förbi är genomtänkt hela vägen:

* Särskrivningar sätts ihop **innan** parsern får texten. "Alkohol kontroll"
  innehåller varken "alkoholkontroll" eller något annat ord i filtret och
  skulle annars glida igenom som en vanlig kontroll. Det är alltså städningen
  som gör att filtret håller även när mikrofonen hör isär orden.
* När appen letar bland alternativa gissningar vinner en vägran över allt
  annat. Låter någon gissning som en nykterhetskontroll blir svaret nej — den
  omtolkas aldrig till något som går att rapportera.
* Vägrar parsern den översta gissningen letar appen inte vidare efter en
  formulering som skulle ha gått igenom.

---

## 4. Appen och mikrofonen pratar inte samtidigt

Telefonens högtalare sitter en decimeter från dess mikrofon. Läser appen upp
"Polis vid Dillos" med mikrofonen öppen hör den sig själv, tolkar det som en
ny rapport, och rapporterar samma polis igen. Och igen.

Tre lager hindrar det:

1. Uppläsningen stänger mikrofonen medan den pratar, och öppnar den igen
   efteråt. Kopplingen sitter inne i `voice.js`, så den finns kvar oavsett hur
   gränssnittet råkar vara ihopkopplat.
2. En halv sekunds ekosvans efter sista ordet — högtalaren är inte tyst i
   samma ögonblick som webbläsaren säger att den är klar.
3. Skulle något ändå slinka in jämförs det med vad appen nyss sade. Bara långa,
   nästan ordagranna kopior kastas. Säger föraren "polis vid Skiljebo" strax
   efter att appen sagt "varning, polis vid Hammarby" delar meningarna två av
   tre ord — den rapporten ska aldrig kastas.

`speechSynthesis` i Chrome hänger sig ibland utan att säga att den är klar.
Därför öppnas mikrofonen igen efter 30 sekunder oavsett vad uppläsningen
påstår. Annars skulle den ligga avstängd resten av resan.

---

## 5. Vad taligenkänning inte klarar i en bil

Det här är begränsningar i tekniken, inte buggar att fixa. Bygg gränssnittet
med dem i åtanke, och lova aldrig att rösten alltid fungerar.

**Vägbuller.** I 100 km/h ligger ljudnivån i en vanlig personbil runt 70 dB,
mer med vinterdäck på grov asfalt eller med fönstret nere. Igenkänningen är
tränad på tal i tystnad. Korta ord ("borta", "här") försvinner först, och
ortnamn blir gissningar. Hela meningar klarar sig bättre än stickord, just
därför — det finns mer sammanhang att gissa utifrån. Så är exemplen i appen
skrivna med flit.

**Musik och passagerare.** Mikrofonen hör allt. Spelar radion, eller pratar
någon i baksätet, blandas det in i transkriptet. Appen dämpar musiken när den
själv pratar, men den kan inte dämpa musiken som mikrofonen hör.

**Chrome skickar ljudet till en server.** Utan täckning finns ingen
igenkänning alls. Längs riksväg 66 norr om Skultuna och i tunnlar går
`network`-fel igen. Appen backar av och försöker igen, men mellan försöken
hörs ingenting. Knapparna på kartan fungerar överallt — rösten gör det inte.

**iPhone har ingen `SpeechRecognition` i Safari.** Det går inte att koda sig
runt. Där visar appen "Ingen röst" och föraren får använda knapparna. Testar
du röstflödet måste du göra det i Chrome på Android.

**Bluetooth-handsfree sänker ljudkvaliteten.** Kopplar telefonen om till
bilens mikrofon via handsfree-profilen halveras bandbredden. Det märks direkt
på ortnamn. En mikrofon i telefonen, eller ett headset med bra profil, ger
märkbart bättre resultat än bilens inbyggda.

**Skärmsläckning och bakgrund.** Läggs appen i bakgrunden, eller släcks
skärmen, stryper telefonen mikrofonen. Appen håller skärmen vaken när den
inställningen är på, men växlar föraren till en karta i en annan app tystnar
igenkänningen. Kommer den tillbaka startar `Listener` om av sig själv.

**Ortnamn är det svåraste.** Aliaslistan täcker det som sägs ofta i Västerås.
Hittar appen ändå inte platsen frågar den en gång, föraren pekar på kartan när
bilen står still, och då sitter platsen för alltid — även för rösten, eftersom
inlärda platser också används när transkriptet städas.

---

## 6. Att ändra något här

* Ny ort eller nytt smeknamn: `data/aliases.vasteras.json`. Rösten läser samma
  fil, så du behöver inte röra `voice.js`.
* Nytt ord för polis, kontroll eller "borta": ordlistorna i `js/parser.js`.
* Ord som mikrofonen envist hör fel: `MISHEARD_WORD` och `MISHEARD_PHRASES` i
  `js/voice.js`.
* Sammansättningar som särskrivs: `JOINABLE` i `js/voice.js`. Gäller det
  nykterhet är det en säkerhetsfråga, inte kosmetik — se avsnitt 3.
* Vad appen vägrar: `js/parser.js`, och ingen annanstans. Bygg aldrig en egen
  tolkning i röstlagret. Det finns exakt en tolkningsmotor, och den ska
  fortsätta vara en.
