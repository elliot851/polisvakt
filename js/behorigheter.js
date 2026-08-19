// Behörigheter — de tre sakerna som avgör om appen gör någon nytta alls.
//
// Polisvakt utan tillstånd är en karta som inte vet var du är och en röst som
// aldrig hörs. Det är inte ett halvfungerande läge, det är ett trasigt läge.
// Därför samlas allt som rör tillstånd här, på ett ställe, så att UI:t kan
// fråga "hur ligger det till?" och få ett ärligt svar istället för tre olika
// gissningar spridda över appen.
//
// De tre:
//
//   1. PLATS. Utan den kan appen varken varna för något i närheten eller märka
//      att bilen börjat rulla. Det andra är viktigare än det låter — det är
//      körningsdetekteringen i driving.js som lär sig dina tider, och det är de
//      tiderna som gör att påminnelsen "du glömde slå på Polisvakt" kan skickas
//      över huvud taget. Ingen plats → inga vanor → ingen påminnelse.
//
//   2. NOTISER. Enda kanalen som når fram när appen är stängd. Läs noga vad det
//      betyder och inte betyder — se BAKGRUND längst ner. Appen varnar inte i
//      bakgrunden, och det får aldrig antydas någonstans i UI:t.
//
//   3. FOKUS / STÖR EJ. Den som alla glömmer. En användare kan ha sagt ja till
//      notiser och ändå aldrig höra ett pling, för att iOS Fokus eller Androids
//      Stör ej filtrerar bort dem. Värst av allt: iPhones fokus "Kör bil" slår
//      på sig själv när telefonen märker biltempo — alltså exakt i det ögonblick
//      appen ska höras.
//
// -------------------------------------------------------------------------
// Två ärlighetsregler som styr hela filen:
//
// A. Fokus/Stör ej GÅR INTE att läsa från en webbsida. Det finns inget API,
//    varken på iOS eller Android, och det kommer det inte att göra — det vore
//    ett läckage av personlig status. Vi hittar därför aldrig på ett värde.
//    Punkten är "obekräftad" tills användaren själv säger att hen kollat, och
//    fältet `verifierad` är alltid false på den.
//
// B. Safari svarar inte på frågan om platstillstånd. Permissions API finns i
//    WebKit men 'geolocation' är inte ett giltigt namn där — anropet kastar
//    TypeError istället för att svara. Vi ANTAR då ingenting. Läget blir
//    'okand' med verifierad:false, och det enda sättet att få veta är att
//    faktiskt be om positionen och se vad telefonen svarar.
//
// Ingen funktion här rör DOM:en. Modulen levererar ett statusobjekt och tre
// funktioner som ber om saker; hur det ritas är UI:ts problem (js/tour.js).
// -------------------------------------------------------------------------

import * as push from './push.js';

const KEY = 'pv.behorigheter.v1';

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

/**
 * Lyssna på 'andrad' för att rita om när något ändrats.
 * Skickas när vi lärt oss något nytt om platstillståndet, och när användaren
 * bekräftat Fokus. Notistillståndet kan webbläsaren inte meddela oss om, så
 * det får läsas om vid varje visning.
 */
export const events = new EventTarget();

const larma = (vad, detalj = {}) =>
  events.dispatchEvent(new CustomEvent('andrad', { detail: { vad, ...detalj } }));

/* ========================== PLATTFORMSKOLL ========================== */

/**
 * Vilken telefon och vilken webbläsare — enda skälet är att kunna säga rätt
 * menyväg. "Inställningar → Fokus" på en Android-telefon är sämre än ingen
 * instruktion alls, eftersom användaren letar efter något som inte finns och
 * drar slutsatsen att appen är trasig.
 *
 * apple och standalone kommer från push.capabilities() istället för en egen
 * kopia — iPad som utger sig för att vara Mac är exakt den sortens detalj som
 * hinner bli fel i två filer.
 */
export function plattform() {
  const ua = navigator.userAgent || '';
  const cap = push.capabilities();
  const android = /Android/i.test(ua);

  // Ordningen är inte godtycklig: Edge- och Samsung-strängarna innehåller
  // "Chrome", och Chromes sträng innehåller "Safari". Först den mest
  // specifika. På iOS är alla webbläsare WebKit inuti, så där spelar märket
  // mindre roll än att det är en Apple-enhet.
  const browser =
    /FxiOS|Firefox/i.test(ua) ? 'firefox' :
    /SamsungBrowser/i.test(ua) ? 'samsung' :
    /EdgiOS|Edg\//i.test(ua) ? 'edge' :
    /CriOS|Chrome/i.test(ua) ? 'chrome' :
    /Safari/i.test(ua) ? 'safari' : 'okand';

  return {
    os: cap.apple ? 'ios' : android ? 'android' : 'annat',
    apple: cap.apple,
    android,
    standalone: cap.standalone,   // startad från hemskärmsikonen
    iosVersion: cap.iosVersion,
    browser,
  };
}

/* ============================== PLATS =============================== */

/** Spara det vi lärt oss om platstillståndet. Bara vid faktiska besked. */
function kommIhagPlats(state) {
  const st = load();
  if (st.plats?.state === state) return;
  st.plats = { state, at: Date.now() };
  save(st);
  larma('plats', { state });
}

let platsAbonnerad = false;

/**
 * Nuvarande platstillstånd.
 *
 * state: 'granted' | 'denied' | 'prompt' | 'okand' | 'saknas'
 *
 * 'okand' är ett riktigt svar, inte ett fel. Det betyder "den här webbläsaren
 * berättar inte, och vi har inte frågat telefonen än". Safari hamnar där varje
 * gång tills användaren tryckt på knappen minst en gång.
 *
 * verifierad säger om svaret kommer från webbläsaren just nu (true) eller från
 * vårt eget minne av vad som hände sist (false). Skillnaden spelar roll: en
 * användare kan ha dragit tillbaka tillståndet i systeminställningarna sedan
 * dess, och då är minnet en lögn med bäst-före-datum.
 */
export async function platsStatus() {
  const bas = { nyckel: 'plats', namn: 'Plats', kritisk: true, detekterbar: true };

  if (!('geolocation' in navigator)) {
    return {
      ...bas, state: 'saknas', ok: false, verifierad: true, kanFraga: false,
      text: 'Enheten saknar GPS-stöd.',
      reason: 'Utan GPS kan appen varken visa var du är eller varna för något i närheten.',
    };
  }

  let state = null;
  let verifierad = false;

  try {
    // Safari kastar TypeError här: 'geolocation' finns inte som PermissionName
    // i WebKit. Chrome, Edge, Firefox och Samsung Internet svarar.
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p?.state) {
      state = p.state;
      verifierad = true;
      kommIhagPlats(p.state);

      // Användaren kan ändra tillståndet i webbläsarens inställningar medan
      // appen ligger framme. Utan den här får hen stirra på en röd prick som
      // hen just gjort grön.
      if (!platsAbonnerad) {
        platsAbonnerad = true;
        p.onchange = () => kommIhagPlats(p.state);
      }
    }
  } catch { /* Safari — vi vet inte, och låtsas inte att vi gör det. */ }

  if (!state) {
    const minne = load().plats?.state;
    state = minne || 'okand';
    verifierad = false;
  }

  const ok = state === 'granted';
  const kanFraga = state !== 'denied' && state !== 'saknas';

  let text;
  if (ok && verifierad) text = 'Plats är tillåten.';
  else if (ok) text = 'Plats var tillåten senast appen kördes.';
  else if (state === 'denied') text = 'Plats är blockerad.';
  else if (state === 'prompt') text = 'Appen har inte frågat än.';
  else text = 'Webbläsaren säger inte om plats är tillåten.';

  return {
    ...bas, state, ok, verifierad, kanFraga, text,
    reason: state === 'denied'
      ? 'Webbläsaren frågar inte igen när man en gång sagt nej. Det måste slås på i inställningarna.'
      : !verifierad && !ok
        ? 'Den här webbläsaren svarar inte på frågan. Tryck på knappen så frågar vi telefonen på riktigt.'
        : '',
  };
}

/**
 * Be om platstillstånd.
 *
 * MÅSTE anropas direkt ur ett riktigt fingertryck. Safari kräver en levande
 * gest för att visa rutan, precis som med notiser — ligger det ett await före
 * anropet hinner gesten gå ut och ingenting händer. Därför inga await här före
 * getCurrentPosition, och därför är det ett Promise istället för async.
 *
 * Ett lyckat svar är dessutom det enda sätt vi har att veta säkert att plats
 * är tillåten i Safari. Positionen kastas bort — vi är ute efter beskedet.
 *
 * @returns {Promise<{ok:boolean, state:string, reason?:string, fix?:string}>}
 */
export function begarPlats({ timeout = 15000 } = {}) {
  return new Promise(resolve => {
    if (!('geolocation' in navigator)) {
      return resolve({ ok: false, state: 'saknas', reason: 'Enheten saknar GPS-stöd.' });
    }

    navigator.geolocation.getCurrentPosition(
      () => { kommIhagPlats('granted'); resolve({ ok: true, state: 'granted' }); },
      err => {
        if (err.code === 1) {         // PERMISSION_DENIED
          kommIhagPlats('denied');
          return resolve({
            ok: false, state: 'denied', fix: 'installningar',
            reason: 'Plats nekades. Webbläsaren frågar inte igen — det måste slås på i inställningarna.',
          });
        }
        // Kod 2 (ingen signal) och 3 (timeout) säger INGENTING om tillståndet.
        // Att spara dem som nekat vore att märka en fungerande telefon som
        // trasig bara för att den stod i ett garage.
        resolve({
          ok: false,
          state: load().plats?.state || 'okand',
          reason: err.code === 3
            ? 'Telefonen hann inte få en position. Prova igen utomhus eller nära ett fönster.'
            : 'Ingen GPS-signal just nu. Tillståndet är oförändrat.',
        });
      },
      { enableHighAccuracy: true, timeout, maximumAge: 0 }
    );
  });
}

/**
 * Låt en GeoTracker från js/geo.js mata in sanningen medan appen används.
 *
 * Trackern får besked om tillståndet varje gång den läser en position eller
 * får ett fel, och det är färskare än allt vi kan fråga oss fram till. Extra
 * värdefullt i Safari, där det är enda källan.
 *
 * @returns {() => void} funktion som kopplar loss igen
 */
export function koppla(tracker) {
  if (!tracker?.addEventListener) return () => {};
  const påPosition = () => kommIhagPlats('granted');
  const påFel = e => { if (e.detail?.code === 1) kommIhagPlats('denied'); };
  tracker.addEventListener('position', påPosition);
  tracker.addEventListener('error', påFel);
  return () => {
    tracker.removeEventListener('position', påPosition);
    tracker.removeEventListener('error', påFel);
  };
}

/* ============================= NOTISER ============================== */

/**
 * Notisläget. All plattformskunskap kommer från js/push.js — den vet redan om
 * iPhone-kravet på hemskärm, om iOS är för gammalt och om servern saknar
 * VAPID-nyckel, och den kunskapen ska inte finnas i två filer som kan glida
 * isär.
 *
 * @param {{snabb?:boolean}} opts  snabb hoppar över kollen av prenumerationen
 *        (som väntar på service workern och kan ta sekunder) — bra för en
 *        första ritning som ska uppdateras när det riktiga svaret kommer.
 */
export async function notisStatus({ snabb = false } = {}) {
  const bas = { nyckel: 'notiser', namn: 'Notiser', kritisk: true, detekterbar: true };
  const cap = push.capabilities();
  const perm = push.permission();     // 'granted' | 'denied' | 'default' | 'unsupported'

  let prenumererad = false;
  if (!snabb && cap.supported) {
    try { prenumererad = (await push.status()).subscribed; } catch {}
  }

  // Webbläsaren kan sakna hela API:et. Då är det inget vi kan fråga om, och
  // push.js har redan formulerat varför på svenska — återanvänd den texten.
  if (perm === 'unsupported' || (!cap.supported && cap.fix !== 'server')) {
    return {
      ...bas, state: 'saknas', ok: false, verifierad: true, kanFraga: false,
      prenumererad: false, fix: cap.fix, apple: cap.apple, standalone: cap.standalone,
      text: cap.fix === 'hemskarm' ? 'Kräver att appen ligger på hemskärmen.' : 'Notiser går inte att slå på här.',
      reason: cap.reason,
    };
  }

  const ok = perm === 'granted';
  return {
    ...bas,
    state: perm === 'default' ? 'prompt' : perm,
    ok,
    verifierad: true,               // Notification.permission är alltid sant nu
    kanFraga: perm === 'default',
    prenumererad,
    fix: perm === 'denied' ? 'installningar' : (ok ? null : cap.fix),
    apple: cap.apple,
    standalone: cap.standalone,
    text: ok
      ? (prenumererad ? 'Påslaget.' : 'Notiser är tillåtna.')
      : perm === 'denied' ? 'Notiser är blockerade.' : 'Inte påslaget än.',
    reason: perm === 'denied'
      ? 'Webbläsaren frågar inte igen när man sagt nej en gång. Det måste slås på i inställningarna.'
      : ok && !prenumererad && cap.fix === 'server'
        // Tillstånd finns, men servern kan inte skicka något — då fungerar
        // notiser bara medan appen är öppen. Säg det, gissa inte.
        ? 'Notiser fungerar, men påminnelser när appen är stängd är inte påslagna i den här versionen av appen än.'
        : '',
  };
}

/**
 * Slå på notiser.
 *
 * MÅSTE anropas direkt ur ett fingertryck — inga await före första raden som
 * ber om lov. Se den långa kommentaren i push.js enable().
 *
 * Två vägar, med flit:
 *   • Är push fullt uppsatt (VAPID-nyckel, stödd plattform) går allt via
 *     push.enable(), som frågar om lov OCH prenumererar OCH lägger upp
 *     prenumerationen på servern. Det är den som ger påminnelser när appen är
 *     stängd.
 *   • Saknas servern kan vi ändå be om själva notistillståndet. Det räcker för
 *     påminnelserna som driving.js visar medan appen ligger framme, och är
 *     bättre än en knapp som vägrar göra någonting.
 *
 * @param {{deviceId?:string, habits?:object, minCount?:number}} opts
 */
export async function begarNotiser({ deviceId, habits, minCount = 3 } = {}) {
  const cap = push.capabilities();

  if (cap.supported && deviceId) {
    // Ingen await före det här anropet — push.enable() ber om lov som första
    // sak den gör, och gesten måste fortfarande vara levande då.
    const res = await push.enable({ deviceId, habits, minCount });
    larma('notiser', { ok: res.ok });
    return { ...res, bakgrund: res.ok };
  }

  if (!('Notification' in window)) {
    return { ok: false, reason: cap.reason, fix: cap.fix, bakgrund: false };
  }

  let perm;
  try { perm = await Notification.requestPermission(); }
  catch { return { ok: false, reason: 'Webbläsaren kunde inte visa frågan om notiser.', bakgrund: false }; }

  larma('notiser', { ok: perm === 'granted' });

  if (perm !== 'granted') {
    return {
      ok: false, bakgrund: false, fix: perm === 'denied' ? 'installningar' : null,
      reason: perm === 'denied'
        ? 'Notiser är blockerade för appen. Slå på dem i inställningarna — i webbläsaren går det inte att fråga igen.'
        : 'Du svarade inte på frågan. Tryck igen när du vill slå på notiser.',
    };
  }

  return {
    ok: true,
    bakgrund: false,
    reason: cap.fix === 'server'
      ? 'Notiser är påslagna. Påminnelser när appen är stängd är inte igång i den här versionen än.'
      : '',
  };
}

/* ========================== FOKUS / STÖR EJ ========================= */

// Bump:as den dagen texten ändras så mycket att en gammal bekräftelse inte
// längre betyder att användaren kollat rätt sak.
const FOKUS_VERSION = 1;

/**
 * Fokus/Stör ej-läget.
 *
 * detekterbar: false och verifierad: false, alltid. Det finns inget API som
 * berättar om telefonen är i ett fokusläge — varken Notification, Permissions
 * eller något annat. Det enda vi kan göra är att förklara var inställningen
 * sitter och lita på att användaren säger sanningen om att hen kollat.
 *
 * Ett hemmasnickrat "vi visade en notis och den kom inte fram, alltså Stör
 * ej"-test finns inte här heller. Det går inte att skilja från tio andra
 * orsaker, och en felaktig varning om Stör ej skickar användaren till fel
 * meny.
 */
export function fokusStatus() {
  const p = plattform();
  const st = load().fokus;
  const bekraftad = !!st?.bekraftad && st.version === FOKUS_VERSION;

  const namn = p.os === 'ios' ? 'Fokus och Stör ej'
    : p.os === 'android' ? 'Stör ej'
    : 'Stör ej / Fokus';

  return {
    nyckel: 'fokus',
    namn,
    kritisk: true,
    detekterbar: false,
    verifierad: false,
    state: bekraftad ? 'bekraftad' : 'okontrollerad',
    ok: bekraftad,
    kanFraga: false,
    bekraftadAt: bekraftad ? st.at : null,
    text: bekraftad
      ? 'Du har bekräftat att Polisvakt släpps igenom.'
      : 'Inte kontrollerat.',
    reason: 'Appen kan inte se om telefonen är i ett fokusläge. Den inställningen är inte läsbar från en webbsida, så den här punkten måste du kolla själv.',
  };
}

/** Användaren säger att hen kollat. Det är hela sanningskällan här. */
export function bekraftaFokus(ja = true) {
  const st = load();
  st.fokus = ja ? { bekraftad: true, at: Date.now(), version: FOKUS_VERSION } : null;
  save(st);
  larma('fokus', { ok: ja });
  return fokusStatus();
}

/* =========================== INSTRUKTIONER ========================== */

/**
 * Menyvägen för att slå på något som blockerats, eller för att kolla Fokus.
 *
 * Kontrollerat mot Apples och Googles egna supportsidor i augusti 2026. En
 * felaktig menyväg är sämre än ingen: användaren letar, hittar inte, och drar
 * slutsatsen att appen ljuger. Där menyn har bytt namn mellan versioner står
 * båda namnen.
 *
 * @param {'plats'|'notiser'|'fokus'} vad
 * @returns {{rubrik:string, steg:string[], not:string}}
 */
export function instruktioner(vad) {
  const p = plattform();
  if (vad === 'plats') return platsInstruktioner(p);
  if (vad === 'notiser') return notisInstruktioner(p);
  return fokusInstruktioner(p);
}

function platsInstruktioner(p) {
  if (p.os === 'ios' && p.standalone) {
    return {
      rubrik: 'Slå på plats för Polisvakt',
      steg: [
        'Öppna Inställningar.',
        'Gå till Appar och leta upp Polisvakt. (På iOS 17 och äldre ligger appen längst ner i huvudlistan i Inställningar.)',
        'Tryck på Plats och välj Vid användning av appen.',
        'Kontrollera också Inställningar → Integritet och säkerhet → Platstjänster, att den översta reglaget är på.',
      ],
      not: 'Byt inte till Alltid — det finns inget läge där en webbapp läser position i bakgrunden, så det ger ingenting.',
    };
  }
  if (p.os === 'ios') {
    return {
      rubrik: 'Slå på plats för Safari',
      steg: [
        'Öppna Inställningar → Appar → Safari. (På iOS 17 och äldre: Inställningar → Safari.)',
        'Bläddra ner till Inställningar för webbplatser och tryck på Plats.',
        'Välj Fråga (eller Tillåt).',
        'Kontrollera Inställningar → Integritet och säkerhet → Platstjänster → Safari-webbplatser och välj Vid användning av appen.',
        'Gå tillbaka till Polisvakt, ladda om sidan och tryck på knappen igen.',
      ],
      not: 'Lägger du appen på hemskärmen med Dela → Lägg till på hemskärmen får den en egen rad i Inställningar, och då slipper du dela tillstånd med resten av Safari.',
    };
  }
  if (p.os === 'android' && p.standalone) {
    return {
      rubrik: 'Slå på plats för Polisvakt',
      steg: [
        'Öppna Inställningar → Appar → Polisvakt.',
        'Tryck på Behörigheter → Plats.',
        'Välj Tillåt endast medan appen används.',
        'Kontrollera att Inställningar → Plats är påslaget för hela telefonen.',
      ],
      not: 'Använd exakt position, inte ungefärlig — en varning som är en kilometer fel kommer för sent.',
    };
  }
  if (p.os === 'android') {
    return {
      rubrik: 'Slå på plats för webbläsaren',
      steg: [
        'Tryck på ikonen till vänster om adressfältet (låset eller reglaget) och välj Behörigheter.',
        'Slå på Plats. Saknas raden: menyn ⋮ → Inställningar → Webbplatsinställningar → Plats, leta upp polisvakt-adressen och välj Tillåt.',
        'Kontrollera systemet: Inställningar → Appar → din webbläsare → Behörigheter → Plats → Tillåt endast medan appen används.',
        'Kontrollera att Inställningar → Plats är påslaget för hela telefonen.',
        'Ladda om sidan och tryck på knappen igen.',
      ],
      not: 'Ligger appen på hemskärmen som egen ikon har den egna behörigheter, skilda från webbläsarens.',
    };
  }
  return {
    rubrik: 'Slå på plats i webbläsaren',
    steg: [
      'Klicka på ikonen till vänster om adressfältet.',
      'Ställ Plats på Tillåt (i Firefox: ta bort den blockerade behörigheten).',
      'Ladda om sidan och tryck på knappen igen.',
    ],
    not: 'På en dator kommer positionen från nätverket och kan vara flera hundra meter fel. Appen är byggd för telefon i bil.',
  };
}

function notisInstruktioner(p) {
  if (p.os === 'ios' && p.standalone) {
    return {
      rubrik: 'Slå på notiser för Polisvakt',
      steg: [
        'Öppna Inställningar → Notiser.',
        'Leta upp Polisvakt i listan.',
        'Slå på Tillåt notiser.',
        'Slå även på Tidskänsliga notiser — utan den hålls varningen tillbaka i fokuslägen.',
      ],
      not: 'Notiser räcker inte i sig. Gå igenom Fokus-steget också, annars kan de ändå filtreras bort.',
    };
  }
  if (p.os === 'ios') {
    return {
      rubrik: 'iPhone kräver hemskärmen',
      steg: [
        'Tryck på Dela-knappen i Safari (fyrkanten med pil uppåt).',
        'Välj Lägg till på hemskärmen och bekräfta.',
        'Stäng Safari och starta Polisvakt från den nya ikonen.',
        'Kör guiden igen därifrån — då går knappen för notiser att trycka på.',
      ],
      not: 'Detta är Apples begränsning, inte vår. I en vanlig Safari-flik finns notis-API:et inte alls, oavsett hur ny telefonen är.',
    };
  }
  if (p.os === 'android' && p.standalone) {
    return {
      rubrik: 'Slå på notiser för Polisvakt',
      steg: [
        'Öppna Inställningar → Aviseringar → Appaviseringar.',
        'Leta upp Polisvakt och slå på Alla Polisvakt-aviseringar.',
        'Alternativt: Inställningar → Appar → Polisvakt → Aviseringar.',
      ],
      not: 'Kolla Stör ej-steget också — en tillåten avisering kan fortfarande tystas av ett läge.',
    };
  }
  if (p.os === 'android') {
    return {
      rubrik: 'Slå på notiser för webbplatsen',
      steg: [
        'Öppna webbläsarens meny ⋮ → Inställningar → Webbplatsinställningar → Aviseringar.',
        'Leta upp polisvakt-adressen under Blockerat och byt till Tillåt.',
        'Kontrollera systemet: Inställningar → Aviseringar → Appaviseringar → din webbläsare, som också måste få skicka aviseringar.',
        'Ladda om sidan och tryck på knappen igen.',
      ],
      not: 'Lägg gärna till appen på hemskärmen (menyn ⋮ → Lägg till på startskärmen). Då blir den en egen app i aviseringslistan och är lättare att hitta.',
    };
  }
  return {
    rubrik: 'Slå på notiser i webbläsaren',
    steg: [
      'Klicka på ikonen till vänster om adressfältet.',
      'Ställ Aviseringar på Tillåt.',
      'Kontrollera att operativsystemet inte har notiser avstängda för webbläsaren.',
      'Ladda om sidan och tryck på knappen igen.',
    ],
    not: '',
  };
}

function fokusInstruktioner(p) {
  if (p.os === 'ios') {
    return {
      rubrik: 'Släpp igenom Polisvakt i Fokus',
      steg: [
        'Öppna Inställningar → Fokus.',
        'Öppna varje fokus du använder — särskilt Kör bil och Stör ej.',
        'Under Tillåtna notiser: tryck på Appar och lägg till Polisvakt.',
        'Gå sedan till Inställningar → Notiser → Polisvakt och slå på Tidskänsliga notiser.',
        'Kolla när Kör bil startar av sig själv: Inställningar → Fokus → Kör bil → Aktivera automatiskt.',
      ],
      not: 'Kör bil slår ofta på sig själv när telefonen känner av biltempo eller kopplar till bilens Bluetooth — alltså precis när appen behövs. Är Polisvakt inte tillagd där hörs ingenting, hur många ja du än tryckt på tidigare.',
    };
  }
  if (p.os === 'android') {
    return {
      rubrik: 'Släpp igenom Polisvakt i Stör ej',
      steg: [
        'Öppna Inställningar → Lägen och välj Stör ej. (På äldre Android: Inställningar → Aviseringar → Stör ej.)',
        'Under Aviseringsfilter, tryck på Appar.',
        'Lägg till Polisvakt i listan över appar som får skicka aviseringar.',
        'På Samsung: Inställningar → Aviseringar → Stör ej → Tillåtna undantag → Appaviseringar.',
        'Kolla också scheman och rutiner som slår på Stör ej av sig själv — till exempel bilhållare, Bluetooth eller Android Auto.',
      ],
      not: 'Ligger appen inte på startskärmen som egen ikon heter den din webbläsares namn i listan, inte Polisvakt.',
    };
  }
  return {
    rubrik: 'Släpp igenom Polisvakt i Stör ej',
    steg: [
      'Windows: Inställningar → System → Aviseringar → Stör ej och prioriterade aviseringar.',
      'Mac: Systeminställningar → Fokus → välj fokus → Tillåtna notiser.',
      'Lägg till webbläsaren i listan över tillåtna.',
    ],
    not: 'På telefonen är det här steget viktigare — det är där ett fokusläge kan slå på sig själv när du kör.',
  };
}

/* ============================= BAKGRUND ============================= */

/**
 * Vad appen gör och inte gör när den är stängd. Samma text överallt.
 *
 * Det här är inte en formulering man ska mjuka upp för att den låter dålig.
 * En förare som tror att telefonen håller vakt i fickan kör utan att slå på
 * appen och blir förvånad — och det är i det ögonblicket ett dokumentfel blir
 * ett trafiksäkerhetsproblem.
 */
export const BAKGRUND = {
  kort: 'Polisvakt varnar inte i bakgrunden. Appen måste vara öppen och framme för att läsa GPS och säga till.',
  kan: [
    'Skicka en notis som påminner dig att slå på appen innan du kör, baserat på tider du brukar köra.',
    'Skicka en notis när polis rapporterats i närheten, genom samma kanal.',
  ],
  kanInte: [
    'Läsa din position när appen är stängd eller ligger i bakgrunden — webbläsaren stänger av GPS då, och det går inte att koda sig runt.',
    'Säga till med rösten när appen inte är framme.',
    'Räkna hastighet, hålla koll på fartkameror eller lära sig dina vanor medan den är stängd.',
  ],
};

/* ============================== STATUS ============================== */

/**
 * Allt på en gång, i den ordning UI:t ska visa det.
 *
 * @param {{snabb?:boolean}} opts
 * @returns {Promise<{plats:object, notiser:object, fokus:object, lista:object[],
 *                    klart:boolean, saknas:string[], plattform:object, bakgrund:object}>}
 */
export async function status({ snabb = false } = {}) {
  const [plats, notiser] = await Promise.all([
    platsStatus(),
    notisStatus({ snabb }),
  ]);
  const fokus = fokusStatus();
  const lista = [plats, notiser, fokus];

  return {
    plats, notiser, fokus, lista,
    plattform: plattform(),
    bakgrund: BAKGRUND,
    klart: lista.every(x => x.ok),
    saknas: lista.filter(x => !x.ok).map(x => x.nyckel),
  };
}

/** Snabb koll utan att vänta på service workern. Samma form som status(). */
export const snabbStatus = () => status({ snabb: true });
