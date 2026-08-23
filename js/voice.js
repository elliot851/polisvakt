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
import { narGest, anvandarenHarInteragerat } from './ljud.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const voiceInputSupported = !!SR;
export const voiceOutputSupported = 'speechSynthesis' in window;

/* ------------------------------------------------------------------ */
/* Ljudupplåsning                                                      */
/* ------------------------------------------------------------------ */
//
// Det här är det som avgör om appen gör någon nytta alls, och det är värt de
// här raderna att förklara.
//
// Scenariot appen är byggd för: telefonen sitter i hållaren, appen är öppen,
// bilen rullar — och föraren har INTE rört skärmen. Då gäller två spärrar, och
// båda är helt tysta:
//
//   1. En AudioContext som skapas utan föregående användargest föds
//      'suspended'. Plingets toner schemaläggs mot en klocka som står stilla
//      och hörs aldrig. ctx.resume() utan gest avvisas — och det avvisade
//      löftet syns ingenstans, eftersom ett try/catch bara fångar kast.
//   2. speechSynthesis.speak() kräver på iOS att det FÖRSTA yttrandet ligger
//      inuti en levande gest. Missas det får varje kommande yttrande 'error'
//      istället för ljud, och kön töms tyst, en varning i taget.
//
// Ingen kodväg i appen råkade uppfylla kraven: både provknappen och de skarpa
// varningarna lägger say() i en setTimeout på 320–380 ms, och då är gesten
// död. Resultatet var en varningsapp som kunde vara helt tyst med varenda
// reglage påslaget, utan att något syntes i gränssnittet.
//
// Därför låser vi upp båda sakerna i FÖRSTA trycket, vilket tryck som helst:
// friskrivningens knapp, ett flikbyte, en tangent. Gesten kommer från ljud.js
// som redan äger frågan "har föraren rört sidan?".
//
// Varför en tyst yttring och inte bara "vi provar när det behövs": det första
// yttrandet är det enda som måste ligga i en gest. Är det avklarat får alla
// senare yttranden komma från en timer, en GPS-händelse eller vad som helst.
// Ett tyst yttrande i första trycket köper alltså resten av resan.
//
//
// ------------------------------------------------------------------------
// VAD SOM VAR FEL MED RESONEMANGET OVANFÖR, OCH VARFÖR IPHONEN VAR TYST
// ------------------------------------------------------------------------
//
// "Ett tyst yttrande i första trycket köper resten av resan" stämmer bara om
// två saker är sanna: att yttrandet faktiskt SPELADES, och att resan aldrig
// tar en paus. Ingen av dem höll.
//
//   1. UPPLÅSNINGEN BOKFÖRDES SOM LYCKAD UTAN ATT VARA DET. Den gamla
//      primaRosten() satte rostPrimad = true på raden EFTER
//      speechSynthesis.speak(), utan att lyssna på om yttrandet accepterades.
//      speak() kastar inte när webbläsaren vägrar — den svarar, lägger
//      yttrandet i en kö och skickar 'error' med error='not-allowed' en
//      bråkdel senare. Uppmätt på live-appen: efter ett anrop utan gest stod
//      ljudlas.rost på true medan speechSynthesis.speaking och .pending båda
//      var false. Yttrandet hade alltså aldrig ens kommit in i kön, och
//      gränssnittet sa "Ljudet är upplåst."
//      Och eftersom `if (rostPrimad) return true` var en spärr som ingenting
//      nollställde, primades rösten exakt EN gång per sidladdning. Gick den
//      gången fel var rösten död resten av körningen.
//
//   2. RESAN TAR PAUSER. Telefonen låses, föraren tittar i kartan, ett samtal
//      kommer in. iOS river då ljudsessionen: AudioContext går till
//      'interrupted' (ett Safari-eget tillstånd som inte är 'suspended', och
//      som den gamla koden därför aldrig resumade) eller ända till 'closed'
//      (som inte gick att bygga om alls — variabeln nollställdes aldrig).
//      Talsyntesen kan dessutom lämnas i ett läge där speak() svarar utan att
//      något hörs. Ingenting i appen tog reda på det, och ingenting sa till.
//
//   3. INGEN VISSTE ATT DET VAR TYST. Bara u.onend var kopplad. Ett yttrande
//      som tyst inte gör någonting anropar varken onend eller onerror, så
//      bokföringen stod kvar på gammalt värde och tystnaden gick inte att se
//      i efterhand — vilket är hela skälet till att felet kunde ligga kvar i
//      flera dygn.
//
// Därför gäller nu tre regler i den här filen:
//
//   • RÖSTEN ÄR UPPLÅST FÖRST NÄR DEN HAR TALAT. Ingenting annat räknas.
//     Beviset är u.onstart. Uteblir onstart är rösten inte upplåst, hur
//     villigt speak() än svarade.
//   • VARJE ÅTERKOMST TILL FÖRGRUNDEN ÄR EN NY RESA. visibilitychange och
//     pageshow river upp beviset, bygger om ljudkontexten om den dog, städar
//     bort en hängande kö och armerar om gest-vägen.
//   • EN TYSTNAD SOM INTE GÅR ATT SE FINNS INTE. Varje yttrande vaktas, varje
//     misslyckande bokförs, och ett fel som inte är förarens eget val syns på
//     skärmen med en knapp som lagar det.

/** Hur länge ett yttrande får dröja innan vi kallar det icke-startat. */
const ROST_START_FRIST_MS = 1500;

/** Extra frist efter speechSynthesis.resume() innan vi ger upp yttrandet. */
const ROST_RADDNING_MS = 700;

/** Hur länge upplåsningsprovet får hänga innan det räknas som nekat. */
const PRIM_FRIST_MS = 1400;

/**
 * Hur länge ett varningspling får stå ensamt innan tystnaden efter det
 * räknas som ett fel. Plinget kommer på t, uppläsningen läggs i en timer på
 * 380 ms, och talsyntesen behöver några hundra millisekunder på sig att
 * starta. 3 sekunder är alltså gott om marginal utan att bli ett dygn.
 */
const PLING_ROST_FRIST_MS = 3000;

/** Så många upplåsningsförsök per förgrundsomgång innan vi slutar tjata. */
const ROST_MAX_FORSOK = 6;

/** Vad vi vet om upplåsningen. Läses av gränssnitt och provbänk. */
const ljudlas = {
  ctx: false,          // AudioContext är 'running'
  rost: false,         // speechSynthesis har BEVISLIGEN talat (onstart kom)
  forsokt: 0,
  tid: 0,
  orsak: 'inte-forsokt',
};

/**
 * Röstens läge, separat från ljudlas därför att det är en annan sorts fakta.
 *
 * ljudlas.rost är ett ja/nej för gränssnittet. Det här är historiken bakom
 * svaret: hur många gånger vi provat i den här förgrundsomgången, vad
 * webbläsaren svarade sist, och när rösten senast bevisligen lät. Utan den
 * går det inte att skilja "har inte provat än" från "provade och blev nekad",
 * och det är precis den skillnaden felsökningen stod och föll med.
 */
const rost = {
  lage: 'inte-forsokt',   // inte-forsokt | provar | klar | nekad
  orsak: 'inte-forsokt',
  forsok: 0,              // nollställs vid varje återkomst till förgrunden
  provStart: 0,
  senastKlar: 0,          // när rösten senast bevisligen talade
  senasteFel: 0,
};

let ljudCtx = null;
// Deklareras här uppe och inte vid haLjudkedja() längre ner: haLjudkontext()
// måste kunna nollställa den när en död context byts ut, och `let` i
// temporal dead zone hade kastat ReferenceError om första gesten kom innan
// modulen laddat färdigt.
let ljudkedja = null;
let taltIGang = 0;     // riktiga yttranden i luften just nu

/** Alla levande Speaker-instanser, så återhämtningen når dem utan app.js. */
const levandeTalare = new Set();

/**
 * Sant om appen själv har något på gång i talsyntesen just nu.
 *
 * RÄKNAREN ENSAM DUGER INTE SOM BEVIS, och det är hela poängen med den här
 * funktionen efter felet nedan.
 *
 * Tidigare räckte `taltIGang > 0`. Räknaren ökas i #drain() och minskas bara
 * i done(), och både stop() och interrupt-grenen i say() kallade
 * speechSynthesis.cancel() utan att någonsin nå done(). WebKit levererar inte
 * tillförlitligt 'canceled' för ett avbrutet yttrande, så uteblev onerror stod
 * räknaren kvar på 1 för alltid. Följden var förödande och helt osynlig:
 * appenTalarSjalv() svarade true i evighet, primaRosten() kortslöts,
 * gränssnittet intygade "Ljudet är upplåst", stadaZombiekO() vägrade städa en
 * hängd kö och atervandTillForgrunden() slutade prova rösten. Alla
 * återhämtningsvägar avstängda av en räknare som ingen kunde se.
 *
 * Läckan är tätad (se #avslutaAvbrutet), men golvet ligger kvar ändå: svaret
 * kräver att en LEVANDE Speaker faktiskt äger ett yttrande eller en kö. Den
 * bokföringen nollställs av done() på varje väg och kan därför inte fastna på
 * samma sätt. taltIGang finns kvar som mätvärde i ljudlasStatus(), så en ny
 * läcka går att se i stället för att gissa.
 */
function appenTalarSjalv() {
  for (const t of levandeTalare) if (t.speaking || t.queue.length) return true;
  return false;
}

/**
 * Den delade contexten för pling — EN för hela sidan.
 *
 * Tidigare hade varje Speaker sin egen (this._ctx), och plate.js och larm.js
 * har fortfarande sina. Telefoner har ett tak på antalet contexts, och en
 * context som ingen resumar är en context som aldrig låter.
 */
export function haLjudkontext({ skapa = true } = {}) {
  /*
   * En stängd context går inte att väcka — resume() på en 'closed' context
   * gör ingenting alls. iOS stänger den när appen legat i bakgrunden en
   * längre stund eller när ett samtal tagit över ljudet, och tidigare
   * returnerade den här funktionen samma döda objekt för alltid: variabeln
   * nollställdes ingenstans. Följden var att `upplast` i spelaVarningsljud()
   * blev permanent false och varje pling svarade tyst
   * 'ljudet-inte-upplast' resten av körningen.
   *
   * Ljudkedjan måste nollställas i samma andetag. Dess noder tillhör den
   * döda contexten, och haLjudkedja() jämför på just ctx-identitet.
   */
  if (ljudCtx && ljudCtx.state === 'closed') {
    ljudCtx = null;
    ljudkedja = null;
  }
  if (!ljudCtx) {
    if (!skapa) return null;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { ljudCtx = new AC(); } catch { ljudCtx = null; return null; }
    // Contexten säger själv till när den börjat köra. Utan den här skulle
    // ljudlas.ctx stå kvar på false, eftersom resume() svarar först efter att
    // gesten är avklarad.
    try { ljudCtx.onstatechange = () => { ljudlas.ctx = ljudCtx?.state === 'running'; }; } catch {}
  }
  /*
   * Allt som inte är 'running' ska väckas — inte bara 'suspended'.
   *
   * Safari på iOS har ett eget, icke-standardiserat tillstånd: 'interrupted'.
   * Dit hamnar contexten vid inkommande samtal, skärmlås och när en annan app
   * tar ljudet. Den gamla koden testade `state === 'suspended'` och missade
   * alltså exakt det tillstånd som uppstår i en bil. Ett resume() på en
   * context som redan kör är gratis, så det finns ingen anledning att vara
   * kräsen här.
   *
   * resume() lämnar ett LÖFTE. Utan användaraktivering avvisas det, och ett
   * avvisat löfte fångas inte av try/catch — det blev tidigare ett ohanterat
   * fel i konsolen varje gång appen försökte plinga för tidigt.
   */
  if (ljudCtx.state !== 'running') {
    try { ljudCtx.resume()?.catch?.(() => {}); } catch {}
  }
  ljudlas.ctx = ljudCtx.state === 'running';
  return ljudCtx;
}

/**
 * Rösten har bevisligen talat. Det här är det ENDA som får sätta ljudlas.rost.
 *
 * Anropas från upplåsningsprovets onstart och från varje riktigt yttrandes
 * onstart. Att låta ett skarpt yttrande räknas som bevis är poängen: kommer
 * en varning fram behöver ingen prima om något, och strimman nere på skärmen
 * ska försvinna av sig själv i samma sekund som rösten fungerar igen.
 */
function markeraRostKlar(orsak) {
  const varTyst = rost.lage !== 'klar';
  rost.lage = 'klar';
  rost.orsak = orsak;
  rost.senastKlar = Date.now();
  ljudlas.rost = true;
  // Rösten har bevisligen låtit. Skulle den tystna igen längre fram är rutan
  // relevant på nytt — men först då, inte en gång per varning. Se visaRostFel.
  rostFelVisad = false;
  if (varTyst) {
    doljRostFel();
    meddelaRostlage();
  }
}

/**
 * Rösten kom inte fram.
 *
 * Bokförs alltid. Syns när det inte är förarens eget val och när föraren
 * faktiskt hunnit röra skärmen — före första trycket är en låst röst det
 * normala tillståndet, inte ett fel, och en röd ruta vid varje appstart hade
 * lärt föraren att ignorera den. Strimman dröjer dessutom några sekunder, så
 * ett fel som löser sig vid nästa tryck aldrig hinner blinka förbi.
 */
function markeraRostNekad(orsak) {
  rost.lage = 'nekad';
  rost.orsak = orsak;
  rost.senasteFel = Date.now();
  ljudlas.rost = false;
  meddelaRostlage();
  if (anvandarenHarInteragerat()) {
    visaRostFel('Rösten kommer inte fram. Varningar hörs bara som pling.');
  }
}

/**
 * Städa bort ett upplåsningsprov som blivit hängande.
 *
 * Bara om ingen RIKTIG uppläsning är i luften. Annars vore en cancel() här
 * exakt det fel filen finns för att undvika: en varning som klipps.
 */
function stadaHangandeProv() {
  setTimeout(() => {
    if (appenTalarSjalv()) return;
    try {
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    } catch {}
  }, PRIM_FRIST_MS);
}

/**
 * Ett tyst yttrande, bara för att låsa upp talsyntesen — och för att TA REDA
 * PÅ om upplåsningen gick igenom.
 *
 * Volym 0 så ingen hör det, och en punkt istället för tom sträng: Chrome
 * svarar 'synthesis-failed' på tom text, och en misslyckad upplåsning är inte
 * en upplåsning.
 *
 * Skillnaden mot den gamla versionen ligger i vad som räknas som svar.
 * speak() är inte ett svar: den kastar inte, den returnerar ingenting, och
 * webbläsaren kan neka yttrandet efteråt utan att någon märker det. Därför
 * kopplas alla tre utgångarna, och rösten räknas som upplåst först när en av
 * dem säger att den faktiskt lät:
 *
 *   onstart  → rösten talade. Bevis.
 *   onend    → yttrandet gick igenom hela vägen. Vissa motorer hoppar över
 *              onstart på mycket korta yttranden, så det räknas också.
 *   onerror  → nekad. 'not-allowed' betyder att gesten inte höll.
 *   inget    → tystnad. Motorn svarade men gjorde ingenting. Det är det värsta
 *              utfallet, för det är det enda som inte syns någonstans, och det
 *              är precis det som hände på iPhonen.
 *
 * @returns {boolean} true bara när rösten är BEVISAT upplåst. Ett pågående
 *          prov ger false, så anroparen provar igen vid nästa tryck.
 */
function primaRosten() {
  if (!voiceOutputSupported) { ljudlas.rost = true; rost.lage = 'klar'; return true; }
  if (rost.lage === 'klar') return true;

  /*
   * Appen har redan något på gång. Ett extra yttrande skulle bara ställa sig
   * i kön framför en varning, så vi hoppar över provet — men vi INTYGAR
   * ingenting.
   *
   * Raden hette förut markeraRostKlar('appen-talar-redan'), och det bröt mot
   * filens egen hårda regel: rösten är upplåst först när den har TALAT. Att
   * ett yttrande ligger i kön säger bara att vi har skickat det, inte att
   * någon hört det — och just den kortslutningen gjorde att en hängd kö
   * kunde få appen att svara "Ljudet är upplåst" medan talsyntesen var
   * stendöd. Beviset kommer från u.onstart i #drain(), som markerar klart
   * när yttrandet faktiskt börjar låta.
   *
   * Notera att vi frågar VÅR EGEN bokföring och inte speechSynthesis.speaking:
   * en kö som fastnat efter bakgrundsläge står också på speaking, och den
   * gamla koden läste det som ett friskhetstecken.
   */
  if (appenTalarSjalv()) return true;

  // Ett prov är redan i luften. Att skicka ett till hade bara gjort kön
  // längre och svaret otydligare.
  if (rost.lage === 'provar' && Date.now() - rost.provStart < PRIM_FRIST_MS) return false;

  if (rost.forsok >= ROST_MAX_FORSOK) return false;

  try {
    const u = new SpeechSynthesisUtterance('.');
    u.lang = 'sv-SE';
    u.volume = 0;
    u.rate = 2;

    rost.lage = 'provar';
    rost.orsak = 'provar';
    rost.provStart = Date.now();
    rost.forsok++;

    let avgjort = false;
    const avgor = (fn) => (...a) => { if (avgjort) return; avgjort = true; clearTimeout(vakt); fn(...a); };
    const vakt = setTimeout(() => {
      if (avgjort) return;
      avgjort = true;
      // Varken start, slut eller fel. Motorn svarade och gjorde ingenting.
      markeraRostNekad('provet-startade-aldrig');
      stadaHangandeProv();
    }, PRIM_FRIST_MS);

    u.onstart = avgor(() => { markeraRostKlar('provet-startade'); stadaHangandeProv(); });
    u.onend = avgor(() => markeraRostKlar('provet-avslutades'));
    u.onerror = avgor(e => {
      const fel = e?.error || 'okant';
      // 'canceled'/'interrupted' är vi själva som städat. Det säger ingenting
      // om huruvida rösten får låta, så det får inte bokföras som ett nej.
      if (fel === 'canceled' || fel === 'interrupted') { rost.lage = 'inte-forsokt'; return; }
      markeraRostNekad('provet-nekades:' + fel);
    });

    speechSynthesis.speak(u);
    return false;   // ännu inte bevisat — svaret kommer i en av handlarna
  } catch {
    markeraRostNekad('speak-kastade');
    return false;
  }
}

/**
 * Lås upp ljudet. Måste köras inuti en användargest.
 *
 * @returns {boolean} true = klart, false = prova igen vid nästa tryck
 */
export function lasUppLjud() {
  ljudlas.forsokt++;
  ljudlas.tid = Date.now();

  const ctx = haLjudkontext();
  const rostKlar = primaRosten();

  ljudlas.orsak =
    !ctx ? 'ingen-ljudmotor'
    : rost.lage === 'nekad' ? 'rosten-slapptes-inte-fram'
    : !rostKlar ? 'provar-rosten'
    : ljudlas.ctx ? 'upplast'
    : 'vantar-pa-ljudmotorn';

  if ((!ctx || ljudlas.ctx) && rostKlar) return true;
  // Sex försök utan att rösten lossnar: webbläsaren tänker inte släppa fram
  // den vid ett sjunde tryck heller. Vi slutar tjata i gest-registret, men
  // ger INTE upp — strimman nere på skärmen har en knapp som nollställer
  // räknaren, och varje återkomst till förgrunden är en ny omgång.
  return ljudlas.forsokt >= 5 && rost.forsok >= ROST_MAX_FORSOK;
}

/** Läsbart läge för gränssnitt och felsökning. */
export function ljudlasStatus() {
  const klart = ljudlas.ctx && ljudlas.rost;
  return {
    ...ljudlas,
    klart,
    rostLage: rost.lage,
    rostOrsak: rost.orsak,
    rostForsok: rost.forsok,
    ctxLage: ljudCtx ? ljudCtx.state : 'ingen',
    // Yttranden appen tror sig ha i luften. Står den kvar över noll när allt
    // är tyst har balanseringen i done() missat en väg ut — se
    // appenTalarSjalv(). Med i diagnosen just för att en sådan läcka annars
    // inte syns någonstans.
    iLuften: taltIGang,
    text: klart ? 'Ljudet är upplåst.'
      : !anvandarenHarInteragerat() ? 'Ljudet väntar på första trycket på skärmen.'
      : ljudlas.orsak === 'ingen-ljudmotor' ? 'Enheten har ingen ljudmotor för webbsidor.'
      : rost.lage === 'nekad' ? 'Rösten kom inte fram. Tryck på skärmen en gång.'
      : rost.lage === 'provar' ? 'Provar rösten…'
      : 'Webbläsaren har inte släppt fram ljudet än.',
  };
}

/** Allt om röstens hälsa, för gränssnitt och provbänk. */
export function rostHalsa() {
  return {
    ...rost,
    stods: voiceOutputSupported,
    ljudlas: ljudlasStatus(),
    // Rösten anses frisk om den talat sedan sidan senast kom i förgrunden.
    frisk: rost.lage === 'klar',
  };
}

/* ------------------------------------------------------------------ */
/* Gest-vägen — och varför voice.js har en egen                        */
/* ------------------------------------------------------------------ */
//
// ljud.js äger frågan "har föraren rört sidan?" och lyssnar på pointerdown,
// keydown och touchstart. Det är rätt för AudioContext.resume(), som släpps
// fram på ett påbörjat tryck.
//
// speechSynthesis på WebKit är kinkigare. Aktiveringen sitter säkrast på det
// AVSLUTADE trycket — click, pointerup, touchend — och appen lade hela sin
// enda upplåsningschans på den tidigaste och minst pålitliga punkten. Den här
// lyssnaren kompletterar alltså ljud.js snarare än att ersätta den: kommer
// pointerdown först får det försöket gälla, och lossnar det inte finns
// touchend en bråkdels sekund senare.
//
// Lyssnarna sitter i capture och passive, precis som ljud.js, och plockas bort
// så fort rösten är bevisat upplåst — men armeras om vid varje återkomst till
// förgrunden, eftersom beviset då är förbrukat.

const AVSLUTADE_GESTER = ['click', 'pointerup', 'touchend'];
let gestlyssnareArmerade = false;

function vidAvslutadGest() {
  if (rost.lage === 'klar' && ljudlas.ctx) { slutaLyssnaEfterGest(); return; }
  lasUppLjud();
}

function lyssnaEfterGest() {
  if (typeof window === 'undefined' || gestlyssnareArmerade) return;
  gestlyssnareArmerade = true;
  for (const namn of AVSLUTADE_GESTER) {
    window.addEventListener(namn, vidAvslutadGest, { capture: true, passive: true });
  }
}

function slutaLyssnaEfterGest() {
  if (typeof window === 'undefined' || !gestlyssnareArmerade) return;
  gestlyssnareArmerade = false;
  for (const namn of AVSLUTADE_GESTER) {
    window.removeEventListener(namn, vidAvslutadGest, true);
  }
}

/* ------------------------------------------------------------------ */
/* Återkomst till förgrunden                                           */
/* ------------------------------------------------------------------ */

/**
 * Städa bort en kö som fastnat.
 *
 * Det klassiska iOS-läget: appen låg i bakgrunden mitt i ett yttrande, och
 * när den kommer tillbaka står speechSynthesis kvar på speaking eller pending
 * utan att någonsin skicka 'end'. Varje nytt speak() hamnar då bakom ett
 * yttrande som aldrig tar slut, och appen är tyst för alltid.
 *
 * Vi rör bara kön när APPEN själv inte har något på gång — annars vore det
 * här en cancel() rakt in i en pågående varning.
 *
 * @returns {boolean} true om något faktiskt städades bort
 */
function stadaZombiekO() {
  if (!voiceOutputSupported) return false;
  if (appenTalarSjalv()) return false;
  let hangande = false;
  try { hangande = speechSynthesis.speaking || speechSynthesis.pending || speechSynthesis.paused; } catch {}
  if (!hangande) return false;
  // resume() först: en kö som bara är pausad ska få tala färdigt av sig själv
  // hellre än att slängas. Hjälper det inte tar cancel() bort proppen.
  try { speechSynthesis.resume(); } catch {}
  try { speechSynthesis.cancel(); } catch {}
  return true;
}

/**
 * Appen är framme igen. Allt som iOS river i bakgrunden byggs upp på nytt.
 *
 * Ordningen spelar roll: ljudmotorn först (den kan behöva byggas om från
 * grunden), sedan kön (en propp måste bort innan något nytt kan tala), sedan
 * röstlistan (SpeechSynthesisVoice-objekt från före bakgrundsläget är en känd
 * väg till ett speak() som svarar utan att låta), och sist själva
 * upplåsningen.
 */
function atervandTillForgrunden(anledning) {
  // 1. Ljudmotorn. haLjudkontext bygger om en 'closed' context och resumar
  //    'interrupted' likaväl som 'suspended'. skapa:false så vi inte skapar
  //    en context innan föraren rört skärmen — det gör ljud.js poäng av.
  haLjudkontext({ skapa: anvandarenHarInteragerat() });

  // 2. Beviset är förbrukat. Att rösten lät före pausen säger ingenting om
  //    huruvida den låter nu, och det var precis det antagandet som gjorde
  //    appen tyst utan att någon kunde se det.
  if (rost.lage !== 'provar') {
    rost.lage = 'inte-forsokt';
    rost.orsak = 'aterkom-till-forgrunden:' + anledning;
    ljudlas.rost = false;
  }
  rost.forsok = 0;
  ljudlas.forsokt = 0;

  // 3. Proppen.
  stadaZombiekO();

  // 4. Röstlistan.
  for (const t of levandeTalare) t.uppdateraRost();

  // 5. Prova direkt. iOS behåller ofta aktiveringen över ett kort
  //    bakgrundsläge, och lyckas det här behöver föraren inte röra skärmen
  //    alls. Misslyckas det får vi svaret inom PRIM_FRIST_MS och kan säga
  //    till — vilket är oändligt mycket bättre än att gissa.
  if (!appenTalarSjalv()) primaRosten();

  // 6. Och armera gest-vägen, båda sorterna, som skyddsnät.
  lyssnaEfterGest();
  narGest(lasUppLjud);
}

if (typeof window !== 'undefined') {
  narGest(lasUppLjud);
  lyssnaEfterGest();
}

if (typeof document !== 'undefined') {
  // Telefonen suspenderar contexten när appen legat i bakgrunden. Utan det här
  // är appen tyst efter varje gång föraren tittat på en karta i en annan app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') atervandTillForgrunden('synlig');
  });
}

if (typeof window !== 'undefined') {
  /*
   * pageshow och inte bara visibilitychange.
   *
   * En installerad PWA från hemskärmen suspenderas helt när man byter app.
   * Kommer den tillbaka laddas sidan INTE om — det är samma session som
   * fortsätter — och beroende på iOS-version kommer ibland pageshow
   * (persisted=true, bfcache) i stället för eller före visibilitychange.
   * Båda vägarna leder till samma återhämtning, och funktionen är idempotent
   * så det gör ingenting att de ibland kommer efter varandra.
   */
  window.addEventListener('pageshow', e => atervandTillForgrunden(e?.persisted ? 'bfcache' : 'pageshow'));
  // focus fångar skrivbordsfallet där fliken aldrig var 'hidden' men
  // webbläsaren ändå släppt ljudet, till exempel efter viloläge.
  window.addEventListener('focus', () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      haLjudkontext({ skapa: false });
      if (rost.lage === 'nekad') { rost.forsok = 0; lyssnaEfterGest(); }
    }
  });
}

/* ------------------------------------------------------------------ */
/* En tystnad som syns                                                 */
/* ------------------------------------------------------------------ */
//
// VARFÖR DET HÄR LIGGER I VOICE.JS OCH INTE I APP.JS
//
// Felet som fick appen att vara tyst på en iPhone i flera dygn var inte att
// rösten gick sönder. Det var att ingenting sa till. Föraren såg en app med
// varenda reglage påslaget, gränssnittet sa "Ljudet är upplåst", och den enda
// funktion som kunde ha svarat på frågan — ljudDiagnos() — refererades inte
// från någon yta i hela appen.
//
// En felyta som bor i en annan fil än felet glider isär från det. Den här
// strimman är därför en del av ljudkedjan, inte en del av gränssnittet: den
// väcks av samma bokföring som räknar tystnaderna, och den försvinner i
// samma sekund som ett yttrande faktiskt startar.
//
//
// PLACERING — VAD SOM INTE FICK HÄNDA
//
// Nere, och aldrig över kartans mitt. Vägen framför bilen är det viktigaste
// på skärmen och en diagnosruta får inte skymma den.
//
// z-index 895, alltså UNDER varningsbannern och det mörka körläget (900),
// under modalerna (1000) och långt under fordonslarmet (1500), som aldrig får
// skymmas. Över tabbaren (800) — men bara i lagerordning: strimman ligger
// ovanför baren i höjdled, inte över den, så tabbarna förblir träffbara.
//
// Toppen av skärmen var utesluten. Där trängs redan fem ytor om samma
// remsa — varningsytan (905), varningsbannern (900), platsremsan (890),
// uppstartsraden (889) och "N nya rapporter" (875).
//
//
// HÖJDEN: OVANFÖR RAPPORTKNAPPARNA, INTE OVANPÅ DEM
//
// Första placeringen var --bar-total + 10px, med motiveringen att "enda
// överlappet är toasten". Det var fel, och felet var av samma sort som det
// den här filen finns för att beskriva: en yta som ser ofarlig ut och äter
// ett tryck som betydde något annat.
//
// FRAMKALLAT SKARPT på 375×812 i kartvyn, med speechSynthesis.speak gjord
// till en tyst no-op och en färsk rapport inmatad:
//
//   strimman            x 10–365,  y 673,5–748
//   .actions (z700)     Polis 12–84 · Kontroll 92–164 · Civil 172–244 ·
//                       Tala 252–363, alla y 662–738
//   elementFromPoint(207, 700)  — mitt i "Civil" — gav
//                       .pv-rost-fel-fix "Slå på rösten"
//
// Strimman täckte 64,5 av knapparnas 76 px höjd. Föraren som ser en civil
// polisbil och trycker på Civil-knappen fick ett rösttest i stället.
//
// Därför ligger strimman nu OVANFÖR knapparna: --bar-total + 108px, alltså
// över y 662. Talet är .actions egen höjd (10 px överkant + 76 px knapp +
// 12 px underkant = 98) plus 10 px luft.
//
// pointer-events är samtidigt ändrad från none till auto på hela strimman.
// none lät trycket passera igenom till det som låg under, och att träffa en
// knapp man inte kan se är värre än att inte träffa någon knapp alls. Priset
// är att strimman täcker de nedersta ~60 px av farulistan (#sheet, z600,
// börjar vid --bar-total + 88px) så länge den ligger uppe. Det är rätt
// avvägning: rapportknapparna är en handling, listan är en uppslagsbok, och
// strimman går att stänga med sitt eget kryss.
//
// Toasten (--bar-total + 18px, z1200) överlappar inte längre alls.

const ROST_FEL_ID = 'pv-rost-fel';
const ROST_FEL_DROJ_MS = 4000;   // så ett startfel som löser sig aldrig hinner synas

let rostFelTimer = null;
let rostFelNod = null;

/** Skickar röstens läge vidare så andra filer kan visa det utan att importera. */
function meddelaRostlage() {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('pv-rost', { detail: rostHalsa() }));
  } catch {}
}

function byggRostFelNod() {
  if (rostFelNod || typeof document === 'undefined' || !document.body) return rostFelNod;

  const stil = document.createElement('style');
  stil.id = ROST_FEL_ID + '-stil';
  // Egna variabler med fallback: filen ska fungera även i provbänkarna, som
  // laddar voice.js utan css/app.css.
  stil.textContent = `
.pv-rost-fel {
  position: fixed;
  left: 10px; right: 10px;
  /* 108px = .actions hela höjd (98) plus 10px luft. Se den uppmätta
     motiveringen i blocket ovanför: på +10px låg strimman ovanpå kartans
     fyra rapportknappar och åt deras tryck. */
  bottom: calc(var(--bar-total, 64px) + 108px);
  z-index: 895;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: linear-gradient(180deg, #7a2626, #5c1b1b);
  border: 1px solid rgba(255,255,255,.22);
  box-shadow: 0 8px 24px rgba(0,0,0,.45);
  color: #fff;
  font: 600 14px/1.25 system-ui, -apple-system, sans-serif;
  /* Hela strimman tar emot tryck, inte bara knapparna.
     pointer-events:none lät trycket gå igenom till det som låg under, och
     det som låg under var osynligt bakom strimman. En knapp man inte kan se
     men kan träffa är sämre än ingen knapp alls. */
  pointer-events: auto;
}
.pv-rost-fel[hidden] { display: none; }
.pv-rost-fel-ikon { font-size: 18px; line-height: 1; }
.pv-rost-fel-text { flex: 1; min-width: 0; }
.pv-rost-fel-fix, .pv-rost-fel-stang {
  pointer-events: auto;
  flex: none;
  border: 0; border-radius: 10px;
  background: rgba(255,255,255,.94); color: #5c1b1b;
  font: 700 13px/1 system-ui, -apple-system, sans-serif;
  /* 44px är minsta träffyta som går att träffa i en bil i rörelse. */
  min-height: 40px; padding: 0 12px;
}
.pv-rost-fel-stang {
  background: rgba(255,255,255,.16); color: #fff;
  min-width: 40px; padding: 0 10px; font-size: 18px;
}
@media (prefers-reduced-motion: no-preference) {
  .pv-rost-fel { animation: pvRostIn .22s ease-out; }
  @keyframes pvRostIn { from { transform: translateY(8px); opacity: 0; } }
}`;
  document.head.appendChild(stil);

  const nod = document.createElement('div');
  nod.id = ROST_FEL_ID;
  nod.className = 'pv-rost-fel';
  nod.hidden = true;
  // role=status och inte alert: den ska läsas upp av skärmläsaren utan att
  // avbryta något, precis som den inte får avbryta körningen.
  nod.setAttribute('role', 'status');
  nod.setAttribute('aria-live', 'polite');

  const ikon = document.createElement('span');
  ikon.className = 'pv-rost-fel-ikon';
  ikon.setAttribute('aria-hidden', 'true');
  ikon.textContent = '🔇';

  const text = document.createElement('span');
  text.className = 'pv-rost-fel-text';

  const fix = document.createElement('button');
  fix.type = 'button';
  fix.className = 'pv-rost-fel-fix';
  fix.textContent = 'Slå på rösten';
  // Trycket ÄR gesten. Därför ligger allt arbete synkront i hanteraren och
  // inte i en timer — en gest som hunnit dö låser inte upp någonting.
  fix.addEventListener('click', slappFramRosten);

  const stang = document.createElement('button');
  stang.type = 'button';
  stang.className = 'pv-rost-fel-stang';
  stang.setAttribute('aria-label', 'Dölj');
  stang.textContent = '×';
  stang.addEventListener('click', () => {
    // Ett tryck på × är också en gest, så vi passar på. Föraren som stänger
    // rutan kan mycket väl ha löst problemet i samma rörelse.
    lasUppLjud();
    doljRostFel();
  });

  nod.append(ikon, text, fix, stang);
  document.body.appendChild(nod);
  rostFelNod = nod;
  return nod;
}

/**
 * Visa att rösten inte kommer fram.
 *
 * @param {string} text
 * @param {{genast?:boolean}} opts genast = en varning har REDAN missats, vänta
 *        inte. Utan flaggan dröjer strimman några sekunder, så ett startfel
 *        som löser sig vid nästa tryck aldrig hinner blinka förbi.
 */
/*
 * En gång per session, inte en gång per varning.
 *
 * Rutan restes från vakthunden som utlöses varje gång en yttring inte startar.
 * Kommer två varningar in efter varandra på en telefon där rösten ännu inte
 * är upplåst restes den alltså två gånger, och ägaren fick godkänna samma sak
 * om igen. Hans ord: "det ska väl bara komma upp en gång".
 *
 * Han har rätt, och det är värre än irriterande: en ruta som kommer tillbaka
 * efter att man svarat på den lär föraren att svaret inte spelar någon roll.
 * Nästa gång trycker han bort den utan att läsa, och då är den värdelös
 * precis när den behövs.
 *
 * Flaggan nollställs när rösten faktiskt talar (markeraRostKlar) — löser sig
 * problemet är rutan relevant igen om det återkommer, men inte förrän dess.
 */
let rostFelVisad = false;

/** Kallas när rösten bevisligen låtit. Då får rutan komma tillbaka en gång till. */
export function nollstallRostFelRuta() { rostFelVisad = false; }

function visaRostFel(text, { genast = false } = {}) {
  if (typeof document === 'undefined') return;
  if (rostFelVisad) return;
  clearTimeout(rostFelTimer);
  const visa = () => {
    if (rost.lage === 'klar') return;      // löste sig under tiden
    const nod = byggRostFelNod();
    if (!nod) return;
    rostFelVisad = true;
    nod.querySelector('.pv-rost-fel-text').textContent = text;
    nod.hidden = false;
  };
  if (genast) visa();
  else rostFelTimer = setTimeout(visa, ROST_FEL_DROJ_MS);
}

function doljRostFel() {
  clearTimeout(rostFelTimer);
  if (rostFelNod) rostFelNod.hidden = true;
}

/**
 * Ett HÖRBART prov, direkt i förarens tryck.
 *
 * Går medvetet förbi Speaker-kön. Är kön det som fastnat hjälper det inte att
 * ställa sig sist i den — och det här yttrandet ska bevisa en enda sak: att
 * talsyntesen kan låta just nu. Hör föraren meningen är frågan besvarad utan
 * att någon behöver läsa en diagnosrad.
 */
function provaRostHogt(text) {
  if (!voiceOutputSupported) {
    visaRostFel('Den här webbläsaren kan inte läsa upp text.', { genast: true });
    return;
  }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'sv-SE';
    u.rate = 1.05;
    u.volume = 1;
    let avgjort = false;
    const vakt = setTimeout(() => {
      if (avgjort) return;
      avgjort = true;
      markeraRostNekad('provrost-startade-aldrig');
      visaRostFel('Rösten svarar men hörs inte. Stäng appen helt och öppna den igen.', { genast: true });
    }, ROST_START_FRIST_MS + ROST_RADDNING_MS);
    u.onstart = () => {
      if (avgjort) return;
      avgjort = true;
      clearTimeout(vakt);
      markeraRostKlar('provrost-startade');
    };
    u.onerror = e => {
      if (avgjort) return;
      avgjort = true;
      clearTimeout(vakt);
      markeraRostNekad('provrost-nekades:' + (e?.error || 'okant'));
      visaRostFel('Webbläsaren släpper inte fram rösten. Tryck igen.', { genast: true });
    };
    speechSynthesis.speak(u);
  } catch {
    markeraRostNekad('provrost-kastade');
  }
}

/** Knappen i strimman: nollställ allt som gett upp och prova på riktigt. */
function slappFramRosten() {
  rost.forsok = 0;
  ljudlas.forsokt = 0;
  rost.lage = 'inte-forsokt';
  haLjudkontext();
  stadaZombiekO();
  for (const t of levandeTalare) t.uppdateraRost();
  provaRostHogt('Rösten är på.');
  lyssnaEfterGest();
}

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

/* ------------------------------------------------------------------ */
/* Varningsljudet                                                      */
/* ------------------------------------------------------------------ */
//
// LÄS DET HÄR INNAN DU FÖRSÖKER GÖRA PUSH-NOTISEN LJUDLIG.
//
// Allt nedanför gäller när appen är ÖPPEN. Bara då äger vi högtalaren, och
// bara då kan vi bestämma hur en varning låter.
//
// En webbpush med STÄNGD app kan inte bära ett eget ljud. Notification-API:ts
// sound-fält är dött i alla webbläsare som räknas, och på iPhone finns det
// inte ens på pappret: en webbpush spelar telefonens systemljud för notiser,
// punkt slut. sw.js kan skicka title, body, icon, badge, tag och data — det
// finns inget fält att lägga ett ljud i, och inget knep runt det. Det går
// alltså INTE att:
//   • skicka med en ljudfil i pushen,
//   • starta Web Audio från service workern (den har ingen AudioContext),
//   • hålla en tyst ljudslinga igång i bakgrunden för att "ta över" ljudet
//     (iOS stoppar den så fort appen lämnar förgrunden, och Android dödar
//     den när batterisparläget slår till).
// Den som vill ändra ljudet för en stängd app får bygga en riktig app till
// App Store. Lägg inte tid på det här igen om ett halvår.
//
//
// VARFÖR DET GAMLA LJUDET INTE DUGDE
//
// Två rena sinustoner, 1046 → 784 Hz, 270 ms, toppnivå 0,22 rakt in i
// destination. Tre fel på en gång:
//
//   1. För svagt. Klickljuden i ljud.js toppar på 0,45 × 0,75 = 0,3375 — ett
//      knapptryck lät alltså STARKARE än en polisvarning. Se kommentaren på
//      ljud.js:219.
//   2. Fel riktning. Tonerna FÖLL. Ett fallande intervall läser örat som
//      "klart, avslutat". En varning ska luta framåt, inte avrundas.
//   3. Ingen kropp. En ren sinus har all sin energi på en enda frekvens.
//      Hamnar just den frekvensen i en dal i kupéns rumsakustik, eller under
//      en gitarr i musiken som spelar, försvinner hela ljudet.
//
//
// TALEN, OCH VARFÖR JUST DE
//
// Frekvensfönstret 1100–1600 Hz (grundtonerna nedan).
//   Under 500 Hz ligger allt som bullrar i en bil: motor, däck, vind — och
//   det mesta av musikens energi. Dessutom orkar en telefonhögtalare knappt
//   producera något där; membranet är för litet. Över ~4 kHz börjar örat
//   tappa känslighet igen och billiga högtalare blir gälla. 1–2 kHz är där
//   örat är känsligast (samma band som talets konsonanter) och där kupén är
//   som tystast. Därför ligger grundtonerna där, och deras övertoner lägger
//   sig i 2–5 kHz där det också är rent.
//
// Övertoner 1 : 0,45 : 0,22 (grundton, oktav, kvint över oktaven).
//   Det här är skillnaden mellan "pip" och "signal". Tre partialer ger ljudet
//   en kropp som liknar ett blåsinstrument eller en tågsignal — något gjort
//   av metall, inte av en leksak. Lika viktigt: energin ligger nu på tre
//   frekvenser i stället för en, så en dal i kupéakustiken eller en ton i
//   musiken kan inte äta upp hela ljudet. Fyrkantvåg övervägdes och valdes
//   bort — den har övertoner ända upp i diskanten och låter billig och
//   sprucken i en telefonhögtalare, alltså precis "leksak".
//
// Attack 4 ms på varningen.
//   Örat känner igen ett ljud på anslaget. 4 ms är hårt nog att låta som ett
//   anslag och mjukt nog att inte knäppa i högtalaren (under ~2 ms hörs ett
//   klick från själva hoppet i vågformen). Kvittensen har 16 ms — mjukt,
//   rundat, uppenbart en annan sorts ljud redan i första hundradelen.
//
// Tre pulser, 105 ms mellan anslagen (~9,5 Hz pulstakt).
//   Ett pulsat ljud läses som varning, ett utdraget som besked. Det är därför
//   varenda riktig varningssignal pulsar. Två korta och en längre gör att
//   identiteten sitter redan i puls ett och två — alltså inom en tiondels
//   sekund, vilket var kravet — medan puls tre bär tonhöjdslyftet.
//
// Kvart uppåt, 1175 → 1568 Hz (D6 → G6).
//   Uppåt = något närmar sig, något ska hända. Kvarten är dessutom det mest
//   igenkännbara "kalla på någon"-intervallet vi har (samma som en signalhorn
//   fanfar). Nedåt sparas åt kvittensen — se ack nedan.
//
// Total längd 350 ms.
//   Inte en slump: alerts.js pling:ar och lägger sedan uppläsningen i en
//   setTimeout på 380 ms. Ljudet måste alltså vara HELT slut före 380 ms,
//   annars ligger svansen kvar under första ordet och äter det. 350 ms ger
//   30 ms marginal. Ändras 380 i alerts.js måste det här talet följa med.
//   Ingen efterklang, ingen svans: en varning ska sluta tvärt så rösten får
//   rent bord.
//
// Toppnivå 0,90 för varningen mot 0,26 för kvittensen.
//   Varningen ska höras genom motorljud och musik. 0,90 är 12 dB över det
//   gamla 0,22 och 8,5 dB över klickljuden i ljud.js — nu är rangordningen
//   äntligen den rätta: varning > knapptryck > kvittens. Avståndet ner till
//   kvittensen är 11 dB, alltså mer än dubbelt så starkt upplevt. 0,90 och
//   inte 1,0 för att lämna plats åt förarens huvudvolym; begränsaren sist i
//   kedjan fångar det som ändå råkar gå över.
//
//
// ALERT MOT ACK — SEX SAKER SKILJER DEM ÅT
//
//   register  hög (1175/1568 Hz)      mot  låg (587/784 Hz), en oktav under
//   form      tre hårda pulser        mot  en enda sammanhängande ton
//   attack    4 ms, ett anslag        mot  16 ms, ett mjukt insvep
//   riktning  kvart UPPÅT             mot  ett litet lyft på slutet
//   klang     tre partialer, metall   mot  nästan ren sinus, rund
//   nivå      0,80                    mot  0,30
//
// Sex skillnader samtidigt, inte en. Ett enda kännetecken kan drunkna i
// vägbuller; sex kan det inte. Föraren behöver aldrig titta.
//
//
// UPPMÄTT (OfflineAudioContext, 48 kHz, förval ljudVolym 0,75, volume 1)
//
//   alert   topp 0,738   RMS 0,325   3 pulser   sista ljudet vid 348 ms
//   ack     topp 0,204   RMS 0,105   1 puls     sista ljudet vid 189 ms
//   listen  topp 0,182   RMS 0,083   2 pulser   sista ljudet vid 158 ms
//
// Ingenting klipper, inte ens med alla reglage i botten (topp 0,82 vid
// ljudVolym 1). Varningen ligger 11 dB över kvittensen och 10,5 dB över det
// gamla plinget. Ändrar du ett tal: mät om, klipp inte, och håll dig under
// 380 ms — annars äter svansen första ordet i uppläsningen.

/** Nyckeln app.js sparar sina inställningar under. Vi LÄSER bara. */
const APP_INSTALLNINGAR_NYCKEL = 'pv.settings.v1';

/**
 * Förarens ljudinställningar.
 *
 * Varför localStorage och inte ett anrop från app.js: app.js bygger sin egen
 * Ljud-instans och skickar inställningar dit, men Speaker skapas innan
 * inställningarna är lästa och får dem aldrig. Att lägga till en väg in hade
 * krävt en ändring i app.js, och den filen ägs av någon annan. Läsningen är
 * billig (ett par gånger i minuten på sin höjd) och helt utan biverkningar.
 * Saknas nyckeln — första starten, privat läge — gäller förvalen.
 */
function ljudInstallningar() {
  const forval = { ljudPa: true, ljudVolym: 0.75, volume: 1 };
  try {
    const s = JSON.parse(localStorage.getItem(APP_INSTALLNINGAR_NYCKEL) || '{}') || {};
    const tal = (v, f) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : f;
    };
    return {
      ljudPa: s.ljudPa !== false,
      ljudVolym: tal(s.ljudVolym, forval.ljudVolym),
      volume: tal(s.volume, forval.volume),
      // Vilken av varningsvarianterna föraren valt. Okänt värde faller
      // tillbaka på förvalet i valjVarningsrecept() — en trasig inställning
      // ska aldrig kunna göra varningen tyst.
      varningsljud: typeof s.varningsljud === 'string' ? s.varningsljud : 'tydlig',
    };
  } catch {
    return forval;
  }
}

/**
 * Recepten.
 *
 *   niva        toppnivå för hela ljudet, före förarens volym
 *   attack      anslagstid i sekunder
 *   slapp       avklingning i sekunder, räknas in i pulsens langd
 *   partialer   relativa styrkor för grundton, oktav, kvint-över-oktav
 *   pulser      { f, f2?, vid, langd, niva } — vid och langd i sekunder
 *   granssnitt  true = ett ljud föraren själv utlöste, lyder "Ljud när du
 *               trycker". false = en varning om verkligheten utanför
 *               vindrutan, och den stängs inte av av ett reglage för klick.
 */
const LJUDRECEPT = {
  // Polis, kontroll eller kamera framför. Se hela resonemanget ovanför.
  /*
   * TRE VARIANTER, och skälet är att jag inte kan höra dem.
   *
   * Den första versionen — tre pulser på 75, 75 och 140 ms kring 1175 Hz —
   * beskrevs av ägaren som "ett ynkligt pip", och han har rätt: 350 ms totalt
   * i ett tunt högt register låter som en avisering från en app, inte som en
   * varning från något som ska rädda ett körkort.
   *
   * VAD SOM GÖR ETT LJUD ALLVARLIGT UTAN ATT SKRÄMMA — det är inte volym:
   *
   *   LÄNGD. Ett kort pip läses som "en notis kom in". Runt en sekund läses
   *   som "lyssna nu". Det är den enskilt största skillnaden.
   *
   *   VÄXLING mellan två toner. Ett stillastående ljud smälter in i
   *   motorljudet; en växling gör det omöjligt att sluta höra. Det är därför
   *   varenda utryckningssignal i Europa växlar mellan två toner.
   *
   *   MJUKARE ATTACK, inte hårdare. En attack på 4 ms är ett knäpp, och ett
   *   knäpp är precis det som får någon att rycka till bakom ratten. 12-18 ms
   *   ger samma tydlighet utan skräcken.
   *
   *   REGISTER kring 700-1000 Hz. Örat är känsligast där, och det ligger
   *   ovanför bilens egen lågfrekventa gröt utan att bli vasst.
   *
   * Vilken av de tre som är rätt går inte att resonera sig fram till — den
   * ska höras i en bil i 90 km/h med musik på. Därför väljer föraren själv,
   * och 'tydlig' är förvalet.
   */

  // TYDLIG (förval). Två toner som växlar tre gånger, som en perrongsignal.
  // 840 ms totalt. Går inte att missa, går inte att rycka till av.
  alert: {
    niva: 0.95,
    attack: 0.014,
    slapp: 0.070,
    partialer: [1, 0.50, 0.28, 0.12],
    granssnitt: false,
    pulser: [
      { f: 784, vid: 0.000, langd: 0.170, niva: 0.92 },
      { f: 988, vid: 0.190, langd: 0.170, niva: 1.00 },
      { f: 784, vid: 0.380, langd: 0.170, niva: 0.92 },
      { f: 988, vid: 0.570, langd: 0.270, niva: 1.00 },
    ],
  },

  // LUGN. Samma figur men mörkare, mjukare och kortare. För den som tycker
  // att förvalet är för mycket i en tyst kupé.
  alertLugn: {
    niva: 0.72,
    attack: 0.022,
    slapp: 0.110,
    partialer: [1, 0.30, 0.12],
    granssnitt: false,
    pulser: [
      { f: 659, vid: 0.000, langd: 0.190, niva: 0.90 },
      { f: 831, vid: 0.215, langd: 0.300, niva: 1.00 },
    ],
  },

  // KRAFTIG. Fyra växlingar, högre register, mer övertoner. För lastbil,
  // dåligt ljudisolerad kupé eller den som kör med musiken uppe.
  // Fortfarande 16 ms attack — kraftig betyder tätare och ljusare, aldrig
  // ett hårdare anslag.
  alertKraftig: {
    niva: 1.00,
    attack: 0.016,
    slapp: 0.055,
    partialer: [1, 0.62, 0.40, 0.24, 0.12],
    granssnitt: false,
    pulser: [
      { f: 880, vid: 0.000, langd: 0.145, niva: 0.95 },
      { f: 1175, vid: 0.160, langd: 0.145, niva: 1.00 },
      { f: 880, vid: 0.320, langd: 0.145, niva: 0.95 },
      { f: 1175, vid: 0.480, langd: 0.145, niva: 1.00 },
      { f: 880, vid: 0.640, langd: 0.145, niva: 0.95 },
      { f: 1175, vid: 0.800, langd: 0.260, niva: 1.00 },
    ],
  },

  /*
   * Kvittens på något föraren själv gjorde: rapporten gick fram.
   *
   * En enda mjuk ton som lyfter från 587 till 784 Hz. Lyftet finns för att
   * ett fallande slut hade låtit som ett fel — ljud.js 'fel' faller, och två
   * ljud som båda faller i mörkt register går inte att hålla isär i en bil.
   * Lyftet är litet med flit: en kvart som glider är inte samma sak som en
   * kvart som hoppar, och det är hoppet som är varningens signatur.
   *
   * Nästan ren sinus (andra partialen på 0,10) för att göra den rund och
   * ofarlig. Det är motsatsen till varningens metall.
   */
  ack: {
    niva: 0.26,
    attack: 0.016,
    slapp: 0.090,
    partialer: [1, 0.10],
    granssnitt: true,
    pulser: [
      { f: 587, f2: 784, vid: 0.000, langd: 0.230, niva: 1.00 },
    ],
  },

  /*
   * Mikrofonen slogs på eller av. Två snabba steg uppåt i mellanregistret,
   * lågt satt: det här är ett kvitto på ett knapptryck, inte en varning, och
   * det kommer ofta flera gånger under en körning.
   */
  listen: {
    niva: 0.24,
    attack: 0.008,
    slapp: 0.040,
    partialer: [1, 0.15],
    granssnitt: true,
    pulser: [
      { f: 660, vid: 0.000, langd: 0.070, niva: 0.90 },
      { f: 990, vid: 0.070, langd: 0.100, niva: 1.00 },
    ],
  },
};

const SLUT_NIVA = 0.0001;     // exponentiella ramper kan inte gå till noll
const LOOKAHEAD_S = 0.006;    // så första samplet inte kapas av schemaläggaren

/**
 * Kedjan: toner → volym → lågpass → begränsare → högtalare.
 *
 * Lågpasset på 7 kHz tar bort det gälla i tredje partialen på billiga
 * telefonhögtalare utan att röra det som bär ljudet (1–5 kHz).
 *
 * Begränsaren är ett skyddsnät, inte en effekt. Den finns för att tre
 * partialer i fas summerar till en topp som ligger nära 1,0, och för att
 * varningen kan råka spelas samtidigt som ett klickljud eller en röst — allt
 * summeras i destination, och en summa över 1,0 klipper. Ett klippt ljud
 * låter sprucket, inte starkt.
 *
 * TALEN, OCH EN FÄLLA SOM KOSTADE EN MÄTNING:
 *
 * DynamicsCompressorNode i Chrome lägger på en egen uppräkning (makeup gain)
 * som räknas fram ur tröskeln. Med tröskel −12 dB och 4:1 blir en svag signal
 * FYRA decibel STARKARE på väg ut — 0,20 in gav 0,33 ut, uppmätt. Det låter
 * bra tills man inser vad det gör med balansen: varningen (som ligger över
 * tröskeln) trycktes ner samtidigt som kvittensen (som ligger under) trycktes
 * upp, och skillnaden mellan dem krympte från 12 dB till 5. Hela poängen med
 * att de ska låta olika starkt gick förlorad i en nod som skulle "hjälpa".
 *
 * Därför ligger tröskeln nu på −1,5 dB med 12:1. Då gör noden ingenting alls
 * förrän signalen närmar sig taket, uppräkningen blir försumbar, och nivåerna
 * i recepten betyder exakt vad de säger. Attack 2 ms och knä 3 dB så att ett
 * anslag inte rundas av — anslaget är halva igenkänningen.
 *
 * En kedja per AudioContext, inte en per ljud: telefoner har tak på antalet
 * noder och contexten är delad med resten av appen.
 */
// ljudkedja deklareras högst upp i filen tillsammans med ljudCtx: den måste
// kunna nollställas när en död AudioContext byts ut, och det sker där.
function haLjudkedja(ctx) {
  if (ljudkedja && ljudkedja.ctx === ctx) return ljudkedja;
  const master = ctx.createGain();
  master.gain.value = 1;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 7000;
  const gransare = ctx.createDynamicsCompressor();
  try {
    gransare.threshold.value = -1.5;
    gransare.knee.value = 3;
    gransare.ratio.value = 12;
    gransare.attack.value = 0.002;
    gransare.release.value = 0.06;
  } catch { /* äldre motorer saknar en del av parametrarna */ }
  master.connect(lp).connect(gransare).connect(ctx.destination);
  ljudkedja = { ctx, master };
  return ljudkedja;
}

/**
 * Spela ett av ljuden ovan.
 *
 * @param {'alert'|'ack'|'listen'} sort
 * @param {{volym?:number, tvinga?:boolean, tystad?:boolean}} opts
 *        volym  = Speaker.volume, förarens huvudvolym (förval: inställningen)
 *        tvinga = provknappen. Går förbi både tystnad och "Ljud när du
 *                 trycker" — ett prov som inte låter bevisar ingenting.
 *        tystad = "Tyst i 15 minuter" är påslagen
 * @returns {{hordes:boolean, orsak:string}}
 */
/**
 * Vilket recept som ska spelas för en given sort.
 *
 * Bara 'alert' har varianter. Kvittensen och mikrofonpiket är kvitton på
 * knapptryck och ska låta likadant för alla — att låta föraren välja där vore
 * tre inställningar för noll nytta.
 *
 * Faller ALLTID tillbaka på LJUDRECEPT.alert. En inställning med ett värde
 * ingen känner igen — gammal app, halvskriven localStorage, framtida variant
 * som tagits bort — får göra ljudet till förvalet, aldrig till tystnad.
 */
/**
 * Hur länge man måste vänta efter plinget innan rösten får börja.
 *
 * DEN HÄR FUNKTIONEN FINNS FÖR ATT ETT MAGISKT TAL REDAN HAR KOSTAT EN NATT.
 *
 * Fram till 23 aug 2026 låg pausen som 380 hårdkodat i js/alerts.js och
 * js/app.js, avstämt mot ett pling som var 350 ms långt. Kommentaren i det
 * här filens LJUDRECEPT varnade uttryckligen: "Ändras 380 i alerts.js måste
 * det här talet följa med." Sedan byttes plinget mot ett på 840 ms — och
 * talet 380 rördes inte.
 *
 * Följden var att rösten började mitt i plinget. På en dator hörs det som en
 * grötig början; på en iPhone tystnar talet HELT, eftersom Web Audio och
 * speechSynthesis slåss om samma ljudväg. Ägaren hörde plinget och ingen
 * röst, i flera dygn, medan varje mätning på skrivbordet sa att allt
 * fungerade.
 *
 * Nu räknas pausen ur receptet som faktiskt spelas. Byter någon ljud igen
 * följer pausen med av sig själv, och det finns inget tal kvar att glömma.
 *
 * 120 ms marginal ovanpå: tillräckligt för att svansen ska dö ut helt, kort
 * nog att inte kännas som en paus i bilen.
 */
export function pausEfterPling(sort = 'alert', valt = null) {
  const r = valjRecept(sort, valt);
  const sist = r.pulser[r.pulser.length - 1];
  const langd = (sist.vid + sist.langd + r.slapp) * 1000;
  return Math.round(langd + 120);
}

export function valjRecept(sort = 'alert', valt = null) {
  if (sort !== 'alert') return LJUDRECEPT[sort] || LJUDRECEPT.alert;
  const namn = valt ?? ljudInstallningar().varningsljud;
  if (namn === 'lugn') return LJUDRECEPT.alertLugn;
  if (namn === 'kraftig') return LJUDRECEPT.alertKraftig;
  return LJUDRECEPT.alert;
}

export function spelaVarningsljud(sort = 'alert', opts = {}) {
  // opts.variant låter provknapparna spela en BESTÄMD variant utan att först
  // spara den — man ska kunna höra alla tre efter varandra och sedan välja.
  const recept = valjRecept(sort, opts.variant ?? null);
  const inst = ljudInstallningar();
  const tvinga = !!opts.tvinga;

  /*
   * Grindarna, i den ordning de biter.
   *
   * Den gamla chime() hade inga alls: den spelade även med uppläsningen
   * avslagen och mitt under "Tyst i 15 minuter". Det gick att leva med när
   * ljudet var svagare än ett knapptryck. Med ett ljud som är byggt för att
   * höras genom motorljud går det inte — den som tystat appen ska inte
   * plötsligt få ett STARKARE ljud i örat än förut.
   */
  if (!tvinga && opts.tystad) return { hordes: false, orsak: 'appen-tystad' };

  /*
   * "Ljud när du trycker" (ljudPa) stänger av kvittenserna men INTE
   * varningen. Reglaget heter det det heter i gränssnittet — det handlar om
   * klickljud — och en polisvarning som tystnar för att någon slog av
   * knappljuden är exakt den tysta app som hela filen finns för att
   * förhindra. Varningen lyder volymen, inte strömbrytaren för klick.
   */
  if (!tvinga && recept.granssnitt && !inst.ljudPa) {
    return { hordes: false, orsak: 'granssnittsljud-av' };
  }

  const ctx = haLjudkontext();
  if (!ctx) return { hordes: false, orsak: 'ingen-ljudmotor' };

  /*
   * Förarens volym.
   *
   * Kvittenser följer ljudVolym rakt av — de får gärna bli tysta.
   * Varningen får ett golv: ljudVolym 0 sänker den till 60 %, inte till
   * ingenting. Skälet är detsamma som ovan. Vill man ha tyst finns "Tyst i
   * 15 minuter", som är ett medvetet och tidsbegränsat val, till skillnad
   * från en slider som råkade hamna längst ner.
   */
  const huvudvolym = Number.isFinite(opts.volym) ? Math.min(1, Math.max(0, opts.volym)) : inst.volume;
  const installningsvolym = recept.granssnitt
    ? inst.ljudVolym
    : 0.6 + 0.4 * inst.ljudVolym;
  const niva = recept.niva * huvudvolym * installningsvolym;
  if (niva <= SLUT_NIVA * 4) return { hordes: false, orsak: 'volym-noll' };

  // Summan av partialerna normaliseras, annars skulle tre toner i fas ge tre
  // gånger den nivå receptet säger — och kompressorn skulle jobba sig svettig
  // på ett problem vi själva skapade.
  const summa = recept.partialer.reduce((a, b) => a + b, 0) || 1;

  /*
   * En suspenderad context hörs inte: tonerna schemaläggs mot en klocka som
   * står stilla. haLjudkontext() har redan bett om resume, men svaret kommer
   * först efter att den här funktionen är klar. Vi spelar ändå — hinner den
   * vakna hörs det — och bokför sanningen så en tyst app går att felsöka.
   */
  const upplast = ctx.state === 'running';

  try {
    const { master } = haLjudkedja(ctx);
    const t0 = ctx.currentTime + LOOKAHEAD_S;

    for (const puls of recept.pulser) {
      const start = t0 + puls.vid;
      const slut = start + puls.langd;
      const slappStart = Math.max(start + recept.attack + 0.001, slut - recept.slapp);
      const topp = niva * (puls.niva ?? 1);

      recept.partialer.forEach((del, i) => {
        const styrka = (topp * del) / summa;
        if (styrka <= SLUT_NIVA) return;
        const n = i + 1;

        const o = ctx.createOscillator();
        const g = ctx.createGain();
        // Sinus per partial, inte en färdig sågtand: då bestämmer vi själva
        // exakt hur mycket av varje överton som får vara med. En sågtand hade
        // tagit med allt ända upp i diskanten.
        o.type = 'sine';
        o.frequency.setValueAtTime(puls.f * n, start);
        if (puls.f2) o.frequency.exponentialRampToValueAtTime(puls.f2 * n, slut);

        g.gain.setValueAtTime(SLUT_NIVA, start);
        g.gain.exponentialRampToValueAtTime(styrka, start + recept.attack);
        g.gain.setValueAtTime(styrka, slappStart);
        g.gain.exponentialRampToValueAtTime(SLUT_NIVA, slut);
        g.gain.setValueAtTime(0, slut + 0.004);

        o.connect(g).connect(master);
        // Nod-städning: utan disconnect ligger de kvar tills contexten dör,
        // och appen kan plinga hundratals gånger under en körning.
        o.onended = () => { try { o.disconnect(); g.disconnect(); } catch {} };
        o.start(start);
        o.stop(slut + 0.02);
      });
    }
  } catch {
    return { hordes: false, orsak: 'fel-i-ljudmotorn' };
  }

  return { hordes: upplast, orsak: upplast ? 'ok' : 'ljudet-inte-upplast' };
}

/** Hur länge ett ljud låter, i millisekunder. Provknappen väntar ut det. */
export function varningsljudLangdMs(sort = 'alert') {
  const r = LJUDRECEPT[sort] || LJUDRECEPT.alert;
  return Math.round(1000 * r.pulser.reduce((m, p) => Math.max(m, p.vid + p.langd), 0));
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
    /*
     * Avslutaren för yttrandet som är i luften just nu, satt av #drain().
     *
     * Finns för att en cancel() ska kunna stänga ned yttrandet ordentligt i
     * stället för att lita på ett onerror som WebKit ofta inte skickar. Se
     * #avslutaAvbrutet().
     */
    this.avslutaPagaende = null;
    this.muteUntil = 0;
    this.onSpeakingChange = () => {};
    // Bokföring av tystnad. ljud.js har haft det här länge för
    // gränssnittsljuden; varningsvägen svalde allt i tomma catch-block, och då
    // gick ett fältfel inte att felsöka i efterhand.
    this.senasteLjud = null;
    this.tystnader = 0;
    /*
     * De sista bokförda ljudhändelserna, nyast först.
     *
     * senasteLjud ensam räckte inte: den skrivs över av nästa händelse, och
     * det som behövde besvaras var "vad hände de senaste minuterna" — plingade
     * det utan att rösten följde, startade yttrandet, hur länge dröjde det.
     * Fem poster är nog för att se ett mönster och lite nog att aldrig växa.
     */
    this.rostHistorik = [];
    /** När talsyntesen senast bevisligen BÖRJADE tala (onstart). */
    this.senasteTalStart = 0;
    /** När det senaste varningsplinget spelades — se #vaktaAttRostenFoljer. */
    this.senasteAlertPling = 0;
    this.plingVakt = null;
    this.startVakt = null;
    this.langdVakt = null;
    this.duckVakt = null;
    /*
     * Vilket yttrande som är det aktuella.
     *
     * Räknaren finns för att en avbruten uppläsning har handlare och
     * vakthundar kvar i luften. cancel() gör inte onerror synkron: den kommer
     * en bit senare, och då kan nästa yttrande redan ha startat. Utan
     * räknaren skulle den gamla handlaren nollställa this.speaking mitt i den
     * nya uppläsningen och driva kön ett steg för långt — alltså hoppa över
     * en varning, vilket är exakt det done() en gång skrevs för att undvika.
     */
    this.talGeneration = 0;
    levandeTalare.add(this);
    audioSession.background();
    if (voiceOutputSupported) {
      this.uppdateraRost();
      speechSynthesis.addEventListener?.('voiceschanged', () => this.uppdateraRost());
    }
  }

  #pickVoice() {
    const all = speechSynthesis.getVoices();
    return all.find(v => v.lang === 'sv-SE')
        || all.find(v => v.lang?.startsWith('sv'))
        || all.find(v => v.default)
        || null;
  }

  /**
   * Hämta röstlistan på nytt och välj om.
   *
   * Körs vid varje återkomst till förgrunden, inte bara vid 'voiceschanged'.
   * Ett SpeechSynthesisVoice-objekt som hämtades före ett bakgrundsläge kan på
   * Safari peka på en röst som inte längre finns — och då svarar speak() utan
   * att något hörs. Det är en av de få kända vägarna till exakt den tystnad
   * den här filen finns för att fånga.
   */
  uppdateraRost() {
    if (!voiceOutputSupported) return;
    try { this.voice = this.#pickVoice(); } catch { this.voice = null; }
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
    /*
     * Fyra vägar ut ur den här funktionen utan att ett ord sägs, och alla
     * fyra var tysta i dubbel bemärkelse: de lämnade inget spår. Två av dem
     * är förarens egna val och helt i sin ordning; två är fel. Skillnaden
     * gick inte att se i efterhand, och det var det som gjorde att en app som
     * plingade men aldrig talade inte gick att felsöka på distans.
     *
     * Nu bokförs alla fyra, med olika orsaker, och #vaktaAttRostenFoljer()
     * läser bokföringen för att avgöra om en tystnad efter ett pling är
     * förklarad eller ett fel.
     */
    if (!text) return;
    if (!voiceOutputSupported) { this.#bokforLjud('tal', false, 'ingen-talsyntes'); return; }
    if (!this.enabled) { this.#bokforLjud('tal', false, 'upplasning-avslagen'); return; }
    if (this.muted && (opts.priority ?? 1) < 2) { this.#bokforLjud('tal', false, 'tyst-lage'); return; }

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
      // Avsluta det pågående yttrandet ORDENTLIGT först. En naken cancel()
      // lämnade förut räknaren och vakthundarna hängande — se
      // #avslutaAvbrutet().
      this.#avslutaAvbrutet();
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

  /**
   * Hur länge ett yttrande rimligen kan hålla på.
   *
   * Behövs för att skilja "talar fortfarande" från "har hängt sig". En
   * svensk mening ligger kring 400–500 ms per ord vid rate 1,05; vi tar
   * rejält i, plus ett påslag för motorns egen starttid. Taket finns för att
   * en absurt lång sträng inte ska kunna låsa kön i en minut.
   */
  #rimligLangdMs(text) {
    const ord = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.min(45000, 5000 + ord * 900);
  }

  /**
   * Kortaste tid ett yttrande rimligen KAN ha låtit.
   *
   * Motsatsen till #rimligLangdMs: den satte ett tak för när något hängt sig,
   * den här sätter ett golv för när något aldrig lät. Används i u.onend för
   * att skilja en motor som hoppar över onstart men talar, från en motor som
   * tyst driver kön vidare utan ljud.
   *
   * 120 ms per ord är långt under verkligt uttal (400–500 ms per ord vid rate
   * 1,05). Golvet ska bara utesluta det omöjliga, inte det snabba.
   */
  #minimiLangdMs(text) {
    const ord = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(250, ord * 120);
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
    taltIGang++;
    audioSession.duck();   // sänk musiken, operativsystemet höjer tillbaka
    notifySpeaking(true, item.text);  // och stäng mikrofonen så vi inte hör oss själva
    this.onSpeakingChange(true);

    const skickadVid = Date.now();
    const gen = ++this.talGeneration;
    let avslutad = false;
    let startade = false;

    /*
     * Vakthundarnas timer-id hålls LOKALT och inte bara på this.
     *
     * En avbruten uppläsnings onerror kommer efter att nästa redan startat.
     * Läste städningen då this.startVakt hade den släckt efterföljarens
     * vakthund — och då hade den enda mekanism som upptäcker en hängd
     * talsyntes varit avstängd i just det yttrande som mest sannolikt hänger
     * sig. Kopian på this finns bara för att stop() ska nå dem; att rensa ett
     * id som redan gått ut är gratis.
     */
    let startVakt = null;
    let langdVakt = null;
    const rensaVakter = () => {
      clearTimeout(startVakt); startVakt = null;
      clearTimeout(langdVakt); langdVakt = null;
    };

    /**
     * @param {{dott?:boolean}} [lage] dott = motorn svarar inte, upprepa inte
     */
    const done = (lage = {}) => {
      // onend OCH onerror kan båda komma. Utan spärren skulle kön drivas två
      // steg framåt och en varning hoppas över.
      if (avslutad) return;
      avslutad = true;
      // Yttrandet är avgjort: ingen annan får avsluta det en gång till.
      if (this.avslutaPagaende === done) this.avslutaPagaende = null;
      rensaVakter();
      // Räknaren för yttranden i luften måste balanseras oavsett vad, annars
      // tror primaRosten() för alltid att appen talar.
      taltIGang = Math.max(0, taltIGang - 1);
      /*
       * Är det här en eftersläntrare från ett yttrande som redan avbrutits
       * slutar vi här. Talaren äger inte längre den pågående uppläsningen och
       * får inte röra vare sig speaking, kön eller mikrofonen.
       */
      if (gen !== this.talGeneration) return;
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
       *
       * Utom när motorn är död. Då hade upprepningen bara betytt ett nytt
       * varv i vakthunden varannan sekund, resten av körningen, och varje
       * varv hade bokfört en ny tystnad. En dörr som inte går att öppna ska
       * man inte fortsätta dra i.
       */
      const upprepa = item.kvar > 1 && !lage.dott;
      if (upprepa) {
        this.queue.unshift({ ...item, kvar: item.kvar - 1 });
        this.queue.sort((a, b) => b.priority - a.priority);
      }
      // Paus mellan gångerna. 120 ms räcker mellan olika meningar, men två
      // likadana i rad flyter ihop till en enda obegriplig ramsa.
      setTimeout(() => this.#drain(), upprepa ? 700 : 120);
    };

    /*
     * Handtaget som gör en cancel() ärlig.
     *
     * speechSynthesis.cancel() är inte en väg ut ur done(): WebKit levererar
     * inte tillförlitligt 'canceled' till det avbrutna yttrandet, och utan
     * onerror körs done() aldrig. Då läcker taltIGang, vakthundarna ligger
     * kvar och this.speaking kan stå på true för alltid. Både stop() och
     * interrupt-grenen i say() måste därför avsluta yttrandet SJÄLVA innan de
     * kallar cancel — det gör de genom det här handtaget.
     */
    this.avslutaPagaende = done;

    u.onstart = () => {
      /*
       * DET HÄR ÄR RADEN SOM SAKNADES.
       *
       * Bara onend var kopplad, och ett yttrande som tyst inte gör någonting
       * anropar varken onend eller onerror. Det gick alltså inte att skilja
       * "talade" från "gjorde ingenting" — vilket är hela skillnaden mellan
       * en app som varnar och en app som låtsas varna.
       *
       * onstart är dessutom det bästa beviset appen kan få på att rösten är
       * upplåst, bättre än något upplåsningsprov: det är en riktig varning
       * som faktiskt lät.
       */
      startade = true;
      clearTimeout(startVakt); startVakt = null;
      this.senasteTalStart = Date.now();
      markeraRostKlar('yttrande-startade');
      this.#bokforLjud('tal', true, 'startade', { drojdeMs: Date.now() - skickadVid });
    };

    u.onend = () => {
      const langdMs = Date.now() - skickadVid;

      /*
       * ETT YTTRANDE SOM TAR SLUT UTAN ATT HA BÖRJAT ÄR INTE 'ok'.
       *
       * Raden bokförde förut alltid hordes=true och orsak 'ok', även när
       * startade var false. Det är precis den tysta utgången filen finns för
       * att fånga: motorn svarade, kön drevs vidare, ingenting lät — och
       * ledgern kallade det ett lyckat ljud. Flaggan startade:false låg med i
       * posten men lästes av ingen, tystnaden räknades inte, och rost.lage
       * kunde stå kvar på 'klar' från ett tidigare yttrande, vilket i sin tur
       * blockerade plingvakthundens strimma.
       *
       * MÄTT: en talsyntes-stubb som skickar onend utan onstart gav
       * {"vad":"tal","hordes":true,"orsak":"ok","langdMs":13,"startade":false}.
       *
       * MEN: onstart är inte helt pålitligt heller. Vissa motorer hoppar över
       * det på mycket korta yttranden — primaRosten() räknar därför onend som
       * bevis för sitt punkt-yttrande. Att döma ut varje onend utan onstart
       * hade alltså kunnat sätta en fullt fungerande röst i 'nekad' för
       * evigt på en sådan motor, och då hade strimman legat uppe permanent.
       *
       * Tiden skiljer de två fallen åt. En mening som faktiskt SAGTS tar
       * minst ett par hundra millisekunder; de 13 ms ovan är inte en mening,
       * det är en kö som drevs vidare. Golvet är därför ordantal × 120 ms,
       * lägst 250 — rejält under vad ett riktigt uttal tar (400–500 ms per
       * ord vid rate 1,05) så en snabb men äkta röst aldrig döms ut.
       */
      const hordes = startade || langdMs >= this.#minimiLangdMs(item.text);
      this.#bokforLjud('tal', hordes, hordes ? 'ok' : 'slutade-utan-att-borja',
        { langdMs, startade });
      if (!hordes) {
        // Sätt rätt utgångsläge för vakthundarna och felstrimman: rösten är
        // INTE bevisat upplåst, hur gärna motorn än vill påstå det.
        markeraRostNekad('yttrande-slutade-utan-att-borja');
      }
      // dott när ingenting lät: en andra uppläsning av en mening motorn
      // sväljer ger bara ett varv till i tystnad.
      done({ dott: !hordes });
    };

    u.onerror = e => {
      /*
       * Hit kommer vi när talsyntesen vägrade. Det är den tystnad som gjorde
       * appen värdelös utan att synas: föraren tror att ingen varning fanns.
       * 'canceled' och 'interrupted' är vi själva (say med interrupt, eller
       * stop) och inget att bokföra som ett fel.
       */
      const fel = e?.error || 'okant';
      const vart = fel === 'canceled' || fel === 'interrupted';
      this.#bokforLjud('tal', vart, vart ? 'avbruten' : 'rosten-nekades:' + fel);
      if (!vart) markeraRostNekad('yttrande-nekades:' + fel);
      done({ dott: !vart });
    };

    /*
     * VAKTHUND ETT: startade yttrandet över huvud taget?
     *
     * Det klassiska iOS-läget efter ett bakgrundsläge är att speak() svarar
     * utan att något händer. Varken onstart, onend eller onerror kommer, och
     * this.speaking står kvar på true — då faller #drain() ur på första raden
     * för alltid, och varje senare say() fyller bara en kö som kapas till
     * fyra poster. Permanent tystnad, utan återhämtningsväg. Listener har
     * haft en vakthund för exakt det här sedan länge (se speakWatchdog); den
     * här sidan av filen hade ingen.
     *
     * Räddningsförsöket är speechSynthesis.resume(). En kö som bara är pausad
     * — vilket händer när iOS avbrutit ljudsessionen — vaknar av den. Hjälper
     * det inte inom ytterligare en knapp sekund ger vi upp yttrandet, städar
     * bort proppen och SÄGER TILL. Att tiga här vore att göra om samma fel
     * en gång till.
     */
    startVakt = this.startVakt = setTimeout(() => {
      if (avslutad || startade || gen !== this.talGeneration) return;
      try { speechSynthesis.resume(); } catch {}
      startVakt = this.startVakt = setTimeout(() => {
        if (avslutad || startade || gen !== this.talGeneration) return;
        this.#bokforLjud('tal', false, 'startade-aldrig', { drojdeMs: Date.now() - skickadVid });
        markeraRostNekad('yttrande-startade-aldrig');
        visaRostFel('Varningen lästes inte upp. Tryck för att slå på rösten.', { genast: true });
        try { speechSynthesis.cancel(); } catch {}
        done({ dott: true });
      }, ROST_RADDNING_MS);
    }, ROST_START_FRIST_MS);

    /*
     * VAKTHUND TVÅ: yttrandet startade, men tog aldrig slut.
     *
     * Samma propp, ett steg senare i förloppet, och lika förödande: kön
     * öppnar sig aldrig igen. Vi avbryter först när det gått längre än
     * meningen rimligen kan ta att säga, så en långsam röst aldrig klipps.
     */
    langdVakt = this.langdVakt = setTimeout(() => {
      if (avslutad || gen !== this.talGeneration) return;
      this.#bokforLjud('tal', false, 'slutade-aldrig', { langdMs: Date.now() - skickadVid });
      try { speechSynthesis.cancel(); } catch {}
      done({ dott: true });
    }, this.#rimligLangdMs(item.text));

    try {
      speechSynthesis.speak(u);
    } catch {
      this.#bokforLjud('tal', false, 'speak-kastade');
      markeraRostNekad('speak-kastade');
      done({ dott: true });
    }
  }

  /**
   * Bokför om ett ljud faktiskt hördes, och varför inte.
   *
   * Samma tanke som #beslut() i ljud.js: en app som är tyst ska kunna svara på
   * frågan varför, i efterhand, utan att någon sitter med en telefon i handen.
   */
  #bokforLjud(vad, hordes, orsak, extra = null) {
    if (!hordes) this.tystnader++;
    this.senasteLjud = { vad, hordes: !!hordes, orsak, tid: Date.now(), ...(extra || {}) };
    // Nyast först, aldrig mer än fem. Historiken finns för att kunna svara på
    // "plingade det utan att rösten följde?" i efterhand, utan att någon
    // sitter med telefonen i handen i rätt sekund.
    this.rostHistorik.unshift(this.senasteLjud);
    if (this.rostHistorik.length > 5) this.rostHistorik.length = 5;
    return this.senasteLjud;
  }

  /** Varför hördes (eller hördes inte) det senaste ljudet? */
  ljudDiagnos() {
    return {
      ...ljudlasStatus(),
      senaste: this.senasteLjud,
      tystnader: this.tystnader,
      historik: [...this.rostHistorik],
      rost: rostHalsa(),
      senasteTalStart: this.senasteTalStart,
      senasteAlertPling: this.senasteAlertPling,
    };
  }

  /**
   * Plinget spelades. Följde rösten efter?
   *
   * Det här är ägarens fall, ordagrant: "den här rösten måste ju också komma
   * med, inte bara pipande ljudet". Plinget och uppläsningen är två helt
   * skilda kedjor — Web Audio respektive speechSynthesis — och den ena kan
   * fungera perfekt medan den andra är död. Ingenting kopplade ihop dem, så
   * ett pling utan röst såg ut som ett lyckat pling.
   *
   * Nu startar varje varningspling en klocka. Har inget yttrande STARTAT
   * innan den går ut är tystnaden ett faktum, och den bokförs — och syns, om
   * den inte har en förklaring föraren själv valt.
   */
  #vaktaAttRostenFoljer() {
    clearTimeout(this.plingVakt);
    const plingVid = this.senasteAlertPling;
    this.plingVakt = setTimeout(() => {
      if (this.senasteTalStart >= plingVid) return;   // rösten kom, allt väl

      /*
       * Tre tystnader är förklarade och ska INTE larma:
       * uppläsningen avslagen, "Tyst i 15 minuter", och en webbläsare utan
       * talsyntes. Alla tre är förarens eget val eller enhetens gräns, och en
       * röd ruta vid varje varning för något föraren själv ställt in lär bara
       * ut att rutan är skräp. De bokförs ändå — en förklarad tystnad är
       * fortfarande en tystnad, och den ska gå att läsa av i efterhand.
       */
      const forklarad =
        !voiceOutputSupported ? 'ingen-talsyntes'
        : !this.enabled ? 'upplasning-avslagen'
        : this.muted ? 'tyst-lage'
        : '';

      this.#bokforLjud('pling-utan-rost', false, forklarad || ('rosten-kom-inte:' + rost.lage));
      if (forklarad) return;

      /*
       * markeraRostNekad FÖRE visaRostFel, och det är inte kosmetik.
       *
       * visaRostFel() börjar med `if (rost.lage === 'klar') return;`. Den
       * spärren är rätt för den fördröjda vägen — ett startfel som hann lösa
       * sig ska inte blinka förbi — men den är fel här: vi har just KONSTATERAT
       * tystnaden. rost.lage sätts till 'klar' av första yttrande som startar
       * och nollställs bara av markeraRostNekad() eller av en återkomst till
       * förgrunden, så efter att rösten fungerat en enda gång var strimman
       * permanent bortfiltrerad i exakt det fall den byggdes för.
       *
       * MÄTT: rösten läser en mening (lage=klar), sedan chime('alert') utan
       * att say() följer — alltså ruttvaktsgrenen i js/app.js, där plinget
       * redan spelats och say() aldrig anropas. Efter 3,3 s fanns
       * 'pling-utan-rost' i historiken, men felstrimmans nod hade aldrig ens
       * byggts. Föraren hörde plinget, fick ingen röst, och såg ingenting.
       *
       * markeraRostNekad rättar dessutom rost.lage och ljudlas.rost, så
       * ljudlasStatus() slutar påstå "Ljudet är upplåst" om en röst som inte
       * kom. Den kan visa sin egen, allmänna text först; raden under skriver
       * över den med den precisa och tar bort dess fördröjning.
       */
      markeraRostNekad('pling-utan-rost');
      visaRostFel('Plinget hördes men varningen lästes inte upp.', { genast: true });
    }, PLING_ROST_FRIST_MS);
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

    // Provknappen är ett fingertryck, alltså rätt tillfälle att låsa upp
    // ljudet om det inte redan skett. Ligger say() 380 ms bort är gesten död
    // när den körs — det var just därför provet inte kunde låsa upp rösten på
    // iOS, hur många gånger man än tryckte.
    lasUppLjud();

    /*
     * Ett prov som ljuger är värre än inget prov.
     *
     * Med "Läs upp varningar" avslaget spelades plinget, meningen skrevs ut i
     * rutan och say() föll igenom tyst på raden i say(). Det såg ut som att
     * provet gick igenom — och det är exakt den sak provet ska bevisa.
     */
    // tvinga: ett prov ska alltid höras, även med "Tyst i 15 minuter" på och
    // även med klickljuden avslagna. Samma skäl som i say-fallet nedan.
    if (!this.enabled) {
      this.chime(kind === 'report' ? 'ack' : 'alert', { tvinga: true, utanRost: true });
      return 'Läs upp varningar är avslaget, så det här är bara plinget. Slå på uppläsning för att höra hela varningen.';
    }
    if (!voiceOutputSupported) {
      this.chime(kind === 'report' ? 'ack' : 'alert', { tvinga: true, utanRost: true });
      return 'Den här webbläsaren kan inte läsa upp text, så varningar kommer bara som pling och text.';
    }

    const wasMuted = this.muteUntil;
    this.muteUntil = 0;                       // ett prov ska alltid höras
    this.chime(kind === 'report' ? 'ack' : 'alert', { tvinga: true });
    setTimeout(() => {
      this.say(text, { priority: 2, interrupt: true });
      this.muteUntil = wasMuted;
    }, 380);
    return text;
  }

  /**
   * Avsluta yttrandet som är i luften, för den som tänker kalla cancel().
   *
   * MÄTT LÄCKA (scratchpad-provbänk, riktig voice.js i node): rösten talar en
   * gång, talsyntesen börjar hänga, föraren trycker "Tyst i 15 minuter" →
   * speaker.stop() → speechSynthesis.cancel() svarar tyst, inget onerror
   * kommer, done() körs aldrig. taltIGang stod kvar på 1 genom pageshow,
   * bfcache och varje senare tryck, och appen svarade "Ljudet är upplåst"
   * resten av körningen medan talsyntesen var död.
   *
   * dott:true så det avbrutna yttrandet inte läggs tillbaka i kön för en
   * andra uppläsning — den som tystar appen vill inte höra meningen igen.
   */
  #avslutaAvbrutet() {
    const avsluta = this.avslutaPagaende;
    this.avslutaPagaende = null;
    if (avsluta) avsluta({ dott: true });
  }

  stop() {
    // Kön töms FÖRE avslutaren. done() lägger tillbaka en upprepning i kön
    // när item.kvar > 1, och även om dott:true redan hindrar det ska ordningen
    // inte vara det enda som håller.
    this.queue = [];
    // Balansera räknaren och släck vakthundarna innan cancel() nedan — se
    // #avslutaAvbrutet().
    this.#avslutaAvbrutet();
    this.queue = [];   // done() kan ha hunnit lägga tillbaka något
    // Generationen bumpas så att handlare och vakthundar från det avbrutna
    // yttrandet inte kan komma tillbaka och röra en ny uppläsning.
    this.talGeneration++;
    clearTimeout(this.startVakt); this.startVakt = null;
    clearTimeout(this.langdVakt); this.langdVakt = null;
    clearTimeout(this.plingVakt); this.plingVakt = null;
    clearTimeout(this.duckVakt); this.duckVakt = null;
    audioSession.background();   // stop() betyder tyst, alltså tillbaka musiken
    try { speechSynthesis.cancel(); } catch {}
    this.speaking = false;
    this.current = null;
    notifySpeaking(false);
    this.onSpeakingChange(false);
  }

  /**
   * Kort signal före en varning så föraren hinner lyssna.
   *
   * Själva syntesen ligger i spelaVarningsljud() på modulnivå. Skälet är inte
   * städning: provknappen i inställningarna behöver kunna spela exakt samma
   * ljud utan att hitta appens Speaker-instans, och två kopior av ett recept
   * är två recept som glider isär.
   *
   * @param {'alert'|'ack'|'listen'} kind
   * @param {{tvinga?:boolean, utanRost?:boolean}} opts
   *        tvinga   = prov, gå förbi tystnad
   *        utanRost = det här plinget står med flit ensamt, vakta inte rösten
   */
  chime(kind = 'alert', opts = {}) {
    const sort = kind === 'ack' ? 'ack' : kind === 'listen' ? 'listen' : 'alert';

    /*
     * Ljudsessionen höjs FÖRE plinget, inte 380 ms efter det.
     *
     * duck() satt tidigare först i #drain(), alltså efter uppläsningens
     * timer. Plinget spelades därmed alltid med sessionen kvar i 'ambient' —
     * kategorin som blandar sig i musiken och som iPhonens tystlägesreglage
     * dämpar. Varningens första och viktigaste ljud var alltså det enda som
     * inte fick företräde.
     *
     * Plinget och rösten är ETT meddelande. De ska ha samma ljudsession, och
     * den ska börja med plinget. Bekräftelser och mikrofonpip är däremot inga
     * meddelanden om verkligheten och får inte lägga sig över musiken.
     */
    if (sort === 'alert') {
      audioSession.duck();
      /*
       * Och ett skyddsnät: kommer ingen röst efter plinget skulle sessionen
       * annars ligga kvar i 'transient' och musiken stå nersänkt resten av
       * körningen. Samma resonemang som i kommentaren om 'transient-solo'
       * ovan — appen får aldrig lämna bilen i ett konstigt ljudläge för att
       * något gick fel hos oss.
       */
      clearTimeout(this.duckVakt);
      this.duckVakt = setTimeout(() => {
        if (!this.speaking && !this.queue.length) audioSession.background();
      }, PLING_ROST_FRIST_MS);
    }

    const svar = spelaVarningsljud(sort, {
      volym: this.volume,
      tystad: this.muted,
      tvinga: !!opts.tvinga,
    });
    // Kvar under sitt gamla namn: provbänkarna läser speaker._ctx.
    this._ctx = haLjudkontext({ skapa: false }) || this._ctx;

    /*
     * Ett varningspling som hördes är ett löfte om en mening. Klockan startar
     * här och kontrolleras i #vaktaAttRostenFoljer(): kommer ingen röst är
     * det ett fel som ska synas, inte en tystnad som ska sväljas.
     */
    if (sort === 'alert' && svar.hordes && !opts.utanRost) {
      this.senasteAlertPling = Date.now();
      this.#vaktaAttRostenFoljer();
    }
    return this.#bokforLjud('pling', svar.hordes, svar.orsak);
  }
}

/* ------------------------------------------------------------------ */
/* Provknappen i inställningarna                                       */
/* ------------------------------------------------------------------ */
//
// Kopplas härifrån och inte från app.js. Knappen gör en enda sak — spelar
// ljudet som definieras i den här filen — och då hör kopplingen hemma i
// samma fil som receptet. app.js är dessutom 6000 rader och ägs av någon
// annan.
//
// Provet går förbi tystnaden med flit: den som trycker på en knapp som heter
// "Spela varningsljudet" vill höra ljudet. Ett prov som tiger bevisar
// ingenting, och det var precis det felet demo() hade innan.

/*
 * Fjärde fältet är VARIANTEN, och bara varningen har en.
 *
 * Provknapparna spelar en bestämd variant utan att spara den. Att välja ljud
 * kräver att man hör alla tre efter varandra, och en väljare som sparar vid
 * varje tryck gör det omöjligt: man vet inte längre vilken som är vald när
 * man är klar. Väljaren sparar, knapparna bara spelar.
 */
const LJUDPROV_KNAPPAR = [
  ['btnProvaVarningsljud', 'alert', null,
    'Så låter varningen du har valt: polis, kontroll eller kamera framför dig.'],
  ['btnProvaLjudLugn', 'alert', 'lugn',
    'Lugn: två mörka toner, 0,5 sekunder. Minst av de tre.'],
  ['btnProvaLjudTydlig', 'alert', 'tydlig',
    'Tydlig: två toner som växlar tre gånger, 0,8 sekunder. Förvalet.'],
  ['btnProvaLjudKraftig', 'alert', 'kraftig',
    'Kraftig: sex växlingar, ljusare och tätare, 1,1 sekunder. För lastbil eller hög musik.'],
  ['btnProvaKvittensljud', 'ack', null,
    'Så låter en kvittens: din rapport gick fram. Mörkare, mjukare, tystare.'],
];

const LJUDPROV_FEL = {
  'ingen-ljudmotor': 'Den här enheten har ingen ljudmotor för webbsidor.',
  'ljudet-inte-upplast': 'Webbläsaren har inte släppt fram ljudet än. Tryck en gång till.',
  'fel-i-ljudmotorn': 'Ljudmotorn svarade inte. Ladda om sidan.',
  'volym-noll': 'Volymen står på noll.',
};

function kopplaLjudprov() {
  if (typeof document === 'undefined') return;
  for (const [id, sort, variant, text] of LJUDPROV_KNAPPAR) {
    const knapp = document.getElementById(id);
    if (!knapp || knapp.dataset.ljudprovKopplat === '1') continue;
    knapp.dataset.ljudprovKopplat = '1';
    knapp.addEventListener('click', () => {
      // Trycket ÄR gesten. Låser upp ljudet om det inte redan är gjort —
      // därför ligger anropet här och inte i en setTimeout, där gesten är död.
      lasUppLjud();
      const svar = spelaVarningsljud(sort, { tvinga: true, variant });
      const ruta = document.getElementById('provaLjudStatus');
      if (ruta) ruta.textContent = svar.hordes ? text : (LJUDPROV_FEL[svar.orsak] || 'Ljudet kom inte fram.');
    });
  }

  /*
   * Väljaren. Sparar i samma localStorage-nyckel som resten av appens
   * inställningar, och spelar det valda ljudet direkt — annars måste man
   * välja, leta upp provknappen och trycka, bara för att höra vad man valde.
   */
  const valjare = document.getElementById('setVarningsljud');
  if (valjare && valjare.dataset.ljudprovKopplat !== '1') {
    valjare.dataset.ljudprovKopplat = '1';
    try {
      valjare.value = ljudInstallningar().varningsljud;
    } catch { }
    valjare.addEventListener('change', () => {
      const val = valjare.value;
      try {
        const s = JSON.parse(localStorage.getItem(APP_INSTALLNINGAR_NYCKEL) || '{}') || {};
        s.varningsljud = val;
        localStorage.setItem(APP_INSTALLNINGAR_NYCKEL, JSON.stringify(s));
      } catch { }
      lasUppLjud();
      const svar = spelaVarningsljud('alert', { tvinga: true, variant: val });
      const ruta = document.getElementById('provaLjudStatus');
      if (ruta) {
        ruta.textContent = svar.hordes
          ? 'Sparat. Så här låter varningarna nu.'
          : (LJUDPROV_FEL[svar.orsak] || 'Sparat, men ljudet kom inte fram.');
      }
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kopplaLjudprov, { once: true });
  } else {
    kopplaLjudprov();
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
    /*
     * Utan platsKonvention, med flit. Facebook-gruppens regel "platsen ensam
     * betyder polis" gäller lappar i den gruppen, inte det mikrofonen hör.
     *
     * MÄTT 2026-08-22, innan flaggan fanns: parseReportText('Bäckby') gav
     * report/police 0,70. Föraren säger "nykterhetskontroll vid Bäckby",
     * igenkänningen tappar det långa ordet, och raden nedanför returnerar
     * tolkningen direkt — före tvåordsspärren och före alternativsökningen
     * där en vägran vinner över allt annat. Resultatet blev en polisnål för
     * det talaren sa var en nykterhetskontroll.
     */
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
