// Bevakningsområde — var du vill bli varnad.
//
// Utan det här får en förare i Västerås varningar om polis i Fagersta, och
// slutar lyssna. Med för snäv radie missar man kontrollen två kilometer bort.
// Därför fyra lägen, från snävt till brett, plus ett ruttläge för när man ska
// någonstans.
//
// Ruttläget hämtar en riktig vägbeskrivning från OSRM och varnar för allt inom
// en korridor längs vägen — inte inom en cirkel. Kör man Västerås–Stockholm
// vill man veta om polisen står i Enköping, men inte om den står i Sala.

import { distance } from './util.js';

export const MODES = {
  radius:  { label: 'Radie runt mig',   hint: 'Följer med dig. Bra i vardagen.' },
  city:    { label: 'Västerås',          hint: 'Hela staden med förorter.' },
  county:  { label: 'Hela Västmanland',  hint: 'Allt i länet. Mest varningar.' },
  route:   { label: 'Längs min rutt',    hint: 'Varnar hela vägen dit du ska.' },
};

// Ungefärliga ytor. Cirklar räcker gott för att avgöra vad som är "i stan".
const AREAS = {
  city:   { lat: 59.6099, lon: 16.5448, radiusM: 15000 },
  county: { lat: 59.7500, lon: 16.2000, radiusM: 75000 },
};

export class Coverage extends EventTarget {
  constructor(cfg = {}) {
    super();
    this.mode = cfg.mode || 'radius';
    this.radiusM = cfg.radiusM ?? 30000;
    this.route = null;             // { points:[[lat,lon]…], name, distanceM, durationS }
    this.corridorM = cfg.corridorM ?? 3000;
    this._grid = null;             // rutnät över rutten, för snabb närhetskoll
  }

  configure(cfg) {
    if (cfg.mode) this.mode = cfg.mode;
    if (cfg.radiusM) this.radiusM = cfg.radiusM;
    if (cfg.corridorM) this.corridorM = cfg.corridorM;
    this.#emit('change');
  }

  /**
   * Ska den här faran nå föraren?
   * @param {{lat:number,lon:number}} hazard
   * @param {{lat:number,lon:number}|null} me
   */
  covers(hazard, me) {
    switch (this.mode) {
      case 'city':
      case 'county': {
        const a = AREAS[this.mode];
        return distance(a.lat, a.lon, hazard.lat, hazard.lon) <= a.radiusM;
      }
      case 'route':
        if (!this.route) return me ? distance(me.lat, me.lon, hazard.lat, hazard.lon) <= this.radiusM : true;
        return this.#nearRoute(hazard.lat, hazard.lon);
      case 'radius':
      default:
        if (!me) return true;
        return distance(me.lat, me.lon, hazard.lat, hazard.lon) <= this.radiusM;
    }
  }

  filter(hazards, me) {
    return hazards.filter(h => this.covers(h, me));
  }

  describe() {
    if (this.mode === 'route' && this.route) {
      return `Längs rutten till ${this.route.name} (${Math.round(this.route.distanceM / 1000)} km)`;
    }
    if (this.mode === 'radius') return `${Math.round(this.radiusM / 1000)} km runt dig`;
    return MODES[this.mode]?.label || 'Okänt område';
  }

  /* ---- Rutt ---- */

  /**
   * Hämta vägbeskrivning från OSRM. Gratis, ingen nyckel, och det är samma
   * ruttmotor som ligger bakom en stor del av kartvärlden.
   */
  async setRoute(fromLat, fromLon, destination) {
    const dest = await this.#geocodeDestination(destination);
    if (!dest) throw new Error(`Hittar inte "${destination}".`);

    const url = `https://router.project-osrm.org/route/v1/driving/` +
      `${fromLon},${fromLat};${dest.lon},${dest.lat}` +
      `?overview=full&geometries=geojson&alternatives=false&steps=false`;

    // Tidsgräns: en värd som tar emot men aldrig svarar skulle annars hänga
    // setRoute för alltid (samma rem som rutt.js/navigering.js har).
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const klocka = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
    let r;
    try { r = await fetch(url, { signal: ctrl?.signal }); }
    catch (e) { throw new Error(e?.name === 'AbortError' ? 'Ruttjänsten svarade inte i tid.' : 'Ruttjänsten svarar inte.'); }
    finally { if (klocka) clearTimeout(klocka); }
    if (!r.ok) throw new Error('Ruttjänsten svarar inte.');
    const j = await r.json();
    const route = j.routes?.[0];
    if (!route) throw new Error('Ingen väg hittades dit.');

    this.route = {
      name: dest.label,
      points: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      distanceM: route.distance,
      durationS: route.duration,
    };
    this.mode = 'route';
    this.#buildGrid();
    this.#emit('change');
    this.#emit('route', { detail: this.route });
    return this.route;
  }

  clearRoute() {
    this.route = null;
    this._grid = null;
    if (this.mode === 'route') this.mode = 'radius';
    this.#emit('change');
  }

  async #geocodeDestination(q) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'se');
    url.searchParams.set('accept-language', 'sv');
    try {
      const r = await fetch(url);
      const rows = await r.json();
      if (!rows.length) return null;
      return {
        lat: +rows[0].lat, lon: +rows[0].lon,
        label: (rows[0].name || rows[0].display_name?.split(',')[0] || q).trim(),
      };
    } catch { return null; }
  }

  /**
   * Rutten kan ha tiotusen punkter. Att mäta mot alla för varje fara och varje
   * GPS-tick blir tungt, så punkterna läggs i ett rutnät och vi tittar bara i
   * cellerna närmast faran.
   */
  #buildGrid() {
    const cell = 0.02;                        // ~2,2 km i latitud
    const grid = new Map();
    this.route.points.forEach(([lat, lon]) => {
      const k = `${Math.round(lat / cell)}:${Math.round(lon / cell)}`;
      let arr = grid.get(k);
      if (!arr) grid.set(k, arr = []);
      arr.push([lat, lon]);
    });
    this._grid = { cell, grid };
  }

  #nearRoute(lat, lon) {
    if (!this._grid) return false;
    const { cell, grid } = this._grid;
    const cy = Math.round(lat / cell), cx = Math.round(lon / cell);
    // Hur många celler korridoren spänner över — PER AXEL. Förr skannades alltid
    // ±1 cell, men en cell är ~2,2 km i latitud och bara ~1,1 km i longitud på
    // våra breddgrader, medan korridoren är 3 km. En fara 2–3 km rakt öster/väster
    // om vägen låg då 2–3 celler bort och skannades aldrig → tyst missad varning.
    const mLat = cell * 111320;
    const mLon = cell * 111320 * Math.max(0.1, Math.cos(lat * Math.PI / 180));
    const ny = Math.max(1, Math.ceil(this.corridorM / mLat));
    const nx = Math.max(1, Math.ceil(this.corridorM / mLon));
    for (let y = cy - ny; y <= cy + ny; y++) {
      for (let x = cx - nx; x <= cx + nx; x++) {
        const arr = grid.get(`${y}:${x}`);
        if (!arr) continue;
        for (const [plat, plon] of arr) {
          if (distance(lat, lon, plat, plon) <= this.corridorM) return true;
        }
      }
    }
    return false;
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}
