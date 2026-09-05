// Polisvakt — tömmer mejlkön (Supabase Edge Function, Deno)
//
// Hämtar råa mejl ur public.fbmejl_ko, tolkar dem med js/fbmejl.js och lämnar
// färdiga rader till public.fbmejl_ta_emot().
//
// ALL TOLKNING SKER I js/fbmejl.js, som anropar js/parser.js. Det finns ingen
// ordlista i den här filen och ska aldrig komma någon. js/parser.js äger
// nykterhetsfiltret — produktregel nummer ett — och en andra ordlista här
// hade varit en andra sanning om den regeln. Se avsnittet SISTA NÄTET i
// supabase/fbmejl.sql för varför databasen ändå har ett grovt nät under.
//
// -------------------------------------------------------------------------
// Schemaläggning
//
// Var minut, antingen från pg_cron (se längst ner i supabase/fbmejl.sql) eller
// från Dashboard -> Edge Functions -> Schedules. Anroparen MÅSTE skicka
// service role-nyckeln i Authorization-huvudet; se kontrollen i Deno.serve().
//
// Miljövariabler (supabase secrets set):
//
//   FB_GRUPP_ID   grupp-id ur länken, /groups/<gid>/... Det här är rätt
//                 filter. Gruppens NAMN står bara i ämnesraden, och
//                 ämnesraden trunkeras av Facebook.
//   FB_GRUPP      reservfilter på namn när grupp-id saknas. Sämre.
//   PV_APP_URL    valfri. Var appens moduler och aliaslistan hämtas ifrån.
//                 Standard https://polisvakt.pages.dev
//   CRON_SECRET   valfri. Alternativ legitimering för anropare som inte kan
//                 sätta Authorization-huvudet.
//
// SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY injiceras av plattformen.

/*
 * LÅST TILL EN EXAKT COMMIT, inte till den levande Pages-adressen.
 *
 * Förr importerades https://polisvakt.pages.dev/js/fbmejl.js — körbar kod
 * hämtad vid varje kallstart, in i en funktion som håller service_role-
 * nyckeln. Den som kunde pusha till Pages/repot (eller kapa DNS) fick då
 * service_role-åtkomst till databasen, och varje front-end-deploy ändrade
 * tyst backendens beteende. jsDelivr-URL:en med commit-hash är oföränderlig:
 * innehållet kan inte bytas under hashen, och modulens relativa imports
 * (parser.js, store.js, util.js) löses mot samma låsta commit. Vill man ha
 * nyare logik i bryggan byter man hashen HÄR och deployar om — medvetet.
 * (Granskningsfynd 2026-09-05, före lansering.)
 */
import { bearbeta, normaliseraMessageId, SKAL }
  from 'https://cdn.jsdelivr.net/gh/elliot851/polisvakt@63260bc/js/fbmejl.js';

/* ========================== KONFIGURATION =========================== */

const SUPA = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

const GRUPP_ID = Deno.env.get('FB_GRUPP_ID') ?? '';
const GRUPP = Deno.env.get('FB_GRUPP') ?? 'Här står polisen';

const APP = Deno.env.get('PV_APP_URL') ?? 'https://polisvakt.pages.dev';

/** Västmanland. Nominatim får aldrig svara med en träff utanför länet. */
const VIEWBOX = [15.10, 59.30, 17.30, 60.30];

/**
 * Hur många mejl per körning.
 *
 * Taket sitter i Nominatims takt, inte i vår. Ett uppslag per sekund och ett
 * uppslag per mejl ger ungefär tjugofem sekunder i värsta fall, vilket är väl
 * innanför edge-funktionens vägguret. Ligger kön djupare än så tas resten
 * nästa minut — den kör ändå varje minut.
 */
const PER_KORNING = 25;

/* ============================== TYPER =============================== */

type KoRad = {
  message_id: string;
  avsandare: string | null;
  amne: string | null;
  brodtext: string | null;
  skickat_at: string | null;
};

type Mejl = {
  messageId: string;
  from: string;
  subject: string;
  body: string;
  date: string | null;
};

type Traff = { lat: number; lon: number; label: string; source: string } | null;

/* ============================ DATABASEN ============================= */

const rpc = async <T = unknown>(fn: string, args: unknown = {}): Promise<T | null> => {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${text.slice(0, 200)}`);
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
};

/* ============================ GEOKODNINGEN ========================== */
//
// Ordagrant samma funktion som telegram-poll använder (docs/telegram-brygga.md).
// Att den står två gånger är avsiktligt: de två bryggorna ska kunna rullas ut
// oberoende av varandra, och en geokodning kan bara ge en position eller
// ingen — den kan inte, till skillnad från nykterhetsfiltret, bli farlig av
// att finnas i två exemplar.

let alias: Record<string, string> | null = null;
const cache = new Map<string, Traff>();
let sistaUppslag = 0;

async function geokoda(plats: string): Promise<Traff> {
  const nyckel = String(plats || '').toLowerCase().trim();
  if (!nyckel) return null;
  if (cache.has(nyckel)) return cache.get(nyckel) ?? null;

  // Aliaslistan hämtas från appen så slang och smeknamn bara finns på ett
  // ställe: data/aliases.vasteras.json.
  if (!alias) {
    alias = await fetch(`${APP}/data/aliases.vasteras.json`)
      .then((r) => r.json())
      .catch(() => ({}));
  }
  const fraga = alias![nyckel] ?? plats;

  // Nominatim tillåter ett anrop per sekund. Kön är enkel men räcker.
  const vanta = 1100 - (Date.now() - sistaUppslag);
  if (vanta > 0) await new Promise((r) => setTimeout(r, vanta));
  sistaUppslag = Date.now();

  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', /västerås|västmanland/i.test(fraga) ? fraga : `${fraga}, Västerås`);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'se');
  u.searchParams.set('viewbox', VIEWBOX.join(','));
  u.searchParams.set('bounded', '1');           // aldrig en träff utanför länet
  u.searchParams.set('accept-language', 'sv');

  const rader = await fetch(u, {
    headers: { 'User-Agent': 'Polisvakt/1.0 (fbmejl-tom; polisvakt.se)' },
  }).then((r) => r.json()).catch(() => []);

  const traff: Traff = rader?.[0]
    ? {
        lat: parseFloat(rader[0].lat),
        lon: parseFloat(rader[0].lon),
        label: String(rader[0].name || plats),
        source: 'nominatim',
      }
    : null;

  cache.set(nyckel, traff);          // även nej cachas, annars frågar vi om
  return traff;
}

/* ============================== SERVERN ============================= */

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Endast POST', { status: 405 });

  if (!SUPA || !SERVICE) {
    console.error('Saknade miljövariabler — kolla supabase secrets list');
    return new Response('Servern är inte konfigurerad', { status: 500 });
  }

  /**
   * Vem får anropa?
   *
   * Supabase kräver som standard en giltig JWT, men ANON-nyckeln räknas som
   * giltig och ligger öppet i appens källkod. Utan kontrollen nedan kan vem
   * som helst tömma kön i otakt: forsok räknas upp fem gånger på sekunder,
   * mejlen slutar plockas upp, och i fbmejl_halsa ser det ut som att
   * tolkaren är trasig.
   *
   * pg_cron-jobbet i supabase/fbmejl.sql sätter Authorization-huvudet från
   * app.service_role_key. Schemalägger du från Dashboard istället måste du
   * lägga till samma huvud där, eller sätta CRON_SECRET och skicka det som
   * x-cron-secret.
   */
  const auth = req.headers.get('authorization') ?? '';
  const hemlighet = req.headers.get('x-cron-secret') ?? '';
  const slapp = auth === `Bearer ${SERVICE}` || (!!CRON_SECRET && hemlighet === CRON_SECRET);
  if (!slapp) return new Response('Nekad', { status: 401 });

  if (!GRUPP_ID && !GRUPP) {
    // bearbeta() vägrar tolka utan gruppfilter (SKAL.INGET_GRUPPFILTER), och
    // det är rätt: utan filter blir varje notismejl från vilken grupp som
    // helst en varning på kartan.
    return Response.json({ ok: false, fel: 'FB_GRUPP_ID saknas' }, { status: 500 });
  }

  try {
    const ko = (await rpc<KoRad[]>('fbmejl_ko_hamta', { p_antal: PER_KORNING })) ?? [];
    if (!ko.length) return Response.json({ ok: true, lasta: 0, skapade: 0 });

    const mejl: Mejl[] = ko.map((r) => ({
      // Kön lagrar den kanoniska formen sedan fbmejl_ko_in() normaliserar vid
      // insättning. Anropet här är ett bälte: kommer en rad från en äldre
      // körning med vinkelparenteser kvar måste den ändå kunna matchas mot
      // det js/fbmejl.js skickar tillbaka, annars markeras den aldrig och
      // ligger kvar tills forsok slår i taket. Se avsnittet
      // MESSAGE-ID: EN FORM i supabase/fbmejl.sql.
      messageId: normaliseraMessageId(r.message_id),
      from: r.avsandare ?? '',
      subject: r.amne ?? '',
      body: r.brodtext ?? '',
      date: r.skickat_at,
    }));

    // Ett mejl i taget, inte hela bunten på en gång.
    //
    // Det är den enda vägen till att veta VARFÖR ett enskilt mejl inte blev en
    // rapport. bearbeta() svarar med en summering per anrop — en räknare per
    // skäl, inte ett skäl per mejl — så tolkar man hela bunten i ett anrop
    // vet man att tre mejl föll bort men inte vilka tre. Då återstår bara att
    // markera allt som inte blev en rapport med samma skäl, och då markeras
    // även de som föll på ett NÄTVERKSFEL i geokodningen. De ska få försöka
    // igen; markeras de som avgjorda är varningen borta för gott.
    //
    // sedda delas mellan anropen så avdubblingen inom bunten fungerar precis
    // som när hela listan skickas in på en gång.
    const sedda = new Set<string>();
    const rapporter: Record<string, unknown>[] = [];
    const avfarda = new Map<string, string[]>();   // skäl -> message_id
    const aterforsok: string[] = [];
    const okandaPlatser: string[] = [];
    let dubbletter = 0;

    for (const m of mejl) {
      const s = await bearbeta(m, {
        geokoda,
        sedda,
        ...(GRUPP_ID ? { gruppId: GRUPP_ID } : { grupp: GRUPP }),
      });

      for (const p of s.okandaPlatser) {
        if (!okandaPlatser.includes(p)) okandaPlatser.push(p);
      }

      if (s.rapporter.length) {
        // Kön markeras av fbmejl_ta_emot(), inte här. Den vet om raden blev
        // en rapport, en dubblett eller stoppades av nykterhetsnätet, och den
        // skillnaden ska stå i fbmejl_ko.skal.
        rapporter.push(...s.rapporter);
        continue;
      }

      if (s.fel.length) {
        // Geokodningen svarade inte. Nätverksfel, inte ett avgörande.
        aterforsok.push(m.messageId);
        console.warn(`Återförsök för ${m.messageId}: ${s.fel.join(' · ')}`);
        continue;
      }

      if (s.dubbletter) {
        dubbletter++;
        lagg(avfarda, SKAL.DUBBLETT, m.messageId);
        continue;
      }

      // Ett skäl per mejl, eftersom vi kör ett mejl per anrop.
      const skal = Object.keys(s.bortsorterade)[0] ?? 'bortsorterad';
      lagg(avfarda, skal, m.messageId);
    }

    let db: unknown = null;
    if (rapporter.length) {
      // Notisen skickas av fbmejl_ta_emot() via fbmejl_notis_ut(), inte
      // härifrån. En omgång = en notis; ringde den här funktionen själv blev
      // det en notis per rapport, och då stänger användaren av notiser för
      // hela appen. Se avsnittet NOTISER: TAKTEN i supabase/fbmejl.sql.
      db = await rpc('fbmejl_ta_emot', { p_rader: rapporter });
    }

    // Allt som INTE blev en rapport och inte ska försökas igen måste markeras,
    // annars plockas det upp varje minut tills forsok slår i taket och det
    // dyker upp som "fastnade" i fbmejl_halsa.
    //
    // Skälet skickas med rakt — fbmejl_ko_avfard() sätter status 'vagrad' för
    // 'nykterhet' och 'kamera', och 'klar' för allt annat.
    for (const [skal, idn] of avfarda) {
      await rpc('fbmejl_ko_avfard', { p_message_ids: idn, p_skal: skal });
    }

    const rad = `${mejl.length} mejl · ${rapporter.length} varningar` +
      (dubbletter ? ` · ${dubbletter} redan inne` : '') +
      (aterforsok.length ? ` · ${aterforsok.length} återförsök` : '') +
      (okandaPlatser.length ? ` · okänd plats: ${okandaPlatser.join(', ')}` : '');
    console.log(rad, JSON.stringify(db));

    return Response.json({
      ok: true,
      lasta: mejl.length,
      skapade: rapporter.length,
      dubbletter,
      aterforsok: aterforsok.length,
      avfardade: [...avfarda].map(([skal, idn]) => [skal, idn.length]),
      okandaPlatser,
      databas: db,
    });
  } catch (e) {
    // Felet skrivs INTE till fbmejl_brygga, och det är ett medvetet val.
    //
    // Frestelsen är att anropa fbmejl_satt_lage() med p_fel. Men den
    // funktionen sätter också senast_kord = now(), och det fältet betyder
    // "POLLAREN körde". Skriver tömmaren i det ser fbmejl_halsa frisk ut med
    // avseende på pollningen även när ägarens dator har sovit i ett dygn —
    // alltså exakt det fel hälsovyn finns för att fånga.
    //
    // Signalen att tömmaren är trasig är istället liggande_i_ko, som växer.
    // Det är den vyn pekar ut i sin egen kommentar, och den ljuger inte.
    const fel = e instanceof Error ? e.message : String(e);
    console.error(fel);
    return Response.json({ ok: false, fel }, { status: 500 });
  }
});

/** Lägg ett message_id i rätt skäl-hög. */
function lagg(karta: Map<string, string[]>, skal: string, id: string) {
  const lista = karta.get(skal);
  if (lista) lista.push(id);
  else karta.set(skal, [id]);
}
