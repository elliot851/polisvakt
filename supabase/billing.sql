-- Polisvakt — betalningsschema (Stripe)
--
-- Körs EFTER supabase/schema.sql, i Supabase SQL Editor. Filen är skriven för
-- att kunna köras om hur många gånger som helst utan att förstöra data.
--
-- Om säkerhetsmodellen, som skiljer sig från resten av schemat:
-- allt härunder rör pengar och e-postadresser. Anon-nyckeln ligger öppet i
-- appens källkod, så utgångspunkten är att en angripare kan anropa vad som
-- helst som är tillgängligt för rollerna anon och authenticated. Därför:
--
--   1. Ingen tabell här får en enda RLS-policy. Radsäkerhet är påslagen och
--      tom, vilket innebär "ingen utom service_role kommer in".
--   2. Postgres ger EXECUTE på nya funktioner till PUBLIC som standard. Det
--      är den farligaste standardinställningen i hela den här filen — utan
--      en explicit REVOKE hade vem som helst kunnat anropa set_paid_until
--      och ge sig själv gratis prenumeration. Varje funktion nedan följs
--      därför av revoke + grant till service_role.
--   3. Vyerna körs med security_invoker = on. Supabase delar automatiskt ut
--      SELECT på nya vyer till anon, och en vy som ägs av postgres med
--      invoker av hade läst förbi radsäkerheten på tabellerna under. Med
--      invoker på gäller anroparens rättigheter, och då stoppas anon av den
--      tomma radsäkerheten.

/* ===================== PRENUMERANTER: TILLÄGG ======================= */
-- Tabellen subscribers finns redan i schema.sql. Här kompletteras den med
-- de fält Stripe-flödet behöver. "add column if not exists" gör att filen
-- kan köras om, och att den inte krockar med ändringar i schema.sql.

alter table public.subscribers add column if not exists plan            text;
alter table public.subscribers add column if not exists stripe_sub_id   text;
alter table public.subscribers add column if not exists sub_status      text;
alter table public.subscribers add column if not exists last_payment_at timestamptz;

/**
 * Den viktigaste raden för webhookens prestanda och riktighet.
 *
 * Efter första betalningen kommer varje förnyelse in med Stripes kund-id och
 * ingenting annat som pekar tillbaka till enheten. Utan index blir det en
 * full tabellskanning per faktura, och Stripe har timeout på 30 sekunder.
 *
 * Unikt, för att en Stripe-kund ska höra till exakt en rad. Det är partiellt
 * (where stripe_id is not null) eftersom de allra flesta rader — alla som
 * bara kör provperioden — saknar Stripe-koppling, och NULL i ett vanligt
 * unikt index hade fungerat men gjort indexet onödigt stort.
 */
create unique index if not exists subscribers_stripe_idx
  on public.subscribers (stripe_id) where stripe_id is not null;

create index if not exists subscribers_sub_idx
  on public.subscribers (stripe_sub_id) where stripe_sub_id is not null;

-- För "vilka betalande har vi just nu" i SQL-editorn.
create index if not exists subscribers_paid_idx
  on public.subscribers (paid_until desc) where paid_until is not null;

/* ======================= REVISIONSLOGG ============================== */
/**
 * Varje webhook loggas här, med hela nyttolasten.
 *
 * Två skäl, och båda är dyra att sakna den dag de behövs:
 *
 * 1. Tvister. När en kund hävdar att hen aldrig betalat, eller att
 *    prenumerationen sades upp i mars, är det här enda stället där både
 *    Stripes ord och vår tolkning av det finns bevarat med tidsstämpel.
 *
 * 2. Idempotens. Stripe skickar om varje händelse tills den kvitteras med
 *    2xx — vid nätverksglapp kan samma betalning komma flera gånger. Radens
 *    primärnyckel är Stripes event_id, vilket gör dubbletter omöjliga att
 *    behandla två gånger. Se claim_payment_event längre ner.
 *
 * payload är hela händelsen som jsonb. Det tar plats, men en trunkerad logg
 * är värdelös i en tvist.
 */
create table if not exists public.payment_events (
  event_id        text primary key,        -- Stripes evt_... — själva idempotensnyckeln
  type            text not null,           -- t.ex. invoice.paid
  status          text not null default 'pending'
                  check (status in ('pending','processed','ignored','orphan','error')),
  attempts        int  not null default 1, -- hur många gånger Stripe skickat om
  device_id       text,                    -- vår rad, när vi lyckats hitta den
  stripe_customer text,
  stripe_sub      text,
  amount_ore      bigint,                  -- i minsta enhet (öre), som Stripe räknar
  currency        text,
  paid_until      timestamptz,             -- vad raden sattes till
  error           text,
  payload         jsonb not null,
  received_at     timestamptz not null default now(),
  finished_at     timestamptz
);

comment on column public.payment_events.status is
  'pending = påbörjad, processed = klar, ignored = händelsetyp vi inte bryr oss om, '
  'orphan = betalning utan spårbar enhet (kräver handpåläggning), error = tekniskt fel';

-- Betalningar för en viss kund, i tidsordning. Det är den frågan man ställer
-- när supporten ringer.
create index if not exists payment_events_device_idx
  on public.payment_events (device_id, received_at desc);

create index if not exists payment_events_customer_idx
  on public.payment_events (stripe_customer, received_at desc);

-- Partiellt index: allt som INTE gick igenom. Den listan ska vara tom, och
-- när den inte är det vill man se den direkt. Indexet är litet av samma skäl.
create index if not exists payment_events_problem_idx
  on public.payment_events (received_at desc) where status <> 'processed';

alter table public.payment_events enable row level security;
-- Inga policies. Med radsäkerhet på och noll policies kommer varken anon
-- eller authenticated åt en enda rad — service_role går förbi radsäkerhet
-- och är den enda som skriver hit.

-- Bälte och hängslen: ta bort de SELECT-rättigheter Supabase delar ut
-- automatiskt på nya tabeller i public.
revoke all on public.payment_events from anon, authenticated;

/* ==================== FUNKTIONER: IDEMPOTENS ======================== */

/**
 * Boka händelsen för behandling. Returnerar true om webhooken ska köra
 * vidare, false om händelsen redan är avklarad eller just nu behandlas.
 *
 * Varför det behövs: Stripe garanterar leverans minst en gång, inte exakt en
 * gång. Vid timeout skickas samma händelse om. För prenumerationer spelar
 * det liten roll — vi sätter paid_until till ett absolut datum från Stripe,
 * så dubbelkörning ger samma svar. Men förskottsbetalningen på sex månader
 * är additiv, och där hade en omsändning gett kunden tolv månader gratis.
 *
 * Fönstret på fem minuter finns för att en 'pending' rad annars kunde
 * blockera händelsen för alltid om funktionen kraschade mitt i. Efter fem
 * minuter antas den förra körningen vara död och en ny får försöka.
 */
create or replace function public.claim_payment_event(
  p_event_id text, p_type text, p_payload jsonb)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_status text; v_received timestamptz;
begin
  insert into payment_events (event_id, type, payload, status)
  values (p_event_id, p_type, p_payload, 'pending')
  on conflict (event_id) do nothing;

  -- FOUND är sant bara om raden faktiskt skrevs, alltså första leveransen.
  if found then return true; end if;

  -- Raden fanns. Lås den så två samtidiga omsändningar inte båda får ja.
  select status, received_at into v_status, v_received
  from payment_events where event_id = p_event_id for update;

  if v_status in ('processed','ignored','orphan') then return false; end if;
  if v_status = 'pending' and v_received > now() - interval '5 minutes' then return false; end if;

  update payment_events
     set attempts = attempts + 1, status = 'pending', received_at = now(), error = null
   where event_id = p_event_id;
  return true;
end $$;

/** Skriv utfallet. Anropas alltid, även när något gick fel. */
create or replace function public.finish_payment_event(
  p_event_id   text,
  p_status     text,
  p_device     text        default null,
  p_customer   text        default null,
  p_sub        text        default null,
  p_amount     bigint      default null,
  p_currency   text        default null,
  p_paid_until timestamptz default null,
  p_error      text        default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update payment_events set
    status          = p_status,
    device_id       = coalesce(p_device, device_id),
    stripe_customer = coalesce(p_customer, stripe_customer),
    stripe_sub      = coalesce(p_sub, stripe_sub),
    amount_ore      = coalesce(p_amount, amount_ore),
    currency        = coalesce(p_currency, currency),
    paid_until      = coalesce(p_paid_until, paid_until),
    error           = left(p_error, 2000),
    finished_at     = now()
  where event_id = p_event_id;
end $$;

/* ================== FUNKTIONER: KUNDKOPPLING ======================== */

/**
 * Knyt en Stripe-kund till en enhet.
 *
 * Bara den första betalningen bär client_reference_id. Allt därefter —
 * förnyelser, uppsägningar, misslyckade kort — kommer med kund-id och inget
 * annat. Går kopplingen förlorad här blir varje framtida förnyelse en
 * föräldralös händelse som ingen märker förrän kunden hör av sig.
 *
 * Raden kan saknas om enheten aldrig hann synka sin provperiod (kunden
 * betalade direkt), därför upsert och inte update.
 *
 * Byter någon telefon och betalar igen pekar samma Stripe-kund plötsligt på
 * en ny enhet. Det unika indexet skulle då avvisa skrivningen och webhooken
 * fastna i evig omsändning. Därför lossas kopplingen från gamla rader först
 * — den nyaste enheten vinner.
 */
create or replace function public.link_stripe_customer(
  p_device text, p_customer text, p_email text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_device is null or p_customer is null then return; end if;

  update subscribers
     set stripe_id = null, updated_at = now()
   where stripe_id = p_customer and device_id <> p_device;

  insert into subscribers (device_id, stripe_id, email)
  values (p_device, p_customer, nullif(p_email, ''))
  on conflict (device_id) do update
    set stripe_id  = excluded.stripe_id,
        email      = coalesce(excluded.email, subscribers.email),
        updated_at = now();
end $$;

/** Vilken enhet hör den här Stripe-kunden till? NULL = föräldralös. */
create or replace function public.device_for_stripe_customer(p_customer text)
returns text
language sql security definer set search_path = public stable as $$
  select device_id from public.subscribers
  where stripe_id = p_customer
  limit 1;
$$;

/* ==================== FUNKTIONER: BETALSTATUS ======================= */

/**
 * Sätt betalt-till-datum. Returnerar det datum raden faktiskt fick.
 *
 * p_mode styr riktningen, och det är en medveten uppdelning:
 *
 *   'forlang' — paid_until flyttas bara framåt. Används för förnyelser och
 *               statusändringar. Skyddet är mot omsändningar och mot att en
 *               händelse som kommer i fel ordning (Stripe garanterar ingen
 *               ordning) råkar dra tillbaka en giltig prenumeration.
 *
 *   'exakt'   — paid_until sätts precis som angivet, även bakåt. Används
 *               bara vid uppsägning, där Stripe berättar exakt när tillgången
 *               ska ta slut.
 *
 * Ingen additiv logik här. Prenumerationer sätts alltid till ett absolut
 * datum hämtat ur Stripe-objektet, vilket gör funktionen idempotent i sig
 * själv — kör den tio gånger och resultatet är detsamma.
 */
create or replace function public.set_paid_until(
  p_device text,
  p_until  timestamptz,
  p_plan   text default null,
  p_sub    text default null,
  p_status text default null,
  p_mode   text default 'forlang')
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_until timestamptz;
begin
  if p_device is null or p_until is null then return null; end if;
  if p_mode not in ('forlang','exakt') then
    raise exception 'okänt läge: %', p_mode;
  end if;

  insert into subscribers (device_id, paid_until, plan, stripe_sub_id, sub_status, last_payment_at)
  values (p_device, p_until, p_plan, p_sub, p_status, now())
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

/**
 * Lägg till månader. Enda additiva vägen, och den finns bara för
 * förskottsköpet på sex månader — ett engångsköp utan prenumeration, där
 * Stripe inte har någon period att läsa av.
 *
 * Additivt innebär att dubbelkörning ger dubbel tid. Skyddet ligger i
 * claim_payment_event, inte här. Rör inte den ordningen.
 *
 * greatest(paid_until, now()) gör att en kund som redan har tid kvar får
 * månaderna påslagna i slutet, inte överskrivna.
 */
create or replace function public.add_paid_months(
  p_device text, p_months int, p_plan text default null)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_until timestamptz;
begin
  if p_device is null or coalesce(p_months, 0) <= 0 then return null; end if;
  if p_months > 24 then raise exception 'orimligt antal månader: %', p_months; end if;

  insert into subscribers (device_id, paid_until, plan, last_payment_at)
  values (p_device, now() + make_interval(months => p_months), p_plan, now())
  on conflict (device_id) do update
    set paid_until = greatest(coalesce(subscribers.paid_until, now()), now())
                     + make_interval(months => p_months),
        plan            = coalesce(p_plan, subscribers.plan),
        last_payment_at = now(),
        updated_at      = now()
  returning paid_until into v_until;

  return v_until;
end $$;

/** Notera statusbyte utan att röra betalt-till. Används vid nekat kort. */
create or replace function public.set_sub_status(p_device text, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update subscribers set sub_status = p_status, updated_at = now()
  where device_id = p_device;
end $$;

/* ====================== RÄTTIGHETER (VIKTIGT) ======================= */
-- Postgres ger EXECUTE till PUBLIC på varje ny funktion. Utan raderna
-- nedan kan vem som helst med anon-nyckeln — som ligger i appens källkod —
-- anropa set_paid_until och ge sig själv livstids prenumeration.
-- Lägger du till en funktion i den här filen: lägg till den här också.

revoke execute on function public.claim_payment_event(text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.finish_payment_event(
  text, text, text, text, text, bigint, text, timestamptz, text)
  from public, anon, authenticated;
revoke execute on function public.link_stripe_customer(text, text, text)
  from public, anon, authenticated;
revoke execute on function public.device_for_stripe_customer(text)
  from public, anon, authenticated;
revoke execute on function public.set_paid_until(text, timestamptz, text, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.add_paid_months(text, int, text)
  from public, anon, authenticated;
revoke execute on function public.set_sub_status(text, text)
  from public, anon, authenticated;

grant execute on function public.claim_payment_event(text, text, jsonb) to service_role;
grant execute on function public.finish_payment_event(
  text, text, text, text, text, bigint, text, timestamptz, text) to service_role;
grant execute on function public.link_stripe_customer(text, text, text) to service_role;
grant execute on function public.device_for_stripe_customer(text) to service_role;
grant execute on function public.set_paid_until(text, timestamptz, text, text, text, text) to service_role;
grant execute on function public.add_paid_months(text, int, text) to service_role;
grant execute on function public.set_sub_status(text, text) to service_role;

/* ========================= VYER FÖR ADMIN =========================== */
-- Körs i SQL-editorn, aldrig från appen. security_invoker = on gör att
-- radsäkerheten på tabellerna under fortsätter gälla även genom vyn — utan
-- den hade vyn (som ägs av postgres) läst förbi den tomma radsäkerheten och
-- blivit en öppen dörr till hela betalningsloggen.

/** Allt som inte gick igenom. Ska vara tom. Kolla den varje vecka. */
create or replace view public.payment_problems
with (security_invoker = on) as
  select event_id, type, status, attempts, device_id, stripe_customer,
         amount_ore, currency, error, received_at
  from public.payment_events
  where status <> 'processed'
  order by received_at desc;

/** Intäkt per månad, i kronor inklusive moms. */
create or replace view public.revenue_by_month
with (security_invoker = on) as
  select to_char(received_at, 'YYYY-MM')      as manad,
         count(*)                             as betalningar,
         sum(amount_ore) / 100.0              as belopp_kr,
         currency
  from public.payment_events
  where status = 'processed' and amount_ore is not null
  group by 1, 4
  order by 1 desc;
-- Notera: webhooken sätter amount_ore bara på invoice.paid och på
-- engångsköp. En prenumerations första betalning kommer både som
-- checkout.session.completed och som invoice.paid — utan den regeln hade
-- varje ny kund räknats dubbelt här.

/** Vem betalar just nu? */
create or replace view public.active_subscribers
with (security_invoker = on) as
  select device_id, plan, sub_status, paid_until, last_payment_at, stripe_id
  from public.subscribers
  where paid_until > now()
  order by paid_until;

revoke all on public.payment_problems    from anon, authenticated;
revoke all on public.revenue_by_month    from anon, authenticated;
revoke all on public.active_subscribers  from anon, authenticated;

/* =========================== STÄDNING =============================== */
/**
 * Nyttolasten är stor och behövs bara så länge en tvist kan dyka upp.
 * Kortbetalningar kan bestridas i upp till 120 dagar hos de flesta
 * kortnätverk, så 18 månader är rejält tilltaget. Själva raden behålls —
 * bara payload töms, så bokföringsspåret finns kvar.
 */
create or replace function public.purge_payment_payloads()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update payment_events set payload = '{"rensad": true}'::jsonb
  where received_at < now() - interval '18 months'
    and payload <> '{"rensad": true}'::jsonb;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.purge_payment_payloads() from public, anon, authenticated;
grant execute on function public.purge_payment_payloads() to service_role;

-- select cron.schedule('purge-payloads', '0 5 1 * *', 'select public.purge_payment_payloads()');
