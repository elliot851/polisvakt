// Polisvakt — sammanfogning av alla delar.

import { shortDistance, relativeTime, debounce, normalize, isDark } from './util.js';
import { parseReportText, TYPE_LABEL, TYPE_ICON } from './parser.js';
import { GeoTracker, currentPosition } from './geo.js';
import { initGeocoder, geocode, reverseGeocode, learnPlace, listLearned, forgetPlace } from './geocode.js';
import { ReportStore, deviceId, setIdentity, isMine, TTL_MINUTES } from './store.js';
import { Speaker, Listener, voiceInputSupported, pausEfterPling } from './voice.js';
import { AlertEngine } from './alerts.js';
import { HazardMap } from './map.js';
import { Dashcam, dashcamSupported, fmtBytes, fmtDuration } from './dashcam.js';
import { Billing, PRICE_TEXT, TRIAL_DAYS } from './billing.js';
import * as Install from './install.js';
import { SpeedLimitService } from './speedlimit.js';
import { ImpactDetector, motionSupported, motionNeedsPermission } from './impact.js';
import { RemoteControl, ACTIONS, DEFAULT_BINDINGS } from './remote.js';
import { Stats } from './stats.js';
import { Reputation, REWARD_TOP_N } from './reputation.js';
import { qrToSVG } from './qr.js';
import { CONFIG, hasBackend, applyOverrides, setAccessToken, buildDate, apiHeaders } from './config.js';
import { Auth, validateUsername } from './auth.js';
import { Tour, seen as tourSeen, reset as resetTour } from './tour.js';
import { DrivingDetector, notificationsSupported } from './driving.js';
import { Coverage, MODES as COVERAGE_MODES } from './coverage.js';
import { PLANS, PREPAY, yearlyComparison } from './plans.js';
import { renderChain } from './roadmap.js';
import { RouteGuide } from './rutt.js';
import { WinterService } from './vinter.js';
import { Groups } from './groups.js';
import * as Behorigheter from './behorigheter.js';
import * as Push from './push.js';
import { larma } from './larm.js';
import * as Facebook from './facebook.js';
import { Vakthund } from './vakthund.js';
import { Varmevakt } from './varme.js';
import * as Kvalitet from './kvalitet.js';
import * as Betalning from './betalning.js';
import { PlateReader, plateSupported, visaPlat, normaliseraPlat, haFordonsregister, migreraKlartext } from './plate.js';
import { Chatt, UTAN_OMRADE_TEXT } from './chatt.js';
import { Ljud } from './ljud.js';
import * as Notiser from './notiser.js';
import * as Korvanor from './korvanor.js';
import { Navigering, tolkaOsrmRutt } from './navigering.js';
import { beskrivning, sammanfattaKort, sammanfattaTal, farBeskrivas } from './sammanfattning.js';
/*
 * Varningsytan importeras statiskt, inte med import().
 *
 * En dynamisk import hade överlevt att filen saknas, men den hade också
 * betytt att FÖRSTA varningen — den enda som spelar roll för den som just
 * installerat appen — får vänta på en nätverkshämtning mitt i det ögonblick
 * då rösten talar. Statiskt är modulen laddad innan appen ens säger hej.
 *
 * Priset är att ett fel i varningsyta.js tar hela app.js med sig. Det är
 * accepterat: räddningsnätet längst ned i index.html fångar exakt det fallet
 * och tvingar fram en ny hämtning, och en app som varnar utan att synas är
 * inte mindre trasig än en app som inte startar.
 */
import { visa as visaYtan, stang as stangYtan } from './varningsyta.js';
/*
 * Rörelsen i navigationen — vybyten, landningsringen, tryckkvittensen.
 *
 * Statisk import, till skillnad från inställningsmodulen längre ner. Skälet
 * är motsatsen till varningsytans: den här filen får inte laddas MITT I ett
 * vybyte. En dynamisk import hade betytt att de första trycken efter start
 * sker utan riktning, alltså precis de tryck där föraren fortfarande lär sig
 * var sakerna ligger. Filen är dessutom liten och har noll beroenden.
 */
import { Rorelse } from './rorelse.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'pv.settings.v1';

/* ================= Inställningar ================= */

const defaults = {
  /*
   * LJUDET ÄR PÅSLAGET FRÅN BÖRJAN, INTE AVSTÄNGT.
   *
   * Skälet är att blicken redan är upptagen. Den här appen används av någon
   * som kör bil, och en varning som bara ritas ut på en skärm i en hållare är
   * en varning som kommer fram efter att den behövdes. Örat är den enda kanal
   * som är ledig, och därför är det den som ska vara öppen som förval.
   *
   * Motargumentet — "låt användaren välja" — håller inte här. Den som stänger
   * av ljudet har valt, och det valet respekteras. Den som aldrig öppnat
   * inställningarna har inte valt tystnad, hen har bara inte tittat. Ett
   * förval som står på "av" gör tystnaden till normalläget och lägger arbetet
   * med att slå på skyddet på precis den person som ännu inte vet att skyddet
   * finns. Det är fel person att lägga det på.
   *
   * volume styr BÅDE uppläsningen och plinget (voice.js: 0.22 * volume).
   * Den ligger på 1 och har med flit inget reglage i gränssnittet: förarens
   * volymknapp sitter på telefonens sida och är redan ett bättre reglage än
   * något vi kan rita. En app som sänker volymen åt någon i förväg tystar sig
   * själv i en bil på E18 utan att någonstans säga att det var det som hände.
   *
   * rate påverkar bara tempot, inte om det hörs.
   */
  tts: true,
  volume: 1,
  rate: 1.05,
  hazardRadiusM: 1500,
  cameraLeadSeconds: 25,
  wakeWord: false,
  mode: 'local',
  supaUrl: '',
  supaKey: '',
  paymentLink: '',
  pollSeconds: 30,
  theme: 'auto',
  keepAwake: true,

  /*
   * Nedanför följer en familj av reglage som var för sig kan tysta EN sorts
   * varning: fartgränsen (limitOn/speedWarn), smällen (impactOn), de kända
   * platserna (hotspotVoice), körpausen (driveReminder), halkan och viltet
   * (winterOn), rutten (routeOn) och skyltläsarens pip (plPip). De står alla
   * på true av samma skäl som huvudreglaget ovan.
   *
   * Det är värt att säga rakt ut varför de inte börjar avstängda "för att
   * inte störa": var och en av dem är en egen tystnad, och tystnaderna syns
   * inte var för sig. Slås tre av dem av i förväg upplever föraren inte att
   * hen fått en lugnare app — hen upplever att appen missade tre saker.
   * Bruset går att klaga på och stänga av i efterhand. En varning som aldrig
   * kom går inte att sakna, för man vet inte om den.
   */
  limitOn: true,
  speedWarn: true,
  speedMargin: 7,
  remoteOn: false,
  bindings: { ...DEFAULT_BINDINGS },
  impactOn: true,
  impactLevel: 'normal',
  showHotspots: true,
  hotspotVoice: true,
  disclaimerAccepted: false,
  plan: 'plus',
  coverageMode: 'radius',
  coverageRadiusM: 30000,
  driveReminder: true,
  winterOn: true,
  routeOn: true,
  plRate: 700,
  plKrav: 2,
  plPip: true,
  plZoomLage: 'auto',
  /*
   * Gränssnittsljud och vibration är också på från början, men av ett annat
   * skäl än varningarna: de är kvittot på att ett tryck gick fram. Utan dem
   * trycker föraren en gång till på en knapp som redan lyssnade, och det är
   * ett tryck till med blicken nere.
   *
   * De konkurrerar inte med varningen — ljud.js får speaker med sig och
   * kliver undan medan något läses upp (se instansen längre ner). Därför
   * kostar påslaget ingenting i hörbarhet där det räknas.
   *
   * 0,75 och inte 1: klicken ska höras, inte höras mest.
   */
  ljudPa: true,
  ljudVolym: 0.75,
  // Vilken av de tre varningsvarianterna som spelas. Läses av js/voice.js,
  // som äger ljuden. Står här också så att appens övriga hantering av
  // inställningar inte råkar skriva bort nyckeln när den sparar hela objektet.
  varningsljud: 'tydlig',
  chattLastAt: 0,          // när chatten senast lästes, för antalet olästa
  morktLage: true,         // släck skärmen under körning när ingen rör den
  haptikPa: true,          // vibrationen når fram även när bilen är högljudd

  /*
   * null betyder inte "inget valt ljud" utan "inget frånval gjort". Läses
   * som Notiser.DEFAULT_NOTISER, där polis, kontroll, civil bil och kamera
   * alla står på NIVA_ROST — alltså uppläst. Den som vill se en typ på
   * kartan utan att bli tilltalad ställer om den själv; appen gissar inte
   * åt någon vilka kameror hen redan kan utantill.
   */
  notiser: null,

  /*
   * Räckvidden för notiser till låst skärm. Bor på servern — de här två är
   * bara vad telefonen tror, så att rutan kan ritas rätt innan svaret kommit.
   *
   * notisFolj: true ÄR förvalet "Nära mig" i rutan setNotisOmfang
   * (index.html), eftersom renderNotisOmfang längre ner översätter true till
   * 'nara' och false till 'alla'. Samma förval står utskrivet som selected i
   * markupen, så rutan visar rätt sak redan innan den här filen kört.
   *
   * notisFolj är true som förval fastän förvalet på servern är false för
   * varje rad som fanns före ändringen. Det ser motsägelsefullt ut men är
   * det inte: servern har ingen hemtrakt att jämföra med förrän telefonen
   * setts på samma ställe två olika dagar, och tills dess går allt fram.
   * Ett förval som säger "av" hade fått den som aldrig rört reglaget att tro
   * att hen missar varningar hen faktiskt får.
   *
   * 100 km är mätt och inte gissat: Västerås–Stockholm är ungefär tio mil,
   * Västerås–Örebro sju och en halv, och hela Västmanland ryms inom sex mil
   * från Hallstahammar. Med det förvalet får varenda förare i dagens
   * upptagningsområde fortfarande varenda varning.
   */
  notisFolj: true,
  notisRadieM: 100000,

  /*
   * Facebook-grupper bryggan ska läsa. En rad per grupp, med eget område —
   * en förare i Västerås ska inte få varningar från Stockholm. Se
   * "Facebook-grupper" längre ner.
   *
   * Förvalet är gruppen bryggan redan kör mot, så att den som uppgraderar
   * ser sin nuvarande inställning i stället för en tom lista.
   */
  fbGrupper: [{
    id: '317968668373072',
    namn: 'Här Står Polisen - Västerås',
    region: 'vastmanland',
    ort: 'Västerås',
    omrade: 'Västmanland',
    ruta: [15.10, 59.30, 17.30, 60.30],
  }],
};

const IMPACT_LEVELS = {
  low:    { hardBrakeG: 3.0, crashG: 3.0 },
  normal: { hardBrakeG: 1.2, crashG: 3.0 },
  high:   { hardBrakeG: 0.8, crashG: 2.5 },
};

let settings = { ...defaults, ...readJSON(SETTINGS_KEY, {}) };

// Nycklarna kommer i första hand från config.js. Fälten i inställningarna
// finns kvar som åsidosättning, för test och för den som kör egen backend.
applyOverrides(settings);
if (hasBackend() && settings.mode === 'local' && !settings.modeChosen) {
  settings.mode = 'supabase';           // finns backend är delat läge det rimliga
}

/*
 * Äldre versioner sparade egna registreringsnummer i klartext under
 * settings.plEgna. De hashas in och klartexten raderas.
 *
 * Körs vid varje start och är idempotent. Går skrivningen fel behålls
 * klartexten — att radera först och spara sedan hade kunnat kosta någon
 * hela sin fordonslista vid full lagring.
 */
(async () => {
  if (!Array.isArray(settings.plEgna) || !settings.plEgna.length) {
    if ('plEgna' in settings) { delete settings.plEgna; saveSettings(); }
    return;
  }
  const r = await migreraKlartext(settings.plEgna);
  if (!r.ok) return;
  /*
   * Klartextnumren fanns ändå i den här listan — passa på att lägga dem i
   * visningslagret innan de raderas, så att fordonslistan kan visa dem.
   * Se kommentaren vid FORDON_VISNING_NYCKEL för varför lagret finns.
   */
  const reg = haFordonsregister();
  const visn = lasFordonVisning();
  let visnAndrad = false;
  for (const rad of settings.plEgna) {
    const t = await reg.slaUpp(rad);
    if (t && !visn[t.id]?.regnr) {
      visn[t.id] = { regnr: normaliseraPlat(rad), smeknamn: visn[t.id]?.smeknamn || '' };
      visnAndrad = true;
    }
  }
  if (visnAndrad) sparaFordonVisning(visn);
  delete settings.plEgna;
  saveSettings();
  if (r.ogiltiga?.length) {
    toast(`Kunde inte tolka som registreringsnummer: ${r.ogiltiga.join(', ')}`, 6000);
  }
})();

/* ---------- Visningslagret för egna fordon ----------
 *
 * Fordonsregistret i plate.js lagrar bara saltade hashar, och det ändras
 * inte: hasharna är det läsaren matchar varje skylt mot, och de designades
 * med flit för att inte gå att räkna baklänges. Men numret användaren själv
 * skrev in, om sina egna bilar, på sin egen telefon, är hans att se — en
 * lista som bara kan säga "Fordon 3" skyddar ingen och går inte att använda.
 *
 * Därför ligger visningen i gränssnittets eget lager: en egen nyckel som
 * mappar registrets id till det inskrivna numret och ett valfritt smeknamn.
 * Raderas fordonet ur registret städas visningsposten bort (se renderFordon).
 * Saknas visningsposten — poster från tiden före lagret — fungerar
 * igenkänningen ändå, listan kan bara inte visa numret.
 */
const FORDON_VISNING_NYCKEL = 'pv.fordon.visning.v1';

function lasFordonVisning() {
  try { return JSON.parse(localStorage.getItem(FORDON_VISNING_NYCKEL)) || {}; }
  catch { return {}; }
}

function sparaFordonVisning(m) {
  try { localStorage.setItem(FORDON_VISNING_NYCKEL, JSON.stringify(m)); } catch {}
}

/* "Fordon 3" är registrets automatiska etikett, inte något användaren valt. */
function arAutoEtikett(e) { return /^Fordon \d+$/.test(String(e || '').trim()); }
function readJSON(k, f) { try { return JSON.parse(localStorage.getItem(k)) || f; } catch { return f; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }

/* ================= Instanser ================= */

const speaker = new Speaker();

// Gränssnittsljuden får speaker med sig så de kan kliva undan. Ett klickljud
// som maskerar "fartkamera om 300 meter" är värre än inget ljud alls.
const ljud = new Ljud(
  { ljudPa: settings.ljudPa, ljudVolym: settings.ljudVolym, haptikPa: settings.haptikPa },
  { speaker });

const chatt = new Chatt({
  url: CONFIG.supabaseUrl,
  key: CONFIG.supabaseAnonKey,
});
const listener = new Listener();
const geo = new GeoTracker();
const engine = new AlertEngine(speaker, {
  hazardRadiusM: settings.hazardRadiusM,
  cameraLeadSeconds: settings.cameraLeadSeconds,
});
const auth = new Auth();
const store = new ReportStore({
  mode: settings.mode,
  url: CONFIG.supabaseUrl,
  key: CONFIG.supabaseAnonKey,
  pollMs: settings.pollSeconds * 1000,
});

// Ruttvakten delar hastighetsradie med varningsmotorn. Det är inte kosmetik:
// de två delar upp sträckan mellan sig vid exakt det avståndet, så att samma
// polis aldrig läses upp av båda. Ändras det ena måste det andra följa med,
// annars får föraren antingen dubbla varningar eller inga alls.
const routeGuide = new RouteGuide(store, {
  handoffM: settings.hazardRadiusM,
  /*
   * ETT STÄLLE AVGÖR VAD APPEN FÅR SÄGA.
   *
   * Ruttvakten läste tidigare store.active() rått och var därmed den enda
   * talande kanalen som inte passerat produktreglerna, kvalitetsgraderingen,
   * täckningsfiltret eller förarens notisval. Det var mätbart: en rapport med
   * label "Nykterhetskontroll Skultuna" undanhölls av kvalitet.js, saknades
   * både i forRost och i inkommande-listan — och lästes ändå upp på rutten.
   *
   * forRost, inte forKarta: ruttvarningen säger AVSTÅND ("om fyra kilometer
   * på rutten"), och det påståendet kräver en punkt man kan lita på. Det
   * kvalitetslyftet i inkommande-uppläsningen gör gäller därför inte här —
   * lyftet byter ut ett avståndspåstående mot ett referat, och ruttvakten har
   * inget referat att ge. Grinden i inkommandeSok tar hänsyn till det: en
   * lyft rapport lämnas aldrig åt ruttvakten, för den kan inte säga den.
   *
   * Funktionen är hoistad, alltså definierad långt nedanför men fullt giltig
   * här — och den anropas ändå aldrig förrän en rutt är igång.
   */
  haemtaFaror: () => graderadeFaror().forRost,
});
const winter = new WinterService();
const groups = new Groups();
const vakthund = new Vakthund();
const varmevakt = new Varmevakt();

const billing = new Billing({
  url: CONFIG.supabaseUrl, key: CONFIG.supabaseAnonKey, paymentLink: CONFIG.stripePaymentLink,
});
const dashcam = new Dashcam();
const installPrompt = new Install.InstallPrompt();
const limits = new SpeedLimitService({
  enabled: settings.limitOn,
  marginKmh: settings.speedMargin,
});
const impact = new ImpactDetector(IMPACT_LEVELS[settings.impactLevel]);
const remote = new RemoteControl(settings.bindings);
const stats = new Stats({ url: CONFIG.supabaseUrl, key: CONFIG.supabaseAnonKey });
const reputation = new Reputation({ url: CONFIG.supabaseUrl, key: CONFIG.supabaseAnonKey });

let map = null;
let cameras = [];
let wakeLock = null;
let pendingPick = null;      // { place, type } medan användaren pekar på kartan
let currentAlert = null;

/* ================= Start ================= */

/*
 * Starten går att stänga av — och bara av ett prov.
 *
 * inkommande-test.html importerar den här filen för att köra den RIKTIGA
 * uppläsningskedjan i stället för en kopia av den. Ett prov som testar en
 * kopia bevisar bara att kopian fungerar; det var precis så felet den 23
 * augusti kunde ligga kvar. Utan flaggan hade importen dragit igång GPS,
 * pollning mot servern och hela gränssnittet — inget av det finns i ett
 * provdokument, och proven hade blivit ett test av vilka DOM-fel boot()
 * kastar.
 *
 * Allt ovanför den här raden är instanser utan sidoeffekter: ingen fetch,
 * ingen DOM, ingen timer. Flaggan hoppar alltså bara över uppstarten, inte
 * över konstruktionen — det är därför provet kan tala med samma store,
 * samma speaker och samma engine som appen kör med.
 */
/*
 * js/inst.js när den finns. Se laddaInst() längre ner, där hela resonemanget
 * om den dynamiska importen står.
 *
 * Deklarationen står HÄR, ovanför boot(), och inte bredvid sina funktioner.
 * boot() körs på raden nedanför medan filen fortfarande evalueras, och en let
 * som deklareras längre ner är då i sin döda zon: laddaInst() kastar
 * ReferenceError innan appen ens ritat en karta. Funktionsdeklarationer
 * hissas, variabler gör det inte — och felet syns bara som en tyst avvisad
 * promise, alltså en app där genvägarna slutat fungera utan att någon vet om
 * det.
 */
let instModul = null;

/* js/butik.js, av exakt samma skäl och med exakt samma dödszon-varning som
   instModul ovanför. Se laddaButik() bredvid laddaInst(). */
let butikModul = null;

if (!globalThis.PV_INGEN_BOOT) boot();

async function boot() {
  /* Först av allt: rörelsens stilmall och tryckkvittensen.
     Före kartan och före wireUI(), för att inget vybyte ska hinna ske innan
     stilen finns. Ett vybyte utan stilmall är inte trasigt — det blir bara
     ett hopp — men det första trycket i appen är det som lär föraren om
     gränssnittet svarar eller inte. */
  Rorelse.start();
  /* Inställningsmodulen hämtas i bakgrunden och väntas aldrig in. Se
     laddaInst(): saknas filen tar reserven i oppnaInstallning() över. */
  laddaInst();
  /* Butiken likadant: hämtas i bakgrunden, väntas aldrig in. Saknas filen
     visar butiksvyn sin reservtext och resten av appen märker ingenting. */
  laddaButik();

  speaker.enabled = settings.tts;
  speaker.volume = settings.volume;
  speaker.rate = settings.rate;
  speaker.onSpeakingChange = talking => talking ? listener.pause() : listener.resume();

  map = new HazardMap($('map'));
  applyTheme();

  await initGeocoder();
  await loadCameras();

  store.addEventListener('change', renderHazards);
  store.addEventListener('status', renderStatus);
  store.start();

  billing.addEventListener('change', renderBilling);
  await billing.sync();

  wireGeo();
  wireUI();
  wireVoice();
  wireDashcam();
  wireLjud();
  hanteraGenvag();
  wireSettingsUI();
  wireSpeedLimits();
  wireRemote();
  wireImpact();
  wireStats();
  wireDagensHistorik();
  wireTour();
  wireDriving();
  wireUpdates();
  wireUpdateBanner();
  wireSedanSist();
  wireInkommandeUpplasning();
  wireCoverage();
  wireRoute();
  wireWinter();
  wireVakthund();
  wireVarmevakt();
  wirePermissions();
  // Läser av läget vid varje start och lägger en rad högst upp om plats eller
  // notiser saknas. Väntas inte in: den har en egen fördröjning som låter
  // startfrågorna gå först, och boot() ska inte stå still för den.
  wireBehorigheter();
  wireDemos();
  lockZoom();

  geo.start();
  renderStatus();
  renderBilling();
  renderHazards();
  refreshLearnedList();
  renderStats();
  renderReputation();

  // Ordningen på det som möter en ny användare: först ansvarsfriskrivningen,
  // sedan konto eller gäst, sist installationsguiden. Tre saker på en gång
  // hade blivit en vägg av modaler.
  wireAuth();
  // Chatten efter inloggningen, aldrig före. RLS slapper bara in den som ar
  // inloggad, sa startar pollningen innan wireAuth satt token gar forsta
  // hamtningen ivag med anonyma nyckeln och far 401.
  wireChatt();
  wireMorktLage();
  if (!settings.disclaimerAccepted) {
    showDisclaimer();
  } else {
    afterDisclaimer();
  }
  if (settings.keepAwake) requestWakeLock();

  /*
   * Omritningarna hoppas över när ingen tittar.
   *
   * renderHazards var den dyraste timern i mätningen — 16 till 35 millisekunder
   * i minuten, mer än alla andra tillsammans. Den ritar nålar och listor som
   * ingen ser i en dold flik, och när fliken kommer fram ritas allt ändå om
   * direkt via showView. Att räkna om en osynlig karta är rent slöseri.
   *
   * VARNINGARNA rörs inte av det här. De körs ur GPS-flödet i wireGeo och
   * fortsätter med skärmen släckt, vilket är hela poängen med appen.
   */
  const nardenSyns = fn => () => { if (document.visibilityState === 'visible') fn(); };

  setInterval(nardenSyns(renderHazards), 20000);
  setInterval(nardenSyns(maybeShowPaywall), 60000);
  setInterval(nardenSyns(() => { stats.recordAll(fickSparas(store.active())); renderStats(); }), 120000);
  registerSW();

  // Säg till räddningsnätet i index.html att allt gick bra. Uteblir den här
  // signalen visas en knapp som hämtar om appen — se kommentaren där.
  dispatchEvent(new Event('polisvakt:ready'));
}

async function loadCameras() {
  try {
    const r = await fetch('./data/cameras.json');
    if (!r.ok) throw 0;
    const raw = await r.json();
    cameras = (Array.isArray(raw) ? raw : raw.cameras || []).map((c, i) => ({
      id: 'cam-' + (c.id ?? i),
      type: 'camera',
      lat: +c.lat, lon: +c.lon,
      label: c.name || c.road || '',
      speedLimit: c.speedLimit ?? null,
      bearing: Number.isFinite(c.bearing) ? c.bearing : undefined,
      fixed: true,
    })).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  } catch { cameras = []; }
  const el = $('camCount');
  if (el) {
    el.textContent = cameras.length
      ? `${cameras.length} fartkameror laddade.`
      : 'Inga fartkameror laddade ännu. Kör importverktyget nedan så börjar appen varna för dem.';
  }
}

/* ================= GPS ================= */

function wireGeo() {
  geo.addEventListener('position', e => {
    const fix = e.detail;
    dashcam.overlay.speedKmh = fix.speedKmh;
    vakthund.notera(fix);
    chatt.notera(fix);
    /*
     * Samma matning som chatten redan får, och av samma skäl: push.js vill
     * veta vilken RUTA telefonen brukar vara i, inte var den är just nu.
     * Ingen ny sensor, ingen ny behörighet, inget nytt anrop per fix — modulen
     * räknar dagar och hör av sig till servern först när trakten är etablerad.
     *
     * Valfritt anrop med flit: push-modulen är fristående och kan saknas i en
     * avskalad körning. En GPS-fix som kastar här hade tagit med sig navFix,
     * hastighetsmätaren och kartnålen i fallet.
     */
    Push.noteraPosition?.(fix.lat, fix.lon);
    navFix(fix);
    updateSpeedo(fix);
    map.updateMe(fix);
    autoTheme(fix);

    driving.update(fix, billing.allowed && settings.tts);

    if (billing.allowed) {
      billing.beginTrial();

      // Ruttvakten först. Den plockar bort det den själv tänker varna för
      // längre fram på vägen, så att närhetsmotorn inte säger samma sak en
      // gång till när man kommer nära. Utan rutt lämnar den listan orörd.
      routeGuide.update(fix);
      engine.evaluate(fix, routeGuide.filterHazards(allHazards({ forAlerts: true })));

      if (settings.limitOn) limits.update(fix);
      if (settings.winterOn) winter.update(fix);
      checkHotspot(fix);
    }
    renderHazardsThrottled();
    renderStatus();
  });

  geo.addEventListener('error', e => {
    $('chipGps').className = 'chip err';
    if (e.detail.code === 1) toast(e.detail.message, 6000);
  });

  map.addEventListener('followchange', e => { $('btnFollow').hidden = e.detail; });
  map.addEventListener('pick', e => onMapPick(e.detail));
  map.addEventListener('hazardclick', e => focusHazard(e.detail));

  engine.addEventListener('alert', e => showAlertBanner(e.detail));
}

function updateSpeedo(fix) {
  const el = $('speedNum');
  const v = fix.speedKmh;
  el.textContent = v == null ? '–' : v;

  // Färgen på siffran säger allt föraren behöver med en blick: gul när du
  // ligger över gränsen, röd när du ligger över marginalen också.
  const limit = limits.current?.limit;
  const sp = $('speedo');
  sp.classList.remove('fast', 'over', 'way-over');
  if (limit && v != null) {
    if (v > limit + settings.speedMargin) sp.classList.add('way-over');
    else if (v > limit) sp.classList.add('over');
  } else if ((v ?? 0) > 100) {
    sp.classList.add('fast');
  }
}

/* ================= Hastighetsgräns ================= */

function wireSpeedLimits() {
  limits.addEventListener('limit', e => {
    const hit = e.detail;
    const sign = $('limitSign');
    if (!hit || !settings.limitOn) { sign.hidden = true; return; }
    sign.hidden = false;
    $('limitNum').textContent = hit.limit;
    sign.title = hit.name || '';
  });

  limits.addEventListener('speeding', e => {
    if (!settings.speedWarn) return;
    const d = e.detail;
    speaker.chime('alert');
    setTimeout(() => speaker.say(d.spoken, { priority: 2, interrupt: true }), 320);
    $('limitSign').classList.add('alarm');
    setTimeout(() => $('limitSign').classList.remove('alarm'), 6000);
    toast(`Du kör ${d.speed} där det är ${d.limit}${d.name ? ' · ' + d.name : ''}`, 5000);
  });

  limits.addEventListener('error', () => {
    const el = $('limitStatus');
    if (el) el.textContent = 'Vägdata kunde inte hämtas just nu. Appen försöker igen automatiskt.';
  });

  limits.addEventListener('tile', async () => {
    const info = await limits.storageInfo();
    const el = $('limitStatus');
    if (el) el.textContent =
      `${info.ways.toLocaleString('sv-SE')} vägsträckor nedladdade i ${info.tiles} områden (${fmtBytes(info.bytes)}).`;
  });
}

/* ================= Rattknappar ================= */

function wireRemote() {
  remote.addEventListener('action', async e => {
    const { action, via } = e.detail;
    switch (action) {
      // Rattknappen ger samma sorts rapport som en knapptryckning i appen -
      // foraren star pa platsen. Har lag tidigare en ternar dar bada grenarna
      // gav 'app', alltsa en rad som sag ut att skilja pa nagot den inte gjorde.
      case 'report-police':   await reportAt('police'); break;
      case 'report-control':  await reportAt('control'); break;
      case 'report-camera':   await reportAt('camera'); break;
      case 'report-unmarked': await reportAt('unmarked'); break;
      case 'confirm-nearest': await confirmNearest(); break;
      case 'clear-nearest':   await clearNearest(null); break;
      case 'toggle-mute':     $('btnMute').click(); break;
      case 'voice':           $('btnMic').click(); break;
      case 'save-clip':
        if (dashcam.recording) { await dashcam.saveEvent(3); speaker.say('Klippet är sparat.', { priority: 0 }); }
        else toast('Dashcam är inte igång.');
        break;
    }
  });

  remote.addEventListener('error', e => toast(e.detail.message, 5000));
}

async function confirmNearest() {
  const fix = geo.position;
  if (!fix) return toast('Ingen GPS-position.');
  const near = store.near(fix.lat, fix.lon, 4000);
  if (!near.length) {
    speaker.say('Ingen rapport i närheten att bekräfta.', { priority: 0 });
    return;
  }
  await store.confirm(near[0].id);
  reputation.addVerify();
  speaker.chime('ack');

  /*
   * Säg vad det var som bekräftades.
   *
   * Rattknappen trycks blint. "Tack. Polis bekräftad." bekräftar något
   * föraren inte kan se vilket av — står det två rapporter inom fyra
   * kilometer är det en gissning vilken av dem som förlängdes. Den
   * uppläsningsvänliga formen säger vilken, med källa och ålder, och gör
   * knappen möjlig att lita på utan att titta.
   *
   * Formen är den tredje i sammanfattning.js och inte den korta: tankstreck
   * och siffror hör hemma på en skärm, inte i en talsyntes. voice.js själv
   * behövde ingen ändring — Speaker tar emot färdiga strängar och bygger
   * inga fraser om rapporter.
   */
  /*
   * "Din bekräftelse är räknad", inte "den ligger kvar längre nu".
   *
   * Den gamla formuleringen var mätbart osann. expires_at sätts ur
   * VISNING_MINUTER (240 min) medan store.confirm() förlänger på
   * TTL_MINUTES × 0,6 (27 min), och greatest() vinner för den befintliga
   * tiden — delta noll minuter ända till 214 minuters ålder. Se den långa
   * motiveringen i js/store.js confirm(). Bekräftelsen gör något verkligt:
   * confirms+1 höjer graderingen i js/kvalitet.js, och det är det som sägs.
   */
  const talat = sammanfattaTal(near[0], { egen: arMin(near[0]) });
  speaker.say(talat ? `Tack. ${talat} Din bekräftelse är räknad.`
                    : `Tack. ${TYPE_LABEL[near[0].type]} bekräftad.`, { priority: 0 });
  renderReputation();
}

/* ================= Krockdetektering ================= */

function wireImpact() {
  impact.addEventListener('impact', async e => {
    const d = e.detail;
    if (dashcam.recording) {
      await dashcam.saveEvent(d.level === 'crash' ? 5 : 2);
    }
    speaker.chime('alert');
    speaker.say(d.level === 'crash'
      ? 'Kraftig smäll registrerad. Filmen är sparad.'
      : 'Händelse sparad.', { priority: 2 });
    toast(d.text, 7000);
    const el = $('impactStatus');
    if (el) el.textContent = `Senaste händelse: ${d.g} g, ${new Date().toLocaleTimeString('sv-SE')}.`;
  });
}

/* ================= Historik och mönster ================= */

/**
 * Sållet framför historiklagringen.
 *
 * NYKTERHETSREGELN, ETT STEG TIDIGARE ÄN FÖRUT.
 *
 * stats.js sparar magert med flit: id, typ, koordinat, tidpunkt och de
 * fyrtio första tecknen av etiketten. `note` och `raw` — alltså det som
 * faktiskt skrevs — följer inte med. Det är rätt för mönsterletandet, men det
 * betyder att en rad som väl hamnat i pv.history.v1 inte längre GÅR att pröva
 * mot spärren i sin helhet: allt spärren skulle ha reagerat på ligger i de
 * fält som kastades.
 *
 * Så länge historiken bara räknades ihop till hotspots spelade det mindre
 * roll — en prick i ett rutnät säger ingenting. Dagens historik läser samma
 * lagring och skriver ut den som text, och då blir det plötsligt en väg fram
 * till en människa. Alltså frågas farBeskrivas() HÄR, medan hela rapporten
 * fortfarande finns, i stället för när bara etiketten är kvar.
 *
 * Visningen frågar en gång till. Rader som lagrats innan den här raden fanns
 * ligger kvar i telefonerna, och för dem är etiketten det enda som går att
 * pröva. Två grindar där den andra ser mindre än den första är inte en kopia
 * att hålla i takt — det är samma fråga ställd till det som återstår.
 *
 * Deklarerad som function och inte som const: boot() startar högre upp i
 * filen än den här raden, och en const hade legat i sin dödzon om någon
 * framtida ändring flyttar ett anrop före den första await:en.
 */
function fickSparas(rapporter) { return rapporter.filter(farBeskrivas); }

function wireStats() {
  store.addEventListener('change', () => stats.recordAll(fickSparas(store.active())));
  stats.addEventListener('change', () => { renderStats(); renderHotspotLayer(); });
  if (settings.mode === 'supabase') stats.syncFromServer().then(renderStats);
}

function renderHotspotLayer() {
  if (!settings.showHotspots) { map.clearHotspots(); return; }
  map.renderHotspots(stats.hotspots({ minCount: 3, limit: 60 }));
}

/** Säg till när vi kör in på en plats som historiskt är het just nu. */
function checkHotspot(fix) {
  if (!settings.hotspotVoice) return;
  if ((fix.speedKmh ?? 0) < 20) return;
  const risk = stats.riskAt(fix.lat, fix.lon);
  if (!risk || !risk.matchesTime) return;
  // Har någon redan rapporterat här nu behövs ingen historiklektion
  if (store.near(fix.lat, fix.lon, 700).length) return;
  if (!stats.shouldAnnounce(risk.hotspot.key)) return;
  speaker.say(risk.spoken, { priority: 0 });
  toast(risk.hotspot.spoken, 5000);
}

function renderStats() {
  const el = $('statsSummary');
  if (!el) return;
  const n = stats.size;
  const days = stats.span;
  el.textContent = n
    ? `${n} rapporter i historiken${days ? `, insamlade över ${days} ${days === 1 ? 'dag' : 'dagar'}` : ''}. Mönstren blir bättre ju längre appen används.`
    : 'Ingen historik ännu. Mönstren växer fram när rapporter börjar komma in.';

  const ul = $('hotspotList');
  if (!ul) return;
  const spots = stats.hotspots({ minCount: 3, limit: 8 });
  ul.innerHTML = spots.length ? '' : '<li class="muted">Behöver minst tre rapporter från samma plats.</li>';
  for (const s of spots) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="hs-ico">${TYPE_ICON[s.type] || '📍'}</span>` +
      `<span class="hs-main"><span class="hs-title">${escapeHtml(s.label)}</span>` +
      `<span class="hs-meta">${escapeHtml(s.spoken)}</span></span>` +
      `<span class="hs-count">${s.count}×</span>`;
    li.onclick = () => { showView('map'); map.setFollow(false); map.centerOn(s.lat, s.lon, 15); };
    ul.appendChild(li);
  }
}

/* ================= Dagens historik =================
 *
 * "Sen kan man se tidigare historiken under dagen." — ägaren.
 *
 * VARFÖR DEN INTE ÄR NÅLAR PÅ KARTAN.
 * En utgången rapport tas bort ur kartan med flit. En karta där morgonens
 * polis fortfarande står kvar klockan sex på kvällen är en karta man slutar
 * tro på, och när man slutat tro på den hjälper inte heller de nålar som
 * stämmer. Uppgiften är däremot inte värdelös bara för att den inte längre är
 * en varning — den svarar på "vad har hänt idag", vilket är en annan fråga än
 * "vad ska jag akta mig för nu". Två frågor, två ytor. Den här öppnar man.
 *
 * VARIFRÅN RADERNA KOMMER, OCH VARFÖR DET ÄR TVÅ KÄLLOR.
 *
 *   store.reports — hela rapportobjekt, även utgångna. Bäst i allo: de bär
 *   källa, bekräftelser och de textfält nykterhetsspärren läser. Men store
 *   städar bort en rad tre timmar efter att den gått ut, så en polis som
 *   rapporterades i morse finns inte kvar där i eftermiddag.
 *
 *   stats.entries — pv.history.v1, samma lagring som mönsterlistan bygger på.
 *   Magrare (typ, koordinat, tidpunkt, kapad etikett) men den lever kvar hela
 *   dagen och långt därefter. Den fyller i det store hunnit glömma.
 *
 * Att bygga en tredje, egen dagslagring hade varit en fjärde kopia av samma
 * rader att hålla i takt. Sammanslagningen är billigare och kan inte glida.
 *
 * ENDAST DET DEN HÄR TELEFONEN SJÄLV HAR SETT.
 * stats.syncFromServer() hämtar också nittio dygn ur report_history, och de
 * raderna saknar id. De hoppas över här. Skälet är inte prydlighet:
 * report_history bär ingen grupptillhörighet men är läsbar för alla, så en
 * rapport som skickats inne i en sluten grupp ligger där utan sitt skydd. Det
 * som gått genom store har däremot passerat radsäkerheten på vägen in.
 * Ett id är alltså inte bara ett id — det är kvittot på att raden var vår att
 * se. Sidoeffekten är dessutom precis vad ägaren bad om: listan fungerar utan
 * nät, eftersom allt den läser redan ligger i telefonens lagring.
 *
 * NYKTERHETSREGELN.
 * farBeskrivas() frågas om varje rad, här igen. Se fickSparas() ovanför för
 * varför det inte är en överflödig kopia: den grinden ser hela rapporten,
 * den här ser det som återstår av en rad som lagrades innan grinden fanns.
 */

/** Hur många rader listan visar. Längre än så bläddrar ingen igenom. */
const DAGEN_TAK = 120;

/** Midnatt i förarens egen tidszon — "idag" är en lokal fråga. */
function dygnetsBorjan(nu = Date.now()) {
  const d = new Date(nu);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const dagenSkapad = r => Number(r?.createdAt ?? r?.created_at);

/**
 * Dagens rapporter, senast först.
 *
 * @returns {Array<object>} rapportobjekt. De som bara fanns i stats-lagringen
 *   är märkta med `urHistoriken: true` och saknar källa och utgångstid — se
 *   dagenStatus() för varför det inte spelar någon roll.
 */
function dagensRapporter(nu = Date.now()) {
  const fran = dygnetsBorjan(nu);
  // Telefonklockor går isär. En stämpel någon minut fram är inte fel data,
  // men en som ligger timmar fram hör inte hemma i "idag". Samma tolerans
  // som sammanfattning.js använder mot framtidsstämplar.
  const till = nu + 2 * 60000;
  const inomDagen = t => Number.isFinite(t) && t >= fran && t <= till;

  const ut = new Map();

  for (const r of store.reports.values()) {
    // Fasta kameror är inte händelser. De stod där igår också.
    if (!r || r.fixed) continue;
    if (!inomDagen(dagenSkapad(r))) continue;
    ut.set(r.id, r);
  }

  for (const e of stats.entries) {
    if (!e || !e.i) continue;        // utan id = hämtad ur report_history
    if (ut.has(e.i)) continue;       // store har en rikare version av samma rad
    if (!inomDagen(Number(e.a))) continue;
    ut.set(e.i, {
      id: e.i,
      type: e.t,
      lat: e.y,
      lon: e.x,
      label: e.n || '',
      createdAt: e.a,
      urHistoriken: true,
    });
  }

  return [...ut.values()]
    .filter(farBeskrivas)
    .sort((a, b) => dagenSkapad(b) - dagenSkapad(a))
    .slice(0, DAGEN_TAK);
}

/**
 * Vad raden ska stå för i listan.
 *
 * Kravet är enkelt att skriva och lätt att gå bet på: en utgången rapport får
 * ALDRIG se ut som en aktuell. Därför säger varje rad rakt ut vad den är, i
 * stället för att lämna det åt läsaren att räkna ut ur ett klockslag.
 *
 * TVÅ LÄGEN RÄCKTE INTE, OCH DET VAR MÄTBART FEL.
 *
 * Funktionen läste bara expiresAt, alltså VISNINGSTIDEN — fyra timmar sedan
 * store.js delades i TTL_MINUTES och VISNING_MINUTER. Följden: en polisrapport
 * skapad 13:00 och öppnad 16:00 fick statusordet "Aktiv nu" i accentfärg och
 * räknades in i "3 räknas fortfarande som aktuella", medan sammanfattaKort()
 * om exakt samma rad sa "Troligen inte kvar" och bedomRapport() satte den till
 * tyst. Två ytor i samma app sa motsatta saker om samma rapport, och den yta
 * som sa fel var just den som byggdes för att göra det utgångna synligt UTAN
 * att låta det se aktuellt ut.
 *
 * Gränserna är därför trovärdighetstiden (TTL_MINUTES) och inte visningstiden,
 * och orden är samma ord som aktualitet() i js/sammanfattning.js använder —
 * annars hade det här blivit den sjunde formuleringen av samma sak. Andelen
 * 0,5 är samma brytpunkt som där.
 */
function dagenStatus(r, nu = Date.now()) {
  if (r.removed) return { text: 'Borttagen', ton: 'var(--fg-dim)', aktiv: false };

  const emot = Number(r.denials) || 0;
  const for_ = Number(r.confirms) || 0;
  if (emot >= 3 && emot > for_) return { text: 'Nedröstad', ton: 'var(--fg-dim)', aktiv: false };

  /*
   * En rad som bara finns i stats-lagringen påstås aldrig vara aktiv.
   *
   * Frestelsen är att räkna fram en utgångstid ur typens livslängd. Men det
   * hade varit en gissning presenterad som ett faktum, och gissningen lutar
   * åt fel håll: den enda anledningen till att raden inte längre finns i
   * store är att store redan städat bort den, vilket sker först tre timmar
   * EFTER att den gått ut. Är den borta därifrån är den slut.
   */
  if (r.urHistoriken) return { text: 'Utgången', ton: 'var(--fg-dim)', aktiv: false };

  const slut = Number(r.expiresAt ?? r.expires_at);
  const synsAn = Number.isFinite(slut) && slut > nu;

  // Trovärdighetstiden, inte visningstiden. Samma skala som graderingen,
  // aktualitetstexten och kartnålens uttoning räknar på.
  const ttlMs = (TTL_MINUTES[r.type] ?? 45) * 60000;
  const skapad = Number(dagenSkapad(r));
  const andel = Number.isFinite(skapad) ? Math.max(0, nu - skapad) / ttlMs : Infinity;

  if (andel < 0.5) return { text: 'Aktiv nu', ton: 'var(--accent)', aktiv: true };
  if (andel < 1)   return { text: 'Kan ha flyttat på sig', ton: 'var(--warn)', aktiv: true };
  // Kvar på kartan i upp till fyra timmar, men appen tror inte längre på den.
  // Ordet är detsamma som rapporten själv bär i sin sammanfattning.
  if (synsAn)      return { text: 'Troligen inte kvar', ton: 'var(--fg-dim)', aktiv: false };
  return { text: 'Utgången', ton: 'var(--fg-dim)', aktiv: false };
}

const dagenKlockslag = t => Number.isFinite(Number(t))
  ? new Date(Number(t)).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
  : '–';

function renderDagensHistorik() {
  const ul = $('dagenLista');
  if (!ul) return;

  const nu = Date.now();
  const rader = dagensRapporter(nu);
  const aktiva = rader.filter(r => dagenStatus(r, nu).aktiv).length;

  const sum = $('dagenSum');
  if (sum) {
    // Tom dag sägs bara EN gång. Sammanfattningen och tomraden hade annars
    // stått under varandra och sagt samma sak med olika ord, vilket läses
    // som att den ena betyder något mer än den andra.
    sum.hidden = rader.length === 0;
    /*
     * "Räknas fortfarande som aktuella", inte "ligger på kartan".
     *
     * En aktiv rapport SYNS inte nödvändigtvis: bevakningsområdet och
     * notisinställningarna kan sålla bort den efteråt. Raden får inte lova
     * något den inte vet, och den enda uppgift den faktiskt har är om
     * rapportens tid gått ut eller inte.
     */
    sum.textContent =
      `${rader.length} ${rader.length === 1 ? 'rapport' : 'rapporter'} sedan midnatt. ` +
      (aktiva
        ? `${aktiva} räknas fortfarande som ${aktiva === 1 ? 'aktuell' : 'aktuella'}, ` +
          `${rader.length - aktiva} har passerat sin tid.`
        : 'Ingen av dem är aktuell längre.');
  }

  $('dagenTom').hidden = rader.length > 0;

  ul.innerHTML = '';
  for (const r of rader) {
    const status = dagenStatus(r, nu);
    const egen = arMin(r);

    /*
     * Rubriken kommer ur sammanfattning.js, inte ur ett eget strängbygge här.
     * "Polis vid Hälla" och "Trafikkontroll, plats okänd" är den modulens
     * formuleringar, och en lista som säger det på sitt eget vis blir den
     * sjunde platsen där samma sak formuleras olika.
     *
     * delar är null när spärren sa nej — men då har raden redan sållats bort
     * av farBeskrivas() ovanför, så det här är enbart ett bälte till.
     */
    const d = beskrivning(r, { egen, nu }).delar;
    if (!d) continue;

    const li = document.createElement('li');
    if (!status.aktiv) li.style.opacity = '.62';

    li.innerHTML =
      `<span class="hs-ico">${TYPE_ICON[r.type] || '📍'}</span>` +
      `<span class="hs-main">` +
        `<span class="hs-title">${escapeHtml(`${d.typ}${d.plats}`)}</span>` +
        `<span class="hs-meta">` +
          `<b style="color:${status.ton}; font-weight:650;">${status.text}</b>` +
          // Källan följer med. "Utgången" ensamt säger inte om det var en
          // förare eller ett Facebook-inlägg, och det är skillnaden mellan
          // en uppgift man kan gå tillbaka till och en man inte kan.
          (d.kalla ? ` · ${escapeHtml(cap(d.kalla))}.` : '') +
        `</span>` +
      `</span>` +
      `<span class="hs-count" style="font-variant-numeric:tabular-nums;">${dagenKlockslag(dagenSkapad(r))}</span>`;

    // Tryck = "var låg det?". Ingen nål tänds — den är utgången och ska
    // förbli det — men kartan går dit, vilket är hela frågan raden väcker.
    li.onclick = () => {
      stangDagensHistorik();
      showView('map');
      map.setFollow(false);
      map.centerOn(r.lat, r.lon, 15);
    };
    ul.appendChild(li);
  }

  const fot = $('dagenFot');
  if (fot) {
    const kapad = rader.length >= DAGEN_TAK;
    fot.hidden = !kapad;
    if (kapad) fot.textContent =
      `Visar de ${DAGEN_TAK} senaste. Äldre rapporter från idag är inte borta — ` +
      'de får bara inte plats i listan, och finns kvar i mönstren under Inställningar.';
  }
}

function oppnaDagensHistorik() {
  renderDagensHistorik();
  $('modalDagen').hidden = false;
}

function stangDagensHistorik() {
  const m = $('modalDagen');
  if (m) m.hidden = true;
}

function wireDagensHistorik() {
  const m = $('modalDagen');
  if (!m) return;

  $('btnDagen')?.addEventListener('click', oppnaDagensHistorik);
  $('btnDagenInst')?.addEventListener('click', oppnaDagensHistorik);
  $('dagenStang')?.addEventListener('click', stangDagensHistorik);
  /*
   * Tryck utanför kortet stänger också.
   *
   * Appens övriga modaler gör INTE så, och det är rätt för dem: de ställer en
   * fråga som ska besvaras, och ett tryck bredvid kortet är då lika ofta en
   * miss som ett svar. Den här ställer ingen fråga — den visar en lista man
   * är klar med när man är klar med den. Att tvinga fram ett träffsäkert
   * tryck på en knapp för att komma ur en läsvy är att göra det svårt att
   * sluta läsa.
   */
  m.addEventListener('click', ev => { if (ev.target === m) stangDagensHistorik(); });

  /*
   * Rita om medan den ligger uppe, men bara då.
   *
   * En rapport kan gå ut, bekräftas eller komma in medan listan är öppen, och
   * en rad som står kvar som "Aktiv nu" efter att den slutat vara det är
   * exakt det fel kravet handlar om. Ligger modalen stängd görs ingenting —
   * store 'change' kommer var trettionde sekund och listan är inte gratis att
   * bygga.
   */
  const omDenSyns = () => { if (!m.hidden) renderDagensHistorik(); };
  store.addEventListener('change', omDenSyns);
  stats.addEventListener('change', omDenSyns);
  // Klockan går vidare även utan nya rapporter. En minut är tätt nog för att
  // "Aktiv nu" ska hinna bli "Utgången" medan man tittar.
  setInterval(omDenSyns, 60000);
}

/* ================= Rapportpoäng ================= */

function renderReputation() {
  reputation.refreshFromStore(store, isMine);
  const scoreEl = $('repScore');
  if (!scoreEl) return;
  scoreEl.textContent = reputation.score();

  const ul = $('repBreakdown');
  ul.innerHTML = '';
  for (const row of reputation.breakdown()) {
    if (!row.n) continue;
    const li = document.createElement('li');
    li.innerHTML = `<span>${row.label}</span><span>${row.n} · ${row.points > 0 ? '+' : ''}${row.points} p</span>`;
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.innerHTML = '<li class="muted">Rapportera något så börjar poängen ticka.</li>';

  $('repNick').value = reputation.nickname;
  refreshLeaderboard();
}

async function refreshLeaderboard() {
  const ol = $('leaderboard');
  const hint = $('repHint');
  if (!ol) return;
  if (!store.isRemote) {
    ol.innerHTML = '';
    hint.textContent = 'Topplistan kräver att delat läge är påslaget under Delning.';
    return;
  }
  const rows = await reputation.leaderboard(REWARD_TOP_N);
  if (!rows) { hint.textContent = 'Kunde inte hämta topplistan.'; return; }
  const myNick = reputation.nickname;
  ol.innerHTML = rows.length ? '' : '<li class="muted">Ingen på listan än den här månaden.</li>';
  for (const r of rows) {
    const li = document.createElement('li');
    if (myNick && r.nickname === myNick) li.className = 'me';
    li.innerHTML = `<span>${escapeHtml(r.nickname || 'Anonym')}</span><span>${r.score} p</span>`;
    ol.appendChild(li);
  }
  hint.textContent = `De ${REWARD_TOP_N} översta får nästa månad gratis.`;
}

/* ================= Ansvarsfriskrivning ================= */

function showDisclaimer() {
  $('modalDisclaimer').hidden = false;
  const check = $('discCheck');
  const btn = $('discAccept');
  check.checked = false;
  btn.disabled = true;
  check.onchange = () => { btn.disabled = !check.checked; };
  btn.onclick = () => {
    settings.disclaimerAccepted = true;
    saveSettings();
    $('modalDisclaimer').hidden = true;
    afterDisclaimer();
  };
}

/* ============================================================
 * TILLFÄLLIGT TESTLÄGE — SKA SLÅS AV IGEN
 * ============================================================
 *
 * Så länge det bara är Elliot som testar appen fram och tillbaka är
 * inloggningsrutan och introduktionsguiden bara två klick i vägen vid varje
 * omladdning. Den här flaggan hoppar över båda.
 *
 * SÄTT TILLBAKA TILL false INNAN NÅGON ANNAN ANVÄNDER APPEN.
 * Elliot säger till när det är dags. Sätt bara den här raden — allt som
 * flaggan påverkar letar upp den, så det finns inget mer att komma ihåg.
 *
 * Vad flaggan INTE gör, och inte kan göra: chatten kräver fortfarande ett
 * konto. Det kravet ligger i databasens radsäkerhet, inte i klienten, och att
 * öppna chattabellen för anonyma vore att montera ner ett säkerhetsskydd i
 * skarp drift för att slippa en inloggningsruta. Det gör jag inte. Logga in
 * när chatten ska testas; allt annat fungerar utan.
 */
const TESTLAGE_UTAN_INLOGGNING = true;

function afterDisclaimer() {
  if (TESTLAGE_UTAN_INLOGGNING) {
    if (!auth.decided) auth.continueAsGuest();
    if (Install.shouldAutoShow()) setTimeout(() => openInstallGuide(true), 900);
    if (settings.wakeWord && voiceInputSupported) listener.startWakeWord();
    visaBelaning();
    return;
  }

  // Konto krävs. Utan det når rapporterna ingen annan, och då är appen bara
  // en karta. Gästläget finns kvar i koden men bara som nödutgång när
  // backend inte svarar alls.
  if (!auth.signedIn && auth.available) { showAuthScreen(); return; }
  if (!auth.decided) { showAuthScreen(); return; }
  if (!tourSeen()) { startTour(); return; }
  if (Install.shouldAutoShow()) setTimeout(() => openInstallGuide(true), 900);
  if (settings.wakeWord && voiceInputSupported) listener.startWakeWord();
  visaBelaning();
}

/* ================= Körning och bevakningsområde ================= */

function wireDriving() {
  /*
   * Körvanorna lär sig när du brukar köra och påminner dig att slå på appen.
   *
   * Det Elliot bad om var att appen skulle känna av körning via GPS även när
   * den är helt stängd. Det går inte i en webbapp, och det är mätt, inte
   * antaget: `geolocation` är undefined inne i en worker och Geofencing-API:t
   * finns inte. En service worker kan alltså aldrig läsa position.
   *
   * Det som finns här är den ena halvan som fungerar utan server: appen är
   * öppen och påminner vid ett inlärt fönster. Andra halvan är en notis som
   * servern skickar vid samma tider och som når fram med appen stängd — den
   * kräver att nycklarna sätts i Supabase, se docs/korpaminnelse.md.
   */
  korvanor.fran(readJSON('pv.korvanor.v1', {}));
  const korningar = readJSON('pv.korningar.v1', []);
  korningar.length
    ? korvanor.larIn(korningar)
    : (korvanor.fonster = Korvanor.fonsterFranVanor(driving.habits));

  driving.addEventListener('start', () => {
    toast('Körning upptäckt. Varningarna är igång.', 4000);

    // Tidsstämpel per körning. Den gamla vanestatistiken sparar bara
    // "dag-timme → antal", utan tidpunkt, och då går varken spann eller
    // andel att räkna — och utan dem kan appen inte skilja ett mönster från
    // ett sammanträffande.
    const k = readJSON('pv.korningar.v1', []);
    k.push(Date.now());
    writeJSON('pv.korningar.v1', k.slice(-400));
    korvanor.larIn(k);
    senasteKorning = Date.now();
    writeJSON('pv.korvanor.v1', korvanor.toJSON());
    renderDriveStatus();

    /*
     * Berätta för servern, så påminnelsen blir sann.
     *
     * Två anrop som fanns färdiga i push.js men aldrig gjordes någonstans.
     * Följden var att hela den serverdrivna påminnelsen byggde på vad som råkade
     * laddas upp den allra första gången notiser slogs på:
     *
     *   syncSlots      Ändrade du arbetstider fick servern aldrig veta det.
     *                  Påminnelsen kom på gamla tider för alltid.
     *   markDroveToday Det här är det som får servern att hoppa över dagens
     *                  lucka när du redan satt dig i bilen. Utan det plingar
     *                  den 07:15 fast du körde 07:05 — och en påminnelse om
     *                  något man redan gjort lär användaren att notiserna inte
     *                  är värda att läsa. Sen stängs de av.
     *
     * Båda är tysta no-op när notiser inte är påslagna.
     *
     * Luckorna kommer från korvanor när den lärt sig tillräckligt, annars
     * från den grova vanekartan.
     */
    const luckor = korvanor.slots;
    Push.syncSlots(luckor?.length ? luckor : driving.habits);
    Push.markDroveToday();
  });
  driving.addEventListener('stop', renderDriveStatus);

  // Kollar en gång i minuten om vi är inne i ett inlärt fönster. Modulen
  // håller själv reda på tak per dygn, avstånd mellan påminnelser, natt och
  // att den inte säger till medan du redan kör.
  setInterval(() => {
    if (!settings.driveReminder) return;
    const b = korvanor.prova({
      korNu: driving.driving,
      appFramme: document.visibilityState === 'visible',
      senastKord: senasteKorning,
    });
    if (!b.paminn) return;
    driving.notify('Polisvakt', b.text);
    korvanor.noteraSkickat(b);
    writeJSON('pv.korvanor.v1', korvanor.toJSON());
  }, 60000);

  // Appen öppen men ljudet av, och bilen börjar rulla: säg till en gång.
  driving.addEventListener('prompt', () => {
    if (!settings.driveReminder) return;
    speaker.chime('listen');
    speaker.say('Du kör nu. Varningarna är avstängda — slå på ljudet om du vill höra dem.', { priority: 2 });
    toast('Varningarna är tystade. Tryck på högtalaren för att slå på dem.', 8000);
  });
}

function renderDriveStatus() {
  const el = $('driveStatus');
  if (!el) return;
  const h = driving.habitStrength;
  // Antalet läggs bara till när det finns något att räkna. Annars står det
  // "Inga körningar noterade än. (0 körningar noterade)", vilket säger samma
  // sak två gånger och låter som ett fel.
  el.textContent = driving.driving
    ? 'Kör just nu.'
    : korvanor.beskrivning + (h.drives ? ` (${h.drives} körningar noterade)` : '');
}

/* ================= Rutt ================= */
/*
 * Skillnaden mot vanliga varningar: här räknas avståndet LÄNGS vägen, inte
 * fågelvägen. En patrull tvåhundra meter bort på en parallellgata du aldrig
 * kör förbi är brus. En patrull fyra kilometer fram på din egen väg är det
 * mest användbara appen kan säga.
 */
function wireRoute() {
  const input = $('routeDest');
  const results = $('routeResults');
  const bar = $('routeBar');
  if (!input) return;

  const showRoute = () => {
    const r = routeGuide.publicRoute();
    bar.hidden = !r;
    if (!r) return;
    $('routeText').textContent = routeGuide.describe();
  };

  // Nominatims villkor förbjuder uppslag för varje tangenttryck. suggest()
  // svarar därför bara från cache och tidigare platser — nätet rörs först
  // när man faktiskt skickar sökningen.
  input.addEventListener('input', () => {
    const rows = routeGuide.suggest(input.value, geo.position);
    renderRouteResults(rows, results);
  });

  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    await searchDestination(input.value, results);
  });

  $('routeSearch')?.addEventListener('click', () => searchDestination(input.value, results));

  $('routeClear')?.addEventListener('click', () => {
    routeGuide.clearRoute();
    input.value = '';
    results.innerHTML = '';
    showRoute();
    toast('Rutten är avslutad.');
  });

  results.addEventListener('click', async e => {
    const li = e.target.closest('li[data-lat]');
    if (!li) return;
    results.innerHTML = '';
    input.value = li.dataset.label || '';
    toast('Beräknar rutt…');
    try {
      await routeGuide.setDestination({
        lat: +li.dataset.lat, lon: +li.dataset.lon, label: li.dataset.label,
      }, geo.position);
    } catch { toast('Kunde inte beräkna rutten.', 5000); }
  });

  routeGuide.addEventListener('route', e => {
    showRoute();
    nyNavRutt(e.detail?.reason === 'recalc' ? 'omberakning' : 'ny');
    toast('Rutt klar.');
  });
  routeGuide.addEventListener('route-cleared', () => {
    showRoute();
    nav.rensa();
    renderNav(null);
    map.rensaRutt();
  });
  routeGuide.addEventListener('progress', showRoute);
  routeGuide.addEventListener('recalculating', () => toast('Du lämnade rutten — räknar om.'));
  routeGuide.addEventListener('error', e => toast(e.detail.message, 5000));

  routeGuide.addEventListener('arrived', () => {
    speaker.say('Du är framme.', { priority: 1 });
    showRoute();
  });

  // Ruttvarningen går före allt annat prat: den är tidskritisk på ett sätt
  // som poängsummor och bekräftelser inte är.
  routeGuide.addEventListener('route-alert', e => {
    const d = e.detail || {};
    if (d.spoken && settings.tts) speaker.say(d.spoken, { priority: 2, interrupt: true });
    if (d.text) toast(d.text, 6000);
  });

  store.addEventListener('change', () => routeGuide.onReportsChanged());
  showRoute();
}

async function searchDestination(text, results) {
  const q = String(text || '').trim();
  if (q.length < 3) { toast('Skriv minst tre tecken.'); return; }
  results.innerHTML = '<li class="route-hint">Söker…</li>';
  try {
    const rows = await routeGuide.searchDestinations(q, geo.position);
    if (!rows.length) results.innerHTML = '<li class="route-hint">Hittade ingen sådan plats.</li>';
    else renderRouteResults(rows, results);
  } catch {
    results.innerHTML = '<li class="route-hint">Sökningen misslyckades.</li>';
  }
}

function renderRouteResults(rows, results) {
  results.innerHTML = '';
  for (const r of (rows || []).slice(0, 6)) {
    const li = document.createElement('li');
    li.dataset.lat = r.lat;
    li.dataset.lon = r.lon;
    li.dataset.label = r.label || r.name || '';
    li.textContent = r.label || r.name || '';
    results.appendChild(li);
  }
}

/* ================= Vinter ================= */
/*
 * Halka och vilt. Den hårda delen är inte mätvärdena utan tystnaden: en
 * förare som får höra "halkrisk" var nittionde sekund slutar lyssna, och då
 * har appen gjort honom mindre säker. Modulen varnar en gång när något
 * börjar, och sedan bara om risken faktiskt stiger.
 */
function wireWinter() {
  winter.addEventListener('warning', e => {
    const d = e.detail || {};
    if (!settings.winterOn) return;
    if (d.spoken && settings.tts) speaker.say(d.spoken, { priority: 1 });
    if (d.text) toast(d.text, 7000);
  });
  winter.addEventListener('error', () => { /* tyst: väder får aldrig stoppa appen */ });
}

/* ================= Vakthund ================= */
/*
 * Säger till när appen slutat kunna varna.
 *
 * Kontrollen körs på en timer och inte per position — hela poängen är att
 * upptäcka att positioner UTEBLIR, och då kommer det inga anrop att hänga
 * kontrollen på.
 */
function wireVakthund() {
  vakthund.koppla();   // batteriövervakning där den finns

  const sag = e => {
    const d = e.detail || {};
    // Prioritet 2: det här går före poäng och bekräftelser. Att appen slutat
    // varna är viktigare än allt annat den har att säga.
    if (d.spoken && settings.tts) speaker.say(d.spoken, { priority: 2, interrupt: true });
    if (d.text) toast(d.text, 7000);
  };
  vakthund.addEventListener('warning', sag);
  vakthund.addEventListener('recovered', sag);

  setInterval(() => {
    if (!billing.allowed) return;
    vakthund.kontrollera({
      synkFel: store.syncError,
      sistaSynk: store.lastSync,
      delatLage: store.isRemote,
    });
  }, 10000);
}

/* ================= Värmevakt ================= */
/*
 * Telefonen orkar inte allt samtidigt: GPS på hög noggrannhet, tänd skärm,
 * video i 30 bilder per sekund och H.264 — i solen bakom en vindruta. När den
 * börjar strypa sig är valet inte "full kvalitet eller inte", utan "sämre film
 * eller ingen film". Vakten föreslår, appen utför, föraren får veta en gång.
 *
 * Vakten rör aldrig dashcam eller GPS själv. Den säger vad den vill ha gjort,
 * och det är här det faktiskt görs — annars går det inte att se i efterhand
 * vem som ändrade vad.
 */
function wireVarmevakt() {
  varmevakt.koppla();
  varmevakt.observera(dashcam);

  varmevakt.addEventListener('rekommendation', e => {
    const d = e.detail || {};
    const a = d.atgard;
    let utfort = false;

    if (a?.modul === 'dashcam') {
      // Bara om dashcamen faktiskt är igång. Att skruva på inställningar för
      // något som inte spelar in är att låtsas göra något.
      if (a.satt === 'stopp') {
        if (dashcam.recording) { dashcam.stop(); utfort = true; }
      } else if (dashcam.recording || a.satt === 'dual') {
        dashcam.setSetting(a.satt, a.varde);
        utfort = true;
      }
    } else if (a?.modul === 'geo') {
      // GPS-noggrannheten sitter i watchPosition och går inte att ändra i
      // efterhand — den måste startas om. Det är billigt, men får bara ske
      // när det verkligen behövs, för under omstarten kommer inga positioner.
      try { geo.stop(); geo.start({ highAccuracy: false }); utfort = true; } catch {}
    }

    varmevakt.stegUtfort(d.id, utfort);
    if (d.spoken && settings.tts) speaker.say(d.spoken, { priority: 1 });
    if (d.text) toast(d.text, 6000);
  });

  varmevakt.addEventListener('atergang', e => {
    const d = e.detail || {};
    const a = d.atgard;
    if (a?.modul === 'dashcam' && dashcam.recording) dashcam.setSetting(a.satt, a.varde);
    if (a?.modul === 'geo') { try { geo.stop(); geo.start(); } catch {} }
    if (d.spoken && settings.tts) speaker.say(d.spoken, { priority: 0 });
    if (d.text) toast(d.text, 5000);
  });

  // Vakten är bara meningsfull medan något tungt körs.
  dashcam.addEventListener('start', () => { varmevakt.start(); renderOlasta(); });
  dashcam.addEventListener('stop', () => {
    varmevakt.stopp();
    $('dcChatt').hidden = true;
    renderOlasta();
  });

  setInterval(() => { if (varmevakt.aktiv) varmevakt.kontrollera(); }, 5000);
}

/* ================= Behörigheter ================= */
/*
 * Platstjänster kan inte frågas om i Safari — det finns ingen väg att läsa
 * av tillståndet utan att be om en position. Därför matar vi in sanningen
 * bakvägen: varje position som kommer in bevisar att tillstånd finns, och
 * felkod 1 bevisar att det saknas.
 */
function wirePermissions() {
  try { Behorigheter.koppla(geo); } catch {}
  try { Push.configure({ vapidPublicKey: CONFIG.vapidPublicKey || '' }); } catch {}
}

/* ================= Påminnelsen: plats och notiser ================= */
/*
 * Ägarens krav, ordagrant: "man får inte glömma det".
 *
 * Bakgrunden är en mätning, inte en känsla: det fanns EN enda push-
 * prenumeration i hela databasen, två dagar gammal. Appen hade öppnats om och
 * om igen utan att en enda ny registrerats. Alltså kom ingen förbi
 * notisfrågan — och ingenting i appen sa till om det. Notisfrågan ställdes
 * bara inne i introduktionsguiden, och guiden visas en gång.
 *
 * Vad den här delen gör:
 *   1. Läser av läget vid VARJE start, inte bara den första.
 *   2. Saknas plats eller notiser ska en rad synas högst upp och ligga kvar
 *      tills det är löst. Ingen dölj-knapp och ingen tyst prick — skälet står
 *      i paminnelse() i js/behorigheter.js. Den raden ritas av js/uppstart.js;
 *      den här filen har en likadan som reserv för det fall modulen inte
 *      finns, och bara då.
 *   3. Knappen navigerar: öppnar Inställningar, rullar till kortet "Plats och
 *      notiser" och pekar på rätt knapp med js/peka.js. Det är den vägen som
 *      bor här, och den går att nå utifrån — se hooken i wireBehorigheter().
 *   4. Sitter blockeringen i webbläsaren kan appen inte lösa den. Då visas den
 *      exakta menyvägen för just den telefonen och den webbläsaren, hämtad ur
 *      behorigheter.instruktioner(), och sedan pekas det på knappen där man
 *      provar igen.
 *
 * Vad den ALDRIG gör: påstår att appen kan slå på något åt användaren. En
 * webbsida kan inte bevilja sig själv behörigheter, och den kan inte öppna
 * telefonens inställningar. Varje mening här är skriven för att hålla även
 * efter att föraren märkt det.
 *
 * Fokus/Stör ej finns medvetet inte med. Det går inte att läsa av, så en rad
 * om Fokus skulle ligga kvar för evigt hos alla som aldrig tryckt på
 * bekräfta-knappen i guiden — och en varning som aldrig går att bli av med
 * slutar man se efter en dag. Då är även den om plats och notiser förlorad.
 */

/*
 * Vad pekaren siktar på. Id:na står i index.html i kortet "Plats och notiser".
 * Ändras de där måste de ändras här — det står som kommentar även på det
 * stället.
 */
const BEH_MAL = { plats: 'btnBehPlats', notiser: 'btnBehNotiser' };
const BEH_AVSNITT = 'behRubrik';

/*
 * TVÅ MODULER SOM DEN HÄR DELEN SAMARBETAR MED, och exakt vad som används.
 *
 * js/peka.js
 *   peka(mal, text, { forbered, plats, visaMs })  →  { visad, skal }
 *     mal       id, css-väljare eller elementet. Vi skickar id.
 *     text      EN mening. Pekaren äger mörkläggning, ring och pil.
 *     forbered  körs först — det är här vyn byts och rullningen startas.
 *               peka() väntar sedan själv in elementet och att rullningen
 *               landat, vilket är bättre än en fast fördröjning: sträckan ner
 *               till notisknappen är över tusen pixlar och en mjuk rullning
 *               tar längre tid ju längre den är.
 *     Misslyckas den är den tyst och svarar visad:false. Då märker vi
 *     elementet på egen hand i stället, se pekaPaBehorighet().
 *
 * js/uppstart.js
 *   oppna(status?)  öppnar startguiden igen. Används bara som nödutgång, när
 *                   kortet i inställningarna inte finns att peka på.
 *
 * RADEN HÖGST UPP ÄGS AV js/uppstart.js. Den ritar '.pv-up-rad' med samma
 * placering och samma uppgift som raden här nedanför, och två rader som säger
 * samma sak är samma sak som ingen rad alls. Vår rad är därför en reserv: den
 * ritas bara när uppstart.js inte finns eller inte gick att ladda. Se
 * ritaBehRadNu().
 *
 * Båda modulerna är frivilliga. Saknas de gör den här filen samma sak själv —
 * sämre, men aldrig trasigt. En app som slutar fungera för att en hjälpmodul
 * saknas är en app som slutar varna.
 *
 * De laddas i FÖRVÄG, aldrig inne i ett klick. Ett await import() i en
 * klickhanterare hinner döda gesten, och då visar Safari varken plats- eller
 * notisrutan: man trycker, och ingenting händer.
 */
let Peka = null;
let Uppstart = null;
let behModulerKlara = null;

function forladdaBehModuler() {
  if (behModulerKlara) return behModulerKlara;
  behModulerKlara = Promise.all([
    import('./peka.js').then(m => { Peka = m; }).catch(() => { Peka = false; }),
    import('./uppstart.js').then(m => { Uppstart = m; }).catch(() => { Uppstart = false; }),
  ]);
  return behModulerKlara;
}

const behPaus = ms => new Promise(r => setTimeout(r, ms));

/*
 * Egen stil i en egen <style>, precis som js/platsstart.js gör.
 *
 * Skälet är detsamma: css/app.css ändras av flera händer, och en ny regel där
 * som bara den här raden använder är en regel som ingen vågar ta bort sedan.
 *
 * z-index 889 är valt med omsorg: över tabbaren (800) och versionsbannern
 * (880), men UNDER platsremsan (890), varningsbannern och mörkt körläge (900),
 * modalerna (1000), fordonslarmet (1500) och rundturen (3000). Raden är en
 * påminnelse om något som saknas — den får aldrig lägga sig över något som
 * varnar för verkligheten just nu.
 *
 * Färgen är gul och inte röd, också med flit. Rött är redan taget av
 * platsremsan och av varningsbannern som betyder "polis framför dig". Två
 * röda remsor med helt olika allvar lär föraren att strunta i båda.
 */
const BEH_CSS = `
#pv-beh-rad {
  position: fixed; z-index: 889; left: 0; right: 0; top: 0;
  padding: calc(env(safe-area-inset-top, 0px) + 9px) 12px 9px;
  background: rgba(40,28,6,.94);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(255,176,32,.5);
  display: flex; align-items: center; gap: 10px;
  color: #ffe9c2;
  font: 13.5px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
#pv-beh-rad b { display: block; color: #fff; font-weight: 650; }
#pv-beh-rad .pv-beh-text { flex: 1; min-width: 0; }
#pv-beh-rad button {
  flex: none; border: 1px solid var(--warn, #ffb020); border-radius: 11px;
  padding: 9px 13px; font-size: 13.5px; font-weight: 650; font-family: inherit;
  background: var(--warn, #ffb020); color: #2a1a02; cursor: pointer;
}
/* Reservmarkeringen bor inte längre här.
   Den var en box-shadow som pulsade i 3,45 sekunder: en målad egenskap som
   ritas om varje bildruta, på en telefon som samtidigt ritar en karta och
   läser en videoström. Landningsringen i js/rorelse.js gör samma jobb med
   transform och opacity, och står still när telefonen bett om mindre
   rörelse. Se pekaPaBehorighet(). */
`;

function behCss() {
  if (document.getElementById('pv-beh-stil')) return;
  const s = document.createElement('style');
  s.id = 'pv-beh-stil';
  s.textContent = BEH_CSS;
  document.head.appendChild(s);
}

/* ---- Raden högst upp ---- */

let behRadEl = null;
let behRadRitas = false;
let behKortStatus = null;       // senaste fulla avläsningen, se behKnapp()

function stangBehRad() {
  behRadEl?.remove();
  behRadEl = null;
}

async function ritaBehRad() {
  if (typeof document === 'undefined') return;
  // paminnelse() är asynkron och två anrop kan komma tätt (ett tillstånd som
  // ändras samtidigt som appen kommer i förgrunden). Utan spärren hinner båda
  // se att raden saknas, och då ritas den två gånger.
  if (behRadRitas) return;
  behRadRitas = true;
  try { await ritaBehRadNu(); } finally { behRadRitas = false; }
}

async function ritaBehRadNu() {
  /*
   * Raden är en RESERV. js/uppstart.js ritar '.pv-up-rad' på samma plats, med
   * samma z-index och samma uppgift, och den filen äger frågan. Finns den
   * modulen håller vi tyst — annars står två gula rader ovanpå varandra och
   * säger nästan samma sak, vilket lär föraren att ingen av dem betyder något.
   *
   * Villkoret är på modulen och inte bara på elementet, med flit: uppstart.js
   * ritar sin rad först när dess egen ruta stängts, och under de sekunderna
   * skulle en kontroll av bara elementet släppa fram vår rad för att sedan
   * behöva ta bort den igen.
   */
  if (Uppstart || document.querySelector('.pv-up-rad')) { stangBehRad(); return; }

  /*
   * Plats som saknas har redan en egen röd remsa från js/platsstart.js. Två
   * rader som säger samma sak är samma sak som ingen rad alls — man slutar
   * läsa båda. Ligger den uppe tar den hand om plats, och vi säger bara det
   * den inte täcker. Är notiser då det enda som fattas blir det en rad om
   * notiser; fattas ingenting mer försvinner vår rad helt.
   */
  const remsa = document.querySelector('.pv-ps-remsa');
  const remsanUppe = !!remsa?.getClientRects().length;

  const p = await Behorigheter.paminnelse({
    snabb: true,
    hoppaOver: remsanUppe ? ['plats'] : [],
  });

  if (!p.visa) { stangBehRad(); return; }

  behCss();
  if (!behRadEl) {
    behRadEl = document.createElement('div');
    behRadEl.id = 'pv-beh-rad';
    behRadEl.setAttribute('role', 'status');
    behRadEl.innerHTML =
      '<div class="pv-beh-text"><b></b><span></span></div><button type="button"></button>';
    document.body.appendChild(behRadEl);
  }

  behRadEl.querySelector('b').textContent = p.rubrik;
  behRadEl.querySelector('span').textContent = p.text;

  const knapp = behRadEl.querySelector('button');
  knapp.textContent = p.knapp;
  // Den som saknar både plats och notiser tas till plats först: utan position
  // gör resten av appen ingen nytta ändå.
  knapp.onclick = () => fixaBehorighet(p.saknas[0]);

  stallInBehRadTopp();
}

let behRemsaObs = null;
let behRemsaObserverad = null;

/**
 * Ligger platsremsan uppe lägger vi oss under den i stället för över. Den är
 * rödare och allvarligare, och den ska synas först.
 *
 * Höjden måste mätas om, inte bara en gång. Remsan radbryts olika i stående
 * och liggande läge och på olika telefonbredder — en enda mätning lämnar vår
 * rad svävande med ett glapp under sig, eller ovanpå remsan så att den täcker
 * just det som är allvarligast.
 */
function stallInBehRadTopp() {
  if (!behRadEl) return;

  const remsa = document.querySelector('.pv-ps-remsa');
  const synlig = !!remsa?.getClientRects().length;
  const topp = synlig ? remsa.offsetHeight : 0;

  behRadEl.style.top = topp + 'px';
  // Egen säkerhetsmarginal behövs bara när vi ligger högst upp. Under remsan
  // är den redan avklarad av remsan själv.
  behRadEl.style.paddingTop = topp ? '9px' : '';

  if (!synlig || typeof ResizeObserver !== 'function') {
    behRemsaObs?.disconnect();
    behRemsaObs = null;
    behRemsaObserverad = null;
    return;
  }
  if (behRemsaObserverad === remsa) return;
  behRemsaObs?.disconnect();
  behRemsaObs = new ResizeObserver(() => stallInBehRadTopp());
  behRemsaObs.observe(remsa);
  behRemsaObserverad = remsa;
}

/* ---- Navigeringen: "Fixa det" ---- */

/**
 * Öppnar Inställningar, rullar till kortet "Plats och notiser" och pekar på
 * knappen.
 *
 * Frågan om behörighet ställs INTE härifrån, med flit. Dels måste gesten vara
 * levande i det ögonblick webbläsarens ruta ska visas, och den här vägen har
 * både en vy-växling och en mjuk rullning i sig. Dels är det halva poängen att
 * föraren ska se VAR reglaget sitter, så att hen hittar tillbaka själv nästa
 * gång i stället för att leta efter en gul rad som förhoppningsvis dyker upp.
 */
async function fixaBehorighet(nyckel = 'plats') {
  await pekaPaBehorighet(nyckel, {
    forbered: async () => {
      /* oppnaInstallning() och inte showView + scrollIntoView: kortet kan
         ligga i en hopfälld grupp, och då rullar scrollIntoView ingenstans
         utan att säga till. Anropet är synkront hela vägen — pekaren väntar
         in elementet själv, men den här funktionen får inte lämna ifrån sig
         kontrollen mitt i en gest. */
      oppnaInstallning(BEH_AVSNITT);

      // Snabb ritning här, med flit. Den fulla frågar service workern om
      // prenumerationen och den kollen får ta upp till tio sekunder — knappen
      // ska ha rätt text när pilen kommer, inte när servern svarat.
      // showView() ovanför har redan startat den fulla ritningen i bakgrunden.
      await ritaBehKort({ snabb: true });
    },
  });
}

/**
 * Peka ut knappen. Bubbeltexten säger vad som händer när man trycker, och den
 * skiljer sig åt: ibland visar telefonen en ruta, ibland kan appen bara visa
 * en menyväg. Att lova det första när det andra gäller är precis den sortens
 * löfte den här filen inte får ge.
 */
async function pekaPaBehorighet(nyckel, { forbered = null } = {}) {
  const mal = BEH_MAL[nyckel];
  const s = nyckel === 'plats' ? behKortStatus?.plats : behKortStatus?.notiser;
  const a = Behorigheter.atgard(s);

  // EN mening, och den lovar bara det som faktiskt händer när man trycker.
  // Att skriva "svara Tillåt" när rutan är förbrukad vore att skicka föraren
  // att vänta på något som aldrig kommer.
  const text =
    a.typ === 'fraga' ? 'Tryck här. Telefonen frågar sedan om lov — svara Tillåt.'
    : a.typ === 'hemskarm' ? 'Tryck här, så visar vi hur du lägger Polisvakt på hemskärmen.'
    : a.typ === 'installningar' ? 'Appen kan inte slå på det åt dig. Tryck här, så visar vi exakt var inställningen sitter i din telefon.'
    : nyckel === 'plats' ? 'Här sitter platsinställningen.' : 'Här sitter notisinställningen.';

  if (typeof Peka?.peka === 'function') {
    // peka() öppnar vyn via forbered, väntar in elementet och rullar fram det
    // själv. Den är tyst när den misslyckas, så svaret måste läsas.
    const res = await Peka.peka(mal, text, { forbered, visaMs: 10000 }).catch(() => null);
    if (res?.visad) return;
  } else if (forbered) {
    try { await forbered(); } catch {}
  }

  const el = $(mal);
  if (!el) {
    // Kortet finns inte i den här versionen av index.html. Då är det bättre
    // att låta uppstart.js ställa frågan i sin egen ruta än att peka på tomma
    // luften.
    if (typeof Uppstart?.oppna === 'function') Uppstart.oppna();
    return;
  }

  /*
   * Reserv utan pil: ta fram knappen och ringa in den. Sämre, men föraren
   * står inte utan väg.
   *
   * Gick tidigare via scrollIntoView + en blinkande box-shadow i 3,45
   * sekunder. Två fel i ett: box-shadow ritas om varje bildruta medan kartan
   * och dashcamen redan tävlar om samma bildrutor, och en markering som
   * pulsar i över tre sekunder blir en sak man lär sig titta förbi.
   * Rorelse.landa() gör samma jobb med transform och opacity på en halv
   * sekund — och står still i stället för att pulsa när telefonen bett om
   * mindre rörelse.
   */
  oppnaInstallning(el);
}

/* ---- Kortet i inställningarna ---- */

/**
 * Ritar om raderna för plats och notiser.
 *
 * Full status, inte snabb: prenumerationen räknas här. Ett "Påslaget" som
 * bygger på snabbStatus() skulle visa en fungerande prenumeration som
 * avstängd — se kommentaren vid snabb i notisStatus().
 */
async function ritaBehKort({ snabb = false } = {}) {
  const platsKnapp = $('btnBehPlats');
  const notisKnapp = $('btnBehNotiser');
  if (!platsKnapp || !notisKnapp) return;

  const st = await Behorigheter.status({ snabb });
  // Märk avläsningen. En snabb status sätter prenumererad: false utan att ha
  // kollat, och utan märket skulle behAtgard() läsa det som en trasig
  // prenumeration och erbjuda att laga något som inte är sönder.
  st.notiser.snabbLast = snabb;
  behKortStatus = st;

  sattBehRadIKort('plats', st.plats, platsKnapp, $('behPlatsText'));
  sattBehRadIKort('notiser', st.notiser, notisKnapp, $('behNotisText'));
}

/** Vilken åtgärd knappen står för just nu. Läses även av behKnapp(). */
function behAtgard(nyckel, s) {
  const a = Behorigheter.atgard(s);

  /*
   * Ett läge till som atgard() inte kan se, eftersom det inte är ett
   * behörighetsläge: tillståndet finns, men servern har ingen rad för den här
   * telefonen. Då ser allt påslaget ut och ingenting kommer fram när appen är
   * stängd. Det är det enda tillfället då en grön punkt ljuger, och därför får
   * det en egen knapp.
   */
  if (nyckel === 'notiser' && a.typ === 'klart' && s?.prenumererad === false
      && !s.snabbLast && Push.capabilities().fix !== 'server') {
    return {
      typ: 'laga',
      knapp: 'Registrera telefonen',
      rubrik: 'Notiser når inte fram',
      forklaring: 'Tillståndet finns, men servern har ingen rad för den här telefonen. Då kommer ingenting fram när appen är stängd.',
    };
  }
  return a;
}

function sattBehRadIKort(nyckel, s, knapp, text) {
  const a = behAtgard(nyckel, s);

  if (text) text.textContent = behKortText(nyckel, s, a);

  /*
   * En snabb avläsning får aldrig gömma knappen.
   *
   * fixaBehorighet() ritar kortet snabbt i sitt forbered-steg för att pilen
   * ska komma fram utan att vänta in service workern. Snabb status sätter
   * prenumererad: false utan att ha kollat, så notiser såg ut som "klart" —
   * och då gömdes just den knapp peka.js sedan letade efter. Resultatet var
   * det värsta möjliga i precis det läge mätningen visade (tillstånd men ingen
   * prenumeration): Inställningar utan pil, utan blinkning och utan knapp.
   *
   * "omojligt" gömmer vi ändå: att stödet saknas i telefonen är inget en full
   * avläsning kan ändra på.
   */
  const snabbtKlart = a.typ === 'klart' && !!s?.snabbLast;
  if (a.typ === 'omojligt') knapp.hidden = true;
  else if (!snabbtKlart) knapp.hidden = a.typ === 'klart';

  knapp.disabled = false;
  // Texten står kvar som den var när läget är "klart" enligt en snabb
  // avläsning: a.knapp är tom då, och en knapp utan text är inget att peka på.
  if (!knapp.hidden && !snabbtKlart) knapp.textContent = a.knapp;
}

function behKortText(nyckel, s, a) {
  if (a.typ === 'klart') {
    if (nyckel !== 'notiser') return s.text;
    // s.reason är satt av notisStatus() när tillståndet finns men servern inte
    // kan skicka något. Den texten är redan ärlig — skriv ingen egen.
    if (s.reason) return s.reason;
    return s.prenumererad
      ? 'Påslaget. Du kan få en notis även när appen är stängd. Appen varnar däremot aldrig i bakgrunden — den måste vara öppen för det.'
      : 'Notiser är tillåtna.';
  }
  return a.forklaring || s?.text || '';
}

/**
 * Knappen i kortet. Här sitter gesten.
 *
 * Läget läses ur den senaste ritningen (behKortStatus) i stället för att
 * hämtas om på nytt. Ett await här skulle döda gesten, och då visar Safari
 * ingen ruta alls — man trycker, och ingenting händer. Ritningen är färsk:
 * kortet ritas om varje gång inställningarna öppnas, varje gång något
 * tillstånd ändras och varje gång appen kommer i förgrunden.
 */
function behKnapp(nyckel) {
  const s = nyckel === 'plats' ? behKortStatus?.plats : behKortStatus?.notiser;
  const a = behAtgard(nyckel, s);

  if (a.typ === 'hemskarm' || a.typ === 'installningar') { visaMenyvag(nyckel); return; }
  if (a.typ === 'omojligt' || a.typ === 'klart') return;

  if (nyckel === 'plats') {
    Behorigheter.markeraPlatsFragad();
    // INGET await ovanför den här raden.
    Behorigheter.begarPlats().then(res => efterBehSvar('plats', res));
    return;
  }

  Behorigheter.markeraNotisFragad();
  let id = null;
  try { id = deviceId(); } catch {}
  // Samma sak här: begarNotiser() ber om lov som första sak den gör.
  Behorigheter.begarNotiser({ deviceId: id, habits: driving.habits })
    .then(res => efterBehSvar('notiser', res));
}

async function efterBehSvar(nyckel, res) {
  /*
   * Snabb ritning först, full efteråt utan att vänta.
   *
   * Den fulla frågar service workern om prenumerationen, och den kollen har
   * tio sekunders tak. Föraren har just tryckt på en knapp och ska få ett svar
   * nu, inte när service workern vaknat.
   */
  await ritaBehKort({ snabb: true });
  ritaBehKort();
  ritaBehRad();

  if (res?.ok && nyckel === 'notiser') {
    // Visa direkt att kedjan går hela vägen. En påminnelse man sett en gång
    // är en påminnelse man känner igen klockan sex på morgonen.
    try { driving.notify('Polisvakt', 'Så här ser en påminnelse ut när du brukar köra.'); } catch {}
  }
  if (res?.ok) { toast(nyckel === 'plats' ? 'Plats är påslagen.' : 'Notiser är påslagna.'); return; }

  // Nekat: webbläsaren frågar aldrig igen. Gå direkt vidare till menyvägen i
  // stället för att lämna föraren med en knapp som inte längre gör något.
  if (res?.fix === 'installningar') { visaMenyvag(nyckel); return; }
  if (res?.reason) toast(res.reason, 6000);
}

/* ---- Menyvägen, när blockeringen sitter i webbläsaren ---- */

/**
 * Exakta steg för just den här webbläsaren och telefonen.
 *
 * Texten kommer från behorigheter.instruktioner(). Appen får aldrig ha en
 * andra uppsättning menyvägar — de glider isär, och en felaktig menyväg är
 * sämre än ingen alls: föraren letar, hittar inte, och drar slutsatsen att
 * appen ljuger. Av samma skäl går iPhone-fallet hit och inte till
 * installationsguidens egen text om hemskärmen.
 *
 * Rutan får klassen .modal av två skäl: den ärver appens egen modalstil, och
 * js/platsstart.js väntar på just den selektorn innan den ritar sin egen ruta
 * ovanpå.
 */
function visaMenyvag(nyckel) {
  const info = Behorigheter.instruktioner(nyckel);

  const skarm = document.createElement('div');
  skarm.className = 'modal';
  skarm.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      <h2></h2>
      <p class="pv-beh-inled"></p>
      <ol class="guide-steps"></ol>
      <p class="hint guide-note"></p>
      <div class="modal-actions">
        <button class="btn-primary" type="button">Jag har slagit på det</button>
        <button class="btn-ghost" type="button">Stäng</button>
      </div>
    </div>`;

  skarm.querySelector('h2').textContent = info.rubrik;
  skarm.querySelector('.pv-beh-inled').textContent =
    'Appen kan inte ändra det här åt dig. Ingen webbsida får öppna telefonens inställningar — de här stegen måste du göra själv.';

  const lista = skarm.querySelector('.guide-steps');
  info.steg.forEach((steg, i) => {
    const li = document.createElement('li');
    const nr = document.createElement('span');
    nr.className = 'g-ico';
    nr.textContent = String(i + 1);
    const txt = document.createElement('span');
    txt.textContent = steg;
    li.append(nr, txt);
    lista.appendChild(li);
  });

  const not = skarm.querySelector('.guide-note');
  if (info.not) not.textContent = info.not;
  else not.remove();

  const stang = () => skarm.remove();

  const efterat = async () => {
    stang();
    // Snabb ritning, av samma skäl som i efterBehSvar(): pilen ska upp direkt.
    await ritaBehKort({ snabb: true });
    ritaBehKort();
    ritaBehRad();
    const s = nyckel === 'plats' ? behKortStatus?.plats : behKortStatus?.notiser;
    // Fortfarande inte löst: peka på knappen där man provar igen, i stället
    // för att bara stänga rutan och lämna föraren där hen började.
    if (!s?.ok) pekaPaBehorighet(nyckel);
    else toast(nyckel === 'plats' ? 'Plats är påslagen.' : 'Notiser är påslagna.');
  };

  skarm.querySelector('.btn-primary').onclick = () => {
    /*
     * Plats går att verifiera på riktigt, och i Safari är det enda sättet:
     * svarar telefonen med en position finns tillståndet. Anropet ligger direkt
     * i klicket av samma skäl som överallt annars.
     *
     * Notiser går inte att fråga om igen efter ett nej — där kan vi bara läsa
     * av Notification.permission på nytt, vilket ritningen gör.
     */
    if (nyckel === 'plats') Behorigheter.begarPlats().then(efterat);
    else efterat();
  };
  skarm.querySelector('.btn-ghost').onclick = stang;

  document.body.appendChild(skarm);
}

/* ---- Start ---- */

/**
 * Tillståndet finns men prenumerationen saknas — laga tyst vid start.
 *
 * Ingen ruta visas: push.enable() frågar om lov, och när svaret redan är
 * 'granted' returnerar webbläsaren direkt utan att visa något. Det här är
 * halva förklaringen till den enda prenumerationen i databasen — knappen i
 * inställningarna bad förut bara om tillstånd, utan att prenumerera.
 */
async function lagaNotisprenumeration() {
  let id = null;
  try { id = deviceId(); } catch {}
  if (!id) return;
  try {
    const res = await Behorigheter.lagaNotiser({ deviceId: id, habits: driving.habits });
    if (res?.lagad) ritaBehKort();
  } catch {}
}

/**
 * Vänta innan reservraden ritas.
 *
 * Under de första sekunderna ställer js/uppstart.js frågorna själv och
 * js/platsstart.js sin. Att lägga en påminnelse ovanpå någon som just håller
 * på att göra precis det vi ber om är att tjata. Fyra sekunder räcker för att
 * hjälpmodulerna ska hinna säga ifrån att de finns — sedan avgör
 * ritaBehRadNu() om raden alls hör hemma här.
 */
const vantaInnanRad = () => behPaus(4000);

async function wireBehorigheter() {
  behCss();
  forladdaBehModuler();

  $('btnBehPlats')?.addEventListener('click', () => behKnapp('plats'));
  $('btnBehNotiser')?.addEventListener('click', () => behKnapp('notiser'));

  const ritaOm = () => { ritaBehRad(); ritaBehKort(); };

  Behorigheter.events.addEventListener('andrad', ritaOm);

  // Föraren kan ha varit inne i telefonens inställningar och löst det. Då ska
  // raden vara borta när hen kommer tillbaka, inte stå kvar och ha fel.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ritaOm();
  });

  // Bredden ändras när telefonen vrids, och då byter platsremsan höjd.
  addEventListener('resize', stallInBehRadTopp);
  addEventListener('orientationchange', stallInBehRadTopp);

  /*
   * En långsam puls utöver händelserna. Två saker fångas bara här: att
   * platsremsan i js/platsstart.js dykt upp eller försvunnit (den skickar
   * ingen händelse), och att en modal eller guiden legat i vägen när vi ville
   * rita. Åtta sekunder är billigt — kollen är ett permissions.query och en
   * läsning av Notification.permission, inget nätanrop.
   */
  setInterval(() => {
    if (document.visibilityState === 'visible') ritaBehRad();
  }, 8000);

  /*
   * Navigeringen som en seam utåt.
   *
   * Raden högst upp ägs av js/uppstart.js, och den filen känner inte till den
   * här funktionen. Hooken finns så att den — eller vad som helst annat i
   * appen — ska kunna skicka föraren till rätt reglage utan att importera
   * app.js, vilket inte går: app.js importerar allt annat, inte tvärtom.
   *
   *   window.polisvakt.fixaBehorighet('notiser')
   *   dispatchEvent(new CustomEvent('polisvakt:fixa', { detail: { nyckel: 'plats' } }))
   */
  window.polisvakt = Object.assign(window.polisvakt || {}, { fixaBehorighet });
  addEventListener('polisvakt:fixa', e => fixaBehorighet(e.detail?.nyckel || 'plats'));

  ritaBehKort();

  await forladdaBehModuler();
  await vantaInnanRad();
  ritaBehRad();
  lagaNotisprenumeration();
}

function renderWinterStatus() {
  const el = $('winterStatus');
  if (!el) return;
  if (!settings.winterOn) { el.textContent = 'Avstängt.'; return; }
  const s = winter.status || {};
  el.textContent = s.hamtad
    ? `Prognos hämtad ${relativeTime(s.hamtad)}.`
    : 'Prognosen hämtas när du börjar köra.';
}

/* ================= Grupper ================= */

function wireGroups() {
  const list = $('groupList');
  if (!list) return;

  /*
   * Var hamnar mina rapporter?
   *
   * Datavägen fanns men ingen kunde välja — group_id blev null för alla, och
   * en grupp utan rapporter är ingen grupp. Väljaren är det som gör
   * funktionen verklig.
   *
   * Publikt är utgångsläget och kan inte ändras av misstag: valet visas bara
   * när man faktiskt är med i en grupp, och texten under säger rakt ut vad
   * som gäller. En förare som tror att hen varnar alla, men bara varnar fyra
   * kollegor, har fått en sämre app utan att förstå varför.
   */
  const renderMal = () => {
    const rows = groups.groups || [];
    const rad = $('groupTargetRow');
    const sel = $('groupTarget');
    const not = $('groupTargetNote');
    if (!rad || !sel) return;

    rad.hidden = rows.length === 0;
    not.hidden = rows.length === 0;
    if (!rows.length) return;

    const valt = groups.aktivId || '';
    sel.innerHTML = '';
    sel.add(new Option('Alla i Västmanland (publikt)', ''));
    for (const g of rows) sel.add(new Option(g.namn || g.name || 'Grupp', g.id));
    sel.value = valt;

    not.textContent = valt
      ? `Dina rapporter syns bara för ${sel.options[sel.selectedIndex].text}. Ingen annan varnas.`
      : 'Dina rapporter syns för alla förare i närheten.';
  };

  $('groupTarget')?.addEventListener('change', e => {
    groups.setAktiv(e.target.value || null);
    renderMal();
    toast(e.target.value
      ? 'Nya rapporter går till gruppen.'
      : 'Nya rapporter går till alla igen.', 3500);
  });

  const render = () => {
    const rows = groups.groups || [];
    $('groupEmpty').hidden = rows.length > 0;
    renderMal();
    list.innerHTML = '';
    for (const g of rows) {
      const div = document.createElement('div');
      div.className = 'group-row';
      const namn = document.createElement('span');
      namn.textContent = g.namn || g.name || 'Grupp';
      div.appendChild(namn);

      if (groups.isOwner(g.id)) {
        const inv = document.createElement('button');
        inv.className = 'btn-ghost small';
        inv.textContent = 'Kod';
        inv.onclick = async () => {
          const r = await groups.invite(g.id);
          if (r?.ok) {
            // Koden visas, inte kopieras tyst. Ägaren ska se exakt vad hen
            // delar ut — en kod som läcker öppnar hela gruppen.
            //
            // Koden ligger i r.invite.kod. Den här raden läste r.kod och
            // r.code, som båda är undefined, så rutan sa "Inbjudningskod:
            // undefined" och ingen kunde bjuda in någon. Funktionen stod
            // ändå som färdig — felet syntes bara för den som faktiskt
            // tryckte på knappen.
            const kod = r.invite?.kod;
            $('groupStatus').textContent = kod
              ? `Inbjudningskod: ${kod}`
              : 'Gruppen har ingen aktiv inbjudningskod just nu.';
          } else {
            $('groupStatus').textContent = r?.error || 'Kunde inte hämta koden.';
          }
        };
        div.appendChild(inv);
      }

      const ut = document.createElement('button');
      ut.className = 'btn-ghost small danger';
      ut.textContent = 'Lämna';
      ut.onclick = async () => {
        const r = await groups.leave(g.id);
        $('groupStatus').textContent = r?.ok ? 'Du lämnade gruppen.' : (r?.error || 'Gick inte att lämna.');
      };
      div.appendChild(ut);
      list.appendChild(div);
    }
  };

  groups.addEventListener('change', render);

  $('btnGroupJoin').addEventListener('click', async () => {
    const r = await groups.join($('groupCode').value);
    $('groupStatus').textContent = r?.ok ? 'Du är med i gruppen.' : (r?.error || 'Koden gick inte att lösa in.');
    if (r?.ok) $('groupCode').value = '';
  });

  $('btnGroupCreate').addEventListener('click', async () => {
    const r = await groups.create($('groupName').value);
    $('groupStatus').textContent = r?.ok ? 'Gruppen är skapad.' : (r?.error || 'Kunde inte skapa gruppen.');
    if (r?.ok) $('groupName').value = '';
  });

  render();
  // Grupper kräver inloggning. Hämta först när vi vet att någon är inloggad,
  // annars svarar servern 401 och användaren får ett fel utan orsak.
  if (auth.session?.access_token) groups.refresh().catch(() => {});
}

/* ================= Facebook-grupper ================= */

/*
 * Ägarens ord: "viktigt att andra som kör appen kan connecta till flera
 * olika grupper på facebook. T.ex någon som kör i Stockholm ska kunna
 * connecta sthlm gruppen etc."
 *
 * Det här är styrpanelen. Själva läsningen sker i tools/fb-bridge.user.js,
 * som körs på facebook.com och inte kan importera något härifrån. Appen äger
 * listan, bryggan läser den — och överföringen sker genom att ägaren
 * kopierar en rad och klistrar in den i användarskriptet. Det är inte
 * elegant, men det är den enda vägen: appen ligger på polisvakt.pages.dev
 * och kommer aldrig åt en flik på facebook.com.
 *
 * VARFÖR VARJE GRUPP MÅSTE BÄRA ETT OMRÅDE
 *
 * En Facebook-grupp handlar om en trakt. Utan att veta vilken kan bryggan
 * inte slå upp "Storgatan" — den gatan finns i varenda svensk stad, och en
 * varning på fel plats är värre än ingen varning alls: föraren bromsar i
 * onödan och slutar lita på appen efter två sådana.
 *
 * VARFÖR EN RUTA OCH INTE rutkod() FRÅN chatt.js
 *
 * Appen har redan en geografisk indelning, och den var första kandidaten:
 * chatt.js delar landet i rutor på 0,25° × 0,5° och beskriver en trakt med
 * en kod som "r238x33" (Västerås). Den är utmärkt till sitt syfte — den
 * säger "trakten" utan att avslöja "platsen", vilket är hela poängen när
 * ett chattmeddelande ska hitta rätt läsare utan att bli en rörelselogg.
 *
 * Men den passar inte här, och det är mätt snarare än tyckt. Ett
 * Facebook-grupps upptagningsområde är ungefär ett län. Uttryckt i
 * chattrutor blir Västmanland antingen för litet eller för stort:
 *
 *   • Den egna rutan plus de åtta grannarna (samma 3×3 som chatten
 *     använder för "nära mig") ger lon 16,0–17,5 och lat 59,25–60,00.
 *     Det klipper bort Köping, Arboga och Fagersta — alla ligger väster
 *     om longitud 16,0 och alla ligger i gruppens område i verkligheten.
 *   • 5×5 rutor ger lon 15,5–18,0, och longitud 18,0 ligger mitt i
 *     Stockholm. Då är vi tillbaka i felet vi försöker undvika.
 *
 * Rutnätet kan alltså inte uttrycka den avgränsning bryggan redan kör med
 * ([15,10 59,30 17,30 60,30]), och att krympa ägarens verkliga täckning för
 * att få återanvända en funktion vore en försämring utklädd till snygg kod.
 *
 * Alltså: en rektangel per grupp, samma form som bryggans ruta redan har.
 * Ägaren väljer den ur en lista över län — han ska inte behöva veta vad en
 * longitud är. Rutkoden lever kvar där den hör hemma, i chatten.
 */

/* ==PV-FB-GRUPPER-START==
 * Allt mellan markörerna är rena funktioner utan beroenden. test.html hämtar
 * app.js som text, skär ut det här stycket och kör det för sig — annars
 * hade testet behövt starta hela appen, med DOM och allt, för att mäta en
 * tabell med koordinater. Lägg ingenting härinne som rör DOM:en, settings
 * eller någon import.
 */

/**
 * Färdiga områden att välja mellan. Rutan är [lonMin, latMin, lonMax, latMax]
 * — samma ordning som Nominatims viewbox, så den kan skickas rakt in.
 *
 * Rutorna är grova med flit. De ska svara på "kan den här varningen höra
 * hemma i den här gruppen?", inte rita en länsgräns. En ruta som är lite för
 * stor kostar ingenting; en som är för liten tappar varningar i utkanten,
 * och det är den dyrare av de två.
 *
 * Västmanland står först och siffrorna är oförändrade sedan bryggans 2.2.
 * Den som uppgraderar ska få exakt samma avgränsning som förut.
 */
const FB_REGIONER = [
  { nyckel: 'vastmanland',    namn: 'Västmanland',        ort: 'Västerås',     ruta: [15.10, 59.30, 17.30, 60.30] },
  { nyckel: 'stockholm',      namn: 'Stockholms län',     ort: 'Stockholm',    ruta: [17.20, 58.80, 19.30, 60.20] },
  { nyckel: 'uppsala',        namn: 'Uppsala län',        ort: 'Uppsala',      ruta: [16.60, 59.60, 18.60, 60.70] },
  { nyckel: 'sodermanland',   namn: 'Södermanland',       ort: 'Eskilstuna',   ruta: [15.60, 58.60, 17.90, 59.60] },
  { nyckel: 'ostergotland',   namn: 'Östergötland',       ort: 'Linköping',    ruta: [14.50, 57.80, 17.20, 59.00] },
  { nyckel: 'orebro',         namn: 'Örebro län',         ort: 'Örebro',       ruta: [14.10, 58.70, 15.90, 60.10] },
  { nyckel: 'vastragotaland', namn: 'Västra Götaland',    ort: 'Göteborg',     ruta: [11.00, 57.00, 14.60, 59.20] },
  { nyckel: 'skane',          namn: 'Skåne',              ort: 'Malmö',        ruta: [12.40, 55.30, 14.60, 56.60] },
  { nyckel: 'halland',        namn: 'Halland',            ort: 'Halmstad',     ruta: [11.90, 56.35, 13.60, 57.60] },
  { nyckel: 'jonkoping',      namn: 'Jönköpings län',     ort: 'Jönköping',    ruta: [13.10, 56.90, 15.90, 58.20] },
  { nyckel: 'kronoberg',      namn: 'Kronoberg',          ort: 'Växjö',        ruta: [13.30, 56.30, 15.90, 57.30] },
  { nyckel: 'kalmar',         namn: 'Kalmar län',         ort: 'Kalmar',       ruta: [15.20, 56.10, 17.20, 58.20] },
  { nyckel: 'blekinge',       namn: 'Blekinge',           ort: 'Karlskrona',   ruta: [14.30, 55.90, 16.20, 56.60] },
  { nyckel: 'gotland',        namn: 'Gotland',            ort: 'Visby',        ruta: [17.90, 56.80, 19.40, 58.00] },
  { nyckel: 'varmland',       namn: 'Värmland',           ort: 'Karlstad',     ruta: [11.60, 58.70, 14.60, 61.10] },
  { nyckel: 'dalarna',        namn: 'Dalarna',            ort: 'Falun',        ruta: [12.10, 59.80, 16.70, 62.30] },
  { nyckel: 'gavleborg',      namn: 'Gävleborg',          ort: 'Gävle',        ruta: [14.50, 60.20, 17.60, 62.30] },
  { nyckel: 'vasternorrland', namn: 'Västernorrland',     ort: 'Sundsvall',    ruta: [15.00, 62.00, 19.10, 64.00] },
  { nyckel: 'jamtland',       namn: 'Jämtland',           ort: 'Östersund',    ruta: [11.90, 61.50, 16.30, 65.10] },
  { nyckel: 'vasterbotten',   namn: 'Västerbotten',       ort: 'Umeå',         ruta: [14.40, 63.40, 21.60, 66.30] },
  { nyckel: 'norrbotten',     namn: 'Norrbotten',         ort: 'Luleå',        ruta: [15.30, 65.00, 24.20, 69.10] },
];

/** Ord som står där ett grupp-id står i adressen, men inte är grupper. */
const FB_FORBJUDNA = [
  'feed', 'discover', 'discovery', 'joins', 'create', 'search',
  'your_groups', 'category', 'browse', 'invites', 'notifications',
];

/**
 * Grupp-id:t ur allt från ett naket id till en hel adress med spårparametrar.
 * Tom sträng när det inte går att få ut något användbart.
 *
 * Ägaren ska kunna kopiera adressfältet rakt av. Att kräva att han själv
 * skalar bort https://www.facebook.com och ?ref=bookmarks är att be om fel.
 */
function fbGruppIdUrUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = /\/groups\/([^/?#\s]+)/i.exec(s);
  const bit = (m ? m[1] : s).trim();
  if (!/^[\w.-]+$/.test(bit)) return '';
  if (FB_FORBJUDNA.includes(bit.toLowerCase())) return '';
  return bit;
}

/** Området med den nyckeln, eller null. */
function fbRegion(nyckel) {
  return FB_REGIONER.find(r => r.nyckel === nyckel) || null;
}

const fbGiltigRuta = r =>
  Array.isArray(r) && r.length === 4 && r.every(n => Number.isFinite(n)) &&
  r[0] < r[2] && r[1] < r[3];

/** Ligger koordinaten i rutan? */
function inomFbRegion(lat, lon, ruta) {
  return Number.isFinite(lat) && Number.isFinite(lon) && fbGiltigRuta(ruta) &&
    lon >= ruta[0] && lon <= ruta[2] && lat >= ruta[1] && lat <= ruta[3];
}

/**
 * Städar listan som ligger i settings. Kastar rader utan id eller utan
 * giltigt område, och tar bort dubbletter.
 *
 * Samma hårda regel som i bryggan: en grupp utan område får inte finnas.
 * Här kastas den i stället för att stoppa appen — appen gör hundra andra
 * saker, och en trasig rad i en lista ska inte släcka kartan. Bryggan, som
 * bara har den här uppgiften, vägrar starta i stället.
 */
function normaliseraFbGrupper(lista) {
  const ut = [];
  const sedda = [];
  for (const rad of (Array.isArray(lista) ? lista : [])) {
    if (!rad || typeof rad !== 'object') continue;
    const id = fbGruppIdUrUrl(rad.id);
    if (!id || sedda.includes(id)) continue;

    const region = fbRegion(rad.region);
    const ruta = fbGiltigRuta(rad.ruta) ? rad.ruta.map(Number) : (region ? region.ruta.slice() : null);
    if (!ruta) continue;

    sedda.push(id);
    ut.push({
      id,
      namn: String(rad.namn || '').trim().slice(0, 80) || id,
      region: region ? region.nyckel : '',
      ort: String(rad.ort || (region ? region.ort : '')).trim(),
      omrade: String(rad.omrade || (region ? region.namn : '')).trim(),
      ruta,
      /*
       * Push till låst skärm för den här gruppen.
       *
       * Förvalet är true, och en saknad nyckel betyder true — annars hade en
       * uppgradering tystat den grupp som redan fungerar.
       *
       * Raden behövde förut sättas till false för varje grupp i en annan
       * stad: notisvägen på servern (fbmejl_push_mottagare) hade ingen
       * geografi alls och skickade varje ny rapport till varenda
       * prenumerant, så en Stockholmsgrupp lade Sergels torg på låsskärmen
       * hos folk i Västerås.
       *
       * Så är det inte längre. Servern jämför rapportens koordinat med de
       * trakter prenumeranten brukar vara i och hoppar över dem som ligger
       * utanför räckvidden (setNotisOmfang i inställningarna). En grupp i en
       * annan stad kan därför stå kvar på true — den når dem som kör där.
       *
       * false är alltså ett val numera, inte en nödvändighet: "den här
       * gruppen ska aldrig kunna väcka någon." Gruppen syns ändå på kartan
       * och hörs i appens röst, som filtrerar på avstånd.
       */
      notis: (rad.notis === undefined || rad.notis === null) ? true : !!rad.notis,
    });
  }
  return ut;
}

/**
 * Raden ägaren klistrar in i användarskriptet.
 *
 * DEN HÄR TEXTEN ÄR APPENS ENDA UTGÅNG, och det är med flit.
 *
 * Grupplistan har EN sanning: CONFIG.groupIds i tools/fb-bridge.user.js. Både
 * användarskriptet och tools/brygg-daemon.ps1 läser den raden och ingen annan.
 * Listan här i appen är inte en andra sanning utan en REDIGERARE: den ligger i
 * webbläsarens localStorage, den styr ingenting, och det enda den producerar
 * är texten nedan.
 *
 * Appen kan inte heller vara sanningen även om man ville. Den ligger på ett
 * annat ursprung än daemonen, har ingen filåtkomst till PC:n, och en synk via
 * Supabase kräver först att rapportraden bär en region och att notisurvalet
 * filtrerar på den — annars betyder "fler grupper" bara att alla får allas
 * städer i låsskärmen.
 *
 * Formen måste därför matcha vad de två läsarna förväntar sig, tecken för
 * tecken. Rundturen mäts i test.html ("konfigurationen är giltig JS i den form
 * bryggan läser") och tolkarnas regler mäts mot varandra i
 * `brygg-daemon.ps1 -ProvaGrupper`.
 */
function fbBryggKonfig(grupper) {
  const rader = normaliseraFbGrupper(grupper).map(g =>
    '      { id: ' + JSON.stringify(g.id) +
    ', namn: ' + JSON.stringify(g.namn) +
    ', ort: ' + JSON.stringify(g.ort) +
    ', omrade: ' + JSON.stringify(g.omrade) +
    ', ruta: [' + g.ruta.map(n => n.toFixed(2)).join(', ') + ']' +
    // Skrivs bara när den är avstängd. En rad som säger samma sak som
    // förvalet är brus, och den som läser filen ska kunna se på en blick
    // vilka grupper som inte pushar.
    (g.notis === false ? ', notis: false' : '') +
    ' },');
  return 'groupIds: [\n' + rader.join('\n') + '\n    ],';
}

/* ==PV-FB-GRUPPER-SLUT== */

/*
 * Kodsnutten ägaren kör i Facebook-fliken för att få fram sina grupper.
 *
 * VARFÖR EN SNUTT OCH INTE EN KNAPP I APPEN
 *
 * Appen ligger på ett annat ursprung än facebook.com. Den kan inte läsa en
 * Facebook-flik, och Meta stängde Groups API för att läsa grupper 2024 — det
 * finns alltså ingen väg alls från appen till listan. Det är inte en
 * begränsning som går att koda sig runt.
 *
 * Däremot GÅR det att läsa listan från insidan, och det är mätt:
 * facebook.com/groups/joins/ ("Dina grupper") bär varje grupp som en länk
 * till /groups/<id>/ med namnet som text. Ett svep på ett riktigt konto gav
 * tio grupper med rena namn. facebook.com/groups/feed/ duger däremot inte —
 * där låg bara den enda grupp som råkade ha ett inlägg i flödet just då.
 *
 * Har ägaren redan bryggan installerad finns samma sak som
 * __polisvakt.hittaGrupper(). Snutten nedan är för första gången, innan det
 * finns någon grupp att starta bryggan med.
 */
const FB_UPPTACK_SNUTT = [
  '(() => {',
  '  const m = new Map();',
  '  for (const a of document.querySelectorAll(\'a[href*="/groups/"]\')) {',
  '    const h = (a.getAttribute("href") || "").split("?")[0].replace(/^https?:\\/\\/[^/]+/, "");',
  '    const t = /^\\/groups\\/([^/?#]+)\\/?$/.exec(h);',
  '    if (!t) continue;',
  '    const id = t[1];',
  '    if (["feed","discover","joins","create","search"].includes(id)) continue;',
  '    if (!m.has(id)) m.set(id, []);',
  '    const s = (a.innerText || "").replace(/\\s+/g, " ").trim();',
  '    if (s) m.get(id).push(s);',
  '  }',
  '  const rader = [...m].map(([id, t]) => id + "  " + (t.sort((a, b) => a.length - b.length)[0] || ""));',
  '  console.log(rader.join("\\n") || "Inga grupper här — öppna facebook.com/groups/joins/");',
  '  return rader;',
  '})()',
].join('\n');

function wireFbGrupper() {
  const list = $('fbGruppLista');
  if (!list) return;

  const sel = $('fbGruppRegion');
  const status = t => { const e = $('fbGruppStatus'); if (e) e.textContent = t || ''; };

  for (const r of FB_REGIONER) sel.add(new Option(r.namn, r.nyckel));
  sel.value = 'vastmanland';

  const las = () => normaliseraFbGrupper(settings.fbGrupper);
  const skriv = rader => { settings.fbGrupper = rader; saveSettings(); render(); };

  function render() {
    const rader = las();
    list.innerHTML = '';
    $('fbGruppTom').hidden = rader.length > 0;

    for (const g of rader) {
      const div = document.createElement('div');
      div.className = 'group-row fb-group-row';

      const txt = document.createElement('span');
      txt.textContent = g.namn;
      const under = document.createElement('small');
      // Id:t står med. Det är det ENDA som måste stämma överens med bryggan,
      // och den som felsöker en tyst grupp behöver se det utan att gräva.
      // Och står gruppen utan notis ska det synas i listan, inte bara i
      // filen — annars felsöker man en tystnad man själv valt.
      under.textContent = (g.omrade || 'Utan område') + ' · ' + g.id +
        (g.notis === false ? ' · karta, ingen notis' : '');
      txt.appendChild(document.createElement('br'));
      txt.appendChild(under);
      div.appendChild(txt);

      const bort = document.createElement('button');
      bort.className = 'btn-ghost small danger';
      bort.textContent = 'Ta bort';
      bort.onclick = () => {
        skriv(las().filter(x => x.id !== g.id));
        status(`${g.namn} är borttagen. Kopiera om inställningen till bryggan.`);
      };
      div.appendChild(bort);
      list.appendChild(div);
    }

    const k = $('fbGruppKonfig');
    if (k) k.value = rader.length ? fbBryggKonfig(rader) : '';
  }

  $('btnFbGruppLagg').addEventListener('click', () => {
    const id = fbGruppIdUrUrl($('fbGruppUrl').value);
    if (!id) {
      status('Hittade inget grupp-id. Klistra in adressen till gruppen, ' +
        'till exempel facebook.com/groups/317968668373072/.');
      return;
    }
    const rader = las();
    if (rader.some(g => g.id === id)) { status('Den gruppen är redan ansluten.'); return; }

    const region = fbRegion(sel.value) || FB_REGIONER[0];
    const namn = String($('fbGruppNamn').value || '').trim().slice(0, 80) || id;
    const notisRuta = $('fbGruppNotis');
    const notis = notisRuta ? !!notisRuta.checked : true;
    rader.push({ id, namn, region: region.nyckel, ort: region.ort,
                 omrade: region.namn, ruta: region.ruta.slice(), notis });
    skriv(rader);
    $('fbGruppUrl').value = '';
    $('fbGruppNamn').value = '';
    if (notisRuta) notisRuta.checked = true;
    status(`${namn} tillagd i ${region.namn}` +
      (notis ? '' : ' (karta ja, notis nej)') +
      '. Kopiera inställningen till bryggan så börjar den läsa gruppen.');
  });

  $('btnFbGruppKopiera').addEventListener('click', async () => {
    const rader = las();
    if (!rader.length) { status('Listan är tom — bryggan startar inte utan minst en grupp.'); return; }
    const ok = await kopiera(fbBryggKonfig(rader));
    status(ok
      ? 'Kopierat. Öppna användarskriptet i Tampermonkey och ersätt raden som ' +
        'börjar med groupIds:.'
      : 'Kunde inte kopiera automatiskt — markera texten i rutan och kopiera för hand.');
  });

  $('btnFbGruppUpptack').addEventListener('click', async () => {
    const ok = await kopiera(FB_UPPTACK_SNUTT);
    status(ok
      ? 'Kopierat. Öppna facebook.com/groups/joins/, tryck F12 → Console, klistra ' +
        'in och tryck Enter. Du får en rad per grupp: id först, sedan namnet.'
      : 'Kunde inte kopiera automatiskt — markera texten i rutan och kopiera för hand.');
    const k = $('fbGruppKonfig');
    if (k) k.value = FB_UPPTACK_SNUTT;
  });

  render();
}

/** Skriver till urklipp. Faller tillbaka på det gamla sättet i äldre webbläsare. */
async function kopiera(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function wireCoverage() {
  coverage.addEventListener('change', () => {
    settings.coverageMode = coverage.mode;
    settings.coverageRadiusM = coverage.radiusM;
    saveSettings();
    $('coverageDesc').textContent = coverage.describe();
    renderRouteLine();
    renderHazards();
  });
}

function renderRouteLine() {
  if (map._routeLine) { map.map.removeLayer(map._routeLine); map._routeLine = null; }
  if (coverage.mode !== 'route' || !coverage.route) return;
  map._routeLine = L.polyline(coverage.route.points, {
    color: '#3d9dff', weight: 5, opacity: .55, interactive: false,
  }).addTo(map.map);
}

/* ================= Introduktionsguide ================= */

const tour = new Tour({ onShowView: showView });
const driving = new DrivingDetector();
const korvanor = new Korvanor.Korvanor();
let senasteKorning = 0;
const coverage = new Coverage({ mode: settings.coverageMode, radiusM: settings.coverageRadiusM });

function startTour() {
  showView('map');
  $('sheet').classList.remove('collapsed');
  setTimeout(() => tour.start(), 350);
}

function wireTour() {
  $('tourNext').onclick = () => tour.next();
  $('tourBack').onclick = () => tour.back();
  $('tourSkip').onclick = () => tour.stop();
  tour.addEventListener('done', () => {
    if (Install.shouldAutoShow()) setTimeout(() => openInstallGuide(true), 600);
    if (settings.wakeWord && voiceInputSupported) listener.startWakeWord();
    toast('Guiden finns kvar under Inställningar om du vill se den igen.', 5000);
  });
}

/* ================= Konto ================= */

function showAuthScreen() {
  $('authScreen').hidden = false;
  showResetForm(false);

  // Öppna alltid på inloggning, aldrig på registrering. Den som återvänder
  // ska mötas av två fält — e-post och lösenord — inte av ett
  // registreringsformulär med namnfält som ser ut att krävas.
  const signinTab = document.querySelector('#authTabs button[data-mode="signin"]');
  if (signinTab && !signinTab.classList.contains('active')) signinTab.click();

  // Har telefonen en sparad inloggning loggar vi in direkt istället för att
  // visa ett tomt formulär. Ingen ska behöva skriva lösenordet varje gång.
  offerSavedLogin();
  const backend = auth.available;
  $('authNoBackend').hidden = backend;
  if (!backend) {
    $('authNoBackend').textContent =
      'Konton är inte påslagna än. Fortsätt utan konto så länge — allt fungerar, men bara på den här telefonen.';
    $('authForm').hidden = true;
    $('authTabs').hidden = true;
    $('authForgot').hidden = true;
    $('authLead').textContent = 'Kör igång direkt. Kontofunktionen kommer inom kort.';
  }
}

/**
 * Räkna ner spärren så det syns att den släpper.
 *
 * En låst knapp utan förklaring får folk att tro att appen hängt sig. En
 * synlig nedräkning gör det tydligt att det är avsiktligt och tillfälligt —
 * och knuffar dem mot återställningen under tiden.
 */
let lockoutTimer = null;
function startLockoutCountdown(email, msg) {
  clearInterval(lockoutTimer);
  const btn = $('authSubmit');
  const tick = () => {
    const left = auth.lockedFor(email);
    if (left <= 0) {
      clearInterval(lockoutTimer);
      btn.disabled = false;
      btn.textContent = 'Logga in';
      msg('Du kan prova igen nu.', true);
      return;
    }
    btn.disabled = true;
    const m = Math.floor(left / 60), s = left % 60;
    btn.textContent = m > 0 ? `Vänta ${m}:${String(s).padStart(2, '0')}` : `Vänta ${s} s`;
  };
  tick();
  lockoutTimer = setInterval(tick, 1000);
}

/** Växla mellan vanlig inloggning och "välj nytt lösenord". */
function showResetForm(on) {
  $('resetForm').hidden = !on;
  $('authForm').hidden = on;
  $('authTabs').hidden = on;
  $('authForgot').hidden = on;
  $('authLead').hidden = on;
  if (on) setTimeout(() => $('resetPass').focus(), 200);
}

function hideAuthScreen(justSignedUp = false) {
  $('authScreen').hidden = true;
  renderAccount();
  // Nytt konto får guiden direkt. Den som bara loggar in igen slipper.
  if (justSignedUp || !tourSeen()) { startTour(); return; }
  if (Install.shouldAutoShow()) setTimeout(() => openInstallGuide(true), 700);
  if (settings.wakeWord && voiceInputSupported) listener.startWakeWord();
}

function wireAuth() {
  let mode = 'signin';
  const msg = (text, ok = false) => {
    const el = $('authMsg');
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('ok', ok);
  };

  $('authTabs').onclick = e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    document.querySelectorAll('#authTabs button').forEach(x => x.classList.toggle('active', x === b));
    $('fieldNick').hidden = mode !== 'signup';
    $('authSubmit').textContent = mode === 'signup' ? 'Skapa konto' : 'Logga in';
    $('authPass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('authForgot').hidden = mode === 'signup';
    // Vid registrering behövs e-posten för att kunna återställa lösenordet.
    // Vid inloggning duger vilketdera som helst.
    $('idLabel').textContent = mode === 'signup' ? 'E-post' : 'Användarnamn eller e-post';
    $('authEmail').placeholder = mode === 'signup' ? 'du@exempel.se' : 'elliot eller du@exempel.se';
    $('authEmail').type = mode === 'signup' ? 'email' : 'text';
    msg('');
  };

  // Kolla att användarnamnet är ledigt medan man skriver
  let nickTimer = null;
  $('authNick').oninput = () => {
    clearTimeout(nickTimer);
    const note = $('nickNote');
    const val = $('authNick').value.trim().toLowerCase();
    if (!val) { note.textContent = ''; note.className = 'field-note'; return; }
    const bad = validateUsername(val);
    if (bad) { note.textContent = bad; note.className = 'field-note bad'; return; }
    note.textContent = 'Kollar…';
    note.className = 'field-note';
    nickTimer = setTimeout(async () => {
      const free = await auth.usernameAvailable(val);
      note.textContent = free ? `"${val}" är ledigt` : `"${val}" är upptaget`;
      note.className = 'field-note ' + (free ? 'good' : 'bad');
    }, 450);
  };

  $('authPeek').onclick = () => {
    const i = $('authPass');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('authPeek').textContent = show ? 'Dölj' : 'Visa';
  };

  $('authForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('authEmail').value;
    const pass = $('authPass').value;
    const nick = $('authNick').value;
    const btn = $('authSubmit');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = mode === 'signup' ? 'Skapar konto…' : 'Loggar in…';
    msg('');

    const res = mode === 'signup'
      ? await auth.signUp(email, pass, nick)
      : await auth.signIn(email, pass);

    btn.disabled = false;
    btn.textContent = original;

    if (!res.ok) {
      msg(res.error);
      // Låst ute: räkna ner så man ser att det faktiskt släpper
      if (res.locked && res.waitSeconds) startLockoutCountdown(email, msg);
      return;
    }

    if (mode === 'signup' && res.confirmed === false) {
      msg('Kontot är skapat. Klicka på länken i mejlet vi just skickade, sedan kan du logga in.', true);
      return;
    }
    if (nick) reputation.setNickname(nick);
    await saveCredentials(email, pass, nick);
    onSignedIn();
    const isNew = mode === 'signup';
    hideAuthScreen(isNew);
  };

  $('authForgot').onclick = async () => {
    const email = $('authEmail').value.trim();
    if (!email) { msg('Skriv din e-postadress i fältet ovan först.'); return; }
    const btn = $('authForgot');
    btn.disabled = true;
    btn.textContent = 'Skickar…';
    const res = await auth.sendPasswordReset(email);
    btn.disabled = false;
    btn.textContent = 'Glömt lösenordet?';
    msg(res.ok
      ? `Vi har skickat en länk till ${email}. Kolla inkorgen och skräpposten. Klicka på länken i mejlet så öppnas appen där du väljer nytt lösenord.`
      : res.error, res.ok);
  };

  /* ---- Nytt lösenord efter återställningslänk ---- */

  $('resetPeek').onclick = () => {
    const i = $('resetPass');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('resetPeek').textContent = show ? 'Dölj' : 'Visa';
  };

  $('resetCancel').onclick = () => showResetForm(false);

  $('resetForm').onsubmit = async e => {
    e.preventDefault();
    const rm = (text, ok = false) => {
      const el = $('resetMsg');
      el.hidden = !text; el.textContent = text || '';
      el.classList.toggle('ok', ok);
    };
    const btn = $('resetSubmit');
    btn.disabled = true;
    btn.textContent = 'Sparar…';
    const res = await auth.setNewPassword($('resetPass').value);
    btn.disabled = false;
    btn.textContent = 'Spara nytt lösenord';

    if (!res.ok) { rm(res.error); return; }
    rm('Lösenordet är bytt. Loggar in dig…', true);
    await saveCredentials(res.email || $('authEmail').value, $('resetPass').value, reputation.nickname);
    onSignedIn();
    setTimeout(() => { showResetForm(false); hideAuthScreen(); }, 900);
  };

  // Kom vi hit från länken i mejlet?
  const recovery = auth.consumeRecoveryLink();
  if (recovery?.error) {
    showAuthScreen();
    msg(recovery.error);
  } else if (recovery?.ready) {
    showAuthScreen();
    showResetForm(true);
  }

  $('authGuest').onclick = () => {
    auth.continueAsGuest();
    hideAuthScreen();
  };

  // Håll token synkad. Serverfunktionerna läser identiteten ur JWT:n, så
  // varje gång sessionen förnyas måste anropen börja bära den nya.
  const syncToken = () => {
    setAccessToken(auth.session?.access_token || null);
    if (auth.signedIn) setIdentity(auth.identity);
  };
  syncToken();
  auth.addEventListener('change', () => { syncToken(); renderAccount(); });
  renderAccount();
}

/**
 * Be telefonen spara inloggningen.
 *
 * Två vägar, för de täcker olika enheter:
 *
 *   iPhone och Safari har inget API för det här. Nyckelringen tittar istället
 *   på formuläret — att det är ett riktigt <form> med method, med
 *   autocomplete="username" på e-posten och "new-password" vid registrering.
 *   Det är därför de attributen finns i HTML:en, och därför den här funktionen
 *   inte gör något på iPhone: jobbet är redan gjort där.
 *
 *   Chrome och Android har Credential Management API, som låter oss be direkt.
 *   Utan det anropet erbjuder Chrome ofta inte att spara alls i en app som den
 *   här, eftersom sidan aldrig laddas om vid inloggning.
 */
async function saveCredentials(email, password, name) {
  try {
    if (!window.PasswordCredential || !navigator.credentials?.store) return false;
    await navigator.credentials.store(new PasswordCredential({
      id: email.trim().toLowerCase(),
      password,
      name: name || email.trim().toLowerCase(),
    }));
    return true;
  } catch {
    return false;   // användaren sa nej, eller webbläsaren stödjer det inte
  }
}

/**
 * Erbjud sparad inloggning vid start. Tyst läge: finns en sparad uppgift
 * loggar vi in direkt, men ingen ruta poppar upp i ansiktet på någon som
 * inte har något sparat.
 */
async function offerSavedLogin() {
  try {
    if (!navigator.credentials?.get || !window.PasswordCredential) return false;
    const cred = await navigator.credentials.get({ password: true, mediation: 'optional' });
    if (!cred || cred.type !== 'password' || !cred.id || !cred.password) return false;
    $('authEmail').value = cred.id;
    $('authPass').value = cred.password;
    const res = await auth.signIn(cred.id, cred.password);
    if (res.ok) { onSignedIn(); hideAuthScreen(); return true; }
  } catch { /* inget sparat, eller nekad */ }
  return false;
}

/**
 * Knyt data till kontot istället för till telefonen. Allt går genom
 * deviceId() i store.js, så det räcker att peka om den på ett ställe —
 * rapporter, poäng och prenumeration följer med automatiskt.
 */
function onSignedIn() {
  const id = auth.identity;
  if (!id) return;
  setIdentity(id);
  billing.sync();
  renderReputation();
  refreshLeaderboard();
}

function renderAccount() {
  const el = $('accountStatus');
  const actions = $('accountActions');
  if (!el || !actions) return;
  actions.innerHTML = '';

  const add = (label, fn, cls = 'btn-ghost small') => {
    const b = document.createElement('button');
    b.className = cls; b.type = 'button'; b.textContent = label; b.onclick = fn;
    actions.appendChild(b);
  };

  if (auth.signedIn) {
    el.textContent = `Inloggad som ${auth.email}. Prenumeration och poäng följer kontot till alla dina enheter.`;
    add('Logga ut', async () => {
      await auth.signOut();
      setIdentity(null);           // tillbaka till enhetens eget id
      toast('Du är utloggad.');
      showAuthScreen();
    });
  } else if (!auth.available) {
    el.textContent = 'Konton är inte påslagna än. Allt sparas lokalt på den här telefonen.';
  } else {
    el.textContent = 'Du kör utan konto. Rapporter, poäng och prenumeration stannar på den här telefonen.';
    add('Logga in eller skapa konto', () => { auth.clearGuest(); showAuthScreen(); }, 'btn-primary');
  }
}

/**
 * Mörkt läge efter verklig solnedgång, inte efter klockan.
 *
 * I Västerås går solen ner strax efter tre i december och strax före tio i
 * juni. En app som byter läge klockan 19 kör med bländande vit karta halva
 * vintern och onödigt mörk karta halva sommaren.
 */
/*
 * "Automatiskt" tema betyder mörkt efter solnedgången på din faktiska position
 * och dagens datum — inte efter klockslag. Skillnaden är stor på vintern, när
 * det är mörkt klockan tre på eftermiddagen.
 *
 * Det fanns tidigare ett separat reglage för det här vid sidan av temavalet.
 * Två inställningar för samma sak, där den ena tyst kunde stänga av den andra.
 * Reglaget är borta; "auto" gör det auto betyder.
 */
function autoTheme(fix) {
  if (settings.theme !== 'auto') return;
  const dark = fix
    ? isDark(fix.lat, fix.lon)
    : isDark(59.6099, 16.5448);         // Västerås tills GPS svarar
  map.setTheme(dark ? 'night' : 'day');
  document.body.classList.toggle('is-night', dark);
}

function applyTheme() {
  if (settings.theme === 'auto') { autoTheme(geo.position); return; }
  map.setTheme(settings.theme);
  document.body.classList.toggle('is-night', settings.theme === 'night');
}

/* ================= Faror ================= */

/**
 * Alla faror som är aktuella just nu, graderade efter hur mycket de går att
 * lita på.
 *
 * En falsk varning kostar mer än en missad. Den missade patrullen är en
 * icke-händelse — föraren får aldrig veta. En varning för polis på en väg där
 * det inte står någon lär föraren att appen ropar varg, och efter tre sådana
 * tror hen inte på de sanna heller.
 *
 * Graderingen sätter `bedomning` på varje rapport. Motorn i alerts.js läser
 * den och formulerar hedgat där det behövs. Här sållas bara det bort som inte
 * ska sägas eller visas alls.
 */
/**
 * Fyll i det vi rimligen kan sluta oss till om en rapport vi inte skapat.
 *
 * Rapporter från andra förare kommer via servern, och servern har ännu inte
 * kolumnerna för hur de kom till. Utan `geokod` antar graderaren en okänd
 * geokodning med drygt en kilometers radie — och tystar därmed varje rapport
 * som någon annan har skickat. Det är hela poängen med appen.
 *
 * `source` säger dock det vi behöver: 'app' betyder ett knapptryck, och ett
 * knapptryck sker på förarens egen position. Att härleda det är ett
 * antagande, men ett långt bättre än att anta det värsta.
 *
 * Raderna som redan har fälten rörs inte — så fort kolumnerna finns i
 * databasen tar riktig data över av sig själv.
 */
function harledKvalitet(r) {
  if (r.geokod || r.geokodTyp) return r;
  if (r.source === 'app') {
    return {
      ...r,
      geokod: 'gps',
      // Ingen aning om hens GPS eller fart. Låt graderaren använda sina egna
      // antaganden för det — men inte för positionens ursprung.
    };
  }
  return r;
}

/**
 * Hela det graderade flödet, uppdelat i det som får höras och det som får
 * synas.
 *
 * Fanns förut bara som insidan av allHazards(). Den är utbruten därför att
 * inkommande-uppläsningen behöver BÅDA listorna ur SAMMA gradering för att
 * kunna svara på frågan "varför hamnade den här bara på kartan?". Två anrop
 * till allHazards() hade gett två graderingar av samma flöde i samma
 * ögonblick — dubbelt arbete, och två svar som i teorin kan skilja sig åt.
 *
 * `undanhallna` är det graderingen kastade ut helt. Ingen ser dem, och det är
 * meningen — men något måste kunna SÄGA att de kastades ut, annars går det
 * inte att skilja "ingen rapport kom in" från "en rapport kom in och sållades
 * bort". Se spåret i inkommande-uppläsningen.
 *
 * @returns {{forRost: Array, forKarta: Array, undanhallna: Array}}
 */
function graderadeFaror() {
  const me = geo.position;
  const aktiva = coverage.filter(store.active(), me);
  const undanhallna = [];

  let graderade = aktiva;
  try {
    const { grupper } = Kvalitet.bedomFlodet(aktiva.map(harledKvalitet), {
      nu: Date.now(),
    });
    graderade = grupper
      .map(g => ({
        ...g.kluster.ledare, lat: g.kluster.lat, lon: g.kluster.lon,
        label: g.kluster.label, bedomning: g.bedomning,

        /*
         * Alla id:n i klustret följer med.
         *
         * Faran bär ledarens id. Står en polis på Vasagatan och tre förare
         * rapporterar den, blir en av dem ledare — och är det inte min
         * rapport tappar appen spåret av att jag var en av dem.
         *
         * Två saker gick sönder av det: appen började varna MIG för något
         * jag själv nyss rapporterat, och listan slutade märka rapporten som
         * min så jag inte kunde ta bort den. Sorteringen gör visserligen att
         * en färsk egen rapport nästan alltid blir ledare — men "nästan
         * alltid" är inte "alltid", och det syns bara som att appen betett
         * sig konstigt en enstaka gång.
         */
        klusterIds: (g.kluster.medlemmar || []).map(m => m.id),
      }))
      // Undanhållet plockas ut i stället för att bara försvinna. Listan är
      // ingen väg tillbaka in i flödet — den används enbart av spåret.
      .filter(h => {
        if (h.bedomning?.behandling !== Kvalitet.BEHANDLING.UNDANHALL) return true;
        undanhallna.push(h);
        return false;
      });
  } catch {
    /*
     * Graderingen får aldrig kunna släcka varningarna. Går något fel faller
     * vi tillbaka på ograderade rapporter — hellre en osäker varning än ingen.
     *
     * MEN ÅLDERSGRINDEN FÖLJER MED NER, och det är nytt.
     *
     * Utan bedomning svarar kvalitetsTak() i js/notiser.js NIVA_ROST, alltså
     * "får läsas upp". Konsekvensen var begränsad när aktiva rapporter var
     * högst 45-60 minuter gamla; med fyra timmars visningstid hade ett enda
     * undantag i bedomFlodet matat varningsmotorn med fyra timmars eftersläp
     * och läst upp varje gammal rapport föraren körde förbi — inklusive de som
     * graderingen skulle ha tystat för att de överlevt sin trovärdighetstid.
     *
     * Filtret räknar på TTL_MINUTES, samma tal graderingen ändå hade använt,
     * och det kan inte kasta.
     *
     * PRISET, UTTALAT: i nödfallet försvinner de gamla nålarna också från
     * kartan, för listan delas upp längre ner och den uppdelningen behöver
     * just den bedömning som nyss kastade. Fyra timmars visning är alltså av
     * så länge graderingen är trasig. Det är rätt håll att fela åt — en app
     * som visar mindre än den borde är en olägenhet, en app som ropar ut fyra
     * timmar gamla poliser är en app man stänger av. Samma nödfall finns i
     * js/rutt.js och räknar likadant.
     */
    const nuMs = Date.now();
    graderade = aktiva.filter(r => {
      const ttlMs = (TTL_MINUTES[r.type] ?? 45) * 60000;
      const skapad = Number(r.createdAt ?? r.created_at);
      if (!Number.isFinite(skapad)) return true;   // okänd ålder: som förut
      return nuMs - skapad < ttlMs;
    });
  }

  /*
   * Notisinställningarna delar upp flödet i två: vad som får läsas upp och
   * vad som får synas på kartan. De kan bara sänka, aldrig höja — tre tak
   * staplas och det tystaste vinner: produktreglerna först, sedan
   * kvalitetsgraderingen, sedan användarens val. Därför behövs inget separat
   * TYST-filter här längre; regeln finns kvar men bor på ett ställe.
   *
   * Kamerorna måste gå genom samma anrop, annars går camera-inställningen
   * inte att använda.
   */
  return {
    ...Notiser.delaUppFaror([...graderade, ...coverage.filter(cameras, me)], settings),
    undanhallna,
  };
}

function allHazards({ forAlerts = false } = {}) {
  const { forRost, forKarta } = graderadeFaror();
  return forAlerts ? forRost : forKarta;
}

const renderHazardsThrottled = debounce(() => renderHazards(), 1500);

/**
 * Är den här faran min?
 *
 * Faran bär klusterledarens id, inte nödvändigtvis mitt. Frågan måste därför
 * ställas mot alla rapporter i klustret — annars slutar min egen rapport
 * räknas som min så fort någon annan råkar bli ledare för samma polis.
 */
function arMin(h) {
  if (isMine(h.id)) return true;
  return (h.klusterIds || []).some(id => isMine(id));
}

function renderHazards() {
  const fix = geo.position;
  const list = allHazards();
  map.render(list, fix);

  const ul = $('hazardList');
  ul.innerHTML = '';

  if (!fix) {
    $('sheetEmpty').hidden = false;
    $('sheetEmpty').textContent = 'Väntar på GPS…';
    $('sheetCount').textContent = '';
    return;
  }

  /*
   * AKTUELLA FÖRE UTGÅNGNA, DÄREFTER NÄRMAST FÖRST.
   *
   * Listan sorterade bara på avstånd och kapade vid tolv rader. Det var
   * ofarligt så länge pölen bara innehöll rapporter yngre än 45-60 minuter.
   * Med fyra timmars visningstid är pölen fyra timmar djup, och de tolv
   * platserna kan fyllas av rapporter appen själv har slutat tro på.
   *
   * MÄTT: 15 aktiva rapporter, varav 14 är 60-190 minuter gamla och 300-820 m
   * bort och en är två minuter gammal 1,4 km bort. Med ren avståndssortering
   * föll den färska ur listan — föraren såg tolv rader som alla sa "Troligen
   * inte kvar" och den enda rad som gällde syntes inte. Samma mekanism gjorde
   * att #sheetCount aldrig kunde visa mer än "12 st".
   *
   * Bedömningen finns redan: graderingen sätter flaggan 'overlevd' på det som
   * levt längre än sin trovärdighetstid (js/kvalitet.js). Saknas bedömningen —
   * nödfallet i graderadeFaror() — räknas åldern direkt ur TTL_MINUTES, samma
   * tal graderingen ändå hade använt.
   */
  const harOverlevt = h => {
    if (h.bedomning?.flaggor) return h.bedomning.flaggor.includes('overlevd');
    const ttlMs = (TTL_MINUTES[h.type] ?? 45) * 60000;
    const skapad = Number(h.createdAt ?? h.created_at);
    return Number.isFinite(skapad) && Date.now() - skapad >= ttlMs;
  };

  const near = list
    .map(h => ({ ...h, distance: haversineFix(fix, h), overlevd: harOverlevt(h) }))
    .filter(h => h.distance <= Math.max(settings.hazardRadiusM * 3, 5000))
    .sort((a, b) => (a.overlevd - b.overlevd) || (a.distance - b.distance))
    .slice(0, 12);

  $('sheetEmpty').hidden = near.length > 0;
  $('sheetEmpty').textContent = 'Inga rapporter i närheten just nu.';
  $('sheetCount').textContent = near.length ? `${near.length} st` : '';

  for (const h of near) {
    const li = document.createElement('li');
    // Min även om någon annans rapport blev klusterledare. Utan det försvinner
    // "Borta"-knappen för en rapport jag själv skickat.
    const own = arMin(h);
    li.innerHTML = `
      <span class="hz-ico">${TYPE_ICON[h.type] || '⚠️'}</span>
      <span class="hz-main">
        <span class="hz-title">${escapeHtml(TYPE_LABEL[h.type] || 'Varning')}${h.label ? ' · ' + escapeHtml(h.label) : ''}</span>
        <span class="hz-meta">${escapeHtml(hazardMeta(h, own))}</span>
      </span>
      <span class="hz-dist">${shortDistance(h.distance)}</span>`;

    // Text istället för tummar. En tumme upp kan betyda "bra rapport" lika
    // gärna som "faran finns kvar", och de två sakerna leder åt helt olika
    // håll. Orden går inte att missförstå.
    if (!h.fixed) {
      const btns = document.createElement('span');
      btns.className = 'hz-btns';
      btns.innerHTML =
        `<button class="hz-yes" title="Jag ser den också — förläng varningen">Finns kvar</button>` +
        `<button class="hz-no" title="Jag körde förbi, här är tomt — ta bort varningen">Borta</button>`;
      btns.children[0].onclick = ev => {
        ev.stopPropagation();
        store.confirm(h.id);
        reputation.addVerify();
        // Samma sanning som rattknappen säger, se motiveringen där och i
        // js/store.js confirm(): bekräftelsen räknas, den förlänger inte.
        toast('Tack. Din bekräftelse är räknad.', 3500);
        renderReputation();
      };
      btns.children[1].onclick = ev => {
        ev.stopPropagation();
        own ? store.remove(h.id) : store.deny(h.id);
        reputation.addVerify();
        toast(own ? 'Din rapport är borttagen.' : 'Tack. Tre sådana och varningen försvinner för alla.', 4000);
        renderReputation();
      };
      li.appendChild(btns);
    }
    li.onclick = () => focusHazard(h);
    ul.appendChild(li);
  }
}

/**
 * Underraden i farolistan.
 *
 * Rubriken ovanför säger redan typ och plats, så här behövs resten av
 * meningen: vem som sagt det, när, och hur mycket det går att lita på.
 * "3 min sedan · Facebook" stod det förut — två fakta utan samband, där
 * föraren själv fick lista ut att det betydde att någon annan sett något,
 * inte att appen visste något.
 *
 * Hela meningen (typ och plats med) hade upprepat rubriken ordagrant, och en
 * rad som säger samma sak två gånger ser ut som ett fel. Därför delarna och
 * inte sammanfattaKort — samma modul, samma ord, bara utan dubbleringen.
 */
function hazardMeta(h, own) {
  const d = beskrivning(h, { egen: own })?.delar;
  if (!d) {
    // Sammanfattningen vägrade beskriva rapporten. Fall tillbaka på det
    // gamla, hellre än att lämna raden tom.
    return h.fixed ? 'Fast kamera'
      : relativeTime(h.createdAt) + (h.source === 'facebook' ? ' · Facebook' : '');
  }
  if (d.fast) return `${cap(d.kallaOchAlder)}.`;
  return `${cap(d.kallaOchAlder)}.${d.aktualitetKort}`;
}

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function haversineFix(fix, h) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(h.lat - fix.lat), dLon = rad(h.lon - fix.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(fix.lat)) * Math.cos(rad(h.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function focusHazard(h) {
  showView('map');
  map.setFollow(false);
  map.centerOn(h.lat, h.lon, 16);
}

/* ================= Varningsytan — den som syns i HELA appen ================= */

/*
 * VARFÖR DET HÄR LAGRET FINNS, OCH VARFÖR BANNERN INTE RÄCKTE.
 *
 * #alertBanner är barn till #view-map. showView() sätter hidden på vyn, och
 * en display:none-förfader tar bort hela grenen — z-index 900 och
 * position:fixed på barnet spelar ingen roll alls. Byter föraren till Chatt
 * eller Inställningar ritas varningen alltså in i ett osynligt subträd.
 *
 * MÄTBART UTAN TELEFON: tryck på en demoknapp i Inställningar. Ljudet kommer,
 * rösten kommer, rutan syns aldrig. Det är exakt samma fel som på iPhonen.
 *
 * varningsyta.js äger en yta som ligger utanför alla vyer. Här bor bara
 * kopplingen: vem som väcker den, i vilken ordning, och när den släcks.
 *
 * ORDNINGEN ÄR LJUD → RÖST → YTA, och den är medveten. Örat är den enda
 * kanal som är ledig när man kör. Plinget säger "något har hänt", rösten
 * säger "vad", och ytan finns där för blicken när föraren har tid att titta
 * — vid rödljuset, inte i kurvan. Att rita först hade inte gjort någon
 * skillnad för den som har ögonen på vägen, och hade tagit huvudtråden i
 * anspråk precis i det ögonblick talsyntesen ska startas.
 */

/*
 * INGEN TIMER HÄR. Ytan äger sin egen livslängd.
 *
 * Första utkastet hade en fjortonsekunderstimer i den här filen, kopierad
 * från bannern. Den var fel på två sätt, och båda syns bara när det är
 * livligt: varningsyta.js håller en KÖ och startar om sin egen klocka vid
 * varje ny rapport (VISA_MS 15 s, med ett tak på MAX_TOTAL_MS 60 s), så en
 * timer härifrån hade dels släckt en sekund för tidigt, dels tagit med sig
 * rapporter som kommit in efteråt och som ingen ännu sett.
 *
 * Regeln som gäller: den som äger noden äger också när den försvinner. Här
 * bor bara frågan om vem som väcker ytan och i vilken ordning.
 */

/**
 * Väck den globala varningsytan.
 *
 * @param {object} rapport  faran, samma objekt som listan och nålen använder
 * @param {object} [opts]   { avstand, egen } — se visa() i varningsyta.js
 *
 * Nykterhets- och drogkontroller filtreras INTE här, och det är medvetet.
 * varningsyta.js frågar farBeskrivas() själv innan den ritar en enda pixel,
 * och behandlar dessutom en tom beskrivning() som ett nej. En kopia av samma
 * spärr på den här raden hade blivit ytterligare en kopia att hålla i takt
 * med de sex som redan finns — och det är just så de driver isär. Spärren
 * sitter hos den kod som skulle kunna bryta mot den, alltså i modulen som
 * ritar.
 */
function visaYtanOverallt(rapport, opts = {}) {
  if (!rapport) return;
  try {
    visaYtan(rapport, opts);
  } catch (e) {
    // En trasig yta får aldrig svälja varningen. Ljudet och rösten har redan
    // gått ut när vi kommer hit, och de är det som når föraren.
    console.warn('[varningsyta] kunde inte visas', e);
  }
}

/** Släck ytan direkt. Bara för förarens egna avfärdanden — aldrig på timer. */
function stangYtanOverallt() {
  try { stangYtan(); } catch {}
}

/*
 * Trycket på ytans kryss stänger också bannern.
 *
 * MÄTT: med båda uppe låg #alertClose (x324,y64 → x345,y99) under ytan
 * (0,0 → 375,95), så bannerns eget kryss tog inte emot något tryck alls.
 * Ytans kryss släckte bara ytan — och eftersom css-regeln i varningsyta.js
 * gömmer bannern så länge ytan lyser POPPADE bannern fram i samma sekund som
 * föraren tryckte bort varningen. Ett tryck som betyder "bort" får inte göra
 * något synligt.
 *
 * hideAlertBanner({avForaren:true}) anropar i sin tur stangYtanOverallt().
 * Det är ofarligt: stang() är idempotent, och den dispatchar ingenting — bara
 * knappen i varningsyta.js gör det, så slingan går ett varv och tar slut.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('pv-varningsyta-stangd', () => {
    try { hideAlertBanner({ avForaren: true }); } catch {}
  });
}

/* ================= Notisen ================= */

/**
 * Samma varning en gång till, som en riktig systemnotis.
 *
 * VARFÖR DEN BEHÖVS, TROTS ATT LJUD, RÖST OCH YTA REDAN FINNS.
 *
 * Alla tre kräver att appen är i förgrunden med JS igång. Det är exakt det
 * tillstånd en iPhone INTE är i när skärmen släckts eller föraren bytt app —
 * alltså det tillstånd ägaren beskriver. Notisen är det enda av de fyra som
 * kan nå fram med släckt skärm, och det var det enda som saknades helt: en
 * genomsökning av js/ och sw.js hittade bara fyra showNotification-anrop, och
 * inget av dem låg i varningskedjan.
 *
 * BEGRÄNSNINGEN, UTSKRIVEN SÅ INGEN TROR MER OM DEN ÄN DEN KAN:
 * det här täcker "skärmen släckt, appen fortfarande igång". Är appen helt
 * stängd av systemet finns ingen JS som kan anropa oss, och då krävs
 * serverpush (js/push.js och lyssnaren i sw.js).
 *
 * TEXTEN ÄR ALDRIG EN EGEN FORMULERING. Rubrik och brödtext kommer ur
 * beskrivning() i sammanfattning.js, samma källa som ytan och rösten. Fyra
 * kanaler som säger fyra olika saker om samma polisbil är fyra chanser att
 * säga fel.
 *
 * NYKTERHETSREGELN följer med genom farBeskrivas(), som frågas här på samma
 * sätt som varningsyta.js frågar den — en ny väg fram till en människa ska
 * själv bära spärren, inte lita på att någon uppströms gjorde det.
 */
const NOTIS_TAGG = 'polisvakt-varning';

/** Samma rapport ska inte kunna banka fram fyra notiser i rad. */
const notisSkickad = new Map();
const NOTIS_OM_IGEN_MS = 120000;

function notisOverallt(rapport, opts = {}) {
  if (!rapport || typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;

  // Spärren, igen. Se doc-kommentaren ovanför.
  if (!farBeskrivas(rapport)) return false;

  const b = beskrivning(rapport, { egen: opts.egen });
  if (!b || !b.kort || !b.delar) return false;   // tomt = får inte beskrivas

  const nyckel = rapport.id != null
    ? `id:${rapport.id}`
    : `x:${rapport.type || ''}|${rapport.label || ''}|${rapport.createdAt || ''}`;
  const nu = Date.now();
  const forra = notisSkickad.get(nyckel);
  if (forra && nu - forra < NOTIS_OM_IGEN_MS) return false;
  notisSkickad.set(nyckel, nu);
  // Kartan får inte växa hela körningen. Äldre än fönstret är ändå glömda.
  if (notisSkickad.size > 60) {
    for (const [k, t] of notisSkickad) if (nu - t > NOTIS_OM_IGEN_MS) notisSkickad.delete(k);
  }

  const d = b.delar;
  const titel = `${d.typ || ''}${d.plats || ''}`.trim() || 'Varning';

  /*
   * Tyst när appen syns, med ljud när den inte gör det.
   *
   * Plinget och rösten har redan gått ut när vi kommer hit. Ett systemljud
   * ovanpå dem hade blivit en andra varning om samma sak en halv sekund
   * senare, alltså brus. Ligger appen i bakgrunden är notisen tvärtom det
   * ENDA som hörs, och då ska den låta.
   */
  const iForgrunden = typeof document !== 'undefined' && document.visibilityState === 'visible';

  const val = {
    body: b.kort,
    icon: './icon.svg',
    badge: './icon.svg',
    tag: NOTIS_TAGG,
    // Samma tagg för alla varningar: en skur ska ersätta sig själv i
    // notislistan, inte stapla tolv rader. renotify tvingar fram ljud och
    // vibration ändå när en ny ersätter en gammal — utan den är rapport
    // nummer två helt tyst.
    renotify: !iForgrunden,
    silent: iForgrunden,
    requireInteraction: false,
    vibrate: iForgrunden ? undefined : [220, 90, 120, 90, 220],
    data: { url: './' },
  };

  /*
   * Via service workern i första hand. En vanlig `new Notification()` visas
   * inte alls när sidan inte är i förgrunden på Android, och finns inte alls
   * i en installerad PWA på iOS — alltså precis i de två fall notisen finns
   * för. Den direkta vägen står kvar som reserv för skrivbordet.
   */
  (async () => {
    try {
      /*
       * getRegistration() och inte .ready.
       *
       * .ready är ett löfte som ALDRIG avvisas — registreras ingen service
       * worker väntar det i evighet. Det hade betytt en notis som tyst aldrig
       * blir av, alltså exakt samma sorts fel som resten av den här
       * genomgången handlar om. getRegistration() svarar direkt, med
       * undefined när ingen finns, och då tar reservvägen vid.
       */
      const reg = swRegistration || await navigator.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) { await reg.showNotification(titel, val); return; }
      new Notification(titel, val);
    } catch (e) {
      console.warn('[notis] kunde inte visas', e);
    }
  })();

  return true;
}

/* ================= Varningsbanner ================= */

function showAlertBanner(alert) {
  currentAlert = alert;
  const h = alert.hazard;
  const b = $('alertBanner');
  b.hidden = false;
  b.classList.toggle('camera', h.type === 'camera');
  $('alertIcon').textContent = TYPE_ICON[h.type] || '⚠️';
  $('alertTitle').textContent = `${TYPE_LABEL[h.type] || 'Varning'}${h.label ? ' · ' + h.label : ''}`;
  /*
   * Underraden är hela meningen, inte bara siffrorna.
   *
   * Bannern är det enda föraren hinner läsa i 90 km/h, och den sa förut
   * "1,2 km bort · 12 min sedan". Avståndet går att agera på; resten var en
   * gåta. Nu står det vad rapporten betyder och varifrån den kommer, med
   * avståndet först eftersom det är det som avgör om man behöver bry sig alls.
   *
   * Rubriken ovanför upprepar typ och plats. Här är upprepningen med flit:
   * rubriken är en etikett man känner igen på formen, underraden är en
   * mening man läser. Tar man bort den ena blir den andra sämre.
   */
  const kort = sammanfattaKort(h, { egen: arMin(h) });
  $('alertSub').textContent = kort
    ? `${shortDistance(alert.distance)} bort. ${kort}`
    : `${shortDistance(alert.distance)} bort` +
      (h.createdAt && !h.fixed ? ` · ${relativeTime(h.createdAt)}` : '');
  clearTimeout(showAlertBanner._t);
  showAlertBanner._t = setTimeout(hideAlertBanner, 14000);

  /*
   * Mörkläget speglar varningen direkt.
   *
   * Det här är den enda plats varje varning säkert passerar. Första försöket
   * hängde mörkläget på en händelse från varningsmotorn i stället, och då
   * syntes varningen inte alls på den mörka skärmen — provkörningen visade
   * tom ruta. Ett sparläge som döljer det appen finns till för är inte ett
   * sparläge, det är ett fel.
   */
  renderMorkt();

  /*
   * Och samma varning en gång till, på ytan som syns utanför kartan.
   *
   * Ljudet och rösten har redan gått ut när vi kommer hit: alerts.js
   * #announce() gör chime + say och dispatchar 'alert' efteråt, så ordningen
   * ljud → röst → yta håller även på den här vägen utan att något behöver
   * ändras i alerts.js.
   *
   * Bannern står kvar. Den är inte överflödig: den är källan renderMorkt()
   * läser ($('alertTitle').textContent), och tas den bort blir mörka
   * körläget tyst igen — ett fel som redan gjorts en gång och som
   * kommentaren ovanför beskriver.
   *
   * Avståndet skickas med: det är det enda motorn vet och listan inte, och
   * det är också det första föraren vill veta. `egen` avgör om ytan får säga
   * "du rapporterade" i stället för "någon varnade".
   */
  visaYtanOverallt(h, { avstand: alert.distance, egen: arMin(h) });

  /*
   * Och den fjärde kanalen: notisen. Se notisOverallt() ovanför.
   *
   * Sist i ordningen med flit — pling, röst, yta, notis. De tre första når
   * en förare som tittar på appen; notisen är den enda som når en telefon
   * med släckt skärm, och den ska inte kunna försena någon av de andra.
   */
  notisOverallt(h, { egen: arMin(h) });
}

/*
 * Bannerns fjortonsekunderstimer släcker BARA bannern.
 *
 * Frestelsen var att låta den ta ytan med sig — de visar ju samma varning.
 * Men ytan har en kö och en egen klocka som startar om vid varje ny rapport.
 * En timer härifrån hade släckt rapport nummer två efter att den legat uppe i
 * en sekund. Ytan går bort av sig själv, eller när föraren trycker på dess
 * egen kryssknapp.
 */
function hideAlertBanner({ avForaren = false } = {}) {
  $('alertBanner').hidden = true;
  currentAlert = null;
  renderMorkt();
  /*
   * Tryckte föraren själv bort varningen ska den vara borta överallt.
   *
   * Att stänga en varning på kartan och sedan hitta samma varning kvar när
   * man byter till Chatt är inte två ytor, det är en app som inte lyssnar.
   * Bara vid det uttryckliga trycket — se kommentaren ovanför om timern.
   */
  if (avForaren) stangYtanOverallt();
}

/* ================= Rapportering ================= */

/**
 * Genvägar från hemskärmen.
 *
 * Håller man in appikonen får man "Rapportera polis", "Kontroll" och "Civil
 * bil" direkt i menyn. Det löser det roadmapen kallar snabbrapport utan att
 * låsa upp: färre steg mellan att se något och att andra blir varnade.
 *
 * Två saker som måste stämma, annars gör funktionen mer skada än nytta:
 *
 * Adressen städas direkt. Ligger ?rapport= kvar och användaren laddar om
 * skickas en ny rapport från fel plats, och den som råkar uppdatera sidan
 * några gånger fyller kartan med spöken.
 *
 * Rapporten skickas inte förrän GPS svarat. reportAt väntar själv in en
 * position, så en genväg som trycks innan telefonen hunnit få fix hamnar rätt
 * ändå istället för på förra kända platsen.
 */
async function hanteraGenvag() {
  const typ = new URLSearchParams(location.search).get('rapport');
  if (!typ) return;

  // Bort ur adressen innan något annat händer.
  const ren = location.pathname + location.hash;
  history.replaceState(null, '', ren);

  if (!['police', 'control', 'unmarked'].includes(typ)) return;

  toast(`Hämtar din position för att rapportera ${TYPE_LABEL[typ]?.toLowerCase() || typ}…`, 4000);
  try {
    await reportAt(typ);
  } catch {
    toast('Kunde inte rapportera — ingen position. Försök igen när GPS svarat.', 6000);
  }
}

async function reportAt(type, { lat, lon, label, source = 'app', geokod } = {}) {
  if (!gateOrPaywall()) return;
  try {
    /*
     * Kom punkten från telefonen eller från ett namn?
     *
     * Skillnaden avgör hur mycket appen får låta som att den vet. Står
     * telefonen på platsen är osäkerheten några meter. Kom punkten ur en
     * namnuppslagning kan den ligga en kilometer fel — "rondellen" finns det
     * fyra av i Västerås.
     *
     * Tidigare skickades ALLTID geokod: 'gps', även för röstrapporter som
     * Nominatim slagit upp. Appen läste då "polis vid Erikslund, klockan 2"
     * med full säkerhet om en punkt den gissat fram. Det är precis den falska
     * precision kvalitet.js finns för att förhindra — dess egen ingress
     * kallar det samma svek som ett falskt påstående, bara svårare att
     * upptäcka.
     */
    const egenPosition = (lat == null || lon == null);
    let pos = egenPosition ? null : { lat, lon };
    if (!pos) {
      pos = geo.position || await currentPosition();
    }
    let name = label;
    if (!name) {
      name = await reverseGeocode(pos.lat, pos.lon) || '';
    }
    // Skicka med hur rapporten kom till, inte bara var.
    //
    // Utan det här kan kvalitet.js inte skilja en färsk rapport från en
    // knapptryckning sex minuter efter passagen i 110 — och behandlar då
    // allt som osäkert, vilket i praktiken tystar appen. Fälten är billiga
    // att samla in i det ögonblick rapporten skapas och omöjliga att
    // rekonstruera efteråt.
    /*
     * Vid kallstart finns ingen löpande fix — då kom positionen från
     * currentPosition(), och dess noggrannhet är den enda vi har.
     *
     * Tidigare lästes bara geo.position, som är null just då. Rapporten gick
     * iväg utan noggrannhet, och kvalitet.js antog 25 meter. Är den verkliga
     * noggrannheten 80 lät appen säkrare än den var — i precis det ögonblick
     * den har minst skäl till det, eftersom GPS:en nyss vaknat.
     */
    const nufix = geo.position || (egenPosition ? pos : null);

    /*
     * GPS-noggrannheten och farten beskriver FÖRAREN, inte punkten.
     *
     * Ligger rapporten på en uppslagen adress säger förarens tio meters
     * noggrannhet ingenting om hur rätt den adressen är — och att skicka med
     * den ändå fick kvalitetslagret att räkna på fel osäkerhet. Samma sak med
     * farten: den används för att uppskatta hur långt bilen hunnit sedan
     * föraren såg något, vilket bara betyder något när punkten är den egna.
     */
    const r = await store.add({
      type, lat: pos.lat, lon: pos.lon, label: name, source,
      gpsAccuracyM: egenPosition && Number.isFinite(nufix?.accuracy)
        ? Math.round(nufix.accuracy) : null,
      fartKmh: egenPosition && Number.isFinite(nufix?.speedKmh)
        ? Math.round(nufix.speedKmh) : null,

      // Femton sekunder är ett ANTAGANDE, inte en mätning.
      //
      // Tiden mellan att föraren ser polisen och trycker på knappen går inte
      // att mäta — appen vet inte när blicken föll på patrullen. Men att
      // lämna fältet tomt betyder "vet inte", och kvalitet.js räknar då med
      // värsta fallet: över en kilometers osäkerhet även för en färsk
      // rapport med perfekt GPS. Då tystnar vardagsrapporten, alltså den
      // vanligaste och mest tillförlitliga av dem alla.
      //
      // Femton sekunder svarar mot att sträcka sig efter telefonen och hålla
      // in knappen. Det skalar med farten av sig själv: 125 m i 30 km/h,
      // 460 m i 110. Ändras knappen till att kräva längre håll ska siffran
      // följa med.
      // Bara meningsfullt för den egna positionen. Ligger punkten på en
      // uppslagen adress finns ingen "fördröjning sedan passagen" att tala
      // om — då låter vi kvalitet.js använda sina källmedvetna antaganden
      // (voice: 8 s) i stället för att skicka en siffra som inte betyder något.
      fordrojningS: egenPosition ? 15 : null,

      /*
       * Var punkten kom ifrån, på riktigt.
       *
       * 'gps' betyder "telefonen stod här". Skickas det för en punkt som
       * slagits upp ur ett namn ger kvalitet.js 15 meters osäkerhet och
       * +0,10 i poäng åt en gissning som kan ligga en kilometer fel — och
       * appen läser upp klockriktning för den, som om den vore mätt.
       *
       * Anroparen får säga till när den vet bättre: onMapPick skickar
       * 'karta', eftersom föraren pekade själv och stod stilla.
       */
      geokod: geokod || (egenPosition ? 'gps' : 'nominatim'),
    });
    speaker.chime('ack');
    const what = TYPE_LABEL[type] || 'Varning';
    if (r.merged) {
      toast(`${what} fanns redan här — din rapport bekräftade den.`);
      speaker.say('Tack, bekräftad.', { priority: 0 });
    } else {
      toast(`${what} rapporterad${name ? ' vid ' + name : ''}. Alla i närheten varnas nu.`);
      speaker.say(`Tack. ${what} ${name ? 'vid ' + name : 'här'} är rapporterad.`, { priority: 0 });
    }
    // Varna inte dig själv för det du precis rapporterade
    engine.state.set(r.id, { warnedAt: Date.now(), insideRadius: true, closest: 0 });
    if (!r.merged) { reputation.addReport(); stats.record(r); showUndo(r); } else { reputation.addVerify(); }
    renderReputation();
    renderHazards();
  } catch (e) {
    toast('Kunde inte hämta din position. Försök igen om en stund.', 4500);
  }
}

/** Rapportera vid en namngiven plats. Kan behöva fråga var den ligger. */
async function reportAtPlace(type, place) {
  if (!gateOrPaywall()) return;
  const hit = await geocode(place);
  if (hit) {
    await reportAt(type, { lat: hit.lat, lon: hit.lon, label: hit.label, source: 'voice' });
    return;
  }
  // Okänd plats — låt föraren peka ut den en gång
  pendingPick = { place, type };
  $('mtBody').textContent =
    `Appen hittar inte "${place}". Peka på kartan så kommer den ihåg platsen för alltid.`;
  $('modalTeach').hidden = false;
  speaker.say(`Jag hittar inte ${place}. Peka ut det på kartan när du står stilla.`, { priority: 0 });
}

function onMapPick({ lat, lon }) {
  map.setPickMode(false);
  map.clearPin();
  if (!pendingPick) return;
  const { place, type } = pendingPick;
  pendingPick = null;
  learnPlace(place, lat, lon, place);
  refreshLearnedList();
  toast(`"${place}" sparad. Nästa gång hittar appen dit direkt.`);
  // Föraren pekade själv på kartan, stillastående. Det är en bättre position
  // än en namnuppslagning och kvalitet.js har ett eget värde för den.
  reportAt(type, { lat, lon, label: place, source: 'voice', geokod: 'karta' });
}

/** Markera närmaste rapport av en typ som borta. */
async function clearNearest(type) {
  const fix = geo.position;
  if (!fix) return toast('Ingen GPS-position.');
  const candidates = store.active()
    .filter(r => !type || r.type === type)
    .map(r => ({ r, d: haversineFix(fix, r) }))
    .filter(x => x.d < 4000)
    .sort((a, b) => a.d - b.d);
  if (!candidates.length) {
    speaker.say('Hittar ingen rapport i närheten att ta bort.', { priority: 0 });
    return toast('Ingen rapport i närheten.');
  }
  const target = candidates[0].r;
  await (isMine(target.id) ? store.remove(target.id) : store.deny(target.id));
  speaker.chime('ack');
  speaker.say('Tack, jag har markerat den som borta.', { priority: 0 });
  toast(`${TYPE_LABEL[target.type]} markerad som borta.`);
}

/* ================= Röst ================= */

/**
 * Har mikrofonen nekats?
 *
 * Sparas mellan sessioner. Webbläsaren minns nekandet, så om vi glömmer det
 * mellan omstarter skulle användaren mötas av en knapp som ser fungerande ut
 * men tyst inte gör någonting.
 */
let micDenied = false;
try { micDenied = localStorage.getItem('pv.micDenied') === '1'; } catch {}

function setMicDenied(v) {
  micDenied = !!v;
  try {
    if (v) localStorage.setItem('pv.micDenied', '1');
    else localStorage.removeItem('pv.micDenied');
  } catch {}
  $('btnMic')?.classList.toggle('needs-permission', micDenied);
}

function openMicDialog() {
  const m = $('modalMic');
  if (!m) return;
  $('micHow').textContent = '';
  m.hidden = false;
}

function startListening() {
  speaker.chime('listen');
  listener.startCommand();
  openVoiceOverlay();
}

function wireVoice() {
  setMicDenied(micDenied);

  $('btnMic').onclick = () => {
    if (!voiceInputSupported) {
      toast('Den här webbläsaren stödjer inte röstigenkänning. På iPhone får du använda knapparna.', 6000);
      return;
    }
    if (!gateOrPaywall()) return;

    // Nekad tidigare: fråga istället för att försöka i tysthet. Ett nytt
    // försök utan förklaring ser bara ut som att knappen är trasig.
    if (micDenied) { openMicDialog(); return; }

    startListening();
  };

  $('micEnable').onclick = () => {
    $('modalMic').hidden = true;
    // Rensa flaggan och försök på riktigt. Sitter blockeringen kvar i
    // webbläsaren kommer 'denied' tillbaka direkt och flaggan sätts om —
    // men då vet vi att det inte var en feltryckning.
    setMicDenied(false);
    startListening();
  };

  $('micHelp').onclick = () => {
    const p = (() => { try { return Behorigheter.plattform(); } catch { return {}; } })();
    $('micHow').textContent = p.ios
      ? 'iPhone: Inställningar → Safari → Mikrofon → Tillåt. Ligger appen på hemskärmen hittar du den istället under Inställningar → Polisvakt.'
      : p.android
        ? 'Android: tryck på hänglåset i adressfältet → Behörigheter → Mikrofon → Tillåt. Ligger appen på hemskärmen: Inställningar → Appar → Polisvakt → Behörigheter.'
        : 'Klicka på hänglåset till vänster om adressen i webbläsaren och sätt Mikrofon till Tillåt. Ladda sedan om sidan.';
  };

  $('micCancel').onclick = () => { $('modalMic').hidden = true; };

  listener.addEventListener('wake', () => {
    speaker.chime('listen');
    openVoiceOverlay();
  });

  listener.addEventListener('heard', e => {
    if (!$('voiceOverlay').hidden) $('voiceText').textContent = e.detail.text || 'Lyssnar…';
  });

  listener.addEventListener('command', e => {
    closeVoiceOverlay();
    handleCommand(e.detail.text);
  });

  listener.addEventListener('timeout', () => {
    closeVoiceOverlay();
  });

  listener.addEventListener('denied', () => {
    settings.wakeWord = false; saveSettings();
    $('setWake').checked = false;
    setMicDenied(true);
    closeVoiceOverlay();
    renderStatus();
    // Knappen får inte se död ut. Nästa tryck ska erbjuda en väg tillbaka.
    toast('Mikrofonen är avstängd. Tryck på Tala för att slå på den.', 6000);
  });

  $('voiceCancel').onclick = () => { listener.stop(); closeVoiceOverlay(); restartWakeIfOn(); };
}

/**
 * Exempel som visas medan mikrofonen lyssnar.
 *
 * Hela meningar, inte stickord. Folk härmar det de ser, och "polis Dillos"
 * lär dem att prata som en sökmotor — vilket ger sämre igenkänning än en
 * naturlig mening. Exemplen roterar så att man ser att formuleringen är fri.
 */
const VOICE_EXAMPLES = [
  'Polis står vid rondellen på Norrleden',
  'Det står en civil polisbil vid infarten till köpcentret',
  'Trafikkontroll på riksväg 66 strax norr om avfarten',
  'Polisen står på bron precis innan avfarten',
  'Civil bil vid busshållplatsen på Bergslagsvägen',
  'Poliskontroll i rondellen vid järnvägsstationen',
];
let voiceExampleIndex = Math.floor(Math.random() * VOICE_EXAMPLES.length);

function openVoiceOverlay() {
  $('voiceText').textContent = 'Lyssnar…';
  const hint = $('voiceHint');
  if (hint) {
    voiceExampleIndex = (voiceExampleIndex + 1) % VOICE_EXAMPLES.length;
    hint.innerHTML = 'Säg till exempel:<br><i>"' +
      escapeHtml(VOICE_EXAMPLES[voiceExampleIndex]) + '"</i>';
  }
  $('voiceOverlay').hidden = false;
  $('btnMic').classList.add('listening');
}
function closeVoiceOverlay() {
  $('voiceOverlay').hidden = true;
  $('btnMic').classList.remove('listening');
}
function restartWakeIfOn() {
  if (settings.wakeWord && voiceInputSupported) listener.startWakeWord();
}

async function handleCommand(text) {
  const t = normalize(text);
  if (!t) return;

  // Systemkommandon först
  if (/^(tyst|tysta|var tyst|stäng av ljud|inga varningar)/.test(t)) {
    speaker.mute(15);
    $('btnMute').classList.add('muted');
    $('btnMute').innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-mute-off"/></svg>';
    toast('Tyst i 15 minuter. Akuta varningar hörs ändå.');
    return;
  }
  if (/^(ljud på|prata|slå på ljud|hörs)/.test(t)) {
    speaker.unmute();
    $('btnMute').classList.remove('muted');
    $('btnMute').innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-mute-on"/></svg>';
    speaker.say('Ljudet är på igen.', { priority: 0 });
    return;
  }

  const parsed = parseReportText(t);

  if (parsed?.intent === 'refused' && parsed.reason === 'sobriety') {
    speaker.say('Nykterhetskontroller rapporteras inte i den här appen.', { priority: 1 });
    toast('Nykterhetskontroller rapporteras inte. Att varna för dem hjälper någon att köra vidare full.', 7000);
    return;
  }

  if (parsed?.intent === 'refused' && parsed.reason === 'camera') {
    speaker.say('Fartkamerorna finns redan i appen. Du behöver inte rapportera dem.', { priority: 0 });
    toast(`Alla ${cameras.length} fartkameror i Västmanland finns redan inlagda med rätt position och mätriktning.`, 6000);
    return;
  }

  if (!parsed) {
    speaker.say('Jag förstod inte. Säg till exempel polis vid Dillos.', { priority: 0 });
    toast(`Uppfattade inte: "${text}"`, 4000);
    return;
  }

  if (parsed.intent === 'clear') {
    await clearNearest(parsed.type);
    return;
  }

  const place = parsed.place;
  const isHere = !place || /^(här|har|hær|nu|på plats)$/.test(place) || place.split(' ').length === 0;
  if (isHere) {
    await reportAt(parsed.type, { source: 'voice' });
  } else {
    await reportAtPlace(parsed.type, place);
  }
}

/* ================= Facebook-ingest ================= */
//
// Anropas av bryggan (userscript eller Telegram-spegel) via
// window.polisvakt.ingest(...). Samma parser som rösten använder.

window.polisvakt = {
  /**
   * Ta emot inlägg från bryggan.
   *
   * Själva arbetet ligger i facebook.js: den dubblettkollar mot vad som redan
   * hämtats, kastar för gamla inlägg, redovisar exakt vad som sorterades bort
   * och samlar upp platsnamn appen inte kände igen. Den tidigare varianten här
   * gjorde en förenklad version av samma sak och tappade allt det.
   *
   *   polisvakt.ingest(inlägg)                  skapa varningar
   *   polisvakt.ingest(inlägg, { dryRun: true }) se vad som HADE hänt
   *
   * Torrkörningen är inte en bekvämlighet. Ett flöde man släpper lös oläst kan
   * fylla kartan med skräp för alla andra användare, och det går inte att ta
   * tillbaka. Kör den först.
   */
  async ingest(payload, options = {}) {
    const summary = await Facebook.ingest(payload, options);
    if (summary.created && !summary.dryRun) {
      await store.refresh();
      renderHazards();
    }
    if (summary.unknownPlaces?.length) {
      // Platser appen inte hittade. Lär den med polisvakt.learn(namn, lat, lon)
      // så känns de igen nästa gång.
      console.info('Okända platser:', summary.unknownPlaces.join(', '));
    }
    console.info(Facebook.summaryText(summary));
    return summary;
  },
  parse: parseReportText,
  learn: learnPlace,
  // Felsökningsyta. Samma skäl som store/geo/speaker redan ligger här: utan
  // dem går appens verkliga tillstånd inte att granska utifrån, och då blir
  // varje test ett test av en kopia istället för av det som faktiskt kör.
  store, geo, speaker, dashcam, vakthund, varmevakt, routeGuide, map, coverage,
  // engine och billing ligger här av samma skäl, och för att inkommande-test.html
  // ska kunna byta ut agerFaran och abonnemangssvaret mot kända värden i stället
  // för att vänta på att en bil ska röra sig.
  engine, billing,
  get settings() { return settings; },

  /*
   * Inkommande-uppläsningen utifrån.
   *
   * spar/sparText är svaret på "varför var den tyst?" — se blocket
   * "Uppläsning vid inkommande rapport" längre ner. Resten finns för
   * inkommande-test.html, som kör den RIKTIGA kedjan i stället för en kopia
   * av den. En kopia hade bara bevisat att kopian fungerar, och det var
   * precis så felet den 23 augusti 2026 kunde ligga kvar oupptäckt.
   *
   * Getters och inte värden: objektet här byggs medan modulen laddas, och
   * konstanterna längre ner i filen finns inte än i det ögonblicket.
   */
  inkommande: {
    spar: () => [...inkommandeSpar],
    sparText: () => inkommandeSparText(),
    sok: () => inkommandeSok(),
    sag: () => inkommandeSag(),
    flode: () => inkommandeFlode(),
    farsk: (h, nu) => inkommandeArFarsk(h, nu),
    lyft: h => inkommandeKvalitetslyft(h),
    nollstall: o => inkommandeNollstall(o),
    get sedda() { return inkommandeSedda; },
    get ko() { return inkommandeKo; },
    get omgangar() { return inkommandeOmgangar; },
    /*
     * Provdokumenten sätter omgangar för att välja läge: 0 = utgångsläget,
     * 2 = "appen har varit igång ett tag". Utgångsläget avgörs numera av
     * datan och inte av räknaren (se inkommandeUtgangslagetBokfort), så
     * flaggan måste följa med — annars ställer provet in ett läge koden inte
     * längre läser, och mäter något annat än det tror.
     */
    set omgangar(v) {
      inkommandeOmgangar = v;
      inkommandeUtgangslagetBokfort = v >= 2;
    },
    get utgangslagetBokfort() { return inkommandeUtgangslagetBokfort; },
    set utgangslagetBokfort(v) { inkommandeUtgangslagetBokfort = !!v; },
    get samlaMs() { return INKOMMANDE_SAMLA_MS; },
  },
  // Läsaren skapas först när läget väljs, så den måste hämtas vid anrop.
  get plate() { return plate; },
  chatt, ljud, korvanor,
  // Belöningsbeskedet går att provköra utan att vänta på ett månadsskifte.
  visaBelaning, renderKorfalt, remote, groups,
  get nav() { return nav; },
  // Gruppnotisreglagets fem lägen, för mätning. Se ritaGruppnotis.
  ritaGruppnotis: s => ritaGruppnotis(s),
  /*
   * Genvägarna och rörelsen, för mätning i en riktig telefon.
   *
   * Animationer går inte att bedöma i en skrivbordsflik: de tappar bildrutor
   * först när kartan ritas och dashcamen läser en videoström samtidigt. Med
   *   polisvakt.oppnaInstallning('setPlPip')
   * går varje genväg att provköra utan att först försätta telefonen i det
   * läge som normalt utlöser den — nekade notiser, till exempel.
   */
  oppnaInstallning, rorelse: Rorelse,
};

/* ================= Gränssnitt ================= */

function wireUI() {
  // Vyer
  document.querySelectorAll('.tab').forEach(btn => {
    btn.onclick = () => showView(btn.dataset.view);
  });

  /* Tillbehörskortet i Inställningar är numera en skylt som pekar mot
     Butik-fliken. Kopplas här och inte i butik.js: knappen ska fungera
     även om butiksmodulen inte gick att hämta — vyn med sin reservtext
     finns alltid. */
  $('btnOppnaButik')?.addEventListener('click', () => showView('butik'));

  // Rapportknappar: tryck och håll, inte ett vanligt tryck.
  //
  // Knapparna sitter längst ner där tummen vilar. Ett vanligt tryck betyder
  // att varje snedtryck blir en falsk rapport som skickas till alla andra i
  // Västmanland — och falska rapporter är det enda som verkligen kan förstöra
  // appen. Håll i sex tiondelar räcker för att det ska vara omöjligt av
  // misstag, men är fortfarande en enda rörelse med tummen.
  document.querySelectorAll('[data-report]').forEach(btn => setupHoldToReport(btn));

  $('btnFollow').onclick = () => map.setFollow(true);

  /*
   * GPS-chippet får ett riktigt jobb.
   *
   * De fyra chippen i HUD:en är <button> men hade ingen enda klickhanterare —
   * fyra träffytor som ser tryckbara ut och inte gör något. Det är den sortens
   * detalj som lär föraren att appen inte svarar, och den lärdomen tar han
   * sedan med sig till knappar som FAKTISKT gör något.
   *
   * Chippet visar täckningen, alltså svarar det på frågan "var får jag
   * varningar?". Ett tryck går därför dit den frågan ställs. Finns inte
   * rubriken i den här versionen av index.html öppnas ändå inställningarna —
   * en genväg som landar en skärm fel är oändligt mycket bättre än en knapp
   * som inte gör något.
   *
   * Rundturens steg mot #chips (js/tour.js rad 63) pekar fortfarande på samma
   * element, så guiden är orörd.
   */
  $('chipGps').onclick = () => oppnaInstallning('covRubrik');
  // Pilen och inte funktionsreferensen: onclick skickar med händelseobjektet
  // som första argument, och då hade { avForaren } lästs ur en MouseEvent och
  // alltid blivit false. Ett tryck på krysset ska stänga varningen överallt,
  // inte bara på kartan.
  $('alertClose').onclick = () => hideAlertBanner({ avForaren: true });

  $('btnMute').onclick = () => {
    if (speaker.muted) {
      speaker.unmute();
      $('btnMute').classList.remove('muted');
      $('btnMute').innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-mute-on"/></svg>';
      toast('Ljudet är på.');
    } else {
      speaker.mute(15);
      speaker.stop();
      $('btnMute').classList.add('muted');
      $('btnMute').innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-mute-off"/></svg>';
      toast('Tyst i 15 minuter.');
    }
  };

  $('sheetGrip').onclick = () => $('sheet').classList.toggle('collapsed');

  // Lär-appen-en-plats
  $('mtCancel').onclick = () => { $('modalTeach').hidden = true; pendingPick = null; };
  $('mtPick').onclick = () => {
    $('modalTeach').hidden = true;
    showView('map');
    map.setPickMode(true);
    map.setFollow(false);
    toast('Peka på platsen på kartan.', 5000);
  };

  // Installationsguide
  $('miClose').onclick = () => { $('modalInstall').hidden = true; Install.markSeen(); };
  $('btnGuide').onclick = () => openInstallGuide(false);
  $('btnTour').onclick = () => { resetTour(); startTour(); };
  $('platformPick').onclick = e => {
    const b = e.target.closest('[data-platform]');
    if (b) renderGuide(b.dataset.platform);
  };
  installPrompt.addEventListener('available', () => {
    if (!$('modalInstall').hidden) $('btnNativeInstall').hidden = false;
  });
  $('btnNativeInstall').onclick = async () => {
    const ok = await installPrompt.prompt();
    if (ok) { $('modalInstall').hidden = true; Install.markSeen(); }
  };

  // Betalvägg
  $('pwLater').onclick = () => { $('modalPaywall').hidden = true; };
  $('pwSubscribe').onclick = startCheckout;
  $('btnSubscribe').onclick = startCheckout;
  $('btnRedeem').onclick = async () => {
    const res = await billing.redeem($('redeemCode').value);
    $('redeemHint').textContent = res.ok ? 'Koden är inlöst. Tack!' : res.error;
    if (res.ok) { $('modalPaywall').hidden = true; renderBilling(); }
  };

  // Klippspelare
  $('clipClose').onclick = closeClipModal;

  addEventListener('orientationchange', () => {
    map.invalidate();
    setTimeout(() => {
      const landscape = Math.abs(window.orientation) === 90 ||
        window.matchMedia('(orientation: landscape)').matches;
      dashcam.setOrientation(landscape ? 'landscape' : 'portrait');
      syncDashcamUI();
    }, 300);
  });
}

/**
 * Tryck och håll för att rapportera.
 *
 * Knappen fylls medan man håller, vibrerar när den går igenom, och släpper
 * man för tidigt händer ingenting. Efteråt ligger en ångra-knapp kvar i sex
 * sekunder — dubbelt skydd, för den som ändå råkar hålla kvar.
 */
const HOLD_MS = 600;

function setupHoldToReport(btn) {
  let timer = null, fired = false, startedAt = 0;

  const start = e => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    e.preventDefault();
    fired = false;
    startedAt = Date.now();
    btn.classList.add('holding');
    btn.style.setProperty('--hold-ms', HOLD_MS + 'ms');
    timer = setTimeout(() => {
      fired = true;
      btn.classList.remove('holding');
      btn.classList.add('fired');
      setTimeout(() => btn.classList.remove('fired'), 400);
      try { navigator.vibrate?.(35); } catch {}
      reportAt(btn.dataset.report);
    }, HOLD_MS);
  };

  const cancel = () => {
    clearTimeout(timer);
    btn.classList.remove('holding');
    // Snabbtryck: förklara varför inget hände, men bara en gång i taget
    if (!fired && Date.now() - startedAt < HOLD_MS && startedAt) {
      toast('Håll knappen intryckt en stund för att rapportera.', 2600);
    }
    startedAt = 0;
  };

  btn.addEventListener('touchstart', start, { passive: false });
  btn.addEventListener('touchend', cancel);
  btn.addEventListener('touchcancel', cancel);
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', cancel);
  btn.addEventListener('mouseleave', cancel);
  // Ett vanligt klick ska aldrig göra något på egen hand
  btn.addEventListener('click', e => e.preventDefault());
}

/**
 * Ångra en rapport. Sex sekunder, sedan är den ute hos alla andra.
 * Kortare än så hinner man inte reagera i en bil; längre och rapporten
 * hinner varna någon som sedan ser den försvinna.
 */
let undoTimer = null;
function showUndo(report) {
  clearTimeout(undoTimer);
  const el = $('undoBar');
  $('undoText').textContent = `${TYPE_LABEL[report.type]} rapporterad${report.label ? ' vid ' + report.label : ''}`;
  el.hidden = false;
  $('undoBtn').onclick = async () => {
    el.hidden = true;
    clearTimeout(undoTimer);
    await store.remove(report.id);
    engine.state.delete(report.id);
    speaker.stop();
    toast('Rapporten togs bort.');
    renderHazards();
  };
  undoTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/* Sätts när inställningarna kopplas. showView ligger på modulnivå medan
   funktionen bor i wire-blocket, så den måste räckas ut hit — annars blir
   anropet nedan ett ReferenceError som fångas av en catch och försvinner. */
let synkaGruppnotis = () => {};

/* Samma sak, men för att kunna mäta. Gruppnotisreglaget har fem lägen och
   fyra av dem går bara att se när servern svarar på ett visst sätt — de
   ritas aldrig i en webbläsare där notiser är nekade. Utan den här kroken
   är de fyra oprövade tills en riktig användare hamnar i dem. */
let ritaGruppnotis = () => {};

/* Och för räckvidden. Samma skäl som ovan: rutan står i inställningarna men
   ritas om från showView, som ligger på modulnivå. */
let synkaNotisOmfang = () => {};

function showView(name) {
  /* Vilken vy vi kom ifrån, läst INNAN något ändras. Riktningen är hela
     poängen med rörelsen: en vy som bara tonar in säger att något bytte, en
     vy som kommer in från höger säger VARIFRÅN den kom. Utan den här raden
     hade rorelse.js fått gissa, och en gissad riktning är värre än ingen. */
  const forraVyn = document.body.dataset.view;

  document.body.dataset.view = name;
  for (const v of ['map', 'dashcam', 'chatt', 'butik', 'settings']) {
    $('view-' + v).hidden = v !== name;
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));

  /* Efter hidden-bytet och före allt tungt nedanför.
     Efter, för att animationen ska ligga på en vy som redan står framme —
     ett element med display: none animeras inte. Före renderingarna, för att
     den första bildrutan ska hinna ritas medan listorna fortfarande räknas.
     Rorelse.bytVy() gör själv ingenting när rundturen, mörkt körläge eller en
     varning är uppe; se farRoraVyn() i js/rorelse.js. */
  Rorelse.bytVy(forraVyn, name);

  // Skyltläsaren stoppas när man lämnar vyn. Till skillnad från dashcamen,
  // som ska fortsätta filma medan man tittar på kartan, gör läsaren ingen
  // nytta i bakgrunden — den skulle bara hålla kameran upptagen och dra
  // batteri för resultat ingen ser.
  if (name !== 'dashcam' && plate?.running) stoppaPlate();

  // Chatten pollar snabbt när man tittar på den och långsamt annars. En
  // bilapp som hämtar meddelanden var åttonde sekund i bakgrunden hela resan
  // äter batteri för ingenting.
  chatt.sattVyAktiv(name === 'chatt');
  if (name === 'chatt') { sattChattLast(); renderChatt(); }
  if (name === 'dashcam') renderOlasta();

  if (name === 'map') map.invalidate();
  if (name === 'dashcam') refreshClipList();
  if (name === 'butik') butikModul?.rita();
  if (name === 'settings') { refreshLearnedList(); renderBilling(); renderShareQR(); renderPlans(); renderChain($('roadmapChain')); renderNotisTyper(); synkaGruppnotis(); synkaNotisOmfang(); ritaBehKort(); }
}

/* ================= Genvägar in i inställningarna ================= */
//
// Appen har tre knappar som inte gör något själva, utan skickar föraren till
// ett reglage längre in: "Fixa det" i påminnelseraden, "Mina fordon" i
// dashcamvyn och GPS-chippet på kartan. Alla tre gick tidigare samma väg:
// showView('settings') och sedan scrollIntoView på ett id.
//
// Den vägen har ett tyst fel. scrollIntoView mot ett element som ligger i en
// hopfälld grupp gör INGENTING och säger ingenting — inget kastat fel, ingen
// konsolrad, bara en vy som står kvar högst upp. Det yttrar sig som "knappen
// gör inget ibland", och det är exakt den knapp som trycks av någon vars
// notiser redan inte fungerar.
//
// Därför går alla tre numera genom oppnaInstallning(). Den öppnar gruppen
// först, rullar sedan, och ringar in det man landade på.

/**
 * Hämta inställningsmodulen.
 *
 * DYNAMISK import, till skillnad från allt annat i huvudet på filen, och det
 * är ett medvetet undantag. Varningsytan importeras statiskt just för att ett
 * fel där ska ta hela appen med sig — en app som varnar utan att synas är
 * inte mindre trasig än en app som inte startar. En genväg till ett reglage
 * är inte i den klassen. Saknas js/inst.js i en utrullning ska föraren få
 * dagens beteende, inte en vit skärm.
 *
 * Laddas i boot() och inte vid första trycket: hämtningen tar ett par
 * hundradelar på fyra streck, och den ska vara avklarad innan någon trycker.
 */
async function laddaInst() {
  if (instModul) return instModul;
  try { instModul = await import('./inst.js'); }
  catch { instModul = null; }                 // filen finns inte — reserven tar över
  return instModul;
}

/**
 * Butiken, samma mönster som laddaInst() och av samma skäl: en hylla med
 * tillbehör är inte i klassen "hellre vit skärm än utan". Saknas filen i en
 * utrullning står reservtexten i #view-butik kvar och pekar mot uppkopplingen
 * — fel budskap i just det fallet, men ett läge föraren tar sig ur genom att
 * uppdatera, inte en app som dött.
 */
async function laddaButik() {
  if (butikModul) return butikModul;
  try {
    butikModul = await import('./butik.js');
    /* toast och e-post räcks in i stället för att butik.js importerar
       app.js — cirkeln app→butik→app är exakt den sortens knut som ger
       "fungerar ibland" vid uppstart. */
    butikModul.start({ toast, epost: () => auth.email || null });
  } catch { butikModul = null; }
  return butikModul;
}

/**
 * Öppna inställningarna och lyft fram ett reglage.
 *
 * Enda tillåtna vägen till ett id inuti inställningsvyn. Rulla aldrig direkt
 * till ett id härifrån — gruppen kan vara stängd, och då är rullningen tyst.
 *
 * @param {string|Element} mal  id eller elementet självt
 */
function oppnaInstallning(mal) {
  /* Bara när vi inte redan står i vyn. showView('settings') ritar om tio
     listor i ett svep, och två genvägar efter varandra — pekaren som
     misslyckas och faller ner i sin reserv, till exempel — hade då kostat
     två fulla ritningar mitt i en gest. */
  if (document.body.dataset.view !== 'settings') showView('settings');

  /* Finns inställningsmodulen äger den vägen — den vet vilken grupp reglaget
     bor i. Svarar den med ingenting tar reserven nedanför över ändå. Priset
     är i värsta fall en ring för mycket på samma element; vinsten är att en
     halvfärdig modul aldrig kan återinföra just den tysta no-op som hela det
     här stycket finns för att ta bort. */
  const via = instModul?.oppnaInstallning;
  if (typeof via === 'function') {
    try { const svar = via(mal); if (svar) return svar; }
    catch { /* faller ner i reserven nedan */ }
  }

  const el = typeof mal === 'string' ? $(mal) : mal;
  if (!el) return null;

  /* Reserv utan js/inst.js: ta fram elementet själva.
     Bara element som bär data-grupp rörs — det är hopfällningens egen
     markering. Att blint ta bort hidden uppåt i trädet hade väckt kort som
     är dolda av helt andra skäl, till exempel för att telefonen saknar
     funktionen de beskriver. */
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.hidden && n.dataset && 'grupp' in n.dataset) n.hidden = false;
  }

  Rorelse.rullaTill(el, { block: 'start' });
  Rorelse.landa(el);
  return el;
}

function renderStatus() {
  const gpsOk = !!geo.position;
  $('chipGps').className = 'chip' + (gpsOk ? ' on' : ' warn');

  const listening = listener.mode !== 'off';
  $('chipVoice').className = 'chip' + (listening ? ' on' : '');
  $('chipVoice').lastChild.textContent = voiceInputSupported ? 'Röst' : 'Ingen röst';

  const c = $('chipSync');
  if (!store.isRemote) { c.className = 'chip'; c.lastChild.textContent = 'Lokalt'; }
  else if (!navigator.onLine) { c.className = 'chip err'; c.lastChild.textContent = 'Offline'; }
  else if (store.syncError) { c.className = 'chip err'; c.lastChild.textContent = 'Synkfel'; }
  else { c.className = 'chip on'; c.lastChild.textContent = 'Delat'; }

  const hint = $('syncHint');
  if (hint) {
    hint.textContent = !store.isRemote
      ? 'Rapporter stannar på den här telefonen. Lägg in Supabase för att dela med alla i Västmanland.'
      : store.syncError ? `Synkfel: ${store.syncError}`
      : store.lastSync ? `Senast synkad ${relativeTime(store.lastSync)}.` : 'Ansluten.';
  }
}

/* ================= Priser och tillbehör ================= */

function renderPlans() {
  const wrap = $('planList');
  if (!wrap) return;
  wrap.innerHTML = '';

  for (const p of PLANS) {
    const el = document.createElement('div');
    el.className = 'plan' + (p.popular ? ' popular' : '');
    el.innerHTML =
      (p.popular ? '<span class="plan-badge">Populärast</span>' : '') +
      `<div class="plan-head"><span class="plan-name">${p.name}</span>` +
      `<span class="plan-price">${p.price}<small> kr/mån</small></span></div>` +
      `<p class="plan-tagline">${escapeHtml(p.tagline)}</p>` +
      `<ul>${p.features.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`;
    el.onclick = () => {
      document.querySelectorAll('.plan').forEach(x => x.classList.remove('chosen'));
      el.classList.add('chosen');
      settings.plan = p.id;
      saveSettings();
      $('btnSubscribe').textContent = `Fortsätt med ${p.name} — ${p.price} kr/mån`;
      $('fineCompare').textContent = yearlyComparison(p).line;
    };
    wrap.appendChild(el);
  }

  const chosen = PLANS.find(p => p.id === settings.plan) || PLANS[1];
  $('fineCompare').textContent = yearlyComparison(chosen).line +
    ' Håller du hastigheten får du aldrig boten från början — det är det appen är till för.';

  const prepay = document.createElement('div');
  prepay.className = 'prepay';
  prepay.innerHTML =
    `<b>Betala ${PREPAY.months} månader i förskott</b>` +
    `<span>${PREPAY.discountPercent} % rabatt, och ${PREPAY.extra.toLowerCase()}</span>`;
  wrap.appendChild(prepay);
}

/* Hyllan (renderShop) och intresseanmälan (toggleInterest) låg här fram
   till att butiken fick sin egen flik. Båda bor nu i js/butik.js, och
   produkterna i data/butik.json — en ny produkt är en post i json-filen,
   ingen kodändring. Samma pv.wishlist.v1-lista och samma
   product_interest-tabell som förut, så inga anmälningar gick förlorade. */

/* ================= Betalning ================= */

function renderBilling() {
  const s = billing.status;
  const chip = $('chipTrial');
  const el = $('billingStatus');

  if (s === 'active') {
    chip.hidden = true;
    if (el) el.textContent = 'Aktiv prenumeration. Tack!';
    $('btnSubscribe').hidden = true;
  } else if (s === 'trial') {
    const h = billing.hoursLeft;
    const d = billing.daysLeft;
    chip.hidden = false;
    chip.textContent = h <= 24 ? `${h} h kvar` : `${d} dagar kvar`;
    if (el) {
      el.textContent = billing.state.trialStart
        ? `Provperiod: ${d} ${d === 1 ? 'dag' : 'dagar'} kvar av ${TRIAL_DAYS}. Sedan ${PRICE_TEXT}.`
        : `${TRIAL_DAYS} dagar gratis, sedan ${PRICE_TEXT}. Provperioden startar när du börjar köra.`;
    }
    $('btnSubscribe').hidden = false;
  } else {
    chip.hidden = false;
    chip.textContent = 'Provperiod slut';
    if (el) el.textContent = `Provperioden är slut. Fortsätt för ${PRICE_TEXT}.`;
    $('btnSubscribe').hidden = false;
  }
}

/** Är appen låst? Visa i så fall betalväggen — men aldrig under körning. */
function gateOrPaywall() {
  // Testläget släpper igenom allt. Betalväggen mitt i en testrunda är samma
  // sorts hinder som inloggningsrutan. Se TESTLAGE_UTAN_INLOGGNING.
  if (TESTLAGE_UTAN_INLOGGNING) return true;
  if (billing.allowed) { billing.beginTrial(); return true; }
  maybeShowPaywall(true);
  return false;
}

function maybeShowPaywall(force = false) {
  if (billing.allowed) return;
  if (!$('modalPaywall').hidden) return;
  const speed = geo.position?.speedKmh ?? 0;
  // Ingen betalvägg i 90 km/h. Vänta tills bilen står still.
  if (!force && speed > 5) { billing.deferredPaywall = true; return; }
  if (speed > 5) { billing.deferredPaywall = true; toast('Provperioden är slut. Öppna appen när du står still.', 6000); return; }
  $('pwTitle').textContent = 'Provperioden är slut';
  $('modalPaywall').hidden = false;
}

/**
 * Skicka användaren till kassan.
 *
 * Sex betallänkar, en per plan och betalperiod, ligger i js/betalning.js.
 * Enhets-id:t måste med i länken — utan det kommer betalningen fram till
 * Stripe men webhooken vet inte vems prenumeration den ska förlänga, och
 * personen har betalat utan att få något.
 *
 * Faller tillbaka på den gamla enkellänken i config, så en halvfärdig
 * uppsättning fortfarande fungerar istället för att blockera allt.
 */
function startCheckout(planId = settings.plan, prepay = false) {
  // betalning.js hämtar enhets-id:t själv och vägrar returnera en länk utan
  // det, just för att en föräldralös betalning aldrig ska kunna uppstå.
  const url = Betalning.checkoutUrl(planId, { prepay }) || billing.checkoutUrl();
  if (!url) {
    const saknas = Betalning.saknadeLankar();
    toast(saknas.length
      ? `Betallänk saknas för ${saknas.length} av 6 planer. Se docs/BETALNING.md.`
      : 'Betallänk saknas.', 6000);
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/* ================= Installationsguide ================= */

function openInstallGuide(auto) {
  renderGuide(Install.detectPlatform());
  $('btnNativeInstall').hidden = !installPrompt.available;
  $('modalInstall').hidden = false;
  if (auto) Install.markSeen();
}

function renderGuide(platform) {
  const g = Install.GUIDES[platform] || Install.GUIDES.android;
  document.querySelectorAll('#platformPick button').forEach(b =>
    b.classList.toggle('active', b.dataset.platform === platform));
  $('guideSteps').innerHTML = g.steps
    .map(s => `<li><span class="g-ico">${s.icon}</span><span>${s.text}</span></li>`).join('');
  $('guideNote').innerHTML = g.note || '';
  $('guideNote').hidden = !g.note;
}

/* ================= Dashcam ================= */

/* ================= Kameraläge ================= */
/*
 * Två lägen, ett i taget: spela in, eller läsa skyltar.
 *
 * Att det är ett val och inte två reglage är inte en designsmak utan en fysisk
 * begränsning — bara en app åt gången kan hålla kameran. Låter man båda se
 * påslagna ut slutar det ena tyst att fungera, och användaren får aldrig veta
 * vilket.
 *
 * Skyltavläsningen kör numera i appen. Tidigare låg den i en separat iOS-app,
 * vilket betydde att man behövde installera något extra för en funktion som
 * ska finnas i sidan man redan har på hemskärmen. Mätningen finns i
 * ocr-test.html och körs mot samma modul som appen.
 */
let plate = null;                       // laddas först när läget väljs
let plateLage = 'record';

function plateInst() {
  if (!plate) {
    plate = new PlateReader({ settings: plateSettings() });
    plate.addEventListener('status', e => { $('plStatus').textContent = e.detail.text; });
    /*
     * Två sorters träff, och skillnaden är hela poängen.
     *
     * Skarpt läge: bara egna fordon når hit. Främmande skyltar kastas i samma
     * bildrutecykel och skickas aldrig.
     *
     * Provläge: även främmande skyltar skickas, med egen:false och utan
     * etikett. Det finns för att man annars inte kan avgöra om läsaren
     * fungerar — den som riktar mot en okänd bil ser "Bekräftar skylt…" och
     * sedan ingenting, vilket ser likadant ut som en trasig läsare. Inget
     * lagras, inget pip, ingen lista: raden är flyktig och försvinner av sig
     * själv. Provläget följer TESTLAGE_UTAN_INLOGGNING och slocknar därför
     * samma dag appen släpps till andra.
     */
    plate.addEventListener('traff', e => {
      const d = e.detail;
      if (d.egen === false) {
        /*
         * Säkerheten utelämnas när motorn rapporterar noll.
         *
         * Tesseract svarar ibland 0 % på en läsning som är helt korrekt —
         * det är känt och hanteras redan i röstningen, där en giltig läsning
         * alltid slår en ogiltig oavsett vad siffran säger. Men "läste
         * NCH 94K (0 %)" i gränssnittet ser ut som ett misslyckande, och
         * det var precis så det lästes vid provkörningen. Siffran tillför
         * ingenting när den är noll, så då står den inte där.
         */
        /*
         * INGEN multiplikation med 100. js/plate.js lämnar redan säkerheten
         * som 0–100 — det är Tesseracts egen skala och den skickas vidare
         * orörd. Raden gjorde 92 till 9200, och provläget visade "9200 %".
         *
         * Att det aldrig upptäcktes har en egen förklaring: fram till
         * ombyggnaden av sökaren var säkerheten på normalt avstånd faktiskt
         * NOLL, eftersom Otsu-tröskeln räknades inklusive det mörka
         * EU-bandet. Grenen som skriver ut procenten kördes alltså i princip
         * aldrig. En bugg som göms av en annan bugg syns först när den
         * första lagas.
         */
        const proc = Math.round(d.sakerhet || 0);
        $('plProvStatus').textContent = proc > 0
          ? `Provläge — läste ${visaPlat(d.plat)} (${proc} %). Inte ditt fordon, inget sparat.`
          : `Provläge — läste ${visaPlat(d.plat)}. Inte ditt fordon, inget sparat.`;
        return;
      }
      larmaFordon(d);
    });
    // Visa vad kameran gav, aldrig vad vi bad om. "60 b/s" i gränssnittet på
    // en telefon som gav 30 är en lögn som är omöjlig att felsöka.
    plate.addEventListener('kamera', e => {
      const k = e.detail;
      const bit = [`${k.bredd}×${k.hojd}`, `${k.bildfrekvens ?? 'okänd'} b/s`];
      if (k.sanktForPixlar) bit.push('bildfrekvensen sänktes för att behålla upplösningen');
      $('plKamera').textContent = bit.join(' · ');
    });
    plate.addEventListener('lutning', e => { renderLutning(e.detail); });
    plate.addEventListener('fel', e => {
      $('plStatus').textContent = e.detail.fel?.message || 'Något gick fel i läsningen.';
    });
    // Reglaget följer med när appen zoomar själv. Annars står det 1,0× medan
    // bilden är fyrfaldigt förstorad, och då litar man inte på det.
    plate.addEventListener('zoom', e => {
      const z = e.detail.zoom;
      $('plZoom').value = z;
      $('plZoomVal').textContent = z.toFixed(1).replace('.', ',') + '×' +
        (e.detail.optisk > 1 ? '' : ' (digital)');
    });
  }
  return plate;
}

function plateSettings() {
  return {
    intervalMs: Number(settings.plRate ?? 700),
    krav: Number(settings.plKrav ?? 2),
    pip: settings.plPip !== false,
    zoomLage: settings.plZoomLage || 'auto',
    // Hör ihop med testläget, inte med produkten. Se traff-hanteraren.
    provlage: TESTLAGE_UTAN_INLOGGNING,
  };
}

/* ================= Fordonslarm =================
 *
 * Själva larmet bor i js/larm.js. Här ligger bara kopplingen till DOM:en.
 *
 * Den gamla versionen skrek: en sågtandsvåg som svepte mellan 700 och 1150 Hz
 * på halv volym i tolv sekunder. Den hördes, men den var byggd som en
 * utryckningssiren — och en förare som får panik av sin egen app tittar på
 * telefonen i stället för på vägen. Fel utfall för något som ska göra
 * körningen säkrare. Nu: två mjuka sinustoner i ren kvint, en femtedel av
 * volymen, och en röst som säger vad som hänt. Motiveringen står i larm.js.
 */
let avbrytLarm = null;

function larmaFordon(d) {
  const rutan = $('fordonslarm');
  if (!rutan) return;
  avbrytLarm?.();
  /*
   * Rutan ska säga smeknamnet eller numret, inte "Fordon 3". Visningslagret
   * slås upp via fordonets id — en läsning av gränssnittets egen nyckel,
   * registret rörs inte. Rösten säger fortfarande aldrig ett nummer högt
   * (se larm.js); den får bara namn användaren själv valt.
   */
  const v = d.fordonId ? lasFordonVisning()[d.fordonId] : null;
  const smek = (v?.smeknamn || '').trim() || (!arAutoEtikett(d.etikett) ? d.etikett : '');
  const visatNamn = smek || (v?.regnr ? visaPlat(v.regnr) : d.etikett);
  avbrytLarm = larma({ ...d, etikett: smek }, {
    visa: t => {
      $('larmNamn').textContent = visatNamn || 'Ditt fordon';
      // Numret som lästes visas bara i larmögonblicket — se Fordonsregister.
      $('larmNr').textContent = visaPlat(t.plat);
      rutan.hidden = false;
    },
    dolj: () => {
      rutan.hidden = true;
      // Numret ska inte ligga kvar i DOM:en efter larmet.
      const nr = $('larmNr'); if (nr) nr.textContent = '';
    },
    speaker,
  });
}

function slutaLarma() {
  avbrytLarm?.();
  avbrytLarm = null;
}

/**
 * Lutningsgivaren är ett tillägg, inte ett krav.
 *
 * Läsaren hittar lutade skyltar helt utan sensor — detektionen mäter blobbens
 * egen huvudaxel och bryr sig inte om hur telefonen hålls. Givaren gör bara
 * att en kandidat som lutar åt det håll telefonen lutar får lite högre poäng.
 * Därför får knappen aldrig blockera starten, och texten ska inte antyda att
 * något är trasigt utan den.
 */
function renderLutning(info) {
  const p = $('plLutStatus'), btn = $('btnPlLutning');
  if (!p) return;
  const i = info || plate?.lutningsinfo;
  if (!i || !i.stods) {
    p.textContent = 'Telefonen har ingen lutningsgivare. Läsaren klarar lutade skyltar ändå.';
    if (btn) btn.hidden = true;
    return;
  }
  if (i.aktiv) {
    p.textContent = i.vinkel === null
      ? 'Lutningsgivaren är på.'
      : `Lutningsgivaren är på. Telefonen lutar ${String(i.vinkel).replace('.', ',')}°.`;
    if (btn) btn.hidden = true;
    return;
  }
  if (i.tillstand === 'denied') {
    p.textContent = 'Rörelsesensorn är nekad. Läsaren klarar lutade skyltar ändå, bara något sämre.';
    if (btn) btn.hidden = true;
    return;
  }
  p.textContent = 'Frivilligt. Hjälper läsaren när telefonen sitter lutad i en hållare.';
  if (btn) btn.hidden = false;
}

function visaLage(lage) {
  plateLage = lage;
  const inspelning = lage === 'record';
  const rec = $('modeRecord'), read = $('modeRead');
  rec.classList.toggle('on', inspelning);
  read.classList.toggle('on', !inspelning);
  rec.setAttribute('aria-pressed', String(inspelning));
  read.setAttribute('aria-pressed', String(!inspelning));

  $('recPanel').hidden = !inspelning;
  $('plPanel').hidden = inspelning;
  document.querySelector('.dc-library').hidden = !inspelning;
  if (inspelning) { $('plControls').hidden = true; }
}

function wireModePicker() {
  const rec = $('modeRecord');
  const read = $('modeRead');
  if (!rec || !read) return;

  rec.onclick = () => {
    if (plate?.running) stoppaPlate();
    visaLage('record');
  };

  read.onclick = () => {
    // Dashcamen måste släppa kameran innan läsaren kan ta den.
    if (dashcam.recording) {
      dashcam.stop();
      toast('Inspelningen stoppad — kameran kan bara användas av en sak i taget.', 5000);
    }
    visaLage('read');
  };

  if (!plateSupported) {
    $('plSupport').hidden = false;
    $('plSupport').textContent =
      'Den här webbläsaren ger inte appen tillgång till kameran. Prova Chrome på Android eller Safari på iPhone.';
    $('plStart').disabled = true;
  }

  $('plStart').onclick = async () => {
    if (!gateOrPaywall()) return;
    const p = plateInst();
    Object.assign(p.settings, plateSettings());
    try {
      $('plStart').disabled = true;
      $('plStart').textContent = 'Startar kameran…';

      const stage = $('dcStage');
      if (!p.canvas.isConnected) stage.insertBefore(p.canvas, stage.firstChild);
      p.canvas.hidden = false;

      await p.start();

      $('dcIdle').hidden = true;
      $('plControls').hidden = false;
      $('dcRec').hidden = true;      // inspelningsmärket hör inte hemma här

      /*
       * Reglaget får sitt tak från kameran, inte från ett gissat värde i
       * markupen. Telefoner skiljer sig: en med optisk zoom klarar långt mer
       * än en utan. Står det 8 i reglaget medan telefonen stannar på 3 drar
       * användaren förbi taket och tror att appen hängt sig.
       */
      const tak = Math.round(p.maxZoom * 10) / 10;
      $('plZoom').max = String(tak);
      $('plZoomTak').textContent = tak > 1
        ? `Den här telefonen klarar upp till ${tak.toFixed(1).replace('.', ',')}×.`
        : 'Den här telefonen erbjuder ingen zoom.';



      renderLutning();     // knappen visas bara om telefonen har en givare
      renderOlasta();      // chattknappen hor till kameravyn
    } catch (e) {
      $('plStatus').textContent = '';
      toast(e.message || 'Kunde inte starta kameran.', 6000);
      p.canvas.hidden = true;
    } finally {
      $('plStart').disabled = false;
      $('plStart').textContent = 'Starta skyltläsning';
    }
  };

  $('plStop').onclick = () => stoppaPlate();

  /*
   * iOS ger bara rörelsesensorn till en riktig gest — anropet måste ligga i
   * klickhanteraren, inte bakom ett await som hunnit släppa gestens
   * giltighet. Därför ligger aktiveraLutning() först.
   */
  $('btnLarmTyst').onclick = () => slutaLarma();

  /*
   * Exempelinlägg — visar kedjan utan att röra den delade databasen.
   *
   * Frestelsen var att skriva en rad i produktionsdatabasen så den syns på
   * telefonen. Det hade varit fel: en påhittad polisvarning i en delad
   * säkerhetstjänst är en falsk varning för alla andra som kör just då, även
   * om den ligger utanför länet. Rapporten läggs därför bara i den här
   * telefonens minne, markerad som demo, med kort livslängd.
   *
   * Den går medvetet genom SAMMA väg som en riktig gruppvarning: samma
   * source, samma sammanfattning, samma kartnål, samma röst. Ser det rätt ut
   * här ser det rätt ut på riktigt.
   */
  const demoKnapp = $('btnDemoInlagg');
  if (demoKnapp) demoKnapp.onclick = () => {
    const text = ($('fbDemoText').value || 'Polis vid Nacka').trim();
    // Samma flagga som js/facebook.js sätter. Knappen visar hur ett
    // GRUPPINLÄGG hade behandlats, och utan flaggan hade demon svarat något
    // annat än driften på exakt de inlägg som bara är ett platsnamn.
    const tolkning = parseReportText(text, { platsKonvention: true });
    if (tolkning?.intent === 'refused') {
      $('demoStatus').textContent =
        'Den texten vägras av appen och skulle aldrig bli en varning. Det är meningen.';
      return;
    }
    if (tolkning?.intent !== 'report') {
      $('demoStatus').textContent = 'Appen hittar ingen varning i den texten. Prova "Polis vid Erikslund".';
      return;
    }
    const fix = geo.position;
    if (!fix) { $('demoStatus').textContent = 'Väntar på GPS — exemplet placeras vid din position.'; return; }

    const nu = Date.now();
    const demo = {
      id: 'demo-' + nu,
      external_id: 'demo:' + nu,
      type: tolkning.type,
      // Parsern gemenar texten för att kunna matcha ord mot ord, så platsen
      // kommer tillbaka som "nacka". I en riktig rapport sätts etiketten av
      // geokodaren och är korrekt skriven; här måste vi göra det själva,
      // annars står det "Polis vid nacka" i exemplet och det ser slarvigt ut.
      label: (tolkning.place || 'Demo').replace(/(^|[\s-])([a-zåäö])/g, (_, f, b) => f + b.toUpperCase()),
      // Ett par hundra meter bort, så nålen syns bredvid dig och inte under.
      lat: fix.lat + 0.0025, lon: fix.lon + 0.0035,
      createdAt: nu - 2 * 60000,
      expiresAt: nu + 15 * 60000,
      source: 'facebook',
      note: text,
      confirms: 1, denials: 0, fixed: false,
      demo: true,
    };
    store.reports.set(demo.id, demo);
    renderHazards();
    speaker.say(sammanfattaTal(demo), { priority: 1 });
    $('demoStatus').textContent =
      'Lagt i din app: ' + sammanfattaKort(demo) + ' Syns på kartan och i listan nedanför. Försvinner vid omladdning.';
  };

  /*
   * Genvägen till fordonslistan.
   *
   * Läsaren stoppas på vägen. Inte för att spara batteri, utan för att den
   * annars står och läser skyltar medan man skriver in nummer i en annan vy
   * — kameran skulle vara igång utan att någon ser bilden, vilket är precis
   * den sortens tyst bakgrundsläsning appen inte ska ägna sig åt.
   */
  $('btnPlMinaFordon').onclick = () => {
    stoppaPlate();
    oppnaInstallning('minaFordonRubrik');
    /*
     * Fokus på fältet, inte bara rullning: den som tryckt på knappen vill
     * skriva ett nummer, och tangentbordet ska upp utan ett extra tryck.
     *
     * Direkt, utan de 420 ms som stod här förut. Fördröjningen var en
     * gissning på hur lång tid vyn och rullningen skulle ta, och en gissning
     * som blir för kort ger fokus åt ett fält som fortfarande är dolt —
     * alltså inget tangentbord alls. oppnaInstallning() är synkron: fältet
     * finns och är framme när den returnerat. Rullningen är mjuk och pågår
     * fortfarande, men focus() bryter inte en rullning, den flyttar bara
     * markören.
     *
     * preventScroll, för att fokus annars drar fram fältet med ett hopp och
     * äter upp den mjuka rullningen som just startat. Rubriken ska hinna
     * komma på plats så att föraren ser VILKET kort han hamnade i — annars
     * står han med ett textfält utan sammanhang.
     */
    $('plNyaFordon')?.focus({ preventScroll: true });
  };

  $('btnPlLutning').onclick = async () => {
    const btn = $('btnPlLutning');
    btn.disabled = true;
    try { await plateInst().aktiveraLutning(); }
    catch { /* nekat eller saknas — renderLutning säger vad som gäller */ }
    finally { btn.disabled = false; renderLutning(); }
  };

  const visaZoom = v => { $('plZoomVal').textContent = v.toFixed(1).replace('.', ',') + '×'; };

  const sattZoomLage = lage => {
    settings.plZoomLage = lage;
    saveSettings();
    if (plate) plate.settings.zoomLage = lage;
    const auto = lage === 'auto';
    // Båda knapp-paren speglas: det inne i läsningen (#plControls) OCH för-valet
    // på startskärmen (#plPanel). Ett par kan saknas beroende på vy — därför
    // null-vakten. Se pl-forval i index.html.
    for (const [aId, mId] of [['plZoomAuto', 'plZoomManuell'], ['plZoomAutoPre', 'plZoomManuellPre']]) {
      const a = $(aId), m = $(mId);
      if (!a || !m) continue;
      a.classList.toggle('on', auto);  m.classList.toggle('on', !auto);
      a.setAttribute('aria-pressed', String(auto));
      m.setAttribute('aria-pressed', String(!auto));
    }
    // Reglaget är kvar synligt i autoläget men går inte att dra. Att dölja
    // det hade gjort att bilden hoppar när man byter läge, och man ser ändå
    // vad appen valt.
    $('plZoom').disabled = auto;
    $('plZoomNot').textContent = auto
      ? 'Appen zoomar själv tills skylten fyller rutan. Ställ telefonen i hållaren och låt den sköta sig.'
      : 'Du styr zoomen. Sikta så att skylten fyller den blå rutan.';
  };

  $('plZoomAuto').onclick = () => sattZoomLage('auto');
  $('plZoomManuell').onclick = () => sattZoomLage('manuell');
  // Samma val på startskärmen (för-valet), innan kameran ens gått igång.
  const preA = $('plZoomAutoPre'), preM = $('plZoomManuellPre');
  if (preA) preA.onclick = () => sattZoomLage('auto');
  if (preM) preM.onclick = () => sattZoomLage('manuell');
  // Spegla sparat läge direkt vid start så för-valet visar rätt knapp.
  sattZoomLage(settings.plZoomLage || 'auto');

  $('plZoom').oninput = e => {
    const v = Number(e.target.value);
    visaZoom(v);
    plate?.zooma(v, { fran: 'manuell' });
  };

  sattZoomLage(settings.plZoomLage || 'auto');

  visaLage('record');
}

function stoppaPlate() {
  if (!plate) return;
  plate.stop();
  plate.canvas.hidden = true;
  $('plControls').hidden = true;
  $('dcIdle').hidden = false;
  // Chattrutan hör till kameran och ska inte ligga kvar över startskärmen.
  $('dcChatt').hidden = true;
  // Provlägesraden nämner en skylt. Den ska inte överleva att kameran
  // stängts av — det är hela skillnaden mot en logg.
  $('plProvStatus').textContent = '';
  $('plKamera').textContent = '';
  // En siren som fortsätter ljuda efter att läsaren stängts av kan ingen
  // förklara. Larmet hör till kameran och slutar med den.
  slutaLarma();
  renderOlasta();
}

function wireDashcam() {
  wireModePicker();
  const stage = $('dcStage');
  $('dcCanvas')?.remove();               // platshållaren från HTML
  dashcam.canvas.id = 'dcCanvas';
  stage.insertBefore(dashcam.canvas, stage.firstChild);

  if (!dashcamSupported) {
    $('dcSupport').hidden = false;
    $('dcSupport').textContent =
      'Den här webbläsaren stödjer inte videoinspelning. Prova Chrome på Android eller Safari på iPhone 15 eller senare.';
    $('dcStart').disabled = true;
  }

  $('dcStart').onclick = async () => {
    if (!gateOrPaywall()) return;
    try {
      $('dcStart').disabled = true;
      $('dcStart').textContent = 'Startar…';
      dashcam.setOrientation(window.matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait');
      await dashcam.start();
      $('dcIdle').hidden = true;
      $('dcControls').hidden = false;
      $('dcRec').hidden = false;
      $('zFrontWrap').style.display = dashcam.dualActive ? '' : 'none';
      startRecTimer();
      syncDashcamUI();
    } catch (e) {
      toast('Kameran gick inte att starta. Kontrollera att du tillåtit kamera och mikrofon.', 6000);
    } finally {
      $('dcStart').disabled = false;
      $('dcStart').textContent = 'Starta inspelning';
    }
  };

  $('dcStop').onclick = async () => {
    await dashcam.stop();
    $('dcIdle').hidden = false;
    $('dcControls').hidden = true;
    $('dcRec').hidden = true;
    stopRecTimer();
    refreshClipList();
  };

  $('dcEvent').onclick = async () => {
    const n = await dashcam.saveEvent(3);
    toast(`Händelse sparad. ${n} klipp skyddade.`, 5000);
    speaker.say('Händelsen är sparad.', { priority: 0 });
  };

  $('zRear').oninput = e => {
    dashcam.setZoom('rear', e.target.value);
    $('zRearVal').textContent = (+e.target.value).toFixed(1).replace('.', ',') + '×';
  };
  $('zFront').oninput = e => {
    dashcam.setZoom('front', e.target.value);
    $('zFrontVal').textContent = (+e.target.value).toFixed(1).replace('.', ',') + '×';
  };

  $('dcOrient').onclick = () => {
    dashcam.setOrientation(dashcam.settings.orientation === 'portrait' ? 'landscape' : 'portrait');
    syncDashcamUI();
  };
  // Telefoner har flera bakkameror (vidvinkel, tele, ultravid). Får man fel
  // bild — eller ingen alls — går det att stega igenom dem här.
  $('dcSwitch').onclick = async () => {
    // Bara kameror som filmar framåt. Selfiekameran är med i telefonens
    // lista men hör inte hemma som huvudbild — den används till kupéspåret,
    // och att kunna stega in på den här hade bara gjort att man råkar spela
    // in sitt eget ansikte istället för vägen.
    const alla = await dashcam.listCameras();
    const cams = alla.filter(c => c.duggerSomHuvudbild !== false);
    if (cams.length < 2) {
      toast(alla.length > cams.length
        ? 'Telefonen rapporterar bara en kamera som filmar framåt.'
        : 'Telefonen rapporterar bara en kamera.');
      return;
    }
    dashcam._camIndex = ((dashcam._camIndex ?? 0) + 1) % cams.length;
    const cam = cams[dashcam._camIndex];
    toast(`Byter till: ${cam.label || 'kamera ' + (dashcam._camIndex + 1)}`, 4000);
    await dashcam.useCamera(cam.deviceId);
  };
  $('dcAudio').onclick = () => {
    dashcam.settings.audio = !dashcam.settings.audio;
    syncDashcamUI();
    toast('Ändringen gäller från nästa inspelning.');
  };

  $('dcPurge').onclick = async () => {
    await dashcam.deleteAll({ includeLocked: false });
    toast('Olåsta klipp raderade.');
  };
  $('dcPurgeAll').onclick = async () => {
    if (!confirm('Radera alla klipp, även de låsta? Går inte att ångra.')) return;
    await dashcam.deleteAll({ includeLocked: true });
    toast('Alla klipp raderade.');
  };

  $('dcQuality').value = dashcam.settings.quality;
  $('dcBuffer').value = String(dashcam.settings.bufferMinutes);
  $('dcQuality').onchange = e => {
    dashcam.settings.quality = e.target.value;
    syncDashcamUI();
    if (dashcam.recording) toast('Kvaliteten ändras vid nästa inspelning.');
  };
  $('dcBuffer').onchange = e => {
    dashcam.settings.bufferMinutes = +e.target.value;
    syncDashcamUI();
  };

  dashcam.addEventListener('clips', refreshClipList);
  dashcam.addEventListener('change', syncDashcamUI);
  dashcam.addEventListener('note', e => toast(e.detail.text, 5000));
  syncDashcamUI();
}

function syncDashcamUI() {
  $('dcOrient').textContent = dashcam.settings.orientation === 'portrait' ? 'Stående' : 'Liggande';
  $('dcAudio').textContent = 'Ljud: ' + (dashcam.settings.audio ? 'på' : 'av');
  $('zFrontWrap').style.display = dashcam.dualActive ? '' : 'none';
  $('dcQuality').value = dashcam.settings.quality;
  $('dcBuffer').value = String(dashcam.settings.bufferMinutes);

  const bytes = (dashcam.bitrate / 8) * dashcam.settings.bufferMinutes * 60;
  const res = dashcam.resolution;
  $('dcEstimate').textContent =
    `${res.w}×${res.h} · ${dashcam.settings.bufferMinutes} min buffert tar ungefär ${fmtBytes(bytes)}. ` +
    'Äldsta klippet raderas automatiskt när det blir fullt.';
}

let recTimer = null;
function startRecTimer() {
  const t0 = Date.now();
  stopRecTimer();
  recTimer = setInterval(() => {
    $('dcTime').textContent = fmtDuration(Date.now() - t0);
  }, 1000);
}
function stopRecTimer() { if (recTimer) clearInterval(recTimer); recTimer = null; }

async function refreshClipList() {
  const clips = await dashcam.listClips();
  const ul = $('clipList');
  ul.innerHTML = '';
  $('clipEmpty').hidden = clips.length > 0;

  const { bytes, quota } = await dashcam.storageUsed();
  $('dcStorage').textContent = quota
    ? `${fmtBytes(bytes)} av ${fmtBytes(quota)}`
    : fmtBytes(bytes);

  for (const c of clips) {
    const li = document.createElement('li');
    const d = new Date(c.startedAt);
    const pad = n => String(n).padStart(2, '0');
    li.innerHTML = `
      <span class="clip-main">
        <span class="clip-when">${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}</span>
        <span class="clip-meta">${fmtDuration(c.durationMs)} · ${fmtBytes(c.size)} · ${c.orientation === 'portrait' ? 'stående' : 'liggande'}${c.dual ? ' · 2 kameror' : ''}</span>
      </span>`;
    const lock = document.createElement('button');
    lock.className = 'clip-lock' + (c.locked ? ' on' : '');
    lock.textContent = c.locked ? '🔒' : '🔓';
    lock.title = c.locked ? 'Låst — raderas inte automatiskt' : 'Olåst';
    lock.onclick = ev => { ev.stopPropagation(); dashcam.toggleLock(c.id); };
    li.appendChild(lock);
    li.onclick = () => openClip(c);
    ul.appendChild(li);
  }
}

let clipUrl = null;
function openClip(c) {
  closeClipModal();
  clipUrl = URL.createObjectURL(c.blob);
  const d = new Date(c.startedAt);
  $('clipTitle').textContent = d.toLocaleString('sv-SE');
  $('clipVideo').src = clipUrl;
  const filnamn = `dashcam-${d.toISOString().replace(/[:.]/g, '-')}.${c.mime.includes('mp4') ? 'mp4' : 'webm'}`;

  /*
   * Dela är huvudvägen, nedladdning reserven — och på iPhone är det den enda
   * vägen som fungerar.
   *
   * `<a download>` gör ingenting vettigt i Safari på iOS. Attributet ignoreras
   * för blob-länkar; videon öppnas istället i en ny vy och användaren står
   * kvar utan fil. Det spelar ingen roll i vardagen men allt i det ögonblick
   * det betyder något: har du krockat och ska lämna filmen till försäkringen
   * eller polisen sitter den fast i telefonen.
   *
   * Web Share med en File öppnar systemets delningsmeny, där klippet kan
   * sparas i Bilder eller Filer, mailas eller skickas. Det är så en app på
   * iPhone lämnar ifrån sig en fil.
   */
  const delaKnapp = $('clipShare');
  const fil = new File([c.blob], filnamn, { type: c.mime || 'video/mp4' });
  const kanDela = !!(navigator.canShare && navigator.canShare({ files: [fil] }));

  delaKnapp.hidden = !kanDela;
  delaKnapp.onclick = async () => {
    try {
      await navigator.share({
        files: [fil],
        title: 'Klipp från Polisvakt',
        text: `Inspelat ${d.toLocaleString('sv-SE')}.`,
      });
    } catch (e) {
      // AbortError = användaren stängde delningsmenyn. Inget fel.
      if (e?.name !== 'AbortError') toast('Kunde inte dela klippet.', 5000);
    }
  };

  // Nedladdningsknappen är kvar för dator och Android, men får inte se ut som
  // vägen framåt där den inte fungerar.
  $('clipDownload').hidden = kanDela;
  $('clipDownload').onclick = () => {
    const a = document.createElement('a');
    a.href = clipUrl;
    a.download = filnamn;
    a.click();
  };
  $('clipDelete').onclick = async () => {
    if (!confirm('Radera det här klippet?')) return;
    await dashcam.deleteClip(c.id);
    closeClipModal();
  };
  $('modalClip').hidden = false;
}
function closeClipModal() {
  $('modalClip').hidden = true;
  $('clipVideo').pause?.();
  $('clipVideo').removeAttribute('src');
  if (clipUrl) { URL.revokeObjectURL(clipUrl); clipUrl = null; }
}

/* ================= Inställningar (UI) ================= */

function wireSettingsUI() {
  const bind = (id, key, transform = v => v, after = () => {}) => {
    const el = $(id);
    if (!el) return;
    const isCheck = el.type === 'checkbox';
    if (isCheck) el.checked = !!settings[key]; else el.value = settings[key];
    el.oninput = el.onchange = () => {
      settings[key] = transform(isCheck ? el.checked : el.value);
      saveSettings();
      after();
    };
  };

  bind('setTts', 'tts', v => !!v, () => { speaker.enabled = settings.tts; });
  bind('setTheme', 'theme', v => v, () => applyTheme());

  /*
   * Volym, talhastighet, varningsradie, framförhållning, pollningsintervall
   * och "håll skärmen tänd" hade var sitt reglage här. De är borttagna med
   * flit.
   *
   * Ett reglage är inte gratis. Det är en fråga appen ställer till föraren,
   * och varje fråga kostar uppmärksamhet som borde ligga på vägen. Frågan är
   * värd att ställa bara när svaret skiljer sig mellan människor OCH appen
   * inte kan avgöra det själv. Ingen av de här klarade provet: volymen sitter
   * på telefonens sida, och resten är avvägningar som ska vara rätt från
   * början — inte något föraren ska behöva finjustera i sekunder och meter.
   *
   * Värdena finns kvar i defaults och används precis som förut.
   */
  settings.keepAwake ? requestWakeLock() : releaseWakeLock();

  const ljudPaVerkan = () => ljud.setInstallningar({
    ljudPa: settings.ljudPa, ljudVolym: settings.ljudVolym, haptikPa: settings.haptikPa,
  });
  bind('setLjudPa', 'ljudPa', v => !!v, ljudPaVerkan);
  bind('setHaptikPa', 'haptikPa', v => !!v, ljudPaVerkan);
  ljudPaVerkan();

  /* ---- Bilingenkännaren ---- */
  const platePaVerkan = () => { if (plate) Object.assign(plate.settings, plateSettings()); };
  bind('setPlPip', 'plPip', v => !!v, platePaVerkan);

  /*
   * Egna fordon.
   *
   * Det appen MATCHAR mot är saltade hashar i fordonsregistret (plate.js),
   * plus de troliga felläsningarna av varje nummer — så att en felläst femma
   * ändå träffar. Hasharna går inte att räkna baklänges, och det ändras inte.
   *
   * Det listan VISAR kommer från visningslagret (se FORDON_VISNING_NYCKEL
   * högre upp): numret användaren själv skrev in om sina egna bilar, sparat
   * bara i den här telefonen. Tidigare visade listan bara "Fordon 3", och
   * ägaren kunde inte se vilket fordon som var vilket.
   */
  const fordon = haFordonsregister();

  let fordonNamnRedigeras = null;   // id för raden vars smeknamn redigeras
  /*
   * Ta bort sker direkt, med Ångra efteråt — samma mönster som rapporternas
   * ångra-knapp (se undoBar). Ångra kan bara återskapa fordon vars nummer
   * finns i visningslagret; gamla poster utan nummer får en fråga i förväg
   * i stället, för dem finns det ingen väg tillbaka.
   */
  let fordonBorttaget = null;
  let fordonAngraTimer = null;

  function fordonKnapp(text, klass, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = klass; b.textContent = text; b.onclick = fn;
    return b;
  }

  function renderFordon() {
    const ul = $('plFordonLista');
    if (!ul) return;

    const visning = lasFordonVisning();
    // Städa bort visningsposter vars fordon inte längre finns i registret.
    const ids = new Set(fordon.lista().map(f => f.id));
    let stadat = false;
    for (const id of Object.keys(visning)) {
      if (!ids.has(id)) { delete visning[id]; stadat = true; }
    }
    if (stadat) sparaFordonVisning(visning);

    ul.innerHTML = '';
    for (const f of fordon.lista()) {
      const v = visning[f.id] || null;
      const smek = (v?.smeknamn || '').trim() || (!arAutoEtikett(f.etikett) ? f.etikett : '');
      const li = document.createElement('li');
      li.className = 'pl-rad';

      if (fordonNamnRedigeras === f.id) {
        // Smeknamnet ändras på plats — numret ska aldrig behöva skrivas om.
        const falt = document.createElement('input');
        falt.type = 'text';
        falt.className = 'pl-namn-falt';
        falt.value = smek;
        falt.placeholder = 'Smeknamn, t.ex. Volvon';
        const spara = () => {
          const namn = falt.value.trim();
          const visn = lasFordonVisning();
          if (visn[f.id]) visn[f.id].smeknamn = namn;
          else if (namn) visn[f.id] = { regnr: '', smeknamn: namn };
          sparaFordonVisning(visn);
          // Registrets etikett följer med: det är den varningen och
          // provknappen faller tillbaka på. Tom sträng lämnar den orörd.
          if (namn) fordon.dopOm(f.id, namn);
          fordonNamnRedigeras = null;
          renderFordon();
        };
        falt.onkeydown = e => { if (e.key === 'Enter') spara(); };
        const knappar = document.createElement('div');
        knappar.className = 'pl-rad-knappar';
        knappar.append(
          fordonKnapp('Spara', 'btn-ghost small', spara),
          fordonKnapp('Avbryt', 'btn-ghost small', () => { fordonNamnRedigeras = null; renderFordon(); }),
        );
        li.append(falt, knappar);
        ul.appendChild(li);
        queueMicrotask(() => falt.focus({ preventScroll: true }));
        continue;
      }

      const info = document.createElement('div');
      info.className = 'pl-rad-info';
      const nr = document.createElement('b');
      nr.className = 'pl-rad-nr';
      const under = document.createElement('span');
      under.className = 'pl-rad-namn';
      if (v?.regnr) {
        nr.textContent = visaPlat(v.regnr);
        under.textContent = smek;
      } else {
        // Gammal post från tiden före visningslagret: numret hashades och
        // slängdes, så det finns inget nummer att visa. Igenkänningen
        // fungerar ändå — hasharna finns kvar.
        nr.textContent = smek || f.etikett;
        under.textContent = 'Numret sparades inte för visning när fordonet lades till. Varningen fungerar ändå.';
      }
      info.appendChild(nr);
      if (under.textContent) info.appendChild(under);

      const knappar = document.createElement('div');
      knappar.className = 'pl-rad-knappar';
      knappar.append(
        fordonKnapp(smek ? 'Byt namn' : 'Ge namn', 'btn-ghost small',
          () => { fordonNamnRedigeras = f.id; renderFordon(); }),
        fordonKnapp('Ta bort', 'btn-ghost small danger', () => {
          const kanAngras = !!v?.regnr;
          if (!kanAngras) {
            const vad = smek || f.etikett;
            if (!confirm(`Ta bort ${vad}? Numret finns inte sparat, så det går inte att ångra — du får skriva in det igen om du ändrar dig.`)) return;
          }
          fordon.taBort(f.id);
          const visn = lasFordonVisning();
          delete visn[f.id];
          sparaFordonVisning(visn);
          clearTimeout(fordonAngraTimer);
          fordonBorttaget = kanAngras ? { regnr: v.regnr, smeknamn: smek } : null;
          if (fordonBorttaget) {
            fordonAngraTimer = setTimeout(() => { fordonBorttaget = null; renderFordon(); }, 6000);
          }
          renderFordon();
        }),
      );

      li.append(info, knappar);
      ul.appendChild(li);
    }

    if (fordonBorttaget) {
      const li = document.createElement('li');
      li.className = 'pl-rad pl-rad-angra';
      const text = document.createElement('span');
      text.textContent = `${visaPlat(fordonBorttaget.regnr)} borttagen.`;
      li.append(text, fordonKnapp('Ångra', 'btn-ghost small', async () => {
        clearTimeout(fordonAngraTimer);
        const b = fordonBorttaget;
        fordonBorttaget = null;
        if (!b) return;
        const r = await fordon.laggTill(b.regnr, b.smeknamn || null);
        if (r.id) {
          const visn = lasFordonVisning();
          visn[r.id] = { regnr: b.regnr, smeknamn: b.smeknamn || visn[r.id]?.smeknamn || '' };
          sparaFordonVisning(visn);
        }
        renderFordon();
      }));
      ul.appendChild(li);
    }

    $('plFordonTom').hidden = fordon.antal > 0 || !!fordonBorttaget;
  }

  /*
   * En rad ur fältet: ett regnummer, valfritt följt av ett smeknamn.
   * "ABC123 Volvon", "ABC 123, Volvon" och "ABC123" ska alla fungera.
   * Numret valideras med samma normalisering som läsaren använder, så det
   * som sparas för visning är exakt det som hashas.
   */
  function tolkaFordonsrad(rad) {
    const t = rad.trim();
    if (!t) return null;
    let nrDel, namnDel;
    const skilj = t.search(/[,;]/);
    if (skilj >= 0) {
      nrDel = t.slice(0, skilj);
      namnDel = t.slice(skilj + 1);
    } else {
      // Numret kan vara skrivet som ett ord ("ABC123") eller två ("ABC 123").
      const ord = t.split(/\s+/);
      if (ord.length >= 2 && normaliseraPlat(ord[0] + ord[1])) {
        nrDel = ord[0] + ord[1];
        namnDel = ord.slice(2).join(' ');
      } else {
        nrDel = ord[0];
        namnDel = ord.slice(1).join(' ');
      }
    }
    return { regnr: normaliseraPlat(nrDel), smeknamn: (namnDel || '').trim(), rad: t };
  }

  $('btnPlLagg').onclick = async () => {
    const falt = $('plNyaFordon');
    const rader = String(falt.value || '').split('\n');
    let nya = 0, fanns = 0, lagringFull = false;
    const ejLasta = [];   // rader som inte gick att tolka — de får ligga kvar
    const kvar = [];      // allt som ska stå kvar i fältet efteråt
    const visn = lasFordonVisning();

    for (const rad of rader) {
      const p = tolkaFordonsrad(rad);
      if (!p) continue;
      if (!p.regnr) { ejLasta.push(p.rad); kvar.push(p.rad); continue; }
      const r = await fordon.laggTill(p.regnr, p.smeknamn || null);
      if (r.status === 'ogiltig') { ejLasta.push(p.rad); kvar.push(p.rad); continue; }
      if (r.status === 'fanns') {
        fanns++;
        // Passa på att fylla i visningsdata som saknas för en gammal post.
        if (!visn[r.id]?.regnr) {
          visn[r.id] = { regnr: p.regnr, smeknamn: visn[r.id]?.smeknamn || p.smeknamn };
        }
        continue;
      }
      if (r.sparad === false) { lagringFull = true; kvar.push(p.rad); continue; }
      visn[r.id] = { regnr: p.regnr, smeknamn: p.smeknamn };
      nya++;
    }
    sparaFordonVisning(visn);

    // Ogiltiga rader försvinner inte — de står kvar i fältet så de går att rätta.
    falt.value = kvar.join('\n');

    const kvitto = [];
    if (nya) kvitto.push(nya === 1 ? '1 tillagd' : `${nya} tillagda`);
    if (fanns) kvitto.push(fanns === 1 ? '1 fanns redan' : `${fanns} fanns redan`);
    if (ejLasta.length === 1) kvitto.push(`1 gick inte att läsa: "${ejLasta[0]}"`);
    else if (ejLasta.length > 1) kvitto.push(`${ejLasta.length} gick inte att läsa — de står kvar i fältet`);
    if (lagringFull) kvitto.push('kunde inte spara allt — telefonens lagring är full eller avstängd');
    $('plLaggKvitto').textContent = kvitto.length
      ? kvitto.join(' · ')
      : 'Skriv ett registreringsnummer först, till exempel ABC 123.';

    renderFordon();
  };

  // Prova-knappen är kvar för att kunna kontrollera igenkänningen — och för
  // gamla poster där numret aldrig sparades för visning.
  $('btnPlProva').onclick = async () => {
    const t = await fordon.slaUpp($('plProva').value);
    $('plProva').value = '';
    const namn = t
      ? (lasFordonVisning()[t.id]?.smeknamn || '').trim() || t.etikett
      : '';
    $('plEgnaStatus').textContent = t
      ? `Ja — det numret hör till ${namn}${t.exakt ? '' : ' (som en trolig felläsning)'}.`
      : 'Nej, det numret ligger inte i registret.';
  };

  renderFordon();

  $('plSupportNote').textContent = plateSupported
    ? 'Textigenkänningen laddas ner första gången du startar läsaren, ungefär 4 MB. Sen fungerar den utan internet.'
    : 'Den här webbläsaren ger inte appen tillgång till kameran, så skyltläsaren kan inte användas här.';


  // Väckningsord
  const wake = $('setWake');
  wake.checked = settings.wakeWord;
  wake.disabled = !voiceInputSupported;
  $('wakeHint').textContent = voiceInputSupported
    ? 'Mikrofonen lyssnar efter "Hej vakt" medan appen är öppen. Inget spelas in eller sparas.'
    : 'Den här webbläsaren stödjer inte röstigenkänning. På iPhone använder du tryck-och-tala-knappen istället — uppläsningen av varningar fungerar som vanligt.';
  wake.onchange = () => {
    settings.wakeWord = wake.checked;
    saveSettings();
    if (settings.wakeWord) listener.startWakeWord(); else listener.stop();
    renderStatus();
  };

  /* ---- Hastighetsgräns ---- */
  // Gränsen visas alltid — den är information, inte en påminnelse, och kostar
  // ingenting att ha framme. Marginalen ligger fast på 7 km/h. Det enda valet
  // som är kvar är det enda som faktiskt stör: om appen ska säga till.
  limits.enabled = true;
  limits.marginKmh = settings.speedMargin;
  bind('setSpeedWarn', 'speedWarn', v => !!v);
  $('btnClearRoads').onclick = async () => {
    await limits.clearCache();
    $('limitStatus').textContent = 'Vägdatan är rensad. Den hämtas på nytt när du börjar köra.';
    $('limitSign').hidden = true;
  };
  limits.storageInfo().then(info => {
    if (info.tiles) $('limitStatus').textContent =
      `${info.ways.toLocaleString('sv-SE')} vägsträckor nedladdade i ${info.tiles} områden (${fmtBytes(info.bytes)}).`;
  });

  /* ---- Rattknappar ---- */
  const bindSelects = { bindNext: 'nexttrack', bindPrev: 'previoustrack', bindPlay: 'play' };
  for (const [id, button] of Object.entries(bindSelects)) {
    const sel = $(id);
    sel.innerHTML = Object.entries(ACTIONS)
      .map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
    sel.value = settings.bindings[button] || 'none';
    sel.onchange = () => {
      settings.bindings[button] = sel.value;
      if (button === 'play') settings.bindings.pause = sel.value;
      saveSettings();
      remote.setBinding(button, sel.value);
      if (button === 'play') remote.setBinding('pause', sel.value);
    };
  }
  const remoteToggle = $('setRemote');
  remoteToggle.checked = settings.remoteOn;
  remoteToggle.disabled = !remote.supported;
  remoteToggle.onchange = async () => {
    if (remoteToggle.checked) {
      const ok = await remote.enableMediaSession();
      if (!ok) { remoteToggle.checked = false; return; }
      toast('Rattknapparna styr nu Polisvakt. Musiken pausas.', 5000);
    } else {
      remote.disableMediaSession();
      toast('Rattknapparna styr musiken igen.');
    }
    settings.remoteOn = remoteToggle.checked;
    saveSettings();
    renderRemoteStatus();
  };
  renderRemoteStatus();

  /* ---- Krockdetektering ---- */
  const impactToggle = $('setImpact');
  impactToggle.checked = settings.impactOn;
  impactToggle.disabled = !motionSupported;
  impactToggle.onchange = async () => {
    settings.impactOn = impactToggle.checked;
    saveSettings();
    if (settings.impactOn) {
      const ok = await impact.start();
      if (!ok) {
        impactToggle.checked = settings.impactOn = false;
        saveSettings();
        toast('Rörelsesensorn nekades. Tillåt rörelse och orientering i webbläsarens inställningar.', 6000);
      }
    } else impact.stop();
    renderImpactStatus();
  };
  /*
   * Känslighetsvalet är borta. Tre nivåer i g-krafter är ingen fråga en förare
   * kan svara på utan att krocka först — normalläget täcker både panikbroms
   * och kollision, och det är det man vill ha låst.
   *
   * Valet var dessutom trasigt: koden anropade impact.setOptions(), en metod
   * som aldrig funnits på ImpactDetector. Eftersom anropet låg i en callback
   * som bara kördes när någon ändrade menyn hade felet aldrig visat sig. Det
   * kom fram först när inställningen togs bort och värdena skulle sättas vid
   * start. Trösklarna är vanliga egenskaper — de sätts direkt.
   */
  const niva = IMPACT_LEVELS[settings.impactLevel] || IMPACT_LEVELS.normal;
  impact.hardBrakeG = niva.hardBrakeG;
  impact.crashG = niva.crashG;
  renderImpactStatus();

  /* ---- Historik ---- */
  bind('setHotspots', 'showHotspots', v => !!v, renderHotspotLayer);
  $('btnClearStats').onclick = () => {
    if (!confirm('Rensa hela historiken? Mönstren byggs om från noll.')) return;
    stats.clear();
    renderStats();
    renderHotspotLayer();
  };

  /* ---- Bevakningsområde ---- */
  const cov = $('setCoverage');
  cov.value = settings.coverageMode;
  const syncCoverageRows = () => {
    $('radiusRow').hidden = cov.value !== 'radius';
    $('routeRow').hidden = cov.value !== 'route';
  };
  syncCoverageRows();
  cov.onchange = () => {
    coverage.configure({ mode: cov.value });
    syncCoverageRows();
  };
  const covR = $('setCovRadius');
  covR.value = settings.coverageRadiusM;
  $('setCovRadiusVal').textContent = Math.round(settings.coverageRadiusM / 1000) + ' km';
  covR.oninput = () => {
    $('setCovRadiusVal').textContent = Math.round(covR.value / 1000) + ' km';
    coverage.configure({ radiusM: +covR.value });
  };
  $('coverageDesc').textContent = coverage.describe();

  $('btnRoute').onclick = async () => {
    /* covRouteDest, inte routeDest. Kartvyns egen ruttsökruta äger id:t
       routeDest, och den låg först i dokumentet — getElementById gav alltså
       kartans fält. Mätt: resmål skrivet i inställningarna gav tom sträng
       här, funktionen returnerade tyst, och täckningsläget "Längs min rutt"
       gick inte att ställa in alls. */
    const dest = $('covRouteDest').value.trim();
    if (!dest) return;
    const fix = geo.position;
    if (!fix) { toast('Väntar på GPS innan rutten kan beräknas.'); return; }
    $('btnRoute').disabled = true;
    $('btnRoute').textContent = 'Beräknar…';
    try {
      const r = await coverage.setRoute(fix.lat, fix.lon, dest);
      cov.value = 'route'; syncCoverageRows();
      toast(`Rutt till ${r.name}: ${Math.round(r.distanceM / 1000)} km, ${Math.round(r.durationS / 60)} min.`, 6000);
    } catch (e) {
      toast(e.message, 5000);
    } finally {
      $('btnRoute').disabled = false;
      $('btnRoute').textContent = 'Beräkna';
    }
  };
  $('btnRouteClear').onclick = () => {
    coverage.clearRoute();
    cov.value = coverage.mode; syncCoverageRows();
    toast('Rutten rensad.');
  };

  /* ---- Påminnelse och nattläge ---- */
  bind('setDriveReminder', 'driveReminder', v => !!v);
  bind('setWinter', 'winterOn', v => !!v, renderWinterStatus);
  renderWinterStatus();
  wireGroups();
  wireFbGrupper();
  renderDriveStatus();
  /*
   * Varför notisläget räknas ut på ett ställe och inte två.
   *
   * Den här rutan sa förut "Den här webbläsaren stödjer inte notiser" på en
   * iPhone som stödjer notiser alldeles utmärkt. Felet var inte upptäckten
   * utan att den gjordes två gånger: push.js har capabilities() som skiljer
   * på "för gammal iOS", "ligger inte på hemskärmen" och "fel webbläsare" —
   * och den här rutan använde den inte, utan sin egen platta lista där allt
   * som inte var granted/denied/default blev "stödjer inte".
   *
   * Det gjorde felet omöjligt att ta sig ur. På iPhone saknas Notification
   * i en vanlig Safari-flik, så permission blev 'unsupported', texten blev
   * "stödjer inte" och knappen doldes — samtidigt som reglaget nedanför
   * hänvisade till just den dolda knappen. Två rader som pekade på varandra
   * och en användare utan någonstans att trycka. Den riktiga åtgärden, lägg
   * appen på hemskärmen, nämndes ingenstans trots att push.js kunde säga
   * exakt det.
   *
   * Nu är capabilities() enda källan, och båda ställena läser samma svar.
   */
  const notisLage = () => {
    const p = driving.permission;
    if (p === 'granted') {
      /*
       * Tillstånd är inte samma sak som att en notis kommer fram. Saknas
       * prenumerationen har servern ingen rad att skicka till, och då når
       * ingenting telefonen när appen är stängd. Att skriva "Notiser tillåtna.
       * Appen kan påminna dig" i det läget är ett löfte appen inte kan hålla —
       * det var precis så det såg ut medan det bara fanns en enda
       * prenumeration i hela databasen.
       *
       * prenumererad kommer från den senaste ritningen av kortet "Plats och
       * notiser" (behKortStatus). Är den inte läst än säger vi ingenting om
       * saken i stället för att gissa.
       */
      const n = behKortStatus?.notiser;
      const pren = n && !n.snabbLast ? n.prenumererad : null;   // snabb avläsning vet inte
      return { kanFraga: false, blockerad: false,
        text: pren === false
          ? 'Notiser är tillåtna, men den här telefonen är inte registrerad hos servern. Tryck "Registrera telefonen" under Plats och notiser högst upp.'
          : 'Notiser tillåtna. Appen kan påminna dig innan du brukar köra.' };
    }
    if (p === 'denied') {
      return { kanFraga: false, blockerad: true,
        text: 'Notiser nekade. Tillåt dem i telefonens inställningar för appen.' };
    }
    // Kvar: 'default' och 'unsupported'. Fråga push.js vad som gäller innan
    // vi påstår något — 'unsupported' betyder nästan alltid något åtgärdbart.
    const k = Push.capabilities();
    if (!k.supported) return { kanFraga: false, blockerad: true, text: k.reason, fix: k.fix };
    return { kanFraga: true, blockerad: true, text: 'Inte tillfrågad än.' };
  };

  const renderNotify = () => {
    const l = notisLage();
    $('notifyStatus').textContent = l.text;

    /*
     * Knappen döljs inte längre när frågan är förbrukad.
     *
     * Förut försvann den så fort kanFraga blev false, samtidigt som texterna
     * runtomkring — och gruppnotisrutan längre ner — fortsatte hänvisa till
     * "knappen ovanför". Föraren satt med en instruktion om att trycka på
     * något som inte fanns. Går det inte att fråga leder knappen i stället
     * till menyvägen för just den telefonen, och det är alltid något.
     */
    const btn = $('btnNotify');
    btn.hidden = false;
    btn.disabled = !l.kanFraga && !l.blockerad;       // redan påslaget
    btn.textContent = l.kanFraga ? 'Tillåt notiser'
      : l.blockerad ? 'Så slår du på'
      : 'Notiser är på';

    renderGruppnotis();
  };
  /*
   * Går via samma väg som kortet "Plats och notiser" högst upp, inte via
   * driving.requestPermission().
   *
   * Den gamla vägen bad bara om tillstånd. Ingen prenumeration skapades, ingen
   * rad hamnade på servern, och ändå skrev appen "Notiser tillåtna. Appen kan
   * påminna dig innan du brukar köra." Det är sannolikt en stor del av
   * förklaringen till att det bara fanns en enda prenumeration i databasen:
   * den här knappen såg ut att göra jobbet och gjorde det inte.
   *
   * behKnapp() frågar synkront i klicket, så gesten överlever.
   */
  $('btnNotify').onclick = () => behKnapp('notiser');
  renderNotify();

  /* Ritas om när tillståndet eller prenumerationen ändrats någon annanstans i
     appen — annars står texten här kvar och har fel tills vyn öppnas igen. */
  Behorigheter.events.addEventListener('andrad', e => {
    if (e.detail?.vad === 'notiser') renderNotify();
  });

  /* ---- Notiser från Facebook-gruppen ----
   *
   * Servern äger sanningen — reglaget speglar bara vad telefonen tror. Går
   * anropet fel ställs kryssrutan tillbaka, för en kryssruta som ser påslagen
   * ut medan servern säger nej är värre än en som är av: man slutar undra
   * varför inga notiser kommer.
   */
  /*
   * Reglaget stängs av när notiser inte går att få, i stället för att stå
   * påslagbart och tyst misslyckas. Ett reglage man kan dra men som far
   * tillbaka lär användaren att appen är trasig; ett gråat reglage med en
   * mening om varför lär hen vad som ska göras.
   *
   * Funktionsdeklaration, inte const: renderNotify() anropar den och körs
   * längre upp i samma block.
   */
  function renderGruppnotis(server) {
    const box = $('setGruppnotiser');
    if (!box) return;
    const l = notisLage();
    box.disabled = l.blockerad;
    if (l.blockerad) box.checked = false;
    const status = $('gruppnotisStatus');
    if (!status || status.dataset.egen === '1') return;
    if (l.blockerad) {
      status.textContent = l.kanFraga ? 'Tillåt notiser först — knappen ovanför.' : l.text;
      return;
    }
    /*
     * Tre lägen till utöver På och Av, och de är inte kosmetik.
     *
     * finns=false betyder att telefonen har en prenumeration servern inte
     * känner igen. Det händer på riktigt: prenumererar man utloggad får
     * raden ett slumpat enhets-id, loggar man sedan in skrivs den om till
     * kontots id. Reglaget kan då dras hur mycket som helst utan att något
     * ändras. Förut sa appen "På" i det läget.
     *
     * aktiv=false betyder att raden finns men är utslagen — påslagen men
     * med för många misslyckade utskick bakom sig.
     */
    if (server && !server.nadde) {
      status.textContent = server.pa
        ? 'På (kunde inte nå servern för att bekräfta).'
        : 'Av (kunde inte nå servern för att bekräfta).';
      return;
    }
    if (server && !server.finns) {
      box.checked = false;
      status.textContent = 'Notiserna behöver slås på igen — tryck "Tillåt notiser" ovanför.';
      return;
    }
    if (server && server.pa && !server.aktiv) {
      box.checked = true;
      status.textContent = 'På, men servern når inte den här telefonen. Slå av och på igen.';
      return;
    }
    const pa = server ? server.pa : Push.harGruppnotiser();
    box.checked = pa;
    status.textContent = pa ? 'På. Du får en notis när det kommit nya inlägg.' : 'Av.';
  }

  /* Frågar servern och ritar om. Anropas när inställningarna öppnas — inte
     vid varje omritning, eftersom det är ett nätanrop. */
  ritaGruppnotis = renderGruppnotis;

  synkaGruppnotis = async () => {
    if (notisLage().blockerad) return;
    const status = $('gruppnotisStatus');
    if (status) delete status.dataset.egen;   // serverns svar vinner över gammal egen text
    try { renderGruppnotis(await Push.hamtaGruppnotiser()); } catch {}
  };

  const gnBox = $('setGruppnotiser');
  if (gnBox) {
    gnBox.checked = Push.harGruppnotiser();
    gnBox.onchange = async () => {
      const vill = gnBox.checked;
      const status = $('gruppnotisStatus');
      const ok = await Push.sattGruppnotiser(vill);
      // Egen text vinner över den automatiska tills nästa omritning, annars
      // skulle "Kunde inte nå servern" skrivas över direkt av "Av."
      status.dataset.egen = '1';
      if (!ok) {
        gnBox.checked = !vill;
        status.textContent =
          Push.permission() === 'granted'
            ? 'Gick inte att spara. Servern känner kanske inte igen den här telefonen — tryck "Tillåt notiser" ovanför.'
            : 'Tillåt notiser först — knappen ovanför.';
        return;
      }
      status.textContent = vill
        ? 'På. Du får en notis när det kommit nya inlägg.'
        : 'Av.';
    };
  }
  renderGruppnotis();

  /* ---- Räckvidd för notiser till låst skärm ----
   *
   * Reglaget står i kortet "Varningar", tillsammans med de andra frågorna om
   * vad appen ska säga till om. Knappen "Tillåt notiser" ligger DÄREMOT
   * längre ner, i kortet "Påminnelse när du kör" — därför säger texterna här
   * "längre ner" och inte "ovanför" som gruppnotisrutan gör. Flyttas något av
   * korten måste de orden med.
   *
   * Servern äger sanningen precis som för gruppnotiserna: settings är bara
   * vad telefonen tror, så att rutan kan ritas direkt vid start i stället för
   * att stå tom tills nätet svarat. Kommer ett serversvar vinner det.
   *
   * Det här reglaget har INGENTING med "Var vill du bli varnad?" att göra,
   * hur lika de än ser ut. Coverage bestämmer vad som ritas på kartan medan
   * du kör; det här bestämmer vem servern väcker när appen är stängd. Två
   * frågor med två olika rätta svar — slå inte ihop dem, och återanvänd inte
   * settings.coverageRadiusM här.
   */
  const kmText = m => Math.round(m / 1000) + ' km';

  /* Hur många trakter servern känner till för den här telefonen. Antalet,
     aldrig punkterna själva — appen behöver veta ATT den vet var föraren hör
     hemma, inte var det är. null = vi har inte frågat än. */
  let antalTrakter = null;

  /*
   * Servern svarar radie_m och antal_platser. push.js kan ha döpt om dem till
   * kamelrygg på vägen; läs båda hellre än att låta rutan tystna för att ett
   * fältnamn översatts i ett annat lager.
   */
  const lasOmfang = s => !s ? null : {
    nadde: s.nadde !== false,
    finns: !!s.finns,
    aktiv: !!s.aktiv,
    folj: !!s.folj,
    radieM: Number(s.radieM ?? s.radie_m) || settings.notisRadieM,
    antalPlatser: Number(s.antalPlatser ?? s.antal_platser) || 0,
  };

  /* Funktionsdeklaration av samma skäl som renderGruppnotis: den anropas
     från synkaNotisOmfang, som tilldelas längre ner i samma block. */
  function renderNotisOmfang(svar) {
    const val = $('setNotisOmfang');
    const rad = $('setNotisRadie');
    if (!val || !rad) return;
    const server = lasOmfang(svar);
    const l = notisLage();
    val.disabled = rad.disabled = l.blockerad;

    // Serverns svar skriver om det telefonen trodde — men bara när servern
    // faktiskt svarat OCH känner igen prenumerationen. Ett "finns: false"
    // säger ingenting om vad föraren valt, bara att raden inte hittades.
    if (server?.nadde && server.finns) {
      settings.notisFolj = server.folj;
      settings.notisRadieM = server.radieM;
      antalTrakter = server.antalPlatser;
      saveSettings();
    }

    /*
     * Har servern inte svarat, eller inte känt igen prenumerationen, står
     * klientens förval kvar — och det förvalet är notisFolj: true, alltså
     * "Nära mig". Rutan faller alltså aldrig tillbaka på "Hela landet" bara
     * för att nätet var borta; den visar det förval föraren annars hade fått.
     */
    val.value = settings.notisFolj ? 'nara' : 'alla';
    rad.value = settings.notisRadieM;
    $('setNotisRadieVal').textContent = kmText(settings.notisRadieM);
    // Räckvidden är meningslös när allt släpps igenom. Samma grepp som
    // radiusRow i bevakningsområdet: dölj frågan i stället för att gråa den.
    $('notisRadieRow').hidden = !settings.notisFolj;

    const status = $('notisPlatsStatus');
    if (!status || status.dataset.egen === '1') return;

    if (l.blockerad) {
      status.textContent = l.kanFraga
        ? 'Slå på notiser först — knappen "Tillåt notiser" längre ner.'
        : l.text;
      return;
    }
    if (server && !server.nadde) {
      status.textContent = 'Kunde inte nå servern. Rutan visar det du valde senast.';
      return;
    }
    if (server && !server.finns) {
      status.textContent = 'Servern känner inte igen den här telefonen. Tryck "Tillåt notiser" längre ner.';
      return;
    }
    // Raden finns men är utslagen. Värt en egen rad här och inte bara nere vid
    // gruppnotisrutan: korten ligger inte längre bredvid varandra, och en
    // räckvidd som ser inställd ut medan ingenting går fram är tystnaden i sig.
    if (server && !server.aktiv) {
      status.textContent = 'Räckvidden är sparad, men servern når inte den här telefonen. '
        + 'Slå av och på "Notis när någon skrivit i gruppen" längre ner.';
      return;
    }
    if (!settings.notisFolj) {
      status.textContent = 'Du får alla varningar, var i landet de än dyker upp.';
      return;
    }
    // Noll trakter är inte ett fel utan ett normalt första dygn — och det
    // ärliga svaret är att inget filtreras bort än. Säger appen "inom 100 km"
    // när den ännu inte vet var föraren kör, låter den mer bestämd än den är.
    if (antalTrakter === 0) {
      status.textContent = 'Appen håller på att lära sig var du kör — en trakt räknas '
        + 'först när telefonen varit där två olika dagar. Tills dess får du alla varningar.';
      return;
    }
    // null = servern är inte tillfrågad än. Beskriv inställningen, räkna inte
    // trakter vi inte fått något tal på.
    const km = kmText(settings.notisRadieM);
    status.textContent =
      antalTrakter > 1  ? `Du får varningar inom ${km} från de ${antalTrakter} trakter du brukar köra i.` :
      antalTrakter === 1 ? `Du får varningar inom ${km} från den trakt du brukar köra i.` :
                           `Du får varningar inom ${km} från de trakter du brukar köra i.`;
  }

  synkaNotisOmfang = async () => {
    const status = $('notisPlatsStatus');
    if (status) delete status.dataset.egen;   // serverns svar vinner över gammal egen text
    if (notisLage().blockerad) { renderNotisOmfang(); return; }
    // Fångar även att push.js saknar funktionen: då är svaret "vi vet inte",
    // vilket är sant, och rutan visar det telefonen valde senast.
    try { renderNotisOmfang(await Push.hamtaNotisomfang()); }
    catch { renderNotisOmfang({ nadde: false }); }
  };

  const sparaOmfang = async (folj, radieM) => {
    const val = $('setNotisOmfang');
    const rad = $('setNotisRadie');
    const status = $('notisPlatsStatus');
    const forra = { folj: settings.notisFolj, radieM: settings.notisRadieM };

    let ok = false;
    try {
      const svar = await Push.sattNotisomfang(folj, radieM);
      // sattGruppnotiser svarar med true/false. Skulle den här svara med
      // serverns hela objekt i stället duger sanningsvärdet ändå, så länge
      // ett uttryckligt ok: false inte råkar räknas som lyckat.
      ok = !!svar && svar.ok !== false;
    } catch { ok = false; }

    if (!ok) {
      // Tillbaka till det som faktiskt gäller på servern. Ett reglage som står
      // kvar på det man drog till lär föraren att inställningen sparades.
      settings.notisFolj = forra.folj;
      settings.notisRadieM = forra.radieM;
      val.value = forra.folj ? 'nara' : 'alla';
      rad.value = forra.radieM;
      $('setNotisRadieVal').textContent = kmText(forra.radieM);
      $('notisRadieRow').hidden = !forra.folj;
      if (status) {
        // Egen text vinner tills nästa omritning, annars skrivs den över direkt.
        status.dataset.egen = '1';
        status.textContent = Push.permission() === 'granted'
          ? 'Gick inte att spara. Servern känner kanske inte igen den här telefonen — tryck "Tillåt notiser" längre ner.'
          : 'Slå på notiser först — knappen "Tillåt notiser" längre ner.';
      }
      return;
    }

    settings.notisFolj = folj;
    settings.notisRadieM = radieM;
    saveSettings();
    if (status) delete status.dataset.egen;
    renderNotisOmfang();
  };

  const noVal = $('setNotisOmfang');
  const noRad = $('setNotisRadie');
  if (noVal && noRad) {
    noVal.onchange = () => sparaOmfang(noVal.value === 'nara', +noRad.value);
    /*
     * Etiketten följer fingret, men servern hörs av först när reglaget
     * släpps. oninput smäller till tjugo gånger under ett drag, och tjugo
     * anrop där det sista ändå vinner är tjugo tillfällen att komma fram i
     * fel ordning.
     */
    noRad.oninput = () => { $('setNotisRadieVal').textContent = kmText(+noRad.value); };
    noRad.onchange = () => sparaOmfang(noVal.value === 'nara', +noRad.value);
  }
  // Rita direkt ur det telefonen minns; showView frågar servern när
  // inställningarna öppnas.
  renderNotisOmfang();

  /* ---- Rapportpoäng ---- */
  $('btnRepSave').onclick = async () => {
    reputation.setNickname($('repNick').value);
    const ok = await reputation.publish(deviceId(), reputation.nickname);
    toast(ok ? 'Sparat. Du syns nu på topplistan.' : 'Sparat lokalt. Slå på delat läge för topplistan.');
    refreshLeaderboard();
  };

  /*
   * Här låg en "Spara och anslut"-knapp som läste en serveradress och en
   * API-nyckel ur två textfält. Den var kvar från tiden innan appen hade en
   * egen backend, och gjorde ingen nytta: anslutningen byggs redan av CONFIG
   * vid start (se där store skapas). Det enda den kunde åstadkomma var att en
   * användare skrev fel i ett fält och tappade kontakten med de andra
   * förarna.
   */
}





/* ================= Mörkt körläge ================= */
/*
 * Skärmen är den enskilt största batteriposten i appen. Den syns inte med en
 * enda millisekund i någon profil — men en tänd telefonskärm drar mer än all
 * kod vi skrivit tillsammans.
 *
 * Mörkläget slocknar allt utom farten, gränsen och en eventuell varning. På en
 * OLED-skärm kostar svarta pixlar nästan ingenting, och medan kartan inte syns
 * slutar vi rita den.
 *
 * Tre regler som inte får brytas:
 *
 *   1. En varning gömmer sig aldrig. Kommer det en visas den stort mitt på den
 *      mörka skärmen. Ett sparläge som döljer det appen finns till för är
 *      inget sparläge.
 *   2. Det slår bara till när bilen rullar. Sitter man still och läser i
 *      chatten ska skärmen inte svartna för att man inte rört den på en halv
 *      minut.
 *   3. Vad som helst väcker den. Tryck, sväng, knapptryck — allt. Ett läge man
 *      inte hittar ur är en fälla, inte en funktion.
 */

const MORKT = {
  efterMs: 25000,        // stillhet innan skärmen går ner
  fartKmh: 25,           // under den här farten aktiveras det aldrig
};

let morktAktivt = false;
let morktTimer = null;
let morktRender = null;

function morktMojligt() {
  if (settings.morktLage === false) return false;
  if (document.body.dataset.view !== 'map') return false;   // bara på kartan
  const kmh = geo.position?.speedKmh ?? 0;
  return kmh >= MORKT.fartKmh;
}

function tandSkarmen() {
  if (morktAktivt) {
    morktAktivt = false;
    clearInterval(morktRender);
    morktRender = null;
    $('morktLage').hidden = true;
    document.body.classList.remove('is-morkt');
    map.invalidate?.();
    renderHazards();
  }
  clearTimeout(morktTimer);
  morktTimer = setTimeout(() => { if (morktMojligt()) slackSkarmen(); }, MORKT.efterMs);
}

function slackSkarmen() {
  if (morktAktivt || !morktMojligt()) return;
  morktAktivt = true;
  $('morktLage').hidden = false;
  document.body.classList.add('is-morkt');
  renderMorkt();

  /*
   * Uppdatera en gång i sekunden medan skärmen är nere.
   *
   * Farten måste vara färsk — en siffra som står stilla är värre än ingen.
   * Och det är den andra garantin för att en varning inte kan gömmas: även om
   * någon i framtiden reser banderollen på ett sätt vi inte känner till här,
   * plockas den upp inom en sekund.
   *
   * Kostnaden är några DOM-skrivningar i sekunden mot en karta som inte ritas
   * alls. Det är en bra affär.
   */
  clearInterval(morktRender);
  morktRender = setInterval(renderMorkt, 1000);
}

function renderMorkt() {
  if (!morktAktivt) return;
  const fix = geo.position;
  $('mlFart').textContent = fix?.speedKmh != null ? Math.round(fix.speedKmh) : '–';

  const grans = limits.current?.limit;
  $('mlGrans').hidden = !grans;
  if (grans) $('mlGrans').textContent = grans;

  // Varningen ärvs från banderollen. Är den uppe syns den här, stort.
  const banner = $('alertBanner');
  const varning = !banner.hidden ? $('alertTitle').textContent : '';
  $('mlVarning').hidden = !varning;
  $('mlVarning').textContent = varning;
}

function wireMorktLage() {
  if (!$('morktLage')) return;

  // Allt som är ett livstecken väcker skärmen.
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(ev, tandSkarmen, { passive: true });
  }

  tandSkarmen();
}

/* ================= Månadens belöning ================= */
/*
 * Appen lovar på tre ställen att de tio som rapporterar mest får nästa månad
 * gratis. Servern delar numera ut den. Det som saknades var att vinnaren fick
 * veta det — en belöning ingen märker är ingen belöning, och ett löfte som
 * uppfylls tyst räknas inte av den som väntat på det.
 *
 * Beskedet visas en gång och kvitteras sedan, så det inte ligger och blinkar
 * i evighet.
 */

const MANADSNAMN = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli',
                    'augusti', 'september', 'oktober', 'november', 'december'];

/** '2026-07' → 'juli'. */
function manadOrd(kod) {
  const m = Number(String(kod || '').slice(5, 7));
  return MANADSNAMN[m - 1] || kod;
}

/** '2026-07' → 'augusti' — månaden man faktiskt fick gratis. */
function manadenEfter(kod) {
  const m = Number(String(kod || '').slice(5, 7));
  return MANADSNAMN[m % 12] || '';
}

const ORDNINGSTAL = ['', 'första', 'andra', 'tredje', 'fjärde', 'femte',
                     'sjätte', 'sjunde', 'åttonde', 'nionde', 'tionde'];

async function hamtaBelaning() {
  if (!hasBackend()) return null;
  try {
    const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/min_belaning`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_device: deviceId() }),
    });
    if (!r.ok) return null;
    const rader = await r.json();
    return (Array.isArray(rader) ? rader : []).find(x => x && !x.kvitterad) || null;
  } catch (e) {
    /*
     * Ett nätfel här får aldrig störa något — beskedet kommer nästa gång.
     * Men felet ska SYNAS i konsolen, inte försvinna.
     *
     * Första versionen svalde allt tyst, och det dolde en ren tabbe: jag
     * använde apiHeaders utan att importera den. Anropet gick aldrig iväg,
     * funktionen returnerade null, och allt såg lugnt ut. Ett catch som
     * fångar programmeringsfel lika tyst som nätfel gör felsökning omöjlig.
     */
    console.warn('Kunde inte hämta månadsbelöningen:', e.message);
    return null;
  }
}

async function kvitteraBelaning(manad) {
  try {
    await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/kvittera_belaning`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_manad: manad, p_device: deviceId() }),
    });
  } catch {}
}

async function visaBelaning() {
  const rad = await hamtaBelaning();
  const ruta = $('modalBelaning');
  if (!rad || !ruta) return;

  const plats = ORDNINGSTAL[rad.placering] || `${rad.placering}:e`;
  $('belaningRubrik').textContent = `Du kom ${plats} i ${manadOrd(rad.manad)}.`;
  $('belaningText').textContent =
    `${versal(manadenEfter(rad.manad))} är gratis. Prenumerationen är redan ` +
    `förlängd — du behöver inte göra något.`;

  // Siffrorna som avgjorde. Utan dem är det bara ett påstående.
  $('belaningDetalj').textContent =
    `${rad.rapporter} rapporter, ${rad.poang} poäng. ` +
    (rad.gratis_till
      ? `Betald till ${new Date(rad.gratis_till).toLocaleDateString('sv-SE')}.`
      : '');

  ruta.hidden = false;
  ljud.bekrafta();

  $('belaningStang').onclick = async () => {
    ruta.hidden = true;
    await kvitteraBelaning(rad.manad);
  };
}

const versal = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* ================= Navigering ================= */
/*
 * Svängbeskrivningar ovanpå ruttvarningarna.
 *
 * De två delar rutt med flit. rutt.js hämtar den, navigering.js får samma
 * råsvar. Hämtade de varsin kunde OSRM svara med två olika vägar — appen
 * varnar för polis längs väg A medan rösten säger svängar för väg B, och båda
 * har rätt var för sig.
 *
 * Polisvarningarna går alltid först. En missad avfart kostar fem minuter; en
 * missad fartkamera kostar tusentals kronor.
 */

const nav = new Navigering();

/**
 * Säg det navigeringen vill ha sagt.
 *
 * Varje yttrande bär ett bäst-före. Hamnar det i kö bakom en polisvarning och
 * hinner bli gammalt ska det kastas, inte läsas — "sväng höger nu" tolv
 * sekunder efter korsningen får föraren att leta efter en avtagsväg som inte
 * finns.
 */
function talaNav(yttranden, nu = Date.now()) {
  if (!settings.tts) return;
  for (const y of yttranden || []) {
    if (y.giltigTillTs && nu > y.giltigTillTs) continue;
    speaker.say(y.text, { priority: y.prioritet ?? 0, interrupt: false });
  }
}

/**
 * Körfältsraden.
 *
 * Pilarna roteras ur gradtalen modulen ger, så gränssnittet aldrig behöver
 * känna igen OSRM:s engelska ordlista. Spärrade filer tonas ner i stället för
 * att döljas — man behöver se hela vägbanan för att förstå vilken fil man
 * ligger i, annars går det inte att räkna sig fram till rätt.
 *
 * Den bästa filen ramas in. Vi vet INTE vilken fil bilen faktiskt ligger i:
 * GPS har omkring tio meters fel och en fil är tre och en halv meter bred.
 * Därför säger raden aldrig "byt två filer åt höger" — den visar var man ska
 * hamna och låter föraren avgöra hur.
 */
function renderKorfalt(k) {
  const box = $('navFiler');
  if (!box) return;
  if (!k?.filer?.length) { box.hidden = true; box.innerHTML = ''; return; }

  box.hidden = false;
  box.innerHTML = '';
  for (const f of k.filer) {
    const d = document.createElement('div');
    d.className = 'fil' + (f.giltig ? ' giltig' : ' sparrad') +
                  (f.index === k.bastaIndex ? ' basta' : '');
    for (let i = 0; i < f.symboler.length; i++) {
      const s = document.createElement('span');
      s.className = 'fil-pil';
      s.textContent = '↑';
      s.style.transform = `rotate(${f.vinklar[i]}deg)`;
      d.appendChild(s);
    }
    box.appendChild(d);
  }
}

function renderNav(t) {
  const kort = $('navManover');
  const bar = $('navAnkomst');
  const varn = $('navVarning');
  if (!kort) return;

  if (!t || !nav.rutt) {
    kort.hidden = true;
    renderKorfalt(null);
    if (bar) bar.hidden = true;
    if (varn) varn.hidden = true;
    return;
  }

  renderKorfalt(t.korfalt);

  if (varn) {
    varn.hidden = !t.varning;
    varn.textContent = t.varning || '';
  }

  const m = t.nastaManover;
  if (t.lage === 'avvikande') {
    kort.hidden = false;
    $('navPil').textContent = '⟳';
    $('navAvstand').textContent = 'Räknar om';
    $('navGata').textContent = 'Du lämnade rutten';
    $('navSedan').hidden = true;
  } else if (t.framme) {
    kort.hidden = false;
    $('navPil').textContent = '⚑';
    $('navAvstand').textContent = 'Framme';
    $('navGata').textContent = nav.mal?.label || '';
    $('navSedan').hidden = true;
  } else if (m) {
    kort.hidden = false;
    $('navPil').textContent = m.symbol || '↑';
    $('navAvstand').textContent = shortDistance(m.avstandM);
    $('navGata').textContent = m.gata || m.kort || '';
    $('navSedan').hidden = !t.efterfoljande;
    $('navSedan').textContent = t.efterfoljande || '';
  } else {
    kort.hidden = true;
  }

  if (bar) {
    // Klockslag, inte minuter kvar.
    bar.hidden = !t.ankomstTs;
    if (t.ankomstTs) {
      bar.textContent = 'Framme ' + new Date(t.ankomstTs)
        .toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    }
  }
}

/** Rita rutten, med den körda delen dämpad. */
function ritaNavRutt(zoomaUt = false) {
  const r = nav.publikRutt();
  if (!r) { map.rensaRutt(); return; }
  map.ritaRutt(r, nav.linjeDelad());
  if (zoomaUt) map.visaHelaRutten(r);
}

/**
 * Koppla ihop rutten från rutt.js med navigeringen.
 *
 * Anropas när RouteGuide fått en ny rutt. Råsvaret innehåller stegen eftersom
 * steps=true numera — utan dem finns geometrin men inga svängar, och då säger
 * navigeringen ingenting.
 */
function nyNavRutt(orsak = 'ny') {
  const raw = routeGuide.rawRoute;
  const pr = routeGuide.publicRoute?.();
  if (!raw || !pr) { nav.rensa(); renderNav(null); map.rensaRutt(); return; }

  try {
    const tolkad = tolkaOsrmRutt(raw);
    const { tal } = nav.satt(
      { ...tolkad, mal: routeGuide.destination },
      { nu: Date.now(), orsak });
    talaNav(tal);
    ritaNavRutt(orsak === 'ny');
    renderNav(nav.tillstand(Date.now()));
  } catch (e) {
    // Navigeringen får aldrig sänka varningarna. Går tolkningen fel kör
    // appen vidare utan svängbeskrivningar i stället för att gå sönder.
    nav.rensa();
    renderNav(null);
    console.warn('Navigering kunde inte starta:', e.message);
  }
}

/** Mata navigeringen med varje GPS-fix. Anropas ur geo-lyssnaren. */
function navFix(fix) {
  if (!nav.rutt) return;
  const nu = Date.now();
  let t;
  try { t = nav.uppdatera({ ...fix, ts: nu }, nu); } catch { return; }

  talaNav(t.tal, nu);
  renderNav(t);

  // Rita om linjen så den körda delen dämpas efter hand.
  const r = nav.publikRutt();
  if (r) map.ritaRutt(r, nav.linjeDelad());

  // Modulen hämtar aldrig själv. Den säger till, appen gör anropet — och
  // RouteGuide äger hämtningen, så båda får samma nya väg.
  if (t.begarOmberakning) routeGuide.recalculate?.(t.begarOmberakning);
}

/* ================= Chatt ================= */
/*
 * Ett gemensamt rum för alla som kör med appen. Inga grupper — det var
 * ägarens beslut, och det är också det som gör rummet värt något: ett enda
 * ställe där folk faktiskt är, istället för tolv tomma.
 *
 * Två saker skiljer den från en vanlig chatt, och båda är avsiktliga.
 * Skrivfältet låses medan bilen rullar, och nykterhetskontroller kan inte
 * spridas här — samma vägran som resten av appen har, eftersom en fritextruta
 * annars är den självklara vägen runt regeln.
 */

/**
 * Vem som ser det man skriver.
 *
 * Rutkoden i sig ("r238x33") säger ingenting för en människa, så den visas
 * aldrig. Det som betyder något är räckvidden: skriver jag här, vilka når
 * jag? Och när appen inte vet var man är ska det stå — annars undrar man
 * varför ingen svarar.
 */
function renderChattRum() {
  const el = $('chattRum');
  if (!el) return;
  el.textContent = chatt.rutkod
    ? 'Förare i din trakt, ungefär tre mil runt dig.'
    : 'Appen vet inte var du är än, så det du skriver når alla. Slå på ' +
      'platstjänster så hittar du dem som kör i närheten.';
}

function renderChatt() {
  renderChattRum();
  const ul = $('chattLista');
  if (!ul) return;
  const lista = chatt.meddelanden();

  ul.innerHTML = '';
  for (const m of lista) {
    const li = document.createElement('li');
    li.className = 'chatt-rad' + (m.mitt ? ' mitt' : '');

    const tid = new Date(m.skapadAt).toLocaleTimeString('sv-SE',
      { hour: '2-digit', minute: '2-digit' });

    const huvud = document.createElement('div');
    huvud.className = 'chatt-huvud';
    // Meddelanden utan område kan komma från var som helst i landet. Det ska
    // synas, annars läser man "polis vid rondellen" och letar efter en
    // rondell som ligger sjuttio mil bort.
    const omradeMark = m.utanOmrade
      ? `<span class="chatt-utan-omrade" title="Avsändaren hade ingen position">${UTAN_OMRADE_TEXT}</span>`
      : '';
    huvud.innerHTML = `<b>${escapeHtml(m.visningsnamn || 'Förare')}</b>${omradeMark}<span>${tid}</span>`;

    const text = document.createElement('p');
    text.className = 'chatt-text';
    text.textContent = m.text;

    li.append(huvud, text);

    const knappar = document.createElement('div');
    knappar.className = 'chatt-knappar';
    if (m.mitt) {
      const rad = document.createElement('button');
      rad.className = 'lank-knapp';
      rad.textContent = 'Radera';
      rad.onclick = async () => {
        const r = await chatt.radera(m.id);
        r.ok ? ljud.bekrafta() : ljud.fel();
        if (!r.ok) toast(r.meddelande || 'Kunde inte radera.', 4000);
        renderChatt();
      };
      knappar.appendChild(rad);
    } else {
      const anm = document.createElement('button');
      anm.className = 'lank-knapp';
      anm.textContent = chatt.arAnmald(m.id) ? 'Anmäld' : 'Anmäl';
      anm.disabled = chatt.arAnmald(m.id);
      anm.onclick = async () => {
        await chatt.anmal(m.id);
        ljud.bekrafta();
        toast('Tack. Meddelandet är anmält.', 3500);
        renderChatt();
      };
      const tys = document.createElement('button');
      tys.className = 'lank-knapp';
      tys.textContent = 'Dölj den här personen';
      tys.onclick = () => {
        chatt.tystaAvsandarenFor(m.id);
        ljud.av();
        toast('Personens meddelanden döljs på den här telefonen.', 4000);
        renderChatt();
      };
      knappar.append(anm, tys);
    }
    li.appendChild(knappar);
    ul.appendChild(li);
  }

  /*
   * Tomrutan ska säga VARFÖR den är tom.
   *
   * "Inga meddelanden än. Säg något." stämmer bara när servern svarade och
   * inte hade något att ge. Är chatten stängd för utomstående är listan tom
   * av ett helt annat skäl, och då är standardtexten en osanning som får folk
   * att tro att chatten är död i stället för att logga in.
   *
   * Rutan visas då även när det ligger kvar gamla meddelanden i cachen från
   * en tidigare inloggning. De uppdateras inte längre, och det ska stå.
   */
  const tomt = $('chattTomt');
  const sparr = chatt.lasSparr;
  tomt.textContent = sparr || 'Inga meddelanden än. Säg något.';
  tomt.hidden = !sparr && lista.length > 0;

  // Rulla till senaste. Man läser en chatt nerifrån.
  ul.scrollTop = ul.scrollHeight;
  uppdateraSkrivlage();
}

/**
 * Låser eller öppnar skrivfältet och säger varför.
 *
 * Att bara gråa ut ett fält utan förklaring är den sortens gränssnitt som får
 * folk att tro att appen är trasig. Skälet skrivs ut.
 */
function uppdateraSkrivlage() {
  const kan = chatt.kanSkriva();
  const falt = $('chattText');
  const knapp = $('chattSkicka');
  const sparr = $('chattSparr');
  if (!falt) return;

  falt.disabled = !kan.ok;
  knapp.disabled = !kan.ok;
  sparr.hidden = kan.ok;
  sparr.textContent = kan.ok ? '' : (kan.meddelande || '');
}

async function skickaChatt() {
  const falt = $('chattText');
  const text = falt.value.trim();
  if (!text) return;

  const r = await chatt.skicka(text);
  if (r.ok) {
    falt.value = '';
    falt.style.height = 'auto';
    ljud.bekrafta();
  } else {
    ljud.fel();
    toast(r.meddelande || 'Meddelandet gick inte att skicka.', 5000);
  }
  renderChatt();
}

/* ---- Olästa meddelanden ----
 *
 * En prick sa bara "något har hänt". Ett tal säger om det är ett meddelande
 * eller tolv, och det är skillnaden mellan att titta nu eller vänta till nästa
 * rödljus.
 *
 * Räknas mot tidpunkten då chattvyn senast var öppen, inte mot en räknare som
 * nollställs av sig själv — annars försvinner olästa om appen laddas om.
 */
function sattChattLast(nu = Date.now()) {
  settings.chattLastAt = nu;
  saveSettings();
  renderOlasta();
}

function antalOlasta() {
  const sedan = settings.chattLastAt || 0;
  return chatt.meddelanden().filter(m => !m.mitt && m.skapadAt > sedan).length;
}

function renderOlasta() {
  const n = antalOlasta();
  const flik = $('chattAntal');
  if (flik) {
    flik.hidden = n === 0;
    flik.textContent = n > 99 ? '99+' : String(n);
  }

  // Knappen i kameravyn. Visas bara när kameran faktiskt är igång — annars
  // ligger den och skräpar över startskärmen.
  const kameraIgang = dashcam.recording || plate?.running;
  const visa = $('dcChattVisa');
  const ruta = $('dcChatt');
  if (!visa || !ruta) return;

  if (!kameraIgang) { visa.hidden = true; ruta.hidden = true; return; }
  if (!ruta.hidden) { visa.hidden = true; renderDcChatt(); return; }

  visa.hidden = false;
  $('dcChattAntal').textContent = n ? String(n) : '';
  visa.classList.toggle('har-nytt', n > 0);
}

/** De senaste meddelandena, i hörnet, medan man kör. */
function renderDcChatt() {
  const ul = $('dcChattLista');
  if (!ul) return;
  // Bara de senaste. En lång lista i ögonvrån är värre än ingen lista.
  const lista = chatt.meddelanden().slice(-4);
  ul.innerHTML = '';
  for (const m of lista) {
    const li = document.createElement('li');
    li.className = m.mitt ? 'mitt' : '';
    li.innerHTML = `<b>${escapeHtml(m.visningsnamn || 'Förare')}</b> ${escapeHtml(m.text)}`;
    ul.appendChild(li);
  }
  // Samma sanning som i chattvyn, fast kortare. Står det "Inget nytt." när
  // chatten i själva verket är stängd ljuger rutan i ögonvrån för föraren.
  if (chatt.lasSparr || !lista.length) {
    const li = document.createElement('li');
    li.className = 'tom';
    li.textContent = chatt.lasSparr ? 'Logga in för att se chatten.' : 'Inget nytt.';
    ul.appendChild(li);
  }
  ul.scrollTop = ul.scrollHeight;
}

function wireDcChatt() {
  const visa = $('dcChattVisa'), ruta = $('dcChatt'), stang = $('dcChattStang');
  if (!visa) return;
  visa.onclick = () => {
    ruta.hidden = false;
    visa.hidden = true;
    sattChattLast();
    renderDcChatt();
  };
  stang.onclick = () => { ruta.hidden = true; renderOlasta(); };
}

function wireChatt() {
  const falt = $('chattText');
  if (!falt) return;

  chatt.addEventListener('meddelanden', () => {
    if (document.body.dataset.view === 'chatt') { sattChattLast(); renderChatt(); }
    else renderOlasta();
    // Rutan i kameravyn uppdateras även när den redan står öppen.
    if (!$('dcChatt').hidden) renderDcChatt();
  });

  wireDcChatt();

  chatt.addEventListener('blockerat', e => {
    const s = $('chattSparr');
    s.hidden = false;
    s.textContent = e.detail?.meddelande || '';
  });

  chatt.addEventListener('status', () => {
    const el = $('chattStatus');
    if (!el) return;
    /*
     * Modulen formulerar hela meningen själv, så inget prefix här.
     *
     * Tidigare stod det "Ingen kontakt med servern: HTTP 401", och när
     * modulen började svara med begriplig text blev det i stället "Ingen
     * kontakt med servern: Logga in för att se chatten" — två påståenden
     * ovanpå varandra där bara det ena stämde.
     *
     * Är man utloggad står skälet redan på två ställen: vid skrivfältet och
     * i tomrutan där meddelandena skulle ha stått. Att upprepa det en tredje
     * gång gör bara samma sak sagd tre gånger. Modulen sätter för övrigt
     * inget synkFel alls när man är utloggad — den frågar inte servern då —
     * så raden nedan fångar bara ögonblicket mellan en utloggning och nästa
     * hämtning.
     */
    const utloggad = !chatt.inloggad;
    el.textContent = (chatt.synkFel && !utloggad) ? chatt.synkFel : '';
  });

  // Fältet växer med texten istället för att rulla i en enrads-ruta.
  falt.addEventListener('input', () => {
    falt.style.height = 'auto';
    falt.style.height = Math.min(120, falt.scrollHeight) + 'px';
  });

  // Enter skickar, skift+enter ger ny rad. Det är vad folk förväntar sig.
  falt.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); skickaChatt(); }
  });

  $('chattSkicka').onclick = () => skickaChatt();

  chatt.konfigurera({
    identitet: auth.identity,
    visningsnamn: reputation.nickname,
  });
  chatt.starta();

  auth.addEventListener('change', () => {
    chatt.konfigurera({ identitet: auth.identity, visningsnamn: reputation.nickname });
    /*
     * Rita om, inte bara lås upp skrivfältet.
     *
     * Läsningen är också stängd för utloggade, och den texten står i
     * tomrutan. Uppdaterades bara skrivläget stod "Chatten är bara för
     * inloggade" kvar tills nästa pollning hann in — alltså upp till en
     * minut efter att man loggat in, vilket ser ut som att inloggningen
     * inte tog.
     */
    uppdateraSkrivlage();
    if (document.body.dataset.view === 'chatt') renderChatt();
    if (!$('dcChatt').hidden) renderDcChatt();
  });

  uppdateraSkrivlage();
}

/* ================= Notisinställningar per typ ================= */
/*
 * Tre nivåer per varningstyp: av, bara på kartan, eller röst. En ren av/på
 * hade varit för trubbig — många vill se fartkamerorna på kartan utan att bli
 * tilltalade om dem varje gång.
 *
 * Raderna genereras ur modulens typlista, så en ny varningstyp i parser.js
 * dyker upp här av sig själv istället för att tyst sakna en inställning.
 */
function renderNotisTyper() {
  const box = $('notisTyper');
  if (!box) return;
  const valda = Notiser.laddaNotiser(settings);
  box.innerHTML = '';

  for (const t of Notiser.NOTIS_TYPER) {
    const rad = document.createElement('label');
    rad.className = 'row';
    rad.innerHTML = `<span>${t.ikon} ${escapeHtml(t.etikett)}</span>`;

    const sel = document.createElement('select');
    for (const n of [...Notiser.NIVAER].reverse()) {     // röst överst
      sel.add(new Option(Notiser.NIVA_ETIKETT[n], n));
    }
    sel.value = valda[t.typ];
    sel.title = Notiser.NIVA_BESKRIVNING[sel.value] || '';
    sel.onchange = () => {
      Notiser.sparaNotiser(settings, t.typ, sel.value);
      saveSettings();
      sel.title = Notiser.NIVA_BESKRIVNING[sel.value] || '';
      // Varningsmotorn minns vad den redan varnat för. Utan en nollställning
      // kan en typ man precis slagit på förbli tyst hela resten av resan.
      engine.reset?.();
      renderHazards();
    };
    rad.appendChild(sel);
    box.appendChild(rad);
  }
}

/* ================= Gränssnittsljud ================= */
/*
 * En enda delegerad lyssnare istället för ljud inklistrat på varje knapp.
 * Nya knappar får ljud automatiskt, och det finns bara ett ställe att stänga
 * av om ljuden visar sig störa.
 */
function wireLjud() {
  document.addEventListener('click', e => {
    const el = e.target.closest('button, .tab, .act');
    if (!el || el.disabled) return;
    if (el.dataset.view) { ljud.flik(); return; }
    if (el.classList.contains('act')) { ljud.tryck(); return; }
    ljud.tryck();
  }, true);

  // Reglagen låter olika beroende på riktning — man hör om något slogs på
  // eller av utan att titta.
  document.getElementById('view-settings')?.addEventListener('change', e => {
    if (e.target.type === 'checkbox') e.target.checked ? ljud.pa() : ljud.av();
  });
}
/* ================= Dela appen ================= */

function renderShareQR() {
  const wrap = $('qrWrap');
  if (!wrap) return;
  // Ta bort eventuella frågeparametrar — koden ska peka på appen, inte på
  // det tillstånd just den här telefonen råkar ha i adressfältet.
  const url = location.origin + location.pathname.replace(/index\.html$/, '');
  try {
    wrap.innerHTML = qrToSVG(url, { moduleSize: 6, margin: 3, dark: '#0b0f14', light: '#ffffff' });
  } catch (e) {
    wrap.innerHTML = '';
    return;
  }
  $('qrUrl').textContent = url.replace(/^https?:\/\//, '');

  $('btnQrShare').onclick = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Polisvakt Västmanland', url }); return; } catch {}
    }
    try { await navigator.clipboard.writeText(url); toast('Länken är kopierad.'); }
    catch { toast(url, 8000); }
  };

  $('btnQrSave').onclick = () => {
    const svg = wrap.innerHTML;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'polisvakt-qr.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

function renderRemoteStatus() {
  const el = $('remoteStatus');
  if (!el) return;
  if (!remote.supported) {
    el.textContent = 'Den här webbläsaren stödjer inte mediaknappar. En Bluetooth-dosa som uppträder som tangentbord fungerar ändå.';
    return;
  }
  el.textContent = remote.mediaSessionActive
    ? 'Aktivt. Bilens rattknappar styr Polisvakt, inte musiken. Stäng av här för att få tillbaka musikkontrollen.'
    : 'Bluetooth-dosor på ratten fungerar redan utan detta. Slå bara på om du vill använda bilens egna rattknappar.';
}

function renderImpactStatus() {
  const el = $('impactStatus');
  if (!el) return;
  if (!motionSupported) {
    el.textContent = 'Telefonen rapporterar ingen rörelsedata till webbläsaren.';
    return;
  }
  const lvl = IMPACT_LEVELS[settings.impactLevel];
  el.textContent = impact.running
    ? `Aktiv. Låser klipp vid ${String(lvl.hardBrakeG).replace('.', ',')} g och uppåt.`
    : (motionNeedsPermission
      ? 'Kräver tillstånd. Slå på reglaget så frågar telefonen.'
      : 'Avstängd.');
}

function refreshLearnedList() {
  const ul = $('learnedList');
  if (!ul) return;
  const items = listLearned();
  ul.innerHTML = items.length ? '' : '<li style="color:var(--fg-dim)">Inga ännu.</li>';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(it.label || it.phrase)}</span>`;
    const b = document.createElement('button');
    b.textContent = 'Ta bort';
    b.onclick = () => { forgetPlace(it.phrase); refreshLearnedList(); };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

/* ================= Diverse ================= */

/*
 * Skärmlåset.
 *
 * Systemet släpper låset av sig själv så fort appen hamnar i bakgrunden, så
 * det måste tas om när man kommer tillbaka. Den lyssnaren registreras EN gång.
 *
 * Tidigare låg addEventListener inuti requestWakeLock, som anropas varje gång
 * inställningen rörs och varje gång fliken blir synlig igen. Lyssnarna
 * staplades — sex stycken på tre minuter i mätningen — och varje ny lyssnare
 * begärde låset en gång till vid varje flikbyte. En läcka som växer med hur
 * mycket appen används är precis den sorten som inte syns förrän någon mäter.
 */
let wakeLyssnare = false;

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }

  if (wakeLyssnare) return;
  wakeLyssnare = true;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && settings.keepAwake && !wakeLock) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }
  });
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }

/**
 * Stäng av zoom.
 *
 * iOS Safari struntar i user-scalable=no sedan länge, så det räcker inte med
 * viewport-taggen. Här fångas nypgesten och dubbeltrycket i stället. Kartan
 * undantas — där ska man kunna zooma.
 */
function lockZoom() {
  const onMap = t => !!(t && t.closest && t.closest('#map'));

  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, e => { if (!onMap(e.target)) e.preventDefault(); }, { passive: false });
  }
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1 && !onMap(e.target)) e.preventDefault();
  }, { passive: false });

  let lastTap = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 320 && !onMap(e.target)) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  // Ctrl+hjul på dator zoomar också
  document.addEventListener('wheel', e => {
    if (e.ctrlKey && !onMap(e.target)) e.preventDefault();
  }, { passive: false });
}

/** Provknapparna: hör exakt vad appen säger innan du sitter i bilen. */
function wireDemos() {
  document.querySelectorAll('[data-demo]').forEach(btn => {
    btn.onclick = () => {
      const slag = btn.dataset.demo;
      const text = speaker.demo(slag);
      $('demoText').textContent = '"' + text + '"';

      /*
       * Visa bannern för ALLA faror, inte bara polis och kontroll.
       *
       * Provet fanns för att man ska höra OCH se hur en varning ser ut innan
       * man sitter i 90. Fartkameran och civilbilen fick förut bara ljudet,
       * vilket gjorde provet till en halv sanning: den som tryckt på alla
       * knappar trodde sig ha sett allt.
       *
       * Avstånden matchar de uppspelade meningarna, annars säger rösten en
       * sak och rutan en annan.
       */
      const avstand = { police: 1200, control: 900, unmarked: 700, camera: 600 }[slag];
      if (avstand) {
        showAlertBanner({
          id: 'demo', distance: avstand, at: Date.now(),
          hazard: {
            type: slag,
            label: 'Provkörning',
            // Den fasta kameran rapporteras inte av någon och har ingen ålder.
            createdAt: slag === 'camera' ? null : Date.now() - 240000,
            fixed: slag === 'camera',
          },
        });
      }
    };
  });
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= Automatisk uppdatering ================= */

let swRegistration = null;
let pendingUpdate = false;
// Versionen service workern rapporterar. Enda källan som inte kan glida isär
// från vad som faktiskt körs — se renderVersion.
let swVersion = null;

/**
 * Appen håller sig själv uppdaterad.
 *
 * Service workern installerar nya versioner i bakgrunden. Det känsliga är
 * *när* omladdningen sker: att byta version mitt under en körning skulle
 * avbryta varningarna i några sekunder, och det är precis då de behövs. Därför
 * väntar omladdningen tills bilen står still, eller tills appen läggs undan.
 */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;   // fungerar bara över http(s)

  navigator.serviceWorker.register('./sw.js').then(reg => {
    swRegistration = reg;

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          pendingUpdate = true;
          applyUpdateWhenSafe();
        }
      });
    });

    // Leta efter nya versioner då och då, och när appen kommer i förgrunden
    setInterval(() => reg.update().catch(() => {}), 30 * 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        reg.update().catch(() => {});
        applyUpdateWhenSafe();
      }
    });
  }).catch(() => {});

  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'version') {
      swVersion = e.data.version;
      const el = $('versionInfo');
      if (el) el.textContent = `Version ${swVersion}`;
      // Och märket i tabbaren, som syns i alla vyer. Det är den enda plats
      // svaret finns när man står någon annanstans än i Inställningar.
      renderVersionsmarke();
    }
    if (e.data?.type === 'updated') {
      pendingUpdate = true;
      applyUpdateWhenSafe();
    }
  });

  navigator.serviceWorker.ready.then(reg => {
    reg.active?.postMessage({ type: 'version' });
  });

  /*
   * Leta efter nya versioner medan appen är öppen, inte bara vid start.
   *
   * Webbläsaren frågar efter service worker-filen när sidan laddas, och
   * sedan högst en gång per dygn. En app som ligger öppen på hemskärmen i
   * en vecka — vilket är precis hur den här används — kunde alltså missa
   * varenda utrullning tills någon råkade stänga och öppna den. Föraren
   * hade en fix installerad hos oss och en gammal app i handen, utan att
   * något sa emot.
   *
   * Två tillfällen räcker och kostar nästan ingenting:
   *
   *   var trettionde minut, men BARA när fliken syns. En bakgrundsflik ska
   *   inte väcka radion; strypningen gör dessutom intervallet oförutsägbart
   *   där, och en missad kontroll är helt harmlös.
   *
   *   när appen kommer i förgrunden igen. Det är då man tittar på den, och
   *   det är då en omladdning stör minst.
   *
   * update() hämtar bara sw.js och jämför — några hundra byte. Finns inget
   * nytt händer ingenting alls. Hittas något tar den befintliga kedjan vid:
   * bannern visas, och omladdningen väntar tills bilen står still.
   */
  const LETA_INTERVALL_MS = 30 * 60 * 1000;
  let sistaKollen = Date.now();

  const letaEfterUppdatering = () => {
    if (document.visibilityState !== 'visible') return;
    sistaKollen = Date.now();
    swRegistration?.update?.().catch(() => {});   // offline är inget fel
  };

  setInterval(letaEfterUppdatering, LETA_INTERVALL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Inte vid varje flikbyte — då skulle den fråga i onödan hela dagen.
    if (Date.now() - sistaKollen < 5 * 60 * 1000) return;
    letaEfterUppdatering();
  });
}

/**
 * Ny version: visa den på kartan, inte i inställningarna.
 *
 * Ingen letar i en meny efter en uppdatering de inte vet finns. Bannern
 * ligger överst på startsidan med en knapp som gör hela jobbet.
 *
 * Automatiken finns kvar under: står bilen still och inget pågår laddar appen
 * om av sig själv efter en stund. Kör man däremot får bannern ligga kvar tills
 * man stannar — en omladdning mitt i en körning tystar varningarna i några
 * sekunder, och det är precis då de behövs.
 */
function showUpdateBanner() {
  const el = $('updateBanner');
  if (!el || el.dataset.dismissed === '1') return;
  el.hidden = false;
  const driving = (geo.position?.speedKmh ?? 0) > 5;
  $('ubNote').textContent = driving
    ? 'Uppdateringen väntar tills du stannat. Tryck om du vill göra det nu.'
    : 'Tryck för att uppdatera. Tar ett par sekunder.';
}

function applyUpdateWhenSafe() {
  if (!pendingUpdate) return;
  showUpdateBanner();

  const speed = geo.position?.speedKmh ?? 0;
  const busy = speaker.speaking || !$('alertBanner').hidden || dashcam.recording;

  if (speed > 5 || busy) {
    setTimeout(applyUpdateWhenSafe, 20000);   // vänta ut körningen
    return;
  }
  pendingUpdate = false;
  toast('Ny version installerad. Startar om appen…', 2500);
  setTimeout(() => location.reload(), 1200);
}

/* ================= "Sedan sist" =================
 *
 * En rad högst upp som säger vad som hänt medan appen var stängd, och
 * försvinner när man tittat.
 *
 * Skälet den finns: rapporterna hamnar på kartan och i listan, men den som
 * öppnar appen ser inte SKILLNADEN mot förra gången. Man måste leta, och den
 * som måste leta slutar leta. Varningsbannern hjälper inte här — den bygger
 * på närhet och tystnar om faran är fem kilometer bort, vilket den oftast är
 * när man just låst upp telefonen hemma.
 *
 * TVÅ FÄLLOR SOM AVGJORDE HUR DEN RÄKNAR:
 *
 * 1. "Sedan sist" måste betyda sedan du SÅG, inte sedan appen startade.
 *    Räknar man från appstart nollställs den av varje omladdning — och appen
 *    laddar om sig själv vid varje ny version. Tidpunkten sparas därför i
 *    lagringen och överlever både omladdning och att telefonen stängs av.
 *
 * 2. Räkna på när rapporten SKAPADES, inte när vi hämtade den. Hämtningen
 *    säger bara när vår telefon råkade fråga; två förare hade fått olika
 *    svar på samma fråga. createdAt är samma för alla.
 *
 * Egna rapporter räknas inte. Man behöver inte påminnas om det man själv
 * nyss skrev in.
 */
const SEDAN_SIST_NYCKEL = 'pv.sedanSist.v1';
const SEDAN_SIST_TAK_MS = 24 * 60 * 60 * 1000;   // "dagens rapporter", inte veckans

function sedanSistLast() {
  const n = Number(localStorage.getItem(SEDAN_SIST_NYCKEL));
  // Första gången: räkna från nu, inte från 1970. Annars möts en ny användare
  // av "47 nya rapporter", vilket varken är sant eller användbart.
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  // Har telefonen legat i en låda i en vecka är "sedan sist" inte intressant
  // längre. Ett dygn är det längsta som fortfarande betyder något för någon
  // som ska köra bil idag.
  return Math.max(n, Date.now() - SEDAN_SIST_TAK_MS);
}

function sedanSistSpara(t = Date.now()) {
  try { localStorage.setItem(SEDAN_SIST_NYCKEL, String(t)); } catch {}
}

/**
 * De rapporter som kommit in sedan man tittade sist, nyast först.
 *
 * SPÄRREN FRÅGAS HÄR OCKSÅ. Bannern läste förut store.active() rått och
 * filtrerade bara på fixed, createdAt och arMin — den frågade aldrig
 * farBeskrivas(). Alla andra vägar fram till en människa gör det
 * (js/varningsyta.js, notisOverallt, dagensRapporter, js/sammanfattning.js),
 * och en ny väg ska bära spärren själv i stället för att lita på att någon
 * uppströms gjorde det.
 *
 * MÄTT: en rad med etiketten "Nykterhetskontroll Skultuna" ger
 * farBeskrivas() === false och sammanfattaKort() === "". Bannern släppte ändå
 * igenom den, och var den nyast blev resultatet kontrollikonen i #nyaIkon,
 * rubriken "1 ny rapport sedan sist" och en tom undertext — en varning om en
 * nykterhetskontroll, utan ord men med ikon, tidpunkt och en Visa-knapp.
 * Fönstret var dessutom 45-60 minuter och är nu 240, alltså fem gånger så stor
 * chans att en spärrad rad hamnar i räkningen.
 */
function nyaSedanSist() {
  const sedan = sedanSistLast();
  return store.active()
    .filter(h => !h.fixed                       // fasta kameror är aldrig nyheter
              && Number(h.createdAt) > sedan
              && !arMin(h))                     // inte det man själv rapporterat
    .filter(farBeskrivas)                       // nykterhetsspärren, samma som app.js:829
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
}

function renderSedanSist() {
  const el = $('nyaBanner');
  if (!el) return;
  if (el.dataset.stangd === '1') { el.hidden = true; return; }

  const nya = nyaSedanSist();
  if (!nya.length) { el.hidden = true; return; }

  const senaste = nya[0];
  $('nyaIkon').textContent = TYPE_ICON[senaste.type] || '⚠️';
  $('nyaRubrik').textContent = nya.length === 1
    ? '1 ny rapport sedan sist'
    : `${nya.length} nya rapporter sedan sist`;
  // Den senaste i klartext. En siffra ensam säger inte om det är värt att
  // titta; en mening gör det.
  $('nyaNot').textContent = sammanfattaKort(senaste);
  el.hidden = false;
}

function wireSedanSist() {
  const el = $('nyaBanner');
  if (!el) return;

  const kvittera = () => {
    sedanSistSpara();
    el.dataset.stangd = '1';
    el.hidden = true;
  };

  $('nyaVisa').onclick = () => {
    kvittera();
    showView('map');
    // Öppna listan så man ser allihop, inte bara den översta.
    $('sheet')?.classList.add('open');
    renderHazards();
  };
  $('nyaStang').onclick = kvittera;

  store.addEventListener('change', renderSedanSist);

  /*
   * Räkna om när appen kommer tillbaka i förgrunden.
   *
   * Det är då man faktiskt tittar, och det är hela poängen med funktionen:
   * du låser upp mobilen, går in, och ser direkt vad som hänt. Utan den här
   * raden hade bannern bara ritats vid start, och en app som legat öppen i
   * bakgrunden hela dagen hade aldrig sagt något.
   *
   * Stängd-flaggan nollställs här: nästa gång du kommer tillbaka är det en ny
   * gång, och det du redan kvitterat räknas inte igen eftersom tidpunkten
   * flyttades fram när du kvitterade.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    delete el.dataset.stangd;
    renderSedanSist();
  });

  renderSedanSist();
}

/* ================= Uppläsning vid inkommande rapport =================
 *
 * Kommer en varning in från servern medan appen är öppen ska den HÖRAS, inte
 * bara dyka upp i listan. Bannern "3 nya rapporter sedan sist" är tyst med
 * flit — den är byggd för den som tittar. Den som kör tittar inte.
 *
 * Varningsmotorn i alerts.js täcker inte det här. Den hänger på GPS-fixar och
 * kräver att bilen rullar (fem km/h för polis, femton för kamera), vilket är
 * rätt för "du närmar dig något" men fel för "något har hänt". Står bilen
 * still i en rondell, vid en rödljuskö eller på en rastplats säger motorn
 * ingenting, hur nära polisen än står.
 *
 * VAD SOM INTE GÅR, OCH SOM INGEN SKA FÖRSÖKA IGEN OM ETT HALVÅR:
 * En webbpush kan inte bära ett eget ljud. Notification-API:ts sound-fält är
 * dött i alla webbläsare som räknas, och service workern kan bara skicka
 * titel, text, ikon, badge, tagg och data vidare till systemet. Ljudet för en
 * push med STÄNGD app är telefonens systemljud, punkt. Det vi äger fullt ut
 * är ljudet när appen är ÖPPEN — och det är exakt det den här filen gör.
 */

/*
 * Bursten samlas ihop innan något sägs.
 *
 * En pollning kan skriva in flera rapporter, och store sänder 'change' en
 * gång per omgång — men två omgångar kan komma tätt (hämtning plus en egen
 * skrivning som slår igenom). Ett och ett halvt sekunders fördröjning kostar
 * ingenting för föraren och gör skillnaden mellan en mening och fyra pling.
 */
const INKOMMANDE_SAMLA_MS = 1500;

/*
 * Åldersgränsen: halva livslängden för sin typ.
 *
 * Talet är inte valt fritt. sammanfattning.js aktualitet() byter ton exakt
 * där: under 0,5 heter det "Den kan ha hunnit flytta på sig", över 0,5 blir
 * det "Så gammal att den troligen inte står kvar". Att läsa upp något som
 * appen i samma andetag kallar borta är precis det brus som lär föraren att
 * ignorera nästa uppläsning — den som gällde.
 *
 * Gränsen uttrycks som ANDEL av TTL_MINUTES, inte som ett fast antal minuter.
 * En fast kvart hade gjort en civil polisbil (livslängd 30 min) notisvärd
 * halva sitt liv och en trafikkontroll (60 min) bara en fjärdedel. Ett tal på
 * ett ställe, i store.js, är hela poängen.
 */
const INKOMMANDE_MAX_ANDEL = 0.5;

/*
 * Taket ovanpå andelen, i minuter.
 *
 * Andelen ensam räcker inte, och kameran är hela skälet. TTL_MINUTES.camera är
 * ett år — en användartillagd kamera lever tills någon tar bort den — så halva
 * livslängden blir ett halvår. En kamerarapport från i vintras hade alltså
 * kunnat läsas upp som en nyhet första gången den dyker upp i listan, till
 * exempel när föraren slår PÅ kamera under "Vad du vill höra" mitt under
 * körningen, eller när täckningsfiltret släpper in ett nytt län.
 *
 * TTL och notisvärdhet svarar på olika frågor. TTL svarar på "står den kvar?",
 * och för en fast kamera är svaret ja i ett år. Grinden här svarar på "är det
 * här en NYHET?", och det är ingenting efter en halvtimme, oavsett typ.
 *
 * Taket räknas ur de rörliga typerna i stället för att skrivas som en siffra,
 * så att det följer med när någon justerar dem i store.js. Det är samma tal
 * och samma resonemang som fbmejl_ttl_tak_minuter() på serversidan (se
 * supabase/migrationer/2026-08-22-aldersgrind-for-notiser.sql) — server och app
 * ska inte kunna svara olika på samma rapport.
 */
const INKOMMANDE_TTL_TAK = Math.max(
  TTL_MINUTES.police ?? 45,
  TTL_MINUTES.control ?? 60,
  TTL_MINUTES.unmarked ?? 30,
);

/*
 * Samma tolerans som sammanfattning.js har för stämplar som ligger framåt i
 * tiden. En telefon med fel klocka ska inte kunna skicka något som låter
 * färskt för alltid, men två minuters skev klocka ska inte tysta en riktig
 * rapport heller.
 */
const INKOMMANDE_FRAMTID_MS = 2 * 60000;

/*
 * Taket på minnet av vad som redan lästs upp. Ett dygns hårt trafikerat flöde
 * ryms väl inom det; vid taket byggs minnet om från det som faktiskt finns
 * kvar i flödet (se inkommandeStadaMinnet).
 */
const INKOMMANDE_MINNE_TAK = 500;

const inkommandeSedda = new Set();     // id:n vi redan tagit ställning till
const inkommandeKo = new Map();        // id -> { h, talat, avstand }, väntar på att sägas
let inkommandeOmgangar = 0;
let inkommandeTimer = null;

/*
 * Är utgångsläget bokfört?
 *
 * DET HÄR ERSATTE EN RÄKNARE, OCH SKÄLET ÄR MÄTT.
 *
 * Förr löd regeln "de två första omgångarna är tysta". Vilken genomgång som
 * blev nummer två avgjordes då av en kapplöpning i boot(): store.start() på
 * rad 328 drar igång en refresh som ingen inväntar, sedan ligger
 * await billing.sync() emellan, och först därefter kopplas lyssnaren på i
 * wireInkommandeUpplasning(). Vann serverhämtningen loppet var hela trakten
 * redan bokförd i omgång 1 — och omgång 2 blev en LEVANDE pollning trettio
 * sekunder senare. Mätt: tjugo genuint nya, färska polisrapporter som anlände
 * i omgång 2 gav noll pling och noll yttringar, och enda spåret var en rad
 * som påstod att de "fanns redan när appen öppnades". De kom efter.
 *
 * Frågan ställs därför om DATAN i stället för om räknaren: utgångsläget är
 * bokfört när servern svarat en gång. Då är det som ligger i flödet per
 * definition det appen HITTADE när den vaknade, aldrig en levande pollning.
 *
 * Andra ledet i villkoret finns för lokalt läge och för en telefon utan
 * täckning: svarar servern aldrig får utgångsläget inte gälla för evigt,
 * för då blir spåret aldrig detaljerat igen.
 */
let inkommandeUtgangslagetBokfort = false;

/*
 * Id:n vi redan skrivit en spårrad för i klassen "kvaliteten tystade den".
 *
 * Det här är INTE en spärr. Den finns bara för att spåret inte ska fyllas med
 * samma rad var trettionde sekund så länge rapporten ligger kvar i flödet.
 * Skulle samma rapport senare få stöd av en andra rapportör och därmed lyftas
 * över kvalitetströskeln går den den vanliga vägen — dess id ligger inte i
 * inkommandeSedda, och därför räknas den då som ny. Att bokföra den som
 * "sedd" här hade tystat den för alltid, vilket är exakt den sortens fälla
 * det här spåret finns för att upptäcka.
 */
const inkommandeTystade = new Set();

/* ---------------- Spåret: varför var den tyst? ------------------------
 *
 * DET HÄR ÄR HALVA FIXEN, INTE EN LOGGRAD.
 *
 * Felet den 23 augusti 2026 kunde ligga kvar i drift därför att ingenting
 * någonstans sa att tre rapporter kom in och INTE lästes upp. Appen betedde
 * sig precis likadant som en app utan rapporter: tyst. Det gick alltså inte
 * att skilja "inget hände" från "något hände och tolv grindar teg om varför",
 * och den enda vägen till svaret var en brytpunkt i en telefon som redan
 * hunnit vidare.
 *
 * Därför bokförs VARJE beslut den här kedjan tar — både det som sades och
 * det som inte sades — med en orsakskod och en mening på svenska. Spåret
 * ligger i localStorage och överlever en omladdning, syns i Inställningar
 * och går att läsa utifrån med polisvakt.inkommande.sparText().
 *
 * NYKTERHETSREGELN GÄLLER SPÅRET OCKSÅ. En rad i spåret är en rad någon
 * läser, alltså samma sak som att rapportera. Därför tvättas plats och text
 * bort ur raden så fort rapporten inte får beskrivas — koden står kvar så att
 * det syns ATT något stoppades, men aldrig VAD.
 */

const INKOMMANDE_SPAR_TAK = 60;
const INKOMMANDE_SPAR_NYCKEL = 'pv.inkommande.spar.v1';

/*
 * Hur många rader av samma tråkiga sort en enda omgång får skriva.
 *
 * Ett spår som svämmar över är lika oläsbart som inget spår alls. Beslutet om
 * en enskild rapport som SADES eller som tystades av en GRIND skrivs alltid —
 * det är dem man letar efter. Massan kapas här och redovisas som en siffra.
 *
 * TAKET GÄLLDE LÄNGE BARA HÄLFTEN AV MASSAN, och ringbufferten är bara 60
 * rader. Mätt: en burst med tjugo rapporter gav tjugo rader (en uppläst,
 * nitton "raknad-i-bursten"); hade föraren tryckt "Tyst i 15 minuter" gav
 * samma tjugo rapporter tjugo identiska "foraren-tystade". Tre sådana
 * omgångar i rad räckte för att fylla hela bufferten med utfyllnad och radera
 * allt äldre — alltså slogs spåret ut i precis det läge det byggdes för:
 * "det kom in massor och jag hörde ingenting". Därför går alla fyra
 * massorsakerna genom sparKapare nu.
 */
const INKOMMANDE_SPAR_PER_OMGANG = 5;

/**
 * Skriver högst INKOMMANDE_SPAR_PER_OMGANG rader av en och samma orsak och
 * sammanfattar resten som en siffra.
 *
 * Skapas per omgång — burst, synk, genomgång — så att taket gäller omgången
 * och inte appens livstid.
 *
 * @param {'sagd'|'raknad'|'tyst'} beslut
 * @param {string} orsak
 */
function sparKapare(beslut, orsak) {
  let skrivna = 0, kapade = 0;
  return {
    skriv(h, varfor, extra) {
      if (skrivna < INKOMMANDE_SPAR_PER_OMGANG) {
        sparaInkommande(h, beslut, orsak, varfor, extra);
        skrivna++;
      } else {
        kapade++;
      }
    },
    /** Skriv sammanfattningsraden. Returnerar hur många det gällde totalt. */
    klar() {
      if (kapade) {
        sparaInkommande(null, beslut, orsak,
          `Och ${kapade} till i samma omgång, av samma skäl.`);
      }
      return skrivna + kapade;
    },
  };
}

/** Klartext för orsakskoderna. Samma ordlista i gränssnitt och konsol. */
const INKOMMANDE_BESLUT_ETIKETT = {
  sagd: 'Läst upp',
  raknad: 'Räknad',
  tyst: 'Tyst',
};

let inkommandeSpar = (() => {
  const rader = readJSON(INKOMMANDE_SPAR_NYCKEL, []);
  return Array.isArray(rader) ? rader.slice(-INKOMMANDE_SPAR_TAK) : [];
})();

/**
 * Skriv en rad i spåret.
 *
 * @param {Object|null} h        faran beslutet gällde, eller null för en rad
 *                               som handlar om omgången i stort
 * @param {'sagd'|'raknad'|'tyst'} beslut
 * @param {string} orsak         kort kod, stabil nog att söka på
 * @param {string} varfor        en mening som svarar på frågan
 * @param {Object} [extra]       fält som bara vissa orsaker har
 */
function sparaInkommande(h, beslut, orsak, varfor, extra = {}) {
  const b = h?.bedomning || null;

  /*
   * Får rapporten inte beskrivas får den inte heller stå i spåret med namn.
   * Se modulkommentaren ovan: en spårrad är något en människa läser.
   *
   * Flaggan räknas med i frågan, inte bara texten. En nykterhetskontroll som
   * parsern flaggat men vars text är för kort för isSobrietyCheck hade annars
   * fått ordet "nykterhetskontroll" utskrivet i flaggkolumnen — alltså läckt
   * genom precis det fält som fanns för att stoppa den.
   */
  const flaggad = Array.isArray(b?.flaggor) && b.flaggor.includes('nykterhetskontroll');
  const oppen = !h || (farBeskrivas(h) && !flaggad);
  const plats = oppen && typeof h?.label === 'string' ? h.label : '';

  const post = {
    tid: Date.now(),
    id: h?.id ?? null,
    typ: oppen ? (h?.type ?? null) : null,
    plats,
    kalla: h?.source ?? null,
    beslut,
    orsak,
    varfor: oppen ? varfor : 'Rapporten får inte beskrivas. Inget mer sparas om den.',
    poang: b?.poang ?? null,
    niva: b?.niva ?? null,
    behandling: b?.behandling ?? null,
    osakerhetM: b?.osakerhetM ?? null,
    flaggor: oppen && Array.isArray(b?.flaggor) ? [...b.flaggor] : [],
    omgang: inkommandeOmgangar,
    ...extra,
  };

  inkommandeSpar.push(post);
  if (inkommandeSpar.length > INKOMMANDE_SPAR_TAK) {
    inkommandeSpar.splice(0, inkommandeSpar.length - INKOMMANDE_SPAR_TAK);
  }
  writeJSON(INKOMMANDE_SPAR_NYCKEL, inkommandeSpar);

  // Konsolen är kvar vid sidan av rutan: den som felsöker på en telefon via
  // USB ser raden i samma sekund den skrivs, utan att behöva byta vy.
  console.info(`[inkommande] ${beslut} · ${orsak} · ${post.plats || post.id || '—'} — ${post.varfor}`);

  renderInkommandeSpar();
  return post;
}

/** Spåret som läsbara rader. polisvakt.inkommande.sparText() i konsolen. */
function inkommandeSparText() {
  if (!inkommandeSpar.length) return 'Inget inkommande har bedömts än.';
  return inkommandeSpar.map(p => {
    const tid = new Date(p.tid).toLocaleTimeString('sv-SE');
    const grad = p.poang != null ? ` [${p.niva} ${p.poang}` +
      (p.osakerhetM != null ? ` ±${p.osakerhetM} m` : '') +
      (p.flaggor?.length ? ` ${p.flaggor.join(',')}` : '') + ']' : '';
    return `${tid}  ${p.beslut.padEnd(6)} ${p.orsak.padEnd(22)} ` +
           `${p.plats || p.id || '—'}${grad}\n${' '.repeat(10)}${p.varfor}`;
  }).join('\n');
}

/**
 * Rutan i Inställningar.
 *
 * Den finns för föraren, inte bara för den som felsöker. Frågan "varför sa
 * den ingenting?" ställs av den som satt i bilen, och svaret ska gå att läsa
 * där appen är — inte i en utvecklarkonsol på en dator.
 */
function renderInkommandeSpar() {
  const el = $('inkommandeSpar');
  if (!el) return;

  if (!inkommandeSpar.length) {
    el.innerHTML = '<p class="hint">Inget har kommit in medan appen varit öppen än.</p>';
    return;
  }

  el.innerHTML = [...inkommandeSpar].reverse().slice(0, 12).map(p => {
    const tid = new Date(p.tid).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    // Ett avhugget id säger ingenting till den som läser. Saknas plats — och
    // det gör den för allt som inte får beskrivas — räcker "En rapport".
    const rubrik = p.plats || (p.typ && TYPE_LABEL[p.typ]) || (p.id ? 'En rapport' : 'Omgången');
    const etikett = INKOMMANDE_BESLUT_ETIKETT[p.beslut] || p.beslut;
    return `<div class="row"><span>${escapeHtml(tid)} · ${escapeHtml(rubrik)}</span>` +
           `<span>${escapeHtml(etikett)}</span></div>` +
           `<p class="hint">${escapeHtml(p.varfor)}</p>`;
  }).join('');
}

/**
 * Är rapporten färsk nog att läsas upp?
 *
 * Okänd eller orimlig tidsstämpel är ett nej. Vi kan inte avgöra om den är
 * från nyss eller från i förrgår, och en gissning åt fel håll är exakt det
 * fel den här grinden finns för att inte göra. Den syns fortfarande på kartan
 * och i listan — det är bara högtalaren som håller tyst.
 */
function inkommandeArFarsk(h, nu = Date.now()) {
  const t = Number(h?.createdAt);
  if (!Number.isFinite(t) || t <= 0) return false;
  if (t - nu > INKOMMANDE_FRAMTID_MS) return false;

  // Kapad TTL: se INKOMMANDE_TTL_TAK. En kamera med ett års livslängd får
  // samma notisfönster som en trafikkontroll, alltså under en halvtimme.
  const ttl = Math.min(TTL_MINUTES[h.type] ?? 45, INKOMMANDE_TTL_TAK);
  if (!(ttl > 0)) return false;
  const minuter = Math.max(0, (nu - t) / 60000);
  return minuter < ttl * INKOMMANDE_MAX_ANDEL;
}

/**
 * Fick kvalitetsgraderingen ensam tysta rapporten?
 *
 * DET HÄR ÄR FELET SOM LAGADES DEN 23 AUGUSTI 2026.
 *
 * Tre rapporter från Facebook-gruppen nådde appen, hamnade i lagringen, ritades
 * på kartan — och sades aldrig. Skälet var inte uppläsningen, inte ljudet och
 * inte rösten. Kedjan såg ut så här:
 *
 *   kvalitet.js gav en ensam Facebook-rapport utan geokod-fält 0,37 av 1.
 *   Under gransHedga 0,48 blir det NIVA.LAG, som blir BEHANDLING.TYST.
 *   notiser.js översätter TYST till "får synas, får inte höras".
 *   allHazards({ forAlerts: true }) lämnade därmed tillbaka en lista som
 *   rapporten aldrig fanns i, och den här filen loopade över en lista som
 *   redan var tömd på det den letade efter.
 *
 * Poängen 0,37 är inte ett räknefel. Den är korrekt: ursprung facebook +0,42,
 * geokod okänd −0,15, ingen som bekräftat, färsk +0,05. En ensam rapport från
 * ett gruppinlägg vars position vi inte vet hur den togs fram KAN inte nå
 * 0,48 på egen hand. Att skruva på trösklarna eller att gissa en bättre
 * geokod åt rapporten hade varit att ljuga om hur säker appen är.
 *
 * DÄRFÖR SKILJS DE TVÅ TALHANDLINGARNA ÅT I STÄLLET:
 *
 *   Varningsmotorn säger AVSTÅND: "Polis om 300 meter." Det påståendet kräver
 *   att punkten går att lita på. En rapport med drygt en kilometers
 *   positionsosäkerhet kan trigga var som helst inom varningsradien, och då
 *   säger varningen inte längre var — bara att. TYST är rätt svar där, och
 *   den grinden rörs inte.
 *
 *   Den här vägen säger NYHET, med NAMN och utan avstånd: "Polis vid Halla.
 *   Någon i Facebook-gruppen varnade för en minut sedan. Rapporten är färsk.
 *   Ingen annan har bekräftat den än." Varenda osäkerhet står med i meningen.
 *   Det är inte ett anspråk på att veta var patrullen står — det är ett
 *   referat av vad någon skrivit, och att hålla tyst om det är att inte vara
 *   appen.
 *
 * TRE SAKER FÅR ALDRIG LYFTAS, OCH GÖR DET INTE HELLER:
 *
 *   1. UNDANHALL. Den kommer aldrig ens hit — allHazards() filtrerar bort den
 *      före uppdelningen. Villkoret nedan kräver dessutom TYST uttryckligen.
 *
 *   2. platskonvention. Ett inlägg som bara är ett platsnamn ("Bäckby") tolkas
 *      som polis genom gruppens konvention, men ingen har skrivit VAD som står
 *      där. Står ordet nykterhetskontroll i bilden eller i kommentarerna finns
 *      det ingenting för isSobrietyCheck att gå på, och en uppläsning hade
 *      brutit den enda regel i det här projektet som aldrig får brytas. Taket
 *      i kvalitet.js sattes för det, och det står kvar orört.
 *
 *      FRÅGAN STÄLLS TILL PREDIKATET, INTE TILL FLAGGAN. Mätt den 23 augusti
 *      2026: en gruppost som bara var ordet "Bäckby", utan geokod-fält, fick
 *      poäng 0,32 och var alltså LAG redan innan taket prövades. Flaggpushen
 *      i kvalitet.js låg då inne i niva-villkoret och kördes aldrig, så
 *      rapporten kom hit med flaggor ['osaker-plats'] — och lyftet, som bara
 *      läste flaggan, släppte den till högtalaren. Flaggan fanns bara på det
 *      som var för BRA för att tystas av sig självt; frågan ställdes om det
 *      som var för dåligt. Nu körs Kvalitet.arPlatskonvention() i stället, och
 *      flaggan är kvar som bälte vid sidan av hängslet.
 *
 *   3. Produktreglerna och förarens egna notisval. Frågan ställs om via
 *      Notiser.skaAnnonseras med ENDAST kvalitetstaket neutraliserat. Allt
 *      annat i notiser.js svarar likadant som förut: nykterhet är fortfarande
 *      av, en handmarkerad fartkamera är fortfarande av, och det föraren
 *      ställt på "bara kartan" stannar på kartan.
 */
function inkommandeKvalitetslyft(h) {
  const b = h?.bedomning;
  if (!b) return false;                                   // ograderad låg redan i forRost
  if (b.behandling !== Kvalitet.BEHANDLING.TYST) return false;

  const flaggor = Array.isArray(b.flaggor) ? b.flaggor : [];
  if (flaggor.includes('platskonvention')) return false;
  if (flaggor.includes('nykterhetskontroll')) return false;

  /*
   * Samma fråga en gång till, ställd till regeln i stället för till flaggan.
   * Se punkt 2 ovan: flaggan saknas på precis de rapporter den skulle märka,
   * så raden ovanför är en nolloperation för dem. Den här raden är den som
   * faktiskt håller — och den kan inte glida isär från kvalitet.js, för det
   * är kvalitet.js egen funktion som körs.
   */
  if (Kvalitet.arPlatskonvention(h)) return false;

  /*
   * Bedömningen behålls i sin helhet och bara behandlingen byts ut. Att
   * skicka in rapporten helt utan bedomning hade sett enklare ut, men då
   * försvinner också nykterhetsflaggan som notiser.js läser — alltså hade
   * genvägen tagit bort en av spärrarna i samma rörelse som den lyfte taket.
   */
  const utanKvalitetstak = { ...h, bedomning: { ...b, behandling: Kvalitet.BEHANDLING.HEDGA } };
  return Notiser.skaAnnonseras(utanKvalitetstak, settings);
}

/**
 * Flödet den inkommande uppläsningen arbetar på.
 *
 * @returns {{lista: Array, lyfta: Set<string>, tystade: Array, undanhallna: Array}}
 *   lista        det som får sägas: röstflödet plus de kvalitetstystade som
 *                lyfts enligt inkommandeKvalitetslyft
 *   lyfta        id:n som kom in via lyftet, så spåret kan säga det högt
 *   tystade      det som stannade på kartan, för spårets skull och inget annat
 *   undanhallna  det graderingen kastade ut helt, likaså bara för spåret
 */
function inkommandeFlode() {
  const { forRost, forKarta, undanhallna } = graderadeFaror();
  const rostIds = new Set(forRost.map(h => h.id));

  const lyfta = new Set();
  const tystade = [];
  const lista = [...forRost];

  for (const h of forKarta) {
    if (rostIds.has(h.id)) continue;
    if (inkommandeKvalitetslyft(h)) {
      lyfta.add(h.id);
      lista.push(h);
    } else {
      tystade.push(h);
    }
  }
  return { lista, lyfta, tystade, undanhallna: undanhallna || [] };
}

/**
 * Går igenom flödet, bokför vad som setts och plockar ut det som ska sägas.
 *
 * Flödet hämtas via inkommandeFlode() och inte ur store direkt. Det är
 * avgörande: den vägen har redan passerat produktreglerna (nykterhet finns
 * inte), täckningsfiltret och förarens egna notisinställningar. En rapport
 * som föraren ställt på "bara kartan" ska inte kunna smyga ut genom
 * högtalaren bara för att den kom in via en annan dörr. Ruttvakten får säga
 * sitt av samma skäl som motorn får det — den har redan claimat delar av
 * sträckan.
 *
 * Kvalitetsgraderingen är den enda av taken som får lyftas här, och bara på
 * de villkor som står i inkommandeKvalitetslyft.
 */
function inkommandeSok() {
  const fix = geo.position;
  const nu = Date.now();

  let lista, lyfta, tystade, undanhallna, ruttensKvar;
  try {
    ({ lista, lyfta, tystade, undanhallna } = inkommandeFlode());
    /*
     * Bokföringen går på hela flödet, urvalet på det ruttvakten lämnat kvar.
     *
     * Skillnaden spelar roll. filterHazards() döljer det som ligger bakom
     * eller vid sidan av rutten, och hade bokföringen gått på den kortare
     * listan hade allt dolt kommit tillbaka som "nytt" i samma sekund som
     * navigeringen avslutades — alltså en skur av uppläsningar när föraren
     * just parkerat.
     */
    ruttensKvar = new Set(routeGuide.filterHazards(lista).map(h => h.id));
  } catch (e) {
    // Uppläsningen får aldrig kunna välta en pollning. Kan vi inte bygga
    // listan säger vi ingenting den här omgången — men vi säger att vi inte
    // kunde, annars ser det ut som att inget kom in.
    sparaInkommande(null, 'tyst', 'listan-brast',
      `Flödet gick inte att bygga den här omgången: ${e?.message || e}`);
    return;
  }

  /*
   * Utgångsläget: det appen HITTAR när den vaknar.
   *
   * Se inkommandeUtgangslagetBokfort. Två saker skiljer det här från
   * räknaren det ersatte:
   *
   *   1. Det är en fråga om datan (har servern svarat?), inte om vilket varv
   *      vi råkar vara på — alltså finns kapplöpningen i boot() inte längre.
   *   2. Uppvärmningen SVÄLJER ingenting längre. Den dämpar bara spåret.
   *      Förr låg "if (uppvarmning) continue" före alla grindar, samtidigt
   *      som id:t redan bokförts som sett — en rapport som skrevs för trettio
   *      sekunder sedan och kom med i första hämtningen var därmed permanent
   *      tystad, utan att en enda grind ställt en fråga om den, och utan en
   *      spårrad som bar dess id. Nu avgör ÅLDERN: hela trakten vid start är
   *      per definition gammal och faller på inkommandeArFarsk, medan en
   *      rapport från en minut sedan går hela vägen fram och hörs.
   */
  const uppvarmning = !inkommandeUtgangslagetBokfort;
  let uppvarmda = 0;

  /*
   * Under utgångsläget dämpas de enskilda raderna till en siffra: hela
   * trakten ligger i flödet och en rad per rapport hade dränkt spåret i just
   * den omgång som aldrig är intressant. Beslutet i sig tas ändå, av samma
   * grind som annars.
   */
  const tystaMed = (h, orsak, varfor, extra) => {
    if (uppvarmning) { uppvarmda++; return; }
    sparaInkommande(h, 'tyst', orsak, varfor, extra);
  };

  // Taket på massraden. Grindarnas egna rader står okapade — det är dem man
  // letar efter — men "samma händelse igen" kan komma i fyrtiotal.
  const sammaSom = sparKapare('tyst', 'samma-som-redan-sedd');

  for (const h of lista) {
    // Faran bär klusterledarens id. Alla id:n i klustret måste bokföras,
    // annars räknas samma polis som ny igen så fort ledarskapet byter hand.
    const ids = [h.id, ...(h.klusterIds || [])].filter(Boolean);
    const redan = ids.find(id => inkommandeSedda.has(id));
    for (const id of ids) inkommandeSedda.add(id);

    if (redan) {
      /*
       * Rapporten är ny men händelsen är det inte.
       *
       * redan !== h.id betyder att just den här raden aldrig setts förut, men
       * att den slagits ihop med en rapport vi redan tagit ställning till.
       * Det är en andra person som rapporterar samma patrull, och att läsa upp
       * den igen vore att säga samma sak två gånger. Grinden är alltså rätt —
       * men den var osynlig, och det var den som tystade den tredje av de tre
       * rapporterna den 23 augusti. Nu står det i spåret i stället för att
       * behöva letas fram med en brytpunkt.
       *
       * Villkoret gör raden engångs: nästa omgång är h.id självt sett, och då
       * är redan === h.id.
       */
      if (redan !== h.id && !uppvarmning) {
        sammaSom.skriv(h,
          `Rapporten är ny, men den slogs ihop med ${redan} som appen redan tagit ` +
          'ställning till. Samma händelse, inte en ny.', { klustradMed: redan });
      } else if (redan !== h.id) {
        uppvarmda++;
      }
      continue;
    }

    if (h.fixed) {                               // fasta kameror händer inte
      tystaMed(h, 'fast-punkt',
        'Fast kamera. Den står där den stod och är ingen nyhet.');
      continue;
    }
    if (arMin(h)) {                              // det man själv nyss skrev in
      tystaMed(h, 'egen-rapport',
        'Du rapporterade den själv. Appen läser aldrig upp ditt eget knapptryck.');
      continue;
    }
    if (!inkommandeArFarsk(h, nu)) {             // gammalt är brus, inte varning
      const min = Number.isFinite(Number(h.createdAt))
        ? Math.round((nu - Number(h.createdAt)) / 60000) : null;
      const tak = Math.round(Math.min(TTL_MINUTES[h.type] ?? 45, INKOMMANDE_TTL_TAK)
                             * INKOMMANDE_MAX_ANDEL);
      /*
       * ÅLDERSGRINDEN ÄR DEN SOM BÄR UTGÅNGSLÄGET.
       *
       * Hela trakten som ligger i flödet när appen öppnas faller här, och det
       * är rätt skäl: den är gammal. En rapport som skrevs för en minut sedan
       * och råkade komma med i första hämtningen faller inte — och ska inte
       * göra det. Föraren som startar appen inomhus, utan GPS-fix, medan det
       * står polis där hen ska köra, ska höra det.
       */
      tystaMed(h, 'for-gammal',
        min == null
          ? 'Tidsstämpeln går inte att tolka, så åldern går inte att avgöra.'
          : `${min} minuter gammal. Gränsen för att räknas som en nyhet är ${tak} minuter.`);
      continue;
    }
    /*
     * Ruttvakten och motorn frågas BARA om faror de faktiskt kan säga.
     *
     * Båda matas med forRost (app.js rad 466 respektive haemtaFaror i
     * RouteGuide-konstruktorn). En kvalitetslyft rapport ligger per definition
     * inte där — den är TYST och kommer bara med via inkommandeFlode(). Att
     * ändå fråga dem är att låta någon annan lova något ingen tänker hålla:
     *
     *   MÄTT: Facebook-rapport 900 m bort, förare i 50 km/h med färsk fix.
     *   Lyftet fungerade (poäng 0,32, behandling tyst, lyft=true), men
     *   agerFaran svarade true på ren geometri trots att rapporten inte fanns
     *   i motorns lista. Resultat: total tystnad, och en spårrad som påstod
     *   att "varningsmotorn har redan varnat för den". Osant. För en förare
     *   som kör blev det raka motsatsen till avsikten: en lyft rapport LÅNGT
     *   bort lästes upp, en NÄRA tystades.
     *
     * Regel 1 — motorn HAR redan varnat — gäller fortfarande alla, och den
     * frågan ställs för sig via harVarnat().
     */
    const lyftDenna = lyfta.has(h.id);
    if (!lyftDenna && !ruttensKvar.has(h.id)) {  // ruttvakten har claimat den
      tystaMed(h, 'ruttvakten',
        'Ruttvakten har hand om den här — den ligger på din beräknade rutt och ' +
        'sägs där i stället, vid rätt tidpunkt.');
      continue;
    }
    if (lyftDenna ? engine.harVarnat(h, h.klusterIds)
                  : engine.agerFaran(h, fix, h.klusterIds)) {
      tystaMed(h, 'motorn-tar-den', lyftDenna
        ? 'Varningsmotorn har redan varnat för den. Två röster om samma polis ' +
          'är en för mycket.'
        : 'Varningsmotorn har redan varnat för den, eller är på väg att göra det. ' +
          'Två röster om samma polis är en för mycket.');
      continue;
    }

    /*
     * Tom sträng får aldrig bli en yttring. sammanfattaTal() svarar tomt för
     * det som inte får beskrivas — nykterhets- och drogkontroller — och för
     * rapporter som inte går att formulera alls. speaker.say() sväljer visst
     * tom text, men att förlita sig på det vore att lägga produktregeln i en
     * annan fil än den som bryter mot den.
     */
    const talat = sammanfattaTal(h, { egen: false });
    if (!talat) {
      tystaMed(h, 'far-inte-beskrivas',
        'Rapporten går inte att formulera i klartext.');
      continue;
    }

    inkommandeKo.set(h.id, {
      h, talat,
      avstand: fix ? haversineFix(fix, h) : Infinity,
      lyft: lyftDenna,
    });
  }
  sammaSom.klar();

  /*
   * Det som aldrig ens kom fram till grindarna ovanför.
   *
   * Två klasser, och båda var helt osynliga före den 23 augusti 2026:
   * kvaliteten satte rapporten på kartnivå (och lyftet gällde inte den), eller
   * kvaliteten kastade ut den helt. En rapport som försvinner utan ett ord
   * ser likadan ut som en rapport som aldrig kom, och då går felet inte att
   * hitta annat än med en brytpunkt i en telefon som redan kört vidare.
   *
   * Raderna spärrar ingenting — se inkommandeTystade.
   */
  const bokforTyst = (faror, orsak, text) => {
    // En synk som drar in fyrtio gamla rader får inte trycka ut de rader
    // någon faktiskt letar efter. Fem räcker för att se mönstret, resten blir
    // en siffra. Samma kapare som massorsakerna i inkommandeSag använder.
    const kapare = sparKapare('tyst', orsak);
    let n = 0;
    for (const h of faror || []) {
      if (!h?.id || inkommandeTystade.has(h.id)) continue;
      if (inkommandeSedda.has(h.id)) continue;      // redan avgjord någon annan väg
      inkommandeTystade.add(h.id);
      n++;
      // Under utgångsläget räknas de bara. Hela trakten ligger i flödet vid
      // start, och en rad per rapport hade dränkt spåret i just den omgång
      // som aldrig är intressant.
      if (uppvarmning) continue;
      kapare.skriv(h, text(h));
    }
    if (!uppvarmning) kapare.klar();
    return n;
  };

  const b2 = h => h.bedomning;
  const holls = bokforTyst(tystade, 'kvaliteten-holl-emot', h => {
    const b = b2(h);
    const flagg = Array.isArray(b?.flaggor) && b.flaggor.length
      ? ` Flaggor: ${b.flaggor.join(', ')}.` : '';
    return `Visas på kartan men läses inte upp. Kvalitetspoäng ${b?.poang ?? '?'} ` +
           `(${b?.niva ?? 'okänd'}), och lyftet gäller inte den här.${flagg}`;
  });
  const utkastade = bokforTyst(undanhallna, 'undanhallen', h => {
    const b = b2(h);
    const skal = b?.skal?.length ? ` ${b.skal.at(-1).varfor}` : '';
    return `Kvaliteten undanhöll rapporten helt — den visas inte ens på kartan. ` +
           `Poäng ${b?.poang ?? '?'}.${skal}`;
  });

  /*
   * Utgångsläget som EN rad, inte hundrafyrtio.
   *
   * Texten påstår inte längre NÄR rapporterna kom in — koden vet inte det.
   * Den gamla lydelsen ("fanns redan när appen öppnades") pekade åt fel håll
   * i precis det fall man felsökte: tjugo rapporter som anlände i omgång två
   * redovisades som om de legat där hela tiden.
   */
  if (uppvarmning && (uppvarmda || holls || utkastade)) {
    sparaInkommande(null, 'tyst', 'uppvarmning',
      `${uppvarmda + holls + utkastade} rapporter låg i flödet när utgångsläget ` +
      `bokfördes och tystades var för sig av sina vanliga grindar — nästan alla ` +
      `på åldern (${uppvarmda} i röstflödet, ${holls} bara på kartan, ` +
      `${utkastade} undanhållna). Bara spårraderna hölls tillbaka, inte besluten: ` +
      'är något i högen färskt nog att vara en nyhet läses det upp.');
  }

  inkommandeStadaMinnet(lista);

  if (inkommandeOmgangar < 2) inkommandeOmgangar++;

  /*
   * Utgångsläget är bokfört när servern svarat en gång.
   *
   * store.lastSync sätts först när en hämtning faktiskt lyckats, så den här
   * raden är oberoende av kapplöpningen mellan store.start() och
   * wireInkommandeUpplasning() i boot(): vilken genomgång som råkar vara
   * nummer ett spelar ingen roll, det är serverns svar som är utgångsläget.
   *
   * Andra ledet är för lokalt läge och för en telefon utan täckning. Utan det
   * hade spåret aldrig blivit detaljerat igen på en app som aldrig når nätet.
   */
  if (!inkommandeUtgangslagetBokfort &&
      (store.lastSync != null || inkommandeOmgangar >= 2)) {
    inkommandeUtgangslagetBokfort = true;
  }

  if (!inkommandeKo.size || inkommandeTimer) return;
  inkommandeTimer = setTimeout(inkommandeSag, INKOMMANDE_SAMLA_MS);
}

/**
 * Håller minnet litet.
 *
 * Minnet finns bara för att samma sak inte ska sägas två gånger. Det som
 * fallit ur flödet kan inte komma tillbaka som nytt utan att först passera
 * åldersgrinden, så vid taket räcker det med de id:n som fortfarande finns
 * kvar. En kö som växer hela dagen i en app som står på i tolv timmar är
 * inget minnesproblem i sig — men ett obegränsat Set är ett löfte man inte
 * behöver ge.
 */
function inkommandeStadaMinnet(lista) {
  // Spårminnet töms först och separat. Det är inte en spärr, så det kostar
  // ingenting att bygga om det — på sin höjd en extra spårrad.
  if (inkommandeTystade.size > INKOMMANDE_MINNE_TAK) inkommandeTystade.clear();

  if (inkommandeSedda.size <= INKOMMANDE_MINNE_TAK) return;
  inkommandeSedda.clear();
  for (const h of lista) {
    for (const id of [h.id, ...(h.klusterIds || [])]) if (id) inkommandeSedda.add(id);
  }
  for (const id of inkommandeKo.keys()) inkommandeSedda.add(id);
}

/**
 * Säger den närmaste och räknar resten.
 *
 * Tio rapporter i en synk blir en mening plus en siffra, aldrig tio
 * uppläsningar. Samma form som varningsmotorn använder när flera faror
 * triggar samtidigt, så att de två låter som samma app.
 */
function inkommandeSag() {
  inkommandeTimer = null;
  const raposter = [...inkommandeKo.values()];
  inkommandeKo.clear();
  if (!raposter.length) return;

  /*
   * GRINDARNA KÖRS OM, HÄR, MOT EN FÄRSK FIX.
   *
   * Frågan "tar varningsmotorn den här?" ställdes vid inläggningen i kön, och
   * mellan den och det här ögonblicket ligger INKOMMANDE_SAMLA_MS. På ett och
   * ett halvt sekund hinner världen ändras: AlertEngine körs på VARJE GPS-fix
   * och ruttvakten claimar löpande.
   *
   * De 380 ms som ligger mellan beslutet och say() täcks INTE av en omkörning
   * — där hjälper ingen kontroll, för motorn kan fyra mitt i glappet. Det
   * fönstret stängs i stället genom att avbockningen skrivs till motorn
   * omedelbart efter att beslutet tagits, se engine.annanSade() nedan. En
   * sista kontroll ligger ändå i setTimeout-callbacken, för ruttvakten
   * claimar utan att fråga någon.
   *
   * Fallet som gjorde det här nödvändigt: bilen står i en rödljuskö, farten är
   * noll, en polisrapport 800 m bort kommer in. agerFaran svarar nej — motorn
   * är tyst med flit när bilen står still — så rapporten hamnar i kön. Grönt
   * ljus, nästa fix säger 6 km/h, motorn triggar och säger "Varning. Polis vid
   * …". En halv sekund senare säger den här vägen exakt samma polis igen.
   * Samma sak när geo.position var null vid inläggningen och första fixen
   * kommer inom ett och ett halvt sekund.
   *
   * Att i stället förlänga spärren i motorn valdes bort: motorn får inte
   * bokföra en fara den inte varnat för (se agerFaran i alerts.js). Den som
   * kör sist ska vara den som avgör, och det är den här funktionen.
   *
   * Grinden vid inläggningen är kvar som billig förfiltrering — den håller kön
   * liten — men den avgör ingenting längre.
   */
  const nu = Date.now();
  const fix = geo.position;
  const poster = [];
  for (const p of raposter) {
    if (arMin(p.h)) {
      sparaInkommande(p.h, 'tyst', 'egen-rapport',
        'Visade sig vara din egen rapport när den skulle sägas.');
      continue;
    }
    if (!inkommandeArFarsk(p.h, nu)) {                      // hann bli gammalt i kön
      sparaInkommande(p.h, 'tyst', 'for-gammal',
        'Hann passera åldersgränsen medan bursten samlades ihop.');
      continue;
    }
    // Samma åtskillnad som i inkommandeSok: en lyft rapport ligger varken i
    // ruttvaktens eller i motorns lista, så de två kan inte lova att säga
    // den. Bara frågan "HAR motorn redan varnat?" är meningsfull för dem.
    if (!p.lyft && routeGuide.isClaimed(p.h.id)) {          // ruttvakten hann claima
      sparaInkommande(p.h, 'tyst', 'ruttvakten',
        'Ruttvakten claimade den under den och en halv sekund kön samlades.');
      continue;
    }
    if (p.lyft ? engine.harVarnat(p.h, p.h.klusterIds)
               : engine.agerFaran(p.h, fix, p.h.klusterIds)) {
      sparaInkommande(p.h, 'tyst', 'motorn-tar-den',
        'Varningsmotorn hann varna för den under tiden kön samlades. ' +
        'Den sista som kör avgör, och det är den här vägen.');
      continue;
    }
    poster.push(p);
  }
  if (!poster.length) return;

  // Samma grind som varningsmotorn står bakom. Utan giltigt abonnemang är
  // hela varningssidan avstängd, och den här vägen ska inte vara en bakdörr
  // in i den.
  if (!billing.allowed) {
    // Kapad: tjugo rapporter i en burst gav förut tjugo identiska rader, och
    // tre sådana omgångar räckte för att radera hela ringbufferten.
    const kapare = sparKapare('tyst', 'abonnemang');
    for (const p of poster) {
      kapare.skriv(p.h,
        'Prenumerationen gäller inte, och då är hela varningssidan avstängd.');
    }
    kapare.klar();
    return;
  }

  /*
   * Tyst är tyst — även plinget.
   *
   * chime() i voice.js kollar varken enabled eller muted; det är medvetet
   * där, eftersom demoknappen ska låta även med uppläsningen avslagen. Här
   * gäller motsatsen: har föraren tryckt "Tyst i 15 minuter" eller slagit av
   * uppläsningen är ett pling ur ingenstans precis det hen bad om att slippa.
   */
  if (!speaker.enabled || speaker.muted) {
    const kapare = sparKapare('tyst', 'foraren-tystade');
    const varfor = speaker.muted
      ? 'Du tryckte "Tyst i 15 minuter". Ingen uppläsning, inget pling.'
      : 'Uppläsning av varningar är avslagen i Inställningar.';
    for (const p of poster) kapare.skriv(p.h, varfor);
    kapare.klar();
    return;
  }

  // Närmast först. Utan GPS är alla lika långt bort, då får den nyaste gå
  // först — det är den föraren senast hade kunnat påverkas av.
  poster.sort((a, b) => (a.avstand - b.avstand)
                     || (Number(b.h.createdAt || 0) - Number(a.h.createdAt || 0)));

  const forst = poster[0];

  /*
   * AVBOCKNINGEN SKRIVS FÖRST, FÖRE PLINGET.
   *
   * MÄTT FALL: rapport i röstflödet 900 m bort, bilen står still. agerFaran
   * svarar nej, den här vägen läser upp "Polis vid Skultuna…". Nästa fix
   * säger 20 km/h, motorn triggar och säger "Polis rapporterad vid Skultuna,
   * om 900 meter klockan 12." Två röster och två pling om samma patrull —
   * exakt det alerts.js själv kallar kriteriet: hör föraren samma polis två
   * gånger på tio sekunder slutar hen lyssna på båda.
   *
   * annanSade() är en UPPSKJUTNING i annanSadeMs, inte warnedAt. Motorn
   * glömmer den efteråt, så förbikörningsvarningen — den som betyder något —
   * kommer ändå, då när föraren verkligen är nära.
   *
   * Alla id:n i klustret skrivs, inte bara ledarens: motorn kan mycket väl
   * möta samma patrull under en annan medlems id.
   *
   * Att raden ligger FÖRE chime och say är hela poängen. Uppläsningen är
   * beslutad i och med den här punkten, och motorn får inte hinna fyra i de
   * 380 ms som ligger mellan plinget och rösten.
   */
  engine.annanSade(forst.h.id, forst.h.klusterIds);

  speaker.chime('alert');

  sparaInkommande(forst.h, 'sagd', forst.lyft ? 'uppläst-efter-lyft' : 'uppläst',
    forst.lyft
      ? `Läses upp fast kvaliteten satte den på kartnivå: "${forst.talat}"`
      : `Läses upp: "${forst.talat}"`,
    { talat: forst.talat, avstandM: Number.isFinite(forst.avstand) ? Math.round(forst.avstand) : null });

  // Kapad av samma skäl som massorsakerna ovan: en burst med tjugo rapporter
  // skrev förut nitton rader här och tryckte ut allt annat ur spåret.
  const raknade = sparKapare('raknad', 'raknad-i-bursten');
  for (const p of poster.slice(1)) {
    raknade.skriv(p.h,
      'Kom in i samma omgång och räknas i "ytterligare N rapporter". ' +
      'Tio uppläsningar i rad är brus, inte information.');
  }
  raknade.klar();

  /*
   * Prioritet 1 utan avbrott, och bara en gång.
   *
   * En inkommande rapport är information, inte en fara framför vindrutan.
   * Kön i voice.js sorterar på prioritet, så en skarp närhetsvarning (2) går
   * ändå före och får avbryta. Upprepningen som prioritet 1 normalt ger är
   * till för det man måste hinna uppfatta i vägbuller när man närmar sig
   * något — det här är inte det, och tjat är också brus.
   *
   * Fördröjningen på 380 ms är samma som i alerts.js: plinget ska hinna klart
   * innan rösten börjar, annars hörs varken det ena eller det andra.
   */
  setTimeout(() => {
    /*
     * Sista kontrollen, efter de 380 ms och inte före dem.
     *
     * Motorn kan inte ha hunnit tala — avbockningen skrevs innan plinget —
     * men ruttvakten frågar ingen om lov. Claimar den under glappet är det
     * den som säger det, med avstånd längs vägen, och då ska den här rösten
     * hålla tyst. Plinget har redan hörts, och det är rätt: något SKA sägas,
     * frågan är bara av vem.
     */
    if (!forst.lyft && routeGuide.isClaimed(forst.h.id)) {
      sparaInkommande(forst.h, 'tyst', 'ruttvakten',
        'Ruttvakten claimade den under de 380 millisekunderna mellan plinget ' +
        'och rösten. Den säger den i stället, med avstånd längs vägen.');
      /*
       * Tyst här, men INTE osynlig.
       *
       * Ruttvakten tar över rösten — den kan säga avståndet längs vägen, det
       * kan inte vi. Men ruttvakten ritar ingenting någonstans. Returnerade
       * vi rakt av vore resultatet en fara som hörs en gång och sedan inte
       * går att hitta i appen, vilket är samma hål vi håller på att täppa
       * till. Ytan visas alltså av oss, rösten kommer från vakten.
       */
      visaYtanOverallt(forst.h, { avstand: forst.avstand });
      notisOverallt(forst.h);
      return;
    }
    speaker.say(forst.talat, { priority: 1, ganger: 1 });

    /*
     * TREDJE STEGET: ytan, från exakt samma ställe som uppläsningen.
     *
     * Det här är raden som saknades. Den här vägen — inkommande rapport utan
     * geokod, den som ägaren mätte på version 88 — gjorde chime() och say()
     * och ritade INGENTING. Sexton oscillatorer och en yttring, och på
     * skärmen ingenting alls oavsett vy. Nu är ordningen komplett:
     * plinget ovanför, rösten på raden före, ytan här.
     *
     * Kopplad till say() och inte till kön eller till chime: det som sägs och
     * det som visas måste vara SAMMA rapport. Ritade vi vid plinget kunde
     * ruttvaktskontrollen ovanför hinna emellan och skärmen hade visat en
     * fara som rösten aldrig nämnde.
     *
     * Den närmaste först, så att den blir raden man läser överst — ytan
     * sorterar själv, men den som lades in först är också den som vibrerade.
     */
    visaYtanOverallt(forst.h, { avstand: forst.avstand });

    /*
     * FJÄRDE STEGET: notisen, från exakt samma ställe som rösten och ytan.
     *
     * Ägarens tredje önskemål ordagrant: "Och sen ska det komma en sägande
     * notis också." Det var det enda av de tre som inte fanns alls — varken
     * den här vägen eller showAlertBanner rörde Notification-API:t, så alla
     * kanaler krävde en app i förgrunden.
     *
     * Bara den upplästa rapporten får en notis, inte hela skuren: notisen
     * bär samma tagg och hade annars ersatt sig själv fyra gånger på en
     * sekund. Resten hittar föraren i ytan och i listan.
     */
    notisOverallt(forst.h);

    if (poster.length > 1) {
      const kvar = poster.length - 1;
      speaker.say(kvar === 1
        ? 'Ytterligare en rapport kom in.'
        : `Ytterligare ${kvar} rapporter kom in.`, { priority: 0 });

      /*
       * Hela bursten går in i ytan, inte bara den som lästes upp.
       *
       * Rösten kan bara säga "ytterligare tre rapporter" — tre uppläsningar i
       * rad är brus. Men en siffra utan något att titta på är en återvändsgränd:
       * föraren hör att det finns tre till och hittar dem ingenstans. Ytan är
       * byggd för precis det, den har en egen kö som namnger de närmaste och
       * räknar resten, och den vibrerar bara när den TÄNDS — alltså en gång för
       * hela skuren, inte en gång per rapport.
       */
      for (const p of poster.slice(1)) visaYtanOverallt(p.h, { avstand: p.avstand });
    }
    /*
     * Pausen räknas ur plinget, inte ur ett tal här. Se pausEfterPling() i
     * js/voice.js: talet 380 var avstämt mot ett pling på 350 ms, plinget
     * blev 840 ms, och rösten hamnade mitt i det. På iPhone tystnade talet
     * helt av överlappningen.
     */
  }, pausEfterPling('alert'));
}

/** Nollställ hela kedjan. Bara för prov — se inkommande-test.html. */
function inkommandeNollstall({ spar = true } = {}) {
  if (inkommandeTimer) { clearTimeout(inkommandeTimer); inkommandeTimer = null; }
  inkommandeSedda.clear();
  inkommandeTystade.clear();
  inkommandeKo.clear();
  inkommandeOmgangar = 0;
  inkommandeUtgangslagetBokfort = false;
  if (spar) {
    inkommandeSpar = [];
    writeJSON(INKOMMANDE_SPAR_NYCKEL, inkommandeSpar);
    renderInkommandeSpar();
  }
}

function wireInkommandeUpplasning() {
  renderInkommandeSpar();
  /*
   * Första genomgången bokför utgångsläget: det som redan låg i telefonens
   * lagring, plus det servern hunnit svara med om hämtningen i store.start()
   * vann kapplöpningen mot billing.sync().
   *
   * Att den kapplöpningen finns spelar inte längre någon roll — utgångsläget
   * avgörs av store.lastSync, inte av vilket varv vi är på — och genomgången
   * tystar ingenting av sig själv. Allt som ligger här passerar sina vanliga
   * grindar, och nästan allt faller på åldern. Det som ändå är färskt nog att
   * vara en nyhet hörs, precis som det ska.
   */
  inkommandeSok();
  store.addEventListener('change', inkommandeSok);
}

function wireUpdateBanner() {
  const el = $('updateBanner');
  if (!el) return;
  $('ubBtn').onclick = () => {
    $('ubBtn').textContent = 'Startar om…';
    $('ubBtn').disabled = true;
    setTimeout(() => location.reload(), 600);
  };
  $('ubLater').onclick = () => {
    el.hidden = true;
    el.dataset.dismissed = '1';
    toast('Uppdateringen sker automatiskt när du stannat.', 4000);
  };
}

/**
 * Visa svart på vitt vilken version som körs och när den byggdes.
 *
 * Utan det här går det inte att veta om en fix faktiskt slagit igenom eller
 * om telefonen sitter kvar på en cachad gammal version — och då blir varje
 * test värdelöst, för man vet inte vad man testar.
 */
/**
 * Byggstämpeln i tabbarens vänstra hörn — den som syns i alla fyra vyer.
 *
 * Egen funktion och inte en rad inne i renderVersion(): renderVersion() ger
 * upp direkt om kortet i Inställningar saknas, och stämpeln ska skrivas ändå.
 * Det är hela dess uppgift — att svara på "vad kör telefonen?" utan att man
 * först måste ta sig till den vy där svaret annars står.
 *
 * Samma källa som kortet: service workerns VERSION i första hand, eftersom
 * den ÄR cachenyckeln och därför inte kan glida isär från vad som körs.
 * CONFIG.version är en handskriven sträng som glömts i tolv utrullningar i
 * rad, så när den är allt vi har sätts ett frågetecken efter numret. Ett
 * nummer som kanske ljuger ska inte se ut som ett svar.
 *
 * Bara sista ledet ryms i hörnet, se motiveringen vid #versionMarke i
 * index.html. Saknar strängen ett ledande datum — någon har satt en egen
 * version — visas de sista tecknen i stället, klippta av max-width.
 */
function renderVersionsmarke() {
  const el = $('versionMarke');
  if (!el) return;
  const full = String(swVersion || CONFIG.version || '');
  const bygge = full.split('-').pop() || '?';
  el.textContent = 'v' + bygge + (swVersion ? '' : '?');
}

function renderVersion(state = 'ok', note = '') {
  renderVersionsmarke();
  const mark = $('updateMark'), card = $('updateCard');
  if (!mark) return;

  /*
   * Versionen kommer från service workern, inte från CONFIG.
   *
   * CONFIG.version är en handskriven sträng i js/config.js som ska bumpas vid
   * varje utrullning. Den glömdes bort i tolv utrullningar i rad: filen stod
   * kvar på 2026-08-20-58 medan appen i själva verket körde -70. Rutan visade
   * alltså ett nummer som inte fanns någonstans, och den som ville veta om en
   * fix slagit igenom fick fel svar — vilket är precis det den här rutan
   * finns för att förhindra.
   *
   * Service workern vet alltid sanningen: dess VERSION är samma sträng som
   * cachenyckeln, så den KAN inte glida isär från vad som faktiskt körs.
   * CONFIG.version står kvar som reserv för de sekunder innan svaret kommit.
   */
  $('versionInfo').textContent = `Version ${swVersion || CONFIG.version}`;
  const built = `Byggd ${buildDate()}`;

  const looks = {
    ok:       { icon: '✓', cls: 'ok',      text: note || `Du har senaste versionen. ${built}.` },
    checking: { icon: '↻', cls: 'busy',    text: 'Letar efter en nyare version…' },
    found:    { icon: '↓', cls: 'found',   text: 'Ny version hämtad. Startar om…' },
    offline:  { icon: '!', cls: 'warn',    text: 'Kunde inte kontrollera. Är du uppkopplad?' },
  }[state] || {};

  mark.textContent = looks.icon;
  /* classList och inte className.
     En hel omskrivning av class-attributet raderar ALLT annat som ligger på
     kortet, och det gör två moduler numera: js/inst.js märker hopfällda kort
     med inst-fallt, och js/rorelse.js lägger rr-avsloja och rr-landad under
     sina animationer. Mätt: kortet stod kvar synligt i en hopfälld grupp
     eftersom renderVersion() körde efter hopfällningen och tog bort märket —
     ett kort som inte gick att fälla ihop, utan felmeddelande. */
  card.classList.remove('ok', 'busy', 'found', 'warn');
  if (looks.cls) card.classList.add(looks.cls);
  $('updateState').textContent = looks.text;
}

/*
 * Läs versionen ur sw.js när service workern inte svarar.
 *
 * Reserven var CONFIG.version, en handskriven sträng som glömdes i tolv
 * utrullningar. Uppmätt: filen sa -71, rutan sa -70. En reserv som ljuger är
 * värre än ingen reserv, för den ser ut som ett svar.
 *
 * sw.js hämtas ändå av webbläsaren, filen är liten, och cache:'reload'
 * går förbi HTTP-cachen så vi får serverns version och inte en gammal.
 * Registreras inte service workern alls — vissa inbäddade webbläsare
 * vägrar — är det här det enda sättet att veta vad som faktiskt ligger uppe.
 */
async function lasVersionUrFil() {
  try {
    const r = await fetch('./sw.js', { cache: 'reload' });
    if (!r.ok) return null;
    const m = (await r.text()).match(/VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Riv allt och hämta om från servern.
 *
 * Sista utvägen, och den enda som fungerar i det fall som gör mest skada:
 * service workern svarar "inget nytt" fast servern har en nyare version.
 * Det händer när HTTP-cachen serverar en gammal sw.js, eller när den
 * installerade workern fastnat i 'waiting'. update() frågar den som har fel,
 * och får därför fel svar.
 *
 * Ordningen är vald med omsorg:
 *
 *   1. Cacherna först. Går avregistreringen sedan fel har vi i alla fall
 *      tvingat bort det gamla skalet — nästa hämtning måste gå till nätet.
 *   2. Avregistrera service workern. Utan det kan en fastnad worker svara på
 *      nästa navigering med precis samma gamla filer.
 *   3. Ladda om med en frågesträng. UTAN den kan webbläsarens egen HTTP-cache
 *      servera samma index.html en gång till, och då var hela övningen
 *      meningslös. Frågesträngen är också varför location.replace används:
 *      adressen ska inte bli kvar i historiken.
 *
 * Bara appens egen cache (poliswakt-skalet) ligger i Cache Storage.
 * Rapporter, inställningar och dashcamklipp bor i localStorage och IndexedDB
 * och rörs inte av det här. Det är därför texten i kortet får lova det.
 */
async function tvingaOmAppen() {
  try {
    if ('caches' in window) {
      const nycklar = await caches.keys();
      await Promise.all(nycklar.map(n => caches.delete(n)));
    }
  } catch (e) {
    console.warn('[uppdatering] kunde inte tömma cachen', e);
  }

  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.map(r => r.unregister()));
  } catch (e) {
    console.warn('[uppdatering] kunde inte avregistrera service workern', e);
  }

  const rent = location.pathname + '?pv=' + Date.now();
  location.replace(rent);
}

function wireUpdates() {
  // Före allt annat, och utanför guarden nedan: märket i tabbaren är det enda
  // som syns när man inte står i Inställningar, och det ska fyllas i även om
  // kortet av någon anledning inte finns i dokumentet.
  renderVersionsmarke();

  /*
   * Städa bort ?pv=… som tvingaOmAppen() lade dit.
   *
   * Den behövdes för EN hämtning, för att komma förbi HTTP-cachen. Blir den
   * kvar cachar service workern index.html under en adress som aldrig kommer
   * tillbaka, och varje delad länk ur appen bär med sig ett tidsstämplat
   * skräpargument. replaceState och inte pushState: tillbakaknappen ska inte
   * kunna leda in i omladdningen igen.
   */
  if (new URLSearchParams(location.search).has('pv')) {
    const p = new URLSearchParams(location.search);
    p.delete('pv');
    const fraga = p.toString();
    history.replaceState(null, '',
      location.pathname + (fraga ? '?' + fraga : '') + location.hash);
  }

  const btn = $('btnUpdate');
  if (!btn) return;
  renderVersion('ok');

  // Fyll i sanningen så fort den finns, utan att hålla upp gränssnittet.
  if (!swVersion) {
    lasVersionUrFil().then(v => {
      if (v && !swVersion) { swVersion = v; renderVersion('ok'); }
    });
  }
  btn.onclick = async () => {
    btn.disabled = true;
    renderVersion('checking');
    try {
      await swRegistration?.update();
      await new Promise(r => setTimeout(r, 2000));

      if (pendingUpdate) {
        renderVersion('found');
        setTimeout(() => location.reload(), 1200);
        return;
      }

      /*
       * Fråga servern också, inte bara service workern.
       *
       * "Inget nytt" från update() betyder bara att workern inte HITTADE
       * något — och det är exakt det svar man får när HTTP-cachen matar den
       * med den gamla sw.js. Filhämtningen går med cache:'reload' och förbi
       * den cachen, så den vet vad som faktiskt ligger uppe. Skiljer de två
       * åt är telefonen bevisligen gammal, och då ska rutan säga det rakt ut
       * i stället för att intyga motsatsen.
       */
      const paServern = await lasVersionUrFil();
      if (paServern && swVersion && paServern !== swVersion) {
        renderVersion('offline',
          `Servern har ${paServern}, du kör ${swVersion}. ` +
          'Sökningen hittade den inte — tryck "Tvinga om appen från servern".');
        toast('Din telefon kör en gammal version. Tvinga om appen.', 7000);
        return;
      }

      renderVersion('ok', `Kontrollerad nyss — du har senaste versionen. Byggd ${buildDate()}.`);
      toast('Du kör redan senaste versionen.');
    } catch {
      renderVersion('offline');
    } finally {
      btn.disabled = false;
    }
  };

  /*
   * Tvinga om: två tryck, ingen dialog.
   *
   * Knappen river offlinecachen. Ett oavsiktligt tryck i en bilhållare ska
   * inte kunna göra det, och en modal hade varit ett tredje tryck ovanpå en
   * ruta som täcker svaret man just läst. Knappen blir sin egen bekräftelse.
   *
   * Ångerfristen på åtta sekunder finns för den som tryckte fel och lägger
   * ifrån sig telefonen: efter den är knappen tillbaka i sitt vanliga läge,
   * så nästa tryck börjar om från början i stället för att verkställa.
   */
  const tvinga = $('btnTvingaOm');
  if (!tvinga) return;
  const tvingaText = tvinga.textContent;
  let angerfrist = null;

  tvinga.onclick = () => {
    if (!angerfrist) {
      tvinga.textContent = 'Säker? Tryck en gång till';
      tvinga.classList.add('danger');
      angerfrist = setTimeout(() => {
        angerfrist = null;
        tvinga.textContent = tvingaText;
        tvinga.classList.remove('danger');
      }, 8000);
      return;
    }
    clearTimeout(angerfrist);
    angerfrist = null;
    tvinga.disabled = true;
    tvinga.textContent = 'Hämtar om allt…';
    $('tvingaNot').textContent =
      'Appen startas om med allt hämtat på nytt. Det tar några sekunder.';
    tvingaOmAppen();
  };
}
