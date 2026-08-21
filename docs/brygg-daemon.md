# Facebook-bryggan som daemon

`tools/brygg-daemon.ps1` är det som får inlägg ur gruppen **Här Står Polisen -
Västerås** (`317968668373072`) att bli polisvarningar i Polisvakt.

Bryggkoden fanns sedan tidigare, mätt mot den riktiga gruppsidan och täckt av
testsvepet i `fb-bryggan-test.html`. Det som saknades var aldrig koden — det
var ett sätt att få in den i sidan. Den här filen är det sättet.

## Det viktigaste först

**Varför har inget nått appen?** Två skäl, båda mätta, inget av dem en bugg:

1. **Koden kom aldrig in i sidan.** Tampermonkey, `--load-extension`,
   handinläst tillägg och hämtning över nätet är alla stängda vägar (se
   tabellen längre ned). Felsökningsporten är den som fungerar, och det är
   den daemonen använder. Det här är löst nu.
2. **Daemonen måste ligga på när inlägget skrivs.** Facebook ritar
   tidsstämpeln som en SVG-sprite på klientrenderade inlägg — alltså på just
   de nya. Där finns ingen ålder att läsa. Bryggan tidsbestämmer i stället på
   sin egen första observation, och den kan den bara göra för inlägg som dyker
   upp **medan den tittar**. Startas den efter att inlägget lagts upp är
   åldern okänd, och då skickas ingenting. Hellre tyst än fel.

**Vad betyder det i praktiken?** Bryggfönstret och daemonen ska stå på
dygnet runt. Ett inlägg upptäcks då inom ett svep — **uppmätt 19,7 sekunder**.
Startas de klockan nio hittar de ingenting som skrevs klockan åtta.

**Vad krävs för att en varning ska nå appen?** `-Skarpt`. Utan den flaggan
loggar daemonen vad den *hade* skickat och skriver ingenting. Läs loggen
först, sätt flaggan sedan.

---

## Kör

```powershell
# 1. Fönstret: eget Chrome, egen profil, gruppen öppen, felsökningsporten på.
powershell -ExecutionPolicy Bypass -File tools\starta-bryggan.ps1

# 2. Läsningen. Torrkörning — skriver ingenting någonstans.
powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1
```

Eller båda på en gång:

```powershell
powershell -ExecutionPolicy Bypass -File tools\starta-bryggan.ps1 -Daemon
```

Skarpt läge, alltså skriv till databasen, kräver ett uttryckligt argument:

```powershell
powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1 -Skarpt
```

Nyttiga varianter:

| Argument | Betyder |
|---|---|
| `-Sjalvtest` | kör provet på produktregeln och avslutar. Rör inte Chrome. |
| `-Svep 1` | gör exakt ett svep och avslutar. Bra för att titta. |
| `-MinuterAttKora 55` | kör i 55 minuter och avslutar. |
| `-SvepIntervallMs 20000` | takten. Förval 20 s. |
| `-GruppId <id>` | annan grupp. Måste finnas i bryggkodens grupptabell. |
| `-Loggfil <sökväg>` | annan logg än förvalet. |

Loggen ligger som förval i
`%LOCALAPPDATA%\Polisvakt\brygg-daemon-<datum>.log`, utanför repot med flit:
repot ligger i OneDrive, och en fil som växer var tjugonde sekund skulle synka
dygnet runt. Den skrivs som UTF-8 **med** byte-order-märke, så att
`Get-Content` och `type` visar å, ä och ö utan att man behöver veta vilken
flagga som krävs.

Två filer till, i samma mapp:

| Fil | Innehåll |
|---|---|
| `brygg-daemon-geo.json` | geokodningscache, även negativa svar (så samma okända plats inte slås upp varje svep). |
| `brygg-daemon-hanterade.json` | avbockade inlägg. **Skrivs bara i skarpt läge** — se torrkörningen nedan. |

Raderna som skickas bär `device_id = 'fb-daemon'`, på samma sätt som
userscriptet bär `fb-bridge` och mejlvägen `fb-mejl`. Ingen kod filtrerar på
fältet; det finns för att man ska kunna se i databasen vilken väg en rad kom
in.

### Förhållandet till `tools/brygg-injicera.ps1`

Det ligger ett andra skript i `tools/` som också injicerar bryggan över
felsökningsporten. De två gör inte samma sak:

| | `brygg-injicera.ps1` | `brygg-daemon.ps1` |
|---|---|---|
| Injicerar | hela `fb-bridge.user.js` | bara läsdelen |
| Värld | sidans egen (`Runtime.evaluate` utan kontext) | isolerad (`worldName: 'polisvakt'`) |
| Vid sidladdning | inget — måste köras om | `addScriptToEvaluateOnNewDocument`, automatiskt |
| Geokodning och Supabase | i sidan, **där Facebooks CSP blockerar dem** | i PowerShell |
| Anslutning | ny WebSocket per anrop | en, som hålls och återansluts |

Skillnaden som avgör: kör hela bryggan i sidan så måste den nå
`nominatim.openstreetmap.org` och `supabase.co` därifrån, och det tillåter
inte Facebooks CSP. Även i torrkörning faller geokodningen, så inga rader blir
till. Det är precis det som delningen "sidan läser, PowerShell skickar" finns
för att lösa.

---

## Arkitekturen: sidan läser, PowerShell skickar

```
   Chrome (bryggfönstret)                    PowerShell (brygg-daemon.ps1)
   ─────────────────────────                 ────────────────────────────
   facebook.com/groups/…
     │
     │  isolerad värld "polisvakt"
     │  ┌──────────────────────┐   CDP        ┌──────────────────────────┐
     └─▶│ läsdelen ur          │◀────────────▶│ svepklocka (20 s)        │
        │ fb-bridge.user.js    │  Runtime     │ produktregel (spärr 3)   │
        │  · collectPosts      │  .evaluate   │ ålder & livslängd        │
        │  · parseReportText   │              │ geokodning (Nominatim)   │
        │  · registreraSedda   │              │ skrivning (Supabase)     │
        │  · isSobrietyCheck   │              │ logg till fil            │
        │                      │              └──────────────────────────┘
        │  INGET NÄTVERK       │
        └──────────────────────┘
```

### Varför inte `Page.setBypassCSP`

Facebooks CSP blockerar nätverkstrafik mot `supabase.co` och
`nominatim.openstreetmap.org` från en facebook.com-sida. Det gäller även
injicerad kod — CSP:n sitter på dokumentet, inte på skriptet.

Den frestande genvägen är `Page.setBypassCSP`, som stänger av spärren för hela
fliken. Den används **inte**, och det är ett medvetet val: fliken kör ägarens
inloggade Facebook-session, och med CSP:n av får varje skript sidan råkar ladda
— från vilken värd som helst — göra vad som helst med den sessionen. Det är att
sänka säkerheten på riktigt för att slippa skriva trettio rader PowerShell.

Delningen ovan löser samma problem utan den kostnaden. Sidan läser bara. Allt
som behöver nätverk sker i PowerShell, där ingen CSP gäller. **Supabase-nyckeln
finns aldrig i sidan.**

### Isolerad värld, inte sidans egen

Skriptet körs i en isolerad värld (`Page.createIsolatedWorld` med
`worldName: 'polisvakt'`). Samma DOM, egen JS-kontext. Facebooks egen kod kan
varken läsa eller peka om `window.__pvLas`.

Det är också därför daemonen registrerar
`Page.addScriptToEvaluateOnNewDocument` med samma världsnamn: efter varje
sidladdning finns läsaren på plats innan flödet ens hunnit rendera.

---

## Koden återanvänds, den skrivs inte om

Daemonen läser `tools/fb-bridge.user.js` från disk vid varje start och klipper
ut stycket **mellan rubriken "Konfiguration" och rubriken "Geokodning"**. Det
stycket är parsern, minneslistan, först-sedd-mekaniken och hela
flödesläsningen — ordagrant, samma bytes som de 117 testerna körts mot. Allt
efter det (geokodning, skrivning, den gamla skanningsloopen) lämnas kvar i
filen och görs i stället i PowerShell.

Runt klippet lägger daemonen ett litet skal som gör tre saker: sätter en egen
`CONFIG`, kör produktregeln först, och gör om DOM-noder till något som går att
skicka över CDP.

**Klippet går på sektionsrubriker, inte på enskilda rader.** Första versionen
pekade på raden `const VIEWBOX = [`. Den raden fanns när daemonen skrevs och
var borta två timmar senare — bryggan gick till 2.3 och flyttade rutan in i en
tabell per grupp. Rubrikerna har däremot legat still genom hela filens
historia, och de beskriver dessutom verkligen gränsen.

Skalet frågar också efter *formen* på det den anropar i stället för att anta
den, eftersom bryggan skrivs om medan den används:

| 2.2 | 2.3 |
|---|---|
| `keysFor(post)` | `keysFor(post, grupp)` |
| `registreraSedda(poster)` | `registreraSedda(poster, grupp)` |
| `let kalibrerat` (boolean) | `const kalibrerade` (Set av grupp-id) |
| `const VIEWBOX` (en ruta) | `GRUPPER[].ruta` (ruta per grupp) |

Skalet läser funktionernas arity och använder `typeof` på identifierarna. En
odeklarerad identifierare ger `'undefined'` i stället för att kasta, så samma
skal går mot båda versionerna.

**Går klippet inte att göra startar daemonen inte.** Den kontrollerar också att
klippet innehåller `collectPosts`, `parseReportText`, `registreraSedda`,
`observeradTid`, `isSobrietyCheck`, `keysFor`, `MESSAGE_SEL` och
`FORSTSEDD_KEY` — och att det *inte* innehåller `nominatim`, `supabase`,
`send`, `scan` eller bryggans egen `CONFIG`. En brygga som tyst läser halv kod
är värre än en som inte startar.

---

## Spärrarna

### 1. Produktregeln: nykterhets- och drogkontroller

Absolut regel. En nykterhets- eller drogkontroll får aldrig skickas, aldrig
loggas och aldrig sammanfattas. Att varna för en fartkamera hjälper någon att
hålla hastigheten. Att varna för en nykterhetskontroll hjälper någon att köra
vidare full.

Regeln läckte redan en gång i det här projektet — isärskrivningar gick rakt
igenom bryggans kopia, och narkotikaorden saknades i båda kopiorna. Därför
ligger den nu på tre ställen i kedjan:

1. **I sidan, före allt annat.** `isSobrietyCheck(normalize(text))` körs på
   varje inlägg innan något annat händer. Fastnar ett inlägg där lämnar det
   aldrig sidan: daemonen får `{ nyckel, vagrad: true }` — ingen text, inget
   id, ingen tolkning, ingen plats.
2. **I sidan igen**, via `parseReportText` som svarar `intent: 'refused'`.
3. **I PowerShell**, på texten som ändå kom fram. Ska aldrig slå till. Gör den
   det är sidans spärr sönder, och då är det den här som står mellan felet och
   databasen. Den loggar då `VÄGRAD produktregel (fångad i PowerShell …)` som
   en uppmaning att se över bryggkoden.

**Ordlistorna kopieras inte.** De plockas ur `fb-bridge.user.js` vid start
(`SOBRIETY_WORDS`, `SOBRIETY_STAMMAR`, `SOBRIETY_PREFIX`, `SOBRIETY_HEAD`).
Går de inte att läsa startar daemonen inte. Skrivs listor av driver de isär,
och det var precis så narkotikaorden kunde saknas på ett ställe och finnas på
ett annat.

**Vad som loggas vid en vägran:** ordet `produktregel`, och ingenting mer.
Inte texten, inte platsen, inte vilken regel som slog till. Fartkameror vägras
med samma etikett *med flit* — kan man skilja dem åt i loggen har man också
fått veta att någon la upp en nykterhetskontroll, och det är precis det regeln
finns för att inte berätta.

Provet: `-Sjalvtest`. Det kör 26 meningar genom **båda** spärrarna — den i
PowerShell och bryggkodens egen i sidan — och jämför. 17 ska vägras
(isärskrivet, bindestreck, snedstreck, punkt, narkotikaorden, versaler), 9 ska
släppas igenom (däribland "Polisen drog vidare från Skiljebo", som inte är en
drogkontroll).

### 2. Gruppfiltret

Kontrolleras tre gånger: bryggkodens grupptabell byggs av `CONFIG.groupId` som
daemonen sätter, sidan svarar med vilken grupp fliken faktiskt står i, och
daemonen jämför med `-GruppId` innan något behandlas. Står fliken i fel grupp
loggas en rad och inget läses.

### 3. Området

Varje geokodningsträff kontrolleras mot gruppens ruta, både färska svar och
det som ligger i cachen. Nominatim får `viewbox` och `bounded=1`, men det är en
spärr som ligger hos någon annan — svarar servern ändå med en träff utanför
området kastas den här. En varning på fel plats är värre än ingen varning: den
lär föraren att appen ljuger.

Rutan hämtas från **sidans egen grupptabell**, inte från en kopia i daemonen.
Daemonens förval (Västmanland, `15.10,59.30,17.30,60.30`) är bara ett golv
tills första svepet svarat.

### 4. Åldern

Kan åldern inte läsas skickas ingenting. Tre vägar, i ordning:

1. **Facebooks egen tid**, läst ur DOM:en. Exaktast.
2. **Bryggans första observation.** Ett inlägg som saknades i förra svepet och
   finns nu dök upp under de senaste 20 sekunderna.
3. **Hovring.** Avstängd. Kräver förgrund och är en automationssignal mot Meta.

Går ingen av dem fram loggas `HOPPAS-ÖVER orsak=oläslig-ålder` och inlägget
lämnas. Efter tre försök ges det upp.

Ett inlägg som är äldre än varningen skulle leva (45–60 min) hoppas också
över: `orsak=för-gammalt`. Gammal varning är sämre än ingen.

### 5. Torrkörning som förval

Utan `-Skarpt` skrivs ingenting till databasen. Torrkörningen loggar hela raden
den *hade* skickat, med text, typ, koordinat, tilltro, ålder och livslängd.

Hanteringslistan hålls dessutom bara i minnet under torrkörning. Annars hade en
torrkörning "bränt" varje inlägg den tittat på, och skarpt läge efteråt hade
varit tyst.

---

## Loggen

```
10:03:45  START          Polisvakt brygg-daemon — TORRKÖRNING, skriver ingenting  grupp=…
10:03:45  START          läsdel ur fb-bridge.user.js: 41762 tecken, ordagrant
10:03:45  ANSLUTEN       flik 12A55CBB…  https://www.facebook.com/groups/317968668373072/
10:03:45  INJEKTION      läsaren injicerad i isolerad värld (injicerad)
10:03:45  OMRÅDE         gruppen "317968668373072" [15.1,59.3,17.3,60.3] orter=västerås/västmanland
10:03:46  SKULLE-SKICKA  typ=police plats="Vasagatan" 59.6112906,16.5451935 tilltro=90% ålder=0min (observation) lever=45min extid=fb:…
10:03:46  SKULLE-SKICKA    text: "Polis står vid Vasagatan just nu"
10:03:46  HOPPAS-ÖVER    orsak=för-gammalt (1566 min)  "Laser rondellen Rocklunda 50 sträckan Börjar nu"
10:03:46  HOPPAS-ÖVER    orsak=oläslig-ålder  "Laser på björnövägen vid pizzerian i båda riktningar"
10:03:46  SVEP           inlägg=6 nya=6 med-ålder=2 utan-ålder=4 vägrade=0
10:03:46  SUMMA          svep=1 unika-inlägg=6 läsbar-ålder=2 … skulle-skickat=1 …
```

| Etikett | Betyder |
|---|---|
| `START` | uppstart: läge, grupp, takt, hur många tecken som klipptes ur bryggkoden. |
| `ANSLUTEN` | fliken hittad och felsökningsanslutningen uppe. |
| `INJEKTION` | läsaren lagd i den isolerade världen. Sker vid start och efter varje sidladdning. |
| `OMRÅDE` | gruppens ruta och orter, hämtade ur bryggkodens tabell. |
| `SVEP` | en avläsning av flödet. Siffrorna beskriver flödet, inte arbetskön. |
| `SKULLE-SKICKA` | torrkörning: hela raden som hade skrivits, plus texten. |
| `SKICKAD` / `DUBBLETT` | skarpt läge. |
| `HOPPAS-ÖVER` | med `orsak=` och texten. |
| `VÄGRAD` | produktregeln. Aldrig någon text. |
| `GEO-KASTAD` / `GEO-FEL` | träff utanför gruppens ruta / Nominatim svarade inte. |
| `SIDFEL` | JS-fel i det injicerade skalet. Kodfel, går inte över. |
| `TAPPAD` | anslutningen bröts. Daemonen ansluter om. |
| `VÄNTAR` | bryggfönstret svarar inte. Klagar en gång i minuten. |
| `FEL-GRUPP` | fliken står någon annanstans. Inget läses det svepet. |
| `STOPP` | bryggkoden vägrar gruppen. |
| `SUMMA` | var tionde svep och vid avslut. |
| `PROV` / `PROV-FEL` / `PROV-LUCKA` | bara vid `-Sjalvtest`. |

### Ett fel i sidan är inte ett tappat nät

Första versionen av loopen behandlade allt som kastades som en bruten
anslutning: koppla ner, sov två sekunder, anslut igen. När bryggan gick till
2.3 och skalet kastade `ReferenceError` vid varje svep gav det en loop som
anslöt om två gånger i sekunden i flera minuter — mot ägarens riktiga
Facebook-session.

Nu skiljs tre saker åt: **JS-fel** (kodfel, backa av, försök i normal takt),
**nätfel** (koppla ner och anslut om) och **inget fönster** (vänta). Backoffen
är 2, 4, 8, 16, 32, 60 sekunder. Efter tre likadana svepfel i rad säger loggen
rakt ut att det är en kodrättelse och inte något som går över.

---

## Överlever omladdning, navigering och omstart av Chrome

* **Omladdning och navigering.** `Page.addScriptToEvaluateOnNewDocument` lägger
  läsaren i den isolerade världen vid varje ny sidladdning. Daemonens cachade
  kontext-id blir ogiltigt, nästa svep får ett kontextfel, och den skaffar en
  ny värld med `Page.createIsolatedWorld`. Finns inte `__pvLas` där injiceras
  den.

  Att samma världsnamn ger samma värld är **mätt**, inte antaget — hela
  återanslutningen hänger på det:

  ```
  createIsolatedWorld('provvarld')  -> contextId 7
  createIsolatedWorld('provvarld')  -> contextId 7      samma värld
  createIsolatedWorld('annanvarld') -> contextId 8      skild värld
  window.__prov = 42 satt i 7, läst i 7  -> 42
                              läst i 8  -> undefined
  ```
* **Omstart av Chrome.** Anslutningen dör, `TAPPAD` loggas, och daemonen letar
  efter fliken igen tills den finns. Ingen omstart av daemonen behövs.
* **Först-sedd-listan** ligger i `localStorage` under `pv.fb.forstsedd.v1` och
  överlever både omladdning och omstart. Ett inlägg som tidsbestämts i går är
  tidsbestämt även efter en omstart.
* **Läsarens version** är en hash av dess egen källkod. Ändras läsdelen i
  `fb-bridge.user.js`, eller skalet, byts hashen och den nya koden injiceras i
  stället för att den gamla ligger kvar i världen resten av dygnet.

Efter varje sidladdning är första svepet ett **kalibreringssvep**: allt som
redan syns registreras men får aldrig en observerad ålder. Annars hade varje
omstart gett en skur färska varningar ur ett veckogammalt flöde.

---

## Uttömda vägar — prova inte igen

| Väg | Vad som händer |
|---|---|
| Tampermonkey | installationssidan ligger på `chrome-extension://`. Chrome blockerar all automation där. |
| `--load-extension` | borttagen i Chrome 151. Verifierat isolerat: tillägget laddades inte, `window.__polisvakt` fanns inte. |
| Tillägg inläst för hand | **är** inläst och aktiverat i profilen (`gkfpgohonkfahcafjejfhdajbaiiolom`, `disable_reasons: []`, rätt `scriptable_host`) — men innehållsskriptet injiceras aldrig: noll konsolrader, tomt `localStorage`. Orsaken syns bara i `chrome://extensions`, som inte går att läsa maskinellt. |
| Hämta koden in i sidan | Facebooks CSP blockerar `fetch` mot både GitHub och localhost, och `window.name` rensas numera vid navigering mellan domäner. |
| OneDrive-platshållare | uteslutet. Filerna är fullt lokala, kontrollerat. |

`tools/brygg-tillagg/` ligger kvar orört. `starta-bryggan.ps1` skickar
fortfarande med `--load-extension` när mappen finns — det skadar inget och
börjar fungera igen om Google ändrar sig — men ingenting hänger på det längre.

---

## Kända begränsningar

* **Daemonen måste ligga på.** Ett inlägg får bara en ålder om det dyker upp
  medan daemonen tittar. Facebook renderar tidsstämpeln som en SVG-sprite på
  klientrenderade inlägg, alltså på just de nya, och där finns ingenting att
  läsa ur DOM:en. Startas daemonen efter att inlägget lagts upp är åldern
  okänd, och då skickas ingenting. **Det är den enskilt viktigaste orsaken
  till att inget nått appen tidigare.**
* **Samma inlägg kan få två olika nycklar när sidan renderas om.** Hittat
  under mätningen, och det är ett fel i bryggkodens nyckling, inte i
  daemonen. Inget av de fem inläggen i gruppen har ett inläggs-id, så
  `keysFor()` faller tillbaka på en hash av texten — och texten är inte
  stabil mellan renderingar:

  ```
  10:31:04   "Laser rondellen Rocklunda 50 sträckan Börjar nu"     (radbrytning kvar)
  10:32:04   "Laser rondellen Rocklunda 50 sträckanBörjar nu"      (radbrytningen borta)
  ```

  `story_message` innehåller två blockelement. Innan layouten är klar ger
  `innerText` ingen radbrytning mellan dem, och då blir det en annan
  normaliserad text och därmed en annan hash. Samma inlägg låg alltså på två
  nycklar under samma körning.

  Två följder, båda bara i skarpt läge:
  1. `external_id` byggs på samma hash, så samma inlägg kan skickas **två
     gånger** med olika `external_id` och dedupen i databasen fångar det inte.
  2. Dyker den omrenderade varianten upp överst i ett flöde där bryggan
     känner igen inlägg nedanför, ser den ut som ett **nytt** inlägg och kan
     få observerad ålder 0. Facebooks egen tidsstämpel vinner när den går att
     läsa och räddar fallet då, men inte för de inläggen där den saknas.

  I mätningen hände det under ett kalibreringssvep, så ingenting skickades.
  Rättelsen hör hemma i `keysFor()`/`meddelandeText()` i
  `tools/fb-bridge.user.js` — texten behöver normaliseras hårdare innan den
  hashas, eller nycklas på något stabilare än texten.
* **Bryggan ser bara så långt bak i flödet som fönstret är högt.** Mätt: 1
  inlägg i ett oskrollat 945 px-fönster, 16 vid en emulerad viewport på
  4 000 px. Se mätningen längre ned. Nya inlägg läggs överst och toppen är
  alltid renderad, så det påverkar inte det bryggan finns till för — men vill
  man att den ska se mer av flödet är ett högre fönster vägen dit.
* **ASCII-strippade blås-stavningar går igenom produktregeln.** Ordlistorna
  bär svenska tecken. För sållnings- och drogsöksorden finns ASCII-varianten
  med (`sallnings`, `drogsok`, `drogsokhund`), men inte för blås-orden:
  `blaser` utan å fångas inte. Rättelsen hör hemma i `js/parser.js` och
  `tools/fb-bridge.user.js`. `-Sjalvtest` mäter luckan och rapporterar den som
  `PROV-LUCKA` varje gång, så att den inte glöms bort — den fäller inte provet,
  eftersom den inte går att laga härifrån.
* **Automatiserad läsning av Facebook strider mot Metas användarvillkor.**
  Risken ligger på kontot som kör. Bryggfönstret använder en egen profil just
  därför.
* **Endast läsning.** Daemonen klickar aldrig, skriver aldrig i ett fält och
  hovrar inte. Den läser DOM och inget annat.

---

## Mätt mot den riktiga gruppen

Allt nedan är avläst 2026-08-21 mot **Här Står Polisen - Västerås**
(`317968668373072`), i torrkörning. Ingenting skrevs till databasen.

### Vad bryggan ser i flödet

| | |
|---|---|
| `[data-ad-rendering-role="story_message"]` | **5** i ett fönster som stått öppet en stund |
| `div[role="article"]` | **2** — och båda är **kommentarer**, inte inlägg. Sorteras bort. |
| `[role="feed"]`-barn | 5 |

Meddelandeväljaren är alltså förankringen, precis som bryggkoden säger.
Hade daemonen räknat `role="article"` som inlägg hade den läst två kommentarer
och noll inlägg.

### Flödet renderas efter fönsterhöjden — mätt

Ett **nyöppnat, oskrollat** bryggfönster (945 px högt) renderar bara det
översta inlägget. Efter sex minuter var det fortfarande ett, med en
laddningsindikator kvar. Med `Emulation.setDeviceMetricsOverride` på
1200 × 4000 px:

| Viewport | Renderade inlägg | Sidhöjd |
|---|---|---|
| 945 px (som fönstret står) | **1** | 1 829 px |
| 4 000 px (emulerad) | **16** | 7 669 px |
| tillbaka till 945 px | 5 (de som hunnit renderas ligger kvar) | 7 633 px |

Facebook renderar alltså feed-objekt först när de närmar sig viewporten.
**Bryggans räckvidd bakåt i flödet är fönsterhöjden.**

Det spelar mindre roll än det låter: nya inlägg läggs överst, och toppen är
alltid renderad. Behållarregeln behöver bara *ett* känt inlägg nedanför för
att räkna ett nytt inlägg som nytt, och det finns alltid.

Daemonen sätter **inte** någon viewport-override av sig själv. Vill man se
längre bakåt i flödet är ett högre fönster den ärliga vägen.

### Ålder

Av de 5 inläggen hade **1** en ålder som gick att läsa ur DOM:en. De övriga
**4** har tidsstämpeln ritad som SVG-sprite — där finns ingenting att läsa
synkront, och de får därför `orsak=oläslig-ålder`. Efter tre svep ges de upp.

`window.__pvLas.tider()` visar det rakt av. Kolumnen `tidText` är vad
`synligText()` får ut av tidsankaret, alltså vad som faktiskt står renderat:

| `tidText` | källa | ålder | inlägg |
|---|---|---|---|
| `Igår kl. 07:58` | `facebook` | 1 592 min | Laser rondellen Rocklunda 50 sträckan Börjar nu |
| *(tom)* | — | — | Laser på björnövägen vid pizzerian i båda riktningar |
| *(tom)* | — | — | Irstamacken |
| *(tom)* | — | — | Trafikvecka nu hela v34. |
| *(tom)* | — | — | Idag firar Här Står Polisen - Västerås 12 år … |

Den geometriska avläsningen av teckenspannen fungerar alltså — den fick ut
`Igår kl. 07:58` ur ett ankare där `innerText` ger skräp. Problemet är de fyra
andra, där ankaret inte innehåller några tecken alls.

**Inget av de fem inläggen hade ett inläggs-id** (`id` tom rakt igenom), så
alla nycklas på texthash. Det stämmer med bryggkodens egen mätning: 1 av 7 hade
en permalänk, och bara för att kommentarerna råkade vara utfällda.

Det är **inte** ett fel. Det är spärren som gör sitt: ett inlägg vars ålder
inte går att fastställa får inte bli en färsk varning på kartan.

Varje svep i stabilt läge ser likadant ut:

```
SVEP  inlägg=5 nya=0 med-ålder=1 utan-ålder=4 vägrade=0
```

Och loggen tystnar av sig själv: de två inlägg som tolkas men saknar ålder
loggas tre gånger var (`MAX_TRIES`) och ges sedan upp. Efter fyra svep står
bara `SVEP`-raderna kvar. En daemon som ska gå i timmar får inte skriva samma
tre rader var tjugonde sekund.

### Vad daemonen hade skickat ur det riktiga flödet: ingenting

Med texterna, som mätningen begärde:

| Text | Utfall |
|---|---|
| "Laser rondellen Rocklunda 50 sträckan Börjar nu" | `för-gammalt` — tolkades rätt som `control`, men Facebooks egen tid säger "Igår kl. 07:58", alltså drygt 26 timmar, och en laserkontroll lever 60 minuter. (Minutsiffran i loggen växer under körningen: 1 552 → 1 592.) |
| "Laser på björnövägen vid pizzerian i båda riktningar" | `oläslig-ålder` — tolkas rätt, men SVG-sprite-tidsstämpel och redan i flödet vid kalibreringssvepet. |
| "Irstamacken" | `ingen-rapport` — inget typord. |
| "Trafikvecka nu hela v34." | `ingen-rapport` — inget typord. |
| "Idag firar Här Står Polisen - Västerås 12 år med 18K följare . Kan vi vi nå 20K?" | `oläslig-ålder` (och hade fallit på tolkningen ändå). |

**Det här är svaret på varför ingenting nått appen.** Gruppen hade under
mättillfället inget färskt inlägg att skicka. Den enda riktiga varningen i
flödet var ett dygn gammal, och den ska inte skickas.

### Ny post → varning: verifierad, och tidtagen

Eftersom flödet inte hade något färskt inlägg mättes vägen med en **syntetisk
nod** i ägarens egen webbläsare: ett `story_message`-element lagt överst i
`[role="feed"]`, utanför skärmen, borttaget direkt efteråt. Ingenting
publicerades, kommenterades, gillades eller skickades till Facebook.

Daemonen kördes i normal takt (20 s) och rörde inte noden.

```
10:15:12.322   noden läggs in
10:15:12       ← svep, hann strax före
10:15:32       SKULLE-SKICKA  typ=police plats="Vasagatan" 59.6112906,16.5451935
               tilltro=90% ålder=0min (observation) lever=45min
               extid=fb:317968668373072:1el3mdw:3joy
               text: "Polis står vid Vasagatan just nu"
```

**Fördröjning inlägg → upptäckt: 19,7 sekunder**, alltså inom ett svep, som
konstruktionen säger. Geokodningen låg i cachen och kostade ingenting; ett
kallt uppslag mot Nominatim lägger på upp till 1,2 s (kötiden) plus svarstid.

Samma nod med texten "Nykterhetskontroll vid Vasagatan just nu" — allt annat
lika, samma plats, samma tilltro — gav:

```
10:04:17       SVEP  inlägg=6 nya=6 med-ålder=1 utan-ålder=4 vägrade=1
```

Ingen `SKULLE-SKICKA`. Ingen geokodning. Ingen text någonstans i loggen. Bara
en etta i `vägrade`.

### Svepklockan håller takten

Uppmätt över **44 svep** i följd, i ett fönster som låg i bakgrunden hela
tiden — och som under körningen laddades om, navigerades bort och tillbaka:

| Sekunder mellan svep | Antal |
|---|---|
| 20 | 42 |
| 21 | 1 |

Bryggans egen `setInterval` stryptes under samma förhållanden till en
väckning i minuten efter två minuter (mätt tidigare, står i botten av
`fb-bridge.user.js`). Daemonens klocka ligger utanför sidan och stryps inte.

Loggen från samma körning innehöll: 44 `SVEP`, 10 `HOPPAS-ÖVER`, 2
`INJEKTION`, 1 `ANSLUTEN`, 1 `OMRÅDE`, 4 `SUMMA`. **Noll `SIDFEL`, noll
`TAPPAD`, noll `GEO-FEL`.**

Sista sammanställningen:

```
SUMMA  svep=40 unika-inlägg=6 läsbar-ålder=1 utan-ålder=5 vägrade=0
       hoppade=3 okänd-plats=0 skulle-skickat=0 dubbletter=0 fel=0
```

`unika-inlägg=6` mot fem inlägg i flödet är inte ett räknefel — det är
nyckelproblemet under "Kända begränsningar": ett av inläggen låg på två
nycklar därför att texten renderades om utan sin radbrytning.

### Överlevnad — provat skarpt under körning

| Händelse | Vad som hände |
|---|---|
| `Page.reload` mitt i körningen | `INJEKTION` + nytt kalibreringssvep. Inget svep missat. |
| Navigering till `/groups/<id>/about` | 10:31:42 navigering → 10:31:44 `INJEKTION` + `SVEP inlägg=0` (om-sidan har inget flöde), korrekt märkt som kalibreringssvep. Två sekunder. |
| Navigering tillbaka till flödet | 10:32:03 navigering → 10:32:04 `INJEKTION` + `SVEP inlägg=1`, och flödet växte tillbaka svep för svep. En sekund. |
| Chrome stängdes helt | `TAPPAD` → `VÄNTAR` var 55:e sekund i 2 min 13 s. |
| Chrome startades om | `ANSLUTEN` till den nya fliken, `INJEKTION`, och sveparna fortsatte. Daemonen startades aldrig om. |
| Svepet före navigeringen | `FEL-GRUPP adressen är / — ingen grupp där ännu`. Ingenting lästes det svepet, och nästa gick igenom. |

Ingen av händelserna krävde att daemonen startades om, och ingen av dem gav
ett tappat svep utöver det ena där sidan ännu inte hade navigerat.

### Gör om mätningen själv

```powershell
# Produktregeln, båda spärrarna. Kräver inte ens att Chrome kör.
powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1 -Sjalvtest

# Ett svep: vad ser bryggan i flödet just nu, och vad hade den gjort?
powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1 -Svep 1

# En halvtimme i normal takt, egen loggfil.
powershell -ExecutionPolicy Bypass -File tools\brygg-daemon.ps1 `
  -MinuterAttKora 30 -Loggfil "$env:LOCALAPPDATA\Polisvakt\matning.log"
```

Vill du se detaljerna per inlägg — vilken tidstext ankaret bär, varifrån
åldern kom — finns `window.__pvLas.tider()` i den isolerade världen, samma vy
som `__polisvakt.tider()` i userscriptet. Vägrade inlägg har `text: null`
också där.

### Produktregeln

`-Sjalvtest`, 26 meningar genom **båda** spärrarna:

```
PROV   Ordlistor ur fb-bridge.user.js: 26 ord, 13 stammar, 14 förled, 6 huvudord
PROV   PowerShell-spärren: 26/26
PROV   Sidans spärr (bryggkodens egen): 26/26
PROV   Alla fall gröna.
```

De två spärrarna gav **identiskt** svar på alla 26 fallen. Det är poängen med
att hämta ordlistorna ur bryggkoden i stället för att skriva av dem.
