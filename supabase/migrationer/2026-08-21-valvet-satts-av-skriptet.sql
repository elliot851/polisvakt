-- Migration: skriptet lägger nyckeln i valvet självt, så människan klistrar EN gång.
--
-- Kör hela filen i Supabase SQL Editor. Den lägger till en funktion, ändrar
-- ingen tabell, rör ingen rad och tar inte bort något.
--
-- ---------------------------------------------------------------------
-- PROBLEMET
--
-- Notiskedjan saknar ett VÄRDE, inte kod. Samma sträng behövde fram till nu
-- klistras in på TVÅ ställen:
--
--   1. tools\satt-nyckel.ps1 på ägarens maskin (DPAPI-krypterad), för att
--      daemonen ska få anropa fbmejl_ta_emot().
--   2. Supabase Vault under namnet service_role_key, för att databasen ska
--      kunna legitimera sig mot edge-funktionen fbmejl-push.
--
-- Punkt 2 var en resa in i dashboarden: Project Settings -> Vault -> Add new
-- secret -> klistra -> spara -> tillbaka till terminalen. Fem klick för att
-- flytta en sträng som skriptet redan hade i minnet.
--
-- Två inklistringar av samma hemlighet är dessutom två tillfällen att klistra
-- FEL sträng. Dashboarden visar två service role-nycklar (en sb_secret_... och
-- en eyJ...), och den variant som duger i valvet är inte självklart samma som
-- duger på maskinen. Ett fel där ger 401 på en nyckel som ser alldeles rätt ut,
-- och felet syns först när en polisrapport inte blir en notis.
--
-- ---------------------------------------------------------------------
-- LÖSNINGEN, OCH VARFÖR DEN INTE ÖPPNAR NÅGOT
--
-- Skriptet har redan nyckeln i minnet i det ögonblick användaren klistrat in
-- den i terminalen. Då kan det lika gärna skriva den i valvet själv.
--
-- Funktionen nedan är grantad till service_role OCH INGEN ANNAN. Det låter
-- generöst men ger noll ny makt: den som redan har service_role-nyckeln kan
-- redan göra allt i den här databasen, valvet inbegripet. Funktionen är en
-- bekvämlighet för en anropare som redan är inne, inte en ny dörr.
--
-- anon och authenticated är uttryckligen revokade längst ner. Vore de det
-- inte hade vem som helst med den publika nyckeln kunnat skriva över
-- service_role_key med skräp och tysta hela notiskedjan — ett förnekelseangrepp
-- som inte kräver någon hemlighet alls.
--
-- ---------------------------------------------------------------------
-- NAMNSPÄRREN
--
-- p_namn får bara vara 'service_role_key'. Det är inte överdriven försiktighet,
-- det är en känd fälla som redan bitit det här projektet:
--
--   public.fbmejl_anropsnyckel() väljer hemligheten fbmejl_anropsnyckel FÖRE
--   service_role_key. Edge-funktionen fbmejl-push har ingen motsvarande
--   FBMEJL_ANROPSNYCKEL att jämföra mot. Ligger en hemlighet med det namnet i
--   valvet vinner den alltså, och varje notis dör med 401 — på en nyckel som
--   är helt korrekt.
--
-- Den fällan står redan som en varning i tools\fbmejl.hemligheter.json. En
-- varning i en fil är en förhoppning; en spärr i funktionen är ett skydd.
-- Skriptet kan därför inte råka skriva fel namn, och ingen som läser den här
-- filen om ett halvår kan heller.

set local statement_timeout = '30s';

do $forkontroll$
begin
  if to_regclass('vault.secrets') is null then
    raise exception
      'supabase_vault är inte installerat i den här databasen. Kör: create extension if not exists supabase_vault with schema vault;';
  end if;
  if to_regproc('public.fbmejl_valv_las') is null then
    raise exception
      'Kör supabase/migrationer/2026-08-21-konfiguration-i-valvet.sql först — fbmejl_valv_las saknas.';
  end if;
end
$forkontroll$;

-- ---------------------------------------------------------------------
-- SÄTTAREN
--
-- Returnerar jsonb och ALDRIG värdet. Inte ens en delsträng, inte ens vid fel.
-- Det enda som lämnas ut är namn, längd och form — precis som
-- fbmejl_notis_konfig() gör, och av samma skäl: svaret ska gå att klistra in i
-- en felsökning utan att hemligheten följer med.
create or replace function public.fbmejl_valv_satt(p_namn text, p_varde text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp as $$
declare
  v_varde   text;
  v_id      uuid;
  v_fanns   boolean := false;
  v_langd   int;
  v_form    text;
begin
  -- Namnspärren. Se resonemanget överst i filen: fbmejl_anropsnyckel i valvet
  -- vinner över service_role_key och ger 401 på en riktig nyckel.
  if p_namn is distinct from 'service_role_key' then
    return jsonb_build_object(
      'klar', false,
      'fel', 'namn-ej-tillatet',
      'bad_om', p_namn,
      'tillatna', jsonb_build_array('service_role_key'),
      'varfor', 'fbmejl_anropsnyckel i valvet vinner over service_role_key och ger 401 pa en korrekt nyckel.');
  end if;

  -- btrim av samma skäl som i fbmejl_valv_las(): en klistrad sträng bär ofta
  -- en radbrytning, och edge-funktionen trimmar sin sida. Trimmas det inte
  -- här jämförs en sträng med nyrad mot en utan.
  v_varde := nullif(btrim(coalesce(p_varde, '')), '');
  if v_varde is null then
    return jsonb_build_object('klar', false, 'fel', 'tomt-varde');
  end if;

  v_langd := length(v_varde);

  -- Formen, inte värdet. Två giltiga former finns, och vilken som duger var
  -- är inte självklart — därför rapporteras den tillbaka så att skriptet kan
  -- säga vad det faktiskt lade in.
  v_form := case
              when v_varde like 'sb_secret_%' then 'sb_secret'
              when v_varde like 'eyJ%'        then 'jwt'
              else 'okand'
            end;

  -- En publik nyckel i valvet är inte ett stavfel, det är en tyst
  -- funktionsförlust: allt svarar 200 och ingen telefon ringer. Vägra.
  if v_varde like 'sb_publishable_%' or v_varde like 'sb_anon_%' then
    return jsonb_build_object(
      'klar', false,
      'fel', 'publik-nyckel',
      'varfor', 'Det ar den publika nyckeln. Valvet ska ha den hemliga (service_role).');
  end if;

  if v_langd < 20 then
    return jsonb_build_object('klar', false, 'fel', 'for-kort', 'langd', v_langd);
  end if;

  -- Uppdatera om namnet redan finns, skapa annars. Två hemligheter med samma
  -- namn är tillåtet i vault.secrets, och fbmejl_valv_las() tar då den nyaste
  -- — men två kopior som driver isär är precis det mönster som redan kostat
  -- det här projektet en hel felsökning. En rad per namn.
  begin
    select s.id into v_id
      from vault.secrets s
     where s.name = p_namn
     order by s.created_at desc
     limit 1;

    if v_id is not null then
      v_fanns := true;
      perform vault.update_secret(v_id, v_varde, p_namn,
        'Satt av tools/satt-nyckel.ps1. Anvands av fbmejl_anropsnyckel() mot edge-funktionen fbmejl-push.');
    else
      v_id := vault.create_secret(v_varde, p_namn,
        'Satt av tools/satt-nyckel.ps1. Anvands av fbmejl_anropsnyckel() mot edge-funktionen fbmejl-push.');
    end if;
  exception when others then
    -- sqlerrm kan i teorin bära med sig det som skickades in. Det får inte
    -- lämna funktionen, så felet rapporteras med sin kod och inte med sin text.
    return jsonb_build_object(
      'klar', false,
      'fel', 'valvet-vagrade',
      'sqlstate', sqlstate);
  end;

  -- Läs tillbaka genom samma väg som notiskedjan faktiskt använder. Ett svar
  -- som bara säger "sparat" är värt ingenting; det här säger "sparat OCH
  -- läsbart för den som ska läsa det".
  return jsonb_build_object(
    'klar',        public.fbmejl_valv_las(p_namn) is not null,
    'namn',        p_namn,
    'ersatte',     v_fanns,
    'langd',       v_langd,
    'form',        v_form,
    'lasbar_igen', public.fbmejl_valv_las(p_namn) is not null);
end $$;

comment on function public.fbmejl_valv_satt(text, text) is
  'Skriver service_role_key i valvet. Bara service_role far anropa. Lamnar aldrig ut vardet.';

-- ---------------------------------------------------------------------
-- RÄTTIGHETER
--
-- revoke from public tas FÖRE grant. Postgres ger execute till public som
-- förval på nya funktioner, och en glömd revoke här hade betytt att vem som
-- helst med den publika anon-nyckeln kunde skriva över nyckeln i valvet.
revoke all on function public.fbmejl_valv_satt(text, text) from public, anon, authenticated;
grant execute on function public.fbmejl_valv_satt(text, text) to service_role;

-- ---------------------------------------------------------------------
-- EFTERKONTROLL
--
-- Kör den här efteråt. Den visar om valvet nu har en läsbar nyckel, utan att
-- visa nyckeln:
--
--   select public.fbmejl_notis_konfig();
--
-- Ska ge klar:true och nyckel_kalla:"service_role_key/valv".
-- Står det "fbmejl_anropsnyckel/valv" ligger den gamla fällan kvar i valvet
-- och vinner. Ta bort den hemligheten, sedan går kedjan igenom.
