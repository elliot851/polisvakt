// Gör en rapportrad till en mening en människa förstår.
//
// Kartan visar i dag en nål med en ikon, en etikett och en relativ tid.
// "🚓 Polis · Hälla · 2 min sedan" är fyra fakta bredvid varandra, inte ett
// påstående — föraren får själv gissa vad de betyder tillsammans. Ett inlägg
// som "laserhälla" ska i stället bli:
//
//   Fartkontroll med laser vid Hälla — någon i Facebook-gruppen varnade
//   för 2 minuter sedan.
//
// Fyra saker måste alltid finnas med, för de är det som avgör om föraren kan
// agera på uppgiften:
//
//   VAD      Typen i klartext. Polis, kontroll, civil polisbil och fast
//            fartkamera är fyra olika saker att göra något åt.
//   VAR      Platsen när vi har den, "plats okänd" när vi inte har den. Att
//            tiga om att platsen saknas är att låtsas att vi vet.
//   NÄR      I ord, med osäkerheten inbakad. Fem minuter och fyrtio minuter
//            är inte samma uppgift, och meningen ska låta olika.
//   VARIFRÅN Facebook-gruppen, en annan förare eller du själv. Det är hela
//            skillnaden mot en officiell uppgift, och den skillnaden är
//            appens enda ärliga försvar den dagen en rapport är fel.
//
// Tre längder, samma innehåll:
//
//   sammanfattaKort   notiser, varningsbannern — en mening
//   sammanfattaLang   när man tryckt på nålen — meningen plus stöd och tvivel
//   sammanfattaTal    uppläsning
//
// Om den tredje: voice.js bygger inga fraser om rapporter. Speaker tar emot
// en färdig sträng och läser upp den; fraserna byggs i alerts.js och
// kvalitet.js. Den uppläsningsvänliga formen hör alltså hemma här, inte där.
// Den skiljer sig från den korta på tre punkter som hörs men inte syns:
// tankstrecket blir en punkt (en talsyntes läser "—" som en paus mitt i en
// sats, eller som ingenting alls), siffror blir ord ("för fyrtio minuter
// sedan"), och det citerade originalinlägget utelämnas — vi vet inte vad det
// innehåller för tecken, och en uppläsning som plötsligt stavar sig genom en
// URL är värre än tystnad.
//
// HÅRD PRODUKTREGEL: nykterhets- och drogkontroller finns inte i appen. De
// stoppas i parser.js, men den här modulen är en ny väg från rådata till
// något föraren ser, och en spärr som bara sitter på ett ställe är en spärr
// som förr eller senare kringgås. Därför kontrolleras texten igen här, med
// samma funktion. En rapport som innehåller något sådant beskrivs inte alls.

import { normalize } from './util.js';
import { isSobrietyCheck } from './parser.js';
import { TTL_MINUTES } from './store.js';

/* ---- Ordlistor och små hjälpare -------------------------------------- */

const TYP_TEXT = {
  police:   'Polis',
  control:  'Trafikkontroll',
  unmarked: 'Civil polisbil',
  camera:   'Fartkamera',
};

/** Vad en fast kamera kallas. Aldrig samma ord som en rapport om något nu. */
const FAST_KAMERA = 'Fast fartkamera';

/**
 * Textfält som kan bära det ursprungliga inlägget.
 *
 * Listan är medvetet bred. Nykterhetsspärren nedan läser samma fält, och
 * missar den ett fält kan en drogkontroll beskrivas via just det fältet.
 */
const TEXTFALT = ['label', 'note', 'raw', 'text', 'titel', 'beskrivning', 'original'];

/** Fälten som kommer från själva inlägget, alltså inte den geokodade etiketten. */
const INLAGGSFALT = ['note', 'raw', 'text', 'original'];

/** Ord som betyder att etiketten i praktiken är tom. */
const TOM_ETIKETT = new Set(['', '-', '–', '—', 'okänd', 'okand', 'okänt', 'okant',
                             'null', 'undefined', 'plats okänd']);

/** Etiketter som bara upprepar typen. "Polis vid Polis" är ingen plats. */
const INTE_EN_PLATS = new Set([
  'polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
  'kontroll', 'trafikkontroll', 'fartkontroll', 'hastighetskontroll', 'poliskontroll',
  'civil', 'civilbil', 'civilpolis', 'kamera', 'fartkamera', 'varning',
]);

/**
 * Ord som redan är en preposition. Står de först i etiketten får den stå som
 * den är.
 *
 * Utan den här listan blir "på E18" till "vid på E18" och "vid Hälla" till
 * "vid vid Hälla". Det är exakt den sortens skarv som får en app att se
 * maskinskriven ut, och en app som ser maskinskriven ut blir inte trodd.
 */
const PREPOSITIONER = new Set([
  'vid', 'på', 'pa', 'i', 'utanför', 'utanfor', 'mot', 'längs', 'langs',
  'nära', 'nara', 'runt', 'kring', 'mellan', 'efter', 'före', 'fore',
  'under', 'över', 'over', 'norr', 'söder', 'soder', 'öster', 'oster',
  'väster', 'vaster', 'strax',
]);

const ENTAL = ['noll', 'en', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio',
               'tio', 'elva', 'tolv', 'tretton', 'fjorton', 'femton', 'sexton',
               'sjutton', 'arton', 'nitton'];
const TIOTAL = ['', '', 'tjugo', 'trettio', 'fyrtio', 'femtio', 'sextio', 'sjuttio',
                'åttio', 'nittio'];

/** Räkneord i ord. Över 99 blir det siffror igen — där hjälper orden ingen. */
export function talOrd(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 0 || v > 99) return String(n);
  if (v < 20) return ENTAL[v];
  const t = Math.floor(v / 10), e = v % 10;
  return TIOTAL[t] + (e ? ENTAL[e] : '');
}

const stor = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Slår ihop meningar och städar bort dubbla mellanslag. */
const foga = (...delar) => delar.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

/**
 * En tidsstämpel får ligga så här långt fram i tiden innan vi slutar tro på
 * den.
 *
 * Telefonklockor går isär, och en rapport från en annan förare kan mycket
 * väl vara stämplad tio sekunder in i framtiden utan att något är fel. Men
 * en stämpel en kvart fram är inte en klockskillnad, det är felaktig data —
 * och "om 15 minuter" är inte en mening en varningsapp får skriva.
 */
const FRAMTID_TOLERANS_MS = 2 * 60000;

/* ---- Spärren --------------------------------------------------------- */

/** All text som hör till rapporten, hopslagen. */
function allText(rapport) {
  const bitar = [];
  for (const f of TEXTFALT) {
    const v = rapport?.[f];
    if (typeof v === 'string' && v.trim()) bitar.push(v);
  }
  return bitar.join(' ');
}

/**
 * Får rapporten beskrivas alls?
 *
 * Nej om någon av dess texter handlar om nykterhet eller droger. Det spelar
 * ingen roll att parsern redan borde ha stoppat den: rapporter kommer också
 * in via servern, via bryggan och via gamla rader som ligger kvar i
 * webbläsarens lagring sedan innan spärren lagades. En beskrivning är det
 * sista steget innan en människa läser något, och det är där en läcka gör
 * skada.
 */
export function farBeskrivas(rapport) {
  if (!rapport || typeof rapport !== 'object') return false;
  const text = allText(rapport);
  if (text && isSobrietyCheck(text)) return false;
  return true;
}

/* ---- Delarna --------------------------------------------------------- */

/** Är det här en punkt som står still för alltid, eller något som händer nu? */
function arFast(rapport) {
  if (rapport.fixed === true) return true;
  return rapport.type === 'camera' && !Number.isFinite(rapport.createdAt);
}

/**
 * Typen i klartext.
 *
 * "Trafikkontroll" är rätt när vi inte vet mer. Säger inlägget självt att det
 * är laser eller radar blir det "Fartkontroll med laser" — det är inte en
 * gissning, det står i texten. Etiketten läses INTE, eftersom den är
 * geokodad och ett ortsnamn som "Laserdomen" inte säger något om utrustning.
 */
function typText(rapport) {
  if (arFast(rapport)) return FAST_KAMERA;
  const bas = TYP_TEXT[rapport.type] || 'Varning';
  if (rapport.type !== 'control') return bas;

  const ord = normalize(INLAGGSFALT.map(f => rapport[f]).filter(v => typeof v === 'string').join(' '))
    .split(/[\s\-–—_/.]+/).filter(Boolean);
  if (ord.some(w => w.startsWith('laser'))) return 'Fartkontroll med laser';
  if (ord.some(w => w.startsWith('radar'))) return 'Fartkontroll med radar';
  if (ord.some(w => w.startsWith('fartkontroll') || w.startsWith('hastighetskontroll') ||
                    w.startsWith('fartkoll') || w.startsWith('fartkamera')))
    return 'Fartkontroll';
  return bas;
}

/**
 * Platsfrasen, med ledande mellanslag när det finns en plats.
 *
 * Tre utfall, och det tredje är det som brukar glömmas: ingen plats alls.
 * Då säger vi det rakt ut. En mening som bara utelämnar platsen låter som
 * om den hade en.
 */
function platsFras(rapport) {
  // Bara text duger som plats. En rad som råkar bära ett objekt i label —
  // det händer när en geokodningsträff sparats ohämtad — blev annars
  // "vid [object Object]", alltså en plats som ser ut att finnas.
  const ra = rapport.label;
  let label = typeof ra === 'string' ? ra
    : (typeof ra === 'number' && Number.isFinite(ra) ? String(ra) : '');
  label = label.replace(/\s+/g, ' ').trim();
  if (TOM_ETIKETT.has(normalize(label))) label = '';
  if (label && INTE_EN_PLATS.has(normalize(label))) label = '';
  if (!label) return { text: ', plats okänd', harPlats: false, label: '' };

  const forsta = normalize(label).split(' ')[0];
  const fras = PREPOSITIONER.has(forsta) ? ` ${label}` : ` vid ${label}`;
  return { text: fras, harPlats: true, label };
}

/**
 * Åldern i ord.
 *
 * `andel` är åldern delat med hur länge en rapport av den typen anses
 * aktuell (samma tal som store.js städar efter). Det är den som gör att en
 * civil polisbil låter gammal tidigare än en trafikkontroll — den förra
 * flyttar sig, den senare står kvar och bygger kö.
 */
function alderDelar(rapport, nu) {
  const t = rapport.createdAt;
  const ttl = TTL_MINUTES[rapport.type] ?? 45;

  if (!Number.isFinite(t) || t <= 0) {
    return { okand: true, text: 'vid okänd tidpunkt', tal: 'vid okänd tidpunkt',
             minuter: null, andel: null };
  }
  const ms = nu - t;
  if (ms < -FRAMTID_TOLERANS_MS) {
    // Stämpeln ligger så långt fram att den inte kan stämma. Att räkna på
    // den ändå ger "om 20 minuter", alltså en varning för framtiden.
    return { okand: true, framtid: true, text: 'vid en tidpunkt som inte går att lita på',
             tal: 'vid en tidpunkt som inte går att lita på', minuter: null, andel: null };
  }

  const m = Math.max(0, Math.floor(ms / 60000));
  const andel = ttl > 0 ? m / ttl : 0;

  let text, tal;
  if (m === 0) {
    text = tal = 'just nu';
  } else if (m === 1) {
    text = tal = 'för en minut sedan';
  } else if (m < 60) {
    text = `för ${m} minuter sedan`;
    tal = `för ${talOrd(m)} minuter sedan`;
  } else if (m < 90) {
    text = tal = 'för ungefär en timme sedan';
  } else if (m < 24 * 60) {
    const h = Math.round(m / 60);
    text = `för ${h} timmar sedan`;
    tal = `för ${talOrd(h)} timmar sedan`;
  } else if (m < 48 * 60) {
    text = tal = 'för mer än ett dygn sedan';
  } else {
    const d = Math.round(m / 1440);
    text = `för ${d} dagar sedan`;
    tal = `för ${talOrd(d)} dagar sedan`;
  }
  return { okand: false, text, tal, minuter: m, andel };
}

/**
 * Hur mycket åldern ska tvinga fram ett förbehåll.
 *
 * Kort form får bara det som ryms; lång form får hela meningen. Den färska
 * rapporten får också en mening, för "den är färsk" är information — utan
 * den kan föraren inte skilja tystnad från trygghet.
 */
function aktualitet(alder) {
  if (alder.okand) {
    // Kort form får inget tillägg: källfrasen har redan sagt "vid okänd
    // tidpunkt", och "Oklart hur gammal." efter den är samma sak en gång
    // till. Två förbehåll om samma sak läser man som ett tomt tonfall.
    return { kort: '', lang: 'Vi vet inte när den rapporterades.' };
  }
  const a = alder.andel;
  if (a < 0.2) return { kort: '', lang: 'Rapporten är färsk.' };
  if (a < 0.5) return { kort: '', lang: 'Den kan ha hunnit flytta på sig.' };
  if (a < 1)   return { kort: ' Kan ha flyttat på sig.',
                        lang: 'Så gammal att den troligen inte står kvar.' };
  return { kort: ' Troligen inte kvar.', lang: 'Så gammal att den knappast stämmer längre.' };
}

/**
 * Varifrån uppgiften kommer, ihopskrivet med när.
 *
 * De hör ihop grammatiskt och ska därför byggas tillsammans — "någon i
 * Facebook-gruppen varnade" utan tidpunkt är en halv mening, och en tidpunkt
 * utan avsändare är en uppgift som ser officiell ut.
 */
function kallaFras(rapport, alder, egen) {
  const kalla = String(rapport.source || '').toLowerCase();
  const nar = alder.text, narTal = alder.tal;

  if (egen) return { text: `du rapporterade den ${nar}`, tal: `du rapporterade den ${narTal}` };
  if (kalla === 'facebook')
    return { text: `någon i Facebook-gruppen varnade ${nar}`,
             tal:  `någon i Facebook-gruppen varnade ${narTal}` };
  if (kalla === 'telegram')
    return { text: `någon i Telegram-gruppen varnade ${nar}`,
             tal:  `någon i Telegram-gruppen varnade ${narTal}` };
  if (kalla === 'app' || kalla === 'voice' || kalla === 'karta')
    return { text: `en annan förare rapporterade ${nar}`,
             tal:  `en annan förare rapporterade ${narTal}` };

  // Okänd källa sägs vara okänd. Att i det läget skriva "en annan förare"
  // är en uppgift vi hittat på om varifrån uppgiften kommer, alltså precis
  // det som meningen finns till för att inte göra.
  return { text: `rapporterad ${nar}, men källan är okänd`,
           tal:  `rapporterad ${narTal}. Källan är okänd` };
}

/**
 * Bekräftelser och dementier.
 *
 * store.js sätter confirms till 1 när rapporten skapas — det är
 * rapportören själv. Stödet från ANDRA är alltså confirms minus ett, och den
 * ettan är skillnaden mellan "en förare har bekräftat" och "ingen har det".
 */
function stodFras(rapport) {
  const extra = Math.max(0, (Number(rapport.confirms) || 0) - 1);
  const emot = Math.max(0, Number(rapport.denials) || 0);
  const ut = [];

  if (extra === 1) ut.push('En annan förare har bekräftat den.');
  else if (extra > 1) ut.push(`${stor(talOrd(extra))} förare har bekräftat den.`);
  else ut.push('Ingen annan har bekräftat den än.');

  if (emot === 1) ut.push('En förare säger att den är borta.');
  else if (emot > 1) ut.push(`${stor(talOrd(emot))} säger att den är borta.`);

  return { text: ut.join(' '), bekraftelser: extra, dementier: emot };
}

/** Originalinlägget, kapat. Bara när det säger något etiketten inte gör. */
function originalFras(rapport) {
  for (const f of INLAGGSFALT) {
    const v = rapport[f];
    if (typeof v !== 'string') continue;
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (normalize(t) === normalize(rapport.label || '')) continue;
    const kapat = t.length > 100 ? t.slice(0, 99).trimEnd() + '…' : t;
    return `I inlägget stod: "${kapat}".`;
  }
  return '';
}

/* ---- Den fasta kameran ----------------------------------------------- */

/**
 * En fast fartkamera är inte en varning om något som händer nu.
 *
 * Den står där i morgon också. Får den samma mening som en polisrapport
 * lär sig föraren att appens meningar inte betyder något särskilt — och då
 * slutar även de som gör det att fungera.
 */
function kameraDelar(rapport) {
  const plats = platsFras(rapport);
  const grans = Number(rapport.speedLimit);
  const skyltat = Number.isFinite(grans) && grans > 0 ? grans : null;

  const rubrik = `${FAST_KAMERA}${plats.text}`;
  const kort = foga(`${rubrik}.`, 'Den står alltid här.',
                    skyltat ? `Skyltat ${skyltat}.` : '');
  const lang = foga(`${rubrik}.`,
    'Den står permanent på platsen och kommer ur kameraregistret,',
    'inte ur en rapport från någon förare.',
    skyltat ? `Skyltad hastighet ${skyltat}.` : '');
  const tal = foga(`${rubrik}.`, 'Den står alltid här, det är ingen ny varning.',
                   skyltat ? `Skyltad hastighet ${talOrd(skyltat)}.` : '');

  return {
    kort, lang, tal,
    delar: {
      typ: FAST_KAMERA,
      plats: plats.text,
      harPlats: plats.harPlats,
      kalla: 'kameraregistret',
      kallaOchAlder: 'står permanent på platsen',
      alder: null,
      aktualitetKort: '',
      aktualitetLang: '',
      stod: '',
      bekraftelser: 0,
      dementier: 0,
      fast: true,
    },
  };
}

/* ---- Publikt API ------------------------------------------------------ */

/**
 * Allt om en rapport, i tre längder plus delarna var för sig.
 *
 * Delarna finns med för att listan och varningsbannern redan visar typ och
 * plats i sin rubrik. De behöver alltså resten av meningen, inte hela — och
 * ett gränssnitt som säger "Polis · Hälla" och sedan "Polis vid Hälla" ser
 * ut som ett fel även när det inte är det.
 *
 * @param {{type?:string, label?:string, createdAt?:number, source?:string,
 *          note?:string, confirms?:number, denials?:number, fixed?:boolean,
 *          speedLimit?:number}} rapport
 * @param {{nu?:number, egen?:boolean}} [opts]
 * @returns {{kort:string, lang:string, tal:string, delar:Object}}
 */
export function beskrivning(rapport, opts = {}) {
  const tom = { kort: '', lang: '', tal: '', delar: null };
  if (!rapport || typeof rapport !== 'object') return tom;
  if (!farBeskrivas(rapport)) return tom;

  if (arFast(rapport)) return kameraDelar(rapport);

  const nu = Number.isFinite(opts.nu) ? opts.nu : Date.now();
  const egen = opts.egen === true || rapport.egen === true;

  const typ = typText(rapport);
  const plats = platsFras(rapport);
  const alder = alderDelar(rapport, nu);
  const kalla = kallaFras(rapport, alder, egen);
  const akt = aktualitet(alder);
  const stod = stodFras(rapport);
  const original = originalFras(rapport);

  const rubrik = `${typ}${plats.text}`;
  const kort = `${rubrik} — ${kalla.text}.${akt.kort}`;
  const lang = foga(`${rubrik} — ${kalla.text}.`, akt.lang, stod.text, original);
  /*
   * RÖSTEN LÄSER UPP DET SOM FAKTISKT SKREVS.
   *
   * Ägarens beslut 23 aug 2026, ordagrant: "Du ska alltid läsa upp
   * meddelandet som personen har skrivit på Facebook. Du behöver inte
   * validera det. Säg bara upp meddelandet precis det som personen har
   * skrivit."
   *
   * Skälet är gott, och det märks först i bilen. Vår egen mening säger
   * "Trafikkontroll vid Rocklunda". Föraren skrev "Laser rondellen Rocklunda
   * 50 sträckan, börjar nu" — och där ligger riktningen, hastighetsgränsen
   * och att det pågår just nu. Sammanfattningen kastar allt det.
   *
   * VAD SOM INTE ÄNDRAS, och varför:
   *
   *   Nykterhetsspärren. farBeskrivas() körs allra först i den här
   *   funktionen och ger tom sträng för drog- och nykterhetstexter. Ingen
   *   råtext kan ta sig förbi den, och det är inte en del av det som
   *   överprövats här.
   *
   *   Låsskärmen. Notisen bär fortfarande den sammanfattade meningen. Där
   *   är risken en annan: en notis går fram till en telefon som ligger i
   *   fickan hos någon som inte bett om just den texten, och råtext dit
   *   gör låsskärmen till en kanal rakt in i telefonen för vem som helst i
   *   gruppen. Se supabase/fbmejl.sql. Appen är öppen och tittad på; det
   *   är en annan sak.
   *
   * Kapningen på 100 tecken i originalFras() gäller fortfarande. En röst som
   * läser en femhundra tecken lång utläggning i 90 km/h är farligare än
   * tystnad — föraren väntar på slutet i stället för att titta på vägen.
   */
  const tal = original
    ? foga(`${rubrik}.`, original, `${stor(kalla.tal)}.`, akt.lang)
    : foga(`${rubrik}.`, `${stor(kalla.tal)}.`, akt.lang, stod.text);

  return {
    kort, lang, tal,
    delar: {
      typ,
      plats: plats.text,
      harPlats: plats.harPlats,
      kalla: kalla.text,
      kallaOchAlder: kalla.text,
      alder,
      aktualitetKort: akt.kort,
      aktualitetLang: akt.lang,
      stod: stod.text,
      bekraftelser: stod.bekraftelser,
      dementier: stod.dementier,
      original,
      fast: false,
    },
  };
}

/** En mening. Notiser, varningsbannern, kartnålen. */
export function sammanfattaKort(rapport, opts = {}) {
  return beskrivning(rapport, opts).kort;
}

/** Meningen plus stöd, tvivel och originalinlägget. När man tryckt på nålen. */
export function sammanfattaLang(rapport, opts = {}) {
  return beskrivning(rapport, opts).lang;
}

/** Samma innehåll, formulerat för att läsas upp. Se modulkommentaren. */
export function sammanfattaTal(rapport, opts = {}) {
  return beskrivning(rapport, opts).tal;
}
