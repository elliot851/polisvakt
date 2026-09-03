// Service worker.
//
// Appskalet cachas så appen startar direkt även med dålig täckning. Kartbrickor
// och API-anrop går alltid mot nätet — gammal trafikdata är värre än ingen.
//
// Om uppdateringar: VERSION nedan bumpas vid varje deploy. När webbläsaren ser
// en ny service worker installeras den i bakgrunden, tar över direkt
// (skipWaiting) och säger till appen, som laddar om sig själv när det är
// lugnt. Föraren behöver aldrig göra något — och blir aldrig avbruten mitt i
// en körning, eftersom omladdningen väntar tills bilen står still.

// VERSION MÅSTE BUMPAS I SAMMA COMMIT SOM VARJE KODÄNDRING.
//
// Inte som en formalitet. Bytet av den här strängen är det ENDA som får
// webbläsaren att installera en ny service worker: är filen byte-identisk med
// den som redan ligger på telefonen händer ingenting alls — activate körs
// aldrig, gamla cachen rensas aldrig, och postMessage {type:'updated'} som
// uppdateringsbannern hänger på skickas aldrig.
//
// Konsekvensen är värre än en utebliven fix: byggmärket i tabbarens vänstra
// hörn och "Sök efter uppdatering" läser BÅDA den här strängen, så en glömd
// bump gör att appen intygar att telefonen kör det senaste medan den kör det
// gamla. Två mätinstrument som ljuger likadant är sämre än inga.
const VERSION = '2026-09-04-124';

// Kod hämtas alltid förbi webbläsarens egen HTTP-cache.
//
// Utan det här är "nät-först" en illusion: fetch() går genom samma cache som
// allt annat, så en trasig fil som hunnit cachas serveras tillbaka och skrivs
// in i service workerns lager på nytt. Appen blir då oförmögen att uppdatera
// sig ur sitt eget fel. Med cache:'reload' frågar vi alltid servern.
const fromNetwork = req => fetch(new Request(req, { cache: 'reload' }));
const CACHE = `polisvakt-${VERSION}`;

/*
 * Skyltmodellerna bor i en EGEN cache, utan versionsnummer i namnet.
 *
 * Två skäl, båda om megabyte över mobildata:
 *
 * 1. Den versionerade cachen töms vid varje deploy (se `activate`). Låg
 *    modellerna där skulle 13 MB hämtas om varje gång en knapptext ändras.
 *    Den här cachen står kvar över deployer och rensas bara när namnet
 *    nedan ändras — vilket det ska göra den dagen en modellfil byts ut.
 * 2. Appskalet hämtas nät-först, för en fix ska slå igenom samma dag. Det är
 *    fel för modellerna: de är oföränderligt innehåll med sitt versionsnummer
 *    i filnamnet, så nät-först hade betytt 13 MB nedladdning vid varje start.
 *    De hämtas cache-först.
 */
const MODELLCACHE = 'polisvakt-modeller-1';
const arModell = url => url.origin === location.origin &&
                        url.pathname.includes('/modeller/');

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './icon.svg',
  './manifest.webmanifest',
  './js/app.js',
  './js/util.js',
  './js/parser.js',
  './js/sammanfattning.js',
  './js/larm.js',
  './js/geo.js',
  './js/geocode.js',
  './js/store.js',
  './js/voice.js',
  './js/alerts.js',
  './js/map.js',
  './js/dashcam.js',
  './js/plate.js',
  // js/plate.js importerar skyltmodell.js STATISKT. Samma fälla som
  // facebook.js/telegram.js nedan: saknas filen i cachen och appen startas
  // utan nät faller begäran tillbaka på index.html, importen kastar, och
  // ingen app startar alls. Själva MODELLFILERNA hör däremot inte hemma
  // här — 13 MB ska inte förhandshämtas, de tas cache-först vid första
  // användning (se MODELLCACHE).
  './js/skyltmodell.js',
  './js/chatt.js',
  './js/ljud.js',
  './js/notiser.js',
  './js/korvanor.js',
  './js/navigering.js',
  './js/billing.js',
  './js/install.js',
  './js/speedlimit.js',
  './js/impact.js',
  './js/remote.js',
  './js/stats.js',
  './js/reputation.js',
  './js/qr.js',
  './js/tour.js',
  './js/driving.js',
  './js/coverage.js',
  './js/plans.js',
  './js/roadmap.js',
  './js/facebook.js',
  // js/facebook.js importerar gissaGeokodTyp härifrån, statiskt. Filen stod
  // inte i listan, och kedjan app.js → facebook.js → telegram.js hade därför
  // exakt samma kalla-start-fälla som varningsyta.js beskrivs ha nedan:
  // index.html tillbaka på en modulbegäran, importen kastar, ingen app.
  // Hittad när listan jämfördes mot vad som faktiskt importeras — gör om den
  // jämförelsen vid varje ny fil.
  './js/telegram.js',
  './js/rutt.js',
  './js/kartrotation.js',
  './js/vinter.js',
  './js/vakthund.js',
  './js/varme.js',
  './js/kvalitet.js',
  './js/betalning.js',
  './js/behorigheter.js',
  // Uppstartsguiden och pekaren. De MÅSTE ligga här: guiden är det enda som
  // ser till att notiser och plats blir påslagna, och en app som startas
  // utan nät medan just de två filerna saknas i cachen startar utan guide —
  // alltså tyst utan varningar, vilket är exakt det tillståndet guiden finns
  // för att upptäcka.
  './js/uppstart.js',
  './js/peka.js',
  // Varningsytan. Samma skäl som de två ovanför, fast värre utfall.
  //
  // js/app.js importerar den STATISKT, alltså innan en enda rad app-kod
  // körs. Saknas den i cachen och appen startas utan nät — tunnel,
  // källargarage, dålig 4G, alltså precis det tillstånd cachen finns för —
  // faller fetch mot nätet, och reservgrenen längst ned i den här filen
  // svarar caches.match('./index.html') på allt den inte har. Modulbegäran
  // får då text/html tillbaka på en text/javascript-import, importen kastar,
  // och app.js evalueras aldrig. Det blir alltså inte en app utan varningsyta
  // — det blir ingen app alls.
  './js/varningsyta.js',
  // Rörelsen i navigationen. Importeras STATISKT av js/app.js, alltså exakt
  // samma kalla-start-fälla som varningsytan beskriver ovanför: saknas raden
  // svarar reservgrenen index.html på modulbegäran, importen kastar, och det
  // blir inte en app utan animationer — det blir ingen app alls.
  './js/rorelse.js',
  // Inställningsvyns hopfällning och sökning. Importeras DYNAMISKT av
  // js/app.js, så en utebliven fil tar inte appen med sig — men utfallet är
  // ändå tydligt: hela inställningsvyn faller tillbaka till en flat rulle på
  // fyrtiotalet avsnitt, mätt 27 skärmar lång, utan sökruta. Raden ligger
  // här för att den vyn ska fungera lika bra i ett källargarage som på
  // fyra streck.
  './js/inst.js',
  // Butikshyllan. Importeras DYNAMISKT — saknas filen visar vyn en reservtext
  // och appen lever vidare. Hyllans innehall bor i data/butik.json: en ny
  // produkt ar en ny post dar PLUS en versionsbump har, eftersom cachade
  // klienter laser sin kopia tills en ny version pekar om dem.
  './js/butik.js',
  './data/butik.json',
  './butik/hallare-hero.png',
  './butik/hallare-vinkel.png',
  './butik/kamera-hero.png',
  './butik/matta-hero.png',
  './butik/matta.png',
  './butik/doft-hero.png',
  './butik/doft.png',
  './butik/marken.png',
  './butik/hallare-ref.jpg',
  './js/platsstart.js',
  './js/push.js',
  // js/push.js importerar regioner.js STATISKT. Samma kalla-start-fälla som
  // varningsyta.js och facebook.js beskrivs ha nedan: saknas filen i cachen
  // och appen startas utan nät faller begäran tillbaka på index.html,
  // push.js-importen kastar, och notisregistreringen dör tyst. Hittad när
  // stadsväljaren kopplades in.
  './js/regioner.js',
  './js/groups.js',
  './js/config.js',
  './js/auth.js',
  './data/aliases.vasteras.json',
  './data/cameras.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll spricker om en enda fil fattas. Hämta var för sig så en
      // bortglömd fil inte stoppar hela uppdateringen. c.add() hade gått via
      // HTTP-cachen — därför hämtar vi själva och lägger in svaret.
      .then(c => Promise.all(SHELL.map(u =>
        fromNetwork(u)
          .then(res => (res.ok ? c.put(u, res) : null))
          .catch(() => {})
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // MODELLCACHE undantas med flit — se kommentaren vid konstanten. Utan
      // undantaget hämtas 13 MB modeller om vid varje deploy.
      .then(keys => Promise.all(keys
        .filter(k => k !== CACHE && k !== MODELLCACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => {
        for (const c of clients) c.postMessage({ type: 'updated', version: VERSION });
      })
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'version') {
    e.source?.postMessage({ type: 'version', version: VERSION });
  }
  if (e.data?.type === 'skipWaiting') self.skipWaiting();
});

/* ---- Push från servern ----------------------------------------------
 *
 * Utan de två lyssnarna nedan kastas varje push tyst. Telefonen tar emot
 * meddelandet, dekrypterar det, hittar ingen som lyssnar och slänger det.
 *
 * Det här var inte en teoretisk risk. Hela kedjan var byggd och såg grön ut —
 * push.js prenumererade, prenumerationen sparades, servern valde ut
 * mottagare, edge-funktionen fick 201 Created och luckan markerades som
 * skickad — men lyssnaren fanns inte, så ingen notis har någonsin nått fram.
 * En kedja där varje led rapporterar framgång och slutresultatet ändå är noll
 * är den svåraste sortens fel att upptäcka, och exakt varför docs/NOTISER.md
 * kallar just det här steget "det vanligaste felet av alla".
 */

self.addEventListener('push', e => {
  let d = { title: 'Polisvakt', body: 'Dags att köra?', tag: 'polisvakt-reminder', url: './' };
  try { d = { ...d, ...(e.data?.json() ?? {}) }; } catch {}

  /* Svenska fältnamn tas emot också.
   *
   * Databasen bygger sin notis med `titel` och `text`, som resten av
   * projektet. Lyssnaren här läste bara `title` och `body`. Kom en
   * gruppnotis in oöversatt spreadades den ovanpå förvalen utan att skriva
   * över dem, och telefonen visade "Polisvakt / Dags att köra?" — med rätt
   * tag och rätt klickbeteende, alltså en notis som ser fullt normal ut men
   * säger fel sak. Ingenting i någon logg hade avslöjat det.
   *
   * Översättningen hör hemma i edge-funktionen, och görs där. Den här raden
   * finns för att felet ska vara omöjligt att göra om: går något led fel
   * visas ändå rätt text. Explicit undefined-koll, inte ||, så en tom
   * sträng som någon medvetet skickat överlever. */
  if (d.titel !== undefined) d.title = d.titel;
  if (d.text !== undefined) d.body = d.text;

  // waitUntil, alltid. Utan den får service workern dödas innan notisen
  // hunnit ritas, och på en telefon med lite minne händer det ofta.
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icon.svg',
    badge: './icon.svg',
    tag: d.tag,
    data: { url: d.url },

    /* silent: false står UTSKRIVET, fastän det är förvalet.
     *
     * Fältet är trestatligt i praktiken: true = tyst, false = ljud, och
     * undefined betyder "webbläsaren bestämmer". Ett par Android-skal och
     * batterisparlägen har tolkat undefined som tyst, och en polisvarning
     * som kommer utan ljud är en polisvarning som inte kom.
     *
     * Det här styr BARA om systemljudet får spelas. VILKET ljud det är kan
     * en webbsida inte välja — Notification-API:ts sound-fält är dött i alla
     * webbläsare som räknas, och på iPhone finns det inte alls. Är telefonen
     * ljudlös, eller är ljud avslaget för appen i telefonens egna
     * notisinställningar, hjälper ingenting här. */
    silent: false,

    /* Vibrationen är det enda vi faktiskt styr över, och den finns för
     * fallet ovan: en telefon i fickan i en bil hör man inte ändå.
     * Mönstret är långt-kort-långt, alltså inte samma korta knäpp som ett
     * meddelande. iOS Safari struntar i fältet; Android använder det. */
    vibrate: [220, 90, 120, 90, 220],

    // Ingen requireInteraction: en påminnelse ska gå att svepa bort, inte
    // ligga kvar i luren tills man rör vid den.
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  // Finns appen redan öppen ska den fokuseras, inte öppnas en gång till.
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const c of list) if ('focus' in c) return c.focus();
        return self.clients.openWindow(url);
      })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Aldrig cacha rapporter, geokodning, ruttning eller kartbrickor
  const live = /supabase\.co|nominatim|overpass|project-osrm|basemaps\.cartocdn|tile\./.test(url.host);
  if (live) return;

  /*
   * Skyltmodellerna: cache-först, och hämtas bara en gång. Ligger de i cachen
   * rörs nätet inte alls — 13 MB ska inte över mobildata en andra gång.
   * Misslyckas hämtningen svarar vi INTE med index.html som reservgrenen
   * nedan gör: onnxruntime hade då fått en HTML-sida där en modell skulle
   * ligga och kastat ett obegripligt fel. Ett rent nätverksfel är ärligare —
   * skyltmodell.js fångar det och appen kör vidare på den handskrivna vägen.
   */
  if (arModell(url)) {
    e.respondWith(
      caches.match(e.request).then(traff => traff || fetch(e.request).then(res => {
        if (res.ok) {
          const kopia = res.clone();
          caches.open(MODELLCACHE).then(c => c.put(e.request, kopia));
        }
        return res;
      }))
    );
    return;
  }

  // Appskalet: nät först, cache som reserv. Nät först är rätt val här —
  // en dashcam-fix eller ny kameradata ska slå igenom samma dag, och
  // cachen finns för att appen ska starta i en tunnel, inte för att spara
  // trafik.
  e.respondWith(
    fromNetwork(e.request)
      .then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
