// Rapportpoäng och månadens topplista.
//
// Ett community-verktyg dör utan folk som matar det. Tjugonio kronor är en
// billig kostnad för att hålla de mest aktiva kvar, så de tio som rapporterar
// mest under en månad får nästa månad gratis.
//
// Poängsättningen är gjord för att belöna rätt sak. Att skicka in något ger
// lite. Att andra bekräftar det ger mycket mer. Att bli nedröstad kostar. Då
// lönar det sig att rapportera det som stämmer, inte att rapportera mest.

import { apiHeaders } from './config.js';

const KEY = 'pv.rep.v1';

export const POINTS = {
  report: 1,      // en rapport
  confirmed: 3,   // varje bekräftelse från någon annan
  denied: -4,     // varje nedröstning
  verify: 1,      // att själv bekräfta eller avfärda någon annans
};

export const REWARD_TOP_N = 10;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} }

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export class Reputation extends EventTarget {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.data = { months: {}, ...load() };
  }

  configure(cfg) { this.cfg = { ...this.cfg, ...cfg }; }

  #month(m = monthKey()) {
    return this.data.months[m] || (this.data.months[m] = { reports: 0, verifies: 0, confirmed: 0, denied: 0 });
  }

  addReport()  { this.#month().reports++;  this.#save(); }
  addVerify()  { this.#month().verifies++; this.#save(); }

  /**
   * Räkna om hur många bekräftelser och nedröstningar mina egna rapporter
   * fått. Görs från rapportlistan, så siffran stämmer även efter omstart.
   */
  /**
   * @param {object} store
   * @param {(id:string)=>boolean} arMin  avgör om en rapport är min
   *
   * Tog tidigare emot ett device_id och jämförde mot `r.device_id` på varje
   * rapport. Det kunde aldrig fungera: servern lämnar inte ut device_id.
   * Vyn `reports_feed` utelämnar kolumnen med flit, eftersom den knyter varje
   * rapport till en enskild telefon. Jämförelsen blev alltså alltid falsk,
   * loopen hoppade över allt, och bekräftelser räknades aldrig — poängen
   * fastnade på "antal rapporter" medan appen påstod att den belönar
   * rapporter som andra bekräftar.
   *
   * `isMine` i store.js håller reda på det lokalt, vilket är rätt ställe:
   * vilka rapporter som är mina behöver bara jag veta.
   */
  refreshFromStore(store, arMin) {
    const m = this.#month();
    let confirmed = 0, denied = 0;
    const from = new Date(); from.setDate(1); from.setHours(0, 0, 0, 0);
    for (const r of store.reports.values()) {
      if (!arMin(r.id)) continue;
      if ((r.createdAt || 0) < from.getTime()) continue;
      confirmed += Math.max(0, (r.confirms || 1) - 1);   // egen rapport räknas inte
      denied += r.denials || 0;
    }
    if (confirmed !== m.confirmed || denied !== m.denied) {
      m.confirmed = confirmed;
      m.denied = denied;
      this.#save();
    }
  }

  score(m = monthKey()) {
    const d = this.data.months[m];
    if (!d) return 0;
    return Math.max(0,
      d.reports * POINTS.report +
      d.confirmed * POINTS.confirmed +
      d.denied * POINTS.denied +
      d.verifies * POINTS.verify);
  }

  breakdown(m = monthKey()) {
    const d = this.data.months[m] || { reports: 0, verifies: 0, confirmed: 0, denied: 0 };
    return [
      { label: 'Rapporter', n: d.reports, points: d.reports * POINTS.report },
      { label: 'Bekräftade av andra', n: d.confirmed, points: d.confirmed * POINTS.confirmed },
      { label: 'Nedröstade', n: d.denied, points: d.denied * POINTS.denied },
      { label: 'Du hjälpte till att verifiera', n: d.verifies, points: d.verifies * POINTS.verify },
    ];
  }

  /**
   * Skicka upp poängen så den kan tävla mot andras. Går via funktion, inte
   * direkt tabellskrivning — servern avgör vems rad det är utifrån
   * inloggningen istället för att lita på det klienten påstår.
   */
  async publish(deviceId, nickname) {
    if (!this.cfg?.url || !this.cfg?.key) return false;
    try {
      const r = await fetch(`${this.cfg.url}/rest/v1/rpc/publish_score`, {
        method: 'POST',
        headers: {
          ...apiHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_device: deviceId,
          p_month: monthKey(),
          p_nickname: (nickname || '').slice(0, 20),
          p_score: this.score(),
          p_reports: this.#month().reports,
        }),
      });
      return r.ok;
    } catch { return false; }
  }

  /**
   * Månadens topplista. Läser en vy som med flit saknar device_id — för
   * inloggade är det fältet samma sak som konto-id, och en publik topplista
   * ska inte lämna ut det. Egen placering markeras därför på smeknamnet.
   */
  async leaderboard(limit = 10) {
    if (!this.cfg?.url || !this.cfg?.key) return null;
    try {
      const url = `${this.cfg.url}/rest/v1/leaderboard` +
        `?select=rank,nickname,score,reports&order=rank.asc&limit=${limit}`;
      const r = await fetch(url, {
        headers: apiHeaders(),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  get nickname() { return this.data.nickname || ''; }
  setNickname(n) { this.data.nickname = String(n || '').slice(0, 20); this.#save(); }

  #save() {
    save(this.data);
    this.dispatchEvent(new CustomEvent('change'));
  }
}

export { monthKey };
