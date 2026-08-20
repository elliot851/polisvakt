// Facebooks egna notismejl -> rapporter.
//
// Tredje vägen in från gruppen "Här står polisen", och den enda som inte
// kräver att någon annan människa vill något.
//
//   Userscriptet läser gruppen som en inloggad människa. Det bryter mot Metas
//   villkor och slutar fungera den dagen de bryr sig.
//
//   Telegram-spegeln är laglig och stabil, men börjar med ett samtal: en
//   admin måste orka posta samma sak två gånger, varje gång, för alltid.
//
//   Den här filen läser ägarens EGEN postlåda. Facebook skickar själva mejlen,
//   till en adress ägaren själv äger, om notiser han själv slagit på. Ingen
//   inloggning kringgås, ingenting skrapas, ingen tredje part behöver vilja
//   något. Det är den enda vägen där ägaren råder över hela kedjan.
//
// Den här filen är RENA LAGRET i den vägen. Den gör en sak: tar ett mejl som
// text och lämnar ifrån sig antingen en rapport eller ett skäl till att den
// inte blev någon.
//
// Fyra saker styr designen, samma fyra som i js/telegram.js:
//
//   Inget lösenord bor här. IMAP-lösenordet finns bara i pollaren, och
//   pollaren läser det ur en miljövariabel. Den här modulen rör aldrig nätet
//   och har därför ingenting att autentisera sig mot.
//
//   Ingen sidoeffekt alls. Inget fetch, inget localStorage, ingen klocka som
//   inte går att skicka in. Geokodningen kommer in som en funktion, dedupen
//   som en mängd. Därför går hela filen att testa, och därför kan samma kod
//   köras i webbläsaren, i Deno på en edge-funktion och i Node.
//
//   Parsern äger reglerna. parseReportText() och isSobrietyCheck() är exakt
//   samma funktioner som rösten, knapparna, Telegram-bryggan och userscriptet
//   använder. Ordlistorna kopieras inte hit. En kopia av ett nykterhetsfilter
//   är ett filter som förr eller senare glider isär från originalet, och det
//   är den enda regel i appen som inte får glida.
//
//   Andrahandsuppgifter märks som andrahandsuppgifter. Någon i gruppen skrev
//   något, Facebook mejlade om det, vi läste mejlet efteråt. Det är svagare än
//   en förare som står på platsen och trycker på knappen — faktiskt ett steg
//   svagare än Telegram, eftersom vi bara ser Facebooks sammandrag av texten
//   och inte texten själv. Kvalitetsfälten sätts som js/telegram.js sätter
//   dem, så js/kvalitet.js får veta precis det.
//
// ---------------------------------------------------------------------
// VAD SOM ÄR BELAGT OCH VAD SOM ÄR ANTAGET — läs innan du litar på filen
//
// BELAGT (mot riktiga råmeddelanden):
//   Avsändardomänen facebookmail.com, med VERP-slumpad lokaldel. Se
//     FB_DOMANER. From == Return-Path == Errors-To; Reply-To är noreply@.
//   Gruppnotislänkens form:
//     facebook.com/groups/<gid_eller_slug>/<post_id>/?notif_t=group_activity
//     inbäddad i omslaget facebook.com/n/?<sökväg>&medium=email&mid=…
//     Nyare mejl använder /nd/?. Se plockaInlaggsId och packaUppOmslag.
//   Message-ID finns (hex-lokaldel på en facebook.com-värd).
//   n_m= bär MOTTAGARENS mejladress i klartext och notif_id= ger läsåtkomst
//     till innehållet. Båda skrubbas, se HEMLIGA_PARAMS.
//
// ANTAGET (gick inte att belägga — måste verifieras mot ett riktigt mejl):
//   Ämnesradens form. Inte en enda verbatim ämnesrad för ett gruppinlägg gick
//     att hitta. Det som går att belägga är att in-app-notisens mening
//     kopieras rakt av och trunkeras med "...". NYCKLA INGENTING PÅ ÄMNET.
//   Hur mycket av inläggstexten som ligger i brödtexten.
//   Vilka fraser som används i buntade sammanfattningar.
//   Fotens exakta formuleringar.
//   List-Unsubscribe fanns INTE i något äkta prov — bygg inget på det.
//   X-Facebook-Notify med mailid= finns i äldre korpusar; om det lever kvar
//     är obelagt, och filen använder det därför inte.
//
// Varje antagande är en EXPORTERAD lista, inte en inbakad regex. Kom det ett
// mejl som inte tolkas rätt ska man kunna lägga till en rad, inte skriva om
// en funktion. Se docs/fbmejl.md, "Verifiera mot ett riktigt mejl".
//
// Det som INTE bygger på antaganden: produktreglerna. De körs på texten som
// den ser ut efter tolkningen, och skulle tolkningen misslyckas helt blir
// resultatet noll rapporter — aldrig fel rapporter.
//
// ---------------------------------------------------------------------
// OCH DET STÖRSTA PROBLEMET ÄR INTE PARSNINGEN
//
// Facebooks egen hjälpsida listar gruppens aviseringsval under rubrikerna
// "In-app notifications" och "Push notifications". DET FINNS INGET
// E-POSTVAL PÅ GRUPPNIVÅ. E-post styrs bara på kontonivå.
//
// Dessutom pekar en leverantörskälla, i linje med många användarrapporter,
// på att Facebook bara aviserar om inlägg som ALGORITMEN väljer — även med
// "Alla inlägg" påslaget.
//
// Ett mejl per inlägg är alltså inte garanterat, och det är inget den här
// koden kan lösa. Den kan bara tolka de mejl som faktiskt kommer. Mät
// täckningen mot gruppen första veckan innan du litar på spåret.

import { parseReportText, isSobrietyCheck } from './parser.js';
import { TTL_MINUTES } from './store.js';
import { normalize, uid, clamp } from './util.js';

/**
 * Källa på rapporterna.
 *
 * 'facebook' och inget annat, av exakt samma tre skäl som i js/telegram.js:
 * det ÄR gruppens inlägg (mejlet är transporten), schema.sql tillåter bara
 * app/voice/facebook/import, och js/kvalitet.js graderar efter källa —
 * 'mejl' hade fallit ner i 'okand' och därmed tyst räknats som MER pålitligt
 * (0,45) än ett Facebook-inlägg (0,42). Samma text, högre betyg, bara för att
 * den tog en annan väg in. Det vore en lögn i graderingen.
 *
 * Att skilja mejlvägen från de andra två går ändå: device_id är 'fb-mejl' och
 * external_id börjar på 'fbm:'. Se vyn fbmejl_senaste i supabase/fbmejl.sql.
 */
export const KALLA = 'facebook';

/** Enhets-id för allt som kommer via mejlnotiserna. Syns i databasen, inte i appen. */
export const BRYGGA_ENHET = 'fb-mejl';

/** Under 0,65 är tolkningen en gissning. Gissningar hör inte hemma på kartan. */
export const MIN_TILLIT = 0.65;

/**
 * Hur länge en text räknas som samma inlägg.
 *
 * Samma tal som js/telegram.js och js/facebook.js använder, och det är med
 * flit: textnyckeln ska bli IDENTISK oavsett vilken av de tre vägarna in ett
 * inlägg tar. Ett inlägg som både speglas till Telegram och mejlas ut ska bli
 * en varning, inte två. Ändras talet här utan att ändras där slutar den
 * korsvisa avdubblingen fungera, tyst.
 */
export const DEDUP_FONSTER_MS = 3 * 60 * 60 * 1000;

/** Längst text vi sparar i note. Samma gräns som de andra två vägarna. */
const NOTE_MAX = 240;
const LABEL_MAX = 120;

/** Varför ett mejl inte blev en rapport. */
export const SKAL = {
  TOM:            'tom',             // ingen brödtext kvar när skräpet rensats
  FEL_AVSANDARE:  'fel-avsandare',   // kom inte från Facebook
  FEL_GRUPP:      'fel-grupp',       // en annan grupp än den vi följer
  INGET_GRUPPFILTER: 'inget-gruppfilter', // varken gruppId eller grupp angavs
  SAMMANFATTNING: 'sammanfattning',  // buntad notis, se arSammanfattning()
  NYKTERHET:      'nykterhet',       // nykterhets- eller drogkontroll — kastas alltid
  KAMERA:         'kamera',          // fartkameror finns redan i appen med rätt position
  OBEGRIPLIG:     'obegriplig',      // ingen typ hittad: frågor, skvaller, brus
  AVBLAST:        'avblast',         // "nu är dom borta" — sant men går inte att koppla
  LAG_TILLIT:     'lag-tillit',
  INGEN_PLATS:    'ingen-plats',
  FOR_GAMMALT:    'for-gammalt',     // varningen hade hunnit löpa ut innan vi såg den
  DUBBLETT:       'dubblett',
  OKAND_PLATS:    'okand-plats',     // platsen gick inte att geokoda
  GEOKOD_FEL:     'geokod-fel',      // nätverksfel — får försökas igen
};

/* ---- Avsändaren ------------------------------------------------------ */

/**
 * Domäner Facebook skickar notismejl från.
 *
 * BELAGT: facebookmail.com, inklusive underdomäner (priority.facebookmail.com
 * förekommer). De övriga är med som bälte och hängslen.
 *
 * BELAGT och avgörande: Facebook använder VERP. LOKALDELEN ÄR SLUMPAD PER
 * MOTTAGARE. Verifierade avsändare ur riktiga råmeddelanden:
 *
 *   notification+meynbxsa@facebookmail.com
 *   update+fswuaytwzzmw@facebookmail.com
 *   notification+kjdm---m7wwd@facebookmail.com
 *
 * Alltså: matcha DOMÄNEN, aldrig lokaldelen. En kontroll på
 * "notification@facebookmail.com" hade kastat varenda riktigt mejl, och
 * felet hade sett ut som "Facebook skickar inga mejl".
 *
 * Påståenden på nätet om att en särskild lokaldel (groupupdates@ och
 * liknande) skulle vara reserverad för grupper är obelagd SEO-text. Bygg
 * ingenting på dem.
 *
 * BELAGT om huvudena: From == Return-Path == Errors-To. Reply-To är däremot
 * noreply@facebookmail.com — det är INTE avsändaren, och en kontroll som
 * läser Reply-To istället för From kommer att se samma adress för alla mejl
 * och därmed inte kontrollera någonting alls.
 *
 * Listan är exporterad så den går att utöka utan att någon rör funktionen.
 */
export const FB_DOMANER = [
  'facebookmail.com',
  'facebook.com',
  'meta.com',
  'metamail.com',
  'mail.instagram.com',
];

/**
 * Kom mejlet från Facebook?
 *
 * Bara domänen kontrolleras, aldrig lokaldelen — se FB_DOMANER ovan om VERP.
 *
 * VIKTIGT, och det viktigaste i hela filen efter produktreglerna:
 *
 * From-huvudet går att förfalska. Vem som helst som känner till adressen kan
 * skicka ett mejl som PÅSTÅR sig komma från notification@facebookmail.com, och
 * den här funktionen skulle säga ja. Skulle någon lista ut vilken postlåda
 * bryggan läser vore det en väg att lägga ut godtyckliga varningar på kartan i
 * gruppens namn.
 *
 * Den här kontrollen är alltså inte säkerheten. Den är ett grovt första nät.
 * Säkerheten är att postlådan bara accepterar mejl som klarar DKIM och SPF —
 * det avgörs hos Strato, innan mejlet ens finns att läsa, och det är därför
 * docs/fbmejl.md ber ägaren om ett spamfilter som kastar det som inte klarar
 * signaturen istället för att flytta det till skräpkorgen.
 *
 * Andra halvan av skyddet: postlådan ska vara en egen adress som inte används
 * till något annat och inte står någonstans publikt. Se docs/fbmejl.md.
 */
export function arFacebookAvsandare(from, domaner = FB_DOMANER) {
  const s = String(from || '').toLowerCase();
  if (!s) return false;
  // Adressen kan stå som "Facebook <notification@facebookmail.com>" eller bar.
  const m = s.match(/[<\s]?([^<>\s@]+)@([a-z0-9.-]+)/);
  const doman = m ? m[2].replace(/[>.,;]+$/, '') : '';
  if (!doman) return false;
  return domaner.some(d => doman === d || doman.endsWith('.' + d));
}

/* ---- Buntade notiser ------------------------------------------------- */

/**
 * Fraser som avslöjar att mejlet är en SAMMANFATTNING och inte ett enskilt
 * inlägg.
 *
 * ANTAGET. Att Facebook buntar ihop notiser är väl känt för den som fått dem;
 * exakt vilka formuleringar som används vet vi inte förrän ett riktigt mejl
 * ligger på bordet. Listan är exporterad så att den kan fyllas på.
 *
 * Varför ett buntat mejl KASTAS istället för att delas upp:
 *
 * En sammanfattning har inga pålitliga gränser mellan inläggen och — det
 * avgörande — ingen tidsstämpel per inlägg. Mejlets Date säger när Facebook
 * skickade bunten, inte när varje inlägg skrevs. Ett inlägg som är fyrtio
 * minuter gammalt skulle alltså läggas ut som färskt, och en varning med fel
 * tid är precis den sortens fel som får en förare att sluta lita på appen.
 *
 * Att kasta bunten kostar oss inget vi hade kunnat använda ändå: har Facebook
 * hunnit bunta ihop inläggen är latenskravet på en minut redan brutet.
 */
export const SAMMANFATTNINGS_FRASER = [
  // svenska
  'nya inlägg i', 'nya aviseringar', 'nya notiser', 'du har flera',
  'senaste aktiviteten', 'det här missade du', 'det har du missat',
  'populära inlägg', 'sammanfattning', 'aktivitet i dina grupper',
  'notiser du missat', 'se vad som hänt',
  // engelska
  'new posts in', 'new notifications', 'you have notifications',
  'recent activity', 'what you missed', 'popular posts',
  'notifications summary', 'activity in your groups',
  'here is what happened', "here's what happened", 'top posts',
];

/**
 * Rader som betyder "här börjar ett nytt inlägg". Används bara för att RÄKNA
 * dem — ser vi fler än ett i samma mejl är det en bunt.
 *
 * ANTAGET på samma sätt som allt annat om formatet.
 */
export const INLAGGSRADER = [
  ' skrev i ', ' lade upp ', ' publicerade ', ' postade i ',
  ' delade ett ', ' delade en ', ' delade inlägget ',
  ' posted in ', ' wrote in ', ' posted to ',
  ' shared a ', ' shared an ', ' shared the ',
];

/**
 * Är det här ett buntat mejl?
 *
 * Två oberoende tecken, och ett räcker:
 *   en fras ur listan ovan, eller
 *   fler än en OLIKA "X skrev i Y"-rad i brödtexten.
 *
 * Det andra fångar bunten även om Facebook byter formulering i ämnesraden,
 * vilket är precis det som kommer att hända.
 *
 * "OLIKA" är hela poängen och stod fel en gång. Räknar man förekomster
 * istället för unika rader blir varje normalt mejl en bunt:
 *
 *   ämnesraden säger "Anna skrev i Här står polisen", och
 *   rubrikraden i brödtexten säger exakt samma sak, och
 *   är brevet multipart står den en gång i textdelen och en gång i HTML-delen.
 *
 * Tre förekomster av samma rad, ett enda inlägg. Med den räkningen hade
 * bryggan tyst kastat precis varje mejl den fick och sett helt frisk ut.
 * Därför: unika rader, och bara ur brödtexten.
 */
export function arSammanfattning(amne, brodtext, fraser = SAMMANFATTNINGS_FRASER) {
  const allt = `${amne || ''}\n${brodtext || ''}`.toLowerCase();
  if (!allt.trim()) return false;
  if (fraser.some(f => allt.includes(f))) return true;

  const rubriker = new Set();
  for (const raRad of String(brodtext || '').toLowerCase().split('\n')) {
    const rad = raRad.replace(/<[^>]{0,4000}>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!rad || rad.length > 200) continue;
    if (INLAGGSRADER.some(f => rad.includes(f))) rubriker.add(rad);
    if (rubriker.size > 1) return true;
  }
  return false;
}

/* ---- Från mejl till inläggstext -------------------------------------- */

/**
 * Rader som är Facebooks eget skräp och aldrig en del av inlägget.
 *
 * ANTAGET, och det mönster som med störst sannolikhet behöver justeras när
 * första riktiga mejlet kommer in. Matchningen är "raden INNEHÅLLER frasen",
 * gemener, så en fras behöver inte vara hela raden.
 *
 * Var hellre för generös här än för snål: en bortkastad skräprad kostar
 * ingenting, medan en kvarlämnad "Gå med i gruppen" gör att parsern letar
 * plats i fel ord och tillit sjunker under gränsen. Det som ALDRIG får läggas
 * till är något som kan förekomma i ett riktigt inlägg — 'polis', 'kontroll'
 * och varje ortnamn i Västmanland är förbjudna här.
 */
export const SKRAPRADER = [
  // svenska
  'visa inlägg', 'visa i facebook', 'gå till gruppen', 'gå med i gruppen',
  'se inlägget', 'öppna facebook',
  'det här meddelandet skickades till', 'du får det här mejlet',
  'du får det här meddelandet', 'om du inte vill få', 'avsluta prenumeration',
  'avregistrera', 'ändra dina inställningar', 'hantera dina notiser',
  'inställningar för aviseringar', 'sluta få dessa mejl', 'rapportera detta mejl',
  'meddelandet skickades av', 'sekretesspolicy', 'användarvillkor',
  // engelska
  'view post', 'view on facebook', 'go to group', 'join group',
  'see post', 'open facebook',
  'this message was sent to', 'you are receiving this', "you're receiving this",
  'if you do not want to receive', "if you don't want to receive",
  'unsubscribe', 'manage your notifications', 'notification settings',
  'change your settings', 'turn off these emails', 'report this email',
  'privacy policy', 'terms of service',
  // avsändarblocket i foten
  'facebook, inc', 'meta platforms', '1 hacker way', 'menlo park',
  '1601 willow', 'facebook ireland', 'meta platforms ireland',
];

/**
 * Knapptexter. Matchas mot HELA raden, inte som delsträng.
 *
 * Skillnaden mot listan ovan är inte kosmetisk och det här stod fel en gång:
 * 'dela', 'gilla' och 'svara' låg bland delsträngarna, och då försvann varje
 * rad som råkade innehålla dem. "Polis vid Delade vägen" innehåller 'dela'.
 * Ett inlägg som tyst kastas för att det innehöll fel bokstavsföljd är precis
 * den sortens fel ingen upptäcker förrän någon undrar varför en varning aldrig
 * kom fram.
 *
 * Korta ord hör alltså hemma här, långa distinkta fraser i listan ovan.
 */
export const SKRAPKNAPPAR = [
  'gilla', 'kommentera', 'svara', 'dela', 'visa', 'öppna', 'gå med',
  'like', 'comment', 'reply', 'share', 'view', 'open', 'join', 'see more',
  'visa mer', 'läs mer', 'read more', 'facebook', 'meta',
];

/** Ett HTML-brev blir läsbar text. Ingen DOM inblandad — filen ska gå i Deno. */
function taBortHtml(s) {
  return String(s)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|th|table|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]{0,4000}>/g, ' ');
}

const ENTITETER = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aring: 'å', Aring: 'Å', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö',
  eacute: 'é', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
};

function avkodaEntiteter(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => kodpunkt(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => kodpunkt(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENTITETER ? ENTITETER[n] : m));
}

function kodpunkt(n) {
  if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/**
 * Quoted-printable, men bara när det verkligen ÄR quoted-printable.
 *
 * Ett mejlbibliotek som inte avkodar transportkodningen lämnar efter sig
 * "V=C3=A4ster=C3=A5s" och rader som slutar på ett ensamt likhetstecken. Vi
 * avkodar det hellre här än att låta parsern se skräpet — men bara om det
 * ensamma likhetstecknet i radslutet faktiskt finns. Utan den grinden skulle
 * ett vanligt inlägg som råkar innehålla "=" mot förmodan kunna förstöras.
 */
export function avkodaQuotedPrintable(s) {
  const text = String(s || '');
  if (!/=\r?\n/.test(text)) return text;
  const utanMjukaBrott = text.replace(/=\r?\n/g, '');
  try {
    return decodeURIComponent(
      utanMjukaBrott.replace(/%/g, '%25').replace(/=([0-9A-Fa-f]{2})/g, '%$1')
    );
  } catch {
    // Trasig kodning: lämna texten som den är hellre än att tappa den.
    return utanMjukaBrott;
  }
}

/**
 * Mejlets brödtext -> bara det som en människa faktiskt skrev.
 *
 * Går igenom rad för rad och kastar Facebooks eget skräp: knappar, foten,
 * adresser, avprenumerationslänkar, tomma rader och rena URL:er. Det som blir
 * kvar antas vara inlägget.
 *
 * Rubrikraden ("Anna Andersson skrev i Här står polisen") kastas också — den
 * innehåller gruppens namn, och lämnas den kvar blir "här" och "står" ord som
 * parsern får leta plats i.
 *
 * @returns {string}
 */
export function plockaInlagg(brodtext, val = {}) {
  const { skraprader = SKRAPRADER, skrapknappar = SKRAPKNAPPAR, maxRader = 40 } = val;

  // Ordningen mellan avkodning och skrubbning är hela poängen, och den stod
  // fel en gång.
  //
  //   1. quoted-printable först. Annars ligger mjuka radbrott mitt i länkarna,
  //      och en skrubbning som slutar vid radbrottet lämnar halva adressen.
  //   2. skrubba. Rader med länkar plockas visserligen bort längre ner, men en
  //      inbäddad länk mitt i en rad rensas bara med regexen — och skulle den
  //      missa en variant hamnar mottagarens e-postadress i note.
  //   3. avkoda entiteterna, och SKRUBBA EN GÅNG TILL. Skrubbningen låg förr
  //      bara före det här steget, och då kunde &amp;n_m= aldrig räddas av
  //      ledet som gör om &amp; till &. Nu täcks båda formerna: den kodade i
  //      steg 2, den avkodade i steg 3.
  let text = saneraLankar(avkodaQuotedPrintable(String(brodtext || '')));
  if (/<[a-z!/][^>]{0,200}>/i.test(text)) text = taBortHtml(text);
  text = saneraLankar(avkodaEntiteter(text)).replace(/ /g, ' ').replace(/\r/g, '');

  const behallna = [];
  // Rader som kastades för att de SÅG UT som Facebooks rubrikrad. De sparas
  // undan istället för att slängas: blir det ingenting kvar alls var
  // gissningen fel, och då är en rubrikrad bättre än tomhet. Se nedan.
  const misstankta = [];

  for (const raRad of text.split('\n')) {
    if (behallna.length >= maxRader) break;
    const rad = raRad.replace(/\s+/g, ' ').trim();
    if (!rad) continue;

    const lag = rad.toLowerCase();

    // Rena skiljelinjer och knappramar.
    if (/^[-=_*·•—–~<>|\s[\]]+$/.test(rad)) continue;
    // En rad som bara är en länk är aldrig inlägget.
    if (/^(https?:\/\/|www\.)\S+$/i.test(rad)) continue;
    // Facebooks eget skräp.
    if (skraprader.some(f => lag.includes(f))) continue;
    // Knappar. Hela raden, inte delsträng — se SKRAPKNAPPAR.
    if (skrapknappar.includes(lag.replace(/[\s.·•|>]+$/, ''))) continue;
    // Rubrikraden: "X skrev i Y", "X posted in Y".
    if (INLAGGSRADER.some(f => lag.includes(f)) && rad.length < 160) {
      misstankta.push(rad.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim());
      continue;
    }

    // Inbäddade länkar mitt i en rad plockas bort, texten runt behålls.
    const rensad = rad.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!rensad) continue;

    behallna.push(rensad);
  }

  // Blev det ingenting kvar? Då träffade rubrikgissningen fel — det var inte
  // en rubrik, det var inlägget. Mönstren i INLAGGSRADER är antaganden om ett
  // format vi inte har sett, och ett antagande som tyst raderar hela inlägget
  // är det värsta felet den här filen kan göra: bryggan ser frisk ut, kön
  // töms, och ingen varning kommer någonsin fram.
  //
  // Hellre en rubrikrad för mycket i texten — parsern hittar ingen typ i den
  // och kastar den ändå — än ett inlägg som försvinner.
  if (!behallna.length && misstankta.length) {
    return misstankta.filter(Boolean).join(' ').trim();
  }

  return behallna.join(' ').trim();
}

/**
 * Ämnesraden -> inläggstext, när brödtexten inte gav något.
 *
 * ANVÄND MED MISSTRO. Efterforskningen hittade inte en enda verbatim
 * ämnesrad för ett gruppinlägg, varken på svenska eller engelska. Det mönster
 * som går att belägga i äkta notismejl är att in-app-notisens mening kopieras
 * rakt av och TRUNKERAS med tre punkter. Ämnesraden är alltså:
 *
 *   inte garanterat "Namn skrev i Grupp",
 *   inte garanterat komplett,
 *   inte något att nyckla dedup eller gruppfilter på.
 *
 * Den används därför bara som sista utväg för texten, och avdubblingen
 * bygger på länken (se plockaInlaggsId). Trunkeringspunkterna kapas bort så
 * att en avhuggen mening inte gör "Erikslund..." till en plats.
 */
export function plockaUrAmne(amne) {
  let s = String(amne || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';

  // Trunkeringen. Både … och ... , med eller utan blanksteg före.
  s = s.replace(/\s*(?:…|\.\.\.)\s*$/, '').trim();

  // "Anna skrev i Här står polisen: Polis vid Erikslund" -> efter kolon.
  const kolon = s.indexOf(':');
  if (kolon > 0 && kolon < s.length - 2) {
    const fore = s.slice(0, kolon).toLowerCase();
    if (INLAGGSRADER.some(f => fore.includes(f.trim()))) s = s.slice(kolon + 1).trim();
  }

  // Kvar står bara rubriken? Då finns ingen text.
  const lag = s.toLowerCase();
  if (INLAGGSRADER.some(f => lag.includes(f))) return '';
  if (/^(fw|fwd|sv|re)\s*:/i.test(s)) s = s.replace(/^(fw|fwd|sv|re)\s*:\s*/i, '');
  return s.trim();
}

/* ---- Länkarna: den enda verifierade delen av formatet ----------------- */

/**
 * Parametrar som ALDRIG får lagras eller skickas vidare.
 *
 * Det här är ett integritetskrav, inte en städning.
 *
 *   n_m        innehåller MOTTAGARENS e-postadress i klartext, procentkodad
 *              (n_m=nagon%40exempel.se). Den skulle alltså hamna i
 *              fbmejl_ko.brodtext, i note på varje rapport, och därmed i
 *              varje backup av databasen.
 *
 *   notif_id   ger LÄSÅTKOMST till notisens innehåll. Den som får tag på den
 *              behöver inget lösenord.
 *
 *   bcode      samma sorts kvitto, samma resonemang.
 *
 * De skrubbas i tre led, med flit: i tools/fbmejl-hamta.ps1 innan texten
 * lämnar maskinen, här innan något tolkas, och i fbmejl_ko_in() innan något
 * skrivs. Att skrubba tre gånger kostar ingenting; att missa ett led kostar
 * en e-postadress i en publik backup.
 */
export const HEMLIGA_PARAMS = ['n_m', 'notif_id', 'bcode', 'aref', 'nid'];

/**
 * Tecknen som kan stå omedelbart FÖRE ett parameternamn i en länk.
 *
 * Den här listan stod för kort en gång, och det var det dyraste felet i filen:
 * den krävde ?, &, %3F eller %26 direkt före namnet. Men Facebooks notismejl
 * ÄR HTML-brev, och i giltig HTML skrivs en href med &amp; mellan
 * parametrarna. Tecknet före n_m är då ';' — och då matchade ingenting.
 * Resultatet var att ägarens e-postadress låg kvar i KLARTEXT i alla tre
 * skrubbleden, alltså i fbmejl_ko.brodtext och i varje databasbackup.
 *
 *   &n_m=…       skrubbades
 *   &amp;n_m=…   skrubbades INTE
 *
 * [?&](?:amp;)* täcker &, &amp; och det dubbelkodade &amp;amp;. De numeriska
 * entiteterna och de dubbelt procentkodade formerna är med av samma skäl:
 * länken ligger inbäddad en gång till inuti omslagslänken.
 */
const SEPARATOR = '([?&](?:amp;)*|&#0*38;|&#[xX]0*26;|%3F|%26|%253F|%2526)';

/**
 * Vad ett parametervärde får bestå av.
 *
 * `=\r\n` är quoted-printables MJUKA RADBROTT. Utan dem i listan slutade
 * matchningen mitt i adressen — "n_m=3Delliot=\r\n%40exempel.se" skrubbades
 * bara fram till radbrottet och lämnade "%40exempel.se" kvar. Ett mjukt
 * radbrott betyder per definition att raden fortsätter, så att äta det är
 * rätt sak att göra.
 */
const VARDE = '(?:=\\r?\\n|[^&\\s"\'<>])*';

/**
 * Plockar bort de känsliga parametrarna men lämnar sökvägen intakt, så att
 * grupp-id och inläggs-id fortfarande går att läsa ut.
 *
 * Rå (&n_m=), HTML-kodad (&amp;n_m=), procentkodad (%26n_m%3D) och
 * quoted-printable-bruten form täcks alla. Se SEPARATOR och VARDE ovan.
 *
 * mid= lämnas kvar med flit — den är dedupnyckel och avslöjar ingenting.
 */
export function saneraLankar(text) {
  let s = String(text || '');
  for (const p of HEMLIGA_PARAMS) {
    s = s.replace(
      new RegExp(SEPARATOR + p + '(?:=|%3D|%253D)' + VARDE, 'gi'),
      '$1' + p + '=BORTTAGET'
    );
  }
  return s;
}

/**
 * Packar upp Facebooks omslagslänk så att den riktiga sökvägen går att läsa.
 *
 * BELAGT: gruppnotislänkar ligger inuti ett omslag av formen
 *
 *   facebook.com/n/?<sökväg>&medium=email&mid=<per-mejl-id>&bcode=…&n_m=<mejl>
 *
 * där sökvägen är procentkodad. Nyare mejl använder /nd/? istället för /n/?.
 * Utan uppackning ser plockaInlaggsId() bara "n" som sökväg och hittar
 * ingenting.
 *
 * Originaltexten behålls också — id:t kan ligga i en oomslagen länk längre
 * ner i samma mejl.
 */
export function packaUppOmslag(text) {
  const s = String(text || '');
  const delar = [s];
  const re = /facebook\.com\/nd?\/\?([^&\s"'<>]+)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    try { delar.push(decodeURIComponent(m[1])); } catch { delar.push(m[1]); }
    if (delar.length > 40) break;      // ett mejl har inte fyrtio omslag
  }
  return delar.join('\n');
}

/**
 * NOTISMEJLETS EGNA LÄNKAR — och bara de.
 *
 * Skillnaden mot "alla länkar i mejlet" är hela gruppfiltret, och den stod
 * fel en gång. Brödtexten innehåller ALLT den som skrev inlägget skrev, och
 * en människa som postar i en helt annan grupp kan mycket väl klistra in en
 * länk till ägarens grupp i sin text. Läser man "första /groups/-länken i
 * mejlet" blir det inlägget klassat som ägarens och hamnar på kartan.
 *
 * Två saker, och bara de två, är skrivna av FACEBOOK och inte av en människa:
 *
 *   omslaget   facebook.com/n/?<procentkodad sökväg>&medium=email&mid=…
 *              (nyare mejl: /nd/?). Omslaget byggs när mejlet skapas.
 *
 *   notif_t=   och notif_id= är Facebooks aviseringsparametrar. De sätts inte
 *              av den som skriver ett inlägg och överlever inte en inklistrad
 *              länk. notif_id skrubbas till BORTTAGET av saneraLankar, men
 *              själva PARAMETERNAMNET står kvar — markören överlever alltså
 *              skrubbningen, vilket är med flit.
 *
 * @returns {string[]} avkodade länkar/sökvägar, i den ordning de stod
 */
export function plockaNotisLankar(text) {
  const s = String(text || '');
  const ut = [];
  const avkoda = v => { try { return decodeURIComponent(v); } catch { return v; } };

  // 1. Omslaget. Allt inuti det är Facebooks eget.
  const omslag = /facebook\.com\/nd?\/\?([^&\s"'<>]+)/gi;
  let m;
  while ((m = omslag.exec(s)) !== null) {
    ut.push(avkoda(m[1]));
    if (ut.length >= 40) return ut;      // ett mejl har inte fyrtio omslag
  }

  // 2. Oomslagna länkar som bär Facebooks aviseringsparametrar.
  const url = /(?:https?:\/\/|www\.)[^\s"'<>]{0,600}/gi;
  while ((m = url.exec(s)) !== null) {
    if (!/(?:notif_t|notif_id)(?:=|%3D)/i.test(m[0])) continue;
    ut.push(avkoda(m[0]));
    if (ut.length >= 80) break;
  }
  return ut;
}

/**
 * Vilken grupp gäller NOTISEN? Inte "vilken grupp nämns någonstans i mejlet".
 *
 * Det här är den enda funktion gruppfiltret får fråga. Se plockaNotisLankar.
 *
 * @returns {string|null} gruppens id eller slug i gemener, null om mejlet
 *   inte bär någon aviseringslänk alls (då VET vi inte, och då kastar vi).
 */
export function plockaNotisGrupp(text) {
  for (const lank of plockaNotisLankar(text)) {
    const m = String(lank).match(/(?:^|[/?&=])groups\/([a-z0-9._-]+)/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Inläggs-id ur en enskild, redan uppackad sökväg.
 *
 * BELAGT: gruppnotislänken har formen
 *
 *   facebook.com/groups/<gid_eller_slug>/<post_id>/?notif_t=group_activity&notif_id=…
 *
 * Alltså är inläggs-id TREDJE sökvägssegmentet — inte /posts/<id>/, som är
 * den form man ser i webbläsaren. Båda hanteras nedan; den verifierade först
 * hade gett samma svar, men den gamla formen finns i äldre mejl och kostar
 * inget att behålla.
 */
function idUrSokvag(s) {
  // /groups/<gid>/posts/<pid>/ och /groups/<gid>/permalink/<pid>/
  const gammal = s.match(/\/?groups\/([a-z0-9._-]+)\/(?:posts|permalink)\/(\d+)/i);
  if (gammal) return `${gammal[1]}_${gammal[2]}`;

  // BELAGD FORM: /groups/<gid_eller_slug>/<post_id>/
  //
  // Minst sex siffror i inläggs-id:t med flit. Utan den gränsen matchar
  // /groups/123/about, /groups/123/members och varje annan undersida, och
  // då blir "about" ett inläggs-id som alla mejl om gruppen delar — vilket
  // hade avdubblat bort precis allting utom det första inlägget.
  const ny = s.match(/\/?groups\/([a-z0-9._-]+)\/(\d{6,})(?:[/?&#]|$)/i);
  if (ny) return `${ny[1]}_${ny[2]}`;

  const story = s.match(/[?&]story_fbid=(\d+)/i);
  const gid = s.match(/[?&](?:id|group_id)=(\d+)/i);
  if (story) return gid ? `${gid[1]}_${story[1]}` : story[1];

  const fbid = s.match(/[?&]fbid=(\d+)/i);
  if (fbid) return gid ? `${gid[1]}_${fbid[1]}` : fbid[1];

  const multi = s.match(/multi_permalinks?=(\d+)/i);
  if (multi) return multi[1];

  return null;
}

/**
 * Inläggets id ur länken. Den bästa dedupnyckeln som finns — samma inlägg får
 * samma id oavsett hur många mejl Facebook skickar om det (nytt mejl vid
 * varje kommentar).
 *
 * NOTISMEJLETS EGEN LÄNK FÖRST. Det stod inte så en gång: funktionen tog
 * första träffen i hela mejltexten och provade /posts/-formen först, och då
 * kunde en främling som klistrade in en länk till ägarens grupp i ETT ANNAT
 * gruppmejl få sitt inlägg nycklat som ägarens.
 *
 * Hela mejlet är fortfarande en fallback, men BARA som dedupnyckel — vilken
 * grupp mejlet gäller avgörs aldrig här, utan i plockaNotisGrupp().
 */
export function plockaInlaggsId(text) {
  for (const lank of plockaNotisLankar(text)) {
    const id = idUrSokvag(lank);
    if (id) return id;
  }
  return idUrSokvag(packaUppOmslag(text));
}

/**
 * Mejlets eget id ur omslagslänken (mid=).
 *
 * Reserv när inläggs-id inte gick att läsa ut. Den står FÖRE Message-ID i
 * nyckelordningen, och skälet är konkret: ägaren kommer med största
 * sannolikhet att VIDAREBEFORDRA Facebook-mejlen till den dedikerade
 * postlådan (se docs/fbmejl.md, steg 2), och en vidarebefordran kan skriva om
 * Message-ID. mid= ligger i brödtexten och överlever.
 *
 * mid är per mejl, inte per inlägg — den avdubblar alltså samma mejl läst två
 * gånger, inte samma inlägg mejlat två gånger. Det är textnyckelns jobb.
 */
export function plockaMid(text) {
  const m = packaUppOmslag(text).match(/[?&]mid=([A-Za-z0-9._-]{4,80})/i);
  return m ? m[1] : null;
}

/* ---- Nycklar --------------------------------------------------------- */

/**
 * FNV-1a, 32 bitar. Samma funktion som i js/facebook.js och js/telegram.js,
 * med flit — alla tre vägarna in måste räkna fram samma textnyckel för samma
 * text, annars blir samma inlägg tre rapporter när man kör två vägar samtidigt.
 */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Message-ID utan vinkelparenteser, gemener, trimmat. */
export function normaliseraMessageId(id) {
  return String(id || '').trim().replace(/^<|>$/g, '').trim().toLowerCase().slice(0, 200);
}

/**
 * @returns {{ stabil:string, text:string, textGrannar:string[],
 *             externalId:string, messageId:string|null, inlaggsId:string|null }}
 *   stabil      — mejlets egen identitet. Samma mejl, alltid samma nyckel.
 *   text        — samma text i samma tidsfönster, oavsett mejl-id. IDENTISK med
 *                 den js/telegram.js räknar fram, så samma inlägg via två vägar
 *                 blir en varning.
 *   textGrannar — samma text i facket före och efter. Se nedan.
 *   externalId  — det som blir unikt i databasen.
 *
 * Ordningen är medveten: inläggets id först när det finns, Message-ID annars.
 * Facebook skickar ett nytt mejl med nytt Message-ID varje gång någon
 * kommenterar samma inlägg — utan inläggs-id blir det tre varningar av ett
 * inlägg, och textnyckeln räddar bara det om Facebook återger texten likadant
 * i alla tre mejlen. Det gör den inte alltid.
 */
export function nycklarFor(mejl, nu = Date.now()) {
  const msgId = normaliseraMessageId(mejl?.messageId ?? mejl?.['message-id']);
  const rat = `${mejl?.body || ''}\n${mejl?.subject || ''}`;
  const inlaggsId = mejl?.inlaggsId || plockaInlaggsId(rat);
  const mid = plockaMid(rat);

  const text = plockaInlagg(mejl?.body) || plockaUrAmne(mejl?.subject);
  const h = hash(normalize(text));

  // Tidsfacket är FAST, inte glidande, och det får det inte vara ensamt.
  //
  // Två mejl med identisk text två minuter isär, på var sin sida om en
  // tretimmarsgräns, får två olika fack och därmed två nycklar — två nålar på
  // samma plats. Nyckeln SJÄLV måste ändå räknas fram exakt som
  // js/telegram.js gör det, annars slutar den korsvisa avdubblingen mot
  // Telegram-spegeln fungera. Alltså: kanonisk nyckel som förr, plus
  // grannfacken att SLÅ UPP på. bearbeta() letar i alla tre.
  const fackNr = Math.floor(nu / DEDUP_FONSTER_MS);
  const nyckelFor = f => `tx:${h}:${f.toString(36)}`;
  const textNyckel = nyckelFor(fackNr);
  const textGrannar = [nyckelFor(fackNr - 1), nyckelFor(fackNr + 1)];

  // Ordningen är inte godtycklig:
  //   inläggs-id  identifierar INLÄGGET. Tre kommentarsmejl om samma inlägg
  //               ger samma nyckel, alltså en varning.
  //   mid         identifierar MEJLET, men överlever vidarebefordran.
  //   Message-ID  identifierar mejlet, men kan skrivas om vid vidarebefordran.
  //   textnyckeln sista utvägen, och den som delas med Telegram-spegeln.
  const stabil = inlaggsId ? `fbm:post:${inlaggsId}`
    : mid ? `fbm:mid:${mid}`
    : msgId ? `fbm:${msgId}`
    : textNyckel;

  return {
    stabil, text: textNyckel, textGrannar, externalId: stabil,
    messageId: msgId || null, inlaggsId, mid,
  };
}

/* ---- Tid -------------------------------------------------------------- */

/**
 * När skrevs inlägget?
 *
 * Vi vet det inte, och det är värt att säga rakt ut. Mejlets Date säger när
 * FACEBOOK SKICKADE MEJLET, inte när inlägget skrevs. Mellan de två ligger
 * Metas egen kö, och den är olika lång olika dagar.
 *
 * Date är ändå det bästa vi har, och felet drar åt rätt håll: mejlet skickas
 * efter inlägget, så varningen blir aningen FÄRSKARE än den borde vara, aldrig
 * äldre. Det gör att en varning kan ligga kvar någon minut för länge — inte
 * att en död varning väcks till liv.
 *
 * Framtida tidsstämplar kapas mot nu. En klocka som går fel någonstans i
 * kedjan ska inte kunna ge en varning evigt liv.
 */
export function skrivenNar(mejl, nu = Date.now()) {
  const rat = mejl?.date ?? mejl?.sentAt ?? mejl?.receivedAt;
  let ms = null;
  if (typeof rat === 'number' && Number.isFinite(rat)) {
    ms = rat < 1e12 ? rat * 1000 : rat;      // sekunder eller millisekunder
  } else if (rat instanceof Date) {
    ms = rat.getTime();
  } else if (typeof rat === 'string' && rat.trim()) {
    const t = Date.parse(rat);
    if (Number.isFinite(t)) ms = t;
  }
  if (!Number.isFinite(ms)) return nu;
  return Math.min(ms, nu);
}

/* ---- Position --------------------------------------------------------- */

/**
 * Hur brett pekar platsnamnet?
 *
 * Identisk med js/telegram.js gissaGeokodTyp(). Den importeras INTE därifrån,
 * och det är ett medvetet undantag från regeln om att inte kopiera:
 * js/telegram.js importerar js/store.js som importerar halva appen, och den
 * här filen ska gå att köra i en edge-funktion utan att dra in kartan. Skillnaden
 * mot ordlistorna är att en felaktig geokodgissning ger en STÖRRE antagen
 * radie, alltså en försiktigare bedömning — medan ett nykterhetsfilter som
 * glider isär släpper igenom det som aldrig får släppas igenom.
 *
 * Ändrar du den ena, ändra den andra. Testet "geokodtypen gissas likadant som
 * i telegram.js" i fbmejl-test.html jämför dem mot varandra och säger ifrån.
 */
export function gissaGeokodTyp(plats, traff) {
  if (traff?.typ) return traff.typ;
  const t = normalize(traff?.label || plats || '');
  if (!t) return 'okand';
  if (/\d/.test(t) && /(gatan|vägen|gata|väg)\b/.test(t)) return 'adress';
  if (/(gatan|vägen|leden|gränd|torget|bron|rondell|rondellen|korsning|korsningen|motet|avfart|påfart|infart|rampen)/.test(t)) return 'vag';
  if (/^e\s?\d{1,3}\b|^rv\s?\d|^väg\s?\d/.test(t)) return 'vag';
  if (/^(västerås|sala|köping|arboga|fagersta|hallstahammar|surahammar|kungsör|norberg|skinnskatteberg|västmanland)$/.test(t)) return 'ort';
  return 'okand';
}

/* ---- Tolkning --------------------------------------------------------- */

/**
 * Ett mejl in — en rapport eller ett skäl ut.
 *
 * Ren funktion. Geokodningen görs INTE här, för den kräver nätet; tolkningen
 * lämnar ifrån sig platsfrasen och låter den som har nätet slå upp den.
 *
 * @param {{ messageId?:string, from?:string, subject?:string, body?:string,
 *           date?:number|string|Date, inlaggsId?:string }} mejl
 * @param {{ nu?:number, minTillit?:number, grupp?:string|null,
 *           gruppId?:string|null, kravAvsandare?:boolean, kravGrupp?:boolean,
 *           domaner?:string[] }} [val]
 * @returns {{ ok:false, skal:string, detalj?:string, nycklar:Object }
 *          |{ ok:true, typ:string, plats:string, tillit:number, text:string,
 *             skrivenAt:number, gallerTill:number, fordrojningS:number,
 *             position:null, nycklar:Object }}
 */
export function tolkaMejl(mejl, val = {}) {
  const {
    nu = Date.now(), minTillit = MIN_TILLIT, grupp = null, gruppId = null,
    kravAvsandare = true, kravGrupp = true, domaner = FB_DOMANER,
  } = val;

  const nycklar = nycklarFor(mejl, nu);
  const nej = (skal, detalj) => ({ ok: false, skal, detalj, nycklar });

  const amne = String(mejl?.subject || '');
  const brod = String(mejl?.body || '');

  // Produktregel nummer ett, före allt annat och på HELA mejlet: nykterhets-
  // och drogkontroller rapporteras aldrig.
  //
  // Kontrollen körs på ämne plus rå brödtext, alltså innan skräpet rensats
  // bort och innan parsern sett något. Det är med flit bredare än nödvändigt:
  // misslyckas plockaInlagg() med ett format vi inte känner till ska ordet
  // "nykterhetskontroll" ändå stoppa mejlet. Parsern gör samma kontroll igen
  // längre ner — det är samma regel körd två gånger, inte en andra ordlista,
  // och den kan bara stoppa mer, aldrig släppa igenom mer.
  if (isSobrietyCheck(`${amne} ${brod}`)) return nej(SKAL.NYKTERHET);

  if (kravAvsandare && !arFacebookAvsandare(mejl?.from, domaner)) {
    return nej(SKAL.FEL_AVSANDARE, String(mejl?.from || '').slice(0, 120));
  }

  // Buntade notiser kastas hela. Se arSammanfattning() för varför.
  if (arSammanfattning(amne, brod)) return nej(SKAL.SAMMANFATTNING);

  // Följer ägaren flera grupper hamnar de i samma postlåda, och ägarens krav
  // är absolut: notis BARA från hans grupp, aldrig från någon annan grupp han
  // råkar vara med i.
  //
  // STANDARD ÄR ATT KASTA. Det stod tvärtom en gång: saknades gruppId släpptes
  // allting igenom — och eftersom null var standardvärdet var det DET man fick
  // om man glömde att skicka in något. Ett filter man måste komma ihåg att
  // sätta är inget filter. Vill man verkligen köra utan får man säga det högt
  // med kravGrupp: false.
  //
  // Två sätt att avgöra vilken grupp mejlet gäller, och det första är
  // oändligt mycket bättre:
  //
  //   gruppId  läses ur NOTISMEJLETS EGEN länk — omslaget eller notif_t=,
  //            alltså det Facebook själv skrev. Sätt den så fort du vet
  //            gruppens id eller slug; den står i adressfältet när du öppnar
  //            gruppen. VIKTIGT: den måste stavas likadant som i länken. Står
  //            det en slug i länken (/groups/harstarpolisen/) men ett
  //            sifferid här matchar ingenting, och då kastas varje mejl. Det
  //            syns i summeringen — se avvisadeGrupper i bearbeta().
  //
  //   grupp    matchar gruppens NAMN mot texten. Fallback, och svag: namnet
  //            står i ämnesraden, och ämnesraden går inte att lita på (den
  //            trunkeras, se plockaUrAmne). Ett långt gruppnamn kan huggas av
  //            mitt i och matchar då inte alls.
  if (!gruppId && !grupp) {
    if (kravGrupp) return nej(SKAL.INGET_GRUPPFILTER, 'sätt gruppId eller grupp');
  } else if (gruppId) {
    const id = String(gruppId).trim().toLowerCase();

    // BARA notismejlets egen länk. Fallbacken som letade strängen
    // "groups/<id>" var som helst i mejlet är borttagen med flit: vilken
    // förekomst som helst räckte, och ett mejl från en ANNAN grupp vars text
    // citerade en länk till ägarens grupp blev därmed en rapport, nycklad som
    // ägarens grupp. Se plockaNotisLankar.
    const sett = plockaNotisGrupp(`${amne}\n${brod}`);
    if (!sett) return nej(SKAL.FEL_GRUPP, 'ingen aviseringslänk med grupp');
    if (sett !== id) return nej(SKAL.FEL_GRUPP, sett.slice(0, 120));
  } else {
    const nal = normalize(grupp);
    if (nal && !normalize(`${amne} ${brod}`).includes(nal)) {
      return nej(SKAL.FEL_GRUPP, amne.slice(0, 120));
    }
  }

  const text = plockaInlagg(brod) || plockaUrAmne(amne);
  if (!text || text.length < 3) return nej(SKAL.TOM);

  // Andra gången, nu på den rensade texten. Skulle rensningen ha satt ihop
  // två rader till "alkohol kontroll" fångas det här.
  if (isSobrietyCheck(text)) return nej(SKAL.NYKTERHET);

  const tolkat = parseReportText(text);

  if (tolkat?.intent === 'refused') {
    return nej(tolkat.reason === 'sobriety' ? SKAL.NYKTERHET : SKAL.KAMERA);
  }
  if (!tolkat) return nej(SKAL.OBEGRIPLIG);

  // "Nu är dom borta" är sann information, men vi vet inte vilken rapport den
  // gäller. Att gissa och släcka fel varning är värre än att låta den löpa ut
  // av sig själv om en halvtimme.
  if (tolkat.intent === 'clear') return nej(SKAL.AVBLAST);

  if (tolkat.confidence < minTillit) {
    return nej(SKAL.LAG_TILLIT, tolkat.confidence.toFixed(2));
  }

  // Utan plats finns ingen varning. Mejlvägen har ingen kartnål att falla
  // tillbaka på — Telegram kunde bära en location, ett mejl kan inte det.
  if (!tolkat.place) return nej(SKAL.INGEN_PLATS);

  const skrivenAt = skrivenNar(mejl, nu);
  const ttlMs = (TTL_MINUTES[tolkat.type] ?? 45) * 60000;
  const gallerTill = skrivenAt + ttlMs;

  // En varning som redan hunnit löpa ut ska aldrig läggas ut. Mejlet kan ha
  // legat oläst i timmar om pollaren varit nere, och en minut kvar är inte
  // värt en uppläsning.
  if (gallerTill <= nu + 60000) {
    return nej(SKAL.FOR_GAMMALT, new Date(skrivenAt).toISOString());
  }

  return {
    ok: true,
    typ: tolkat.type,
    plats: tolkat.place,
    tillit: tolkat.confidence,
    text,
    skrivenAt,
    gallerTill,
    // Mätt fördröjning mellan att mejlet skickades och att vi läste det. Det
    // här är ett GOLV, inte sanningen: tiden från att bilen sågs till att
    // någon skrev om den går inte att veta, och Metas egen kö mellan inlägget
    // och mejlet syns inte heller. Men ett mätt golv är ärligare än
    // kvalitetslagrets antagande på 300 sekunder.
    fordrojningS: Math.round(clamp((nu - skrivenAt) / 1000, 0, 86400)),
    position: null,
    nycklar,
  };
}

/* ---- Rapportraden ----------------------------------------------------- */

/**
 * Färdig rad till public.reports.
 *
 * Samma form som js/telegram.js byggRapport() lämnar ifrån sig, med tre extra
 * fält som INTE är kolumner i reports (text_nyckel, message_id, inlaggs_id).
 * De läses av public.fbmejl_ta_emot() i supabase/fbmejl.sql. Raden går alltså
 * till databasen genom RPC:n, inte genom en direkt insert mot /rest/v1/reports
 * — PostgREST hade avvisat hela raden med 400 för tre okända kolumner.
 *
 * @param {Object} tolkning  resultatet från tolkaMejl med ok = true
 * @param {{lat:number, lon:number, label?:string, source?:string, typ?:string}} traff
 * @param {{ deviceId?:string, kalla?:string, id?:string }} [val]
 */
export function byggRapport(tolkning, traff, val = {}) {
  const { deviceId = BRYGGA_ENHET, kalla = KALLA, id = uid() } = val;
  if (!traff || !Number.isFinite(traff.lat) || !Number.isFinite(traff.lon)) {
    throw new Error('byggRapport: ingen position');
  }

  return {
    // Primärnyckeln är slumpad med flit. Vore den härledd ur Message-ID
    // skulle en omkörning krocka på både id och external_id samtidigt, och
    // on conflict kan bara tyst hoppa över det ena.
    id,
    type: tolkning.typ,
    lat: traff.lat,
    lon: traff.lon,
    label: String(traff.label || tolkning.plats).slice(0, LABEL_MAX),
    note: tolkning.text.slice(0, NOTE_MAX),
    source: kalla,
    device_id: deviceId,
    external_id: tolkning.nycklar.externalId,
    created_at: tolkning.skrivenAt,
    expires_at: tolkning.gallerTill,
    confirms: 1,
    denials: 0,

    // Kvalitetsfälten, se supabase/kvalitetsfalt.sql och js/kvalitet.js.
    //
    // De som är null är null med flit. NULL betyder "vet inte" och ska aldrig
    // tolkas som noll: vi vet ingenting om skribentens GPS eller fart, och
    // att skriva en nolla där hade sagt "perfekt noggrannhet, stillastående".
    parser_confidence: Number(tolkning.tillit.toFixed(3)),
    fordrojning_s: tolkning.fordrojningS,
    geokod: traff.source || 'okand',
    geokod_typ: gissaGeokodTyp(tolkning.plats, traff),
    geokod_radius_m: null,   // låt kvalitet.js sätta radien utifrån geokod_typ
    gps_accuracy_m: null,
    fart_kmh: null,

    // Inte kolumner i reports — läses av public.fbmejl_ta_emot().
    text_nyckel: tolkning.nycklar.text,
    // Grannfacken. Databasen jämför text_nyckel exakt, och exakt jämförelse
    // mot ett FAST tidsfack missar två identiska texter som råkar ligga på var
    // sin sida om en gräns — även när de kom två minuter isär. bearbeta()
    // löser det i minnet; den här listan finns för att fbmejl_ta_emot() ska
    // kunna göra samma sak mot fbmejl_lasta och telegram_lasta.
    text_nyckel_grannar: tolkning.nycklar.textGrannar || [],
    message_id: tolkning.nycklar.messageId,
    inlaggs_id: tolkning.nycklar.inlaggsId,
  };
}

/* ---- Omgången --------------------------------------------------------- */

/**
 * Kör en omgång mejl genom tolkning, geokodning och radbygge.
 *
 * Gör inget nätverksanrop själv. Geokodningen skickas in, och gör den inget
 * anrop heller (till exempel i ett test) rör funktionen aldrig nätet.
 *
 * @param {Array<Object>|Object} mejl  ett mejl eller en lista av mejl
 * @param {{
 *   geokoda?: (plats:string) => Promise<{lat,lon,label,source?}|null>,
 *   sedda?: Set<string>,      dedup över anrop — skicka in samma mängd varje gång
 *   nu?: number, minTillit?: number, grupp?: string|null, gruppId?: string|null,
 *   kravAvsandare?: boolean, kravGrupp?: boolean,
 *   deviceId?: string, kalla?: string
 * }} [val]
 * @returns {Promise<Object>} sammanfattning, se summeringText()
 */
export async function bearbeta(mejl, val = {}) {
  const {
    geokoda = null,
    sedda = new Set(),
    nu = Date.now(),
    minTillit = MIN_TILLIT,
    grupp = null,
    gruppId = null,
    kravAvsandare = true,
    kravGrupp = true,
    deviceId = BRYGGA_ENHET,
    kalla = KALLA,
  } = val;

  const lista = Array.isArray(mejl) ? mejl : mejl ? [mejl] : [];
  const summering = {
    lasta: lista.length,
    skapade: 0,
    dubbletter: 0,
    bortsorterade: {},
    rapporter: [],
    okandaPlatser: [],
    // Vilka grupper som faktiskt kastades, med det namn de hade i länken.
    //
    // Finns den här listan inte går ett trasigt gruppfilter inte att skilja
    // från en tom inkorg: står det ett sifferid i gruppId men en slug i
    // länken blir svaret "0 rapporter" båda gångerna, och bryggan ser frisk
    // ut medan den kastar precis allt. Med listan står det
    // "fel grupp: harstarpolisen" i summeringen och felet syns direkt.
    avvisadeGrupper: [],
    fel: [],
  };

  const bort = skal => { summering.bortsorterade[skal] = (summering.bortsorterade[skal] || 0) + 1; };

  for (const m of lista) {
    if (!m || typeof m !== 'object') { bort(SKAL.TOM); continue; }

    const tolkning = tolkaMejl(m, { nu, minTillit, grupp, gruppId, kravAvsandare, kravGrupp });
    const { stabil, text: textNyckel, textGrannar = [] } = tolkning.nycklar;

    // Dedup före allt annat arbete. Både mejlets egen identitet och
    // textnyckeln räknas: det första fångar samma mejl läst två gånger, det
    // andra fångar samma inlägg som kom in via Telegram eller userscriptet.
    //
    // Grannfacken räknas också. Textnyckelns tidsfack är fast, och utan
    // grannarna blir två identiska texter två minuter isär men på var sin
    // sida om en fackgräns två varningar. Se nycklarFor().
    if (sedda.has(stabil) || sedda.has(textNyckel) || textGrannar.some(k => sedda.has(k))) {
      summering.dubbletter++;
      continue;
    }

    if (!tolkning.ok) {
      bort(tolkning.skal);
      // Fel grupp ska SYNAS. Se avvisadeGrupper ovan.
      if (tolkning.skal === SKAL.FEL_GRUPP && tolkning.detalj
          && !summering.avvisadeGrupper.includes(tolkning.detalj)) {
        summering.avvisadeGrupper.push(tolkning.detalj);
      }
      // Fel avsändare märks inte som sett. Kommer mejlet från något annat än
      // Facebook är det inte gruppens inlägg, och skulle domänlistan utökas
      // senare ska inget vara tyst bortsorterat sedan innan.
      //
      // Fel grupp och inget gruppfilter märks inte heller: rättar man
      // gruppId — eller sätter det för första gången — ska mejlen prövas om,
      // inte ligga kvar tyst bortsorterade.
      const foratigt = tolkning.skal === SKAL.FEL_AVSANDARE
                    || tolkning.skal === SKAL.FEL_GRUPP
                    || tolkning.skal === SKAL.INGET_GRUPPFILTER;
      if (!foratigt) { sedda.add(stabil); sedda.add(textNyckel); }
      continue;
    }

    if (typeof geokoda !== 'function') {
      throw new Error('bearbeta: geokoda-funktionen saknas — skicka in den, ' +
                      'modulen gör inga egna nätverksanrop.');
    }

    let traff = null;
    try {
      traff = await geokoda(tolkning.plats);
    } catch (e) {
      bort(SKAL.GEOKOD_FEL);
      summering.fel.push(`Geokodning av "${tolkning.plats}" misslyckades: ${e.message}`);
      continue;   // ingen minnesmarkering: nätverksfel ska få försöka igen
    }

    if (!traff || !Number.isFinite(traff.lat) || !Number.isFinite(traff.lon)) {
      bort(SKAL.OKAND_PLATS);
      if (!summering.okandaPlatser.includes(tolkning.plats)) {
        summering.okandaPlatser.push(tolkning.plats);
      }
      sedda.add(stabil); sedda.add(textNyckel);
      continue;
    }

    summering.rapporter.push(byggRapport(tolkning, traff, { deviceId, kalla }));
    summering.skapade++;
    sedda.add(stabil); sedda.add(textNyckel);
  }

  return summering;
}

/** En rad på svenska att logga eller visa i en admin-vy. */
export function summeringText(s) {
  const bort = Object.values(s.bortsorterade).reduce((a, b) => a + b, 0);
  const delar = [
    `${s.lasta} ${s.lasta === 1 ? 'mejl' : 'mejl'}`,
    `${s.skapade} ${s.skapade === 1 ? 'varning' : 'varningar'}`,
  ];
  if (s.dubbletter) delar.push(`${s.dubbletter} redan inne`);
  if (bort) delar.push(`${bort} bortsorterade`);
  if (s.okandaPlatser.length) delar.push(`okänd plats: ${s.okandaPlatser.join(', ')}`);
  // Måste synas. "0 varningar" för att gruppfiltret är felstavat ser exakt ut
  // som "0 varningar" för att ingen postat något — utom med den här raden.
  if (s.avvisadeGrupper?.length) delar.push(`fel grupp: ${s.avvisadeGrupper.join(', ')}`);
  if (s.bortsorterade?.[SKAL.INGET_GRUPPFILTER]) delar.push('inget gruppfilter satt');
  return delar.join(' · ');
}
