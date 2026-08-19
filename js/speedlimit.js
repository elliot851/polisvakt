// Hastighetsgräns för vägen du kör på, från OpenStreetMap.
//
// Det här är funktionen som faktiskt räddar körkort. En polisvarning hjälper
// bara när polisen råkar vara rapporterad; att veta att du kör 92 där det är
// 70 hjälper alltid.
//
// Så funkar det:
//   1. Vägdata hämtas från Overpass i brickor på ungefär 6x6 km och sparas i
//      IndexedDB. En bricka räcker i tio minuters körning och behöver bara
//      hämtas en gång.
//   2. Varje vägsegment läggs i ett rutnät så att vi bara behöver testa de
//      hundratal segment som ligger närmast, inte alla tiotusen.
//   3. Positionen matchas mot närmaste segment som pekar åt samma håll som du
//      kör. Kursjämförelsen är det som gör att appen inte snappar till
//      korsande gator eller till motorvägen när du kör på parallellvägen.
//
// Täckningen i Västmanland är i praktiken fullständig — 92 % av alla vägar i
// Västerås har hastighet taggad, och det som saknas är hissar och perronger.
// Saknas gränsen visar appen ingenting hellre än att gissa.

import { distance, bearing, angleDiff } from './util.js';

const DB_NAME = 'pv-roads';
const STORE = 'tiles';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Brickstorlek i grader. Vid Västerås latitud blir det ungefär 6,7 x 6,2 km.
const TILE_LAT = 0.06;
const TILE_LON = 0.11;

// Rutnätet inuti en bricka, för snabb närhetssökning
const CELL_LAT = 0.003;      // ~330 m
const CELL_LON = 0.006;      // ~340 m

const EXCLUDED = 'footway|cycleway|path|steps|track|service|pedestrian|construction|proposed|bridleway|platform|elevator';

/* ---------------- Lagring ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    let out;
    Promise.resolve(fn(t.objectStore(STORE))).then(v => { out = v; }).catch(reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

const tileGet = key => idb('readonly', s => new Promise(res => {
  const r = s.get(key); r.onsuccess = () => res(r.result || null);
}));
const tilePut = tile => idb('readwrite', s => s.put(tile));
const tileAll = () => idb('readonly', s => new Promise(res => {
  const r = s.getAll(); r.onsuccess = () => res(r.result || []);
}));
const tileDel = key => idb('readwrite', s => s.delete(key));

/* ---------------- Hjälpare ---------------- */

const tileKey = (lat, lon) =>
  `${Math.floor(lat / TILE_LAT)}_${Math.floor(lon / TILE_LON)}`;

const tileBounds = (lat, lon) => {
  const y = Math.floor(lat / TILE_LAT), x = Math.floor(lon / TILE_LON);
  return { south: y * TILE_LAT, north: (y + 1) * TILE_LAT, west: x * TILE_LON, east: (x + 1) * TILE_LON };
};

/** OSM skriver mest siffror i Sverige, men inte alltid. */
function parseMaxspeed(v) {
  if (!v) return 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'none' || s === 'signals' || s === 'variable' || s === 'walk') return 0;
  const m = /^(\d+)/.exec(s);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (s.includes('mph')) return Math.round(n * 1.609);
  return n >= 5 && n <= 150 ? n : 0;
}

/* ---------------- Tjänsten ---------------- */

export class SpeedLimitService extends EventTarget {
  constructor(opts = {}) {
    super();
    this.enabled = opts.enabled ?? true;
    this.marginKmh = opts.marginKmh ?? 7;      // hur mycket över innan varning
    this.sustainMs = opts.sustainMs ?? 4000;   // hur länge, så GPS-spikar inte triggar
    this.cooldownMs = opts.cooldownMs ?? 90000;

    this.tiles = new Map();          // key -> { grid, ways }
    this.loading = new Set();
    this.failed = new Map();         // key -> tidpunkt, för att inte spamma

    this.current = null;             // { limit, name, distance, confidence }
    this._candidate = null;          // väg som väntar på bekräftelse
    this._candidateCount = 0;

    this.overSince = 0;
    this.lastWarnAt = 0;
    this.wasUnder = true;
  }

  setOptions(o) { Object.assign(this, o); }

  /* ---- Brickor ---- */

  async ensureTile(lat, lon) {
    const key = tileKey(lat, lon);
    if (this.tiles.has(key) || this.loading.has(key)) return;

    const failedAt = this.failed.get(key);
    if (failedAt && Date.now() - failedAt < 60000) return;

    this.loading.add(key);
    try {
      let tile = await tileGet(key);
      // Vägdata ändras långsamt. En månad är gott och väl färskt nog.
      if (tile && Date.now() - tile.fetchedAt > 30 * 86400_000) tile = null;

      if (!tile) {
        const ways = await this.#fetchTile(lat, lon);
        tile = { key, ways, fetchedAt: Date.now() };
        await tilePut(tile).catch(() => {});
        await this.#pruneTiles();
      }
      this.tiles.set(key, { ways: tile.ways, grid: this.#buildGrid(tile.ways) });
      this.failed.delete(key);
      this.#emit('tile', { key, ways: tile.ways.length });
    } catch (e) {
      this.failed.set(key, Date.now());
      this.#emit('error', { message: e.message });
    } finally {
      this.loading.delete(key);
    }
  }

  async #fetchTile(lat, lon) {
    const b = tileBounds(lat, lon);
    const q = `[out:json][timeout:30];` +
      `way["highway"]["maxspeed"]["highway"!~"${EXCLUDED}"]` +
      `(${b.south},${b.west},${b.north},${b.east});out tags geom;`;

    let lastErr;
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        // Komprimera direkt — rådatan är tre gånger så stor som vi behöver
        return json.elements
          .filter(w => w.geometry?.length >= 2)
          .map(w => ({
            s: parseMaxspeed(w.tags.maxspeed),
            n: w.tags.name || w.tags.ref || '',
            g: w.geometry.map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5)]),
          }))
          .filter(w => w.s > 0);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass svarade inte');
  }

  /** Håll bara de brickor som används; vägdata är tungt. */
  async #pruneTiles(max = 12) {
    const all = await tileAll();
    if (all.length <= max) return;
    all.sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const t of all.slice(0, all.length - max)) {
      await tileDel(t.key).catch(() => {});
      this.tiles.delete(t.key);
    }
  }

  /**
   * Lägg varje vägsegment i alla rutnätsceller det passerar igenom. Då räcker
   * det att titta i de nio cellerna runt bilen istället för i hela brickan.
   */
  #buildGrid(ways) {
    const grid = new Map();
    const add = (cy, cx, seg) => {
      const k = cy + ':' + cx;
      let arr = grid.get(k);
      if (!arr) grid.set(k, arr = []);
      arr.push(seg);
    };
    for (const w of ways) {
      for (let i = 0; i < w.g.length - 1; i++) {
        const a = w.g[i], b = w.g[i + 1];
        const seg = { a, b, s: w.s, n: w.n };
        const y0 = Math.floor(Math.min(a[0], b[0]) / CELL_LAT);
        const y1 = Math.floor(Math.max(a[0], b[0]) / CELL_LAT);
        const x0 = Math.floor(Math.min(a[1], b[1]) / CELL_LON);
        const x1 = Math.floor(Math.max(a[1], b[1]) / CELL_LON);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) add(y, x, seg);
      }
    }
    return grid;
  }

  /* ---- Matchning ---- */

  #nearbySegments(lat, lon) {
    const key = tileKey(lat, lon);
    const tile = this.tiles.get(key);
    if (!tile) return [];
    const cy = Math.floor(lat / CELL_LAT), cx = Math.floor(lon / CELL_LON);
    const out = [];
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        const arr = tile.grid.get(y + ':' + x);
        if (arr) out.push(...arr);
      }
    }
    return out;
  }

  /**
   * Vinkelrätt avstånd från punkt till segment, i meter. Räknar i ett lokalt
   * plan runt bilen — på de här avstånden är jordkrökningen försumbar och
   * matematiken blir både snabbare och enklare att lita på.
   */
  #pointToSegment(lat, lon, a, b) {
    const mPerLat = 111320;
    const mPerLon = 111320 * Math.cos(lat * Math.PI / 180);
    const px = 0, py = 0;
    const ax = (a[1] - lon) * mPerLon, ay = (a[0] - lat) * mPerLat;
    const bx = (b[1] - lon) * mPerLon, by = (b[0] - lat) * mPerLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(ax, ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + t * dx - px, ay + t * dy - py);
  }

  /** Vilken väg kör vi på? */
  match(fix) {
    const segs = this.#nearbySegments(fix.lat, fix.lon);
    if (!segs.length) return null;

    // GPS-noggrannheten sätter hur långt ifrån vägen vi får vara
    const maxDist = Math.min(45, Math.max(20, (fix.accuracy || 10) + 15));
    const heading = fix.headingSmoothed;

    let best = null;
    for (const seg of segs) {
      const d = this.#pointToSegment(fix.lat, fix.lon, seg.a, seg.b);
      if (d > maxDist) continue;

      let penalty = 0;
      if (heading != null) {
        const segBearing = bearing(seg.a[0], seg.a[1], seg.b[0], seg.b[1]);
        // Vägen kan köras åt båda hållen, så jämför mot närmaste av de två
        const diff = Math.min(angleDiff(heading, segBearing), angleDiff(heading, (segBearing + 180) % 360));
        if (diff > 50) continue;              // korsande gata, inte vår
        penalty = diff * 0.4;                 // rakare = bättre kandidat
      }
      const score = d + penalty;
      if (!best || score < best.score) best = { score, d, seg };
    }
    if (!best) return null;
    return { limit: best.seg.s, name: best.seg.n, distance: best.d };
  }

  /* ---- Huvudanrop, en gång per GPS-fix ---- */

  update(fix) {
    if (!this.enabled || !fix) return null;

    this.ensureTile(fix.lat, fix.lon);
    this.#prefetchAhead(fix);

    const hit = this.match(fix);

    // Kräv två fixar i rad innan gränsen byts, annars fladdrar den i korsningar
    if (hit && (!this.current || hit.limit !== this.current.limit || hit.name !== this.current.name)) {
      if (this._candidate && this._candidate.limit === hit.limit && this._candidate.name === hit.name) {
        this._candidateCount++;
      } else {
        this._candidate = hit;
        this._candidateCount = 1;
      }
      if (this._candidateCount >= 2 || !this.current) {
        this.current = hit;
        this._candidate = null;
        this._candidateCount = 0;
        this.#emit('limit', hit);
      }
    } else if (hit) {
      this.current = hit;
    } else if (!hit) {
      // Tappar vi vägen helt (parkering, ny bricka laddas) — behåll en stund
      if (this.current && Date.now() - (this._lostAt || 0) > 15000) {
        this._lostAt = Date.now();
      }
      if (this.current && this._lostAt && Date.now() - this._lostAt > 20000) {
        this.current = null;
        this.#emit('limit', null);
      }
    }
    if (hit) this._lostAt = 0;

    this.#checkSpeeding(fix);
    return this.current;
  }

  /** Hämta nästa bricka innan vi kör in i den. */
  #prefetchAhead(fix) {
    if (fix.headingSmoothed == null || (fix.speedKmh ?? 0) < 40) return;
    // Titta 3 km framåt längs färdriktningen
    const rad = fix.headingSmoothed * Math.PI / 180;
    const dLat = (3000 * Math.cos(rad)) / 111320;
    const dLon = (3000 * Math.sin(rad)) / (111320 * Math.cos(fix.lat * Math.PI / 180));
    const aheadKey = tileKey(fix.lat + dLat, fix.lon + dLon);
    if (aheadKey !== tileKey(fix.lat, fix.lon)) {
      this.ensureTile(fix.lat + dLat, fix.lon + dLon);
    }
  }

  /**
   * Fortkörningsvarning. Marginalen finns för att GPS-hastighet ligger några
   * km/h fel och för att bilens mätare visar högre än verklig fart. Kravet på
   * ihållande överträdelse finns för att en omkörning inte ska ge pip.
   */
  #checkSpeeding(fix) {
    const limit = this.current?.limit;
    const speed = fix.speedKmh;
    if (!limit || speed == null) { this.overSince = 0; return; }

    const now = Date.now();
    const over = speed > limit + this.marginKmh;

    if (!over) {
      this.overSince = 0;
      if (speed <= limit) this.wasUnder = true;    // återställ först under gränsen
      return;
    }

    if (!this.overSince) { this.overSince = now; return; }
    if (now - this.overSince < this.sustainMs) return;
    if (!this.wasUnder && now - this.lastWarnAt < this.cooldownMs) return;

    this.lastWarnAt = now;
    this.wasUnder = false;
    this.overSince = 0;
    this.#emit('speeding', {
      speed, limit, over: speed - limit,
      name: this.current.name,
      spoken: `Du kör ${speed}. Här är det ${limit}.`,
    });
  }

  /* ---- Status ---- */

  async storageInfo() {
    const tiles = await tileAll();
    const ways = tiles.reduce((s, t) => s + t.ways.length, 0);
    const bytes = tiles.reduce((s, t) => s + JSON.stringify(t.ways).length, 0);
    return { tiles: tiles.length, ways, bytes };
  }

  async clearCache() {
    for (const t of await tileAll()) await tileDel(t.key).catch(() => {});
    this.tiles.clear();
    this.current = null;
    this.#emit('limit', null);
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}
