# Granskning: data som tappar mening i en skarv

Genomgång av hela gränsen klient ↔ server och modul ↔ modul, efter att två
buggar av samma sort hittats (`store.js` som spred `...row` utan att mappa
snake_case, och `app.js` som läste `m.namn` när chatten heter `visningsnamn`).

Familjen: **data passerar en skarv, tappar sin betydelse, och ingenting går
sönder synligt.** Servern svarar 200 eller 201, loggen är grön, appen ritar
något. Det som försvann märks bara som att appen är sämre än den behöver vara.

Metod: varje `fetch` i `js/` jämförd mot kolumn- och argumentnamnen i
`supabase/*.sql`, varje `...`-spridning som läses av en annan modul, varje
RPC-signatur, varje `localStorage`-nyckel. Kontrollerat i källan, inte gissat
utifrån namn.

**Ingen kodfil är ändrad.** Detta är enbart en granskning.

---

## A. Bekräftade fel, dyrast först

### A1. `sw.js` saknar `push`-lyssnaren — varje notis kastas tyst

* **Fil:** `sw.js` (hela filen, 131 rader). Lyssnare som finns: `install` (74),
  `activate` (89), `message` (101), `fetch` (108). Ingen `push`. Ingen
  `notificationclick`.
* **Skrivs:** `supabase/functions/send-reminder/index.ts:162–167` skickar en
  krypterad nyttolast `{title, body, tag: 'polisvakt-reminder', url: '/'}`.
* **Läses:** ingenstans. Telefonen tar emot meddelandet, dekrypterar det och
  slänger det.
* **Vad användaren märker:** ingen påminnelse kommer någonsin fram. Hela
  notiskedjan finns i övrigt och ser korrekt ut hela vägen: `js/push.js`
  prenumererar, `save_push_subscription` sparar endpoint och nycklar,
  `due_push_reminders` väljer ut mottagare, edge-funktionen får `201 Created`
  och loggar "skickad". `mark_push_sent` bränner dessutom luckan, så samma
  påminnelse kommer inte igen samma dag. Föraren ser ingenting och tror att
  hen inte slagit på notiser.
* **Extra allvarligt:** `docs/NOTISER.md` avsnitt 4 innehåller exakt den kod
  som saknas, med rubriken "Det här steget glöms bort oftast", och i
  felsökningstabellen på rad 392: *"Funktionen svarar 201, ingen notis syns →
  `push`-lyssnaren saknas i `sw.js`. Det här är det vanligaste felet av alla."*
  Den andra halvan av samma instruktion ÄR utförd: `'./js/push.js'` ligger i
  `SHELL`-listan (`sw.js:66`) och `VERSION` är bumpad. Någon läste avsnittet,
  gjorde sista stycket och hoppade över kodblocket.
* **Åtgärd:** klistra in blocket ur `docs/NOTISER.md` rad 166–200 i `sw.js`
  och bumpa `VERSION`.

### A2. `groups.invite()` returnerar `{invite:{kod}}` — `app.js` läser `r.kod`

* **Skrivs:** `js/groups.js:312–322` returnerar
  `{ ok: true, invite: { kod, visning, giltigTill, anvant, kvar, maxAnvandningar } }`.
* **Läses:** `js/app.js:908` — `$('groupStatus').textContent = \`Inbjudningskod: ${r.kod || r.code}\``.
  Varken `r.kod` eller `r.code` finns på den nivån.
* **Vad användaren märker:** ägaren trycker "Kod" och får rutan
  **"Inbjudningskod: undefined"**. Anropet lyckas, servern svarar rätt kod,
  den finns i `r.invite.kod` — och kastas i sista ledet.
* **Samma skada en gång till, i skapandet:** `js/groups.js:343–348` returnerar
  `{ok, group, code, display}` från `create()`. `js/app.js:939–941` läser bara
  `r.ok` och skriver "Gruppen är skapad." Koden som `create_group` precis
  präglade visas aldrig.
* **Sammantaget:** det finns ingen väg i appen att få ut en inbjudningskod.
  Grupper går att skapa och att gå med i om någon ger dig en kod ur SQL-editorn,
  men ingen kan bjuda in någon. Funktionen står som `status: 'done'` i
  `js/roadmap.js:107`.

### A3. `reports.group_id` skrivs aldrig av klienten — gruppflödet finns inte

* **Finns i databasen:** `supabase/grupper.sql:328` lägger till
  `reports.group_id`, med RLS-regel (`grupper.sql:349`), skrivregel
  (`:358`), index, kaskad, historikkolumn och röstspärr. Allt på serversidan
  är byggt och genomtänkt.
* **Skrivs av klienten:** ingenstans. `store.js.add()` (rad 182–240) tar inget
  gruppargument, och `#send()`-kroppen (rad 347–364) innehåller inget
  `group_id`. Sökning på `group_id`/`groupId` i `js/` ger bara `groups.js`
  egna funktionsparametrar och `dashcam.js` (som menar kameraenheter, inte
  grupper).
* **Läses av klienten:** inte heller. `reports_feed` som den ser ut efter
  `kvalitetsfalt.sql:66–72` har ingen `group_id` i kolumnlistan, och
  `dolj-enhets-id.sql:74` grant:ar inte kolumnen.
* **Vad användaren märker:** `groups.js:173` har en getter `ids` med
  kommentaren *"för den som vill lägga en rapport i en av dem"* — ingen gör
  det. `docs/GRUPPER.md:372` lovar i behörighetstabellen "Rapportera till
  gruppen ✓" för både medlem och ägare. Varje rapport ett åkeri lägger går ut
  publikt till hela länet. Det är det motsatta av vad funktionen säljs som,
  och det syns inte: rapporten kommer fram, den kommer bara fram till fel
  publik.

### A4. `reputation.refreshFromStore()` filtrerar på `device_id` som servern inte lämnar ut

* **Fil:** `js/reputation.js:56` — `if (r.device_id !== deviceId) continue;`
* **Skrivs:** `store.js.add()` sätter `device_id` lokalt (rad 193).
* **Försvinner:** `store.js.refresh()` rad 321 gör `this.reports.set(r.id, r)`
  där `r` är byggd ur en rad från `reports_feed` — en vy som med flit saknar
  `device_id` (`dolj-enhets-id.sql`). Så fort din egen rapport hunnit ett varv
  över servern (≤ 30 s, `pollMs`) skrivs den lokala kopian över och
  `device_id` blir `undefined`.
* **Vad användaren märker:** poängen fastnar. `breakdown()` visar för alltid
  0 på "Bekräftade av andra" och 0 på "Nedröstade", oavsett hur många som
  bekräftar. Poängen blir i praktiken bara `antal rapporter × 1`, och det är
  precis den poängsättning modulens egen ingress säger att den inte vill ha:
  *"Att skicka in något ger lite. Att andra bekräftar det ger mycket mer."*
  Publiceringen till topplistan (`publish_score`) skickar den felaktiga
  siffran vidare, så listan rankar på rapportmängd i stället för kvalitet.
* **Notera:** i `mode: 'local'` fungerar det, eftersom ingen serverrad skriver
  över. Felet finns bara i delat läge, alltså i det läge som faktiskt används.
* **Rätt lösning finns redan:** `store.js` exporterar `isMine(id)` (rad 83),
  byggd för exakt det här problemet — "telefonen håller själv reda på vad den
  har skickat". `reputation.js` uppdaterades inte när den infördes.

### A5. `facebook.js` skriver inga kvalitetsfält — varje Facebook-rapport nedgraderas

* **Fil:** `js/facebook.js:261–274`, raden som skickas till `reports`.
  Innehåller `id, type, lat, lon, label, note, source, device_id,
  external_id, created_at, expires_at, confirms, denials` — och slutar där.
* **Vad som fanns att skicka, i samma scope:**
  * `parsed.confidence` (rad 224) → kolumnen `parser_confidence`
  * `hit.source` från `geocode()` (rad 246), som returnerar exakt
    `'learned' | 'cache' | 'nominatim'` → kolumnen `geokod`. Det är inte en
    tillfällighet: `kvalitet.js:184–191` `GEOKOD_DELTA` har nycklarna
    `gps, karta, learned, alias, cache, nominatim, okand`. Fältet är
    konstruerat för att bära just det värdet.
  * `parsed.place` + `hit.label` → `geokod_typ` via samma gissning som
    `telegram.js:242` `gissaGeokodTyp()` gör.
* **Vad användaren märker:** `kvalitet.js:436` faller tillbaka på `'okand'`
  när `geokod` saknas → `GEOKOD_DELTA.okand = −0.15` och
  `geokodRadieM.okand = 1200 m` (`kvalitet.js:112`). 1 200 m ligger precis vid
  gränsen där en rapport hedgas eller tystas. `app.js:1376` `harledKvalitet()`
  räddar bara `source === 'app'`, aldrig `'facebook'`. Resultat: rapporter
  från Facebook-bryggan graderas systematiskt lägre än de förtjänar, formuleras
  maximalt hedgat eller läses inte upp alls. Samma inlägg som kommer in via
  Telegram-bryggan får en ärlig gradering.
* **Jämförelsen som gör det obestridligt:** `js/telegram.js:375–383` gör
  exakt det som saknas — `parser_confidence`, `fordrojning_s`,
  `geokod: punkt.source || 'okand'`, `geokod_typ: gissaGeokodTyp(...)`, och
  `gps_accuracy_m`/`fart_kmh` som `null` med en kommentar om varför NULL inte
  är noll. Facebook-vägen skrevs före `kvalitetsfalt.sql` och följde aldrig med.

### A6. `reportAt()` hårdkodar `geokod: 'gps'` även för geokodade platser

* **Fil:** `js/app.js:1604` — `geokod: 'gps'`, med kommentaren *"Telefonen
  stod på platsen. Ingen geokodning inblandad."*
* **Men samma funktion anropas med en geokodad position:**
  * `js/app.js:1630` — `reportAtPlace()` slår upp platsen med `geocode(place)`
    och skickar `hit.lat/hit.lon` vidare. Här VAR en geokodning inblandad.
  * `js/app.js:1650` — `onMapPick()`, föraren pekade på kartan. Rätt värde här
    är `'karta'`, som finns i `GEOKOD_DELTA`.
* **Vad användaren märker:** en röstrapport "polis vid Erikslund" som
  Nominatim löser till fel del av stan behandlas som om telefonen stått på
  punkten. `kvalitet.js:255–259` sätter då geokodradien till
  `MIN_OSAKERHET_M` (15 m) i stället för nominatim-radien, och
  `kvalitet.js:436` ger `+0.10` i stället för `0`. Appen säger "det står polis
  vid Erikslund, klockan 2" med full säkerhet om en punkt som kan ligga en
  kilometer fel. Det är exakt den falska precision hela `kvalitet.js` finns
  för att förhindra — modulens egen ingress kallar det "samma svek som ett
  falskt påstående, bara svårare att upptäcka".
* **Två mindre fel i samma anrop:**
  * `fordrojningS: 15` sätts även när `source === 'voice'`, trots att
    `DEFAULTS.antagenFordrojningS` (`kvalitet.js:107`) har egna, källmedvetna
    antaganden (`voice: 8`).
  * `gpsAccuracyM`/`fartKmh` hämtas ur `geo.position` — förarens egen
    noggrannhet — och sätts på en punkt som ligger någon annanstans.

### A7. `push.syncSlots()` och `push.markDroveToday()` anropas aldrig

* **Definierade:** `js/push.js:432` respektive `js/push.js:457`.
* **Anropade:** ingenstans. `js/app.js` importerar `* as Push` (rad 31) och
  använder bara `Push.configure` (rad 871). `js/behorigheter.js:334` anropar
  `push.enable()`. Inget annat.
* **Vad användaren märker:**
  * Luckorna (`slots`) laddas upp en enda gång, vid `enable()`. Ändrar du
    arbetstider vet servern det aldrig — påminnelsen kommer på gamla tider för
    alltid.
  * `markDroveToday()` är det som gör att servern hoppar över dagens lucka när
    du redan satt dig i bilen. Utan anropet plingar påminnelsen 07:15 fast du
    körde 07:05. Funktionens egen docstring säger vad det kostar: *"En
    påminnelse om något man redan gjort … lär användaren att notiserna inte är
    värda att läsa, och sen stängs de av."*
* **I dagsläget dolt bakom A1** — ingen notis kommer fram alls. Lagas A1 utan
  A7 blir den första synliga notisen fel.

### A8. `spara_kor_fonster()` anropas aldrig — `korpaminnelse.sql` matas inte

* **Finns i databasen:** `supabase/korpaminnelse.sql:161` `spara_kor_fonster`,
  `:254` `mina_kor_fonster`, `:237` `rensa_kor_fonster`, `:304`
  `due_kor_paminnelser`. `docs/korpaminnelse.md:179` beskriver kontraktet:
  *"Klienten ersätter hela sin uppsättning fönster."*
* **Anropas av klienten:** ingen av dem. `js/korvanor.js` räknar fram fönster
  (`larFonster`, `slotsFromFonster`, rad 331) och `app.js:588–624` sparar dem
  bara i `localStorage` under `pv.korvanor.v1`.
* **Vad användaren märker:** den nyare, finkorniga fönsterlogiken (spann,
  andel, nattspärr, avfärdade mönster) fungerar bara medan appen är öppen. Den
  server-drivna påminnelsen kör vidare på den grova `pv.habits.v1`-kodningen
  från `driving.js` via `push.js:214 slotsFromHabits()`. Två parallella system
  där det sämre är det som når servern. `korvanor.js:327` kommenterar t.o.m.
  att kodningen är identisk med `slotsFromHabits()` "med flit" — bron byggdes,
  men ingen går över den.

### A9. `subscribers.plan` läses aldrig av klienten, `PLANS[].perks` läses aldrig alls

* **Skrivs:** `supabase/billing.sql:29` lägger till `subscribers.plan`.
  `set_paid_until` (`:253`) och `add_paid_months` (`:297`) fyller den.
  `supabase/stripe.sql:236 stripe_plan_for_amount()` härleder nivån ur
  betalningens belopp, matchat mot de sex priserna i `js/plans.js`.
* **Läses:** `get_subscription(p_device)` (`schema.sql:222`) returnerar
  `table (trial_start timestamptz, paid_until timestamptz)` — plan ingår inte.
  `js/billing.js:100–107` läser bara de två datumen.
* **Och i klienten:** `js/plans.js` definierar `perks: {dashcamMinutes,
  coverage, history, accessoryDiscount, cloud}` för alla tre nivåerna.
  Sökning på `perks` i hela `js/` ger bara definitionerna. Ingen läser dem.
  `settings.plan` (`app.js:2137`) är bara vilket kort användaren senast
  klickade på, inte vad hen betalat för.
* **Vad användaren märker:** Bas, Plus och Pro ger identisk app. Den som
  betalar 199 kr/mån får samma sak som den som betalar 99.
* **Ärlig reservation:** `ROADMAP.md:51` har `❓ **Nivåer** — 99 / 149 / 199 kr.
  Vad ska ligga i varje?` som ett öppet beslut. Det här är därför troligen en
  ofärdig funktion snarare än en regression — men serversidan är redan
  färdigbyggd och skriver data som klienten inte kan se, vilket är samma skarv.

### A10. `bedomFlodet()` får aldrig någon `historik` — hela rapportörshistoriken är död kod

* **Läses:** `js/kvalitet.js:388` — `slaUppHistorik(kontext.historik, rapport.device_id)`.
* **Skickas:** `js/app.js:1396–1399` anropar
  `Kvalitet.bedomFlodet(..., { nu, minaId })`. Ingen `historik`. Det är enda
  anropet i hela kodbasen.
* **Vad användaren märker:** poängblocket på rad 377–406 — det som ska hedga
  rapporter från någon vars rapporter regelbundet röstas ner — kör aldrig.
  Varje rapport får i stället flaggan `rapportor-anonym` (rad 406), eftersom
  `device_id` dessutom saknas efter A4:s mekanism. Två oberoende orsaker till
  samma tystnad.
* **Sammanhang:** `stats.js:76 syncFromServer()` hämtar `report_history`, men
  den tabellen innehåller med flit inte `device_id` (`schema.sql:294`), så den
  kan inte fylla rollen. Det finns i dag ingen datakälla för `kontext.historik`.
  Antingen ska blocket matas från en ny källa, eller så ska det tas bort — som
  det står nu läser man kod som ser ut att göra något den aldrig gör.

### A11. Uppmätt GPS-noggrannhet kastas när `watchPosition` inte hunnit svara

* **Skrivs:** `js/geo.js:112` — `currentPosition()` returnerar
  `{lat, lon, accuracy}`.
* **Läses:** `js/app.js:1583` — `const nufix = geo.position;` och sedan
  `gpsAccuracyM: Number.isFinite(nufix?.accuracy) ? ... : null`. När `pos` kom
  från `currentPosition()` (rad 1570, alltså när `geo.position` var `null`) är
  `nufix` fortfarande `null`. `pos.accuracy` finns och läses aldrig.
* **Vad användaren märker:** vid kallstart — appen precis öppnad, ingen
  löpande GPS-fix än — går rapporten iväg med `gps_accuracy_m = null`.
  `kvalitet.js:114` antar då 25 m. Är den verkliga noggrannheten 80 m
  underskattar appen sin osäkerhet och låter säkrare än den är, i precis det
  ögonblick den har minst skäl att göra det. Litet fel, men åt fel håll.

---

## B. Misstänkta — ser fel ut, kunde inte beläggas utan levande databas

### B1. `facebook.js` ber om `return=representation` mot en tabell utan full SELECT

`js/facebook.js:110–117` skickar `Prefer: resolution=ignore-duplicates,return=representation`
mot `/rest/v1/reports`. PostgREST bygger då en `INSERT … RETURNING *`, och
`RETURNING *` kräver SELECT-rätt på **varje** kolumn. `dolj-enhets-id.sql:69`
återkallar SELECT på hela `reports` och delar ut den kolumn för kolumn — utan
`device_id`. `grupper.sql:328` lägger dessutom till `group_id` utan att
grant:a den (kolumnrättigheter ärvs inte).

Det talar för att varje Facebook-insert svarar `permission denied` i stället
för att skrivas. Men `insertReport()` använder tomt svar som signal för
"fanns redan", så ett fel här skulle bli `summary.skipped.failed++` — synligt
bara i den som läser sammanfattningen.

**Kunde inte verifieras**: kräver ett anrop mot den skarpa databasen som anon.
Prova med `curl` mot `/rest/v1/reports` med `Prefer: return=representation`
och en giltig rad. Om det faller: byt till `return=minimal` och avgör
dubbletter på HTTP-status i stället.

### B2. Klusterledaren kan tappa ruttmatchningen

`js/app.js:1401` skickar klustrets **ledare** vidare, med klustrets viktade
`lat`/`lon`. `js/rutt.js:873–884 filterHazards()` slår upp `ahead.get(h.id)`
i en karta byggd ur `this.store.active()` — alltså råa rapporter med sina
egna positioner. Ligger ledaren 300 m utanför korridoren men en annan
klustermedlem på vägen, faller hela klustret bort och föraren varnas inte.

Konstruerat men inte omöjligt. Kunde inte belägga att det inträffar i praktiken
utan riktiga rapportmängder.

### B3. Egen rapport kan sluta räknas som egen efter klustring

Samma rad, `app.js:1401`. `renderHazards()` (`:1451`) och
`engine.state.set(r.id, …)` (`:1618`) identifierar "min rapport" på `id`. Blir
någon annans rapport klusterledare byter faran id, och både
undertryckningen av egen varning och markeringen i listan slutar gälla.
`grupperaRapporter()` sorterar på lägst osäkerhet först
(`kvalitet.js:786`), så en färsk egen rapport med `geokod: 'gps'` blir nästan
alltid ledare — men "nästan alltid" är inte "alltid".

### B4. `GEOKOD_DELTA.alias` går inte att nå

`kvalitet.js:188` har `alias: 0.02`. `geocode.js:131 remember()` stämplar
varje träff som `'nominatim'`, även den som gick via aliaslistan
(`geocode.js:106–109`). En uppslagning genom den kurerade aliaslistan — som
är mer tillförlitlig än en rå sökning — graderas alltså som en rå sökning.
Konsekvensen är 2 poängs skillnad, alltså liten. Men värdet är dött och det
är värt att antingen sätta `source: 'alias'` i alias-grenen eller ta bort
nyckeln, så nästa läsare inte tror den används.

### B5. `via === 'ratt' ? 'app' : 'app'`

`js/app.js:371`. En ternär där båda grenarna ger samma värde. Antingen skulle
rattknappen ha en egen källa (och då saknas den i `BAS_KALLA`), eller så är
det en kvarleva. Ingen konsekvens i dag — men det är en rad som ser ut att
skilja på något den inte skiljer på.

---

## C. Kontrollerat och funnet korrekt

Detta behöver inte granskas om.

**Kolumn- och argumentnamn som stämmer exakt:**

| Anrop | Fil | Motpart |
|---|---|---|
| `chatt_flode` `select=*` → `#franRad` | `chatt.js:548, 630–638` | `chatt.sql:434–443` — `id, skapad_at, text, visningsnamn, avsandarnyckel, mitt` stämmer alla sex |
| `chatt_meddelanden` insert | `chatt.js:669–680` | `chatt.sql:215–225` |
| `chatt_anmalningar` insert | `chatt.js:693–701` | `chatt.sql:445–449` |
| `save_push_subscription` | `push.js:270` | `push.sql:141–147` — sex argument, alla rätt |
| `set_push_slots`, `mark_drove_today`, `delete_push_subscription` | `push.js:440, 467, 391` | `push.sql:193, 218, 234` |
| `due_push_reminders` → `type Prenumeration` | `send-reminder/index.ts:112–119` | `push.sql:287–293` — sex fält, samma namn |
| `username_available`, `claim_username`, `email_for_login` | `auth.js:231, 245, 283` | `anvandarnamn.sql:106, 130, 175` — även returkoderna `ok/upptaget/ogiltigt/inte_inloggad` |
| `my_groups`, `group_members_list`, `group_invite`, `create_group`, `join_group`, `rotate_group_invite`, `rename_group`, `remove_group_member`, `transfer_group_ownership`, `leave_group`, `delete_group` | `groups.js:264–473` | `grupper.sql:480–790` — samtliga argumentnamn och returfält stämmer, inklusive `kod / giltig_till / anvant / max_anvandningar` |
| `get_subscription`, `redeem_code` | `billing.js:95, 144` | `schema.sql:222, 246` |
| `subscribers` upsert | `billing.js:120–131` | `schema.sql:188–195` |
| `leaderboard` `select=rank,nickname,score,reports` | `reputation.js:122` | `schema.sql:353–363` |
| `publish_score` | `reputation.js:96` | `schema.sql:162–163` — fem argument |
| `report_history` `select=type,lat,lon,created_at,label` | `stats.js:81` | `schema.sql:297–304` |
| `product_interest` insert | `app.js:2211–2214` | `schema.sql:399–404` |
| `telegram_ta_emot` radformat | `telegram.js:355–397` | `telegram.sql:179–256` — inklusive de tre fält som *inte* är kolumner i `reports` (`text_nyckel`, `chat_id`, `message_id`) och som funktionen plockar ur JSON:en |

**Skarvar som är rätt av avsikt, inte av tur:**

* `kvalitet.js` hanterar saknad `device_id` explicit och dokumenterat
  (`:377–406` och `:643–651`). Rapporten räknas ändå som stöd, men
  `oberoendeOkant` sänker taket på bonusen. Det är en medveten avvägning, inte
  en glömd `undefined`. Notera dock att `undefined === undefined` på rad 666
  gör att grenen aldrig nås — det spelar ingen roll här eftersom
  `if (g.device_id)` på rad 665 redan sållat bort fallet.
* `store.js:311–317` mappar nu snake_case → camelCase via `kvalitetFranRad()`
  och behåller samtidigt `...row`, så båda skrivsätten finns på objektet.
  Ingen konsument bryts av det.
* `notiser.js:330–341 tolkaNiva()` tar hand om gammalt sparat format: `true`
  blir `'rost'`, `false` blir `'av'`. En uppdatering över en boolesk
  inställning tolkas alltså inte fel. `plockaKarta()` (`:311`) skyddar
  dessutom mot att hela `settings` misstolkas som en nivåkarta.
* `app.js:96` `settings = {...defaults, ...readJSON(SETTINGS_KEY, {})}` —
  ytlig sammanslagning, men inget default-värde är ett objekt utom `notiser`,
  som notiser.js hanterar själv.
* `pv.learned.v1` skrivs av `geocode.js:82` som `{nyckel: {lat, lon, label,
  learnedAt}}` och läses av `voice.js:352`, som bara itererar nycklarna.
  Formaten är förenliga.
* Övriga `localStorage`-nycklar (28 st, alla med `pv.`-prefix) skrivs och läses
  av en enda modul var. Inga korsläsningar utöver `pv.learned.v1`,
  `pv.korvanor.v1`/`pv.korningar.v1` (app.js ↔ korvanor.js, samma
  `toJSON()`/`fran()`-par) och `pv.habits.v1` (driving.js → push.js, samma
  `"dag-timme" → antal`-form). Alla `.v1`-suffixade, inga blandade generationer.
* `data/cameras.json` → `app.js:250–258`: `id, lat, lon, name, bearing,
  speedLimit` läses alla, och `name || road` täcker båda varianterna i filen.
* `store.js:303–307` faller tillbaka på tabellen `reports` bara vid HTTP 404.
  Efter `dolj-enhets-id.sql` ger `select=*` mot tabellen `permission denied`
  (403), inte 404 — så reservvägen är i praktiken död. Det är avsiktligt och
  står i filens egen kommentar: den ska "tystna i stället för att läcka".
* `chatt.js` konfigureras med `identitet`/`visningsnamn` först i
  `app.js:3263`, efter inloggning — inte i konstruktorn på rad 118. Det ser ut
  som en glömd parameter men är rätt ordning.
* `grupper.sql:385–386` sätter `security_invoker = on` på både `reports_active`
  och `reports_feed`, och `kvalitetsfalt.sql:67` behåller den när vyn skrivs
  om. Privata grupprapporter läcker alltså inte genom vyn.
* `m.namn` → `m.visningsnamn` är lagad. `app.js:3047` och `:3189` läser båda
  `m.visningsnamn` med `|| 'Förare'` som reserv.

---

## D. Testerna som saknas för att fånga familjen automatiskt

Det befintliga `test.html` har redan två bra tester i den här riktningen —
`'REGRESSIONEN PÅ LÄSVÄGEN: serverns snake_case blir camelCase'` (rad 170) och
`'store.add sätter kvalitetsfälten'` (rad 158). Båda är exempel på rätt idé.
Det som fattas är att göra idén uttömmande i stället för punktvis.

### D1. Kontraktstest per skarv, genererat ur en enda lista

Det första testet fångade bara `geokod` av en slump — det var det enda fältet
som hette likadant på båda sidor. Ett test som räknar upp fälten för hand
missar nästa fält som läggs till.

Skriv i stället **en** tabell över varje skarv:

```js
const SKARVAR = [
  { vy: 'reports_feed', kolumner: [...], las: kvalitetFranRad, forvantat: [...] },
  { vy: 'chatt_flode',  kolumner: [...], las: chattFranRad,    forvantat: [...] },
  { rpc: 'group_invite', returnerar: ['kod','giltig_till','anvant','max_anvandningar'],
    las: groups.invite, forvantat: ['kod','visning','giltigTill','anvant','kvar','maxAnvandningar'] },
  …
];
```

och låt testet mata varje mottagarfunktion en syntetisk rad där **varje**
kolumn har ett unikt, igenkännbart värde (`'__gps_accuracy_m__'`,
`'__visningsnamn__'`). Kravet: efter översättningen finns varje sådant värde
någonstans i resultatet. Ett fält som tappas bort blir då ett rött test, inte
en tystare app. Det här hade fångat både de två kända buggarna och A2.

### D2. Kolumnlistan i testet måste komma från SQL-filen, inte skrivas av

Läs `supabase/kvalitetsfalt.sql` och `supabase/chatt.sql` som text i testet och
plocka ut kolumnlistan i `create … view` med ett reguljärt uttryck. Jämför mot
`SKARVAR`. Då blir en ny kolumn i SQL:en som ingen mappat ett testfel samma
dag den läggs till — vilket är hela orsaken till att A5 kunde uppstå.

### D3. "Skrivs men läses aldrig" och "läses men skrivs aldrig"

Ett statiskt test över `js/`:

* varje kolumn i `reports`-insertarna (`store.js`, `facebook.js`,
  `telegram.js`) ska finnas i minst en av kolumnlistorna i SQL-filerna
* varje kolumn i `reports_feed` ska läsas av minst en modul
* varje `p_*`-argument i en `create … function` ska antingen skickas av en
  klientmodul eller stå på en dokumenterad undantagslista (`due_push_reminders`
  och `mark_push_sent` anropas bara av edge-funktionen, `monthly_winners`
  bara i SQL-editorn)

Det här hade fångat A3, A8 och A9 direkt, och pekat på A1 indirekt.

### D4. Exporterad-men-oanropad-funktion

Enkelt och billigt: för varje `export function` i `js/`, sök efter minst ett
anrop utanför den egna filen eller ett test som täcker den. `syncSlots` och
`markDroveToday` (A7) hade båda flaggats. Undantagslista för det som är
avsiktligt publikt API.

### D5. Ett test på `sw.js` som helt enkelt letar efter lyssnarna

```js
await T('service workern fångar push', async () =>
  /addEventListener\(\s*'push'/.test(swSrc) || 'sw.js saknar push-lyssnaren');
await T('service workern hanterar klick på notisen', async () =>
  /addEventListener\(\s*'notificationclick'/.test(swSrc) || 'saknas');
```

Trivialt, fångar A1, och är precis den sortens kontroll `test.html` redan gör
för `index.html`-markup (rad 285, 379).

### D6. Ett test som graderar en rapport från varje ingångsväg

`app.js`-knappen, röst med geokodning, kartpekning, Facebook-bryggan,
Telegram-bryggan. Kör var och en genom `bedomRapport()` och kräv att
`bedomning.behandling` blir det som är rimligt för vägen — och att inga två
vägar som borde vara likvärdiga hamnar olika. A5 (Facebook tystas) och A6
(röstrapport får falsk precision) hade båda fallit ut ur ett sådant test, för
de yttrar sig som att två vägar som ska ge samma svar ger olika.

### D7. En rundtur genom lagringen

Skapa en rapport, skriv den, läs tillbaka en serversvarsliknande rad, kör
`refresh()`, och kontrollera att varje fält som gick in kan läsas ut igen —
eller att det står uttryckligen i en lista över fält som *ska* försvinna
(`device_id`, av integritetsskäl). A4 är precis ett fält som föll ur den listan
utan att någon konsument uppdaterades.

---

*Granskad 2026-08-20. Ingen kodfil ändrad.*
