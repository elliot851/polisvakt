-- =====================================================================
--  Polisvakt — notisen går bara till dem som är i närheten
--  2026-08-22
-- =====================================================================
--
-- VARNING OM BLOCKKOMMENTARER
--
-- Filen har INGA blockkommentarer, och ska inte få några. En stjärna följd av
-- ett snedstreck avslutar en blockkommentar mitt i raden, och den
-- kombinationen har redan dödat en körning i det här projektet en gång. Bara
-- radkommentarer med två bindestreck.
--
--
-- VAD DEN LÖSER
--
-- Notisvägen har ingen geografi. fbmejl_push_mottagare() väljer mottagare på
-- tre villkor — enabled, failures under fem, gruppnotiser på — och inget av
-- dem säger var telefonen är. Varenda ny rapport i Västeråsgruppen väcker
-- alltså varenda prenumerant i landet.
--
-- Det håller så länge det finns en grupp. Dagen Stockholm, Uppsala och Gävle
-- kopplas in blir varje ny grupp en volymökning för alla andra, och den enda
-- utväg som finns i dag är trubbig: sätt notis = false på gruppen i
-- tools/fb-bridge.user.js och ta bort HELA rapporten ur fbmejl_ta_emot — och
-- därmed också ur avdubblingen, ur Telegram-korsningen och ur nykterhetsnätet.
-- Att bygga vidare på den flaggan kostar mer än notisen är värd.
--
-- Efter den här filen jämför servern två koordinatpar: var rapporten ligger,
-- och var telefonen brukar vara. Ingen orttabell, ingen rutregistrering,
-- ingenting som måste fyllas i innan en ny grupp kan kopplas in. Tio grupper
-- är samma kod som en.
--
--
-- VARFÖR FILTRET SITTER PÅ SERVERN OCH INTE I TELEFONEN
--
-- Frågan är rimlig: telefonen vet ju exakt var den är, servern vet det bara
-- ungefär. Lägg filtret i sw.js, låt pushen gå till alla som i dag, och låt
-- luren avgöra om den ska ringa. Fyra saker gör att det inte går.
--
--   1. En push som inte visar en notis är ett kontraktsbrott. Web Push kräver
--      att push-lyssnaren visar något varje gång den väcks. Chrome svarar med
--      "den här webbplatsen har uppdaterats i bakgrunden" på en tyst push och
--      drar in tillståndet efter upprepade fall. Ett klientfilter betyder
--      alltså antingen en falsk notis eller en förlorad prenumeration — och
--      den som tappar tillståndet tappar körpåminnelsen med.
--
--   2. Väckningen har redan skett. Hela kostnaden av en notis — radion,
--      skärmen, avbrottet — betalas när telefonen tar emot pushen, inte när
--      den ritar den. Ett filter som körs efteråt sparar ingenting av det som
--      gör en onödig notis dyr.
--
--   3. Koordinaterna hade behövt följa med i nyttolasten. Nyttolasten går till
--      VARJE prenumerant och ritas på en låsskärm. Att skicka positionen för
--      varje rapport till varje telefon i landet, för att telefonen sedan ska
--      räkna ut att den inte var intresserad, är att sprida uppgifterna
--      längre för att kunna använda dem mindre.
--
--   4. Beslutet "ska den här omgången alls skickas" bor på servern. Takten,
--      dygnstaket och odelade sitter i fbmejl_notis_lage och kan inte läsa vad
--      en telefon tyckte. En omgång som ingen i närheten skulle fått ska inte
--      räknas upp i odelade — annars får den som slår på notiser en dag senare
--      "312 nya varningar i gruppen" som välkomsthälsning. Det beslutet går
--      bara att fatta där mottagarna räknas, alltså här.
--
-- Priset är att servern måste veta ungefär var telefonen hör hemma. Det
-- betalas med samma mynt som chatten redan använder: telefonen skickar MITTEN
-- AV SIN RUTA, en av ~2 500 fasta punkter i ett rutnät på 0,25 grader gånger
-- 0,5 grader, aldrig en rå GPS-position. Resonemanget står redan i
-- js/chatt.js — "hemadress, arbetsplats, vilka kvällar hen inte var hemma" —
-- och gäller ordagrant här. En dump av push_subscriptions ger ingen
-- adresslista.
--
--
-- SÄKERHETSREGELN, FÖRST AV ALLT
--
-- Nykterhets- och drogkontroller avvisas i fbmejl_ta_emot FÖRE insert och når
-- därför aldrig p_nya. Ingenting i den här filen läser den vägen, försvagar
-- den eller kan runda den: filtret kan bara TA BORT mottagare ur en lista,
-- aldrig lägga till en rapport som ett tidigare filter tystat. Ingen av de sex
-- kopiorna av nykterhetsnätet (js/parser.js, js/voice.js, supabase/chatt.sql,
-- supabase/telegram.sql, supabase/fbmejl.sql, tools/fb-bridge.user.js) öppnas,
-- rörs eller ens läses skrivande här.
--
--
-- VAD FILEN GÖR
--
--   push_subscriptions        TRE NYA KOLUMNER. notis_platser, notis_radie_m,
--                             notis_folj. Ingen befintlig rad ändrar beteende.
--   fbmejl_notis_logg         TVÅ NYA KOLUMNER. mottagare_inom, mottagare_totalt.
--   fbmejl_avstand_m()        NY. Haversine, samma formel som js/util.js.
--   fbmejl_push_mottagare()   NY ÖVERLAGRING (int, jsonb). Den gamla (int)
--                             blir ett skal som anropar den med null.
--   fbmejl_gruppnotis_antal() NY ÖVERLAGRING (jsonb). Den gamla () räknar nu
--                             rader UR mottagarlistan i stället för en egen
--                             fråga — grinden och listan kan inte längre vara
--                             oense.
--   fbmejl_notis_ut()         ERSATT. Plockar ut rapporternas koordinater,
--                             frågar grinden om just dem, och skickar dem
--                             vidare till edge-funktionen som URVALSKRITERIUM.
--   fbmejl_satt_notisplats()      NY. Automatikens väg in.
--   fbmejl_satt_notisomfang()     NY. Reglagets väg in.
--   fbmejl_har_notisomfang()      NY. Läs tillbaka sanningen.
--
-- Takten är ORÖRD: en notis per omgång, minst tio minuter emellan, tyst 23–06
-- svensk tid, högst tolv per dygn, odelade räknas upp precis som förut.
-- Buntningen är orörd. Avdubblingen är orörd. fbmejl_ta_emot rörs inte med en
-- bokstav. Nykterhetsnätet rörs inte med en bokstav.
--
--
-- VAD DEN INTE GÖR
--
--   * Ingen ny tabell. Ingen orttabell, ingen rutregistrering, ingen
--     kopia av länsrektanglarna. Det finns redan tre kopior av dem i
--     projektet och en fjärde är en fjärde som driver isär.
--   * Ingen PostGIS. Nytt beroende för en formel som ryms på fem rader.
--   * Inget index på de nya kolumnerna. Predikatet är haversine per rad och
--     kan inte indexeras utan PostGIS. push_active_idx smalnar redan av till
--     enabled och failures under fem, och några tusen rader gånger haversine
--     är mikrosekunder — EN gång per notis, högst tolv per dygn, inte per
--     förfrågan.
--   * Ingen omnyckling av fbmejl_notis_lage och ingen notis per område. Den
--     ändringen rör sex update-satser, två subselects i fbmejl_halsa och
--     kolumnen id, gör takten per-ruta, och kan tysta. Fel håll.
--   * INGEN ÄNDRING I fbmejl_halsa. Vyn fungerar och rörs inte här. Kolumnen
--     notis_racktvidd_procent hör hemma i supabase/fbmejl.sql, som äger
--     vydefinitionen — att droppa och återskapa vyn i en migration för att
--     lägga till en rad vore att flytta sanningen till fel fil.
--
--
-- OCH DET VIKTIGASTE: FILTRET ÄR INERT TILLS fbmejl.sql ÄR KÖRD
--
-- Filtret jämför rapportens koordinat mot telefonens hemtrakt. Rapportens
-- koordinat kommer från p_nya, och p_nya byggs i fbmejl_ta_emot — som den här
-- filen INTE rör. Den nuvarande versionen skickar med fyra fält: typ, plats,
-- utrustning, created_at. Ingen lat, ingen lon.
--
-- Alltså: efter den här filen ensam ser fbmejl_notis_ut() noll koordinater,
-- v_platspunkter blir null, och grinden räknar ALLA. Exakt dagens beteende,
-- till punkt och pricka. Filtret börjar arbeta först när supabase/fbmejl.sql
-- körts, för det är där p_nya får sina två extra fält.
--
-- Det är med flit och i den ordningen. Varje väg genom den här filen som inte
-- vet något faller mot "skicka till alla" — den generösa riktningen — och en
-- halv utrullning kan därför inte tysta någon. Självprovet längst ned säger
-- vilket läge databasen är i just nu.
--
--
-- KÖR
--
--   Klistra in hela filen i Supabase SQL Editor och kör. Den är idempotent och
--   tål att köras om. Läs kvittot och kontrollerna längst ned.
--
--   Kör FÖRE och EFTER:
--     select * from public.fbmejl_notiskedjan();
--     select public.fbmejl_gruppnotis_antal();
--   Talet ska vara oförändrat. Ändras det har grind-rättningen hittat rader
--   som låg över felgränsen — läs punkt 4 i kontrollerna innan du blir orolig.

-- to_regprocedure med FULL SIGNATUR, aldrig to_regproc med bara namnet.
-- to_regproc KASTAR på ett överlagrat namn i stället för att svara null — och
-- efter första körningen av den här filen ÄR både fbmejl_gruppnotis_antal och
-- fbmejl_push_mottagare överlagrade. En vakt skriven med to_regproc hade alltså
-- dödat varje omkörning av filen, på precis det sätt filen påstår att den inte
-- gör. Samma fälla som pg_net-kontrollen i fbmejl_notis_ut redan undviker, av
-- samma skäl.
do $vakt$
begin
  if to_regprocedure('public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)') is null
     or to_regprocedure('public.fbmejl_gruppnotis_antal()') is null
     or to_regprocedure('public.fbmejl_push_mottagare(int)') is null then
    raise exception 'Kör supabase/fbmejl.sql först — fbmejl_notis_ut, fbmejl_gruppnotis_antal eller fbmejl_push_mottagare saknas.';
  end if;
  if to_regclass('public.fbmejl_notis_logg') is null then
    raise exception 'Kör supabase/fbmejl.sql först — fbmejl_notis_logg saknas.';
  end if;
  if to_regprocedure('public.fbmejl_installning(text)') is null
     or to_regprocedure('public.fbmejl_dolj_hemligheter(text)') is null then
    raise exception 'Kör supabase/fbmejl.sql först — konfigurationsavsnittet saknas, och fbmejl_notis_ut anropar det.';
  end if;
end $vakt$;

begin;

-- =====================================================================
--  1. KOLUMNERNA PÅ PRENUMERATIONEN
-- =====================================================================
--
-- Tre stycken, på push_subscriptions. Blocket gör ingenting om push.sql inte
-- är körd — samma skyddsvakt som gruppnotiser-kolumnen har i fbmejl.sql, av
-- samma skäl: den här filen ska gå att köra på en databas utan push, och då
-- är notiserna ändå avstängda.
--
-- notis_platser  NULLABLE UTAN DEFAULT, med flit. null betyder "telefonen har
--                inte sagt var den hör hemma" och släpper igenom allt.
--                Bakåtkompatibiliteten ligger alltså i DATAMODELLEN och inte i
--                ett villkor någon kan glömma att skriva. Varenda befintlig
--                rad får null och fortsätter få varenda varning.
--
--                Innehållet är ALDRIG en rå GPS-position. Det är en array om
--                högst åtta objekt
--                {"lat":…, "lon":…, "sedd":"<iso>", "forst":"<iso>"}, där
--                varje lat/lon är MITTEN av en ruta ur js/chatt.js RUTA
--                (0,25 grader gånger 0,5 grader) — en av ~2 500 fasta punkter,
--                exakt samma kvantisering som chattens omrade-kolumn redan bär
--                över nätet. 'forst' är när punkten först blev känd och skrivs
--                aldrig om; se gallringen i fbmejl_satt_notisplats.
--
--                Åtta punkter som tak, inte en. Två dygns närvaro skiljer en
--                resa från en flytt, men inte en tvåveckorssemester från en
--                flytt — och den som kommer hem utan att öppna appen med GPS
--                på hade annars haft sin bevakning kvar i fel stad. Alltså:
--                automatiken LÄGGER TILL, tar aldrig bort. Samma sak löser
--                pendlaren Västerås–Stockholm utan att hen rör ett reglage.
--
--                Åtta och inte fyra sedan 2026-08-22: en semestervecka hinner
--                lägga upp fyra nya rutor, och med fyra platser var hemmet
--                utträngt innan föraren kom hem. Åtta platser kostar ingenting
--                — filtret jämför ändå varje punkt mot varje rapport i
--                omgången — och de gör resan för kort för att äta hemmet.
--                Klientens HEM_TAK i js/push.js är samma tal; en nionde punkt
--                därifrån hade tyst kastats här.
--
-- notis_radie_m  100 000 som förval, mätt och inte gissat. Västerås–Stockholm
--                är ~100 km, Västerås–Örebro ~75 km, och hela Västmanland ryms
--                inom 60 km från Hallstahammar. Med 100 km plus 20 km slarv
--                får varenda prenumerant i dagens upptagningsområde
--                FORTFARANDE varenda varning. Filtret gör i dag bara en sak:
--                slutar väcka telefoner i Malmö och Umeå.
--
-- notis_folj     Tvåstegs-defaulten, och den är hela migrationslöftet. Första
--                satsen ger BEFINTLIGA rader false. Andra satsen gör att
--                FRAMTIDA rader föds med true. Ingen som redan prenumererar
--                kan alltså smalnas av, inte ens när hens app uppdateras och
--                börjar skicka upp hempunkter — servern vägrar skriva punkter
--                på en rad med notis_folj = false. Spärren ligger på servern i
--                stället för i ett löfte om vad klienten inte skickar.

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'push.sql är inte körd — notisradien hoppas över. Rapporterna hamnar ändå på kartan.';
    return;
  end if;

  alter table public.push_subscriptions
    add column if not exists notis_platser  jsonb,
    add column if not exists notis_radie_m  int     not null default 100000,
    add column if not exists notis_folj     boolean not null default false;

  -- Steg två. Ska stå EFTER add column, aldrig i samma sats: det är hela
  -- skillnaden mellan "befintliga rader lämnas i fred" och "alla smalnas av".
  alter table public.push_subscriptions alter column notis_folj set default true;

  raise notice 'push_subscriptions har notis_platser, notis_radie_m och notis_folj. Befintliga rader: notis_folj = false, notis_platser = null, alltså allt som förut.';
end $$;

-- =====================================================================
--  2. BORTFALLET SKA SYNAS
-- =====================================================================
--
-- Två kolumner på notisloggen. Utan dem är ett filter som tystar för hårt
-- osynligt tills en förare kör in i en kontroll — användaren ser aldrig
-- notisen som inte kom, och loggen är det enda som kan se den.
--
--   mottagare_inom    hur många som fick den här omgången
--   mottagare_totalt  hur många som hade fått den utan filter
--
-- Ligger de nära varandra gör filtret ingenting, vilket är det väntade i
-- Västmanland i dag. Glider de isär brant efter att en ny grupp kopplats in är
-- det antingen filtret som arbetar som tänkt eller en radie som är för snål —
-- och nu går det att se vilket.

alter table public.fbmejl_notis_logg add column if not exists mottagare_inom   int;
alter table public.fbmejl_notis_logg add column if not exists mottagare_totalt int;

-- =====================================================================
--  3. AVSTÅNDET
-- =====================================================================
--
-- Haversine, meter, jordradie 6371000 — samma formel och samma radie som
-- distance() i js/util.js. least(1, …) av exakt samma skäl som Math.min(1, …)
-- där: flyttalsavrundning kan ge asin ett argument strax över 1, och då kastar
-- Postgres i stället för att svara noll meter.
--
-- Det finns i dag ingen avståndsfunktion i någon av de sexton sql-filerna,
-- kontrollerat. Skriv ingen andra heller. Två avståndsfunktioner som driver
-- isär är precis den fälla nykterhetsregelns sex kopior redan lärt det här
-- projektet, och den blir svårare att upptäcka här: en formel som är fel på
-- tredje decimalen ser rätt ut i varje test man orkar skriva för hand.
--
-- immutable och parallel safe för att planeraren ska få räkna den var den
-- vill. Den rör ingen tabell och har inget tillstånd.

create or replace function public.fbmejl_avstand_m(
  a_lat double precision, a_lon double precision,
  b_lat double precision, b_lon double precision
)
returns double precision
language sql
immutable
parallel safe
set search_path = public, pg_temp as $$
  select 6371000 * 2 * asin(least(1, sqrt(
    sin(radians(b_lat - a_lat) / 2) ^ 2 +
    cos(radians(a_lat)) * cos(radians(b_lat)) *
    sin(radians(b_lon - a_lon) / 2) ^ 2
  )));
$$;

-- =====================================================================
--  4. MOTTAGARNA
-- =====================================================================
--
-- Här sitter filtret, och det sitter på ETT ställe.
--
-- ---------------------------------------------------------------------
-- Om varför den gamla signaturen lever vidare i stället för att droppas
--
-- Det naturliga hade varit att droppa fbmejl_push_mottagare(int) och skapa en
-- ny med en parameter som har default null. Två saker talar emot.
--
--   1. Under utrullningen finns det en stund då databasen är ny och
--      edge-funktionen gammal. Den gamla anropar med bara p_limit. Med en
--      default-parameter fungerar det anropet — men bara tills någon lägger
--      till en tredje överlagring, och då blir det tvetydigt utan förvarning.
--      Två uttryckliga signaturer utan defaults kan aldrig bli tvetydiga.
--
--   2. drop function fungerar inte alltid. Vyn fbmejl_halsa ANROPAR
--      fbmejl_gruppnotis_antal(), och en vy som anropar en funktion är ett
--      beroende: drop svarar "cannot drop function because other objects
--      depend on it". Att först droppa vyn och sedan återskapa den kräver att
--      hela vydefinitionen kopieras hit — en andra kopia av en vy som bor i
--      fbmejl.sql. Samma fälla igen. Samma sak gäller den som frestas droppa
--      nollställiga fbmejl_gruppnotis_antal() i fbmejl.sql: det går inte
--      heller, på en databas där vyn redan finns.
--
-- Alltså: den gamla signaturen behålls som ett SKAL som anropar den nya med
-- null. Ett urval, en where-sats, två vägar in. Skalet kan inte glida från
-- innehållet, för det har inget eget innehåll.

create or replace function public.fbmejl_push_mottagare(
  p_limit   int,
  p_platser jsonb
)
returns table (endpoint text, p256dh text, auth text)
language plpgsql
security definer
stable
set search_path = public, pg_temp as $$
begin
  if to_regclass('public.push_subscriptions') is null then
    return;
  end if;

  return query
    select s.endpoint, s.p256dh, s.auth
      from public.push_subscriptions s
     where s.enabled
       and s.failures < 5
       and coalesce(s.gruppnotiser, false)
       -- AVSTÅNDSGRINDEN.
       --
       -- Fyra vägar igenom, och alla fyra pekar åt det generösa hållet:
       --
       --   * prenumeranten har ingen hemplats  -> allt. Varje rad som fanns
       --     före den här filen ligger här, och stannar här tills hens app
       --     både uppdaterats och hunnit lära sig var hon bor.
       --   * hemplatslistan är tom             -> allt. Kan bara uppstå om
       --     någon skrivit '[]' för hand i SQL.
       --   * notisen bär inga koordinater      -> allt. Gäller varje omgång
       --     så länge fbmejl_ta_emot inte skickar med lat/lon, och gäller
       --     dessutom varje omgång där odelade väckt filtret — se
       --     fbmejl_notis_ut nedan.
       --   * någon hemplats ligger inom radien från någon rapport i omgången.
       --
       -- Filtret kan alltså bara SÄNKA vad som når föraren, aldrig höja. Det
       -- kan inte återinföra något som ett tidigare filter tystat, och
       -- nykterhets- och drogkontroller sorteras bort långt uppströms i
       -- fbmejl_ta_emot, före insert, och finns inte ens i p_platser.
       --
       -- jsonb_typeof-kollarna står före jsonb_array_length av ett trist skäl:
       -- den senare KASTAR på allt som inte är en array. En rad där någon
       -- skrivit ett objekt för hand i SQL hade då tagit med sig hela
       -- notisomgången i fallet, för alla andra också. Nu blir en trasig rad
       -- bara en rad utan filter.
       and (
         s.notis_platser is null
         or jsonb_typeof(s.notis_platser) <> 'array'
         or jsonb_array_length(s.notis_platser) = 0
         or p_platser is null
         or jsonb_typeof(p_platser) <> 'array'
         or jsonb_array_length(p_platser) = 0
         or exists (
           select 1
             from jsonb_to_recordset(s.notis_platser)
                    as hem(lat double precision, lon double precision),
                  jsonb_to_recordset(p_platser)
                    as rap(lat double precision, lon double precision)
            where hem.lat is not null and hem.lon is not null
              and rap.lat is not null and rap.lon is not null
              -- SLARVET, OCH VARFÖR DET ÄR ETT BEVIS OCH INTE EN FÖRHOPPNING.
              --
              -- hem-punkten är mitten av en ruta på 0,25 grader gånger 0,5
              -- grader. Vid 60 grader nord är halva diagonalen av den rutan
              -- 19,7 km. Telefonens SANNA position ligger alltså högst 19,7 km
              -- från punkten vi jämför med.
              --
              -- Ligger rapporten inom radien från den sanna positionen är den
              -- därför högst radie plus 19,7 km från rutmitten — och släpps
              -- igenom av marginalen nedan. Felet kan bara gå åt ena hållet:
              -- några får en notis de inte behövde, ingen missar en som gällde.
              and public.fbmejl_avstand_m(hem.lat, hem.lon, rap.lat, rap.lon)
                  <= coalesce(s.notis_radie_m, 100000) + 20000
         )
       )
     limit greatest(1, least(coalesce(p_limit, 2000), 5000));
end $$;

-- Skalet. Finns för edge-funktioner och SQL-rader som ännu inte känner till
-- p_platser, och gör exakt det de gjorde förut: hämtar alla.
create or replace function public.fbmejl_push_mottagare(p_limit int default 2000)
returns table (endpoint text, p256dh text, auth text)
language sql
security definer
stable
set search_path = public, pg_temp as $$
  select m.endpoint, m.p256dh, m.auth
    from public.fbmejl_push_mottagare(p_limit, null::jsonb) m;
$$;

-- ---------------------------------------------------------------------
-- GRINDEN RÄKNAR NU RADER UR LISTAN, INTE UR EN EGEN FRÅGA
--
-- Den kända oenigheten, och den rättas här för att ett ortsfilter gör den
-- VANLIGARE, inte ovanligare.
--
-- Så här såg den ut: grinden räknade "where enabled and coalesce(gruppnotiser,
-- false)" medan listan dessutom krävde "failures < 5". Låg alla prenumeranter
-- över felgränsen passerade notis_ut grinden, skrev senaste_at, räknade upp
-- antal_idag, NOLLSTÄLLDE odelade och loggade 'koad' — och edge-funktionen
-- hittade noll mottagare och svarade 200. Omgången var borta, varje led grönt.
-- Exakt det felmönster hela fbmejl.sql är skriven för att undvika.
--
-- Med ett avståndsfilter blir varje omgång ett mindre urval, och ett mindre
-- urval har större chans att bestå enbart av trasiga rader. Alltså: grinden
-- räknar rader ur fbmejl_push_mottagare. Nu finns bara ETT urval att vara
-- oense med.
--
-- Två följder att känna till, båda ofarliga men båda överraskande första
-- gången:
--
--   * Talet kan bli LÄGRE än det var före den här filen, om någon
--     prenumerant ligger över felgränsen. Det är inte filtret som arbetar,
--     det är sanningen som kommit ikapp.
--   * Räkningen är kapad till 5000, eftersom listan är det. Med några tusen
--     prenumeranter spelar det ingen roll; passeras taket är gränsen redan
--     nådd på riktigt i edge-funktionen också.
--
-- Kontrollen mot information_schema.columns som gamla versionen hade är borta:
-- fbmejl_push_mottagare svarar redan tomt när tabellen saknas, och den är nu
-- den enda definitionen av vem som är mottagare.
--
-- Signaturen () behålls oförändrad, och det är inte artighet. Den anropas på
-- TRE ställen, inte två: i fbmejl_notis_konfig() som diagnostik, i grinden i
-- fbmejl_notis_ut, och i vyn fbmejl_halsa. Vyn gör signaturen omöjlig att
-- droppa. Den nya överlagringen har INGEN default, alltså kan () aldrig bli
-- tvetydig, och alla tre anropsställena fortsätter fungera orörda.

create or replace function public.fbmejl_gruppnotis_antal(p_platser jsonb)
returns int
language plpgsql
security definer
stable
set search_path = public, pg_temp as $$
declare n int;
begin
  if to_regclass('public.push_subscriptions') is null then return 0; end if;
  select count(*) into n from public.fbmejl_push_mottagare(5000, p_platser);
  return coalesce(n, 0);
end $$;

-- Totalen. Samma signatur som förut, samma svar som förut för alla utom de
-- rader som ligger över felgränsen — se resonemanget ovan.
create or replace function public.fbmejl_gruppnotis_antal()
returns int
language plpgsql
security definer
stable
set search_path = public, pg_temp as $$
begin
  return public.fbmejl_gruppnotis_antal(null::jsonb);
end $$;

-- =====================================================================
--  5. UTSKICKET
-- =====================================================================
--
-- Hela fbmejl_notis_ut, ersatt. Fem ändringar, och INGEN av dem rör en spärr:
--
--   1. Rapporternas koordinater plockas ut ur p_nya till v_platspunkter.
--   2. Grinden frågas två gånger: en gång om totalen, en gång om de punkterna.
--   3. Ligger det odelade varningar i högen slås filtret AV för omgången.
--   4. Punkterna följer med i pg_net-kroppen som ett urvalskriterium.
--   5. Loggen får mottagare_inom och mottagare_totalt.
--
-- Nattspärren, glesspärren, dygnstaket, buntningen, odelade-räkningen,
-- ordningen mellan dem, samt regeln att tillståndet skrivs FÖRST när anropet
-- är köat — allt ordagrant som förut. Jämför gärna mot supabase/fbmejl.sql
-- rad för rad; det är meningen att diffen ska vara liten och tråkig.
--
-- ---------------------------------------------------------------------
-- Varför orten härleds ur RAPPORTENS koordinat och inte ur gruppens ruta
--
-- Bryggan känner varje Facebook-grupps ruta och ort och hade kunnat skicka med
-- dem. Den ska inte. Gruppens ruta säger var gruppen SVEPER, inte var nålen
-- hamnade: någon i Västeråsgruppen som postar om E18 vid Enköping ska nå
-- Enköping, inte Västerås. Samma regel som source, som sätts av servern och
-- inte av anroparen, och av exakt samma skäl — en anropare ska inte kunna
-- hitta på var en rapport hör hemma.
--
-- Följden är den stora vinsten: tools/brygg-daemon.ps1 och js/fbmejl.js ändras
-- inte med en rad, och en ny grupp kräver ingen registrering någonstans.

create or replace function public.fbmejl_notis_ut(
  p_nya          jsonb,
  p_min_minuter  int      default 10,
  p_tak_per_dygn int      default 12,
  p_tidigast     smallint default 6,
  p_senast       smallint default 23
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_antal    int;
  v_lage     public.fbmejl_notis_lage%rowtype;
  v_lokal    timestamptz := now();
  v_timme    int;
  v_dag      date;
  v_platser  text;
  v_mening   jsonb;
  v_titel    text;
  v_text     text;
  v_totalt   int;
  v_url      text;
  v_nyckel   text;
  v_skal     text;
  v_mottagare int;
  v_net_id   bigint;
  v_fel      text;
  -- Nytt. v_platspunkter är omgångens koordinater, v_mottagare_alla är vad
  -- grinden hade svarat utan filter, v_odelade_fore är en OLÅST förhandstitt
  -- på högen — se resonemanget vid grinden nedan.
  v_platspunkter  jsonb;
  v_mottagare_alla int;
  v_odelade_fore   int;
begin
  if p_nya is null or jsonb_typeof(p_nya) <> 'array' then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  v_antal := jsonb_array_length(p_nya);
  if v_antal = 0 then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  -- Var ligger den här omgången?
  --
  -- Punkterna är slutna värden: två tal som redan ritas som en nål på kartan
  -- för alla. De följer med för URVALET, aldrig för texten — de får inte
  -- hamna i titel eller brödtext, och de får inte in i nyttolasten som
  -- edge-funktionen krypterar och skickar till telefonen. Varningen om att
  -- 'note' inte hör hemma i p_nya gäller oförändrat och gäller dubbelt här.
  --
  -- Saknas lat och lon blir v_platspunkter null och allt går till alla. Det är
  -- läget så länge fbmejl_ta_emot inte skickar med koordinaterna, alltså tills
  -- supabase/fbmejl.sql är körd. Se rubriken längst upp i filen.
  --
  -- Högst 25 punkter. Fler ryms inte meningsfullt i en omgång, och en
  -- obegränsad lista är en pg_net-kropp som växer med gruppens värsta kväll.
  select jsonb_agg(jsonb_build_object('lat', x.lat, 'lon', x.lon))
    into v_platspunkter
    from (
      select distinct y.lat, y.lon
        from jsonb_to_recordset(p_nya) as y(lat double precision, lon double precision)
       where y.lat is not null and y.lon is not null
       limit 25
    ) x;

  -- ODELADE SLÅR AV FILTRET.
  --
  -- Ligger det varningar i högen sedan tidigare omgångar beskriver texten som
  -- ska gå ut även DEM, och deras koordinater har ingen längre — odelade är
  -- ett tal, inte en lista. Att då filtrera på bara den här omgångens punkter
  -- vore att tysta en notis som delvis handlar om något annat.
  --
  -- Titten är OLÅST och sker före grinden, med flit. Grinden ska kunna svara
  -- utan att ta radlåset — det är hela skälet till att den ligger före
  -- select ... for update. Kappseglar två omgångar om samma rad kan svaret bli
  -- en omgång gammalt, och konsekvensen av det är i värsta fall att filtret
  -- slås av när det inte behövde slås av. Åt det generösa hållet, som allt
  -- annat här. Det låsta värdet läses längre ner och används för texten.
  select coalesce(l.odelade, 0) into v_odelade_fore
    from public.fbmejl_notis_lage l where l.id = 1;

  if coalesce(v_odelade_fore, 0) > 0 then
    v_platspunkter := null;
  end if;

  -- Lyssnar någon, och lyssnar någon I NÄRHETEN?
  --
  -- Först av allt, och före spärrarna: har ingen slagit på gruppnotiser finns
  -- det inget att spärra. Tillståndet rörs INTE — varken senaste_at eller
  -- odelade. Att räkna upp odelade när ingen lyssnar hade betytt att den
  -- första som slår på notiser får "312 nya varningar i gruppen" som
  -- välkomsthälsning.
  --
  -- Samma resonemang gäller nu en omgång som ingen i närheten skulle fått: den
  -- ska inte heller läggas på hög. Den som bor i Västerås ska inte en tisdag få
  -- veta att det hänt fyrtio saker i Gävle sedan sist.
  v_mottagare_alla := public.fbmejl_gruppnotis_antal();
  if v_platspunkter is null then
    v_mottagare := v_mottagare_alla;
  else
    v_mottagare := public.fbmejl_gruppnotis_antal(v_platspunkter);
  end if;

  if coalesce(v_mottagare, 0) = 0 then
    insert into public.fbmejl_notis_logg (antal, utfall, skal, mottagare_inom, mottagare_totalt)
    values (
      v_antal,
      'ingen-mottagare',
      case when coalesce(v_mottagare_alla, 0) = 0
             then 'noll prenumeranter med gruppnotiser pa'
             else 'noll prenumeranter inom rackhall' end,
      0,
      coalesce(v_mottagare_alla, 0)
    );
    return jsonb_build_object('skickad', false, 'skal', 'ingen-mottagare',
                              'antal', v_antal, 'mottagare', 0,
                              'mottagare_totalt', coalesce(v_mottagare_alla, 0));
  end if;

  v_timme := extract(hour from (v_lokal at time zone 'Europe/Stockholm'))::int;
  v_dag   := (v_lokal at time zone 'Europe/Stockholm')::date;

  select * into v_lage from public.fbmejl_notis_lage where id = 1 for update;

  -- Nytt dygn nollställer räknaren.
  if v_lage.dag is distinct from v_dag then
    v_lage.antal_idag := 0;
    v_lage.dag := v_dag;
  end if;

  -- Spärrarna, i ordning. Först den som är billigast att avgöra.
  if v_timme < p_tidigast or v_timme >= p_senast then
    v_skal := 'natt';
  elsif v_lage.senaste_at is not null
        and v_lage.senaste_at > now() - make_interval(mins => greatest(0, p_min_minuter)) then
    v_skal := 'for-tatt';
  elsif v_lage.antal_idag >= greatest(0, p_tak_per_dygn) then
    v_skal := 'dygnstak';
  end if;

  if v_skal is not null then
    -- Undertryckt, inte glömt. Nästa notis som får gå berättar hur många
    -- varningar som kommit sedan sist.
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal,
           dag = v_dag,
           antal_idag = v_lage.antal_idag,
           uppdaterad = now()
     where id = 1;

    insert into public.fbmejl_notis_logg (antal, utfall, skal)
    values (v_antal, 'sparrad', v_skal);

    return jsonb_build_object('skickad', false, 'skal', v_skal, 'antal', v_antal);
  end if;

  v_totalt := v_antal + coalesce(v_lage.odelade, 0);

  -- Det låsta värdet, som facit. Förhandstitten ovan kan ha varit en omgång
  -- gammal; den här kan inte. Filtret slås av åt samma håll en gång till, för
  -- säkerhets skull — att slå av det två gånger kostar ingenting, att missa
  -- det en gång kostar en varning.
  if coalesce(v_lage.odelade, 0) > 0 then
    v_platspunkter := null;
    v_mottagare    := v_mottagare_alla;
  end if;

  -- Rubrikerna, utan dubbletter, högst tre. Fler får inte plats i en notis
  -- och gör den svårare att läsa på en låsskärm i en bil.
  --
  -- Förut stod bara platsnamnen här — "Erikslund · E18 · Hälla". Tre platser
  -- utan att säga VAD som står där är tre frågor, inte tre besked. Nu står
  -- typen med, byggd av fbmejl_mening() precis som den enskilda notisen.
  select string_agg(q.r, ' · ' order by q.r) into v_platser
    from (
      select distinct on (lower(d.rubrik)) d.rubrik as r
        from (
          select public.fbmejl_mening(x.typ, x.utrustning, x.plats, x.created_at) ->> 'rubrik'
                   as rubrik
            from jsonb_to_recordset(p_nya)
                 as x(typ text, plats text, utrustning text, created_at bigint)
        ) d
       where coalesce(d.rubrik, '') <> ''
       order by lower(d.rubrik)
       limit 3
    ) q;

  if v_totalt = 1 then
    -- En enda varning: hela sammanfattningsmeningen, delad vid sitt eget
    -- tankstreck. Titeln säger VAD och VAR, brödtexten NÄR och VARIFRÅN.
    -- Det är samma mening som js/sammanfattning.js visar i appen — se
    -- avsnittet NOTISER: MENINGEN i supabase/fbmejl.sql.
    select public.fbmejl_mening(x.typ, x.utrustning, x.plats, x.created_at)
      into v_mening
      from jsonb_to_recordset(p_nya)
           as x(typ text, plats text, utrustning text, created_at bigint)
     limit 1;
    v_titel := left(coalesce(v_mening->>'rubrik', 'Ny varning i gruppen'), 80);
    v_text  := left(coalesce(v_mening->>'svans',
                             'Någon i Facebook-gruppen varnade. Öppna Polisvakt för att se var.'), 240);
  else
    v_titel := v_totalt || ' nya varningar i gruppen';
    v_text  := left(coalesce(v_platser, 'Öppna Polisvakt för att se var.'), 240);
  end if;

  -- Ut på nätet, om vägen dit finns. Saknas pg_net eller adressen loggas det
  -- som ett fel istället för att tyst försvinna — en notiskedja som ser frisk
  -- ut och inte når fram är den svåraste sortens fel, och den har den här
  -- appen redan haft en gång.
  --
  -- Observera att tillståndet inte är rört än. Varje väg ut härifrån som INTE
  -- lyckas köa anropet lägger tillbaka varningarna i odelade, precis som en
  -- spärr gör.
  v_url    := public.fbmejl_installning('fbmejl_push_url');
  v_nyckel := public.fbmejl_anropsnyckel();

  if v_url is null or v_url = '' then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'fbmejl_push_url saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'fbmejl_push_url saknas');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-url', 'titel', v_titel);
  end if;

  -- Nyckeln, innan anropet och inte efter det. Utan nyckel svarar fbmejl-push
  -- 401 på varje anrop — den godtar ingen tom sträng, med flit, för en tom
  -- nyckel som duger vore ett öppet API.
  if v_nyckel is null or v_nyckel = '' then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'anropsnyckel saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'anropsnyckel saknas');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-nyckel', 'titel', v_titel);
  end if;

  -- Katalogen, inte to_regproc(): den senare KASTAR på ett överlagrat namn
  -- istället för att svara null, och pg_net har historiskt haft flera
  -- signaturer för http_post. Ett fel här hade blivit ett fel i notisen —
  -- alltså precis det den här kontrollen finns för att undvika.
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'pg_net saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'pg_net saknas');
    return jsonb_build_object('skickad', false, 'skal', 'pg_net-saknas', 'titel', v_titel);
  end if;

  begin
    -- Id:t sparas. Det är den enda kopplingen mellan den här raden i loggen
    -- och pg_nets svar i net._http_response.
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce(v_nyckel, '')
      ),
      body    := jsonb_build_object(
        'titel', v_titel,
        'text',  v_text,
        -- Samma tag varje gång: en ny gruppnotis ERSÄTTER den gamla i luren
        -- istället för att lägga sig ovanpå. Se push-lyssnaren i sw.js.
        --
        -- Och den viktigaste avgränsningen i hela den här ändringen: taggen
        -- står KVAR på 'polisvakt-grupp' och url på './'. Ingen ruta, ingen
        -- per-område-tagg, ingen omnyckling av fbmejl_notis_lage. Notisen är
        -- fortfarande EN text per omgång — den skickas bara till färre.
        'tag',   'polisvakt-grupp',
        'url',   './',
        'antal', v_totalt,
        -- URVALSKRITERIUM, INTE INNEHÅLL. Fältet läses av edge-funktionen och
        -- skickas vidare till fbmejl_push_mottagare. Det får ALDRIG in i
        -- byggNyttolast — koordinater på en låsskärm är inte vad någon bad om,
        -- och nyttolasten är det enda i kedjan som når telefonen.
        --
        -- Är fältet null skickar edge-funktionen null vidare och alla får
        -- notisen. En edge-funktion som inte hunnit uppdateras skickar inte
        -- p_platser alls och träffar då skalet ovan, som också ger alla.
        -- Ingen halv utrullning kan tysta någon.
        'platser', v_platspunkter
      )
    ) into v_net_id;
  exception when others then
    -- sqlerrm maskas innan den sparas. Nyckeln är ett ARGUMENT till
    -- net.http_post(), och Postgres skriver normalt inte ut argument i sina
    -- felmeddelanden — men "normalt" är inte "aldrig".
    v_fel := public.fbmejl_dolj_hemligheter(sqlerrm);
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = left(v_fel, 500), uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', left(v_fel, 200));
    return jsonb_build_object('skickad', false, 'skal', 'fel', 'detalj', v_fel);
  end;

  -- Först här. Anropet ligger i pg_nets kö, glesspärren och dygnstaket får
  -- räknas upp, och odelade nollställs eftersom varningarna nu är med i den
  -- text som ligger på väg ut.
  update public.fbmejl_notis_lage
     set senaste_at = now(),
         antal_idag = v_lage.antal_idag + 1,
         dag = v_dag,
         odelade = 0,
         senaste_fel = null,
         uppdaterad = now()
   where id = 1;

  insert into public.fbmejl_notis_logg
    (antal, titel, text, utfall, net_id, mottagare_inom, mottagare_totalt)
  values
    (v_totalt, v_titel, v_text, 'koad', v_net_id, v_mottagare, v_mottagare_alla);

  -- 'koad', inte 'skickad', och nyckeln heter fortfarande skickad i svaret av
  -- bakåtkompatibilitet — men den betyder "köad hos pg_net", ingenting mer.
  return jsonb_build_object('skickad', true, 'utfall', 'koad', 'antal', v_totalt,
                            'titel', v_titel, 'mottagare', v_mottagare,
                            'mottagare_totalt', v_mottagare_alla,
                            'platser', case when v_platspunkter is null then 0
                                            else jsonb_array_length(v_platspunkter) end,
                            'net_id', v_net_id);
end $$;

-- =====================================================================
--  6. APPENS VÄGAR IN
-- =====================================================================
--
-- Tre funktioner, byggda på exakt samma mönster som fbmejl_satt_gruppnotiser:
-- public.actor(p_device) avgör vem raden tillhör, ingen kan ändra åt någon
-- annan, och SVARET ÄR ALLTID JSONB — aldrig void.
--
-- Skälet till det sista står redan i fbmejl.sql och är värt att upprepa: en
-- void-funktion som träffar noll rader ger PostgREST-svar 200. Appen skriver
-- "sparat" i reglaget och ingenting hände. Det är inte teoretiskt —
-- prenumererar man utloggad får raden ett slumpat device_id, loggar man in
-- skrivs den om till auth.uid(), och sedan matchar ingenting.
--
-- Blocket gör ingenting om push.sql inte är körd. Ett create som misslyckas
-- hade dödat hela filen, och notisradien är inte värd rapporterna.

do $$
begin
  if to_regclass('public.push_subscriptions') is null
     or to_regprocedure('public.actor(text)') is null then
    raise notice 'push.sql eller schema.sql saknas — hoppar över notisomfångs-funktionerna.';
    return;
  end if;

  -- ---------------------------------------------------------------------
  -- AUTOMATIKENS VÄG IN
  --
  -- Klienten skickar mitten av en ruta den setts i under två skilda
  -- kalenderdygn. Servern gör tre saker, i den här ordningen:
  --
  --   1. Är notis_folj false: skriv INGENTING och säg det. Det är
  --      tvåstegs-defaultens andra hälft — en uppdaterad klient kan inte
  --      smalna av en prenumerant som fanns före den här filen, hur ivrig den
  --      än är. Spärren ligger här, inte i ett löfte om vad appen inte gör.
  --   2. Slå ihop mot befintliga punkter på fyra decimaler. Rutmitterna är
  --      fasta punkter, så samma ruta ger alltid exakt samma tal — jämförelsen
  --      finns för flyttalsbrus i transporten, inget annat. Träff: skriv om
  --      'sedd' men BEHÅLL 'forst'. Miss: lägg till med 'forst' = nu.
  --   3. Tak åtta. Punkten som just kom in ligger alltid kvar; resten sorteras
  --      på 'forst' STIGANDE, alltså överlever den som varit känd längst.
  --
  -- Punkt 3 hette till 2026-08-22 "sorterat på 'sedd' fallande, aldrig
  -- hemrutan, eftersom hemrutans 'sedd' skrivs om varje gång telefonen är
  -- där". Det var fel: telefonen skriver bara om 'sedd' när den ÄR där, och
  -- en semester är precis den tiden då den inte är det. Fyra nya punkter från
  -- resan räckte för att hemmet skulle bli den orördaste av alla och gallras
  -- bort — varpå avståndsgrinden stod kvar aktiv på fel landsdel och tystade
  -- varenda hemmarapport. Med 'forst' stigande kan en resa aldrig tränga ut
  -- ett hem som funnits där längre, och skulle det bli fel går felet åt rätt
  -- håll: en punkt för mycket släpper igenom fler varningar, aldrig färre.
  --
  -- Den nya punkten undantas från sorteringen för att en riktig flytt annars
  -- aldrig kan få fäste: dess 'forst' är alltid den yngsta, och den hade
  -- kastats i samma anrop som skrev den, varje gång.
  --
  -- Funktionen tar aldrig bort en punkt av sig själv. Det är hela poängen med
  -- en array i stället för en punkt: semestern flyttar inte hem.
  execute $fn1$
    create or replace function public.fbmejl_satt_notisplats(
      p_endpoint text, p_device text,
      p_lat double precision, p_lon double precision
    )
    returns jsonb
    language plpgsql security definer set search_path = public, pg_temp as $kropp1$
    declare
      v_actor   text;
      v_folj    boolean;
      v_gamla   jsonb;
      v_nya     jsonb;
      v_radie   int;
      v_n       int;
      v_forst   text;
      v_nu      text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    begin
      if p_lat is null or p_lon is null
         or p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
        return jsonb_build_object('ok', false, 'rader', 0, 'skal', 'ogiltig-punkt');
      end if;

      v_actor := public.actor(p_device);

      select coalesce(s.notis_folj, false), s.notis_platser, coalesce(s.notis_radie_m, 100000)
        into v_folj, v_gamla, v_radie
        from public.push_subscriptions s
       where s.endpoint = p_endpoint and s.device_id = v_actor;

      if not found then
        return jsonb_build_object('ok', false, 'rader', 0, 'skal', 'ingen-rad');
      end if;

      if not v_folj then
        -- Inte ett fel. Raden fanns före utrullningen, eller så har användaren
        -- valt "Hela landet". Båda betyder samma sak: rör den inte.
        return jsonb_build_object('ok', true, 'rader', 0, 'skal', 'foljer-inte',
                                  'platser', 0, 'radie_m', v_radie, 'folj', false);
      end if;

      -- Punktens ålder, INTE dess färskhet. Är rutan känd sedan förut ärver
      -- den nya raden det gamla 'forst'; skrevs det om till nu förlorade
      -- hemmet sin ålder varje gång telefonen råkade vara hemma, och blev
      -- därmed det första gallringen kastade. Rader från före den här
      -- ändringen saknar 'forst' och får sitt 'sedd' som bästa kända ålder.
      select min(coalesce(nullif(g.forst, ''), g.sedd, v_nu))
        into v_forst
        from jsonb_to_recordset(coalesce(v_gamla, '[]'::jsonb))
               as g(lat double precision, lon double precision, sedd text, forst text)
       where g.lat is not null and g.lon is not null
         and round(g.lat::numeric, 4) = round(p_lat::numeric, 4)
         and round(g.lon::numeric, 4) = round(p_lon::numeric, 4);
      v_forst := coalesce(v_forst, v_nu);

      select coalesce(jsonb_agg(p.rad order by p.ny desc, p.forst asc), '[]'::jsonb)
        into v_nya
        from (
          select jsonb_build_object('lat', q.lat, 'lon', q.lon,
                                    'sedd', q.sedd, 'forst', q.forst) as rad,
                 q.ny, q.forst
            from (
              -- Den nya punkten först, sedan de gamla som inte är samma ruta.
              select p_lat as lat, p_lon as lon, v_nu as sedd, v_forst as forst, 1 as ny
              union all
              select g.lat, g.lon, coalesce(g.sedd, '1970-01-01T00:00:00Z'),
                     coalesce(nullif(g.forst, ''), g.sedd, '1970-01-01T00:00:00Z'), 0
                from jsonb_to_recordset(coalesce(v_gamla, '[]'::jsonb))
                       as g(lat double precision, lon double precision, sedd text, forst text)
               where g.lat is not null and g.lon is not null
                 and (round(g.lat::numeric, 4) is distinct from round(p_lat::numeric, 4)
                      or round(g.lon::numeric, 4) is distinct from round(p_lon::numeric, 4))
            ) q
           -- ny först, sedan äldst känd. Se resonemanget ovanför funktionen:
           -- den som varit känd längst är den som får stanna.
           order by q.ny desc, q.forst asc
           limit 8
        ) p;

      update public.push_subscriptions s
         set notis_platser = v_nya,
             updated_at = now()
       where s.endpoint = p_endpoint and s.device_id = v_actor
         and coalesce(s.notis_folj, false);

      get diagnostics v_n = row_count;

      if v_n = 0 then
        return jsonb_build_object('ok', false, 'rader', 0, 'skal', 'ingen-rad');
      end if;

      -- Antalet, aldrig punkterna. Appen behöver veta ATT den vet var den hör
      -- hemma, inte VAR det är — och ett svar som bär hempunkterna är ett svar
      -- som hamnar i localStorage hos nästa utvecklare som tycker det är
      -- praktiskt.
      return jsonb_build_object('ok', true, 'rader', v_n, 'skal', null,
                                'platser', jsonb_array_length(v_nya),
                                'radie_m', v_radie, 'folj', true);
    end $kropp1$;
  $fn1$;

  -- ---------------------------------------------------------------------
  -- REGLAGETS VÄG IN
  --
  -- p_folj = false är "Hela landet", och den nollar notis_platser i SAMMA
  -- update som den nollar notis_folj. Gjorde den bara det ena skulle
  -- automatiken fylla på listan igen vid nästa GPS-fix och användaren få
  -- tillbaka ett filter hen precis stängt av — den sortens fel man får
  -- rapporterat som "appen ändrar sig själv".
  --
  -- Radien klampas HÄR och inte i klienten. En radie på 500 m vore en tyst
  -- avstängning av notiserna, och den ska inte gå att skicka in — varken av en
  -- bugg i ett reglage eller av någon som provar sig fram mot API:et.
  execute $fn2$
    create or replace function public.fbmejl_satt_notisomfang(
      p_endpoint text, p_device text,
      p_folj boolean, p_radie_m int
    )
    returns jsonb
    language plpgsql security definer set search_path = public, pg_temp as $kropp2$
    declare
      v_actor  text;
      v_folj   boolean;
      v_radie  int;
      v_antal  int;
      v_n      int;
    begin
      v_actor := public.actor(p_device);
      v_radie := greatest(25000, least(coalesce(p_radie_m, 100000), 300000));

      update public.push_subscriptions s
         set notis_folj    = coalesce(p_folj, false),
             notis_radie_m = v_radie,
             notis_platser = case when coalesce(p_folj, false) then s.notis_platser else null end,
             updated_at    = now()
       where s.endpoint = p_endpoint and s.device_id = v_actor
      returning coalesce(s.notis_folj, false),
                coalesce(s.notis_radie_m, 100000),
                coalesce(jsonb_array_length(s.notis_platser), 0)
           into v_folj, v_radie, v_antal;

      get diagnostics v_n = row_count;

      if v_n = 0 then
        return jsonb_build_object('ok', false, 'rader', 0, 'skal', 'ingen-rad',
                                  'folj', false, 'radie_m', null, 'platser', 0);
      end if;

      return jsonb_build_object('ok', true, 'rader', v_n, 'skal', null,
                                'folj', v_folj, 'radie_m', v_radie,
                                'platser', v_antal);
    end $kropp2$;
  $fn2$;

  -- ---------------------------------------------------------------------
  -- LÄS TILLBAKA SANNINGEN
  --
  -- Spegling av fbmejl_har_gruppnotiser. aktiv = raden lever (enabled och
  -- under felgränsen), så gränssnittet kan skilja "smalt filter" från
  -- "utslagen prenumeration" — två lägen som ser identiska ut från appen och
  -- kräver helt olika svar av användaren.
  execute $fn3$
    create or replace function public.fbmejl_har_notisomfang(
      p_endpoint text, p_device text
    )
    returns jsonb
    language plpgsql security definer stable set search_path = public, pg_temp as $kropp3$
    declare
      v_actor text;
      v_folj  boolean;
      v_radie int;
      v_antal int;
      v_aktiv boolean;
    begin
      v_actor := public.actor(p_device);

      select coalesce(s.notis_folj, false),
             coalesce(s.notis_radie_m, 100000),
             coalesce(jsonb_array_length(s.notis_platser), 0),
             (s.enabled and s.failures < 5)
        into v_folj, v_radie, v_antal, v_aktiv
        from public.push_subscriptions s
       where s.endpoint = p_endpoint and s.device_id = v_actor;

      if not found then
        return jsonb_build_object('finns', false, 'folj', false, 'radie_m', null,
                                  'antal_platser', 0, 'aktiv', false);
      end if;

      return jsonb_build_object('finns', true, 'folj', v_folj, 'radie_m', v_radie,
                                'antal_platser', v_antal,
                                'aktiv', coalesce(v_aktiv, false));
    end $kropp3$;
  $fn3$;

  execute 'revoke execute on function public.fbmejl_satt_notisplats(text, text, double precision, double precision) from public';
  execute 'grant  execute on function public.fbmejl_satt_notisplats(text, text, double precision, double precision) to anon, authenticated';
  execute 'revoke execute on function public.fbmejl_satt_notisomfang(text, text, boolean, int) from public';
  execute 'grant  execute on function public.fbmejl_satt_notisomfang(text, text, boolean, int) to anon, authenticated';
  execute 'revoke execute on function public.fbmejl_har_notisomfang(text, text) from public';
  execute 'grant  execute on function public.fbmejl_har_notisomfang(text, text) to anon, authenticated';

  raise notice 'fbmejl_satt_notisplats(), fbmejl_satt_notisomfang() och fbmejl_har_notisomfang() finns.';
exception when others then
  raise notice 'Kunde inte skapa notisomfangs-funktionerna (%). Filtret ar anda pa plats och slapper igenom alla.', sqlerrm;
end $$;

-- =====================================================================
--  7. RÄTTIGHETER
-- =====================================================================
--
-- Mottagarlistan lämnar ut endpoint och auth-hemlighet i klartext. Den är
-- service_role och ingenting annat — båda överlagringarna, för en överlagring
-- utan grant är en överlagring man upptäcker för sent.
--
-- create or replace rör inte proacl, så de befintliga signaturerna behåller
-- vad de hade. Raderna står ändå uttryckligen, så att filen ger rätt läge
-- också på en databas där någon skruvat på dem.

revoke execute on function public.fbmejl_push_mottagare(int)          from public, anon, authenticated;
grant  execute on function public.fbmejl_push_mottagare(int)          to service_role;
revoke execute on function public.fbmejl_push_mottagare(int, jsonb)   from public, anon, authenticated;
grant  execute on function public.fbmejl_push_mottagare(int, jsonb)   to service_role;

revoke execute on function public.fbmejl_gruppnotis_antal()           from public, anon, authenticated;
grant  execute on function public.fbmejl_gruppnotis_antal()           to service_role;
revoke execute on function public.fbmejl_gruppnotis_antal(jsonb)      from public, anon, authenticated;
grant  execute on function public.fbmejl_gruppnotis_antal(jsonb)      to service_role;

revoke execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                      from public, anon, authenticated;
grant  execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                      to service_role;

-- Avståndet är ren matematik utan en enda uppslagning mot en tabell. Samma
-- resonemang som för meningsbyggarna: det avslöjar ingenting, och det ska gå
-- att prova i editorn utan servernyckel — annars provas det inte, och då
-- glider det från distance() i js/util.js.
grant execute on function public.fbmejl_avstand_m(double precision, double precision,
                                                  double precision, double precision)
                                                                      to anon, authenticated, service_role;

commit;

-- =====================================================================
--  SJÄLVPROV
-- =====================================================================
--
-- Kör automatiskt. Går något av påståendena inte igenom avbryts körningen med
-- ett fel som säger vilket — men allt ovan är redan committat, så filen går
-- att köra om efter en rättning.
--
-- Provet rör INTE fbmejl_notis_ut(): den skriver till notisloggen och skulle
-- kunna skicka en riktig push. Bara avståndet, grinden och listan provas här.

do $prov$
declare
  v_m      double precision;
  v_alla   int;
  v_nara   int;
  v_def    text;
  v_lat    int;
begin
  -- Västerås till Stockholm: ~92 km fågelvägen, ~110 km på väg. Det är hela
  -- skälet till att förvalet är 100 000 meter — en radie mätt på kartan och
  -- inte gissad, och tillräckligt generös för att pendlaren ska få
  -- Stockholmsvarningarna utan att röra ett reglage.
  v_m := public.fbmejl_avstand_m(59.6099, 16.5448, 59.3293, 18.0686);
  if v_m < 85000 or v_m > 100000 then
    raise exception 'Avstandet Vasteras-Stockholm blev % m. Ska ligga runt 92 000.', round(v_m);
  end if;

  -- Noll meter till sig själv, utan att asin kastar på ett argument strax
  -- över 1. Det är precis vad least(1, ...) finns för.
  if public.fbmejl_avstand_m(59.6099, 16.5448, 59.6099, 16.5448) <> 0 then
    raise exception 'Avstandet till sig sjalv blev inte noll.';
  end if;

  -- Halva rutdiagonalen vid 60 grader nord. Marginalen i grinden är 20 000 m
  -- och måste vara STÖRRE än det här talet, annars är beviset inget bevis.
  v_m := public.fbmejl_avstand_m(60.0, 16.0, 60.125, 16.25);
  if v_m > 20000 then
    raise exception 'Halva rutdiagonalen ar % m, alltsa storre an marginalen 20 000. Marginalen maste hojas.', round(v_m);
  end if;

  -- Grinden och listan ska ge samma tal så länge ingen har en hemplats.
  -- Gör de inte det är tvåstegs-defaulten fel, och någon har smalnats av som
  -- inte skulle ha blivit det.
  v_alla := public.fbmejl_gruppnotis_antal();
  v_nara := public.fbmejl_gruppnotis_antal('[{"lat":59.6099,"lon":16.5448}]'::jsonb);
  if v_alla is distinct from v_nara then
    raise exception 'Grinden ger % utan filter och % med Vasteras-punkt. Nagon har redan en hemplats — kontrollera att det ar med flit.', v_alla, v_nara;
  end if;

  raise notice 'Sjalvprovet gick igenom: avstandet stammer, marginalen racker, och grinden ar oforandrad (% mottagare).', v_alla;

  -- Och slutligen: ÄR filtret ens vaket? Det kräver att fbmejl_ta_emot
  -- skickar med lat och lon i p_nya, vilket den gör först när
  -- supabase/fbmejl.sql har körts. Titten nedan räknar hur många gånger
  -- funktionen läser fältet lat: en gång betyder bara insert i reports, två
  -- eller fler betyder att koordinaterna också följer med till notisen.
  --
  -- Det är en indikation och inte en dom — läs den som en påminnelse, inte
  -- som ett godkännande.
  begin
    v_def := pg_get_functiondef(to_regprocedure('public.fbmejl_ta_emot(jsonb)'));
    v_lat := coalesce(array_length(string_to_array(v_def, '->>''lat'''), 1), 1) - 1;
    if v_lat < 2 then
      raise notice 'FILTRET AR INERT: fbmejl_ta_emot skickar inga koordinater till notisen an. Alla far allt, precis som forut. Kor supabase/fbmejl.sql for att vacka filtret.';
    else
      raise notice 'Filtret ar vaket: fbmejl_ta_emot skickar koordinater vidare till notisen.';
    end if;
  exception when others then
    raise notice 'Kunde inte lasa fbmejl_ta_emot (%). Hoppar over inert-kontrollen.', sqlerrm;
  end;
end $prov$;

-- =====================================================================
--  KONTROLL
-- =====================================================================
--
-- Kör de här efteråt och läs svaren.
--
-- 1. Ingen prenumerant tappad, och ingen avsmalnad. Ska ge lika många rader
--    som före körningen, alla med folj = false och platser = 0.

-- select count(*)                                             as prenumeranter,
--        count(*) filter (where enabled)                      as aktiva,
--        count(*) filter (where coalesce(gruppnotiser, false)) as med_gruppnotiser,
--        count(*) filter (where notis_folj)                   as foljer_med,
--        count(*) filter (where notis_platser is not null)    as har_hemplats
--   from public.push_subscriptions;

-- 2. Grinden och listan är inte längre oense. De två talen ska vara IDENTISKA.
--    Är de olika är det inte den här filen som är fel — det är den bugg filen
--    rättar, och den syns nu.

-- select public.fbmejl_gruppnotis_antal()                        as grinden,
--        (select count(*) from public.fbmejl_push_mottagare(5000)) as listan;

-- 3. Filtret, provat utan att skicka något. Första talet ska vara alla,
--    andra ska också vara alla (ingen har hemplats än), och tredje likaså.
--    Den dagen någon har en hemplats i Västerås ska det tredje talet SJUNKA.

-- select public.fbmejl_gruppnotis_antal(null)                                as utan_filter,
--        public.fbmejl_gruppnotis_antal('[{"lat":59.61,"lon":16.55}]'::jsonb) as vasteras,
--        public.fbmejl_gruppnotis_antal('[{"lat":55.60,"lon":13.00}]'::jsonb) as malmo;

-- 4. Räckvidden över tid. Ligger den nära 100 gör filtret ingenting, vilket är
--    det väntade i Västmanland i dag. Sjunker den brant efter att en ny grupp
--    kopplats in är det antingen filtret som arbetar eller en radie som är för
--    snål. Noll rader betyder bara att ingen notis gått ut på en vecka.

-- select count(*)                                            as omgangar,
--        sum(mottagare_inom)                                 as fick,
--        sum(mottagare_totalt)                               as kunde_fatt,
--        round(avg(nullif(mottagare_inom, 0)::numeric
--                  / nullif(mottagare_totalt, 0)) * 100)     as rackvidd_procent
--   from public.fbmejl_notis_logg
--  where utfall = 'koad' and skickat_at > now() - interval '7 days';

-- 5. Blev någon omgång tyst för att ingen var i närheten? Skäl-texten skiljer
--    de två fallen åt, och skillnaden är hela poängen: 'noll prenumeranter med
--    gruppnotiser pa' betyder att ingen lyssnar, 'noll prenumeranter inom
--    rackhall' betyder att filtret arbetade.

-- select skickat_at, antal, skal, mottagare_inom, mottagare_totalt
--   from public.fbmejl_notis_logg
--  where utfall = 'ingen-mottagare' and skickat_at > now() - interval '7 days'
--  order by skickat_at desc limit 20;

-- 6. Rättigheterna. NOLL rader — mottagarlistan och grinden får aldrig gå att
--    anropa med anon-nyckeln.

-- select p.proname, pg_get_function_identity_arguments(p.oid) as argument, r.rolname
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   cross join lateral aclexplode(p.proacl) a
--   join pg_roles r on r.oid = a.grantee
--  where n.nspname = 'public'
--    and p.proname in ('fbmejl_push_mottagare', 'fbmejl_gruppnotis_antal', 'fbmejl_notis_ut')
--    and r.rolname in ('anon', 'authenticated');

-- 7. Överlagringarna finns, med rätt signatur. Ska ge sex rader:
--    fbmejl_avstand_m, fbmejl_gruppnotis_antal x2, fbmejl_push_mottagare x2,
--    fbmejl_notis_ut — plus de tre nya klientfunktionerna om push.sql är körd.

-- select p.proname, pg_get_function_identity_arguments(p.oid) as argument
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('fbmejl_avstand_m', 'fbmejl_gruppnotis_antal',
--                      'fbmejl_push_mottagare', 'fbmejl_notis_ut',
--                      'fbmejl_satt_notisplats', 'fbmejl_satt_notisomfang',
--                      'fbmejl_har_notisomfang')
--  order by p.proname, argument;

-- 8. Hela kedjan, på riktigt. Kräver gruppnotiser påslaget för din egen
--    telefon. Raden nedan ska ge skapade = 1 och notis.skickad = true.
--    Så länge filtret är inert är notis.platser = 0 i svaret — det är den
--    enklaste kvittensen på vilket läge databasen är i.
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fb:test:notisradie:1', 'type', 'police',
--        'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
--        'note', 'Polis står vid testplatsen',
--        'device_id', 'fb-daemon',
--        'created_at', (extract(epoch from now())*1000)::bigint - 3*60000,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 42*60000)));
--
--    Och provet som aldrig får glömmas bort: en drogkontroll får inte ens ge
--    en notis om att "något hänt", för det VORE varningen. Ska ge skapade 0
--    och vagrade 1, och ingen ny rad i notisloggen.
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fb:test:notisradie:2', 'type', 'police',
--        'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
--        'note', 'Polisen har drog-kontroll vid testplatsen',
--        'device_id', 'fb-daemon',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000)));
--
--    Städa upp efteråt:
--
--      delete from public.fbmejl_lasta where nyckel like 'fb:test:notisradie:%';
--      delete from public.reports      where external_id like 'fb:test:notisradie:%';
--      update public.fbmejl_notis_lage
--         set senaste_at = null, antal_idag = 0, odelade = 0 where id = 1;

-- =====================================================================
--  DEN DAG ÄGAREN VILL ATT GAMLA PRENUMERANTER OCKSÅ SKA FÖLJA MED
-- =====================================================================
--
-- Raden nedan är AVSIKTLIGT bortkommenterad och ska förbli det tills någon
-- fattar beslutet med öppna ögon. Den slår på notis_folj för varje befintlig
-- prenumerant, och först då kan deras appar börja skriva hempunkter — alltså
-- först då kan någon av dem få FÄRRE notiser än i dag.
--
-- Villkoren för att någon över huvud taget ska tappa en varning är fyra, och
-- alla fyra måste gälla samtidigt: notis_folj är true, minst en hemplats är
-- etablerad (två skilda kalenderdygn i samma ruta), varenda rapport i omgången
-- ligger mer än radie plus 20 km från var och en av hens hemplatser, och det
-- finns inga odelade i högen. Tröskeln är 45 km även för den som dragit
-- reglaget till botten.
--
--   -- update public.push_subscriptions set notis_folj = true where enabled;
--
-- =====================================================================
--  OM DEN HÄR FILENS HÅLLBARHET
-- =====================================================================
--
-- Filen är historik dagen efter att den körts. Sanningen bor i
-- supabase/fbmejl.sql, precis som 2026-08-21-brygga-notiskedja.sql redan är
-- överspelad — dess fbmejl_notis_ut läser current_setting() medan den körande
-- läser valvet. Ändringar hör hemma i fbmejl.sql. Rör inte den här filen igen.
--
-- supabase/KOR-ALLT.sql behöver ingen ändring: allt nytt hör hemma i
-- fbmejl.sql, som redan står i körordningen.
--
-- ---------------------------------------------------------------------
-- TILL DEN SOM SKRIVER IN DET HÄR I supabase/fbmejl.sql
--
-- Signaturerna måste bli EXAKT de här, annars får en databas som kört båda
-- filerna två uppsättningar funktioner som skiljer sig i vem som räknas som
-- mottagare — och den skillnaden syns bara som en utebliven notis.
--
--   public.fbmejl_avstand_m(double precision, double precision,
--                           double precision, double precision)
--   public.fbmejl_push_mottagare(int, jsonb)          -- ingen default
--   public.fbmejl_push_mottagare(int default 2000)    -- skalet, anropar den ovan
--   public.fbmejl_gruppnotis_antal(jsonb)             -- ingen default
--   public.fbmejl_gruppnotis_antal()                  -- anropar den ovan
--   public.fbmejl_satt_notisplats(text, text, double precision, double precision)
--   public.fbmejl_satt_notisomfang(text, text, boolean, int)
--   public.fbmejl_har_notisomfang(text, text)
--
-- Och en fälla värd att skriva ut, för den kostar en halv körning att hitta:
-- DROPPA INTE fbmejl_gruppnotis_antal(). Vyn fbmejl_halsa anropar den, och
-- drop svarar "cannot drop function because other objects depend on it" — på
-- varje databas där vyn redan finns, alltså varje databas som kört fbmejl.sql
-- en gång. Ersätt den i stället, som här. Av samma skäl får den nya
-- överlagringen inte ha en default: () och (jsonb default null) hade blivit
-- tvetydiga för de tre nollställiga anropen i fbmejl_notis_konfig,
-- fbmejl_notis_ut och fbmejl_halsa.
