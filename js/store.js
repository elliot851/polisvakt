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
// Vilken grupp rapporten hör till. Bara en läsning av ett valt id — store
// filtrerar ingenting och vet inget om medlemskap, det sitter i
// radsäkerhetsreglerna i supabase/grupper.sql där det hör hemma.
import { aktivGruppId } from './groups.js';

const LOCAL_KEY = 'pv.reports.v1';
const QUEUE_KEY = 'pv.queue.v1';
const DEVICE_KEY = 'pv.device.v1';

/**
 * Hur länge en rapport anses AKTUELL, i minuter.
 *
 * Det här är trovärdighetsskalan: hur länge det är rimligt att patrullen
 * fortfarande står kvar. Den styr graderingen (js/kvalitet.js), aktualitets-
 * texten (js/sammanfattning.js) och åldersgrinden för notiser (js/app.js samt
 * supabase/migrationer/2026-08-22-aldersgrind-for-notiser.sql).
 *
 * Den styr INTE längre hur länge rapporten syns — se VISNING_MINUTER nedan.
 */
export const TTL_MINUTES = {
  police: 45,
  control: 60,
  unmarked: 30,
  camera: 60 * 24 * 365,     // användartillagd kamera lever tills den tas bort
};

/**
 * Hur länge en rapport SYNS, i minuter. Det är det här talet som skrivs in i
 * expires_at och som därmed avgör vad active() släpper fram.
 *
 * Ägaren ville ha fyra timmar. Att bara skriva 240 i TTL_MINUTES hade varit
 * fel svar på rätt önskemål, och skälen skrivs ut här eftersom nästa person
 * kommer att frestas att "förenkla" tillbaka det till ett enda tal:
 *
 *   1. Allt i js/kvalitet.js räknar ålder som ANDEL av livslängden. Med 240
 *      minuter hade en timmesgammal polisrapport legat på 25 % och alltså
 *      graderats som färsk — med plus i poängen, och utan att åldern ens
 *      nämndes högt (namnAlderOverAndel 0,40 = 96 minuter). Appen hade låtit
 *      MER säker ju äldre uppgiften blev. Det är raka motsatsen till vad en
 *      längre livslängd behöver.
 *   2. js/app.js räknar notisfönstret som halva livslängden, med taket
 *      Math.max över de rörliga typerna. Ett fyrtimmarstal där hade skickat
 *      notiser om sådant som hände för två timmar sedan — precis det ägaren
 *      själv sagt att appen aldrig får göra. Samma konstruktion finns på
 *      servern (fbmejl_ttl_tak_minuter), och migrationens PROV 1 hade
 *      dessutom vägrat köra om taket rörde sig från 60.
 *
 * Därför är talet delat i två. Rapporten ligger kvar i fyra timmar, bleknar
 * på kartan (js/map.js) och får en allt tydligare aktualitetstext ("Kan ha
 * flyttat på sig" → "Troligen inte kvar", js/sammanfattning.js) — men appen
 * slutar TRO på den efter TTL_MINUTES och slutar därmed säga den högt.
 * Föraren ser den; högtalaren tiger. Det är hela poängen med delningen.
 *
 * Skillnaden mellan typerna bor kvar i TTL_MINUTES där den hör hemma: en
 * civil bil är otrolig redan efter 30 minuter och en trafikkontroll först
 * efter 60, men båda går att titta på i fyra timmar.
 */
export const VISNING_MINUTER = {
  police: 240,
  control: 240,
  unmarked: 240,
  camera: TTL_MINUTES.camera,   // kameran står kvar där den står
};

/** Hur länge typen syns. Faller tillbaka på trovärdighetstiden om typen är okänd. */
export function visningMinuter(typ) {
  return VISNING_MINUTER[typ] ?? TTL_MINUTES[typ] ?? 45;
}

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

    /*
     * Pollningen går långsammare när ingen tittar.
     *
     * Rapporterna behövs för att kunna varna, och varningarna ska fungera med
     * skärmen släckt — så pollningen får INTE stanna helt. Men var trettionde
     * sekund i bakgrunden var mätt till 1,9 anrop i minuten dygnet runt, och
     * en app som ligger öppen i en ficka hela dagen betalar för det i batteri
     * utan att någon får något.
     *
     * Kompromissen: full takt när appen syns, en fjärdedel när den inte gör
     * det, och en omedelbar hämtning så fort den kommer fram igen. Föraren
     * märker aldrig fördröjningen, eftersom hen inte tittade.
     */
    const takt = () => (document.visibilityState === 'visible'
      ? this.cfg.pollMs
      : this.cfg.pollMs * 4);

    const starta = ms => {
      if (this.timer) clearInterval(this.timer);
      this._pollMs = ms;
      this.timer = setInterval(() => this.refresh(), ms);
    };
    starta(takt());

    this._vis = () => {
      const ny = takt();
      if (ny !== this._pollMs) starta(ny);
      // Hämta direkt när appen kommer i förgrunden igen
      if (document.visibilityState === 'visible') this.refresh();
    };
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
   *          note?:string, source?:string, ttlMinutes?:number,
   *          groupId?:string|null}} input
   *
   * groupId utelämnad betyder "dit föraren valt att rapportera", vilket i sin
   * tur är publikt tills hen valt en grupp. Skicka null uttryckligen för att
   * tvinga en rapport publik oavsett vad som är valt.
   */
  async add(input) {
    const now = Date.now();
    // Visningstiden, inte trovärdighetstiden. expires_at är enbart frågan
    // "ska den här synas?" — hur mycket appen tror på den avgörs av
    // TTL_MINUTES i js/kvalitet.js, långt innan den slutar synas.
    const ttl = input.ttlMinutes ?? visningMinuter(input.type);
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

      // Vilken grupp rapporten hör till. null = publik, precis som allt som
      // fanns innan grupper.
      //
      // Det här fältet skrevs aldrig av klienten, trots att hela serversidan
      // var byggd för det. Följden var inte att gruppfunktionen saknades utan
      // att den ljög: ett åkeri som trodde att förarnas rapporter stannade
      // internt fick varenda en utlagd publikt över hela länet. Läsregeln i
      // supabase/grupper.sql kan bara skydda en rapport som faktiskt bär ett
      // group_id.
      group_id: input.groupId !== undefined ? (input.groupId || null) : aktivGruppId(),
    };
    // Interna alias så resten av koden slipper snake_case
    report.createdAt = report.created_at;
    report.expiresAt = report.expires_at;
    report.groupId = report.group_id;

    // Slå ihop med en näraliggande rapport av samma typ istället för dubblett.
    //
    // Bara inom samma publik. En bekräftelse på någon annans publika rapport
    // är INTE en rapport till åkeriet, och tvärtom: hade en grupprapport fått
    // svälja en publik rapport skulle hela länet blivit utan varning för att
    // en förare råkade stå på samma gata.
    // TIDSFÖNSTRET ÄR INTE PYNT — det är det som gör fyra timmars visningstid
    // ofarlig.
    //
    // Sammanslagningen hade tidigare ingen tidsgräns alls; den enda gränsen
    // var att den gamla rapporten fortfarande var aktiv. Det gick bra så länge
    // "aktiv" betydde 45 minuter. Med fyra timmar hade en helt ny polis vid
    // Erikslund klockan 17:00 svalts som en "bekräftelse" på 13:10-rapporten:
    // föraren hade fått noll ny varning, bara confirms+1 — och confirms+1
    // hade dessutom förlängt den GAMLA rapporten. En ny iakttagelse hade
    // alltså gjort appen tystare i stället för mer vaken.
    //
    // Gränsen är trovärdighetstiden, samma tal som graderingen använder: inom
    // den kan det rimligen vara samma patrull, efter den är det två tillfällen
    // och ska visas som två. (kvalitet.js har en egen, kortare gräns på 12
    // minuter för sin klustring — den får gärna hålla isär mer, den slår bara
    // ihop i texten och går att ångra. Den här sammanslagningen kastar en rad.)
    const dubblettFonsterMs = (TTL_MINUTES[report.type] ?? 45) * 60000;
    const dupe = this.active(now).find(r => {
      if (r.type !== report.type) return false;
      if ((r.group_id ?? null) !== report.group_id) return false;
      // Okänd ålder räknas som noll, alltså som förut: hellre en sammanslagning
      // för mycket än två nålar på samma punkt när vi inte vet bättre.
      const skapad = Number(r.createdAt ?? r.created_at);
      const alder = Number.isFinite(skapad) ? now - skapad : 0;
      if (alder >= dubblettFonsterMs) return false;
      return distance(r.lat, r.lon, report.lat, report.lon) < 250;
    });
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
    // Bekräftelse förlänger livslängden.
    //
    // TROVÄRDIGHETSTIDEN, INTE VISNINGSTIDEN, och det är med flit. Servern
    // har en egen inbakad kopia av samma tal i confirm_report
    // (supabase/schema.sql) och gör exakt samma greatest(). Räknade klienten
    // på 240 minuter skulle den sätta ett expires_at som servern sedan skrev
    // över vid nästa refresh. En bekräftelse på en färsk rapport förlänger som
    // förut; en bekräftelse på en som redan har timmar kvar är en
    // nolloperation, vilket är rätt — den syns redan.
    //
    // ...OCH DÄRFÖR FÅR KNAPPEN INTE SÄGA ATT DEN FÖRLÄNGER.
    //
    // expires_at sätts vid skapandet ur VISNING_MINUTER (240 min) medan
    // förlängningen räknas på TTL_MINUTES × 0,6 (27 min för police). greatest()
    // vinner alltid för den befintliga tiden. MÄTT mot den riktiga
    // ReportStore: på en färsk polisrapport är expiresAt före och efter
    // confirm identiska, delta noll minuter, och förlängningen börjar ge
    // utslag först vid 214 minuters ålder — alltså under de sista 26 av 240.
    // För 89 procent av rapportens liv var toasten "Varningen ligger kvar
    // längre nu" osann, och osann på ett sätt föraren kan mäta.
    //
    // Texten är därför bytt till vad bekräftelsen FAKTISKT gör (js/app.js:632
    // och js/app.js:3175): den räknas som confirms+1 och lyfter graderingen.
    // Talet här är kvar orört — det gör rätt sak för den rapport som verkligen
    // närmar sig sitt slut.
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
        // reports_feed lämnar inte ut group_id (se supabase/kvalitetsfalt.sql:
        // kolumnen finns på tabellen men inte i vyn). Utan raden nedan skulle
        // en egen grupprapport tappa sin grupp så fort den hunnit ett varv
        // över servern, och därmed kunna slås ihop med en publik rapport.
        if (r.group_id == null && mine?.group_id) {
          r.group_id = mine.group_id;
          r.groupId = mine.group_id;
        }
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

        // Utan den här raden går varje grupprapport ut publikt. Servern kan
        // inte gissa åt oss: läsregeln släpper igenom allt som har
        // group_id is null, och det är precis vad en rad utan fältet blir.
        group_id: report.group_id,
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
    // Taket höjdes från 400 när visningstiden gick från 45 minuter till fyra
    // timmar. Ungefär fem gånger så många rapporter är aktiva samtidigt, och
    // ett tak som biter tyst hade tappat de äldsta — alltså precis dem den
    // längre livslängden finns för. 1200 rader är fortfarande små pengar i
    // localStorage.
    const alla = [...this.reports.values()];
    // Trimma på relevans, inte insättningsordning. Map.set() på en befintlig
    // rapport behåller dess ursprungsplats, så slice(-1200) kunde tappa en
    // gammal men fortfarande aktiv (om-uppdaterad) rapport före en nyare
    // utgången. Sortera på expiresAt så de med längst kvar — de aktiva —
    // överlever taket.
    if (alla.length > 1200) {
      alla.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
      alla.length = 1200;
    }
    writeJSON(LOCAL_KEY, alla);
  }

  #emit(name) { this.dispatchEvent(new CustomEvent(name)); }
}
