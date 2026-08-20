// Tolkar fritext (Facebook-inlägg eller talat kommando) till en rapport.
// Används av både röstkommandon och Facebook-ingesten.
//
// Matchningen är ordbaserad, inte regexbaserad. Texten normaliseras till rena
// gemener utan skiljetecken och delas i ord, sedan jämförs ord mot ord. Det
// gör att "Polis!" och "polis" behandlas lika utan att vi behöver bygga
// regexar av användarens ord — och en enda felaktig escape i en regex skulle
// tyst svälja varje varning.

import { normalize } from './util.js';

/* ---- Ordlistor ------------------------------------------------------- */

const TYPE_WORDS = [
  // ordning spelar roll: mest specifik först
  { type: 'camera',   words: ['fartkamera', 'fartkameror', 'atk', 'trafiksäkerhetskamera', 'kamera'] },
  { type: 'control',  words: ['trafikkontroll', 'fartkontroll', 'hastighetskontroll',
                              'laserkontroll', 'poliskontroll', 'kontroll', 'razzia', 'laser'] },
  { type: 'unmarked', words: ['civilbil', 'civilbilar', 'civilpolis', 'civilpoliser', 'civil polis',
                              'civila bilar', 'civil', 'civila'] },
  { type: 'police',   words: ['polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
                              'snuten', 'blåljus', 'piket', 'mc-polis', 'motorcykelpolis'] },
];

/** Alla typord platt, för att kunna rensa bort dem ur platsfrasen. */
const ALL_TYPE_WORDS = new Set(TYPE_WORDS.flatMap(g => g.words.flatMap(w => w.split(' '))));

// Ord som betyder "faran är över" -> rensa istället för att skapa
const CLEAR_WORDS = ['borta', 'åkte', 'åkt', 'iväg', 'försvunnit', 'försvann', 'fritt',
                     'lugnt', 'avblåst', 'packat', 'tomt'];

/**
 * Nykterhetskontroller rapporteras inte. Punkt.
 *
 * Att varna för en fartkamera hjälper någon att hålla hastigheten. Att varna
 * för en nykterhetskontroll hjälper någon att köra vidare full. Det är inte
 * samma sak, och en app som gör det andra förtjänar inte att finnas.
 *
 * Filtret sitter i parsern och gäller därför allt på en gång: rösten,
 * knapparna och det som kommer in från Facebook-gruppen. Det finns ingen
 * väg runt det någonstans i appen.
 */
const SOBRIETY_WORDS = [
  'nykterhetskontroll', 'nykterhetskontroller', 'nykterhet', 'nykter',
  'alkoholkontroll', 'alkotest', 'alkoholtest', 'blåsa', 'blåser', 'blås',
  'utandningsprov', 'promillekontroll', 'rattfylla', 'rattfyllerikontroll',
  'sållningsprov', 'drogkontroll', 'drogtest',
  // Narkotikaorden saknades helt. En granskning körde riktiga meningar genom
  // parsern och fem av nio drogkontroller blev vanliga polisrapporter på
  // kartan: "Polisen har narkotikakontroll på Vasagatan" bland dem. Regeln
  // såg absolut ut i kommentaren ovan och var det inte i koden.
  'narkotikakontroll', 'narkotika', 'narko', 'droger', 'drogsök', 'drogsok',
  'drogsökhund', 'drogsokhund', 'drogrelaterad',
];

/*
 * Stavningar som ska fångas var de än står i meningen.
 *
 * SOBRIETY_WORDS matchas med includes() och fångar därför ihopskrivet, men
 * bara exakt de böjningar som råkar stå i listan. Att jaga böjningar är ett
 * förlorat lopp — det var precis så "narkotikakontroll" kunde saknas medan
 * "drogkontroll" fanns.
 *
 * Notera att "drog" INTE står här. Det är också imperfekt av "dra", och
 * "polisen drog vidare" är en avblåsning, inte en kontroll. Det ordet fångas
 * i stället av isärskrivningsregeln nedan ("drog kontroll"), där nästa ord
 * avgör vilken betydelse det är.
 */
const SOBRIETY_STAMMAR = [
  'nykter', 'alkohol', 'alko', 'promille', 'rattfyll',
  'utandnings', 'sållnings', 'sallnings',
  'narkotika', 'narko', 'droger', 'drogsök', 'drogsok',
];

/**
 * Förled som gör en "kontroll" till en nykterhets- eller drogkontroll när de
 * står som eget ord före den.
 *
 * Svenskan skrivs ihop, men folk särskriver ständigt — och röstigenkänning
 * gör det nästan alltid. "Alkohol kontroll vid rondellen" är samma sak som
 * "alkoholkontroll", men bara det ena ordet fanns i listan ovan. Den
 * isärskrivna varianten gick alltså rakt igenom och blev en vanlig kontroll
 * på kartan, för alla.
 *
 * Ett testsvep hittade det. Regeln fanns, den var bara lättare att gå runt
 * än den såg ut.
 */
const SOBRIETY_PREFIX = [
  'alkohol', 'alko', 'nykterhets', 'nykterhet', 'promille', 'rattfylleri',
  'rattfylla', 'drog', 'droger', 'utandnings', 'sållnings', 'sallnings',
  'narkotika', 'narko',
];
const SOBRIETY_HEAD = ['kontroll', 'kontroller', 'test', 'prov', 'kollar', 'koll'];

/*
 * Bindestreck skiljer ord, inte bara blanksteg.
 *
 * normalize() i util.js behåller bindestreck med flit — gatunamn som
 * "Stora Gatan-korsningen" ska hålla ihop. Men det gjorde att
 * "drog-kontroll" blev ETT ord: ordlistan matchade det inte, och
 * isärskrivningsregeln som letar efter två ord bredvid varandra hittade
 * inget att ställa bredvid. Skrivsättet gick alltså rakt igenom båda
 * spärrarna samtidigt.
 *
 * Nykterhetskontrollen får därför sin egen orduppdelning, som också delar på
 * bindestreck, snedstreck, punkt och understreck. Det gäller bara den här
 * kontrollen — resten av parsern ser texten som förut.
 */
const SKILJETECKEN = /[\s\-–—_/.]+/;

/** Är det här en nykterhets- eller drogkontroll? Då rapporteras den inte. */
export function isSobrietyCheck(raw) {
  const text = normalize(raw);
  if (!text) return false;
  const words = text.split(SKILJETECKEN).filter(Boolean);
  // Samma text utan skiljetecken alls, så "drog-kontroll" också hittas av
  // ordlistan och inte bara av regeln nedan.
  const hopskrivet = text.replace(/[\s\-–—_/.]+/g, '');

  if (SOBRIETY_WORDS.some(w => words.includes(w) || text.includes(w) || hopskrivet.includes(w))) return true;
  if (SOBRIETY_STAMMAR.some(s => words.some(w => w.startsWith(s)) || hopskrivet.includes(s))) return true;

  // Isärskrivet: förled + huvudord som två ord bredvid varandra.
  for (let i = 0; i < words.length - 1; i++) {
    if (SOBRIETY_PREFIX.includes(words[i]) && SOBRIETY_HEAD.includes(words[i + 1])) {
      return true;
    }
  }
  return false;
}

// Fraser som gör hela inlägget till brus
const NOISE_PHRASES = ['någon som vet', 'vet någon', 'stämmer det', 'är det någon kvar',
                       'säljes', 'köpes', 'bortsprungen', 'efterlyst', 'grattis'];
const NOISE_WORDS = ['tack', 'tackar', 'okej', 'grattis', 'säljes', 'köpes', 'katt', 'hund'];

// Ord som ska bort innan platsnamnet plockas ut
const STOPWORDS = new Set([
  'vid', 'på', 'i', 'utanför', 'mot', 'runt', 'kring', 'nere', 'uppe', 'bakom', 'framför', 'från',
  'står', 'stod', 'sitter', 'satt', 'ligger', 'finns', 'är', 'var', 'nu', 'just', 'precis', 'åt', 'håll',
  'en', 'ett', 'den', 'det', 'de', 'dom', 'och', 'samt', 'med', 'har', 'hade', 'ser', 'såg', 'kvar',
  'varning', 'varnar', 'obs', 'info', 'tips', 'akta', 'se', 'upp', 'kolla', 'observera', 'pass',
  'nyss', 'sedan', 'sen', 'igen', 'också', 'även', 'typ', 'ca', 'cirka', 'ungefär', 'liksom',
  'gubbarna', 'gubbar', 'grabbar', 'killar', 'folk', 'någon', 'nån', 'dem', 'dej', 'er', 'oss',
]);

// Ord som antyder vägkontext — höjer förtroendet men är inte platsen i sig
const DIRECTION_HINTS = new Set(['norrut', 'söderut', 'österut', 'västerut', 'infart', 'avfart',
  'påfart', 'avfarten', 'påfarten', 'rondellen', 'rondell', 'korsningen', 'bron', 'rampen']);

// Aldrig en del av ett platsnamn: väckningsord, "borta"-ord och sådant folk
// lägger till om fordonet ("mörk volvo", "vit skåpbil").
const NOT_A_PLACE = new Set([
  ...CLEAR_WORDS, 'ihop',
  'hej', 'hallå', 'okej', 'vakt', 'hey',
  'mörk', 'mörkblå', 'ljus', 'vit', 'svart', 'grå', 'blå', 'röd', 'silver',
  'bil', 'bilen', 'skåpbil', 'volvo', 'passat', 'golf', 'bmw', 'audi', 'buss',
]);

/* ---- Hjälpare -------------------------------------------------------- */

/** Hittar första typordet. Flerordsfraser matchas mot hela texten. */
function findType(text, words) {
  const set = new Set(words);
  for (const group of TYPE_WORDS) {
    for (const w of group.words) {
      const hit = w.includes(' ') ? text.includes(w) : set.has(w);
      if (hit) return { type: group.type, word: w };
    }
  }
  return null;
}

const hasAnyWord = (words, list) => list.some(w => words.includes(w));
const hasAnyPhrase = (text, list) => list.some(p => text.includes(p));

/**
 * Platsfrasen är det som blir kvar när typord, stoppord och skräp plockats
 * bort. Ordningen behålls så "hammarby rampen" förblir "hammarby rampen".
 */
function extractPlace(words) {
  const kept = [];
  for (const w of words) {
    if (ALL_TYPE_WORDS.has(w)) continue;
    if (STOPWORDS.has(w)) continue;
    if (NOT_A_PLACE.has(w)) continue;
    if (/^\d{1,2}[:.]\d{2}$/.test(w)) continue;      // klockslag
    if (/^\d+$/.test(w) && w.length > 3) continue;   // långa sifferklumpar
    kept.push(w);
  }
  return kept.join(' ').trim();
}

/* ---- Publikt API ----------------------------------------------------- */

/**
 * @returns {null | {
 *   intent: 'report'|'clear',
 *   type: 'police'|'camera'|'control'|'unmarked',
 *   place: string,          // rå platsfras, ska geokodas
 *   confidence: number,     // 0-1
 *   raw: string
 * }}
 */
export function parseReportText(raw) {
  const text = normalize(raw);
  if (!text || text.length < 3) return null;

  // Före allt annat: nykterhetskontroller släpps aldrig igenom, oavsett om de
  // kommer från rösten, en knapp eller Facebook-gruppen.
  if (isSobrietyCheck(text)) {
    return { intent: 'refused', reason: 'sobriety', raw: String(raw).trim() };
  }

  const words = text.split(' ');
  const t = findType(text, words);
  if (!t) return null;

  // Fartkameror rapporteras inte av användare. De står still, de finns redan
  // i appen med rätt koordinat och mätriktning, och en handmarkerad kamera
  // hamnar nästan alltid några hundra meter fel — vilket är värre än ingen
  // markering alls.
  if (t.type === 'camera') {
    return { intent: 'refused', reason: 'camera', raw: String(raw).trim() };
  }

  // Frågor och skvaller är inte varningar
  if (hasAnyPhrase(text, NOISE_PHRASES)) return null;
  if (hasAnyWord(words, NOISE_WORDS) && words.length < 5) return null;

  const intent = hasAnyWord(words, CLEAR_WORDS) ? 'clear' : 'report';
  const place = extractPlace(words);

  // Förtroende: en tydlig plats och ett kort inlägg är ett bra tecken.
  // Långa inlägg är oftast diskussion, inte varning.
  let confidence = 0.5;
  if (place.length >= 3) confidence += 0.3;
  if (words.length <= 8) confidence += 0.1;
  else if (words.length > 25) confidence -= 0.2;
  if (t.type === 'camera' || t.type === 'control') confidence += 0.05;
  if (words.some(w => DIRECTION_HINTS.has(w))) confidence += 0.05;

  return {
    intent,
    type: t.type,
    place,
    confidence: Math.max(0, Math.min(1, confidence)),
    raw: String(raw).trim(),
  };
}

/** Etikett på svenska för en typ. */
export const TYPE_LABEL = {
  police:   'Polis',
  camera:   'Fartkamera',
  control:  'Trafikkontroll',
  unmarked: 'Civil polisbil',
};

/** Vad rösten säger. */
export const TYPE_SPOKEN = {
  police:   'polis',
  camera:   'fartkamera',
  control:  'trafikkontroll',
  unmarked: 'civil polisbil',
};

export const TYPE_ICON = {
  police:   '🚓',
  camera:   '📷',
  control:  '🛑',
  unmarked: '🚗',
};
