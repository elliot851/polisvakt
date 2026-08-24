// Rörelsen — appens enda ställe för rörelse i navigationen.
//
// Varför filen finns
// ------------------
// Animationerna i en bilapp har ett enda jobb: att förklara vart något tog
// vägen. Föraren tittar på skärmen i högst en sekund. Hinner han inte se
// varifrån den nya vyn kom, eller var han landade efter en genväg, får han
// leta — och att leta är precis det appen ska slippa kosta honom.
//
// Rörelsen bor i en egen fil och inte i css/app.css, av tre skäl:
//
//   1. Reglerna hänger ihop med koden som utlöser dem. En klass som läggs på
//      och tas av i JS men beskrivs 1600 rader bort i en annan fil driver
//      isär. Samma resonemang som js/peka.js och js/platsstart.js redan gör:
//      modulen tar med sig sin egen <style>.
//   2. Filen kan läsas som en lista över ALLA rörelser appen gör i sin
//      navigation. Går bildrutor förlorade är det här man tittar först.
//   3. css/app.css skrivs av andra händer parallellt. En injicerad <style>
//      kan inte krocka på radnivå med den filen.
//
// Reglerna, som inte får brytas
// -----------------------------
//   • ENDAST transform och opacity. Allt annat (left, height, box-shadow,
//     filter) tvingar fram omritning, och telefonen ritar samtidigt en karta
//     och läser en videoström. Höjder SNÄPPER, de animeras aldrig.
//   • Ingen enskild animation över 300 ms.
//   • prefers-reduced-motion stänger av allt utom det som BÄR information.
//     Bara ett av sex fall gör det: landningsringen, som svarar på frågan
//     "var hamnade jag?". Den blir en stilla ram i stället för två pulser.
//   • Ingenting här ligger över varningarna. Allt vi rör är antingen en vy
//     (som per definition ligger under tabbaren på z-index 800) eller en
//     ::after inuti en vy. Modulen skapar inget eget lager och inget eget
//     element på body — därför kan den inte hamna över varningsytan (905),
//     mörkt körläge (900), modalerna (1000), fordonslarmet (1500) eller
//     rundturen (3000).
//
// Två fällor som styrde hela utformningen
// ---------------------------------------
// FÄLLA 1 — transform gör ett element till containing block för position:
// fixed. #morktLage ligger som barn till #view-map (index.html rad 258) och
// är position: fixed; inset: 0. Ligger det kvar en transform på #view-map
// mäts mörkläggningen mot vyn i stället för mot skärmen, och då slutar den
// täcka tabbaren. Därför:
//
//   a) Varje animation här körs UTAN fill-mode och med bara ett from-block.
//      När speltiden är slut finns ingen transform kvar — inte ens
//      translateX(0) — även om städningen skulle missas. Rörelsen läker
//      sig själv. Det är den enda formen som inte kan lämna efter sig en
//      bugg som yttrar sig timmar senare.
//   b) Vyn flyttas aldrig medan något som mäter eller täcker skärmen är
//      uppe. Se farRoraVyn().
//
// FÄLLA 2 — rundturen mäter direkt efter vybytet. js/tour.js kallar
// onShowView('map') och läser getBoundingClientRect() i samma svep (rad 233
// och 427). Glider vyn just då klipps hålet arton pixlar fel och blir kvar
// så hela steget. Rundturen står därför överst i farRoraVyn().
//
// Varför bara den INKOMMANDE vyn rör sig
// --------------------------------------
// Att korsa två vyer förbi varandra hade varit tydligare, men vyerna är fyra
// syskon i samma DOM och den som ligger senare målar över den som ligger
// tidigare. Kartan hade då glidit ut OVANPÅ inställningarna. Att lösa det
// kräver z-index på vyerna, alltså ett nytt lager mitt i en ordning som
// ligger fast. Riktningen syns lika bra på vilken kant den nya vyn kommer
// in från, och kostar ingenting.

/* ------------------------------------------------------------------ */
/* Tider och kurva                                                     */
/* ------------------------------------------------------------------ */

// Vybyte. 180 ms är gränsen där ögat hinner uppfatta riktningen utan att
// tummen känner att den väntar. Kortare läses som ett hopp.
const VY_MS = 180;

// Hur långt den nya vyn kommer in från sidan. Arton pixlar räcker för att
// riktningen ska gå att avläsa i ögonvrån; mer och det blir en föreställning.
const VY_PX = 18;

// En grupp fälls ut. Höjden snäpper, bara innehållet tonar in.
const GRUPP_MS = 160;

// Filtret svarar. Ingen förflyttning — poängen är att raderna INTE rör sig
// medan man skriver, annars tappar man platsen mitt i ett ord.
const FILTER_MS = 110;

// Landningsringen: två pulser à 260 ms.
const RING_MS = 260;
const RING_PULSER = 2;

// Hur länge ringen står still när rörelse är avstängd. Lång nog att hinna
// hittas med blicken, kort nog att inte se ut som ett fel i gränssnittet.
const RING_STILLA_MS = 1500;

// Tryckkvittens. Ska kännas som ett svar, inte som en animation.
const KVITTENS_MS = 90;

// Små saker som dyker upp (rensa-krysset i sökfältet).
const IN_MS = 100;

// Samma kurva överallt: snabbt igång, mjukt i mål. Att blanda kurvor gör att
// två rörelser i samma gränssnitt känns som två olika appar.
const MJUK = 'cubic-bezier(.22,.61,.36,1)';

// Vilka element som får en tryckkvittens. Medvetet kort lista: en scale på
// fel element (rapportknapparna, reglagen) stör funktioner som redan har
// egen återkoppling, och scale på ett element med absolut placerade barn
// flyttar barnen med sig.
//
// [role="button"] på grupprubriken är inte prydnad. Attributet sätts av
// js/inst.js först när rubrikerna faktiskt har en hanterare. Utan villkoret
// gav vi tryckkvittens på sju rubriker i en utrullning där modulen saknades:
// rubriken krympte under fingret som en riktig knapp och gjorde sedan
// ingenting. Ett uteblivet svar är ett fel; ett svar som ljuger är värre.
// .act (kartans Polis/Kontroll/Civil/TALA) står MED FLIT inte här: den har
// egen :active-krympning i css/app.css OCH en håll-in-fyllnad (.act.holding),
// och en rr-tryck ovanpå hade slagits mot hållgesten. Alla andra tryckytor —
// primär- och spökknappar, köplänken, sök- och ikonknappen, modalernas
// knappar, produktsidans tillbaka — saknade kvittens helt tills raden nedan.
const KVITTENS_MAL =
  '.tab, #view-settings h2.grupp[role="button"], #view-settings button, ' +
  '.btn-primary, .btn-ghost, a.btn-kop, .route-go, .icon-btn, ' +
  '.modal button, .platform-pick button, .pd-tillbaka';

// Rullningen ska landa UNDER den klistrade sökraden, inte bakom den.
//
// Talet ÄGS av css/app.css (--rr-rull-marginal, definierad i :root), och det
// nedanför är bara en reserv för det fall stilmallen inte hunnit läsas.
// Reserven stod tidigare på 104px, räknad som "sökrad 52 + grupprubrik 52" —
// två siffror som ingendera stämde: sökraden är 64 hög och fastnar 16 px ner
// (rullbehållarens padding), medan grupprubriken inte är klistrad alls och
// därför inte ska räknas. Mätt utfall: var åttonde skärmpixel lämnades tom
// ovanför det genvägen pekade på.
const RULL_MARGINAL = 'calc(var(--safe-top, 0px) + 88px)';

/* ------------------------------------------------------------------ */
/* Stilen                                                              */
/* ------------------------------------------------------------------ */

const CSS = `
/* Alla animationer nedan saknar fill-mode med flit. Se FÄLLA 1 överst. */

/* 1. Vybyte — den nya vyn kommer in från den kant den ligger åt i tabbaren. */
@keyframes rr-vy-in {
  from { opacity: 0; transform: translateX(var(--rr-dx, 0px)); }
}
/* Utan will-change, med flit. Animationen lyfter redan upp vyn i ett eget
   lager medan den spelas, och will-change: transform gör dessutom elementet
   till containing block för position: fixed — samma fälla som transformen
   själv, fast med en egen livslängd att hålla reda på. En risk räcker. */
.rr-vy-in { animation: rr-vy-in ${VY_MS}ms ${MJUK}; }

/* 2. En grupp fälls ut. Höjden snäpper — bara innehållet tonar in, och det
      lilla lyftet säger att det kom ur raden man tryckte på. */
@keyframes rr-avsloja {
  from { opacity: 0; transform: translateY(6px); }
}
.rr-avsloja { animation: rr-avsloja ${GRUPP_MS}ms ${MJUK}; }

/* 3. Filtret svarade. Ingen förflyttning, bara en kvittens på att listan är
      ny. Börjar på .55 och inte på 0: en lista som blinkar svart vid varje
      tangenttryck är värre än ingen kvittens alls. */
@keyframes rr-filter {
  from { opacity: .55; }
}
.rr-filter { animation: rr-filter ${FILTER_MS}ms linear; }

/* 4. Landningsringen. Enda rörelsen som bär information: den svarar på
      "var hamnade jag?" efter en genväg. Ligger som ::after så att inget
      eget element behöver skapas och inget kan bli kvar på body.
      Grundläget är opacity 0, så när animationen tar slut försvinner ringen
      av sig själv även om klassen skulle bli kvar. */
.rr-landad::after {
  content: '';
  position: absolute; inset: -4px;
  border-radius: 14px;
  border: 2px solid var(--ring, rgba(61,157,255,.55));
  pointer-events: none;
  opacity: 0;
  animation: rr-ring ${RING_MS}ms ease-out ${RING_PULSER};
}
@keyframes rr-ring {
  from { opacity: 1; transform: scale(1.03); }
  to   { opacity: 0; transform: scale(1); }
}

/* 5. Tryckkvittens. Transitionen ligger på klassen och inte på elementet, så
      att inget i appen bär med sig en transform-transition den inte bad om. */
.rr-tryck      { transform: scale(.985); transition: transform ${KVITTENS_MS}ms ease-out; }
.rr-tryck-slut { transition: transform ${KVITTENS_MS}ms ease-out; }

/* 6. Något litet dyker upp (rensa-krysset i sökfältet). */
@keyframes rr-in {
  from { opacity: 0; transform: scale(.8); }
}
.rr-in { animation: rr-in ${IN_MS}ms ${MJUK}; }

/* Rullningsmålet ska hamna under den klistrade sökraden, inte bakom den.
   Listan är bred med flit: genvägarna pekar på allt från en <section> till
   en enskild knapp (btnBehNotiser) och en underrubrik (minaFordonRubrik).
   Mätt: minaFordonRubrik är en h4.sub-head, och med bara section/h2/h3 i
   listan landade den bakom sökraden. */
#view-settings section,
#view-settings h2,
#view-settings h3,
#view-settings h4,
#view-settings button,
#view-settings .row {
  scroll-margin-top: var(--rr-rull-marginal, ${RULL_MARGINAL});
}

/* Åksjuka och rörelsekänslighet.
   Fem av sex rörelser stängs av helt — de är kvitton, och kvittot finns kvar
   i själva lägesbytet. Ringen är undantaget: den BÄR information om var man
   landade, och ersätts av en stilla ram som JS tar bort efter
   ${RING_STILLA_MS} ms. */
@media (prefers-reduced-motion: reduce) {
  .rr-vy-in, .rr-avsloja, .rr-filter, .rr-in { animation: none; }
  .rr-tryck, .rr-tryck-slut { transition: none; transform: none; }
  .rr-landad::after { animation: none; opacity: 1; }
}
`;

function injiceraCss() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById('pv-rorelse-stil')) return;
  const s = document.createElement('style');
  s.id = 'pv-rorelse-stil';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* Små hjälpare                                                        */
/* ------------------------------------------------------------------ */

let dampadMq = null;

/**
 * Läses vid varje anrop och inte en gång vid start: inställningen kan slås
 * på mitt i en resa, och den som just blivit åksjuk ska inte behöva starta
 * om appen för att slippa rörelsen.
 */
export function dampad() {
  try {
    if (!dampadMq) dampadMq = matchMedia('(prefers-reduced-motion: reduce)');
    return !!dampadMq.matches;
  } catch { return false; }
}

/**
 * Lägg på en klass som spelar en animation, och ta bort den när den är slut.
 *
 * Klassen tas alltid bort på TID och inte på animationend. animationend
 * uteblir när fliken går i bakgrunden mitt i animationen, och då hade
 * klassen blivit kvar för alltid. Tiden är dessutom känd — vi skrev den själva.
 */
function spela(el, klass, ms) {
  if (!el) return;
  spelaFlera([el], klass, ms);
}

/**
 * Samma sak för många element på en gång — med EN tvingad layout, inte en per
 * element.
 *
 * Skillnaden är inte teoretisk. spela() i en slinga gör
 * remove → void offsetWidth → add för varje element, och den mellersta raden
 * tvingar webbläsaren att räkna om layouten på fläcken. Mätt på sju
 * sektioner i inställningsvyn, fem omgångar: 3,8 / 4,1 / 4,5 / 6,0 ms mot
 * 0,0 / 0,1 / 0,2 ms när hela gruppen får dela på en enda omflödning. Fyrtio
 * gånger dyrare, på en stationär dator — och det inträffar i exakt det
 * ögonblick föraren trycker på en grupprubrik, alltså precis där animationen
 * ska förklara vad som hände.
 *
 * Layouten läses på document.body och inte på något av elementen: vad vi
 * läser spelar ingen roll, det enda som behövs är att webbläsaren tömmer sin
 * kö av stiländringar en gång mellan remove och add.
 */
function spelaFlera(lista, klass, ms) {
  const el = [...lista].filter(Boolean);
  if (!el.length) return;

  for (const e of el) e.classList.remove(klass);
  // Läs fram en layout så att webbläsaren ser klassen försvinna och komma
  // tillbaka. Utan den här raden startar samma animation aldrig om, och en
  // andra genväg till samma reglage skulle inte visa någon ring alls.
  void document.body.offsetWidth;
  for (const e of el) e.classList.add(klass);

  setTimeout(() => { for (const e of el) e.classList.remove(klass); }, ms + 40);
}

/* ------------------------------------------------------------------ */
/* 1. Vybyte                                                           */
/* ------------------------------------------------------------------ */

// Reserv om tabbaren inte gick att läsa. Ordningen står i index.html och
// läses därifrån vid varje byte — en handskriven kopia hade tyst börjat
// peka åt fel håll den dagen någon flyttar en flik.
const VY_RESERV = ['map', 'dashcam', 'chatt', 'butik', 'settings'];

function vyOrdning() {
  try {
    const tabbar = [...document.querySelectorAll('.tabbar .tab[data-view]')]
      .map(t => t.dataset.view);
    if (tabbar.length >= 2) return tabbar;
  } catch { /* faller igenom */ }
  return VY_RESERV;
}

const STOPPARE = '.tour, .morkt-lage, .alert-banner, .pv-varningsyta, .fordonslarm';

/**
 * Får vyn flyttas just nu?
 *
 * Fyra fall säger nej, och alla fyra är mätta och inte antagna:
 *
 *   • Rundturen är uppe. Den mäter elementets position i samma ögonblick som
 *     den byter vy (js/tour.js rad 233 → 427). Rör sig vyn hamnar hålet fel
 *     och blir kvar där hela steget.
 *   • Mörkt körläge är uppe. #morktLage är position: fixed och ligger INUTI
 *     #view-map. En transform på vyn gör vyn till dess containing block, och
 *     då slutar mörkläggningen täcka tabbaren. Se FÄLLA 1.
 *   • En varning syns. Varningsytan och fordonslarmet ligger visserligen på
 *     body och påverkas inte, men varningsbannern ligger i kartvyn — och
 *     framför allt: när något varnar ska ingenting annat röra sig på skärmen.
 *   • Rörelse är avstängd i telefonen.
 *
 * Mätt: kontrollen görs efter att den gamla vyn fått hidden, så ett
 * mörkt körläge som låg i den vy man LÄMNAR har redan nollställd storlek och
 * räknas inte. Det är rätt — transformen läggs på den vy man kommer TILL, och
 * det är bara den vyns egna fasta barn som kan hamna fel. Provkört åt båda
 * hållen.
 */
function farRoraVyn() {
  if (dampad()) return false;
  try {
    if (document.body?.classList.contains('tour-open')) return false;
    /*
     * Synligheten mäts med getClientRects() och inte med [hidden].
     *
     * Fordonslarmet och varningsytan LIGGER kvar i DOM:en hela tiden och
     * göms med hidden respektive display: none — mätt: en sökning på
     * '.fordonslarm' träffar i en app där ingenting alls är på gång. Ett
     * villkor på attributet hade därför stängt av rörelsen permanent, och
     * det felet syns inte: allt fungerar, det bara slutar röra sig. Samma
     * mätning som stallInBehRadTopp() i js/app.js använder.
     */
    for (const el of document.querySelectorAll(STOPPARE)) {
      if (el.getClientRects().length) return false;
    }
  } catch { return false; }
  return true;
}

/**
 * Vybyte med riktning.
 *
 * Anropas EFTER att vyerna bytt hidden — vi animerar den som redan står
 * framme, inte en som är på väg fram. Kommer man från en flik till höger
 * glider den nya in från vänster, och tvärtom: samma modell som fingrarna
 * har på tabbaren.
 *
 * Är riktningen okänd (första ritningen, eller ett anrop från kod i stället
 * för ett tryck) händer ingenting alls. En rörelse utan riktning förklarar
 * ingenting och kostar ändå bildrutor.
 */
export function bytVy(fran, till) {
  if (!till || fran === till) return;
  if (!farRoraVyn()) return;

  const el = document.getElementById('view-' + till);
  if (!el) return;

  const ordning = vyOrdning();
  const i = ordning.indexOf(fran);
  const j = ordning.indexOf(till);
  if (i < 0 || j < 0 || i === j) return;

  el.style.setProperty('--rr-dx', (j > i ? VY_PX : -VY_PX) + 'px');
  spela(el, 'rr-vy-in', VY_MS);
  // Variabeln städas bort med lite marginal efter animationen. Den gör ingen
  // skada om den ligger kvar, men en vilsen --rr-dx i inspektorn är en fråga
  // någon annars måste ställa sig om ett år.
  setTimeout(() => el.style.removeProperty('--rr-dx'), VY_MS + 120);
}

/* ------------------------------------------------------------------ */
/* 2. Grupp fälls ut                                                   */
/* ------------------------------------------------------------------ */

/**
 * Innehållet i en nyss öppnad grupp tonar in med ett litet lyft.
 *
 * Tar emot elementen som just blev synliga — sektionerna är syskon till
 * grupprubriken, inte barn till den, så det finns ingen behållare att peka
 * på. Alla rör sig samtidigt och inte i trappa: en trappa på sju kort tar
 * över en halv sekund, och då är regeln bruten fast varje enskilt steg är
 * kort.
 *
 * Höjden animeras ALDRIG. Den snäpper, och det är hela skälet till att den
 * här formen får plats i en app som samtidigt ritar en karta.
 */
export function avslojaGrupp(element) {
  if (dampad()) return;
  const lista = element == null ? []
    : (element instanceof Element ? [element] : [...element]);
  // spelaFlera och inte spela i en slinga. Se kommentaren där: en tvingad
  // layout per sektion kostade fyrtio gånger mer än en för hela gruppen.
  spelaFlera(lista, 'rr-avsloja', GRUPP_MS);
}

/* ------------------------------------------------------------------ */
/* 3. Filtret svarade                                                  */
/* ------------------------------------------------------------------ */

/**
 * Kvittens på att sökningen räknat om. Ingen förflyttning, med flit: att
 * raderna står still medan man skriver är hela poängen.
 */
export function filterSvar(el) {
  if (dampad()) return;
  spela(el, 'rr-filter', FILTER_MS);
}

/* ------------------------------------------------------------------ */
/* 4. Landningsringen                                                  */
/* ------------------------------------------------------------------ */

const ringTimers = new WeakMap();

/**
 * Säg var man landade.
 *
 * Utan den här ser föraren bara text glida förbi och måste själv gissa
 * vilket av tjugo reglage genvägen syftade på. Det är den enda rörelsen i
 * filen som överlever prefers-reduced-motion, eftersom den bär information
 * och inte bara är ett kvitto: då blir den en stilla ram i stället.
 *
 * position: relative sätts som inline-stil och bara när elementet är
 * statiskt. Ringen är en ::after med inset: -4px och måste mätas mot
 * elementet självt — annars hamnar den vid närmaste placerade förfader, som
 * kan vara hela vyn. En relative utan förskjutningar flyttar ingenting.
 */
export function landa(el) {
  if (!el) return;

  try {
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  } catch { /* strunt i det: ringen hamnar då fel, men inget går sönder */ }

  clearTimeout(ringTimers.get(el));

  if (dampad()) {
    el.classList.remove('rr-landad');
    void el.offsetWidth;
    el.classList.add('rr-landad');
    ringTimers.set(el, setTimeout(() => el.classList.remove('rr-landad'), RING_STILLA_MS));
    return;
  }

  const total = RING_MS * RING_PULSER;
  el.classList.remove('rr-landad');
  void el.offsetWidth;
  el.classList.add('rr-landad');
  ringTimers.set(el, setTimeout(() => el.classList.remove('rr-landad'), total + 40));
}

/* ------------------------------------------------------------------ */
/* 5. Tryckkvittens                                                    */
/* ------------------------------------------------------------------ */

/**
 * En scale på 1,5 % när fingret går ner, tillbaka när det släpper.
 *
 * I en gupp på nittio är det inte självklart att man träffade. Utan kvittens
 * trycker föraren en gång till, och två tryck på en grupprubrik är samma sak
 * som noll.
 *
 * pointerdown och inte click: kvittensen ska komma när fingret rör skärmen,
 * inte när webbläsaren bestämt sig för att det var ett klick.
 */
function kvitteraNer(e) {
  if (dampad()) return;
  const el = e.target?.closest?.(KVITTENS_MAL);
  if (!el) return;
  el.classList.remove('rr-tryck-slut');
  el.classList.add('rr-tryck');
}

function kvitteraUpp() {
  for (const el of document.querySelectorAll('.rr-tryck')) {
    el.classList.remove('rr-tryck');
    el.classList.add('rr-tryck-slut');
    setTimeout(() => el.classList.remove('rr-tryck-slut'), KVITTENS_MS + 40);
  }
}

/* ------------------------------------------------------------------ */
/* 6. Något litet dyker upp                                            */
/* ------------------------------------------------------------------ */

export function tonaIn(el) {
  if (dampad()) return;
  spela(el, 'rr-in', IN_MS);
}

/* ------------------------------------------------------------------ */
/* Rullning                                                            */
/* ------------------------------------------------------------------ */

/**
 * Rulla fram ett element i inställningarna.
 *
 * Ligger här och inte hos anroparen av ett enda skäl: valet mellan smooth
 * och auto hör ihop med prefers-reduced-motion, och den regeln ska finnas på
 * ETT ställe. En mjuk rullning är en rörelse som andra, och den som stängt
 * av rörelse ska landa direkt.
 *
 * Avståndet till den klistrade sökraden ligger i scroll-margin-top ovan, inte
 * i en uträkning här. En uträkning hade behövt känna till sökradens höjd, och
 * det är exakt den sortens andra kopia som driver isär.
 */
export function rullaTill(el, { block = 'start' } = {}) {
  if (!el?.scrollIntoView) return;
  try {
    el.scrollIntoView({ behavior: dampad() ? 'auto' : 'smooth', block });
  } catch {
    el.scrollIntoView();
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

let startad = false;

export function start() {
  if (startad || typeof document === 'undefined') return;
  startad = true;

  injiceraCss();

  // Passiva lyssnare: kvittensen får aldrig kunna fördröja en rullning.
  document.addEventListener('pointerdown', kvitteraNer, { passive: true });
  document.addEventListener('pointerup', kvitteraUpp, { passive: true });
  document.addEventListener('pointercancel', kvitteraUpp, { passive: true });
  // Fingret kan lämna skärmen utanför elementet, och synlighetsbytet kan
  // komma mitt i ett tryck. Båda hade annars lämnat kvar en hoptryckt knapp.
  addEventListener('blur', kvitteraUpp);
  document.addEventListener('visibilitychange', kvitteraUpp);
}

/*
 * Bron till js/inst.js.
 *
 * Inställningsvyns egen modul importerar helst härifrån med en vanlig
 * import. Bindningen på window finns för att filerna byggs var för sig och
 * för att rörelserna ska gå att provköra från konsolen i en riktig telefon —
 * det är enda sättet att se om en animation tappar bildrutor när kartan och
 * dashcamen är igång samtidigt.
 */
export const Rorelse = {
  start, bytVy, avslojaGrupp, filterSvar, landa, tonaIn, rullaTill, dampad,
};

if (typeof window !== 'undefined') window.Rorelse = Rorelse;
