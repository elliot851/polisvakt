// Svängbeskrivningar — vägen dit, sagd i tid.
//
// rutt.js svarar redan på "vad ligger farligt framför mig". Den här modulen
// svarar på den andra halvan: "var ska jag svänga, och när ska du säga det".
// De två delar samma rutt och samma projektion, och det är med flit — se
// avsnittet "En rutt, inte två" längre ned.
//
// Modulen rör aldrig DOM, aldrig kartan och aldrig talsyntesen. Den tar emot
// en rutt och en GPS-fix och lämnar tillbaka ett tillstånd plus noll eller en
// mening som BÖR sägas. Vem som säger den, med vilken prioritet och om den
// hinner bli inaktuell på vägen dit avgörs av appen.
//
// ---------------------------------------------------------------------------
// Varför polisvarningar alltid går före svängbeskrivningar
//
// Det här är modulens viktigaste designbeslut, och det är ett affärsbeslut
// lika mycket som ett tekniskt.
//
// Kostnaden för en missad svängbeskrivning är att man kör till nästa avfart
// och vänder. Det tar tre till fem minuter och är irriterande. Kostnaden för
// en missad fartkamera eller en missad kontroll är en fortkörningsbot, i värsta
// fall ett indraget körkort. Det är skillnaden mellan att bli sen och att bli
// av med bilen i en månad.
//
// Appen säljs dessutom på polisvarningarna. En förare som får en bot medan
// appen var på och tyst har inte fått ett sämre navigationsläge — hen har
// fått ett bevis på att abonnemanget inte gör det det lovar. Det är den enda
// felkategori som är existentiell för produkten.
//
// Därför:
//
//   1. ALLT som lämnar den här modulen har prioritet 0 (NAV_PRIORITET).
//      alerts.js och rutt.js skickar sina varningar på 1 och 2. Speaker i
//      voice.js sorterar kön fallande på prioritet, alltså hamnar varje
//      svängbeskrivning bakom varje polisvarning som redan står och väntar.
//   2. Ingen svängbeskrivning får någonsin sättas med interrupt. En
//      polisvarning som håller på att läsas upp ska aldrig kunna klippas av
//      mitt i av "sväng höger in på Drottninggatan".
//   3. Motsatsen ska gälla. En polisvarning som kommer medan en
//      svängbeskrivning läses SKA avbryta den — det är redan Speakers
//      beteende när alerts.js sätter interrupt på prioritet 2, och den här
//      modulen gör ingenting som stör det.
//
// Priset för det: en svängbeskrivning kan hamna i kö bakom en polisvarning och
// komma ut flera sekunder för sent. "Sväng höger nu" som sägs tolv sekunder
// efter korsningen är inte bara värdelös, den är farlig — föraren tittar upp
// och letar efter en avtagsväg som inte finns. Därför bär varje mening ett
// bäst-före: giltigTillTs. Har den passerat när kön hinner fram ska appen
// slänga meningen i stället för att läsa den. Se hur i docs/navigering.md.
//
// ---------------------------------------------------------------------------
// En rutt, inte två
//
// rutt.js hämtar sin rutt med steps=false — den behöver bara geometrin. Den
// här modulen behöver dessutom svängarna, alltså steps=true. Att låta båda
// hämta var sin rutt vore den enkla vägen och ett riktigt otäckt fel: OSRM kan
// mycket väl svara med två olika vägar på två anrop (trafikfria alternativ som
// råkar ligga inom en sekund från varandra), och då varnar appen för polis
// längs väg A medan den säger åt föraren att svänga in på väg B.
//
// Modulen är därför byggd för att ÅTERANVÄNDA geometrin. satt() tar emot en
// valfri `geometri` som bara behöver kunna fyra saker — nearest, nearestBetween,
// pointAt och lengthM — vilket är exakt vad Route-objektet i rutt.js kan.
// Skickar man in guide.route projicerar båda modulerna mot samma linje och kan
// per definition inte hamna på olika vägar.
//
// Saknas geometri bygger modulen en egen (Ruttlinje). Det fungerar, men det är
// reservvägen. Se docs/navigering.md för den tre rader långa ändringen i
// rutt.js som gör att en enda hämtning räcker.
//
// ---------------------------------------------------------------------------
// Klockan skickas in
//
// Ingen funktion här inne läser Date.now(). Tiden kommer med fixen (fix.ts)
// eller som andra argument till uppdatera(). Det är enda sättet att kunna
// testa "sa vi det här för tidigt eller för sent" utan att köra bil.

import { distance, clamp, spokenDistance, shortDistance } from './util.js';

/**
 * Prioriteten på allt som lämnar modulen. Se resonemanget högst upp.
 * Speaker-skalan: 2 = akut fara, 1 = normal varning, 0 = bekräftelse.
 */
export const NAV_PRIORITET = 0;

export const NAV_STANDARD = {
  /* ---- När en sväng ska sägas -----------------------------------------
   *
   * Fast avstånd går inte att försvara. Tvåhundra meter är fjorton sekunder i
   * 50 km/h — lagom för att hinna byta fil och bromsa in. Samma tvåhundra
   * meter är sex och en halv sekund i 110 km/h, alltså ungefär den tid det tar
   * att förstå meningen. Vid det laget är avfarten redan bakom dig.
   *
   * Så horisonten räknas i SEKUNDER och multipliceras med farten vid varje
   * fix. Golv och tak i meter finns för att hålla den vettig i ytterlägena:
   * utan golv sägs ingenting alls när man rullar i kö, utan tak varnas man om
   * en avfart tre kilometer innan på en tom motorväg.
   *
   * Tre steg, för att en sväng behöver tre olika sorters besked:
   *
   *   langt   "Det kommer något." Ger tid att lägga sig i rätt fil på
   *           motorväg. Fyras bara när steget faktiskt är långt nog, se
   *           gatnätsregeln nedan.
   *   snart   "Nu ska du börja agera." Det här är huvudbeskedet och det enda
   *           som alltid ska komma. 18 sekunder ger 250 m i 50 km/h och
   *           550 m i 110 km/h.
   *   nu      "Här." Kort mening, inget gatunamn — det finns inte tid.
   */
  langtS: 55, langtMinM: 500, langtMaxM: 2500,
  snartS: 18, snartMinM: 120, snartMaxM: 600,
  nuS: 4, nuMinM: 25, nuMaxM: 120,

  /* Gatnätsregeln.
   *
   * Ett steg som är 200 m långt kan inte förvarnas 550 m i förväg — då skulle
   * beskedet komma före föregående sväng och föraren skulle höra två
   * motstridiga instruktioner samtidigt. Ett steg måste vara minst
   * stegMarginal gånger utlösningsavståndet för att det steget alls ska
   * annonseras.
   *
   * Det är den regeln som gör att modulen beter sig olika i en stadskärna och
   * på E18 utan att veta vilket den kör i. I Västerås centrum är stegen 150–300
   * m och bara "nu" hinner fyra; på motorvägen är stegen kilometerlånga och
   * alla tre fyrar. Sammanlänkningen ("sedan vänster") täcker upp för de
   * besked som faller bort i tätorten.
   */
  stegMarginal: 1.1,

  // Sammanlänkning: ligger nästa sväng inom så här många meter efter den vi
  // just annonserar sägs båda i samma mening. Waze gör det, och det är rätt:
  // två meningar med fyra sekunders mellanrum hinner inte höras.
  kedjaM: 150,

  // Minsta paus mellan två svängbeskrivningar. "nu" struntar i den — den
  // handlar om något som händer inom några sekunder.
  navMinGapMs: 5000,

  /* ---- Fart -----------------------------------------------------------
   *
   * GPS-farten hoppar. En enda tokig avläsning på 180 km/h skulle annars göra
   * att förvarningen fyrar två och en halv kilometer i förväg. Utjämningen är
   * ett exponentiellt glidande medelvärde; 0,4 ger ungefär tre sekunders
   * minne vid 1 Hz, vilket är kort nog att följa en verklig inbromsning.
   *
   * Golvet på 20 km/h är viktigare än det ser ut. Står man still vid rödljus
   * är farten noll, och noll gånger arton sekunder är noll meter — då skulle
   * ingenting någonsin sägas och föraren skulle stå kvar i fel fil.
   */
  fartUtjamning: 0.4,
  minFartKmh: 20,

  /* ---- Av rutten ------------------------------------------------------
   *
   * Kravet är att en enstaka dålig fix ALDRIG får utlösa en omräkning, och
   * det kravet går inte att uppfylla med bara ett avstånd. En telefon i en
   * tunnel, mellan höghus eller under en bro kan svara med en position tre
   * hundra meter fel, en gång, och sedan vara helt rätt igen. Räknar man den
   * som en avfart får föraren "räknar om" mitt på raksträckan och tappar
   * förtroendet för hela appen.
   *
   * Fyra villkor måste vara uppfyllda SAMTIDIGT:
   *
   *   1. Sidoavståndet överstiger max(avvikM, noggrannhet × 1,5). En osäker
   *      fix höjer alltså ribban i stället för att sänka den — precis tvärtom
   *      mot vad ett rent avståndsvillkor gör.
   *   2. Det har hänt avvikFixar gånger i rad. En enda fix räcker aldrig.
   *   3. Bilen har faktiskt förflyttat sig avvikMinResaM sedan det började.
   *      Fyra dåliga fixar från en bil som står stilla är brus, inte en avfart.
   *   4. Det har gått avvikMinTidS. Skyddar mot att en burst av fixar inom en
   *      sekund räknas som fyra oberoende observationer.
   *
   * Fixar med sämre noggrannhet än maxNoggrannhetM räknas varken upp eller
   * ner. De säger ingenting alls om var bilen är, och att låta dem nollställa
   * räknaren vore lika fel som att låta dem fylla den.
   *
   * I praktiken: 90 km/h och en missad avfart upptäcks efter ungefär fyra
   * sekunder. 30 km/h i tätort tar tio sekunder, vilket är rätt — där ligger
   * gatorna tätt och en tidig gissning blir ofta fel.
   */
  avvikM: 50,
  avvikFixar: 4,
  avvikMinResaM: 80,
  avvikMinTidS: 4,
  maxNoggrannhetM: 100,

  // Omräkningen. Pausen skyddar OSRM (och batteriet) mot att bli mald i en
  // rondell där man är "av rutten" varannan sekund. Taket är en nödbroms för
  // det fall där ingen väg leder tillbaka och varje omräkning misslyckas.
  omberakningPausMs: 15000,
  maxOmberakningar: 10,

  // Framme. Sextio meter är ungefär en husvägg, och det är så nära OSRM:s
  // slutpunkt (som ligger på vägen, inte på tomten) man kan komma.
  frammeM: 60,

  /* ---- Bäst-före på meningarna ----------------------------------------
   *
   * Se avsnittet om prioritet högst upp. En mening som stått i kö bakom en
   * polisvarning är inte automatiskt fel, men ju kortare horisont den handlar
   * om desto snabbare ruttnar den. "Om 1,7 kilometer" tål en halv minut;
   * "sväng höger nu" tål knappt sex sekunder.
   */
  giltigNuMs: 6000,
  giltigSnartMs: 15000,
  giltigLangtMs: 30000,
  giltigOvrigtMs: 60000,
};

/* ===================================================================== */
/* Geometri                                                              */
/* ===================================================================== */
//
// Samma platta meterplan som rutt.js använder, och med flit samma metodnamn.
// Route-klassen där är inte exporterad, så den kan inte återanvändas som kod —
// men den kan återanvändas som OBJEKT, och det är det som räknas. Ruttlinje
// nedan är en reservimplementation med kompatibelt gränssnitt för de fall där
// ingen färdig geometri skickas in (framför allt testerna).

const M_PER_DEG_LAT = 111320;
const mPerDegLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

function projicera(pLat, pLon, aLat, aLon, bLat, bLon) {
  const mLon = mPerDegLon(aLat);
  const bx = (bLon - aLon) * mLon, by = (bLat - aLat) * M_PER_DEG_LAT;
  const px = (pLon - aLon) * mLon, py = (pLat - aLat) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - t * bx, dy = py - t * by;
  return { t, lateral: Math.sqrt(dx * dx + dy * dy) };
}

/**
 * Minimal ruttgeometri.
 *
 * Gränssnittet är avsiktligt en delmängd av Route i rutt.js, så att guide.route
 * kan skickas in i stället utan att någonting här behöver veta om det.
 *
 * nearest() är en rak genomsökning av alla segment. Route i rutt.js har ett
 * rutnät och är snabbare; den skillnaden syns bara i reservvägen, och bara när
 * fönstersökningen missar (start, efter en paus, verklig avvikelse). En rutt
 * med tiotusen punkter kostar ungefär en halv millisekund då. Det är
 * acceptabelt för något som händer några gånger per resa.
 */
export class Ruttlinje {
  constructor(punkter) {
    this.points = punkter;
    const n = punkter.length;
    this.cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      this.cum[i] = this.cum[i - 1] +
        distance(punkter[i - 1][0], punkter[i - 1][1], punkter[i][0], punkter[i][1]);
    }
    this.lengthM = n ? this.cum[n - 1] : 0;
  }

  segLen(i) { return this.cum[i + 1] - this.cum[i]; }

  hitOn(i, lat, lon) {
    const [aLat, aLon] = this.points[i], [bLat, bLon] = this.points[i + 1];
    const p = projicera(lat, lon, aLat, aLon, bLat, bLon);
    return { seg: i, s: this.cum[i] + p.t * this.segLen(i), lateral: p.lateral };
  }

  #indexVid(s) {
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

  nearestBetween(lat, lon, sFran, sTill) {
    const fran = this.#indexVid(sFran);
    const till = this.#indexVid(sTill);
    let bast = null;
    for (let i = fran; i <= till && i < this.points.length - 1; i++) {
      const h = this.hitOn(i, lat, lon);
      if (!bast || h.lateral < bast.lateral) bast = h;
    }
    return bast;
  }

  nearest(lat, lon) {
    let bast = null;
    for (let i = 0; i < this.points.length - 1; i++) {
      const h = this.hitOn(i, lat, lon);
      if (!bast || h.lateral < bast.lateral) bast = h;
    }
    return bast;
  }

  pointAt(s) {
    const i = this.#indexVid(s);
    const len = this.segLen(i) || 1;
    const t = clamp((s - this.cum[i]) / len, 0, 1);
    const [aLat, aLon] = this.points[i], [bLat, bLon] = this.points[i + 1];
    return [aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t];
  }
}

/** Duger objektet som ruttgeometri? Enda kravet som ställs på guide.route. */
function arGeometri(g) {
  return !!g && typeof g.nearest === 'function' && typeof g.nearestBetween === 'function'
    && typeof g.pointAt === 'function' && Number.isFinite(g.lengthM) && g.lengthM > 0;
}

/* ===================================================================== */
/* OSRM: manövrar till svenska                                           */
/* ===================================================================== */

const ORDNINGSTAL = ['', 'första', 'andra', 'tredje', 'fjärde', 'femte',
  'sjätte', 'sjunde', 'åttonde', 'nionde', 'tionde'];

const ordningstal = n =>
  (n >= 1 && n <= 10) ? ORDNINGSTAL[n] : `${n}:e`;

const versal = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

/**
 * Svängarnas ord.
 *
 * OSRM:s modifierare är åtta stycken och de betyder olika saker beroende på
 * manövertypen: "left" efter en `turn` är en korsning man svänger i, "left"
 * efter en `fork` är en fil man lägger sig i, och de ska inte sägas likadant.
 * Att säga "sväng vänster" i en vägdelning där man bara ska hålla åt vänster
 * får folk att bromsa in mitt på motorvägen.
 *
 * `kort` är samma manöver utan gatunamn, för "nu"-beskedet. Vid femtiofem
 * meters marginal finns det inte tid att höra "in på Sankt Olofsgatan"; det
 * enda som spelar roll är höger eller vänster.
 */
const SVANG = {
  right: { fras: 'sväng höger', kort: 'sväng höger', symbol: '↱' },
  left: { fras: 'sväng vänster', kort: 'sväng vänster', symbol: '↰' },
  'slight right': { fras: 'håll till höger', kort: 'håll höger', symbol: '↗' },
  'slight left': { fras: 'håll till vänster', kort: 'håll vänster', symbol: '↖' },
  'sharp right': { fras: 'sväng skarpt höger', kort: 'skarpt höger', symbol: '⮡' },
  'sharp left': { fras: 'sväng skarpt vänster', kort: 'skarpt vänster', symbol: '⮢' },
  straight: { fras: 'kör rakt fram', kort: 'rakt fram', symbol: '↑' },
  uturn: { fras: 'vänd om', kort: 'vänd om', symbol: '⮐' },
};

const HALL = {
  right: { fras: 'håll höger', kort: 'håll höger', symbol: '↗' },
  left: { fras: 'håll vänster', kort: 'håll vänster', symbol: '↖' },
  'slight right': { fras: 'håll höger', kort: 'håll höger', symbol: '↗' },
  'slight left': { fras: 'håll vänster', kort: 'håll vänster', symbol: '↖' },
  straight: { fras: 'håll rakt fram', kort: 'rakt fram', symbol: '↑' },
};

/** Sidan som ord, för de manövrar där bara höger/vänster betyder något. */
function sida(mod) {
  if (!mod) return '';
  if (mod.includes('right')) return 'höger';
  if (mod.includes('left')) return 'vänster';
  return '';
}

/**
 * Vägens namn som det ska sägas.
 *
 * OSRM ger `name` och `ref` var för sig. På en motorväg är name ofta tom och
 * ref är "E18"; på en stadsgata är name "Vasagatan" och ref tom. Är båda satta
 * är ref nästan alltid överflödig i tal — "Vasagatan E18" låter som två vägar.
 * Semikolon separerar flera refs ("E18;E20"); bara den första sägs.
 */
function vagnamn(steg) {
  const namn = String(steg?.name || '').trim();
  const ref = String(steg?.ref || '').trim().split(';')[0].trim();
  if (namn && namn !== ref) return namn;
  return ref || '';
}

/**
 * Skyltat mål, för av- och påfarter.
 *
 * `destinations` ser ut som "E18: Stockholm, Enköping" eller bara
 * "Stockholm, Enköping". Prefixet före kolon är vägnumret och är redan sagt.
 * Fler än två orter blir en ramsa som ingen hinner ta in.
 */
function skyltatMal(steg) {
  const d = String(steg?.destinations || '').trim();
  if (!d) return '';
  const efterKolon = d.includes(':') ? d.slice(d.indexOf(':') + 1) : d;
  const delar = efterKolon.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return delar.slice(0, 2).join(' och ');
}

/**
 * Kräver manövern att föraren gör något?
 *
 * OSRM lägger in ett steg varje gång vägen byter namn, även när man kör rakt
 * fram utan att göra någonting alls. På en tio mil lång rutt blir det ett
 * dussin sådana, och läser man upp dem får föraren "Fortsätt nu" i örat sju
 * gånger mellan Västerås och Stockholm. Det är precis den sortens brus som gör
 * att man stänger av rösten — och stänger man av rösten missar man
 * polisvarningarna, vilket är det enda som verkligen kostar pengar.
 *
 * Så namnbyten och notifikationer annonseras aldrig. I stället hoppar
 * #nastaHandling() över dem och räknar avståndet hela vägen fram till nästa
 * manöver som faktiskt kräver att man vrider på ratten. Det är också mer
 * hjälpsamt: "om 1,4 kilometer, håll vänster" är sant och användbart även om
 * vägen hinner byta namn två gånger på vägen dit.
 *
 * `continue` med en modifierare är ett undantag — då är det en riktig sväng
 * som OSRM råkar kalla för en fortsättning, och den ska sägas.
 */
function kraverHandling(steg) {
  const m = steg?.maneuver || {};
  const typ = m.type || 'continue';
  if (typ === 'new name' || typ === 'notification') return false;
  if (typ === 'continue') return !!m.modifier && m.modifier !== 'straight';
  return true;
}

/**
 * Översätt en OSRM-manöver till svenska.
 *
 * @param {object} steg  ett OSRM-steg (steps[i]); manövern utförs vid steget
 *                       BÖRJAN, alltså är det här beskrivningen av hur man tar
 *                       sig in på steget.
 * @returns {{fras:string, kort:string, symbol:string, typ:string,
 *            modifier:string, vagnamn:string, avfart:(number|null)}}
 *          `fras` = hela beskedet utan avstånd ("sväng höger in på Vasagatan").
 *          `kort` = imperativen utan gatunamn ("sväng höger").
 */
export function beskrivManover(steg) {
  const m = steg?.maneuver || {};
  const typ = m.type || 'continue';
  const mod = m.modifier || '';
  const namn = vagnamn(steg);
  const mal = skyltatMal(steg);
  const s = sida(mod);
  const paNamn = namn ? ` in på ${namn}` : '';
  const forbi = namn ? ` på ${namn}` : '';
  const motMal = mal ? ` mot ${mal}` : '';
  const avfartsnr = String(steg?.exits || '').split(';')[0].trim();

  const ut = (fras, kort, symbol) => ({
    fras, kort: kort || fras, symbol: symbol || '↑',
    typ, modifier: mod, vagnamn: namn, mal,
    avfart: Number.isFinite(m.exit) ? m.exit : null,
    handling: kraverHandling(steg),
  });

  switch (typ) {
    case 'depart':
      return ut(namn ? `kör ut på ${namn}` : 'kör iväg', 'kör iväg', '↑');

    case 'arrive': {
      if (s) return ut(`du är framme, målet ligger på ${s} sida`, 'du är framme', '⚑');
      return ut('du är framme', 'du är framme', '⚑');
    }

    case 'turn': {
      const v = SVANG[mod] || SVANG.straight;
      return ut(v.fras + paNamn, v.kort, v.symbol);
    }

    case 'end of road': {
      const v = SVANG[mod] || SVANG.straight;
      return ut(`${v.fras} vid vägens slut${paNamn}`, v.kort, v.symbol);
    }

    case 'fork': {
      const v = HALL[mod] || HALL.straight;
      return ut(v.fras + (namn ? ` mot ${namn}` : motMal), v.kort, v.symbol);
    }

    case 'merge': {
      // "Fila in" är vad en svensk trafikskola säger. "Smält samman", som är
      // den ordagranna översättningen av merge, säger ingen människa.
      const v = s ? `fila in till ${s}` : 'fila in';
      return ut(v + forbi, s ? `fila in till ${s}` : 'fila in',
        s === 'höger' ? '↗' : s === 'vänster' ? '↖' : '↑');
    }

    case 'on ramp': {
      const v = s ? `ta påfarten till ${s}` : 'ta påfarten';
      return ut(v + (motMal || forbi), v, s === 'vänster' ? '↖' : '↗');
    }

    case 'off ramp': {
      const nr = avfartsnr ? `, avfart ${avfartsnr}` : '';
      const v = s ? `ta avfarten till ${s}` : 'ta avfarten';
      return ut(v + nr + (motMal || paNamn), v, s === 'vänster' ? '↖' : '↗');
    }

    case 'roundabout':
    case 'rotary': {
      // exit saknas ibland i OSRM:s svar. Då är "kör in i rondellen" allt vi
      // ärligt kan säga — att gissa på "första avfarten" vore att hitta på.
      if (Number.isFinite(m.exit) && m.exit > 0) {
        const v = `kör av vid ${ordningstal(m.exit)} avfarten i rondellen`;
        return ut(v + paNamn, `${ordningstal(m.exit)} avfarten`, '⭯');
      }
      return ut('kör in i rondellen' + paNamn, 'in i rondellen', '⭯');
    }

    case 'roundabout turn': {
      const v = SVANG[mod] || SVANG.straight;
      return ut(`i rondellen, ${v.fras}${paNamn}`, v.kort, '⭯');
    }

    case 'exit roundabout':
    case 'exit rotary':
      return ut('kör ut ur rondellen' + paNamn, 'ut ur rondellen', '⭯');

    case 'new name':
      return ut(namn ? `fortsätt på ${namn}` : 'fortsätt rakt fram', 'fortsätt', '↑');

    case 'continue': {
      if (mod === 'uturn') return ut('vänd om' + forbi, 'vänd om', '⮐');
      const v = SVANG[mod];
      if (v && mod && mod !== 'straight') return ut(v.fras + paNamn, v.kort, v.symbol);
      return ut('fortsätt' + forbi, 'fortsätt', '↑');
    }

    case 'notification':
    default:
      return ut('fortsätt' + forbi, 'fortsätt', '↑');
  }
}

/**
 * Platta ut ett OSRM-svar till det modulen arbetar med.
 *
 * Anropas på route-objektet ur j.routes[0], alltså efter att koden som hämtade
 * det redan kollat att svaret är Ok. Stegen slås ihop över alla legs: med en
 * enda start och ett enda mål finns bara en leg, men om appen någon gång lägger
 * till mellanstopp ska det inte krascha här.
 *
 * @returns {{punkter:Array<[number,number]>, steg:Array, distanceM:number,
 *            durationS:number}}
 */
export function tolkaOsrmRutt(raw) {
  const koord = raw?.geometry?.coordinates;
  if (!Array.isArray(koord) || koord.length < 2) {
    throw new NavigeringsFel('Ruttjänsten gav ingen väg.', 'ingen-vag');
  }
  const punkter = koord.map(([lon, lat]) => [lat, lon]);
  const steg = [];
  for (const leg of (raw.legs || [])) {
    for (const s of (leg.steps || [])) steg.push(s);
  }
  return {
    punkter,
    steg,
    distanceM: Number(raw.distance) || 0,
    durationS: Number(raw.duration) || 0,
  };
}

/* ===================================================================== */
/* Hämtning                                                              */
/* ===================================================================== */

export class NavigeringsFel extends Error {
  /** @param {string} kod  'nat' | 'timeout' | 'svar' | 'ingen-vag' | 'for-lang' */
  constructor(meddelande, kod = 'nat') {
    super(meddelande);
    this.name = 'NavigeringsFel';
    this.kod = kod;
  }
}

// Samma två värdar som rutt.js. FOSSGIS-instansen är en annan maskin med
// samma API — värd att ha när demoservern viker sig. Se docs/navigering.md om
// varför två publika servrar ändå inte är samma sak som driftsäkerhet.
export const OSRM_VARDAR = [
  'https://router.project-osrm.org/route/v1/driving',
  'https://routing.openstreetmap.de/routed-car/route/v1/driving',
];

const OSRM_FEL = {
  NoRoute: ['Det går inte att köra dit härifrån.', 'ingen-vag'],
  NoSegment: ['Hittar ingen väg nära start eller mål.', 'ingen-vag'],
  TooBig: ['Rutten är för lång för ruttjänsten.', 'for-lang'],
  InvalidQuery: ['Ruttjänsten förstod inte förfrågan.', 'svar'],
};

/**
 * Hämta en rutt MED svängbeskrivningar.
 *
 * Enda funktionen i filen som rör nätet. Allt annat är rent räknande, och det
 * är därför hela beslutslogiken går att testa utan uppkoppling.
 *
 * overview=full av samma skäl som i rutt.js: den förenklade linjen skär hörn
 * med hundratals meter i avfartsslingor, och det är precis den storleksordning
 * både korridorlogiken och "avstånd till nästa sväng" arbetar i.
 *
 * @param {{lat:number,lon:number}} start
 * @param {{lat:number,lon:number}} mal
 * @param {{timeoutMs?:number, forsok?:number, hamta?:Function, vardar?:string[]}} [opts]
 * @returns {Promise<{punkter, steg, distanceM, durationS, kalla:string}>}
 */
export async function hamtaOsrmRutt(start, mal, opts = {}) {
  const hamta = opts.hamta || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!hamta) throw new NavigeringsFel('Ingen nätverksfunktion tillgänglig.', 'nat');
  const vardar = opts.vardar || OSRM_VARDAR;
  const forsok = opts.forsok ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8000;

  const koord = `${start.lon},${start.lat};${mal.lon},${mal.lat}`;
  const qs = '?overview=full&geometries=geojson&alternatives=false' +
    '&steps=true&annotations=false&continue_straight=default';

  let sistaFel = null;
  for (let i = 0; i < forsok; i++) {
    const vard = vardar[i % vardar.length];
    // Utan timeout kan en server som accepterar anslutningen men aldrig svarar
    // låsa hela omräkningen. En förare som kört fel står då utan besked hur
    // länge som helst, vilket är sämre än ett tydligt "kunde inte räkna om".
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const klocka = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await hamta(`${vard}/${koord}${qs}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl?.signal,
      });
      if (!r.ok) throw new NavigeringsFel(`Ruttjänsten svarade ${r.status}.`, 'svar');
      const j = await r.json();
      if (j.code && j.code !== 'Ok') {
        const [txt, kod] = OSRM_FEL[j.code] || ['Ruttjänsten kunde inte räkna ut vägen.', 'svar'];
        throw new NavigeringsFel(txt, kod);
      }
      const rutt = tolkaOsrmRutt(j.routes?.[0]);
      if (!rutt.steg.length) {
        // Geometrin finns men svängarna saknas. Rutten går att rita och att
        // varna längs, men det går inte att navigera efter den. Säg det rakt
        // ut i stället för att tyst ge föraren en linje utan instruktioner.
        throw new NavigeringsFel('Ruttjänsten gav ingen vägbeskrivning.', 'svar');
      }
      return { ...rutt, kalla: vard };
    } catch (e) {
      sistaFel = e?.name === 'AbortError'
        ? new NavigeringsFel('Ruttjänsten svarade inte i tid.', 'timeout')
        : (e instanceof NavigeringsFel ? e
          : new NavigeringsFel('Kunde inte nå ruttjänsten.', 'nat'));
      // Ett NoRoute är inte ett driftfel. Att fråga en annan server om samma
      // omöjliga resa ger samma svar och kostar bara tid.
      if (sistaFel.kod === 'ingen-vag' || sistaFel.kod === 'for-lang') break;
      if (i < forsok - 1) await paus(600 * (i + 1));
    } finally {
      if (klocka) clearTimeout(klocka);
    }
  }
  throw sistaFel || new NavigeringsFel('Ruttjänsten svarar inte.', 'nat');
}

const paus = ms => new Promise(r => setTimeout(r, ms));

/* ===================================================================== */
/* Navigeringen                                                          */
/* ===================================================================== */

/**
 * Följer bilen längs rutten och bestämmer vad som ska sägas.
 *
 * Inget nät, ingen DOM, ingen talsyntes, ingen klocka. Skicka in en rutt och
 * en position, få ut ett tillstånd och noll eller en mening.
 *
 * Typiskt bruk:
 *
 *   const nav = new Navigering();
 *   const rutt = await hamtaOsrmRutt(start, mal);
 *   for (const yttrande of nav.satt({ ...rutt, mal }, { nu: Date.now() }).tal) {
 *     speaker.say(yttrande.text, { priority: yttrande.prioritet });
 *   }
 *   // sedan, vid varje GPS-fix:
 *   const t = nav.uppdatera(fix, Date.now());
 *   for (const y of t.tal) if (Date.now() <= y.giltigTillTs) speaker.say(...);
 */
export class Navigering {
  constructor(opts = {}) {
    this.opts = { ...NAV_STANDARD, ...opts };
    this.#nollstall();
  }

  #nollstall() {
    this.rutt = null;
    this.mal = null;
    this.lage = 'ingen';        // 'ingen' | 'navigerar' | 'avvikande' | 'framme'
    this.s = 0;                 // meter längs rutten
    this.lateralM = 0;
    this.stegIndex = 0;
    this.fartKmh = null;        // utjämnad
    this.varning = null;        // t.ex. att geometrin inte matchar stegen

    this._stegPekare = 0;
    this._talat = new Set();    // `${stegIndex}:${fas}`
    this._sisteTalTs = 0;
    this._forraFix = null;
    this._avvik = { antal: 0, forsta: null };
    this._omberakningar = 0;
    this._sisteOmberakningTs = -Infinity;
    this._badOmberakning = false;
    this._sadeUppgivet = false;
  }

  setOptions(o) { this.opts = { ...this.opts, ...o }; }

  get aktiv() { return this.lage === 'navigerar' || this.lage === 'avvikande'; }

  /**
   * Sätt (eller byt ut) rutten.
   *
   * @param {object} rutt
   *   @param {Array<[number,number]>} rutt.punkter   geometrin, [lat, lon]
   *   @param {Array} rutt.steg                       OSRM-steg
   *   @param {number} [rutt.distanceM]
   *   @param {number} [rutt.durationS]
   *   @param {object} [rutt.geometri]  färdig ruttgeometri att återanvända —
   *                                    skicka guide.route från rutt.js här
   *   @param {{lat,lon,label?}} [rutt.mal]
   * @param {{nu:number, orsak?:'ny'|'omberakning'}} ctx
   * @returns {{tal:Array, rutt:object}}
   */
  satt(rutt, ctx = {}) {
    const nu = kravTid(ctx.nu, 'satt');
    const orsak = ctx.orsak || 'ny';

    if (!Array.isArray(rutt?.steg) || rutt.steg.length < 2) {
      throw new NavigeringsFel('Rutten saknar vägbeskrivning.', 'svar');
    }

    const linje = arGeometri(rutt.geometri)
      ? rutt.geometri
      : new Ruttlinje(rutt.punkter || []);
    if (!Number.isFinite(linje.lengthM) || linje.lengthM <= 0) {
      throw new NavigeringsFel('Rutten saknar geometri.', 'ingen-vag');
    }

    const { stegStart, varaktighetKvar, varning } = byggStegIndex(rutt.steg, linje);

    // Vid omräkning nollställs allt som handlar om VAD som sagts: det är en ny
    // väg med nya svängar, och gamla steg-index betyder ingenting längre.
    // Räknaren för antal omräkningar behålls däremot — den är hela poängen med
    // spärren mot att mala ruttjänsten.
    const behallOmrakningar = this._omberakningar;
    const behallSiste = this._sisteOmberakningTs;
    this.#nollstall();
    if (orsak === 'omberakning') {
      this._omberakningar = behallOmrakningar;
      this._sisteOmberakningTs = behallSiste;
    }

    this.rutt = {
      punkter: rutt.punkter || linje.points,
      steg: rutt.steg,
      stegStart,
      varaktighetKvar,
      linje,
      distanceM: Number.isFinite(rutt.distanceM) ? rutt.distanceM : linje.lengthM,
      durationS: Number.isFinite(rutt.durationS) ? rutt.durationS : null,
    };
    this.mal = rutt.mal || null;
    this.varning = varning;
    this.lage = 'navigerar';
    this.s = 0;
    this.stegIndex = 0;

    return { rutt: this.publikRutt(), tal: this.#startTal(nu, orsak) };
  }

  rensa() { this.#nollstall(); }

  /**
   * En GPS-fix.
   *
   * @param {{lat:number, lon:number, accuracy?:number, speedKmh?:number, ts?:number}} fix
   * @param {number} [nu]  epoch-ms. Faller tillbaka på fix.ts. En av dem MÅSTE
   *                       finnas — modulen läser aldrig klockan själv.
   * @returns {object} tillståndet, med `tal` = det som bör sägas nu (0 eller 1
   *                   svängbeskrivning, plus eventuellt ett ankomst- eller
   *                   omräkningsbesked).
   */
  uppdatera(fix, nu = fix?.ts) {
    const tid = kravTid(nu, 'uppdatera');
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) {
      return this.tillstand(tid);
    }
    if (!this.rutt || this.lage === 'framme') return this.tillstand(tid);

    const fart = this.#fart(fix, tid);
    const trafF = this.#projicera(fix, tid);
    this._forraFix = { lat: fix.lat, lon: fix.lon, ts: tid };

    const tal = [];

    if (trafF.paRutten) {
      if (this.lage === 'avvikande') {
        // Tillbaka på vägen av sig själv. Händer hela tiden i trafikplatser
        // där rätt fil ligger femtio meter från mittlinjen. Ingen omräkning
        // behövs, och att säga något om det vore bara brus.
        this.lage = 'navigerar';
        this._badOmberakning = false;
      }
      this._avvik = { antal: 0, forsta: null };
      this.stegIndex = this.#stegVid(this.s);

      if (this.#framme()) {
        this.lage = 'framme';
        tal.push(this.#yttrande('ankomst', null,
          this.mal?.label ? `Du är framme vid ${this.mal.label}.` : 'Du är framme.', tid));
        return this.tillstand(tid, tal);
      }
      tal.push(...this.#instruktioner(tid, fart));
    } else {
      tal.push(...this.#avvikelse(fix, tid));
    }

    return this.tillstand(tid, tal);
  }

  /* ---------------- Position ---------------- */

  /**
   * Var på rutten är vi?
   *
   * Fönstersökning först: vi vet var vi var förra sekunden och hur fort det
   * går, alltså räcker det att titta på ett kort stycke av linjen. Bara när
   * fönstret inte ger en rimlig träff söks hela rutten igenom. Det gör
   * skillnaden mellan tiotals segment och tiotusen, varje sekund, i en telefon
   * som samtidigt ritar karta.
   *
   * Fönstret är avsiktligt snålt bakåt (150 m) och generöst framåt: en tunnel
   * eller en app som legat i bakgrunden kan ge ett hopp på flera kilometer,
   * och det ska inte kastas ut som en avvikelse.
   */
  #projicera(fix, tid) {
    const r = this.rutt;
    const noggrannhet = Number.isFinite(fix.accuracy) ? fix.accuracy : 0;
    const trosk = Math.max(this.opts.avvikM, noggrannhet * 1.5);

    let traff = null;
    if (this._forraFix) {
      const dt = clamp((tid - this._forraFix.ts) / 1000, 1, 120);
      const mps = Math.max(this.fartKmh ?? 70, 30) / 3.6;
      const framat = Math.min(8000, mps * dt * 3 + 250);
      traff = r.linje.nearestBetween(fix.lat, fix.lon, this.s - 150, this.s + framat);
    }
    if (!traff || traff.lateral > trosk) {
      const global = r.linje.nearest(fix.lat, fix.lon);
      if (global && (!traff || global.lateral < traff.lateral)) traff = global;
    }
    if (!traff) return { paRutten: false, trosk, noggrannhet };

    this.lateralM = traff.lateral;
    const paRutten = traff.lateral <= trosk;
    if (paRutten) {
      // Positionen får backa långsamt men inte hoppa.
      //
      // Gränsen på sextio meter per fix skiljer två saker som ser lika ut i
      // datan. Kör man tillbaka samma väg efter en U-sväng flyttar sig
      // positionen fjorton meter per sekund i 50 km/h, och det ska följas —
      // annars fryser "kvar till målet" mitt i vändningen. Ett hopp på flera
      // hundra meter mellan två fixar är däremot ingen bil, det är en telefon
      // som låst på fel satelliter, och att följa det skulle kasta oss tillbaka
      // förbi svängar vi redan kört.
      this.s = traff.s < this.s - 60 ? this.s : traff.s;
    }
    return { paRutten, trosk, noggrannhet };
  }

  /**
   * Utjämnad fart.
   *
   * Saknar fixen speedKmh härleds farten ur förflyttningen sedan förra fixen.
   * Det är sämre — positionsbrus blir till fantomfart — men det är bättre än
   * att falla tillbaka på en konstant, för hela tidslogiken hänger på att
   * farten är ungefär rätt.
   */
  #fart(fix, tid) {
    let kmh = null;
    if (Number.isFinite(fix.speedKmh) && fix.speedKmh >= 0) {
      kmh = fix.speedKmh;
    } else if (this._forraFix) {
      const dt = (tid - this._forraFix.ts) / 1000;
      if (dt >= 0.5 && dt <= 30) {
        kmh = distance(this._forraFix.lat, this._forraFix.lon, fix.lat, fix.lon) / dt * 3.6;
      }
    }
    if (kmh === null) return this.#beslutsfart();
    this.fartKmh = this.fartKmh === null
      ? kmh
      : this.fartKmh + (kmh - this.fartKmh) * this.opts.fartUtjamning;
    return this.#beslutsfart();
  }

  /**
   * Farten som utlösningsavstånden räknas på.
   *
   * Blandar in vägens egen fart enligt OSRM (steglängd delat med stegtid).
   * Poängen syns i kö på motorvägen: GPS säger 8 km/h, men avfarten kommer
   * ändå att passera i 100 så fort kön släpper, och en förvarning på hundra
   * meter är då för sent. Vägens fart viktas ner till 60 % så att den inte tar
   * över helt när man verkligen står still.
   */
  #beslutsfart() {
    const gps = Number.isFinite(this.fartKmh) ? Math.max(0, this.fartKmh) : 0;
    const vagen = this.#stegfart();
    return Math.max(gps, vagen * 0.6, this.opts.minFartKmh);
  }

  #stegfart() {
    const st = this.rutt?.steg?.[this.stegIndex];
    if (!st || !(st.duration > 0) || !(st.distance > 0)) return 0;
    return (st.distance / st.duration) * 3.6;
  }

  /**
   * Vilket steg befinner vi oss på?
   *
   * Pekaren går bara framåt i normalfallet — den bakåtgående loopen finns för
   * hopp efter en paus i appen. Taket är näst sista steget: sista steget är
   * alltid OSRM:s `arrive`, som har längden noll och därför inte är något man
   * "befinner sig på" annat än i slutögonblicket.
   */
  #stegVid(s) {
    const st = this.rutt.stegStart;
    const max = this.rutt.steg.length - 1;
    let i = Math.min(this._stegPekare, max);
    while (i < max && st[i + 1] <= s) i++;
    while (i > 0 && st[i] > s + 5) i--;
    this._stegPekare = i;
    return i;
  }

  /* ---------------- Vad ska sägas ---------------- */

  /**
   * Utlösningsavstånden för den här sekunden.
   *
   * Räknas om vid VARJE fix, vilket är hela poängen: bromsar man in från 110
   * till 50 för att en kö byggts upp krymper förvarningen från 550 till 250 m
   * på ett par sekunder, och beskedet kommer där det gör nytta i stället för
   * där det var planerat.
   */
  utlosare(fartKmh = this.#beslutsfart()) {
    const o = this.opts;
    const mps = Math.max(0, fartKmh) / 3.6;
    return {
      fartKmh,
      langtM: clamp(mps * o.langtS, o.langtMinM, o.langtMaxM),
      snartM: clamp(mps * o.snartS, o.snartMinM, o.snartMaxM),
      nuM: clamp(mps * o.nuS, o.nuMinM, o.nuMaxM),
    };
  }

  /**
   * Välj eventuell svängbeskrivning.
   *
   * Högst en per fix. Fyrar "nu" markeras "snart" och "långt" som avklarade i
   * samma veva — hinner man ända fram utan att ha hört förvarningen finns det
   * ingen anledning att säga den efteråt.
   */
  #instruktioner(nu, fartKmh) {
    const r = this.rutt;
    const i = this.stegIndex;
    const j = this.#nastaHandling(i);
    if (j == null) return [];                    // bara namnbyten kvar
    const nasta = r.steg[j];

    const avstand = r.stegStart[j] - this.s;
    if (!(avstand >= 0)) return [];
    // Utrymmet vi har att annonsera i sträcker sig från där vi är nu fram till
    // manövern — namnbyten på vägen dit tar inget utrymme, för de sägs inte.
    const steglangd = r.stegStart[j] - r.stegStart[i];
    const u = this.utlosare(fartKmh);

    // Gatnätsregeln: ett besked får inte fyra längre bort än steget är långt,
    // annars krockar det med föregående sväng.
    const ryms = utM => steglangd >= utM * this.opts.stegMarginal;

    // Ankomsten har inget "nu"-läge.
    //
    // Framme-tröskeln (60 m) och nu-fönstret (upp till 120 m) överlappar, så i
    // högre fart hann båda fyra och föraren fick höra "Du är framme" och sedan
    // "Du är framme vid Drottninggatan" med några sekunders mellanrum. Den
    // sista meningen är den riktiga; manöverbeskedet är överflödigt. Däremot
    // behålls "Om 350 meter, du är framme, målet ligger på höger sida" — den
    // säger något manöverbeskedet inte gör, nämligen att börja titta åt höger.
    const arAnkomst = nasta.maneuver?.type === 'arrive';

    let fas = null;
    if (!arAnkomst && avstand <= u.nuM && !this.#harTalat(j, 'nu')) fas = 'nu';
    else if (avstand <= u.snartM && ryms(u.snartM) && !this.#harTalat(j, 'snart')) fas = 'snart';
    else if (avstand <= u.langtM && u.langtM > u.snartM && ryms(u.langtM)
      && !this.#harTalat(j, 'langt')) fas = 'langt';
    if (!fas) return [];

    // Talpausen gäller inte "nu". Den handlar om något som händer inom några
    // sekunder och får aldrig hållas tillbaka av att vi nyss sagt något annat.
    if (fas !== 'nu' && nu - this._sisteTalTs < this.opts.navMinGapMs) return [];

    // Markera den valda fasen och alla längre bort som avklarade.
    const trappa = ['langt', 'snart', 'nu'];
    for (const f of trappa.slice(0, trappa.indexOf(fas) + 1)) this.#markera(j, f);

    const m = beskrivManover(nasta);
    const kedja = this.#kedja(j);
    let text;
    if (fas === 'nu') {
      text = versal(m.kort) + (m.typ === 'arrive' ? '.' : ' nu.');
    } else {
      text = `Om ${spokenDistance(avstand)}, ${m.fras}.`;
    }
    if (kedja && fas !== 'langt') text = text.replace(/\.$/, '') + `, ${kedja}.`;

    this._sisteTalTs = nu;
    return [this.#yttrande('sväng', fas, text, nu, {
      stegIndex: j, avstandM: Math.round(avstand), manover: m,
    })];
  }

  /**
   * Nästa steg efter i som kräver att föraren gör något.
   * Namnbyten och notifikationer hoppas över — se kraverHandling().
   */
  #nastaHandling(i) {
    const steg = this.rutt.steg;
    for (let j = i + 1; j < steg.length; j++) {
      if (kraverHandling(steg[j])) return j;
    }
    return null;
  }

  /**
   * Sammanlänkning: "sväng höger, sedan vänster".
   *
   * Två svängar hundra meter isär hinner inte bli två meningar. Vid 50 km/h är
   * hundra meter sju sekunder, och en talsyntes hinner knappt säga den första
   * meningen på den tiden.
   */
  #kedja(index) {
    const r = this.rutt;
    if (!Number.isFinite(index)) return '';
    const k = this.#nastaHandling(index);
    if (k == null) return '';
    const mellan = r.stegStart[k] - r.stegStart[index];
    if (!(mellan > 0) || mellan > this.opts.kedjaM) return '';
    const m = beskrivManover(r.steg[k]);
    if (m.typ === 'arrive') return 'sedan är du framme';
    return `sedan ${m.kort}`;
  }

  #harTalat(index, fas) { return this._talat.has(`${index}:${fas}`); }
  #markera(index, fas) { this._talat.add(`${index}:${fas}`); }

  /** Meningarna vid ruttstart. */
  #startTal(nu, orsak) {
    if (orsak === 'omberakning') {
      const m = beskrivManover(this.rutt.steg[1] || this.rutt.steg[0]);
      return [this.#yttrande('omberaknad', null, `Ny rutt. ${versal(m.fras)}.`, nu)];
    }
    const km = this.rutt.distanceM / 1000;
    const min = this.rutt.durationS ? Math.round(this.rutt.durationS / 60) : null;
    const vart = this.mal?.label ? ` till ${this.mal.label}` : '';
    const resa = `Rutt${vart}, ${spokenDistance(this.rutt.distanceM)}` +
      (min != null ? `, ungefär ${min} minuter.` : '.');

    const ut = [this.#yttrande('resa', null, resa, nu, { km })];
    // Avgången sägs bara när den bär information. "Kör iväg" är brus.
    const start = beskrivManover(this.rutt.steg[0]);
    if (start.typ === 'depart' && start.vagnamn) {
      ut.push(this.#yttrande('start', null, versal(start.fras) + '.', nu,
        { stegIndex: 0, manover: start }));
    }
    return ut;
  }

  /* ---------------- Av rutten ---------------- */

  /**
   * Räkna, men slå inte larm förrän det är övertygande. Se villkoren vid
   * NAV_STANDARD.avvikM.
   */
  #avvikelse(fix, nu) {
    const o = this.opts;
    const noggrannhet = Number.isFinite(fix.accuracy) ? fix.accuracy : 0;

    // En fix som är sämre än maxNoggrannhetM säger ingenting. Den varken
    // fyller på räknaren eller nollställer den — den räknas helt enkelt inte.
    if (noggrannhet > o.maxNoggrannhetM) return [];

    this._avvik.antal++;
    if (!this._avvik.forsta) this._avvik.forsta = { lat: fix.lat, lon: fix.lon, ts: nu };
    const f = this._avvik.forsta;
    const resa = distance(f.lat, f.lon, fix.lat, fix.lon);
    const gatt = (nu - f.ts) / 1000;

    const overtygande = this._avvik.antal >= o.avvikFixar &&
      resa >= o.avvikMinResaM && gatt >= o.avvikMinTidS;
    if (!overtygande) return [];

    const forst = this.lage !== 'avvikande';
    this.lage = 'avvikande';

    // Pausen mellan omräkningar. I en trafikplats är man "av rutten" varannan
    // sekund; utan paus skulle OSRM få femton anrop på en halv minut och
    // föraren skulle höra "räknar om" som en papegoja.
    if (nu - this._sisteOmberakningTs < o.omberakningPausMs) return [];

    if (this._omberakningar >= o.maxOmberakningar) {
      // Nödbromsen. Vi har försökt tio gånger och ligger fortfarande fel.
      // Antingen är nätet borta eller så finns det ingen väg tillbaka. Säg det
      // en gång och håll sedan tyst — att fortsätta mala hjälper ingen.
      if (this._sadeUppgivet) return [];
      this._sadeUppgivet = true;
      return [this.#yttrande('uppgivet', null,
        'Jag hittar inte tillbaka till rutten. Välj resmål igen när du står stilla.', nu)];
    }

    this._sisteOmberakningTs = nu;
    this._omberakningar++;
    this._badOmberakning = true;

    // Bara första gången sägs något. Kommer man tillbaka på rutten och åker av
    // igen är det en ny avvikelse och då sägs det igen.
    return forst ? [this.#yttrande('omberakning', null, 'Du har lämnat rutten. Räknar om.', nu)] : [];
  }

  /**
   * Tog modulen emot en begäran om ny rutt som appen ännu inte svarat på?
   * Nollställs så fort den lästs — appen ska hämta EN gång per begäran.
   */
  #taBegaran() {
    if (!this._badOmberakning) return null;
    this._badOmberakning = false;
    return this._forraFix ? { lat: this._forraFix.lat, lon: this._forraFix.lon } : null;
  }

  /* ---------------- Framme ---------------- */

  #framme() {
    const kvar = this.#kvarM();
    if (kvar <= this.opts.frammeM) return true;
    // OSRM:s slutpunkt ligger på vägen, inte på adressen. Står bilen på
    // parkeringen bakom huset kan det vara hundra meter kvar på linjen medan
    // föraren i praktiken är framme.
    if (this.mal && Number.isFinite(this.mal.lat) && kvar <= 250) {
      const f = this._forraFix;
      if (f && distance(f.lat, f.lon, this.mal.lat, this.mal.lon) <= this.opts.frammeM) return true;
    }
    return false;
  }

  /* ---------------- Avläsning ---------------- */

  #kvarM() { return Math.max(0, this.rutt.linje.lengthM - this.s); }

  /**
   * Restid kvar.
   *
   * Summan av de återstående stegens egna varaktigheter plus den andel av det
   * pågående steget som är kvar — inte totaltiden skalad linjärt mot
   * återstående sträcka. Skillnaden är stor på en blandad rutt: har man tio
   * kilometer motorväg kvar och två kilometer stadstrafik är de två sista
   * kilometrarna tidsmässigt värda lika mycket som de tio första, och en
   * linjär skalning skulle lova en ankomsttid som är sex minuter fel.
   *
   * Vad den INTE vet är trafik. Se docs/navigering.md.
   */
  #kvarS() {
    const r = this.rutt;
    if (!r.varaktighetKvar) return null;
    const i = Math.min(this.stegIndex, r.steg.length - 1);
    const langd = r.stegStart[i + 1] - r.stegStart[i];
    const kvarISteget = Math.max(0, (r.stegStart[i + 1] ?? r.linje.lengthM) - this.s);
    const andel = langd > 0 ? clamp(kvarISteget / langd, 0, 1) : 0;
    const eget = (r.steg[i]?.duration || 0) * andel;
    return Math.round(eget + (r.varaktighetKvar[i + 1] || 0));
  }

  /**
   * Hela tillståndet. Rent avläsande — anropa hur ofta som helst, till exempel
   * för att rita om gränssnittet i en annan takt än GPS:en tickar.
   */
  tillstand(nu, tal = []) {
    if (!this.rutt) {
      return { lage: 'ingen', tal, begarOmberakning: null, framme: false };
    }
    const r = this.rutt;
    const i = this.stegIndex;
    // Panelen ska visa nästa SVÄNG, inte nästa namnbyte. Föraren som ser
    // "Fortsätt · 1,4 km" har inte fått veta något; "Håll vänster · 1,4 km"
    // är samma sträcka och ett svar på frågan.
    const j = this.#nastaHandling(i);
    const nasta = j != null ? r.steg[j] : null;
    const kvarS = this.#kvarS();
    const manover = nasta ? beskrivManover(nasta) : null;

    return {
      lage: this.lage,
      framme: this.lage === 'framme',
      s: Math.round(this.s),
      lateralM: Math.round(this.lateralM),
      kvarM: Math.round(this.#kvarM()),
      kvarS,
      ankomstTs: kvarS != null && Number.isFinite(nu) ? nu + kvarS * 1000 : null,
      stegIndex: i,
      steg: r.steg[i] || null,
      nastaManover: nasta ? {
        ...manover,
        stegIndex: j,
        avstandM: Math.round(Math.max(0, r.stegStart[j] - this.s)),
        s: r.stegStart[j],
        punkt: r.linje.pointAt(r.stegStart[j]),
      } : null,
      efterfoljande: (j != null ? this.#kedja(j) : '') || null,
      fart: { gpsKmh: this.fartKmh, beslutKmh: this.#beslutsfart() },
      utlosare: this.utlosare(),
      avvikFixar: this._avvik.antal,
      omberakningar: this._omberakningar,
      begarOmberakning: this.#taBegaran(),
      varning: this.varning,
      tal,
    };
  }

  /** En rad för gränssnittet. */
  beskriv() {
    if (!this.rutt) return 'Ingen rutt vald.';
    if (this.lage === 'framme') return `Framme vid ${this.mal?.label || 'målet'}.`;
    const t = this.tillstand(0);
    if (this.lage === 'avvikande') return 'Du har lämnat rutten. Räknar om…';
    const sv = t.nastaManover
      ? `${versal(t.nastaManover.kort)} om ${shortDistance(t.nastaManover.avstandM)}`
      : 'Framme snart';
    const min = t.kvarS != null ? `, ${Math.round(t.kvarS / 60)} min` : '';
    return `${sv} · ${shortDistance(t.kvarM)} kvar${min}`;
  }

  /**
   * Rutten delad vid bilen — för att rita den körda delen dämpad och den
   * återstående i full färg. Det är den enskilt tydligaste signalen på en
   * navigationskarta: föraren ser på en halv sekund åt vilket håll rutten går
   * utan att behöva leta reda på sin egen pil.
   *
   * Sökningen är linjär över punkterna. Den ska anropas när kartan ritas om,
   * inte vid varje GPS-fix — på en lång rutt är det tiotusen jämförelser.
   */
  linjeDelad() {
    if (!this.rutt) return { passerad: [], kvar: [] };
    const { linje } = this.rutt;
    const pts = linje.points || this.rutt.punkter;
    const cum = linje.cum;
    if (!cum || !pts?.length) return { passerad: [], kvar: this.rutt.punkter };
    let i = 0;
    while (i < cum.length - 1 && cum[i + 1] <= this.s) i++;
    const har = linje.pointAt(this.s);
    return {
      passerad: [...pts.slice(0, i + 1), har],
      kvar: [har, ...pts.slice(i + 1)],
    };
  }

  /** Serialiserbar bild av rutten — för kartan. */
  publikRutt() {
    if (!this.rutt) return null;
    return {
      punkter: this.rutt.punkter,
      distanceM: this.rutt.distanceM,
      durationS: this.rutt.durationS,
      mal: this.mal,
      manovrar: this.rutt.steg.map((st, i) => ({
        index: i,
        s: this.rutt.stegStart[i],
        punkt: this.rutt.linje.pointAt(this.rutt.stegStart[i]),
        ...beskrivManover(st),
      })),
    };
  }

  /**
   * Bygg ett yttrande.
   *
   * prioritet är alltid NAV_PRIORITET och avbryt alltid false. Se avsnittet
   * högst upp i filen — det är inte en detalj som får varieras per meningstyp.
   *
   * giltigTillTs är bäst-före. Appen ska kasta yttrandet i stället för att
   * läsa upp det om kön hunnit förbi den tidpunkten.
   */
  #yttrande(typ, fas, text, nu, extra = {}) {
    const o = this.opts;
    const livslangd = fas === 'nu' ? o.giltigNuMs
      : fas === 'snart' ? o.giltigSnartMs
        : fas === 'langt' ? o.giltigLangtMs
          : o.giltigOvrigtMs;
    return {
      typ, fas, text,
      prioritet: NAV_PRIORITET,
      avbryt: false,
      skapadTs: nu,
      giltigTillTs: nu + livslangd,
      ...extra,
    };
  }
}

/* ===================================================================== */
/* Stegindex                                                             */
/* ===================================================================== */

/**
 * Lägg stegen på linjen.
 *
 * OSRM:s egna stegdistanser är exakta och sekventiella, så var varje manöver
 * ligger går att räkna ut med ren addition — ingen projektion behövs och inga
 * gissningar görs. Det är robustare än att projicera manöverpunkterna, för en
 * rutt som passerar samma korsning två gånger (en slinga, en tur och retur)
 * skulle annars kunna projicera en manöver till fel varv.
 *
 * Summan av stegdistanserna stämmer sällan exakt med den längd man får av att
 * mäta upp polylinjen: OSRM räknar med sin egen geodesi och geometrin är
 * avrundad till sex decimaler. Skillnaden är typiskt någon promille, men den
 * ackumuleras — på tio mil blir en promille hundra meter, vilket är mer än
 * hela "nu"-fönstret. Därför skalas offseten om mot den uppmätta längden.
 *
 * Går skalfaktorn utanför rimliga gränser är det inte avrundningsbrus utan ett
 * tecken på att geometrin och stegen kommer från OLIKA rutter — precis det som
 * händer om någon hämtar geometrin i rutt.js och stegen här, i två anrop. Då
 * sätts en varning som appen ska visa, för i det läget kan avstånden till
 * svängarna vara hur fel som helst.
 */
function byggStegIndex(steg, linje) {
  const n = steg.length;
  const ra = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ra[i + 1] = ra[i] + (Number(steg[i].distance) || 0);
  const summa = ra[n];

  let skala = 1;
  let varning = null;
  if (summa > 0 && linje.lengthM > 0) {
    skala = linje.lengthM / summa;
    if (skala < 0.9 || skala > 1.1) {
      varning = 'Vägbeskrivningen och kartlinjen kommer inte från samma rutt. ' +
        'Avstånden till svängarna kan vara fel.';
      skala = 1;
    }
  }

  const stegStart = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) stegStart[i] = Math.min(ra[i] * skala, linje.lengthM);
  stegStart[n] = linje.lengthM;

  // Suffixsumma av varaktigheter, så att restiden kvar blir en uppslagning i
  // stället för en loop över alla steg vid varje fix.
  const varaktighetKvar = new Float64Array(n + 2);
  for (let i = n - 1; i >= 0; i--) {
    varaktighetKvar[i] = varaktighetKvar[i + 1] + (Number(steg[i].duration) || 0);
  }

  return { stegStart, varaktighetKvar, varning };
}

/**
 * Klockan är ett argument, inte en global.
 *
 * Kastar hellre än att smyga in Date.now(): en modul som ibland läser klockan
 * själv går inte att testa, och felet skulle märkas först när en tidsberoende
 * bugg inte gick att återskapa.
 */
function kravTid(v, var_) {
  if (!Number.isFinite(v)) {
    throw new TypeError(
      `Navigering.${var_} kräver tiden som argument (fix.ts eller andra argumentet). ` +
      'Modulen läser aldrig klockan själv — det är vad som gör den testbar.');
  }
  return v;
}

export { versal as versalisera, ordningstal, vagnamn, skyltatMal };
