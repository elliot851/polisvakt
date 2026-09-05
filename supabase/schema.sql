-- Polisvakt — Supabase-schema
--
-- Kör hela filen i Supabase SQL Editor. Efteråt: kopiera projektets URL och
-- anon-nyckeln till appens inställningar (Delning -> Delat med alla).
--
-- !! VARNING — KÖR INTE OM DEN HÄR FILEN FRISTÅENDE EFTER KOR-ALLT.sql !!
-- grupper.sql (via KOR-ALLT) sätter security_invoker=on på vyn reports_active,
-- byter reports_read till gruppscopad policy och ger archive_report group_id.
-- CREATE OR REPLACE VIEW nollställer reloptions och policyn/funktionen här är
-- de gamla — en omkörning av bara den här filen läcker TYST device_id till
-- anon igen (då kan vem som helst radera/rösta i andras namn via remove_report)
-- och gör privata gruppers rapporter publika. Ändra här → kör KOR-ALLT.sql.
-- (Granskningsfynd 2026-09-05, före lansering.)
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

-- security_invoker: vyn läser med ANROPARENS rättigheter, så kolumnspärren på
-- reports.device_id (dolj-enhets-id.sql) gäller även här. Utan den läckte
-- device_id till anon via select * — och med ett device_id kan vem som helst
-- radera/rösta i andras namn via remove_report/confirm_report. Ligger även i
-- grupper.sql; upprepas här eftersom CREATE OR REPLACE VIEW nollställer
-- reloptions och en omkörning av bara den här filen annars öppnade hålet igen.
alter view public.reports_active set (security_invoker = on);

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
  with check (
    paid_until is null and email is null and stripe_id is null
    -- Ingen får skapa en rad åt någon ANNAN inloggad, och ingen får ljuga om
    -- starten bakåt: förr kunde vem som helst förskapa ett gäst-id:s rad med
    -- trial_start = 1970 så provperioden såg utgången ut — och utan
    -- UPDATE-policy kunde offret aldrig rätta den. Framåt-satt tid är
    -- ofarlig (klienten tar minsta värdet), fem minuters klockslack räcker.
    and trial_start <= now() + interval '5 minutes'
    and (auth.uid() is null or device_id = auth.uid()::text)
  );

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

-- Definer-vy som exponerar device_id + smeknamn för varje rapportör. Supabase
-- auto-grantar SELECT till anon på nya vyer, så utan revoken kunde vilken
-- klient som helst läsa hela listan (grupper.sql/KOR-ALLT stänger den i
-- drift; upprepas här så en omkörning av bara den här filen inte öppnar den).
-- Topplistan läses via publish_score/reporter_scores, inte via den här vyn.
revoke all on public.monthly_winners from anon, authenticated;

-- select * from monthly_winners limit 10;   (som postgres/service_role)

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
