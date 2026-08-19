-- Polisvakt — Stripe: spärrar, prisuppslag och handpåläggning
--
-- Körs i Supabase SQL Editor, EFTER schema.sql och EFTER billing.sql.
-- Filen går att köra om hur många gånger som helst utan att förstöra data.
--
-- Varför en fil till, när billing.sql redan finns?
--
-- billing.sql bygger maskineriet: revisionstabellen payment_events, idempotens
-- via claim_payment_event, och de funktioner som faktiskt sätter paid_until.
-- Den filen antar att allt anropas rätt. Den här filen antar motsatsen och
-- lägger till tre saker som bara behövs när något gått fel:
--
--   1. En spärr i databasen som gör paid_until omöjlig att skriva från
--      klienten, även om någon senare råkar lägga till en UPDATE-policy på
--      subscribers. Rättighetsmodellen i billing.sql är riktig, men den vilar
--      helt på att ingen gör fel i en annan fil. Den här spärren gör det
--      strukturellt omöjligt istället för bara förbjudet.
--
--   2. Ett prisuppslag på belopp. Webhooken läser nivå och antal månader ur
--      metadata på Stripe-priset. Glöms metadata bort blir en genomförd
--      betalning en föräldralös händelse — kunden har betalat och får
--      ingenting. Uppslaget nedan gör beloppet till en reservväg, så att
--      slarv i Stripe-panelen kostar en lograd istället för en kund.
--
--   3. Ett sätt att laga en föräldralös betalning för hand utan att peta
--      direkt i tabellerna.
--
-- Om säkerhetsmodellen: samma som i billing.sql och push.sql. Anon-nyckeln
-- ligger öppet i appens källkod (js/config.js), så utgångspunkten är att en
-- angripare kan anropa allt som är tillgängligt för anon och authenticated.
-- Postgres delar ut EXECUTE på nya funktioner till PUBLIC som standard, och
-- REVOKE måste därför nämna PUBLIC — inte bara anon och authenticated.
-- Att bara skriva "revoke ... from anon, authenticated" ser rätt ut och
-- lämnar dörren vidöppen, eftersom rättigheten aldrig låg på de rollerna
-- utan på PUBLIC som de ärver ifrån. Det är den fällan push.sql varnar för
-- överst i sin egen fil, och den gäller varje funktion här nedan.
--
-- En konvention till, för den som utökar filen: tidsgränser i den här filen
-- räknas i timestamptz och interval. Där projektet istället lagrar
-- millisekunder sedan epok (reports.expires_at i schema.sql) måste samma sorts
-- gräns skrivas 400::bigint * 24 * 60 * 60 * 1000. Utan ::bigint räknar
-- Postgres uttrycket i int4, och 400 * 24 * 60 * 60 * 1000 är 34,5 miljarder —
-- långt över int32-taket på 2 147 483 647. Det spiller över och ger ett
-- negativt tal, vilket i praktiken betyder "utgången för länge sedan". Det har
-- redan bitit det här projektet en gång.

/* ===================== BEROENDEN: KOLLA FÖRST ======================= */
-- Bättre ett tydligt fel här än sju obegripliga längre ner.

do $$
begin
  if to_regclass('public.subscribers') is null then
    raise exception 'Kör supabase/schema.sql först — tabellen subscribers saknas.';
  end if;
  if to_regclass('public.payment_events') is null then
    raise exception 'Kör supabase/billing.sql först — tabellen payment_events saknas.';
  end if;
  if to_regproc('public.link_stripe_customer') is null then
    raise exception 'Kör supabase/billing.sql först — funktionen link_stripe_customer saknas.';
  end if;
end $$;

/* ================= SPÄRREN: VEM FÅR SÄTTA paid_until ================ */

/**
 * paid_until är den enda kolumnen i hela databasen som direkt motsvarar
 * pengar. Skyddet ligger i dag på tre ställen, och det här är det fjärde:
 *
 *   schema.sql   subscribers har ingen UPDATE-policy alls, och INSERT-policyn
 *                kräver att paid_until är null.
 *   billing.sql  set_paid_until och add_paid_months har EXECUTE indraget från
 *                anon och authenticated.
 *   webhooken    kör med service role-nyckeln, som aldrig finns i klientkod.
 *
 * De tre är riktiga men ömtåliga på samma sätt: de är alla någon annans fil.
 * Den dag någon lägger till en till synes harmlös UPDATE-policy på
 * subscribers — för att spara ett smeknamn, en inställning, vad som helst —
 * öppnas paid_until samtidigt, och ingenting i den ändringen ser ut som ett
 * betalningsproblem. Den här triggern är oberoende av allt det: oavsett vilka
 * policies som finns kommer skrivningen inte förbi.
 *
 * VIKTIGT: funktionen får INTE vara security definer.
 *
 * En security definer-funktion kör som sin ägare, och då hade current_user
 * varit 'postgres' även när anon skrev — kontrollen nedan hade alltid sagt ja
 * och triggern varit ren dekoration. Med invoker (standard) speglar
 * current_user den som faktiskt utför skrivningen: 'anon' för en gäst,
 * 'authenticated' för en inloggad, 'service_role' för webhooken, och ägaren
 * för de security definer-funktioner i billing.sql som ska få skriva.
 *
 * Kontrollen är skriven som en nekandelista, inte en tillåtandelista, och det
 * är ett medvetet val åt det försiktiga hållet. En tillåtandelista som missar
 * en roll gör att riktiga betalningar slutar skrivas — kunden har betalat och
 * appen låser sig ändå, det värsta utfallet i hela kedjan. En nekandelista som
 * missar en roll gör i värsta fall ingen skada alls, eftersom bara tre roller
 * är åtkomliga utifrån: PostgREST sätter rollen till exakt 'anon',
 * 'authenticated' eller 'service_role' utifrån nyckeln i anropet, och vilken
 * det blir kan klienten inte välja. De två första är de som ska stoppas.
 *
 * Rollnamnen jämförs som text istället för med pg_has_role, för att funktionen
 * inte ska kunna kasta på en databas där någon av rollerna saknas. Ett fel i
 * en spärr får aldrig bli ett fel i en betalning.
 */
create or replace function public.guard_paid_until()
returns trigger
language plpgsql
set search_path = public, pg_temp as $$
declare
  v_gammal timestamptz;
  v_hopp   interval;
begin
  -- Rörs inte paid_until finns det inget att skydda. Vanligaste fallet:
  -- klienten skriver upp trial_start, eller webhooken bara byter sub_status.
  if tg_op = 'UPDATE' and new.paid_until is not distinct from old.paid_until then
    return new;
  end if;
  if tg_op = 'INSERT' and new.paid_until is null then
    return new;
  end if;

  if current_user in ('anon', 'authenticated', 'authenticator') then
    raise exception
      'paid_until sätts bara av Stripe-webhooken. Rollen % har inte rätt till det.', current_user
      using hint = 'Betalstatus kommer från Stripe, aldrig från klienten. Se supabase/stripe.sql.';
  end if;

  /**
   * Rimlighetstak på hoppet, inte på datumet.
   *
   * Taket sitter på hur mycket EN skrivning får lägga till, inte på hur långt
   * fram paid_until totalt får ligga. Skillnaden är hela poängen: en trogen
   * kund som köper sexmånadersförskottet fyra gånger ska hamna två år fram
   * utan att något stoppar honom, medan en enda skrivning som påstår sig ge
   * fyra år är ett fel varje gång.
   *
   * Två verkliga fel fångas här:
   *
   *   fel enhet   Stripe räknar tid i sekunder, JavaScript i millisekunder.
   *               Blandas de ihop hamnar datumet antingen 1970 eller år 56000.
   *               Det senare hade gett livstids prenumeration utan att någon
   *               märkt det förrän vid bokslutet.
   *
   *   rundgång    add_paid_months är additiv med flit och skyddas bara av
   *               idempotensen i claim_payment_event. Går den sönder blir
   *               månaderna staplade, och 800 dagar nås efter fyra körningar.
   *
   * 800 dagar, inte 400: add_paid_months släpper igenom upp till 24 månader
   * i ett anrop, och ett tak under det hade gjort en tillåten operation
   * omöjlig. Taket ska fånga det orimliga, inte det ovanliga.
   */
  v_gammal := case when tg_op = 'UPDATE' then old.paid_until else null end;
  v_hopp := new.paid_until - greatest(coalesce(v_gammal, now()), now());

  if v_hopp > interval '800 days' then
    raise exception
      'paid_until skulle flyttas % framåt i ett enda steg — det är inte en giltig betalning.', v_hopp
      using hint = 'Nästan alltid sekunder tolkade som millisekunder. Se periodSlut() i stripe-webhook.';
  end if;

  return new;
end $$;

drop trigger if exists subscribers_guard_paid_until on public.subscribers;
create trigger subscribers_guard_paid_until
  before insert or update on public.subscribers
  for each row execute function public.guard_paid_until();

-- Ingen revoke här, och det är med flit. Postgres vägrar att köra en
-- triggerfunktion som ett vanligt funktionsanrop ("trigger functions can only
-- be called as triggers"), så EXECUTE på den ger ingen angreppsyta. Rätten
-- kontrolleras dessutom när triggern skapas, inte när den körs — en revoke
-- hade alltså kunnat se ut att fungera men i värsta fall stoppat helt vanliga
-- insert från appen. Låt den vara.

/* ===================== PRISUPPSLAG PÅ BELOPP ======================== */

/**
 * Reservvägen när metadata saknas i Stripe.
 *
 * Webhooken vill läsa två saker ur Stripe-priset: vilken nivå köpet gäller
 * (bas/plus/pro) och, för förskottsköpet, hur många månader. Båda sätts för
 * hand i Stripe-panelen enligt docs/BETALNING.md. Handpåsatt metadata på sex
 * priser glöms förr eller senare bort på ett av dem — troligen det man skapade
 * sist, en kväll, när de fem första gick bra.
 *
 * Utan reservväg blir följden att kunden betalar, Stripe är nöjd, och
 * webhooken skriver 'orphan' i loggen. Kunden får ingenting och hör av sig
 * först några dagar senare, om han orkar.
 *
 * Beloppet är entydigt: de sex priserna i js/plans.js ger sex olika summor.
 * Att slå upp på belopp är därför en exakt reserv, inte en gissning — och den
 * kan bara ge fel svar om två priser råkar bli lika stora, vilket tabellen
 * hindrar genom sin primärnyckel.
 *
 * Tabellen är sanningen, inte koden: ändrar du priserna i Stripe ska du ändra
 * här också. Gör du inte det slutar reserven fungera, men ingenting går
 * sönder — metadata är fortfarande huvudvägen.
 */
create table if not exists public.stripe_price_map (
  amount_ore bigint not null,          -- exakt belopp i öre, som Stripe räknar
  currency   text   not null default 'sek',
  plan       text   not null,          -- måste stavas som id i PLANS, js/plans.js
  months     int,                      -- null = prenumeration, Stripe äger perioden
  note       text,
  primary key (amount_ore, currency),
  constraint stripe_price_map_months_ck check (months is null or months between 1 and 24)
);

alter table public.stripe_price_map enable row level security;
-- Inga policies. Tabellen styr hur mycket tid en betalning ger, alltså är den
-- lika känslig som funktionerna som skriver paid_until. Läses bara av
-- webhooken, via service_role som går förbi radsäkerheten.
revoke all on public.stripe_price_map from public, anon, authenticated;

/**
 * Utgångsvärden: exakt de sex priserna i js/plans.js.
 *
 * Månadspriserna är 99 / 149 / 199 kr. Förskotten är sex månader minus 20 %,
 * avrundat på samma sätt som priceFor() i js/plans.js gör det:
 *   round(99 * 6 * 0,8) = 475      round(149 * 6 * 0,8) = 715
 *   round(199 * 6 * 0,8) = 955
 *
 * "on conflict do nothing" gör att filen kan köras om utan att skriva över en
 * rad du ändrat för hand efter en prisjustering.
 */
insert into public.stripe_price_map (amount_ore, currency, plan, months, note) values
  (  9900, 'sek', 'bas',  null, 'Bas 99 kr/mån'),
  ( 14900, 'sek', 'plus', null, 'Plus 149 kr/mån'),
  ( 19900, 'sek', 'pro',  null, 'Pro 199 kr/mån'),
  ( 47500, 'sek', 'bas',  6,    'Bas 6 mån i förskott'),
  ( 71500, 'sek', 'plus', 6,    'Plus 6 mån i förskott'),
  ( 95500, 'sek', 'pro',  6,    'Pro 6 mån i förskott')
on conflict (amount_ore, currency) do nothing;

/** Vad motsvarar det här beloppet? Tom rad = vet inte, och då gissar vi inte. */
create or replace function public.stripe_plan_for_amount(
  p_amount bigint, p_currency text default 'sek')
returns table (plan text, months int)
language sql security definer set search_path = public stable as $$
  select m.plan, m.months
  from public.stripe_price_map m
  where m.amount_ore = p_amount
    and m.currency = lower(coalesce(nullif(p_currency, ''), 'sek'))
  limit 1;
$$;

/* ================== HANDPÅLÄGGNING: FÖRÄLDRALÖSA ==================== */

/**
 * Laga en betalning som inte gick att koppla till en enhet.
 *
 * Det händer i två fall, och båda är verkliga:
 *
 *   1. Betallänken öppnades utan ?client_reference_id. Någon delade länken
 *      vidare, eller kopierade den ur adressfältet på Stripes sida.
 *   2. Kunden bytte telefon och betalade från en enhet vars rad aldrig hann
 *      synkas.
 *
 * Funktionen gör två saker och inget mer: knyter Stripe-kunden till enheten,
 * och öppnar händelsen för omsändning. Den delar medvetet INTE ut tid själv.
 * Tiden ska komma från Stripes egna uppgifter om perioden — skriver vi den
 * på fri hand blir revisionsloggen en berättelse om vad vi trodde, inte vad
 * som hände, och det är just den loggen som ska hålla i en tvist.
 *
 * Efter att den här körts: Stripe → Utvecklare → Webhooks → händelsen →
 * Skicka om. Då gör webhooken samma jobb som den skulle gjort från början,
 * nu med kopplingen på plats.
 *
 * received_at backas en timme för att claim_payment_event ska släppa igenom.
 * Den funktionen avvisar en 'pending' rad som är yngre än fem minuter, för att
 * två samtidiga omsändningar inte ska behandlas parallellt. Utan backningen
 * hade lagningen sett ut att lyckas och omsändningen tyst kastats bort.
 */
create or replace function public.repair_payment_event(
  p_event_id text, p_device text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_rad      public.payment_events%rowtype;
  v_customer text;
  v_email    text;
begin
  if p_device is null or btrim(p_device) = '' then
    return 'Ange enhetens id (device_id). Fråga kunden, eller leta i subscribers på e-postadressen.';
  end if;

  select * into v_rad from payment_events where event_id = p_event_id;
  if not found then
    return 'Ingen händelse med id ' || coalesce(p_event_id, '(null)') || '. Kolla stavningen (evt_...).';
  end if;

  -- Kunden kan stå antingen i kolumnen (satt av webhooken) eller kvar i
  -- nyttolasten. Som id-sträng i normalfallet, som objekt om endpointen
  -- råkat vara inställd på att expandera kunden.
  --
  -- jsonb_typeof, inte bara två coalesce-led: #>> på ett objekt returnerar
  -- objektets JSON-text i stället för null, så en enkel coalesce hade tagit
  -- hela klumpen "{"id":"cus_..","object":"customer",...}" som kund-id och
  -- skrivit den till subscribers.stripe_id. Kopplingen hade sett gjord ut och
  -- ingen förnyelse hade någonsin hittat hem.
  v_customer := coalesce(
    v_rad.stripe_customer,
    case jsonb_typeof(v_rad.payload #> '{data,object,customer}')
      when 'string' then v_rad.payload #>> '{data,object,customer}'
      when 'object' then v_rad.payload #>> '{data,object,customer,id}'
      else null
    end);

  v_email := coalesce(
    v_rad.payload #>> '{data,object,customer_details,email}',
    v_rad.payload #>> '{data,object,customer_email}');

  if v_customer is not null then
    perform public.link_stripe_customer(p_device, v_customer, v_email);
  end if;

  update payment_events set
    status      = 'pending',
    device_id   = p_device,
    received_at = now() - interval '1 hour',
    error       = 'öppnad för omsändning ' || to_char(now(), 'YYYY-MM-DD HH24:MI'),
    finished_at = null
  where event_id = p_event_id;

  if v_customer is null then
    return 'Händelsen är öppnad, men den innehåller ingen Stripe-kund att koppla. '
        || 'Skicka om den från Stripe. Ger den fortfarande orphan: ge tiden för hand med '
        || 'select public.add_paid_months(''' || p_device || ''', 1, ''plus'');';
  end if;

  return 'Kund ' || v_customer || ' kopplad till enhet ' || p_device
      || '. Skicka nu om händelsen ' || p_event_id
      || ' från Stripe → Utvecklare → Webhooks.';
end $$;

/**
 * Stödsökning: vilken enhet hör den här e-postadressen till?
 *
 * Enda uppgiften kunden säkert kan lämna över telefon är e-postadressen han
 * betalade med. device_id är en slumpsträng ingen läser upp korrekt.
 * Funktionen är service_role-skyddad av samma skäl som resten: den kopplar
 * ihop en person med en betalningshistorik.
 */
create index if not exists subscribers_email_idx
  on public.subscribers (lower(email)) where email is not null;

create or replace function public.subscriber_by_email(p_email text)
returns table (device_id text, plan text, sub_status text, paid_until timestamptz, stripe_id text)
language sql security definer set search_path = public stable as $$
  select s.device_id, s.plan, s.sub_status, s.paid_until, s.stripe_id
  from public.subscribers s
  where s.email is not null
    and lower(s.email) = lower(btrim(coalesce(p_email, '')))
  order by s.updated_at desc;
$$;

/* ====================== RÄTTIGHETER (VIKTIGT) ======================= */
-- PUBLIC måste stå med. Postgres ger EXECUTE på varje ny funktion till
-- PUBLIC, och anon ärver därifrån — en revoke som bara nämner anon och
-- authenticated tar därför bort en rättighet de aldrig hade och lämnar
-- dörren öppen. Se kommentaren överst i supabase/push.sql.
--
-- Lägger du till en funktion i den här filen: lägg till den här också.

revoke execute on function public.stripe_plan_for_amount(bigint, text)
  from public, anon, authenticated;
revoke execute on function public.repair_payment_event(text, text)
  from public, anon, authenticated;
revoke execute on function public.subscriber_by_email(text)
  from public, anon, authenticated;

grant execute on function public.stripe_plan_for_amount(bigint, text) to service_role;
grant execute on function public.repair_payment_event(text, text)     to service_role;
grant execute on function public.subscriber_by_email(text)            to service_role;

/* ========================== VY FÖR ADMIN ============================ */

/**
 * Hur mår betalningarna? Kör i SQL-editorn en gång i veckan.
 *
 * security_invoker = on: Supabase delar automatiskt ut SELECT på nya vyer
 * till anon, och en vy som ägs av postgres med invoker av hade läst förbi den
 * tomma radsäkerheten på tabellerna under. Med invoker på gäller anroparens
 * rättigheter, och då stoppas anon av radsäkerheten precis som det var tänkt.
 */
create or replace view public.stripe_health
with (security_invoker = on) as
  select
    (select count(*) from payment_events)                                     as handelser_totalt,
    (select count(*) from payment_events where status = 'processed')          as klara,
    (select count(*) from payment_events where status = 'orphan')             as foraldralosa,
    (select count(*) from payment_events where status = 'error')              as fel,
    -- Fastnade: 'pending' som aldrig blev klar. En handfull minuter är normalt
    -- mitt i en körning, en kvart är det inte.
    (select count(*) from payment_events
      where status = 'pending' and received_at < now() - interval '15 minutes') as fastnade,
    (select max(received_at) from payment_events)                             as senaste_handelse,
    (select count(*) from payment_events
      where received_at > now() - interval '7 days')                          as handelser_7_dagar,
    (select count(*) from subscribers where paid_until > now())               as betalande_nu,
    -- Betalande rader utan giltig nivå. Betyder nästan alltid att metadata
    -- 'plan' saknas på ett Stripe-pris: kunden får tillgång men appen vet inte
    -- vilken nivå, och faller tillbaka på den lägsta.
    (select count(*) from subscribers
      where paid_until > now()
        and (plan is null or plan not in ('bas', 'plus', 'pro')))             as utan_giltig_niva;

revoke all on public.stripe_health from public, anon, authenticated;

/**
 * De föräldralösa, med det som behövs för att laga dem.
 *
 * payment_problems i billing.sql visar allt som inte gick igenom.
 * Den här visar bara orphan, och plockar fram e-postadressen ur nyttolasten —
 * för det är den man söker på när kunden ringer.
 */
create or replace view public.stripe_orphans
with (security_invoker = on) as
  select
    event_id,
    type,
    received_at,
    stripe_customer,
    coalesce(payload #>> '{data,object,customer_details,email}',
             payload #>> '{data,object,customer_email}')                as epost,
    (payload #>> '{data,object,amount_total}')::bigint / 100.0          as belopp_kr,
    error
  from public.payment_events
  where status = 'orphan'
  order by received_at desc;

revoke all on public.stripe_orphans from public, anon, authenticated;

/* ===================== EFTERKONTROLL: KÖR DESSA ===================== */
--
-- 1. Kan anon sätta sin egen betalstatus? Ska ge ett fel, inte en rad.
--
--    set local role anon;
--    insert into public.subscribers (device_id, paid_until)
--    values ('spärrtest', now() + interval '10 years');
--    reset role;
--
--    Förväntat: "paid_until sätts bara av Stripe-webhooken."
--    Kommer raden in istället: sluta här och felsök triggern innan du går
--    live. Allt annat i betalningskedjan är meningslöst då.
--
-- 2. Ligger EXECUTE kvar hos fel roll någonstans?
--
--    select p.proname, coalesce(r.rolname, 'PUBLIC') as roll
--    from pg_proc p
--    join pg_namespace n on n.oid = p.pronamespace
--    left join lateral aclexplode(p.proacl) a on true
--    left join pg_roles r on r.oid = a.grantee
--    where n.nspname = 'public'
--      and p.proname in ('set_paid_until','add_paid_months','claim_payment_event',
--                        'finish_payment_event','link_stripe_customer',
--                        'device_for_stripe_customer','set_sub_status',
--                        'stripe_plan_for_amount','repair_payment_event',
--                        'subscriber_by_email')
--    order by 1, 2;
--
--    Dyker anon, authenticated eller PUBLIC upp: kör revoke-blocken igen,
--    både i billing.sql och här.
--
-- 3. Har PostgREST sett de nya funktionerna?
--
--    notify pgrst, 'reload schema';
