-- Migration: nykterhetsregeln lackte narkotikaord och bindestreck.
--
-- Kor den har i Supabase SQL Editor. Den ersatter EN funktion och ror
-- ingen data. Inga drop, inga delete, ingen tabellandring.
--
-- Bakgrund: tva granskningar korde riktiga meningar genom kedjan och fem av
-- nio drogkontroller blev vanliga polisrapporter. Narkotikaorden fanns inte
-- i nagon ordlista, och 'drog-kontroll' gick igenom bade ordlistan och
-- isarskrivningsregeln eftersom normaliseringen behaller bindestreck.
--
-- Kalla: supabase/chatt.sql. Halls synkad med js/parser.js.

create or replace function public.chatt_ar_nykterhet(p_text text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp as $$
declare
  v_text text := public.chatt_normalisera(p_text);
  v_ord  text[];
  v_i    int;
  v_ord_lista text[] := array[
    'nykterhetskontroll', 'nykterhetskontroller', 'nykterhet', 'nykter',
    'alkoholkontroll', 'alkotest', 'alkoholtest', 'blåsa', 'blåser', 'blås',
    'utandningsprov', 'promillekontroll', 'rattfylla', 'rattfyllerikontroll',
    'sållningsprov', 'drogkontroll', 'drogtest',
    -- Narkotikaorden saknades. En granskning körde riktiga meningar genom
    -- kedjan och fem av nio drogkontroller blev polisrapporter. Håll synkad
    -- med SOBRIETY_WORDS i js/parser.js.
    'narkotikakontroll', 'narkotika', 'narko', 'droger', 'drogsök', 'drogsok',
    'drogsökhund', 'drogsokhund', 'blåsning'
  ];
  /*
   * Svenskan skrivs ihop, men folk särskriver ständigt. "Alkohol kontroll
   * vid rondellen" är samma sak som "alkoholkontroll" — bara det ena
   * ordet stod i listan ovan, och den isärskrivna varianten gick rakt
   * igenom. Regeln fanns, den var bara lättare att gå runt än den såg ut.
   */
  v_forled text[] := array[
    'alkohol', 'alko', 'nykterhets', 'nykterhet', 'promille', 'rattfylleri',
    'rattfylla', 'drog', 'droger', 'utandnings', 'sållnings', 'sallnings',
    'narkotika', 'narko'
  ];
  v_huvud text[] := array[
    'kontroll', 'kontroller', 'test', 'prov', 'kollar', 'koll'
  ];
begin
  if v_text = '' then
    return false;
  end if;

  -- Delsträngsmatchning, precis som klienten gör. Den fångar både hela
  -- ord och sammansättningar ("poliserna_har_drogtest_idag").
  for v_i in 1 .. array_length(v_ord_lista, 1) loop
    if strpos(v_text, v_ord_lista[v_i]) > 0 then
      return true;
    end if;
  end loop;

  /*
   * Dela även på bindestreck, inte bara blanksteg.
   *
   * chatt_normalisera behåller bindestreck med flit (gatunamn), men det
   * gjorde att "drog-kontroll" blev ETT ord: ordlistan matchade det inte,
   * och isärskrivningsregeln nedan hittade inget att ställa bredvid. Ett
   * enda bindestreck gick alltså igenom båda spärrarna samtidigt.
   */
  v_ord := regexp_split_to_array(v_text, '[ \-/._]+');
  if array_length(v_ord, 1) is null then
    return false;
  end if;

  -- Och samma text helt utan skiljetecken, så ordlistan ovan också ser
  -- "drog-kontroll" som "drogkontroll".
  if strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'drogkontroll') > 0
     or strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'narkotikakontroll') > 0
     or strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'alkoholkontroll') > 0
     or strpos(regexp_replace(v_text, '[ \-/._]+', '', 'g'), 'nykterhetskontroll') > 0 then
    return true;
  end if;
  for v_i in 1 .. array_length(v_ord, 1) - 1 loop
    if v_ord[v_i] = any(v_forled) and v_ord[v_i + 1] = any(v_huvud) then
      return true;
    end if;
  end loop;

  return false;
end $$;

-- Kontroll: alla ska ge true.
select t, public.chatt_ar_nykterhet(t) as vagras from (values
  ('Polisen har narkotikakontroll pa Vasagatan'),
  ('Narkotika kontroll vid Erikslund'),
  ('Polis gor drog-kontroll vid Erikslund'),
  ('Polis vid Erikslund med drogsokhund'),
  ('Polis kollar droger vid Erikslund'),
  ('Alkohol-kontroll vid Erikslund'),
  ('Nykterhetskontroll vid Erikslund')
) as p(t);

-- Kontroll: alla ska ge false (riktiga polisrapporter far inte tystas).
select t, public.chatt_ar_nykterhet(t) as vagras from (values
  ('Polis vid Erikslund'),
  ('Fartkontroll pa E18'),
  ('Polisen drog vidare fran Halla'),
  ('Trafikkontroll vid Halla')
) as p(t);
