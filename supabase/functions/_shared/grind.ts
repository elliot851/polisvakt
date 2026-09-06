// Polisvakt — delad grind för edge-funktionerna
//
// Mappar under supabase/functions/ som börjar med understreck deployas INTE
// som egna funktioner: de buntas in i de funktioner som importerar dem. Det är
// därför det här får vara en fil och inte tre kopior. Jämförelsen av en
// hemlighet är precis den sortens kod som inte får finnas i tre utgåvor — en
// rättning som bara görs på två av dem lämnar den tredje öppen, och inget i
// någon logg säger vilken.
//
// Importeras som:  import { likaHemlighet } from '../_shared/grind.ts';

/* ==================== KONSTANTTIDSJÄMFÖRELSE ======================== */

/**
 * En nyckel som slumpas vid uppstart och aldrig lämnar processen.
 *
 * Skapas lat, inte på toppnivå, så att modulen inte behöver top-level await.
 */
let hmacNyckel: Promise<CryptoKey> | null = null;

function nyckel(): Promise<CryptoKey> {
  if (!hmacNyckel) {
    hmacNyckel = crypto.subtle.importKey(
      'raw',
      crypto.getRandomValues(new Uint8Array(32)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return hmacNyckel;
}

async function fingeravtryck(v: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await nyckel(), new TextEncoder().encode(v));
  return new Uint8Array(sig);
}

/**
 * Jämför två hemligheter utan att läcka något via tiden det tar.
 *
 * `a === b` på strängar avbryter vid första tecknet som skiljer. Skillnaden är
 * nanosekunder, men den är mätbar över tillräckligt många försök, och mot en
 * endpoint som ligger öppen på internet kan en angripare göra hur många försök
 * som helst. Med ett sådant orakel gissas hemligheten fram tecken för tecken
 * i stället för att behöva gissas hel — skillnaden mellan omöjligt och en
 * eftermiddag.
 *
 * Båda sidorna hashas först, så jämförelsen går alltid över exakt 32 byte.
 * Annars hade själva LÄNGDEN på hemligheten läckt ut genom hur lång loopen är,
 * och längden är halva jobbet för den som ska gissa.
 *
 * HMAC med en nyckel som slumpas vid uppstart, inte rå SHA-256: då kan ingen
 * förberäkna digesten av en gissning och känna igen den någon annanstans.
 */
export async function likaHemlighet(a: string, b: string): Promise<boolean> {
  // En tom hemlighet är aldrig en giltig hemlighet. Utan den här raden blir en
  // osatt miljövariabel en nyckel som alla känner till: tomma strängen.
  if (!a || !b) return false;
  const [x, y] = await Promise.all([fingeravtryck(a), fingeravtryck(b)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Duger token mot NÅGON av nycklarna?
 *
 * Ingen tidig retur. Hela listan gås alltid igenom, annars läcker POSITIONEN
 * i listan ut genom svarstiden — vilket i praktiken avslöjar vilken av
 * nycklarna som är i bruk.
 */
export async function nagonLikaHemlighet(token: string, nycklar: string[]): Promise<boolean> {
  let traff = false;
  for (const k of nycklar) {
    if (await likaHemlighet(token, k)) traff = true;
  }
  return traff;
}

/* ======================= KROPPEN, MED TAK =========================== */

/**
 * Läs kroppen, men aldrig mer än maxByte.
 *
 * `await req.text()` har inget tak. Den som skickar en kropp på en gigabyte
 * får funktionen att svälja hela innan en enda rad av vår kod kör — och på
 * stripe-webhook går det att göra HELT utan att legitimera sig, eftersom
 * kroppen måste läsas innan signaturen kan verifieras. Ett tak gör den
 * attacken till en 413.
 *
 * Content-length kollas först eftersom det är gratis, men det går att ljuga
 * om, så strömmen räknas också medan den läses.
 *
 * @returns texten, eller null när taket sprängdes.
 */
export async function lasKropp(req: Request, maxByte: number): Promise<string | null> {
  const angiven = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(angiven) && angiven > maxByte) return null;

  const strom = req.body;
  if (!strom) return '';

  const bitar: Uint8Array[] = [];
  let summa = 0;
  const lasare = strom.getReader();
  try {
    for (;;) {
      const { done, value } = await lasare.read();
      if (done) break;
      if (!value) continue;
      summa += value.byteLength;
      if (summa > maxByte) {
        await lasare.cancel();
        return null;
      }
      bitar.push(value);
    }
  } finally {
    try { lasare.releaseLock(); } catch { /* redan släppt av cancel() */ }
  }

  const allt = new Uint8Array(summa);
  let i = 0;
  for (const b of bitar) { allt.set(b, i); i += b.byteLength; }
  return new TextDecoder().decode(allt);
}

/**
 * Läs kroppen som ett JSON-OBJEKT, med tak.
 *
 * Allt som inte är ett objekt — `null`, en lista, en sträng, trasig JSON —
 * blir ett tomt objekt. JSON-kroppen `null` passerar nämligen JSON.parse men
 * gör varje fältuppslag till ett TypeError, alltså en ohanterad 500 på en
 * kropp som vem som helst kan skicka.
 *
 * @returns objektet, eller null när taket sprängdes (då ska anroparen svara 413).
 */
export async function lasKroppObjekt(
  req: Request,
  maxByte: number,
): Promise<Record<string, unknown> | null> {
  const text = await lasKropp(req, maxByte);
  if (text === null) return null;
  if (!text.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(text); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}
