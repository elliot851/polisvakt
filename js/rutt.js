// Ruttvarningar — polis på vägen dit du faktiskt ska.
//
// Resten av appen varnar för det som är NÄRA. Den här modulen varnar för det
// som ligger FRAMFÖR DIG PÅ DIN VÄG, och det är inte samma sak. En civilbil
// tvåhundra meter bort på en parallellgata du aldrig kommer köra på är brus
// som får föraren att sluta lyssna. En kontroll fyra kilometer fram på samma
// väg är det mest användbara appen kan säga.
//
// Skillnaden ligger i två mätvärden som ersätter fågelvägen helt:
//
//   sidoavstånd   Hur långt från vägens mittlinje faran ligger. Avgör OM den
//                 alls hör till rutten.
//   framförhållning  Hur långt kvar det är TILL faran räknat längs rutten,
//                 inte tvärs över. En kontroll som fågelvägen ligger 500 m
//                 bort kan vara tre kilometer bort i körning, och en som
//                 ligger bakom dig är oändligt långt bort.
//
// Modulen rör aldrig DOM och pratar aldrig. Den räknar, håller ordning på vad
// föraren redan har hört, och skickar händelser. Rösten äger alerts.js, och
// gränssnittet kopplas ihop någon annanstans.
//
// ---------------------------------------------------------------------------
// Vad som ALDRIG varnas för härifrån
//
// Nykterhets- och drogkontroller rapporteras inte i appen över huvud taget —
// filtret sitter i parser.js och gäller rösten, knapparna och Facebook-flödet
// på en gång. Fartkameror rapporteras inte heller av användare; de kommer från
// den inlagda databasen.
//
// Den här modulen öppnar ingen ny väg in för något av det. Ruttvarningar
// släpps bara igenom för de tre typerna i ROUTE_ALERT_TYPES, och det är en
// tillåtelselista med flit: dyker en ny typ upp i databasen i framtiden blir
// den tyst här tills någon aktivt lägger till den.
//
// Fartkameror är dessutom uttryckligen undantagna även när de är riktiga och
// inlagda, se ROUTE_ALERT_TYPES.

import {
  distance, bearing, clamp, spokenDistance, spokenAge, shortDistance,
} from './util.js';
import { TYPE_SPOKEN, isSobrietyCheck } from './parser.js';
import { searchPlaces, localSuggestions } from './geocode.js';

/**
 * Vilka rapporttyper som får ge en ruttvarning.
 *
 * Fartkameror saknas med flit. alerts.js har redan en kameralogik som är
 * bättre än allt en korridortest kan åstadkomma: den skalar avståndet med
 * hastigheten och kollar att du faktiskt kör mot kamerans mätriktning. Att
 * lägga en andra kamerakälla ovanpå den skulle bara ge dubbla varningar för
 * något som står stilla och redan hanteras rätt.
 */
const ROUTE_ALERT_TYPES = new Set(['police', 'control', 'unmarked']);

const OSRM_HOSTS = [
  'https://router.project-osrm.org/route/v1/driving',
  // FOSSGIS kör en andra publik OSRM. Samma API, annan maskin — värd att ha
  // när demoservern är nere, för en rutt som inte går att räkna om är samma
  // sak som ingen rutt alls.
  'https://routing.openstreetmap.de/routed-car/route/v1/driving',
];

const DEFAULTS = {
  /* ---- Korridoren: vad som räknas som "på min väg" ---------------------
   *
   * Rutten från OSRM är vägens mittlinje. Avståndet från den till en rapport
   * består av tre fel som staplas på varandra:
   *
   *   Vägbredd        Rapporten görs från vägrenen eller från andra
   *                   körbanan. En svensk motorväg med mittremsa är 30–40 m
   *                   mellan körbanornas mitt, en trafikplats sprider ut sig
   *                   över 100–150 m.
   *   GPS-fel         5–15 m på öppen väg, 20–50 m mellan hus i en stadskärna
   *                   där signalen studsar. Felet finns i BÅDA ändar: i
   *                   positionen där rapporten skapades och i förarens egen.
   *   Geokodningsfel  En rapport som kom via rösten eller Facebook har ingen
   *                   GPS alls. Nominatim svarar med en punkt någonstans på
   *                   gatan, och gatan kan vara en kilometer lång.
   *
   * Uppåt begränsas korridoren av det den ska sortera bort: kvartersgator i
   * en svensk stadsplan ligger 60–120 m isär, och parallellvägen bredvid en
   * större led ligger typiskt 80–150 m bort.
   *
   * Det finns alltså ingen bredd som är rätt i båda ändarna. Valet blev en
   * bas på 120 m — bred nog att fånga båda körbanorna på en motorväg och en
   * rapport från vägrenen, smal nog att i regel inte svälja grannkvarteret —
   * plus ett påslag för den osäkerhet vi faktiskt känner till för just den
   * rapporten, med ett tak på 250 m.
   *
   * Taket är den viktigaste siffran av de tre. Utan det skulle en dåligt
   * geokodad rapport kunna göra hela innerstaden till "min väg".
   */
  corridorM: 120,
  corridorMaxM: 250,
  geocodedSlackM: 100,       // påslag för rapporter utan egen GPS-position

  /* ---- Framförhållning: när något ska sägas ---------------------------
   *
   * Fast avstånd fungerar inte. Fyra kilometer är två minuter på E18 och åtta
   * minuter i Västerås centrum. Därför räknas horisonten i TID, med tak och
   * golv i meter så den inte spårar ur i vare sig kö eller fri motorväg.
   *
   * Två minuter är valt för att det räcker för att byta fil, tänka om vid en
   * avfart och lägga sig rätt i hastighet — men inte är så tidigt att man
   * hinner glömma bort det. Taket på fem kilometer hänger ihop med hur länge
   * en rapport lever: en polisrapport gäller i 45 minuter, och något som
   * ligger längre bort än fem kilometer hinner ofta bli inaktuellt innan man
   * är framme.
   */
  headsUpSeconds: 120,
  headsUpMinM: 1200,
  headsUpMaxM: 5000,

  // Andra påminnelsen, strax innan. Trettio sekunder är "nu händer det".
  imminentSeconds: 30,
  imminentMinM: 350,
  imminentMaxM: 1000,

  /* ---- Överlämning till alerts.js -------------------------------------
   *
   * alerts.js varnar för allt inom hazardRadiusM (1500 m fågelvägen) oavsett
   * riktning. Skulle den här modulen varna i samma intervall hör föraren
   * samma polis två gånger från två system, och det är värre än att inte
   * varna alls — man slutar tro på appen.
   *
   * Gränsdragningen är därför att avståndet delas i två band med ett tydligt
   * ägande, och att ägandet bestäms EN gång per rapport:
   *
   *   Långt fält   Bortom handoffM. Den här modulen äger det, eftersom den
   *                är den enda som vet att faran ligger på vägen och inte
   *                bara i närheten. Hinner vi ta en rapport här "claimar" vi
   *                den, och då tar vi också den nära påminnelsen själva —
   *                med avstånd räknat längs vägen, vilket är rätt siffra.
   *   Nära fält    Innanför handoffM. alerts.js äger det. Ser vi en rapport
   *                först när den redan är där inne rör vi den inte alls.
   *
   * filterHazards() är verktyget som gör ägandet verkligt: den plockar bort
   * det vi claimat ur listan som skickas vidare till alerts.js.
   *
   * Sätt handoffM till samma värde som appens hazardRadiusM. Ändrar föraren
   * radien i inställningarna måste den här följa med, annars uppstår antingen
   * en glipa där ingen varnar eller en överlappning där båda gör det.
   */
  handoffM: 1500,
  handoffMarginM: 400,       // minsta fönster vi behöver för att hinna claima

  /* ---- Talbudget -------------------------------------------------------
   *
   * En tre mil lång rutt kan korsa ett dussin rapporter. Att läsa upp alla
   * vid start är obrukbart, och att upprepa var och en varje pollningscykel
   * är aktivt farligt i en bil. Reglerna:
   *
   *   1. Högst en ruttvarning per 45 sekunder. Blir flera aktuella samtidigt
   *      går den närmaste först, resten står kvar i tur och tas nästa varv.
   *   2. Varje rapport får högst en förvarning och en nära-påminnelse. Aldrig
   *      mer, oavsett hur många GPS-fixar eller pollningar som passerar.
   *   3. Vid ruttstart sägs EN sammanfattning i stället för en varning per
   *      rapport. De som redan ligger inom horisonten räknas som förvarnade.
   *   4. Ingenting sägs när bilen står stilla.
   */
  minGapMs: 45000,
  minSpeedKmh: 15,

  /* ---- Avvikelse -------------------------------------------------------
   *
   * Att varna för en väg föraren har lämnat är det värsta felet modulen kan
   * göra, så tröskeln för att sluta lita på rutten är låg — men den kräver
   * uthållighet, för en enda tokig GPS-fix i en tunnel eller mellan höghus
   * ska inte räkna som en avfart.
   *
   * Villkoret är därför tre saker samtidigt: tillräckligt långt från linjen,
   * tillräckligt många fixar i rad, och tillräckligt lång faktisk förflyttning
   * sedan det började. Sidoavståndet mäts mot det större av 60 m och 1,5 gånger
   * GPS:ens egen felmarginal, så en dålig fix höjer ribban i stället för att
   * utlösa en omräkning.
   */
  offRouteM: 60,
  offRouteFixes: 4,
  offRouteMinTravelM: 120,
  recalcCooldownMs: 20000,
  maxAutoRecalcs: 12,        // spärr mot att mala OSRM i en rondell

  arrivedM: 150,
  fallbackSpeedKmh: 70,      // används när GPS inte har någon fart ännu
};

/* ---------------- Geometri ---------------- */
//
// All projektion görs i ett lokalt platt meterplan. Över de avstånd det
// handlar om (segment på tiotals till hundratals meter) är felet från att
// ignorera jordens krökning långt under en meter, och beräkningen blir ren
// aritmetik utan trigonometri. Det spelar roll: det här körs för varje rapport
// vid varje GPS-tick, i en telefon som samtidigt ritar karta och spelar musik.

const M_PER_DEG_LAT = 111320;
const mPerDegLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

/**
 * Projicera en punkt på ett segment.
 * @returns {{t:number, lateral:number, side:number}} t = 0..1 längs segmentet,
 *   side = +1 om punkten ligger till vänster om färdriktningen, -1 till höger.
 */
function projectOnSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const mLon = mPerDegLon(aLat);
  const bx = (bLon - aLon) * mLon, by = (bLat - aLat) * M_PER_DEG_LAT;
  const px = (pLon - aLon) * mLon, py = (pLat - aLat) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - t * bx, dy = py - t * by;
  // Korsprodukten i ett (öst, norr)-plan: positiv betyder vänster om kursen.
  const cross = bx * dy - by * dx;
  return { t, lateral: Math.sqrt(dx * dx + dy * dy), side: cross >= 0 ? 1 : -1 };
}

/* ---------------- Rutten ---------------- */

/**
 * En färdig rutt med förberäknade index.
 *
 * Allt som är dyrt görs en gång här, vid ruttberäkningen, och aldrig igen:
 * kumulativa avstånd längs linjen och ett rutnät över segmenten. Efter det är
 * varje uppslagning under körning en handfull kvadratrötter.
 */
class Route {
  constructor(points, meta) {
    this.id = meta.id;
    this.points = points;                 // [[lat, lon], …]
    this.name = meta.name;
    this.destination = meta.destination;  // { lat, lon, label, detail }
    this.distanceM = meta.distanceM;
    this.durationS = meta.durationS;
    this.createdAt = Date.now();

    // cum[i] = meter längs rutten fram till punkt i
    const n = points.length;
    this.cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      this.cum[i] = this.cum[i - 1] +
        distance(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    }
    this.lengthM = n ? this.cum[n - 1] : 0;

    this.#buildGrid();
  }

  /**
   * Rutnät över segmenten.
   *
   * Cellerna är drygt en kilometer i sida. En sökning tittar i cellen och dess
   * åtta grannar, alltså minst 1,1 km åt varje håll — med god marginal mer än
   * den bredaste korridor vi tillåter. Varje segment skrivs in i alla celler
   * dess omslutande rektangel rör vid, så inget segment kan missas för att det
   * råkar sträcka sig över en cellgräns.
   */
  #buildGrid() {
    const CELL_LAT = 0.01;   // ~1,11 km
    const CELL_LON = 0.02;   // ~1,15 km vid 59°N
    const grid = new Map();
    const pts = this.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const [aLat, aLon] = pts[i], [bLat, bLon] = pts[i + 1];
      const y0 = Math.floor(Math.min(aLat, bLat) / CELL_LAT);
      const y1 = Math.floor(Math.max(aLat, bLat) / CELL_LAT);
      const x0 = Math.floor(Math.min(aLon, bLon) / CELL_LON);
      const x1 = Math.floor(Math.max(aLon, bLon) / CELL_LON);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const k = y + ':' + x;
          let arr = grid.get(k);
          if (!arr) grid.set(k, arr = []);
          arr.push(i);
        }
      }
    }
    this._grid = grid;
    this._cell = { lat: CELL_LAT, lon: CELL_LON };
  }

  /** Segmentindex värda att testa för en punkt, ur rutnätet. */
  candidates(lat, lon, ring = 1) {
    const { lat: cl, lon: cn } = this._cell;
    const cy = Math.floor(lat / cl), cx = Math.floor(lon / cn);
    const out = [];
    for (let y = cy - ring; y <= cy + ring; y++) {
      for (let x = cx - ring; x <= cx + ring; x++) {
        const arr = this._grid.get(y + ':' + x);
        if (arr) out.push(...arr);
      }
    }
    return out;
  }

  /** Meterlängden på segment i. */
  segLen(i) { return this.cum[i + 1] - this.cum[i]; }

  /** Projektion på ett givet segment, uttryckt i meter längs rutten. */
  hitOn(i, lat, lon) {
    const [aLat, aLon] = this.points[i], [bLat, bLon] = this.points[i + 1];
    const p = projectOnSegment(lat, lon, aLat, aLon, bLat, bLon);
    return {
      seg: i,
      s: this.cum[i] + p.t * this.segLen(i),
      lateral: p.lateral,
      side: p.side,
      heading: bearing(aLat, aLon, bLat, bLon),
    };
  }

  /** Bästa träffen bland ett antal segment. */
  bestOf(indices, lat, lon) {
    let best = null;
    for (const i of indices) {
      const h = this.hitOn(i, lat, lon);
      if (!best || h.lateral < best.lateral) best = h;
    }
    return best;
  }

  /** Bästa träffen någonstans på hela rutten. Rutnätsstödd. */
  nearest(lat, lon) {
    for (let ring = 1; ring <= 3; ring++) {
      const idx = this.candidates(lat, lon, ring);
      if (idx.length) {
        const best = this.bestOf(idx, lat, lon);
        // Ligger träffen längre bort än ringen når kan det finnas en bättre
        // strax utanför. Vidga då hellre än att svara fel.
        if (best && best.lateral < ring * 1000) return best;
      }
    }
    return null;
  }

  /** Bästa träffen inom ett intervall av rutten, i meter. Billigast av alla. */
  nearestBetween(lat, lon, sFrom, sTo) {
    const from = this.#indexAt(sFrom);
    const to = this.#indexAt(sTo);
    let best = null;
    for (let i = from; i <= to && i < this.points.length - 1; i++) {
      const h = this.hitOn(i, lat, lon);
      if (!best || h.lateral < best.lateral) best = h;
    }
    return best;
  }

  /** Segmentindex vid ett givet meteravstånd. Binärsökning i cum. */
  #indexAt(s) {
    const n = this.points.length - 1;
    if (s <= 0) return 0;
    if (s >= this.lengthM) return Math.max(0, n - 1);
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid + 1] < s) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Punkten på rutten vid meteravståndet s — för kartmarkörer. */
  pointAt(s) {
    const i = this.#indexAt(s);
    const len = this.segLen(i) || 1;
    const t = clamp((s - this.cum[i]) / len, 0, 1);
    const [aLat, aLon] = this.points[i], [bLat, bLon] = this.points[i + 1];
    return [aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t];
  }
}

/* ---------------- Ruttvakten ---------------- */

/**
 * @fires route          ny eller omräknad rutt finns
 * @fires route-cleared  rutten är borta
 * @fires recalculating  avvikelse upptäckt, ny rutt hämtas
 * @fires deviation      föraren har lämnat rutten
 * @fires progress       ny position längs rutten (varje GPS-tick)
 * @fires route-summary  en mening att säga vid start: hur många faror finns
 * @fires route-alert    en enskild varning ska läsas upp
 * @fires arrived        framme
 * @fires error          något gick inte att hämta
 */
export class RouteGuide extends EventTarget {
  /**
   * @param {import('./store.js').ReportStore} store
   * @param {object} opts  se DEFAULTS
   */
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.opts = { ...DEFAULTS, ...opts };
    this.enabled = true;

    /*
     * VAD RUTTVAKTEN FÅR SÄGA NÅGOT OM — samma källa som de andra två.
     *
     * Ruttvakten var länge den enda talande kanalen som läste store.active()
     * rått. Motorn får forRost (app.js), inkommande-uppläsningen får
     * inkommandeFlode(), och båda har då passerat produktreglerna i
     * notiser.js, kvalitetsgraderingen, täckningsfiltret och förarens egna
     * notisval. Ruttvakten hade inte passerat någonting alls, och skickade
     * rapportens råa label rakt till speaker.say.
     *
     * MÄTT: en rapport med label "Nykterhetskontroll Skultuna" undanhålls av
     * kvalitet.js och finns varken i forRost eller i inkommande-listan — men
     * låg kvar i store.active(), projicerades på rutten och lästes upp. Det
     * är den enda regel i projektet som aldrig får brytas. Samma hål gällde
     * allt annat de andra kanalerna respekterar: police på "av", en rapport
     * med koordinat utanför Sverige, en handmarkerad kamera.
     *
     * notiser.js säger i sin modulkommentar att spärren sitter tre gånger
     * "eftersom en skruv som går att skruva fel förr eller senare är fel
     * skruvad". Det här var den fjärde skruven, och ingen hade dragit åt den.
     *
     * Förvalet är store.active() så att modulen fungerar ensam i prov och
     * provdokument. Appen injicerar sin graderade lista i app.js.
     */
    this.haemtaFaror = typeof opts.haemtaFaror === 'function'
      ? opts.haemtaFaror
      : (now => this.store.active(now));

    this.route = null;
    this.destination = null;      // sparas separat, behövs vid omräkning
    this.progress = null;         // { s, seg, lateral, at, remainingM, etaS }
    this.offRoute = false;
    this.arrived = false;
    this.busy = false;

    this._alertState = new Map(); // reportId -> { claimed, headsUpAt, imminentAt }
    this._projections = new Map();// reportId -> { passes:[…] } | null
    this._projRouteId = null;
    this._off = { count: 0, from: null };
    this._lastSpokeAt = 0;
    this._recalcs = 0;
    this._lastRecalcAt = 0;
    this._lastFix = null;         // senast kända position, se noteFix()
  }

  /** Kör vi ruttvarningar just nu? */
  get active() {
    return !!(this.route && this.enabled && !this.arrived);
  }

  setOptions(o) {
    this.opts = { ...this.opts, ...o };
  }

  /* ================= Resmål ================= */

  /**
   * Förslag medan föraren skriver. Rör aldrig nätet — se villkorsavsnittet i
   * geocode.js. Ett sökfält får anropa den här hur ofta som helst.
   */
  suggest(text, near = null) {
    const at = near || this.#here();
    return localSuggestions(text, at ? { lat: at.lat, lon: at.lon } : {});
  }

  /**
   * Sök resmål. Anropas när föraren trycker på sök, inte medan hen skriver.
   * @returns {Promise<Array>} kandidater, den mest sannolika först
   */
  async searchDestinations(text, near = null) {
    const at = near || this.#here();
    const hits = await searchPlaces(text, at ? { lat: at.lat, lon: at.lon } : {});
    if (!hits.length) {
      // Ett tomt svar kan vara spärren i geocode.js som slog till, inte att
      // platsen saknas. Tvinga fram ett riktigt anrop innan vi ger upp.
      return await searchPlaces(text, { ...(at || {}), force: true });
    }
    return hits;
  }

  /**
   * Sätt resmål och räkna ut rutten.
   * @param {{lat:number,lon:number,label?:string,detail?:string}|string} dest
   *   Ett träffobjekt från searchDestinations, eller en fri textsträng som slås
   *   upp här.
   * @param {{lat:number,lon:number}} [from]  startpunkt, annars nuvarande GPS
   */
  async setDestination(dest, from = null) {
    const start = from || this.#here();
    if (!start) throw new Error('Ingen GPS-position ännu. Vänta tills kartan hittat dig.');

    let target = dest;
    if (typeof dest === 'string') {
      const hits = await this.searchDestinations(dest, start);
      if (!hits.length) throw new Error(`Hittar inte "${dest}".`);
      target = hits[0];
    }
    if (!Number.isFinite(target?.lat) || !Number.isFinite(target?.lon)) {
      throw new Error('Resmålet saknar koordinater.');
    }

    this.destination = {
      lat: target.lat, lon: target.lon,
      label: target.label || 'resmålet',
      detail: target.detail || '',
    };

    // Nytt resmål = allt föraren hört tidigare är irrelevant.
    this._alertState.clear();
    this._recalcs = 0;
    this.arrived = false;

    await this.#build(start, { reason: 'new' });
    return this.route;
  }

  /** Räkna om från nuvarande position till samma resmål. */
  async recalculate(from = null) {
    if (!this.destination) return null;
    const start = from || this.#here();
    if (!start) return null;
    await this.#build(start, { reason: 'recalc' });
    return this.route;
  }

  clearRoute() {
    this.route = null;
    this.destination = null;
    this.progress = null;
    this.offRoute = false;
    this.arrived = false;
    this._alertState.clear();
    this._projections.clear();
    this._projRouteId = null;
    this._off = { count: 0, from: null };
    this.#emit('route-cleared');
  }

  /* ================= Ruttberäkning ================= */

  async #build(start, { reason }) {
    this.busy = true;
    if (reason === 'recalc') this.#emit('recalculating', { from: start });
    try {
      const raw = await this.#fetchRoute(start, this.destination);
      const points = raw.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      if (points.length < 2) throw new Error('Ruttjänsten gav ingen väg.');

      this.route = new Route(points, {
        id: `${Date.now()}-${Math.round(raw.distance)}`,
        name: this.destination.label,
        destination: this.destination,
        distanceM: raw.distance,
        durationS: raw.duration,
      });

      // Råsvaret sparas för navigeringen. Den behöver stegen, och de ska
      // komma från exakt det här svaret — inte från ett eget anrop som kan
      // ge en annan väg. Se kommentaren vid #fetchRoute.
      this.rawRoute = raw;

      // Projektionerna hör till en viss rutt och måste räknas om.
      this._projections.clear();
      this._projRouteId = this.route.id;

      // Vid omräkning behålls _alertState med flit. Det är samma poliser som
      // står där, och föraren har redan hört om dem. Att tömma listan här vore
      // att läsa upp hela rutten en gång till varje gång man missar en avfart.
      this.offRoute = false;
      this._off = { count: 0, from: null };
      this.progress = {
        s: 0, seg: 0, lateral: 0, at: Date.now(),
        remainingM: this.route.lengthM,
        etaS: this.route.durationS,
      };

      this.#emit('route', { route: this.publicRoute(), reason });
      if (reason === 'new') this.#brief();
      return this.route;
    } catch (e) {
      // Misslyckas ett NYTT resmål får den gamla rutten inte ligga kvar. Då
      // skulle appen visa vägen till Enköping medan den påstår att den är på
      // väg till Stockholm — och varna längs fel väg. Vid omräkning behålls
      // rutten däremot: den är gammal men sann, och offRoute håller oss tysta
      // tills nästa försök går igenom.
      if (reason === 'new') {
        this.route = null;
        this.progress = null;
        this._projections.clear();
      }
      this.#emit('error', { message: e.message || 'Kunde inte hämta rutten.', reason });
      throw e;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Hämta rutten från OSRM.
   *
   * overview=full är själva poängen: standardsvaret ger en förenklad linje som
   * duger att rita men inte att mäta emot. En förenklad linje skär hörn, och i
   * en avfartsslinga hamnar den hundratals meter fel — vilket är precis den
   * storleksordning hela korridorlogiken arbetar i.
   *
   * steps=true numera, annotations fortfarande av.
   *
   * Svängbeskrivningarna används inte här — RouteGuide bryr sig bara om
   * geometrin. De hämtas för navigeringens skull, och skälet att göra det i
   * SAMMA anrop är viktigt: hämtade de två modulerna varsin rutt kunde OSRM
   * svara med två olika vägar. Då varnar appen för polis längs väg A medan
   * rösten säger svängar för väg B, och båda har rätt var för sig. Ett anrop,
   * en rutt, en sanning.
   *
   * Två värdar, tre försök. En rutt som inte går att räkna om är samma sak som
   * ingen rutt, så det är värt att vara envis här.
   */
  async #fetchRoute(start, dest) {
    const coords = `${start.lon},${start.lat};${dest.lon},${dest.lat}`;
    const qs = '?overview=full&geometries=geojson&alternatives=false&steps=true&annotations=false';
    let lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const host = OSRM_HOSTS[attempt % OSRM_HOSTS.length];
      try {
        const r = await fetch(`${host}/${coords}${qs}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`Ruttjänsten svarade ${r.status}.`);
        const j = await r.json();
        if (j.code && j.code !== 'Ok') throw new Error(this.#osrmMessage(j.code));
        const route = j.routes?.[0];
        if (!route?.geometry?.coordinates?.length) throw new Error('Ingen väg hittades dit.');
        return route;
      } catch (e) {
        lastErr = e;
        // Kort paus innan nästa värd. Är det nätet som är borta hjälper det,
        // är det servern som är nere byter vi maskin i nästa varv.
        if (attempt < 2) await new Promise(res => setTimeout(res, 600 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('Ruttjänsten svarar inte.');
  }

  #osrmMessage(code) {
    return {
      NoRoute: 'Det går inte att köra dit härifrån.',
      NoSegment: 'Hittar ingen väg nära start eller mål.',
      TooBig: 'Rutten är för lång för ruttjänsten.',
    }[code] || 'Ruttjänsten kunde inte räkna ut vägen.';
  }

  /* ================= Position längs rutten ================= */

  /**
   * Anropas för varje GPS-fix. Det här är den varma kodvägen — allt här inne
   * är skrivet för att köras en gång i sekunden i en telefon på en vagga.
   *
   * @param {{lat,lon,accuracy,speedKmh,headingSmoothed,moving,ts}} fix
   * @returns {{progress:object, alerts:Array}|null}
   */
  update(fix) {
    if (!fix) return null;
    this.noteFix(fix);
    if (!this.route) return null;

    this.#advance(fix);

    if (this.arrived) return { progress: this.progress, alerts: [] };

    // Är vi av rutten säger vi ingenting alls. Att varna för en väg föraren
    // har lämnat är precis det fel modulen finns för att undvika, och det är
    // bättre att vara tyst i tjugo sekunder medan omräkningen går.
    if (this.offRoute) {
      this.#maybeRecalculate(fix);
      return { progress: this.progress, alerts: [] };
    }

    const matches = this.matches();
    this.#emit('progress', {
      ...this.progress,
      ahead: matches.length,
      nextM: matches.length ? matches[0].aheadM : null,
    });

    return { progress: this.progress, alerts: this.#announce(fix, matches) };
  }

  /**
   * Flytta fram positionen längs rutten.
   *
   * Nyckeln till att det här är billigt: vi vet ungefär var vi var förra
   * sekunden och hur fort vi kör, alltså behöver bara ett kort fönster av
   * rutten testas — några tiotal segment i stället för tiotusen. Fönstret är
   * generöst framåt (tre gånger den sträcka farten medger, plus 200 m) så att
   * en tappad minut i en tunnel inte tappar bort oss, och kort bakåt eftersom
   * man sällan backar.
   *
   * Bara när fönstret inte ger en rimlig träff faller vi tillbaka på en
   * rutnätssökning över hela rutten. Det händer vid start, efter en paus i
   * appen, och när föraren faktiskt har kört fel.
   */
  #advance(fix) {
    const r = this.route;
    const prev = this.progress;
    const limit = Math.max(this.opts.offRouteM, (fix.accuracy || 0) * 1.5);
    let hit = null;

    if (prev) {
      const dt = clamp(((fix.ts || Date.now()) - prev.at) / 1000, 1, 120);
      const mps = Math.max(fix.speedKmh ?? this.opts.fallbackSpeedKmh, 30) / 3.6;
      const forward = Math.min(6000, mps * dt * 3 + 200);
      hit = r.nearestBetween(fix.lat, fix.lon, prev.s - 150, prev.s + forward);
    }
    if (!hit || hit.lateral > limit) {
      const global = r.nearest(fix.lat, fix.lon);
      if (global && (!hit || global.lateral < hit.lateral)) hit = global;
    }

    const onRoute = hit && hit.lateral <= limit;

    if (onRoute) {
      this._off = { count: 0, from: null };
      // Positionen får aldrig backa av brus. Kör man faktiskt bakåt fångas det
      // av avvikelselogiken i stället, vilket är rätt: det är en avvikelse.
      const s = prev && hit.s < prev.s - 100 ? prev.s : hit.s;
      this.progress = {
        s,
        seg: hit.seg,
        lateral: hit.lateral,
        heading: hit.heading,
        at: fix.ts || Date.now(),
        remainingM: Math.max(0, r.lengthM - s),
        etaS: r.durationS ? Math.round(r.durationS * (1 - s / (r.lengthM || 1))) : null,
      };
      if (this.offRoute) {
        // Tillbaka på vägen av sig själv, till exempel efter en omkörning i en
        // trafikplats. Ingen omräkning behövs.
        this.offRoute = false;
        this.#emit('route', { route: this.publicRoute(), reason: 'rejoined' });
      }
      if (this.progress.remainingM <= this.opts.arrivedM && !this.arrived) {
        this.arrived = true;
        this.#emit('arrived', { destination: this.destination });
      }
      return;
    }

    // Utanför korridoren. Räkna, men slå inte larm förrän det är övertygande.
    this._off.count++;
    if (!this._off.from) this._off.from = { lat: fix.lat, lon: fix.lon, at: fix.ts || Date.now() };
    const travelled = distance(this._off.from.lat, this._off.from.lon, fix.lat, fix.lon);

    if (!this.offRoute &&
        this._off.count >= this.opts.offRouteFixes &&
        travelled >= this.opts.offRouteMinTravelM &&
        (fix.moving !== false)) {
      this.offRoute = true;
      this.#emit('deviation', {
        lateral: hit ? Math.round(hit.lateral) : null,
        at: { lat: fix.lat, lon: fix.lon },
      });
    }
  }

  /** Avvikelse upptäckt — hämta en ny rutt, men inte i ett kör. */
  async #maybeRecalculate(fix) {
    const now = Date.now();
    if (this.busy) return;
    if (now - this._lastRecalcAt < this.opts.recalcCooldownMs) return;
    if (this._recalcs >= this.opts.maxAutoRecalcs) return;
    this._lastRecalcAt = now;
    this._recalcs++;
    try {
      await this.recalculate({ lat: fix.lat, lon: fix.lon });
    } catch {
      // #build har redan skickat 'error'. Rutten ligger kvar som den är och vi
      // är fortfarande offRoute, alltså tysta — vilket är rätt tillstånd.
    }
  }

  /* ================= Matchning av rapporter mot rutten ================= */

  /**
   * Projicera en rapport på rutten. Resultatet cachas per rutt.
   *
   * En rapport står stilla och rutten ändras inte, så projektionen behöver
   * bara räknas EN gång per rapport och rutt. Det som ändras varje sekund är
   * bara var föraren är, och det är en subtraktion. Det är den här cachen som
   * gör att femtio rapporter på en tre mil lång rutt inte kostar något per
   * GPS-tick.
   *
   * En rutt kan passera samma punkt flera gånger — en tur-och-retur, eller en
   * slinga runt ett kvarter. Därför sparas alla passager, inte bara den
   * närmaste, så att "framför mig" kan svara med NÄSTA gång man kör förbi och
   * inte med den passage som redan är avklarad.
   */
  #projection(report) {
    if (this._projRouteId !== this.route.id) {
      this._projections.clear();
      this._projRouteId = this.route.id;
    }
    if (this._projections.has(report.id)) return this._projections.get(report.id);

    const corridor = this.#corridorFor(report);
    const idx = this.route.candidates(report.lat, report.lon, 1);
    let result = null;

    if (idx.length) {
      // Alla segment inom korridoren, sorterade efter position längs rutten.
      const inside = [];
      for (const i of idx) {
        const h = this.route.hitOn(i, report.lat, report.lon);
        if (h.lateral <= corridor) inside.push(h);
      }
      if (inside.length) {
        inside.sort((a, b) => a.seg - b.seg);
        // Slå ihop sammanhängande segment till en passage och behåll det
        // närmaste läget i varje. Utan det skulle en rapport bredvid en lång
        // raksträcka räknas som tjugo separata passager.
        const passes = [];
        let run = inside[0];
        for (let k = 1; k < inside.length; k++) {
          const h = inside[k];
          if (h.seg - inside[k - 1].seg <= 3) {
            if (h.lateral < run.lateral) run = h;
          } else {
            passes.push(run);
            run = h;
          }
        }
        passes.push(run);
        result = { corridor, passes };
      }
    }
    this._projections.set(report.id, result);
    return result;
  }

  /** Korridorbredd för en enskild rapport. Se resonemanget vid DEFAULTS. */
  #corridorFor(r) {
    let c = this.opts.corridorM;
    // Bär rapporten sin egen GPS-osäkerhet får den plats i korridoren.
    if (Number.isFinite(r.accuracy)) c += Math.min(r.accuracy, 100);
    // Röst- och Facebook-rapporter är geokodade på ett gatunamn, inte mätta
    // med GPS. Punkten kan ligga var som helst längs gatan.
    if (r.source === 'voice' || r.source === 'facebook') c += this.opts.geocodedSlackM;
    return Math.min(c, this.opts.corridorMaxM);
  }

  /**
   * Alla aktiva rapporter som ligger i korridoren FRAMFÖR föraren, närmast
   * först. Det här är modulens svar på frågan "vad ska jag akta mig för".
   *
   * @returns {Array<{report, aheadM, lateral, side, s, etaS, atPoint}>}
   */
  matches(now = Date.now()) {
    if (!this.route || !this.progress) return [];
    const here = this.progress.s;
    const out = [];

    /*
     * Flödet, inte store. Se haemtaFaror i konstruktorn: det som inte får
     * höras någon annanstans får inte höras här heller. Kastar den
     * injicerade funktionen faller vi tillbaka på store.active() — ruttvakten
     * får aldrig kunna släcka sig själv, och de talande grindarna finns kvar
     * i #announce och i app.js.
     */
    let flode;
    try {
      flode = this.haemtaFaror(now) || [];
    } catch {
      /*
       * Nödfallet, och det är avsiktligt inte store.active() rakt av.
       *
       * Ruttvakten får inte kunna släcka appen genom att gå sönder —
       * filterHazards() bygger på matches(), så en tom lista här hade tystat
       * även närhetsmotorn under aktiv rutt. Men den får inte heller läcka
       * det som aldrig får sägas. Därför samma fråga som parser.js äger,
       * ställd direkt: allt som ser ut som en nykterhets- eller drogkontroll
       * lämnas utanför även när graderingen inte gick att nå.
       */
      flode = this.store.active(now)
        .filter(r => !isSobrietyCheck(`${r?.note || ''} ${r?.label || ''}`));
    }

    for (const r of flode) {
      if (!ROUTE_ALERT_TYPES.has(r.type)) continue;      // se filen högst upp
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      const p = this.#projection(r);
      if (!p) continue;

      // Nästa passage, inte den närmaste. Har vi redan kört förbi punkten en
      // gång men kommer tillbaka senare på rutten är det återkomsten som är
      // intressant. En liten tolerans bakåt så att man inte tappar en rapport
      // i samma sekund som man är i höjd med den.
      const next = p.passes.find(x => x.s >= here - 40);
      if (!next) continue;

      out.push({
        report: r,
        aheadM: Math.max(0, next.s - here),
        lateral: next.lateral,
        side: next.side > 0 ? 'vänster' : 'höger',
        s: next.s,
        atPoint: this.route.pointAt(next.s),
      });
    }
    out.sort((a, b) => a.aheadM - b.aheadM);
    return out;
  }

  /** Listan att visa i gränssnittet. */
  aheadList(limit = 8) {
    return this.matches().slice(0, limit).map(m => ({
      ...m,
      text: `${shortDistance(m.aheadM)} fram`,
    }));
  }

  /* ================= Överlämning till alerts.js ================= */

  /**
   * Filtrera farolistan innan den går till närhetsmotorn.
   *
   * Det här är den andra halvan av kontraktet med alerts.js, och det som gör
   * att föraren aldrig hör samma polis två gånger:
   *
   *   Fartkameror och annat fast     Går alltid igenom orörda. alerts.js
   *                                  hanterar dem riktningsberoende och den
   *                                  logiken ska aldrig ruttläget peta i.
   *   Rapporter utanför korridoren   Faller bort. Det är hela poängen med
   *                                  ruttläget — parallellgatan är brus.
   *   Rapporter vi redan äger        Faller bort. Vi har sagt till om dem och
   *                                  tar den nära påminnelsen själva.
   *   Rapporter vi kört förbi        Faller bort. Fågelvägen kan de ligga
   *                                  hundra meter bort, men de är avklarade.
   *   Resten                         Går igenom. Det är rapporter som dök upp
   *                                  när de redan var nära, och då är
   *                                  närhetsmotorns vanliga varning helt rätt.
   *
   * Är rutten inte igång — ingen rutt, avvikelse, framme — släpps ALLT igenom
   * oförändrat. Modulen får aldrig kunna tysta appen genom att gå sönder.
   */
  filterHazards(hazards) {
    if (!this.active || this.offRoute || !this.progress) return hazards;

    const ahead = new Map();
    for (const m of this.matches()) ahead.set(m.report.id, m);

    return hazards.filter(h => {
      if (h.type === 'camera' || h.fixed) return true;
      if (!ROUTE_ALERT_TYPES.has(h.type)) return true;
      const m = ahead.get(h.id);
      if (!m) return false;                          // vid sidan av, eller passerad
      const st = this._alertState.get(h.id);
      if (st?.claimed) return false;                 // vi äger den
      return true;
    });
  }

  /** Har ruttvakten tagit ansvar för den här rapporten? */
  isClaimed(id) { return !!this._alertState.get(id)?.claimed; }

  /* ================= Varningsdisciplin ================= */

  /**
   * Sammanfattning vid start.
   *
   * Att läsa upp sex varningar i rad medan bilen fortfarande står på
   * uppfarten är obrukbart. En mening är det rätta: hur många det är och hur
   * långt till den första. Allt som redan ligger inom horisonten räknas som
   * förvarnat av sammanfattningen och får ingen egen förvarning senare — men
   * de får sin nära-påminnelse när man faktiskt närmar sig, vilket är då den
   * gör nytta.
   */
  #brief() {
    const mps = Math.max(this.opts.fallbackSpeedKmh, 20) / 3.6;
    // Räkna bara det som rimligen finns kvar när vi kommer dit. På en 30 mil
    // lång rutt korsar man annars fyrtio rapporter varav trettionio hunnit gå
    // ut långt innan man är i närheten, och "fyrtio rapporter längs vägen" är
    // både skrämmande och osant.
    const matches = this.matches().filter(m => !this.#willBeStale(m, mps));
    const horizon = clamp(mps * this.opts.headsUpSeconds,
      this.opts.headsUpMinM, this.opts.headsUpMaxM);

    for (const m of matches) {
      if (m.aheadM > horizon) continue;
      if (m.aheadM <= this.opts.handoffM) continue;   // närhetsmotorns område
      const st = this.#stateOf(m.report.id);
      st.claimed = true;
      st.headsUpAt = Date.now();
    }

    const n = matches.length;
    const km = Math.round(this.route.distanceM / 1000);
    const min = Math.round(this.route.durationS / 60);
    let spoken;
    if (!n) {
      spoken = `Rutt till ${this.destination.label}, ${km} kilometer, ungefär ${min} minuter. ` +
        'Inga rapporter längs vägen just nu.';
    } else {
      const first = matches[0];
      const kind = TYPE_SPOKEN[first.report.type] || 'varning';
      spoken = `Rutt till ${this.destination.label}, ${km} kilometer. ` +
        `${n === 1 ? 'En rapport' : `${n} rapporter`} längs vägen. ` +
        `Närmast ${kind} om ${spokenDistance(first.aheadM)}.`;
    }

    this.#emit('route-summary', {
      spoken,
      count: n,
      distanceM: this.route.distanceM,
      durationS: this.route.durationS,
      matches: matches.slice(0, 8),
    });
  }

  /**
   * Bestäm om något ska sägas den här sekunden.
   *
   * Högst en varning per varv och per talpaus, den närmaste först. Att
   * prioritera efter avstånd i stället för efter turordning är viktigt: den
   * som är närmast är den föraren behöver agera på nu, och den som ligger
   * längre bort tål att vänta ett varv till.
   */
  #announce(fix, matches) {
    const fired = [];
    if (!this.enabled || !matches.length) return fired;

    const speedKmh = fix.speedKmh ?? 0;
    if (speedKmh < this.opts.minSpeedKmh) return fired;   // står stilla

    const now = Date.now();
    if (now - this._lastSpokeAt < this.opts.minGapMs) return fired;

    const mps = Math.max(speedKmh, 20) / 3.6;
    const horizon = clamp(mps * this.opts.headsUpSeconds,
      this.opts.headsUpMinM, this.opts.headsUpMaxM);
    const imminent = clamp(mps * this.opts.imminentSeconds,
      this.opts.imminentMinM, this.opts.imminentMaxM);
    // Fönstret där vi över huvud taget får claima något. Är horisonten kortare
    // än överlämningsgränsen finns inget fönster, och då gör alerts.js allt.
    const claimFrom = this.opts.handoffM;
    const claimTo = Math.max(horizon, this.opts.handoffM + this.opts.handoffMarginM);

    for (const m of matches) {
      const st = this.#stateOf(m.report.id);

      // 1. Nära-påminnelsen på det vi äger. Går före allt annat: den är den
      //    enda varning som handlar om något som händer om trettio sekunder.
      if (st.claimed && !st.imminentAt && m.aheadM <= imminent) {
        st.imminentAt = now;
        fired.push(this.#buildAlert(m, 'imminent'));
        break;
      }

      // 2. Förvarningen. Bara på det som ligger utanför närhetsmotorns
      //    räckvidd — annars dubbelvarnar vi.
      if (!st.claimed && !st.headsUpAt &&
          m.aheadM > claimFrom && m.aheadM <= claimTo) {
        if (this.#willBeStale(m, mps)) {
          // Rapporten hinner gå ut innan vi är framme. Att säga "polis om fem
          // kilometer" om något som försvinner om tre minuter lär föraren att
          // varningarna inte stämmer.
          //
          // Överhoppningen får INTE fastna. Bedömningen bygger på nuvarande
          // fart, och den ändras: står man i kö när rapporten dyker upp är
          // ETA:n tio minuter, men släpper kön är den två. Därför bara
          // continue — nästa varv görs bedömningen om från nytt underlag.
          // Vi claimar den inte heller, så finns den kvar när vi kommer nära
          // tar alerts.js den på vanligt vis.
          continue;
        }
        st.claimed = true;
        st.headsUpAt = now;
        fired.push(this.#buildAlert(m, 'ahead'));
        break;
      }
    }

    if (fired.length) {
      this._lastSpokeAt = now;
      for (const a of fired) this.#emit('route-alert', a);
    }
    return fired;
  }

  /** Hinner rapporten gå ut innan vi är framme vid den? */
  #willBeStale(m, mps) {
    const exp = m.report.expiresAt || m.report.expires_at;
    if (!exp) return false;
    const etaMs = (m.aheadM / Math.max(mps, 5)) * 1000;
    return exp < Date.now() + etaMs;
  }

  #stateOf(id) {
    let st = this._alertState.get(id);
    if (!st) this._alertState.set(id, st = { claimed: false, headsUpAt: 0, imminentAt: 0 });
    return st;
  }

  /**
   * Bygg varningen.
   *
   * Formuleringen säger avstånd LÄNGS VÄGEN och gör det tydligt att det är på
   * rutten, för det är den informationen som skiljer den här varningen från
   * närhetsvarningen: "om fyra kilometer" betyder fyra kilometers körning, inte
   * fyra kilometer fågelvägen.
   *
   * Sidan — höger eller vänster — finns i händelsen men sägs inte högt. Den
   * bygger på var rapportens punkt hamnade i förhållande till mittlinjen, och
   * den punkten bär både GPS-fel och geokodningsfel. Att säga "på höger sida"
   * och ha fel är sämre än att inte säga något: föraren tittar åt fel håll.
   * Gränssnittet får gärna visa det, rösten ska inte påstå det.
   */
  #buildAlert(m, stage) {
    const r = m.report;
    const kind = TYPE_SPOKEN[r.type] || 'varning';
    const where = r.label ? ` vid ${r.label}` : '';
    const dist = spokenDistance(m.aheadM);

    const spoken = stage === 'ahead'
      ? `${cap(kind)} ${dist} fram på rutten${where}` +
        (r.createdAt ? `, rapporterat ${spokenAge(r.createdAt)}.` : '.')
      : `Varning. ${cap(kind)}${where}, om ${dist}.`;

    return {
      id: r.id,
      hazard: r,
      stage,                      // 'ahead' = förvarning, 'imminent' = nära
      distance: m.aheadM,         // längs rutten, inte fågelvägen
      lateral: Math.round(m.lateral),
      side: m.side,
      atPoint: m.atPoint,
      spoken,
      // Förvarningen är information, nära-påminnelsen är en varning. Samma
      // skala som alerts.js använder, så mottagaren kan behandla dem lika.
      priority: stage === 'imminent' ? 2 : 1,
      onRoute: true,
      at: Date.now(),
    };
  }

  /* ================= Övrigt ================= */

  /** Kalla in nytt underlag när pollningen hämtat rapporter. */
  onReportsChanged() {
    if (!this.route) return;
    // Städa bort projektioner för rapporter som inte finns längre, annars
    // växer cachen under en lång körning.
    const live = new Set(this.store.active().map(r => r.id));
    for (const id of this._projections.keys()) if (!live.has(id)) this._projections.delete(id);
    for (const id of this._alertState.keys()) if (!live.has(id)) this._alertState.delete(id);
  }

  /** Serialiserbar bild av rutten — för kartan och för att spara. */
  publicRoute() {
    if (!this.route) return null;
    return {
      id: this.route.id,
      name: this.route.name,
      destination: this.destination,
      points: this.route.points,
      distanceM: this.route.distanceM,
      durationS: this.route.durationS,
    };
  }

  describe() {
    if (!this.route) return 'Ingen rutt vald.';
    if (this.arrived) return `Framme vid ${this.destination.label}.`;
    if (this.offRoute) return 'Du har lämnat rutten. Räknar om…';
    const left = this.progress ? this.progress.remainingM : this.route.lengthM;
    const min = this.progress?.etaS != null ? Math.round(this.progress.etaS / 60) : null;
    return `Till ${this.destination.label}: ${shortDistance(left)} kvar` +
      (min != null ? `, cirka ${min} min` : '') + '.';
  }

  #here() { return this._lastFix; }

  /**
   * Kom ihåg var föraren är.
   *
   * Anropas automatiskt av update(), men finns också publikt så att sökrutan
   * kan vikta träffar mot förarens position innan någon rutt existerar — och
   * så att setDestination() kan anropas utan att den som kopplar ihop
   * gränssnittet behöver skicka med startpunkten varje gång.
   */
  noteFix(fix) {
    if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lon)) {
      this._lastFix = { lat: fix.lat, lon: fix.lon };
    }
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export { ROUTE_ALERT_TYPES, DEFAULTS as ROUTE_DEFAULTS };
