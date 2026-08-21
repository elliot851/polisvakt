// Röst in och röst ut.
//
// UT: speechSynthesis på svenska. Kö så två varningar aldrig pratar i mun
//     på varandra, och prioritet så en nära fara går före en avlägsen.
//
// IN: SpeechRecognition som en ren strömbrytare. Ett tryck startar, ett
//     tryck stoppar — mikrofonen stänger sig aldrig själv. Webbläsarens
//     igenkänning gör tvärtom: den avslutar sessionen vid en paus i talet,
//     vid tystnad, och på vissa telefoner efter en fast tid. Därför startar
//     Listener om igenkänningen internt så länge föraren har den påslagen,
//     och håller ihop texten över omstarterna. iOS Safari saknar
//     SpeechRecognition helt — där faller appen tillbaka på knapparna,
//     vilket voiceInputSupported rapporterar så gränssnittet kan säga det
//     rakt ut.

import { normalize } from './util.js';
import { parseReportText } from './parser.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const voiceInputSupported = !!SR;
export const voiceOutputSupported = 'speechSynthesis' in window;

/* ------------------------------------------------------------------ */
/* Uppläsning                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ljudsession — det som gör att appen beter sig som ett trafikmeddelande.
 *
 * Normalt ska musiken spela ostört: Spotify via CarPlay, radio, poddar. Appen
 * ligger då i "ambient", vilket blandar sig i utan att ta över.
 *
 * När en varning ska läsas upp byter vi till "transient". Telefonen dämpar då
 * annan uppspelning, släpper fram vår röst, och återgår av sig själv — precis
 * som när radion bryter in med ett trafikmeddelande. Utan det här försvinner
 * varningen under musiken, vilket gör hela appen meningslös i en bil.
 *
 * Stöds i Safari 17 och uppåt. Saknas API:et gör webbläsaren sitt eget
 * bästa, och vi rör ingenting.
 */
const audioSession = {
  get available() { return typeof navigator !== 'undefined' && 'audioSession' in navigator; },
  set(type) {
    if (!this.available) return;
    try { navigator.audioSession.type = type; } catch {}
  },
  /** Blanda med musiken. */
  background() { this.set('ambient'); },
  /** Kvar under sitt gamla namn så inget som anropar den går sönder. */
  announce() { this.duck(); },
  /*
   * Varför vi duckar och inte pausar.
   *
   * 'transient-solo' hade pausat Spotify helt. Det låter bättre på pappret,
   * men det lägger ett ansvar på appen som den inte klarar av att bära: går
   * något fel mitt i en varning — fliken dödas, sidan kraschar, batteriet tar
   * slut — blir musiken stående pausad, och föraren vet inte varför. En app
   * som ska göra körningen enklare får inte kunna lämna bilen tyst.
   *
   * 'transient' sänker musiken kraftigt medan rösten går och låter
   * operativsystemet höja tillbaka den efteråt, helt utan att appen behöver
   * göra något. Blir det fel återgår ljudet ändå. Det är rätt sorts fel att
   * ha: värsta utfallet är att musiken låter lågt en stund för länge, inte
   * att den försvinner.
   *
   * Ducking finns i Safari på iOS 17 och senare. Saknas API:et hörs rösten
   * så gott den kan över musiken. Att styra Spotify från en webbapp på
   * Android går inte alls — plattformsbegränsning, inte något appen kan
   * koda sig runt.
   */
  duck() { this.set('transient'); },
};

export { audioSession };

/**
 * Alla levande lyssnare, så uppläsningen kan tysta mikrofonen utan att
 * app.js behöver koppla ihop dem manuellt.
 *
 * Telefonens högtalare sitter en decimeter från dess mikrofon. Läser appen
 * upp "Polis vid Dillos" medan mikrofonen är öppen hör den sig själv, tolkar
 * det som en ny rapport och rapporterar polis vid Dillos en gång till. Det
 * går runt tills någon stänger av appen. Kopplingen här nere gör att
 * uppläsning och igenkänning aldrig är igång samtidigt, oavsett hur
 * gränssnittet råkar vara ihopkopplat.
 */
const liveListeners = new Set();
function notifySpeaking(on, text) {
  for (const l of liveListeners) {
    try { l.noteAppSpeaking(on, text); } catch {}
  }
}

export class Speaker {
  constructor() {
    this.enabled = true;
    this.volume = 1;
    this.rate = 1.05;
    this.queue = [];
    this.speaking = false;
    this.voice = null;
    this.current = null;      // det som lases upp just nu
    this.muteUntil = 0;
    this.onSpeakingChange = () => {};
    audioSession.background();
    if (voiceOutputSupported) {
      const pick = () => { this.voice = this.#pickVoice(); };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  #pickVoice() {
    const all = speechSynthesis.getVoices();
    return all.find(v => v.lang === 'sv-SE')
        || all.find(v => v.lang?.startsWith('sv'))
        || all.find(v => v.default)
        || null;
  }

  get muted() { return Date.now() < this.muteUntil; }
  mute(minutes) { this.muteUntil = Date.now() + minutes * 60000; }
  unmute() { this.muteUntil = 0; }

  /**
   * @param {string} text
   * @param {{priority?:number, interrupt?:boolean}} opts
   *        priority 2 = akut (nära fara), 1 = normal, 0 = bekräftelse
   */
  say(text, opts = {}) {
    if (!voiceOutputSupported || !this.enabled || !text) return;
    if (this.muted && (opts.priority ?? 1) < 2) return;

    /*
     * Upprepning: en varning sägs två gånger som förval.
     *
     * Man kör bil. Det är vägbuller, kanske passagerare, kanske musik som
     * just duckat. Den första meningen används ofta bara till att flytta
     * uppmärksamheten dit — det är den andra man faktiskt hör. Ett
     * vägmärke står kvar tills man passerat det; en röst gör inte det,
     * och upprepningen är det närmaste vi kommer.
     *
     * Bekräftelser (prioritet 0) upprepas inte. "Klippet är sparat" två
     * gånger är tjat, inte säkerhet.
     */
    const prioritet = opts.priority ?? 1;
    const gangerKvar = opts.ganger ?? (prioritet >= 1 ? 2 : 1);
    const item = { text, priority: prioritet, kvar: gangerKvar };

    /*
     * Avbryt bara det som är MINDRE viktigt än det nya.
     *
     * Tidigare avbröt `interrupt` allt, ovillkorligt. Numera finns sju
     * system som kan prata — närhetsvarningar, rutt, vinter, vakthund,
     * krockdetektering, hastighet och bekräftelser — och fyra av dem
     * använder prioritet 2 med avbrott. Två sådana inom en sekund gav
     * "polis rapporterad två kilo— jag har tappat GPS". Föraren fick alltså
     * ingen av dem, i det ögonblick båda var som viktigast.
     *
     * En halv mening är värre än en fördröjd mening. Är det nya lika
     * viktigt som det pågående får det vänta sin tur; kön är sorterad, så
     * det kommer näst.
     */
    const pagaende = this.current?.priority ?? -1;
    if (opts.interrupt && item.priority > pagaende) {
      speechSynthesis.cancel();
      this.queue = [];
      this.speaking = false;
      this.current = null;
    }
    this.queue.push(item);
    this.queue.sort((a, b) => b.priority - a.priority);
    if (this.queue.length > 4) this.queue.length = 4;
    this.#drain();
  }

  #drain() {
    if (this.speaking || !this.queue.length) {
      // Kön tom: lämna tillbaka ljudet till musiken
      if (!this.queue.length && !this.speaking) audioSession.background();
      return;
    }
    const item = this.queue.shift();
    this.current = item;          // vad som lases just nu, se prioritetsregeln i say()
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = 'sv-SE';
    u.rate = this.rate;
    u.volume = this.volume;
    if (this.voice) u.voice = this.voice;
    this.speaking = true;
    audioSession.duck();   // sänk musiken, operativsystemet höjer tillbaka
    notifySpeaking(true, item.text);  // och stäng mikrofonen så vi inte hör oss själva
    this.onSpeakingChange(true);
    const done = () => {
      this.speaking = false;
      this.current = null;
      notifySpeaking(false, item.text);
      this.onSpeakingChange(false);
      /*
       * Ska den sägas en gång till läggs den först i kön igen, inte direkt
       * efter varandra. Skillnaden märks: kommer något viktigare in mellan
       * de två gångerna ska det få gå före, och andra gången kommer efter.
       * En andra uppläsning är värdefull, men inte viktigare än en ny
       * varning.
       */
      if (item.kvar > 1) {
        this.queue.unshift({ ...item, kvar: item.kvar - 1 });
        this.queue.sort((a, b) => b.priority - a.priority);
      }
      // Paus mellan gångerna. 120 ms räcker mellan olika meningar, men två
      // likadana i rad flyter ihop till en enda obegriplig ramsa.
      setTimeout(() => this.#drain(), item.kvar > 1 ? 700 : 120);
    };
    u.onend = done;
    u.onerror = done;
    try { speechSynthesis.speak(u); } catch { done(); }
  }

  /**
   * Spela upp en varning på prov, så föraren vet hur den låter innan den
   * kommer skarpt i 90 km/h. Testar hela kedjan: pling, ducking, uppläsning.
   */
  demo(kind = 'police') {
    /*
     * Meningarna är skrivna för att låta som en RIKTIG varning, inte som en
     * demo. Samma ordföljd, samma avståndsform, samma klockriktning och
     * samma åldersfras som alerts.js bygger skarpt. Ett prov som låter
     * annorlunda än verkligheten lär föraren fel sak, och då är provet värre
     * än inget prov.
     *
     * Fartkameran saknar ålder och klockriktning med flit: den står
     * permanent och rapporteras inte av någon. Civilbilen saknar ålder i
     * den korta formen men får sin livslängd påmind — en civilbil som stått
     * i tjugo minuter är oftast borta, och det är den viktigaste skillnaden
     * mot en vanlig polisbil.
     */
    const samples = {
      police:   'Varning. Polis vid Dillos, om 1,2 kilometer klockan 12, rapporterat för 4 minuter sedan.',
      camera:   'Fartkamera om 600 meter, 80.',
      control:  'Varning. Trafikkontroll vid Erikslund, om 900 meter klockan 11.',
      unmarked: 'Varning. Civil polisbil vid Hälla, om 700 meter klockan 1, rapporterat för 6 minuter sedan.',
      speed:    'Du kör 92. Här är det 70.',
      report:   'Tack. Polis vid Hammarby är rapporterad.',
      hotspot:  'Här brukar det stå polis vid den här tiden.',
    };
    const text = samples[kind] || samples.police;
    const wasMuted = this.muteUntil;
    this.muteUntil = 0;                       // ett prov ska alltid höras
    this.chime(kind === 'report' ? 'ack' : 'alert');
    setTimeout(() => {
      this.say(text, { priority: 2, interrupt: true });
      this.muteUntil = wasMuted;
    }, 380);
    return text;
  }

  stop() {
    this.queue = [];
    try { speechSynthesis.cancel(); } catch {}
    this.speaking = false;
    notifySpeaking(false);
    this.onSpeakingChange(false);
  }

  /** Kort pling före en varning så föraren hinner lyssna. */
  chime(kind = 'alert') {
    try {
      const ctx = this._ctx || (this._ctx = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const tones = kind === 'ack' ? [880] : kind === 'listen' ? [660, 990] : [1046, 784];
      tones.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now + i * 0.13);
        g.gain.exponentialRampToValueAtTime(0.22 * this.volume, now + i * 0.13 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.13 + 0.12);
        o.connect(g).connect(ctx.destination);
        o.start(now + i * 0.13);
        o.stop(now + i * 0.13 + 0.14);
      });
    } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* Ordlistor för att städa upp taligenkänningens text                  */
/* ------------------------------------------------------------------ */

const WAKE_PHRASES = ['hej vakt', 'hallå vakt', 'okej vakt', 'hey vakt', 'hej valt', 'hej vackt'];

// Utfyllnadsljud. Taligenkänningen skriver ut dem, och parsern skulle ta med
// dem i platsfrasen ("öh vid dillos" -> platsen "öh dillos").
const FILLERS = new Set(['öh', 'öhm', 'eh', 'ehm', 'hmm', 'hm', 'mm', 'asså', 'ba']);

/**
 * Sammansatta ord som taligenkänningen ofta särskriver.
 *
 * Det här är inte kosmetik. Parsern matchar ord mot ord, så "alkohol
 * kontroll" innehåller varken "alkoholkontroll" eller något annat ord i
 * nykterhetsfiltret — den skulle glida rakt igenom som en vanlig kontroll.
 * Att sätta ihop orden igen innan parsern får texten är alltså det som gör
 * att filtret håller även när mikrofonen hör särskrivet.
 */
const JOINABLE = new Set([
  'fartkamera', 'fartkameror', 'trafikkontroll', 'fartkontroll', 'hastighetskontroll',
  'laserkontroll', 'poliskontroll', 'polisbil', 'polisbilar', 'civilbil', 'civilbilar',
  'civilpolis', 'civilpoliser', 'blåljus', 'mc-polis', 'motorcykelpolis',
  // nykterhet: måste sättas ihop, annars vägrar inte parsern
  'nykterhetskontroll', 'nykterhetskontroller', 'alkoholkontroll', 'alkoholtest',
  'alkotest', 'utandningsprov', 'promillekontroll', 'rattfyllerikontroll',
  'sållningsprov', 'drogkontroll', 'drogtest',
  // Narkotikaorden saknades här av samma skäl som i parser.js — se
  // SOBRIETY_WORDS där. Parsern fångar dem numera även isärskrivna, men
  // ihopsättningen här gör att texten som visas för föraren blir densamma
  // som den som bedömdes.
  'narkotikakontroll', 'drogsökhund',
  // vanliga vägord
  'avfarten', 'påfarten', 'infarten', 'rondellen', 'korsningen', 'busshållplatsen',
]);

// Enstaka ord som svensk taligenkänning konsekvent hör fel.
// Map, inte objekt: ett yttrande som råkar innehålla "constructor" ska slå
// upp ingenting, inte en funktion från Object.prototype.
const MISHEARD_WORD = new Map([
  ['pollis', 'polis'], ['poliss', 'polis'], ['polisbilen', 'polisbil'],
  ['sivil', 'civil'], ['sivilbil', 'civilbil'], ['civilbilen', 'civilbil'],
  ['snutten', 'snuten'], ['blåljuset', 'blåljus'],
  ['dilos', 'dillos'], ['dillås', 'dillos'], ['dillo', 'dillos'], ['dilloz', 'dillos'],
  ['hella', 'hälla'], ['heller', 'hälla'], ['hälle', 'hälla'],
  ['backby', 'bäckby'], ['beckby', 'bäckby'],
  ['norleden', 'norrleden'], ['nordleden', 'norrleden'],
  ['östeleden', 'österleden'],
  ['roby', 'råby'],
  ['viksang', 'viksäng'], ['vicksäng', 'viksäng'],
  ['hökåsens', 'hökåsen'], ['hokasen', 'hökåsen'],
  ['erikslunds', 'erikslund'], ['eriksslund', 'erikslund'],
]);

/** Felhörda fraser, körs på hela strängen efter att orden städats. */
const MISHEARD_PHRASES = [
  ['dill os', 'dillos'],
  ['eriks lund', 'erikslund'],
  ['erik slund', 'erikslund'],
  ['hammar by', 'hammarby'],
  ['räta linje', 'räta linjen'],
  ['stora gata ', 'stora gatan '],
];

// Ord som brukar stå direkt före ett platsnamn. Bara efter ett sådant vågar
// vi rätta ett ord mot ortlistan — annars riskerar vi att "polis" blir
// "pilgatan" och en varning byter innebörd.
const PLACE_PREPS = new Set(['vid', 'på', 'i', 'utanför', 'mot', 'runt', 'kring', 'bakom',
                             'framför', 'från', 'nere', 'uppe', 'till', 'genom', 'förbi']);

// "en" och "ett" saknas med flit: de är artiklar ("en civil bil vid...") och
// ska aldrig bli siffran 1 i en platsfras.
const UNITS = new Map(Object.entries({
  noll: 0, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9,
  tio: 10, elva: 11, tolv: 12, tretton: 13, fjorton: 14, femton: 15, sexton: 16,
  sjutton: 17, arton: 18, aderton: 18, nitton: 19,
}));
const TENS = new Map(Object.entries({
  tjugo: 20, trettio: 30, fyrtio: 40, förtio: 40, femtio: 50, sextio: 60,
  sjuttio: 70, åttio: 80, nittio: 90,
}));
const ROAD_WORDS = new Set(['e', 'väg', 'vägen', 'riksväg', 'riksvägen', 'rv', 'länsväg',
                            'länsvägen', 'motorväg', 'motorvägen']);

function numFromWord(w) {
  if (/^\d+$/.test(w)) return Number(w);
  if (UNITS.has(w)) return UNITS.get(w);
  if (TENS.has(w)) return TENS.get(w);
  for (const [t, tv] of TENS) {
    if (w.startsWith(t)) {
      const rest = w.slice(t.length);
      if (UNITS.has(rest)) return tv + UNITS.get(rest);
    }
  }
  return null;
}

/* ---- Ortvokabulär --------------------------------------------------- */
//
// Aliaslistan är redan appens facit över hur folk i Västerås säger. Vi läser
// samma fil istället för att skriva av den, så en ny ort bara behöver läggas
// in på ett ställe. Inlärda platser (de föraren pekat ut på kartan) läggs
// till från localStorage — hör mikrofonen "bäck by" ska det bli "bäckby"
// även för en plats bara den här telefonen känner till.

let vocabWords = new Set();
let vocabLoaded = null;

function addVocabKey(key) {
  const k = normalize(key);
  if (!k) return;
  for (const w of k.split(' ')) if (w.length >= 3) vocabWords.add(w);
  if (!k.includes(' ')) vocabWords.add(k);
}

export function loadVoiceVocabulary() {
  if (vocabLoaded) return vocabLoaded;
  vocabLoaded = (async () => {
    try {
      const r = await fetch('./data/aliases.vasteras.json');
      if (r.ok) {
        const json = await r.json();
        for (const key of Object.keys(json)) {
          if (key.startsWith('_')) continue;      // _kommentar är dokumentation
          addVocabKey(key);
          addVocabKey(String(json[key]).split(',')[0]);
        }
      }
    } catch { /* vokabulär är en förbättring, inte ett krav */ }
    try {
      const learned = JSON.parse(localStorage.getItem('pv.learned.v1') || '{}');
      for (const key of Object.keys(learned)) addVocabKey(key);
    } catch {}
    return vocabWords;
  })();
  return vocabLoaded;
}

/** Redigeringsavstånd med tak — vi bryter så fort det blivit för långt. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Närmaste ortnamn, men bara om det är entydigt närmast. */
function nearestPlaceWord(word) {
  if (vocabWords.has(word)) return word;
  const max = word.length >= 9 ? 2 : 1;
  let best = null, bestD = max + 1, ties = 0;
  for (const cand of vocabWords) {
    if (Math.abs(cand.length - word.length) > max) continue;
    const d = editDistance(word, cand, max);
    if (d < bestD) { bestD = d; best = cand; ties = 0; }
    else if (d === bestD) ties++;
  }
  return (best && bestD <= max && ties === 0) ? best : null;
}

/* ---- Städning av transkriptet --------------------------------------- */

function mergeNumbers(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    let w = words[i];

    // "sextiosexan" -> "66an", "56 an" -> "56an": så folk kan säga 66:an
    if (w === 'an' && out.length && /^\d+$/.test(out[out.length - 1])) {
      out[out.length - 1] += 'an';
      continue;
    }
    if (w.length > 3 && w.endsWith('an')) {
      const n = numFromWord(w.slice(0, -2));
      if (n != null && n >= 4) {
        const prev = out[out.length - 1];
        // "e artonan" är E18, inte "e 18an"
        if (prev === 'e') out[out.length - 1] = 'e' + n;
        else if (prev && ROAD_WORDS.has(prev)) out.push(String(n));
        else out.push(String(n) + 'an');
        continue;
      }
    }

    // Vägnummer: bara här skrivs talord om till siffror. "en" och "ett" ska
    // förbli artiklar, och "fem bilar" ska inte bli "5 bilar" i en platsfras.
    if (ROAD_WORDS.has(w) && i + 1 < words.length) {
      const n = numFromWord(words[i + 1]);
      if (n != null) {
        i++;
        // "e 18" skrivs ihop, aliaslistan har e18. Övriga vägord behåller
        // mellanrummet: aliaslistan har "riksväg 66".
        if (w === 'e') { out.push('e' + n); continue; }
        out.push(w, String(n));
        continue;
      }
    }
    out.push(w);
  }
  return out;
}

function joinCompounds(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const joined = words[i] + (words[i + 1] || '');
    if (words[i + 1] && (JOINABLE.has(joined) || vocabWords.has(joined))) {
      out.push(joined);
      i++;
    } else {
      out.push(words[i]);
    }
  }
  return out;
}

/**
 * Tar bort omedelbara upprepningar av upp till fyra ord.
 *
 * Behövs för att vi syr ihop flera igenkänningssessioner. När webbläsaren
 * avslutar mitt i en mening tar nästa session ibland med sig svansen igen:
 * "polis vid polis vid dillos".
 */
function dedupeRuns(words) {
  const w = words.slice();
  for (let n = 4; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= w.length;) {
      const a = w.slice(i, i + n).join(' ');
      const b = w.slice(i + n, i + 2 * n).join(' ');
      if (a === b && a.length > 1) w.splice(i + n, n);
      else i++;
    }
  }
  return w;
}

function fixPlaceWords(words) {
  const out = words.slice();
  for (let i = 1; i < out.length; i++) {
    if (!PLACE_PREPS.has(out[i - 1])) continue;
    const w = out[i];
    if (w.length < 5 || /\d/.test(w) || vocabWords.has(w)) continue;
    const fixed = nearestPlaceWord(w);
    if (fixed) out[i] = fixed;
  }
  return out;
}

/**
 * Gör om taligenkänningens råtext till något parsern känner igen.
 *
 * Taligenkänningen levererar text utan skiljetecken, med siffror som siffror
 * eller som ord beroende på dagsform, och med särskrivna sammansättningar.
 * Parsern jämför ord mot ord. Allt som händer här är alltså att texten
 * putsas innan den lämnas över — själva tolkningen, och de två sakerna
 * appen vägrar rapportera, sitter kvar i parser.js och rörs inte.
 */
export function cleanTranscript(raw) {
  let s = String(raw || '').toLowerCase();
  s = s.replace(/[.,!?;:"'’()[\]…]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (const p of WAKE_PHRASES) s = s.split(p).join(' ');

  let words = s.split(' ').filter(w => w && !FILLERS.has(w));
  words = mergeNumbers(words);
  words = words.map(w => MISHEARD_WORD.get(w) || w);
  words = joinCompounds(words);
  words = dedupeRuns(words);
  words = fixPlaceWords(words);

  // Mellanslag runt om så en fras bara matchar hela ord
  let out = ' ' + words.join(' ') + ' ';
  for (const [from, to] of MISHEARD_PHRASES) out = out.split(from).join(to);
  return out.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Igenkänning                                                         */
/* ------------------------------------------------------------------ */

const MAX_ALTERNATIVES = 5;

// Väckningsordet kan inte tryckas av. Där behövs ett slut på lyssnandet,
// annars står appen och lyssnar i evighet efter ett felaktigt "hej vakt".
const WAKE_SILENCE_MS = 2800;     // tystnad efter tal avslutar
const WAKE_MAX_MS = 14000;        // tak även om någon pratar oavbrutet

const FLUSH_MS = 900;             // hur länge vi väntar på sista slutresultatet
const ECHO_TAIL_MS = 500;         // ekosvans efter att appen slutat prata
const SPEAK_MAX_MS = 30000;       // längsta tid mikrofonen får hållas stängd av uppläsning
const SHORT_SESSION_MS = 300;     // kortare än så = igenkänningen kom aldrig igång
const MAX_FAST_RESTARTS = 6;      // fler i rad = något är fel, sluta snurra
const MAX_NETWORK_RETRIES = 4;

const ERROR_MESSAGES = {
  'not-allowed': 'Mikrofonen är blockerad. Tillåt mikrofon för den här sidan i webbläsarens inställningar.',
  'service-not-allowed': 'Webbläsaren tillåter inte röstigenkänning här. Tillåt mikrofon i inställningarna.',
  'audio-capture': 'Ingen mikrofon hittades. Är ett headset eller bilstereon kopplad till något annat?',
  'network': 'Röstigenkänningen behöver internet och når det inte just nu.',
  'unknown': 'Röstigenkänningen slutade svara. Försök igen.',
};

export class Listener extends EventTarget {
  /**
   * Två egenskaper, med olika syften:
   *
   *   mode   — vad mikrofonen är till för just nu:
   *            'off' | 'wake' (bara väckningsord) | 'command' (ett yttrande)
   *   state  — vad gränssnittet ska rita:
   *            'idle' | 'listening' | 'processing' | 'error'
   *
   * Väckningsläget är 'idle' i state: mikrofonen står visserligen på, men
   * knappen är inte igång och ska inte lysa som om den vore det.
   *
   * Klassen rör aldrig DOM. Den skickar händelser och låter app.js rita.
   */
  constructor() {
    super();
    this.mode = 'off';
    this.state = 'idle';
    this.lastError = null;
    this.errorMessage = '';
    this.restarts = 0;

    this.wantsRunning = false;    // föraren har slagit på mikrofonen
    this.paused = false;          // pausad medan appen pratar

    this.rec = null;
    this.finals = [];             // [{transcript, confidence}[], ...] per slutresultat
    this.interimText = '';

    this.wakeArmed = false;       // väckningsordet ska tillbaka efteråt
    this.autoFinish = false;      // sant bara i väckningsläge
    this.silenceTimer = null;
    this.capTimer = null;
    this.restartTimer = null;
    this.flushTimer = null;

    this.sessionStart = 0;
    this.fastRestarts = 0;
    this.networkRetries = 0;
    this.captureRetries = 0;

    this.appSpeaking = false;
    this.echoUntil = 0;
    this.speakWatchdog = null;
    this.spoken = [];             // {text, until} — vad appen nyss sagt

    liveListeners.add(this);
    loadVoiceVocabulary();        // hinner bli klar långt innan någon pratar
  }

  get supported() { return voiceInputSupported; }
  get listening() { return this.state === 'listening'; }
  /** Allt som hörts hittills i sessionen, inklusive det som sägs just nu. */
  get transcript() {
    const top = this.finals.map(a => a[0].transcript);
    if (this.interimText) top.push(this.interimText);
    return top.join(' ').trim();
  }

  /* ---- Strömbrytaren ------------------------------------------------ */

  /**
   * Ett tryck. På om den är av, av om den är på.
   *
   * app.js anropar startCommand() på varje tryck på mikrofonknappen, och den
   * filen ägs av någon annan. Därför är startCommand en synonym för toggle:
   * andra trycket avslutar och lämnar över texten istället för att starta om
   * en session som redan är igång.
   */
  toggle() {
    if (this.state === 'listening' || this.state === 'processing') this.finish();
    else this.start();
  }

  /** Tryck-och-tala. Se toggle() — samma knapp, samma tryck. */
  startCommand() { this.toggle(); }

  /** Slå på mikrofonen. Den stängs aldrig av sig själv efter det här. */
  start() {
    if (!SR) { this.#emit('unsupported'); return; }
    if (this.state === 'listening') return;
    this.#clearTimers();
    this.#resetCounters();
    this.finals = [];
    this.interimText = '';
    this.lastError = null;
    this.errorMessage = '';
    this.mode = 'command';
    this.autoFinish = false;       // inget tidsslut: föraren trycker själv
    this.wantsRunning = true;
    // Pratar appen just nu får mikrofonen vänta tills munnen är stängd,
    // annars är det första den hör vår egen röst. resume() tar vid.
    this.paused = this.appSpeaking;
    this.#setState('listening');
    this.#emit('listening', { mode: 'command' });
    this.#ensure();
  }

  /**
   * Föraren är klar. Avsluta snyggt: be igenkänningen stänga (då levererar
   * den det sista slutresultatet, till skillnad från abort) och lämna över
   * hela texten när den kommit fram — eller efter FLUSH_MS om den aldrig gör
   * det.
   */
  finish() {
    if (this.state !== 'listening') return;
    this.wantsRunning = false;
    this.#clearTimers();
    this.#setState('processing');
    if (this.rec) {
      try { this.rec.stop(); } catch { this.#submit(); return; }
      this.flushTimer = setTimeout(() => this.#submit(), FLUSH_MS);
    } else {
      this.#submit();
    }
  }

  /** Avbryt utan att tolka något. Det gränssnittets kryss gör. */
  stop() {
    this.wantsRunning = false;
    this.wakeArmed = false;
    this.mode = 'off';
    this.autoFinish = false;
    this.finals = [];
    this.interimText = '';
    this.#clearTimers();
    this.#kill();
    this.#setState('idle');
    this.#emit('stopped');
  }

  /** Lyssna efter väckningsordet i bakgrunden. */
  startWakeWord() {
    if (!SR) { this.#emit('unsupported'); return; }
    if (this.state === 'listening' || this.state === 'processing') return;
    this.wakeArmed = true;
    this.mode = 'wake';
    this.wantsRunning = true;
    this.finals = [];
    this.interimText = '';
    this.#resetCounters();
    this.#setState('idle');
    this.#ensure();
  }

  /* ---- Uppläsning kontra mikrofon ----------------------------------- */

  /** Pausa medan uppläsningen pågår så appen inte hör sig själv. */
  pause() {
    if (!this.wantsRunning || this.paused) return;
    this.paused = true;
    clearTimeout(this.restartTimer);
    this.#kill();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    // Vänta ut ekosvansen: högtalaren är inte tyst i samma ögonblick som
    // speechSynthesis säger att den är klar.
    if (this.wantsRunning) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.#ensure(), ECHO_TAIL_MS);
    }
  }

  /**
   * Kallas av Speaker. Stänger mikrofonen medan appen pratar och kommer ihåg
   * vad som sades, så att ett eventuellt eko som ändå slinker in kan kastas.
   */
  noteAppSpeaking(on, text) {
    clearTimeout(this.speakWatchdog);
    this.appSpeaking = !!on;
    if (on) {
      if (text) this.spoken.push({ text: normalize(text), until: Date.now() + 20000 });
      this.spoken = this.spoken.filter(s => s.until > Date.now()).slice(-6);
      this.echoUntil = Date.now() + SPEAK_MAX_MS;   // kortas ner när talet tar slut
      this.pause();
      // speechSynthesis i Chrome hänger sig ibland utan att skicka 'end'.
      // Utan den här skulle mikrofonen då stå avstängd resten av resan.
      this.speakWatchdog = setTimeout(() => this.noteAppSpeaking(false), SPEAK_MAX_MS);
    } else {
      this.echoUntil = Date.now() + ECHO_TAIL_MS;
      this.resume();
    }
  }

  #echoGated() { return this.appSpeaking || Date.now() < this.echoUntil; }

  /**
   * Är det här appens egen röst som kom tillbaka in i mikrofonen?
   *
   * Kraven är hårda med flit. Mikrofonen är redan avstängd medan appen
   * pratar, så det här fångar bara svansen. En förare som säger "polis vid
   * Skiljebo" strax efter att appen sagt "varning, polis vid Hammarby" delar
   * två av tre ord med uppläsningen — den rapporten får aldrig kastas. Ett
   * riktigt eko är en lång, nästan ordagrann bit av det som just lästes upp.
   */
  #isEcho(text) {
    const heard = normalize(text);
    if (!heard) return true;
    const words = heard.split(' ').filter(Boolean);
    if (words.length < 4) return false;
    for (const s of this.spoken) {
      if (s.until < Date.now()) continue;
      const said = new Set(s.text.split(' '));
      const overlap = words.filter(w => said.has(w)).length / words.length;
      if (overlap >= 0.8) return true;
    }
    return false;
  }

  /* ---- Motorn ------------------------------------------------------- */

  #ensure() {
    if (!this.wantsRunning || this.paused || this.rec || !SR) return;
    const rec = new SR();
    rec.lang = 'sv-SE';
    rec.continuous = true;        // sluta inte vid första meningen
    rec.interimResults = true;    // så knappen kan visa vad som hörs
    rec.maxAlternatives = MAX_ALTERNATIVES;

    rec.onresult = e => this.#onResult(e);
    rec.onerror = e => this.#onError(e);
    rec.onend = () => this.#onEnd();

    try {
      rec.start();
      this.rec = rec;
      this.sessionStart = Date.now();
    } catch {
      // Kastas bland annat om en session redan är igång i samma flik.
      this.rec = null;
      this.#scheduleRestart(500);
    }
  }

  #kill() {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    rec.onresult = rec.onerror = rec.onend = null;
    try { rec.abort(); } catch { try { rec.stop(); } catch {} }
  }

  #onEnd() {
    this.rec = null;

    // Föraren har tryckt stopp och vi väntade bara på sista resultatet.
    if (this.state === 'processing') { this.#submit(); return; }

    if (!this.wantsRunning) {
      if (this.state !== 'error') this.#setState('idle');
      return;
    }
    if (this.paused) return;      // resume() startar om

    // Hit kommer vi när webbläsaren stängde sessionen på eget bevåg: en paus
    // i talet, tystnad, eller en tidsgräns i telefonen. Föraren har inte
    // tryckt av, alltså startar vi om och behåller texten som redan hörts.
    const ranFor = Date.now() - this.sessionStart;
    if (ranFor < SHORT_SESSION_MS) this.fastRestarts++;
    else this.fastRestarts = 0;

    if (this.fastRestarts >= MAX_FAST_RESTARTS) {
      // Sessionerna dör direkt gång på gång. Något är fel med mikrofonen
      // eller tjänsten; att fortsätta försöka blir en evighetsloop som äter
      // batteri utan att någonsin höra ett ord.
      this.#fail(this.lastError || 'unknown');
      return;
    }
    this.restarts++;
    this.#scheduleRestart(Math.min(1500, 250 + this.fastRestarts * 250));
  }

  #scheduleRestart(ms) {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.#ensure(), ms);
  }

  /**
   * Felen betyder helt olika saker och får därför olika svar.
   * Att behandla dem lika är just det som ger antingen en mikrofon som dör
   * tyst eller en omstartsloop som aldrig ger upp.
   */
  #onError(e) {
    const err = e?.error || 'unknown';
    this.lastError = err;

    switch (err) {
      case 'no-speech':
        // Helt normalt: föraren tänker efter, eller det är tyst i en kurva.
        // Ingen åtgärd — onEnd startar om och texten ligger kvar.
        break;

      case 'aborted':
        // Antingen vi själva (pause/stop) eller att telefonen tog mikrofonen
        // till ett samtal. onEnd avgör om vi ska tillbaka.
        break;

      case 'audio-capture':
        // Ingen mikrofon att lyssna på. Prova ett par gånger — headset som
        // kopplas in och ur ger tillfälliga fel — sedan ge upp med besked.
        this.captureRetries++;
        if (this.captureRetries > 2) this.#fail(err);
        else this.#scheduleRestart(800);
        break;

      case 'network':
        // Chromes igenkänning körs i molnet. Utan täckning finns inget att
        // göra, men täckning kommer och går längs vägen, så vi backar av.
        this.networkRetries++;
        if (this.networkRetries > MAX_NETWORK_RETRIES) this.#fail(err);
        else this.#scheduleRestart(600 * this.networkRetries);
        break;

      case 'not-allowed':
      case 'service-not-allowed':
        // Föraren (eller webbläsaren) har sagt nej. Att försöka igen ger
        // bara samma nej. Slå av strömbrytaren och säg varför.
        this.wantsRunning = false;
        this.wakeArmed = false;
        this.mode = 'off';
        this.#clearTimers();
        this.#kill();
        this.#fail(err);
        this.#emit('denied', { error: err, message: ERROR_MESSAGES[err] });
        break;

      default:
        this.#scheduleRestart(700);
    }
  }

  #fail(err) {
    const hadSession = this.state === 'listening' || this.state === 'processing';
    this.wantsRunning = false;
    this.mode = 'off';
    this.autoFinish = false;
    this.#clearTimers();
    this.errorMessage = ERROR_MESSAGES[err] || ERROR_MESSAGES.unknown;
    this.#setState('error', { error: err, message: this.errorMessage });
    this.#emit('error', { error: err, message: this.errorMessage });
    // Stod mikrofonknappen på när det sprack ligger röstöverlägget kvar över
    // kartan tills något säger till. 'timeout' är signalen gränssnittet redan
    // stänger på — felet i sig berättas av 'error' och 'denied'.
    if (hadSession) this.#emitAsync('timeout', { reason: err });
  }

  #onResult(e) {
    // Allt som hörs medan appen pratar är appen själv.
    if (this.#echoGated()) return;

    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        const alts = [];
        for (let a = 0; a < res.length; a++) {
          const t = res[a]?.transcript?.trim();
          if (t) alts.push({ transcript: t, confidence: res[a].confidence ?? 0 });
        }
        if (!alts.length) continue;
        if (this.#isEcho(alts[0].transcript)) continue;
        this.finals.push(alts);
      } else {
        interim += res[0].transcript + ' ';
      }
    }
    this.interimText = interim.trim();

    const heard = this.transcript;
    if (!heard) return;

    if (this.mode === 'wake') {
      const low = heard.toLowerCase();
      if (WAKE_PHRASES.some(p => low.includes(p))) {
        this.mode = 'command';
        this.autoFinish = true;      // ingen knapp att trycka av med
        this.finals = [];
        this.interimText = '';
        this.#resetCounters();
        this.#setState('listening');
        this.#emit('wake');
        this.#armAutoFinish();
        return;
      }
      // Väckningsläget kan stå på i timmar. Spara bara den sista biten, så
      // varken minnet eller ett gammalt "hej" hänger kvar.
      if (this.finals.length > 2) this.finals = this.finals.slice(-2);
      return;
    }

    this.#emit('heard', { text: heard, final: !!this.finals.length, interim: this.interimText });
    this.#setState(this.state);     // bär med sig interimtexten till knappen
    if (this.autoFinish) this.#armAutoFinish();
  }

  /** Bara i väckningsläge: tystnad efter talet avslutar yttrandet. */
  #armAutoFinish() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.state === 'listening') this.finish();
    }, WAKE_SILENCE_MS);
    if (!this.capTimer) {
      this.capTimer = setTimeout(() => {
        if (this.state === 'listening') this.finish();
      }, WAKE_MAX_MS);
    }
  }

  /* ---- Överlämning till parsern ------------------------------------- */

  #submit() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.#clearTimers();

    const chunks = this.finals;
    const interim = this.interimText;
    this.finals = [];
    this.interimText = '';

    const picked = this.#pickTranscript(chunks, interim);
    this.#afterSession();

    if (!picked || !picked.text) {
      // Ingenting hördes. Ingen tolkning, inget felmeddelande — bara stäng.
      this.#emit('timeout', { reason: 'empty' });
      return;
    }
    this.#emitAsync('command', {
      text: picked.text,
      alternatives: picked.all,
      parsed: picked.parsed,          // bara för felsökning; app.js tolkar om
    });
  }

  /** Tillbaka till väckningsläge om det var påslaget, annars släpp mikrofonen. */
  #afterSession() {
    this.autoFinish = false;
    if (this.wakeArmed) {
      this.mode = 'wake';
      this.wantsRunning = true;
      this.#kill();               // ingen halvstängd session kvar att krocka med
      this.#setState('idle');
      this.#scheduleRestart(ECHO_TAIL_MS);
    } else {
      this.mode = 'off';
      this.wantsRunning = false;
      this.#kill();
      this.#setState('idle');
    }
  }

  /**
   * Bygg kandidattexter och välj den som faktiskt betyder något.
   *
   * Igenkänningen lämnar flera gissningar per mening. Den översta är ofta
   * "polis vid dill os" medan trean är "polis vid dillos" — samma ljud, men
   * bara den ena går att göra en rapport av. Vi provar därför gissningarna
   * mot parsern och lämnar över den text som håller.
   *
   * Två saker är viktiga:
   *  - parseReportText används bara för att VÄLJA text. app.js tolkar om den
   *    valda texten själv, så det finns fortfarande exakt en tolkningsmotor.
   *  - vi letar aldrig fram ett alternativ för att slippa en vägran. Vägrar
   *    parsern översta gissningen är svaret nej, punkt. Och när vi väl börjar
   *    leta bland alternativen vinner en vägran över allt annat — hör
   *    mikrofonen något som kan vara en nykterhetskontroll ska den vägras,
   *    inte omtolkas till något som går att rapportera.
   */
  #pickTranscript(chunks, interim) {
    if (!chunks.length && !interim) return null;
    const top = chunks.map(c => c[0].transcript);
    if (interim) top.push(interim);

    const all = [];
    const push = t => { if (t && !all.includes(t)) all.push(t); };
    push(cleanTranscript(top.join(' ')));

    chunks.forEach((alts, i) => {
      for (let a = 1; a < alts.length; a++) {
        const variant = top.slice();
        variant[i] = alts[a].transcript;
        push(cleanTranscript(variant.join(' ')));
      }
    });
    if (!all.length) return null;

    const best = all[0];
    const first = parseReportText(best);
    if (first) return { text: best, parsed: first, all };

    // Ett eller två ord är systemkommandon ("tyst", "ljud på"). De ska aldrig
    // bli en rapport för att ett lågt alternativ råkade låta som "polis".
    if (best.split(' ').filter(Boolean).length <= 2) return { text: best, parsed: null, all };

    let chosen = null;
    for (const t of all.slice(1)) {
      const p = parseReportText(t);
      if (!p) continue;
      if (p.intent === 'refused') return { text: t, parsed: p, all };
      if (p.confidence < 0.6) continue;
      if (!chosen || p.confidence > chosen.parsed.confidence) chosen = { text: t, parsed: p, all };
    }
    return chosen || { text: best, parsed: null, all };
  }

  /* ---- Småsaker ----------------------------------------------------- */

  #resetCounters() {
    this.fastRestarts = 0;
    this.networkRetries = 0;
    this.captureRetries = 0;
  }

  #clearTimers() {
    clearTimeout(this.silenceTimer); this.silenceTimer = null;
    clearTimeout(this.capTimer); this.capTimer = null;
    clearTimeout(this.restartTimer); this.restartTimer = null;
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.#emit('state', {
      state,
      mode: this.mode,
      text: this.transcript,
      interim: this.interimText,
      ...extra,
    });
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  /**
   * Samma sak, men efter att den pågående klickhanteringen är klar.
   *
   * app.js öppnar röstöverlägget EFTER att den anropat oss. Skickade vi
   * 'command' synkront skulle överlägget stängas först och öppnas sedan, och
   * bli hängande kvar över kartan.
   */
  #emitAsync(name, detail) { setTimeout(() => this.#emit(name, detail), 0); }
}
