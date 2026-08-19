-- Polisvakt — körningspåminnelse
--
-- Körs i Supabase SQL Editor EFTER schema.sql och push.sql. Filen är skriven
-- för att kunna köras om hur många gånger som helst utan att förstöra data.
--
-- =========================================================================
-- VAD DEN HÄR FILEN LÖSER
--
-- En varningsapp som inte är påslagen varnar för ingenting. Det uppenbara
-- svaret — känn av via GPS att bilen börjar rulla — går INTE i en webbapp,
-- och det är mätt i webbläsaren, inte antaget:
--
--   * navigator.geolocation är `undefined` inne i en ServiceWorker. Inte
--     "kräver tillstånd" — objektet finns inte. En service worker kan alltså
--     aldrig läsa position.
--   * Geofencing-API:t finns inte i någon webbläsare i drift.
--   * En sida som inte ligger framme fryses: inga timers, inga fixar.
--
-- Kvar finns en enda väg som faktiskt fungerar med appen helt stängd, även på
-- iPhone (för appar som lagts till på hemskärmen): en web push som SERVERN
-- skickar vid de tider användaren brukar köra. Det är den vägen som byggs
-- här. Klienten lär sig fönstren (js/korvanor.js) och laddar upp dem;
-- servern skickar. Se docs/korpaminnelse.md.
--
-- =========================================================================
-- FÖRHÅLLANDET TILL push.sql
--
-- push_subscriptions har redan en kolumn `slots`. Den fungerar, men den vet
-- bara VILKA timmar — inte hur starkt mönstret är, inte hur många gånger det
-- setts. Utan det går det inte att skilja "kör varje måndag i tre månader"
-- från "körde tre måndagar av tolv", och den skillnaden är hela skillnaden
-- mellan en nyttig notis och en som får någon att stänga av notiser för gott.
--
-- Tabellen nedan lägger till den kunskapen som en egen tabell per fönster,
-- med radsäkerhet — i stället för att bredda push_subscriptions, som med
-- flit är helt oläsbar för klienten (den innehåller pushnycklar).
--
-- Utskicksspärrarna (last_sent_at, sent_today, sent_date, last_slot) DELAS
-- med push.sql med flit. Två system som räknar var sitt tak hade gett
-- dubbelt så många notiser som något av dem lovar. Kör man den här filen är
-- due_kor_paminnelser den funktion cronjobbet ska anropa — inte
-- due_push_reminders. Kör aldrig båda.
-- =========================================================================

/* =========================== TABELLEN =============================== */

create table if not exists public.kor_fonster (
  /**
   * Ägaren, i samma form som resten av schemat: public.actor() ger
   * auth.uid() för inloggade och det slumpade enhets-id:t för gäster.
   * Samma värde som push_subscriptions.device_id, vilket är det som gör
   * join:en i due_kor_paminnelser möjlig.
   */
  agare       text not null,

  /**
   * Fönstret som ett platt nummer 0–167: veckodag × 24 + timme.
   *
   * Veckodagen är JavaScripts getDay() där 0 = söndag — exakt samma numrering
   * som Postgres extract(dow). Det är hela skälet till att kodningen valdes
   * framför något mer läsbart: ingen omräkning behövs på någondera sidan, och
   * en omräkning som görs på ett ställe men glöms på det andra ger
   * påminnelser på fel veckodag utan att något syns i loggen.
   *
   * Samma kodning som js/korvanor.js -> slotsFromFonster() och
   * js/push.js -> slotsFromHabits().
   */
  slot        smallint not null check (slot between 0 and 167),

  /** Antal gånger fönstret setts. Distinkta dygn, inte antal GPS-fixar. */
  antal       smallint not null default 0 check (antal >= 0),

  /**
   * Andel av tillfällena: 3 måndagar av 3 = 1,0, 3 av 12 = 0,25.
   *
   * Utan andelen räcker det att köra länge nog för att allting ska se ut som
   * en vana. Antal ensamt kan inte skilja ett mönster från ihärdighet.
   */
  andel       real not null default 0 check (andel >= 0 and andel <= 1),

  /** Tidszonen fönstret lärdes in i. Se kommentaren vid due_kor_paminnelser. */
  tidszon     text not null default 'Europe/Stockholm',

  uppdaterad  timestamptz not null default now(),

  primary key (agare, slot)
);

create index if not exists kor_fonster_slot_idx on public.kor_fonster (slot);

/* ========================= RADSÄKERHET ============================== */
/**
 * Var och en ser och skriver bara sitt eget.
 *
 * Och en ärlig brasklapp, för den som läser policyerna nedan och undrar:
 *
 * För INLOGGADE är det här riktig isolering. auth.uid() kommer ur en signerad
 * JWT som klienten inte kan förfalska, och `agare = auth.uid()::text` går
 * därför inte att komma runt.
 *
 * För GÄSTER finns ingen sådan garanti att ge. Ett device_id ligger i
 * localStorage och är inget hemligt påstående — en policy som jämför mot ett
 * värde klienten själv skickar in vore teater, den ser ut som säkerhet utan
 * att vara det. Därför får anon ingen policy alls, och gästens väg går genom
 * spara_kor_fonster() nedan, som är security definer och tar identiteten ur
 * public.actor(). Det gästen får är att ingen kan LISTA andras rader och att
 * ingen kan skriva utan att känna till ett id — inte kryptografisk isolering.
 *
 * Att det är acceptabelt beror på vad som står i tabellen: veckodag, timme
 * och en räknare. Ingen position, inget innehåll, inga nycklar. Skulle
 * tabellen någon gång få ett känsligt fält måste den här texten läsas om.
 */
alter table public.kor_fonster enable row level security;

drop policy if exists kor_fonster_egna_las    on public.kor_fonster;
drop policy if exists kor_fonster_egna_skapa  on public.kor_fonster;
drop policy if exists kor_fonster_egna_andra  on public.kor_fonster;
drop policy if exists kor_fonster_egna_radera on public.kor_fonster;

create policy kor_fonster_egna_las on public.kor_fonster
  for select to authenticated
  using (agare = auth.uid()::text);

create policy kor_fonster_egna_skapa on public.kor_fonster
  for insert to authenticated
  with check (agare = auth.uid()::text);

create policy kor_fonster_egna_andra on public.kor_fonster
  for update to authenticated
  using (agare = auth.uid()::text)
  with check (agare = auth.uid()::text);

create policy kor_fonster_egna_radera on public.kor_fonster
  for delete to authenticated
  using (agare = auth.uid()::text);

-- Gäster kommer inte in direkt. De går via funktionen nedan.
revoke all on public.kor_fonster from anon;
grant select, insert, update, delete on public.kor_fonster to authenticated;

/* ==================== FUNKTIONER FÖR KLIENTEN ======================= */

/**
 * Ersätt hela uppsättningen fönster för en användare.
 *
 * Hela uppsättningen, inte enskilda rader, och med flit: klienten räknar om
 * allt från sin historik varje gång (js/korvanor.js -> larFonster). Ett
 * fönster som försvunnit ur mönstret — man har bytt jobb, slutat träna på
 * torsdagar — måste försvinna även här. En funktion som bara lägger till
 * hade byggt upp ett arkiv av gamla vanor som skickar notiser i evighet.
 *
 * p_slots, p_antal och p_andel är parallella listor. Blir de olika långa är
 * det ett klientfel, och då är det bättre att avvisa än att para ihop fel
 * siffra med fel fönster.
 *
 * Nattfönster (23–05) avvisas här också, inte bara i klienten. Servern får
 * aldrig lita på att klienten filtrerat: en felinlärd nattlucka som slinker
 * igenom väcker någon 03:00, och den användaren stänger av notiser samma
 * morgon.
 */
create or replace function public.spara_kor_fonster(
  p_device  text,
  p_slots   int[],
  p_antal   int[]   default null,
  p_andel   real[]  default null,
  p_timezone text   default 'Europe/Stockholm')
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_agare text;
  v_tz    text;
  v_n     int;
  i       int;
  v_slot  int;
  v_kvar  int := 0;
begin
  v_agare := public.actor(p_device);
  if v_agare is null or v_agare = '' then
    raise exception 'saknar identitet';
  end if;

  p_slots := coalesce(p_slots, '{}'::int[]);
  v_n := coalesce(array_length(p_slots, 1), 0);

  if v_n > 168 then
    raise exception 'för många fönster (%). Max 168.', v_n;
  end if;
  if p_antal is not null and coalesce(array_length(p_antal, 1), 0) <> v_n then
    raise exception 'p_antal har fel längd';
  end if;
  if p_andel is not null and coalesce(array_length(p_andel, 1), 0) <> v_n then
    raise exception 'p_andel har fel längd';
  end if;

  -- valid_timezone() kommer från push.sql och finns med av ett skäl som inte
  -- är kosmetiskt: en enda rad med skräp i tidszonsfältet får
  -- "now() at time zone tz" att kasta i urvalsfrågan nedan, och då dör HELA
  -- frågan. Alla användares påminnelser slutar fungera på grund av en telefon.
  -- Skräpet stoppas därför vid skrivning, inte vid läsning.
  v_tz := case when public.valid_timezone(p_timezone) then p_timezone else 'Europe/Stockholm' end;

  -- Bort med det som inte längre är en vana.
  --
  -- "not exists", inte "not in". Med NULL i p_slots ger NOT IN alltid NULL
  -- för varje rad, WHERE släpper bara igenom sant, och raderingen tar då
  -- INGENTING — gamla fönster hade legat kvar och skickat notiser i evighet
  -- utan att något ser fel ut.
  delete from kor_fonster f
   where f.agare = v_agare
     and not exists (select 1 from unnest(p_slots) as x where x = f.slot);

  for i in 1 .. v_n loop
    v_slot := p_slots[i];
    continue when v_slot is null or v_slot < 0 or v_slot > 167;
    -- Nattspärren. mod 24 ger timmen ur den platta koden.
    continue when (v_slot % 24) >= 23 or (v_slot % 24) < 5;

    insert into kor_fonster as f (agare, slot, antal, andel, tidszon, uppdaterad)
    values (
      v_agare, v_slot::smallint,
      least(greatest(coalesce(p_antal[i], 0), 0), 32000)::smallint,
      least(greatest(coalesce(p_andel[i], 0), 0), 1)::real,
      v_tz, now())
    on conflict (agare, slot) do update set
      antal      = excluded.antal,
      andel      = excluded.andel,
      tidszon    = excluded.tidszon,
      uppdaterad = now();

    v_kvar := v_kvar + 1;
  end loop;

  return v_kvar;
end $$;

/** Stäng av körningspåminnelsen helt. Tar bort alla fönster. */
create or replace function public.rensa_kor_fonster(p_device text)
returns int
language plpgsql security definer set search_path = public as $$
declare v_agare text; n int;
begin
  v_agare := public.actor(p_device);
  delete from kor_fonster where agare = v_agare;
  get diagnostics n = row_count;
  return n;
end $$;

/**
 * Läs tillbaka sina egna fönster. För inställningsrutan.
 *
 * Returnerar bara den anropandes egna rader — funktionen tar identiteten ur
 * actor(), aldrig ur ett argument som säger vems rader man vill se.
 */
create or replace function public.mina_kor_fonster(p_device text)
returns table (slot smallint, antal smallint, andel real, tidszon text)
language sql security definer set search_path = public stable as $$
  select f.slot, f.antal, f.andel, f.tidszon
    from kor_fonster f
   where f.agare = public.actor(p_device)
   order by f.slot;
$$;

grant execute on function public.spara_kor_fonster(text, int[], int[], real[], text) to anon, authenticated;
grant execute on function public.rensa_kor_fonster(text)                             to anon, authenticated;
grant execute on function public.mina_kor_fonster(text)                              to anon, authenticated;

/* ===================== FUNKTIONEN FÖR SERVERN ======================= */

/**
 * Vilka ska påminnas just nu? Enda frågan cronjobbet ställer.
 *
 * Anropas var femte minut. p_lead_minutes är hur långt före fönstret
 * påminnelsen ska komma — 15 minuter räcker för jacka och ytterdörr utan att
 * man hinner glömma den igen.
 *
 * OM "at time zone f.tidszon", som är den viktigaste raden i hela filen:
 *
 *   Supabase kör UTC. Sverige ligger UTC+1 på vintern och UTC+2 på sommaren.
 *   Räknas fönstret i UTC hamnar samma morgonrutin — 07:30 varje måndag — i
 *   timme 5 halva året och timme 6 den andra halvan. Påminnelsen som fungerat
 *   hela sommaren kommer en timme fel från sista söndagen i oktober. Ingenting
 *   kraschar, ingenting loggas, den bara kommer vid fel tid — och det upptäcks
 *   av användare, inte av oss. Att lägga på en fast offset är samma bugg med
 *   extra steg. Zonen måste komma från raden och tolkas av Postgres egen
 *   tidszonsdatabas, vilket är precis vad uttrycket nedan gör.
 *
 * Spärrarna finns för att lösa varsitt verkligt problem och ingen av dem är
 * utbytbar mot en annan:
 *
 *   underlaget   antal >= 3 och andel >= 0,4. En påminnelse byggd på en enda
 *                observation är en gissning som stör. Tröskeln finns även i
 *                klienten — den står här också för att servern aldrig får
 *                lita på att klienten filtrerat.
 *   nattspärren  inga notiser 23–05 lokal tid, oavsett vad som står i
 *                tabellen. En felinlärd nattlucka får aldrig ringa i sovrummet.
 *   körspärren   har bilen redan rullat idag hoppas hela dygnet över. En
 *                påminnelse om något man just gjort lär användaren att
 *                notiserna inte är värda att läsa.
 *   luckspärren  en påminnelse per fönster och dygn. Cron kör var femte minut
 *                och skulle annars träffa samma fönster tre gånger i rad.
 *   takspärren   högst två om dygnet och minst 90 minuter emellan. Taket är
 *                det som skyddar kanalen.
 */
create or replace function public.due_kor_paminnelser(
  p_lead_minutes int  default 15,
  p_min_antal    int  default 3,
  p_min_andel    real default 0.4,
  p_limit        int  default 500)
returns table (
  endpoint text,
  p256dh   text,
  auth     text,
  slot     smallint,
  timme    smallint,
  antal    smallint,
  andel    real,
  tidszon  text
)
language sql security definer set search_path = public stable as $$
  with kandidater as (
    select
      s.endpoint, s.p256dh, s.auth,
      s.last_drive_date, s.last_sent_at, s.last_slot, s.sent_date, s.sent_today,
      f.slot, f.antal, f.andel, s.timezone as tz,
      (now() at time zone s.timezone)                                        as lokal,
      (now() at time zone s.timezone) + make_interval(mins => p_lead_minutes) as mal
    from push_subscriptions s
    join kor_fonster f on f.agare = s.device_id
    where s.enabled
      and s.failures < 5
      and f.antal >= p_min_antal
      and f.andel >= p_min_andel
  ),
  med_lucka as (
    select
      k.*,
      (extract(dow from k.mal)::int * 24 + extract(hour from k.mal)::int)::smallint as v_slot,
      extract(hour from k.lokal)::int as v_timme_nu,
      extract(hour from k.mal)::int   as v_timme_mal,
      k.lokal::date                   as v_datum
    from kandidater k
  )
  select
    m.endpoint, m.p256dh, m.auth,
    m.v_slot,
    m.v_timme_mal::smallint,
    m.antal, m.andel, m.tz
  from med_lucka m
  where m.slot = m.v_slot
    -- Natt, både på klockan nu och på fönstrets egen timme.
    and m.v_timme_nu  >= 5 and m.v_timme_nu  < 23
    and m.v_timme_mal >= 5 and m.v_timme_mal < 23
    and (m.last_drive_date is null or m.last_drive_date <> m.v_datum)
    -- "is distinct from", inte "=". På en ny rad är sent_date och last_slot
    -- NULL, och en vanlig jämförelse ger då NULL — inte falskt. NOT NULL är
    -- fortfarande NULL, WHERE släpper bara igenom sant, och resultatet blir
    -- att en nyregistrerad telefon aldrig någonsin får sin första påminnelse.
    -- Ett fel som inte syns i loggen: allt ser rätt ut, det händer bara inget.
    and not (m.sent_date is not distinct from m.v_datum
             and m.last_slot is not distinct from m.v_slot)
    and (m.sent_date is distinct from m.v_datum or m.sent_today < 2)
    and (m.last_sent_at is null or m.last_sent_at < now() - interval '90 minutes')
  order by m.andel desc, m.last_sent_at nulls first
  limit greatest(1, least(p_limit, 2000));
$$;

/**
 * Notera att pushen gick iväg.
 *
 * Skrivs EFTER att pushtjänsten kvitterat, aldrig före. Blir ordningen omvänd
 * och funktionen dör mitt i, är fönstret förbrukat utan att någon notis kommit
 * fram — och användaren får ingenting, den dagen det spelade roll.
 *
 * Skriver i push_subscriptions med flit: spärrarna delas med push.sql så att
 * de två aldrig kan skicka var sin notis samma timme.
 */
create or replace function public.mark_kor_paminnelse(p_endpoint text, p_slot int)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update push_subscriptions s set
    last_sent_at = now(),
    last_slot    = p_slot::smallint,
    sent_today   = case when s.sent_date = (now() at time zone s.timezone)::date
                        then s.sent_today + 1 else 1 end,
    sent_date    = (now() at time zone s.timezone)::date,
    failures     = 0,
    last_error   = null
  where s.endpoint = p_endpoint;
end $$;

/**
 * Städa bort fönster för användare som inte finns kvar.
 *
 * En rad utan matchande prenumeration kan aldrig ge en notis, och en rad som
 * inte rörts på ett halvår hör till en telefon som är borta.
 */
create or replace function public.stada_kor_fonster()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from kor_fonster f
   where f.uppdaterad < now() - interval '180 days'
      or not exists (select 1 from push_subscriptions s where s.device_id = f.agare);
  get diagnostics n = row_count;
  return n;
end $$;

/* ====================== RÄTTIGHETER (VIKTIGT) ======================= */
-- Postgres ger EXECUTE på nya funktioner till PUBLIC som standard. Utan de
-- här raderna kan vem som helst med anon-nyckeln — som ligger öppet i appens
-- källkod, se js/config.js — anropa due_kor_paminnelser och få ut varje
-- användares endpoint och auth-hemlighet i klartext. Med båda kan man skicka
-- valfri notis till valfri telefon, i vårt namn. Det är den allvarligaste
-- enskilda risken i filen.

revoke execute on function public.due_kor_paminnelser(int, int, real, int) from public, anon, authenticated;
revoke execute on function public.mark_kor_paminnelse(text, int)           from public, anon, authenticated;
revoke execute on function public.stada_kor_fonster()                      from public, anon, authenticated;

grant execute on function public.due_kor_paminnelser(int, int, real, int) to service_role;
grant execute on function public.mark_kor_paminnelse(text, int)           to service_role;
grant execute on function public.stada_kor_fonster()                      to service_role;

/* ========================== VY FÖR ADMIN ============================ */
/**
 * Hur mår körningspåminnelsen? Kör i SQL-editorn då och då.
 *
 * security_invoker = on, så att anon stoppas av radsäkerheten på tabellen
 * under. Supabase delar automatiskt ut SELECT på nya vyer till anon, och en
 * vy med invoker AV hade läst förbi radsäkerheten — och därmed lämnat ut
 * precis det tabellen skyddar. Vyn visar bara räknare, aldrig en enskild rad.
 */
create or replace view public.korpaminnelse_halsa
with (security_invoker = on) as
  select
    count(*)                                          as fonster,
    count(distinct agare)                             as anvandare,
    count(*) filter (where antal >= 3 and andel >= 0.4) as starka_nog,
    round(avg(andel)::numeric, 2)                     as snittandel,
    max(uppdaterad)                                   as senast_uppdaterad
  from public.kor_fonster;

revoke all on public.korpaminnelse_halsa from anon, authenticated;

/* ========================= SCHEMALÄGGNING =========================== */
/*
 * Utskicket sköts av edge-funktionen send-reminder, som måste anropas var
 * femte minut. Blocken nedan ligger i DO med felfångst av ett skäl:
 *
 *   OM pg_cron ELLER pg_net SAKNAS händer ingenting alls — filen körs klart,
 *   tabellen och funktionerna finns, men INGA PÅMINNELSER SKICKAS. Det syns
 *   inte på något annat sätt än att telefonen är tyst. Blocken skriver därför
 *   ut ett NOTICE som säger vad du ska göra i stället:
 *
 *      Supabase Dashboard -> Edge Functions -> send-reminder -> Schedules
 *      Cron: var femte minut. Uttrycket står ordagrant i cron.schedule-
 *      anropet längre ner i den här filen — kopiera det därifrån.
 *
 *   Och skriv det INTE här: cron-uttrycket för var femte minut innehåller en
 *   stjärna följd av snedstreck, vilket är exakt tecknen som avslutar en
 *   blockkommentar. Står uttrycket i en sådan kommentar tar kommentaren slut
 *   mitt i raden, resten tolkas som SQL, och filen dör på "syntax error at or
 *   near 5". Det tog en körning mot en riktig databas att hitta.
 *
 *   Den vägen kräver inga tillägg alls och är den som rekommenderas på
 *   Supabase Free. pg_cron finns bara på betalda projekt och på vissa
 *   regioner.
 *
 * OM NYCKLARNA: de får INTE stå i klartext i cron.schedule-anropet.
 * cron.job-tabellen är läsbar för alla med databasåtkomst och hamnar i varje
 * backup — en service_role-nyckel där är samma sak som att ge bort hela
 * databasen. Sätt dem som databasinställningar först, en enda gång:
 *
 *   alter database postgres set app.service_role_key = 'eyJ...';
 *   alter database postgres set app.cron_secret      = '<slumpad sträng>';
 *   alter database postgres set app.funktions_url    = 'https://<projekt>.supabase.co/functions/v1/send-reminder';
 *
 * Inställningarna slår igenom först i NYA anslutningar. Kör du raderna ovan
 * och sedan schemaläggningen i samma SQL-editorsession läser
 * current_setting() fortfarande tomt — det är därför blocket nedan varnar i
 * stället för att tyst schemalägga ett anrop utan nyckel, som hade gett 401
 * var femte minut i evighet.
 */

do $$
declare v_url text; v_key text;
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — INGA PÅMINNELSER SKICKAS av databasen. Schemalägg send-reminder var femte minut i Dashboard -> Edge Functions -> Schedules i stället.';
    return;
  end if;

  perform 1 from pg_extension where extname = 'pg_net';
  if not found then
    raise notice 'pg_net saknas — pg_cron kan inte anropa edge-funktionen. Kör: create extension pg_net; eller schemalägg i Dashboard i stället.';
    return;
  end if;

  v_url := current_setting('app.funktions_url', true);
  v_key := current_setting('app.service_role_key', true);

  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    raise notice 'app.funktions_url eller app.service_role_key är tom. Sätt dem med "alter database postgres set ...", öppna en NY anslutning och kör den här filen igen. Inget schemaläggs nu — ett schemalagt anrop utan nyckel ger 401 var femte minut utan att någon märker det.';
    return;
  end if;

  -- Idempotent: ta bort ett eventuellt tidigare jobb med samma namn först.
  -- cron.unschedule kastar om jobbet inte finns, därav kollen.
  perform 1 from cron.job where jobname = 'polisvakt-korpaminnelse';
  if found then perform cron.unschedule('polisvakt-korpaminnelse'); end if;

  perform cron.schedule(
    'polisvakt-korpaminnelse',
    '*/5 * * * *',
    format($jobb$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
          'x-cron-secret', coalesce(current_setting('app.cron_secret', true), '')
        ),
        body    := jsonb_build_object('kalla', 'korpaminnelse')
      );
    $jobb$, v_url)
  );
  raise notice 'Körningspåminnelsen schemalagd via pg_cron, var femte minut.';
exception when others then
  raise notice 'Kunde inte schemalägga körningspåminnelsen (%). Schemalägg send-reminder var femte minut i Dashboard -> Edge Functions -> Schedules i stället.', sqlerrm;
end $$;

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then return; end if;
  perform 1 from cron.job where jobname = 'polisvakt-korfonster-stada';
  if found then perform cron.unschedule('polisvakt-korfonster-stada'); end if;
  perform cron.schedule('polisvakt-korfonster-stada', '40 4 * * *',
                        'select public.stada_kor_fonster();');
  raise notice 'Städning av kor_fonster schemalagd 04:40 varje natt.';
exception when others then
  raise notice 'Kunde inte schemalägga städningen (%). Kör "select public.stada_kor_fonster();" manuellt då och då.', sqlerrm;
end $$;

/* ============================ KONTROLL ==============================

   Kör de här efteråt för att se att det blev rätt.

   1. Tabellen och radsäkerheten — ska ge fyra policyer:

        select policyname, cmd from pg_policies
         where tablename = 'kor_fonster' order by policyname;

   2. Rättigheterna — INGEN av raderna får ha anon eller authenticated:

        select p.proname, r.rolname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) a
          join pg_roles r on r.oid = a.grantee
         where n.nspname = 'public'
           and p.proname in ('due_kor_paminnelser','mark_kor_paminnelse','stada_kor_fonster');

   3. Att sommartiden räknas rätt. Ska ge samma timme båda gångerna:

        select extract(hour from (timestamptz '2026-10-19 05:30:00+00' at time zone 'Europe/Stockholm')) as sommar,
               extract(hour from (timestamptz '2026-11-09 06:30:00+00' at time zone 'Europe/Stockholm')) as vinter;
        -- Båda ska bli 7. Blir de 5 och 6 räknas det i UTC någonstans.

   4. Schemat — ska ge en rad om pg_cron finns, noll annars (och då gäller
      Dashboard -> Edge Functions -> Schedules):

        select jobname, schedule, active from cron.job
         where jobname like 'polisvakt-kor%';

   5. Hälsan:

        select * from public.korpaminnelse_halsa;

   ==================================================================== */
