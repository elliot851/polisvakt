// Krock- och tillbudsdetektering via telefonens accelerometer.
//
// Poängen med en dashcam är att du inte trycker på knappar under en krock.
// Telefonen känner smällen långt innan du hinner reagera, så den får låsa
// klippet själv.
//
// Nivåerna är satta efter vad som faktiskt händer i en bil:
//   normal körning        under 0,3 g
//   kraftig inbromsning   0,6 - 0,9 g
//   panikbroms            ungefär 1,0 g (däckens gräns på torr asfalt)
//   kollision             3 g och uppåt, ofta betydligt mer
//
// Därför två nivåer: en händelse vid 1,2 g som bara noteras, och en
// krockdetektering vid 3 g som låser klippet och säger till.
//
// iOS kräver att användaren aktivt ger tillstånd till rörelsedata, och bara
// från ett riktigt knapptryck. Därför finns requestPermission som eget steg.

const G = 9.80665;

export const motionSupported = typeof window.DeviceMotionEvent !== 'undefined';
export const motionNeedsPermission =
  motionSupported && typeof DeviceMotionEvent.requestPermission === 'function';

export class ImpactDetector extends EventTarget {
  constructor(opts = {}) {
    super();
    this.hardBrakeG = opts.hardBrakeG ?? 1.2;
    this.crashG = opts.crashG ?? 3.0;
    this.cooldownMs = opts.cooldownMs ?? 20000;

    this.running = false;
    this.permission = motionNeedsPermission ? 'unknown' : 'granted';
    this.peakG = 0;
    this.lastEventAt = 0;
    this.baseline = G;              // vilande tyngdkraft, kalibreras löpande
    this._handler = e => this.#onMotion(e);
    this._samples = 0;
  }

  /** Måste anropas från ett riktigt knapptryck på iOS. */
  async requestPermission() {
    if (!motionNeedsPermission) { this.permission = 'granted'; return true; }
    try {
      const res = await DeviceMotionEvent.requestPermission();
      this.permission = res === 'granted' ? 'granted' : 'denied';
      return this.permission === 'granted';
    } catch {
      this.permission = 'denied';
      return false;
    }
  }

  async start() {
    if (this.running || !motionSupported) return false;
    if (this.permission !== 'granted') {
      const ok = await this.requestPermission();
      if (!ok) return false;
    }
    addEventListener('devicemotion', this._handler);
    this.running = true;
    this._samples = 0;
    this.#emit('start');
    return true;
  }

  stop() {
    if (!this.running) return;
    removeEventListener('devicemotion', this._handler);
    this.running = false;
    this.#emit('stop');
  }

  #onMotion(e) {
    // includingGravity finns på fler enheter och är stabilare att kalibrera mot
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;

    const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);

    // Håll ett långsamt glidande medelvärde som nollpunkt. En telefon i en
    // hållare ligger inte plant, och tyngdkraften fördelas olika på axlarna.
    this._samples++;
    if (this._samples < 30) { this.baseline = mag; return; }
    this.baseline = this.baseline * 0.995 + mag * 0.005;

    const deltaG = Math.abs(mag - this.baseline) / G;
    if (deltaG > this.peakG) this.peakG = deltaG;

    const now = Date.now();
    if (now - this.lastEventAt < this.cooldownMs) return;

    if (deltaG >= this.crashG) {
      this.lastEventAt = now;
      this.#emit('impact', {
        level: 'crash', g: +deltaG.toFixed(1),
        text: `Kraftig smäll registrerad (${deltaG.toFixed(1)} g). Klippet är låst.`,
      });
    } else if (deltaG >= this.hardBrakeG) {
      this.lastEventAt = now;
      this.#emit('impact', {
        level: 'hardbrake', g: +deltaG.toFixed(1),
        text: `Kraftig inbromsning (${deltaG.toFixed(1)} g). Klippet är låst.`,
      });
    }
  }

  /** Högsta uppmätta värdet sedan senaste nollställningen. */
  resetPeak() { const p = this.peakG; this.peakG = 0; return p; }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}
