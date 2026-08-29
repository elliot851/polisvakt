// Regioner (städer) — EN sanning, delad av notis-väljaren och (via samma
// nycklar) av bryggan och notis-routingen på servern.
//
// VARFÖR EN EGEN FIL
//
// "Välj vilka städer du vill ha notiser från" rör fyra lager: väljaren i
// Inställningar, kolumnen push_subscriptions.regioner, edge-funktionen som
// filtrerar mottagare, och bryggan som taggar varje varning med sin region.
// Alla fyra måste vara överens om EXAKT samma nycklar ('vasteras' osv). Ligger
// listan på ett ställe kan de aldrig glida isär; en stavfel-region syns direkt
// i stället för att tyst tappa notiser.
//
// NYCKELN ÄNDRAS ALDRIG. Den står i databasen (regioner-arrayen per
// prenumeration) och i bryggans gruppdefinition. Byt 'label' fritt — det är
// bara det som visas — men rör aldrig 'key'.
//
// status: 'live'     = bryggan läser gruppen, notiser går ut. Visas som valbar.
//         'kommande' = staden är definierad men bryggan läser den inte än
//                      (Facebook-gruppen inte inkopplad). Visas nedtonad så
//                      användaren ser att den är på väg, men kan inte välja den
//                      och tro att den fungerar.
//
// bbox: [minLon, minLat, maxLon, maxLat] — samma ordning som bryggan använder.
//       Behövs den dag routingen ska härleda en varnings region ur dess
//       koordinat i stället för ur gruppen den kom från. Västerås-rutan är
//       hämtad ur bryggans egen gruppdefinition (Västmanland). Uppsala och
//       Stockholm är grovt satta och FÅR JUSTERAS när de riktiga
//       Facebook-grupperna kopplas in.

export const REGIONER = Object.freeze([
  Object.freeze({
    key: 'vasteras',
    label: 'Västerås',
    status: 'live',
    bbox: [15.1, 59.3, 17.3, 60.3],
  }),
  Object.freeze({
    key: 'uppsala',
    label: 'Uppsala',
    status: 'kommande',
    bbox: [17.3, 59.6, 18.2, 60.2],
  }),
  Object.freeze({
    key: 'stockholm',
    label: 'Stockholm',
    status: 'kommande',
    bbox: [17.6, 59.1, 18.4, 59.6],
  }),
]);

/** Bara de regioner som faktiskt läses och går att välja i dag. */
export const LIVE_REGIONER = Object.freeze(REGIONER.filter(r => r.status === 'live'));

/** Nycklarna för live-regionerna — det tillåtna värdeförrådet för ett val. */
export const LIVE_NYCKLAR = Object.freeze(LIVE_REGIONER.map(r => r.key));

/** Slå upp en region på nyckel. null om okänd (t.ex. en gammal sparad nyckel). */
export function region(key) {
  return REGIONER.find(r => r.key === key) || null;
}

/** Etikett för en nyckel, med nyckeln själv som reserv så inget blir tomt. */
export function etikett(key) {
  return region(key)?.label || key;
}

/**
 * Städa ett val mot det tillåtna förrådet.
 *
 * Tar bort okända nycklar (en stad som tagits bort, eller skräp) och
 * dubbletter. TOM lista tolkas ALDRIG här som "ingen" — det är anroparens
 * beslut. På servern betyder null/tom "alla regioner" (bakåtkompatibelt: alla
 * gamla prenumeranter får allt precis som förut). Den som aktivt vill ha noll
 * städer stänger av gruppnotiser i stället.
 */
export function stada(valda) {
  if (!Array.isArray(valda)) return [];
  const tillåtna = new Set(LIVE_NYCKLAR);
  return [...new Set(valda.filter(k => tillåtna.has(k)))];
}
