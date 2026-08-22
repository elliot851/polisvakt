// Chatt — ett rum som följer med dit man kör.
//
// Inga grupper, inga privata meddelanden, inga trådar. Ett rum per trakt. Det
// är ett medvetet beslut: den som sitter i en bil ska kunna fråga "står de kvar
// vid Erikslund?" och få svar av någon som just körde förbi. Delar man upp folk
// i namngivna rum blir varje rum tomt, och en tom chatt är värre än ingen chatt
// — men ett enda rikstäckande rum är lika illa åt andra hållet: skriver någon i
// Malmö att polisen står vid Värnhem hjälper det ingen i Västerås.
//
// Därför ett grovt rutnät istället för rum. Se avsnittet OMRÅDE nedan.
//
// Tre saker skiljer det här från en vanlig chatt, och alla tre finns för att
// appen används bakom en ratt:
//
//   1. NYKTERHETSKONTROLLER SLÄPPS ALDRIG IGENOM. Appen vägrar redan sådana
//      rapporter i parser.js. En fritextchatt är den självklara vägen runt
//      den regeln, och den vägen är stängd — här i klienten OCH i databasen.
//      Filtret importeras från parser.js, det finns ingen andra kopia av
//      ordlistan som kan hamna ur synk.
//
//   2. SKRIVNING LÅSES NÄR BILEN RULLAR. Läsning fortsätter (någon annan i
//      bilen kan läsa högt), men tangentbordet är stängt över tröskeln. Hela
//      appen bygger på "titta på vägen, inte på skärmen" — en chatt som ber
//      föraren skriva medan bilen rullar river ner precis det.
//
//   3. POLLNING, INTE WEBSOCKET. Appen pollar redan Supabase och har en
//      fungerande offlinekö (se store.js). En andra transport hade betytt en
//      andra sak som kan sluta fungera tyst. Pollningen går långsammare när
//      chattvyn inte visas och pausar helt när fliken är dold — batteriet är
//      en förstklassig fråga i en bilapp.
//
// Rå fetch mot PostgREST, precis som store.js och auth.js. Inga bibliotek.

import { uid } from './util.js';
import { apiHeaders } from './config.js';
import { isSobrietyCheck } from './parser.js';

/* ---- Gränser --------------------------------------------------------- */

export const GRANSER = {
  /** Längsta meddelande. Samma tak som i databasen. */
  maxTecken: 400,

  /**
   * Kortaste tid mellan två egna meddelanden.
   *
   * Fem sekunder känns långt när man sitter still och skriver, och det är
   * meningen. Chatten är till för korta lägesbesked, inte för ett samtal i
   * realtid — och varje meddelande kostar batteri och uppmärksamhet hos alla
   * andra som kör just nu.
   */
  minMellanMs: 5000,

  maxPerMinut: 5,
  maxPerTimme: 60,

  /**
   * Över den här farten är inmatningen låst.
   *
   * Åtta km/h är samma gräns som geo.js använder för "moving". Under den
   * rullar man i en kö eller på en parkering; över den kör man. Vakthundens
   * 15 km/h är medvetet högre — den avgör om ett FEL är värt att säga högt,
   * inte om det är säkert att skriva.
   */
  farttroskelKmh: 8,

  /**
   * Hur gammal en fartavläsning får vara innan vi slutar lita på den.
   *
   * Utan den här spärren låser en sista avläsning på 90 km/h innan tunneln
   * fältet för alltid — bilen står parkerad, telefonen har ingen GPS, och
   * appen vägrar envist låta någon skriva. En låsning som inte går att ta
   * sig ur är ett fel, inte en säkerhetsfunktion.
   */
  fartFarskMs: 20000,

  /**
   * Hur många färska avläsningar i rad som måste ligga över tröskeln innan
   * fältet låses.
   *
   * Bakgrund: spärren slog till för folk som satt blickstilla inomhus. GPS
   * inomhus har ingen satellitfix att gå på och positionen hoppar mellan
   * wifi- och mastgissningar. Två gissningar 30 meter isär med en sekund
   * emellan blir 108 km/h i geo.js härledning — ett enda sådant utslag låste
   * tidigare fältet i hela tjugo sekunder (fartFarskMs), och nästa utslag
   * förlängde låsningen. Det såg ut som slumpen.
   *
   * Två avläsningar i rad, inte en. Ett hopp räcker inte; en verklig körning
   * ger en ny avläsning i sekunden och låser alltså inom ett par sekunder —
   * långt innan någon hunnit skriva något.
   *
   * Avvägningen, uttalad: spärren finns för att ingen ska sitta och skriva i
   * nittio. Men en spärr som slår till när man står still lär användaren att
   * den är trasig, och då litar hen inte på den när den har rätt. Ett litet
   * glapp åt det öppna hållet är billigare än att hela funktionen förlorar
   * sin trovärdighet — särskilt eftersom grinden prövas en gång till när
   * Skicka trycks.
   *
   * Låsningen är därför medvetet OSYMMETRISK: den slår till på den andra
   * avläsningen över tröskeln, men släpper på den första trovärdiga
   * avläsningen under den. Fel åt det låsande hållet kan låsa någon ute i
   * tjugo sekunder; fel åt det öppna hållet varar en sekund, tills nästa
   * avläsning kommer in.
   */
  fartMinTraffar: 2,

  /**
   * Sämsta GPS-noggrannhet (meter) vi tar en fartavläsning på allvar från.
   *
   * geo.js ber om enableHighAccuracy. Utomhus med satellitfix ligger
   * accuracy på 5–20 meter. Inomhus finns ingen fix och accuracy landar på
   * 30–2000 meter. En position som får ligga femtio meter fel kan "flytta
   * sig" hundra meter mellan två avläsningar utan att någon rört sig, och en
   * fart räknad ur den säger ingenting om bilen rullar. Sådana avläsningar
   * kastas helt — de får varken låsa eller låsa upp.
   *
   * Saknas accuracy (äldre anrop, sattFart utan mer information) litar vi på
   * värdet. Vi kan inte straffa en anropare för att den inte berättade.
   */
  fartMaxOsakerhetM: 50,

  /** Pollintervall när chattvyn syns. */
  pollAktivMs: 8000,
  /** Pollintervall när chatten är öppen men vyn inte visas. */
  pollBakgrundMs: 60000,

  /** Hur många meddelanden som hämtas. */
  hamtaAntal: 100,

  /** Hur ofta en inkrementell hämtning byts mot en full (för att se raderingar). */
  fullHamtningVar: 10,

  /** Databasen städar äldre än så här. Klienten gör samma sak lokalt. */
  gallringDygn: 7,
};

/** Skälen kanSkriva/farSkicka kan ge, med färdig svensk förklaring. */
export const SKAL_TEXT = {
  inte_inloggad: 'Logga in för att skriva i chatten.',
  kor:           'Bilen rullar. Du kan läsa, men inte skriva förrän du står still.',
  tomt:          'Skriv något först.',
  for_langt:     `För långt. Håll dig under ${GRANSER.maxTecken} tecken.`,
  nykterhet:     'Nykterhets- och drogkontroller delas inte i Polisvakt. Det gäller ' +
                 'chatten också.',
  for_tatt:      'Vänta några sekunder mellan meddelandena.',
  for_manga:     'Du har skrivit många meddelanden på kort tid. Ta en paus.',
};

const ok = () => ({ ok: true, skal: null, meddelande: '' });
const nej = skal => ({ ok: false, skal, meddelande: SKAL_TEXT[skal] || 'Går inte just nu.' });

/* ---- Det rena lagret ------------------------------------------------- */
/*
 * Allt som avgör om ett meddelande får skickas ligger i två rena funktioner
 * utan nätverk, utan localStorage och utan klocka som inte går att skicka in.
 * Det är därför de går att testa rakt av i chatt-test.html — och därför de
 * går att lita på.
 */

/**
 * Väg samman de senaste fartavläsningarna till ett besked: rullar bilen?
 *
 * Ren funktion, ingen klocka och inget GPS. Hela tåligheten mot skräpvärden
 * ligger här, och därför går den att testa rakt av.
 *
 * Tre steg, i tur och ordning:
 *
 *   1. Kasta det som inte går att lita på — för gammalt (fartFarskMs) eller
 *      mätt med för dålig noggrannhet (fartMaxOsakerhetM). Blir ingenting
 *      kvar vet vi ingenting om farten, och då är fältet ÖPPET. Okänd fart
 *      har aldrig låst och ska aldrig göra det: annars låser en telefon utan
 *      GPS-tillstånd ute sin ägare för alltid.
 *
 *   2. Räkna svansen: hur många av de SENASTE avläsningarna i rad som ligger
 *      över tröskeln. Just svansen, inte totalen — en enda avläsning under
 *      tröskeln nollar räknaren, vilket är precis det som ska hända när man
 *      stannar.
 *
 *   3. Lås om svansen är minst fartMinTraffar lång.
 *
 * @param {Array<{kmh:number, at:number, noggrannhetM?:number|null}>} prover
 * @param {number} nu
 * @param {object} granser
 * @returns {{kmh:number|null, traffar:number, prover:number, laser:boolean}}
 */
export function bedomFart(prover, nu = Date.now(), granser = GRANSER) {
  const g = { ...GRANSER, ...(granser || {}) };

  const farska = (Array.isArray(prover) ? prover : [])
    .filter(p => p && Number.isFinite(p.kmh) && Number.isFinite(p.at))
    .filter(p => nu - p.at <= g.fartFarskMs && nu - p.at >= -1000)
    .filter(p => !Number.isFinite(p.noggrannhetM) || p.noggrannhetM <= g.fartMaxOsakerhetM)
    .sort((a, b) => a.at - b.at);

  if (!farska.length) return { kmh: null, traffar: 0, prover: 0, laser: false };

  let traffar = 0;
  for (let i = farska.length - 1; i >= 0; i--) {
    if (farska[i].kmh > g.farttroskelKmh) traffar++;
    else break;
  }

  return {
    kmh: farska[farska.length - 1].kmh,
    traffar,
    prover: farska.length,
    laser: traffar >= g.fartMinTraffar,
  };
}

/**
 * Får föraren skriva just nu? Avgör om inmatningsfältet ska vara låst.
 *
 * Två vägar in, och det är avsiktligt:
 *
 *   - fartProver: en lista avläsningar. Då gäller bedomFart ovan med allt vad
 *     det innebär av tålighet mot enstaka utslag. Det är vägen Chatt-klassen
 *     går, och alltså vägen appen går.
 *
 *   - fartKmh + fartAlderMs: EN fart som anroparen redan bestämt sig för att
 *     lita på. Då tas den för god. Den vägen finns kvar för anropare som
 *     själva vet vad de mätt, och för att kunna ställa en fråga om en enskild
 *     fart utan att först bygga en historik.
 *
 * @param {{inloggad?:boolean, fartKmh?:number|null, fartAlderMs?:number,
 *          fartNoggrannhetM?:number|null,
 *          fartProver?:Array, nu?:number, granser?:object}} lage
 * @returns {{ok:boolean, skal:string|null, meddelande:string}}
 */
export function skrivlage(lage = {}) {
  const g = { ...GRANSER, ...(lage.granser || {}) };

  if (lage.inloggad === false) return nej('inte_inloggad');

  if (Array.isArray(lage.fartProver)) {
    return bedomFart(lage.fartProver, lage.nu ?? Date.now(), g).laser ? nej('kor') : ok();
  }

  const fart = lage.fartKmh;
  const alder = lage.fartAlderMs ?? 0;
  // En fix med usel noggrannhet ger en fart som inte är värd att agera på.
  const osaker = Number.isFinite(lage.fartNoggrannhetM)
    && lage.fartNoggrannhetM > g.fartMaxOsakerhetM;
  const farsk = Number.isFinite(fart) && alder <= g.fartFarskMs && !osaker;
  if (farsk && fart > g.farttroskelKmh) return nej('kor');

  return ok();
}

/**
 * Får det här meddelandet skickas? Hela grinden: inloggning, fart, innehåll
 * och hastighetsgräns.
 *
 * @param {string} text
 * @param {{inloggad?:boolean, fartKmh?:number|null, fartAlderMs?:number,
 *          historik?:number[], nu?:number, granser?:object}} lage
 *        historik = tidpunkter (ms) för egna skickade meddelanden.
 * @returns {{ok:boolean, skal:string|null, meddelande:string}}
 */
export function farSkicka(text, lage = {}) {
  const g = { ...GRANSER, ...(lage.granser || {}) };
  const nu = lage.nu ?? Date.now();
  const t = String(text ?? '').trim();

  if (!t) return nej('tomt');
  if (t.length > g.maxTecken) return nej('for_langt');

  /*
   * Produktregeln, före allt annat som handlar om innehåll.
   *
   * isSobrietyCheck importeras från parser.js med flit. Den listan har redan
   * lärt sig saker som inte syns förrän man tittar — att folk och
   * röstigenkänning särskriver ("alkohol kontroll"), och att "drogtest" och
   * "sållningsprov" betyder samma sak. En andra kopia här hade drivit isär
   * från den första inom en månad, och glappet hade blivit exakt den lucka
   * regeln finns för att täppa till.
   */
  if (isSobrietyCheck(t)) return nej('nykterhet');

  const skriv = skrivlage({ ...lage, granser: g });
  if (!skriv.ok) return skriv;

  const h = (lage.historik || []).filter(Number.isFinite);
  const senaste = h.length ? Math.max(...h) : 0;
  if (senaste && nu - senaste < g.minMellanMs) return nej('for_tatt');
  if (h.filter(x => nu - x < 60000).length >= g.maxPerMinut) return nej('for_manga');
  if (h.filter(x => nu - x < 3600000).length >= g.maxPerTimme) return nej('for_manga');

  return ok();
}

/* ---- Namn ------------------------------------------------------------ */

/** FNV-1a, 32 bitar. Samma funktion finns i supabase/chatt.sql. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  const b = new TextEncoder().encode(String(s ?? ''));
  for (const x of b) {
    h ^= x;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Namnet den får som inte valt smeknamn.
 *
 * Aldrig e-postadressen. En chatt där folk syns med sin e-post är en chatt
 * där man inte vågar skriva, och adressen går dessutom inte att ta tillbaka
 * när den väl stått i rummet.
 *
 * Stabilt per konto — samma person heter samma sak imorgon, annars går det
 * inte att följa ett samtal. Härledningen är densamma i databasen, så namnet
 * blir identiskt oavsett vem som räknar ut det.
 */
export function neutraltNamn(identitet) {
  return `Förare ${1000 + (fnv1a(identitet) % 9000)}`;
}

/** Städa ett smeknamn till något som går att visa bredvid andras. */
export function stadaNamn(namn) {
  return String(namn ?? '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

/* ---- OMRÅDE ---------------------------------------------------------- */
/*
 * Ett meddelande hör hemma i en trakt, inte i hela landet och inte på en
 * punkt. Varje meddelande får därför en områdeskod: numret på den ruta i ett
 * grovt rutnät som avsändaren befann sig i. Klienten hämtar sin egen ruta plus
 * de åtta omkringliggande.
 *
 * VARFÖR RUTNÄT OCH INTE LÄN
 *
 * Länsgränser skär rakt genom vardagen. Den som kör två kilometer in i Uppsala
 * län ska självklart se en varning från Västerås — gränsen finns på en karta,
 * inte på vägen. Ett rutnät ger "nära mig", vilket är det ägaren egentligen
 * menar med "i Västmanland". Dessutom kräver en länsuppslagning ett anrop per
 * meddelande, och ett rutnät kräver noll.
 *
 * VARFÖR ALDRIG EXAKTA KOORDINATER — det tyngsta skälet
 *
 * Ett chattmeddelande med lat och lon är en post i en logg över var en enskild
 * person befunnit sig och när. Sju dagars sådana rader är en rörelsekarta över
 * någons liv: hemadress, arbetsplats, vilka kvällar hen inte var hemma. Den
 * loggen får inte finnas, för allt som finns kan begäras ut, läcka eller
 * missbrukas. Det säkraste sättet att inte läcka den är att aldrig skapa den.
 *
 * En ruta på cirka 25 km säger "trakten", inte "platsen". Den räcker för att
 * avgöra om ett meddelande angår mig, och den räcker inte för att följa någon.
 * Koden består av exakt två heltal och kan aldrig bära mer information än så —
 * hela Västerås med förorter delar en och samma kod.
 *
 * SÅ RÄKNAS DEN
 *
 * Latitud golvas till närmaste 0,25 grad (cirka 27,8 km, konstant överallt).
 * Longitud golvas till närmaste 0,5 grad. En longitudgrad krymper norrut, så
 * rutans bredd går från cirka 31 km i Skåne till cirka 21 km i Kiruna. Det är
 * med flit: fasta steg i grader gör grannrutorna till en ren heltalsaddition,
 * och en ruta som är lite smalare långt norrut skadar ingen.
 *
 * Koden skrivs "r" + latitudindex + "x" + longitudindex, till exempel r238x33
 * för Västerås. Negativa index skrivs med minustecken.
 */

export const RUTA = {
  /** Latitudsteg i grader. 0,25 grad = cirka 27,8 km, överallt. */
  latSteg: 0.25,
  /** Longitudsteg i grader. 0,5 grad = cirka 31 km i Skåne, 21 km i Kiruna. */
  lonSteg: 0.5,
  /*
   * Rimlighetsfönster. Ligger positionen utanför är den inte något appen kan
   * göra något vettigt av, och meddelandet blir "utan område" istället för att
   * få en påhittad ruta. Fönstret är också taket för hur många olika koder
   * som över huvud taget kan lagras, alltså taket för hur mycket den kan
   * avslöja.
   */
  latMin: 54, latMax: 72,
  lonMin: 2,  lonMax: 34,
};

/** Enda tillåtna formen. Två heltal, ingenting annat. */
export const RUTA_MONSTER = /^r(-?\d{1,4})x(-?\d{1,4})$/;

/** Texten gränssnittet ska visa på ett meddelande utan områdeskod. */
export const UTAN_OMRADE_TEXT = 'Utan område — syns för alla';

const rutkodAvIndex = (y, x) => `r${y}x${x}`;

/**
 * Rutan en position ligger i, eller null om positionen saknas eller ligger
 * utanför rimlighetsfönstret.
 *
 * Math.floor, inte Math.round: golvning ger rutor med fasta kanter som ligger
 * still. Avrundning hade lagt rutgränsen mitt i rutan och gjort grannlogiken
 * fel i kanterna.
 */
export function rutkod(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < RUTA.latMin || lat > RUTA.latMax) return null;
  if (lon < RUTA.lonMin || lon > RUTA.lonMax) return null;
  return rutkodAvIndex(Math.floor(lat / RUTA.latSteg), Math.floor(lon / RUTA.lonSteg));
}

/** Heltalen ur en kod, eller null om koden inte har rätt form. */
export function rutIndex(kod) {
  const m = RUTA_MONSTER.exec(String(kod ?? ''));
  if (!m) return null;
  const y = Number(m[1]), x = Number(m[2]);
  const yMin = Math.floor(RUTA.latMin / RUTA.latSteg), yMax = Math.floor(RUTA.latMax / RUTA.latSteg);
  const xMin = Math.floor(RUTA.lonMin / RUTA.lonSteg), xMax = Math.floor(RUTA.lonMax / RUTA.lonSteg);
  if (y < yMin || y > yMax || x < xMin || x > xMax) return null;
  return { y, x };
}

/** Är det här en giltig områdeskod? */
export function arRutkod(kod) { return rutIndex(kod) !== null; }

/**
 * Den egna rutan plus de åtta omkringliggande, nio koder.
 *
 * Nio och inte en, för att en ruta är godtyckligt utlagd: står man femtio
 * meter från rutkanten är hälften av "nära mig" i grannrutan. Med grannarna
 * med blir det garanterade avståndet till kanten minst en hel ruta.
 */
export function grannrutor(kod) {
  const i = rutIndex(kod);
  if (!i) return null;
  const ut = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) ut.push(rutkodAvIndex(i.y + dy, i.x + dx));
  }
  return ut;
}

/**
 * Rutans mittpunkt. Finns för kartor och tester — det är ALLT som går att
 * återskapa ur en kod, och det är hela poängen. Mittpunkten är inte var någon
 * var; den är mitten av en yta stor som en kommun.
 */
export function rutansMitt(kod) {
  const i = rutIndex(kod);
  if (!i) return null;
  return {
    lat: (i.y + 0.5) * RUTA.latSteg,
    lon: (i.x + 0.5) * RUTA.lonSteg,
  };
}

/* ---- Lagring --------------------------------------------------------- */

function lasJSON(k, reserv) {
  try { return JSON.parse(localStorage.getItem(k)) ?? reserv; } catch { return reserv; }
}
function skrivJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

/* ---- Chatten --------------------------------------------------------- */

/**
 * Händelser:
 *   'meddelanden'  listan ändrades (nytt, raderat, hämtat)
 *   'status'       online/offline, synkfel, pollintervall
 *   'blockerat'    ett försök att skicka stoppades — detail = {skal, meddelande}
 */
export class Chatt extends EventTarget {
  /**
   * @param {{url?:string, key?:string, identitet?:string|null,
   *          visningsnamn?:string, granser?:object, lagringsPrefix?:string}} cfg
   */
  constructor(cfg = {}) {
    super();
    this.cfg = { lagringsPrefix: 'pv.chatt', ...cfg };
    this.granser = { ...GRANSER, ...(cfg.granser || {}) };

    this.meddelandenMap = new Map();     // id -> meddelande
    this.egnaTider = [];                 // tidpunkter för egna skickade
    this.timer = null;
    this.vyAktiv = false;
    this.online = typeof navigator === 'undefined' ? true : navigator.onLine;
    this.senasteSynk = null;
    this.synkFel = null;
    this.fartKmh = null;
    this.fartAt = 0;
    this.fartProver = [];                // rullande fönster av fartavläsningar
    this.rutkod = null;                  // egen områdeskod, null tills GPS svarat
    this._nyRuta = false;                // rutan bytte — nästa hämtning tas om helt
    this._pollRakning = 0;

    this.tystade = new Set(lasJSON(this.#nyckel('tystade'), []));
    this.anmalda = new Set(lasJSON(this.#nyckel('anmalda'), []));
    for (const m of lasJSON(this.#nyckel('cache'), [])) this.meddelandenMap.set(m.id, m);
    this.egnaTider = lasJSON(this.#nyckel('tider'), []);

    this._online = () => { this.online = true; this.#emit('status'); this.tommKo(); this.hamta(); };
    this._offline = () => { this.online = false; this.#emit('status'); };
    if (typeof addEventListener === 'function') {
      addEventListener('online', this._online);
      addEventListener('offline', this._offline);
    }
  }

  #nyckel(namn) { return `${this.cfg.lagringsPrefix}.${namn}.v1`; }

  get harBackend() { return !!(this.cfg.url && this.cfg.key); }
  get inloggad() { return !!this.cfg.identitet; }

  /**
   * Varför flödet inte går att läsa just nu — eller null när det går.
   *
   * Chatten är stängd för utomstående, och det är ett medvetet beslut som
   * står i supabase/chatt.sql: rapporterna är publika för att en varning gör
   * nytta även för den som aldrig registrerat sig, medan chatten är fritext
   * folk skriver till varandra. Vyn chatt_flode är därför utdelad till
   * authenticated och till ingen annan, och den kräver auth.uid() i sig själv.
   *
   * Följden måste synas. Tidigare hämtade appen flödet med anon-nyckeln, fick
   * 401, och visade en tom lista med "Inga meddelanden än. Säg något." — ett
   * påstående som inte var sant. Den som läste det trodde att chatten var
   * tom, inte att den var stängd, och hade ingen anledning att logga in.
   *
   * Utan backend returneras null: då är ingenting stängt, appen kör bara
   * lokalt, och den saknaden har egna texter på annat håll.
   */
  get lasSparr() {
    if (!this.harBackend || this.inloggad) return null;
    return 'Chatten är bara för inloggade. Logga in så ser du vad andra ' +
           'förare skriver i din trakt.';
  }

  konfigurera(cfg) {
    const gickIgang = !!this.timer;
    this.cfg = { ...this.cfg, ...cfg };
    if (cfg.granser) this.granser = { ...this.granser, ...cfg.granser };
    if (gickIgang) { this.stoppa(); this.starta(); }
  }

  /* ---- Livscykel ---------------------------------------------------- */

  starta() {
    this.stoppa();
    this.hamta();
    this.#stallTimer();
    this._synlighet = () => {
      // Dold flik = ingen pollning alls. Telefonen ligger i fickan och
      // ingen läser ändå; varje anrop är ren batteriförlust.
      this.#stallTimer();
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.hamta();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._synlighet);
    }
  }

  stoppa() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this._synlighet && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._synlighet);
      this._synlighet = null;
    }
  }

  /** Släpp allt — lyssnare på window också. Kallas om chatten stängs av helt. */
  kopplaLoss() {
    this.stoppa();
    if (typeof removeEventListener === 'function') {
      removeEventListener('online', this._online);
      removeEventListener('offline', this._offline);
    }
  }

  /** Talar om ifall chattvyn visas. Styr hur ofta vi pollar. */
  sattVyAktiv(aktiv) {
    const nytt = !!aktiv;
    if (nytt === this.vyAktiv) return;
    this.vyAktiv = nytt;
    if (this.timer) this.#stallTimer();
    if (nytt) this.hamta();
  }

  /** Är fliken dold? Då pollar vi inte alls. */
  get dold() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  /**
   * Intervallet vyn förtjänar, oavsett om fliken råkar vara dold just nu.
   *
   * Åtta sekunder när man tittar på chatten, en minut när man inte gör det.
   * En bilapp som ligger och pollar var åttonde sekund i timmar för en vy
   * ingen har framme äter batteri som föraren behöver till att komma hem.
   */
  get intervallMs() {
    return this.vyAktiv ? this.granser.pollAktivMs : this.granser.pollBakgrundMs;
  }

  /** Nuvarande pollintervall i ms, eller 0 när pollningen är pausad. */
  get pollMs() { return this.dold ? 0 : this.intervallMs; }

  #stallTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ms = this.pollMs;
    if (!ms) { this.#emit('status'); return; }
    this.timer = setInterval(() => this.hamta(), ms);
    this.#emit('status');
  }

  /**
   * Mata in en position från geo.js. Samma namn som Vakthund.notera.
   *
   * Fixen bär både fart, noggrannhet och koordinater. Koordinaterna används
   * här och bara här: de blir en områdeskod och kastas sedan. Ingen lat och
   * ingen lon lagras, varken i minnet, i localStorage eller på servern.
   */
  notera(fix, nu = Date.now()) {
    if (!fix) return;
    if (Number.isFinite(fix.speedKmh)) this.sattFart(fix.speedKmh, nu, fix.accuracy);
    if (Number.isFinite(fix.lat) && Number.isFinite(fix.lon)) {
      this.sattPosition(fix.lat, fix.lon);
    }
  }

  /**
   * Sätt farten direkt, utan en hel GPS-fix.
   *
   * @param {number|null} kmh
   * @param {number} nu
   * @param {number|null} noggrannhetM GPS-noggrannhet i meter, om den är känd.
   */
  sattFart(kmh, nu = Date.now(), noggrannhetM = null) {
    if (!Number.isFinite(kmh)) {
      // Farten är okänd. Ingen okänd fart får låsa något, så töm fönstret.
      this.fartKmh = null;
      this.fartAt = nu;
      this.fartProver = [];
      return;
    }
    this.fartKmh = kmh;
    this.fartAt = nu;
    this.fartProver = [
      ...this.fartProver,
      { kmh, at: nu, noggrannhetM: Number.isFinite(noggrannhetM) ? noggrannhetM : null },
    ]
      .filter(p => nu - p.at <= this.granser.fartFarskMs)
      .slice(-20);
  }

  /**
   * Vilken ruta befinner sig föraren i? Bara rutan sparas.
   *
   * Byter rutan tas nästa hämtning om helt (se hamta). Annars hade den
   * inkrementella hämtningen bara sett nya rader, och den som kör in i en ny
   * trakt hade fått ett tomt rum tills någon skrev något nytt.
   */
  sattPosition(lat, lon) {
    const kod = rutkod(lat, lon);
    if (kod === this.rutkod) return;
    this.rutkod = kod;
    this._nyRuta = true;
    this.#emit('status');
  }

  /**
   * De nio koder som räknas som "nära mig", eller null när rutan är okänd.
   *
   * Är den null filtrerar vi ingenting alls — utan GPS ska ingen tystas, och
   * hellre ett meddelande från fel del av landet än en tom skärm utan
   * förklaring.
   */
  get omradeKoder() { return grannrutor(this.rutkod); }

  /* ---- Grinden ------------------------------------------------------ */

  #lage(nu = Date.now()) {
    return {
      inloggad: this.inloggad,
      // fartProver avgör låsningen. fartKmh och fartAlderMs följer med för
      // gränssnittet och för den som vill läsa av senaste värdet.
      fartProver: this.fartProver,
      fartKmh: this.fartKmh,
      fartAlderMs: this.fartAt ? nu - this.fartAt : Infinity,
      historik: this.egnaTider,
      granser: this.granser,
      nu,
    };
  }

  /** Fartbedömningen bakom låset. För felsökning och för gränssnittet. */
  fartlage(nu = Date.now()) { return bedomFart(this.fartProver, nu, this.granser); }

  /** Ska inmatningsfältet vara låst? Anropas av gränssnittet. */
  kanSkriva(nu = Date.now()) { return skrivlage(this.#lage(nu)); }

  /** Skulle det här meddelandet gå igenom? Utan att skicka det. */
  provaSkicka(text, nu = Date.now()) { return farSkicka(text, this.#lage(nu)); }

  /* ---- Läsning ------------------------------------------------------ */

  /**
   * Meddelandena att visa: äldst först, tystade avsändare bortfiltrerade och
   * allt äldre än gallringsgränsen borta.
   *
   * Områdesfiltret är serverns jobb — det är hela poängen med att skicka
   * rutan i frågan istället för att hämta hela landet över mobildatan. Det
   * som görs här är städning av det som redan ligger i cachen: kör man från
   * Västerås till Örebro ska Västeråsmeddelandena inte bli kvar på skärmen
   * fram till nästa fulla hämtning.
   *
   * Meddelanden UTAN områdeskod passerar alltid. Den som skrev utan GPS ska
   * höras, inte tystas.
   */
  meddelanden(nu = Date.now()) {
    const grans = nu - this.granser.gallringDygn * 86400000;
    const koder = this.omradeKoder;
    const nara = koder ? new Set(koder) : null;
    return [...this.meddelandenMap.values()]
      .filter(m => (m.skapadAt || 0) >= grans)
      .filter(m => !nara || !m.omrade || nara.has(m.omrade))
      .filter(m => !this.tystade.has(m.avsandarnyckel))
      .sort((a, b) => a.skapadAt - b.skapadAt);
  }

  /** Allt, även tystat. För en "visa dolda"-knapp. */
  allaMeddelanden() {
    return [...this.meddelandenMap.values()].sort((a, b) => a.skapadAt - b.skapadAt);
  }

  arTystad(nyckel) { return this.tystade.has(nyckel); }
  arAnmald(id) { return this.anmalda.has(id); }

  /* ---- Skrivning ---------------------------------------------------- */

  /**
   * Skicka ett meddelande.
   * @returns {Promise<{ok:boolean, skal?:string, meddelande?:string, id?:string}>}
   */
  async skicka(text, nu = Date.now()) {
    const dom = this.provaSkicka(text, nu);
    if (!dom.ok) {
      this.#emit('blockerat', dom);
      return dom;
    }

    const m = {
      id: uid(),
      text: String(text).trim(),
      visningsnamn: this.#mittNamn(),
      avsandarnyckel: 'jag',      // servern ger den riktiga nyckeln vid hämtning
      mitt: true,
      // Rutan, aldrig positionen. Är den null blir meddelandet "utan område"
      // och når alla — det är bättre än att skrivas ut i tomma intet.
      omrade: this.rutkod,
      utanOmrade: !this.rutkod,
      skapadAt: nu,
      status: this.harBackend ? 'kö' : 'lokalt',
    };

    this.meddelandenMap.set(m.id, m);
    this.egnaTider = [...this.egnaTider, nu].filter(t => nu - t < 3600000).slice(-200);
    skrivJSON(this.#nyckel('tider'), this.egnaTider);
    this.#spara();
    this.#emit('meddelanden');

    if (!this.harBackend) return { ok: true, id: m.id };

    if (!this.online) { this.#koa({ op: 'skicka', m }); return { ok: true, id: m.id }; }
    try {
      await this.#sand({ op: 'skicka', m });
      m.status = 'skickat';
      this.#spara();
      this.#emit('meddelanden');
    } catch (e) {
      // Databasen har samma spärrar som klienten. Blir vi stoppade där är
      // det inte ett nätverksfel och ska inte köas om i all evighet — då
      // skulle en spärrad rad ligga och slå i väggen varje gång vi kommer
      // online. Ta bort bubblan och säg till istället.
      if (e.avvisad) {
        this.meddelandenMap.delete(m.id);
        this.#spara();
        this.#emit('meddelanden');
        const svar = { ok: false, skal: e.skal || 'avvisad', meddelande: e.message };
        this.#emit('blockerat', svar);
        return svar;
      }
      this.#koa({ op: 'skicka', m });
      m.status = 'kö';
      this.#emit('meddelanden');
    }
    return { ok: true, id: m.id };
  }

  /**
   * Radera ett eget meddelande.
   *
   * Andras går inte att röra — varken här eller i databasen, där
   * raderingspolicyn kräver att raden tillhör den inloggade. Klientkollen
   * finns för att kunna ge ett begripligt svar utan en nätverksrunda, inte
   * som skydd. Skyddet ligger i RLS.
   */
  async radera(id) {
    const m = this.meddelandenMap.get(id);
    if (!m) return { ok: false, skal: 'saknas', meddelande: 'Meddelandet finns inte.' };
    if (!m.mitt) {
      return {
        ok: false, skal: 'inte_mitt',
        meddelande: 'Du kan bara radera dina egna meddelanden. Anmäl eller tysta istället.',
      };
    }

    this.meddelandenMap.delete(id);
    this.#spara();
    this.#emit('meddelanden');

    if (!this.harBackend) return { ok: true };
    // Utloggad räknas som offline här: anropet kan bara ge 401, och köandet
    // gör redan rätt sak med ett anrop som inte går fram just nu.
    if (!this.online || !this.inloggad) { this.#koa({ op: 'radera', id }); return { ok: true }; }
    try { await this.#sand({ op: 'radera', id }); }
    catch { this.#koa({ op: 'radera', id }); }
    return { ok: true };
  }

  /**
   * Anmäl ett meddelande. Anmälningar går till en tabell ingen klient kan
   * läsa — annars blir listan över anmälda en anslagstavla i sig.
   */
  async anmal(id, skal = '') {
    const m = this.meddelandenMap.get(id);
    if (!m) return { ok: false };
    this.anmalda.add(id);
    skrivJSON(this.#nyckel('anmalda'), [...this.anmalda].slice(-300));
    this.#emit('meddelanden');

    if (!this.harBackend) return { ok: true };
    // Samma sak som i radera(): utan inloggning finns ingen väg fram, och en
    // anmälan är för viktig för att tappas — den ligger kvar i kön.
    if (!this.online || !this.inloggad) { this.#koa({ op: 'anmal', id, skal }); return { ok: true }; }
    try { await this.#sand({ op: 'anmal', id, skal }); }
    catch { this.#koa({ op: 'anmal', id, skal }); }
    return { ok: true };
  }

  /**
   * Tysta en avsändare på den här enheten.
   *
   * Lokalt med flit. En global blockering kräver att någon bedömer vem som
   * har rätt, och det finns ingen sådan någon. Att slippa se någon är ett
   * beslut var och en får ta för egen del — och det verkar direkt, utan att
   * vänta på moderering.
   */
  tysta(nyckel) {
    if (!nyckel) return;
    this.tystade.add(nyckel);
    skrivJSON(this.#nyckel('tystade'), [...this.tystade]);
    this.#emit('meddelanden');
  }

  avtysta(nyckel) {
    this.tystade.delete(nyckel);
    skrivJSON(this.#nyckel('tystade'), [...this.tystade]);
    this.#emit('meddelanden');
  }

  /** Tysta den som skrev ett visst meddelande. */
  tystaAvsandarenFor(id) {
    const m = this.meddelandenMap.get(id);
    if (m && !m.mitt) this.tysta(m.avsandarnyckel);
    return !!m;
  }

  /* ---- Synk --------------------------------------------------------- */

  async hamta() {
    // Lokal gallring gäller även utan server, annars växer cachen för alltid.
    const grans = Date.now() - this.granser.gallringDygn * 86400000;
    let stadat = false;
    for (const [id, m] of this.meddelandenMap) {
      if ((m.skapadAt || 0) < grans) { this.meddelandenMap.delete(id); stadat = true; }
    }
    if (stadat) { this.#spara(); this.#emit('meddelanden'); }

    if (!this.harBackend || !this.online) return;

    /*
     * Utloggad: fråga inte.
     *
     * Vyn chatt_flode är utdelad till authenticated och till ingen annan, så
     * anropet kan bara sluta på ett sätt — 401. Att skicka det ändå gav ett
     * rött fel i konsolen vid varje sidladdning och sedan var åttonde sekund
     * så länge appen stod öppen, för ingenting: svaret var känt innan frågan
     * ställdes. Ett känt 401 i konsolen är dessutom värre än inget, för det
     * ser ut som en trasig behörighet och drar felsökning till fel ställe.
     *
     * Skälet visas i stället i gränssnittet, via lasSparr. Det här är inget
     * synkfel — servern gör precis det den ska — så synkFel nollställs hellre
     * än sätts. Annars hade det stått "ingen kontakt med servern" om en
     * server som mår bra.
     */
    if (!this.inloggad) {
      if (this.synkFel !== null) { this.synkFel = null; this.#emit('status'); }
      return;
    }

    // Var tionde hämtning tas hela fönstret om. Inkrementell hämtning ser
    // bara nya rader — den som raderat sitt meddelande skulle annars ligga
    // kvar på alla andras skärmar tills appen startades om. Ett rutbyte
    // tvingar också fram en full hämtning; den nya traktens äldre meddelanden
    // finns inte i cachen och kommer aldrig med i en inkrementell fråga.
    const tur = (this._pollRakning++ % this.granser.fullHamtningVar) === 0;
    const full = tur || this._nyRuta;
    this._nyRuta = false;
    const senaste = full ? 0 : this.#senasteTid();

    const filter = senaste ? `&skapad_at=gt.${encodeURIComponent(new Date(senaste).toISOString())}` : '';
    const url = `${this.cfg.url}/rest/v1/chatt_flode` +
      `?select=*&order=skapad_at.desc&limit=${this.granser.hamtaAntal}` +
      `${this.#omradeFilter()}${filter}`;

    try {
      const r = await fetch(url, { headers: apiHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rader = await r.json();

      this.mottaRader(rader, { full });
      this.senasteSynk = Date.now();
      /*
       * Nollställningen måste också ut på skärmen.
       *
       * Tidigare sattes synkFel till null här utan att någon händelse gick
       * iväg, så en felruta från en enda misslyckad hämtning stod kvar för
       * alltid — även när chatten hämtade utan problem sekunden efter. Det
       * såg ut som att appen var trasig när den redan lagat sig.
       */
      const hadeFel = this.synkFel !== null;
      this.synkFel = null;
      if (hadeFel) this.#emit('status');
    } catch (e) {
      this.synkFel = this.#synkfelText(e);
      this.#emit('status');
    }
    this.tommKo();
  }

  /**
   * Frågedelen som gör hämtningen till en trakt istället för ett land.
   *
   * Filtret sätts på SERVERN, inte här. Att hämta hela landet och sålla
   * lokalt hade betytt att varje pollning drar hem meddelanden från Malmö
   * till Kiruna över mobildata som föraren betalar för, var åttonde sekund.
   *
   * "eller utan områdeskod" måste vara med. Utan den delen försvinner varje
   * meddelande från någon utan GPS-läsning ur allas flöden, och den som
   * skrev får aldrig veta varför ingen svarar.
   *
   * Utan egen ruta: inget filter alls. Vet vi inte var vi är kan vi inte
   * påstå att något inte angår oss.
   */
  #omradeFilter() {
    const koder = this.omradeKoder;
    if (!koder) return '';
    // Koderna innehåller bara r, x, siffror och minus. Ingenting som behöver
    // kodas om, och ingenting som kan bryta sig ut ur frågan — RUTA_MONSTER
    // har redan avvisat allt annat innan koden hamnade i this.rutkod.
    return `&or=(omrade.in.(${koder.join(',')}),omrade.is.null)`;
  }

  /**
   * Översätt ett nätverksfel till något en förare kan agera på.
   *
   * "Ingen kontakt med servern: HTTP 401" säger ingenting till den som ser
   * det. 401 betyder här en enda sak numera: sessionen dög inte. Utloggad
   * frågar vi inte ens (se hamta), så ett 401 hit betyder att en inloggning
   * som fanns har gått ut — och det är något föraren kan göra något åt.
   *
   * Grenen för utloggad står kvar ändå. Den kostar en rad och täcker
   * ögonblicket då sessionen försvinner mitt under ett anrop som redan är
   * på väg.
   */
  #synkfelText(e) {
    const m = String(e?.message || '');
    if (m.includes('401') || m.includes('403')) {
      return this.inloggad
        ? 'Inloggningen har gått ut. Logga in igen för att se chatten.'
        : 'Logga in för att se chatten.';
    }
    if (m.includes('404')) return 'Chatten är inte påslagen på servern än.';
    if (m.includes('Failed to fetch')) return 'Ingen internetanslutning.';
    return 'Ingen kontakt med servern just nu.';
  }

  /**
   * Ta emot rader från servern (eller från ett test).
   *
   * Ligger separat från hämtningen så att tolkningen av en serverrad går att
   * kontrollera utan nätverk — det var precis den skarven som brast förra
   * gången ett fält lades till, och felet såg då ut som en trasig app.
   *
   * @param {Array} rader rader ur vyn chatt_flode
   * @param {{full?:boolean}} opt full = hela fönstret hämtat, bygg om listan
   */
  mottaRader(rader, opt = {}) {
    if (opt.full) {
      // Behåll det som ännu inte nått servern, kasta resten och bygg om.
      const okoat = [...this.meddelandenMap.values()].filter(m => m.status === 'kö');
      this.meddelandenMap.clear();
      for (const m of okoat) this.meddelandenMap.set(m.id, m);
    }
    for (const rad of rader || []) {
      const m = this.#franRad(rad);
      if (m.id) this.meddelandenMap.set(m.id, m);
    }
    this.#spara();
    this.#emit('meddelanden');
  }

  #senasteTid() {
    let t = 0;
    for (const m of this.meddelandenMap.values()) {
      if (m.status === 'kö') continue;          // inte serverns tid
      if (m.skapadAt > t) t = m.skapadAt;
    }
    return t;
  }

  #franRad(rad) {
    // Bara koden tas emot. Skulle servern någon gång börja skicka
    // koordinater plockas de aldrig upp här, och kan alltså inte råka hamna
    // i cachen i localStorage.
    const omrade = arRutkod(rad.omrade) ? rad.omrade : null;
    return {
      id: rad.id,
      text: rad.text || '',
      visningsnamn: rad.visningsnamn || 'Förare',
      avsandarnyckel: rad.avsandarnyckel || '',
      omrade,
      utanOmrade: !omrade,
      mitt: !!rad.mitt,
      skapadAt: typeof rad.skapad_at === 'number' ? rad.skapad_at : Date.parse(rad.skapad_at),
      status: 'skickat',
    };
  }

  #mittNamn() {
    const n = stadaNamn(this.cfg.visningsnamn);
    return n || neutraltNamn(this.cfg.identitet || '');
  }

  #koa(jobb) {
    const k = lasJSON(this.#nyckel('ko'), []);
    k.push(jobb);
    skrivJSON(this.#nyckel('ko'), k.slice(-50));
  }

  async tommKo() {
    if (!this.harBackend || !this.online) return;
    /*
     * Samma sak som i hamta(): utan inloggning kan ingenting i kön gå fram,
     * och varje försök blir ett 401 i konsolen. Kön ligger kvar orörd — den
     * som skrev något precis innan sessionen gick ut ska få det skickat när
     * hen loggat in igen, inte tappa det tyst.
     */
    if (!this.inloggad) return;
    const k = lasJSON(this.#nyckel('ko'), []);
    if (!k.length) return;
    const kvar = [];
    for (const jobb of k) {
      try { await this.#sand(jobb); }
      catch (e) { if (!e.avvisad) kvar.push(jobb); }
    }
    skrivJSON(this.#nyckel('ko'), kvar);
  }

  async #sand(jobb) {
    const bas = `${this.cfg.url}/rest/v1`;
    const huvud = { ...apiHeaders(), 'Content-Type': 'application/json' };

    if (jobb.op === 'skicka') {
      const r = await fetch(`${bas}/chatt_meddelanden`, {
        method: 'POST',
        headers: { ...huvud, Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: jobb.m.id,
          avsandare: this.cfg.identitet,
          text: jobb.m.text,
          visningsnamn: jobb.m.visningsnamn,
          // Rutan, och ingenting mer. Servern normaliserar om koden ändå
          // (chatt-omrade.sql) — det som skickas härifrån är ett förslag,
          // inte något databasen litar blint på.
          omrade: jobb.m.omrade ?? null,
        }),
      });
      if (!r.ok) throw await this.#fel(r);
      return;
    }

    if (jobb.op === 'radera') {
      const r = await fetch(`${bas}/chatt_meddelanden?id=eq.${encodeURIComponent(jobb.id)}`, {
        method: 'DELETE',
        headers: { ...huvud, Prefer: 'return=minimal' },
      });
      if (!r.ok) throw await this.#fel(r);
      return;
    }

    if (jobb.op === 'anmal') {
      const r = await fetch(`${bas}/chatt_anmalningar`, {
        method: 'POST',
        headers: { ...huvud, Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({
          meddelande_id: jobb.id,
          anmalare: this.cfg.identitet,
          skal: String(jobb.skal || '').slice(0, 200),
        }),
      });
      if (!r.ok) throw await this.#fel(r);
    }
  }

  /**
   * Översätt ett svar från PostgREST till något en förare förstår.
   *
   * Databasen har egna spärrar för nykterhetsinnehåll och skrivtakt. Blir vi
   * stoppade där är det ett besked, inte ett avbrott — markera det som
   * "avvisad" så köandet inte försöker igen i all evighet.
   */
  async #fel(r) {
    let kropp = '';
    try { kropp = await r.text(); } catch {}
    const l = kropp.toLowerCase();
    const e = new Error('Kunde inte skicka. Försök igen.');
    e.status = r.status;

    if (l.includes('chatt_nykterhet')) {
      e.avvisad = true; e.skal = 'nykterhet'; e.message = SKAL_TEXT.nykterhet;
    } else if (l.includes('chatt_for_snabbt')) {
      e.avvisad = true; e.skal = 'for_tatt'; e.message = SKAL_TEXT.for_tatt;
    } else if (l.includes('chatt_for_manga')) {
      e.avvisad = true; e.skal = 'for_manga'; e.message = SKAL_TEXT.for_manga;
    } else if (r.status === 401 || r.status === 403) {
      e.avvisad = true; e.skal = 'inte_inloggad'; e.message = SKAL_TEXT.inte_inloggad;
    }
    return e;
  }

  #spara() {
    const senaste = this.allaMeddelanden().slice(-this.granser.hamtaAntal);
    skrivJSON(this.#nyckel('cache'), senaste);
  }

  #emit(namn, detalj) {
    this.dispatchEvent(new CustomEvent(namn, { detail: detalj }));
  }
}

export default Chatt;
