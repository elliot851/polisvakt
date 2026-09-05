-- =====================================================================
-- LANSERINGSKOLL — kör i Supabase SQL Editor så fort projektet är väckt
-- =====================================================================
--
-- Rent läsande. Ändrar ingenting. Varje rad ska ge det som står i
-- kommentaren; en avvikelse betyder att en migration saknas eller att en
-- fil körts om i fel ordning (se varningshuvudena i fbmejl.sql, schema.sql,
-- chatt.sql). Byggd ur backend-granskningen 2026-09-05.

-- 1. Betalkedjan (hamta_konto_prenumeration anropas av js/billing.js:305 och
--    definieras BARA i migrationer/2026-08-23-provperiod-pa-kontot.sql).
--    Saknas den faller appen tyst tillbaka på enhetsvägen: provperioden styrs
--    då av klientens klocka och kontokravet går att kringgå.
select
  to_regproc('public.hamta_konto_prenumeration')  as konto_prenumeration,  -- ska INTE vara null
  to_regclass('public.payment_events')            as payment_events,       -- ska INTE vara null
  to_regproc('public.set_paid_until')             as set_paid_until,       -- ska INTE vara null
  (select count(*) from pg_trigger
    where tgname = 'subscribers_guard_paid_until')  as guard_trigger;        -- ska vara 1

-- 2. Notisrutten: radiefiltret och åldersgrinden lever bara i migrationerna
--    (notisradie + aldersgrind). Har fbmejl.sql körts om efteråt är kropparna
--    utbytta mot versionerna utan filter → alla får allt, timgamla repriser
--    inräknade. Kroppen ska innehålla radie-/åldersord.
select
  proname,
  position('radie' in lower(prosrc)) > 0
    or position('avstand' in lower(prosrc)) > 0
    or position('haversine' in lower(prosrc)) > 0        as har_radiefilter,   -- ska vara true för notis_ut/push_mottagare
  position('alder' in lower(prosrc)) > 0
    or position('minuter' in lower(prosrc)) > 0          as har_aldersgrind    -- ska vara true för notis_ut
from pg_proc
where proname in ('fbmejl_notis_ut', 'fbmejl_push_mottagare');

-- 3. Chatten: vyn chatt_flode måste ha kolumnen omrade (chatt-omrade.sql).
--    Saknas den svarar PostgREST 400 på klientens omrade=in.(...) och chatten
--    är död för alla.
select count(*) as chatt_flode_har_omrade                      -- ska vara 1
from information_schema.columns
where table_schema = 'public' and table_name = 'chatt_flode' and column_name = 'omrade';

-- 4. device_id får inte läcka till anon (dolj-enhets-id + security_invoker på
--    reports_active). Med ett device_id kan vem som helst radera/rösta i andras
--    namn via remove_report/confirm_report.
select
  c.relname,
  coalesce((select option_value from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'), 'off') as security_invoker   -- ska vara 'on' för reports_active
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('reports_active', 'monthly_winners');

-- 5. Belöningsliggaren: efter att manadsbelaning.sql körts om ska
--    notera_bidrag innehålla auth.uid()-spärren.
select position('auth.uid() is null' in prosrc) > 0 as belonings_sparr   -- ska vara true
from pg_proc where proname = 'notera_bidrag';

-- 6. Röktestets spöke: en fejkad "Polis vid Erikslund" får inte ligga kvar.
select count(*) as testrader_i_kon                             -- ska vara 0
from public.fbmejl_ko where message_id like 'test-%';

-- 7. Bryggan hittar hem: senaste inkomna rapport från bryggan.
select max(inserted_at) as senaste_bryggrapport                -- ska vara nyligen efter att bryggan svept
from public.reports where device_id in ('fbmejl-bridge', 'tg-bridge') or source = 'facebook';
