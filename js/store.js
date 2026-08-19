// Datalager för rapporter.
//
// Två lägen, samma API:
//   local     — allt sparas på telefonen. Fungerar direkt, men bara för dig.
//   supabase  — delat mellan alla användare. Ren REST över fetch, inga
//               bibliotek. Pollar med jämna mellanrum (default 30 s).
//
// Byt läge i Inställningar. Rapporter du skapat offline skickas upp när
// anslutningen kommer tillbaka.

import { uid, distance } from './util.js';
import { apiHeaders } from './config.js';

const LOCAL_KEY = 'pv.reports.v1';
const QUEUE_KEY = 'pv.queue.v1';
const DEVICE_KEY = 'pv.device.v1';

/** Hur länge en rapport anses aktuell, i minuter. */
export const TTL_MINUTES = {
  police: 45,
  control: 60,
  unmarked: 30,
  camera: 60 * 24 * 365,     // användartillagd kamera lever tills den tas bort
};

/*
 * Postgres svarar med snake_case, resten av appen talar camelCase.
 *
 * Det här var en tyst bugg med verkliga följder. `refresh()` spred serverraden
 * rakt in med `...row`, och mappade bara created_at och expires_at. Alltså kom
 * gps_accuracy_m, fart_kmh och fordrojning_s in med sina databasnamn, medan
 * kvalitet.js läser gpsAccuracyM, fartKmh och fordrojningS.
 *
 * Följden: VARJE rapport från en annan förare graderades på antaganden i
 * stället för på verklig data. Utan känd geokodningstyp antas radien 1 200 m,
 * vilket ligger precis på gränsen där en rapport tystnar. Ingenting såg
 * trasigt ut — rapporterna fanns, de var bara sämre än de behövde vara.
 *
 * Bara `geokod` heter likadant i båda världarna, vilket är varför problemet
 * inte syntes i det befintliga testet.
 *
 * Samma familj som regressionen jag lagade tidigare: data måste följa hela
 * vägen — skapa, spara, hämta, läsa. Den gången testade jag tre av fyra.
 */
const KVALITETSFALT = {
  gps_accuracy_m:    'gpsAccuracyM',
  fart_kmh:          'fartKmh',
  fordrojning_s:     'fordrojningS',
  geokod_typ:        'geokodTyp',
  geokod_radius_m:   'geokodRadiusM',
  parser_confidence: 'parserConfidence',
};

export function kvalitetFranRad(row) {
  const ut = {};
  for (const [kolumn, falt] of Object.entries(KVALITETSFALT)) {
    if (row[kolumn] != null) ut[falt] = row[kolumn];
  }
  return ut;
}

const IDENTITY_KEY = 'pv.identity.v1';
const MINE_KEY = 'pv.mine.v1';

/**
 * Vilka rapporter som är mina.
 *
 * Servern lämnar inte längre ut device_id — annars kunde vem som helst plocka
 * ett id ur det publika flödet och radera någon annans rapport. Telefonen
 * håller därför själv reda på vad den har skickat. Det räcker: frågan "är den
 * här min" behöver bara besvaras på den enhet som frågar.
 */
const mine = {
  read() { try { return new Set(JSON.parse(localStorage.getItem(MINE_KEY)) || []); } catch { return new Set(); } },
  add(id) {
    const s = this.read(); s.add(id);
    // Håll listan kort — gamla rapporter är ändå borta
    try { localStorage.setItem(MINE_KEY, JSON.stringify([...s].slice(-300))); } catch {}
  },
  has(id) { return this.read().has(id); },
};

export const isMine = id => mine.has(id);

/**
 * Vem är det som rapporterar? Är man inloggad används kontots id, annars ett
 * slumpat id som hör till telefonen. Det gör att rapporter, poäng och
 * prenumeration följer personen så fort ett konto finns, utan att något
 * behöver skrivas om på andra ställen.
 */
export function deviceId() {
  const identity = localStorage.getItem(IDENTITY_KEY);
  if (identity) return identity;
  let d = localStorage.getItem(DEVICE_KEY);
  if (!d) { d = uid(); localStorage.setItem(DEVICE_KEY, d); }
  return d;
}

export function setIdentity(id) {
  try {
    if (id) localStorage.setItem(IDENTITY_KEY, id);
    else localStorage.removeItem(IDENTITY_KEY);
  } catch {}
}

function readJSON(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
}
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

export class ReportStore extends EventTarget {
  /**
   * @param {{mode:'local'|'supabase', url?:string, key?:string, pollMs?:number}} cfg
   */
  constructor(cfg = { mode: 'local' }) {
    super();
    this.cfg = { pollMs: 30000, ...cfg };
    this.reports = new Map();       // id -> report
    this.timer = null;
    this.online = navigator.onLine;
    this.lastSync = null;
    this.syncError = null;

    for (const r of readJSON(LOCAL_KEY, [])) this.reports.set(r.id, r);

    addEventListener('online',  () => { this.online = true;  this.flushQueue(); this.refresh(); });
    addEventListener('offline', () => { this.online = false; this.#emit('status'); });
  }

  get isRemote() { return this.cfg.mode === 'supabase' && this.cfg.url && this.cfg.key; }

  configure(cfg) {
    this.cfg = { ...this.cfg, ...cfg };
    this.stop();
    this.start();
  }

  start() {
    this.refresh();
    this.stop();
    this.timer = setInterval(() => this.refresh(), this.cfg.pollMs);
    // Hämta direkt när appen kommer i förgrunden igen
    this._vis = () => { if (document.visibilityState === 'visible') this.refresh(); };
    document.addEventListener('visibilitychange', this._vis);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this._vis) document.removeEventListener('visibilitychange', this._vis);
  }

  /* ---- Läsning ------------------------------------------------------ */

  /** Aktiva (ej utgångna, ej nedröstade) rapporter. */
  active(now = Date.now()) {
    const out = [];
    for (const r of this.reports.values()) {
      if (r.removed) continue;
      if (r.expiresAt && r.expiresAt < now) continue;
      if ((r.denials || 0) >= 3 && (r.denials || 0) > (r.confirms || 0)) continue;
      out.push(r);
    }
    return out;
  }

  near(lat, lon, radiusM, now = Date.now()) {
    return this.active(now)
      .map(r => ({ ...r, distance: distance(lat, lon, r.lat, r.lon) }))
      .filter(r => r.distance <= radiusM)
      .sort((a, b) => a.distance - b.distance);
  }

  get(id) { return this.reports.get(id); }

  /* ---- Skrivning ---------------------------------------------------- */

  /**
   * @param {{type:string, lat:number, lon:number, label:string,
   *          note?:string, source?:string, ttlMinutes?:number}} input
   */
  async add(input) {
    const now = Date.now();
    const ttl = input.ttlMinutes ?? TTL_MINUTES[input.type] ?? 45;
    const report = {
      id: uid(),
      type: input.type,
      lat: +input.lat,
      lon: +input.lon,
      label: input.label || '',
      note: input.note || '',
      source: input.source || 'app',
      device_id: deviceId(),
      created_at: now,
      expires_at: now + ttl * 60000,
      confirms: 1,
      denials: 0,

      // Hur rapporten kom till. Används av kvalitet.js för att avgöra hur
      // mycket den går att lita på. null betyder "vet inte" och ska INTE
      // tolkas som noll — skillnaden mellan okänd GPS-noggrannhet och
      // perfekt GPS-noggrannhet är hela poängen.
      //
      // Fälten ligger bara lokalt tills kolumnerna finns i databasen; en
      // insert med okända kolumner avvisas av PostgREST, så de skickas inte
      // vidare i #send() förrän schemat har dem.
      gpsAccuracyM: input.gpsAccuracyM ?? null,
      fartKmh: input.fartKmh ?? null,
      fordrojningS: input.fordrojningS ?? null,

      // Hur positionen kom till: 'gps' = förarens egen position, 'karta' =
      // utpekad på kartan, annars namnet på det som geokodades. Saknas det
      // antas en okänd geokodning med drygt en kilometers radie, vilket är
      // rätt för ett ortsnamn ur ett textinlägg och helt fel för ett
      // knapptryck där telefonen stod på platsen.
      geokod: input.geokod ?? null,
      geokodTyp: input.geokodTyp ?? null,
      geokodRadiusM: input.geokodRadiusM ?? null,
      parserConfidence: input.parserConfidence ?? null,
    };
    // Interna alias så resten av koden slipper snake_case
    report.createdAt = report.created_at;
    report.expiresAt = report.expires_at;

    // Slå ihop med en näraliggande rapport av samma typ istället för dubblett
    const dupe = this.active(now).find(r =>
      r.type === report.type && distance(r.lat, r.lon, report.lat, report.lon) < 250);
    if (dupe) {
      await this.confirm(dupe.id);
      return { ...dupe, merged: true };
    }

    this.reports.set(report.id, report);
    mine.add(report.id);            // kom ihag att den har ar min
    this.#persist();
    this.#emit('change');

    if (this.isRemote) await this.#push('insert', report);
    return report;
  }

  async confirm(id) {
    const r = this.reports.get(id);
    if (!r) return;
    r.confirms = (r.confirms || 0) + 1;
    // Bekräftelse förlänger livslängden
    const ttl = TTL_MINUTES[r.type] ?? 45;
    r.expiresAt = r.expires_at = Math.max(r.expiresAt, Date.now() + ttl * 0.6 * 60000);
    this.#persist();
    this.#emit('change');
    if (this.isRemote) await this.#push('confirm', r);
  }

  async deny(id) {
    const r = this.reports.get(id);
    if (!r) return;
    r.denials = (r.denials || 0) + 1;
    if (r.denials >= 3 && r.denials > r.confirms) r.removed = true;
    this.#persist();
    this.#emit('change');
    if (this.isRemote) await this.#push('deny', r);
  }

  /** Ta bort en egen rapport helt. */
  async remove(id) {
    const r = this.reports.get(id);
    if (!r) return;
    if (!mine.has(id)) return this.deny(id);
    r.removed = true;
    r.expiresAt = r.expires_at = Date.now() - 1;
    this.#persist();
    this.#emit('change');
    if (this.isRemote) await this.#push('remove', r);
  }

  /* ---- Synk --------------------------------------------------------- */

  async refresh() {
    // Städa utgångna oavsett läge
    const before = this.reports.size;
    const cutoff = Date.now() - 3 * 3600_000;
    for (const [id, r] of this.reports) {
      if ((r.expiresAt || 0) < cutoff) this.reports.delete(id);
    }
    if (this.reports.size !== before) this.#persist();

    if (!this.isRemote) { this.#emit('change'); return; }
    if (!this.online) { this.#emit('status'); return; }

    try {
      const since = Date.now() - 6 * 3600_000;
      // Helst vyn reports_feed, som saknar device_id — se supabase/schema.sql
      // för varför det spelar roll. Finns den inte än (SQL:en inte körd) faller
      // vi tillbaka på tabellen istället för att sluta synka helt.
      //
      // Reservvägen finns för att en app som tyst slutar varna är farligare än
      // en app som läcker ett slumpat id. Så fort vyn finns används den, och
      // då upphör läckan av sig själv.
      const path = this._feedPath || 'reports_feed';
      const query = `?select=*&expires_at=gt.${since}&order=created_at.desc&limit=500`;
      let res = await fetch(`${this.cfg.url}/rest/v1/${path}${query}`, { headers: this.#headers() });

      if (res.status === 404 && path === 'reports_feed') {
        this._feedPath = 'reports';
        this._feedFallback = true;
        res = await fetch(`${this.cfg.url}/rest/v1/reports${query}`, { headers: this.#headers() });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();

      for (const row of rows) {
        const r = {
          ...row,
          createdAt: typeof row.created_at === 'number' ? row.created_at : Date.parse(row.created_at),
          expiresAt: typeof row.expires_at === 'number' ? row.expires_at : Date.parse(row.expires_at),
          ...kvalitetFranRad(row),
        };
        const mine = this.reports.get(r.id);
        // Lokala obekräftade ändringar vinner inte över servern, förutom removed
        if (mine?.removed) continue;
        this.reports.set(r.id, r);
      }
      this.lastSync = Date.now();
      this.syncError = null;
      this.#persist();
      this.#emit('change');
    } catch (e) {
      this.syncError = e.message;
      this.#emit('status');
    }
    this.flushQueue();
  }

  async #push(op, report) {
    const job = { op, report, at: Date.now() };
    if (!this.online) { this.#enqueue(job); return; }
    try {
      await this.#send(job);
    } catch {
      this.#enqueue(job);
    }
  }

  async #send({ op, report }) {
    const base = `${this.cfg.url}/rest/v1/reports`;
    if (op === 'insert') {
      const body = {
        id: report.id, type: report.type, lat: report.lat, lon: report.lon,
        label: report.label, note: report.note, source: report.source,
        device_id: report.device_id,
        created_at: report.created_at, expires_at: report.expires_at,
        confirms: report.confirms, denials: report.denials,

        // Hur rapporten kom till. Utan de här fälten kan mottagaren inte
        // avgöra hur mycket den går att lita på, och graderaren antar då
        // det värsta — vilket tystar varje rapport som kommer utifrån.
        gps_accuracy_m: report.gpsAccuracyM,
        fart_kmh: report.fartKmh,
        fordrojning_s: report.fordrojningS,
        geokod: report.geokod,
        geokod_typ: report.geokodTyp,
        geokod_radius_m: report.geokodRadiusM,
        parser_confidence: report.parserConfidence,
      };
      // Ta bort det som är okänt. PostgREST avvisar hela insertet om en
      // kolumn inte finns än, och rapporten är viktigare än metadatan.
      for (const k of Object.keys(body)) if (body[k] == null) delete body[k];
      const skicka = kropp => fetch(base, {
        method: 'POST',
        headers: { ...this.#headers(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(kropp),
      });

      let r = await skicka(body);

      /*
       * Saknas kvalitetskolumnerna i databasen avvisar PostgREST HELA
       * rapporten med 400 — inte bara de okända fälten. Rapporten är
       * viktigare än metadatan om den, så vi skickar om utan dem.
       *
       * Utan det här skulle en utrullning av klienten före SQL:en göra att
       * ingen kunde rapportera någonting alls. Fallbacken försvinner av sig
       * själv den dagen kolumnerna finns.
       */
      if (r.status === 400 && !this._utanKvalitetsfalt) {
        const bas = { ...body };
        for (const k of ['gps_accuracy_m', 'fart_kmh', 'fordrojning_s',
                         'geokod', 'geokod_typ', 'geokod_radius_m',
                         'parser_confidence']) delete bas[k];
        const r2 = await skicka(bas);
        if (r2.ok) {
          this._utanKvalitetsfalt = true;   // sluta försöka den här sessionen
          return;
        }
        r = r2;
      }
      if (!r.ok) throw new Error(`insert ${r.status}`);
      return;
    }
    // confirm / deny / remove -> RPC så räknarna blir atomära
    const fn = { confirm: 'confirm_report', deny: 'deny_report', remove: 'remove_report' }[op];
    const r = await fetch(`${this.cfg.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { ...this.#headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: report.id, p_device: deviceId() }),
    });
    if (!r.ok) throw new Error(`${op} ${r.status}`);
  }

  #enqueue(job) {
    const q = readJSON(QUEUE_KEY, []);
    q.push(job);
    writeJSON(QUEUE_KEY, q.slice(-100));
  }

  async flushQueue() {
    if (!this.isRemote || !this.online) return;
    const q = readJSON(QUEUE_KEY, []);
    if (!q.length) return;
    const rest = [];
    for (const job of q) {
      try { await this.#send(job); } catch { rest.push(job); }
    }
    writeJSON(QUEUE_KEY, rest);
  }

  #headers() {
    return apiHeaders();
  }

  #persist() {
    writeJSON(LOCAL_KEY, [...this.reports.values()].slice(-400));
  }

  #emit(name) { this.dispatchEvent(new CustomEvent(name)); }
}
