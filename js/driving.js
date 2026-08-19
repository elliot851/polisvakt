// Körningsdetektering och påminnelse.
//
// Den vanligaste anledningen till att en varningsapp inte hjälper någon är
// inte att varningarna är dåliga. Det är att appen aldrig startades. Man sätter
// sig i bilen, kör iväg, och kommer på det halvvägs.
//
// Så här löser vi det, och det är värt att vara rak om begränsningen:
//
// En webbapp får INTE läsa GPS i bakgrunden. Webbläsaren stänger av positionen
// så fort appen inte ligger framme, och det finns ingen väg runt det. Vi kan
// alltså inte känna av att bilen börjar rulla medan telefonen ligger i fickan.
//
// Det vi kan göra är två saker som tillsammans blir nästan lika bra:
//
//   1. Lära oss vanan. Varje gång appen används under körning noteras veckodag
//      och timme. Efter ett par veckor vet vi att du nästan alltid kör vid
//      07:20 på vardagar, och kan skicka en notis strax innan — via systemets
//      egen påminnelse, som fungerar även när appen är stängd.
//
//   2. Fånga tillfället. Öppnas appen utan att köra igång, och telefonen sedan
//      börjar röra sig som en bil gör, säger appen till direkt.
//
// Det första kräver notistillstånd. Det andra kräver bara att appen är öppen.

const KEY = 'pv.driving.v1';
const HABIT_KEY = 'pv.habits.v1';

const load = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const notificationsSupported = 'Notification' in window;

export class DrivingDetector extends EventTarget {
  constructor(opts = {}) {
    super();
    this.state = { lastPrompt: 0, ...load(KEY, {}) };
    this.habits = load(HABIT_KEY, {});     // "dag-timme" -> antal körningar

    this.movingSince = 0;
    this.stillSince = Date.now();
    this.driving = false;
    this.promptCooldownMs = opts.promptCooldownMs ?? 30 * 60000;

    // Trösklar valda för att skilja bil från promenad och cykel.
    // 25 km/h går att cykla i nedförsbacke, men inte att hålla i en minut.
    this.startKmh = opts.startKmh ?? 25;
    this.sustainMs = opts.sustainMs ?? 20000;
    this.stopKmh = opts.stopKmh ?? 6;
    this.stopAfterMs = opts.stopAfterMs ?? 3 * 60000;
  }

  /* ---- Vanor ---- */

  #slot(d = new Date()) { return `${d.getDay()}-${d.getHours()}`; }

  /** Notera att en körning pågick nu. Bygger upp bilden av veckan. */
  recordDriving(when = new Date()) {
    const k = this.#slot(when);
    this.habits[k] = (this.habits[k] || 0) + 1;
    save(HABIT_KEY, this.habits);
  }

  /** Tider då du kör så ofta att det är värt en påminnelse. */
  likelyTimes(minCount = 3) {
    return Object.entries(this.habits)
      .filter(([, n]) => n >= minCount)
      .map(([k, n]) => {
        const [day, hour] = k.split('-').map(Number);
        return { day, hour, count: n };
      })
      .sort((a, b) => b.count - a.count);
  }

  /** Kör du typiskt just nu? Används för att välja tidpunkt för påminnelsen. */
  isTypicalDrivingTime(when = new Date()) {
    return (this.habits[this.#slot(when)] || 0) >= 3;
  }

  get habitStrength() {
    const n = Object.values(this.habits).reduce((a, b) => a + b, 0);
    return { slots: Object.keys(this.habits).length, drives: n };
  }

  /* ---- Rörelse ---- */

  /**
   * Mata in varje GPS-fix. Avgör om bilen rullar, och säger till första
   * gången appen upptäcker körning utan att varningarna är igång.
   * @param {{speedKmh:number|null}} fix
   * @param {boolean} armed  är varningarna redan påslagna?
   */
  update(fix, armed) {
    const speed = fix?.speedKmh ?? 0;
    const now = Date.now();

    if (speed >= this.startKmh) {
      this.stillSince = 0;
      if (!this.movingSince) this.movingSince = now;

      if (!this.driving && now - this.movingSince >= this.sustainMs) {
        this.driving = true;
        this.recordDriving();
        this.#emit('start');
        if (!armed) this.#maybePrompt();
      }
    } else if (speed <= this.stopKmh) {
      this.movingSince = 0;
      if (!this.stillSince) this.stillSince = now;
      if (this.driving && now - this.stillSince >= this.stopAfterMs) {
        this.driving = false;
        this.#emit('stop');
      }
    }
    return this.driving;
  }

  #maybePrompt() {
    const now = Date.now();
    if (now - (this.state.lastPrompt || 0) < this.promptCooldownMs) return;
    this.state.lastPrompt = now;
    save(KEY, this.state);
    this.#emit('prompt');
  }

  /* ---- Notiser ---- */

  get permission() {
    return notificationsSupported ? Notification.permission : 'unsupported';
  }

  /** Måste anropas från ett riktigt knapptryck. */
  async requestPermission() {
    if (!notificationsSupported) return false;
    try {
      const res = await Notification.requestPermission();
      return res === 'granted';
    } catch { return false; }
  }

  /**
   * Visa en påminnelse. Går via service workern när den finns, eftersom en
   * vanlig Notification inte visas när appen är stängd på Android.
   */
  async notify(title, body) {
    if (this.permission !== 'granted') return false;
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg?.showNotification) {
        await reg.showNotification(title, {
          body,
          icon: './icon.svg',
          badge: './icon.svg',
          tag: 'polisvakt-reminder',
          renotify: false,
          requireInteraction: false,
        });
        return true;
      }
      new Notification(title, { body, icon: './icon.svg' });
      return true;
    } catch { return false; }
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}

/** Läsbar sammanfattning av när någon brukar köra. */
export function describeHabits(times) {
  if (!times.length) return 'Appen har inte lärt sig dina tider än. Kör med den påslagen ett par gånger så kommer den ihåg.';
  const DAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
  const top = times.slice(0, 3)
    .map(t => `${DAYS[t.day]} runt ${String(t.hour).padStart(2, '0')}`)
    .join(', ');
  return `Du kör oftast ${top}.`;
}
