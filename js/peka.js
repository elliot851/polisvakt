// Pekaren — lyft fram EN sak i appen och säg vad den gör.
//
// Varför filen finns
// ------------------
// Att navigera föraren till rätt reglage räcker inte. Panelen öppnas, sidan
// rullar, och sedan står hen framför tjugo rader inställningar utan att veta
// vilken av dem det gällde. Det som saknades var själva pekandet: en
// mörkläggning runt om, en ring på just det reglaget, och en pil med en kort
// mening.
//
// Introduktionsguiden (js/tour.js) kan redan peka, men den kan bara peka som
// en del av sina femton steg: den låser skärmen, äger hela flödet, ligger på
// z-index 3000 och märker sig själv som "sedd" när den stängs. Det som behövs
// här är motsatsen — något litet som kan kastas upp när som helst, ovanpå den
// vanliga appen, utan att ta över den. Därför en egen fil istället för ett
// nytt läge i tour.js.
//
// Vad pekaren INTE gör, och varför
// --------------------------------
//   • Den fångar aldrig ett klick. Hela lagret är pointer-events: none, så
//     fingret går rakt igenom och trycker på den riktiga knappen. Poängen är
//     att föraren ska SLÅ PÅ det vi pekar på — en pekare som står i vägen för
//     just det vore direkt kontraproduktiv.
//   • Den fångar aldrig tangentbordet. Ingen fokusflytt, ingen fokusfälla,
//     inget preventDefault. Escape stänger, men bara som en genväg.
//   • Den ligger aldrig över en varning. z-index 885: över tabbaren (800) och
//     versionsbannern (880), men UNDER varningsbannern och mörkt körläge
//     (900), modalerna (1000), fordonslarmet (1500) och rundturen (3000).
//     Samma resonemang som remsan i js/platsstart.js. Dyker något av det upp
//     medan pekaren står kvar stängs den dessutom helt — en förklaring får
//     aldrig konkurrera om blicken med något som varnar för verkligheten.
//   • Den rör inte css/app.css. Stilen läggs in i en egen <style>, precis som
//     js/platsstart.js gör, så filen kan laddas dynamiskt utan att krocka med
//     någon annan.
//
// Rörelsen är medvetet dämpad. Appen används i bil: en pil som studsar hårt
// eller en ring som blinkar drar blicken från vägen. Pilen rör sig tre pixlar
// på 2,2 sekunder, ringen andas i ljusstyrka utan att flytta sig, och
// prefers-reduced-motion stänger av allt.

/* ------------------------------------------------------------------ */
/* Förval                                                              */
/* ------------------------------------------------------------------ */

// Hur länge vi väntar in ett element som ännu inte syns. Panelen ska hinna
// öppnas och den mjuka rullningen hinna landa, men en förare ska aldrig sitta
// och vänta på en pil som inte kommer.
const VANTA_MS = 6000;

// Hur länge pekaren står kvar av sig själv. Lång nog att hinna läsas två
// gånger, kort nog att inte bli en sak man lär sig att titta förbi.
const VISA_MS = 12000;

// Hur länge vi som mest väntar på att en mjuk rullning ska landa.
//
// js/app.js väntar 420 ms rakt av, och det räcker för ett par hundra pixlar.
// Men Chrome låter den mjuka rullningen ta längre tid ju längre den är, och
// notisknappen ligger långt ner i inställningarna: mätt här blev sträckan
// 1537 px och rullningen pågick fortfarande när de 420 ms tagit slut. Hålet
// hamnade då där elementet LÅG. Därför väntar vi istället tills elementet
// slutat röra sig, med det här som tak.
const RULLNING_MAX_MS = 1500;
const RULLNING_STEG_MS = 60;

// Efter start ignoreras klick en kort stund. Anropas peka() inifrån en
// klickhanterare hinner samma klick annars nå vår egen lyssnare och stänga
// pekaren i samma andetag som den öppnades.
const NADATID_MS = 350;

const TICK_MS = 300;

/** Rutor som är viktigare än en pekare. Syns någon av dem — stäng. */
const VIKTIGARE = '.alert-banner, .fordonslarm, .morkt-lage, .modal, .auth-screen, ' +
                  '.tour, .voice-overlay, .pv-ps-skarm, dialog[open]';

/* ------------------------------------------------------------------ */
/* Stil                                                                */
/* ------------------------------------------------------------------ */
//
// Variablerna ur css/app.css med hårda reservvärden efter sig: filen kan
// laddas dynamiskt och ska se rätt ut även om den råkar köra före stilmallen.

const CSS = `
.pv-peka {
  position: fixed; inset: 0; z-index: 885;
  pointer-events: none;            /* fingret ska nå knappen vi pekar på */
  opacity: 0; transition: opacity .18s ease;
  font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
.pv-peka.pv-peka-inne { opacity: 1; }
.pv-peka[hidden] { display: none; }

.pv-peka-mask { position: absolute; inset: 0; width: 100%; height: 100%; }

.pv-peka-ring {
  position: absolute; border-radius: 16px;
  border: 2px solid var(--accent, #3d9dff);
  box-shadow: 0 0 0 4px rgba(61,157,255,.20), 0 0 26px rgba(61,157,255,.38);
  animation: pvPekaPuls 2.2s ease-in-out infinite;
}
/* Bara ljusstyrka, ingen storleksändring: en ring som växer och krymper
   drar blicken hårdare än den behöver. */
@keyframes pvPekaPuls {
  50% { box-shadow: 0 0 0 8px rgba(61,157,255,.11), 0 0 30px rgba(61,157,255,.48); }
}

.pv-peka-pil {
  position: absolute; font-size: 22px; line-height: 1;
  color: var(--accent, #3d9dff);
  text-shadow: 0 0 12px rgba(61,157,255,.65);
  animation: pvPekaGung 2.2s ease-in-out infinite;
}
@keyframes pvPekaGung { 50% { transform: translateY(-3px); } }

.pv-peka-rad { position: absolute; left: 12px; right: 12px; display: flex; }
.pv-peka-text {
  max-width: 320px;
  background: var(--bg-2, #141b23);
  border: 1px solid var(--line, #26323f);
  border-radius: 14px; padding: 11px 14px;
  color: var(--fg, #eef4fa);
  font-size: 14.5px; line-height: 1.45; font-weight: 550;
  box-shadow: 0 16px 40px rgba(0,0,0,.6);
}

/* Åksjuka och rörelsekänslighet: allt står stilla, ringen syns ändå. */
@media (prefers-reduced-motion: reduce) {
  .pv-peka { transition: none; }
  .pv-peka-ring, .pv-peka-pil { animation: none; }
}
`;

function injiceraCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('pv-peka-stil')) return;
  const s = document.createElement('style');
  s.id = 'pv-peka-stil';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* Små hjälpare                                                        */
/* ------------------------------------------------------------------ */

const sov = ms => new Promise(r => setTimeout(r, ms));

const dampadRorelse = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/**
 * Ett mål får anges på tre sätt, för att anroparen inte ska behöva veta om
 * elementet finns ännu:
 *   • 'btnNotify'            — ett id
 *   • elementet självt
 *   • () => element          — en funktion som körs om vid varje försök
 */
function hitta(mal) {
  try {
    if (!mal) return null;
    if (typeof mal === 'string') return document.getElementById(mal) || document.querySelector(mal);
    if (typeof mal === 'function') return mal() || null;
    if (mal.nodeType === 1) return mal;
  } catch {}
  return null;
}

/** Syns elementet på riktigt, eller är det bara med i DOM:en? */
function synligt(el) {
  if (!el || !el.isConnected) return false;
  if (!el.getClientRects().length) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

/** Ligger elementet inom skärmen, åtminstone delvis? */
function inomBild(r) {
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

function viktigareRutaUppe() {
  try {
    for (const el of document.querySelectorAll(VIKTIGARE)) {
      if (el.closest('.pv-peka')) continue;
      if (el.hasAttribute('hidden')) continue;
      if (el.getClientRects().length) return true;
    }
  } catch {}
  return false;
}

/* ------------------------------------------------------------------ */
/* Tillståndet — exakt en pekare åt gången                             */
/* ------------------------------------------------------------------ */
//
// Två pilar samtidigt pekar i praktiken på ingenting. En ny peka() stänger
// alltid den föregående istället för att lägga sig bredvid.

let lager = null;        // rotelementet
let malEl = null;        // elementet vi pekar på
let lage = null;         // 'auto' | 'over' | 'under'
let stangTimer = null;
let tickTimer = null;
let ramme = 0;           // requestAnimationFrame-id för omritningen
let losKlick = null;     // avregistrerare för klick/tangent/rullning
let korId = 0;           // varje start får ett nummer; gamla svar kastas

/* ------------------------------------------------------------------ */
/* Ritningen                                                           */
/* ------------------------------------------------------------------ */

// Varje pekare får ett eget mask-id. En stängd pekare tonar ut i tvåtiondels
// sekund innan den plockas bort, och under den tiden kan nästa redan vara
// byggd. Med ett fast id hade den nya mörkläggningen letat upp den döende
// pekarens mask — den som står först i dokumentet vinner — och därmed klippt
// hålet på fel ställe.
let maskNr = 0;

function bygg() {
  injiceraCss();
  const halId = `pvPekaHal${++maskNr}`;
  const rot = document.createElement('div');
  rot.className = 'pv-peka';
  // Mörkläggningen och pilen är dekor för den som ser. Texten är däremot
  // information, och den läggs i en role="status" så att en skärmläsare
  // säger den utan att fokus flyttas någonstans.
  rot.innerHTML = `
    <svg class="pv-peka-mask" aria-hidden="true">
      <defs>
        <mask id="${halId}">
          <rect width="100%" height="100%" fill="#fff"></rect>
          <rect class="pv-peka-hal" x="0" y="0" width="0" height="0" rx="16" fill="#000"></rect>
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgba(4,7,11,.62)" mask="url(#${halId})"></rect>
    </svg>
    <div class="pv-peka-ring" aria-hidden="true"></div>
    <div class="pv-peka-pil" aria-hidden="true">▲</div>
    <div class="pv-peka-rad"><div class="pv-peka-text" role="status"></div></div>`;
  document.body.appendChild(rot);
  return rot;
}

/**
 * Läs av elementets läge och flytta hål, ring, pil och text dit.
 *
 * Körs om vid varje rullning och varje tick. Den skriver bara — all logik om
 * huruvida pekaren fortfarande ska finnas ligger i tick().
 */
function rita() {
  if (!lager || !malEl) return;

  const hal = lager.querySelector('.pv-peka-hal');
  const ring = lager.querySelector('.pv-peka-ring');
  const pil = lager.querySelector('.pv-peka-pil');
  const rad = lager.querySelector('.pv-peka-rad');

  const r = malEl.getBoundingClientRect();

  // Elementet har rullat ut ur bild, eller gömts. Dölj hålet och pilen men
  // stäng inte: rullar föraren tillbaka ska pekaren stå kvar och peka.
  if (!synligt(malEl) || !inomBild(r)) {
    hal.setAttribute('width', '0');
    hal.setAttribute('height', '0');
    ring.style.display = 'none';
    pil.style.display = 'none';
    rad.style.display = 'none';
    return;
  }
  ring.style.display = '';
  pil.style.display = '';
  rad.style.display = '';

  const pad = 8;
  const x = Math.max(0, r.left - pad);
  const y = Math.max(0, r.top - pad);
  const w = Math.min(innerWidth - x, r.width + pad * 2);
  const h = Math.min(innerHeight - y, r.height + pad * 2);

  hal.setAttribute('x', x);
  hal.setAttribute('y', y);
  hal.setAttribute('width', Math.max(0, w));
  hal.setAttribute('height', Math.max(0, h));

  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.style.width = `${w}px`;
  ring.style.height = `${h}px`;

  // Texten hamnar på motsatt sida av det vi pekar på, så att den aldrig
  // skymmer själva knappen.
  const under = lage === 'under' || (lage !== 'over' && r.top < innerHeight / 2);

  const mitt = x + w / 2;
  pil.textContent = under ? '▲' : '▼';
  pil.style.left = `${Math.min(innerWidth - 34, Math.max(12, mitt - 11))}px`;
  pil.style.top = under ? `${y + h + 4}px` : `${y - 30}px`;

  // Raden är full bredd och texten läggs vid pilen — men aldrig utanför
  // kanten. Att räkna på det här sättet istället för att centrera bubblan på
  // pilen slipper vi klämma ihop texten vid skärmkanterna.
  rad.style.justifyContent =
    mitt < innerWidth * 0.34 ? 'flex-start' :
    mitt > innerWidth * 0.66 ? 'flex-end' : 'center';

  if (under) {
    rad.style.top = `${Math.min(innerHeight - 84, y + h + 34)}px`;
    rad.style.bottom = '';
  } else {
    rad.style.bottom = `${Math.min(innerHeight - 84, innerHeight - y + 34)}px`;
    rad.style.top = '';
  }
}

/** Rita om, men högst en gång per bildruta. */
function ritaSnart() {
  if (ramme) return;
  ramme = requestAnimationFrame(() => { ramme = 0; rita(); });
}

/* ------------------------------------------------------------------ */
/* Livslängden                                                         */
/* ------------------------------------------------------------------ */

/**
 * Var 300:e millisekund: lever elementet fortfarande, och har något
 * viktigare tagit skärmen?
 *
 * En ren rAF-slinga hade följt elementet mjukare, men den kostar ström varje
 * bildruta i en app som ligger på i timmar med skärmen tänd. Rullnings-
 * händelserna sköter det snabba följandet; ticken är bara ett skyddsnät för
 * layoutändringar som inte ger någon händelse alls.
 */
function tick() {
  if (!lager) return;
  if (viktigareRutaUppe()) { stang('viktigare-ruta'); return; }
  if (!malEl || !malEl.isConnected) { stang('malet-borta'); return; }
  rita();
}

export function stang(skal = 'stangd') {
  if (!lager) return;

  clearTimeout(stangTimer); stangTimer = null;
  clearInterval(tickTimer); tickTimer = null;
  if (ramme) { cancelAnimationFrame(ramme); ramme = 0; }
  losKlick?.(); losKlick = null;

  const dott = lager;
  lager = null;
  malEl = null;
  korId++;                                  // kasta svar som är på väg in

  dott.classList.remove('pv-peka-inne');
  // Vänta ut uttoningen innan elementet plockas bort. Vid dämpad rörelse är
  // övergången avstängd, och då ska det gå direkt.
  if (dampadRorelse()) dott.remove();
  else setTimeout(() => dott.remove(), 200);

  try {
    dispatchEvent(new CustomEvent('pv-peka-stangd', { detail: { skal } }));
  } catch {}
}

/** Är en pekare uppe just nu? */
export const pekarUppe = () => !!lager;

/**
 * Lyssnare som stänger pekaren, plus de som håller den på plats.
 * Klicklyssnarna kopplas in först efter nådatiden — se NADATID_MS.
 */
function kopplaLyssnare(mitt) {
  const av = [];
  const pa = (mal, typ, fn, opt) => {
    mal.addEventListener(typ, fn, opt);
    av.push(() => mal.removeEventListener(typ, fn, opt));
  };

  // Rullning i vilken behållare som helst: scroll bubblar inte, men den
  // fångas på vägen ner. Passivt, så att rullningen aldrig hackar.
  pa(window, 'scroll', ritaSnart, { capture: true, passive: true });
  pa(window, 'resize', ritaSnart);
  pa(window, 'orientationchange', ritaSnart);

  // Appen i bakgrunden: pekaren har spelat ut sin roll när föraren kommer
  // tillbaka, och en pil som stått kvar i tio minuter pekar sällan rätt.
  pa(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') stang('bakgrund');
  });

  // Escape som genväg. Inget preventDefault, ingen fokusflytt — pekaren ska
  // aldrig märkas för den som navigerar med tangentbord.
  pa(window, 'keydown', e => { if (e.key === 'Escape') stang('escape'); });

  const klick = () => stang('klick');
  const nada = setTimeout(() => {
    if (korId !== mitt) return;
    if (window.PointerEvent) pa(window, 'pointerdown', klick, { capture: true, passive: true });
    else {
      pa(window, 'mousedown', klick, { capture: true, passive: true });
      pa(window, 'touchstart', klick, { capture: true, passive: true });
    }
  }, NADATID_MS);
  av.push(() => clearTimeout(nada));

  losKlick = () => { for (const f of av) { try { f(); } catch {} } };
}

/* ------------------------------------------------------------------ */
/* Rullningen fram till elementet                                      */
/* ------------------------------------------------------------------ */

/**
 * Rulla in elementet i bild och vänta ut rullningen.
 *
 * Vi väntar inte en bestämd tid utan tills elementet slutat röra sig: en mjuk
 * rullning på tolv rader tar en bråkdel av vad en rullning genom hela
 * inställningspanelen tar, och båda ska landa rätt.
 *
 * Sista stycket är för det fall den mjuka rullningen aldrig ens startar. Det
 * händer när fliken ligger i bakgrunden — animeringen drivs av bildrutor, och
 * de kommer inte då. Kommer föraren tillbaka står pilen annars kvar och pekar
 * på tom skärm.
 */
async function rullaFram(el) {
  const mjukt = !dampadRorelse();
  try {
    el.scrollIntoView({ behavior: mjukt ? 'smooth' : 'auto', block: 'center' });
  } catch {
    try { el.scrollIntoView(); } catch {}
  }

  const slutar = Date.now() + RULLNING_MAX_MS;
  let forra = null;
  let stilla = 0;
  while (Date.now() < slutar) {
    await sov(RULLNING_STEG_MS);
    const y = Math.round(el.getBoundingClientRect().top);
    if (forra !== null && y === forra) { if (++stilla >= 2) break; } else stilla = 0;
    forra = y;
  }

  if (!inomBild(el.getBoundingClientRect())) {
    try { el.scrollIntoView({ block: 'center' }); } catch {}
    await sov(RULLNING_STEG_MS);
  }
}

/* ------------------------------------------------------------------ */
/* Ingången                                                            */
/* ------------------------------------------------------------------ */

/**
 * Peka på ett element och säg vad det är.
 *
 * @param {string|Element|Function} mal  id, css-väljare, elementet, eller en
 *        funktion som letar upp det. Funktionen körs om tills elementet dyker
 *        upp — det är så pekaren kan vänta in en panel som håller på att
 *        öppnas.
 * @param {string} text  En mening. Fingret ska veta vart det ska efter ett
 *        ögonkast, inte efter ett stycke.
 * @param {object} [opts]
 *   forbered  async funktion som körs först (öppna panelen, byt vy).
 *   rulla     rulla in elementet i bild först. Förval: true.
 *   plats     'auto' | 'over' | 'under' — var texten hamnar. Förval: 'auto'.
 *   vantaMs   hur länge vi väntar in elementet. Förval: 6000.
 *   visaMs    hur länge pekaren står kvar. 0 = tills något stänger den.
 *
 * @returns {Promise<{visad: boolean, skal: string}>}
 *   Misslyckas den är det tyst: en pil som pekar på fel ställe är sämre än
 *   ingen pil, och anroparen får själv avgöra om något annat ska sägas.
 */
export async function peka(mal, text, opts = {}) {
  if (typeof document === 'undefined') return { visad: false, skal: 'ingen-dom' };

  const {
    forbered = null,
    rulla = true,
    plats = 'auto',
    vantaMs = VANTA_MS,
    visaMs = VISA_MS,
  } = opts;

  stang('ersatt');                 // exakt en pekare åt gången
  const mitt = ++korId;
  const avbruten = () => mitt !== korId;

  try {
    if (forbered) await forbered();
  } catch {
    // En panel som inte gick att öppna är inte pekarens fel att laga. Vi
    // fortsätter — kanske låg elementet framme ändå.
  }
  if (avbruten()) return { visad: false, skal: 'avbruten' };

  // Vänta in elementet. Panelen kan behöva ritas om, listan fyllas på, och
  // vyn bytas — inget av det är klart i samma bildruta som anropet.
  const slutar = Date.now() + Math.max(0, vantaMs);
  let el = hitta(mal);
  while (!synligt(el)) {
    if (Date.now() >= slutar) return { visad: false, skal: 'elementet-kom-aldrig' };
    await sov(100);
    if (avbruten()) return { visad: false, skal: 'avbruten' };
    el = hitta(mal);
  }

  if (viktigareRutaUppe()) return { visad: false, skal: 'viktigare-ruta' };

  if (rulla) {
    await rullaFram(el);
    if (avbruten()) return { visad: false, skal: 'avbruten' };
    if (!synligt(el)) return { visad: false, skal: 'elementet-forsvann' };
  }

  malEl = el;
  lage = plats;
  lager = bygg();
  lager.querySelector('.pv-peka-text').textContent = text || '';

  rita();
  // Tona in först nästa bildruta, annars hoppar lagret fram utan övergång.
  // Timern är en reserv: ligger fliken i bakgrunden kommer ingen bildruta, och
  // utan den hade lagret blivit stående osynligt.
  const tona = () => { if (korId === mitt) lager?.classList.add('pv-peka-inne'); };
  requestAnimationFrame(tona);
  setTimeout(tona, 120);

  kopplaLyssnare(mitt);
  tickTimer = setInterval(tick, TICK_MS);
  if (visaMs > 0) stangTimer = setTimeout(() => stang('tiden-ute'), visaMs);

  return { visad: true, skal: 'visad' };
}

export default { peka, stang, pekarUppe };
