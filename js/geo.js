// GPS-spårning med utjämnad kurs och hastighet.

import { distance, bearing, toKmh } from './util.js';

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
    this.watchId = navigator.geolocation.watchPosition(
      p => this.#onPosition(p),
      e => this.#onError(e),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  stop() {
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

/** Engångsposition — används när man rapporterar "här". */
export function currentPosition(timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Ingen GPS'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      e => reject(e),
      { enableHighAccuracy: true, timeout, maximumAge: 5000 }
    );
  });
}
