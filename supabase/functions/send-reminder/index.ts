// Polisvakt — påminnelser via Web Push (Supabase Edge Function, Deno)
//
// Den här funktionen är hela skälet till att körningsdetekteringen i
// js/driving.js är värd något. Detektorn lär sig att du nästan alltid kör
// 07:20 på vardagar, men den kan bara säga till medan appen ligger framme —
// och den som redan har appen öppen behöver ingen påminnelse. Notisen måste
// komma utifrån, medan telefonen ligger i fickan. Det kan bara en server göra.
//
// Anropas var femte minut av ett schema. Varje körning:
//   1. frågar databasen vilka som brukar köra om en kvart (due_push_reminders)
//   2. krypterar en notis per person och skickar den till pushtjänsten
//   3. städar bort prenumerationer som pushtjänsten säger är döda
//
// -------------------------------------------------------------------------
// Om kryptobiblioteket, och varför just det:
//
//   jsr:@negrel/webpush — implementerar RFC 8291 (kryptering) och RFC 8292
//   (VAPID) med enbart Web Crypto (SubtleCrypto). Inga Node-beroenden alls.
//
// Alternativet hade varit npm:web-push, som är standarden i Node-världen. Den
// valdes bort med flit: web-push bygger på node:crypto och node:https, som i
// Deno bara finns via kompatibilitetslagret. Det lagret är bra men inte
// komplett, och den som får fel här får inte ett undantag — hen får en push
// som pushtjänsten accepterar med 201 och som telefonen sedan tyst slänger,
// för att den inte gick att dekryptera. Ett fel utan felmeddelande, i en
// funktion som kör var femte minut utan att någon tittar. Ett bibliotek som
// använder samma Web Crypto-primitiver som körtiden själv tar bort hela den
// klassen av problem.
//
// Nyckelhärledningen i biblioteket är kontrollerad rad för rad mot
// pseudokoden i RFC 8291 §3.4:
//   PRK_key  = HMAC-SHA-256(auth_secret, ecdh_secret)
//   key_info = "WebPush: info" || 0x00 || ua_public || as_public
//   IKM      = HMAC-SHA-256(PRK_key, key_info || 0x01)
// följt av aes128gcm enligt RFC 8188. Det stämmer.
//
// Två saker att vara ärlig om:
//
//   - Biblioteket skriver själv i sin README att det inte granskats av
//     kryptografer. Det är sant om nästan alla web push-bibliotek, men det
//     ska stå någonstans, och nu står det här.
//   - RFC 8291 §2 beskriver att servern genererar ett ECDH-nyckelpar per
//     meddelande. Biblioteket genererar ett per ApplicationServer-objekt.
//     Saltet är däremot slumpat per meddelande, och det är saltet som gör
//     nyckel och nonce unika, så återanvändning av nyckelparet ger ingen
//     nonce-återanvändning. För säkerhets skull byggs objektet om vid varje
//     anrop nedan istället för att ligga kvar mellan körningar — en P-256-
//     nyckelgenerering kostar under en millisekund, och då roterar nyckeln
//     var femte minut istället för per kallstart.
//
// -------------------------------------------------------------------------
// Deploy och hemligheter: se docs/NOTISER.md.
//
//   VAPID_KEYS      hela JSON-utskriften från generate-vapid-keys.ts
//   VAPID_SUBJECT   mailto:din@adress.se — pushtjänsterna kontaktar den
//                   adressen om vi börjar bete oss illa
//   CRON_SECRET     slumpad sträng, måste matcha x-cron-secret-huvudet
//
// SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY injiceras av plattformen.

import * as webpush from 'jsr:@negrel/webpush@0.5.0';

/* ========================== KONFIGURATION =========================== */

const VAPID_KEYS = Deno.env.get('VAPID_KEYS') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';

/** Hur långt före den vanliga körtiden notisen ska komma. */
const FORVARNING_MIN = 15;

/**
 * Livslängd på pushen hos pushtjänsten.
 *
 * Kort med flit. Är telefonen avstängd eller utan täckning i en timme är
 * påminnelsen inte längre sann — personen har redan kört, eller låtit bli.
 * En notis som säger "dags att köra snart" och dyker upp vid lunch är sämre
 * än ingen notis alls, för nästa gång tror man inte på den.
 */
const TTL_SEK = 15 * 60;

/**
 * Hur många skickas samtidigt.
 *
 * Inte obegränsat. Pushtjänsterna svarar 429 på den som öppnar hundratals
 * anslutningar på en gång, och en 429 kostar oss hela den luckan för de
 * användarna — cron kommer tillbaka om fem minuter, men då har tidpunkten
 * passerat. Tio i taget är långsamt nog att aldrig trigga spärrarna och
 * snabbt nog att hinna igenom några tusen prenumeranter inom fönstret.
 */
const SAMTIDIGA = 10;

/** Tak per körning, så en felaktig fråga aldrig kan bli ett massutskick. */
const MAX_PER_KORNING = 500;

/**
 * Största nyttolast innan kryptering.
 *
 * RFC 8291 §4 garanterar att pushtjänsten tar emot 4096 byte krypterad kropp.
 * aes128gcm lägger på 86 byte header och 16 byte autentiseringstagg plus en
 * avgränsare, så 3800 byte klartext är väl innanför med marginal. Vår
 * nyttolast är runt 150 byte — kontrollen finns för den dagen någon lägger
 * till ett fält och undrar varför pushen börjar ge 413.
 */
const MAX_PAYLOAD = 3800;

/* ============================== TYPER =============================== */

type Prenumeration = {
  endpoint: string;
  p256dh: string;
  auth: string;
  slot: number;
  hour: number;
  timezone: string;
};

type Utfall = 'skickad' | 'borttagen' | 'fel' | 'hoppad';

/* ============================ DATABASEN ============================= */

/**
 * Databasanrop med service role-nyckeln.
 *
 * Måste vara service role: funktionerna i supabase/push.sql har uttryckligen
 * fått EXECUTE indraget från anon och authenticated, eftersom
 * due_push_reminders lämnar ut varje användares endpoint och auth-hemlighet —
 * alltså precis det som krävs för att skicka valfri notis i vårt namn.
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

/**
 * Vad notisen säger.
 *
 * Copyn följer samma linje som resten av appen: sälj att hålla hastigheten,
 * inte att slippa böter. Vi lovar heller aldrig att det står en kontroll —
 * vi vet inte det. Det vi vet är att personen brukar köra nu och att appen
 * inte är igång.
 */
function notistext(p: Prenumeration) {
  const tid = `${String(p.hour).padStart(2, '0')}`;
  return {
    title: 'Dags att köra?',
    body: `Du brukar köra runt ${tid}. Slå på Polisvakt innan du åker, så håller du koll på hastigheten hela vägen.`,
    // Samma tagg som driving.js använder lokalt, så en push och en lokal
    // påminnelse aldrig kan hamna som två notiser bredvid varandra.
    tag: 'polisvakt-reminder',
    url: '/',
    slot: p.slot,
  };
}

/* ============================ UTSKICKET ============================= */

async function skicka(
  server: webpush.ApplicationServer,
  p: Prenumeration,
): Promise<Utfall> {
  const nyttolast = JSON.stringify(notistext(p));

  if (nyttolast.length > MAX_PAYLOAD) {
    console.error(`Nyttolasten är ${nyttolast.length} byte — pushtjänsten svarar 413. Korta texten.`);
    return 'hoppad';
  }

  const mottagare = server.subscribe({
    endpoint: p.endpoint,
    keys: { p256dh: p.p256dh, auth: p.auth },
  });

  try {
    await mottagare.pushTextMessage(nyttolast, {
      // High: notisen ska visas nu, inte buntas ihop med nästa gång telefonen
      // ändå vaknar. Normal hade räckt tekniskt, men en påminnelse som kommer
      // tio minuter för sent är samma sak som ingen påminnelse.
      urgency: webpush.Urgency.High,
      ttl: TTL_SEK,
      // Topic får pushtjänsten att ersätta ett tidigare oöppnat meddelande
      // med samma ämne istället för att lägga det på hög. Skulle något gå
      // fel och två utskick ske för samma lucka ser användaren ändå en notis.
      // Max 32 tecken enligt RFC 8030.
      topic: `pv${p.slot}`,
    });
  } catch (e) {
    return await hanteraFel(p, e);
  }

  // Först EFTER kvittensen. Skrivs spärren före och pushen sedan misslyckas
  // är luckan förbrukad utan att någon notis kommit fram, och personen står
  // utan påminnelse just den dagen det gällde.
  await rpc('mark_push_sent', { p_endpoint: p.endpoint, p_slot: p.slot });
  return 'skickad';
}

/**
 * Vad felet betyder, och vad som ska göras åt det.
 *
 * Skillnaden mellan "död för alltid" och "dålig minut" är hela poängen med
 * den här funktionen. Raderar man på fel signal tappar man riktiga användare;
 * behåller man på rätt signal hamrar man mot en död adress var femte minut
 * tills pushtjänsten spärrar oss.
 */
async function hanteraFel(p: Prenumeration, e: unknown): Promise<Utfall> {
  const status = (e as { response?: Response })?.response?.status ?? 0;
  const text = e instanceof Error ? e.message || String(e) : String(e);

  // 404 Not Found och 410 Gone: prenumerationen finns inte längre. Appen är
  // avinstallerad, webbläsardata rensad, eller notiser avstängda i systemet.
  // Det går aldrig tillbaka — samma endpoint blir aldrig giltig igen.
  if (status === 404 || status === 410) {
    await rpc('drop_push_subscription', { p_endpoint: p.endpoint });
    return 'borttagen';
  }

  // 429 Too Many Requests: vi skickar för fort. Retry-After räknas i sekunder
  // eller som ett datum. Vi väntar inte in den här — cron kommer tillbaka om
  // fem minuter ändå — men den loggas, för återkommande 429 betyder att
  // SAMTIDIGA behöver sänkas och det syns inte på något annat sätt.
  if (status === 429) {
    const efter = (e as { response?: Response })?.response?.headers.get('retry-after');
    console.warn(`429 från ${new URL(p.endpoint).host}, retry-after=${efter ?? 'saknas'}`);
    // p_count: false — felräknaren rörs inte. Att bli rate limitad är vårt
    // fel, inte den här telefonens, och fem 429 i rad ska inte stänga av en
    // fullt fungerande prenumerant.
    await rpc('note_push_failure', {
      p_endpoint: p.endpoint, p_error: `429 retry-after=${efter ?? '?'}`, p_count: false,
    });
    return 'fel';
  }

  // 400 och 403 betyder normalt fel VAPID-nyckel eller fel subject — alltså
  // ett konfigurationsfel som gäller ALLA, inte den här raden. Skriks ut i
  // loggen så det går att skilja från en enskild trasig telefon.
  if (status === 400 || status === 403) {
    console.error(`KONFIGURATIONSFEL ${status} från ${new URL(p.endpoint).host}: ${text}. Kolla VAPID_KEYS och VAPID_SUBJECT.`);
  }

  // Allt annat — 500, 503, timeout, nätet: tillfälligt. Räknaren höjs, och
  // efter fem fel i rad slutar raden komma med i frågan. Den ligger kvar och
  // nollställs så fort appen öppnas och prenumerationen sparas om.
  await rpc('note_push_failure', {
    p_endpoint: p.endpoint, p_error: `${status || 'nät'}: ${text}`, p_count: true,
  });
  return 'fel';
}

/** Kör i grupper istället för allt på en gång. Se SAMTIDIGA. */
async function iGrupper(
  server: webpush.ApplicationServer,
  rader: Prenumeration[],
): Promise<Record<Utfall, number>> {
  const summa: Record<Utfall, number> = { skickad: 0, borttagen: 0, fel: 0, hoppad: 0 };

  for (let i = 0; i < rader.length; i += SAMTIDIGA) {
    const grupp = rader.slice(i, i + SAMTIDIGA);
    const svar = await Promise.allSettled(grupp.map((p) => skicka(server, p)));
    for (const s of svar) {
      if (s.status === 'fulfilled') summa[s.value]++;
      else {
        // Hit kommer bara fel som skicka() inte redan fångat, t.ex. att
        // databasen gick ner mitt i. Loggas — raden får en ny chans nästa
        // körning eftersom spärren aldrig hann skrivas.
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
   * Två lås, och båda behövs. Supabase kräver som standard en giltig JWT för
   * att funktionen ska köras alls, vilket stoppar helt anonyma anrop — men
   * anon-nyckeln ligger öppet i appens källkod (js/config.js) och räknas som
   * giltig. Utan det andra låset kan alltså vem som helst som läst källkoden
   * trigga ett massutskick till samtliga användare, om och om igen.
   * CRON_SECRET är det som faktiskt skiljer schemaläggaren från allmänheten.
   */
  if (CRON_SECRET && req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('Nekad', { status: 401 });
  }
  if (!CRON_SECRET) {
    console.warn('CRON_SECRET är inte satt — vem som helst med anon-nyckeln kan trigga utskick.');
  }

  let kropp: { dry?: boolean; endpoint?: string; lead?: number } = {};
  try { kropp = await req.json(); } catch { /* tom kropp är normalfallet */ }

  // Nytt ECDH-nyckelpar per körning. Se noten om RFC 8291 §2 överst i filen.
  let server: webpush.ApplicationServer | null = null;
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

  let rader: Prenumeration[] = [];
  try {
    rader = (await rpc<Prenumeration[]>('due_push_reminders', {
      p_lead_minutes: Math.min(60, Math.max(0, kropp.lead ?? FORVARNING_MIN)),
      p_limit: MAX_PER_KORNING,
    })) ?? [];
  } catch (e) {
    console.error('Kunde inte hämta mottagare:', (e as Error).message);
    return new Response('Databasen svarar inte', { status: 500 });
  }

  // Testläge: skicka bara till en angiven endpoint, och bara om den ändå var
  // på tur. Se docs/NOTISER.md för hur man tvingar fram en riktig testpush.
  if (kropp.endpoint) rader = rader.filter((p) => p.endpoint === kropp.endpoint);

  if (kropp.dry) {
    // Torrkörning för felsökning: svara med vilka som VAR på tur, utan
    // endpoints — de är hemligheter och ska aldrig ut ur funktionen.
    return Response.json({
      ok: true, dry: true, antal: rader.length,
      luckor: rader.map((p) => ({ slot: p.slot, hour: p.hour, tz: p.timezone })),
    });
  }

  if (!rader.length || !server) return Response.json({ ok: true, antal: 0 });

  const summa = await iGrupper(server, rader);
  console.log(`Påminnelser: ${JSON.stringify(summa)}`);

  // Alltid 200 så länge funktionen kört klart. Ett 500 här hade fått
  // schemaläggaren att larma på något som redan är hanterat rad för rad —
  // enskilda misslyckanden syns i summan och i push_health istället.
  return Response.json({ ok: true, ...summa });
});
