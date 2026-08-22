-- Migration: koordinaterna med i notisvägen — filtret vaknar.
--
-- Kör den här EFTER supabase/migrationer/2026-08-22-notisradie.sql.
--
-- ---------------------------------------------------------------------
-- VARFÖR
--
-- Avståndsfiltret i notisradie-migrationen jämför rapportens koordinat mot
-- telefonens hemtrakt. Men fbmejl_ta_emot() skickade bara fyra fält vidare
-- till notisen — typ, plats, utrustning, created_at — och alltså ingen
-- koordinat alls.
--
-- Följden var ett filter som såg färdigt ut och inte gjorde någonting:
-- fbmejl_notis_ut() fick noll punkter, tolkade det som "vet inte var det här
-- hände" och skickade till alla. Exakt dagens beteende, alltså osynligt i
-- varje test man gör innan en andra stad kopplas in.
--
-- Den här filen är ENDA ändringen: två fält i ett jsonb_build_object.
-- Funktionskroppen är i övrigt ordagrant den ur supabase/fbmejl.sql, som är
-- källan. Skulle de två någonsin gå isär är det fbmejl.sql som gäller.
--
-- lat och lon går ALDRIG ut i en notistext. De läses bara av grinden för att
-- avgöra vem som ska få notisen. Resonemanget om varför råtexten aldrig får
-- följa med står kvar ovanför fältlistan och gäller oförändrat.

set local statement_timeout = '60s';

do $forkontroll$
begin
  -- Vakten frågar efter avståndsfunktionen, inte efter fbmejl_notis_ut.
  -- notis_ut har funnits länge och har dessutom fem argument, så en vakt på
  -- den hade svarat "kör notisradie först" även när den redan var körd.
  if to_regprocedure(
       'public.fbmejl_avstand_m(double precision, double precision, double precision, double precision)'
     ) is null then
    raise exception 'Kör supabase/migrationer/2026-08-22-notisradie.sql först.';
  end if;
end
$forkontroll$;

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
      --
      -- lat och lon är SEX fält i stället för fyra, och de bryter inte mot
      -- resonemanget ovan: de går aldrig ut i en notistext. De läses bara av
      -- fbmejl_notis_ut() för att avgöra VEM som ska få notisen — se
      -- supabase/migrationer/2026-08-22-notisradie.sql.
      --
      -- Utan de här två raderna är hela avståndsfiltret sovande. Grinden får
      -- då noll punkter, tolkar det som "vet inte var det här hände" och
      -- skickar till alla, vilket är dagens beteende och alltså osynligt.
      -- Den dagen den nationella gruppen kopplas in blir samma tystnad till
      -- en laserkontroll i Malmö klockan sju på morgonen, i Västerås.
      v_nya := v_nya || jsonb_build_array(jsonb_build_object(
        'typ',        v_typ,
        'plats',      left(coalesce(nullif(v_rad->>'label', ''), ''), 60),
        'utrustning', public.fbmejl_utrustning(v_note),
        'created_at', (v_rad->>'created_at')::bigint,
        'lat',        (v_rad->>'lat')::double precision,
        'lon',        (v_rad->>'lon')::double precision
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

-- ---------------------------------------------------------------------
-- RÄTTIGHETER — samma som förut. fbmejl_ta_emot är revokad från anon med
-- flit: den skriver rapporter OCH utlöser notiser.
revoke execute on function public.fbmejl_ta_emot(jsonb) from public, anon, authenticated;
grant  execute on function public.fbmejl_ta_emot(jsonb) to service_role;

-- ---------------------------------------------------------------------
-- EFTERKONTROLL: läser funktionen nu fältet lat?
do $prov$
declare n int;
begin
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'fbmejl_ta_emot'
     and p.prosrc like '%''lat''%';
  if n = 0 then
    raise exception 'FILTRET ÄR FORTFARANDE SOVANDE: fbmejl_ta_emot skickar ingen lat.';
  end if;
  raise notice 'Filtret är vaket: fbmejl_ta_emot skickar med koordinaterna.';
end
$prov$;
