/* =====================================================================
   FIXAR 2026-09-06 — efterskörden av backend-granskningen
   =====================================================================

   VAD DEN HÄR FILEN GÖR

   Den stänger de hål som granskningen den 6 september hittade i
   supabase/*.sql och som INTE redan var åtgärdade i drift. Ingenting här
   ändrar hur appen fungerar för en användare. Allt är rättigheter och
   search_path.

   Fem fixar, i fallande allvarlighetsgrad:

     1. pg_temp saknas i search_path på 55 SECURITY DEFINER-funktioner.
     2. purge_old_reports() går att anropa av vem som helst med anon-nyckeln.
     3. Sju vyer som tros vara privata är i själva verket läsbara för anon.
     4. Fem tabeller med känsliga fält saknar den revoke som resten av
        kodbasen har som standard.
     5. (ingår i 1) trigger- och hjälpfunktioner får samma pinning.

   SÄKER ATT KÖRA OM

   Varje sats är antingen idempotent i sig (revoke, grant, alter function
   set) eller villkorad på att objektet finns. Kör filen två gånger i rad
   och andra körningen ändrar ingenting.

   INGENTING RADERAS

   Filen innehåller noll drop table, noll delete, noll drop function, noll
   truncate, noll alter table drop. Enda DDL:en är ALTER FUNCTION ... SET
   search_path, som varken rör funktionens kropp eller dess rättigheter.
   De två DO-blocken finns bara för att kunna hoppa över objekt som inte
   existerar i den här databasen; de kör inget annat än ALTER FUNCTION SET
   search_path respektive REVOKE.

   VAD DEN MEDVETET INTE RÖR

   - Betalkedjan. hamta_konto_prenumeration, payment_events, set_paid_until
     och guard-triggern är inte applicerade, och det är ett beslut: appen
     kör testläge utan betalningar. Ingenting här slår på dem.
   - Radiefiltret i fbmejl_notis_ut. Att alla prenumeranter får alla
     varningar är accepterat så länge tjänsten täcker en stad.
   - notera_bidrag, uppdatera_bidrag och subs_insert. De fixades i drift
     tidigare idag och rörs inte här.
   - subscribers UPDATE för anon. Den ser onödig ut men behövs: js/billing.js
     skriver med Prefer: resolution=merge-duplicates, vilket blir
     INSERT ... ON CONFLICT DO UPDATE, och Postgres kräver UPDATE-rätt för
     att ens planera den satsen. Drar man in den slutar provperiodens rad
     att skapas. Se fix 4.

   Kör i Supabase SQL Editor som postgres. Verifieringen ligger sist.
   ===================================================================== */


/* =====================================================================
   FIX 1 — pg_temp saknas i search_path på 55 SECURITY DEFINER-funktioner
   =====================================================================

   FELET

   55 av 89 SECURITY DEFINER-funktioner står skrivna som

       set search_path = public

   och inte som

       set search_path = public, pg_temp

   Det ser ut som en pinnad sökväg, och för FUNKTIONSNAMN är det också en
   pinnad sökväg. För TABELLNAMN är det inte det. Postgres regel:

       "Om pg_temp inte är listad i search_path söks den ändå, och då
        FÖRST — före pg_catalog. Temp-schemat söks bara för relationer
        (tabell, vy, sekvens) och datatypnamn, aldrig för funktioner."

   Den faktiska sökvägen är alltså "pg_temp, public", inte "public".

   VAD SOM HÄNDER OM MAN INTE FIXAR DET

   Den som har en riktig Postgres-session mot databasen kan skriva

       create temp table subscribers (device_id text, paid_until timestamptz);

   och sedan anropa till exempel redeem_code(). Funktionen är SECURITY
   DEFINER, kör som postgres, och dess obundna "insert into subscribers"
   hittar då angriparens temp-tabell först. Samma sak för reports,
   report_votes, group_members och alla andra obundna tabellnamn i de 55
   funktionerna. Skrivningar hamnar i tomma intet, läsningar returnerar det
   angriparen valt, och en behörighetskontroll som läser en tabell går att
   svara "ja" på.

   HUR ALLVARLIGT ÄR DET I PRAKTIKEN

   Ärligt: låg exponering idag. anon och authenticated är roller som
   PostgREST växlar in i, de har inget lösenord och kan inte öppna en egen
   session, och PostgREST kör ingen godtycklig SQL — alltså går det inte
   att skapa temp-tabellen den vägen. Det som fixas här är att skyddet inte
   ska vila på den omständigheten. Det är också exakt vad Supabase egen
   linter (function_search_path_mutable) klagar på.

   VAD FIXEN GÖR

   Lägger till pg_temp SIST i sökvägen på varje SECURITY DEFINER-funktion i
   public som saknar den. Sist, inte först — då söks temp-schemat efter
   public i stället för före, vilket är hela poängen. Befintliga scheman i
   sökvägen behålls ordagrant, så en funktion som står på
   "public, auth, extensions" blir "public, auth, extensions, pg_temp" och
   tappar ingenting.

   Ingen funktion i kodbasen skapar eller läser en temp-tabell (kontrollerat
   med grep på "create temp" och "create temporary": noll träffar), så
   ändringen kan inte påverka beteendet.
   ===================================================================== */

do $sp$
declare
  r        record;
  v_gammal text;
  v_ny     text;
  v_antal  int := 0;
begin
  for r in
    select p.oid::regprocedure as sig,
           (select c
              from unnest(coalesce(p.proconfig, array[]::text[])) as c
             where c like 'search_path=%'
             limit 1) as rad
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef            -- bara SECURITY DEFINER
       and p.prokind = 'f'        -- funktioner, inte procedurer/aggregat
     order by 1
  loop
    -- Ingen search_path alls satt räknas som "public" — det är vad
    -- Supabase-sessionen ändå har, och vi vill inte smalna av den i smyg.
    v_gammal := coalesce(substring(r.rad from 13), 'public');

    if position('pg_temp' in v_gammal) > 0 then
      continue;                                  -- redan rätt, rör den inte
    end if;

    -- Ett citattecken i sökvägen (Postgres egen user-platshållare skrivs så)
    -- går inte att skarva på blint utan att riskera trasig syntax. Rapportera
    -- i stället, så får den sättas för hand.
    if position('"' in v_gammal) > 0 then
      raise notice 'HOPPAR ÖVER %: search_path innehåller citattecken (%). Sätt den för hand.', r.sig, v_gammal;
      continue;
    end if;

    v_ny := v_gammal || ', pg_temp';
    execute format('alter function %s set search_path = %s', r.sig, v_ny);
    v_antal := v_antal + 1;
    raise notice 'search_path pinnad: %  ->  %', r.sig, v_ny;
  end loop;

  raise notice 'FIX 1 klar: % funktioner fick pg_temp sist i search_path.', v_antal;
end
$sp$;


/* =====================================================================
   FIX 2 — purge_old_reports() är öppen för anon
   =====================================================================

   FELET

   purge_old_reports() (schema.sql rad 305, KOR-ALLT.sql rad 314) är
   SECURITY DEFINER och raderar rader ur public.reports. Den saknar både
   grant och revoke.

   Postgres delar ut EXECUTE till PUBLIC på VARJE ny funktion. Att inte
   skriva något grant betyder alltså inte att ingen får anropa den — det
   betyder att alla får det. anon ingår i PUBLIC, och anon-nyckeln ligger
   öppet i js/config.js.

   Resten av kodbasen kan den här fällan utantill: billing.sql, push.sql,
   grupper.sql, manadsbelaning.sql, telegram.sql och fbmejl.sql har alla en
   "revoke ... from public"-rad efter varje serverfunktion, och
   manadsbelaning.sql skriver rakt ut att raden är det ENDA som hindrar en
   klient från att ge sig själv gratis prenumeration. purge_old_reports blev
   bara aldrig med på listan.

   VAD SOM HÄNDER OM MAN INTE FIXAR DET

   Vem som helst kan skicka

       POST /rest/v1/rpc/purge_old_reports
       apikey: <anon-nyckeln ur js/config.js>

   och gallringen körs på beställning. Funktionen tar bara rapporter som
   löpt ut för mer än sju dygn sedan, så en enstaka körning gör ingen större
   skada — men den går förbi radsäkerheten (SECURITY DEFINER) och förbi det
   faktum att reports helt saknar delete-policy, och den går att köra i en
   loop. Det är en skrivande, raderande RPC utan avsändarkontroll som pekar
   rakt ut mot internet.

   VAD FIXEN GÖR

   Samma mönster som purge_dead_push() och purge_dead_invites(): bort från
   PUBLIC, in till service_role. pg_cron kör som postgres, alltså som
   ägaren, och påverkas inte.
   ===================================================================== */

do $pg$
begin
  if to_regprocedure('public.purge_old_reports()') is not null then
    execute 'revoke execute on function public.purge_old_reports() from public, anon, authenticated';
    execute 'grant  execute on function public.purge_old_reports() to service_role';
    raise notice 'FIX 2 klar: purge_old_reports() indragen från PUBLIC.';
  else
    raise notice 'FIX 2 hoppad: purge_old_reports() finns inte i den här databasen.';
  end if;
end
$pg$;


/* =====================================================================
   FIX 3 — sju vyer tros vara privata men är läsbara för anon
   =====================================================================

   FELET

   Supabase kör med

       alter default privileges in schema public grant all on tables
         to anon, authenticated, service_role;

   Det betyder att varje ny vy i public får SELECT till anon AUTOMATISKT,
   utan att en enda rad i våra filer ber om det. Att låta bli att skriva ett
   grant räcker alltså inte.

   fbmejl.sql kan det här — rad 2502 och framåt säger det ordagrant och
   revokar sina tre vyer. Men samma insikt nådde aldrig fram till:

     facebook.sql rad 60-62   "Därför inga grants till anon" — fel, anon har
                              redan grant. Gäller facebook_recent,
                              facebook_quality och facebook_places.
     telegram.sql rad 371-373 "Inga grants till anon" — samma fel. Gäller
                              telegram_senaste och telegram_halsa.
     schema.sql rad 448       interest_summary. Saknar dessutom
                              security_invoker, alltså en DEFINER-vy.
     schema.sql rad 45        reports_active.

   VAD SOM HÄNDER OM MAN INTE FIXAR DET

   Olika illa per vy, och det ska sägas rakt ut:

     interest_summary  VÄRST av de sju. Utan security_invoker körs vyn som
                       postgres och går därmed FÖRBI radsäkerheten på
                       product_interest — den tabell som har en e-postkolumn
                       och vars policy uttryckligen bara tillåter insert.
                       Vyn lämnar idag ut aggregat (produkt, antal,
                       antal med e-post) till anon. Inga adresser ännu, men
                       hela spärren mellan anon och tabellen är borta, och
                       nästa kolumn någon lägger till i vyn läcker på riktigt.
                       Exakt samma bugg som monthly_winners hade.

     facebook_quality  Rena invoker-vyer som bara rör kolumner anon redan får
     facebook_places   läsa, alltså läsbara för anon här och nu. Innehållet
                       är statistik över publika rapporter, så skadan är
                       liten — men filen påstår motsatsen, och det som står i
                       kommentaren är det någon kommer att lita på nästa gång
                       en kolumn läggs till.

     facebook_recent   Skyddas i praktiken av kolumnspärren på
     telegram_senaste  reports.device_id (dolj-enhets-id.sql) respektive av
     telegram_halsa    den tomma radsäkerheten på telegram-tabellerna. De är
     reports_active    alltså täta idag — av en annan anledning än den som
                       står i filen. Ett skydd som fungerar av misstag är
                       inget skydd, och kostnaden att stänga dem är noll.

   VAD FIXEN GÖR

   revoke all from anon, authenticated på alla sju. Ingen av dem läses av
   klienten — kontrollerat mot js/: reports_feed, leaderboard, chatt_flode
   och report_history är de enda vyer appen rör. LANSERINGSKOLL.sql läser
   reports_active men gör det som postgres i SQL-editorn och påverkas inte.
   ===================================================================== */

do $vy$
declare
  v      text;
  v_gjort int := 0;
begin
  foreach v in array array[
    'public.interest_summary',   -- DEFINER-vy över tabellen med e-post
    'public.facebook_recent',    -- device_id + andras ordagranna text
    'public.facebook_quality',
    'public.facebook_places',
    'public.telegram_senaste',   -- andras ordagranna text
    'public.telegram_halsa',
    'public.reports_active'      -- select * över reports, alltså device_id
  ]
  loop
    if to_regclass(v) is not null then
      execute format('revoke all on %s from anon, authenticated', v);
      v_gjort := v_gjort + 1;
      raise notice 'Stängd för anon/authenticated: %', v;
    else
      raise notice 'Hoppad (finns inte i den här databasen): %', v;
    end if;
  end loop;
  raise notice 'FIX 3 klar: % vyer stängda.', v_gjort;
end
$vy$;


/* =====================================================================
   FIX 4 — fem tabeller med känsliga fält saknar revoke
   =====================================================================

   FELET

   Samma default privileges som i fix 3 gäller tabeller: anon och
   authenticated får SELECT, INSERT, UPDATE och DELETE på varje ny tabell i
   public. Radsäkerheten håller dem ute ändå — men bara så länge ingen
   lägger till en policy som råkar vara för vid.

   Kodbasens egen standard är bälte OCH hängslen: manads_bidrag skriver
   uttryckligen "Supabase delar ut SELECT till anon och authenticated på nya
   tabeller i public automatiskt. Utan raden nedan hade tabellen legat
   öppen." Fjorton tabeller har den raden. Fem har den inte, och det är
   dessa fem — alla med ett fält som inte ska ut.

     product_interest   e-postadresser
     access_codes       koder som är värda en betald prenumeration
     report_votes       device_id, som för inloggade är konto-id
     reporter_scores    device_id
     subscribers        e-post, stripe_id, betalstatus

   VAD SOM HÄNDER OM MAN INTE FIXAR DET

   Ingenting läcker just nu — radsäkerheten står emot. Men avståndet mellan
   "tätt" och "hela kundlistan ute" är en enda slarvig policy. En
   "for select using (true)" på subscribers, skriven av någon som felsöker
   en supportfråga, lämnar ut varje e-postadress och varje stripe_id i
   samma sekund, för rättigheten under ligger redan där och väntar. Med
   revoken kvar blir samma slarv ett permission denied i stället.

   VAD FIXEN GÖR — OCH VAD DEN MEDVETET INTE GÖR

   Drar in allt utom exakt det klienten bevisligen använder:

     product_interest   bara INSERT kvar. js/butik.js rad 304 postar med
                        Prefer: resolution=ignore-duplicates, vilket blir
                        INSERT ... ON CONFLICT DO NOTHING och kräver bara
                        insert-rätt.
     access_codes       ingenting kvar. Inlösen går via redeem_code(), som
                        är SECURITY DEFINER.
     report_votes       ingenting kvar. Röstning går via confirm_report /
                        deny_report, som är SECURITY DEFINER.
     reporter_scores    SELECT kvar (policyn scores_read finns och får
                        fortsätta gälla), skrivrätterna bort. publish_score
                        är SECURITY DEFINER och rörs inte.
     subscribers        BARA DELETE dras in. SELECT, INSERT och UPDATE ligger
                        kvar med flit: js/billing.js rad 348 och 388 gör en
                        upsert med Prefer: resolution=merge-duplicates, och
                        Postgres kräver UPDATE-rätt för att över huvud taget
                        planera INSERT ... ON CONFLICT DO UPDATE. Drar man in
                        UPDATE misslyckas även den FÖRSTA skrivningen, och
                        provperiodens rad skapas aldrig. Radsäkerheten (ingen
                        update-policy) är det som stoppar själva skrivningen.
   ===================================================================== */

-- E-postadresser. Klienten ska kunna anmäla intresse, aldrig läsa listan.
revoke all    on public.product_interest from anon, authenticated;
grant  insert on public.product_interest to   anon, authenticated;

-- Koder värda en betald prenumeration. Nås bara av redeem_code().
revoke all on public.access_codes from anon, authenticated;

-- device_id per röst. Nås bara av confirm_report/deny_report/remove_report.
revoke all on public.report_votes from anon, authenticated;

-- device_id per månad. Läsning behålls (policyn scores_read), skrivning bort.
revoke insert, update, delete, truncate on public.reporter_scores from anon, authenticated;

-- E-post och stripe_id. Bara DELETE dras in — se resonemanget ovan om upserten.
revoke delete, truncate on public.subscribers from anon, authenticated;


/* =====================================================================
   VERIFIERING
   =====================================================================

   Kör hela blocket nedan efter filen. Kolumnen "forvantat" säger vad som
   ska stå i "varde". Avviker en rad har fixen inte tagit — läs notiserna
   som DO-blocken skrev ut, de säger vilket objekt som hoppades över.
   ===================================================================== */

select 'FIX 1: definer-funktioner utan pg_temp' as kontroll,
       (select count(*)::text
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
           and p.prokind = 'f'
           and not exists (
                 select 1
                   from unnest(coalesce(p.proconfig, array[]::text[])) as c
                  where c like 'search_path=%'
                    and c like '%pg_temp%')) as varde,
       '0' as forvantat

union all
select 'FIX 1: definer-funktioner med pg_temp (info)',
       (select count(*)::text
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
           and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) as c
                        where c like 'search_path=%' and c like '%pg_temp%')),
       'samma tal som alla definer-funktioner i public (89 i filerna)'

union all
select 'FIX 2: anon kan anropa purge_old_reports',
       case when to_regprocedure('public.purge_old_reports()') is null
            then 'funktionen saknas'
            else (has_function_privilege('anon', to_regprocedure('public.purge_old_reports()')::oid, 'execute')
               or has_function_privilege('authenticated', to_regprocedure('public.purge_old_reports()')::oid, 'execute'))::text
       end,
       'false'

union all
select 'FIX 2: service_role kan anropa purge_old_reports',
       case when to_regprocedure('public.purge_old_reports()') is null
            then 'funktionen saknas'
            else has_function_privilege('service_role', to_regprocedure('public.purge_old_reports()')::oid, 'execute')::text
       end,
       'true'

union all
select 'FIX 3: vyer som anon/authenticated fortfarande kan läsa',
       (select count(*)::text
          from (values ('public.interest_summary'), ('public.facebook_recent'),
                       ('public.facebook_quality'), ('public.facebook_places'),
                       ('public.telegram_senaste'), ('public.telegram_halsa'),
                       ('public.reports_active')) as t(v)
         -- to_regclass ger null för en vy som inte finns, och
         -- has_table_privilege på null ger null i stället för att kasta fel.
         -- Därför oid-varianten och inte namnvarianten här.
         where has_table_privilege('anon',          to_regclass(t.v)::oid, 'select')
            or has_table_privilege('authenticated', to_regclass(t.v)::oid, 'select')),
       '0'

union all
select 'FIX 3: reports_feed läsbar för anon (ska INTE ha stängts)',
       has_table_privilege('anon', 'public.reports_feed', 'select')::text,
       'true'

union all
select 'FIX 3: leaderboard läsbar för anon (ska INTE ha stängts)',
       has_table_privilege('anon', 'public.leaderboard', 'select')::text,
       'true'

union all
select 'FIX 4: product_interest, rättigheter utöver insert',
       (select count(*)::text
          from (values ('select'), ('update'), ('delete')) as p(pr)
         where has_table_privilege('anon', 'public.product_interest', p.pr)
            or has_table_privilege('authenticated', 'public.product_interest', p.pr)),
       '0'

union all
select 'FIX 4: product_interest, insert kvar (appen skriver hit)',
       has_table_privilege('anon', 'public.product_interest', 'insert')::text,
       'true'

union all
select 'FIX 4: access_codes, rättigheter för anon/authenticated',
       (select count(*)::text
          from (values ('select'), ('insert'), ('update'), ('delete')) as p(pr)
         where has_table_privilege('anon', 'public.access_codes', p.pr)
            or has_table_privilege('authenticated', 'public.access_codes', p.pr)),
       '0'

union all
select 'FIX 4: report_votes, rättigheter för anon/authenticated',
       (select count(*)::text
          from (values ('select'), ('insert'), ('update'), ('delete')) as p(pr)
         where has_table_privilege('anon', 'public.report_votes', p.pr)
            or has_table_privilege('authenticated', 'public.report_votes', p.pr)),
       '0'

union all
select 'FIX 4: reporter_scores, skrivrättigheter för anon/authenticated',
       (select count(*)::text
          from (values ('insert'), ('update'), ('delete')) as p(pr)
         where has_table_privilege('anon', 'public.reporter_scores', p.pr)
            or has_table_privilege('authenticated', 'public.reporter_scores', p.pr)),
       '0'

union all
select 'FIX 4: subscribers, delete indragen',
       (has_table_privilege('anon', 'public.subscribers', 'delete')
     or has_table_privilege('authenticated', 'public.subscribers', 'delete'))::text,
       'false'

union all
select 'FIX 4: subscribers, insert+update kvar (upserten i billing.js)',
       (has_table_privilege('anon', 'public.subscribers', 'insert')
    and has_table_privilege('anon', 'public.subscribers', 'update'))::text,
       'true'

union all
select 'Oförändrat: monthly_winners stängd för anon',
       (not has_table_privilege('anon', 'public.monthly_winners', 'select'))::text,
       'true'

union all
select 'Oförändrat: login_lookups stängd för anon',
       (not has_table_privilege('anon', 'public.login_lookups', 'select'))::text,
       'true'

union all
select 'Oförändrat: reports.device_id dold för anon',
       (not has_column_privilege('anon', 'public.reports', 'device_id', 'select'))::text,
       'true'

order by 1;
