// Polisvakt — gruppnotisen ut på riktigt (Supabase Edge Function, Deno)
//
// Anropas av public.fbmejl_notis_ut() via pg_net när en omgång Facebook-mejl
// blivit minst en NY rapport. Kroppen ser ut så här:
//
//   { "titel": "Polis vid Erikslund",
//     "text":  "Ny rapport från gruppen. Öppna Polisvakt för att se var.",
//     "tag":   "polisvakt-grupp",
//     "url":   "./",
//     "antal": 1 }
//
// -------------------------------------------------------------------------
// DET VIKTIGASTE I HELA FILEN: översättningen av fältnamnen
//
// Databasen skickar titel och text. Push-lyssnaren i sw.js läser title och
// body. Skickar man kroppen vidare orörd hittar sw.js varken title eller body
// och faller tillbaka på sina standardvärden — alltså visas
//
//     Polisvakt
//     Dags att köra?
//
// på varje gruppnotis. En notis med rätt ikon, rätt tag och rätt
// klickbeteende, som ser fullständigt normal ut, och som säger fel sak. Den
// felar inte i någon logg: pushtjänsten svarar 201, edge-funktionen svarar
// 200, fbmejl_notis_logg får 'kvitterad'. Det enda som avslöjar den är att
// någon läser sin egen låsskärm och undrar.
//
// Översättningen sker HÄR, i byggNyttolast(). sw.js är numera härdad att tåla
// båda formerna, men det är ett skyddsnät, inte kontraktet. Kontraktet är att
// den här funktionen skickar { title, body, tag, url }.
//
// -------------------------------------------------------------------------
// Byggd som en kopia av send-reminder/index.ts, med tre skillnader:
//
//   1. Mottagarna hämtas med fbmejl_push_mottagare (alla som slagit på
//      gruppnotiser) istället för due_push_reminders (de som brukar köra nu).
//   2. Texten byggs INTE här. Den kommer i anropets kropp, färdig, och är
//      redan begränsad till typ plus plats av databasen. Ingen råtext ur ett
//      Facebook-inlägg får någonsin nå en låsskärm — se avsnittet
//      NOTISER: TEXTEN i supabase/fbmejl.sql.
//   3. Ingen mark_push_sent. Det finns ingen lucka att bränna här; spärrarna
//      sitter i fbmejl_notis_ut() och har redan räknats upp när vi anropas.
//
// Kryptobiblioteket och resonemanget bakom det är detsamma som i
// send-reminder — läs kommentaren överst i den filen, den gäller ordagrant.
//
// -------------------------------------------------------------------------
// Hemligheter (supabase secrets set):
//
//   VAPID_KEYS      hela JSON-utskriften från generate-vapid-keys.ts
//   VAPID_SUBJECT   mailto:din@adress.se
//
// DE TVÅ ÄR SANNOLIKT REDAN SATTA. Hemligheter i Supabase är gemensamma för
// hela projektet, inte per funktion, och send-reminder använder samma två.
// Sattes de när körpåminnelsen rullades ut gäller de här funktionen också, och
// då ska INGA nya VAPID-nycklar genereras: en ny nyckel gör varje befintlig
// prenumeration ogiltig, och då tystnar körpåminnelsen. Se docs/notiskedjan.md,
// avsnittet om nycklarna, innan du rör dem.
//
// SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY injiceras av plattformen.
//
//   FBMEJL_ANROPSNYCKEL   REKOMMENDERAD. En egen lång slumpad sträng, bara
//                         för det här anropet. Se nedan.
//
// Anroparen legitimerar sig med en nyckel i Authorization-huvudet. Vilken
// nyckel den plockar upp bestäms av public.fbmejl_anropsnyckel() i
// supabase/fbmejl.sql, som läser i den här ordningen:
//
//   1. valvet, hemligheten som heter fbmejl_anropsnyckel
//   2. valvet, hemligheten som heter service_role_key
//   3. current_setting('app.fbmejl_anropsnyckel') respektive
//      current_setting('app.service_role_key'), den gamla vägen
//
// FÖRSTA VÄGEN ÄR DEN SOM SKA ANVÄNDAS, och det är ett val med skäl. Sätt
// FBMEJL_ANROPSNYCKEL här och samma sträng i valvet under namnet
// fbmejl_anropsnyckel:
//
//   * Den roteras utan att röra något annat i projektet. Service role-nyckeln
//     bärs av varje jobb och skript; den här bärs av ett anrop.
//   * Läcker den kostar den mindre. Service role-nyckeln går förbi all
//     radsäkerhet i hela databasen. Den här kan skicka en gruppnotis — illa
//     nog, se kontrollen i Deno.serve() nedan, men en skada med en botten.
//   * Den har ingen andra utgåva att förväxlas med, vilket är precis den
//     fälla som beskrivs vid TILLATNA_ANROPSNYCKLAR nedan.
//
// Databasinställningarna i steg 3 finns kvar för bakåtkompatibilitet. På ett
// Supabase-projekt går de INTE att sätta: SQL-editorn kör som rollen postgres,
// som inte är superuser, och alter database ... set svarar 42501. Se
// docs/notiskedjan.md.

import * as webpush from 'jsr:@negrel/webpush@0.5.0';

/* ========================== KONFIGURATION =========================== */

const VAPID_KEYS = Deno.env.get('VAPID_KEYS') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';

/**
 * Vilka nycklar duger för att ANROPA funktionen?
 *
 * SERVICE_ROLE ovan används mot databasen och injiceras av plattformen. Att
 * kräva exakt den strängen också i Authorization-huvudet är den självklara
 * lösningen — och den har en fälla som kostar en hel felsökningskväll.
 *
 * Projektet har nya API-nycklar (js/config.js bär en sb_publishable-nyckel).
 * Dashboarden visar då både den nya hemliga nyckeln och den gamla JWT:n, och
 * plattformen injicerar EN av dem i SUPABASE_SERVICE_ROLE_KEY. Lägger man den
 * andra i valvet svarar funktionen 401 på varje anrop. I fbmejl_notis_logg
 * står det då 'fel' med "HTTP 401", och ingenting säger att de två nycklarna
 * bara är olika utgåvor av samma behörighet.
 *
 * Därför: alla nycklar vi känner till duger, och en egen hemlighet
 * FBMEJL_ANROPSNYCKEL går att sätta — den är numera den rekommenderade
 * vägen, se hemlighetslistan överst i filen. Listan filtreras på längd så en
 * tom miljövariabel aldrig kan bli en giltig tom nyckel — det vore ett öppet
 * API.
 */
const MIN_NYCKELLANGD = 20;

const TILLATNA_ANROPSNYCKLAR = [
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  Deno.env.get('SERVICE_ROLE_KEY') ?? '',
  Deno.env.get('FBMEJL_ANROPSNYCKEL') ?? '',
].filter((k) => k.length >= MIN_NYCKELLANGD);

/**
 * En satt men för kort nyckel är värre än ingen nyckel alls.
 *
 * Längdfiltret ovan är rätt, men det är TYST. Sätter ägaren
 * FBMEJL_ANROPSNYCKEL till något kort — en handskriven sträng istället för en
 * slumpad — faller den ur listan, databasen skickar den lydigt, och svaret
 * blir 401 på en nyckel som ser precis rätt ut i båda ändarna. Det felet är
 * osynligt i allt utom den här raden.
 *
 * Loggas vid uppstart, med namn och LÄNGD. Aldrig värdet.
 */
for (const namn of ['SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY', 'FBMEJL_ANROPSNYCKEL']) {
  const v = Deno.env.get(namn) ?? '';
  if (v.length > 0 && v.length < MIN_NYCKELLANGD) {
    console.error(
      `${namn} är satt men bara ${v.length} tecken lång och räknas därför inte. ` +
        `Minst ${MIN_NYCKELLANGD} krävs. Sätt en längre sträng, i BÅDA ändarna: här och i valvet.`,
    );
  }
}
if (TILLATNA_ANROPSNYCKLAR.length === 0) {
  console.error(
    'INGEN giltig anropsnyckel i miljön — varje anrop kommer att nekas med 401. ' +
      'Sätt FBMEJL_ANROPSNYCKEL. Se docs/notiskedjan.md.',
  );
}

/**
 * Livslängd på pushen hos pushtjänsten.
 *
 * Trettio minuter, mot varningarnas egen livslängd i js/store.js: polis 45
 * min, trafikkontroll 60, civil 30. En gruppnotis som dyker upp när varningen
 * den handlar om redan är borttagen från kartan är sämre än ingen notis alls
 * — nästa gång tror man inte på den.
 */
const TTL_SEK = 30 * 60;

/** Hur många skickas samtidigt. Samma resonemang som i send-reminder. */
const SAMTIDIGA = 10;

/** Tak per körning, så ett felaktigt svar aldrig kan bli ett massutskick. */
const MAX_PER_KORNING = 2000;

/** Största nyttolast innan kryptering. Se send-reminder för uträkningen. */
const MAX_PAYLOAD = 3800;

/** Vad sw.js visar om vi skickar en tom titel. Aldrig önskvärt. */
const TITEL_RESERV = 'Ny varning i gruppen';
const TEXT_RESERV = 'Öppna Polisvakt för att se var på kartan.';

/* ============================== TYPER =============================== */

type Prenumeration = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type Kropp = {
  titel?: unknown;
  text?: unknown;
  tag?: unknown;
  url?: unknown;
  antal?: unknown;
  // Skickar någon redan rätt fältnamn tas de emot också. Kostar en rad och
  // gör funktionen möjlig att testa med curl utan att gissa svenska.
  title?: unknown;
  body?: unknown;
  dry?: unknown;
};

type Utfall = 'skickad' | 'borttagen' | 'fel' | 'hoppad';

/* ============================ DATABASEN ============================= */

/**
 * Databasanrop med service role-nyckeln.
 *
 * Måste vara service role: fbmejl_push_mottagare har uttryckligen fått
 * EXECUTE indraget från anon och authenticated i supabase/fbmejl.sql. Den
 * lämnar ut varje mottagares endpoint och auth-hemlighet, alltså precis det
 * som krävs för att skicka valfri notis i vårt namn.
 */
async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`rpc ${fn} gav ${r.status}: ${text.slice(0, 300)}`);
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

/* ============================== TEXTEN ============================== */

/** Trimmad sträng, eller null. Tomma strängar är inte texter. */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * Databasens fält -> service workerns fält.
 *
 * Det här är hela skälet till att den här funktionen inte bara kunde vara en
 * pass-through. Se kommentaren överst i filen.
 *
 * Längdgränserna är inte kosmetiska: Android klipper titeln runt 65 tecken
 * och brödtexten runt 240, och en avhuggen plats ("Polis vid Björnöv…") är
 * värre än en kort. Databasen kapar redan platsen till 60, men den som
 * anropar funktionen med curl gör det inte.
 */
function byggNyttolast(k: Kropp) {
  return {
    title: (str(k.titel) ?? str(k.title) ?? TITEL_RESERV).slice(0, 80),
    body: (str(k.text) ?? str(k.body) ?? TEXT_RESERV).slice(0, 240),
    // Samma tag varje gång: en ny gruppnotis ERSÄTTER den gamla i luren
    // istället för att lägga sig ovanpå. Databasen skickar 'polisvakt-grupp'.
    tag: (str(k.tag) ?? 'polisvakt-grupp').slice(0, 60),
    url: (str(k.url) ?? './').slice(0, 300),
  };
}

/* ============================ UTSKICKET ============================= */

async function skicka(
  server: webpush.ApplicationServer,
  p: Prenumeration,
  nyttolast: string,
): Promise<Utfall> {
  const mottagare = server.subscribe({
    endpoint: p.endpoint,
    keys: { p256dh: p.p256dh, auth: p.auth },
  });

  try {
    await mottagare.pushTextMessage(nyttolast, {
      // High: en varning som ligger och väntar på att telefonen ändå vaknar
      // är ingen varning. Samma val som i send-reminder.
      urgency: webpush.Urgency.High,
      ttl: TTL_SEK,
      // Topic får pushtjänsten att ERSÄTTA ett tidigare oöppnat meddelande
      // med samma ämne istället för att lägga det på hög. Det är den andra
      // halvan av buntspärren: skulle två omgångar hinna gå ut innan
      // telefonen varit online ser användaren den senaste, inte båda.
      // Max 32 tecken enligt RFC 8030.
      topic: 'pvgrupp',
    });
  } catch (e) {
    return await hanteraFel(p, e);
  }
  return 'skickad';
}

/**
 * Vad felet betyder, och vad som ska göras åt det.
 *
 * Ordagrant samma logik som send-reminder, och det är med flit: prenumera-
 * tionerna är SAMMA rader i samma tabell. Skulle den här funktionen radera på
 * en annan signal än påminnelsefunktionen tappar användaren körpåminnelsen
 * också, och orsaken hade varit en gruppnotis hen aldrig såg.
 */
async function hanteraFel(p: Prenumeration, e: unknown): Promise<Utfall> {
  const status = (e as { response?: Response })?.response?.status ?? 0;
  const text = e instanceof Error ? e.message || String(e) : String(e);

  // 404 Not Found och 410 Gone: prenumerationen finns inte längre och blir
  // aldrig giltig igen.
  if (status === 404 || status === 410) {
    await rpc('drop_push_subscription', { p_endpoint: p.endpoint });
    return 'borttagen';
  }

  // 429: vi skickar för fort. Felräknaren rörs INTE — det är vårt fel, inte
  // den här telefonens, och fem 429 i rad ska inte stänga av en fungerande
  // prenumerant.
  if (status === 429) {
    const efter = (e as { response?: Response })?.response?.headers.get('retry-after');
    console.warn(`429 från ${new URL(p.endpoint).host}, retry-after=${efter ?? 'saknas'}`);
    await rpc('note_push_failure', {
      p_endpoint: p.endpoint, p_error: `429 retry-after=${efter ?? '?'}`, p_count: false,
    });
    return 'fel';
  }

  // 400 och 403 betyder normalt fel VAPID-nyckel eller fel subject — ett
  // konfigurationsfel som gäller ALLA, inte den här raden.
  if (status === 400 || status === 403) {
    console.error(`KONFIGURATIONSFEL ${status} från ${new URL(p.endpoint).host}: ${text}. Kolla VAPID_KEYS och VAPID_SUBJECT.`);
  }

  await rpc('note_push_failure', {
    p_endpoint: p.endpoint, p_error: `${status || 'nät'}: ${text}`, p_count: true,
  });
  return 'fel';
}

/** Kör i grupper istället för allt på en gång. Se SAMTIDIGA. */
async function iGrupper(
  server: webpush.ApplicationServer,
  rader: Prenumeration[],
  nyttolast: string,
): Promise<Record<Utfall, number>> {
  const summa: Record<Utfall, number> = { skickad: 0, borttagen: 0, fel: 0, hoppad: 0 };

  for (let i = 0; i < rader.length; i += SAMTIDIGA) {
    const grupp = rader.slice(i, i + SAMTIDIGA);
    const svar = await Promise.allSettled(grupp.map((p) => skicka(server, p, nyttolast)));
    for (const s of svar) {
      if (s.status === 'fulfilled') summa[s.value]++;
      else {
        summa.fel++;
        console.error('Ohanterat fel vid utskick:', s.reason);
      }
    }
  }
  return summa;
}

/* ============================== SERVERN ============================= */

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Endast POST', { status: 405 });

  if (!VAPID_KEYS || !VAPID_SUBJECT || !SUPABASE_URL || !SERVICE_ROLE) {
    console.error('Saknade miljövariabler — kolla supabase secrets list');
    return new Response('Servern är inte konfigurerad', { status: 500 });
  }

  /**
   * Vem får anropa?
   *
   * Supabase kräver som standard en giltig JWT, men ANON-nyckeln räknas som
   * giltig — och den ligger öppet i appens källkod (js/config.js). Utan
   * kontrollen nedan kan alltså vem som helst som läst källkoden skicka
   * valfri text till varenda telefon som slagit på gruppnotiser. Det är den
   * värsta buggen den här funktionen kan ha, värre än att den inte fungerar
   * alls, för den skulle vara osynlig i alla loggar.
   *
   * Anroparen är fbmejl_notis_ut() via pg_net, som sätter huvudet från
   * public.fbmejl_anropsnyckel() — normalt hemligheten fbmejl_anropsnyckel i
   * valvet. Bara en nyckel ur listan ovan duger.
   */
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !TILLATNA_ANROPSNYCKLAR.some((k) => k === token)) {
    // Diagnosen, utan att logga en hemlighet.
    //
    // Ett 401 utan förklaring ser exakt likadant ut oavsett om anroparen är
    // en främling eller om ägaren råkat lägga fel utgåva av sin egen nyckel i
    // valvet. Det ena kräver ingenting, det andra kräver
    // en rättning — och skillnaden syns i FORMEN och LÄNGDEN, inte i
    // innehållet. Nycklarnas tre första tecken skiljer 'eyJ' (JWT) från
    // 'sb_' (ny hemlig nyckel), och det räcker för att se felet.
    console.error(
      'Nekat anrop. Fick nyckel av formen "' + (token.slice(0, 3) || 'ingen') +
      '" med längd ' + token.length + '. Godtar ' + TILLATNA_ANROPSNYCKLAR.length +
      ' nyckel/nycklar av formen ' +
      TILLATNA_ANROPSNYCKLAR.map((k) => '"' + k.slice(0, 3) + '" (' + k.length + ')').join(', ') +
      '. Stämmer längden men inte nyckeln är det en annan nyckel; skiljer formen är det fel ' +
      'utgåva — se docs/notiskedjan.md.',
    );
    return new Response('Nekad', { status: 401 });
  }

  let kropp: Kropp = {};
  try { kropp = await req.json(); } catch { /* tom kropp hanteras nedan */ }

  const data = byggNyttolast(kropp);
  const nyttolast = JSON.stringify(data);

  if (nyttolast.length > MAX_PAYLOAD) {
    // RFC 8291 §4 garanterar 4096 byte krypterad kropp. Kommer vi hit har
    // någon lagt till ett fält, inte skrivit en lång plats.
    console.error(`Nyttolasten är ${nyttolast.length} byte — pushtjänsten svarar 413.`);
    return Response.json({ ok: false, fel: 'nyttolast for stor' }, { status: 400 });
  }

  let rader: Prenumeration[] = [];
  try {
    rader = (await rpc<Prenumeration[]>('fbmejl_push_mottagare', {
      p_limit: MAX_PER_KORNING,
    })) ?? [];
  } catch (e) {
    console.error('Kunde inte hämta mottagare:', (e as Error).message);
    return new Response('Databasen svarar inte', { status: 500 });
  }

  // Torrkörning: svara med VAD som skulle skickats och till hur många, utan
  // endpoints — de är hemligheter och ska aldrig ut ur funktionen.
  if (kropp.dry) {
    return Response.json({ ok: true, dry: true, mottagare: rader.length, notis: data });
  }

  if (!rader.length) {
    // Ska inte hända: fbmejl_notis_ut() kollar fbmejl_gruppnotis_antal() och
    // skickar ingenting när svaret är noll. Kommer vi ändå hit har någon
    // stängt av sina notiser i sekunderna emellan, eller så anropades
    // funktionen för hand. Svaret hamnar i fbmejl_notis_logg.skal.
    console.warn('Noll mottagare med gruppnotiser på — ingenting skickades.');
    return Response.json({ ok: true, mottagare: 0, skickade: 0, borttagna: 0, fel: 0 });
  }

  // Nytt ECDH-nyckelpar per körning. Se noten om RFC 8291 §2 i send-reminder.
  let server: webpush.ApplicationServer;
  try {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(VAPID_KEYS), { extractable: false });
    server = await webpush.ApplicationServer.new({
      contactInformation: VAPID_SUBJECT,
      vapidKeys,
    });
  } catch (e) {
    // Nästan alltid felformaterad VAPID_KEYS. Måste vara hela JSON-objektet
    // med publicKey och privateKey i JWK-form, inte base64-strängen.
    console.error('Kunde inte läsa VAPID-nycklarna:', (e as Error).message);
    return new Response('Trasiga VAPID-nycklar', { status: 500 });
  }

  const summa = await iGrupper(server, rader, nyttolast);
  console.log(`Gruppnotis "${data.title}": ${JSON.stringify(summa)}`);

  // Svaret läses av public.fbmejl_notis_stam_av(), som lägger det i
  // fbmejl_notis_logg.skal — kapat till 200 tecken. Håll det kort och håll
  // talen först, så de överlever kapningen. Det här är den enda plats där
  // frågan "nådde notisen fram?" får ett svar som går att spara.
  //
  // OCH: fem tal, ingenting annat. Aldrig ett värde ur Deno.env, aldrig ett
  // eko av inkommande huvuden, aldrig en endpoint. Allt som står här hamnar i
  // en tabell som följer med i varje backup. Databassidan maskar visserligen
  // nyckelformer innan den sparar — se fbmejl_dolj_hemligheter() i
  // supabase/fbmejl.sql — men det är ett skyddsnät mot att adressen pekar på
  // NÅGON ANNANS server. Det är inte en ursäkt för att skriva något känsligt
  // här.
  return Response.json({
    ok: true,
    mottagare: rader.length,
    skickade: summa.skickad,
    borttagna: summa.borttagen,
    fel: summa.fel,
  });
});
