/**
 * TIMERS SOM INTE STRYPS AV EN DOLD FLIK.
 *
 * Varför filen finns, och det är en dyrköpt läxa: bänkarna som spelar upp en
 * film i verklig hastighet mätte fel utan att säga ifrån. Chrome klämmer
 * `setInterval` i en flik som inte syns till ungefär ett anrop i sekunden.
 * `PlateReader` driver både sökningen (`sokMs` 120) och läsningen på setInterval
 * respektive setTimeout — så i en dold flik körde de i en sjundedel av sin takt,
 * och mätningen visade en läsare som var långsam och missade skyltar.
 *
 * Slutsatsen "appen läser bara en gång i sekunden, kön måste vara flaskhalsen"
 * var alltså ett mätfel, inte ett fynd. Söktakten avslöjade det: 35 sökningar
 * på 30 sekunder när `sokMs` 120 ska ge 250.
 *
 * Lösningen är att inte gå genom de klämda timerna alls. `MessageChannel`
 * levererar sina meddelanden som vanliga uppgifter i händelsekön och omfattas
 * inte av samma strypning, så en egen schemaläggare på den kan hålla takten
 * även när fliken ligger i bakgrunden.
 *
 * Priset är att slingan snurrar: varje varv postar ett nytt meddelande direkt.
 * Det är medvetet, och det är därför den här filen bara används av bänkarna och
 * aldrig av appen. En bänk får kosta processorkraft; en app i en bil får inte.
 *
 * ANVÄNDNING
 *   import { starkaTimers } from './_takt.js';
 *   const slappTimers = starkaTimers();   // före mätningen
 *   ...
 *   slappTimers();                        // efteråt, alltid
 *
 * `taktprov()` mäter vad flikens timers faktiskt klarar just nu. Kör den före
 * varje mätning som bryr sig om tid — ett tal långt under det begärda betyder
 * att siffrorna som kommer ut inte går att lita på.
 */

/** Hur många gånger i sekunden en timer på `ms` faktiskt fyrar av just nu. */
export function taktprov(ms = 120, varv = 12) {
  return new Promise(ok => {
    const t0 = performance.now();
    let n = 0;
    const id = setInterval(() => {
      if (++n < varv) return;
      clearInterval(id);
      const sek = (performance.now() - t0) / 1000;
      ok({
        begard: +(1000 / ms).toFixed(1),
        uppmatt: +(n / sek).toFixed(1),
        strypt: n / sek < (1000 / ms) * 0.6,
      });
    }, ms);
  });
}

/**
 * Byter ut sidans timers mot en egen schemaläggare. Returnerar en funktion som
 * lämnar tillbaka de riktiga — anropa den alltid när mätningen är klar, annars
 * fortsätter slingan snurra resten av sidans liv.
 */
export function starkaTimers() {
  const origSetTimeout = window.setTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origClearInterval = window.clearInterval.bind(window);

  const jobb = new Map();
  let nastaId = 1, vantar = false, levande = true;
  const kanal = new MessageChannel();

  function schemalagg() {
    if (vantar || !levande || !jobb.size) return;
    vantar = true;
    kanal.port2.postMessage(0);
  }

  kanal.port1.onmessage = () => {
    vantar = false;
    if (!levande) return;
    const nu = performance.now();
    // Kopia: en callback får lägga till och ta bort jobb medan vi går igenom.
    for (const [id, j] of [...jobb]) {
      if (nu < j.nasta) continue;
      if (j.upprepa) j.nasta = nu + j.ms;
      else jobb.delete(id);
      try { j.fn(); } catch (e) { setTimeout(() => { throw e; }); }
    }
    schemalagg();
  };

  const lagg = (fn, ms, args, upprepa) => {
    const id = nastaId++;
    jobb.set(id, {
      fn: typeof fn === 'function' ? () => fn(...args) : () => {},
      ms: Math.max(0, ms || 0),
      nasta: performance.now() + Math.max(0, ms || 0),
      upprepa,
    });
    schemalagg();
    return id;
  };

  window.setTimeout = (fn, ms, ...a) => lagg(fn, ms, a, false);
  window.setInterval = (fn, ms, ...a) => lagg(fn, ms, a, true);
  window.clearTimeout = id => { jobb.delete(id); origClearTimeout(id); };
  window.clearInterval = id => { jobb.delete(id); origClearInterval(id); };

  return function slapp() {
    levande = false;
    jobb.clear();
    try { kanal.port1.close(); kanal.port2.close(); } catch {}
    window.setTimeout = origSetTimeout;
    window.setInterval = origSetInterval;
    window.clearTimeout = origClearTimeout;
    window.clearInterval = origClearInterval;
  };
}
