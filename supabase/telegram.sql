-- =====================================================================
-- TELEGRAM-BRYGGAN — serversidan
-- =====================================================================
--
-- Kör hela filen i Supabase SQL Editor. Den är idempotent och går att köra
-- om hur många gånger som helst; ingenting här raderar rapporter.
--
-- Beroenden, i ordning:
--   supabase/schema.sql          reports, RLS, purge_old_reports
--   supabase/kvalitetsfalt.sql   kvalitetskolumnerna på reports
--   supabase/facebook.sql        index och revisionsvyer (rekommenderas)
--
-- ---------------------------------------------------------------------
-- Varför den här filen finns
--
-- Facebook-gruppen "Här står polisen" går inte att läsa maskinellt — Meta
-- stängde Groups API för inläggsläsning 2024. Vägen som återstår är att en
-- gruppadmin speglar inläggen till en Telegram-kanal, och att vi läser den
-- kanalen med Telegrams riktiga bot-API.
--
-- Boten pollas på SERVERSIDAN. Det är inte en detalj: en bot-token i en
-- webbapp är samma sak som att ge bort boten, och appens anon-nyckel ligger
-- öppet i källkoden. Ingenting i den här filen får därför gå att anropa med
-- anon-nyckeln.
--
-- ---------------------------------------------------------------------
-- Modellen, kort
--
--   telegram_lasta      vilka meddelanden som redan är avgjorda. Avdubbling.
--   telegram_brygga     var pollningen står (update_id) och hur den mår.
--   telegram_ta_emot()  tar emot färdigtolkade rader och skapar rapporter.
--   telegram_senaste    revisionsvy: vad kom in senaste dygnet.
--   telegram_halsa      revisionsvy: går bryggan alls, och håller den måttet.
--
-- Tolkningen görs INTE här. Den ligger i js/telegram.js, som anropar samma
-- js/parser.js som rösten och knapparna använder. Att skriva om parsern i
-- plpgsql hade gett två ordlistor som glider isär, och den ena av dem är
-- nykterhetsfiltret. Servern har istället ett grovt nät under parsern — se
-- telegram_ar_nykterhetskontroll() — som bara kan avvisa MER, aldrig släppa
-- igenom mer.
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

-- ============================ LÄSTA MEDDELANDEN ======================
--
-- Ett meddelande får bli en rapport en gång. Pollningsfönster överlappar,
-- Telegram skickar om allt som inte kvitterats, en omstart innan offset
-- hunnit sparas spelar upp samma kö igen — utan den här tabellen blir samma
-- inlägg en ny varning varje gång.
--
-- Två nycklar, för de fångar olika fel:
--   nyckel       'tg:<chat>:<message_id>'. Meddelandets egen identitet.
--   text_nyckel  'tx:<hash>:<fack>'. Samma text i samma tidsfönster, oavsett
--                meddelande-id. Fångar när samma inlägg speglas en gång till.
--
-- Raden skrivs även för det som INTE blev en rapport. En vägrad
-- nykterhetskontroll ska inte prövas igen vid nästa pollning.

create table if not exists public.telegram_lasta (
  nyckel      text primary key,
  text_nyckel text,
  chat_id     text,
  message_id  bigint,
  utfall      text not null default 'okand'
              check (utfall in ('rapport', 'vagrad', 'bortsorterad', 'okand')),
  skal        text,
  rapport_id  text references public.reports(id) on delete set null,
  last_at     timestamptz not null default now()
);

create index if not exists telegram_lasta_text_idx on public.telegram_lasta (text_nyckel);
create index if not exists telegram_lasta_tid_idx  on public.telegram_lasta (last_at desc);

alter table public.telegram_lasta enable row level security;

-- Inga policies, med flit. Radsäkerhet utan policy betyder att ingen som
-- kommer in via PostgREST ser eller skriver någonting alls — varken anon
-- eller inloggade. Tabellen nås bara av funktionerna nedan, som är security
-- definer, och av service_role i SQL-editorn.
revoke all on public.telegram_lasta from anon, authenticated;

-- ============================ BRYGGANS TILLSTÅND =====================
--
-- Telegram levererar uppdateringar med ett löpande update_id. Kvitterar man
-- inte hur långt man kommit spelas hela kön om vid varje start, och timmar
-- gamla varningar dyker upp som nya. En rad, alltid id = 1.

create table if not exists public.telegram_brygga (
  id                smallint primary key default 1 check (id = 1),
  senaste_update_id bigint not null default 0,
  senast_kord       timestamptz,
  senaste_fel       text,
  uppdaterad        timestamptz not null default now()
);

insert into public.telegram_brygga (id) values (1) on conflict (id) do nothing;

alter table public.telegram_brygga enable row level security;
revoke all on public.telegram_brygga from anon, authenticated;

-- ============================ SISTA NÄTET ============================
--
-- Nykterhets- och drogkontroller blir aldrig rapporter. Det är produktregel
-- nummer ett i appen, och den avgörs i js/parser.js — det är den enda
-- ordlista som räknas, och den gäller rösten, knapparna och gruppen lika.
--
-- Funktionen nedan är inte en andra parser. Den är ett grovt nät under den
-- riktiga, för databasen är det sista stället där en rapport kan stoppas och
-- tolkningen sker på en maskin någon annanstans. Nätet är MEDVETET för brett:
-- "alkohol" räcker, utan att kräva ordet "kontroll" efter. Ett bortsorterat
-- inlägg om alkohol kostar ingenting. Ett släppt kostar hela produktregeln.
--
-- Regeln är därför enkelriktad: den kan bara avvisa mer än parsern, aldrig
-- släppa igenom något parsern stoppat. Släpper man till här slutar den vara
-- ett skydd och blir en andra sanning.

create or replace function public.telegram_ar_nykterhetskontroll(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select lower(coalesce(p_text, '')) ~
    '(nykter|alkohol|alkotest|promille|rattfyll|utandnings|sållnings|sallnings|drogkontroll|drogtest|drog ?kontroll|drog ?test|blåser|blåsa|blåste|blaser)';
$$;

-- ============================ TA EMOT ================================
--
-- Anropas av pollaren med en json-array av färdigtolkade rader. Varje rad är
-- det js/telegram.js byggRapport() lämnar ifrån sig, plus text_nyckel för
-- avdubblingen och chat_id/message_id för revisionen.
--
-- Funktionen är security definer eftersom den skriver till reports förbi
-- radsäkerheten (det finns ingen insert-policy som tillåter external_id från
-- en tredje part). Den är därför också åtkomstskyddad hårt längre ner: bara
-- service_role får anropa den. Ingen anon-nyckel i världen ska kunna lägga
-- rapporter i gruppens namn.
--
-- Returnerar en sammanfattning i json så pollaren kan logga vad som hände.

create or replace function public.telegram_ta_emot(p_rader jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_rad         jsonb;
  v_nyckel      text;
  v_text_nyckel text;
  v_note        text;
  v_id          text;
  v_typ         text;
  v_skrivna     int;
  v_mottagna    int := 0;
  v_skapade     int := 0;
  v_dubbletter  int := 0;
  v_vagrade     int := 0;
  v_ogiltiga    int := 0;
begin
  if p_rader is null or jsonb_typeof(p_rader) <> 'array' then
    return jsonb_build_object('fel', 'p_rader maste vara en json-array');
  end if;

  for v_rad in select * from jsonb_array_elements(p_rader) loop
    v_mottagna    := v_mottagna + 1;
    v_nyckel      := nullif(v_rad->>'external_id', '');
    v_text_nyckel := nullif(v_rad->>'text_nyckel', '');
    v_note        := coalesce(v_rad->>'note', '');
    v_typ         := v_rad->>'type';

    -- Utan external_id finns ingen avdubbling, och då blir samma inlägg en ny
    -- varning vid varje pollning. Raden avvisas hellre än skrivs.
    if v_nyckel is null or v_typ is null
       or (v_rad->>'lat') is null or (v_rad->>'lon') is null then
      v_ogiltiga := v_ogiltiga + 1;
      continue;
    end if;

    -- Kameror kommer aldrig hit från js/telegram.js, men om någon bygger en
    -- fjärde väg in ska svaret vara detsamma: de 136 kamerorna i Västmanland
    -- ligger redan i appen med rätt position och mätriktning.
    if v_typ = 'camera' then
      v_vagrade := v_vagrade + 1;
      insert into telegram_lasta (nyckel, text_nyckel, chat_id, message_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_rad->>'chat_id',
              (v_rad->>'message_id')::bigint, 'vagrad', 'kamera')
      on conflict (nyckel) do nothing;
      continue;
    end if;

    perform 1 from telegram_lasta
     where nyckel = v_nyckel
        or (v_text_nyckel is not null and text_nyckel = v_text_nyckel);
    if found then
      v_dubbletter := v_dubbletter + 1;
      continue;
    end if;

    if public.telegram_ar_nykterhetskontroll(v_note) then
      v_vagrade := v_vagrade + 1;
      insert into telegram_lasta (nyckel, text_nyckel, chat_id, message_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_rad->>'chat_id',
              (v_rad->>'message_id')::bigint, 'vagrad', 'nykterhet')
      on conflict (nyckel) do nothing;
      continue;
    end if;

    -- Primärnyckeln är slumpad med flit. Vore den härledd ur meddelande-id:t
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
      -- Källan sätts HÄR, inte av den som anropar. En pollare som råkar
      -- skicka source = 'app' ska inte kunna få gruppens andrahandsuppgifter
      -- graderade som en förares egen knapptryckning i js/kvalitet.js.
      'facebook',
      coalesce(nullif(v_rad->>'device_id', ''), 'tg-bridge'),
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
      insert into telegram_lasta (nyckel, text_nyckel, chat_id, message_id, utfall, rapport_id)
      values (v_nyckel, v_text_nyckel, v_rad->>'chat_id',
              (v_rad->>'message_id')::bigint, 'rapport', v_id)
      on conflict (nyckel) do update set rapport_id = excluded.rapport_id,
                                         utfall = 'rapport';
    else
      -- Fanns redan i reports men inte i telegram_lasta: minnet hade rensats
      -- eller raden kom in via userscriptet. Skriv minnet, räkna som dubblett.
      v_dubbletter := v_dubbletter + 1;
      insert into telegram_lasta (nyckel, text_nyckel, chat_id, message_id, utfall, skal)
      values (v_nyckel, v_text_nyckel, v_rad->>'chat_id',
              (v_rad->>'message_id')::bigint, 'bortsorterad', 'fanns-redan')
      on conflict (nyckel) do nothing;
    end if;
  end loop;

  update public.telegram_brygga
     set senast_kord = now(), senaste_fel = null, uppdaterad = now()
   where id = 1;

  return jsonb_build_object(
    'mottagna',   v_mottagna,
    'skapade',    v_skapade,
    'dubbletter', v_dubbletter,
    'vagrade',    v_vagrade,
    'ogiltiga',   v_ogiltiga
  );
end $$;

-- ============================ POLLNINGENS LÄGE =======================

create or replace function public.telegram_offset()
returns bigint
language sql
security definer
stable
set search_path = public as $$
  select coalesce(max(senaste_update_id), 0) from public.telegram_brygga where id = 1;
$$;

create or replace function public.telegram_satt_offset(p_offset bigint, p_fel text default null)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  -- greatest() med flit: offset får bara gå framåt. Ett svar som kommer i fel
  -- ordning ska aldrig kunna backa kön och spela upp gamla varningar igen.
  update public.telegram_brygga
     set senaste_update_id = greatest(senaste_update_id, coalesce(p_offset, 0)),
         senast_kord = now(),
         senaste_fel = left(p_fel, 500),
         uppdaterad = now()
   where id = 1;
end $$;

-- ============================ STÄDNING ===============================
--
-- Minnet behöver inte vara längre än pollningen kan hoppa. Efter fjorton
-- dagar är inläggen sedan länge borta ur kanalen, och reports_external_id_key
-- är sista spärren ändå.

create or replace function public.stada_telegram_lasta()
returns int
language plpgsql
security definer
set search_path = public as $$
declare n int;
begin
  delete from telegram_lasta where last_at < now() - interval '14 days';
  get diagnostics n = row_count;
  return n;
end $$;

-- ============================ RÄTTIGHETER ============================
--
-- Ingenting här får gå att anropa med anon-nyckeln. telegram_ta_emot skriver
-- förbi radsäkerheten; kunde vem som helst anropa den vore hela insert-
-- policyn i schema.sql meningslös — man skulle kunna lägga ut vad som helst
-- i gruppens namn, med valfri position och valfri livslängd.

revoke execute on function public.telegram_ta_emot(jsonb)              from public, anon, authenticated;
revoke execute on function public.telegram_offset()                    from public, anon, authenticated;
revoke execute on function public.telegram_satt_offset(bigint, text)   from public, anon, authenticated;
revoke execute on function public.stada_telegram_lasta()               from public, anon, authenticated;

grant execute on function public.telegram_ta_emot(jsonb)               to service_role;
grant execute on function public.telegram_offset()                     to service_role;
grant execute on function public.telegram_satt_offset(bigint, text)    to service_role;
grant execute on function public.stada_telegram_lasta()                to service_role;

-- Nätet får läsas av alla — det avslöjar ingenting och är bekvämt att kunna
-- prova i editorn.
grant execute on function public.telegram_ar_nykterhetskontroll(text)  to anon, authenticated, service_role;

-- ============================ REVISIONSVYER ==========================
--
-- Läses i SQL-editorn, inte av appen. Inga grants till anon: kolumnen note
-- innehåller andra människors text ordagrant och ska inte gå att hämta med
-- den publika nyckeln. Samma resonemang som i facebook.sql.

create or replace view public.telegram_senaste
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
  where r.device_id = 'tg-bridge'
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 24 * 3600 * 1000
  order by r.created_at desc;

-- Går bryggan alls? Den vanligaste frågan efter en vecka i drift, och den
-- går inte att besvara från appen — där ser "inga rapporter" och "bryggan är
-- död" exakt likadant ut.
create or replace view public.telegram_halsa
with (security_invoker = on) as
  select
    b.senaste_update_id,
    b.senast_kord,
    b.senaste_fel,
    round(extract(epoch from now() - b.senast_kord) / 60.0)      as minuter_sedan_koring,
    (select count(*) from public.telegram_lasta
      where last_at > now() - interval '24 hours')               as lasta_dygn,
    (select count(*) from public.telegram_lasta
      where utfall = 'rapport' and last_at > now() - interval '24 hours') as rapporter_dygn,
    (select count(*) from public.telegram_lasta
      where utfall = 'vagrad'  and last_at > now() - interval '24 hours') as vagrade_dygn,
    (select count(*) from public.reports
      where device_id = 'tg-bridge' and denials > 0
        and created_at > (extract(epoch from now()) * 1000)::bigint - 7 * 24 * 3600 * 1000)
                                                                 as nedrostade_veckan
  from public.telegram_brygga b
  where b.id = 1;

commit;

-- ============================ SCHEMALÄGGNING =========================
--
-- Två jobb, och bara det ena bor i databasen.
--
-- 1. Städningen. Ren SQL, schemaläggs direkt här nedan om pg_cron finns.
--
-- 2. Pollningen. Den måste ut på nätet till api.telegram.org och kan alltså
--    inte vara ren SQL. Den kör i en edge-funktion (telegram-poll), som
--    anropas antingen från Dashboard -> Edge Functions -> Schedules eller
--    från pg_cron via pg_net. Se docs/telegram-brygga.md.
--
-- OBS för den som redigerar filen: skriv aldrig ett cron-uttryck inuti en
-- blockkommentar. En stjärna följd av snedstreck avslutar kommentaren mitt i
-- raden, och resten tolkas som SQL. Hela filen dör då på "syntax error at or
-- near 5". Därför är hela den här filen skriven med radkommentarer.

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — kör "select public.stada_telegram_lasta();" manuellt då och då.';
    return;
  end if;
  perform 1 from cron.job where jobname = 'polisvakt-telegram-stada';
  if found then perform cron.unschedule('polisvakt-telegram-stada'); end if;
  perform cron.schedule('polisvakt-telegram-stada', '50 4 * * *',
                        'select public.stada_telegram_lasta();');
  raise notice 'Städning av telegram_lasta schemalagd 04:50 varje natt.';
exception when others then
  raise notice 'Kunde inte schemalägga städningen (%). Kör funktionen manuellt då och då.', sqlerrm;
end $$;

-- Pollningen, om du vill ha den i databasen istället för i Dashboard.
--
-- Kräver att edge-funktionen telegram-poll är utrullad och att de två
-- nycklarna är satta som databasinställningar. Nycklarna får ALDRIG stå i
-- klartext i cron.job — den tabellen är läsbar för alla med databasåtkomst
-- och följer med i varje backup:
--
--   alter database postgres set app.service_role_key = 'eyJ...';
--   alter database postgres set app.telegram_poll_url =
--     'https://<projekt>.supabase.co/functions/v1/telegram-poll';
--
-- Blocket nedan gör ingenting förrän telegram_poll_url är satt.

do $$
declare v_url text;
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — schemalägg telegram-poll i Dashboard -> Edge Functions -> Schedules.';
    return;
  end if;
  perform 1 from pg_extension where extname = 'pg_net';
  if not found then
    raise notice 'pg_net saknas — schemalägg telegram-poll i Dashboard -> Edge Functions -> Schedules.';
    return;
  end if;

  v_url := current_setting('app.telegram_poll_url', true);
  if v_url is null or v_url = '' then
    raise notice 'app.telegram_poll_url är inte satt — pollningen schemaläggs inte. Se docs/telegram-brygga.md.';
    return;
  end if;

  perform 1 from cron.job where jobname = 'polisvakt-telegram';
  if found then perform cron.unschedule('polisvakt-telegram'); end if;

  -- Varannan minut. Telegram sparar uppdateringar i 24 timmar, så ett missat
  -- fönster tappar ingenting — men en varning som är en halvtimme gammal är
  -- värdelös, och js/telegram.js kastar den ändå.
  perform cron.schedule('polisvakt-telegram', '*/2 * * * *', format($jobb$
    select net.http_post(
      url     := %L,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce(current_setting('app.service_role_key', true), '')
      ),
      body    := jsonb_build_object('kalla', 'pg_cron')
    );
  $jobb$, v_url));
  raise notice 'Telegram-pollningen schemalagd varannan minut.';
exception when others then
  raise notice 'Kunde inte schemalägga pollningen (%). Använd Dashboard -> Edge Functions -> Schedules istället.', sqlerrm;
end $$;

-- ============================ KONTROLL ===============================
--
-- Kör de här efteråt för att se att det blev rätt.
--
-- 1. Produktregeln, i databasen. Ska ge true, true, false:
--
--      select public.telegram_ar_nykterhetskontroll('Nykterhetskontroll vid Bäckby'),
--             public.telegram_ar_nykterhetskontroll('polisen blåser alla vid E18'),
--             public.telegram_ar_nykterhetskontroll('Polis står vid Erikslund');
--
-- 2. Rättigheterna. INGEN rad får innehålla anon eller authenticated:
--
--      select p.proname, r.rolname
--        from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        cross join lateral aclexplode(p.proacl) a
--        join pg_roles r on r.oid = a.grantee
--       where n.nspname = 'public'
--         and p.proname in ('telegram_ta_emot','telegram_offset',
--                           'telegram_satt_offset','stada_telegram_lasta');
--
-- 3. Radsäkerheten. Ska ge rowsecurity = true och noll policyer:
--
--      select relrowsecurity from pg_class where relname = 'telegram_lasta';
--      select count(*) from pg_policies where tablename = 'telegram_lasta';
--
-- 4. Avdubblingen, på riktigt. Kör två gånger — andra gången ska ge
--    skapade 0 och dubbletter 1:
--
--      select public.telegram_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'tg:-100test:1', 'text_nyckel', 'tx:test:1',
--        'type', 'police', 'lat', 59.6099, 'lon', 16.5448,
--        'label', 'Testplats', 'note', 'Polis står vid testplatsen',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000,
--        'parser_confidence', 0.9, 'geokod', 'nominatim', 'geokod_typ', 'vag',
--        'fordrojning_s', 120)));
--
--    Städa upp efteråt:
--
--      delete from public.telegram_lasta where nyckel = 'tg:-100test:1';
--      delete from public.reports where external_id = 'tg:-100test:1';
--
-- 5. Nätet, på riktigt. Ska ge skapade 0 och vagrade 1:
--
--      select public.telegram_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'tg:-100test:2', 'type', 'police',
--        'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplats',
--        'note', 'Nykterhetskontroll vid testplatsen',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000)));
--
-- 6. Hälsan, när bryggan väl går:
--
--      select * from public.telegram_halsa;
--      select * from public.telegram_senaste;
--
-- Gick en omgång fel och la ut skräp? Så här släcks den utan att historiken
-- raderas — rapporterna försvinner ur appen inom en pollningscykel, men
-- raderna finns kvar att granska:
--
--   update public.reports
--      set removed = true,
--          expires_at = (extract(epoch from now()) * 1000)::bigint
--    where device_id = 'tg-bridge'
--      and created_at > (extract(epoch from now()) * 1000)::bigint - 3600 * 1000;
-- =====================================================================
