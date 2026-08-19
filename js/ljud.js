// Gränssnittsljud — de små ljuden när man trycker sig runt i appen.
//
// Det här är INTE varningsljuden. Varningarna äger voice.js: pling, ducking
// av musiken och uppläsning med prioritet. Den här filen gör tvärtom så lite
// väsen av sig som möjligt. Ett klickljud som maskerar "fartkamera om 300
// meter" har gjort appen sämre, inte trevligare, så allt här nere är byggt
// för att kliva åt sidan.
//
// Tre saker skiljer den från pip-funktionen i plate.js, som gör rätt sak på
// fel sätt:
//
//   1. EN delad AudioContext för hela sidan. plate.js skapar en ny per pip
//      och stänger den efter 400 ms. Ett pip i minuten går bra; en app som
//      klickas hundra gånger under en körning får hack och läcker
//      ljudenheter — telefoner har ett tak på antalet contexts.
//   2. Contexten skapas LAT, vid första riktiga användarinteraktionen.
//      Webbläsare vägrar ändå spela ljud innan dess. Vi hanterar det tyst
//      istället för att fylla konsolen med undantag.
//   3. Inga ljudfiler. Allt är korta sinustoner med mjuk attack och
//      avklingning. Appen har inget byggsteg och ska inte dra megabyte
//      ljud över mobildata.
//
// Modulen läser aldrig localStorage. app.js äger inställningarna och skickar
// in dem med setInstallningar().

/* ------------------------------------------------------------------ */
/* Har föraren rört sidan än?                                          */
/* ------------------------------------------------------------------ */
//
// Modulnivå, inte per instans: "användaren har interagerat med sidan" är ett
// faktum om sidan, inte om ett objekt. Innan det har hänt skapas ingen
// AudioContext över huvud taget — inte ens en suspenderad.

let harInteragerat = false;

function markeraInteraktion() {
  harInteragerat = true;
  for (const namn of ['pointerdown', 'keydown', 'touchstart']) {
    window.removeEventListener(namn, markeraInteraktion, true);
  }
}

if (typeof window !== 'undefined') {
  for (const namn of ['pointerdown', 'keydown', 'touchstart']) {
    // capture: vi vill hinna före appens egna klickhanterare, så att ett
    // ljud som begärs i samma tryck faktiskt får spela.
    window.addEventListener(namn, markeraInteraktion, { capture: true, passive: true });
  }
}

/** Sant så fort föraren tryckt, tangentat eller nuddat sidan en gång. */
export function anvandarenHarInteragerat() {
  if (harInteragerat) return true;
  // Webbläsarens egen bokföring duger lika bra när den finns — den överlever
  // till exempel en interaktion som skedde innan modulen laddades.
  return !!(typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive);
}

/* ------------------------------------------------------------------ */
/* Den delade contexten                                                */
/* ------------------------------------------------------------------ */

let deladCtx = null;
let skapadeContexter = 0;

/** Hur många AudioContext modulen har skapat sedan sidan laddades. */
export function antalSkapadeContexter() { return skapadeContexter; }

/**
 * Contexten, eller null om den inte får skapas än.
 * Skapar aldrig något innan första interaktionen.
 */
function haCtx() {
  if (!anvandarenHarInteragerat()) return null;
  if (deladCtx) {
    // Telefonen suspenderar contexten när appen legat i bakgrunden. resume()
    // är billig när den redan kör, och tyst när den inte får köra.
    if (deladCtx.state === 'suspended') { try { deladCtx.resume(); } catch {} }
    return deladCtx;
  }
  // Slås upp vid anropet, inte vid modulladdning: tester byter ut
  // window.AudioContext för att räkna hur många som skapas.
  const AC = (typeof window !== 'undefined')
    && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try {
    deladCtx = new AC();
    skapadeContexter++;
  } catch {
    deladCtx = null;
  }
  return deladCtx;
}

/* ------------------------------------------------------------------ */
/* Ljudpaketet                                                         */
/* ------------------------------------------------------------------ */
//
// Recepten är avsiktligt torftiga. Toner under 50 ms med mjuk attack hörs som
// en knäpp utan att låta som en knäpp, och de tar aldrig plats i kupén.
//
//   vid   = fördröjning i sekunder från ljudets början
//   langd = tonens längd i sekunder
//   niva  = relativ styrka, multipliceras med volyminställningen
//   f2    = glid upp eller ner till den frekvensen
//
// Karaktären är det som gör dem urskiljbara utan att man tänker på det:
// bekräftelsen går UPP och är ljus, felet går NER och är mörkt. Man behöver
// inte lära sig ljuden, örat gör jobbet.

export const LJUD_RECEPT = {
  // Kort, ljus, nästan omärklig. Det vanligaste ljudet i appen — det ska man
  // sluta höra efter en dag.
  tryck: {
    toner: [{ f: 1150, langd: 0.045, niva: 0.45 }],
    vib: 8,
  },
  // Flikbyte: ett litet glid uppåt, så det känns som en förflyttning.
  flik: {
    toner: [{ f: 760, f2: 1040, langd: 0.075, niva: 0.42 }],
    vib: 10,
  },
  // På: två stigande toner.
  pa: {
    toner: [{ f: 660, langd: 0.055, niva: 0.4 },
            { f: 990, langd: 0.075, niva: 0.4, vid: 0.055 }],
    vib: 12,
  },
  // Av: samma sak baklänges. Ett reglage ska låta som det ser ut.
  av: {
    toner: [{ f: 880, langd: 0.055, niva: 0.4 },
            { f: 587, langd: 0.085, niva: 0.4, vid: 0.055 }],
    vib: 12,
  },
  // Bekräftelse: ren kvint uppåt, ljus och kort. "Klart."
  bekrafta: {
    toner: [{ f: 784, langd: 0.08, niva: 0.5 },
            { f: 1175, langd: 0.13, niva: 0.45, vid: 0.075 }],
    vib: 16,
  },
  // Fel: lågt och nedåt, med triangelvåg så det får lite sträv ton utan att
  // bli skarpt. Lågpassfiltret i kedjan tar udden av översvängarna.
  fel: {
    toner: [{ f: 300, langd: 0.1, niva: 0.55, typ: 'triangle' },
            { f: 196, langd: 0.18, niva: 0.5, typ: 'triangle', vid: 0.095 }],
    vib: [18, 60, 18],
  },
};

export const LJUD_NAMN = Object.keys(LJUD_RECEPT);

/** Inställningarna app.js äger. Skickas in, läses aldrig härifrån. */
export const LJUD_FORVAL = {
  ljudPa: true,      // gränssnittsljud alls
  ljudVolym: 0.35,   // 0–1. Lågt förval med flit: varningarna ska höras bäst.
  haptikPa: true,    // kort vibration tillsammans med ljudet
};

/* Konstanter -------------------------------------------------------- */

const BAS_NIVA = 0.35;        // taket innan volyminställningen; chime() i voice.js ligger på 0,22
const ATTACK_S = 0.012;       // mjuk anslagstid — kortare än så knäpper det
const SLUT_NIVA = 0.0001;     // exponentiella ramper kan inte gå till noll
const LOOKAHEAD_S = 0.008;    // liten framförhållning så första samplet inte kapas
const DAMPNING = 0.22;        // hur mycket vi trycker ner ljudet när appen pratar tyst
const MAX_TONER = 10;         // tak på samtidiga toner, mot knappspam

/**
 * Gränssnittsljud.
 *
 * @example
 *   const ljud = new Ljud({ ljudVolym: 0.4 }, { speaker });
 *   knapp.addEventListener('click', () => ljud.tryck());
 */
export class Ljud {
  /**
   * @param {Partial<typeof LJUD_FORVAL>} installningar
   * @param {{speaker?: object}} beroenden  speaker = Speaker från voice.js
   */
  constructor(installningar = {}, { speaker = null } = {}) {
    this.installningar = { ...LJUD_FORVAL, ...installningar };
    this.speaker = speaker;

    this.master = null;        // volymnod, en per instans, på den delade contexten
    this.filter = null;
    this.aktivaToner = 0;

    // Bokföring — provbänken och testsvepet läser den här, inget annat.
    this.statistik = { spelade: 0, hoppade: 0, dampade: 0, noder: 0, vibrationer: 0 };
    this.senaste = null;

    /**
     * Systemet har bett om mindre rörelse. Den som stänger av animationer i
     * telefonen vill sällan ha pling heller — och samma inställning används
     * av folk som blir illamående av gränssnitt som gör för mycket.
     * Går att skriva över i test.
     */
    this.systemTyst = false;
    try {
      const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
      if (mq) {
        this.systemTyst = mq.matches;
        mq.addEventListener?.('change', e => { this.systemTyst = e.matches; });
      }
    } catch {}
  }

  /* ---- Inställningar ------------------------------------------------ */

  /**
   * Uppdatera delvis. app.js skickar bara det som ändrats.
   * @param {Partial<typeof LJUD_FORVAL>} delvis
   */
  setInstallningar(delvis = {}) {
    this.installningar = { ...this.installningar, ...delvis };
    const v = Number(this.installningar.ljudVolym);
    this.installningar.ljudVolym = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : LJUD_FORVAL.ljudVolym;
    if (this.master) this.master.gain.value = this.masterNiva;
    return this.installningar;
  }

  /** Koppla in Speaker efteråt, om instansen skapades före den. */
  kopplaTalare(speaker) { this.speaker = speaker; return this; }

  /** Volymnodens värde — det som faktiskt hamnar i ljudkedjan. */
  get masterNiva() {
    return this.installningar.ljudPa ? this.installningar.ljudVolym * BAS_NIVA : 0;
  }

  /** Den delade contexten, eller null om ingen skapats än. */
  get ctx() { return deladCtx; }

  /* ---- Ljuden ------------------------------------------------------- */

  tryck()    { return this.spela('tryck'); }
  flik()     { return this.spela('flik'); }
  pa()       { return this.spela('pa'); }
  av()       { return this.spela('av'); }
  bekrafta() { return this.spela('bekrafta'); }
  fel()      { return this.spela('fel'); }

  /**
   * Spela ett ljud vid namn. Kastar aldrig — ett gränssnittsljud som fäller
   * ett klick är värre än ett gränssnitt utan ljud.
   *
   * @param {'tryck'|'flik'|'pa'|'av'|'bekrafta'|'fel'} namn
   * @returns {{spelade:boolean, orsak:string, dampning:number}}
   */
  spela(namn) {
    const recept = LJUD_RECEPT[namn];
    if (!recept) return this.#bokfor(namn, { spela: false, dampning: 0, orsak: 'okant-ljud' });

    const beslut = this.#beslut();

    // Haptiken går sin egen väg. Att appen läser upp en varning är inget skäl
    // att strypa en vibration — den maskerar ingenting. Därför känns knappen
    // fortfarande igen även när ljudet kliver åt sidan.
    this.#vibrera(recept.vib);

    if (!beslut.spela) return this.#bokfor(namn, beslut);

    const ctx = haCtx();
    if (!ctx) return this.#bokfor(namn, { spela: false, dampning: 0, orsak: 'ingen-ljudmotor' });

    try {
      this.#toner(ctx, recept, beslut.dampning);
    } catch {
      return this.#bokfor(namn, { spela: false, dampning: 0, orsak: 'fel-i-ljudmotorn' });
    }
    return this.#bokfor(namn, beslut);
  }

  /* ---- Beslutet: ska det här ljudet höras? -------------------------- */

  /**
   * Ordningen är viktig. Först det som stänger av allt, sedan det som bara
   * dämpar. Varje avslag har en orsak som går att läsa i provbänken, så det
   * aldrig blir gissningar om varför appen är tyst.
   */
  #beslut() {
    const i = this.installningar;
    if (!i.ljudPa) return { spela: false, dampning: 0, orsak: 'av' };
    if (i.ljudVolym <= 0) return { spela: false, dampning: 0, orsak: 'volym-noll' };
    if (this.systemTyst) return { spela: false, dampning: 0, orsak: 'reducerad-rorelse' };
    if (this.speaker?.muted) return { spela: false, dampning: 0, orsak: 'appen-tystad' };
    if (!anvandarenHarInteragerat()) return { spela: false, dampning: 0, orsak: 'ingen-interaktion' };
    if (this.aktivaToner >= MAX_TONER) return { spela: false, dampning: 0, orsak: 'for-manga-toner' };

    const tal = this.#talStatus();
    if (tal.pratar) {
      /*
       * Här sitter hela poängen med filen.
       *
       * Speaker i voice.js har prioritet 2 för akut fara, 1 för vanlig
       * varning och 0 för bekräftelser ("Tack, bekräftad"). Ligger något på
       * 1 eller 2 i kön eller i munnen är det en varning om verkligheten
       * utanför vindrutan, och då spelar vi ingenting alls — ett pling som
       * krockar med "fartkamera om 300 meter" kostar föraren böter.
       *
       * En bekräftelse (0) är däremot bara artighet. Där räcker det att
       * trycka ner klickljudet så det hörs som en bakgrundsdetalj.
       */
      if (tal.prio >= 1) return { spela: false, dampning: 0, orsak: 'uppläsning-pågår' };
      return { spela: true, dampning: DAMPNING, orsak: 'dämpad-under-tal' };
    }
    return { spela: true, dampning: 1, orsak: 'ok' };
  }

  /**
   * Vad Speaker håller på med just nu. Läser både det som lases upp och det
   * som står på tur — kön hinner fyllas på innan första meningen är slut.
   */
  #talStatus() {
    const s = this.speaker;
    if (!s) return { pratar: false, prio: -1 };
    const ko = Array.isArray(s.queue) ? s.queue : [];
    const pratar = !!s.speaking || ko.length > 0;
    let prio = s.current?.priority ?? -1;
    for (const p of ko) prio = Math.max(prio, p?.priority ?? -1);
    return { pratar, prio };
  }

  /* ---- Själva syntesen ---------------------------------------------- */

  /**
   * Volymnod plus ett lågpass, en gång per instans, på den delade contexten.
   * Filtret finns för felljudets triangelvåg: utan det blir översvängarna
   * vassa i en billig biltelefonhögtalare.
   */
  #masterNod(ctx) {
    if (this.master && this.master.context === ctx) return this.master;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    this.statistik.noder += 2;
    f.type = 'lowpass';
    f.frequency.value = 3800;
    g.gain.value = this.masterNiva;
    f.connect(g).connect(ctx.destination);
    this.master = g;
    this.filter = f;
    return g;
  }

  #toner(ctx, recept, dampning) {
    const master = this.#masterNod(ctx);
    master.gain.value = this.masterNiva;      // slidern kan ha rört sig
    const t0 = ctx.currentTime + LOOKAHEAD_S;

    for (const ton of recept.toner) {
      const start = t0 + (ton.vid || 0);
      const langd = ton.langd;
      const niva = Math.max(SLUT_NIVA * 2, ton.niva * dampning);

      const o = ctx.createOscillator();
      const g = ctx.createGain();
      this.statistik.noder += 2;
      o.type = ton.typ || 'sine';
      o.frequency.setValueAtTime(ton.f, start);
      if (ton.f2) o.frequency.exponentialRampToValueAtTime(ton.f2, start + langd);

      // Mjuk kuvert. Exponentiella ramper från och till nära noll, aldrig ett
      // hårt av- eller påslag — det är precis det som hörs som ett klick.
      g.gain.setValueAtTime(SLUT_NIVA, start);
      g.gain.exponentialRampToValueAtTime(niva, start + ATTACK_S);
      g.gain.exponentialRampToValueAtTime(SLUT_NIVA, start + langd);
      g.gain.setValueAtTime(0, start + langd + 0.005);

      o.connect(g).connect(master);
      this.aktivaToner++;
      o.onended = () => {
        this.aktivaToner = Math.max(0, this.aktivaToner - 1);
        try { o.disconnect(); g.disconnect(); } catch {}
      };
      o.start(start);
      o.stop(start + langd + 0.02);
    }
  }

  /* ---- Haptik -------------------------------------------------------- */

  /** Kort vibration, bara där den finns och bara om den är påslagen. */
  #vibrera(monster) {
    if (!this.installningar.haptikPa || this.systemTyst || !monster) return false;
    if (!anvandarenHarInteragerat()) return false;
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
    try {
      navigator.vibrate(monster);
      this.statistik.vibrationer++;
      return true;
    } catch { return false; }
  }

  /* ---- Bokföring ------------------------------------------------------ */

  #bokfor(namn, beslut) {
    if (beslut.spela) {
      this.statistik.spelade++;
      if (beslut.dampning < 1) this.statistik.dampade++;
    } else {
      this.statistik.hoppade++;
    }
    this.senaste = {
      namn,
      tid: Date.now(),
      spelade: !!beslut.spela,
      orsak: beslut.orsak,
      dampning: beslut.dampning,
      niva: this.masterNiva * beslut.dampning,
    };
    return { spelade: !!beslut.spela, orsak: beslut.orsak, dampning: beslut.dampning };
  }

  /** Koppla loss instansen. Contexten är delad och stängs inte här. */
  avsluta() {
    try { this.filter?.disconnect(); this.master?.disconnect(); } catch {}
    this.master = this.filter = null;
  }
}

/** Färdig instans för appen. app.js kopplar in talaren och inställningarna. */
export const ljud = new Ljud();
