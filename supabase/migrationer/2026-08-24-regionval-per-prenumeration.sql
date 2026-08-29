-- =====================================================================
--  Polisvakt — regionval per prenumeration (välj vilka städer)
--  2026-08-24
-- =====================================================================
--
-- INGA BLOCKKOMMENTARER. Bara radkommentarer med två bindestreck — samma skäl
-- som i fbmejl.sql: en tidigare fil dog på "syntax error at or near 5".
--
--
-- VAD DEN LÖSER
--
-- I dag är gruppnotiser EN på/av-knapp (push_subscriptions.gruppnotiser) och
-- notisen går till ALLA som har den på, oavsett stad. När appen läser flera
-- städer (Västerås + Uppsala + Stockholm) ska varje person kunna välja VILKA
-- städer hen vill väckas av.
--
-- Den här filen lägger till förrådet för det valet. Den RÖR INTE routingen
-- ännu — det gör lager 2 (edge-funktionen fbmejl-push filtrerar mottagare på
-- regionen, och fbmejl_notis_ut/bryggan taggar varje varning med sin region).
-- Tills dess är kolumnen bara lagrad; beteendet är oförändrat.
--
--
-- BAKÅTKOMPATIBELT MED FLIT
--
--   regioner IS NULL  = "alla regioner". Varje befintlig prenumerant, och var
--                       och en som aldrig rör väljaren, får allt precis som
--                       förut. Ingen tystnar av att den här filen körs.
--   regioner = '{}'   = uttryckligen inga (samma effekt som gruppnotiser av,
--                       men behålls skild så väljaren kan visa noll ikryssade
--                       utan att slå av hela gruppnotisen).
--   regioner = '{vasteras,stockholm}' = bara de städerna.
--
-- Nycklarna ÄGS av js/regioner.js. Klienten städar valet mot live-regionerna
-- innan det skickas hit; databasen litar inte blint men gör bara en billig
-- rimlighetskoll (kapar längd och tomma strängar), eftersom hela stadslistan
-- bor i koden, inte här.
--
--
-- INNAN DU KÖR
--   1. supabase/push.sql är körd — tabellen push_subscriptions och
--      funktionen public.actor(text) finns.
--   2. Kör som vanligt i Supabase SQL Editor.
--   3. Efteråt körs notify pgrst längst ner så PostgREST ser de nya
--      funktionerna.

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'push.sql är inte körd — hoppar över regionval. Inget att utöka.';
    return;
  end if;

  -- Förrådet. NULL = alla regioner (se ovan).
  alter table public.push_subscriptions
    add column if not exists regioner text[] default null;

  -- SÄTT valet. Speglar fbmejl_satt_gruppnotiser: actor(p_device) avgör vem,
  -- raden matchas på endpoint OCH device_id så ingen kan skriva i någon
  -- annans prenumeration.
  execute $fn$
    create or replace function public.fbmejl_satt_regioner(
      p_endpoint text, p_device text, p_regioner text[]
    )
    returns jsonb
    language plpgsql security definer set search_path = public, pg_temp as $kropp$
    declare
      v_actor text;
      v_rensat text[];
      v_ut   text[];
      v_n    int;
    begin
      v_actor := public.actor(p_device);

      -- Billig rimlighetskoll: null lämnas som null ("alla"), annars kapa
      -- tomma och orimligt långa strängar och ta högst 50 poster. Den riktiga
      -- valideringen mot kända städer gör klienten (js/regioner.js).
      if p_regioner is null then
        v_rensat := null;
      else
        select array(
          select distinct btrim(x)
            from unnest(p_regioner) as x
           where btrim(coalesce(x, '')) <> '' and length(x) <= 40
           limit 50
        ) into v_rensat;
      end if;

      update public.push_subscriptions s
         set regioner = v_rensat,
             updated_at = now()
       where s.endpoint = p_endpoint and s.device_id = v_actor
      returning s.regioner into v_ut;

      get diagnostics v_n = row_count;

      if v_n = 0 then
        return jsonb_build_object('ok', false, 'rader', 0, 'skal', 'ingen-rad');
      end if;

      return jsonb_build_object('ok', true, 'rader', v_n,
                                'regioner', to_jsonb(v_ut), 'skal', null);
    end $kropp$;
  $fn$;

  -- LÄS tillbaka sanningen. Appen ska aldrig lita på sitt eget localStorage
  -- för det här — samma princip som fbmejl_har_gruppnotiser.
  execute $fn2$
    create or replace function public.fbmejl_har_regioner(
      p_endpoint text, p_device text
    )
    returns jsonb
    language plpgsql security definer stable set search_path = public, pg_temp as $kropp2$
    declare
      v_actor text;
      v_reg   text[];
      v_finns boolean := false;
    begin
      v_actor := public.actor(p_device);

      select s.regioner, true
        into v_reg, v_finns
        from public.push_subscriptions s
       where s.endpoint = p_endpoint and s.device_id = v_actor;

      if not v_finns then
        return jsonb_build_object('finns', false, 'regioner', null);
      end if;

      -- null i databasen betyder "alla" — skickas som null, klienten tolkar.
      return jsonb_build_object('finns', true, 'regioner', to_jsonb(v_reg));
    end $kropp2$;
  $fn2$;

  execute 'revoke execute on function public.fbmejl_satt_regioner(text, text, text[]) from public';
  execute 'grant execute on function public.fbmejl_satt_regioner(text, text, text[]) to anon, authenticated';
  execute 'revoke execute on function public.fbmejl_har_regioner(text, text) from public';
  execute 'grant execute on function public.fbmejl_har_regioner(text, text) to anon, authenticated';

  raise notice 'regionval klart: push_subscriptions.regioner + fbmejl_satt_regioner/fbmejl_har_regioner.';
end $$;

notify pgrst, 'reload schema';
