-- Polisvakt — Facebook-ingesten
--
-- Kör efter supabase/schema.sql. Filen är idempotent och går att köra om.
--
-- Innehåller inga nya tabeller. Allt som kommer in från gruppen hamnar i
-- reports precis som en rapport från appen, med source = 'facebook' och ett
-- external_id som gör att samma inlägg aldrig kan bli två varningar. Det som
-- läggs till här är index, en spärr som gör dedupen obligatorisk, och tre
-- vyer för att se om ingesten håller kvalitet — den frågan går inte att
-- besvara från appen, för där ser en felaktig varning ut precis som en riktig.

/* ============================== INDEX =============================== */

-- Notera att det INTE finns något create index på external_id här. Kolumnen
-- är deklarerad "text unique" i schema.sql, och en unique-deklaration skapar
-- redan ett index (reports_external_id_key). Ett till hade bara kostat
-- skrivtid vid varje insert utan att göra en enda läsning snabbare.

-- Revisionsvyerna nedan filtrerar alltid på source och sorterar på tid. Utan
-- det här indexet blir det en full scan av hela reports varje gång.
create index if not exists reports_source_created_idx
  on public.reports (source, created_at desc);

/* ========================= DEDUP ÄR OBLIGATORISK ==================== */

/**
 * En rad från en brygga utan external_id går inte att deduplicera, och då blir
 * samma inlägg en ny varning för varje skanning. Spärren nedan gör det omöjligt
 * att skriva så av misstag när någon bygger en tredje brygga om ett halvår.
 *
 * Den är MEDVETET inte påslagen. Appens gamla väg in — window.polisvakt.ingest
 * i js/app.js — går via store.add(), som inte känner till external_id och alltså
 * skriver source = 'facebook' med external_id null. Slår du på spärren innan den
 * vägen bytts mot js/facebook.js börjar de skrivningarna avvisas med 400, och
 * felet syns bara i konsolen hos den som råkar ha appen öppen.
 *
 * Kör alltså det här först när ingesten går genom js/facebook.js:
 *
 *   alter table public.reports
 *     add constraint reports_bridge_needs_external_id
 *     check (source <> 'facebook' or external_id is not null) not valid;
 *
 * NOT VALID betyder att gamla rader lämnas i fred och bara nya kontrolleras.
 * Vill du göra regeln fullständig efteråt: rensa facebook-rader utan
 * external_id och kör
 *
 *   alter table public.reports validate constraint reports_bridge_needs_external_id;
 */

-- Så här ser du om vägen är fri att slå på spärren. Noll rader = kör på.
-- select count(*) from public.reports where source = 'facebook' and external_id is null;

/* ====================== VAD KOM IN SENASTE DYGNET =================== */

/**
 * Rå lista att ögna igenom. Jämför label mot note: står det "polis vid Hälla"
 * i inlägget men label blev en gata i Sala har geokodningen missat, och då
 * hör platsen hemma i data/aliases.vasteras.json.
 *
 * Vyn läses i SQL-editorn, inte av appen. Därför inga grants till anon —
 * kolumnen note innehåller andra människors text ordagrant, och den ska inte
 * gå att hämta med den publika nyckeln. Appen läser reports_feed som vanligt.
 */
create or replace view public.facebook_recent
with (security_invoker = on) as
  select
    to_char(to_timestamp(r.created_at / 1000.0) at time zone 'Europe/Stockholm',
            'YYYY-MM-DD HH24:MI')                        as tid,
    r.type                                               as typ,
    r.label                                              as plats,
    r.note                                               as inlagg,
    r.confirms - 1                                       as bekraftelser,
    r.denials                                            as nedrostningar,
    case
      when r.removed then 'borttagen'
      when r.denials >= 3 and r.denials > r.confirms then 'nedröstad'
      when r.expires_at > (extract(epoch from now()) * 1000)::bigint then 'aktiv'
      else 'utgången'
    end                                                  as status,
    round((r.expires_at - r.created_at) / 60000.0)       as livslangd_min,
    r.device_id                                          as brygga,
    r.external_id,
    r.lat, r.lon,
    r.id
  from public.reports r
  where r.source = 'facebook'
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 24 * 3600 * 1000
  order by r.created_at desc;

/* =========================== HÅLLER DEN MÅTTET? ===================== */

/**
 * Nedröstningar är den enda ärliga kvalitetsmätaren vi har. Ingen orkar
 * rapportera att en varning stämde, men falska varningar röstas ner direkt.
 *
 * Tumregel: kryper andel_nedrostade över ungefär 15 % är det parsern eller
 * geokodningen som brister, inte användarna. Höj MIN_CONFIDENCE i bryggan
 * innan du ändrar något annat.
 */
create or replace view public.facebook_quality
with (security_invoker = on) as
  select
    to_char(to_timestamp(r.created_at / 1000.0) at time zone 'Europe/Stockholm',
            'YYYY-MM-DD')                                as dag,
    r.type                                               as typ,
    count(*)                                             as antal,
    sum(greatest(0, r.confirms - 1))                     as bekraftelser,
    sum(r.denials)                                       as nedrostningar,
    round(100.0 * count(*) filter (where r.denials > 0) / count(*), 1)
                                                         as andel_nedrostade,
    count(distinct r.label)                              as olika_platser
  from public.reports r
  where r.source = 'facebook'
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 30 * 24 * 3600 * 1000
  group by 1, 2
  order by 1 desc, 3 desc;

/**
 * Vilka platser kommer igen? Två användningar: platser som återkommer ofta är
 * värda ett alias så geokodningen slipper gissa, och en plats som ständigt
 * röstas ner är nästan alltid en felträff hos Nominatim — samma namn finns på
 * fler ställen i Västmanland.
 */
create or replace view public.facebook_places
with (security_invoker = on) as
  select
    r.label                                              as plats,
    count(*)                                             as antal,
    sum(r.denials)                                       as nedrostningar,
    round(avg(r.lat)::numeric, 5)                        as lat,
    round(avg(r.lon)::numeric, 5)                        as lon,
    max(to_char(to_timestamp(r.created_at / 1000.0) at time zone 'Europe/Stockholm',
                'YYYY-MM-DD HH24:MI'))                   as senast
  from public.reports r
  where r.source = 'facebook'
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 30 * 24 * 3600 * 1000
  group by r.label
  having count(*) > 1
  order by count(*) desc;

/* ============================== ANVÄNDNING ========================== */
-- select * from facebook_recent;
-- select * from facebook_quality;
-- select * from facebook_places;

-- Gick en brygga fel och lade ut skräp? Så här ser du vad som ligger ute just
-- nu innan du rör något:
--
--   select * from facebook_recent where status = 'aktiv';
--
-- Och så här släcks en dålig omgång utan att radera historiken — rapporterna
-- försvinner ur appen inom en pollningscykel, men raderna finns kvar att
-- granska:
--
--   update public.reports
--      set removed = true,
--          expires_at = (extract(epoch from now()) * 1000)::bigint
--    where source = 'facebook'
--      and created_at > (extract(epoch from now()) * 1000)::bigint - 3600 * 1000;
--
-- Kör det i SQL-editorn. Det går medvetet inte via API:et: det finns ingen
-- update-policy på reports, så varken bryggan eller appen kan göra det här av
-- misstag.
