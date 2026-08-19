// Riktiga push-notiser — de som kommer fram när appen är stängd.
//
// Varför det här behövs, och varför js/driving.js inte räcker:
//
// driving.js lär sig när du brukar köra och kan påminna dig. Men den kan bara
// göra det medan appen ligger framme, för en webbapp får varken läsa GPS eller
// köra en timer i bakgrunden. Påminnelsen "du glömde slå på Polisvakt" är
// värdelös om den bara visas i en app du redan har öppen. Hela poängen är att
// den ska plinga 07:15 på en tisdag, medan telefonen ligger i fickan och du är
// på väg mot bilen.
//
// Enda vägen dit är Web Push: telefonen håller en uppkoppling mot Google,
// Apple eller Mozillas pushtjänst även när appen är stängd, och vår server
// skickar meddelandet dit. Det är operativsystemet som väcker service workern,
// inte vi.
//
// Tre delar måste finnas för att det ska fungera:
//   1. Den här filen — ber om lov, prenumererar, skickar prenumerationen till
//      Supabase tillsammans med de tider du brukar köra.
//   2. supabase/push.sql — tabellen som håller prenumerationerna.
//   3. supabase/functions/send-reminder — schemalagd funktion som varje kvart
//      kollar vem som brukar köra strax och skickar pushen.
//
// Plus en fjärde sak som ligger i sw.js och som INTE finns i den här filen:
// en 'push'-lyssnare i service workern. Utan den kastas meddelandet bort.
// Se docs/NOTISER.md, avsnittet "Service workern".
//
// -------------------------------------------------------------------------
// Om iPhone, som är den stora fällan här:
//
// Safari på iOS stödjer Web Push, men BARA för appar som lagts till på
// hemskärmen, och bara från iOS 16.4. I en vanlig Safari-flik finns
// window.PushManager helt enkelt inte, oavsett hur ny telefonen är. Det
// betyder att en iPhone-användare som surfar in på sidan aldrig kan få
// notiser förrän hen tryckt Dela → Lägg till på hemskärmen och startat appen
// från ikonen.
//
// Det här går inte att koda sig runt. Det enda hederliga är att upptäcka läget
// och säga som det är, istället för att visa en knapp som inte gör något.
// Därför returnerar capabilities() nedan en förklaring på svenska istället för
// bara false.
// -------------------------------------------------------------------------

import { CONFIG, hasBackend, apiHeaders } from './config.js';

/**
 * Serverns publika VAPID-nyckel, i base64url (raw P-256, 65 byte → 87 tecken).
 *
 * Den här är publik med flit och hör hemma i klientkoden — den är webbläsarens
 * sätt att veta att pushen kommer från oss. Den privata halvan finns bara som
 * hemlighet i edge-funktionen och får aldrig hamna här.
 *
 * Fylls i efter `deno run .../generate-vapid-keys.ts`. Se docs/NOTISER.md.
 * Byts nyckeln måste ALLA prenumerationer göras om — därför står den bara på
 * ett ställe, och därför jämför vi mot den nedan innan vi återanvänder en
 * gammal prenumeration.
 */
export const VAPID_PUBLIC_KEY = '';

const KEY = 'pv.push.v1';

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

let vapidKey = VAPID_PUBLIC_KEY;

/** Låter inställningarna peka om till en testnyckel utan ombyggnad. */
export function configure({ vapidPublicKey } = {}) {
  if (vapidPublicKey) vapidKey = vapidPublicKey.trim();
  return vapidKey;
}

/* ========================= PLATTFORMSKOLL ========================== */

/** iPhone eller iPad? iPadOS 13+ ljuger och säger MacIntel. */
function isApple() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Startad från hemskärmsikonen, inte i en webbläsarflik? */
function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches === true ||
         window.navigator.standalone === true;
}

/**
 * iOS-version som [major, minor]. Null när den inte går att läsa.
 * En iPad som utger sig för att vara Mac saknar "OS 17_2" i user
 * agent-strängen, och då vet vi helt enkelt inte — vilket är bättre att
 * erkänna än att gissa.
 *
 * Två tal, inte ett decimaltal. Number("16.10") blir 16.1 och hade fått en
 * telefon på 16.10 att bedömas som äldre än 16.4.
 */
function iosVersion() {
  const m = /(?:iPhone )?OS (\d+)[._](\d+)/.exec(navigator.userAgent);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Har telefonen iOS 16.4 eller senare, alltså den första med Web Push? */
function iosMinstig(v) {
  return v === null || v[0] > 16 || (v[0] === 16 && v[1] >= 4);
}

/**
 * Går push att använda här, och om inte — varför?
 *
 * Returnerar alltid en förklaring som går att visa rakt av för användaren.
 * Tyst false är det värsta svaret: då står det en knapp som inte händer något
 * när man trycker på den.
 *
 * @returns {{supported:boolean, reason:string, fix:'hemskarm'|'uppdatera'|'webblasare'|'server'|null,
 *            apple:boolean, standalone:boolean, iosVersion:string|null}}
 */
export function capabilities() {
  const apple = isApple();
  const standalone = isStandalone();
  const ios = iosVersion();
  const base = {
    apple, standalone,
    iosVersion: ios ? `${ios[0]}.${ios[1]}` : null,
  };

  const har = 'serviceWorker' in navigator &&
              'PushManager' in window &&
              'Notification' in window;

  if (har) {
    if (!vapidKey) {
      return { ...base, supported: false, fix: 'server',
        reason: 'Notiser är inte påslagna i den här versionen av appen än.' };
    }
    return { ...base, supported: true, fix: null, reason: '' };
  }

  // Härifrån och ner: något saknas. Ge rätt förklaring, inte en generisk.
  if (apple) {
    if (!iosMinstig(ios)) {
      return { ...base, supported: false, fix: 'uppdatera',
        reason: 'iPhone kan ta emot notiser först från iOS 16.4. Uppdatera telefonen under Inställningar → Allmänt → Programuppdatering.' };
    }
    if (!standalone) {
      return { ...base, supported: false, fix: 'hemskarm',
        reason: 'På iPhone fungerar notiser bara när appen ligger på hemskärmen. Tryck på Dela-knappen i Safari, välj Lägg till på hemskärmen, och starta appen från ikonen — då dyker knappen upp här.' };
    }
    // Hemskärm och tillräckligt ny iOS, men API:et saknas ändå. Händer i
    // låst läge (skoltelefon/MDM) och i vissa EU-webbläsare på iOS.
    return { ...base, supported: false, fix: 'webblasare',
      reason: 'Telefonen tillåter inte notiser för webbappar. Är appen installerad via en annan webbläsare än Safari? Lägg till den från Safari istället.' };
  }

  return { ...base, supported: false, fix: 'webblasare',
    reason: 'Den här webbläsaren stödjer inte notiser när appen är stängd. Chrome, Edge, Firefox och Samsung Internet gör det.' };
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function permission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/* ============================ NYCKLAR ============================== */

/**
 * base64url → Uint8Array. pushManager.subscribe vägrar ta emot strängen.
 *
 * Notera padding-raden. VAPID-nycklar är 65 byte, vilket ger 87 base64-tecken
 * utan utfyllnad. atob kräver en längd delbar med fyra och kastar
 * InvalidCharacterError utan '='. Det är det vanligaste felet i den här
 * funktionen och det ser ut som en trasig nyckel när det egentligen är
 * saknad utfyllnad.
 */
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** ArrayBuffer → base64url, för p256dh och auth ur prenumerationen. */
function toBase64Url(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameKey(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* ============================= VANOR =============================== */

/**
 * Vanorna från driving.js översatta till nummer servern kan söka på.
 *
 * driving.js sparar "veckodag-timme" → antal. Servern behöver kunna svara på
 * "vilka prenumeranter brukar köra just nu, i sin egen tidszon" utan att
 * plocka isär text i varje rad. En platt siffra 0–167 (dag × 24 + timme) blir
 * en array med index på, och frågan blir en enda överlappsjämförelse.
 *
 * Veckodagsnumreringen är JavaScripts getDay(): 0 = söndag. Postgres extract
 * (dow) råkar använda exakt samma, vilket är hela skälet till att den här
 * kodningen valdes framför något smartare.
 *
 * @param {Record<string, number>} habits  detector.habits
 * @param {number} minCount  hur många gånger innan det räknas som en vana
 */
export function slotsFromHabits(habits, minCount = 3) {
  return Object.entries(habits || {})
    .filter(([, n]) => n >= minCount)
    .map(([k]) => {
      const [day, hour] = k.split('-').map(Number);
      return day * 24 + hour;
    })
    .filter(n => Number.isInteger(n) && n >= 0 && n < 168)
    .sort((a, b) => a - b);
}

/* ============================= SERVERN ============================= */

async function rpc(fn, args) {
  if (!hasBackend()) throw new Error('Ingen server konfigurerad');
  const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn} gav ${r.status}: ${text.slice(0, 200)}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Service workern, eller null om den inte kommer igång.
 *
 * navigator.serviceWorker.ready är ett löfte som ALDRIG avvisas. Är ingen
 * worker registrerad — för att registreringen misslyckades, eller för att
 * sidan öppnats från file:// — hänger det för alltid. Utan tidsgränsen
 * fastnar knappen i "laddar" och användaren får aldrig veta varför.
 */
function swReady(ms = 10000) {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return Promise.race([
    navigator.serviceWorker.ready.catch(() => null),
    new Promise(r => setTimeout(() => r(null), ms)),
  ]);
}

/** Tidszonen som IANA-namn, t.ex. "Europe/Stockholm". */
function timezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Stockholm'; }
  catch { return 'Europe/Stockholm'; }
}

/**
 * Skicka upp prenumerationen. Servern kan inte skicka något utan de här tre
 * fälten: endpoint säger vart, p256dh och auth är nycklarna meddelandet
 * krypteras med. auth är en delad hemlighet — därför får tabellen i
 * push.sql ingen läsregel alls.
 */
async function upload(sub, deviceId, slots) {
  const json = sub.toJSON();
  await rpc('save_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys?.p256dh ?? toBase64Url(sub.getKey('p256dh')),
    p_auth: json.keys?.auth ?? toBase64Url(sub.getKey('auth')),
    p_device: deviceId,
    p_timezone: timezone(),
    p_slots: slots ?? [],
  });
}

/* ============================== API ================================ */

/**
 * Slå på notiser.
 *
 * MÅSTE anropas direkt ur ett riktigt fingertryck. Både Safari och Chrome
 * kräver att Notification.requestPermission() ligger i samma uppgift som
 * klicket — lägger man en await före den raden (hämta något, läsa en fil)
 * hinner gesten gå ut och rutan visas aldrig. Därför står permission-frågan
 * först av allt här, och allt asynkront efter.
 *
 * @param {{deviceId:string, habits?:object, minCount?:number}} opts
 * @returns {Promise<{ok:boolean, reason?:string, fix?:string, endpoint?:string}>}
 */
export async function enable({ deviceId, habits, minCount = 3 } = {}) {
  const cap = capabilities();
  if (!cap.supported) return { ok: false, reason: cap.reason, fix: cap.fix };
  if (!deviceId) return { ok: false, reason: 'Saknar enhets-id.' };

  // Ingenting asynkront före den här raden. Se kommentaren ovan.
  let perm;
  try { perm = await Notification.requestPermission(); }
  catch { return { ok: false, reason: 'Webbläsaren kunde inte visa frågan om notiser.' }; }

  if (perm !== 'granted') {
    return {
      ok: false, fix: 'installningar',
      reason: perm === 'denied'
        ? 'Notiser är blockerade för appen. Slå på dem i telefonens inställningar — i webbläsaren går det inte att fråga igen.'
        : 'Du svarade inte på frågan. Tryck igen när du vill slå på påminnelser.',
    };
  }

  const reg = await swReady();
  if (!reg) return { ok: false, reason: 'Appens bakgrundstjänst startade inte. Ladda om sidan och försök igen.' };

  const wanted = urlBase64ToUint8Array(vapidKey);
  let sub = await reg.pushManager.getSubscription();

  /**
   * En prenumeration är låst till den VAPID-nyckel den skapades med. Har vi
   * bytt nyckel sedan sist kastar subscribe() InvalidStateError istället för
   * att göra om den. Utan den här hanteringen slutar notiserna fungera tyst
   * dagen nycklarna roteras.
   *
   * Nyckeln jämförs bara när webbläsaren faktiskt exponerar den. Äldre WebKit
   * lämnar applicationServerKey tom, och att tolka det som "fel nyckel" hade
   * gjort att varje tryck kastade en fungerande prenumeration och skapade en
   * ny endpoint. Där får istället InvalidStateError nedan bli signalen.
   */
  const gammalNyckel = sub?.options?.applicationServerKey;
  if (sub && gammalNyckel && !sameKey(gammalNyckel, wanted.buffer)) {
    try { await sub.unsubscribe(); } catch {}
    sub = null;
  }

  const nyPrenumeration = () => reg.pushManager.subscribe({
    // Obligatoriskt i Chrome. Betyder "varje push leder till en synlig notis"
    // — tyst push för att spåra användare är inte tillåtet, och det är inte
    // heller något vi vill göra.
    userVisibleOnly: true,
    applicationServerKey: wanted,
  });

  if (!sub) {
    try {
      sub = await nyPrenumeration();
    } catch (e) {
      // InvalidStateError: det finns en prenumeration med en annan nyckel som
      // vi inte kunde se. Kasta den och försök en gång till.
      if (e?.name === 'InvalidStateError') {
        try {
          const gammal = await reg.pushManager.getSubscription();
          await gammal?.unsubscribe();
          sub = await nyPrenumeration();
        } catch (e2) {
          return { ok: false, reason: `Prenumerationen misslyckades: ${e2.message}` };
        }
      } else {
        return { ok: false, reason: `Prenumerationen misslyckades: ${e.message}` };
      }
    }
  }

  const slots = slotsFromHabits(habits, minCount);
  try {
    await upload(sub, deviceId, slots);
  } catch (e) {
    // Prenumerationen finns i webbläsaren men servern vet inte om den, och då
    // kommer inga notiser. Städa upp istället för att låtsas att det gick.
    try { await sub.unsubscribe(); } catch {}
    return { ok: false, reason: `Servern tog inte emot prenumerationen: ${e.message}` };
  }

  // device sparas med, eftersom varje senare anrop måste kunna visa att raden
  // är vår — funktionerna i push.sql matchar på endpoint OCH device_id.
  save({ endpoint: sub.endpoint, device: deviceId, slots, at: Date.now() });
  return { ok: true, endpoint: sub.endpoint };
}

/**
 * Stäng av notiser. Tar bort raden på servern FÖRST — blir ordningen omvänd
 * och webbläsaren hinner släppa prenumerationen innan servern nås, ligger en
 * död rad kvar och pushas till tills pushtjänsten svarar 410.
 */
export async function disable() {
  const reg = await swReady();
  const sub = await reg?.pushManager.getSubscription();

  if (sub) {
    const st = load();
    try { await rpc('delete_push_subscription', { p_endpoint: sub.endpoint, p_device: st.device }); }
    catch { /* servern nere — vi tar bort lokalt ändå, cron städar på 410 */ }
    try { await sub.unsubscribe(); } catch {}
  }
  save({});
  return { ok: true };
}

/**
 * Nuvarande läge, för att rita inställningsrutan.
 * Sanningen läses ur webbläsaren, inte ur localStorage — användaren kan ha
 * återkallat tillståndet i systeminställningarna sedan sist.
 */
export async function status() {
  const cap = capabilities();
  const out = {
    ...cap,
    permission: permission(),
    subscribed: false,
    endpoint: null,
    slots: load().slots ?? [],
  };
  if (!cap.supported) return out;

  try {
    const reg = await swReady();
    const sub = await reg?.pushManager.getSubscription();
    out.subscribed = !!sub;
    out.endpoint = sub?.endpoint ?? null;
  } catch {}
  return out;
}

/**
 * Skicka upp nya vanor. Anropas när driving.js lärt sig något nytt.
 *
 * Tyst no-op när notiser inte är påslagna, så den går att anropa varje gång
 * en körning registreras utan att anroparen behöver kolla först.
 * Skickar bara när listan faktiskt ändrats — annars blir det ett anrop per
 * körning i onödan.
 */
export async function syncSlots(habits, minCount = 3) {
  const st = load();
  if (!st.endpoint || !st.device) return false;

  const slots = slotsFromHabits(habits, minCount);
  if (JSON.stringify(slots) === JSON.stringify(st.slots ?? [])) return false;

  try {
    await rpc('set_push_slots', {
      p_endpoint: st.endpoint, p_device: st.device,
      p_slots: slots, p_timezone: timezone(),
    });
    save({ ...st, slots });
    return true;
  } catch { return false; }
}

/**
 * "Jag kör redan." Anropas när driving.js upptäcker att bilen rullar.
 *
 * Det här är det som gör att påminnelsen inte plingar 07:15 när du redan satt
 * dig i bilen 07:05. En påminnelse om något man redan gjort är inte bara
 * onödig — den lär användaren att notiserna inte är värda att läsa, och sen
 * stängs de av. Servern hoppar över alla luckor samma dygn efter det här.
 */
export async function markDroveToday() {
  const st = load();
  if (!st.endpoint || !st.device) return false;

  // En gång per dygn räcker. Datumet är telefonens lokala, samma som servern
  // räknar i eftersom den använder tidszonen vi skickade upp.
  const today = new Date().toLocaleDateString('sv-SE');
  if (st.droveOn === today) return false;

  try {
    await rpc('mark_drove_today', { p_endpoint: st.endpoint, p_device: st.device });
    save({ ...st, droveOn: today });
    return true;
  } catch { return false; }
}

/**
 * Visa en notis lokalt, utan servern. För testknappen i inställningarna.
 *
 * Var tydlig med vad det här bevisar och inte: det visar att telefonen
 * släpper fram notiser, men inte att push-kedjan fungerar. Den enda riktiga
 * testen är att stänga appen helt och trigga edge-funktionen — se
 * docs/NOTISER.md.
 */
export async function testLocal(title = 'Polisvakt', body = 'Så här ser en påminnelse ut.') {
  if (permission() !== 'granted') return false;
  try {
    const reg = await swReady();
    if (!reg) return false;
    await reg.showNotification(title, {
      body, icon: './icon.svg', badge: './icon.svg', tag: 'polisvakt-test',
    });
    return true;
  } catch { return false; }
}
