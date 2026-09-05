// Polisvakt — Stripe-webhook (Supabase Edge Function, Deno)
//
// Enda vägen från "kunden betalade" till "appen släpper igenom". Klienten får
// aldrig sätta sin egen betalstatus — den läser bara get_subscription. All
// sanning om pengar kommer hit, signerad av Stripe.
//
// Kontraktet mot klienten, se js/billing.js -> checkoutUrl():
// betallänken öppnas med ?client_reference_id=<device_id>, där device_id är
// samma sträng som auth.uid() för inloggade. Det värdet är den enda kopplingen
// mellan en Stripe-betalning och en rad i subscribers, och det följer bara med
// på den FÖRSTA betalningen. Därför sparas Stripes kund-id direkt vid
// checkout, så att förnyelser ett år senare fortfarande hittar rätt rad.
//
// Deploy:
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// --no-verify-jwt är inte slarv. Stripe skickar ingen Supabase-JWT, och skulle
// aldrig kunna göra det. Autentiseringen sker istället genom signaturen i
// stripe-signature-huvudet, som verifieras mot webhookhemligheten nedan. Utan
// flaggan avvisar Supabase varje anrop med 401 innan koden ens körs, och
// Stripe-panelen fylls med röda leveranser.
//
// Hemligheter som måste sättas (supabase secrets set ...):
//   STRIPE_SECRET_KEY       sk_live_... eller sk_test_...
//   STRIPE_WEBHOOK_SECRET   whsec_... — en per endpoint, och test och live
//                           har OLIKA hemligheter
// SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY injiceras automatiskt av
// plattformen och ska inte sättas för hand.
//
// SQL som måste vara körd först: supabase/schema.sql, supabase/billing.sql
// och supabase/stripe.sql. Den sista är inte livsviktig för lyckoscenariot —
// den innehåller spärren som gör paid_until oskrivbar från klienten, samt
// prisuppslaget som räddar en betalning där metadata glömts i Stripe. Saknas
// den fungerar betalningarna ändå, men reservvägen är borta och skyddet vilar
// enbart på rättigheterna i billing.sql.

import Stripe from 'npm:stripe@^22';

/* ========================== KONFIGURATION =========================== */

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';

/**
 * Respit efter att perioden tekniskt löpt ut.
 *
 * Stripe drar kortet på förfallodagen, men fakturan kan ta timmar att gå
 * igenom, och webhooken kan komma efter det. Utan respit får en betalande
 * kund betalväggen i ansiktet mitt på motorvägen medan pengarna är på väg.
 * Ett dygn kostar oss ingenting och tar bort hela den klassen av supportärenden.
 */
const RESPIT_TIMMAR = 24;

/** Statusar där prenumerationen ska ge tillgång. */
const AKTIVA_STATUSAR = new Set(['active', 'trialing', 'past_due']);

/* ============================== KLIENTER ============================ */

// createFetchHttpClient: Deno har ingen Node-http att låna, Stripe-biblioteket
// måste peka om sig till fetch.
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  httpClient: Stripe.createFetchHttpClient(),
});

// Signaturverifieringen måste gå via Web Crypto i Deno. Den synkrona
// constructEvent() använder Nodes crypto och kastar här — det är därför all
// verifiering nedan är constructEventAsync med den här providern.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

/**
 * Anropa en databasfunktion med service role-nyckeln.
 *
 * Service role, aldrig anon: funktionerna i supabase/billing.sql har
 * uttryckligen fått EXECUTE indraget från anon och authenticated, just för
 * att ingen ska kunna skriva sin egen betalstatus. Skulle den här nyckeln
 * någonsin läcka ut i klientkod är hela databasen öppen.
 */
async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`rpc ${fn} gav ${r.status}: ${text}`);
  if (!text) return null;              // void-funktioner svarar 204 utan kropp
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

/* ============================== HJÄLPARE ============================ */

/**
 * När tar den betalda perioden slut?
 *
 * Stripe flyttade current_period_end från prenumerationen till varje rad i
 * items i API-version 2025-03-31.basil. Vilken form som kommer hit beror på
 * vilken API-version endpointen är inställd på i Stripe-panelen, inte på
 * vilken version SDK:n är byggd för — så båda formerna måste hanteras.
 * Läser man bara den gamla får man undefined och sätter paid_until till
 * 1970, vilket i praktiken stänger av varje betalande kund.
 */
function periodSlut(sub: Stripe.Subscription): number | null {
  const rader = (sub.items?.data ?? []) as Array<{ current_period_end?: number }>;
  const slut = rader
    .map((r) => r.current_period_end)
    .filter((n): n is number => typeof n === 'number');
  // max: kunden har betalt så länge något i prenumerationen är betalt.
  if (slut.length) return Math.max(...slut);
  const gammalt = (sub as unknown as { current_period_end?: number }).current_period_end;
  return typeof gammalt === 'number' ? gammalt : null;
}

/**
 * Vilken prenumeration hör fakturan till?
 *
 * Samma versionsproblem som ovan: invoice.subscription flyttade till
 * invoice.parent.subscription_details.subscription i Basil.
 */
function fakturansPrenumeration(inv: Stripe.Invoice): string | null {
  const i = inv as unknown as {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
    subscription?: string | { id: string };
  };
  const v = i.parent?.subscription_details?.subscription ?? i.subscription;
  if (!v) return null;
  return typeof v === 'string' ? v : v.id;
}

/** Unix-sekunder + respit -> ISO-sträng som Postgres förstår. */
function tillISO(unixSek: number, respit = true): string {
  const ms = unixSek * 1000 + (respit ? RESPIT_TIMMAR * 3600_000 : 0);
  return new Date(ms).toISOString();
}

function kundId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id;
}

/**
 * Vilken nivå gäller? Läses ur metadata på priset, med produkten som reserv.
 *
 * Nivån (bas/plus/pro) styr vad appen släpper på — dashcamlängd,
 * bevakningsområde, historik. Sätts metadata inte i Stripe blir fältet null
 * och appen får falla tillbaka på Bas. Se docs/BETALNING.md.
 */
function planFranMetadata(pris?: Stripe.Price | null): string | null {
  const p = pris?.metadata?.plan;
  const prod = typeof pris?.product === 'object' ? (pris.product as Stripe.Product) : null;
  return p || prod?.metadata?.plan || null;
}

/** Antal månader för ett engångsköp (förskottet). Aldrig gissat. */
function manaderFranMetadata(pris?: Stripe.Price | null): number | null {
  const prod = typeof pris?.product === 'object' ? (pris.product as Stripe.Product) : null;
  const rått = pris?.metadata?.manader ?? prod?.metadata?.manader;
  const n = Number(rått);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Reservvägen: slå upp nivå och månader på beloppet istället för på metadata.
 *
 * Metadata är huvudvägen och sätts för hand på sex priser i Stripe-panelen.
 * Handpåsatt metadata på sex ställen glöms förr eller senare bort på ett av
 * dem. Utan reserv blir följden att kunden betalar, Stripe är nöjd, och vi
 * skriver 'orphan' i loggen — kunden får ingenting och märker det först när
 * appen låser sig.
 *
 * Beloppen i tabellen stripe_price_map är de sex i js/plans.js och alla olika,
 * så uppslaget är exakt och inte en gissning. Matchar inget belopp returneras
 * tomt, och då blir det orphan som förut. Se supabase/stripe.sql.
 */
async function planFranBelopp(
  belopp: number | null | undefined,
  valuta: string | null | undefined,
): Promise<{ plan: string | null; manader: number | null }> {
  if (typeof belopp !== 'number' || belopp <= 0) return { plan: null, manader: null };
  try {
    const rader = await rpc<Array<{ plan: string; months: number | null }>>(
      'stripe_plan_for_amount', { p_amount: belopp, p_currency: valuta ?? 'sek' },
    );
    const rad = Array.isArray(rader) ? rader[0] : null;
    return { plan: rad?.plan ?? null, manader: rad?.months ?? null };
  } catch (e) {
    // Uppslaget är en reserv, inte ett krav. Att kasta här hade gjort ett
    // saknat prisuppslag till ett fel i en betalning som annars gått bra.
    console.error('prisuppslag på belopp misslyckades:', (e as Error).message);
    return { plan: null, manader: null };
  }
}

/** Resultatet av en hanterad händelse — det som skrivs till revisionsloggen. */
type Utfall = {
  status: 'processed' | 'orphan' | 'ignored';
  device?: string | null;
  customer?: string | null;
  sub?: string | null;
  amount?: number | null;
  currency?: string | null;
  paidUntil?: string | null;
  error?: string | null;
};

/* =========================== HÄNDELSER ============================== */

/**
 * Första betalningen. Enda tillfället client_reference_id finns med.
 */
async function hanteraCheckout(session: Stripe.Checkout.Session): Promise<Utfall> {
  const device = session.client_reference_id;
  const customer = kundId(session.customer);
  const epost = session.customer_details?.email ?? session.customer_email ?? null;

  if (!device) {
    // Betalningen är genomförd men vi vet inte vems den är. Att svara 4xx
    // hade fått Stripe att skicka om i tre dygn utan att något blir bättre —
    // ett saknat client_reference_id kommer inte att dyka upp av sig självt.
    // Istället kvitteras händelsen och märks 'orphan', så den syns i vyn
    // payment_problems och kan kopplas för hand. Se docs/BETALNING.md.
    return {
      status: 'orphan', customer,
      error: 'checkout utan client_reference_id — betallänken saknar URL-parametern',
    };
  }

  // Kopplingen först, alltid. Går resten fel kan förnyelser fortfarande
  // hitta hem, och en session som kommer om igen gör samma sak.
  await rpc('link_stripe_customer', { p_device: device, p_customer: customer, p_email: epost });

  /**
   * Är pengarna faktiskt betalda?
   *
   * checkout.session.completed betyder "kunden gick igenom kassan", inte
   * "betalningen är klar". För fördröjda betalmetoder — Klarna, banköverföring
   * och flera av de EU-metoder som ligger nära till hands för en svensk app —
   * är payment_status 'unpaid' här, och pengarna kan utebli helt.
   *
   * Ger vi tillgång nu blir det gratis prenumeration åt var och en som väljer
   * en fördröjd metod och sedan låter bli att betala. Vi väntar istället på
   * checkout.session.async_payment_succeeded, som kommer med samma session och
   * går genom exakt den här funktionen igen — då med payment_status 'paid'.
   *
   * Kopplingen ovan görs ändå, före returen: den är alltid rätt att spara, och
   * betalar kunden en timme senare måste kund-id:t redan sitta på plats.
   */
  if (session.payment_status === 'unpaid') {
    return {
      status: 'ignored', device, customer,
      error: 'kassan genomförd men ännu obetald (fördröjd betalmetod) — '
           + 'tillgång ges när async_payment_succeeded kommer',
    };
  }

  /**
   * Hämtar om sessionen: webhookens kopia saknar line_items, och där ligger
   * metadata som avgör nivå och antal månader.
   *
   * Anropet kan misslyckas — begränsad API-nyckel, Stripe som svarar långsamt,
   * nätet. Det får inte fälla hela betalningen, för då hamnar vi i en
   * omsändningsloop på något som kanske aldrig går att läsa. Misslyckas det
   * går vi vidare på beloppet istället.
   */
  let pris: Stripe.Price | null = null;
  let anmarkning: string | null = null;
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price.product'],
    });
    pris = full.line_items?.data?.[0]?.price ?? null;
  } catch (e) {
    anmarkning = `line_items kunde inte hämtas (${(e as Error).message}) — föll tillbaka på beloppet`;
    console.error(anmarkning);
  }

  let plan = planFranMetadata(pris);
  let manader = manaderFranMetadata(pris);

  // Reservvägen. Bara när metadata faktiskt saknas — metadata vinner alltid,
  // eftersom den är satt med avsikt och beloppet bara är en indikation.
  if (!plan || (session.mode === 'payment' && !manader)) {
    const reserv = await planFranBelopp(session.amount_total, session.currency);
    const harlett: string[] = [];
    if (!plan && reserv.plan) { plan = reserv.plan; harlett.push(`nivå ${plan}`); }
    if (!manader && reserv.manader) { manader = reserv.manader; harlett.push(`${manader} mån`); }
    if (harlett.length) {
      // Loggas som fel trots att betalningen räddades: det ÄR ett fel i
      // Stripe-panelen, och det syns ingen annanstans förrän nästa gång
      // beloppet ändras och reserven slutar stämma.
      anmarkning = `metadata saknas på priset — ${harlett.join(' och ')} härledd ur beloppet`;
      console.error(`${anmarkning} (${session.id}) — sätt metadata i Stripe`);
    }
  }

  if (session.mode === 'subscription') {
    const subId = kundId(session.subscription);
    if (!subId) return { status: 'orphan', device, customer, error: 'prenumeration saknas i sessionen' };

    const sub = await stripe.subscriptions.retrieve(subId);

    // 'incomplete' betyder att första dragningen inte gick igenom. Statusen
    // noteras, men tillgång ges inte förrän den blir aktiv — vilket i så fall
    // kommer som customer.subscription.updated.
    if (!AKTIVA_STATUSAR.has(sub.status)) {
      await rpc('set_sub_status', { p_device: device, p_status: sub.status });
      return {
        status: 'processed', device, customer, sub: subId,
        error: `prenumerationen är ${sub.status} — ingen tillgång ännu`,
      };
    }

    const slut = periodSlut(sub);
    if (!slut) return { status: 'orphan', device, customer, sub: subId, error: 'kunde inte läsa periodslut' };

    const until = await rpc<string>('set_paid_until', {
      p_device: device, p_until: tillISO(slut), p_plan: plan,
      p_sub: subId, p_status: sub.status, p_mode: 'forlang',
    });
    // Beloppet lämnas medvetet tomt: samma pengar kommer strax som
    // invoice.paid, och räknas de på båda ställena blir intäktsvyn dubbel.
    return { status: 'processed', device, customer, sub: subId, paidUntil: until, error: anmarkning };
  }

  if (session.mode === 'payment') {
    // Förskottet på sex månader — engångsköp, ingen prenumeration, alltså
    // ingen period att läsa av. Antalet måste komma från metadata eller från
    // prisuppslaget; gissas det får kunden fel tid, och fel åt något håll är
    // värre än ett ärligt fel i loggen.
    if (!manader) {
      return {
        status: 'orphan', device, customer,
        amount: session.amount_total, currency: session.currency,
        error: 'engångsköp utan metadata "manader" på priset, och beloppet '
             + `${session.amount_total} ${session.currency} finns inte i stripe_price_map`,
      };
    }
    const until = await rpc<string>('add_paid_months', {
      p_device: device, p_months: manader, p_plan: plan,
    });
    return {
      status: 'processed', device, customer, paidUntil: until, error: anmarkning,
      amount: session.amount_total, currency: session.currency,
    };
  }

  return { status: 'ignored', device, customer, error: `okänt läge: ${session.mode}` };
}

/**
 * Prenumerationen ändrades: nivåbyte, uppsägning i förväg, betalning som
 * kom ikapp. Här finns inget client_reference_id — kopplingen måste redan
 * finnas.
 */
async function hanteraSubUppdatering(sub: Stripe.Subscription): Promise<Utfall> {
  const customer = kundId(sub.customer);
  const device = customer
    ? await rpc<string>('device_for_stripe_customer', { p_customer: customer })
    : null;

  if (!device) {
    return { status: 'orphan', customer, sub: sub.id, error: 'ingen enhet kopplad till kunden' };
  }

  const plan = planFranMetadata(sub.items?.data?.[0]?.price ?? null);

  if (!AKTIVA_STATUSAR.has(sub.status)) {
    // canceled, unpaid, incomplete_expired: Stripe har gett upp. Statusen
    // noteras men paid_until rörs inte här — den riktiga sluttiden kommer
    // med customer.subscription.deleted, och att stänga av i förtid på en
    // status som kan gå tillbaka är värre än att släppa igenom ett dygn för
    // mycket.
    await rpc('set_sub_status', { p_device: device, p_status: sub.status });
    return { status: 'processed', device, customer, sub: sub.id };
  }

  const slut = periodSlut(sub);
  if (!slut) return { status: 'orphan', device, customer, sub: sub.id, error: 'kunde inte läsa periodslut' };

  const until = await rpc<string>('set_paid_until', {
    p_device: device, p_until: tillISO(slut), p_plan: plan,
    p_sub: sub.id, p_status: sub.status, p_mode: 'forlang',
  });
  return { status: 'processed', device, customer, sub: sub.id, paidUntil: until };
}

/**
 * Prenumerationen är avslutad.
 *
 * Läge 'exakt', inte 'forlang': det här är enda gången paid_until får flyttas
 * bakåt. Säger kunden upp i förväg löper den ut vid periodens slut, och då
 * är ended_at just det datumet — kunden behåller det hen betalat för.
 * Avslutas den direkt är ended_at nu, och tillgången tas bort direkt.
 *
 * Ingen respit här. Respiten finns för att pengar är på väg; är
 * prenumerationen uppsagd är de inte det.
 */
async function hanteraSubBorttagen(sub: Stripe.Subscription): Promise<Utfall> {
  const customer = kundId(sub.customer);
  const device = customer
    ? await rpc<string>('device_for_stripe_customer', { p_customer: customer })
    : null;

  if (!device) {
    return { status: 'orphan', customer, sub: sub.id, error: 'ingen enhet kopplad till kunden' };
  }

  const slut = sub.ended_at ?? sub.canceled_at ?? Math.floor(Date.now() / 1000);
  const until = await rpc<string>('set_paid_until', {
    p_device: device, p_until: tillISO(slut, false), p_plan: null,
    p_sub: sub.id, p_status: 'canceled', p_mode: 'exakt',
  });
  return { status: 'processed', device, customer, sub: sub.id, paidUntil: until };
}

/**
 * Förnyelse betald. Den händelse som håller kunder igång månad efter månad,
 * och därmed den som absolut inte får misslyckas tyst.
 */
async function hanteraFakturaBetald(inv: Stripe.Invoice): Promise<Utfall> {
  const customer = kundId(inv.customer);
  const subId = fakturansPrenumeration(inv);

  if (!subId) {
    // Faktura utan prenumeration — engångsköp faktureras normalt inte så,
    // men om det händer finns det inget att förnya.
    return { status: 'ignored', customer, error: 'faktura utan prenumeration' };
  }

  const device = customer
    ? await rpc<string>('device_for_stripe_customer', { p_customer: customer })
    : null;
  if (!device) {
    return { status: 'orphan', customer, sub: subId, error: 'ingen enhet kopplad till kunden' };
  }

  const sub = await stripe.subscriptions.retrieve(subId);
  const slut = periodSlut(sub);
  if (!slut) return { status: 'orphan', device, customer, sub: subId, error: 'kunde inte läsa periodslut' };

  // Nivån får aldrig fällas tillbaka till null vid en förnyelse. set_paid_until
  // behåller visserligen den gamla nivån när p_plan är null, men saknas den
  // också där hamnar kunden på Bas trots att han betalar för Pro. Beloppet på
  // fakturan är samma sex belopp som vid köpet, så uppslaget håller.
  let plan = planFranMetadata(sub.items?.data?.[0]?.price ?? null);
  if (!plan) plan = (await planFranBelopp(inv.amount_paid, inv.currency)).plan;

  const until = await rpc<string>('set_paid_until', {
    p_device: device, p_until: tillISO(slut), p_plan: plan,
    p_sub: subId, p_status: sub.status, p_mode: 'forlang',
  });
  return {
    status: 'processed', device, customer, sub: subId, paidUntil: until,
    amount: inv.amount_paid, currency: inv.currency,
  };
}

/**
 * Kortet gick inte igenom.
 *
 * Tillgången dras INTE in här, med flit. Stripe försöker om enligt sin
 * dunning-inställning i upp till ett par veckor, och de allra flesta fall
 * löser sig med ett nytt försök eller ett uppdaterat kort. paid_until har
 * redan ett slutdatum — går tiden ut utan betalning stängs appen av av sig
 * själv, utan att vi behöver göra något. Att kapa direkt hade straffat
 * kunder vars kort råkade förnyas den veckan.
 */
async function hanteraFakturaMisslyckad(inv: Stripe.Invoice): Promise<Utfall> {
  const customer = kundId(inv.customer);
  const device = customer
    ? await rpc<string>('device_for_stripe_customer', { p_customer: customer })
    : null;

  if (device) await rpc('set_sub_status', { p_device: device, p_status: 'past_due' });

  return {
    status: 'processed', device, customer, sub: fakturansPrenumeration(inv),
    amount: inv.amount_due, currency: inv.currency,
    error: 'betalning misslyckades — Stripe försöker om, tillgången löper ut av sig själv',
  };
}

/**
 * Tvist. Ingen tillgång dras in — loggas bara, så att hela betalhistoriken
 * för kunden går att plocka fram ur payment_events när bevisen ska skickas in.
 * Debiteringen kommer normalt som id-sträng och måste hämtas för att kunden
 * ska gå att spåra.
 */
async function hanteraTvist(d: Stripe.Dispute): Promise<Utfall> {
  let customer: string | null = null;
  try {
    const charge = typeof d.charge === 'string'
      ? await stripe.charges.retrieve(d.charge)
      : (d.charge as Stripe.Charge);
    customer = kundId(charge?.customer);
  } catch { /* debiteringen gick inte att hämta — tvisten loggas ändå */ }

  const device = customer
    ? await rpc<string>('device_for_stripe_customer', { p_customer: customer })
    : null;
  return {
    status: 'processed', device, customer,
    amount: d.amount, currency: d.currency,
    error: `tvist inledd (${d.reason}) — svara i Stripe-panelen före deadline`,
  };
}

/* ============================== SERVERN ============================= */

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Endast POST', { status: 405 });
  }

  // Felkonfiguration ska ge 500, inte tyst 200. En grön leverans i Stripe
  // som inte skrivit någonting i databasen är det värsta som kan hända här:
  // kunden har betalat, ingen får veta, och Stripe skickar aldrig om.
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_ROLE) {
    console.error('Saknade miljövariabler — kolla supabase secrets list');
    return new Response('Servern är inte konfigurerad', { status: 500 });
  }

  const signatur = req.headers.get('stripe-signature');
  if (!signatur) return new Response('stripe-signature saknas', { status: 400 });

  // Rå text, inte req.json(). Signaturen räknas på exakta byte — går kroppen
  // genom en JSON-tolkning och tillbaka stämmer den aldrig.
  const rått = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rått, signatur, STRIPE_WEBHOOK_SECRET, undefined, cryptoProvider,
    );
  } catch (e) {
    // 400: signaturen är fel eller för gammal. Att svara 500 hade fått
    // Stripe att skicka om i tre dygn på något som aldrig kan bli rätt.
    // Vanligaste orsaken är fel whsec — test och live har olika.
    console.error('Signaturen gick inte att verifiera:', (e as Error).message);
    return new Response(`Ogiltig signatur: ${(e as Error).message}`, { status: 400 });
  }

  // Från och med här är händelsen bevisligen från Stripe och får loggas.
  let bokad: boolean | null = null;
  try {
    bokad = await rpc<boolean>('claim_payment_event', {
      p_event_id: event.id, p_type: event.type, p_payload: event,
    });
  } catch (e) {
    console.error('Kunde inte boka händelsen:', (e as Error).message);
    return new Response('Databasen svarar inte', { status: 500 });
  }

  if (bokad === null || bokad === undefined) {
    // Tomt svar från claim_payment_event (t.ex. 204/void efter en signatur-
    // eller schemaändring) gjorde förr `!bokad` sant → VARJE händelse
    // kvitterades 200 som "dubblett" och behandlades aldrig: tyst total
    // betalningsförlust med gröna leveranser i Stripe. Ett tomt svar är ett
    // fel — 500 så Stripe skickar om, inte en kvittens.
    console.error('claim_payment_event gav tomt svar — bokar INTE som dubblett.');
    return new Response('Bokningen gav tomt svar', { status: 500 });
  }
  if (bokad === false) {
    // Redan hanterad. 200, annars fortsätter Stripe skicka om.
    return new Response(JSON.stringify({ ok: true, dubblett: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let utfall: Utfall;
    switch (event.type) {
      case 'checkout.session.completed':
      // Fördröjda betalmetoder (Klarna, banköverföring) kvitterar först här,
      // ibland timmar senare. Samma session, samma hantering — men nu med
      // payment_status 'paid', vilket är det som faktiskt släpper på tillgången.
      case 'checkout.session.async_payment_succeeded':
        utfall = await hanteraCheckout(event.data.object as Stripe.Checkout.Session);
        break;

      case 'checkout.session.async_payment_failed': {
        // Pengarna kom aldrig. Ingen tillgång har getts (se payment_status-
        // kontrollen i hanteraCheckout), så det finns inget att dra tillbaka —
        // men det ska synas i loggen att någon försökte och misslyckades.
        const s = event.data.object as Stripe.Checkout.Session;
        utfall = {
          status: 'processed',
          device: s.client_reference_id, customer: kundId(s.customer),
          amount: s.amount_total, currency: s.currency,
          error: 'fördröjd betalning misslyckades — ingen tillgång gavs',
        };
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        utfall = await hanteraSubUppdatering(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        utfall = await hanteraSubBorttagen(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.paid':
        utfall = await hanteraFakturaBetald(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        utfall = await hanteraFakturaMisslyckad(event.data.object as Stripe.Invoice);
        break;
      case 'charge.dispute.created':
        utfall = await hanteraTvist(event.data.object as Stripe.Dispute);
        break;
      default:
        utfall = { status: 'ignored' };
    }

    await rpc('finish_payment_event', {
      p_event_id: event.id,
      p_status: utfall.status,
      p_device: utfall.device ?? null,
      p_customer: utfall.customer ?? null,
      p_sub: utfall.sub ?? null,
      p_amount: utfall.amount ?? null,
      p_currency: utfall.currency ?? null,
      p_paid_until: utfall.paidUntil ?? null,
      p_error: utfall.error ?? null,
    });

    if (utfall.status === 'orphan') {
      // Kvitteras med 200 — omsändning löser inget — men skriks ut i loggen
      // och hamnar i vyn payment_problems.
      console.error(`FÖRÄLDRALÖS ${event.type} ${event.id}: ${utfall.error}`);
    }

    return new Response(JSON.stringify({ ok: true, status: utfall.status }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error(`FEL i ${event.type} ${event.id}:`, msg);

    // Märk raden som error innan vi ger upp, annars kan claim_payment_event
    // inte släppa igenom omsändningen förrän femminutersfönstret gått ut.
    try {
      await rpc('finish_payment_event', {
        p_event_id: event.id, p_status: 'error', p_error: msg,
      });
    } catch { /* databasen är nere — Stripe skickar om ändå */ }

    // 500 med flit: händelsen ska bli röd i Stripe-panelen och skickas om.
    // Nästan alla fel här är tillfälliga (databasen nere, Stripe-API långsamt),
    // och nästa försök lyckas.
    return new Response(`Fel vid hantering: ${msg}`, { status: 500 });
  }
});
