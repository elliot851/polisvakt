// Värmevakt — märker när telefonen slutat hinna med, och säger det rakt ut.
//
// FÖRST DET VIKTIGASTE: den här modulen mäter INTE temperatur.
//
// Webben har ingen termometer. Det finns inget API som säger hur varm en
// telefon är, och det kommer inte heller. Namnet "värmevakt" är vardagsspråk
// för det som faktiskt händer i en bil — telefon i vindrutefäste, sol,
// GPS på högsta noggrannhet, skärmen tvingad tänd, canvas som ritas trettio
// gånger i sekunden och H.264 som kodas parallellt — men det modulen läser av
// är inte grader. Det är om appen fortfarande hinner med sitt eget arbete.
//
// Skillnaden är inte akademisk. "Telefonen är 46 grader" är ett påstående vi
// inte kan belägga. "Kameran levererar 12 bilder i sekunden av utlovade 30"
// är en mätning. Det första hade varit en gissning klädd i siffror, och en
// app som gissar med decimaler blir trodd på fel grunder. Därför står det
// aldrig "överhettad" någonstans i den här filen — varken i koden, i texten
// på skärmen eller i det som sägs högt.
//
// Vad som mäts, vad som härleds och vad som är rena antaganden står i
// docs/VARME.md, uppdelat i den ordningen. Håll den uppdelningen levande.
//
// Modulen ändrar ingenting själv. Den observerar dashcamen läsande — den rör
// aldrig dess inställningar — och skickar ifrån sig rekommendationer som
// händelser. Den som kopplar in appen bestämmer om de ska följas. Det är
// medvetet: en modul som både bedömer läget och drar i spakarna går inte att
// felsöka den dagen den drar i fel spak.
//
// Disciplinen kring rösten är hämtad rakt av från js/vakthund.js: säg det en
// gång, säg det bara när det spelar roll, upprepa inte, och tala om när det
// blir bra igen. En förare som får höra om varje sänkt bildruta stänger av
// ljudet — och då tystnar polisvarningarna också.

const SEK = 1000;

/* ================= Inställningar ================= */

export const DEFAULTS = {
  /**
   * Hur ofta läget vägs samman. Tio sekunder är samma takt som vakthunden
   * kontrolleras i, av samma skäl: strypning yttrar sig som att arbete
   * UTEBLIR, och då kommer det inga anrop att hänga bedömningen på.
   */
  kontrollMs: 10 * SEK,

  /**
   * Uppvärmningstid innan något alls bedöms.
   *
   * De första sekunderna efter kamerastart är alltid hackiga: två
   * getUserMedia, IndexedDB som öppnas, canvasen som storleksändras och
   * MediaRecorder som startar. Bedömer man den perioden flaggas varenda
   * körning som strypt inom tjugo sekunder efter start, och då betyder
   * flaggan ingenting.
   */
  uppvarmningMs: 25 * SEK,

  /** Poäng som krävs för respektive läge. Se #vag() för vad poängen består av. */
  warmPoang: 2,
  hotPoang: 4,

  /**
   * Lägre gränser för att LÄMNA ett läge än för att gå in i det.
   *
   * Det här är hela hysteresen. Utan den studsar bedömningen kring
   * tröskeln — två poäng, ett poäng, två poäng — och varje studs vill
   * antingen sänka eller höja kvaliteten. Resultatet blir en dashcam som
   * byter upplösning varje halvminut, vilket kostar mer prestanda än det
   * någonsin sparar eftersom varje byte klipper ett segment.
   */
  lamnaWarm: 1,
  lamnaHot: 2,

  /** Hur länge ett sämre läge måste hålla i sig innan vi tror på det. */
  bekraftaUppMs: 20 * SEK,

  /**
   * Hur länge ett bättre läge måste hålla i sig innan vi tror på det.
   *
   * Mycket längre än uppgången, och det är avsiktligt asymmetriskt. En
   * telefon som blivit varm blir inte sval för att man kört in i en tunnel i
   * tjugo sekunder. Kyler man ned för lätt höjer man kvaliteten precis lagom
   * ofta för att aldrig hinna kylas på riktigt.
   */
  bekraftaNerMs: 120 * SEK,

  /**
   * Hårda fakta får gå fortare.
   *
   * Att kameraspåret tystnat eller att inspelaren slutat leverera data är
   * inte en slutsats dragen ur mätvärden — det är sakläget. Där finns inget
   * att bekräfta bort.
   */
  bekraftaHartMs: 5 * SEK,

  /** Kortaste tid i ett läge innan det får bytas igen. */
  minTidILageMs: 60 * SEK,

  /** Hur länge vi väntar mellan två steg nedåt i trappan när läget är warm. */
  stegPausMs: 90 * SEK,

  /** Samma sak när läget är hot. Kortare — då är det bråttom. */
  stegPausHotMs: 45 * SEK,

  /** Hur länge läget måste vara normalt innan vi tar tillbaka ett steg. */
  aterstallStegMs: 3 * 60 * SEK,

  /** Kortaste tid mellan två likadana talade besked. */
  upprepaTidigastMs: 10 * 60 * SEK,
};

/* ================= Trappan ================= */

/**
 * Åtgärder i den ordning som gör minst skada först.
 *
 * Resonemanget bakom ordningen, eftersom den är hela modulens omdöme:
 *
 * 1–2. UPPLÖSNING. Kostnaden för att rita och koda växer med antalet pixlar.
 *      1080p → 720p är mer än en halvering av arbetet. Priset är detaljer i
 *      en film man förhoppningsvis aldrig behöver. Allt blir fortfarande
 *      filmat, hela tiden, och en registreringsskylt går att läsa i 720p.
 *
 * 3–4. BILDFREKVENS. Nästa största besparing. 30 → 15 bilder i sekunden är
 *      hälften av kodningsarbetet och filmen är fortfarande sammanhängande.
 *      Ligger efter upplösningen därför att låg bildfrekvens gör snabba
 *      förlopp — just de förlopp man filmar för — svårare att tyda.
 *
 * 5.   KUPÉKAMERAN. Först här, trots att den sparar en hel kamerapipeline
 *      och ett komponeringssteg. Skälet är att den är avstängd som standard:
 *      har föraren slagit på den vill han se kupén, och att tyst ta bort en
 *      påslagen funktion är värre än att göra kvar funktionen sämre.
 *
 * 6.   GPS-NOGGRANNHETEN. Sent, för här börjar det kosta appens hela syfte.
 *      Polisvakt varnar för polis och fartkameror; sämre positioner betyder
 *      senare varningar. Dashcamen är bevis, GPS:en är själva funktionen.
 *      Bevis får bli grynigt innan funktionen får bli trubbig.
 *
 * 7.   STOPPA INSPELNINGEN. Sist. Telefonen kommer att göra det åt oss om vi
 *      inte gör det själva — skillnaden är att när vi gör det säger vi till,
 *      och varningarna lever vidare. En tyst avstannad dashcam är precis det
 *      här projektets värsta fel: föraren tror att han filmar.
 *
 * `atgard` är avsiktligt data och inte kod. Modulen ska inte kunna röra
 * dashcam.js eller geo.js ens av misstag.
 *
 * `nivaKrav` är den andra spärren. De fem första stegen gör filmen sämre och
 * får tas redan när telefonen bara halkar efter (warm). De två sista rör
 * appens själva uppgift och kräver att läget är hot. Utan den spärren
 * vandrar en lätt belastad telefon steg för steg ända ned till avstängd
 * dashcam och trubbig GPS, bara för att den halkat efter en aning länge nog
 * — och det är inte proportionerligt.
 */
export const STEGE = [
  {
    id: 'upplosning-1',
    grupp: 'upplosning',
    nivaKrav: 'warm',
    atgard: { modul: 'dashcam', satt: 'quality', varde: 'medium' },
    text: 'Telefonen hinner inte med. Dashcamen går ner till 720p.',
    // Det enda talade beskedet i den övre halvan av trappan. Föraren tror
    // sig ha 1080p på film; ändras det ska han få veta det en gång.
    tal: 'Telefonen hinner inte med inspelningen. Jag sänker videokvaliteten så att den inte stannar.',
    ater: 'Dashcamen är tillbaka på full kvalitet.',
    skal: 'Färre pixlar att rita och koda. Största besparingen per förlorad detalj.',
  },
  {
    id: 'upplosning-2',
    grupp: 'upplosning',
    nivaKrav: 'warm',
    atgard: { modul: 'dashcam', satt: 'quality', varde: 'low' },
    text: 'Dashcamen går ner till 480p för att fortsätta spela in.',
    tal: null,
    ater: null,
    skal: 'Sista upplösningssteget innan bildfrekvensen måste offras.',
  },
  {
    id: 'bildfrekvens-1',
    grupp: 'bildfrekvens',
    nivaKrav: 'warm',
    atgard: { modul: 'dashcam', satt: 'fps', varde: 20 },
    text: 'Dashcamen spelar in i 20 bilder per sekund.',
    tal: null,
    ater: null,
    skal: 'En tredjedel mindre kodningsarbete. Filmen är fortfarande sammanhängande.',
  },
  {
    id: 'bildfrekvens-2',
    grupp: 'bildfrekvens',
    nivaKrav: 'warm',
    atgard: { modul: 'dashcam', satt: 'fps', varde: 15 },
    text: 'Dashcamen spelar in i 15 bilder per sekund.',
    tal: null,
    ater: null,
    skal: 'Halva kodningsarbetet. Under det här blir snabba förlopp svårlästa.',
  },
  {
    id: 'kupekamera',
    grupp: 'kupekamera',
    nivaKrav: 'warm',
    atgard: { modul: 'dashcam', satt: 'dual', varde: false },
    text: 'Kupékameran stängs av. Vägen framåt spelas in som vanligt.',
    tal: null,
    ater: 'Kupékameran är på igen.',
    skal: 'En hel kamera och ett komponeringssteg mindre per bildruta.',
  },
  {
    id: 'gps',
    grupp: 'gps',
    nivaKrav: 'hot',
    atgard: {
      modul: 'geo',
      satt: 'watchOptions',
      varde: { enableHighAccuracy: false, maximumAge: 5000, timeout: 20000 },
    },
    text: 'GPS:en går på sparlåga. Varningarna kan komma något senare.',
    // Talas, för att det här är första steget som gör appen sämre på det den
    // finns till för. Tystnad här hade varit ett löfte vi inte längre håller.
    tal: 'Telefonen är hårt belastad. Jag sänker GPS-noggrannheten, så varningarna kan komma något senare.',
    ater: 'GPS:en är tillbaka på full noggrannhet.',
    skal: 'Sparar radio och processor, men kostar precision i det appen finns till för.',
  },
  {
    id: 'stopp',
    grupp: 'stopp',
    nivaKrav: 'hot',
    atgard: { modul: 'dashcam', anrop: 'stop' },
    text: 'Dashcamen är stoppad. Polisvarningarna fortsätter som vanligt.',
    tal: 'Telefonen orkar inte spela in mer. Jag stänger av dashcamen. Varningarna fortsätter.',
    ater: 'Dashcamen spelar in igen.',
    skal: 'Sista utvägen. Hellre avstängd med besked än avsomnad i tysthet.',
  },
];

/** normal < warm < hot */
const RANG = { normal: 0, warm: 1, hot: 2 };

/* ================= Småverktyg ================= */

const median = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Ringbuffert utan allokeringar per prov. */
class Ring {
  constructor(n) { this.n = n; this.v = []; }
  push(x) { this.v.push(x); if (this.v.length > this.n) this.v.shift(); }
  get full() { return this.v.length >= this.n; }
  clear() { this.v.length = 0; }
}

/* ================= Värmevakten ================= */

export class Varmevakt extends EventTarget {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.aktiv = false;

    this.niva = 'normal';
    this.poang = 0;
    this.signaler = {};           // senaste avlästa värden, för felsökning och UI

    this.startad = 0;             // när bevakningen startade (uppvärmning)
    this.nivaSedan = 0;
    this.kandidat = null;         // { niva, sedan } — läge på väg att bekräftas

    this.stegIndex = -1;          // hur långt ned i trappan vi rekommenderat
    this.stegAt = 0;              // när senaste steget rekommenderades
    this.normalSedan = 0;         // när läget senast blev normalt
    this.utforda = new Map();     // steg-id -> bekräftat utfört av den som kopplar
    this.ursprungliga = new Map();// grupp -> inställningen som gällde innan vi rörde den

    // Talat: samma bokföring som vakthunden gör, så beteendet blir identiskt.
    this.sagt = new Map();        // nyckel -> { sagtAt, annonserat }

    /* --- mätprober --- */
    this.rafId = null;
    this.rafTider = new Ring(90);
    this.basRafFps = null;        // enhetens EGEN normalfrekvens, inte antagna 60
    this.timer = null;
    this.timerVantat = 0;
    this.timerDrift = new Ring(12);

    this.ritTider = new Ring(90); // matas utifrån, om någon matar
    this.sistaRit = 0;

    this.sistaData = 0;           // senaste tecken på liv från inspelaren
    this.sistaChunkAntal = -1;

    this.kameraProv = null;       // { t, ramar }
    this.kamerataktRatio = null;

    this.batteriProv = [];        // { t, niva, laddar }
    this.batteriStodjs = false;

    this.tryck = null;            // PressureObserver-tillstånd, om det finns
    this.tryckStodjs = false;
    this.tryckObs = null;

    this.dashcam = null;          // observeras läsande, aldrig skrivande
    this._synlighet = null;
  }

  setOptions(o) { this.opts = { ...this.opts, ...o }; }

  /* ---------------- Koppling till plattformens signaler ---------------- */

  /**
   * Koppla på det som plattformen råkar erbjuda.
   *
   * Två saker finns, och båda saknas där de skulle behövas mest:
   *
   * - Battery Status API (navigator.getBattery) finns bara i Chromium.
   *   Safari har aldrig haft det och Firefox tog bort det. iPhone — den
   *   telefon som stryper hårdast av alla — ger oss alltså ingenting här.
   *
   * - Compute Pressure API (PressureObserver) är det närmaste webben har
   *   kommit en värmemätare, men den finns bara i Chrome på DATOR. Chrome
   *   för Android har den inte, Safari har den inte. Den kommer i praktiken
   *   aldrig att vara påslagen i en bil. Vi läser den ändå, dels för att den
   *   är gratis när den finns, dels för att den gör felsökning vid skrivbordet
   *   ärligare. Källan "thermals" finns i specifikationen men är inte
   *   implementerad någonstans — bara "cpu" går att observera.
   *
   * Saknas de degraderar vi. Vi låtsas aldrig att vi vet.
   */
  async koppla() {
    // Batteri
    try {
      const b = await navigator.getBattery?.();
      if (b) {
        this.batteriStodjs = true;
        const las = () => this.#noteraBatteri(b.level, b.charging);
        las();
        b.addEventListener('levelchange', las);
        b.addEventListener('chargingchange', las);
      }
    } catch { this.batteriStodjs = false; }

    // Systemtryck
    try {
      const kallor = window.PressureObserver?.knownSources || [];
      if (window.PressureObserver && kallor.includes('cpu')) {
        this.tryckObs = new PressureObserver(poster => {
          const sista = poster[poster.length - 1];
          if (sista) { this.tryck = sista.state; this.tryckStodjs = true; }
        });
        await this.tryckObs.observe('cpu', { sampleInterval: 2000 });
        this.tryckStodjs = true;
      }
    } catch {
      // observe() kastar NotSupportedError på plattformar som saknar källan.
      this.tryckStodjs = false;
      this.tryckObs = null;
    }

    return { batteri: this.batteriStodjs, tryck: this.tryckStodjs };
  }

  /**
   * Observera dashcamen. LÄSANDE — modulen skriver aldrig i den.
   *
   * Allt som läses här är publika fält i js/dashcam.js: recording, mode,
   * segmentChunks, settings och videoelementen. Ingen av avläsningarna
   * ändrar något, och ingen av dem kräver att dashcam.js skrivs om.
   */
  observera(dashcam) {
    this.dashcam = dashcam || null;
    return this;
  }

  /* ---------------- Start och stopp ---------------- */

  start(now = Date.now()) {
    if (this.aktiv) return;
    this.aktiv = true;
    this.startad = now;
    this.nivaSedan = now;
    this.normalSedan = now;
    this.sistaData = now;
    this.sistaChunkAntal = -1;
    this.kameraProv = null;
    this.rafTider.clear();
    this.timerDrift.clear();
    this.basRafFps = null;

    this.#startRaf();
    this.#startTimer();

    // Bakgrundsflik: både rAF och timers stryps hårt när sidan inte visas.
    // Mätvärdena därifrån är inte strypning på grund av belastning, det är
    // webbläsarens normala energisparande — och att blanda ihop de två hade
    // gjort att appen sänkte kvaliteten varje gång föraren tittade på kartan
    // i en annan app. Vi kastar proverna och pausar bedömningen istället.
    this._synlighet = () => {
      if (document.visibilityState === 'visible') {
        this.rafTider.clear();
        this.timerDrift.clear();
        this.kameraProv = null;
        this.#startRaf();
      } else {
        this.#stoppRaf();
      }
    };
    document.addEventListener('visibilitychange', this._synlighet);
  }

  stopp() {
    this.aktiv = false;
    this.#stoppRaf();
    clearInterval(this.timer); this.timer = null;
    if (this._synlighet) {
      document.removeEventListener('visibilitychange', this._synlighet);
      this._synlighet = null;
    }
  }

  #startRaf() {
    if (this.rafId != null) return;
    let forra = 0;
    const steg = ts => {
      if (forra) {
        const dt = ts - forra;
        // Hopp över en sekund är inte tappade bildrutor, det är ett avbrott
        // — fliken låg still, telefonen ringde, användaren bytte app. Räknas
        // de som strypning ser varje återkomst ut som ett haveri.
        if (dt > 0 && dt < 1000) this.rafTider.push(dt);
      }
      forra = ts;
      this.rafId = requestAnimationFrame(steg);
    };
    this.rafId = requestAnimationFrame(steg);
  }

  #stoppRaf() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /**
   * Egen timerprob.
   *
   * Mäter hur mycket senare än beställt en setInterval faktiskt vaknar. Det
   * är samma sorts timer som driver dashcamens ritloop, på samma tråd — går
   * vår 500-millisekunderstimer 900 millisekunder är det ingen gissning att
   * ritloopens 33-millisekunderstimer också halkat.
   *
   * Svag för sig själv: en lång rendering av rapportlistan ger samma utslag.
   * Därför väger den lätt och räknas bara ihop med annat.
   */
  #startTimer() {
    clearInterval(this.timer);
    const period = 500;
    this.timerVantat = performance.now() + period;
    this.timer = setInterval(() => {
      const nu = performance.now();
      if (document.visibilityState === 'visible') {
        this.timerDrift.push(Math.max(0, nu - this.timerVantat) / period);
      }
      this.timerVantat = nu + period;
    }, period);
  }

  /* ---------------- Inmatning utifrån (frivillig) ---------------- */

  /**
   * Anropas en gång per ritad bildruta, om den som kopplar in vill mata oss.
   *
   * Det här är den ärligaste mätningen som finns i hela modulen — uppnådd
   * ritfrekvens mot beställd — men den kräver att någon i ritloopen ropar
   * hit. Uteblir den säger vi inte att ritfrekvensen är bra; vi säger att
   * vi inte vet, och lutar oss på kameraräknarna istället.
   */
  noteraBildruta(now = performance.now()) {
    if (this.sistaRit) {
      const dt = now - this.sistaRit;
      if (dt > 0 && dt < 2000) this.ritTider.push(dt);
    }
    this.sistaRit = now;
  }

  /** Anropas vid MediaRecorder-händelsen dataavailable, om någon matar oss. */
  noteraInspelningsdata(_bytes, now = Date.now()) {
    this.sistaData = now;
  }

  /** Bekräfta att ett rekommenderat steg faktiskt genomfördes. */
  stegUtfort(id, ok = true) {
    this.utforda.set(id, !!ok);
    this.#emit('change');
  }

  #noteraBatteri(niva, laddar) {
    const nu = Date.now();
    this.batteriProv.push({ t: nu, niva, laddar });
    // Femton minuter räcker: längre historik gör inte takten säkrare, den gör
    // bara att en gammal laddningsperiod smittar av sig på nuläget.
    const gr = nu - 15 * 60 * SEK;
    while (this.batteriProv.length && this.batteriProv[0].t < gr) this.batteriProv.shift();
  }

  /* ---------------- Avläsningar ---------------- */

  /**
   * Hur många bildrutor kameran faktiskt levererat, delat med hur många den
   * lovade.
   *
   * Det här är modulens starkaste signal, och den enda som mäter kameran och
   * inte oss själva. Videoelementets egna räknare talar om hur många rutor
   * som kommit fram från kameraströmmen. Utlovad takt läser vi ur spårets
   * getSettings().frameRate — den siffran är vad telefonen GICK MED PÅ, inte
   * vad den levererar, och just glappet mellan de två är det vi letar efter.
   *
   * Safari har inte getVideoPlaybackQuality utan de äldre webkit-räknarna, så
   * båda läses. Står räknarna stilla — vilket händer om webbläsaren aldrig
   * komponerar det två pixlar stora videoelementet — returnerar vi null, inte
   * noll. Noll hade betytt "kameran är död" och tyst stoppat inspelningen.
   */
  #lasKameratakt(now) {
    const dc = this.dashcam;
    const video = dc?.rearVideo;
    const spar = dc?.rearStream?.getVideoTracks?.()[0];
    if (!video || !spar) return null;

    let ramar = null;
    try {
      const q = video.getVideoPlaybackQuality?.();
      if (q && Number.isFinite(q.totalVideoFrames)) ramar = q.totalVideoFrames;
      else if (Number.isFinite(video.webkitDecodedFrameCount)) ramar = video.webkitDecodedFrameCount;
    } catch { ramar = null; }
    if (ramar == null) return null;

    const forra = this.kameraProv;
    this.kameraProv = { t: now, ramar };
    if (!forra) return null;

    const dt = (now - forra.t) / 1000;
    const dRamar = ramar - forra.ramar;
    if (dt < 3) return this.kamerataktRatio;      // för kort fönster för att säga något
    if (dRamar <= 0) return null;                 // räknaren står still: vet inte, inte noll

    const uppnatt = dRamar / dt;
    let mal = 30;
    try {
      const s = spar.getSettings?.() || {};
      if (Number.isFinite(s.frameRate) && s.frameRate > 0) mal = s.frameRate;
    } catch {}
    this.kamerataktRatio = Math.min(2, uppnatt / mal);
    return this.kamerataktRatio;
  }

  /**
   * Är kameraspåret fortfarande vid liv?
   *
   * Det här är inte en slutsats, det är sakläget. iOS sätter muted på spåret
   * när systemet tar kameran ifrån oss, och readyState blir 'ended' när den
   * är borta för gott. Båda är exakt det haveri modulen finns till för att
   * fånga: bilden slutar komma medan appen fortsätter påstå att den spelar in.
   */
  #lasSparstatus() {
    const spar = this.dashcam?.rearStream?.getVideoTracks?.()[0];
    if (!spar) return null;
    if (spar.readyState === 'ended') return 'slut';
    if (spar.muted) return 'tyst';
    return 'ok';
  }

  /**
   * Tid sedan inspelaren senast gav livstecken.
   *
   * MediaRecorder startas med start(1000), alltså en databit i sekunden.
   * Bitarna samlas i dashcam.segmentChunks, som töms när segmentet byts. Vi
   * läser bara längden: växer den kom det data, krymper den byttes segment —
   * båda är liv. Står den stilla flera sekunder har kodaren hamnat efter.
   */
  #lasDatalucka(now) {
    const dc = this.dashcam;
    if (!dc?.recording) { this.sistaData = now; return 0; }
    const antal = dc.segmentChunks?.length ?? -1;
    if (antal !== this.sistaChunkAntal) {
      this.sistaChunkAntal = antal;
      this.sistaData = now;
    }
    return now - this.sistaData;
  }

  /**
   * Batteriets takt, i procent per timme.
   *
   * Nivån avrundas till hela procent av webbläsaren, så det krävs minst en
   * procents förändring och några minuter innan siffran betyder något. Den
   * används därför bara som medhåll, aldrig som ensam anledning.
   *
   * Ett undantag är starkare än allt annat i den här funktionen: sjunker
   * nivån medan telefonen LADDAR drar den mer än laddaren orkar leverera.
   * Det är precis den situationen man hamnar i med telefonen i solen, full
   * belastning och en billaddare — och den behöver ingen tolkning.
   */
  #lasBatteritakt() {
    const p = this.batteriProv;
    if (p.length < 2) return null;
    const forsta = p[0], sista = p[p.length - 1];
    const timmar = (sista.t - forsta.t) / 3600000;
    if (timmar < 0.08) return null;                   // under fem minuter: för trubbigt
    const fall = (forsta.niva - sista.niva) * 100;
    if (fall <= 0) return { procentPerTimme: 0, laddarOchSjunker: false };
    return {
      procentPerTimme: fall / timmar,
      laddarOchSjunker: !!sista.laddar && !!forsta.laddar && fall >= 1,
    };
  }

  /* ---------------- Sammanvägning ---------------- */

  /**
   * Väg ihop signalerna till en poäng.
   *
   * Poäng och inte procent, för att signalerna inte är jämförbara. En trasig
   * kamera är ett faktum, en batteritakt är ett indicium och ett tryckvärde
   * är någon annans bedömning. Att slå ihop dem till "73 % belastning" hade
   * varit att ge tre olika sorters kunskap samma auktoritet.
   *
   * Varje signal ger 0, 1 eller 2. Saknad signal ger ingenting alls — den
   * drar varken upp eller ned, och räknas som okänd i felsökningsvyn.
   */
  #vag(now) {
    const s = {};
    let poang = 0;
    let hart = false;                                 // fanns ett faktum, inte bara indicier

    // 1. Kameran — den viktigaste
    const kam = this.#lasKameratakt(now);
    s.kameratakt = kam;
    if (kam != null) {
      if (kam < 0.5) { poang += 2; hart = true; }
      else if (kam < 0.8) poang += 1;
    }

    // 2. Spårets liv — rent faktum
    const spar = this.#lasSparstatus();
    s.spar = spar;
    if (spar === 'slut' || spar === 'tyst') { poang += 2; hart = true; }

    // 3. Inspelarens dataflöde — också faktum
    const lucka = this.#lasDatalucka(now);
    s.dataluckaMs = lucka;
    if (this.dashcam?.recording) {
      if (lucka > 8000) { poang += 2; hart = true; }
      else if (lucka > 3000) { poang += 1; hart = true; }
    }

    // 4. Ritfrekvens mot beställd — bara om någon matar oss
    const ritMed = median(this.ritTider.v);
    const malFps = this.dashcam?.settings?.fps || 30;
    s.rittakt = ritMed ? (1000 / ritMed) / malFps : null;
    if (s.rittakt != null && this.ritTider.full) {
      if (s.rittakt < 0.5) poang += 2;
      else if (s.rittakt < 0.8) poang += 1;
    }

    // 5. Kompositören mot enhetens egen normalfrekvens
    const rafMed = median(this.rafTider.v);
    const rafFps = rafMed ? 1000 / rafMed : null;
    if (rafFps && this.rafTider.full) {
      // Baslinjen mäts upp, den antas inte. 60 Hz är inte längre normalläget:
      // det finns telefoner på 120 och sparlägen på 30. Jämför man mot en
      // antagen siffra flaggar man antingen alla 120-telefoner som friska
      // eller alla 30-telefoner som strypta.
      if (this.basRafFps == null || rafFps > this.basRafFps) this.basRafFps = rafFps;
      const kvot = rafFps / this.basRafFps;
      s.rafFps = Math.round(rafFps);
      s.rafKvot = kvot;
      if (kvot < 0.5) poang += 2;
      else if (kvot < 0.75) poang += 1;
    } else {
      s.rafFps = null; s.rafKvot = null;
    }

    // 6. Timerdrift
    const drift = median(this.timerDrift.v);
    s.timerDrift = drift;
    if (drift != null && this.timerDrift.full) {
      if (drift > 0.6) poang += 2;
      else if (drift > 0.25) poang += 1;
    }

    // 7. Batteriet — medhåll, högst en poäng
    const bat = this.#lasBatteritakt();
    s.batteri = bat;
    if (bat) {
      if (bat.laddarOchSjunker || bat.procentPerTimme > 40) poang += 1;
      else if (bat.procentPerTimme > 25) poang += 0.5;
    }

    // 8. Systemtryck — finns i praktiken bara vid skrivbordet
    s.tryck = this.tryckStodjs ? this.tryck : null;
    if (s.tryck === 'critical') { poang += 2; hart = true; }
    else if (s.tryck === 'serious') poang += 1;

    s.synlig = document.visibilityState === 'visible';
    s.enhetsklass = this.enhetsklass;

    this.signaler = s;
    return { poang, hart };
  }

  /**
   * Enhetens klass — INTE dess tillstånd.
   *
   * deviceMemory finns bara i Chromium och hardwareConcurrency klämmer Safari
   * till 4 eller 8 oavsett verklighet. Siffrorna säger något om vad telefonen
   * borde klara, ingenting om vad den klarar just nu i solen. De används bara
   * till att välja en rimlig utgångspunkt, aldrig till att gradera läget.
   */
  get enhetsklass() {
    const minne = navigator.deviceMemory ?? null;
    const karnor = navigator.hardwareConcurrency ?? null;
    if (minne != null && minne <= 2) return 'svag';
    if (karnor != null && karnor <= 4) return 'svag';
    if (minne == null && karnor == null) return 'okand';
    return 'normal';
  }

  /* ---------------- Bedömning ---------------- */

  /**
   * Utvärdera läget. Anropas på timer av den som kopplar in modulen.
   *
   * Returnerar det som eventuellt ska sägas, precis som vakthundens
   * kontrollera(), så att inkopplingen ser likadan ut på båda ställena.
   */
  kontrollera(now = Date.now()) {
    if (!this.aktiv) return null;

    // Ingen inspelning, ingen bedömning. Strypning som inte drabbar något
    // arbete är inte ett problem, och utan en beställd bildfrekvens finns
    // det ingenting att mäta det uppnådda mot.
    if (!this.dashcam?.recording) {
      this.#nollstallMjukt(now);
      // Men vägen tillbaka måste gå att gå även härifrån. Har vi själva
      // rekommenderat att inspelningen stoppas är det ju precis det här
      // läget vi hamnar i — och utan den här raden vore stoppet permanent:
      // ingen inspelning, alltså ingen mätning, alltså aldrig en
      // återgång, alltså en dashcam som är avstängd resten av resan.
      //
      // Att kalla läget normalt när ingenting spelas in är inte en mätning
      // utan en slutsats, men en rimlig sådan: ritloopen och kodaren är
      // faktiskt avstängda, så belastningen vi klagade på finns inte kvar.
      if (this.niva === 'normal' && this.stegIndex >= 0) return this.#kanskeAterta(now);
      return null;
    }

    // Uppvärmning: mät, men döm inte.
    if (now - this.startad < this.opts.uppvarmningMs) { this.#vag(now); return null; }

    // Osynlig flik: proverna säger mer om webbläsarens energisparande än om
    // telefonen. Behåll läget, avstå från att bedöma.
    if (document.visibilityState !== 'visible') return null;

    const { poang, hart } = this.#vag(now);
    this.poang = poang;

    const nyNiva = this.#gradera(poang, hart, now);
    if (nyNiva !== this.niva) {
      const forra = this.niva;
      this.niva = nyNiva;
      this.nivaSedan = now;
      if (nyNiva === 'normal') this.normalSedan = now;
      this.#emit('change', { niva: nyNiva, forra, poang, signaler: this.signaler });
    }

    return this.#trappa(now);
  }

  /**
   * Gradera med hysteres.
   *
   * Tre spärrar, alla till för att undvika pendling:
   *  1. Olika trösklar in och ut (warmPoang/lamnaWarm).
   *  2. Ett läge måste hålla i sig innan det tros på — kort uppåt, långt nedåt.
   *  3. Aldrig mer än ett steg i taget, och aldrig oftare än minTidILageMs.
   */
  #gradera(poang, hart, now) {
    const onskad =
      poang >= this.opts.hotPoang ? 'hot' :
      poang >= this.opts.warmPoang ? 'warm' : 'normal';

    let mal = this.niva;
    if (RANG[onskad] > RANG[this.niva]) {
      mal = onskad;
    } else if (RANG[onskad] < RANG[this.niva]) {
      const underGrans = this.niva === 'hot'
        ? poang <= this.opts.lamnaHot
        : poang <= this.opts.lamnaWarm;
      if (underGrans) mal = onskad;
    }
    if (mal === this.niva) { this.kandidat = null; return this.niva; }

    // Ett steg i taget. Hopp från hot rakt till normal betyder nästan alltid
    // att en signal tillfälligt föll bort, inte att telefonen svalnat.
    const riktning = RANG[mal] > RANG[this.niva] ? 1 : -1;
    const nasta = Object.keys(RANG).find(k => RANG[k] === RANG[this.niva] + riktning);

    if (!this.kandidat || this.kandidat.niva !== nasta) {
      this.kandidat = { niva: nasta, sedan: now };
      return this.niva;
    }

    const krav = riktning > 0
      ? (hart ? this.opts.bekraftaHartMs : this.opts.bekraftaUppMs)
      : this.opts.bekraftaNerMs;

    if (now - this.kandidat.sedan < krav) return this.niva;
    // Minsta tid i läget gäller inte för hårda fakta uppåt: står kameran
    // still ska vi inte vänta ut en karens innan vi gör något åt det.
    if (!(hart && riktning > 0) && now - this.nivaSedan < this.opts.minTidILageMs) return this.niva;

    this.kandidat = null;
    return nasta;
  }

  /* ---------------- Trappan upp och ned ---------------- */

  #trappa(now) {
    if (this.niva === 'normal') {
      this.normalSedan = this.normalSedan || now;
      return this.#kanskeAterta(now);
    }
    this.normalSedan = 0;

    const paus = this.niva === 'hot' ? this.opts.stegPausHotMs : this.opts.stegPausMs;
    if (this.stegAt && now - this.stegAt < paus) return null;
    if (this.stegIndex >= STEGE.length - 1) return null;

    // Nästa steg kan kräva ett värre läge än det vi är i. Då stannar trappan
    // här. Warm ska kunna göra filmen sämre men aldrig trubba av varningarna
    // eller stänga av inspelningen — det får bara hot göra.
    const nasta = STEGE[this.stegIndex + 1];
    if (RANG[nasta.nivaKrav || 'warm'] > RANG[this.niva]) return null;

    this.stegIndex += 1;
    this.stegAt = now;
    const steg = nasta;
    this.#minnsUrsprung(steg);

    // Rekommendationen först: den som kopplar in ska hinna genomföra
    // åtgärden innan rösten påstår att den är genomförd.
    this.#emit('rekommendation', {
      id: steg.id,
      grupp: steg.grupp,
      steg: this.stegIndex,
      niva: this.niva,
      atgard: steg.atgard,
      skal: steg.skal,
      text: steg.text,
      spoken: this.#farSaga(steg.id, now) ? steg.tal : null,
      poang: this.poang,
      signaler: this.signaler,
    });

    return this.#kanskeTala(steg, 'fel', now);
  }

  /**
   * Ta tillbaka ett steg i taget när det varit lugnt ett tag.
   *
   * Ett steg, aldrig allt på en gång. Höjer man tillbaka allt i samma
   * ögonblick är telefonen tillbaka i exakt den belastning som gjorde att
   * den halkade efter, och tio minuter senare står man där igen — fast nu
   * har föraren hört appen ändra sig fyra gånger.
   */
  #kanskeAterta(now) {
    if (this.stegIndex < 0) return null;
    if (!this.normalSedan || now - this.normalSedan < this.opts.aterstallStegMs) return null;

    const steg = STEGE[this.stegIndex];
    this.stegIndex -= 1;
    this.normalSedan = now;                 // ny väntetid innan nästa steg tas tillbaka
    this.stegAt = now;

    const tillbaka = this.stegIndex >= 0 ? STEGE[this.stegIndex] : null;
    this.#emit('atergang', {
      id: steg.id,
      grupp: steg.grupp,
      steg: this.stegIndex,
      // Vad läget ska återställas TILL: föregående stegs åtgärd, eller
      // ursprungsläget när vi klättrat hela vägen upp igen.
      atgard: tillbaka && tillbaka.grupp === steg.grupp ? tillbaka.atgard : this.#ursprung(steg),
      text: steg.ater || null,
      spoken: steg.ater && this.#harAnnonserat(steg.id) ? steg.ater : null,
      niva: this.niva,
    });

    if (steg.ater && this.#harAnnonserat(steg.id)) {
      const t = this.sagt.get(steg.id);
      if (t) t.annonserat = false;
      return this.#saga({ id: steg.id, sort: 'ater', spoken: steg.ater, text: steg.ater }, now);
    }
    return null;
  }

  /**
   * Skriv upp vad inställningen stod på INNAN vi rörde den.
   *
   * Annars gissar återställningen. Kupékameran är det tydliga exemplet: den
   * är avstängd som standard, så en återställning till "påslagen" hade slagit
   * på en funktion föraren aldrig bett om — och gjort det mitt under körning,
   * på en telefon som just haft det tungt. Läses bara, skrivs aldrig.
   */
  #minnsUrsprung(steg) {
    if (this.ursprungliga.has(steg.grupp)) return;
    const satt = steg.atgard?.satt;
    const nu = satt ? this.dashcam?.settings?.[satt] : undefined;
    if (steg.atgard?.modul === 'dashcam' && satt && nu !== undefined) {
      this.ursprungliga.set(steg.grupp, { modul: 'dashcam', satt, varde: nu });
    }
  }

  /** Ursprungsläget för en grupp — det appen körde innan vi rörde något. */
  #ursprung(steg) {
    const sparat = this.ursprungliga.get(steg.grupp);
    if (sparat) return sparat;
    // Inget uppmätt ursprung (GPS går inte att läsa av, och stopp/start är
    // inget värde). Fall tillbaka på appens standardläge.
    switch (steg.grupp) {
      case 'upplosning':   return { modul: 'dashcam', satt: 'quality', varde: 'high' };
      case 'bildfrekvens': return { modul: 'dashcam', satt: 'fps', varde: 30 };
      case 'kupekamera':   return { modul: 'dashcam', satt: 'dual', varde: true };
      case 'gps':          return {
        modul: 'geo', satt: 'watchOptions',
        varde: { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
      };
      case 'stopp':        return { modul: 'dashcam', anrop: 'start' };
      default:             return null;
    }
  }

  /* ---------------- Rösten ---------------- */

  /**
   * Får det här sägas högt just nu?
   *
   * Samma karens som vakthunden håller, och av samma skäl. I bilen hörs två
   * besked efter varandra som ett enda otydligt, och det tionde beskedet om
   * samma sak hörs inte alls — då har föraren redan sänkt volymen, och med
   * den försvann polisvarningarna.
   */
  #farSaga(id, now) {
    const t = this.sagt.get(id);
    if (!t) return true;
    return !t.sagtAt || (now - t.sagtAt) >= this.opts.upprepaTidigastMs;
  }

  #harAnnonserat(id) { return !!this.sagt.get(id)?.annonserat; }

  #kanskeTala(steg, sort, now) {
    if (!steg.tal) {
      // Stegets text visas ändå — men tyst. De flesta steg är sådana att
      // föraren inte behöver höra dem: filmen fortsätter, bara lite sämre.
      this.#emit('note', { id: steg.id, text: steg.text });
      return null;
    }
    if (!this.#farSaga(steg.id, now)) {
      this.#emit('note', { id: steg.id, text: steg.text });
      return null;
    }
    return this.#saga({ id: steg.id, sort, spoken: steg.tal, text: steg.text }, now);
  }

  #saga(nyttl, now) {
    const t = this.sagt.get(nyttl.id) || { sagtAt: 0, annonserat: false };
    t.sagtAt = now;
    if (nyttl.sort !== 'ater') t.annonserat = true;
    this.sagt.set(nyttl.id, t);
    this.#emit(nyttl.sort === 'ater' ? 'recovered' : 'warning', nyttl);
    return nyttl;
  }

  /* ---------------- Nollställning ---------------- */

  /**
   * Mjuk nollställning när inget spelas in.
   *
   * Trappan behålls — hade den nollställts vid varje paus i inspelningen
   * hade appen börjat om på full kvalitet efter varje stopp, mot en telefon
   * som fortfarande är precis lika varm som nyss.
   */
  #nollstallMjukt(now) {
    this.kameraProv = null;
    this.sistaData = now;
    this.sistaChunkAntal = -1;
    if (this.niva !== 'normal' && now - this.nivaSedan > this.opts.bekraftaNerMs) {
      this.niva = 'normal';
      this.nivaSedan = now;
      this.normalSedan = now;
      this.#emit('change', { niva: 'normal', poang: 0, signaler: this.signaler });
    }
  }

  /** Full nollställning, t.ex. när en ny resa börjar. */
  aterstall(now = Date.now()) {
    this.niva = 'normal';
    this.poang = 0;
    this.kandidat = null;
    this.nivaSedan = now;
    this.normalSedan = now;
    this.stegIndex = -1;
    this.stegAt = 0;
    this.utforda.clear();
    this.ursprungliga.clear();
    this.sagt.clear();
    this.rafTider.clear();
    this.timerDrift.clear();
    this.ritTider.clear();
    this.kameraProv = null;
    this.basRafFps = null;
    this.startad = now;
    this.#emit('change', { niva: 'normal', poang: 0, signaler: this.signaler });
  }

  /** Läget i klartext, för felsökningsvyn i inställningarna. */
  get lage() {
    return {
      niva: this.niva,
      poang: this.poang,
      steg: this.stegIndex >= 0 ? STEGE[this.stegIndex].id : null,
      stegIndex: this.stegIndex,
      signaler: this.signaler,
      stod: {
        batteri: this.batteriStodjs,
        tryck: this.tryckStodjs,
        ritmatning: this.ritTider.v.length > 0,
      },
    };
  }

  #emit(namn, detalj) {
    this.dispatchEvent(new CustomEvent(namn, { detail: detalj }));
  }
}

/**
 * Kort mänsklig sammanfattning av läget.
 *
 * Formuleringarna undviker medvetet ord som "varm", "het" och "överhettad".
 * Vi vet inte det. Vi vet att appen halkat efter.
 */
export const beskrivNiva = niva => ({
  normal: 'Telefonen hinner med.',
  warm: 'Telefonen börjar halka efter. Appen har dragit ner på arbetet.',
  hot: 'Telefonen hinner inte med. Appen kör på sparlåga för att inte stanna helt.',
}[niva] || 'Okänt läge.');

export default Varmevakt;
