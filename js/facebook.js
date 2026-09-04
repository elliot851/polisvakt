// Facebook-gruppen "Här står polisen" -> riktiga varningar på kartan.
//
// Det här är mottagarsidan. Bryggorna (userscriptet i tools/fb-bridge.user.js
// eller Telegram-spegeln i tools/telegram-bridge.md) levererar rå text hit,
// och den här modulen bestämmer vad som faktiskt blir en varning.
//
// Tre saker styr designen:
//
//   Parsern äger reglerna. Ingenting tolkas om här. parseReportText() är samma
//   funktion som rösten använder, så en regel som ändras där gäller direkt för
//   gruppen också. Det är hela poängen med att inte kopiera ordlistor.
//
//   Fel ska tas här, inte på kartan. Ett Facebook-inlägg är en främlings
//   snabba mening, inte ett formulär. Allt som inte går att geokoda, är för
//   svagt tolkat eller för gammalt kastas — en falsk varning är värre än ingen
//   varning alls, eftersom föraren slutar lita på appen efter två sådana.
//
//   Samma inlägg får aldrig bli två varningar. Gruppens flöde läses om och om
//   igen, och samma text dyker upp igen när någon kommenterar. Dedupen sitter
//   både lokalt (så vi inte ens frågar servern) och i databasen (unikt
//   external_id), eftersom den lokala minneslistan försvinner vid ny enhet.

import { parseReportText } from './parser.js';
import { geocode } from './geocode.js';
// Visningstiden, inte trovärdighetstiden: expires_at svarar bara på om
// rapporten ska synas. Se store.js VISNING_MINUTER för varför de två är
// skilda tal sedan varningarna ligger kvar i fyra timmar.
import { visningMinuter } from './store.js';
import { CONFIG, apiHeaders, hasBackend } from './config.js';
import { normalize, uid, clamp } from './util.js';
// Samma gissning som Telegram-bryggan gör. Lånad, inte kopierad: två
// ordlistor som ska betyda samma sak glider isär första gången någon lägger
// till "avfart" på det ena stället.
import { gissaGeokodTyp } from './telegram.js';

const SEEN_KEY = 'pv.fb.seen.v2';

/** Under 0,65 är tolkningen en gissning. Gissningar hör inte hemma på kartan. */
const MIN_CONFIDENCE = 0.65;

/**
 * Hur länge ett textinlägg räknas som samma inlägg.
 *
 * Har bryggan ett riktigt inläggs-id används det, och då behövs ingen tid alls.
 * Saknas id har vi bara texten, och "polis vid Erikslund" är samma varning i
 * eftermiddag men en ny varning nästa vecka. Fönstret är därför längre än en
 * rapports livslängd men mycket kortare än ett dygn.
 */
const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Enhets-id för allt som kommer från gruppen. Syns i databasen, inte i appen. */
const BRIDGE_DEVICE = 'fb-bridge';

/* ---- Lokal minneslista ------------------------------------------------ */

function loadSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; }
}

function saveSeen(seen) {
  // Håll listan kort. Gamla nycklar skyddar ingenting — de inläggen är sedan
  // länge borta ur flödet, och databasens unika external_id är sista spärren.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const rows = Object.entries(seen)
    .filter(([, t]) => t > cutoff)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2000);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(rows))); } catch {}
}

/** Glöm allt vi sett. Bara för felsökning — nästa körning skickar om allt. */
export function forgetSeen() {
  try { localStorage.removeItem(SEEN_KEY); } catch {}
}

/* ---- Nycklar ---------------------------------------------------------- */

/**
 * FNV-1a, 32 bitar. Samma funktion finns i userscriptet och i Telegram-
 * skriptet, med flit: alla tre måste räkna fram identiskt external_id för
 * samma text, annars blir samma inlägg två rapporter när man byter brygga.
 */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * @returns {{ stable:string, externalId:string }}
 *   stable     — nyckel i den lokala minneslistan, oberoende av tidsfönster
 *   externalId — unikt i databasen, får återanvändas först nästa fönster
 */
export function keysFor(post, now = Date.now()) {
  const id = post.id ? String(post.id).slice(0, 64) : null;
  if (id) return { stable: 'id:' + id, externalId: 'fb:' + id };
  const h = hash(normalize(post.text || ''));
  const bucket = Math.floor(now / DEDUP_WINDOW_MS).toString(36);
  return { stable: 'tx:' + h, externalId: `fb:${h}:${bucket}` };
}

/* ---- Rapportraden ----------------------------------------------------- */

/**
 * Färdig rad till public.reports.
 *
 * Bruten ur run() med flit: raden är det enda i hela bryggan som är värt att
 * testa utan nät, och den var tidigare inbakad mitt i en loop med fetch i.
 * Telegram-bryggan har samma funktion under samma namn, av samma skäl.
 *
 * @param {{type:string, place:string, confidence:number}} parsed  svar från parseReportText
 * @param {{lat:number, lon:number, label?:string, source?:string, typ?:string}} hit
 *        geokodningens träff
 * @param {{ text?:string, deviceId?:string, externalId?:string,
 *           createdAt?:number, expiresAt?:number, nu?:number, id?:string }} [val]
 */
export function byggRapport(parsed, hit, val = {}) {
  const {
    text = '', deviceId = BRIDGE_DEVICE, externalId = null,
    createdAt = Date.now(), nu = Date.now(), id = uid(),
  } = val;
  const ttlMs = visningMinuter(parsed.type) * 60000;
  const expiresAt = val.expiresAt ?? createdAt + ttlMs;

  const row = {
    id,
    type: parsed.type,
    lat: hit.lat,
    lon: hit.lon,
    label: String(hit.label || parsed.place).slice(0, 120),
    note: String(text).trim().slice(0, 240),
    source: 'facebook',
    device_id: deviceId,
    external_id: externalId,
    created_at: createdAt,
    expires_at: expiresAt,
    confirms: 1,
    denials: 0,

    // Kvalitetsfälten, se supabase/kvalitetsfalt.sql och js/kvalitet.js.
    //
    // Utan dem antar graderaren det värsta: geokod 'okand' ger −0,15 i poäng
    // och 1 200 m antagen radie, vilket ligger precis vid gränsen där en
    // rapport hedgas bort eller tystas helt. Ett inlägg som kommer in hit ska
    // graderas försiktigare än en knapptryckning i bilen — det är
    // andrahandsuppgifter, och BAS_KALLA sätter 0,42 mot appens 0,62 — men
    // det ska ske på verklig data, inte på att fälten saknas.
    parser_confidence: Number(Number(parsed.confidence).toFixed(3)),

    // Mätt fördröjning mellan att inlägget skrevs och att bryggan läste det.
    // Ett GOLV, inte sanningen: tiden från att bilen sågs till att någon skrev
    // om den går inte att veta. Men ett mätt golv är ärligare än
    // kvalitetslagrets antagande.
    fordrojning_s: Math.round(clamp((nu - createdAt) / 1000, 0, 86400)),

    // geocode() svarar 'learned' | 'cache' | 'nominatim' — exakt de nycklar
    // GEOKOD_DELTA i kvalitet.js är byggd för. Fältet är konstruerat för att
    // bära just det värdet.
    geokod: hit.source || 'okand',
    geokod_typ: gissaGeokodTyp(parsed.place, hit),

    // Radien MÄTT ur OSM-svaret när svaret bar en mätning, annars null så att
    // kvalitet.js får räkna fram den ur geokod_typ. Se radieFranSvar() i
    // js/geocode.js för varför boundingboxen bara får BREDDA och aldrig smalna
    // av — en nod får en påhittad ruta och en väg får bara sitt eget avsnitt.
    geokod_radius_m: Number.isFinite(hit?.radieM) ? hit.radieM : null,

    // De två nedan är null med flit. NULL betyder "vet inte" och ska aldrig
    // tolkas som noll: vi vet ingenting om skribentens GPS eller fart, och en
    // nolla där hade sagt "perfekt noggrannhet, stillastående".
    gps_accuracy_m: null,
    fart_kmh: null,
  };

  // PostgREST avvisar hela insertet om en kolumn inte finns än, och en varning
  // på kartan är viktigare än metadatan om den. Ett null bär dessutom ingen
  // information — kolumnen blir NULL ändå om den utelämnas.
  for (const k of Object.keys(row)) if (row[k] == null) delete row[k];
  return row;
}

/* ---- Skrivning -------------------------------------------------------- */

/**
 * Lägger raden i reports. on_conflict + ignore-duplicates gör att en dubblett
 * blir en tyst nullpost istället för ett fel — och eftersom vi ber om raden
 * tillbaka kan vi ändå se skillnad: tom array betyder "fanns redan".
 *
 * Notera att vi skriver direkt mot REST istället för via store.add(). Store
 * känner inte till external_id, och utan external_id finns ingen dedup alls
 * på serversidan.
 */
async function insertReport(row) {
  const url = `${CONFIG.supabaseUrl}/rest/v1/reports?on_conflict=external_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...apiHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

/* ---- Publikt API ------------------------------------------------------ */

/**
 * @typedef {Object} FacebookPost
 * @property {string}  text      inläggets text
 * @property {string} [id]       Facebooks inläggs-id, om bryggan hittade det
 * @property {number} [postedAt] millisekunder sedan epoch, när det skrevs
 * @property {string} [url]      permalänk, sparas inte men bra vid felsökning
 */

/**
 * Kör en omgång inlägg genom parser, geokodning och skrivning.
 *
 * @param {FacebookPost|string|Array<FacebookPost|string>} posts
 * @param {{ dryRun?:boolean, minConfidence?:number, deviceId?:string,
 *           now?:number }} [options]
 * @returns {Promise<Object>} sammanfattning, se summaryText()
 */
export async function ingest(posts, options = {}) {
  const {
    dryRun = false,
    minConfidence = MIN_CONFIDENCE,
    deviceId = BRIDGE_DEVICE,
    now = Date.now(),
  } = options;

  const items = (Array.isArray(posts) ? posts : [posts])
    .map(p => (typeof p === 'string' ? { text: p } : p))
    .filter(p => p && typeof p.text === 'string' && p.text.trim());

  const summary = {
    dryRun,
    scanned: items.length,
    created: 0,
    duplicates: 0,
    skipped: {
      sobriety: 0,       // nykterhets- och drogkontroller, se parser.js
      camera: 0,         // fartkameror, finns redan inlagda med rätt position
      unparsed: 0,       // ingen typ hittad — brus, frågor, skvaller
      clear: 0,          // "polisen är borta", går inte att koppla till en rapport
      lowConfidence: 0,
      noPlace: 0,
      notFound: 0,       // platsen gick inte att geokoda
      stale: 0,          // inlägget är äldre än varningen skulle leva
      failed: 0,         // nätverks- eller databasfel
    },
    reports: [],         // det som skapades (eller skulle skapats vid dryRun)
    unknownPlaces: [],   // platser att lära appen, se geocode.learnPlace()
    errors: [],
  };

  if (!dryRun && !hasBackend()) {
    summary.errors.push('Supabase är inte konfigurerad — inget skickades.');
    return summary;
  }

  const seen = loadSeen();
  let seenChanged = false;

  // En torrkörning ska kunna köras om och ge exakt samma svar. Skriver den i
  // minneslistan blir andra körningen tom, och då är funktionen oanvändbar för
  // det den finns till: att se vad som *skulle* hända innan man släpper på.
  const remember = key => { if (!dryRun) { seen[key] = now; seenChanged = true; } };

  for (const post of items) {
   try {
    const { stable, externalId } = keysFor(post, now);
    if (seen[stable]) { summary.duplicates++; continue; }

    // platsKonvention: gruppens om-sida säger "Man skriver enbart när man ser
    // en poliskontroll", så ett kort inlägg som bara pekar ut en känd plats
    // betyder polis där. Flaggan sätts BARA här och i de andra grupp-
    // kanalerna — rösten och knapparna har ingen sådan konvention.
    const parsed = parseReportText(post.text, { platsKonvention: true });

    // Nykterhetskontroller och fartkameror kastas tyst. Ingen rapport, ingen
    // notis, ingenting sparat av texten — inte ens i sammanfattningen. Regeln
    // sitter i parsern och gäller därför rösten, knapparna och gruppen lika.
    if (parsed?.intent === 'refused') {
      summary.skipped[parsed.reason === 'sobriety' ? 'sobriety' : 'camera']++;
      remember(stable);
      continue;
    }

    if (!parsed) {
      summary.skipped.unparsed++;
      remember(stable);
      continue;
    }

    // "Nu är dom borta" är sann information, men vi vet inte vilken rapport
    // den gäller. Att gissa och släcka fel varning är värre än att låta den
    // löpa ut av sig själv om en halvtimme.
    if (parsed.intent === 'clear') {
      summary.skipped.clear++;
      remember(stable);
      continue;
    }

    if (parsed.confidence < minConfidence) {
      summary.skipped.lowConfidence++;
      remember(stable);
      continue;
    }

    if (!parsed.place) {
      summary.skipped.noPlace++;
      remember(stable);
      continue;
    }

    // En varning som redan hunnit löpa ut ska aldrig läggas ut. Inlägget kan
    // ha legat i flödet i timmar innan bryggan såg det.
    //
    // Grinden är visningstiden, alltså fyra timmar. Ett tre timmar gammalt
    // inlägg läggs numera ut — men det kommer in som det det är: blek nål,
    // "Troligen inte kvar" i texten, ingen uppläsning och ingen notis
    // (åldersgrinden i js/app.js räknar på trovärdighetstiden och släpper
    // inte igenom det). Att i stället tysta det helt hade betytt att kartan
    // saknade det som faktiskt hänt under dagen.
    const ttlMs = visningMinuter(parsed.type) * 60000;
    const createdAt = Number.isFinite(post.postedAt) ? Math.min(post.postedAt, now) : now;
    const expiresAt = createdAt + ttlMs;
    if (expiresAt <= now + 60000) {
      summary.skipped.stale++;
      remember(stable);
      continue;
    }

    let hit;
    try {
      hit = await geocode(parsed.place);
    } catch (e) {
      summary.skipped.failed++;
      summary.errors.push(`Geokodning av "${parsed.place}" misslyckades: ${e.message}`);
      continue;   // ingen minnesmarkering: nätverksfel ska få försöka igen
    }

    if (!hit) {
      summary.skipped.notFound++;
      if (!summary.unknownPlaces.includes(parsed.place)) summary.unknownPlaces.push(parsed.place);
      remember(stable);
      continue;
    }

    const row = byggRapport(parsed, hit, {
      text: post.text, deviceId, externalId, createdAt, expiresAt, nu: now,
    });

    if (dryRun) {
      summary.reports.push({ ...row, place: parsed.place, confidence: parsed.confidence });
      summary.created++;
      continue;   // torrkörning får inte lämna spår i minneslistan
    }

    try {
      const inserted = await insertReport(row);
      remember(stable);
      if (inserted) {
        summary.created++;
        summary.reports.push({ ...row, place: parsed.place, confidence: parsed.confidence });
      } else {
        summary.duplicates++;
      }
    } catch (e) {
      summary.skipped.failed++;
      summary.errors.push(`Kunde inte spara "${row.label}": ${e.message}`);
      // Ingen minnesmarkering här heller — nästa körning får ta om den.
    }
   } catch (postFel) {
     // Ett enda trasigt inlägg (t.ex. en text som får parsern att kasta) fick
     // förr hela ingest() att avvisa och tappa ALLA återstående inlägg i
     // svepet. Felet tas nu per inlägg — modulens uttalade mål är "Fel ska tas
     // här, inte på kartan". Kom ihåg posten så samma gift inte körs varje
     // svep; en parse-/byggkrasch är deterministisk för samma text.
     summary.skipped.failed++;
     summary.errors.push(`Inlägg kunde inte behandlas: ${postFel.message}`);
     try { remember(keysFor(post, now).stable); } catch { /* nyckeln gick inte att bilda */ }
   }
  }

  if (seenChanged) saveSeen(seen);
  return summary;
}

/** En rad på svenska att logga eller visa i en admin-vy. */
export function summaryText(s) {
  const bort = Object.values(s.skipped).reduce((a, b) => a + b, 0);
  const delar = [
    `${s.scanned} inlägg`,
    `${s.created} ${s.created === 1 ? 'varning' : 'varningar'}${s.dryRun ? ' (torrkörning)' : ''}`,
  ];
  if (s.duplicates) delar.push(`${s.duplicates} redan inne`);
  if (bort) delar.push(`${bort} bortsorterade`);
  if (s.unknownPlaces.length) delar.push(`okänd plats: ${s.unknownPlaces.join(', ')}`);
  return delar.join(' · ');
}

export { MIN_CONFIDENCE, DEDUP_WINDOW_MS, BRIDGE_DEVICE };
