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
 *   7. Läs flera bildrutor och väg ihop svaren innan något visas.
 *
 * Punkt 7 är det som gör den ärlig. En enstaka gissning är en gissning.
 *
 * ATT HITTA SKYLTEN, INTE BARA LÄSA DEN
 *
 * Länge letade sökningen efter *ljusa avlånga fläckar*. Det var fel fråga.
 * En ljus avlång fläck är lika ofta en skåpbilsdörr, en stötfångarreflex,
 * en dörrkarm eller en solblänk i en sidoruta. Sökningen såg inte en skylt,
 * den såg något som råkade ha ungefär rätt form, och den valde dessutom den
 * *största* av dem — vilket är ungefär det sämsta urvalskriterium som finns,
 * eftersom skylten nästan aldrig är det största ljusa i bilden.
 *
 * En människa gör inte så. En människa ser det blå EU-bandet. Det är det mest
 * distinkta på en svensk skylt: ett mättat blått, stående, smalt band längst
 * till vänster, med vitt eller gult omedelbart till höger om sig. Mättat blått
 * är ovanligt i en gatubild, och mättat blått i ett smalt stående band med
 * ljust intill är i praktiken bara en skylt.
 *
 * Så numera är ordningen:
 *   A. Hitta det blå bandet på kulör och mättnad (inte på råa RGB-trösklar —
 *      en skylt i skugga är fortfarande blå, bara mycket mörkare).
 *   B. Bandets höjd ÄR skyltens höjd. Mät hur långt det ljusa fortsätter åt
 *      höger, och grinda på 4,73:1.
 *   C. Räkna teckenväxlingar i skyltkroppen. Det skiljer en skylt från en
 *      blå bil bredvid en vit panel.
 *   D. Hittas inget blått körs den gamla ljusstapelsökningen precis som förut.
 *      Bandet kan vara smutsigt, avklippt i bildkanten eller bortvänt, och en
 *      sökare som är bättre i snitt men blind i vissa lägen är en försämring.
 *
 * Se docs/malsokning.md.
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

/* ---- Det blå EU-bandet --------------------------------------------------
 *
 * Svensk skylt: 520 × 110 mm, vit eller gul botten, svarta tecken, och längst
 * till vänster ett blått EU-band. Bandet är ungefär 52 mm brett — en tiondel
 * av skyltens bredd — och går hela höjden. Färgen är reflexblå, i tryck
 * ungefär #003399.
 *
 * VARFÖR KULÖR OCH MÄTTNAD, INTE RÅ RGB
 *
 * En rå tröskel av typen "b > 120 och r < 80" fungerar i solsken och bara där.
 * Samma skylt i skugga har kanske RGB 0/18/54 — en åttondel så ljus — och
 * ramlar rakt igenom varje absolut tröskel man sätter. Men den är fortfarande
 * *blå*: förhållandet mellan kanalerna är intakt. Kulör och mättnad är just
 * de två tal som beskriver det förhållandet och struntar i hur mycket ljus som
 * fanns. Därför mäts de, och inte råa nivåer.
 *
 * TALEN, OCH VAD DE KOMMER IFRÅN
 *
 * Kulör räknas bara ut när blå är den största kanalen — vi behöver inte de
 * andra sektorerna av färgcirkeln och kan hoppa över dem gratis.
 *
 *   #003399  → mättnad 1,00, kulör 220°
 *   samma i djup skugga (0/18/54)   → mättnad 1,00, kulör 220°   (oförändrad)
 *   samma urblekt i motljus (90/125/190) → mättnad 0,53, kulör 219°
 *
 * MATTNAD_MIN 0,32 släpper igenom även den urblekta varianten med god marginal
 * och stänger ute grått, asfalt och vita ytor med en blå ton i vitbalansen —
 * de ligger under 0,15.
 *
 * MEN MÄTTNAD ENSAM RÄCKER INTE, OCH DET VAR EN MÄTNING SOM VISADE DET
 *
 * Mättnad är ett förhållande, och förhållanden blir opålitliga när det inte
 * finns mycket ljus att ta förhållandet mellan. En mörk blågrå bilkaross —
 * #1d2733, en fullständigt vardaglig bilfärg — har RGB 29/39/51. Skillnaden
 * mellan största och minsta kanal är futtiga 22 steg av 255, alltså nästan
 * ingen färg alls. Men eftersom hela pixeln är mörk blir mättnaden 22/51 =
 * 0,43, och den seglade rakt igenom en gräns på 0,32.
 *
 * Följden var inte att en bilkaross råkade se ut som ett band. Följden var
 * värre: karossen ligger RUNT skylten, och när den blev "blå" flöt bandet
 * ihop med den till en enda stor klump. Klumpen hade förstås inte ett bands
 * form, så den kastades — och skylten försvann med den. Ankaret fungerade i
 * skugga och i motljus, men inte i normalt ljus, vilket är precis tvärtemot
 * vad man gissar.
 *
 * Rätt regel är två villkor med ELLER emellan, och skälet är att de två
 * sätten en skylt kan bli svår på förstör olika saker:
 *
 *   MÖRKER bevarar förhållandet mellan kanalerna och förstör absolutnivån.
 *   URBLEKNING bevarar absolutnivån och förstör förhållandet.
 *
 * Alltså: släpp igenom en pixel som är MYCKET REN i kulören (mättnad ≥ 0,70,
 * vilket bandet är ända ner i nattmörker) ELLER som har MYCKET FÄRG i absoluta
 * tal (kromaskillnad ≥ 30 av 255, vilket bandet har ända upp i hårt motljus).
 * Att kräva båda hade fällt bandet i båda lägena. Att kräva bara ett av dem
 * hade släppt in bilkarossen.
 *
 *   bandet, rent               mättnad 1,00   kroma 153   → båda
 *   bandet, skugga ×0,16       mättnad 1,00   kroma  25   → renheten
 *   bandet, motljus slöja 0,45 mättnad 0,42   kroma  84   → kromat
 *   blågrå kaross #1d2733      mättnad 0,43   kroma  22   → INGETDERA
 *   asfalt #5a6068             mättnad 0,14   kroma  14   → INGETDERA
 *
 * NYANS 198°–268° är brett med flit. Bandet självt ligger på 220°, men
 * vitbalansen i en telefonkamera flyttar hela bilden flera grader, och en våt
 * eller smutsig skylt drar mot violett. Den nedre gränsen 198° är satt precis
 * ovanför ljus himmelsblå (#87CEEB ligger på 197°), den övre 268° under lila.
 *
 * V_MIN 0,09: under det är pixeln nattsvart och kulören är brus, inte färg.
 * V_MAX 0,98: en utbränd pixel har ingen kulör kvar att mäta.
 *
 * VAD SOM ÄNDÅ SLINKER IGENOM, OCH VARFÖR DET INTE GÖR NÅGOT
 *
 * Klarblå himmel klarar pixeltestet (djup himmel ligger på ~211° och mättnad
 * 0,66). Det är avsiktligt: att strama åt kulören tills himlen faller hade
 * tagit skylten med sig. Himlen faller i stället på formen — den är inte ett
 * smalt stående band — och på att det inte finns vitt med sex mörka pelare
 * omedelbart till höger om den. Samma sak med blå bilar och blå vägmärken.
 * Färgen väljer ut var vi ska titta. Den avgör inte vad vi hittade.
 */
const BLA_MATTNAD_MIN = 0.32;   // golv, alltid
const BLA_MATTNAD_REN = 0.70;   // ...eller så här ren, då räcker det ensamt
const BLA_KROMA_MIN   = 30;     // ...eller så här mycket färg i absoluta tal
const BLA_NYANS_MIN   = 198;
const BLA_NYANS_MAX   = 268;
const BLA_V_MIN       = 0.09;
const BLA_V_MAX       = 0.98;

/** Grindarna samlade, så provet kan skriva ut dem i stället för att upprepa dem. */
export const BLAGRIND = {
  mattnadMin: BLA_MATTNAD_MIN,
  mattnadRen: BLA_MATTNAD_REN,
  kromaMin: BLA_KROMA_MIN,
  nyansMin: BLA_NYANS_MIN,
  nyansMax: BLA_NYANS_MAX,
  vMin: BLA_V_MIN,
  vMax: BLA_V_MAX,
};

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
function skannaLjusa(kalla, omrade, arbetsbredd,
                     { minAndel = 0.12, minPx = 8, bla = false } = {}) {
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
  /*
   * Blåmasken byggs i samma svep som gråskalan. Det är enda stället i modulen
   * där varje pixel ändå läses, och att lägga masken här kostar ett fåtal
   * jämförelser per pixel i stället för en hel extra genomgång av bilden.
   *
   * Uppmätt kostnad för hela ankarvägen, median av 50 körningar mot en
   * 1920 × 1080-bildruta vid arbetsbredd 400: sökningen gick från 4,1 ms till
   * 5,2 ms. Vid 8,3 sökningar i sekunden är det 9 ms extra per sekund, alltså
   * knappt en procent av en kärna. Det är priset för att hitta skylten på
   * färgen i stället för att gissa på ljusstyrka.
   */
  const blaMask = bla ? new Uint8Array(n) : null;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = px[p], g2 = px[p + 1], b2 = px[p + 2];
    gra[i] = (r * 0.299 + g2 * 0.587 + b2 * 0.114) | 0;


    if (!bla) continue;

    // Blå måste vara den största kanalen. Är den inte det är pixeln inte blå,
    // och då behöver vi varken mättnad eller kulör — det är den billigaste
    // avvisningen som finns och den tar merparten av bilden.
    if (b2 <= r || b2 <= g2) continue;
    const mn = r < g2 ? r : g2;
    const delta = b2 - mn;
    if (delta <= 0) continue;
    if (b2 < BLA_V_MIN * 255 || b2 > BLA_V_MAX * 255) continue;
    // Mättnadsgolvet först, sedan renhet ELLER kroma. Se resonemanget ovan:
    // mörker och urblekning förstör var sitt av de två talen, aldrig båda.
    const mattnad = delta / b2;
    if (mattnad < BLA_MATTNAD_MIN) continue;
    if (mattnad < BLA_MATTNAD_REN && delta < BLA_KROMA_MIN) continue;
    // Kulören, men bara den sektor där blå är störst: 240° ± 60°.
    const nyans = 240 + 60 * (r - g2) / delta;
    if (nyans < BLA_NYANS_MIN || nyans > BLA_NYANS_MAX) continue;
    blaMask[i] = 1;
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
  return { b, h, skala, gra, trosk, blobbar, blaMask };
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

/* ---- Plattgrinden --------------------------------------------------------
 *
 * HÅLET SOM DEN TÄPPER TILL: ingenstans i modulen frågades det om fältet var
 * VITT. `skannaLjusa` frågar efter ljust och avlångt, `raknaTeckenbyten`
 * frågar efter kontrast, `poangsattKandidat` frågar efter form och storlek.
 * Ingen av dem skiljer en skylt från en handlarlist med vit text på svart
 * botten — den är också avlång, den har också kontrast, och den ligger en halv
 * skylthöjd under den riktiga skylten. Uppmätt på de 22 provbilderna låste
 * läsaren på en handlarlist, en kromlist eller en blå dekal i 9 av 22 fall.
 *
 * TRE GRINDAR. TVÅ AV DEM KOSTAR INTE EN ENDA PIXELLÄSNING.
 *
 *   1. MÖRKANDELEN — polariteten, tvåsidig.
 *
 *      En svensk skylt är svart text på vitt. Tecknen täcker 28–35 % av ytan
 *      innanför teckenraden, raden är 70 av 110 mm, och den tryckta svarta
 *      ramen tar ett par procent till: 0,64 · 0,32 + 0,05 ≈ 0,25 mörkt.
 *
 *      UPPMÄTT på de 18 av 22 provbilder där sökningen alls hittar den sanna
 *      skylten (grindprov.html, arbetsbredd 400): mörkandelen ligger mellan
 *      0,29 och 0,44, median 0,37. Att den ligger över de teoretiska 0,25 är
 *      väntat — samplingsrutan spänner 1,16 skylthöjder och skrapar därför
 *      alltid lite av hållarramen.
 *
 *      ÖVRE gränsen dödar allt som är LJUST PÅ MÖRKT — handlarlisten, den blå
 *      dekaltexten, den vita skrivstilen på en röd motorhuv. Där ligger
 *      mörkandelen på 0,6–0,9. Det är den gränsen som gör hela nyttan.
 *      NEDRE gränsen dödar det som är NÄSTAN HELVITT och sätts löst; se
 *      PLATTGRIND nedan för varför den inte får dras åt.
 *
 *   2. HORISONTEN — gratis, och det är den som svarar på ägarens "börja inte
 *      läsa vägskyltar". Den STRYKER INGENTING. Den rangordnar.
 *
 *      Ett vägmärke sitter på en stolpe. En skylt sitter på en stötfångare. I
 *      en telefon som står i en hållare hamnar vägmärket i övre halvan av
 *      bildrutan och skylten i den nedre.
 *
 *      LÄGSTA SANNA SKYLTMITT I PROVMAPPEN ÄR 0,3792, INTE 0,390.
 *      Det tidigare talet 0,390 (images.jpg) räknade tyst bort
 *      nya-skyltar-transportstyrelsen.png, som ligger på 0,3792
 *      (facit y 0,117 + h 0,5244/2), med formuleringen "de 21 läsbara".
 *      Den bilden är en skylt och den syns i bildrutan; att OCR-steget inte
 *      får ut text ur den gör inte dess POSITION ogiltig. Med den räknad är
 *      marginalen ned till gränsen 0,32 alltså 0,059 — inte 0,07.
 *      Näst lägsta är images.jpg 0,390 och image.png 0,396.
 *
 *      UNDERLAGET ÄR TUNT OCH DET SKA SÄGAS RAKT UT. 0,059 är marginalen på
 *      ETT stickprov om 22 handlarfoton, alltså närbilder tagna av en
 *      bilhandlare som ville visa bilen — inte bildrutor ur en dashcam som
 *      filmar trafik. En kamera som sitter någon centimeter för högt i
 *      vindrutan, en uppförsbacke eller en hållare som lutar uppåt flyttar
 *      hela bildrutan mer än 0,059. Talet 0,32 går därför inte att lita på
 *      som en gräns — bara som en LUTNING i rangordningen.
 *      Vad som skulle behövas för att lita på det: några hundra bildrutor ur
 *      en riktig dashcam, i den kamerahöjd och den hållarvinkel appen faktiskt
 *      körs i, med skyltmitten uppmätt per bildruta. Då går fördelningen att
 *      rita, och först då går en gräns att sätta. Tills dess: straff, aldrig
 *      strykning.
 *
 *      VAD DEN GÖR I STÄLLET, OCH VARFÖR DET ÄR RELATIVT.
 *      Nyttan sitter inte i "det där uppe är falskt" utan i "det där nere är
 *      bättre". Finns det minst en kandidat UNDER horisonten avbildas
 *      kandidaterna ovanför in i det HÅRDA bandet [0,16; `horisontTak`] — då
 *      rankas HEDIN CERTIFIED (0,065), FORDONSGRUPPEN (0,23), HALLSTEN BIL
 *      (0,245/0,305), VBYBIL (0,25), BILFÖRSÄLJNING (0,30), banderollerna i
 *      3b979c11 (0,29), vägmärket på stolpe i 721ab0d6 (0,335) och
 *      parkeringsförbudet i 0c4d9b68 (0,185) under den riktiga skylten, utan
 *      att en enda pixel lästes. Finns det INGEN kandidat under horisonten är
 *      den där uppe den enda vi har, och då bär den bara den mjuka lutningen
 *      0,7. En bildruta där bara stötfångaren syns, eller där kameran lutar
 *      uppåt, tappar alltså inte sin enda kandidat.
 *      Mellan 0,32 och 0,45 gäller bara den mjuka lutningen 0,7: där uppe
 *      FINNS skyltar, de är bara ovanligare än falska napp.
 *
 *      BÅDA STRAFFEN ÄR AVBILDNINGAR OCH INGET AV DEM ÄR EN MULTIPLIKATION
 *      MED ETT GOLV. En multiplikation kan ta en äkta skylt under låsgränsen,
 *      och ett golv utplånar rangordningen under sig — de två felen mättes och
 *      båda är lagade. Se `horisontstraff` för härledningen av linjen, och
 *      `sokKandidater` för att URVALET är en egen fråga som poängen inte kan
 *      svara på.
 *
 *      DEN ANTAR EN RÄTTVÄND BILDRUTA, OCH DET ANTAGANDET SKRIVS UT.
 *      cyBild är en position längs bildrutans y-axel. Är bildrutan vriden ett
 *      kvarts varv mäter den en position i SIDLED i världen, och regeln mäter
 *      då fel axel. Modulen vet något om detta utan att fråga efter något
 *      nytt: `forvantadVinkel` är lutningsgivarens vinkel, alltså världens
 *      vågräta riktning uttryckt i bildrutans koordinater (se
 *      `Lutningsgivare#matning`, där skärmvinkeln redan räknats bort). Ligger
 *      den nära 0 är bildrutan rättvänd och regeln körs fullt ut; ligger den
 *      nära ±90° står telefonen på högkant i förhållande till världen och
 *      regeln STÄNGS AV hellre än att mäta fel axel; är givaren av eller inte
 *      framme ännu är orienteringen okänd och då är regeln MJUK — bara 0,7,
 *      aldrig det hårda straffet. Se `horisontlage`.
 *
 *   3. BANDETS ANDEL — också gratis, talet är redan uppmätt av ankarvägen.
 *      EU-bandet är 45 mm av 520, alltså 0,087. Är den uppmätta andelen över
 *      0,22 har "bandet" svällt ut i en blå kaross eller en blå dekal och
 *      kroppen bredvid är inte en skylt. Grinden hoppas över under 40 px
 *      skyltlängd i arbetsupplösning — där är bandet 3 px brett och talet är
 *      brus. Utan det undantaget dör image.png, vars band är 6–7 px och
 *      dessutom utblåst av en reflex.
 *
 * VAD SOM BYGGDES, MÄTTES OCH REVS IGEN — sägs ut, döljs inte:
 *
 *   RADPROFILEN, alltså "hitta teckenradens sammanhängande löpa av mörka
 *   rader och kräv att den är 0,45–0,88 av höjden, med högst 0,18 mörkt i
 *   marginalerna ovanför och under". Den var byggd och den mättes, och den
 *   höll inte. På de 19 sanna skyltarna gav den:
 *      höjdandel   0,61 – 1,16   (gränsen skulle ha varit 0,45–0,88)
 *      marginalen  0,00 – 0,72   (gränsen skulle ha varit högst 0,18)
 *   Alltså: den fällde 19 av 19 SANNA skyltar. Hela bänken gick från 8/21
 *   rätt till 0/21. Skälet är fysiskt och inte en justeringsfråga: en svensk
 *   skylt sitter nästan alltid i en MÖRK hållarram, och bakom skylten sitter
 *   en mörk kaross. Marginalen ovanför och under teckenraden är därför inte
 *   vit — den är svart. Och vid de upplösningar det gäller (skylthöjd 10–26 px
 *   i arbetsbilden) flyter ram, tecken och kaross ihop till en enda löpa som
 *   täcker hela rutan.
 *
 *   Marginalkorrigeringen — att kapa rutans höjd till löpans höjd delat med
 *   0,64 — föll med den, eftersom den byggde på samma löpa. Den skulle ha
 *   räddat handlarlisten under plåten i 2039174f, 0c4d9b68 och YBK70UD, och
 *   det problemet står alltså kvar olöst. Låt det stå olöst hellre än att
 *   lösa det med ett mått som mätningen underkände.
 *
 *   RUNDHET OCH RÖD RING, alltså den direkta vägmärkesdetektorn. Den kräver
 *   en ny färgmask i pixelsvepet och räddar NOLL av de 22 bilderna — ingen av
 *   dem innehåller ett vägmärke med röd ring. Ett tal går inte att fylla i
 *   utan att mäta det, och det går inte att mäta här. Horisontregeln tar
 *   vägmärkena gratis under tiden. Bygg rundheten när det finns dashcam-
 *   material med riktiga vägmärken att mäta emot.
 */

/** Grindens tal samlade, så provet kan skriva ut dem i stället för att upprepa dem. */
export const PLATTGRIND = {
  /*
   * DE TVÅ GRÄNSERNA GÖR OLIKA JOBB OCH ÄR SATTA PÅ OLIKA GRUNDER.
   *
   * ÖVRE, 0,56 — den som gör nyttan. Uppmätt mörkandel på de 18 sanna
   * skyltar sökningen hittar i provmappen: 0,29–0,44, median 0,37. Allt som
   * är LJUST PÅ MÖRKT ligger på 0,6–0,9: handlarlisten, den blå dekaltexten,
   * den vita skrivstiften på en röd motorhuv. 0,56 ligger tolv
   * procentenheter över den ljusaste sanna skylten och en bra bit under den
   * mörkaste falska. Det är den här raden som gav +2 rätt lås och +2 rätt
   * text i bänken.
   *
   * NEDRE, 0,12 — den som nästan inget gör, och som därför sätts LÖST.
   * Frestelsen är att sätta den strax under det uppmätta 0,29. Det gjordes,
   * på 0,20, och det gick sönder: sok-test.html-fallet "blått band avklippt
   * i bildkanten" mäter 0,19 och slutade hittas (51 godkända → 50). Den
   * syntetiska provskylten har tunnare tecken än en verklig plåt, och det är
   * inte fel på provet — en urblekt, smutsig eller långt bort sedd skylt har
   * också tunna tecken.
   *
   * Räkna på det i stället för att mäta på arton foton: sex tecken med tunna
   * streck täcker omkring 28 % av teckenradens yta, och raden är 70 av 110
   * mm. 0,64 · 0,28 ≈ 0,18 är alltså den fysiska botten för en skylt utan
   * tryckt ram. 0,12 ligger under den. Vad kostar det? Ingenting mätbart: på
   * provmappens 22 foton är utfallet bit för bit identiskt vid 0,12 och 0,20
   * (10/21 rätt, 15/22 lås, 0 falska läsningar i båda). Det som ska filtreras
   * bort i den änden — släta vita ytor utan tecken — fastnar redan på
   * kontrastMin och på `tecken`-faktorn i poangsattKandidat.
   *
   * OCKSÅ PRÖVAT OCH FÖRKASTAT: 0,24. Tanken var att stänga ute det falska
   * ankaret i polestar-4-madrid-gold, som mäter exakt 0,20. Utfall: bit för
   * bit samma bänk. Kandidaten vann inte på den marginalen ändå.
   */
  morkandelMin: 0.12,
  morkandelMax: 0.56,
  kontrastMin: 30,      // under det är ytan slät och andelen är brus

  /*
   * HORISONTEN. Fyra tal, och INGET av dem stryker en kandidat.
   *
   * `horisont` 0,32 — över den här höjden i bildrutan (räknat uppifrån, alltså
   * mindre tal = högre upp) ligger vägmärken, handlarlistar och banderoller.
   * Lägsta SANNA skyltmitt i provmappens 22 foton är 0,3792; marginalen är
   * alltså 0,059 och underlaget är ett stickprov handlarnärbilder. Se det
   * långa stycket ovan för varför det talet inte duger som klippkant.
   *
   * `horisontMjuk` 0,45 — var mellanzonen börjar. Allt ovanför 0,45 bär det
   * mjuka straffet, oavsett vad resten av bildrutan innehåller.
   *
   * DE TVÅ STRAFFEN ÄR AVBILDNINGAR, INTE MULTIPLIKATIONER MED ETT GOLV.
   * Se `horisontstraff` för härledningen; det som ska stå här är vad de två
   * talen BETYDER, och de betyder inte samma sak längre.
   *
   * `horisontStraff` 0,7 — MJUKA bandets LUTNING. Samma 0,7 som förut och
   * samma rangordning som förut: kvoten mellan två straffade kandidaters
   * avstånd till låsgränsen är oförändrad. Det enda som ändrats är att linjen
   * går genom punkten (låsgränsen, låsgränsen) i stället för genom origo, så
   * att en kandidat som låg över låsgränsen aldrig kan hamna under den.
   *
   * `horisontTak` 0,228 — HÅRDA bandets TAK, alltså den högsta poäng en
   * kandidat ovanför horisonten kan ha kvar när det finns en kandidat under
   * horisonten att förlora mot. Golvet är låsgränsen MALSOK.minPoang 0,16, så
   * bandet är [0,16; 0,228] och lutningen faller ut ur de två ändarna —
   * den sätts inte för hand.
   *
   * HÄRLETT UR BÄNKENS EGNA POÄNG, inte valt på känsla. Mätt i
   * prov/skyltar/horisont.html: 22 foton, arbetsbredd 400, horisontläge
   * 'full'. Poängen nedan är · 100 och är RÅA, alltså före varje straff.
   *
   *   Tolv av de 22 bildrutorna innehåller BÅDE en sann skylt under
   *   horisonten och minst en kandidat ovanför den. I dem:
   *     starkaste kandidat ovanför:  7,6 · 21,1 · 18,6 · 3,9 · 11,4 · 118,8
   *                                  49,0 · 46,3 · 2,1 · 10,0 · 16,2 · 18,5
   *     bästa sanna skylten under:  29,6 · 37,0 · 53,1 · 89,6 · 131,1 · 132,2
   *                                 43,0 · 44,2 · 94,0 · 101,8 · 54,5 · 55,3
   *
   *   TAKET ÄR MITTPUNKTEN MELLAN LÅSGRÄNSEN OCH DEN SVAGASTE SANNA SKYLTEN.
   *   Svagaste sanna skylt som alls går att låsa på i en bildruta med en
   *   straffad kandidat i: 29,6 (YBK70UD). Låsgränsen är 16. Mitt emellan:
   *   16 + (29,6 − 16)/2 = 22,8. Under taket ligger alltså varje straffad
   *   kandidat under varje sann skylt i bänken, med en halv bänkbredd över.
   *
   *   VARFÖR INTE HÖGRE: vid 29,6 tar den starkaste straffade kandidaten
   *   ikapp den svagaste sanna skylten och rangordningen slutar betyda något.
   *   VARFÖR INTE LÄGRE: golvet är låsgränsen och den kan inte flyttas — en
   *   sänkning under den är en strykning med ett annat namn. Ett lägre tak
   *   köper därför bara en bråkdel av en procent i marginal och betalar med
   *   ett smalare band att rangordna i. Uppmätt på bänken: sämsta marginalen i
   *   en enskild bildruta är 2,285 gånger med taket 22,8
   *   (polestar-4-madrid-gold: 37,0 mot 16,2) och 2,313 gånger med ett tak som
   *   ligger på själva låsgränsen. Det är GOLVET som binder, inte taket, och
   *   skillnaden mellan dem är 1,2 %.
   *
   *   VAD OMSKRIVNINGEN GAV, MÄTT PÅ prov/skyltar/granskning.html (8
   *   förvrängningar × 22 foton = 174 bildrutor, arbetsbredd 400,
   *   skärmvinkel 90). Tre kolumner: före avbildningen → efter avbildningen
   *   med EN reserverad plats → efter `horisontReserv` 2. Lås ≥ 0,50 IoU och
   *   topp1:
   *     oförvrängd 16/15 → 16/15 → 16/15 · natt 21/20 → 21/20 → 21/20 ·
   *     regn 18/18 → 18/18 → 18/18 · smuts 9/7 → 9/7 → 9/7 ·
   *     högt 16/12 → 16/13 → 17/13 · vriden 90° 17/13 → 16/14 → 16/14 ·
   *     avstånd 3/3 → 3/3 → 3/3 · stötfångare 14/12 → 15/13 → 15/13
   *     SUMMA lås 114 → 114 → 115, topp1 100 → 103 → 103.
   *   Ett lås byttes alltså mot ett annat och tre bildrutor fick rätt
   *   toppkandidat. DET FÖRLORADE SKA NAMNGES: vriden 90°, 2039174f.avif. Där
   *   ligger en kandidat ovanför horisonten med rå poäng 0,168 — precis över
   *   låsgränsen — och den får därför inte längre tryckas ned till 0,030 utan
   *   landar på 0,160. Den tar sjätte platsen i listan från den äkta skylten,
   *   som i den bildrutan har 0,154 och alltså inte kunde ha låst ändå. Att
   *   den bildrutan är just den vridna är ingen slump: där matar bänken med
   *   flit regeln med fel axel (se `horisontlage`), och kostnaden för det
   *   antagandet är dokumenterad sedan tidigare.
   *
   *   OCH STRAFFET ÄR INTE BARA MARGINAL, DET ÄR RÄTTAT. Här stod förut att
   *   den sanna skylten låg överst redan utan straff i alla tolv bildrutorna,
   *   sämsta kvot 1,26. Det talet var mätt med det MJUKA straffet 0,7 kvar i
   *   poängen, alltså inte utan straff utan med halva. Mätt på verkligt råa
   *   poäng vinner den sanna skylten i TIO av tolv: i 521e24d0.avif ligger
   *   den falska dekaltexten på 49,0 mot skyltens 43,0, och i Regpl-Heden.jpg
   *   den vita skrivstilen på 46,3 mot 44,2. I de två bildrutorna är straffet
   *   det som gör låset rätt, inte bara det som gör det säkrare.
   *
   * `horisontReserv` 2 — hur många RESERVERADE PLATSER en straffad kandidat
   * får ta i den korta listan, och hur många ett straffat SPÅR får ta i
   * `Malsokare`. Talet är mätt, inte valt.
   *
   *   Mätningen: prov/skyltar/reserv.html, samma 22 foton × 8 förvrängningar
   *   och samma skärmvinkel 90 som granskning.html, alltså 174 bildrutor. I
   *   116 av dem hittar sökningen alls den sanna skylten (max 50). Frågan är i
   *   hur många av de 116 den finns kvar i APPENS lista, den på max 6:
   *
   *     0 reserverade platser (rakt `slice`)   113/116
   *     1 reserverad plats                     114/116
   *     2 reserverade platser                  115/116
   *     3 reserverade platser                  115/116
   *
   *   VARFÖR INTE EN: den enda bildruta där EN plats inte räcker är
   *   hogt/Regpl-Heden.jpg. Där klarar fyra straffade kandidater båda
   *   villkoren utanför snittet, och den enda platsen går till fel av dem: den
   *   sanna skylten ligger på rå 0,4288 och lockbetet på 0,4352 — 1,5 % isär.
   *   Med två platser kommer båda in och skylten är räddad.
   *
   *   VARFÖR INTE TRE: mätt, och den tredje platsen räddar ingen bildruta alls
   *   (115 → 115). Den räddar ingen och kostar ingen i det här svepet — men en
   *   plats som aldrig gör nytta ska inte finnas, för varje reserverad plats
   *   är en ostraffad kandidat mindre i en lista på sex. Två straffade av sex
   *   är en tredjedel av listan; tre är hälften, och det är att låta
   *   horisontregeln bestämma vad appen tittar på i stället för att bara
   *   rangordna det.
   *
   *   DEN SISTA BILDRUTAN GÅR INTE ATT RÄDDA MED FLER PLATSER: i
   *   vriden90/2039174f.avif finns den sanna skylten inte bland de straffade
   *   sökandena alls, så ingen mängd reserv når den. (Den bildrutan matar
   *   bänken med flit regeln med fel axel — se `horisontlage`.)
   *
   * `horisontLutningMax` — hur mycket bildrutan får luta innan regeln stängs
   * av. `forvantadVinkel` viker till (-90, 90]; 30° är den punkt där en
   * position i höjdled fortfarande till 87 % (cos 30°) är en position i
   * höjdled i världen. Över det mäter regeln alltmer fel axel, och då är den
   * hellre av. Är vinkeln okänd (givaren av, eller inte framme ännu) är regeln
   * mjuk: bara `horisontStraff`, aldrig det hårda bandet.
   */
  horisont: 0.32,
  horisontMjuk: 0.45,
  horisontStraff: 0.7,
  horisontTak: 0.228,
  horisontReserv: 2,
  horisontLutningMax: 30,
  euMin: 0.03,          // 45/520 = 0,087
  euMax: 0.22,
  euMinLangd: 40,       // under det är bandet 3 px och andelen är brus
  minLangd: 24,         // samma golv som `tecken`-faktorn i poangsattKandidat
  osakerFaktor: 0.85,   // för liten för att mätas: varken ja eller nej
};

/**
 * Den högsta poäng `poangsattKandidat` kan ge, räknad ur funktionen och inte
 * uppmätt: form ≤ 1, storlekstermen ≤ 1, centrum ≤ 1, tecken ≤ 1, rakhet ≤ 1
 * och prior ≤ 1. Det enda som får gå över 1 är `ankarfaktor`, vars största
 * gren är 1,8. Alltså 1,8.
 *
 * Talet används av `horisontstraff` som avbildningens övre ände. Ändras
 * `ankarfaktor` måste det här talet ändras med, annars kan en straffad
 * kandidat gå över sitt tak.
 *
 * DET UPPMÄTTA TALET, OMMÄTT. Här stod förut "bänkens största uppmätta poäng
 * är 1,352 (d54eac78.png)". Det talet är inte den största poängen utan den
 * största SANNA SKYLTENS poäng i horisont.html (135,2 · 100 i den tabellen) —
 * två olika frågor, och den här kommentaren ställde fel. Ommätt över ALLA
 * kandidater i prov/skyltar/reserv.html, samma 174 bildrutor som
 * granskning.html kör, är den största poängen 1,5816 (natt/2560.webp) och
 * bland de 22 oförvrängda fotona 1,4573 (nya-skyltar-transportstyrelsen.png).
 * 1,8 är alltså fortfarande ett räknat tak med luft och inte ett mätt — men
 * luften är 14 %, inte 33 %.
 */
export const POANG_TAK = 1.8;

/**
 * Horisontstraffet, som en AVBILDNING av poängen — ett enda steg, och det är
 * hela poängen med funktionen.
 *
 * VARFÖR INTE EN MULTIPLIKATION MED ETT GOLV. Så såg det ut förut, och tre
 * fel följde ur formen i sig och inte ur talen:
 *
 *   1. Det mjuka straffet låg i `granskaSkyltruta` och gick in i poängen via
 *      `prior`. Golvet längre ner jämförde alltså mot ett REDAN SÄNKT tal och
 *      såg inte hela sänkningen. Rå poäng i [0,16; 0,2286) hamnade på
 *      0,028–0,040, alltså under låsgränsen, med golvet påslaget. Uppmätt: 4
 *      av 104 syntetiska bildrutor med äkta svensk skylt, och på riktigt foto
 *      521e24d0.avif flyttad till skyltmitt 0,28 (0,0283, plats 9).
 *   2. Ett golv är inte monotont. Allt under golvet klistrades ihop till
 *      EXAKT samma tal: över ett fyra gånger brett band av rå poäng
 *      ([0,2286; 0,9143)) fick varje straffad kandidat 0,160, och
 *      rangordningen — som var hela skälet att straffa i stället för att
 *      stryka — var utraderad just där. 68 av 104 bildrutor i ett dashcam-likt
 *      svep.
 *   3. Vid golvkanten hoppade utfallet fyrfaldigt på en tusendel: 0,2285 gav
 *      0,040 och 0,2286 gav 0,160.
 *
 * HÄRLEDNINGEN. Tre krav ska hållas samtidigt:
 *
 *   (a) SÄNK REJÄLT — en kandidat ovanför horisonten ska rankas under en sann
 *       skylt under den.
 *   (b) HAMNA ALDRIG UNDER LÅSGRÄNSEN — en sänkning som får passera
 *       `MALSOK.minPoang` är en strykning med ett annat namn, och strykningen
 *       är precis det som mättes bort (15/20 lås → 1/20, 17/22 → 0/22).
 *   (c) BEVARA ORDNINGEN — är A starkare än B före straffet ska A vara
 *       starkare än B efter.
 *
 * Sök en avbildning T på poängen. (c) säger att T är strängt växande. (b)
 * säger att T(R) ≥ g för alla R ≥ g, där g = MALSOK.minPoang. Att straffet
 * aldrig får LYFTA något säger T(R) ≤ R. Den enklaste funktionen som
 * uppfyller alla tre är en RÄT LINJE genom fixpunkten (g, g):
 *
 *      T(R) = g + k · (R − g)          med 0 < k < 1,  för R ≥ g
 *
 * Skriv om den och den blir den gamla multiplikationen plus ett lyft:
 *
 *      T(R) = k · R + g · (1 − k)
 *
 * Alltså: SAMMA LUTNING som förut, men linjen är skjuten uppåt exakt så
 * mycket att den skär genom låsgränsen i stället för genom origo. Det är
 * skillnaden mellan ett golv och det här: golvet klipper linjen, lyftet
 * lutar den. Bilden av [g; POANG_TAK] blir bandet [g; g + k(POANG_TAK − g)],
 * och där inne är ordningen exakt den råa ordningen.
 *
 * UNDER LÅSGRÄNSEN GÄLLER DEN RENA MULTIPLIKATIONEN, T(R) = k · R, OCH
 * SKARVEN DÄR ÄR ETT HOPP SOM INTE GÅR ATT UNDVIKA. Det ska sägas rakt ut,
 * med beviset:
 *
 *   Krav (b) tvingar T(g) = g — T(g) ≥ g från (b) och T(g) ≤ g från "lyfter
 *   aldrig". Vore T dessutom KONTINUERLIG i g måste T(R) → g underifrån, och
 *   eftersom T(R) ≤ R < g där blir T(R) = R strax under g: alltså INGET
 *   straff alls just under låsgränsen. De fyra kraven "T(g) = g",
 *   "kontinuerlig", "lyfter aldrig" och "sänk även under låsgränsen" kan inte
 *   hållas samtidigt. Ett av dem måste släppas.
 *
 *   Det mättes vilket. Med T(R) = R under låsgränsen slutade vägmärken och
 *   husfasader med rå poäng 0,12–0,15 att sänkas alls, och de fyllde
 *   kandidatlistan: på granskningsbänken föll smuts från 9 lås till 8 och
 *   vriden 90° från 17 till 16, båda genom att en svag men ÄKTA skylt trängdes
 *   ur `slice(0, 6)` av fyra ostraffade fasadbitar (uppmätt i 521e24d0.avif
 *   med smuts: rå 0,123 · 0,133 · 0,138 · 0,147, förut 0,022–0,026).
 *
 *   Alltså släpps kontinuiteten, och hoppet läggs där det betyder något:
 *   EXAKT PÅ LÅSGRÄNSEN. Under den kan ingen kandidat låsas hur som helst, så
 *   där finns inget att missa; över den skyddar lyftet varje kandidat som
 *   kunde ha låst. Hoppet är inte ett trappsteg i fel C:s mening — inget
 *   klistras ihop, avbildningen är strängt växande genom hoppet
 *   (k·g < g = T(g)) och det finns ingen platt zon i [0; POANG_TAK].
 *   Skillnaden mot det golv som revs: golvet la sitt hopp mitt inne i det
 *   låsbara spannet (0,2285 → 0,040 och 0,2286 → 0,160) och la en platt zon
 *   ovanför det.
 *
 *   FÖRBEHÅLLET, OCH DET SKA STÅ HÄR OCH INTE BARA VID KLÄMMAN: "strängt
 *   växande, ingen platt zon" gäller [0; POANG_TAK] och ingenting däröver.
 *   `Math.min(poang, POANG_TAK)` gör T konstant för varje R > POANG_TAK, i
 *   båda banden — en riktig platt zon, utan övre ände. Mätt i ett jämnt svep
 *   över [0; 2,4] med 240 000 steg: 60 000 platta steg per band, alla ovanför
 *   1,8 (första platta steget vid R = 1,80001 — steglängden är 1e−5 och 1,8
 *   träffas exakt på steg 180 000, så steg 180 001…240 000 är platta). Det
 *   stod 59 999 och 1,80002 här; den slingan började ett steg för sent.
 *   Ingenting i sak ändras av det, men ett mätt tal i en kommentar som är fel
 *   är samma sorts fel som en gång gav hela den här regeln fel gräns. Zonen
 *   är onåbar i dag, och det
 *   är därför klämman kostar noll: `poangsattKandidat` kan per konstruktion
 *   inte ge mer än exakt POANG_TAK (se talets härledning) och bänkens största
 *   uppmätta poäng är 1,5816 över hela 174-svepet, 1,4573 oförvrängt. Får
 *   någon faktor en dag ett större tak flyttas den platta zonen in i det
 *   nåbara spannet, och då är det POANG_TAK som ska ändras — inte klämman som
 *   ska tas bort, för utan den kan en straffad kandidat gå över sitt band.
 *
 * DE TVÅ LUTNINGARNA — en enda konstant per band, samma över och under
 * låsgränsen:
 *
 *   MJUKA, k = PLATTGRIND.horisontStraff = 0,7. Oförändrat tal, oförändrad
 *   rangordning; bara formen är lagad.
 *
 *   HÅRDA, k = (horisontTak − g) / (POANG_TAK − g). Den sätts inte för hand.
 *   Bandet är [g; horisontTak] = [0,16; 0,228] och definitionsmängden är
 *   [g; POANG_TAK] = [0,16; 1,8], så lutningen faller ut ur ändarna:
 *   (0,228 − 0,16)/(1,8 − 0,16) = 0,0415. Se `PLATTGRIND.horisontTak` för var
 *   0,228 kommer ifrån.
 *
 * @param {number} poang   kandidatens poäng före straffet
 * @param {boolean} hart   true = hårda bandet, false = mjuka lutningen
 * @returns {number} poängen efter straffet
 */
export function horisontstraff(poang, hart) {
  const g = MALSOK.minPoang;
  const k = hart
    ? (PLATTGRIND.horisontTak - g) / (POANG_TAK - g)
    : PLATTGRIND.horisontStraff;
  // Klämman mot POANG_TAK håller taket även om någon faktor en dag får ett
  // större tak än det som räknats fram ovan. Priset är att avbildningen är
  // PLATT för varje R > POANG_TAK — där, och bara där, gäller inte "strängt
  // växande". Zonen är onåbar med dagens faktorer (`poangsattKandidat` kan
  // inte ge mer än POANG_TAK), så klämman kostar ingenting i dag. Se
  // förbehållet i rubriken.
  const p = Math.min(poang, POANG_TAK);
  return poang >= g ? k * p + g * (1 - k) : k * p;
}

/**
 * Hur hårt horisontregeln får gälla i den här bildrutan.
 *
 * RÄTTVÄND BILDRUTA ÄR ETT ANTAGANDE, OCH DET SKA INTE GÖRAS TYST.
 * `cyBild` är en position längs bildrutans y-axel. Regeln bygger på att den
 * axeln pekar mot marken. Vrids bildrutan ett kvarts varv — telefonen på
 * högkant i en hållare byggd för liggande, eller en bänk vriden 90° — mäter
 * `cyBild` i stället en position i sidled, och regeln är då inte mjukt fel
 * utan helt fel: den skulle straffa allt i ena halvan av vägbanan.
 *
 * Modulen behöver inget nytt för att veta det här. `forvantadVinkel` är
 * lutningsgivarens vinkel, alltså världens vågräta riktning uttryckt i
 * bildrutans koordinater, med skärmvinkeln redan borträknad (se
 * `Lutningsgivare#matning`). Den viker till (-90, 90].
 *
 *   nära 0    bildrutan är rättvänd      → 'full', hårda straffet får läggas på
 *   nära ±90  bildrutan ligger på sidan  → 'av', hellre ingen regel än fel axel
 *
 * ANDRAHANDSKÄLLAN, NÄR GIVAREN ÄR AV: `screen.orientation.angle`. Den kostar
 * ingenting och kräver inget tillstånd, men den är ett ANTAGANDE och inte en
 * mätning — den säger hur SKÄRMEN står, inte hur bildrutan levereras, och det
 * går inte att avgöra härifrån vilket av de två webbläsaren väljer. Appen är
 * byggd för en telefon som ligger i en hållare (liggande, skärmvinkel 90 eller
 * 270); står telefonen på högkant är hållarläget inte det modulen räknar med
 * och regeln stängs AV i stället för att gissa vilken axel `cyBild` mäter.
 * Det kostar rangordningen i stående läge — vägmärken rankas då inte ned — men
 * det kan aldrig kosta ett missat lås, och det är rätt håll att fela åt.
 *
 * OCH DEN SKÄRPER, DEN STÄNGER INTE BARA AV. Det ska stå rakt ut, för det
 * stod länge fel på anropsstället: skärmvinkel 90 eller 270 ger 'full' när
 * `forvantadVinkel` är null, alltså en SKÄRPNING från grundvärdet 'mjuk', och
 * det är just den vägen det hårda bandet slås på i en telefon utan
 * rörelsetillstånd. Antagandet bär den skärpningen med vett: en telefon i
 * hållare rapporterar 90 eller 270, och det är det läget modulen är byggd för.
 *
 * VET VI INGET ALLS är regeln 'mjuk': bara lutningen 0,7 och aldrig det hårda
 * bandet. Det är också vad varje anropare som inte skickar in något får, till
 * exempel `hittaPlat` och provbänkarna. Den som inte vet får inte döma hårt.
 * Den grenen är nåbar även från `PlateReader`: `Lutningsgivare#skarmvinkel`
 * svarar null när `screen.orientation` saknas, inte 0. Förut svarade den 0,
 * alltså "stående", och grenen var i praktiken död.
 *
 * @param {object} [opt]
 *        forvantadVinkel  lutningsgivarens vinkel i grader, null = okänd
 *        skarmvinkel      screen.orientation.angle, null = okänd
 * @returns {'full'|'mjuk'|'av'}
 */
function horisontlage({ forvantadVinkel = null, skarmvinkel = null } = {}) {
  if (Number.isFinite(forvantadVinkel)) {
    return Math.abs(forvantadVinkel) <= PLATTGRIND.horisontLutningMax ? 'full' : 'av';
  }
  if (Number.isFinite(skarmvinkel)) {
    const v = ((skarmvinkel % 360) + 360) % 360;
    return (v === 90 || v === 270) ? 'full' : 'av';
  }
  return 'mjuk';
}

/**
 * Samplar en kandidat längs dess EGNA axlar och mäter hur stor del av ytan
 * som är mörk.
 *
 * Läser inte om bilden. Den samplar den gråskalebuffert `skannaLjusa` redan
 * byggt, med samma roterade `prov(u,v)` som `raknaTeckenbytenVriden` och
 * `matSkyltFranBand` använder. Rutnätet är högst 28 × 48 = 1 344 sampel, och
 * varje sampel är två multiplikationer och en läsning ur en buffert som redan
 * ligger i cache.
 *
 * Låg- och högnivån tas som 5:e och 95:e percentilen ur rutans EGNA sampel,
 * inte som min och max och aldrig som den globala Otsu-tröskeln. Min/max hade
 * gjort en enda solreflex till hela högnivån, och då hamnar tröskeln så högt
 * att halva den vita plattan räknas som mörk — alltså en äkta skylt dödad av
 * en glans. Den globala tröskeln hade dödat images.jpg, vars tecken är
 * gråaktiga i motljus.
 *
 * @returns {object|null} mätningen, eller null om rutan mest ligger utanför bilden
 */
function matPlatta(gra, b, h, ruta, bandAndel = 0) {
  const { cx, cy, L, W, vinkel } = ruta;
  if (!(L > 0) || !(W > 0)) return null;
  const rad = vinkel * Math.PI / 180;
  const kos = Math.cos(rad), sin = Math.sin(rad);

  // Rader: en per pixel i höjdled, men aldrig färre än 10 (annars är profilen
  // för grov) och aldrig fler än 28 (över det tillför de ingenting utom tid).
  const R = Math.max(10, Math.min(28, Math.round(W)));
  // Kolumner: en varannan pixel i längdled. Tecknen är breda; att sampla
  // tätare än så mäter samma pelare två gånger.
  const K = Math.max(16, Math.min(48, Math.round(L / 2)));

  // u-fönstret börjar där EU-bandet slutar plus två procent luft. Ankarvägen
  // vet bandets uppmätta andel; ljusstapeln har inget band i sin blobb (det
  // blå är inte ljust och kom aldrig med) och skickar 0. Slutar vid 0,48 för
  // att inte skrapa mot ytterramen.
  const u0 = (-0.5 + Math.min(0.25, bandAndel) + 0.02) * L;
  const u1 = 0.48 * L;
  if (u1 <= u0) return null;

  const varden = new Int16Array(R * K);
  const hist = new Uint16Array(64);          // 4 gråsteg per fack
  let n = 0;
  for (let j = 0; j < R; j++) {
    // v spänner 1,16 · W, alltså 8 % utanför kanten åt vardera hållet. Det
    // överskottet är med för att en skylt som mätts några procent för snävt
    // inte ska få sin egen ytterkant räknad som bakgrund.
    const v = (-0.58 + 1.16 * (j + 0.5) / R) * W;
    const bx = cx - v * sin, by = cy + v * kos;
    for (let i = 0; i < K; i++) {
      const u = u0 + (u1 - u0) * (i + 0.5) / K;
      const x = Math.round(bx + u * kos);
      const y = Math.round(by + u * sin);
      let g = -1;
      if (x >= 0 && x < b && y >= 0 && y < h) { g = gra[y * b + x]; hist[g >> 2]++; n++; }
      varden[j * K + i] = g;
    }
  }
  if (n < R * K * 0.5) return null;          // rutan hänger mest utanför bilden

  let ack = 0, lag = 0, hog = 255;
  const p5 = n * 0.05, p95 = n * 0.95;
  for (let k = 0; k < 64; k++) { ack += hist[k]; if (ack >= p5) { lag = k * 4 + 2; break; } }
  ack = 0;
  for (let k = 0; k < 64; k++) { ack += hist[k]; if (ack >= p95) { hog = k * 4 + 2; break; } }
  const kontrast = hog - lag;
  const trosk = lag + kontrast * 0.55;

  let morka = 0;
  for (let i = 0; i < R * K; i++) {
    const g = varden[i];
    if (g >= 0 && g < trosk) morka++;
  }
  return { morkandel: morka / n, kontrast, sampel: n };
}

/**
 * Grinden, som den anropas från sökningen.
 *
 * @param {Uint8ClampedArray} gra   gråskalan från `skannaLjusa`
 * @param {number} b @param {number} h   arbetsbildens mått
 * @param {{cx,cy,L,W,vinkel}} ruta      kandidaten längs sina egna axlar
 * @param {object} [opt]
 *        bandAndel  uppmätt EU-band i andel av skyltlängden, 0 = okänt
 *        cyBild     kandidatens mitt i andel av KÄLLBILDENS höjd, null = okänt
 *        lage       'full' | 'mjuk' | 'av' — se `horisontlage`
 * @returns {{ok:boolean, faktor:number, skal:string|null, matt:object|null,
 *            mjukZon:boolean, overHorisont:boolean, cyBild:number|null}}
 */
function granskaSkyltruta(gra, b, h, ruta,
                          { bandAndel = 0, cyBild = null, lage = 'mjuk' } = {}) {
  const svar = { ok: true, faktor: 1, skal: null, matt: null,
                 mjukZon: false, overHorisont: false, cyBild };

  /*
   * Horisonten först — den kostar inte en enda pixelläsning.
   *
   * HÄR STRYKS INGET, OCH DET ÄR EN ÄNDRING MOT FÖRSTA VERSIONEN.
   * Förut satte `cyBild < horisont` svar.ok = false, och i `sokKandidater`
   * blev det `continue`: kandidaten upphörde att finnas, utan spår, utan
   * läsning och utan förklaring till användaren. Mätt på bänken kostade det
   * allt precis utanför den bänkens egen ram — en bildruta kapad strax ovanför
   * skylten gick från 15/20 lås till 1/20, och en bänk flyttad till skyltmitt
   * 0,28 (kameran lutad uppåt) från 17/22 till 0/22.
   *
   * HÄR SÄNKS INGET HELLER, OCH DET ÄR ÄNDRINGEN MOT ANDRA VERSIONEN.
   * Förut multiplicerades det mjuka straffet 0,7 in i `faktor` här, gick
   * vidare via `prior` in i poängen, och det hårda straffet lades på längst
   * ned i `sokKandidater`. Två steg alltså — och det andra steget kunde
   * därmed aldrig se hur mycket det första redan hade tagit. Golvet i steg
   * två jämförde mot ett halvsänkt tal och missade fyra av 104 bildrutor med
   * äkta skylt. Se `horisontstraff`.
   *
   * Nu lämnas bara TVÅ FLAGGOR ut och hela sänkningen sker i ett enda steg
   * hos anroparen, som är den ende som kan ställa frågan rätt: `overHorisont`
   * ska bara bli det hårda bandet om det finns någon UNDER horisonten att
   * förlora mot, och det vet först `sokKandidater` när alla kandidater är
   * insamlade.
   */
  if (cyBild != null && lage !== 'av') {
    if (cyBild < PLATTGRIND.horisontMjuk) svar.mjukZon = true;
    if (cyBild < PLATTGRIND.horisont && lage === 'full') {
      svar.overHorisont = true;
    }
  }

  // Bandets andel, men bara när bandet är stort nog att mätas.
  if (bandAndel && ruta.L >= PLATTGRIND.euMinLangd &&
      (bandAndel < PLATTGRIND.euMin || bandAndel > PLATTGRIND.euMax)) {
    svar.ok = false; svar.skal = 'bandet har fel andel'; return svar;
  }

  // Under 24 px svarar polariteten varken ja eller nej — annars hade varje
  // skylt på håll dömts ut, och det är en tyst regression som bara syns i
  // drift och aldrig i en bänk med närbilder.
  if (ruta.L < PLATTGRIND.minLangd) {
    svar.faktor *= PLATTGRIND.osakerFaktor; return svar;
  }

  const p = matPlatta(gra, b, h, ruta, bandAndel);
  svar.matt = p;
  /*
   * GÅR DEN INTE ATT MÄTA SKA DEN INTE DÖMAS. `matPlatta` ger null när mer än
   * halva rutan hänger utanför bildrutan, och det är inte ett tecken på att
   * kandidaten är falsk — det är en skylt i bildkanten.
   *
   * Det här är ingen teoretisk risk. Första versionen avvisade i det läget,
   * och sok-test.html gick från 51 godkända till 50: fallet "blått band
   * avklippt i bildkanten" slutade hittas. En bil som just kör in i bild ska
   * gå att låsa på, det är hela vitsen med att låsa tidigt.
   *
   * Samma svar som för en för liten kandidat: varken ja eller nej, utan
   * faktorn 0,85 och vidare.
   */
  if (!p) { svar.faktor *= PLATTGRIND.osakerFaktor; svar.skal = 'kunde ej mätas'; return svar; }
  /*
   * Slät yta: kontrasten räcker inte för att mörkandelen ska betyda något. Här
   * AVVISAS det ändå, till skillnad från fallet ovan — en yta helt utan
   * kontrast har inga tecken, och en skylt utan tecken går inte att läsa.
   */
  if (p.kontrast < PLATTGRIND.kontrastMin) {
    svar.ok = false; svar.skal = 'slät yta'; return svar;
  }
  if (p.morkandel > PLATTGRIND.morkandelMax) {
    svar.ok = false; svar.skal = 'ljust på mörkt'; return svar;
  }
  if (p.morkandel < PLATTGRIND.morkandelMin) {
    svar.ok = false; svar.skal = 'inga tecken på plattan'; return svar;
  }
  return svar;
}

/**
 * Bara för provet: kör skanningen och lämnar ut varje kandidats geometri,
 * hela plattmätningen och grindens dom.
 *
 * Finns för att gränserna i PLATTGRIND ska gå att härleda ur mätta tal i
 * stället för ur gissningar. Utan den syns bara att en kandidat föll, aldrig
 * VILKET av talen som fällde den — och då blir varje justering av en gräns en
 * gissning till. Det var precis den funktionen som visade att radprofilen
 * fällde 19 av 19 sanna skyltar, och som därmed sparade in att den byggdes
 * färdigt.
 */
export function provaPlattgrind(kalla, omrade = null, { arbetsbredd = 400 } = {}) {
  const m = kallMatt(kalla);
  const yta = omrade || { x: 0, y: 0, w: m.b, h: m.h };
  const s = skannaLjusa(kalla, yta, arbetsbredd, { minAndel: 0.025, minPx: 10, bla: true });
  const inv = 1 / s.skala;
  const rader = [];
  const ta = (typ, ruta, bandAndel, extra) => {
    const cyBild = (yta.y + ruta.cy * inv) / (m.h || 1);
    rader.push({
      typ, cyBild, bandAndel,
      cx: ruta.cx, cy: ruta.cy, L: ruta.L, W: ruta.W, vinkel: ruta.vinkel,
      matt: matPlatta(s.gra, s.b, s.h, ruta, bandAndel),
      // 'full' här med flit: provet finns för att se vad regeln GÖR, och i
      // 'mjuk' vore flaggan overHorisont alltid falsk och kolumnen tom.
      dom: granskaSkyltruta(s.gra, s.b, s.h, ruta, { bandAndel, cyBild, lage: 'full' }),
      ...extra,
    });
  };
  for (const a of blaAnkare(s)) {
    ta('ankare', { cx: a.cx, cy: a.cy, L: a.rw, W: a.rh, vinkel: a.vinkel }, a.euAndel,
       { teckenbyten: a.teckenbyten,
         lada: { x: yta.x + a.minX * inv, y: yta.y + a.minY * inv,
                 w: a.bw * inv, h: a.bh * inv } });
  }
  for (const bl of s.blobbar) {
    ta('blobb', { cx: bl.cx, cy: bl.cy, L: bl.L, W: bl.W, vinkel: bl.vinkel }, 0,
       { teckenbyten: raknaTeckenbyten(s.gra, s.b, s.h, bl),
         lada: { x: yta.x + bl.minX * inv, y: yta.y + bl.minY * inv,
                 w: bl.bw * inv, h: bl.bh * inv } });
  }
  return { arbetsbredd: s.b, arbetshojd: s.h, skala: s.skala, rader };
}

/* ---- Skyltens proportion som grind --------------------------------------
 *
 * 520 / 110 = 4,73. Nästan ingenting annat i en gatubild har den formen, och
 * det gör den till en av de starkaste grindarna som finns att sätta. Men den
 * får inte sättas hårt kring 4,73, för skylten är sällan sedd rakt framifrån.
 *
 * NEDRE GRÄNSEN 2,5 — skylten vriden bort från kameran i sidled.
 * Bredden kortas av med cosinus för vinkeln, höjden står kvar:
 *      4,73 · cos 40° = 3,62
 *      4,73 · cos 50° = 3,04
 *      4,73 · cos 58° = 2,51
 * Vid 58° börjar tecknen skymma varandra i sidled och ingen motor läser dem.
 * Grinden kastar alltså bara sådant som ändå inte gick att läsa.
 *
 * ÖVRE GRÄNSEN 7,0 — skylten sedd uppifrån eller underifrån.
 * Nu är det höjden som kortas av:
 *      4,73 / cos 30° = 5,46
 *      4,73 / cos 40° = 6,17
 *      4,73 / cos 48° = 7,07
 * Telefonen sitter i en hållare och tittar snett ner, och skyltar sitter
 * dessutom ofta lätt bakåtlutade. 48° är mer än det med god marginal. Ligger
 * mätningen ovanför är det inte längre en skylt vi mätt — då har det ljusa
 * fortsatt förbi skylten ut i en vit stötfångare eller en ljus skåpbilssida.
 *
 * Spannet [2,5; 7,0] täcker alltså ±58° i sidled och ±48° i höjdled, och det
 * är mer än vad som går att läsa åt båda hållen.
 */
export const SKYLT_KVOT     = 4.73;
export const SKYLT_KVOT_MIN = 2.5;
export const SKYLT_KVOT_MAX = 7.0;

/* ---- Blå bandet som ankare ----------------------------------------------
 *
 * Bandets form, mätt längs bandets EGNA axlar.
 *
 * Nominellt är bandet 110 mm högt och 52 mm brett, alltså 2,12 gånger längre
 * än brett. Sett snett i sidled blir det smalare och kvoten stiger
 * (2,12 / cos 60° = 4,2), sett snett uppifrån blir det kortare och kvoten
 * sjunker (2,12 · cos 60° = 1,06). Därav [1,10; 6,0].
 *
 * FÖRST MÄTTES DEN AXELPARALLELLA LÅDAN, OCH DET VAR FEL PÅ SAMMA SÄTT SOM
 * DEN GAMLA SÖKNINGEN VAR FEL.
 *
 * Lutar bilden i sökaren dras den omslutande lådan mot kvadrat: vid 40° blir
 * ett band på 2,12 en låda på 1,07, som föll på en gräns vid 1,10. Skylten
 * fanns mitt i bild, tydligt blå, och ankaret såg den inte — av exakt samma
 * skäl som den gamla ljusstapelsökningen inte såg lutade skyltar.
 *
 * Kvoten mäts därför på egenvärdena, precis som `skannaLjusa` redan gör för
 * skyltar. De är oberoende av hur bilden är vriden: ett band är 2,12 långt mot
 * brett oavsett om telefonen ligger rakt eller på sned. Talen nedan behövde
 * inte ändras — bara vad de mäts på.
 *
 * Grinden är ändå medvetet slapp. Bandets uppgift är att peka ut VAR vi ska
 * titta, inte att avgöra vad vi hittade. Det avgörandet ligger i skyltens
 * proportion och i teckenräkningen längre ner.
 */
export const BAND = {
  minBredd: 2,      // px i arbetsupplösning; smalare än så är en pixelrad brus
  minHojd: 5,       // motsvarar en skylt ~24 px bred i arbetsupplösning
  kvotMin: 1.10,    // längd genom bredd, längs bandets egna axlar
  kvotMax: 6.0,
  /*
   * Kostnadsgrind, inte formgrind: en blå himmel eller en blå husvägg ska inte
   * betala för en mätning som ändå kommer att falla.
   *
   * Talet måste sättas mot det MINSTA område sökningen körs i, inte mot en hel
   * bildruta. `sokKandidater` söker i hela bilden, och där är bandet under en
   * procent av ytan. Men `hittaPlat` söker inne i en ruta som redan sitter tätt
   * om skylten, och där är bandet ungefär en tiondel av bredden gånger hela
   * höjden — alltså runt tio procent av ytan, fullt lagligt.
   *
   * Först stod 0,06 här, satt efter helbildsfallet. Följden var att ankaret
   * fungerade i den stora sökningen men aldrig inne i den snäva rutan, vilket
   * är precis där beskärningen till textigenkänningen avgörs. 0,20 lämnar
   * marginal åt båda hållen och stänger fortfarande ute himmel och fasader.
   */
  maxAreaAndel: 0.20,
  max: 8,           // så många band tas vidare till mätning, störst först
};

/* ---- Vad som krävs av KROPPEN till höger om bandet ----------------------
 *
 * DET HÄR ÄR DET SOM SAKNADES, OCH DET SLÄPPTE IGENOM PÅHITTADE SKYLTAR.
 *
 * Kravet på kroppen var i praktiken bara tre saker: att den är ljus, att den
 * har ungefär rätt proportion, och att det finns MINST fyra växlingar mellan
 * mörkt och ljust. En vit skåpbilssida med en blå logotypruta och texten
 * "RÖR & VVS AB" uppfyller alla tre — uppmätt gav den scenen en ankrad
 * kandidat med poäng 1,75, och textigenkänningen läste ut "ROR54B", som är
 * ett formatgiltigt svenskt registreringsnummer. Ingenting längre fram i
 * kedjan kan stoppa det: formatvalideringen säger ja, rösträkningen får
 * samma svar bildruta efter bildruta eftersom skåpbilen står stilla, och en
 * kollision mot ett av förarens egna fordon hade utlöst larm på en främling.
 *
 * Grinden nedan säger inte längre "ljust med kontrast" utan "kropp med sex
 * tecken i skyltens takt". Fyra oberoende mätningar:
 *
 *   TAK PÅ VÄXLINGARNA. Sex tecken ger tio till fjorton växlingar. En
 *     korrugerad trailersida gav trettio och en företagstext tjugo. Talet
 *     som skulle skilja en skylt från en slät yta belönade i stället det som
 *     har MER struktur än en skylt. Taket är den enkla halvan av fixen.
 *
 *   GOLV EFTER UPPLÖSNING. Fyra växlingar är inte sex tecken. Men golvet kan
 *     inte sättas till åtta rakt av: en skylt vars kropp bara är fyrtio
 *     pixlar i arbetsupplösning har tio pixlar per tecken, och där flyter
 *     tecken ihop av ren nedskalning. Golvet följer därför upplösningen, och
 *     är hårdast där mätningen är pålitligast. Är bredden dessutom ANTAGEN
 *     är formen inget bevis alls, och då krävs två växlingar till.
 *
 *   SPANN. Tecknen ska ligga utspridda över kroppen. En skylt har text från
 *     nära bandet mot högerkanten; en företagslogotyp har ett kort ord i ena
 *     änden av en lång ljus yta.
 *
 * EN FEMTE GRIND PRÖVADES OCH FÖLL PÅ MÄTNINGEN: teckenTAKTEN, alltså
 * spannet delat med antalet pelare. Tanken var god — sex tecken ger gles takt,
 * löpande text ger tät. Men mätt mot provbilderna i sok-test.html ligger en
 * äkta skylt mellan 0,054 och 0,131 kroppslängder, och en tolv glyfer lång
 * företagstext över samma spann landar runt 0,043. Marginalen mellan rätt och
 * fel är alltså mindre än tio procent, och en grind med den marginalen kommer
 * att döda riktiga skyltar långt innan den räddar oss från ett lockbete.
 * Antalet växlingar mäter samma sak — hur många tecken det är — med betydligt
 * större marginal, så taket och golvet får bära det ensamma.
 *
 * Talen nedan är satta mot uppmätta värden och inte mot teori. På samtliga
 * provbilder ligger en äkta skylt på 10–16 växlingar och minst 38 % spann;
 * lockbetena som släpptes igenom låg på 20, 28 och 30 växlingar.
 */
export const KROPP = {
  bytenTak: 18,          // uppmätt: äkta skylt max 16, lockbeten från 20
  golvHog: 8,            // kropp >= hogUpplostPx: full teckenevidens krävs
  golvMellan: 6,         // kropp >= mellanUpplostPx
  golvLag: 4,            // därunder: som förut, mätningen bär inte mer
  antagenTillagg: 2,     // antagen bredd ⇒ hårdare krav på tecknen
  hogUpplostPx: 80,
  mellanUpplostPx: 40,
  spannAndel: 0.30,      // uppmätt golv på provbilderna: 0,38
  vansterLjusMax: 0.6,   // så långt får det ljusa fortsätta VÄNSTER om bandet
  bandMorkerAndel: 0.55, // bandet måste ligga under den nivån mellan lag och hog
};

/**
 * Plockar ut sammanhängande blå områden ur blåmasken.
 *
 * Fyra grannar, inte åtta, och sedan en hopslagning.
 *
 * Först prövades åtta grannar, eftersom EU-bandet är genomborrat av tolv gula
 * stjärnor och ett gult S och de hålen kan kapa bandet i två delar när skylten
 * är liten i bild. Men åtta grannar läcker: skyltens svarta ram är två pixlar
 * i full upplösning och mindre än en pixel efter nedskalningen till 400, och
 * över den utsuddade ramen räckte en enda diagonal förbindelse för att bandet
 * skulle flyta ihop med det som låg utanför skylten. Den sammanflutna klumpen
 * har inte ett bands form, så den kastades — och skylten med den.
 *
 * Fyra grannar läcker inte lika lätt. Att bandet kan splittras av stjärnorna
 * löses i stället av hopslagningen nedan, som bara slår ihop bitar som ligger
 * i samma lodräta stråk och nästan nuddar varandra. Den kan laga ett delat
 * band; den kan inte limma ihop ett band med en bilkaross bredvid.
 *
 * Momenten är rena summor, så en hopslagning är exakt — inte en approximation.
 */
function blaBand(mask, b, h) {
  const n = b * h;
  const besokt = new Uint8Array(n);
  const stack = new Int32Array(n);
  const bitar = [];

  for (let start = 0; start < n; start++) {
    if (besokt[start] || !mask[start]) continue;
    let sp = 0; stack[sp++] = start; besokt[start] = 1;
    let minX = b, maxX = -1, minY = h, maxY = -1, area = 0;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;

    while (sp) {
      const i = stack[--sp];
      const x = i % b, y = (i / b) | 0;
      area++;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0     && !besokt[i - 1] && mask[i - 1]) { besokt[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < b - 1 && !besokt[i + 1] && mask[i + 1]) { besokt[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0     && !besokt[i - b] && mask[i - b]) { besokt[i - b] = 1; stack[sp++] = i - b; }
      if (y < h - 1 && !besokt[i + b] && mask[i + b]) { besokt[i + b] = 1; stack[sp++] = i + b; }
    }
    bitar.push({ minX, minY, maxX, maxY, area, sx, sy, sxx, syy, sxy });
  }

  // Störst först, så en hopslagning alltid växer det största fragmentet.
  bitar.sort((a, c) => c.area - a.area);
  const hela = [];
  for (const f of bitar) {
    let slogsIhop = false;
    for (const m of hela) {
      const overlapp = Math.min(f.maxX, m.maxX) - Math.max(f.minX, m.minX) + 1;
      const smalast = Math.min(f.maxX - f.minX, m.maxX - m.minX) + 1;
      const glapp = Math.max(f.minY - m.maxY, m.minY - f.maxY);
      if (overlapp < smalast * 0.5 || glapp > 2) continue;
      m.minX = Math.min(m.minX, f.minX); m.maxX = Math.max(m.maxX, f.maxX);
      m.minY = Math.min(m.minY, f.minY); m.maxY = Math.max(m.maxY, f.maxY);
      m.area += f.area; m.sx += f.sx; m.sy += f.sy;
      m.sxx += f.sxx; m.syy += f.syy; m.sxy += f.sxy;
      slogsIhop = true; break;
    }
    if (!slogsIhop) hela.push({ ...f });
  }

  const ut = [];
  for (const m of hela) {
    const bw = m.maxX - m.minX + 1, bh = m.maxY - m.minY + 1;
    // Lådan duger till två saker: att se att fläcken alls har någon utsträckning,
    // och att se att den inte är orimligt stor. Formen mäts längre ner.
    if (bw < BAND.minBredd || bh < BAND.minHojd) continue;
    if (m.area > n * BAND.maxAreaAndel) continue;

    // Samma momentmatematik som `skannaLjusa`, men bandets långa axel är den
    // *lodräta*. Skyltens riktning är därför vinkelrät mot den, och den faller
    // ut gratis ur samma summor.
    const cx = m.sx / m.area, cy = m.sy / m.area;
    const cxx = m.sxx / m.area - cx * cx;
    const cyy = m.syy / m.area - cy * cy;
    const cxy = m.sxy / m.area - cx * cy;
    const spar = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const rot = Math.sqrt(Math.max(0, spar * spar / 4 - det));
    const L = Math.sqrt(Math.max(1, 12 * (spar / 2 + rot) + 1));            // bandets längd
    const W = Math.sqrt(Math.max(1, 12 * Math.max(0, spar / 2 - rot) + 1)); // bandets bredd

    // Formgrinden, längs bandets egna axlar. Se resonemanget vid BAND.
    const kvot = L / W;
    if (kvot < BAND.kvotMin || kvot > BAND.kvotMax) continue;

    /*
     * Huvudaxeln är bara meningsfull när bandet faktiskt är avlångt. Ett band
     * sett brant uppifrån är nästan kvadratiskt, och då pekar "långa axeln" åt
     * ett slumpmässigt håll. Hellre anta att skylten ligger vågrätt — det är
     * rätt i de allra flesta bildrutor — än att lita på ett brusigt tal.
     */
    const axel = vikVinkel(0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180 / Math.PI);
    const platvinkel = (L / W) >= 1.3 ? vikVinkel(axel - 90) : 0;

    ut.push({ minX: m.minX, minY: m.minY, bw, bh, area: m.area, cx, cy, L, W, platvinkel });
  }
  ut.sort((a, c) => c.area - a.area);
  return ut.slice(0, BAND.max);
}

/**
 * Bandets höjd, mätt längs bandets egen axel.
 *
 * Momenten duger till att peka ut riktningen men inte till att mäta höjden,
 * och det är inte en detalj — höjden ÄR skyltens höjd, och hela proportionen
 * hänger på den.
 *
 * Skälet är hålen. Ett band med tolv stjärnor och ett S är genomborrat mitt
 * på, och andra ordningens moment mäter spridning: tar man bort massa nära
 * mitten ökar spridningen, och den beräknade längden blir för stor. Uppmätt
 * på provbilderna gav momenten 77 px där bandet var 72 — sju procent för
 * mycket, konsekvent, och sju procent på höjden är sju procent fel på
 * proportionen. Det räckte för att en skylt vriden 55° skulle mätas till 2,49
 * och falla på en grind som går vid 2,50.
 *
 * Här mäts i stället hur långt det blå faktiskt sträcker sig, längs bandets
 * egen axel, från mitten och utåt åt båda hållen. Hålen bryggas av ett glapp —
 * ett hål i ett band är fortfarande samma band. Tre provlinjer i sidled, den
 * längsta vinner, så att en stjärna som råkar ligga mitt i den ena linjen inte
 * kortar av svaret.
 *
 * @returns {{hojd:number, vMitt:number}|null}  höjd i pixlar, och hur långt
 *          bandets verkliga mitt ligger från tyngdpunkten längs axeln
 */
function matBandHojd(mask, b, h, band, vinkel) {
  const rad = vinkel * Math.PI / 180;
  const kos = Math.cos(rad), sin = Math.sin(rad);
  const pa = (u, v) => {
    const x = Math.round(band.cx + u * kos - v * sin);
    const y = Math.round(band.cy + u * sin + v * kos);
    if (x < 0 || x >= b || y < 0 || y >= h) return 0;
    return mask[y * b + x];
  };
  // Bandet kan aldrig vara längre än sin egen omslutande låda, med marginal.
  const tak = Math.round(Math.max(band.bw, band.bh) * 1.2) + 4;
  const glapp = Math.max(2, Math.round(Math.max(band.bw, band.bh) * 0.22));

  let bast = 0, mitt = 0;
  for (const u of [0, -band.W * 0.3, band.W * 0.3]) {
    let upp = 0, ner = 0;
    for (let d = 1; d <= tak; d++) {
      if (pa(u, d)) upp = d; else if (d - upp > glapp) break;
    }
    for (let d = 1; d <= tak; d++) {
      if (pa(u, -d)) ner = d; else if (d - ner > glapp) break;
    }
    if (upp + ner > bast) { bast = upp + ner; mitt = (upp - ner) / 2; }
  }
  return bast ? { hojd: bast + 1, vMitt: mitt } : null;
}

/**
 * Mäter upp skylten utifrån ett blått band.
 *
 * Bandets höjd ÄR skyltens höjd — bandet går hela vägen upp och ner. Det är
 * den mätningen som gör ankaret värt något: höjden är det tal skylten är
 * minst tvetydig om, och ur den följer allt annat.
 *
 * Bredden mäts, den antas inte. Vi går åt höger från bandet och letar efter
 * var det ljusa tar slut. Det måste gå att gå förbi tecknen på vägen — en
 * kolumn mitt i ett B är nästan helt mörk — så mätningen bär med sig ett
 * glapp på 0,45 skylthöjder innan den säger att det ljusa är slut. Bredare än
 * så är inget tecken i skyltfonten.
 *
 * @param {number} vinkel  skyltens riktning i grader, ofolded: bandet ligger
 *                         vid u = 0 och skyltkroppen åt +u
 * @returns {object|null}  mätningen i arbetsupplösningens pixlar
 */
function matSkyltFranBand(gra, mask, b, h, band, vinkel) {
  const matt = matBandHojd(mask, b, h, band, vinkel);
  if (!matt) return null;
  const ph = matt.hojd / 0.94;          // bandet är inramat, skylten är lite högre
  if (ph < 6) return null;

  // Bandbredden i förhållande till höjden. Nominellt 52/110 = 0,47; snett
  // sett krymper den. Långt utanför det är det inte ett skyltband.
  const bandAndel = band.W / ph;
  if (bandAndel < 0.18 || bandAndel > 1.0) return null;

  const rad = vinkel * Math.PI / 180;
  const kos = Math.cos(rad), sin = Math.sin(rad);
  /*
   * Origo läggs i bandets UPPMÄTTA mitt, inte i dess tyngdpunkt. Stjärnorna
   * och S:et sitter inte symmetriskt i bandet, så tyngdpunkten dras åt ett
   * håll — och eftersom allt nedan mäts från origo hade den förskjutningen
   * lutat hela skylten uppåt eller nedåt i beskärningen.
   */
  const ox = band.cx - matt.vMitt * sin;
  const oy = band.cy + matt.vMitt * kos;
  const prov = (u, v) => {
    const x = Math.round(ox + u * kos - v * sin);
    const y = Math.round(oy + u * sin + v * kos);
    if (x < 0 || x >= b || y < 0 || y >= h) return -1;
    return gra[y * b + x];
  };

  // Elva provlinjer över mittersta 60 % av höjden. Över- och underkanten
  // bidrar ingenting och drar bara in skyltramen i mätningen.
  const vRad = [];
  for (let i = 0; i < 11; i++) vRad.push((-0.3 + 0.06 * i) * ph);

  const steg = Math.max(1, Math.round(ph / 60));
  const u0 = band.W / 2;                        // bandets högerkant
  const uMax = u0 + SKYLT_KVOT_MAX * 1.03 * ph; // så långt vi någonsin letar

  /*
   * Vitnivån tas ur den första biten närmast bandet. Där ÄR vi på skylten om
   * det finns en skylt — de första 1,5 skylthöjderna rymmer ett par tecken och
   * bottnen mellan dem. Att i stället ta nivån ur hela sökspannet hade låtit
   * bakgrunden bestämma var gränsen går.
   */
  let lag = 255, hog = 0, prickar = 0;
  for (let u = u0; u <= u0 + 1.5 * ph; u += steg) {
    for (const v of vRad) {
      const g = prov(u, v);
      if (g < 0) continue;
      prickar++;
      if (g < lag) lag = g;
      if (g > hog) hog = g;
    }
  }
  if (prickar < 20) return null;          // skylten ligger utanför bilden
  if (hog - lag < 35) return null;        // slät yta intill bandet, inga tecken
  const trosk = lag + (hog - lag) * 0.55;

  /*
   * Bandet måste vara MÖRKT i förhållande till kroppen.
   *
   * Blåmasken går på kulör och mättnad, inte på ljushet, och det är rätt — en
   * skylt i skugga är fortfarande blå. Men konsekvensen är att en ljus blå
   * yta (en himmelsflik mellan två grenar, en blekt blå dekal) kan bli ett
   * "band" med en ljus yta bredvid sig. Ett EU-band är djupt mörkblått och
   * ligger långt under skyltens vitnivå även med de gula stjärnorna inräknade.
   * Uppmätt på provbilderna landar bandet runt en fjärdedel upp mellan svart
   * text och vit botten; grinden går vid drygt hälften.
   */
  let bandSumma = 0, bandAntal = 0;
  for (let u = -band.W * 0.3; u <= band.W * 0.3; u += Math.max(1, steg)) {
    for (const v of vRad) {
      const g = prov(u, v);
      if (g < 0) continue;
      bandSumma += g; bandAntal++;
    }
  }
  if (!bandAntal) return null;
  if (bandSumma / bandAntal > lag + (hog - lag) * KROPP.bandMorkerAndel) return null;

  /*
   * Hur långt det ljusa fortsätter till VÄNSTER om bandet.
   *
   * En skylt SLUTAR vid bandet — bandet sitter i skyltens yttersta vänsterkant.
   * En skåpbilssida med en blå logotypruta gör det inte: där fortsätter samma
   * vita plåt förbi det blå åt båda hållen.
   *
   * Det är däremot medvetet INTE en dödsdom. Sitter skylten på en vit skåpbil,
   * en silverkaross eller mot en ljus husvägg är det ljust till vänster om
   * bandet också, och det är exakt det fall ankaret finns för — att avvisa där
   * vore att göra sökaren blind i just det läge där ljusstapelvägen redan är
   * svagast. Måttet används därför till att avgöra hur mycket ankaret får LYFTA
   * kandidaten, inte till att kasta den. Se `ankarfaktor`.
   */
  let vansterLjus = 0;
  for (let d = steg; d <= 1.2 * ph; d += steg) {
    let ljus = 0, av = 0;
    for (const v of vRad) {
      const g = prov(-band.W / 2 - d, v);
      if (g < 0) continue;
      av++;
      if (g > trosk) ljus++;
    }
    if (!av || ljus / av < 0.35) break;
    vansterLjus = d;
  }
  const kantstodd = vansterLjus < KROPP.vansterLjusMax * ph;

  // Gå åt höger tills det ljusa tar slut.
  const glapp = 0.45 * ph;
  let sistLjus = u0, slutMatt = false;
  for (let u = u0; u <= uMax; u += steg) {
    let ljus = 0, av = 0;
    for (const v of vRad) {
      const g = prov(u, v);
      if (g < 0) continue;
      av++;
      if (g > trosk) ljus++;
    }
    if (av && ljus / av >= 0.35) sistLjus = u;
    else if (u - sistLjus > glapp) { slutMatt = true; break; }
  }

  /*
   * Tre utfall, och skillnaden mellan dem är ärlighet.
   *
   * 1. Det ljusa tog slut på ett rimligt avstånd. Då HAR vi mätt skyltens
   *    bredd, och proportionen får grinda på riktigt.
   *
   * 2. Det ljusa tog aldrig slut, eller tog slut orimligt långt bort. Båda
   *    betyder samma sak: skyltens högerkant syns inte, för bakgrunden är
   *    också ljus. Skylten sitter på en vit skåpbil, en silverfärgad kaross
   *    eller mot en ljus husvägg. Då har vi inte mätt bredden, och att låtsas
   *    om något annat vore att grinda på ett tal vi hittat på.
   *
   *    I stället används den kända geometrin, 4,73, och kandidaten märks som
   *    antagen. Formen är då inget bevis längre, så bevisbördan flyttas till
   *    teckenräkningen som får ett hårdare krav längre ner.
   *
   *    Att i stället avvisa hade tappat skylten helt i just det läge där
   *    ljusstapelsökningen också är som svagast — där flyter skylten ihop med
   *    karossen till en enda ljus fläck. Det är precis det fallet ankaret
   *    finns för.
   *
   * 3. Det ljusa tog slut alldeles för tidigt. Då är det inte en skylt till
   *    höger om bandet, och kandidaten avvisas. Här är mätningen ett riktigt
   *    negativt besked och inte ett uteblivet svar.
   */
  let pw = sistLjus + band.W / 2;
  let antagenBredd = false;
  const kvot = pw / ph;
  if (!slutMatt || kvot > SKYLT_KVOT_MAX) {
    pw = SKYLT_KVOT * ph;
    antagenBredd = true;
  } else if (kvot < SKYLT_KVOT_MIN) {
    return null;
  }

  /*
   * Teckenväxlingar i skyltkroppen, alltså till höger om bandet. Sex tecken
   * ger tio till sexton växlingar; en slät vit yta ger noll, en företagstext
   * tjugo och ett räfflat trailerplåt trettio. Det är den mätning som skiljer
   * en skylt från en blå bil parkerad intill en vit panel, och den får döda en
   * kandidat åt båda hållen — för få OCH för många. Grindarna och de uppmätta
   * talen bakom dem står i KROPP.
   *
   * Räkningen kräver upplösning för att betyda något. Är kroppen under 24 px
   * lång i arbetsupplösning svarar vi varken ja eller nej — samma försiktighet
   * som `poangsattKandidat` redan har mot små kandidater.
   */
  const uSlut = -band.W / 2 + pw;
  const kroppLangd = uSlut - u0;
  let byten = 0, imork = false;
  // Var växlingarna ligger, inte bara hur många. Spannet räknas ur det.
  let forstaByte = 0, sistaByte = 0;
  for (let u = u0; u <= uSlut; u += steg) {
    let mork = 0, av = 0;
    for (const v of vRad) {
      const g = prov(u, v);
      if (g < 0) continue;
      av++;
      if (g < trosk) mork++;
    }
    if (!av) continue;
    const andel = mork / av;
    let bytte = false;
    if (!imork && andel > 0.45) { imork = true; bytte = true; }
    else if (imork && andel < 0.2) { imork = false; bytte = true; }
    if (bytte) {
      if (!byten) forstaByte = u;
      sistaByte = u;
      byten++;
    }
  }
  const palitligTeckenrakning = kroppLangd >= 24;
  if (palitligTeckenrakning) {
    /*
     * Tre grindar, i den ordning de är billigast att svara på. Alla tre frågar
     * samma sak från olika håll: är det här sex tecken, eller är det något
     * annat som råkar vara randigt? Se KROPP för motiveringen och för talen.
     */
    if (byten > KROPP.bytenTak) return null;

    const bas = kroppLangd >= KROPP.hogUpplostPx ? KROPP.golvHog
              : kroppLangd >= KROPP.mellanUpplostPx ? KROPP.golvMellan
              : KROPP.golvLag;
    if (byten < bas + (antagenBredd ? KROPP.antagenTillagg : 0)) return null;

    if (sistaByte - forstaByte < kroppLangd * KROPP.spannAndel) return null;
  }

  // Skyltens mitt, uttryckt i bildens pixlar.
  const uMitt = -band.W / 2 + pw / 2;
  const cx = ox + uMitt * kos;
  const cy = oy + uMitt * sin;
  const aw = pw * Math.abs(kos) + ph * Math.abs(sin);
  const ah = pw * Math.abs(sin) + ph * Math.abs(kos);

  return {
    cx, cy, rw: pw, rh: ph, vinkel,
    minX: cx - aw / 2, minY: cy - ah / 2, bw: aw, bh: ah,
    forhallande: pw / ph,
    teckenbyten: byten,
    palitligTeckenrakning,
    antagenBredd,
    kantstodd,
    // Uppmätt EU-band i andel av skyltens bredd. `forbehandla` slipper då
    // gissa på en fast tiondel.
    euAndel: Math.min(0.3, Math.max(0.04, band.W / pw)),
  };
}

/**
 * Kör hela ankarvägen mot en färdig skanning: blå band → uppmätt skylt.
 *
 * BÅDA RIKTNINGARNA MÄTS, OCH DEN BÄSTA VINNER.
 *
 * Huvudaxeln vet vilken linje bandet ligger längs men inte åt vilket håll
 * skylten fortsätter — ett band och samma band upp och ner ger identiska
 * moment. Förut stod det `a || b` här, med motiveringen att fel riktning
 * "faller på sina egna grindar". Det var ett antagande och inte en mätning,
 * och `||` gör antagandet till ett faktum: passerar fel riktning så prövas
 * rätt riktning aldrig.
 *
 * `vikVinkel` viker alltid till (-90, 90], så första försöket letar alltid
 * åt höger i bildens koordinater. Står skylten nästan lodrätt i bildrutan —
 * liggande telefon, som modulen räknar med på annat håll — pekar det första
 * försöket rakt in i karossen. Är karossen ljus tar det ljusa aldrig slut,
 * bredden antas, och en grill eller en lyktkant kan bära hem teckengrinden.
 * Då returnerades en ruta över plåten och den riktiga skylten mättes aldrig.
 *
 * Rangordningen: en UPPMÄTT bredd slår en antagen, sedan vinner den med flest
 * teckenväxlingar. Kostnaden är en extra mätning per band — samma kostnad som
 * förut betalades i varje fall där den första riktningen misslyckades.
 *
 * Den omvända riktningen märks. En svensk skylt har bandet till vänster, så i
 * en rättvänd bildruta är omvänd riktning inte skyltens layout. Den får därför
 * ett mindre lyft i poängen (se `ankarfaktor`) — men den kastas inte, för med
 * liggande telefon är den rätt.
 */
function blaAnkare(s) {
  if (!s.blaMask) return [];
  const ut = [];
  const battre = (a, b) => {
    if (!b) return a;
    if (!a) return b;
    if (a.antagenBredd !== b.antagenBredd) return a.antagenBredd ? b : a;
    return b.teckenbyten > a.teckenbyten ? b : a;
  };
  for (const bd of blaBand(s.blaMask, s.b, s.h)) {
    const fram = matSkyltFranBand(s.gra, s.blaMask, s.b, s.h, bd, bd.platvinkel);
    const bak = matSkyltFranBand(s.gra, s.blaMask, s.b, s.h, bd, bd.platvinkel + 180);
    if (bak) bak.omvand = true;
    const f = battre(fram, bak);
    if (f) ut.push(f);
  }
  return ut;
}

/**
 * Hur mycket ett ankare får lyfta en kandidats poäng.
 *
 * FÖRUT VAR TALET 1,8 OVILLKORLIGT, OCH DET VAR DET SOM GJORDE ETT FALSKT
 * ANKARE FARLIGT. Med en äkta ABC123-skylt mitt i bild och en skåpbil med blå
 * logotypruta uppe i hörnet vann lockbetet låset — 1,55 mot 1,35 — och den
 * skylt föraren faktiskt hade framför sig lästes aldrig. Lyftet ska ges för
 * bevis, inte för att kandidaten kom in genom den blå dörren.
 *
 * Fullt lyft kräver att kroppen faktiskt bevisats vara en skyltkropp: att
 * teckenräkningen var pålitlig (kroppen har upplösning nog), att bredden
 * MÄTTES och inte antogs, att bandet sitter i en kant, och att riktningen är
 * den en svensk skylt har. Saknas något av det är kandidaten fortfarande värd
 * att titta på — den ska bara inte gå före en uppmätt ljus skylt.
 */
function ankarfaktor(a) {
  if (!a.palitligTeckenrakning) return 1.15;   // ingen teckenevidens alls
  let f = a.antagenBredd ? 1.35 : 1.8;         // gissad bredd ⇒ formen är inget bevis
  if (!a.kantstodd) f = Math.min(f, 1.25);     // bandet sitter mitt i en ljus yta
  /*
   * Omvänd riktning: mindre lyft, men inte inget. Uppmätt på en scen vriden
   * −90° — liggande telefon, ett läge modulen uttryckligen räknar med — läser
   * den omvända ankarkandidaten ut MLK907 med 87 % säkerhet medan ljusstapeln
   * på samma skylt inte ger någon läsning alls. Straffas ankaret ända ner till
   * 1,0 vinner alltså den kandidat som inte går att läsa. 1,5 räcker för att
   * en rättvänd ankarkandidat alltid ska gå före, och för att den omvända ändå
   * ska slå en ren ljus fläck.
   */
  if (a.omvand) f = Math.min(f, 1.5);
  return f;
}

/**
 * Bara ankarvägen, i källans pixlar. Finns för att provet ska kunna mäta den
 * för sig — hur ofta bandet hittas, vilken proportion som mättes upp och vad
 * det kostade — utan att ljusstapelvägen blandar sig i svaret.
 *
 * Produktionsvägen går genom `sokKandidater`, som kör båda.
 */
export function sokAnkare(kalla, omrade = null, { arbetsbredd = 400 } = {}) {
  const m = kallMatt(kalla);
  const yta = omrade || { x: 0, y: 0, w: m.b, h: m.h };
  if (!(yta.w > 16 && yta.h > 16)) return [];
  const s = skannaLjusa(kalla, yta, arbetsbredd, { minAndel: 0.025, minPx: 10, bla: true });
  const inv = 1 / s.skala;
  return blaAnkare(s).map(a => ({
    x: yta.x + a.minX * inv, y: yta.y + a.minY * inv,
    w: a.bw * inv, h: a.bh * inv,
    cx: yta.x + a.cx * inv, cy: yta.y + a.cy * inv,
    rw: a.rw * inv, rh: a.rh * inv,
    vinkel: a.vinkel,
    forhallande: a.forhallande,
    teckenbyten: a.teckenbyten,
    antagenBredd: a.antagenBredd,
    palitligTeckenrakning: a.palitligTeckenrakning,
    kantstodd: a.kantstodd,
    omvand: !!a.omvand,
    euAndel: a.euAndel,
  }));
}

/**
 * Letar upp själva skylten inne i en given ruta.
 *
 * Utan det här steget skalas hela rutan, och sitter bilen tio meter bort är
 * skylten en tiondel av rutan — texten blir några pixlar hög och motorn läser
 * ingenting. Det var precis så mätningen såg ut innan: rutan gav rätt svar
 * bara när skylten råkade fylla den.
 *
 * Två vägar, i den ordningen:
 *
 *   1. Det blå EU-bandet. Hittas ett band som mäter upp till något med
 *      skyltens proportion är det skylten, punkt. Den vägen ger dessutom två
 *      saker den gamla aldrig kunde: en vänsterkant som är uppmätt i stället
 *      för gissad, och bandets faktiska bredd — så att `forbehandla` kan
 *      vitmåla precis bandet i stället för en fast tiondel av bilden.
 *
 *   2. Ljusstapeln, precis som förut: samma arbetsbredd, samma filter. Den är
 *      kvar därför att bandet kan vara smutsigt, avklippt i bildkanten,
 *      bortvänt eller sitta på en utländsk skylt utan band alls. En sökare som
 *      är bättre i snitt men blind i vissa lägen är en försämring, inte en
 *      förbättring.
 *
 * DE TÄVLAR, DE STÅR INTE I KÖ.
 *
 * Förut returnerades ankaret ovillkorligt och ljusstapeln nåddes bara när
 * ankaret gav NOLL träffar. Ett enda blått område som tog sig igenom
 * mätningen vann därmed över en perfekt ljus skylt i samma ruta — och de två
 * vanligaste sätten att få ett sådant område är blå kaross som flyter ihop
 * med bandet (bredden överskattas, kvoten sätts till 4,73 per definition och
 * lådan blir karossen) och ett blått föremål bredvid skylten. Kommentaren
 * ovan om att ljusstapeln är kvar "för att bandet kan vara bortvänt" stämde
 * bara i det fall ankaret inte hittade någonting alls.
 *
 * Numera poängsätts båda med samma funktion som `sokKandidater` använder, och
 * den bästa vinner. Det är samma jämförelse på båda ställena, vilket också
 * betyder att de inte längre kan välja olika ruta för samma bildruta.
 *
 * Sökningen i hela bilden ligger i `sokKandidater`.
 *
 * @returns {object|null} snävare {x,y,w,h} i källans pixlar, eller null
 */
export function hittaPlat(kalla, roi) {
  const AB = 320;                                   // arbetsbredd, håller det billigt
  const s = skannaLjusa(kalla, roi, AB, { minAndel: 0.12, minPx: 0, bla: true });
  const inv0 = 1 / s.skala;
  const m = kallMatt(kalla);

  /*
   * PLATTGRINDEN KÖRS ÄVEN HÄR, OCH DET ÄR INTE EN DUBBLETT.
   *
   * `lasRuta` letar reda på skylten en gång till inuti den ruta den fått, och
   * den andra sökningen kan välja en annan sak än den första gjorde — den ser
   * bara ett litet utsnitt och har inte hela bildrutan att jämföra med. Utan
   * grinden här kan alltså ett korrekt lås på skylten beskäras om till
   * handlarlisten under den, och det syns bara som "rätt ruta, ingen text".
   *
   * MEN HÄR AVVISAS INGEN KANDIDAT. Skillnaden mot sökningen är att den här
   * funktionen har ett ansvar att lämna ifrån sig NÅGOT — returnerar den null
   * läser `lasRuta` hela den råa rutan och kapar EU-fältet på egen hand, och
   * det är sämre än en tveksam beskärning. Underkänd kandidat får därför
   * faktorn 0,05 i stället för att strykas: finns en bättre kandidat vinner
   * den, finns ingen alls står den underkända kvar. Fail-open, inte
   * fail-closed.
   */
  const GRIND_UNDERKAND = 0.05;
  const grinda = (ruta, bandAndel) => {
    // Inget `lage` skickas in: den här funktionen vet ingenting om hur
    // telefonen sitter, och då är horisontregeln mjuk. Se `horisontlage`.
    // Alla kandidater här ligger dessutom inne i EN redan låst ruta, så de
    // sitter på i praktiken samma höjd — horisonten skiljer dem sällan åt.
    const g = granskaSkyltruta(s.gra, s.b, s.h, ruta,
      { bandAndel, cyBild: (roi.y + ruta.cy * inv0) / (m.h || 1) });
    return { prior: g.ok ? g.faktor : GRIND_UNDERKAND, mjukZon: g.mjukZon };
  };
  /*
   * Horisontstraffet läggs på FÄRDIG poäng, inte in i priorn, av exakt samma
   * skäl som i `sokKandidater`: ett straff som gömmer sig i en faktor kan inte
   * granskas av det som kommer efter. Här kommer visserligen ingenting efter —
   * `hittaPlat` jämför bara kandidater med varandra och har ingen låsgräns att
   * falla under — men samma avbildning används i båda vägarna så att det finns
   * EN implementation att mäta och EN att ändra. Se `horisontstraff`.
   */
  const straffa = (poang, mjukZon) => (mjukZon ? horisontstraff(poang, false) : poang);

  let ankare = null, ankarePoang = -1;
  for (const a of blaAnkare(s)) {
    const gr = grinda({ cx: a.cx, cy: a.cy, L: a.rw, W: a.rh, vinkel: a.vinkel },
                      a.euAndel);
    const p = poangsattKandidat({
      forhallande: a.forhallande,
      fyllnad: null,
      teckenbyten: a.teckenbyten,
      bredd: a.rw,
      cx: a.cx / s.b, cy: a.cy / s.h,
      ytaB: s.b,
      vinkel: a.vinkel,
      ankare: ankarfaktor(a),
      prior: gr.prior,
    });
    const poang = straffa(p.poang, gr.mjukZon);
    if (poang > ankarePoang) { ankare = a; ankarePoang = poang; }
  }

  // Ljusstapeln poängsätts likadant. Att välja den STÖRSTA blobben, som koden
  // gjorde förut, är ungefär det sämsta urvalskriterium som finns — skylten är
  // nästan aldrig det största ljusa i bilden.
  let bast = null, bastPoang = -1;
  for (const bl of s.blobbar) {
    const gr = grinda({ cx: bl.cx, cy: bl.cy, L: bl.L, W: bl.W, vinkel: bl.vinkel }, 0);
    const p = poangsattKandidat({
      forhallande: bl.forhallande,
      fyllnad: bl.fyllnad,
      teckenbyten: raknaTeckenbyten(s.gra, s.b, s.h, bl),
      bredd: bl.L,
      cx: (bl.minX + bl.bw / 2) / s.b,
      cy: (bl.minY + bl.bh / 2) / s.h,
      ytaB: s.b,
      vinkel: bl.vinkel,
      prior: gr.prior,
    });
    const poang = straffa(p.poang, gr.mjukZon);
    if (poang > bastPoang) { bast = bl; bastPoang = poang; }
  }

  if (ankare && ankarePoang >= bastPoang) {
    return {
      x: roi.x + ankare.minX * inv0,
      y: roi.y + ankare.minY * inv0,
      w: ankare.bw * inv0,
      h: ankare.bh * inv0,
      vinkel: ankare.vinkel,
      cx: roi.x + ankare.cx * inv0,
      cy: roi.y + ankare.cy * inv0,
      // Ankaret har mätt skyltens kanter, inte en ljus fläcks. Marginalen är
      // därför mindre än i ljusstapelvägen — vi vet var kanten går.
      rw: ankare.rw * 1.03 * inv0,
      rh: ankare.rh * 1.08 * inv0,
      euAndel: ankare.euAndel,
      // Följer med ut. Förut stannade de här inne i `hittaPlat`, och den som
      // fick rutan kunde inte se om bredden var mätt eller påhittad.
      teckenbyten: ankare.teckenbyten,
      forhallande: ankare.forhallande,
      antagenBredd: ankare.antagenBredd,
      palitligTeckenrakning: ankare.palitligTeckenrakning,
      kantstodd: ankare.kantstodd,
      omvand: !!ankare.omvand,
      poang: ankarePoang,
      ankrad: true,
    };
  }

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
    poang: bastPoang,
  };
}

/* ---- BAKVAGNSANKARET: BYGGT, MÄTT, BORTTAGET -----------------------------
 *
 * Idén var ägarens egen mening satt i kod: "när du har identifierat bilen, då
 * låser du in på regskylten". En bil bakifrån behöver inte segmenteras — två
 * röda, ungefär lika stora fläckar på samma höjd räcker. Avståndet mellan dem,
 * `sep`, är bakvagnens måttstock, och skylten sitter alltid på ungefär samma
 * plats i den måttstocken.
 *
 * DET BYGGDES FÄRDIGT OCH DET MÄTTES. Mekanismen FUNGERAR — den togs inte bort
 * för att den inte hittar bakvagnar. Uppmätt med en provsida som lade
 * facitrutan i lyktparets måttstock (den följde med koden ut; talen står kvar
 * här, för det är talen som är värdefulla och inte harnesket):
 *
 *   Lyktpar hittat:            18 av 22 bilder, 14 av 15 bakifrån-bilder.
 *   Skyltens läge i sep-enheter, mätt ur facitrutan på de 14 (två uteslutna,
 *   se nedan):
 *       u = (skyltmitt.x − parets mitt) / sep   −0,29 … +0,20, median 0,00
 *       v = (skyltmitt.y − lyktlinjen)  / sep   −0,06 … +0,19, median 0,02
 *       skyltlängd / sep                         0,24 … 0,48,  median 0,46
 *   Uteslutna: 0c4d9b68 (u = −1,18, dess "par" är en röd bil långt bort, inte
 *   målbilens bakvagn) och nya-skyltar-transportstyrelsen (L/sep = 0,87,
 *   bilden är ett montage med en urklippt närbild inklistrad över vägfotot).
 *
 * Det är en STRAM prior: skylten ligger inom ±0,29 lyktavstånd i sidled och
 * inom −0,06…+0,19 i höjdled. Informationen är verklig och stark.
 *
 * DEN TOGS BORT ÄNDÅ, PÅ SIFFROR:
 *
 *   VINST:  0 av 22 bilder ändrades. Rätt text 10/21 före och efter, lås på
 *           rätt skylt 15/22 före och efter, varje enskild bilds IoU
 *           oförändrad in på andra decimalen.
 *   KOSTNAD (median söktick, samma maskin, samma bänk, arbetsbredd 400):
 *           utan mekanismen            6,8 ms   (max 22,5)
 *           + rödmasken i pixelsvepet  8,3 ms   (max 29,0)   +1,5 ms
 *           + flödesfyllning och parning 10,8 ms (max 33,3)  +2,5 ms till
 *           Alltså +4,0 ms per söktick, +59 %. Vid 8,3 sökningar i sekunden
 *           är det +33 ms CPU per sekund, för alltid, på varje bildruta.
 *
 * VARFÖR VINSTEN BLEV NOLL, för det är den intressanta delen: mekanismen
 * överlappar PLATTGRIND, och den billiga av de två hann först. De tre
 * rangordningsfel bakvagnsankaret var tänkt att laga — 521e24d0 (blå dekaltext
 * på en baklucka vann låset), Regpl-Heden (vit skrivstil på röd motorhuv) och
 * polestar-4-bak (rätt kandidat fanns men låg tvåa) — är alla "ljust på mörkt",
 * och plattgrindens mörkandel dödar dem för under en millisekund. När den väl
 * gjort det finns det inget kvar för priorn att rangordna bort.
 *
 * Det enda som återstod var latens: YBK70UD har ett betrott par med skylten
 * inne i fönstret och hade kunnat få `bildrutorForLasAnkrad` 3 i stället för
 * 8, alltså 600 ms snabbare lås. EN bild av 22, betald med 33 ms CPU i
 * sekunden på alla 22. Det är fel sida av regeln om att en förbättring inte
 * får kosta mer än den vinner.
 *
 * NÄR DEN SKA BYGGAS TILLBAKA: när en bänk med riktigt dashcam-material visar
 * rangordningsfel som INTE är "ljust på mörkt" — två vita, teckenförsedda,
 * skyltformade ytor i samma bildruta, där bara den ena sitter på bilen man
 * kör bakom. Då är lyktparet rätt verktyg, och fönstret ovan är redan mätt.
 *
 * Två saker som ska följa med om den byggs tillbaka, båda funna under bygget:
 *   1. TILLITSGRINDEN är inte valfri. Fyra av sju framifrån-bilder ger ett
 *      falskt "par" av röd kaross och röda dekaler. Paret får bara användas
 *      om minst en kandidat redan ligger inne i fönstret. Fail-open.
 *   2. SÄNKNINGEN FÅR INTE PASSERA LÅSGRÄNSEN. Hamnar alla kandidater utanför
 *      fönstret sänks allihop, och då kan de falla under MALSOK.minPoang — och
 *      då finns ingen kandidat kvar att låsa på alls. Samma fel som redan står
 *      dokumenterat i `taxAvAnkare`, en nivå längre ut.
 *      OCH DET SKA INTE LÖSAS MED ETT GOLV. Ett golv klistrar ihop allt under
 *      sig till ett enda tal och utplånar den rangordning sänkningen fanns
 *      till för — det mättes på horisontstraffet och revs. Använd
 *      `horisontstraff`-formen i stället: samma multiplikation, men linjen
 *      lyft så att den går genom (låsgränsen, låsgränsen). Härledningen står
 *      i `horisontstraff`.
 */

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
                             vinkel = 0, forvantadVinkel = null, ankare = 1, prior = 1 }) {
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
   * FAKTORN VAR ENSIDIG, OCH DÅ BELÖNADE DEN FEL SAK. `teckenbyten / 8` med
   * tak vid 1 gav full poäng åt allt från åtta växlingar och uppåt. En svensk
   * skylt ger tio till fjorton. En korrugerad trailersida gav trettio och en
   * företagstext tjugo — alltså exakt samma teckenpoäng som en perfekt läst
   * skylt. Talet som skulle skilja en skylt från en slät yta kontrollerade
   * bara att det fanns MINST sex pelare, aldrig att det inte fanns trettio.
   *
   * Nu är den tvåsidig: en klocka kring tolv växlingar. Tio till fjorton
   * behåller i praktiken full poäng, medan räfflor och löpande text faller.
   * Golvet 0,2 står kvar — faktorn ska rangordna, och bara de två uttryckliga
   * fallen nedan får döda.
   *
   * Räkningen kräver att kandidaten är minst 24 pixlar bred i arbetsupplösning
   * för att vara pålitlig. Är den mindre svarar vi varken ja eller nej, utan
   * lägger oss mitt emellan — annars hade varje skylt på håll dömts ut.
   */
  let tecken;
  if (bredd < 24) tecken = 0.7;
  // Fyllnaden mäts bara i ljusstapelvägen. Ankarvägen har ingen ljus blobb att
  // mäta fyllnad på — den har mätt skyltens kanter direkt — och då ska
  // fyllnadstestet hoppas över, inte matas med ett påhittat tal.
  else if ((fyllnad != null && fyllnad > 0.96) || teckenbyten < 3) tecken = 0.08;
  else {
    const db = teckenbyten - 12;
    tecken = Math.max(0.2, Math.exp(-(db * db) / (2 * 4 * 4)));
  }

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
  // Vinkeln viks först. Straffet handlar om hur långt från vågrätt kandidaten
  // ligger, och en skylt vriden 180° ligger vågrätt. Ankarvägen kan lämna en
  // ovikt vinkel eftersom den vet åt vilket håll skylten läses; utan vikningen
  // hade den kandidaten straffats som om den stod på högkant.
  const straff = a => 1 - 0.45 * Math.pow(Math.min(1, Math.abs(vikVinkel(a)) / 90), 1.5);
  let rakhet = straff(vinkel);
  if (forvantadVinkel !== null) {
    rakhet = Math.max(rakhet, straff(vinkel - forvantadVinkel));
  }

  /*
   * Ankarfaktorn. Den är det enda som får lyfta en poäng över 1, och det är
   * avsiktligt: en kandidat med ett uppmätt blått band, ljust omedelbart till
   * höger om det och rätt proportion är inte "lite bättre" än en ljus stapel
   * som råkar ha rätt form — den är en annan sorts bevis. Poängen används bara
   * till rangordning och mot `minPoang`, så ett tal över 1 gör ingen skada.
   */
  /*
   * `prior` är allt vi vet om kandidaten som INTE står att läsa ur dess egen
   * form: hur högt i bildrutan den sitter (`granskaSkyltruta`) och om den
   * ligger där en bakvagn säger att en skylt ska sitta. Den är skild från
   * `ankare` med flit — ankaret är ett
   * bevis kandidaten bär själv, priorn är omgivningens vittnesmål om den.
   */
  return {
    poang: form * (0.35 + 0.65 * storlek) * centrum * tecken * rakhet * ankare * prior,
    form, storlek, centrum, tecken, rakhet, ankare, prior,
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
 * @returns {Array<object>} {x,y,w,h,poang,poangRa,form,storlek,centrum,tecken,
 *          teckenbyten,forhallande,fyllnad,mjukZon,overHorisont,horisontStraffad,cyBild}
 *
 *          `poangRa` är poängen INNAN horisontstraffet och `poang` är den
 *          efter. Båda lämnas ut med flit: provbänkarna ska kunna mäta vad
 *          straffet tog utan att mutera modulens tal, och urvalet längst ned
 *          behöver den råa evidensen för att inte låta straffet tränga ut en
 *          kandidat helt. `horisontStraffad` är sant bara för det HÅRDA
 *          bandet — `Malsokare#krav` läser den.
 */
export function sokKandidater(kalla, omrade = null,
                              { arbetsbredd = 400, max = 6, forvantadVinkel = null,
                                skarmvinkel = null } = {}) {
  const m = kallMatt(kalla);
  const yta = omrade || { x: 0, y: 0, w: m.b, h: m.h };
  if (!(yta.w > 16 && yta.h > 16)) return [];

  // Hur hårt horisontregeln får gälla i just den här bildrutan. Se
  // `horisontlage` — och se att svaret aldrig är "stryk kandidaten".
  const hLage = horisontlage({ forvantadVinkel, skarmvinkel });

  // Minsta kandidat: 2,5 % av bildens bredd. En skylt mindre än så är under
  // tjugo pixlar bred i en telefonbild och innehåller inte tillräckligt med
  // information för att bli text — men den får finnas med, för zoomen kan
  // göra något av den.
  const s = skannaLjusa(kalla, yta, arbetsbredd, { minAndel: 0.025, minPx: 10, bla: true });
  const inv = 1 / s.skala;
  const ut = [];


  /*
   * ANKARVÄGEN FÖRST — det blå bandet.
   *
   * Båda vägarna delar på en enda skanning: samma nedskalning, samma
   * getImageData, samma gråskalesvep. Blåmasken byggdes i det svepet. Att
   * lägga till ankaret kostar alltså ingen ny genomgång av bilden, bara en
   * flödesfyllning över en mask som är tom i nästan hela bildrutan.
   */
  for (const a of blaAnkare(s)) {
    /*
     * PLATTGRINDEN, före allt annat. Ett uppmätt blått band bevisar att det
     * finns något blått och avlångt — det bevisar inte att kroppen till höger
     * om det är en vit platta med mörka tecken. Den blå dekaltexten på Caddyns
     * baklucka i 521e24d0 och VOLVO-emblemets blå oval i Regplat-URK är båda
     * ankare i dag, och båda vinner låset över den riktiga skylten.
     *
     * Här AVVISAS kandidaten på PIXELGRINDARNA, till skillnad från i
     * `hittaPlat`. Sökningen har ingen skyldighet att lämna ifrån sig något:
     * hittar den inget håller `Malsokare` bara på att leta i nästa bildruta,
     * och det är precis rätt beteende. Ett falskt lås kostar däremot tre
     * brända OCR-läsningar (MALSOK.brandForsok) innan spåret släpps.
     *
     * HORISONTEN AVVISAR INGET. Den lämnar bara flaggan `overHorisont`, och
     * det hårda straffet läggs på längst ned, när alla kandidater är kända.
     */
    const g = granskaSkyltruta(s.gra, s.b, s.h,
      { cx: a.cx, cy: a.cy, L: a.rw, W: a.rh, vinkel: a.vinkel },
      { bandAndel: a.euAndel, cyBild: (yta.y + a.cy * inv) / m.h, lage: hLage });
    if (!g.ok) continue;

    const p = poangsattKandidat({
      forhallande: a.forhallande,
      fyllnad: null,
      teckenbyten: a.teckenbyten,
      bredd: a.rw,
      cx: a.cx / s.b, cy: a.cy / s.h,
      ytaB: s.b,
      vinkel: a.vinkel, forvantadVinkel,
      ankare: ankarfaktor(a),
      prior: g.faktor,
    });
    ut.push({
      x: yta.x + a.minX * inv,
      y: yta.y + a.minY * inv,
      w: a.bw * inv,
      h: a.bh * inv,
      vinkel: a.vinkel,
      cx: yta.x + a.cx * inv,
      cy: yta.y + a.cy * inv,
      rw: a.rw * 1.03 * inv,
      rh: a.rh * 1.08 * inv,
      teckenbyten: a.teckenbyten,
      forhallande: a.forhallande,
      fyllnad: null,
      euAndel: a.euAndel,
      antagenBredd: a.antagenBredd,
      palitligTeckenrakning: a.palitligTeckenrakning,
      kantstodd: a.kantstodd,
      omvand: !!a.omvand,
      ankrad: true,
      mjukZon: g.mjukZon,
      overHorisont: g.overHorisont,
      cyBild: g.cyBild,
      ...p,
    });
  }

  /*
   * En ljusstapel som täcker samma sak som ett ankare är samma sak som
   * ankaret, sämre beskriven. Den ska inte tävla mot sitt eget bättre jag om
   * låset — två spår på en skylt gör bara att båda får färre bildrutor.
   *
   * MEN "SÄMRE BESKRIVEN" MÅSTE VARA MÄTT OCH INTE ANTAGET.
   *
   * Förut räckte det att blobbens mittpunkt låg inuti ankarets låda, utan att
   * poängen någonsin jämfördes, och blobben togs bort innan den ens kom in i
   * listan. Ankarlådan är som störst just när den är som minst trovärdig: när
   * det ljusa aldrig tog slut sätts bredden till 4,73 skylthöjder rakt av, och
   * den påhittade lådan svalt då ut den riktiga blobben. Att kvoten samtidigt
   * blir exakt 4,73 gör dessutom att formfaktorn blir 1,00 och kandidaten SER
   * bäst ut i poängen fastän bredden aldrig mättes. Värst av allt: tystandet
   * skedde även när ankarets egen poäng låg under låsgränsen, och då fanns
   * ingen kandidat kvar att låsa på alls — där den gamla koden hade låst på
   * blobben.
   *
   * Nu räknas blobbens poäng först, och ankaret får bara tysta den om det
   * faktiskt är det starkare beviset.
   *
   * POÄNGEN HÄR ÄR RÅ, alltså före horisontstraffet, och det är rätt sida att
   * fela åt. Straffet läggs på längst ned när alla kandidater är kända, så vid
   * det här laget FINNS det inte något straffat tal att jämföra med. Att
   * jämföra rått är dessutom det tystandet handlar om: frågan är vilken av två
   * beskrivningar av SAMMA fläck som är den bättre, och båda sitter per
   * definition på samma höjd i bildrutan — horisonten skiljer dem inte åt. Den
   * enda gång positionen spelar roll är raden nedan, och den är kvar.
   */
  const taxAvAnkare = (bx, by, bw2, bh2, blobbPoang, blobbOverHorisont) => {
    const mx2 = bx + bw2 / 2, my2 = by + bh2 / 2;
    return ut.some(a => a.ankrad &&
      mx2 >= a.x && mx2 <= a.x + a.w && my2 >= a.y && my2 <= a.y + a.h &&
      // Antagen bredd eller en poäng under låsgränsen är inte starkare bevis
      // än en uppmätt ljus kant. Då får blobben stå kvar och tävla.
      !a.antagenBredd && a.poang >= MALSOK.minPoang &&
      // Ett ankare OVANFÖR horisonten är aldrig det starkare beviset mot en
      // blobb under den. Utan den raden hade det hårda straffet kunnat läggas
      // på en vinnare som redan tystat sin egen ersättare — alltså en tyst
      // strykning bakvägen, precis det som skulle bort.
      (!a.overHorisont || blobbOverHorisont) &&
      a.poang >= blobbPoang);
  };

  for (const bl of s.blobbar) {
    /*
     * Samma grind på ljusstapeln. Här sitter de flesta av de nio falska
     * låsningarna: kromlisten över skylten i 2560.webp har förhållande 4,6 och
     * går rakt igenom dagens formgrind, Skoda-grillens ribbor i 1728543597268
     * likaså, och prislapparna i vindrutorna i 3b979c11 är vita rektanglar med
     * en enda stor mörk siffra. Ingen av dem har en skylts mörkandel.
     *
     * Blobben har ingen bandandel — det blå är per definition inte ljust och
     * kom aldrig med i blobben — så bandgrinden hoppas över och u-fönstret
     * börjar vid blobbens egen vänsterkant.
     */
    const g = granskaSkyltruta(s.gra, s.b, s.h,
      { cx: bl.cx, cy: bl.cy, L: bl.L, W: bl.W, vinkel: bl.vinkel },
      { cyBild: (yta.y + bl.cy * inv) / m.h, lage: hLage });
    if (!g.ok) continue;
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
      prior: g.faktor,
    });

    // Samma marginal som `hittaPlat` ger, så att OCR-steget får en ruta med
    // luft kring tecknen och inte klipper kanterna.
    const mx = bl.bw * 0.03 * inv, my = bl.bh * 0.08 * inv;
    const lx = yta.x + bl.minX * inv - mx, ly = yta.y + bl.minY * inv - my;
    const lw = bl.bw * inv + mx * 2, lh = bl.bh * inv + my * 2;
    if (taxAvAnkare(lx, ly, lw, lh, p.poang, g.overHorisont)) continue;
    ut.push({
      x: lx, y: ly, w: lw, h: lh,
      vinkel: bl.vinkel,
      cx: yta.x + bl.cx * inv,
      cy: yta.y + bl.cy * inv,
      rw: bl.L * 1.06 * inv,
      rh: bl.W * 1.16 * inv,
      teckenbyten, forhallande: bl.forhallande, fyllnad: bl.fyllnad,
      mjukZon: g.mjukZon, overHorisont: g.overHorisont, cyBild: g.cyBild, ...p,
    });
  }

  /*
   * HORISONTSTRAFFET — ETT STEG, OCH DET ÄR RELATIVT MED FLIT.
   *
   * Nu — och först nu — är alla kandidater kända, och frågan går att ställa
   * rätt: finns det något UNDER horisonten att förlora mot?
   *
   *   Ja  → kandidaterna ovanför avbildas in i det HÅRDA bandet
   *         [MALSOK.minPoang; PLATTGRIND.horisontTak]. Ett vägmärke eller en
   *         handlarlist rankas då under den riktiga skylten i samma bildruta,
   *         vilket är hela nyttan ägaren bad om.
   *   Nej → de där uppe är allt vi har. Då bär de bara den MJUKA lutningen och
   *         får tävla som vanligt. En bildruta där bara stötfångaren syns,
   *         eller där kameran lutar uppåt, behåller sin enda kandidat.
   *
   * ETT STEG, INTE TVÅ, OCH DET ÄR ÄNDRINGEN. Förut multiplicerade
   * `granskaSkyltruta` in det mjuka straffet 0,7 i `prior`, och det här stället
   * lade på det hårda ovanpå och golvade resultatet vid `MALSOK.minPoang`.
   * Golvet jämförde alltså mot ett tal som redan var sänkt en gång och såg
   * aldrig hela sänkningen: fyra av 104 syntetiska bildrutor med äkta svensk
   * skylt föll ändå under låsgränsen, och på riktigt foto gjorde
   * 521e24d0.avif flyttad till skyltmitt 0,28 det samma. Nu bär
   * `granskaSkyltruta` bara flaggorna och HELA sänkningen sker här, i en enda
   * avbildning — då finns det inget halvsänkt tal kvar att jämföra mot.
   *
   * OCH DET ÄR EN AVBILDNING, INTE EN MULTIPLIKATION MED ETT GOLV. Ett golv
   * bevarar inte ordningen: det klistrar ihop allt under sig till ETT tal, och
   * över ett fyra gånger brett band av rå poäng fick varje straffad kandidat
   * exakt 0,160. Rangordningen — hela skälet att straffa i stället för att
   * stryka — var utraderad just där. `horisontstraff` är i stället samma
   * multiplikation som förut, med linjen lyft så att den går genom punkten
   * (låsgränsen, låsgränsen): den sänker precis lika hårt, den kan aldrig ta
   * en kandidat som KUNDE ha låst under låsgränsen, och den bevarar ordningen
   * — strängt växande, ingen platt zon, och den enda diskontinuiteten ligger
   * på själva låsgränsen, där det inte finns något lås att missa. Se
   * härledningen och beviset för att den diskontinuiteten är oundviklig i
   * `horisontstraff`.
   *
   * `poangRa` sparas på varje kandidat — dels för att urvalet nedan behöver
   * den, dels för att den som läser ut en kandidat ska kunna se exakt vad
   * straffet tog. Straffet skrivs också in i `prior` av samma skäl.
   */
  for (const k of ut) k.poangRa = k.poang;
  const finnsUnder = ut.some(k => !k.overHorisont);
  for (const k of ut) {
    if (!k.mjukZon) continue;
    const hart = k.overHorisont && finnsUnder;
    const fore = k.poang;
    k.poang = horisontstraff(fore, hart);
    k.prior *= (fore > 0 ? k.poang / fore : 1);
    k.horisontStraffad = hart;
  }

  /*
   * URVALET, OCH DET ÄR ETT LISTPROBLEM SOM INTE GÅR ATT LAGA I POÄNGEN.
   *
   * `slice(0, max)` skar förut rakt av i den straffade listan, och då kunde
   * straffet tränga ut en kandidat helt. Mätt: Regpl-Heden.jpg beskuren så att
   * bara stötfångaren syns lägger den sanna skylten ovanför horisonten. Elva
   * OSTRAFFADE skräpkandidater under horisonten låg på 0,195–0,243 medan den
   * sanna skylten efter straffet låg på 0,169 — över låsgränsen, alltså inte
   * struken av poängen, men på plats 13 av 6 möjliga. IoU gick från 0,75 till
   * 0,00. Kandidaten upphörde att finnas, utan spår, och det är precis det
   * utfall hela omskrivningen fanns till för att bli av med. Ett golv kan
   * aldrig laga det: golvet vaktar låsGRÄNSEN, inte PLATSEN i listan.
   *
   * LÖSNINGEN ÄR RESERVERADE PLATSER MED TRE VILLKOR, OCH VART OCH ETT AV DEM
   * ÄR DÄR FÖR ATT ETT MÄTT FEL ANNARS KOMMER TILLBAKA. Efter snittet görs
   * högst `PLATTGRIND.horisontReserv` byten: de bäst bevisade kandidaterna
   * utanför snittet, A, tar plats av de sämst bevisade inne i snittet, B. Ett
   * byte sker bara om
   *
   *   1. A ÄR STRAFFAD. Annars föll A ut på sina egna meriter, och då är det
   *      inte straffet som trängde ut den — då finns inget att laga.
   *   2. A KAN FORTFARANDE LÅSA, alltså A:s poäng EFTER straffet ligger på
   *      eller över `MALSOK.minPoang`. En kandidat som ändå inte kan låsa
   *      behöver ingen reserverad plats, och utan det här villkoret gör
   *      reserven aktiv skada: en fasadbit ovanför horisonten med rå poäng
   *      0,155 hamnar efter straffet på 0,006, alltså längst ned i listan, men
   *      har fortfarande STARKARE rå poäng än en svag äkta skylt på 0,101 och
   *      knuffar ut den. Uppmätt i 521e24d0.avif med smuts, och det kostade ett
   *      lås (smuts 9 → 8) tills villkoret lades till.
   *   3. A ÄR BÄTTRE BEVISAD ÄN B, mätt i rå poäng. Bytet ska gå åt rätt håll:
   *      av två kandidater som BÅDA kan låsa får listan bara tappa den vars
   *      egna pixlar talade svagast för den.
   *
   * OCH B VÄLJS INTE PÅ RÅ POÄNG ENSAM. Villkor 2 skyddar den som kommer IN,
   * men ingenting skyddade den som kastades UT: B var helt enkelt den med
   * lägst RÅ poäng i snittet, och rå poäng är inte det som avgör lås — `poang`
   * är. Uppmätt över 174 bildrutor vräks en kandidat som kunde ha låst i två
   * av dem: stötfångar-Regpl-Heden en på poäng 0,219 och hogt-Regpl-Heden två
   * på 0,187 och 0,189. Därför står den som INTE kan låsa alltid först på tur
   * att åka — att tappa en kandidat som ändå aldrig kunde bli ett lås kostar
   * ingenting — och först när varje kandidat i snittet kan låsa faller valet
   * tillbaka på "svagast bevisad", där villkor 3 bevakar riktningen.
   *
   * FÖRETRÄDET ÄNDRAR INGET I DAGENS BÄNK, och det ska stå rakt ut: 0 av 174
   * bildrutor. I båda bildrutorna ovan ligger HELA snittet över låsgränsen
   * (0,187–0,215 respektive 0,219–0,243), så det finns ingen olåsbar att offra
   * i stället, och de bytena är dessutom rätt: den som kommer in är den sanna
   * skylten. Regeln finns för bildrutan bänken inte har, och den kan per
   * konstruktion inte kosta ett lås — den flyttar bara offret från någon som
   * kunde låsa till någon som inte kunde.
   *
   * I Regpl-Heden beskuren till stötfångaren är A den sanna skylten — plats 10
   * av 33 efter straffet, poäng 0,193 (över låsgränsen, villkor 2 håller), och
   * bildrutans STARKASTE råa kandidat: rå 0,9669 mot skräpets rå 0,2187–0,2448,
   * alltså fyrfaldig marginal.
   *
   * TVÅ RÄTTELSER, OCH BÅDA ÄR VÄRDA ATT LÄSA INNAN NÄSTA TAL SKRIVS HÄR:
   *   Det stod "plats 11", och en tidigare rapport påstod sig ha verifierat
   *   den siffran. Verifieringen kördes mot en duk på 225 px — `Math.trunc` i
   *   stället för `Math.round`. Ingen bänk i repot bygger den duken; alla
   *   använder `cv()` som avrundar till 226, och då är det plats 10. Ett tal
   *   som stämmer i en bildruta som inte finns är inte verifierat.
   *   Det stod också "0,9669 mot skräpets 0,219–0,243", vilket jämförde en RÅ
   *   poäng mot fem STRAFFADE. Slutsatsen höll, men meningen läste som om
   *   båda talen vore samma storhet. Rått mot rått är spannet 0,2187–0,2448.
   *
   * VARFÖR INTE "SKÄR TILL MAX INNAN STRAFFET": då bestämmer den råa evidensen
   * ensam, och en bildruta med sex starka vägmärken ovanför horisonten och en
   * svag men äkta skylt under den tappar skylten.
   * VARFÖR INTE EN FLÄTNING: en flätning av de två ordningarna varannan plats
   * mättes också. Den räddade ingenting utöver de här bytena och kostade två
   * lås på granskningsbänken (smuts 9 → 8, vriden 17 → 16), därför att den
   * kastade plats fyra och fem i straffordningen. Skillnaden mot reserven är
   * att flätningen byter utan villkor; reserven byter bara den som straffet
   * faktiskt trängde ut, och bara mot någon som är sämre bevisad.
   * VARFÖR TVÅ PLATSER OCH INTE EN ELLER TRE: mätt, se
   * `PLATTGRIND.horisontReserv`.
   *
   * KOSTNADEN ÄR NOLL I DEN VANLIGA BILDRUTAN: finns ingen straffad kandidat
   * faller villkor 1 för alla, inget byte sker, och listan blir bit för bit
   * den `slice` gav.
   */
  const efterStraff = ut.slice().sort((a, b) => b.poang - a.poang);
  if (efterStraff.length <= max) return efterStraff;

  const valda = efterStraff.slice(0, max);
  // Villkor 1 och 2 sitter i filtret, den bäst bevisade söker först.
  const sokande = efterStraff.slice(max)
    .filter(k => k.horisontStraffad && k.poang >= MALSOK.minPoang)
    .sort((a, b) => b.poangRa - a.poangRa);

  let byten = 0;
  for (const inn of sokande) {
    if (byten >= PLATTGRIND.horisontReserv) break;
    // Vem står på tur att åka? Den som inte kan låsa före den som kan, och
    // inom samma grupp den sämst bevisade.
    let b = 0;
    for (let i = 1; i < valda.length; i++) {
      const kanI = valda[i].poang >= MALSOK.minPoang;
      const kanB = valda[b].poang >= MALSOK.minPoang;
      if (kanI !== kanB) { if (!kanI) b = i; continue; }
      if (valda[i].poangRa < valda[b].poangRa) b = i;
    }
    if (inn.poangRa <= valda[b].poangRa) continue;   // villkor 3
    valda[b] = inn;
    byten++;
  }

  valda.sort((a, b) => b.poang - a.poang);
  return valda;
}

/**
 * Beskär, skala upp och tröskla en bildruta till något en OCR-motor klarar.
 *
 * @param {CanvasImageSource} kalla   video eller canvas
 * @param {object} roi                {x,y,w,h} i källans pixlar
 * @returns {HTMLCanvasElement}
 */
export function forbehandla(kalla, roi,
                            { malHojd = 96, kapaEuFalt = true, lutning = 0, vridning = 0,
                              euAndel = null, vridenRuta = null } = {}) {
  /*
   * `vridenRuta` säger att `roi` beskriver en *vriden* rektangel: mitten i
   * cx/cy och sidorna i rw/rh, mätta längs skyltens egna axlar. Är den falsk
   * är roi den vanliga axelparallella rutan och allt nedan går den gamla
   * vägen, bit för bit — de tio pipelinefallen mäter exakt samma sak som förut.
   *
   * DET VAR TVÅ FRÅGOR SOM DELADE PÅ ETT ENDA TAL, OCH DE DREV ISÄR I DET
   * VANLIGASTE FALLET AV ALLA.
   *
   * Förut var `vridning` både "vrid så här många grader" OCH omkopplaren för
   * om den uppmätta rektangeln alls skulle användas. Vinkel exakt 0 är inte
   * ett kantfall: `blaBand` sätter platvinkel = 0 så fort bandets L/W ligger
   * under 1,3 — alltså i hela spannet 1,10–1,30 — och en skylt sedd rakt
   * framifrån ger axel 90°, vilket viks till 0. Då blev omkopplaren falsk,
   * hela ankarmätningen kastades, och beskärningen tog roi.w/roi.h: den exakta
   * uppmätta lådan UTAN den marginal som ligger i rw/rh. Kanttecknen klipptes,
   * och den ankrade vägen läste sämre än reserven för den geometri som är
   * absolut vanligast.
   *
   * Nu är frågorna åtskilda. Grundvärdet härleds ur vridningen så att äldre
   * anrop beter sig precis som förut.
   */
  const vriden = vridenRuta === null ? !!vridning : !!vridenRuta;
  const rw = vriden ? (roi.rw ?? roi.w) : roi.w;
  const rh = vriden ? (roi.rh ?? roi.h) : roi.h;
  const skala = malHojd / rh;
  const bredd = Math.max(1, Math.round(rw * skala));
  const hojd  = Math.max(1, Math.round(malHojd));

  const c = document.createElement('canvas');
  c.width = bredd; c.height = hojd;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (vriden) {
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

  /*
   * Hur mycket av vänsterkanten som är EU-band.
   *
   * Har sökningen ankrat på bandet VET vi bredden — den är uppmätt, inte
   * gissad — och då kapas precis den. Taket på 0,14 finns för att en
   * överskattad mätning aldrig ska få äta första tecknet: bandet slutar vid
   * 10 % av skyltens bredd och första tecknet börjar vid ungefär 15 %.
   *
   * Utan ankare står den gamla vägen kvar oförändrad: fast tiondel, och bara
   * när anroparen ber om det.
   */
  const kapa = euAndel != null
    ? Math.round(bredd * Math.min(euAndel * 1.06, 0.14))
    : (kapaEuFalt ? Math.round(bredd * 0.105) : 0);

  /*
   * Gråskala med ögats viktning, och histogram i samma svep — men histogrammet
   * räknas bara på det som ligger TILL HÖGER om bandet.
   *
   * Det var en verklig felkälla. Bandet är djupt mörkblått och fyller en
   * tiondel av bilden med pixlar nära noll. De drog ner både den andra
   * percentilen och Otsu-tröskeln, alltså på en yta som ändå skulle vitmålas
   * några rader längre ner. Resultatet blev en tröskel som satt för lågt och
   * tecken som blev fetare än de är — och feta tecken flyter ihop, vilket är
   * precis den felläsning bandet skulle skydda mot.
   */
  const gra = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  let raknade = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
    gra[i] = v;
    if ((i % bredd) >= kapa) { hist[v]++; raknade++; }
  }
  if (!raknade) { for (let i = 0; i < n; i++) hist[gra[i]]++; raknade = n; }

  // Kontraststräckning mellan 2:a och 98:e percentilen. Utan den blir en
  // skylt i motljus en grå klump där trösklingen tar fel överallt.
  const lag = percentil(hist, raknade, 0.02);
  const hog = percentil(hist, raknade, 0.98);
  const spann = Math.max(1, hog - lag);
  for (let i = 0; i < n; i++) {
    gra[i] = Math.max(0, Math.min(255, ((gra[i] - lag) * 255) / spann));
  }

  // Otsu: låt bilden själv bestämma var gränsen går mellan text och botten.
  // Även den räknas utan bandet, av samma skäl.
  const trosk = otsu(gra, bredd, kapa);

  // Bandet vitmålas hellre än beskärs — då behåller vi marginalen kring
  // tecknen, och motorn ser en textrad som börjar med luft.
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

/**
 * Otsus tröskel.
 *
 * `bredd` och `kapa` är frivilliga och används bara av `forbehandla`: de
 * hoppar över de `kapa` första kolumnerna, alltså EU-bandet. Utan dem räknas
 * hela bilden precis som förut, vilket är vad `skannaLjusa` vill ha.
 */
function otsu(gra, bredd = 0, kapa = 0) {
  const hist = new Uint32Array(256);
  let n = 0;
  if (bredd > 0 && kapa > 0) {
    for (let i = 0; i < gra.length; i++) {
      if ((i % bredd) < kapa) continue;
      hist[gra[i]]++; n++;
    }
  }
  if (!n) { hist.fill(0); for (let i = 0; i < gra.length; i++) hist[gra[i]]++; n = gra.length; }
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
export async function lasRuta(kalla, roi, { fardigMatt = null } = {}) {
  const tider = { hittaMs: 0, forbMs: 0, ocrMs: 0, ocrAntal: 0, ankrad: false };
  const klocka = (namn, fn) => {
    const t0 = performance.now();
    const r = fn();
    tider[namn] += performance.now() - t0;
    return r;
  };
  const klockaOcr = async bild => {
    const t0 = performance.now();
    const r = await lasBild(bild);
    tider.ocrMs += performance.now() - t0;
    tider.ocrAntal++;
    return r;
  };

  /*
   * Snäva in på skylten när den går att hitta. Går den inte att hitta får
   * hela rutan duga — hellre ett försök än inget.
   *
   * `fardigMatt` är en mätning sökningen redan gjort. Kom kandidaten från
   * ankarvägen är skyltens kanter, vinkel och bandbredd redan uppmätta, och
   * att skanna om samma yta här hade varit att kasta bort den mätningen och
   * betala för en ny sämre. Det var en ren dubbelkörning: samma nedskalning,
   * samma flödesfyllning, en gång per OCR-varv.
   */
  const traff = fardigMatt || klocka('hittaMs', () => hittaPlat(kalla, roi));
  const snav = traff || roi;
  tider.ankrad = !!(traff && traff.ankrad);

  /*
   * Det blå EU-fältet.
   *
   * Ankrad kandidat: bandet är uppmätt och ligger med i beskärningen, så det
   * MÅSTE kapas — och kapas precis så brett som det mättes.
   *
   * Ljusstapelvägen: bandet är mörkt, så lokaliseringen har redan lämnat det
   * utanför. Kapar vi då ytterligare en tiondel äter vi första tecknet — M
   * blev U, och det såg ut som ett fel i motorn. Kapningen behövs bara när vi
   * inte hittade skylten och skickar in hela rutan.
   */
  const euAndel = snav.euAndel ?? null;
  const kapaEuFalt = !traff;

  /*
   * Lutar skylten i bild rätas den upp redan i beskärningen. Vinkeln kommer
   * från sökningen och kostar ingen extra OCR-körning.
   *
   * `vridenRuta` och `vridning` är två skilda besked, och det är hela poängen:
   * en ankrad skylt sedd RAKT framifrån har vinkel 0 men en uppmätt rektangel
   * som ska användas. Slogs de ihop föll den vanligaste geometrin av alla ur
   * ankarvägen och beskars utan marginal. Se `forbehandla`.
   */
  const vridenRuta = !!(traff?.ankrad ||
    Math.abs(vikVinkel(snav.vinkel || 0)) >= VINKEL_DODBAND);
  let vridning = vridenRuta ? (snav.vinkel || 0) : 0;

  // Rakt på först. Går det bra behöver vi inte röra vinkeln alls.
  const rak = klocka('forbMs',
    () => forbehandla(kalla, snav, { kapaEuFalt, vridning, vridenRuta, euAndel }));
  let bast = { plat: null, sakerhet: 0, bild: rak, tider };

  const r0 = await klockaOcr(rak);
  if (r0.plat) bast = { plat: r0.plat, sakerhet: r0.sakerhet, bild: rak, tider };
  if (r0.plat && r0.sakerhet >= 80) return bast;

  /*
   * Huvudaxeln vet vilken linje skylten ligger längs, men inte åt vilket håll
   * den läses — en skylt och samma skylt upp och ner ger identiska moment. Vid
   * små lutningar spelar det ingen roll: en bil som lutar 20° lutar 20°, den
   * står inte på taket. Vid liggande telefon gör det det, för då är ±90° två
   * helt olika bilder. Prövas bara när första försöket inte gav någon skylt,
   * så den kostar ingenting i normalfallet.
   */
  if (!bast.plat && Math.abs(vikVinkel(vridning)) > 60) {
    const vand = klocka('forbMs',
      () => forbehandla(kalla, snav, { kapaEuFalt, vridning: vridning + 180, vridenRuta, euAndel }));
    const rv = await klockaOcr(vand);
    if (rv.plat) {
      bast = { plat: rv.plat, sakerhet: rv.sakerhet, bild: vand, tider };
      vridning += 180;
      if (rv.sakerhet >= 80) return bast;
    }
  }

  // Annars: mät lutningen och räta upp. Mätningen kostar ingen OCR-körning,
  // så det är billigare än att pröva sig fram med flera gissningar.
  const lutning = klocka('forbMs', () => uppskattaLutning(bast.bild));
  if (lutning) {
    const rat = klocka('forbMs',
      () => forbehandla(kalla, snav, { kapaEuFalt, lutning, vridning, vridenRuta, euAndel }));
    const r1 = await klockaOcr(rat);
    // En giltig skylt slår alltid ingen skylt. Att jämföra säkerheten först
    // vore fel: motorn rapporterar ibland 0 % även för en läsning som
    // stämmer, och då kastades det rätta svaret bort.
    if (r1.plat && (!bast.plat || r1.sakerhet > bast.sakerhet)) {
      bast = { plat: r1.plat, sakerhet: r1.sakerhet, bild: rat, tider };
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
  /*
   * Ankrad kandidat: sökningen har redan mätt upp skyltens kanter, dess vinkel
   * och bandets bredd. Då finns ingenting kvar att leta efter — beskär på
   * mätningen och läs. Det tar bort en hel skanning per OCR-varv och, viktigare,
   * det behåller den bättre av de två mätningarna i stället för att skriva över
   * den med en sämre.
   */
  if (kandidat.ankrad && kandidat.rw && kandidat.rh) {
    return lasRuta(kalla, kandidat, { fardigMatt: kandidat });
  }
  /*
   * Ett SPÅR från `Malsokare` bär mätningen i `matt` och har bara den
   * utjämnade lådan på ytan. Får vi ett sådant ska den råa mätningen användas,
   * precis som `#steg` gör — annars kastas skyltens uppmätta kanter och vinkel
   * bort och kvar blir en axelparallell låda. Det syntes tydligast i liggande
   * läge: samma skylt läses till MLK907 med 87 % ur ankarmätningen och till
   * ingenting alls ur lådan.
   */
  if (kandidat.matt?.ankrad && kandidat.matt.rw && kandidat.matt.rh) {
    return lasRuta(kalla, kandidat.matt, { fardigMatt: kandidat.matt });
  }
  const mx = kandidat.w * 0.06, my = kandidat.h * 0.14;
  return lasRuta(kalla, {
    x: kandidat.x - mx, y: kandidat.y - my,
    w: kandidat.w + mx * 2, h: kandidat.h + my * 2,
  });
}

/* Grundvärden för målsökningen. Motiveringen står i docs/malsokning.md. */
export const MALSOK = {
  bildrutorForLas: 8,   // ~1 s vid 120 ms mellan sökningar
  /*
   * Ankrade kandidater låser efter tre bildrutor i stället för åtta, alltså
   * efter ~0,36 s i stället för ~0,96 s.
   *
   * Det är inte en uppmjukning av kravet, det är ett annat bevis. Åtta
   * bildrutor krävdes därför att en ljus fläck med rätt form är svag evidens
   * och tiden fick göra jobbet: en solreflex består inte åtta bildrutor i rad
   * på samma plats med samma storlek. En kandidat som har ett mättat blått
   * band, ljust omedelbart till höger om bandet, rätt proportion mellan höjd
   * och uppmätt bredd OCH sex mörka pelare i kroppen har redan lämnat fyra
   * oberoende bevis i en enda bildruta. Tre bildrutor räcker då för att utesluta
   * en engångsartefakt, och de sparade 0,6 sekunderna är den enskilt största
   * posten i väntetiden till första svar.
   */
  bildrutorForLasAnkrad: 3,
  tappForLas: 3,        // en låst kandidat får försvinna 3 bildrutor
  tappForSpar: 2,       // en olåst släpps snabbare
  minPoang: 0.16,       // under det låser vi inte, hur ensam kandidaten än är
  brandForsok: 3,       // så många läsningar utan giltig skylt bränner låset
  glidning: 0.4,        // hur mycket av den nya positionen som slår igenom
  maxSpar: 12,
  /*
   * Så länge minns spårningen ett spår den nyss släppte, för att kunna
   * återknyta det i stället för att mynta ett nytt id.
   *
   * Utan det tappade rösträkningen sin urna varje gång skylten blinkade bort.
   * Ett låst spår släpps på den FJÄRDE missade sökbildrutan, alltså efter
   * 480 ms — `tappForLas` 3 är hur många det får missa, inte när det släpps,
   * och gränsen är `tappade > tak`. (Ett olåst spår har `tappForSpar` 2 och
   * släpps på den tredje missen, 360 ms. Här stod förut 360 ms för det låsta
   * också; ommätt mot klassen är det 480.) Det räcker ändå gott att bilen
   * framför kör in i en solreflex eller under en bro.
   * Kandidaten dök upp igen som ett nytt spår med nytt id, urnan var därmed en
   * annan, och räkningen började om från noll fastän kameran hela tiden tittat
   * på samma skylt. 1500 ms täcker glimtar, skakningar och motljus utan att
   * knyta ihop två olika bilar — en bil hinner inte bytas ut på den tiden utan
   * att lådan flyttar sig mer än matchningen tillåter.
   */
  aterforeningMs: 1500,
  slapptaMax: 8,        // så många nyss släppta spår minns vi
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
    // Nyss släppta spår, för återförening. Se MALSOK.aterforeningMs.
    this.slappta = [];
  }

  /**
   * SPÅRLISTAN LIGGER BAKOM EN GRIND, OCH DET ÄR INTE PRYDNAD — DET ÄR DET SOM
   * GÖR SPÖKLÅSET OMÖJLIGT ATT NÅ.
   *
   * FELET SOM VAR HÄR. `lastId` nollades bara i tappade-grenen. Skars det
   * låsta spåret i stället bort av `maxSpar`-snittet stod `lastId` kvar och
   * pekade på ett spår som inte längre fanns. `get last()` gav då null, och
   * eftersom `if (this.lastId === null) this.#valjLas()` såg ett lastId som
   * inte var null kördes valet ALDRIG igen. Låset var ett spöke: uppmätt låser
   * en straffad äkta skylt på 8 bildrutor, tre bildrutor med fem nya
   * skräpkandidater var trycker upp spårantalet till 12, skylten skärs bort —
   * och därefter kan 20 lugna bildrutor med BARA skylten i bild inte laga det.
   * `spar.length` 1, `traffar` 20, `poang` 0,171, `pahang` 1,00, och `last`
   * fortfarande null. `#lagesText` säger "Låser på skylt…" i all evighet,
   * `#las` läser aldrig eftersom `last` är null, och `rapporteraLasning` kan
   * inte ens bränna spåret. Enda vägen ut var `nollstall()`, alltså stop/start
   * på kameran.
   *
   * VARFÖR EN GRIND OCH INTE EN RAD TILL I `mata`. En rad till i `mata` lagar
   * den väg som finns i dag. Den lagar inte den fjärde vägen någon lägger till
   * om ett halvår. Invarianten är enkel och ska hållas av koden själv:
   *
   *      lastId pekar alltid på ett spår som FINNS i spar, eller är null.
   *
   * Varje sätt att TA BORT ett spår måste skriva om listan — `push` kan bara
   * lägga till, och ett tillägg kan inte göra `lastId` föräldralöst. Därför
   * fångar en sättare på `spar` varje borttagningsväg som finns och varje som
   * kan tillkomma. En framtida `splice` rakt i listan går förbi sättaren, och
   * därför kör `mata` dessutom `#sakraLas()` innan låset läses — då fångas
   * även den, i samma bildruta som den skedde.
   *
   * BÄNKEN ÄR prov/skyltar/sparlista.html. Ingen annan bänk i repot kör
   * `maxSpar`-snittet alls: matning.html matar samma stillbild om och om igen,
   * så spårantalet passerar aldrig 6–7. Den sidan matar `Malsokare` direkt med
   * växande skräp tills listan svämmar över, splicear dessutom bort det låsta
   * spåret rakt ur listan för att pröva den fjärde vägen, och kräver att appen
   * låser igen utan `nollstall()`.
   */
  get spar() { return this._spar; }
  set spar(lista) { this._spar = lista; this.#sakraLas(); }

  /**
   * Nollar låset om det pekar på ett spår som inte finns i listan längre, så
   * att `#valjLas()` får köra igen. Att sätta `sisteOrsak` är halva poängen:
   * ett lås som försvinner utan orsak är ett lås ingen kan felsöka.
   */
  #sakraLas() {
    if (this.lastId == null) return;               // täcker även undefined
    if (this._spar.some(s => s.id === this.lastId)) return;
    this.lastId = null;
    this.sisteOrsak = 'borta';
  }

  get last() { return this.spar.find(s => s.id === this.lastId) || null; }

  nollstall() {
    this.spar = []; this.lastId = null; this.sisteOrsak = null; this.slappta = [];
  }

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
      // Ett spår räknas som ankrat så snart det setts med blått band en gång.
      // Bandet kan blinka bort en bildruta i en solreflex utan att skylten
      // slutade vara en skylt, och att tappa låskravet då hade varit att låta
      // en enstaka dålig bildruta straffa den starkaste kandidaten vi har.
      if (k.ankrad) { s.ankrad = true; s.ankradeTraffar++; }
    }

    // Glöm det som varit borta för länge innan vi försöker återknyta.
    this.slappta = this.slappta.filter(s => nu - s.sistSedd <= this.k.aterforeningMs);

    for (const l of lediga) {
      if (l.tagen) continue;
      const aterfunnet = this.#aterforena(l.k, nu);
      if (aterfunnet) { this.spar.push(aterfunnet); continue; }
      this.spar.push({
        id: this._nastaId++,
        x: l.k.x, y: l.k.y, w: l.k.w, h: l.k.h,
        poang: l.k.poang, matt: l.k,
        traffar: 1, tappade: 0, sistSedd: nu,
        ankrad: !!l.k.ankrad, ankradeTraffar: l.k.ankrad ? 1 : 0,
        forstSedd: nu,
        ocrForsok: 0, ocrBom: 0, ocrTraffar: 0, brand: false,
        // Se `rapporteraLasning`: ett spår som spottar ur sig en NY skylt varje
        // varv hittar på, och det går bara att se genom att jämföra hasharna.
        sisteHash: null, upprepade: 0,
        // Sätts av `#valjLas` och nollställs aldrig. `#slapp` vräker aldrig ett
        // spår som en gång varit lås — dess röster är de enda i urnan som redan
        // är värda något.
        varLas: false,
      });
    }


    const kvar = [];
    for (const s of this.spar) {
      const tak = s.id === this.lastId ? this.k.tappForLas : this.k.tappForSpar;
      if (s.tappade > tak) {
        if (s.id === this.lastId) { this.lastId = null; this.sisteOrsak = 'tappad'; }
        this.#slapp(s);
        continue;
      }
      kvar.push(s);
    }
    // Sortera på poäng och håll listan kort. Ett spår som ingen tittar på
    // kostar ingenting, men tusen gör det.
    kvar.sort((a, b) => b.poang - a.poang);
    const { behall, bort } = this.#skarSparlista(kvar);
    // ALLT SOM SKÄRS BORT SKA I URNAN. Förut la bara tappade-grenen sina spår
    // i `slappta`, och det som snittet skar bort försvann utan spår: nästa
    // bildruta myntade ett nytt id åt samma skylt, rösträkningens urna var
    // borta och `#aterforena` hade ingenting att knyta ihop.
    for (const s of bort) this.#slapp(s);
    this.spar = behall;

    // Fångar en borttagning som skett rakt i listan, förbi sättaren på `spar`.
    // Se grinden vid `set spar`.
    this.#sakraLas();
    if (this.lastId === null) this.#valjLas();
    for (const s of this.spar) s.last = s.id === this.lastId;
    return { spar: this.spar, last: this.last };
  }

  /**
   * Lägger ett släppt spår i urnan. Ett spår som lämnar `spar` ska ALLTID gå
   * genom den här, oavsett varför det lämnade — det är urnan `#aterforena`
   * letar i, och rösträkningens röster hänger på spårets id.
   *
   * OCH URNAN FÅR INTE SPOLAS AV SKRÄP. Förut kom hit bara ett spår i taget,
   * från tappade-grenen, och `shift()` — släng den äldsta — dög. Nu kommer
   * även det som `maxSpar`-snittet skar bort, och det kan vara nio spår i en
   * enda bildruta. Med `shift()` hade nio nyfödda fläckar spolat ut precis det
   * urnan finns till för: den skylt som blinkade bort för tre bildrutor sedan
   * och som `#aterforena` väntar på. Den har många `traffar`; skräpet har en.
   * Därför slängs den med SVAGAST bevis, och vid lika den som setts för längst
   * sedan — den ligger ändå närmast att falla ur `aterforeningMs`-fönstret.
   *
   * MEN "SVAGAST BEVIS" ÄR BARA RÄTT NÄR SKRÄPET ÄR NYFÖTT, och det stod inte
   * här förut. Är skräpet i stället GAMMALT vänds regeln bakvänd och slänger
   * exakt det urnan finns till för. Reproducerat mot klassen: tolv stabila
   * reflexer matas i 60 bildrutor och når `traffar` 60–72; skylten kommer in,
   * låser och hinner till `traffar` 8. Försvinner skylten samtidigt som
   * snittet skär bort reflexerna väljer regeln ovan LÅSET som offer, eftersom
   * 8 < 72. Urnan blir [72 ×8], låset är borta, och skylten som kommer
   * tillbaka myntas som ett nytt id — precis den regression `#aterforena`
   * finns till för att stoppa.
   *
   * Genom appen går det inte att nå i dag: `sokKandidater` lämnar aldrig mer
   * än sex kandidater per bildruta, och med det taket har låset alltid fler
   * `traffar` än det som skärs bort. Men `Malsokare` är en exporterad klass,
   * repots egen bänk matar den med åtta till nio kandidater per bildruta, och
   * ett tak som råkar hålla i dag är inget skydd. Därför är låset undantaget
   * uttryckligen: det spår appen just läste text ur är det ENDA i urnan vars
   * röster redan är värda något, och det ska aldrig vara offret.
   *
   * `sparlista.html` avsnitt 6 kunde inte se det här — provet matar bara
   * NYFÖTT skräp (traffar 8 mot 1) och är därmed konstruerat så att den gamla
   * regeln alltid vinner. Ett prov som bara kan bekräfta är inget prov.
   */
  #slapp(s) {
    this.slappta.push(s);
    if (this.slappta.length <= this.k.slapptaMax) return;

    // Två svep. Först bland dem som ALDRIG varit lås — de får alltid åka
    // först, hur mogna de än är. Hittas ingen sådan är hela urnan ex-lås, och
    // då gäller samma svagast-bevis-regel inom den gruppen; listan får inte
    // växa förbi sitt tak bara för att allt i den är skyddat.
    const valj = (kravVarLas) => {
      let sv = -1;
      for (let i = 0; i < this.slappta.length; i++) {
        const a = this.slappta[i];
        if (!kravVarLas && a.varLas) continue;
        if (sv < 0) { sv = i; continue; }
        const b = this.slappta[sv];
        if (a.traffar < b.traffar || (a.traffar === b.traffar && a.sistSedd < b.sistSedd)) sv = i;
      }
      return sv;
    };

    let sv = valj(false);
    if (sv < 0) sv = valj(true);
    this.slappta.splice(sv, 1);
  }

  /**
   * Skär spårlistan till `maxSpar` — MED SAMMA TVÅ SKYDD SOM KANDIDATLISTAN
   * HAR, och av samma skäl.
   *
   * Ett rakt `slice` på poäng skar bort vad som helst, och två saker som inte
   * fick skäras bort låg längst ned per konstruktion:
   *
   *   LÅSET. Skars det låsta spåret bort blev låset ett spöke — se grinden vid
   *   `set spar` för hela mätningen. Grinden lagar följden (låset nollas och
   *   `#valjLas` får köra igen); den här raden lagar ORSAKEN. Ett spår som
   *   appen just nu läser text ur ska inte kunna trängas undan av tolv nyfödda
   *   fläckar som ingen ännu vet något om. Det är ingen reserv utan en
   *   garanti, och den kostar inget: låset har redan visat sig i flera
   *   bildrutor i rad.
   *
   *   DET STRAFFADE SPÅRET. Horisontstraffet parkerar en straffad kandidat i
   *   [0,16; 0,228] per konstruktion, alltså längst ned i poängordningen. Utan
   *   reserverad plats är det ALLTID den straffade som skärs bort först — och
   *   en straffad kandidat är ofta den sanna skylten, precis det som gjorde
   *   reserven nödvändig i kandidatlistan. Samma tre villkor gäller här: bara
   *   straffade spår söker, bara de som fortfarande kan låsa, och bara mot
   *   någon som är sämre bevisad. Och samma val av offer: den som inte kan
   *   låsa åker före den som kan.
   *
   * RÅ EVIDENS FÖR ETT SPÅR är `matt.poangRa`, alltså den råa poängen i den
   * bildruta spåret senast sågs. Spårets egen `poang` är ett glidande medel av
   * den STRAFFADE poängen och duger inte som bevis om pixlarna — det är exakt
   * den skillnaden reserven bygger på.
   *
   * @returns {{behall:Array, bort:Array}}
   */
  #skarSparlista(kvar) {
    if (kvar.length <= this.k.maxSpar) return { behall: kvar, bort: [] };
    const g = this.k.minPoang;
    const ra = s => (s.matt && typeof s.matt.poangRa === 'number')
      ? s.matt.poangRa : s.poang;

    const behall = kvar.slice(0, this.k.maxSpar);
    const bort = kvar.slice(this.k.maxSpar);

    // Vem i snittet står på tur att åka? Aldrig låset. Den som inte kan låsa
    // före den som kan. Inom samma grupp den sämst bevisade. -1 = ingen.
    const paTur = () => {
      let b = -1;
      for (let i = 0; i < behall.length; i++) {
        if (behall[i].id === this.lastId) continue;
        if (b < 0) { b = i; continue; }
        const kanI = behall[i].poang >= g, kanB = behall[b].poang >= g;
        if (kanI !== kanB) { if (!kanI) b = i; continue; }
        if (ra(behall[i]) < ra(behall[b])) b = i;
      }
      return b;
    };

    // Låset först, och utan villkor — det är en garanti, inte en reserv.
    const iLas = bort.findIndex(s => s.id === this.lastId);
    if (iLas >= 0) {
      const b = paTur();
      if (b >= 0) { const gammal = behall[b]; behall[b] = bort[iLas]; bort[iLas] = gammal; }
    }

    // Sedan de reserverade platserna åt straffade spår.
    const sokande = bort
      .map((s, i) => ({ s, i }))
      .filter(x => x.s.matt && x.s.matt.horisontStraffad && x.s.poang >= g)
      .sort((x, y) => ra(y.s) - ra(x.s));
    let byten = 0;
    for (const { s, i } of sokande) {
      if (byten >= PLATTGRIND.horisontReserv) break;
      const b = paTur();
      if (b < 0) break;
      if (ra(s) <= ra(behall[b])) continue;
      bort[i] = behall[b];
      behall[b] = s;
      byten++;
    }
    return { behall, bort };
  }

  /**
   * Knyter ihop en kandidat med ett spår som nyss släpptes.
   *
   * VARFÖR DET HÄR BEHÖVS: rösträkningens urna nycklas på spårets id. Mintas
   * ett nytt id ligger de röster som redan lagts kvar i sin gamla urna och
   * röstas aldrig mer i — de bleknar bort, och räkningen börjar om från noll
   * fastän kameran hela tiden tittade på samma skylt. Ett låst spår släpps på
   * den fjärde missade sökbildrutan, alltså 480 ms, och ett olåst på den
   * tredje, 360 ms — båda klarar en solreflex eller en bro utan vidare.
   * Föraren fick sitt svar senare i exakt det scenario — glimtar, skakningar,
   * motljus — som flerbildskonsensus finns för.
   *
   * OCH URNAN LÄCKTE PÅ ETT ANDRA STÄLLE. Bara tappade-grenen la sina spår
   * här; det som `maxSpar`-snittet skar bort försvann utan spår. Se
   * `#slapp` och `#skarSparlista` — nu går varje spår som lämnar `spar` samma
   * väg in i urnan.
   *
   * Matchningen är slappare än den mellan två bildrutor i följd, för mer tid
   * har gått, men den är fortfarande en matchning: ligger rutan på fel ställe
   * eller har bytt storlek är det en annan bil, och då ska det bli ett nytt
   * spår med en egen urna. Två bilar i bild får aldrig blandas ihop.
   *
   * `brand` följer med tillbaka. Ett spår som brunnit upp ska inte kunna tvätta
   * sig rent genom att blinka bort en halv sekund.
   */
  #aterforena(k, nu) {
    let bast = -1, bastAvst = Infinity;
    for (let i = 0; i < this.slappta.length; i++) {
      const s = this.slappta[i];
      if (nu - s.sistSedd > this.k.aterforeningMs) continue;
      const ref = Math.max(s.w, k.w);
      const avst = Math.hypot((k.x + k.w / 2) - (s.x + s.w / 2),
                              (k.y + k.h / 2) - (s.y + s.h / 2)) / ref;
      const storleksbyte = k.w / s.w;
      if (avst > 1.2 || storleksbyte < 0.45 || storleksbyte > 2.2) continue;
      if (avst < bastAvst) { bastAvst = avst; bast = i; }
    }
    if (bast < 0) return null;

    const s = this.slappta.splice(bast, 1)[0];
    s.x = k.x; s.y = k.y; s.w = k.w; s.h = k.h;
    s.poang = k.poang; s.matt = k;
    s.traffar++; s.tappade = 0; s.sistSedd = nu;
    if (k.ankrad) { s.ankrad = true; s.ankradeTraffar++; }
    return s;
  }

  /**
   * Så många bildrutor det här spåret behöver innan det får låsas.
   *
   * SNABBLÅSET GES INTE TILL DEN SOM HORISONTEN STRAFFAT, och det är mätt och
   * inte principryttande. Regpl-Heden.jpg: bildrutans enda ANKRADE kandidat är
   * en gul husfasad högst upp (cy 0,238) som horisontstraffet trycker ner i det
   * hårda bandet [16; 22,8], medan de två riktiga skyltarna ligger på 44 och 25
   * men är OANKRADE. Med snabblåset låste den ankrade falska kandidaten på bildruta 3
   * — långt innan de riktiga hann till sina 8 — och bänken tappade ett lås
   * (15/22 → 14/22) trots att rangordningen var alldeles rätt.
   *
   * Skälet snabblåset finns är att ett ankare är fyra oberoende bevis i en och
   * samma bildruta (se `bildrutorForLasAnkrad`). En kandidat som bildrutans
   * egen geometri talar emot har ett bevis mindre, och ska då låsas på vanliga
   * villkor. Det KOSTAR ALDRIG ETT LÅS — bara 5 bildrutor, 600 ms — och det
   * gäller bara den som faktiskt fått straffet, alltså när det samtidigt finns
   * en kandidat under horisonten. En ensam skylt högt i bildrutan bär inget
   * straff och behåller sitt snabblås.
   */
  krav(s) {
    const straffad = !!(s.matt && s.matt.horisontStraffad);
    return (s.ankrad && !straffad)
      ? this.k.bildrutorForLasAnkrad
      : this.k.bildrutorForLas;
  }

  #valjLas() {
    let bast = null;
    for (const s of this.spar) {
      if (s.brand || s.traffar < this.krav(s)) continue;
      if (s.poang < this.k.minPoang) continue;
      if (!bast || s.poang > bast.poang) bast = s;
    }
    if (bast) {
      this.lastId = bast.id;
      this.sisteOrsak = 'last';
      // Märket sitter kvar för alltid på spåret, inte på klockan. Se `#slapp`:
      // ett spår som appen någon gång har läst text ur är det enda vars röster
      // redan är värda något, och det ska aldrig vräkas ur urnan. Att i stället
      // fråga "är detta låset just nu" skyddar bara under den bildruta låset
      // släpps — en bildruta senare ligger samma spår oskyddat i urnan, och det
      // är precis då tolv mogna reflexer spolar ut det.
      bast.varLas = true;
    }
  }

  /** Hur långt den bäst placerade olåsta kandidaten har kommit mot ett lås, 0–1. */
  get pahang() {
    let b = 0;
    for (const s of this.spar) {
      if (s.brand || s.poang < this.k.minPoang) continue;
      b = Math.max(b, Math.min(1, s.traffar / this.krav(s)));
    }
    return b;
  }

  /**
   * Rapporterar in vad textigenkänningen fick ut ur ett spår.
   *
   * "GILTIG SKYLT" ÄR INTE SAMMA SAK SOM "SAMMA SKYLT TVÅ GÅNGER", och det var
   * hålet i brandmekanismen. Ett falskt ankare på en skåpbilssida läser ut
   * text som råkar passera formatvalideringen — den uppmätta scenen gav
   * "ROR54B", ett fullt giltigt svenskt nummer. Då blev `giltig` sant,
   * `ocrTraffar` större än noll, bomräkningen nollställdes, och spåret kunde
   * per konstruktion aldrig brinna. Det satt kvar och läste vidare framför den
   * riktiga skylten.
   *
   * Nu jämförs hashen mot förra varvets. Bara en UPPREPAD läsning räknas som
   * ett kvitto på att spåret tittar på en verklig skylt; en ny påhittad skylt
   * varje varv räknas som en bom, och tre sådana bränner låset precis som tre
   * tomma läsningar gör.
   *
   * Hashen jämförs bara med sig själv. Den lagras aldrig som något annat än
   * det saltade värdet, och den lämnar inte spåret — samma regel som resten av
   * modulen: ingenting läsbart korsar en bildrutegräns.
   *
   * @param {string|null} hash  saltad hash av läsningen, eller null när det
   *                            inte gick att hasha alls
   */
  rapporteraLasning(id, giltig, hash = null) {
    const s = this.spar.find(x => x.id === id);
    if (!s) return;
    s.ocrForsok++;

    if (giltig) {
      s.ocrTraffar++;
      const samma = !!(hash && s.sisteHash && hash === s.sisteHash);
      if (hash) s.sisteHash = hash;
      if (samma) { s.upprepade++; s.ocrBom = 0; return; }
      // Utan hash går det inte att avgöra om det var samma skylt. Då står den
      // gamla, mildare regeln kvar: en giltig läsning friar spåret.
      if (!hash) { s.ocrBom = 0; return; }
    }

    s.ocrBom++;
    if (!s.upprepade && s.ocrBom >= this.k.brandForsok) {
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

/* ---- Flerbildskonsensus -------------------------------------------------
 *
 * DET SOM STOD HÄR FÖRUT VAR INTE EN OMRÖSTNING.
 *
 * Den gamla regeln var "samma svar två gånger inom sex sekunder". Den lät som
 * en omröstning men var något annat, och skillnaden bet:
 *
 *   • Första svaret som råkade dyka upp två gånger vann. Avvikande läsningar
 *     jämfördes aldrig mot varandra — de låg som separata poster i samma lista
 *     och tävlade inte.
 *   • En systematisk felläsning — samma sudd, samma smuts, samma bildruta —
 *     upprepar sig lika villigt som den rätta och uppfyllde kravet lika lätt.
 *   • En läsning som motorn var 12 % säker på vägde exakt lika mycket som en
 *     den var 94 % säker på.
 *   • Listan var gemensam för hela läsaren. Två bilar i bild röstade i samma
 *     urna, åtskilda bara av att hasharna skilde sig.
 *
 * DET SOM STÅR HÄR NU
 *
 * En urna per spår, vikter i stället för antal, och ett krav på försprång.
 *
 * VIKTEN. Motorns säkerhet 40 % ger 0,30, 90 % eller mer ger 0,60, och
 * däremellan rakt av. Målet är 1,0. Uppmätt, med blekningen inräknad och
 * ungefär 300 ms mellan läsningarna — se avsnittet om TAKTEN nedan för vad
 * som händer när läsningarna kommer glesare, vilket de gör i drift:
 *
 *     två säkra läsningar (92 %)     → klar på 2 bildrutor
 *     tre medelbra (65 %)            → klar på 3
 *     fem osäkra (20 %)              → klar på 5
 *
 * Talen är inte 2/3/4 som en rak summa hade gett, och det är blekningen som
 * gör skillnaden — en röst som är tre bildrutor gammal väger inte längre fullt.
 * Trappan är det som ombads: ett säkert svar får komma tidigt, ett osäkert får
 * kosta fler bildrutor.
 *
 * Taket 0,60 är det viktigaste talet här: EN läsning kan aldrig räcka, hur
 * säker motorn än säger sig vara. Det var premissen från början och den står
 * kvar — en enstaka gissning är en gissning.
 *
 * FÖRSPRÅNGET. Vinnaren måste leda tvåan med 0,30, alltså med minst en hel
 * osäker läsning. Utan det räcker det att en felläsning hinner före; med det
 * måste den faktiskt slå de andra svaren. Det är den delen som gör det till en
 * omröstning i stället för ett kappränning.
 *
 * FÖNSTRET 2,5 SEKUNDER, OCH BLEKNINGEN. Föraren kör. I 50 km/h täcks 35 meter
 * på 2,5 sekunder, och en läsning från början av det fönstret gjordes på ett
 * helt annat avstånd, i en annan vinkel, i ett annat ljus — det är i praktiken
 * en bild av något annat. Sex sekunder, som förut, är över 80 meter. Rösterna
 * bleknar dessutom linjärt med åldern i stället för att falla bort på en
 * gräns, så det som just lästes väger tyngst. Det är exakt den viktning en
 * bilburen sökare vill ha.
 *
 * VARFÖR INTE MAJORITET TECKEN FÖR TECKEN. Det vore starkare, och det går inte
 * att göra här. Teckenvis röstning kräver att numren ligger läsbara mellan
 * bildrutor, och det enda som får korsa en bildrutegräns i den här modulen är
 * en saltad hash. Att bygga teckenröstning hade byggt tillbaka precis den
 * klartextlista som togs bort. Vikterna och försprånget är vad som går att få
 * utan att offra det, och de räcker.
 *
 * TAKTEN, OCH VARFÖR KRAVET INTE GICK ATT UPPFYLLA.
 *
 * Trappan ovan är räknad på 300 ms mellan läsningarna. Så tätt läser appen
 * aldrig: `intervalMs` är 700 ms och OCR-slingan väntar dessutom ut resten av
 * varvtiden, så det verkliga avståndet är max(700, varvtid) — och en läsning
 * under 80 % säkerhet drar igång en andra OCR-körning, så just de varv som
 * ger LÅG vikt är också de längsta, ofta 1,1 s och på en telefon gärna 1,2.
 *
 * Med ett fast fönster på 2500 ms rymdes då bara fyra röster, och deras
 * bleknade summa toppade på 2,32 gånger röstvikten. Det gav ett hårt tak:
 * under 62 % motorsäkerhet kunde summan ALDRIG nå 1,0, hur länge föraren än
 * låg bakom bilen. Vid 1,2 s varvtid nådde inte ens en läsning på 100 %
 * säkerhet fram — ingenting annonserades någonsin. Det var inte "svaret kommer
 * senare", det var "svaret kommer inte", och filens egen kommentar om att
 * motorn "ibland rapporterar 0 % även för en läsning som stämmer" beskriver
 * precis de läsningar som tystades.
 *
 * Två ändringar, båda så att talen mäter verkligheten i stället för en takt
 * som inte finns:
 *
 *   1. Fönstret följer takten: minst `fonsterVarv` läsningar ska rymmas i det,
 *      och fler när `krav` är högre. Vid 300 ms ändrar det ingenting (2500 ms
 *      räcker gott), vid 1,2 s växer det med takten.
 *   2. Målet kapas av vad som FAKTISKT ryms i fönstret. Kravet får aldrig
 *      ligga över det uppnåeliga — ett krav som inte går att uppfylla är inte
 *      ett högt krav, det är en trasig funktion. Golvet `malGolv` står kvar
 *      över `viktHog`, så en enda läsning kan fortfarande aldrig räcka. Det
 *      var premissen från början och den ändras inte.
 */
export const ROST = {
  malVikt: 0.5,          // per enhet av `krav`; krav 2 ⇒ mål 1,0
  vinstMarginal: 0.30,
  viktLag: 0.30,
  viktHog: 0.60,
  sakerhetLag: 40,
  sakerhetHog: 90,
  fonsterMs: 2500,       // golv för fönstret
  fonsterVarv: 5,        // ...men minst så många OCR-varv ska rymmas
  varvMs: 300,           // antagen takt tills anroparen säger något annat
  malMarginal: 0.95,     // takten är aldrig helt jämn; ta inte i till kanten
  malGolv: 0.65,         // > viktHog, så en enda läsning aldrig räcker
  maxUrnor: 8,
};

/** Vad en enskild läsning väger, utifrån vad motorn sa om sin egen säkerhet. */
export function rostvikt(sakerhet, k = ROST) {
  const spann = Math.max(1, k.sakerhetHog - k.sakerhetLag);
  const t = Math.min(1, Math.max(0, (sakerhet - k.sakerhetLag) / spann));
  return k.viktLag + (k.viktHog - k.viktLag) * t;
}

/**
 * Viktad omröstning per spår.
 *
 * Innehåller bara hashar och tidpunkter. Inget nummer, ingen text, ingenting
 * som går att läsa — samma regel som resten av modulen.
 */
export class Rostrakning {
  constructor(opt = {}) {
    this.k = { ...ROST, ...opt };
    this.urnor = new Map();
  }

  nollstall() { this.urnor.clear(); }

  /**
   * Fönstrets verkliga längd: golvet, eller så långt som `fonsterVarv`
   * läsningar i den takt anroparen faktiskt läser i behöver. Se ROST.
   *
   * Fönstret växer också med `krav`. Utan det tappar knappen sin mening vid
   * långsam takt: höjer man kravet från två till tre men fönstret rymmer
   * fortfarande bara sex läsningar, kapas målet ner till samma tal igen och
   * "krav 3" beter sig exakt som "krav 2". Ett fönster som rymmer fler
   * läsningar när fler krävs är det enda sättet att låta båda talen betyda
   * det de säger.
   */
  fonster(krav = 2) {
    const varv = this.k.fonsterVarv * Math.max(1, krav) / 2;
    return Math.max(this.k.fonsterMs, varv * this.k.varvMs);
  }

  /**
   * Högsta vikt som över huvud taget går att samla i fönstret, om varenda
   * läsning är den svagaste sorten.
   *
   * n röster med `dt` emellan bleknar till (1 - i·dt/F) var, alltså
   * n - dt·n(n-1)/(2F) gånger röstvikten.
   */
  takVikt(krav = 2) {
    const F = this.fonster(krav);
    const dt = Math.max(1, this.k.varvMs);
    const n = Math.max(2, Math.floor(F / dt) + 1);
    return this.k.viktLag * (n - dt * n * (n - 1) / (2 * F));
  }

  /**
   * Målvikt för ett givet `krav`. krav 2 ⇒ 1,0, krav 3 ⇒ 1,5 — men aldrig
   * mer än vad takten hinner samla ihop, och aldrig under `malGolv`.
   */
  mal(krav = 2) {
    const onskat = Math.max(this.k.malVikt, krav * this.k.malVikt);
    const uppnaeligt = this.takVikt(krav) * this.k.malMarginal;
    return Math.max(this.k.malGolv, Math.min(onskat, uppnaeligt));
  }

  /**
   * Lägger en röst och svarar om urnan är avgjord.
   *
   * @param {string|number} urnaId  spårets id — en urna per fordon i bild
   * @param {string} hash           saltad hash av läsningen
   * @param {number} sakerhet       motorns säkerhet, 0–100
   * @returns {{klar:boolean, vikt:number, tvaa:number, roster:number, mal:number}}
   */
  rosta(urnaId, hash, sakerhet, { krav = 2, nu = Date.now() } = {}) {
    // Urnor för spår som inte finns kvar ska inte ligga och minnas. Två
    // fönster utan en röst betyder att fordonet är ur bild.
    for (const [id, u] of this.urnor) {
      if (nu - u.sist > this.fonster(krav) * 2) this.urnor.delete(id);
    }
    let u = this.urnor.get(urnaId);
    if (!u) {
      u = { roster: [], sist: nu };
      this.urnor.set(urnaId, u);
      // Håll listan kort även om spår-id:n rullar snabbt.
      while (this.urnor.size > this.k.maxUrnor) {
        const aldst = [...this.urnor.entries()].sort((a, b) => a[1].sist - b[1].sist)[0];
        if (!aldst || aldst[0] === urnaId) break;
        this.urnor.delete(aldst[0]);
      }
    }
    u.sist = nu;
    const F = this.fonster(krav);
    u.roster = u.roster.filter(r => nu - r.t < F);
    u.roster.push({ h: hash, t: nu, v: rostvikt(sakerhet, this.k) });

    // Blekning: en röst tappar sin vikt linjärt över fönstret.
    const summa = new Map();
    for (const r of u.roster) {
      const bleknad = r.v * (1 - (nu - r.t) / F);
      if (bleknad <= 0) continue;
      summa.set(r.h, (summa.get(r.h) || 0) + bleknad);
    }

    let vinnare = null, vikt = 0, tvaa = 0;
    for (const [h, v] of summa) {
      if (v > vikt) { tvaa = vikt; vikt = v; vinnare = h; }
      else if (v > tvaa) tvaa = v;
    }

    const mal = this.mal(krav);
    // Vinnaren måste vara den vi just läste. Annars annonserar vi ett gammalt
    // svar i samma ögonblick som bilden säger något annat.
    const klar = vinnare === hash && vikt >= mal && (vikt - tvaa) >= this.k.vinstMarginal;
    if (klar) u.roster = [];
    return { klar, vikt, tvaa, mal, roster: u.roster.length };
  }
}

/* ---- Mätning ------------------------------------------------------------
 *
 * "Snabbare" är inte en känsla, det är ett tal. Före den här klassen mättes
 * bara sökningen — det billigaste steget i hela kedjan — och siffran skickades
 * till en händelse ingen lyssnade på. OCR-tiden, som är en till två tiopotenser
 * dyrare, mättes ingenstans, och överhoppade OCR-varv räknades inte alls.
 *
 * Nu mäts varje steg, och två tider till första godkända läsning:
 *   franStart  — från att kameran startade. Det föraren upplever.
 *   franSpar   — från att skylten först syntes i bild. Det som går att jämföra
 *                mellan två versioner av koden, eftersom det inte innehåller
 *                hur lång tid föraren tog på sig att komma ikapp bilen framför.
 */
class Matvarde {
  constructor() { this.antal = 0; this.summa = 0; this.senast = 0; this.max = 0; }
  lagg(ms) {
    this.antal++; this.summa += ms; this.senast = ms;
    if (ms > this.max) this.max = ms;
  }
  get medel() { return this.antal ? this.summa / this.antal : 0; }
  varden() {
    return {
      antal: this.antal,
      senast: Math.round(this.senast * 10) / 10,
      medel: Math.round(this.medel * 10) / 10,
      max: Math.round(this.max * 10) / 10,
    };
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
   *
   * NULL BETYDER OKÄND, OCH DET ÄR EN RÄTTELSE. Getteren returnerade förut 0
   * när `screen.orientation` saknades, alltså aldrig null. Talet 0 betyder
   * "stående telefon", och `horisontlage` svarar då 'av' — regeln stängdes av
   * i en webbläsare som helt enkelt inte kunde svara på frågan, medan
   * dokumentationen intill påstod att den grenen gav 'mjuk'. Den grenen var
   * alltså onåbar från `PlateReader`. Nu är den nåbar: okänt är null, och den
   * som inte vet får den mjuka regeln — inte ingen regel och inte den hårda.
   *
   * `#matning` nedan vill ha ett TAL och inte en flagga: där betyder okänd
   * skärmvinkel "dra bort ingenting", alltså 0, och den läser därför
   * `this.skarmvinkel ?? 0`.
   */
  get skarmvinkel() {
    const v = Number(screen?.orientation?.angle);
    return Number.isFinite(v) ? v : null;
  }

  /** Sant först när det kommit några mätningar. En sensor som inte svarat
   *  ännu ska inte låtsas att telefonen står rak. */
  get harVarde() { return this.aktiv && this._prov > 5; }

  #matning(e) {
    // Tyngdkraften, inte rörelsen. En bil skakar; tyngdkraften gör det inte.
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const rad = Math.atan2(a.x, a.y);
    const ny = vikVinkel(rad * 180 / Math.PI - (this.skarmvinkel ?? 0));
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
      intervalMs: 700,        // kortaste tid mellan två OCR-varv
      /*
       * `krav` är inte längre ett antal läsningar utan ett antal SÄKRA
       * läsningar: målvikten blir krav × 0,5, och en läsning väger 0,30–0,60
       * beroende på hur säker motorn var. Förvalet 2 betyder därför precis vad
       * det alltid har betytt — två säkra räcker — men tre osäkra krävs nu där
       * två osäkra förut släpptes igenom. Se `Rostrakning`.
       */
      krav: 2,
      // Rösternas livslängd — ett GOLV, inte ett tak. Läser slingan glesare än
      // 300 ms växer fönstret med takten, annars vore målet omöjligt att nå.
      // Se `Rostrakning` och ROST.
      fonsterMs: 2500,
      franvaroMs: 8000,       // så länge måste en skylt ha varit borta för att räknas som ny
      pip: true,
      zoomLage: 'auto',      // 'auto' eller 'manuell'
      zoomVilaMs: 1800,      // minsta tid mellan tva zoomandringar

      // Målsökning
      sokMs: 120,             // hur ofta bilden genomsöks efter kandidater
      /*
       * Arbetsbredd för sökningen, i pixlar.
       *
       * 320 ÄR PRÖVAT, MÄTT OCH FÖRKASTAT. Det är inte en självklar dom och
       * båda sidorna ska stå här, för nästa läsare kommer att få samma idé.
       *
       * Mätt i prov/skyltar/matning.html?bredd=320&sokms=90, två identiska
       * körningar mot alla 22 foton, med plattgrinden på plats:
       *
       *                        400 (nu)     320
       *   lås på rätt skylt    15/22        17/22    ← 320 är BÄTTRE
       *   rätt text            10/21         7/21    ← 320 är sämre
       *   uppfunna nummer       0            1       ← 320 är farligt
       *   median söktick       7,7 ms       4,5 ms   ← 320 är billigare
       *   dyraste söktick     22,0 ms      13,9 ms
       *
       * 320 hittar alltså skylten OFTARE och för 42 % av priset — och läser
       * den ändå sämre. Mekanismen är rakt igenom: en grövre arbetsbild
       * kvantiserar kandidatens uppmätta kanter grövre, och för en ANKRAD
       * kandidat går den mätningen rakt in i beskärningen (se `lasKandidat`,
       * som med flit hoppar över en ny sökning när kanterna redan är mätta).
       * Sämre kanter ger en sämre beskärning ger en sämre läsning.
       *
       * Det som fäller det är den sista raden. Vid 320 svarar läsaren
       * "YDR148" på Regpl-Heden.jpg, där skyltarna heter YDR167 och YDR168 —
       * bänkens enda uppfunna registreringsnummer i någon körning, och det
       * går att reproducera. En läsare som tiger när den är osäker är
       * användbar. En som hittar på ett nummer är sämre än ingen läsare alls,
       * och två extra lås är inte värda det.
       *
       * VÄGEN VIDARE, om någon vill ha både billigare sökning och behållen
       * läsning: sök på 320 men låt `lasKandidat` mäta om en ankrad kandidats
       * kanter i full upplösning i stället för att lita på den grova
       * mätningen. Det är omätt och därför inte byggt.
       */
      sokBredd: 400,          // arbetsbredd för sökningen, i pixlar
      bildrutorForLas: MALSOK.bildrutorForLas,
      bildrutorForLasAnkrad: MALSOK.bildrutorForLasAnkrad,
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
    /*
     * `varvMs` är rösträkningens enda kunskap om hur tätt appen faktiskt
     * läser. Utan den räknade den på 300 ms medan slingan gick på 700, och
     * målet blev omöjligt att nå för allt utom de säkraste läsningarna. Se
     * ROST, avsnittet om TAKTEN.
     */
    this.rostning = new Rostrakning({
      fonsterMs: this.settings.fonsterMs,
      varvMs: this.settings.intervalMs,
    });
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
      bildrutorForLasAnkrad: this.settings.bildrutorForLasAnkrad,
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
    this.#nollstallMatning();
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
    this.#nollstallMatning();
    this.matning.startAt = performance.now();
    this.#status('Söker skylt…');
    this.#rita();
    // setInterval, inte requestAnimationFrame: rAF står stilla så fort
    // skärmen slocknar eller fliken hamnar i bakgrunden, och då slutade
    // dashcamen spela in mitt i en resa. Samma fälla gäller här.
    this.#startaOcrSlinga();
    this._ritTimer = setInterval(() => this.#rita(), 100);
    // Sökningen går i egen takt, mycket snabbare än OCR:en. Den är billig och
    // det är den som avgör hur snabbt låset kan sitta — ett lås som byggs av
    // läsningar var sjunde tiondel hade tagit sex sekunder.
    this._sokTimer = setInterval(() => this.#sok(), this.settings.sokMs);

    // Värm motorn medan användaren riktar in sig, så första läsningen inte
    // tar fem sekunder.
    haMotor().catch(e => this.#fel(e));
  }

  /**
   * OCR-slingan schemalägger sig själv i stället för att ligga på setInterval.
   *
   * Med setInterval fanns en tyst förlust: tog en läsning längre tid än
   * `intervalMs` slog nästa tick i återinträdesspärren och försvann utan spår.
   * Vid 700 ms mellan tickarna och en läsning på 900 ms betyder det att
   * VARANNAN läsning aldrig blev av, och ingen mätning hade kunnat visa det.
   *
   * Nu väntar slingan i stället ut resten av intervallet efter att läsningen
   * blev klar. `intervalMs` blir ett GOLV för hur tätt vi läser, inte ett
   * schema som läsningen måste hinna in i. Går en läsning snabbt kommer nästa
   * i tid; går den långsamt startar nästa direkt efteråt i stället för att
   * hoppas över. Två följder på köpet: en ändrad `intervalMs` slår igenom utan
   * omstart, och det finns inget läge kvar där läsaren ser död ut för att alla
   * tick landat i spärren.
   */
  #startaOcrSlinga() {
    const varv = async () => {
      if (!this.running) return;
      const t0 = performance.now();
      try { await this.#steg(); } catch (e) { this.#fel(e); }
      if (!this.running) return;
      const gick = performance.now() - t0;
      this._ocrTimer = setTimeout(varv, Math.max(0, this.settings.intervalMs - gick));
    };
    this._ocrTimer = setTimeout(varv, 0);
  }

  stop() {
    this.running = false;
    clearTimeout(this._ocrTimer); clearInterval(this._ritTimer); clearInterval(this._sokTimer);
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
    this.rostning.nollstall(); this.sedd.clear(); this.antalLasta = 0;
  }

  #nollstallMatning() {
    this.matning = {
      startAt: 0,
      sok: new Matvarde(),          // en sökning över bildrutan
      hitta: new Matvarde(),        // lokalisering inne i rutan (ljusstapelvägen)
      forbehandla: new Matvarde(),  // beskär, räta upp, tröskla
      ocr: new Matvarde(),          // en recognize() i arbetaren
      varv: new Matvarde(),         // hela OCR-varvet, vägg-mot-vägg
      ocrVarv: 0,
      ocrKorningar: 0,
      ankradeVarv: 0,
      giltiga: 0,
      ogiltiga: 0,
      /*
       * Överhoppade varv. Tog förra läsningen längre tid än intervalMs
       * droppades nästa tick förut helt tyst — ingen kö, ingen logg, ingen
       * räknare. Det såg ut som att läsaren dött. Nu räknas det, och med den
       * självschemaläggande slingan i `start()` ska talet dessutom vara noll.
       */
      overhoppade: 0,
      lastAt: 0,
      forstaLasMs: null,            // start → första låset
      forstaGiltigMs: null,         // start → första giltiga OCR-läsningen
      forstaTraffFranStart: null,   // start → första godkända (röstade) läsningen
      forstaTraffFranSpar: null,    // skylten syns → första godkända läsningen
    };
  }

  /**
   * Mätvärdena, färdiga att skriva ut. Det här är svaret på "blev det
   * snabbare" — en siffra, inte en känsla.
   */
  matdata() {
    const m = this.matning;
    const rund = v => (v == null ? null : Math.round(v));
    return {
      sok: m.sok.varden(),
      hitta: m.hitta.varden(),
      forbehandla: m.forbehandla.varden(),
      ocr: m.ocr.varden(),
      varv: m.varv.varden(),
      ocrVarv: m.ocrVarv,
      ocrKorningar: m.ocrKorningar,
      ocrPerVarv: m.ocrVarv ? Math.round(m.ocrKorningar / m.ocrVarv * 100) / 100 : 0,
      ankradeVarv: m.ankradeVarv,
      giltiga: m.giltiga,
      ogiltiga: m.ogiltiga,
      overhoppade: m.overhoppade,
      forstaLasMs: rund(m.forstaLasMs),
      forstaGiltigMs: rund(m.forstaGiltigMs),
      forstaTraffFranStart: rund(m.forstaTraffFranStart),
      forstaTraffFranSpar: rund(m.forstaTraffFranSpar),
    };
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
        // Skärmens vridning kostar ingenting och kräver inget tillstånd. Den
        // används BARA som andrahandskälla åt horisontregeln, när givaren är
        // av — se `horisontlage` för varför den är ett antagande och inte en
        // mätning.
        //
        // OCH DEN KAN BÅDE SKÄRPA OCH STÄNGA AV REGELN. Här stod förut att den
        // "bara kan stänga av regeln, aldrig skärpa den", och det stämmer inte
        // med koden: utan lutningsgivare är `forvantadVinkel` null, och då
        // svarar `horisontlage` 'full' på skärmvinkel 90 eller 270 — en
        // SKÄRPNING från grundvärdet 'mjuk', och det är just den som slår på
        // det hårda bandet. Skärmvinkel 0 eller 180 ger 'av'. Ett antagande
        // som får skärpa ska stå utskrivet som ett antagande som får skärpa:
        // en telefon som ligger i en hållare rapporterar 90 eller 270, och
        // hållarläget är det modulen är byggd för.
        skarmvinkel: this.lutningsgivare.skarmvinkel,
      });
    } catch (e) {
      this.#fel(e); return;
    }
    this.sokMsSenast = performance.now() - t0;
    this.sokMsMedel = this.sokMsMedel
      ? this.sokMsMedel * 0.9 + this.sokMsSenast * 0.1
      : this.sokMsSenast;
    this.matning.sok.lagg(this.sokMsSenast);

    const { spar, last } = this.malsokare.mata(kand);
    this.kandidater = spar;
    if (last) {
      this._sistLast = Date.now();
      if (this.matning.forstaLasMs == null) {
        this.matning.forstaLasMs = performance.now() - this.matning.startAt;
      }
    }
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
      brand: s.brand, last: !!s.last, ankrad: !!s.ankrad,
      // Mätaren ska visa vägen till DET HÄR spårets lås. Ett ankrat spår har
      // tre bildrutor kvar till målet, inte åtta, och en mätare som räknar mot
      // fel mål ljuger om hur nära låset är.
      mognad: Math.min(1, s.traffar / this.malsokare.krav(s)),
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
      ankrade: kandidater.filter(k => k.ankrad).length,
      matning: this.matdata(),
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
    if (!this.running || !this.video.videoWidth) return;
    // Kan inte längre inträffa med den självschemaläggande slingan, men om det
    // någonsin gör det ska det synas i mätningen och inte försvinna tyst.
    if (this.arbetar) { this.matning.overhoppade++; return; }

    const m = this.matning;
    const last = this.malsokare.last;
    let roi = null, lasId = null, matt = null, forstSedd = 0;
    if (last) {
      lasId = last.id;
      forstSedd = last.forstSedd || 0;
      matt = { w: last.w, h: last.h, rw: last.matt?.rw, rh: last.matt?.rh };
      // Kopia, inte spåret självt: sökningen skriver om spåret medan
      // läsningen pågår, och rutan skulle glida ifrån bilden vi beskar.
      roi = { x: last.x, y: last.y, w: last.w, h: last.h };
      /*
       * Är spårets senaste mätning ankrad följer skyltens uppmätta kanter,
       * vinkel och bandbredd med in i läsningen.
       *
       * Här används den RÅA mätningen, inte spårets utjämnade ruta. Utjämningen
       * finns för att siktet inte ska darra på skärmen, och den är rätt till
       * det — men den ligger drygt en sökbildruta efter sanningen, och i
       * landsvägsfart hinner skylten flytta sig så mycket på den tiden att
       * beskärningen hamnar bredvid. Den utjämnade rutan ritas, den råa läses.
       */
      if (last.matt?.ankrad) {
        /*
         * HELA rutan tas från den råa mätningen, inte bara den vridna
         * rektangeln. Förut skrevs cx/cy/rw/rh över men x/y/w/h lämnades
         * utjämnade, och de två beskrev då olika ögonblick. Vid vinkel 0 —
         * skylt rakt framifrån, det vanligaste läget som finns — är det
         * x/y/w/h som beskärs, alltså den eftersläpande rutan, precis det
         * kommentaren ovan lovar att den inte gör.
         */
        Object.assign(roi, {
          ankrad: true,
          x: last.matt.x, y: last.matt.y, w: last.matt.w, h: last.matt.h,
          vinkel: last.matt.vinkel,
          cx: last.matt.cx, cy: last.matt.cy,
          rw: last.matt.rw, rh: last.matt.rh,
          euAndel: last.matt.euAndel,
        });
      }
    } else if (this.settings.centrumFallback && this._roi &&
               Date.now() - this._sistLast > this.settings.fallbackMs) {
      roi = this._roi;
      const t0 = performance.now();
      matt = hittaPlat(this.video, this._roi);
      m.hitta.lagg(performance.now() - t0);
    }
    if (!roi) return;

    this.arbetar = true;
    const tVarv = performance.now();
    try {
      // Skyltens storlek styr autozoomen, oavsett om den gick att läsa. En
      // skylt som hittas men är för liten är precis det fall zoomen finns för.
      this.#justeraZoom(matt);

      /*
       * `matt` skickas med. Utan det letade `lasRuta` upp skylten en gång
       * till inne i exakt samma ruta som vi just sökt igenom — samma
       * nedskalning, samma flödesfyllning, en gång per OCR-varv, till ingen
       * nytta. Är `matt` null beter sig anropet precis som förut.
       */
      const svar = lasId
        ? await lasKandidat(this.video, roi)
        : await lasRuta(this.video, roi, { fardigMatt: matt });
      const { plat, sakerhet, tider } = svar;

      /*
       * Kameran kan ha släckts medan läsningen pågick. Utan den här kontrollen
       * kunde en läsning som var i luften när `stop()` kördes fylla på
       * rösträkningen efter att `rensa()` tömt den — och då ligger hashar kvar
       * i minnet med kameran av. Litet, men det biter mot regeln om att
       * ingenting ska finnas kvar när läsaren är avstängd.
       */
      if (!this.running) return;

      m.ocrVarv++;
      if (tider) {
        m.ocrKorningar += tider.ocrAntal;
        if (tider.ocrAntal) m.ocr.lagg(tider.ocrMs / tider.ocrAntal);
        if (tider.forbMs) m.forbehandla.lagg(tider.forbMs);
        if (tider.hittaMs) m.hitta.lagg(tider.hittaMs);
        if (tider.ankrad) m.ankradeVarv++;
      }
      if (plat) {
        m.giltiga++;
        if (m.forstaGiltigMs == null) m.forstaGiltigMs = performance.now() - m.startAt;
      } else {
        m.ogiltiga++;
      }

      /*
       * Hashen tas fram här och inte inne i `#rosta`, därför att BÅDA behöver
       * den: rösträkningen för att räkna, och brandmekanismen för att se om
       * spåret läser samma skylt igen eller hittar på en ny varje varv. Att
       * hasha två gånger vore samma arbete två gånger — och att skicka numret
       * vidare i klartext i stället är precis det modulen inte gör.
       */
      let h = null;
      if (plat) { try { h = await this.#hasha(plat); } catch {} }

      // Ett lås som aldrig ger en giltig skylt ska brinna upp, inte sitta
      // kvar. Rapporten är det som gör det.
      if (lasId) this.malsokare.rapporteraLasning(lasId, !!plat, h);
      if (plat) await this.#rosta(plat, sakerhet, lasId ?? 'mitten', forstSedd, h);
    } catch (e) {
      this.#fel(e);
    } finally {
      const varvMs = performance.now() - tVarv;
      m.varv.lagg(varvMs);
      /*
       * Rösträkningen måste veta hur tätt vi verkligen läser, inte hur tätt vi
       * tänkt oss. Det verkliga avståndet mellan två röster är golvet
       * `intervalMs` eller varvtiden, det som är längst. En läsning under 80 %
       * säkerhet drar igång en andra OCR-körning och gör varvet nästan dubbelt
       * så långt — alltså blir takten som glesast just när rösterna är som
       * svagast, och det är den kombinationen som förut gjorde målet omöjligt.
       */
      this.rostning.k.varvMs =
        Math.max(this.settings.intervalMs, Math.round(varvMs)) || ROST.varvMs;
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
  async #rosta(plat, sakerhet, urnaId = 'mitten', forstSedd = 0, fardigHash = null) {
    const nu = Date.now();

    // Hashen kan redan vara framtagen av anroparen — brandmekanismen behöver
    // samma värde, och två hashningar av samma läsning är ren dubbelkörning.
    let h = fardigHash;
    if (!h) { try { h = await this.#hasha(plat); } catch {} }
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

    /*
     * En urna per spår. Två bilar i bild röstade förut i samma urna, åtskilda
     * bara av att hasharna skilde sig — nu räknas de var för sig, och en
     * felläsning av den ena kan inte längre störa den andra.
     */
    const rost = this.rostning.rosta(urnaId, h, sakerhet,
                                     { krav: this.settings.krav, nu });
    if (!rost.klar) {
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

    const m = this.matning;
    if (m.forstaTraffFranStart == null) {
      m.forstaTraffFranStart = performance.now() - m.startAt;
      // Från att skylten först syntes, inte från att kameran startade. Det är
      // det talet som går att jämföra mellan två versioner av koden.
      if (forstSedd) m.forstaTraffFranSpar = nu - forstSedd;
    }

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
