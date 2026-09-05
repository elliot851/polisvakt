/* =====================================================================
   CHATT — ett gemensamt rum
   =====================================================================

   Kör hela filen i Supabase SQL Editor. Ingenting här raderar data utom
   städfunktionen, och den rör bara meddelanden äldre än sju dygn.

   !! VARNING — KÖR INTE OM DEN HÄR FILEN EFTER chatt-omrade.sql !!
   Den här filen gör drop view + create view chatt_flode UTAN kolumnen
   omrade. chatt-omrade.sql lägger till den. En omkörning här efteråt tar
   bort kolumnen igen — klientens omrade=in.(...)-filter träffar då en
   kolumn som inte finns, PostgREST svarar 400 och chatten är död för alla
   tills chatt-omrade.sql körs om. Ändra här → kör chatt-omrade.sql efteråt.
   (Granskningsfynd 2026-09-05, före lansering.)

   Beroenden: anvandarnamn.sql bör vara körd (tabellen public.usernames
   används för att hämta smeknamn). Är den inte det fungerar chatten ändå
   — alla får då sitt neutrala namn. schema.sql behöver inte vara körd.

   ---------------------------------------------------------------------
   Modellen, kort:

     chatt_meddelanden   raderna. Ingen klient läser den direkt.
     chatt_flode         vyn appen läser. Saknar avsandare med flit.
     chatt_anmalningar   anmälningar. Ingen klient läser den alls.

   Varför en vy istället för att läsa tabellen? För att avsandare är
   samma uuid som auth.uid(), och det id:t används på flera andra ställen
   i appen (reporter_scores.device_id, rapporternas device_id). Hela
   dolj-enhets-id.sql finns för att INTE lämna ut det. Skulle chatten
   publicera samma uuid vore det arbetet ogjort — varje meddelande blir
   då en koppling mellan en person i topplistan och allt hen skrivit.

   Klienten behöver ändå kunna skilja avsändare åt för att kunna tysta
   någon lokalt. Den får därför en härledd nyckel, samma för samma
   person men inte bakvägen till kontot.
   ===================================================================== */

begin;

/* ===================== Hjälpfunktioner: namn ========================= */

/**
 * FNV-1a, 32 bitar.
 *
 * Exakt samma funktion finns i js/chatt.js. Poängen är att klienten och
 * servern ska räkna fram SAMMA neutrala namn: bubblan man just skrev ska
 * inte byta namn när den kommer tillbaka från servern en sekund senare.
 * Det är inte kosmetik — ett namn som hoppar får en att tro att någon
 * annan skrev det.
 */
create or replace function public.chatt_fnv1a(p_text text)
returns bigint
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  h bigint := 2166136261;
  b bytea  := convert_to(coalesce(p_text, ''), 'UTF8');
  i int;
begin
  for i in 0 .. length(b) - 1 loop
    h := h # get_byte(b, i);
    h := (h * 16777619) % 4294967296;
  end loop;
  return h;
end $$;

/**
 * Vilket namn ska stå på meddelandet?
 *
 * Ordningen är hela säkerheten i det här:
 *
 *   1. Har kontot ett registrerat användarnamn vinner det alltid. Namnet
 *      är redan unikt och redan knutet till kontot, och den som har det
 *      ska heta samma sak i chatten som på topplistan.
 *
 *   2. Annars det smeknamn klienten skickade med — men bara om det inte
 *      krockar med någon annans registrerade användarnamn. Utan den
 *      spärren kan vem som helst skriva som "elliot" och bli trodd. Ett
 *      registrerat namn är inte värt något om det går att låna.
 *
 *   3. Annars ett neutralt, stabilt namn ur konto-id:t.
 *
 * E-postadressen används aldrig, i något led. Den finns inte ens att
 * hämta här inne, och det är avsiktligt.
 */
create or replace function public.chatt_visningsnamn(p_uid uuid, p_onskat text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp as $$
declare
  v_namn  text;
  v_onsk  text := nullif(btrim(regexp_replace(coalesce(p_onskat, ''), '\s+', ' ', 'g')), '');
begin
  if p_uid is null then
    return 'Förare';
  end if;

  -- 1. Registrerat användarnamn.
  begin
    select u.username into v_namn
    from public.usernames u
    where u.user_id = p_uid;
  exception
    -- anvandarnamn.sql inte körd. Chatten ska inte falla för det.
    when undefined_table then v_namn := null;
  end;
  if v_namn is not null and v_namn <> '' then
    return left(v_namn, 20);
  end if;

  -- 2. Önskat smeknamn, om det inte är någon annans registrerade namn.
  if v_onsk is not null then
    v_onsk := left(v_onsk, 20);
    begin
      if exists (
        select 1 from public.usernames u
        where lower(u.username) = lower(v_onsk) and u.user_id <> p_uid
      ) then
        v_onsk := null;
      end if;
    exception
      when undefined_table then null;
    end;
    if v_onsk is not null then
      return v_onsk;
    end if;
  end if;

  -- 3. Neutralt och stabilt.
  return 'Förare ' || (1000 + (public.chatt_fnv1a(p_uid::text) % 9000))::text;
end $$;

/* ============== Nykterhetsspärren, på databassidan =================== */
/*
 * Nykterhets- och drogkontroller sprids inte i Polisvakt. Att varna för
 * en fartkamera hjälper någon att hålla hastigheten; att varna för en
 * nykterhetskontroll hjälper någon att köra vidare full.
 *
 * Klienten stoppar det redan (js/chatt.js importerar isSobrietyCheck ur
 * js/parser.js). Den här kopian finns för att klienten inte är ett
 * skydd: PostgREST ligger öppet med anon-nyckeln, och en insert går att
 * skicka med curl. Regeln måste alltså finnas där raden faktiskt landar.
 *
 * VIKTIGT: ordlistorna nedan är en spegling av SOBRIETY_WORDS,
 * SOBRIETY_PREFIX och SOBRIETY_HEAD i js/parser.js. Ändras listan där
 * ska den ändras här. De kan inte delas — det ena är JavaScript i en
 * webbläsare, det andra är SQL i Postgres — men de får inte gå isär.
 */

/** Samma normalisering som normalize() i js/util.js. */
create or replace function public.chatt_normalisera(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(p_text, '')), '[^0-9a-z_åäöéèü\s-]', ' ', 'g'),
      '\s+', ' ', 'g'));
$$;

create or replace function public.chatt_ar_nykterhet(p_text text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_text text := public.chatt_normalisera(p_text);
  v_ord  text[];
  v_i    int;
  v_ord_lista text[] := array[
    'nykterhetskontroll', 'nykterhetskontroller', 'nykterhet', 'nykter',
    'alkoholkontroll', 'alkotest', 'alkoholtest', 'blåsa', 'blåser', 'blås',
    'utandningsprov', 'promillekontroll', 'rattfylla', 'rattfyllerikontroll',
    'sållningsprov', 'drogkontroll', 'drogtest',
    -- Narkotikaorden saknades. En granskning körde riktiga meningar genom
    -- kedjan och fem av nio drogkontroller blev polisrapporter. Håll synkad
    -- med SOBRIETY_WORDS i js/parser.js.
    'narkotikakontroll', 'narkotika', 'narko', 'droger', 'drogsök', 'drogsok',
    'drogsökhund', 'drogsokhund', 'blåsning',
    -- Hopskrivet förled + huvudord. De behövs eftersom särskrivningsregeln
    -- längst ner bara ser två ord bredvid varandra, och de här skrivsätten
    -- blev annars rapporter på kartan: 'razzia', 'polis' och 'piket' är
    -- TYPORD i js/parser.js, så "Drograzzia vid Erikslund" tolkades som en
    -- trafikkontroll med notis. 'nyckter' är den vanliga felstavningen av
    -- 'nykter' och är inget svenskt ord — den kostar ingenting.
    'drograzzia', 'drogpolis', 'drogpiket', 'droghund', 'nyckter'
  ];
  /*
   * Svenskan skrivs ihop, men folk särskriver ständigt. "Alkohol kontroll
   * vid rondellen" är samma sak som "alkoholkontroll" — bara det ena
   * ordet stod i listan ovan, och den isärskrivna varianten gick rakt
   * igenom. Regeln fanns, den var bara lättare att gå runt än den såg ut.
   */
  v_forled text[] := array[
    'alkohol', 'alko', 'nykterhets', 'nykterhet', 'promille', 'rattfylleri',
    'rattfylla', 'drog', 'droger', 'utandnings', 'sållnings', 'sallnings',
    'narkotika', 'narko'
  ];
  -- Samma huvudord som SOBRIETY_HEAD i js/parser.js. Reglerna finns i
  -- praktiken bara för förledet "drog" (alla andra förled är också stammar),
  -- och frågan är alltså vilket ord efter "drog" som gör det till en
  -- drogkontroll. razzia, polis och piket står dessutom som TYPORD i parsern:
  -- utan dem här blir "drog razzia" en publicerad trafikkontroll.
  v_huvud text[] := array[
    'kontroll', 'kontroller', 'test', 'prov', 'kollar', 'koll',
    'razzia', 'sök', 'sok', 'hund', 'polis', 'poliser', 'piket'
  ];
begin
  if v_text = '' then
    return false;
  end if;

  -- Delsträngsmatchning, precis som klienten gör. Den fångar både hela
  -- ord och sammansättningar ("poliserna_har_drogtest_idag").
  for v_i in 1 .. array_length(v_ord_lista, 1) loop
    if strpos(v_text, v_ord_lista[v_i]) > 0 then
      return true;
    end if;
  end loop;

  /*
   * Dela även på bindestreck, inte bara blanksteg.
   *
   * chatt_normalisera behåller bindestreck med flit (gatunamn), men det
   * gjorde att "drog-kontroll" blev ETT ord: ordlistan matchade det inte,
   * och isärskrivningsregeln nedan hittade inget att ställa bredvid. Ett
   * enda bindestreck gick alltså igenom båda spärrarna samtidigt.
   */
  v_ord := regexp_split_to_array(v_text, '[ \-/._]+');
  if array_length(v_ord, 1) is null then
    return false;
  end if;

  -- Och samma text helt utan skiljetecken, så ordlistan ovan också ser
  -- "drog-kontroll" som "drogkontroll".
  if strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'drogkontroll') > 0
     or strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'narkotikakontroll') > 0
     or strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'alkoholkontroll') > 0
     or strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'nykterhetskontroll') > 0 then
    return true;
  end if;
  for v_i in 1 .. array_length(v_ord, 1) - 1 loop
    if v_ord[v_i] = any(v_forled) and v_ord[v_i + 1] = any(v_huvud) then
      return true;
    end if;
  end loop;

  return false;
end $$;

/* ========================== Meddelandena ============================= */

create table if not exists public.chatt_meddelanden (
  id           text primary key,
  avsandare    uuid not null references auth.users(id) on delete cascade,
  text         text not null,
  -- Inget default. Namnet sätts av triggern nedan, och den kör före
  -- NOT NULL-kontrollen. Ett default hade lagt sig i vägen: triggern hade
  -- då fått "Förare" istället för ingenting och trott att klienten önskat
  -- just det namnet, så det neutrala namnet aldrig räknats fram.
  visningsnamn text not null,
  skapad_at    timestamptz not null default now()
);

/*
 * Index på tiden, fallande.
 *
 * Appen ställer exakt en fråga: "de senaste hundra, nyast först". Utan
 * det här indexet blir varje pollning en full genomsökning av tabellen,
 * och pollningar är det enda som händer hela tiden.
 */
create index if not exists chatt_meddelanden_tid_idx
  on public.chatt_meddelanden (skapad_at desc);

/*
 * Index på (avsändare, tid).
 *
 * Skrivbromsen nedan räknar hur många rader en och samma person skrivit
 * den senaste minuten, vid VARJE insert. Utan det här indexet växer
 * kostnaden för att skriva med hela tabellens storlek — alltså blir
 * bromsen dyrare ju mer trafik det finns, precis när den behövs som mest.
 */
create index if not exists chatt_meddelanden_avsandare_idx
  on public.chatt_meddelanden (avsandare, skapad_at desc);

/* ---------------------------- Reglerna ------------------------------- */

alter table public.chatt_meddelanden
  drop constraint if exists chatt_text_rimlig;
alter table public.chatt_meddelanden
  add constraint chatt_text_rimlig check (
    length(btrim(chatt_meddelanden.text)) between 1 and 400
    and length(chatt_meddelanden.visningsnamn) between 1 and 20
  );

/*
 * Nykterhetsspärren som CHECK, inte som trigger.
 *
 * En CHECK är deklarativ och går inte att kringgå av misstag: den gäller
 * insert och update, den syns i schemat, och den kan inte stängas av av
 * en session som råkar ha rättigheter. Namnet är valt så klienten kan
 * känna igen det i felmeddelandet från PostgREST och visa rätt svenska
 * förklaring istället för ett databasfel.
 */
alter table public.chatt_meddelanden
  drop constraint if exists chatt_nykterhet;
alter table public.chatt_meddelanden
  add constraint chatt_nykterhet
  check (not public.chatt_ar_nykterhet(chatt_meddelanden.text));

/* -------------------- Skrivbroms och namnsättning -------------------- */
/*
 * Klienten har egna gränser (5 s mellan meddelanden, 5 per minut). De
 * finns för att ge snabb och begriplig återkoppling. De HÄR gränserna är
 * väggen, och de är medvetet något lösare: en klocka som går några
 * sekunder fel ska inte ge avslag på ett meddelande som klienten just
 * släppte igenom.
 */
create or replace function public.chatt_innan_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_uid     uuid := auth.uid();
  v_senaste timestamptz;
  v_minut   int;
  v_timme   int;
begin
  if v_uid is null then
    raise exception 'chatt_inte_inloggad: bara inloggade kan skriva i chatten';
  end if;

  -- Avsändaren och tiden bestäms här, aldrig av klienten. Annars går det
  -- att skriva i någon annans namn eller backdatera sig förbi bromsen.
  new.avsandare := v_uid;
  new.skapad_at := now();

  select max(skapad_at) into v_senaste
  from public.chatt_meddelanden where avsandare = v_uid;

  if v_senaste is not null and v_senaste > now() - interval '3 seconds' then
    raise exception 'chatt_for_snabbt: vänta några sekunder mellan meddelandena';
  end if;

  select count(*) into v_minut
  from public.chatt_meddelanden
  where avsandare = v_uid and skapad_at > now() - interval '1 minute';
  if v_minut >= 8 then
    raise exception 'chatt_for_manga: för många meddelanden på kort tid';
  end if;

  select count(*) into v_timme
  from public.chatt_meddelanden
  where avsandare = v_uid and skapad_at > now() - interval '1 hour';
  if v_timme >= 100 then
    raise exception 'chatt_for_manga: för många meddelanden den senaste timmen';
  end if;

  new.visningsnamn := public.chatt_visningsnamn(v_uid, new.visningsnamn);

  /*
   * Städa lite, ibland.
   *
   * Gallringen borde ligga i pg_cron, och gör det längre ner om
   * tillägget finns. Men den får inte VARA beroende av det: på ett
   * projekt utan pg_cron skulle tabellen då växa för alltid, och sju
   * dygn är ett löfte till användarna om att det de skriver försvinner.
   *
   * Två procent av alla inserts betalar notan. Vid all rimlig trafik
   * betyder det flera städningar i timmen, och vid noll trafik finns
   * det inget att städa.
   */
  if random() < 0.02 then
    perform public.chatt_stada();
  end if;

  return new;
end $$;

/**
 * Bort med allt äldre än sju dygn.
 *
 * Chatten är färskvara. Ett meddelande om att det står en polis vid
 * Erikslund är värdelöst efter en timme och obehagligt efter ett år —
 * det är fortfarande en logg över var någon befann sig och när. Det
 * bästa sättet att inte läcka den loggen är att inte ha den.
 */
create or replace function public.chatt_stada()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare v_antal int;
begin
  delete from public.chatt_meddelanden where skapad_at < now() - interval '7 days';
  get diagnostics v_antal = row_count;
  return v_antal;
end $$;

drop trigger if exists chatt_innan_insert_trg on public.chatt_meddelanden;
create trigger chatt_innan_insert_trg
  before insert on public.chatt_meddelanden
  for each row execute function public.chatt_innan_insert();

/* ------------------------------- RLS --------------------------------- */

alter table public.chatt_meddelanden enable row level security;

/*
 * LÄSA: bara inloggade.
 *
 * Rapporterna är publika med flit — en varning gör nytta även för den som
 * aldrig registrerat sig. Chatten är något annat: fritext som folk
 * skriver till varandra. Att den ligger öppen för vem som helst med
 * anon-nyckeln vore att publicera den, och ingen skriver i en chatt som
 * i praktiken är ett anslag på nätet.
 */
drop policy if exists chatt_las on public.chatt_meddelanden;
create policy chatt_las on public.chatt_meddelanden
  for select to authenticated
  using (true);

/*
 * SKRIVA: bara som sig själv.
 *
 * with check jämför raden mot auth.uid(), som kommer ur JWT:n och inte
 * går att sätta av klienten. Triggern skriver visserligen över avsandare
 * ändå, men policyn ska hålla på egen hand — ett skydd som förutsätter
 * att ett annat skydd finns kvar är inget skydd.
 */
drop policy if exists chatt_skriv on public.chatt_meddelanden;
create policy chatt_skriv on public.chatt_meddelanden
  for insert to authenticated
  with check (avsandare = auth.uid());

/*
 * RADERA: bara sitt eget.
 *
 * Ingen UPDATE-policy finns, och det är avsiktligt. Kunde man ändra ett
 * meddelande i efterhand skulle ett samtal gå att skriva om — någon
 * svarar "ja" på en fråga som sedan byts ut. Ta bort och skriv nytt
 * istället; då syns det att något hänt.
 */
drop policy if exists chatt_radera on public.chatt_meddelanden;
create policy chatt_radera on public.chatt_meddelanden
  for delete to authenticated
  using (avsandare = auth.uid());

/* ------------------------------- Vyn --------------------------------- */
/*
 * Appen läser bara den här. Den körs med ägarens rättigheter (INTE
 * security_invoker), av två skäl:
 *
 *   - Klienten ska inte ha select-rätt på kolumnen avsandare. Med
 *     security_invoker hade den behövt det, eftersom vyn räknar på
 *     kolumnen — och då hade den kunnat läsa den direkt från tabellen
 *     istället, vilket är precis det vi undviker.
 *   - Inloggningskravet ligger då i vyn själv: raden nedan med
 *     auth.uid() is not null. Utan den vore vyn öppen för anon.
 *
 * mitt beräknas här på servern. Klienten ska inte behöva känna till sitt
 * eget uuid för att veta vilka bubblor som är dess egna, och gränssnittet
 * ska inte gissa.
 */
-- drop före create: create or replace view vägrar om kolumnlistan ändras,
-- och då kan filen inte köras om efter en ändring här.
drop view if exists public.chatt_flode;

create view public.chatt_flode as
  select
    m.id,
    m.skapad_at,
    m.text,
    m.visningsnamn,
    md5(m.avsandare::text || 'polisvakt-chatt-v1') as avsandarnyckel,
    (m.avsandare = auth.uid())                     as mitt
  from public.chatt_meddelanden m
  where auth.uid() is not null;

/* =========================== Anmälningar ============================= */

create table if not exists public.chatt_anmalningar (
  meddelande_id text not null,
  anmalare      uuid not null references auth.users(id) on delete cascade,
  skal          text default '',
  anmald_at     timestamptz not null default now(),
  primary key (meddelande_id, anmalare)
);

/*
 * Ingen främmande nyckel mot meddelandet.
 *
 * Anmälan ska överleva att raden försvinner — det vanligaste sättet att
 * hantera ett anmält meddelande är just att det raderas, och då är
 * anmälan det enda som är kvar att titta på i efterhand.
 */

alter table public.chatt_anmalningar enable row level security;

/*
 * Anmäla får man, men ingen får läsa anmälningar.
 *
 * En läsbar anmälningstabell blir en anslagstavla: vem anmälde vem, och
 * hur ofta. Det är precis den sortens information som får folk att
 * anmäla varandra tillbaka. Bara service role (Supabase-panelen) kommer
 * åt innehållet.
 */
drop policy if exists chatt_anmal on public.chatt_anmalningar;
create policy chatt_anmal on public.chatt_anmalningar
  for insert to authenticated
  with check (anmalare = auth.uid() and length(coalesce(skal, '')) <= 200);

/* =========================== Rättigheter ============================= */
/*
 * RLS avgör VILKA RADER man får röra. GRANT avgör om man får röra
 * tabellen alls. Båda behövs — glöms grantet får man "permission denied"
 * trots perfekta policyer, och glöms policyn får man noll rader trots
 * perfekt grant.
 */

revoke all on public.chatt_meddelanden from anon, authenticated;
revoke all on public.chatt_anmalningar from anon, authenticated;
revoke all on public.chatt_flode       from anon, authenticated;

/*
 * Select bara på id, inte på hela tabellen.
 *
 * PostgREST behöver select-rätt på id för att kunna göra
 * DELETE ?id=eq.… Men vi vill inte ge select på avsandare — då kunde
 * appen kringgå vyn och läsa ut kopplingen konto -> meddelande.
 */
grant select (id)              on public.chatt_meddelanden to authenticated;
grant insert                   on public.chatt_meddelanden to authenticated;
grant delete                   on public.chatt_meddelanden to authenticated;
grant select                   on public.chatt_flode       to authenticated;
grant insert                   on public.chatt_anmalningar to authenticated;

/*
 * Funktioner tilldelas PUBLIC automatiskt i Postgres. Att bara låta bli
 * att grant:a räcker alltså inte — den underförstådda rättigheten ligger
 * kvar. Ta bort allt först, dela sedan ut det som faktiskt ska gå att
 * anropa utifrån (ingenting: allt körs av triggern och vyn).
 */
revoke all on function public.chatt_fnv1a(text)              from public;
revoke all on function public.chatt_normalisera(text)        from public;
revoke all on function public.chatt_ar_nykterhet(text)       from public;
revoke all on function public.chatt_visningsnamn(uuid, text) from public;
revoke all on function public.chatt_innan_insert()           from public;
revoke all on function public.chatt_stada()                  from public;

/*
 * Två undantag, och de är nödvändiga.
 *
 * En CHECK-villkorsfunktion körs som den som gör insertet, och Postgres
 * kontrollerar EXECUTE-rätten då. Utan de här två raderna avvisas VARJE
 * meddelande med "permission denied for function chatt_ar_nykterhet" —
 * chatten hade varit helt tyst, av rätt skäl fast fel orsak.
 *
 * Att lämna ut dem kostar ingenting: de svarar bara ja eller nej om en
 * textsträng, och svaret är samma regel som klienten redan tillämpar.
 */
grant execute on function public.chatt_normalisera(text)  to authenticated;
grant execute on function public.chatt_ar_nykterhet(text) to authenticated;

commit;

/* ===================== Schemalagd städning =========================== */
/*
 * Ligger utanför transaktionen och i ett DO-block med felfångst: pg_cron
 * finns inte på alla Supabase-projekt, och filen ska gå att köra ändå.
 * Saknas tillägget städar triggern istället (se chatt_innan_insert).
 */
do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.unschedule('polisvakt-chatt-stada');
  end if;
exception when others then
  null;
end $$;

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.schedule('polisvakt-chatt-stada', '17 3 * * *',
                          'select public.chatt_stada();');
    raise notice 'Chattstädning schemalagd via pg_cron, 03:17 varje natt.';
  else
    raise notice 'pg_cron saknas. Städningen sköts av insert-triggern istället.';
  end if;
exception when others then
  raise notice 'Kunde inte schemalägga städningen (%). Triggern städar ändå.', sqlerrm;
end $$;

/* ============================ Kontroll ===============================

   Kör de här efteråt för att se att det blev rätt.

   1. Spärren mot nykterhetsinnehåll — ska ge true på alla fyra:

        select public.chatt_ar_nykterhet('nykterhetskontroll vid Bäckby'),
               public.chatt_ar_nykterhet('alkohol kontroll vid rondellen'),
               public.chatt_ar_nykterhet('de har drogtest på Vasagatan'),
               public.chatt_ar_nykterhet('DROG KOLL nu');

      Och false på en vanlig rad:

        select public.chatt_ar_nykterhet('polis vid Erikslund, står kvar');

   2. Policyerna — ska ge tre rader (select, insert, delete):

        select policyname, cmd from pg_policies
        where tablename = 'chatt_meddelanden';

      Finns det en update-rad är något fel. Ingen får ändra ett skickat
      meddelande, inte ens sitt eget.

   3. Vyn ska inte lämna ut avsandare:

        select column_name from information_schema.columns
        where table_name = 'chatt_flode';

      Ska ge: id, skapad_at, text, visningsnamn, avsandarnyckel, mitt.

   4. Städningen går att köra för hand:

        select public.chatt_stada();

   ===================================================================== */
