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
// Rutnätet från chatten, återanvänt rakt av. Se avsnittet "VAR NOTISERNA SKA
// GÄLLA" längst ner: det som skickas upp om var telefonen hör hemma är mitten
// av en ruta, aldrig en position. En andra rutkodning här hade blivit ännu en
// kopia som kan driva isär — och den här kodbasen har redan en dokumenterad
// skada av just det.
import { rutkod, rutansMitt } from './chatt.js';

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

/**
 * Dagens datum som "2026-08-22", i telefonens egen tidszon.
 *
 * Formatet är valt för att det sorteras rätt som ren text, vilket gör att
 * hemruteräkningen längre ner kan jämföra dygn med localeCompare i stället
 * för att tolka datum. Ett eget datumformat till hade varit en andra sanning
 * om vad "i dag" betyder — markDroveToday räknar redan så här, och servern
 * räknar i samma tidszon eftersom vi skickat upp den.
 */
const idag = () => new Date().toLocaleDateString('sv-SE');

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

  // Ny endpoint betyder ny rad på servern, och den raden har inte sagt nej till
  // något än. Utan den här raden skulle en användare som stängt av och slagit
  // på notiser i samma session sitta kvar med förra radens nej i minnet, och
  // aldrig få sin hemtrakt uppskickad förrän appen startats om.
  nollstallOmfangsminnet();

  /*
   * Fråga direkt vad servern tycker om notisernas räckvidd.
   *
   * Utan den här raden vet en alldeles ny prenumeration ingenting om sitt eget
   * omfång förrän någon öppnar inställningarna, och `harNotisomfang()` skulle
   * under tiden svara med sitt försiktiga förval — alltså visa "hela landet"
   * för en rad som servern redan skapat med filtret påslaget.
   *
   * INTE awaitad, med flit: prenumerationen är klar och fungerar, och en
   * långsam server — eller en som ännu inte fått migrationen — får inte hålla
   * kvar knappen användaren just tryckte på.
   */
  hamtaNotisomfang().catch(() => {});

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

  /*
   * Även den lokala hemruteräkningen. Den finns bara för att mata
   * notisfiltret, och när notiserna är avstängda finns inget filter att mata —
   * då ska det inte ligga kvar åtta rutkoder på telefonen som säger var
   * användaren brukar vara. Priset är att den som slår på notiser igen får
   * vänta två dygn på att appen lär sig trakten på nytt; under tiden får hen
   * alla varningar, vilket är åt rätt håll.
   */
  glomHemrutor();
  nollstallOmfangsminnet();
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

  /*
   * Tar emot antingen den gamla vanekartan eller en färdig lucklista.
   *
   * Appen har numera två system som räknar fram när någon brukar köra:
   * driving.js grova "dag-timme → antal", och korvanor.js som väger in spann,
   * andel, nattspärr och avfärdade mönster. Båda kodar resultatet i samma
   * 0–167-skala, och korvanor.js säger själv i en kommentar att den gör det
   * med flit — men bron var aldrig byggd, så det var alltid den sämre
   * uppsättningen som nådde servern.
   *
   * Att ta emot en färdig lista här är hela bron.
   */
  const slots = Array.isArray(habits)
    ? [...new Set(habits)].filter(n => Number.isInteger(n) && n >= 0 && n < 168).sort((a, b) => a - b)
    : slotsFromHabits(habits, minCount);
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
  const today = idag();
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

/**
 * Notiser när någon skrivit i Facebook-gruppen.
 *
 * Av som standard, och det är ett medvetet val. En livlig grupp kan ge tiotals
 * inlägg i timmen, och den som får för många notiser stänger av dem för hela
 * appen — då tystnar körpåminnelsen med. Hellre att den som vill ha dem slår
 * på dem själv.
 *
 * Servern har fyra spärrar ovanpå: en notis per omgång, minst tio minuter
 * emellan, tyst mellan 23 och 06, och tolv per dygn.
 *
 * Tyst no-op när notiser inte är påslagna alls, så den går att anropa utan
 * att anroparen kollar först.
 */
export async function sattGruppnotiser(pa) {
  const st = load();
  if (!st.endpoint || !st.device) return false;
  try {
    /*
     * Svaret läses numera. Förut kastades det.
     *
     * Funktionen på servern var ett update ... where endpoint = ... and
     * device_id = ... som returnerade void. Träffade den noll rader syntes
     * det ingenstans: PostgREST svarar 200, den här funktionen returnerade
     * true, och appen skrev "På. Du får en notis när det kommit nya inlägg."
     * medan servern stod kvar på av.
     *
     * Det är inte hypotetiskt. Prenumererar man utloggad får raden ett
     * slumpat enhets-id; loggar man sedan in skrivs raden om till
     * auth.uid(). Loggar man ut igen och drar reglaget matchar ingenting,
     * noll rader ändras, och notiser kommer aldrig — utan att något i
     * appen säger emot.
     *
     * Nu returnerar servern {ok, pa, rader, skal} och vi sparar det värde
     * SERVERN rapporterar, inte det anroparen bad om.
     */
    const svar = await rpc('fbmejl_satt_gruppnotiser', {
      p_endpoint: st.endpoint, p_device: st.device, p_pa: !!pa,
    });
    if (!svar?.ok) return false;
    save({ ...st, gruppnotiser: !!svar.pa });
    return true;
  } catch {
    return false;
  }
}

/**
 * Vad telefonen tror att inställningen är.
 *
 * Bara en cache. Kommentaren här sa förut "Servern äger sanningen" medan
 * koden aldrig frågade servern — töms lagringen visade rutan "Av" fastän
 * servern skickade, och tvärtom. Använd `hamtaGruppnotiser()` när det
 * spelar roll; den här finns för att kunna rita något direkt vid start.
 */
export function harGruppnotiser() {
  const st = load();
  /*
   * Påslaget som förval, för att spegla servern.
   *
   * Kolumnen `gruppnotiser` har `default true` sedan 21 aug 2026. Har den
   * här telefonen aldrig rört reglaget finns inget sparat värde, och då ska
   * cachen visa samma sak som servern kommer att svara — annars står rutan
   * "Av" i några sekunder innan `hamtaGruppnotiser()` hinner rätta den, och
   * en användare som råkar titta just då tror att den är avstängd och slår
   * på något som redan är på.
   *
   * Har telefonen ett sparat värde vinner det alltid, även när det är false:
   * ett förval styr den som inte valt, inte den som valt.
   */
  return st.gruppnotiser === undefined ? true : !!st.gruppnotiser;
}

/**
 * Frågar servern vad som faktiskt gäller.
 *
 * @returns {Promise<{finns:boolean, pa:boolean, aktiv:boolean, nadde:boolean}>}
 *   finns  — prenumerationen känns igen. false = telefonen har en
 *            prenumeration servern inte hittar, och den måste sparas om.
 *   aktiv  — raden lever (påslagen och inte utslagen av upprepade fel).
 *   nadde  — vi fick svar. false = offline, säg inget tvärsäkert då.
 */
export async function hamtaGruppnotiser() {
  const st = load();
  if (!st.endpoint || !st.device) {
    return { finns: false, pa: false, aktiv: false, nadde: true };
  }
  try {
    const s = await rpc('fbmejl_har_gruppnotiser', {
      p_endpoint: st.endpoint, p_device: st.device,
    });
    const ut = { finns: !!s?.finns, pa: !!s?.pa, aktiv: !!s?.aktiv, nadde: true };
    // Cachen följer serverns svar, så nästa start ritar rätt direkt.
    save({ ...st, gruppnotiser: ut.pa });
    return ut;
  } catch {
    return { finns: true, pa: harGruppnotiser(), aktiv: true, nadde: false };
  }
}

/* ==================== VAR NOTISERNA SKA GÄLLA ====================== */
/*
 * Gruppnotisen gick förut till varenda prenumerant, oavsett var i landet hen
 * befann sig — notisvägen på servern hade ingen geografi alls. Det höll så
 * länge bryggan bara läste Västmanland. Dagen Stockholm, Uppsala och Gävle
 * kopplas in betyder samma sak: en förare i Västerås väcks halv sex på
 * morgonen av en kontroll i Gävle, och stänger av notiserna för hela appen —
 * varpå körpåminnelsen tystnar med.
 *
 * Själva filtret sitter på servern, i public.fbmejl_push_mottagare. Allt den
 * här filen gör är att tala om två saker: VAR telefonen hör hemma, och HUR
 * LÅNGT bort en varning fortfarande angår den.
 *
 * VARFÖR EN RUTA OCH ALDRIG EN POSITION
 *
 * Det som skickas upp är aldrig telefonens koordinat. Det är mittpunkten i en
 * ruta ur js/chatt.js RUTA — 0,25° × 0,5°, ungefär tre mil, en av knappt
 * 2 500 fasta punkter i hela landet. Resonemanget står redan utskrivet i
 * chatt.js ("hemadress, arbetsplats, vilka kvällar hen inte var hemma") och
 * gäller ordagrant här: en dump av push_subscriptions ska inte kunna bli en
 * adresslista. Det är dessutom exakt samma kvantisering som chattens
 * omrade-kolumn redan bär över nätet, alltså ingen ny sorts uppgift om
 * användaren — bara en andra användning av en som redan finns.
 *
 * Att i stället skicka rå lat/lon och låta servern runda hade varit enklare
 * kod och sämre löfte: då finns positionen i en HTTP-logg någonstans, och
 * löftet vilar på att ingen sparar den. Rundningen görs därför här, innan
 * talet lämnar telefonen.
 *
 * VARFÖR TVÅ DYGN INNAN EN RUTA BLIR HEMMA
 *
 * En enda resa till Stockholm skulle annars flytta hela bevakningsområdet dit,
 * och föraren komma hem till en app som slutat varna om hemmaplan. Två skilda
 * kalenderdygn i samma ruta skiljer en resa från en flytt, och kostar
 * ingenting alls för den som bor kvar.
 *
 * VARFÖR EN LISTA OCH INTE EN PUNKT
 *
 * Två dygn skiljer en resa från en flytt, men inte en tvåveckorssemester från
 * en flytt. Med en enda hempunkt skulle semesterorten skriva över hemmet, och
 * den som kommer hem utan att öppna appen med GPS igång sitter kvar med ett
 * bevakningsområde i fel landsdel. Därför är hemplatsen en lista om högst
 * fyra rutor, och automatiken LÄGGER TILL — den tar aldrig bort. Samma sak
 * löser pendlaren Västerås–Stockholm en andra gång, utan att hen rör ett
 * reglage.
 *
 * VARFÖR DET HÄR INTE ÄR SAMMA SAK SOM BEVAKNINGSOMRÅDET
 *
 * `coverage.js` svarar på "vad ritas på kartan medan jag kör". Det här svarar
 * på "vad väcker telefonen när appen är stängd". Två olika frågor med två
 * olika rätta svar — 30 km är rimligt för det första och alldeles för snålt
 * för det andra. Återanvänd INTE settings.coverageRadiusM här, hur duplicerat
 * det än ser ut.
 *
 * FILTRET FÅR BARA TYSTA, ALDRIG ÖPPNA
 *
 * Nykterhets- och drogkontroller sorteras bort långt uppströms, i
 * public.fbmejl_ta_emot innan raden ens blir en rapport. Ingenting i den här
 * filen kan återinföra något som ett tidigare filter tystat, och ingenting
 * här får någonsin byggas om till att göra det.
 */

/**
 * Räckvidden i meter: förval, gränser och steg.
 *
 * SAMMA TAL som reglaget i index.html (#setNotisRadie) och samma klamp som
 * public.fbmejl_satt_notisomfang gör på servern. Ändras ett av de tre måste
 * alla tre ändras — servern är den som bestämmer, de andra två finns för att
 * användaren inte ska kunna skicka in något servern ändå vägrar.
 *
 * Förvalet är mätt och inte gissat: Västerås–Stockholm är ungefär tio mil,
 * Västerås–Örebro sju och en halv, och hela Västmanland ryms inom sex mil
 * från Hallstahammar. Med 100 km plus rutslarvet på servern får varenda
 * prenumerant i dagens upptagningsområde fortfarande varenda varning.
 */
export const NOTIS_RADIE = { forval: 100000, min: 25000, max: 300000, steg: 25000 };

/**
 * Hur många rutor som kan vara "hemma" samtidigt. Åtta, för att det är vad
 * kolumnen notis_platser på servern rymmer. Ett nionde värde här hade tyst
 * kastats bort där.
 *
 * Var fyra fram till 2026-08-22. Fyra räckte inte: en enda dag borta hemifrån
 * kan korsa fyra nya rutor, och gallrades det då på senast sedda dygn föll
 * hemrutan ur listan samma dag — med den också beviset för att den någonsin
 * varit hem. Åtta platser plus gallringsordningen nedan gör att en resa inte
 * längre får plats att trycka ut hemmet.
 */
const HEM_TAK = 8;

/** Så många skilda kalenderdygn i samma ruta krävs innan den räknas som hemma. */
const DYGN_FOR_HEM = 2;

/**
 * Räkningen av besökta rutor. Ligger för sig, inte i push-kvittot, eftersom
 * den överlever att prenumerationen görs om men inte att notiserna stängs av.
 *
 * Formen är { "r238x33": { forst: "2026-06-01", sedd: "2026-08-22", dygn: 34 }
 * }: första dygnet, senaste dygnet och ANTALET skilda dygn — aldrig vilka.
 * Frågan är "har telefonen varit här två skilda dygn", inte "hur ofta och
 * när" — en växande lista hade varit en närvarologg per ruta, alltså precis
 * det rutkodningen finns för att slippa.
 *
 * `dygn` är en räknare och inte listans längd med flit. Den gamla formen var
 * [första, senaste], och där kunde en ruta med sextio dygn bakom sig inte
 * skiljas från en som setts två gånger — de såg likadana ut för gallringen.
 * Räknaren överlever, och det är den som gör hemrutan tyngre än en semester.
 */
const RUTOR_KEY = 'pv.push.rutor.v1';

const lasRutor = () => {
  try {
    const v = JSON.parse(localStorage.getItem(RUTOR_KEY));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const ut = {};
    for (const [k, p] of Object.entries(v)) {
      // Nyckeln är kvar på v1 fast formen bytt: en ny nyckel hade tömt varje
      // telefon på sin hemruta vid uppdateringen, alltså exakt det fel den
      // här formen finns för att laga. Gamla [första, senaste] läses in i
      // stället, och två poster blir en räknare på två.
      const post = Array.isArray(p)
        ? { forst: String(p[0] ?? ''), sedd: String(p[p.length - 1] ?? ''), dygn: new Set(p).size }
        : p && typeof p === 'object' ? p : null;
      if (!post || !post.sedd) continue;
      ut[k] = {
        forst: typeof post.forst === 'string' && post.forst ? post.forst : String(post.sedd),
        sedd: String(post.sedd),
        dygn: Number.isFinite(+post.dygn) && +post.dygn > 0 ? Math.floor(+post.dygn) : 1,
      };
    }
    return ut;
  } catch { return {}; }
};
const skrivRutor = v => { try { localStorage.setItem(RUTOR_KEY, JSON.stringify(v)); } catch {} };
const glomHemrutor = () => { try { localStorage.removeItem(RUTOR_KEY); } catch {} };

/** Senaste dygnet en ruta setts, som sorterbar text. Tom sträng = okänd. */
const senastSedd = post => (post && typeof post.sedd === 'string' ? post.sedd : '');

/** Första dygnet en ruta setts, som sorterbar text. Tom sträng = okänd. */
const forstSedd = post => (post && typeof post.forst === 'string' ? post.forst : '');

/** Har telefonen varit i rutan tillräckligt många skilda dygn? */
const arHem = post => !!post && (post.dygn ?? 0) >= DYGN_FOR_HEM;

/**
 * Skriv upp att telefonen är i rutan i dag. Returnerar hela räkningen.
 *
 * GALLRINGSORDNINGEN, OCH VARFÖR DEN INTE ÄR "SENAST SEDD"
 *
 * Fram till 2026-08-22 gallrades det på senast sedda dygn, i tron att
 * hemrutan aldrig kunde ryka eftersom dess dygn skrevs om varje gång
 * telefonen var där. Det höll inte: är telefonen borta hemifrån en enda dag
 * och korsar fyra nya rutor den dagen är hemrutan den orördaste av alla och
 * faller ur listan. Med den försvinner räkningen som bevisade att rutan var
 * hem, så telefonen kräver två NYA skilda dygn innan den kan säga hem igen —
 * och under tiden står serverfiltret kvar på fel landsdel.
 *
 * Nu rangordnas rutorna i stället så här, och den som hamnar sist ryker:
 *
 *   1. rutan telefonen står i just nu, alltid. Utan undantaget kan en riktig
 *      flytt aldrig få fäste när taket är fullt av gamla hemrutor — den nya
 *      rutan hade kastats samma sekund den skrevs upp, varje dag, för alltid.
 *   2. hemrutor före rutor som ännu inte kvalificerat sig. Finns det något
 *      ogallrat att kasta i stället kastas det, aldrig ett hem.
 *   3. bland hemrutor: äldst FÖRST sedda vinner. Den som varit hem sedan i
 *      somras väger tyngre än den som blev hem i förrgår.
 *   4. bland övriga: färskast sedda vinner, alltså ryker den som legat orörd
 *      längst — samma regel som förr, men nu bara bland resrutorna.
 */
function noteraRuta(kod, dag) {
  const rutor = lasRutor();
  const post = rutor[kod] ?? { forst: dag, sedd: '', dygn: 0 };

  if (post.sedd !== dag) {
    // Räknaren stegas en gång per skilt kalenderdygn och nollställs aldrig.
    // Den är hela skillnaden mot den gamla [första, senaste]-formen: ett hem
    // som varit hem i sextio dygn ska inte kunna vägas mot en enskild dag.
    post.dygn = (post.dygn ?? 0) + 1;
    post.sedd = dag;
  }
  // Klockan kan gå baklänges (tidszon, manuell ändring). Då är det äldsta
  // dygnet vi någonsin sett det som gäller, inte det vi råkade skriva först.
  if (!post.forst || dag < post.forst) post.forst = dag;
  rutor[kod] = post;

  const kvar = Object.keys(rutor)
    .sort((a, b) => {
      if (a === kod) return -1;
      if (b === kod) return 1;
      const ha = arHem(rutor[a]), hb = arHem(rutor[b]);
      if (ha !== hb) return ha ? -1 : 1;
      return ha
        ? forstSedd(rutor[a]).localeCompare(forstSedd(rutor[b]))
        : senastSedd(rutor[b]).localeCompare(senastSedd(rutor[a]));
    })
    .slice(0, HEM_TAK);
  const ut = {};
  for (const k of kvar) ut[k] = rutor[k];
  skrivRutor(ut);
  return ut;
}

/**
 * De rutor som kvalificerat sig som hemma, äldst först sedda först.
 *
 * Ordningen är inte kosmetisk: servern gallrar också på när en punkt först
 * blev känd, så den som skickas först är den som överlever längst där. Skulle
 * ordningen bli senast-sedd igen hamnar hemmet sist i serverns lista och
 * gallras bort där i stället — samma fel, andra sidan nätet.
 */
function hemrutor() {
  const rutor = lasRutor();
  return Object.keys(rutor)
    .filter(k => arHem(rutor[k]))
    .sort((a, b) => forstSedd(rutor[a]).localeCompare(forstSedd(rutor[b])))
    .slice(0, HEM_TAK);
}

/*
 * Tre lägen som bara lever så länge appen är igång.
 *
 * _senastSkickad hålls i minnet och inte i lagringen med flit: en omstart
 * hemma ger då ett enda extra anrop, som bekräftar hemrutan på servern och
 * håller den överst i listan. Att spara den hade sparat ett anrop per start
 * och gjort att servern aldrig fick höra av hemmet igen. Fel byte.
 *
 * _foljerInte är serverns nej. Varje befintlig prenumeration har notis_folj =
 * false — det är hela migrationslöftet, ingen som redan prenumererar får
 * smalnas av — och då vägrar servern skriva hempunkter. Utan flaggan hade
 * varje ny ruta gett ett anrop som säkert misslyckas.
 *
 * _skickarNu hindrar två GPS-fixar tätt inpå varandra från att skicka samma
 * ruta två gånger. noteraPosition är synkron och väntar inte in svaret, så
 * utan den kan andra fixen hinna in innan den första hunnit sätta
 * _senastSkickad.
 */
let _senastSkickad = null;
let _foljerInte = false;
let _skickarNu = false;

/** Glöm vad den förra prenumerationen svarat. Anropas när endpoint byts. */
function nollstallOmfangsminnet() {
  _senastSkickad = null;
  _foljerInte = false;
}

/**
 * Läs in serverns svar i push-kvittot.
 *
 * Notera vad som INTE sparas: `platser`. Servern svarar med punkterna, men de
 * har ingenting i localStorage att göra — då vore hempunkterna i klartext på
 * telefonen igen och hela resonemanget ovan bortkastat. Bara ANTALET sparas,
 * och det räcker för att gränssnittet ska kunna skilja "appen letar
 * fortfarande efter din trakt" från "filtret är igång".
 */
function sparaOmfang(svar, reservFolj) {
  const st = load();
  const antal = Number.isFinite(svar?.antal_platser)
    ? svar.antal_platser
    : Array.isArray(svar?.platser) ? svar.platser.length : st.notisPlatser ?? 0;

  const ut = {
    notisFolj: !!(svar?.folj ?? reservFolj ?? st.notisFolj ?? false),
    notisRadieM: Number.isFinite(svar?.radie_m) ? svar.radie_m : st.notisRadieM ?? NOTIS_RADIE.forval,
    notisPlatser: antal,
  };
  save({ ...st, ...ut });
  return ut;
}

/**
 * Skicka en hemruta till servern. Aldrig exporterad, och det är avsiktligt:
 * ingen annan del av appen ska kunna mata in en punkt som inte är mitten av
 * en ruta. Vägen in går genom noteraPosition(), som rundar först.
 */
async function skickaHemruta(kod) {
  if (_skickarNu || _foljerInte) return false;
  const st = load();
  if (!st.endpoint || !st.device) return false;
  const mitt = rutansMitt(kod);
  if (!mitt) return false;

  _skickarNu = true;
  try {
    const svar = await rpc('fbmejl_satt_notisplats', {
      p_endpoint: st.endpoint, p_device: st.device,
      p_lat: mitt.lat, p_lon: mitt.lon,
    });
    // "foljer-inte" är inte ett fel. Det är servern som skyddar en
    // prenumeration som fanns före filtret från att smalnas av bakom ryggen
    // på sin ägare. Sluta försöka tills någon slår på det.
    if (svar?.skal === 'foljer-inte') { _foljerInte = true; return false; }
    if (!svar?.ok) return false;
    sparaOmfang(svar, true);
    _senastSkickad = kod;
    return true;
  } catch (e) {
    /*
     * Servern kan sakna funktionen ännu — klienten rullas ut efter SQL:en,
     * men en telefon med gammal cachad JS mot en ny server, eller tvärtom,
     * är precis det som händer i verkligheten. Finns funktionen inte är det
     * ingen idé att fråga igen vid varje ny ruta; nästa start frågar ändå.
     */
    if (/\b404\b|does not exist/i.test(e?.message ?? '')) _foljerInte = true;
    return false;
  } finally {
    _skickarNu = false;
  }
}

/**
 * En GPS-fix. Matas från samma ställe som chattens rutkod, i wireGeo().
 *
 * Synkron och tyst med flit: den anropas för varje position telefonen får,
 * och får varken kasta, blockera eller kräva att anroparen vet något om
 * notiser. Allt nätverk sker i bakgrunden och får misslyckas.
 *
 * Räkningen fortsätter även när servern inte följer med (se _foljerInte).
 * Det är det som gör att en befintlig installation kan slå på "Nära mig" och
 * få rätt trakt direkt, i stället för att stå i "appen letar" i två dygn för
 * en trakt appen redan känner.
 *
 * @returns {string|null} rutkoden telefonen befinner sig i, för felsökning.
 */
export function noteraPosition(lat, lon) {
  const kod = rutkod(lat, lon);
  if (!kod) return null;

  const rutor = noteraRuta(kod, idag());
  if (!arHem(rutor[kod])) return kod;      // första dygnet: räkna, skicka inte
  if (_foljerInte) return kod;
  if (kod === _senastSkickad) return kod;  // redan uppe, och rutan är stor

  skickaHemruta(kod);
  return kod;
}

/**
 * Reglaget: "Nära mig" eller "Hela landet", och hur långt "nära" är.
 *
 * @param {boolean} folj   false = hela landet, alltså inget filter alls
 * @param {number}  radieM meter. Servern klampar; se NOTIS_RADIE.
 * @returns {Promise<{ok:boolean, folj:boolean, radieM:number,
 *                    antalPlatser:number, skal:string|null}>}
 *
 * Svaret bär serverns värden, inte anroparens önskan. Skälet står utskrivet
 * i sattGruppnotiser ovan och gäller ordagrant här: prenumererar man utloggad
 * och loggar sedan in matchar inte enhets-id:t längre, noll rader ändras, och
 * en void-funktion hade fått appen att påstå att inställningen sparats.
 */
export async function sattNotisomfang(folj, radieM) {
  const st = load();
  if (!st.endpoint || !st.device) {
    return { ok: false, folj: false, radieM: NOTIS_RADIE.forval, antalPlatser: 0, skal: 'ingen-prenumeration' };
  }

  try {
    const svar = await rpc('fbmejl_satt_notisomfang', {
      p_endpoint: st.endpoint, p_device: st.device,
      p_folj: !!folj,
      // Talet skickas som det är. Klampen bor på servern, för en radie på
      // 500 m vore en tyst avstängning av notiserna och det ska inte gå att
      // skicka in — inte ens från en klient som byggts om.
      p_radie_m: Number.isFinite(+radieM) ? Math.round(+radieM) : NOTIS_RADIE.forval,
    });
    if (!svar?.ok) {
      return { ok: false, folj: harNotisomfang().folj, radieM: harNotisomfang().radieM,
               antalPlatser: harNotisomfang().antalPlatser, skal: svar?.skal ?? 'nekad' };
    }

    const sparat = sparaOmfang(svar, !!folj);
    _foljerInte = !sparat.notisFolj;
    _senastSkickad = null;

    /*
     * Slås filtret på skickas de rutor telefonen redan lärt sig, direkt.
     *
     * Utan det här står det "Appen letar fortfarande efter din trakt" om en
     * trakt appen känner sedan i somras, tills nästa gång föraren råkar ha
     * appen öppen med GPS på. Äldst först sedda först, så att serverns lista
     * får samma inbördes ordning som telefonens — servern gallrar på när en
     * punkt först blev känd, och då ska hemmet ha blivit känt först där med.
     */
    if (sparat.notisFolj) {
      for (const kod of hemrutor()) {
        if (!await skickaHemruta(kod)) break;
      }
    }

    const nu = harNotisomfang();
    return { ok: true, folj: nu.folj, radieM: nu.radieM, antalPlatser: nu.antalPlatser, skal: null };
  } catch {
    const nu = harNotisomfang();
    return { ok: false, folj: nu.folj, radieM: nu.radieM, antalPlatser: nu.antalPlatser, skal: 'offline' };
  }
}

/**
 * Vad telefonen tror att omfånget är. Bara en cache, för första ritningen.
 *
 * `kant` säger om det finns ett sparat värde alls. Använd det: förvalet nedan
 * är "hela landet", vilket är sant för varje prenumeration som fanns före
 * filtret, men det är en gissning och inte ett svar. Vill du veta säkert —
 * fråga `hamtaNotisomfang()`.
 *
 * Varför förvalet är false och inte true, tvärtemot hur harGruppnotiser
 * resonerar: kolumnen notis_folj har `default false` för alla rader som redan
 * fanns och `default true` bara för nya. Ett tomt kvitto tillhör alltså nästan
 * alltid en telefon som prenumererade före ändringen. En ny prenumeration
 * hämtar dessutom sitt riktiga värde direkt i enable().
 */
export function harNotisomfang() {
  const st = load();
  return {
    kant: st.notisFolj !== undefined,
    folj: st.notisFolj === undefined ? false : !!st.notisFolj,
    radieM: Number.isFinite(st.notisRadieM) ? st.notisRadieM : NOTIS_RADIE.forval,
    antalPlatser: Number.isFinite(st.notisPlatser) ? st.notisPlatser : 0,
  };
}

/**
 * Frågar servern vad som faktiskt gäller, och rättar cachen.
 *
 * @returns {Promise<{finns:boolean, folj:boolean, radieM:number,
 *                    antalPlatser:number, aktiv:boolean, nadde:boolean}>}
 *   finns        — servern känner igen prenumerationen. false = telefonen har
 *                  en prenumeration servern inte hittar, och den måste sparas om.
 *   folj         — filtret är påslaget för den här raden.
 *   antalPlatser — hur många hemrutor servern känner. 0 med folj = true
 *                  betyder "filtret är på men släpper igenom allt än".
 *   aktiv        — raden lever (påslagen och inte utslagen av upprepade fel).
 *   nadde        — vi fick svar. false = offline, säg inget tvärsäkert då.
 *
 * Den här är också uppgraderingsvägen för en befintlig installation: slår
 * ägaren på notis_folj i databasen, eller slår användaren på filtret från en
 * annan telefon, så släpper det här anropet loss automatiken igen utan att
 * någon behöver göra något i appen.
 */
export async function hamtaNotisomfang() {
  const st = load();
  const cache = harNotisomfang();
  if (!st.endpoint || !st.device) {
    return { finns: false, folj: false, radieM: cache.radieM, antalPlatser: 0, aktiv: false, nadde: true };
  }

  try {
    const s = await rpc('fbmejl_har_notisomfang', {
      p_endpoint: st.endpoint, p_device: st.device,
    });
    const ut = {
      finns: !!s?.finns,
      folj: !!s?.folj,
      radieM: Number.isFinite(s?.radie_m) ? s.radie_m : NOTIS_RADIE.forval,
      antalPlatser: Number.isFinite(s?.antal_platser) ? s.antal_platser : 0,
      aktiv: !!s?.aktiv,
      nadde: true,
    };
    // Bara när servern känner igen raden. Svarar den "finns inte" är dess
    // folj/radie påhittade förval, och att cacha dem hade skrivit över det
    // användaren faktiskt valt på en telefon som råkat tappa matchningen.
    if (ut.finns) {
      save({ ...load(), notisFolj: ut.folj, notisRadieM: ut.radieM, notisPlatser: ut.antalPlatser });
      _foljerInte = !ut.folj;
    }
    return ut;
  } catch {
    return { finns: true, folj: cache.folj, radieM: cache.radieM,
             antalPlatser: cache.antalPlatser, aktiv: true, nadde: false };
  }
}
