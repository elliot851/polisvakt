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
  // Beskriver utrustningen, inte platsen: "en MOBIL trafikkamera vid Hälla".
  ...MOBIL_KAMERA_ORD, ...FAST_KAMERA_ORD,
  // 'kontroll' står i INGEN_SAMMANSATTNING och plockas därför inte längre
  // bort av arTypord i böjd form. Utan de här raderna skulle "kontrollen"
  // bli en del av platsfrasen som geokodningen får slå upp.
  'kontroll', 'kontrollen', 'kontroller', 'kontrollerna',
]);

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

/**
 * Platsfrasen är det som blir kvar när typord, stoppord och skräp plockats
 * bort. Ordningen behålls så "stora gatan" förblir "stora gatan".
 *
 * Vägorden (rondellen, avfarten, rampen) räknas inte som plats — det står
 * redan i kommentaren vid DIRECTION_HINTS, men rensningen gjorde det inte
 * förrän nu. "vid första avfarten Hälla" ska geokodas som "hälla".
 * De sparas ändå undan: är de allt vi har är "rondellen norrut" bättre än
 * ingen plats alls, för utan plats faller rapporten på tröskeln.
 */
function extractPlace(words) {
  const kept = [];
  const medVagord = [];
  for (const w of words) {
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
    if (/^\d{1,2}[:.]\d{2}$/.test(w)) continue;      // klockslag
    if (/^\d+$/.test(w) && w.length > 3) continue;   // långa sifferklumpar
    medVagord.push(w);
    if (DIRECTION_HINTS.has(w)) continue;
    kept.push(w);
  }
  return (kept.length ? kept : medVagord).join(' ').trim();
}

/* ---- Publikt API ----------------------------------------------------- */

/**
 * @returns {null | {
 *   intent: 'report'|'clear',
 *   type: 'police'|'camera'|'control'|'unmarked',
 *   place: string,          // rå platsfras, ska geokodas
 *   confidence: number,     // 0-1
 *   raw: string,
 *   traff?: 'exakt'|'bojning'|'sammansatt',   // hur typordet hittades
 *   kamera?: 'mobil'                          // se kameraregeln nedan
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

  const intent = hasAnyWord(words, CLEAR_WORDS) ? 'clear' : 'report';
  const place = extractPlace(words);

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
  if (t.traff === 'sammansatt') confidence -= 0.1;
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
];

/**
 * Kör PROV plus de påståenden som inte går att uttrycka som ett enskilt fall.
 * @returns {{ok: boolean, antal: number, fel: string[]}}
 */
export function korProv() {
  const fel = [];
  for (const fall of PROV) {
    const fick = parseReportText(fall.text);
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

  return { ok: !fel.length, antal: PROV.length + 2, fel };
}
