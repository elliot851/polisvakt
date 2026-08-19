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

const VERSION = '2026-08-19-36';

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
  './js/geo.js',
  './js/geocode.js',
  './js/store.js',
  './js/voice.js',
  './js/alerts.js',
  './js/map.js',
  './js/dashcam.js',
  './js/plate.js',
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
