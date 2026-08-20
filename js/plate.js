/*
 * Bilingenkännare — läser registreringsskyltar direkt i webbläsaren.
 *
 * Bakgrunden till att den ser ut som den gör: en tidigare mätning lät
 * textigenkänningen titta på hela bildrutan, och då fick den 2 av 6 rätt på
 * syntetiska skyltar. Det är obrukbart. Felet låg inte i motorn utan i vad den
 * fick se — en skylt som är 5 % av bilden är några få pixlar hög när den når
 * igenkänningen.
 *
 * Det som gör skillnad, i fallande ordning:
 *   1. Beskär till skylten istället för hela bilden.
 *   2. Skala upp så texten blir ~60 px hög.
 *   3. Klipp bort det blå EU-fältet — stjärnorna läses annars som tecken.
 *   4. Sträck kontrasten och tröskla till svart/vitt (Otsu).
 *   5. Säg åt motorn att det är EN textrad, inte ett dokument.
 *   6. Begränsa alfabetet till de tecken svenska skyltar faktiskt använder.
 *   7. Läs flera bildrutor och kräv att två är överens.
 *
 * Punkt 7 är det som gör den ärlig. En enstaka gissning är en gissning.
 *
 * Punkt 1 krävde länge att skylten hamnade inuti en fast ruta mitt i bilden.
 * Det var ett krav på verkligheten och inte på programmet — telefonen sitter i
 * en hållare och skylten hamnar där den hamnar. Numera letar läsaren upp
 * skylten själv, var som helst i bild, och låser på den innan den läser.
 * Se docs/malsokning.md.
 *
 * Allt sker på telefonen. Ingen bild och ingen skylt lämnar enheten.
 *
 * Läsaren för ingen lista. Den enda skylt som någonsin lämnar den här modulen
 * är en som matchar ett av dina egna fordon — allt annat kastas i samma
 * bildrutecykel som det lästes. Dina egna fordon ligger som saltade hashar,
 * aldrig som nummer. Se docs/skyltintegritet.md.
 */

import { motionSupported, motionNeedsPermission } from './impact.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

/* ---- Svenskt skyltformat ------------------------------------------------
 * Två serier i bruk: ABC 123 och ABC 12A.
 * Bokstäverna I, Q och V används inte alls — de förväxlas med 1, O och U.
 * På sista positionen används dessutom inte O, av samma skäl mot nollan.
 * Att koda in det här är inte kosmetika: det förkastar merparten av
 * felläsningarna innan de hinner visas.
 */
const BOKSTAV     = 'ABCDEFGHJKLMNOPRSTUWXYZ';
const SISTBOKSTAV = 'ABCDEFGHJKLMNPRSTUWXYZ';
export const PLAT_RE = new RegExp(`^[${BOKSTAV}]{3}[0-9]{2}[0-9${SISTBOKSTAV}]$`);
export const OCR_ALFABET = BOKSTAV + '0123456789';

/* Tecken som ser likadana ut i skyltfonten. Vi vet vilken position som ska
 * vara bokstav och vilken som ska vara siffra, så förväxlingen går att rätta
 * åt rätt håll. Bara par som faktiskt är visuellt lika finns med — att gissa
 * bredare hade skapat skyltar som aldrig fanns. */
const TILL_BOKSTAV = { 0: 'O', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 8: 'B' };
const TILL_SIFFRA  = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2',
                       A: '4', S: '5', G: '6', T: '7', B: '8' };

/**
 * Städar en rå OCR-sträng till en svensk skylt, eller null.
 * Rättar bara förväxlingar positionsvis — hittar inte på tecken.
 */
export function normaliseraPlat(ratext) {
  let s = String(ratext || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Vissa skyltar läses med landskoden fram ("S ABC123").
  if (s.length === 7 && s[0] === 'S') s = s.slice(1);
  if (s.length !== 6) return null;

  const tecken = s.split('');
  let rattade = 0;
  const ratta = (i, nytt) => { if (nytt && nytt !== tecken[i]) { tecken[i] = nytt; rattade++; } };

  for (let i = 0; i < 3; i++) {
    if (!BOKSTAV.includes(tecken[i])) ratta(i, TILL_BOKSTAV[tecken[i]]);
  }
  for (let i = 3; i < 5; i++) {
    if (!/[0-9]/.test(tecken[i])) ratta(i, TILL_SIFFRA[tecken[i]]);
  }
  // Sista tecknet får vara antingen — rätta bara om det inte duger som något.
  if (!/[0-9]/.test(tecken[5]) && !SISTBOKSTAV.includes(tecken[5])) {
    ratta(5, TILL_SIFFRA[tecken[5]]);
  }

  /*
   * Tak för hur mycket vi får rätta. Utan det bygger rättningen ihop en giltig
   * skylt av vad som helst: "888888" blev "BBB 888", eftersom varje åtta i
   * bokstavsläge glatt blev ett B. Sex rättningar är inte en tolkning av en
   * skylt, det är en påhittad skylt.
   *
   * Två är rimligt: en riktig felläsning brukar gälla ett eller två tecken,
   * och behöver den mer var det förmodligen aldrig en skylt i bild.
   */
  if (rattade > 2) return null;

  const plat = tecken.join('');
  return PLAT_RE.test(plat) ? plat : null;
}

/** ABC123 → "ABC 123". Bara för visning. */
export const visaPlat = p => (p && p.length === 6 ? `${p.slice(0, 3)} ${p.slice(3)}` : p || '');

/* ---- Egna fordon: saltade hashar ----------------------------------------
 *
 * "Mina fordon" är den enda lista appen har, och den är personuppgifter i
 * samma ögonblick som den går att läsa. Därför lagras inga registreringsnummer
 * över huvud taget. Det som ligger på telefonen är ett slumpat salt och en
 * samling SHA-256-hashar.
 *
 * Hashar går bara att jämföra exakt, och det är ett problem här: OCR:en läser
 * fel ibland. Lösningen är att gissa i förväg — när numret matas in räknas
 * alla rimliga felläsningar fram och hashas de också. Uppslagningen blir då
 * en exakt jämförelse, vilket är den enda sorts jämförelse en hash klarar.
 *
 * Vad det inte är: ett skydd mot någon som har telefonen, saltet och hasharna
 * och vill veta vilka nummer som ligger där. Det finns knappt 39 miljoner
 * giltiga svenska skyltar, och att hasha alla med ett känt salt tar sekunder.
 * Poängen är att inget nummer går att *läsa* — inte i lagringen, inte i en
 * enhetsbackup, inte i en felrapport, och inte av appen själv efter att du
 * matat in det. Se docs/skyltintegritet.md.
 */

/** Egen nyckel, med flit utanför settings-objektet. Se docs/skyltintegritet.md. */
export const FORDON_NYCKEL = 'pv.fordon.v1';
const FORDON_VERSION = 1;

/*
 * Vilka tecken som ser lika ut, som en graf.
 *
 * TILL_BOKSTAV och TILL_SIFFRA säger vad ett tecken ska rättas till när
 * positionen kräver den andra teckentypen. Läses de åt båda hållen och det som
 * hänger ihop slås samman får man de visuella klasserna: 0, O, D och Q är en
 * enda klass, eftersom alla tre bokstäverna läses som nolla.
 *
 * Det är klasserna som betyder något, inte pilarnas riktning. normaliseraPlat
 * rättar redan korsningarna mellan bokstav och siffra på de positioner där
 * formatet är bestämt — en åtta på första positionen har blivit ett B innan vi
 * ser den. Det som blir kvar, och som varianterna finns för, är två fall:
 * bokstav förväxlad med bokstav (O och D), och sista positionen, som får vara
 * både siffra och bokstav och därför inte går att rätta.
 */
const TECKENKLASS = (() => {
  const grannar = new Map();
  const kant = (a, b) => {
    if (!grannar.has(a)) grannar.set(a, new Set());
    if (!grannar.has(b)) grannar.set(b, new Set());
    grannar.get(a).add(b); grannar.get(b).add(a);
  };
  for (const [siffra, bokstav] of Object.entries(TILL_BOKSTAV)) kant(siffra, bokstav);
  for (const [bokstav, siffra] of Object.entries(TILL_SIFFRA)) kant(bokstav, siffra);

  // Hela den sammanhängande komponenten, inte bara närmaste granne — annars
  // hamnar O och D i olika klasser trots att båda är nollan.
  const klass = new Map();
  for (const start of grannar.keys()) {
    const sedda = new Set([start]);
    const ko = [start];
    while (ko.length) {
      for (const g of grannar.get(ko.pop()) || []) {
        if (!sedda.has(g)) { sedda.add(g); ko.push(g); }
      }
    }
    sedda.delete(start);
    klass.set(start, [...sedda]);
  }
  return klass;
})();

/*
 * Taket på varianterna.
 *
 * Två byten, samma tak som normaliseraPlat har på antalet rättningar, och av
 * samma skäl: en läsning som skiljer sig på tre tecken är inte en felläsning
 * av ditt nummer, det är ett annat fordon.
 *
 * Varje variant är ett riktigt registreringsnummer som appen kommer att kalla
 * ditt. Räkningen: av 23³ × 10² × 32 ≈ 38,9 miljoner giltiga svenska skyltar
 * blir som mest elva stycken dina, och det bara för nummer som består nästan
 * enbart av O och D. De flesta nummer får en enda variant — sig självt.
 * Fler varianter betyder fler främmande bilar som pipar som dina. Det är
 * priset, och det är därför taket är lågt och inte generöst.
 *
 * MAX_VARIANTER är en ren spärr; med två byten går det inte att nå den.
 */
export const MAX_BYTEN = 2;
export const MAX_VARIANTER = 24;

/**
 * Alla rimliga felläsningar av ett registreringsnummer, numret självt först.
 *
 * Kombinationer som inte är giltiga svenska skyltar faller bort — och det är
 * inte en detalj utan själva filtret. En etta i en siffrposition kan läsas som
 * L, men "ABL23" är ingen skylt, så normaliseraPlat hade rättat tillbaka den
 * innan vi någonsin fick se den. Att hasha sådana varianter vore att lagra
 * strängar som aldrig kan dyka upp.
 */
export function ocrVarianter(plat, { maxByten = MAX_BYTEN, max = MAX_VARIANTER } = {}) {
  const bas = normaliseraPlat(plat);
  if (!bas) return [];

  const tecken = bas.split('');
  const val = tecken.map(t => [t, ...(TECKENKLASS.get(t) || [])]);
  const funna = [];
  const bygg = (i, byggd, byten) => {
    if (i === 6) {
      const v = byggd.join('');
      if (PLAT_RE.test(v)) funna.push({ plat: v, byten });
      return;
    }
    for (const a of val[i]) {
      const n = byten + (a === tecken[i] ? 0 : 1);
      if (n > maxByten) continue;
      byggd.push(a); bygg(i + 1, byggd, n); byggd.pop();
    }
  };
  bygg(0, [], 0);

  // Närmast först, så att en eventuell kapning tar de mest långsökta.
  funna.sort((a, b) => a.byten - b.byten);
  const unika = [], sedda = new Set();
  for (const v of funna) {
    if (sedda.has(v.plat)) continue;
    sedda.add(v.plat); unika.push(v.plat);
  }
  return unika.slice(0, max);
}

const TEXT = new TextEncoder();
const HASH_DOMAN = 'polisvakt-fordon-v1';

const tillHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

function slumpBytes(n) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}

const slumpHex = n => tillHex(slumpBytes(n));

/** Nytt salt, en gång per installation. 32 byte, base64 för att rymmas i JSON. */
export function nyttSalt() {
  return btoa(String.fromCharCode(...slumpBytes(32)));
}

/**
 * Saltad SHA-256 av ett registreringsnummer, som hex.
 *
 * Domänsträngen fram gör att hasharna inte går att jämföra mot en tabell som
 * någon annan råkat räkna fram över samma salt för något annat ändamål.
 */
export async function hashaPlat(plat, salt) {
  const d = await crypto.subtle.digest('SHA-256', TEXT.encode(`${HASH_DOMAN}|${salt}|${plat}`));
  return tillHex(d);
}

/**
 * Ett Storage-liknande objekt i minnet. Finns för mätningen i ocr-test.html —
 * den ska kunna köra hela registret utan att röra användarens localStorage.
 */
export function minneslagring(start = {}) {
  const m = new Map(Object.entries(start));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}

/**
 * Registret över egna fordon.
 *
 * Innehåller salt, hashar och en etikett per fordon. Etiketten är det du själv
 * skrivit, eller "Fordon 1" — den är det enda läsbara som finns, och den är
 * med flit inte numret. Det betyder att listan inte kan visa dig vilka nummer
 * som ligger i den. Vill du kontrollera att ett visst nummer finns får du
 * skriva in det och fråga; se `slaUpp`. Det är en verklig försämring av
 * gränssnittet, och den är avsiktlig.
 */
export class Fordonsregister {
  #lagring; #data; #index;

  constructor(lagring, data) {
    this.#lagring = lagring;
    this.#data = data;
    this.#byggIndex();
  }

  static ladda(lagring = localStorage) {
    let data = null;
    try { data = JSON.parse(lagring.getItem(FORDON_NYCKEL) || 'null'); } catch {}
    const giltig = data && data.v === FORDON_VERSION &&
      typeof data.salt === 'string' && data.salt && Array.isArray(data.fordon);
    if (!giltig) {
      data = { v: FORDON_VERSION, salt: nyttSalt(), raknare: 0, fordon: [] };
      try { lagring.setItem(FORDON_NYCKEL, JSON.stringify(data)); } catch {}
    }
    if (typeof data.raknare !== 'number') data.raknare = data.fordon.length;
    return new Fordonsregister(lagring, data);
  }

  get salt() { return this.#data.salt; }
  get antal() { return this.#data.fordon.length; }

  /** Det gränssnittet får visa: etikett och antal varianter, aldrig ett nummer. */
  lista() {
    return this.#data.fordon.map(f => ({
      id: f.id, etikett: f.etikett, skapad: f.skapad, varianter: f.hashar.length,
    }));
  }

  hasha(plat) { return hashaPlat(plat, this.#data.salt); }

  /**
   * Uppslagning på en färdig hash. Synkron med flit: läsaren hashar en gång
   * per bekräftad läsning och ska inte behöva vänta en gång till.
   */
  slaUppHash(hash) {
    const id = this.#index.get(hash);
    if (!id) return null;
    const f = this.#data.fordon.find(x => x.id === id);
    if (!f) return null;
    // hashar[0] är numret självt, resten är felläsningar av det.
    return { id: f.id, etikett: f.etikett, exakt: f.hashar[0] === hash };
  }

  async slaUpp(plat) {
    const p = normaliseraPlat(plat);
    if (!p) return null;
    return this.slaUppHash(await this.hasha(p));
  }

  async arEget(plat) { return !!(await this.slaUpp(plat)); }

  /**
   * Lägger till ett fordon. Numret hashas här och slängs — det finns inte kvar
   * någonstans efter att den här funktionen returnerat.
   *
   * `sparad: false` betyder att lagringen vägrade. Anroparen måste bry sig:
   * det är skillnaden mellan ett tillagt fordon och ett fordon som försvann.
   */
  async laggTill(plat, etikett = null) {
    const bas = normaliseraPlat(plat);
    if (!bas) return { status: 'ogiltig' };

    const varianter = ocrVarianter(bas);
    const hashar = [];
    for (const v of varianter) hashar.push(await this.hasha(v));

    const fanns = this.slaUppHash(hashar[0]);
    if (fanns) return { status: 'fanns', id: fanns.id, etikett: fanns.etikett, sparad: true };

    const n = ++this.#data.raknare;
    const f = {
      id: slumpHex(8),
      etikett: String(etikett || '').trim() || `Fordon ${n}`,
      skapad: Date.now(),
      hashar,
    };
    this.#data.fordon.push(f);
    this.#byggIndex();
    const sparad = this.#spara();
    return { status: 'ny', id: f.id, etikett: f.etikett, varianter: hashar.length, sparad };
  }

  /** Byter etikett. Rör inga hashar. */
  dopOm(id, etikett) {
    const f = this.#data.fordon.find(x => x.id === id);
    if (!f) return false;
    f.etikett = String(etikett || '').trim() || f.etikett;
    return this.#spara();
  }

  taBort(id) {
    const fore = this.#data.fordon.length;
    this.#data.fordon = this.#data.fordon.filter(f => f.id !== id);
    if (this.#data.fordon.length === fore) return false;
    this.#byggIndex();
    return this.#spara();
  }

  rensaAllt() {
    this.#data.fordon = [];
    this.#byggIndex();
    return this.#spara();
  }

  #byggIndex() {
    this.#index = new Map();
    for (const f of this.#data.fordon) {
      for (const h of f.hashar) this.#index.set(h, f.id);
    }
  }

  #spara() {
    try { this.#lagring.setItem(FORDON_NYCKEL, JSON.stringify(this.#data)); return true; }
    catch { return false; }
  }
}

/* Ett register per lagring. Läsaren och inställningssidan måste se samma —
 * två instanser över samma nyckel hade skrivit över varandras fordon. */
const registerCache = new WeakMap();

export function haFordonsregister(lagring = localStorage) {
  const l = lagring || localStorage;
  if (!registerCache.has(l)) registerCache.set(l, Fordonsregister.ladda(l));
  return registerCache.get(l);
}

/**
 * Migrering från den gamla klartextlistan (settings.plEgna).
 *
 * Idempotent: ett nummer som redan finns läggs inte till igen, eftersom
 * uppslagningen sker på exakt samma hash. Får köras vid varje start.
 *
 * Anroparen ska radera klartexten först när `ok` är sant. Går skrivningen till
 * lagringen fel är den gamla listan det enda som är kvar av fordonen, och att
 * radera den då är att tappa dem. Rader som inte är svenska registreringsnummer
 * rapporteras i `ogiltiga` men blockerar inte — de kunde ändå aldrig matcha.
 */
export async function migreraKlartext(klartext, lagring = localStorage) {
  const reg = haFordonsregister(lagring);
  const svar = { ok: true, nya: 0, fanns: 0, ogiltiga: [], antal: 0 };
  for (const rad of Array.isArray(klartext) ? klartext : []) {
    const r = await reg.laggTill(rad, null);
    if (r.status === 'ny') { svar.nya++; if (r.sparad === false) svar.ok = false; }
    else if (r.status === 'fanns') svar.fanns++;
    else svar.ogiltiga.push(String(rad));
  }
  svar.antal = reg.antal;
  return svar;
}

/* ---- Bildbehandling ------------------------------------------------------ */

/** Källans pixelmått, oavsett om det är en video, en canvas eller en bild. */
export function kallMatt(kalla) {
  return {
    b: kalla.videoWidth || kalla.naturalWidth || kalla.width || 0,
    h: kalla.videoHeight || kalla.naturalHeight || kalla.height || 0,
  };
}

/*
 * En enda arbetsyta återanvänds i hela modulen. Sökningen kör åtta gånger i
 * sekunden, och en ny canvas per varv lämnar hundratals döda ytor åt
 * skräpsamlaren varje minut — på en telefon syns det som ryck i sökaren.
 * Allt som använder ytan gör det synkront, så det finns ingen att krocka med.
 */
let arbetsyta = null;
function haArbetsyta(b, h) {
  if (!arbetsyta) arbetsyta = document.createElement('canvas');
  if (arbetsyta.width !== b || arbetsyta.height !== h) { arbetsyta.width = b; arbetsyta.height = h; }
  return arbetsyta;
}

/* ---- Lutning ------------------------------------------------------------
 *
 * Telefonen sitter i en hållare och hållaren sitter sällan rakt. Bilden lutar
 * då, och med den skylten. Det bröt sökningen fullständigt: den mätte kvoten
 * på blobbens *axelparallella* omslutande låda, och en skylt som lutar 30°
 * får en nästan kvadratisk sådan låda. Kvot 1,4 i stället för 4,7, fyllnad
 * 0,32 i stället för 0,78 — båda filtren sa nej, och kandidaten fanns aldrig.
 * Mätt före ändringen: noll kandidater vid 15°, 30°, 45° och 90°.
 *
 * Lösningen mäter blobbens *egentliga* utsträckning i stället för lådans.
 * Andra ordningens moment (samma summor som en tröghetsberäkning) ger både
 * riktningen på blobbens långa axel och längden längs den. För en fylld
 * rektangel är variansen längs en axel exakt L²/12, så L = √(12λ). Summorna
 * plockas upp i den flödesfyllning som ändå går igenom varje pixel — det
 * kostar fem additioner per pixel och ingen extra genomgång av bilden.
 *
 * Varför inte rotera bilden efter enhetens sensor i stället: sensorn kräver
 * tillstånd på iOS, och ett läge som bara fungerar efter ett knapptryck är
 * inte ett läge som fungerar. Den här vägen kräver ingenting av användaren.
 * Sensorn finns kvar som ett *tillägg* — se `Lutningsgivare` — men bara för
 * att rangordna kandidater, aldrig för att hitta dem. Se docs/lutning.md.
 */

/*
 * Dödband. Under det här räknas blobben som rak och behandlas exakt som förut,
 * med den axelparallella lådan. Två skäl:
 *
 *   1. En skylt sedd snett från sidan är *skjuvad*, inte roterad. Skjuvning
 *      vrider huvudaxeln försumbart — en 15°-skjuvning ger 0,7° vridning —
 *      och den fångas redan av `uppskattaLutning` längre ner. Att börja
 *      rotera på den vore att bygga en andra mekanism för samma sak.
 *   2. Mätningen på de fall som redan fungerade blir bit för bit oförändrad.
 */
const VINKEL_DODBAND = 3;

/** Viker en vinkel till (−90, 90]. En skylt och samma skylt vriden 180° är
 *  samma linje; huvudaxeln kan inte skilja dem åt. */
function vikVinkel(v) {
  let x = v % 180;
  if (x > 90) x -= 180;
  if (x <= -90) x += 180;
  return x;
}

/**
 * Grunden under både `hittaPlat` och `sokKandidater`: skala ner ett område,
 * tröskla med Otsu och plocka ut alla ljusa sammanhängande områden som har
 * skyltens grovform.
 *
 * Metoden är enkel med flit: en skylt är det ljusa, avlånga och någorlunda
 * rektangulära i bilden. Det räcker för att skilja den från en bilkropp, och
 * det kostar ingenting jämfört med att lägga in en modell.
 *
 * Form och storlek mäts längs blobbens egna axlar, inte längs bildens. En
 * lutad skylt är fortfarande en skylt.
 *
 * @returns {{b:number,h:number,skala:number,gra:Uint8ClampedArray,trosk:number,blobbar:Array}}
 */
function skannaLjusa(kalla, omrade, arbetsbredd, { minAndel = 0.12, minPx = 8 } = {}) {
  const skala = Math.min(1, arbetsbredd / omrade.w);
  const b = Math.max(8, Math.round(omrade.w * skala));
  const h = Math.max(4, Math.round(omrade.h * skala));

  const c = haArbetsyta(b, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, b, h);
  g.drawImage(kalla, omrade.x, omrade.y, omrade.w, omrade.h, 0, 0, b, h);
  const px = g.getImageData(0, 0, b, h).data;

  const n = b * h;
  const gra = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gra[i] = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
  }
  const trosk = otsu(gra);

  // Sammanhängande ljusa områden. Egen stack istället för rekursion — en
  // skylt som fyller rutan är tiotusentals pixlar och skulle spränga stacken.
  const besokt = new Uint8Array(n);
  const stack = new Int32Array(n);
  const minBredd = Math.max(minPx, b * minAndel);
  const blobbar = [];

  for (let start = 0; start < n; start++) {
    if (besokt[start] || gra[start] <= trosk) continue;
    let sp = 0; stack[sp++] = start; besokt[start] = 1;
    let minX = b, maxX = -1, minY = h, maxY = -1, area = 0;
    // Andra ordningens moment, plockade i samma svep. Fem additioner och tre
    // multiplikationer per pixel — mätt kostar de under en tiondels millisekund
    // i en bildruta på 400 × 225.
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;

    while (sp) {
      const i = stack[--sp];
      const x = i % b, y = (i / b) | 0;
      area++;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0     && !besokt[i - 1] && gra[i - 1] > trosk) { besokt[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < b - 1 && !besokt[i + 1] && gra[i + 1] > trosk) { besokt[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0     && !besokt[i - b] && gra[i - b] > trosk) { besokt[i - b] = 1; stack[sp++] = i - b; }
      if (y < h - 1 && !besokt[i + b] && gra[i + b] > trosk) { besokt[i + b] = 1; stack[sp++] = i + b; }
    }

    const bw = maxX - minX + 1, bh = maxY - minY + 1;

    // Kovariansen kring blobbens tyngdpunkt. Huvudaxelns riktning är den
    // vinkel som gör kovariansen noll, och den finns i sluten form.
    const mx = sx / area, my = sy / area;
    const cxx = sxx / area - mx * mx;
    const cyy = syy / area - my * my;
    const cxy = sxy / area - mx * my;
    let vinkel = vikVinkel(0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180 / Math.PI);

    let L, W, forhallande, fyllnad;
    if (Math.abs(vinkel) < VINKEL_DODBAND) {
      // Rak nog. Lådan är exakt, momenten bara en uppskattning — använd lådan.
      vinkel = 0;
      L = bw; W = bh;
      forhallande = bw / bh;
      fyllnad = area / (bw * bh);
    } else {
      // Egenvärdena till en 2×2-symmetrisk matris, för hand. λ₁ hör till den
      // långa axeln. För en fylld rektangel gäller varians = sida²/12; termen
      // +1 kompenserar för att pixlar är rutor och inte punkter.
      const spar = cxx + cyy;
      const det = cxx * cyy - cxy * cxy;
      const rot = Math.sqrt(Math.max(0, spar * spar / 4 - det));
      L = Math.sqrt(Math.max(1, 12 * (spar / 2 + rot) + 1));
      W = Math.sqrt(Math.max(1, 12 * Math.max(0, spar / 2 - rot) + 1));
      forhallande = L / W;
      // Fyllnaden mäts mot den vridna lådan. Det är samma tal som förut för en
      // rak skylt, och till skillnad från den axelparallella lådan faller det
      // inte bara för att bilden lutar.
      fyllnad = Math.min(1, area / (L * W));
    }

    // En skylt är avlång, någorlunda rektangulär och inte försvinnande liten.
    if (forhallande < 2.2 || forhallande > 8) continue;
    if (fyllnad < 0.45) continue;
    if (L < minBredd || W < 3) continue;
    blobbar.push({ minX, minY, bw, bh, area, forhallande, fyllnad,
                   vinkel, L, W, cx: mx, cy: my });
  }
  return { b, h, skala, gra, trosk, blobbar };
}

/**
 * Räknar hur många gånger en vågrät linje genom området växlar mellan ljust
 * och mörkt.
 *
 * Det här är skillnaden mellan en skylt och en vit skåpbilsdörr. Båda är
 * ljusa, avlånga och rektangulära — formen ensam kan inte skilja dem åt.
 * Men en skylt har sex tecken, och tecken är mörka pelare med ljust emellan:
 * tio till fjorton växlingar. En slät yta har noll.
 *
 * Tröskeln tas lokalt ur området, inte globalt. En skylt i skugga är mörkare
 * än en soldränkt vägbana, och en global tröskel hade gjort hela skylten svart.
 * Saknar området kontrast alls är det per definition slätt — då är svaret noll
 * utan att vi behöver räkna.
 *
 * Lutar blobben måste linjen luta med den. En vågrät linje genom en skylt som
 * står på snedden skär bara ett par tecken och en massa botten, och svaret blir
 * noll växlingar — alltså "slät yta", alltså kandidaten dödad. Det var samma
 * fel som den axelparallella lådan, en nivå längre in.
 */
function raknaTeckenbyten(gra, b, h, box) {
  if (box.vinkel) return raknaTeckenbytenVriden(gra, b, h, box);

  const y0 = box.minY + Math.max(1, Math.round(box.bh * 0.2));
  const y1 = box.minY + Math.max(2, Math.round(box.bh * 0.8));
  const x0 = box.minX, x1 = box.minX + box.bw;
  if (y1 <= y0 || box.bw < 6) return 0;

  let lag = 255, hog = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = gra[y * b + x];
      if (v < lag) lag = v;
      if (v > hog) hog = v;
    }
  }
  if (hog - lag < 40) return 0;                 // slät yta, inga tecken
  const trosk = lag + (hog - lag) * 0.5;

  // Andel mörka pixlar per kolumn, och sedan antalet gånger den korsar
  // gränsen. Hysteres i båda riktningarna så att en enstaka brusig pixel inte
  // räknas som ett tecken.
  const rader = y1 - y0;
  let byten = 0, imork = false;
  for (let x = x0; x < x1; x++) {
    let mork = 0;
    for (let y = y0; y < y1; y++) if (gra[y * b + x] < trosk) mork++;
    const andel = mork / rader;
    if (!imork && andel > 0.45) { imork = true; byten++; }
    else if (imork && andel < 0.2) { imork = false; byten++; }
  }
  return byten;
}

/**
 * Samma räkning, men längs blobbens egna axlar i stället för bildens.
 * Punktprovning med närmaste granne — vi räknar växlingar, inte pixlar, och
 * en halv pixels felplacering ändrar ingenting i det svaret.
 */
function raknaTeckenbytenVriden(gra, b, h, box) {
  if (box.L < 6 || box.W < 3) return 0;
  const rad = box.vinkel * Math.PI / 180;
  const kos = Math.cos(rad), sin = Math.sin(rad);
  const halvL = Math.round(box.L / 2);
  const halvV = Math.max(1, Math.round(box.W * 0.3));   // mittpartiet, 0,2–0,8

  const prov = (u, v) => {
    const x = Math.round(box.cx + u * kos - v * sin);
    const y = Math.round(box.cy + u * sin + v * kos);
    if (x < 0 || x >= b || y < 0 || y >= h) return -1;
    return gra[y * b + x];
  };

  let lag = 255, hog = 0;
  for (let u = -halvL; u <= halvL; u++) {
    for (let v = -halvV; v <= halvV; v++) {
      const g = prov(u, v);
      if (g < 0) continue;
      if (g < lag) lag = g;
      if (g > hog) hog = g;
    }
  }
  if (hog - lag < 40) return 0;
  const trosk = lag + (hog - lag) * 0.5;

  let byten = 0, imork = false;
  for (let u = -halvL; u <= halvL; u++) {
    let mork = 0, rader = 0;
    for (let v = -halvV; v <= halvV; v++) {
      const g = prov(u, v);
      if (g < 0) continue;
      rader++;
      if (g < trosk) mork++;
    }
    if (!rader) continue;
    const andel = mork / rader;
    if (!imork && andel > 0.45) { imork = true; byten++; }
    else if (imork && andel < 0.2) { imork = false; byten++; }
  }
  return byten;
}

/**
 * Letar upp själva skylten inne i en given ruta.
 *
 * Utan det här steget skalas hela rutan, och sitter bilen tio meter bort är
 * skylten en tiondel av rutan — texten blir några pixlar hög och motorn läser
 * ingenting. Det var precis så mätningen såg ut innan: rutan gav rätt svar
 * bara när skylten råkade fylla den.
 *
 * Beteendet är oförändrat sedan mätningen: samma arbetsbredd, samma filter,
 * största träffen vinner. Sökningen i hela bilden ligger i `sokKandidater`.
 *
 * @returns {object|null} snävare {x,y,w,h} i källans pixlar, eller null
 */
export function hittaPlat(kalla, roi) {
  const AB = 320;                                   // arbetsbredd, håller det billigt
  const s = skannaLjusa(kalla, roi, AB, { minAndel: 0.12, minPx: 0 });

  let bast = null;
  for (const bl of s.blobbar) if (!bast || bl.area > bast.area) bast = bl;
  if (!bast) return null;

  // Tillbaka till källans pixlar, med en nypa marginal så inte kanttecknen
  // kapas av en pixel hit eller dit.
  const inv = 1 / s.skala;
  const mx = bast.bw * 0.03 * inv, my = bast.bh * 0.08 * inv;
  /*
   * Två beskrivningar av samma fynd, och båda behövs:
   *
   *   x, y, w, h   den axelparallella lådan. Det är den siktet ritar, den
   *                spårningen jämför och den zoomen mäter mot — oförändrad.
   *   cx, cy, rw, rh, vinkel
   *                den vridna rektangeln. Det är den `forbehandla` beskär, och
   *                den enda som beskriver en lutad skylt utan att ta med halva
   *                bakgrunden på köpet.
   *
   * Vid vinkel 0 är de två samma sak, och då används den gamla vägen rakt av.
   */
  return {
    x: roi.x + bast.minX * inv - mx,
    y: roi.y + bast.minY * inv - my,
    w: bast.bw * inv + mx * 2,
    h: bast.bh * inv + my * 2,
    vinkel: bast.vinkel,
    cx: roi.x + bast.cx * inv,
    cy: roi.y + bast.cy * inv,
    // Samma marginaler, fast längs skyltens egna axlar.
    rw: bast.L * 1.06 * inv,
    rh: bast.W * 1.16 * inv,
  };
}

/* ---- Målsökning ---------------------------------------------------------- */

/**
 * Rangordning av en kandidat. Fyra faktorer, alla mellan 0 och 1, som
 * multipliceras ihop. Multiplikation och inte summa: en kandidat som är
 * uppenbart fel i ett avseende ska falla, inte kompenseras av att den är stor.
 *
 * Ingen faktor utom `tecken` får gå ner till noll. En skylt i hörnet av bilden
 * är fortfarande en skylt, och den ska kunna låsas — bara inte före den som
 * ligger mitt i vägen.
 */
function poangsattKandidat({ forhallande, fyllnad, teckenbyten, bredd, cx, cy, ytaB,
                             vinkel = 0, forvantadVinkel = null }) {
  // Form: svenska skyltar är 520 × 110 mm, alltså 4,7. Avvikelsen mäts i
  // logaritm så att 2,35 och 9,4 straffas lika mycket — en skylt sedd snett
  // trycks ihop i sidled, aldrig i höjdled.
  const d = Math.abs(Math.log(forhallande / 4.7));
  const form = Math.exp(-(d * d) / (2 * 0.45 * 0.45));

  // Storlek: andel av bildens bredd. Under en tredjedel är det avståndet som
  // avgör om läsningen lyckas, så där ska skillnaden märkas. Över det spelar
  // det ingen roll längre, och en yta som täcker hela bilden är sällan en
  // skylt.
  const andel = bredd / ytaB;
  let storlek = Math.min(1, andel / 0.30);
  if (andel > 0.8) storlek = 0.5;

  // Läge: bilen man följer ligger mitt i vägen. Höjdled väger lättare —
  // telefonen sitter i en hållare och skylten hamnar nästan alltid i nedre
  // halvan, det är normalfallet och inte ett skäl att misstro den.
  const dx = Math.abs(cx - 0.5) * 2, dy = Math.abs(cy - 0.5) * 2;
  const centrum = Math.max(0.4, 1 - 0.45 * dx * dx - 0.15 * dy * dy);

  /*
   * Tecken: den enda faktorn som får döda en kandidat. En vit skåpbilsdörr,
   * en vägskylts baksida och ett vitt klistermärke har allihop rätt form och
   * rätt ljushet. Det de inte har är sex mörka pelare på rad.
   *
   * Räkningen kräver att kandidaten är minst 24 pixlar bred i arbetsupplösning
   * för att vara pålitlig. Är den mindre svarar vi varken ja eller nej, utan
   * lägger oss mitt emellan — annars hade varje skylt på håll dömts ut.
   */
  let tecken;
  if (bredd < 24) tecken = 0.7;
  else if (fyllnad > 0.96 || teckenbyten < 3) tecken = 0.08;
  else tecken = Math.min(1, Math.max(0.2, teckenbyten / 8));

  /*
   * Rakhet: hur mycket kandidaten lutar.
   *
   * Detektionen hittar numera skyltar i vilken vinkel som helst, och det är
   * rätt. Men en lutad ljus stapel är oftare en dörrkarm, en reflex i en ruta
   * eller en linje i vägbanan än en skylt, så vid lika poäng ska den raka
   * vinna. Straffet är milt med flit — det ska rangordna, inte döda. En skylt
   * i 45° behåller 84 % och ligger med god marginal över låsgränsen.
   *
   * Finns lutningsgivaren igång vet vi ungefär hur telefonen sitter, och då
   * mäts avvikelsen mot det i stället. Den vägen kan bara lyfta en kandidat,
   * aldrig sänka den: utan tillstånd, med fel tecken på sensorn eller med en
   * telefon som ligger stilla i handen blir svaret det samma som utan givare.
   * Sensorn är ett tillägg och får aldrig bli ett krav.
   */
  const straff = a => 1 - 0.45 * Math.pow(Math.min(1, Math.abs(a) / 90), 1.5);
  let rakhet = straff(vinkel);
  if (forvantadVinkel !== null) {
    rakhet = Math.max(rakhet, straff(vikVinkel(vinkel - forvantadVinkel)));
  }

  return {
    poang: form * (0.35 + 0.65 * storlek) * centrum * tecken * rakhet,
    form, storlek, centrum, tecken, rakhet,
  };
}

/**
 * Söker igenom hela bilden efter skyltliknande kandidater.
 *
 * Det gamla kravet — att skylten skulle hamna inuti en fast ruta mitt i bilden
 * — var fel ställt. Telefonen sitter i en hållare, vinkeln är den den är, och
 * skylten hamnar var som helst: i nedre halvan, ute åt sidan, uppe i ett hörn.
 * Rutan ska följa skylten, inte tvärtom.
 *
 * Flera kandidater kan finnas samtidigt — bilen framför och en parkerad
 * bredvid — så alla returneras, rangordnade. Rangordningen avgör inte vad som
 * är en skylt, den avgör vilken vi tittar på först.
 *
 * @param {CanvasImageSource} kalla
 * @param {object|null} omrade       {x,y,w,h} i källans pixlar, null = hela bilden
 * @param {object} [opt]             { arbetsbredd = 400, max = 6 }
 * @returns {Array<object>} {x,y,w,h,poang,form,storlek,centrum,tecken,teckenbyten,forhallande,fyllnad}
 */
export function sokKandidater(kalla, omrade = null,
                              { arbetsbredd = 400, max = 6, forvantadVinkel = null } = {}) {
  const m = kallMatt(kalla);
  const yta = omrade || { x: 0, y: 0, w: m.b, h: m.h };
  if (!(yta.w > 16 && yta.h > 16)) return [];

  // Minsta kandidat: 2,5 % av bildens bredd. En skylt mindre än så är under
  // tjugo pixlar bred i en telefonbild och innehåller inte tillräckligt med
  // information för att bli text — men den får finnas med, för zoomen kan
  // göra något av den.
  const s = skannaLjusa(kalla, yta, arbetsbredd, { minAndel: 0.025, minPx: 10 });
  const inv = 1 / s.skala;
  const ut = [];

  for (const bl of s.blobbar) {
    const teckenbyten = raknaTeckenbyten(s.gra, s.b, s.h, bl);
    const p = poangsattKandidat({
      forhallande: bl.forhallande,
      fyllnad: bl.fyllnad,
      teckenbyten,
      // Storleken mäts längs skyltens långsida. Den axelparallella lådan är
      // bredare än skylten så fort bilden lutar, och hade fått en liten lutad
      // skylt att se större ut än den är.
      bredd: bl.L,
      cx: (bl.minX + bl.bw / 2) / s.b,
      cy: (bl.minY + bl.bh / 2) / s.h,
      ytaB: s.b,
      vinkel: bl.vinkel, forvantadVinkel,
    });

    // Samma marginal som `hittaPlat` ger, så att OCR-steget får en ruta med
    // luft kring tecknen och inte klipper kanterna.
    const mx = bl.bw * 0.03 * inv, my = bl.bh * 0.08 * inv;
    ut.push({
      x: yta.x + bl.minX * inv - mx,
      y: yta.y + bl.minY * inv - my,
      w: bl.bw * inv + mx * 2,
      h: bl.bh * inv + my * 2,
      vinkel: bl.vinkel,
      cx: yta.x + bl.cx * inv,
      cy: yta.y + bl.cy * inv,
      rw: bl.L * 1.06 * inv,
      rh: bl.W * 1.16 * inv,
      teckenbyten, forhallande: bl.forhallande, fyllnad: bl.fyllnad, ...p,
    });
  }

  ut.sort((a, b) => b.poang - a.poang);
  return ut.slice(0, max);
}

/**
 * Beskär, skala upp och tröskla en bildruta till något en OCR-motor klarar.
 *
 * @param {CanvasImageSource} kalla   video eller canvas
 * @param {object} roi                {x,y,w,h} i källans pixlar
 * @returns {HTMLCanvasElement}
 */
export function forbehandla(kalla, roi,
                            { malHojd = 96, kapaEuFalt = true, lutning = 0, vridning = 0 } = {}) {
  /*
   * `vridning` räknar med att `roi` beskriver en *vriden* rektangel: mitten i
   * cx/cy och sidorna i rw/rh, mätta längs skyltens egna axlar. Utan vridning
   * är roi den vanliga axelparallella rutan och allt nedan går den gamla vägen,
   * bit för bit — de tio pipelinefallen ska mäta exakt samma sak som förut.
   */
  const rw = vridning ? (roi.rw ?? roi.w) : roi.w;
  const rh = vridning ? (roi.rh ?? roi.h) : roi.h;
  const skala = malHojd / rh;
  const bredd = Math.max(1, Math.round(rw * skala));
  const hojd  = Math.max(1, Math.round(malHojd));

  const c = document.createElement('canvas');
  c.width = bredd; c.height = hojd;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (vridning) {
    /*
     * Räta upp en skylt som lutar i bild. Skjuvning räcker inte här: en
     * skjuvning rätar upp tecknens *stammar* men låter textraden fortsätta gå
     * på snedden, och motorn läser en enda rad. Det måste vara en riktig
     * rotation.
     *
     * Den kostar ingenting extra — det är samma enda `drawImage`, bara under
     * en annan matris, och den ligger i canvasens hårdvaruväg. Ingen extra
     * OCR-körning, ingen extra genomgång av pixlarna.
     *
     * Ordningen läses nerifrån och upp: flytta skyltens mitt till origo, vrid
     * tillbaka den, skala upp till målhöjden, skjuva bort resten av snedheten,
     * lägg den mitt på duken.
     */
    const cx = roi.cx ?? (roi.x + roi.w / 2);
    const cy = roi.cy ?? (roi.y + roi.h / 2);
    g.fillStyle = '#fff'; g.fillRect(0, 0, bredd, hojd);
    g.save();
    g.translate(bredd / 2, hojd / 2);
    if (lutning) g.transform(1, 0, Math.tan(-lutning * Math.PI / 180), 1, 0, 0);
    g.scale(skala, skala);
    g.rotate(-vridning * Math.PI / 180);
    g.translate(-cx, -cy);
    g.drawImage(kalla, 0, 0);
    g.restore();
  } else if (lutning) {
    // Räta upp en skylt som setts snett. Tecknen står kvar på plats i höjdled,
    // så det räcker att skjuva i sidled kring mitten.
    g.fillStyle = '#fff'; g.fillRect(0, 0, bredd, hojd);
    g.save();
    g.translate(bredd / 2, hojd / 2);
    g.transform(1, 0, Math.tan(-lutning * Math.PI / 180), 1, 0, 0);
    g.drawImage(kalla, roi.x, roi.y, roi.w, roi.h, -bredd / 2, -hojd / 2, bredd, hojd);
    g.restore();
  } else {
    g.drawImage(kalla, roi.x, roi.y, roi.w, roi.h, 0, 0, bredd, hojd);
  }

  const bild = g.getImageData(0, 0, bredd, hojd);
  const px = bild.data;
  const n = bredd * hojd;

  // Gråskala med ögats viktning, och histogram i samma svep.
  const gra = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
    gra[i] = v; hist[v]++;
  }

  // Kontraststräckning mellan 2:a och 98:e percentilen. Utan den blir en
  // skylt i motljus en grå klump där trösklingen tar fel överallt.
  const lag = percentil(hist, n, 0.02);
  const hog = percentil(hist, n, 0.98);
  const spann = Math.max(1, hog - lag);
  for (let i = 0; i < n; i++) {
    gra[i] = Math.max(0, Math.min(255, ((gra[i] - lag) * 255) / spann));
  }

  // Otsu: låt bilden själv bestämma var gränsen går mellan text och botten.
  const trosk = otsu(gra);

  // Det blå EU-fältet till vänster är ungefär en tiondel av skyltens bredd.
  // Stjärnorna och landsbokstaven läses annars som tecken, och då stämmer
  // längden aldrig. Vitmålas hellre än beskärs — då behåller vi marginalen.
  const kapa = kapaEuFalt ? Math.round(bredd * 0.105) : 0;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const x = i % bredd;
    const v = (x < kapa || gra[i] > trosk) ? 255 : 0;
    px[p] = px[p + 1] = px[p + 2] = v; px[p + 3] = 255;
  }
  g.putImageData(bild, 0, 0);
  return c;
}

function percentil(hist, n, andel) {
  let mal = n * andel, sum = 0;
  for (let v = 0; v < 256; v++) { sum += hist[v]; if (sum >= mal) return v; }
  return 255;
}

function otsu(gra) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gra.length; i++) hist[gra[i]]++;
  const n = gra.length;
  let summa = 0;
  for (let v = 0; v < 256; v++) summa += v * hist[v];
  let sumB = 0, wB = 0, bast = 0, trosk = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (summa - sumB) / wF;
    const mellan = wB * wF * (mB - mF) * (mB - mF);
    if (mellan > bast) { bast = mellan; trosk = v; }
  }
  return trosk;
}

/* ---- OCR-motorn ---------------------------------------------------------- */

let motorLofte = null;

/** Laddar Tesseract en gång och återanvänder arbetaren. */
export function haMotor() {
  if (motorLofte) return motorLofte;
  motorLofte = (async () => {
    if (!window.Tesseract) await laddaSkript(TESSERACT_URL);
    const w = await window.Tesseract.createWorker('eng');
    await w.setParameters({
      tessedit_char_whitelist: OCR_ALFABET,
      tessedit_pageseg_mode: '7',            // en enda textrad, inget dokument
      classify_bln_numeric_mode: '0',
    });
    return w;
  })().catch(e => { motorLofte = null; throw e; });
  return motorLofte;
}

function laddaSkript(url) {
  return new Promise((ok, nej) => {
    const s = document.createElement('script');
    s.src = url; s.async = true;
    s.onload = ok;
    s.onerror = () => nej(new Error('Kunde inte ladda textigenkänningen. Kräver internet första gången.'));
    document.head.appendChild(s);
  });
}

/**
 * Läser en förbehandlad bild. Returnerar { plat, ratext, sakerhet } —
 * plat är null när ingenting giltigt gick att få ut.
 */
export async function lasBild(canvas) {
  const w = await haMotor();
  const { data } = await w.recognize(canvas);
  const ratext = (data.text || '').trim();
  return { plat: normaliseraPlat(ratext), ratext, sakerhet: Math.round(data.confidence || 0) };
}

/**
 * Uppskattar hur mycket skylten lutar, utan att fråga OCR-motorn.
 *
 * En skylt sedd snett får tecknen att glida in i varandra, och då läses
 * "ABC123" som "ANBCA23". Vi vet inte vinkeln i förväg. Att pröva sig fram
 * med tre OCR-körningar fungerar men är både långsamt och trubbigt.
 *
 * Istället: tecken som står rakt bildar tydliga svarta kolumner med vita
 * mellanrum. Lutar de smetas kolumnerna ut. Vi räknar svarta pixlar per
 * kolumn för en rad vinklar och tar den vinkel där skillnaden mellan
 * kolumnerna är som störst — det är när tecknen står rakast.
 *
 * @param {HTMLCanvasElement} bin  redan tröskladbild, svart text på vitt
 */
export function uppskattaLutning(bin) {
  const g = bin.getContext('2d', { willReadFrequently: true });
  const b = bin.width, h = bin.height;
  const px = g.getImageData(0, 0, b, h).data;

  // Bara mittpartiet i höjdled — skyltens över- och underkant bidrar inget
  // och drar ner utslaget.
  const y0 = Math.round(h * 0.2), y1 = Math.round(h * 0.8);

  const morkt = new Uint8Array(b * h);
  for (let i = 0, p = 0; i < b * h; i++, p += 4) morkt[i] = px[p] < 128 ? 1 : 0;

  let bastVinkel = 0, bastVarians = -1;
  const kolumner = new Float32Array(b);

  for (let v = -20; v <= 20; v += 2) {
    kolumner.fill(0);
    const lut = Math.tan(v * Math.PI / 180);
    for (let y = y0; y < y1; y++) {
      const skift = Math.round(lut * (y - h / 2));
      for (let x = 0; x < b; x++) {
        if (!morkt[y * b + x]) continue;
        const xx = x - skift;
        if (xx >= 0 && xx < b) kolumner[xx]++;
      }
    }
    let medel = 0;
    for (let x = 0; x < b; x++) medel += kolumner[x];
    medel /= b;
    let varians = 0;
    for (let x = 0; x < b; x++) { const d = kolumner[x] - medel; varians += d * d; }
    if (varians > bastVarians) { bastVarians = varians; bastVinkel = v; }
  }
  return bastVinkel;
}

/**
 * Hela vägen från en bildruta till en skylt: hitta skylten i siktrutan, räta
 * upp den, tröskla, läs, validera. Returnerar den bästa giltiga läsningen.
 *
 * @returns {{plat:string|null, sakerhet:number, bild:HTMLCanvasElement}}
 */
export async function lasRuta(kalla, roi) {
  // Snäva in på skylten när den går att hitta. Går den inte att hitta får
  // hela rutan duga — hellre ett försök än inget.
  const traff = hittaPlat(kalla, roi);
  const snav = traff || roi;

  // Det blå EU-fältet är mörkt, så lokaliseringen har redan lämnat det
  // utanför. Kapar vi då ytterligare en tiondel äter vi första tecknet —
  // M blev U, och det såg ut som ett fel i motorn. Kapningen behövs bara när
  // vi inte hittade skylten och skickar in hela rutan.
  const kapaEuFalt = !traff;

  // Lutar skylten i bild rätas den upp redan i beskärningen. Vinkeln kommer
  // från sökningen och kostar ingen extra OCR-körning.
  let vridning = Math.abs(snav.vinkel || 0) >= VINKEL_DODBAND ? snav.vinkel : 0;

  // Rakt på först. Går det bra behöver vi inte röra vinkeln alls.
  const rak = forbehandla(kalla, snav, { kapaEuFalt, vridning });
  let bast = { plat: null, sakerhet: 0, bild: rak };

  const r0 = await lasBild(rak);
  if (r0.plat) bast = { plat: r0.plat, sakerhet: r0.sakerhet, bild: rak };
  if (r0.plat && r0.sakerhet >= 80) return bast;

  /*
   * Huvudaxeln vet vilken linje skylten ligger längs, men inte åt vilket håll
   * den läses — en skylt och samma skylt upp och ner ger identiska moment. Vid
   * små lutningar spelar det ingen roll: en bil som lutar 20° lutar 20°, den
   * står inte på taket. Vid liggande telefon gör det det, för då är ±90° två
   * helt olika bilder. Prövas bara när första försöket inte gav någon skylt,
   * så den kostar ingenting i normalfallet.
   */
  if (!bast.plat && Math.abs(vridning) > 60) {
    const vand = forbehandla(kalla, snav, { kapaEuFalt, vridning: vridning + 180 });
    const rv = await lasBild(vand);
    if (rv.plat) {
      bast = { plat: rv.plat, sakerhet: rv.sakerhet, bild: vand };
      vridning += 180;
      if (rv.sakerhet >= 80) return bast;
    }
  }

  // Annars: mät lutningen och räta upp. Mätningen kostar ingen OCR-körning,
  // så det är billigare än att pröva sig fram med flera gissningar.
  const lutning = uppskattaLutning(bast.bild);
  if (lutning) {
    const rat = forbehandla(kalla, snav, { kapaEuFalt, lutning, vridning });
    const r1 = await lasBild(rat);
    // En giltig skylt slår alltid ingen skylt. Att jämföra säkerheten först
    // vore fel: motorn rapporterar ibland 0 % även för en läsning som
    // stämmer, och då kastades det rätta svaret bort.
    if (r1.plat && (!bast.plat || r1.sakerhet > bast.sakerhet)) {
      bast = { plat: r1.plat, sakerhet: r1.sakerhet, bild: rat };
    }
  }
  return bast;
}

/**
 * Läser en kandidat från målsökningen.
 *
 * Kandidatens ruta ligger tätt om skyltens ljusa yta. `lasRuta` letar reda på
 * skylten en gång till inuti den ruta den får, och behöver lite luft för att
 * lyckas — hittar den ingenting kapar den EU-fältet på egen hand och äter då
 * första tecknet. Marginalen här är billigare än den felläsningen.
 */
export function lasKandidat(kalla, kandidat) {
  const mx = kandidat.w * 0.06, my = kandidat.h * 0.14;
  return lasRuta(kalla, {
    x: kandidat.x - mx, y: kandidat.y - my,
    w: kandidat.w + mx * 2, h: kandidat.h + my * 2,
  });
}

/* Grundvärden för målsökningen. Motiveringen står i docs/malsokning.md. */
export const MALSOK = {
  bildrutorForLas: 8,   // ~1 s vid 120 ms mellan sökningar
  tappForLas: 3,        // en låst kandidat får försvinna 3 bildrutor
  tappForSpar: 2,       // en olåst släpps snabbare
  minPoang: 0.16,       // under det låser vi inte, hur ensam kandidaten än är
  brandForsok: 3,       // så många läsningar utan giltig skylt bränner låset
  glidning: 0.4,        // hur mycket av den nya positionen som slår igenom
  maxSpar: 12,
};

/**
 * Spårar kandidater mellan bildrutor och håller låset.
 *
 * En sökning i taget vet ingenting om tid. Den ser ljusa fläckar. Det som gör
 * ett lås möjligt är att samma fläck går att känna igen i nästa bildruta: den
 * ligger nära där den låg, och den är ungefär lika stor. Rör den sig långt
 * eller byter storlek plötsligt är det inte samma sak, hur lik den än ser ut.
 *
 * Låset kräver att kandidaten setts flera bildrutor i rad. Det är hela
 * poängen: ett sikte som låser omedelbart låser lika gärna på en solreflex.
 *
 * Och låset kan brännas. En kandidat som gång på gång skickas till
 * textigenkänningen utan att någonsin ge en giltig skylt är inte en skylt —
 * det är en skåpbilsdörr. Då släpps den och nästa kandidat får chansen. Utan
 * det fastnar siktet på fel sak och läser med tillförsikt.
 */
export class Malsokare {
  constructor(opt = {}) {
    this.k = { ...MALSOK, ...opt };
    this.spar = [];
    this.lastId = null;
    this.sisteOrsak = null;
    this._nastaId = 1;
  }

  get last() { return this.spar.find(s => s.id === this.lastId) || null; }

  nollstall() { this.spar = []; this.lastId = null; this.sisteOrsak = null; }

  /**
   * Matar in en bildrutas kandidater och får tillbaka spåren.
   * @returns {{spar:Array, last:object|null}}
   */
  mata(kandidater, nu = Date.now()) {
    const lediga = (kandidater || []).map(k => ({ k, tagen: false }));

    // Låst spår först, sedan de mest sedda. Vid tveksam matchning ska låset
    // få behålla sin kandidat — annars stjäl en nyfödd fläck den.
    const ordning = [...this.spar].sort((a, b) =>
      (b.id === this.lastId) - (a.id === this.lastId) || b.traffar - a.traffar);

    for (const s of ordning) {
      let bast = -1, bastAvst = Infinity;
      for (let i = 0; i < lediga.length; i++) {
        if (lediga[i].tagen) continue;
        const k = lediga[i].k;
        const ref = Math.max(s.w, k.w);
        const avst = Math.hypot((k.x + k.w / 2) - (s.x + s.w / 2),
                                (k.y + k.h / 2) - (s.y + s.h / 2)) / ref;
        const storleksbyte = k.w / s.w;
        // Nära, och ungefär lika stor. Bilen framför kan komma närmare mellan
        // två bildrutor, men den kan inte fördubbla sin skylt på 120 ms.
        if (avst > 0.7 || storleksbyte < 0.55 || storleksbyte > 1.8) continue;
        if (avst < bastAvst) { bastAvst = avst; bast = i; }
      }
      if (bast < 0) { s.tappade++; continue; }

      lediga[bast].tagen = true;
      const k = lediga[bast].k;
      const g = this.k.glidning;
      // Glidande medel på rutan. Rå mätning hoppar en pixel hit och dit varje
      // bildruta, och ett sikte som darrar ser trasigt ut även när det sitter.
      s.x += (k.x - s.x) * g; s.y += (k.y - s.y) * g;
      s.w += (k.w - s.w) * g; s.h += (k.h - s.h) * g;
      s.poang += (k.poang - s.poang) * g;
      s.matt = k;
      s.traffar++; s.tappade = 0; s.sistSedd = nu;
    }

    for (const l of lediga) {
      if (l.tagen) continue;
      this.spar.push({
        id: this._nastaId++,
        x: l.k.x, y: l.k.y, w: l.k.w, h: l.k.h,
        poang: l.k.poang, matt: l.k,
        traffar: 1, tappade: 0, sistSedd: nu,
        ocrForsok: 0, ocrBom: 0, ocrTraffar: 0, brand: false,
      });
    }

    const kvar = [];
    for (const s of this.spar) {
      const tak = s.id === this.lastId ? this.k.tappForLas : this.k.tappForSpar;
      if (s.tappade > tak) {
        if (s.id === this.lastId) { this.lastId = null; this.sisteOrsak = 'tappad'; }
        continue;
      }
      kvar.push(s);
    }
    // Sortera på poäng och håll listan kort. Ett spår som ingen tittar på
    // kostar ingenting, men tusen gör det.
    kvar.sort((a, b) => b.poang - a.poang);
    this.spar = kvar.slice(0, this.k.maxSpar);

    if (this.lastId === null) this.#valjLas();
    for (const s of this.spar) s.last = s.id === this.lastId;
    return { spar: this.spar, last: this.last };
  }

  #valjLas() {
    let bast = null;
    for (const s of this.spar) {
      if (s.brand || s.traffar < this.k.bildrutorForLas) continue;
      if (s.poang < this.k.minPoang) continue;
      if (!bast || s.poang > bast.poang) bast = s;
    }
    if (bast) { this.lastId = bast.id; this.sisteOrsak = 'last'; }
  }

  /** Hur långt den bäst placerade olåsta kandidaten har kommit mot ett lås, 0–1. */
  get pahang() {
    let b = 0;
    for (const s of this.spar) {
      if (s.brand || s.poang < this.k.minPoang) continue;
      b = Math.max(b, Math.min(1, s.traffar / this.k.bildrutorForLas));
    }
    return b;
  }

  /**
   * Rapporterar in vad textigenkänningen fick ut ur ett spår.
   * Giltig skylt nollställer bomräkningen — en skylt som lästs en gång är en
   * skylt även när nästa bildruta är suddig.
   */
  rapporteraLasning(id, giltig) {
    const s = this.spar.find(x => x.id === id);
    if (!s) return;
    s.ocrForsok++;
    if (giltig) { s.ocrTraffar++; s.ocrBom = 0; return; }
    s.ocrBom++;
    if (s.ocrTraffar === 0 && s.ocrBom >= this.k.brandForsok) {
      s.brand = true;
      if (s.id === this.lastId) { this.lastId = null; this.sisteOrsak = 'brand'; }
    }
  }

  slappLas(orsak = 'manuell') {
    if (this.lastId === null) return;
    this.lastId = null; this.sisteOrsak = orsak;
    for (const s of this.spar) s.last = false;
  }
}

/* ---- Lutningsgivaren ----------------------------------------------------
 *
 * Ett tillägg, inte en förutsättning. Detektionen hittar lutade skyltar helt
 * på egen hand (se `skannaLjusa`) och gör det utan att fråga användaren om
 * någonting. Det som givaren tillför är en gissning om hur telefonen sitter,
 * och den gissningen används till exakt en sak: att rangordna en kandidat som
 * lutar lika mycket som telefonen lika högt som en rak. Inget mer.
 *
 * Varför så snålt: iOS kräver tillstånd till rörelsedata, och tillståndet får
 * bara begäras från ett riktigt knapptryck. Ett läsläge som kräver ett
 * knapptryck innan det fungerar är inte ett läsläge som fungerar. Nekar
 * användaren, eller sitter telefonen i en Android utan sensor, blir svaret
 * exakt det samma som förut — bara utan den lilla extra precisionen i
 * rangordningen.
 *
 * Tillståndsflaggorna lånas ur js/impact.js. Det är samma tillstånd, samma
 * händelse och samma iOS-dialog; att fråga två gånger för samma sak vore både
 * påträngande och en andra mekanism att hålla i synk.
 */

export const lutningStods = motionSupported;
export const lutningKraverTillstand = motionNeedsPermission;

export class Lutningsgivare extends EventTarget {
  constructor() {
    super();
    this.tillstand = motionNeedsPermission ? 'okant' : (motionSupported ? 'beviljat' : 'saknas');
    this.aktiv = false;
    this.vinkel = 0;
    this._prov = 0;
    this._h = e => this.#matning(e);
  }

  /** Måste anropas från ett riktigt knapptryck på iOS. Samma krav som i impact.js. */
  async begarTillstand() {
    if (!motionSupported) { this.tillstand = 'saknas'; return false; }
    if (!motionNeedsPermission) { this.tillstand = 'beviljat'; return true; }
    try {
      const svar = await DeviceMotionEvent.requestPermission();
      this.tillstand = svar === 'beviljat' || svar === 'granted' ? 'beviljat' : 'nekat';
    } catch {
      this.tillstand = 'nekat';
    }
    return this.tillstand === 'beviljat';
  }

  async start() {
    if (this.aktiv || !motionSupported) return false;
    if (this.tillstand !== 'beviljat' && !(await this.begarTillstand())) return false;
    addEventListener('devicemotion', this._h);
    this.aktiv = true; this._prov = 0;
    return true;
  }

  stop() {
    if (!this.aktiv) return;
    removeEventListener('devicemotion', this._h);
    this.aktiv = false; this._prov = 0;
  }

  /**
   * Skärmens egen vridning. Kostar ingenting och kräver inget tillstånd.
   * Sensorns axlar följer telefonens hölje, medan videobilden levereras i
   * skärmens läge — utan det här ligger de 90° fel så fort telefonen vänds.
   */
  get skarmvinkel() {
    const v = Number(screen?.orientation?.angle);
    return Number.isFinite(v) ? v : 0;
  }

  /** Sant först när det kommit några mätningar. En sensor som inte svarat
   *  ännu ska inte låtsas att telefonen står rak. */
  get harVarde() { return this.aktiv && this._prov > 5; }

  #matning(e) {
    // Tyngdkraften, inte rörelsen. En bil skakar; tyngdkraften gör det inte.
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const rad = Math.atan2(a.x, a.y);
    const ny = vikVinkel(rad * 180 / Math.PI - this.skarmvinkel);
    this._prov++;
    // Lågpassfilter. Rå accelerometerdata i en bil hoppar flera grader per
    // avläsning, och en prior som darrar är sämre än ingen prior.
    if (this._prov <= 5) this.vinkel = ny;
    else this.vinkel = vikVinkel(this.vinkel + vikVinkel(ny - this.vinkel) * 0.08);
  }
}

/* ---- Läsaren ------------------------------------------------------------- */

export const plateSupported = !!(navigator.mediaDevices?.getUserMedia && window.OffscreenCanvas !== undefined
  || navigator.mediaDevices?.getUserMedia);

/*
 * Vad vi ber kameran om, och var gränsen går.
 *
 * `minBredd` är det som gör att en högre bildfrekvens inte får kosta upplösning.
 * Frågan är verklig: getUserMedia väger alla `ideal`-önskemål mot varandra och
 * väljer det läge som sammanlagt ligger närmast. En telefon som kan
 * 1920 × 1080 vid 30 och 1280 × 720 vid 60 kan mycket väl svara med
 * 1280 × 720 — den träffar då bildfrekvensen exakt och missar upplösningen
 * "bara" en bit. Det är fel avvägning för just den här appen.
 *
 * Skylten behöver pixlar mer än den behöver bildrutor. En skylt på 20 meters
 * håll är runt 40 pixlar bred i 1080p och under 30 i 720p, och under 24 slutar
 * teckenräkningen svara ja eller nej över huvud taget. Bildrutorna gör en
 * suddig skylt skarpare; upplösningen avgör om det finns en skylt att göra
 * skarp. Därför: be om båda, kontrollera vad vi fick, och backa bildfrekvensen
 * om upplösningen blev lidande.
 */
export const KAMERA = {
  bredd: 1920,
  hojd: 1080,
  bildfrekvens: 60,
  minBredd: 1280,        // under det byter vi tillbaka till 30 b/s
  reservBildfrekvens: 30,
};

/**
 * Videovillkoren, som ett eget uttryck så att de går att mäta utan kamera.
 *
 * Allt är `ideal`. Inte ett enda `exact` — ett hårt krav på bildfrekvens eller
 * upplösning gör att getUserMedia kastar `OverconstrainedError` i stället för
 * att ge det näst bästa, och då står läsaren helt still på en telefon som hade
 * kunnat läsa skyltar alldeles utmärkt vid 30 bildrutor i 1080p.
 *
 * (Kameravalet — bakre kameran — är det enda som får vara hårt, och det
 * hanteras för sig i `start()` med ett eget återfall.)
 */
export function kameravillkor(k = KAMERA) {
  return {
    width:  { ideal: k.bredd },
    height: { ideal: k.hojd },
    frameRate: { ideal: k.bildfrekvens },
  };
}

/**
 * Ska vi byta tillbaka till lägre bildfrekvens för att få upplösningen?
 *
 * Ja precis när telefonen gav oss hög bildfrekvens men låg upplösning. Det är
 * den avvägning getUserMedia gör åt oss när flera `ideal` inte går att uppfylla
 * samtidigt, och för den här appen är den fel: en skylt som är för få pixlar
 * bred blir aldrig text, hur skarp den än är. Bildrutorna gör en suddig skylt
 * skarpare — upplösningen avgör om det finns en skylt att göra skarp.
 *
 * @param {{bredd:number, bildfrekvens:number|null}} fick   det kameran gav
 */
export function behoverSankaBildfrekvens(fick, k = KAMERA) {
  return !!(fick && fick.bredd && fick.bredd < k.minBredd &&
            fick.bildfrekvens && fick.bildfrekvens > k.reservBildfrekvens);
}

/**
 * Håller kameran, målsöker skylten och matar OCR:en.
 *
 * Läsaren för ingen lista och skickar inte vidare det den ser. En läsning som
 * inte matchar ett eget fordon slutar inuti #rosta och finns inte kvar efter
 * att den funktionen returnerat — varken som händelse, i minnet eller i DOM:en.
 * En läsare som visar varje skylt den ser är en logg över främmande fordon,
 * oavsett att loggen bara ligger i minnet.
 *
 * Händelser:
 *   'traff'       {plat, sakerhet, egen, fordonId, etikett, exakt}
 *                 ETT AV DINA EGNA fordon. Skickas aldrig för någon annans.
 *   'kandidater'  {kandidater, last, ...}  var siktet ser skyltar, för uppritning
 *   'status'      {text}                   vad den håller på med, för sökarens text
 *   'zoom'        {zoom, optisk, fran}
 *   'fel'         {fel}
 */
export class PlateReader extends EventTarget {
  constructor({ settings, register } = {}) {
    super();
    this.settings = Object.assign({
      intervalMs: 700,        // hur ofta en bildruta skickas till OCR
      krav: 2,                // så många överens innan vi tror på den
      fonsterMs: 6000,        // ...inom det här tidsfönstret
      franvaroMs: 8000,       // så länge måste en skylt ha varit borta för att räknas som ny
      pip: true,
      zoomLage: 'auto',      // 'auto' eller 'manuell'
      zoomVilaMs: 1800,      // minsta tid mellan tva zoomandringar

      // Målsökning
      sokMs: 120,             // hur ofta bilden genomsöks efter kandidater
      sokBredd: 400,          // arbetsbredd för sökningen, i pixlar
      bildrutorForLas: MALSOK.bildrutorForLas,
      tappForLas: MALSOK.tappForLas,
      minPoang: MALSOK.minPoang,
      brandForsok: MALSOK.brandForsok,
      ritaSikte: true,        // false = modulen ritar bara videon, appen ritar siktet
      centrumFallback: true,  // läs mitten när målsökningen inte hittar något alls
      fallbackMs: 3000,

      /*
       * PROVLÄGE — hör till provkörning, inte till produkten.
       *
       * Normalt skickas 'traff' bara för ett av dina egna fordon. Allt annat
       * som läses slutar inuti #rosta och finns inte kvar efter att den
       * funktionen returnerat. Det är med flit: en läsare som visar varje skylt
       * den ser är en logg över främmande fordon, och det är skillnaden mellan
       * en läsare och ett spaningsverktyg. Den skillnaden ska inte suddas ut.
       *
       * Men den som provkör kan inte se om läsaren fungerar. Låset sitter,
       * statusen går "Låst på skylt — läser…" → "Bekräftar skylt…", och sedan
       * händer ingenting synligt — vare sig läsningen blev rätt, fel eller
       * uteblev. Det behöver gå att avgöra, både vid provkörning och när någon
       * senare rapporterar att den inte funkar.
       *
       * Med `provlage: true` skickas 'traff' även för fordon som inte är dina,
       * med `egen: false` och utan fordonId och etikett. Inget lagras, ingen
       * lista förs, ingenting sparas: samma kastas-direkt-beteende som annars,
       * skillnaden är enbart att appen får veta vad som lästes i just det
       * ögonblicket.
       *
       * Det här är alltså INTE en vanlig inställning som en användare ska kunna
       * slå på. Den är kopplad till appens TESTLAGE_UTAN_INLOGGNING, som redan
       * är märkt "SKA SLÅS AV IGEN" — då försvinner provläget av sig självt den
       * dagen appen släpps, utan att någon behöver komma ihåg det. Koppla den
       * inte till någon annan flagga, och lägg den inte i inställningssidan.
       */
      provlage: false,
    }, settings || {});

    /*
     * Den gamla klartextlistan finns inte längre. Skickar appen ändå med en
     * kastas den här — den ska inte överleva i minnet heller, och att tyst
     * använda den hade byggt tillbaka precis det som togs bort.
     */
    delete this.settings.egnaFordon;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pl-canvas';
    this.video = document.createElement('video');
    this.video.playsInline = true; this.video.muted = true;

    this.running = false;
    /*
     * Rösträkningen behöver veta att två bildrutor läste samma sak, men inte
     * vad de läste. Därför är nyckeln en saltad hash och inte ett nummer:
     * ingenting läsbart korsar en bildrutegräns. Båda samlingarna gallras på
     * tid — utan det blir `sedd` en liggande förteckning över varje främmande
     * bil sedan starten, hashad men ändå en förteckning.
     */
    this.senaste = [];          // {h, t} — hash, inte nummer
    this.sedd = new Map();      // hash -> {sistSedd, annonserad}
    this.register = register || null;
    this.antalLasta = 0;        // ren räknare, nollas vid stop. Ingen historik.
    this.stream = null;
    this.arbetar = false;
    this._roi = null;
    this.zoom = 1;
    this.optiskZoom = 1;
    this.digitalZoom = 1;
    this._sistZoomAt = 0;
    this._bomkast = 0;

    this.malsokare = new Malsokare({
      bildrutorForLas: this.settings.bildrutorForLas,
      tappForLas: this.settings.tappForLas,
      minPoang: this.settings.minPoang,
      brandForsok: this.settings.brandForsok,
    });
    this.kandidater = [];
    this.kamera = null;
    // Frivillig, och avstängd tills någon trycker på en knapp. Se klassen.
    this.lutningsgivare = new Lutningsgivare();
    this.sokMsSenast = 0;
    this.sokMsMedel = 0;      // rullande medel, för mätning i fält
    this._sistLast = 0;
    this._sisteStatus = null;

    /*
     * Reservsalt för det fall registret inte gick att läsa. Då kan läsaren
     * fortfarande rösta — den kan bara aldrig säga att något är ditt fordon,
     * vilket är rätt svar när den inte vet.
     */
    try { this._sessionSalt = nyttSalt(); } catch { this._sessionSalt = null; }
  }

  async start() {
    if (this.running) return;

    if (!this.register) {
      try { this.register = haFordonsregister(); } catch { this.register = null; }
    }

    /*
     * Sextio bildrutor i sekunden, och inte för att läsa fler av dem —
     * textigenkänningen kör ett par gånger i sekunden och sökningen åtta, så
     * bildrutor är det minsta vi saknar.
     *
     * Skälet är exponeringstiden. En kamera som ska hinna med 60 bildrutor i
     * sekunden kan aldrig exponera längre än 1/60 s per ruta, oftast kortare.
     * Vid 30 får den dubbelt så lång tid, och all den tiden rör sig bilen
     * framför. Det är precis den rörelseoskärpan pipelinen fortfarande faller
     * på: de två fall som missas är "smutsig skylt" och "värsta fallet", och
     * båda handlar om att tecknen smetas ut.
     *
     * `ideal`, aldrig `exact` — och vad kameran faktiskt gav läses tillbaka i
     * `#stallInKamera`. Se `kameravillkor` och `behoverSankaBildfrekvens`.
     *
     * Kameravalet är det enda som får vara hårt: får vi selfiekameran är läget
     * meningslöst, och ett tydligt fel är bättre än en sökare mot taket.
     */
    const vc = kameravillkor();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { ...vc, facingMode: { exact: 'environment' } }, audio: false,
      });
    } catch {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { ...vc, facingMode: 'environment' }, audio: false,
      });
      if (this.#arFramat(this.stream.getVideoTracks()[0])) {
        this.#slappStream();
        throw new Error('Telefonen gav selfiekameran. Skyltläsaren behöver den bakre kameran.');
      }
    }

    await this.#stallInKamera();

    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await this.#vantaPaBild();

    this.running = true;
    this.malsokare.nollstall();
    this.#status('Söker skylt…');
    this.#rita();
    // setInterval, inte requestAnimationFrame: rAF står stilla så fort
    // skärmen slocknar eller fliken hamnar i bakgrunden, och då slutade
    // dashcamen spela in mitt i en resa. Samma fälla gäller här.
    this._ocrTimer = setInterval(() => this.#steg(), this.settings.intervalMs);
    this._ritTimer = setInterval(() => this.#rita(), 100);
    // Sökningen går i egen takt, mycket snabbare än OCR:en. Den är billig och
    // det är den som avgör hur snabbt låset kan sitta — ett lås som byggs av
    // läsningar var sjunde tiondel hade tagit sex sekunder.
    this._sokTimer = setInterval(() => this.#sok(), this.settings.sokMs);

    // Värm motorn medan användaren riktar in sig, så första läsningen inte
    // tar fem sekunder.
    haMotor().catch(e => this.#fel(e));
  }

  stop() {
    this.running = false;
    clearInterval(this._ocrTimer); clearInterval(this._ritTimer); clearInterval(this._sokTimer);
    this._ocrTimer = this._ritTimer = this._sokTimer = null;
    this.malsokare.nollstall();
    this.kandidater = [];
    this.lutningsgivare.stop();
    this.#slappStream();
    this.video.srcObject = null;
    // Rösträkningens hashar har inget att göra i minnet när kameran är av.
    this.rensa();
  }

  /** Nollar rösträkningen. Det finns ingen lista att rensa längre. */
  rensa() {
    this.senaste = []; this.sedd.clear(); this.antalLasta = 0;
  }

  /** Zoom via kameran när telefonen kan, annars digitalt genom en snävare ruta. */
  /**
   * Ställ zoomen.
   *
   * Två vägar, i den ordningen: kamerans egen zoom om telefonen har den, annars
   * digital förstoring i ritningen. Kamerazoom är alltid bättre — den ger fler
   * riktiga pixlar på skylten, medan digital zoom bara förstorar de pixlar som
   * redan finns. Men digital duger, eftersom det som avgör om OCR:en lyckas är
   * hur stor skylten är i den ruta som skickas in, och den blir större åt båda
   * hållen.
   *
   * Att bara krympa siktrutan, som första versionen gjorde, var fel: rutan
   * blev mindre på skärmen men bilden förstorades inte, så det såg ut som att
   * zoomen gjorde tvärtom.
   */
  async zooma(faktor, { fran = 'manuell' } = {}) {
    const v = Math.max(1, Math.min(this.maxZoom, faktor));
    this.zoom = v;

    const t = this.stream?.getVideoTracks?.()[0];
    const k = t?.getCapabilities?.();
    if (k?.zoom) {
      const kv = Math.max(k.zoom.min, Math.min(k.zoom.max, v));
      try {
        await t.applyConstraints({ advanced: [{ zoom: kv }] });
        this.optiskZoom = kv;
        this.digitalZoom = v / kv;              // resten tas digitalt
        this.#zoomAndrad(fran);
        return true;
      } catch {}
    }
    this.optiskZoom = 1;
    this.digitalZoom = v;
    this.#zoomAndrad(fran);
    return false;
  }

  /**
   * Största zoom den här telefonen klarar.
   *
   * Taket kommer från kameran, inte från ett tal valt på måfå. Skillnaden är
   * stor och verklig: en modern toppmodell har tiotals gångers zoom i
   * hårdvara, en några år gammal telefon knappt någon alls. Ett fast tak hade
   * antingen strypt den ena eller lovat något den andra inte kan hålla.
   *
   * Saknar telefonen zoom helt finns bara digital förstoring kvar, och den
   * begränsas till tre gånger. Bortom det tillför den ingen information —
   * pixlarna blir bara större, och en suddig skylt läses inte bättre för att
   * den är stor. Det är ett ärligt tak, inte ett snålt.
   */
  get maxZoom() {
    const k = this.stream?.getVideoTracks?.()[0]?.getCapabilities?.();
    const kamera = Number(k?.zoom?.max) || 0;
    return kamera > 1 ? kamera : 3;
  }

  #zoomAndrad(fran) {
    this.dispatchEvent(new CustomEvent('zoom', {
      detail: { zoom: this.zoom, optisk: this.optiskZoom, fran, lage: this.settings.zoomLage },
    }));
  }

  /**
   * Autozoom.
   *
   * Styr på det som faktiskt avgör om en skylt går att läsa: hur stor den är i
   * rutan. Mätningen i ocr-test.html visade att en skylt som fyller sökaren
   * läses nästan alltid, medan en som är en bråkdel av den nästan aldrig går
   * fram. Skärpa hade varit ett sämre mått — en suddig men stor skylt läses
   * ofta ändå, en knivskarp men liten gör det aldrig.
   *
   * Regleringen är avsiktligt trög. En snabb loop börjar jaga: den zoomar in,
   * tappar skylten ur bild, zoomar ut, hittar den igen, och pumpar fram och
   * tillbaka utan att någonsin stå still länge nog för en läsning.
   */
  #justeraZoom(traff) {
    if (this.settings.zoomLage !== 'auto' || !this._roi) return;

    const nu = Date.now();
    if (nu - this._sistZoomAt < this.settings.zoomVilaMs) return;

    let mal = null;
    if (!traff) {
      // Ingen skylt hittad. Bara zooma ut, och först efter flera bomkast —
      // en enstaka bildruta utan träff betyder oftast bara att bilen framför
      // svängde eller att någon gick förbi.
      if (++this._bomkast < 4) return;
      if (this.zoom <= 1) { this._bomkast = 0; return; }
      mal = Math.max(1, this.zoom - 0.5);
    } else {
      this._bomkast = 0;
      // Skyltens långsida, inte den omslutande lådans bredd. Lutar bilden är
      // lådan bredare än skylten, och zoomen hade trott att den redan var
      // stor nog.
      const andel = (traff.rw || traff.w) / this._roi.w;
      // Under en tredjedel av rutan är skylten för liten för att läsas säkert.
      if (andel < 0.34) mal = this.zoom + 0.4;
      // Över nio tiondelar riskerar kanttecknen att hamna utanför.
      else if (andel > 0.9) mal = this.zoom - 0.3;
      else return;                                  // lagom, rör ingenting
    }

    mal = Math.min(mal, this.#zoomtakForMal());
    mal = Math.max(1, Math.min(this.maxZoom, Math.round(mal * 10) / 10));
    if (Math.abs(mal - this.zoom) < 0.05) return;
    this._sistZoomAt = nu;
    this.zooma(mal, { fran: 'auto' });
  }

  /**
   * Hur mycket zoomen får dras upp utan att målet hamnar utanför bild.
   *
   * Zoomen förstorar kring bildens mitt, men målet ligger sällan i mitten —
   * det är hela anledningen till att målsökningen finns. Utan det här taket
   * zoomar den in tills skylten glider ut ur bild, tappar låset, zoomar ut,
   * hittar den igen och pumpar fram och tillbaka utan att någonsin stå still
   * länge nog för en läsning. Det syntes direkt i mätningen: en skylt nere
   * till vänster hamnade halvvägs utanför utsnittet vid 1,4×.
   *
   * Räkningen görs i andel av den synliga halvbilden. Allt förstoras med
   * samma faktor, så ett mål som ligger på nio tiondelar ut får zoomen att
   * stanna där — och ligger det redan utanför blir taket lägre än nuvarande
   * zoom, vilket drar tillbaka den.
   */
  #zoomtakForMal() {
    const s = this.malsokare?.last, u = this._utsnitt;
    if (!s || !u?.w || !u?.h) return this.maxZoom;
    const cx = u.x + u.w / 2, cy = u.y + u.h / 2;
    const fx = Math.max(Math.abs(s.x - cx), Math.abs(s.x + s.w - cx)) / (u.w / 2);
    const fy = Math.max(Math.abs(s.y - cy), Math.abs(s.y + s.h - cy)) / (u.h / 2);
    return Math.max(1, this.zoom * 0.9 / Math.max(fx, fy, 0.01));
  }

  /**
   * Målsökningen. Går igenom hela den synliga bilden, spårar kandidaterna
   * mellan bildrutor och håller låset. Ingen textigenkänning sker här — det
   * här steget avgör bara vad som är värt att läsa.
   *
   * Sökområdet är utsnittet, inte hela videon. Vid digital zoom ser
   * användaren bara mitten, och att låsa på en skylt utanför bild vore både
   * obegripligt och oläsbart.
   */
  #sok() {
    if (!this.running || !this.video.videoWidth) return;
    const yta = this._utsnitt ||
      { x: 0, y: 0, w: this.video.videoWidth, h: this.video.videoHeight };

    let kand = [];
    const t0 = performance.now();
    try {
      kand = sokKandidater(this.video, yta, {
        arbetsbredd: this.settings.sokBredd,
        // null när givaren är av eller inte hunnit svara. Sökningen fungerar
        // lika fullt — vinkeln mäts ur bilden, aldrig ur sensorn.
        forvantadVinkel: this.lutningsgivare.harVarde ? this.lutningsgivare.vinkel : null,
      });
    } catch (e) {
      this.#fel(e); return;
    }
    this.sokMsSenast = performance.now() - t0;
    this.sokMsMedel = this.sokMsMedel
      ? this.sokMsMedel * 0.9 + this.sokMsSenast * 0.1
      : this.sokMsSenast;

    const { spar, last } = this.malsokare.mata(kand);
    this.kandidater = spar;
    if (last) this._sistLast = Date.now();
    // "Ser ABC 123 — bekräftar…" ska hinna läsas. Utan spärren skriver
    // sökningen över den 120 ms senare och texten blinkar förbi.
    if (Date.now() > (this._statusLas || 0)) this.#status(this.#lagesText());
    this.dispatchEvent(new CustomEvent('kandidater', { detail: this.siktdata() }));
  }

  /**
   * Allt gränssnittet behöver för att rita siktet.
   *
   * Rutorna anges två gånger: i videons pixlar, som är det OCR:en arbetar i,
   * och i canvasens pixlar, som är det man ser. De skiljer sig så fort digital
   * zoom är på, och att blanda ihop dem ritar siktet på fel ställe.
   */
  siktdata() {
    const v = this.video, c = this.canvas;
    const u = this._utsnitt || { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
    const sx = u.w ? c.width / u.w : 1, sy = u.h ? c.height / u.h : 1;
    const till = k => ({
      x: (k.x - u.x) * sx, y: (k.y - u.y) * sy, w: k.w * sx, h: k.h * sy,
    });
    const kandidater = this.kandidater.map(s => ({
      id: s.id, x: s.x, y: s.y, w: s.w, h: s.h,
      poang: s.poang, traffar: s.traffar, tappade: s.tappade,
      brand: s.brand, last: !!s.last,
      mognad: Math.min(1, s.traffar / this.settings.bildrutorForLas),
      canvas: till(s),
    }));
    return {
      kandidater,
      last: kandidater.find(k => k.last) || null,
      video: { bredd: v.videoWidth, hojd: v.videoHeight },
      canvas: { bredd: c.width, hojd: c.height },
      utsnitt: u,
      sokMs: Math.round(this.sokMsMedel * 10) / 10,
      lasKrav: this.settings.bildrutorForLas,
    };
  }

  #lagesText() {
    if (this.malsokare.last) return 'Låst på skylt — läser…';
    if (this.malsokare.pahang > 0) return 'Låser på skylt…';
    return 'Söker skylt…';
  }

  /**
   * Siktet. Kandidaterna ritas tunt, den som håller på att låsas fyller sin
   * mätare, och låset får hörnvinklar. Ingen ljudsignal — bilkörning är inte
   * ett dataspel, och ett pip per lås hade pipit hela vägen till jobbet.
   *
   * Går att stänga av helt med `ritaSikte: false`, och då ritas bara
   * videobilden. Appen kan då lägga sitt eget sikte ovanpå.
   */
  #ritaSikte(g, c) {
    const d = this.siktdata();
    const tjock = Math.max(1.5, c.width / 480);

    for (const k of d.kandidater) {
      const r = k.canvas;
      if (k.last) continue;
      if (k.brand || k.traffar < 2) continue;
      g.save();
      g.strokeStyle = 'rgba(143,202,255,.55)';
      g.lineWidth = tjock;
      g.strokeRect(r.x, r.y, r.w, r.h);
      // Mätaren under rutan visar hur nära ett lås kandidaten är. Utan den ser
      // väntan ut som att ingenting händer.
      if (k.mognad > 0) {
        g.fillStyle = 'rgba(143,202,255,.85)';
        g.fillRect(r.x, r.y + r.h + tjock * 1.5, r.w * k.mognad, tjock * 1.2);
      }
      g.restore();
    }

    if (!d.last) return;
    const r = d.last.canvas;
    const arm = Math.min(r.w, r.h) * 0.45;
    g.save();
    g.strokeStyle = '#2fd07a';
    g.lineWidth = tjock * 1.8;
    g.lineCap = 'round';
    for (const [hx, hy, dx, dy] of [
      [r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1],
      [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1],
    ]) {
      g.beginPath();
      g.moveTo(hx + dx * arm, hy);
      g.lineTo(hx, hy);
      g.lineTo(hx, hy + dy * arm);
      g.stroke();
    }
    g.restore();
  }

  /**
   * Läser tillbaka vad kameran faktiskt gav, och rättar till bytet om den
   * betalade bildfrekvensen med upplösning.
   *
   * Att läsa tillbaka är hela poängen. `ideal` är ett önskemål, inte ett löfte,
   * och en app som visar vad den bad om i stället för vad den fick ljuger för
   * den som felsöker. `getSettings()` är det enda stället där sanningen står.
   */
  async #stallInKamera() {
    const t = this.stream?.getVideoTracks?.()[0];
    if (!t) return;

    const las = () => {
      const s = t.getSettings?.() || {};
      return {
        bredd: s.width || 0,
        hojd: s.height || 0,
        bildfrekvens: s.frameRate ? Math.round(s.frameRate) : null,
      };
    };

    let f = las();
    let sankt = false;

    // Fick vi hög bildfrekvens men låg upplösning har telefonen gjort precis
    // den avvägning vi inte vill ha. Be om samma upplösning igen, nu utan att
    // pressa bildfrekvensen, och behåll resultatet bara om det blev bättre.
    if (behoverSankaBildfrekvens(f)) {
      try {
        await t.applyConstraints({
          width:  { ideal: KAMERA.bredd },
          height: { ideal: KAMERA.hojd },
          frameRate: { ideal: KAMERA.reservBildfrekvens },
        });
        const efter = las();
        if (efter.bredd > f.bredd) { f = efter; sankt = true; }
      } catch { /* kameran vägrade byta läge — behåll det vi har */ }
    }

    this.kamera = {
      ...f,
      begard: { ...KAMERA },
      sanktForPixlar: sankt,
      // Kort exponering är det bildfrekvensen köper. Taket är 1/frekvens; i
      // dagsljus ligger den verkliga tiden under det.
      maxExponeringMs: f.bildfrekvens ? Math.round(1000 / f.bildfrekvens) : null,
    };
    this.dispatchEvent(new CustomEvent('kamera', { detail: this.kamera }));
  }

  /** Vad kameran gav, inte vad vi bad om. null innan kameran startat. */
  get kamerainfo() { return this.kamera; }

  /**
   * Slår på lutningsgivaren. Måste anropas från ett riktigt knapptryck på iOS.
   * Läsaren fungerar utan — se `Lutningsgivare`. Returnerar om den kom igång.
   */
  async aktiveraLutning() {
    const ok = await this.lutningsgivare.start();
    this.dispatchEvent(new CustomEvent('lutning', { detail: this.lutningsinfo }));
    return ok;
  }

  get lutningsinfo() {
    const l = this.lutningsgivare;
    return {
      stods: lutningStods, kraverTillstand: lutningKraverTillstand,
      tillstand: l.tillstand, aktiv: l.aktiv,
      vinkel: l.harVarde ? Math.round(l.vinkel * 10) / 10 : null,
      skarmvinkel: l.skarmvinkel,
    };
  }

  #slappStream() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  #arFramat(track) {
    const s = track?.getSettings?.() || {};
    if (s.facingMode === 'user') return true;
    if (s.facingMode === 'environment') return false;
    const namn = (track?.label || '').toLowerCase();
    if (!namn) return false;
    if (/\b(back|rear|environment|bak)\b/.test(namn)) return false;
    return /\b(front|user|selfie|face|fram)\b/.test(namn);
  }

  #vantaPaBild() {
    return new Promise(ok => {
      let kvar = 40;
      const kolla = () => {
        if (this.video.videoWidth > 0 || --kvar <= 0) { clearInterval(id); ok(); }
      };
      const id = setInterval(kolla, 100);
      kolla();
    });
  }

  /**
   * Mittrutan. Den är inte längre ett krav på var skylten ska ligga — den är
   * kvar av två skäl: autozoomen mäter skyltens storlek mot den, och hittar
   * målsökningen ingenting alls är mitten den enda gissning som är bättre än
   * ingen.
   *
   * Svenska skyltar är 520 × 110 mm, alltså 4,7 gånger bredare än höga.
   */
  #beraknaRoi(vb, vh) {
    // Rutan är en fast andel av det man ser. Zoomen förstorar bilden, inte
    // krymper rutan — annars ser det ut som att zoomen gör tvärtom.
    const w = Math.min(vb * 0.82, vh * 2.6);
    const h = w / 4.7;
    return { x: (vb - w) / 2, y: (vh - h) / 2, w, h };
  }

  #rita() {
    const v = this.video;
    if (!v.videoWidth) return;
    const c = this.canvas, g = c.getContext('2d');
    if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }

    /*
     * Digital zoom görs här, genom att rita ett mindre utsnitt över hela
     * canvasen. Då ser användaren en verkligt förstorad bild — inte en
     * krympt ruta i en oförändrad bild, vilket var det gamla beteendet och
     * såg ut som en bugg.
     *
     * Utsnittet sparas, eftersom OCR:en läser ur videon och inte ur canvasen.
     * Siktrutans koordinater måste därför räknas om till videons pixlar innan
     * de skickas vidare, annars läser motorn på fel ställe.
     */
    const dz = Math.max(1, this.digitalZoom || 1);
    const uw = v.videoWidth / dz, uh = v.videoHeight / dz;
    const ux = (v.videoWidth - uw) / 2, uy = (v.videoHeight - uh) / 2;
    this._utsnitt = { x: ux, y: uy, w: uw, h: uh };
    g.drawImage(v, ux, uy, uw, uh, 0, 0, c.width, c.height);

    const roi = this.#beraknaRoi(c.width, c.height);
    // Rutan i videons koordinater — det är den OCR:en får.
    this._roi = {
      x: ux + roi.x * (uw / c.width),
      y: uy + roi.y * (uh / c.height),
      w: roi.w * (uw / c.width),
      h: roi.h * (uh / c.height),
    };

    // Den dämpade ramen kring mittrutan är borta med flit. Den sa "lägg
    // skylten här", och det är precis kravet som togs bort.
    if (this.settings.ritaSikte) this.#ritaSikte(g, c);
  }

  /**
   * Ett OCR-varv. Läser det siktet låst på — inte mitten av bilden.
   *
   * Hittar målsökningen ingenting alls på några sekunder faller den tillbaka
   * på mittrutan. Det är inte en återgång till det gamla kravet: det är den
   * enda gissning som finns kvar när sökningen är tom, och formatvalideringen
   * står kvar bakom den.
   */
  async #steg() {
    if (!this.running || this.arbetar || !this.video.videoWidth) return;

    const last = this.malsokare.last;
    let roi = null, lasId = null, matt = null;
    if (last) {
      lasId = last.id;
      matt = { w: last.w, h: last.h, rw: last.matt?.rw, rh: last.matt?.rh };
      // Kopia, inte spåret självt: sökningen skriver om spåret medan
      // läsningen pågår, och rutan skulle glida ifrån bilden vi beskar.
      roi = { x: last.x, y: last.y, w: last.w, h: last.h };
    } else if (this.settings.centrumFallback && this._roi &&
               Date.now() - this._sistLast > this.settings.fallbackMs) {
      roi = this._roi;
      matt = hittaPlat(this.video, this._roi);
    }
    if (!roi) return;

    this.arbetar = true;
    try {
      // Skyltens storlek styr autozoomen, oavsett om den gick att läsa. En
      // skylt som hittas men är för liten är precis det fall zoomen finns för.
      this.#justeraZoom(matt);

      const { plat, sakerhet } = lasId
        ? await lasKandidat(this.video, roi)
        : await lasRuta(this.video, roi);
      // Ett lås som aldrig ger en giltig skylt ska brinna upp, inte sitta
      // kvar. Rapporten är det som gör det.
      if (lasId) this.malsokare.rapporteraLasning(lasId, !!plat);
      if (plat) await this.#rosta(plat, sakerhet);
    } catch (e) {
      this.#fel(e);
    } finally {
      this.arbetar = false;
    }
  }

  /**
   * Hashar en läsning. Registrets salt när det finns, annars ett salt som
   * bara lever så länge appen är öppen.
   */
  async #hasha(plat) {
    if (this.register) return this.register.hasha(plat);
    if (!this._sessionSalt) return null;
    return hashaPlat(plat, this._sessionSalt);
  }

  /**
   * Rösträkningen. En enda läsning duger inte — motorn är för säker på sina
   * misstag för det. Kräver att samma skylt dyker upp minst två gånger inom
   * tidsfönstret.
   *
   * Räkningen sker på hashen, inte på numret. Numret finns bara som argument
   * till den här funktionen och lämnar den bara om det visar sig vara ditt
   * eget fordon. Är det någon annans slutar det här, i samma bildrutecykel
   * som det lästes.
   */
  async #rosta(plat, sakerhet) {
    const nu = Date.now();

    let h = null;
    try { h = await this.#hasha(plat); } catch {}
    if (!h) {
      /*
       * Utan hashning går det varken att rösta eller att avgöra om skylten är
       * din. Att falla tillbaka på att jämföra nummer i klartext hade byggt
       * tillbaka det som togs bort, så läsaren säger ifrån istället.
       * Inträffar i praktiken bara utanför säker kontext (http mot annat än
       * localhost), där crypto.subtle inte finns.
       */
      this.#status('Den här webbläsaren kan inte jämföra fordon säkert.');
      return;
    }

    /*
     * En "syn" är en sammanhängande period då skylten finns i bild. Skylten
     * visas en gång per syn — inte en gång per läsning, och inte på klocka.
     *
     * Första försöket var en avkylningstid: samma skylt fick inte visas oftare
     * än var tjugonde sekund. Fel fråga. Står man bakom samma bil i en kö dyker
     * den upp igen och igen, bara långsammare. Det som avgör är om skylten
     * faktiskt försvann ur bild emellan.
     *
     * Andra försöket räknade "senast sedd" på varje läsning och jämförde mot
     * den. Också fel, och tystare: eftersom tiden uppdaterades vid varje
     * läsning såg skylten aldrig ut att ha varit borta, och ingenting visades
     * någonsin. Presence och annonsering måste hållas isär.
     */
    /*
     * Gallringen är inte städning, den är själva poängen. Utan den växer
     * `sedd` till en förteckning över varje fordon som passerat sedan appen
     * startade. Att posterna är hashade gör den mindre läsbar, inte mindre
     * till en förteckning.
     */
    for (const [nyckel, s] of this.sedd) {
      if (nu - s.sistSedd > this.settings.franvaroMs) this.sedd.delete(nyckel);
    }

    let syn = this.sedd.get(h);
    if (!syn) {
      syn = { sistSedd: nu, annonserad: false };     // skylten är tillbaka
      this.sedd.set(h, syn);
    }
    syn.sistSedd = nu;

    this.senaste = this.senaste.filter(r => nu - r.t < this.settings.fonsterMs);
    this.senaste.push({ h, t: nu });

    const antal = this.senaste.filter(r => r.h === h).length;
    if (antal < this.settings.krav) {
      // Statusraden sa förut vilken skylt som höll på att bekräftas. Det var
      // en logg över främmande fordon, målad direkt i gränssnittet.
      this._statusLas = nu + 1500;
      this.#status('Bekräftar skylt…');
      return;
    }
    this._statusLas = 0;
    this.#status(this.#lagesText());
    if (syn.annonserad) return;
    syn.annonserad = true;
    this.antalLasta++;

    const traff = this.register ? this.register.slaUppHash(h) : null;
    if (!traff) {
      /*
       * Någon annans fordon. Här slutar det normalt — numret finns bara som
       * argument till den här funktionen och är borta när den returnerat.
       *
       * Provläget ändrar inte på det. Det som skickas är samma nummer som
       * ändå fanns i den här anropsramen, i samma ögonblick som det lästes,
       * och ingenting sparas: inget läggs i `sedd` utöver den gallrade
       * närvaromarkeringen som redan fanns, ingen lista förs, ingen historik
       * byggs. Skillnaden är enbart att den som provkör får se att läsaren
       * faktiskt läser. Se kommentaren vid `provlage` i konstruktorn.
       */
      if (!this.settings.provlage) return;
      this.dispatchEvent(new CustomEvent('traff', {
        detail: { plat, sakerhet, egen: false, provlage: true },
      }));
      return;
    }

    if (this.settings.pip) this.#pip(true);
    this.dispatchEvent(new CustomEvent('traff', {
      detail: {
        plat, sakerhet, egen: true,
        fordonId: traff.id, etikett: traff.etikett, exakt: traff.exakt,
      },
    }));
  }

  #pip(hog) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = hog ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.16);
      o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.18);
      setTimeout(() => ac.close().catch(() => {}), 400);
    } catch {}
  }

  /* Sökningen kör åtta gånger i sekunden. Att skicka samma statustext varje
   * varv hade gett appen åttio händelser i minuten att inte göra något med. */
  #status(text) {
    if (text === this._sisteStatus) return;
    this._sisteStatus = text;
    this.dispatchEvent(new CustomEvent('status', { detail: { text } }));
  }
  #fel(fel) { this.dispatchEvent(new CustomEvent('fel', { detail: { fel } })); }
}
