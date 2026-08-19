# Privata grupper — åkerier, trafikskolor och kompisgäng

Ett åkeri med femton bilar vill att förarna ser varandras rapporter utan att
varenda varning går ut till hela Västmanland. Samtidigt vill de ha kvar det
publika flödet — polisen på E18 är intressant oavsett vem som såg den.

Lösningen: en rapport får en **frivillig grupp**. Den som är inloggad ser
**unionen** av det publika flödet och varje grupp hen är med i. Ingen
inställning att växla mellan, ingen "gruppvy" — bara ett flöde som råkar
innehålla lite mer för den som hör hemma i en grupp.

Räkna med **15 minuter** för att köra igång det.

Läs **avsnitt 8 och 9** innan du bygger UI kring det här. Där står vad som
faktiskt händer när en kod läcker och när en förare slutar, och båda svaren är
mindre bekväma än man skulle tro.

---

## Så hänger det ihop

```
Klienten                     Databasen                     Effekten
────────                     ─────────                     ────────
js/groups.js
  create_group("Åkeriet") ─▶ groups           ┐
                             group_members     ├─ ägare + första medlem
                             group_invites     ┘  + färdig kod
       ← { kod: "7K3M9…" }

  ...koden delas ut i förarnas WhatsApp-grupp...

  join_group("7K3M9…")   ─▶ kollar: revoked? utgången? slut?
                             full? spärrad efter för många missar?
                             ─▶ group_members (raden skrivs av SERVERN)

js/store.js (orörd)
  GET /reports_feed      ─▶ radsäkerhetsregeln reports_read:
                             group_id is null            ← publikt
                             or is_group_member(group_id) ← mina grupper
       ← unionen                                          Allt annat finns
                                                          inte, sett utifrån.
```

Det som är värt att förstå direkt: **`js/store.js` vet inte att grupper
finns.** Den frågar precis som förut och får tillbaka det den får se.
Filtreringen sitter i radsäkerheten, en gång, på servern. Det är därför
`js/groups.js` inte filtrerar någonting — se kommentaren överst i den filen
innan du frestas att lägga till ett filter "för säkerhets skull".

---

## 1. Datamodellen

### `groups`

| Kolumn | Typ | Not |
|---|---|---|
| `id` | uuid | Slumpat, aldrig löpnummer |
| `name` | text | 2–60 tecken |
| `kind` | text | `akeri` · `trafikskola` · `vanner` · `ovrigt` |
| `owner_id` | uuid → `auth.users` | `on delete cascade` |
| `member_limit` | int | 2–500, standard 50 |

`kind` styr ingenting tekniskt. Den finns för att vi ska kunna se vad
funktionen faktiskt används till innan vi bygger vidare på den.

`owner_id` kaskaderar med flit. Raderas kontot försvinner gruppen, medlemskapen
och gruppens rapporter. En grupp utan ägare går inte att administrera, och en
föräldralös privat grupp som ligger kvar är sämre än ingen grupp alls.

### `group_members`

| Kolumn | Typ | Not |
|---|---|---|
| `group_id` + `user_id` | uuid | Primärnyckel |
| `handle` | uuid | **Medlemmens id utåt.** Slumpat, unikt |
| `nickname` | text | Max 20 tecken, standard "Medlem" |
| `role` | text | `owner` · `member` |

**Handtaget är viktigt.** Ägaren måste kunna peka ut vem som ska tas bort, men
får inte se `user_id`: för inloggade är det exakt samma sträng som `device_id` i
rapporttabellen, och den som har den kan koppla rapporter till person.
Handtaget är slumpat, betyder ingenting någon annanstans i systemet och duger
utmärkt som "den där raden".

Ett partiellt unikt index (`group_one_owner_idx`) garanterar **exakt en
ägarrad per grupp**. Utan det kan ett avbrutet ägarbyte lämna två efter sig.

### `group_invites`

| Kolumn | Not |
|---|---|
| `code` | Primärnyckel, tio tecken |
| `expires_at` | Hårt, kollas i `join_group` |
| `max_uses` / `uses` | Hårt, kollas i `join_group` |
| `revoked` | Sätts av `rotate_group_invite` |
| `last_used_at` | När koden senast löstes in |

### `reports.group_id` och `report_history.group_id`

`null` = publik, precis som allt som fanns innan.

På `reports` är den en främmande nyckel med **`on delete cascade`, inte
`set null`**. Raderas gruppen ska dess rapporter försvinna, inte plötsligt bli
publika. En rapport som byter från privat till synlig-för-alla utan att någon
bett om det är precis det den här funktionen finns för att förhindra.

På `report_history` finns ingen främmande nyckel — historiken ska överleva att
en grupp tas bort. Raden blir då osynlig för alla, vilket är rätt håll att
fela åt.

Att historiken alls fick kolumnen är lätt att missa: triggern `reports_archive`
kopierar varje ny rapport dit, och den tabellen hade en läsregel med
`using (true)`. Utan kolumnen hade åkeriets privata positioner hamnat i den
publika mönsterkartan inom en sekund, med rätt tid och plats.

---

## 2. Tre saker som skiljer sig från resten av schemat

**1. Grupper kräver konto.** Resten av appen litar på ett slumpat `device_id`,
vilket räcker för en varningstjänst där allt ändå är publikt. Här går det inte:
ett enhets-id ligger i klartext i klienten och går att hitta på. Kunde man äga
en grupp med ett `device_id` kunde vem som helst påstå sig vara ägaren och
kasta ut åkeriets förare. Allt går på `auth.uid()`, aldrig på `public.actor()`.

**2. Grupptabellerna har radsäkerhet påslagen och noll policies.** De är helt
stängda, som `push_subscriptions`. Kravet är att en utomstående inte ens ska
kunna se **att** en grupp finns eller hur många som är med. En läsregel, hur
snäv den än är, svarar alltid på frågan "finns raden?" med ett tomt eller
icke-tomt svar, och antalet läcker genom `count`. Är tabellen stängd finns
ingen sådan kanal alls.

**3. Medlemskap skapas aldrig av klienten.** `join_group` tar en kod och
skriver raden själv. Fick klienten göra `insert` vore koden bara dekoration —
man hade kunnat lägga till sig i vilken grupp som helst genom att gissa ett
grupp-id.

---

## 3. Så fungerar inbjudningar

En kod är **tio tecken ur ett alfabet på 32** — Crockfords base32: siffror och
versaler utan I, L, O och U. De tre första för att de går att förväxla med
ettor och nollor när koden läses upp i telefon, U för att slumpen inte ska
stava något olämpligt. Det ger **50 bitars entropi**.

Koden slumpas med `gen_random_bytes`, inte `random()`. `random()` är en
pseudoslumpgenerator som går att förutsäga om man känner till tillståndet, och
en förutsägbar inbjudningskod är samma sak som ingen kod alls. 256 delat med 32
går jämnt ut, så modulon snedvrider inte fördelningen.

### Vad som kontrolleras, och var

| Kontroll | Standard | Var |
|---|---|---|
| Koden finns och är inte återkallad | — | `join_group` |
| Utgångsdatum | 14 dagar, max 365 | `join_group` |
| Användningstak | 25, max 500 | `join_group` |
| Medlemstak i gruppen | 50 | `join_group` |
| Max antal grupper man äger | 10 | `create_group` |
| Max antal medlemskap | 25 | `join_group` |
| Spärr mot kodgissning | 10 missar/timme → 1 timmes vila | `join_group` |

**Allt i tabellen sker på servern.** Det som står i `js/groups.js` är hjälptext
och ett sparat anrop, inte skydd. Klienten kollar att koden är tio tecken innan
den skickar — det är för att den som klistrat in halva koden inte ska bränna en
miss mot spärren, ingenting annat.

### Två svar som är avsiktligt otydliga

- **Okänd kod och återkallad kod ger samma svar** (`ogiltig`). Att skilja dem åt
  hade berättat för den som testar en gammal läckt kod att gruppen finns kvar.
- **Redan medlem ger `ok` utan att bränna en användning.** Annars äter en förare
  som trycker på länken två gånger upp koden för någon annan.

### Spärren

Att gissa sig till en fungerande kod är inte ett realistiskt hot vid 50 bitar.
Spärren finns för det som faktiskt går att göra: sitta och pröva tusentals
koder i följd för att kartlägga vilka som finns. Fönstret är rullande en timme:
har första missen passerat börjar räkningen om, så den som skriver fel en gång
i månaden aldrig blir spärrad.

---

## 4. Exakt vad en medlem ser — och inte ser

### Ser

| | Via |
|---|---|
| Gruppens rapporter, blandat i det vanliga flödet | radsäkerhet på `reports` |
| Gruppens historik i mönsterkartan | radsäkerhet på `report_history` |
| Gruppens namn, typ, sin egen roll, medlemsantal | `my_groups()` |
| Medlemslistan: **handtag, smeknamn, roll, när de gick med** | `group_members_list()` |

### Ser inte

| | Varför |
|---|---|
| **Andra medlemmars `user_id`** | Samma sträng som `device_id` i rapportflödet → rapport kan kopplas till person |
| **Andra medlemmars e-post** | Ligger i `auth.users` och stannar där. Ingen funktion och ingen vy rör den tabellen |
| **Inbjudningskoden** | `group_invite()` kräver ägare. En medlem ska inte kunna bjuda in |
| **Vem som är ägare av en grupp man inte är med i** | Tabellerna är stängda |
| **Rapporter från grupper man inte är med i** | Radsäkerheten. De finns inte, sett utifrån |

### En utomstående ser ingenting alls

Inte att gruppen finns, inte hur många som är med, inte vad den heter. Det enda
observerbara är att `join_group` med en felaktig kod svarar `ogiltig` — vilket
den gör oavsett om koden aldrig funnits, är återkallad eller hör till en grupp
som raderats.

### Vad ägaren ser utöver det

Inbjudningskoden, dess utgångsdatum och hur många gånger den använts. Inget mer
— ägaren ser **inte heller** medlemmarnas konto-id eller e-post.

---

## 5. Kör SQL:en

**Ordningen spelar roll. `grupper.sql` ska köras SIST.**

```
1. supabase/schema.sql
2. supabase/billing.sql · push.sql · facebook.sql   (om de används)
3. supabase/grupper.sql   ← sist
```

`grupper.sql` skriver över fyra saker från `schema.sql`: policyerna
`reports_read`, `reports_insert` och `history_read`, samt funktionen
`archive_report()`. Kör du `schema.sql` igen efteråt återställs originalen — och
då blir varje grupps rapporter publika, och historiken börjar läcka positioner
samma sekund. Det ger inget felmeddelande och syns inte i appen. **Kör om
`grupper.sql` direkt efter varje körning av `schema.sql`.**

Filen går att köra om hur många gånger som helst. Öppna Supabase → SQL Editor,
klistra in hela filen, kör.

### Verifiera efteråt

Det viktigaste testet, som fångar exakt den bugg som fanns i filen tidigare —
`anon` ska inte kunna anropa någonting:

```sql
select p.proname,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as inloggad
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_group','join_group','my_groups','group_members_list',
                    'group_invite','rotate_group_invite','rename_group',
                    'remove_group_member','transfer_group_ownership',
                    'leave_group','delete_group','mint_invite_code',
                    'note_join_miss','new_invite_code',
                    'is_group_member','is_group_owner')
order by 1;
```

Förväntat: `anon` är **false** överallt utom `is_group_member` och
`is_group_owner`. De två utvärderas inne i radsäkerhetsreglerna, och de reglerna
körs som den som frågar — även en utloggad läsare måste alltså få EXECUTE.
Funktionerna svarar `false` när `auth.uid()` är tom, men utan grant blir det
"permission denied" och hela det publika flödet slutar fungera för utloggade.

`inloggad` ska vara true för klientfunktionerna och **false** för de tre
interna: `mint_invite_code`, `note_join_miss`, `new_invite_code`. Att de blir
oanropbara utifrån stör inte funktionerna som använder dem — en SECURITY
DEFINER-funktion körs som sin ägare, och ägaren är `postgres`, som äger även
hjälpfunktionerna.

> Varför just det här testet: Postgres delar ut EXECUTE på varje ny funktion
> till rollen **PUBLIC**, och PUBLIC är inte en roll man är medlem i utan
> "alla, alltid". Ett `revoke execute … from anon` tar bort Supabases egen
> standardrättighet men lämnar PUBLIC-grantet orört, så funktionen är
> fortfarande anropbar av anon. Det ser rätt ut, det ger inget felmeddelande,
> och skyddet finns inte. Enda formen som stänger en funktion är
> `revoke all on function … from public` **före** grantet.

Att varje SECURITY DEFINER-funktion har en egen `search_path` — en funktion
utan är öppen för att luras att köra fel tabell:

```sql
select proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and (p.proconfig is null or not p.proconfig::text like '%search_path%');
```

Förväntat: **noll rader**.

Att vyerna över `reports` inte läser förbi radsäkerheten:

```sql
select c.relname, c.reloptions
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and c.relname in ('reports_active','reports_feed','group_health');
```

Förväntat: varje vy som dyker upp har `security_invoker=on`. En vy körs annars
med sin ägares rättigheter, och ägaren är `postgres` — hela skyddet hade läckt
ut genom en vy ingen tänkte på.

`reports_feed` saknas troligen i resultatet, och det är väntat: den vyn skapas
inte av något SQL i repot än. `js/store.js` frågar efter den först och faller
tillbaka på tabellen `reports` när den svarar 404. Gruppskyddet påverkas inte —
radsäkerheten sitter på tabellen — men `device_id` följer med i flödet tills vyn
finns. `alter view if exists` här är ofarlig när vyn saknas och gör rätt den dag
någon lägger till den.

**Lägger du till en ny vy över `reports`: sätt `security_invoker = on`**, annars
är den privata gruppen publik igen.

### Om appen säger "Grupper är inte påslagna i den här installationen än"

Då svarar PostgREST 404 på funktionsanropen. Nästan alltid är SQL:en inte körd.
Är den körd har schemacachen inte laddats om:

```sql
notify pgrst, 'reload schema';
```

---

## 6. Klienten

`js/groups.js` exporterar en `Groups`-klass som inte rör DOM:en. Den skickar
`change` när grupplistan ändrats och `status` när en hämtning börjar eller
misslyckas.

| Metod | Gör |
|---|---|
| `refresh()` | Hämtar mina grupper, cachar dem lokalt |
| `create(namn, typ, smeknamn)` | Skapar grupp, returnerar `{ code, display }` |
| `join(kod, smeknamn)` | Går med. Städar koden först |
| `leave(id)` | Lämnar. `{ deleted: true }` om gruppen togs bort |
| `members(id)` | Medlemslistan med handtag |
| `invite(id)` | Ägarens kod, `{ invite: null }` om ingen giltig finns |
| `rotateInvite(id, { days, maxUses })` | Ny kod, alla gamla återkallas |
| `rename(id, namn)` · `remove(id)` | Ägaråtgärder |
| `removeMember(handtag)` · `transferOwnership(handtag)` | Ägaråtgärder |

Allt svarar `{ ok: true, … }` eller `{ ok: false, error: 'svensk text' }`, som
`js/auth.js`. Databasfunktionerna returnerar korta statuskoder i stället för att
kasta undantag, och `js/groups.js` har översättningarna — en förare ska aldrig
behöva läsa en Postgres-felsträng.

**Omtag görs bara på läsningar.** Att göra om ett `join_group` som kanske gick
igenom är ofarligt, men samma resonemang håller inte för `rotate_group_invite`:
ett omtag som råkar lyckas två gånger ger ägaren en kod hen redan hunnit skicka
ut i fel version. Skrivningar körs en gång och får ett ärligt felmeddelande.

**Koden städas på två ställen med flit.** `normalizeCode()` i klienten och
`clean_invite_code()` i databasen gör samma sak: bort med bindestreck och
mellanslag, upp till versaler, och O tolkas som nolla medan I och L blir ettor.
Servern måste göra det för att inte avvisa hederligt folk som skrivit av koden
från ett papper; klienten gör det för att kunna säga "koden är för kort" innan
anropet går iväg. **Ändras den ena måste den andra ändras med.**

---

## 7. Vem får göra vad

| | Medlem | Ägare |
|---|---|---|
| Läsa gruppens rapporter | ✓ | ✓ |
| Rapportera till gruppen | ✓ | ✓ |
| Se medlemslistan | ✓ | ✓ |
| Se inbjudningskoden | — | ✓ |
| Byta kod | — | ✓ |
| Byta namn på gruppen | — | ✓ |
| Kasta ut en medlem | — | ✓ |
| Ta bort gruppen | — | ✓ |
| Lämna gruppen | ✓ | Bara om ensam kvar |

**Ägaren kan inte lämna medan andra är kvar.** `leave_group` svarar
`agare_kvar`, och `remove_group_member` vägrar ta bort en rad med rollen
`owner`. Vägen ut är `transferOwnership()` — utan den hade regeln låst in ägaren
för alltid. Är ägaren ensam kvar tas gruppen bort i stället, för en tom grupp
med en levande inbjudningskod är bara en läcka som väntar.

---

## 8. När en kod läcker

En kod hamnar i fel WhatsApp-grupp, i ett skärmklipp på Facebook, eller hos en
förare som slutat på dålig fot. Så här ser återställningen ut — och vad den
inte fixar.

### Gör så här

**1. Byt kod.** `rotateInvite(gruppId)`. Alla gamla koder för gruppen återkallas
i samma svep, inte bara den senaste, så en kod som hunnit roteras en gång inte
kan komma tillbaka.

**2. Gå igenom medlemslistan.** Det här är steget folk hoppar över.
**Rotering är dörren, inte medlemskapet** — den som redan kommit in sitter kvar.
`members(gruppId)`, jämför `gick_med` mot när koden läckte, och
`removeMember(handtag)` på de som inte hör hemma.

**3. Är gruppen genomkompromissad: `remove(gruppId)`.** Det tar medlemskap,
koder **och gruppens rapporter**. Bygg om från en ny grupp.

### Vad det inte fixar — läs det här

**Det som lästs går inte att göra oläst.** Rapporterna är positioner, tid och
plats. Har någon suttit i gruppen i tre dagar kan hen ha skrivit av allt.
Rotering stänger dörren framåt; den städar inte bakåt. Utgå från att allt som
gruppen rapporterade under den tid koden var ute är känt.

**Vi loggar inte vem som använde vilken kod.** `group_invites` sparar `uses` och
`last_used_at` — alltså **hur många** som kom in och **när** koden senast
löstes in, men inte vem. Kopplingen får du göra själv genom att jämföra
`last_used_at` med `joined_at` i medlemslistan. Det räcker oftast för ett åkeri
med femton personer och inte alls för en grupp på femtio. Att spara kopplingen
hade betytt en till rad som binder en person till en händelse, och den avvägningen
landade åt andra hållet.

**Återkallade koder ligger kvar i 30 dagar** innan `purge_dead_invites()` tar
dem, just för att den jämförelsen ska gå att göra i efterhand.

**Sänk taket i förväg i stället.** Ett åkeri med femton bilar ska inte ha en kod
med `max_uses = 25` liggande i 14 dagar. Sätt
`rotateInvite(id, { maxUses: 15, days: 2 })` när förarna ska in, så stängs
hålet av sig självt. Taket och utgångsdatumet är billigare än en städning.

---

## 9. Vad som händer med rapporterna när någon lämnar

Kort svar: **rapporterna stannar i gruppen.** Det gäller både den som lämnar
själv och den som kastas ut.

Skälet är att de tillhör gruppen, inte personen. En förare som slutar ska inte
ta med sig varningarna ut ur bilarna som fortfarande kör. Att lämna en grupp är
inte samma sak som att ångra det man sagt medan man var med.

Och åt andra hållet, det som är lätt att missa:

**Läsrätten försvinner på servern i samma sekund.** Medlemsraden tas bort,
`is_group_member` svarar false, och nästa hämtning ger bara det publika flödet.
Inget fönster, ingen fördröjning.

**Men kopian som redan ligger i telefonen stannar kvar.** `js/store.js` sparar
hämtade rapporter i `localStorage` och rensar dem först när de gått ut. En
polisrapport har 45 minuters livslängd och är borta inom några timmar. En
**kamera som någon lagt in i gruppen har ett års livslängd** och ligger kvar på
den avhoppade förarens telefon tills den går ut. Vi kan inte fjärradera den —
appen fungerar offline, och en klient som kastar sin lokala data på order från
servern är samma mekanism som en klient som slutar varna. Vill du bli av med
den: `remove(gruppId)` och bygg om gruppen, eller acceptera det.

**Den som lämnat kan fortfarande ta bort sina egna rapporter.** `remove_report`
i `schema.sql` kollar författarskap, inte medlemskap, så en ex-medlem som har
kvar appen kan markera sina gamla grupprapporter som borttagna, en och en. Det är avsiktligt
— man ska kunna radera det man själv skrivit — men det betyder att "rapporterna
stannar kvar" är en regel om gruppens data, inte en garanti mot författaren.
Hen kan bara röra sina egna, och bara från en enhet som fortfarande minns
id:na; rapport-id går inte att leta upp när läsrätten är borta.

**Rösta kan hen inte längre.** Triggern `votes_group_guard` avvisar varje röst
på en rapport i en grupp man inte är med i. Utan den hade den som gissar ett
rapport-id kunnat rösta ner gruppens rapporter utifrån — ingen data läcker på
det, men flödet ska inte gå att störa.

---

## 10. Att vara ärlig om

**Gruppen skyddar mot främlingar, inte mot medlemmar.** Femton förare med samma
kod är femton personer som kan skärmdumpa flödet. Modellen förutsätter att
ägaren vet vilka som är med. Den fungerar för ett åkeri och sämre för en öppen
"kompisgrupp" som växer.

**Ägarens konto är en enskild felkälla.** Raderas kontot försvinner gruppen och
dess rapporter genom kaskaden. Det är rätt beteende, men ett åkeri bör låta
gruppen ägas av ett konto som överlever att en person slutar — eller använda
`transferOwnership()` innan hen gör det.

**`monthly_winners` var öppen och är det inte längre.** Vyn i `schema.sql`
grupperar rapporter per `device_id` för att räkna fram vilka tio som får nästa
månad gratis. Supabase delar automatiskt ut SELECT på nya vyer till `anon`, och
ingen `revoke` följde — så den lämnade ut `device_id` publikt, redan innan
grupper fanns. Med grupper blev den dessutom ett orakel: lägger en förare en
rapport i åkeriets grupp ändras en rad som vem som helst kan läsa. `grupper.sql`
återkallar därför läsrätten för `anon` och `authenticated`. Vyn räknar
fortfarande på alla rapporter, grupprapporter inräknade, och körs i SQL-editorn
där man är `postgres`. **Grupprapporter ger alltså fortfarande poäng** — den
avvägningen är inte självklar och är värd ett beslut om funktionen blir stor.

**Femtio medlemmar är ett tak vi gissat.** Det räcker för ett åkeri och en
trafikskola med marginal. Dyker det upp en kund med hundra bilar är
`member_limit` per grupp och går att höja till 500 utan att något annat ändras.

**Ingen inbjudan via länk.** Koden skrivs eller klistras in. En länk hade varit
bekvämare och hade samtidigt betytt att koden hamnar i webbläsarhistorik,
länkförhandsvisningar och serverloggar hos den som fick den vidarebefordrad.
Det får bli en QR-kod i appen i stället — `js/qr.js` finns redan.

**Ej testat mot en riktig databas i den här omgången.** SQL:en är
genomgången rad för rad och kontrollerad statiskt: inga framåtreferenser, varje
SECURITY DEFINER-funktion har `search_path`, varje funktion stängs från PUBLIC
innan den delas ut. `js/groups.js` är däremot körd i webbläsaren mot en
installation utan SQL:en, vilket bekräftar att modulen laddar, att
kodstädningen stämmer och att 404-vägen ger rätt svenska felmeddelande. Kör
frågorna i avsnitt 5 direkt efter första körningen — de tar tio sekunder och
fångar det som är värt att fånga.
