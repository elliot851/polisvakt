# Prenumerationsnivåer — förslag

Svar på den öppna frågan i `ROADMAP.md`: *"Nivåer — 99 / 149 / 199 kr. Vad ska
ligga i varje?"*

Grundpriset 99 kr/mån är låst av ägaren och ändras inte här. Det som avgörs är
vad som skiljer nivåerna åt, vad som aldrig får skiljas åt, och vad som måste
byggas innan något av det går att sälja.

Varje rad är märkt **FINNS IDAG** (med filhänvisning) eller **MÅSTE BYGGAS**.
Ett nivåförslag som paketerar funktioner som inte finns är värdelöst, så den
märkningen är viktigare än nivåindelningen i sig.

> **Läge just nu, belagt i koden:** nivåvalet är rent kosmetiskt. `js/app.js`
> rad 1975 sparar `settings.plan` i inställningarna och byter knapptext.
> `perks`-objekten i `js/plans.js` läses inte av någon fil (grep över hela
> `js/`). `get_subscription` i `supabase/KOR-ALLT.sql` rad 257 returnerar bara
> `trial_start` och `paid_until` — aldrig `plan`, trots att kolumnen finns i
> `supabase/billing.sql` rad 29 och fylls av webhooken. **Ingen nivå går att
> upprätthålla idag, ens om vi ville.**

---

## 1. De tre nivåerna

Behåll id:na `bas`, `plus`, `pro`. De är inskrivna i `js/plans.js`,
`js/betalning.js`, `supabase/stripe_price_map` och i metadata på varje Stripe-pris
(`docs/BETALNING.md` avsnitt 2). Att döpa om ett id kostar mer än det smakar.

### Bas — 99 kr/mån · "Allt som varnar"

Hela varningsappen. Inget skydd är borttaget.

| Funktion | Status |
|---|---|
| Röstvarningar för polis, kontroll, civilbil och fartkamera med avstånd och klockriktning | FINNS IDAG — `js/alerts.js`, `js/voice.js` |
| Karta med 136 fartkameror, mätriktning | FINNS IDAG — `js/map.js`, `data/` |
| Hastighetsgräns för vägen du kör på + varning när du ligger över | FINNS IDAG — `js/speedlimit.js` |
| Röststyrd rapportering, väckningsord "Hej vakt" | FINNS IDAG — `js/voice.js` (ej Safari, se `ROADMAP.md`) |
| Bevakningsområde: radie, Västerås, **hela Västmanland**, **ruttläge** | FINNS IDAG — `js/coverage.js`, `js/rutt.js` |
| Historik och mönster ("här står polisen oftast fredagar 15–18") | FINNS IDAG — `js/stats.js` |
| Dashcam med loopbuffert, krockdetektering, "spara händelse" — lokalt, ingen konstgjord tidsgräns | FINNS IDAG — `js/dashcam.js`, `js/impact.js` |
| Halk- och vinterrisk från SMHI | FINNS IDAG — `js/vinter.js` |
| Vakthund som säger till när appen slutat kunna varna | FINNS IDAG — `js/vakthund.js` |
| Rattknappar och Bluetooth-dosa | FINNS IDAG — `js/remote.js` |
| Rapportpoäng och topplista | FINNS IDAG — `js/reputation.js` |
| Gratis månad till de 10 som rapporterar mest | **DELVIS** — listan finns (`js/reputation.js`, löftet skrivs ut i `js/app.js` rad 486), men **ingen automatik ger månaden**. Se risk 4. |
| Påminnelse "glöm inte slå på Polisvakt" | **MÅSTE BYGGAS** — `js/driving.js` och `js/push.js` finns, men `sw.js` saknar `push`-lyssnare och den schemalagda funktionen finns inte |
| 10 % rabatt på tillbehör | **MÅSTE BYGGAS** — ingen butik finns; `js/app.js` `toggleInterest()` registrerar bara intresse |

### Plus — 149 kr/mån · "Bevis som överlever telefonen"

Skillnaden mot Bas är inte fler varningar. Det är att det som spelats in
finns kvar när telefonen är krossad, stulen eller kvar i bilen hos motparten.

| Funktion | Status |
|---|---|
| Allt i Bas | — |
| Molnlagring av sparade händelseklipp (förslag: 20 klipp, 12 månaders retention) | **MÅSTE BYGGAS** — `js/dashcam.js` sparar enbart i IndexedDB på telefonen |
| Automatisk uppladdning när krock detekteras | **MÅSTE BYGGAS** — `js/impact.js` låser klippet idag, men laddar inte upp |
| Upp till 3 förare på samma abonnemang | **MÅSTE BYGGAS** — konton finns (`js/auth.js`) men `subscribers` är en rad per enhet/konto, ingen platslogik |
| 25 % rabatt på tillbehör | **MÅSTE BYGGAS** |
| Mobilhållare ingår vid 12 månaders förskott | **MÅSTE BYGGAS** — lager och leverans, se `ROADMAP.md` |

### Pro — 199 kr/mån **per förare** · "För dem som kör för att tjäna pengar"

Pro är inte en större konsument. Det är åkeriet, trafikskolan och budfirman.
Sälj den inte som tredje kolumn i inställningarna bredvid de andra två — sälj
den på en egen sida med "kontakta oss".

| Funktion | Status |
|---|---|
| Allt i Plus | — |
| Privata grupper — förarna ser varandras rapporter utan att allt går ut i länet, upp till 50 medlemmar | FINNS IDAG — `js/grupper.js`, `supabase/grupper.sql` (`member_limit` default 50) |
| Fakturabetalning och samlingsfaktura | **MÅSTE BYGGAS** — Stripe Invoicing; idag bara betallänkar (`js/betalning.js`) |
| Prioriterad support med utlovad svarstid | **MÅSTE BYGGAS** — ingen supportkanal finns i koden |
| Flera regioner (Norge, Danmark, Finland när de finns) | **MÅSTE BYGGAS** — `js/coverage.js` har `radius`/`city`/`county`/`route`, inget `multi`-läge; kräver dessutom ny kameradata per region |
| 50 % rabatt på tillbehör | **MÅSTE BYGGAS** |

**Bedömning:** Pro är den enda nivån som redan har sin bärande funktion byggd
(grupper). Det är också den enda nivån där 100 kr extra i månaden är
oomtvistat billigt — för ett åkeri är det avrundningsfel.

---

## 2. Vad som inte får ligga bakom en högre nivå

**Jag håller med ägaren, och jag har prövat motsatsen ordentligt.**
Säkerhetskritiska varningar ligger i Bas. Inget undantag.

Det etiska argumentet räcker men står inte ensamt. Tre skäl till som väger lika
tungt kommersiellt:

1. **Produktlöftet går sönder.** Appen säljer att du ska hålla hastigheten,
   inte att du får en trevligare karta. En nivå som tar bort en varning tar
   inte bort en bekvämlighet — den tar bort själva produkten och säljer
   tillbaka den. Det är samma resonemang som redan är inskrivet i
   `js/vakthund.js`: en app som slutat varna utan att säga det är sämre än
   ingen app alls, för den har lärt föraren att lita på tystnaden. En
   nivåspärr producerar exakt den tystnaden, med flit.
2. **Det skadar den dyraste kunden.** Värdet ligger i rapporttätheten. En
   Bas-användare som inte varnas för kontrollen ser den inte, bekräftar den
   inte och rapporterar den inte — och då försämras data för Pro-kunden som
   betalar mest. Att strypa varningar nedåt sänker kvaliteten uppåt.
3. **Det finns ingen marginal att hämta.** Det roadmapens tabell föreslår att
   låsa — dashcam-minuter, historik, bevakningsradie — kostar oss noll kronor
   i drift. Allt ligger i telefonen eller i data vi redan hämtat. Att låsa
   något som är gratis att ge bort ger ingen intäkt, bara churn och
   supportärenden.

### Tre rader i roadmapens tabell som jag vill riva

| Roadmapens förslag | Min bedömning |
|---|---|
| Dashcam 20 min på Bas, obegränsad på Plus | **Riv.** Lagringen ligger i telefonens IndexedDB och `js/dashcam.js` (rad ~800–830) krymper redan bufferten automatiskt efter ledigt utrymme. Taket sparar oss ingenting — det gör bara bevisfilmen kortare den dag någon kör in i kunden. |
| Bevakning: radie på Bas, hela länet på Plus | **Riv.** Att en Bas-kund inte varnas för kontrollen i Hallstahammar är precis det vi sagt att vi inte gör. Hela Västmanland och ruttläget ligger i Bas. Det som *kan* ligga högre är **andra regioner** när de finns — det är ny datakostnad för oss, inte ett borttaget skydd. |
| Historik och mönster först på Plus | **Riv.** Mönstren är varningskvalitet, inte lyx, och de är enligt `js/stats.js` det som är svårast för en konkurrent att kopiera. Använd dem som skäl att stanna kvar, inte som lås. |

### Vad som däremot får kosta extra

En funktion får ligga på en högre nivå om den uppfyller minst ett av tre krav:

- **den kostar oss pengar per kund** — molnlagring, bandbredd, GDPR-ansvar för
  filmen, hårdvara, support med utlovad svarstid;
- **den vänder sig till ett annat behov** — flottstyrning, fakturering, flera
  förare på ett avtal;
- **den täcker geografi vi behövt köpa in eller bygga data för.**

Ingen av dem gör att någon kör på en fartkamera.

---

## 3. Årspris och halvårspris

### Förslag

| | Månad | 6 mån | 12 mån |
|---|---|---|---|
| Bas | 99 kr | **495 kr** | **890 kr** |
| Plus | 149 kr | **745 kr** | **1 340 kr** |
| Pro | 199 kr | **995 kr** | **1 790 kr** |

Logiken går att säga i en mening vardera, vilket är hela poängen:

- **6 månader = en månad gratis** (5 × månadspriset). Dessutom **halva priset
  på alla tillbehör** så länge prenumerationen löper — det är ägarens redan
  uttalade önskemål och det ligger redan som text i `PREPAY.extra`,
  `js/plans.js`.
- **12 månader = tre månader gratis** (9 × månadspriset). Dessutom **ingår
  mobilhållaren**.

> **Detta ändrar befintliga siffror.** `PREPAY.discountPercent = 20` i
> `js/plans.js` ger idag 475 / 715 / 955 kr, och de beloppen står också i
> `docs/BETALNING.md` avsnitt 2 och i `stripe_price_map` (`supabase/stripe.sql`
> rad ~226). Byter man ladder måste alla tre uppdateras, annars slutar
> webhookens reservväg att hitta rätt nivå. Skälet att ändå byta: årspriset
> måste vara bättre än halvårspriset, och en procentsats är svårare att sälja
> än "tre månader gratis".

### Räkneexempel — Bas

| | Månadsvis | 6 mån | 12 mån |
|---|---|---|---|
| Betalar | 1 188 kr/år | 495 kr | 890 kr |
| Per månad | 99 kr | 82,50 kr | 74,17 kr |
| Sparar mot månadsvis | — | 99 kr | 298 kr |
| Ingår extra | — | tillbehör till halva priset (hållare 299 → 150, matta 99 → 50) | hållaren ingår (299 kr) |

Mot boten, formulerat ärligt: **ett helt år på Bas kostar 890 kr. Den
billigaste fortkörningsboten är 1 500 kr** (`FINE_EXAMPLES`, `js/plans.js`).
Året kostar alltså under 60 % av den lindrigaste boten — men argumentet i copyn
är fortfarande att du håller gränsen och aldrig får boten, inte att du undviker
den.

**Vad årspriset kostar oss:** 890 kr in, minus hållaren som enligt `ROADMAP.md`
landar på ~21 kr vid bulkimport (~30 kr med tryckt kartong), minus ~2 % i
Stripe-avgift ≈ **840 kr netto för tolv månader**, mot 1 164 kr netto om
kunden betalar månadsvis och stannar hela året. Skillnaden på ~324 kr är priset
för kontanterna i förskott och för att kunden faktiskt får en hållare — vilket
är den enskilt viktigaste faktorn för att appen ska användas alls.

**Hållaren är inte ett tillbehör, den är en förutsättning.** `ROADMAP.md`
konstaterar att appen måste ligga i förgrunden och att telefonen måste sitta i
hållaren med fri bakre kamera för att dashcammen ska fungera. En kund utan
hållare använder inte appen, och en kund som inte använder appen säger upp den.
Att ge bort en produkt som kostar oss 21 kr för att lösa retentionsproblemet är
det billigaste marknadsföring vi kan köpa.

---

## 4. Största risken, och vad jag skulle mäta

### Risken: 99 kr är prissatt mot boten, men konkurrerar mot noll

Räknestycket "en bot = femton månader" är sant och det är inte det som avgör.
Köparen jämför inte med boten, hen jämför med Waze och Google Maps, som varnar
för fartkameror gratis. Det Polisvakt har som de inte har — polis och kontroller
i realtid, uppläsning, dashcam, halkvarning — är till hälften beroende av att
tillräckligt många andra i Västmanland också betalar 99 kr och rapporterar.

**Det är en kallstart som prissättningen inte kan lösa.** Vid låg
rapporttäthet är Bas objektivt sämre än gratisalternativet, och då spelar det
ingen roll om priset är 99, 49 eller 149. Vid hög täthet är 99 kr billigt.
Risken är alltså inte att priset är för högt — den är att vi tolkar en
täthetskris som ett prisproblem och sänker priset, vilket förstör affären utan
att fixa något.

Tre risker till, i fallande ordning:

2. **Fem dagars provperiod är förmodligen för kort.** `TRIAL_DAYS = 5`
   (`js/billing.js`), och provperioden startar först när appen används på
   riktigt — bra byggt. Men en normal pendlare hinner på fem dagar knappt vara
   med om en enda verklig polisrapport. Man betalar inte för något man aldrig
   sett hända.
3. **Tre nivåer utan spärrar i koden.** Nivåerna är kosmetiska idag (se rutan
   överst). Att bygga rättighetsstyrning kostar utvecklingstid och skapar en
   ny sorts supportärende ("jag betalar Plus men får inte molnlagring") i en
   app vars enda jobb är att vara pålitlig.
4. **Vi lovar redan något vi inte levererar.** `js/app.js` rad 486 skriver ut
   "De 10 översta får nästa månad gratis" för varje användare. Det finns ingen
   automatik som ger den månaden — `add_paid_months` finns i
   `supabase/billing.sql` men anropas bara av Stripe-webhooken. Antingen
   automatisera eller ta bort meningen. Ett löfte i gränssnittet som inte
   infrias är dyrare än rabatten.

### Vad jag skulle mäta

Fem tal. De fyra första går att få ur `subscribers` och `payment_events` som de
ser ut idag; det femte kräver ett nytt fält.

| Mätvärde | Varför | Vad som är larm |
|---|---|---|
| Andel provanvändare som hört **minst en riktig varning** innan provet tog slut | Skiljer prisproblem från täthetsproblem — det enda talet som gör det | Under 50 % → förläng provet och jaga rapporttäthet, rör inte priset |
| Prov → betalande | Grundkonverteringen | Under 10 % |
| Uppsägning i månad 2 och 3 | Om produkten håller efter första fakturan | Över 15 %/mån |
| Nivåmix | Om nivåerna alls är en produkt | Över 80 % väljer Bas → sälj bara Bas, spara Plus/Pro |
| Uppsägningsorsak (fritext + tre kryssrutor: för dyrt / för få rapporter / använder inte) | Enda direkta signalen på om priset är fel | "för dyrt" under en tredjedel → priset är inte problemet |

Dessutom: andel som väljer förskott, och konvertering från intresseanmälan på
tillbehör till faktiskt köp (`product_interest`-tabellen samlar redan intressena
via `toggleInterest()` i `js/app.js`).

---

## 5. Vad som måste byggas, i ordning

1. **Stripe-betallänkarna.** `PAYMENT_LINKS` i `js/betalning.js` är sex tomma
   strängar. `startCheckout()` i `js/app.js` rad 2120 är redan inkopplad och
   fungerar så fort de fylls i. Inget kan säljas innan detta. Följ
   `docs/BETALNING.md` avsnitt 2–3, och glöm inte `plan`-metadata på varje pris.
2. **Låt appen få veta vilken nivå kunden köpt.** Utöka `get_subscription`
   (`supabase/KOR-ALLT.sql` rad 257) till att också returnera `plan`, och spara
   den i `Billing.state` (`js/billing.js`). Utan det här steget är alla tre
   nivåer omöjliga att upprätthålla — det är den enda hårda blockeraren.
3. **En enda rättighetsfunktion**, typ `harRattTill(funktion)`, som läser
   `perks` i `js/plans.js`. Idag läses `perks` inte av någon fil. Håll den
   liten och låt den aldrig kunna släcka en varning.
4. **Uppsägningsorsak och de fem mätvärdena.** Byggs före Plus och Pro, inte
   efter — annars vet vi inte om nivåerna ens behövs.
5. **Automatisera gratismånaden för topp 10**, eller ta bort löftet ur
   gränssnittet. Liten insats, direkt förtroendeeffekt.
6. **Tillbehörsbutik med rabatt per nivå.** Fram tills den finns är
   rabattsatserna 10/25/50 % text utan mekanism. Enklaste vägen först: en
   rabattkod per nivå i Stripe.
7. **Molnlagring av händelseklipp** — Plus bärande funktion, och den enda
   punkten på listan som är riktigt infrastrukturarbete (lagring, retention,
   radering, personuppgiftsansvar för film på andra bilister).
8. **Flera förare på ett abonnemang** (Plus).
9. **Fakturabetalning och supportkanal** (Pro) — först när första åkeriet
   frågar, inte innan.
10. **Fler regioner** — sist. Det är ny data och ny marknad, inte en nivå.

### Min rekommendation om sekvensen

Lansera med **en** nivå: Bas 99 kr, med 6- och 12-månadersförskott och hållaren
i årsupplägget. Punkt 1, 4, 5 och 6 räcker för det. Släpp Plus när molnlagringen
faktiskt finns, och Pro när ett åkeri hört av sig. Tre nivåer i prislistan innan
två av dem har innehåll är en löftesskuld, och den betalas i supportärenden.

---

*Belagt i koden är allt som är märkt FINNS IDAG med filhänvisning, plus
sifferuppgifterna ur `js/plans.js`, `docs/BETALNING.md` och `ROADMAP.md`.
Nivåindelningen, priserna i avsnitt 3, riskbedömningen och sekvensen i avsnitt 5
är min bedömning.*
