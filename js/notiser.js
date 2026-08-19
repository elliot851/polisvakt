// Notisinställningar per varningstyp.
//
// Bakgrund ur ROADMAP.md: "vissa vill bara ha kontroller, inte varje
// fartkamera de redan kan utantill". Den som kör samma sträcka varje dag vet
// precis var kamerorna står, och en röst som påminner om dem fyra gånger per
// resa lär föraren att stänga av rösten helt. Då tystnar också polisen och
// kontrollerna, alltså precis det hen ville ha kvar.
//
// Därför tre nivåer per typ, inte två:
//
//   av     Varken röst eller kartnål. Typen finns inte för den här föraren.
//   karta  Nålen ritas ut, rösten säger ingenting. Föraren ser den om hen
//          tittar, och blir aldrig tilltalad om den.
//   röst   Röst, notis och nål. Appens normalläge.
//
// Mellansteget är hela poängen. En ren av/på-inställning tvingar föraren att
// välja mellan att bli tjatad på och att bli blind, och de flesta som tröttnar
// på kamerorna vill fortfarande kunna se dem på kartan innan de svänger.
//
/* ---------------------------------------------------------------------
 * TVÅ REGLER SOM INGEN INSTÄLLNING FÅR KRINGGÅ
 *
 * 1. Nykterhets- och drogkontroller annonseras aldrig. Att varna för en
 *    fartkamera hjälper någon att hålla hastigheten; att varna för en
 *    nykterhetskontroll hjälper någon att köra vidare full. Filtret sitter
 *    redan i parser.js och kvalitet.js. Här sitter det en tredje gång,
 *    eftersom den här modulen är det enda stället där användaren själv får
 *    skruva på vad som läses upp — och en skruv som går att skruva fel är
 *    förr eller senare fel skruvad.
 *
 * 2. Fartkameror rapporteras inte av användare. De kommer ur OSM-datan med
 *    känd koordinat och mätriktning. En handmarkerad kamera hamnar nästan
 *    alltid några hundra meter fel, vilket är värre än ingen markering alls.
 *
 * Därav grundprincipen i hela modulen: en inställning kan bara SÄNKA vad
 * appen säger, aldrig höja. Kvalitetsgraderingen i kvalitet.js sätter ett
 * tak, produktreglerna sätter ett tak, och användarens val läggs ovanpå som
 * ytterligare en sänkning. Resultatet är alltid det tystaste av dem.
 * ------------------------------------------------------------------- */

import { isSobrietyCheck, TYPE_LABEL, TYPE_ICON } from './parser.js';
import { BEHANDLING } from './kvalitet.js';

/* ========================= Nivåerna ================================= */

export const NIVA_AV = 'av';
export const NIVA_KARTA = 'karta';
export const NIVA_ROST = 'rost';

/** Nivåerna i stigande ordning. Index = hur mycket appen hörs. */
export const NIVAER = [NIVA_AV, NIVA_KARTA, NIVA_ROST];

const RANG = { [NIVA_AV]: 0, [NIVA_KARTA]: 1, [NIVA_ROST]: 2 };

/** Etiketter till gränssnittet. */
export const NIVA_ETIKETT = {
  [NIVA_AV]:    'Av',
  [NIVA_KARTA]: 'Bara på kartan',
  [NIVA_ROST]:  'Röst och notis',
};

/** Kort förklaring under valet, så ingen behöver gissa vad "karta" betyder. */
export const NIVA_BESKRIVNING = {
  [NIVA_AV]:    'Visas inte alls och säger ingenting.',
  [NIVA_KARTA]: 'Syns som nål på kartan, men rösten är tyst.',
  [NIVA_ROST]:  'Läses upp och visas på kartan.',
};

/** Den tystaste av två nivåer. Grunden i "bara sänka, aldrig höja". */
export function lagstaNiva(a, b) {
  const ra = RANG[a] ?? RANG[NIVA_ROST];
  const rb = RANG[b] ?? RANG[NIVA_ROST];
  return ra <= rb ? NIVAER[ra] : NIVAER[rb];
}

/* ========================= Förvalen ================================= */

/*
 * Allt på från början.
 *
 * Det ligger nära till hands att låta fartkameror börja på "bara karta",
 * eftersom det är dem roadmap-punkten nämner. Men "sådant föraren redan kan
 * utantill" är inte en egenskap hos typen, det är en egenskap hos föraren.
 * Appen vet inte vilka kameror just den här personen har passerat tusen
 * gånger, och en förstagångsanvändare som kör E18 för första gången har inga
 * kameror i huvudet alls. Att tysta dem åt hen i förväg vore att svara på en
 * fråga vi inte har ställt.
 *
 * Inställningen finns för de som vill ha tystnaden. Den som inte rör den ska
 * få appen som den beskrivs.
 */
export const DEFAULT_NOTISER = Object.freeze({
  police:   NIVA_ROST,
  control:  NIVA_ROST,
  unmarked: NIVA_ROST,
  camera:   NIVA_ROST,
});

/*
 * Vad en typ vi aldrig sett förut får.
 *
 * Måste vara röst, inte av. Lägger någon till "vägarbete" eller "viltstråk"
 * som ny typ i parser.js utan att komma ihåg den här filen, ska den nya
 * varningen höras — inte tystna i det tysta hos alla som redan har sparade
 * inställningar. En bortglömd rad ska ge för mycket varning, aldrig för lite.
 */
export const FORVAL_OKAND_TYP = NIVA_ROST;

/** En rad förklaring per typ, så valet går att göra utan att gissa. */
const BESKRIVNING_TYP = {
  police:   'Polisbilar och patruller som andra förare har rapporterat.',
  control:  'Trafik-, fart- och laserkontroller.',
  unmarked: 'Civila polisbilar.',
  camera:   'Fasta fartkameror ur kartdatan. Står alltid på samma ställe.',
};

/** Typerna som visas i inställningarna, i den ordning de ska ritas. */
export const NOTIS_TYPER = Object.freeze(['police', 'control', 'unmarked', 'camera'].map(typ =>
  Object.freeze({
    typ,
    etikett: TYPE_LABEL[typ] || typ,
    ikon: TYPE_ICON[typ] || '⚠️',
    forval: DEFAULT_NOTISER[typ],
    beskrivning: BESKRIVNING_TYP[typ] || '',
  })));

/* ===================== Läsa och skriva ============================== */

/**
 * Plocka fram en komplett, städad uppsättning nivåer.
 *
 * Modulen rör aldrig localStorage. Appen äger lagringen — den läser sitt
 * `pv.settings.v1`, skickar in objektet hit och får tillbaka något den kan
 * lita på. Det gör lagret testbart utan webbläsarlagring och gör att appen
 * kan byta lagringsplats utan att den här filen behöver veta om det.
 *
 * Tål allt som kan ligga i sparad data sedan tidigare versioner:
 *   * hela inställningsobjektet ({ tts: true, notiser: {...} })
 *   * bara kartan ({ police: 'rost' })
 *   * gamla av/på-boolean (true -> röst, false -> av)
 *   * skräp och stavfel (faller tillbaka på förvalet för typen)
 *
 * @param {object|null|undefined} settings
 * @returns {Record<string,string>} ny kopia, aldrig DEFAULT_NOTISER själv
 */
export function laddaNotiser(settings) {
  const rat = { ...DEFAULT_NOTISER };
  const kalla = plockaKarta(settings);
  if (!kalla) return rat;

  for (const [nyckel, varde] of Object.entries(kalla)) {
    const typ = String(nyckel);

    // Regel 1, redan här i inläsningen. Finns det en sparad nyckel som läser
    // som en nykterhets- eller drogkontroll får den aldrig bli en inställning
    // — då hade någon kunnat lägga in { nykterhetskontroll: 'rost' } i sin
    // lagring och därmed skaffa sig en påslagen knapp som inte får finnas.
    if (isSobrietyCheck(typ)) continue;

    const niva = tolkaNiva(varde);
    if (niva) rat[typ] = niva;
    else if (!(typ in rat)) rat[typ] = FORVAL_OKAND_TYP;
  }
  return rat;
}

/**
 * Sätt nivån för en typ och skriv in den i appens inställningsobjekt.
 *
 * Skriver till `settings.notiser` och returnerar den nya kartan. Sparandet
 * till disk är appens sak: den anropar sitt eget saveSettings() efteråt.
 *
 * @param {object} settings   appens inställningsobjekt (muteras)
 * @param {string} typ
 * @param {string} niva       'av' | 'karta' | 'rost'
 * @returns {Record<string,string>} hela den nya kartan
 */
export function sparaNotiser(settings, typ, niva) {
  if (!settings || typeof settings !== 'object') {
    throw new Error('sparaNotiser behöver ett inställningsobjekt att skriva i.');
  }
  const nasta = sattNiva(laddaNotiser(settings), typ, niva);
  settings.notiser = nasta;
  return nasta;
}

/**
 * Ren variant: ny karta med en typ ändrad. Muterar ingenting.
 * @returns {Record<string,string>}
 */
export function sattNiva(notiser, typ, niva) {
  const namn = String(typ || '').trim();
  if (!namn) throw new Error('Ingen typ angiven.');
  if (isSobrietyCheck(namn)) {
    // Regel 1. Ingen väg in, inte ens genom det publika API:et.
    throw new Error('Nykterhets- och drogkontroller går inte att slå på.');
  }
  const rat = tolkaNiva(niva);
  if (!rat) throw new Error(`Okänd nivå "${niva}". Använd en av: ${NIVAER.join(', ')}.`);
  return { ...laddaNotiser(notiser), [namn]: rat };
}

/** Är typen en vi känner till och ritar en rad för i inställningarna? */
export function arKandTyp(typ) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_NOTISER, String(typ));
}

/* ======================= Beslutet ==================================== */

/**
 * Vilken nivå gäller för den här rapporten, allt inräknat?
 *
 * Tre tak läggs ovanpå varandra och det lägsta vinner:
 *   1. produktreglerna (nykterhet, användarrapporterad kamera)
 *   2. kvalitetsgraderingen från kvalitet.js (undanhåll / tyst)
 *   3. förarens egen inställning för typen
 *
 * @param {object} rapport
 * @param {object} [notisinstallningar] appens settings, kartan, eller inget
 * @returns {'av'|'karta'|'rost'}
 */
export function nivaFor(rapport, notisinstallningar) {
  if (!rapport || typeof rapport !== 'object') return NIVA_AV;

  const tak = produktTak(rapport);
  if (tak === NIVA_AV) return NIVA_AV;

  const karta = laddaNotiser(notisinstallningar);
  const typ = String(rapport.type || '');
  const vald = karta[typ] || (arKandTyp(typ) ? DEFAULT_NOTISER[typ] : FORVAL_OKAND_TYP);

  return lagstaNiva(lagstaNiva(tak, kvalitetsTak(rapport)), vald);
}

/**
 * Ska rösten och notisen få nämna den här rapporten?
 * @returns {boolean}
 */
export function skaAnnonseras(rapport, notisinstallningar) {
  return nivaFor(rapport, notisinstallningar) === NIVA_ROST;
}

/**
 * Ska nålen ritas på kartan?
 *
 * Sant för både "karta" och "röst" — det som hörs syns också. Bara "av"
 * plockar bort nålen.
 * @returns {boolean}
 */
export function skaVisasPaKartan(rapport, notisinstallningar) {
  return nivaFor(rapport, notisinstallningar) !== NIVA_AV;
}

/**
 * Bekvämt filter för app.js: dela en lista i det som får höras och det som
 * bara får synas.
 *
 * @returns {{forRost: Array, forKarta: Array}}
 */
export function delaUppFaror(faror, notisinstallningar) {
  const karta = laddaNotiser(notisinstallningar);   // en gång, inte per fara
  const forRost = [];
  const forKarta = [];
  for (const f of faror || []) {
    const n = nivaFor(f, karta);
    if (n === NIVA_AV) continue;
    forKarta.push(f);
    if (n === NIVA_ROST) forRost.push(f);
  }
  return { forRost, forKarta };
}

/* ======================== Interna delar ============================== */

/** Källor som betyder "en människa tryckte på något". Samma lista som kvalitet.js. */
const ANVANDARKALLOR = ['app', 'voice', 'facebook', 'import'];

/**
 * Taket som produktreglerna sätter. Går inte att höja med en inställning,
 * och finns inte som något val i gränssnittet.
 */
function produktTak(rapport) {
  // Regel 1: nykterhets- och drogkontroller. Texten kontrolleras här igen
  // eftersom en rapport kan ha nått hit via ett fält som aldrig gick genom
  // parsern — servern, en import, en gammal rad i lagringen.
  const text = `${rapport.label || ''} ${rapport.note || ''} ${rapport.raw || ''}`.trim();
  if (text && isSobrietyCheck(text)) return NIVA_AV;
  if (isSobrietyCheck(String(rapport.type || ''))) return NIVA_AV;
  if (Array.isArray(rapport.bedomning?.flaggor) &&
      rapport.bedomning.flaggor.includes('nykterhetskontroll')) return NIVA_AV;

  // Regel 2: en fartkamera som en användare har markerat är inte data, den är
  // en gissning på fel plats. Kamerorna ur cameras.json har fixed=true och
  // ingen källa; de är de enda som får synas.
  if (rapport.type === 'camera' && ANVANDARKALLOR.includes(rapport.source)) return NIVA_AV;

  return NIVA_ROST;
}

/** Taket som kvalitetsgraderingen satt, översatt till en nivå. */
function kvalitetsTak(rapport) {
  const b = rapport.bedomning?.behandling;
  if (b === BEHANDLING.UNDANHALL) return NIVA_AV;
  if (b === BEHANDLING.TYST) return NIVA_KARTA;
  return NIVA_ROST;
}

/**
 * Hitta själva kartan i det som skickats in.
 *
 * Anropas både med appens hela inställningsobjekt och med bara kartan, och
 * måste kunna skilja dem åt. Ett helt inställningsobjekt utan notiser-fält får
 * inte tolkas som en karta — då hade `tts: true` blivit en varningstyp som
 * heter "tts" och stod på röst.
 */
function plockaKarta(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  if (settings.notiser && typeof settings.notiser === 'object') return settings.notiser;
  if ('notiser' in settings) return null;

  const poster = Object.entries(settings);
  if (!poster.length) return null;
  // En karta känns igen på att den nämner en typ vi har, eller på att varenda
  // värde i den är en giltig nivå.
  if (poster.some(([k]) => arKandTyp(k))) return settings;
  if (poster.every(([, v]) => tolkaNiva(v) !== null)) return settings;
  return null;
}

/** Tolka ett sparat värde till en giltig nivå, eller null om det är skräp. */
function tolkaNiva(varde) {
  if (varde === true) return NIVA_ROST;        // gammal av/på-inställning
  if (varde === false) return NIVA_AV;
  const s = String(varde ?? '').trim().toLowerCase();
  if (NIVAER.includes(s)) return s;
  // Några stavningar som är rimliga att någon skrivit för hand.
  if (s === 'röst' || s === 'voice' || s === 'pa' || s === 'på') return NIVA_ROST;
  if (s === 'map' || s === 'tyst' || s === 'silent') return NIVA_KARTA;
  if (s === 'off' || s === 'aldrig') return NIVA_AV;
  return null;
}
