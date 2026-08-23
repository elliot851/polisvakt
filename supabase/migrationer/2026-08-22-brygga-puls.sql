-- =====================================================================
--  Polisvakt — bryggans puls och ett dödmansgrepp
--  2026-08-22
-- =====================================================================
--
-- VARNING OM BLOCKKOMMENTARER
--
-- Filen har INGA blockkommentarer, och ska inte få några. En cron-rad med
-- stjärna-snedstreck-fem innehåller tecknen som avslutar en blockkommentar,
-- och den kombinationen har redan dödat en körning i det här projektet en
-- gång. Bara radkommentarer med två bindestreck.
--
--
-- VAD DEN LÖSER
--
-- Bryggan kan dö tyst. Windows startar om, Chrome uppdaterar sig, PowerShell
-- kastas ut, nätet försvinner — och ingenting säger till. Appen ser precis
-- likadan ut som en lugn dag i gruppen.
--
-- fbmejl_brygga.senast_kord duger INTE som livstecken. Den skrivs inne i
-- fbmejl_ta_emot, alltså när en rapport faktiskt skapats. En daemon som kör
-- felfritt i tre dygn utan att någon postar en polis rör den aldrig, och en
-- daemon som är död ser exakt likadan ut. Kolumnen betyder "senaste rapport"
-- och fbmejl_halsa räknar på den — den rörs inte här, med flit.
--
-- Alltså en EGEN puls, i egna kolumner, plus ett cron-jobb som säger till när
-- pulsen tystnar.
--
--
-- VAD DEN INTE GÖR
--
--   * Ingen kanariefågel. Ett falskt utskick varje kvart bevisar exakt det
--     som daemonens startprob redan bevisar, smutsar ner fbmejl_notis_logg
--     med sjuttio rader om dygnet, och bevisar INTE sista milen — dry-svaret
--     i fbmejl-push returneras före importVapidKeys. Det beviset ligger i
--     stället i daemonens veckolivstecken, som skickar en RIKTIG push.
--   * Ingen ändring i fbmejl_halsa. Den fungerar och rörs inte.
--   * Ingen ändring i fbmejl_notis_ut, fbmejl_ta_emot eller
--     fbmejl_anropsnyckel. Notisvägen rörs inte med en bokstav.
--   * Larmet räknas INTE mot dygnstaket och nollställer INTE odelade. Det är
--     inte en varning om en polis, det är ett larm om bryggan. Blandas de två
--     kan ett larm äta upp en riktig varning.
--
--
-- KÖR
--
--   Klistra in hela filen i Supabase SQL Editor och kör. Den är idempotent
--   och kan köras om hur många gånger som helst. Läs kvittot längst ned.

begin;

-- =====================================================================
--  1. KOLUMNERNA
-- =====================================================================
--
-- Sex, inte fyra. Fyra beskriver bryggan; två till behövs för att larmet ska
-- kunna säga ifrån EN gång och inte var femte minut i evighet. Ett larm utan
-- eget minne är ett larm man stänger av, och ett avstängt larm är sämre än
-- inget.
--
-- Allihop på fbmejl_brygga, som redan finns, redan har RLS påslaget och redan
-- är indragen från anon och authenticated. Noll nya tabeller, noll nya
-- rättigheter att hålla reda på.

alter table public.fbmejl_brygga add column if not exists brygga_puls_at            timestamptz;
alter table public.fbmejl_brygga add column if not exists brygga_lage               text;
alter table public.fbmejl_brygga add column if not exists brygga_inlagg_1h          int;
alter table public.fbmejl_brygga add column if not exists brygga_senaste_inlagg_at  timestamptz;

-- Dödmansgreppets eget minne.
alter table public.fbmejl_brygga add column if not exists brygga_larm_lage          text;
alter table public.fbmejl_brygga add column if not exists brygga_larm_at            timestamptz;

-- Läget är en av tre kända strängar, aldrig fri text. En puls som kunde bära
-- godtycklig text vore en väg in i databasen för det som står i sidan.
alter table public.fbmejl_brygga drop constraint if exists fbmejl_brygga_lage_check;
alter table public.fbmejl_brygga add constraint fbmejl_brygga_lage_check
  check (brygga_lage is null or brygga_lage in ('skarp', 'torr'));

alter table public.fbmejl_brygga drop constraint if exists fbmejl_brygga_larm_lage_check;
alter table public.fbmejl_brygga add constraint fbmejl_brygga_larm_lage_check
  check (brygga_larm_lage is null or brygga_larm_lage in ('frisk', 'tyst', 'torr'));

-- =====================================================================
--  2. PULSEN
-- =====================================================================
--
-- Daemonen anropar den här var annan minut med service_role-nyckeln.
--
-- PRODUKTREGELN GÄLLER OCKSÅ HÄR, OCH DET ÄR INTE EN FORMALITET.
--
-- Pulsen tar emot FYRA fält och kastar allt annat: läge, antal svep, antal
-- inlägg den senaste timmen, och när det senaste sågs. Ingen text, ingen typ,
-- inget id, ingen plats. Skälet är att en puls som kunde bära "typ=control"
-- vore en nykterhetskontroll som läckt ut bakvägen, i en kolumn ingen tänker
-- på som en varning. Ett antal kan inte skilja en fartkamera från en
-- nykterhetskontroll, och det är hela poängen.
--
-- Fälten läses ETT I TAGET ur jsonb och typas hårt. Ingen jsonb sparas rått.
--
-- Fält som funktionen inte känner igen IGNORERAS tyst, och det är avsiktligt
-- åt båda hållen. Daemonen skickar i dag också 'svep' (antal svep sedan start)
-- som inte lagras — den siffran hör hemma i daemonens egen logg, inte i en
-- kolumn. Och en nyare daemon som lägger till ett fält får aldrig kunna få en
-- äldre databas att svara med fel: då hade en uppgradering av PowerShell-sidan
-- tystat pulsen och utlöst dödmansgreppet.

create or replace function public.fbmejl_brygga_puls(p_puls jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $fn$
declare
  v_lage    text;
  v_inlagg  int;
  v_senaste timestamptz;
begin
  if p_puls is null or jsonb_typeof(p_puls) <> 'object' then
    return jsonb_build_object('ok', false, 'skal', 'ingen puls');
  end if;

  v_lage := nullif(p_puls ->> 'lage', '');
  if v_lage is not null and v_lage not in ('skarp', 'torr') then
    v_lage := null;
  end if;

  begin
    v_inlagg := greatest(0, least(100000, (p_puls ->> 'inlagg_1h')::int));
  exception when others then
    v_inlagg := null;
  end;

  begin
    v_senaste := (p_puls ->> 'senaste_inlagg_at')::timestamptz;
    -- En tidpunkt i framtiden är en trasig klocka, inte ett inlägg. Den
    -- skulle få dödmansgreppet att tro att allt är nyss.
    if v_senaste > now() + interval '1 hour' then v_senaste := null; end if;
  exception when others then
    v_senaste := null;
  end;

  update public.fbmejl_brygga
     set brygga_puls_at           = now(),
         brygga_lage              = coalesce(v_lage, brygga_lage),
         brygga_inlagg_1h         = coalesce(v_inlagg, brygga_inlagg_1h),
         brygga_senaste_inlagg_at = coalesce(v_senaste, brygga_senaste_inlagg_at),
         uppdaterad               = now()
   where id = 1;

  -- senast_kord rörs INTE. Den betyder "senaste rapport" och fbmejl_halsa
  -- räknar på den. Skriver pulsen dit blir hälsovyn en lögn: den skulle säga
  -- att rapporter kommer in var annan minut dygnet runt.

  return jsonb_build_object('ok', true, 'lage', v_lage, 'inlagg_1h', v_inlagg);
end $fn$;

-- BARA service_role. Pulsen skriver i en tabell som styr ett larm, och anon
-- lever öppet i js/config.js. En främling som kunde pulsa skulle kunna hålla
-- dödmansgreppet tyst medan bryggan är död — vilket är exakt det fel den är
-- byggd för att fånga.
revoke all on function public.fbmejl_brygga_puls(jsonb) from public;
revoke all on function public.fbmejl_brygga_puls(jsonb) from anon, authenticated;
grant execute on function public.fbmejl_brygga_puls(jsonb) to service_role;

-- =====================================================================
--  3. DÖDMANSGREPPET
-- =====================================================================
--
-- Två villkor, inte tre:
--
--   i.  Ingen puls på femton minuter. Daemonen pulsar var annan minut, så tre
--       missade i rad ryms utan falsklarm.
--   ii. Puls finns, men bryggan står i TORRKÖRNING. Den läser då flödet och
--       skriver ingenting — det ser i alla loggar ut som att allt fungerar.
--
-- Villkoret "inga inlägg på sex timmar" ligger INTE här. Det hanteras lokalt
-- i daemonen, där sidan faktiskt går att inspektera: där kan man se skillnad
-- på ett lugnt flöde och en utloggad session. Härifrån ser de två likadana
-- ut, och ett larm som inte kan skilja dem åt blir ett larm man stänger av.
--
-- EN notis per tillståndsövergång. Tidigast trettio minuter efter föregående
-- övergång, så att en brygga som studsar upp och ner inte blir en notisskur.
-- Nattetid HÅLLS larmet till 06:00 — det stryks aldrig, bara skjuts upp. En
-- brygga som dog klockan två ska man få veta om, men inte klockan två.

create or replace function public.fbmejl_dodman()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $fn$
declare
  v_b        public.fbmejl_brygga%rowtype;
  v_nytt     text;
  v_titel    text;
  v_text     text;
  v_url      text;
  v_nyckel   text;
  v_net_id   bigint;
  v_timme    int;
  v_fel      text;
begin
  -- for update: cron kan i teorin överlappa sig själv om en körning hänger.
  -- Två samtidiga övergångar vore två notiser om samma sak.
  select * into v_b from public.fbmejl_brygga where id = 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'skal', 'ingen brygg-rad');
  end if;

  -- Vilket tillstånd ÄR vi i?
  if v_b.brygga_puls_at is null then
    -- Har aldrig pulsat. Det är inte ett haveri — det är en databas där
    -- migrationen just körts och daemonen inte startat om än. Larma inte.
    v_nytt := null;
  elsif v_b.brygga_puls_at < now() - interval '15 minutes' then
    v_nytt := 'tyst';
  elsif coalesce(v_b.brygga_lage, 'skarp') = 'torr' then
    v_nytt := 'torr';
  else
    v_nytt := 'frisk';
  end if;

  if v_nytt is null then
    return jsonb_build_object('ok', true, 'lage', 'avvaktar', 'skal', 'ingen puls annu');
  end if;

  -- Ingen övergång, ingenting att göra. Det här är det vanliga fallet, tolv
  -- gånger i timmen, och det kostar en select.
  if v_nytt = coalesce(v_b.brygga_larm_lage, 'frisk') then
    return jsonb_build_object('ok', true, 'lage', v_nytt, 'notis', false);
  end if;

  -- Studsspärr.
  if v_b.brygga_larm_at is not null and v_b.brygga_larm_at > now() - interval '30 minutes' then
    return jsonb_build_object('ok', true, 'lage', v_nytt, 'notis', false, 'skal', 'studsspärr');
  end if;

  -- Nattystnad. Tillståndet skrivs INTE om här: larmet ska gå klockan sex,
  -- inte glömmas bort för att det inträffade klockan två.
  v_timme := extract(hour from (now() at time zone 'Europe/Stockholm'))::int;
  if v_timme < 6 then
    return jsonb_build_object('ok', true, 'lage', v_nytt, 'notis', false, 'skal', 'natt');
  end if;

  if v_nytt = 'tyst' then
    v_titel := 'Polisvakt: bryggan svarar inte';
    v_text  := 'Ingen kontakt med bryggan på 15 minuter. Inga varningar kommer fram. Starta datorn eller kör polisvakt-brygga.ps1.';
  elsif v_nytt = 'torr' then
    v_titel := 'Polisvakt: bryggan står i torrkörning';
    v_text  := 'Bryggan läser gruppen men skriver ingenting. Starta om utan -Torr.';
  else
    v_titel := 'Polisvakt: bryggan är frisk igen';
    v_text  := 'Kontakten är återställd. Varningarna går fram som vanligt.';
  end if;

  v_url    := public.fbmejl_installning('fbmejl_push_url');
  v_nyckel := public.fbmejl_anropsnyckel();

  if v_url is null or v_url = '' or v_nyckel is null or v_nyckel = '' then
    -- Kan inte larma. Skriv INTE om tillståndet — då skulle larmet vara
    -- förbrukat utan att någon fått det, vilket är exakt den tysta döden
    -- funktionen finns för att förhindra. Nästa körning provar igen.
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (0, v_titel, v_text, 'fel', 'dodman: url eller anropsnyckel saknas');
    return jsonb_build_object('ok', false, 'lage', v_nytt, 'notis', false,
                              'skal', 'url eller nyckel saknas');
  end if;

  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (0, v_titel, v_text, 'fel', 'dodman: pg_net saknas');
    return jsonb_build_object('ok', false, 'lage', v_nytt, 'notis', false, 'skal', 'pg_net saknas');
  end if;

  begin
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_nyckel
      ),
      body    := jsonb_build_object(
        'titel', v_titel,
        'text',  v_text,
        -- EGEN tag. 'polisvakt-grupp' hade ERSATT en färsk polisvarning i
        -- luren, och ett driftlarm får aldrig kunna radera den varning det
        -- är till för att skydda.
        'tag',   'polisvakt-brygga',
        'url',   './'
      )
    ) into v_net_id;
  exception when others then
    v_fel := public.fbmejl_dolj_hemligheter(sqlerrm);
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (0, v_titel, v_text, 'fel', left('dodman: ' || v_fel, 200));
    return jsonb_build_object('ok', false, 'lage', v_nytt, 'notis', false, 'detalj', v_fel);
  end;

  -- Först när anropet ligger i pg_nets kö skrivs tillståndet om.
  update public.fbmejl_brygga
     set brygga_larm_lage = v_nytt,
         brygga_larm_at   = now(),
         uppdaterad       = now()
   where id = 1;

  -- Loggas i samma tabell som notiserna. Det är med flit: fbmejl_notis_stam_av
  -- plockar upp raden på net_id och skriver om 'koad' till 'kvitterad' inom
  -- fem minuter. Larmet blir alltså självt bevisat framme, utan en rad ny kod.
  insert into public.fbmejl_notis_logg (antal, titel, text, utfall, net_id)
  values (0, v_titel, v_text, 'koad', v_net_id);

  return jsonb_build_object('ok', true, 'lage', v_nytt, 'notis', true, 'net_id', v_net_id);
end $fn$;

revoke all on function public.fbmejl_dodman() from public;
revoke all on function public.fbmejl_dodman() from anon, authenticated;
grant execute on function public.fbmejl_dodman() to service_role;

commit;

-- =====================================================================
--  4. SCHEMALÄGGNINGEN
-- =====================================================================
--
-- Utanför transaktionen: cron.schedule tar egna lås, och en misslyckad
-- schemaläggning ska inte rulla tillbaka kolumnerna och funktionerna.
--
-- Minutlistan är utskriven med flit i stället för det korta uttrycket med
-- stjärna och snedstreck. Se varningen överst i filen.

do $sched$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — dödmansgreppet schemaläggs INTE. Kör select public.fbmejl_dodman(); manuellt.';
    return;
  end if;
  perform 1 from cron.job where jobname = 'polisvakt-brygga-dodman';
  if found then perform cron.unschedule('polisvakt-brygga-dodman'); end if;
  perform cron.schedule('polisvakt-brygga-dodman',
                        '0,5,10,15,20,25,30,35,40,45,50,55 * * * *',
                        'select public.fbmejl_dodman();');
  raise notice 'Dödmansgreppet schemalagt var femte minut.';
exception when others then
  raise notice 'Kunde inte schemalägga dödmansgreppet (%). Kör fbmejl_dodman() manuellt.', sqlerrm;
end $sched$;

-- =====================================================================
--  5. KVITTOT — läs det, gissa inte
-- =====================================================================

do $kvitto$
declare
  v_kol   int;
  v_puls  boolean;
  v_dod   boolean;
  v_jobb  boolean;
  v_anon  boolean;
  v_srv   boolean;
begin
  select count(*) into v_kol
    from information_schema.columns
   where table_schema = 'public' and table_name = 'fbmejl_brygga'
     and column_name in ('brygga_puls_at', 'brygga_lage', 'brygga_inlagg_1h',
                         'brygga_senaste_inlagg_at', 'brygga_larm_lage', 'brygga_larm_at');

  v_puls := to_regprocedure('public.fbmejl_brygga_puls(jsonb)') is not null;
  v_dod  := to_regprocedure('public.fbmejl_dodman()') is not null;

  begin
    select exists (select 1 from cron.job where jobname = 'polisvakt-brygga-dodman') into v_jobb;
  exception when others then
    v_jobb := false;
  end;

  v_anon := has_function_privilege('anon', 'public.fbmejl_brygga_puls(jsonb)', 'execute');
  v_srv  := has_function_privilege('service_role', 'public.fbmejl_brygga_puls(jsonb)', 'execute');

  raise notice '--------------------------------------------------';
  raise notice 'kolumner (ska vara 6):        %', v_kol;
  raise notice 'fbmejl_brygga_puls finns:     %', v_puls;
  raise notice 'fbmejl_dodman finns:          %', v_dod;
  raise notice 'cron-jobbet finns:            %', v_jobb;
  raise notice 'anon far pulsa (ska vara f):  %', v_anon;
  raise notice 'service_role far pulsa (t):   %', v_srv;
  raise notice '--------------------------------------------------';

  if v_kol <> 6 or not v_puls or not v_dod then
    raise exception 'Migrationen blev inte komplett. Las notiserna ovan.';
  end if;
  if v_anon then
    raise exception 'anon far kora fbmejl_brygga_puls. Det ar ett sakerhetsfel — migrationen ska inte anses klar.';
  end if;
  if not v_srv then
    raise exception 'service_role far INTE kora fbmejl_brygga_puls. Daemonens puls kommer att fela.';
  end if;
end $kvitto$;

-- =====================================================================
--  6. EFTERÅT
-- =====================================================================
--
-- Se bryggans läge, utan att ändra något:
--
--   select brygga_puls_at, brygga_lage, brygga_inlagg_1h,
--          brygga_senaste_inlagg_at, brygga_larm_lage, brygga_larm_at,
--          senast_kord
--     from public.fbmejl_brygga where id = 1;
--
-- senast_kord står kvar bredvid och betyder fortfarande "senaste rapport".
-- De två ska inte förväxlas: brygga_puls_at säger att daemonen LEVER,
-- senast_kord säger att den SKREV något.
--
-- Provkör dödmansgreppet för hand:
--
--   select public.fbmejl_dodman();
--
-- Ta bort schemaläggningen igen, om det någonsin behövs:
--
--   select cron.unschedule('polisvakt-brygga-dodman');
