/* =====================================================================
   POLISVAKT — SAMLAD DATABASKÖRNING
   =====================================================================

   Kör hela den här filen i ett svep i Supabase SQL Editor.

   Allt ligger i EN transaktion. Går något fel någonstans rullas precis
   allt tillbaka och databasen står kvar exakt som innan. Du kan alltså
   inte hamna i ett halvmigrerat läge.

   Filen går att köra om. Tabeller skapas bara om de saknas, funktioner
   och vyer ersätts. Ingen befintlig rapport, konto eller prenumeration
   rörs — den enda raderingen som finns i filen ligger inuti en
   städfunktion som körs på schema, inte vid installationen.

   Innehåll, i beroendeordning:

     1  schema.sql          grundtabeller, röstning, poäng, tillbehör
     2  anvandarnamn.sql    logga in med namn istället för e-post
     3  dolj-enhets-id.sql  slutar läcka vilken enhet som rapporterat
     4  push.sql            notiser som når fram när appen är stängd
     5  grupper.sql         privata grupper för åkerier och kompisgäng

   Ordningen är inte godtycklig: vyn reports_feed måste finnas innan
   grupper.sql ändrar den, och grunden måste finnas innan resten.
   ===================================================================== */

begin;



/* ###################################################################
   ### schema.sql                                                 ###
   ################################################################### */

-- Polisvakt — Supabase-schema
--
-- Kör hela filen i Supabase SQL Editor. Efteråt: kopiera projektets URL och
-- anon-nyckeln till appens inställningar (Delning -> Delat med alla).
--
-- Om säkerhetsmodellen: appen har ingen inloggning. Alla klienter använder
-- samma anon-nyckel, och enheten identifierar sig med ett slumpat device_id.
-- Det räcker för en varningstjänst men gör inte anon-nyckeln hemlig — allt
-- härunder är skrivet med det i åtanke. Räknare uppdateras bara genom
-- funktioner, aldrig genom direkt UPDATE, och ingen kan ändra andras rader.

/* ============================= RAPPORTER ============================= */

create table if not exists public.reports (
  id           text primary key,
  type         text not null check (type in ('police','camera','control','unmarked')),
  lat          double precision not null check (lat between -90 and 90),
  lon          double precision not null check (lon between -180 and 180),
  label        text default '',
  note         text default '',
  source       text default 'app' check (source in ('app','voice','facebook','import')),
  device_id    text not null,
  external_id  text unique,               -- t.ex. Facebook-inläggets id
  created_at   bigint not null,           -- millisekunder sedan epoch
  expires_at   bigint not null,
  confirms     int not null default 1,
  denials      int not null default 0,
  removed      boolean not null default false,
  inserted_at  timestamptz not null default now()
);

create index if not exists reports_expires_idx on public.reports (expires_at desc);
create index if not exists reports_geo_idx     on public.reports (lat, lon);

-- Röstas ner tillräckligt av tillräckligt många: göm den.
create or replace view public.reports_active as
  select * from public.reports
  where removed = false
    and expires_at > (extract(epoch from now()) * 1000)::bigint
    and not (denials >= 3 and denials > confirms);

alter table public.reports enable row level security;

-- Alla får läsa. Rapporter är hela poängen med tjänsten.
drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports
  for select to anon, authenticated using (true);

-- Alla får skapa, men bara rimliga rader: inom Sverige, rimlig livslängd,
-- och räknarna måste börja på noll så ingen kan skapa en förfalskat
-- "bekräftad" rapport.
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to anon, authenticated
  with check (
    lat between 55 and 70 and lon between 10 and 25
    and expires_at > created_at
    -- Notera bigint-casten. Utan den räknar Postgres 1000*60*60*24*400 som
    -- 32-bitars heltal, får overflow vid 2,1 miljarder, och avvisar varje
    -- skrivning med "integer out of range" — trots att raden är helt korrekt.
    and expires_at < created_at + (400::bigint * 24 * 60 * 60 * 1000)
    and confirms <= 1 and denials = 0
    and removed = false
    and length(coalesce(label, '')) <= 120
    and length(coalesce(note, '')) <= 500
  );

-- Ingen direkt UPDATE eller DELETE. Använd funktionerna nedan.

/* ====================== FUNKTIONER FÖR RÖSTNING ====================== */

create table if not exists public.report_votes (
  report_id text not null references public.reports(id) on delete cascade,
  device_id text not null,
  vote      smallint not null check (vote in (-1, 1)),
  voted_at  timestamptz not null default now(),
  primary key (report_id, device_id)
);
alter table public.report_votes enable row level security;
-- Inga policies: tabellen nås bara via SECURITY DEFINER-funktionerna.

/**
 * Vem utför åtgärden?
 *
 * För en inloggad användare tas identiteten ur JWT:n, aldrig ur det klienten
 * påstår. Rapportflödet är publikt och innehåller device_id, så utan det här
 * hade vem som helst kunnat plocka ett id ur flödet och sedan rösta eller
 * radera i den personens namn.
 *
 * Gäster har ingen JWT och får fortsatt lita på sitt slumpade enhets-id. Det
 * går att kringgå, men gästen har heller ingenting att stjäla.
 */
create or replace function public.actor(p_device text)
returns text
language sql stable as $$
  select coalesce(nullif(auth.uid()::text, ''), p_device);
$$;

create or replace function public.confirm_report(p_id text, p_device text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_ttl int; v_actor text;
begin
  v_actor := public.actor(p_device);

  -- En enhet, en röst
  insert into report_votes (report_id, device_id, vote) values (p_id, v_actor, 1)
  on conflict (report_id, device_id) do update set vote = 1, voted_at = now();

  select case type when 'control' then 60 when 'unmarked' then 30 else 45 end
    into v_ttl from reports where id = p_id;

  update reports set
    confirms   = (select count(*) from report_votes where report_id = p_id and vote = 1) + 1,
    denials    = (select count(*) from report_votes where report_id = p_id and vote = -1),
    expires_at = greatest(
      expires_at,
      (extract(epoch from now()) * 1000)::bigint + (v_ttl * 0.6 * 60000)::bigint
    )
  where id = p_id;
end $$;

create or replace function public.deny_report(p_id text, p_device text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  v_actor := public.actor(p_device);

  insert into report_votes (report_id, device_id, vote) values (p_id, v_actor, -1)
  on conflict (report_id, device_id) do update set vote = -1, voted_at = now();

  update reports set
    confirms = (select count(*) from report_votes where report_id = p_id and vote = 1) + 1,
    denials  = (select count(*) from report_votes where report_id = p_id and vote = -1)
  where id = p_id;
end $$;

-- Bara den som skapade rapporten får ta bort den helt.
create or replace function public.remove_report(p_id text, p_device text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  v_actor := public.actor(p_device);

  update reports set removed = true, expires_at = (extract(epoch from now()) * 1000)::bigint
  where id = p_id and device_id = v_actor;

  -- Inte din rapport? Då blir det en nedröstning istället, inte en radering.
  if not found then
    perform public.deny_report(p_id, p_device);
  end if;
end $$;

/**
 * Skriv din egen poängrad. Identiteten kommer från JWT:n för inloggade, så
 * ingen kan skriva över någon annans rad. Vinnarna räknas ändå fram ur
 * riktiga rapporter i vyn monthly_winners — den här tabellen är bara till
 * för att visa topplistan snabbt.
 */
create or replace function public.publish_score(
  p_device text, p_month text, p_nickname text, p_score int, p_reports int)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  v_actor := public.actor(p_device);
  if p_score < 0 or p_score > 100000 then return; end if;

  insert into reporter_scores (device_id, month, nickname, score, reports)
  values (v_actor, p_month, left(coalesce(p_nickname, ''), 20), p_score, greatest(0, p_reports))
  on conflict (device_id, month) do update
    set nickname = excluded.nickname,
        score = excluded.score,
        reports = excluded.reports,
        updated_at = now();
end $$;

grant execute on function public.actor(text)          to anon, authenticated;
grant execute on function public.confirm_report(text, text) to anon, authenticated;
grant execute on function public.deny_report(text, text)    to anon, authenticated;
grant execute on function public.remove_report(text, text)  to anon, authenticated;
grant execute on function public.publish_score(text, text, text, int, int) to anon, authenticated;

/* ========================== PRENUMERATION =========================== */

create table if not exists public.subscribers (
  device_id   text primary key,
  trial_start timestamptz not null default now(),
  paid_until  timestamptz,
  email       text,
  stripe_id   text,
  updated_at  timestamptz not null default now()
);

alter table public.subscribers enable row level security;

-- INGEN öppen läsregel här. Tabellen innehåller e-postadresser, Stripe-id och
-- betalstatus, och anon-nyckeln ligger öppet i appens källkod — en regel med
-- "using (true)" hade låtit vem som helst hämta hela kundlistan med ett enda
-- anrop. Inloggade får läsa sin egen rad, och gäster går via funktionen
-- get_subscription som bara lämnar ut de två datum appen faktiskt behöver.

drop policy if exists subs_read on public.subscribers;
create policy subs_read on public.subscribers
  for select to authenticated
  using (device_id = auth.uid()::text);

drop policy if exists subs_insert on public.subscribers;
create policy subs_insert on public.subscribers
  for insert to anon, authenticated
  with check (paid_until is null and email is null and stripe_id is null);

-- Ingen UPDATE-policy: bara Stripe-webhooken (service role) får sätta paid_until.

/**
 * Hämta prenumerationsstatus för en enhet. Returnerar bara datumen — aldrig
 * e-post eller betalningsuppgifter. Att gissa någon annans device_id ger
 * alltså ingenting av värde.
 */
create or replace function public.get_subscription(p_device text)
returns table (trial_start timestamptz, paid_until timestamptz)
language sql security definer set search_path = public stable as $$
  select s.trial_start, s.paid_until
  from public.subscribers s
  where s.device_id = p_device;
$$;

grant execute on function public.get_subscription(text) to anon, authenticated;

/* ============================ KODER ================================= */
-- Tänkt för manuell försäljning innan Stripe är på plats: generera koder,
-- sälj via Swish, kunden löser in i appen.

create table if not exists public.access_codes (
  code        text primary key,
  months      int not null default 1,
  used_by     text,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.access_codes enable row level security;
-- Inga policies: nås bara via funktionen.

create or replace function public.redeem_code(p_code text, p_device text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_months int; v_until timestamptz;
begin
  select months into v_months from access_codes
  where code = upper(p_code) and used_by is null
  for update;

  if v_months is null then return null; end if;

  update access_codes set used_by = p_device, used_at = now() where code = upper(p_code);

  insert into subscribers (device_id, paid_until)
  values (p_device, now() + (v_months || ' months')::interval)
  on conflict (device_id) do update
    set paid_until = greatest(coalesce(subscribers.paid_until, now()), now())
                     + (v_months || ' months')::interval,
        updated_at = now()
  returning paid_until into v_until;

  return v_until;
end $$;

grant execute on function public.redeem_code(text, text) to anon, authenticated;

-- Exempel: skapa tio koder
-- insert into access_codes (code, months)
-- select 'PV' || upper(substr(md5(random()::text), 1, 6)), 1 from generate_series(1, 10);

/* =========================== STÄDNING =============================== */
-- Kör som schemalagd funktion (pg_cron) eller manuellt då och då.

create or replace function public.purge_old_reports()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from reports
  where expires_at < (extract(epoch from now()) * 1000)::bigint - 1000*60*60*24*7;
  get diagnostics n = row_count;
  return n;
end $$;

-- select cron.schedule('purge-reports', '0 4 * * *', 'select public.purge_old_reports()');

/* ======================= HISTORIK FÖR MÖNSTER ======================= */
-- Rapporter rensas efter en vecka, men mönstren de bildar är värdefulla i
-- månader. Historiken sparar därför plats, typ och tidpunkt — men aldrig vem
-- som rapporterade. Det behövs inte för statistiken och ska inte lagras.

create table if not exists public.report_history (
  id         bigserial primary key,
  type       text not null,
  lat        double precision not null,
  lon        double precision not null,
  label      text,
  created_at bigint not null
);

create index if not exists history_time_idx on public.report_history (created_at desc);
create index if not exists history_geo_idx  on public.report_history (lat, lon);

create or replace function public.archive_report()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into report_history (type, lat, lon, label, created_at)
  values (new.type, new.lat, new.lon, nullif(new.label, ''), new.created_at);
  return new;
end $$;

drop trigger if exists reports_archive on public.reports;
create trigger reports_archive after insert on public.reports
  for each row execute function public.archive_report();

alter table public.report_history enable row level security;

drop policy if exists history_read on public.report_history;
create policy history_read on public.report_history
  for select to anon, authenticated using (true);
-- Ingen insert-policy: bara triggern (security definer) skriver hit.

/* ========================== RAPPORTPOÄNG ============================ */
-- De tio som rapporterar mest under en månad får nästa månad gratis.

create table if not exists public.reporter_scores (
  device_id  text not null,
  month      text not null,               -- 'ÅÅÅÅ-MM'
  nickname   text,
  score      int not null default 0,
  reports    int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (device_id, month)
);

create index if not exists scores_month_idx on public.reporter_scores (month, score desc);

alter table public.reporter_scores enable row level security;

-- Ingen direktläsning: raderna innehåller device_id, som för inloggade är
-- samma sak som deras konto-id. Topplistan går via en vy utan det fältet.
drop policy if exists scores_read on public.reporter_scores;
create policy scores_read on public.reporter_scores
  for select to authenticated
  using (device_id = auth.uid()::text);

create or replace view public.leaderboard
with (security_invoker = off) as
  select
    row_number() over (order by score desc, reports desc) as rank,
    coalesce(nullif(nickname, ''), 'Anonym') as nickname,
    score,
    reports
  from public.reporter_scores
  where month = to_char(now(), 'YYYY-MM')
  order by score desc, reports desc
  limit 50;

grant select on public.leaderboard to anon, authenticated;

-- Klienten får skriva sin egen rad. Poängen går att ljuga om — därför är
-- kolumnen reports med, så du kan jämföra mot verkligheten innan du delar ut
-- belöningar. Sanningen finns i reports-tabellen.
-- Inga skrivregler: allt gar via publish_score, som tar identiteten ur JWT:n
-- istallet for att lita pa vad klienten skickar.

-- Månadens vinnare, räknad på riktiga rapporter istället för klientens ord.
-- Kör den här i slutet av månaden och dela ut koder till de tio översta.
create or replace view public.monthly_winners as
  select
    r.device_id,
    max(s.nickname)                                   as nickname,
    count(*)                                          as reports,
    sum(greatest(0, r.confirms - 1))                  as confirmations,
    sum(r.denials)                                    as denials,
    count(*) + sum(greatest(0, r.confirms - 1)) * 3
             - sum(r.denials) * 4                     as score
  from public.reports r
  left join public.reporter_scores s
    on s.device_id = r.device_id
   and s.month = to_char(to_timestamp(r.created_at / 1000), 'YYYY-MM')
  where to_timestamp(r.created_at / 1000) >= date_trunc('month', now())
    and r.source in ('app', 'voice')
  group by r.device_id
  order by score desc;

-- select * from monthly_winners limit 10;

/* ====================== INTRESSE FÖR TILLBEHÖR ====================== */
-- Innan vi beställer femhundra mobilhållare från Kina vill vi veta hur många
-- som faktiskt vill ha en. Knappen i appen registrerar intresse, inte köp.

create table if not exists public.product_interest (
  device_id  text not null,
  product    text not null,
  email      text,
  created_at bigint not null,
  primary key (device_id, product)
);

alter table public.product_interest enable row level security;

-- Alla får anmäla intresse. Ingen får läsa listan — den innehåller
-- e-postadresser och hör hemma i admin, inte i klienten.
drop policy if exists interest_insert on public.product_interest;
create policy interest_insert on public.product_interest
  for insert to anon, authenticated
  with check (length(product) <= 40 and length(coalesce(email, '')) <= 120);

-- Hur många vill ha vad? Kör i SQL-editorn inför en beställning.
create or replace view public.interest_summary as
  select product, count(*) as antal, count(email) as med_epost
  from public.product_interest
  group by product
  order by antal desc;


/* ###################################################################
   ### anvandarnamn.sql                                           ###
   ################################################################### */

/* =====================================================================
   ANVÄNDARNAMN — logga in med namn eller e-post
   =====================================================================

   Supabase Auth känner bara till e-post. Ska man kunna logga in med
   "elliot" måste namnet växlas till en e-postadress innan lösenordet
   skickas iväg. Det är den växlingen som är känslig, och därför ligger
   hela logiken här på servern istället för i appen.

   Tre funktioner, och gränsen mellan dem är medvetet dragen:

     username_available  ledigt eller inte, före registrering
     claim_username      knyt namnet till mitt konto, kräver inloggning
     email_for_login     namn + rätt lösenord -> e-post

   Den sista är hjärtat i det hela. En naken uppslagning namn -> e-post
   hade varit en gratis adresslista: skicka in tusen vanliga förnamn och
   få ut tusen e-postadresser att spamma eller lösenordsgissa på. Därför
   kräver funktionen rätt lösenord innan den lämnar ut något. Den som
   redan kan lösenordet kan ändå logga in, så vi röjer ingenting nytt.

   Fel lösenord och okänt namn ger exakt samma svar (null). Annars gick
   det att kartlägga vilka namn som finns genom att jämföra svaren.

   Beroenden: schema.sql behöver inte vara kört först. Filen går att köra
   om hur många gånger som helst utan att något går sönder.
   ===================================================================== */

/* ------------------------- Tabellen -------------------------------- */

create table if not exists public.usernames (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now()
);

-- Unikt oavsett skiftläge. "Elliot" och "elliot" får inte vara två personer:
-- annars kan någon registrera ett namn som ser identiskt ut med ditt och
-- utge sig för att vara dig i topplistan.
create unique index if not exists usernames_unique_ci
  on public.usernames (lower(username));

alter table public.usernames enable row level security;

-- Medvetet noll policies.
--
-- Ingen policy alls betyder att ingen kan läsa eller skriva tabellen direkt
-- via REST — inte ens med giltig inloggning. Allt går genom funktionerna
-- nedan. Det är själva poängen: kunde man läsa tabellen vore den en färdig
-- lista över alla användarnamn och vilka konton de hör till.
revoke all on public.usernames from anon, authenticated;

/* ------------------- Bromsen mot lösenordsgissning ------------------ */

create table if not exists public.login_lookups (
  username text not null,
  at       timestamptz not null default now()
);

create index if not exists login_lookups_idx
  on public.login_lookups (username, at desc);

revoke all on public.login_lookups from anon, authenticated;

/* ------------------------- Namnreglerna ----------------------------- */

create or replace function public.valid_username(p_username text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp as $$
begin
  if p_username is null then return false; end if;

  -- 3–20 tecken, måste börja på en bokstav. Siffror först öppnar för namn
  -- som liknar id-nummer, och rena siffernamn krockar med hur vi visar
  -- placeringar i topplistan.
  if p_username !~ '^[a-zåäö][a-zåäö0-9._-]{2,19}$' then return false; end if;

  -- Två skiljetecken i rad gör "el..liot" och "el.liot" svåra att skilja åt
  -- med blotta ögat. Det är precis vad någon som vill utge sig för dig vill.
  if p_username ~ '[._-]{2,}' then return false; end if;
  if p_username ~ '[._-]$'    then return false; end if;

  -- Namn som får folk att tro att de pratar med oss eller med polisen.
  if p_username in (
    'admin', 'administrator', 'root', 'system', 'support', 'hjalp', 'help',
    'polis', 'polisen', 'police', 'polisvakt', 'moderator', 'mod', 'info',
    'kontakt', 'security', 'sakerhet', 'anonym', 'test'
  ) then return false; end if;

  return true;
end $$;

/* ---------------------- Är namnet ledigt? --------------------------- */
/*
 * Svarar bara ja eller nej. Aldrig vem som har namnet.
 *
 * Att den här går att anropa utan inloggning är ett medvetet val: ett
 * registreringsformulär måste kunna säga "upptaget" medan man skriver.
 * Priset är att någon kan ta reda på vilka namn som är tagna. Det priset
 * betalar varje tjänst med öppen registrering, och det är litet — ett
 * taget namn utan e-post är inget att göra något med. Det farliga vore
 * kopplingen namn -> e-post, och den kräver lösenord.
 */
create or replace function public.username_available(p_username text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp as $$
begin
  if not public.valid_username(lower(trim(p_username))) then
    return false;                       -- ogiltigt är i praktiken upptaget
  end if;

  return not exists (
    select 1 from public.usernames
    where lower(username) = lower(trim(p_username))
  );
end $$;

/* --------------------- Knyt namnet till kontot ---------------------- */
/*
 * Kräver inloggning, och tar identiteten ur JWT:n — aldrig ur ett argument
 * från klienten. Skickade appen in ett user_id kunde vem som helst döpa om
 * någon annans konto.
 *
 * Returnerar en kort kod som appen översätter till svenska.
 */
create or replace function public.claim_username(p_username text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := lower(trim(p_username));
begin
  if v_uid is null then return 'inte_inloggad'; end if;
  if not public.valid_username(v_name) then return 'ogiltigt'; end if;

  -- Taget av någon annan?
  if exists (
    select 1 from public.usernames
    where lower(username) = v_name and user_id <> v_uid
  ) then
    return 'upptaget';
  end if;

  insert into public.usernames (user_id, username)
  values (v_uid, v_name)
  on conflict (user_id) do update set username = excluded.username;

  return 'ok';
exception
  -- Två personer som tar samma namn i samma sekund. Den som förlorar
  -- kapplöpningen ska få "upptaget", inte ett rått databasfel.
  when unique_violation then return 'upptaget';
end $$;

/* ------------------- Namn + lösenord -> e-post ---------------------- */
/*
 * Den känsliga. Läser auth.users, som ingen klient kommer åt annars.
 *
 * Ordningen spelar roll: vi bromsar FÖRE vi tittar på lösenordet. Annars
 * blir funktionen ett gissningsverktyg som svarar snabbt på fel lösenord
 * och långsamt på rätt.
 *
 * Vi loggar varje försök per namn, inte per avsändare. IP-adressen når oss
 * inte här inne, och att bromsa per konto skyddar just det konto som är
 * under attack. Nackdelen är att någon kan låsa ditt namn i ett kvart
 * genom att spamma fel lösenord — men bara namnvägen. E-postvägen in är
 * orörd, så du kommer alltid in.
 */
create or replace function public.email_for_login(p_username text, p_password text)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp as $$
declare
  v_name  text := lower(trim(p_username));
  v_tries int;
  v_user  record;
begin
  if v_name is null or v_name = '' or p_password is null then
    return null;
  end if;

  -- Städa gammalt först, annars växer tabellen för alltid.
  delete from public.login_lookups where at < now() - interval '1 hour';

  select count(*) into v_tries
  from public.login_lookups
  where username = v_name and at > now() - interval '15 minutes';

  if v_tries >= 10 then
    return null;
  end if;

  insert into public.login_lookups (username) values (v_name);

  select u.email, u.encrypted_password
    into v_user
  from public.usernames n
  join auth.users u on u.id = n.user_id
  where lower(n.username) = v_name;

  -- Okänt namn. Vi returnerar null utan att avslöja att namnet saknas —
  -- exakt samma svar som fel lösenord ger nedan.
  if not found or v_user.encrypted_password is null then
    return null;
  end if;

  -- Lösenordet ligger som bcrypt. crypt() med den lagrade hashen som salt
  -- ger samma hash tillbaka om lösenordet stämmer.
  if extensions.crypt(p_password, v_user.encrypted_password) <> v_user.encrypted_password then
    return null;
  end if;

  -- Rätt lösenord: nollställ bromsen så en inloggad användare inte straffas
  -- för sina egna felskrivningar tidigare i kvarten.
  delete from public.login_lookups where username = v_name;

  return v_user.email;
end $$;

/* --------------------------- Rättigheter ---------------------------- */
/*
 * Funktioner tilldelas PUBLIC automatiskt i Postgres. Att bara återkalla
 * från anon räcker därför INTE — den underförstådda rättigheten till
 * PUBLIC ligger kvar och funktionen går fortfarande att anropa. Vi tar
 * bort allt först och delar sedan ut det vi faktiskt menar.
 */
revoke all on function public.valid_username(text)             from public;
revoke all on function public.username_available(text)         from public;
revoke all on function public.claim_username(text)             from public;
revoke all on function public.email_for_login(text, text)      from public;

-- Före inloggning: appen måste kunna kolla ledigt namn och växla namn->e-post.
grant execute on function public.username_available(text)      to anon, authenticated;
grant execute on function public.email_for_login(text, text)   to anon, authenticated;

-- Efter inloggning: bara den som har en giltig session får ta ett namn.
grant execute on function public.claim_username(text)          to authenticated;


/* ###################################################################
   ### dolj-enhets-id.sql                                         ###
   ################################################################### */

/* =====================================================================
   DÖLJ ENHETS-ID — vyn reports_feed
   =====================================================================

   Problemet: appen läser rapporter med den publika nyckeln, och tabellen
   reports innehåller kolumnen device_id. Alltså kunde vem som helst hämta
   hela flödet och se vilket id som rapporterat vad.

   Två saker går fel med det. Rösterna på en rapport avgörs per enhet, så
   den som ser andras id kan rösta ner med lånade id:n. Och även om id:t är
   slumpat följer det en person över tid — samlar man flödet i några veckor
   ser man var en viss enhet brukar befinna sig. Det är positionsdata om en
   enskild människa, och den ska inte ligga öppet.

   Lösningen är inte att döpa om kolumnen utan att ta bort rättigheten till
   den. Postgres kan ge läsrätt per kolumn, och det är precis vad vi vill:
   appen får läsa allt utom device_id, och vyn nedan är den väg den går.

   Varför inte bara en vy? För att tabellen ligger kvar bredvid vyn. Utan
   återkallad rättighet kan man hoppa förbi vyn och läsa tabellen direkt
   med samma nyckel. Vyn hade då varit en artighetsfras, inte ett skydd.

   Kör den här filen EFTER schema.sql och FÖRE grupper.sql.
   ===================================================================== */

/* ---------------------------- Vyn ----------------------------------- */
/*
 * security_invoker = on är viktigt och ska inte ändras.
 *
 * Med "on" gäller anroparens egna radregler när vyn läses. Det betyder att
 * den dag grupper finns — där en rapport kan tillhöra ett privat åkeri —
 * så följer vyn automatiskt med och visar bara de rader personen får se.
 *
 * Med "off" hade vyn körts som sin ägare och gått förbi radreglerna. Den
 * hade fungerat lika bra idag och tyst läckt varje privat grupprapport den
 * dagen grupper slås på. Det är den sortens fel som ingen upptäcker.
 */
create or replace view public.reports_feed
with (security_invoker = on) as
  select
    id,
    type,
    lat,
    lon,
    label,
    note,
    source,
    external_id,
    created_at,
    expires_at,
    confirms,
    denials,
    removed,
    inserted_at
  from public.reports;

/* ------------------------- Rättigheterna ---------------------------- */
/*
 * Först bort med läsrätten på hela tabellen, sedan tillbaka kolumn för
 * kolumn — alla utom device_id.
 *
 * Notera att INSERT inte rörs. Appen skriver fortfarande direkt till
 * reports, och den skrivningen måste få innehålla device_id: det är så en
 * rapport blir kopplad till den som skickade den, vilket i sin tur är det
 * som gör att du kan radera din egen. Att få skriva ett värde man inte får
 * läsa tillbaka är helt i sin ordning, och är precis vad vi vill här.
 */
revoke select on public.reports from anon, authenticated;

grant select (
  id, type, lat, lon, label, note, source, external_id,
  created_at, expires_at, confirms, denials, removed, inserted_at
) on public.reports to anon, authenticated;

grant select on public.reports_feed to anon, authenticated;

/* ------------------------------ Följder ------------------------------ */
/*
 * Efter det här slutar ett gammalt anrop mot /rest/v1/reports?select=*
 * att fungera, eftersom * omfattar device_id. Det är avsiktligt.
 *
 * Appen har redan en reservväg som föll tillbaka på tabellen när vyn
 * saknades. Den vägen tystnar nu istället för att läcka — men eftersom vyn
 * finns från och med den här körningen används den aldrig. Ordningen i
 * koden är vyn först, tabellen sedan.
 *
 * Kontrollera efteråt att det verkligen blev tätt:
 *
 *   select * from public.reports_feed limit 1;   -- ska fungera
 *   select device_id from public.reports limit 1; -- ska ge permission denied
 *                                                 -- när du kör som anon
 */


/* ###################################################################
   ### push.sql                                                   ###
   ################################################################### */

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


/* ###################################################################
   ### grupper.sql                                                ###
   ################################################################### */

-- Polisvakt — privata grupper
--
-- Körs EFTER supabase/schema.sql, i Supabase SQL Editor. Filen är skriven för
-- att kunna köras om hur många gånger som helst utan att förstöra data.
--
-- Vad det här löser: ett åkeri med femton bilar vill att förarna ser varandras
-- rapporter utan att de går ut till varenda främling i Västmanland — och vill
-- samtidigt ha kvar det publika flödet. En rapport får därför en frivillig
-- grupp, och en användare ser unionen av det publika flödet och varje grupp
-- hen är med i. Se docs/GRUPPER.md.
--
-- Om säkerhetsmodellen, som skiljer sig från resten av schemat på tre punkter:
--
--   1. GRUPPER KRÄVER KONTO. Resten av appen litar på ett slumpat device_id,
--      vilket räcker för en varningstjänst där allt ändå är publikt. Här går
--      det inte: ett enhets-id ligger i klartext i klienten och går att hitta
--      på. Kunde man äga en grupp med ett device_id kunde vem som helst påstå
--      sig vara ägaren och kasta ut åkeriets förare. Allt nedan går därför på
--      auth.uid(), aldrig på public.actor().
--
--   2. INGA RADSÄKERHETSREGLER PÅ GRUPPTABELLERNA — de är helt stängda, precis
--      som push_subscriptions. All åtkomst sker genom funktionerna längst ner.
--      Skälet är kravet att en utomstående inte ens ska kunna se ATT en grupp
--      finns eller hur många som är med i den. En läsregel, hur snäv den än är,
--      svarar alltid på frågan "finns raden?" med ett tomt eller icke-tomt
--      svar, och antalet rader läcker genom count. Är tabellen stängd finns
--      ingen sådan kanal alls.
--
--   3. MEDLEMSKAP SKAPAS ALDRIG AV KLIENTEN. join_group tar en inbjudningskod
--      och skriver raden själv. Fick klienten göra insert vore koden bara
--      dekoration — man hade kunnat lägga till sig i vilken grupp som helst
--      genom att gissa ett grupp-id.
--
-- Varken device_id eller e-post lämnar servern genom något av det här. Medlemmar
-- identifieras utåt med ett smeknamn och ett slumpat handtag (group_members.handle),
-- aldrig med sitt konto-id — som för inloggade är samma sträng som device_id i
-- rapportflödet.

/* ============================= TABELLER ============================== */

create table if not exists public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) between 2 and 60),

  -- Vad slags grupp det är. Styr ingenting tekniskt, men gör det möjligt att
  -- se vad funktionen faktiskt används till innan vi bygger vidare på den.
  kind         text not null default 'ovrigt'
               check (kind in ('akeri', 'trafikskola', 'vanner', 'ovrigt')),

  -- Ägaren är ett riktigt konto. on delete cascade: raderas kontot försvinner
  -- gruppen, medlemskapen och gruppens rapporter. Det är med flit — en grupp
  -- utan ägare går inte att administrera, och en föräldralös privat grupp som
  -- ligger kvar är sämre än ingen grupp alls.
  owner_id     uuid not null references auth.users(id) on delete cascade,

  -- Taket finns för att en läckt kod inte ska kunna dra in tusen personer.
  -- Femtio räcker för ett åkeri och en trafikskola med marginal.
  member_limit int not null default 50 check (member_limit between 2 and 500),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists groups_owner_idx on public.groups (owner_id);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,

  /**
   * Handtaget är medlemmens id utåt.
   *
   * Ägaren måste kunna peka ut vem som ska tas bort, men får inte se
   * user_id: för inloggade är det exakt samma sträng som device_id i
   * rapporttabellen, och den som har den kan koppla rapporter till person.
   * Handtaget är slumpat, betyder ingenting någon annanstans i systemet och
   * duger utmärkt som "den där raden".
   */
  handle    uuid not null default gen_random_uuid() unique,

  -- Visningsnamn i medlemslistan. Aldrig e-post — den finns i auth.users och
  -- ska stanna där.
  nickname  text not null default 'Medlem' check (length(nickname) <= 20),

  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- Uppslagning åt andra hållet: "vilka grupper är jag med i". Används av varje
-- läsning av rapportflödet via is_group_member, så den ska finnas.
create index if not exists group_members_user_idx on public.group_members (user_id);

-- Exakt en ägare per grupp. Utan det här kan transfer_group_ownership lämna
-- två ägarrader efter sig om något går fel mitt i.
create unique index if not exists group_one_owner_idx
  on public.group_members (group_id) where role = 'owner';

create table if not exists public.group_invites (
  code        text primary key,
  group_id    uuid not null references public.groups(id) on delete cascade,
  created_by  uuid not null,
  created_at  timestamptz not null default now(),

  -- Både utgångsdatum och användningstak är hårda och kollas i join_group.
  -- Klienten får se dem, men kontrollen sker aldrig där.
  expires_at  timestamptz not null,
  max_uses    int not null default 25 check (max_uses between 1 and 500),
  uses        int not null default 0,

  -- Sätts av rotate_group_invite. Vi raderar inte gamla koder direkt, så att
  -- en läckt kod syns i loggen om någon undrar hur folk kom in.
  revoked     boolean not null default false,
  last_used_at timestamptz
);

create index if not exists group_invites_group_idx on public.group_invites (group_id);

/**
 * Spärr mot kodgissning.
 *
 * En kod har 50 bitars entropi (tio tecken ur ett alfabet på 32), så att gissa
 * sig till en fungerande kod är inte ett realistiskt hot i sig. Spärren finns
 * för det som faktiskt går att göra: sitta och pröva tusentals koder i följd
 * för att kartlägga vilka som finns. Efter tio missar på en timme får kontot
 * vila en timme.
 */
create table if not exists public.group_join_attempts (
  actor         text primary key,          -- auth.uid()::text
  misses        smallint not null default 0,
  first_miss    timestamptz not null default now(),
  blocked_until timestamptz
);

alter table public.groups              enable row level security;
alter table public.group_members       enable row level security;
alter table public.group_invites       enable row level security;
alter table public.group_join_attempts enable row level security;

-- Radsäkerhet påslagen och HELT tom: ingen policy = ingen utom service_role
-- kommer in. Läs punkt 2 överst i filen innan du lägger till en.
--
-- Radsäkerheten är bältet, revoken nedan är hängslena. Att bara ta bort
-- rättigheten hade räckt, men en tom policy-lista är lätt att råka fylla i.
--
-- Notera att tabeller och vyer inte har samma fälla som funktioner: Postgres
-- ger INTE bort tabellrättigheter till PUBLIC som standard. Det som finns här
-- är Supabases egna standardrättigheter till anon och authenticated, och de
-- försvinner med en revoke riktad till just de rollerna. För funktioner gäller
-- något helt annat — se stycket "RÄTTIGHETER (VIKTIGT)" längst ner. Kopiera
-- alltså inte den här raden som mall för en funktion.
revoke all on public.groups              from anon, authenticated;
revoke all on public.group_members       from anon, authenticated;
revoke all on public.group_invites       from anon, authenticated;
revoke all on public.group_join_attempts from anon, authenticated;

/* ========================= HJÄLPFUNKTIONER ========================== */

/**
 * Är den som frågar med i gruppen?
 *
 * security definer, för att funktionen måste kunna läsa group_members trots
 * att tabellen är stängd. Den tar inget användar-id som argument utan går
 * alltid på auth.uid() — annars hade den blivit ett orakel som svarar på
 * "är person X med i grupp Y" för vem som helst som frågar.
 *
 * Anropas ur radsäkerhetsreglerna på reports och report_history, alltså en
 * gång per rad. Därför stable (planeraren får cacha svaret inom frågan) och
 * därför indexet group_members_user_idx.
 */
create or replace function public.is_group_member(p_group uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_group is not null
     and auth.uid() is not null
     and exists (
       select 1 from public.group_members m
       where m.group_id = p_group and m.user_id = auth.uid()
     );
$$;

/** Äger den som frågar gruppen? Samma resonemang som ovan. */
create or replace function public.is_group_owner(p_group uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_group is not null
     and auth.uid() is not null
     and exists (
       select 1 from public.groups g
       where g.id = p_group and g.owner_id = auth.uid()
     );
$$;

/**
 * Ny inbjudningskod, tio tecken.
 *
 * Alfabetet är Crockfords base32: siffror och versaler utan I, L, O och U.
 * Poängen är att koden ska gå att läsa upp i en telefon utan att någon skriver
 * ett ettställe där det ska stå ett I. U är borttaget i samma alfabet för att
 * slumpen inte ska stava något olämpligt.
 *
 * gen_random_bytes, inte random(). random() är en pseudoslumpgenerator som går
 * att förutsäga om man känner till tillståndet, och en förutsägbar
 * inbjudningskod är samma sak som ingen kod. 256 delat med 32 går jämnt ut,
 * så modulon snedvrider inte fördelningen.
 */
create or replace function public.new_invite_code()
returns text
language plpgsql volatile set search_path = public, extensions as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea := gen_random_bytes(10);
  v_out   text := '';
  i       int;
begin
  for i in 0..9 loop
    v_out := v_out || substr(alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_out;
end $$;

/**
 * Skapa en kod och se till att den är unik. Intern — anropas av create_group
 * och rotate_group_invite, aldrig av klienten.
 *
 * Fem försök innan vi ger upp: med 50 bitars entropi krockar två koder i
 * praktiken aldrig, men en oändlig loop i en databasfunktion är en sämre bugg
 * än ett felmeddelande.
 *
 * Ligger HÄR, bland hjälpfunktionerna, och inte nere hos klientfunktionerna
 * där den hörde hemma tematiskt. Skälet är krasst: create_group anropar den,
 * och en fil som definierar saker i den ordning de används går att köra rad
 * för rad i SQL-editorn när något ändå gick fel. Postgres kompilerar visserligen
 * inte plpgsql-kroppar förrän de körs första gången, så en framåtreferens går
 * igenom vid create — men då upptäcks felet av en förare som försöker skapa en
 * grupp istället för av den som körde filen.
 */
create or replace function public.mint_invite_code(
  p_group uuid, p_by uuid, p_days int, p_max_uses int)
returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; i int;
begin
  for i in 1..5 loop
    v_code := public.new_invite_code();
    begin
      insert into group_invites (code, group_id, created_by, expires_at, max_uses)
      values (v_code, p_group, p_by,
              now() + (greatest(1, least(coalesce(p_days, 14), 365)) || ' days')::interval,
              greatest(1, least(coalesce(p_max_uses, 25), 500)));
      return v_code;
    exception when unique_violation then
      null;   -- otroligt osannolikt, men prova en till
    end;
  end loop;
  raise exception 'Kunde inte skapa en unik inbjudningskod';
end $$;

/**
 * Städa en kod som någon skrivit för hand.
 *
 * Bindestreck och mellanslag bort, gemener upp, och de tecken alfabetet
 * saknar tolkas som det de uppenbart var tänkta att vara: O är en nolla, I och
 * L är ettor. Utan det här får den som skriver av koden från ett papper fel
 * varje gång, och vi hade lagt spärren för kodgissning på hederligt folk.
 */
create or replace function public.clean_invite_code(p_code text)
returns text
language sql immutable as $$
  select translate(
    regexp_replace(upper(coalesce(p_code, '')), '[^0-9A-Z]', '', 'g'),
    'OIL', '011'
  );
$$;

/** Smeknamn som får visas i medlemslistan. Tomt blir "Medlem". */
create or replace function public.clean_nickname(p_nickname text)
returns text
language sql immutable as $$
  select coalesce(nullif(left(btrim(coalesce(p_nickname, '')), 20), ''), 'Medlem');
$$;

/**
 * Räkna en miss mot spärren. Anropas bara inifrån join_group.
 *
 * Fönstret är rullande en timme: har första missen passerat börjar räkningen
 * om, så den som skriver fel en gång i månaden aldrig blir spärrad.
 */
create or replace function public.note_join_miss(p_actor text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_row group_join_attempts%rowtype;
begin
  select * into v_row from group_join_attempts where actor = p_actor for update;

  if not found then
    -- on conflict, inte ett rent insert: två parallella missar hamnar båda här
    -- och den andra hade fallit på primärnyckeln. Ett undantag i den här
    -- funktionen bubblar upp genom join_group och river hela transaktionen —
    -- alltså skulle gissning nummer två avbrytas med ett Postgres-fel istället
    -- för att räknas. Spärren hade blivit lättast att kringgå genom att
    -- gissa snabbt, vilket är precis vad den ska stoppa.
    insert into group_join_attempts (actor, misses) values (p_actor, 1)
    on conflict (actor) do update set misses = group_join_attempts.misses + 1;
    return;
  end if;

  if v_row.first_miss < now() - interval '1 hour' then
    update group_join_attempts
       set misses = 1, first_miss = now(), blocked_until = null
     where actor = p_actor;
    return;
  end if;

  if v_row.misses + 1 >= 10 then
    update group_join_attempts
       set misses = 0, first_miss = now(), blocked_until = now() + interval '1 hour'
     where actor = p_actor;
  else
    update group_join_attempts set misses = misses + 1 where actor = p_actor;
  end if;
end $$;

/* ====================== RAPPORTER I EN GRUPP ======================== */

-- Frivillig grupp på rapporten. null = publik, som allt som fanns innan.
alter table public.reports
  add column if not exists group_id uuid references public.groups(id) on delete cascade;

-- on delete cascade och inte set null, med flit: raderas gruppen ska dess
-- rapporter försvinna, inte plötsligt bli publika. En rapport som byter från
-- privat till synlig-för-alla utan att någon bett om det är precis det den här
-- funktionen finns för att förhindra.

create index if not exists reports_group_idx
  on public.reports (group_id) where group_id is not null;

/**
 * Läsregeln, som är hela poängen med filen.
 *
 * Ersätter reports_read i schema.sql, som släppte igenom allt. Publika
 * rapporter fungerar exakt som förut; gruppens rapporter syns bara för den som
 * är med. Att unionen "publikt + mina grupper" blir rätt behöver klienten inte
 * göra något för — den frågar som vanligt och får tillbaka det den får se.
 */
drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports
  for select to anon, authenticated
  using (group_id is null or public.is_group_member(group_id));

/**
 * Skrivregeln. Samma villkor som i schema.sql plus ett: du kan bara lägga en
 * rapport i en grupp du själv är med i. Utan det hade vem som helst kunnat
 * skjuta in rapporter i åkeriets flöde genom att gissa ett grupp-id.
 */
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to anon, authenticated
  with check (
    lat between 55 and 70 and lon between 10 and 25
    and expires_at > created_at
    -- Notera bigint-casten. Utan den räknar Postgres 1000*60*60*24*400 som
    -- 32-bitars heltal, får overflow vid 2,1 miljarder, och avvisar varje
    -- skrivning med "integer out of range" — trots att raden är helt korrekt.
    and expires_at < created_at + (400::bigint * 24 * 60 * 60 * 1000)
    and confirms <= 1 and denials = 0
    and removed = false
    and length(coalesce(label, '')) <= 120
    and length(coalesce(note, '')) <= 500
    and (group_id is null or public.is_group_member(group_id))
  );

/**
 * Vyer läser förbi radsäkerheten om de inte sägs göra något annat.
 *
 * En vy körs som standard med sin ägares rättigheter (security_invoker = off),
 * och ägaren är postgres. reports_active hade alltså fortsatt lämna ut
 * gruppens rapporter till anon trots regeln ovan — hela skyddet hade läckt ut
 * genom en vy ingen tänkte på. Samma sak gäller reports_feed, som js/store.js
 * läser i första hand.
 *
 * VIKTIGT för den som lägger till en ny vy över reports: sätt
 * security_invoker = on, annars är den privata gruppen publik igen.
 */
alter view if exists public.reports_active set (security_invoker = on);
alter view if exists public.reports_feed   set (security_invoker = on);

/**
 * monthly_winners är den tredje vyn över reports, och den går inte att rädda
 * med security_invoker.
 *
 * Vyn i schema.sql grupperar rapporter per device_id för att räkna fram vilka
 * tio som får nästa månad gratis. Två saker med den:
 *
 *   - Den lämnar ut device_id, som för inloggade är samma sträng som konto-id.
 *     Supabase delar automatiskt ut SELECT på nya vyer till anon, och ingen
 *     revoke följde i schema.sql. Den läckan fanns redan innan grupper.
 *   - Med grupper blir den dessutom ett orakel: lägger en förare en rapport i
 *     åkeriets grupp ändras raden i en vy som vem som helst kan läsa.
 *
 * Fixen är inte security_invoker — vyn ska räkna på ALLA rapporter för att
 * belöningen ska bli rätt, och med invoker på hade den bara sett anropandes
 * egna. Den ska istället inte gå att läsa från appen alls. Den är ett
 * administrationsverktyg och körs i SQL-editorn, där man är postgres.
 *
 * Kolumnen device_id ligger kvar med flit: den behövs för att kunna dela ut
 * koden till rätt person. Se docs/GRUPPER.md.
 */
revoke all on public.monthly_winners from anon, authenticated;

/**
 * Historiken får också veta vilken grupp raden kom från.
 *
 * Det här är lätt att missa: triggern reports_archive i schema.sql kopierar
 * varje ny rapport till report_history, och den tabellen har en läsregel med
 * "using (true)". Utan kolumnen nedan hade åkeriets privata positioner hamnat
 * i den publika historiken inom en sekund, med rätt tid och plats — och
 * mönsterkartan hade läckt exakt det rapportflödet skyddar.
 *
 * Ingen främmande nyckel till groups: historiken ska överleva att en grupp tas
 * bort. Raden blir då osynlig för alla, vilket är rätt håll att fela åt.
 */
alter table public.report_history add column if not exists group_id uuid;

create index if not exists history_group_idx
  on public.report_history (group_id) where group_id is not null;

-- Utökad kopia av archive_report i schema.sql. Kör den här filen sist, annars
-- skrivs den över av originalet och historiken börjar läcka igen.
create or replace function public.archive_report()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into report_history (type, lat, lon, label, created_at, group_id)
  values (new.type, new.lat, new.lon, nullif(new.label, ''), new.created_at, new.group_id);
  return new;
end $$;

drop policy if exists history_read on public.report_history;
create policy history_read on public.report_history
  for select to anon, authenticated
  using (group_id is null or public.is_group_member(group_id));

/**
 * Röstning på en rapport man inte får se.
 *
 * confirm_report och deny_report är security definer och går därför förbi
 * radsäkerheten. Den som gissar ett rapport-id kan alltså rösta ner en rapport
 * i en grupp hen inte är med i. Ingen data läcker, men gruppens flöde ska inte
 * gå att störa utifrån. Istället för att skriva om funktionerna i schema.sql
 * — som andra också redigerar — sitter kontrollen på tabellen som varenda röst
 * måste passera.
 */
create or replace function public.guard_group_vote()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_group uuid;
begin
  select group_id into v_group from reports where id = new.report_id;
  if v_group is not null and not public.is_group_member(v_group) then
    raise exception 'Rapporten tillhör en grupp du inte är med i';
  end if;
  return new;
end $$;

drop trigger if exists votes_group_guard on public.report_votes;
create trigger votes_group_guard before insert or update on public.report_votes
  for each row execute function public.guard_group_vote();

/* ==================== FUNKTIONER FÖR KLIENTEN ======================= */
-- Alla returnerar en statuskod på svenska, aldrig ett kastat undantag, av
-- samma skäl som claim_username i schema.sql: klienten ska kunna visa ett
-- begripligt meddelande utan att tolka Postgres felsträngar. js/groups.js har
-- översättningarna.

/**
 * Skapa en grupp. Den som skapar blir ägare och första medlem, och får
 * tillbaka en färdig inbjudningskod att dela ut.
 */
create or replace function public.create_group(
  p_name text, p_kind text default 'ovrigt', p_nickname text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := btrim(coalesce(p_name, ''));
  v_kind  text := lower(coalesce(nullif(btrim(p_kind), ''), 'ovrigt'));
  v_id    uuid;
  v_code  text;
begin
  if v_uid is null then return jsonb_build_object('status', 'inte_inloggad'); end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    return jsonb_build_object('status', 'ogiltigt_namn');
  end if;
  if v_kind not in ('akeri', 'trafikskola', 'vanner', 'ovrigt') then v_kind := 'ovrigt'; end if;

  -- Tak på antal egna grupper. En grupp kostar oss ingenting att lagra, men en
  -- bot som skapar tiotusen gör tabellen oanvändbar.
  if (select count(*) from groups where owner_id = v_uid) >= 10 then
    return jsonb_build_object('status', 'for_manga_grupper');
  end if;

  insert into groups (name, kind, owner_id) values (v_name, v_kind, v_uid)
  returning id into v_id;

  insert into group_members (group_id, user_id, nickname, role)
  values (v_id, v_uid, public.clean_nickname(p_nickname), 'owner');

  v_code := public.mint_invite_code(v_id, v_uid, 14, 25);

  return jsonb_build_object(
    'status', 'ok',
    'grupp', jsonb_build_object('id', v_id, 'namn', v_name, 'typ', v_kind,
                                'roll', 'owner', 'medlemmar', 1),
    'kod', v_code
  );
end $$;

/**
 * Gå med i en grupp med en kod.
 *
 * Enda vägen in. Utgångsdatum, användningstak, medlemstak och spärren mot
 * kodgissning kontrolleras här och ingen annanstans — allt som står i
 * klienten är hjälptext, inte skydd.
 */
create or replace function public.join_group(p_code text, p_nickname text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_code    text := public.clean_invite_code(p_code);
  v_inv     group_invites%rowtype;
  v_group   groups%rowtype;
  v_blocked timestamptz;
  v_count   int;
begin
  if v_uid is null then return jsonb_build_object('status', 'inte_inloggad'); end if;

  select blocked_until into v_blocked from group_join_attempts where actor = v_uid::text;
  if v_blocked is not null and v_blocked > now() then
    return jsonb_build_object(
      'status', 'for_manga_forsok',
      'vanta_sekunder', ceil(extract(epoch from (v_blocked - now())))::int);
  end if;

  if length(v_code) <> 10 then
    perform public.note_join_miss(v_uid::text);
    return jsonb_build_object('status', 'ogiltig');
  end if;

  -- for update: två förare som klistrar in sista platsens kod samtidigt ska
  -- inte båda komma in förbi taket.
  select * into v_inv from group_invites where code = v_code for update;

  -- Okänd och återkallad kod ger samma svar. Att skilja dem åt hade berättat
  -- för den som testar en gammal läckt kod att gruppen finns kvar.
  if not found or v_inv.revoked then
    perform public.note_join_miss(v_uid::text);
    return jsonb_build_object('status', 'ogiltig');
  end if;

  select * into v_group from groups where id = v_inv.group_id;
  if not found then return jsonb_build_object('status', 'ogiltig'); end if;

  -- Redan medlem: svara ok utan att bränna en användning. Annars äter en förare
  -- som trycker på länken två gånger upp koden för någon annan.
  if exists (select 1 from group_members where group_id = v_group.id and user_id = v_uid) then
    select count(*) into v_count from group_members where group_id = v_group.id;
    return jsonb_build_object(
      'status', 'ok', 'redan_medlem', true,
      'grupp', jsonb_build_object('id', v_group.id, 'namn', v_group.name,
                                  'typ', v_group.kind, 'medlemmar', v_count));
  end if;

  if v_inv.expires_at <= now() then return jsonb_build_object('status', 'utgangen'); end if;
  if v_inv.uses >= v_inv.max_uses then return jsonb_build_object('status', 'slut'); end if;

  select count(*) into v_count from group_members where group_id = v_group.id;
  if v_count >= v_group.member_limit then return jsonb_build_object('status', 'full'); end if;

  if (select count(*) from group_members where user_id = v_uid) >= 25 then
    return jsonb_build_object('status', 'for_manga_medlemskap');
  end if;

  insert into group_members (group_id, user_id, nickname)
  values (v_group.id, v_uid, public.clean_nickname(p_nickname));

  update group_invites set uses = uses + 1, last_used_at = now() where code = v_code;
  delete from group_join_attempts where actor = v_uid::text;

  return jsonb_build_object(
    'status', 'ok',
    'grupp', jsonb_build_object('id', v_group.id, 'namn', v_group.name,
                                'typ', v_group.kind, 'medlemmar', v_count + 1));
end $$;

/**
 * Mina grupper. Returnerar bara det gränssnittet behöver — inga ägar-id, inga
 * koder. Koden hämtas separat av ägaren via group_invite.
 */
create or replace function public.my_groups()
returns table (
  id uuid, namn text, typ text, roll text, medlemmar int,
  gick_med timestamptz, skapad timestamptz)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.kind, m.role,
         (select count(*) from public.group_members x where x.group_id = g.id)::int,
         m.joined_at, g.created_at
  from public.group_members m
  join public.groups g on g.id = m.group_id
  where auth.uid() is not null and m.user_id = auth.uid()
  order by g.created_at;
$$;

/**
 * Medlemmarna i en grupp. Bara för medlemmar, och aldrig med user_id eller
 * e-post — se kommentaren om handtaget vid tabellen.
 */
create or replace function public.group_members_list(p_group uuid)
returns table (handtag uuid, namn text, roll text, gick_med timestamptz, jag boolean)
language sql stable security definer set search_path = public as $$
  select m.handle, m.nickname, m.role, m.joined_at, (m.user_id = auth.uid())
  from public.group_members m
  where public.is_group_member(p_group) and m.group_id = p_group
  order by (m.role = 'owner') desc, m.joined_at;
$$;

/** Gruppens aktuella kod. Bara ägaren — en medlem ska inte kunna bjuda in. */
create or replace function public.group_invite(p_group uuid)
returns table (kod text, giltig_till timestamptz, anvant int, max_anvandningar int)
language sql stable security definer set search_path = public as $$
  select i.code, i.expires_at, i.uses, i.max_uses
  from public.group_invites i
  where public.is_group_owner(p_group)
    and i.group_id = p_group
    and not i.revoked
    and i.expires_at > now()
  order by i.created_at desc
  limit 1;
$$;

/**
 * Byt kod.
 *
 * Det här är återställningen efter en läcka: alla gamla koder återkallas i
 * samma svep, så den som har den läckta koden i ett skärmklipp inte kommer in
 * igen. Redan invandrade medlemmar sitter kvar — koden är dörren, inte
 * medlemskapet — så kombinera med att kasta ut dem som inte hör hemma.
 */
create or replace function public.rotate_group_invite(
  p_group uuid, p_days int default 14, p_max_uses int default 25)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_code text;
begin
  if v_uid is null then return jsonb_build_object('status', 'inte_inloggad'); end if;
  if not public.is_group_owner(p_group) then return jsonb_build_object('status', 'inte_agare'); end if;

  update group_invites set revoked = true where group_id = p_group and not revoked;

  v_code := public.mint_invite_code(p_group, v_uid, p_days, p_max_uses);

  return jsonb_build_object(
    'status', 'ok', 'kod', v_code,
    'giltig_till', (select expires_at from group_invites where code = v_code),
    'max_anvandningar', (select max_uses from group_invites where code = v_code));
end $$;

/** Byt namn på gruppen. Bara ägaren. */
create or replace function public.rename_group(p_group uuid, p_name text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then return 'inte_inloggad'; end if;
  if not public.is_group_owner(p_group) then return 'inte_agare'; end if;
  if length(v_name) < 2 or length(v_name) > 60 then return 'ogiltigt_namn'; end if;

  update groups set name = v_name, updated_at = now() where id = p_group;
  return 'ok';
end $$;

/**
 * Kasta ut en medlem. Bara ägaren, och aldrig sig själv.
 *
 * Ägaren pekas ut med handtaget, inte med konto-id — klienten har aldrig sett
 * ett konto-id och ska inte behöva göra det.
 */
create or replace function public.remove_group_member(p_handle uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_row group_members%rowtype;
begin
  if auth.uid() is null then return 'inte_inloggad'; end if;

  select * into v_row from group_members where handle = p_handle;
  -- Finns handtaget inte, eller äger du inte gruppen det hör till, får du
  -- samma svar. Annars går handtag att sondera efter.
  if not found or not public.is_group_owner(v_row.group_id) then return 'inte_agare'; end if;
  if v_row.role = 'owner' then return 'agare'; end if;

  delete from group_members where handle = p_handle;
  return 'ok';
end $$;

/**
 * Lämna över ägarskapet. Vägen ut för en ägare som vill lämna en grupp som
 * lever vidare — utan den här skulle kravet "ägaren får inte lämna medan andra
 * är kvar" låsa in ägaren för alltid.
 */
create or replace function public.transfer_group_ownership(p_handle uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_row group_members%rowtype; v_me uuid := auth.uid();
begin
  if v_me is null then return 'inte_inloggad'; end if;

  select * into v_row from group_members where handle = p_handle;
  if not found or not public.is_group_owner(v_row.group_id) then return 'inte_agare'; end if;
  if v_row.user_id = v_me then return 'ok'; end if;

  -- Ordningen spelar roll: det partiella unika indexet tillåter bara en
  -- ägarrad per grupp, så den gamla måste ner först.
  update group_members set role = 'member'
   where group_id = v_row.group_id and user_id = v_me;
  update group_members set role = 'owner' where handle = p_handle;
  update groups set owner_id = v_row.user_id, updated_at = now() where id = v_row.group_id;

  return 'ok';
end $$;

/**
 * Lämna en grupp.
 *
 * Rapporterna man lagt i gruppen stannar kvar. De tillhör gruppen, inte
 * personen, och en förare som slutar ska inte ta med sig varningarna ut ur
 * bilarna som fortfarande kör. Läsrätten försvinner däremot i samma sekund:
 * nästa hämtning ger bara det publika flödet.
 *
 * Ägaren kan bara gå om hen är ensam kvar — och då tas gruppen bort, för en
 * tom grupp med en levande inbjudningskod är bara en läcka som väntar.
 */
create or replace function public.leave_group(p_group uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_role text; v_count int;
begin
  if v_uid is null then return 'inte_inloggad'; end if;

  select role into v_role from group_members where group_id = p_group and user_id = v_uid;
  if v_role is null then return 'inte_medlem'; end if;

  select count(*) into v_count from group_members where group_id = p_group;

  if v_role = 'owner' then
    if v_count > 1 then return 'agare_kvar'; end if;
    delete from groups where id = p_group;      -- kaskad tar medlemmar, koder, rapporter
    return 'ok_borttagen';
  end if;

  delete from group_members where group_id = p_group and user_id = v_uid;
  return 'ok';
end $$;

/**
 * Ta bort gruppen helt. Bara ägaren.
 *
 * Kaskaden tar medlemskap, koder och gruppens rapporter. Historikraderna finns
 * kvar men blir osynliga för alla, eftersom ingen längre är medlem i den grupp
 * de pekar på.
 */
create or replace function public.delete_group(p_group uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return 'inte_inloggad'; end if;
  if not public.is_group_owner(p_group) then return 'inte_agare'; end if;

  delete from groups where id = p_group;
  return 'ok';
end $$;

/* ====================== RÄTTIGHETER (VIKTIGT) ======================= */
/**
 * Läs det här stycket innan du rör något härunder.
 *
 * Postgres delar ut EXECUTE på varje ny funktion till rollen PUBLIC. PUBLIC är
 * inte en roll man är medlem i utan "alla, alltid", och en rättighet som ligger
 * där gäller även den som uttryckligen fått den fråntagen. Att skriva
 *
 *     revoke execute on function public.create_group(...) from anon;
 *
 * gör därför ingenting alls i praktiken: den plockar bort Supabases egna
 * standardrättighet till anon, men anon kör vidare på PUBLIC-grantet och kan
 * fortfarande anropa funktionen. Det såg rätt ut, det gav inget felmeddelande,
 * och skyddet fanns inte.
 *
 * Den enda formen som stänger en funktion är att först ta bort PUBLIC:
 *
 *     revoke all on function public.create_group(...) from public;
 *
 * och sedan dela ut till exakt de roller som ska in. Ordningen spelar roll —
 * revoke först, grant sedan — annars nollas grantet av revoken.
 *
 * Filen gör det i två svep nedan: allt stängs, sedan öppnas det som ska vara
 * öppet. Lägger du till en funktion i den här filen ska den in i BÅDA listorna,
 * annars ligger den öppen för anon utan att någon märker det.
 */

-- 1. Stäng allt. Signaturen måste skrivas ut i sin helhet; utan den vet
--    Postgres inte vilken överlagring som avses.
revoke all on function public.is_group_member(uuid)                   from public, anon, authenticated;
revoke all on function public.is_group_owner(uuid)                    from public, anon, authenticated;
revoke all on function public.new_invite_code()                       from public, anon, authenticated;
revoke all on function public.mint_invite_code(uuid, uuid, int, int)  from public, anon, authenticated;
revoke all on function public.clean_invite_code(text)                 from public, anon, authenticated;
revoke all on function public.clean_nickname(text)                    from public, anon, authenticated;
revoke all on function public.note_join_miss(text)                    from public, anon, authenticated;
revoke all on function public.archive_report()                        from public, anon, authenticated;
revoke all on function public.guard_group_vote()                      from public, anon, authenticated;
revoke all on function public.create_group(text, text, text)          from public, anon, authenticated;
revoke all on function public.join_group(text, text)                  from public, anon, authenticated;
revoke all on function public.my_groups()                             from public, anon, authenticated;
revoke all on function public.group_members_list(uuid)                from public, anon, authenticated;
revoke all on function public.group_invite(uuid)                      from public, anon, authenticated;
revoke all on function public.rotate_group_invite(uuid, int, int)     from public, anon, authenticated;
revoke all on function public.rename_group(uuid, text)                from public, anon, authenticated;
revoke all on function public.remove_group_member(uuid)               from public, anon, authenticated;
revoke all on function public.transfer_group_ownership(uuid)          from public, anon, authenticated;
revoke all on function public.leave_group(uuid)                       from public, anon, authenticated;
revoke all on function public.delete_group(uuid)                      from public, anon, authenticated;

-- 2. Öppna det som ska vara öppet.
--
-- De interna funktionerna får INGET grant och står därför inte med här:
-- new_invite_code, mint_invite_code (skapar en giltig kod till vilken grupp som
-- helst utan att fråga vem som ringer), clean_nickname, note_join_miss (kunde
-- annars användas för att spärra andras konton) samt de två utlösarna
-- archive_report och guard_group_vote.
--
-- Att de blir oanropbara utifrån stör inte funktionerna som använder dem: en
-- SECURITY DEFINER-funktion körs som sin ägare, och ägaren är postgres, som
-- äger även hjälpfunktionerna. Rättighetskontrollen sker mot den som kör i
-- stunden, inte mot den som loggade in.

-- is_group_member och is_group_owner utvärderas inne i radsäkerhetsreglerna på
-- reports och report_history, och de reglerna körs som den som frågar. Även en
-- utloggad läsare måste alltså få EXECUTE — funktionen svarar false när
-- auth.uid() är tom, men utan grant blir det "permission denied" och hela det
-- publika flödet slutar fungera för utloggade.
grant execute on function public.is_group_member(uuid)  to anon, authenticated;
grant execute on function public.is_group_owner(uuid)   to anon, authenticated;

-- Ren strängstädning utan databasåtkomst. Klienten normaliserar redan koden
-- själv; den här finns så att servern och appen garanterat gör likadant.
grant execute on function public.clean_invite_code(text) to authenticated;

-- Resten kräver konto. Grupper går inte att äga med ett device_id — se punkt 1
-- överst i filen.
grant execute on function public.create_group(text, text, text)          to authenticated;
grant execute on function public.join_group(text, text)                  to authenticated;
grant execute on function public.my_groups()                             to authenticated;
grant execute on function public.group_members_list(uuid)                to authenticated;
grant execute on function public.group_invite(uuid)                      to authenticated;
grant execute on function public.rotate_group_invite(uuid, int, int)     to authenticated;
grant execute on function public.rename_group(uuid, text)                to authenticated;
grant execute on function public.remove_group_member(uuid)               to authenticated;
grant execute on function public.transfer_group_ownership(uuid)          to authenticated;
grant execute on function public.leave_group(uuid)                       to authenticated;
grant execute on function public.delete_group(uuid)                      to authenticated;

/* =========================== STÄDNING =============================== */

/**
 * Rensa koder som ändå inte fungerar längre.
 *
 * Utgångna och förbrukade koder ligger kvar en månad så att en ägare som
 * undrar "hur kom den här personen in" kan se att koden användes. Efter det är
 * de bara skräp — och en läckt kod som ligger kvar i en tabell är en läckt kod
 * som kan komma tillbaka om någon råkar sätta revoked = false.
 */
create or replace function public.purge_dead_invites()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from group_invites
   where created_at < now() - interval '30 days'
     and (revoked or expires_at < now() or uses >= max_uses);
  get diagnostics n = row_count;

  delete from group_join_attempts
   where first_miss < now() - interval '7 days'
     and (blocked_until is null or blocked_until < now());

  return n;
end $$;

revoke execute on function public.purge_dead_invites() from public, anon, authenticated;
grant execute on function public.purge_dead_invites() to service_role;

-- select cron.schedule('purge-invites', '15 4 * * *', 'select public.purge_dead_invites()');

/* ========================== VY FÖR ADMIN ============================ */
/**
 * Hur används grupperna? Kör i SQL-editorn.
 *
 * security_invoker = on, så att vyn stoppas av den tomma radsäkerheten på
 * tabellerna under. Supabase delar automatiskt ut SELECT på nya vyer till
 * anon, och en vy med invoker av hade läst förbi radsäkerheten — och därmed
 * lämnat ut precis den grupplista som resten av filen finns för att dölja.
 */
create or replace view public.group_health
with (security_invoker = on) as
  select
    count(*)                                                     as grupper,
    count(*) filter (where kind = 'akeri')                       as akerier,
    count(*) filter (where kind = 'trafikskola')                 as trafikskolor,
    (select count(*) from public.group_members)                  as medlemskap,
    (select count(*) from public.group_invites
      where not revoked and expires_at > now())                  as levande_koder,
    (select count(*) from public.reports where group_id is not null) as grupprapporter
  from public.groups;

revoke all on public.group_health from anon, authenticated;


commit;
