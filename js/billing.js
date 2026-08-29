// Provperiod och prenumeration.
//
// 2 dagar gratis, sedan 99 kr/mån — när kontokravet är aktivt. I dag, i
// testläget, gäller fortfarande 5 dagar på enhetens id: se KONTOKRAV_AKTIVT
// nedan. (Rubriken här sade länge "29 kr/mån"; det var aldrig sant — priset
// är och har varit 99 kr, se PRICE_TEXT.)
//
// Var ärlig med vad det här är: en spärr i klienten går att kringgå av den
// som verkligen vill. Den håller ordning på hederligt folk, inget mer. Riktig
// koll kräver att servern (Supabase) äger sanningen — därför synkas både
// provperiodens start och prenumerationsstatus mot backend när den är
// konfigurerad. Utan backend är allt lokalt och lätt att nollställa.
//
// Två viktiga produktbeslut ligger inbakade här:
//   1. Betalväggen visas aldrig mitt under körning. En bilist ska inte få en
//      modal i ansiktet i 90 km/h. Den väntar tills bilen står still.
//   2. Provperioden startar först när appen används på riktigt, inte vid
//      första sidladdningen. (Med konto gäller det bara den LOKALA
//      visningen — serverns start sätts när kontot skapas, av en trigger
//      på auth.users, och den vinner alltid. Se migrationen
//      supabase/migrationer/2026-08-23-provperiod-pa-kontot.sql.)
//
// KONTOVÄGEN, i korthet (vilande tills KONTOKRAV_AKTIVT = true):
//   - Provperioden följer KONTOT, inte telefonen. Nyckeln på servern är
//     kontots uuid (deviceId() i js/store.js returnerar redan den för
//     inloggade). En ny telefon är inte längre en ny gratisperiod.
//   - Starten sätts på SERVERN när kontot skapas — aldrig av klientens
//     klocka, aldrig vid sidladdning.
//   - Fanns en enhetsnycklad trial på telefonen när kontot skapades gäller
//     den TIDIGASTE starten av de två (sammanslagningen görs på servern i
//     hamta_konto_prenumeration). Annars: kör slut på enhetens trial,
//     skapa konto, få nya dagar — receptet för evig gratis.
//   - För att sammanslagningen ska ha något att arbeta med även i skarp
//     drift (där kontokravet gör att ingen hinner vara utloggad, så
//     #syncUp aldrig skapar någon enhetsrad) skriver kontosynken tillbaka
//     den tidigaste kända starten till telefonens EGNA enhetsrad — ett
//     enhetsankare. Se #skrivEnhetsankare för hela resonemanget.
//   - ÄRLIG GRÄNS: spärren är per KONTO, inte per MÄNNISKA. Ett nytt konto
//     i en ny webbläsare eller i privat surfläge (inget enhetsankare där)
//     får nya provdagar, och Supabase räknar en gmail-plusadress som en ny
//     e-post. Att stänga det går inte härifrån — det är ett produktbeslut:
//     e-postbekräftelse med normaliserad adress, kort up-front vid
//     trialstart, eller fingeravtryck som sekundär spärr. Tills något av
//     det finns är "2 dagar per konto" vad grinden faktiskt lovar.
//   - En betalning på kontot gäller på alla kontots enheter, eftersom alla
//     inloggade enheter läser samma rad.

import { deviceId } from './store.js';
import { apiHeaders } from './config.js';

const KEY = 'pv.billing.v1';
export const PRICE_TEXT = '99 kr/mån';

/**
 * Huvudströmbrytaren för kontonycklad provperiod.
 *
 * false = dagens beteende, exakt: 5 dagars prov på enhetens id, ingen
 *         kontoväg, inget konto-prefix i kassalänken. Ägaren testar appen
 *         utan inloggning (TESTLAGE_UTAN_INLOGGNING i js/app.js) och
 *         ingenting här får ändra det.
 * true  = 2 dagars prov som följer kontot. Flippas till true SAMTIDIGT som
 *         TESTLAGE_UTAN_INLOGGNING i js/app.js sätts till false, och
 *         migrationen 2026-08-23-provperiod-pa-kontot.sql ska vara körd
 *         innan dess — annars svarar servern 404 på kontovägen (klienten
 *         faller då tillbaka på enhetsvägen, inget kraschar, men kontot
 *         ger fel antal dagar).
 *
 * Två flaggor i två filer är inte idealt, men app.js ägs av en annan
 * omgång just nu och flaggan där kan inte importeras (den är en lokal
 * const). Se "kvar" i rapporten: när filgränserna släpper bör app.js
 * exportera sitt testläge eller läsa det här.
 */
export const KONTOKRAV_AKTIVT = false;

/** Beställningen: två dagar när kontokravet är aktivt. */
export const PROV_DAGAR_KONTO = 2;
/** Dagens längd. Rörs inte förrän testläget stängs. */
export const PROV_DAGAR_TESTLAGE = 5;

/**
 * Exporteras för texterna i app.js ("X dagar gratis..."). Följer
 * strömbrytaren så att texten aldrig ljuger om vad grinden gör.
 */
export const TRIAL_DAYS = KONTOKRAV_AKTIVT ? PROV_DAGAR_KONTO : PROV_DAGAR_TESTLAGE;

/**
 * Enhetens EGNA id — inte deviceId().
 *
 * deviceId() returnerar kontots uuid när man är inloggad (setIdentity i
 * js/store.js), och det är rätt för allt annat. Men sammanslagningen bakåt
 * behöver just telefonens gamla slumpade id, för det är under det som en
 * redan påbörjad trial ligger. Nyckeln måste stavas exakt som DEVICE_KEY i
 * js/store.js — store.js ägs av en annan omgång just nu, därför läses
 * localStorage direkt här i stället för en ny export därifrån.
 */
function enhetensEgnaId() {
  try { return localStorage.getItem('pv.device.v1') || null; } catch { return null; }
}

/**
 * Referensen som skickas till Stripe som client_reference_id.
 *
 * Inloggad med aktivt kontokrav: 'konto-<uuid>' — prefixet låter webhooken
 * (och funktionerna den anropar, se migrationen) skilja konto från enhet.
 * Utloggad, eller i testläget: deviceId(), precis som i dag.
 *
 * BINDESTRECK, inte kolon: Stripe Payment Links (buy.stripe.com) tillåter
 * bara alfanumeriskt, bindestreck och understreck i client_reference_id,
 * max 200 tecken, och SLÄPPER OGILTIGA VÄRDEN TYST. Med 'konto:' hade
 * kassan fungerat och kunden betalat — men webhooken fått null och varje
 * inloggat köp blivit föräldralöst. Kollisionsrisken med enhets-id är
 * noll: de är crypto.randomUUID() eller 'id-'-prefixade (js/util.js) och
 * kan aldrig börja med 'konto-'.
 *
 * Konto-id:t läses ur pv.identity.v1 — nyckeln som setIdentity() i
 * js/store.js skriver vid inloggning och tömmer vid utloggning. Samma skäl
 * till direktläsningen som i enhetensEgnaId() ovan.
 */
export function kassareferens(kontokrav = KONTOKRAV_AKTIVT, konto = null) {
  if (kontokrav) {
    let id = konto;
    if (!id) { try { id = localStorage.getItem('pv.identity.v1'); } catch {} }
    if (id) return 'konto-' + id;
  }
  return deviceId();
}

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} }

export class Billing extends EventTarget {
  /**
   * @param {{url?:string, key?:string, paymentLink?:string, kontokrav?:boolean}} cfg
   *   kontokrav finns som fält bara för proven (prov/konto-trial.mjs), som
   *   måste kunna köra den vilande vägen utan att flippa den globala
   *   flaggan. app.js skickar aldrig fältet — där gäller KONTOKRAV_AKTIVT.
   */
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.kontokrav = cfg.kontokrav ?? KONTOKRAV_AKTIVT;
    this.konto = null;         // kontots uuid när någon är inloggad
    this.kontoToken = null;    // användarens JWT — kontovägen kräver den
    this.state = {
      trialStart: null,
      status: 'unknown',      // unknown | trial | active | expired
      paidUntil: null,
      code: null,
      ...load(),
    };
    this.deferredPaywall = false;

    // auth.js meddelar in-/utloggning med en händelse på window i stället
    // för ett direkt anrop: app.js (som äger båda instanserna) får inte
    // röras av den här omgången, och auth.js kan inte importera instansen.
    // Händelsen bär både konto-id och token, så kontovägen fungerar även
    // innan app.js hunnit sätta den delade accessToken i config.js.
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pv:konto', e => {
        this.setKonto(e.detail?.id || null, e.detail?.token || null);
      });
    }
  }

  configure(cfg) { this.cfg = { ...this.cfg, ...cfg }; }

  /**
   * auth.js ropar hit (via pv:konto-händelsen) vid inloggning, utloggning
   * och tokenförnyelse. Kontot är nyckeln så länge det finns; deviceId
   * behålls som sekundär koppling för utloggade enheter och för Stripe.
   */
  setKonto(userId, accessToken = null) {
    const nytt = userId || null;
    const bytte = nytt !== this.konto;
    this.konto = nytt;
    this.kontoToken = accessToken || null;
    // Bara ett byte av konto motiverar en omsynk. Tokenförnyelser kommer
    // varje timme och ska inte trigga nätverkstrafik i onödan.
    if (bytte) this.sync();
  }

  /** Provperiodens längd i dagar för DEN HÄR instansen. */
  get provDagar() {
    return this.kontokrav ? PROV_DAGAR_KONTO : PROV_DAGAR_TESTLAGE;
  }

  get trialEndsAt() {
    return this.state.trialStart ? this.state.trialStart + this.provDagar * 86400_000 : null;
  }

  get daysLeft() {
    if (!this.trialEndsAt) return this.provDagar;
    return Math.max(0, Math.ceil((this.trialEndsAt - Date.now()) / 86400_000));
  }

  get hoursLeft() {
    if (!this.trialEndsAt) return this.provDagar * 24;
    return Math.max(0, Math.ceil((this.trialEndsAt - Date.now()) / 3600_000));
  }

  /** Får appen användas just nu? */
  get allowed() {
    // Testfasen (KONTOKRAV_AKTIVT = false): ingen betalning krävs, så
    // provperioden får ALDRIG gata. Utan den här raden slog en utgången
    // enhets-trial upp betalväggen "Provperioden är slut" mitt i testfasen —
    // maybeShowPaywall() körs var 60:e sekund och kollade bara allowed, inte
    // testläget. Hela provlogiken är vilande tills kontokravet slås på.
    if (!KONTOKRAV_AKTIVT) return true;
    return this.status === 'trial' || this.status === 'active';
  }

  get status() {
    if (this.state.paidUntil && this.state.paidUntil > Date.now()) return 'active';
    if (!this.state.trialStart) return 'trial';           // ännu inte startad
    if (Date.now() < this.trialEndsAt) return 'trial';
    return 'expired';
  }

  /**
   * Kallas när användaren faktiskt börjar köra appen. Sätter bara den
   * LOKALA starten — för konton är serverns trigger sanningen, och sync()
   * skriver över det här så fort den svarar. Klientens klocka bestämmer
   * aldrig ett kontos start.
   */
  beginTrial() {
    if (this.state.trialStart) return;
    this.state.trialStart = Date.now();
    this.#save();
    this.#syncUp();
    this.#emit('change');
  }

  /* ---- Backend ---- */

  get hasBackend() { return !!(this.cfg.url && this.cfg.key); }

  /**
   * Hämtar sanningen från servern. Serverns trialStart vinner alltid över
   * den lokala — annars räcker det att rensa webbläsardata för nytt prov.
   *
   * Två vägar:
   *   Konto (inloggad, kontokrav aktivt): hamta_konto_prenumeration, som
   *   läser identiteten ur JWT:n och gör sammanslagningen bakåt på servern.
   *   Svarar den inte (offline, utgången token, migrationen inte körd) tas
   *   enhetsvägen i stället — deviceId() pekar ändå på kontots rad för
   *   inloggade, så läsningen blir rätt, bara utan sammanslagning.
   *
   *   Enhet (utloggad, eller testläget): exakt som i dag. get_subscription
   *   på deviceId(), och saknas raden skrivs den lokala starten upp.
   */
  async sync() {
    if (!this.hasBackend) { this.#emit('change'); return; }

    if (this.kontokrav && this.konto) {
      const ok = await this.#syncKonto();
      if (ok) { this.#emit('change'); return; }
      // annars: fall igenom till enhetsvägen
    }

    try {
      // Går via funktion istället för direktläsning: prenumeranttabellen
      // innehåller e-post och betalningsuppgifter som ingen klient ska kunna
      // hämta. Funktionen lämnar bara ut de två datumen.
      const r = await fetch(`${this.cfg.url}/rest/v1/rpc/get_subscription`, {
        method: 'POST',
        headers: { ...this.#headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_device: deviceId() }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const rows = await r.json();
      if (rows.length) {
        const row = rows[0];
        const remoteStart = row.trial_start ? Date.parse(row.trial_start) || +row.trial_start : null;
        if (remoteStart && (!this.state.trialStart || remoteStart < this.state.trialStart)) {
          this.state.trialStart = remoteStart;
        }
        this.state.paidUntil = row.paid_until ? (Date.parse(row.paid_until) || +row.paid_until) : null;
        this.#save();
      } else {
        await this.#syncUp();
      }
    } catch { /* offline — kör vidare på lokal status */ }
    this.#emit('change');
  }

  /** Kontovägen. true = klart, false = ta enhetsvägen i stället. */
  async #syncKonto() {
    try {
      const headers = { ...this.#headers(), 'Content-Type': 'application/json' };
      // Kontofunktionen läser vem du är ur JWT:n. Utan användarens token är
      // anropet meningslöst (servern svarar med tom mängd för anon).
      if (this.kontoToken) headers.Authorization = `Bearer ${this.kontoToken}`;
      const r = await fetch(`${this.cfg.url}/rest/v1/rpc/hamta_konto_prenumeration`, {
        method: 'POST',
        headers,
        // Enhetens egna id följer med för sammanslagningen bakåt: fanns en
        // trial på telefonen innan kontot skapades gäller den tidigaste
        // starten. Servern tar bara emot trial_start den vägen — aldrig
        // betald tid (se migrationen för varför).
        body: JSON.stringify({ p_enhet: enhetensEgnaId() }),
      });
      if (!r.ok) return false;
      const rows = await r.json();
      if (!rows.length) return false;   // ingen JWT nådde fram — enhetsvägen får ta det

      const row = rows[0];
      const remoteStart = row.trial_start ? Date.parse(row.trial_start) || +row.trial_start : null;
      // Tidigaste starten vinner även lokalt: en trial som börjat offline
      // och aldrig synkats upp ska inte förlängas av att servern har en
      // senare uppfattning.
      if (remoteStart && (!this.state.trialStart || remoteStart < this.state.trialStart)) {
        this.state.trialStart = remoteStart;
      }
      // Betald tid däremot ägs helt av kontot: alla kontots enheter ska se
      // samma sak, så serverns värde gäller rakt av — även när det är null.
      this.state.paidUntil = row.paid_until ? (Date.parse(row.paid_until) || +row.paid_until) : null;
      this.#save();
      // Efter en lyckad kontoläsning: skriv enhetsankaret, så nästa konto
      // på samma telefon har något att smälta bakåt med. Se metoden.
      await this.#skrivEnhetsankare();
      return true;
    } catch {
      return false;   // offline — enhetsvägen misslyckas då också, lokal status gäller
    }
  }

  async #syncUp() {
    if (!this.hasBackend || !this.state.trialStart) return;
    // En inloggad med kontokrav skriver aldrig upp sin lokala start HÄR —
    // deviceId() är då kontots uuid, och det hade varit klientens klocka
    // som satte KONTOTS sanning bakvägen. Enhetsankaret nedan är en annan
    // sak: det skrivs till telefonens EGNA rad, och bara med värden som
    // servern just bekräftat.
    if (this.kontokrav && this.konto) return;
    try {
      await fetch(`${this.cfg.url}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          ...this.#headers(),
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          device_id: deviceId(),
          trial_start: new Date(this.state.trialStart).toISOString(),
        }),
      });
    } catch {}
  }

  /**
   * Enhetsankaret — skrivs av INLOGGADE, till telefonens EGNA rad.
   *
   * Sammanslagningen bakåt (hamta_konto_prenumeration, p_enhet) behöver en
   * enhetsnycklad rad på servern att smälta med. I skarp drift skapas den
   * aldrig av #syncUp: kontokravet gör att appen inte kör utloggad, och
   * #syncUp är dessutom spärrad för inloggade. Utan det här hade merge-
   * koden varit död i produktion och receptet "kör slut på konto A:s
   * dagar, skapa konto B på samma telefon" stått öppet.
   *
   * Därför skrivs den tidigaste kända starten tillbaka till enhetsraden
   * efter varje lyckad kontoläsning. Värdet är i det läget redan minsta av
   * kontots, enhetens och den lokala starten (servern har just gjort
   * sammanslagningen), så skrivningen kan bara HÅLLA KVAR eller FLYTTA
   * BAKÅT enhetsradens start — aldrig förlänga någons prov. Nästa konto
   * som skapas på samma telefon ärver ankaret via p_enhet och får inga
   * nya dagar.
   *
   * Detta stänger "två konton växelvis på samma telefon". Det stänger
   * INTE "nytt konto i ny webbläsare" — se ÄRLIG GRÄNS i filhuvudet.
   */
  async #skrivEnhetsankare() {
    const enhet = enhetensEgnaId();
    if (!this.hasBackend || !enhet || enhet === this.konto || !this.state.trialStart) return;
    try {
      await fetch(`${this.cfg.url}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          ...this.#headers(),
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          device_id: enhet,
          trial_start: new Date(this.state.trialStart).toISOString(),
        }),
      });
    } catch { /* offline — ankaret skrivs vid nästa lyckade kontosynk i stället */ }
  }

  /**
   * Lös in en kod. Tänkt för manuell försäljning (Swish) innan Stripe är
   * på plats: koden slås upp i tabellen access_codes och binds till enheten
   * — eller till kontot, eftersom deviceId() är kontots uuid för inloggade.
   */
  async redeem(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return { ok: false, error: 'Ange en kod.' };
    if (!this.hasBackend) return { ok: false, error: 'Ingen backend konfigurerad.' };
    try {
      const r = await fetch(`${this.cfg.url}/rest/v1/rpc/redeem_code`, {
        method: 'POST',
        headers: { ...this.#headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_code: clean, p_device: deviceId() }),
      });
      if (!r.ok) return { ok: false, error: 'Koden gick inte att lösa in.' };
      const paidUntil = await r.json();
      if (!paidUntil) return { ok: false, error: 'Ogiltig eller redan använd kod.' };
      this.state.paidUntil = Date.parse(paidUntil) || +paidUntil;
      this.state.code = clean;
      this.#save();
      this.#emit('change');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Nätverksfel.' };
    }
  }

  /**
   * Öppnar Stripe-betallänken med rätt referens så webhooken hittar rätt
   * rad: 'konto-<uuid>' för inloggade när kontokravet är aktivt (då gäller
   * betalningen på alla kontots enheter), annars enhetens id precis som
   * i dag.
   */
  checkoutUrl() {
    if (!this.cfg.paymentLink) return null;
    const u = new URL(this.cfg.paymentLink);
    u.searchParams.set('client_reference_id', kassareferens(this.kontokrav, this.konto));
    return u.toString();
  }

  #headers() {
    return apiHeaders();
  }

  #save() { save(this.state); }
  #emit(n) { this.dispatchEvent(new CustomEvent(n)); }

  /**
   * Endast för utveckling. Nollställer BARA det lokala tillståndet —
   * serverns trial_start och paid_until rörs inte, och nästa sync()
   * hämtar tillbaka dem. Det är med flit: en reset i klienten får aldrig
   * vara en väg till ny gratisperiod.
   */
  resetTrial() {
    this.state = { trialStart: null, status: 'unknown', paidUntil: null, code: null };
    this.#save();
    this.#emit('change');
  }
}
