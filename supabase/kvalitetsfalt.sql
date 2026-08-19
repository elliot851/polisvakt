/* =====================================================================
   KVALITETSFÄLT PÅ RAPPORTER
   =====================================================================

   Hur en rapport kom till, inte bara var.

   Bakgrunden: js/kvalitet.js graderar hur mycket en rapport går att lita på
   och väljer mellan att annonsera den rakt, formulera den hedgat, visa den
   tyst på kartan eller hålla inne den helt. Den graderingen behöver veta
   omständigheterna vid inlämningen — och de går inte att rekonstruera i
   efterhand.

   Utan de här kolumnerna får varje rapport som kommer via servern en antagen
   osäkerhet på drygt en kilometer, och tystas. Alltså exakt de rapporter som
   är hela poängen med tjänsten: andras.

   Fälten är avsiktligt nullbara. NULL betyder "vet inte" och ska aldrig
   tolkas som noll — skillnaden mellan okänd GPS-noggrannhet och perfekt
   GPS-noggrannhet är hela skillnaden mellan en tyst och en uttalad varning.

   Kör efter schema.sql och dolj-enhets-id.sql. Går att köra om.
   ===================================================================== */

begin;

/* ------------------------------ Kolumner ---------------------------- */

alter table public.reports
  add column if not exists gps_accuracy_m    int,
  add column if not exists fart_kmh          int,
  add column if not exists fordrojning_s     int,
  add column if not exists geokod            text,
  add column if not exists geokod_typ        text,
  add column if not exists geokod_radius_m   int,
  add column if not exists parser_confidence real;

/* ---------------------------- Rimlighet ----------------------------- */
/*
 * Kontrollerna är vida med flit. De ska stoppa nonsens och skrivfel, inte
 * göra en bedömning — bedömningen hör hemma i kvalitet.js där den går att
 * ändra utan en databasmigrering.
 */
alter table public.reports
  drop constraint if exists reports_kvalitet_rimlig;

alter table public.reports
  add constraint reports_kvalitet_rimlig check (
    (gps_accuracy_m    is null or gps_accuracy_m    between 0 and 100000) and
    (fart_kmh          is null or fart_kmh          between 0 and 400) and
    (fordrojning_s     is null or fordrojning_s     between 0 and 86400) and
    (geokod_radius_m   is null or geokod_radius_m   between 0 and 100000) and
    (parser_confidence is null or parser_confidence between 0 and 1) and
    (geokod is null or length(geokod) <= 20) and
    (geokod_typ is null or length(geokod_typ) <= 20)
  );

/* ------------------------- Vyn måste följa med ----------------------- */
/*
 * reports_feed är det appen faktiskt läser. Lägger vi till kolumner på
 * tabellen utan att ta med dem här kommer de aldrig fram, och felet ser ut
 * som att graderingen är trasig istället för att vyn är gammal.
 *
 * device_id är fortfarande INTE med. Se dolj-enhets-id.sql för varför.
 * security_invoker = on ska ligga kvar — grupprapporter förlitar sig på det.
 */
create or replace view public.reports_feed
with (security_invoker = on) as
  select
    id, type, lat, lon, label, note, source, external_id,
    created_at, expires_at, confirms, denials, removed, inserted_at,
    gps_accuracy_m, fart_kmh, fordrojning_s,
    geokod, geokod_typ, geokod_radius_m, parser_confidence
  from public.reports;

/* --------------------------- Rättigheter ---------------------------- */
/*
 * Kolumnrättigheterna sattes en gång i dolj-enhets-id.sql och gäller per
 * kolumn — nya kolumner ärver ingenting. Utan raden nedan blir de osynliga
 * för appen trots att de ligger i vyn.
 */
grant select (
  gps_accuracy_m, fart_kmh, fordrojning_s,
  geokod, geokod_typ, geokod_radius_m, parser_confidence
) on public.reports to anon, authenticated;

grant select on public.reports_feed to anon, authenticated;

commit;

/* ---------------------------- Kontroll ------------------------------
   Ska ge sju rader:

     select column_name from information_schema.columns
     where table_name = 'reports'
       and column_name in ('gps_accuracy_m','fart_kmh','fordrojning_s',
                           'geokod','geokod_typ','geokod_radius_m',
                           'parser_confidence');

   Och det här ska fungera som anon:

     select gps_accuracy_m, geokod from public.reports_feed limit 1;
   -------------------------------------------------------------------- */
