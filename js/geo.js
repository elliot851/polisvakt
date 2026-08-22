// GPS-spårning med utjämnad kurs och hastighet.
//
// Filen äger också GRINDEN för platsfrågan — se avsnittet längre ner. Kort:
// watchPosition är det som i praktiken utlöser webbläsarens platsruta, och
// därför är det här den frågan måste hållas tillbaka tills föraren fått veta
// varför appen ber om den.

import { distance, bearing, toKmh } from './util.js';
import { platsMinne, platsFragad } from './behorigheter.js';

/* ------------------------------------------------------------------ */
/* Grinden: när får platsrutan visas?                                  */
/* ------------------------------------------------------------------ */
//
// Förr anropades watchPosition vid sidladdning, utan fingertryck och innan
// föraren sett en enda rad om varför appen behöver plats. Två saker blev fel:
//
//   • Frågan kom oförklarad, mitt i en app användaren aldrig sett. En förare
//     som inte förstår frågan trycker Neka — och webbläsaren frågar aldrig
//     igen. Ett nej som beror på förvirring är permanent.
//   • På iOS Safari kräver platsrutan i praktiken en levande användargest.
//     Utan gest kan den tystas helt: appen fick varken svar eller position,
//     och ingenting syntes.
//
// Numera håller grinden tillbaka watchPosition vid ALLRA första starten, tills
// js/platsstart.js hunnit förklara varför och låta föraren trycka själv. Har
// appen frågat förr står grinden öppen direkt — då är rutan redan besvarad en
// gång, och att vänta skulle bara försena GPS:en för alla befintliga
// användare.
//
// NÖDUTGÅNG. Om platsstart.js inte laddar, kraschar, eller aldrig får plats på
// skärmen släpps grinden ändå efter NODUTGANG_MS, och appen beter sig som
// förr. En app utan GPS är värdelös, och det får aldrig bero på att en
// dialogruta gick sönder. platsstart.js håller grinden stängd genom att pinga
// hallGrinden() så länge den lever och väntar — slutar pingandet öppnas
// grinden av sig själv.

const NODUTGANG_MS = 25000;

let grind = 'oppen';          // 'oppen' | 'vantar' | 'uppskjuten'
let grindBestamd = false;
let grindOrsak = 'start';
let nodutgangTimer = null;
const vantandeSparare = new Set();

function bestamGrind() {
  if (grindBestamd) return grind;
  grindBestamd = true;

  // Utan DOM finns ingen som kan rita frågan. Då är väntan bara en fördröjning.
  if (typeof window === 'undefined' || typeof document === 'undefined') return grind;

  // Har vi frågat förr — oavsett svar — är det inte längre första starten.
  if (platsMinne() || platsFragad()) { grindOrsak = 'har-fragat-forr'; return grind; }

  grind = 'vantar';
  grindOrsak = 'forsta-starten';
  hallGrinden();
  return grind;
}

/** Vad grinden gör just nu, och varför. */
export function grindLage() {
  bestamGrind();
  return { lage: grind, orsak: grindOrsak, vantande: vantandeSparare.size };
}

/**
 * Håll grinden stängd en stund till. platsstart.js pingar den medan den lever
 * och väntar på ledig skärm; tystnar pingen träder nödutgången in.
 */
export function hallGrinden(ms = NODUTGANG_MS) {
  if (grind !== 'vantar') return;
  clearTimeout(nodutgangTimer);
  nodutgangTimer = setTimeout(() => slappFramPlats('nodutgang'), ms);
}

/** Föraren har svarat, eller vi behöver inte fråga. Släpp fram GPS:en. */
export function slappFramPlats(orsak = 'ok') {
  grindBestamd = true;
  grind = 'oppen';
  grindOrsak = orsak;
  clearTimeout(nodutgangTimer);
  nodutgangTimer = null;
  for (const t of [...vantandeSparare]) {
    vantandeSparare.delete(t);
    t.start();
  }
}

/**
 * Föraren sa "inte nu".
 *
 * Ingen nödutgång här: att öppna grinden bakvägen tjugofem sekunder efter ett
 * "inte nu" hade gett exakt den oförklarade systemruta som hela grinden finns
 * för att undvika, och dessutom fått appen att framstå som att den inte
 * lyssnar. Grinden öppnas nu bara av ett nytt tryck.
 */
export function skjutUppPlats(orsak = 'inte-nu') {
  bestamGrind();
  if (grind === 'oppen') return false;
  grind = 'uppskjuten';
  grindOrsak = orsak;
  clearTimeout(nodutgangTimer);
  nodutgangTimer = null;
  return true;
}

export class GeoTracker extends EventTarget {
  constructor() {
    super();
    this.watchId = null;
    this.last = null;          // { lat, lon, accuracy, speed, heading, ts }
    this.history = [];         // senaste positionerna, för kursberäkning
    this.permission = 'unknown';
  }

  get position() { return this.last; }
  get isTracking() { return this.watchId !== null; }

  start() {
    if (this.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      this.#emit('error', { message: 'Enheten saknar GPS-stöd.' });
      return;
    }
    if (bestamGrind() !== 'oppen') {
      // Inte ett fel: föraren har bara inte fått frågan förklarad än.
      // slappFramPlats() startar oss så fort hen svarat, och nödutgången
      // startar oss ändå om ingen dialog dyker upp.
      vantandeSparare.add(this);
      this.#emit('vantar', { grind: grindLage() });
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      p => this.#onPosition(p),
      e => this.#onError(e),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  stop() {
    // Stod vi i kö bakom grinden ska vi inte startas av ett senare
    // slappFramPlats — någon har uttryckligen bett oss sluta.
    vantandeSparare.delete(this);
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  #onPosition(p) {
    const c = p.coords;
    const fix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      speed: c.speed,                 // m/s eller null
      heading: c.heading,             // grader eller null
      ts: p.timestamp || Date.now(),
    };

    // Många telefoner ger heading = null när man står still, och orimliga
    // värden vid låg fart. Räkna ut kursen ur positionshistoriken istället.
    this.history.push(fix);
    if (this.history.length > 8) this.history.shift();

    const derived = this.#deriveMotion();
    fix.headingSmoothed = derived.heading;
    fix.speedKmh = derived.speedKmh;
    fix.moving = derived.speedKmh != null && derived.speedKmh > 8;

    this.last = fix;
    this.permission = 'granted';
    this.#emit('position', fix);
  }

  /** Kurs och fart ur de senaste fixarna — stabilare än rådata. */
  #deriveMotion() {
    const h = this.history;
    const newest = h[h.length - 1];

    let speedKmh = toKmh(newest.speed);
    let heading = Number.isFinite(newest.heading) ? newest.heading : null;

    // Hitta en tillräckligt gammal punkt att räkna vektor mot (>= 15 m bort)
    let ref = null;
    for (let i = h.length - 2; i >= 0; i--) {
      if (distance(h[i].lat, h[i].lon, newest.lat, newest.lon) >= 15) { ref = h[i]; break; }
    }
    if (ref) {
      const d = distance(ref.lat, ref.lon, newest.lat, newest.lon);
      const dt = (newest.ts - ref.ts) / 1000;
      if (dt > 0.5) {
        const calc = (d / dt) * 3.6;
        if (speedKmh == null || !Number.isFinite(speedKmh)) speedKmh = calc;
      }
      if (heading == null || !Number.isFinite(heading)) {
        heading = bearing(ref.lat, ref.lon, newest.lat, newest.lon);
      }
    }

    if (speedKmh != null) speedKmh = Math.max(0, Math.round(speedKmh));
    return { heading, speedKmh };
  }

  #onError(e) {
    const msg = {
      1: 'Platsåtkomst nekad. Tillåt plats i webbläsarens inställningar.',
      2: 'Ingen GPS-signal.',
      3: 'GPS-timeout.',
    }[e.code] || 'GPS-fel.';
    if (e.code === 1) this.permission = 'denied';
    this.#emit('error', { code: e.code, message: msg });
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

/**
 * Engångsposition — används när man rapporterar "här".
 *
 * Grinden gäller inte här. Det här anropet sker alltid i ett fingertryck som
 * föraren själv gjort för att peka ut en plats, alltså med samma förklaring
 * som grinden finns för att ge — bara i form av handling istället för text.
 * Går det igenom öppnas grinden, så watchPosition slipper stå och vänta på en
 * fråga som redan är besvarad.
 */
export function currentPosition(timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Ingen GPS'));
    navigator.geolocation.getCurrentPosition(
      p => {
        slappFramPlats('rapport');
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy });
      },
      e => reject(e),
      { enableHighAccuracy: true, timeout, maximumAge: 5000 }
    );
  });
}

/*
 * Första starten ritas av js/platsstart.js.
 *
 * Dynamisk import, inte en vanlig, av två skäl. Dels behöver platsstart.js
 * geo.js och inte tvärtom — en statisk import åt det här hållet hade blivit en
 * cirkel. Dels ska en trasig dialogruta aldrig kunna hindra GPS:en från att
 * starta: går importen fel fångas det här, och nödutgången i grinden öppnar
 * den av sig själv.
 *
 * Ansvaret ligger i den här filen därför att det är watchPosition ovanför som
 * utlöser platsrutan. Den som äger frågan ska också se till att den ställs
 * begripligt.
 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  import('./platsstart.js').catch(() => slappFramPlats('platsstart-saknas'));
}
