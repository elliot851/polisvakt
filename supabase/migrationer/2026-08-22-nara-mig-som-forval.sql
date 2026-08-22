-- =====================================================================
--  Polisvakt — "Nära mig" blir förval, också för dem som redan finns
--  2026-08-22
-- =====================================================================
--
-- Kör hela filen i Supabase SQL Editor. Den ändrar ETT kolumnförval och
-- skriver om befintliga rader. Ingen tabell skapas, ingen funktion ändras,
-- ingen rad raderas, ingen spärr rörs.
--
--
-- VARNING OM BLOCKKOMMENTARER
--
-- Filen har INGA blockkommentarer, och ska inte få några. En stjärna följd av
-- ett snedstreck avslutar en blockkommentar mitt i raden, och den
-- kombinationen har redan dödat en körning i det här projektet en gång. Bara
-- radkommentarer med två bindestreck.
--
--
-- VAD DEN GÖR
--
-- Tre saker, och bara på kolumnerna:
--
--   1. push_subscriptions.notis_folj får default true. Det står det redan
--      efter 2026-08-22-notisradie.sql rad 252 — satsen finns här för att
--      filen ska vara sann på egen hand, och för att den ska gå att köra på
--      en databas där någon dragit tillbaka förvalet.
--   2. Varje befintlig prenumeration som INTE följer med får notis_folj =
--      true. Det är raden som notisradie-filen lämnade bortkommenterad på
--      rad 1364 med orden "tills någon fattar beslutet med öppna ögon".
--      Ägaren har fattat det. Se nästa rubrik.
--   3. Samma rader får notis_platser = null och en radie på minst 100 000 m,
--      alltså exakt det läge en helt ny prenumeration föds i. Skälet står
--      under BEVISET nedan: det är det som gör ändringen ofarlig, inte
--      tilltron till att den är det.
--
--
-- VARFÖR TVÅSTEGS-DEFAULTEN UPPHÄVS
--
-- 2026-08-22-notisradie.sql gav notis_folj en default i två steg, med flit:
-- första satsen gav BEFINTLIGA rader false, andra satsen gjorde att FRAMTIDA
-- rader föds med true. Motivet står kvar där och är värt att upprepa i sin
-- starkaste form, för det är fortfarande ett riktigt argument:
--
--   Den som redan prenumererar har sagt ja till att bli väckt. Att en
--   uppdatering av appen sedan tyst börjar sålla bort varningar åt hen — utan
--   att hen rört ett reglage, utan att något syns i gränssnittet — är att
--   ändra vad någon köpt efter att hen köpt det. Spärren låg därför på
--   servern och inte i ett löfte om vad klienten inte skickar.
--
-- Vad har ändrats sedan dess? Inte argumentet. Avvägningen.
--
-- Förvalet "Hela landet" var rätt så länge det bara fanns en grupp och en
-- ort. Då sållade filtret ingenting, och tvåstegs-defaulten kostade
-- ingenting heller. Nu är riktningen bestämd: fler grupper, fler orter, och
-- då blir "Hela landet" inte längre generöst utan bullrigt. Ägaren har vägt
-- den avsmalning som en förare kan råka ut för mot den avstängning en förare
-- SÄKERT gör när notiserna handlar om en stad hen aldrig kör i — och den
-- avstängningen sker i telefonens egna inställningar, för hela appen, och tar
-- körpåminnelsen med sig. En förare som stängt av appen får noll varningar.
-- En förare med "Nära mig" får alla som gäller där hen faktiskt kör.
--
-- Beslutet är alltså: hellre ett filter som kan sålla någon enstaka varning
-- för mycket, än en notisström som får folk att tysta hela appen. Det är
-- samma avvägning som gjordes åt andra hållet i
-- 2026-08-21-gruppnotiser-pa-som-forval.sql, av samma ägare, med samma
-- motivering — en varning som ingen ser är värdelös.
--
-- Notera vad som INTE ändras med det: reglaget finns kvar. Den som vill ha
-- hela landet drar det tillbaka i Inställningar, och då nollar
-- fbmejl_satt_notisomfang både notis_folj och notis_platser i samma update.
-- Ingen är inlåst.
--
--
-- VAD DET INNEBÄR FÖR DEN SOM REDAN HAR APPEN
--
-- Dagen filen körs: ingenting. Bokstavligen ingenting — se BEVISET nedan.
--
-- Dagen därpå, om hen kör med appen igång: telefonen börjar skicka upp mitten
-- av den ruta den setts i under två skilda kalenderdygn, och servern tar emot
-- den nu i stället för att svara 'foljer-inte'. Först när den första
-- hemplatsen är etablerad kan hen få FÄRRE notiser än i dag.
--
-- Fyra villkor måste gälla samtidigt för att hen ska missa en enda varning:
-- notis_folj är true, minst en hemplats är etablerad, VARENDA rapport i
-- omgången ligger mer än radie plus 20 km från var och en av hens hemplatser,
-- och det finns inga odelade i högen. Med radien nedan är tröskeln 120 km från
-- en plats där telefonen bevisligen stått två dygn.
--
-- Vad hen ser i appen: "Nära mig" står i väljaren i stället för "Hela landet".
-- Det är hela den synliga skillnaden, och den är ärlig — det är precis vad som
-- gäller.
--
-- Klientlåset släpper av sig självt. js/push.js sätter _foljerInte när servern
-- svarat 'foljer-inte' och slutar då försöka spara plats för resten av
-- sessionen (rad 948). Nästa gång hamtaNotisomfang() körs läser den serverns
-- svar och sätter _foljerInte = !ut.folj (rad 1120), alltså false efter den
-- här filen. Ingen omstart krävs, ingen klientändring krävs för att den här
-- filen ska verka.
--
--
-- BEVISET: INGEN KAN SLUTA FÅ VARNINGAR AV DEN HÄR FILEN
--
-- Fyra led, och de behöver inte tros på — tre av dem går att läsa ur koden,
-- det fjärde kontrolleras av filen själv och rullar tillbaka allt om det inte
-- stämmer.
--
--   1. AVSTÅNDSGRINDEN LÄSER INTE notis_folj. Villkoret i
--      fbmejl_push_mottagare (notisradie-filen rad 388-414) frågar efter
--      s.notis_platser, s.notis_radie_m och p_platser. Ordet notis_folj
--      förekommer inte i det. Kolumnen är ett SKRIVLÅS på hemplatserna, inte
--      ett läsfilter på mottagarna. Att vända den kan därför inte ensam ta bort
--      en enda mottagare ur en enda omgång.
--
--   2. VARJE RAD FILEN RÖR SLUTAR UTAN KÄNDA TRAKTER. Updaten sätter
--      notis_platser = null på precis de rader den vänder. Grindens första
--      gren — "prenumeranten har ingen hemplats -> allt" — gäller alltså varje
--      rad filen tagit i, från sekunden den körts och tills hens egen telefon
--      lärt sig var hon bor. Bakåtkompatibiliteten ligger i DATAMODELLEN och
--      inte i ett villkor någon kan glömma att skriva, precis som
--      notisradie-filen rad 194-197 föreskriver.
--
--      I praktiken är den nollställningen en tom gest: en rad med
--      notis_folj = false kan inte ha fått hempunkter, för servern vägrade
--      skriva dem. Den står här för det som inte får hända ändå — någon som
--      skrivit punkter för hand i SQL, eller en rad från ett tidigare
--      experiment. Den vänds inte på med en okänd bevakning kvar.
--
--   3. RADIEN KAN BARA HÖJAS. Raderna filen rör får
--      greatest(coalesce(notis_radie_m, 100000), 100000). En rad som redan
--      står på 300 000 behåller 300 000. En rad som råkar ligga på 25 000 —
--      klampens golv i fbmejl_satt_notisomfang, möjlig att ha fått medan
--      reglaget stod på "Hela landet" och radien var overksam — höjs till det
--      mätta förvalet. Att låta en overksam siffra bli verksam i samma andetag
--      som filtret slås på vore precis den tysta avsmalning filen lovar att
--      inte göra. Med 100 km plus grindens 20 km slarv täcks hela dagens
--      upptagningsområde: Västerås–Stockholm ~100 km, Västerås–Örebro ~75 km,
--      hela Västmanland inom 60 km från Hallstahammar.
--
--      Rader som redan står på notis_folj = true rörs inte alls. Deras radie
--      är ett val någon gjort med filtret påslaget, och ett val skrivs inte om
--      av ett förval.
--
--   4. FILEN MÄTER SIG SJÄLV. Före och efter updaten frågas grinden tre
--      gånger: utan filter, med en punkt i Västerås och med en punkt i Malmö.
--      Sjunker något av de tre talen kastar filen och HELA transaktionen
--      rullas tillbaka. Ett sjunkande tal skulle betyda att led 1-3 är fel, och
--      då ska ingenting ha hänt.
--
-- Och det som ligger utanför den här filen men måste sägas, för det är den
-- enda regel som aldrig får glida: nykterhets- och drogkontroller sorteras
-- bort uppströms i fbmejl_ta_emot, före insert. De finns inte i tabellen, inte
-- i p_platser och inte i någon notisomgång. Ett filter som bara kan TA BORT
-- mottagare kan inte återinföra dem, och den här filen rör ingen funktion alls.
-- Inget av de sex filtren försvagas här.
--
--
-- OM DU ÅNGRAR DIG
--
--   alter table public.push_subscriptions alter column notis_folj set default false;
--   update public.push_subscriptions
--      set notis_folj = false, notis_platser = null
--    where notis_folj;
--
-- Den andra satsen tar tillbaka ALLA, också dem som själva valt "Nära mig"
-- efter att den här filen körts, för det går inte att skilja dem åt i
-- efterhand. Kör den bara om du menar det.

do $vakt$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise exception 'push.sql är inte körd — det finns inga prenumerationer att sätta förval för.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'push_subscriptions'
       and column_name = 'notis_folj'
  ) then
    raise exception 'Kolumnen notis_folj saknas. Kör supabase/migrationer/2026-08-22-notisradie.sql först — den här filen ändrar bara ett förval, den skapar ingenting.';
  end if;

  if to_regprocedure('public.fbmejl_gruppnotis_antal(jsonb)') is null then
    raise exception 'fbmejl_gruppnotis_antal(jsonb) saknas. Utan grinden går det inte att mäta att ingen tappas, och då ska filen inte köras.';
  end if;
end $vakt$;

begin;

-- =====================================================================
--  1. FÖRVALET FÖR NYA PRENUMERATIONER
-- =====================================================================
--
-- Redan satt av notisradie-filen. Står här för att filen ska vara sann läst
-- ensam, och för att den ska gå att köra som återställning om någon dragit
-- tillbaka förvalet enligt OM DU ÅNGRAR DIG ovan. Satsen är idempotent.

alter table public.push_subscriptions alter column notis_folj set default true;

-- =====================================================================
--  2. DE SOM REDAN FINNS
-- =====================================================================

do $forval$
declare
  -- Tre sonder. Den första öppnar grinden för alla och ska aldrig ändras av
  -- någonting; de två andra går genom hela avståndsvillkoret och är de som
  -- skulle sjunka om led 1-3 i BEVISET vore fel.
  c_vasteras constant jsonb := '[{"lat":59.61,"lon":16.55}]'::jsonb;
  c_malmo    constant jsonb := '[{"lat":55.60,"lon":13.00}]'::jsonb;

  v_alla_fore  int;  v_alla_efter  int;
  v_vst_fore   int;  v_vst_efter   int;
  v_mal_fore   int;  v_mal_efter   int;

  v_rader      int;
  v_totalt     int;
  v_med_platser int;
begin
  select count(*) into v_totalt from public.push_subscriptions;

  v_alla_fore := public.fbmejl_gruppnotis_antal(null::jsonb);
  v_vst_fore  := public.fbmejl_gruppnotis_antal(c_vasteras);
  v_mal_fore  := public.fbmejl_gruppnotis_antal(c_malmo);

  -- SJÄLVA ÄNDRINGEN.
  --
  -- where-satsen är inte kosmetika. Den gör filen körbar en andra gång utan
  -- att någon skadas: en förare som hunnit etablera hemplatser sedan första
  -- körningen har notis_folj = true och rörs alltså inte, så hennes
  -- notis_platser nollas inte bort under fötterna på henne. Utan villkoret
  -- hade en omkörning tyst kastat allas hemkännedom och startat om
  -- inlärningen från noll.
  --
  -- Ingen begränsning till enabled, till skillnad från den bortkommenterade
  -- raden i notisradie-filen. En avstängd prenumeration får ändå inga notiser
  -- — grinden kräver s.enabled — och den dag den slås på igen ska den vakna
  -- med samma förval som en ny. Att lämna avstängda rader på false hade bara
  -- gjort att förvalet berodde på vilket läge raden råkade ha en tisdag i
  -- augusti.
  --
  -- updated_at rörs INTE, och det är ett aktivt val. purge_dead_push()
  -- (supabase/push.sql rad 450) raderar rader vars updated_at är äldre än 180
  -- dagar. Att stämpla om varenda rad här hade gett varje sedan länge död
  -- telefon ett halvår till i tabellen, och den stämpeln hade dessutom varit
  -- osann: ingen telefon har hört av sig. Ett förval är inte ett livstecken.
  update public.push_subscriptions s
     set notis_folj    = true,
         notis_platser = null,
         notis_radie_m = greatest(coalesce(s.notis_radie_m, 100000), 100000)
   where s.notis_folj is distinct from true;

  get diagnostics v_rader = row_count;

  v_alla_efter := public.fbmejl_gruppnotis_antal(null::jsonb);
  v_vst_efter  := public.fbmejl_gruppnotis_antal(c_vasteras);
  v_mal_efter  := public.fbmejl_gruppnotis_antal(c_malmo);

  select count(*) into v_med_platser
    from public.push_subscriptions
   where notis_platser is not null;

  -- LED 4 I BEVISET.
  --
  -- Grinden får inte ha blivit snävare av en ändring som enligt led 1 inte
  -- ens kan påverka den. Blev den det är antagandet fel, inte mätningen, och
  -- då ska ingenting ha hänt. raise exception rullar tillbaka hela
  -- transaktionen, alter column set default inräknat.
  if v_alla_efter < v_alla_fore
     or v_vst_efter < v_vst_fore
     or v_mal_efter < v_mal_fore then
    raise exception
      'AVBRUTET: färre mottagare efter ändringen (utan filter %->%, Västerås %->%, Malmö %->%). Ingenting har sparats. Avståndsgrinden läser uppenbarligen notis_folj, tvärtemot vad den här filen förutsätter — läs om fbmejl_push_mottagare innan du kör igen.',
      v_alla_fore, v_alla_efter, v_vst_fore, v_vst_efter, v_mal_fore, v_mal_efter;
  end if;

  raise notice 'Prenumerationer: %. Vända till "Nära mig": %. Rader med hemplats kvar: % (alla med notis_folj = true sedan tidigare).',
    v_totalt, v_rader, v_med_platser;
  raise notice 'Mottagare oförändrade: utan filter %, Västerås %, Malmö %. Ingen har tappat en varning på den här filen.',
    v_alla_efter, v_vst_efter, v_mal_efter;
  raise notice 'Nya prenumerationer föds med notis_folj = true. Nykterhets- och drogkontroller berörs inte — de finns inte i notisvägen alls.';
end $forval$;

commit;

-- =====================================================================
--  KONTROLL
-- =====================================================================
--
-- Kör de här efteråt och läs svaren.
--
-- 1. Alla följer med, ingen har en bevakning ingen bett om. foljer_med ska
--    vara lika med prenumeranter, och har_hemplats ska vara 0 direkt efter
--    körningen. har_hemplats stiger sedan av sig själv i takt med att telefoner
--    lär sig var de hör hemma — det är meningen.

-- select count(*)                                          as prenumeranter,
--        count(*) filter (where notis_folj)                as foljer_med,
--        count(*) filter (where notis_platser is not null) as har_hemplats,
--        min(notis_radie_m)                                as minsta_radie
--   from public.push_subscriptions;

-- 2. Kolumnförvalet. Ska svara true.

-- select column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'push_subscriptions'
--    and column_name = 'notis_folj';

-- 3. Filtret är fortfarande inert. Alla tre talen ska vara lika stora så länge
--    ingen hunnit etablera en hemplats. Den dagen någon har en, ska malmo
--    sjunka men vasteras stå kvar — det är filtret som arbetar, inte ett fel.

-- select public.fbmejl_gruppnotis_antal(null)                                as utan_filter,
--        public.fbmejl_gruppnotis_antal('[{"lat":59.61,"lon":16.55}]'::jsonb) as vasteras,
--        public.fbmejl_gruppnotis_antal('[{"lat":55.60,"lon":13.00}]'::jsonb) as malmo;

-- 4. Ägarens egen rad, som var hela anledningen till filen. Byt device_id mot
--    ditt eget. Ska ge folj = true, antal_platser = 0, radie_m = 100000.

-- select endpoint, notis_folj, coalesce(jsonb_array_length(notis_platser), 0) as platser,
--        notis_radie_m, enabled, failures
--   from public.push_subscriptions
--  where device_id = '<ditt device_id>';

-- 5. Räckvidden över tid, samma fråga som notisradie-filens kontroll 4. Ligger
--    den nära 100 gör filtret ingenting. Sjunker den brant är det antingen
--    filtret som arbetar som tänkt eller en radie som är för snål.

-- select count(*)                                        as omgangar,
--        sum(mottagare_inom)                             as fick,
--        sum(mottagare_totalt)                           as kunde_fatt,
--        round(avg(nullif(mottagare_inom, 0)::numeric
--                  / nullif(mottagare_totalt, 0)) * 100) as rackvidd_procent
--   from public.fbmejl_notis_logg
--  where utfall = 'koad' and skickat_at > now() - interval '7 days';

-- =====================================================================
--  OM DEN HÄR FILENS HÅLLBARHET
-- =====================================================================
--
-- Filen är historik dagen efter att den körts, precis som notisradie-filen.
-- Den tål att köras om: where-satsen gör en andra körning till noll rader, och
-- alter column set default är idempotent.
--
-- Den tål också att 2026-08-22-notisradie.sql körs om EFTER den. Dess
-- "add column if not exists notis_folj boolean not null default false" gör
-- ingenting när kolumnen redan finns — den skriver inga rader — och dess andra
-- steg sätter samma default som här. Tvåstegs-defaulten kan alltså inte slå
-- tillbaka av sig själv.
--
-- TILL DEN SOM SKRIVER IN KOLUMNERNA I supabase/push.sql
--
-- notis_platser, notis_radie_m och notis_folj bor ännu bara i
-- migrationsfilerna; supabase/push.sql känner inte till dem. När de skrivs in
-- i tabelldefinitionen ska notis_folj ha
--
--   notis_folj boolean not null default true
--
-- direkt, i ETT steg. Kopiera INTE tvåstegsdansen från notisradie-filen dit.
-- Den var en engångsåtgärd för en utrullning som redan skett, och en kvarlämnad
-- "default false" följd av en "set default true" i en fil som körs om vid varje
-- ny databas är en fälla utan motsvarande vinst: på en tom tabell finns inga
-- befintliga rader att skydda, och på en befolkad tabell gör den ingenting.
--
-- Sanningen om vem som är MOTTAGARE hör fortfarande hemma i supabase/fbmejl.sql
-- enligt notisradie-filens sista rubrik. Den här filen rör ingen funktion och
-- ändrar därför ingenting i den planen.
