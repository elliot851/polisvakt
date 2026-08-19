# Körningspåminnelse

Appen påminner föraren om att slå på Polisvakt när hen sannolikt är på väg att köra.

Skälet står i ROADMAP.md och är värt att upprepa: en varningsapp som inte är påslagen
varnar för ingenting. Det spelar ingen roll hur bra kamerorna är kartlagda om föraren
sitter i bilen med appen stängd. Att få igång appen är därför värt mer än varje enskild
varning i den.

---

## Vad som INTE går, och varför

Den uppenbara lösningen — känn av via GPS att bilen börjar rulla, även när appen är
stängd — går inte i en webbapp. Det är **mätt i webbläsaren, inte antaget**:

| Vad som testats | Resultat |
| --- | --- |
| `navigator.geolocation` inne i en `Worker` | `undefined` |
| `navigator.geolocation` inne i en `ServiceWorker` | `undefined` |
| `GeofencingManager` / Geofencing-API:t | finns inte i någon webbläsare i drift |
| Timers och positionsuppdateringar i en bakgrundad flik | fryses |

`undefined` betyder inte "kräver tillstånd". Objektet finns inte — det går alltså inte
att be om lov, och det finns ingen flagga att slå på. **En service worker kan aldrig läsa
position.** Geofencing-specen övergavs och implementerades aldrig.

Bygg därför ingenting som låtsas göra det. En funktion som tyst inte fungerar är sämre än
ingen funktion alls: användaren tror att hen är bevakad och är det inte.

En nativ app (Android/iOS) kan göra det här. En webbapp kan inte. Det är skillnaden, och
den går inte att koda sig runt.

## Vad som går

Appen lär sig **när** användaren brukar köra, av körningar som faktiskt registrerats.
Servern skickar en web push strax innan de tiderna. Push kommer fram med appen **helt
stängd** — även på iPhone, för appar som lagts till på hemskärmen (iOS 16.4+, se
`docs/NOTISER.md`).

Det är inte samma sak som GPS i bakgrunden, och det ska inte beskrivas som det. Det som
lovas användaren är: *"appen påminner dig vid de tider du brukar köra"* — inte *"appen
känner av att du kör"*.

```
js/driving.js       körningar registreras när appen är öppen
        │
        ▼
js/korvanor.js      lär in fönster ur historiken   (ren logik, inga sidoeffekter)
        │
        ▼
js/push.js          laddar upp fönstren + prenumerationen
        │
        ▼
supabase/korpaminnelse.sql
  kor_fonster       fönstren per användare, med radsäkerhet
  due_kor_paminnelser   vem ska pingas just nu?
        │
        ▼
pg_cron var 5:e min → pg_net → edge-funktionen send-reminder → Web Push
        │
        ▼
sw.js 'push'        notisen visas, appen är stängd
```

---

## `js/korvanor.js`

Rent logiklager. Inget nätverk, ingen `localStorage`, ingen DOM, ingen `Notification`.
In går en historik av körningar, ut går fönster och ett ja/nej. Det gör den testbar utan
att någon behöver köra bil, och gör att exakt samma regler kan skrivas om i SQL utan att
man behöver gissa vad klienten menade.

### API

| Funktion | Beskrivning |
| --- | --- |
| `larFonster(korningar, opts)` | Historik → `{ fonster, avfardade, underlag, tillrackligt, varfor, tidszon }` |
| `borPaminna(lage, opts)` | → `{ paminn, kod, skal, slot, fonster, forTid, text }` |
| `slotsFromFonster(fonster)` | Fönster → platta nummer 0–167 för servern |
| `fonsterFranVanor(habits)` | Läser gamla `pv.habits.v1` (endast för övergången) |
| `noteraSkickad(logg, beslut, nu)` | Ny logg med utskicket noterat. Ren funktion. |
| `lokalTid(tid, tidszon)` | Väggklocka i användarens zon: `{ timme, veckodag, datum, slot, … }` |
| `arNatt(timme, opts)` | Ligger timmen i den tysta natten? |
| `beskrivFonster(fonster, resultat)` | Svensk sammanfattning för inställningsrutan |
| `class Korvanor` | Skal som håller fönster och utskickslogg i minnet |
| `STANDARD`, `SKAL` | Trösklar respektive stabila orsakskoder |

`korningar` tål tal, `Date`, ISO-strängar och `{at}`-objekt om vartannat. Skräp hoppas
över tyst — en trasig rad i historiken får aldrig hindra påminnelsen.

### Omdömet

Det svåra är inte att räkna timmar. Det svåra är att veta när man **inte** ska säga något.

* **Underlag.** En påminnelse byggd på en enda observation är en gissning. Den blir fel,
  den stör, och användaren stänger av notiser — och då är kanalen borta för alltid.
  Krav: minst 6 körningar totalt, historiken minst 10 dygn lång, minst 3 träffar i
  samma fönster.
* **Andel.** Räknas per veckodag. Tre måndagar av tre är ett mönster. Tre måndagar av
  tolv är slump. Utan andelen räcker det att köra länge nog för att allt ska se ut som en
  vana. Krav: minst 40 %.
* **En körning, inte en resa.** Flera positioner samma morgon räknas som **en** körning.
  Distinkta lokala datum, inte antal rader. Utan det bevisar en enda lång resa ett
  "mönster".
* **En per fönster.** Högst en påminnelse per fönster och dygn, högst två per dygn,
  minst 90 minuter emellan. Cron kör var femte minut och skulle annars träffa samma
  fönster tre gånger i rad. Taket är det som skyddar kanalen.
* **Tyst.** Natt (23–05) är alltid tyst. Kör man redan, eller har appen varit framme de
  senaste 20 minuterna, plingar ingenting. En notis om något man just gjort lär
  användaren att notiserna inte är värda att läsa.

### Sommartid

Allt räknas i användarens egen tidszon via `Intl.DateTimeFormat` med `timeZone`.

Det här är inte petighet. Sverige ligger UTC+1 på vintern och UTC+2 på sommaren. Räknar
man vanor i UTC hamnar samma morgonrutin — 07:30 varje måndag — i timme 5 halva året och
timme 6 den andra halvan. Mönstret delas i två högar som var för sig är för svaga för att
passera trösklarna, och påminnelsen som fungerat hela sommaren **slutar komma i slutet av
oktober**. Ingenting kraschar, ingenting loggas. Den bara tystnar, och det upptäcks av
användare, inte av oss.

Att i stället lägga på en fast offset (+1 eller +2) är samma bugg med extra steg: fel
exakt de dagar övergången sker, och fel för alla utanför Sverige.

Testet `sex måndagar tvärs över 25 oktober blir ETT fönster, inte två` finns just för
den här buggen. Går det sönder är det den här raden som brustit.

---

## Att köra i Supabase

Kör i SQL Editor, i den här ordningen. Filerna är idempotenta — de går att köra om.

1. `supabase/schema.sql` — måste redan vara körd (ger `public.actor()`)
2. `supabase/push.sql` — måste redan vara körd (ger `push_subscriptions` och `valid_timezone()`)
3. **`supabase/korpaminnelse.sql`** ← den här funktionen

### Innan du kör filen: sätt inställningarna

Nycklarna får **inte** stå i klartext i `cron.schedule`. `cron.job`-tabellen är läsbar för
alla med databasåtkomst och hamnar i varje backup — en `service_role`-nyckel där är samma
sak som att ge bort hela databasen.

```sql
alter database postgres set app.service_role_key = 'eyJ...';
alter database postgres set app.cron_secret      = '<slumpad sträng>';
alter database postgres set app.funktions_url    = 'https://<projekt>.supabase.co/functions/v1/send-reminder';
```

Inställningarna slår igenom först i **nya** anslutningar. Kör raderna ovan, öppna en ny
SQL-editorflik, och kör sedan `korpaminnelse.sql`. Gör du det i samma session läser
`current_setting()` fortfarande tomt, och filen vägrar då schemalägga — med ett NOTICE
som säger varför. Det är avsiktligt: ett schemalagt anrop utan nyckel ger 401 var femte
minut i evighet utan att någon märker något.

### Om pg_cron saknas

`pg_cron` finns inte på alla Supabase-projekt (inte på Free, och inte i alla regioner).
Filen körs klart ändå — tabellen och funktionerna skapas — men **inga påminnelser
skickas**, och det syns inte på något annat sätt än att telefonen är tyst. Filen skriver
ut ett NOTICE när det händer.

Gör då detta i stället, vilket fungerar överallt och inte kräver några tillägg:

> **Dashboard → Edge Functions → `send-reminder` → Schedules**
> Cron: `*/5 * * * *`

Samma sak gäller om `pg_net` saknas: utan det kan `pg_cron` inte anropa edge-funktionen.
`create extension pg_net;` — eller använd Dashboard-vägen.

### Vad som skapas

| Objekt | Roll |
| --- | --- |
| `kor_fonster` | Ett fönster per rad: `(agare, slot)`, med `antal`, `andel`, `tidszon` |
| `spara_kor_fonster(...)` | Klienten ersätter **hela** sin uppsättning fönster |
| `rensa_kor_fonster(device)` | Stäng av påminnelsen helt |
| `mina_kor_fonster(device)` | Läs tillbaka sina egna fönster |
| `due_kor_paminnelser(...)` | **service_role only.** Vem ska pingas nu? |
| `mark_kor_paminnelse(...)` | **service_role only.** Notera att pushen gick iväg |
| `stada_kor_fonster()` | **service_role only.** Städa döda rader |
| `korpaminnelse_halsa` | Adminvy med räknare |
| `polisvakt-korpaminnelse` | pg_cron-jobb, var femte minut |
| `polisvakt-korfonster-stada` | pg_cron-jobb, 04:40 varje natt |

### Radsäkerhet — ärligt om vad den ger

För **inloggade** är det riktig isolering: `agare = auth.uid()::text` kommer ur en
signerad JWT som klienten inte kan förfalska.

För **gäster** finns ingen sådan garanti att ge. Ett `device_id` ligger i `localStorage`
och är inget hemligt påstående — en policy som jämför mot ett värde klienten själv
skickar in vore teater. Därför får `anon` ingen policy alls; gästens väg går genom
`spara_kor_fonster()`, som är `security definer` och tar identiteten ur `public.actor()`.
Vad gästen får är att ingen kan **lista** andras rader och att ingen kan skriva utan att
känna till ett id — inte kryptografisk isolering.

Att det är acceptabelt beror på vad som står i tabellen: veckodag, timme och en räknare.
Ingen position, inget innehåll, inga nycklar. Skulle tabellen någon gång få ett känsligt
fält måste det här stycket läsas om.

### Utskicksspärrarna delas med push.sql — kör inte båda

`mark_kor_paminnelse` skriver i `push_subscriptions` (`last_sent_at`, `sent_today`,
`sent_date`, `last_slot`) med flit. Två system som räknar var sitt tak hade gett dubbelt
så många notiser som något av dem lovar.

Har du kört den här filen är **`due_kor_paminnelser`** den funktion cronjobbet ska
anropa — inte `due_push_reminders`. Kör aldrig båda schemalagda samtidigt.

---

## Tester

`korvanor-test.html`, körs över http (ES-moduler kräver det):

```powershell
.\serve.ps1 -Port 8151
# öppna http://localhost:8151/korvanor-test.html
```

36 tester. Grönt betyder att för lite underlag är tyst, att ett tydligt mönster ger
exakt en påminnelse, att samma fönster bara påminner en gång, att natten är tyst, att
lokal tid håller över sommartidsbytet, och att den som redan kör inte blir störd.

### Kontroller i SQL efteråt

```sql
-- Fyra policyer ska finnas
select policyname, cmd from pg_policies where tablename = 'kor_fonster' order by policyname;

-- Sommartiden. Båda ska bli 7 — blir de 5 och 6 räknas det i UTC någonstans.
select extract(hour from (timestamptz '2026-10-19 05:30:00+00' at time zone 'Europe/Stockholm')) as sommar,
       extract(hour from (timestamptz '2026-11-09 06:30:00+00' at time zone 'Europe/Stockholm')) as vinter;

-- Jobbet. Noll rader = pg_cron saknas, använd Dashboard-vägen.
select jobname, schedule, active from cron.job where jobname like 'polisvakt-kor%';

select * from public.korpaminnelse_halsa;
```

---

## Kvar att göra

* Edge-funktionen `send-reminder` måste anropa `due_kor_paminnelser` i stället för
  `due_push_reminders` och kvittera med `mark_kor_paminnelse`. Texten i notisen finns i
  `korvanor.paminnelsetext(timme)`.
* `js/driving.js` sparar i dag bara `"dag-timme" → antal` i `pv.habits.v1`. Den nyckeln
  vet varken datum eller tidszon, så andel och spann går inte att räkna ur den —
  `fonsterFranVanor()` finns bara för övergången. För att få den fulla kvaliteten behöver
  körningarnas tidsstämplar sparas (en lista `pv.korningar.v1`) och matas till
  `larFonster()`.
