// Uppstartsguiden — det som MÅSTE vara påslaget innan appen gör någon nytta.
//
// Varför filen finns
// ------------------
// Notisfrågan ställdes bara på ett enda ställe i hela appen: steg 3 i
// introduktionsguiden. Den guiden körs en gång, går att hoppa över med en
// knapp, och kommer aldrig tillbaka av sig själv. En förare som tryckte
// "Hoppa över" på steg 1 fick aldrig frågan igen, och ingenting i appen sa
// ifrån. Det syntes i verkligheten: en enda push-prenumeration på servern,
// två dagar gammal, och ingen ny trots att appen startades om.
//
// Den här filen ställer de kritiska frågorna utanför introduktionsguiden, vid
// varje start, tills de är besvarade. Ett steg i taget, med en mening om
// varför, och en knapp som utlöser den riktiga systemrutan i samma
// fingertryck.
//
// VAD EN WEBBSIDA FAKTISKT KAN — och vad texterna därför aldrig lovar
// -------------------------------------------------------------------
// En webbsida kan inte bevilja sig själv notiser eller plats, och kan inte
// öppna telefonens inställningar åt någon. Allt vi kan göra är fyra saker:
// fråga i en levande gest, läsa av läget, visa den exakta menyvägen för just
// den här telefonen när webbläsaren slutat fråga, och fortsätta påminna. Står
// det något annat i en text här är texten fel, inte koden.
//
// iPhone i en vanlig Safari-flik är ett eget fall. Där finns notis-API:et inte
// alls förrän appen ligger på hemskärmen och startas därifrån — att visa en
// notisknapp som ändå misslyckas är att ljuga. Den föraren får steg 0 istället:
// Dela → Lägg till på hemskärmen, och ingen notisfråga.
//
// ARBETSFÖRDELNING MED js/platsstart.js
// -------------------------------------
// platsstart.js äger platsfrågan vid allra första starten och den röda remsan
// som ligger kvar när plats saknas. Den filen rörs inte. Två regler håller oss
// isär, och båda finns utskrivna där de används längre ner:
//
//   1. Vår ruta har klassen .modal, som platsstart.js redan väntar på i sin
//      annanRutaUppe(). Vi väntar i vår tur på .pv-ps-skarm. Kollen görs på
//      båda håll, men den räcker bara om den görs OM efter varje await —
//      annars hinner den andra filen rita medan vi läser av läget. Vår kolls
//      sitter därför i oppna(), som alla vägar till en ruta går igenom.
//      Platsfrågan ställer vi dessutom inte alls när platsstart.js redan
//      ställt den i den här sessionen; se platsNyssFragad().
//   2. Stänger föraren vår ruta utan att ha svarat på platsfrågan skjuter vi
//      upp den i geo.js. Då kastar platsstart.js inte upp sin egen ruta i
//      samma sekund, utan ritar sin röda remsa — vilket är precis den
//      kvarliggande raden vi vill lämna efter oss.
//
// Vår egen rad längst upp handlar därför om notiser och hemskärm. Plats tas
// bara med när platsstart.js remsa inte redan står där och säger samma sak.
//
// Filen vet ingenting om tillstånd själv. Allt kommer från js/behorigheter.js
// och js/push.js, som båda bara läses härifrån. css/app.css rörs inte heller:
// rutan återanvänder .modal/.modal-card/.btn-primary, och det lilla som är
// nytt ligger i en <style> som filen själv lägger in.

import {
  status,
  snabbStatus,
  begarPlats,
  begarNotiser,
  instruktioner,
  plattform,
  markeraPlatsFragad,
  platsFragad,
  BAKGRUND,
  events as behorighetsEvents,
} from './behorigheter.js';
import * as push from './push.js';
import { skjutUppPlats, slappFramPlats, grindLage } from './geo.js';
import { deviceId } from './store.js';
import { CONFIG } from './config.js';

/* ------------------------------------------------------------------ */
/* Texter                                                              */
/* ------------------------------------------------------------------ */

// Samma mening som VARFOR i js/platsstart.js. Den är inte exporterad därifrån,
// så den står på två ställen — ändras den ena ska den andra ändras med.
const VARFOR_PLATS =
  'Polisvakt behöver din plats för att kunna varna för polis och fartkameror på vägen framför dig.';

const VARFOR_NOTISER =
  'Notiser är det enda som når dig när appen är stängd: en påminnelse innan du brukar köra, ' +
  'och ett pling när polis rapporterats i närheten.';

const VARFOR_HEMSKARM =
  'På iPhone kan appen inte skicka en enda notis från en vanlig Safari-flik. Lägg ikonen på ' +
  'hemskärmen och starta appen därifrån, så går notiser att slå på.';

/** Vad varje läge heter för en förare. "Nekat" får aldrig låta som "klart". */
const LAGETEXT = {
  klart: 'Påslaget',
  halv: 'Nästan klart',
  vantar: 'Väntar på dig',
  nekat: 'Nekat',
  garinte: 'Går inte här',
};

const LAGEFARG = {
  klart: 'var(--ok, #2fd07a)',
  halv: 'var(--warn, #ffb020)',
  vantar: 'var(--warn, #ffb020)',
  nekat: 'var(--danger, #ff4d4f)',
  garinte: 'var(--fg-dim, #93a4b6)',
};

// Hur ofta vi kollar om skärmen blivit ledig, och hur länge vi orkar vänta.
// Efter det får raden längst upp ta över — en ruta som slår upp fem minuter
// efter start känns som ett fel, inte som en hjälp.
const PULS_MS = 700;
const MAX_VANTAN_MS = 180000;

/* ------------------------------------------------------------------ */
/* Stil                                                                */
/* ------------------------------------------------------------------ */
//
// Färgerna är app.css egna variabler med hårda reservvärden efter sig, av
// samma skäl som i platsstart.js: filen ska fungera även om den råkar köra
// innan stilmallen är på plats.

const CSS = `
#uppstart .modal-card { position: relative; max-height: calc(100vh - 40px); overflow-y: auto; }
.pv-up-stang {
  position: absolute; top: 8px; right: 10px;
  width: 36px; height: 36px; border: 0; border-radius: 50%;
  background: transparent; color: var(--fg-dim, #93a4b6);
  font-size: 24px; line-height: 1; cursor: pointer; font-family: inherit;
}
.pv-up-spar { list-style: none; margin: 0 0 16px; padding: 0; display: grid; gap: 7px; }
.pv-up-spar li {
  display: flex; align-items: center; gap: 9px;
  font-size: 12.5px; color: var(--fg-dim, #93a4b6);
}
.pv-up-spar li.nu { color: var(--fg, #eef4fa); font-weight: 650; }
.pv-up-prick { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.pv-up-spar .pv-up-sluttext { margin-left: auto; font-size: 12px; }

.pv-up-ikon { font-size: 30px; line-height: 1; margin-bottom: 8px; }
#uppstart h2 { margin: 0 0 8px; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }

.pv-up-lage {
  display: flex; align-items: center; gap: 9px;
  background: var(--bg-3, #1d2733); border: 1px solid var(--line, #26323f);
  border-radius: 12px; padding: 10px 12px; margin: 0 0 14px;
  font-size: 13.5px; font-weight: 600; color: var(--fg, #eef4fa);
}
.pv-up-fin { font-size: 12.5px; line-height: 1.5; color: #7f8fa1; margin: -6px 0 14px; }
.pv-up-fel { font-size: 13px; line-height: 1.5; color: var(--warn, #ffb020); margin: 0 0 14px; }

.pv-up-vagrubrik {
  font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
  color: var(--accent, #3d9dff); font-weight: 700; margin: 0 0 8px;
  border-top: 1px solid var(--line, #26323f); padding-top: 12px;
}
.pv-up-steg { margin: 0 0 14px; padding: 0; list-style: none; counter-reset: pvup; }
.pv-up-steg li {
  counter-increment: pvup;
  display: flex; gap: 11px; padding: 9px 0;
  border-top: 1px solid var(--line, #26323f);
  font-size: 13.5px; line-height: 1.45; color: var(--fg, #eef4fa);
}
.pv-up-steg li:first-child { border-top: none; }
.pv-up-steg li::before {
  content: counter(pvup); flex: none;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--bg-3, #1d2733); color: var(--fg-dim, #93a4b6);
  font-size: 12px; font-weight: 700; text-align: center; line-height: 22px;
}
.pv-up-not {
  background: rgba(255,176,32,.1); border: 1px solid rgba(255,176,32,.3);
  border-radius: 12px; padding: 11px 13px; margin: 0 0 14px;
  font-size: 13px; line-height: 1.5; color: var(--warn, #ffb020);
}

/* [hidden] slås annars ut av display-reglerna ovanför. */
.pv-up-steg[hidden], .pv-up-not[hidden], .pv-up-fel[hidden],
.pv-up-fin[hidden], .pv-up-vagrubrik[hidden] { display: none; }

/* Raden som ligger kvar tills det är löst.

   z-index 889: över tabbaren (800) och versionsbannern (880), men UNDER
   platsstart.js röda remsa (890), varningsbannern och mörkt körläge (900),
   fordonslarmet (1500) och modalerna (1000). Att appen inte är färdiginställd
   är viktigt, men det är aldrig viktigare än något som varnar för verkligheten
   just nu. Ligger platsremsan uppe placeras den här raden under den — se
   placeraRad(). */
.pv-up-rad {
  position: fixed; z-index: 889; left: 0; right: 0; top: 0;
  padding: 9px 12px;
  background: rgba(46,33,6,.94);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(255,176,32,.5);
  display: flex; align-items: center; gap: 10px;
  color: #ffeccd;
  font: 13.5px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
.pv-up-rad b { display: block; color: #fff; font-weight: 650; }
.pv-up-rad .pv-up-radtext { flex: 1; min-width: 0; }
.pv-up-rad button {
  flex: none; border: 1px solid var(--warn, #ffb020); border-radius: 11px;
  padding: 9px 13px; font-size: 13.5px; font-weight: 650; font-family: inherit;
  background: var(--warn, #ffb020); color: #2a1d02; cursor: pointer;
}
`;

function injiceraCss() {
  if (document.getElementById('pv-up-stil')) return;
  const s = document.createElement('style');
  s.id = 'pv-up-stil';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* Småsaker                                                            */
/* ------------------------------------------------------------------ */

const $ = id => document.getElementById(id);

function el(tag, klass, text) {
  const n = document.createElement(tag);
  if (klass) n.className = klass;
  if (text != null) n.textContent = text;   // aldrig innerHTML
  return n;
}

/**
 * Ligger något annat uppe som äger skärmen?
 *
 * Ansvarsfriskrivningen ska läsas först, kontoskärmen och introduktionsguiden
 * tar hela skärmen, larmet får aldrig täckas — och .pv-ps-skarm är
 * platsstart.js egen ruta. Den sista raden är halva samarbetet med den filen:
 * hinner den fram först väntar vi, precis som den väntar på oss.
 *
 * .pv-varningsyta är js/varningsyta.js remsa högst upp. Den äger samma yta
 * som vår rad och ligger på z-index 905, alltså över oss. Att appen inte är
 * färdiginställd är aldrig viktigare än en varning om något på vägen just nu,
 * så vi viker undan helt i stället för att ligga kvar dold under den.
 */
function annanRutaUppe() {
  const val = '.modal, .auth-screen, .tour, .voice-overlay, .fordonslarm, ' +
              '.pv-ps-skarm, .pv-varningsyta, dialog[open]';
  const egen = $('uppstart');
  for (const n of document.querySelectorAll(val)) {
    if (n === egen) continue;
    if (n.hasAttribute('hidden')) continue;
    if (n.getClientRects().length) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Läget: vilka steg finns, och hur ligger de till                     */
/* ------------------------------------------------------------------ */

/**
 * Notissteget har fyra utfall och de betyder helt olika saker:
 *
 *   klart   — tillstånd finns OCH prenumerationen ligger på servern, eller så
 *             kan den här appversionen ändå inte skicka något (ingen
 *             VAPID-nyckel) och då är tillståndet allt vi kan begära.
 *   halv    — tillståndet finns men prenumerationen saknas. Det är exakt det
 *             läge som gjorde att servern hade en enda rad: någon tryckte
 *             "Tillåt notiser" i inställningarna, som bara frågar om lov och
 *             aldrig prenumererar. Det får inte se ut som klart.
 *   nekat   — webbläsaren frågar inte igen. Bara menyvägen hjälper.
 *   garinte — webbläsaren eller telefonen saknar stödet. Inget att göra, och
 *             därför inget vi tjatar om.
 */
function notisLage(n) {
  // 'saknas' betyder att webbläsaren eller telefonen inte har stödet alls.
  // Hemskärmsfallet hamnar också här, men det har ett eget steg och kommer
  // aldrig hit — byggSteg() lämnar notissteget helt när fix är 'hemskarm'.
  if (n.state === 'saknas') return 'garinte';
  if (n.state === 'denied') return 'nekat';
  if (!n.ok) return 'vantar';
  // push.capabilities() läses direkt: notisStatus() säger inte om det ens är
  // möjligt att prenumerera, bara om vi gjort det.
  const cap = push.capabilities();
  if (!cap.supported) {
    // fix 'server' betyder bara en sak: VAPID-nyckeln är inte satt. Det såg
    // förut ut som "klart" här, och det var fel på det värsta sättet — appen
    // skrev "Påslaget" om notiser som inte når fram, och slog av hela
    // påminnelsen för resten av sessionen. Nyckeln sätts numera av
    // konfigureraPush() innan pulsen startar, så kommer vi ändå hit saknas
    // den i js/config.js. Då finns ingen prenumeration att skapa och heller
    // ingenting föraren kan göra åt det: eget läge, ingen tjatknapp.
    return cap.fix === 'server' ? 'garinte' : 'klart';
  }
  return n.prenumererad ? 'klart' : 'halv';
}

/* ------------------------------------------------------------------ */
/* LJUDSTEGET — det enda vi inte kan mäta, och därför frågar om          */
/* ------------------------------------------------------------------ */
//
// VARFÖR STEGET FINNS
//
// Behörigheten kan vara beviljad, prenumerationen kan ligga på servern, och
// notisen kan komma fram — och ändå vara helt tyst. iOS sätter ofta en
// nyinstallerad webbapp till ljudlös, och det syns ingenstans från koden:
// Notification-API:t har inget sätt att fråga "får jag låta?".
//
// Mätt 23 aug 2026: en riktig push nådde båda ägarens enheter
// ({"skickade":2,"fel":0}) och han hörde ingenting. Guiden sa "Påslaget".
// Det är samma sorts fel som gått igen hela det här projektet — varje led
// grönt, slutresultatet noll — och den enda skillnaden är att det här ledet
// inte går att mäta från vår sida.
//
// Alltså frågar vi. Appen skickar en riktig notis till sig själv och låter
// föraren svara. Svaret sparas, och frågan kommer tillbaka vid varje start
// tills den är besvarad med ja.
//
// showNotification() på registreringen kräver INGEN server och ingen push:
// samma notis, samma väg genom telefonen, samma ljudinställning. Det är den
// enda provet som bevisar något.

// Svaret sparades förut här. Steget som frågade är borttaget (se byggSteg),
// och en nyckel som ingen skriver är en nyckel som ljuger vid nästa läsning.

/*
 * Menyvägen till ljudinställningen, per plattform.
 *
 * Den här listan är HANDSKRIVEN, till skillnad från de andra vägarna i guiden
 * som kommer ur behorigheter.instruktioner(). Skälet: instruktioner() handlar
 * om BEHÖRIGHETER, och ljudet är ingen behörighet — det finns inget API att
 * fråga, inget tillstånd att bevilja, ingenting att läsa av. Att smyga in det
 * bland behörighetsvägarna hade gjort den modulen till något annat än den är.
 *
 * Sista raden är samma på alla plattformar med flit: ringknappen på sidan är
 * det överlägset vanligaste svaret, och den glöms av alla.
 */
function LJUD_VAG() {
  const p = plattform();
  if (p.os === 'ios') {
    return [
      'Öppna Inställningar på telefonen.',
      'Gå till Notiser och leta upp Polisvakt i listan.',
      'Slå på Ljud.',
      'Kolla också att Fokus eller Stör ej inte är igång.',
      'Och ringknappen på sidan av telefonen — står den på tyst hörs ingenting.',
    ];
  }
  if (p.os === 'android') {
    return [
      'Öppna Inställningar på telefonen.',
      'Gå till Appar, leta upp Chrome och sedan Aviseringar.',
      'Hitta Polisvakt i listan och slå på ljud.',
      'Kolla också att Stör ej inte är igång.',
      'Och att telefonen inte står på ljudlöst.',
    ];
  }
  return [
    'Öppna webbläsarens inställningar för webbplatser.',
    'Leta upp polisvakt.pages.dev och tillåt notiser.',
    'Kolla att datorns eget ljud inte är avstängt.',
  ];
}

/** Skickar en riktig notis till telefonen, utan server. */
export async function provaNotisljud() {
  try {
    if (!('serviceWorker' in navigator)) return { ok: false, skal: 'ingen-sw' };
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Polisvakt: hör du det här?', {
      body: 'Så här låter en varning när appen är stängd. Svara i appen.',
      icon: './icon.svg',
      badge: './icon.svg',
      // EGEN tag. Provet får aldrig ersätta en riktig polisvarning i luren —
      // samma resonemang som driftnotisernas egna tag i tools/brygg-daemon.ps1.
      tag: 'polisvakt-ljudprov',
      silent: false,
      vibrate: [220, 90, 120, 90, 220],
      data: { url: './' },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, skal: String(e && e.message || e).slice(0, 120) };
  }
}

function platsLage(p) {
  if (p.ok) return 'klart';
  if (p.state === 'saknas') return 'garinte';
  if (p.state === 'denied') return 'nekat';
  return 'vantar';
}

/**
 * Har platsfrågan redan ställts i den här sessionen, och svarade föraren nej?
 *
 * platsstart.js äger första platsfrågan. Trycker föraren "Inte nu" där skjuter
 * den upp grinden i geo.js och ritar sin röda remsa. Utan den här kollen såg
 * vår puls bara att tillståndet fortfarande är "prompt" och kastade upp exakt
 * samma fråga en sekund senare. Ett nej som beror på tjat är permanent —
 * webbläsaren frågar aldrig igen — så det får inte hända.
 *
 * Samma nyckel som platsstart.js och geo.js redan använder; ingen ny sanning.
 */
function platsNyssFragad() {
  try { return platsFragad() && grindLage().lage === 'uppskjuten'; }
  catch { return false; }
}

/**
 * Stegen, i den ordning de ska tas. Listan byggs om vid varje ritning:
 * hemskärmssteget försvinner i samma sekund som appen startas från ikonen.
 *
 * @param {object} st läget
 * @param {boolean} tillRad listan är till raden längst upp, inte till rutan.
 *        Raden får nämna plats även efter ett "inte nu" — den frågar
 *        ingenting, den ligger bara kvar. Rutan får det inte.
 */
function byggSteg(st, { tillRad = false } = {}) {
  const steg = [];
  const hemskarm = st.notiser.fix === 'hemskarm';

  if (hemskarm) {
    // Steg 0. Läget kan aldrig bli "klart" här: appen måste startas om från
    // hemskärmsikonen för att det ska hända, och då är steget borta.
    steg.push({ nyckel: 'hemskarm', namn: 'Hemskärm', lage: 'vantar' });
  }

  // Frågan är redan ställd och besvarad med nej. Då degraderas plats till
  // raden längst upp (och till platsstart.js remsa), i stället för att bli en
  // ruta till om samma sak.
  if (tillRad || !platsNyssFragad()) {
    steg.push({ nyckel: 'plats', namn: 'Plats', lage: platsLage(st.plats) });
  }

  // Ingen notisknapp på en iPhone i Safari-flik. Frågan kan inte lyckas där,
  // och steg 0 säger redan vad som ska göras — två rutor om samma sak är en
  // vägg av text, vilket är precis det den här guiden ska slippa.
  if (!hemskarm) {
    steg.push({ nyckel: 'notiser', namn: 'Notiser', lage: notisLage(st.notiser) });
  }

  /*
   * INGET LJUDSTEG HÄR. Det provades 23 aug 2026 och låste guiden.
   *
   * Felet var inte i ljudsteget självt utan i att det VILLKORADES på ett annat
   * stegs läge: det lades bara till när notissteget var 'klart'. notisLage()
   * läses om vid varje ritning, och snabbStatus() och status() kan svara olika
   * på samma sekund — prenumerationen hinner inte alltid med. Steget dök alltså
   * upp och försvann mellan två ritningar, och rita() svarar på ett nyckelNu
   * som inte längre finns i listan genom att hoppa till första ostädade steget.
   * Det steget var notiser. Föraren tryckte "Klart", kom till ljudsteget, det
   * försvann, och han var tillbaka på notiser. Om och om igen.
   *
   * Lärdomen är generell och gäller varje framtida steg: ETT STEGS EXISTENS
   * FÅR ALDRIG BERO PÅ ETT ANNAT STEGS LÄGE. Listan måste vara densamma vid
   * varje ritning i samma session, annars kan navigeringen inte vara stabil.
   *
   * Ljudprovet bor nu i inställningarna i stället, under "Hur låter det?",
   * där det inte kan stå i vägen för någon. Se provaNotisljud() nedan.
   */
  return steg;
}

/** Finns det något kvar som föraren faktiskt kan göra något åt? */
function nagotSaknas(steg) {
  return steg.some(s => s.lage === 'vantar' || s.lage === 'nekat' || s.lage === 'halv');
}

/* ------------------------------------------------------------------ */
/* Rutan                                                               */
/* ------------------------------------------------------------------ */

let aktiv = false;              // ligger rutan uppe just nu?
let stangdISession = false;     // föraren har stängt den, vänta till nästa start
let nyckelNu = null;            // vilket steg som visas
let senast = null;              // senast lästa status, för stang()
let felText = null;             // senaste svaret från telefonen, { nyckel, text }
let ritToken = 0;
let platsStegVisat = false;     // har föraren faktiskt sett platssteget?

/* ------------------------------------------------------------------ */
/* Startgrinden: appen ska ha ritat sitt eget först                    */
/* ------------------------------------------------------------------ */
//
// annanRutaUppe() kan bara se det som redan ritats, och vid vårt första tick
// har app.js boot() inte hunnit rita någonting alls: den ligger och väntar på
// tre nätanrop (initGeocoder, loadCameras, billing.sync) innan
// ansvarsfriskrivningen ens visas. Resultatet var att guiden lade sig ÖVER
// friskrivningen — samma z-index, men #uppstart står senare i index.html — och
// att föraren fick behörighetsfrågan innan den juridiska text hen måste
// godkänna. Stängde hen guiden för att komma åt friskrivningen kom den aldrig
// tillbaka den sessionen.
//
// Därför tittar vi inte på skärmen förrän app.js sagt till. 'polisvakt:ready'
// skickas sist i boot(), alltså efter att friskrivningen ritats. Taket finns
// för att en trasig boot() aldrig får bli en app helt utan uppstartsguide.

const START_TAK_MS = 20000;
const modulStart = Date.now();
let appRedo = false;

/** Är ansvarsfriskrivningen kvar att godkänna? Läses direkt ur lagringen,
 *  eftersom modalen kan vara oritad ännu — det är just det som är problemet. */
function friskrivningKvar() {
  try {
    const s = JSON.parse(localStorage.getItem('pv.settings.v1'));
    return !!s && s.disclaimerAccepted === false;
  } catch { return false; }
}

/** Får vi visa något alls just nu? */
function farVisa() {
  if (!appRedo && Date.now() - modulStart < START_TAK_MS) return false;
  return !friskrivningKvar();
}

function stegElement() {
  return {
    rot: $('uppstart'),
    spar: $('uppstartSpar'),
    ikon: $('uppstartIkon'),
    titel: $('uppstartTitel'),
    text: $('uppstartText'),
    fin: $('uppstartFin'),
    lage: $('uppstartLage'),
    fel: $('uppstartFel'),
    vagrubrik: $('uppstartVagRubrik'),
    vag: $('uppstartVag'),
    not: $('uppstartNot'),
    ja: $('uppstartJa'),
    sen: $('uppstartSen'),
    stang: $('uppstartStang'),
  };
}

/**
 * Öppna guiden. Går även att anropa utifrån, till exempel från raden.
 *
 * Rutan ritas FÖRE den visas. Utan det blinkar ett tomt kort förbi medan
 * statusen läses, och den som ser det tror att appen hängt sig.
 *
 * @param {object|null} forhandsStatus redan läst status, om anroparen har en
 */
export function oppna(forhandsStatus = null) {
  const d = stegElement();
  if (!d.rot) return;

  // Kollas HÄR och inte bara i tick(). Både vår puls och platsstart.js puls
  // kollar skärmen före sina await och ritar efter dem — hann något annat upp
  // under tiden lade vi oss ovanpå det. status() kan dessutom vänta tio
  // sekunder på service workern, och på tio sekunder hinner friskrivningen,
  // kontoskärmen, rundturen och platsstart.js kort alla dyka upp. Att kolla i
  // oppna() täcker alla tre vägar hit med en enda rad.
  if (!farVisa() || annanRutaUppe()) { ritaRad(); return; }

  injiceraCss();
  aktiv = true;
  doljRad();

  const st = forhandsStatus || senast;
  // rita() kan komma fram till att ingenting saknas längre och stänga igen.
  // Därför visas rutan först efteråt, och bara om den fortfarande ska vara uppe.
  if (st) rita(st);
  if (!aktiv) return;

  d.rot.hidden = false;
  uppdatera();
}

/**
 * Stäng guiden.
 *
 * En ruta man inte kan stänga är en fälla, så knappen finns. Men två saker
 * händer i samma andetag: platsfrågan skjuts upp i geo.js så att
 * platsstart.js ritar sin remsa istället för att kasta upp en andra ruta, och
 * vår egen rad ritas för det som är kvar. Ingenting försvinner tyst.
 */
function stang() {
  const d = stegElement();
  aktiv = false;
  // Stängdes rutan innan appen ens var startklar var det inte ett nej till
  // frågan — det var någon som ville komma åt ansvarsfriskrivningen bakom oss.
  // Att räkna det som ett nej vore att tappa hela första starten, alltså exakt
  // den start mätningen visade att vi tappade.
  if (appRedo) stangdISession = true;
  ritToken++;                                   // kasta svar som är på väg in
  if (d.rot) d.rot.hidden = true;

  const p = senast?.plats;
  // Bara om föraren FAKTISKT sett platssteget. Förut skedde det här vid varje
  // stängning: ett tryck på × i hemskärmssteget på en iPhone skrev platsFragad
  // och sköt upp grinden, och då startade GPS:en aldrig under resten av
  // sessionen — och vid nästa start öppnades grinden direkt, så webbläsarens
  // egen oförklarade platsruta poppade upp utan gest. Har vi inte frågat får
  // grinden stå kvar på "vantar", så platsstart.js får ställa frågan förklarat.
  if (platsStegVisat && p && !p.ok && p.kanFraga) {
    markeraPlatsFragad();
    // Ingen nödutgång efter detta: grinden i geo.js öppnas av nästa tryck,
    // inte av en timer. Att låta watchPosition väcka systemrutan en halv minut
    // efter att föraren stängt oss vore att fråga bakvägen.
    skjutUppPlats('uppstart-stangd');
  }

  // Nollställ vilket steg som visades. Utan det låg nyckelNu kvar på det sista
  // steget föraren råkade se, och eftersom nasta() bara går framåt öppnade
  // radens knapp "Slå på" guiden på notissteget om och om igen — platsfrågan
  // gick inte att nå resten av sessionen.
  nyckelNu = null;
  felText = null;
  platsStegVisat = false;

  ritaRad();
}

function nasta() {
  if (!senast) { stang(); return; }
  const steg = byggSteg(senast);
  const i = steg.findIndex(s => s.nyckel === nyckelNu);
  const kvar = steg.slice(i + 1);
  if (!kvar.length) { stang(); return; }
  nyckelNu = kvar[0].nyckel;
  felText = null;
  uppdatera();
}

/**
 * Läs av läget och rita om.
 *
 * Två ritningar med flit, samma skäl som i tour.js: snabbStatus() svarar
 * direkt medan status() väntar in service workern och kan ta sekunder på en
 * telefon där den sover. Utan den första står rutan tom precis när föraren
 * läser rubriken. Token:en kastar svar som hinner komma efter ett stegbyte.
 */
async function uppdatera() {
  if (!aktiv) return;
  const token = ++ritToken;
  try {
    const snabb = await snabbStatus();
    if (token !== ritToken || !aktiv) return;
    rita(snabb);

    const full = await status();
    if (token !== ritToken || !aktiv) return;
    rita(full);
  } catch {
    // Går läget inte att läsa ska rutan inte bli en tom vit yta. Stäng hellre.
    if (token === ritToken) stang();
  }
}

function rita(st) {
  senast = st;
  const d = stegElement();
  if (!d.rot) return;

  const steg = byggSteg(st);
  if (!nagotSaknas(steg)) { stang(); return; }

  if (!nyckelNu || !steg.some(s => s.nyckel === nyckelNu)) {
    nyckelNu = (steg.find(s => s.lage !== 'klart' && s.lage !== 'garinte') || steg[0]).nyckel;
  }
  const nu = steg.find(s => s.nyckel === nyckelNu);
  // Läses av stang(): platsgrinden får bara skjutas upp av någon som sett
  // frågan.
  if (nu.nyckel === 'plats') platsStegVisat = true;

  ritaSpar(d.spar, steg);

  // Nollställ allt som är valfritt, så inget står kvar från förra steget —
  // inklusive en knapp som råkade lämnas avstängd av ett avbrutet försök.
  d.ja.disabled = false;
  d.fin.hidden = true;
  d.fel.hidden = true;
  d.vagrubrik.hidden = true;
  d.vag.hidden = true;
  d.vag.replaceChildren();
  d.not.hidden = true;

  d.lage.replaceChildren(
    el('span', 'pv-up-prick'),
    el('span', null, `${nu.namn}: ${LAGETEXT[nu.lage]}`),
  );
  d.lage.firstChild.style.background = LAGEFARG[nu.lage];
  d.lage.firstChild.style.boxShadow = `0 0 8px ${LAGEFARG[nu.lage]}`;

  if (felText?.nyckel === nu.nyckel && felText.text) {
    d.fel.textContent = felText.text;
    d.fel.hidden = false;
  }

  if (nu.nyckel === 'hemskarm') ritaHemskarm(d, st);
  else if (nu.nyckel === 'plats') ritaPlats(d, st, nu);
  else ritaNotiser(d, st, nu);

  // Sista steget? Då är "Inte nu" en stängning, och inget annat.
  const i = steg.findIndex(s => s.nyckel === nyckelNu);
  const finnsFler = i < steg.length - 1;
  d.sen.textContent = finnsFler ? 'Inte nu' : 'Stäng';
  d.sen.onclick = () => (finnsFler ? nasta() : stang());
  d.stang.onclick = () => stang();
}

function ritaSpar(spar, steg) {
  spar.replaceChildren();
  for (const s of steg) {
    const li = el('li', s.nyckel === nyckelNu ? 'nu' : null);
    const prick = el('span', 'pv-up-prick');
    prick.style.background = LAGEFARG[s.lage];
    li.append(prick, el('span', null, s.namn), el('span', 'pv-up-sluttext', LAGETEXT[s.lage]));
    li.querySelector('.pv-up-sluttext').style.color = LAGEFARG[s.lage];
    spar.appendChild(li);
  }
}

/** Fyller menyvägslistan från behorigheter.instruktioner(). Aldrig egen text. */
function ritaVag(d, vad) {
  const info = instruktioner(vad);
  d.vagrubrik.textContent = info.rubrik;
  d.vagrubrik.hidden = false;
  for (const s of info.steg) d.vag.appendChild(el('li', null, s));
  d.vag.hidden = false;
  if (info.not) { d.not.textContent = info.not; d.not.hidden = false; }
}

/* ---------------------------- Steg 0 ------------------------------- */

function ritaHemskarm(d, st) {
  d.ikon.textContent = '📲';
  d.titel.textContent = 'Lägg till Polisvakt på hemskärmen';
  d.text.textContent = VARFOR_HEMSKARM;
  // Exakta gesten, samma text som guiden och remsan använder.
  ritaVag(d, 'notiser');

  // Ingen knapp som låtsas göra jobbet. Appen kan inte lägga sig själv på
  // hemskärmen, och den kan inte se att det gjorts förrän den startas från
  // ikonen — då är hela steget borta av sig självt.
  d.ja.textContent = 'Jag har lagt till den';
  d.ja.onclick = () => nasta();
}

/* ---------------------------- Steg 1 ------------------------------- */

function ritaPlats(d, st, nu) {
  const p = st.plats;
  d.ikon.textContent = '📍';
  d.titel.textContent = 'Slå på plats';
  d.text.textContent = VARFOR_PLATS;

  if (nu.lage === 'klart') {
    d.ja.textContent = 'Nästa';
    d.ja.onclick = () => nasta();
    return;
  }

  if (nu.lage === 'garinte') {
    d.text.textContent = p.reason || VARFOR_PLATS;
    d.ja.textContent = 'Nästa';
    d.ja.onclick = () => nasta();
    return;
  }

  if (p.kanFraga) {
    d.ja.textContent = p.state === 'okand' ? 'Kontrollera plats' : 'Tillåt plats';
    d.ja.onclick = () => {
      d.ja.disabled = true;
      d.ja.textContent = 'Väntar på svar…';
      markeraPlatsFragad();
      // INGET await ovanför den här raden. Safari visar ingen platsruta om
      // gesten hunnit dö, och det felet är osynligt: man trycker, och
      // ingenting händer.
      begarPlats().then(svar => {
        d.ja.disabled = false;
        if (svar.ok) {
          // Grinden i geo.js står kvar på "vantar" tills någon öppnar den.
          // platsstart.js gör det också vid sitt nästa tick, men vi väntar
          // inte på det — appen ska ha en position i samma sekund.
          slappFramPlats('uppstart-ja');
        } else if (svar.state === 'denied') {
          slappFramPlats('uppstart-nekad');
        }
        felText = svar.ok || svar.state === 'denied' ? null : { nyckel: 'plats', text: svar.reason };
        uppdatera();
      }).catch(() => misslyckades(d, 'plats'));
    };
    return;
  }

  // Nekad: webbläsaren frågar aldrig igen. Enda vägen är menyerna, och sedan
  // ett nytt försök — i Safari är ett lyckat getCurrentPosition dessutom det
  // enda sättet att veta att det verkligen är löst.
  ritaVag(d, 'plats');
  d.ja.textContent = 'Jag har slagit på det';
  d.ja.onclick = () => {
    d.ja.disabled = true;
    d.ja.textContent = 'Kollar…';
    begarPlats().then(svar => {
      d.ja.disabled = false;
      if (svar.ok) slappFramPlats('uppstart-efter-instruktion');
      felText = svar.ok ? null : { nyckel: 'plats', text: svar.reason };
      uppdatera();
    }).catch(() => misslyckades(d, 'plats'));
  };
}

/* ---------------------------- Steg 2 ------------------------------- */

function ritaNotiser(d, st, nu) {
  const n = st.notiser;
  d.ikon.textContent = '🔔';
  d.titel.textContent = 'Slå på notiser';
  d.text.textContent = VARFOR_NOTISER;
  // Den ärliga raden om bakgrunden, ordagrant som överallt annars i appen.
  d.fin.textContent = BAKGRUND.kort;
  d.fin.hidden = false;

  if (nu.lage === 'klart') {
    d.ja.textContent = 'Klart';
    d.ja.onclick = () => nasta();
    return;
  }

  if (nu.lage === 'garinte') {
    // capabilities().reason tas med: saknas VAPID-nyckeln är det appversionen
    // som inte kan skicka, inte webbläsaren som saknar stödet, och den
    // skillnaden ska föraren få läsa som den är.
    d.text.textContent =
      n.reason || push.capabilities().reason || 'Notiser går inte att slå på i den här webbläsaren.';
    d.fin.hidden = true;
    d.ja.textContent = 'Nästa';
    d.ja.onclick = () => nasta();
    return;
  }

  if (nu.lage === 'nekat') {
    ritaVag(d, 'notiser');
    // Ingen ny fråga att ställa — requestPermission svarar "denied" direkt utan
    // att visa något. Knappen läser bara av läget igen, vilket är sant och
    // fungerar: har föraren nollställt behörigheten i inställningarna står den
    // på "fråga" när vi tittar näst gång.
    d.ja.textContent = 'Jag har slagit på det';
    d.ja.onclick = () => {
      felText = null;
      uppdatera();
    };
    return;
  }

  // 'vantar' och 'halv' går båda via begarNotiser(). Skillnaden är bara vad
  // knappen heter: i "halv" finns tillståndet redan, och det som saknas är
  // prenumerationen på servern — utan den kommer ingen notis fram när appen är
  // stängd, hur många ja föraren än tryckt på tidigare.
  d.ja.textContent = nu.lage === 'halv' ? 'Slutför notiser' : 'Slå på notiser';
  d.ja.onclick = () => {
    d.ja.disabled = true;
    d.ja.textContent = 'Väntar på svar…';
    let id = null;
    try { id = deviceId(); } catch {}
    // Ingen await före det här anropet: begarNotiser() ber om lov som första
    // sak den gör, och gesten måste fortfarande vara levande då.
    begarNotiser({ deviceId: id }).then(res => {
      d.ja.disabled = false;
      // Även ett lyckat svar kan ha något att säga, till exempel att
      // tillståndet finns men att servern inte kan skicka påminnelser än.
      felText = res.reason ? { nyckel: 'notiser', text: res.reason } : null;
      uppdatera();
    }).catch(() => misslyckades(d, 'notiser'));
  };
}

/**
 * Anropet gick sönder på vägen, inte "nej" utan "kraschade".
 *
 * Det finns riktiga vägar hit: push.enable() gör atob() på VAPID-nyckeln och
 * frågar pushManager utanför sin egen try, och båda kan kasta. Utan den här
 * återställningen stod knappen kvar avstängd med texten "Väntar på svar…" för
 * alltid, utan felrad — och föraren trodde att appen hängt sig.
 */
function misslyckades(d, nyckel) {
  if (d.ja) d.ja.disabled = false;
  felText = {
    nyckel,
    text: nyckel === 'plats'
      ? 'Något gick fel när platsen skulle slås på. Prova igen.'
      : 'Något gick fel när notiser skulle slås på. Prova igen.',
  };
  uppdatera();
}

/* ------------------------------------------------------------------ */
/* Raden som ligger kvar                                               */
/* ------------------------------------------------------------------ */

let radEl = null;
let radRitas = false;
let radIgen = false;
let radNyckel = null;           // vad radens knapp ska ta itu med

function doljRad() {
  radEl?.remove();
  radEl = null;
}

/**
 * Är platsstart.js röda remsa uppe? Då står plats redan förklarat där, och vi
 * lägger oss under den istället för att säga samma sak en gång till.
 */
function platsRemsan() {
  const r = document.querySelector('.pv-ps-remsa');
  return r && r.getClientRects().length ? r : null;
}

function placeraRad() {
  if (!radEl) return;
  const remsa = platsRemsan();
  const h = remsa ? remsa.getBoundingClientRect().height : 0;
  radEl.style.top = `${Math.round(h)}px`;
  // Ligger vi överst måste vi själva hålla oss undan kameraskåran.
  radEl.style.paddingTop = h ? '9px' : 'calc(env(safe-area-inset-top, 0px) + 9px)';
}

/**
 * Rita raden i två pass.
 *
 * Snabbpasset körs ALLTID direkt, utan kö. Det är det som gör att raden dyker
 * upp i samma ögonblick som föraren stänger rutan. Det vet allt utom om
 * prenumerationen finns, så där hoppas läget "halv" över — annars hade varje
 * start blinkat "notiser är inte färdiga" åt någon som har allt påslaget.
 *
 * Det fulla passet väntar in service workern och kan hålla på i tio sekunder
 * (taket sitter i push.js). Två sådana får aldrig löpa samtidigt, men den som
 * kommer under tiden får inte heller kastas bort — det var oftast den som
 * visste något nytt. Därför köas den och körs efteråt.
 */
async function ritaRad() {
  // Samma startgrind som rutan. Raden ligger visserligen under modalerna, men
  // en gul rad bakom ansvarsfriskrivningen är ändå bara skräp i bakgrunden på
  // det första någon ser av appen.
  if (!farVisa()) return;
  try {
    if (!ritaRadPass(await snabbStatus(), true)) return;
  } catch { return; }

  if (radRitas) { radIgen = true; return; }
  radRitas = true;
  try {
    do {
      radIgen = false;
      try { ritaRadPass(await status(), false); }
      catch { /* går läget inte att läsa säger vi hellre ingenting än fel */ }
    } while (radIgen);
  } finally {
    radRitas = false;
  }
}

/**
 * Ett pass av raden.
 *
 * @param {object} st läget
 * @param {boolean} snabbt hoppa över "halv", som bara full status kan avgöra
 * @returns {boolean} false när det inte är någon idé att fortsätta
 */
function ritaRadPass(st, snabbt) {
  // Kollas om: status() kan ta upp till tio sekunder medan den väntar in
  // service workern, och under tiden hinner rutan öppnas. Utan den här raden
  // ritas raden bakom rutan och står kvar efteråt.
  if (aktiv) { doljRad(); return false; }
  senast = st;

  const steg = byggSteg(st, { tillRad: true })
    .filter(s => s.lage !== 'klart' && s.lage !== 'garinte')
    .filter(s => !(snabbt && s.lage === 'halv'));

  // Plats hoppas över när platsstart.js remsa redan står där och säger det.
  // Två röda rader om samma sak lär föraren att ingen av dem betyder något.
  const visaPlats = !platsRemsan();
  const mina = steg.filter(s => s.nyckel !== 'plats' || visaPlats);

  // Inget kvar i det här passet betyder inte att det snabba passet hade rätt:
  // det fulla kan fortfarande hitta en prenumeration som saknas. Därför tas
  // raden bort men körningen fortsätter.
  if (!mina.length) { doljRad(); return true; }

  // Vad knappen ska ta itu med. Den som saknar flera saker tas till den
  // första i listan, alltså plats före notiser: utan position gör resten av
  // appen ingen nytta ändå.
  radNyckel = mina[0].nyckel;

  injiceraCss();
  if (!radEl) {
    radEl = el('div', 'pv-up-rad');
    radEl.setAttribute('role', 'status');
    const text = el('div', 'pv-up-radtext');
    text.append(el('b'), el('span'));
    const knapp = el('button', null, 'Slå på');
    knapp.type = 'button';
    // Pilen, som ägaren bad om: window.polisvakt.fixaBehorighet() i js/app.js
    // öppnar Inställningar, rullar fram kortet "Plats och notiser" och pekar
    // med js/peka.js på exakt det reglage som saknas. Förut öppnade den här
    // knappen bara vår egen ruta igen, och då nåddes pilen aldrig i det
    // normala flödet. Hemskärmssteget har ingen knapp att peka på — där är
    // rutan med gesten "Dela → Lägg till på hemskärmen" rätt svar, och den är
    // också reserven när hooken saknas.
    knapp.onclick = () => {
      const fixa = window.polisvakt?.fixaBehorighet;
      if (radNyckel && radNyckel !== 'hemskarm' && typeof fixa === 'function') {
        fixa(radNyckel);
        return;
      }
      oppna();
    };
    radEl.append(text, knapp);
    document.body.appendChild(radEl);
  }

  radEl.querySelector('b').textContent = 'Polisvakt är inte färdiginställd';
  radEl.querySelector('.pv-up-radtext span').textContent = radMening(mina);
  placeraRad();
  return true;
}

/** En mening som säger vad som saknas — och vad det kostar föraren. */
function radMening(mina) {
  if (mina.length > 1) {
    // "Kvar att göra" istället för "är inte påslaget": hemskärmen slås inte på,
    // den läggs till, och en mening som är fel om hälften av punkterna får
    // föraren att sluta lita på raden.
    return `Kvar att göra: ${mina.map(s => s.namn.toLowerCase()).join(' och ')}.`;
  }
  const s = mina[0];
  if (s.nyckel === 'hemskarm') return 'Notiser kräver att appen ligger på hemskärmen.';
  if (s.nyckel === 'plats') return 'Polisvakt kan inte varna för något framför dig.';
  if (s.lage === 'halv') return 'Notiser är tillåtna men inte färdiga — inget når dig när appen är stängd.';
  if (s.lage === 'nekat') return 'Notiser är blockerade — inget når dig när appen är stängd.';
  return 'Notiser är inte påslagna — inget når dig när appen är stängd.';
}

/* ------------------------------------------------------------------ */
/* Pulsen: vänta på ledig skärm                                        */
/* ------------------------------------------------------------------ */

let puls = null;
let pulsBorjade = 0;
let tickPagar = false;

function stoppaPuls() {
  clearInterval(puls);
  puls = null;
}

async function tick() {
  if (tickPagar) return;                // status() är asynkron
  tickPagar = true;
  try {
    if (aktiv || stangdISession) { stoppaPuls(); return; }

    // Vänta in appens egen start. Klockan nollställs medan vi väntar: de tre
    // minuterna nedan är till för en skärm som är upptagen av något föraren
    // gör, inte för ett boot() som hänger på dålig täckning.
    if (!farVisa()) { pulsBorjade = Date.now(); return; }

    if (Date.now() - pulsBorjade > MAX_VANTAN_MS) {
      // Skärmen har varit upptagen i flera minuter. En ruta som slår upp nu
      // känns som ett fel. Raden längst upp får ta över, och guiden kommer
      // tillbaka vid nästa start.
      stoppaPuls();
      ritaRad();
      return;
    }
    if (annanRutaUppe()) return;

    // Snabbvägen först. status() väntar in service workern för att kunna se om
    // prenumerationen finns, och den väntan har tio sekunders tak i push.js —
    // en förare som startar appen ska inte titta på en tom karta så länge
    // innan frågan kommer. Allt utom "halv" går att avgöra utan den, eftersom
    // det enda snabbStatus() inte vet är just om prenumerationen finns.
    let st;
    try {
      const snabb = await snabbStatus();
      const stegSnabb = byggSteg(snabb);
      if (stegSnabb.some(s => s.lage === 'vantar' || s.lage === 'nekat')) {
        senast = snabb;
        // Pulsen stoppas EFTER att rutan öppnats, och bara om den faktiskt
        // gick upp: oppna() backar när något annat hunnit lägga sig på
        // skärmen, och en puls som redan är död försöker aldrig igen.
        oppna(snabb);
        if (aktiv) stoppaPuls();
        return;
      }
      st = await status();
    } catch { return; }
    senast = st;

    // ritaRad() och inte doljRad(): rutans steglista kan sakna plats efter ett
    // "inte nu", men raden ska fortfarande nämna det. Finns inget kvar där
    // heller tar ritaRadPass() bort raden själv.
    if (!nagotSaknas(byggSteg(st))) { stoppaPuls(); ritaRad(); return; }

    oppna(st);
    if (aktiv) stoppaPuls();
  } finally {
    tickPagar = false;
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

function domRedo() {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
}

function bevaka() {
  // app.js skickar den här sist i boot(), alltså efter att ansvarsfriskrivningen
  // ritats. Först då vet annanRutaUppe() vad som egentligen ligger på skärmen.
  addEventListener('polisvakt:ready', () => {
    appRedo = true;
    pulsBorjade = Date.now();
    if (!aktiv) ritaRad();
  }, { once: true });

  // Tillståndet kan ändras utan att vi frågat: geo.js matar in platsläget så
  // fort watchPosition svarar, och Permissions API kan säga till mitt i
  // körningen.
  behorighetsEvents.addEventListener('andrad', () => {
    if (aktiv) uppdatera();
    else ritaRad();
  });

  // Föraren kan ha varit inne i telefonens inställningar och löst det. Då ska
  // raden vara borta när hen kommer tillbaka, inte stå kvar och ha fel.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (aktiv) uppdatera();
    else ritaRad();
  });

  addEventListener('resize', placeraRad);

  // Platsremsan dyker upp och försvinner utan att säga till oss — den ritas av
  // platsstart.js på egna villkor — och den avgör två saker för vår rad: var
  // den ska ligga, och om den ska nämna plats alls. Billigare att mäta om när
  // body ändras än att gissa en höjd som är fel på halva telefonerna, eller
  // att stå kvar och säga samma sak som remsan ovanför.
  let planerad = false;
  let remsaFanns = false;
  new MutationObserver(() => {
    if (planerad || !radEl) return;
    planerad = true;
    requestAnimationFrame(() => {
      planerad = false;
      const finns = !!platsRemsan();
      if (finns === remsaFanns) { placeraRad(); return; }
      remsaFanns = finns;
      ritaRad();
    });
  }).observe(document.body, { childList: true });
}

/**
 * Sätt VAPID-nyckeln själva, innan något läse av push.capabilities().
 *
 * app.js gör det i wirePermissions(), men den ligger efter tre nätanrop i
 * boot(). Fram till dess är nyckeln tom, capabilities() säger { supported:
 * false, fix: 'server' } och behorigheter.begarNotiser() tar då inte
 * push.enable()-grenen utan bara Notification.requestPermission(): tillstånd
 * utan prenumeration, ingen rad på servern. Det är exakt den halvfärdiga
 * behörighet hela den här filen finns för att få bort. Nyckeln är publik och
 * kräver ingen väntan, så det finns ingen anledning att sitta och hoppas på
 * ordningen i boot().
 */
function konfigureraPush() {
  try { push.configure({ vapidPublicKey: CONFIG.vapidPublicKey || '' }); } catch {}
}

/*
 * Provknappen i inställningarna.
 *
 * Provet satt först som ett steg i guiden och LÅSTE den: steget lades bara
 * till när notissteget var 'klart', och eftersom det läget läses om vid varje
 * ritning dök steget upp och försvann mellan två ritningar. Guiden hoppade då
 * tillbaka till första ostädade steget, alltså notiser, och föraren satt fast
 * i en slinga han inte kunde ta sig ur. Se kommentaren i byggSteg().
 *
 * Här kan det inte stå i vägen för någon. Den som vill veta går och kollar;
 * den som bara vill köra blir inte hindrad.
 */
function kopplaNotisprov() {
  const knapp = document.getElementById('btnProvaNotisljud');
  if (!knapp || knapp.dataset.kopplat === '1') return;
  knapp.dataset.kopplat = '1';

  const skriv = t => {
    const r = document.getElementById('provaNotisStatus');
    if (r) r.textContent = t;
  };

  knapp.addEventListener('click', async () => {
    skriv('Skickar…');
    const r = await provaNotisljud();
    if (!r.ok) {
      skriv('Provnotisen kunde inte skickas: ' + r.skal +
            '  Är notiser påslagna för appen?');
      return;
    }
    // Menyvägen skrivs ut DIREKT, inte först om föraren säger att det var
    // tyst. Den som inte hörde något ska inte behöva trycka en gång till för
    // att få veta vad han ska göra åt det.
    skriv('Skickad. Hörde du ingenting? Då är ljudet avslaget i telefonen: '
          + LJUD_VAG().join(' '));
  });
}

async function start() {
  konfigureraPush();
  await domRedo();
  injiceraCss();
  bevaka();
  ritaRad();
  kopplaNotisprov();

  pulsBorjade = Date.now();
  puls = setInterval(tick, PULS_MS);
  tick();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Går något fel här ska resten av appen inte märka det. Frågorna finns kvar
  // i introduktionsguiden och i inställningarna.
  start().catch(() => {});
}
