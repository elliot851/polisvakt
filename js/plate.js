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
 */

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

/**
 * Grunden under både `hittaPlat` och `sokKandidater`: skala ner ett område,
 * tröskla med Otsu och plocka ut alla ljusa sammanhängande områden som har
 * skyltens grovform.
 *
 * Metoden är enkel med flit: en skylt är det ljusa, avlånga och någorlunda
 * rektangulära i bilden. Det räcker för att skilja den från en bilkropp, och
 * det kostar ingenting jämfört med att lägga in en modell.
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

    while (sp) {
      const i = stack[--sp];
      const x = i % b, y = (i / b) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0     && !besokt[i - 1] && gra[i - 1] > trosk) { besokt[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < b - 1 && !besokt[i + 1] && gra[i + 1] > trosk) { besokt[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0     && !besokt[i - b] && gra[i - b] > trosk) { besokt[i - b] = 1; stack[sp++] = i - b; }
      if (y < h - 1 && !besokt[i + b] && gra[i + b] > trosk) { besokt[i + b] = 1; stack[sp++] = i + b; }
    }

    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const forhallande = bw / bh;
    const fyllnad = area / (bw * bh);
    // En skylt är avlång, någorlunda rektangulär och inte försvinnande liten.
    if (forhallande < 2.2 || forhallande > 8) continue;
    if (fyllnad < 0.45) continue;
    if (bw < minBredd || bh < 3) continue;
    blobbar.push({ minX, minY, bw, bh, area, forhallande, fyllnad });
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
 */
function raknaTeckenbyten(gra, b, box) {
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
  return {
    x: roi.x + bast.minX * inv - mx,
    y: roi.y + bast.minY * inv - my,
    w: bast.bw * inv + mx * 2,
    h: bast.bh * inv + my * 2,
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
function poangsattKandidat({ forhallande, fyllnad, teckenbyten, bredd, cx, cy, ytaB }) {
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

  return {
    poang: form * (0.35 + 0.65 * storlek) * centrum * tecken,
    form, storlek, centrum, tecken,
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
export function sokKandidater(kalla, omrade = null, { arbetsbredd = 400, max = 6 } = {}) {
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
    const teckenbyten = raknaTeckenbyten(s.gra, s.b, bl);
    const p = poangsattKandidat({
      forhallande: bl.forhallande,
      fyllnad: bl.fyllnad,
      teckenbyten,
      bredd: bl.bw,
      cx: (bl.minX + bl.bw / 2) / s.b,
      cy: (bl.minY + bl.bh / 2) / s.h,
      ytaB: s.b,
    });

    // Samma marginal som `hittaPlat` ger, så att OCR-steget får en ruta med
    // luft kring tecknen och inte klipper kanterna.
    const mx = bl.bw * 0.03 * inv, my = bl.bh * 0.08 * inv;
    ut.push({
      x: yta.x + bl.minX * inv - mx,
      y: yta.y + bl.minY * inv - my,
      w: bl.bw * inv + mx * 2,
      h: bl.bh * inv + my * 2,
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
export function forbehandla(kalla, roi, { malHojd = 96, kapaEuFalt = true, lutning = 0 } = {}) {
  const skala = malHojd / roi.h;
  const bredd = Math.max(1, Math.round(roi.w * skala));
  const hojd  = Math.max(1, Math.round(malHojd));

  const c = document.createElement('canvas');
  c.width = bredd; c.height = hojd;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (lutning) {
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

  // Rakt på först. Går det bra behöver vi inte röra vinkeln alls.
  const rak = forbehandla(kalla, snav, { kapaEuFalt });
  let bast = { plat: null, sakerhet: 0, bild: rak };

  const r0 = await lasBild(rak);
  if (r0.plat) bast = { plat: r0.plat, sakerhet: r0.sakerhet, bild: rak };
  if (r0.plat && r0.sakerhet >= 80) return bast;

  // Annars: mät lutningen och räta upp. Mätningen kostar ingen OCR-körning,
  // så det är billigare än att pröva sig fram med flera gissningar.
  const lutning = uppskattaLutning(rak);
  if (lutning) {
    const rat = forbehandla(kalla, snav, { kapaEuFalt, lutning });
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

/* ---- Läsaren ------------------------------------------------------------- */

export const plateSupported = !!(navigator.mediaDevices?.getUserMedia && window.OffscreenCanvas !== undefined
  || navigator.mediaDevices?.getUserMedia);

/**
 * Håller kameran, målsöker skylten och matar OCR:en.
 *
 * Händelser:
 *   'traff'       {plat, sakerhet, egen}   en skylt som två bildrutor är överens om
 *   'kandidater'  {kandidater, last, ...}  var siktet ser skyltar, för uppritning
 *   'status'      {text}                   vad den håller på med, för sökarens text
 *   'zoom'        {zoom, optisk, fran}
 *   'fel'         {fel}
 */
export class PlateReader extends EventTarget {
  constructor({ settings } = {}) {
    super();
    this.settings = Object.assign({
      intervalMs: 700,        // hur ofta en bildruta skickas till OCR
      krav: 2,                // så många överens innan vi tror på den
      fonsterMs: 6000,        // ...inom det här tidsfönstret
      franvaroMs: 8000,       // så länge måste en skylt ha varit borta för att räknas som ny
      pip: true,
      egnaFordon: [],
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
    }, settings || {});

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pl-canvas';
    this.video = document.createElement('video');
    this.video.playsInline = true; this.video.muted = true;

    this.running = false;
    this.senaste = [];          // {plat, t}
    this.sedd = new Map();       // plat -> när den senast sågs
    this.traffar = [];          // sessionens lista, bara i minnet
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
    this.sokMsSenast = 0;
    this.sokMsMedel = 0;      // rullande medel, för mätning i fält
    this._sistLast = 0;
    this._sisteStatus = null;
  }

  get antalTraffar() { return this.traffar.length; }

  async start() {
    if (this.running) return;

    // Samma hårda krav som dashcamen: får vi selfiekameran är läget
    // meningslöst, och ett tydligt fel är bättre än en sökare mot taket.
    const vc = { width: { ideal: 1920 }, height: { ideal: 1080 } };
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
    this.#slappStream();
    this.video.srcObject = null;
  }

  rensa() {
    this.traffar = []; this.senaste = []; this.sedd.clear();
    this.dispatchEvent(new CustomEvent('lista'));
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
      const andel = traff.w / this._roi.w;
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
      kand = sokKandidater(this.video, yta, { arbetsbredd: this.settings.sokBredd });
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
      matt = { w: last.w, h: last.h };
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
      if (plat) this.#rosta(plat, sakerhet);
    } catch (e) {
      this.#fel(e);
    } finally {
      this.arbetar = false;
    }
  }

  /**
   * Rösträkningen. En enda läsning duger inte — motorn är för säker på sina
   * misstag för det. Kräver att samma skylt dyker upp minst två gånger inom
   * tidsfönstret innan den visas.
   */
  #rosta(plat, sakerhet) {
    const nu = Date.now();

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
    let syn = this.sedd.get(plat);
    if (!syn || nu - syn.sistSedd > this.settings.franvaroMs) {
      syn = { sistSedd: nu, annonserad: false };     // skylten är tillbaka
      this.sedd.set(plat, syn);
    }
    syn.sistSedd = nu;

    this.senaste = this.senaste.filter(r => nu - r.t < this.settings.fonsterMs);
    this.senaste.push({ plat, t: nu });

    const antal = this.senaste.filter(r => r.plat === plat).length;
    if (antal < this.settings.krav) {
      this._statusLas = nu + 1500;
      this.#status(`Ser ${visaPlat(plat)} — bekräftar…`);
    } else {
      this._statusLas = 0;
      this.#status(this.#lagesText());
    }
    if (antal < this.settings.krav) return;
    if (syn.annonserad) return;
    syn.annonserad = true;

    const egen = this.settings.egnaFordon.includes(plat);
    this.traffar.unshift({ plat, sakerhet, t: nu, egen });
    if (this.traffar.length > 50) this.traffar.length = 50;

    if (this.settings.pip) this.#pip(egen);
    this.dispatchEvent(new CustomEvent('traff', { detail: { plat, sakerhet, egen } }));
    this.dispatchEvent(new CustomEvent('lista'));
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
