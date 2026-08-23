// Första starten: platsfrågan, förklarad — och en plats som SYNS när den saknas.
//
// Varför filen finns
// ------------------
// Polisvakt utan plats är inte en app med en avstängd funktion. Det är en
// karta som inte vet var du är, en hastighet som visar streck, och en motor
// som aldrig får ett läge att jämföra mot. Ingen varning kan gå ut. Ändå såg
// en nekad platsbehörighet i praktiken likadan ut som en GPS som bara dröjde:
// en gul prick i huvudet, och en toast som försvann efter sex sekunder.
//
// Två saker rättas här:
//
//   1. FRÅGAN. Den ställs vid första starten, med en mening om varför, och i
//      ett riktigt fingertryck. Tidigare utlöstes webbläsarens ruta av
//      watchPosition vid sidladdning: oförklarad, och på iOS Safari ibland
//      inte alls, eftersom rutan där kräver en levande gest. Grinden i
//      js/geo.js håller tillbaka watchPosition tills den här filen fått fråga.
//
//   2. SYNLIGHETEN. Nekas plats ligger en remsa kvar högst upp tills det är
//      löst, med den exakta menyvägen för just den här telefonen. Den täcker
//      hastighetsrutan — med flit. Utan plats visar den ändå bara ett streck,
//      och skälet till att den gör det är viktigare än rutan själv.
//
// Filen ritar, den vet ingenting. Allt om tillstånd kommer från
// js/behorigheter.js, allt om GPS-grinden från js/geo.js. Det ska finnas exakt
// en uppfattning om vad som är tillåtet, och den bor inte här.
//
// Den tränger sig aldrig före något annat: ligger ansvarsfriskrivningen,
// kontoskärmen, introduktionsguiden eller en annan modal uppe väntar den. Den
// egna stilen ligger i en <style> som filen själv lägger in, så css/app.css
// inte behöver röras.

import {
  platsStatus,
  begarPlats,
  instruktioner,
  markeraPlatsFragad,
  events as behorighetsEvents,
} from './behorigheter.js';
import { slappFramPlats, skjutUppPlats, hallGrinden, grindLage } from './geo.js';

/** EN mening. En förare som förstår frågan säger ja; en som inte gör det säger nej för alltid. */
const VARFOR = 'Polisvakt behöver din plats för att kunna varna för polis och fartkameror på vägen framför dig.';

// Hur länge vi väntar på en ledig skärm innan vi ger upp och låter
// nödutgången i geo.js starta GPS:en på gammalt vis. Hellre webbläsarens egen
// oförklarade ruta än en app som aldrig får en position.
const MAX_VANTAN_MS = 150000;

const PULS_MS = 700;

/* ------------------------------------------------------------------ */
/* Stil                                                                */
/* ------------------------------------------------------------------ */
//
// Färgerna är app.css egna variabler med hårda reservvärden efter sig: filen
// laddas dynamiskt och ska fungera även om den skulle råka köra innan
// stilmallen är på plats.

const CSS = `
.pv-ps-skarm {
  position: fixed; inset: 0; z-index: 990;
  background: rgba(4,7,11,.78); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  display: flex; align-items: flex-end; justify-content: center;
  padding: 16px;
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
}
.pv-ps-kort {
  width: 100%; max-width: 380px;
  background: var(--bg-2, #141b23);
  border: 1px solid var(--line, #26323f);
  border-radius: 20px; padding: 20px;
  box-shadow: 0 24px 60px rgba(0,0,0,.6);
  color: var(--fg, #eef4fa);
  font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  max-height: calc(100vh - 32px); overflow-y: auto;
}
.pv-ps-ikon { font-size: 30px; line-height: 1; margin-bottom: 8px; }
.pv-ps-kort h2 { margin: 0 0 8px; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
.pv-ps-kort p { margin: 0 0 16px; font-size: 14.5px; color: var(--fg-dim, #93a4b6); }
.pv-ps-kort p.pv-ps-fel { color: var(--warn, #ffb020); }
.pv-ps-knappar { display: flex; flex-direction: column; gap: 9px; }
.pv-ps-knapp {
  width: 100%; border: 1px solid var(--line, #26323f); border-radius: 14px;
  padding: 14px 12px; font-size: 15.5px; font-weight: 650;
  background: var(--bg-3, #1d2733); color: var(--fg, #eef4fa);
  cursor: pointer; font-family: inherit;
}
.pv-ps-knapp.pv-ps-primar {
  background: var(--accent, #3d9dff); border-color: var(--accent, #3d9dff); color: #04101d;
}
.pv-ps-knapp[disabled] { opacity: .6; cursor: default; }

/* Remsan som ligger kvar. Högst upp, över hastighetsrutan — utan plats visar
   den ändå bara ett streck, och varför den gör det är viktigare än rutan.

   z-index 890: över tabbaren (800) och versionsbannern (880), men UNDER
   varningsbannern och mörkt körläge (900), fordonslarmet (1500), modalerna
   (1000) och rundturen (3000). Remsan är viktig, men den är en förklaring —
   den ska aldrig lägga sig över något som varnar för verkligheten just nu. */
.pv-ps-remsa {
  position: fixed; z-index: 890; left: 0; right: 0; top: 0;
  padding: calc(env(safe-area-inset-top, 0px) + 9px) 12px 9px;
  background: rgba(38,10,12,.92); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(255,77,79,.5);
  display: flex; align-items: center; gap: 10px;
  color: #ffd9d9;
  font: 13.5px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
.pv-ps-remsa b { display: block; color: #fff; font-weight: 650; }
.pv-ps-remsa .pv-ps-text { flex: 1; min-width: 0; }
.pv-ps-remsa .pv-ps-knapp {
  width: auto; flex: none; padding: 9px 13px; font-size: 13.5px; border-radius: 11px;
  background: var(--danger, #ff4d4f); border-color: var(--danger, #ff4d4f); color: #2a0507;
}

.pv-ps-steg { margin: 0 0 14px; padding: 0; list-style: none; counter-reset: pvps; }
.pv-ps-steg li {
  counter-increment: pvps;
  display: flex; gap: 11px; padding: 10px 0;
  border-top: 1px solid var(--line, #26323f);
  font-size: 14px; line-height: 1.45; color: var(--fg, #eef4fa);
}
.pv-ps-steg li:first-child { border-top: none; }
.pv-ps-steg li::before {
  content: counter(pvps); flex: none;
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--bg-3, #1d2733); color: var(--fg-dim, #93a4b6);
  font-size: 12px; font-weight: 700; text-align: center; line-height: 22px;
}
.pv-ps-not {
  background: rgba(255,176,32,.1); border: 1px solid rgba(255,176,32,.3);
  border-radius: 12px; padding: 11px 13px; margin: 0 0 16px;
  font-size: 13px; color: var(--warn, #ffb020);
}
`;

function injiceraCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('pv-ps-stil')) return;
  const s = document.createElement('style');
  s.id = 'pv-ps-stil';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* Skärmen — vem äger den just nu?                                     */
/* ------------------------------------------------------------------ */

/**
 * Ligger något annat viktigt uppe?
 *
 * Ansvarsfriskrivningen måste läsas först, kontoskärmen och guiden äger hela
 * skärmen när de går, och larmet får aldrig täckas. Vi väntar hellre en stund
 * än lägger en andra ruta ovanpå en användare som redan har en fråga framför
 * sig — två rutor på första starten är samma sak som ingen läst ruta alls.
 *
 * .pv-varningsyta är js/varningsyta.js remsa. Den låg inte här, till skillnad
 * från i uppstart.js och peka.js som båda lärde sig om den — och det var inte
 * ett teoretiskt hål: remsan nedanför visas BARA när appen saknar position,
 * och det är precis samma läge som ger rapporter utan geokod. De två ytorna
 * är alltså uppe samtidigt per konstruktion, inte av olyckshändelse. Uppmätt
 * följd: remsan (z890) helt begravd under ytan (z905), och trycket på dess
 * "Slå på"-knapp landade på ytans kryss. Föraren som försökte laga sin
 * platsdelning stängde i stället varningen.
 *
 * Själva remsan göms dessutom av en CSS-regel i varningsyta.js
 * (body.pv-vy-uppe .pv-ps-remsa), eftersom ritaRemsa() inte går genom den här
 * grinden — den ritar när tillståndet ändras, inte när skärmen är ledig. Den
 * här raden hindrar KORTET från att poppa upp mitt i en varning.
 */
function annanRutaUppe() {
  const val = '.modal, .auth-screen, .tour, .voice-overlay, .fordonslarm, ' +
              '.pv-varningsyta, dialog[open]';
  for (const el of document.querySelectorAll(val)) {
    if (el.closest('.pv-ps-skarm')) continue;          // våra egna räknas inte
    if (el.hasAttribute('hidden')) continue;
    if (el.getClientRects().length) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Frågan                                                              */
/* ------------------------------------------------------------------ */

let kortEl = null;
let remsaEl = null;
let puls = null;
let pulsBorjade = 0;
let tickPagar = false;

function stangKort() {
  kortEl?.remove();
  kortEl = null;
}

/**
 * Bygger kortet. Knappen anropar begarPlats() SYNKRONT i klicket — inget await
 * före, ingen setTimeout. Safari visar ingen platsruta alls om gesten hunnit
 * dö, och det felet är osynligt: man trycker, och ingenting händer.
 */
function visaKort() {
  if (kortEl) return;
  injiceraCss();

  const skarm = document.createElement('div');
  skarm.className = 'pv-ps-skarm';
  skarm.innerHTML = `
    <div class="pv-ps-kort" role="dialog" aria-modal="true" aria-labelledby="pv-ps-rubrik">
      <div class="pv-ps-ikon" aria-hidden="true">📍</div>
      <h2 id="pv-ps-rubrik">Slå på plats</h2>
      <p class="pv-ps-varfor"></p>
      <div class="pv-ps-knappar">
        <button type="button" class="pv-ps-knapp pv-ps-primar">Tillåt plats</button>
        <button type="button" class="pv-ps-knapp pv-ps-sekundar">Inte nu</button>
      </div>
    </div>`;
  // textContent, inte innerHTML: meningen är text och ska aldrig kunna bli markup.
  skarm.querySelector('.pv-ps-varfor').textContent = VARFOR;

  const ja = skarm.querySelector('.pv-ps-primar');
  const nej = skarm.querySelector('.pv-ps-sekundar');

  ja.addEventListener('click', () => {
    ja.disabled = true;
    ja.textContent = 'Väntar på svar…';
    markeraPlatsFragad();
    // INGET await ovanför den här raden. Se kommentaren i behorigheter.js
    // begarPlats(): gesten måste fortfarande vara levande.
    begarPlats().then(svar => svaretPaFragan(svar, ja, nej));
  });

  nej.addEventListener('click', () => {
    markeraPlatsFragad();
    stangKort();
    // Grinden hålls stängd. Att låta watchPosition väcka systemrutan tjugofem
    // sekunder efter ett "inte nu" vore att fråga bakvägen.
    skjutUppPlats('inte-nu');
    ritaRemsa();
  });

  document.body.appendChild(skarm);
  kortEl = skarm;
}

function svaretPaFragan(svar, ja, nej) {
  if (svar.ok) {
    stangKort();
    slappFramPlats('anvandaren-sa-ja');
    ritaRemsa();
    return;
  }

  if (svar.state === 'denied') {
    // Webbläsaren frågar inte igen. Remsan tar över och visar menyvägen.
    stangKort();
    slappFramPlats('nekad');
    ritaRemsa();
    return;
  }

  /*
   * Varken ja eller nej: ingen signal, eller timeout. Tillståndet är
   * oförändrat, och det vore fel att måla upp det som ett nej — telefonen kan
   * ha stått i ett garage. Vi släpper fram watchPosition, som fortsätter
   * försöka i bakgrunden av sig själv, och låter kortet stå kvar med skälet.
   */
  slappFramPlats('oklart-svar');
  ja.disabled = false;
  ja.textContent = 'Försök igen';
  nej.textContent = 'Stäng';
  const kort = kortEl?.querySelector('.pv-ps-kort');
  if (kort && !kort.querySelector('.pv-ps-fel')) {
    const p = document.createElement('p');
    p.className = 'pv-ps-fel';
    p.textContent = svar.reason || 'Telefonen svarade inte på platsfrågan.';
    kort.querySelector('.pv-ps-knappar').before(p);
  }
  ritaRemsa();
}

/* ------------------------------------------------------------------ */
/* Remsan — plats som saknas ska aldrig vara tyst                      */
/* ------------------------------------------------------------------ */

function stangRemsa() {
  remsaEl?.remove();
  remsaEl = null;
}

/**
 * Ritar (eller tar bort) remsan efter hur det faktiskt ligger till.
 *
 * Tre lägen som betyder olika saker och därför får olika text och olika knapp:
 *   • blockerad  — webbläsaren frågar inte igen, det måste lösas i menyerna
 *   • avstängd   — föraren tryckte "Inte nu", ett tryck löser det
 *   • saknas     — enheten har ingen GPS, det finns ingenting att göra
 *
 * "Väntar på första fixen" ger ingen remsa. Det är inte ett fel, och en varning
 * om något som håller på att lösa sig lär föraren att strunta i remsan.
 */
let remsaRitas = false;

async function ritaRemsa() {
  if (typeof document === 'undefined') return;
  // platsStatus() är asynkron, och två anrop kan komma tätt (ett tillstånd som
  // ändras samtidigt som appen kommer i förgrunden). Utan spärren hinner båda
  // se att remsan saknas, och då ritas den två gånger.
  if (remsaRitas) return;
  remsaRitas = true;
  try {
    await ritaRemsaNu();
  } finally {
    remsaRitas = false;
  }
}

async function ritaRemsaNu() {
  const st = await platsStatus();
  const uppskjuten = grindLage().lage === 'uppskjuten';

  // Plats blev tillåten någon annan väg än våra egna knappar: installations-
  // guidens "Tillåt plats" (tour.js) går direkt på behorigheter.begarPlats(),
  // och telefonens systeminställningar går förbi appen helt. Då står grinden
  // kvar på "uppskjuten" efter ett tidigare "Inte nu", GeoTrackern ligger
  // oanvänd i vantandeSparare och watchPosition startar aldrig. Resultatet såg
  // rätt ut — remsan försvann här nedanför — men appen fick noll positioner:
  // ingen närhetsvarning, ingen fartkamera, ingen hastighet, och inte ens ett
  // larm från vakthunden, som kräver en första fix för att kunna sakna GPS.
  //
  // Därför öppnas grinden här, innan remsan tas bort. Bara när tillståndet
  // verkligen är beviljat (st.ok) — ett "uppskjuten" som fortfarande bara är
  // ett obesvarat läge ska aldrig öppnas bakvägen, det är hela poängen med
  // grinden.
  if (st.ok && uppskjuten) slappFramPlats('tillaten-utifran');

  if (st.ok || (!uppskjuten && st.state !== 'denied' && st.state !== 'saknas')) {
    stangRemsa();
    return;
  }

  const lage =
    st.state === 'saknas' ? 'saknas' :
    st.state === 'denied' ? 'blockerad' : 'avstangd';

  const rubrik =
    lage === 'saknas'    ? 'Enheten saknar GPS' :
    lage === 'blockerad' ? 'Plats är blockerad' : 'Plats är avstängd';

  injiceraCss();
  if (!remsaEl) {
    remsaEl = document.createElement('div');
    remsaEl.className = 'pv-ps-remsa';
    remsaEl.setAttribute('role', 'status');
    remsaEl.innerHTML = `
      <div class="pv-ps-text"><b></b><span></span></div>
      <button type="button" class="pv-ps-knapp"></button>`;
    document.body.appendChild(remsaEl);
  }

  remsaEl.querySelector('b').textContent = rubrik;
  remsaEl.querySelector('span').textContent = 'Polisvakt kan inte varna för något framför dig.';

  const knapp = remsaEl.querySelector('.pv-ps-knapp');
  if (lage === 'saknas') {
    knapp.hidden = true;
    return;
  }
  knapp.hidden = false;

  if (lage === 'avstangd') {
    // Ett tryck räcker: rutan är aldrig visad, så webbläsaren frågar gärna.
    knapp.textContent = 'Slå på';
    knapp.onclick = () => {
      markeraPlatsFragad();
      // Direkt i gesten, av samma skäl som i kortet ovanför.
      begarPlats().then(svar => {
        if (svar.ok) slappFramPlats('remsan');
        else if (svar.state === 'denied') slappFramPlats('nekad');
        ritaRemsa();
      });
    };
    return;
  }

  // Blockerad: det finns ingen ruta kvar att visa, bara en menyväg.
  knapp.textContent = 'Så slår du på';
  knapp.onclick = () => visaHjalp();
}

/* ------------------------------------------------------------------ */
/* Menyvägen                                                           */
/* ------------------------------------------------------------------ */

/**
 * Exakta steg för just den här telefonen. Texten kommer från
 * behorigheter.js instruktioner('plats') — en felaktig menyväg är sämre än
 * ingen, och den kunskapen ska finnas på ett ställe.
 */
function visaHjalp() {
  if (kortEl) return;
  injiceraCss();
  const info = instruktioner('plats');

  const skarm = document.createElement('div');
  skarm.className = 'pv-ps-skarm';
  skarm.innerHTML = `
    <div class="pv-ps-kort" role="dialog" aria-modal="true">
      <h2></h2>
      <ol class="pv-ps-steg"></ol>
      <p class="pv-ps-not"></p>
      <div class="pv-ps-knappar">
        <button type="button" class="pv-ps-knapp pv-ps-primar">Jag har slagit på det</button>
        <button type="button" class="pv-ps-knapp pv-ps-sekundar">Stäng</button>
      </div>
    </div>`;

  skarm.querySelector('h2').textContent = info.rubrik;
  const lista = skarm.querySelector('.pv-ps-steg');
  for (const steg of info.steg) {
    const li = document.createElement('li');
    li.textContent = steg;
    lista.appendChild(li);
  }
  const not = skarm.querySelector('.pv-ps-not');
  if (info.not) not.textContent = info.not;
  else not.remove();

  const prova = skarm.querySelector('.pv-ps-primar');
  prova.addEventListener('click', () => {
    prova.disabled = true;
    prova.textContent = 'Kollar…';
    /*
     * begarPlats() igen, direkt i gesten. Har föraren verkligen slagit på det
     * i systeminställningarna svarar telefonen med en position, och då vet vi
     * det säkert — i Safari är det till och med enda sättet, eftersom
     * Permissions API inte svarar på frågan där.
     */
    begarPlats().then(svar => {
      if (svar.ok) {
        slappFramPlats('efter-instruktion');
        stangKort();
      } else {
        prova.disabled = false;
        prova.textContent = 'Försök igen';
      }
      ritaRemsa();
    });
  });
  skarm.querySelector('.pv-ps-sekundar').addEventListener('click', stangKort);

  document.body.appendChild(skarm);
  kortEl = skarm;
}

/* ------------------------------------------------------------------ */
/* Pulsen: vänta på ledig skärm, och håll grinden vid liv              */
/* ------------------------------------------------------------------ */

function stoppaPuls() {
  clearInterval(puls);
  puls = null;
}

async function tick() {
  if (tickPagar) return;          // platsStatus() är asynkron; kör inte om oss själva
  tickPagar = true;
  try {
    if (grindLage().lage !== 'vantar') { stoppaPuls(); return; }

    // Så länge vi lever hålls nödutgången i geo.js på avstånd. Dör den här
    // filen slutar pingen, och GPS:en startar ändå.
    hallGrinden();

    if (kortEl) return;           // frågan är ställd, vi väntar på svar

    if (Date.now() - pulsBorjade > MAX_VANTAN_MS) {
      // Skärmen har varit upptagen i flera minuter. Sluta pinga och låt
      // nödutgången öppna grinden — hellre webbläsarens egen oförklarade ruta
      // än en app som aldrig får en position.
      stoppaPuls();
      return;
    }
    if (annanRutaUppe()) return;

    const st = await platsStatus();
    if (st.ok) { stoppaPuls(); slappFramPlats('redan-tillaten'); ritaRemsa(); return; }
    if (!st.kanFraga) {
      // Blockerad eller ingen GPS: det finns ingen ruta att visa. Släpp fram
      // watchPosition (den kostar ingenting när den nekas) och visa remsan.
      stoppaPuls();
      slappFramPlats('gar-inte-att-fraga');
      ritaRemsa();
      return;
    }
    visaKort();
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

function bevakaTillstand() {
  // Tillståndet kan ändras utan att vi frågat: geo.js matar in det via
  // behorigheter.koppla() så fort watchPosition får en position eller ett
  // nekande, och Permissions API kan säga till mitt i körningen.
  behorighetsEvents.addEventListener('andrad', e => {
    if (e.detail?.vad === 'plats') ritaRemsa();
  });

  // Föraren kan ha varit inne i systeminställningarna och löst det. Då ska
  // remsan vara borta när hen kommer tillbaka, inte stå kvar och ha fel.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ritaRemsa();
  });
}

async function start() {
  injiceraCss();
  await domRedo();
  bevakaTillstand();
  ritaRemsa();

  if (grindLage().lage !== 'vantar') return;   // inte första starten
  pulsBorjade = Date.now();
  puls = setInterval(tick, PULS_MS);
  tick();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Går något fel här får det aldrig bli en app utan GPS. Nödutgången i
  // geo.js sköter det, men vi säger till direkt istället för att låta den
  // vänta ut sina tjugofem sekunder.
  start().catch(() => slappFramPlats('platsstart-fel'));
}
