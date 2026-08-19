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
