-- Migration: bryggan gav rapporter men aldrig en notis.
--
-- Kör hela filen i Supabase SQL Editor på en databas där supabase/fbmejl.sql
-- redan är körd. Den ersätter två funktioner, lägger till fyra nya och en vy.
-- Ingen tabell ändras, ingen rad raderas, ingen rapport rörs.
--
-- ---------------------------------------------------------------------
-- FELET
--
-- Kedjan "någon skriver i Facebook-gruppen -> notis på mobilen" var bruten i
-- mitten. Bryggan (tools/fb-bridge.user.js och tools/brygg-daemon.ps1) skrev
-- rakt in i reports över PostgREST. Rapporten hamnade på kartan, varje led
-- svarade 201, och telefonen var tyst — för allt som får en telefon att ringa
-- sitter i fbmejl_notis_ut(), som bara anropas från fbmejl_ta_emot().
-- Bryggan gick förbi avdubblingen, nykterhetsnätet, takten och notisen på en
-- gång.
--
-- Exakt det felmönster som redan bitit det här projektet tre gånger: varje
-- led grönt, total effekt noll.
--
-- ---------------------------------------------------------------------
-- VALET: bryggan anropar fbmejl_ta_emot(), och ingen andra notisväg byggs
--
-- Två utvägar fanns.
--
--   1. Anroparen anropar fbmejl_ta_emot() i stället för att skriva rått. Hela
--      den testade kedjan återanvänds och det finns fortfarande BARA EN väg
--      från "någon skrev i gruppen" till "en telefon ringer". Priset är att
--      anroparen måste bära service_role-nyckeln.
--
--   2. En trigger på reports. Fångar varje väg in automatiskt, men faller på
--      tre saker: den ser en rad i taget (daemonen gör en insert per inlägg,
--      alltså en notis per rapport — precis det buntspärren finns för att
--      förhindra); att bunta i stället kräver kötabell plus cron-jobb, alltså
--      en ANDRA notisväg med egen timing som glider från den här; och den
--      skulle köra nykterhetsnätet på rader appens knappar och rösten skapat,
--      ett nät som är MEDVETET bredare än parsern och som därför skulle börja
--      avvisa förares egna rapporter.
--
-- Alternativ 1 gäller. Motiveringen står också i koden, ovanför
-- fbmejl_ta_emot() i supabase/fbmejl.sql, så att valet inte behöver fattas om.
--
-- Servernyckeln går för en daemon på ägarens egen maskin (gitignorerad fil,
-- precis som IMAP-lösenordet redan ligger). Den går INTE för ett userscript
-- inne på facebook.com — en servernyckel i en sida Meta kontrollerar är samma
-- sak som ingen nyckel alls. Userscriptet fortsätter alltså skriva till
-- reports och ger karta utan notis, tills daemonen tagit över. Vyn
-- fbmejl_notiskedjan längst ner säger vilket läge som gäller just nu.
--
-- ---------------------------------------------------------------------
-- VAD FILEN GÖR
--
--   fbmejl_utrustning()   NY. 'laser', 'radar', 'fart' eller null ur en text.
--   fbmejl_typtext()      NY. Typnamnet med utrustningen inbakad.
--   fbmejl_platsfras()    NY. " vid Hälla", " på E18" eller ", plats okänd".
--   fbmejl_mening()       NY. Hela sammanfattningsmeningen, i tre delar.
--   fbmejl_notis_ut()     ERSATT. Notisen bär nu meningen, inte fyra fakta.
--   fbmejl_ta_emot()      ERSATT. Skickar med NÄR och utrustning till notisen.
--   fbmejl_notiskedjan    NY VY. Skriver någon fortfarande förbi kedjan?
--
-- Takten är ORÖRD och gäller: en notis per omgång, minst tio minuter emellan,
-- tyst 23–06 svensk tid, högst tolv per dygn. Nykterhets- och drogkontroller
-- ger varken rapport eller notis — nätet är orört, och kontroll 1 längst ner
-- kör riktiga meningar genom det.
--
-- Filen är säker att köra om. Alla create är "create or replace", vyn droppas
-- och skapas, och ingen data rörs.
--
-- ---------------------------------------------------------------------
-- Om formen: noll blockkommentarer i hela filen, med flit. En stjärna följd
-- av snedstreck avslutar en blockkommentar mitt i raden, och ett cron-uttryck
-- inuti en sådan har redan dödat en körning i det här projektet en gång.

do $vakt$
begin
  if to_regproc('public.fbmejl_notis_ut') is null
     or to_regproc('public.fbmejl_ta_emot') is null
     or to_regclass('public.fbmejl_lasta') is null then
    raise exception 'Kör supabase/fbmejl.sql först — fbmejl_ta_emot, fbmejl_notis_ut eller fbmejl_lasta saknas.';
  end if;
end $vakt$;

begin;

-- ============================ NOTISER: MENINGEN ======================
--
-- Notisen ska bära samma mening som appen visar, inte fyra fakta bredvid
-- varandra.
--
-- js/sammanfattning.js gör redan det jobbet på klienten: "Fartkontroll med
-- laser vid Hälla — någon i Facebook-gruppen varnade för 2 minuter sedan."
-- Fyra saker måste alltid vara med: VAD, VAR, NÄR och VARIFRÅN. Utan NÄR och
-- VARIFRÅN är en varning inte något föraren kan handla på, och utan VARIFRÅN
-- ser gruppens andrahandsuppgift ut som en officiell uppgift.
--
-- Varför meningen byggs på SERVERN och inte i klienten, trots att koden redan
-- finns där: push-lyssnaren i sw.js får en färdig titel och en färdig
-- brödtext och ritar dem. Den kan inte formulera något — en service worker
-- som skulle importera sammanfattning.js hade dragit in parser.js, util.js
-- och store.js i en modulkontext som sw.js inte kör i, och kedjan hade blivit
-- längre och skörare på det enda ställe där den absolut inte får vara det.
-- De två ställena möts i stället i FORMEN: samma ord, samma ordning, samma
-- åldersfraser. Kontroll 2 längst ner visar dem ordagrant.
--
-- Fördelningen mellan titel och brödtext följer meningens eget snitt:
--
--   rubrik  "Fartkontroll med laser vid Hälla"        -> notisens titel
--   svans   "Någon i Facebook-gruppen varnade för
--            2 minuter sedan. Kan ha flyttat på sig." -> notisens brödtext
--   mening  rubrik + tankstreck + svans, gemen        -> loggen, revisionen
--
-- DET SOM ALDRIG FÅR HÄNDA: inläggets råtext på en låsskärm. Platsen är
-- geokodningens etikett, typen är en av fyra kända strängar, och det enda som
-- härleds ur inläggstexten är fbmejl_utrustning() — som bara kan svara med
-- ett av tre fasta ord. Ingen teckensekvens ur ett Facebook-inlägg kan ta sig
-- igenom den funktionen. Kontroll 3 provar det.

create or replace function public.fbmejl_utrustning(p_text text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare v_t text;
begin
  -- Samma orduppdelning som klienten: allt som inte är en bokstav eller en
  -- siffra skiljer ord. Då fångas "laser-kontroll" och "laserkontroll" lika.
  v_t := ' ' || regexp_replace(lower(coalesce(p_text, '')), '[^0-9a-zåäöéèü]+', ' ', 'g');
  if v_t ~ ' laser'  then return 'laser'; end if;
  if v_t ~ ' radar'  then return 'radar'; end if;
  if v_t ~ ' (fartkontroll|hastighetskontroll|fartkoll|fartkamera)' then return 'fart'; end if;
  return null;
end $$;

-- Typen i klartext, med utrustningen inbakad när den är känd.
--
-- Bygger på fbmejl_typnamn() med flit: typordlistan ska finnas på ETT
-- ställe. Den här funktionen lägger bara till de tre preciseringar som
-- js/sammanfattning.js gör, och bara för trafikkontroller.
create or replace function public.fbmejl_typtext(p_typ text, p_utrustning text default null)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when p_typ = 'control' and p_utrustning = 'laser' then 'Fartkontroll med laser'
    when p_typ = 'control' and p_utrustning = 'radar' then 'Fartkontroll med radar'
    when p_typ = 'control' and p_utrustning = 'fart'  then 'Fartkontroll'
    else public.fbmejl_typnamn(p_typ)
  end;
$$;

-- Platsfrasen, med ledande mellanslag när det finns en plats.
--
-- Tre utfall, ordagrant som platsFras() i js/sammanfattning.js, och det
-- tredje är det som brukar glömmas: ingen plats alls. Då sägs det rakt ut.
-- En mening som bara utelämnar platsen låter som om den hade en.
--
-- Två listor följer med från klienten:
--   tomma etiketter   "-", "okänd", "null" — text som ser ut att vara en
--                     plats men inte är det.
--   inte en plats     etiketter som bara upprepar typen. "Polis vid Polis"
--                     är ingen upplysning.
-- Och prepositionslistan, som hindrar "vid på E18" och "vid vid Hälla".
create or replace function public.fbmejl_platsfras(p_plats text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_etikett text;
  v_norm    text;
  v_forsta  text;
begin
  v_etikett := btrim(regexp_replace(coalesce(p_plats, ''), '[[:space:]]+', ' ', 'g'));

  v_norm := lower(v_etikett);
  v_norm := regexp_replace(v_norm, '[^0-9a-zåäöéèü_[:space:]-]+', ' ', 'g');
  v_norm := btrim(regexp_replace(v_norm, '[[:space:]]+', ' ', 'g'));

  if v_norm = any (array[
       '', '-', 'okänd', 'okand', 'okänt', 'okant', 'null', 'undefined',
       'plats okänd']) then
    return ', plats okänd';
  end if;

  if v_norm = any (array[
       'polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
       'kontroll', 'trafikkontroll', 'fartkontroll', 'hastighetskontroll',
       'poliskontroll', 'civil', 'civilbil', 'civilpolis', 'kamera',
       'fartkamera', 'varning']) then
    return ', plats okänd';
  end if;

  v_forsta := split_part(v_norm, ' ', 1);
  if v_forsta = any (array[
       'vid', 'på', 'pa', 'i', 'utanför', 'utanfor', 'mot', 'längs', 'langs',
       'nära', 'nara', 'runt', 'kring', 'mellan', 'efter', 'före', 'fore',
       'under', 'över', 'over', 'norr', 'söder', 'soder', 'öster', 'oster',
       'väster', 'vaster', 'strax']) then
    return ' ' || v_etikett;
  end if;

  return ' vid ' || v_etikett;
end $$;

-- Hela meningen, i tre delar.
--
-- Åldersfraserna och aktualitetsförbehållen är ordagrant desamma som
-- alderDelar() och aktualitet() i js/sammanfattning.js, inklusive gränserna:
-- en minut, en timme, ett dygn. Livslängderna är samma tal som TTL_MINUTES i
-- js/store.js — polis 45, kontroll 60, civil 30 — och det är de som gör att
-- en civil polisbil låter gammal tidigare än en trafikkontroll. Den förra
-- flyttar sig, den senare står kvar och bygger kö.
--
-- Tvåminuterstoleransen för framtida stämplar finns av samma skäl som i
-- klienten: en klocka som går fel ska ge "vid en tidpunkt som inte går att
-- lita på", inte "om 20 minuter".
--
-- @param p_created_at millisekunder sedan epoch, som i reports.created_at
create or replace function public.fbmejl_mening(
  p_typ        text,
  p_utrustning text,
  p_plats      text,
  p_created_at bigint default null
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp as $$
declare
  v_nu     bigint := (extract(epoch from now()) * 1000)::bigint;
  v_ms     bigint;
  v_min    bigint;
  v_ttl    int;
  v_okand  boolean := false;
  v_nar    text;
  v_akt    text := '';
  v_rubrik text;
  v_svans  text;
begin
  v_rubrik := public.fbmejl_typtext(p_typ, p_utrustning) || public.fbmejl_platsfras(p_plats);

  if p_created_at is null or p_created_at <= 0 then
    v_okand := true;
    v_nar := 'vid okänd tidpunkt';
  else
    v_ms := v_nu - p_created_at;
    if v_ms < -120000 then
      v_okand := true;
      v_nar := 'vid en tidpunkt som inte går att lita på';
    else
      v_min := greatest(0, v_ms / 60000);
      if    v_min = 0     then v_nar := 'just nu';
      elsif v_min = 1     then v_nar := 'för en minut sedan';
      elsif v_min < 60    then v_nar := 'för ' || v_min || ' minuter sedan';
      elsif v_min < 90    then v_nar := 'för ungefär en timme sedan';
      elsif v_min < 1440  then v_nar := 'för ' || round(v_min / 60.0) || ' timmar sedan';
      elsif v_min < 2880  then v_nar := 'för mer än ett dygn sedan';
      else                     v_nar := 'för ' || round(v_min / 1440.0) || ' dagar sedan';
      end if;
    end if;
  end if;

  if not v_okand then
    v_ttl := case p_typ
               when 'police'   then 45
               when 'control'  then 60
               when 'unmarked' then 30
               when 'camera'   then 525600
               else 45
             end;
    if v_min >= v_ttl then
      v_akt := ' Troligen inte kvar.';
    elsif v_min::numeric / v_ttl >= 0.5 then
      v_akt := ' Kan ha flyttat på sig.';
    end if;
  end if;

  -- Versalen står här och inte i ett upper(): brödtexten börjar en mening,
  -- den fullständiga meningen gör det inte. Två fasta strängar är säkrare än
  -- en teckenoperation som beter sig olika beroende på databasens kollation.
  v_svans := 'Någon i Facebook-gruppen varnade ' || v_nar || '.' || v_akt;

  return jsonb_build_object(
    'rubrik', v_rubrik,
    'svans',  v_svans,
    'mening', v_rubrik || ' — någon i Facebook-gruppen varnade ' || v_nar || '.' || v_akt,
    'nar',    v_nar
  );
end $$;

-- ============================ NOTISER: UTSKICKET =====================
--
-- Samma signatur, samma spärrar, samma ordning som förut. Det enda som
-- ändrats är texten som byggs: rubrik och svans ur fbmejl_mening() i stället
-- för typnamn plus en rad platsnamn. Buntspärren, glesspärren, nattspärren
-- och dygnstaket är orörda, och tillståndet skrivs fortfarande FÖRST när
-- anropet är köat hos pg_net.
--
-- Hela funktionen står här och inte bara den ändrade delen: plpgsql går inte
-- att lappa i bitar. Texten är ordagrant densamma som i supabase/fbmejl.sql.

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
set search_path = public, pg_temp as $$
declare
  v_antal    int;
  v_lage     public.fbmejl_notis_lage%rowtype;
  v_lokal    timestamptz := now();
  v_timme    int;
  v_dag      date;
  v_platser  text;
  v_mening   jsonb;
  v_titel    text;
  v_text     text;
  v_totalt   int;
  v_url      text;
  v_nyckel   text;
  v_skal     text;
  v_mottagare int;
  v_net_id   bigint;
begin
  if p_nya is null or jsonb_typeof(p_nya) <> 'array' then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  v_antal := jsonb_array_length(p_nya);
  if v_antal = 0 then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  -- Lyssnar någon?
  --
  -- Först av allt, och före spärrarna: har ingen slagit på gruppnotiser finns
  -- det inget att spärra. Tillståndet rörs INTE — varken senaste_at eller
  -- odelade. Att räkna upp odelade när ingen lyssnar hade betytt att den
  -- första som slår på notiser får "312 nya varningar i gruppen" som
  -- välkomsthälsning.
  v_mottagare := public.fbmejl_gruppnotis_antal();
  if coalesce(v_mottagare, 0) = 0 then
    insert into public.fbmejl_notis_logg (antal, utfall, skal)
    values (v_antal, 'ingen-mottagare', 'noll prenumeranter med gruppnotiser pa');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-mottagare',
                              'antal', v_antal, 'mottagare', 0);
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

  -- Rubrikerna, utan dubbletter, högst tre. Fler får inte plats i en notis
  -- och gör den svårare att läsa på en låsskärm i en bil.
  --
  -- Förut stod bara platsnamnen här — "Erikslund · E18 · Hälla". Tre platser
  -- utan att säga VAD som står där är tre frågor, inte tre besked. Nu står
  -- typen med, byggd av fbmejl_mening() precis som den enskilda notisen.
  select string_agg(q.r, ' · ' order by q.r) into v_platser
    from (
      select distinct on (lower(d.rubrik)) d.rubrik as r
        from (
          select public.fbmejl_mening(x.typ, x.utrustning, x.plats, x.created_at) ->> 'rubrik'
                   as rubrik
            from jsonb_to_recordset(p_nya)
                 as x(typ text, plats text, utrustning text, created_at bigint)
        ) d
       where coalesce(d.rubrik, '') <> ''
       order by lower(d.rubrik)
       limit 3
    ) q;

  if v_totalt = 1 then
    -- En enda varning: hela sammanfattningsmeningen, delad vid sitt eget
    -- tankstreck. Titeln säger VAD och VAR, brödtexten NÄR och VARIFRÅN.
    -- Det är samma mening som js/sammanfattning.js visar i appen — se
    -- avsnittet NOTISER: MENINGEN ovan.
    select public.fbmejl_mening(x.typ, x.utrustning, x.plats, x.created_at)
      into v_mening
      from jsonb_to_recordset(p_nya)
           as x(typ text, plats text, utrustning text, created_at bigint)
     limit 1;
    v_titel := left(coalesce(v_mening->>'rubrik', 'Ny varning i gruppen'), 80);
    v_text  := left(coalesce(v_mening->>'svans',
                             'Någon i Facebook-gruppen varnade. Öppna Polisvakt för att se var.'), 240);
  else
    v_titel := v_totalt || ' nya varningar i gruppen';
    v_text  := left(coalesce(v_platser, 'Öppna Polisvakt för att se var.'), 240);
  end if;

  -- Ut på nätet, om vägen dit finns. Saknas pg_net eller adressen loggas det
  -- som ett fel istället för att tyst försvinna — en notiskedja som ser frisk
  -- ut och inte når fram är den svåraste sortens fel, och den har den här
  -- appen redan haft en gång.
  --
  -- Observera att tillståndet inte är rört än. Varje väg ut härifrån som INTE
  -- lyckas köa anropet lägger tillbaka varningarna i odelade, precis som en
  -- spärr gör. Det är hela skillnaden mot den första versionen, där odelade
  -- nollställdes innan man visste om något ens gick att skicka.
  v_url    := current_setting('app.fbmejl_push_url', true);
  v_nyckel := current_setting('app.service_role_key', true);

  if v_url is null or v_url = '' then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'app.fbmejl_push_url saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'app.fbmejl_push_url saknas');
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
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'pg_net saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'pg_net saknas');
    return jsonb_build_object('skickad', false, 'skal', 'pg_net-saknas', 'titel', v_titel);
  end if;

  begin
    -- Id:t sparas. Det är den enda kopplingen mellan den här raden i loggen
    -- och pg_nets svar i net._http_response, och utan den går det inte att i
    -- efterhand svara på om notisen faktiskt togs emot av edge-funktionen.
    select net.http_post(
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
    ) into v_net_id;
  exception when others then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = left(sqlerrm, 500), uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', left(sqlerrm, 200));
    return jsonb_build_object('skickad', false, 'skal', 'fel', 'detalj', sqlerrm);
  end;

  -- Först här. Anropet ligger i pg_nets kö, glesspärren och dygnstaket får
  -- räknas upp, och odelade nollställs eftersom varningarna nu är med i den
  -- text som ligger på väg ut.
  update public.fbmejl_notis_lage
     set senaste_at = now(),
         antal_idag = v_lage.antal_idag + 1,
         dag = v_dag,
         odelade = 0,
         senaste_fel = null,
         uppdaterad = now()
   where id = 1;

  insert into public.fbmejl_notis_logg (antal, titel, text, utfall, net_id)
  values (v_totalt, v_titel, v_text, 'koad', v_net_id);

  -- 'koad', inte 'skickad', och nyckeln heter fortfarande skickad i svaret av
  -- bakåtkompatibilitet — men den betyder "köad hos pg_net", ingenting mer.
  -- Vad som hände sedan står i fbmejl_notis_stam_av().
  return jsonb_build_object('skickad', true, 'utfall', 'koad', 'antal', v_totalt,
                            'titel', v_titel, 'mottagare', v_mottagare,
                            'net_id', v_net_id);
end $$;


-- ============================ TA EMOT ================================
--
-- Samma signatur och samma logik som förut. Den enda ändringen är att listan
-- v_nya nu bär fyra fält i stället för två, så att notisen kan säga NÄR.
--
-- DEN ENDA VÄGEN IN. Kontraktet för en brygga är:
--
--   ETT anrop per svep, med alla nya rader i samma array. Inte ett anrop per
--   rad. Buntspärren ger EN notis per anrop, och fyra anrop i rad ger en
--   notis plus tre rader i odelade — alltså tre varningar som inte hörs
--   förrän tio minuter senare. Kedjan går inte sönder av det, men den blir
--   sämre, och det syns ingenstans.
--
-- Raderna får se ut precis som en reports-rad: id, type, lat, lon, label,
-- note, device_id, external_id, created_at, expires_at. source sätts här och
-- går inte att skicka med. Skickar anroparen dessutom text_nyckel (och
-- text_nyckel_grannar) fungerar den korsvisa avdubblingen mot mejlvägen och
-- Telegram-spegeln, så att samma inlägg som kommer två vägar blir EN nål.
-- Nyckeln räknas fram likadant överallt: se nycklarFor() i js/fbmejl.js.
--
-- Svaret bär 'skapade' och 'notis'. En brygga som loggar de två talen märker
-- samma dag om notiskedjan slutar fungera. Det gjorde ingen förut.

create or replace function public.fbmejl_ta_emot(p_rader jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_rad         jsonb;
  v_nyckel      text;
  v_text_nyckel text;
  v_text_nycklar text[];      -- huvudnyckeln plus grannfacken, se avdubblingen
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
    -- Genom normaliseringen, alltid. Kön lagrar den kanoniska formen, och det
    -- är den de fem update-satserna nedan måste matcha mot. Skickar en
    -- framtida anropare den råa formen med vinkelparenteser fungerar det ändå.
    v_msg_id      := public.fbmejl_normalisera_msgid(v_rad->>'message_id');
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
      insert into public.fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'vagrad', 'kamera')
      on conflict (nyckel) do nothing;
      update public.fbmejl_ko set status = 'vagrad', skal = 'kamera', avgjort_at = now()
       where message_id = v_msg_id;
      continue;
    end if;

    -- Textnyckelns grannfack räknas som samma text.
    --
    -- Nyckeln är 'tx:<hash>:<fack>' där facket är floor(nu / 3 timmar) -- ett
    -- FAST fack, inte ett glidande fönster. Två mejl med identisk text två
    -- minuter isär, men på var sin sida om en fackgräns, fick därför olika
    -- nycklar och blev två nålar på samma plats. Vid varje fackgräns, var
    -- tredje timme.
    --
    -- js/fbmejl.js skickar med grannfacken i text_nyckel_grannar just för
    -- det här. Saknas fältet faller vi tillbaka på enbart huvudnyckeln, så
    -- en äldre anropare fortsätter fungera.
    v_text_nycklar := array_remove(
      array[v_text_nyckel] || coalesce(
        (select array_agg(x) from jsonb_array_elements_text(
           case when jsonb_typeof(v_rad->'text_nyckel_grannar') = 'array'
                then v_rad->'text_nyckel_grannar' else '[]'::jsonb end) as t(x)),
        array[]::text[]),
      null);

    -- Avdubbling, tre frågor.
    perform 1 from public.fbmejl_lasta
     where nyckel = v_nyckel
        or (v_text_nyckel is not null and text_nyckel = any(v_text_nycklar));
    v_krock := found;

    -- Korsvis mot Telegram-spegeln, om den är installerad. Samma inlägg kan
    -- komma både speglat och mejlat, och då ska det bli EN varning. Kollen
    -- görs dynamiskt så att den här filen går att köra utan telegram.sql.
    if not v_krock and v_text_nyckel is not null
       and to_regclass('public.telegram_lasta') is not null then
      execute 'select exists (select 1 from public.telegram_lasta where text_nyckel = any($1))'
        into v_krock using v_text_nycklar;
    end if;

    if v_krock then
      v_dubbletter := v_dubbletter + 1;
      update public.fbmejl_ko set status = 'klar', skal = 'dubblett', avgjort_at = now()
       where message_id = v_msg_id;
      continue;
    end if;

    if public.fbmejl_ar_nykterhetskontroll(v_note) then
      v_vagrade := v_vagrade + 1;
      insert into public.fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'vagrad', 'nykterhet')
      on conflict (nyckel) do nothing;
      update public.fbmejl_ko set status = 'vagrad', skal = 'nykterhet', avgjort_at = now()
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
      -- Fyra fält, och bara fyra. Notisen ska bära sammanfattningsmeningen,
      -- och den kräver NÄR (created_at) utöver VAD och VAR.
      --
      -- utrustning är den enda beröringen mellan inläggets råtext och
      -- notisen, och den går genom fbmejl_utrustning() som bara kan svara
      -- 'laser', 'radar', 'fart' eller null. RÅTEXTEN SJÄLV SKICKAS INTE MED
      -- — se avsnittet NOTISER: TEXTEN. Skulle någon frestas lägga till
      -- 'note' här är det den ändringen som gör låsskärmen till en kanal där
      -- vem som helst i en Facebook-grupp skriver vad som helst.
      v_nya := v_nya || jsonb_build_array(jsonb_build_object(
        'typ',        v_typ,
        'plats',      left(coalesce(nullif(v_rad->>'label', ''), ''), 60),
        'utrustning', public.fbmejl_utrustning(v_note),
        'created_at', (v_rad->>'created_at')::bigint
      ));
      insert into public.fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, rapport_id)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'rapport', v_id)
      on conflict (nyckel) do update set rapport_id = excluded.rapport_id,
                                         utfall = 'rapport';
      update public.fbmejl_ko set status = 'klar', skal = null, avgjort_at = now()
       where message_id = v_msg_id;
    else
      -- Fanns redan i reports men inte i fbmejl_lasta: minnet hade rensats
      -- eller raden kom in via Telegram-spegeln eller userscriptet. Skriv
      -- minnet, räkna som dubblett.
      v_dubbletter := v_dubbletter + 1;
      insert into public.fbmejl_lasta (nyckel, text_nyckel, message_id, inlaggs_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_msg_id, v_rad->>'inlaggs_id', 'bortsorterad', 'fanns-redan')
      on conflict (nyckel) do nothing;
      update public.fbmejl_ko set status = 'klar', skal = 'fanns-redan', avgjort_at = now()
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


-- ============================ GICK RAPPORTEN FÖRBI? ==================
--
-- Vyn finns för ETT fel, och det felet har redan inträffat: en rapport som
-- kom in vid sidan av notiskedjan. Ingen befintlig vy kunde svara på det —
-- fbmejl_halsa räknar mejlkön, och kön var frisk. Det var en helt annan väg
-- in som var trasig.
--
-- Signalen är svår att luras av: varje rad som gått genom fbmejl_ta_emot()
-- har ett minne i fbmejl_lasta med nyckel = external_id. En rapport från en
-- Facebook-väg UTAN ett sådant minne har kommit in förbi kedjan.
--
-- Vyn säger INTE att en notis nådde en telefon. Den säger bara att raden ens
-- var i närheten av maskineriet. Det är ett lägre krav, med flit: den ska
-- kunna svara "nej" också när allt annat är trasigt.

drop view if exists public.fbmejl_notiskedjan;

create view public.fbmejl_notiskedjan
with (security_invoker = on) as
  select
    r.device_id                                            as vag,
    count(*)                                               as rapporter_dygn,
    count(*) filter (where l.nyckel is not null)           as genom_notiskedjan,
    count(*) filter (where l.nyckel is null)               as forbi_notiskedjan,
    max(to_char(to_timestamp(r.created_at / 1000.0) at time zone 'Europe/Stockholm',
                'YYYY-MM-DD HH24:MI'))                     as senaste,
    case
      when count(*) filter (where l.nyckel is null) > 0
        then 'SKRIVER FÖRBI — ingen notis går ut för de raderna'
      else 'går genom fbmejl_ta_emot'
    end                                                    as omdome
  from public.reports r
  left join public.fbmejl_lasta l on l.nyckel = r.external_id
  where r.device_id in ('fb-mejl', 'fb-bridge', 'fb-daemon')
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 24 * 3600 * 1000
  group by r.device_id
  order by r.device_id;

revoke all on public.fbmejl_notiskedjan from anon, authenticated;
grant select on public.fbmejl_notiskedjan to service_role;

-- ============================ RÄTTIGHETER ============================
--
-- De fyra nya funktionerna är ren textbehandling utan en enda uppslagning mot
-- en tabell. De tar det anroparen skickar in och lämnar tillbaka en sträng.
-- Samma resonemang som för fbmejl_typnamn: de avslöjar ingenting, och de ska
-- gå att prova i editorn och i fbmejl-test.html utan servernyckel — annars
-- provas de inte, och då glider de från js/sammanfattning.js.
--
-- De två ERSATTA funktionerna behåller sina rättigheter automatiskt: create
-- or replace rör inte proacl. Raderna nedan står ändå, uttryckligen, så att
-- filen ger rätt läge också på en databas där någon skruvat på dem.

grant execute on function public.fbmejl_utrustning(text)                  to anon, authenticated, service_role;
grant execute on function public.fbmejl_typtext(text, text)               to anon, authenticated, service_role;
grant execute on function public.fbmejl_platsfras(text)                   to anon, authenticated, service_role;
grant execute on function public.fbmejl_mening(text, text, text, bigint)  to anon, authenticated, service_role;

revoke execute on function public.fbmejl_ta_emot(jsonb)                   from public, anon, authenticated;
grant  execute on function public.fbmejl_ta_emot(jsonb)                   to service_role;
revoke execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                          from public, anon, authenticated;
grant  execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                          to service_role;

commit;

-- ============================ SJÄLVPROV ==============================
--
-- Kör automatiskt. Går något av påståendena inte igenom avbryts körningen med
-- ett fel som säger vilket — men objekten ovan är redan committade, så filen
-- går att köra om efter en rättning.
--
-- Provet rör INTE fbmejl_notis_ut(): den skriver till notisloggen och skulle
-- kunna skicka en riktig push. Bara de rena funktionerna provas här. Den
-- levande kedjan provas med kontroll 7 längre ner.

do $prov$
declare
  v_nu  bigint := (extract(epoch from now()) * 1000)::bigint;
  v_har text;
  v_ska text;
begin
  v_har := public.fbmejl_mening('police', null, 'Erikslund', v_nu - 4 * 60000) ->> 'mening';
  v_ska := 'Polis vid Erikslund — någon i Facebook-gruppen varnade för 4 minuter sedan.';
  if v_har is distinct from v_ska then
    raise exception 'Meningen blev fel. Fick: %  Ville ha: %', v_har, v_ska;
  end if;

  v_har := public.fbmejl_mening('control', public.fbmejl_utrustning('laserkontroll pa E18'),
                                'E18', v_nu) ->> 'rubrik';
  if v_har is distinct from 'Fartkontroll med laser vid E18' then
    raise exception 'Utrustningen nadde inte rubriken. Fick: %', v_har;
  end if;

  v_har := public.fbmejl_mening('unmarked', null, 'på Hälla', v_nu - 20 * 60000) ->> 'svans';
  v_ska := 'Någon i Facebook-gruppen varnade för 20 minuter sedan. Kan ha flyttat på sig.';
  if v_har is distinct from v_ska then
    raise exception 'Aktualitetsforbehallet blev fel. Fick: %  Ville ha: %', v_har, v_ska;
  end if;

  if public.fbmejl_platsfras('på E18') is distinct from ' på E18' then
    raise exception 'Prepositionen dubblerades: %', public.fbmejl_platsfras('på E18');
  end if;
  if public.fbmejl_platsfras('') is distinct from ', plats okänd' then
    raise exception 'Tom plats sades inte ut.';
  end if;
  if public.fbmejl_platsfras('Polis') is distinct from ', plats okänd' then
    raise exception 'En etikett som bara upprepar typen slapp igenom som plats.';
  end if;

  if public.fbmejl_utrustning('polis vid Erikslund') is not null then
    raise exception 'fbmejl_utrustning hittade utrustning dar ingen finns.';
  end if;

  if not public.fbmejl_ar_nykterhetskontroll('Polis gör drog-kontroll vid Erikslund') then
    raise exception 'PRODUKTREGELN LACKER: drog-kontroll slapp igenom natet.';
  end if;
  if public.fbmejl_ar_nykterhetskontroll('Polis står vid Erikslund') then
    raise exception 'Natet avvisar en vanlig polisrapport.';
  end if;

  raise notice 'Sjalvprovet gick igenom: meningen, platsfrasen, utrustningen och natet stammer.';
end $prov$;

-- ============================ KONTROLL ===============================
--
-- Kör de här efteråt och läs svaren.
--
-- 1. Produktregeln, med riktiga meningar. De fem första ska ge true, de två
--    sista false. En enda felaktig rad här är hela produktregeln.

select t as text, public.fbmejl_ar_nykterhetskontroll(t) as vagras from (values
  ('Nykterhetskontroll vid Bäckby'),
  ('polisen blåser alla vid E18'),
  ('alkohol kontroll vid rondellen'),
  ('Polis gör drog-kontroll vid Erikslund'),
  ('narkotikakontroll på Vasagatan'),
  ('Polis står vid Erikslund'),
  ('Fartkontroll på E18')
) as p(t);

-- 2. Meningen, ordagrant. Jämför med sammanfattaKort() i js/sammanfattning.js.
--
--    Ska ge, i tur och ordning:
--      Polis vid Erikslund — någon i Facebook-gruppen varnade för 4 minuter sedan.
--      Fartkontroll med laser vid E18 — någon i Facebook-gruppen varnade just nu.
--      Civil polisbil på Hälla — någon i Facebook-gruppen varnade för 20 minuter sedan. Kan ha flyttat på sig.
--      Polis, plats okänd — någon i Facebook-gruppen varnade vid okänd tidpunkt.

select fall, public.fbmejl_mening(typ, utr, plats, skapad) ->> 'mening' as mening
  from (values
    ('fyra minuter sedan',   'police',   null,
     'Erikslund', (extract(epoch from now()) * 1000)::bigint - 4 * 60000),
    ('just nu, med laser',   'control',  public.fbmejl_utrustning('laserkontroll pa E18'),
     'E18',       (extract(epoch from now()) * 1000)::bigint),
    ('gammal, civil',        'unmarked', null,
     'på Hälla',  (extract(epoch from now()) * 1000)::bigint - 20 * 60000),
    ('utan plats, utan tid', 'police',   null,
     '',          null)
  ) as p(fall, typ, utr, plats, skapad);

-- 3. Ingenting ur inläggstexten kan nå en låsskärm. Ska ge laser, radar,
--    fart, och sedan bara null — hur texten än ser ut.

select public.fbmejl_utrustning('laser vid E18')            as ska_bli_laser,
       public.fbmejl_utrustning('radarkontroll')            as ska_bli_radar,
       public.fbmejl_utrustning('fartkontroll vid Hälla')   as ska_bli_fart,
       public.fbmejl_utrustning('polis vid Erikslund')      as ska_bli_null_1,
       public.fbmejl_utrustning('KOM TILL MITT HUS NU!!!')  as ska_bli_null_2,
       public.fbmejl_utrustning(null)                       as ska_bli_null_3;

-- 4. Rättigheterna. NOLL rader — ingen av de skrivande funktionerna får gå
--    att anropa med anon-nyckeln.

select p.proname, r.rolname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(p.proacl) a
  join pg_roles r on r.oid = a.grantee
 where n.nspname = 'public'
   and p.proname in ('fbmejl_ta_emot', 'fbmejl_notis_ut', 'fbmejl_push_mottagare',
                     'fbmejl_ko_in', 'fbmejl_ko_hamta', 'fbmejl_ko_avfard')
   and r.rolname in ('anon', 'authenticated');

-- 5. De sex funktionerna finns, med rätt signatur. Ska ge sex rader.

select p.proname, pg_get_function_identity_arguments(p.oid) as argument
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('fbmejl_utrustning', 'fbmejl_typtext', 'fbmejl_platsfras',
                     'fbmejl_mening', 'fbmejl_ta_emot', 'fbmejl_notis_ut')
 order by p.proname;

-- 6. Skriver någon fortfarande förbi notiskedjan? Kolumnen omdome ska säga
--    "går genom fbmejl_ta_emot" för varje väg. Står det "SKRIVER FÖRBI" är
--    bryggan inte omställd än — se docs/notiskedjan.md.
--
--    Noll rader betyder bara att inga Facebook-rapporter kommit in det
--    senaste dygnet. Det är inte ett godkännande.

select * from public.fbmejl_notiskedjan;

-- 7. Hela kedjan, på riktigt, utan att vänta på gruppen. Kräver att du först
--    slagit på gruppnotiser för din egen telefon — punkt 8 i fbmejl.sql.
--
--    Kör raden nedan EN gång. Den ska ge skapade = 1, och notis.skickad =
--    true med titel "Polis vid Testplatsen". Ligger telefonen bredvid ska den
--    ringa inom några sekunder.
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fb:test:notiskedja:1', 'type', 'police',
--        'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
--        'note', 'Polis står vid testplatsen',
--        'device_id', 'fb-daemon',
--        'created_at', (extract(epoch from now())*1000)::bigint - 3*60000,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 42*60000)));
--
--    Och det viktigaste provet i hela filen: en drogkontroll får inte ens ge
--    en notis om att "något hänt", för det vore i praktiken varningen. Kör
--    raden nedan — ska ge skapade 0 och vagrade 1 — och kontrollera sedan att
--    INGEN ny rad tillkommit i notisloggen.
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fb:test:notiskedja:2', 'type', 'police',
--        'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
--        'note', 'Polisen har drog-kontroll vid testplatsen',
--        'device_id', 'fb-daemon',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000)));
--
--      select id, skickat_at, antal, utfall, titel, left(text, 120)
--        from public.fbmejl_notis_logg order by skickat_at desc limit 5;
--
--    Städa upp efteråt:
--
--      delete from public.fbmejl_lasta where nyckel like 'fb:test:notiskedja:%';
--      delete from public.reports      where external_id like 'fb:test:notiskedja:%';
--      update public.fbmejl_notis_lage
--         set senaste_at = null, antal_idag = 0, odelade = 0 where id = 1;
--
-- 8. Nådde notisen fram? Loggen svarar först efter avstämningen. Utfallet ska
--    gå från 'koad' till 'kvitterad'. Står det 'fel' med "HTTP 404" är
--    edge-funktionen fbmejl-push inte utrullad; "HTTP 401" betyder att
--    app.service_role_key inte är samma nyckel som funktionen förväntar sig.
--    Se docs/notiskedjan.md.
--
--      select public.fbmejl_notis_stam_av();
--      select id, skickat_at, antal, utfall, left(skal, 160)
--        from public.fbmejl_notis_logg order by skickat_at desc limit 10;
