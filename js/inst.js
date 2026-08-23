// Inställningsvyn — hopfällning, sökning och genvägar.
//
// Varför filen finns
// ------------------
// Vyn har fyrtiotalet innehållsblock. Som en enda rulle är den mätt 27
// skärmar lång, och att hitta Bilingenkännaren krävde nio svep. Föraren
// ställer in appen EN gång, i stillastående bil — därför får inställningarna
// vara DJUPA. De får inte vara långa.
//
// Två vägar in, och bara två:
//
//   1. Sju grupprubriker som landmärken. Allt ligger hopfällt från start,
//      så vyn ryms på en skärm och man väljer riktning innan man rullar.
//   2. Sökfältet. Den som vet vad han letar efter ska inte behöva veta
//      vilken grupp VI råkade lägga det i. Skriver han "regnr" ska
//      Bilingenkännaren upp, oavsett gruppering.
//
// Kontraktet mot index.html
// -------------------------
//   • Varje kort och varje grupprubrik bär data-grupp="<nyckel>".
//     Rubriken är h2.grupp, korten är dess SYSKON — ingen omkapsling.
//     Omkapsling är den enda redigering där ett helt block kan försvinna
//     utan att något ser trasigt ut, så vi rör inte trädet.
//   • data-alltid-oppen="1" betyder: kollapsen får ALDRIG sätta hidden här.
//     Gruppen "hjalte" (rutten och behörigheterna) har ingen rubrik och är
//     det enda som rörs medan bilen rullar.
//   • data-sok="..." är extra sökord utöver kortets egen text. Den som söker
//     "regnr" ska hitta ett kort som bara skriver "registreringsnummer".
//   • Inget hidden står på korten i HTML:en. Laddar den här filen inte —
//     trasig utrullning, gammal service worker — får föraren den gamla flata
//     rullen i stället för en tom skärm. En lång vy är sämre än en kort, men
//     en tom vy är sämre än båda.
//   • Grupprubrikerna har VARKEN role, tabindex eller aria-expanded i
//     markupen, och sökraden står med hidden. Allt det sätts här nere,
//     efter att lyssnarna finns. Skälet är mätt och inte teoretiskt: när
//     modulen saknades låg sju rubriker kvar med role="button" och svarade
//     inte på vare sig tryck eller Enter, och sökfältet tog emot text utan
//     att filtrera något. En kontroll som ser tryckbar ut och inte är det
//     lär föraren att gränssnittet är trasigt — det är värre än ingen
//     kollaps alls.
//
// Rörelsen bor i js/rorelse.js, inte här. Skälet är detsamma som där: alla
// animationer i navigationen ska gå att läsa på ett ställe när bildrutor
// försvinner.

import { Rorelse } from './rorelse.js';

const VY_ID = 'view-settings';

/* Grupperna i den ordning de står i index.html. Byggs vid start ur DOM:en
   och inte ur en handskriven lista — en kopia här hade tyst börjat peka fel
   den dagen någon flyttar ett kort. */
let grupper = new Map();   // nyckel -> { rubrik, sektioner[], text }
let vy = null;
let falt = null;           // #sokInstallning
let knappAlla = null;      // #btnOppnaAlla
let traffrad = null;       // #sokTraffar
let rensaKryss = null;     // skapas här, finns inte i markupen
let sokning = '';          // aktuell sökterm, tom sträng = ingen sökning

/* ------------------------------------------------------------------ */
/* Stilen som hör ihop med koden här                                   */
/* ------------------------------------------------------------------ */

/*
 * Bara det som JS självt skapar eller styr. Grupprubrikernas utseende,
 * sökradens klistring och kedjerutan ligger i css/app.css, eftersom de
 * finns i markupen även när den här filen uteblir — och då ska de ändå se ut
 * som något man kan läsa.
 *
 * Här ligger alltså tre saker: hopfällningens egen klass, rensa-krysset (som
 * skapas nedan) och det som bara gäller under en pågående sökning.
 */
const CSS = `
/* Hopfällt kort. Egen klass och inte hidden-attributet — se doljAvOss()
   längre ner: appen äger hidden, vi äger den här, och kortet syns när båda
   säger ja. Ligger under ett id-selektor så att den vinner över .card utan
   !important. */
#${VY_ID} .inst-fallt { display: none; }

/* Rensa-krysset. 48x48 med flit: fältet töms med tummen i en gungande bil,
   och ett 24px kryss är samma sak som inget kryss. */
.sok-rensa {
  width: 48px; height: 48px; flex: none;
  display: grid; place-items: center;
  background: var(--bg-3, #212d3b);
  border: 1px solid var(--line-stark, #44586f);
  border-radius: var(--radius-2, 12px);
  color: var(--fg, #eef4fa); font-size: 17px; line-height: 1;
}
.sok-rensa[hidden] { display: none; }

/* Under en sökning är grupprubriken en etikett över sina träffar, inte en
   knapp — trycker man på den mitt i en sökning vet ingen vad som ska hända
   med filtret. Pilen tas bort så att löftet inte ens ges. */
#${VY_ID}.sok-aktiv h2.grupp::after { display: none; }
#${VY_ID}.sok-aktiv h2.grupp { cursor: default; }
`;

function injiceraCss() {
  if (document.getElementById('pv-inst-stil')) return;
  const s = document.createElement('style');
  s.id = 'pv-inst-stil';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* Bygg registret                                                      */
/* ------------------------------------------------------------------ */

/**
 * Normalisera text för jämförelse.
 *
 * Gemener och hoptryckta blanksteg, inget mer. Å, Ä och Ö får INTE vikas
 * ihop till a och o: "far" och "får" är olika ord, och en förare som söker
 * "får" ska inte få träff på "farthinder". Bindestreck plattas däremot ut,
 * eftersom "reg-nr" och "regnr" är samma sak för den som skriver snabbt.
 */
function norm(s) {
  return (s || '').toLowerCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

function byggRegister() {
  grupper = new Map();
  const barn = [...vy.children];

  for (const el of barn) {
    const nyckel = el.dataset?.grupp;
    if (!nyckel) continue;

    if (!grupper.has(nyckel)) {
      grupper.set(nyckel, { rubrik: null, sektioner: [], alltidOppen: false, oppen: false });
    }
    const g = grupper.get(nyckel);

    if (el.tagName === 'H2' && el.classList.contains('grupp')) { g.rubrik = el; continue; }

    g.sektioner.push(el);
    if (el.dataset.alltidOppen === '1') g.alltidOppen = true;
  }

  /* Söktexten läses EN gång. textContent på fyrtiotalet kort vid varje
     tangenttryck är den sortens kostnad som inte syns förrän man skriver
     fort — och man skriver fort just när man har bråttom. */
  for (const g of grupper.values()) {
    g.rubriktext = norm(g.rubrik ? g.rubrik.textContent : '');
    for (const s of g.sektioner) {
      s._pvSok = norm((s.dataset.sok || '') + ' ' + s.textContent);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hopfällning                                                         */
/* ------------------------------------------------------------------ */

/*
 * Hopfällningen använder en EGEN klass, inte hidden-attributet.
 *
 * `s.hidden = !oppen` rakt av hade varit kortare och fel. Ett kort i den här
 * vyn kan vara dolt av helt andra skäl än hopfällningen — telefonen saknar
 * funktionen kortet beskriver, kontot har inte den planen, mikrofonen finns
 * inte. Med ett gemensamt attribut skriver de två ägarna över varandra: en
 * grupp som öppnas väcker kort som appen medvetet gömt, och felet syns inte
 * som ett fel — det ser ut som att appen erbjuder något som inte finns.
 *
 * Ett dataset-märke ("jag var den som gömde det här") räcker inte heller.
 * Göms kortet av annan kod MEDAN gruppen är hopfälld är märket redan satt,
 * och nästa öppning tar fram det ändå. Provkört, och det gick precis så.
 *
 * Med en egen klass äger vi ett spår och appen ett annat. Kortet syns när
 * BÅDA säger ja, och ingen av oss behöver veta om den andra.
 */
function doljAvOss(el) {
  el.classList.add('inst-fallt');
}

/** @returns {boolean} true om elementet FAKTISKT blev synligt av anropet */
function visaAvOss(el) {
  if (!el.classList.contains('inst-fallt')) return false;
  el.classList.remove('inst-fallt');
  return !el.hidden;      // kan fortfarande vara gömt av appen
}

/** Syns kortet just nu — oavsett vem som gömt det? */
function synlig(el) {
  return !el.hidden && !el.classList.contains('inst-fallt');
}

/**
 * Sätt en grupps läge.
 *
 * @param {object} g       posten ur registret
 * @param {boolean} oppen  önskat läge
 * @param {boolean} rorelse  ska innehållet tona in? Falskt vid start och
 *                           vid "fäll ihop", där det inte finns något att
 *                           förklara.
 */
function sattGrupp(g, oppen, rorelse = true) {
  /* Hjälteytan kan inte stängas. Kontraktet står i index.html: gruppen har
     ingen rubrik, och en loop som blint stänger varje grupp den hittar
     skulle gömma det enda avsnitt som rörs under körning. */
  if (g.alltidOppen) oppen = true;

  g.oppen = oppen;
  if (g.rubrik) g.rubrik.setAttribute('aria-expanded', oppen ? 'true' : 'false');

  const framme = [];
  for (const s of g.sektioner) {
    if (oppen) { if (visaAvOss(s)) framme.push(s); }
    else doljAvOss(s);
  }

  /* Bara de kort som verkligen kom fram animeras. Ett kort som låg dolt av
     annan anledning ska inte tona in — det är fortfarande dolt. */
  if (oppen && rorelse && framme.length) Rorelse.avslojaGrupp(framme);
}

function allaOppna() {
  for (const g of grupper.values()) if (g.rubrik && !g.oppen) return false;
  return true;
}

function synkaKnappAlla() {
  if (!knappAlla) return;
  const alla = allaOppna();
  knappAlla.setAttribute('aria-expanded', alla ? 'true' : 'false');
  knappAlla.textContent = alla ? 'Fäll ihop allt' : 'Öppna allt';
}

function vaxlaGrupp(rubrik) {
  const g = grupper.get(rubrik.dataset.grupp);
  if (!g) return;
  /* Mitt i en sökning är rubriken en etikett, inte en knapp. Se CSS ovan. */
  if (sokning) return;
  sattGrupp(g, !g.oppen);
  synkaKnappAlla();
}

/* ------------------------------------------------------------------ */
/* Sökningen                                                           */
/* ------------------------------------------------------------------ */

/**
 * Filtrera vyn.
 *
 * Tre lägen, och skillnaden mellan dem är hela poängen:
 *
 *   • Tom sökning  — tillbaka till hopfällningens läge, precis som det var
 *     innan man började skriva. Att alltid falla tillbaka till "allt stängt"
 *     hade tagit ifrån föraren den grupp han just öppnat.
 *   • Träffar      — bara de kort som matchar syns, deras grupprubriker står
 *     kvar som etiketter så man ser VAR träffen bor.
 *   • Inga träffar — allt göms och raden säger det rent ut. En vy som blir
 *     tom utan förklaring läses som en krasch.
 *
 * Ingenting rullar och ingenting flyttar sig medan man skriver. Se
 * Rorelse.filterSvar: kvittensen är en toning, inte en förflyttning, för att
 * man inte ska tappa platsen mitt i ett ord.
 */
function filtrera() {
  const q = norm(falt ? falt.value : '');
  sokning = q;

  if (rensaKryss) {
    const visa = !!q;
    if (visa && rensaKryss.hidden) { rensaKryss.hidden = false; Rorelse.tonaIn(rensaKryss); }
    else rensaKryss.hidden = !visa;
  }

  if (!q) {
    vy.classList.remove('sok-aktiv');
    for (const g of grupper.values()) {
      if (g.rubrik) g.rubrik.hidden = false;
      /* Återställ till hopfällningens läge utan intoning: det här är inte
         ett nytt val, det är en ångring. g.oppen rördes aldrig av filtret,
         så gruppen han öppnade innan han började skriva står kvar öppen. */
      sattGrupp(g, g.oppen, false);
    }
    if (traffrad) traffrad.textContent = '';
    synkaKnappAlla();
    Rorelse.filterSvar(vy);
    return;
  }

  vy.classList.add('sok-aktiv');

  /* Flera ord = alla måste finnas, i valfri ordning. "kamera ljud" ska hitta
     kortet som handlar om båda och inte de trettio som handlar om ettdera. */
  const ord = q.split(' ').filter(Boolean);
  const matchar = text => ord.every(o => text.includes(o));

  let traffar = 0;

  for (const g of grupper.values()) {
    /* Träff på gruppnamnet visar hela gruppen. Skriver man "ljud" är det
       gruppen man menar, inte de fyra kort som råkar nämna ordet. */
    const helGrupp = !!g.rubriktext && matchar(g.rubriktext);
    let nagon = false;

    for (const s of g.sektioner) {
      const traff = helGrupp || matchar(s._pvSok);
      if (traff) visaAvOss(s); else doljAvOss(s);
      /* synlig() och inte bara traff: ett kort som appen gömt räknas inte
         som en träff, hur väl det än matchar. Att säga "3 träffar" och visa
         två är samma sorts lögn som en knapp som inte gör något. */
      if (traff && synlig(s)) { nagon = true; traffar++; }
    }

    if (g.rubrik) {
      g.rubrik.hidden = !nagon;
      g.rubrik.setAttribute('aria-expanded', 'true');
    }
  }

  if (traffrad) {
    traffrad.textContent = traffar === 0
      ? `Inget matchar "${falt.value.trim()}". Prova ett kortare ord.`
      : traffar === 1 ? '1 träff.' : `${traffar} träffar.`;
  }

  Rorelse.filterSvar(vy);
}

function rensaSok({ behallFokus = false } = {}) {
  if (!falt || !falt.value) return false;
  falt.value = '';
  filtrera();
  if (behallFokus) falt.focus();
  return true;
}

/* ------------------------------------------------------------------ */
/* Genvägen utifrån                                                    */
/* ------------------------------------------------------------------ */

/**
 * Öppna gruppen ett reglage bor i, rulla dit och ringa in det.
 *
 * Anropas från js/app.js oppnaInstallning(), som redan har bytt vy. Svarar
 * vi med null tar reserven där över — den kan bara ta bort hidden och rulla,
 * men det är bättre än ingenting.
 *
 * Sökningen rensas först, och det är avsiktligt: en genväg som landar mitt i
 * ett filtrerat läge visar ett reglage omgivet av tomhet, och då vet föraren
 * inte om resten av appen försvann.
 *
 * @param {string|Element} mal  id eller elementet självt
 * @returns {Element|null}
 */
export function oppnaInstallning(mal) {
  if (!vy) return null;
  const el = typeof mal === 'string' ? document.getElementById(mal) : mal;
  if (!el || !vy.contains(el)) return null;

  rensaSok();

  const bar = el.closest('[data-grupp]');
  const g = bar ? grupper.get(bar.dataset.grupp) : null;
  if (g && !g.oppen) { sattGrupp(g, true); synkaKnappAlla(); }

  /* Målet kan vara dolt av helt andra skäl än hopfällningen — ett kort som
     göms för att telefonen saknar funktionen det beskriver, till exempel.
     Då finns inget att rulla till, och en tyst rullning som inte händer är
     precis det felet den här vägen byggdes för att ta bort.

     synlig() på kortet och inte bar.hidden: hopfällningen bor numera i en
     egen klass, så attributet ensamt svarar inte längre på frågan. */
  if (el.hidden || (bar && !synlig(bar))) return null;

  Rorelse.rullaTill(el, { block: 'start' });
  Rorelse.landa(el);
  return el;
}

/**
 * Öppna eller fäll ihop allt.
 *
 * "Öppna allt" ger tillbaka den gamla flata rullen, med gruppnamnen kvar som
 * landmärken. Den som hellre rullar än väljer ska få göra det — men han ska
 * behöva be om det.
 */
export function vaxlaAlla() {
  rensaSok();
  const oppna = !allaOppna();
  for (const g of grupper.values()) sattGrupp(g, oppna, oppna);
  synkaKnappAlla();
  return oppna;
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

let startad = false;

export function start() {
  if (startad || typeof document === 'undefined') return;
  vy = document.getElementById(VY_ID);
  if (!vy) return;
  startad = true;

  injiceraCss();
  byggRegister();

  falt = document.getElementById('sokInstallning');
  knappAlla = document.getElementById('btnOppnaAlla');
  traffrad = document.getElementById('sokTraffar');

  /* Först nu blir rubrikerna knappar. Se filhuvudet: attributen sätts av
     koden som binder dem, aldrig av markupen, så att ett uteblivet skript
     inte kan lämna efter sig sju kontroller som ljuger. */
  for (const g of grupper.values()) {
    if (!g.rubrik) continue;
    g.rubrik.setAttribute('role', 'button');
    g.rubrik.setAttribute('tabindex', '0');
  }

  /* Sökraden ligger med hidden i markupen av samma skäl. */
  const sokrad = vy.querySelector('.sokrad');
  if (sokrad) sokrad.hidden = false;

  /* Starttillståndet sätts HÄR och inte i markupen. Se filhuvudet: utan den
     här filen ska vyn vara lång, inte tom. */
  for (const g of grupper.values()) sattGrupp(g, g.alltidOppen, false);
  synkaKnappAlla();

  /* En lyssnare på vyn i stället för sju på rubrikerna. Grupprubrikerna
     ritas aldrig om i dag, men en delegerad lyssnare kan inte tappas bort
     den dagen någon börjar rita om dem — och det felet syns inte, det yttrar
     sig bara som att en rubrik slutat svara. */
  vy.addEventListener('click', e => {
    const rubrik = e.target.closest?.('h2.grupp');
    if (rubrik && vy.contains(rubrik)) vaxlaGrupp(rubrik);
  });

  /* Tangentbord. role="button" lovar att Enter och Blanksteg fungerar, och
     ett löfte som bara syns för skärmläsare är fortfarande ett löfte.
     preventDefault på Blanksteg: annars rullar sidan en skärm samtidigt. */
  vy.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const rubrik = e.target.closest?.('h2.grupp');
    if (!rubrik || !vy.contains(rubrik)) return;
    e.preventDefault();
    vaxlaGrupp(rubrik);
  });

  if (falt) {
    /* Eget rensa-kryss i stället för webbläsarens. Safaris egna kryss ritas
       svart oavsett fältets färg och försvinner helt mot --bg-3, och Chrome
       på Android ritar inget alls. */
    rensaKryss = document.createElement('button');
    rensaKryss.type = 'button';
    rensaKryss.className = 'sok-rensa';
    rensaKryss.setAttribute('aria-label', 'Rensa sökningen');
    rensaKryss.textContent = '✕';
    rensaKryss.hidden = true;
    rensaKryss.addEventListener('click', () => rensaSok({ behallFokus: true }));
    falt.insertAdjacentElement('afterend', rensaKryss);

    falt.addEventListener('input', filtrera);
    /* Escape rensar, och Enter stänger tangentbordet i stället för att
       skicka något. Det finns inget att skicka — listan är redan filtrerad
       vid varje tangenttryck, och ett tangentbord som ligger kvar äter halva
       skärmen medan man läser träffarna. */
    falt.addEventListener('keydown', e => {
      if (e.key === 'Escape') { rensaSok({ behallFokus: true }); e.preventDefault(); }
      else if (e.key === 'Enter') { falt.blur(); e.preventDefault(); }
    });
  }

  if (knappAlla) knappAlla.addEventListener('click', () => vaxlaAlla());
}

start();

export const Inst = { start, oppnaInstallning, vaxlaAlla };
if (typeof window !== 'undefined') window.Inst = Inst;
