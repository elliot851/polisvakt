// Larmet när skyltläsaren känner igen ett av dina egna fordon.
//
// Första versionen skrek. En sågtandsvåg som svepte mellan 700 och 1150 Hz
// på halv volym i tolv sekunder, med hela skärmen pulsande i mättat rött.
// Den hördes, men den var byggd som en utryckningssiren — och en förare som
// får panik av sin egen app tittar på telefonen i stället för på vägen. Det
// är precis fel utfall för en sak som ska göra körningen säkrare.
//
// Den här versionen säger samma sak lugnare:
//
//   Ljudet är två mjuka sinustoner, en stigande kvint, spelade två gånger.
//   Sinus har inga vassa övertoner. Kvinten låter som en avisering, inte som
//   ett nödläge — samma intervall som en hisssignal eller en dörrklocka.
//   Volymen ligger på en femtedel av den gamla.
//
//   Rösten bär informationen. Ljud kan bara säga ATT något hänt; en röst kan
//   säga VAD, och föraren behöver inte titta bort från vägen för att förstå.
//   Det är samma princip som resten av appen vilar på — den är gjord för att
//   höras, inte läsas.
//
// Ljudet finns kvar trots rösten, av två skäl: talsyntes har en fördröjning
// på ett par hundra millisekunder, och rösten kan vara avstängd eller upptagen
// med en viktigare varning. Tonen är kvittot på att något hände.

/** Hur länge den röda rutan ligger kvar innan den släcker sig själv. */
export const LARM_MAX_MS = 9000;

/*
 * Om tonerna.
 *
 * 587 Hz (D5) och 880 Hz (A5) är en ren kvint. Två toner i harmoni läses av
 * örat som en signal, medan två toner i dissonans läses som ett larm. Vi vill
 * det första: föraren ska notera, inte rycka till.
 */
const TON_LAG = 587;
const TON_HOG = 880;
const TON_LANGD = 0.16;
const TON_VOLYM = 0.09;      // gamla larmet låg på 0.5

let ljudkontext = null;
let slocknaTimer = null;

/**
 * Två mjuka pling. Inget svep, ingen upprepning som fortsätter.
 *
 * Varje ton får en egen gain-nod med mjuk in- och uttoning. Utan den hörs ett
 * knäpp när tonen bryts tvärt, och knäppet är det som får en signal att låta
 * billig och stressande.
 */
export function spelaSignal() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    const ac = new Ctx();
    ljudkontext = ac;
    const t0 = ac.currentTime;

    // Två gånger: stigande kvint, kort paus, stigande kvint igen.
    const toner = [
      { f: TON_LAG, t: t0 },
      { f: TON_HOG, t: t0 + TON_LANGD },
      { f: TON_LAG, t: t0 + TON_LANGD * 2.6 },
      { f: TON_HOG, t: t0 + TON_LANGD * 3.6 },
    ];

    for (const { f, t } of toner) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(TON_VOLYM, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + TON_LANGD);
      o.connect(g); g.connect(ac.destination);
      o.start(t);
      o.stop(t + TON_LANGD + 0.02);
    }

    const slut = TON_LANGD * 4.6;
    setTimeout(() => { try { ac.close(); } catch {} if (ljudkontext === ac) ljudkontext = null; },
               Math.ceil(slut * 1000) + 300);
    return true;
  } catch {
    return false;
  }
}

/** Tystar en pågående signal. Anropas när larmet stängs. */
export function tystaSignal() {
  try { ljudkontext?.close(); } catch {}
  ljudkontext = null;
}

/**
 * Vad rösten säger.
 *
 * Formuleringen är vald med omsorg. "Bilen framför dig" är fel — läsaren vet
 * inte var fordonet står i förhållande till dig, bara att kameran ser det.
 * Att påstå "framför dig" är att hitta på en placering, och en app som hittar
 * på en detalj tappar förtroendet för resten.
 *
 * "Du har antecknat den" i stället för "den finns i registret": det är
 * användarens egen lista, inte ett register någon annan för.
 *
 * Etiketten läses upp om den finns — det är den föraren själv skrivit och
 * känner igen. Numret läses aldrig upp. Det finns inte lagrat, och en app som
 * läser upp registreringsnummer högt i en bil med passagerare gör något annat
 * än den utger sig för.
 */
export function larmMening(etikett) {
  const namn = (etikett || '').trim();
  return namn
    ? `Du känner igen det här fordonet. ${namn}, som du har antecknat.`
    : 'Du känner igen det här fordonet. Det finns i dina anteckningar.';
}

/**
 * Larma: ton, röst och röd ruta.
 *
 * @param {{plat?:string, etikett?:string}} traff
 * @param {{visa:Function, dolj:Function, speaker?:object, vibrera?:boolean}} krokar
 * @returns {Function} avbryt-funktion
 */
export function larma(traff, krokar) {
  const { visa, dolj, speaker, vibrera = true } = krokar || {};
  visa?.(traff);
  spelaSignal();

  /*
   * Rösten kommer efter tonen, inte samtidigt. Talsyntesen skulle annars
   * börja mitt i plinget och båda blir svårare att uppfatta. 700 ms räcker
   * för att tonerna ska ha klingat ut.
   *
   * Prioritet 1, inte 2. Prioritet 2 avbryter pågående tal, och en
   * polisvarning två hundra meter fram är viktigare än att ett fordon man
   * själv antecknat passerar. Igenkänningen får vänta sin tur.
   */
  const rostTimer = setTimeout(() => {
    try { speaker?.say?.(larmMening(traff?.etikett), { priority: 1 }); } catch {}
  }, 700);

  // Mjukare vibration också: två korta i stället för fem stötar.
  if (vibrera) { try { navigator.vibrate?.([120, 90, 120]); } catch {} }

  clearTimeout(slocknaTimer);
  const avbryt = () => {
    clearTimeout(rostTimer);
    clearTimeout(slocknaTimer);
    slocknaTimer = null;
    tystaSignal();
    dolj?.();
  };
  slocknaTimer = setTimeout(avbryt, LARM_MAX_MS);
  return avbryt;
}
