-- Migration: konfigurationen flyttar till Vault, för alter database är stängd.
--
-- Kör hela filen i Supabase SQL Editor, som vanligt, på en databas där
-- supabase/fbmejl.sql och 2026-08-21-brygga-notiskedja.sql redan är körda.
-- Ingen tabell töms, ingen rapport rörs, ingen rad raderas.
--
-- HELA FILEN GÅR ATT KÖRA SOM ROLLEN postgres. Det finns inte ett enda
-- "alter database" i den, och den kräver ingen superuser. Det är hela poängen.
--
-- ---------------------------------------------------------------------
-- FELET
--
-- Notiskedjan var hel utom i ett led. Uppmätt mot produktionsdatabasen:
-- fbmejl-push är utrullad och svarar 401 på ett anrop utan nyckel, alltså
-- finns den. Migrationen 2026-08-21-brygga-notiskedja.sql är körd.
-- fbmejl_gruppnotis_antal() ger 1, alltså finns en telefon som lyssnar.
--
-- Det som fattades var att databasen skulle kunna legitimera sig. Den vägen
-- förutsatte två databasinställningar:
--
--   alter database postgres set app.service_role_key = '...';
--   alter database postgres set app.fbmejl_push_url  = '...';
--
-- Och de går inte att sätta här. Uppmätt svar i SQL-editorn:
--
--   ERROR: 42501: permission denied to set parameter "app.fbmejl_push_url"
--
-- SQL-editorn kör som rollen postgres, och postgres är INTE superuser på ett
-- Supabase-projekt. alter database ... set är därmed stängd för båda värdena.
-- Ingen mängd omkörningar av fbmejl.sql hade hjälpt: funktionen läste ett
-- värde som var omöjligt att skriva.
--
-- Uppmätt i samma databas, och det är det som gör den här migrationen möjlig:
--
--   current_user            postgres
--   rolsuper                false
--   supabase_vault          installerad
--   vault-schemat           finns
--   vault.create_secret     finns
--   CREATE på databasen     true
--
-- ---------------------------------------------------------------------
-- VALEN, OCH VARFÖR
--
-- 1. NYCKELN LIGGER I VALVET, INTE I EN INSTÄLLNING.
--
--    supabase_vault krypterar värdet och lämnar ut det genom vyn
--    vault.decrypted_secrets, som är läsbar för postgres och för ingen annan
--    roll. En security definer-funktion ägd av postgres kommer alltså åt den;
--    anon och authenticated gör det inte, varken direkt eller via funktionen.
--    Beviset står som kontrollfråga längst ner och byter roll på riktigt.
--
-- 2. ADRESSEN LIGGER I EN VANLIG TABELL, INTE I VALVET.
--
--    Adressen till en edge-funktion är ingen hemlighet. Den är
--    https://<projekt>.supabase.co/functions/v1/fbmejl-push, projekt-id:t
--    står redan öppet i js/config.js, och funktionen svarar 401 på varje
--    anrop utan nyckel. Läggs den i valvet köper det ingenting och kostar
--    två saker: värdet går inte längre att LÄSA när man felsöker, och nästa
--    människa som öppnar valvsidan ser två hemligheter utan att veta vilken
--    som är den riktiga. Ett valv där bara hälften är hemligt är ett valv man
--    slutar tro på.
--
--    Tabellen har radsäkerhet på och allt indraget från anon och
--    authenticated. Den är alltså inte offentlig — den är bara okrypterad,
--    och det är skillnaden mellan "inte hemligt" och "fritt fram".
--
-- 3. EN EGEN DELAD HEMLIGHET, INTE PROJEKTETS SERVICE ROLE-NYCKEL.
--
--    Frågan var om databasen måste bära en Supabase-nyckel alls för att få
--    anropa fbmejl-push. Det måste den inte. Funktionen godtar redan tre:
--    SUPABASE_SERVICE_ROLE_KEY (injicerad av plattformen), SERVICE_ROLE_KEY,
--    och den valfria FBMEJL_ANROPSNYCKEL — se TILLATNA_ANROPSNYCKLAR i
--    supabase/functions/fbmejl-push/index.ts.
--
--    Den sista är bättre av tre skäl:
--
--      a) Den roteras utan att röra något annat. Service role-nyckeln bärs av
--         varje jobb och skript i projektet; byts den måste allt bytas samma
--         dag. Den här bärs av ett anrop.
--      b) Läcker den kostar den mindre. Service role-nyckeln går förbi all
--         radsäkerhet i hela databasen. Den här kan skicka en gruppnotis.
--         Illa nog — edge-funktionens egen kommentar kallar det den värsta
--         bugg den kan ha — men det är en skada med en botten.
--      c) Den har ingen andra utgåva att förväxlas med. Projektet har både en
--         sb_secret-nyckel och en äldre eyJ-JWT, plattformen injicerar EN av
--         dem, och sätter man den andra svarar funktionen 401 på varje anrop.
--         Det felet har redan kostat en felsökningskväll här.
--
--    Priset, sagt rakt ut: värdet måste sättas på TVÅ ställen — som hemlighet
--    FBMEJL_ANROPSNYCKEL på edge-funktionen, och i valvet under namnet
--    fbmejl_anropsnyckel. Glider de isär blir det 401. Men service role-vägen
--    har samma tvåställesproblem OCH ett ställe man inte råder över, eftersom
--    plattformen väljer utgåva åt en. Två ställen man styr är bättre än ett
--    man styr och ett man inte gör.
--
--    Service role-nyckeln ligger kvar som andrahandsval. Ett projekt som
--    redan har den satt fortsätter gå utan en enda ändring.
--
-- 4. BAKÅTKOMPATIBELT. Läsordningen är tabell, sedan valv, sedan
--    current_setting('app.<namn>'), sedan null. Sista steget är inte död kod:
--    på en egen Postgres eller ett projekt med superuser fungerar alter
--    database, raderna är redan körda, och kedjan går. Tas steget bort slutar
--    en fungerande installation fungera vid nästa omkörning av fbmejl.sql,
--    utan att någonting i den installationen har ändrats.
--
-- 5. INGEN HEMLIGHET FÅR NÅ EN LOGG.
--
--    Genomgången, väg för väg. Det finns fyra ställen där text som kommer
--    UTIFRÅN kan hamna i fbmejl_notis_logg.skal eller fbmejl_notis_lage.
--    senaste_fel, och de är kapade till 200 respektive 500 tecken:
--
--      a) sqlerrm efter net.http_post() i fbmejl_notis_ut(). Nyckeln är ett
--         ARGUMENT till anropet, och Postgres skriver normalt inte ut
--         argument i sina felmeddelanden — men "normalt" är inte "aldrig".
--         ÅTGÄRDAT: maskas med fbmejl_dolj_hemligheter().
--
--      b) r.content i fbmejl_notis_stam_av(), alltså svarskroppen från det
--         som svarade på adressen. Är adressen rätt är det vår egen
--         edge-funktion, och den svarar med fem tal — se sista returen i
--         fbmejl-push/index.ts. Men adressen är en INSTÄLLNING. Pekar den
--         fel gick bäraranropet till någon annans server, och en server som
--         ekar tillbaka sina huvuden skriver nyckeln rakt in i en tabell som
--         ligger i varje backup. ÅTGÄRDAT: maskas, och maskas FÖRE kapningen
--         till 200 tecken. Maskas den efter matchar en avhuggen nyckel inget
--         mönster, och kvar i loggen blir en prefix av en riktig nyckel.
--
--      c) r.error_msg i samma funktion, pg_nets eget nätverksfel.
--         ÅTGÄRDAT: maskas likadant.
--
--      d) sqlerrm i fbmejl_ta_emot()s begin/exception runt notisanropet.
--         GRANSKAD, INTE ÄNDRAD: det värdet lagras inte, det returneras till
--         anroparen i fältet notis.detalj. Det kan bara innehålla ett
--         Postgres-felmeddelande från fbmejl_notis_ut(), som numera fångar
--         sitt eget nätverksfel och aldrig kastar vidare med ett värde i
--         texten. Ändras det ska masken läggas till där också.
--
--    Kvar blir form och längd, aldrig innehåll — samma mönster som
--    401-loggen i fbmejl-push/index.ts. Kontrollfrågan längst ner matar in
--    den RIKTIGA nyckeln i maskningen och kräver att den försvinner.
--
-- ---------------------------------------------------------------------
-- VAD SOM ÄNDRAS
--
--   NY   public.fbmejl_installningar        tabell för icke-hemligt
--   NY   public.fbmejl_satt_installning()   sättare med formkontroll
--   NY   public.fbmejl_valv_las()           läser vault.decrypted_secrets
--   NY   public.fbmejl_kalla()              var ligger värdet? Ordningen bor här
--   NY   public.fbmejl_installning()        icke-hemligt värde
--   NY   public.fbmejl_hemlighet()          hemligt värde, aldrig ur tabellen
--   NY   public.fbmejl_anropsnyckel()       nyckeln mot fbmejl-push
--   NY   public.fbmejl_dolj_hemligheter()   maskning före loggning
--   NY   public.fbmejl_notis_konfig()       svaret utan att något hemligt syns
--   OM   public.fbmejl_notis_ut()           läser genom det nya, maskar sqlerrm
--   OM   public.fbmejl_notis_stam_av()      maskar svarskroppen
--
-- Spärrarna är orörda: natt, glesspärr, dygnstak, buntspärr, och framför allt
-- nykterhets- och drognätet. En nykterhetskontroll ger fortfarande varken
-- rapport eller notis, och ingenting i den här filen rör den regeln.
--
-- Funktionerna står i sin helhet och inte som lappar. plpgsql går inte att
-- ändra i bitar, och texten är ordagrant densamma som i supabase/fbmejl.sql.
--
-- EFTER KÖRNING återstår ETT steg: lägg nyckeln i valvet. Det gör ägaren
-- själv, i dashboarden, och ingen annan behöver se den. Se docs/notiskedjan.md
-- och kontrollfrågorna längst ner i den här filen.
--
-- ---------------------------------------------------------------------
-- OBS: hela filen är skriven med radkommentarer. Skriv ALDRIG ett cron-uttryck
-- inuti en blockkommentar — en stjärna följd av snedstreck avslutar
-- kommentaren mitt i raden, och hela körningen dör på "syntax error at or
-- near 5". Det har redan hänt en gång i det här projektet.
-- =====================================================================

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


-- ============================ ADRESSEN, SATT =========================
--
-- Projektet är livvehyqowmcafnisxho. Adressen är inte hemlig, står redan i
-- js/config.js och i docs/notiskedjan.md, och behöver därför inte skrivas in
-- för hand. Den sätts här, i migrationen, så att det enda som återstår när
-- filen är körd är nyckeln — och nyckeln är det enda som ägaren måste göra
-- själv.
--
-- Kör du filen på ett ANNAT projekt: byt projekt-id:t nedan, eller kör
-- sättaren igen efteråt med rätt adress. Den skriver över.

do $$
declare v_svar jsonb;
begin
  v_svar := public.fbmejl_satt_installning(
    'fbmejl_push_url',
    'https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-push');
  if coalesce((v_svar->>'ok')::boolean, false) then
    raise notice 'Adressen till fbmejl-push är satt: %', v_svar->>'varde';
  else
    raise warning 'Adressen sattes INTE: %', v_svar->>'skal';
  end if;
end $$;

-- ============================ NOTISER: UTSKICKET =====================
--
-- ÄNDRAT I DEN HÄR MIGRATIONEN, och ingenting annat:
--
--   * v_url läses med fbmejl_installning('fbmejl_push_url') i stället för
--     current_setting('app.fbmejl_push_url', true).
--   * v_nyckel läses med fbmejl_anropsnyckel() i stället för
--     current_setting('app.service_role_key', true).
--   * En ny gren: saknas nyckeln loggas 'anropsnyckel saknas' och omgången
--     läggs tillbaka i odelade, i stället för att skicka ett anrop som
--     garanterat ger 401.
--   * sqlerrm maskas med fbmejl_dolj_hemligheter() innan den sparas.
--
-- Spärrarna, texten, ordningen och tillståndsskrivningen är ORÖRDA. Hela
-- funktionen står här ändå, för plpgsql går inte att ändra i bitar. Texten är
-- ordagrant densamma som i supabase/fbmejl.sql.
--
-- ---------------------------------------------------------------------
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
-- ÄNDRAT I DEN HÄR MIGRATIONEN, och ingenting annat: både svarskroppen och
-- error_msg körs genom fbmejl_dolj_hemligheter() innan de kapas till 200
-- tecken och sparas i fbmejl_notis_logg.skal. Räkningen, utfallen, tiderna
-- och taken är orörda.
--
-- Schemaläggningen rörs inte heller. Jobbet polisvakt-fbmejl-notisavstamning
-- pekar på funktionsNAMNET, inte på en kopia av kroppen, så det plockar upp
-- den nya versionen automatiskt vid nästa körning.
--
-- ---------------------------------------------------------------------
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
-- på en databas utan pg_net. Schemaläggningen står i supabase/fbmejl.sql och
-- rörs inte här.

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


-- ============================ RÄTTIGHETER ============================
--
-- Varje rad nedan pekar på en funktion som skapas i den här filen. Ingen
-- signatur är gissad.
--
-- Läsarna av hemligheter är indragna från ALLT, service_role inräknat. Det är
-- inte en artighet mot service_role, som ändå kan det mesta i databasen — det
-- är att ingen anropare utanför databasen behöver dem. Den enda som läser
-- nyckeln är fbmejl_notis_ut(), och den är security definer och ägs av samma
-- roll som funktionerna. Ett internt anrop i en security definer-funktion
-- prövas mot ÄGAREN, inte mot den som anropade den yttersta funktionen.
-- Kedjan går alltså hela vägen utan att en enda roll utanför databasen har
-- fått rätten att läsa nyckeln.
--
-- En hemlighet som anon kan läsa är ingen hemlighet. Beviset står bland
-- kontrollfrågorna längst ner och byter roll till anon på riktigt.

revoke all on function public.fbmejl_valv_las(text)                  from public, anon, authenticated, service_role;
revoke all on function public.fbmejl_kalla(text, boolean)            from public, anon, authenticated, service_role;
revoke all on function public.fbmejl_hemlighet(text)                 from public, anon, authenticated, service_role;
revoke all on function public.fbmejl_anropsnyckel()                  from public, anon, authenticated, service_role;

-- Det icke-hemliga. Adressen får läsas och sättas av service_role, och
-- konfigurationsstatusen får hämtas — den innehåller aldrig ett hemligt
-- värde, bara form, längd och varifrån värdet kom. anon och authenticated får
-- ingenting heller av det: adressen säger vilken edge-funktion som är
-- notiskedjans, och det är onödig hjälp åt någon som letar efter den.
revoke all on function public.fbmejl_installning(text)               from public, anon, authenticated;
revoke all on function public.fbmejl_satt_installning(text, text)    from public, anon, authenticated;
revoke all on function public.fbmejl_dolj_hemligheter(text)          from public, anon, authenticated;
revoke all on function public.fbmejl_notis_konfig()                  from public, anon, authenticated;

grant execute on function public.fbmejl_installning(text)            to service_role;
grant execute on function public.fbmejl_satt_installning(text, text) to service_role;
grant execute on function public.fbmejl_dolj_hemligheter(text)       to service_role;
grant execute on function public.fbmejl_notis_konfig()               to service_role;

-- De två omskrivna behåller sina gamla rättigheter. create or replace
-- bevarar dem, men raderna står här ändå: filen ska gå att köra på en databas
-- där någon råkat dela ut dem fel.
revoke execute on function public.fbmejl_notis_stam_av(int)          from public, anon, authenticated;
revoke execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                     from public, anon, authenticated;
grant  execute on function public.fbmejl_notis_stam_av(int)          to service_role;
grant  execute on function public.fbmejl_notis_ut(jsonb, int, int, smallint, smallint)
                                                                     to service_role;


-- ============================ SJÄLVPROV ==============================
--
-- Körs automatiskt när filen körs. Skriver bara meddelanden och ändrar
-- ingenting.
--
-- Provet som räknas mest: att anon INTE kommer åt hemligheten. Det går inte
-- att avgöra genom att titta på koden — det avgörs av rättigheterna i
-- katalogen, och de sätts av raderna ovan. Alltså byter provet roll till anon
-- på riktigt och kräver att varje anrop nekas.

do $bevis$
declare
  v_namn  text;
  v_ok    boolean;
  v_bytt  boolean := false;
begin
  begin
    execute 'set role anon';
    v_bytt := current_user = 'anon';
  exception when others then
    v_bytt := false;
  end;
  execute 'reset role';

  if not v_bytt then
    raise warning 'BEVISET GICK INTE ATT GORA: rollbytet till anon misslyckades. Kor katalogfragan langst ner i stallet.';
    return;
  end if;

  foreach v_namn in array array['fbmejl_valv_las', 'fbmejl_hemlighet', 'fbmejl_anropsnyckel'] loop
    v_ok := false;
    begin
      execute 'set role anon';
      if v_namn = 'fbmejl_anropsnyckel' then
        execute 'select public.fbmejl_anropsnyckel()';
      else
        execute 'select public.' || quote_ident(v_namn) || '(''service_role_key'')';
      end if;
    exception when insufficient_privilege then
      v_ok := true;
    end;
    execute 'reset role';

    if v_ok then
      raise notice 'OK: anon nekas av %()', v_namn;
    else
      raise warning 'FEL: anon slapp in i %() — hemligheten ar inte skyddad. Kor revoke-raderna igen.', v_namn;
    end if;
  end loop;

  -- Bältet. Ett do-block trycker ingen egen GUC-nivå, så en kvarglömd roll
  -- hade följt med resten av skriptet.
  execute 'reset role';
end $bevis$;

-- Maskningen, på den riktiga nyckeln. Finns ingen nyckel än säger provet det
-- i stället för att påstå att allt är bra.

do $mask$
declare
  v_nyckel text := public.fbmejl_anropsnyckel();
  v_maskad text;
begin
  if v_nyckel is null then
    raise notice 'Ingen nyckel satt an — maskningen provas nar den finns. Se docs/notiskedjan.md.';
    return;
  end if;

  v_maskad := public.fbmejl_dolj_hemligheter('Authorization: Bearer ' || v_nyckel);
  if position(v_nyckel in v_maskad) = 0 then
    raise notice 'OK: nyckeln maskas bort ur text som ska loggas. Kvar blir: %', v_maskad;
  else
    raise warning 'FEL: nyckeln overlever maskningen och kan hamna i fbmejl_notis_logg.skal. Rulla inte ut forran det ar lagat.';
  end if;
end $mask$;

-- ============================ KONTROLL ===============================
--
-- Sista satsen i filen är en enda fråga med hela facit. Kör den igen när som
-- helst; den ändrar ingenting.
--
-- SÅ HÄR SKA DEN SE UT NÄR ALLT ÄR PÅ PLATS:
--
--   klar                 true
--   push_url             https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-push
--   url_kalla            tabell
--   nyckel_finns         true
--   nyckel_kalla         fbmejl_anropsnyckel/valv
--   nyckel_langd         ett tal över 20
--   nyckel_form          tre tecken. 'eyJ' = JWT, 'sb_' = ny hemlig nyckel,
--                        något annat = en egen slumpad sträng, vilket är det
--                        rekommenderade
--   valv                 true
--   pg_net               true
--   mottagare            minst 1
--   notis_ut_omstalld    true
--   stam_av_maskar       true
--   maskning_ok          true
--   logg_ren             true
--   anon_*               SEX GÅNGER false. En enda true betyder att en
--                        hemlighet är läsbar för den nyckel som ligger öppet
--                        i js/config.js
--
-- KLAR = FALSE DIREKT EFTER MIGRATIONEN ÄR VÄNTAT. Nyckeln finns inte än, och
-- det är meningen: ingen annan än ägaren ska behöva se den. Lägg den i valvet
-- enligt docs/notiskedjan.md och kör frågan igen.
--
-- ---------------------------------------------------------------------
-- NÄR KLAR = TRUE: gör det riktiga provet, med telefonen bredvid dig.
--
--   select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--     'external_id', 'fb:test:valv:1', 'type', 'police',
--     'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
--     'note', 'Polis står vid testplatsen',
--     'device_id', 'fb-daemon',
--     'created_at', (extract(epoch from now())*1000)::bigint - 3*60000,
--     'expires_at', (extract(epoch from now())*1000)::bigint + 42*60000)));
--
-- Svaret ska bära "skapade": 1 och "notis": {"skickad": true, ...}, och
-- telefonen ska visa "Polis vid Testplatsen" inom några sekunder. Vänta en
-- minut och stäm sedan av:
--
--   select public.fbmejl_notis_stam_av();
--   select id, skickat_at, antal, utfall, titel, left(skal, 160)
--     from public.fbmejl_notis_logg order by skickat_at desc limit 5;
--
-- utfall ska ha gått från 'koad' till 'kvitterad'. Står det 'fel' med
-- "HTTP 401" matchar inte nyckeln i valvet den som är satt på
-- edge-funktionen — de är två fält och de måste vara samma sträng.
--
-- ---------------------------------------------------------------------
-- OCH DET VIKTIGASTE PROVET, som inte har med den här migrationen att göra
-- men som ska köras varje gång notiskedjan rörts: en nykterhets- eller
-- drogkontroll får varken bli en rapport eller en notis.
--
--   select public.fbmejl_ta_emot(jsonb_build_array(jsonb_build_object(
--     'external_id', 'fb:test:valv:2', 'type', 'police',
--     'lat', 59.6099, 'lon', 16.5448, 'label', 'Testplatsen',
--     'note', 'Polisen har drog-kontroll vid testplatsen',
--     'device_id', 'fb-daemon',
--     'created_at', (extract(epoch from now())*1000)::bigint,
--     'expires_at', (extract(epoch from now())*1000)::bigint + 45*60000)));
--
-- Ska ge "skapade": 0, "vagrade": 1, "notis": null — och ingen ny rad i
-- fbmejl_notis_logg. Telefonen ska vara helt tyst.
--
--   select count(*) from public.fbmejl_notis_logg
--    where skickat_at > now() - interval '1 minute';
--
-- Städa upp efter proven:
--
--   delete from public.fbmejl_lasta where nyckel like 'fb:test:valv:%';
--   delete from public.reports      where external_id like 'fb:test:valv:%';
--   update public.fbmejl_notis_lage
--      set senaste_at = null, antal_idag = 0, odelade = 0 where id = 1;
--
-- =====================================================================

select
  (k->>'klar')::boolean                                                            as klar,
  k->>'push_url'                                                                   as push_url,
  k->>'push_url_kalla'                                                             as url_kalla,
  (k->>'nyckel_finns')::boolean                                                    as nyckel_finns,
  k->>'nyckel_kalla'                                                               as nyckel_kalla,
  (k->>'nyckel_langd')::int                                                        as nyckel_langd,
  k->>'nyckel_form'                                                                as nyckel_form,
  (k->>'valv_installerat')::boolean                                                as valv,
  k->>'valv_fel'                                                                   as valv_fel,
  (k->>'pg_net')::boolean                                                          as pg_net,
  (k->>'mottagare')::int                                                           as mottagare,

  -- Att funktionerna i databasen faktiskt är de omskrivna, och inte en gammal
  -- version som ligger kvar. Katalogens egen text, inte ett antagande.
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'fbmejl_notis_ut'
             and p.prosrc like '%fbmejl_anropsnyckel()%')                          as notis_ut_omstalld,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'fbmejl_notis_stam_av'
             and p.prosrc like '%fbmejl_dolj_hemligheter%')                        as stam_av_maskar,

  -- Maskningen på den riktiga nyckeln. null = ingen nyckel satt än.
  case when public.fbmejl_anropsnyckel() is null then null
       else position(public.fbmejl_anropsnyckel() in
                     public.fbmejl_dolj_hemligheter('Bearer ' || public.fbmejl_anropsnyckel())) = 0
  end                                                                              as maskning_ok,

  -- Och att loggen är ren idag. Letar efter både de kända formerna och den
  -- riktiga nyckeln.
  not exists (select 1 from public.fbmejl_notis_logg l
               where l.skal ~ 'eyJ[A-Za-z0-9._-]{20,}'
                  or l.skal ~ 'sb_[a-z]+_[A-Za-z0-9_-]{20,}'
                  or (public.fbmejl_anropsnyckel() is not null
                      and position(public.fbmejl_anropsnyckel() in coalesce(l.skal, '')) > 0))
                                                                                   as logg_ren,

  -- Rättigheterna. Alla sex ska vara false. Uppslagningen av vault-objekten
  -- går via pg_namespace och pg_class och inte via namnsträngar: ett
  -- kvalificerat namn slår upp schemat med LookupExplicitNamespace(), som
  -- KASTAR när USAGE saknas — och en kontrollfråga som dör när rätten saknas
  -- svarar inte på frågan den ställdes för att svara på.
  has_function_privilege('anon','public.fbmejl_hemlighet(text)','execute')          as anon_hemlighet,
  has_function_privilege('authenticated','public.fbmejl_hemlighet(text)','execute') as auth_hemlighet,
  has_function_privilege('anon','public.fbmejl_valv_las(text)','execute')           as anon_valv_las,
  has_function_privilege('anon','public.fbmejl_anropsnyckel()','execute')           as anon_nyckel,
  coalesce((select has_schema_privilege('anon', n.oid, 'usage')
              from pg_namespace n where n.nspname = 'vault'), false)                as anon_valv_schema,
  coalesce((select has_table_privilege('anon', c.oid, 'select')
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'vault' and c.relname = 'decrypted_secrets'), false) as anon_valv_vy
from (select public.fbmejl_notis_konfig() as k) q;

