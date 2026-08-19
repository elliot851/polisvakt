// Vakthund — säger till när appen har slutat kunna varna.
//
// Hela Polisvakt bygger på en enda premiss: du ska titta på vägen, inte på
// skärmen. Allt viktigt sägs högt.
//
// Då blir tystnad ett besked i sig. Kör du i en kvart utan att höra något
// drar du slutsatsen att det är fritt fram. Men exakt samma tystnad uppstår
// när GPS:en tappats, när servern inte svarar och när telefonen är på väg att
// dö. Appen märkte det — och ändrade färg på en prick som föraren blivit
// tillsagd att inte titta på.
//
// Det är den farligaste sortens fel. En app som inte varnar är ofarlig; en
// app som slutat varna utan att säga det är sämre än ingen app alls, för den
// har först lärt föraren att lita på tystnaden.
//
// Den här modulen bevakar tre saker och säger till när de går sönder — och,
// lika viktigt, när de fungerar igen. Utan återställningsbeskedet vågar
// föraren aldrig lita på appen igen efter första felet.
//
// Disciplinen är densamma som i vinter.js: säg det en gång, upprepa bara om
// läget faktiskt förvärras, och tig hellre än att tjata. En vakthund som
// gnäller blir avstängd, och då skyddar den ingenting.

const SEK = 1000;

export const DEFAULTS = {
  /** Hur länge GPS får vara borta innan vi säger något. */
  gpsTystnadMs: 30 * SEK,

  /**
   * Hur gammal senaste lyckade synk får bli.
   *
   * Tre minuter är valt mot hur färskvaran faktiskt beter sig: rapporter
   * lever i 30–60 minuter, och pollningen går var 30:e sekund. Sex missade
   * pollningar i rad är inte en glapp i täckningen, det är ett fel.
   */
  synkTystnadMs: 3 * 60 * SEK,

  /** Under så här mycket batteri säger vi till. */
  batteriGrans: 0.15,

  /**
   * Hastighet över vilken vi anser att bilen rullar.
   *
   * Under den här tiger vakthunden helt. Att meddela "ingen GPS" när
   * telefonen ligger i ett garage är brus, och brus är det enda som får en
   * förare att sluta lyssna.
   */
  korGransKmh: 15,

  /** Kortaste tid mellan två likadana besked. */
  upprepaTidigastMs: 10 * 60 * SEK,
};

/** Vad vakthunden kan ha att säga. Ordningen är prioritetsordningen. */
const LAGEN = [
  {
    id: 'gps',
    tal: 'Jag har tappat GPS-signalen och kan inte varna just nu.',
    text: 'Ingen GPS — inga varningar förrän signalen är tillbaka.',
    ater: 'GPS är tillbaka.',
    aterText: 'GPS tillbaka. Varningarna fungerar igen.',
  },
  {
    id: 'synk',
    // Medvetet formulerad som "kan vara gamla" och inte "fungerar inte".
    // Appen varnar fortfarande för det den redan hämtat och för fartkameror
    // som ligger lokalt — det är bara nya rapporter som uteblir.
    tal: 'Ingen kontakt med servern. Varningarna kan vara gamla.',
    text: 'Ingen kontakt med servern. Du ser bara rapporter som redan hämtats.',
    ater: 'Kontakten med servern är tillbaka.',
    aterText: 'Ansluten igen. Nya rapporter kommer in som vanligt.',
  },
  {
    id: 'batteri',
    tal: 'Batteriet är snart slut. Ladda, annars slutar appen varna.',
    text: 'Lågt batteri. Appen slutar varna när telefonen dör.',
    ater: null,          // att batteriet stiger igen är inget man behöver höra
    aterText: 'Laddar igen.',
  },
];

export class Vakthund extends EventTarget {
  /**
   * @param {{gpsTystnadMs?:number, synkTystnadMs?:number, batteriGrans?:number,
   *          korGransKmh?:number, upprepaTidigastMs?:number}} opts
   */
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.aktiv = true;

    this.sistaFix = 0;          // när vi senast fick en position
    this.sistaFart = 0;         // senast kända hastighet
    this.harKort = false;       // har bilen rullat den här sessionen?
    this.batteri = null;        // 0–1, eller null om okänt
    this.laddar = false;

    /** id -> { aktivt:boolean, sagtAt:number, annonserat:boolean } */
    this.tillstand = new Map(
      LAGEN.map(l => [l.id, { aktivt: false, sagtAt: 0, annonserat: false }]));
  }

  setOptions(o) { this.opts = { ...this.opts, ...o }; }

  /**
   * Koppla på batteriövervakning.
   *
   * Battery Status API finns inte i Safari, och det är helt i sin ordning —
   * då hoppar vi bara över den bevakningen istället för att låtsas att vi vet.
   */
  async koppla() {
    try {
      const b = await navigator.getBattery?.();
      if (!b) return false;
      const las = () => { this.batteri = b.level; this.laddar = b.charging; };
      las();
      b.addEventListener('levelchange', las);
      b.addEventListener('chargingchange', las);
      return true;
    } catch { return false; }
  }

  /** Kallas för varje position appen får in. */
  notera(fix, now = Date.now()) {
    if (!fix) return;
    this.sistaFix = now;
    this.sistaFart = Number.isFinite(fix.speedKmh) ? fix.speedKmh : this.sistaFart;
    if (this.sistaFart >= this.opts.korGransKmh) this.harKort = true;
  }

  /** Kallas när GPS ger fel. Vi nollar inte sistaFix — tiden får löpa. */
  noteraGpsFel() { /* tystnaden räknas av #kontrollera */ }

  /**
   * Kör bilen just nu?
   *
   * Vi kräver att den har rullat någon gång under sessionen. Annars skulle en
   * telefon som ligger still med appen öppen få höra om varje glapp, vilket
   * är precis den sortens tjat som gör att man stänger av ljudet.
   */
  get korande() {
    return this.harKort && this.sistaFart >= this.opts.korGransKmh;
  }

  /**
   * Utvärdera läget. Kallas med jämna mellanrum, inte per position — GPS-fel
   * yttrar sig som att positioner UTEBLIR, och då kommer inga anrop alls.
   *
   * @param {{synkFel:any, sistaSynk:number, delatLage:boolean}} status
   */
  kontrollera(status = {}, now = Date.now()) {
    if (!this.aktiv) return null;

    const gpsBorta =
      this.sistaFix > 0 && (now - this.sistaFix) > this.opts.gpsTystnadMs;

    // Synken räknas bara som trasig i delat läge. I lokalt läge finns ingen
    // server att tappa kontakten med, och då vore beskedet obegripligt.
    const synkTrasig = !!status.delatLage && (
      !!status.synkFel ||
      (status.sistaSynk > 0 && (now - status.sistaSynk) > this.opts.synkTystnadMs)
    );

    const batteriLagt =
      this.batteri != null && !this.laddar && this.batteri <= this.opts.batteriGrans;

    const nu = { gps: gpsBorta, synk: synkTrasig, batteri: batteriLagt };

    // Återställningar först: att få veta att något fungerar igen är alltid
    // välkommet, även när något annat fortfarande är trasigt.
    //
    // Men bara om vi faktiskt sa ifrån. Sa vi aldrig något finns det inget
    // att ta tillbaka, och "GPS är tillbaka" utan föregående varning är rent
    // obegripligt för den som kör.
    for (const lage of LAGEN) {
      const t = this.tillstand.get(lage.id);
      if (t.aktivt && !nu[lage.id]) {
        t.aktivt = false;
        const annonserat = t.annonserat;
        t.annonserat = false;
        if (!annonserat) continue;
        if (lage.ater) return this.#saga(lage, 'ater', now);
        this.#emit('recovered', { id: lage.id, text: lage.aterText });
      }
    }

    // Sedan fel, i prioritetsordning. Ett besked i taget — två röstmeddelanden
    // på raken i en bil hörs som ett enda otydligt.
    for (const lage of LAGEN) {
      if (!nu[lage.id]) continue;
      const t = this.tillstand.get(lage.id);

      // Batteriet är det enda som gäller även när bilen står still: det
      // spelar ingen roll att du står i kö om telefonen dör om två minuter.
      if (lage.id !== 'batteri' && !this.korande) continue;

      t.aktivt = true;

      // Karensen gäller ÄVEN efter en återställning.
      //
      // Utan det blir en flappande signal — tunnel, viadukt, tät stadsbebyggelse
      // — en ström av "GPS borta", "GPS tillbaka", "GPS borta". Föraren får
      // ingen ny information av den tionde upprepningen, bara en anledning att
      // stänga av rösten. Och är rösten avstängd varnar appen inte för något
      // alls längre.
      if (t.sagtAt && now - t.sagtAt < this.opts.upprepaTidigastMs) continue;
      t.annonserat = true;
      return this.#saga(lage, 'fel', now);
    }

    return null;
  }

  #saga(lage, sort, now) {
    const t = this.tillstand.get(lage.id);
    t.sagtAt = now;
    const nyttl = {
      id: lage.id,
      sort,
      spoken: sort === 'ater' ? lage.ater : lage.tal,
      text: sort === 'ater' ? lage.aterText : lage.text,
    };
    this.#emit(sort === 'ater' ? 'recovered' : 'warning', nyttl);
    return nyttl;
  }

  /** Nollställ, t.ex. när en ny resa börjar. */
  aterstall() {
    for (const t of this.tillstand.values()) { t.aktivt = false; t.sagtAt = 0; }
    this.harKort = false;
    this.sistaFart = 0;
  }

  #emit(namn, detalj) {
    this.dispatchEvent(new CustomEvent(namn, { detail: detalj }));
  }
}

export default Vakthund;
