-- Polisvakt — push-notiser
--
-- Körs EFTER supabase/schema.sql, i Supabase SQL Editor. Filen är skriven för
-- att kunna köras om hur många gånger som helst utan att förstöra data.
--
-- Vad tabellen är till för: js/push.js lägger upp en prenumeration per telefon
-- tillsammans med de tider personen brukar köra. Edge-funktionen
-- send-reminder läser dem var femte minut och skickar en påminnelse strax
-- innan en sådan tid — även när appen är helt stängd. Se docs/NOTISER.md.
--
-- Om säkerhetsmodellen, som är strängare än resten av schemat:
--
--   1. INGEN läsregel, för någon. Kolumnen auth är en delad hemlighet som
--      krypterar pushen, och endpoint är adressen dit den skickas. Den som
--      har båda kan skicka valfri notis till den telefonen, i vårt namn.
--      Anon-nyckeln ligger öppet i appens källkod (se js/config.js), så en
--      läsregel med "using (true)" — eller ens en scopad sådan — hade varit
--      ett sätt att lämna ut nycklarna till hela användarbasen.
--      Klienten behöver aldrig läsa tillbaka något: webbläsaren har redan sin
--      egen prenumeration i pushManager.getSubscription().
--
--   2. Inga skrivregler heller. All skrivning går genom funktionerna nedan,
--      som tar identiteten ur public.actor() — alltså ur JWT:n för inloggade,
--      aldrig ur vad klienten påstår.
--
--   3. Postgres ger EXECUTE på nya funktioner till PUBLIC som standard. Utan
--      en explicit REVOKE hade vem som helst kunnat anropa due_push_reminders
--      och hämta ut samtliga endpoints och hemligheter i klartext. Varje
--      serverfunktion nedan följs därför av revoke + grant till service_role.

/* ========================= PRENUMERATIONER ========================== */

create table if not exists public.push_subscriptions (
  -- Endpointen är pushtjänstens egen adress till just den här installationen
  -- och är global unik. Att använda den som primärnyckel gör upsert trivialt
  -- och gör det omöjligt att av misstag få två rader för samma telefon.
  endpoint        text primary key,
  p256dh          text not null,          -- mottagarens publika nyckel (base64url)
  auth            text not null,          -- delad hemlighet, 16 byte (base64url)

  device_id       text not null,          -- samma id som i reports, se store.js
  timezone        text not null default 'Europe/Stockholm',

  /**
   * Vanorna, som platta nummer 0–167: veckodag × 24 + timme.
   *
   * Kodningen kommer från js/push.js -> slotsFromHabits(). Veckodagen är
   * JavaScripts getDay() där 0 = söndag, vilket är exakt samma numrering som
   * Postgres extract(dow) — hela poängen med att välja den här formen framför
   * något mer läsbart. Ingen omräkning behövs på någondera sidan, och en
   * omräkning som görs på ett ställe men glöms på det andra hade gett
   * påminnelser på fel dag utan att något syns i loggen.
   */
  slots           smallint[] not null default '{}',

  enabled         boolean not null default true,

  -- Körde personen redan idag? Sätts av appen när bilen börjar rulla.
  last_drive_date date,

  -- Utskicksspärrar. Se due_push_reminders för hur de används.
  last_sent_at    timestamptz,
  last_slot       smallint,
  sent_date       date,
  sent_today      smallint not null default 0,

  -- Räknare för trasiga prenumerationer som inte gett 404/410 än.
  failures        smallint not null default 0,
  last_error      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists push_device_idx on public.push_subscriptions (device_id);

/**
 * Cronjobbets index.
 *
 * Partiellt på enabled, för att en avstängd eller sönderpushad rad aldrig ska
 * behöva läsas alls. Något smartare index går inte att bygga: vilken lucka
 * som är aktuell beror på radens egen tidszon och måste räknas per rad. Med
 * några tusen aktiva prenumeranter är det en skanning på millisekunder, och
 * den körs var femte minut — inte per förfrågan.
 */
create index if not exists push_active_idx
  on public.push_subscriptions (enabled) where enabled and failures < 5;

alter table public.push_subscriptions enable row level security;

-- Radsäkerhet påslagen och HELT tom: ingen policy = ingen utom service_role
-- kommer in. Läs kommentaren överst i filen innan du lägger till en.
revoke all on public.push_subscriptions from anon, authenticated;

/* ========================= HJÄLPFUNKTIONER ========================== */

/**
 * Är tidszonen något Postgres känner igen?
 *
 * Den här kollen är inte kosmetisk. Tidszonen kommer från klientens
 * Intl.DateTimeFormat().resolvedOptions().timeZone, och en enda rad med skräp
 * i det fältet får "now() at time zone tz" att kasta i due_push_reminders —
 * vilket dödar HELA frågan. Alla användares påminnelser slutar då fungera på
 * grund av en telefon. Skräpet stoppas därför vid skrivning, inte vid läsning.
 */
create or replace function public.valid_timezone(p_tz text)
returns boolean
language sql stable as $$
  select p_tz is not null
     and exists (select 1 from pg_timezone_names where name = p_tz);
$$;

/** Rensa och begränsa luckorna. Utanför 0–167 är alltid ett fel. */
create or replace function public.clean_slots(p_slots int[])
returns smallint[]
language sql immutable as $$
  select coalesce(
    (select array_agg(distinct s::smallint order by s::smallint)
       from unnest(coalesce(p_slots, '{}')) as s
      where s between 0 and 167),
    '{}'::smallint[]
  );
$$;

/* ==================== FUNKTIONER FÖR KLIENTEN ======================= */

/**
 * Spara eller uppdatera prenumerationen. Anropas av js/push.js -> enable().
 *
 * Om konfliktregeln: raden ägs av den enhet som skapade den. Undantaget
 * "auth.uid() is not null" finns för övergången gäst → inloggad. Samma
 * telefon behåller sin endpoint när man loggar in, men actor() byter från det
 * slumpade enhets-id:t till konto-id:t, och utan undantaget hade uppdateringen
 * tyst gjort ingenting och notiserna slutat komma efter inloggning.
 *
 * Det öppnar teoretiskt för att ett inloggat konto tar över en rad — men bara
 * om det redan känner till endpointen, som aldrig lämnar servern (ingen
 * läsregel) och som pushtjänsten genererar med långt mer entropi än något går
 * att gissa. Den som har endpointen har redan allt den ger.
 */
create or replace function public.save_push_subscription(
  p_endpoint  text,
  p_p256dh    text,
  p_auth      text,
  p_device    text,
  p_timezone  text  default 'Europe/Stockholm',
  p_slots     int[] default '{}')
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text; v_tz text;
begin
  v_actor := public.actor(p_device);
  if v_actor is null or v_actor = '' then
    raise exception 'saknar identitet';
  end if;

  -- https, inget annat. En endpoint över http hade läckt hela pushen, och en
  -- data:- eller file:-URL är bara ett försök att få servern att göra något
  -- annat än att pusha.
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then
    raise exception 'ogiltig endpoint';
  end if;

  -- Nycklarna har fasta längder i base64url: p256dh är 65 byte -> 87 tecken,
  -- auth är 16 byte -> 22 tecken. Spannen nedan är generösa med flit, ifall
  -- någon webbläsare skickar med utfyllnad, men stoppar ändå fältfyllnad.
  if p_p256dh is null or length(p_p256dh) not between 80 and 100
     or p_auth is null or length(p_auth) not between 16 and 30 then
    raise exception 'ogiltiga nycklar';
  end if;

  v_tz := case when public.valid_timezone(p_timezone) then p_timezone else 'Europe/Stockholm' end;

  insert into push_subscriptions
    (endpoint, p256dh, auth, device_id, timezone, slots)
  values
    (p_endpoint, p_p256dh, p_auth, v_actor, v_tz, public.clean_slots(p_slots))
  on conflict (endpoint) do update set
    p256dh     = excluded.p256dh,
    auth       = excluded.auth,
    device_id  = excluded.device_id,
    timezone   = excluded.timezone,
    slots      = excluded.slots,
    enabled    = true,
    failures   = 0,          -- ny prenumeration, gamla fel är inte längre sanna
    last_error = null,
    updated_at = now()
  where push_subscriptions.device_id = v_actor
     or auth.uid() is not null;
end $$;

/** Uppdatera vanorna utan att röra nycklarna. js/push.js -> syncSlots(). */
create or replace function public.set_push_slots(
  p_endpoint text, p_device text, p_slots int[], p_timezone text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  v_actor := public.actor(p_device);
  update push_subscriptions set
    slots      = public.clean_slots(p_slots),
    timezone   = case when public.valid_timezone(p_timezone) then p_timezone else timezone end,
    updated_at = now()
  where endpoint = p_endpoint and device_id = v_actor;
end $$;

/**
 * "Jag har redan kört idag."
 *
 * Anropas när js/driving.js känner att bilen rullar. Utan det här skickar
 * servern påminnelsen 07:15 till någon som satte sig i bilen 07:05 — och en
 * notis om något man redan gjort är det snabbaste sättet att få någon att
 * stänga av notiser helt.
 *
 * Datumet räknas i radens egen tidszon, inte serverns UTC. Kör man 00:30 en
 * lördag ska lördagen räknas som avklarad, inte fredagen.
 */
create or replace function public.mark_drove_today(p_endpoint text, p_device text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  v_actor := public.actor(p_device);
  -- Alias på tabellen: utan den står ett naket "timezone" i uttrycket, och
  -- det finns en inbyggd funktion med samma namn. Kolumnen vinner, men den
  -- som läser koden ska inte behöva veta det.
  update push_subscriptions s set
    last_drive_date = (now() at time zone s.timezone)::date,
    updated_at      = now()
  where s.endpoint = p_endpoint and s.device_id = v_actor;
end $$;

/** Stäng av notiser. js/push.js -> disable(). */
create or replace function public.delete_push_subscription(p_endpoint text, p_device text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  v_actor := public.actor(p_device);
  delete from push_subscriptions
   where endpoint = p_endpoint and device_id = v_actor;
end $$;

grant execute on function public.save_push_subscription(text, text, text, text, text, int[])
  to anon, authenticated;
grant execute on function public.set_push_slots(text, text, int[], text)
  to anon, authenticated;
grant execute on function public.mark_drove_today(text, text)
  to anon, authenticated;
grant execute on function public.delete_push_subscription(text, text)
  to anon, authenticated;

/* ===================== FUNKTIONER FÖR SERVERN ======================= */

/**
 * Vilka ska pingas nu? Enda frågan edge-funktionen ställer.
 *
 * Anropas var femte minut. p_lead_minutes är hur långt före luckan
 * påminnelsen ska komma — 15 minuter är vald för att hinna med "ta på jackan
 * och gå ut till bilen" utan att vara så tidig att man hunnit glömma den igen.
 *
 * Alla fyra spärrar nedan finns för att lösa varsitt verkligt problem, och
 * ingen av dem är utbytbar mot en annan:
 *
 *   nattspärren   inga notiser före klockan fem lokalt. En felinlärd lucka —
 *                 en enda nattkörning som råkade upprepas — får aldrig väcka
 *                 någon 03:00. Vanorna kommer från riktiga körningar, men den
 *                 dagen datan är fel vill vi inte att felet ringer i sovrummet.
 *
 *   körspärren    har bilen redan rullat idag hoppas hela dygnet över.
 *
 *   luckspärren   en påminnelse per lucka och dygn. Cron kör var femte minut
 *                 och skulle annars träffa samma lucka tre gånger i rad
 *                 (kl 45, 50 och 55 före en timme som börjar 08:00).
 *
 *   takspärren    högst tre om dygnet och minst 90 minuter emellan. Den som
 *                 kör mycket har många luckor, och den som får sex notiser om
 *                 dagen stänger av dem. Taket är det som skyddar kanalen.
 *
 * Notera "at time zone timezone": luckan räknas i telefonens tid, inte
 * serverns. Utan det hade svenska användare fått påminnelsen en eller två
 * timmar fel beroende på sommartid, eftersom Supabase kör UTC.
 */
create or replace function public.due_push_reminders(
  p_lead_minutes int default 15,
  p_limit        int default 500)
returns table (
  endpoint text,
  p256dh   text,
  auth     text,
  slot     smallint,
  hour     smallint,
  timezone text
)
language sql security definer set search_path = public stable as $$
  with kandidater as (
    select
      s.*,
      (now() at time zone s.timezone) as lokal,
      (now() at time zone s.timezone) + make_interval(mins => p_lead_minutes) as mal
    from push_subscriptions s
    where s.enabled and s.failures < 5 and array_length(s.slots, 1) > 0
  ),
  med_lucka as (
    select
      k.*,
      (extract(dow from k.mal)::int * 24 + extract(hour from k.mal)::int)::smallint as v_slot,
      k.lokal::date as v_datum
    from kandidater k
  )
  select
    m.endpoint, m.p256dh, m.auth,
    m.v_slot,
    extract(hour from m.mal)::smallint,
    m.timezone
  from med_lucka m
  where m.slots @> array[m.v_slot]
    and extract(hour from m.lokal) >= 5
    and (m.last_drive_date is null or m.last_drive_date <> m.v_datum)
    -- "is distinct from", inte "=". På en ny rad är sent_date och last_slot
    -- NULL, och en vanlig jämförelse ger då NULL — inte falskt. NOT NULL är
    -- fortfarande NULL, WHERE släpper bara igenom sant, och resultatet hade
    -- blivit att en nyregistrerad telefon aldrig någonsin får sin första
    -- påminnelse. Ett fel som inte syns i loggen: allt ser rätt ut, det bara
    -- händer ingenting.
    and not (m.sent_date is not distinct from m.v_datum
             and m.last_slot is not distinct from m.v_slot)
    and (m.sent_date is distinct from m.v_datum or m.sent_today < 3)
    and (m.last_sent_at is null or m.last_sent_at < now() - interval '90 minutes')
  order by m.last_sent_at nulls first
  limit greatest(1, least(p_limit, 2000));
$$;

/**
 * Notera att pushen gick iväg.
 *
 * Skrivs efter att pushtjänsten kvitterat, aldrig före. Blir ordningen omvänd
 * och funktionen dör mitt i, är luckan förbrukad utan att någon notis kommit
 * fram — och användaren får ingenting, den dagen det spelade roll.
 */
create or replace function public.mark_push_sent(p_endpoint text, p_slot int)
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
 * Prenumerationen finns inte längre. Raderas direkt.
 *
 * 404 och 410 från pushtjänsten betyder att appen avinstallerats, att
 * webbläsardata rensats, eller att användaren stängt av notiser i systemet.
 * Det tillståndet går aldrig tillbaka — samma endpoint kommer aldrig att
 * fungera igen. Att behålla raden ger bara ett anrop till ingenstans var
 * femte minut, i all evighet, och till slut hamnar vi på pushtjänstens
 * spärrlista för att vi hamrar mot döda adresser.
 */
create or replace function public.drop_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint;
$$;

/**
 * Något annat gick fel: 429, 500, timeout, nätet.
 *
 * Raden får INTE raderas här. De felen är tillfälliga, och den som raderar på
 * en 500 tappar en riktig användare för att pushtjänsten hade en dålig minut.
 * Istället räknas felen upp, och vid fem i rad slutar raden komma med i
 * due_push_reminders — men den ligger kvar, och nollställs så fort appen
 * öppnas och prenumerationen sparas om.
 */
create or replace function public.note_push_failure(
  p_endpoint text, p_error text, p_count boolean default true)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update push_subscriptions set
    -- p_count = false för 429. Att bli rate limitad är VÅRT fel — vi skickar
    -- för fort — och att räkna det som ett fel på prenumerationen hade i
    -- värsta fall stängt av en fullt fungerande användare för att
    -- pushtjänsten hade en tung eftermiddag. Felet noteras ändå, så det syns
    -- i last_error att det händer.
    failures   = case when p_count then least(failures + 1, 32000) else failures end,
    last_error = left(p_error, 500),
    updated_at = now()
  where endpoint = p_endpoint;
end $$;

/* ====================== RÄTTIGHETER (VIKTIGT) ======================= */
-- Utan de här raderna kan vem som helst med anon-nyckeln anropa
-- due_push_reminders och få ut varje användares endpoint och auth-hemlighet.
-- Det är den allvarligaste enskilda risken i hela filen.

revoke execute on function public.due_push_reminders(int, int)   from public, anon, authenticated;
revoke execute on function public.mark_push_sent(text, int)      from public, anon, authenticated;
revoke execute on function public.drop_push_subscription(text)   from public, anon, authenticated;
revoke execute on function public.note_push_failure(text, text, boolean) from public, anon, authenticated;

grant execute on function public.due_push_reminders(int, int)   to service_role;
grant execute on function public.mark_push_sent(text, int)      to service_role;
grant execute on function public.drop_push_subscription(text)   to service_role;
grant execute on function public.note_push_failure(text, text, boolean) to service_role;

/* ========================== VY FÖR ADMIN ============================ */
/**
 * Hur mår notiserna? Kör i SQL-editorn då och då.
 *
 * security_invoker = on, så att anon stoppas av den tomma radsäkerheten på
 * tabellen under. Supabase delar automatiskt ut SELECT på nya vyer till anon,
 * och en vy med invoker av hade läst förbi radsäkerheten — och därmed lämnat
 * ut precis de hemligheter tabellen är byggd för att skydda.
 * Vyn visar därför heller aldrig auth eller p256dh, bara räknare.
 */
create or replace view public.push_health
with (security_invoker = on) as
  select
    count(*)                                               as prenumerationer,
    count(*) filter (where enabled and failures < 5)       as aktiva,
    count(*) filter (where failures >= 5)                  as trasiga,
    count(*) filter (where array_length(slots, 1) > 0)     as med_vanor,
    count(*) filter (where last_sent_at > now() - interval '24 hours') as pushade_senaste_dygnet,
    max(last_sent_at)                                      as senaste_utskick
  from public.push_subscriptions;

revoke all on public.push_health from anon, authenticated;

/* =========================== STÄDNING =============================== */

/**
 * Rader som inte hörts av på ett halvår.
 *
 * En prenumeration som varken pushats eller sparats om på sex månader hör
 * till en telefon som inte finns kvar. Pushtjänsterna svarar inte alltid 410
 * för dem, så de måste städas på tid istället.
 */
create or replace function public.purge_dead_push()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from push_subscriptions
   where updated_at < now() - interval '180 days'
     and (last_sent_at is null or last_sent_at < now() - interval '180 days');
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.purge_dead_push() from public, anon, authenticated;
grant execute on function public.purge_dead_push() to service_role;

-- select cron.schedule('purge-push', '30 4 * * *', 'select public.purge_dead_push()');

/* ========================= SCHEMALÄGGNING =========================== */
-- Själva utskicket sköts av edge-funktionen send-reminder, som måste anropas
-- var femte minut. Två vägar, se docs/NOTISER.md för vilken du ska välja:
--
--   1. Supabase Dashboard -> Edge Functions -> Schedules (enklast)
--   2. pg_cron + pg_net, om du hellre vill ha allt i databasen:
--
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.schedule(
--   'polisvakt-paminnelser', '*/5 * * * *', $cron$
--   select net.http_post(
--     url     := 'https://<projekt>.supabase.co/functions/v1/send-reminder',
--     headers := jsonb_build_object(
--       'Content-Type',  'application/json',
--       'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
--       'x-cron-secret', current_setting('app.cron_secret', true)
--     ),
--     body    := '{}'::jsonb
--   );
--   $cron$
-- );
--
-- Nycklarna får INTE stå i klartext i cron.job — tabellen är läsbar för alla
-- med databasåtkomst och hamnar i varje backup. Sätt dem som
-- databasinställningar istället, en gång:
--
-- alter database postgres set app.service_role_key = 'eyJ...';
-- alter database postgres set app.cron_secret      = '<slumpad sträng>';
