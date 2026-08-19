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
 *   1. Beskär till siktrutan istället för hela bilden.
 *   2. Skala upp så texten blir ~60 px hög.
 *   3. Klipp bort det blå EU-fältet — stjärnorna läses annars som tecken.
 *   4. Sträck kontrasten och tröskla till svart/vitt (Otsu).
 *   5. Säg åt motorn att det är EN textrad, inte ett dokument.
 *   6. Begränsa alfabetet till de tecken svenska skyltar faktiskt använder.
 *   7. Läs flera bildrutor och kräv att två är överens.
 *
 * Punkt 7 är det som gör den ärlig. En enstaka gissning är en gissning.
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

/**
 * Letar upp själva skylten inne i siktrutan.
 *
 * Utan det här steget skalas hela rutan, och sitter bilen tio meter bort är
 * skylten en tiondel av rutan — texten blir några pixlar hög och motorn läser
 * ingenting. Det var precis så mätningen såg ut innan: rutan gav rätt svar
 * bara när skylten råkade fylla den.
 *
 * Metoden är enkel med flit: skylten är det ljusaste sammanhängande området i
 * rutan, och den är ungefär fem gånger bredare än hög. Det räcker för att
 * skilja den från en bilkropp, och det kostar ingenting jämfört med att lägga
 * in en modell.
 *
 * @returns {object|null} snävare {x,y,w,h} i källans pixlar, eller null
 */
export function hittaPlat(kalla, roi) {
  const AB = 320;                                   // arbetsbredd, håller det billigt
  const skala = Math.min(1, AB / roi.w);
  const b = Math.max(8, Math.round(roi.w * skala));
  const h = Math.max(4, Math.round(roi.h * skala));

  const c = document.createElement('canvas');
  c.width = b; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(kalla, roi.x, roi.y, roi.w, roi.h, 0, 0, b, h);
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
  let bast = null;

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
    if (bw < b * 0.12) continue;
    if (!bast || area > bast.area) bast = { minX, minY, bw, bh, area };
  }
  if (!bast) return null;

  // Tillbaka till källans pixlar, med en nypa marginal så inte kanttecknen
  // kapas av en pixel hit eller dit.
  const inv = 1 / skala;
  const mx = bast.bw * 0.03 * inv, my = bast.bh * 0.08 * inv;
  return {
    x: roi.x + bast.minX * inv - mx,
    y: roi.y + bast.minY * inv - my,
    w: bast.bw * inv + mx * 2,
    h: bast.bh * inv + my * 2,
  };
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

/* ---- Läsaren ------------------------------------------------------------- */

export const plateSupported = !!(navigator.mediaDevices?.getUserMedia && window.OffscreenCanvas !== undefined
  || navigator.mediaDevices?.getUserMedia);

/**
 * Håller kameran, ritar sökaren och matar OCR:en.
 *
 * Händelser:
 *   'traff'   {plat, sakerhet, egen}   en skylt som två bildrutor är överens om
 *   'status'  {text}                   vad den håller på med, för sökarens text
 *   'fel'     {fel}
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
    this.#status('Rikta rutan mot skylten');
    this.#rita();
    // setInterval, inte requestAnimationFrame: rAF står stilla så fort
    // skärmen slocknar eller fliken hamnar i bakgrunden, och då slutade
    // dashcamen spela in mitt i en resa. Samma fälla gäller här.
    this._ocrTimer = setInterval(() => this.#steg(), this.settings.intervalMs);
    this._ritTimer = setInterval(() => this.#rita(), 100);

    // Värm motorn medan användaren riktar in sig, så första läsningen inte
    // tar fem sekunder.
    haMotor().catch(e => this.#fel(e));
  }

  stop() {
    this.running = false;
    clearInterval(this._ocrTimer); clearInterval(this._ritTimer);
    this._ocrTimer = this._ritTimer = null;
    this.#slappStream();
    this.video.srcObject = null;
  }

  rensa() {
    this.traffar = []; this.senaste = []; this.sedd.clear();
    this.dispatchEvent(new CustomEvent('lista'));
  }

  /** Zoom via kameran när telefonen kan, annars digitalt genom en snävare ruta. */
  async zooma(faktor) {
    const t = this.stream?.getVideoTracks?.()[0];
    const k = t?.getCapabilities?.();
    if (k?.zoom) {
      const v = Math.max(k.zoom.min, Math.min(k.zoom.max, faktor));
      try { await t.applyConstraints({ advanced: [{ zoom: v }] }); return true; } catch {}
    }
    this._digitalZoom = faktor;
    return false;
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
   * Siktrutan. Svenska skyltar är 520 × 110 mm, alltså 4,7 gånger bredare än
   * höga. Rutan följer det förhållandet så att en skylt som fyller rutan
   * också fyller bildrutan vi skickar till OCR:en.
   */
  #beraknaRoi(vb, vh) {
    const zoom = this._digitalZoom || 1;
    const w = Math.min(vb * 0.82 / zoom, vh * 2.6);
    const h = w / 4.7;
    return { x: (vb - w) / 2, y: (vh - h) / 2, w, h };
  }

  #rita() {
    const v = this.video;
    if (!v.videoWidth) return;
    const c = this.canvas, g = c.getContext('2d');
    if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
    g.drawImage(v, 0, 0, c.width, c.height);

    const roi = this._roi = this.#beraknaRoi(c.width, c.height);

    // Allt utanför rutan dämpas. Det säger utan text var man ska sikta.
    g.save();
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.beginPath();
    g.rect(0, 0, c.width, c.height);
    g.rect(roi.x, roi.y, roi.w, roi.h);
    g.fill('evenodd');
    g.restore();

    g.strokeStyle = this.arbetar ? '#2fd07a' : '#8fcaff';
    g.lineWidth = Math.max(2, c.width / 320);
    g.strokeRect(roi.x, roi.y, roi.w, roi.h);
  }

  async #steg() {
    if (!this.running || this.arbetar || !this._roi || !this.video.videoWidth) return;
    this.arbetar = true;
    try {
      const { plat, sakerhet } = await lasRuta(this.video, this._roi);
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
    this.#status(antal < this.settings.krav
      ? `Ser ${visaPlat(plat)} — bekräftar…`
      : 'Rikta rutan mot skylten');
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

  #status(text) { this.dispatchEvent(new CustomEvent('status', { detail: { text } })); }
  #fel(fel) { this.dispatchEvent(new CustomEvent('fel', { detail: { fel } })); }
}
