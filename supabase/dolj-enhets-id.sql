/* =====================================================================
   DÖLJ ENHETS-ID — vyn reports_feed
   =====================================================================

   Problemet: appen läser rapporter med den publika nyckeln, och tabellen
   reports innehåller kolumnen device_id. Alltså kunde vem som helst hämta
   hela flödet och se vilket id som rapporterat vad.

   Två saker går fel med det. Rösterna på en rapport avgörs per enhet, så
   den som ser andras id kan rösta ner med lånade id:n. Och även om id:t är
   slumpat följer det en person över tid — samlar man flödet i några veckor
   ser man var en viss enhet brukar befinna sig. Det är positionsdata om en
   enskild människa, och den ska inte ligga öppet.

   Lösningen är inte att döpa om kolumnen utan att ta bort rättigheten till
   den. Postgres kan ge läsrätt per kolumn, och det är precis vad vi vill:
   appen får läsa allt utom device_id, och vyn nedan är den väg den går.

   Varför inte bara en vy? För att tabellen ligger kvar bredvid vyn. Utan
   återkallad rättighet kan man hoppa förbi vyn och läsa tabellen direkt
   med samma nyckel. Vyn hade då varit en artighetsfras, inte ett skydd.

   Kör den här filen EFTER schema.sql och FÖRE grupper.sql.
   ===================================================================== */

/* ---------------------------- Vyn ----------------------------------- */
/*
 * security_invoker = on är viktigt och ska inte ändras.
 *
 * Med "on" gäller anroparens egna radregler när vyn läses. Det betyder att
 * den dag grupper finns — där en rapport kan tillhöra ett privat åkeri —
 * så följer vyn automatiskt med och visar bara de rader personen får se.
 *
 * Med "off" hade vyn körts som sin ägare och gått förbi radreglerna. Den
 * hade fungerat lika bra idag och tyst läckt varje privat grupprapport den
 * dagen grupper slås på. Det är den sortens fel som ingen upptäcker.
 */
create or replace view public.reports_feed
with (security_invoker = on) as
  select
    id,
    type,
    lat,
    lon,
    label,
    note,
    source,
    external_id,
    created_at,
    expires_at,
    confirms,
    denials,
    removed,
    inserted_at
  from public.reports;

/* ------------------------- Rättigheterna ---------------------------- */
/*
 * Först bort med läsrätten på hela tabellen, sedan tillbaka kolumn för
 * kolumn — alla utom device_id.
 *
 * Notera att INSERT inte rörs. Appen skriver fortfarande direkt till
 * reports, och den skrivningen måste få innehålla device_id: det är så en
 * rapport blir kopplad till den som skickade den, vilket i sin tur är det
 * som gör att du kan radera din egen. Att få skriva ett värde man inte får
 * läsa tillbaka är helt i sin ordning, och är precis vad vi vill här.
 */
revoke select on public.reports from anon, authenticated;

grant select (
  id, type, lat, lon, label, note, source, external_id,
  created_at, expires_at, confirms, denials, removed, inserted_at
) on public.reports to anon, authenticated;

grant select on public.reports_feed to anon, authenticated;

/* ------------------------------ Följder ------------------------------ */
/*
 * Efter det här slutar ett gammalt anrop mot /rest/v1/reports?select=*
 * att fungera, eftersom * omfattar device_id. Det är avsiktligt.
 *
 * Appen har redan en reservväg som föll tillbaka på tabellen när vyn
 * saknades. Den vägen tystnar nu istället för att läcka — men eftersom vyn
 * finns från och med den här körningen används den aldrig. Ordningen i
 * koden är vyn först, tabellen sedan.
 *
 * Kontrollera efteråt att det verkligen blev tätt:
 *
 *   select * from public.reports_feed limit 1;   -- ska fungera
 *   select device_id from public.reports limit 1; -- ska ge permission denied
 *                                                 -- när du kör som anon
 */
