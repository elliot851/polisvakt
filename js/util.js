// Gemensamma hjälpfunktioner. Ren ESM, inga beroenden.

export const R_EARTH = 6371000;
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Avstånd i meter mellan två WGS84-punkter. */
export function distance(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Kompassbäring i grader (0-360) från punkt A mot punkt B. */
export function bearing(aLat, aLon, bLat, bLon) {
  const dLon = rad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) -
    Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Minsta vinkelskillnad mellan två bäringar, 0-180. Samma kurs ger 0. */
export function angleDiff(a, b) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180);
}

/** Klockriktning (12 = rakt fram) relativt färdriktning. Bra för uppläsning. */
export function clockDirection(heading, target) {
  const rel = ((target - heading) % 360 + 360) % 360;
  const h = Math.round(rel / 30) % 12;
  return h === 0 ? 12 : h;
}

/** "700 meter" / "1,4 kilometer" — svensk uppläsning. */
export function spokenDistance(m) {
  if (m < 950) return `${Math.max(50, Math.round(m / 50) * 50)} meter`;
  const km = m / 1000;
  const s = km < 10 ? km.toFixed(1).replace('.', ',') : String(Math.round(km));
  return `${s} kilometer`;
}

export function shortDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

/** "3 min sedan" */
export function relativeTime(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'nyss';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min sedan`;
  const h = Math.round(m / 60);
  return `${h} h sedan`;
}

export function spokenAge(ts, now = Date.now()) {
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return 'precis nu';
  if (m === 1) return 'för en minut sedan';
  if (m < 60) return `för ${m} minuter sedan`;
  return 'för över en timme sedan';
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** m/s -> km/h */
export const toKmh = ms => (ms == null ? null : Math.round(ms * 3.6));

/** Enkel debounce. */
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Normalisera svensk text för matchning: gemener, trimmad, utan skiljetecken. */
export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\wåäöéèü\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Solens upp- och nedgång för en position och ett datum.
 *
 * Klockslag duger inte för att avgöra om det är mörkt. I Västerås går solen
 * ner strax efter tre på vintern och strax före tio på sommaren — sju timmars
 * skillnad. En app som byter till mörkt läge klockan 19 är fel halva året.
 *
 * Beräkningen är NOAA:s standardalgoritm, förenklad till det vi behöver.
 * Returnerar Date-objekt, eller null under polardygn (gäller inte Sverige
 * söder om polcirkeln, men koden ska inte spricka om någon kör i Kiruna).
 */
export function sunTimes(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const dayMs = 86400000;
  const J1970 = 2440588, J2000 = 2451545;

  const toJulian = d => d.valueOf() / dayMs - 0.5 + J1970;
  const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs);

  const d = toJulian(date) - J2000;
  const n = Math.round(d - 0.0009 - -lon * rad / (2 * Math.PI));
  const ds = 0.0009 + -lon * rad / (2 * Math.PI) + n;              // ungefärlig soltid
  const M = rad * (357.5291 + 0.98560028 * ds);                    // solens medelanomali
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;                      // ekliptisk longitud
  const dTransit = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const dec = Math.asin(Math.sin(rad * 23.4397) * Math.sin(L));    // deklination

  // -0.833 grader tar hänsyn till solskivans radie och refraktion i horisonten
  const h = rad * -0.833;
  const cosH = (Math.sin(h) - Math.sin(rad * lat) * Math.sin(dec)) /
               (Math.cos(rad * lat) * Math.cos(dec));
  if (cosH > 1) return { sunrise: null, sunset: null, polar: 'night' };   // solen går aldrig upp
  if (cosH < -1) return { sunrise: null, sunset: null, polar: 'day' };    // midnattssol

  const H = Math.acos(cosH) / (2 * Math.PI);
  const setJ = J2000 + (0.0009 + ((H + -lon * rad / (2 * Math.PI)) + n)) +
               0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const riseJ = dTransit - (setJ - dTransit);

  return { sunrise: fromJulian(riseJ), sunset: fromJulian(setJ), polar: null };
}

/** Är det mörkt här och nu? Marginalen ger mörkt läge redan i skymningen. */
export function isDark(lat, lon, date = new Date(), marginMinutes = 30) {
  const { sunrise, sunset, polar } = sunTimes(lat, lon, date);
  if (polar === 'night') return true;
  if (polar === 'day') return false;
  if (!sunrise || !sunset) return date.getHours() < 7 || date.getHours() >= 19;
  const m = marginMinutes * 60000;
  return date < new Date(sunrise.getTime() + m) || date > new Date(sunset.getTime() - m);
}
