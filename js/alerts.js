// Varningsmotorn: avgör vad föraren ska höra, och när.
//
// Reglerna skiljer sig mellan fasta och rörliga faror:
//
//   Fartkamera  Riktad. Varnar bara om du faktiskt kör mot den, och en gång
//               per passage. Avståndet skalas med hastigheten så du hinner
//               sakta ner i tid — 110 km/h behöver längre framförhållning
//               än 50.
//
//   Polis /     Områdesvarning. Riktningen spelar mindre roll eftersom
//   kontroll    polisen kan flytta sig. Varnar en gång inom radien, sedan
//               igen först om du lämnat och kommit tillbaka.

import { distance, bearing, angleDiff, spokenDistance, spokenAge, clockDirection } from './util.js';
import { TYPE_SPOKEN } from './parser.js';
import { byggMening } from './kvalitet.js';

const DEFAULTS = {
  cameraLeadSeconds: 25,      // så många sekunder före kameran
  cameraMinM: 350,
  cameraMaxM: 1200,
  cameraConeDeg: 55,          // hur snett du får köra och ändå varnas
  hazardRadiusM: 1500,
  hazardRearmM: 600,          // måste lämna radien + detta innan ny varning
  repeatAfterMs: 8 * 60000,
  minSpeedKmh: 15,            // varna inte när du står stilla
};

export class AlertEngine extends EventTarget {
  constructor(speaker, opts = {}) {
    super();
    this.speaker = speaker;
    this.opts = { ...DEFAULTS, ...opts };
    this.state = new Map();   // hazardId -> { warnedAt, insideRadius, closest }
    this.enabled = true;
  }

  setOptions(o) { this.opts = { ...this.opts, ...o }; }

  reset() { this.state.clear(); }

  /**
   * @param {{lat,lon,headingSmoothed,speedKmh,moving}} fix
   * @param {Array} hazards  rapporter + fartkameror, alla med {id,type,lat,lon,label}
   */
  evaluate(fix, hazards) {
    if (!this.enabled || !fix) return [];
    const now = Date.now();
    const speed = fix.speedKmh ?? 0;
    const heading = fix.headingSmoothed;
    const fired = [];

    for (const h of hazards) {
      const d = distance(fix.lat, fix.lon, h.lat, h.lon);
      const st = this.state.get(h.id) || { warnedAt: 0, insideRadius: false, closest: Infinity };

      const isCamera = h.type === 'camera';
      const trigger = isCamera
        ? this.#cameraTrigger(fix, h, d, speed, heading, st, now)
        : this.#hazardTrigger(fix, h, d, speed, st, now);

      st.closest = Math.min(st.closest, d);
      if (trigger) {
        st.warnedAt = now;
        st.insideRadius = true;
        st.closest = d;
        const alert = this.#buildAlert(h, d, fix, heading);
        fired.push(alert);
      }

      // Återställ när man lämnat området, så nästa passage varnar igen
      const rearmAt = isCamera
        ? this.opts.cameraMaxM + 500
        : this.opts.hazardRadiusM + this.opts.hazardRearmM;
      if (d > rearmAt) {
        st.insideRadius = false;
        st.closest = Infinity;
        if (now - st.warnedAt > this.opts.repeatAfterMs) st.warnedAt = 0;
      }
      this.state.set(h.id, st);
    }

    // Om flera faror triggar samtidigt: läs den närmaste, nämn resten kort
    if (fired.length) this.#announce(fired);
    return fired;
  }

  #cameraTrigger(fix, h, d, speed, heading, st, now) {
    if (speed < this.opts.minSpeedKmh) return false;
    if (st.insideRadius) return false;
    if (now - st.warnedAt < this.opts.repeatAfterMs) return false;

    // Avstånd som motsvarar cameraLeadSeconds i nuvarande fart
    const lead = Math.round((speed / 3.6) * this.opts.cameraLeadSeconds);
    const range = Math.min(this.opts.cameraMaxM, Math.max(this.opts.cameraMinM, lead));
    if (d > range) return false;

    // Kör vi mot den?
    if (heading != null) {
      const toHazard = bearing(fix.lat, fix.lon, h.lat, h.lon);
      if (angleDiff(heading, toHazard) > this.opts.cameraConeDeg) return false;

      // Kameran mäter åt ett håll. Har vi riktningsdata, hoppa över den
      // om vi kör åt motsatt håll mot mätriktningen.
      if (Number.isFinite(h.bearing)) {
        if (angleDiff(heading, h.bearing) > 90) return false;
      }
    }
    return true;
  }

  #hazardTrigger(fix, h, d, speed, st, now) {
    if (st.insideRadius) return false;
    if (now - st.warnedAt < this.opts.repeatAfterMs) return false;
    if (d > this.opts.hazardRadiusM) return false;
    // Stillastående i garaget ska inte trigga, men rullar man sakta i stan
    // vill man absolut veta
    if (speed < 5) return false;
    return true;
  }

  #buildAlert(h, d, fix, heading) {
    const kind = TYPE_SPOKEN[h.type] || 'varning';
    const where = h.label ? ` vid ${h.label}` : '';
    const dist = spokenDistance(d);

    /*
     * Hedgad formulering från kvalitet.js går före den vanliga.
     *
     * Skillnaden är inte kosmetisk. "Varning. Polis vid Erikslund" är appens
     * eget påstående — visar det sig fel känner sig föraren lurad, och nästa
     * gång tror hen inte på oss. "Polis rapporterad i området kring
     * Erikslund, för 26 minuter sedan" går att agera vettigt på och håller
     * fortfarande när det inte stämmer, eftersom vi aldrig påstod att vi
     * visste.
     *
     * Är platsen hedgad saknas klockriktningen med flit: falsk precision är
     * samma svek som ett falskt påstående.
     */
    if (h.bedomning) {
      const clock = heading != null
        ? clockDirection(heading, bearing(fix.lat, fix.lon, h.lat, h.lon))
        : null;
      const mening = byggMening(h.bedomning, h, {
        avstandM: d,
        klockriktning: clock,
      });
      if (mening) {
        return {
          id: h.id, hazard: h, distance: d, spoken: mening,
          priority: d < 500 ? 2 : 1,
          at: Date.now(),
        };
      }
    }

    let spoken;
    if (h.type === 'camera') {
      const limit = h.speedLimit ? `, ${h.speedLimit}` : '';
      spoken = `Fartkamera om ${dist}${limit}.`;
    } else {
      const clock = heading != null
        ? clockDirection(heading, bearing(fix.lat, fix.lon, h.lat, h.lon))
        : null;
      const dir = clock && d > 400 ? ` klockan ${clock}` : '';
      const age = h.createdAt ? `, rapporterat ${spokenAge(h.createdAt)}` : '';
      spoken = `Varning. ${cap(kind)}${where}, om ${dist}${dir}${age}.`;
    }

    return {
      id: h.id,
      hazard: h,
      distance: d,
      spoken,
      priority: d < 500 ? 2 : 1,
      at: Date.now(),
    };
  }

  #announce(fired) {
    fired.sort((a, b) => a.distance - b.distance);
    const first = fired[0];
    this.speaker.chime('alert');
    setTimeout(() => {
      this.speaker.say(first.spoken, { priority: first.priority, interrupt: first.priority === 2 });
      if (fired.length > 1) {
        this.speaker.say(`Ytterligare ${fired.length - 1} varning${fired.length > 2 ? 'ar' : ''} i närheten.`,
          { priority: 0 });
      }
    }, 380);
    for (const a of fired) this.dispatchEvent(new CustomEvent('alert', { detail: a }));
  }
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
