-- Migration: åldersgrinden — gammalt hamnar på kartan, men väcker ingen telefon.
--
-- Kör den här EFTER supabase/migrationer/2026-08-22-notisradie.sql och
-- EFTER supabase/migrationer/2026-08-22-koordinater-till-notisen.sql.
-- Vakten längst ner i det första do-blocket vägrar annars.
--
-- =====================================================================
--  VARFÖR
-- =====================================================================
--
-- Ägaren, ordagrant: "Du kan inte skicka en notis för något som var för 2
-- dagar sen."
--
-- Han har rätt, och det gick att göra. Mellan "rapporten är skriven" och
-- "pushen är köad" fanns ingen enda åldersprövning. created_at lästes på
-- exakt två ställen i hela notiskedjan, båda gånger bara för att FORMULERA
-- texten: fbmejl_mening() bygger frasen "för 2 dagar sedan" och lägger på
-- förbehållet " Troligen inte kvar." Ingenting läste talet för att avgöra om
-- notisen över huvud taget skulle gå ut. En rapport med created_at två dygn
-- bak gick alltså rakt igenom och blev:
--
--     Fartkontroll vid Erikslund
--     Någon i Facebook-gruppen varnade för 2 dagar sedan. Troligen inte kvar.
--
-- Det är en push som säger i sin egen brödtext att den inte är värd något.
-- Och det är precis så en förare lär sig att svepa bort nästa notis — den
-- som gällde.
--
-- ---------------------------------------------------------------------
-- KARTAN OCH NOTISEN ÄR OLIKA SAKER
--
-- Den här filen rör bara notisen.
--
-- De fyra åldersgrindar som redan finns i projektet sitter alla vid
-- INMATNINGEN och de dödar hela rapporten — kartan också:
--
--   tools/brygg-daemon.ps1:3175    expires_at <= nu + 60 s  ->  hoppas över
--   js/fbmejl.js:1029              samma formel             ->  SKAL.FOR_GAMMALT
--   js/facebook.js:319             samma formel             ->  skipped.stale
--   tools/fb-bridge.user.js:1653   samma formel             ->  hoppas över
--
-- De svarar på frågan "ska det här bli en nål på kartan?". Den här filen
-- svarar på en annan fråga: "ska det här väcka en telefon?". Samma rapport
-- kan mycket väl förtjäna ett ja på den första och ett nej på den andra, och
-- det är hela poängen. En nål man kan välja att titta på kostar ingenting.
-- En notis man inte valde kostar förtroende varje gång den var brus.
--
-- Grinden ligger därför strikt EFTER insert into public.reports. Rapporten
-- skrivs, syns i flödet, ritas på kartan, räknas i statistiken och kan
-- bekräftas av nästa förare — precis som förut. Det enda som händer är att
-- den inte kommer med i det som skickas till fbmejl-push.
--
-- ---------------------------------------------------------------------
-- VAR GRINDEN SITTER, OCH VARFÖR INTE PÅ DET ANDRA STÄLLET
--
-- Två platser var möjliga:
--
--   A. i fbmejl_ta_emot(), runt raden där v_nya byggs
--      (2026-08-22-koordinater-till-notisen.sql:214)
--   B. allra först i fbmejl_notis_ut(), innan v_antal räknas
--      (2026-08-22-notisradie.sql:563)
--
-- Valet blev B. Fyra skäl:
--
--   1. fbmejl_notis_ut är funktionen vars hela uppgift ÄR notisen. En grind
--      som handlar om notiser hör hemma där namnet står.
--   2. B skyddar varje anropare. fbmejl_ta_emot är bara en av dem — någon
--      kör funktionen för hand ur SQL-editorn, en omkörning av en gammal kö
--      kan ske, och en fjärde väg in kommer förr eller senare att byggas.
--      Med grinden i A hade var och en av dem behövt sin egen kopia.
--   3. B ligger före v_antal, före v_platspunkter och före rubrikbygget.
--      Alltså kan en gallrad rad varken räknas, styra vem som får notisen
--      eller nämnas i texten. Ligger grinden efter v_antal hamnar de gamla
--      raderna i stället i odelade-högen och kommer tillbaka som en uppblåst
--      siffra i nästa notis — då har man inte tagit bort bruset, man har
--      flyttat det.
--   4. A hade krävt att hela fbmejl_ta_emot skrevs om igen, i en tredje
--      kopia, vid sidan av supabase/fbmejl.sql och koordinater-filen.
--
-- BÅDA ställena vore fel. Två grindar är två tal som ska hållas i takt, och
-- det här projektet har redan en nykterhetsregel i sex kopior som driver
-- isär. Det finns ETT ställe. Det är här.
--
-- =====================================================================
--  GRÄNSEN
-- =====================================================================
--
-- Regeln, i en mening:
--
--     En rapport får ge notis så länge den är yngre än HALVA livslängden för
--     sin typ — och livslängden räknas aldrig högre än den längsta bland de
--     rörliga typerna.
--
-- I minuter, med dagens tal:
--
--     civil polisbil (unmarked, TTL 30)   högst 14 minuter
--     polis          (police,   TTL 45)   högst 22 minuter
--     trafikkontroll (control,  TTL 60)   högst 29 minuter
--     fartkamera     (camera,   TTL 1 år) högst 29 minuter   <- taket, se nedan
--
-- ---------------------------------------------------------------------
-- Varför HALVA livslängden och inte något annat tal
--
-- Ett fast minuttal hade varit fel oavsett vilket man valde. Sätt 60 minuter
-- och en civil polisbil blir notisvärd dubbelt så länge som appen själv anser
-- att den finns kvar. Sätt 20 och en trafikkontroll tystnar långt innan den
-- hunnit bygga kö. Talen i appen är olika per typ av ett skäl: en civilbil
-- flyttar sig, en kontroll står kvar. Gränsen måste följa samma logik, annars
-- är den bara ännu ett tal att glömma bort.
--
-- Halva livslängden är dessutom inte valt på känsla. Det är den brytpunkt där
-- appens EGEN text slutar vara neutral och börjar ta förbehåll:
--
--   js/sammanfattning.js aktualitet(), rad 272-280
--       andel < 0,2  "Rapporten är färsk."
--       andel < 0,5  "Den kan ha hunnit flytta på sig."
--       andel < 1    " Kan ha flyttat på sig."   / "troligen inte står kvar"
--       andel >= 1   " Troligen inte kvar."      / "knappast stämmer längre"
--
--   supabase/fbmejl.sql fbmejl_mening(), rad 1180-1191 — samma två sista steg
--       v_min / v_ttl >= 0,5   -> ' Kan ha flyttat på sig.'
--       v_min       >= v_ttl   -> ' Troligen inte kvar.'
--
-- Vid andel 0,5 börjar alltså notisens egen brödtext hedga. Grinden säger
-- ingenting nytt: den säger att om vi hade behövt skriva ett förbehåll om
-- åldern, då skickar vi inte. En push vars text lyder "Kan ha flyttat på sig"
-- är samma brus som den ägaren beskriver, bara mindre pinsam.
--
-- Ett absolut tak vid andel < 1 hade också varit möjligt, och det är den
-- yttersta gränsen som går att försvara — allt över den säger i klartext
-- "Troligen inte kvar", och att notisa något appen samtidigt kallar borta är
-- obegripligt. Men 1,0 är taket för vad som inte är rent självmotsägande, inte
-- en gräns för vad som är värt en push. Vi tar 0,5.
--
-- Räkningen görs på heltal och utan flyttal: villkoret är
--
--     minuter * 2 < livslängd
--
-- vilket är exakt samma sak som andel < 0,5 men utan en enda avrundning att
-- bråka om vid 22,5 minuter.
--
-- ---------------------------------------------------------------------
-- Varför fartkameran ändå får samma gräns som en trafikkontroll
--
-- Frågan är rimlig: en fartkamera står kvar i åratal, en civil polisbil är
-- borta om en kvart. De har med flit olika TTL i js/store.js — 525 600 minuter
-- mot 30. Skulle de då inte få olika gräns?
--
-- Nej, och skälet är att TTL svarar på en annan fråga än grinden.
--
--   TTL frågar:      står den kvar?
--   Grinden frågar:  är det här en nyhet värd att väcka en telefon för?
--
-- För allt som rör sig är svaren desamma, och därför fungerar halva TTL rakt
-- av. För en fast kamera glider de isär totalt. En kamerarapport som är ett
-- halvår gammal är fortfarande SANN — kameran står där — och fullständigt
-- ointressant som notis. Halva TTL hade gett den 262 800 minuter, alltså ett
-- halvår, att fortfarande ringa i någons ficka.
--
-- Därför ett tak: gränsen räknas aldrig på en livslängd som är längre än den
-- längsta bland de RÖRLIGA typerna (police, control, unmarked — idag 60
-- minuter för control). Kameran får alltså 29 minuter, precis som en
-- trafikkontroll. Är kamerarapporten äldre än så är den inte en nyhet längre;
-- den är en post i databasen, och den finns redan på kartan där den hör hemma.
--
-- Taket räknas ut ur samma tabell som allt annat, så det finns fortfarande
-- bara ETT ställe att ändra om livslängderna någonsin ändras.
--
-- Fotnot: kameror från mejlvägen vägras redan rakt av i fbmejl_ta_emot
-- (v_typ = 'camera' -> utfall 'vagrad'), med motiveringen att de 136 kamerorna
-- i Västmanland redan ligger i appen med rätt position och mätriktning. Att
-- kameragrenen ändå finns här kostar ingenting idag och gör att en framtida
-- fjärde väg in inte kan skicka en notis om något som stod där i julas.
--
-- ---------------------------------------------------------------------
-- Varför grinden är HÅRDARE än bryggans egen
--
-- Bryggan släpper igenom allt som är yngre än TTL minus en minut: 44 minuter
-- för polis, 59 för kontroll, 29 för civil. Grinden här är alltså ungefär
-- dubbelt så sträng, och det finns ett fönster där en rapport hamnar på kartan
-- utan att ge notis — 15 till 29 minuter för en civilbil, till exempel.
--
-- Det är avsiktligt, och det är samma delning som hela filen bygger på.
-- Bryggan avgör vad som blir en nål. Grinden avgör vad som väcker någon.
-- Fönstret däremellan är inte ett glapp, det är svaret.
--
-- ---------------------------------------------------------------------
-- Okänd och otrolig tidsstämpel
--
-- created_at som är null, noll eller negativ ger i fbmejl_mening frasen "vid
-- okänd tidpunkt", och en stämpel mer än två minuter in i framtiden ger "vid
-- en tidpunkt som inte går att lita på". Båda passerar utan förbehåll idag,
-- eftersom det inte går att räkna ut någon andel på dem.
--
-- Grinden vägrar båda. Skälet är enkelt: en ålder vi inte kan fastställa är
-- inte ett bevis på färskhet. Ägarens krav är att ingenting gammalt får ringa,
-- och "vi vet inte hur gammal den är" är inte ett svar som uppfyller det.
-- Rapporten hamnar som vanligt på kartan, där föraren kan se "vid okänd
-- tidpunkt" och själv avgöra vad den är värd.
--
-- Tvåminuterstoleransen är kvar oförändrad: en klocka som går två minuter fel
-- ska räknas som noll minuter gammal, inte som otrolig.
--
-- OBSERVERA hålet som grinden INTE kan täppa till: js/fbmejl.js:872
-- skrivenNar() faller tillbaka på `nu` när mejlet saknar läsbart datum. Ett två
-- dygn gammalt inlägg får då created_at = nu och är därmed färskt för allt som
-- kommer efter, inklusive den här grinden. Ingen SQL i världen kan se skillnad
-- på en äkta färsk stämpel och en påhittad. Vill man täppa till det måste
-- skrivenNar() returnera null och tolkaMejl() vägra raden — en separat ändring
-- i en separat fil, och den hör inte hemma här.
--
-- =====================================================================
--  BUNTNINGEN — det svåra
-- =====================================================================
--
-- Flera rapporter i samma omgång blir EN notis. Kommer en färsk och en två
-- dygn gammal i samma svep finns det två fel att göra, och båda är lätta:
--
--   FEL 1: kasta hela omgången för att en rad var för gammal.
--          Då tystnar den färska varningen. Oacceptabelt.
--
--   FEL 2: släppa igenom hela omgången för att en rad var färsk.
--          Då står den gamla kvar i rubrikraden — "Fartkontroll vid X ·
--          Polis vid Y" — utan att någonstans avslöja att den ena var från i
--          förrgår. Flerfallet kastar nämligen 'svans', som är den enda del av
--          meningen som bär åldern. Notisen blir osann.
--
-- Grinden gallrar därför RAD FÖR RAD och lämnar resten av omgången i fred.
-- Den gallrade listan ersätter p_nya innan något annat läser den, så att
-- samtliga fem konsumenter ser exakt samma mängd:
--
--   v_antal          räknar bara de kvarvarande
--   v_platspunkter   får bara de kvarvarandes koordinater
--   v_platser        rubrikerna byggs bara av de kvarvarande
--   v_totalt         talet i rubriken innehåller inte de gallrade
--   enfallet         "en enda varning" betyder en enda KVARVARANDE varning
--
-- Sista punkten är den fina bieffekten: en omgång med en färsk och en gammal
-- rad blir efter gallringen en omgång med en rad, och då får notisen hela den
-- enskilda sammanfattningsmeningen med sitt "för 3 minuter sedan" — i stället
-- för "2 nya varningar i gruppen" och två rubriker utan åldrar.
--
-- Gallrade rader läggs INTE i odelade. De kommer aldrig tillbaka, i någon
-- form, i någon senare notis. De var för gamla; att spara dem som en siffra
-- till nästa gång vore att göra dem äldre och sedan skicka dem ändå.
--
-- Blir hela omgången gallrad returnerar funktionen skal 'for-gammalt' och rör
-- INTE tillståndet: ingen glesspärr bränns, inget dygnstak räknas upp, ingen
-- odelade-hög växer. Det är samma försiktighet som redan gäller när ingen
-- lyssnar, och av samma skäl.
--
-- =====================================================================
--  HÖGEN — nattspärrens efterrätt
-- =====================================================================
--
-- Utan det här stycket vore grinden bara halvfärdig, och den halva som
-- saknades vore den som faktiskt drabbar folk.
--
-- odelade är ETT TAL. När en spärr säger nej räknas omgångens rader upp där
-- och nästa notis som får gå säger "N nya varningar i gruppen". Radernas
-- created_at och koordinater är borta i samma ögonblick — det finns ingen
-- lista att åldersgranska i efterhand.
--
-- Nattspärren går 23:00-05:59 Europe/Stockholm. Allt som kommer in under de
-- sju timmarna hamnar i högen. Klockan 06:01 nästa morgon går den ut som ett
-- tal, och det talet räknar varningar som löpte ut vid midnatt. Slår
-- dygnstaket (12) in kan högen dessutom överleva flera dygn. Det är, ord för
-- ord, en notis för något som var för två dagar sedan — bara uttryckt som en
-- siffra i stället för en mening.
--
-- Lösningen är den enda som är möjlig när ingredienserna är borta: högen får
-- ett bäst-före-datum. Ny kolumn odelade_forst skrivs om vid VARJE påfyllning
-- av högen, och nollställs när högen töms. Är den äldre än takgränsen — samma
-- tak som grinden räknar med, alltså 30 minuter — släpps hela högen.
--
-- DEN SENAST TILLAGDA RADEN ÄR MÅTTET, INTE DEN FÖRSTA. Det här är hela
-- skillnaden mot det första försöket, och det försöket var fel: satte man
-- datumet en enda gång, av den omgång som startade högen, mätte släppet
-- åldern på fel rad. En rapport som lades i högen sent i dess liv kastades då
-- långt innan den själv hunnit bli gammal — 05:41 startar högen, 05:55 kommer
-- en trafikkontroll, 06:12 släpps allt för att 05:41 passerat 30 minuter, och
-- kontrollen som var 17 minuter gammal försvann för alltid utan att någonsin
-- ha nämnts i en notis. Med den senaste påfyllningen som mått gäller garantin
-- igen åt rätt håll: har inget nytt lagts i högen på 30 minuter hade även den
-- sist tillagda raden som mest 29 minuter kvar när den lades dit, alltså är
-- HELA högen garanterat passerad.
--
-- Priset är att en livlig grupp får en hög som lever längre, och att en gammal
-- rad kan följa med i talet så länge nya rapporter fortsätter komma. Det felar
-- åt att skicka för mycket i stället för att tappa en färsk varning, vilket är
-- samma håll som allt annat i den här kedjan lutar åt.
--
-- Kolumnen heter fortfarande odelade_forst fast den numera bär tiden för den
-- SENASTE påfyllningen. Ett rename valdes bort: kolumnen kan redan ligga ute i
-- en körd migration, och ett bättre namn är inte värt en schemaändring som
-- måste vara idempotent i båda riktningarna.
--
-- Två bieffekter, båda goda:
--
--   • Morgonnotisen efter en tyst natt handlar om morgonen, inte om natten.
--   • odelade > 0 slår idag AV avståndsfiltret och skickar till ALLA i hela
--     landet (notisradie:604 och :686), eftersom högens koordinater är okända.
--     En hög som släpps kan inte längre göra det. En laserkontroll i Västerås
--     slutar väcka folk i Malmö bara för att det var tyst i natt.
--
-- Högen släpps tyst mot användaren men högljutt mot loggen: en rad med utfall
-- 'for-gammalt' skrivs så att frågan "varför sa den inte 14?" går att besvara
-- i efterhand. Utan den ser en släppt hög exakt likadan ut som en trasig
-- räknare.
--
-- =====================================================================
--  DET SOM INTE GÅR, OCH SOM INGEN FÅR LOVA
-- =====================================================================
--
-- Den här filen gör notisen färre och sannare. Den gör den inte hörbar.
--
-- En webbpush kan INTE bära ett eget ljud. Notification-API:ts sound-fält är
-- dött i alla webbläsare som räknas, och kroppen som går härifrån till
-- fbmejl-push (titel, text, tag, url, antal, platser) har ingen plats för ett
-- och ska inte få en. Ljudet för en push med STÄNGD app är telefonens
-- systemljud, punkt.
--
-- Det vi äger fullt ut är ljudet när appen är ÖPPEN — js/voice.js, Web Audio,
-- där får vi göra precis vad vi vill. Försök inte igen härifrån om ett halvår.

-- Allt fram till commit; går in i ETT svep, precis som notisradien. Faller
-- förkontrollen eller något create är ingenting ändrat — en halvt utrullad
-- åldersgrind är värre än ingen, eftersom fbmejl_notis_ut då kan stå och
-- anropa en fbmejl_notis_farsk som inte finns.
begin;

set local statement_timeout = '60s';

-- ---------------------------------------------------------------------
-- FÖRKONTROLL
--
-- Vakten frågar efter två saker: att notisradien är körd (avståndsfunktionen
-- finns) och att koordinaterna faktiskt följer med ut ur fbmejl_ta_emot. Den
-- andra frågan ställs för att den här filen skriver om fbmejl_notis_ut i sin
-- helhet — körs den på en databas där koordinatfilen inte gått igenom skulle
-- resultatet se friskt ut och tyst sakna halva urvalet.
do $forkontroll$
declare n int;
begin
  if to_regprocedure(
       'public.fbmejl_avstand_m(double precision, double precision, double precision, double precision)'
     ) is null then
    raise exception 'Kör supabase/migrationer/2026-08-22-notisradie.sql först.';
  end if;

  if to_regprocedure('public.fbmejl_mening(text, text, text, bigint)') is null then
    raise exception 'Kör supabase/fbmejl.sql först — fbmejl_mening saknas.';
  end if;

  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'fbmejl_ta_emot'
     and p.prosrc like '%''lat''%';
  if n = 0 then
    raise exception
      'Kör supabase/migrationer/2026-08-22-koordinater-till-notisen.sql först.';
  end if;
end
$forkontroll$;

-- =====================================================================
--  1. LIVSLÄNGDERNA, MED ETT NAMN
-- =====================================================================
--
-- Talen är samma som TTL_MINUTES i js/store.js:23-28, som är sanningens källa
-- för hela appen. De fanns hittills på servern bara som ett inbakat case inuti
-- fbmejl_mening() (supabase/fbmejl.sql:1180-1186), alltså utan namn och utan
-- något sätt att återanvända dem.
--
-- Att grinden skulle skriva av dem en gång till hade gjort dem till ännu en
-- kopia att glömma. Nu får de i stället ett namn, och det är den här
-- funktionen som är serverns svar på frågan.
--
-- ATT GÖRA NÄR NÅGON ÄNDÅ ÄR I supabase/fbmejl.sql: byt caset i
-- fbmejl_mening() mot ett anrop hit. Det är en ren omskrivning utan
-- beteendeändring, och efter den finns talen på ETT ställe per sida. Filen är
-- inte min att röra i den här omgången, så tills vidare bevakas de i stället:
-- efterkontrollen längst ner jämför de två mot varandra och skriker om de
-- någonsin skiljer sig. Skriker den, är det fbmejl_mening som har rätt — den
-- styr texten som föraren faktiskt läser.
create or replace function public.fbmejl_ttl_minuter(p_typ text)
returns int
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_typ
           when 'police'   then 45
           when 'control'  then 60
           when 'unmarked' then 30
           when 'camera'   then 525600   -- 365 dygn: en fast kamera står kvar
           else 45                       -- okänd typ behandlas som polis
         end;
$$;

comment on function public.fbmejl_ttl_minuter(text) is
  'Hur länge en rapport av typen anses aktuell, i minuter. Samma tal som '
  'TTL_MINUTES i js/store.js. Används av åldersgrinden i fbmejl_notis_ut.';

-- ---------------------------------------------------------------------
-- Taket: den längsta livslängden bland de RÖRLIGA typerna.
--
-- Uträknad, inte nedskriven. Skulle någon en dag ge control 90 minuter följer
-- taket med av sig självt, och skulle någon lägga till en femte rörlig typ är
-- den här funktionen det enda stället som behöver veta om den.
--
-- Kameran är inte med, och det är hela idén — se resonemanget i huvudet.
create or replace function public.fbmejl_ttl_tak_minuter()
returns int
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select greatest(
    public.fbmejl_ttl_minuter('police'),
    public.fbmejl_ttl_minuter('control'),
    public.fbmejl_ttl_minuter('unmarked')
  );
$$;

comment on function public.fbmejl_ttl_tak_minuter() is
  'Längsta livslängden bland de rörliga typerna (idag control, 60 min). Taket '
  'som hindrar fartkamerans ettåriga livslängd från att göra ett halvår gammalt '
  'till notisvärt.';

-- =====================================================================
--  2. GRINDEN SJÄLV
-- =====================================================================
--
-- En rad, ett ja eller nej. Funktionen tar hela jsonb-elementet i stället för
-- typ och created_at var för sig, av två skäl: anropet i where-satsen blir
-- läsbart, och den slarviga texttolkningen (created_at kan i teorin komma som
-- vad som helst) hamnar på ETT ställe i stället för i varje anropare.
--
-- p_nu finns bara för att grinden ska gå att prova utan att vänta en
-- halvtimme. Lämnas den tom är det now() som gäller, som överallt annars.
--
-- stable, inte immutable: now() är stabil inom transaktionen men inte över
-- tid, och en immutable-märkning här hade låtit planeraren räkna ut svaret en
-- gång och återanvända det.
create or replace function public.fbmejl_notis_farsk(
  p_rad jsonb,
  p_nu  bigint default null
)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, pg_temp as $$
declare
  v_nu   bigint := coalesce(p_nu, (extract(epoch from now()) * 1000)::bigint);
  v_txt  text;
  v_at   bigint;
  v_ms   bigint;
  v_min  bigint;
  v_ttl  int;
begin
  if p_rad is null or jsonb_typeof(p_rad) <> 'object' then
    return false;
  end if;

  v_txt := p_rad->>'created_at';

  -- Tolkas talet inte som ett heltal är stämpeln obrukbar, och en obrukbar
  -- stämpel är inte ett bevis på färskhet. Kastar man i stället ett fel här
  -- dör hela notisen för en enda trasig rad — och det är fel håll att fela åt
  -- när resten av omgången kan vara helt i sin ordning.
  if v_txt is null or v_txt !~ '^-?[0-9]{1,19}$' then
    return false;
  end if;

  v_at := v_txt::bigint;
  if v_at <= 0 then
    -- 'vid okänd tidpunkt' i fbmejl_mening. Ingen ålder, ingen notis.
    return false;
  end if;

  v_ms := v_nu - v_at;

  -- Samma tvåminuterstolerans som fbmejl_mening() och js/sammanfattning.js:
  -- en klocka som går lite fel ska ge noll minuter, inte en varning för
  -- framtiden. Bortom toleransen är stämpeln 'vid en tidpunkt som inte går
  -- att lita på', och den får inte heller ringa.
  if v_ms < -120000 then
    return false;
  end if;

  v_min := greatest(0, v_ms / 60000);

  -- Taket. För police, control och unmarked ändrar least() ingenting — det är
  -- bara fartkameran som någonsin träffar det.
  v_ttl := least(
    public.fbmejl_ttl_minuter(p_rad->>'typ'),
    public.fbmejl_ttl_tak_minuter()
  );

  -- andel < 0,5, uttryckt så att 22,5 minuter inte behöver avrundas.
  return v_min * 2 < v_ttl;
end $$;

comment on function public.fbmejl_notis_farsk(jsonb, bigint) is
  'Åldersgrinden. Sant om raden är yngre än halva livslängden för sin typ, med '
  'taket från fbmejl_ttl_tak_minuter(). Okänd eller otrolig tidsstämpel ger '
  'falskt. Gäller BARA notisen — kartan har egna, mildare gränser.';

-- =====================================================================
--  3. TVÅ SMÅ ÄNDRINGAR I TABELLERNA
-- =====================================================================

-- Högens ålder. Skrivs om vid varje påfyllning av odelade, nollställs när
-- högen töms. Nullbar med flit: null betyder "ingen hög", och det är sant för
-- den allra vanligaste raden.
--
-- Namnet ljuger en aning: värdet är tiden för den SENASTE påfyllningen, inte
-- den första. Se HÖGEN i huvudet för varför måttet måste vara den sist
-- tillagda raden, och varför kolumnen ändå inte döps om.
alter table public.fbmejl_notis_lage
  add column if not exists odelade_forst timestamptz;

comment on column public.fbmejl_notis_lage.odelade_forst is
  'När något senast lades i den nuvarande odelade-högen (namnet till trots). '
  'Är den äldre än fbmejl_ttl_tak_minuter()/2 minuter släpps hela högen — då '
  'har även den sist tillagda raden garanterat passerat sin egen '
  'notisgräns. Null = ingen hög.';

-- Fanns det redan en hög när den här filen kördes har den ingen känd ålder.
-- Att lämna den utan datum vore att göra den odödlig: staleness-provet kan
-- inte fira på null, och högen hade legat kvar och blåst upp varje framtida
-- rubrik. Den får därför nu som senaste påfyllning och åldras ut en halvtimme
-- efter utrullningen, om inget nytt hinner läggas i den. Åt det generösa
-- hållet, som allt annat i den här kedjan.
update public.fbmejl_notis_lage
   set odelade_forst = now()
 where id = 1 and odelade > 0 and odelade_forst is null;

-- Loggen behöver kunna säga 'for-gammalt'.
--
-- Att i stället skriva 'sparrad' hade varit frestande men fel: fbmejl_halsa
-- räknar utfall = 'sparrad' de senaste 24 timmarna som sparrade_dygn, med
-- kommentaren "spärrarna gör sitt jobb". Gallringen är inte en spärr — en
-- spärr skjuter upp, gallringen kastar — och att blanda ihop dem gör
-- hälsotalet obegripligt precis den dag man behöver det.
--
-- VARNING TILL DEN SOM KÖR OM supabase/fbmejl.sql EFTER DEN HÄR FILEN:
-- rad 523-525 där återskapar villkoret utan 'for-gammalt'. Lägg till värdet i
-- listan där också. Tills det är gjort är de två log-skrivningarna nedan
-- inpackade i var sitt exception-block, så att ett gammalt villkor kan tysta
-- loggen men aldrig notisen.
alter table public.fbmejl_notis_logg
  drop constraint if exists fbmejl_notis_logg_utfall_check;
alter table public.fbmejl_notis_logg
  add constraint fbmejl_notis_logg_utfall_check
  check (utfall in ('koad', 'kvitterad', 'sparrad', 'fel', 'ingen-mottagare',
                    'okand', 'skickad', 'for-gammalt'));

-- =====================================================================
--  4. UTSKICKET, MED GRINDEN
-- =====================================================================
--
-- Hela fbmejl_notis_ut, ersatt. Grunden är ordagrant versionen ur
-- supabase/migrationer/2026-08-22-notisradie.sql:524-860. Postgres kan inte
-- skjuta in en rad i en befintlig funktionskropp, så hela kroppen måste med —
-- samma mönster som notisradien och koordinatfilen redan använder.
--
-- Diffen mot den versionen, och ingenting mer:
--
--   1. Åldersgrinden gallrar p_nya rad för rad, före allt annat.
--   2. Blir omgången tom returneras 'for-gammalt' utan att tillståndet rörs.
--   3. odelade-högen släpps om den senaste påfyllningen är äldre än taket. Ny
--      kolumn odelade_forst skrivs om på varje väg som lägger något i högen
--      och nollställs när den töms.
--   4. Två nya loggrader med utfall 'for-gammalt', båda felsäkra.
--
-- Nattspärren, glesspärren, dygnstaket, buntningen, avståndsfiltret, ordningen
-- mellan dem, och regeln att tillståndet skrivs FÖRST när anropet är köat —
-- allt oförändrat. Diffen ska vara liten och tråkig; jämför gärna rad för rad.

create or replace function public.fbmejl_notis_ut(
  p_nya          jsonb,
  p_min_minuter  int      default 10,
  p_tak_per_dygn int      default 12,
  p_tidigast     smallint default 6,
  p_senast       smallint default 23
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_antal    int;
  v_lage     public.fbmejl_notis_lage%rowtype;
  v_lokal    timestamptz := now();
  v_timme    int;
  v_dag      date;
  v_platser  text;
  v_mening   jsonb;
  v_titel    text;
  v_text     text;
  v_totalt   int;
  v_url      text;
  v_nyckel   text;
  v_skal     text;
  v_mottagare int;
  v_net_id   bigint;
  v_fel      text;
  v_platspunkter  jsonb;
  v_mottagare_alla int;
  v_odelade_fore   int;
  -- Nytt i den här filen.
  v_farska     jsonb;         -- omgången efter gallring
  v_gallrade   int := 0;      -- hur många som föll bort, bara för loggen
  v_hog_forst  timestamptz;   -- olåst förhandstitt på högens ålder
  v_hog_livs   int;           -- hur länge en hög får leva, i minuter
begin
  if p_nya is null or jsonb_typeof(p_nya) <> 'array' then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  v_antal := jsonb_array_length(p_nya);
  if v_antal = 0 then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  -- Högens bäst-före, räknat från den SENASTE påfyllningen. Halva taket,
  -- alltså 30 minuter med dagens tal: den sist tillagda raden hade som mest
  -- taket-minus-ett minuter kvar av sin egen notisvärdhet när den lades dit,
  -- och alla andra i högen är äldre än den — så har inget nytt kommit på halva
  -- taket är hela högen garanterat passerad, oavsett vilka typer den råkade
  -- innehålla. Mätt från den FÖRSTA raden hade provet i stället kastat färska
  -- rapporter som lagts i högen sent; se HÖGEN i huvudet.
  v_hog_livs := greatest(1, public.fbmejl_ttl_tak_minuter() / 2);

  -- =================================================================
  --  ÅLDERSGRINDEN
  -- =================================================================
  --
  -- Rad för rad, före allt annat. Hela poängen med att den ligger HÄR och inte
  -- längre ner är att v_antal, v_platspunkter, rubrikbygget och v_totalt alla
  -- ska se samma mängd. En gammal rad ska inte kunna räknas, inte kunna styra
  -- vem som får notisen, och inte kunna nämnas i texten.
  --
  -- jsonb_array_elements och inte jsonb_to_recordset: hela elementet ska
  -- överleva gallringen med alla sina fält, inklusive lat och lon. En
  -- projektion hade tappat dem och slagit av avståndsfiltret på köpet.
  select coalesce(jsonb_agg(e.rad), '[]'::jsonb)
    into v_farska
    from jsonb_array_elements(p_nya) as e(rad)
   where public.fbmejl_notis_farsk(e.rad);

  v_gallrade := v_antal - jsonb_array_length(v_farska);

  if v_gallrade > 0 then
    -- Felsäker: ett gammalt check-villkor på utfall får tysta loggen, aldrig
    -- notisen. Se varningen vid alter table ovan.
    begin
      insert into public.fbmejl_notis_logg (antal, utfall, skal)
      values (v_gallrade, 'for-gammalt',
              'gallrade rader: aldre an halva livslangden for sin typ');
    exception when others then
      null;
    end;
  end if;

  -- HÄRIFRÅN OCH NER FINNS DE GALLRADE RADERNA INTE.
  --
  -- Tilldelningen till parametern är avsiktlig och är det som gör att
  -- resten av kroppen inte behöver röras med en rad. Skulle någon senare
  -- lägga till en femte läsning av p_nya blir den automatiskt rätt.
  p_nya  := v_farska;
  v_antal := jsonb_array_length(p_nya);

  if v_antal = 0 then
    -- Hela omgången var för gammal. Tillståndet rörs INTE: ingen glesspärr
    -- bränns, inget dygnstak räknas upp, ingen hög växer. Samma försiktighet
    -- som när ingen lyssnar, och av samma skäl — det som aldrig skulle skickats
    -- ska inte heller kunna skugga nästa notis som faktiskt ska gå.
    return jsonb_build_object('skickad', false, 'skal', 'for-gammalt',
                              'gallrade', v_gallrade);
  end if;

  -- Var ligger den här omgången?
  --
  -- Punkterna är slutna värden: två tal som redan ritas som en nål på kartan
  -- för alla. De följer med för URVALET, aldrig för texten — de får inte
  -- hamna i titel eller brödtext, och de får inte in i nyttolasten som
  -- edge-funktionen krypterar och skickar till telefonen.
  --
  -- Saknas lat och lon blir v_platspunkter null och allt går till alla.
  --
  -- Högst 25 punkter. Fler ryms inte meningsfullt i en omgång, och en
  -- obegränsad lista är en pg_net-kropp som växer med gruppens värsta kväll.
  select jsonb_agg(jsonb_build_object('lat', x.lat, 'lon', x.lon))
    into v_platspunkter
    from (
      select distinct y.lat, y.lon
        from jsonb_to_recordset(p_nya) as y(lat double precision, lon double precision)
       where y.lat is not null and y.lon is not null
       limit 25
    ) x;

  -- ODELADE SLÅR AV FILTRET.
  --
  -- Ligger det varningar i högen sedan tidigare omgångar beskriver texten som
  -- ska gå ut även DEM, och deras koordinater har ingen längre — odelade är
  -- ett tal, inte en lista. Att då filtrera på bara den här omgångens punkter
  -- vore att tysta en notis som delvis handlar om något annat.
  --
  -- Titten är OLÅST och sker före grinden, med flit. Grinden ska kunna svara
  -- utan att ta radlåset. Kappseglar två omgångar om samma rad kan svaret bli
  -- en omgång gammalt, och konsekvensen av det är i värsta fall att filtret
  -- slås av när det inte behövde slås av. Åt det generösa hållet, som allt
  -- annat här. Det låsta värdet läses längre ner och används för texten.
  --
  -- NYTT: högens ålder läses med. En hög som är för gammal räknas som tom
  -- redan här, så att den inte hinner slå av avståndsfiltret på vägen. Det
  -- riktiga släppet sker under låset längre ner; det här är bara samma fråga
  -- ställd olåst, precis som raden ovanför. Skulle de två svaren skilja sig —
  -- alltså om högen råkar passera bäst-före-gränsen i mikrosekunderna mellan
  -- dem — blir följden att notisen går till fler än den behövde. Fel åt rätt
  -- håll, som överallt annars i den här funktionen.
  select coalesce(l.odelade, 0), l.odelade_forst
    into v_odelade_fore, v_hog_forst
    from public.fbmejl_notis_lage l where l.id = 1;

  if v_hog_forst is not null
     and v_hog_forst < now() - make_interval(mins => v_hog_livs) then
    v_odelade_fore := 0;
  end if;

  if coalesce(v_odelade_fore, 0) > 0 then
    v_platspunkter := null;
  end if;

  -- Lyssnar någon, och lyssnar någon I NÄRHETEN?
  --
  -- Först av allt, och före spärrarna: har ingen slagit på gruppnotiser finns
  -- det inget att spärra. Tillståndet rörs INTE — varken senaste_at eller
  -- odelade. Att räkna upp odelade när ingen lyssnar hade betytt att den
  -- första som slår på notiser får "312 nya varningar i gruppen" som
  -- välkomsthälsning.
  --
  -- Samma resonemang gäller en omgång som ingen i närheten skulle fått: den
  -- ska inte heller läggas på hög. Den som bor i Västerås ska inte en tisdag få
  -- veta att det hänt fyrtio saker i Gävle sedan sist.
  v_mottagare_alla := public.fbmejl_gruppnotis_antal();
  if v_platspunkter is null then
    v_mottagare := v_mottagare_alla;
  else
    v_mottagare := public.fbmejl_gruppnotis_antal(v_platspunkter);
  end if;

  if coalesce(v_mottagare, 0) = 0 then
    insert into public.fbmejl_notis_logg (antal, utfall, skal, mottagare_inom, mottagare_totalt)
    values (
      v_antal,
      'ingen-mottagare',
      case when coalesce(v_mottagare_alla, 0) = 0
             then 'noll prenumeranter med gruppnotiser pa'
             else 'noll prenumeranter inom rackhall' end,
      0,
      coalesce(v_mottagare_alla, 0)
    );
    return jsonb_build_object('skickad', false, 'skal', 'ingen-mottagare',
                              'antal', v_antal, 'mottagare', 0,
                              'gallrade', v_gallrade,
                              'mottagare_totalt', coalesce(v_mottagare_alla, 0));
  end if;

  v_timme := extract(hour from (v_lokal at time zone 'Europe/Stockholm'))::int;
  v_dag   := (v_lokal at time zone 'Europe/Stockholm')::date;

  select * into v_lage from public.fbmejl_notis_lage where id = 1 for update;

  -- Nytt dygn nollställer räknaren.
  if v_lage.dag is distinct from v_dag then
    v_lage.antal_idag := 0;
    v_lage.dag := v_dag;
  end if;

  -- =================================================================
  --  HÖGEN SLÄPPS OM DEN ÄR FÖR GAMMAL
  -- =================================================================
  --
  -- Här, under låset, och FÖRE spärrarna. Före, därför att en spärrad omgång
  -- annars hade lagt sina färska rader ovanpå en hög som redan var utgången
  -- och samtidigt skrivit om dess datum — då hade den gamla högen aldrig
  -- kunnat åldras ut så länge gruppen var livlig, vilket är precis när den gör
  -- mest skada. Med provet först släpps den utgångna högen, och de färska
  -- raderna börjar om i en tom hög med sitt eget datum.
  --
  -- Släppet är tyst mot användaren och högljutt mot loggen. Raderna kommer
  -- aldrig tillbaka; de fanns bara som ett tal, och talet var inte längre sant.
  --
  -- Kolumnen kan vara null på en hög som byggdes av en äldre version av den
  -- här funktionen. Då kan provet inte fira, och högen får leva tills nästa
  -- spärr sätter ett datum på den. Backfyllningen vid alter table ovan gör att
  -- det bara kan hända om någon nollställer kolumnen för hand.
  if coalesce(v_lage.odelade, 0) > 0
     and v_lage.odelade_forst is not null
     and v_lage.odelade_forst < now() - make_interval(mins => v_hog_livs) then

    begin
      insert into public.fbmejl_notis_logg (antal, utfall, skal)
      values (v_lage.odelade, 'for-gammalt',
              'hogen slappt: senast pafylld ' ||
              to_char(v_lage.odelade_forst at time zone 'Europe/Stockholm',
                      'YYYY-MM-DD HH24:MI') ||
              ', aldre an ' || v_hog_livs || ' minuter');
    exception when others then
      null;
    end;

    update public.fbmejl_notis_lage
       set odelade = 0, odelade_forst = null, uppdaterad = now()
     where id = 1;

    -- Minnesbilden måste följa med, annars räknar v_totalt längre ner på ett
    -- tal som inte längre står i tabellen.
    v_lage.odelade := 0;
    v_lage.odelade_forst := null;
  end if;

  -- Spärrarna, i ordning. Först den som är billigast att avgöra.
  if v_timme < p_tidigast or v_timme >= p_senast then
    v_skal := 'natt';
  elsif v_lage.senaste_at is not null
        and v_lage.senaste_at > now() - make_interval(mins => greatest(0, p_min_minuter)) then
    v_skal := 'for-tatt';
  elsif v_lage.antal_idag >= greatest(0, p_tak_per_dygn) then
    v_skal := 'dygnstak';
  end if;

  if v_skal is not null then
    -- Undertryckt, inte glömt. Nästa notis som får gå berättar hur många
    -- varningar som kommit sedan sist — så länge högen hinner gå ut i tid.
    --
    -- odelade_forst skrivs om, utan coalesce: klockan ska stå på den SENAST
    -- tillagda raden. Ett coalesce här — startdatumet satt en gång av den
    -- omgång som råkade hamna först i en tom hög — hade fått släppet att mäta
    -- fel rad och kasta rapporter som lagts i högen sent och fortfarande var
    -- färska. Se HÖGEN i huvudet. Att en livlig grupp därmed får en hög som
    -- lever längre är det medvetna priset.
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal,
           odelade_forst = now(),
           dag = v_dag,
           antal_idag = v_lage.antal_idag,
           uppdaterad = now()
     where id = 1;

    insert into public.fbmejl_notis_logg (antal, utfall, skal)
    values (v_antal, 'sparrad', v_skal);

    return jsonb_build_object('skickad', false, 'skal', v_skal, 'antal', v_antal,
                              'gallrade', v_gallrade);
  end if;

  v_totalt := v_antal + coalesce(v_lage.odelade, 0);

  -- Det låsta värdet, som facit. Förhandstitten ovan kan ha varit en omgång
  -- gammal; den här kan inte. Filtret slås av åt samma håll en gång till, för
  -- säkerhets skull — att slå av det två gånger kostar ingenting, att missa
  -- det en gång kostar en varning.
  --
  -- Efter högsläppet ovan är v_lage.odelade noll när högen var för gammal, och
  -- då slås filtret inte av. Det är hela vinsten med släppet: en tyst natt
  -- slutar skicka morgonens Västeråsvarning till Malmö.
  if coalesce(v_lage.odelade, 0) > 0 then
    v_platspunkter := null;
    v_mottagare    := v_mottagare_alla;
  end if;

  -- Rubrikerna, utan dubbletter, högst tre. Fler får inte plats i en notis
  -- och gör den svårare att läsa på en låsskärm i en bil.
  --
  -- Bygger på det GALLRADE p_nya. Det är den viktigaste följden av att grinden
  -- ligger högst upp: flerfallet kastar 'svans', som är den enda del av
  -- meningen som bär åldern, så en gammal rad hade stått här som en rubrik
  -- utan datum och gjort hela notisen osann.
  select string_agg(q.r, ' · ' order by q.r) into v_platser
    from (
      select distinct on (lower(d.rubrik)) d.rubrik as r
        from (
          select public.fbmejl_mening(x.typ, x.utrustning, x.plats, x.created_at) ->> 'rubrik'
                   as rubrik
            from jsonb_to_recordset(p_nya)
                 as x(typ text, plats text, utrustning text, created_at bigint)
        ) d
       where coalesce(d.rubrik, '') <> ''
       order by lower(d.rubrik)
       limit 3
    ) q;

  if v_totalt = 1 then
    -- En enda varning: hela sammanfattningsmeningen, delad vid sitt eget
    -- tankstreck. Titeln säger VAD och VAR, brödtexten NÄR och VARIFRÅN.
    --
    -- Efter gallringen är det här fallet vanligare än förut, och det är bra:
    -- en omgång med en färsk och en gammal rad blir en omgång med en rad, och
    -- då får föraren "för 3 minuter sedan" i klartext i stället för "2 nya
    -- varningar i gruppen" och två rubriker utan åldrar.
    select public.fbmejl_mening(x.typ, x.utrustning, x.plats, x.created_at)
      into v_mening
      from jsonb_to_recordset(p_nya)
           as x(typ text, plats text, utrustning text, created_at bigint)
     limit 1;
    v_titel := left(coalesce(v_mening->>'rubrik', 'Ny varning i gruppen'), 80);
    v_text  := left(coalesce(v_mening->>'svans',
                             'Någon i Facebook-gruppen varnade. Öppna Polisvakt för att se var.'), 240);
  else
    v_titel := v_totalt || ' nya varningar i gruppen';
    v_text  := left(coalesce(v_platser, 'Öppna Polisvakt för att se var.'), 240);
  end if;

  -- Ut på nätet, om vägen dit finns. Saknas pg_net eller adressen loggas det
  -- som ett fel istället för att tyst försvinna — en notiskedja som ser frisk
  -- ut och inte når fram är den svåraste sortens fel, och den har den här
  -- appen redan haft en gång.
  --
  -- Observera att tillståndet inte är rört än. Varje väg ut härifrån som INTE
  -- lyckas köa anropet lägger tillbaka varningarna i odelade, precis som en
  -- spärr gör — och skriver om odelade_forst av exakt samma skäl.
  v_url    := public.fbmejl_installning('fbmejl_push_url');
  v_nyckel := public.fbmejl_anropsnyckel();

  if v_url is null or v_url = '' then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal,
           odelade_forst = now(),
           dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'fbmejl_push_url saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'fbmejl_push_url saknas');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-url', 'titel', v_titel,
                              'gallrade', v_gallrade);
  end if;

  -- Nyckeln, innan anropet och inte efter det. Utan nyckel svarar fbmejl-push
  -- 401 på varje anrop — den godtar ingen tom sträng, med flit, för en tom
  -- nyckel som duger vore ett öppet API.
  if v_nyckel is null or v_nyckel = '' then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal,
           odelade_forst = now(),
           dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'anropsnyckel saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'anropsnyckel saknas');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-nyckel', 'titel', v_titel,
                              'gallrade', v_gallrade);
  end if;

  -- Katalogen, inte to_regproc(): den senare KASTAR på ett överlagrat namn
  -- istället för att svara null, och pg_net har historiskt haft flera
  -- signaturer för http_post. Ett fel här hade blivit ett fel i notisen —
  -- alltså precis det den här kontrollen finns för att undvika.
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal,
           odelade_forst = now(),
           dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'pg_net saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'pg_net saknas');
    return jsonb_build_object('skickad', false, 'skal', 'pg_net-saknas', 'titel', v_titel,
                              'gallrade', v_gallrade);
  end if;

  begin
    -- Id:t sparas. Det är den enda kopplingen mellan den här raden i loggen
    -- och pg_nets svar i net._http_response.
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce(v_nyckel, '')
      ),
      body    := jsonb_build_object(
        'titel', v_titel,
        'text',  v_text,
        -- Samma tag varje gång: en ny gruppnotis ERSÄTTER den gamla i luren
        -- istället för att lägga sig ovanpå. Se push-lyssnaren i sw.js.
        'tag',   'polisvakt-grupp',
        'url',   './',
        'antal', v_totalt,
        -- URVALSKRITERIUM, INTE INNEHÅLL. Fältet läses av edge-funktionen och
        -- skickas vidare till fbmejl_push_mottagare. Det får ALDRIG in i
        -- byggNyttolast — koordinater på en låsskärm är inte vad någon bad om,
        -- och nyttolasten är det enda i kedjan som når telefonen.
        --
        -- Här finns ingen plats för ett ljudfält, och det ska inte tillkomma
        -- ett. Notification-API:ts sound är dött i alla webbläsare som räknas.
        -- Ljudet för en push med stängd app är telefonens systemljud, punkt.
        'platser', v_platspunkter
      )
    ) into v_net_id;
  exception when others then
    -- sqlerrm maskas innan den sparas. Nyckeln är ett ARGUMENT till
    -- net.http_post(), och Postgres skriver normalt inte ut argument i sina
    -- felmeddelanden — men "normalt" är inte "aldrig".
    v_fel := public.fbmejl_dolj_hemligheter(sqlerrm);
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal,
           odelade_forst = now(),
           dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = left(v_fel, 500), uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', left(v_fel, 200));
    return jsonb_build_object('skickad', false, 'skal', 'fel', 'detalj', v_fel,
                              'gallrade', v_gallrade);
  end;

  -- Först här. Anropet ligger i pg_nets kö, glesspärren och dygnstaket får
  -- räknas upp, och odelade nollställs eftersom varningarna nu är med i den
  -- text som ligger på väg ut. Med odelade nollställd måste odelade_forst bli
  -- null i samma andetag — annars hade nästa hög ärvt ett startdatum från en
  -- hög som redan gått ut, och släppts långt innan den var gammal.
  update public.fbmejl_notis_lage
     set senaste_at = now(),
         antal_idag = v_lage.antal_idag + 1,
         dag = v_dag,
         odelade = 0,
         odelade_forst = null,
         senaste_fel = null,
         uppdaterad = now()
   where id = 1;

  insert into public.fbmejl_notis_logg
    (antal, titel, text, utfall, net_id, mottagare_inom, mottagare_totalt)
  values
    (v_totalt, v_titel, v_text, 'koad', v_net_id, v_mottagare, v_mottagare_alla);

  -- 'koad', inte 'skickad', och nyckeln heter fortfarande skickad i svaret av
  -- bakåtkompatibilitet — men den betyder "köad hos pg_net", ingenting mer.
  return jsonb_build_object('skickad', true, 'utfall', 'koad', 'antal', v_totalt,
                            'titel', v_titel, 'mottagare', v_mottagare,
                            'mottagare_totalt', v_mottagare_alla,
                            'gallrade', v_gallrade,
                            'platser', case when v_platspunkter is null then 0
                                            else jsonb_array_length(v_platspunkter) end,
                            'net_id', v_net_id);
end $$;

-- ---------------------------------------------------------------------
-- RÄTTIGHETER — oförändrade. notis_ut skickar pushar och är revokad från
-- anon med flit. Grinden och livslängderna är ren matematik utan en enda
-- uppslagning mot en tabell, och de får därför läsas av vem som helst: de
-- avslöjar ingenting, och de ska gå att prova i SQL-editorn utan servernyckel
-- — annars provas de inte, och då är kontrollfrågorna längst ner bara text.
revoke execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                      from public, anon, authenticated;
grant  execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                      to service_role;

grant execute on function public.fbmejl_ttl_minuter(text)
                                                     to anon, authenticated, service_role;
grant execute on function public.fbmejl_ttl_tak_minuter()
                                                     to anon, authenticated, service_role;
grant execute on function public.fbmejl_notis_farsk(jsonb, bigint)
                                                     to anon, authenticated, service_role;

commit;

-- =====================================================================
--  EFTERKONTROLL
-- =====================================================================
--
-- Tre prov, alla körs automatiskt när filen körs. Samma upplägg som
-- notisradiens självprov: allt ovan är redan committat, så ett prov som
-- brakar tar inte grinden med sig i fallet. Det är avsiktligt och inte
-- slarv — går PROV 2 fel betyder det att livslängderna glidit isär, och då
-- är en grind med fel tal ändå bättre än det vi har idag, som är ingen grind
-- alls. Felet syns i editorn och ska rättas, men inte genom att lämna dörren
-- öppen under tiden.
--
-- Inget av proven skickar en notis. Bara PROV 3 rör buntningen, och den kör
-- select-satsen ur funktionen mot påhittade rader — aldrig funktionen själv.

-- PROV 1: håller grinden gränsen, för varje typ?
do $prov1$
declare
  v_typ    text;
  v_ttl    int;
  v_tak    int;
  v_slapp  bigint;   -- äldsta minuttal som SKA släppas igenom
  v_nu     bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  v_tak := public.fbmejl_ttl_tak_minuter();
  if v_tak <> 60 then
    raise exception 'Taket är % minuter, väntade 60. Har en TTL ändrats?', v_tak;
  end if;

  foreach v_typ in array array['police', 'control', 'unmarked', 'camera'] loop
    v_ttl   := least(public.fbmejl_ttl_minuter(v_typ), v_tak);
    -- Största heltal m med m*2 < ttl.
    v_slapp := (v_ttl - 1) / 2;

    if not public.fbmejl_notis_farsk(
         jsonb_build_object('typ', v_typ, 'created_at', v_nu - v_slapp * 60000), v_nu) then
      raise exception 'Grinden stoppar % vid % minuter — den skulle släppt.', v_typ, v_slapp;
    end if;

    if public.fbmejl_notis_farsk(
         jsonb_build_object('typ', v_typ, 'created_at', v_nu - (v_slapp + 1) * 60000), v_nu) then
      raise exception 'Grinden släpper % vid % minuter — den skulle stoppat.',
                      v_typ, v_slapp + 1;
    end if;

    -- Två dygn. Ägarens exempel, för varje typ.
    if public.fbmejl_notis_farsk(
         jsonb_build_object('typ', v_typ, 'created_at', v_nu - 2880::bigint * 60000), v_nu) then
      raise exception 'Grinden släpper % som är två dygn gammal.', v_typ;
    end if;
  end loop;

  -- Okänd, otrolig och trasig stämpel.
  if public.fbmejl_notis_farsk(jsonb_build_object('typ', 'police'), v_nu) then
    raise exception 'Grinden släpper en rad utan created_at.';
  end if;
  if public.fbmejl_notis_farsk(
       jsonb_build_object('typ', 'police', 'created_at', 0), v_nu) then
    raise exception 'Grinden släpper created_at = 0.';
  end if;
  if public.fbmejl_notis_farsk(
       jsonb_build_object('typ', 'police', 'created_at', v_nu + 600000), v_nu) then
    raise exception 'Grinden släpper en stämpel tio minuter in i framtiden.';
  end if;
  if public.fbmejl_notis_farsk(
       jsonb_build_object('typ', 'police', 'created_at', 'igår'), v_nu) then
    raise exception 'Grinden släpper en created_at som inte är ett tal.';
  end if;

  -- Tvåminuterstoleransen ska däremot vara kvar.
  if not public.fbmejl_notis_farsk(
       jsonb_build_object('typ', 'police', 'created_at', v_nu + 60000), v_nu) then
    raise exception 'Grinden stoppar en klocka som går en minut fel. Toleransen är borta.';
  end if;

  raise notice 'PROV 1 ok: grinden håller 22/29/14/29 minuter för police/control/unmarked/camera.';
end
$prov1$;

-- PROV 2: säger grinden och fbmejl_mening samma sak om samma rapport?
--
-- Det här är bevakningen som ersätter en refaktorering jag inte får göra.
-- fbmejl_mening() har livslängderna inbakade som ett eget case; grinden läser
-- dem ur fbmejl_ttl_minuter(). Skulle de någonsin gå isär hade grinden tystat
-- rapporter vars text är neutral, eller släppt fram rapporter vars text säger
-- "Kan ha flyttat på sig" — och båda är precis det den finns för att stoppa.
--
-- Provet gäller de rörliga typerna. Kameran är med flit avvikande: där ÄR
-- grinden strängare än texten, se resonemanget i huvudet.
do $prov2$
declare
  v_typ   text;
  v_ttl   int;
  v_slapp bigint;
  v_nu    bigint := (extract(epoch from now()) * 1000)::bigint;
  v_svans text;
begin
  foreach v_typ in array array['police', 'control', 'unmarked'] loop
    v_ttl   := public.fbmejl_ttl_minuter(v_typ);
    v_slapp := (v_ttl - 1) / 2;

    -- Sista minuten grinden släpper: texten ska ännu inte ta något förbehåll.
    v_svans := public.fbmejl_mening(v_typ, null, 'Testvägen',
                                    v_nu - v_slapp * 60000) ->> 'svans';
    if v_svans like '%flyttat på sig%' or v_svans like '%inte kvar%' then
      raise exception
        'DRIFT: fbmejl_mening hedgar redan vid % minuter för %, men grinden släpper. Svans: %',
        v_slapp, v_typ, v_svans;
    end if;

    -- Första minuten grinden stoppar: texten ska ha börjat hedga.
    v_svans := public.fbmejl_mening(v_typ, null, 'Testvägen',
                                    v_nu - (v_slapp + 1) * 60000) ->> 'svans';
    if not (v_svans like '%flyttat på sig%' or v_svans like '%inte kvar%') then
      raise exception
        'DRIFT: grinden stoppar % vid % minuter men fbmejl_mening är fortfarande neutral. Svans: %',
        v_typ, v_slapp + 1, v_svans;
    end if;
  end loop;

  raise notice 'PROV 2 ok: grinden och fbmejl_mening byter tonläge på exakt samma minut.';
end
$prov2$;

-- PROV 3: gallrar buntningen rad för rad, och bara raderna?
--
-- Provet kör den riktiga select-satsen ur fbmejl_notis_ut mot en påhittad
-- omgång med en färsk och en två dygn gammal rad. Två frågor: överlever den
-- färska, och överlever den med sina koordinater i behåll?
do $prov3$
declare
  v_nu     bigint := (extract(epoch from now()) * 1000)::bigint;
  v_omgang jsonb;
  v_kvar   jsonb;
begin
  v_omgang := jsonb_build_array(
    jsonb_build_object('typ', 'control', 'plats', 'Erikslund', 'utrustning', 'laser',
                       'created_at', v_nu - 2880::bigint * 60000,
                       'lat', 59.60, 'lon', 16.50),
    jsonb_build_object('typ', 'police', 'plats', 'Hälla', 'utrustning', null,
                       'created_at', v_nu - 3::bigint * 60000,
                       'lat', 59.62, 'lon', 16.61)
  );

  select coalesce(jsonb_agg(e.rad), '[]'::jsonb)
    into v_kvar
    from jsonb_array_elements(v_omgang) as e(rad)
   where public.fbmejl_notis_farsk(e.rad, v_nu);

  if jsonb_array_length(v_kvar) <> 1 then
    raise exception 'Gallringen lämnade % rader, väntade 1.', jsonb_array_length(v_kvar);
  end if;
  if v_kvar->0->>'plats' <> 'Hälla' then
    raise exception 'Fel rad överlevde gallringen: %', v_kvar->0->>'plats';
  end if;
  if (v_kvar->0->>'lat') is null or (v_kvar->0->>'lon') is null then
    raise exception 'Gallringen tappade koordinaterna — avståndsfiltret skulle slås av.';
  end if;

  raise notice 'PROV 3 ok: den färska raden överlever med koordinater, den gamla faller bort.';
end
$prov3$;

do $klar$
begin
  raise notice '';
  raise notice 'Åldersgrinden är på.';
  raise notice '  Notisvärd ålder: polis 22 min, kontroll 29, civil 14, kamera 29.';
  raise notice '  Högen (odelade) släpps efter % minuter.',
               greatest(1, public.fbmejl_ttl_tak_minuter() / 2);
  raise notice '  Kartan är orörd: reports skrivs precis som förut.';
  raise notice '';
end
$klar$;

-- =====================================================================
--  KONTROLLFRÅGOR
-- =====================================================================
--
-- Kör dem i SQL-editorn efter migrationen och läs svaren. Ingen av dem
-- skickar en enda notis — den enda som rör notiskedjan är fråga 6, och den
-- är inpackad i en rollback.

-- 1. Finns allt, och står talen rätt?
--
-- Vänta: 45 / 60 / 30 / 525600, tak 60, och grinden 22 / 29 / 14 / 29.
--
-- select t                                              as typ,
--        public.fbmejl_ttl_minuter(t)                   as livslangd_min,
--        least(public.fbmejl_ttl_minuter(t),
--              public.fbmejl_ttl_tak_minuter())         as raknas_som,
--        (least(public.fbmejl_ttl_minuter(t),
--               public.fbmejl_ttl_tak_minuter()) - 1)/2 as notisvard_till_min
--   from unnest(array['police','control','unmarked','camera']) as t;

-- 2. Ägarens exempel, rakt av. Vänta false på alla fyra.
--
-- select t,
--        public.fbmejl_notis_farsk(jsonb_build_object(
--          'typ', t,
--          'created_at', (extract(epoch from now())*1000)::bigint - 2*24*60*60*1000
--        )) as ger_notis
--   from unnest(array['police','control','unmarked','camera']) as t;

-- 3. Var går brytpunkten, minut för minut? Vänta true upp till och med 22
--    för police, false därefter.
--
-- select m,
--        public.fbmejl_notis_farsk(jsonb_build_object(
--          'typ', 'police',
--          'created_at', (extract(epoch from now())*1000)::bigint - m*60000
--        )) as ger_notis,
--        public.fbmejl_mening('police', null, 'Testvägen',
--          (extract(epoch from now())*1000)::bigint - m*60000) ->> 'svans' as texten
--   from generate_series(20, 25) as m;

-- 4. Ligger det en hög just nu, och hur länge sedan fylldes den på?
--    odelade_forst null och odelade 0 är det normala läget.
--
-- select odelade,
--        odelade_forst,
--        case when odelade_forst is null then null
--             else round(extract(epoch from now() - odelade_forst)/60) end as sedan_pafylld_min,
--        greatest(1, public.fbmejl_ttl_tak_minuter()/2)                    as slapps_efter_min,
--        senaste_at, antal_idag, dag
--   from public.fbmejl_notis_lage where id = 1;

-- 5. Vad har grinden gallrat sedan den slogs på?
--    utfall 'for-gammalt' med skal 'gallrade rader...' = enskilda rapporter.
--    utfall 'for-gammalt' med skal 'hogen slappt...'   = en hel hög.
--
-- select skickat_at, antal, skal
--   from public.fbmejl_notis_logg
--  where utfall = 'for-gammalt'
--  order by skickat_at desc
--  limit 20;

-- 6. Torrkörning av hela kedjan, utan att något skickas.
--    Vänta: skickad = false, skal = 'for-gammalt', gallrade = 2.
--    ROLLBACK i slutet är inte valfritt — utan den ligger loggraderna kvar.
--
-- begin;
--   select public.fbmejl_notis_ut(jsonb_build_array(
--     jsonb_build_object('typ','control','plats','Erikslund','utrustning','laser',
--                        'created_at',(extract(epoch from now())*1000)::bigint - 2*24*60*60*1000,
--                        'lat',59.60,'lon',16.50),
--     jsonb_build_object('typ','unmarked','plats','E18','utrustning',null,
--                        'created_at',(extract(epoch from now())*1000)::bigint - 40*60000,
--                        'lat',59.61,'lon',16.55)
--   ));
-- rollback;

-- 7. Samma sak men med EN färsk rad tillagd. Vänta att svaret handlar om
--    EN varning (den färska), att gallrade = 2, och att titeln är den
--    enskilda meningen och inte "3 nya varningar i gruppen".
--
--    Kommer skal 'natt', 'for-tatt' eller 'dygnstak' tillbaka är det en spärr
--    som svarade, inte grinden — gallrade-talet i svaret gäller ändå.
--
-- begin;
--   select public.fbmejl_notis_ut(jsonb_build_array(
--     jsonb_build_object('typ','control','plats','Erikslund','utrustning','laser',
--                        'created_at',(extract(epoch from now())*1000)::bigint - 2*24*60*60*1000,
--                        'lat',59.60,'lon',16.50),
--     jsonb_build_object('typ','unmarked','plats','E18','utrustning',null,
--                        'created_at',(extract(epoch from now())*1000)::bigint - 40*60000,
--                        'lat',59.61,'lon',16.55),
--     jsonb_build_object('typ','police','plats','Hälla','utrustning',null,
--                        'created_at',(extract(epoch from now())*1000)::bigint - 3*60000,
--                        'lat',59.62,'lon',16.61)
--   ));
-- rollback;

-- 8. Kartan då — skrivs rapporterna fortfarande?
--    Jämför antalet facebook-rapporter det senaste dygnet med antalet
--    notisrader. De ska INTE vara lika, och skillnaden är hela poängen.
--
-- select
--   (select count(*) from public.reports
--     where source = 'facebook'
--       and created_at > (extract(epoch from now() - interval '24 hours')*1000)::bigint)
--                                                                  as pa_kartan_dygnet,
--   (select coalesce(sum(antal), 0) from public.fbmejl_notis_logg
--     where utfall = 'koad' and skickat_at > now() - interval '24 hours')
--                                                                  as i_notiser_dygnet,
--   (select coalesce(sum(antal), 0) from public.fbmejl_notis_logg
--     where utfall = 'for-gammalt' and skickat_at > now() - interval '24 hours')
--                                                                  as gallrade_dygnet;

-- 9. Sanity: har någon råkat köra om supabase/fbmejl.sql efteråt och tappat
--    'for-gammalt' ur villkoret? Vänta att raden nedan hittar värdet.
--
-- select conname,
--        pg_get_constraintdef(oid) like '%for-gammalt%' as villkoret_ar_uppdaterat
--   from pg_constraint
--  where conname = 'fbmejl_notis_logg_utfall_check';
