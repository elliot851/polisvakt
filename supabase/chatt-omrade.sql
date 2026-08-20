-- =====================================================================
-- CHATTENS OMRÅDE — ett meddelande hör hemma i en trakt
-- =====================================================================
--
-- Körs EFTER supabase/chatt.sql, i Supabase SQL Editor. Går att köra om hur
-- många gånger som helst. Ingenting här raderar en enda rad: allt är
-- additivt, och befintliga meddelanden får områdeskod null, vilket betyder
-- "utan område" och når alla precis som förut.
--
-- Filen rör INTE chatt.sql. Den lägger till en kolumn, en egen trigger med
-- eget namn, ett villkor och en ny version av vyn. Skulle chatt.sql köras om
-- efteråt står allt det här kvar — det var därför normaliseringen fick en
-- egen trigger istället för att bakas in i chatt_innan_insert, som chatt.sql
-- äger och skriver över med create or replace.
--
-- ---------------------------------------------------------------------
-- OBS OM KOMMENTARER I DEN HÄR FILEN
--
-- Hela filen använder radkommentarer med två bindestreck, aldrig
-- blockkommentarer. Skälet är konkret: en stjärna följd av ett snedstreck
-- avslutar en blockkommentar mitt i raden. Ett cron-uttryck eller ett
-- filnamn med den teckenkombinationen inuti en blockkommentar dödar filen
-- med "syntax error at or near 5", och felet pekar på fel rad. Det har hänt
-- en gång och ska inte hända igen.
--
-- ---------------------------------------------------------------------
-- VAD SOM LÖSES
--
-- Chatten var ett enda rikstäckande rum. Skriver någon i Västerås att polisen
-- står vid Erikslund hjälper det ingen i Malmö, och tvärtom. Ett meddelande
-- ska nå förare i avsändarens närområde.
--
-- ---------------------------------------------------------------------
-- VARFÖR RUTNÄT OCH INTE LÄN
--
--   1. Länsgränser skär rakt genom vardagen. Den som kör två kilometer in i
--      Uppsala län ska självklart se en varning från Västerås. Gränsen finns
--      på en karta, inte på vägen. Ett rutnät ger "nära mig", vilket är det
--      som faktiskt menas med "i Västmanland".
--
--   2. Ingen nätverksslagning. Att slå upp län ur en koordinat kräver ett
--      anrop eller en geometritabell per meddelande. Ett rutnät kräver två
--      divisioner.
--
--   3. INTEGRITET, och det är det tyngsta skälet. Exakta koordinater per
--      chattmeddelande vore en karta över var en enskild person befunnit sig
--      och när. Sju dygn av sådana rader ger hemadress, arbetsplats och
--      vilka kvällar personen inte var hemma. Den kartan får inte finnas,
--      för allt som finns kan begäras ut, läcka eller missbrukas. Det
--      säkraste sättet att inte läcka en logg är att aldrig skapa den.
--
--      En ruta på cirka 25 km säger "trakten", inte "platsen". Hela Västerås
--      med förorter delar en och samma kod. Det räcker för att avgöra om ett
--      meddelande angår mig, och det räcker inte för att följa någon.
--
--      DÄRFÖR: lagra ALDRIG lat eller lon på ett chattmeddelande. Det finns
--      ingen kolumn för det här, och det ska inte tillkomma någon. Behöver
--      något i framtiden veta var ett meddelande kom ifrån är svaret rutan,
--      inte punkten.
--
-- ---------------------------------------------------------------------
-- SÅ RÄKNAS KODEN
--
--   latitudindex  = floor(lat / 0,25)     0,25 grad = cirka 27,8 km
--   longitudindex = floor(lon / 0,5)      0,5 grad  = cirka 31 km i Skåne,
--                                                     cirka 21 km i Kiruna
--   kod = 'r' + latitudindex + 'x' + longitudindex
--
-- Västerås (59,6099 / 16,5448) blir r238x33.
-- Malmö    (55,6050 / 13,0038) blir r222x26.
--
-- Fasta steg i grader gör grannrutorna till ren heltalsaddition. Att rutan
-- blir smalare långt norrut är medvetet och skadar ingen.
--
-- Klienten hämtar sin egen ruta plus de åtta omkringliggande. Nio och inte
-- en, eftersom rutnätet är godtyckligt utlagt: står man femtio meter från en
-- rutkant ligger halva "nära mig" i grannrutan.
--
-- Identisk räkning finns i js/chatt.js (rutkod och grannrutor). De kan inte
-- dela kod — det ena är JavaScript i en webbläsare, det andra SQL i Postgres
-- — men de får inte gå isär. Ändras stegen här ska de ändras där.
--
-- ---------------------------------------------------------------------
-- VARFÖR SERVERN VALIDERAR I STÄLLET FÖR ATT HÄRLEDA
--
-- Kravet är att rutan inte ska gå att förfalska till något som avslöjar mer,
-- och att servern inte ska lita blint på klienten.
--
-- Att låta servern HÄRLEDA koden vore att låta klienten skicka lat och lon.
-- Då hade koordinaterna passerat PostgREST, legat i request-loggen och
-- funnits i minnet på en maskin utanför telefonen — precis den exponering
-- hela konstruktionen finns för att undvika. Att härleda hade alltså gjort
-- integriteten sämre, inte bättre.
--
-- Servern VALIDERAR och NORMALISERAR i stället, i två led:
--
--   chatt_rutkod_normalisera(text) plockar ut exakt två heltal ur strängen,
--   avvisar allt som inte har den formen, avvisar index utanför Norden och
--   BYGGER OM strängen från heltalen. Det som lagras är alltså aldrig det
--   klienten skickade, utan serverns egen sammansättning av två avgränsade
--   tal.
--
--   Villkoret chatt_omrade_form kräver att kolumnen är lika med sin egen
--   normalisering. Det gäller insert och update, det syns i schemat och det
--   överlever att triggern skulle försvinna.
--
-- Vad det köper: fältet kan inte bära mer information än en ruta. Ingen kan
-- smyga in "r238x33 59.60991,16.54483", en tidsstämpel eller ett spår-id i
-- kolumnen. Det är det verkliga hotet mot en positionskolumn — att den blir
-- en dold kanal för exakt position.
--
-- Vad det INTE köper: servern kan inte veta om koden är SANN. En klient kan
-- påstå att den står i Kiruna. Men det ger ingenting: den som ljuger ser en
-- annan trakts chatt, och den chatten var rikstäckande och öppen för alla
-- inloggade redan innan den här filen fanns. Ingen rättighet vinns, och
-- skrivbromsen i chatt.sql gäller oförändrat. Att sätta koden till null och
-- nå alla är samma sak som läget före den här filen.
--
-- Ogiltig kod ger null, inte ett fel. Meddelandet går alltså igenom och
-- märks "utan område". Att avvisa hade tystat någon på grund av ett
-- teknikfel, och tystnad är den dyraste utgången i den här appen.
--
-- ---------------------------------------------------------------------
-- MODELLEN EFTER DEN HÄR FILEN
--
--   chatt_meddelanden.omrade   text, null tillåtet. null = utan område.
--   chatt_flode.omrade         samma kod. Fortfarande INGEN avsandare.
-- =====================================================================

begin;

-- ===================== Rutnätet, som funktioner ======================

-- Räknar fram en kod ur en position.
--
-- REFERENS OCH SJÄLVTEST, INGET ANNAT. Den anropas aldrig på insert-vägen
-- och är med flit inte utdelad till authenticated. Den finns för att
-- kontrollfrågorna längst ner ska kunna visa att servern och js/chatt.js
-- räknar likadant. Skulle någon frestas att anropa den från appen betyder
-- det att appen skickar koordinater till servern, och då är hela poängen
-- borta.
create or replace function public.chatt_rutkod(p_lat double precision,
                                               p_lon double precision)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when p_lat is null or p_lon is null then null
    when p_lat < 54 or p_lat > 72 then null
    when p_lon <  2 or p_lon > 34 then null
    else 'r' || floor(p_lat / 0.25)::bigint::text
              || 'x' || floor(p_lon / 0.5)::bigint::text
  end;
$$;

-- Tar emot en kod från en klient och lämnar tillbaka serverns egen version
-- av den, eller null.
--
-- Ordningen är hela skyddet:
--   1. Trimma och gemener. Formen ska vara kanonisk, inte ungefärlig.
--   2. Matcha mot mönstret. Exakt 'r', heltal, 'x', heltal. Ingenting före,
--      ingenting efter, inga decimaler, inga mellanslag.
--   3. Kontrollera att indexen ligger inom Norden. Det är taket för hur
--      många olika koder som kan finnas, alltså taket för hur mycket
--      kolumnen kan avslöja.
--   4. Bygg om strängen ur heltalen. Efter det här steget finns ingenting
--      kvar av det klienten skrev utom två tal.
create or replace function public.chatt_rutkod_normalisera(p_kod text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_text text := btrim(lower(coalesce(p_kod, '')));
  v_del  text[];
  v_y    bigint;
  v_x    bigint;
begin
  if v_text = '' then
    return null;
  end if;

  v_del := regexp_match(v_text, '^r(-?[0-9]{1,4})x(-?[0-9]{1,4})$');
  if v_del is null then
    return null;
  end if;

  v_y := v_del[1]::bigint;
  v_x := v_del[2]::bigint;

  -- floor(54 / 0,25) = 216 och floor(72 / 0,25) = 288.
  if v_y < 216 or v_y > 288 then
    return null;
  end if;
  -- floor(2 / 0,5) = 4 och floor(34 / 0,5) = 68.
  if v_x < 4 or v_x > 68 then
    return null;
  end if;

  return 'r' || v_y::text || 'x' || v_x::text;
end $$;

-- De nio koder som räknas som "nära" en given kod.
--
-- Klienten bygger sin egen lista och skickar den i frågan; den här finns för
-- kontroll och för framtida serverside-frågor. Håll dem lika.
create or replace function public.chatt_grannrutor(p_kod text)
returns text[]
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_kod  text := public.chatt_rutkod_normalisera(p_kod);
  v_del  text[];
  v_y    bigint;
  v_x    bigint;
  v_ut   text[] := '{}';
  v_dy   int;
  v_dx   int;
begin
  if v_kod is null then
    return null;
  end if;
  v_del := regexp_match(v_kod, '^r(-?[0-9]+)x(-?[0-9]+)$');
  v_y := v_del[1]::bigint;
  v_x := v_del[2]::bigint;
  for v_dy in -1 .. 1 loop
    for v_dx in -1 .. 1 loop
      v_ut := v_ut || ('r' || (v_y + v_dy)::text || 'x' || (v_x + v_dx)::text);
    end loop;
  end loop;
  return v_ut;
end $$;

-- ========================== Kolumnen ================================

-- Additivt och idempotent. Null tillåtet, inget default.
--
-- Null betyder "utan område" och är rätt svar i två fall: befintliga rader
-- som skrevs innan den här filen fanns, och nya meddelanden från någon utan
-- GPS-läsning. Båda ska synas för alla. Ett default hade satt en påhittad
-- ruta på båda, vilket är sämre än att erkänna att den saknas.
alter table public.chatt_meddelanden
  add column if not exists omrade text;

comment on column public.chatt_meddelanden.omrade is
  'Grov områdesruta, cirka 25 km. Aldrig en position. null = utan område, syns för alla.';

-- Index för frågan appen faktiskt ställer: några få koder eller null, nyast
-- först, hundra rader. Utan det blir varje pollning en full genomsökning, och
-- pollningar är det enda som händer hela tiden. Btree indexerar null, så
-- samma index betjänar även grenen omrade is null.
create index if not exists chatt_meddelanden_omrade_idx
  on public.chatt_meddelanden (omrade, skapad_at desc);

-- Formen, som villkor.
--
-- Deklarativt och inte som trigger: det gäller insert och update, det syns i
-- schemat, och det håller även om triggern nedan skulle försvinna. Villkoret
-- kan bara falla om normaliseringstriggern är borta — normaliserad kod är
-- per definition lika med sin egen normalisering.
alter table public.chatt_meddelanden
  drop constraint if exists chatt_omrade_form;
alter table public.chatt_meddelanden
  add constraint chatt_omrade_form check (
    chatt_meddelanden.omrade is null
    or chatt_meddelanden.omrade = public.chatt_rutkod_normalisera(chatt_meddelanden.omrade)
  );

-- ===================== Normalisering vid insert ======================

-- Egen trigger, eget namn, egen funktion.
--
-- Den här logiken hör hemma i chatt_innan_insert, men den funktionen ägs av
-- chatt.sql och skrivs över med create or replace varje gång den filen körs.
-- Bakades normaliseringen in där skulle en omkörning av chatt.sql tyst ta
-- bort den, och kolumnen hade börjat ta emot vad som helst tills villkoret
-- ovan avvisade hela meddelandet. Två triggrar som inte känner till varandra
-- är billigare än ett beroende som går sönder utan att någon märker det.
--
-- Postgres kör BEFORE INSERT-triggrar i bokstavsordning på namnet.
-- chatt_innan_insert_trg går först, chatt_omrade_innan_insert_trg efter. De
-- rör olika kolumner, så ordningen spelar ingen roll — men den är känd.
create or replace function public.chatt_omrade_innan_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $$
begin
  -- Skräp blir null, inte ett fel. Meddelandet går fram och märks "utan
  -- område". Att avvisa hade tystat någon på grund av ett teknikfel.
  new.omrade := public.chatt_rutkod_normalisera(new.omrade);
  return new;
end $$;

drop trigger if exists chatt_omrade_innan_insert_trg on public.chatt_meddelanden;
create trigger chatt_omrade_innan_insert_trg
  before insert on public.chatt_meddelanden
  for each row execute function public.chatt_omrade_innan_insert();

-- ============================== Vyn =================================

-- Samma vy som i chatt.sql, plus omrade. Allt annat oförändrat, och det
-- viktigaste är det som fortfarande INTE står här: avsandare.
--
-- Kolumnen avsandare är samma uuid som auth.uid(), och det id:t används i
-- reporter_scores och i rapporternas device_id. Skulle chatten publicera det
-- vore varje meddelande en koppling mellan en person i topplistan och allt
-- hen skrivit. Vyn körs därför fortfarande med ägarens rättigheter, INTE
-- security_invoker, och inloggningskravet ligger kvar i vyn själv.
--
-- Det som läggs till är rutan. Inte positionen. Det finns ingen kolumn med
-- lat eller lon att lägga till, och det ska inte tillkomma någon.
--
-- drop före create: create or replace view vägrar när kolumnlistan ändras.
drop view if exists public.chatt_flode;

create view public.chatt_flode as
  select
    m.id,
    m.skapad_at,
    m.text,
    m.visningsnamn,
    m.omrade,
    md5(m.avsandare::text || 'polisvakt-chatt-v1') as avsandarnyckel,
    (m.avsandare = auth.uid())                     as mitt
  from public.chatt_meddelanden m
  where auth.uid() is not null;

-- =========================== Rättigheter =============================

-- drop view tar bort vyns grants. De måste sättas om, annars får appen
-- "permission denied for view chatt_flode" och chatten blir helt tyst.
revoke all on public.chatt_flode from anon, authenticated;
grant select on public.chatt_flode to authenticated;

-- Funktioner tilldelas PUBLIC automatiskt i Postgres. Att bara låta bli att
-- grant:a räcker inte — den underförstådda rättigheten ligger kvar.
revoke all on function public.chatt_rutkod(double precision, double precision) from public;
revoke all on function public.chatt_rutkod_normalisera(text)                   from public;
revoke all on function public.chatt_grannrutor(text)                           from public;
revoke all on function public.chatt_omrade_innan_insert()                      from public;

-- Ett nödvändigt undantag, exakt samma fälla som chatt_ar_nykterhet i
-- chatt.sql gick i:
--
-- En funktion i ett CHECK-villkor körs som den som gör insertet, och Postgres
-- kontrollerar EXECUTE-rätten då. Utan raden nedan avvisas VARJE meddelande
-- med "permission denied for function chatt_rutkod_normalisera". Chatten
-- hade varit helt tyst, av rätt skäl fast fel orsak.
--
-- Att lämna ut den kostar ingenting: den svarar bara med en städad version av
-- en sträng den redan fått.
grant execute on function public.chatt_rutkod_normalisera(text) to authenticated;

commit;

-- ============================ Kontroll ===============================
--
-- Kör de här efteråt för att se att det blev rätt.
--
-- 1. Rutnätet räknar som js/chatt.js. Ska ge r238x33 och r222x26:
--
--      select public.chatt_rutkod(59.6099, 16.5448) as vasteras,
--             public.chatt_rutkod(55.6050, 13.0038) as malmo;
--
-- 2. Malmö ligger INTE i Västerås grannrutor. Ska ge false:
--
--      select 'r222x26' = any(public.chatt_grannrutor('r238x33'));
--
--    Och Västerås ligger i sina egna. Ska ge true:
--
--      select 'r238x33' = any(public.chatt_grannrutor('r238x33'));
--
-- 3. Normaliseringen släpper bara igenom rena koder. Alla fyra ska ge null:
--
--      select public.chatt_rutkod_normalisera('r238x33 59.6099,16.5448'),
--             public.chatt_rutkod_normalisera('r238.4x33.09'),
--             public.chatt_rutkod_normalisera('r999x999'),
--             public.chatt_rutkod_normalisera('hej');
--
--    Och en ren kod går igenom oförändrad. Ska ge r238x33:
--
--      select public.chatt_rutkod_normalisera('  R238X33 ');
--
-- 4. Vyn ska ha områdeskoden men INTE avsandare. Ska ge sju namn:
--    id, skapad_at, text, visningsnamn, omrade, avsandarnyckel, mitt.
--
--      select column_name from information_schema.columns
--      where table_name = 'chatt_flode';
--
--    Står avsandare med är något allvarligt fel.
--
-- 5. Befintliga meddelanden ska ha överlevt som "utan område". Antalet ska
--    vara samma som före körningen, och alla gamla rader ska ha null:
--
--      select count(*) as totalt,
--             count(*) filter (where omrade is null) as utan_omrade
--      from public.chatt_meddelanden;
--
-- 6. Ingen kolumn med koordinater ska finnas. Ska ge noll rader, alltid:
--
--      select column_name from information_schema.columns
--      where table_name = 'chatt_meddelanden'
--        and column_name in ('lat', 'lon', 'latitude', 'longitude', 'position');
--
-- 7. Frågan appen ställer, för hand. Ska bara ge trakten plus det som saknar
--    område:
--
--      select id, omrade from public.chatt_flode
--      where omrade in ('r237x32','r237x33','r237x34',
--                       'r238x32','r238x33','r238x34',
--                       'r239x32','r239x33','r239x34')
--         or omrade is null
--      order by skapad_at desc limit 100;
--
-- =====================================================================
