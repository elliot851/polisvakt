# Månadsbelöningen

De tio som rapporterar mest under en månad får nästa månad gratis. Det står i
`index.html`, i `js/app.js` och i `js/reputation.js`. Fram tills nu fanns
ingen mekanism som delade ut något — löftet var tomt.

Den här filen beskriver mekanismen som gör det sant. Allt ligger i
`supabase/manadsbelaning.sql`.

---

## Vad du måste köra

1. Öppna Supabase → SQL Editor.
2. Kör `supabase/KOR-ALLT.sql` först, om du inte redan gjort det.
3. Kör hela `supabase/manadsbelaning.sql` i ett svep.
4. Läs NOTICE-utskrifterna längst ner. Ett av två besked kommer:
   - *"Månadsbelöningen schemalagd via pg_cron…"* — klart, inget mer att göra.
   - *"pg_cron saknas…"* — då måste utdelningen startas på annat sätt, se
     [Om pg_cron saknas](#om-pg_cron-saknas).

Filen går att köra om hur många gånger som helst. Den skapar inga dubbletter
och delar aldrig ut en extra gratismånad.

**Kör den inte samma dag som ett månadsskifte om du kan undvika det.** Se
[Första månaden är ofullständig](#första-månaden-är-ofullständig).

---

## Hur det fungerar

### 1. Liggaren — `manads_bidrag`

Varje gång en rapport skapas skriver en trigger en rad i `manads_bidrag`:
vem, vilken månad, vilken källa, vilken grupp och hur rapporten röstats. När
rösterna ändras uppdateras raden.

**Varför inte bara räkna på `reports`?** Därför att `reports` töms löpande.
`purge_old_reports` raderar varje rapport en vecka efter att den gått ut. Den
1:a i månaden finns bara den sista dryga veckans rapporter kvar. Vyn
`monthly_winners` i `KOR-ALLT.sql` räknar på `reports` och skulle därför utse
fel vinnare varje månad — och listan hade sett helt rimlig ut hela tiden.

`report_history` går inte att använda i stället: den sparar med flit aldrig
vem som rapporterade, och det beslutet ska inte rivas upp för en topplistas
skull.

Liggaren har ingen främmande nyckel till `reports`, så gallringen rör den
inte.

### 2. Uträkningen — `manadens_stallning(månad, topp)`

Samma poängformel som `monthly_winners`:

```
rapporter + bekräftelser × 3 − nedröstningar × 4
```

Bara publika rapporter från appen och rösten räknas (`source` är `app` eller
`voice`, ingen grupp). Noll eller minuspoäng ger ingen plats. Ordningen är
poäng, sedan antal rapporter, sedan ägar-id — det sista ledet gör listan
deterministisk, så att två blickar på samma månad aldrig ger olika tia.

Klientens poäng (`reporter_scores`, `js/reputation.js`) används **inte**.
Den ligger i localStorage och går att ljuga om.

### 3. Utdelningen — `dela_ut_manadsbelaning()`

Utan argument: delar ut för månaden som just tog slut, till de tio översta,
en månad var.

För varje vinnare:

1. Läser nuvarande `paid_until` i `subscribers`.
2. Skriver en rad i `manads_belaning` (revisionen). **Först här.**
3. Förlänger `paid_until` till `greatest(paid_until, now()) + 1 månad`.
4. Skriver tillbaka det nya datumet i revisionsraden.

Returnerar en rad per **ny** vinnare. Noll rader betyder antingen "redan
utdelat" eller "ingen kvalificerade sig" — vilket det var står i NOTICE och i
`manads_utdelning`.

### 4. Revisionen — `manads_belaning`

En rad per utdelad belöning: månad, ägare, placering, rapporter, poäng,
smeknamn, hur många månader, om personen var betalande, `paid_until` före och
efter, och när användaren kvitterade beskedet i appen.

Det här är svaret på *"jag vann men fick ingenting"*. Den frågan kommer att
ställas.

---

## Att den inte kan dela ut dubbelt

Två lager, och det undre är det som verkligen håller.

**Undre lagret** är primärnyckeln `(manad, agare)` på `manads_belaning`.
Revisionsraden skrivs **innan** `paid_until` rörs. Kolliderar den har personen
redan fått sin månad, och då hoppas hen över helt. Ordningen är inte
utbytbar: skrevs raden efteråt hade ett avbrott mitt emellan gett en förlängd
prenumeration utan spår i revisionen — precis det tabellen finns till för att
göra omöjligt. Allt sker i samma transaktion, så antingen finns både raden och
månaden, eller ingendera.

**Övre lagret** är `manads_utdelning` (en rad per månad, `manad` som
primärnyckel) plus ett rådgivande lås. Det gör att en andra körning avbryter
direkt i stället för att räkna om hela månaden i onödan, och att två samtidiga
körningar — till exempel ett dubblerat cronjobb och en otålig administratör i
SQL-editorn — inte kan trampa på varandra.

Tas den övre raden bort för hand händer fortfarande ingen dubbelutdelning.
Det är avsiktligt: den övre spärren får gå att lyfta vid felsökning, den undre
får aldrig göra det.

Testa det själv, punkt 5 under [Kontroll](#kontroll).

---

## Besluten, och varför

### En vinnare utan prenumeration får ändå sin månad

Löftet i appen är villkorslöst. Det står inte "om du redan betalar". Den som
rapporterat mest av alla och råkar gå på provperiod eller ha en utgången
prenumeration är precis den person tjänsten inte har råd att tappa — hen matar
kartan som alla andra betalar för. Att neka sparar heller inga pengar,
eftersom personen inte betalade något att börja med. Saknas raden i
`subscribers` skapas den, med `paid_until` en månad fram från nu.

### Den som redan betalat får månaden pålagd i slutet

`paid_until` flyttas till `greatest(paid_until, now()) + 1 månad`. Alltså
aldrig bakåt, och aldrig "hoppa över, hen är ju redan täckt". Det senare hade
betytt att den lojala betalande kunden blev utan medan den som inte betalar
fick sin månad — exakt bakvänt mot vad belöningen finns till för. Belöningen
är värd en hel månad för alla tio.

Samma additiva form som `add_paid_months` i `billing.sql`.

### Belöningen är inte en betalning

Filen rör varken `plan`, `sub_status` eller `last_payment_at` (kolumnerna som
`billing.sql` lägger till). En gratismånad ska inte dyka upp i
`revenue_by_month` som intäkt och inte se ut som ett kortköp i en tvist. Enda
kolumnerna som ändras i `subscribers` är `paid_until` och `updated_at`.

### Grupprapporter räknas inte

En rapport i en privat grupp syns bara för gruppen. Belöningen betalas för
rapporter som hjälper alla. Dessutom stänger det en lucka: fyra kollegor i
samma åkerigrupp kan annars bekräfta varandras rapporter i en sluten cirkel
som ingen utomstående kan rösta ner.

Raden sparas ändå i liggaren, med grupp-id, så beslutet går att riva upp utan
att data gått förlorad.

### Egna verifieringar ger inga poäng

`js/reputation.js` ger +1 för att bekräfta någon annans rapport. Den delen är
den enda i poängmodellen som är gratis att spamma — ett klick per poäng.
Servern följer i stället `monthly_winners` och räknar bara rapporter,
bekräftelser och nedröstningar.

**Följd att känna till:** talet appen visar under "Din rapportpoäng" kan vara
högre än det tal som avgör vinsten. Det är värt att jämna ut i klienten (ta
bort `verify` ur `POINTS`, eller visa två tal), men det ska inte lösas genom
att göra utdelningen spambar.

### Månaden räknas i svensk tid, och på serverns klocka

Servern går i UTC. En rapport klockan 00:30 svensk tid den 1:a augusti är
fortfarande den 31 juli i UTC och hade hamnat i fel månad. Användaren räknar i
svensk tid (`monthKey()` i `js/reputation.js` använder webbläsarens lokala
tid), så liggaren gör det också.

Månaden tas från serverns `now()` när rapporten kommer in, inte från
`reports.created_at`. `created_at` kommer från klienten och kontrolleras inte
av någon insert-policy — den som vill kan datera en rapport till förra månaden
och göra sig till vinnare i en månad som redan är avgjord. Priset är att en
rapport som köats offline över ett månadsskifte räknas till månaden den kom
fram. Det är rätt sida att fela åt.

---

## Vad som körs när

| När | Vad | Var |
|---|---|---|
| Vid varje ny rapport | Trigger `reports_notera_bidrag` skriver en rad i `manads_bidrag` | automatiskt |
| Vid varje röst | Trigger `reports_uppdatera_bidrag` uppdaterar rösträkningen | automatiskt |
| Den 1:a varje månad kl 03:15 UTC | `dela_ut_manadsbelaning()` för månaden som tog slut | pg_cron, jobbet `polisvakt-manadsbelaning` |

Tiden i cron är serverns, alltså UTC. Den 1:a på natten är det samma dygn i
Sverige oavsett sommartid, så månadsgränsen stämmer.

### Om pg_cron saknas

pg_cron finns bara på betalda Supabase-projekt och i vissa regioner. Saknas
det delas **ingen** belöning ut automatiskt, och det syns inte på något annat
sätt än att ingen hör av sig — förrän någon gör det. Filen skriver därför ut
ett NOTICE.

Två vägar då:

1. **Dashboard → Database → Cron Jobs.** Skapa ett jobb som kör
   `select * from public.dela_ut_manadsbelaning();`. Tidsuttrycket står
   ordagrant i `cron.schedule`-anropet i slutet av `supabase/manadsbelaning.sql`
   — kopiera det därifrån.
2. **För hand.** Kör raden nedan i SQL-editorn den 1:a i varje månad. Missar
   du en dag gör det inget — funktionen räknar på månaden som tog slut, inte
   på när du kör den. Vill du köra en gammal månad i efterhand:
   `select * from public.dela_ut_manadsbelaning('2026-07');`

```sql
select * from public.dela_ut_manadsbelaning();
```

---

## Så hämtar appen "du vann"

Två funktioner är öppna för klienten. Båda tar identiteten ur
`public.actor()` — JWT:n för inloggade, det skickade enhets-id:t för gäster —
och lämnar bara ut den egna raden. Aldrig e-post, aldrig andras id, aldrig
hela vinnarlistan.

### Hämta

```js
const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/min_belaning`, {
  method: 'POST',
  headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_device: deviceId() }),
});
const rader = r.ok ? await r.json() : [];
// rader[0] = senaste vinsten, upp till 12 månader bakåt
```

Varje rad:

| Fält | Betyder |
|---|---|
| `manad` | `'2026-07'` — månaden som vanns |
| `placering` | 1–10 |
| `rapporter` | antal rapporter som räknades |
| `poang` | poängen som avgjorde |
| `manader` | hur många månader som gavs (1) |
| `gratis_till` | till vilket datum prenumerationen räckte efteråt |
| `vunnen_at` | när belöningen delades ut |
| `kvitterad` | `true` när användaren sett beskedet |

Visa den senaste raden med `kvitterad === false` som ett meddelande:
*"Du kom {placering}:a i juli — augusti är gratis."*

### Kvittera

Så att beskedet inte ligger kvar och blinkar i evighet:

```js
await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/kvittera_belaning`, {
  method: 'POST',
  headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_manad: rad.manad, p_device: deviceId() }),
});
```

Returnerar `true` om något faktiskt kvitterades.

**Notera:** en inloggad användare som byter enhet får med sig sina vinster,
eftersom `deviceId()` returnerar konto-id vid inloggning. En gäst som rensar
webbläsardata tappar dem, precis som hen tappar sin prenumeration i övrigt.

---

## Kontroll

Kontrollfrågorna står också längst ner i `supabase/manadsbelaning.sql`, med
kommentarer. De viktigaste:

**Att liggaren fylls på.** Lägg en rapport i appen och kör:

```sql
select * from public.belaning_halsa;
```

Raden för innevarande månad ska öka med ett per rapport. Gör den inte det
fylls liggaren inte, och då blir det ingen belöning.

**Att ingen klientroll kommer åt utdelningen.** Ska ge noll rader:

```sql
select p.proname, r.rolname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(p.proacl) a
  join pg_roles r on r.oid = a.grantee
 where n.nspname = 'public'
   and p.proname in ('dela_ut_manadsbelaning','manadens_stallning')
   and r.rolname in ('anon','authenticated');
```

**Ställningen just nu, utan att dela ut något:**

```sql
select * from public.manadens_stallning();
```

**Att en månad gick rätt:**

```sql
select * from public.belaning_historik;
select * from public.manads_belaning where manad = '2026-07' order by placering;
```

`antal_vinnare` i `belaning_historik` ska vara samma som
`rader_i_revisionen`. Är de olika har någon rört tabellerna för hand.

**När en kund hör av sig:**

```sql
select * from public.manads_belaning where agare = '<device_id>' order by manad desc;
select device_id, paid_until from public.subscribers where device_id = '<device_id>';
```

`paid_until_efter` på belöningsraden ska stämma med det `paid_until` som stod
i `subscribers` direkt efter körningen. Ligger det längre fram i dag har
kunden betalat något efteråt — det är rätt och väntat.

**Att schemat finns:**

```sql
select jobname, schedule, active from cron.job
 where jobname like 'polisvakt-manadsbelaning';
```

En rad om pg_cron finns, noll annars.

---

## Att veta

### Första månaden är ofullständig

Filen fyller liggaren med de rapporter som finns i `reports` när den körs.
Allt som redan gallrats bort av `purge_old_reports` är borta för gott och kan
inte fyllas på — bara den dryga sista veckan finns kvar.

Den första utdelningen efter installationen räknar alltså på ofullständigt
underlag. Kör den första månaden för hand och läs `manadens_stallning('…')`
innan du delar ut, så du ser om listan ser rimlig ut. Från och med den första
hela månaden efter installationen är siffran komplett.

### Om ingen kvalificerade sig

Raden i `manads_utdelning` står kvar som kvitto på att körningen skedde, med
en notering. Var det ett misstag — till exempel att liggaren var tom av
tekniska skäl:

```sql
delete from public.manads_utdelning where manad = '2026-07';
select * from public.dela_ut_manadsbelaning('2026-07');
```

Det är ofarligt. Primärnyckeln på `manads_belaning` hindrar ändå
dubbelutdelning till någon som redan fått sin månad.

### Att rulla tillbaka en felaktig utdelning

Det finns ingen ångra-funktion, med flit. Att automatiskt dra tillbaka en
prenumeration är farligare än att låta en felaktig gratismånad stå kvar. Vill
du ändå göra det: läs `paid_until_innan` på revisionsraden och sätt tillbaka
det med `set_paid_until(..., p_mode => 'exakt')` från `billing.sql`, och
radera sedan raden ur `manads_belaning` och `manads_utdelning`.

### Vad som inte är testat mot en riktig databas

Filen är kontrollerad mekaniskt — balanserade dollar-citat, balanserade
`begin`/`end`, och att varje funktion och kolumn den refererar finns i
`KOR-ALLT.sql`. Den har **inte** körts mot en riktig Postgres. Kör den i
SQL-editorn och läs felmeddelandet om något klagar; hela filen ligger i
editorns transaktion och rullas tillbaka om den inte går igenom.

---

## Objekt som skapas

| Objekt | Typ | Åtkomst |
|---|---|---|
| `manads_bidrag` | tabell | RLS på, inga policyer, revoke från anon/authenticated |
| `manads_belaning` | tabell | samma |
| `manads_utdelning` | tabell | samma |
| `notera_bidrag()` | triggerfunktion | trigger `reports_notera_bidrag` |
| `uppdatera_bidrag()` | triggerfunktion | trigger `reports_uppdatera_bidrag` |
| `manadens_stallning(text,int)` | funktion | endast `service_role` |
| `dela_ut_manadsbelaning(text,int,int,bool)` | funktion | endast `service_role` |
| `min_belaning(text)` | funktion | `anon`, `authenticated` |
| `kvittera_belaning(text,text)` | funktion | `anon`, `authenticated` |
| `belaning_historik` | vy | admin, revoke från anon/authenticated |
| `belaning_halsa` | vy | admin, revoke från anon/authenticated |

`dela_ut_manadsbelaning` är `security definer` och passerar därför både
radsäkerheten på `subscribers` och `guard_paid_until` i `stripe.sql`. Den enda
sak som hindrar en klient från att ge sig själv gratis prenumeration är att
EXECUTE är indraget från `anon` och `authenticated`. Rör inte de raderna.
