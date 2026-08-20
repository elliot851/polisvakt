// ==UserScript==
// @name         Polisvakt — Facebook-brygga
// @namespace    polisvakt
// @version      2.0
// @description  Läser nya inlägg i en Facebook-grupp du är medlem i och skickar polisvarningar vidare till Polisvakt.
// @match        https://www.facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://mbasic.facebook.com/*
// @connect      livvehyqowmcafnisxho.supabase.co
// @connect      nominatim.openstreetmap.org
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * LÄS DET HÄR FÖRST
 *
 * Meta stängde Groups API för att läsa inlägg 2024. Det finns alltså ingen
 * officiell väg för en app att prenumerera på en grupps flöde. Det här
 * skriptet gör något annat: det tittar på inläggen som *du* redan ser i
 * *din* inloggade webbläsare och skickar vidare de som ser ut att vara
 * polisvarningar.
 *
 * Tre saker att veta:
 *   1. Automatiserad läsning av Facebook strider mot Metas användarvillkor.
 *      Risken ligger på kontot som kör skriptet, och den risken är verklig —
 *      i värsta fall stängs kontot av. Använd inte ditt privata huvudkonto om
 *      det oroar dig.
 *   2. Skriptet måste ha gruppens flik öppen för att fungera. Det är ingen
 *      server — stänger du fliken slutar det läsa.
 *   3. Det skriver till en delad databas som riktiga förare läser under
 *      körning. Kör i torrkörning tills du sett i konsolen att rätt saker
 *      plockas upp, och först då dryRun: false.
 *
 * Den hållbara vägen, om det här växer: be gruppens admin spegla inläggen
 * till en Telegram-kanal (Telegram har ett riktigt bot-API som får läsa) och
 * låt en liten server läsa därifrån istället. Samma regler, ingen ToS-risk,
 * fungerar dygnet runt utan öppen flik. Se tools/telegram-bridge.md.
 *
 * Om koden nedan: den är en avsiktlig kopia av js/parser.js. Skriptet körs på
 * facebook.com och kan inte importera något från appen. Ändras ordlistorna i
 * parser.js måste de ändras här också — särskilt nykterhetsfiltret.
 */

(function () {
  'use strict';

  /* ================= Konfiguration ================= */

  const CONFIG = {
    // Polisvakts Supabase. Publishable/anon-nyckeln är byggd för att ligga
    // öppet i klientkod — den ger bara det radsäkerhetsreglerna tillåter.
    supabaseUrl: 'https://livvehyqowmcafnisxho.supabase.co',
    supabaseKey: 'sb_publishable_6Oz7vhMd2b-kWB_DVftsmg_VwclVG5Q',

    /*
     * Bara inlägg i den här gruppen skickas vidare. Siffrorna eller slug:en
     * i /groups/<här>/.
     *
     * Tomt betyder numera att skriptet vägrar starta. Förut betydde det
     * "läs varje grupp du besöker", med en varning i konsolen — men en
     * varning i konsolen är ingen spärr. Den som glömt fylla i fältet fick
     * en brygga som vidarebefordrade inlägg ur varenda grupp kontot är med
     * i, och det är precis det den aldrig får göra. Fel förval ska stoppa,
     * inte varna.
     */
    // "Här Står Polisen - Västerås", privat grupp, ~18 000 medlemmar.
    // Gruppen har inget eget namn i adressen, bara siffrorna — därför är
    // det den här formen som ska stå här, och samma form som Facebooks
    // notismejl kommer att bära.
    groupId: '317968668373072',

    minConfidence: 0.65,
    scanIntervalMs: 20000,

    // true = logga bara i konsolen, skriv ingenting. Börja alltid här.
    dryRun: true,
  };

  /*
   * Testkrok — enda ändringen som gjorts för att filen ska gå att mäta.
   *
   * fb-bryggan-test.html hämtar den här filen ordagrant och kör den i en
   * förberedd miljö (låtsas-location, låtsas-document, låtsas-fetch) för att
   * bevisa gruppfiltret, nykterhetsspärren och torrkörningen. Testet måste
   * kunna byta grupp och läge per fall, och filen får ändå inte skrivas om
   * till en modul: ägaren installerar den som den är i Tampermonkey.
   *
   * Kroken är död på Facebook. Skriptet körs med @grant none, alltså i
   * sidans egen värld, där Facebooks kod kan sätta vilka globaler den vill —
   * hade kroken gällt där kunde en sida på facebook.com peka om supabaseUrl
   * eller öppna bryggan för fler grupper. Därför gäller den bara när
   * skriptet inte körs på facebook.com, och @match släpper bara in det där.
   */
  const HOST = (typeof location !== 'undefined' && location.hostname) || '';
  if (!/(^|\.)facebook\.com$/i.test(HOST) &&
      typeof window !== 'undefined' && window.__pvBryggaConfig) {
    Object.assign(CONFIG, window.__pvBryggaConfig);
  }

  const VIEWBOX = [15.10, 59.30, 17.30, 60.30];   // Västmanland
  const TTL_MINUTES = { police: 45, control: 60, unmarked: 30 };
  const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000;
  const MAX_TRIES = 3;                            // innan ett inlägg ges upp
  const TAG = '[Polisvakt]';

  /* ================= Parser (kopia av js/parser.js) ================= */

  const TYPE_WORDS = [
    // ordning spelar roll: mest specifik först
    { type: 'camera',   words: ['fartkamera', 'fartkameror', 'atk', 'trafiksäkerhetskamera', 'kamera'] },
    { type: 'control',  words: ['trafikkontroll', 'fartkontroll', 'hastighetskontroll',
                                'laserkontroll', 'poliskontroll', 'kontroll', 'razzia', 'laser'] },
    { type: 'unmarked', words: ['civilbil', 'civilbilar', 'civilpolis', 'civilpoliser', 'civil polis',
                                'civila bilar', 'civil', 'civila'] },
    { type: 'police',   words: ['polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
                                'snuten', 'blåljus', 'piket', 'mc-polis', 'motorcykelpolis'] },
  ];

  const ALL_TYPE_WORDS = new Set(TYPE_WORDS.flatMap(g => g.words.flatMap(w => w.split(' '))));

  const CLEAR_WORDS = ['borta', 'åkte', 'åkt', 'iväg', 'försvunnit', 'försvann', 'fritt',
                       'lugnt', 'avblåst', 'packat', 'tomt'];

  /*
   * Nykterhetskontroller rapporteras inte. Punkt.
   *
   * Att varna för en fartkamera hjälper någon att hålla hastigheten. Att varna
   * för en nykterhetskontroll hjälper någon att köra vidare full. Filtret
   * ligger först i parsern så det gäller allt som passerar här.
   */
  const SOBRIETY_WORDS = [
    'nykterhetskontroll', 'nykterhetskontroller', 'nykterhet', 'nykter',
    'alkoholkontroll', 'alkotest', 'alkoholtest', 'blåsa', 'blåser', 'blås',
    'utandningsprov', 'promillekontroll', 'rattfylla', 'rattfyllerikontroll',
    'sållningsprov', 'drogkontroll', 'drogtest',
    // Narkotikaorden saknades i BÅDA kopiorna, här och i js/parser.js. En
    // granskning körde riktiga meningar genom kedjan: fem av nio
    // drogkontroller blev polisrapporter på kartan, däribland "Polisen har
    // narkotikakontroll på Vasagatan".
    'narkotikakontroll', 'narkotika', 'narko', 'droger', 'drogsök', 'drogsok',
    'drogsökhund', 'drogsokhund', 'drogrelaterad',
  ];

  /*
   * Stavningar som fångas var de än står. Se motiveringen i js/parser.js.
   * "drog" saknas med flit — det är också imperfekt av "dra", och
   * "polisen drog vidare" är en avblåsning, inte en kontroll.
   */
  const SOBRIETY_STAMMAR = [
    'nykter', 'alkohol', 'alko', 'promille', 'rattfyll',
    'utandnings', 'sållnings', 'sallnings',
    'narkotika', 'narko', 'droger', 'drogsök', 'drogsok',
  ];

  /*
   * FELET SOM TESTET HITTADE (fb-bryggan-test.html)
   *
   * js/parser.js fick de här två listorna när ett testsvep visade att
   * isärskrivningar gick rakt igenom nykterhetsspärren. Kopian här nere
   * uppdaterades aldrig. Alltså: "alkohol kontroll vid rondellen",
   * "nykterhets kontroll" och "drog test" tolkades av bryggan som en helt
   * vanlig trafikkontroll och skickades till kartan — precis det som aldrig
   * får hända, och just via den väg som har högst täckning.
   *
   * Svenskan skrivs ihop, men folk särskriver ständigt. Ett Facebook-inlägg
   * är dessutom skrivet i mobilen, i farten, med autokorrigering.
   */
  const SOBRIETY_PREFIX = [
    'alkohol', 'alko', 'nykterhets', 'nykterhet', 'promille', 'rattfylleri',
    'rattfylla', 'drog', 'droger', 'utandnings', 'sållnings', 'sallnings',
    'narkotika', 'narko',
  ];
  const SOBRIETY_HEAD = ['kontroll', 'kontroller', 'test', 'prov', 'kollar', 'koll'];

  /* Bindestreck skiljer ord, inte bara blanksteg. normalize() behåller
     bindestreck för gatunamns skull, vilket gjorde att "drog-kontroll" blev
     ETT ord och gick igenom både ordlistan och isärskrivningsregeln. */
  const SKILJETECKEN = /[\s\-–—_/.]+/;

  const NOISE_PHRASES = ['någon som vet', 'vet någon', 'stämmer det', 'är det någon kvar',
                         'säljes', 'köpes', 'bortsprungen', 'efterlyst', 'grattis'];
  const NOISE_WORDS = ['tack', 'tackar', 'okej', 'grattis', 'säljes', 'köpes', 'katt', 'hund'];

  const STOPWORDS = new Set([
    'vid', 'på', 'i', 'utanför', 'mot', 'runt', 'kring', 'nere', 'uppe', 'bakom', 'framför', 'från',
    'står', 'stod', 'sitter', 'satt', 'ligger', 'finns', 'är', 'var', 'nu', 'just', 'precis', 'åt', 'håll',
    'en', 'ett', 'den', 'det', 'de', 'dom', 'och', 'samt', 'med', 'har', 'hade', 'ser', 'såg', 'kvar',
    'varning', 'varnar', 'obs', 'info', 'tips', 'akta', 'se', 'upp', 'kolla', 'observera', 'pass',
    'nyss', 'sedan', 'sen', 'igen', 'också', 'även', 'typ', 'ca', 'cirka', 'ungefär', 'liksom',
    'gubbarna', 'gubbar', 'grabbar', 'killar', 'folk', 'någon', 'nån', 'dem', 'dej', 'er', 'oss',
  ]);

  const DIRECTION_HINTS = new Set(['norrut', 'söderut', 'österut', 'västerut', 'infart', 'avfart',
    'påfart', 'avfarten', 'påfarten', 'rondellen', 'rondell', 'korsningen', 'bron', 'rampen']);

  const NOT_A_PLACE = new Set([
    ...CLEAR_WORDS, 'ihop',
    'hej', 'hallå', 'okej', 'vakt', 'hey',
    'mörk', 'mörkblå', 'ljus', 'vit', 'svart', 'grå', 'blå', 'röd', 'silver',
    'bil', 'bilen', 'skåpbil', 'volvo', 'passat', 'golf', 'bmw', 'audi', 'buss',
  ]);

  const normalize = s => (s || '').toLowerCase()
    .replace(/[^\wåäöéèü\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function isSobrietyCheck(text) {
    if (!text) return false;
    const words = text.split(SKILJETECKEN).filter(Boolean);
    const hopskrivet = text.replace(/[\s\-–—_/.]+/g, '');
    if (SOBRIETY_WORDS.some(w => words.includes(w) || text.includes(w) || hopskrivet.includes(w))) return true;
    if (SOBRIETY_STAMMAR.some(s => words.some(w => w.startsWith(s)) || hopskrivet.includes(s))) return true;

    // Isärskrivet: förled + huvudord som två ord bredvid varandra.
    for (let i = 0; i < words.length - 1; i++) {
      if (SOBRIETY_PREFIX.includes(words[i]) && SOBRIETY_HEAD.includes(words[i + 1])) {
        return true;
      }
    }
    return false;
  }

  function findType(text, words) {
    const set = new Set(words);
    for (const group of TYPE_WORDS) {
      for (const w of group.words) {
        const hit = w.includes(' ') ? text.includes(w) : set.has(w);
        if (hit) return { type: group.type, word: w };
      }
    }
    return null;
  }

  const hasAnyWord = (words, list) => list.some(w => words.includes(w));
  const hasAnyPhrase = (text, list) => list.some(p => text.includes(p));

  function extractPlace(words) {
    const kept = [];
    for (const w of words) {
      if (ALL_TYPE_WORDS.has(w)) continue;
      if (STOPWORDS.has(w)) continue;
      if (NOT_A_PLACE.has(w)) continue;
      if (/^\d{1,2}[:.]\d{2}$/.test(w)) continue;
      if (/^\d+$/.test(w) && w.length > 3) continue;
      kept.push(w);
    }
    return kept.join(' ').trim();
  }

  function parseReportText(raw) {
    const text = normalize(raw);
    if (!text || text.length < 3) return null;

    if (isSobrietyCheck(text)) return { intent: 'refused', reason: 'sobriety' };

    const words = text.split(' ');
    const t = findType(text, words);
    if (!t) return null;

    // Fartkameror står still, finns redan i appen med rätt koordinat och
    // mätriktning, och en handmarkerad kamera hamnar nästan alltid fel.
    if (t.type === 'camera') return { intent: 'refused', reason: 'camera' };

    if (hasAnyPhrase(text, NOISE_PHRASES)) return null;
    if (hasAnyWord(words, NOISE_WORDS) && words.length < 5) return null;

    const intent = hasAnyWord(words, CLEAR_WORDS) ? 'clear' : 'report';
    const place = extractPlace(words);

    let confidence = 0.5;
    if (place.length >= 3) confidence += 0.3;
    if (words.length <= 8) confidence += 0.1;
    else if (words.length > 25) confidence -= 0.2;
    if (t.type === 'control') confidence += 0.05;
    if (words.some(w => DIRECTION_HINTS.has(w))) confidence += 0.05;

    return {
      intent,
      type: t.type,
      place,
      confidence: Math.max(0, Math.min(1, confidence)),
      raw: String(raw).trim(),
    };
  }

  /* ================= Minneslista ================= */

  /*
   * Gamla versionen markerade ett inlägg som sett *innan* det skickats. Föll
   * geokodningen eller nätet bort försvann varningen för alltid. Nu sparas
   * status: klara inlägg rörs aldrig igen, misslyckade får tre försök.
   *
   * Nyckeln är inläggets Facebook-id när vi hittar det, annars en hash av
   * texten. Id:t är det enda som överlever att flödet renderas om.
   */
  const SEEN_KEY = 'pv.fb.seen.v2';
  const SEEN_TTL = 7 * 24 * 3600 * 1000;

  let seen = (() => {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; }
  })();

  function saveSeen() {
    const cutoff = Date.now() - SEEN_TTL;
    const rows = Object.entries(seen)
      .filter(([, v]) => (v && v.t) > cutoff)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, 2000);
    seen = Object.fromEntries(rows);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
  }

  /*
   * Under torrkörning hålls minnet bara i sidan. Annars hade en torrkörning
   * "bränt" alla inlägg den tittade på: du sätter dryRun: false efteråt och
   * ingenting skickas, för allt är redan avbockat. Konsolen upprepar sig
   * heller inte varje skanning, eftersom minnet lever tills fliken laddas om.
   */
  const dryRunSeen = new Set();

  const isHandled = key => {
    if (CONFIG.dryRun) return dryRunSeen.has(key);
    const e = seen[key];
    return !!e && (e.done || (e.tries || 0) >= MAX_TRIES);
  };
  const markDone = key => {
    if (CONFIG.dryRun) { dryRunSeen.add(key); return; }
    seen[key] = { t: Date.now(), done: true };
    saveSeen();
  };
  const markTry = key => {
    if (CONFIG.dryRun) { dryRunSeen.add(key); return; }
    const e = seen[key] || { tries: 0 };
    seen[key] = { t: Date.now(), tries: (e.tries || 0) + 1 };
    saveSeen();
  };

  /** FNV-1a, identisk med js/facebook.js så external_id blir samma överallt. */
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function keysFor(post) {
    if (post.id) return { stable: 'id:' + post.id, externalId: 'fb:' + post.id };
    const h = hash(normalize(post.text));
    const bucket = Math.floor(Date.now() / DEDUP_WINDOW_MS).toString(36);
    return { stable: 'tx:' + h, externalId: `fb:${h}:${bucket}` };
  }

  /* ================= Läsning av flödet ================= */

  /*
   * Att bara ta innerText på div[role="article"] var för trubbigt: varje
   * kommentar är också en article, och texten kom med knappar, tidsstämplar
   * och "Se mer" inbakat. Nu görs tre saker istället:
   *
   *   1. Bara yttersta article räknas — kommentarerna ligger inuti den.
   *   2. Texten hämtas ur Facebooks egen inläggsbehållare när den finns.
   *      Attributnamnen byter Meta ibland, därför flera kandidater och en
   *      textbaserad reserv.
   *   3. Permalänken ger inläggets id, som blir stabil nyckel över omladdning.
   */

  const MESSAGE_SELECTORS = [
    '[data-ad-comet-preview="message"]',
    '[data-ad-preview="message"]',
    '[data-ad-rendering-role="story_message"]',
    '[data-testid="post_message"]',
  ];

  // Rader som är knappar och metadata, inte inlägg. Både svenska och engelska
  // eftersom kontot kan stå på vilket språk som helst.
  const CHROME_LINE = new RegExp(
    '^(' + [
      'gilla', 'kommentera', 'dela', 'svara', 'se mer', 'visa mer', 'se fler kommentarer',
      'alla kommentarer', 'mest relevanta', 'nyaste', 'skriv en kommentar', 'skriv något',
      'följ', 'följer', 'gå med i gruppen', 'medlem', 'admin', 'moderator', 'sponsrad',
      'redigerat', 'se översättning', 'översätt', 'toppkommentarer', 'aktiva medlemmar',
      'like', 'comment', 'share', 'reply', 'see more', 'see translation', 'top comments',
      'most relevant', 'newest', 'write a comment', 'follow', 'following', 'sponsored',
      'edited', 'group member', 'author',
    ].join('|') + ')$', 'i');

  // "2 tim", "14 aug kl. 09:12", "Igår kl 20:00", "3 h", "Just nu"
  const TIME_LINE = /^(just nu|nyss|igår|idag|yesterday|today|\d+\s*(min|minuter|tim|timmar|h|d|dagar|v|veckor)\b|\d{1,2}\s+\w+\s*(kl\.?\s*\d{1,2}[:.]\d{2})?)/i;

  const COUNT_LINE = /^\d+([\s,.]\d+)?\s*(kommentar|kommentarer|delning|delningar|visning|visningar|comments?|shares?|views?)/i;

  function outermostArticles() {
    const all = Array.from(document.querySelectorAll('div[role="article"]'));
    // Kommentarer är också articles, men ligger inuti inläggets article.
    return all.filter(a => !all.some(b => b !== a && b.contains(a)));
  }

  function messageText(article) {
    for (const sel of MESSAGE_SELECTORS) {
      const node = article.querySelector(sel);
      const t = node && node.innerText ? node.innerText.trim() : '';
      if (t.length > 4) return t;
    }
    return '';
  }

  function fallbackText(article) {
    // Reserv när Meta bytt attributnamn: ta hela artikeln men rensa bort
    // knappar, tider och räknare, och stanna vid första kommentarsraden.
    const lines = (article.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const kept = [];
    for (const line of lines) {
      if (CHROME_LINE.test(line)) break;          // knappraden = slut på inlägget
      if (TIME_LINE.test(line)) continue;
      if (COUNT_LINE.test(line)) continue;
      if (line.length < 3) continue;
      kept.push(line);
      if (kept.length >= 6) break;
    }
    // Första raden är nästan alltid författarens namn. Den bär ingen
    // information för oss och kan innehålla ord som förvirrar parsern.
    if (kept.length > 1) kept.shift();
    return kept.join(' ').trim();
  }

  function postIdOf(article) {
    for (const a of article.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const m =
        /\/groups\/[^\/]+\/(?:posts|permalink)\/(\d+)/.exec(href) ||
        /[?&](?:multi_permalinks|story_fbid|post_id)=(\d+)/.exec(href);
      if (m) return m[1];
    }
    return null;
  }

  /** Ungefärlig tid för inlägget, om vi kan läsa den ur en title-attribut. */
  function postedAtOf(article) {
    for (const el of article.querySelectorAll('a[aria-label], abbr[data-utime], [title]')) {
      const utime = el.getAttribute('data-utime');
      if (utime) return Number(utime) * 1000;
      const raw = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const rel = /^(\d+)\s*(min|minuter|tim|timmar|h)\b/i.exec(raw.trim());
      if (rel) {
        const n = Number(rel[1]);
        return Date.now() - n * (/^m/i.test(rel[2]) ? 60000 : 3600000);
      }
    }
    return null;
  }

  function collectPosts() {
    const out = [];
    for (const article of outermostArticles()) {
      const text = (messageText(article) || fallbackText(article)).slice(0, 400);
      if (text.length < 7) continue;
      out.push({ text, id: postIdOf(article), postedAt: postedAtOf(article) });
    }
    return out;
  }

  /* ================= Geokodning ================= */

  let lastGeocode = 0;

  /*
   * FELET SOM TESTET HITTADE (fb-bryggan-test.html)
   *
   * Nominatim får både viewbox och bounded=1, men det är en spärr som ligger
   * hos någon annan. Svarade servern ändå med en träff utanför Västmanland
   * — eller låg en gammal, felaktig träff kvar i cachen från en tidigare
   * version — gick koordinaten rakt vidare till kartan. Testet lät Nominatim
   * svara "Sergels torg" på en Västeråsfråga, och varningen hamnade i
   * Stockholm.
   *
   * En varning på fel plats är värre än ingen varning: den lär föraren att
   * appen ljuger. Därför kontrolleras varje koordinat mot VIEWBOX här också,
   * både färska svar och det som ligger i cachen.
   */
  const inomOmradet = (lat, lon) =>
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lon >= VIEWBOX[0] && lon <= VIEWBOX[2] &&
    lat >= VIEWBOX[1] && lat <= VIEWBOX[3];

  async function geocode(place) {
    const key = 'pv.fb.geo.' + normalize(place);
    const cached = localStorage.getItem(key);
    if (cached) {
      try {
        const c = JSON.parse(cached);
        if (!c) return null;                       // negativt svar, sparat med flit
        if (inomOmradet(c.lat, c.lon)) return c;
        localStorage.setItem(key, 'null');         // förgiftad rad, kasta den
        return null;
      } catch {}
    }

    // Nominatim tillåter ett anrop i sekunden. Vi köar snällt.
    const wait = 1200 - (Date.now() - lastGeocode);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeocode = Date.now();

    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.searchParams.set('q', /västerås|västmanland/i.test(place) ? place : place + ', Västerås');
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '1');
    u.searchParams.set('countrycodes', 'se');
    u.searchParams.set('viewbox', VIEWBOX.join(','));
    u.searchParams.set('bounded', '1');
    u.searchParams.set('accept-language', 'sv');

    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Nominatim ' + r.status);
    const rows = await r.json();
    if (!rows.length) {
      // Negativt svar cachas också, annars slås samma okända plats upp varje
      // skanning och vi bränner Nominatims tålamod på ingenting.
      localStorage.setItem(key, 'null');
      return null;
    }
    const hit = {
      lat: parseFloat(rows[0].lat),
      lon: parseFloat(rows[0].lon),
      label: String(rows[0].name || place).trim().slice(0, 120),
    };
    if (!inomOmradet(hit.lat, hit.lon)) {
      localStorage.setItem(key, 'null');
      console.warn(TAG, 'träff utanför Västmanland kastad:', place, hit.lat, hit.lon);
      return null;
    }
    localStorage.setItem(key, JSON.stringify(hit));
    return hit;
  }

  /* ================= Skrivning ================= */

  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'fb-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

  /** @returns {boolean} true om raden var ny, false om den redan fanns. */
  async function send(row) {
    const url = CONFIG.supabaseUrl + '/rest/v1/reports?on_conflict=external_id';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: CONFIG.supabaseKey,
        Authorization: 'Bearer ' + CONFIG.supabaseKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error('Supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  }

  /* ================= Skanning ================= */

  function currentGroupId() {
    const m = /\/groups\/([\w.-]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  let running = false;
  let nämntFelGrupp = false;
  const tally = { created: 0, duplicates: 0, refused: 0, skipped: 0, failed: 0 };

  async function scan() {
    if (running) return;

    // Bälte och hängslen: startspärren nedan hindrar redan att skriptet kommer
    // hit utan grupp, men scan går också att kalla för hand från konsolen.
    // Förut stod det `CONFIG.groupId && gid !== CONFIG.groupId`, vilket betydde
    // att ett tomt fält släppte igenom varje grupp just här.
    if (!CONFIG.groupId) return;

    const gid = currentGroupId();
    if (!gid) return;
    if (gid !== CONFIG.groupId) {
      // Facebook byter mellan siffer-id och slug i adressfältet. Står det fel
      // sak i CONFIG.groupId läser bryggan ingenting alls, och tystnaden ser
      // likadan ut som "inga inlägg". En rad i konsolen, en gång.
      if (!nämntFelGrupp) {
        nämntFelGrupp = true;
        console.log(TAG, 'du är i grupp ' + gid + ' men bryggan lyssnar på ' +
          CONFIG.groupId + ' — inget läses här.');
      }
      return;
    }

    running = true;
    try {
      for (const post of collectPosts()) {
        const { stable, externalId } = keysFor(post);
        if (isHandled(stable)) continue;

        const parsed = parseReportText(post.text);

        // Nykterhetskontroller och fartkameror kastas tyst. Inget skickas,
        // ingenting loggas av texten. Det är en produktregel, inte en filter-
        // inställning, och den finns även i appens parser.
        if (parsed && parsed.intent === 'refused') {
          tally.refused++; markDone(stable); continue;
        }
        if (!parsed || parsed.intent === 'clear' || !parsed.place ||
            parsed.confidence < CONFIG.minConfidence) {
          tally.skipped++; markDone(stable); continue;
        }

        const ttl = (TTL_MINUTES[parsed.type] || 45) * 60000;
        const createdAt = post.postedAt && post.postedAt < Date.now() ? post.postedAt : Date.now();
        const expiresAt = createdAt + ttl;
        if (expiresAt <= Date.now() + 60000) {
          // Inlägget är äldre än varningen skulle leva. Gammal varning är
          // sämre än ingen: föraren bromsar i onödan och slutar lita på appen.
          tally.skipped++; markDone(stable); continue;
        }

        let hit;
        try {
          hit = await geocode(parsed.place);
        } catch (e) {
          tally.failed++; markTry(stable);
          console.warn(TAG, 'geokodning misslyckades:', parsed.place, e.message);
          continue;
        }
        if (!hit) {
          tally.skipped++; markDone(stable);
          console.log(TAG, 'okänd plats:', parsed.place, '—', post.text.slice(0, 80));
          continue;
        }

        const row = {
          id: uid(),
          type: parsed.type,
          lat: hit.lat,
          lon: hit.lon,
          label: hit.label,
          note: post.text.slice(0, 240),
          source: 'facebook',
          device_id: 'fb-bridge',
          external_id: externalId,
          created_at: createdAt,
          expires_at: expiresAt,
          confirms: 1,
          denials: 0,
        };

        if (CONFIG.dryRun) {
          console.log(TAG, 'TORRKÖRNING — skulle skicka:', row.type, row.label,
            '(' + Math.round(parsed.confidence * 100) + '%)', row);
          markDone(stable);
          tally.created++;
          continue;
        }

        try {
          const inserted = await send(row);
          markDone(stable);
          if (inserted) { tally.created++; console.log(TAG, 'skickad:', row.type, row.label); }
          else { tally.duplicates++; }
        } catch (e) {
          tally.failed++; markTry(stable);
          console.warn(TAG, 'kunde inte skicka:', e.message);
        }
      }
    } finally {
      running = false;
    }
  }

  /* ================= Igång ================= */

  if (!CONFIG.groupId) {
    console.error(TAG, 'CONFIG.groupId är tom — bryggan startar inte. ' +
      'Öppna gruppen, kopiera det som står efter /groups/ i adressen, och ' +
      'skriv in det i CONFIG.groupId. Utan spärren hade skriptet läst varje ' +
      'grupp kontot är med i.');
    return;      // ingen timer, ingen observatör — skriptet gör ingenting
  }

  console.log(TAG, 'Facebook-bryggan är igång för grupp ' + CONFIG.groupId + '.' +
    (CONFIG.dryRun ? ' Torrkörning: inget skickas.' : ' Skarpt läge.'));

  setTimeout(scan, 4000);
  setInterval(scan, CONFIG.scanIntervalMs);

  // Nya inlägg dyker upp när man skrollar, och Facebook byter sida utan att
  // ladda om. En debounce räcker — vi vill inte skanna vid varje DOM-ändring.
  let moTimer = null;
  new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(scan, 3000);
  }).observe(document.body, { childList: true, subtree: true });

  // Handtag för felsökning i konsolen.
  window.__polisvakt = {
    scanNow: scan,
    stats: () => ({ ...tally, ihagkomna: Object.keys(seen).length }),
    peek: () => collectPosts(),
    parse: parseReportText,
    forget: () => { seen = {}; localStorage.removeItem(SEEN_KEY); console.log(TAG, 'minneslistan tömd'); },
  };
})();
