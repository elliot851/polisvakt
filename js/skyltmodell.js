/**
 * SKYLTMODELLEN — sökning och läsning gjord av två små neurala nät.
 *
 * VARFÖR DEN FINNS. Den handskrivna sökningen i plate.js letar efter ett blått
 * EU-band och ljusa fläckar med rätt form. På bilhandlarnas närbilder fungerar
 * det (11 av 21 rätt). På ägarens egna foton tagna från förarplats — samma
 * vinkel som mobilhållaren ger — fungerar det inte alls: 0 av 8 rätt, 0 av 8
 * skyltar ens hittade, och ett uppfunnet nummer. Blåbandsankaret slog inte till
 * en enda gång, inte ens på bilden där bandet fyller en tredjedel av rutan, och
 * spårningen låste i stället på hela grillen. Att höja sökupplösningen från 400
 * till 1280 ändrade ingenting. Det är mätt, inte gissat, och det är hela skälet
 * till att den här filen finns. Bänken heter prov/skyltar/vagb.html.
 *
 * Samma bilder, samma facit, med modellerna: 6 av 8 rätt, 0 uppfunna, 8 av 8
 * hittade. De två som inte lästes är de två rutor där skylten är oläslig även
 * för ett öga — där tiger den, vilket är rätt svar.
 *
 * DEN ERSÄTTER INGENTING PERMANENT. Modulen är ett alternativ som plate.js
 * använder NÄR den är laddad. Tills dess, och på varje enhet där den inte går
 * att ladda, kör den gamla vägen precis som förut. 13 MB modell får aldrig stå
 * mellan användaren och en fungerande app.
 *
 * LICENS. Båda modellerna är MIT (se modeller/LASMIG.md). Det är ett medvetet
 * val: de spridda skyltdetektorerna är Ultralytics-baserade och AGPL-3.0, som
 * smittar över nätverket och kan tvinga fram källkoden till en betaltjänst.
 */

/* onnxruntime-web. WEBGPU-BUNDLEN, inte ort.min.js. Den vanliga bundeln har
 * ingen webgpu-backend alls och svarar "no available backend found" — vilket
 * låter som att telefonen saknar WebGPU fastän den inte gör det. Uppmätt på en
 * maskin med fungerande WebGPU. Den här bundeln innehåller båda, så reserven
 * finns kvar. */
const ORT_BAS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const ORT_URL = ORT_BAS + 'ort.webgpu.min.js';

const DETEKTOR = '/modeller/yolo-v9-t-640-plate.onnx';
const LASARE   = '/modeller/eu-ocr.onnx';

/** Detektorns indatasida. 384-modellen är tre gånger snabbare men blind för små
 *  skyltar: på samma bild föll bästa lådan från 0,70 till 0,04. Räckvidd kostar
 *  upplösning, och räckvidd är hela poängen. */
const DS = 640;
/** Samma tal, utåt. plate.js autozoom behöver veta hur bred bilden är som
 *  detektorn faktiskt ser, för att kunna räkna sitt målband i de pixlarna. */
export const SOKBREDD = DS;
/** Läsarens indata, ur modellens egen config (modeller/eu-ocr-config.yaml). */
const LB = 140, LH = 70;
const ALFABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const PLATSER = 9;

export const MODELL = {
  /** Under det här är lådan inte en skylt. */
  minLada: 0.25,
  /**
   * Under det här säger vi ingenting.
   *
   * Numrets säkerhet är den LÄGSTA säkerheten bland dess tecken — en kedja är
   * inte starkare än sin svagaste länk. På bänken låg varje RÄTT läsning på
   * 0,73–0,79 och varje FEL på 0,09–0,26. Tröskeln ligger mitt i det tomma
   * bandet däremellan, och allt mellan 0,30 och 0,70 ger samma facit. Den är
   * alltså inte intrimmad mot provet, och det är den grinden som gör skillnad
   * på att läsa och att hitta på.
   */
  minTecken: 0.40,
  /** Färre tecken än så är inte ett svenskt registreringsnummer. */
  minTeckenAntal: 5,
};

/* Läget är läsbart utifrån så att gränssnittet kan visa vad som händer i
 * stället för att appen ser sönderlaggad ut medan 13 MB laddas ner. */
const lage = {
  laddar: false,
  laddad: false,
  fel: null,
  motor: null,      // 'webgpu' eller 'wasm', som ORT faktiskt valde
  laddMs: null,
};
export const skyltmodellLage = () => ({ ...lage });

let lofte = null;
let dSess = null, lSess = null;

function laddaSkript(url) {
  return new Promise((ok, nej) => {
    const s = document.createElement('script');
    s.async = true;
    s.src = url;
    s.onload = () => ok();
    s.onerror = () => nej(new Error('kunde inte hämta ' + url));
    document.head.appendChild(s);
  });
}

/**
 * Laddar båda modellerna en gång och återanvänder dem. Samma memoiserings-
 * mönster som `haMotor` i plate.js: misslyckas den nollas löftet så att nästa
 * försök gör om laddningen i stället för att för alltid returnera samma fel.
 */
export function haSkyltmodell() {
  if (lofte) return lofte;
  lage.laddar = true; lage.fel = null;
  const t0 = performance.now();
  lofte = (async () => {
    if (!window.ort) await laddaSkript(ORT_URL);
    ort.env.wasm.wasmPaths = ORT_BAS;
    /*
     * INFERENSEN FÅR INTE LIGGA PÅ HUVUDTRÅDEN.
     *
     * onnxruntimes WASM-backend kör som förval synkront på huvudtråden. Med
     * läsaren på WASM och en läsning per OCR-varv betyder det att varje
     * läsning fryser allt annat: rittimern, sökslingan, knapptryck, kartan.
     * Uppmätt i liveprovet — sidan slutade svara helt, och det var inte ett
     * dödläge utan ren utsvältning. På en telefon i en hållare hade det synts
     * som att appen hakar upp sig varje gång den läser en skylt.
     *
     * `proxy` lägger körningen i en egen arbetartråd. Huvudtråden lämnar bara
     * över indata och får tillbaka svaret.
     */
    ort.env.wasm.proxy = true;
    /*
     * DETEKTORN: WebGPU först, WASM som reserv. Uppmätt 84 ms mot 380 ms per
     * bildruta, med IDENTISKT resultat — samma lådor, samma poäng, samma
     * ordning. En enhet utan WebGPU tappar alltså fart, inte funktion.
     *
     * LÄSAREN: WASM först. Det är inte en försiktighetsåtgärd utan en
     * uppmätt bugg. På WebGPU returnerar läsarnätet BARA NOLLOR — hela
     * utdatatensorn, varje gång, utan att kasta något fel. Avkodningen
     * plockar då index 0 nio gånger och svarar "000000000" med säkerhet 0.
     * Samma indata på WASM ger MDM774. Reproducerat sida vid sida på
     * bilkamera-bänkens bilder. Ett tyst fel svar är farligare än ett
     * kraschande, och den här hade tystat hela läsaren utan ett spår i
     * konsolen.
     */
    /*
     * EN I TAGET, inte Promise.all. Två samtidiga `create` med olika backend
     * får onnxruntime att initiera sitt WASM-lager två gånger och den andra
     * sessionen dör med "multiple calls to initWasm() detected" — alltså
     * exakt när vi ber om webgpu för det ena nätet och wasm för det andra,
     * vilket är precis vad vi gör. Parallellt sparade en halv sekund vid
     * uppstart och kostade hela modellvägen.
     */
    /*
     * OCH LÄSAREN FÖRST. Skapas WebGPU-sessionen först loggar ORT
     * "removing requested execution provider wasm ... multiple calls to
     * initWasm()" när nästa session ber om wasm — den TAR BORT reserven,
     * tyst, ur just den session som måste ha den. Skapas wasm-sessionen
     * först är WASM redan initierat när webgpu läggs till, och båda finns
     * kvar. Hittat i konsolen, inte i dokumentationen.
     */
    lSess = await ort.InferenceSession.create(LASARE,
      { executionProviders: ['wasm'] });
    dSess = await ort.InferenceSession.create(DETEKTOR,
      { executionProviders: ['webgpu', 'wasm'] });

    /*
     * ...och lita inte ens på det. Läsarens utdata är nio softmax-rader, så
     * VARJE rad måste summera till 1. Det är en invariant i modellen själv,
     * inte en tumregel — och det är precis den WebGPU bröt. Håller den inte
     * är näten obrukbara, och då är det bättre att säga det och låta appen
     * köra vidare på den handskrivna vägen än att mata rösträkningen med
     * nollor. Kontrollen kostar en körning på en konstgjord bild, en gång.
     */
    if (!(await lasarenSvararVettigt())) {
      throw new Error('läsarmodellen ger degenererad utdata på den här enheten');
    }

    lage.motor = (navigator.gpu ? 'webgpu (sökning) + wasm (läsning)' : 'wasm');
    lage.laddad = true;
    lage.laddar = false;
    lage.laddMs = Math.round(performance.now() - t0);
    return true;
  })().catch(e => {
    lofte = null;
    dSess = lSess = null;
    lage.laddar = false; lage.laddad = false; lage.fel = e.message;
    throw e;
  });
  return lofte;
}

/** Sant först när båda näten går att köra. plate.js frågar den varje varv. */
export const skyltmodellRedo = () => !!(dSess && lSess);

/**
 * Svarar läsaren över huvud taget något meningsfullt?
 *
 * Utdatan är nio softmax-rader à 37 tecken. Summan av en softmax-rad är 1 —
 * alltid, för alla indata, på alla enheter. Går summan inte att känna igen som
 * 1 räknar nätet inte, och då spelar det ingen roll vad avkodningen skulle ha
 * sagt. Bilden vi provar med behöver inte föreställa en skylt; det som mäts är
 * att matematiken kommer ut, inte vad den kom fram till.
 */
async function lasarenSvararVettigt() {
  try {
    const prov = new Uint8Array(LB * LH);
    for (let i = 0; i < prov.length; i++) prov[i] = (i * 7) & 0xff;
    const t = new ort.Tensor('uint8', prov, [1, LH, LB, 1]);
    const svar = await iTur(() => lSess.run({ [lSess.inputNames[0]]: t }));
    const d = svar[lSess.outputNames[0]].data;
    if (!d || d.length !== PLATSER * ALFABET.length) return false;
    for (let s = 0; s < PLATSER; s++) {
      let summa = 0;
      for (let c = 0; c < ALFABET.length; c++) summa += d[s * ALFABET.length + c];
      if (!(summa > 0.9 && summa < 1.1)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/*
 * EN KÖ FÖR ALLA MODELLANROP.
 *
 * onnxruntime tål inte två `run()` samtidigt — inte ens på två olika
 * sessioner, när de delar arbetartråd. Den andra kastar
 * "Session already started", och därefter är körningen trasig: nästa anrop
 * dör på "Cannot read properties of null" inne i wasm-lagret.
 *
 * Det är precis vad som händer här, för sökningen och läsningen går i två
 * OBEROENDE slingor i plate.js med olika takt. De krockar inte varje varv,
 * bara ibland — den värsta sortens fel. Uppmätt i liveprovet: låset satt,
 * statusen sa "Bekräftar skylt…", och sedan kom aldrig ett enda nummer ut.
 *
 * Kön är hela lösningen: anropen ställer sig i led och körs ett i taget.
 * Något arbete går inte förlorat, det väntar. Att de i praktiken redan var
 * serialiserade av hårdvaran gör kostnaden liten — det som försvinner är
 * krocken, inte kapaciteten.
 */
let ko = Promise.resolve();
function iTur(arbete) {
  const nasta = ko.then(arbete, arbete);
  // Kön får aldrig fastna i ett avvisat löfte: då skulle varje efterföljande
  // anrop ärva felet utan att ens ha körts.
  ko = nasta.then(() => {}, () => {});
  return nasta;
}

/*
 * En återanvänd duk per storlek. Att skapa en 640×640-canvas per bildruta är
 * en allokering på 1,6 MB tio gånger i sekunden.
 *
 * OCH INGET `willReadFrequently`. Flaggan ser ut att höra hemma här — vi läser
 * ju ut varenda pixel varje bildruta — men den betyder "lägg duken i
 * huvudminnet", och då görs nedskalningen av videon i programvara i stället
 * för på grafikkortet.
 *
 * UPPMÄTT på en 2560×1440-film (prov/skyltar/bildkostnad.html):
 *   drawImage med willReadFrequently .... 19,8 ms
 *   drawImage utan ....................... under 0,1 ms
 *   getImageData med ...................... 0,9 ms
 *   getImageData utan ..................... 0,7 ms
 * Flaggan kostade alltså 19,8 ms per sökning och gjorde återläsningen
 * långsammare, inte snabbare. Det var den enskilt största posten före
 * modellen, och den var ren förlust.
 */
const dukar = new Map();
function duk(b, h) {
  const nyckel = b + 'x' + h;
  let d = dukar.get(nyckel);
  if (!d) {
    d = document.createElement('canvas');
    d.width = b; d.height = h;
    d.ctx = d.getContext('2d');
    dukar.set(nyckel, d);
  }
  return d;
}

/*
 * 256 färdiga värden i stället för en division per färgkanal och pixel.
 * 640×640×3 är 1,2 miljoner divisioner per bildruta; uppmätt 6,6 ms mot
 * 4,3 ms med tabellen. Litet, men det är ren vinst på varje sökning.
 */
const DELAT_255 = new Float32Array(256);
for (let i = 0; i < 256; i++) DELAT_255[i] = i / 255;

/**
 * Brevlådeskalning: krymp med BEVARADE proportioner och fyll ut resten grått.
 *
 * En rak omskalning till 640×640 klämmer ihop en 16:9-ruta på höjden. En skylt
 * är redan avlång, och hoptryckt blir den en form modellen aldrig sett under
 * träningen. Skalan och kanterna följer med tillbaka så lådorna kan räknas om
 * till videons koordinater.
 */
function brevlada(kalla, yta) {
  const skala = Math.min(DS / yta.w, DS / yta.h);
  const nb = Math.round(yta.w * skala), nh = Math.round(yta.h * skala);
  const dx = Math.floor((DS - nb) / 2), dy = Math.floor((DS - nh) / 2);
  const d = duk(DS, DS);
  d.ctx.fillStyle = '#727272';         // 114,114,114 — samma utfyllnad som vid träning
  d.ctx.fillRect(0, 0, DS, DS);
  d.ctx.drawImage(kalla, yta.x, yta.y, yta.w, yta.h, dx, dy, nb, nh);
  return { d, skala, dx, dy };
}

function detektTensor(d) {
  const px = d.ctx.getImageData(0, 0, DS, DS).data;
  const antal = DS * DS;
  const ut = new Float32Array(3 * antal);
  for (let i = 0, p = 0; i < antal; i++, p += 4) {
    ut[i]             = DELAT_255[px[p]];
    ut[i + antal]     = DELAT_255[px[p + 1]];
    ut[i + 2 * antal] = DELAT_255[px[p + 2]];
  }
  return new ort.Tensor('float32', ut, [1, 3, DS, DS]);
}

/**
 * Söker skyltar i `yta` och lämnar tillbaka kandidater i EXAKT samma form som
 * `sokKandidater` i plate.js — samma fältnamn, samma koordinatsystem (videons
 * pixlar, inte ytans). Det är det som gör att `Malsokare` och `lasKandidat`
 * inte behöver veta att sökningen bytts ut.
 *
 * `ankrad: true` är det fält som betyder något: då hoppar `lasKandidat` över
 * sin egen sökning inne i rutan, för rutan ÄR skylten. Utan flaggan letar den
 * efter skylten en gång till, i en bild som redan bara innehåller skylten.
 *
 * @returns {Promise<Array<object>>}
 */
export async function sokMedModell(kalla, yta) {
  if (!dSess) return [];
  /* Bilden tas ur videon FÖRE kön. Väntar vi på tur med en referens till
   * videoelementet läser vi en nyare bildruta än den vi trodde, och lådorna
   * beskriver då ett annat ögonblick än det som mättes. */
  const bl = brevlada(kalla, yta);
  const indata = detektTensor(bl.d);
  const svar = await iTur(() => dSess.run({ images: indata }));
  const ut = svar[dSess.outputNames[0]];
  const kolumner = ut.dims[1] || 7;
  const kandidater = [];
  for (let i = 0; i < ut.dims[0]; i++) {
    const o = i * kolumner;
    /*
     * [N,7] = [bild, x1, y1, x2, y2, KLASS, POÄNG]. Poängen ligger SIST.
     * Läser man plats 5 som poäng blir varje låda 0,00 och det ser ut som att
     * modellen inte hittar något — den hittade skylten med 0,88.
     */
    const poang = ut.data[o + 6];
    if (poang < MODELL.minLada) continue;
    const x1 = yta.x + (ut.data[o + 1] - bl.dx) / bl.skala;
    const y1 = yta.y + (ut.data[o + 2] - bl.dy) / bl.skala;
    const x2 = yta.x + (ut.data[o + 3] - bl.dx) / bl.skala;
    const y2 = yta.y + (ut.data[o + 4] - bl.dy) / bl.skala;
    const b = x2 - x1, h = y2 - y1;
    if (!(b > 4 && h > 3)) continue;
    kandidater.push({
      x: x1, y: y1, w: b, h,
      cx: (x1 + x2) / 2, cy: (y1 + y2) / 2,
      /* Samma lilla marginal som ankarvägen lägger på, så beskärningen inte
       * skär i tecknens ytterkanter. */
      rw: b * 1.03, rh: h * 1.08,
      /* Modellen ger räta lådor. En lutande skylt blir därför något sämre
       * beskuren än vad blåbandsankaret klarade — en känd kostnad, och den
       * betalas med att skylten över huvud taget hittas. */
      vinkel: 0,
      euAndel: 0.115,          // svensk skylt: EU-fältet är ~11,5 % av bredden
      ankrad: true,
      antagenBredd: false,
      omvand: false,
      overHorisont: false,
      mjukZon: false,
      /* Malsokare väger med poängen och låser inte under MALSOK.minPoang
       * (0,16). Detektorns egen säkerhet är ett ärligare mått än den
       * handräknade poängen någonsin var, så den går in rakt av. */
      poang,
      modell: true,
    });
  }
  kandidater.sort((a, b) => b.poang - a.poang);
  return kandidater;
}

/**
 * Skyltutklippet → läsarens indata: 140×70, gråskala, uint8, NHWC.
 *
 * uint8 0–255, INTE 0–1. Normaliserar man blir bilden kolsvart för modellen,
 * och den svarar med nio utfyllnadstecken utan att klaga — en tyst nolla som
 * ser ut som att skylten var oläslig.
 */
function lasarTensor(kalla, r) {
  const d = duk(LB, LH);
  d.ctx.drawImage(kalla, r.x, r.y, r.w, r.h, 0, 0, LB, LH);
  const px = d.ctx.getImageData(0, 0, LB, LH).data;
  const ut = new Uint8Array(LB * LH);
  for (let i = 0, p = 0; i < ut.length; i++, p += 4) {
    ut[i] = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
  }
  return new ort.Tensor('uint8', ut, [1, LH, LB, 1]);
}

/**
 * Avkodar [1, 333] = 9 teckenplatser × 37 tecken.
 *
 * Per plats: softmax-andelen för det troligaste tecknet är den platsens
 * säkerhet. Utfyllnadstecknet `_` avslutar numret. Hela numrets säkerhet är
 * den LÄGSTA över de riktiga tecknen — ett enda osäkert tecken räcker för att
 * numret ska vara fel, och ett medelvärde hade dolt precis det.
 */
function avkoda(data) {
  let text = '', lagsta = 1;
  for (let s = 0; s < PLATSER; s++) {
    const o = s * ALFABET.length;
    let bast = 0, summa = 0;
    for (let c = 0; c < ALFABET.length; c++) {
      summa += data[o + c];
      if (data[o + c] > data[o + bast]) bast = c;
    }
    const tecken = ALFABET[bast];
    if (tecken === '_') break;
    const sakerhet = summa > 0 ? data[o + bast] / summa : 0;
    if (sakerhet < lagsta) lagsta = sakerhet;
    text += tecken;
  }
  return { text, sakerhet: text ? lagsta : 0 };
}

/**
 * Läser en kandidat. Svaret har samma form som `lasKandidat` i plate.js —
 * `{ plat, sakerhet, exaktSex, ratext, tider }` — så rösträkningen och allt
 * ovanför den är oförändrat.
 *
 * `sakerhet` är 0–100, samma skala som Tesseract använde, för att `rostvikt`
 * ska väga rätt. Och här finns äntligen något att väga: Tesseract svarade
 * 0 % på ALLA 22 provbilder, även på rätta läsningar, så rösträkningen har
 * hittills vägt varje läsning lika. Den här modellen skiljer 0,73 från 0,20.
 *
 * Råtexten går genom plate.js egna `tolkaRatext`. Det är med flit: där sitter
 * formatkontrollen, och rättningen av tecken som ser lika ut på just den
 * position där de står (nolla mot O på en bokstavsplats). Modellen får alltså
 * inte förbi någon grind som den gamla läsaren behövde passera.
 *
 * @param {Function} tolkaRatext plate.js egen tolkning, inskickad för att
 *        undvika att de två modulerna importerar varandra
 */
export async function lasMedModell(kalla, kandidat, tolkaRatext) {
  if (!lSess) return { plat: null, sakerhet: 0, exaktSex: false, ratext: '' };
  const t0 = performance.now();
  const b = kandidat.rw || kandidat.w;
  const h = kandidat.rh || kandidat.h;
  const cx = kandidat.cx ?? (kandidat.x + kandidat.w / 2);
  const cy = kandidat.cy ?? (kandidat.y + kandidat.h / 2);
  const r = { x: cx - b / 2, y: cy - h / 2, w: b, h };
  if (!(r.w > 4 && r.h > 3)) {
    return { plat: null, sakerhet: 0, exaktSex: false, ratext: '' };
  }

  const indata = lasarTensor(kalla, r);   // ur videon före kön, se `sokMedModell`
  const svar = await iTur(() => lSess.run({ [lSess.inputNames[0]]: indata }));
  const { text, sakerhet } = avkoda(svar[lSess.outputNames[0]].data);
  const ocrMs = performance.now() - t0;
  const tider = { ocrAntal: 1, ocrMs, forbMs: 0, hittaMs: 0, ankrad: !!kandidat.ankrad };

  /*
   * GRINDEN. Under tröskeln säger vi ingenting alls — vi lämnar inte ifrån oss
   * en osäker gissning och låter rösträkningen sortera ut den, för en gissning
   * som råkar upprepas blir en röst. Ett uppfunnet nummer är sämre än tystnad.
   */
  if (text.length < MODELL.minTeckenAntal || sakerhet < MODELL.minTecken) {
    return { plat: null, sakerhet: Math.round(sakerhet * 100), exaktSex: false,
             ratext: text, tider, modell: true };
  }
  const t = tolkaRatext(text);
  return {
    plat: t.plat,
    exaktSex: !!(t.plat && t.exaktSex),
    sakerhet: Math.round(sakerhet * 100),
    ratext: text,
    tider,
    modell: true,
  };
}
