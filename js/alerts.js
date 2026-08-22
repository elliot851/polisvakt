// Varningsmotorn: avgör vad föraren ska höra, och när.
//
// Reglerna skiljer sig mellan fasta och rörliga faror:
//
//   Fartkamera  Riktad. Varnar bara om du faktiskt kör mot den, och en gång
//               per passage. Avståndet skalas med hastigheten så du hinner
//               sakta ner i tid — 110 km/h behöver längre framförhållning
//               än 50.
//
//   Polis /     Områdesvarning. Riktningen spelar mindre roll eftersom
//   kontroll    polisen kan flytta sig. Varnar en gång inom radien, sedan
//               igen först om du lämnat och kommit tillbaka.

import { distance, bearing, angleDiff, spokenDistance, spokenAge, clockDirection } from './util.js';
import { TYPE_SPOKEN } from './parser.js';
import { byggMening } from './kvalitet.js';

const DEFAULTS = {
  cameraLeadSeconds: 25,      // så många sekunder före kameran
  cameraMinM: 350,
  cameraMaxM: 1200,
  cameraConeDeg: 55,          // hur snett du får köra och ändå varnas
  hazardRadiusM: 1500,
  hazardRearmM: 600,          // måste lämna radien + detta innan ny varning
  repeatAfterMs: 8 * 60000,
  minSpeedKmh: 15,            // varna inte när du står stilla
  /*
   * Egen tröskel för polis/kontroll/civil, lägre än kamerans.
   *
   * Talet stod tidigare som en femma mitt i #hazardTrigger. Det gick inte att
   * fråga efter utifrån, och när uppläsningen vid inkommande rapport behövde
   * veta exakt var gränsen går fanns bara två vägar: skriva en andra femma
   * någon annanstans, eller lyfta hit den. En andra femma hade drivit isär
   * första gången någon justerade den ena.
   */
  hazardMinSpeedKmh: 5,
  /*
   * Hur gammal en GPS-fix får vara för att motorn ska räknas som körande.
   *
   * watchPosition levererar normalt varje sekund i en bil. Tolv sekunder är
   * generöst nog för en gles fix i tät stadsbebyggelse men kort nog att en
   * tunnel eller ett p-hus märks direkt. Talet används av agerFaran, som är
   * enda stället där någon frågar motorn om FRAMTIDEN — evaluate() själv får
   * alltid en färsk fix i handen, den körs ur 'position'-lyssnaren.
   */
  fixFarskMs: 12000,
};

export class AlertEngine extends EventTarget {
  constructor(speaker, opts = {}) {
    super();
    this.speaker = speaker;
    this.opts = { ...DEFAULTS, ...opts };
    this.state = new Map();   // hazardId -> { warnedAt, insideRadius, closest }
    this.enabled = true;
  }

  setOptions(o) { this.opts = { ...this.opts, ...o }; }

  reset() { this.state.clear(); }

  /**
   * @param {{lat,lon,headingSmoothed,speedKmh,moving}} fix
   * @param {Array} hazards  rapporter + fartkameror, alla med {id,type,lat,lon,label}
   */
  evaluate(fix, hazards) {
    if (!this.enabled || !fix) return [];
    const now = Date.now();
    const speed = fix.speedKmh ?? 0;
    const heading = fix.headingSmoothed;
    const fired = [];

    for (const h of hazards) {
      const d = distance(fix.lat, fix.lon, h.lat, h.lon);
      const st = this.state.get(h.id) || { warnedAt: 0, insideRadius: false, closest: Infinity };

      const isCamera = h.type === 'camera';
      const trigger = isCamera
        ? this.#cameraTrigger(fix, h, d, speed, heading, st, now)
        : this.#hazardTrigger(fix, h, d, speed, st, now);

      st.closest = Math.min(st.closest, d);
      if (trigger) {
        st.warnedAt = now;
        st.insideRadius = true;
        st.closest = d;
        const alert = this.#buildAlert(h, d, fix, heading);
        fired.push(alert);
      }

      // Återställ när man lämnat området, så nästa passage varnar igen
      const rearmAt = isCamera
        ? this.opts.cameraMaxM + 500
        : this.opts.hazardRadiusM + this.opts.hazardRearmM;
      if (d > rearmAt) {
        st.insideRadius = false;
        st.closest = Infinity;
        if (now - st.warnedAt > this.opts.repeatAfterMs) st.warnedAt = 0;
      }
      this.state.set(h.id, st);
    }

    // Om flera faror triggar samtidigt: läs den närmaste, nämn resten kort
    if (fired.length) this.#announce(fired);
    return fired;
  }

  #cameraTrigger(fix, h, d, speed, heading, st, now) {
    if (speed < this.opts.minSpeedKmh) return false;
    if (st.insideRadius) return false;
    if (now - st.warnedAt < this.opts.repeatAfterMs) return false;

    // Avstånd som motsvarar cameraLeadSeconds i nuvarande fart
    const lead = Math.round((speed / 3.6) * this.opts.cameraLeadSeconds);
    const range = Math.min(this.opts.cameraMaxM, Math.max(this.opts.cameraMinM, lead));
    if (d > range) return false;

    // Kör vi mot den?
    if (heading != null) {
      const toHazard = bearing(fix.lat, fix.lon, h.lat, h.lon);
      if (angleDiff(heading, toHazard) > this.opts.cameraConeDeg) return false;

      // Kameran mäter åt ett håll. Har vi riktningsdata, hoppa över den
      // om vi kör åt motsatt håll mot mätriktningen.
      if (Number.isFinite(h.bearing)) {
        if (angleDiff(heading, h.bearing) > 90) return false;
      }
    }
    return true;
  }

  #hazardTrigger(fix, h, d, speed, st, now) {
    if (st.insideRadius) return false;
    if (now - st.warnedAt < this.opts.repeatAfterMs) return false;
    if (d > this.opts.hazardRadiusM) return false;
    // Stillastående i garaget ska inte trigga, men rullar man sakta i stan
    // vill man absolut veta
    if (speed < this.opts.hazardMinSpeedKmh) return false;
    return true;
  }

  /**
   * Äger motorn den här faran — nu, eller alldeles strax?
   *
   * Frågan ställs av uppläsningen vid inkommande rapport i app.js. Den vägen
   * kan säga till om något som just kommit in från servern även när bilen
   * står still, alltså i precis det läge där motorn här är tyst med flit.
   * Men bara om motorn inte redan tänkt säga det: hör föraren samma polis
   * två gånger på tio sekunder slutar hen lyssna på båda.
   *
   * Två sätt att äga:
   *   1. Motorn HAR sagt till, och spärren mot upprepning håller ännu.
   *   2. Motorn KOMMER att säga till vid nästa GPS-fix — bilen rullar, faran
   *      ligger inom räckvidd, OCH fixarna kommer fortfarande. Utan det sista
   *      villkoret är löftet tomt; se färskhetsgrinden i kroppen.
   *
   * Frågan måste ställas mot alla id:n i klustret, inte bara ledarens. Faran
   * som motorn bokfört kan bära ett annat id än den rapport som nyss kom in
   * (se klusterIds i app.js), och en spärr som letar på fel id är ingen
   * spärr alls.
   *
   * DET OMVÄNDA VALDES BORT: att låta uppläsningen bocka av faran hos motorn
   * genom att skriva warnedAt/insideRadius i state. Det hade låst motorn i
   * åtta minuter eller tills bilen lämnat radien plus 600 meter — alltså
   * hade en rapport som lästes upp medan bilen stod still tappat sin
   * förbikörningsvarning en stund senare. Den varningen är den som betyder
   * något; inkommande-uppläsningen är bara trevlig att ha. Den som yielder
   * ska vara den som betyder minst.
   *
   * @param {{id,type,lat,lon}} h
   * @param {{lat,lon,speedKmh}|null} fix
   * @param {string[]|null} ids  övriga id:n i klustret
   */
  agerFaran(h, fix, ids = null) {
    if (!h) return false;
    const now = Date.now();

    const alla = Array.isArray(ids) && ids.length ? [h.id, ...ids] : [h.id];
    for (const id of alla) {
      const st = this.state.get(id);
      if (st && st.warnedAt && now - st.warnedAt < this.opts.repeatAfterMs) return true;
    }

    // Är motorn avstängd, eller saknas position, säger den ingenting alls —
    // och då äger den heller ingenting. Då är uppläsningen enda kanalen.
    if (!this.enabled || !fix) return false;

    /*
     * FIXEN MÅSTE VARA FÄRSK, annars är regel 2 ett tomt löfte.
     *
     * evaluate() körs bara ur 'position'-lyssnaren i app.js. Slutar fixarna
     * komma — tunnel, p-hus, GPS-timeout, nekad behörighet, eller ett stop()
     * som aldrig fick ett watchId igen — kommer det inget "nästa GPS-fix" att
     * säga till vid. GeoTracker nollställer aldrig sin last: den sista fixen
     * ligger kvar med den fart som medvetet HÅLLS KVAR över signaltapp, alltså
     * ser en gammal position i 70 km/h ut som en bil i rörelse för evigt.
     * Utan den här grinden hade agerFaran svarat "jag tar den" om en fara nära
     * tunnelmynningen, uppläsningen hade tigit, och motorn hade aldrig kört —
     * total tystnad i precis den miljö där kontrollerna sitter tätast.
     *
     * Att i stället fråga geo.isTracking valdes bort: spåraren kan vara igång
     * och ändå inte leverera (timeout, ingen signal), och motorn ska inte
     * behöva känna till spåraren. Fixens egen ålder svarar på hela frågan.
     */
    if (!Number.isFinite(fix.ts) || now - fix.ts > this.opts.fixFarskMs) return false;
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) return false;
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return false;

    const speed = fix.speedKmh ?? 0;
    const d = distance(fix.lat, fix.lon, h.lat, h.lon);

    if (h.type === 'camera') {
      if (speed < this.opts.minSpeedKmh) return false;
      /*
       * Kamerans verkliga räckvidd växer med farten och kapas av
       * cameraMaxM. Här används taket rakt av, inte den framräknade
       * räckvidden: frågan är "kan motorn hinna ta den här", och svaret ska
       * luta åt att låta motorn få den. En riktningskoll görs inte heller,
       * av samma skäl — kör man snett kan man svänga in nästa sekund.
       */
      return d <= this.opts.cameraMaxM;
    }

    if (speed < this.opts.hazardMinSpeedKmh) return false;
    return d <= this.opts.hazardRadiusM;
  }

  #buildAlert(h, d, fix, heading) {
    const kind = TYPE_SPOKEN[h.type] || 'varning';
    const where = h.label ? ` vid ${h.label}` : '';
    const dist = spokenDistance(d);

    /*
     * Hedgad formulering från kvalitet.js går före den vanliga.
     *
     * Skillnaden är inte kosmetisk. "Varning. Polis vid Erikslund" är appens
     * eget påstående — visar det sig fel känner sig föraren lurad, och nästa
     * gång tror hen inte på oss. "Polis rapporterad i området kring
     * Erikslund, för 26 minuter sedan" går att agera vettigt på och håller
     * fortfarande när det inte stämmer, eftersom vi aldrig påstod att vi
     * visste.
     *
     * Är platsen hedgad saknas klockriktningen med flit: falsk precision är
     * samma svek som ett falskt påstående.
     */
    if (h.bedomning) {
      const clock = heading != null
        ? clockDirection(heading, bearing(fix.lat, fix.lon, h.lat, h.lon))
        : null;
      const mening = byggMening(h.bedomning, h, {
        avstandM: d,
        klockriktning: clock,
      });
      if (mening) {
        return {
          id: h.id, hazard: h, distance: d, spoken: mening,
          priority: d < 500 ? 2 : 1,
          at: Date.now(),
        };
      }
    }

    let spoken;
    if (h.type === 'camera') {
      const limit = h.speedLimit ? `, ${h.speedLimit}` : '';
      spoken = `Fartkamera om ${dist}${limit}.`;
    } else {
      const clock = heading != null
        ? clockDirection(heading, bearing(fix.lat, fix.lon, h.lat, h.lon))
        : null;
      const dir = clock && d > 400 ? ` klockan ${clock}` : '';
      const age = h.createdAt ? `, rapporterat ${spokenAge(h.createdAt)}` : '';
      spoken = `Varning. ${cap(kind)}${where}, om ${dist}${dir}${age}.`;
    }

    return {
      id: h.id,
      hazard: h,
      distance: d,
      spoken,
      priority: d < 500 ? 2 : 1,
      at: Date.now(),
    };
  }

  #announce(fired) {
    fired.sort((a, b) => a.distance - b.distance);
    const first = fired[0];

    /*
     * PLINGET LYDER SAMMA REGLAGE SOM ORDEN.
     *
     * chime() anropades tidigare ovillkorligt medan say() faller igenom direkt
     * när "Läs upp varningar" är avslaget. Med det gamla, svaga ljudet märkte
     * ingen skillnaden. Det nya varningsljudet är det starkaste appen gör, och
     * då blir följden att den som slagit AV uppläsningen får en larmsignal i
     * kupén utan ett enda ord som förklarar den — och utan något reglage som
     * stänger av den, förutom "Tyst i 15 minuter".
     *
     * spelaVarningsljud() kan inte grinda själv: den ser bara tystad och
     * ljudPa, och ljudPa gäller med flit bara gränssnittsljud. Grinden hör
     * alltså hemma här, och den är exakt samma som inkommande-uppläsningen i
     * app.js redan använder. Två vägar som spelar samma ljud ska inte svara
     * olika på samma reglage.
     *
     * Provknappen i voice.js fortsätter tvinga fram plinget även med
     * uppläsningen av — ett prov som inte låter bevisar ingenting, och det är
     * ett tryck föraren själv gjort just nu.
     *
     * VILL MAN HA PLINGET SOM EGEN KANAL när uppläsningen är av måste det bli
     * ett eget synligt reglage i index.html först. Att bara ta bort raden här
     * igen ger tillbaka larmet utan avstängning.
     */
    if (this.speaker.enabled) this.speaker.chime('alert');
    setTimeout(() => {
      this.speaker.say(first.spoken, { priority: first.priority, interrupt: first.priority === 2 });
      if (fired.length > 1) {
        this.speaker.say(`Ytterligare ${fired.length - 1} varning${fired.length > 2 ? 'ar' : ''} i närheten.`,
          { priority: 0 });
      }
    }, 380);
    for (const a of fired) this.dispatchEvent(new CustomEvent('alert', { detail: a }));
  }
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
