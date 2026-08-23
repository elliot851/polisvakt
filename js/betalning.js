// Betallänkar till Stripe — en per nivå och betalperiod.
//
// VARFÖR DEN HÄR FILEN FINNS
//
// js/config.js har ett enda fält, stripePaymentLink, och js/billing.js har en
// enda checkoutUrl(). Det räckte när priset var ett. Nu finns sex kombinationer
// — Bas/Plus/Pro gånger månad/halvår, se PLANS och PREPAY i js/plans.js — och
// varje kombination är sin egen betallänk i Stripe, eftersom en betallänk är
// bunden till exakt ett pris.
//
// Länkarna måste alltså bo någonstans, och de måste kompletteras med
// client_reference_id innan de öppnas. Utan den parametern kan webhooken inte
// veta vems betalningen är: den skriver 'orphan' i payment_events, kunden har
// betalat och får ingenting, och det måste lagas för hand. Det är den enda
// riktigt dyra felkällan i hela betalningskedjan, och den beror på en
// URL-parameter som är lätt att tappa. Därför ligger den i en funktion här
// istället för att skrivas ihop på anropsstället.
//
// INKOPPLAD, MEN LÄNKARNA ÄR TOMMA
//
// js/app.js importerar modulen (subscribe-knappen provar checkoutUrl() här
// först och faller tillbaka på billing.checkoutUrl()). Så länge PAYMENT_LINKS
// nedan är tomma returnerar den null och den gamla vägen med en enda länk i
// CONFIG.stripePaymentLink gäller. Fyll i länkarna enligt docs/BETALNING.md
// avsnitt 3 så tar de sex över, utan kodändring någon annanstans.

import { PLANS, PREPAY, priceFor } from './plans.js';
// kassareferens ersätter deviceId här: den ger 'konto-<uuid>' för inloggade
// när kontokravet är aktivt (js/billing.js, KONTOKRAV_AKTIVT) och enhetens
// id i alla andra fall — alltså exakt dagens beteende tills flaggan flippas.
import { kassareferens } from './billing.js';

/**
 * De sex länkarna. Klistras in av ägaren efter att betallänkarna skapats i
 * Stripe — se docs/BETALNING.md avsnitt 3.
 *
 * manad  = månadsprenumeration, dras om automatiskt
 * halvar = sex månader i förskott, engångsköp utan automatisk förnyelse
 *
 * Nycklarna måste stavas exakt som id i PLANS (js/plans.js). Stavfel fångas av
 * kontrollen längst ner i filen, som skriker i konsolen istället för att låta
 * en knapp gå död i tysthet.
 */
export const PAYMENT_LINKS = {
  bas:  { manad: '', halvar: '' },
  plus: { manad: '', halvar: '' },
  pro:  { manad: '', halvar: '' },
};

/** Är en sträng en betallänk från Stripe, och inte något annat klistrat fel? */
function giltigLank(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    // Stripes betallänkar ligger på buy.stripe.com. Egen domän går att sätta
    // upp i Stripe, så en främmande värd avvisas inte — men http gör det.
    // En betallänk över http hade skickat kunden till en sida där kortdata
    // kan avlyssnas, och det ska aldrig gå att råka klistra in.
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Är länken en testlänk? buy.stripe.com/test_... används bara i testläge. */
export function arTestlank(url) {
  return typeof url === 'string' && /\/test_/.test(url);
}

/**
 * Rå betallänk för en nivå och period, utan parametrar. Null om den inte är
 * ifylld — anroparen ska visa ett begripligt besked, inte öppna en tom flik.
 */
export function paymentLink(planId, prepay = false) {
  const rad = PAYMENT_LINKS[planId];
  if (!rad) return null;
  const url = prepay ? rad.halvar : rad.manad;
  return giltigLank(url) ? url : null;
}

/**
 * Färdig kassaadress att öppna.
 *
 * client_reference_id är kassareferensen: enhetens id för utloggade (samma
 * sträng som skickas till get_subscription), 'konto-<uuid>' för inloggade
 * när kontokravet är aktivt. Den följer med
 * betalningen hela vägen till webhooken, som använder den för att hitta rätt
 * rad i subscribers och sedan sparar Stripes kund-id där. Efter den första
 * betalningen finns parametern inte med i något Stripe skickar; kopplingen
 * lever vidare enbart genom kund-id:t. Går det förlorat slutar förnyelser
 * fungera tyst.
 *
 * @param {string} planId       'bas' | 'plus' | 'pro'
 * @param {{prepay?:boolean, email?:string|null}} val
 * @returns {string|null} adressen, eller null om länken saknas
 */
export function checkoutUrl(planId, val = {}) {
  const bas = paymentLink(planId, !!val.prepay);
  if (!bas) return null;

  // 'konto-<uuid>' för inloggade med aktivt kontokrav — då gäller köpet på
  // alla kontots enheter. Annars enhetens id, precis som i dag. Webhooken
  // skickar strängen orörd till databasfunktionerna, som skalar prefixet
  // (se supabase/migrationer/2026-08-23-provperiod-pa-kontot.sql).
  // Bindestreck i prefixet, aldrig kolon: Stripe släpper tyst varje
  // client_reference_id med otillåtna tecken — se kassareferens i billing.js.
  const referens = kassareferens();
  if (!referens) return null;   // utan referens blir betalningen föräldralös — öppna inte

  const u = new URL(bas);
  u.searchParams.set('client_reference_id', referens);

  // Förifylld e-post sparar kunden ett fält och ger oss en adress att söka på
  // när något ska lagas för hand. Stripe ignorerar parametern om betallänken
  // är inställd på att inte samla in e-post, så den är alltid ofarlig.
  if (val.email) u.searchParams.set('prefilled_email', val.email);

  return u.toString();
}

/**
 * Vad knappen ska heta. Priset i knapptexten är inte kosmetik: vid distansavtal
 * ska det framgå att beställningen medför betalningsskyldighet, och "Fortsätt"
 * gör inte det. Se docs/BETALNING.md avsnittet om konsumentlagstiftning.
 */
export function knappText(planId, prepay = false) {
  const plan = PLANS.find(p => p.id === planId);
  if (!plan) return 'Betala';
  return prepay
    ? `Betala ${priceFor(plan, true)} kr för ${PREPAY.months} månader`
    : `Betala ${plan.price} kr/mån`;
}

/** Vilka av de sex rutorna är fortfarande tomma? Tom lista = allt ifyllt. */
export function saknadeLankar() {
  const saknas = [];
  for (const plan of PLANS) {
    if (!paymentLink(plan.id, false)) saknas.push(`${plan.name} månad`);
    if (!paymentLink(plan.id, true)) saknas.push(`${plan.name} halvår`);
  }
  return saknas;
}

export const harBetallankar = () => saknadeLankar().length === 0;

/**
 * Startkontroll.
 *
 * Tre fel är lätta att göra när sex länkar klistras in för hand, och alla tre
 * märks annars först när en kund trycker på knappen:
 *
 *   fel nyckel     en nivå döps om i plans.js men inte här
 *   testlänk kvar  test_-länkarna fungerar men tar inga riktiga pengar
 *   halvtomt       tre av sex ifyllda, och de andra tre går döda
 *
 * Kontrollen skriver bara i konsolen. Att kasta hade tagit ner hela appen för
 * en betalningsdetalj, och en app som inte startar varnar inte för fartkameror
 * heller.
 */
function kontrollera() {
  const idn = PLANS.map(p => p.id);
  for (const nyckel of Object.keys(PAYMENT_LINKS)) {
    if (!idn.includes(nyckel)) {
      console.warn(`betalning.js: "${nyckel}" finns inte i PLANS — den länken kommer aldrig att användas.`);
    }
  }
  for (const id of idn) {
    if (!PAYMENT_LINKS[id]) {
      console.warn(`betalning.js: nivån "${id}" saknar rad i PAYMENT_LINKS.`);
    }
  }

  const saknas = saknadeLankar();
  if (saknas.length && saknas.length < PLANS.length * 2) {
    console.warn('betalning.js: betallänkar saknas för ' + saknas.join(', '));
  }

  const test = Object.values(PAYMENT_LINKS)
    .flatMap(r => [r.manad, r.halvar])
    .filter(arTestlank);
  if (test.length && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    console.warn(`betalning.js: ${test.length} testlänk(ar) i drift — de tar inga riktiga pengar.`);
  }
}

try { kontrollera(); } catch { /* kontrollen får aldrig hindra appen från att starta */ }
