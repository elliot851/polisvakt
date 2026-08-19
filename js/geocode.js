// Platsnamn -> koordinater.
//
// Kedjan: inlärda alias -> medföljande aliaslista -> Nominatim (OSM), alltid
// begränsad till Västmanland. Allt cachas i localStorage så samma plats bara
// slås upp en gång. Misslyckas allt hamnar platsen i en "lär mig"-kö där
// föraren pekar ut den på kartan en enda gång — sedan sitter den för alltid.
//
// Två slags uppslagning bor här, och de har olika räckvidd med flit:
//
//   geocode()      Rapportplatser. Låst till Västmanland (bounded=1). En
//                  röstrapport om "polis vid rondellen" ska aldrig kunna
//                  landa i Skåne.
//   searchPlaces() Resmål för ruttläget. Hela Sverige, men viktat mot
//                  föraren — "Drottninggatan" finns i ett femtiotal svenska
//                  städer och den i närheten är nästan alltid den rätta.
//
// ---------------------------------------------------------------------------
// Nominatims användarvillkor (operations.osmfoundation.org/policies/nominatim)
//
// Tjänsten är gratis och drivs av donerade servrar. Villkoren är korta och
// hårda, och appen håller dem så här:
//
//   Max 1 anrop/sekund     En enda kö i den här filen serialiserar ALLA anrop
//                          — sökning, rapportgeokodning och omvänd
//                          uppslagning. Se nominatimSlot(). Kön är avsiktligt
//                          global: två moduler som var för sig håller en
//                          anrop/sekund bryter tillsammans mot gränsen.
//   Identifiering krävs    Webbläsare tillåter inte att JavaScript sätter
//                          User-Agent. Identifieringen sker därför via
//                          Referer, som webbläsaren själv skickar med appens
//                          adress. Det är den andra av de två godkända
//                          vägarna i villkoren. Egna huvuden läggs medvetet
//                          INTE på — de skulle utlösa en CORS-preflight som
//                          Nominatim inte svarar på.
//   Cachning krävs         Varje svar sparas i localStorage. Villkoren säger
//                          rakt ut att den som skickar samma fråga om och om
//                          igen kan bli blockerad.
//   Autocomplete förbjudet Sökning medan man skriver är uttryckligen otillåten.
//                          Därför finns localSuggestions(), som svarar direkt
//                          ur cachen och de inlärda platserna utan att röra
//                          nätet, och searchPlaces() som bara får anropas när
//                          föraren faktiskt trycker på sök. searchPlaces har
//                          dessutom en egen spärr som vägrar skicka samma
//                          fråga två gånger och aldrig oftare än var 1,5:e
//                          sekund, som skydd mot att någon ändå kopplar den
//                          till ett oninput.

import { normalize, distance } from './util.js';

const CACHE_KEY = 'pv.geocache.v1';
const LEARNED_KEY = 'pv.learned.v1';
const SEARCH_KEY = 'pv.searchcache.v1';

// Ungefärlig ruta runt Västmanland (minLon, minLat, maxLon, maxLat)
const VIEWBOX = [15.10, 59.30, 17.30, 60.30];
const CENTER = { lat: 59.6099, lon: 16.5448 };   // Västerås centrum

const REGION_RE = /västerås|västmanland|sala|köping|arboga|fagersta|hallstahammar|surahammar|skinnskatteberg|kungsör|norberg|kvicksund|irsta|dingtuna|tillberga|skultuna|hökåsen/i;

let bundled = {};
let cache = load(CACHE_KEY);
let learned = load(LEARNED_KEY);
let searchCache = load(SEARCH_KEY);
let lastCall = 0;

function load(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

export async function initGeocoder() {
  try {
    const r = await fetch('./data/aliases.vasteras.json');
    if (r.ok) bundled = await r.json();
  } catch { /* alias är valfria */ }
}

export function isLearned(place) { return !!learned[normalize(place)]; }

/** Lär appen en plats permanent (efter att föraren pekat på kartan). */
export function learnPlace(place, lat, lon, label) {
  const key = normalize(place);
  if (!key) return;
  learned[key] = { lat, lon, label: label || place, learnedAt: Date.now() };
  save(LEARNED_KEY, learned);
}

export function forgetPlace(place) {
  delete learned[normalize(place)];
  save(LEARNED_KEY, learned);
}

export function listLearned() {
  return Object.entries(learned).map(([phrase, v]) => ({ phrase, ...v }));
}

/**
 * @returns {Promise<null | {lat:number, lon:number, label:string, source:string}>}
 */
export async function geocode(place) {
  const key = normalize(place);
  if (!key) return null;

  if (learned[key]) return { ...learned[key], source: 'learned' };
  if (cache[key])   return { ...cache[key], source: 'cache' };

  // Aliaslistan mappar slang och smeknamn till en riktig sökfras
  const alias = bundled[key] || bundled[key.replace(/\s+/g, '')];
  if (alias) {
    const hit = await nominatim(alias);
    if (hit) return remember(key, hit);
  }

  // Folk skriver "björnövägen mörk volvo" eller "e18 vid avfarten mot hälla".
  // Prova hela frasen först, korta sedan bakifrån ord för ord. Sista ordet
  // ensamt provas också — ibland är det stadsdelen som bär informationen.
  const words = key.split(' ');
  const attempts = [];
  for (let n = words.length; n >= 1; n--) attempts.push(words.slice(0, n).join(' '));
  if (words.length > 1) attempts.push(words[words.length - 1]);

  for (const q of attempts) {
    if (q.length < 3) continue;
    const hit = await nominatim(bundled[q] || q);
    if (hit) return remember(key, hit);
  }
  return null;
}

function remember(key, hit) {
  cache[key] = hit;
  save(CACHE_KEY, cache);
  return { ...hit, source: 'nominatim' };
}

/**
 * Nominatim tillåter 1 anrop/sekund. Vi köar snällt.
 *
 * Det här var tidigare en enkel "vänta tills det gått en sekund sedan förra
 * anropet". Det höll inte: två anrop som startade samtidigt läste samma
 * lastCall, väntade lika länge och sköt iväg i samma millisekund. Ruttläget
 * gör flera uppslagningar efter varandra och hade utlöst precis det.
 *
 * Nu är kön en löfteskedja. Varje anropare hakar på slutet, och först när den
 * föregående släppt sin plats börjar nästa räkna sin sekund. Kön är global
 * för hela appen — det är hela poängen, gränsen gäller per klient och inte
 * per funktion.
 */
const MIN_INTERVAL_MS = 1100;
let queue = Promise.resolve();

function nominatimSlot() {
  const slot = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  });
  queue = slot.catch(() => {});      // ett fel får aldrig proppa kön
  return slot;
}

/**
 * Hämta med ett omförsök. Ett tappat paket i en tunnel ska inte betyda att
 * resmålet "inte finns" — det ser ut som ett appfel för föraren.
 */
async function fetchJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      await nominatimSlot();
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      // 429/503 = vi går för hårt fram. Backa mer än vanligt innan omförsöket.
      if (r.status === 429 || r.status === 503) {
        await new Promise(res => setTimeout(res, 2500));
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      if (i === tries - 1) return null;
      await new Promise(res => setTimeout(res, 800));
    }
  }
  return null;
}

async function nominatim(query) {
  const q = REGION_RE.test(query) ? query : query + ', Västerås';
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'se');
  url.searchParams.set('viewbox', VIEWBOX.join(','));
  url.searchParams.set('bounded', '1');
  url.searchParams.set('accept-language', 'sv');

  const rows = await fetchJSON(url);
  if (!Array.isArray(rows) || !rows.length) return null;
  const hit = rows[0];
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    label: String(hit.name || hit.display_name.split(',')[0] || query).trim(),
  };
}

/** Koordinater -> gatunamn + stadsdel. Används när man rapporterar "här". */
export async function reverseGeocode(lat, lon) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lon);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', '17');
  url.searchParams.set('accept-language', 'sv');
  const j = await fetchJSON(url);
  if (!j) return null;
  const a = j.address || {};
  const road = a.road || a.pedestrian || a.footway;
  const area = a.suburb || a.city_district || a.neighbourhood || a.town || a.village || a.city;
  if (road && area) return road + ', ' + area;
  return road || area || j.name || null;
}

/* ---- Resmålssökning för ruttläget ------------------------------------- */

// Hur nära föraren ett träff ska ligga för att räknas som "här i trakten".
// Fyra mil är ungefär en halvtimmes körning och täcker Västerås med omland.
const NEAR_M = 40000;

// Två rutor runt föraren, och de gör helt olika saker.
//
//   BIAS   Viktningsrutan. Cirka 1,2 grader latitud ≈ 13 mil åt varje håll —
//          brett nog att Stockholm ligger inom rutan för en förare i Västerås,
//          snävt nog att Malmö inte gör det. Används med bounded=0.
//   LOCAL  Den lokala rutan, satt att motsvara NEAR_M. Används med bounded=1
//          när vi letar efter gatan i FÖRARENS egen stad. Den måste vara
//          betydligt mindre än viktningsrutan — annars skulle "lokal sökning"
//          från Västerås fortfarande innehålla hela Stockholm, och hela
//          poängen faller.
const BIAS_DEG = 1.2;
const LOCAL_DEG_LAT = NEAR_M / 111320;
const LOCAL_DEG_LON = lat => NEAR_M / (111320 * Math.cos(lat * Math.PI / 180));

/**
 * Ögonblickliga förslag utan att röra nätet.
 *
 * Det här är vad ett sökfält får anropa medan föraren skriver. Nominatims
 * villkor förbjuder autocomplete rakt av, så allt som visas under skrivandet
 * måste komma härifrån: inlärda platser, den medföljande aliaslistan och
 * tidigare svar som redan ligger i cachen. Kostar noll och fungerar offline.
 *
 * @returns {Array<{lat,lon,label,detail,source}>}
 */
export function localSuggestions(query, { lat, lon, limit = 6 } = {}) {
  const key = normalize(query);
  if (key.length < 2) return [];
  const out = [];
  const seen = new Set();

  const push = (phrase, v, source) => {
    if (!v || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
    const id = `${v.lat.toFixed(4)},${v.lon.toFixed(4)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      lat: v.lat, lon: v.lon,
      label: v.label || phrase,
      detail: v.detail || '',
      source,
      distanceM: (lat != null && lon != null) ? distance(lat, lon, v.lat, v.lon) : null,
    });
  };

  for (const [phrase, v] of Object.entries(learned)) {
    if (phrase.includes(key)) push(phrase, v, 'learned');
  }
  for (const [phrase, v] of Object.entries(cache)) {
    if (phrase.includes(key)) push(phrase, v, 'cache');
  }
  for (const rows of Object.values(searchCache)) {
    for (const v of rows || []) {
      if (normalize(v.label).includes(key)) push(v.label, v, 'cache');
    }
  }
  // Närmast först — samma resonemang som i searchPlaces nedan.
  out.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  return out.slice(0, limit);
}

/**
 * Spärr mot att någon råkar koppla searchPlaces till ett oninput.
 *
 * Modulen kan inte hindra att den anropas fel, men den kan vägra skicka.
 * Samma fråga två gånger går aldrig ut på nätet (den ligger ändå i cachen),
 * och två olika frågor tätare än 1,5 sekund gör det inte heller.
 */
let lastQuery = '';
let lastQueryAt = 0;

/**
 * Sök resmål i hela Sverige, viktat mot föraren.
 *
 * FÅR BARA ANROPAS PÅ EN FAKTISK SÖKNING — knapptryck, Enter eller ett val i
 * en lista. Aldrig medan någon skriver. Se villkorsavsnittet högst upp.
 *
 * Viktningen är två saker som gör olika jobb:
 *
 *   viewbox utan bounded    Ber Nominatim föredra träffar nära föraren, men
 *                           utan att kasta bort resten. Skriver man
 *                           "Drottninggatan Stockholm" hamnar Stockholm först
 *                           ändå, för då bär frågan själv sitt svar.
 *   omsortering efteråt     Träffar inom fyra mil lyfts före resten, med
 *                           Nominatims inbördes ordning bevarad i varje grupp.
 *                           Det gör att ett ensamt "Drottninggatan" ger den i
 *                           den egna staden först, utan att någonsin kasta om
 *                           ett resultat där föraren redan varit tydlig.
 *
 * @returns {Promise<Array<{lat,lon,label,detail,kind,distanceM,near}>>}
 */
export async function searchPlaces(query, { lat, lon, limit = 6, force = false } = {}) {
  const key = normalize(query);
  if (key.length < 3) return [];

  // Cachen slår allt. Rundade koordinater i nyckeln så att småryck i GPS:en
  // inte gör varje sökning till en ny fråga.
  const bias = (lat != null && lon != null) ? `${lat.toFixed(1)},${lon.toFixed(1)}` : 'se';
  const cacheKey = `${key}@${bias}`;
  if (searchCache[cacheKey]) return rank(searchCache[cacheKey], lat, lon).slice(0, limit);

  const now = Date.now();
  if (!force) {
    if (key === lastQuery) return [];
    if (now - lastQueryAt < 1500) return [];
  }
  lastQuery = key;
  lastQueryAt = now;

  const hasPos = lat != null && lon != null;
  const box = hasPos
    ? [lon - BIAS_DEG * 2, lat - BIAS_DEG, lon + BIAS_DEG * 2, lat + BIAS_DEG].join(',')
    : null;
  const localBox = hasPos
    ? [
        lon - LOCAL_DEG_LON(lat), lat - LOCAL_DEG_LAT,
        lon + LOCAL_DEG_LON(lat), lat + LOCAL_DEG_LAT,
      ].join(',')
    : null;

  // mode: 'bias'   viewbox som viktning, resten av Sverige får vara kvar
  //       'local'  viewbox som filter, bara träffar i förarens trakt
  //       'plain'  ingen viewbox alls
  const build = mode => {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(Math.min(10, Math.max(limit, 5))));
    url.searchParams.set('countrycodes', 'se');
    url.searchParams.set('accept-language', 'sv');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('dedupe', '1');
    // Nominatim vill ha minLon,minLat,maxLon,maxLat
    if (mode === 'bias' && box) {
      url.searchParams.set('viewbox', box);
      url.searchParams.set('bounded', '0');
    } else if (mode === 'local' && localBox) {
      url.searchParams.set('viewbox', localBox);
      url.searchParams.set('bounded', '1');
    }
    return url;
  };

  let rows = await fetchJSON(build('bias'));
  // Tomt svar med viktning kan betyda att rutan i praktiken filtrerade bort
  // allt. Prova en gång till utan den innan vi säger "hittar inte".
  if ((!rows || !rows.length) && box) rows = await fetchJSON(build('plain'));
  if (!Array.isArray(rows) || !rows.length) return [];

  let hits = rows.map(shape).filter(ok);

  /**
   * Andra passet: hämta den lokala gatan när den globala rankningen dolde den.
   *
   * viewbox utan bounded är bara en knuff, och Nominatim rankar efter hur
   * "viktig" en plats är i världen. Söker en förare i Västerås på
   * "Drottninggatan" fylls hela listan därför av Stockholm — Västerås egen
   * Drottninggatan finns, men kommer inte med bland de tio första. För en
   * app som varnar i Västmanland är det nästan alltid fel svar.
   *
   * Så när inget i första passet ligger i närheten gör vi ett andra, låst
   * till rutan runt föraren, och lägger de träffarna först.
   *
   * Villkoret som skyddar mot att göra det när det vore fel: har föraren
   * SJÄLV skrivit ut orten — "Drottninggatan Stockholm" — då nämner frågan
   * en ort som redan finns i svaren, och vi rör inte ordningen. Att lyfta en
   * gata i Västerås över den i Stockholm när användaren uttryckligen bad om
   * Stockholm vore mycket värre än att ranka lite fel.
   *
   * Kostar ett extra anrop, men bara på en riktig sökning som föraren
   * startat, och kön håller ändå gränsen på ett anrop per sekund.
   */
  const anyNear = box && hits.some(h => distance(lat, lon, h.lat, h.lon) <= NEAR_M);
  const namedTheTown = hits.some(h => h.locality && key.includes(normalize(h.locality)));
  if (box && !anyNear && !namedTheTown) {
    const local = await fetchJSON(build('local'));
    if (Array.isArray(local) && local.length) {
      const localHits = local.map(shape).filter(ok);
      const seen = new Set(localHits.map(h => `${h.lat.toFixed(4)},${h.lon.toFixed(4)}`));
      hits = [...localHits, ...hits.filter(h => !seen.has(`${h.lat.toFixed(4)},${h.lon.toFixed(4)}`))];
    }
  }

  searchCache[cacheKey] = hits;
  // Håll cachen liten. Femtio sökningar räcker gott och localStorage delas
  // med rapporter och inställningar.
  const keys = Object.keys(searchCache);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete searchCache[k];
  save(SEARCH_KEY, searchCache);

  return rank(hits, lat, lon).slice(0, limit);
}

const ok = h => Number.isFinite(h.lat) && Number.isFinite(h.lon);

/** Ett Nominatim-svar till appens form. */
function shape(h) {
  const parts = String(h.display_name || '').split(',').map(s => s.trim());
  const label = String(h.name || parts[0] || '').trim();
  const a = h.address || {};
  const locality = a.city || a.town || a.village || a.municipality || a.county || '';
  // Detaljraden är resten av adressen utan land och postnummer — det är den
  // som skiljer Drottninggatan i Stockholm från den i Örebro.
  const detail = parts.slice(1)
    .filter(p => p && !/^\d{3}\s?\d{2}$/.test(p) && p !== 'Sverige')
    .slice(0, 2).join(', ');
  return {
    lat: parseFloat(h.lat),
    lon: parseFloat(h.lon),
    label,
    detail,
    locality,
    kind: h.type || h.category || '',
  };
}

/** Nära föraren först, Nominatims ordning bevarad inom varje grupp. */
function rank(hits, lat, lon) {
  const withDistance = hits.map(h => ({
    ...h,
    distanceM: (lat != null && lon != null) ? distance(lat, lon, h.lat, h.lon) : null,
    near: (lat != null && lon != null) ? distance(lat, lon, h.lat, h.lon) <= NEAR_M : false,
  }));
  const close = withDistance.filter(h => h.near);
  const far = withDistance.filter(h => !h.near);
  // Bland de nära vinner den närmaste — det är hela poängen med "gatan här".
  close.sort((a, b) => a.distanceM - b.distanceM);
  return [...close, ...far];
}

export { CENTER as VASTERAS };
