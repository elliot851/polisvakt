-- Migration: gruppnotiser pa som forval, for alla.
--
-- Kor hela filen i Supabase SQL Editor. Den andrar ETT kolumnforval och
-- skriver om befintliga rader. Ingen tabell skapas, ingen rad raderas.
--
--
-- VAD SOM ANDRAS, OCH VARFOR DET VAR TVARTOM FORUT
--
-- Kolumnen las forut 'default false', och det var ett medvetet val. Motivet
-- star kvar har for den som undrar: en livlig grupp kan ge tiotals inlagg i
-- timmen, och den som far for manga notiser stanger av dem for HELA appen i
-- telefonens installningar. Da tystnar korpaminnelsen med, och den ar det
-- enda som far nagon att slaa pa appen innan de akr.
--
-- Agaren har vagt det mot att en varning som ingen ser ar vardelos, och valt
-- pa. Det ar ratt avvagning sa lange takten haller, och den gor den:
--
--   hogst en notis per omgang       fbmejl_notis_ut
--   minst tio minuter emellan       p_min_minuter
--   tyst mellan 23 och 06           svensk tid, inte UTC
--   hogst tolv per dygn             p_tak_per_dygn
--   nykterhetskontroller aldrig     fbmejl_ar_nykterhetskontroll
--
-- Utan de sparrarna hade det har varit fel beslut. Med dem far en forare som
-- mest tolv korta rader per dygn, aldrig mitt i natten.
--
--
-- OM DU ANGRAR DIG
--
--   alter table public.push_subscriptions alter column gruppnotiser set default false;
--
-- Befintliga rader pavarkas inte av det -- var och en behaller sitt val, och
-- det ar meningen. Ett forval ska styra nya prenumerationer, inte skriva om
-- vad nagon redan bestamt.

alter table public.push_subscriptions
  alter column gruppnotiser set default true;

-- Befintliga rader far ocksa pa, en gang.
--
-- Det ar det enda stallet i migrationen som ror data nagon annan aget. Det
-- gors med flit och bara har: alternativet vore att befintliga anvandare
-- aldrig fick gruppnotiser fast forvalet sager att de ska, vilket ar precis
-- den sortens tysta halvatgard som gjort att den har kedjan varit trasig i
-- tre led.
update public.push_subscriptions
   set gruppnotiser = true
 where gruppnotiser is distinct from true;

-- Kontroll: hur manga mottagare finns det nu?
select 'prenumerationer' as vad, count(*)::text as varde from public.push_subscriptions
union all
select 'med gruppnotiser pa', count(*)::text from public.push_subscriptions where gruppnotiser
union all
select 'mottagare enligt servern', public.fbmejl_gruppnotis_antal()::text
union all
select 'kolumnforval', coalesce((
  select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'push_subscriptions'
     and column_name = 'gruppnotiser'), 'okant');
