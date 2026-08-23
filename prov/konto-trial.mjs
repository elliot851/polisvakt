// Prov: provperioden följer kontot — js/billing.js + js/auth.js
//
// Körs med portabel Node:
//   %LOCALAPPDATA%\nodejs-portable\node.exe prov\konto-trial.mjs
//
// Vad som bevisas, i ordning:
//   1. Två dagar när kontokravet är aktivt — inte fem — och att dagens
//      exporterade TRIAL_DAYS fortfarande är 5 (vilande flagga, dagens
//      beteende orört).
//   2. Statusövergången trial -> expired vid exakt två dagar.
//   3. Kontostarten vinner när kontot är äldst, och tvärtom: tidigaste
//      starten av konto och enhet gäller (sammanslagning bakåt). Plus
//      enhetsankaret: kontosynken skriver tillbaka den tidigaste starten
//      till telefonens egna rad, så konto nummer två på samma telefon
//      ärver den och får INGA nya dagar.
//   4. En utloggad enhet beter sig EXAKT som i dag: samma anrop, samma
//      ordning, samma femdagarsregel, inget kontoanrop.
//   5. resetTrial rör aldrig serverns sanning.
//   6. Kassareferensen: 'konto-<uuid>' för inloggade med kontokrav,
//      enhetens id annars. Bindestreck, aldrig kolon — Stripe släpper
//      tyst varje client_reference_id med otillåtna tecken.
//   7. Bryggan auth -> billing: pv:konto-händelsen når setKonto, även för
//      en session som fanns sparad före sidladdningen.
//
// Ingen riktig backend: fetch är mockad och spelar server med samma regler
// som migrationen 2026-08-23-provperiod-pa-kontot.sql. Varje anrop loggas,
// så proven kan kontrollera ATT och HUR nätverket användes — inte bara
// slutresultatet.

/* ---------- Skal: webbläsarens globaler i Node ---------- */

const lagring = new Map();
globalThis.localStorage = {
  getItem: k => (lagring.has(k) ? lagring.get(k) : null),
  setItem: (k, v) => { lagring.set(k, String(v)); },
  removeItem: k => { lagring.delete(k); },
};

if (typeof CustomEvent === 'undefined') {
  globalThis.CustomEvent = class extends Event {
    constructor(typ, opts = {}) { super(typ, opts); this.detail = opts.detail ?? null; }
  };
}

globalThis.window = new EventTarget();

/* ---------- Mockad server ---------- */

const DYGN = 86_400_000;
const nu = Date.now();
const iso = ms => new Date(ms).toISOString();

// rader: nyckel -> { trial_start, paid_until } — subscribers-tabellen.
// tokens: JWT -> konto-uuid — vad auth.uid() hade svarat.
const server = { rader: {}, tokens: {} };
const kallelser = [];   // { path, body, auth } för varje fetch

globalThis.fetch = async (url, opts = {}) => {
  const path = new URL(String(url)).pathname;
  const body = opts.body ? JSON.parse(opts.body) : null;
  const auth = opts.headers?.Authorization || null;
  kallelser.push({ path, body, auth });

  const svar = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

  if (path === '/rest/v1/rpc/get_subscription') {
    const rad = server.rader[body.p_device];
    return svar(rad ? [rad] : []);
  }

  if (path === '/rest/v1/rpc/hamta_konto_prenumeration') {
    // Samma dörr som i drift: identiteten ur JWT:n, aldrig ur en parameter.
    const m = /^Bearer (.+)$/.exec(auth || '');
    const konto = m ? server.tokens[m[1]] : null;
    if (!konto) return svar([]);   // anon-nyckel => tom mängd, som migrationen
    if (!server.rader[konto]) server.rader[konto] = { trial_start: iso(nu), paid_until: null };
    // Sammanslagning bakåt: tidigaste trial_start vinner. paid_until följer
    // ALDRIG med — exakt som hamta_konto_prenumeration i migrationen.
    const enhet = body?.p_enhet;
    if (enhet && enhet !== konto && server.rader[enhet]) {
      const k = Date.parse(server.rader[konto].trial_start);
      const e = Date.parse(server.rader[enhet].trial_start);
      if (e < k) server.rader[konto].trial_start = server.rader[enhet].trial_start;
    }
    return svar([server.rader[konto]]);
  }

  if (path === '/rest/v1/subscribers') {
    // PostgRESTs merge-duplicates-upsert, som #syncUp använder.
    const id = body.device_id;
    server.rader[id] = { ...(server.rader[id] || { paid_until: null }), trial_start: body.trial_start };
    return svar(null);
  }

  throw new Error('oväntat anrop: ' + path);
};

/* ---------- Provräkning ---------- */

let antalOk = 0;
const fel = [];
function kontrollera(namn, sant, detalj = '') {
  if (sant) { antalOk++; }
  else { fel.push(namn + (detalj ? ' — ' + detalj : '')); console.error('FEL: ' + namn, detalj); }
}
const naraMs = (a, b, tol = 5000) => Math.abs(a - b) <= tol;

/* ---------- Importera modulerna som appen kör med ---------- */

localStorage.setItem('pv.device.v1', 'enhet-lokal-1');   // telefonens egna id

const { Billing, TRIAL_DAYS, PROV_DAGAR_KONTO, PROV_DAGAR_TESTLAGE, KONTOKRAV_AKTIVT, kassareferens, PRICE_TEXT } =
  await import('../js/billing.js');

const CFG = { url: 'https://prov.local', key: 'anon-nyckel' };

/* =====================================================================
   PROV 1 — konstanterna: 2 dagar bakom flaggan, 5 i dag, 99 kr
   ===================================================================== */

kontrollera('1a: PROV_DAGAR_KONTO är 2', PROV_DAGAR_KONTO === 2, String(PROV_DAGAR_KONTO));
kontrollera('1b: KONTOKRAV_AKTIVT är false (vilande)', KONTOKRAV_AKTIVT === false);
kontrollera('1c: TRIAL_DAYS är 5 i dag — dagens beteende orört', TRIAL_DAYS === 5, String(TRIAL_DAYS));
kontrollera('1d: PROV_DAGAR_TESTLAGE är 5', PROV_DAGAR_TESTLAGE === 5);
kontrollera('1e: priset är 99 kr/mån', PRICE_TEXT === '99 kr/mån', PRICE_TEXT);

/* =====================================================================
   PROV 2 — två dagar, inte fem, och övergången trial -> expired
   ===================================================================== */

localStorage.removeItem('pv.billing.v1');
const b2 = new Billing({ kontokrav: true });   // kontoläget, utan backend

kontrollera('2a: instansens provdagar är 2 i kontoläget', b2.provDagar === 2);

b2.state.trialStart = nu - (2 * DYGN - 60_000);   // en minut kvar
kontrollera('2b: en minut före tvådagarsgränsen: trial', b2.status === 'trial', b2.status);
kontrollera('2c: allowed under trial', b2.allowed === true);

b2.state.trialStart = nu - (2 * DYGN + 60_000);   // en minut över
kontrollera('2d: en minut efter tvådagarsgränsen: expired', b2.status === 'expired', b2.status);
kontrollera('2e: allowed false efter utgång', b2.allowed === false);

b2.state.trialStart = nu - 3 * DYGN;              // 3 dagar gammal
kontrollera('2f: 3 dagar gammal trial är expired i kontoläget (hade varit trial med 5)',
  b2.status === 'expired', b2.status);

/* =====================================================================
   PROV 3 — kontostarten vinner när kontot är äldst
   ===================================================================== */

localStorage.removeItem('pv.billing.v1');
server.rader['uuid-konto-A'] = { trial_start: iso(nu - 10 * DYGN), paid_until: null };
server.rader['enhet-lokal-1'] = { trial_start: iso(nu - 1 * DYGN), paid_until: null };
server.tokens['jwt-A'] = 'uuid-konto-A';

const b3 = new Billing({ ...CFG, kontokrav: true });
b3.state.trialStart = null;
const mark3 = kallelser.length;
b3.setKonto('uuid-konto-A', 'jwt-A');            // triggar sync()
await new Promise(r => setTimeout(r, 10));

const anrop3 = kallelser.slice(mark3);
kontrollera('3a: kontovägen anropades', anrop3.some(k => k.path === '/rest/v1/rpc/hamta_konto_prenumeration'));
kontrollera('3b: användarens JWT skickades, inte anon-nyckeln',
  anrop3.find(k => k.path === '/rest/v1/rpc/hamta_konto_prenumeration')?.auth === 'Bearer jwt-A');
kontrollera('3c: enhetens EGNA id följde med för sammanslagningen',
  anrop3.find(k => k.path === '/rest/v1/rpc/hamta_konto_prenumeration')?.body?.p_enhet === 'enhet-lokal-1');
kontrollera('3d: kontots äldre start (10 d) gäller — inte enhetens (1 d)',
  naraMs(b3.state.trialStart, nu - 10 * DYGN), new Date(b3.state.trialStart).toISOString());
kontrollera('3e: status expired (10 d > 2 d)', b3.status === 'expired', b3.status);

// Enhetsankaret: efter kontosynken ska telefonens EGNA rad bära den
// tidigaste kända starten — utan det hade merge-vägen varit död i skarp
// drift (ingen är någonsin utloggad där, så #syncUp skriver aldrig raden).
kontrollera('3f: enhetsankaret skrevs — telefonens egna rad bär den tidigaste starten',
  naraMs(Date.parse(server.rader['enhet-lokal-1'].trial_start), nu - 10 * DYGN),
  server.rader['enhet-lokal-1'].trial_start);

// Konto nummer två på samma telefon: servern har ingen egen historik om
// det, men ankaret finns — och ärvs. Receptet "kör slut på konto A,
// registrera konto B på samma telefon" ger alltså inga nya dagar.
localStorage.removeItem('pv.billing.v1');
server.tokens['jwt-C'] = 'uuid-konto-C';
const b3c = new Billing({ ...CFG, kontokrav: true });
b3c.state.trialStart = null;
b3c.setKonto('uuid-konto-C', 'jwt-C');
await new Promise(r => setTimeout(r, 10));
kontrollera('3g: konto nummer två på samma telefon ärver ankaret',
  naraMs(b3c.state.trialStart, nu - 10 * DYGN),
  b3c.state.trialStart ? new Date(b3c.state.trialStart).toISOString() : 'null');
kontrollera('3h: konto två är expired direkt — växelvisa konton på samma telefon stängt',
  b3c.status === 'expired', b3c.status);

/* =====================================================================
   PROV 4 — tvärtom: enhetens start är äldst och ärvs av kontot
   ===================================================================== */

localStorage.removeItem('pv.billing.v1');
server.rader['uuid-konto-B'] = { trial_start: iso(nu - 3_600_000), paid_until: null };   // 1 h
server.rader['enhet-lokal-1'] = { trial_start: iso(nu - 3 * DYGN), paid_until: null };   // 3 d
server.tokens['jwt-B'] = 'uuid-konto-B';

const b4 = new Billing({ ...CFG, kontokrav: true });
b4.state.trialStart = null;
b4.setKonto('uuid-konto-B', 'jwt-B');
await new Promise(r => setTimeout(r, 10));

kontrollera('4a: enhetens äldre start (3 d) ärvdes av kontot',
  naraMs(b4.state.trialStart, nu - 3 * DYGN), new Date(b4.state.trialStart).toISOString());
kontrollera('4b: serverraden för kontot bär nu den tidigaste starten',
  naraMs(Date.parse(server.rader['uuid-konto-B'].trial_start), nu - 3 * DYGN));
kontrollera('4c: status expired — evig-gratis-receptet är stängt', b4.status === 'expired', b4.status);

// Betald tid på kontot gäller på enheten (beslut 4), utan att läcka.
server.rader['uuid-konto-B'].paid_until = iso(nu + 30 * DYGN);
await b4.sync();
kontrollera('4d: kontots paid_until slår igenom vid nästa synk',
  naraMs(b4.state.paidUntil, nu + 30 * DYGN));
kontrollera('4e: status active med betalt konto', b4.status === 'active', b4.status);
kontrollera('4f: enhetsraden fick ALDRIG betald tid',
  server.rader['enhet-lokal-1'].paid_until === null);

/* =====================================================================
   PROV 5 — regression: utloggad enhet beter sig EXAKT som i dag
   ===================================================================== */

localStorage.removeItem('pv.billing.v1');
delete server.rader['enhet-lokal-1'];

const b5 = new Billing(CFG);   // precis som app.js skapar den: ingen kontokrav-flagga
kontrollera('5a: utan flagga gäller dagens 5 dagar', b5.provDagar === 5);

const mark5 = kallelser.length;
await b5.sync();
const anrop5 = kallelser.slice(mark5);
kontrollera('5b: exakt ett anrop, till get_subscription',
  anrop5.length === 1 && anrop5[0].path === '/rest/v1/rpc/get_subscription',
  anrop5.map(k => k.path).join(', '));
kontrollera('5c: nycklat på enhetens id', anrop5[0].body.p_device === 'enhet-lokal-1');
kontrollera('5d: kontovägen rördes aldrig',
  !anrop5.some(k => k.path === '/rest/v1/rpc/hamta_konto_prenumeration'));

// beginTrial: lokal start + uppskrivning, precis som i dag.
const mark5b = kallelser.length;
b5.beginTrial();
await new Promise(r => setTimeout(r, 10));
const upp = kallelser.slice(mark5b).find(k => k.path === '/rest/v1/subscribers');
kontrollera('5e: beginTrial skriver upp starten till subscribers', !!upp);
kontrollera('5f: uppskrivningen bär enhetens id och ISO-tid',
  upp && upp.body.device_id === 'enhet-lokal-1' && !Number.isNaN(Date.parse(upp.body.trial_start)));

// Serverns äldre start vinner över den lokala, precis som i dag.
server.rader['enhet-lokal-1'] = { trial_start: iso(nu - 4 * DYGN), paid_until: null };
await b5.sync();
kontrollera('5g: serverns äldre start (4 d) vann över den lokala',
  naraMs(b5.state.trialStart, nu - 4 * DYGN));
kontrollera('5h: 4 dagar gammal trial är fortfarande TRIAL med dagens 5-dagarsregel',
  b5.status === 'trial', b5.status);
kontrollera('5i: kassareferensen är enhetens id, oprefixad',
  kassareferens() === 'enhet-lokal-1', kassareferens());

/* =====================================================================
   PROV 6 — resetTrial rör inte serverns sanning
   ===================================================================== */

const fore = JSON.stringify(server.rader);
const mark6 = kallelser.length;
b5.resetTrial();
kontrollera('6a: resetTrial gjorde NOLL nätverksanrop', kallelser.length === mark6,
  String(kallelser.length - mark6));
kontrollera('6b: serverns rader är orörda', JSON.stringify(server.rader) === fore);
kontrollera('6c: lokalt nollställd', b5.state.trialStart === null && b5.state.paidUntil === null);
await b5.sync();
kontrollera('6d: nästa synk hämtar tillbaka serverns start — ingen ny gratisperiod',
  naraMs(b5.state.trialStart, nu - 4 * DYGN));

/* =====================================================================
   PROV 7 — kassareferensen med konto: 'konto-<uuid>'

   Bindestreck, aldrig kolon: Stripe Payment Links tillåter bara
   alfanumeriskt, bindestreck och understreck i client_reference_id och
   släpper ogiltiga värden TYST — 'konto:' hade gjort varje inloggat köp
   föräldralöst.
   ===================================================================== */

const b7 = new Billing({ ...CFG, paymentLink: 'https://buy.stripe.com/prov123', kontokrav: true });
b7.konto = 'uuid-konto-A';
const u7 = new URL(b7.checkoutUrl());
kontrollera('7a: inloggad med kontokrav: client_reference_id = konto-<uuid>',
  u7.searchParams.get('client_reference_id') === 'konto-uuid-konto-A',
  u7.searchParams.get('client_reference_id'));
kontrollera('7a2: referensen klarar Stripes teckenfilter (a-z, 0-9, - och _)',
  /^[A-Za-z0-9_-]+$/.test(u7.searchParams.get('client_reference_id')),
  u7.searchParams.get('client_reference_id'));

localStorage.setItem('pv.identity.v1', 'uuid-konto-A');   // som setIdentity gör vid inloggning
kontrollera('7b: kassareferens(true) läser identiteten som setIdentity satt',
  kassareferens(true) === 'konto-uuid-konto-A', kassareferens(true));
localStorage.removeItem('pv.identity.v1');
kontrollera('7c: utloggad (identiteten tömd): tillbaka till enhetens id',
  kassareferens(true) === 'enhet-lokal-1', kassareferens(true));

const b7b = new Billing({ ...CFG, paymentLink: 'https://buy.stripe.com/prov123' });   // dagens läge
const u7b = new URL(b7b.checkoutUrl());
kontrollera('7d: i dagens läge är referensen enhetens id, precis som förut',
  u7b.searchParams.get('client_reference_id') === 'enhet-lokal-1',
  u7b.searchParams.get('client_reference_id'));

/* =====================================================================
   PROV 8 — bryggan auth -> billing (pv:konto-händelsen)
   ===================================================================== */

// En session som låg sparad före "sidladdningen": konstruktorn ska meddela
// kontot via mikrotask, och billing (skapad efteråt, som i app.js) ska hinna
// få lyssnaren på plats innan händelsen skickas.
server.tokens['jwt-anna'] = 'uuid-anna';
server.rader['uuid-anna'] = { trial_start: iso(nu - 1 * DYGN), paid_until: null };
localStorage.setItem('pv.session.v1', JSON.stringify({
  access_token: 'jwt-anna', refresh_token: 'r1',
  expires_at: nu + 3_600_000, user: { id: 'uuid-anna', email: 'anna@prov.se' },
}));

const { Auth } = await import('../js/auth.js');
const b8 = new Billing({ ...CFG, kontokrav: true });   // lyssnaren först ...
const auth = new Auth();                               // ... sedan Auth — samma ordning har app.js inte, men mikrotasken jämnar ut det
await new Promise(r => setTimeout(r, 20));             // släpp fram mikrotasken och synken

kontrollera('8a: billing fick kontot från den sparade sessionen', b8.konto === 'uuid-anna', String(b8.konto));
kontrollera('8b: token följde med bryggan', b8.kontoToken === 'jwt-anna');
kontrollera('8c: synken gick kontovägen med rätt JWT',
  kallelser.some(k => k.path === '/rest/v1/rpc/hamta_konto_prenumeration' && k.auth === 'Bearer jwt-anna'));

// Utloggning: händelse med id null ska släppa kontonyckeln.
window.dispatchEvent(new CustomEvent('pv:konto', { detail: { id: null, token: null } }));
await new Promise(r => setTimeout(r, 10));
kontrollera('8d: utloggning släpper kontot i billing', b8.konto === null);

clearTimeout(auth.refreshTimer);   // annars håller förnyelsetimern processen vid liv

/* ---------- Summering ---------- */

console.log('');
console.log('==========================================');
console.log(`Godkända kontroller: ${antalOk}`);
console.log(`Underkända:          ${fel.length}`);
if (fel.length) {
  for (const f of fel) console.log('  - ' + f);
  process.exit(1);
}
console.log('Alla prov gick igenom.');
console.log('==========================================');
