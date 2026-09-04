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
    this.lastLevel = null;          // 'crash' | 'hardbrake' — senast utlösta nivå
    // Vilande tyngdkraft som VEKTOR (en per axel), inte som skalär. Se #onMotion
    // för varför skalären var fel.
    this.bx = 0; this.by = 0; this.bz = 0;
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
    // Har enheten en tyngdkraftsFRI avläsning är den bäst: magnituden ÄR då
    // själva händelsen, utan att tyngdkraften behöver räknas bort.
    const lin = e.acceleration;
    if (lin && lin.x != null && (lin.x || lin.y || lin.z)) {
      this.#bedom(Math.hypot(lin.x || 0, lin.y || 0, lin.z || 0) / G);
      return;
    }

    // Annars: accelerationIncludingGravity. Här satt den gamla buggen. Att ta
    // magnituden och jämföra mot en skalär ~1 g-nollpunkt är fel: tyngdkraften
    // (~1 g) ligger alltid på och står ungefär vinkelrätt mot broms-/krocklaster,
    // så en horisontell händelse adderas i KVADRATUR — en riktig panikbroms på
    // 1 g läses som sqrt(1+1)-1 ≈ 0,41 g och en 3 g-krock som ≈ 2,16 g, under
    // trösklarna. Rätt sätt är att dra bort tyngdkraften som VEKTOR (per axel)
    // och mäta längden på det som blir kvar (den linjära accelerationen).
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const ax = a.x || 0, ay = a.y || 0, az = a.z || 0;

    // Uppvärmning: medelvärda de första rutorna till en nollpunkt, så en enda
    // guppig första ruta inte förgiftar vektorn.
    if (this._samples < 30) {
      this._samples++;
      this.bx = (this.bx * (this._samples - 1) + ax) / this._samples;
      this.by = (this.by * (this._samples - 1) + ay) / this._samples;
      this.bz = (this.bz * (this._samples - 1) + az) / this._samples;
      return;
    }

    const g = Math.hypot(ax - this.bx, ay - this.by, az - this.bz) / G;
    // Låt nollpunkten glida med långsamt — men BARA när det är lugnt, annars
    // äter själva händelsen upp sin egen nollpunkt och trycket försvinner.
    if (g < 0.4) {
      this.bx = this.bx * 0.99 + ax * 0.01;
      this.by = this.by * 0.99 + ay * 0.01;
      this.bz = this.bz * 0.99 + az * 0.01;
    }
    this.#bedom(g);
  }

  #bedom(g) {
    if (g > this.peakG) this.peakG = g;
    const now = Date.now();
    const iCooldown = now - this.lastEventAt < this.cooldownMs;

    if (g >= this.crashG) {
      // En krock får ALLTID lösa ut — även strax efter en hårdbroms, för det
      // vanligaste krockförloppet är broms följt av smäll inom en sekund, och
      // förr blindade hårdbromsens cooldown den efterföljande krocken i 20 s.
      // Undantaget: en krock som redan låst nyss ska inte dubbelrapportera på
      // sin egen efterskälvning.
      if (iCooldown && this.lastLevel === 'crash') return;
      this.lastEventAt = now; this.lastLevel = 'crash';
      this.#emit('impact', {
        level: 'crash', g: +g.toFixed(1),
        text: `Kraftig smäll registrerad (${g.toFixed(1)} g). Klippet är låst.`,
      });
      return;
    }
    if (g >= this.hardBrakeG) {
      if (iCooldown) return;                 // hårdbroms respekterar cooldown
      this.lastEventAt = now; this.lastLevel = 'hardbrake';
      this.#emit('impact', {
        level: 'hardbrake', g: +g.toFixed(1),
        text: `Kraftig inbromsning (${g.toFixed(1)} g). Klippet är låst.`,
      });
    }
  }

  /** Högsta uppmätta värdet sedan senaste nollställningen. */
  resetPeak() { const p = this.peakG; this.peakG = 0; return p; }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}
