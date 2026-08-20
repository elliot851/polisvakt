// Chatt — ett gemensamt rum för alla som kör appen.
//
// Inga grupper, inga privata meddelanden, inga trådar. Ett rum. Det är ett
// medvetet beslut: den som sitter i en bil ska kunna fråga "står de kvar vid
// Erikslund?" och få svar av någon som just körde förbi. Delar man upp folk i
// rum blir varje rum tomt, och en tom chatt är värre än ingen chatt.
//
// Tre saker skiljer det här från en vanlig chatt, och alla tre finns för att
// appen används bakom en ratt:
//
//   1. NYKTERHETSKONTROLLER SLÄPPS ALDRIG IGENOM. Appen vägrar redan sådana
//      rapporter i parser.js. En fritextchatt är den självklara vägen runt
//      den regeln, och den vägen är stängd — här i klienten OCH i databasen.
//      Filtret importeras från parser.js, det finns ingen andra kopia av
//      ordlistan som kan hamna ur synk.
//
//   2. SKRIVNING LÅSES NÄR BILEN RULLAR. Läsning fortsätter (någon annan i
//      bilen kan läsa högt), men tangentbordet är stängt över tröskeln. Hela
//      appen bygger på "titta på vägen, inte på skärmen" — en chatt som ber
//      föraren skriva medan bilen rullar river ner precis det.
//
//   3. POLLNING, INTE WEBSOCKET. Appen pollar redan Supabase och har en
//      fungerande offlinekö (se store.js). En andra transport hade betytt en
//      andra sak som kan sluta fungera tyst. Pollningen går långsammare när
//      chattvyn inte visas och pausar helt när fliken är dold — batteriet är
//      en förstklassig fråga i en bilapp.
//
// Rå fetch mot PostgREST, precis som store.js och auth.js. Inga bibliotek.

import { uid } from './util.js';
import { apiHeaders } from './config.js';
import { isSobrietyCheck } from './parser.js';

/* ---- Gränser --------------------------------------------------------- */

export const GRANSER = {
  /** Längsta meddelande. Samma tak som i databasen. */
  maxTecken: 400,

  /**
   * Kortaste tid mellan två egna meddelanden.
   *
   * Fem sekunder känns långt när man sitter still och skriver, och det är
   * meningen. Chatten är till för korta lägesbesked, inte för ett samtal i
   * realtid — och varje meddelande kostar batteri och uppmärksamhet hos alla
   * andra som kör just nu.
   */
  minMellanMs: 5000,

  maxPerMinut: 5,
  maxPerTimme: 60,

  /**
   * Över den här farten är inmatningen låst.
   *
   * Åtta km/h är samma gräns som geo.js använder för "moving". Under den
   * rullar man i en kö eller på en parkering; över den kör man. Vakthundens
   * 15 km/h är medvetet högre — den avgör om ett FEL är värt att säga högt,
   * inte om det är säkert att skriva.
   */
  farttroskelKmh: 8,

  /**
   * Hur gammal en fartavläsning får vara innan vi slutar lita på den.
   *
   * Utan den här spärren låser en sista avläsning på 90 km/h innan tunneln
   * fältet för alltid — bilen står parkerad, telefonen har ingen GPS, och
   * appen vägrar envist låta någon skriva. En låsning som inte går att ta
   * sig ur är ett fel, inte en säkerhetsfunktion.
   */
  fartFarskMs: 20000,

  /** Pollintervall när chattvyn syns. */
  pollAktivMs: 8000,
  /** Pollintervall när chatten är öppen men vyn inte visas. */
  pollBakgrundMs: 60000,

  /** Hur många meddelanden som hämtas. */
  hamtaAntal: 100,

  /** Hur ofta en inkrementell hämtning byts mot en full (för att se raderingar). */
  fullHamtningVar: 10,

  /** Databasen städar äldre än så här. Klienten gör samma sak lokalt. */
  gallringDygn: 7,
};

/** Skälen kanSkriva/farSkicka kan ge, med färdig svensk förklaring. */
export const SKAL_TEXT = {
  inte_inloggad: 'Logga in för att skriva i chatten.',
  kor:           'Bilen rullar. Du kan läsa, men inte skriva förrän du står still.',
  tomt:          'Skriv något först.',
  for_langt:     `För långt. Håll dig under ${GRANSER.maxTecken} tecken.`,
  nykterhet:     'Nykterhets- och drogkontroller delas inte i Polisvakt. Det gäller ' +
                 'chatten också.',
  for_tatt:      'Vänta några sekunder mellan meddelandena.',
  for_manga:     'Du har skrivit många meddelanden på kort tid. Ta en paus.',
};

const ok = () => ({ ok: true, skal: null, meddelande: '' });
const nej = skal => ({ ok: false, skal, meddelande: SKAL_TEXT[skal] || 'Går inte just nu.' });

/* ---- Det rena lagret ------------------------------------------------- */
/*
 * Allt som avgör om ett meddelande får skickas ligger i två rena funktioner
 * utan nätverk, utan localStorage och utan klocka som inte går att skicka in.
 * Det är därför de går att testa rakt av i chatt-test.html — och därför de
 * går att lita på.
 */

/**
 * Får föraren skriva just nu? Avgör om inmatningsfältet ska vara låst.
 *
 * @param {{inloggad?:boolean, fartKmh?:number|null, fartAlderMs?:number,
 *          granser?:object}} lage
 * @returns {{ok:boolean, skal:string|null, meddelande:string}}
 */
export function skrivlage(lage = {}) {
  const g = { ...GRANSER, ...(lage.granser || {}) };

  if (lage.inloggad === false) return nej('inte_inloggad');

  const fart = lage.fartKmh;
  const alder = lage.fartAlderMs ?? 0;
  const farsk = Number.isFinite(fart) && alder <= g.fartFarskMs;
  if (farsk && fart > g.farttroskelKmh) return nej('kor');

  return ok();
}

/**
 * Får det här meddelandet skickas? Hela grinden: inloggning, fart, innehåll
 * och hastighetsgräns.
 *
 * @param {string} text
 * @param {{inloggad?:boolean, fartKmh?:number|null, fartAlderMs?:number,
 *          historik?:number[], nu?:number, granser?:object}} lage
 *        historik = tidpunkter (ms) för egna skickade meddelanden.
 * @returns {{ok:boolean, skal:string|null, meddelande:string}}
 */
export function farSkicka(text, lage = {}) {
  const g = { ...GRANSER, ...(lage.granser || {}) };
  const nu = lage.nu ?? Date.now();
  const t = String(text ?? '').trim();

  if (!t) return nej('tomt');
  if (t.length > g.maxTecken) return nej('for_langt');

  /*
   * Produktregeln, före allt annat som handlar om innehåll.
   *
   * isSobrietyCheck importeras från parser.js med flit. Den listan har redan
   * lärt sig saker som inte syns förrän man tittar — att folk och
   * röstigenkänning särskriver ("alkohol kontroll"), och att "drogtest" och
   * "sållningsprov" betyder samma sak. En andra kopia här hade drivit isär
   * från den första inom en månad, och glappet hade blivit exakt den lucka
   * regeln finns för att täppa till.
   */
  if (isSobrietyCheck(t)) return nej('nykterhet');

  const skriv = skrivlage({ ...lage, granser: g });
  if (!skriv.ok) return skriv;

  const h = (lage.historik || []).filter(Number.isFinite);
  const senaste = h.length ? Math.max(...h) : 0;
  if (senaste && nu - senaste < g.minMellanMs) return nej('for_tatt');
  if (h.filter(x => nu - x < 60000).length >= g.maxPerMinut) return nej('for_manga');
  if (h.filter(x => nu - x < 3600000).length >= g.maxPerTimme) return nej('for_manga');

  return ok();
}

/* ---- Namn ------------------------------------------------------------ */

/** FNV-1a, 32 bitar. Samma funktion finns i supabase/chatt.sql. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  const b = new TextEncoder().encode(String(s ?? ''));
  for (const x of b) {
    h ^= x;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Namnet den får som inte valt smeknamn.
 *
 * Aldrig e-postadressen. En chatt där folk syns med sin e-post är en chatt
 * där man inte vågar skriva, och adressen går dessutom inte att ta tillbaka
 * när den väl stått i rummet.
 *
 * Stabilt per konto — samma person heter samma sak imorgon, annars går det
 * inte att följa ett samtal. Härledningen är densamma i databasen, så namnet
 * blir identiskt oavsett vem som räknar ut det.
 */
export function neutraltNamn(identitet) {
  return `Förare ${1000 + (fnv1a(identitet) % 9000)}`;
}

/** Städa ett smeknamn till något som går att visa bredvid andras. */
export function stadaNamn(namn) {
  return String(namn ?? '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

/* ---- Lagring --------------------------------------------------------- */

function lasJSON(k, reserv) {
  try { return JSON.parse(localStorage.getItem(k)) ?? reserv; } catch { return reserv; }
}
function skrivJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

/* ---- Chatten --------------------------------------------------------- */

/**
 * Händelser:
 *   'meddelanden'  listan ändrades (nytt, raderat, hämtat)
 *   'status'       online/offline, synkfel, pollintervall
 *   'blockerat'    ett försök att skicka stoppades — detail = {skal, meddelande}
 */
export class Chatt extends EventTarget {
  /**
   * @param {{url?:string, key?:string, identitet?:string|null,
   *          visningsnamn?:string, granser?:object, lagringsPrefix?:string}} cfg
   */
  constructor(cfg = {}) {
    super();
    this.cfg = { lagringsPrefix: 'pv.chatt', ...cfg };
    this.granser = { ...GRANSER, ...(cfg.granser || {}) };

    this.meddelandenMap = new Map();     // id -> meddelande
    this.egnaTider = [];                 // tidpunkter för egna skickade
    this.timer = null;
    this.vyAktiv = false;
    this.online = typeof navigator === 'undefined' ? true : navigator.onLine;
    this.senasteSynk = null;
    this.synkFel = null;
    this.fartKmh = null;
    this.fartAt = 0;
    this._pollRakning = 0;

    this.tystade = new Set(lasJSON(this.#nyckel('tystade'), []));
    this.anmalda = new Set(lasJSON(this.#nyckel('anmalda'), []));
    for (const m of lasJSON(this.#nyckel('cache'), [])) this.meddelandenMap.set(m.id, m);
    this.egnaTider = lasJSON(this.#nyckel('tider'), []);

    this._online = () => { this.online = true; this.#emit('status'); this.tommKo(); this.hamta(); };
    this._offline = () => { this.online = false; this.#emit('status'); };
    if (typeof addEventListener === 'function') {
      addEventListener('online', this._online);
      addEventListener('offline', this._offline);
    }
  }

  #nyckel(namn) { return `${this.cfg.lagringsPrefix}.${namn}.v1`; }

  get harBackend() { return !!(this.cfg.url && this.cfg.key); }
  get inloggad() { return !!this.cfg.identitet; }

  konfigurera(cfg) {
    const gickIgang = !!this.timer;
    this.cfg = { ...this.cfg, ...cfg };
    if (cfg.granser) this.granser = { ...this.granser, ...cfg.granser };
    if (gickIgang) { this.stoppa(); this.starta(); }
  }

  /* ---- Livscykel ---------------------------------------------------- */

  starta() {
    this.stoppa();
    this.hamta();
    this.#stallTimer();
    this._synlighet = () => {
      // Dold flik = ingen pollning alls. Telefonen ligger i fickan och
      // ingen läser ändå; varje anrop är ren batteriförlust.
      this.#stallTimer();
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.hamta();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._synlighet);
    }
  }

  stoppa() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this._synlighet && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._synlighet);
      this._synlighet = null;
    }
  }

  /** Släpp allt — lyssnare på window också. Kallas om chatten stängs av helt. */
  kopplaLoss() {
    this.stoppa();
    if (typeof removeEventListener === 'function') {
      removeEventListener('online', this._online);
      removeEventListener('offline', this._offline);
    }
  }

  /** Talar om ifall chattvyn visas. Styr hur ofta vi pollar. */
  sattVyAktiv(aktiv) {
    const nytt = !!aktiv;
    if (nytt === this.vyAktiv) return;
    this.vyAktiv = nytt;
    if (this.timer) this.#stallTimer();
    if (nytt) this.hamta();
  }

  /** Är fliken dold? Då pollar vi inte alls. */
  get dold() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  /**
   * Intervallet vyn förtjänar, oavsett om fliken råkar vara dold just nu.
   *
   * Åtta sekunder när man tittar på chatten, en minut när man inte gör det.
   * En bilapp som ligger och pollar var åttonde sekund i timmar för en vy
   * ingen har framme äter batteri som föraren behöver till att komma hem.
   */
  get intervallMs() {
    return this.vyAktiv ? this.granser.pollAktivMs : this.granser.pollBakgrundMs;
  }

  /** Nuvarande pollintervall i ms, eller 0 när pollningen är pausad. */
  get pollMs() { return this.dold ? 0 : this.intervallMs; }

  #stallTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ms = this.pollMs;
    if (!ms) { this.#emit('status'); return; }
    this.timer = setInterval(() => this.hamta(), ms);
    this.#emit('status');
  }

  /** Mata in en position från geo.js. Samma namn som Vakthund.notera. */
  notera(fix, nu = Date.now()) {
    if (!fix) return;
    if (Number.isFinite(fix.speedKmh)) { this.fartKmh = fix.speedKmh; this.fartAt = nu; }
  }

  /** Sätt farten direkt, utan en hel GPS-fix. */
  sattFart(kmh, nu = Date.now()) {
    this.fartKmh = Number.isFinite(kmh) ? kmh : null;
    this.fartAt = nu;
  }

  /* ---- Grinden ------------------------------------------------------ */

  #lage(nu = Date.now()) {
    return {
      inloggad: this.inloggad,
      fartKmh: this.fartKmh,
      fartAlderMs: this.fartAt ? nu - this.fartAt : Infinity,
      historik: this.egnaTider,
      granser: this.granser,
      nu,
    };
  }

  /** Ska inmatningsfältet vara låst? Anropas av gränssnittet. */
  kanSkriva(nu = Date.now()) { return skrivlage(this.#lage(nu)); }

  /** Skulle det här meddelandet gå igenom? Utan att skicka det. */
  provaSkicka(text, nu = Date.now()) { return farSkicka(text, this.#lage(nu)); }

  /* ---- Läsning ------------------------------------------------------ */

  /**
   * Meddelandena att visa: äldst först, tystade avsändare bortfiltrerade och
   * allt äldre än gallringsgränsen borta.
   */
  meddelanden(nu = Date.now()) {
    const grans = nu - this.granser.gallringDygn * 86400000;
    return [...this.meddelandenMap.values()]
      .filter(m => (m.skapadAt || 0) >= grans)
      .filter(m => !this.tystade.has(m.avsandarnyckel))
      .sort((a, b) => a.skapadAt - b.skapadAt);
  }

  /** Allt, även tystat. För en "visa dolda"-knapp. */
  allaMeddelanden() {
    return [...this.meddelandenMap.values()].sort((a, b) => a.skapadAt - b.skapadAt);
  }

  arTystad(nyckel) { return this.tystade.has(nyckel); }
  arAnmald(id) { return this.anmalda.has(id); }

  /* ---- Skrivning ---------------------------------------------------- */

  /**
   * Skicka ett meddelande.
   * @returns {Promise<{ok:boolean, skal?:string, meddelande?:string, id?:string}>}
   */
  async skicka(text, nu = Date.now()) {
    const dom = this.provaSkicka(text, nu);
    if (!dom.ok) {
      this.#emit('blockerat', dom);
      return dom;
    }

    const m = {
      id: uid(),
      text: String(text).trim(),
      visningsnamn: this.#mittNamn(),
      avsandarnyckel: 'jag',      // servern ger den riktiga nyckeln vid hämtning
      mitt: true,
      skapadAt: nu,
      status: this.harBackend ? 'kö' : 'lokalt',
    };

    this.meddelandenMap.set(m.id, m);
    this.egnaTider = [...this.egnaTider, nu].filter(t => nu - t < 3600000).slice(-200);
    skrivJSON(this.#nyckel('tider'), this.egnaTider);
    this.#spara();
    this.#emit('meddelanden');

    if (!this.harBackend) return { ok: true, id: m.id };

    if (!this.online) { this.#koa({ op: 'skicka', m }); return { ok: true, id: m.id }; }
    try {
      await this.#sand({ op: 'skicka', m });
      m.status = 'skickat';
      this.#spara();
      this.#emit('meddelanden');
    } catch (e) {
      // Databasen har samma spärrar som klienten. Blir vi stoppade där är
      // det inte ett nätverksfel och ska inte köas om i all evighet — då
      // skulle en spärrad rad ligga och slå i väggen varje gång vi kommer
      // online. Ta bort bubblan och säg till istället.
      if (e.avvisad) {
        this.meddelandenMap.delete(m.id);
        this.#spara();
        this.#emit('meddelanden');
        const svar = { ok: false, skal: e.skal || 'avvisad', meddelande: e.message };
        this.#emit('blockerat', svar);
        return svar;
      }
      this.#koa({ op: 'skicka', m });
      m.status = 'kö';
      this.#emit('meddelanden');
    }
    return { ok: true, id: m.id };
  }

  /**
   * Radera ett eget meddelande.
   *
   * Andras går inte att röra — varken här eller i databasen, där
   * raderingspolicyn kräver att raden tillhör den inloggade. Klientkollen
   * finns för att kunna ge ett begripligt svar utan en nätverksrunda, inte
   * som skydd. Skyddet ligger i RLS.
   */
  async radera(id) {
    const m = this.meddelandenMap.get(id);
    if (!m) return { ok: false, skal: 'saknas', meddelande: 'Meddelandet finns inte.' };
    if (!m.mitt) {
      return {
        ok: false, skal: 'inte_mitt',
        meddelande: 'Du kan bara radera dina egna meddelanden. Anmäl eller tysta istället.',
      };
    }

    this.meddelandenMap.delete(id);
    this.#spara();
    this.#emit('meddelanden');

    if (!this.harBackend) return { ok: true };
    if (!this.online) { this.#koa({ op: 'radera', id }); return { ok: true }; }
    try { await this.#sand({ op: 'radera', id }); }
    catch { this.#koa({ op: 'radera', id }); }
    return { ok: true };
  }

  /**
   * Anmäl ett meddelande. Anmälningar går till en tabell ingen klient kan
   * läsa — annars blir listan över anmälda en anslagstavla i sig.
   */
  async anmal(id, skal = '') {
    const m = this.meddelandenMap.get(id);
    if (!m) return { ok: false };
    this.anmalda.add(id);
    skrivJSON(this.#nyckel('anmalda'), [...this.anmalda].slice(-300));
    this.#emit('meddelanden');

    if (!this.harBackend) return { ok: true };
    if (!this.online) { this.#koa({ op: 'anmal', id, skal }); return { ok: true }; }
    try { await this.#sand({ op: 'anmal', id, skal }); }
    catch { this.#koa({ op: 'anmal', id, skal }); }
    return { ok: true };
  }

  /**
   * Tysta en avsändare på den här enheten.
   *
   * Lokalt med flit. En global blockering kräver att någon bedömer vem som
   * har rätt, och det finns ingen sådan någon. Att slippa se någon är ett
   * beslut var och en får ta för egen del — och det verkar direkt, utan att
   * vänta på moderering.
   */
  tysta(nyckel) {
    if (!nyckel) return;
    this.tystade.add(nyckel);
    skrivJSON(this.#nyckel('tystade'), [...this.tystade]);
    this.#emit('meddelanden');
  }

  avtysta(nyckel) {
    this.tystade.delete(nyckel);
    skrivJSON(this.#nyckel('tystade'), [...this.tystade]);
    this.#emit('meddelanden');
  }

  /** Tysta den som skrev ett visst meddelande. */
  tystaAvsandarenFor(id) {
    const m = this.meddelandenMap.get(id);
    if (m && !m.mitt) this.tysta(m.avsandarnyckel);
    return !!m;
  }

  /* ---- Synk --------------------------------------------------------- */

  async hamta() {
    // Lokal gallring gäller även utan server, annars växer cachen för alltid.
    const grans = Date.now() - this.granser.gallringDygn * 86400000;
    let stadat = false;
    for (const [id, m] of this.meddelandenMap) {
      if ((m.skapadAt || 0) < grans) { this.meddelandenMap.delete(id); stadat = true; }
    }
    if (stadat) { this.#spara(); this.#emit('meddelanden'); }

    if (!this.harBackend || !this.online) return;

    // Var tionde hämtning tas hela fönstret om. Inkrementell hämtning ser
    // bara nya rader — den som raderat sitt meddelande skulle annars ligga
    // kvar på alla andras skärmar tills appen startades om.
    const full = (this._pollRakning++ % this.granser.fullHamtningVar) === 0;
    const senaste = full ? 0 : this.#senasteTid();

    const filter = senaste ? `&skapad_at=gt.${encodeURIComponent(new Date(senaste).toISOString())}` : '';
    const url = `${this.cfg.url}/rest/v1/chatt_flode` +
      `?select=*&order=skapad_at.desc&limit=${this.granser.hamtaAntal}${filter}`;

    try {
      const r = await fetch(url, { headers: apiHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rader = await r.json();

      this.mottaRader(rader, { full });
      this.senasteSynk = Date.now();
      /*
       * Nollställningen måste också ut på skärmen.
       *
       * Tidigare sattes synkFel till null här utan att någon händelse gick
       * iväg, så en felruta från en enda misslyckad hämtning stod kvar för
       * alltid — även när chatten hämtade utan problem sekunden efter. Det
       * såg ut som att appen var trasig när den redan lagat sig.
       */
      const hadeFel = this.synkFel !== null;
      this.synkFel = null;
      if (hadeFel) this.#emit('status');
    } catch (e) {
      this.synkFel = this.#synkfelText(e);
      this.#emit('status');
    }
    this.tommKo();
  }

  /**
   * Översätt ett nätverksfel till något en förare kan agera på.
   *
   * "Ingen kontakt med servern: HTTP 401" säger ingenting till den som ser
   * det. 401 betyder här nästan alltid en enda sak: anropet gick iväg utan
   * inloggning, för chatten är stängd för utomstående.
   */
  #synkfelText(e) {
    const m = String(e?.message || '');
    if (m.includes('401') || m.includes('403')) {
      return this.inloggad
        ? 'Inloggningen har gått ut. Logga in igen för att se chatten.'
        : 'Logga in för att se chatten.';
    }
    if (m.includes('404')) return 'Chatten är inte påslagen på servern än.';
    if (m.includes('Failed to fetch')) return 'Ingen internetanslutning.';
    return 'Ingen kontakt med servern just nu.';
  }

  /**
   * Ta emot rader från servern (eller från ett test).
   *
   * Ligger separat från hämtningen så att tolkningen av en serverrad går att
   * kontrollera utan nätverk — det var precis den skarven som brast förra
   * gången ett fält lades till, och felet såg då ut som en trasig app.
   *
   * @param {Array} rader rader ur vyn chatt_flode
   * @param {{full?:boolean}} opt full = hela fönstret hämtat, bygg om listan
   */
  mottaRader(rader, opt = {}) {
    if (opt.full) {
      // Behåll det som ännu inte nått servern, kasta resten och bygg om.
      const okoat = [...this.meddelandenMap.values()].filter(m => m.status === 'kö');
      this.meddelandenMap.clear();
      for (const m of okoat) this.meddelandenMap.set(m.id, m);
    }
    for (const rad of rader || []) {
      const m = this.#franRad(rad);
      if (m.id) this.meddelandenMap.set(m.id, m);
    }
    this.#spara();
    this.#emit('meddelanden');
  }

  #senasteTid() {
    let t = 0;
    for (const m of this.meddelandenMap.values()) {
      if (m.status === 'kö') continue;          // inte serverns tid
      if (m.skapadAt > t) t = m.skapadAt;
    }
    return t;
  }

  #franRad(rad) {
    return {
      id: rad.id,
      text: rad.text || '',
      visningsnamn: rad.visningsnamn || 'Förare',
      avsandarnyckel: rad.avsandarnyckel || '',
      mitt: !!rad.mitt,
      skapadAt: typeof rad.skapad_at === 'number' ? rad.skapad_at : Date.parse(rad.skapad_at),
      status: 'skickat',
    };
  }

  #mittNamn() {
    const n = stadaNamn(this.cfg.visningsnamn);
    return n || neutraltNamn(this.cfg.identitet || '');
  }

  #koa(jobb) {
    const k = lasJSON(this.#nyckel('ko'), []);
    k.push(jobb);
    skrivJSON(this.#nyckel('ko'), k.slice(-50));
  }

  async tommKo() {
    if (!this.harBackend || !this.online) return;
    const k = lasJSON(this.#nyckel('ko'), []);
    if (!k.length) return;
    const kvar = [];
    for (const jobb of k) {
      try { await this.#sand(jobb); }
      catch (e) { if (!e.avvisad) kvar.push(jobb); }
    }
    skrivJSON(this.#nyckel('ko'), kvar);
  }

  async #sand(jobb) {
    const bas = `${this.cfg.url}/rest/v1`;
    const huvud = { ...apiHeaders(), 'Content-Type': 'application/json' };

    if (jobb.op === 'skicka') {
      const r = await fetch(`${bas}/chatt_meddelanden`, {
        method: 'POST',
        headers: { ...huvud, Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: jobb.m.id,
          avsandare: this.cfg.identitet,
          text: jobb.m.text,
          visningsnamn: jobb.m.visningsnamn,
        }),
      });
      if (!r.ok) throw await this.#fel(r);
      return;
    }

    if (jobb.op === 'radera') {
      const r = await fetch(`${bas}/chatt_meddelanden?id=eq.${encodeURIComponent(jobb.id)}`, {
        method: 'DELETE',
        headers: { ...huvud, Prefer: 'return=minimal' },
      });
      if (!r.ok) throw await this.#fel(r);
      return;
    }

    if (jobb.op === 'anmal') {
      const r = await fetch(`${bas}/chatt_anmalningar`, {
        method: 'POST',
        headers: { ...huvud, Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({
          meddelande_id: jobb.id,
          anmalare: this.cfg.identitet,
          skal: String(jobb.skal || '').slice(0, 200),
        }),
      });
      if (!r.ok) throw await this.#fel(r);
    }
  }

  /**
   * Översätt ett svar från PostgREST till något en förare förstår.
   *
   * Databasen har egna spärrar för nykterhetsinnehåll och skrivtakt. Blir vi
   * stoppade där är det ett besked, inte ett avbrott — markera det som
   * "avvisad" så köandet inte försöker igen i all evighet.
   */
  async #fel(r) {
    let kropp = '';
    try { kropp = await r.text(); } catch {}
    const l = kropp.toLowerCase();
    const e = new Error('Kunde inte skicka. Försök igen.');
    e.status = r.status;

    if (l.includes('chatt_nykterhet')) {
      e.avvisad = true; e.skal = 'nykterhet'; e.message = SKAL_TEXT.nykterhet;
    } else if (l.includes('chatt_for_snabbt')) {
      e.avvisad = true; e.skal = 'for_tatt'; e.message = SKAL_TEXT.for_tatt;
    } else if (l.includes('chatt_for_manga')) {
      e.avvisad = true; e.skal = 'for_manga'; e.message = SKAL_TEXT.for_manga;
    } else if (r.status === 401 || r.status === 403) {
      e.avvisad = true; e.skal = 'inte_inloggad'; e.message = SKAL_TEXT.inte_inloggad;
    }
    return e;
  }

  #spara() {
    const senaste = this.allaMeddelanden().slice(-this.granser.hamtaAntal);
    skrivJSON(this.#nyckel('cache'), senaste);
  }

  #emit(namn, detalj) {
    this.dispatchEvent(new CustomEvent(namn, { detail: detalj }));
  }
}

export default Chatt;
