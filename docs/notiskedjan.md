# Notiskedjan — från inlägg i gruppen till notis i fickan

Den här filen är en körlista. Följ den uppifrån och ner, en gång, så ringer
telefonen när någon skriver i Facebook-gruppen. Varje steg har ett sätt att se
att det blev rätt, för det är just den kontrollen som saknats varje gång den
här kedjan gått sönder.

**Projektet:** `livvehyqowmcafnisxho` · `https://livvehyqowmcafnisxho.supabase.co`

---

## Vad som var trasigt

```
Facebook-gruppen
      │
      ▼
  bryggan läser inlägget          tools/brygg-daemon.ps1
      │
      ├──────► reports  ─────────► kartan          ✅ fungerade
      │        (rå PostgREST)
      │
      └──────► ✗ INGENTING                          ❌ telefonen tyst
```

Allt som får en telefon att ringa sitter i `fbmejl_notis_ut()`, och den
anropas bara från `fbmejl_ta_emot()`. Bryggan skrev rakt in i `reports` och
hoppade därmed över avdubblingen, nykterhetsnätet, takten **och** notisen på
en gång. Rapporten hamnade på kartan, varje led svarade 201, och ingenting
gick fel — det bara hände inget.

Så här ska det se ut när det är klart:

```
Facebook-gruppen
      │
      ▼
  bryggan läser inlägget
      │
      ▼
  fbmejl_ta_emot()      ← avdubbling · nykterhetsnät · rapport
      │
      ▼
  fbmejl_notis_ut()     ← EN notis per omgång · 10 min · tyst 23–06 · 12/dygn
      │
      ▼  pg_net
  edge-funktionen fbmejl-push
      │
      ▼  web push
  telefonen
```

Fem saker måste vara på plats. Fyra av dem är steg nedan; det femte är
bryggan själv, och det står sist.

---

## Steg 1 — kör migrationen

1. Öppna **Supabase Dashboard → SQL Editor → New query**.
2. Klistra in hela innehållet i
   `supabase/migrationer/2026-08-21-brygga-notiskedja.sql`.
3. Tryck **Run**.

**Så vet du att det blev rätt:** längst ner i svaret ska det stå

```
NOTICE:  Sjalvprovet gick igenom: meningen, platsfrasen, utrustningen och natet stammer.
```

Kommer det ett `ERROR` i stället säger felmeddelandet vilket påstående som
inte höll. Ingenting är då sönder — objekten är redan skapade och filen går
att köra om efter en rättning.

Filen går att köra om hur många gånger som helst. Den rör ingen data.

Kör sedan kontrollfrågorna längst ner i samma fil, punkt 1 till 6. Punkt 4 ska
ge **noll rader** och punkt 5 ska ge **sex rader**.

---

## Steg 2 — rulla ut edge-funktionen `fbmejl-push`

Funktionen finns i repot men har aldrig rullats ut. Utan den skickas notisen
till en adress som svarar 404, och i `fbmejl_notis_logg` står det `fel` med
`HTTP 404`.

Koden ligger i `supabase/functions/fbmejl-push/index.ts`.

### Via Dashboard (samma väg som `send-reminder` rullades ut)

1. **Dashboard → Edge Functions**.
2. Knappen **Deploy a new function → Via Editor**.
3. **Namnet måste vara exakt `fbmejl-push`.** Adressen byggs av namnet, och
   databasinställningen i steg 4 pekar på just den adressen. Ett bindestreck
   fel och kedjan är tyst igen.
4. Radera exempelkoden i editorn. Klistra in **hela**
   `supabase/functions/fbmejl-push/index.ts`.
5. Tryck **Deploy**.

   > Deploy-knappen har legat **under loggpanelen** i den här dashboarden
   > förut och gick inte att klicka. Maximera fönstret om det händer igen.

6. Öppna funktionen → **Settings** (eller kugghjulet) → slå **AV**
   `Verify JWT` / `Enforce JWT verification`.

   Varför av: funktionen har en egen dörrvakt som kräver servernyckeln i
   `Authorization`-huvudet, och den är strängare än plattformens JWT-grind —
   plattformens släpper igenom **anon-nyckeln**, som ligger öppet i appens
   källkod. Med grinden på får du dessutom 401 av två helt olika skäl som ser
   likadana ut. Samma val gjordes för `send-reminder`.

### Eller via CLI, om du hellre gör det så

```powershell
supabase functions deploy fbmejl-push --no-verify-jwt
```

**Så vet du att det blev rätt:** funktionen ska stå med i listan under
**Edge Functions** och ha en `Last deployed`-tidpunkt från idag. Ett skarpt
prov kommer i steg 5.

---

## Steg 3 — hemligheterna (`VAPID_KEYS`, `VAPID_SUBJECT`)

### Läs det här först: nycklarna finns troligen redan

Hemligheter i Supabase är **gemensamma för hela projektet**, inte per
funktion. `send-reminder` — körpåminnelsen som redan fungerar — använder
exakt samma två hemligheter, och de sattes när den rullades ut:

* nyckelparet genererades lokalt och den **publika** halvan ligger i
  `js/config.js`, raden `vapidPublicKey:`, och börjar på `BF0j2Vrm`;
* `VAPID_SUBJECT` och `VAPID_KEYS` sattes som hemligheter i samma veva, och
  hela kedjan verifierades skarpt med svaret `{"ok":true,"antal":0}`.

Är de satta behöver du **inte göra någonting i det här steget**.

> ⚠️ **Generera inga nya VAPID-nycklar.** En prenumeration är låst till den
> nyckel den skapades med. Byter du nyckelpar blir varenda befintlig
> prenumeration ogiltig på en gång — och då tystnar **körpåminnelsen** också,
> alltså det enda som får folk att öppna appen innan de kör. Priset för ett
> onödigt nyckelbyte betalas av användare som inte märker något förrän de
> saknar en varning.

### Kontrollera att de finns

**Dashboard → Edge Functions → Secrets** (i nyare dashboards:
**Project Settings → Edge Functions → Secrets**).

Du ska se två rader:

| Namn | Ska finnas | Värdet visas inte, och behöver inte visas |
|---|---|---|
| `VAPID_KEYS` | ✅ | hela JSON-objektet med `publicKey` och `privateKey` i JWK-form |
| `VAPID_SUBJECT` | ✅ | `mailto:` följt av din adress, eller en `https:`-URL |

Eller från CLI:

```powershell
supabase secrets list
```

**Står båda där: gå vidare till steg 4.**

### Bara om någon av dem SAKNAS

Då — och bara då — genereras ett nytt par. Följ `docs/NOTISER.md` avsnitt 2,
i korthet:

```powershell
deno run https://raw.githubusercontent.com/negrel/webpush/master/cmd/generate-vapid-keys.ts `
  > vapid.json 2> vapid-public.txt
```

```powershell
supabase secrets set VAPID_KEYS="$(Get-Content vapid.json -Raw)"
supabase secrets set VAPID_SUBJECT="mailto:din@adress.se"
```

Tre saker som gått fel förut och kostar en kväll var:

* `VAPID_KEYS` ska vara **hela JSON-objektet**, inte base64-strängen. Fel här
  ger `Trasiga VAPID-nycklar` och 500 direkt vid första anropet.
* `VAPID_SUBJECT` måste börja på `mailto:` eller `https:`. Chrome svarar
  annars 400.
* **`vapid.json` får aldrig in i git.** Med den kan vem som helst skicka
  notiser i appens namn.

Genererade du ett nytt par måste den publika strängen ur `vapid-public.txt`
in i `js/config.js` på raden `vapidPublicKey:`, och appen rullas ut på nytt.
Alla måste då slå på notiser igen.

---

## Steg 4 — databasinställningarna

Två inställningar. De får **aldrig** stå i klartext i ett cron-jobb —
`cron.job` är läsbar för alla med databasåtkomst och följer med i varje
backup. Därför sätts de på databasen och läses med `current_setting()`.

Öppna **SQL Editor** och kör:

```sql
alter database postgres set app.service_role_key = 'DIN_SERVICE_ROLE_NYCKEL';
alter database postgres set app.fbmejl_push_url  =
  'https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-push';
```

**Var hittar du service role-nyckeln:** Dashboard → **Project Settings → API
Keys**. Det är den som är märkt `service_role` / `secret`. Den är inte
`anon`/`publishable` — den nyckeln ligger öppet i appen och duger inte.

> **Har projektet både en `sb_secret_…`-nyckel och en gammal `eyJ…`-JWT?**
> Ta då i första hand den som visas som **service_role**. Blir det ändå 401
> när du provar i steg 5 är det de två utgåvorna som inte matchar — se
> felsökningen längst ner. Funktionen godtar numera båda, och loggar vilken
> form den fick, så felet går att se i stället för att gissas.

### Inställningar slår igenom först i NYA anslutningar

Det här är fällan i det här steget, och den ser ut som att ingenting hänt.

1. Kör de två `alter database`-raderna.
2. **Stäng SQL-editorfliken och öppna en ny.**
3. Kontrollera:

```sql
select current_setting('app.fbmejl_push_url', true)                as url,
       length(current_setting('app.service_role_key', true))       as nyckel_langd;
```

**Så vet du att det blev rätt:** `url` ska vara hela adressen, och
`nyckel_langd` ska vara ett tresiffrigt tal — inte `null` och inte `0`.

---

## Steg 5 — slå på gruppnotiser för din egen telefon

Utan minst en mottagare skickas ingenting alls, och notisloggen skriver
`ingen-mottagare`. Det är med flit: loggen ska aldrig påstå att något gick ut
när noll människor lyssnar.

1. Öppna appen på telefonen och slå på notiser om det inte redan är gjort.
2. Kör i SQL-editorn:

```sql
select public.fbmejl_gruppnotis_antal();
```

Ger den `0`, slå på gruppnotiser för din prenumeration. Enklast, om appen
ännu inte har reglaget:

```sql
update public.push_subscriptions
   set gruppnotiser = true
 where enabled
   and device_id = 'DITT_DEVICE_ID';
```

Ditt `device_id` står i appens inställningar. Kör sedan
`select public.fbmejl_gruppnotis_antal();` igen — den ska nu ge minst `1`.

### Prova utan att skicka något

```powershell
curl -X POST "https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-push" `
  -H "Authorization: Bearer DIN_SERVICE_ROLE_NYCKEL" `
  -H "Content-Type: application/json" `
  -d '{\"titel\":\"Prov\",\"text\":\"Prov\",\"dry\":true}'
```

**Så vet du att det blev rätt:** svaret ska vara

```json
{"ok":true,"dry":true,"mottagare":1,"notis":{"title":"Prov","body":"Prov","tag":"polisvakt-grupp","url":"./"}}
```

* `401 Nekad` → nyckeln stämmer inte. Se felsökningen.
* `404` → funktionen heter något annat, eller är inte utrullad. Tillbaka till
  steg 2.
* `mottagare: 0` → steg 5 är inte klart.

### Och sedan på riktigt

Kör i SQL-editorn — **en gång**, med telefonen bredvid dig:

```sql
select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
  'external_id', 'fb:test:notiskedja:1', 'type', 'police',
  'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
  'note', 'Polis står vid testplatsen',
  'device_id', 'fb-daemon',
  'created_at', (extract(epoch from now())*1000)::bigint - 3*60000,
  'expires_at', (extract(epoch from now())*1000)::bigint + 42*60000)));
```

**Så vet du att det blev rätt:** svaret innehåller `"skapade": 1` och
`"notis": {"skickad": true, ...}` — och telefonen visar inom några sekunder:

> **Polis vid Testplatsen**
> Någon i Facebook-gruppen varnade för 3 minuter sedan.

Vänta en minut och kör sedan:

```sql
select public.fbmejl_notis_stam_av();
select id, skickat_at, antal, utfall, titel, left(skal, 160)
  from public.fbmejl_notis_logg order by skickat_at desc limit 5;
```

`utfall` ska ha gått från `koad` till **`kvitterad`**, och `skal` ska bära
edge-funktionens egen räkning, till exempel
`{"ok":true,"mottagare":1,"skickade":1,"borttagna":0,"fel":0}`.

### Det viktigaste provet: drogkontrollen

En nykterhets- eller drogkontroll får inte ge en rapport, och inte heller en
notis om att "något har hänt" — det vore i praktiken samma varning. Föraren
behöver inte veta var kontrollen står för att sakta ner och ta en annan väg;
det räcker att veta att det står något.

```sql
select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
  'external_id', 'fb:test:notiskedja:2', 'type', 'police',
  'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
  'note', 'Polisen har drog-kontroll vid testplatsen',
  'device_id', 'fb-daemon',
  'created_at', (extract(epoch from now())*1000)::bigint,
  'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000)));
```

**Så vet du att det blev rätt:** `"skapade": 0`, `"vagrade": 1`, `"notis": null`
— och **ingen ny rad** i `fbmejl_notis_logg`. Telefonen ska vara helt tyst.

### Städa upp efter provet

```sql
delete from public.fbmejl_lasta where nyckel like 'fb:test:notiskedja:%';
delete from public.reports      where external_id like 'fb:test:notiskedja:%';
update public.fbmejl_notis_lage
   set senaste_at = null, antal_idag = 0, odelade = 0 where id = 1;
```

---

## Steg 6 — ställ om bryggan

Nu fungerar servern. Kvar är att bryggan slutar skriva rått och börjar anropa
`fbmejl_ta_emot()` i stället.

### Vad som måste ändras

`tools/brygg-daemon.ps1`, funktionen `Skicka-Rad` (runt rad 1131), skriver i
dag till `/rest/v1/reports?on_conflict=external_id` med **anon**-nyckeln. Den
ska i stället samla svepets rader och göra **ett** anrop till
`/rest/v1/rpc/fbmejl_ta_emot` med **service_role**-nyckeln:

```powershell
$url = $script:SupabaseUrl + '/rest/v1/rpc/fbmejl_ta_emot'
$svar = Invoke-RestMethod -Uri $url -Method Post -TimeoutSec 30 `
  -ContentType 'application/json' -Headers @{
    'apikey'        = $script:ServiceRoleNyckel
    'Authorization' = 'Bearer ' + $script:ServiceRoleNyckel
  } -Body (ConvertTo-Json @{ p_rader = @($Rader) } -Depth 8 -Compress)
```

Tre krav som inte får glida:

1. **Ett anrop per svep, inte ett per rad.** Buntspärren ger EN notis per
   anrop. Fyra separata anrop ger en notis plus tre varningar som inte hörs
   förrän tio minuter senare, och det syns ingenstans.
2. **Nyckeln får inte in i repot.** `tools/fbmejl.hemligheter.json` är redan
   gitignorerad och används redan för IMAP-lösenordet — lägg nyckeln där, i
   ett eget fält. Lägger du en ny fil måste den läggas till i `.gitignore`
   **först**. Repot är publikt.
3. **Logga svaret.** `skapade` och `notis` finns i svaret. En brygga som
   loggar de två talen märker samma dag om notiskedjan slutar fungera. Det
   gjorde ingen förut, och det är hela anledningen till att det här felet fick
   leva.

Raderna får se ut precis som i dag: `id`, `type`, `lat`, `lon`, `label`,
`note`, `device_id`, `external_id`, `created_at`, `expires_at`. `source` sätts
av servern och går inte att skicka med.

**Bonus, om det får plats:** skicka också `text_nyckel` och
`text_nyckel_grannar` (`tx:<fnv1a-hash av normaliserad text>:<tidsfack>`, se
`nycklarFor()` i `js/fbmejl.js`). Då avdubblas samma inlägg som kommer både
via mejlvägen och via bryggan till EN nål i stället för två.

### Userscriptet

`tools/fb-bridge.user.js` kör inne på facebook.com och kan **inte** bära en
servernyckel — en servernyckel i en sida Meta kontrollerar är samma sak som
ingen nyckel alls. Det får därför fortsätta skriva till `reports` och ger
**karta utan notis**. Notiserna kommer från daemonen.

### Så vet du att det blev rätt

```sql
select * from public.fbmejl_notiskedjan;
```

| vag | rapporter_dygn | genom_notiskedjan | forbi_notiskedjan | omdome |
|---|---|---|---|---|
| fb-daemon | 7 | 7 | 0 | går genom fbmejl_ta_emot |

Står det `SKRIVER FÖRBI` i `omdome` är bryggan inte omställd. Noll rader
betyder bara att inga Facebook-rapporter kommit in det senaste dygnet — det
är inte ett godkännande.

---

## Vad notisen säger

Servern bygger samma mening som appen visar, av samma delar och i samma
ordning som `sammanfattaKort()` i `js/sammanfattning.js`. Meningen delas vid
sitt eget tankstreck:

```
Polis vid Erikslund — någon i Facebook-gruppen varnade för 4 minuter sedan.
└────── titel ─────┘   └───────────────── brödtext ──────────────────────┘
```

Fyra saker är alltid med, för det är de som avgör om föraren kan handla på
uppgiften: **vad**, **var**, **när** och **varifrån**. Kommer flera varningar
i samma omgång blir det i stället

> **3 nya varningar i gruppen**
> Civil polisbil vid Hälla · Fartkontroll med laser vid E18 · Polis vid Erikslund

**Inläggets råtext når aldrig en låsskärm.** Typen är en av fyra kända
strängar, platsen är geokodningens etikett, och det enda som härleds ur
texten är `fbmejl_utrustning()`, som bara kan svara `laser`, `radar`, `fart`
eller ingenting. Skulle någon lägga till `note` i notisen har man byggt en
kanal där vem som helst i en Facebook-grupp skriver vad som helst rakt in på
en främlings låsskärm.

Meningen går att prova utan att skicka något:

```sql
select public.fbmejl_mening('police', null, 'Erikslund',
         (extract(epoch from now())*1000)::bigint - 4*60000) ->> 'mening';
```

---

## Takten

Fyra spärrar, och ingen ersätter en annan. De är oförändrade.

| Spärr | Regel | Varför |
|---|---|---|
| bunt | en notis per omgång | fyra varningar samtidigt är ett besked, inte fyra |
| gles | minst 10 minuter emellan | den som fick en notis nyss ser den nya på kartan redan |
| natt | tyst 23:00–06:00 svensk tid | en varning som väcker någon 03:00 kostar mer än den ger |
| dygn | högst 12 per dygn | slår taket i är appen inte längre kanalen |

Ingenting går tyst förlorat: varje undertryckt omgång räknas i `odelade`, och
nästa notis som får gå säger hur många varningar som kommit sedan sist.

Vill du ha andra tal sitter de som parametrar på `fbmejl_notis_ut()` just
därför — men de anropas med förval från `fbmejl_ta_emot()`, så en ändring
måste göras där.

---

## Felsökning

Börja alltid här:

```sql
select * from public.fbmejl_halsa;
select * from public.fbmejl_notiskedjan;
select id, skickat_at, antal, utfall, titel, left(skal, 160)
  from public.fbmejl_notis_logg order by skickat_at desc limit 10;
```

| Symptom | Betyder | Gör |
|---|---|---|
| `fbmejl_notiskedjan` säger `SKRIVER FÖRBI` | bryggan skriver fortfarande rått till `reports` | steg 6 |
| Loggen tom, rapporter finns | samma sak — `fbmejl_ta_emot` anropas aldrig | steg 6 |
| `utfall = ingen-mottagare` | noll prenumeranter har gruppnotiser på | steg 5 |
| `utfall = sparrad`, `skal = natt` | klockan är mellan 23 och 06 | inget fel |
| `utfall = sparrad`, `skal = for-tatt` | mindre än 10 minuter sedan förra | inget fel |
| `utfall = fel`, `skal = app.fbmejl_push_url saknas` | inställningen är inte satt, eller så läses den i en gammal anslutning | steg 4, och öppna en **ny** SQL-flik |
| `utfall = fel`, `skal = pg_net saknas` | tillägget pg_net är inte påslaget | Dashboard → Database → Extensions → `pg_net` |
| `utfall = fel` med `HTTP 404` | `fbmejl-push` är inte utrullad, eller heter fel | steg 2 |
| `utfall = fel` med `HTTP 401` | `app.service_role_key` är inte den nyckel funktionen godtar | se nedan |
| Allt står kvar som `koad` | avstämningen körs inte | `select public.fbmejl_notis_stam_av();` och kolla cron-jobbet `polisvakt-fbmejl-notisavstamning` |
| `kvitterad`, men ingen notis i luren | servern gjorde sitt; felet är i telefonen | notiser avstängda för appen i telefonens inställningar, eller batterioptimering |
| Notisen säger "Polisvakt / Dags att köra?" | fältnamnen översätts inte | edge-funktionen är en gammal version — rulla ut den igen, steg 2 |

### `HTTP 401` — de två nyckelutgåvorna

Detta är kedjans mest tidsödande fel, och det ser ut som ett behörighetsfel
när det egentligen är två utgåvor av **samma** behörighet.

Projektet har nya API-nycklar. Dashboarden visar då både en `sb_secret_…` och
en äldre `eyJ…`-JWT, och plattformen injicerar en av dem i funktionens
miljövariabel. Sätter du `app.service_role_key` till den andra svarar
funktionen 401 på varje anrop.

Funktionen godtar numera alla nycklar den känner till och **loggar formen**
när den nekar. Öppna **Dashboard → Edge Functions → fbmejl-push → Logs** och
leta efter raden som börjar `Nekat anrop.` Den säger vilken form och längd som
skickades och vilka som godtas — utan att skriva ut någon nyckel.

* **Olika form** (`eyJ` mot `sb_`): sätt `app.service_role_key` till den andra
  utgåvan.
* **Samma form, olika längd**: det är en nyckel från ett annat projekt.
* **Får du det inte att gå ihop**: sätt en egen hemlighet i stället, och peka
  databasen på den.

  ```powershell
  supabase secrets set FBMEJL_ANROPSNYCKEL="en-lang-slumpad-strang"
  ```

  ```sql
  alter database postgres set app.service_role_key = 'en-lang-slumpad-strang';
  ```

  Öppna en ny SQL-flik efteråt. Notera att `app.service_role_key` då bara
  används mot `fbmejl-push`; använder du samma inställning för andra jobb
  måste de också klara den nyckeln.

---

## Filer som hör till

| Fil | Roll |
|---|---|
| `supabase/fbmejl.sql` | hela serversidan, idempotent, kör om när som helst |
| `supabase/migrationer/2026-08-21-brygga-notiskedja.sql` | den här ändringen som delta |
| `supabase/functions/fbmejl-push/index.ts` | edge-funktionen som skickar pushen |
| `js/sammanfattning.js` | samma mening, byggd på klienten |
| `js/parser.js` | `SOBRIETY_WORDS` / `SOBRIETY_STAMMAR` — produktregeln |
| `sw.js` | push-lyssnaren som ritar notisen |
| `tools/brygg-daemon.ps1` | bryggan som läser gruppen |
| `docs/NOTISER.md` | pushkedjan i allmänhet, VAPID, körpåminnelsen |
| `docs/fbmejl.md` | mejlvägen in, kön, tolkaren |
