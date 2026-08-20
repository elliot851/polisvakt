-- =====================================================================
-- MEJLBRYGGAN — Facebooks egna notismejl, serversidan
-- =====================================================================
--
-- Kör hela filen i Supabase SQL Editor. Den är idempotent och går att köra
-- om hur många gånger som helst; ingenting här raderar rapporter.
--
-- Beroenden, i ordning:
--   supabase/schema.sql          reports, RLS, purge_old_reports
--   supabase/kvalitetsfalt.sql   kvalitetskolumnerna på reports
--   supabase/telegram.sql        VALFRI. Finns den används telegram_lasta
--                                för korsvis avdubbling, se nedan.
--
-- ---------------------------------------------------------------------
-- Varför den här filen finns
--
-- Facebook-gruppen "Här står polisen" går inte att läsa maskinellt — Meta
-- stängde Groups API för inläggsläsning 2024. Telegram-spegeln löser det men
-- kräver att en gruppadmin vill spegla inläggen, alltså att en annan människa
-- orkar göra något varje dag för alltid.
--
-- Den här vägen kräver ingen annan människa. Facebook skickar själv ett mejl
-- när det kommer ett nytt inlägg i en grupp man följer. Mejlet går till
-- ägarens egen postlåda, om notiser ägaren själv har slagit på. Ingen
-- inloggning kringgås, ingenting skrapas, ingen tredje part behöver vilja
-- något. Se docs/fbmejl.md.
--
-- ---------------------------------------------------------------------
-- Modellen, kort
--
--   fbmejl_ko          RÅA mejl som pollaren hittat. Kön in.
--   fbmejl_lasta       vilka mejl som är avgjorda. Avdubbling.
--   fbmejl_brygga      var IMAP-pollningen står (UIDVALIDITY + UID) och hur den mår.
--   fbmejl_ko_in()     pollaren lägger råa mejl här. Idempotent på Message-ID.
--   fbmejl_ko_hamta()  tolkaren hämtar det som inte är avgjort.
--   fbmejl_ta_emot()   tar emot färdigtolkade rader och skapar rapporter.
--   fbmejl_notis_ut()  EN push per omgång, med spärrar. Se avsnittet TAKTEN.
--   fbmejl_senaste     revisionsvy: vad kom in senaste dygnet.
--   fbmejl_halsa       revisionsvy: går bryggan alls, och håller den måttet.
--
-- Varför kön finns, i två steg istället för ett:
--
-- Tolkningen ligger i js/fbmejl.js, som anropar samma js/parser.js som rösten
-- och knapparna. Pollaren är PowerShell och kan inte köra JavaScript — det
-- finns ingen Node på maskinen. Att skriva om parsern i plpgsql eller i
-- PowerShell hade gett en andra ordlista, och en av dem är nykterhetsfiltret.
-- Det får aldrig hända.
--
-- Alltså: pollaren lägger RÅTEXT i kön inom sekunder, och något som kan köra
-- JavaScript (en edge-funktion, se docs/fbmejl.md) tömmer kön och anropar
-- fbmejl_ta_emot(). Kön är också en försäkring: går tolkaren ner ligger
-- mejlen kvar och kan köras om, istället för att gå förlorade.
--
-- Baksidan, sagd rakt ut: tolkaren MÅSTE finnas. En kö som ingen tömmer ger
-- noll varningar och ser i övrigt helt frisk ut. Vyn fbmejl_halsa längst ner
-- finns just för att den frågan ska gå att ställa.
--
-- ---------------------------------------------------------------------
-- OBS för den som redigerar filen: skriv ALDRIG ett cron-uttryck inuti en
-- blockkommentar. En stjärna följd av snedstreck avslutar kommentaren mitt i
-- raden, och resten tolkas som SQL. Hela filen dör då på "syntax error at or
-- near 5". Därför är hela den här filen skriven med radkommentarer.
-- =====================================================================

-- ============================ FÖRUTSÄTTNINGAR ========================
-- Kvalitetskolumnerna måste finnas innan funktionen nedan skrivs, annars
-- misslyckas varje insert vid körning istället för här och nu.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'reports'
      and column_name = 'parser_confidence'
  ) then
    raise exception 'Kör supabase/kvalitetsfalt.sql först — kvalitetskolumnerna på reports saknas.';
  end if;
end $$;

begin;

-- ============================ SISTA NÄTET ============================
--
-- Nykterhets- och drogkontroller blir aldrig rapporter. Det är produktregel
-- nummer ett i appen, och den avgörs i js/parser.js — det är den enda
-- ordlista som räknas, och den gäller rösten, knapparna, Telegram-spegeln och
-- mejlnotiserna lika.
--
-- Funktionen nedan är inte en andra parser. Den är ett grovt nät under den
-- riktiga, för databasen är det sista stället där en rapport kan stoppas och
-- tolkningen sker på en maskin någon annanstans. Nätet är MEDVETET för brett:
-- "alkohol" räcker, utan att kräva ordet "kontroll" efter. Ett bortsorterat
-- inlägg om alkohol kostar ingenting. Ett släppt kostar hela produktregeln.
--
-- Regeln är enkelriktad: den kan bara avvisa mer än parsern, aldrig släppa
-- igenom något parsern stoppat. Släpper man till här slutar den vara ett
-- skydd och blir en andra sanning.
--
-- Uttrycket är ordagrant detsamma som telegram_ar_nykterhetskontroll() i
-- supabase/telegram.sql. Att det står två gånger är avsiktligt: filerna ska
-- gå att köra oberoende av varandra, och ett nät som bara kan säga NEJ kan
-- inte bli farligt av att finnas i två exemplar. Ändras det ena, ändra det
-- andra — kontroll 1 längst ner i filen körs på båda och säger ifrån.

create or replace function public.fbmejl_ar_nykterhetskontroll(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  -- Narkotikaorden saknades, och bindestreck bröt de delade formerna.
  -- En granskning körde riktiga meningar genom kedjan: fem av nio
  -- drogkontroller blev polisrapporter på kartan, och "drog-kontroll" gick
  -- igenom både det här nätet och parserns spärr samtidigt eftersom bara
  -- blanksteg var valfritt. Håll den här synkad med SOBRIETY_WORDS och
  -- SOBRIETY_STAMMAR i js/parser.js.
  --
  -- Bara "drog" utan efterled saknas med flit: det är också imperfekt av
  -- "dra", och "polisen drog vidare" är en avblåsning, inte en kontroll.
  select lower(coalesce(p_text, '')) ~
    '(nykter|alkohol|alkotest|promille|rattfyll|utandnings|sållnings|sallnings|narkotika|narko|droger|drogsök|drogsok|drogkontroll|drogtest|drog[ -]?kontroll|drog[ -]?test|drog[ -]?koll|blåser|blåsa|blåste|blaser|blåsning)';
$$;

-- ============================ INTEGRITET =============================
--
-- Facebooks notislänkar bär två saker som aldrig får lagras:
--
--   n_m=       MOTTAGARENS e-postadress i klartext, procentkodad. Utan
--              skrubbning hamnar den i fbmejl_ko.brodtext och därmed i varje
--              backup av databasen.
--   notif_id=  ger LÄSÅTKOMST till notisens innehåll. Ingen inloggning behövs.
--   bcode=     samma sorts kvitto.
--
-- Skrubbningen sker i tre led: i tools/fbmejl-hamta.ps1 innan texten lämnar
-- ägarens maskin, i js/fbmejl.js innan något tolkas, och här innan något
-- skrivs. Tre exemplar är avsiktligt — till skillnad från nykterhetsfiltret
-- kan en avvikelse här bara betyda att ett led skrubbar MER än ett annat.
--
-- Sökvägen lämnas intakt så grupp-id och inläggs-id går att läsa ut, och mid=
-- lämnas kvar eftersom den är en dedupnyckel som inte avslöjar mottagaren.

create or replace function public.fbmejl_sanera(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select regexp_replace(
           coalesce(p_text, ''),
           '([?&]|%3F|%26)(n_m|notif_id|bcode|aref|nid)(=|%3D)[^&[:space:]"''<>]*',
           '\1\2=BORTTAGET',
           'gi');
$$;

-- ============================ KÖN IN =================================
--
-- Råa mejl, precis som pollaren läste dem. Ett mejl per rad, nyckel är
-- Message-ID.
--
-- Innehållet är andra människors text ordagrant, plus deras namn. Tabellen är
-- därför oåtkomlig för både anon och inloggade, och städas efter sju dagar.
-- Ingenting här behöver sparas längre än så: har ett mejl inte tolkats inom en
-- vecka är varningen död sedan länge ändå.

create table if not exists public.fbmejl_ko (
  message_id  text primary key,
  avsandare   text,
  amne        text,
  brodtext    text,
  skickat_at  timestamptz,
  hamtat_at   timestamptz not null default now(),
  imap_uid    bigint,
  status      text not null default 'ny'
              check (status in ('ny', 'klar', 'vagrad', 'fel')),
  skal        text,
  forsok      smallint not null default 0,
  avgjort_at  timestamptz
);

create index if not exists fbmejl_ko_status_idx on public.fbmejl_ko (status, hamtat_at);
create index if not exists fbmejl_ko_tid_idx    on public.fbmejl_ko (hamtat_at desc);

alter table public.fbmejl_ko enable row level security;

-- Inga policies, med flit. Radsäkerhet utan policy betyder att ingen som
-- kommer in via PostgREST ser eller skriver någonting alls — varken anon
-- eller inloggade. Tabellen nås bara av funktionerna nedan, som är security
-- definer, och av service_role i SQL-editorn.
revoke all on public.fbmejl_ko from anon, authenticated;

-- ============================ LÄSTA MEJL =============================
--
-- Ett inlägg får bli en rapport en gång. Facebook skickar ett NYTT mejl med
-- nytt Message-ID varje gång någon kommenterar samma inlägg — utan den här
-- tabellen blir ett inlägg med tre kommentarer fyra varningar på kartan.
--
-- Tre nycklar, för de fångar olika fel:
--   nyckel       'fbm:post:<gid>_<pid>' när mejlet bar en länk till inlägget,
--                'fbm:<message-id>' annars. Mejlets/inläggets egen identitet.
--   text_nyckel  'tx:<hash>:<fack>'. Samma text i samma tidsfönster, oavsett
--                väg in. IDENTISK med den js/telegram.js räknar fram — det är
--                den som gör att ett inlägg som både speglas till Telegram och
--                mejlas ut blir EN varning.
--   inlaggs_id   inläggets id när det gick att få tag på. Revision.
--
-- Raden skrivs även för det som INTE blev en rapport. En vägrad
-- nykterhetskontroll ska inte prövas igen vid nästa körning.

create table if not exists public.fbmejl_lasta (
  nyckel      text primary key,
  text_nyckel text,
  message_id  text,
  inlaggs_id  text,
  utfall      text not null default 'okand'
              check (utfall in ('rapport', 'vagrad', 'bortsorterad', 'okand')),
  skal        text,
  rapport_id  text references public.reports(id) on delete set null,
  last_at     timestamptz not null default now()
);

create index if not exists fbmejl_lasta_text_idx on public.fbmejl_lasta (text_nyckel);
create index if not exists fbmejl_lasta_tid_idx  on public.fbmejl_lasta (last_at desc);
create index if not exists fbmejl_lasta_msg_idx  on public.fbmejl_lasta (message_id);

alter table public.fbmejl_lasta enable row level security;
revoke all on public.fbmejl_lasta from anon, authenticated;

-- ============================ BRYGGANS TILLSTÅND =====================
--
-- IMAP numrerar mejl med ett stigande UID per postlåda. Kvitterar man inte
-- hur långt man kommit läses hela inkorgen om vid varje start, och timmar
-- gamla varningar dyker upp som nya.
--
-- UIDVALIDITY måste sparas bredvid. Byter servern ut den — vilket händer om
-- postlådan byggs om — börjar UID om från ett, och ett sparat UID på 4711
-- skulle då hoppa över allt nytt för alltid. Ändras UIDVALIDITY nollställs
-- UID, och en omgång gamla mejl läses om. Det är rätt fel att göra: en
-- dubblett stoppas av avdubblingen, en missad varning stoppas av ingenting.

create table if not exists public.fbmejl_brygga (
  id             smallint primary key default 1 check (id = 1),
  uidvalidity    bigint not null default 0,
  senaste_uid    bigint not null default 0,
  senast_kord    timestamptz,
  senaste_fel    text,
  uppdaterad     timestamptz not null default now()
);

insert into public.fbmejl_brygga (id) values (1) on conflict (id) do nothing;

alter table public.fbmejl_brygga enable row level security;
revoke all on public.fbmejl_brygga from anon, authenticated;

-- ============================ NOTISER: OPT-IN ========================
--
-- En push när någon skrivit i gruppen. Kravet kommer från ägaren, och det är
-- rimligt: en varning som ligger på kartan men som ingen tittar på är ingen
-- varning.
--
-- Kolumnen läggs till på push_subscriptions och har default FALSE. Det är
-- inte försiktighet för sakens skull:
--
--   En notis är det enda i appen som visas utan att någon bett om det. Får en
--   användare notiser hen inte valt stänger hen av notiser för hela appen i
--   telefonens inställningar — och då tystnar körpåminnelsen också. Kanalen
--   är gemensam, och den som bränner den bränner den för allt.
--
-- Alltså: av som standard, på för den som väljer det. Se docs/fbmejl.md för
-- vad som behöver läggas till i js/push.js och index.html för att det ska gå
-- att slå på från appen, och för SQL-raden som slår på det för ägarens egen
-- telefon innan den knappen finns.
--
-- Blocket gör ingenting om push.sql inte är körd — då finns ingen tabell att
-- utöka, och notiserna är ändå avstängda.

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'push.sql är inte körd — gruppnotiser hoppas över. Rapporterna hamnar ändå på kartan.';
    return;
  end if;
  alter table public.push_subscriptions
    add column if not exists gruppnotiser boolean not null default false;
  raise notice 'push_subscriptions.gruppnotiser finns (default false — se docs/fbmejl.md).';
end $$;

-- ============================ NOTISER: TAKTEN ========================
--
-- Hur ofta får appen ringa?
--
-- Det här är den enda designfrågan i hela filen som inte har ett tekniskt
-- svar, så resonemanget står här istället för i en commit ingen läser.
--
-- Gruppen "Här står polisen" är livlig. En fredagseftermiddag kan ge tiotals
-- inlägg i timmen. En notis per inlägg betyder en telefon som ringer var
-- tredje minut, och konsekvensen av det är känd och entydig: användaren
-- stänger av notiser för Polisvakt. Inte för gruppnotiserna — för appen. Då
-- tystnar körpåminnelsen med, och den är det enda som får folk att öppna
-- appen INNAN de kör.
--
-- Fyra spärrar, och ingen av dem ersätter en annan:
--
--   buntspärren   EN notis per tömningsomgång, aldrig en per rapport. Kom det
--                 fyra varningar samtidigt är det ett besked, inte fyra.
--
--   glesspärren   minst 10 minuter mellan två notiser. Talet är valt mot
--                 varningarnas livslängd i js/store.js: polis 45 min, kontroll
--                 60, civil 30. Den som fick en notis för tio minuter sedan
--                 och öppnade appen ser den nya varningen på kartan redan —
--                 den behöver inte ringa igen.
--
--   nattspärren   inga notiser 23:00–06:00 svensk tid. Samma resonemang som
--                 nattspärren i due_push_reminders: en varning som väcker
--                 någon 03:00 kostar mer förtroende än den kan ge tillbaka.
--                 Vill man ha nattnotiser är det ett medvetet val — ändra
--                 p_tidigast och p_senast, de sitter som parametrar just
--                 därför.
--
--   dygnstaket    högst 12 notiser per dygn. Är gruppen så aktiv att taket
--                 slår i är appen inte längre kanalen — då öppnar man den.
--
-- Ingenting går tyst förlorat. Varje undertryckt omgång räknas upp i
-- odelade, och nästa notis som får gå säger hur många varningar som kommit
-- sedan sist. Användaren får alltså veta att det hänt saker, bara inte fyra
-- gånger i rad.

create table if not exists public.fbmejl_notis_lage (
  id             smallint primary key default 1 check (id = 1),
  senaste_at     timestamptz,
  antal_idag     smallint not null default 0,
  dag            date,
  odelade        int not null default 0,   -- varningar som inte fått ringa än
  senaste_fel    text,
  uppdaterad     timestamptz not null default now()
);

insert into public.fbmejl_notis_lage (id) values (1) on conflict (id) do nothing;

alter table public.fbmejl_notis_lage enable row level security;
revoke all on public.fbmejl_notis_lage from anon, authenticated;

-- Loggen finns för att frågan "varför ringde det inte?" ska gå att besvara i
-- efterhand. Utan den ser en tyst spärr exakt likadan ut som en trasig kedja.
create table if not exists public.fbmejl_notis_logg (
  id          bigint generated always as identity primary key,
  skickat_at  timestamptz not null default now(),
  antal       int not null default 0,
  titel       text,
  text        text,
  utfall      text not null default 'skickad'
              check (utfall in ('skickad', 'sparrad', 'fel')),
  skal        text
);

create index if not exists fbmejl_notis_logg_tid_idx on public.fbmejl_notis_logg (skickat_at desc);

alter table public.fbmejl_notis_logg enable row level security;
revoke all on public.fbmejl_notis_logg from anon, authenticated;

-- ============================ NOTISER: TEXTEN ========================
--
-- Vad står det i notisen?
--
-- Typ plus plats, och ingenting mer. ALDRIG inläggets råa text.
--
-- Skälet är inte estetiskt. note är en främlings ord ordagrant, hämtade ur ett
-- mejl vi inte kontrollerar, och en notis är det enda i appen som dyker upp på
-- en låst skärm utan att någon bett om det. Det som får visas där måste vara
-- något vi själva har byggt av fält vi själva har validerat: typen är en av
-- fyra kända strängar, platsen är geokodningens etikett. Skickar man vidare
-- råtexten har man byggt en kanal där vem som helst i en Facebook-grupp kan
-- skriva vad som helst rakt in på en främlings låsskärm.

create or replace function public.fbmejl_typnamn(p_typ text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_typ
    when 'police'   then 'Polis'
    when 'control'  then 'Trafikkontroll'
    when 'unmarked' then 'Civil polisbil'
    when 'camera'   then 'Fartkamera'
    else 'Varning'
  end;
$$;

-- ============================ NOTISER: SLÅ PÅ ========================
--
-- Appens knapp. Samma mönster som mark_drove_today() i push.sql: den som
-- anropar måste känna till både sin egen endpoint och sitt device_id, och
-- public.actor() avgör vem raden tillhör. Ingen kan slå på notiser åt någon
-- annan.
--
-- Funktionen skapas bara om push.sql är körd — annars finns varken tabellen
-- eller actor(), och ett create som misslyckas hade dödat hela filen.

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'push.sql saknas — hoppar över fbmejl_satt_gruppnotiser().';
    return;
  end if;

  execute $fn$
    create or replace function public.fbmejl_satt_gruppnotiser(
      p_endpoint text, p_device text, p_pa boolean
    )
    returns void
    language plpgsql security definer set search_path = public as $kropp$
    declare v_actor text;
    begin
      v_actor := public.actor(p_device);
      update push_subscriptions s
         set gruppnotiser = coalesce(p_pa, false),
             updated_at = now()
       where s.endpoint = p_endpoint and s.device_id = v_actor;
    end $kropp$;
  $fn$;

  execute 'revoke execute on function public.fbmejl_satt_gruppnotiser(text, text, boolean) from public';
  execute 'grant execute on function public.fbmejl_satt_gruppnotiser(text, text, boolean) to anon, authenticated';
  raise notice 'fbmejl_satt_gruppnotiser() finns — se docs/fbmejl.md för knappen i appen.';
exception when others then
  raise notice 'Kunde inte skapa fbmejl_satt_gruppnotiser (%). Notiserna gar att sla pa med SQL anda.', sqlerrm;
end $$;

-- ============================ NOTISER: MOTTAGARE =====================
--
-- Edge-funktionen fbmejl-push hämtar sina mottagare härifrån. Bara de som
-- själva slagit på gruppnotiser, och bara de vars prenumeration lever.
--
-- Funktionen lämnar ut endpoint och auth-hemlighet i klartext — samma sak som
-- due_push_reminders gör, och därför samma skydd: service_role och ingenting
-- annat. Se rättighetsblocket längre ner.

-- Hur många har faktiskt slagit på gruppnotiser?
--
-- Egen funktion och inte en subselect i vyn, av ett trist men avgörande skäl:
-- push.sql behöver inte vara körd för att den här filen ska gå att köra. En
-- vy som nämner push_subscriptions direkt hade fått hela transaktionen att dö
-- på en tabell som inte finns, och då hade inte heller rapporterna kommit in.
-- Uppslagningen görs därför dynamiskt, och svarar 0 när tabellen saknas.
create or replace function public.fbmejl_gruppnotis_antal()
returns int
language plpgsql
security definer
stable
set search_path = public as $$
declare n int;
begin
  if to_regclass('public.push_subscriptions') is null then return 0; end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'push_subscriptions'
       and column_name = 'gruppnotiser'
  ) then return 0; end if;

  execute 'select count(*) from public.push_subscriptions where enabled and coalesce(gruppnotiser, false)'
    into n;
  return coalesce(n, 0);
end $$;

create or replace function public.fbmejl_push_mottagare(p_limit int default 2000)
returns table (endpoint text, p256dh text, auth text)
language plpgsql
security definer
stable
set search_path = public as $$
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
     limit greatest(1, least(coalesce(p_limit, 2000), 5000));
end $$;

-- ============================ NOTISER: UTSKICKET =====================
--
-- Anropas av fbmejl_ta_emot() när en omgång skapat minst en NY rapport.
-- Aldrig för dubbletter, aldrig för bortsorterade, och aldrig — under några
-- omständigheter — för nykterhets- eller drogkontroller.
--
-- Det sista är inte automatiskt bara för att de aldrig blir rapporter, och
-- det är värt att säga rakt ut: en notis som säger "något har hänt i gruppen"
-- efter en nykterhetskontroll VORE nykterhetsvarningen. Föraren behöver inte
-- veta var kontrollen står för att sakta ner och ta en annan väg — det räcker
-- att veta att det står något. Därför byggs notisen uteslutande av rader som
-- faktiskt blev rapporter, och p_nya innehåller bara dem.
--
-- @param p_nya  jsonb-array av {typ, plats} för de rapporter som skapades
--
-- Anropet ut sker med pg_net, som är asynkront: net.http_post lägger sig i en
-- kö och returnerar direkt. Det betyder att en trög eller nere edge-funktion
-- ALDRIG kan hålla upp fbmejl_ta_emot och därmed rapporterna. Rapporten på
-- kartan är viktigare än notisen om den.

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
set search_path = public as $$
declare
  v_antal    int;
  v_lage     public.fbmejl_notis_lage%rowtype;
  v_lokal    timestamptz := now();
  v_timme    int;
  v_dag      date;
  v_platser  text;
  v_titel    text;
  v_text     text;
  v_totalt   int;
  v_url      text;
  v_nyckel   text;
  v_skal     text;
begin
  if p_nya is null or jsonb_typeof(p_nya) <> 'array' then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  v_antal := jsonb_array_length(p_nya);
  if v_antal = 0 then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
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

  -- Platserna, utan dubbletter, högst tre. Fler får inte plats i en notis och
  -- gör den svårare att läsa på en låsskärm i en bil.
  select string_agg(p, ' · ') into v_platser from (
    select distinct on (lower(x.plats)) left(x.plats, 40) as p
      from jsonb_to_recordset(p_nya) as x(typ text, plats text)
     where coalesce(x.plats, '') <> ''
     order by lower(x.plats)
     limit 3
  ) d;

  if v_totalt = 1 then
    -- En enda varning: säg vad och var direkt i titeln. Det är hela poängen.
    select public.fbmejl_typnamn(x.typ) || coalesce(' vid ' || left(x.plats, 60), '')
      into v_titel
      from jsonb_to_recordset(p_nya) as x(typ text, plats text) limit 1;
    v_text := 'Ny rapport från gruppen. Öppna Polisvakt för att se var på kartan.';
  else
    v_titel := v_totalt || ' nya varningar i gruppen';
    v_text  := coalesce(v_platser, 'Öppna Polisvakt för att se var.');
  end if;

  update public.fbmejl_notis_lage
     set senaste_at = now(),
         antal_idag = v_lage.antal_idag + 1,
         dag = v_dag,
         odelade = 0,
         senaste_fel = null,
         uppdaterad = now()
   where id = 1;

  -- Ut på nätet, om vägen dit finns. Saknas pg_net eller adressen loggas det
  -- som ett fel istället för att tyst försvinna — en notiskedja som ser frisk
  -- ut och inte når fram är den svåraste sortens fel, och den har den här
  -- appen redan haft en gång.
  v_url    := current_setting('app.fbmejl_push_url', true);
  v_nyckel := current_setting('app.service_role_key', true);

  if v_url is null or v_url = '' then
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'app.fbmejl_push_url saknas');
    update public.fbmejl_notis_lage set senaste_fel = 'app.fbmejl_push_url saknas' where id = 1;
    return jsonb_build_object('skickad', false, 'skal', 'ingen-url', 'titel', v_titel);
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
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'pg_net saknas');
    update public.fbmejl_notis_lage set senaste_fel = 'pg_net saknas' where id = 1;
    return jsonb_build_object('skickad', false, 'skal', 'pg_net-saknas', 'titel', v_titel);
  end if;

  begin
    perform net.http_post(
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
        'tag',   'polisvakt-grupp',
        'url',   './',
        'antal', v_totalt
      )
    );
  exception when others then
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', left(sqlerrm, 200));
    update public.fbmejl_notis_lage set senaste_fel = left(sqlerrm, 500) where id = 1;
    return jsonb_build_object('skickad', false, 'skal', 'fel', 'detalj', sqlerrm);
  end;

  insert into public.fbmejl_notis_logg (antal, titel, text, utfall)
  values (v_totalt, v_titel, v_text, 'skickad');

  return jsonb_build_object('skickad', true, 'antal', v_totalt, 'titel', v_titel);
end $$;

-- ============================ POLLAREN LÄGGER IN =====================
--
-- Anropas av tools/fbmejl-hamta.ps1 med en json-array av råa mejl:
--
--   [{ "message_id": "<...@facebookmail.com>", "from": "...", "subject": "...",
--      "body": "...", "date": "2026-08-20T12:00:00Z", "uid": 4711 }]
--
-- Idempotent på Message-ID: samma mejl inlagt två gånger ger en rad.
--
-- Nykterhetsnätet körs redan HÄR, innan tolkaren ens sett mejlet. Raden
-- sparas men markeras 'vagrad' och plockas aldrig upp av fbmejl_ko_hamta().
-- Det är tredje gången samma regel körs på samma text (js/fbmejl.js kör den
-- två gånger före parsern), och det är med flit — den enda regeln i appen som
-- får kosta överdriven försiktighet är den här.

create or replace function public.fbmejl_ko_in(p_mejl jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_rad       jsonb;
  v_id        text;
  v_text      text;
  v_skrivna   int;
  v_mottagna  int := 0;
  v_nya       int := 0;
  v_dubbletter int := 0;
  v_vagrade   int := 0;
  v_ogiltiga  int := 0;
  v_max_uid   bigint := 0;
  v_uid       bigint;
begin
  if p_mejl is null or jsonb_typeof(p_mejl) <> 'array' then
    return jsonb_build_object('fel', 'p_mejl maste vara en json-array');
  end if;

  for v_rad in select * from jsonb_array_elements(p_mejl) loop
    v_mottagna := v_mottagna + 1;
    v_id := nullif(trim(coalesce(v_rad->>'message_id', '')), '');

    -- Utan Message-ID finns ingen avdubbling, och då blir samma mejl en ny
    -- varning vid varje pollning. Raden avvisas hellre än skrivs.
    if v_id is null then
      v_ogiltiga := v_ogiltiga + 1;
      continue;
    end if;

    v_uid := nullif(v_rad->>'uid', '')::bigint;
    if v_uid is not null and v_uid > v_max_uid then v_max_uid := v_uid; end if;

    v_text := coalesce(v_rad->>'subject', '') || ' ' || coalesce(v_rad->>'body', '');

    insert into public.fbmejl_ko
      (message_id, avsandare, amne, brodtext, skickat_at, imap_uid, status, skal, avgjort_at)
    values (
      left(v_id, 200),
      left(coalesce(v_rad->>'from', ''), 200),
      left(public.fbmejl_sanera(coalesce(v_rad->>'subject', '')), 1000),
      -- Brödtexten kapas. Ett Facebook-mejl i HTML kan vara hundra kilobyte
      -- boilerplate, och inlägget står alltid i början. Skrubbas först — se
      -- avsnittet INTEGRITET ovan.
      left(public.fbmejl_sanera(coalesce(v_rad->>'body', '')), 20000),
      nullif(v_rad->>'date', '')::timestamptz,
      v_uid,
      case when public.fbmejl_ar_nykterhetskontroll(v_text) then 'vagrad' else 'ny' end,
      case when public.fbmejl_ar_nykterhetskontroll(v_text) then 'nykterhet' else null end,
      case when public.fbmejl_ar_nykterhetskontroll(v_text) then now() else null end
    )
    on conflict (message_id) do nothing;

    get diagnostics v_skrivna = row_count;

    if v_skrivna = 0 then
      v_dubbletter := v_dubbletter + 1;
    elsif public.fbmejl_ar_nykterhetskontroll(v_text) then
      v_vagrade := v_vagrade + 1;
    else
      v_nya := v_nya + 1;
    end if;
  end loop;

  update public.fbmejl_brygga
     set senast_kord = now(), senaste_fel = null, uppdaterad = now()
   where id = 1;

  return jsonb_build_object(
    'mottagna',   v_mottagna,
    'nya',        v_nya,
    'dubbletter', v_dubbletter,
    'vagrade',    v_vagrade,
    'ogiltiga',   v_ogiltiga,
    'max_uid',    v_max_uid
  );
end $$;

-- ============================ TOLKAREN HÄMTAR ========================
--
-- Ger det som ligger olöst i kön, äldst först. Äldst först med flit: en
-- varning som håller på att bli för gammal ska hinna ut innan den dör, och
-- js/fbmejl.js kastar den ändå om den hunnit löpa ut.
--
-- forsok räknas upp här, inte när svaret kommer. Ett mejl som får tolkaren
-- att krascha ska inte kunna spelas om i evighet och blockera allt efter sig
-- — efter fem försök plockas det inte upp igen.

create or replace function public.fbmejl_ko_hamta(p_antal int default 25)
returns table (
  message_id text,
  avsandare  text,
  amne       text,
  brodtext   text,
  skickat_at timestamptz
)
language plpgsql
security definer
set search_path = public as $$
-- returns table(...) skapar variabler som heter EXAKT som kolumnerna nedan.
-- Utan den här raden riskerar varje okvalificerad kolumnreferens att bli
-- "column reference is ambiguous" — ett fel som bara syns vid körning, alltså
-- när kön ska tömmas och ingen tittar.
#variable_conflict use_column
begin
  return query
  update public.fbmejl_ko k
     set forsok = k.forsok + 1
   where k.message_id in (
     select k2.message_id from public.fbmejl_ko k2
      where k2.status = 'ny' and k2.forsok < 5
      order by coalesce(k2.skickat_at, k2.hamtat_at) asc
      limit greatest(1, least(coalesce(p_antal, 25), 200))
   )
  returning k.message_id, k.avsandare, k.amne, k.brodtext, k.skickat_at;
end $$;

-- ============================ TA EMOT ================================
--
-- Anropas av tolkaren med en json-array av färdigtolkade rader. Varje rad är
-- det js/fbmejl.js byggRapport() lämnar ifrån sig, plus text_nyckel för
-- avdubblingen och message_id/inlaggs_id för revisionen.
--
-- Funktionen är security definer eftersom den skriver till reports förbi
-- radsäkerheten (det finns ingen insert-policy som tillåter external_id från
-- en tredje part). Den är därför också åtkomstskyddad hårt längre ner: bara
-- service_role får anropa den. Ingen anon-nyckel i världen ska kunna lägga
-- rapporter i gruppens namn.

create or replace function public.fbmejl_ta_emot(p_rader jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_rad         jsonb;
  v_nyckel      text;
  v_text_nyckel text;
  v_msg_id      text;
  v_note        text;
  v_id          text;
  v_typ         text;
  v_skrivna     int;
  v_krock       boolean;
  v_mottagna    int := 0;
  v_skapade     int := 0;
  v_dubbletter  int := 0;
  v_vagrade     int := 0;
  v_ogiltiga    int := 0;
  -- Bara det som FAKTISKT blev en ny rapport samlas här. Listan är det enda
  -- notisen byggs av, och det är därför en vägrad nykterhetskontroll inte kan
  -- ge upphov ens till en notis om att "något hänt". Se fbmejl_notis_ut().
  v_nya         jsonb := '[]'::jsonb;
  v_notis       jsonb := null;
begin
  if p_rader is null or jsonb_typeof(p_rader) <> 'array' then
    return jsonb_build_object('fel', 'p_rader maste vara en json-array');
  end if;

  for v_rad in select * from jsonb_array_elements(p_rader) loop
    v_mottagna    := v_mottagna + 1;
    v_nyckel      := nullif(v_rad->>'external_id', '');
    v_text_nyckel := nullif(v_rad->>'text_nyckel', '');
    v_msg_id      := nullif(v_rad->>'message_id', '');
    v_note        := coalesce(v_rad->>'note', '');
    v_typ         := v_rad->>'type';

    if v_nyckel is null or v_typ is null
       or (v_rad->>'lat') is null or (v_rad->>'lon') is null then
      v_ogiltiga := v_ogiltiga + 1;
      continue;
    end if;

    -- Kameror kommer aldrig hit från js/fbmejl.js, men om någon bygger en
    -- fjärde väg in ska svaret vara detsamma: de 136 kamerorna i Västmanland
    -- ligger redan i appen med rätt position och mätriktning.
    if v_typ = 'camera' then
      v_vagrade := v_vagrade + 1;
      insert into fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'vagrad', 'kamera')
      on conflict (nyckel) do nothing;
      update fbmejl_ko set status = 'vagrad', skal = 'kamera', avgjort_at = now()
       where message_id = v_msg_id;
      continue;
    end if;

    -- Avdubbling, tre frågor.
    perform 1 from fbmejl_lasta
     where nyckel = v_nyckel
        or (v_text_nyckel is not null and text_nyckel = v_text_nyckel);
    v_krock := found;

    -- Korsvis mot Telegram-spegeln, om den är installerad. Samma inlägg kan
    -- komma både speglat och mejlat, och då ska det bli EN varning. Kollen
    -- görs dynamiskt så att den här filen går att köra utan telegram.sql.
    if not v_krock and v_text_nyckel is not null
       and to_regclass('public.telegram_lasta') is not null then
      execute 'select exists (select 1 from public.telegram_lasta where text_nyckel = $1)'
        into v_krock using v_text_nyckel;
    end if;

    if v_krock then
      v_dubbletter := v_dubbletter + 1;
      update fbmejl_ko set status = 'klar', skal = 'dubblett', avgjort_at = now()
       where message_id = v_msg_id;
      continue;
    end if;

    if public.fbmejl_ar_nykterhetskontroll(v_note) then
      v_vagrade := v_vagrade + 1;
      insert into fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'vagrad', 'nykterhet')
      on conflict (nyckel) do nothing;
      update fbmejl_ko set status = 'vagrad', skal = 'nykterhet', avgjort_at = now()
       where message_id = v_msg_id;
      continue;
    end if;

    -- Primärnyckeln är slumpad med flit. Vore den härledd ur Message-ID
    -- skulle en omkörning krocka på både id och external_id samtidigt, och
    -- on conflict kan bara tyst hoppa över det ena.
    v_id := coalesce(nullif(v_rad->>'id', ''), gen_random_uuid()::text);

    insert into public.reports (
      id, type, lat, lon, label, note, source, device_id, external_id,
      created_at, expires_at, confirms, denials,
      gps_accuracy_m, fart_kmh, fordrojning_s,
      geokod, geokod_typ, geokod_radius_m, parser_confidence
    )
    values (
      v_id,
      v_typ,
      (v_rad->>'lat')::double precision,
      (v_rad->>'lon')::double precision,
      left(coalesce(v_rad->>'label', ''), 120),
      left(v_note, 500),
      -- Källan sätts HÄR, inte av den som anropar. En tolkare som råkar
      -- skicka source = 'app' ska inte kunna få gruppens andrahandsuppgifter
      -- graderade som en förares egen knapptryckning i js/kvalitet.js.
      'facebook',
      coalesce(nullif(v_rad->>'device_id', ''), 'fb-mejl'),
      v_nyckel,
      (v_rad->>'created_at')::bigint,
      (v_rad->>'expires_at')::bigint,
      1, 0,
      (v_rad->>'gps_accuracy_m')::int,
      (v_rad->>'fart_kmh')::int,
      (v_rad->>'fordrojning_s')::int,
      v_rad->>'geokod',
      v_rad->>'geokod_typ',
      (v_rad->>'geokod_radius_m')::int,
      (v_rad->>'parser_confidence')::real
    )
    on conflict (external_id) do nothing;

    get diagnostics v_skrivna = row_count;

    if v_skrivna > 0 then
      v_skapade := v_skapade + 1;
      v_nya := v_nya || jsonb_build_array(jsonb_build_object(
        'typ',   v_typ,
        'plats', left(coalesce(nullif(v_rad->>'label', ''), ''), 60)
      ));
      insert into fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, rapport_id)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'rapport', v_id)
      on conflict (nyckel) do update set rapport_id = excluded.rapport_id,
                                         utfall = 'rapport';
      update fbmejl_ko set status = 'klar', skal = null, avgjort_at = now()
       where message_id = v_msg_id;
    else
      -- Fanns redan i reports men inte i fbmejl_lasta: minnet hade rensats
      -- eller raden kom in via Telegram-spegeln eller userscriptet. Skriv
      -- minnet, räkna som dubblett.
      v_dubbletter := v_dubbletter + 1;
      insert into fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'bortsorterad', 'fanns-redan')
      on conflict (nyckel) do nothing;
      update fbmejl_ko set status = 'klar', skal = 'fanns-redan', avgjort_at = now()
       where message_id = v_msg_id;
    end if;
  end loop;

  update public.fbmejl_brygga
     set senast_kord = now(), senaste_fel = null, uppdaterad = now()
   where id = 1;

  -- EN notis för hela omgången, aldrig en per rapport. Anropet sker sist av
  -- allt och inuti sitt eget begin/exception: en trasig notiskedja får inte
  -- kunna rulla tillbaka rapporter som redan är skrivna. Varningen på kartan
  -- är det som räknas; notisen om den är en bekvämlighet.
  if v_skapade > 0 then
    begin
      v_notis := public.fbmejl_notis_ut(v_nya);
    exception when others then
      v_notis := jsonb_build_object('skickad', false, 'skal', 'fel', 'detalj', sqlerrm);
    end;
  end if;

  return jsonb_build_object(
    'mottagna',   v_mottagna,
    'skapade',    v_skapade,
    'dubbletter', v_dubbletter,
    'vagrade',    v_vagrade,
    'ogiltiga',   v_ogiltiga,
    'notis',      v_notis
  );
end $$;

-- ============================ AVGJORT UTAN RAPPORT ===================
--
-- Tolkaren kastar de flesta mejl: frågor, skvaller, kommentarsnotiser,
-- buntade sammanfattningar. De måste ändå markeras, annars plockas de upp
-- igen vid nästa tömning tills forsok slår i taket.
--
-- p_skal är fritext från js/fbmejl.js SKAL-listan.

create or replace function public.fbmejl_ko_avfard(p_message_ids jsonb, p_skal text default 'bortsorterad')
returns int
language plpgsql
security definer
set search_path = public as $$
declare n int;
begin
  if p_message_ids is null or jsonb_typeof(p_message_ids) <> 'array' then
    return 0;
  end if;

  update public.fbmejl_ko
     set status = case when p_skal = 'nykterhet' or p_skal = 'kamera' then 'vagrad' else 'klar' end,
         skal = left(coalesce(p_skal, 'bortsorterad'), 60),
         avgjort_at = now()
   where message_id in (select jsonb_array_elements_text(p_message_ids))
     and status = 'ny';

  get diagnostics n = row_count;
  return n;
end $$;

-- ============================ POLLNINGENS LÄGE =======================

create or replace function public.fbmejl_lage()
returns jsonb
language sql
security definer
stable
set search_path = public as $$
  select jsonb_build_object(
    'uidvalidity', coalesce(max(uidvalidity), 0),
    'senaste_uid', coalesce(max(senaste_uid), 0)
  )
  from public.fbmejl_brygga where id = 1;
$$;

create or replace function public.fbmejl_satt_lage(
  p_uidvalidity bigint,
  p_uid bigint,
  p_fel text default null
)
returns void
language plpgsql
security definer
set search_path = public as $$
declare v_nuvarande bigint;
begin
  select uidvalidity into v_nuvarande from public.fbmejl_brygga where id = 1;

  if coalesce(p_uidvalidity, 0) <> 0 and coalesce(v_nuvarande, 0) <> coalesce(p_uidvalidity, 0) then
    -- Postlådan har byggts om. UID börjar om från ett, och ett gammalt sparat
    -- UID skulle hoppa över allt nytt för alltid. Nollställ hellre och läs om
    -- en omgång — dubbletter stoppas av avdubblingen, missade varningar av
    -- ingenting.
    update public.fbmejl_brygga
       set uidvalidity = p_uidvalidity,
           senaste_uid = coalesce(p_uid, 0),
           senast_kord = now(),
           senaste_fel = left(p_fel, 500),
           uppdaterad = now()
     where id = 1;
    return;
  end if;

  -- greatest() med flit: UID får bara gå framåt inom samma UIDVALIDITY. Ett
  -- svar som kommer i fel ordning ska aldrig kunna backa kön och läsa om
  -- gamla mejl som redan är avgjorda.
  update public.fbmejl_brygga
     set uidvalidity = greatest(uidvalidity, coalesce(p_uidvalidity, 0)),
         senaste_uid = greatest(senaste_uid, coalesce(p_uid, 0)),
         senast_kord = now(),
         senaste_fel = left(p_fel, 500),
         uppdaterad = now()
   where id = 1;
end $$;

-- ============================ STÄDNING ===============================
--
-- Kön städas efter sju dagar: den innehåller andra människors text ordagrant
-- och ska inte ligga kvar längre än den behövs. Minnet städas efter fjorton —
-- efter det är inläggen sedan länge borta ur gruppen, och
-- reports_external_id_key är sista spärren ändå.

create or replace function public.stada_fbmejl()
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare n_ko int; n_lasta int; n_logg int;
begin
  delete from fbmejl_ko where hamtat_at < now() - interval '7 days';
  get diagnostics n_ko = row_count;

  delete from fbmejl_lasta where last_at < now() - interval '14 days';
  get diagnostics n_lasta = row_count;

  -- Notisloggen är bara till för felsökning. Trettio dagar räcker för att
  -- kunna svara på "varför ringde det inte i fredags".
  delete from fbmejl_notis_logg where skickat_at < now() - interval '30 days';
  get diagnostics n_logg = row_count;

  return jsonb_build_object('ko', n_ko, 'lasta', n_lasta, 'notislogg', n_logg);
end $$;

-- ============================ RÄTTIGHETER ============================
--
-- Ingenting här får gå att anropa med anon-nyckeln. fbmejl_ta_emot skriver
-- förbi radsäkerheten; kunde vem som helst anropa den vore hela insert-
-- policyn i schema.sql meningslös — man skulle kunna lägga ut vad som helst
-- i gruppens namn, med valfri position och valfri livslängd.
--
-- fbmejl_ko_hamta är lika känslig åt andra hållet: den returnerar hela
-- brödtexten ur andra människors inlägg.

revoke execute on function public.fbmejl_ko_in(jsonb)                     from public, anon, authenticated;
revoke execute on function public.fbmejl_ko_hamta(int)                    from public, anon, authenticated;
revoke execute on function public.fbmejl_ko_avfard(jsonb, text)           from public, anon, authenticated;
revoke execute on function public.fbmejl_ta_emot(jsonb)                   from public, anon, authenticated;
revoke execute on function public.fbmejl_lage()                           from public, anon, authenticated;
revoke execute on function public.fbmejl_satt_lage(bigint, bigint, text)  from public, anon, authenticated;
revoke execute on function public.stada_fbmejl()                          from public, anon, authenticated;
revoke execute on function public.fbmejl_push_mottagare(int)              from public, anon, authenticated;
revoke execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                          from public, anon, authenticated;

grant execute on function public.fbmejl_ko_in(jsonb)                      to service_role;
grant execute on function public.fbmejl_ko_hamta(int)                     to service_role;
grant execute on function public.fbmejl_ko_avfard(jsonb, text)            to service_role;
grant execute on function public.fbmejl_ta_emot(jsonb)                    to service_role;
grant execute on function public.fbmejl_lage()                            to service_role;
grant execute on function public.fbmejl_satt_lage(bigint, bigint, text)   to service_role;
grant execute on function public.stada_fbmejl()                           to service_role;
grant execute on function public.fbmejl_push_mottagare(int)               to service_role;
grant execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                          to service_role;

-- Typnamnet avslöjar ingenting och är en ren uppslagning.
grant execute on function public.fbmejl_typnamn(text)                     to anon, authenticated, service_role;
grant execute on function public.fbmejl_sanera(text)                      to anon, authenticated, service_role;

revoke execute on function public.fbmejl_gruppnotis_antal()               from public, anon, authenticated;
grant  execute on function public.fbmejl_gruppnotis_antal()               to service_role;

-- Nätet får läsas av alla — det avslöjar ingenting och är bekvämt att kunna
-- prova i editorn.
grant execute on function public.fbmejl_ar_nykterhetskontroll(text)       to anon, authenticated, service_role;

-- ============================ REVISIONSVYER ==========================
--
-- Läses i SQL-editorn, inte av appen. Inga grants till anon: kolumnen note
-- innehåller andra människors text ordagrant och ska inte gå att hämta med
-- den publika nyckeln. Samma resonemang som i facebook.sql och telegram.sql.

create or replace view public.fbmejl_senaste
with (security_invoker = on) as
  select
    to_char(to_timestamp(r.created_at / 1000.0) at time zone 'Europe/Stockholm',
            'YYYY-MM-DD HH24:MI')                        as tid,
    r.type                                               as typ,
    r.label                                              as plats,
    r.note                                               as inlagg,
    r.parser_confidence                                  as tillit,
    r.geokod, r.geokod_typ,
    round(r.fordrojning_s / 60.0, 1)                     as fordrojning_min,
    r.confirms - 1                                       as bekraftelser,
    r.denials                                            as nedrostningar,
    case
      when r.removed then 'borttagen'
      when r.denials >= 3 and r.denials > r.confirms then 'nedröstad'
      when r.expires_at > (extract(epoch from now()) * 1000)::bigint then 'aktiv'
      else 'utgången'
    end                                                  as status,
    r.external_id,
    r.lat, r.lon,
    r.id
  from public.reports r
  where r.device_id = 'fb-mejl'
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 24 * 3600 * 1000
  order by r.created_at desc;

-- Går bryggan alls? Den vanligaste frågan efter en vecka i drift, och den
-- går inte att besvara från appen — där ser "inga rapporter" och "bryggan är
-- död" exakt likadant ut.
--
-- Tre tal är de som betyder något:
--   minuter_sedan_koring  hög = pollaren går inte. Datorn sover, eller
--                         schemat är borta.
--   liggande_i_ko         hög = mejlen kommer in men INGEN TOLKAR DEM. Det är
--                         felet den här modellen är känsligast för.
--   fastnade              mejl som fått fem försök och gett upp. Här ligger
--                         formatfelen: kolla dem i fbmejl_ko med brödtexten.

create or replace view public.fbmejl_halsa
with (security_invoker = on) as
  select
    b.uidvalidity,
    b.senaste_uid,
    b.senast_kord,
    b.senaste_fel,
    round(extract(epoch from now() - b.senast_kord) / 60.0)      as minuter_sedan_koring,
    (select count(*) from public.fbmejl_ko
      where status = 'ny' and forsok < 5)                        as liggande_i_ko,
    (select count(*) from public.fbmejl_ko
      where status = 'ny' and forsok >= 5)                       as fastnade,
    (select count(*) from public.fbmejl_ko
      where hamtat_at > now() - interval '24 hours')             as mejl_dygn,
    (select count(*) from public.fbmejl_lasta
      where utfall = 'rapport' and last_at > now() - interval '24 hours') as rapporter_dygn,
    (select count(*) from public.fbmejl_lasta
      where utfall = 'vagrad'  and last_at > now() - interval '24 hours') as vagrade_dygn,
    (select count(*) from public.reports
      where device_id = 'fb-mejl' and denials > 0
        and created_at > (extract(epoch from now()) * 1000)::bigint - 7 * 24 * 3600 * 1000)
                                                                 as nedrostade_veckan,
    -- Notiskedjan. Tre tal som skiljer "det ringde inte för att det inte hänt
    -- något" från "det ringde inte för att kedjan är trasig":
    --   notiser_dygn   noll trots rapporter_dygn > 0 = något är fel.
    --   sparrade_dygn  spärrarna gör sitt jobb. Högt tal = livlig grupp.
    --   notis_fel      ingen url, ingen pg_net, eller ett svar som inte gick fram.
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'skickad' and skickat_at > now() - interval '24 hours') as notiser_dygn,
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'sparrad' and skickat_at > now() - interval '24 hours') as sparrade_dygn,
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'fel'     and skickat_at > now() - interval '24 hours') as notis_fel,
    (select n.senaste_fel from public.fbmejl_notis_lage n where n.id = 1)    as notis_senaste_fel,
    (select n.odelade     from public.fbmejl_notis_lage n where n.id = 1)    as odelade_varningar,
    public.fbmejl_gruppnotis_antal()                                         as gruppnotis_mottagare
  from public.fbmejl_brygga b
  where b.id = 1;

commit;

-- ============================ SCHEMALÄGGNING =========================
--
-- Två jobb, och bara det ena bor i databasen.
--
-- 1. Städningen. Ren SQL, schemaläggs direkt här nedan om pg_cron finns.
--
-- 2. Tömningen av kön. Den måste köra JavaScript (js/fbmejl.js) och ut på
--    nätet till geokodningen, och kan alltså inte vara ren SQL. Den kör i en
--    edge-funktion (fbmejl-tom), som anropas antingen från Dashboard ->
--    Edge Functions -> Schedules eller från pg_cron via pg_net.
--    Se docs/fbmejl.md.
--
-- Pollningen av postlådan schemaläggs INTE här. Den kör på ägarens Windows-
-- maskin via Uppgiftsschemaläggaren, för IMAP-lösenordet ska inte finnas i
-- molnet. Se docs/fbmejl.md.

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — kör "select public.stada_fbmejl();" manuellt då och då.';
    return;
  end if;
  perform 1 from cron.job where jobname = 'polisvakt-fbmejl-stada';
  if found then perform cron.unschedule('polisvakt-fbmejl-stada'); end if;
  perform cron.schedule('polisvakt-fbmejl-stada', '55 4 * * *',
                        'select public.stada_fbmejl();');
  raise notice 'Städning av fbmejl_ko och fbmejl_lasta schemalagd 04:55 varje natt.';
exception when others then
  raise notice 'Kunde inte schemalägga städningen (%). Kör funktionen manuellt då och då.', sqlerrm;
end $$;

-- Tömningen av kön, om du vill ha den i databasen istället för i Dashboard.
--
-- Kräver att edge-funktionen fbmejl-tom är utrullad och att de två nycklarna
-- är satta som databasinställningar. Nycklarna får ALDRIG stå i klartext i
-- cron.job — den tabellen är läsbar för alla med databasåtkomst och följer
-- med i varje backup:
--
--   alter database postgres set app.service_role_key = 'eyJ...';
--   alter database postgres set app.fbmejl_tom_url =
--     'https://<projekt>.supabase.co/functions/v1/fbmejl-tom';
--
-- Notiserna behöver en tredje inställning. Utan den skapas rapporterna som
-- vanligt men ingen push går ut, och fbmejl_halsa.notis_fel räknar upp:
--
--   alter database postgres set app.fbmejl_push_url =
--     'https://<projekt>.supabase.co/functions/v1/fbmejl-push';
--
-- Inställningar slår igenom först i NYA anslutningar. Sätt dem, öppna en ny
-- flik i SQL-editorn, och kör den här filen igen.
--
-- Blocket nedan gör ingenting förrän fbmejl_tom_url är satt.

do $$
declare v_url text;
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — schemalägg fbmejl-tom i Dashboard -> Edge Functions -> Schedules.';
    return;
  end if;
  perform 1 from pg_extension where extname = 'pg_net';
  if not found then
    raise notice 'pg_net saknas — schemalägg fbmejl-tom i Dashboard -> Edge Functions -> Schedules.';
    return;
  end if;

  v_url := current_setting('app.fbmejl_tom_url', true);
  if v_url is null or v_url = '' then
    raise notice 'app.fbmejl_tom_url är inte satt — tömningen schemaläggs inte. Se docs/fbmejl.md.';
    return;
  end if;

  perform 1 from cron.job where jobname = 'polisvakt-fbmejl';
  if found then perform cron.unschedule('polisvakt-fbmejl'); end if;

  -- Varje minut. Kravet från ägaren är att ett inlägg ska synas i appen inom
  -- en minut, och kön ligger redan färdig när tömningen vaknar — det enda
  -- den gör är att tolka text och geokoda. Tätare än så går inte med pg_cron.
  perform cron.schedule('polisvakt-fbmejl', '* * * * *', format($jobb$
    select net.http_post(
      url     := %L,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
      ),
      body    := jsonb_build_object('kalla', 'pg_cron')
    );
  $jobb$, v_url));
  raise notice 'Tömningen av mejlkön schemalagd varje minut.';
exception when others then
  raise notice 'Kunde inte schemalägga tömningen (%). Använd Dashboard -> Edge Functions -> Schedules istället.', sqlerrm;
end $$;

-- ============================ KONTROLL ===============================
--
-- Kör de här efteråt för att se att det blev rätt.
--
-- 1. Produktregeln, i databasen. Ska ge true, true, true, false:
--
--      select public.fbmejl_ar_nykterhetskontroll('Nykterhetskontroll vid Bäckby'),
--             public.fbmejl_ar_nykterhetskontroll('polisen blåser alla vid E18'),
--             public.fbmejl_ar_nykterhetskontroll('alkohol kontroll vid rondellen'),
--             public.fbmejl_ar_nykterhetskontroll('Polis står vid Erikslund');
--
-- 2. Nätet är detsamma som Telegram-spegelns. Ska ge noll rader, alltså
--    ingen text där de två svarar olika. Hoppa över om telegram.sql inte är körd:
--
--      select t, public.fbmejl_ar_nykterhetskontroll(t) as mejl,
--                public.telegram_ar_nykterhetskontroll(t) as telegram
--        from unnest(array[
--          'Nykterhetskontroll vid Bäckby', 'alkohol kontroll vid rondellen',
--          'drogtest på Vasagatan', 'polisen blåser alla', 'Polis vid Erikslund',
--          'Civilbil på E18 österut', 'fartkamera vid Hälla'
--        ]) as t
--       where public.fbmejl_ar_nykterhetskontroll(t)
--             is distinct from public.telegram_ar_nykterhetskontroll(t);
--
-- 3. Rättigheterna. INGEN rad får innehålla anon eller authenticated:
--
--      select p.proname, r.rolname
--        from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        cross join lateral aclexplode(p.proacl) a
--        join pg_roles r on r.oid = a.grantee
--       where n.nspname = 'public'
--         and p.proname in ('fbmejl_ko_in','fbmejl_ko_hamta','fbmejl_ko_avfard',
--                           'fbmejl_ta_emot','fbmejl_lage','fbmejl_satt_lage',
--                           'stada_fbmejl');
--
-- 4. Radsäkerheten. Ska ge rowsecurity = true och noll policyer på båda:
--
--      select relname, relrowsecurity from pg_class
--       where relname in ('fbmejl_ko','fbmejl_lasta','fbmejl_brygga');
--      select count(*) from pg_policies
--       where tablename in ('fbmejl_ko','fbmejl_lasta','fbmejl_brygga');
--
-- 5. Kön, med nykterhetsnätet på. Ska ge nya 1 och vagrade 1:
--
--      select public.fbmejl_ko_in(jsonb_build_array(
--        jsonb_build_object('message_id','<test-1@facebookmail.com>',
--          'from','notification@facebookmail.com',
--          'subject','Anna skrev i Här står polisen',
--          'body','Polis står vid Erikslund','date', now()::text),
--        jsonb_build_object('message_id','<test-2@facebookmail.com>',
--          'from','notification@facebookmail.com',
--          'subject','Bo skrev i Här står polisen',
--          'body','Nykterhetskontroll vid Bäckby','date', now()::text)));
--
--    Kön ska nu innehålla en rad med status 'ny' och en med 'vagrad':
--
--      select message_id, status, skal from public.fbmejl_ko
--       where message_id like '<test-%';
--
-- 6. Avdubblingen, på riktigt. Kör två gånger — andra gången ska ge
--    skapade 0 och dubbletter 1:
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fbm:test:1', 'text_nyckel', 'tx:test:1',
--        'message_id', '<test-1@facebookmail.com>',
--        'type', 'police', 'lat', 59.6099, 'lon', 16.5448,
--        'label', 'Testplats', 'note', 'Polis står vid testplatsen',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000,
--        'parser_confidence', 0.9, 'geokod', 'nominatim', 'geokod_typ', 'vag',
--        'fordrojning_s', 120)));
--
-- 7. Nätet, på riktigt. Ska ge skapade 0 och vagrade 1:
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fbm:test:2', 'type', 'police',
--        'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplats',
--        'note', 'Nykterhetskontroll vid testplatsen',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000)));
--
--    Städa upp efter 5, 6 och 7:
--
--      delete from public.fbmejl_ko    where message_id like '<test-%';
--      delete from public.fbmejl_lasta where nyckel like 'fbm:test:%';
--      delete from public.reports      where external_id like 'fbm:test:%';
--
-- 8. Notisen. Slå först på gruppnotiser för din egen telefon — byt ut
--    device_id mot ditt eget, det står i appens inställningar:
--
--      update public.push_subscriptions
--         set gruppnotiser = true
--       where device_id = '<ditt-device-id>';
--
--      select public.fbmejl_gruppnotis_antal();   -- ska ge minst 1
--      select * from public.fbmejl_push_mottagare(10);
--
--    Prova texten utan att skicka något (ingen url satt = ingen push går ut,
--    men titeln syns i svaret). En rapport ska ge "Polis vid Erikslund",
--    tre ska ge "3 nya varningar i gruppen":
--
--      select public.fbmejl_notis_ut(jsonb_build_array(
--        jsonb_build_object('typ','police','plats','Erikslund')));
--
--    Glesspärren, på riktigt. Kör raden ovan två gånger i rad — andra gången
--    ska ge skickad = false och skal = 'for-tatt':
--
--      select public.fbmejl_notis_ut(jsonb_build_array(
--        jsonb_build_object('typ','control','plats','E18')));
--
--    Nollställ spärren när du testat klart:
--
--      update public.fbmejl_notis_lage
--         set senaste_at = null, antal_idag = 0, odelade = 0 where id = 1;
--      delete from public.fbmejl_notis_logg;
--
-- 9. Produktregeln OCH notisen, tillsammans. Det här är det viktigaste testet
--    i hela filen: en nykterhetskontroll får inte ens ge en notis om att
--    "något hänt", för det vore i praktiken samma varning. Kör raden i punkt 7
--    och kontrollera sedan att INGEN ny rad tillkommit:
--
--      select count(*) from public.fbmejl_notis_logg
--       where skickat_at > now() - interval '1 minute';
--
-- 10. Hälsan, när bryggan väl går:
--
--      select * from public.fbmejl_halsa;
--      select * from public.fbmejl_senaste;
--
-- Gick en omgång fel och la ut skräp? Så här släcks den utan att historiken
-- raderas — rapporterna försvinner ur appen inom en tömningscykel, men
-- raderna finns kvar att granska:
--
--   update public.reports
--      set removed = true,
--          expires_at = (extract(epoch from now()) * 1000)::bigint
--    where device_id = 'fb-mejl'
--      and created_at > (extract(epoch from now()) * 1000)::bigint - 3600 * 1000;
-- =====================================================================
