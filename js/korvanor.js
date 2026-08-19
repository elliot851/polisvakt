// Körningspåminnelse — det rena lagret.
//
// Problemet, rakt sagt: en varningsapp som inte är påslagen varnar för
// ingenting. Det spelar ingen roll hur bra kamerorna är kartlagda om
// föraren sitter i bilen med appen stängd. Att få igång appen är därför
// värd mer än varje enskild varning i den.
//
// -------------------------------------------------------------------------
// VAD SOM INTE GÅR, OCH VARFÖR — läs det här innan du "förbättrar" något
//
// Den uppenbara lösningen är att känna av körning via GPS i bakgrunden. Den
// finns inte i en webbapp, och det är mätt i webbläsaren, inte antaget:
//
//   * navigator.geolocation är `undefined` inne i en Worker och i en
//     ServiceWorker. Inte "kräver tillstånd" — objektet finns helt enkelt
//     inte. En service worker kan alltså aldrig läsa position.
//   * Geofencing-API:t (GeofencingManager) finns inte i någon webbläsare
//     som är i drift. Specen övergavs.
//   * En sida som inte ligger framme får varken timers som är att lita på
//     eller positionsuppdateringar. Backgrounded = frusen.
//
// Slutsats: appen kan INTE upptäcka att bilen börjar rulla medan telefonen
// ligger i fickan. Bygg inget som låtsas göra det — det blir en funktion som
// tyst inte fungerar, vilket är sämre än ingen funktion alls.
//
// VÄGEN SOM FUNGERAR
//
// Appen lär sig i stället NÄR användaren brukar köra, av de körningar som
// faktiskt registrerats (js/driving.js, nyckeln `pv.habits.v1`). De tiderna
// skickas upp till servern, och servern skickar en web push strax innan. Den
// kommer fram med appen helt stängd — även på iPhone, för appar som lagts
// till på hemskärmen. Se supabase/korpaminnelse.sql och docs/korpaminnelse.md.
// -------------------------------------------------------------------------
//
// Den här filen är BARA logiken: den vet inte om nätverk, localStorage,
// Notification eller DOM. In går en historik av körningar, ut går fönster och
// ett ja/nej. Det gör den testbar utan att någon behöver köra bil, och det
// gör att exakt samma regler kan skrivas om i SQL på serversidan utan att man
// behöver gissa vad klienten menade.
//
// Om omdömet, som är hela svårigheten:
//
//   Underlag  En påminnelse byggd på en enda observation är en gissning. Den
//             stör, den blir fel, och användaren stänger av notiser — och då
//             är kanalen borta för alltid. Vi kräver flera observationer,
//             över flera veckor, OCH att de utgör en tillräcklig andel av
//             tillfällena. Tre måndagar av tre är ett mönster. Tre måndagar
//             av tolv är slump.
//   Andel     Räknas per veckodag, inte totalt. Utan andelen räcker det att
//             köra länge nog för att allt ska se ut som en vana.
//   En gång   Högst en påminnelse per fönster och dygn. Cron kör ofta och
//             skulle annars träffa samma fönster flera gånger i rad.
//   Tyst      Natt är tyst, alltid. En felinlärd nattlucka får aldrig väcka
//             någon 03:00. Och kör man redan, eller har appen precis varit
//             framme, ska ingenting plinga.
//   Lokal tid Allt räknas i användarens egen tidszon. Se kommentaren vid
//             lokalTid() — det här är felet som visar sig först i oktober.

/* ====================== INSTÄLLNINGAR ============================== */

/**
 * Standardtrösklarna. Alla går att skruva på per anrop, men ändra dem inte
 * utan att veta vad var och en skyddar mot — de sitter ihop.
 */
export const STANDARD = Object.freeze({
  /** Så många körningar i samma fönster innan det räknas som en vana. */
  minPerFonster: 3,
  /** Så många körningar totalt innan appen påstår sig veta något alls. */
  minTotalt: 6,
  /** Historiken måste sträcka sig så här många dygn. Två veckor på en dag
   *  är inte två veckors underlag. */
  minSpannDagar: 10,
  /** Andel av tillfällena. 3 måndagar av 3 = 1,0. 3 av 12 = 0,25. */
  minAndel: 0.4,

  /** Tyst från och med den här timmen (lokal tid). */
  tystFran: 23,
  /** Tyst till och med timmen före den här. Standard: tyst 23–05. */
  tystTill: 5,

  /** Hur långt före fönstret påminnelsen ska komma. Femton minuter räcker
   *  för jacka och ytterdörr utan att man hinner glömma den igen. */
  ledtidMin: 15,
  /** Tak per dygn. Den som kör mycket har många fönster — och den som får
   *  sex notiser om dagen stänger av dem. Taket skyddar kanalen. */
  maxPerDygn: 2,
  /** Minsta tid mellan två påminnelser. */
  minMellanrumMin: 90,
  /** Har appen varit framme så här nyligen behövs ingen påminnelse. */
  nyssAnvandMin: 20,
});

/** Varför det blev som det blev. Stabila koder, för tester och loggar. */
export const SKAL = Object.freeze({
  OK: 'paminn',
  KOR_REDAN: 'kor-redan',
  NYSS_ANVAND: 'nyss-anvand',
  KORD_IDAG: 'kord-idag',
  FOR_LITE: 'for-lite-underlag',
  NATT: 'natt',
  INGET_FONSTER: 'inget-fonster',
  REDAN_PAMINND: 'redan-paminnd',
  TAK: 'tak-per-dygn',
  FOR_TATT: 'for-tatt',
});

const DAGAR = ['söndagar', 'måndagar', 'tisdagar', 'onsdagar', 'torsdagar', 'fredagar', 'lördagar'];
const DAG_ENTAL = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
const DYGN = 86400000;
const pad = n => String(n).padStart(2, '0');

/* ========================== LOKAL TID ============================== */

const formatterare = new Map();

function formatterare_for(tidszon) {
  if (formatterare.has(tidszon)) return formatterare.get(tidszon);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tidszon || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false, hourCycle: 'h23',
    });
  } catch { f = null; }   // okänd tidszon — vi faller tillbaka nedan
  formatterare.set(tidszon, f);
  return f;
}

/** Enhetens egen tidszon som IANA-namn. */
export function egenTidszon() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Stockholm'; }
  catch { return 'Europe/Stockholm'; }
}

/**
 * Tidpunkt → väggklocka i användarens tidszon.
 *
 * SOMMARTID, som är hela poängen med den här funktionen:
 *
 * Sverige ligger UTC+1 på vintern och UTC+2 på sommaren. Räknar man vanor i
 * UTC hamnar samma morgonrutin — 07:30 varje måndag — i timme 5 halva året
 * och timme 6 den andra halvan. Mönstret delas då i två högar som var för
 * sig är för svaga för att passera trösklarna, och påminnelsen som fungerade
 * hela sommaren slutar komma i slutet av oktober. Ingenting kraschar,
 * ingenting loggas, det bara tystnar.
 *
 * Att i stället lägga på en fast offset (+1 eller +2) är samma bugg med extra
 * steg: den blir fel exakt de dagar övergången sker, och fel för alla
 * användare som inte är i Sverige.
 *
 * Intl.DateTimeFormat med timeZone kan tidszonsdatabasen och är därför den
 * enda rätta vägen. Faller den (okänd zon i en gammal motor) används
 * enhetens egen lokala tid, vilket är rätt i det fall som är vanligast — att
 * zonen är enhetens egen.
 *
 * Veckodagen räknas ur datumet, inte ur Date#getDay(), för att den ska följa
 * den formaterade zonen och inte motorns. 0 = söndag, samma numrering som
 * JavaScripts getDay() och som Postgres extract(dow) — hela skälet till att
 * den valdes framför något mer läsbart.
 *
 * @param {number|Date} tid
 * @param {string} [tidszon] IANA-namn, t.ex. 'Europe/Stockholm'
 * @returns {{ar:number,manad:number,dag:number,timme:number,minut:number,
 *            veckodag:number,datum:string,dagnr:number,slot:number}}
 */
export function lokalTid(tid, tidszon) {
  const d = tid instanceof Date ? tid : new Date(tid);
  if (Number.isNaN(d.getTime())) throw new TypeError('lokalTid: ogiltig tidpunkt');

  let ar, manad, dag, timme, minut;
  const f = formatterare_for(tidszon);
  if (f) {
    const p = Object.create(null);
    for (const del of f.formatToParts(d)) p[del.type] = del.value;
    ar = +p.year; manad = +p.month; dag = +p.day;
    timme = +p.hour; minut = +p.minute;
    // hourCycle h23 ger 00–23, men vissa äldre motorer ger ändå 24 vid
    // midnatt. Då blir dygnet fel med ett helt dygn om det inte fångas.
    if (timme === 24) timme = 0;
  }
  if (!Number.isFinite(ar)) {
    ar = d.getFullYear(); manad = d.getMonth() + 1; dag = d.getDate();
    timme = d.getHours(); minut = d.getMinutes();
  }

  const dagnr = Math.floor(Date.UTC(ar, manad - 1, dag) / DYGN);
  const veckodag = veckodagAv(dagnr);
  return {
    ar, manad, dag, timme, minut, veckodag, dagnr,
    datum: `${ar}-${pad(manad)}-${pad(dag)}`,
    slot: veckodag * 24 + timme,
  };
}

/** Veckodag ur ett dygnsnummer sedan epok. 1970-01-01 var en torsdag (4). */
const veckodagAv = dagnr => ((dagnr + 4) % 7 + 7) % 7;

/** Hur många gånger veckodagen `dag` inträffar mellan två dygnsnummer. */
function antalVeckodagar(dagnr0, dagnr1, dag) {
  if (dagnr1 < dagnr0) return 0;
  const totalt = dagnr1 - dagnr0 + 1;
  let n = Math.floor(totalt / 7);
  for (let i = 0; i < totalt % 7; i++) if (veckodagAv(dagnr0 + i) === dag) n++;
  return n;
}

/** Är timmen inom den tysta natten? */
export function arNatt(timme, { tystFran = STANDARD.tystFran, tystTill = STANDARD.tystTill } = {}) {
  return tystFran > tystTill
    ? (timme >= tystFran || timme < tystTill)   // vanliga fallet: 23–05
    : (timme >= tystFran && timme < tystTill);  // om någon vänder på det
}

/* =========================== INLÄRNING ============================= */

/**
 * Normalisera det anroparen råkar skicka in till millisekunder.
 * Accepterar tal, Date, ISO-sträng eller `{at}` / `{tid}` / `{when}`.
 */
function tillMs(x) {
  if (x == null) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x.getTime();
  if (typeof x === 'string') { const t = Date.parse(x); return Number.isNaN(t) ? null : t; }
  if (typeof x === 'object') return tillMs(x.at ?? x.tid ?? x.when ?? x.ts ?? null);
  return null;
}

/**
 * Lär in fönster ur en historik av körningar.
 *
 * En "körning" är en tidpunkt då bilen faktiskt rullade. Flera positioner
 * under samma morgon är EN körning, inte tjugo — därför räknas unika lokala
 * datum per fönster, inte antal rader. Utan det räcker en enda lång resa för
 * att appen ska tro sig ha sett ett mönster.
 *
 * @param {Array<number|Date|string|{at:number}>} korningar
 * @param {object} [opts]
 * @param {string} [opts.tidszon]  IANA-zon. Standard: enhetens egen.
 * @returns {{
 *   fonster: Array<{slot:number,veckodag:number,timme:number,antal:number,
 *                   tillfallen:number,andel:number,senast:number}>,
 *   avfardade: Array<object>,
 *   underlag: {korningar:number, dagar:number, spannDagar:number,
 *              forsta:string|null, sista:string|null},
 *   tillrackligt: boolean,
 *   varfor: string,
 *   tidszon: string
 * }}
 */
export function larFonster(korningar, opts = {}) {
  const o = { ...STANDARD, ...opts };
  const tidszon = o.tidszon || egenTidszon();

  // Unikt per (fönster, lokalt datum). En Map per slot håller datumen.
  const perSlot = new Map();
  const allaDatum = new Set();
  let dagnrMin = Infinity, dagnrMax = -Infinity;

  for (const rad of korningar || []) {
    const ms = tillMs(rad);
    if (ms == null) continue;
    const L = lokalTid(ms, tidszon);
    allaDatum.add(L.datum);
    if (L.dagnr < dagnrMin) dagnrMin = L.dagnr;
    if (L.dagnr > dagnrMax) dagnrMax = L.dagnr;

    let s = perSlot.get(L.slot);
    if (!s) perSlot.set(L.slot, s = { slot: L.slot, veckodag: L.veckodag, timme: L.timme, datum: new Set(), senast: 0 });
    s.datum.add(L.datum);
    if (ms > s.senast) s.senast = ms;
  }

  const spannDagar = allaDatum.size ? (dagnrMax - dagnrMin + 1) : 0;
  const underlag = {
    korningar: [...perSlot.values()].reduce((a, s) => a + s.datum.size, 0),
    dagar: allaDatum.size,
    spannDagar,
    forsta: allaDatum.size ? datumAv(dagnrMin) : null,
    sista: allaDatum.size ? datumAv(dagnrMax) : null,
  };

  // Grinden. Innan den passerats får appen inte påstå någonting alls — inte
  // ens ett svagt "du brukar kanske köra på måndagar". Ett osäkert påstående
  // som visar sig fel kostar mer förtroende än tystnad kostar nytta.
  let varfor = '';
  if (underlag.korningar < o.minTotalt) {
    varfor = `Bara ${underlag.korningar} körningar noterade, ${o.minTotalt} behövs.`;
  } else if (spannDagar < o.minSpannDagar) {
    varfor = `Historiken sträcker sig ${spannDagar} dygn, ${o.minSpannDagar} behövs.`;
  }
  const tillrackligt = varfor === '';

  const fonster = [], avfardade = [];
  for (const s of perSlot.values()) {
    const antal = s.datum.size;
    const tillfallen = Math.max(antal, antalVeckodagar(dagnrMin, dagnrMax, s.veckodag));
    const andel = tillfallen ? antal / tillfallen : 0;
    const rad = {
      slot: s.slot, veckodag: s.veckodag, timme: s.timme,
      antal, tillfallen, andel: +andel.toFixed(3), senast: s.senast,
    };

    if (!tillrackligt) { avfardade.push({ ...rad, orsak: SKAL.FOR_LITE }); continue; }
    if (arNatt(s.timme, o)) { avfardade.push({ ...rad, orsak: SKAL.NATT }); continue; }
    if (antal < o.minPerFonster) { avfardade.push({ ...rad, orsak: 'for-fa' }); continue; }
    if (andel < o.minAndel) { avfardade.push({ ...rad, orsak: 'svagt-monster' }); continue; }
    fonster.push(rad);
  }

  fonster.sort((a, b) => b.antal - a.antal || b.andel - a.andel || a.slot - b.slot);
  if (tillrackligt && !fonster.length) varfor = 'Inget tillräckligt tydligt mönster än.';

  return { fonster, avfardade, underlag, tillrackligt, varfor, tidszon };
}

const datumAv = dagnr => {
  const d = new Date(dagnr * DYGN);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * Fönster → platta nummer 0–167 (veckodag × 24 + timme) som servern söker på.
 *
 * Exakt samma kodning som js/push.js -> slotsFromHabits(), med flit: den som
 * byter kodning på ena sidan men glömmer den andra får påminnelser på fel
 * veckodag utan att något syns i loggen.
 */
export function slotsFromFonster(fonster) {
  return [...new Set((fonster || []).map(f => f.slot))]
    .filter(n => Number.isInteger(n) && n >= 0 && n < 168)
    .sort((a, b) => a - b);
}

/**
 * Bygg om `pv.habits.v1` från js/driving.js ("dag-timme" → antal) till
 * fönster, utan att gå via tidsstämplar.
 *
 * Sämre än larFonster och bara till för övergången: den nyckeln vet varken
 * datum eller tidszon, så andel och spann går inte att räkna. Allt som går
 * att kräva är antalet. Ny kod ska mata larFonster med tidsstämplar.
 */
export function fonsterFranVanor(habits, { minPerFonster = STANDARD.minPerFonster } = {}) {
  const ut = [];
  for (const [k, n] of Object.entries(habits || {})) {
    const [veckodag, timme] = String(k).split('-').map(Number);
    if (!Number.isInteger(veckodag) || !Number.isInteger(timme)) continue;
    if (veckodag < 0 || veckodag > 6 || timme < 0 || timme > 23) continue;
    if (!(n >= minPerFonster)) continue;
    if (arNatt(timme)) continue;
    ut.push({ slot: veckodag * 24 + timme, veckodag, timme, antal: n, tillfallen: n, andel: 1, senast: 0 });
  }
  return ut.sort((a, b) => b.antal - a.antal || a.slot - b.slot);
}

/* ========================== BESLUTET =============================== */

/**
 * Ska en påminnelse skickas just nu?
 *
 * Ingen sidoeffekt, inget nätverk, inget sparat. Anroparen ansvarar för att
 * lägga in resultatet i loggen via noteraSkickad() när notisen verkligen
 * gick iväg — aldrig innan.
 *
 * @param {object} lage
 * @param {Array} lage.fonster        från larFonster().fonster
 * @param {number|Date} [lage.nu]     tidpunkten som prövas
 * @param {string} [lage.tidszon]
 * @param {boolean} [lage.korNu]      bilen rullar just nu
 * @param {boolean} [lage.appFramme]  appen ligger öppen och synlig
 * @param {number|null} [lage.senastAnvand]   ms-tidpunkt då appen senast användes
 * @param {number|null} [lage.senastKord]     ms-tidpunkt för senaste körning
 * @param {Array<{datum:string,slot:number,at:number}>} [lage.logg]
 * @param {object} [opts] trösklar, se STANDARD
 * @returns {{paminn:boolean, kod:string, skal:string,
 *            slot:number|null, fonster:object|null,
 *            forTid:{timme:number,minut:number,datum:string}|null,
 *            text:string|null}}
 */
export function borPaminna(lage = {}, opts = {}) {
  const o = { ...STANDARD, ...opts };
  const tidszon = lage.tidszon || egenTidszon();
  const nu = tillMs(lage.nu) ?? Date.now();
  const L = lokalTid(nu, tidszon);
  const logg = Array.isArray(lage.logg) ? lage.logg : [];

  const nej = (kod, skal) => ({ paminn: false, kod, skal, slot: null, fonster: null, forTid: null, text: null });

  // 1. Kör redan. Det här är den viktigaste spärren av alla: en påminnelse
  //    om något man just gjort lär användaren att notiserna inte är värda
  //    att läsa, och sen stängs de av — och då är kanalen borta.
  if (lage.korNu) return nej(SKAL.KOR_REDAN, 'Bilen rullar redan.');

  // 2. Appen är framme eller var det nyss. Då har användaren redan tänkt på
  //    Polisvakt, och en notis är bara brus.
  const sedanAnvand = lage.senastAnvand == null ? Infinity : nu - tillMs(lage.senastAnvand);
  if (lage.appFramme || sedanAnvand < o.nyssAnvandMin * 60000) {
    return nej(SKAL.NYSS_ANVAND, 'Appen har använts nyligen.');
  }

  // 3. Har bilen redan rullat idag hoppas hela dygnet över. Dygnet räknas
  //    lokalt: kör man 00:30 en lördag är det lördagen som är avklarad.
  const kordMs = tillMs(lage.senastKord);
  if (kordMs != null && lokalTid(kordMs, tidszon).datum === L.datum) {
    return nej(SKAL.KORD_IDAG, 'Redan kört idag.');
  }

  const fonster = Array.isArray(lage.fonster) ? lage.fonster : [];
  if (!fonster.length) return nej(SKAL.FOR_LITE, 'Appen har inte lärt sig dina tider än.');

  // 4. Natt är tyst. Kollas både på klockan nu och på fönstrets timme —
  //    larFonster sållar redan bort nattfönster, men den här funktionen
  //    måste kunna anropas med fönster som kommit någon annanstans ifrån
  //    (servern, en gammal `pv.habits.v1`) utan att kunna väcka någon 03:00.
  if (arNatt(L.timme, o)) return nej(SKAL.NATT, 'Natt — inga påminnelser.');

  // 5. Ligger tidpunkten om `ledtidMin` minuter i ett fönster?
  const mal = lokalTid(nu + o.ledtidMin * 60000, tidszon);
  if (arNatt(mal.timme, o)) return nej(SKAL.NATT, 'Natt — inga påminnelser.');

  const traff = fonster.find(f => f.slot === mal.slot);
  if (!traff) return nej(SKAL.INGET_FONSTER, 'Du brukar inte köra vid den här tiden.');
  if (traff.andel != null && traff.andel < o.minAndel) {
    return nej(SKAL.INGET_FONSTER, 'Mönstret är för svagt för att påminna om.');
  }

  // 6. En påminnelse per fönster och dygn. Utan den träffar ett cronjobb som
  //    kör var femte minut samma fönster tre gånger i rad.
  const idag = logg.filter(r => r && r.datum === L.datum);
  if (idag.some(r => r.slot === mal.slot)) {
    return nej(SKAL.REDAN_PAMINND, 'Redan påmind om det här fönstret idag.');
  }
  if (idag.length >= o.maxPerDygn) return nej(SKAL.TAK, `Redan ${idag.length} påminnelser idag.`);

  const senaste = logg.reduce((m, r) => Math.max(m, tillMs(r?.at) ?? 0), 0);
  if (senaste && nu - senaste < o.minMellanrumMin * 60000) {
    return nej(SKAL.FOR_TATT, 'För kort sedan förra påminnelsen.');
  }

  return {
    paminn: true,
    kod: SKAL.OK,
    skal: `Du brukar köra ${DAG_ENTAL[mal.veckodag]} runt ${pad(mal.timme)}.`,
    slot: mal.slot,
    fonster: traff,
    forTid: { timme: mal.timme, minut: mal.minut, datum: mal.datum },
    text: paminnelsetext(mal.timme),
  };
}

/**
 * Lägg ett skickat utskick i loggen. Ren funktion — ny array tillbaka.
 * Loggen hålls kort med flit: allt äldre än ett par dygn används aldrig.
 */
export function noteraSkickad(logg, beslut, nu = Date.now()) {
  if (!beslut?.paminn) return Array.isArray(logg) ? logg : [];
  const rad = { datum: beslut.forTid.datum, slot: beslut.slot, at: tillMs(nu) ?? Date.now() };
  return [...(Array.isArray(logg) ? logg : []), rad].slice(-20);
}

/* ========================= FORMULERING ============================= */

/**
 * Texten i notisen. Kort, och med anledningen synlig — "kl 07" gör det
 * begripligt varför telefonen plingar just nu, vilket är skillnaden mellan
 * en hjälpsam notis och en oförklarlig.
 */
export function paminnelsetext(timme) {
  return `Dags att köra runt ${pad(timme)}? Öppna Polisvakt innan du åker.`;
}

/** Läsbar sammanfattning av de inlärda fönstren. */
export function beskrivFonster(fonster, resultat = null) {
  if (resultat && !resultat.tillrackligt) {
    return `Appen lär sig fortfarande. ${resultat.varfor}`;
  }
  if (!fonster?.length) {
    return 'Appen har inte hittat något tydligt mönster i dina tider än.';
  }
  const per = new Map();
  for (const f of [...fonster].sort((a, b) => a.slot - b.slot)) {
    if (!per.has(f.veckodag)) per.set(f.veckodag, []);
    per.get(f.veckodag).push(f.timme);
  }
  const delar = [...per.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, 4)
    .map(([dag, timmar]) => `${DAGAR[dag]} ${timmar.map(t => pad(t)).join(' och ')}`);
  return `Du kör oftast ${delar.join(', ')}.`;
}

/* ============================ FASAD ================================ */

/**
 * Bekvämt skal runt funktionerna ovan. Håller fönster och utskickslogg i
 * minnet — INGET sparas, inget nätverk. Anroparen sköter persistens genom
 * `toJSON()` och `fran()`, vilket är det som gör att den här filen kan testas
 * utan webbläsare och återanvändas i en worker.
 */
export class Korvanor {
  constructor(opts = {}) {
    this.opts = { ...STANDARD, ...opts };
    this.tidszon = opts.tidszon || egenTidszon();
    this.fonster = [];
    this.underlag = { korningar: 0, dagar: 0, spannDagar: 0, forsta: null, sista: null };
    this.tillrackligt = false;
    this.varfor = 'Inga körningar noterade än.';
    this.logg = [];
  }

  /** Lär om allt utifrån en historik av körningar. */
  larIn(korningar) {
    const r = larFonster(korningar, { ...this.opts, tidszon: this.tidszon });
    this.fonster = r.fonster;
    this.avfardade = r.avfardade;
    this.underlag = r.underlag;
    this.tillrackligt = r.tillrackligt;
    this.varfor = r.varfor;
    return r;
  }

  /** Luckorna servern ska söka på. */
  get slots() { return slotsFromFonster(this.fonster); }

  /** Ska vi påminna nu? Uppdaterar INTE loggen — se noteraSkickat(). */
  prova(lage = {}) {
    return borPaminna(
      { tidszon: this.tidszon, logg: this.logg, ...lage, fonster: lage.fonster ?? this.fonster },
      this.opts,
    );
  }

  /** Anropas när notisen verkligen visats. */
  noteraSkickat(beslut, nu = Date.now()) {
    this.logg = noteraSkickad(this.logg, beslut, nu);
    return this.logg;
  }

  get beskrivning() {
    return beskrivFonster(this.fonster, this);
  }

  toJSON() { return { tidszon: this.tidszon, logg: this.logg }; }

  /** Återställ loggen efter en omstart. Fönstren lärs alltid om från data. */
  fran(sparat) {
    if (sparat?.tidszon) this.tidszon = sparat.tidszon;
    if (Array.isArray(sparat?.logg)) this.logg = sparat.logg.slice(-20);
    return this;
  }
}

export { DAGAR, DAG_ENTAL };
