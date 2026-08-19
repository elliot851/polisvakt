// Historik och mönster.
//
// En enskild varning är färskvara. Men samma rapporter, sparade över tid,
// blir något helt annat: "här står polisen ofta på fredagar mellan 15 och 18".
// Det är kunskap som gäller även när ingen just nu har rapporterat något, och
// det är den delen av appen som är svårast för någon annan att kopiera.
//
// Historiken lagras avsiktligt magert — plats, typ och tidpunkt. Inget om vem
// som rapporterade. Det behövs inte för mönstren och ska därför inte sparas.

import { apiHeaders } from './config.js';

const KEY = 'pv.history.v1';
const MAX_ENTRIES = 5000;

// Ungefär 220 x 280 meter vid Västerås latitud. Tillräckligt fint för att
// skilja två korsningar åt, tillräckligt grovt för att samma plats hamnar i
// samma ruta även när GPS:en spretar.
const GRID_LAT = 0.002;
const GRID_LON = 0.005;

const DAYS = ['söndagar', 'måndagar', 'tisdagar', 'onsdagar', 'torsdagar', 'fredagar', 'lördagar'];
const BUCKET_HOURS = 3;

const cellKey = (lat, lon) =>
  `${Math.round(lat / GRID_LAT)}:${Math.round(lon / GRID_LON)}`;

const cellCenter = key => {
  const [y, x] = key.split(':').map(Number);
  return { lat: y * GRID_LAT, lon: x * GRID_LON };
};

const bucketLabel = b => {
  const from = b * BUCKET_HOURS;
  return `${String(from).padStart(2, '0')}–${String((from + BUCKET_HOURS) % 24).padStart(2, '0')}`;
};

export class Stats extends EventTarget {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;                  // { url, key } för Supabase
    this.entries = load();
    this.seenIds = new Set(this.entries.map(e => e.i).filter(Boolean));
    this.announced = new Map();      // hotspot -> senast omnämnd, så det inte blir tjatigt
  }

  configure(cfg) { this.cfg = { ...this.cfg, ...cfg }; }

  /* ---- Insamling ---- */

  /** Lägg en rapport i historiken. Tål att anropas med samma rapport igen. */
  record(report) {
    if (!report || report.fixed) return;
    if (report.id && this.seenIds.has(report.id)) return;
    if (report.id) this.seenIds.add(report.id);

    this.entries.push({
      i: report.id,
      t: report.type,
      y: +(+report.lat).toFixed(5),
      x: +(+report.lon).toFixed(5),
      a: report.createdAt || Date.now(),
      n: (report.label || '').slice(0, 40),
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
      this.seenIds = new Set(this.entries.map(e => e.i).filter(Boolean));
    }
    this.#saveSoon();
  }

  recordAll(reports) {
    for (const r of reports) this.record(r);
  }

  /** Hämta historik som andra användare byggt upp. */
  async syncFromServer(days = 90) {
    if (!this.cfg?.url || !this.cfg?.key) return 0;
    try {
      const since = Date.now() - days * 86400_000;
      const url = `${this.cfg.url}/rest/v1/report_history` +
        `?select=type,lat,lon,created_at,label&created_at=gt.${since}&order=created_at.desc&limit=5000`;
      const r = await fetch(url, {
        headers: apiHeaders(),
      });
      if (!r.ok) return 0;
      const rows = await r.json();
      let added = 0;
      const known = new Set(this.entries.map(e => `${e.t}|${e.y}|${e.x}|${e.a}`));
      for (const row of rows) {
        const e = {
          t: row.type,
          y: +(+row.lat).toFixed(5),
          x: +(+row.lon).toFixed(5),
          a: typeof row.created_at === 'number' ? row.created_at : Date.parse(row.created_at),
          n: (row.label || '').slice(0, 40),
        };
        const k = `${e.t}|${e.y}|${e.x}|${e.a}`;
        if (known.has(k)) continue;
        known.add(k);
        this.entries.push(e);
        added++;
      }
      if (added) {
        this.entries.sort((a, b) => a.a - b.a);
        if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
        this.#saveSoon();
        this.dispatchEvent(new CustomEvent('change'));
      }
      return added;
    } catch { return 0; }
  }

  /* ---- Analys ---- */

  /**
   * Gruppera historiken i platser och räkna ut när på veckan de är aktiva.
   * @returns {Array<{key, lat, lon, label, count, types, topDay, topBucket, share, spoken}>}
   */
  hotspots({ minCount = 3, type = null, limit = 20 } = {}) {
    const cells = new Map();

    for (const e of this.entries) {
      if (type && e.t !== type) continue;
      const k = cellKey(e.y, e.x);
      let c = cells.get(k);
      if (!c) {
        cells.set(k, c = {
          key: k, count: 0, types: {}, labels: {},
          when: new Map(),            // "dag:hinkindex" -> antal
          days: new Array(7).fill(0),
          buckets: new Array(Math.ceil(24 / BUCKET_HOURS)).fill(0),
          latSum: 0, lonSum: 0, last: 0,
        });
      }
      const d = new Date(e.a);
      const day = d.getDay();
      const bucket = Math.floor(d.getHours() / BUCKET_HOURS);

      c.count++;
      c.types[e.t] = (c.types[e.t] || 0) + 1;
      if (e.n) c.labels[e.n] = (c.labels[e.n] || 0) + 1;
      c.days[day]++;
      c.buckets[bucket]++;
      c.when.set(`${day}:${bucket}`, (c.when.get(`${day}:${bucket}`) || 0) + 1);
      c.latSum += e.y; c.lonSum += e.x;
      c.last = Math.max(c.last, e.a);
    }

    const out = [];
    for (const c of cells.values()) {
      if (c.count < minCount) continue;

      const topDay = c.days.indexOf(Math.max(...c.days));
      const topBucket = c.buckets.indexOf(Math.max(...c.buckets));
      const dayShare = c.days[topDay] / c.count;
      const bucketShare = c.buckets[topBucket] / c.count;

      const label = Object.entries(c.labels).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const topType = Object.entries(c.types).sort((a, b) => b[1] - a[1])[0][0];

      out.push({
        key: c.key,
        lat: c.latSum / c.count,
        lon: c.lonSum / c.count,
        label: label || 'Okänd plats',
        count: c.count,
        type: topType,
        types: c.types,
        topDay, topBucket, dayShare, bucketShare,
        lastSeen: c.last,
        spoken: describe({ label, count: c.count, topDay, topBucket, dayShare, bucketShare }),
      });
    }
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, limit);
  }

  /**
   * Är den här platsen och tiden historiskt sett riskabel?
   * @returns {null | {hotspot, matchesTime:boolean, spoken:string}}
   */
  riskAt(lat, lon, when = new Date(), radiusM = 400) {
    const spots = this._cache && Date.now() - this._cacheAt < 60000
      ? this._cache
      : (this._cache = this.hotspots({ minCount: 3, limit: 200 }), this._cacheAt = Date.now(), this._cache);

    const day = when.getDay();
    const bucket = Math.floor(when.getHours() / BUCKET_HOURS);

    let best = null;
    for (const s of spots) {
      const d = roughDistance(lat, lon, s.lat, s.lon);
      if (d > radiusM) continue;
      const matchesTime = s.topDay === day || s.topBucket === bucket;
      const score = s.count * (matchesTime ? 2 : 1) - d / 100;
      if (!best || score > best.score) best = { score, hotspot: s, matchesTime, distance: d };
    }
    if (!best) return null;
    return {
      hotspot: best.hotspot,
      matchesTime: best.matchesTime,
      distance: best.distance,
      spoken: best.matchesTime
        ? `Här brukar det stå ${typeWord(best.hotspot.type)} vid den här tiden.`
        : `Här har det rapporterats ${typeWord(best.hotspot.type)} ${best.hotspot.count} gånger.`,
    };
  }

  /** Nämn en hotspot högst en gång per timme, så det inte blir tjatigt. */
  shouldAnnounce(hotspotKey) {
    const now = Date.now();
    const last = this.announced.get(hotspotKey);
    if (last && now - last < 3600_000) return false;
    this.announced.set(hotspotKey, now);
    return true;
  }

  get size() { return this.entries.length; }

  get span() {
    if (!this.entries.length) return null;
    const first = Math.min(...this.entries.map(e => e.a));
    return Math.max(1, Math.round((Date.now() - first) / 86400_000));
  }

  clear() {
    this.entries = [];
    this.seenIds.clear();
    this._cache = null;
    save(this.entries);
    this.dispatchEvent(new CustomEvent('change'));
  }

  #saveSoon() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      save(this.entries);
      this._cache = null;
      this.dispatchEvent(new CustomEvent('change'));
    }, 1500);
  }
}

/* ---- Formulering ---- */

function describe({ label, count, topDay, topBucket, dayShare, bucketShare }) {
  const where = label && label !== 'Okänd plats' ? `Vid ${label}` : 'Här';
  // Bara påstå ett mönster när det faktiskt finns ett. Med jämn spridning
  // över veckan är "oftast på tisdagar" ren slump.
  const dayStrong = dayShare > 0.35 && count >= 4;
  const timeStrong = bucketShare > 0.4 && count >= 4;

  if (dayStrong && timeStrong) return `${where}: oftast ${DAYS[topDay]} ${bucketLabel(topBucket)}.`;
  if (timeStrong) return `${where}: oftast mellan ${bucketLabel(topBucket)}.`;
  if (dayStrong) return `${where}: oftast ${DAYS[topDay]}.`;
  return `${where}: ${count} rapporter, ingen tydlig tid.`;
}

const typeWord = t => ({
  police: 'polis', camera: 'fartkamera', control: 'kontroll', unmarked: 'civil polis',
}[t] || 'polis');

function roughDistance(aLat, aLon, bLat, bLon) {
  const mLat = 111320, mLon = 111320 * Math.cos(aLat * Math.PI / 180);
  return Math.hypot((bLat - aLat) * mLat, (bLon - aLon) * mLon);
}

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function save(entries) {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); }
  catch { /* fullt — historiken är trevlig men inte kritisk */ }
}

export { DAYS, bucketLabel };
