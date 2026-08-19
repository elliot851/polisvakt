# Polisvakt — produktplan

Allt Elliot vill bygga, samlat på ett ställe så inget tappas bort mellan
sessioner. Ordnat efter vad som faktiskt flyttar affären, inte efter i vilken
ordning det nämndes.

Status: ✅ klart · 🔨 påbörjat · 📋 planerat · ❓ behöver beslut · ⛔ byggs inte

---

## Appen

### Klart
- ✅ Karta med polis, kontroller, civilbilar och 136 fartkameror (OSM, med mätriktning)
- ✅ Hastighetsgräns för vägen du kör på, varning när du ligger över
- ✅ Röstvarningar på svenska med avstånd och klockriktning
- ✅ Röststyrd rapportering, väckningsord "Hej vakt"
- ✅ Dashcam med loopbuffert, krockdetektering, självtest mot svart bild
- ✅ Konton, delade rapporter, rapportpoäng och topplista
- ✅ Historik och mönster ("här står polisen oftast fredagar 15–18")
- ✅ Introduktionsguide, testknappar för varningsljud
- ✅ Ljudducking som trafikmeddelande — musiken dämpas, kommer tillbaka
- ✅ Zoom avstängd, konto krävs

### Nästa
- 🔨 **Körningsdetektering** — appen känner att bilen rullar och påminner
  "glöm inte slå på Polisvakt". Det här är den enskilt viktigaste funktionen
  för att appen ska användas: en app man glömmer starta är värdelös.
- 🔨 **Bevakningsområde** — hela Västmanland, bara Västerås, eller radie
  (10/30/50 km). Plus ruttläge: skriv "Stockholm" och få varningar längs vägen
  precis som Waze.
- 🔨 **Nattläge** — mörk karta efter solnedgång räknad på riktig position och
  datum, inte klockslag. Viktigt på vintern när det är mörkt klockan tre.
- 📋 **Notisinställningar per typ** — vissa vill bara ha kontroller, inte varje
  fartkamera de redan kan utantill.
- 📋 **Widget / låsskärm** — snabbrapport utan att låsa upp.

## Affär

### Prenumeration
Beslut: **99 kr/mån** istället för 29 kr.

Motiveringen som ska in i appen: en fortkörningsbot ligger på 1 500–4 000 kr
och vid grov överträdelse ryker körkortet. 99 kr/mån är 1 188 kr på ett år.
En enda undviken bot betalar mer än hela året.

Viktigt i copyn: sälj **att hålla hastigheten**, inte "slippa böter". Det är
både ärligare och starkare — den som håller gränsen får aldrig boten från
början, och då slipper vi också stå för ett löfte vi inte kan hålla.

- ❓ **Nivåer** — 99 / 149 / 199 kr. Vad ska ligga i varje? Se förslag nedan.
- 📋 **6 månader i förskott** — halva priset på tillbehör, eller rabatterad
  månadskostnad. Ger MRR och binder kunden över trafikveckorna.
- 📋 Stripe Payment Link saknas fortfarande.

### Fysiska produkter
Modell: källa i Kina → **bulk till svenskt lager** → 1–2 dagars leverans → egen
branding.

**Viktigast av allt i sourcingen:** EU:s nya schablontull på 3 EUR per vara
gäller distansförsäljning i lågvärdesändningar — alltså dropship direkt från
Kina till kund. **Bulkimport till eget lager räknas som vanlig kommersiell
import och slipper den.** På en hållare med 14 kr i inköp är skillnaden
mellan 21 kr och 54 kr landad kostnad. Bulk är inte en optimering här, det är
förutsättningen för att affären ska gå ihop.

- 🔨 **Mobilhållare** — huvudprodukten.
  **Kritiskt krav som nästan alla hållare missar:** ryggplattan täcker
  telefonens bakre kamera. Utan fri lins fungerar inte dashcammen, och då
  faller hela produktkopplingen. Kräv **magnetfäste (MagSafe-typ)** eller öppen
  ram utan ryggplatta.
  Indikativt: teleskoparm ~$1,40–1,57 vid MOQ 500, landad ~21 kr.
  ❓ **Beslut behövs:** instrumentbräda ger sämre dashcam-bild än vindruta —
  motorhuv i bild och instrumentbrädan speglar sig i glaset, värst på natten
  som är hela poängen. Lång arm upp mot glaset + antireflexmatta löser det.
  Matta kan säljas som tillbehör.
  Sugkopp släpper i kyla på texturerad plast — kör 3M VHB-platta i Sverige.
- 📋 Start: standardprodukt + **egen tryckt förpackning** (~$0,10–0,30/st).
  Graverad logga driver MOQ till 3 000+ och pris +20–50 % — spara till order två.
- 📋 **Stickers** — lägg i kartongen som giveaway, ~$0,03/st i samma last.
  För lösförsäljning: print-on-demand i EU, ingen import och ingen lagerbindning.
- ❓ **Doftfläkt** — hårdvaran är billig ($0,09–0,25) och lätt att branda, men
  vätskan klassas som UN1266 brandfarlig vara med DG-frakt och CLP-etikett.
  Väg: importera torr bärare, fyll doften i EU.
- ⛔ **Nattkörningsglasögon** — se nedan.
- ⛔ **Nattkamera** — se nedan.

**GPSR gäller allt:** sätter vi eget varumärke på en produkt blir vi juridisk
tillverkare, med märkning, teknisk dokumentation och riskanalys. Undvik
trådlös laddning i version 1 — då tillkommer RED, EMC och RoHS.

### Marknad
- 📋 Meta-annonsering
- 📋 UGC-kreatörer (Sofia Lindberg-flödet finns redan i en annan skill)
- 📋 Expansion: Norge, Danmark, Finland. Appen är redan byggd för att byta
  region — kameradata, platsnamn och språk är separata filer.

## Facebook-gruppen "Här står polisen"

Mottagarsidan är klar och testad: parser, geokodning, kartmarkering och
uppläsning. Det som saknas är flödet in.

- ⛔ Officiellt API finns inte. Meta stängde Groups API för inläggsläsning 2024.
- ❓ **Userscript-brygga** — läser inläggen i din egen inloggade webbläsare.
  Fungerar, men kräver öppen flik och bryter mot Metas villkor.
- ❓ **Telegram-spegel** — be en admin spegla gruppen. Riktigt bot-API, ingen
  villkorsrisk, dygnet runt. Rekommenderas.

---

## Byggs inte

### ⛔ Register över civila polisbilar
Registreringsnummer, märke, färg, årsmodell och foton på civila polisfordon,
sparat så alla kan söka i det.

Det här är inte samma sak som att varna för var polisen står just nu. Det är en
permanent katalog som pekar ut enskilda tjänstemäns fordon. Civila enheter
används för narkotika, människohandel, organiserad brottslighet och rattfylla
— inte bara hastighet. Registreringsnummer kopplade till tjänstemän är dessutom
personuppgifter, och foton på fordonen gör dem spårbara som individer.

**Det som finns istället:** "Civil"-knappen och röstkommandot "civil här"
lägger en varning på kartan som alla ser och som försvinner efter 30 minuter.
Föraren blir varnad. Ingen databas byggs.

### ⛔ Automatisk avläsning av registreringsnummer under körning
Kameran läser skyltarna på bilarna runt omkring och larmar när en av dem finns
i civilpolisregistret.

Två saker på en gång: dels bygger det registret ovan, dels blir det automatisk
massinsamling av registreringsnummer på alla privatpersoner man kör förbi.
Skyltarna är personuppgifter, och att systematiskt läsa av dem från en bil i
rörelse är en helt annan sak än att en människa tittar ut genom rutan.

**Det som finns istället:** dashcammen filmar framåt och sparar det som händer.
Vill du ha bevis efter en incident finns filmen. Ingen automatisk identifiering
av andra bilister.

---

## Teknisk verklighet att räkna med

Saker som begränsar vad som går, oavsett hur mycket vi vill:

- **Appen måste ligga i förgrunden.** Webbläsare stoppar GPS, mikrofon och
  kamera i bakgrunden. Wake Lock håller skärmen tänd, men telefonen måste sitta
  i hållaren med appen framme. Det här är det starkaste argumentet för att på
  sikt bygga en riktig native-app.
- **Körningsdetektering i bakgrunden går inte** av samma skäl. Påminnelsen
  måste komma via push från servern, baserat på tid på dygnet och vanor —
  inte via GPS som körs hela tiden.
- **Röstigenkänning saknas i Safari.** Väckningsordet fungerar bara på
  Android/Chrome. iPhone får tryck-och-tala.
- **Nattkamera via Bluetooth** — Bluetooth klarar inte videoström. En sådan
  kamera skulle behöva wifi, egen app eller trådanslutning. Kolla vad
  leverantörerna faktiskt har innan vi lovar något.

---

## Förslag på nivåer

| | 99 kr | 149 kr | 199 kr |
|---|---|---|---|
| Varningar och karta | ✓ | ✓ | ✓ |
| Röststyrning | ✓ | ✓ | ✓ |
| Dashcam | 20 min buffert | Obegränsad | Obegränsad |
| Bevakningsområde | Radie | Hela länet | Flera län |
| Historik och mönster | — | ✓ | ✓ |
| Molnlagring av händelser | — | — | ✓ |
| Rabatt på tillbehör | 10 % | 25 % | 50 % |

Halva priset på tillbehör vid 6 månaders förskottsbetalning.
