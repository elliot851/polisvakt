// Tolkar fritext (Facebook-inlägg eller talat kommando) till en rapport.
// Används av både röstkommandon och Facebook-ingesten.
//
// Matchningen är ordbaserad, inte regexbaserad. Texten normaliseras till rena
// gemener utan skiljetecken och delas i ord, sedan jämförs varje ord mot
// listorden med matchaOrd() nedan. Det gör att "Polis!" och "polis" behandlas
// lika utan att vi behöver bygga regexar av användarens ord — och en enda
// felaktig escape i en regex skulle tyst svälja varje varning.
//
// Ett ord träffar även när det är en sammansättning ("trafikkamera") eller en
// bestämd form ("poliskontrollen"). Fram till 2026-08-22 jämfördes hela ord
// mot hela ord, och då försvann varje sammansättning tyst. Se den långa
// motiveringen vid Ordmatchning längre ner.

import { normalize } from './util.js';

/* ---- Ordlistor ------------------------------------------------------- */

const TYPE_WORDS = [
  // Ordningen är kvar som tie-break, men den avgör inte längre ensam: findType
  // väger träffens KVALITET först (exakt slår böjning slår sammansättning).
  // Annars hade "Polisen står vid Hälla med kroppskameror" blivit en vägrad
  // kameraträff i stället för en polisvarning, just för att kameragruppen
  // står först.
  { type: 'camera',   words: ['fartkamera', 'fartkameror', 'atk', 'trafiksäkerhetskamera',
                              // 'kameror' står som eget ord för att kamera->kameror är en
                              // oregelbunden plural: "trafikkameror" slutar inte på "kamera".
                              'kamera', 'kameror',
                              // 'kamerasläp' och 'kameravagn' är huvudfinala på "släp"
                              // respektive "vagn" — inte på "kamera". Ändelsematchningen
                              // når dem alltså aldrig, precis som den inte når
                              // 'blåljusbil', och "Kamerasläp vid Tortuna" försvann tyst.
                              // De två orden betyder dessutom entydigt en FLYTTBAR
                              // fartkamera; MOBILA_TYPORD nedan gör dem till kamera:'mobil'
                              // utan att något mobilord behöver stå bredvid.
                              'kamerasläp', 'kameravagn'] },
  { type: 'control',  words: ['trafikkontroll', 'fartkontroll', 'hastighetskontroll',
                              'laserkontroll', 'poliskontroll', 'kontroll', 'razzia', 'laser'] },
  { type: 'unmarked', words: ['civilbil', 'civilbilar', 'civilpolis', 'civilpoliser', 'civil polis',
                              'civila bilar', 'civil', 'civila'] },
  { type: 'police',   words: ['polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
                              // 'blåljusbil' är huvudfinalt på "bil", inte på "blåljus", och
                              // kan därför inte nås av en ändelsematchning på 'blåljus'.
                              // Prefixmatchning vore priset — se motiveringen nedan — så
                              // ordet står i stället här.
                              'snuten', 'blåljus', 'blåljusbil', 'piket', 'mc-polis',
                              'motorcykelpolis'] },
];

// Ord som betyder "faran är över" -> rensa istället för att skapa
//
// De här matchas fortfarande ord mot ord, med flit. Ett för brett
// avblåsningsord GÖR INTE en rapport av något — det gör om en rapport till en
// släckning, alltså tar bort en varning som finns. Riktningen är farligare än
// den för typorden, och ingen mätning har visat att den behövs.
const CLEAR_WORDS = ['borta', 'åkte', 'åkt', 'iväg', 'försvunnit', 'försvann', 'fritt',
                     'lugnt', 'avblåst', 'packat', 'tomt'];

/* ---- Ordmatchning ----------------------------------------------------- */

/*
 * VARFÖR ÄNDELSEMATCHNING — OCH VAD SOM VALDES BORT
 *
 * Mätt i drift 2026-08-22 kl 16:16: "Står en mobil trafikkamera vid första
 * avfarten Hälla om man kommer från Stockholm" försvann tyst. Ordlistan hade
 * 'kamera', inlägget sade 'trafikkamera', och matchningen jämförde hela ord
 * mot hela ord. Samma hål gällde varje bestämd form: fartkameran,
 * poliskontrollen, polisbilen, civilbilen, poliserna.
 *
 * Svenska sammansättningar är HUVUDFINALA — huvudordet står sist.
 * "trafikkamera" slutar på "kamera", "poliskontrollen" slutar på
 * "poliskontroll" plus en böjningsändelse. Därför matchar vi BAKIFRÅN: ett ord
 * i texten träffar ett listord om det slutar på listordet, eventuellt med en
 * ändelse ur en sluten lista.
 *
 * Valt bort 1 — delsträng (includes). Den fångar allt ändelsematchningen
 * fångar och därtill orden där vårt listord står FÖRST och betydelsen är en
 * annan: "polisanmälan", "kameraövervakning", "civilstånd", "kontrollant".
 * Nykterhetsfiltret använder delsträng med flit, men där är riktningen den
 * omvända: ett falskt utslag där betyder bara att en rapport inte blir av,
 * medan ett falskt utslag här sätter en varning på kartan där det inte står
 * någon polis.
 *
 * Valt bort 2 — prefixmatchning (startsWith). "kontroll" hade då fångat
 * "kontrollera", "kontrollerade" och "kontrollant" direkt. Priset för att
 * välja bort den är att vänstersammansättningar som "blåljusbil" inte kan
 * härledas; de orden står i stället som egna listord.
 *
 * Valt bort 3 — stemming eller morfologibibliotek. Mer kod än hela parsern,
 * och varje fel i den blir en tyst felmatchning i drift. Den slutna
 * ändelselistan nedan går att läsa och bevisa på en skärm.
 *
 * Tre spärrar håller nätet från att bli för brett, var och en motiverad där
 * den står: ENDAST_EXAKT, INGEN_SAMMANSATTNING och FEL_FORLED.
 */

/*
 * Böjningsändelser. Sluten lista, och det är hela poängen.
 *
 * Här står INTE -era, -erar, -erat, -erad, -ering. Det är exakt skillnaden
 * mellan "kontrollen" (en kontroll) och "kontrollera" (att granska något).
 * Tomma strängen först betyder "ren sammansättning, ingen ändelse".
 */
const BOJNINGAR = ['', 'n', 'en', 'et', 'er', 'ar', 'or', 'na', 'ns', 'ens', 'ets', 's',
                   'erna', 'arna', 'orna', 'ernas', 'arnas', 'ornas'];

/*
 * Ord som bara får matcha exakt.
 *
 * 'atk' är tre bokstäver och en förkortning — allt utom exakt likhet är en
 * olycka som väntar ("matkasse", "flatkant").
 *
 * 'laser' är värre. "blaser" — ASCII-formen av "blåser", som folk skriver på
 * tangentbord utan prickar — SLUTAR på "laser". En ändelsematchning hade gjort
 * ett blåsprov till en trafikkontroll på kartan. Ordet räddas i dag av att
 * nykterhetsspärren körs före typmatchningen, men en spärr som håller enbart
 * tack vare ordningen mellan två andra rader är ingen spärr.
 */
const ENDAST_EXAKT = new Set(['atk', 'laser']);

/*
 * Huvudord som är för generiska för att bära en sammansättning.
 *
 * "kontroll" är svenskans mest återanvända huvudord: biljettkontroll,
 * parkeringskontroll, gränskontroll, besiktningskontroll, dopingkontroll,
 * fjärrkontroll, egenkontroll, passkontroll. Inget av dem är polis på vägen,
 * och en blocklista över förled hade aldrig blivit färdig.
 *
 * De sammansättningar vi faktiskt vill ha står redan som egna listord
 * (trafikkontroll, fartkontroll, hastighetskontroll, laserkontroll,
 * poliskontroll) och får sina böjningar därifrån: "poliskontrollen" är
 * 'poliskontroll' + 'en'.
 *
 * SPÄRREN GÄLLER OCKSÅ BÖJNINGAR, inte bara sammansättningar.
 * Den satt först bara i godkantForled(), alltså efter böjningsgrenen i
 * matchaOrd, och då matchade 'kontroll' plötsligt "kontrollen",
 * "kontrollerna" och "kontrollernas". Bestämd form är den vanligaste formen i
 * löpande text, och "tappade kontrollen" betyder herravälde, inte kontroll:
 * "Föraren tappade kontrollen och körde av vägen vid Tortuna" blev en
 * publicerad trafikkontroll med röstnotis på en olycksplats. Olycksinlägg med
 * just den frasen är bland det vanligaste som postas i en trafikgrupp.
 *
 * Priset är den nakna meningen "Kontrollen vid Hälla", som inte längre blir
 * en rapport. Alla varianter vi faktiskt vill ha står som egna listord.
 */
const INGEN_SAMMANSATTNING = new Set(['kontroll', 'kontroller']);

/*
 * Kortare förled än så är oftast ingen sammansättning alls utan en bokstav
 * som råkar stå före ordet ("b" + "laser"). Bindestreck räknas inte med.
 */
const MIN_FORLED = 3;

/*
 * Förled som gör sammansättningen till något annat än en vägvarning.
 *
 * Kameraorden är de farligaste, för en kameraträff VÄGRAS: en falsk
 * kameraträff raderar alltså en rapport i stället för att skapa en. "Polisen
 * står vid Hälla med kroppskameror" ska bli en polisvarning, inte tystnad.
 * Rangordningen i findType() fångar det fallet också (exakt 'polisen' slår
 * sammansatt 'kameror'), men när priset för ett misstag är en utebliven
 * varning är två spärrar rätt.
 *
 * Foge-s stryks före uppslaget, så 'övervaknings' hittas som 'övervakning'.
 */
const KAMERA_FEL_FORLED = [
  'övervakning', 'overvakning', 'säkerhet', 'sakerhet', 'webb', 'web', 'dash', 'back',
  'bak', 'front', 'vilt', 'jakt', 'kropp', 'mobil', 'telefon', 'video', 'action',
  'digital', 'system', 'reserv', 'drönar', 'dronar', 'film', 'foto', 'natur', 'fågel',
  'fagel', 'skol', 'butik', 'dörr', 'dorr', 'port', 'ring', 'spel',
];
const FEL_FORLED = {
  kamera: KAMERA_FEL_FORLED,
  kameror: KAMERA_FEL_FORLED,
  fartkamera: KAMERA_FEL_FORLED,
  fartkameror: KAMERA_FEL_FORLED,
  'trafiksäkerhetskamera': KAMERA_FEL_FORLED,
  // "metropolis", "akropolis" och "nekropolis" slutar på 'polis' utan att ha
  // det minsta med polis att göra.
  polis: ['metro', 'akro', 'nekro', 'necro', 'megalo', 'kosmo'],
};

/** Duger förledet, eller är sammansättningen något helt annat? */
function godkantForled(forled, listord) {
  // INGEN_SAMMANSATTNING testas inte här längre utan överst i matchaOrd, så
  // att spärren också gäller böjningsgrenen. Se motiveringen vid listan.
  const rent = forled.replace(/[-_]+$/, '');
  if (rent.length < MIN_FORLED) return false;
  const fel = FEL_FORLED[listord];
  if (!fel) return true;
  const utanFogeS = rent.endsWith('s') ? rent.slice(0, -1) : rent;
  return !fel.includes(rent) && !fel.includes(utanFogeS);
}

/**
 * Matchar ETT ord ur texten mot ETT listord.
 *
 * Samma funktion används av findType (vad är det här för rapport?) och av
 * extractPlace (vilka ord är typord och ska bort ur platsfrasen?). Att de
 * delar funktion är inte en städning utan ett krav: gick de isär skulle
 * "trafikkamera" bli både typ OCH plats, platsen få full platsbonus på ett
 * inlägg utan plats, och geokodningen få en skräpsträng att slå upp.
 *
 * @returns {'exakt'|'bojning'|'sammansatt'|null}
 */
function matchaOrd(ord, listord) {
  if (!ord || !listord) return null;
  if (ord === listord) return 'exakt';
  // Båda spärrarna står FÖRE böjningsloopen. De har olika skäl (se listorna)
  // men samma verkan här: ett för generiskt eller för kort listord får bara
  // träffa sig självt — varken böjt eller sammansatt.
  if (ENDAST_EXAKT.has(listord) || INGEN_SAMMANSATTNING.has(listord)) return null;

  let basta = null;
  for (const andelse of BOJNINGAR) {
    const form = listord + andelse;
    if (ord.length < form.length) continue;
    if (ord === form) return 'bojning';        // andelse kan aldrig vara '' här
    if (!ord.endsWith(form)) continue;
    if (godkantForled(ord.slice(0, ord.length - form.length), listord)) basta = 'sammansatt';
  }
  return basta;
}

/**
 * Exakt ord eller böjning av det — men aldrig en sammansättning.
 *
 * Egen jämförelse, INTE matchaOrd(). Skillnaden är avsiktlig: matchaOrd bär
 * typordens spärrar (ENDAST_EXAKT, INGEN_SAMMANSATTNING), och de finns för
 * att hålla nätet som SKAPAR rapporter smalt. Den här funktionen används av
 * nykterhetsspärren, som ska vara bred. Gick de via samma väg skulle
 * 'kontroll' i INGEN_SAMMANSATTNING plötsligt göra att "drog kontrollen" och
 * "nykterhets kontrollerna" slapp igenom — en spärr mot falska rapporter
 * hade tyst rivit hål i produktregeln.
 */
const arBojningAv = (ord, bas) => {
  if (!ord || !bas) return false;
  if (ord === bas) return true;
  return BOJNINGAR.some(a => a && ord === bas + a);
};

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
  /*
   * Blås-orden utan svenska tecken.
   *
   * "sållnings" fick sin ASCII-form "sallnings" när narkotikaorden lades
   * till, men blås-orden glömdes. Alltså gick "blaser i vasteras" igenom
   * medan "blåser i Västerås" stoppades — samma mening, olika tangentbord.
   * Folk skriver utan prickar på gamla telefoner, i bilen, och när
   * autokorrigeringen står på engelska.
   *
   * "blas" ensamt står INTE här. Det är för kort och för nära vanliga ord
   * ("blast", engelska "blase"), och en spärr som vägrar riktiga
   * polisrapporter kostar också liv. Böjningarna räcker.
   */
  'blaser', 'blasa', 'blaste', 'blasning', 'blåsning',
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
  // 'nyckter' är felstavningen av 'nykter' och är med flit med: den är inget
  // svenskt ord, alltså kostar den ingenting, och utan den gick
  // "Nyckterhetsrazzia vid Bäckby" förbi hela stamlistan.
  'nykter', 'nyckter', 'alkohol', 'alko', 'promille', 'rattfyll',
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
/*
 * Huvudorden matchas med arBojningAv(), inte med exakt likhet.
 *
 * MÄTT HÅL, samma dag som kameran försvann: "Polisen har drog kollen på E18"
 * blev en vanlig polisrapport. 'drog' är med flit inget stamord, och 'kollen'
 * fanns inte i listan — bara 'koll'. Bestämd form saknades genomgående:
 * kontrollen, kontrollerna, testet, testerna, provet, proven, kollen.
 *
 * Att räkna upp dem för hand hade lagat de sju formerna och missat nästa.
 * Samma böjningslista som typorden använder täcker dem alla, och den växer
 * med typorden i stället för att halka efter dem. Sammansättningar tas inte
 * med här: huvudordet står redan sist i det som ska matchas.
 *
 * VARFÖR LISTAN VÄXTE I SAMMA ÄNDRING SOM TYPORDEN
 *
 * Reglerna 3 och 4 finns i praktiken bara för ordet 'drog'. Alla andra förled
 * är också stammar och fångas en rad tidigare. Frågan är alltså den enkla:
 * vilket ord efter "drog" gör det till en drogkontroll?
 *
 * Listan hade sex svar och behövde fler, för breddningen av typorden gav dem
 * betydelse. Ett exempel som mättes: 'razzia' står som typord i
 * control-gruppen, och sedan matchaOrd löser sammansättningar blir
 * "Drograzzia vid Erikslund" en publicerad trafikkontroll med notis och
 * uppläsning — förut gav samma mening ingenting alls, av ren tur. Samma sak
 * för "Drogpolisen står vid Erikslund" ('polis') och "Drogpiketen vid Bäckby"
 * ('piket'). Serverns migration hade redan pekat ut razzia, sök och hund.
 *
 * PRISET, uträknat och accepterat: "Nu drog polisen från Erikslund" vägras,
 * eftersom 'drog' + 'polisen' inte går att skilja från drogpolisen. Det är en
 * AVBLÅSNING som tystnar, alltså en varning som ligger kvar sin TTL ut —
 * aldrig en varning som uteblir. Samma pris som servern redan tagit för
 * 'hund' ("polisen drog hunden ur bilen"). En utebliven avblåsning väger
 * lättare än en spridd drogkontroll, och riktningen är hela regeln.
 */
const SOBRIETY_HEAD = ['kontroll', 'kontroller', 'test', 'prov', 'kollar', 'koll',
                       'razzia', 'sök', 'sok', 'hund', 'polis', 'poliser', 'piket'];

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

  // Isärskrivet: förled + huvudord som två ord bredvid varandra. Båda leden
  // får nu vara böjda ("nykterhets kontrollen", "drog testet", "alko proven").
  // Förr krävdes exakt likhet i båda leden, och då räckte ett -en för att gå
  // förbi hela spärren.
  for (let i = 0; i < words.length - 1; i++) {
    const forled = SOBRIETY_PREFIX.some(f => arBojningAv(words[i], f));
    if (forled && SOBRIETY_HEAD.some(h => arBojningAv(words[i + 1], h))) return true;
  }

  /*
   * Hopskrivet: förled + huvudord i ETT ord, där huvudordet är böjt.
   *
   * "drogkollen" gick igenom allt annat: 'drog' är inget stamord (det är
   * också imperfekt av "dra"), 'drogkoll' står inte i ordlistan, och regeln
   * ovan letar efter två ord. Här delas ordet i stället vid förledet och
   * resten prövas som huvudord. Foge-s stryks, så "alkoholskontroll" också
   * hittas.
   *
   * Att i stället lägga in 'drog' som stamord vore att vägra "polisen drog
   * vidare från Skiljebo" — en avblåsning, inte en kontroll. Det är därför
   * nästa ordled får avgöra betydelsen, precis som i isärskrivningsregeln.
   */
  for (const w of words) {
    for (const f of SOBRIETY_PREFIX) {
      if (w.length <= f.length || !w.startsWith(f)) continue;
      const rest = w.slice(f.length).replace(/^s/, '');
      if (SOBRIETY_HEAD.some(h => arBojningAv(rest, h))) return true;
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
  // Räkneorden kom med driftfallet: "vid FÖRSTA avfarten Hälla" gav platsen
  // "första hälla", som ingen geokodning hittar.
  'första', 'andra', 'tredje', 'fjärde', 'femte', 'sista',
  'man', 'du', 'ni', 'jag', 'vi', 'kommer', 'kör', 'åker', 'svänger', 'sväng', 'av',
  // Tidsorden och de vanligaste fyllnadsorden. De är aldrig en plats, och
  // förr blev de det: "Poliskontroll idag som ligger vid Hälla" gav platsen
  // "idag", eftersom ordet både överlevde rensningen och utlöste
  // bisatsgränsen innan ortnamnet hann läsas.
  'idag', 'dag', 'imorgon', 'ikväll', 'inatt', 'igår', 'pågår', 'ute', 'fortfarande',
  // Klockan skrivs ut lika ofta som den skrivs med siffror. Siffrorna tas om
  // hand av klockslagsregeln i extractPlace, orden här.
  'kl', 'klockan',
  // Ur det mätta inlägget "Polis för andra gången idag Emausskolan 13.45 stan".
  // 'andra' och 'idag' fanns redan; 'för' och 'gången' följde med in i
  // platsfrasen och gjorde den oslagbar.
  'för', 'gången', 'gånger', 'till',
  // Fler verb i samma familj som 'står'/'kör'. Ett verb är aldrig en plats,
  // och riktningen är ofarlig: ett ord för mycket här kan bara göra
  // platsfrasen kortare, aldrig fel.
  'stannar', 'stannat', 'passerar', 'passerade',
]);

/*
 * Ord som inleder en bisats. Efter dem beskriver meningen något annat än var
 * polisen står — oftast vem som ser den eller varifrån man kommer.
 *
 * Driftfallet slutar med "...avfarten Hälla OM MAN KOMMER FRÅN STOCKHOLM".
 * Utan den här gränsen hamnar Stockholm i platsfrasen, och geokodningen får
 * välja mellan två städer.
 *
 * Gränsen gäller bara när vi redan fått något att gå på. "Polisen SOM står
 * vid Hälla" börjar med bisatsordet, och där är det bara ett stoppord.
 */
const KLAUSULORD = new Set(['om', 'när', 'ifall', 'eftersom', 'medan', 'som', 'men']);

/*
 * Ord som gör en kamera flyttbar. Se kameraregeln i parseReportText().
 *
 * Exakta ord med flit, ingen prefixmatchning: "jag såg den i mobilen" skulle
 * annars göra varje fast fartkamera till en mobil.
 *
 * ORDET MÅSTE STÅ INTILL KAMERAORDET. Regeln letade först efter dem var som
 * helst i inlägget, och det räckte med ett enda för att göra en FAST kamera
 * till en publicerad trafikkontroll med 60 minuters TTL och röstnotis:
 *   "Fartkameran vid Bäckby blixtrade, jag har bilden i min mobil"
 *   "Nya fartkameran vid Erikslund, se den tillfälliga skylten"
 *   "Trafikkameran vid Skiljebo, jag stod med släpet bakom"
 * Alla tre mättes över tröskeln 0,65. Orden betyder något helt annat på
 * avstånd från kameraordet — telefonen, skylten, släpet bakom bilen — men
 * "mobil trafikkamera" och "fartkamera i skåpbil" är entydiga.
 */
const MOBIL_KAMERA_ORD = new Set([
  'mobil', 'mobila', 'mobilt', 'flyttbar', 'flyttbara', 'flyttbart',
  'tillfällig', 'tillfälliga', 'tillfälligt', 'skåpbil', 'skåpbilen',
  'släpvagn', 'släpet', 'kameravagn', 'kamerasläp', 'trailer',
]);

/*
 * Ord som säger motsatsen. Står något av dem intill kameraordet är kameran
 * fast, hur många mobilord som än står längre bort i meningen.
 */
const FAST_KAMERA_ORD = new Set(['fast', 'fasta', 'fastmonterad', 'fastmonterade']);

/*
 * Listord som ÄR en mobil kamera i sig. Här behövs inget grannord alls —
 * ett kamerasläp är aldrig en fast anläggning.
 */
const MOBILA_TYPORD = new Set(['kamerasläp', 'kameravagn']);

/*
 * Hur långt från kameraordet ett mobilord får stå.
 *
 * Två ord, inte ett: "fartkamera I skåpbil" och "kamera PÅ ETT släp" har ett
 * eller två småord emellan. Tre hade börjat plocka upp nästa sats.
 */
const KAMERA_FONSTER = 2;

/** Står något ord ur mängden inom fönstret runt ordet på plats idx? */
function narOrdet(words, idx, mangd) {
  if (!(idx >= 0)) return false;
  const forsta = Math.max(0, idx - KAMERA_FONSTER);
  const sista = Math.min(words.length - 1, idx + KAMERA_FONSTER);
  for (let i = forsta; i <= sista; i++) {
    if (i !== idx && mangd.has(words[i])) return true;
  }
  return false;
}

// Ord som antyder vägkontext — höjer förtroendet men är inte platsen i sig.
// Böjningarna står utskrivna: matchningen är exakt strängmatchning, så
// 'korsningen' hjälper inte "Hammarby korsning". Det var billigare att skriva
// ut formerna än att bygga en böjningsregel som också måste vara ofarlig.
const DIRECTION_HINTS = new Set(['norrut', 'söderut', 'österut', 'västerut', 'infart', 'avfart',
  'påfart', 'avfarten', 'påfarten', 'infarten', 'rondellen', 'rondell', 'korsningen', 'korsning',
  'bron', 'bro', 'rampen', 'ramp', 'viadukten', 'viadukt', 'trafikplatsen', 'trafikplats',
  'cirkulationsplatsen', 'cirkulationsplats']);

// Aldrig en del av ett platsnamn: väckningsord, "borta"-ord och sådant folk
// lägger till om fordonet ("mörk volvo", "vit skåpbil").
const NOT_A_PLACE = new Set([
  ...CLEAR_WORDS, 'ihop',
  'hej', 'hallå', 'okej', 'vakt', 'hey',
  'mörk', 'mörkblå', 'ljus', 'vit', 'svart', 'grå', 'blå', 'röd', 'silver',
  'bil', 'bilen', 'skåpbil', 'volvo', 'passat', 'golf', 'bmw', 'audi', 'buss',
  // Beskriver utrustningen, inte platsen: "en MOBIL trafikkamera vid Hälla".
  ...MOBIL_KAMERA_ORD, ...FAST_KAMERA_ORD,
  // 'kontroll' står i INGEN_SAMMANSATTNING och plockas därför inte längre
  // bort av arTypord i böjd form. Utan de här raderna skulle "kontrollen"
  // bli en del av platsfrasen som geokodningen får slå upp.
  'kontroll', 'kontrollen', 'kontroller', 'kontrollerna',
]);

/*
 * Ord som gör inlägget till gruppens eget prat i stället för en observation.
 *
 * Gruppens NAMN innehåller ett typord ("Här Står Polisen - Västerås"). Varje
 * jubileums-, välkomst- och regelinlägg som citerar namnet får därför en
 * typordsträff gratis. Mätt 2026-08-22: "Idag firar Här Står Polisen -
 * Västerås 12 år med 18K följare" gav report/police med tilliten 0,80 — över
 * tröskeln 0,65 — och räddades bara av att geokodningen inte hittade
 * skräpsträngen. Det är en systematisk källa till falska varningar, inte en
 * slumpmässig, och den blir farligare i samma stund som platsuttaget blir
 * bättre.
 *
 * Kontrollen är medvetet oberoende av inläggets längd, till skillnad från
 * NOISE_WORDS ovan som bara gäller under fem ord: metainläggen är långa.
 * Inget av orden förekommer i en observation av polis.
 */
const GRUPPMETA_ORD = ['firar', 'firade', 'jubileum', 'följare', 'medlemmar', 'medlem',
  'gruppen', 'gruppens', 'admin', 'administratör', 'moderator', 'välkommen', 'välkomna',
  'regler', 'reglerna', 'påminnelse', 'inlägg', 'inlägget',
  // Gruppens egen regeltext lyder "Man skriver enbart när man ser en
  // poliskontroll." och gav report/control med tilliten 0,95 varje gång en
  // administratör klistrade in den. Ingen som rapporterar polis skriver
  // "skriver".
  'skriver', 'skriv', 'skrivs'];

/* ---- Platsen ensam är en varning -------------------------------------- */

/*
 * GRUPPENS KONVENTION, OCH VARFÖR DEN FÅR STYRA
 *
 * "Här Står Polisen - Västerås" har en enda regel på sin om-sida: "Man
 * skriver enbart när man ser en poliskontroll." Följden är att folk skriver
 * bara platsen, ibland med ett klockslag eller en färdriktning:
 *     Dillos norrgående 11.15
 *     Hemköp Öster Mälarstrand- 16:15
 *     Irstamacken
 *     Vallby vid entrén till Golfklubb.
 * Alla fyra gav ingenting alls: parseReportText kräver ett typord, och inget
 * av inläggen har ett. Fyra av de fem inlägg som föll i mätningen föll här.
 *
 * Priset för att öppna grinden är att "vad som helst" inte får bli polis. En
 * falsk nål lär föraren att strunta i appen, och den går inte att ta
 * tillbaka. Sju krav måste därför vara uppfyllda SAMTIDIGT — alla sju, och
 * det första bär huvudlasten. Tre av dem (3, 4 och 5) skrevs om 2026-08-22
 * efter en mätning som visade att de var för generösa; det står vid vart och
 * ett vad som mättes:
 *
 *   1. Texten måste PEKA UT ETT KÄNT PLATSNAMN (PLATSORD nedan). Det är den
 *      starkaste spärren och den enda som är POSITIV: ett ord vi aldrig sett
 *      kan aldrig bära ett inlägg. Jämför extractPlace, som är ett rent
 *      negativt filter och därför antar att varje okänt ord är ett platsnamn.
 *      Med det kravet blir "texten pekar ut en plats" mätbart i stället för
 *      en känsla.
 *   2. Inlägget måste vara KORT (högst PLATS_MAX_ORD ord). Konventionen är en
 *      lapp, inte ett resonemang.
 *   3. Texten får inte vara en FRÅGA. En fråga är motsatsen till ett
 *      påstående om vad någon just har sett. Frågetecknet räcker inte som
 *      spärr — det utelämnas ofta — så ett frågeord var som helst (FRAGEORD)
 *      och ett finit verb eller frågeord FÖRST i satsen (FRAGEINLEDNING)
 *      fäller inlägget var för sig.
 *   4. Texten måste vara en LAPP, inte en mening. Ett verb eller ett pronomen
 *      (VERB_OCH_PRONOMEN) diskvalificerar direkt: den som skriver "Jag åker
 *      till Erikslund nu" har skrivit en mening, och en mening kan handla om
 *      vad som helst.
 *   5. ALLT ÖVRIGT I TEXTEN måste peka på platsen. Utöver ortnamnet får bara
 *      bindeord och tidsord (PLATS_BINDEORD), avblåsningsord, riktningar,
 *      klockslag och ord som PRECISERAR platsen (PLATSPRECISERING) förekomma
 *      — entrén, macken, Hemköp. Ett enda okänt ord räcker för att avstå. Det
 *      är det som skiljer "Vallby vid entrén till Golfklubb" från "Bra pizza
 *      på Dillos igår" och från "Kö på E18 österut", där platsen bara är var
 *      något annat händer.
 *   6. Klockslag och färdriktning är inget krav men ett STÖD: de beskriver
 *      ett ögonblick och en rörelse, alltså precis vad en observation är, och
 *      ger ett mindre avdrag på tilliten (se parseReportText).
 *   7. Texten får inte innehålla ett typord ens som DELSTRÄNG. Kravet kom ur
 *      provsviten: utan det räddade platsregeln precis de meningar som
 *      typordsmatchningen medvetet vägrar. "Kameraövervakning i garaget på
 *      Vasagatan", "Parkeringskontrollen står på Vasagatan" och "Kontrollerna
 *      av matlådorna på skolan i Bäckby" blev alla polisvarningar, för de har
 *      ett känt ortnamn, är korta och innehåller inget annat ämnesord. Se
 *      motiveringen vid anropet.
 *
 * VALT BORT 1 — data/aliases.vasteras.json som lista. Den är rätt lista för
 * GEOKODNING och fel för det här beslutet. Dels går den inte att nå härifrån:
 * parser.js är synkron och fetch-fri, och bryggan kör på facebook.com där
 * filen inte finns. Dels innehåller den vanliga svenska ord i bestämd form —
 * punkt, gallerian, stationen, centralen, hamnen, arenan, sjukhuset,
 * lasarettet, flygplatsen, abb — och med dem hade "Ses vid stationen" blivit
 * en varning. PLATSORD är därför ett MEDVETET URVAL ur aliasfilen: bara namn
 * som inte betyder något annat på svenska. Grannkommunerna (Sala, Köping,
 * Arboga...) är också borta — konventionen gäller Västerås, och en ensam
 * kommunrubrik är oftare prat än en observation.
 *
 * VALT BORT 2 — att låta tilliten vara spärren. Platsbonusen i confidence är
 * `place.length >= 3` och säger ingenting om huruvida platsen ÄR en plats:
 * "Tack för tipset om polisen vid Erikslund" får 0,90 idag med platsfrasen
 * "tack för tipset". Tillit kan inte grinda det här.
 *
 * VALT BORT 3 — att kräva att INGENTING annat står i texten. Då hade bara
 * enordsinlägget "Irstamacken" räddats, medan "Hemköp Öster Mälarstrand" och
 * "Vallby vid entrén till Golfklubb" fallit. De är lika tydliga för en läsare.
 *
 * KVAR SOM RISK, MEDVETET: ett inlägg som bara är ett platsnamn kan gälla en
 * nykterhetskontroll där ordet står i bilden eller i kommentarerna. Texten
 * innehåller då ingenting för spärren att gå på — isSobrietyCheck kan bara
 * fånga ord som faktiskt är skrivna. Det är ett av skälen till att tolkningen
 * får LÄGRE tillit än ett uttalat påstående (se avdraget i parseReportText):
 * resten av systemet ska kunna behandla den försiktigare.
 */

// Högst så många ord i inlägget. Konventionen är en lapp, inte ett
// resonemang; "Idag firar gruppen 12 år med 18K följare" är fjorton ord.
const PLATS_MAX_ORD = 8;

/*
 * Namn som ensamma får bära ett inlägg. Urval ur data/aliases.vasteras.json
 * enligt VALT BORT 1 ovan: egennamn som inte också är ett gångbart svenskt
 * allmänord, och inga grannkommuner.
 *
 * Medvetet UTELÄMNADE härifrån trots att de står i aliasfilen: punkt,
 * gallerian, resecentrum, centralen, stationen, flygplatsen, hamnen, abb,
 * sjukhuset, lasarettet, mdh, mdu, arenan, 66an, 56an, rv66, rv56, sala,
 * köping, arboga, fagersta, hallstahammar, surahammar, kungsör, norberg,
 * skinnskatteberg, kvicksund.
 */
const PLATSORD = [
  // Stadsdelar och orter i Västerås kommun
  'hälla', 'hälla köpcentrum', 'erikslund', 'erikslundsrondellen', 'rocklunda',
  'hammarby', 'hammarbyrampen', 'bäckby', 'backby', 'vallby', 'pettersberg',
  'råby', 'raby', 'bjurhovda', 'skiljebo', 'malmaberg', 'viksäng', 'viksang',
  'gideonsberg', 'skallberget', 'jakobsberg', 'blåsbo', 'emaus', 'nordanby',
  'önsta', 'gryta', 'hökåsen', 'hokasen', 'skultuna', 'irsta', 'barkarö',
  'tillberga', 'dingtuna', 'badelunda', 'tortuna', 'kungsåra', 'romfartuna',
  'lillhärad', 'gäddeholm', 'johannisberg', 'öster mälarstrand', 'lillåudden',
  // Namngivna hållpunkter. De sex sista skrev gruppen själv i de mätta
  // inläggen, och alla sex saknades i aliasfilen — inlägget kastades då med
  // "okänd-plats". Söksträngarna är tillagda där och provade mot Nominatim
  // 2026-08-22; ingen av dem är gissad.
  'dillos', 'dillos pizzeria', 'abb arena', 'bombardier',
  'apalby', 'apalby ip', 'irstamacken', 'emausskolan',
  'hemköp öster mälarstrand', 'vallby golfklubb', 'vallby golfklubben',
  'västerås golfklubb',
  // Gator och leder
  'stora gatan', 'vasagatan', 'kopparbergsvägen', 'björnövägen', 'bjornovagen',
  'djurgårdsvägen', 'norrleden', 'österleden', 'västerleden', 'bergslagsvägen',
  'köpingsvägen', 'surahammarsvägen', 'pilgatan', 'sigurdsgatan',
  'ängsgärdsgatan', 'e18', 'e18 västerut', 'e18 österut', 'riksväg 66',
  'riksväg 56', 'räta linjen',
];
const PLATSORD_SET = new Set(PLATSORD);
const PLATS_MAX_LED = Math.max(...PLATSORD.map(p => p.split(' ').length));

/*
 * Efterled i sammansatta platsnamn där ORTNAMNET STÅR FÖRST: "Irstamacken" är
 * macken i Irsta, "Vallbyrondellen" rondellen i Vallby.
 *
 * Det är motsatt riktning mot typordsmatchningen (matchaOrd), som bygger på
 * att svenska sammansättningar är huvudfinala. Här är huvudordet just det som
 * INTE är platsen, så matchningen måste gå framifrån — och en prefixmatchning
 * utan en sluten lista över efterled hade gjort varje ord som råkar börja på
 * ett ortnamn till en plats. Listan är därför sluten och kort.
 */
const ORTSLED = new Set([
  'macken', 'mackarna', 'rondellen', 'rondell', 'krysset', 'korset', 'korsningen',
  'torget', 'torg', 'skolan', 'centrum', 'badet', 'hallen', 'kyrkan', 'bron',
  'backen', 'motet', 'avfarten', 'påfarten', 'infarten', 'vägen', 'gatan',
  'gården', 'parken', 'viken', 'udden', 'ip',
]);
// Kortare förled än så vore gissningar: "råby" i "råbygga" är inte Råby.
const ORTSLED_MINLANGD = 5;

/*
 * Ord som gör inlägget till en fråga. En fråga är motsatsen till ett
 * påstående om vad någon just har sett, och NOISE_PHRASES fångar bara de
 * exakta frasvändningar som mätts.
 *
 * MÄTT 2026-08-22: listan var för smal och de saknade orden stod dessutom i
 * STOPWORDS, alltså räknades de AKTIVT som ord som pekar på platsen. "Är
 * någon vid Vallby nu", "Var det vid Vasagatan" och "Nån som är i Irsta nu"
 * blev alla report/police 0,70 och hamnade som nålar på kartan. Felet är
 * självförstärkande: den som frågar gör det ofta för att appen redan visat en
 * nål där, och svaret blev en ny nål på samma plats.
 */
const FRAGEORD = new Set(['vem', 'vad', 'vart', 'varför', 'hur', 'vilken', 'vilket',
  'vilka', 'undrar', 'vet', 'stämmer', 'kanske', 'finns', 'nån', 'någon', 'frågar']);

/*
 * Ord som gör inlägget till en fråga NÄR DE STÅR FÖRST.
 *
 * Frågetecknet räcker inte: det utelämnas ofta i en snabb mobilkommentar, och
 * FRAGEORD kan bara ta de ord som aldrig betyder något annat. En svensk sats
 * som INLEDS med ett finit verb är däremot nästan alltid en fråga — "Är någon
 * vid Vallby", "Har dom åkt", "Ser ni polisen" — medan ett påstående inleds
 * med satsdelen som bär informationen. Konventionens egna inlägg inleds
 * undantagslöst med platsnamnet.
 *
 * Orden prövas FÖRE stopporden med flit. Flera av dem (var, är, har, ser)
 * står i STOPWORDS, och den listan är byggd för platsUTTAG — där är ett verb
 * bara skräp att stryka, här är det beviset på att någon skrev en mening.
 */
const FRAGEINLEDNING = new Set(['var', 'är', 'ar', 'har', 'hade', 'ser', 'såg', 'finns',
  'kan', 'ska', 'vill', 'vet', 'undrar', 'gör', 'blir', 'kommer', 'får', 'tror', 'verkar',
  'nån', 'någon', 'vem', 'vad', 'vart', 'varför', 'hur', 'vilken', 'vilket', 'vilka',
  'stämmer', 'minns']);

/*
 * Verb och pronomen. Ett enda av dem gör att texten inte längre är en LAPP.
 *
 * Konventionen "platsen ensam betyder polis" gäller lappar: någon skriver var
 * hen ser polisen och inget mer. Den som skriver ett verb har skrivit en
 * mening, och en mening kan handla om vad som helst — "Jag åker till
 * Erikslund nu", "Vi kommer från Skultuna", "Sitter på Max i Erikslund".
 *
 * MÄTT 2026-08-22, och det är därför listan finns: krav 4 nedan använde
 * STOPWORDS som godkännandelista. Den listan är byggd för det MOTSATTA
 * ändamålet — att stryka ord ur en fras som redan har ett typord — och
 * innehåller därför jag, vi, man, är, kommer, kör, ser, kolla. Vänd om till
 * en positiv grind blev varje vardaglig mening med ett ortnamn i en
 * polisvarning: 13 av 30 provade vardagsmeningar gav report/police 0,70, alla
 * med en aliasnyckel som geokodar rent — alltså riktiga nålar på kartan.
 *
 * Listan är sluten och diskvalificerar direkt. Den kostar ingenting av de
 * fyra mätta måltexterna: ingen av dem innehåller vare sig verb eller
 * pronomen. Avblåsningsorden (CLEAR_WORDS: åkte, borta, fritt) står medvetet
 * INTE här — de är hela poängen med att "Rocklunda fritt nu" ska kunna bli en
 * släckning i stället för en varning.
 */
const VERB_OCH_PRONOMEN = new Set([
  'jag', 'du', 'vi', 'ni', 'man', 'dom', 'de', 'den', 'mig', 'dig', 'oss', 'er', 'dem',
  'är', 'ar', 'var', 'vara', 'har', 'hade', 'kommer', 'kom', 'kör', 'körde', 'åker',
  'sitter', 'satt', 'ligger', 'låg', 'står', 'stod', 'ser', 'såg', 'sett', 'kolla',
  'kollade', 'ses', 'ska', 'skulle', 'vill', 'tänker', 'tror', 'undrar', 'vet', 'gör',
  'blir', 'jobbar', 'bor', 'går', 'gick', 'tar', 'fick', 'får',
]);

/*
 * Ord som PRECISERAR platsen: byggnaden, macken, entrén, kedjan på skylten.
 *
 * De är det enda innehåll utöver själva ortnamnet som ett inlägg får bära.
 * Listan är POSITIV med flit, och den är den andra halvan av krav 5. En
 * negativ ämneslista prövades först ('kö', 'olycka', 'vägarbete'...) och den
 * mätte fel: den släppte igenom "Bra pizza på Dillos igår", "Hej alla i
 * Skultuna" och — värst av allt — "Irsta sållning", eftersom inget av de
 * orden stod på listan. Ett negativt filter kan bara vägra det någon redan
 * tänkt på, och det är precis den svagheten som gör extractPlace opålitlig.
 *
 * Med den positiva vändningen gäller i stället: ALLT i texten måste peka på
 * platsen. Ett enda ord vi inte känner igen räcker för att avstå. Regeln
 * felar därmed åt rätt håll — den tappar tolkningar, den hittar aldrig på
 * dem — och listan växer när nya inlägg mätts, inte när nya risker gissats.
 */
const PLATSPRECISERING = new Set([
  // Delar av en plats
  'entré', 'entrén', 'entren', 'ingången', 'ingång', 'utgången', 'utfarten',
  'parkeringen', 'parkering', 'parkeringsplatsen', 'hållplatsen', 'busshållplatsen',
  'viadukten', 'tunneln', 'gångbron', 'övergångsstället', 'refugen',
  // Anläggningar
  'macken', 'mack', 'bensinmacken', 'laddstationen', 'golfklubb', 'golfklubben',
  'golfbanan', 'skolan', 'förskolan', 'gymnasiet', 'kyrkan', 'badet', 'simhallen',
  'ishallen', 'sporthallen', 'idrottsplatsen', 'torget', 'köpcentret', 'köpcentrum',
  'centrum', 'gallerian', 'affären', 'butiken', 'restaurangen', 'pizzerian',
  'kiosken', 'vårdcentralen', 'industriområdet', 'återvinningen', 'ip',
  // Skyltarna folk går efter
  'hemköp', 'ica', 'coop', 'willys', 'lidl', 'netto', 'maxi', 'city', 'gross',
  'preem', 'circle', 'shell', 'okq8', 'ingo', 'st1', 'tanka', 'biltema', 'jula',
  'systembolaget', 'mcdonalds', 'burger', 'king', 'sibylla', 'max',
]);

/*
 * Färdriktningar som gruppen skriver ut. DIRECTION_HINTS ovan har bara
 * -ut-formerna; konventionen i den här gruppen är -gående. Orden räknas som
 * STÖD för tolkningen (de beskriver en observation i rörelse) och aldrig som
 * ett okänt innehållsord.
 */
const FARDRIKTNING = new Set(['norrgående', 'södergående', 'östergående', 'västergående',
  'norrgaende', 'sodergaende', 'ostergaende', 'vastergaende']);

/*
 * Småord som binder ihop en plats med sin precisering, plus tidsorden.
 *
 * Listan är EGEN och kort med flit, och det är hela skillnaden mot den
 * version som mättes 2026-08-22. Då lydde krav 4 "STOPWORDS eller KLAUSULORD
 * eller PLATS_SMAORD", alltså tre listor byggda för andra ändamål, och
 * summan av dem godkände i praktiken vilken vardaglig mening som helst (se
 * VERB_OCH_PRONOMEN). En godkännandelista måste skrivas för att vara
 * godkännandelista: varje ord här ska gå att läsa som "det här ordet pekar på
 * platsen", ingenting annat.
 *
 * Vad som medvetet INTE står här:
 *   - Verb och pronomen. De diskvalificerar i stället, se VERB_OCH_PRONOMEN.
 *   - Bisatsorden (KLAUSULORD: om, när, som, men). Efter dem beskriver
 *     meningen något ANNAT än var polisen står — det är själva skälet till
 *     att extractPlace bryter på dem — och en lapp har ingen bisats.
 *   - Satsglue: så, att, än, här, där, eller. Samma sak: de bygger meningar.
 */
const PLATS_BINDEORD = new Set([
  // Var i förhållande till platsen
  'vid', 'på', 'i', 'utanför', 'innanför', 'mot', 'runt', 'kring', 'nere', 'uppe',
  'bakom', 'framför', 'bredvid', 'mellan', 'över', 'under', 'efter', 'före',
  'ner', 'upp', 'in', 'ut', 'till', 'från',
  // Bindeord mellan två platsled
  'och', 'samt', 'plus', 'med',
  // Tiden. Klockslagen är nakna tal efter normalize(); orden står här.
  'nu', 'just', 'precis', 'idag', 'ikväll', 'inatt', 'imorgon', 'kl', 'klockan',
  'fortfarande', 'kvar', 'hela',
]);

// Klockslag i RÅtexten. normalize() byter ':' och '.' mot blanksteg, så
// tidsangivelsen är redan sönderdelad när parsern ser den.
const TID_RE = /\d{1,2}[.:]\d{2}/;

// Bindestreck överlever normalize(). "Mälarstrand-" måste matcha nyckeln
// "mälarstrand", annars faller "Hemköp Öster Mälarstrand- 16:15" på ett
// skiljetecken.
const utanBindestreck = w => w.replace(/^-+|-+$/g, '');

// Gatuord som får bära ett husnummer. Samma vokabulär som ADRESS_RE i
// tools/fb-bridge.user.js och $script:AdressRe i tools/brygg-daemon.ps1 —
// listan finns på tre ställen och måste vara samma på alla tre.
const GATUEFTERLED_RE = /(gatan|gata|vägen|gränd|allén|stigen)$/;

/**
 * Bredda en träff med det som står bredvid den och hör till den.
 *
 * TVÅ UTVIDGNINGAR, BÅDA MÄTTA PÅ RIKTIGA GRUPPINLÄGG.
 *
 * 1. SÄRSKRIVEN ALIASNYCKEL. Uppslaget ovan kräver att nyckelns led står som
 *    en SAMMANHÄNGANDE ordföljd. Gruppen skriver dem isär: "Vallby vid entrén
 *    till Golfklubb." ger orden ['vallby','vid','entrén','till','golfklubb'],
 *    och eftersom 'vallby golfklubb' inte är sammanhängande blev platsen
 *    'vallby'. Aliasfilen har raden "vallby golfklubb" just för det här
 *    inlägget, och den nåddes aldrig: nålen hamnade på stadsdelsnoden
 *    59,6225/16,5036 i stället för på golfbanan 59,6278/16,5085 — 651 m fel,
 *    och banan är dessutom 1 532 x 1 250 m, så entrén kan ligga ytterligare
 *    ett par hundra meter därifrån.
 *
 *    Mellanorden måste ALLA vara ord som binder ihop eller preciserar en plats
 *    (PLATS_BINDEORD, PLATSPRECISERING). Ett enda okänt ord emellan och vi
 *    avstår — annars hade "Vallby igår, kompisen bor vid Golfklubb" blivit en
 *    utpekad punkt vid golfbanan. Den sammansatta nyckeln måste dessutom redan
 *    finnas i PLATSORD; regeln hittar aldrig på ett namn.
 *
 * 2. HUSNUMRET. "Polis vid Vasagatan 12" gav platsen 'vasagatan', eftersom det
 *    kända namnet vann och resten av frasen kastades. Följden var att
 *    ADRESS_RE i bryggan aldrig fick se numret och adressvägen var död för
 *    VARJE gata som råkar stå i PLATSORD — alltså precis de gator gruppen
 *    skriver om oftast. Numret följer därför med när namnet slutar på ett
 *    gatuord och nästa ord är ett rent 1-4-siffrigt tal.
 *
 *    Bara efter ett gatuord: "Erikslund 4" är inte en adress, och "Hälla 12"
 *    är ingenting alls. Klockslag är redan sönderdelade av klockslagsindex()
 *    innan extractPlace kommer hit, och platsEnsamSomTyp släpper inte igenom
 *    fler än ett fritt tal.
 */
function utvidga(rena, traff) {
  // 1. Särskriven aliasnyckel.
  for (let j = traff.i + traff.n; j < rena.length; j++) {
    const w = rena[j];
    if (!w) continue;
    const sammansatt = traff.namn + ' ' + w;
    if (PLATSORD_SET.has(sammansatt)) {
      return utvidga(rena, { namn: sammansatt, i: traff.i, n: j - traff.i + 1 });
    }
    if (PLATS_BINDEORD.has(w) || PLATSPRECISERING.has(w)) continue;
    break;
  }

  // 2. Husnumret.
  if (GATUEFTERLED_RE.test(traff.namn)) {
    const idx = traff.i + traff.n;
    const nasta = rena[idx];
    // klockslagsindex() ställer samma fråga som extractPlace redan gör, och
    // svaret måste bli detsamma: "Vasagatan 11 15" är ett klockslag och inte
    // hus nummer elva. platsEnsamSomTyp anropar hittaKandPlats på den RÅA
    // ordföljden, där klockslaget fortfarande står kvar, så kontrollen kan
    // inte lämnas åt anroparen.
    if (nasta && /^\d{1,4}$/.test(nasta) && !klockslagsindex(rena)[idx]) {
      return { namn: traff.namn + ' ' + nasta, i: traff.i, n: traff.n + 1 };
    }
  }
  return traff;
}

/**
 * Hittar det längsta kända platsnamnet i ordföljden.
 * @returns {null | {namn: string, i: number, n: number}} namn = aliasnyckeln,
 *          i = första ordets index, n = antal ord platsen tar upp.
 */
function hittaKandPlats(words) {
  const rena = words.map(utanBindestreck);
  // Längst först: "öster mälarstrand" ska vinna över ett ensamt led.
  for (let n = Math.min(PLATS_MAX_LED, rena.length); n >= 1; n--) {
    for (let i = 0; i + n <= rena.length; i++) {
      const fras = rena.slice(i, i + n).join(' ');
      if (PLATSORD_SET.has(fras)) return utvidga(rena, { namn: fras, i, n });
    }
  }
  /*
   * Sammansättningen prövas SIST och bara när inget helt namn hittats.
   * Namnet som returneras är BASEN, inte hela ordet: "vallbyrondellen" finns
   * inte i aliasfilen, men "vallby" gör det. Nålen hamnar då i stadsdelen i
   * stället för vid rondellen — några hundra meter fel, och ändå oändligt
   * mycket bättre än ingen nål alls.
   *
   * "Irstamacken" var exemplet här tills macken slogs upp och lades in i
   * data/aliases.vasteras.json med en provad söksträng ("Circle K, Irsta").
   * Den vägen är alltid bättre: ett inlagt namn ger rätt koordinat, medan
   * basen bara ger rätt trakt. Faller ett efterled ofta i loggen är svaret
   * att lägga in platsen, inte att bredda den här listan.
   */
  for (let i = 0; i < rena.length; i++) {
    const w = rena[i];
    for (const namn of PLATSORD) {
      if (namn.includes(' ') || namn.length < ORTSLED_MINLANGD) continue;
      if (w.length <= namn.length || !w.startsWith(namn)) continue;
      const efterled = w.slice(namn.length).replace(/^s/, '');   // foge-s
      if (ORTSLED.has(efterled)) return { namn, i, n: 1 };
    }
  }
  return null;
}

/**
 * Gruppens konvention som en syntetisk typordsträff, eller null.
 *
 * Formen är med flit densamma som findType returnerar, så att allt nedanför
 * kroken i parseReportText kan köras oförändrat. Två fält är nya:
 *   plats — aliasnyckeln som matchade. Måste användas i stället för
 *           extractPlace, se motiveringen vid anropet.
 *   stod  — texten bär också ett klockslag eller en färdriktning. Det gör
 *           tolkningen säkrare (någon rapporterar ett ögonblick), och
 *           avdraget på tilliten blir mindre.
 */
function platsEnsamSomTyp(raw, text, words) {
  if (words.length > PLATS_MAX_ORD) return null;
  if (String(raw).includes('?')) return null;

  // Frågeorden prövas FÖRE allt annat, och första ordet prövas mot en egen
  // lista: en sats som inleds med ett finit verb eller ett frågeord är på
  // svenska nästan alltid en fråga, med eller utan frågetecken. Se
  // FRAGEINLEDNING — alla tre mätta fallen saknade frågetecken.
  if (FRAGEINLEDNING.has(utanBindestreck(words[0]))) return null;
  for (const w of words) {
    if (FRAGEORD.has(utanBindestreck(w))) return null;
  }

  /*
   * ETT VERB ELLER ETT PRONOMEN BETYDER ATT NÅGON SKREV EN MENING, och
   * konventionen gäller lappar. Kontrollen står här uppe, före både
   * platsuppslaget och krav 4, av två skäl: den är den billigaste av alla
   * (en mängduppslagning per ord), och den ska gälla ORD FÖR ORD i hela
   * texten — även de ord som något annat filter längre ner råkar godkänna.
   */
  for (const w of words) {
    if (VERB_OCH_PRONOMEN.has(utanBindestreck(w))) return null;
  }

  /*
   * Delsträng, inte matchaOrd — och riktningen är hela poängen.
   *
   * Vi står här bara därför att findType redan sagt nej. Står ett typord ändå
   * i texten betyder det att matchningen AKTIVT valde bort ordet:
   * "kameraövervakning" och "polisanmälan" har listordet först och betyder
   * något annat, "kontrollerna" och "parkeringskontrollen" stoppas av
   * INGEN_SAMMANSATTNING. Alla tre försvann tyst av goda skäl, och
   * konventionsargumentet gäller inte dem: en text som faktiskt handlar om en
   * kontroll av matlådor blir inte en polisobservation av att den nämner
   * Bäckby. Hade skribenten menat polis hade hen skrivit ett ord vi tar emot.
   *
   * Delsträngen är trubbig med flit. Den felar bara åt ett håll — färre
   * platstolkningar, aldrig fler — och en fras som "matkasse" (som råkar bära
   * 'atk') kostar oss en tolkning vi ändå bara gissade oss till.
   */
  if (ALLA_TYPORD.some(w => text.includes(w))) return null;

  const traff = hittaKandPlats(words);
  if (!traff) return null;

  /*
   * ALLT ÖVRIGT I TEXTEN MÅSTE PEKA PÅ PLATSEN. Ett enda ord vi inte känner
   * igen räcker för att avstå — inte "högst två", som en tidigare version
   * tillät. Taket mättes och var för generöst: "Bra pizza på Dillos igår",
   * "Hej alla i Skultuna" och "Irsta sållning" hade alla högst två okända ord
   * och blev polisvarningar. Det sista är det allvarliga: 'sållning' ensamt
   * står inte i nykterhetsspärrens ordlistor, och regeln hade då gjort en
   * nykterhetskontroll till en publicerad polisnål. Nollkravet stänger det
   * hålet utan att röra säkerhetsfiltret.
   *
   * Godtagbart är: stoppord och bisatsord, avblåsningsord (så att "Rocklunda
   * fritt nu" kan bli en AVBLÅSNING i stället för att tystna), riktningar,
   * bindeord, klockslag — och ord som preciserar platsen.
   *
   * NOT_A_PLACE i sin helhet duger INTE som godkännandelista, trots att den
   * ligger nära till hands: den innehåller hälsningsord och bilfärger, och
   * med dem hade "Hej Skultuna" blivit en varning.
   *
   * STOPWORDS duger inte heller, och det var det MÄTTA felet 2026-08-22: den
   * listan är byggd för platsuttaget, där ett extra ord bara kortar frasen.
   * Som godkännandelista släppte den igenom pronomen och verb och gjorde 13
   * av 30 vardagsmeningar till polisvarningar. Se PLATS_BINDEORD.
   */
  for (let i = 0; i < words.length; i++) {
    if (i >= traff.i && i < traff.i + traff.n) continue;   // platsen själv
    const w = utanBindestreck(words[i]);
    if (!w) continue;
    if (PLATS_BINDEORD.has(w)) continue;
    if (CLEAR_WORDS.includes(w)) continue;
    if (DIRECTION_HINTS.has(w) || FARDRIKTNING.has(w)) continue;
    if (PLATSPRECISERING.has(w)) continue;
    // Klockslagen är nakna tal efter normalize(), se TID_RE.
    if (/^\d+$/.test(w)) continue;
    return null;
  }

  const stod = TID_RE.test(String(raw)) || words.includes('kl') || words.includes('klockan') ||
               words.some(w => FARDRIKTNING.has(w) || DIRECTION_HINTS.has(w));

  // Typen blir 'police': det är vad konventionen betyder. Inte 'control' —
  // inlägget säger inte att det är en hastighetsmätning, bara att polisen
  // står där.
  return { type: 'police', word: null, traff: 'plats', gi: 99, idx: -1, plats: traff.namn, stod };
}

/* ---- Hjälpare -------------------------------------------------------- */

/** Hur mycket en träff är värd. Exakt slår böjning slår sammansättning. */
const TRAFF_RANG = { exakt: 3, bojning: 2, sammansatt: 1 };

/**
 * Hittar det BÄSTA typordet, inte det första.
 *
 * Förr vann första träffen i gruppordning. Med enbart exakta ord var det
 * ofarligt; med sammansättningar är det inte det, eftersom kameragruppen står
 * först och en kameraträff vägras. "Civilbil vid Hälla, han filmar med
 * dashkameran" hade då gått från publicerad civilbilsvarning till tyst
 * vägran.
 *
 * Ordningen är: träffkvalitet först, sedan gruppordningen, sedan listordets
 * längd. Gruppordningen står FÖRE längden med flit — den är ett
 * produktbeslut ("mest specifik först"), och med den ordningen svarar
 * parsern exakt som förut på varje inlägg där alla träffar är exakta.
 * "Två polisbilar och en civilbil vid Erikslund" är fortfarande en
 * civilbilsvarning, inte en polisvarning.
 */
function findType(text, words) {
  let basta = null;
  for (let gi = 0; gi < TYPE_WORDS.length; gi++) {
    const group = TYPE_WORDS[gi];
    for (const w of group.words) {
      let traff = null;
      // Var i meningen ordet stod. Kameraregeln behöver det för att kunna
      // fråga vad som står BREDVID kameraordet i stället för var som helst.
      let idx = -1;
      if (w.includes(' ')) {
        // Flerordsfraser ('civil polis') matchas mot hela texten som förut.
        // De är två ord i texten, och en ändelsematchning per ord skulle
        // behöva veta vilket av dem som är huvudordet. De finns bara i
        // unmarked-gruppen, alltså aldrig i kameraregeln, och saknar därför
        // ordindex utan att något går förlorat.
        if (text.includes(w)) traff = 'exakt';
      } else {
        for (let oi = 0; oi < words.length; oi++) {
          const m = matchaOrd(words[oi], w);
          if (m && (!traff || TRAFF_RANG[m] > TRAFF_RANG[traff])) { traff = m; idx = oi; }
        }
      }
      if (!traff) continue;
      const kandidat = { type: group.type, word: w, traff, gi, idx };
      if (!basta || arBattreTraff(kandidat, basta)) basta = kandidat;
    }
  }
  return basta;
}

function arBattreTraff(a, b) {
  if (TRAFF_RANG[a.traff] !== TRAFF_RANG[b.traff]) return TRAFF_RANG[a.traff] > TRAFF_RANG[b.traff];
  if (a.gi !== b.gi) return a.gi < b.gi;
  return a.word.length > b.word.length;
}

const hasAnyWord = (words, list) => list.some(w => words.includes(w));
const hasAnyPhrase = (text, list) => list.some(p => text.includes(p));

/** Alla typord platt, för att kunna rensa bort dem ur platsfrasen. */
const ALLA_TYPORD = [...new Set(TYPE_WORDS.flatMap(g => g.words.flatMap(w => w.split(' '))))];

/**
 * Är ordet ett typord i någon form?
 *
 * SAMMA matchning som findType använder, och det är avgörande. Vore
 * rensningen kvar på exakt likhet medan findType breddades, blev
 * "trafikkamera" både typ och plats: geokodningen hade fått "trafikkamera
 * hälla" att slå upp, och inlägget hade fått hela platsbonusen på +0,3 — den
 * enda term som lyfter en rapport över tröskeln 0,65. Nettoeffekten hade
 * blivit fler publicerade rapporter med fel koordinat.
 *
 * Hela ordet plockas bort, inte bara ändelsen. "trafikkamera" lämnar alltså
 * ingen "trafik" kvar i platsfrasen.
 */
const arTypord = ord => ALLA_TYPORD.some(w => matchaOrd(ord, w) !== null);

/*
 * Svaga platsled: ord som säger VAR VID platsen något står, inte VILKEN plats
 * det är. Vägorden (DIRECTION_HINTS) och färdriktningarna (FARDRIKTNING) är
 * redan sådana; de tre sista kom ur de mätta inläggen — "Mot stan." och
 * "Vallby vid entrén till Golfklubb."
 *
 * De står HÄR och inte bland stopporden, för ett stoppord försvinner helt.
 * Ett svagt platsled sparas undan och används när ingenting annat blev kvar:
 * "Rondellen norrut" och "Polis mot stan" är sämre platser än ett ortnamn men
 * oändligt mycket bättre än tom sträng, för utan plats faller rapporten på
 * tröskeln 0,65 och föraren får ingen varning alls.
 */
const SVAGA_PLATSLED = new Set([
  ...DIRECTION_HINTS, ...FARDRIKTNING,
  'stan', 'entrén', 'entren', 'entré', 'entre', 'parkeringen', 'parkering',
]);

/*
 * Vilka ord är ett klockslag?
 *
 * normalize() byter ':' och '.' mot blanksteg INNAN parsern ser texten, så
 * "13.45" är två ord — "13" och "45" — när rensningen når dem. Regeln som
 * stod här förut, /^\d{1,2}[:.]\d{2}$/, kunde därför aldrig träffa någonting:
 * den letade efter ett tecken som redan var borta. Tre av gruppens fem
 * mätta bortfall bar ett klockslag av precis den formen.
 *
 * Paret måste vara ett GILTIGT klockslag, inte vilka två tal som helst.
 * Annars försvinner vägnumret ur "riksväg 66 11.15": 66 följt av 11 ser ut
 * som ett par, och timmen 66 finns inte. Paret hoppas dessutom över i ett
 * svep, så tre tal i rad inte kan kedja ihop sig.
 *
 * Ett ENSAMT tal rörs inte. "Vasagatan 12" är ett husnummer och hjälper
 * geokodningen; att kasta varje litet tal hade kostat mer än det gav.
 */
function klockslagsindex(words) {
  const arKlockslag = new Array(words.length).fill(false);
  for (let i = 0; i < words.length - 1; i++) {
    if (!/^\d{1,2}$/.test(words[i]) || Number(words[i]) > 23) continue;
    if (!/^\d{2}$/.test(words[i + 1]) || Number(words[i + 1]) > 59) continue;
    arKlockslag[i] = true;
    arKlockslag[i + 1] = true;
    i++;
  }
  return arKlockslag;
}

/**
 * Platsfrasen är det som blir kvar när typord, stoppord och skräp plockats
 * bort. Ordningen behålls så "stora gatan" förblir "stora gatan".
 *
 * Vägorden (rondellen, avfarten, rampen) räknas inte som plats — det står
 * redan i kommentaren vid DIRECTION_HINTS, men rensningen gjorde det inte
 * förrän nu. "vid första avfarten Hälla" ska geokodas som "hälla".
 * De sparas ändå undan: är de allt vi har är "rondellen norrut" bättre än
 * ingen plats alls, för utan plats faller rapporten på tröskeln.
 *
 * SIST PRÖVAS DELFRASERNA MOT DE KÄNDA NAMNEN, och det är den delen som
 * faktiskt löser de mätta bortfallen. Rensningen ovan är ett NEGATIVT filter:
 * den kan bara ta bort ord den känner igen, och antar att allt annat är ett
 * platsnamn. "Laser vid Hammarby- korsningen vid la pizza" blir därför
 * "hammarby la pizza", och ingen ordlista i världen kommer att innehålla
 * "la pizza". hittaKandPlats() vänder på frågan och letar POSITIVT efter det
 * längsta kända namnet någonstans i frasen, så delfrasen "hammarby" vinner.
 *
 * Priset var att resten av frasen kastades när ett känt namn hittades: "Polis
 * på Vasagatan 12" gav "vasagatan", nålen hamnade på gatan i stället för vid
 * huset, och bryggans adressväg (ADRESS_RE) var därmed död för VARJE gata som
 * står i PLATSORD — alltså precis de gator gruppen skriver om oftast. Det är
 * lagat i utvidga(), som låter både husnumret och ett särskrivet aliasled följa
 * med. Se motiveringen där.
 */
function extractPlace(words) {
  const kept = [];
  const medVagord = [];
  const arKlockslag = klockslagsindex(words);
  for (let i = 0; i < words.length; i++) {
    // Bindestrecket överlever normalize() för gatunamnens skull, men i kanten
    // av ett ord är det skiljetecken: "Hammarby-" är Hammarby.
    const w = utanBindestreck(words[i]);
    if (!w) continue;
    if (KLAUSULORD.has(w)) {
      /*
       * Bryt bara när vi har ett RIKTIGT platsled, alltså kept och inte
       * medVagord. Gränsen bröt först på medVagord, och det räckte med ett
       * enda fyllnadsord före bisatsordet för att kasta resten av meningen:
       * "Poliskontroll idag som ligger vid Hälla" gav platsen "idag", som
       * ingen geokodning hittar — meningen tystnade trots att ortnamnet stod
       * där. Vägorden (rondellen, avfarten) räknas alltså inte som något att
       * gå på: "Snutarna vid rondellen som står vid Hälla" ska ge "hälla".
       * De vanligaste fyllnadsorden står numera bland stopporden och når
       * aldrig hit.
       */
      if (kept.length) break;        // bisatsen beskriver inte platsen
      continue;                      // ...men inleder meningen den, är den bara ett stoppord
    }
    if (arTypord(w)) continue;
    if (STOPWORDS.has(w)) continue;
    if (NOT_A_PLACE.has(w)) continue;
    if (arKlockslag[i]) continue;                    // klockslag, se ovan
    if (/^\d+$/.test(w) && w.length > 3) continue;   // långa sifferklumpar
    medVagord.push(w);
    if (SVAGA_PLATSLED.has(w)) continue;
    kept.push(w);
  }
  const ord = kept.length ? kept : medVagord;
  // Samma uppslag som platsregeln använder, med flit: två listor över kända
  // platser i samma fil hade drivit isär, och den som glömdes bort hade blivit
  // ett tyst bortfall igen.
  const kand = hittaKandPlats(ord);
  return (kand ? kand.namn : ord.join(' ')).trim();
}

/* ---- Publikt API ----------------------------------------------------- */

/**
 * @param {string} raw  texten som ska tolkas
 * @param {{platsKonvention?: boolean}} [val]
 *   platsKonvention — får ett kort inlägg som bara pekar ut ett känt
 *   platsnamn läsas som "polis här"? Se PLATSORD.
 *
 *   FLAGGAN ÄR AV SOM STANDARD, OCH DET ÄR HELA POÄNGEN. Regeln är en
 *   GRUPPREGEL: "Här Står Polisen - Västerås" har på sin om-sida att man
 *   skriver enbart när man ser en poliskontroll, och det är den konventionen
 *   som gör platsen ensam till en observation. Ingen sådan konvention finns
 *   för rösten eller för appens egna fält.
 *
 *   MÄTT 2026-08-22 innan flaggan fanns: parseReportText('Bäckby') gav
 *   report/police 0,70. Föraren säger "nykterhetskontroll vid Bäckby",
 *   taligenkänningen tappar det långa och ovanliga ordet, och översta
 *   gissningen blir bara "Bäckby". js/voice.js #pickTranscript returnerar då
 *   den tolkningen direkt — före både tvåordsspärren och alternativsökningen
 *   där en vägran vinner över allt annat — och js/app.js publicerar en
 *   polisnål för det som talaren sa var en nykterhetskontroll. Före
 *   platsregeln gav 'bäckby' null och yttrandet föll tyst.
 *
 *   Sätt flaggan bara där texten kommer från gruppflödet: js/facebook.js,
 *   js/fbmejl.js, js/telegram.js och bryggan. Aldrig i voice.js eller app.js.
 *
 * @returns {null | {
 *   intent: 'report'|'clear',
 *   type: 'police'|'camera'|'control'|'unmarked',
 *   place: string,          // rå platsfras, ska geokodas
 *   confidence: number,     // 0-1
 *   raw: string,
 *   traff?: 'exakt'|'bojning'|'sammansatt'|'plats',
 *                           // hur typet hittades. 'plats' = inget typord alls,
 *                           // gruppens konvention läst ur ett känt platsnamn.
 *                           // Den klassen har lägst tillit, se avdraget nedan.
 *   kamera?: 'mobil'                          // se kameraregeln nedan
 * }}
 */
export function parseReportText(raw, val = {}) {
  const { platsKonvention = false } = val;
  const text = normalize(raw);
  if (!text || text.length < 3) return null;

  // Före allt annat: nykterhetskontroller släpps aldrig igenom, oavsett om de
  // kommer från rösten, en knapp eller Facebook-gruppen.
  if (isSobrietyCheck(text)) {
    return { intent: 'refused', reason: 'sobriety', raw: String(raw).trim() };
  }

  const words = text.split(' ');
  let t = findType(text, words);

  /*
   * PLATSEN ENSAM ÄR EN VARNING. Inget typord — men gruppens konvention är
   * att man skriver ENBART när man ser polis, så ett kort inlägg som pekar ut
   * en känd plats betyder polis där. Se den långa motiveringen vid PLATSORD.
   *
   * Kroken sitter PÅ DEN HÄR RADEN med flit, inte som ett eget tidigt return
   * längre upp. Placeringen är hela skillnaden mellan rätt och fel svar:
   *   - Nykterhetsspärren ovan har redan kört, och kör alltså också för den
   *     här vägen. Säkerhetsregeln kan inte kringgås av en platsregel.
   *   - Brusfiltren, gruppmetafiltret, avblåsningsraden, platsuttaget och
   *     tilliten nedanför körs oförändrat. Det är därför "Rocklunda fritt nu"
   *     blir en AVBLÅSNING och inte en varning: raden med CLEAR_WORDS nås.
   *     Ett tidigt return hade lagt en polisnål på en plats som nyss blivit
   *     fri — den naturliga första implementationen, och den farliga.
   *   - Kamerablocket nedanför frågar bara efter type === 'camera' och rör
   *     alltså inte den syntetiska träffen.
   *   - Raden nås bara när dagens kod redan svarar null, så inget befintligt
   *     fall kan byta svar.
   *
   * Flaggan gör regeln till det den är: en GRUPPREGEL. Rösten och appens egna
   * fält har ingen sådan konvention, och där är ett ensamt platsnamn oftast
   * en avhuggen mening. Se motiveringen vid parametern.
   */
  if (!t && platsKonvention) t = platsEnsamSomTyp(raw, text, words);
  if (!t) return null;

  /*
   * FASTA fartkameror rapporteras inte av användare. De står still, de finns
   * redan i appen med rätt koordinat och mätriktning, och en handmarkerad
   * kamera hamnar nästan alltid några hundra meter fel — vilket är värre än
   * ingen markering alls.
   *
   * MOBILA kameror är motsatsen på varje punkt. De står där i några timmar,
   * de finns inte i någon kartdata, och den enda som kan berätta att de står
   * där är någon som just körde förbi. Motiveringen ovan gäller helt enkelt
   * inte dem — och driftfallet 2026-08-22 var just en mobil kamera, som
   * först försvann tyst i ordmatchningen och sedan hade fastnat här.
   *
   * VARFÖR TYPEN BLIR 'control' OCH INTE 'camera'
   * 'camera' betyder något bestämt i resten av appen: TTL ett år
   * (js/store.js), notiser avstängda för användarkällor (js/notiser.js), och
   * kvalitetslagret behandlar den som en fast anläggning. En mobil kamera med
   * den typen hade blivit en tyst nål som ligger kvar på kartan i ett år —
   * ett byte av ett tyst bortfall mot ett tyst fel. 'control' betyder
   * "tillfällig hastighetsmätning här och nu": 60 minuter, notis på, samma
   * behandling som en fartkontroll. Det är vad en mobil kamera ÄR.
   * Fältet kamera:'mobil' finns kvar så att ursprunget syns i loggen.
   */
  /*
   * Mobilordet måste höra ihop med kameraordet, inte bara finnas i texten.
   * Se motiveringen vid MOBIL_KAMERA_ORD: "jag har bilden i min mobil" är
   * inte en mobil kamera. Två undantag från grannkravet, båda åt rätt håll:
   * ett listord som SJÄLVT betyder flyttbar kamera (kamerasläp, kameravagn)
   * behöver inget grannord, och ett "fast" intill kameraordet vinner alltid
   * över ett mobilord i samma fönster.
   */
  const mobilKamera = t.type === 'camera' &&
    !narOrdet(words, t.idx, FAST_KAMERA_ORD) &&
    (MOBILA_TYPORD.has(t.word) || narOrdet(words, t.idx, MOBIL_KAMERA_ORD));
  if (t.type === 'camera' && !mobilKamera) {
    return { intent: 'refused', reason: 'camera', raw: String(raw).trim() };
  }
  const type = mobilKamera ? 'control' : t.type;

  // Frågor och skvaller är inte varningar
  if (hasAnyPhrase(text, NOISE_PHRASES)) return null;
  if (hasAnyWord(words, NOISE_WORDS) && words.length < 5) return null;
  // Gruppens eget prat, oavsett längd. Se GRUPPMETA_ORD: gruppnamnet
  // innehåller ett typord, så varje metainlägg får en typordsträff gratis.
  if (hasAnyWord(words, GRUPPMETA_ORD)) return null;

  const intent = hasAnyWord(words, CLEAR_WORDS) ? 'clear' : 'report';
  /*
   * Platsen kommer från platsregeln när det var den som bar inlägget.
   * extractPlace duger inte där: utan typord rensar arTypord ingenting, och
   * "Vallby vid entrén till Golfklubb" hade gett platsfrasen "vallby entrén
   * till golfklubb" — alltså hela skräpfras-problemet ärvt rakt in i den nya
   * vägen. Aliasnyckeln är dessutom det enda som säkert går att geokoda.
   */
  const place = t.plats !== undefined ? t.plats : extractPlace(words);

  // Förtroende: en tydlig plats och ett kort inlägg är ett bra tecken.
  // Långa inlägg är oftast diskussion, inte varning.
  let confidence = 0.5;
  if (place.length >= 3) confidence += 0.3;
  if (words.length <= 8) confidence += 0.1;
  else if (words.length > 25) confidence -= 0.2;
  // Kameraledet var dött här (camera har redan returnerat ovan) och hade
  // dessutom hunnit driva isär mellan kopiorna. Nu står den upplösta typen.
  if (type === 'control') confidence += 0.05;
  if (words.some(w => DIRECTION_HINTS.has(w))) confidence += 0.05;

  /*
   * En osäkrare matchning ska ge en osäkrare rapport.
   *
   * "Polis vid Hälla" är ett ord vi känner igen rakt av. "Trafikpolisen vid
   * Hälla" är en gissning byggd på att svenska sammansättningar är
   * huvudfinala — nästan alltid rätt, men inte alltid. Avdraget är litet med
   * flit: det ska rangordna rapporter mot varandra, inte ensamt fälla dem
   * under tröskeln 0,65 (js/facebook.js).
   */
  /*
   * Platsregeln är en TOLKNING AV EN KONVENTION, inte av ett uttalat
   * påstående. Ingen har skrivit "polis" — vi läser in det ur att någon över
   * huvud taget skrev i gruppen. Avdraget är därför det största av alla, och
   * ordningen på grenarna gör platsträffen till den lägsta klassen:
   *   "Polis vid Vallby"                  0,90   exakt typord
   *   "Trafikpolisen vid Vallby"          0,80   sammansatt typord
   *   "Dillos norrgående 11.15"           0,75   plats + klockslag/riktning
   *   "Vallby vid entrén till Golfklubb"  0,70   plats ensam
   * Ett klockslag eller en färdriktning drar av mindre: de beskriver ett
   * ögonblick och en rörelse, alltså precis det en observation är.
   *
   * Nivåerna är valda så att de fortfarande når över tröskeln 0,65
   * (js/facebook.js) — under den kastas inlägget helt och regeln vore död —
   * men ligger tydligt under varje rapport med ett utskrivet typord, så att
   * kvalitetslagret kan välja att visa den på kartan utan att läsa upp den.
   * Ett längre inlägg än åtta ord når aldrig hit; platsregeln kräver kortare.
   */
  if (t.traff === 'plats') confidence -= (t.stod ? 0.15 : 0.2);
  else if (t.traff === 'sammansatt') confidence -= 0.1;
  else if (t.traff === 'bojning') confidence -= 0.05;

  const svar = {
    intent,
    type,
    place,
    confidence: Math.max(0, Math.min(1, confidence)),
    raw: String(raw).trim(),
    traff: t.traff,
  };
  if (mobilKamera) svar.kamera = 'mobil';
  return svar;
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

/* ---- PROV ------------------------------------------------------------- */

/*
 * Riktiga meningar genom hela parsern.
 *
 * Varför de ligger här och inte bara i test.html: daemonens självtest
 * (tools/brygg-daemon.ps1) provar bara nykterhetsspärren, aldrig findType
 * eller parseReportText. Ordmatchningen hade alltså ingen mätpunkt alls —
 * en trasig typordsändring märktes först som uteblivna varningar i drift.
 *
 * Kör i webbläsaren:
 *   import { korProv } from './js/parser.js'; console.log(korProv());
 * Kör i node:
 *   node --input-type=module -e "import('./js/parser.js').then(m=>console.log(m.korProv()))"
 *
 * `vanta: null` betyder att parsern inte ska svara någonting alls. Övriga
 * nycklar jämförs var för sig mot svaret, så ett fall kan pröva bara typen
 * eller bara platsen när resten inte är poängen.
 *
 * ALLA FALL KÖRS SOM GRUPPINLÄGG, alltså med platsKonvention: true. Det är
 * den hårdaste inställningen: allt platsregeln kan göra fel kan den bara göra
 * fel här. Att regeln är AV för rösten och appen prövas för sig i korProv().
 */
export const PROV = [
  /* --- Det mätta driftfallet, 2026-08-22 kl 16:16 --- */
  { text: 'Står en mobil trafikkamera vid första avfarten Hälla om man kommer från Stockholm',
    vanta: { intent: 'report', type: 'control', kamera: 'mobil', place: 'hälla' },
    varfor: 'Försvann tyst: ordlistan hade kamera, inlägget sade trafikkamera.' },

  /* --- Sammansättningar och bestämda former som förr föll bort --- */
  { text: 'Poliskontrollen står kvar vid Hälla',
    vanta: { intent: 'report', type: 'control', place: 'hälla' } },
  { text: 'Polisbilen står vid Erikslund',
    vanta: { intent: 'report', type: 'police', place: 'erikslund' } },
  { text: 'Poliserna står vid Bäckby',
    vanta: { intent: 'report', type: 'police', place: 'bäckby' } },
  { text: 'Civilbilen på Stora gatan',
    vanta: { intent: 'report', type: 'unmarked', place: 'stora gatan' } },
  { text: 'Hastighetskontrollen på E18',
    vanta: { intent: 'report', type: 'control', place: 'e18' } },
  { text: 'Snutarna vid rondellen',
    vanta: { intent: 'report', type: 'police', place: 'rondellen' },
    varfor: 'Vägordet är allt vi har, och då är det bättre än ingen plats.' },
  { text: 'Laserkontrollen vid Skultuna',
    vanta: { intent: 'report', type: 'control', place: 'skultuna' } },
  { text: 'Trafikpolisen vid Hälla',
    vanta: { intent: 'report', type: 'police', place: 'hälla', traff: 'sammansatt' } },
  { text: 'Polisrazzian på Vasagatan',
    vanta: { intent: 'report', type: 'control', place: 'vasagatan' } },
  { text: 'Blåljusen vid Erikslund',
    vanta: { intent: 'report', type: 'police', place: 'erikslund' } },
  { text: 'Piketen står vid Bäckby',
    vanta: { intent: 'report', type: 'police', place: 'bäckby' } },
  { text: 'Motorcykelpolisen vid bron',
    vanta: { intent: 'report', type: 'police' } },
  { text: 'Fartkamera i skåpbil vid Tortuna',
    vanta: { intent: 'report', type: 'control', kamera: 'mobil', place: 'tortuna' } },
  { text: 'Kamerasläp vid Tortuna',
    vanta: { intent: 'report', type: 'control', kamera: 'mobil', place: 'tortuna' },
    varfor: 'Huvudfinalt på släp, inte på kamera — nåddes inte av ändelsematchningen.' },
  { text: 'Kameravagnen står vid Vasagatan',
    vanta: { intent: 'report', type: 'control', kamera: 'mobil', place: 'vasagatan' } },

  /* --- Mobilordet måste stå INTILL kameraordet --- */
  { text: 'Fartkameran vid Bäckby blixtrade, jag har bilden i min mobil',
    vanta: { intent: 'refused', reason: 'camera' },
    varfor: 'Mobilen är telefonen. Kameran är fast och ska inte på kartan.' },
  { text: 'Nya fartkameran vid Erikslund, se den tillfälliga skylten',
    vanta: { intent: 'refused', reason: 'camera' } },
  { text: 'Trafikkameran vid Skiljebo, jag stod med släpet bakom',
    vanta: { intent: 'refused', reason: 'camera' } },
  { text: 'Den fasta fartkameran är mobil enligt någon, vid Hälla',
    vanta: { intent: 'refused', reason: 'camera' },
    varfor: 'Fast intill kameraordet vinner över ett mobilord i samma fönster.' },

  /* --- Rangordningen: en sammansatt kameraträff får inte tysta en rapport --- */
  { text: 'Civilbil vid Hälla, han filmar med dashkameran',
    vanta: { intent: 'report', type: 'unmarked' },
    varfor: 'Förr vann första gruppen. Kameragruppen står först och vägras.' },
  { text: 'Polisen står vid Hälla med kroppskameror',
    vanta: { intent: 'report', type: 'police' } },

  /* --- Regressioner: det som fungerade ska fungera likadant --- */
  { text: 'Polis vid Erikslund',
    vanta: { intent: 'report', type: 'police', place: 'erikslund', traff: 'exakt' } },
  { text: 'Trafikkontroll vid Hälla',
    vanta: { intent: 'report', type: 'control', place: 'hälla' } },
  { text: 'Polisen är borta från Erikslund',
    vanta: { intent: 'clear', type: 'police' } },
  { text: 'Någon som vet om polisen står kvar vid Erikslund',
    vanta: null, varfor: 'Fråga, inte varning.' },

  /* --- Ord där en bredare matchning ger FEL svar --- */
  { text: 'Nu ska vi kontrollera fakturorna på kontoret', vanta: null },
  { text: 'Kontrollanten på bussen var trevlig', vanta: null },
  { text: 'Jag gjorde en polisanmälan igår', vanta: null },
  { text: 'Kameraövervakning i garaget på Vasagatan', vanta: null },
  { text: 'Frågor om civilstånd och skatt', vanta: null },
  { text: 'Biljettkontroll på tåget mot Sala', vanta: null },
  { text: 'Parkeringskontrollen står på Vasagatan', vanta: null },
  { text: 'Fjärrkontrollen till teven är trasig', vanta: null },
  { text: 'Övervakningskameran vid affären', vanta: null },
  { text: 'Webbkameran fungerar inte igen', vanta: null },
  { text: 'Föraren tappade kontrollen och körde av vägen vid Tortuna', vanta: null,
    varfor: 'Bestämd form av kontroll är herravälde här. Blev en trafikkontroll på en olycksplats.' },
  { text: 'Kontrollerna av matlådorna på skolan i Bäckby', vanta: null },
  { text: 'Kontrollen av färdskrivaren gick bra i Köping', vanta: null },

  /* --- Bisatsen får inte ta ortnamnet med sig --- */
  { text: 'Poliskontroll idag som ligger vid Hälla',
    vanta: { intent: 'report', type: 'control', place: 'hälla' },
    varfor: 'Gav platsen "idag": ett fyllnadsord före bisatsordet kastade resten av meningen.' },
  { text: 'Fartkontroll pågår när man svänger av vid Hälla',
    vanta: { intent: 'report', type: 'control', place: 'hälla' } },
  { text: 'Polis ute idag om ni kör mot Hälla',
    vanta: { intent: 'report', type: 'police', place: 'hälla' } },
  { text: 'Snutarna vid rondellen som står kvar vid Hälla',
    vanta: { intent: 'report', type: 'police', place: 'hälla' },
    varfor: 'Vägordet är inget att gå på — bryt inte bisatsen på det.' },

  /* --- Fasta kameror vägras fortfarande --- */
  { text: 'Fartkamera på E18', vanta: { intent: 'refused', reason: 'camera' } },
  { text: 'Trafikkameran vid Bäckby', vanta: { intent: 'refused', reason: 'camera' },
    varfor: 'Ändelsematchad men fast — vägras, precis som den utskrivna formen.' },

  /* --- Nykterhet och droger: får aldrig bli en rapport --- */
  { text: 'Nykterhetskontroll vid Bäckby', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Polisen har drog kollen på E18', vanta: { intent: 'refused', reason: 'sobriety' },
    varfor: 'Mätt hål: kollen saknades i huvudorden, drog är inget stamord.' },
  { text: 'Polisen har drogkollen på E18', vanta: { intent: 'refused', reason: 'sobriety' },
    varfor: 'Samma hål hopskrivet — gick förbi både ordlistan och isärskrivningen.' },
  { text: 'Nykterhets kontrollerna vid Hälla', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Drog testet vid Erikslund', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Alkohol kontrollen vid rondellen', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Polis gör drog-kontroll vid Erikslund', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'polisen står med sållnings-prov vid rondellen',
    vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Drograzzia vid Erikslund', vanta: { intent: 'refused', reason: 'sobriety' },
    varfor: 'razzia är typord i control-gruppen. Utan huvudordet blev det en publicerad kontroll.' },
  { text: 'Drograzzian pågår vid Erikslund', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Polisen har drograzzia vid Hälla', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Drogpolisen står vid Erikslund', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Drogpiketen vid Bäckby', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Droghunden vid stationen', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Nyckterhetsrazzia vid Bäckby', vanta: { intent: 'refused', reason: 'sobriety' },
    varfor: 'Felstavningen träffade ingen stam, men razzia träffade typordet.' },

  /* --- Motriktningen: spärren får inte tysta riktiga polisrapporter --- */
  { text: 'Polisen drog vidare från Skiljebo',
    vanta: { intent: 'report', type: 'police' },
    varfor: 'drog är också imperfekt av dra. En avblåsning, inte en kontroll.' },
  { text: 'Polisen har dragit igång en hastighetskontroll',
    vanta: { intent: 'report', type: 'control' } },
  { text: 'Polisen står vid Hälla med polishunden',
    vanta: { intent: 'report', type: 'police' },
    varfor: 'hund som huvudord får bara betydelse efter ett nykterhetsförled. ' +
            'Platsen blir "hälla polishunden" — geokodningen kortar bakifrån och hittar Hälla.' },
  { text: 'Polisbilen och piketen står vid Erikslund',
    vanta: { intent: 'report', type: 'police', place: 'erikslund' },
    varfor: 'polis och piket som huvudord får inte tysta vanliga polisrapporter.' },

  /* --- Rensningen av platsfrasen: de fyra som loggades som okänd-plats --- */
  { text: 'Polis står vid Vasagatan just nu',
    vanta: { intent: 'report', type: 'police', place: 'vasagatan' },
    varfor: 'Verbet och tidsorden följde med in i frasen, och uppslaget är en ' +
            'EXAKT nyckelmatchning: "star vasagatan" finns inte i aliasfilen.' },
  { text: 'Står och laser mot gryta Apalby IP',
    vanta: { intent: 'report', type: 'control', place: 'apalby ip' },
    varfor: 'Längsta kända namnet vinner: "apalby ip" slår det ensamma "gryta", ' +
            'precis som "hälla köpcentrum" ska slå "hälla".' },
  { text: 'Laser vid Hammarby- korsningen vid la pizza',
    vanta: { intent: 'report', type: 'control', place: 'hammarby' },
    varfor: 'Ingen ordlista kommer någonsin att innehålla "la pizza". Delfrasen ' +
            'måste prövas, och bindestrecket i kanten är skiljetecken.' },
  { text: 'Laser vid Emausskolan. 13.45. Mot stan.',
    vanta: { intent: 'report', type: 'control', place: 'emausskolan' },
    varfor: 'Klockslaget är två nakna tal efter normalize(), och "stan" är ett ' +
            'svagt platsled som ska vika för ett riktigt namn.' },

  /* --- ...men rensningen får inte kasta det enda vi har --- */
  { text: 'Snutarna vid rondellen norrut',
    vanta: { intent: 'report', type: 'police', place: 'rondellen norrut' },
    varfor: 'Vägordet och riktningen är allt föraren skrev. Bättre än tom plats, ' +
            'för utan plats faller rapporten på tröskeln 0,65.' },
  { text: 'Polis mot stan',
    vanta: { intent: 'report', type: 'police', place: 'stan' },
    varfor: 'Samma sak för de svaga platsleden: de stryks bara när något bättre finns.' },
  { text: 'Polis på riksväg 66 11.15',
    vanta: { intent: 'report', type: 'police', place: 'riksväg 66' },
    varfor: 'Klockslagsregeln får inte äta vägnumret. 66 är ingen giltig timme, ' +
            'så paret är (11, 15) — inte (66, 11).' },
  { text: 'Polis vid Vasagatan 13:45',
    vanta: { intent: 'report', type: 'police', place: 'vasagatan' },
    varfor: 'Regeln som stod här förut letade efter ett kolon som normalize() ' +
            'redan bytt mot blanksteg. Den kunde aldrig träffa något.' },
  { text: 'Polis vid Dillos norrgående',
    vanta: { intent: 'report', type: 'police', place: 'dillos' },
    varfor: 'Färdriktningen är gruppens konvention och aldrig en del av namnet.' },

  /* --- Nykterhet: de nya platsnamnen får inte bli en väg runt spärren --- */
  { text: 'Nykterhetskontroll vid Irstamacken',
    vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Polisen står med alkotest vid Apalby IP',
    vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Drogkontroll vid Emausskolan 13.45',
    vanta: { intent: 'refused', reason: 'sobriety' } },

  /* --- Platsen ensam är en varning: gruppens konvention, mätt 2026-08-21 --- */
  { text: 'Dillos norrgående 11.15',
    vanta: { intent: 'report', type: 'police', place: 'dillos', traff: 'plats' },
    varfor: 'Föll på "inget typord". Klockslag och färdriktning stöder tolkningen.' },
  { text: 'Hemköp Öster Mälarstrand- 16:15',
    vanta: { intent: 'report', type: 'police', place: 'hemköp öster mälarstrand', traff: 'plats' },
    varfor: 'Bindestrecket överlever normalize() och får inte gömma aliasnyckeln. ' +
            'Butiken är egen nyckel sedan den slogs upp, och det längsta kända ' +
            'namnet vinner: nålen hamnar vid Hemköp, inte mitt i stadsdelen.' },
  { text: 'Irstamacken',
    vanta: { intent: 'report', type: 'police', place: 'irstamacken', traff: 'plats' },
    varfor: 'Låg förut i kartdatan bara som basen "irsta" via ORTSLED. Macken är ' +
            'numera egen nyckel med en provad söksträng, och hela namnet vinner ' +
            'över sammansättningsregeln — rätt mack i stället för rätt by.' },
  { text: 'Vallby vid entrén till Golfklubb.',
    vanta: { intent: 'report', type: 'police', place: 'vallby golfklubb', traff: 'plats' },
    varfor: 'entrén och golfklubb PRECISERAR platsen, och leden i aliasnyckeln står ' +
            'ISÄR i texten. Gav förut bara "vallby" — nålen hamnade på stadsdelsnoden ' +
            '651 m från golfbanan, trots att raden "vallby golfklubb" fanns i ' +
            'aliasfilen just för det här inlägget. Se utvidga().' },
  { text: 'Vallby igår, kompisen jobbar vid Golfklubb',
    vanta: null,
    varfor: 'Samma två kända led, men "kompisen" och "jobbar" är varken bindeord ' +
            'eller precisering. Sammanslagningen måste avstå, annars blir vardagsprat ' +
            'en utpekad punkt vid golfbanan.' },
  { text: 'Polis vid Vasagatan 12',
    vanta: { intent: 'report', type: 'police', place: 'vasagatan 12' },
    varfor: 'Husnumret följer med när namnet slutar på ett gatuord. Gav förut ' +
            '"vasagatan", och då fick ADRESS_RE i bryggan aldrig se numret — ' +
            'adressvägen var död för varje gata som står i PLATSORD.' },
  { text: 'Polis vid Hälla 12',
    vanta: { intent: 'report', type: 'police', place: 'hälla' },
    varfor: 'Bara efter ett GATUORD. "Hälla 12" är ingen adress, och att skicka ' +
            'talet vidare hade gjort en provad aliasnyckel till en okänd fras.' },

  /* --- ...men vad som helst blir inte polis --- */
  { text: 'Trafikvecka nu hela v34.', vanta: null,
    varfor: 'Inget känt platsnamn. Den positiva listan är hela spärren här.' },
  { text: 'Idag firar Här Står Polisen - Västerås 12 år med 18K följare', vanta: null,
    varfor: 'Gruppnamnet innehåller ett typord, så inlägget hade en träff redan ' +
            'före platsregeln och gav report/police 0,80. GRUPPMETA_ORD fäller det.' },
  { text: 'Välkommen till Här Står Polisen - Västerås', vanta: null },
  { text: 'Tack för info!', vanta: null },
  { text: 'Vet någon om det är kö på E18?', vanta: null,
    varfor: 'E18 är ett känt platsnamn. Frågetecknet, frågeordet och ämnesordet ' +
            '"kö" fäller den var för sig.' },
  { text: 'Kö på E18 österut', vanta: null,
    varfor: 'Utan ämneslistan hade kön blivit en polisvarning: E18 är bara var ' +
            'den står. Ingen fråga, kort text, ett känt namn — allt annat stämmer.' },
  { text: 'Rocklunda fritt nu',
    vanta: { intent: 'clear', type: 'police', place: 'rocklunda' },
    varfor: 'Avblåsning, inte varning. Kroken sitter före CLEAR_WORDS-raden just ' +
            'för det här; ett tidigt return hade satt en nål på en tom plats.' },
  { text: 'Ses vid stationen', vanta: null,
    varfor: 'stationen står i aliasfilen men inte i PLATSORD — det är ett vanligt ' +
            'svenskt ord i bestämd form.' },
  { text: 'Jobbar på ABB idag', vanta: null,
    varfor: 'Samma skäl: abb geokodas gärna, men får inte bära ett inlägg ensamt.' },
  { text: 'Jag bor i Vallby och undrar vad som hände', vanta: null,
    varfor: 'Känt namn, men en fråga och för många okända innehållsord.' },
  { text: 'Var på Erikslund och handlade mat och kläder hela eftermiddagen', vanta: null,
    varfor: 'Nio ord — konventionen är en lapp, inte ett resonemang.' },

  /* --- Vardagliga meningar med ett ortnamn i, mätta 2026-08-22 ---
   *
   * Alla tretton gav report/police 0,70 med en aliasnyckel som geokodar rent,
   * alltså riktiga nålar på kartan. Ordet som bar dem igenom var i samtliga
   * fall ett pronomen eller ett verb ur STOPWORDS, som krav 5 använde som
   * godkännandelista. Nio av dem står här; de fyra kvarvarande skilde sig
   * bara i vilket ortnamn de råkade nämna.
   */
  { text: 'Jag åker till Erikslund nu', vanta: null,
    varfor: 'Ett verb och ett pronomen. Den som skriver en mening skriver inte en lapp.' },
  { text: 'Vi kommer från Skultuna', vanta: null },
  { text: 'Jag är kvar i Skultuna', vanta: null },
  { text: 'Man kör till Hälla', vanta: null },
  { text: 'Kolla upp Dillos', vanta: null,
    varfor: 'Imperativ är också ett verb, och "kolla upp" är inte en observation.' },
  { text: 'Ser du dem vid Vallby', vanta: null },
  { text: 'Jag ser er vid Hälla', vanta: null },
  { text: 'Kör ni till Hälla köpcentrum idag', vanta: null },
  { text: 'Sitter på Max i Erikslund', vanta: null,
    varfor: 'Max och köpcentrum PRECISERAR platsen — det är verbet som fäller den.' },

  /* --- Frågor utan frågetecken, mätta 2026-08-22 --- */
  { text: 'Är någon vid Vallby nu', vanta: null,
    varfor: 'Inleds med finit verb. Frågetecknet saknas, som det ofta gör i en ' +
            'mobilkommentar, och "är" stod dessutom i STOPWORDS.' },
  { text: 'Var det vid Vasagatan', vanta: null,
    varfor: 'Rumsfrågan "var" saknades helt i FRAGEORD.' },
  { text: 'Nån som är i Irsta nu', vanta: null,
    varfor: 'NOISE_PHRASES har "någon som vet", inte "nån som är".' },

  /* --- Nykterhet: platsregeln får inte öppna säkerhetsspärren --- */
  { text: 'Vasagatan blås', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Irstamacken nykterhet', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Dillos alkotest 11.15', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Vallby drogkontroll', vanta: { intent: 'refused', reason: 'sobriety' } },
  { text: 'Rocklunda sållningsprov nu', vanta: { intent: 'refused', reason: 'sobriety' } },
];

/**
 * Kör PROV plus de påståenden som inte går att uttrycka som ett enskilt fall.
 * @returns {{ok: boolean, antal: number, fel: string[]}}
 */
export function korProv() {
  const fel = [];
  // Gruppflödets inställning. Se kommentaren över PROV: alla fall prövas i
  // det läge där platsregeln är påslagen, för det är där den kan göra fel.
  const GRUPP = { platsKonvention: true };
  for (const fall of PROV) {
    const fick = parseReportText(fall.text, GRUPP);
    if (fall.vanta === null) {
      if (fick) fel.push(`"${fall.text}" — väntade inget svar, fick ${JSON.stringify(fick)}`);
      continue;
    }
    if (!fick) {
      fel.push(`"${fall.text}" — inget svar alls, väntade ${JSON.stringify(fall.vanta)}`);
      continue;
    }
    for (const [nyckel, varde] of Object.entries(fall.vanta)) {
      if (fick[nyckel] !== varde) {
        fel.push(`"${fall.text}" — ${nyckel} blev ${JSON.stringify(fick[nyckel])}, ` +
                 `väntade ${JSON.stringify(varde)}`);
      }
    }
  }

  // En osäkrare matchning ska ge en lägre tillit. Samma mening, samma längd,
  // samma plats — bara ordet skiljer.
  const exakt = parseReportText('Polis vid Hälla');
  const sammansatt = parseReportText('Trafikpolis vid Hälla');
  if (!(exakt.confidence > sammansatt.confidence)) {
    fel.push(`tilliten skiljer inte på matchningskvalitet: exakt ${exakt.confidence} ` +
             `mot sammansatt ${sammansatt.confidence}`);
  }

  // Typordet ska bort ur platsfrasen HELT, inte lämna sitt förled kvar.
  if (parseReportText('Trafikkameran är mobil vid Hälla').place !== 'hälla') {
    fel.push('typordet lämnade rester i platsfrasen: ' +
             JSON.stringify(parseReportText('Trafikkameran är mobil vid Hälla').place));
  }

  /*
   * Platsen ensam ska ALLTID ge lägre tillit än ett utskrivet typord, och
   * mätas mot en text av samma form: samma plats, samma längdklass. Annars
   * hade jämförelsen bara mätt inläggets längd.
   */
  const medTypord = parseReportText('Polis vid Vallby', GRUPP);
  const baraPlats = parseReportText('Vallby vid entrén till Golfklubb.', GRUPP);
  if (!(medTypord.confidence > baraPlats.confidence)) {
    fel.push(`platsen ensam har inte lägre tillit än ett typord: typord ` +
             `${medTypord.confidence} mot plats ${baraPlats.confidence}`);
  }

  // ...men den måste ändå nå över tröskeln 0,65 (js/facebook.js, js/telegram.js,
  // bryggan). Gör den inte det kastas inlägget före kartan och regeln är död.
  for (const text of ['Dillos norrgående 11.15', 'Hemköp Öster Mälarstrand- 16:15',
                      'Irstamacken', 'Vallby vid entrén till Golfklubb.']) {
    const svar = parseReportText(text, GRUPP);
    if (!svar || svar.confidence < 0.65) {
      fel.push(`"${text}" når inte tröskeln 0,65: ${svar && svar.confidence}`);
    }
  }

  /*
   * PLATSREGELN ÄR EN GRUPPREGEL OCH MÅSTE VARA AV SOM STANDARD.
   *
   * Utan flaggan gav parseReportText('Bäckby') report/police 0,70, och rösten
   * anropar parsern utan att veta något om Facebook-gruppen. Ett avhugget
   * "nykterhetskontroll vid Bäckby" hade då blivit en publicerad polisnål —
   * se motiveringen vid parametern. Provet mäter just det: samma text, båda
   * lägena.
   */
  for (const text of ['Bäckby', 'Vallby', 'Hälla', 'E18', 'Irstamacken',
                      'Dillos norrgående 11.15']) {
    if (parseReportText(text) !== null) {
      fel.push(`"${text}" tolkades utan platsKonvention: ` +
               JSON.stringify(parseReportText(text)));
    }
    if (!parseReportText(text, GRUPP)) {
      fel.push(`"${text}" tolkades inte ens med platsKonvention`);
    }
  }

  // Ett klockslag eller en riktning ska stödja tolkningen, inte vara neutralt.
  const utanStod = parseReportText('Irstamacken', GRUPP);
  const medStod = parseReportText('Irstamacken 11.15', GRUPP);
  if (!(medStod.confidence > utanStod.confidence)) {
    fel.push(`klockslaget höjde inte tilliten: ${medStod.confidence} mot ${utanStod.confidence}`);
  }

  /*
   * Delfrasuppslaget får INTE rädda en skräpfras.
   *
   * "Tack för tipset om polisen vid Erikslund" ger idag report/police med
   * tilliten 0,90 och platsfrasen "tack tipset". Det enda som hindrar en nål
   * är att geokodningen inte hittar strängen — och ett uppslag som letar efter
   * kända namn var som helst i RÅtexten hade hittat Erikslund och publicerat
   * ett andrahandsrykte som en färsk observation. Därför söks delfraserna i
   * den RENSADE frasen, efter bisatsgränsen, inte i råtexten.
   */
  const eko = parseReportText('Tack för tipset om polisen vid Erikslund', GRUPP);
  if (eko && eko.place === 'erikslund') {
    fel.push('delfrasuppslaget räddade en skräpfras: "tack för tipset..." blev erikslund');
  }

  return { ok: !fel.length, antal: PROV.length + 21, fel };
}
