// Polisvakt — sammanfogning av alla delar.

import { shortDistance, relativeTime, debounce, normalize, isDark } from './util.js';
import { parseReportText, TYPE_LABEL, TYPE_ICON } from './parser.js';
import { GeoTracker, currentPosition } from './geo.js';
import { initGeocoder, geocode, reverseGeocode, learnPlace, listLearned, forgetPlace } from './geocode.js';
import { ReportStore, deviceId, setIdentity, isMine } from './store.js';
import { Speaker, Listener, voiceInputSupported } from './voice.js';
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
import { PLANS, PRODUCTS, PREPAY, STATUS_LABEL, yearlyComparison } from './plans.js';
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
import { PlateReader, plateSupported, visaPlat, haFordonsregister, migreraKlartext } from './plate.js';
import { Chatt, UTAN_OMRADE_TEXT } from './chatt.js';
import { Ljud } from './ljud.js';
import * as Notiser from './notiser.js';
import * as Korvanor from './korvanor.js';
import { Navigering, tolkaOsrmRutt } from './navigering.js';
import { beskrivning, sammanfattaKort, sammanfattaTal } from './sammanfattning.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'pv.settings.v1';

/* ================= Inställningar ================= */

const defaults = {
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
  ljudPa: true,
  ljudVolym: 0.75,
  chattLastAt: 0,          // när chatten senast lästes, för antalet olästa
  morktLage: true,         // släck skärmen under körning när ingen rör den
  haptikPa: true,
  notiser: null,          // fylls av notiser.js vid behov

  /*
   * Räckvidden för notiser till låst skärm. Bor på servern — de här två är
   * bara vad telefonen tror, så att rutan kan ritas rätt innan svaret kommit.
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
  delete settings.plEgna;
  saveSettings();
  if (r.ogiltiga?.length) {
    toast(`Kunde inte tolka som registreringsnummer: ${r.ogiltiga.join(', ')}`, 6000);
  }
})();
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
const routeGuide = new RouteGuide(store, { handoffM: settings.hazardRadiusM });
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

boot();

async function boot() {
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
  wireTour();
  wireDriving();
  wireUpdates();
  wireUpdateBanner();
  wireSedanSist();
  wireCoverage();
  wireRoute();
  wireWinter();
  wireVakthund();
  wireVarmevakt();
  wirePermissions();
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
  setInterval(nardenSyns(() => { stats.recordAll(store.active()); renderStats(); }), 120000);
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
  const talat = sammanfattaTal(near[0], { egen: arMin(near[0]) });
  speaker.say(talat ? `Tack. ${talat} Den ligger kvar längre nu.`
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

function wireStats() {
  store.addEventListener('change', () => stats.recordAll(store.active()));
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

function allHazards({ forAlerts = false } = {}) {
  const me = geo.position;
  const aktiva = coverage.filter(store.active(), me);

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
      .filter(h => h.bedomning?.behandling !== Kvalitet.BEHANDLING.UNDANHALL);
  } catch {
    // Graderingen får aldrig kunna släcka varningarna. Går något fel faller
    // vi tillbaka på ograderade rapporter — hellre en osäker varning än ingen.
    graderade = aktiva;
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
  const { forRost, forKarta } =
    Notiser.delaUppFaror([...graderade, ...coverage.filter(cameras, me)], settings);
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

  const near = list
    .map(h => ({ ...h, distance: haversineFix(fix, h) }))
    .filter(h => h.distance <= Math.max(settings.hazardRadiusM * 3, 5000))
    .sort((a, b) => a.distance - b.distance)
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
        toast('Tack. Varningen ligger kvar längre nu.', 3500);
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
}

function hideAlertBanner() {
  $('alertBanner').hidden = true;
  currentAlert = null;
  renderMorkt();
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
  // Läsaren skapas först när läget väljs, så den måste hämtas vid anrop.
  get plate() { return plate; },
  chatt, ljud, korvanor,
  // Belöningsbeskedet går att provköra utan att vänta på ett månadsskifte.
  visaBelaning, renderKorfalt, remote, groups,
  get nav() { return nav; },
  // Gruppnotisreglagets fem lägen, för mätning. Se ritaGruppnotis.
  ritaGruppnotis: s => ritaGruppnotis(s),
};

/* ================= Gränssnitt ================= */

function wireUI() {
  // Vyer
  document.querySelectorAll('.tab').forEach(btn => {
    btn.onclick = () => showView(btn.dataset.view);
  });

  // Rapportknappar: tryck och håll, inte ett vanligt tryck.
  //
  // Knapparna sitter längst ner där tummen vilar. Ett vanligt tryck betyder
  // att varje snedtryck blir en falsk rapport som skickas till alla andra i
  // Västmanland — och falska rapporter är det enda som verkligen kan förstöra
  // appen. Håll i sex tiondelar räcker för att det ska vara omöjligt av
  // misstag, men är fortfarande en enda rörelse med tummen.
  document.querySelectorAll('[data-report]').forEach(btn => setupHoldToReport(btn));

  $('btnFollow').onclick = () => map.setFollow(true);
  $('alertClose').onclick = hideAlertBanner;

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
  document.body.dataset.view = name;
  for (const v of ['map', 'dashcam', 'chatt', 'settings']) {
    $('view-' + v).hidden = v !== name;
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));

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
  if (name === 'settings') { refreshLearnedList(); renderBilling(); renderShareQR(); renderPlans(); renderShop(); renderChain($('roadmapChain')); renderNotisTyper(); synkaGruppnotis(); synkaNotisOmfang(); }
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

function renderShop() {
  const wrap = $('shopList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const wanted = readJSON('pv.wishlist.v1', []);

  for (const p of PRODUCTS) {
    const el = document.createElement('div');
    el.className = 'product';
    const on = wanted.includes(p.id);
    el.innerHTML =
      `<div class="prod-ico">${p.icon}</div>` +
      `<div class="prod-body">` +
        `<div class="prod-head"><b>${escapeHtml(p.name)}</b>` +
        `<span class="prod-price">${p.price} kr</span></div>` +
        `<div class="prod-tag">${escapeHtml(p.tagline)}</div>` +
        `<div class="prod-text">${escapeHtml(p.body)}</div>` +
        `<span class="prod-status">${STATUS_LABEL[p.status]}</span>` +
      `</div>`;
    const btn = document.createElement('button');
    btn.className = 'btn-ghost small' + (on ? ' chosen' : '');
    btn.type = 'button';
    btn.textContent = on ? '✓ Du står på listan' : 'Meddela mig';
    btn.onclick = () => toggleInterest(p, btn);
    el.querySelector('.prod-body').appendChild(btn);
    wrap.appendChild(el);
  }
}

/**
 * Intresseanmälan istället för köpknapp.
 *
 * Lagret finns inte än. Att låta folk trycka "köp" på något som inte kan
 * skickas är ett säkert sätt att bränna förtroendet direkt. Intresset säger
 * dessutom hur många hållare som faktiskt ska beställas från Kina — det är
 * värt mer än en tidig krona.
 */
async function toggleInterest(product, btn) {
  const list = readJSON('pv.wishlist.v1', []);
  const i = list.indexOf(product.id);
  const adding = i === -1;
  if (adding) list.push(product.id); else list.splice(i, 1);
  try { localStorage.setItem('pv.wishlist.v1', JSON.stringify(list)); } catch {}

  btn.className = 'btn-ghost small' + (adding ? ' chosen' : '');
  btn.textContent = adding ? '✓ Du står på listan' : 'Meddela mig';

  if (adding) {
    toast(`Vi hör av oss när ${product.name} finns i lager.`, 4000);
    if (store.isRemote) {
      try {
        await fetch(`${CONFIG.supabaseUrl}/rest/v1/product_interest`, {
          method: 'POST',
          headers: { apikey: CONFIG.supabaseAnonKey, Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
                     'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            device_id: deviceId(), product: product.id,
            email: auth.email || null, created_at: Date.now(),
          }),
        });
      } catch { /* intresset finns kvar lokalt */ }
    }
  }
}

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
        const proc = Math.round((d.sakerhet || 0) * 100);
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
  avbrytLarm = larma(d, {
    visa: t => {
      $('larmNamn').textContent = t.etikett || 'Ditt fordon';
      // Numret visas bara i larmögonblicket och lagras aldrig — se
      // Fordonsregister. Rösten säger det aldrig högt.
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
    const tolkning = parseReportText(text);
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
    showView('settings');
    const rubrik = $('minaFordonRubrik');
    rubrik?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Fokus på fältet, inte bara rullning: den som tryckt på knappen vill
    // skriva ett nummer, och tangentbordet ska upp utan ett extra tryck.
    setTimeout(() => $('plNytt')?.focus(), 420);
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
    $('plZoomAuto').classList.toggle('on', auto);
    $('plZoomManuell').classList.toggle('on', !auto);
    $('plZoomAuto').setAttribute('aria-pressed', String(auto));
    $('plZoomManuell').setAttribute('aria-pressed', String(!auto));
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
   * Egna fordon — som saltade hashar, aldrig som nummer.
   *
   * Textrutan som låg här sparade registreringsnummer i klartext i telefonens
   * lagring. Nu lagras bara saltade hashar plus de troliga felläsningarna av
   * varje nummer, så att en felläst femma ändå matchar. Inget läsbart nummer
   * finns kvar — varken i lagringen, i en enhetsbackup eller i en felrapport.
   *
   * Listan visar därför namnet du gett fordonet, inte numret. Det är inte en
   * begränsning som gömts undan, det är hela poängen: appen kan inte visa ett
   * nummer den inte har.
   */
  const fordon = haFordonsregister();

  function renderFordon() {
    const ul = $('plFordonLista');
    if (!ul) return;
    ul.innerHTML = '';
    for (const f of fordon.lista()) {
      const li = document.createElement('li');
      li.className = 'pl-item';
      li.innerHTML = '<b class="pl-nr"></b><span class="pl-meta"></span>';
      li.querySelector('.pl-nr').textContent = f.etikett;
      li.querySelector('.pl-meta').textContent =
        `${f.varianter} hash${f.varianter === 1 ? '' : 'ar'} · inget nummer lagrat`;
      const bort = document.createElement('button');
      bort.type = 'button';
      bort.className = 'btn-ghost small';
      bort.textContent = 'Ta bort';
      bort.onclick = () => { fordon.taBort(f.id); renderFordon(); };
      li.appendChild(bort);
      ul.appendChild(li);
    }
    $('plFordonTom').hidden = fordon.antal > 0;
  }

  $('btnPlLagg').onclick = async () => {
    const r = await fordon.laggTill($('plNytt').value, $('plNyttNamn').value);
    // Numret ska inte ligga kvar i fältet efteråt.
    $('plNytt').value = '';
    if (r.status === 'ogiltig') {
      $('plEgnaStatus').textContent = 'Känns inte igen som ett svenskt registreringsnummer.';
      return;
    }
    if (r.status === 'fanns') {
      $('plEgnaStatus').textContent = `Fordonet finns redan (${r.etikett}).`;
      return;
    }
    if (r.sparad === false) {
      $('plEgnaStatus').textContent = 'Kunde inte spara — telefonens lagring är full eller avstängd.';
      return;
    }
    $('plNyttNamn').value = '';
    /*
     * Antalet hashar stod förut i klartext här, och det var missvisande.
     * "1 hash" läses som "ingen feltolerans", vilket är fel: de flesta
     * felläsningar rättas redan av normaliseringen innan uppslaget sker —
     * ett A på en sifferposition blir en fyra. Varianterna behövs bara för
     * de förväxlingar formatet inte kan avgöra, som O mot D. Ett nummer
     * utan sådana tecken får därför en enda hash och är ändå fullt skyddat.
     * Siffran svarade alltså på en fråga ingen ställt, och gav fel svar på
     * den man faktiskt hade.
     */
    $('plEgnaStatus').textContent =
      `Sparade ${r.etikett}. Numret lagras inte — bara en hash som appen kan känna igen det på.`;
    renderFordon();
  };

  // Att kunna prova ett nummer är enda sättet att kontrollera att rätt fordon
  // ligger inne, när numret inte går att visa.
  $('btnPlProva').onclick = async () => {
    const t = await fordon.slaUpp($('plProva').value);
    $('plProva').value = '';
    $('plEgnaStatus').textContent = t
      ? `Ja — det numret hör till ${t.etikett}${t.exakt ? '' : ' (som en trolig felläsning)'}.`
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
    const dest = $('routeDest').value.trim();
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
      return { kanFraga: false, blockerad: false,
        text: 'Notiser tillåtna. Appen kan påminna dig innan du brukar köra.' };
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
    $('btnNotify').hidden = !l.kanFraga;
    renderGruppnotis();
  };
  $('btnNotify').onclick = async () => {
    const ok = await driving.requestPermission();
    renderNotify();
    if (ok) {
      driving.notify('Polisvakt', 'Så här ser en påminnelse ut när du brukar köra.');
    }
  };
  renderNotify();

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

  $('chattTomt').hidden = lista.length > 0;
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
  if (!lista.length) {
    const li = document.createElement('li');
    li.className = 'tom';
    li.textContent = 'Inget nytt.';
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
     * Är man utloggad står skälet redan vid skrivfältet. Att upprepa det
     * här gör bara samma sak sagd två gånger.
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
    uppdateraSkrivlage();
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

/** De rapporter som kommit in sedan man tittade sist, nyast först. */
function nyaSedanSist() {
  const sedan = sedanSistLast();
  return store.active()
    .filter(h => !h.fixed                       // fasta kameror är aldrig nyheter
              && Number(h.createdAt) > sedan
              && !arMin(h))                     // inte det man själv rapporterat
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
function renderVersion(state = 'ok', note = '') {
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
  card.className = 'card card-update ' + (looks.cls || '');
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

function wireUpdates() {
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
      renderVersion('ok', `Kontrollerad nyss — du har senaste versionen. Byggd ${buildDate()}.`);
      toast('Du kör redan senaste versionen.');
    } catch {
      renderVersion('offline');
    } finally {
      btn.disabled = false;
    }
  };
}
