// Varningsytan — den enda varningen som syns i HELA appen.
//
// BAKGRUNDEN, för den som undrar varför filen finns.
//
// Fram till nu ritades varningar på två ställen, och båda låg INNE i
// kartvyn: #alertBanner och listan i #sheet. Vyerna släcks med
// `.view[hidden] { display:none }`, och display:none på en förfader tar bort
// hela grenen oavsett vad barnen har för position eller z-index. Byter
// föraren till Chatt eller Inställningar finns alltså ingen varning alls —
// ljudet kommer, rösten kommer, men skärmen är tyst. Ägaren beskrev det
// exakt så: "Ingen varning kommer. Jag är ju vid den här kartamenyn."
//
// Därför ligger den här ytan direkt i <body>, utanför alla fyra vyer, precis
// som fordonslarmet gör. Det är den enda placering som överlever ett vybyte.
//
// VARFÖR EN EGEN FIL OCH INTE MARKUP I index.html
// Ytan skapar sin egen nod och sin egen <style>, samma mönster som
// js/peka.js, js/uppstart.js och js/platsstart.js redan använder. Det gör
// den flyttbar utan att index.html och css/app.css måste röras, och det gör
// att den fungerar även om den laddas dynamiskt.
//
// FORM: EN REMSA HÖGST UPP, ALDRIG EN RUTA MITT ÖVER KARTAN
// Fordonslarmet täcker hela skärmen (inset:0). Det är rätt för det: en
// igenkänd skylt betyder att man ska titta på telefonen. En polisvarning
// betyder motsatsen — då ska föraren titta på VÄGEN, och kartan under är en
// del av det. En heltäckande ruta här hade tagit bort orienteringen i exakt
// det ögonblick den behövs mest.
//
// Överkanten valdes framför underkanten av två skäl: kartans egna
// rapportknappar (.actions, z700) och farulistan (#sheet, z600) bor i
// nederkanten, och en remsa där hade både dolt dem och ätit deras tryck.
// Överkanten bär bara HUD:en och två förklaringsrader som båda är skrivna
// för att vika undan för något som varnar för verkligheten just nu.
//
// OM Z-INDEX 905
// Nivåerna som gäller i appen: tabbar 800, versionsbanner 880, pekaren 885,
// uppstartsraden 889, platsremsan 890, gamla varningsbannern och mörkt
// körläge 900, modaler 1000, fordonslarmet 1500, rundturen 3000.
// 905 lägger ytan strax över mörkt körläge — mörkt läge är påslaget just när
// man kör, alltså precis när varningen ska synas, och hamnar varningen under
// den stora hastighetssiffran syns den inte alls. Samtidigt ligger 905 under
// modalerna (en modal betyder att föraren själv har begärt något) och långt
// under fordonslarmet (1500), som aldrig får skymmas av någonting.
//
// OM TRYCK
// Ytan är INTE ett heltäckande lager. Den är en remsa med egen höjd, och
// utanför den finns ingenting av oss — inget osynligt lager över skärmen som
// kan äta ett tryck på väg till en knapp. Inom sin egen rektangel tar den
// däremot emot trycket med flit: den är ogenomskinlig, och ett tryck som gick
// rakt igenom hade träffat något föraren inte kan se.
//
// Men "något föraren inte kan se" var i praktiken tre knappar som betyder
// något: #btnMute, platsremsans åtgärdsknapp och bannerns kryss. Alla tre låg
// i samma rektangel som ytan. Det löses inte med pointer-events utan genom
// att de viker undan medan ytan lyser — se regelblocket "VAD SOM VIKER UNDAN"
// i CSS:en längre ned, där varje uppmätt överlapp står med koordinater.
//
// HÅRD PRODUKTREGEL
// Nykterhets- och drogkontroller finns inte i appen. Spärren sitter i
// parser.js och igen i sammanfattning.js. Den här ytan är en NY väg från
// rådata till något en människa ser, och en spärr som bara sitter uppströms
// är en spärr som förr eller senare kringgås. Därför frågas farBeskrivas()
// igen här, och beskrivning() som ändå returnerar tomt behandlas som ett nej.
// En sådan rapport ritas inte, räknas inte och väcker inte ytan.

import { beskrivning, farBeskrivas, talOrd } from './sammanfattning.js';
import { shortDistance } from './util.js';

/* ------------------------------------------------------------------ */
/* Tider                                                               */
/* ------------------------------------------------------------------ */

/**
 * Hur länge ytan ligger kvar efter den SENASTE varningen.
 *
 * 15 sekunder. Gamla varningsbannern låg på 14 och fordonslarmet på 9. Den
 * här bär mer text än båda, och den ska kunna läsas av någon som bara får
 * kasta korta blickar på skärmen mellan att titta på vägen. Kortare än så och
 * meningen hinner inte läsas färdigt; längre och den börjar likna en fast
 * del av gränssnittet, vilket är precis hur en varning slutar betyda något.
 */
export const VISA_MS = 15000;

/**
 * Absolut tak för hur länge ytan får ligga uppe i ett svep.
 *
 * Varje ny rapport startar om 15-sekunderstimern. En kväll när gruppen är
 * livlig kan rapporterna komma tätare än så, och då hade ytan aldrig
 * släckts — den hade blivit en permanent list över skärmen som föraren slutar
 * se. Taket bryter kedjan: efter en minut släcks ytan oavsett, och nästa
 * rapport får väcka den på nytt så att rörelsen syns igen.
 */
export const MAX_TOTAL_MS = 60000;

/** Hur många av de övriga varningarna som nämns vid namn innan vi räknar. */
const MAX_NAMNDA = 2;

/** Så många rapporter håller vi som mest i ytan. Resten blir en siffra. */
const MAX_KO = 8;

/* ------------------------------------------------------------------ */
/* Färg per typ                                                        */
/* ------------------------------------------------------------------ */
//
// Färgen ska bära informationen på en armlängds avstånd i dagsljus, INNAN
// texten hinner läsas. Därför mättade fält med vit text, som en vägskylt —
// inte en tonad ruta med accentfärg, som försvinner i solljus bakom ett
// fingeravtryck på glaset.
//
// Fyra färger, medvetet långt ifrån varandra i nyans så att de går att skilja
// åt även i ögonvrån och även för den som ser rött och grönt sämre:
//
//   police    röd      — det man oftast varnas för, och det mest akuta
//   unmarked  magenta  — civil polisbil är något annat än en polisbil, och
//                        skillnaden får inte försvinna i samma röda fält
//   control   orange   — en kontroll står still, den är ett hinder
//   camera    blå      — en fast kamera är en upplysning, inte en händelse.
//                        Blått säger det utan att ett ord behöver läsas.
//
// Ikonerna är samma som i listan och på nålen (TYPE_ICON i parser.js), men
// hämtas inte därifrån: den här filen ska kunna ritas även om parser.js
// laddas senare, och en tom ikon i en varning ser trasig ut.

const TYPFARG = {
  police:   { klass: 'pv-vy-police',   ikon: '🚓' },
  unmarked: { klass: 'pv-vy-unmarked', ikon: '🚗' },
  control:  { klass: 'pv-vy-control',  ikon: '🛑' },
  camera:   { klass: 'pv-vy-camera',   ikon: '📷' },
};
const STANDARDTYP = { klass: 'pv-vy-police', ikon: '⚠️' };

/* ------------------------------------------------------------------ */
/* Stil                                                                */
/* ------------------------------------------------------------------ */
//
// app.css variabler med hårda reservvärden efter sig, av samma skäl som i
// platsstart.js: filen kan laddas innan stilmallen är på plats, och en
// varning utan färg är en varning som inte syns.

const CSS = `
.pv-varningsyta {
  position: fixed; z-index: 905; left: 0; right: 0; top: 0;
  /* Ingen inset: 0. Ytan är en remsa, inte ett lager — utanför den här
     rektangeln finns ingenting av oss som kan fånga ett tryck. */
  color: #fff;
  font: 16px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  box-shadow: 0 14px 34px rgba(0,0,0,.55);
  animation: pvVyIn .22s cubic-bezier(.2,1.25,.4,1);
}
.pv-varningsyta[hidden] { display: none; }

/* Slår ned uppifrån. Rörelsen är hela poängen: det är den som fångar
   ögonvrån när blicken ligger på vägen. Den är kort med flit — en yta som
   fortsätter röra sig drar blicken bort från vägen i stället för tillbaka. */
@keyframes pvVyIn { from { transform: translateY(-100%); } }

/* Kommer varning nummer två medan ytan redan ligger uppe byts texten ut utan
   att något rör sig, och då missar föraren den. Att låta ytan åka in uppifrån
   igen vore fel — den skulle försvinna ur bild ett ögonblick, precis när den
   bär ny information. En kort ljusning gör samma sak utan att flytta något. */
.pv-vy-puls { animation: pvVyPuls .34s ease-out; }
@keyframes pvVyPuls { 40% { filter: brightness(1.55); } }

.pv-vy-rad {
  display: flex; align-items: center; gap: 13px;
  padding: 12px 12px 13px;
  /* Kameraskåran. Ytan ligger överst på skärmen och måste själv hålla sig
     undan den — ingen annan gör det åt oss här. */
  padding-top: calc(env(safe-area-inset-top, 0px) + 12px);
}

.pv-vy-ikon {
  flex: none; font-size: 32px; line-height: 1;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,.45));
}

.pv-vy-text { flex: 1; min-width: 0; }

/* 23px/800. Stort nog att läsas i en blick på en armlängds avstånd, litet
   nog att "Fartkontroll med laser vid E18" ryms på två rader på en liten
   telefon. Textskuggan finns för dagsljuset: den håller isär bokstäver och
   bakgrund även när skärmen är nedbländad bakom solglasögon.

   Rubriken får HELA bredden vid sidan av ikonen och stängknappen. Första
   utkastet la avståndet i en egen kolumn till höger, och på en 360 px bred
   telefon åt ikonen, siffran och knappen tillsammans upp 205 av 360 px —
   rubriken fick 155 px och "Fartkontroll med laser vid E18 västerut" bröts
   över fyra rader. Det som ska läsas först måste ha bredden. */
.pv-vy-rubrik {
  margin: 0;
  font: 800 23px/1.15 system-ui, sans-serif;
  letter-spacing: -.01em;
  text-shadow: 0 2px 8px rgba(0,0,0,.45);
}

/* Underraden är en rad i sig: avståndet först som en bricka, meningen efter.
   Bryts de isär på en smal skärm hamnar avståndet kvar överst, vilket är
   rätt ordning — hur långt bort den är avgör om föraren behöver göra något. */
.pv-vy-under {
  margin: 4px 0 0;
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px;
  font: 500 14.5px/1.35 system-ui, sans-serif;
  color: rgba(255,255,255,.93);
  text-shadow: 0 1px 6px rgba(0,0,0,.4);
}
.pv-vy-under[hidden] { display: none; }
.pv-vy-undertext { min-width: 0; }

/* Avståndet i monospace på mörk bricka: siffran ska gå att hitta utan att
   meningen läses, och den ska inte hoppa i sidled när den ändras från 900 m
   till 1,2 km. */
.pv-vy-avstand {
  flex: none;
  font: 800 15px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(0,0,0,.32);
  border-radius: 999px;
  padding: 2px 9px;
  text-shadow: none;
}
.pv-vy-avstand[hidden] { display: none; }

/* 46 px träffyta. Stängknappen ska gå att träffa med tummen, utan att sikta,
   i en bil — samma resonemang som fordonslarmets tystaknapp. */
.pv-vy-stang {
  flex: none;
  width: 46px; height: 46px; border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,.55);
  background: rgba(0,0,0,.28); color: #fff;
  font: 700 19px/1 system-ui, sans-serif;
  display: grid; place-items: center;
  cursor: pointer;
}

/* Raden om de övriga varningarna. En yta, inte fem staplade: kommer det tre
   rapporter samtidigt växer den här raden i stället för att ytan gör det.
   Fem staplade remsor hade täckt halva vindrutan av skärmen och gjort exakt
   det den här filen finns för att undvika. */
.pv-vy-fler {
  margin: 0;
  padding: 8px 12px 9px;
  background: rgba(0,0,0,.26);
  border-top: 1px solid rgba(255,255,255,.16);
  font: 600 13.5px/1.35 system-ui, sans-serif;
  color: rgba(255,255,255,.94);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pv-vy-fler[hidden] { display: none; }

/* Färgfälten. Mörk botten, ljusare topp — samma riktning som app.css egna
   gradienter, så ytan känns som en del av appen och inte som ett påklistrat
   fel. */
.pv-vy-police   { background: linear-gradient(180deg, #d8281f, #a01712); }
.pv-vy-unmarked { background: linear-gradient(180deg, #c02a86, #8c1a5f); }
.pv-vy-control  { background: linear-gradient(180deg, #d1740a, #9a5305); }
.pv-vy-camera   { background: linear-gradient(180deg, #1668c4, #0f4a8f); }

@media (prefers-reduced-motion: reduce) {
  .pv-varningsyta, .pv-vy-puls { animation: none; }
}

/* ------------------------------------------------------------------
   VAD SOM VIKER UNDAN MEDAN YTAN LIGGER UPPE

   Modulkommentarens "OM TRYCK" stämde inte, och det här är rättelsen.

   Påståendet var att ett tryck som gick igenom ytan bara hade träffat "en
   knapp föraren inte kan se". Den knappen finns, och den är den viktigaste i
   hela appen i just det ögonblicket. Uppmätt på 375×812:

     #btnMute ("Tysta varningar")  x321,y10 → x365,y54
     .pv-vy-stang (ytans kryss)    x317,y24 → x363,y70
     elementFromPoint(343, 32) → .pv-vy-stang

   Träffytorna ligger sex pixlar isär i centrum. Föraren som hör varningen och
   sträcker sig efter tysta-knappen träffade alltså ytans kryss: varningen
   försvann från skärmen, ljudet och rösten fortsatte, ingenting tystades.
   Samma sak begravde hastighetssiffran och chipsen GPS/Röst/Nät (.topp,
   z550).

   Lösningen är den som uppstart.js och peka.js redan använder: den som ligger
   under viker undan. Här skjuts .topp NED i stället för att gömmas — mute,
   hastighet och chips ska förbli nåbara medan varningen syns, det är själva
   poängen. Höjden mäts i rita() och skrivs till --pv-vy-hojd, eftersom ytan
   växer med "Även:"-raden och en hårdkodad siffra hade blivit fel varannan
   gång.
   ------------------------------------------------------------------ */
body.pv-vy-uppe .topp { top: calc(var(--pv-vy-hojd, 0px) + 10px); }

/* platsstart.js röda remsa (z890) delar rektangel med oss: samma
   position:fixed, samma left/right/top:0. Den var alltså helt begravd, och
   dess "Slå på"-knapp gick inte att träffa — trycket landade på vårt kryss.
   Den göms hellre än flyttas: remsan handlar om appens INSTÄLLNINGAR, ytan om
   verkligheten framför bilen, och den prioriteringen är redan uttalad i
   uppstart.js. Remsan kommer tillbaka av sig själv när ytan slocknar. */
body.pv-vy-uppe .pv-ps-remsa { display: none; }

/* Gamla varningsbannern (#alertBanner, z900) ritas av samma anrop som väcker
   oss och visar SAMMA varning. Med båda uppe stack den ut 17 px under ytan
   som en avhuggen röd list, och dess kryss låg under oss, alltså dött.
   display:none och inte hidden-attributet: renderMorkt() läser banner.hidden
   för att spegla varningen på den mörka körskärmen, och sätter vi attributet
   blir mörkläget tyst igen — ett fel som redan gjorts en gång. */
body.pv-vy-uppe .alert-banner { display: none; }
`;

function injiceraCss() {
  if (document.getElementById('pv-vy-stil')) return;
  const s = document.createElement('style');
  s.id = 'pv-vy-stil';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* Noden                                                               */
/* ------------------------------------------------------------------ */

let rot = null;          // .pv-varningsyta
let elIkon = null;
let elRubrik = null;
let elUnder = null;
let elUndertext = null;
let elAvstand = null;
let elFler = null;

function el(tag, klass, text) {
  const n = document.createElement(tag);
  if (klass) n.className = klass;
  if (text != null) n.textContent = text;   // aldrig innerHTML
  return n;
}

/**
 * Bygger noden en gång, sist i <body>.
 *
 * Sist med flit: ligger den efter allt annat vinner den på lika z-index mot
 * syskon som mörkt körläge, utan att någon behöver hålla reda på
 * dokumentordningen framöver.
 *
 * role="alert" och inte "alertdialog": ytan tar inte över skärmen och fångar
 * ingen fokus. En skärmläsare ska läsa upp den och sedan lämna föraren i
 * fred, inte kräva att något stängs.
 */
function bygg() {
  if (rot) return rot;
  if (!document.body) return null;
  injiceraCss();

  rot = el('div', 'pv-varningsyta');
  rot.id = 'pv-varningsyta';
  rot.setAttribute('role', 'alert');
  rot.setAttribute('aria-live', 'assertive');
  rot.setAttribute('aria-atomic', 'true');
  rot.hidden = true;

  const rad = el('div', 'pv-vy-rad');
  elIkon = el('div', 'pv-vy-ikon');
  elIkon.setAttribute('aria-hidden', 'true');

  const text = el('div', 'pv-vy-text');
  elRubrik = el('p', 'pv-vy-rubrik');
  elUnder = el('p', 'pv-vy-under');
  elAvstand = el('span', 'pv-vy-avstand');
  elUndertext = el('span', 'pv-vy-undertext');
  elUnder.append(elAvstand, elUndertext);
  text.append(elRubrik, elUnder);

  const stangKnapp = el('button', 'pv-vy-stang', '✕');
  stangKnapp.type = 'button';
  stangKnapp.setAttribute('aria-label', 'Stäng varningen');
  stangKnapp.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    stang();
    /*
     * Ett tryck ska släcka varningen ÖVERALLT, inte bara här.
     *
     * #alertBanner i kartvyn visar samma varning och ligger kvar när ytan
     * försvinner — uppmätt utfall: föraren tryckte bort ytan och bannern
     * poppade fram i stället, alltså precis tvärtom mot vad trycket betydde.
     * Bannerns eget kryss gick samtidigt inte att träffa, det låg under oss.
     *
     * Händelse och inte ett import-anrop: den här filen får inte känna till
     * js/app.js. Bara knappen dispatchar, aldrig stang() själv — annars hade
     * app.js svar (som anropar stang()) blivit en oändlig slinga.
     */
    try {
      window.dispatchEvent(new CustomEvent('pv-varningsyta-stangd'));
    } catch { /* äldre webbläsare utan CustomEvent-konstruktor */ }
  });

  rad.append(elIkon, text, stangKnapp);

  elFler = el('p', 'pv-vy-fler');
  elFler.hidden = true;

  rot.append(rad, elFler);

  // Ytan är ogenomskinlig. Ett tryck som gick igenom hade träffat en knapp
  // föraren inte kan se, så vi tar emot det och gör ingenting med det.
  // Att stänga på hela ytan vore lätt att göra av misstag med tummen på
  // ratten, och en varning som råkar försvinna är värre än en som ligger
  // kvar fyra sekunder för länge. Stängning kräver knappen.
  rad.addEventListener('click', ev => ev.stopPropagation());

  document.body.appendChild(rot);
  return rot;
}

/* ------------------------------------------------------------------ */
/* Kön                                                                 */
/* ------------------------------------------------------------------ */

/** Posterna som ligger uppe just nu. Först i listan är den som visas stort. */
let ko = [];
let slocknaTimer = null;
let takTimer = null;

/**
 * En nyckel som är samma för samma rapport.
 *
 * Utan den lade två anrop om samma polisbil — ett från närhetsmotorn och ett
 * från inkommande-kedjan — samma varning två gånger i kön, och ytan sa "och
 * en till" om sig själv.
 */
function nyckel(rapport) {
  if (rapport.id != null) return `id:${rapport.id}`;
  const lat = Number(rapport.lat), lon = Number(rapport.lon);
  const plats = Number.isFinite(lat) && Number.isFinite(lon)
    ? `${lat.toFixed(4)},${lon.toFixed(4)}` : (rapport.label || '');
  return `x:${rapport.type || ''}|${plats}|${rapport.createdAt || ''}`;
}

/**
 * Ordningen i kön.
 *
 * En fast fartkamera står där i morgon också och får aldrig tränga undan en
 * polisbil som är där NU — den läggs sist oavsett när den kom in. I övrigt
 * vinner den som är närmast, och saknas avstånd (rapporter utan geokod, som
 * är just de ägaren mätte på) den som kom in senast.
 */
function sortera() {
  ko.sort((a, b) => {
    if (a.fast !== b.fast) return a.fast ? 1 : -1;
    const aa = Number.isFinite(a.avstand) ? a.avstand : Infinity;
    const bb = Number.isFinite(b.avstand) ? b.avstand : Infinity;
    if (aa !== bb) return aa - bb;

    /*
     * RAPPORTENS EGEN TID FÖRE KÖTIDPUNKTEN. Ordningen mellan de två raderna
     * är inte en detalj — den avgjorde vilken varning föraren LÄSTE.
     *
     * Utan avstånd, alltså för geokodlösa rapporter (just de som ligger på
     * servern), föll ordningen förut tillbaka på lagdTill, och den är omvänd
     * mot hur app.js matar in kön: den upplästa läggs in FÖRST och resten av
     * bursten efteråt i en slinga, så den sist inlagda — den äldsta — fick
     * högst lagdTill och sorterades överst. Uppmätt utfall: rösten sa "Polis
     * vid Gamma" (1 minut gammal) medan rubriken sa "Polis vid Alfa" (5
     * minuter gammal). Föraren hörde en sak och läste en annan, och det han
     * läste var det minst relevanta.
     *
     * skapad är rapportens createdAt, alltså samma nyckel som poster.sort()
     * i js/app.js redan sorterar burst-en på. Nu sammanfaller ordningarna,
     * och "senast inkommen" betyder händelsens tid — inte i vilken ordning
     * slingan råkade nå oss.
     */
    if ((a.skapad || 0) !== (b.skapad || 0)) return (b.skapad || 0) - (a.skapad || 0);

    // Sista utvägen: två rapporter utan createdAt går inte att skilja åt på
    // tid. Då får kötidpunkten avgöra, så ordningen åtminstone är stabil.
    return b.lagdTill - a.lagdTill;
  });
}

/* ------------------------------------------------------------------ */
/* Texten                                                              */
/* ------------------------------------------------------------------ */

/**
 * Rubrik och underrad ur appens EGNA ord.
 *
 * Ingen ny formulering byggs här. beskrivning() i sammanfattning.js äger hur
 * en rapport låter i den här appen, och den korta formen är redan skriven för
 * precis det här — "notiser, varningsbannern — en mening". Vi delar bara upp
 * den i en del som ska vara stor och en som ska vara liten:
 *
 *   Polis vid Skultuna — någon i Facebook-gruppen varnade för en minut sedan.
 *   ^ rubrik           ^ underrad
 *
 * Delningen görs på delar.typ + delar.plats, alltså på exakt de strängar
 * beskrivning() själv satte ihop rubriken av — inte på ett tankstreck i
 * texten. Den fasta kameran har nämligen ingen tankstreck ("Fast fartkamera
 * vid Hälla. Den står alltid här."), och en delning på tecken hade gett
 * tom rubrik just för den.
 */
function texter(post) {
  const b = post.beskrivning;
  const d = b.delar || {};
  const rubrik = `${d.typ || ''}${d.plats || ''}`.trim();
  let under = b.kort || '';

  if (rubrik && under.startsWith(rubrik)) {
    // Skarven mellan rubrik och resten är antingen " — " eller ". ".
    under = under.slice(rubrik.length).replace(/^\s*[—–-]\s*/, '').replace(/^\.\s*/, '').trim();
    // Stor bokstav igen: "någon i Facebook-gruppen varnade …" står mitt i en
    // mening i originalet, men är en egen rad här.
    if (under) under = under.charAt(0).toUpperCase() + under.slice(1);
  }

  return { rubrik: rubrik || (b.kort || 'Varning'), under };
}

/** "Polis vid Skultuna" — det korta namnet, för raden om de övriga. */
function kortNamn(post) {
  const d = post.beskrivning.delar || {};
  return `${d.typ || 'Varning'}${d.plats || ''}`.trim();
}

/* ------------------------------------------------------------------ */
/* Ritningen                                                           */
/* ------------------------------------------------------------------ */

/**
 * Säger till resten av appen att ytan äger toppen av skärmen just nu.
 *
 * Klassen på <body> är kontraktet: css/app.css och platsstart.js behöver inte
 * importera något härifrån, de behöver bara vika undan. Höjden skickas med
 * som en variabel eftersom ytan växer med "Även:"-raden — .topp ska hamna
 * precis under oss, inte på en gissad siffra.
 */
function markeraLage(uppe) {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle('pv-vy-uppe', !!uppe);
  const rotStil = document.documentElement?.style;
  if (!rotStil) return;
  if (uppe && rot) rotStil.setProperty('--pv-vy-hojd', rot.offsetHeight + 'px');
  else rotStil.removeProperty('--pv-vy-hojd');
}

function rita() {
  if (!bygg()) return;

  if (!ko.length) {
    rot.hidden = true;
    markeraLage(false);
    return;
  }

  sortera();
  const forst = ko[0];
  const farg = TYPFARG[forst.typ] || STANDARDTYP;
  const t = texter(forst);

  rot.className = `pv-varningsyta ${farg.klass}`;
  elIkon.textContent = farg.ikon;
  elRubrik.textContent = t.rubrik;
  elUndertext.textContent = t.under;

  const harAvstand = Number.isFinite(forst.avstand);
  elAvstand.textContent = harAvstand ? shortDistance(forst.avstand) : '';
  elAvstand.hidden = !harAvstand;
  // Hela underraden göms bara när den är tom på båda — en rapport utan geokod
  // har inget avstånd, och en tom rad hade lämnat ett hål under rubriken.
  elUnder.hidden = !t.under && !harAvstand;

  // De övriga. Namnges de två närmaste; resten blir en siffra i ord, samma
  // språk som resten av appen använder ("och två till", inte "och 2 till").
  const ovriga = ko.slice(1);
  if (!ovriga.length) {
    elFler.textContent = '';
    elFler.hidden = true;
  } else {
    const namnda = ovriga.slice(0, MAX_NAMNDA).map(kortNamn);
    const kvar = ovriga.length - namnda.length;
    let rad = `Även: ${namnda.join(' · ')}`;
    if (kvar === 1) rad += ' · och en till';
    else if (kvar > 1) rad += ` · och ${talOrd(kvar)} till`;
    elFler.textContent = rad;
    elFler.hidden = false;
  }

  rot.hidden = false;
  // Höjden mäts EFTER att noden är synlig — offsetHeight på en hidden nod är
  // noll, och då hade .topp lagt sig kvar under ytan.
  markeraLage(true);
}

/**
 * Kort ljusning när ytan redan ligger uppe och får något nytt att säga.
 *
 * Klassen tas bort och sätts tillbaka med en påtvingad omräkning emellan —
 * utan den startar en CSS-animation inte om på ett element som redan bär
 * klassen, och varning nummer tre hade blivit helt orörlig.
 */
function pulsa() {
  if (!rot || !rot.classList) return;
  rot.classList.remove('pv-vy-puls');
  void rot.offsetWidth;
  rot.classList.add('pv-vy-puls');
}

/* ------------------------------------------------------------------ */
/* Timrarna                                                            */
/* ------------------------------------------------------------------ */

function stallOmSlockna() {
  clearTimeout(slocknaTimer);
  slocknaTimer = setTimeout(stang, VISA_MS);
  // Taket sätts bara när ytan går från släckt till tänd, aldrig av en ny
  // rapport — annars hade det aldrig löpt ut och taket varit meningslöst.
  if (!takTimer) takTimer = setTimeout(stang, MAX_TOTAL_MS);
}

/* ------------------------------------------------------------------ */
/* Publikt API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Visa en varning. Ett anrop per rapport; ytan slår ihop dem själv.
 *
 * Anropas av app.js från ETT ställe. Den kan anropas hur ofta som helst med
 * samma rapport — andra gången uppdaterar den bara avståndet.
 *
 * @param {Object} rapport  Raden ur store.js.
 * @param {{avstand?:number, egen?:boolean, nu?:number, vibrera?:boolean}} [opts]
 *        avstand  meter till rapporten, när GPS-fix finns. Utelämnas den
 *                 visas ingen siffra — det är rätt utfall för en rapport utan
 *                 geokod, och att gissa ett avstånd vore att hitta på.
 *        vibrera  false stänger av vibrationen, för den som redan vibrerat.
 * @returns {boolean} true om ytan visar rapporten.
 */
export function visa(rapport, opts = {}) {
  if (!rapport || typeof rapport !== 'object') return false;

  // Utan typ är det ingen rapport. beskrivning() svarar villigt "Varning,
  // plats okänd — rapporterad vid okänd tidpunkt, men källan är okänd" på ett
  // tomt objekt, och det är en fullt läsbar mening om ingenting alls. En
  // sådan yta lär föraren att appen ibland skriker utan orsak, och då slutar
  // även de riktiga varningarna betyda något. En OKÄND typ släpps däremot
  // igenom med ⚠️: läggs en ny typ till uppströms ska den synas, inte tystas.
  if (typeof rapport.type !== 'string' || !rapport.type.trim()) return false;

  // Spärren, igen. Se modulkommentaren: den här filen är en ny väg fram till
  // en människas ögon, och den frågar därför själv.
  if (!farBeskrivas(rapport)) return false;

  const b = beskrivning(rapport, { nu: opts.nu, egen: opts.egen });
  if (!b || !b.kort || !b.delar) return false;   // tomt = får inte beskrivas

  const nu = Date.now();
  const k = nyckel(rapport);
  const avstand = Number.isFinite(opts.avstand) ? Number(opts.avstand) : null;

  const fanns = ko.find(p => p.nyckel === k);
  if (fanns) {
    fanns.beskrivning = b;
    if (avstand != null) fanns.avstand = avstand;
    rita();
    stallOmSlockna();
    return true;
  }

  const nyYta = ko.length === 0;

  ko.push({
    nyckel: k,
    typ: rapport.type,
    fast: b.delar.fast === true,
    avstand,
    beskrivning: b,
    skapad: Number.isFinite(rapport.createdAt) ? rapport.createdAt : 0,
    lagdTill: nu,
  });
  // Taket på kön: den yta som ändå bara visar en rubrik och en siffra behöver
  // inte minnas trettio rapporter. Den som ryker är den sist sorterade,
  // alltså den minst angelägna.
  if (ko.length > MAX_KO) {
    sortera();
    ko.length = MAX_KO;
  }

  rita();
  stallOmSlockna();
  if (!nyYta) pulsa();   // ytan låg redan uppe: markera att något nytt kom

  // Vibrationen är den tredje kanalen, vid sidan av ljudet och skärmen. Den
  // når fram genom musik, genom en telefon i tyst läge och genom en blick som
  // ligger på vägen. Bara när ytan TÄNDS — en vibration per rapport i en
  // skur hade blivit en surrande telefon, alltså en distraktion.
  if (nyYta && opts.vibrera !== false) {
    try { navigator.vibrate?.(90); } catch { /* enheten saknar motor */ }
  }

  return true;
}

/** Stäng ytan och töm kön. Både knappen och timrarna går hit. */
export function stang() {
  clearTimeout(slocknaTimer); slocknaTimer = null;
  clearTimeout(takTimer); takTimer = null;
  ko = [];
  if (rot) {
    rot.hidden = true;
    elFler.hidden = true;
  }
  // Alltid, även om noden aldrig byggdes: klassen kan ha satts av en tidigare
  // visa() och en kvarglömd klass hade lämnat .topp nedskjuten för alltid.
  markeraLage(false);
}

/** Ligger ytan uppe? Finns för andra moduler som ska vika undan för den. */
export function arUppe() {
  return !!rot && !rot.hidden;
}
