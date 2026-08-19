// Trovärdighetslager: hur säker är den här rapporten, och hur ska den sägas?
//
// En falsk varning kostar mer än en missad. Missar appen en patrull händer
// ingenting — föraren får aldrig veta att den fanns, och tystnaden kostar
// ingenting i förtroende. Varnar appen för polis på en väg där ingen polis
// står lär den istället föraren att den ljuger. Efter tre sådana slutar folk
// tro på de varningar som faktiskt stämmer, och då är hela appen värdelös.
// Felen är alltså inte symmetriska, och koden får inte behandla dem som om
// de vore det.
//
// Innan den här modulen fanns behandlades varje rapport som lika sann i
// samma sekund den kom in. Det stämmer inte med hur rapporter faktiskt blir
// fel, och nästan inget av det beror på illvilja:
//
//   * Någon trycker på knappen fyra minuter efter att ha passerat. Positionen
//     är då flera kilometer fel, men rapporten i sig är sann.
//   * En passagerare rapporterar i 110 km/h. Bilen hinner hundra meter innan
//     fingret når skärmen.
//   * Röst eller Facebook-text geokodas till rätt gatunamn i fel stadsdel.
//   * Samma patrull rapporteras två gånger från två olika positioner, och
//     ser i kartan ut som två patruller.
//   * Rapporten är helt enkelt fel, eller inaktuell — bilen åkte för tio
//     minuter sedan.
//
// Modulen svarar på två frågor och gör inget annat:
//
//   bedomRapport()      Hur mycket ska vi tro på den här? Ger en graderad
//                       trovärdighet och en rekommenderad behandling.
//   grupperaRapporter() Vilka av de här rapporterna är samma fysiska patrull?
//
// Allt är rena funktioner. Modulen rör inte DOM, säger ingenting högt och
// skriver inte till store — den lämnar ifrån sig en bedömning och en färdig
// svensk mening, precis som vinter.js. Någon annan kopplar in den.
//
// Den hårda regeln från parser.js gäller här också: nykterhetskontroller och
// fartkameror är aldrig användarrapporterbara. Modulen inför dem inte igen —
// den har tvärtom ett eget skyddsnät som vägrar gradera sådant, så att en
// framtida väg förbi parsern inte tyst öppnar hålet.

import { distance, bearing, clamp, normalize, spokenDistance } from './util.js';
import { isSobrietyCheck, TYPE_SPOKEN } from './parser.js';
import { TTL_MINUTES } from './store.js';

/* ==================== Vad modulen kan svara ========================== */

/** Rekommenderad behandling, i fallande ordning av hur mycket appen påstår. */
export const BEHANDLING = {
  /** Läs upp som ett konstaterande. Appen går i god för uppgiften. */
  ANNONSERA: 'annonsera',
  /** Läs upp, men som ett referat: "rapporterad", aldrig "det står". */
  HEDGA: 'hedga',
  /** Visa på kartan, säg ingenting. Föraren får se den om hen tittar. */
  TYST: 'tyst',
  /** Håll inne helt. Varken röst eller karta. */
  UNDANHALL: 'undanhall',
};

export const NIVA = {
  HOG: 'hog',
  MEDEL: 'medel',
  LAG: 'lag',
  SVAG: 'svag',
  /** Inte en användarrapport — t.ex. en fartkamera ur den medföljande listan. */
  EJ_TILLAMPLIG: 'ejTillamplig',
};

/** De enda typer en användare får rapportera. Se parser.js för varför. */
export const RAPPORTERBARA_TYPER = ['police', 'control', 'unmarked'];

/* ========================== Trösklar ================================= */
//
// Varje siffra här nere har en anledning. Ändra dem gärna, men ändra dem med
// en motivering — docs/KVALITET.md listar vad varje tal är valt mot.

export const DEFAULTS = {
  /* --- Nivågränser -------------------------------------------------- */
  //
  // Gränserna är medvetet snedställda mot tystnad. Att gå från "hedga" till
  // "annonsera" kräver 0,72 därför att det steget är det enda som får appen
  // att låta som om den vet. Steget ner till karta går redan vid 0,48, för
  // en tyst kartnål har ingen kostnad om den är fel.
  gransAnnonsera: 0.72,
  gransHedga: 0.48,
  gransKarta: 0.28,

  /* --- Position ----------------------------------------------------- */
  //
  // Över 250 m osäkerhet slutar vi säga "vid X" och säger "i området kring
  // X". 250 m är ungefär det längsta man kan peka ut i tätort utan att
  // hamna på fel kvarter, och motsvarar fyra sekunders fördröjning i
  // motorvägsfart.
  hedgaPlatsOverM: 250,
  //
  // Över 1200 m är platsen oanvändbar som varning. Varningsradien i
  // alerts.js är 1500 m, så en rapport med den osäkerheten skulle kunna
  // trigga var som helst inom radien — den säger inte längre var, bara att.
  platsOanvandbarOverM: 1200,
  //
  // Över 3 km är den oanvändbar också på kartan. En nål som står tre
  // kilometer fel är inte "ungefärlig", den är falsk — föraren tror att den
  // pekar på en väg. Då är ingen nål bättre.
  platsHopplosOverM: 3000,
  //
  // Antagen fördröjning mellan iakttagelse och inlämning, i sekunder, när
  // appen inte vet bättre. Röst tar längre tid än en knapp eftersom man
  // hinner formulera sig. Facebook-inlägg skrivs typiskt några minuter efter.
  antagenFordrojningS: { app: 4, voice: 8, facebook: 300, import: 300, okand: 6 },
  //
  // Standardradie för olika sorters geokodning, i meter. Ett gatunamn utan
  // husnummer i Västerås är i storleksordningen 250 m långt; en stadsdel
  // närmare en kilometer; ett ortsnamn flera.
  geokodRadieM: { punkt: 15, adress: 40, vag: 250, stadsdel: 900, ort: 2500, okand: 1200 },
  //
  // GPS-osäkerhet att anta när telefonen inte rapporterar någon.
  antagenGpsM: 25,

  /* --- Dubbletter --------------------------------------------------- */
  dubblettTidMs: 12 * 60000,     // längre isär än så: rimligen två tillfällen
  dubblettGrundM: 150,           // grundtillägg längs vägen
  dubblettTvarsGrundM: 60,       // grundtillägg tvärs vägen (parallellgator)
  dubblettMaxM: 700,             // aldrig, oavsett vad osäkerheten säger
  klusterMaxDiameterM: 900,      // hela klustret får inte bli en korridor
  typLikhetsGrans: 0.5,

  /* --- Historik ----------------------------------------------------- */
  historikVikt: 6,               // pseudoräknare: så många rapporter innan historiken väger
  historikNolla: 0.55,           // vad en okänd rapportör antas ligga på
  daligHistorikNedrostningar: 5, // så många nedröstningar = taknivå medel

  /* --- Tak ---------------------------------------------------------- */
  //
  // En ensam rapport får aldrig nå toppen av skalan hur bra allt annat än
  // ser ut. En persons ord är en persons ord, och skalan ska inte kunna
  // påstå något annat. Taket ligger med flit över annonseringsgränsen —
  // ensamma rapporter ska fortfarande läsas upp, bara inte räknas som
  // bevisade.
  soloTak: 0.88,

  /* --- Ålder -------------------------------------------------------- */
  farskUnderAndel: 0.15,         // andel av livslängden som räknas som färsk
  gammalOverAndel: 0.50,
  mycketGammalOverAndel: 0.80,
  namnAlderOverAndel: 0.40,      // säg åldern högt när rapporten passerat den här
};

/** Hur mycket två typer talar om samma sak. 1 = samma, 0 = orelaterat. */
const TYP_SLAKTSKAP = {
  'police|police': 1,
  'control|control': 1,
  'unmarked|unmarked': 1,
  // En marker polisbil vid en avspärrning och "trafikkontroll" är ofta samma
  // händelse beskriven med olika ord.
  'police|control': 0.6,
  // En civil bil och en markerad bil ser helt olika ut. Att slå ihop dem
  // döljer den ena. Under sammanslagningsgränsen med flit.
  'police|unmarked': 0.25,
  'control|unmarked': 0.25,
};

const slaktskap = (a, b) =>
  TYP_SLAKTSKAP[`${a}|${b}`] ?? TYP_SLAKTSKAP[`${b}|${a}`] ?? 0;

/* --- Utgångsläge per rapportväg -------------------------------------- */
//
// Hur rapporten skapades säger en hel del innan vi vet något annat. En
// knapptryckning i appen bär ett underförstått "jag är här och ser det nu".
// Röst lägger till ett taltolkningssteg. Ett Facebook-inlägg lägger till en
// okänd författare, en okänd tidpunkt och en geokodning.
const BAS_KALLA = {
  app: 0.62,
  voice: 0.56,
  facebook: 0.42,
  import: 0.42,
  okand: 0.45,
};

/* --- Geokodningens bidrag -------------------------------------------- */
//
// Det här är fallet "rätt gatunamn i fel del av stan". Ett ortsnamn drar ner
// hårt eftersom det pekar på en kommun, inte på en väg.
const GEOKOD_DELTA = {
  gps: 0.10,        // egen position, ingen namntolkning inblandad
  karta: 0.08,      // föraren pekade själv, stillastående
  learned: 0.05,    // inlärd plats som pekats ut en gång och suttit sedan dess
  alias: 0.02,
  cache: 0.02,
  nominatim: 0,     // neutral: bra på adresser, sämre på "rondellen"
  okand: -0.15,
};

const GEOKODTYP_DELTA = {
  punkt: 0.04,
  adress: 0.02,
  vag: 0,
  stadsdel: -0.10,
  ort: -0.22,
  okand: -0.06,
};

/* ========================= Små hjälpare ============================== */

const clamp01 = v => clamp(v, 0, 1);
const nz = (v, d = 0) => (Number.isFinite(v) ? v : d);

/**
 * Minsta osäkerhet vi någonsin påstår, i meter.
 *
 * En punkt utpekad på kartan har formellt noll fel, men bilen den beskriver
 * står inte på en matematisk punkt och den som pekade siktade inte perfekt.
 * Noll är alltid en lögn, och den lögnen skulle sedan användas som vikt i
 * klustringen och göra en enda rapport oändligt tung.
 */
const MIN_OSAKERHET_M = 15;

/** Livslängd i millisekunder för en typ, samma tal som store.js använder. */
function livslangdMs(typ) {
  return (TTL_MINUTES[typ] ?? 45) * 60000;
}

/** Slår upp rapportörens historik oavsett om den kom som Map, objekt eller funktion. */
function slaUppHistorik(historik, deviceId) {
  if (!historik || !deviceId) return null;
  if (typeof historik === 'function') return historik(deviceId) || null;
  if (typeof historik.get === 'function') return historik.get(deviceId) || null;
  return historik[deviceId] || null;
}

/* ==================== Positionsosäkerhet ============================= */

/**
 * Hur långt ifrån den angivna punkten kan patrullen rimligen stå?
 *
 * Tre oberoende felkällor, och de adderas kvadratiskt eftersom de inte
 * samvarierar — att GPS:en är dålig gör inte fördröjningen längre:
 *
 *   gps        telefonens egen osäkerhet
 *   geokod     hur brett platsnamnet pekar (en gata är inte en punkt)
 *   längs      farten gånger fördröjningen mellan iakttagelse och tryck
 *
 * Den sista skiljer sig från de andra på ett sätt som spelar roll längre ner:
 * den ligger *längs färdriktningen*, inte runt om. Två rapporter som skiljer
 * 200 m längs samma väg kan mycket väl vara samma patrull; två som skiljer
 * 200 m tvärs vägen står på olika gator. Därför returneras felet uppdelat.
 *
 * @returns {{ total:number, iso:number, langs:number, delar:Object }}
 */
export function positionsOsakerhet(rapport, opts = DEFAULTS) {
  const o = { ...DEFAULTS, ...opts };
  const kalla = rapport.source || 'okand';

  const gps = rapport.geokod === 'gps' || !rapport.geokod
    ? nz(rapport.gpsAccuracyM, o.antagenGpsM)
    : nz(rapport.gpsAccuracyM, 0);

  const geoRadie = Number.isFinite(rapport.geokodRadiusM)
    ? rapport.geokodRadiusM
    : (rapport.geokod === 'gps' || rapport.geokod === 'karta'
        ? 0
        : o.geokodRadieM[rapport.geokodTyp || 'okand'] ?? o.geokodRadieM.okand);

  const fordrojningS = Number.isFinite(rapport.fordrojningS)
    ? rapport.fordrojningS
    : (o.antagenFordrojningS[kalla] ?? o.antagenFordrojningS.okand);

  // Bara egna GPS-rapporter förskjuts av farten. En geokodad plats pekar på
  // en gata; att rapportören körde fort flyttar inte gatan.
  const egenPosition = !rapport.geokod || rapport.geokod === 'gps';
  const langs = egenPosition
    ? (nz(rapport.fartKmh, 0) / 3.6) * fordrojningS
    : 0;

  const iso = Math.max(MIN_OSAKERHET_M, Math.hypot(gps, geoRadie));
  return {
    total: Math.hypot(iso, langs),
    iso,
    langs,
    delar: { gps, geoRadie, fordrojningS, fartKmh: nz(rapport.fartKmh, 0) },
  };
}

/* ======================== Bedömningen ================================ */

/**
 * @typedef {Object} Rapport
 * @property {string} id
 * @property {'police'|'control'|'unmarked'|'camera'} type
 * @property {number} lat
 * @property {number} lon
 * @property {number} createdAt          millisekunder
 * @property {string} [label]
 * @property {string} [note]
 * @property {'app'|'voice'|'facebook'|'import'} [source]
 * @property {string} [device_id]        saknas i det publika flödet, se store.js
 * @property {string} [external_id]
 * @property {number} [confirms]
 * @property {number} [denials]
 * @property {number} [gpsAccuracyM]     GPS-osäkerhet vid inlämning
 * @property {number} [fartKmh]          rapportörens fart vid inlämning
 * @property {number} [kurs]             rapportörens kurs i grader
 * @property {number} [fordrojningS]     sekunder mellan iakttagelse och inlämning
 * @property {'gps'|'karta'|'learned'|'alias'|'cache'|'nominatim'|'okand'} [geokod]
 * @property {'punkt'|'adress'|'vag'|'stadsdel'|'ort'|'okand'} [geokodTyp]
 * @property {number} [geokodRadiusM]
 * @property {number} [parserConfidence] 0-1 från parser.js
 */

/**
 * @typedef {Object} Kontext
 * @property {number} [nu]
 * @property {Array<Rapport>} [grannar]  andra rapporter att jämföra mot
 * @property {Object} [kluster]          färdigt kluster från grupperaRapporter
 * @property {Map|Object|Function} [historik]  device_id -> {reports,confirmed,denied}
 */

/**
 * Bedöm en rapport.
 *
 * @param {Rapport} rapport
 * @param {Kontext} kontext
 * @returns {{
 *   id: string,
 *   poang: number|null,        // 0-1, null när frågan inte gäller posten
 *   niva: string,              // NIVA.*
 *   behandling: string,        // BEHANDLING.*
 *   osakerhetM: number|null,
 *   hedgaFakta: boolean,
 *   hedgaPlats: boolean,
 *   visaAlder: boolean,
 *   oberoendeStod: number,
 *   skal: Array<{namn:string, delta:number, varfor:string}>,
 *   flaggor: Array<string>,
 * }}
 */
export function bedomRapport(rapport, kontext = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const nu = kontext.nu ?? Date.now();
  const skal = [];
  const flaggor = [];
  const lagg = (namn, delta, varfor) => {
    if (delta) skal.push({ namn, delta: +delta.toFixed(3), varfor });
    return delta;
  };

  /* ---- Skyddsnät före all poängsättning ---------------------------- */
  //
  // De här är inte trösklar utan regler. En regel går inte att köpa sig förbi
  // med hög poäng.

  const spar = grundlaggandeVeto(rapport, o);
  if (spar) {
    return {
      id: rapport.id,
      poang: spar.niva === NIVA.EJ_TILLAMPLIG ? null : 0,
      niva: spar.niva,
      behandling: spar.behandling,
      // null, inte Infinity: vi vet inte att osäkerheten är stor, vi vet att
      // frågan inte gäller den här posten.
      osakerhetM: null,
      hedgaFakta: false,
      hedgaPlats: false,
      visaAlder: false,
      oberoendeStod: 0,
      skal: [],
      flaggor: spar.flaggor,
    };
  }

  /* ---- Utgångsläge -------------------------------------------------- */

  const kalla = BAS_KALLA[rapport.source] != null ? rapport.source : 'okand';
  let poang = BAS_KALLA[kalla];
  skal.push({
    namn: 'ursprung',
    delta: +poang.toFixed(3),
    varfor: `Skapad via ${kalla}. Utgångsläge innan övriga faktorer.`,
  });

  /* ---- Rapportörens historia --------------------------------------- */
  //
  // Poängsättningen i reputation.js belönar bekräftade rapporter och
  // bestraffar nedröstade. Samma siffror går att läsa baklänges: någon vars
  // rapporter regelbundet röstas ner har antingen dålig position eller dålig
  // bedömning, och båda är skäl att hedga.
  //
  // Siffrorna dras mot mitten vid få data. Utan det skulle en enda
  // nedröstning på en enda rapport ge kvoten noll, och en förstagångare som
  // hade otur bli permanent misstrodd.
  const h = slaUppHistorik(kontext.historik, rapport.device_id);
  if (h) {
    const bra = Math.max(0, nz(h.confirmed, 0));
    const dalig = Math.max(0, nz(h.denied, 0));
    const kvot = (bra + o.historikVikt * o.historikNolla) / (bra + dalig + o.historikVikt);
    const delta = clamp((kvot - o.historikNolla) * 0.55, -0.25, 0.20);
    poang += lagg('historik', delta,
      `${bra} bekräftelser och ${dalig} nedröstningar tidigare (utjämnat mot ${o.historikVikt} pseudorapporter).`);
    if (dalig >= o.daligHistorikNedrostningar && dalig > bra) flaggor.push('dalig-historik');
  } else if (rapport.device_id) {
    flaggor.push('okand-rapportor');
    skal.push({
      namn: 'historik',
      delta: 0,
      varfor: 'Ingen historik. Ger varken plus eller minus — nya rapportörer ska inte straffas.',
    });
  } else {
    // Det publika flödet lämnar med flit inte ut device_id, se store.js.
    flaggor.push('rapportor-anonym');
  }

  /* ---- Fart vid inlämning ------------------------------------------ */
  //
  // Farten flyttar framför allt punkten, och det hanteras av
  // positionsosäkerheten. Men den påverkar också vad man hinner se: i
  // 120 km/h är en mörk kombi på vägrenen en glimt. Ett litet avdrag, inte
  // ett stort.
  const fart = nz(rapport.fartKmh, null);
  if (fart != null && fart > 60) {
    const delta = -clamp((fart - 60) / 60, 0, 1) * 0.08;
    poang += lagg('fart', delta,
      `${Math.round(fart)} km/h vid inlämning. Kortare tid att se rätt.`);
  }

  /* ---- Fördröjning -------------------------------------------------- */
  //
  // Det här är det enda som fångar "jag tryckte när jag kom hem". Appen vet
  // det bara om den frågar eller om inlägget har en tidsstämpel — därför är
  // fältet valfritt och saknas oftast.
  if (Number.isFinite(rapport.fordrojningS) && rapport.fordrojningS > 60) {
    const min = rapport.fordrojningS / 60;
    const delta = -clamp(min / 10, 0, 1) * 0.20;
    poang += lagg('fordrojning', delta,
      `${Math.round(min)} minuter mellan iakttagelse och inlämning.`);
    if (min >= 5) flaggor.push('sen-inlamning');
  }

  /* ---- Geokodning --------------------------------------------------- */
  const gk = rapport.geokod || (rapport.source === 'app' ? 'gps' : 'okand');
  poang += lagg('geokod', GEOKOD_DELTA[gk] ?? 0,
    `Positionen kom från ${gk}.`);
  if (rapport.geokodTyp) {
    poang += lagg('geokodtyp', GEOKODTYP_DELTA[rapport.geokodTyp] ?? 0,
      `Träffen löste till nivå "${rapport.geokodTyp}".`);
    if (rapport.geokodTyp === 'ort' || rapport.geokodTyp === 'stadsdel') {
      flaggor.push('grov-geokod');
    }
  }

  /* ---- Parserns egen bedömning ------------------------------------- */
  if (Number.isFinite(rapport.parserConfidence)) {
    const delta = clamp((rapport.parserConfidence - 0.7) * 0.25, -0.08, 0.08);
    poang += lagg('texttolkning', delta,
      `parser.js gav ${rapport.parserConfidence.toFixed(2)} på texttolkningen.`);
  }

  /* ---- Samstämmighet ------------------------------------------------ */
  //
  // Två personer som oberoende av varandra rapporterar samma sak på samma
  // ställe är det starkaste vi kan få utan att åka dit och titta. Men bara
  // om de verkligen är oberoende: samma telefon två gånger är en person som
  // tryckte två gånger, och samma Facebook-inlägg inläst två gånger är ett
  // inlägg.
  const stod = raknaStod(rapport, kontext, o);
  if (stod.oberoende > 0) {
    let delta = stod.oberoende === 1 ? 0.12 : stod.oberoende === 2 ? 0.20 : 0.25;
    if (stod.korsKanal) delta += 0.05;   // app + Facebook är starkare än app + app
    if (stod.oberoendeOkant) delta = Math.min(delta, 0.12);
    poang += lagg('samstammighet', delta,
      `${stod.oberoende} oberoende rapport(er) om samma patrull` +
      (stod.korsKanal ? ', från olika kanaler' : '') +
      (stod.oberoendeOkant ? ' (oberoendet går inte att bevisa, taket sänkt)' : '') + '.');
  } else {
    // Ingen bestraffning. Den första rapporten om en verklig patrull är den
    // mest värdefulla som finns; straffar vi ensamhet varnar appen aldrig
    // först, och då är den meningslös.
    skal.push({
      namn: 'samstammighet',
      delta: 0,
      varfor: 'Ensam rapport. Ger inget avdrag — någon måste vara först.',
    });
  }

  /* ---- Röster på rapporten ----------------------------------------- */
  //
  // En röst är billigare än en rapport (ett tryck, ingen egen iakttagelse
  // krävs) och väger därför mindre än en självständig rapport.
  const bekraftelser = Math.max(0, nz(rapport.confirms, 1) - 1);
  const nedrostningar = Math.max(0, nz(rapport.denials, 0));
  if (bekraftelser) {
    poang += lagg('bekraftelser', Math.min(bekraftelser * 0.08, 0.16),
      `${bekraftelser} bekräftelse(r) från andra användare.`);
  }
  if (nedrostningar) {
    poang += lagg('nedrostningar', -Math.min(nedrostningar * 0.10, 0.30),
      `${nedrostningar} användare har markerat den som borta eller fel.`);
    flaggor.push('motsagd');
  }

  /* ---- Ålder -------------------------------------------------------- */
  //
  // Livslängden per typ ligger redan i store.js och är satt efter hur länge
  // en patrull rimligen står kvar. Här används samma tal som skala, så en
  // civil bil (30 min) åldras dubbelt så fort som en trafikkontroll (60 min)
  // utan att någon siffra behöver upprepas.
  const ttl = livslangdMs(rapport.type);
  const alder = Math.max(0, nu - nz(rapport.createdAt, nu));
  const andel = alder / ttl;
  if (andel < o.farskUnderAndel) {
    poang += lagg('alder', 0.05, 'Färsk rapport, mindre än 15 % av livslängden.');
  } else if (andel > o.mycketGammalOverAndel) {
    poang += lagg('alder', -0.18, 'Rapporten har nästan gått ut. Patrullen har troligen flyttat.');
    flaggor.push('gammal');
  } else if (andel > o.gammalOverAndel) {
    poang += lagg('alder', -0.08, 'Mer än halva livslängden har gått.');
  }

  poang = clamp01(poang);

  /* ---- Tak som poängen inte får forcera ---------------------------- */
  //
  // Taken är inte avdrag utan gränser. Ett avdrag går att kompensera bort
  // med tillräckligt många plus; en gräns gör det inte, och vissa saker ska
  // inte gå att kompensera bort.
  if (stod.oberoende === 0 && poang > o.soloTak) {
    poang = o.soloTak;
    skal.push({ namn: 'tak', delta: 0, varfor: 'Ensam rapport kan inte nå toppen av skalan.' });
  }
  if (flaggor.includes('dalig-historik') && poang > 0.65) {
    poang = 0.65;
    skal.push({ namn: 'tak', delta: 0, varfor: 'Historiken tillåter inte konstaterande formulering.' });
  }
  if (nedrostningar >= 2 && poang > 0.45) {
    // Två personer som säger "det står ingen där" väger tyngre än en som
    // säger att det gör det. De har sett samma plats senare i tiden.
    poang = 0.45;
    skal.push({ namn: 'tak', delta: 0, varfor: 'Två eller fler säger emot. Rapporten sägs inte högt.' });
  }

  /* ---- Position avgör hur platsen får uttryckas -------------------- */
  //
  // Kluster räknar redan fram sin egen spridning; då ska den användas istället
  // för att räknas om ur ledarens fält, som skulle dubbelräkna farten.
  const os = Number.isFinite(kontext.osakerhetM)
    ? { total: kontext.osakerhetM, iso: kontext.osakerhetM, langs: 0, delar: { kluster: true } }
    : positionsOsakerhet(rapport, o);
  const hedgaPlats = os.total > o.hedgaPlatsOverM;
  if (hedgaPlats) flaggor.push('osaker-plats');

  let niva = poang >= o.gransAnnonsera ? NIVA.HOG
    : poang >= o.gransHedga ? NIVA.MEDEL
    : poang >= o.gransKarta ? NIVA.LAG
    : NIVA.SVAG;

  // En punkt som är över en kilometer osäker kan inte pekas ut. Varningen
  // skulle handla om ett område större än varningsradien och därmed säga
  // ingenting alls om var. Då hör den hemma på kartan, inte i högtalaren.
  if (os.total > o.platsOanvandbarOverM && niva !== NIVA.SVAG) {
    niva = NIVA.LAG;
    flaggor.push('plats-oanvandbar');
    skal.push({
      namn: 'plats',
      delta: 0,
      varfor: `Osäkerhet ${Math.round(os.total)} m överstiger ${o.platsOanvandbarOverM} m — går inte att varna för en punkt.`,
    });
  }

  // Och över det hopplösa: bort helt. En kartnål som står tre kilometer fel
  // ser exakt lika trovärdig ut som en som står rätt, och föraren har inget
  // sätt att se skillnaden.
  if (os.total > o.platsHopplosOverM) {
    niva = NIVA.SVAG;
    flaggor.push('plats-hopplos');
    skal.push({
      namn: 'plats',
      delta: 0,
      varfor: `Osäkerhet ${Math.round(os.total)} m — nålen skulle peka på fel väg. Bättre att inte visa den.`,
    });
  }

  const behandling = niva === NIVA.HOG ? BEHANDLING.ANNONSERA
    : niva === NIVA.MEDEL ? BEHANDLING.HEDGA
    : niva === NIVA.LAG ? BEHANDLING.TYST
    : BEHANDLING.UNDANHALL;

  return {
    id: rapport.id,
    poang: +poang.toFixed(3),
    niva,
    behandling,
    osakerhetM: Math.round(os.total),
    hedgaFakta: niva !== NIVA.HOG,
    hedgaPlats,
    visaAlder: andel > o.namnAlderOverAndel,
    oberoendeStod: stod.oberoende,
    skal,
    flaggor,
  };
}

/**
 * Regler som gäller före all poängsättning.
 *
 * Det här är skyddsnätet, inte huvudfiltret. Huvudfiltret sitter i parser.js
 * och ska fånga allt det här innan det ens blir en rapport. Nätet finns för
 * att en framtida väg in i store — en import, en delad länk, en ny knapp —
 * inte ska kunna öppna hålet tyst.
 */
function grundlaggandeVeto(rapport, o) {
  // Fartkameror ur den medföljande listan är inga användarrapporter och ska
  // inte graderas. De har känd koordinat och känd mätriktning; att låta en
  // trovärdighetsbedömning tysta dem vore fel.
  if (!RAPPORTERBARA_TYPER.includes(rapport.type)) {
    const anvandarkalla = ['app', 'voice', 'facebook', 'import'].includes(rapport.source);
    if (rapport.type === 'camera' && anvandarkalla) {
      // Handmarkerad kamera. parser.js vägrar redan det här; hamnar en ändå
      // här är något fel och den ska inte ut.
      return { niva: NIVA.SVAG, behandling: BEHANDLING.UNDANHALL, flaggor: ['kamera-ej-rapporterbar'] };
    }
    return { niva: NIVA.EJ_TILLAMPLIG, behandling: BEHANDLING.ANNONSERA, flaggor: ['ej-anvandarrapport'] };
  }

  // Nykterhets- och drogkontroller rapporteras aldrig. Texten kan ha kommit
  // in via ett fält som inte gick genom parsern, så den kontrolleras igen.
  const text = `${rapport.label || ''} ${rapport.note || ''}`.trim();
  if (text && isSobrietyCheck(text)) {
    return { niva: NIVA.SVAG, behandling: BEHANDLING.UNDANHALL, flaggor: ['nykterhetskontroll'] };
  }

  // Utanför Sverige finns inget att varna för, och en koordinat i Atlanten
  // är ett fel någonstans i kedjan. Samma gränser som schema.sql sätter.
  if (!Number.isFinite(rapport.lat) || !Number.isFinite(rapport.lon) ||
      rapport.lat < 55 || rapport.lat > 70 || rapport.lon < 10 || rapport.lon > 25) {
    return { niva: NIVA.SVAG, behandling: BEHANDLING.UNDANHALL, flaggor: ['utanfor-omradet'] };
  }

  return null;
}

/**
 * Hur många oberoende rapporter stödjer den här?
 *
 * Oberoende betyder olika personer och olika iakttagelser. Tre saker gör att
 * en granne inte räknas:
 *   * samma device_id — en person som tryckt två gånger
 *   * samma external_id — samma Facebook-inlägg inläst två gånger
 *   * samma id — rapporten själv
 *
 * Saknas device_id (det publika flödet lämnar inte ut det, se store.js) kan
 * oberoendet inte bevisas. Då räknas grannen ändå, men flaggan gör att
 * bonusen får ett lägre tak i bedomRapport. Alternativet — att ignorera all
 * samstämmighet — vore att kasta bort det starkaste vi har.
 */
function raknaStod(rapport, kontext, o) {
  const medlemmar = kontext.kluster?.medlemmar
    || (kontext.grannar || []).filter(g => g.id !== rapport.id && arSammaPatrull(rapport, g, o).samma);

  const enheter = new Set();
  const externa = new Set();
  const kanaler = new Set([rapport.source || 'okand']);
  let oberoendeOkant = false;
  let n = 0;

  for (const g of medlemmar) {
    if (!g || g.id === rapport.id) continue;
    if (g.external_id && externa.has(g.external_id)) continue;
    if (g.external_id) externa.add(g.external_id);
    if (g.device_id) {
      if (g.device_id === rapport.device_id) continue;
      if (enheter.has(g.device_id)) continue;
      enheter.add(g.device_id);
    } else {
      oberoendeOkant = true;
    }
    kanaler.add(g.source || 'okand');
    n++;
  }

  return { oberoende: n, oberoendeOkant, korsKanal: kanaler.size > 1 };
}

/* ======================= Dubbletthantering =========================== */

/**
 * Är de här två rapporterna samma fysiska patrull?
 *
 * Den svåra avvägningen: två rapporter om samma patrull från olika positioner
 * ska bli en, men två verkliga patruller på samma väg får aldrig bli en. Den
 * andra sortens misstag är värre — den döljer en patrull som finns.
 *
 * Därför delas avståndet upp i två riktningar när vi känner rapportörens kurs.
 * Felet från fördröjningen ligger längs vägen: den som passerade i 90 km/h och
 * tryckte fyra sekunder senare hamnar hundra meter *efter* patrullen, inte
 * bredvid den. Tvärs vägen finns bara GPS-felet, och 80 meter åt sidan är en
 * annan gata. Ett isotropt avstånd hade slagit ihop parallellgator.
 *
 * Två hårda spärrar utöver matematiken:
 *   * över dubblettMaxM slås aldrig något ihop, oavsett vad osäkerheten säger
 *   * två rapporter som båda har bra position och ändå står isär är två saker
 *     (faller ut av toleransmatten, men är avsikten bakom talen)
 *
 * @returns {{samma:boolean, sep:number, langs:number, tvars:number, varfor:string}}
 */
export function arSammaPatrull(a, b, opts = DEFAULTS) {
  const o = { ...DEFAULTS, ...opts };
  const nej = (varfor, extra = {}) => ({ samma: false, varfor, ...extra });

  if (!a || !b || a.id === b.id) return nej('samma rapport');

  const likhet = slaktskap(a.type, b.type);
  if (likhet < o.typLikhetsGrans) {
    return nej(`typerna ${a.type} och ${b.type} beskriver inte samma sak`);
  }

  const dt = Math.abs(nz(a.createdAt, 0) - nz(b.createdAt, 0));
  if (dt > o.dubblettTidMs) {
    return nej(`${Math.round(dt / 60000)} min isär — behandlas som två tillfällen`);
  }

  const sep = distance(a.lat, a.lon, b.lat, b.lon);
  if (sep > o.dubblettMaxM) {
    return nej(`${Math.round(sep)} m isär, över den absoluta gränsen ${o.dubblettMaxM} m`, { sep });
  }

  const oa = positionsOsakerhet(a, o);
  const ob = positionsOsakerhet(b, o);

  // Vems kurs vet vi? Har ingen av dem en känd kurs går det inte att skilja
  // längs från tvärs, och då får toleransen bli rund — men utan att någon av
  // riktningarna får den generösa längsmarginalen.
  const kurs = Number.isFinite(a.kurs) ? a.kurs : (Number.isFinite(b.kurs) ? b.kurs : null);

  if (kurs == null || sep === 0) {
    const tillaten = Math.hypot(oa.total, ob.total) + o.dubblettGrundM;
    return sep <= tillaten
      ? { samma: true, sep, langs: sep, tvars: 0, varfor: `${Math.round(sep)} m inom rund tolerans ${Math.round(tillaten)} m` }
      : nej(`${Math.round(sep)} m över rund tolerans ${Math.round(tillaten)} m`, { sep });
  }

  const rel = (bearing(a.lat, a.lon, b.lat, b.lon) - kurs) * Math.PI / 180;
  const langs = Math.abs(sep * Math.cos(rel));
  const tvars = Math.abs(sep * Math.sin(rel));

  let tillatetLangs = Math.hypot(oa.iso, ob.iso, oa.langs, ob.langs) + o.dubblettGrundM;
  let tillatetTvars = Math.hypot(oa.iso, ob.iso) + o.dubblettTvarsGrundM;

  // Två olika, kända vägnamn drar åt tumskruven. Namnen kommer från omvänd
  // geokodning och är inte pålitliga nog att fälla avgörandet ensamma, så de
  // krymper toleransen istället för att sätta stopp.
  if (a.label && b.label && normalize(a.label) !== normalize(b.label)) {
    tillatetLangs *= 0.8;
    tillatetTvars *= 0.8;
  }

  if (langs <= tillatetLangs && tvars <= tillatetTvars) {
    return {
      samma: true, sep, langs, tvars,
      varfor: `${Math.round(langs)} m längs (tillåtet ${Math.round(tillatetLangs)}) och ` +
              `${Math.round(tvars)} m tvärs (tillåtet ${Math.round(tillatetTvars)})`,
    };
  }
  return nej(
    tvars > tillatetTvars
      ? `${Math.round(tvars)} m tvärs färdriktningen — troligen en annan väg`
      : `${Math.round(langs)} m längs vägen, mer än osäkerheten räcker till`,
    { sep, langs, tvars });
}

/**
 * Gruppera rapporter så att varje fysisk patrull blir ett kluster.
 *
 * Metoden är avsiktligt "ledarklustring" och inte den vanligare enkellänkade:
 * varje medlem måste likna *ledaren*, inte bara någon annan medlem. Enkellänkad
 * klustring kedjar — A liknar B, B liknar C, och plötsligt är hela E18 genom
 * Västerås en enda patrull trots att A och C ligger två kilometer isär.
 *
 * Ledare blir den rapport som har säkrast position, inte den som har högst
 * trovärdighet. Positionen är det klustret ärver, så det är precisionen som
 * ska styra vem som får sätta punkten.
 *
 * @returns {{kluster: Array, index: Map<string,string>}}
 */
export function grupperaRapporter(rapporter, kontext = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lista = (rapporter || []).filter(r => r && Number.isFinite(r.lat) && Number.isFinite(r.lon));

  const med = lista.map(r => ({ r, os: positionsOsakerhet(r, o) }));
  // Säkrast position först; vid lika, nyast först.
  med.sort((x, y) => (x.os.total - y.os.total) || (nz(y.r.createdAt, 0) - nz(x.r.createdAt, 0)));

  const kvar = new Set(med.map(m => m.r.id));
  const kluster = [];
  const index = new Map();

  for (const { r: ledare, os: ledarOs } of med) {
    if (!kvar.has(ledare.id)) continue;
    kvar.delete(ledare.id);

    const medlemmar = [ledare];
    for (const { r: kandidat } of med) {
      if (!kvar.has(kandidat.id)) continue;
      const dom = arSammaPatrull(ledare, kandidat, o);
      if (!dom.samma) continue;

      // Diametervakt: även om kandidaten liknar ledaren får klustret inte
      // svälla till en korridor. Kontrollen görs mot alla befintliga medlemmar.
      const forLangt = medlemmar.some(m =>
        distance(m.lat, m.lon, kandidat.lat, kandidat.lon) > o.klusterMaxDiameterM);
      if (forLangt) continue;

      medlemmar.push(kandidat);
      kvar.delete(kandidat.id);
    }

    kluster.push(byggKluster(ledare, ledarOs, medlemmar, o));
    for (const m of medlemmar) index.set(m.id, ledare.id);
  }

  return { kluster, index };
}

/** Sätter klustrets gemensamma position, spridning och oberoendemått. */
function byggKluster(ledare, ledarOs, medlemmar, o) {
  // Inversvariansviktat medelvärde: en rapport med 800 m osäkerhet får väga
  // ungefär en hundradel av en med 80 m. Platt medelvärde hade låtit en grov
  // geokodning dra punkten flera hundra meter.
  let wSum = 0, latSum = 0, lonSum = 0, minSigma = Infinity;
  let forsta = Infinity, senast = -Infinity;
  const enheter = new Set();
  const kanaler = new Set();
  let anonyma = 0;

  for (const m of medlemmar) {
    const s = Math.max(MIN_OSAKERHET_M, positionsOsakerhet(m, o).total);
    const w = 1 / (s * s);
    wSum += w; latSum += m.lat * w; lonSum += m.lon * w;
    minSigma = Math.min(minSigma, s);
    forsta = Math.min(forsta, nz(m.createdAt, Date.now()));
    senast = Math.max(senast, nz(m.createdAt, 0));
    if (m.device_id) enheter.add(m.device_id); else anonyma++;
    kanaler.add(m.source || 'okand');
  }

  const lat = latSum / wSum;
  const lon = lonSum / wSum;

  // Sprid inte falskt lugn: klustrets osäkerhet får aldrig bli mindre än
  // halva spridningen mellan medlemmarna. Att kombinera tre mätningar
  // matematiskt ger en snävare siffra, men bara om de mäter samma sak — och
  // det är precis det vi har gissat oss till, inte vetat.
  let diameter = 0;
  for (const a of medlemmar) {
    for (const b of medlemmar) {
      diameter = Math.max(diameter, distance(a.lat, a.lon, b.lat, b.lon));
    }
  }

  return {
    id: ledare.id,
    ledare,
    medlemmar,
    type: ledare.type,
    lat, lon,
    label: ledare.label || medlemmar.find(m => m.label)?.label || '',
    osakerhetM: Math.round(Math.max(minSigma, diameter / 2)),
    diameterM: Math.round(diameter),
    forstaAt: forsta,
    senastAt: senast,
    oberoendeEnheter: enheter.size + anonyma,
    kanaler: [...kanaler],
    antal: medlemmar.length,
  };
}

/**
 * Hela kedjan: gruppera först, bedöm sedan varje grupp som en enhet.
 *
 * Ordningen spelar roll. Bedöms rapporterna var för sig först blir tre
 * rapporter om samma patrull tre svaga varningar istället för en stark.
 *
 * @returns {{grupper: Array<{kluster:Object, bedomning:Object}>, index: Map<string,string>}}
 */
export function bedomFlodet(rapporter, kontext = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const nu = kontext.nu ?? Date.now();
  const { kluster, index } = grupperaRapporter(rapporter, kontext, o);

  const grupper = kluster.map(k => ({
    kluster: k,
    bedomning: bedomRapport(
      // Klustret ärver ledarens egenskaper men får den viktade positionen och
      // klustrets egen osäkerhet — annars räknas farten in en gång till.
      { ...k.ledare, lat: k.lat, lon: k.lon, label: k.label },
      { ...kontext, nu, kluster: k, osakerhetM: k.osakerhetM },
      o),
  }));

  return { grupper, index };
}

/* ======================== Formuleringen ============================== */
//
// Det här är hela poängen med modulen, och den delen som faktiskt möter
// föraren.
//
// En förare kan hantera "polis rapporterad framför dig" även när det visar
// sig vara fel. Hen saktar ner, tittar efter, ser ingenting och kör vidare —
// och känner sig inte lurad, för appen sa aldrig att den visste. Samma förare
// som fått höra "det står polis vid Stora gatan" och inte ser någon polis vet
// att appen påstod något som inte stämde. Det är skillnaden mellan att
// referera och att gå i god, och den skillnaden ligger i ett enda ord.
//
// Tre saker hedgas oberoende av varandra, för de misslyckas på olika sätt:
//
//   FAKTA   "rapporterad" istället för att konstatera. Används så fort appen
//           inte skulle satsa pengar på uppgiften.
//   PLATS   "i området kring X" istället för "vid X". Används när punkten är
//           osäker även om själva patrullen är trolig — det vanligaste felet
//           av alla, och det som annars låter mest exakt.
//   ÅLDER   "för tjugo minuter sedan" läggs till när rapporten hunnit bli
//           gammal. Ett gammalt fel är en annan sorts fel: den var sann men
//           bilen har åkt, och det handlar föraren om på ett annat sätt än en
//           uppgift som aldrig stämde.
//
// En regel till, som är lätt att missa: när platsen är hedgad tas
// klockriktningen bort. Att säga "klockan 2" om en punkt vi är 400 meter
// osäkra på är en precision vi inte har. Falsk precision är samma svek som
// ett falskt påstående, bara svårare att upptäcka.

const ALDERSFRAS = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'precis nu';
  if (m === 1) return 'för en minut sedan';
  if (m < 60) return `för ${m} minuter sedan`;
  return 'för över en timme sedan';
};

const stor = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Bygg den mening rösten ska säga, eller null om den ska tiga.
 *
 * Distans och klockriktning skickas in av den som kopplar in modulen —
 * alerts.js äger dem redan och ska fortsätta göra det.
 *
 * @param {Object} bedomning  svaret från bedomRapport
 * @param {Object} rapport    {type, label, createdAt}
 * @param {{avstandM?:number, klockriktning?:number, nu?:number}} [visning]
 * @returns {string|null}
 */
export function byggMening(bedomning, rapport, visning = {}) {
  if (!bedomning) return null;
  // Fartkameror och annat som inte är användarrapporter formuleras av
  // alerts.js, som kan säga hastighetsgräns och mätriktning. Vi lägger oss
  // inte i det.
  if (bedomning.niva === NIVA.EJ_TILLAMPLIG) return null;
  if (bedomning.behandling === BEHANDLING.TYST ||
      bedomning.behandling === BEHANDLING.UNDANHALL) return null;

  const nu = visning.nu ?? Date.now();
  const vad = TYPE_SPOKEN[rapport.type] || 'varning';
  const label = (rapport.label || '').trim();

  // 1. Platsfrasen
  let plats;
  if (!label) plats = bedomning.hedgaPlats ? ' någonstans här omkring' : ' här';
  else if (bedomning.hedgaPlats) plats = ` i området kring ${label}`;
  else plats = ` vid ${label}`;

  // 2. Åldersfrasen
  const alder = bedomning.visaAlder && Number.isFinite(rapport.createdAt)
    ? ` ${ALDERSFRAS(nu - rapport.createdAt)}`
    : '';

  // 3. Avstånd och riktning. Klockan ryker om platsen är hedgad.
  const avstand = Number.isFinite(visning.avstandM)
    ? `, om ${spokenDistance(visning.avstandM)}`
    : '';
  const klocka = (!bedomning.hedgaPlats && Number.isFinite(visning.klockriktning) &&
                  Number.isFinite(visning.avstandM) && visning.avstandM > 400)
    ? ` klockan ${visning.klockriktning}`
    : '';

  if (bedomning.hedgaFakta) {
    // Referatform. Inget "Varning." — ordet är appens eget påstående, och
    // här påstår appen ingenting, den vidarebefordrar.
    return `${stor(vad)} rapporterad${plats}${alder}${avstand}${klocka}.`;
  }
  return `Varning. ${stor(vad)}${plats}${alder}${avstand}${klocka}.`;
}

/**
 * Kort text till kartan och listan. Visas även för nivåer som inte sägs högt —
 * poängen med "tyst" är just att rapporten finns att se för den som tittar.
 */
export function kortText(bedomning, rapport, nu = Date.now()) {
  if (!bedomning || bedomning.niva === NIVA.EJ_TILLAMPLIG) return '';
  const min = Math.round(Math.max(0, nu - nz(rapport.createdAt, nu)) / 60000);
  const alder = min < 1 ? 'nyss' : `${min} min`;
  const stod = bedomning.oberoendeStod > 0
    ? `Bekräftad av ${bedomning.oberoendeStod + 1}`
    : 'Enskild rapport';

  switch (bedomning.niva) {
    case NIVA.HOG:   return `${stod} · ${alder}`;
    case NIVA.MEDEL: return `${stod} · ${alder} · osäker`;
    case NIVA.LAG:   return `Obekräftad · ${alder}${bedomning.flaggor.includes('osaker-plats') ? ' · ungefärlig plats' : ''}`;
    default:         return `Undanhållen · ${alder}`;
  }
}

/** Läsbar sammanfattning för felsökningsvyn. Aldrig något föraren ser i körläge. */
export function sammanfatta(bedomning) {
  if (!bedomning) return '';
  const rader = [
    `Poäng ${bedomning.poang ?? '—'} → ${bedomning.niva} (${bedomning.behandling})`,
    `Positionsosäkerhet ${bedomning.osakerhetM == null ? '—' : bedomning.osakerhetM + ' m'}`,
  ];
  for (const s of bedomning.skal) rader.push(`  ${s.delta >= 0 ? '+' : ''}${s.delta}  ${s.namn}: ${s.varfor}`);
  if (bedomning.flaggor.length) rader.push(`Flaggor: ${bedomning.flaggor.join(', ')}`);
  return rader.join('\n');
}
