// Prisnivåer och tillbehör.
//
// Om argumentet mot kunden: frestelsen är att sälja "slipp böter". Vi gör det
// inte, av två skäl. Det är ett löfte vi inte kan hålla — appen vet inte var
// varenda kontroll står. Och det säljer fel beteende.
//
// Det starkare argumentet är detsamma i kronor men ärligt: den som håller
// hastigheten får aldrig boten från början. Appen påminner dig om gränsen på
// vägen du kör på, varnar för kameror i tid och säger till när du ligger över.
// Räknestycket står för sig självt.

export const CURRENCY = 'kr';

/** Vad en fortkörningsbot faktiskt kostar. Källa: polisens ordningsbotskatalog. */
export const FINE_EXAMPLES = [
  { over: '1–10 km/h över', cost: 1500 },
  { over: '11–15 km/h över', cost: 2000 },
  { over: '16–20 km/h över', cost: 2400 },
  { over: '21–25 km/h över', cost: 2800 },
  { over: '26–30 km/h över', cost: 3200 },
  { over: 'över 30 km/h', cost: 4000, note: 'och körkortet kan ryka' },
];

export const PLANS = [
  {
    id: 'bas',
    name: 'Bas',
    price: 99,
    tagline: 'Allt du behöver för att hålla hastigheten.',
    features: [
      'Röstvarningar för fartkameror, polis och kontroller',
      'Hastighetsgräns för vägen du kör på',
      'Varning när du ligger över gränsen',
      'Röststyrd rapportering',
      'Dashcam med 20 minuters buffert',
      'Bevakning inom vald radie',
    ],
    perks: { dashcamMinutes: 20, coverage: 'radius', history: false, accessoryDiscount: 10 },
  },
  {
    id: 'plus',
    name: 'Plus',
    price: 149,
    tagline: 'För dig som kör varje dag.',
    popular: true,
    features: [
      'Allt i Bas',
      'Dashcam utan tidsgräns',
      'Bevakning i hela Västmanland',
      'Historik och mönster — var polisen brukar stå',
      'Varningar längs hela din rutt',
      '25 % rabatt på tillbehör',
    ],
    perks: { dashcamMinutes: 0, coverage: 'county', history: true, accessoryDiscount: 25 },
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 199,
    tagline: 'För yrkesförare och den som kör långt.',
    features: [
      'Allt i Plus',
      'Bevakning i flera län',
      'Molnlagring av sparade händelser',
      'Prioriterad support',
      '50 % rabatt på tillbehör',
    ],
    perks: { dashcamMinutes: 0, coverage: 'multi', history: true, accessoryDiscount: 50, cloud: true },
  },
];

/** Sex månader i förskott. Binder över trafikveckorna och ger MRR. */
export const PREPAY = {
  months: 6,
  discountPercent: 20,
  extra: 'Halva priset på alla tillbehör så länge prenumerationen löper.',
};

export const priceFor = (plan, prepay = false) =>
  prepay
    ? Math.round(plan.price * PREPAY.months * (1 - PREPAY.discountPercent / 100))
    : plan.price;

/** Vad kostar ett år, och hur står det sig mot en enda bot? */
export function yearlyComparison(plan) {
  const year = plan.price * 12;
  const cheapestFine = FINE_EXAMPLES[0].cost;
  return {
    year,
    cheapestFine,
    breakEvenMonths: Math.ceil(cheapestFine / plan.price),
    line: `${year} kr om året. En enda bot på ${cheapestFine} kr motsvarar ${Math.ceil(cheapestFine / plan.price)} månader.`,
  };
}

/* ---------------- Tillbehör ---------------- */

/**
 * Produkterna. Priser är satta men lagret finns inte än, så knappen registrerar
 * intresse istället för att ta betalt. Det är med flit: vi vill veta hur många
 * som faktiskt vill ha en hållare innan vi beställer femhundra från Kina.
 */
export const PRODUCTS = [
  {
    id: 'holder',
    name: 'Polisvakt Mobilhållare',
    price: 299,
    tagline: 'Håller telefonen så bakkameran filmar rakt fram.',
    body: 'Magnetfäste, så inget täcker linsen. Styv arm som lyfter telefonen upp mot vindrutan — ' +
          'det är skillnaden mellan en dashcam som filmar vägen och en som filmar motorhuven. ' +
          'Fästs på instrumentbrädan med 3M-platta som håller även i vinterkyla.',
    status: 'coming',
    icon: '📱',
  },
  {
    id: 'mat',
    name: 'Antireflexmatta',
    price: 99,
    tagline: 'Tar bort spegling i vindrutan.',
    body: 'Mörk matta som läggs under hållaren. Utan den speglar sig instrumentbrädan i rutan ' +
          'och lägger sig som en dimma över nattbilden — precis när dashcammen behövs som mest.',
    status: 'coming',
    icon: '⬛',
  },
  {
    id: 'scent',
    name: 'Bildoft',
    price: 129,
    tagline: 'Ventilklämma med utbytbar doftplatta.',
    body: 'Diskret klämma på ventilationen. Doftplattan byts när den tar slut.',
    status: 'idea',
    icon: '🌿',
  },
  {
    id: 'sticker',
    name: 'Klistermärken',
    price: 49,
    tagline: 'Tre stycken i förpackningen.',
    body: 'Följer med gratis vid köp av hållare.',
    status: 'idea',
    icon: '✨',
  },
];

export const STATUS_LABEL = {
  coming: 'Kommer snart',
  idea: 'På idéstadiet',
  live: 'Kan beställas',
};
