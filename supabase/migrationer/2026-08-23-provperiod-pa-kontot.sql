-- =====================================================================
--  Polisvakt — provperioden följer kontot, inte telefonen
--  2026-08-23
-- =====================================================================
--
-- VARNING OM BLOCKKOMMENTARER
--
-- Filen har INGA blockkommentarer, av samma skäl som i
-- 2026-08-22-brygga-puls.sql. Bara radkommentarer med två bindestreck.
--
--
-- INNAN DU KÖR — allt det här måste vara sant, annars: kör inte
--
--   1. supabase/schema.sql är körd — tabellen subscribers och funktionen
--      get_subscription finns.
--   2. supabase/billing.sql är körd — set_paid_until, add_paid_months,
--      link_stripe_customer, set_sub_status finns. Den här filen ERSÄTTER
--      de fyra funktionerna med versioner som förstår konto-prefixet, så
--      de måste finnas först — annars skapas de här med fel utgångsläge.
--   3. supabase/stripe.sql är körd — triggern subscribers_guard_paid_until
--      finns. Förkontrollen vägrar annars.
--   4. Du kör som postgres i Supabase SQL Editor (triggern på auth.users
--      kräver det).
--   5. Tidpunkt: filen är tänkt att köras I SAMBAND MED att kontokravet
--      aktiveras (KONTOKRAV_AKTIVT = true i js/billing.js och
--      TESTLAGE_UTAN_INLOGGNING = false i js/app.js). Den är ofarlig att
--      köra tidigare — klienten frågar inte efter kontovägen förrän
--      flaggan flippats — men backfyllningen sätter trial_start på
--      befintliga konton till kontots skapelsedatum, så en testare som
--      loggar in EFTER körningen men FÖRE flippen kan se färre provdagar
--      i siffervisningen. Inget låses (testläget släpper igenom allt),
--      men kör den helst i samma veva som flippen.
--   6. Efteråt: notify pgrst, 'reload schema'; ligger sist i filen —
--      utan den ser PostgREST inte den nya funktionen.
--
--
-- VAD DEN LÖSER
--
-- I dag är gratisperioden nycklad på enhetens id. En ny telefon — eller
-- privat surfläge — är en ny enhet, alltså en ny gratisperiod, hur många
-- gånger som helst. Beställningen: provperioden ska följa KONTOT och
-- starta på SERVERN när kontot skapas, inte på klientens klocka.
--
-- Nyckelfaktum som allt bygger på: js/store.js setIdentity() gör att
-- deviceId() returnerar kontots uuid för inloggade. Kontots rad i
-- subscribers ÄR alltså raden med device_id = auth.uid()::text. Ingen ny
-- tabell behövs — bara rätt skrivvägar till den raden.
--
-- Fyra delar:
--
--   1. En trigger på auth.users som sätter trial_start = now() på kontots
--      rad i samma ögonblick som kontot skapas. Serverns klocka, aldrig
--      klientens. Plus backfyllning för konton som redan finns, med
--      kontots created_at som start — det är den ärliga serversanningen.
--
--   2. hamta_konto_prenumeration(p_enhet): kontots motsvarighet till
--      get_subscription. SECURITY DEFINER, läser identiteten ur JWT:n
--      (auth.uid()), lämnar bara ut de två datumen — precis samma
--      säkerhetsmodell som get_subscription har för enheter.
--      Sammanslagning bakåt sker här: fanns en enhetsnycklad trial på
--      telefonen när kontot skapades gäller den TIDIGASTE starten av de
--      två. Annars är receptet för evig gratis: kör slut på enhetens
--      trial, skapa konto, få nya dagar.
--
--   3. Prefixet 'konto-'. En inloggad användare skickar
--      client_reference_id = 'konto-<uuid>' till Stripe (js/billing.js,
--      js/betalning.js), så webhooken kan skilja konto från enhet.
--      BINDESTRECK, inte kolon: Stripe Payment Links tillåter bara
--      alfanumeriskt, bindestreck och understreck i client_reference_id
--      och släpper ogiltiga värden TYST — med kolon hade webhooken fått
--      null och varje inloggat köp blivit föräldralöst.
--      Webhooken (supabase/functions/stripe-webhook) skickar strängen
--      vidare orörd till link_stripe_customer och set_paid_until — därför
--      normaliseras prefixet HÄR, i databasfunktionerna, i stället för
--      att webhooken ändras. Webhookflödet rörs inte med en rad.
--
--   4. PROV-blocket sist: kör riktiga fall mot riktiga rader och kastar
--      vid fel, inne i transaktionen — går ett prov fel rullas hela
--      migrationen tillbaka.
--
--
-- VAD DEN INTE GÖR
--
--   * Flyttar ALDRIG paid_until från en enhetsrad till en kontorad på
--     klientens ord. p_enhet i sammanslagningen är en overifierbar sträng
--     från klienten; att slå ihop trial_start är självbestraffande (den
--     tidigaste starten kan bara KORTA gratisperioden, så det finns inget
--     att vinna på att gissa andras enhets-id), men att slå ihop
--     paid_until hade varit stöld av prenumeration för den som gissar
--     rätt. Betalning som hamnat på en enhetsrad flyttas med
--     repair_payment_event i stripe.sql, av en människa.
--   * Rör inte get_subscription, redeem_code eller månadsbeläningen.
--     Utloggade enheter går exakt samma väg som i dag.
--   * Rör inte webhooken. Prefixet tas om hand i funktionerna den redan
--     anropar, med samma signaturer — ersättningarna ärver därmed också
--     sina EXECUTE-rättigheter (CREATE OR REPLACE behåller ACL), men
--     revoke/grant körs ändå om nedan, för att vila på beslut och inte
--     på arv.
--   * Stoppar inte en människa med många konton. Spärren är per KONTO:
--     ett nytt konto (ny e-post — Supabase räknar en gmail-plusadress som
--     ny) i en ny webbläsare får nya provdagar. Klientens enhetsankare
--     (js/billing.js #skrivEnhetsankare, se sektion 3 nedan) stänger "två
--     konton växelvis på samma telefon/webbläsare", men fler-konton-i-nya-
--     webbläsare kräver ett produktbeslut utanför den här filen:
--     e-postbekräftelse med normaliserad adress, kort up-front vid
--     trialstart, eller fingeravtryck som sekundär spärr.
--
--
-- KÖR
--
--   Klistra in hela filen i Supabase SQL Editor och kör. Idempotent —
--   kan köras om hur många gånger som helst. Läs PROV-utskriften längst
--   ned; slutar den i fel har ingenting ändrats.

begin;

-- =====================================================================
--  0. FÖRKONTROLL — vägra köra om beroenden saknas
-- =====================================================================

do $fk$
begin
  if to_regclass('public.subscribers') is null then
    raise exception 'Kör supabase/schema.sql först — tabellen subscribers saknas.';
  end if;
  if to_regproc('public.get_subscription') is null then
    raise exception 'Kör supabase/schema.sql först — funktionen get_subscription saknas.';
  end if;
  if to_regprocedure('public.set_paid_until(text, timestamptz, text, text, text, text)') is null then
    raise exception 'Kör supabase/billing.sql först — set_paid_until saknas eller har fel signatur.';
  end if;
  if to_regprocedure('public.add_paid_months(text, int, text)') is null then
    raise exception 'Kör supabase/billing.sql först — add_paid_months saknas.';
  end if;
  if to_regprocedure('public.link_stripe_customer(text, text, text)') is null then
    raise exception 'Kör supabase/billing.sql först — link_stripe_customer saknas.';
  end if;
  if to_regprocedure('public.set_sub_status(text, text)') is null then
    raise exception 'Kör supabase/billing.sql först — set_sub_status saknas.';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgname = 'subscribers_guard_paid_until'
                   and tgrelid = 'public.subscribers'::regclass) then
    raise exception 'Kör supabase/stripe.sql först — spärren subscribers_guard_paid_until saknas. '
                    'Utan den är paid_until oskyddad och den här filen ska inte köras.';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'auth.users saknas — är det här verkligen en Supabase-databas?';
  end if;
end $fk$;

-- =====================================================================
--  1. NYCKELN — 'konto-<uuid>' och '<enhets-id>' till samma namnrymd
-- =====================================================================
--
-- Kontoraden lagras alltid under det NAKNA uuid:t (det är vad deviceId()
-- returnerar för inloggade, och vad alla befintliga inloggade rader redan
-- använder). Prefixet finns bara i transit — i client_reference_id på
-- vägen genom Stripe — och skalas av här, vid första kontakt med
-- databasen. Lagra prefixet hade splittrat kontot i två rader: en från
-- betalningen ('konto-uuid') och en från appen ('uuid').
--
-- Prefixet är 'konto-' med BINDESTRECK: kolon överlever inte Stripes
-- filter på client_reference_id (se filhuvudet), och 'konto_' duger inte
-- heller — understreck är LIKE-wildcard, så 'konto_%' hade även matchat
-- t.ex. 'kontoX...'. substr(p_ref, 7) är rätt för 'konto-' precis som
-- för 'konto:' — båda är sex tecken. Kollisionsrisk med enhets-id: noll,
-- de är crypto.randomUUID() eller 'id-'-prefixade (js/util.js) och kan
-- aldrig börja med 'konto-'.

create or replace function public.prenumerationsnyckel(p_ref text)
returns text
language sql immutable as $$
  select case
    when p_ref like 'konto-%' then substr(p_ref, 7)
    else p_ref
  end;
$$;

-- Ren strängfunktion utan åtkomst till någon tabell — men samma disciplin
-- som resten av betalfilerna: inget körbart för klienten utan skäl.
revoke execute on function public.prenumerationsnyckel(text) from public, anon, authenticated;
grant execute on function public.prenumerationsnyckel(text) to service_role;

-- =====================================================================
--  2. STARTEN — servern sätter trial_start när kontot skapas
-- =====================================================================
--
-- Beslut 1 i beställningen: klientens klocka bestämmer aldrig starten.
-- Triggern körs i samma transaktion som kontot skapas, med serverns
-- now(). least() i konfliktgrenen är beslut 3 (sammanslagning bakåt) för
-- det ovanliga fall där raden redan finns med en äldre start — den
-- tidigaste vinner, alltid.
--
-- SECURITY DEFINER med ägare postgres: inserten på auth.users görs av
-- supabase_auth_admin, som varken har rättigheter i public-schemat eller
-- går förbi radsäkerheten på subscribers. Utan definer hade varje
-- registrering kraschat på rättighetsfel.
--
-- Undantagsfångaren är inte kosmetik: ett fel HÄR ärvs av inserten på
-- auth.users och gör att ingen kan skapa konto alls. Hellre ett konto
-- utan förifylld rad (hamta_konto_prenumeration självläker den vid första
-- synk) än en registrering som dör.

create or replace function public.starta_provperiod_vid_konto()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into subscribers (device_id, trial_start)
  values (new.id::text, now())
  on conflict (device_id) do update
    set trial_start = least(subscribers.trial_start, excluded.trial_start),
        updated_at  = now();
  return new;
exception when others then
  raise warning 'starta_provperiod_vid_konto: % — kontot skapas ändå, raden läks vid första synk.', sqlerrm;
  return new;
end $$;

drop trigger if exists konto_startar_provperiod on auth.users;
create trigger konto_startar_provperiod
  after insert on auth.users
  for each row execute function public.starta_provperiod_vid_konto();

-- Backfyllning: konton som skapades innan triggern fanns får sin start
-- satt till kontots created_at — serverns egen tidsstämpel från
-- registreringen, inte något klienten påstått. least() även här: har
-- kontot redan en äldre start (t.ex. inskriven av klientens #syncUp)
-- behålls den. En NYARE klientskriven start ersätts — created_at är
-- sanningen om när kontot föddes.

insert into public.subscribers (device_id, trial_start)
select u.id::text, u.created_at
from auth.users u
on conflict (device_id) do update
  set trial_start = least(subscribers.trial_start, excluded.trial_start),
      updated_at  = now()
  where subscribers.trial_start > excluded.trial_start;

-- =====================================================================
--  3. LÄSVÄGEN — kontots get_subscription, med sammanslagning bakåt
-- =====================================================================
--
-- Beslut 2, 3, 4 och 6 i beställningen bor här:
--
--   2: kontot är nyckeln — identiteten läses ur JWT:n med auth.uid(),
--      aldrig ur en parameter. Klienten kan inte fråga om någon annan.
--   3: p_enhet är telefonens EGNA slumpade id (inte deviceId(), som pekar
--      på kontot för inloggade). Fanns en enhetsnycklad trial där när
--      kontot skapades gäller den tidigaste starten av de två. Enbart
--      trial_start slås ihop — se "VAD DEN INTE GÖR" överst för varför
--      paid_until aldrig följer med på klientens ord.
--      VAR ENHETSRADEN KOMMER IFRÅN i skarp drift: inte från #syncUp
--      (den körs bara utloggad, och kontokravet gör att ingen är det)
--      utan från klientens enhetsankare — js/billing.js
--      #skrivEnhetsankare skriver tillbaka den tidigaste kända starten
--      till telefonens egna rad efter varje lyckad kontosynk. Utan det
--      hade sammanslagningen bara haft material för testkohorten från
--      tiden före kontokravet, och "konto B på samma telefon" gett nya
--      dagar. Ankarvärdet är alltid serverns redan sammanslagna minimum,
--      så det kan aldrig förlänga någons prov.
--   4: paid_until som returneras är kontoradens. Alla enheter som loggar
--      in med samma konto träffar samma rad — det ÄR kontonyckeln.
--   6: SECURITY DEFINER som bara lämnar ut de två datumen, aldrig e-post
--      eller Stripe-id. Samma modell som get_subscription. RLS på
--      subscribers förblir stängd för direktläsning.
--
-- Uppdateringen av trial_start går genom guard_paid_until utan att väcka
-- den — paid_until rörs inte. Att funktionen skriver vid läsning är med
-- flit: den självläker konton som saknar rad (skapade innan triggern,
-- eller när triggern fångade ett undantag) och gör sammanslagningen utan
-- ett separat anrop som klienten kunde glömma.

create or replace function public.hamta_konto_prenumeration(p_enhet text default null)
returns table (trial_start timestamptz, paid_until timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_konto       text;
  v_skapad      timestamptz;
  v_enhetsstart timestamptz;
begin
  v_konto := auth.uid()::text;
  if v_konto is null then
    -- Anrop utan riktig användar-JWT (anon-nyckel eller trasig token).
    -- Tom mängd, inte fel: klienten faller då tillbaka på enhetsvägen.
    return;
  end if;

  -- Självläkning: rad saknas => skapa den med kontots födelsedatum.
  select u.created_at into v_skapad from auth.users u where u.id = auth.uid();
  insert into subscribers (device_id, trial_start)
  values (v_konto, coalesce(v_skapad, now()))
  on conflict (device_id) do nothing;

  -- Sammanslagning bakåt: tidigaste starten vinner. Ofarlig att kalla
  -- med vilket p_enhet som helst — en främmande enhets äldre start kan
  -- bara KORTA anroparens gratisperiod, aldrig förlänga den.
  if p_enhet is not null and btrim(p_enhet) <> '' and p_enhet <> v_konto then
    select s.trial_start into v_enhetsstart
    from subscribers s where s.device_id = p_enhet;
    if v_enhetsstart is not null then
      update subscribers s
         set trial_start = v_enhetsstart, updated_at = now()
       where s.device_id = v_konto
         and s.trial_start > v_enhetsstart;
    end if;
  end if;

  return query
    select s.trial_start, s.paid_until
    from subscribers s
    where s.device_id = v_konto;
end $$;

-- Bara inloggade. anon har enhetsvägen (get_subscription) och ska inte
-- ens kunna fråga här. service_role för felsökning i SQL-editorn.
revoke execute on function public.hamta_konto_prenumeration(text) from public, anon, authenticated;
grant execute on function public.hamta_konto_prenumeration(text) to authenticated, service_role;

-- =====================================================================
--  4. SKRIVVÄGARNA — samma funktioner, nu prefixmedvetna
-- =====================================================================
--
-- Exakta kopior av originalen i billing.sql, med EN ändring var: nyckeln
-- normaliseras först, så 'konto-<uuid>' från Stripe landar på samma rad
-- som appen läser. Signaturerna är identiska — webhooken märker
-- ingenting, och månadsbeläningen (som skriver subscribers direkt med
-- nakna id:n) berörs inte.
--
-- Ändrar du något i originalen i billing.sql: ändra HÄR också, annars
-- skriver nästa omkörning av billing.sql bort prefixhanteringen.
-- (Omvänt gäller redan: kör billing.sql efter den här filen måste den
-- här filen köras om. Idempotensen gör det riskfritt.)

create or replace function public.link_stripe_customer(
  p_device text, p_customer text, p_email text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_nyckel text;
begin
  if p_device is null or p_customer is null then return; end if;
  v_nyckel := public.prenumerationsnyckel(p_device);

  update subscribers
     set stripe_id = null, updated_at = now()
   where stripe_id = p_customer and device_id <> v_nyckel;

  insert into subscribers (device_id, stripe_id, email)
  values (v_nyckel, p_customer, nullif(p_email, ''))
  on conflict (device_id) do update
    set stripe_id  = excluded.stripe_id,
        email      = coalesce(excluded.email, subscribers.email),
        updated_at = now();
end $$;

create or replace function public.set_paid_until(
  p_device text,
  p_until  timestamptz,
  p_plan   text default null,
  p_sub    text default null,
  p_status text default null,
  p_mode   text default 'forlang')
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_until timestamptz; v_nyckel text;
begin
  if p_device is null or p_until is null then return null; end if;
  if p_mode not in ('forlang','exakt') then
    raise exception 'okänt läge: %', p_mode;
  end if;
  v_nyckel := public.prenumerationsnyckel(p_device);

  insert into subscribers (device_id, paid_until, plan, stripe_sub_id, sub_status, last_payment_at)
  values (v_nyckel, p_until, p_plan, p_sub, p_status, now())
  on conflict (device_id) do update
    set paid_until = case
          when p_mode = 'exakt' then p_until
          else greatest(coalesce(subscribers.paid_until, to_timestamp(0)), p_until)
        end,
        plan            = coalesce(p_plan, subscribers.plan),
        stripe_sub_id   = coalesce(p_sub, subscribers.stripe_sub_id),
        sub_status      = coalesce(p_status, subscribers.sub_status),
        last_payment_at = now(),
        updated_at      = now()
  returning paid_until into v_until;

  return v_until;
end $$;

create or replace function public.add_paid_months(
  p_device text, p_months int, p_plan text default null)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_until timestamptz; v_nyckel text;
begin
  if p_device is null or coalesce(p_months, 0) <= 0 then return null; end if;
  if p_months > 24 then raise exception 'orimligt antal månader: %', p_months; end if;
  v_nyckel := public.prenumerationsnyckel(p_device);

  insert into subscribers (device_id, paid_until, plan, last_payment_at)
  values (v_nyckel, now() + make_interval(months => p_months), p_plan, now())
  on conflict (device_id) do update
    set paid_until = greatest(coalesce(subscribers.paid_until, now()), now())
                     + make_interval(months => p_months),
        plan            = coalesce(p_plan, subscribers.plan),
        last_payment_at = now(),
        updated_at      = now()
  returning paid_until into v_until;

  return v_until;
end $$;

create or replace function public.set_sub_status(p_device text, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update subscribers set sub_status = p_status, updated_at = now()
  where device_id = public.prenumerationsnyckel(p_device);
end $$;

-- CREATE OR REPLACE behåller rättigheterna, men de körs om ändå — samma
-- princip som i billing.sql: vila på beslut, inte på arv.
revoke execute on function public.link_stripe_customer(text, text, text)
  from public, anon, authenticated;
revoke execute on function public.set_paid_until(text, timestamptz, text, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.add_paid_months(text, int, text)
  from public, anon, authenticated;
revoke execute on function public.set_sub_status(text, text)
  from public, anon, authenticated;

grant execute on function public.link_stripe_customer(text, text, text)             to service_role;
grant execute on function public.set_paid_until(text, timestamptz, text, text, text, text) to service_role;
grant execute on function public.add_paid_months(text, int, text)                   to service_role;
grant execute on function public.set_sub_status(text, text)                         to service_role;

-- =====================================================================
--  5. PROVET — riktiga fall, kastar vid fel, städar efter sig
-- =====================================================================
--
-- Körs inne i transaktionen: kastar ett prov rullas HELA migrationen
-- tillbaka och databasen är orörd. Kontot simuleras med set_config på
-- request.jwt.claims — det är exakt den väg auth.uid() läser i drift,
-- så provet går genom samma dörr som en riktig klient.

do $prov$
declare
  v_uuid   text := gen_random_uuid()::text;
  v_betald timestamptz;
  r record;
begin
  raise notice '=== PROV: provperiod på kontot ===';

  -- Prov 1: nyckelnormaliseringen.
  if public.prenumerationsnyckel('konto-' || v_uuid) <> v_uuid then
    raise exception 'PROV 1 FEL: prefixet konto- skalas inte av.';
  end if;
  if public.prenumerationsnyckel('enhet-abc-123') <> 'enhet-abc-123' then
    raise exception 'PROV 1 FEL: ett oprefixat enhets-id ska passera orört.';
  end if;
  -- Gamla kolon-formen ska INTE skalas — den skickas aldrig (Stripe hade
  -- tappat den), och att skala den hade dolt ett klientfel.
  if public.prenumerationsnyckel('konto:' || v_uuid) <> 'konto:' || v_uuid then
    raise exception 'PROV 1 FEL: kolon-formen ska passera orörd — den är inte prefixet.';
  end if;
  raise notice 'PROV 1 OK: prenumerationsnyckel skalar konto--prefixet och inget annat.';

  -- Prov 2: triggern finns och sitter på auth.users.
  if not exists (select 1 from pg_trigger
                 where tgname = 'konto_startar_provperiod'
                   and tgrelid = 'auth.users'::regclass) then
    raise exception 'PROV 2 FEL: triggern konto_startar_provperiod saknas på auth.users.';
  end if;
  raise notice 'PROV 2 OK: triggern sitter på auth.users.';

  -- Simulerad inloggning: samma mekanism som PostgREST använder.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uuid, 'role', 'authenticated')::text, true);
  if auth.uid()::text is distinct from v_uuid then
    raise exception 'PROV FEL: kunde inte simulera inloggning — auth.uid() gav %, väntade %.',
      auth.uid(), v_uuid;
  end if;

  -- Prov 3: enhetens trial är ÄLDST — kontot ska ärva den starten.
  insert into subscribers (device_id, trial_start)
  values ('PROV-ENHET-A', now() - interval '3 days');

  select * into r from public.hamta_konto_prenumeration('PROV-ENHET-A');
  if r.trial_start is null then
    raise exception 'PROV 3 FEL: kontoraden skapades inte vid första synk.';
  end if;
  if abs(extract(epoch from (r.trial_start - (now() - interval '3 days')))) > 5 then
    raise exception 'PROV 3 FEL: tidigaste starten vann inte — kontot fick % i stället för enhetens start tre dagar bakåt.',
      r.trial_start;
  end if;
  raise notice 'PROV 3 OK: enhetens äldre start (3 dagar) ärvdes av kontot.';

  -- Prov 4: kontots start är ÄLDST — en nyare enhet ska INTE flytta fram den.
  update subscribers set trial_start = now() - interval '10 days'
   where device_id = v_uuid;
  insert into subscribers (device_id, trial_start)
  values ('PROV-ENHET-B', now() - interval '1 day');

  select * into r from public.hamta_konto_prenumeration('PROV-ENHET-B');
  if abs(extract(epoch from (r.trial_start - (now() - interval '10 days')))) > 5 then
    raise exception 'PROV 4 FEL: kontots äldre start (10 dagar) skulle stått kvar, blev %.', r.trial_start;
  end if;
  raise notice 'PROV 4 OK: kontots äldre start stod emot en nyare enhetsstart.';

  -- Prov 5: en betalning med konto-prefix landar på kontoraden.
  -- (Provet kör som postgres, så guard_paid_until släpper förbi — precis
  -- som för webhookens service_role.)
  select public.set_paid_until('konto-' || v_uuid, now() + interval '30 days', 'bas', null, 'active')
    into v_betald;
  select s.paid_until into v_betald from subscribers s where s.device_id = v_uuid;
  if v_betald is null or abs(extract(epoch from (v_betald - (now() + interval '30 days')))) > 5 then
    raise exception 'PROV 5 FEL: set_paid_until med konto--prefix träffade inte kontoraden.';
  end if;
  if exists (select 1 from subscribers where device_id = 'konto-' || v_uuid) then
    raise exception 'PROV 5 FEL: en egen rad skapades för den prefixade nyckeln — kontot är splittrat.';
  end if;
  raise notice 'PROV 5 OK: betalning via konto--prefix landade på kontoraden, ingen splittring.';

  -- Prov 6: enhetsraden rördes inte av betalningen (paid_until följer
  -- ALDRIG med i sammanslagningen, åt något håll).
  if exists (select 1 from subscribers
             where device_id in ('PROV-ENHET-A', 'PROV-ENHET-B')
               and paid_until is not null) then
    raise exception 'PROV 6 FEL: en enhetsrad fick paid_until — betald tid har läckt.';
  end if;
  select s.paid_until into v_betald
  from public.hamta_konto_prenumeration() s;
  if v_betald is null then
    raise exception 'PROV 6 FEL: kontovägen lämnar inte ut kontots paid_until.';
  end if;
  raise notice 'PROV 6 OK: betald tid ligger på kontot och läcker inte till enhetsrader.';

  -- Prov 7: rättigheterna. anon ska inte kunna fråga kontovägen, och
  -- ingen klientroll ska kunna köra skrivfunktionerna.
  if has_function_privilege('anon', 'public.hamta_konto_prenumeration(text)', 'execute') then
    raise exception 'PROV 7 FEL: anon får köra hamta_konto_prenumeration.';
  end if;
  if not has_function_privilege('authenticated', 'public.hamta_konto_prenumeration(text)', 'execute') then
    raise exception 'PROV 7 FEL: authenticated får INTE köra hamta_konto_prenumeration — inloggade blir blinda.';
  end if;
  if has_function_privilege('anon', 'public.set_paid_until(text, timestamptz, text, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.set_paid_until(text, timestamptz, text, text, text, text)', 'execute') then
    raise exception 'PROV 7 FEL: en klientroll kan köra set_paid_until. Stoppa allt.';
  end if;
  raise notice 'PROV 7 OK: rättigheterna sitter som de ska.';

  -- Städning: bara provets egna rader.
  delete from subscribers where device_id in (v_uuid, 'PROV-ENHET-A', 'PROV-ENHET-B');
  perform set_config('request.jwt.claims', '', true);

  raise notice '=== ALLA PROV OK — migrationen står. ===';
end $prov$;

commit;

-- PostgREST måste ladda om schemat för att se hamta_konto_prenumeration.
notify pgrst, 'reload schema';

-- =====================================================================
--  6. EFTERÅT — kontrollera på riktigt
-- =====================================================================
--
-- 1. Skapa ett riktigt konto i appen och kolla att raden dök upp med
--    serverns tid:
--
--      select device_id, trial_start, paid_until
--      from public.subscribers
--      where device_id in (select id::text from auth.users
--                          order by created_at desc limit 3);
--
-- 2. När kontokravet aktiveras i klienten (KONTOKRAV_AKTIVT = true i
--    js/billing.js): logga in på en telefon som redan bränt provdagar
--    och se att dagarna INTE börjar om.
