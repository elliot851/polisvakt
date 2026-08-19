-- Polisvakt — månadsbelöningen
--
-- Körs i Supabase SQL Editor EFTER supabase/KOR-ALLT.sql. Filen går att köra
-- om hur många gånger som helst utan att förstöra data och utan att dela ut
-- en enda extra gratismånad.
--
-- =========================================================================
-- VAD DEN HÄR FILEN LÖSER
--
-- Appen lovar på tre ställen — index.html, js/app.js och js/reputation.js —
-- att "de 10 som rapporterar mest under en månad får nästa månad gratis".
-- Före den här filen fanns ingen mekanism som delade ut någonting. Vyn
-- monthly_winners räknar visserligen fram tio namn, men ingen kod läser den
-- och ingen prenumeration förlängs. Löftet var alltså tomt.
--
-- Här byggs det som gör löftet sant: en durabel liggare över riktiga
-- rapporter, en utdelningsfunktion som är omöjlig att köra dubbelt, en
-- revisionstabell som svarar på "jag vann men fick ingenting", och en
-- funktion appen kan anropa för att visa vinsten för den som fick den.
--
-- =========================================================================
-- VARFÖR EN EGEN LIGGARE OCH INTE monthly_winners
--
-- Det här är filens viktigaste beslut, och det är inte kosmetiskt.
--
-- monthly_winners räknar på tabellen public.reports. Den tabellen töms
-- löpande: purge_old_reports (schema.sql) raderar varje rapport vars
-- expires_at passerat med en vecka. En rapport från den 3:e finns alltså
-- inte kvar den 1:a i nästa månad, när vinnarna ska koras. Vyn ser bara
-- den sista dryga veckan av månaden och skulle utse fel vinnare varje gång
-- — och felet syns inte, eftersom listan ser fullt rimlig ut.
--
-- report_history hjälper inte: den sparar med flit ALDRIG vem som
-- rapporterade. Det är ett riktigt integritetsbeslut som inte ska rivas upp
-- för en topplistas skull.
--
-- Lösningen är tabellen manads_bidrag nedan: en rad per rapport, skriven av
-- en trigger i samma ögonblick rapporten föds, utan koppling till reports
-- (ingen främmande nyckel). Den överlever gallringen. Den innehåller inte
-- position, inte etikett, inte anteckning — bara vem, vilken månad, vilken
-- källa, vilken grupp och hur rapporten röstades. Alltså mindre känslig än
-- reports, och tillräcklig för att räkna fram en vinnare.
--
-- Klientens poäng (js/reputation.js, tabellen reporter_scores) används inte
-- alls till utdelningen. Den ligger i localStorage och skickas upp av
-- klienten — den går att ljuga om. Den får fortsätta driva topplistan i
-- appen; pengar delas ut på databasens egna siffror.
--
-- =========================================================================
-- BESLUT SOM RÖR PENGAR (läs innan du ändrar något)
--
-- 1. VINNARE UTAN PRENUMERATION FÅR ÄNDÅ SIN MÅNAD.
--    Löftet i appen är villkorslöst. Det står inte "om du redan betalar".
--    Den som rapporterat mest av alla och råkar gå på provperiod eller ha en
--    utgången prenumeration är precis den person tjänsten inte har råd att
--    tappa — hen matar kartan som alla andra betalar för. Att neka skulle
--    inte heller spara några pengar, eftersom personen inte betalade något
--    att börja med. Saknas raden i subscribers skapas den, med paid_until en
--    månad fram från nu.
--
-- 2. DEN SOM REDAN BETALAT FÅR MÅNADEN PÅLAGD I SLUTET, INTE ÖVERSKRIVEN.
--    paid_until flyttas till greatest(paid_until, now()) + 1 månad. Alltså
--    aldrig bakåt, och aldrig "hoppa över, hen är ju redan täckt". Det
--    senare hade betytt att den lojala betalande kunden blev utan medan den
--    som inte betalar fick sin månad — exakt bakvänt mot vad belöningen
--    finns till för. Belöningen är alltid värd en hel månad för alla tio.
--
-- 3. BELÖNINGEN ÄR INTE EN BETALNING.
--    Filen rör med flit varken plan, sub_status eller last_payment_at (de
--    kolumner billing.sql lägger till). En gratismånad ska inte dyka upp i
--    revenue_by_month som intäkt och inte se ut som ett kortköp i en tvist.
--    Enda kolumnerna som ändras i subscribers är paid_until och updated_at.
--
-- 4. GRUPPRAPPORTER RÄKNAS INTE.
--    En rapport i en privat grupp syns bara för gruppen. Belöningen betalas
--    för rapporter som hjälper alla. Dessutom stänger det en uppenbar lucka:
--    fyra kollegor i samma åkerigrupp kan annars bekräfta varandras
--    rapporter i en sluten cirkel som ingen utomstående kan rösta ner.
--    Raden sparas ändå i liggaren, med grupp-id, så beslutet går att riva
--    upp utan att data gått förlorad.
--
-- 5. EGNA VERIFIERINGAR GER INGA POÄNG HÄR.
--    js/reputation.js ger +1 för att bekräfta någon annans rapport. Den
--    delen är den enda i poängmodellen som är gratis att spamma — ett klick
--    per poäng. Serverns uträkning följer i stället monthly_winners:
--    rapporter + bekräftelser × 3 − nedröstningar × 4. Följden är att talet
--    appen visar kan vara högre än det tal som avgör vinsten. Det är värt
--    att jämna ut i klienten, men det ska inte lösas genom att göra
--    utdelningen spambar.
--
-- =========================================================================
-- OM IDEMPOTENS
--
-- Två lager, med flit, och det undre lagret är det som verkligen håller:
--
--   Undre  Primärnyckeln (manad, agare) på manads_belaning. En andra
--          utdelning för samma månad kolliderar och gör ingenting. Först när
--          raden faktiskt skrevs rörs paid_until — det sker i samma
--          transaktion, så antingen finns både revisionsraden och månaden,
--          eller ingendera.
--   Övre   Tabellen manads_utdelning med manad som primärnyckel plus ett
--          rådgivande lås. Den gör att en andra körning avbryter direkt i
--          stället för att räkna om hela månaden i onödan, och att två
--          samtidiga körningar inte kan trampa på varandra.
--
-- Tas den övre raden bort för hand händer fortfarande ingen dubbelutdelning.
-- Det är avsiktligt: den övre spärren får gärna gå att lyfta vid en
-- felsökning, den undre får aldrig göra det.
-- =========================================================================


/* ===================== KRAV PÅ DATABASEN FÖRST ====================== */
-- Bättre att stanna här med ett begripligt fel än att skapa halva systemet
-- ovanpå ett schema som saknar det den bygger på.

do $krav$
begin
  if to_regclass('public.reports') is null then
    raise exception 'Kör supabase/KOR-ALLT.sql först — tabellen reports saknas.';
  end if;
  if to_regclass('public.subscribers') is null then
    raise exception 'Kör supabase/KOR-ALLT.sql först — tabellen subscribers saknas.';
  end if;
  if to_regprocedure('public.actor(text)') is null then
    raise exception 'Kör supabase/KOR-ALLT.sql först — funktionen actor(text) saknas.';
  end if;
end $krav$;


/* ======================= LIGGAREN ÖVER BIDRAG ======================= */

create table if not exists public.manads_bidrag (
  /**
   * Rapportens id, men INGEN främmande nyckel till reports.
   *
   * Det är hela poängen med tabellen. Med "references reports(id) on delete
   * cascade" hade purge_old_reports raderat liggaren i samma svep som
   * rapporterna, och vi hade stått med samma problem som monthly_winners.
   * Nyckeln finns kvar som text så att en enskild rad går att spåra tillbaka
   * så länge rapporten lever.
   */
  report_id     text primary key,

  /**
   * Ägaren i samma form som resten av schemat: för inloggade är det
   * auth.uid() som text (js/store.js deviceId() returnerar konto-id när man
   * är inloggad), för gäster det slumpade enhets-id:t. Samma värde som
   * subscribers.device_id — det är det som gör utdelningen möjlig.
   */
  agare         text not null,

  /**
   * Månaden som 'ÅÅÅÅ-MM', räknad i Europe/Stockholm.
   *
   * Två saker att veta:
   *
   *   Tidszonen. Servern går i UTC. En rapport klockan 00:30 svensk tid den
   *   1:a augusti är fortfarande den 31 juli i UTC, och hade hamnat i fel
   *   månad. Användaren räknar i svensk tid (js/reputation.js monthKey()
   *   använder webbläsarens lokala tid), och belöningen ska räknas i samma
   *   månad som appen visar.
   *
   *   now() och inte created_at. reports.created_at kommer från klienten och
   *   kontrolleras inte mot verkligheten av någon insert-policy — den som
   *   vill kan datera en rapport till förra månaden och göra sig till vinnare
   *   i en månad som redan är avgjord. Serverns klocka går inte att ljuga om.
   *   Priset är att en rapport som köats offline över ett månadsskifte
   *   räknas till månaden den kom fram. Det är rätt sida att fela åt.
   */
  manad         text not null,

  /**
   * Gruppen rapporten lades i, null = publik. Sparas även om grupprapporter
   * inte ger belöning (beslut 4 överst), så att beslutet går att ändra i
   * efterhand utan att historiken är förlorad.
   */
  grupp         uuid,

  -- 'app', 'voice', 'facebook' eller 'import'. Bara de två första räknas.
  kalla         text not null default 'app',

  -- Andras bekräftelser (reports.confirms minus rapportörens egen) och
  -- nedröstningar, som de såg ut senast rapporten rördes. Uppdateras av
  -- triggern nedan så länge rapporten lever, och fryser vid gallringen.
  bekraftelser  int not null default 0,
  nedrostningar int not null default 0,

  -- Rapporter som tagits bort av rapportören själv räknas inte.
  borttagen     boolean not null default false,

  skapad        timestamptz not null default now(),
  uppdaterad    timestamptz not null default now()
);

-- Frågan som ställs varje månadsskifte: alla bidrag för en månad, grupperade
-- per ägare. Ett sammansatt index räcker för hela uträkningen.
create index if not exists manads_bidrag_manad_idx
  on public.manads_bidrag (manad, agare);

alter table public.manads_bidrag enable row level security;

-- Inga policyer. Tabellen nås bara av triggrarna och av de security
-- definer-funktioner som körs som ägaren. Med radsäkerhet på och noll
-- policyer kommer varken anon eller authenticated åt en enda rad.
--
-- Bälte och hängslen: Supabase delar ut SELECT till anon och authenticated på
-- nya tabeller i public automatiskt. Utan raden nedan hade tabellen — som
-- innehåller device_id, alltså konto-id för inloggade — legat öppen.
revoke all on public.manads_bidrag from anon, authenticated;


/* ======================= REVISIONSTABELLERNA ======================== */

/**
 * En rad per utdelad belöning. Det här är svaret på "jag vann men fick
 * ingenting", och den frågan kommer att ställas.
 *
 * Primärnyckeln (manad, agare) är hela idempotensen. Den gör en andra
 * gratismånad för samma person och samma månad fysiskt omöjlig, oavsett hur
 * många gånger någon kör funktionen, oavsett om cronjobbet dubblerats,
 * oavsett om raden i manads_utdelning råkat försvinna.
 */
create table if not exists public.manads_belaning (
  manad              text not null,                 -- månaden som vanns, 'ÅÅÅÅ-MM'
  agare              text not null,                 -- samma id som subscribers.device_id
  placering          int  not null,                 -- 1–10
  rapporter          int  not null,
  bekraftelser       int  not null,
  nedrostningar      int  not null,
  poang              int  not null,
  smeknamn           text,                          -- som det såg ut när belöningen delades ut
  manader            int  not null default 1,       -- hur många månader som gavs
  hade_prenumeration boolean not null default false,-- betalande vid utdelningen?
  paid_until_innan   timestamptz,                   -- före
  paid_until_efter   timestamptz,                   -- efter
  skapad             timestamptz not null default now(),
  kvitterad_at       timestamptz,                   -- när användaren såg beskedet i appen
  primary key (manad, agare)
);

-- "Vad har den här personen fått genom åren?" — supportfrågan.
create index if not exists manads_belaning_agare_idx
  on public.manads_belaning (agare, manad desc);

alter table public.manads_belaning enable row level security;
revoke all on public.manads_belaning from anon, authenticated;

/**
 * En rad per körd månad. Övre spärren och körjournalen i ett.
 *
 * Raden skrivs FÖRST i utdelningen, innan en enda krona rörs. Kolliderar
 * insert:en är månaden redan utdelad och funktionen avbryter direkt.
 */
create table if not exists public.manads_utdelning (
  manad         text primary key,
  kord_at       timestamptz not null default now(),
  kord_av       text not null default current_user,
  antal_vinnare int not null default 0,
  antal_manader int not null default 1,
  noteringar    text
);

alter table public.manads_utdelning enable row level security;
revoke all on public.manads_utdelning from anon, authenticated;


/* ================== TRIGGRAR SOM FYLLER LIGGAREN =================== */

/**
 * Ny rapport → ny rad i liggaren.
 *
 * Om felfångsten: en trasig belöningsliggare får ALDRIG kunna stoppa en
 * polisrapport. Går insert:en fel av något skäl loggas en varning och
 * rapporten går igenom ändå. Priset är att en enstaka rad kan saknas i
 * topplistan; alternativet är att appen slutar fungera för att en tabell för
 * en tävling krånglar. Det är inte en avvägning.
 *
 * Om to_jsonb(new): kolumnen group_id läggs till på reports först i
 * grupper.sql. Läses den som new.group_id dör funktionen på en databas där
 * bara schema.sql körts. Genom jsonb blir ett saknat fält bara null, och
 * filen fungerar oavsett hur långt schemat körts.
 */
create or replace function public.notera_bidrag()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $notera$
begin
  begin
    insert into public.manads_bidrag (
      report_id, agare, manad, grupp, kalla,
      bekraftelser, nedrostningar, borttagen)
    values (
      new.id,
      new.device_id,
      to_char(timezone('Europe/Stockholm', now()), 'YYYY-MM'),
      (to_jsonb(new) ->> 'group_id')::uuid,
      coalesce(new.source, 'app'),
      greatest(0, coalesce(new.confirms, 1) - 1),
      greatest(0, coalesce(new.denials, 0)),
      coalesce(new.removed, false))
    on conflict (report_id) do nothing;
  exception when others then
    raise warning 'manads_bidrag: kunde inte notera rapport % (%)', new.id, sqlerrm;
  end;
  return new;
end $notera$;

/**
 * Rösterna ändras efter att rapporten skapats. confirm_report, deny_report
 * och remove_report skriver alla till reports, och liggaren följer med.
 *
 * Utan den här triggern hade varje rapport räknats som "noll bekräftelser,
 * noll nedröstningar" — alltså exakt det poängmodellen finns till för att
 * skilja på: den som rapporterar rätt saker mot den som rapporterar många.
 */
create or replace function public.uppdatera_bidrag()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $uppdatera$
begin
  begin
    update public.manads_bidrag
       set bekraftelser  = greatest(0, coalesce(new.confirms, 1) - 1),
           nedrostningar = greatest(0, coalesce(new.denials, 0)),
           borttagen     = coalesce(new.removed, false),
           uppdaterad    = now()
     where report_id = new.id;
  exception when others then
    raise warning 'manads_bidrag: kunde inte uppdatera rapport % (%)', new.id, sqlerrm;
  end;
  return new;
end $uppdatera$;

-- Egna triggrar, inte en ändring av archive_report i schema.sql. Den filen
-- redigeras av andra, och en utökning där hade skrivits över nästa gång
-- KOR-ALLT.sql körs.
drop trigger if exists reports_notera_bidrag on public.reports;
create trigger reports_notera_bidrag
  after insert on public.reports
  for each row execute function public.notera_bidrag();

-- WHEN-villkoret gör att triggern inte väcks av skrivningar som inte har med
-- poängen att göra (till exempel expires_at, som confirm_report flyttar fram
-- vid varje bekräftelse).
drop trigger if exists reports_uppdatera_bidrag on public.reports;
create trigger reports_uppdatera_bidrag
  after update on public.reports
  for each row
  when (old.confirms is distinct from new.confirms
     or old.denials  is distinct from new.denials
     or old.removed  is distinct from new.removed)
  execute function public.uppdatera_bidrag();

-- Ingen revoke på de två triggerfunktionerna, och det är med flit — samma
-- slutsats som stripe.sql drar om guard_paid_until. Postgres vägrar köra en
-- triggerfunktion som ett vanligt funktionsanrop ("trigger functions can only
-- be called as triggers"), så EXECUTE på dem ger ingen angreppsyta alls.
-- Däremot KRÄVS EXECUTE när triggern skapas, så en revoke här kan i värsta
-- fall bara ställa till det nästa gång filen körs. Låt dem vara.


/* ============ ENGÅNGSPÅFYLLNING AV REDAN BEFINTLIGA RADER =========== */
/*
 * Rapporter som redan ligger i databasen när filen körs första gången får en
 * rad i liggaren, så att den innevarande månaden inte börjar på noll.
 *
 * Månaden räknas här ur inserted_at (serverns tidsstämpel), inte created_at,
 * av samma skäl som i triggern. on conflict do nothing gör satsen ofarlig att
 * köra om — inga dubbletter, inga överskrivna rösträkningar.
 *
 * VIKTIGT ATT VETA: allt som redan gallrats bort av purge_old_reports är
 * borta för gott och kan inte fyllas på. Den FÖRSTA månaden efter
 * installationen är därför ofullständig — den innehåller bara rapporter från
 * den dryga vecka som fanns kvar. Vill man vara helt rättvis: kör den första
 * utdelningen för hand och läs ställningen först. Från och med nästa hela
 * månad är siffran komplett.
 */
insert into public.manads_bidrag (
  report_id, agare, manad, grupp, kalla,
  bekraftelser, nedrostningar, borttagen, skapad, uppdaterad)
select
  r.id,
  r.device_id,
  to_char(timezone('Europe/Stockholm', r.inserted_at), 'YYYY-MM'),
  (to_jsonb(r) ->> 'group_id')::uuid,
  coalesce(r.source, 'app'),
  greatest(0, coalesce(r.confirms, 1) - 1),
  greatest(0, coalesce(r.denials, 0)),
  coalesce(r.removed, false),
  r.inserted_at,
  now()
from public.reports r
on conflict (report_id) do nothing;


/* ==================== STÄLLNINGEN FÖR EN MÅNAD ====================== */

/**
 * Vem leder, och med vad? En enda uträkning som både utdelningen och
 * administratören läser, så att listan man tittar på i SQL-editorn är exakt
 * den lista som betalas ut. Två uträkningar hade förr eller senare glidit
 * isär, och glappet hade upptäckts av en kund.
 *
 * Poängen är samma formel som monthly_winners i KOR-ALLT.sql:
 *   rapporter + bekräftelser × 3 − nedröstningar × 4
 *
 * Sorteringen är poäng, sedan antal rapporter, sedan ägar-id. Det sista
 * ledet ser onödigt ut men gör ordningen deterministisk: utan det kan två
 * körningar med samma data ge olika tia, och en topplista som byter vinnare
 * mellan två blickar går inte att försvara.
 *
 * Noll eller minuspoäng ger ingen plats. Den som blivit nedröstad till minus
 * har inte hjälpt någon och ska inte få en månad betald för det.
 */
create or replace function public.manadens_stallning(
  p_manad text default null,
  p_topp  int  default 10)
returns table (
  placering     int,
  agare         text,
  smeknamn      text,
  rapporter     int,
  bekraftelser  int,
  nedrostningar int,
  poang         int)
language sql stable security definer set search_path = public, pg_temp as $stallning$
  with param as (
    select coalesce(nullif(p_manad, ''),
                    to_char(timezone('Europe/Stockholm', now()), 'YYYY-MM')) as manad
  ),
  grund as (
    select
      b.agare                                                                   as agare,
      count(*)::int                                                             as rapporter,
      sum(b.bekraftelser)::int                                                  as bekraftelser,
      sum(b.nedrostningar)::int                                                 as nedrostningar,
      (count(*) + sum(b.bekraftelser) * 3 - sum(b.nedrostningar) * 4)::int      as poang
    from public.manads_bidrag b
    cross join param p
    where b.manad = p.manad
      and b.borttagen = false
      and b.grupp is null
      and b.kalla in ('app', 'voice')
    group by b.agare
    having (count(*) + sum(b.bekraftelser) * 3 - sum(b.nedrostningar) * 4) > 0
  ),
  rankad as (
    select
      (row_number() over (order by g.poang desc, g.rapporter desc, g.agare asc))::int as placering,
      g.agare, g.rapporter, g.bekraftelser, g.nedrostningar, g.poang
    from grund g
  )
  select
    rk.placering,
    rk.agare,
    (select nullif(s.nickname, '')
       from public.reporter_scores s
       cross join param p2
      where s.device_id = rk.agare and s.month = p2.manad),
    rk.rapporter,
    rk.bekraftelser,
    rk.nedrostningar,
    rk.poang
  from rankad rk
  where rk.placering <= greatest(1, coalesce(p_topp, 10))
  order by rk.placering;
$stallning$;

-- Administrationsverktyg, precis som monthly_winners. Kolumnen agare finns
-- kvar med flit — den behövs för att kunna se vem som ska ha vad — och det
-- är just därför funktionen inte får nås från appen. Rättigheterna sätts
-- samlat längre ner, under RÄTTIGHETER.


/* ========================== UTDELNINGEN ============================= */

/**
 * Dela ut månadens belöning. Körs en gång per månad, för månaden som just
 * tog slut.
 *
 * Returnerar en rad per NY vinnare. Noll rader betyder antingen "redan
 * utdelat" eller "ingen kvalificerade sig" — vilket det var står i
 * manads_utdelning och i det NOTICE som skrivs ut.
 *
 * Parametrar:
 *   p_manad    'ÅÅÅÅ-MM'. Utelämnad = månaden före den innevarande, räknad
 *              i svensk tid. Det är det cronjobbet skickar.
 *   p_topp     Hur många som får belöningen. 10, enligt löftet i appen.
 *   p_manader  Hur många månader var. 1, enligt löftet i appen.
 *   p_tvinga   Släpper igenom en utdelning för en månad som inte är slut.
 *              Finns bara för test på en tom databas.
 */
create or replace function public.dela_ut_manadsbelaning(
  p_manad   text    default null,
  p_topp    int     default 10,
  p_manader int     default 1,
  p_tvinga  boolean default false)
returns table (
  manad       text,
  placering   int,
  agare       text,
  smeknamn    text,
  rapporter   int,
  poang       int,
  gratis_till timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $utdelning$
#variable_conflict use_column
/**
 * Direktivet ovan är inte pynt — utan det går funktionen sönder första
 * gången den körs. Det står allra först i kroppen för att det MÅSTE göra det;
 * plpgsql läser #-direktiv före allt annat.
 *
 * Kolumnerna i RETURNS TABLE (manad, agare, placering, …) blir variabler i
 * plpgsql. Satsen "on conflict (manad, agare) do nothing" innehåller då två
 * namn som är både kolumn och variabel, och plpgsql avbryter som standard med
 * "column reference is ambiguous". Felet kommer vid körning, inte när
 * funktionen skapas — filen hade alltså gått igenom utan ett ord, och det
 * enda som märkts är att den första riktiga utdelningen kastade.
 *
 * use_column säger: vid krock vinner kolumnen. Alla riktiga variabler i
 * funktionen heter v_ eller p_ och krockar inte med någon kolumn, så
 * direktivet påverkar bara de tvetydiga namnen — vilket är precis de ställen
 * där kolumnen är det som avses.
 */
declare
  v_manad    text;
  v_nu       text;
  v_rad      record;
  v_innan    timestamptz;
  v_efter    timestamptz;
  v_antal    int  := 0;
  v_nya      text[] := array[]::text[];
begin
  /* ---- Rimlighetskontroller. Ett fel här är billigare än ett fel efter. ---- */

  if coalesce(p_manader, 0) <= 0 or p_manader > 3 then
    raise exception 'orimligt antal månader: %', p_manader
      using hint = 'Löftet i appen är en (1) månad.';
  end if;
  if coalesce(p_topp, 0) <= 0 or p_topp > 100 then
    raise exception 'orimlig topplistelängd: %', p_topp
      using hint = 'Löftet i appen är tio (10) vinnare.';
  end if;

  v_nu := to_char(timezone('Europe/Stockholm', now()), 'YYYY-MM');
  v_manad := coalesce(
    nullif(p_manad, ''),
    to_char(timezone('Europe/Stockholm', now()) - interval '1 month', 'YYYY-MM'));

  if v_manad !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'månaden ska skrivas som ÅÅÅÅ-MM, inte %', v_manad;
  end if;

  -- En månad som inte är slut har ingen vinnare. Att dela ut mitt i månaden
  -- vore att låsa tian medan tävlingen pågår.
  if v_manad >= v_nu and not p_tvinga then
    raise exception 'månaden % är inte slut än (nu är %)', v_manad, v_nu
      using hint = 'Kör utan argument den 1:a, eller ange en tidigare månad.';
  end if;

  /* ---- Övre spärren: ett lås och en körjournal ---- */

  /**
   * Rådgivande lås på transaktionen. Två cronjobb, eller ett cronjobb och en
   * otålig administratör i SQL-editorn, kan annars läsa "inte utdelad än"
   * samtidigt och båda gå vidare. Låset släpps av sig självt när
   * transaktionen tar slut, oavsett hur den tar slut.
   */
  perform pg_advisory_xact_lock(4711001::bigint);

  insert into public.manads_utdelning (manad, antal_manader)
  values (v_manad, p_manader)
  on conflict (manad) do nothing;

  if not found then
    raise notice 'Månadsbelöningen för % är redan utdelad. Inget gjordes. Kolla: select * from public.manads_belaning where manad = ''%'';', v_manad, v_manad;
    return;
  end if;

  /* ---- Själva utdelningen ---- */

  for v_rad in
    select * from public.manadens_stallning(v_manad, p_topp)
  loop
    -- Läs betalstatus före, för revisionen. En kund som ifrågasätter sin
    -- gratismånad ska kunna få se båda datumen.
    select s.paid_until into v_innan
      from public.subscribers s
     where s.device_id = v_rad.agare;

    /**
     * UNDRE SPÄRREN, och den enda som verkligen räknas.
     *
     * Revisionsraden skrivs FÖRE prenumerationen förlängs. Kolliderar den
     * har personen redan fått sin månad, och då hoppas hen över helt —
     * paid_until rörs inte. Ordningen är inte utbytbar: skrevs raden efteråt
     * hade ett avbrott mitt emellan gett en förlängd prenumeration utan spår
     * i revisionen, alltså exakt den situation tabellen finns till för att
     * göra omöjlig.
     *
     * Allt nedan ligger i samma transaktion som funktionen. Går något fel
     * efter den här raden rullas både revisionen och förlängningen tillbaka.
     */
    insert into public.manads_belaning (
      manad, agare, placering, rapporter, bekraftelser, nedrostningar, poang,
      smeknamn, manader, hade_prenumeration, paid_until_innan)
    values (
      v_manad, v_rad.agare, v_rad.placering, v_rad.rapporter, v_rad.bekraftelser,
      v_rad.nedrostningar, v_rad.poang, v_rad.smeknamn, p_manader,
      (v_innan is not null and v_innan > now()), v_innan)
    on conflict (manad, agare) do nothing;

    if not found then
      raise notice 'Hoppar över % för % — belöningen är redan registrerad.', v_rad.agare, v_manad;
      continue;
    end if;

    /**
     * Förlängningen. Samma additiva form som add_paid_months i billing.sql:
     * greatest(paid_until, now()) + en månad. Alltså aldrig bakåt för den som
     * redan har tid kvar, och ett nytt datum en månad fram för den som inte
     * har någon prenumeration alls (beslut 1 och 2 överst i filen).
     *
     * Två spärrar i andra filer passeras här, och båda med avsikt:
     *   - subscribers har ingen UPDATE-policy och en INSERT-policy som kräver
     *     paid_until is null. Funktionen är security definer och körs som
     *     ägaren, som inte omfattas av radsäkerheten.
     *   - guard_paid_until (stripe.sql) stoppar skrivningar från rollerna
     *     anon, authenticated och authenticator. current_user är ägaren här,
     *     inte anroparen, så triggern släpper igenom. Taket på 800 dagar per
     *     skrivning ligger långt över en månad.
     * Just därför måste EXECUTE på den här funktionen vara indraget från
     * klientrollerna. Se rättigheterna längst ner.
     */
    insert into public.subscribers (device_id, paid_until)
    values (v_rad.agare, greatest(coalesce(v_innan, now()), now())
                         + make_interval(months => p_manader))
    on conflict (device_id) do update
      set paid_until = greatest(coalesce(subscribers.paid_until, now()), now())
                       + make_interval(months => p_manader),
          updated_at = now()
    returning paid_until into v_efter;

    update public.manads_belaning b
       set paid_until_efter = v_efter
     where b.manad = v_manad and b.agare = v_rad.agare;

    v_antal := v_antal + 1;
    v_nya   := v_nya || v_rad.agare;
  end loop;

  update public.manads_utdelning u
     set antal_vinnare = v_antal,
         noteringar = case
           when v_antal = 0
             then 'Ingen kvalificerade sig. Tom liggare för månaden, eller alla på minuspoäng.'
           else null end
   where u.manad = v_manad;

  if v_antal = 0 then
    raise notice 'Ingen kvalificerade sig för %. Raden i manads_utdelning står kvar som kvitto på att körningen skedde. Var det fel: delete from public.manads_utdelning where manad = ''%''; och kör om — primärnyckeln på manads_belaning hindrar ändå dubbelutdelning.', v_manad, v_manad;
  else
    raise notice 'Månadsbelöningen för %: % vinnare fick % månad(er) var.', v_manad, v_antal, p_manader;
  end if;

  return query
    select b.manad, b.placering, b.agare, b.smeknamn, b.rapporter, b.poang, b.paid_until_efter
    from public.manads_belaning b
    where b.manad = v_manad and b.agare = any(v_nya)
    order by b.placering;
end $utdelning$;


/* =================== VAD DEN INLOGGADE VANN ========================= */

/**
 * Appens fråga: "vann jag förra månaden?"
 *
 * Identiteten tas ur public.actor(): JWT:n för inloggade, det skickade
 * enhets-id:t för gäster. Samma modell som get_subscription i KOR-ALLT.sql,
 * och av samma skäl — gäster har ingen inloggning men kan mycket väl vara
 * bland de tio, och en vinst som vinnaren aldrig får se är ingen belöning.
 *
 * Funktionen lämnar bara ut den egna raden och bara ofarliga fält: månad,
 * placering, poäng och till vilket datum prenumerationen räcker. Aldrig
 * e-post, aldrig andras id, aldrig hela vinnarlistan. Att gissa någon annans
 * enhets-id ger alltså ingenting av värde.
 *
 * Tolv månader tillbaka: appen visar den senaste, resten blir en liten
 * historik för den som vunnit flera gånger.
 */
create or replace function public.min_belaning(p_device text default null)
returns table (
  manad       text,
  placering   int,
  rapporter   int,
  poang       int,
  manader     int,
  gratis_till timestamptz,
  vunnen_at   timestamptz,
  kvitterad   boolean)
language sql stable security definer set search_path = public, pg_temp as $min$
  select b.manad, b.placering, b.rapporter, b.poang, b.manader,
         b.paid_until_efter, b.skapad, (b.kvitterad_at is not null)
  from public.manads_belaning b
  where b.agare = public.actor(p_device)
  order by b.manad desc
  limit 12;
$min$;

/**
 * Kvittera beskedet, så att "du vann i juli" inte ligger kvar och blinkar i
 * appen i evighet. Skriver bara på den egna raden — actor() avgör vems.
 * Returnerar true om något faktiskt kvitterades.
 */
create or replace function public.kvittera_belaning(
  p_manad text, p_device text default null)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $kvittera$
declare v_antal int;
begin
  update public.manads_belaning b
     set kvitterad_at = now()
   where b.agare = public.actor(p_device)
     and b.manad = p_manad
     and b.kvitterad_at is null;
  get diagnostics v_antal = row_count;
  return v_antal > 0;
end $kvittera$;


/* ======================== VYER FÖR ADMIN ============================ */
-- Körs i SQL-editorn, aldrig från appen. security_invoker = on gör att
-- radsäkerheten på tabellerna under fortsätter gälla genom vyn — utan den
-- hade vyn (som ägs av postgres) läst förbi den tomma radsäkerheten och
-- blivit en öppen dörr rakt in i utdelningshistoriken.

/** Har varje månad delats ut, och till hur många? */
create or replace view public.belaning_historik
with (security_invoker = on) as
  select u.manad,
         u.kord_at,
         u.kord_av,
         u.antal_vinnare,
         u.antal_manader,
         u.noteringar,
         (select count(*) from public.manads_belaning b where b.manad = u.manad) as rader_i_revisionen
  from public.manads_utdelning u
  order by u.manad desc;

/** Hur mycket bidrag samlas in just nu? Ska växa varje dag. */
create or replace view public.belaning_halsa
with (security_invoker = on) as
  select b.manad,
         count(*)                                        as bidrag,
         count(distinct b.agare)                         as rapportorer,
         count(*) filter (where b.grupp is not null)     as i_grupp,
         count(*) filter (where b.borttagen)             as borttagna,
         min(b.skapad)                                   as forsta,
         max(b.skapad)                                   as senaste
  from public.manads_bidrag b
  group by b.manad
  order by b.manad desc;

revoke all on public.belaning_historik from anon, authenticated;
revoke all on public.belaning_halsa    from anon, authenticated;


/* ======================= RÄTTIGHETER (VIKTIGT) ====================== */
/*
 * Postgres ger EXECUTE till PUBLIC på varje ny funktion. Utan raderna nedan
 * kan vem som helst med anon-nyckeln — som ligger öppet i js/config.js —
 * anropa dela_ut_manadsbelaning och skriva paid_until åt vem den vill.
 * Funktionen är security definer och passerar därför både radsäkerheten på
 * subscribers och guard_paid_until i stripe.sql. Den ENDA sak som hindrar en
 * klient från att ge sig själv gratis prenumeration är raden nedan.
 *
 * Lägger du till en funktion i den här filen: lägg till den här också.
 */

revoke execute on function public.dela_ut_manadsbelaning(text, int, int, boolean)
  from public, anon, authenticated;
revoke execute on function public.manadens_stallning(text, int)
  from public, anon, authenticated;

-- Utdelningen körs av pg_cron (som postgres, alltså ägaren) eller för hand i
-- SQL-editorn. service_role finns med så att ett skript eller en
-- edge-funktion ska kunna köra den om cron saknas. Aldrig anon eller
-- authenticated.
grant execute on function public.dela_ut_manadsbelaning(text, int, int, boolean) to service_role;
grant execute on function public.manadens_stallning(text, int)                   to service_role;

-- De två klientfunktionerna. De lämnar bara ut den egna raden, och
-- identiteten kommer från actor() — inte från det klienten påstår, när
-- klienten är inloggad.
revoke execute on function public.min_belaning(text)             from public;
revoke execute on function public.kvittera_belaning(text, text)  from public;
grant  execute on function public.min_belaning(text)             to anon, authenticated;
grant  execute on function public.kvittera_belaning(text, text)  to anon, authenticated;


/* ========================= SCHEMALÄGGNING =========================== */
/*
 * Utdelningen ska ske en gång i månaden, tidigt den första, för månaden som
 * just tog slut. Blocket nedan schemalägger det med pg_cron om tillägget
 * finns, och säger tydligt ifrån om det inte gör det.
 *
 * OM pg_cron SAKNAS händer ingenting alls automatiskt: funktionerna finns,
 * liggaren fylls på, men INGEN VINNARE FÅR SIN MÅNAD. Det syns inte på något
 * annat sätt än att ingen hör av sig — förrän någon gör det. Därför NOTICE.
 *
 * Tidsuttrycket står ordagrant inne i cron.schedule-anropet nedan. Det
 * skrivs INTE här i klartext, och det är inget hyfs: ett cron-uttryck för
 * återkommande tider innehåller en stjärna följd av snedstreck, och det är
 * exakt tecknen som avslutar en blockkommentar. Står uttrycket i en sådan
 * kommentar tar kommentaren slut mitt i raden, resten tolkas som SQL och
 * filen dör på "syntax error at or near 5". Det har hänt i det här repot.
 *
 * Tiden i cron är serverns, alltså UTC. Den 1:a på natten är det samma dygn
 * i Sverige oavsett sommartid, så månadsgränsen stämmer.
 */

do $cron$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — INGEN MÅNADSBELÖNING DELAS UT AUTOMATISKT. Kör "select * from public.dela_ut_manadsbelaning();" för hand den 1:a i varje månad, eller schemalägg det i Dashboard -> Database -> Cron Jobs. Se docs/manadsbelaning.md.';
    return;
  end if;

  -- Idempotent: ta bort ett eventuellt tidigare jobb med samma namn först.
  -- cron.unschedule kastar om jobbet inte finns, därav kollen.
  perform 1 from cron.job where jobname = 'polisvakt-manadsbelaning';
  if found then perform cron.unschedule('polisvakt-manadsbelaning'); end if;

  -- Minut 15, timme 3, den 1:a i månaden, varje månad, alla veckodagar.
  perform cron.schedule('polisvakt-manadsbelaning', '15 3 1 * *',
                        'select * from public.dela_ut_manadsbelaning();');
  raise notice 'Månadsbelöningen schemalagd via pg_cron: den 1:a varje månad kl 03:15 UTC, för månaden som tog slut.';
exception when others then
  raise notice 'Kunde inte schemalägga månadsbelöningen (%). Kör "select * from public.dela_ut_manadsbelaning();" för hand den 1:a i varje månad.', sqlerrm;
end $cron$;


/* ============================ KONTROLL ==============================

   Kör de här efteråt för att se att det blev rätt.

   1. Att liggaren fylls på. Lägg en rapport i appen och kör:

        select * from public.belaning_halsa;
        -- Raden för innevarande månad ska öka med ett per rapport.

   2. Att ingen klientroll kommer åt utdelningen. Ska ge NOLL rader med
      anon eller authenticated:

        select p.proname, r.rolname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          cross join lateral aclexplode(p.proacl) a
          join pg_roles r on r.oid = a.grantee
         where n.nspname = 'public'
           and p.proname in ('dela_ut_manadsbelaning','manadens_stallning')
           and r.rolname in ('anon','authenticated');

   3. Att tabellerna är stängda. Ska ge noll rader:

        select table_name, grantee, privilege_type
          from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name in ('manads_bidrag','manads_belaning','manads_utdelning')
           and grantee in ('anon','authenticated');

   4. Ställningen just nu, utan att dela ut något:

        select * from public.manadens_stallning();

   5. Att dubbelkörning inte ger dubbel månad. Kör på en TESTMÅNAD:

        select * from public.dela_ut_manadsbelaning('2000-01');   -- första
        select * from public.dela_ut_manadsbelaning('2000-01');   -- ska ge 0 rader
        select manad, agare, paid_until_innan, paid_until_efter
          from public.manads_belaning where manad = '2000-01';
        -- Städa efteråt:
        -- delete from public.manads_belaning  where manad = '2000-01';
        -- delete from public.manads_utdelning where manad = '2000-01';
        -- (paid_until backas INTE av raderingen — gör testet på en tom databas,
        --  eller acceptera att testpersonerna fick en riktig månad.)

   6. Revisionen. Frågan man ställer när en kund hör av sig:

        select * from public.manads_belaning where agare = '<device_id>' order by manad desc;
        select * from public.belaning_historik;

   7. Klientfunktionen, som den inloggade ser den:

        select * from public.min_belaning('<device_id>');

   8. Schemat — ska ge en rad om pg_cron finns, noll annars (och då gäller
      Dashboard -> Database -> Cron Jobs):

        select jobname, schedule, active from cron.job
         where jobname like 'polisvakt-manadsbelaning';

   ==================================================================== */
