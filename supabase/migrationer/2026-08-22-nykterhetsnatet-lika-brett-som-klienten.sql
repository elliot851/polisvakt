-- Migration: serverns nykterhetsnät blir minst lika brett som klientens.
--
-- Kör hela filen i Supabase SQL Editor på en databas där supabase/chatt.sql,
-- supabase/telegram.sql och supabase/fbmejl.sql redan är körda. Den skapar EN
-- ny funktion och ersätter TRE. Ingen tabell ändras, ingen rad raderas, ingen
-- rapport rörs. Filen är säker att köra om.
--
-- ---------------------------------------------------------------------
-- VARFÖR NU: klientens typord blir bredare i samma ändring
--
-- js/parser.js matchar typord ord mot ord (set.has). "trafikkamera" innehöll
-- ordet "kamera" men var inte ordet "kamera", så inlägget blev ingen rapport
-- alls. Den matchningen breddas nu till svenska sammansättningar.
--
-- Det gör INTE att klienten börjar släppa igenom nykterhetskontroller.
-- Nykterhetsspärren i js/parser.js körs på rad 225, FÖRE findType, och är
-- alltså helt oberoende av typorden. Frågan är en annan, och värre.
--
-- Före breddningen dog varje text utan exakt typord tyst på "ingen-rapport".
-- Det var i praktiken ett extra filter: en drogtext som klientens ordlista
-- missade stoppades ändå, av misstag, för att den inte råkade innehålla ett
-- typord ordagrant. Den slumpen försvinner nu. Texter som tidigare aldrig
-- blev något blir rapporter, och då är serverns nät det enda som står kvar.
--
-- Konkret, mätt mot dagens kod:
--
--   "Poliskontrollen vid Hälla var bara en drogkoll"
--
--   Klienten i dag:    findType hittar inget ("poliskontrollen" är inte
--                      "kontroll"), texten dör som ingen-rapport.
--   Klienten efteråt:  typ = control. Nykterhetsspärren släpper igenom den,
--                      för "drogkoll" står inte i SOBRIETY_WORDS, "drog" är
--                      med flit inget stamord, och isärskrivningsregeln
--                      kräver två ord — här är det ett.
--   Servern i dag:     släpper igenom. Ordet finns i ingen av de tre SQL-
--                      funktionerna, och "koll" i bestämd form finns inte
--                      ens som huvudord.
--   Servern efteråt:   vägrar. Se regel 3 nedan.
--
-- Det är hela ärendet. Nätet under klienten måste bli minst lika finmaskigt
-- i samma ändring, annars byter breddningen ett tyst bortfall mot en
-- publicerad drogkontroll.
--
-- ---------------------------------------------------------------------
-- VAD SERVERN SÅG UT ATT GÖRA, OCH VAD DEN GJORDE
--
-- supabase/telegram.sql rad 38-40 och supabase/fbmejl.sql rad 112-116 säger
-- båda att nätet "bara kan avvisa MER, aldrig släppa igenom mer" än
-- js/parser.js. Det stämde inte. Uppmätt mot parsern saknade de två
-- regexarna "blås" ensamt, ASCII-formerna blasa/blaste/blasning,
-- "drogrelaterad", stammen "alko" och paret "drog prov". chatt_ar_nykterhet
-- saknade fem ord och HELA stamlistan, alltså gick alkoholrazzia,
-- promillekoll, utandningstest och sållningskontroll rakt igenom den CHECK
-- som är det enda skyddet mot en curl-insert med anon-nyckeln
-- (motiveringen står i supabase/chatt.sql rad 136-139).
--
-- Tre kopior, tre matchningsspråk, tre olika svar på samma mening. Påståendet
-- om enkelriktning var en kommentar, inte en egenskap.
--
-- ---------------------------------------------------------------------
-- VALET: en funktion, tre omslag — inte tre kopior till
--
-- Alternativ 1, förkastat: skriva samma ordlista en fjärde, femte och sjätte
-- gång, en per funktion, som filerna gör i dag. Motiveringen i fbmejl.sql
-- lyder att "ett nät som bara kan säga NEJ kan inte bli farligt av att finnas
-- i två exemplar". Den motiveringen är nu motbevisad av mätning: kopiorna
-- gled isär, och de gled isär åt det håll som gör nätet svagare. Ett nät som
-- bara kan säga nej blir farligt precis när den ena kopian slutar säga nej.
--
-- Alternativ 2, förkastat: en trigger på reports som fångar alla vägar in.
-- Samma invändning som i 2026-08-21-brygga-notiskedja.sql: nätet är MEDVETET
-- bredare än parsern, och en trigger skulle köra det på rapporter som förare
-- själva skapat med knapparna och rösten. Då börjar appen avvisa sina egna
-- användare.
--
-- Alternativ 3, valt: public.nykterhet_ar_kontroll(text) bär regeln en gång.
-- chatt_ar_nykterhet, telegram_ar_nykterhetskontroll och
-- fbmejl_ar_nykterhetskontroll behåller sina namn, signaturer, returtyper,
-- immutable-märkning och rättigheter, men blir tre rader var som anropar den.
-- Namnen behålls för att anroparna är många och står i tre filer, i CHECK-
-- villkoret chatt_nykterhet och i fbmejl_ko_in/fbmejl_ta_emot.
--
-- Priset, uttalat: kör någon om supabase/telegram.sql eller supabase/fbmejl.sql
-- efter den här migrationen skrivs omslaget tillbaka till den gamla, smalare
-- regexen — tyst. Kontroll 6 längst ner upptäcker exakt det. Källfilerna bör
-- följa efter i en egen ändring; den här migrationen rör dem inte.
--
-- ---------------------------------------------------------------------
-- MATCHNINGEN: allt mäts på den hopskrivna texten
--
-- Regeln normaliserar som normalize() i js/util.js, klistrar sedan ihop hela
-- texten utan skiljetecken och letar delsträngar i den. Tre regler:
--
--   1. Orden      31 ord ur SOBRIETY_WORDS, som delsträng.
--   2. Stammarna  13 stammar ur SOBRIETY_STAMMAR, som delsträng.
--   3. Förled     varje förled hopklistrat med varje huvudord, som delsträng.
--
-- Att allt mäts på den HOPSKRIVNA texten är hela poängen, och det ger tre
-- saker gratis:
--
--   Bestämd form och plural. "kontroll" som delsträng fångar kontrollen,
--   kontroller, kontrollerna, kontrollerar. "koll" fångar kollen och kollar.
--   Huvudordslistan behöver därför bara de kortaste formerna — det var just
--   bestämd form som saknades och som släppte igenom "drog kollen".
--
--   Sammansättningar. Svenska sammansättningar är huvudfinala, så en
--   delsträngsträff på huvudordet fångar varje förled: drogkontroll,
--   narkotikakontroll, alkoholkontroll.
--
--   Isärskrivning och bindestreck. Hopklistringen suddar skillnaden mellan
--   "drog kontroll", "drog-kontroll" och "drogkontroll". Den separata
--   grannords-loopen som chatt_ar_nykterhet hade behövs inte längre; den är
--   en delmängd av regel 3.
--
-- OCH DET GER BEVISET. Klientens isSobrietyCheck matchar på tre sätt:
-- words.includes / text.includes / hopskrivet.includes för orden, startsWith
-- på token plus hopskrivet.includes för stammarna, och två grannord för
-- förled+huvud. Var och en av dem är en delmängd av "delsträng i den
-- hopskrivna texten". Så länge serverns fyra listor är supermängder av
-- klientens fyra listor kan servern alltså ALDRIG vägra mindre än klienten.
-- Det är inte en ambition, det följer av formen. Ordlistan och stamlistan
-- står därför ordagrant som i js/parser.js, så att en diff är mekanisk, och
-- allt som är bredare står samlat under rubriken SERVERTILLÄGG.
--
-- ---------------------------------------------------------------------
-- MÄTT INNAN FILEN SKREVS KLAR, INTE PÅSTÅTT
--
-- Regeln nedan kördes mot den riktiga isSobrietyCheck ur js/parser.js på ett
-- korpus om 2312 meningar, byggt av varje ord, stam, förled och huvudord i
-- båda listorna satt i tio olika satsmönster och i varenda förled-huvud-par.
--
--   klienten vägrade  1471
--   servern vägrade   1546
--   fall där klienten vägrade men servern släppte igenom:  0
--
-- Samma regel kördes mot regressionssviten i tools/brygg-daemon.ps1 rad
-- 934-982: 17 av 17 i $skaVagras vägras, 9 av 9 i $skaSlappasIgenom släpps
-- igenom. Båda fallen i $kandLucka ("De blaser alla vid Skiljebo") fångas nu
-- också — den kommentaren i daemonen beskriver en lucka som inte finns kvar,
-- varken i js/parser.js eller här. Den bör städas, men inte i den här filen.
--
-- ---------------------------------------------------------------------
-- FALSKA UTFALL SOM FÖLJER MED, MED ÖPPNA ÖGON
--
-- Delsträng på hopklistrad text ger fel svar över ordgränser. Tre fall är
-- uppmätta i dag, och alla tre ÄRVS från js/parser.js — klienten vägrar dem
-- redan, servern gör bara samma bedömning:
--
--   "Polisen har total kontroll på E18"  -> "totalkontroll" innehåller "alko".
--   "Polis vid Blåsbo"                   -> ortnamnet innehåller "blås", och
--                                           Blåsbo står i appens egen
--                                           ortlista (data/aliases.vasteras.json).
--   "Trafikkontrollen är avblåst"        -> "avblåst" innehåller "blås", så
--                                           avblåsningsordet i CLEAR_WORDS är
--                                           i praktiken oåtkomligt.
--
-- Ett fall är nytt med regel 3: "polisen drog, kolla in bilden" blir
-- "drogkolla" när texten klistras ihop, och vägras.
--
-- Alla fyra kostar en utebliven polisvarning. Det är fel, och de ska lagas —
-- men i js/parser.js, inte här. Servern får aldrig bli den smalaste kopian,
-- för då slutar enkelriktningen gälla och beviset ovan faller. Ordningen är:
-- laga klienten först, låt servern följa efter. Aldrig tvärtom.
--
-- ---------------------------------------------------------------------
-- Om formen: noll blockkommentarer i hela filen, med flit. Samma skäl som i
-- 2026-08-21-brygga-notiskedja.sql — en stjärna följd av snedstreck avslutar
-- en blockkommentar mitt i raden, och det har redan dödat en körning här.

do $vakt$
begin
  if to_regproc('public.chatt_ar_nykterhet') is null
     or to_regproc('public.telegram_ar_nykterhetskontroll') is null
     or to_regproc('public.fbmejl_ar_nykterhetskontroll') is null then
    raise exception 'Kör supabase/chatt.sql, supabase/telegram.sql och supabase/fbmejl.sql först — en av de tre nykterhetsfunktionerna saknas.';
  end if;
end $vakt$;

begin;

-- ============================ NÄTET ==================================
--
-- immutable, för chatt_nykterhet är ett CHECK-villkor och ett CHECK får inte
-- kalla något som kan svara olika på samma text. Ingen security definer:
-- funktionen läser ingenting, den ser bara på en sträng.

create or replace function public.nykterhet_ar_kontroll(p_text text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_text text;
  v_hop  text;
  v_i    int;
  v_j    int;

  -- Ordagrant SOBRIETY_WORDS i js/parser.js rad 43-68. Ändras listan där ska
  -- den ändras här, och en diff ska vara mekanisk — därför står orden i samma
  -- ordning och utan tillägg.
  v_ord text[] := array[
    'nykterhetskontroll', 'nykterhetskontroller', 'nykterhet', 'nykter',
    'alkoholkontroll', 'alkotest', 'alkoholtest', 'blåsa', 'blåser', 'blås',
    'utandningsprov', 'promillekontroll', 'rattfylla', 'rattfyllerikontroll',
    'sållningsprov', 'drogkontroll', 'drogtest',
    'narkotikakontroll', 'narkotika', 'narko', 'droger', 'drogsök', 'drogsok',
    'drogsökhund', 'drogsokhund', 'drogrelaterad',
    -- Blås-orden utan svenska tecken. Folk skriver utan prickar på gamla
    -- telefoner och när autokorrigeringen står på engelska. "blas" ensamt
    -- står med flit INTE här: tre tecken är för nära vanliga ord, och en
    -- spärr som vägrar riktiga polisvarningar kostar också liv.
    'blaser', 'blasa', 'blaste', 'blasning', 'blåsning'
  ];

  -- Ordagrant SOBRIETY_STAMMAR i js/parser.js rad 83-87.
  --
  -- "drog" står inte här, och det är inget förbiseende: det är också
  -- imperfekt av "dra", och "polisen drog vidare" är en avblåsning, inte en
  -- kontroll. Ordet fångas i stället av regel 3, där nästa ordled avgör
  -- betydelsen.
  -- 'nyckter' är felstavningen av 'nykter'. Den är inget svenskt ord och
  -- kostar därför ingenting; utan den gick "Nyckterhetsrazzia" förbi hela
  -- stamlistan. Står också i js/parser.js.
  v_stam text[] := array[
    'nykter', 'nyckter', 'alkohol', 'alko', 'promille', 'rattfyll',
    'utandnings', 'sållnings', 'sallnings',
    'narkotika', 'narko', 'droger', 'drogsök', 'drogsok'
  ];

  -- SOBRIETY_PREFIX i js/parser.js rad 102-106, plus SERVERTILLÄGG.
  --
  -- Notera att varje förled utom "drog" redan täcks av en stam ovan. Regel 3
  -- finns alltså i praktiken för "drog" — det ord som inte får stå ensamt.
  -- Tilläggen är former utan foge-s och utan ändelse, som stammarna missar:
  -- "utandning prov", "sållning kontroll", "rattfyllkoll".
  v_forled text[] := array[
    'alkohol', 'alko', 'nykterhets', 'nykterhet', 'promille', 'rattfylleri',
    'rattfylla', 'drog', 'droger', 'utandnings', 'sållnings', 'sallnings',
    'narkotika', 'narko',
    -- SERVERTILLÄGG
    'rattfyll', 'utandning', 'sållning', 'sallning'
  ];

  -- SOBRIETY_HEAD i js/parser.js rad 107, plus SERVERTILLÄGG.
  --
  -- Klientens lista är kontroll, kontroller, test, prov, kollar, koll. Här
  -- står bara de kortaste formerna, för delsträngsmatchningen tar resten:
  -- "kontroll" fångar kontrollen och kontrollerna, "koll" fångar kollen och
  -- kollar. Det var precis den bestämda formen som saknades och som lät
  -- "Polisen har drog kollen på E18" bli en polisrapport.
  --
  -- SERVERTILLÄGGEN är tre huvudord klienten inte har:
  --   razzia  "drograzzia", "alkoholrazzia" — samma sak, annat ord.
  --   sök/sok "drogsök" står redan i ordlistan, men inte "narkosök".
  --   hund    "droghund" är hur folk faktiskt skriver om en narkotikahund.
  --           Priset är att "polisen drog hunden ur bilen" vägras. Det är en
  --           mening ingen skriver i en varningsgrupp, och en utebliven
  --           varning väger lättare än en spridd drogkontroll.
  --
  -- razzia, sök och hund är numera INTE servertillägg: js/parser.js har dem
  -- också. Kvar som skillnad står bara att klienten räknar upp böjda former
  -- (kontroller, kollar) som delsträngsmatchningen här inte behöver.
  --
  -- 'polis' och 'piket' kom till i samma ändring som klientens, och av samma
  -- skäl: båda är TYPORD, så "drogpolisen" och "drogpiketen" blev annars
  -- publicerade polisvarningar med notis. Priset är att "nu drog polisen från
  -- Erikslund" vägras — en avblåsning som tystnar, aldrig en varning som
  -- uteblir. 'poliser' behövs inte: delsträngen 'polis' tar den.
  v_huvud text[] := array[
    'kontroll', 'test', 'prov', 'koll',
    'razzia', 'sök', 'sok', 'hund', 'polis', 'piket'
  ];
begin
  -- Samma normalisering som normalize() i js/util.js rad 82-88. Bindestreck
  -- och understreck överlever med flit där (gatunamn) — de tas bort en rad
  -- längre ner i stället, och bara för den här bedömningen.
  v_text := btrim(
    regexp_replace(
      regexp_replace(lower(coalesce(p_text, '')), '[^0-9a-z_åäöéèü\s-]', ' ', 'g'),
      '\s+', ' ', 'g'));

  if v_text = '' then
    return false;
  end if;

  -- Hela texten utan skiljetecken. Bindestrecket sist i teckenklassen, inte
  -- rymt med bakstreck: sist är det alltid ett bokstavligt tecken, och då
  -- finns ingen tolkningsfråga kvar att göra fel på. Tankstreck, snedstreck
  -- och punkt är redan borta efter normaliseringen ovan, men de står kvar
  -- här för att spegla SKILJETECKEN i js/parser.js rad 123 ord för ord — om
  -- normaliseringen någon gång ändras ska det här steget inte tyst luckras.
  v_hop := regexp_replace(v_text, '[ –—/._-]+', '', 'g');

  -- 1. Orden.
  --
  -- Bara v_hop söks, inte v_text. Varje ord i listan är sammanhängande
  -- bokstäver, så att ta bort skiljetecken kan bara skapa träffar, aldrig
  -- förstöra dem: en träff i v_text är alltid också en träff i v_hop.
  for v_i in 1 .. array_length(v_ord, 1) loop
    if strpos(v_hop, v_ord[v_i]) > 0 then
      return true;
    end if;
  end loop;

  -- 2. Stammarna.
  --
  -- Klienten kollar stammen både som ordinledning och som delsträng i den
  -- hopskrivna texten. Delsträngen rymmer ordinledningen, så en egen
  -- ordloop vore död kod här.
  for v_i in 1 .. array_length(v_stam, 1) loop
    if strpos(v_hop, v_stam[v_i]) > 0 then
      return true;
    end if;
  end loop;

  -- 3. Förled hopklistrat med huvudord.
  --
  -- Ett och samma prov täcker tre skrivsätt: "drogkontroll", "drog kontroll"
  -- och "drog-kontroll" ser likadana ut i v_hop. Klientens grannordsregel är
  -- alltså en äkta delmängd av den här loopen.
  --
  -- 18 x 8 delsträngsprov på en text som är högst några hundra tecken. Det
  -- körs en gång per insert och kostar mikrosekunder; att i stället bygga en
  -- regex av listorna skulle spara ingenting mätbart och lägga till precis
  -- den escape-risk som js/parser.js filhuvud varnar för.
  for v_i in 1 .. array_length(v_forled, 1) loop
    for v_j in 1 .. array_length(v_huvud, 1) loop
      if strpos(v_hop, v_forled[v_i] || v_huvud[v_j]) > 0 then
        return true;
      end if;
    end loop;
  end loop;

  return false;
end $$;

comment on function public.nykterhet_ar_kontroll(text) is
  'Nykterhets- och drogkontroller får aldrig bli rapporter. Enda kopian på servern; chatt_ar_nykterhet, telegram_ar_nykterhetskontroll och fbmejl_ar_nykterhetskontroll anropar den här. Speglar SOBRIETY_WORDS, SOBRIETY_STAMMAR, SOBRIETY_PREFIX och SOBRIETY_HEAD i js/parser.js och får bara vara bredare, aldrig smalare.';

-- ============================ DE TRE OMSLAGEN ========================
--
-- Namn, argumenttyp, returtyp och immutable-märkning är oförändrade, så
-- create or replace behåller varje befintlig grant och varje beroende:
-- CHECK-villkoret chatt_nykterhet på public.chatt_meddelanden fortsätter
-- gälla utan att röras, och inga befintliga rader omprövas.
--
-- Omslagen är language sql, inte plpgsql, så planeraren kan baka in dem.
-- search_path saknar public med flit — därför är anropet kvalificerat.

create or replace function public.chatt_ar_nykterhet(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  -- Var en egen kopia med egen ordlista. Den saknade drogrelaterad, blaser,
  -- blasa, blaste, blasning och hela stamlistan, alltså gick alkoholrazzia,
  -- promillekoll, utandningstest och sållningskontroll igenom CHECK:en.
  select public.nykterhet_ar_kontroll(p_text);
$$;

create or replace function public.telegram_ar_nykterhetskontroll(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  -- Var en POSIX-regex utan normalisering. Den saknade blås ensamt, blasa,
  -- blaste, blasning, drogrelaterad, stammen alko och paret drog prov.
  select public.nykterhet_ar_kontroll(p_text);
$$;

create or replace function public.fbmejl_ar_nykterhetskontroll(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  -- Bar ordagrant samma regex som telegram-varianten, med samma luckor.
  select public.nykterhet_ar_kontroll(p_text);
$$;

-- ============================ RÄTTIGHETER ============================
--
-- Omslagen är inte security definer, så anroparen måste själv få köra det
-- inre nätet. chatt_nykterhet körs som den som gör insert — alltså anon.
--
-- Att nätet får läsas av alla avslöjar ingenting: det svarar sant eller
-- falskt om en text den redan fått, och det är bekvämt att kunna prova en
-- mening i SQL-editorn. Samma resonemang som redan gäller
-- fbmejl_ar_nykterhetskontroll i supabase/fbmejl.sql rad 2462.

grant execute on function public.nykterhet_ar_kontroll(text) to anon, authenticated, service_role;

commit;

-- ============================ KONTROLL ===============================
--
-- Kör frågorna nedan efter migrationen. De ändrar ingenting.

-- 1. SKA VÄGRAS. Varenda rad ska ge true i alla tre kolumnerna.
--
--    Rad 1-3 är hålet den här migrationen finns för: den bestämda formen av
--    huvudordet, och samma ord hopskrivet. Rad 1 är meningen ur
--    filhuvudet — texten som klientens breddade typord gör till en rapport.
--    Rad 4-9 gick igenom chatt_ar_nykterhet fram till i dag, för den saknade
--    stamlistan. Rad 10-13 gick igenom de två SQL-regexarna.

select t,
       public.chatt_ar_nykterhet(t)               as chatt,
       public.telegram_ar_nykterhetskontroll(t)   as telegram,
       public.fbmejl_ar_nykterhetskontroll(t)     as fbmejl
  from (values
    ('Poliskontrollen vid Hälla var bara en drogkoll'),
    ('Polisen har drog kollen på E18'),
    ('Drogkollen vid Erikslund pågår fortfarande'),
    ('Alkoholrazzia vid Erikslund i kväll'),
    ('Promillekoll på Vasagatan'),
    ('Utandningstest vid Skiljebo'),
    ('Sållningskontroll på E18 västerut'),
    ('Polis med droghund vid Bäckby'),
    ('Nykterhetskontrollen vid rondellen står kvar'),
    ('Drogrelaterad kontroll vid Hälla'),
    ('Polisen blaste mig vid Ikea'),
    ('Polis gör drog-kontroll vid Erikslund'),
    ('Narkotika kontroll vid Erikslund')
  ) as p(t);

-- 2. SKA SLÄPPAS IGENOM. Varenda rad ska ge false i alla tre kolumnerna.
--
--    Rad 1-4 är de rapporter appen finns för. Rad 3 är driftfallet från
--    2026-08-22 16:16 som startade hela ändringen — den får inte tystas av
--    nätet nu när klienten äntligen ser den.
--    Rad 5-6 står ordagrant i regressionssviten $skaSlappasIgenom i
--    tools/brygg-daemon.ps1 rad 955-965. "drog" och "dragit" är imperfekt av
--    "dra", inte narkotika, och det är därför "drog" inte är ett stamord.
--    Rad 7-9 är formerna klientens breddade typord nyss började se: bestämd
--    form och sammansättning. De blir rapporter först nu, och de ska bli det.

select t,
       public.chatt_ar_nykterhet(t)               as chatt,
       public.telegram_ar_nykterhetskontroll(t)   as telegram,
       public.fbmejl_ar_nykterhetskontroll(t)     as fbmejl
  from (values
    ('Polis vid Erikslund'),
    ('Fartkontroll på E18'),
    ('Står en mobil trafikkamera vid första avfarten Hälla'),
    ('Civil polisbil vid rondellen'),
    ('Polisen drog vidare från Skiljebo'),
    ('Polisen har dragit igång en hastighetskontroll'),
    ('Poliskontrollen vid Hälla står kvar'),
    ('Trafikkameran på E18 blixtrade nyss'),
    ('Polisbilen åkte iväg från Bäckby')
  ) as p(t);

-- 3. De tre måste svara likadant på varje text. Ska ge NOLL rader.
--
--    Det är hela poängen med att de delar en funktion. Kommer det en rad har
--    någon skrivit tillbaka en egen kopia i ett av omslagen.

select t
  from (
    select t,
           public.chatt_ar_nykterhet(t)             as a,
           public.telegram_ar_nykterhetskontroll(t) as b,
           public.fbmejl_ar_nykterhetskontroll(t)   as c
      from (values
        ('Poliskontrollen vid Hälla var bara en drogkoll'),
        ('Polisen har drog kollen på E18'),
        ('Alkoholrazzia vid Erikslund i kväll'),
        ('Promillekoll på Vasagatan'),
        ('Polis med droghund vid Bäckby'),
        ('Polis vid Erikslund'),
        ('Står en mobil trafikkamera vid första avfarten Hälla'),
        ('Polisen drog vidare från Skiljebo')
      ) as p(t)
  ) as k
 where a <> b or b <> c;

-- 4. Tomt, null och skräp ska ge false, inte fel.

select public.nykterhet_ar_kontroll(null)      as ska_bli_false_1,
       public.nykterhet_ar_kontroll('')        as ska_bli_false_2,
       public.nykterhet_ar_kontroll('   ')     as ska_bli_false_3,
       public.nykterhet_ar_kontroll('!!! ???') as ska_bli_false_4;

-- 5. CHECK-villkoret gäller fortfarande, och det är det som stoppar en
--    curl-insert med anon-nyckeln förbi klienten. Ska ge en rad, och
--    definitionen ska nämna chatt_ar_nykterhet.

select conname, pg_get_constraintdef(oid) as villkor
  from pg_constraint
 where conrelid = 'public.chatt_meddelanden'::regclass
   and conname = 'chatt_nykterhet';

--    Och på riktigt. Raden nedan SKA misslyckas med
--    "new row for relation ... violates check constraint chatt_nykterhet".
--    Går den igenom är spärren borta. Ingen städning behövs — inget skrevs.
--
--      insert into public.chatt_meddelanden (id, avsandare, text, visningsnamn)
--      values ('test-nykterhet-1', auth.uid(), 'Drogkollen vid Erikslund', 'Förare 1234');

-- 6. Har någon kört om supabase/telegram.sql eller supabase/fbmejl.sql och
--    därmed tyst skrivit tillbaka den gamla, smalare regexen?
--
--    Ska ge tre rader, alla med delegerar = true. Står det false någonstans
--    är just den vägen inte längre skyddad av det gemensamma nätet, och
--    kontroll 3 ovan börjar ge rader.

select p.proname,
       pg_get_functiondef(p.oid) like '%nykterhet_ar_kontroll%' as delegerar
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('chatt_ar_nykterhet', 'telegram_ar_nykterhetskontroll',
                     'fbmejl_ar_nykterhetskontroll')
 order by p.proname;

-- 7. Listorna mot js/parser.js. Görs för hand, en gång, och det är avsiktligt
--    att det inte går att automatisera härifrån — databasen kan inte läsa en
--    JavaScript-fil.
--
--    Öppna js/parser.js och jämför:
--      v_ord    mot SOBRIETY_WORDS    rad 43-68   ska vara identisk
--      v_stam   mot SOBRIETY_STAMMAR  rad 83-87   ska vara identisk
--      v_forled mot SOBRIETY_PREFIX   rad 102-106 ska innehålla alla
--      v_huvud  mot SOBRIETY_HEAD     rad 107     ska innehålla varje ord
--                                                 som prefix (koll täcker
--                                                 kollar, kontroll täcker
--                                                 kontroller)
--
--    Blir någon av de fyra listorna i js/parser.js bredare utan att den här
--    funktionen följer med, gäller inte längre beviset i filhuvudet: servern
--    kan då vägra mindre än klienten, och nätet under den riktiga spärren
--    slutar vara ett nät.
