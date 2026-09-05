-- =====================================================================
-- MEJLBRYGGAN — Facebooks egna notismejl, serversidan
-- =====================================================================
--
-- Kör hela filen i Supabase SQL Editor. Den är idempotent; ingenting här
-- raderar rapporter.
--
-- !! VARNING — KÖR INTE OM DEN HÄR FILEN EFTER MIGRATIONERNA !!
-- migrationer/2026-08-22-notisradie.sql och 2026-08-22-aldersgrind-for-
-- notiser.sql create-or-replace:ar fbmejl_notis_ut() och
-- fbmejl_push_mottagare() med SAMMA signaturer som här, men med radiefiltret
-- och åldersgrinden inuti. Kroppen i den här filen saknar båda. En omkörning
-- efter migrationerna skriver alltså TYST tillbaka till "alla prenumeranter
-- får allt, timgamla repriser inräknade" — utan att något loggar skillnaden.
-- Måste något här ändras: kör den här filen OCH migrationerna efteråt, i den
-- ordningen. (Granskningsfynd 2026-09-05, före lansering.)
--
-- Beroenden, i ordning:
--   supabase/schema.sql          reports, RLS, purge_old_reports
--   supabase/kvalitetsfalt.sql   kvalitetskolumnerna på reports
--   supabase/telegram.sql        VALFRI. Finns den används telegram_lasta
--                                för korsvis avdubbling, se nedan.
--
-- ---------------------------------------------------------------------
-- Varför den här filen finns
--
-- Facebook-gruppen "Här står polisen" går inte att läsa maskinellt — Meta
-- stängde Groups API för inläggsläsning 2024. Telegram-spegeln löser det men
-- kräver att en gruppadmin vill spegla inläggen, alltså att en annan människa
-- orkar göra något varje dag för alltid.
--
-- Den här vägen kräver ingen annan människa. Facebook skickar själv ett mejl
-- när det kommer ett nytt inlägg i en grupp man följer. Mejlet går till
-- ägarens egen postlåda, om notiser ägaren själv har slagit på. Ingen
-- inloggning kringgås, ingenting skrapas, ingen tredje part behöver vilja
-- något. Se docs/fbmejl.md.
--
-- ---------------------------------------------------------------------
-- Modellen, kort
--
--   fbmejl_ko          RÅA mejl som pollaren hittat. Kön in.
--   fbmejl_lasta       vilka mejl som är avgjorda. Avdubbling.
--   fbmejl_brygga      var IMAP-pollningen står (UIDVALIDITY + UID) och hur den mår.
--   fbmejl_ko_in()     pollaren lägger råa mejl här. Idempotent på Message-ID.
--   fbmejl_ko_hamta()  tolkaren hämtar det som inte är avgjort.
--   fbmejl_ta_emot()   tar emot färdigtolkade rader och skapar rapporter.
--   fbmejl_notis_ut()  EN push per omgång, med spärrar. Se avsnittet TAKTEN.
--   fbmejl_notis_stam_av()  läser pg_nets svar i efterhand och skriver vad som
--                      FAKTISKT hände med notisen. Se avsnittet STÄM AV.
--   fbmejl_normalisera_msgid()  den kanoniska formen av ett Message-ID. Allt
--                      som rör kön går genom den. Se avsnittet EN FORM.
--   fbmejl_senaste     revisionsvy: vad kom in senaste dygnet.
--   fbmejl_halsa       revisionsvy: går bryggan alls, och håller den måttet.
--
-- Och konfigurationen, som inte går genom databasinställningar längre. Se
-- avsnittet KONFIGURATION; kortversionen är att alter database är stängd för
-- rollen postgres på Supabase, så nyckeln bor i Vault och adressen i en tabell:
--
--   fbmejl_installningar     tabell. Adresser, i klartext. Aldrig nycklar.
--   fbmejl_satt_installning() sättaren, som vägrar värden med nyckelform.
--   fbmejl_valv_las()        läser en hemlighet ur vault.decrypted_secrets.
--   fbmejl_kalla()           var ligger värdet? Läsordningen bor HÄR, ensam.
--   fbmejl_installning()     icke-hemligt värde.
--   fbmejl_hemlighet()       hemligt värde. Aldrig ur klartexttabellen.
--   fbmejl_anropsnyckel()    nyckeln mot fbmejl-push.
--   fbmejl_dolj_hemligheter() maskar nycklar ur text som ska loggas.
--   fbmejl_notis_konfig()    hela facit, utan att en hemlighet syns.
--
-- Varför kön finns, i två steg istället för ett:
--
-- Tolkningen ligger i js/fbmejl.js, som anropar samma js/parser.js som rösten
-- och knapparna. Pollaren är PowerShell och kan inte köra JavaScript — det
-- finns ingen Node på maskinen. Att skriva om parsern i plpgsql eller i
-- PowerShell hade gett en andra ordlista, och en av dem är nykterhetsfiltret.
-- Det får aldrig hända.
--
-- Alltså: pollaren lägger RÅTEXT i kön inom sekunder, och något som kan köra
-- JavaScript (en edge-funktion, se docs/fbmejl.md) tömmer kön och anropar
-- fbmejl_ta_emot(). Kön är också en försäkring: går tolkaren ner ligger
-- mejlen kvar och kan köras om, istället för att gå förlorade.
--
-- Baksidan, sagd rakt ut: tolkaren MÅSTE finnas. En kö som ingen tömmer ger
-- noll varningar och ser i övrigt helt frisk ut. Vyn fbmejl_halsa längst ner
-- finns just för att den frågan ska gå att ställa.
--
-- ---------------------------------------------------------------------
-- OBS för den som redigerar filen: skriv ALDRIG ett cron-uttryck inuti en
-- blockkommentar. En stjärna följd av snedstreck avslutar kommentaren mitt i
-- raden, och resten tolkas som SQL. Hela filen dör då på "syntax error at or
-- near 5". Därför är hela den här filen skriven med radkommentarer.
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

-- ============================ SISTA NÄTET ============================
--
-- Nykterhets- och drogkontroller blir aldrig rapporter. Det är produktregel
-- nummer ett i appen, och den avgörs i js/parser.js — det är den enda
-- ordlista som räknas, och den gäller rösten, knapparna, Telegram-spegeln och
-- mejlnotiserna lika.
--
-- Funktionen nedan är inte en andra parser. Den är ett grovt nät under den
-- riktiga, för databasen är det sista stället där en rapport kan stoppas och
-- tolkningen sker på en maskin någon annanstans. Nätet är MEDVETET för brett:
-- "alkohol" räcker, utan att kräva ordet "kontroll" efter. Ett bortsorterat
-- inlägg om alkohol kostar ingenting. Ett släppt kostar hela produktregeln.
--
-- Regeln är enkelriktad: den kan bara avvisa mer än parsern, aldrig släppa
-- igenom något parsern stoppat. Släpper man till här slutar den vara ett
-- skydd och blir en andra sanning.
--
-- Uttrycket är ordagrant detsamma som telegram_ar_nykterhetskontroll() i
-- supabase/telegram.sql. Att det står två gånger är avsiktligt: filerna ska
-- gå att köra oberoende av varandra, och ett nät som bara kan säga NEJ kan
-- inte bli farligt av att finnas i två exemplar. Ändras det ena, ändra det
-- andra — kontroll 1 längst ner i filen körs på båda och säger ifrån.

create or replace function public.fbmejl_ar_nykterhetskontroll(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  -- Narkotikaorden saknades, och bindestreck bröt de delade formerna.
  -- En granskning körde riktiga meningar genom kedjan: fem av nio
  -- drogkontroller blev polisrapporter på kartan, och "drog-kontroll" gick
  -- igenom både det här nätet och parserns spärr samtidigt eftersom bara
  -- blanksteg var valfritt. Håll den här synkad med SOBRIETY_WORDS och
  -- SOBRIETY_STAMMAR i js/parser.js.
  --
  -- Bara "drog" utan efterled saknas med flit: det är också imperfekt av
  -- "dra", och "polisen drog vidare" är en avblåsning, inte en kontroll.
  --
  -- drog+razzia/polis/piket/hund/sök kom till när typorden i js/parser.js
  -- breddades: de fyra sista leden är TYPORD där, så "Drograzzia vid
  -- Erikslund" och "Drogpolisen står vid Erikslund" blev publicerade
  -- varningar med notis i stället för ingenting alls. De står bara som PAR
  -- med "drog" — en polisrazzia utan droger är en riktig rapport som ska
  -- fram. 'nyckter' är felstavningen av 'nykter' och är inget svenskt ord.
  select lower(coalesce(p_text, '')) ~
    '(nykter|nyckter|alkohol|alkotest|promille|rattfyll|utandnings|sållnings|sallnings|narkotika|narko|droger|drogsök|drogsok|drogkontroll|drogtest|drog[ -]?kontroll|drog[ -]?test|drog[ -]?koll|drog[ -]?razzia|drog[ -]?polis|drog[ -]?piket|drog[ -]?hund|drog[ -]?sök|drog[ -]?sok|blåser|blåsa|blåste|blaser|blåsning)';
$$;

-- ============================ INTEGRITET =============================
--
-- Facebooks notislänkar bär två saker som aldrig får lagras:
--
--   n_m=       MOTTAGARENS e-postadress i klartext, procentkodad. Utan
--              skrubbning hamnar den i fbmejl_ko.brodtext och därmed i varje
--              backup av databasen.
--   notif_id=  ger LÄSÅTKOMST till notisens innehåll. Ingen inloggning behövs.
--   bcode=     samma sorts kvitto.
--
-- Skrubbningen sker i tre led: i tools/fbmejl-hamta.ps1 innan texten lämnar
-- ägarens maskin, i js/fbmejl.js innan något tolkas, och här innan något
-- skrivs. Tre exemplar är avsiktligt — till skillnad från nykterhetsfiltret
-- kan en avvikelse här bara betyda att ett led skrubbar MER än ett annat.
--
-- Sökvägen lämnas intakt så grupp-id och inläggs-id går att läsa ut, och mid=
-- lämnas kvar eftersom den är en dedupnyckel som inte avslöjar mottagaren.

create or replace function public.fbmejl_sanera(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  -- Separatorn måste tåla HTML-entiteter, inte bara ett rakt &.
  --
  -- Mönstret krävde förut att tecknet omedelbart före parameternamnet var
  -- ?, &, %3F eller %26. Men i giltig HTML skrivs en href med &amp;, och
  -- Facebooks notismejl ÄR HTML-brev. Tecknet före n_m är då ett semikolon,
  -- ingen regex matchade, och mottagarens mejladress låg kvar i klartext i
  -- brodtext -- alltså i varje databasbackup. Precis det som avsnittet
  -- INTEGRITET ovan säger aldrig får hända.
  --
  -- Värdeklassen släpper igenom quoted-printables mjuka radbrott (=CRLF),
  -- annars kapades matchningen mitt i adressen och resten blev kvar.
  -- mid= lämnas orörd med flit: dedupnyckel, avslöjar ingenting.
  select regexp_replace(
           coalesce(p_text, ''),
           '([?&](?:amp;)*|&#0*38;|&#[xX]0*26;|%3F|%26|%253F|%2526)(n_m|notif_id|bcode|aref|nid)(?:=|%3D|%253D)(?:=\r?\n|[^&[:space:]"''<>])*',
           '\1\2=BORTTAGET',
           'gi');
$$;

-- ============================ MESSAGE-ID: EN FORM ====================
--
-- Ett Message-ID kan skrivas på flera sätt och betyda samma sak:
--
--   <ABC.123@facebookmail.com>     som pollaren läser det ur IMAP-huvudet
--   abc.123@facebookmail.com       som js/fbmejl.js normaliserar det
--
-- Det här har redan kostat en gång. Pollaren la in den råa formen med
-- vinkelparenteser, tolkaren skickade tillbaka den normaliserade, och varje
-- "update fbmejl_ko ... where message_id = ..." i fbmejl_ta_emot() träffade
-- NOLL rader. Kön tömdes aldrig, samma mejl plockades upp om och om igen,
-- forsok räknades upp, och efter fem varv dök de upp som "fastnade" i
-- fbmejl_halsa trots att de för länge sedan blivit rapporter på kartan. Ett
-- fel där varje led rapporterade framgång.
--
-- KONTRAKTET: den normaliserade formen är den kanoniska. Gemener, utan
-- vinkelparenteser, trimmad, kapad till 200 tecken. Kön LAGRAR den formen
-- (fbmejl_ko_in normaliserar vid insättning), och alla uppslag går genom den
-- här funktionen. Då spelar det ingen roll vilken form anroparen skickar.
--
-- Identisk med normaliseraMessageId() i js/fbmejl.js — samma ordning på
-- stegen, samma längdgräns. Ändras det ena, ändra det andra.
--
-- Tom sträng ger null, inte '': ett mejl utan Message-ID har ingen identitet
-- och ska avvisas, inte lagras under en tom nyckel som alla krockar med.

create or replace function public.fbmejl_normalisera_msgid(p_id text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select nullif(
           left(lower(btrim(regexp_replace(btrim(coalesce(p_id, '')), '^<|>$', '', 'g'))), 200),
           '');
$$;

-- ============================ KÖN IN =================================
--
-- Råa mejl, precis som pollaren läste dem. Ett mejl per rad, nyckel är
-- Message-ID i den kanoniska formen ovan.
--
-- Innehållet är andra människors text ordagrant, plus deras namn. Tabellen är
-- därför oåtkomlig för både anon och inloggade, och städas efter sju dagar.
-- Ingenting här behöver sparas längre än så: har ett mejl inte tolkats inom en
-- vecka är varningen död sedan länge ändå.

create table if not exists public.fbmejl_ko (
  message_id  text primary key,
  avsandare   text,
  amne        text,
  brodtext    text,
  skickat_at  timestamptz,
  hamtat_at   timestamptz not null default now(),
  imap_uid    bigint,
  status      text not null default 'ny'
              check (status in ('ny', 'klar', 'vagrad', 'fel')),
  skal        text,
  forsok      smallint not null default 0,
  avgjort_at  timestamptz
);

create index if not exists fbmejl_ko_status_idx on public.fbmejl_ko (status, hamtat_at);
create index if not exists fbmejl_ko_tid_idx    on public.fbmejl_ko (hamtat_at desc);

alter table public.fbmejl_ko enable row level security;

-- Inga policies, med flit. Radsäkerhet utan policy betyder att ingen som
-- kommer in via PostgREST ser eller skriver någonting alls — varken anon
-- eller inloggade. Tabellen nås bara av funktionerna nedan, som är security
-- definer, och av service_role i SQL-editorn.
revoke all on public.fbmejl_ko from anon, authenticated;

-- ============================ LÄSTA MEJL =============================
--
-- Ett inlägg får bli en rapport en gång. Facebook skickar ett NYTT mejl med
-- nytt Message-ID varje gång någon kommenterar samma inlägg — utan den här
-- tabellen blir ett inlägg med tre kommentarer fyra varningar på kartan.
--
-- Tre nycklar, för de fångar olika fel:
--   nyckel       'fbm:post:<gid>_<pid>' när mejlet bar en länk till inlägget,
--                'fbm:<message-id>' annars. Mejlets/inläggets egen identitet.
--   text_nyckel  'tx:<hash>:<fack>'. Samma text i samma tidsfönster, oavsett
--                väg in. IDENTISK med den js/telegram.js räknar fram — det är
--                den som gör att ett inlägg som både speglas till Telegram och
--                mejlas ut blir EN varning.
--   inlaggs_id   inläggets id när det gick att få tag på. Revision.
--
-- Raden skrivs även för det som INTE blev en rapport. En vägrad
-- nykterhetskontroll ska inte prövas igen vid nästa körning.

create table if not exists public.fbmejl_lasta (
  nyckel      text primary key,
  text_nyckel text,
  message_id  text,
  inlaggs_id  text,
  utfall      text not null default 'okand'
              check (utfall in ('rapport', 'vagrad', 'bortsorterad', 'okand')),
  skal        text,
  rapport_id  text references public.reports(id) on delete set null,
  last_at     timestamptz not null default now()
);

create index if not exists fbmejl_lasta_text_idx on public.fbmejl_lasta (text_nyckel);
create index if not exists fbmejl_lasta_tid_idx  on public.fbmejl_lasta (last_at desc);
create index if not exists fbmejl_lasta_msg_idx  on public.fbmejl_lasta (message_id);

alter table public.fbmejl_lasta enable row level security;
revoke all on public.fbmejl_lasta from anon, authenticated;

-- ============================ GAMMALT FORMAT I KÖN ===================
--
-- Rader som skrevs innan kontraktet ovan fanns ligger kvar med
-- vinkelparenteser och versaler. De går inte att matcha mot det tolkaren
-- skickar tillbaka, alltså blir de aldrig avgjorda — de ligger och räknar upp
-- forsok tills de dyker upp som "fastnade" i fbmejl_halsa.
--
-- Blocket nedan skriver om dem en gång. Det är avsiktligt idempotent: har
-- filen redan körts hittar det noll rader och säger ingenting.
--
-- Ordningen spelar roll. message_id är PRIMÄRNYCKEL, så en omskrivning kan
-- krocka: <ABC@x> och abc@x är två rader idag och samma rad efteråt, och det
-- gäller även <ABC@x> mot <abc@x>. En rå update hade dött på ett unique-fel
-- och tagit hela filkörningen med sig. Alltså raderas krockarna först.
--
-- Vilken rad som överlever: den som redan står i kanonisk form om en sådan
-- finns, annars den äldsta. De bär samma mejl — Message-ID är per definition
-- unikt per meddelande — så valet spelar bara roll för hamtat_at.
--
-- I skrivande stund finns inga sådana rader i produktion. Blocket finns för
-- den som kör en databas som hunnit ta emot mejl med den gamla koden, och för
-- att svaret på "vad händer med de gamla raderna?" ska stå i koden och inte
-- bara i ett samtal.

do $$
declare n_bort int := 0; n_om int := 0;
begin
  delete from public.fbmejl_ko k
   where public.fbmejl_normalisera_msgid(k.message_id) is not null
     and (public.fbmejl_normalisera_msgid(k.message_id), k.message_id) not in (
       select distinct on (public.fbmejl_normalisera_msgid(k2.message_id))
              public.fbmejl_normalisera_msgid(k2.message_id), k2.message_id
         from public.fbmejl_ko k2
        where public.fbmejl_normalisera_msgid(k2.message_id) is not null
        order by public.fbmejl_normalisera_msgid(k2.message_id),
                 (k2.message_id = public.fbmejl_normalisera_msgid(k2.message_id)) desc,
                 k2.hamtat_at asc);
  get diagnostics n_bort = row_count;

  update public.fbmejl_ko k
     set message_id = public.fbmejl_normalisera_msgid(k.message_id)
   where public.fbmejl_normalisera_msgid(k.message_id) is not null
     and public.fbmejl_normalisera_msgid(k.message_id) is distinct from k.message_id;
  get diagnostics n_om = row_count;

  -- Rader helt utan brukbart Message-ID kan inte avdubblas och skulle bli en
  -- ny varning vid varje pollning. De ska inte finnas — fbmejl_ko_in avvisar
  -- dem — men om de gör det är kön fel plats för dem.
  delete from public.fbmejl_ko
   where public.fbmejl_normalisera_msgid(message_id) is null;

  -- Minnet joinas mot kön på message_id. Samma form måste gälla där.
  update public.fbmejl_lasta l
     set message_id = public.fbmejl_normalisera_msgid(l.message_id)
   where l.message_id is not null
     and public.fbmejl_normalisera_msgid(l.message_id) is distinct from l.message_id;

  if n_om > 0 or n_bort > 0 then
    raise notice 'Message-ID i gammalt format: % omskrivna, % raderade som dubbletter.', n_om, n_bort;
  end if;
end $$;

-- ============================ BRYGGANS TILLSTÅND =====================
--
-- IMAP numrerar mejl med ett stigande UID per postlåda. Kvitterar man inte
-- hur långt man kommit läses hela inkorgen om vid varje start, och timmar
-- gamla varningar dyker upp som nya.
--
-- UIDVALIDITY måste sparas bredvid. Byter servern ut den — vilket händer om
-- postlådan byggs om — börjar UID om från ett, och ett sparat UID på 4711
-- skulle då hoppa över allt nytt för alltid. Ändras UIDVALIDITY nollställs
-- UID, och en omgång gamla mejl läses om. Det är rätt fel att göra: en
-- dubblett stoppas av avdubblingen, en missad varning stoppas av ingenting.

create table if not exists public.fbmejl_brygga (
  id             smallint primary key default 1 check (id = 1),
  uidvalidity    bigint not null default 0,
  senaste_uid    bigint not null default 0,
  senast_kord    timestamptz,
  senaste_fel    text,
  uppdaterad     timestamptz not null default now()
);

insert into public.fbmejl_brygga (id) values (1) on conflict (id) do nothing;

alter table public.fbmejl_brygga enable row level security;
revoke all on public.fbmejl_brygga from anon, authenticated;

-- ============================ NOTISER: OPT-IN ========================
--
-- En push när någon skrivit i gruppen. Kravet kommer från ägaren, och det är
-- rimligt: en varning som ligger på kartan men som ingen tittar på är ingen
-- varning.
--
-- Kolumnen läggs till på push_subscriptions och har default FALSE. Det är
-- inte försiktighet för sakens skull:
--
--   En notis är det enda i appen som visas utan att någon bett om det. Får en
--   användare notiser hen inte valt stänger hen av notiser för hela appen i
--   telefonens inställningar — och då tystnar körpåminnelsen också. Kanalen
--   är gemensam, och den som bränner den bränner den för allt.
--
-- Alltså: av som standard, på för den som väljer det. Se docs/fbmejl.md för
-- vad som behöver läggas till i js/push.js och index.html för att det ska gå
-- att slå på från appen, och för SQL-raden som slår på det för ägarens egen
-- telefon innan den knappen finns.
--
-- Blocket gör ingenting om push.sql inte är körd — då finns ingen tabell att
-- utöka, och notiserna är ändå avstängda.

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'push.sql är inte körd — gruppnotiser hoppas över. Rapporterna hamnar ändå på kartan.';
    return;
  end if;
  alter table public.push_subscriptions
    -- PA som forval sedan 21 aug 2026. Var forut av, av oro for att den som
    -- far for manga notiser stanger av dem for hela appen och darmed tystar
    -- korpaminnelsen med. Agaren vagde det mot att en varning ingen ser ar
    -- vardelos och valde pa. Det haller sa lange takten haller: en notis per
    -- omgang, tio minuter emellan, tyst 23-06, hogst tolv per dygn.
    -- Se supabase/migrationer/2026-08-21-gruppnotiser-pa-som-forval.sql.
    add column if not exists gruppnotiser boolean not null default true;
  raise notice 'push_subscriptions.gruppnotiser finns (default false — se docs/fbmejl.md).';
end $$;

-- ============================ NOTISER: TAKTEN ========================
--
-- Hur ofta får appen ringa?
--
-- Det här är den enda designfrågan i hela filen som inte har ett tekniskt
-- svar, så resonemanget står här istället för i en commit ingen läser.
--
-- Gruppen "Här står polisen" är livlig. En fredagseftermiddag kan ge tiotals
-- inlägg i timmen. En notis per inlägg betyder en telefon som ringer var
-- tredje minut, och konsekvensen av det är känd och entydig: användaren
-- stänger av notiser för Polisvakt. Inte för gruppnotiserna — för appen. Då
-- tystnar körpåminnelsen med, och den är det enda som får folk att öppna
-- appen INNAN de kör.
--
-- Fyra spärrar, och ingen av dem ersätter en annan:
--
--   buntspärren   EN notis per tömningsomgång, aldrig en per rapport. Kom det
--                 fyra varningar samtidigt är det ett besked, inte fyra.
--
--   glesspärren   minst 10 minuter mellan två notiser. Talet är valt mot
--                 varningarnas livslängd i js/store.js: polis 45 min, kontroll
--                 60, civil 30. Den som fick en notis för tio minuter sedan
--                 och öppnade appen ser den nya varningen på kartan redan —
--                 den behöver inte ringa igen.
--
--   nattspärren   inga notiser 23:00–06:00 svensk tid. Samma resonemang som
--                 nattspärren i due_push_reminders: en varning som väcker
--                 någon 03:00 kostar mer förtroende än den kan ge tillbaka.
--                 Vill man ha nattnotiser är det ett medvetet val — ändra
--                 p_tidigast och p_senast, de sitter som parametrar just
--                 därför.
--
--   dygnstaket    högst 12 notiser per dygn. Är gruppen så aktiv att taket
--                 slår i är appen inte längre kanalen — då öppnar man den.
--
-- Ingenting går tyst förlorat. Varje undertryckt omgång räknas upp i
-- odelade, och nästa notis som får gå säger hur många varningar som kommit
-- sedan sist. Användaren får alltså veta att det hänt saker, bara inte fyra
-- gånger i rad.

create table if not exists public.fbmejl_notis_lage (
  id             smallint primary key default 1 check (id = 1),
  senaste_at     timestamptz,
  antal_idag     smallint not null default 0,
  dag            date,
  odelade        int not null default 0,   -- varningar som inte fått ringa än
  senaste_fel    text,
  uppdaterad     timestamptz not null default now()
);

insert into public.fbmejl_notis_lage (id) values (1) on conflict (id) do nothing;

alter table public.fbmejl_notis_lage enable row level security;
revoke all on public.fbmejl_notis_lage from anon, authenticated;

-- Loggen finns för att frågan "varför ringde det inte?" ska gå att besvara i
-- efterhand. Utan den ser en tyst spärr exakt likadan ut som en trasig kedja.
--
-- ---------------------------------------------------------------------
-- Om ordet 'skickad', och varför det inte finns kvar
--
-- Den gamla loggen skrev 'skickad' direkt efter net.http_post(). Det var inte
-- sant. net.http_post är ASYNKRON: den lägger anropet i pg_nets kö och
-- returnerar ett id på en gång. exception-blocket runt den fångar bara att
-- KÖANDET misslyckades — inte att nyckeln var fel (401), att funktionen inte
-- var utrullad (404), eller att noll människor hade slagit på gruppnotiser.
-- Alla tre gav 'skickad' i loggen och räknades upp i fbmejl_halsa.
--
-- Det är exakt det felmönster som redan drabbat den här appen en gång: varje
-- led rapporterade framgång och noll notiser nådde fram, i veckor.
--
-- Nu står det i loggen vad vi faktiskt vet, och inte mer:
--
--   ingen-mottagare  noll personer har gruppnotiser på. Inget skickades.
--   koad             pg_net har tagit emot anropet. Vi vet INTE mer än så än.
--   kvitterad        edge-funktionen svarade 2xx. skal bär dess svarskropp,
--                    som säger hur många pushar som gick ut. Det betyder att
--                    SERVERN gjorde sitt — inte att en telefon visade något.
--   fel              pg_net vägrade, eller svaret var 4xx/5xx/timeout.
--   sparrad          en av de fyra spärrarna sa nej. Inget fel.
--   okand            pg_net hann städa bort svaret innan vi läste det.
--
-- 'skickad' står kvar i villkoret enbart för rader som redan ligger i
-- databasen från den gamla versionen. Ingen ny rad skrivs med det värdet.

create table if not exists public.fbmejl_notis_logg (
  id          bigint generated always as identity primary key,
  skickat_at  timestamptz not null default now(),
  antal       int not null default 0,
  titel       text,
  text        text,
  utfall      text not null default 'koad',
  skal        text,
  -- pg_nets kvitto. Nyckeln in i net._http_response, se
  -- fbmejl_notis_stam_av() nedan. Null när ingenting skickades.
  net_id      bigint
);

-- Kolumnen och villkoret ändrades efter att tabellen först skapades. Den som
-- kör om filen på en befintlig databas har en tabell utan net_id och med det
-- gamla tre-värdes-villkoret, och create table if not exists gör ingenting åt
-- det. Alltså uttryckligt:
alter table public.fbmejl_notis_logg add column if not exists net_id bigint;
alter table public.fbmejl_notis_logg alter column utfall set default 'koad';
alter table public.fbmejl_notis_logg drop constraint if exists fbmejl_notis_logg_utfall_check;
alter table public.fbmejl_notis_logg add constraint fbmejl_notis_logg_utfall_check
  check (utfall in ('koad', 'kvitterad', 'sparrad', 'fel', 'ingen-mottagare', 'okand', 'skickad'));

create index if not exists fbmejl_notis_logg_tid_idx on public.fbmejl_notis_logg (skickat_at desc);
-- Avstämningen nedan letar bara efter rader som väntar på svar. Utan index
-- går den igenom hela loggen var femte minut.
create index if not exists fbmejl_notis_logg_koad_idx on public.fbmejl_notis_logg (net_id)
  where utfall = 'koad';

alter table public.fbmejl_notis_logg enable row level security;
revoke all on public.fbmejl_notis_logg from anon, authenticated;

-- ============================ KONFIGURATION ==========================
--
-- Var ligger adressen, och var ligger nyckeln?
--
-- Den ursprungliga konstruktionen läste båda ur databasinställningar:
--
--   alter database postgres set app.service_role_key = '...';
--   alter database postgres set app.fbmejl_push_url  = '...';
--
-- DET GÅR INTE PÅ DET HÄR PROJEKTET. SQL-editorn kör som rollen postgres, och
-- postgres är inte superuser på Supabase. Uppmätt svar:
--
--   ERROR: 42501: permission denied to set parameter "app.fbmejl_push_url"
--
-- Alltså gick varken adressen eller nyckeln att sätta, och notiskedjan stod
-- kvar i fbmejl_notis_ut() med "ingen url". Varje annat led såg friskt ut.
-- Exakt det felmönster som den här filen redan bär tre ärr av.
--
-- ---------------------------------------------------------------------
-- Två lager, och de skiljer på hemligt och inte hemligt
--
--   public.fbmejl_installningar    en vanlig liten tabell.  ADRESSER.
--   vault.secrets (supabase_vault) krypterat valv.          NYCKLAR.
--
-- Varför inte lägga adressen i valvet också, när valvet ändå finns?
--
-- För att ett valv med två rader där bara den ena är känslig gör det svårare,
-- inte lättare, att se vad som faktiskt måste skyddas. Adressen till
-- edge-funktionen ÄR ingen hemlighet: den är
-- https://<projekt>.supabase.co/functions/v1/fbmejl-push, projekt-id:t står
-- redan öppet i js/config.js, och funktionen svarar 401 på varje anrop utan
-- nyckel. Att kryptera den köper ingenting, och kostar två saker som är dyra
-- just i den här kedjan: värdet går inte längre att LÄSA när man felsöker,
-- och nästa människa som öppnar valvsidan ser två hemligheter och vet inte
-- vilken av dem som är den som får en telefon att ringa.
--
-- Alltså: adressen i klartext i en tabell med radsäkerhet på och allt indraget
-- från anon och authenticated, nyckeln i valvet. Valvsidan innehåller då
-- exakt EN rad, och den raden är en riktig hemlighet.
--
-- ---------------------------------------------------------------------
-- Ordningen, och varför den gamla vägen finns kvar
--
--   1. public.fbmejl_installningar     bara för icke-hemligt
--   2. vault.decrypted_secrets         namnet ordagrant, se docs/notiskedjan.md
--   3. current_setting('app.<namn>')   den gamla vägen
--   4. null
--
-- Steg 3 är inte död kod. På ett projekt där alter database FUNGERAR — en
-- egen Postgres, en självdriftad Supabase, eller ett projekt där ägaren har
-- superuser — är de raderna redan körda och kedjan går. Tas steget bort
-- slutar en fungerande installation att fungera vid nästa körning av den här
-- filen, utan att någonting i den installationen har ändrats. Den sortens
-- tyst nedgradering får inte finnas i en fil som är byggd för att köras om.
--
-- Steg 2 gäller även adressen. Det är en eftergift åt verkligheten: den som
-- just satt nyckeln på valvsidan står på precis rätt plats för att av misstag
-- klistra in adressen bredvid, och ett tyst "ingen url" är ett dyrt sätt att
-- upptäcka det.
--
-- Ordningen ligger på ETT ställe: fbmejl_kalla(). Läsarna nedan frågar den
-- var värdet finns och hämtar det sedan därifrån. Skälet är filens egen
-- historia — samma regel skriven på två ställen driver isär, och här hade
-- driften betytt att felsökningsfunktionen påstår en sak och notisen gör en
-- annan.

create table if not exists public.fbmejl_installningar (
  nyckel      text primary key,
  varde       text,
  beskrivning text,
  uppdaterad  timestamptz not null default now()
);

alter table public.fbmejl_installningar enable row level security;
revoke all on public.fbmejl_installningar from anon, authenticated;

-- Raderna finns med beskrivning även när värdet är tomt, så att
-- "select * from public.fbmejl_installningar" svarar på frågan vad som GÅR
-- att sätta. En tom tabell svarar bara att ingenting är satt.
insert into public.fbmejl_installningar (nyckel, beskrivning) values
  ('fbmejl_push_url',
   'Adress till edge-funktionen fbmejl-push. https://<projekt>.supabase.co/functions/v1/fbmejl-push'),
  ('fbmejl_tom_url',
   'Adress till edge-funktionen fbmejl-tom. Bara om kön ska tömmas av pg_cron istället för Dashboard.')
on conflict (nyckel) do nothing;

-- Sättaren finns för att tabellen inte ska bli den plats där en nyckel
-- hamnar av misstag. Den tar bara de namn som är kända, kräver https, och
-- vägrar värden som har formen av en nyckel. Det sista är ingen paranoia:
-- den som får "url saknas" i loggen och står på valvsidan med nyckeln i
-- urklipp är en klistring från att lägga en service role-nyckel i klartext i
-- en tabell som följer med i varje backup.
create or replace function public.fbmejl_satt_installning(p_nyckel text, p_varde text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_nyckel text := lower(btrim(coalesce(p_nyckel, '')));
  v_varde  text := nullif(btrim(coalesce(p_varde, '')), '');
begin
  if v_nyckel not in ('fbmejl_push_url', 'fbmejl_tom_url') then
    return jsonb_build_object('ok', false, 'skal', 'okand nyckel',
      'tillatna', jsonb_build_array('fbmejl_push_url', 'fbmejl_tom_url'));
  end if;

  if v_varde is not null then
    -- Formkontroll, aldrig innehållskontroll. Samma princip som
    -- edge-funktionens 401-logg: säg vad formen är, aldrig vad värdet är.
    if v_varde !~ '^https://[A-Za-z0-9._-]+/' then
      return jsonb_build_object('ok', false, 'skal', 'varde maste vara en https-adress',
        'fick_langd', length(v_varde));
    end if;
    if v_varde ~ 'eyJ[A-Za-z0-9._-]{20,}' or v_varde ~ 'sb_[a-z]+_[A-Za-z0-9_-]{20,}' then
      return jsonb_build_object('ok', false,
        'skal', 'vardet har formen av en nyckel och lagras inte i klartext. Lagg den i valvet.',
        'fick_langd', length(v_varde));
    end if;
  end if;

  insert into public.fbmejl_installningar (nyckel, varde, uppdaterad)
  values (v_nyckel, v_varde, now())
  on conflict (nyckel) do update
     set varde = excluded.varde, uppdaterad = now();

  return jsonb_build_object('ok', true, 'nyckel', v_nyckel, 'varde', v_varde);
end $$;

-- ---------------------------------------------------------------------
-- VALVET
--
-- supabase_vault lagrar hemligheten krypterad i vault.secrets och lämnar ut
-- den dekrypterad genom vyn vault.decrypted_secrets. Vyn ägs av
-- supabase_admin och är läsbar för postgres — alltså för en security
-- definer-funktion som skapats i SQL-editorn, och för ingen annan.
--
-- Funktionen svarar null på ALLT som går fel: inget valv installerat, ingen
-- läsrätt, inget sådant namn. Det är med flit — en notiskedja ska inte dö för
-- att ett valv saknas — men det gör också att ett tyst null inte går att
-- skilja från ett tomt valv. Därför finns fbmejl_notis_konfig() längre ner,
-- som säger VARFÖR, med form och längd men aldrig med värde.
create or replace function public.fbmejl_valv_las(p_namn text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp as $$
declare
  v_varde text;
begin
  if p_namn is null or p_namn !~ '^[a-z][a-z0-9_]*$' then
    return null;
  end if;

  -- to_regclass() ligger INNANFÖR exception-blocket, och det är ingen
  -- slarvighet. Den slår upp schemat med LookupExplicitNamespace(), som
  -- prövar USAGE och KASTAR om rätten saknas — även när objektet efterfrågas
  -- med missing_ok. Låg den utanför skulle en databas där valvet finns men
  -- inte är läsbart få hela notisen att dö med "permission denied for schema
  -- vault", i stället för att svara null och låta konfigurationskontrollen
  -- förklara varför.
  begin
    if to_regclass('vault.decrypted_secrets') is null then
      return null;
    end if;

    select s.decrypted_secret into v_varde
      from vault.decrypted_secrets s
     where s.name = p_namn
     order by s.created_at desc
     limit 1;
  exception when others then
    -- Nästan alltid utebliven läsrätt på vault-schemat. Sväljs här och
    -- rapporteras av fbmejl_notis_konfig() istället, som körs när någon
    -- frågar och inte mitt i en notis.
    return null;
  end;

  -- btrim är med flit. En hemlighet klistrad in i dashboarden får ofta en
  -- radbrytning på slutet, och edge-funktionen kör .trim() på det den tar
  -- emot. Trimmas det inte här jämförs en sträng med nyrad mot en utan, och
  -- svaret blir 401 på en nyckel som ser alldeles rätt ut.
  return nullif(btrim(coalesce(v_varde, '')), '');
end $$;

-- ---------------------------------------------------------------------
-- KÄLLAN
--
-- Var finns värdet? Ordningen bor här och ingen annanstans. Funktionen
-- lämnar aldrig ut något värde, bara namnet på platsen — den går därför att
-- läsa i en felsökning utan att något känsligt hamnar på skärmen.
--
-- p_hemlig = true hoppar över tabellen helt. En hemlighet får inte läsas ur
-- en klartexttabell ens om någon lagt den där för hand; skulle den vägen
-- fungera vore sättarens vägran ovan bara en artighet.
create or replace function public.fbmejl_kalla(p_namn text, p_hemlig boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp as $$
declare
  v_finns boolean;
begin
  if p_namn is null or p_namn !~ '^[a-z][a-z0-9_]*$' then
    return null;
  end if;

  if not coalesce(p_hemlig, false) then
    select true into v_finns
      from public.fbmejl_installningar i
     where i.nyckel = p_namn
       and coalesce(btrim(i.varde), '') <> ''
     limit 1;
    if coalesce(v_finns, false) then
      return 'tabell';
    end if;
  end if;

  if public.fbmejl_valv_las(p_namn) is not null then
    return 'valv';
  end if;

  if nullif(btrim(coalesce(current_setting('app.' || p_namn, true), '')), '') is not null then
    return 'databasinstallning';
  end if;

  return null;
end $$;

-- Icke-hemliga värden. Adresser, alltså.
create or replace function public.fbmejl_installning(p_namn text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp as $$
declare
  v_kalla text := public.fbmejl_kalla(p_namn, false);
  v_varde text;
begin
  if v_kalla = 'tabell' then
    select btrim(i.varde) into v_varde
      from public.fbmejl_installningar i where i.nyckel = p_namn;
  elsif v_kalla = 'valv' then
    v_varde := public.fbmejl_valv_las(p_namn);
  elsif v_kalla = 'databasinstallning' then
    v_varde := btrim(current_setting('app.' || p_namn, true));
  end if;
  return nullif(coalesce(v_varde, ''), '');
end $$;

-- Hemliga värden. Aldrig ur tabellen.
create or replace function public.fbmejl_hemlighet(p_namn text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp as $$
declare
  v_kalla text := public.fbmejl_kalla(p_namn, true);
begin
  if v_kalla = 'valv' then
    return public.fbmejl_valv_las(p_namn);
  elsif v_kalla = 'databasinstallning' then
    return nullif(btrim(coalesce(current_setting('app.' || p_namn, true), '')), '');
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- NYCKELN SOM ANVÄNDS MOT fbmejl-push
--
-- Två namn, i tur och ordning:
--
--   fbmejl_anropsnyckel   en egen delad hemlighet, bara för det här anropet
--   service_role_key      hela projektets service role-nyckel
--
-- Den EGNA hemligheten först, och det är ett val, inte en slump.
--
-- Edge-funktionen godtar tre nycklar: SUPABASE_SERVICE_ROLE_KEY (injicerad av
-- plattformen), SERVICE_ROLE_KEY, och den valfria FBMEJL_ANROPSNYCKEL. Den
-- sista är bättre av tre skäl:
--
--   1. Den kan roteras utan att röra något annat. Byts service role-nyckeln
--      ut måste varje jobb, varje skript och varje funktion som bär den bytas
--      samtidigt. Byts den här behöver två fält ändras, och ingenting annat i
--      projektet vet ens om att det hänt.
--   2. Läcker den kostar den mindre. Service role-nyckeln går förbi all
--      radsäkerhet i hela databasen. Den här går att skicka EN sak med: en
--      gruppnotis. Illa nog, och det är precis den bugg edge-funktionens
--      egen kommentar kallar den värsta den kan ha — men det är en bugg med
--      en botten.
--   3. Den slipper fällan som redan kostat en felsökningskväll här. Projektet
--      har både en sb_secret-nyckel och en äldre eyJ-JWT, plattformen
--      injicerar EN av dem, och sätter man den andra svarar funktionen 401 på
--      varje anrop. En egen sträng har ingen andra utgåva att förväxlas med.
--
-- Priset, sagt rakt ut: värdet måste sättas på TVÅ ställen — som hemlighet
-- FBMEJL_ANROPSNYCKEL i edge-funktionen, och i valvet under namnet
-- fbmejl_anropsnyckel. Glider de isär blir det 401. Men service role-vägen
-- har samma tvåställesproblem och därtill ett ställe man inte råder över,
-- eftersom plattformen väljer utgåva åt en. Två ställen man styr över är
-- bättre än ett man styr över och ett man inte gör.
--
-- Service role-nyckeln ligger kvar som andrahandsval. Ett projekt som redan
-- kört "alter database postgres set app.service_role_key = ..." fortsätter gå
-- utan en enda ändring.
create or replace function public.fbmejl_anropsnyckel()
returns text
language sql
stable
security definer
set search_path = public, pg_temp as $$
  select coalesce(public.fbmejl_hemlighet('fbmejl_anropsnyckel'),
                  public.fbmejl_hemlighet('service_role_key'));
$$;

-- ---------------------------------------------------------------------
-- INGEN HEMLIGHET I EN LOGG
--
-- fbmejl_notis_logg.skal bär två sorters text som kommer utifrån: sqlerrm
-- från net.http_post(), och svarskroppen från det som svarade på adressen.
-- Ingen av dem är hemlig i normalfallet. Men adressen är en INSTÄLLNING, och
-- pekar den fel går bäraranropet till någon annans server — och en server som
-- ekar tillbaka sina huvuden skriver då nyckeln rakt in i loggen, i en tabell
-- som följer med i varje backup.
--
-- Därför maskas texten innan den sparas. Två lager:
--
--   1. De nycklar vi själva känner till, ordagrant utbytta.
--   2. Formerna, för de nycklar vi inte känner till: "Bearer <något långt>",
--      eyJ-strängar (JWT) och sb_-strängar (nya API-nycklar).
--
-- Kvar blir formen och längden, aldrig innehållet. Samma mönster som
-- 401-loggen i supabase/functions/fbmejl-push/index.ts, och av samma skäl:
-- det som ska felsökas är om nyckeln har rätt FORM, inte vilken den är.
create or replace function public.fbmejl_dolj_hemligheter(p_text text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp as $$
declare
  v_ut text := p_text;
  v_h  text;
begin
  if v_ut is null or v_ut = '' then
    return v_ut;
  end if;

  foreach v_h in array array[
    public.fbmejl_hemlighet('fbmejl_anropsnyckel'),
    public.fbmejl_hemlighet('service_role_key')
  ] loop
    if v_h is not null and length(v_h) >= 8 then
      v_ut := replace(v_ut, v_h, '[hemlighet, ' || length(v_h) || ' tecken]');
    end if;
  end loop;

  v_ut := regexp_replace(v_ut, '(?i)(bearer[[:space:]]+)[^[:space:]"'']{16,}',
                         '\1[dold nyckel]', 'g');
  v_ut := regexp_replace(v_ut, 'eyJ[A-Za-z0-9._-]{20,}',       '[dold jwt]',    'g');
  v_ut := regexp_replace(v_ut, 'sb_[a-z]+_[A-Za-z0-9_-]{20,}', '[dold nyckel]', 'g');

  return v_ut;
end $$;

-- ---------------------------------------------------------------------
-- GICK DET IN? SVARET UTAN ATT NÅGON HEMLIGHET SYNS
--
-- Det här är funktionen ägaren kör efter att ha lagt nyckeln i valvet. Den
-- svarar på om kedjan har allt den behöver, och den skriver aldrig ut ett
-- hemligt värde: bara om det finns, varifrån det kom, hur långt det är och
-- vilka tre tecken det börjar på. Tre tecken räcker för att skilja eyJ från
-- sb_ — alltså för att se den enda förväxling som faktiskt inträffar — och
-- räcker inte till någonting annat.
create or replace function public.fbmejl_notis_konfig()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp as $$
declare
  v_url        text := public.fbmejl_installning('fbmejl_push_url');
  v_url_kalla  text := public.fbmejl_kalla('fbmejl_push_url', false);
  v_nyckel     text := public.fbmejl_anropsnyckel();
  v_egen       text := public.fbmejl_kalla('fbmejl_anropsnyckel', true);
  v_srk        text := public.fbmejl_kalla('service_role_key', true);
  v_valv_finns boolean := false;
  v_valv_las   boolean := false;
  v_valv_fel   text;
  v_antal      bigint;
begin
  -- Både uppslagningen och räkningen ligger inne i exception-blocket. Samma
  -- skäl som i fbmejl_valv_las(): to_regclass() prövar USAGE på schemat och
  -- kastar om rätten saknas, och den här funktionen är just den man kör NÄR
  -- något inte fungerar. Den får inte vara det som går sönder.
  begin
    v_valv_finns := to_regclass('vault.decrypted_secrets') is not null;
    if v_valv_finns then
      execute 'select count(*) from vault.secrets' into v_antal;
      v_valv_las := true;
    end if;
  exception when others then
    v_valv_fel := left(sqlerrm, 200);
  end;

  return jsonb_build_object(
    'push_url',        v_url,
    'push_url_kalla',  v_url_kalla,
    'nyckel_finns',    v_nyckel is not null,
    'nyckel_langd',    coalesce(length(v_nyckel), 0),
    'nyckel_form',     coalesce(left(v_nyckel, 3), 'ingen'),
    'nyckel_kalla',    case when v_egen is not null then 'fbmejl_anropsnyckel/' || v_egen
                            when v_srk  is not null then 'service_role_key/' || v_srk
                            else null end,
    'valv_installerat', v_valv_finns,
    'valv_lasbart',     v_valv_las,
    'valv_hemligheter', v_antal,
    'valv_fel',         v_valv_fel,
    'pg_net',          exists (select 1 from pg_proc p
                                 join pg_namespace n on n.oid = p.pronamespace
                                where n.nspname = 'net' and p.proname = 'http_post'),
    'mottagare',       public.fbmejl_gruppnotis_antal(),
    'klar',            v_url is not null and v_nyckel is not null
  );
end $$;

-- ============================ NOTISER: TEXTEN ========================
--
-- Vad står det i notisen?
--
-- Typ plus plats, och ingenting mer. ALDRIG inläggets råa text.
--
-- Skälet är inte estetiskt. note är en främlings ord ordagrant, hämtade ur ett
-- mejl vi inte kontrollerar, och en notis är det enda i appen som dyker upp på
-- en låst skärm utan att någon bett om det. Det som får visas där måste vara
-- något vi själva har byggt av fält vi själva har validerat: typen är en av
-- fyra kända strängar, platsen är geokodningens etikett. Skickar man vidare
-- råtexten har man byggt en kanal där vem som helst i en Facebook-grupp kan
-- skriva vad som helst rakt in på en främlings låsskärm.

create or replace function public.fbmejl_typnamn(p_typ text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select case p_typ
    when 'police'   then 'Polis'
    when 'control'  then 'Trafikkontroll'
    when 'unmarked' then 'Civil polisbil'
    when 'camera'   then 'Fartkamera'
    else 'Varning'
  end;
$$;

-- ============================ NOTISER: MENINGEN ======================
--
-- Notisen ska bära samma mening som appen visar, inte fyra fakta bredvid
-- varandra.
--
-- js/sammanfattning.js gör redan det jobbet på klienten: "Fartkontroll med
-- laser vid Hälla — någon i Facebook-gruppen varnade för 2 minuter sedan."
-- Fyra saker måste alltid vara med, och skälet står i den filen: VAD, VAR,
-- NÄR och VARIFRÅN. Utan NÄR och VARIFRÅN är en varning inte något föraren
-- kan handla på, och utan VARIFRÅN ser gruppens andrahandsuppgift ut som en
-- officiell uppgift.
--
-- Varför meningen byggs HÄR och inte i klienten, trots att koden redan finns
-- där: push-lyssnaren i sw.js får en färdig titel och en färdig brödtext och
-- ritar dem. Den kan inte formulera något — en service worker som skulle
-- importera sammanfattning.js hade dragit in parser.js, util.js och store.js
-- i en modulkontext som sw.js inte kör i, och kedjan hade blivit längre och
-- skörare på det enda ställe där den absolut inte får vara det. Servern
-- skickar alltså den färdiga meningen, och de två ställena möts i formen:
-- samma ord, samma ordning, samma åldersfraser.
--
-- Fördelningen mellan titel och brödtext följer meningens eget snitt:
--
--   rubrik  "Fartkontroll med laser vid Hälla"        -> notisens titel
--   svans   "Någon i Facebook-gruppen varnade för
--            2 minuter sedan. Kan ha flyttat på sig." -> notisens brödtext
--   mening  rubrik + tankstreck + svans, gemen        -> loggen, revisionen
--
-- DET SOM ALDRIG FÅR HÄNDA: inläggets råtext på en låsskärm. Se avsnittet
-- NOTISER: TEXTEN ovan. Regeln är intakt här. Platsen är geokodningens
-- etikett, typen är en av fyra kända strängar, och det enda som härleds ur
-- inläggstexten är fbmejl_utrustning() nedan — som bara kan svara med ett av
-- tre fasta ord. Ingen teckensekvens ur ett Facebook-inlägg kan ta sig
-- igenom den funktionen.

-- Laser eller radar? Ett slutet svar, aldrig ett citat.
--
-- Samma tre fall som typText() i js/sammanfattning.js prövar, i samma
-- ordning. Returvärdet är 'laser', 'radar', 'fart' eller null — ingenting
-- annat kan komma ut, hur inlägget än ser ut.
create or replace function public.fbmejl_utrustning(p_text text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare v_t text;
begin
  -- Samma orduppdelning som klienten: allt som inte är en bokstav eller en
  -- siffra skiljer ord. Då fångas "laser-kontroll" och "laserkontroll" lika.
  v_t := ' ' || regexp_replace(lower(coalesce(p_text, '')), '[^0-9a-zåäöéèü]+', ' ', 'g');
  if v_t ~ ' laser'  then return 'laser'; end if;
  if v_t ~ ' radar'  then return 'radar'; end if;
  if v_t ~ ' (fartkontroll|hastighetskontroll|fartkoll|fartkamera)' then return 'fart'; end if;
  return null;
end $$;

-- Typen i klartext, med utrustningen inbakad när den är känd.
--
-- Bygger på fbmejl_typnamn() med flit: typordlistan ska finnas på ETT
-- ställe. Den här funktionen lägger bara till de tre preciseringar som
-- js/sammanfattning.js gör, och bara för trafikkontroller.
create or replace function public.fbmejl_typtext(p_typ text, p_utrustning text default null)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp as $$
  select case
    when p_typ = 'control' and p_utrustning = 'laser' then 'Fartkontroll med laser'
    when p_typ = 'control' and p_utrustning = 'radar' then 'Fartkontroll med radar'
    when p_typ = 'control' and p_utrustning = 'fart'  then 'Fartkontroll'
    else public.fbmejl_typnamn(p_typ)
  end;
$$;

-- Platsfrasen, med ledande mellanslag när det finns en plats.
--
-- Tre utfall, ordagrant som platsFras() i js/sammanfattning.js, och det
-- tredje är det som brukar glömmas: ingen plats alls. Då sägs det rakt ut.
-- En mening som bara utelämnar platsen låter som om den hade en.
--
-- Två listor följer med från klienten:
--   tomma etiketter   "-", "okänd", "null" — text som ser ut att vara en
--                     plats men inte är det.
--   inte en plats     etiketter som bara upprepar typen. "Polis vid Polis"
--                     är ingen upplysning.
-- Och prepositionslistan, som hindrar "vid på E18" och "vid vid Hälla".
create or replace function public.fbmejl_platsfras(p_plats text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_etikett text;
  v_norm    text;
  v_forsta  text;
begin
  v_etikett := btrim(regexp_replace(coalesce(p_plats, ''), '[[:space:]]+', ' ', 'g'));

  v_norm := lower(v_etikett);
  v_norm := regexp_replace(v_norm, '[^0-9a-zåäöéèü_[:space:]-]+', ' ', 'g');
  v_norm := btrim(regexp_replace(v_norm, '[[:space:]]+', ' ', 'g'));

  if v_norm = any (array[
       '', '-', 'okänd', 'okand', 'okänt', 'okant', 'null', 'undefined',
       'plats okänd']) then
    return ', plats okänd';
  end if;

  if v_norm = any (array[
       'polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
       'kontroll', 'trafikkontroll', 'fartkontroll', 'hastighetskontroll',
       'poliskontroll', 'civil', 'civilbil', 'civilpolis', 'kamera',
       'fartkamera', 'varning']) then
    return ', plats okänd';
  end if;

  v_forsta := split_part(v_norm, ' ', 1);
  if v_forsta = any (array[
       'vid', 'på', 'pa', 'i', 'utanför', 'utanfor', 'mot', 'längs', 'langs',
       'nära', 'nara', 'runt', 'kring', 'mellan', 'efter', 'före', 'fore',
       'under', 'över', 'over', 'norr', 'söder', 'soder', 'öster', 'oster',
       'väster', 'vaster', 'strax']) then
    return ' ' || v_etikett;
  end if;

  return ' vid ' || v_etikett;
end $$;

-- Hela meningen, i tre delar.
--
-- Åldersfraserna och aktualitetsförbehållen är ordagrant desamma som
-- alderDelar() och aktualitet() i js/sammanfattning.js, inklusive gränserna:
-- en minut, en timme, ett dygn. Livslängderna är samma tal som TTL_MINUTES i
-- js/store.js — polis 45, kontroll 60, civil 30 — och det är de som gör att
-- en civil polisbil låter gammal tidigare än en trafikkontroll. Den förra
-- flyttar sig, den senare står kvar och bygger kö.
--
-- Tvåminuterstoleransen för framtida stämplar finns av samma skäl som i
-- klienten: en klocka som går fel ska ge "vid en tidpunkt som inte går att
-- lita på", inte "om 20 minuter".
--
-- @param p_created_at millisekunder sedan epoch, som i reports.created_at
create or replace function public.fbmejl_mening(
  p_typ        text,
  p_utrustning text,
  p_plats      text,
  p_created_at bigint default null
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp as $$
declare
  v_nu     bigint := (extract(epoch from now()) * 1000)::bigint;
  v_ms     bigint;
  v_min    bigint;
  v_ttl    int;
  v_okand  boolean := false;
  v_nar    text;
  v_akt    text := '';
  v_rubrik text;
  v_svans  text;
begin
  v_rubrik := public.fbmejl_typtext(p_typ, p_utrustning) || public.fbmejl_platsfras(p_plats);

  if p_created_at is null or p_created_at <= 0 then
    v_okand := true;
    v_nar := 'vid okänd tidpunkt';
  else
    v_ms := v_nu - p_created_at;
    if v_ms < -120000 then
      v_okand := true;
      v_nar := 'vid en tidpunkt som inte går att lita på';
    else
      v_min := greatest(0, v_ms / 60000);
      if    v_min = 0     then v_nar := 'just nu';
      elsif v_min = 1     then v_nar := 'för en minut sedan';
      elsif v_min < 60    then v_nar := 'för ' || v_min || ' minuter sedan';
      elsif v_min < 90    then v_nar := 'för ungefär en timme sedan';
      elsif v_min < 1440  then v_nar := 'för ' || round(v_min / 60.0) || ' timmar sedan';
      elsif v_min < 2880  then v_nar := 'för mer än ett dygn sedan';
      else                     v_nar := 'för ' || round(v_min / 1440.0) || ' dagar sedan';
      end if;
    end if;
  end if;

  if not v_okand then
    -- TROVÄRDIGHETSTIDEN, samma tal som js/store.js TTL_MINUTES. HÖJ INTE
    -- DEM TILL 240 för att matcha den tid rapporten syns. Sedan
    -- 2026-08-23 är de två olika saker: rapporten ligger kvar fyra timmar
    -- (store.js VISNING_MINUTER), men tron på den tar slut här. Skrevs 240
    -- in nedan skulle en två timmar gammal rapport sluta säga "Kan ha
    -- flyttat på sig" — alltså skulle den längre livslängden göra texten
    -- MER tvärsäker ju äldre uppgiften blev. Åldersgrinden för notiser
    -- (fbmejl_ttl_minuter i migrationen 2026-08-22) räknar på samma tal och
    -- provas mot den här funktionen av PROV 2.
    v_ttl := case p_typ
               when 'police'   then 45
               when 'control'  then 60
               when 'unmarked' then 30
               when 'camera'   then 525600
               else 45
             end;
    if v_min >= v_ttl then
      v_akt := ' Troligen inte kvar.';
    elsif v_min::numeric / v_ttl >= 0.5 then
      v_akt := ' Kan ha flyttat på sig.';
    end if;
  end if;

  -- Versalen står här och inte i ett upper(): brödtexten börjar en mening,
  -- den fullständiga meningen gör det inte. Två fasta strängar är säkrare än
  -- en teckenoperation som beter sig olika beroende på databasens kollation.
  v_svans := 'Någon i Facebook-gruppen varnade ' || v_nar || '.' || v_akt;

  return jsonb_build_object(
    'rubrik', v_rubrik,
    'svans',  v_svans,
    'mening', v_rubrik || ' — någon i Facebook-gruppen varnade ' || v_nar || '.' || v_akt,
    'nar',    v_nar
  );
end $$;

-- ============================ NOTISER: SLÅ PÅ ========================
--
-- Appens knapp. Samma mönster som mark_drove_today() i push.sql: den som
-- anropar måste känna till både sin egen endpoint och sitt device_id, och
-- public.actor() avgör vem raden tillhör. Ingen kan slå på notiser åt någon
-- annan.
--
-- Funktionen skapas bara om push.sql är körd — annars finns varken tabellen
-- eller actor(), och ett create som misslyckas hade dödat hela filen.
--
-- ---------------------------------------------------------------------
-- Varför den returnerar något, och inte void
--
-- Den gamla versionen var ett rent "update ... where endpoint = ... and
-- device_id = ..." som returnerade void. Träffade den noll rader syntes det
-- ingenstans: PostgREST svarar 200 på en void-funktion oavsett, appen skrev
-- "På" i reglaget, och notiserna kom aldrig.
--
-- Det är inte ett teoretiskt fall. Prenumererar man utloggad skrivs raden med
-- ett anonymt device_id. Loggar man sedan in skrivs raden om till auth.uid().
-- Loggar man ut igen och drar reglaget matchar varken endpoint + gammalt
-- device_id eller endpoint + nytt — noll rader, tyst "På", tystnad.
--
-- Nu svarar funktionen med vad som FAKTISKT står i databasen efteråt. Träffar
-- den ingen rad säger den det rakt ut, och appen kan be användaren slå på
-- notiser igen istället för att ljuga i reglaget.
--
-- Svaret:
--   { "ok": true,  "pa": true|false, "rader": 1, "skal": null }
--   { "ok": false, "pa": false,      "rader": 0, "skal": "ingen-rad" }
--
-- Läs tillbaka sanningen med fbmejl_har_gruppnotiser() — appen ska aldrig
-- behöva lita på localStorage för det här.

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'push.sql saknas — hoppar över fbmejl_satt_gruppnotiser().';
    return;
  end if;

  -- Returtypen ändrades från void till jsonb. create or replace kan inte
  -- ändra returtyp, alltså måste den gamla bort först. Utan det här steget
  -- dör körningen med "cannot change return type of existing function" på
  -- varje databas som kört en tidigare version av filen.
  execute 'drop function if exists public.fbmejl_satt_gruppnotiser(text, text, boolean)';

  execute $fn$
    create or replace function public.fbmejl_satt_gruppnotiser(
      p_endpoint text, p_device text, p_pa boolean
    )
    returns jsonb
    language plpgsql security definer set search_path = public, pg_temp as $kropp$
    declare
      v_actor text;
      v_pa    boolean;
      v_n     int;
    begin
      v_actor := public.actor(p_device);

      update public.push_subscriptions s
         set gruppnotiser = coalesce(p_pa, false),
             updated_at = now()
       where s.endpoint = p_endpoint and s.device_id = v_actor
      returning s.gruppnotiser into v_pa;

      get diagnostics v_n = row_count;

      if v_n = 0 then
        -- Ingen rad matchade. Antingen finns prenumerationen inte, eller så
        -- tillhör den ett annat device_id än det anroparen kan visa upp.
        -- Skillnaden spelar ingen roll för appen: båda betyder "spara om
        -- prenumerationen och försök igen".
        return jsonb_build_object('ok', false, 'pa', false, 'rader', 0, 'skal', 'ingen-rad');
      end if;

      return jsonb_build_object('ok', true, 'pa', coalesce(v_pa, false), 'rader', v_n, 'skal', null);
    end $kropp$;
  $fn$;

  -- Läs tillbaka det sanna värdet. Det fanns ingen sådan väg tidigare, och
  -- därför läste appen sitt eget localStorage och kallade det för sanning.
  --
  -- Svaret:
  --   { "finns": true,  "pa": true|false, "aktiv": true|false }
  --   { "finns": false, "pa": false,      "aktiv": false }
  --
  -- aktiv = raden lever (enabled och under felgränsen). En prenumeration med
  -- gruppnotiser = true som pushtjänsten slutat svara på får ändå inga
  -- notiser, och det ska gå att se skillnad på det och ett avslaget reglage.
  execute $fn2$
    create or replace function public.fbmejl_har_gruppnotiser(
      p_endpoint text, p_device text
    )
    returns jsonb
    language plpgsql security definer stable set search_path = public, pg_temp as $kropp2$
    declare
      v_actor text;
      v_pa    boolean;
      v_aktiv boolean;
    begin
      v_actor := public.actor(p_device);

      select coalesce(s.gruppnotiser, false),
             (s.enabled and s.failures < 5)
        into v_pa, v_aktiv
        from public.push_subscriptions s
       where s.endpoint = p_endpoint and s.device_id = v_actor;

      if not found then
        return jsonb_build_object('finns', false, 'pa', false, 'aktiv', false);
      end if;

      return jsonb_build_object('finns', true, 'pa', v_pa, 'aktiv', coalesce(v_aktiv, false));
    end $kropp2$;
  $fn2$;

  execute 'revoke execute on function public.fbmejl_satt_gruppnotiser(text, text, boolean) from public';
  execute 'grant execute on function public.fbmejl_satt_gruppnotiser(text, text, boolean) to anon, authenticated';
  execute 'revoke execute on function public.fbmejl_har_gruppnotiser(text, text) from public';
  execute 'grant execute on function public.fbmejl_har_gruppnotiser(text, text) to anon, authenticated';
  raise notice 'fbmejl_satt_gruppnotiser() och fbmejl_har_gruppnotiser() finns — se docs/fbmejl.md.';
exception when others then
  raise notice 'Kunde inte skapa gruppnotis-funktionerna (%). Notiserna gar att sla pa med SQL anda.', sqlerrm;
end $$;

-- ============================ NOTISER: MOTTAGARE =====================
--
-- Edge-funktionen fbmejl-push hämtar sina mottagare härifrån. Bara de som
-- själva slagit på gruppnotiser, och bara de vars prenumeration lever.
--
-- Funktionen lämnar ut endpoint och auth-hemlighet i klartext — samma sak som
-- due_push_reminders gör, och därför samma skydd: service_role och ingenting
-- annat. Se rättighetsblocket längre ner.

-- Hur många har faktiskt slagit på gruppnotiser?
--
-- Egen funktion och inte en subselect i vyn, av ett trist men avgörande skäl:
-- push.sql behöver inte vara körd för att den här filen ska gå att köra. En
-- vy som nämner push_subscriptions direkt hade fått hela transaktionen att dö
-- på en tabell som inte finns, och då hade inte heller rapporterna kommit in.
-- Uppslagningen görs därför dynamiskt, och svarar 0 när tabellen saknas.
create or replace function public.fbmejl_gruppnotis_antal()
returns int
language plpgsql
security definer
stable
set search_path = public, pg_temp as $$
declare n int;
begin
  if to_regclass('public.push_subscriptions') is null then return 0; end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'push_subscriptions'
       and column_name = 'gruppnotiser'
  ) then return 0; end if;

  execute 'select count(*) from public.push_subscriptions where enabled and coalesce(gruppnotiser, false)'
    into n;
  return coalesce(n, 0);
end $$;

create or replace function public.fbmejl_push_mottagare(p_limit int default 2000)
returns table (endpoint text, p256dh text, auth text)
language plpgsql
security definer
stable
set search_path = public, pg_temp as $$
begin
  if to_regclass('public.push_subscriptions') is null then
    return;
  end if;
  return query
    select s.endpoint, s.p256dh, s.auth
      from public.push_subscriptions s
     where s.enabled
       and s.failures < 5
       and coalesce(s.gruppnotiser, false)
     limit greatest(1, least(coalesce(p_limit, 2000), 5000));
end $$;

-- ============================ NOTISER: UTSKICKET =====================
--
-- Anropas av fbmejl_ta_emot() när en omgång skapat minst en NY rapport.
-- Aldrig för dubbletter, aldrig för bortsorterade, och aldrig — under några
-- omständigheter — för nykterhets- eller drogkontroller.
--
-- Det sista är inte automatiskt bara för att de aldrig blir rapporter, och
-- det är värt att säga rakt ut: en notis som säger "något har hänt i gruppen"
-- efter en nykterhetskontroll VORE nykterhetsvarningen. Föraren behöver inte
-- veta var kontrollen står för att sakta ner och ta en annan väg — det räcker
-- att veta att det står något. Därför byggs notisen uteslutande av rader som
-- faktiskt blev rapporter, och p_nya innehåller bara dem.
--
-- @param p_nya  jsonb-array av {typ, plats, utrustning, created_at} för de
--               rapporter som faktiskt skapades. Aldrig råtext — se
--               avsnittet NOTISER: MENINGEN.
--
-- Anropet ut sker med pg_net, som är asynkront: net.http_post lägger sig i en
-- kö och returnerar direkt. Det betyder att en trög eller nere edge-funktion
-- ALDRIG kan hålla upp fbmejl_ta_emot och därmed rapporterna. Rapporten på
-- kartan är viktigare än notisen om den.
--
-- Priset för det är att funktionen INTE kan veta om notisen gick fram. Den
-- vet att pg_net tagit emot anropet, och den skriver 'koad' — inte 'skickad'.
-- Vad som sedan hände läses av fbmejl_notis_stam_av() ur net._http_response.
--
-- Två saker till skiljer den här versionen från den första:
--
--   1. Har ingen slagit på gruppnotiser skickas ingenting alls. Det är den
--      vanligaste anledningen till att en notiskedja ser frisk ut och inte
--      når fram, och den syntes inte förut: pg_net köade lydigt, edge-
--      funktionen svarade 200, loggen sa 'skickad', och noll telefoner
--      ringde. Nu står det 'ingen-mottagare' i loggen, och räknaren i
--      fbmejl_halsa.gruppnotis_mottagare säger varför.
--
--   2. Tillståndet (senaste_at, antal_idag, odelade = 0) skrivs FÖRST när
--      anropet är köat. Skrevs det före och köandet sedan misslyckades var
--      odelade nollställt utan att någon fått veta något — varningarna gick
--      tyst förlorade, vilket är precis vad odelade finns för att förhindra.

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
begin
  if p_nya is null or jsonb_typeof(p_nya) <> 'array' then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  v_antal := jsonb_array_length(p_nya);
  if v_antal = 0 then
    return jsonb_build_object('skickad', false, 'skal', 'inget');
  end if;

  -- Lyssnar någon?
  --
  -- Först av allt, och före spärrarna: har ingen slagit på gruppnotiser finns
  -- det inget att spärra. Tillståndet rörs INTE — varken senaste_at eller
  -- odelade. Att räkna upp odelade när ingen lyssnar hade betytt att den
  -- första som slår på notiser får "312 nya varningar i gruppen" som
  -- välkomsthälsning.
  v_mottagare := public.fbmejl_gruppnotis_antal();
  if coalesce(v_mottagare, 0) = 0 then
    insert into public.fbmejl_notis_logg (antal, utfall, skal)
    values (v_antal, 'ingen-mottagare', 'noll prenumeranter med gruppnotiser pa');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-mottagare',
                              'antal', v_antal, 'mottagare', 0);
  end if;

  v_timme := extract(hour from (v_lokal at time zone 'Europe/Stockholm'))::int;
  v_dag   := (v_lokal at time zone 'Europe/Stockholm')::date;

  select * into v_lage from public.fbmejl_notis_lage where id = 1 for update;

  -- Nytt dygn nollställer räknaren.
  if v_lage.dag is distinct from v_dag then
    v_lage.antal_idag := 0;
    v_lage.dag := v_dag;
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
    -- varningar som kommit sedan sist.
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal,
           dag = v_dag,
           antal_idag = v_lage.antal_idag,
           uppdaterad = now()
     where id = 1;

    insert into public.fbmejl_notis_logg (antal, utfall, skal)
    values (v_antal, 'sparrad', v_skal);

    return jsonb_build_object('skickad', false, 'skal', v_skal, 'antal', v_antal);
  end if;

  v_totalt := v_antal + coalesce(v_lage.odelade, 0);

  -- Rubrikerna, utan dubbletter, högst tre. Fler får inte plats i en notis
  -- och gör den svårare att läsa på en låsskärm i en bil.
  --
  -- Förut stod bara platsnamnen här — "Erikslund · E18 · Hälla". Tre platser
  -- utan att säga VAD som står där är tre frågor, inte tre besked. Nu står
  -- typen med, byggd av fbmejl_mening() precis som den enskilda notisen.
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
    -- Det är samma mening som js/sammanfattning.js visar i appen — se
    -- avsnittet NOTISER: MENINGEN ovan.
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
  -- spärr gör. Det är hela skillnaden mot den första versionen, där odelade
  -- nollställdes innan man visste om något ens gick att skicka.
  --
  -- Adressen och nyckeln läses genom KONFIGURATION ovan, inte längre direkt
  -- ur current_setting(). Den gamla vägen finns kvar som sista steg i
  -- ordningen, så en installation där alter database fungerar är oförändrad.
  -- Se resonemanget i det avsnittet.
  v_url    := public.fbmejl_installning('fbmejl_push_url');
  v_nyckel := public.fbmejl_anropsnyckel();

  if v_url is null or v_url = '' then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'fbmejl_push_url saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'fbmejl_push_url saknas');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-url', 'titel', v_titel);
  end if;

  -- Nyckeln, innan anropet och inte efter det.
  --
  -- Utan nyckel svarar fbmejl-push 401 på varje anrop — den godtar ingen tom
  -- sträng, med flit, för en tom nyckel som duger vore ett öppet API. Att
  -- skicka ändå kostar en omgång varningar och lägger en rad i loggen som
  -- ser ut som ett behörighetsfel fast det är ett konfigurationsfel. Här
  -- läggs varningarna tillbaka i odelade istället, och loggen säger vad som
  -- faktiskt saknas.
  if v_nyckel is null or v_nyckel = '' then
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'anropsnyckel saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'anropsnyckel saknas');
    return jsonb_build_object('skickad', false, 'skal', 'ingen-nyckel', 'titel', v_titel);
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
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = 'pg_net saknas', uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', 'pg_net saknas');
    return jsonb_build_object('skickad', false, 'skal', 'pg_net-saknas', 'titel', v_titel);
  end if;

  begin
    -- Id:t sparas. Det är den enda kopplingen mellan den här raden i loggen
    -- och pg_nets svar i net._http_response, och utan den går det inte att i
    -- efterhand svara på om notisen faktiskt togs emot av edge-funktionen.
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
        'antal', v_totalt
      )
    ) into v_net_id;
  exception when others then
    -- sqlerrm maskas innan den sparas. Nyckeln är ett ARGUMENT till
    -- net.http_post(), och Postgres skriver normalt inte ut argument i sina
    -- felmeddelanden — men "normalt" är inte "aldrig", och skillnaden syns
    -- först den dag det inträffar, i en tabell som redan följt med i varje
    -- backup. Maskningen kostar ingenting och stänger frågan. Se
    -- fbmejl_dolj_hemligheter() i avsnittet KONFIGURATION.
    v_fel := public.fbmejl_dolj_hemligheter(sqlerrm);
    update public.fbmejl_notis_lage
       set odelade = odelade + v_antal, dag = v_dag,
           antal_idag = v_lage.antal_idag,
           senaste_fel = left(v_fel, 500), uppdaterad = now()
     where id = 1;
    insert into public.fbmejl_notis_logg (antal, titel, text, utfall, skal)
    values (v_totalt, v_titel, v_text, 'fel', left(v_fel, 200));
    return jsonb_build_object('skickad', false, 'skal', 'fel', 'detalj', v_fel);
  end;

  -- Först här. Anropet ligger i pg_nets kö, glesspärren och dygnstaket får
  -- räknas upp, och odelade nollställs eftersom varningarna nu är med i den
  -- text som ligger på väg ut.
  update public.fbmejl_notis_lage
     set senaste_at = now(),
         antal_idag = v_lage.antal_idag + 1,
         dag = v_dag,
         odelade = 0,
         senaste_fel = null,
         uppdaterad = now()
   where id = 1;

  insert into public.fbmejl_notis_logg (antal, titel, text, utfall, net_id)
  values (v_totalt, v_titel, v_text, 'koad', v_net_id);

  -- 'koad', inte 'skickad', och nyckeln heter fortfarande skickad i svaret av
  -- bakåtkompatibilitet — men den betyder "köad hos pg_net", ingenting mer.
  -- Vad som hände sedan står i fbmejl_notis_stam_av().
  return jsonb_build_object('skickad', true, 'utfall', 'koad', 'antal', v_totalt,
                            'titel', v_titel, 'mottagare', v_mottagare,
                            'net_id', v_net_id);
end $$;

-- ============================ NOTISER: STÄM AV =======================
--
-- Vad hände med anropet?
--
-- pg_net kör anropet i en bakgrundsprocess och lägger svaret i tabellen
-- net._http_response, nycklad på det id som net.http_post() returnerade. Där
-- står status_code, svarskroppen, och error_msg om anropet aldrig gick fram.
-- Den tabellen städas av pg_net självt efter ett par timmar (net.ttl,
-- normalt sex), så avstämningen måste hinna före det.
--
-- Det här är det enda stället i hela kedjan där ordet "gick fram" kan sägas
-- med någon täckning alls. Och även här är täckningen begränsad, så det ska
-- sägas rakt ut: 2xx betyder att EDGE-FUNKTIONEN svarade, inte att en telefon
-- visade en notis. Edge-funktionen svarar 200 även när varenda push
-- misslyckades — precis som send-reminder gör, och av samma skäl. Därför
-- heter utfallet 'kvitterad' och inte 'levererad', och därför sparas
-- svarskroppen i skal: den bär edge-funktionens egen räkning av hur många
-- pushar som gick ut och hur många som föll.
--
-- Funktionen är byggd att kunna köras när som helst, hur ofta som helst, och
-- på en databas utan pg_net. Schemaläggs var femte minut längst ner i filen.

create or replace function public.fbmejl_notis_stam_av(p_max int default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  n_kvitterade int := 0;
  n_fel        int := 0;
  n_okanda     int := 0;
begin
  if to_regclass('net._http_response') is null then
    -- Inget pg_net, eller en version utan svarstabellen. Då finns ingenting
    -- att stämma av, och raderna får ligga kvar som 'koad'. Det är ett ärligt
    -- utfall: vi vet inte.
    return jsonb_build_object('pg_net', false, 'kvitterade', 0, 'fel', 0, 'okanda', 0);
  end if;

  -- Dynamiskt, för net-schemat finns inte när filen körs på en databas utan
  -- pg_net, och en direkt referens hade fått hela transaktionen att dö redan
  -- vid CREATE.
  --
  -- Två körningar istället för en med case: det enda sättet att få ut ETT
  -- ärligt tal per utfall. En enda update kan bara säga hur många rader den
  -- rörde, och "8 rader avstämda" svarar inte på frågan som ställdes, som är
  -- om notiserna gick fram.
  --
  -- Kolumnnamnen är pg_nets: id, status_code, content, timed_out, error_msg.
  --
  -- ---------------------------------------------------------------------
  -- Varför svarskroppen maskas innan den sparas
  --
  -- r.content är det som svarade på adressen i fbmejl_push_url. Är adressen
  -- rätt är det vår egen edge-funktion, och den svarar med fem tal och
  -- ingenting annat — läs sista returen i fbmejl-push/index.ts. Men adressen
  -- är en INSTÄLLNING. Pekar den fel gick bäraranropet till någon annans
  -- server, och en server som ekar tillbaka sina huvuden skriver då nyckeln
  -- rakt in i fbmejl_notis_logg.skal, i klartext, i en tabell som ligger i
  -- varje backup.
  --
  -- Maskningen sker FÖRE kapningen till 200 tecken. Görs den efter matchar en
  -- avhuggen nyckel ingen av mönstren, och det som blir kvar i loggen är en
  -- prefix av en riktig nyckel. Mellansteget på 4000 tecken finns bara för
  -- att slippa köra reguljära uttryck över hundra kilobyte HTML; en nyckel
  -- som börjar bortom tecken 4000 hamnar ändå utanför de 200 som sparas.
  --
  -- Se fbmejl_dolj_hemligheter() i avsnittet KONFIGURATION.

  execute format($q$
    update public.fbmejl_notis_logg l
       set utfall = 'kvitterad',
           skal   = left(public.fbmejl_dolj_hemligheter(
                      left('HTTP ' || r.status_code || ' ' || coalesce(r.content, ''), 4000)), 200)
      from net._http_response r
     where r.id = l.net_id
       and l.utfall = 'koad'
       and r.error_msg is null
       and coalesce(r.timed_out, false) = false
       and r.status_code between 200 and 299
       and l.skickat_at > now() - interval '7 hours'
       and l.id in (select id from public.fbmejl_notis_logg
                     where utfall = 'koad' and net_id is not null
                     order by skickat_at desc limit %s)
  $q$, greatest(1, least(coalesce(p_max, 500), 5000)));
  get diagnostics n_kvitterade = row_count;

  execute format($q$
    update public.fbmejl_notis_logg l
       set utfall = 'fel',
           skal   = case
                      when r.error_msg is not null
                        then left(public.fbmejl_dolj_hemligheter(left(r.error_msg, 4000)), 200)
                      when coalesce(r.timed_out, false) then 'tidsgrans'
                      else left(public.fbmejl_dolj_hemligheter(
                             left('HTTP ' || r.status_code || ' ' || coalesce(r.content, ''), 4000)), 200)
                    end
      from net._http_response r
     where r.id = l.net_id
       and l.utfall = 'koad'
       and (r.error_msg is not null
            or coalesce(r.timed_out, false)
            or r.status_code is null
            or r.status_code not between 200 and 299)
       and l.skickat_at > now() - interval '7 hours'
       and l.id in (select id from public.fbmejl_notis_logg
                     where utfall = 'koad' and net_id is not null
                     order by skickat_at desc limit %s)
  $q$, greatest(1, least(coalesce(p_max, 500), 5000)));
  get diagnostics n_fel = row_count;

  -- Svaret hann städas bort av pg_net innan vi kom hit. Raden blir 'okand' —
  -- inte 'kvitterad'. Att gissa åt det hållet vore samma lögn som förut.
  update public.fbmejl_notis_logg
     set utfall = 'okand',
         skal = coalesce(skal, 'pg_net hade redan stadat bort svaret')
   where utfall = 'koad'
     and net_id is not null
     and skickat_at < now() - interval '6 hours';
  get diagnostics n_okanda = row_count;

  -- Senaste kända felet upp i lägestabellen, så fbmejl_halsa kan visa det.
  update public.fbmejl_notis_lage n
     set senaste_fel = (select left(l.skal, 500) from public.fbmejl_notis_logg l
                         where l.utfall = 'fel'
                           and l.skickat_at > now() - interval '24 hours'
                         order by l.skickat_at desc limit 1),
         uppdaterad = now()
   where n.id = 1
     and exists (select 1 from public.fbmejl_notis_logg l
                  where l.utfall = 'fel' and l.skickat_at > now() - interval '24 hours');

  return jsonb_build_object('pg_net', true, 'kvitterade', n_kvitterade,
                            'fel', n_fel, 'okanda', n_okanda);
end $$;

-- ============================ POLLAREN LÄGGER IN =====================
--
-- Anropas av tools/fbmejl-hamta.ps1 med en json-array av råa mejl:
--
--   [{ "message_id": "<...@facebookmail.com>", "from": "...", "subject": "...",
--      "body": "...", "date": "2026-08-20T12:00:00Z", "uid": 4711 }]
--
-- Idempotent på Message-ID: samma mejl inlagt två gånger ger en rad.
--
-- Nykterhetsnätet körs redan HÄR, innan tolkaren ens sett mejlet. Raden
-- sparas men markeras 'vagrad' och plockas aldrig upp av fbmejl_ko_hamta().
-- Det är tredje gången samma regel körs på samma text (js/fbmejl.js kör den
-- två gånger före parsern), och det är med flit — den enda regeln i appen som
-- får kosta överdriven försiktighet är den här.

create or replace function public.fbmejl_ko_in(p_mejl jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_rad       jsonb;
  v_id        text;
  v_text      text;
  v_skrivna   int;
  v_mottagna  int := 0;
  v_nya       int := 0;
  v_dubbletter int := 0;
  v_vagrade   int := 0;
  v_ogiltiga  int := 0;
  v_max_uid   bigint := 0;
  v_uid       bigint;
begin
  if p_mejl is null or jsonb_typeof(p_mejl) <> 'array' then
    return jsonb_build_object('fel', 'p_mejl maste vara en json-array');
  end if;

  for v_rad in select * from jsonb_array_elements(p_mejl) loop
    v_mottagna := v_mottagna + 1;

    -- KANONISK FORM redan här. Pollaren läser Message-ID rått ur IMAP-huvudet,
    -- alltså med vinkelparenteser: <ABC@facebookmail.com>. Tolkaren skickar
    -- tillbaka den normaliserade formen. Lagras den råa formen träffar varje
    -- senare uppslag noll rader och kön töms aldrig. Se avsnittet
    -- MESSAGE-ID: EN FORM längst upp.
    v_id := public.fbmejl_normalisera_msgid(v_rad->>'message_id');

    -- Utan Message-ID finns ingen avdubbling, och då blir samma mejl en ny
    -- varning vid varje pollning. Raden avvisas hellre än skrivs.
    if v_id is null then
      v_ogiltiga := v_ogiltiga + 1;
      continue;
    end if;

    v_uid := nullif(v_rad->>'uid', '')::bigint;
    if v_uid is not null and v_uid > v_max_uid then v_max_uid := v_uid; end if;

    v_text := coalesce(v_rad->>'subject', '') || ' ' || coalesce(v_rad->>'body', '');

    insert into public.fbmejl_ko
      (message_id, avsandare, amne, brodtext, skickat_at, imap_uid, status, skal, avgjort_at)
    values (
      -- Redan kapad till 200 av fbmejl_normalisera_msgid(), samma gräns som
      -- normaliseraMessageId() i js/fbmejl.js. Kapas den om här kan de två
      -- glida isär.
      v_id,
      left(coalesce(v_rad->>'from', ''), 200),
      left(public.fbmejl_sanera(coalesce(v_rad->>'subject', '')), 1000),
      -- Brödtexten kapas. Ett Facebook-mejl i HTML kan vara hundra kilobyte
      -- boilerplate, och inlägget står alltid i början. Skrubbas först — se
      -- avsnittet INTEGRITET ovan.
      left(public.fbmejl_sanera(coalesce(v_rad->>'body', '')), 20000),
      nullif(v_rad->>'date', '')::timestamptz,
      v_uid,
      case when public.fbmejl_ar_nykterhetskontroll(v_text) then 'vagrad' else 'ny' end,
      case when public.fbmejl_ar_nykterhetskontroll(v_text) then 'nykterhet' else null end,
      case when public.fbmejl_ar_nykterhetskontroll(v_text) then now() else null end
    )
    on conflict (message_id) do nothing;

    get diagnostics v_skrivna = row_count;

    if v_skrivna = 0 then
      v_dubbletter := v_dubbletter + 1;
    elsif public.fbmejl_ar_nykterhetskontroll(v_text) then
      v_vagrade := v_vagrade + 1;
    else
      v_nya := v_nya + 1;
    end if;
  end loop;

  update public.fbmejl_brygga
     set senast_kord = now(), senaste_fel = null, uppdaterad = now()
   where id = 1;

  return jsonb_build_object(
    'mottagna',   v_mottagna,
    'nya',        v_nya,
    'dubbletter', v_dubbletter,
    'vagrade',    v_vagrade,
    'ogiltiga',   v_ogiltiga,
    'max_uid',    v_max_uid
  );
end $$;

-- ============================ TOLKAREN HÄMTAR ========================
--
-- Ger det som ligger olöst i kön, äldst först. Äldst först med flit: en
-- varning som håller på att bli för gammal ska hinna ut innan den dör, och
-- js/fbmejl.js kastar den ändå om den hunnit löpa ut.
--
-- forsok räknas upp här, inte när svaret kommer. Ett mejl som får tolkaren
-- att krascha ska inte kunna spelas om i evighet och blockera allt efter sig
-- — efter fem försök plockas det inte upp igen.

create or replace function public.fbmejl_ko_hamta(p_antal int default 25)
returns table (
  message_id text,
  avsandare  text,
  amne       text,
  brodtext   text,
  skickat_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp as $$
-- returns table(...) skapar variabler som heter EXAKT som kolumnerna nedan.
-- Utan den här raden riskerar varje okvalificerad kolumnreferens att bli
-- "column reference is ambiguous" — ett fel som bara syns vid körning, alltså
-- när kön ska tömmas och ingen tittar.
#variable_conflict use_column
begin
  return query
  update public.fbmejl_ko k
     set forsok = k.forsok + 1
   where k.message_id in (
     select k2.message_id from public.fbmejl_ko k2
      where k2.status = 'ny' and k2.forsok < 5
      order by coalesce(k2.skickat_at, k2.hamtat_at) asc
      limit greatest(1, least(coalesce(p_antal, 25), 200))
   )
  returning k.message_id, k.avsandare, k.amne, k.brodtext, k.skickat_at;
end $$;

-- ============================ TA EMOT ================================
--
-- Anropas av tolkaren med en json-array av färdigtolkade rader. Varje rad är
-- det js/fbmejl.js byggRapport() lämnar ifrån sig, plus text_nyckel för
-- avdubblingen och message_id/inlaggs_id för revisionen.
--
-- Funktionen är security definer eftersom den skriver till reports förbi
-- radsäkerheten (det finns ingen insert-policy som tillåter external_id från
-- en tredje part). Den är därför också åtkomstskyddad hårt längre ner: bara
-- service_role får anropa den. Ingen anon-nyckel i världen ska kunna lägga
-- rapporter i gruppens namn.
--
-- ---------------------------------------------------------------------
-- DEN ENDA VÄGEN IN. Gäller också bryggan.
--
-- Facebook-bryggan skrev tidigare rakt in i reports över PostgREST. Rapporten
-- hamnade på kartan och telefonen var tyst, för allt som får en telefon att
-- ringa sitter i fbmejl_notis_ut(), som bara anropas härifrån. Bryggan gick
-- alltså förbi avdubblingen, nykterhetsnätet, takten och notisen på en gång.
--
-- Två utvägar övervägdes, och valet står här för att det inte ska behöva
-- fattas om:
--
--   1. Anroparen anropar den HÄR funktionen i stället för att skriva rått.
--      Hela den testade kedjan återanvänds, och det finns fortfarande bara
--      en väg från "någon skrev i gruppen" till "en telefon ringer". Priset
--      är att anroparen måste bära service_role-nyckeln. Det går för en
--      daemon på ägarens egen maskin (nyckeln i en gitignorerad fil, precis
--      som IMAP-lösenordet redan ligger), men INTE för ett userscript inne på
--      facebook.com — en servernyckel i en sida Meta kontrollerar är samma
--      sak som ingen nyckel alls.
--
--   2. En trigger på reports som anropar notisen. Lockande för att den fångar
--      varje väg in automatiskt, men den faller på tre saker. Den ser en rad
--      i taget: daemonen gör en HTTP-insert per inlägg, alltså en notis per
--      rapport, och buntspärren finns just för att det aldrig får hända. Att
--      bunta i stället kräver en kötabell och ett cron-jobb, alltså en ANDRA
--      notisväg med egen timing som glider från den här. Och den skulle
--      behöva köra nykterhetsnätet på rader appens egna knappar och rösten
--      skapat — ett nät som är MEDVETET bredare än parsern och som därför
--      skulle börja avvisa förares egna rapporter.
--
-- Alternativ 1 gäller. Kontraktet för en brygga är:
--
--   ETT anrop per svep, med alla nya rader i samma array. Inte ett anrop per
--   rad. Buntspärren i fbmejl_notis_ut() ger EN notis per anrop, och fyra
--   anrop i rad ger en notis plus tre rader i odelade — alltså tre varningar
--   som inte hörs förrän tio minuter senare. Kedjan går inte sönder av det,
--   men den blir sämre, och det syns ingenstans.
--
-- Raderna får se ut precis som en reports-rad: id, type, lat, lon, label,
-- note, device_id, external_id, created_at, expires_at. source sätts här och
-- går inte att skicka med. Skickar anroparen dessutom text_nyckel (och
-- text_nyckel_grannar) fungerar den korsvisa avdubblingen mot mejlvägen och
-- Telegram-spegeln, så att samma inlägg som kommer två vägar blir EN nål.
-- Nyckeln räknas fram likadant överallt: se nycklarFor() i js/fbmejl.js.
--
-- Svaret bär 'skapade' — antalet rader som blev nya rapporter — och 'notis'
-- med utfallet från fbmejl_notis_ut(). En brygga som loggar de två talen
-- märker samma dag om notiskedjan slutar fungera. Det gjorde ingen förut.

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

-- ============================ AVGJORT UTAN RAPPORT ===================
--
-- Tolkaren kastar de flesta mejl: frågor, skvaller, kommentarsnotiser,
-- buntade sammanfattningar. De måste ändå markeras, annars plockas de upp
-- igen vid nästa tömning tills forsok slår i taket.
--
-- p_skal är fritext från js/fbmejl.js SKAL-listan.

create or replace function public.fbmejl_ko_avfard(p_message_ids jsonb, p_skal text default 'bortsorterad')
returns int
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare n int;
begin
  if p_message_ids is null or jsonb_typeof(p_message_ids) <> 'array' then
    return 0;
  end if;

  -- Genom normaliseringen, samma som i fbmejl_ta_emot(). Tolkaren skickar
  -- tillbaka den normaliserade formen, men den som anropar den här funktionen
  -- har ibland kvar den råa listan från kön i handen. Båda ska fungera —
  -- annars är det just den här funktionen som slutar tömma kön, och det syns
  -- inte förrän raderna dyker upp som "fastnade" i fbmejl_halsa.
  update public.fbmejl_ko
     set status = case when p_skal = 'nykterhet' or p_skal = 'kamera' then 'vagrad' else 'klar' end,
         skal = left(coalesce(p_skal, 'bortsorterad'), 60),
         avgjort_at = now()
   where message_id in (
           select public.fbmejl_normalisera_msgid(t.rad)
             from jsonb_array_elements_text(p_message_ids) as t(rad)
            where public.fbmejl_normalisera_msgid(t.rad) is not null)
     and status = 'ny';

  get diagnostics n = row_count;
  return n;
end $$;

-- ============================ POLLNINGENS LÄGE =======================

create or replace function public.fbmejl_lage()
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'uidvalidity', coalesce(max(uidvalidity), 0),
    'senaste_uid', coalesce(max(senaste_uid), 0)
  )
  from public.fbmejl_brygga where id = 1;
$$;

create or replace function public.fbmejl_satt_lage(
  p_uidvalidity bigint,
  p_uid bigint,
  p_fel text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare v_nuvarande bigint;
begin
  select uidvalidity into v_nuvarande from public.fbmejl_brygga where id = 1;

  if coalesce(p_uidvalidity, 0) <> 0 and coalesce(v_nuvarande, 0) <> coalesce(p_uidvalidity, 0) then
    -- Postlådan har byggts om. UID börjar om från ett, och ett gammalt sparat
    -- UID skulle hoppa över allt nytt för alltid. Nollställ hellre och läs om
    -- en omgång — dubbletter stoppas av avdubblingen, missade varningar av
    -- ingenting.
    update public.fbmejl_brygga
       set uidvalidity = p_uidvalidity,
           senaste_uid = coalesce(p_uid, 0),
           senast_kord = now(),
           senaste_fel = left(p_fel, 500),
           uppdaterad = now()
     where id = 1;
    return;
  end if;

  -- greatest() med flit: UID får bara gå framåt inom samma UIDVALIDITY. Ett
  -- svar som kommer i fel ordning ska aldrig kunna backa kön och läsa om
  -- gamla mejl som redan är avgjorda.
  update public.fbmejl_brygga
     set uidvalidity = greatest(uidvalidity, coalesce(p_uidvalidity, 0)),
         senaste_uid = greatest(senaste_uid, coalesce(p_uid, 0)),
         senast_kord = now(),
         senaste_fel = left(p_fel, 500),
         uppdaterad = now()
   where id = 1;
end $$;

-- ============================ STÄDNING ===============================
--
-- Kön städas efter sju dagar: den innehåller andra människors text ordagrant
-- och ska inte ligga kvar längre än den behövs. Minnet städas efter fjorton —
-- efter det är inläggen sedan länge borta ur gruppen, och
-- reports_external_id_key är sista spärren ändå.

create or replace function public.stada_fbmejl()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare n_ko int; n_lasta int; n_logg int;
begin
  delete from public.fbmejl_ko where hamtat_at < now() - interval '7 days';
  get diagnostics n_ko = row_count;

  delete from public.fbmejl_lasta where last_at < now() - interval '14 days';
  get diagnostics n_lasta = row_count;

  -- Notisloggen är bara till för felsökning. Trettio dagar räcker för att
  -- kunna svara på "varför ringde det inte i fredags".
  delete from public.fbmejl_notis_logg where skickat_at < now() - interval '30 days';
  get diagnostics n_logg = row_count;

  return jsonb_build_object('ko', n_ko, 'lasta', n_lasta, 'notislogg', n_logg);
end $$;

-- ============================ RÄTTIGHETER ============================
--
-- Ingenting här får gå att anropa med anon-nyckeln. fbmejl_ta_emot skriver
-- förbi radsäkerheten; kunde vem som helst anropa den vore hela insert-
-- policyn i schema.sql meningslös — man skulle kunna lägga ut vad som helst
-- i gruppens namn, med valfri position och valfri livslängd.
--
-- fbmejl_ko_hamta är lika känslig åt andra hållet: den returnerar hela
-- brödtexten ur andra människors inlägg.

revoke execute on function public.fbmejl_ko_in(jsonb)                     from public, anon, authenticated;
revoke execute on function public.fbmejl_ko_hamta(int)                    from public, anon, authenticated;
revoke execute on function public.fbmejl_ko_avfard(jsonb, text)           from public, anon, authenticated;
revoke execute on function public.fbmejl_ta_emot(jsonb)                   from public, anon, authenticated;
revoke execute on function public.fbmejl_lage()                           from public, anon, authenticated;
revoke execute on function public.fbmejl_satt_lage(bigint, bigint, text)  from public, anon, authenticated;
revoke execute on function public.stada_fbmejl()                          from public, anon, authenticated;
revoke execute on function public.fbmejl_push_mottagare(int)              from public, anon, authenticated;
revoke execute on function public.fbmejl_notis_stam_av(int)               from public, anon, authenticated;
revoke execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                          from public, anon, authenticated;

grant execute on function public.fbmejl_ko_in(jsonb)                      to service_role;
grant execute on function public.fbmejl_ko_hamta(int)                     to service_role;
grant execute on function public.fbmejl_ko_avfard(jsonb, text)            to service_role;
grant execute on function public.fbmejl_ta_emot(jsonb)                    to service_role;
grant execute on function public.fbmejl_lage()                            to service_role;
grant execute on function public.fbmejl_satt_lage(bigint, bigint, text)   to service_role;
grant execute on function public.stada_fbmejl()                           to service_role;
grant execute on function public.fbmejl_push_mottagare(int)               to service_role;
grant execute on function public.fbmejl_notis_stam_av(int)                to service_role;
grant execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                          to service_role;

-- Typnamnet avslöjar ingenting och är en ren uppslagning. Detsamma gäller
-- normaliseringen — den är ren textbehandling och bekväm att kunna prova.
grant execute on function public.fbmejl_typnamn(text)                     to anon, authenticated, service_role;
grant execute on function public.fbmejl_sanera(text)                      to anon, authenticated, service_role;
grant execute on function public.fbmejl_normalisera_msgid(text)           to anon, authenticated, service_role;

-- Meningsbyggarna är ren textbehandling utan en enda uppslagning mot en
-- tabell. De tar det anroparen skickar in och lämnar tillbaka en sträng.
-- Samma resonemang som för fbmejl_typnamn: de avslöjar ingenting, och de ska
-- gå att prova i editorn och i fbmejl-test.html utan servernyckel — annars
-- provas de inte, och då glider de från js/sammanfattning.js.
grant execute on function public.fbmejl_utrustning(text)                  to anon, authenticated, service_role;
grant execute on function public.fbmejl_typtext(text, text)               to anon, authenticated, service_role;
grant execute on function public.fbmejl_platsfras(text)                   to anon, authenticated, service_role;
grant execute on function public.fbmejl_mening(text, text, text, bigint)  to anon, authenticated, service_role;

revoke execute on function public.fbmejl_gruppnotis_antal()               from public, anon, authenticated;
grant  execute on function public.fbmejl_gruppnotis_antal()               to service_role;

-- ---------------------------------------------------------------------
-- KONFIGURATIONEN
--
-- Läsarna av hemligheter är indragna från ALLT, service_role inräknat. Det
-- är inte en artighet mot service_role, som ändå kan det mesta — det är att
-- den enda anroparen som behöver dem är fbmejl_notis_ut(), som är security
-- definer och ägs av samma roll som funktionerna. Ett internt anrop i en
-- security definer-funktion prövas mot ÄGAREN, inte mot den som anropade
-- yttersta funktionen. Kedjan går alltså igenom utan att en enda roll
-- utanför databasen har fått rätten att läsa nyckeln.
--
-- En hemlighet som anon kan läsa är ingen hemlighet. Beviset står i
-- kontrollfråga 12 längst ner: den byter roll till anon på riktigt och
-- kräver att anropet nekas.
revoke all on function public.fbmejl_valv_las(text)                       from public, anon, authenticated, service_role;
revoke all on function public.fbmejl_kalla(text, boolean)                 from public, anon, authenticated, service_role;
revoke all on function public.fbmejl_hemlighet(text)                      from public, anon, authenticated, service_role;
revoke all on function public.fbmejl_anropsnyckel()                       from public, anon, authenticated, service_role;

-- Det icke-hemliga. Adressen får läsas och sättas av service_role, och
-- konfigurationsstatusen får hämtas — den innehåller aldrig ett hemligt
-- värde, bara form, längd och varifrån värdet kom. anon och authenticated
-- får ingenting av det heller: adressen säger vilken edge-funktion som är
-- notiskedjans, och det är onödig hjälp åt någon som letar efter den.
revoke all on function public.fbmejl_installning(text)                    from public, anon, authenticated;
revoke all on function public.fbmejl_satt_installning(text, text)         from public, anon, authenticated;
revoke all on function public.fbmejl_dolj_hemligheter(text)               from public, anon, authenticated;
revoke all on function public.fbmejl_notis_konfig()                       from public, anon, authenticated;

grant execute on function public.fbmejl_installning(text)                 to service_role;
grant execute on function public.fbmejl_satt_installning(text, text)      to service_role;
grant execute on function public.fbmejl_dolj_hemligheter(text)            to service_role;
grant execute on function public.fbmejl_notis_konfig()                    to service_role;

-- Nätet får läsas av alla — det avslöjar ingenting och är bekvämt att kunna
-- prova i editorn.
grant execute on function public.fbmejl_ar_nykterhetskontroll(text)       to anon, authenticated, service_role;

-- ============================ REVISIONSVYER ==========================
--
-- Läses i SQL-editorn, inte av appen. Kolumnen note innehåller andra
-- människors text ordagrant och ska inte gå att hämta med den publika
-- nyckeln. Samma resonemang som i facebook.sql och telegram.sql.
--
-- Det räcker INTE att låta bli att skriva ett grant. Supabase kör med
-- "alter default privileges ... grant select on tables to anon" i public,
-- alltså får anon SELECT på varje ny vy som skapas här — utan att någon rad
-- i den här filen ber om det. Kommentaren som tidigare stod här påstod
-- motsatsen, och det var fel.
--
-- Vyerna är visserligen security_invoker = on, så radsäkerheten på de
-- underliggande tabellerna gäller fortfarande och fbmejl_ko/fbmejl_lasta/
-- fbmejl_brygga har noll policyer. Inget nytt läcker alltså i praktiken. Men
-- "det läcker inte för att en annan spärr råkar hålla" är inte samma sak som
-- "det går inte att komma åt", och skillnaden är exakt den som gör att en
-- framtida policy på reports tyst öppnar en dörr ingen visste fanns.
--
-- Alltså: uttryckligt revoke efter varje create, och nu stämmer kommentaren.
-- (revoke måste stå EFTER create or replace view — den vyn finns inte att
-- återkalla rättigheter på innan den är skapad.)

-- drop före create, inte "create or replace". Den senare vägrar byta namn på
-- en befintlig kolumn ("cannot change name of view column"), och kolumnerna i
-- fbmejl_halsa nedan har bytt namn: notiser_dygn räknade ett värde som ljög.
-- Vyerna innehåller ingen data — de är frågor — så en drop kostar ingenting.
drop view if exists public.fbmejl_senaste;
drop view if exists public.fbmejl_halsa;
drop view if exists public.fbmejl_notiskedjan;

create view public.fbmejl_senaste
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
  where r.device_id = 'fb-mejl'
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 24 * 3600 * 1000
  order by r.created_at desc;

revoke all on public.fbmejl_senaste from anon, authenticated;
grant select on public.fbmejl_senaste to service_role;

-- Går bryggan alls? Den vanligaste frågan efter en vecka i drift, och den
-- går inte att besvara från appen — där ser "inga rapporter" och "bryggan är
-- död" exakt likadant ut.
--
-- Tre tal är de som betyder något:
--   minuter_sedan_koring  hög = pollaren går inte. Datorn sover, eller
--                         schemat är borta.
--   liggande_i_ko         hög = mejlen kommer in men INGEN TOLKAR DEM. Det är
--                         felet den här modellen är känsligast för.
--   fastnade              mejl som fått fem försök och gett upp. Här ligger
--                         formatfelen: kolla dem i fbmejl_ko med brödtexten.

create view public.fbmejl_halsa
with (security_invoker = on) as
  select
    b.uidvalidity,
    b.senaste_uid,
    b.senast_kord,
    b.senaste_fel,
    round(extract(epoch from now() - b.senast_kord) / 60.0)      as minuter_sedan_koring,
    (select count(*) from public.fbmejl_ko
      where status = 'ny' and forsok < 5)                        as liggande_i_ko,
    (select count(*) from public.fbmejl_ko
      where status = 'ny' and forsok >= 5)                       as fastnade,
    (select count(*) from public.fbmejl_ko
      where hamtat_at > now() - interval '24 hours')             as mejl_dygn,
    (select count(*) from public.fbmejl_lasta
      where utfall = 'rapport' and last_at > now() - interval '24 hours') as rapporter_dygn,
    (select count(*) from public.fbmejl_lasta
      where utfall = 'vagrad'  and last_at > now() - interval '24 hours') as vagrade_dygn,
    (select count(*) from public.reports
      where device_id = 'fb-mejl' and denials > 0
        and created_at > (extract(epoch from now()) * 1000)::bigint - 7 * 24 * 3600 * 1000)
                                                                 as nedrostade_veckan,
    -- Notiskedjan. Talen skiljer "det ringde inte för att det inte hänt
    -- något" från "det ringde inte för att kedjan är trasig". Det gjorde de
    -- INTE tidigare: kolumnen hette notiser_dygn och räknade utfall
    -- 'skickad', ett värde som skrevs direkt efter net.http_post() och alltså
    -- var sant även när nyckeln var fel, funktionen inte var utrullad, eller
    -- noll människor hade slagit på gruppnotiser. Hälsovyn lyste grönt medan
    -- ingenting nådde fram.
    --
    --   notiser_kvitterade_dygn  edge-funktionen svarade 2xx. Så nära "gick
    --                            fram" som databasen kan komma — den vet inte
    --                            om en telefon visade något.
    --   notiser_koade_dygn       hos pg_net, svar ännu inte avläst. Står talet
    --                            still och kvitterade är noll: kör
    --                            fbmejl_notis_stam_av(), eller så är den inte
    --                            schemalagd.
    --   ingen_mottagare_dygn     omgångar där noll prenumeranter hade
    --                            gruppnotiser på. Inget skickades, och det är
    --                            inte ett fel — men det är svaret på "varför
    --                            ringde det aldrig".
    --   sparrade_dygn            spärrarna gör sitt jobb. Högt tal = livlig grupp.
    --   notis_fel                ingen url, ingen pg_net, eller ett svar som
    --                            inte gick fram.
    --   notis_okand_dygn         pg_net hann städa bort svaret först. Vet inte.
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'kvitterad' and skickat_at > now() - interval '24 hours') as notiser_kvitterade_dygn,
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'koad' and skickat_at > now() - interval '24 hours')      as notiser_koade_dygn,
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'ingen-mottagare'
        and skickat_at > now() - interval '24 hours')                          as ingen_mottagare_dygn,
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'sparrad' and skickat_at > now() - interval '24 hours')   as sparrade_dygn,
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'fel'     and skickat_at > now() - interval '24 hours')   as notis_fel,
    (select count(*) from public.fbmejl_notis_logg
      where utfall = 'okand'   and skickat_at > now() - interval '24 hours')   as notis_okand_dygn,
    (select n.senaste_fel from public.fbmejl_notis_lage n where n.id = 1)      as notis_senaste_fel,
    (select n.odelade     from public.fbmejl_notis_lage n where n.id = 1)      as odelade_varningar,
    public.fbmejl_gruppnotis_antal()                                           as gruppnotis_mottagare
  from public.fbmejl_brygga b
  where b.id = 1;

revoke all on public.fbmejl_halsa from anon, authenticated;
grant select on public.fbmejl_halsa to service_role;

-- ============================ GICK RAPPORTEN FÖRBI? ==================
--
-- Den här vyn finns för ETT fel, och det felet har redan inträffat.
--
-- Facebook-bryggan (tools/fb-bridge.user.js och tools/brygg-daemon.ps1)
-- skrev rakt in i reports över PostgREST. Rapporten hamnade på kartan, allt
-- såg friskt ut, och telefonen var tyst — för notismaskineriet sitter i
-- fbmejl_notis_ut(), som bara anropas från fbmejl_ta_emot(). Bryggan gick
-- förbi hela stycket: avdubblingen, nykterhetsnätet, takten och notisen.
--
-- Ingen befintlig vy kunde svara på det. fbmejl_halsa räknar mejlkön, och
-- kön var frisk — det var en helt annan väg in som var trasig.
--
-- Signalen är enkel och svår att luras av: varje rad som gått genom
-- fbmejl_ta_emot() har ett minne i fbmejl_lasta med nyckel = external_id.
-- En rapport från en Facebook-väg UTAN ett sådant minne har alltså kommit in
-- vid sidan av notiskedjan.
--
--   forbi_notiskedjan > 0   någon skriver fortfarande direkt till reports.
--                           Det är felet. Se docs/notiskedjan.md.
--   genom_notiskedjan       rader som gick rätt väg. Att de fick en notis är
--                           en annan fråga — den besvaras av fbmejl_halsa.
--
-- Vyn säger INTE att en notis nådde en telefon. Den säger bara att raden ens
-- var i närheten av maskineriet. Det är ett lägre krav, och det är med flit:
-- den ska kunna svara "nej" också när allt annat är trasigt.

create view public.fbmejl_notiskedjan
with (security_invoker = on) as
  select
    r.device_id                                            as vag,
    count(*)                                               as rapporter_dygn,
    count(*) filter (where l.nyckel is not null)           as genom_notiskedjan,
    count(*) filter (where l.nyckel is null)               as forbi_notiskedjan,
    max(to_char(to_timestamp(r.created_at / 1000.0) at time zone 'Europe/Stockholm',
                'YYYY-MM-DD HH24:MI'))                     as senaste,
    case
      when count(*) filter (where l.nyckel is null) > 0
        then 'SKRIVER FÖRBI — ingen notis går ut för de raderna'
      else 'går genom fbmejl_ta_emot'
    end                                                    as omdome
  from public.reports r
  left join public.fbmejl_lasta l on l.nyckel = r.external_id
  where r.device_id in ('fb-mejl', 'fb-bridge', 'fb-daemon')
    and r.created_at > (extract(epoch from now()) * 1000)::bigint - 24 * 3600 * 1000
  group by r.device_id
  order by r.device_id;

revoke all on public.fbmejl_notiskedjan from anon, authenticated;
grant select on public.fbmejl_notiskedjan to service_role;

commit;

-- ============================ SCHEMALÄGGNING =========================
--
-- Två jobb, och bara det ena bor i databasen.
--
-- 1. Städningen. Ren SQL, schemaläggs direkt här nedan om pg_cron finns.
--
-- 2. Tömningen av kön. Den måste köra JavaScript (js/fbmejl.js) och ut på
--    nätet till geokodningen, och kan alltså inte vara ren SQL. Den kör i en
--    edge-funktion (fbmejl-tom), som anropas antingen från Dashboard ->
--    Edge Functions -> Schedules eller från pg_cron via pg_net.
--    Se docs/fbmejl.md.
--
-- Pollningen av postlådan schemaläggs INTE här. Den kör på ägarens Windows-
-- maskin via Uppgiftsschemaläggaren, för IMAP-lösenordet ska inte finnas i
-- molnet. Se docs/fbmejl.md.

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — kör "select public.stada_fbmejl();" manuellt då och då.';
    return;
  end if;
  perform 1 from cron.job where jobname = 'polisvakt-fbmejl-stada';
  if found then perform cron.unschedule('polisvakt-fbmejl-stada'); end if;
  perform cron.schedule('polisvakt-fbmejl-stada', '55 4 * * *',
                        'select public.stada_fbmejl();');
  raise notice 'Städning av fbmejl_ko och fbmejl_lasta schemalagd 04:55 varje natt.';
exception when others then
  raise notice 'Kunde inte schemalägga städningen (%). Kör funktionen manuellt då och då.', sqlerrm;
end $$;

-- Avstämningen av notisloggen. Utan den står varje rad kvar som 'koad' och
-- fbmejl_halsa kan inte svara på om notiserna gick fram — bara på att de
-- lämnades över till pg_net, vilket är precis den halvsanning som hela
-- omskrivningen av fbmejl_notis_ut() handlar om att bli av med.
--
-- Var femte minut. Tätare behövs inte: pg_net kör anropet inom sekunder, och
-- svaret ligger kvar i net._http_response i ett par timmar. Glesare än en
-- timme är däremot farligt — då hinner pg_net städa bort svaret och varje rad
-- blir 'okand'.
--
-- Går det inte att schemalägga är det ingen katastrof: kör
-- "select public.fbmejl_notis_stam_av();" när du vill veta.

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — kör "select public.fbmejl_notis_stam_av();" manuellt för att stämma av notisloggen.';
    return;
  end if;
  perform 1 from cron.job where jobname = 'polisvakt-fbmejl-notisavstamning';
  if found then perform cron.unschedule('polisvakt-fbmejl-notisavstamning'); end if;
  -- Minutlistan är utskriven med flit istället för det korta uttrycket med
  -- stjärna-snedstreck-fem. Den formen innehåller tecknen som avslutar en
  -- blockkommentar, och den kombinationen har redan dödat en körning i det
  -- här projektet en gång — se varningen längst upp i filen. Filen har inga
  -- blockkommentarer idag, men den dagen någon lägger till en ska den här
  -- raden inte vara den som spränger.
  perform cron.schedule('polisvakt-fbmejl-notisavstamning',
                        '0,5,10,15,20,25,30,35,40,45,50,55 * * * *',
                        'select public.fbmejl_notis_stam_av();');
  raise notice 'Avstämning av notisloggen schemalagd var femte minut.';
exception when others then
  raise notice 'Kunde inte schemalägga notisavstämningen (%). Kör fbmejl_notis_stam_av() manuellt.', sqlerrm;
end $$;

-- Tömningen av kön, om du vill ha den i databasen istället för i Dashboard.
--
-- Kräver att edge-funktionen fbmejl-tom är utrullad, att adressen till den är
-- satt, och att en nyckel går att hitta. Nyckeln får ALDRIG stå i klartext i
-- cron.job — den tabellen är läsbar för alla med databasåtkomst och följer
-- med i varje backup. Därför står ett ANROP i jobbtexten nedan, aldrig ett
-- värde:
--
--   select public.fbmejl_satt_installning('fbmejl_tom_url',
--     'https://<projekt>.supabase.co/functions/v1/fbmejl-tom');
--
-- Notiserna behöver adressen till den andra funktionen. Utan den skapas
-- rapporterna som vanligt men ingen push går ut, och fbmejl_halsa.notis_fel
-- räknar upp:
--
--   select public.fbmejl_satt_installning('fbmejl_push_url',
--     'https://<projekt>.supabase.co/functions/v1/fbmejl-push');
--
-- Nyckeln läggs i valvet, inte här. Se avsnittet KONFIGURATION ovan och
-- docs/notiskedjan.md.
--
-- OBSERVERA att tömningen och notisen inte godtar samma nyckel. fbmejl-push
-- godtar den egna hemligheten FBMEJL_ANROPSNYCKEL; fbmejl-tom kräver den
-- riktiga service role-nyckeln i Authorization, eller CRON_SECRET i huvudet
-- x-cron-secret. Därför läser jobbet nedan uttryckligen service_role_key och
-- inte fbmejl_anropsnyckel. Skulle det ändras måste fbmejl-tom/index.ts
-- ändras först, inte den här raden.
--
-- Blocket nedan gör ingenting förrän fbmejl_tom_url är satt.

do $$
declare v_url text;
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron saknas — schemalägg fbmejl-tom i Dashboard -> Edge Functions -> Schedules.';
    return;
  end if;
  perform 1 from pg_extension where extname = 'pg_net';
  if not found then
    raise notice 'pg_net saknas — schemalägg fbmejl-tom i Dashboard -> Edge Functions -> Schedules.';
    return;
  end if;

  v_url := public.fbmejl_installning('fbmejl_tom_url');
  if v_url is null or v_url = '' then
    raise notice 'fbmejl_tom_url är inte satt — tömningen schemaläggs inte. Se docs/fbmejl.md.';
    return;
  end if;

  perform 1 from cron.job where jobname = 'polisvakt-fbmejl';
  if found then perform cron.unschedule('polisvakt-fbmejl'); end if;

  -- Varje minut. Kravet från ägaren är att ett inlägg ska synas i appen inom
  -- en minut, och kön ligger redan färdig när tömningen vaknar — det enda
  -- den gör är att tolka text och geokoda. Tätare än så går inte med pg_cron.
  perform cron.schedule('polisvakt-fbmejl', '* * * * *', format($jobb$
    select net.http_post(
      url     := %L,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || coalesce(public.fbmejl_hemlighet('service_role_key'), '')
      ),
      body    := jsonb_build_object('kalla', 'pg_cron')
    );
  $jobb$, v_url));
  raise notice 'Tömningen av mejlkön schemalagd varje minut.';
exception when others then
  raise notice 'Kunde inte schemalägga tömningen (%). Använd Dashboard -> Edge Functions -> Schedules istället.', sqlerrm;
end $$;

-- ============================ KONTROLL ===============================
--
-- Kör de här efteråt för att se att det blev rätt.
--
-- 1. Produktregeln, i databasen. Ska ge true, true, true, false:
--
--      select public.fbmejl_ar_nykterhetskontroll('Nykterhetskontroll vid Bäckby'),
--             public.fbmejl_ar_nykterhetskontroll('polisen blåser alla vid E18'),
--             public.fbmejl_ar_nykterhetskontroll('alkohol kontroll vid rondellen'),
--             public.fbmejl_ar_nykterhetskontroll('Polis står vid Erikslund');
--
-- 2. Nätet är detsamma som Telegram-spegelns. Ska ge noll rader, alltså
--    ingen text där de två svarar olika. Hoppa över om telegram.sql inte är körd:
--
--      select t, public.fbmejl_ar_nykterhetskontroll(t) as mejl,
--                public.telegram_ar_nykterhetskontroll(t) as telegram
--        from unnest(array[
--          'Nykterhetskontroll vid Bäckby', 'alkohol kontroll vid rondellen',
--          'drogtest på Vasagatan', 'polisen blåser alla', 'Polis vid Erikslund',
--          'Civilbil på E18 österut', 'fartkamera vid Hälla'
--        ]) as t
--       where public.fbmejl_ar_nykterhetskontroll(t)
--             is distinct from public.telegram_ar_nykterhetskontroll(t);
--
-- 3. Rättigheterna. INGEN rad får innehålla anon eller authenticated:
--
--      select p.proname, r.rolname
--        from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        cross join lateral aclexplode(p.proacl) a
--        join pg_roles r on r.oid = a.grantee
--       where n.nspname = 'public'
--         and p.proname in ('fbmejl_ko_in','fbmejl_ko_hamta','fbmejl_ko_avfard',
--                           'fbmejl_ta_emot','fbmejl_lage','fbmejl_satt_lage',
--                           'stada_fbmejl');
--
-- 4. Radsäkerheten. Ska ge rowsecurity = true och noll policyer på båda:
--
--      select relname, relrowsecurity from pg_class
--       where relname in ('fbmejl_ko','fbmejl_lasta','fbmejl_brygga');
--      select count(*) from pg_policies
--       where tablename in ('fbmejl_ko','fbmejl_lasta','fbmejl_brygga');
--
-- 5. Kön, med nykterhetsnätet på. Ska ge nya 1 och vagrade 1:
--
--      select public.fbmejl_ko_in(jsonb_build_array(
--        jsonb_build_object('message_id','<test-1@facebookmail.com>',
--          'from','notification@facebookmail.com',
--          'subject','Anna skrev i Här står polisen',
--          'body','Polis står vid Erikslund','date', now()::text),
--        jsonb_build_object('message_id','<test-2@facebookmail.com>',
--          'from','notification@facebookmail.com',
--          'subject','Bo skrev i Här står polisen',
--          'body','Nykterhetskontroll vid Bäckby','date', now()::text)));
--
--    Kön ska nu innehålla en rad med status 'ny' och en med 'vagrad':
--
--      select message_id, status, skal from public.fbmejl_ko
--       where message_id like 'test-%'   -- fbmejl_ko_in normaliserar: strippar <> och gemenar;
--
-- 6. Avdubblingen, på riktigt. Kör två gånger — andra gången ska ge
--    skapade 0 och dubbletter 1:
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fbm:test:1', 'text_nyckel', 'tx:test:1',
--        'message_id', '<test-1@facebookmail.com>',
--        'type', 'police', 'lat', 59.6099, 'lon', 16.5448,
--        'label', 'Testplats', 'note', 'Polis står vid testplatsen',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000,
--        'parser_confidence', 0.9, 'geokod', 'nominatim', 'geokod_typ', 'vag',
--        'fordrojning_s', 120)));
--
-- 7. Nätet, på riktigt. Ska ge skapade 0 och vagrade 1:
--
--      select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--        'external_id', 'fbm:test:2', 'type', 'police',
--        'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplats',
--        'note', 'Nykterhetskontroll vid testplatsen',
--        'created_at', (extract(epoch from now())*1000)::bigint,
--        'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000)));
--
--    Städa upp efter 5, 6 och 7:
--
--      delete from public.fbmejl_ko    where message_id like 'test-%'   -- fbmejl_ko_in normaliserar: strippar <> och gemenar;
--      delete from public.fbmejl_lasta where nyckel like 'fbm:test:%';
--      delete from public.reports      where external_id like 'fbm:test:%';
--
-- 7b. Message-ID-kontraktet. Ska ge fyra gånger samma sträng, alltså true:
--
--      select public.fbmejl_normalisera_msgid('<ABC@facebookmail.com>')
--             = public.fbmejl_normalisera_msgid('abc@facebookmail.com')
--        and public.fbmejl_normalisera_msgid('  <AbC@facebookmail.com>  ')
--             = 'abc@facebookmail.com'
--        and public.fbmejl_normalisera_msgid('') is null
--        and public.fbmejl_normalisera_msgid(null) is null;
--
--    Och på riktigt, hela vägen: lägg in ett mejl med vinkelparenteser, avfärda
--    det med den normaliserade formen, och se att kön faktiskt markerades.
--    Sista frågan ska ge status 'klar', inte 'ny':
--
--      select public.fbmejl_ko_in(jsonb_build_array(jsonb_build_object(
--        'message_id','<TEST-NORM@facebookmail.com>',
--        'from','notification@facebookmail.com',
--        'subject','Anna skrev i Här står polisen',
--        'body','Polis står vid Erikslund','date', now()::text)));
--
--      select public.fbmejl_ko_avfard(
--        jsonb_build_array('test-norm@facebookmail.com'), 'bortsorterad');
--
--      select message_id, status, skal from public.fbmejl_ko
--       where message_id = 'test-norm@facebookmail.com';
--
--      delete from public.fbmejl_ko where message_id = 'test-norm@facebookmail.com';
--
-- 8. Notisen. Slå först på gruppnotiser för din egen telefon — byt ut
--    device_id mot ditt eget, det står i appens inställningar.
--
--    Utan minst en mottagare skickas ingenting alls, och svaret blir
--    skal = 'ingen-mottagare'. Det är med flit: notisloggen ska inte påstå
--    att något gick ut när noll människor lyssnar.
--
--      update public.push_subscriptions
--         set gruppnotiser = true
--       where device_id = '<ditt-device-id>';
--
--      select public.fbmejl_gruppnotis_antal();   -- ska ge minst 1
--      select * from public.fbmejl_push_mottagare(10);
--
--    Prova texten utan att skicka något (ingen url satt = ingen push går ut,
--    men titeln syns i svaret). En rapport ska ge "Polis vid Erikslund",
--    tre ska ge "3 nya varningar i gruppen":
--
--      select public.fbmejl_notis_ut(jsonb_build_array(
--        jsonb_build_object('typ','police','plats','Erikslund')));
--
--    Glesspärren, på riktigt. Kör raden ovan två gånger i rad — andra gången
--    ska ge skickad = false och skal = 'for-tatt':
--
--      select public.fbmejl_notis_ut(jsonb_build_array(
--        jsonb_build_object('typ','control','plats','E18')));
--
--    Nollställ spärren när du testat klart:
--
--      update public.fbmejl_notis_lage
--         set senaste_at = null, antal_idag = 0, odelade = 0 where id = 1;
--      delete from public.fbmejl_notis_logg;
--
-- 9. Produktregeln OCH notisen, tillsammans. Det här är det viktigaste testet
--    i hela filen: en nykterhetskontroll får inte ens ge en notis om att
--    "något hänt", för det vore i praktiken samma varning. Kör raden i punkt 7
--    och kontrollera sedan att INGEN ny rad tillkommit:
--
--      select count(*) from public.fbmejl_notis_logg
--       where skickat_at > now() - interval '1 minute';
--
-- 9b. Notisloggen ljuger inte längre. Efter en riktig omgång ska raden stå
--     som 'koad' och sedan bli 'kvitterad' eller 'fel' — aldrig 'skickad':
--
--      select id, skickat_at, antal, utfall, net_id, left(skal, 120)
--        from public.fbmejl_notis_logg order by skickat_at desc limit 10;
--
--      select public.fbmejl_notis_stam_av();
--
--     Står allt kvar som 'koad' efter avstämningen saknas pg_net, eller så
--     hann svaret städas bort. Står det 'fel' med "HTTP 401" är nyckeln fel —
--     kör punkt 12 nedan; "HTTP 404" betyder att edge-funktionen fbmejl-push
--     inte är utrullad. Står det 'fel' med "fbmejl_push_url saknas" eller
--     "anropsnyckel saknas" är det konfigurationen, inte kedjan.
--
-- 9c. Reglaget för gruppnotiser. Ska ge ok = false och skal = 'ingen-rad' för
--     en endpoint som inte finns, alltså precis det fall som tidigare gav ett
--     tyst "På" i appen:
--
--      select public.fbmejl_satt_gruppnotiser('https://finns.inte/x', 'nagon', true);
--      select public.fbmejl_har_gruppnotiser('https://finns.inte/x', 'nagon');
--
--     Och med din egen endpoint (hämta den ur appens inställningar) ska de
--     två svaren stämma överens:
--
--      select public.fbmejl_satt_gruppnotiser('<din-endpoint>', '<ditt-device-id>', true);
--      select public.fbmejl_har_gruppnotiser('<din-endpoint>', '<ditt-device-id>');
--
-- 9d. Meningen. Ska ge de fyra raderna nedan, ordagrant:
--
--      select public.fbmejl_mening('police', null, 'Erikslund',
--               (extract(epoch from now())*1000)::bigint - 4*60000) ->> 'mening';
--      -- Polis vid Erikslund — någon i Facebook-gruppen varnade för 4 minuter sedan.
--
--      select public.fbmejl_mening('control', public.fbmejl_utrustning('laserkontroll pa E18'),
--               'E18', (extract(epoch from now())*1000)::bigint) ->> 'mening';
--      -- Fartkontroll med laser vid E18 — någon i Facebook-gruppen varnade just nu.
--
--      select public.fbmejl_mening('unmarked', null, 'på Hälla',
--               (extract(epoch from now())*1000)::bigint - 20*60000) ->> 'mening';
--      -- Civil polisbil på Hälla — någon i Facebook-gruppen varnade för 20
--      -- minuter sedan. Kan ha flyttat på sig.
--
--      select public.fbmejl_mening('police', null, '', null) ->> 'mening';
--      -- Polis, plats okänd — någon i Facebook-gruppen varnade vid okänd tidpunkt.
--
--    Och att inget ur inläggstexten kan ta sig ut. Ska ge laser, radar, fart,
--    och tre gånger null — aldrig något annat:
--
--      select public.fbmejl_utrustning('laser vid E18'),
--             public.fbmejl_utrustning('radarkontroll'),
--             public.fbmejl_utrustning('fartkontroll vid Hälla'),
--             public.fbmejl_utrustning('polis vid Erikslund'),
--             public.fbmejl_utrustning('<script>alert(1)</script>'),
--             public.fbmejl_utrustning(null);
--
-- 10. Hälsan, när bryggan väl går:
--
--      select * from public.fbmejl_halsa;
--      select * from public.fbmejl_senaste;
--
-- 11. Skriver någon fortfarande förbi notiskedjan? Kolumnen omdome ska säga
--     "går genom fbmejl_ta_emot" för varje väg. Står det "SKRIVER FÖRBI" är
--     bryggan inte omställd — se docs/notiskedjan.md:
--
--      select * from public.fbmejl_notiskedjan;
--
-- 12. Konfigurationen. Ett svar, hela bilden, och inte en enda hemlighet i
--     det. klar = true betyder att både adress och nyckel finns:
--
--      select jsonb_pretty(public.fbmejl_notis_konfig());
--
--     nyckel_kalla säger vilket namn som svarade och varifrån, till exempel
--     "fbmejl_anropsnyckel/valv". Står det null finns ingen nyckel någonstans.
--     nyckel_form är tre tecken: 'eyJ' är en JWT, 'sb_' en ny hemlig nyckel,
--     något annat är en egen sträng. Tre tecken räcker för att se den enda
--     förväxling som faktiskt inträffar och räcker inte till något annat.
--
--     valv_installerat = false betyder att tillägget supabase_vault inte är
--     påslaget. valv_lasbart = false med valv_fel satt betyder att det finns
--     men inte går att läsa för den roll som äger funktionerna.
--
-- 12b. BEVISET att anon inte kommer åt hemligheten. Byter roll på riktigt och
--      kräver att anropet nekas. Ska skriva OK tre gånger:
--
--      do $bevis$
--      declare v_svar text; v_ok boolean;
--      begin
--        foreach v_svar in array array['fbmejl_valv_las', 'fbmejl_hemlighet',
--                                      'fbmejl_anropsnyckel'] loop
--          v_ok := false;
--          begin
--            set local role anon;
--            if v_svar = 'fbmejl_anropsnyckel' then
--              execute 'select public.fbmejl_anropsnyckel()';
--            else
--              execute 'select public.' || v_svar || '(''service_role_key'')';
--            end if;
--          exception when insufficient_privilege then
--            v_ok := true;
--          end;
--          reset role;
--          if v_ok then
--            raise notice 'OK: anon nekas av %', v_svar;
--          else
--            raise warning 'FEL: anon slapp in i % — kor revoke-raderna igen', v_svar;
--          end if;
--        end loop;
--      end $bevis$;
--
--      Och samma sak ur katalogen, för den som hellre läser ett rutnät. Alla
--      sex ska vara false:
--
--      Uppslagningen av vault-objekten går via pg_namespace och pg_class och
--      inte via namnsträngar. Ett kvalificerat namn slår upp schemat med
--      LookupExplicitNamespace(), som kastar när USAGE saknas — och en
--      kontrollfråga som DÖR när rätten saknas svarar inte på frågan den
--      ställdes för att svara på.
--
--      select
--        has_function_privilege('anon','public.fbmejl_hemlighet(text)','execute')          as anon_hemlighet,
--        has_function_privilege('authenticated','public.fbmejl_hemlighet(text)','execute') as auth_hemlighet,
--        has_function_privilege('anon','public.fbmejl_valv_las(text)','execute')           as anon_valv_las,
--        has_function_privilege('anon','public.fbmejl_anropsnyckel()','execute')           as anon_nyckel,
--        coalesce((select has_schema_privilege('anon', n.oid, 'usage')
--                    from pg_namespace n where n.nspname = 'vault'), false)                as anon_valv_schema,
--        coalesce((select has_table_privilege('anon', c.oid, 'select')
--                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
--                   where n.nspname = 'vault' and c.relname = 'decrypted_secrets'), false) as anon_valv_vy;
--
-- 12c. Att ingen hemlighet kan hamna i loggen. Maskningen ska bita på alla
--      fyra formerna. Ska ge fyra rader utan en enda nyckel i:
--
--      select public.fbmejl_dolj_hemligheter(
--               'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaaaa')
--        union all
--      select public.fbmejl_dolj_hemligheter('nyckeln sb_secret_abcdefghijklmnopqrstuvwxyz kom med')
--        union all
--      select public.fbmejl_dolj_hemligheter('HTTP 200 {"ok":true,"mottagare":1,"skickade":1}')
--        union all
--      select public.fbmejl_dolj_hemligheter(
--               'Bearer ' || coalesce(public.fbmejl_anropsnyckel(), 'ingen-nyckel-satt'));
--
--      Sista raden är den som räknas: den matar in den RIKTIGA nyckeln och
--      ska ge "Bearer [hemlighet, N tecken]" eller "Bearer [dold nyckel]".
--      Kommer nyckeln ut i klartext är maskningen trasig — och då ska
--      ingenting rulla ut förrän den är lagad.
--
--      Och att loggen faktiskt är ren, efter en riktig omgång. Ska ge noll
--      rader:
--
--      select id, skickat_at, left(skal, 120) from public.fbmejl_notis_logg
--       where skal ~ 'eyJ[A-Za-z0-9._-]{20,}'
--          or skal ~ 'sb_[a-z]+_[A-Za-z0-9_-]{20,}'
--          or (public.fbmejl_anropsnyckel() is not null
--              and position(public.fbmejl_anropsnyckel() in coalesce(skal, '')) > 0);
--
-- Gick en omgång fel och la ut skräp? Så här släcks den utan att historiken
-- raderas — rapporterna försvinner ur appen inom en tömningscykel, men
-- raderna finns kvar att granska:
--
--   update public.reports
--      set removed = true,
--          expires_at = (extract(epoch from now()) * 1000)::bigint
--    where device_id = 'fb-mejl'
--      and created_at > (extract(epoch from now()) * 1000)::bigint - 3600 * 1000;
-- =====================================================================
