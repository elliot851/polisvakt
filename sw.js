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

const VERSION = '2026-08-20-69';

// Kod hämtas alltid förbi webbläsarens egen HTTP-cache.
//
// Utan det här är "nät-först" en illusion: fetch() går genom samma cache som
// allt annat, så en trasig fil som hunnit cachas serveras tillbaka och skrivs
// in i service workerns lager på nytt. Appen blir då oförmögen att uppdatera
// sig ur sitt eget fel. Med cache:'reload' frågar vi alltid servern.
const fromNetwork = req => fetch(new Request(req, { cache: 'reload' }));
const CACHE = `polisvakt-${VERSION}`;

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
  './js/rutt.js',
  './js/kartrotation.js',
  './js/vinter.js',
  './js/vakthund.js',
  './js/varme.js',
  './js/kvalitet.js',
  './js/betalning.js',
  './js/behorigheter.js',
  './js/push.js',
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
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
