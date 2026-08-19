/* =====================================================================
   ANVÄNDARNAMN — logga in med namn eller e-post
   =====================================================================

   Supabase Auth känner bara till e-post. Ska man kunna logga in med
   "elliot" måste namnet växlas till en e-postadress innan lösenordet
   skickas iväg. Det är den växlingen som är känslig, och därför ligger
   hela logiken här på servern istället för i appen.

   Tre funktioner, och gränsen mellan dem är medvetet dragen:

     username_available  ledigt eller inte, före registrering
     claim_username      knyt namnet till mitt konto, kräver inloggning
     email_for_login     namn + rätt lösenord -> e-post

   Den sista är hjärtat i det hela. En naken uppslagning namn -> e-post
   hade varit en gratis adresslista: skicka in tusen vanliga förnamn och
   få ut tusen e-postadresser att spamma eller lösenordsgissa på. Därför
   kräver funktionen rätt lösenord innan den lämnar ut något. Den som
   redan kan lösenordet kan ändå logga in, så vi röjer ingenting nytt.

   Fel lösenord och okänt namn ger exakt samma svar (null). Annars gick
   det att kartlägga vilka namn som finns genom att jämföra svaren.

   Beroenden: schema.sql behöver inte vara kört först. Filen går att köra
   om hur många gånger som helst utan att något går sönder.
   ===================================================================== */

/* ------------------------- Tabellen -------------------------------- */

create table if not exists public.usernames (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now()
);

-- Unikt oavsett skiftläge. "Elliot" och "elliot" får inte vara två personer:
-- annars kan någon registrera ett namn som ser identiskt ut med ditt och
-- utge sig för att vara dig i topplistan.
create unique index if not exists usernames_unique_ci
  on public.usernames (lower(username));

alter table public.usernames enable row level security;

-- Medvetet noll policies.
--
-- Ingen policy alls betyder att ingen kan läsa eller skriva tabellen direkt
-- via REST — inte ens med giltig inloggning. Allt går genom funktionerna
-- nedan. Det är själva poängen: kunde man läsa tabellen vore den en färdig
-- lista över alla användarnamn och vilka konton de hör till.
revoke all on public.usernames from anon, authenticated;

/* ------------------- Bromsen mot lösenordsgissning ------------------ */

create table if not exists public.login_lookups (
  username text not null,
  at       timestamptz not null default now()
);

create index if not exists login_lookups_idx
  on public.login_lookups (username, at desc);

revoke all on public.login_lookups from anon, authenticated;

/* ------------------------- Namnreglerna ----------------------------- */

create or replace function public.valid_username(p_username text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp as $$
begin
  if p_username is null then return false; end if;

  -- 3–20 tecken, måste börja på en bokstav. Siffror först öppnar för namn
  -- som liknar id-nummer, och rena siffernamn krockar med hur vi visar
  -- placeringar i topplistan.
  if p_username !~ '^[a-zåäö][a-zåäö0-9._-]{2,19}$' then return false; end if;

  -- Två skiljetecken i rad gör "el..liot" och "el.liot" svåra att skilja åt
  -- med blotta ögat. Det är precis vad någon som vill utge sig för dig vill.
  if p_username ~ '[._-]{2,}' then return false; end if;
  if p_username ~ '[._-]$'    then return false; end if;

  -- Namn som får folk att tro att de pratar med oss eller med polisen.
  if p_username in (
    'admin', 'administrator', 'root', 'system', 'support', 'hjalp', 'help',
    'polis', 'polisen', 'police', 'polisvakt', 'moderator', 'mod', 'info',
    'kontakt', 'security', 'sakerhet', 'anonym', 'test'
  ) then return false; end if;

  return true;
end $$;

/* ---------------------- Är namnet ledigt? --------------------------- */
/*
 * Svarar bara ja eller nej. Aldrig vem som har namnet.
 *
 * Att den här går att anropa utan inloggning är ett medvetet val: ett
 * registreringsformulär måste kunna säga "upptaget" medan man skriver.
 * Priset är att någon kan ta reda på vilka namn som är tagna. Det priset
 * betalar varje tjänst med öppen registrering, och det är litet — ett
 * taget namn utan e-post är inget att göra något med. Det farliga vore
 * kopplingen namn -> e-post, och den kräver lösenord.
 */
create or replace function public.username_available(p_username text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp as $$
begin
  if not public.valid_username(lower(trim(p_username))) then
    return false;                       -- ogiltigt är i praktiken upptaget
  end if;

  return not exists (
    select 1 from public.usernames
    where lower(username) = lower(trim(p_username))
  );
end $$;

/* --------------------- Knyt namnet till kontot ---------------------- */
/*
 * Kräver inloggning, och tar identiteten ur JWT:n — aldrig ur ett argument
 * från klienten. Skickade appen in ett user_id kunde vem som helst döpa om
 * någon annans konto.
 *
 * Returnerar en kort kod som appen översätter till svenska.
 */
create or replace function public.claim_username(p_username text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := lower(trim(p_username));
begin
  if v_uid is null then return 'inte_inloggad'; end if;
  if not public.valid_username(v_name) then return 'ogiltigt'; end if;

  -- Taget av någon annan?
  if exists (
    select 1 from public.usernames
    where lower(username) = v_name and user_id <> v_uid
  ) then
    return 'upptaget';
  end if;

  insert into public.usernames (user_id, username)
  values (v_uid, v_name)
  on conflict (user_id) do update set username = excluded.username;

  return 'ok';
exception
  -- Två personer som tar samma namn i samma sekund. Den som förlorar
  -- kapplöpningen ska få "upptaget", inte ett rått databasfel.
  when unique_violation then return 'upptaget';
end $$;

/* ------------------- Namn + lösenord -> e-post ---------------------- */
/*
 * Den känsliga. Läser auth.users, som ingen klient kommer åt annars.
 *
 * Ordningen spelar roll: vi bromsar FÖRE vi tittar på lösenordet. Annars
 * blir funktionen ett gissningsverktyg som svarar snabbt på fel lösenord
 * och långsamt på rätt.
 *
 * Vi loggar varje försök per namn, inte per avsändare. IP-adressen når oss
 * inte här inne, och att bromsa per konto skyddar just det konto som är
 * under attack. Nackdelen är att någon kan låsa ditt namn i ett kvart
 * genom att spamma fel lösenord — men bara namnvägen. E-postvägen in är
 * orörd, så du kommer alltid in.
 */
create or replace function public.email_for_login(p_username text, p_password text)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp as $$
declare
  v_name  text := lower(trim(p_username));
  v_tries int;
  v_user  record;
begin
  if v_name is null or v_name = '' or p_password is null then
    return null;
  end if;

  -- Städa gammalt först, annars växer tabellen för alltid.
  delete from public.login_lookups where at < now() - interval '1 hour';

  select count(*) into v_tries
  from public.login_lookups
  where username = v_name and at > now() - interval '15 minutes';

  if v_tries >= 10 then
    return null;
  end if;

  insert into public.login_lookups (username) values (v_name);

  select u.email, u.encrypted_password
    into v_user
  from public.usernames n
  join auth.users u on u.id = n.user_id
  where lower(n.username) = v_name;

  -- Okänt namn. Vi returnerar null utan att avslöja att namnet saknas —
  -- exakt samma svar som fel lösenord ger nedan.
  if not found or v_user.encrypted_password is null then
    return null;
  end if;

  -- Lösenordet ligger som bcrypt. crypt() med den lagrade hashen som salt
  -- ger samma hash tillbaka om lösenordet stämmer.
  if extensions.crypt(p_password, v_user.encrypted_password) <> v_user.encrypted_password then
    return null;
  end if;

  -- Rätt lösenord: nollställ bromsen så en inloggad användare inte straffas
  -- för sina egna felskrivningar tidigare i kvarten.
  delete from public.login_lookups where username = v_name;

  return v_user.email;
end $$;

/* --------------------------- Rättigheter ---------------------------- */
/*
 * Funktioner tilldelas PUBLIC automatiskt i Postgres. Att bara återkalla
 * från anon räcker därför INTE — den underförstådda rättigheten till
 * PUBLIC ligger kvar och funktionen går fortfarande att anropa. Vi tar
 * bort allt först och delar sedan ut det vi faktiskt menar.
 */
revoke all on function public.valid_username(text)             from public;
revoke all on function public.username_available(text)         from public;
revoke all on function public.claim_username(text)             from public;
revoke all on function public.email_for_login(text, text)      from public;

-- Före inloggning: appen måste kunna kolla ledigt namn och växla namn->e-post.
grant execute on function public.username_available(text)      to anon, authenticated;
grant execute on function public.email_for_login(text, text)   to anon, authenticated;

-- Efter inloggning: bara den som har en giltig session får ta ett namn.
grant execute on function public.claim_username(text)          to authenticated;
