// ==UserScript==
// @name         Polisvakt — Facebook-brygga
// @namespace    polisvakt
// @version      2.1
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
 *   4. Fliken måste ligga i FÖRGRUNDEN, inte bara vara öppen. Facebook ritar
 *      tidsstämpeln som en SVG-sprite på nya inlägg, och enda vägen till
 *      åldern är att hovra den och läsa verktygstipset. Det kräver riktig
 *      layout och otryckta timers. I en bakgrundsflik läser bryggan färre
 *      inlägg — den hittar inte på tider, den hoppar över dem.
 *
 * Vill du se vad bryggan faktiskt får ut av flödet just nu:
 *   __polisvakt.tider()   → text, id och ålder per inlägg ('OLÄSLIG' om
 *                            tiden inte gick att läsa)
 *   __polisvakt.peek()    → hela avläsningen
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

    /*
     * Facebook ritar tidsstämpeln som en SVG-sprite på inlägg som renderats
     * på klienten — alltså på precis de nya inlägg bryggan finns till för.
     * Där går tiden inte att läsa ur DOM:en alls. Enda vägen är att hovra
     * tidsstämpeln, då lägger Facebook upp ett verktygstips med hela datumet.
     *
     * Slår du av det här läser bryggan bara de inlägg vars tid råkar stå som
     * text. Resten hoppas över, eftersom ett inlägg utan läsbar ålder aldrig
     * får skickas som färskt. Hovringen sker bara på inlägg som redan
     * passerat parsern, ett i taget, och städas bort efteråt.
     */
    hoverForTime: true,

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
  const HOVER_FORSOK = 12;                        // ~800 ms totalt på tipset
  const HOVER_PAUS_MS = 70;

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
   * MÄTT MOT DEN RIKTIGA GRUPPSIDAN, inte mot en påhittad DOM.
   *
   * Den förra versionen itererade div[role="article"] och byggde allt på
   * antagandet att ett inlägg är en article. Det stämmer inte. På
   * /groups/317968668373072/ matchade div[role="article"] fyra element — och
   * alla fyra var KOMMENTARER. Bryggan läste alltså noll inlägg och
   * behandlade kommentarer som inlägg. Uppmätta antal på samma sida:
   *
   *   div[role="article"]                          4   (bara kommentarer)
   *   [data-ad-rendering-role="story_message"]     7   (inläggen)
   *   [data-ad-comet-preview="message"]            1
   *   [data-ad-preview="message"]                  1
   *   [data-testid="post_message"]                 0   (död väljare, borttagen)
   *
   * Alltså: meddelandeväljarna är förankringen. role="article" behålls bara
   * som kommentarsfilter — ligger en meddelandenod inuti en article är den
   * en kommentar, inte ett inlägg.
   */

  const MESSAGE_SELECTORS = [
    '[data-ad-rendering-role="story_message"]',   // bär inläggen på riktigt
    '[data-ad-comet-preview="message"]',
    '[data-ad-preview="message"]',
    // '[data-testid="post_message"]' är borta: 0 träffar på den riktiga
    // sidan. Att låta en död väljare ligga kvar gör bara att nästa mätning
    // måste utesluta den igen.
  ];
  const MESSAGE_SEL = MESSAGE_SELECTORS.join(',');

  // Facebooks egen roll på författarnamnet. Fanns på 7 av 7 riktiga inlägg.
  const PROFILE_SEL = '[data-ad-rendering-role="profile_name"]';

  /*
   * Hårt tak för klättringen. På den riktiga sidan ligger [role="feed"]
   * direkt ovanför inläggsbehållaren (uppmätt: meddelandet på djup 0,
   * behållaren på djup 16, feeden på djup 17). Utan den spärren skulle det
   * sista inlägget i flödet kunna klättra ända upp till <body> och dra med
   * sig hela sidan in i ett enda "inlägg".
   */
  const FEED_SEL = '[role="feed"],[role="main"],[role="banner"],[role="navigation"],[role="complementary"]';
  const MAX_KLATTRING = 25;

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

  /** Är noden en kommentar? Kommentarer — och bara de — är role="article". */
  const arKommentar = nod =>
    !!(nod && typeof nod.closest === 'function' && nod.closest('div[role="article"]'));

  /*
   * BEHÅLLARREGELN
   *
   * Klättra uppåt från meddelandenoden så länge grenen fortfarande handlar om
   * ETT enda inlägg, och stanna vid flödet. Uppmätt på den riktiga sidan gav
   * det samma djup (16) för alla sex vanliga inlägg, och behållaren innehöll
   * då exakt ett författarnamn, tidsstämpelankaret och — när Facebook hade
   * renderat den — permalänken.
   *
   * Att i stället stanna vid "närmaste förfader med författarlänk" ger djup 3.
   * Det testades och är för snävt: den behållarens innerText börjar med
   * raden "Facebook" (Metas egna lockbetesspann) och tidsstämpeln ligger inte
   * i den.
   */
  /* Kommentarer ska inte räknas när vi mäter "handlar den här grenen om ett
     enda inlägg?". Ett inlägg med utfällda kommentarer skulle annars se ut
     som flera inlägg och klättringen stanna för lågt. */
  const raknaEgna = (el, sel) =>
    Array.from(el.querySelectorAll(sel)).filter(n => !arKommentar(n)).length;

  function inlaggsBehallare(nod) {
    let bast = nod;
    let el = nod.parentElement;
    for (let d = 0; el && d < MAX_KLATTRING; d++, el = el.parentElement) {
      if (el.nodeType !== 1) break;
      if (el === document.body) break;
      if (typeof el.matches === 'function' && el.matches(FEED_SEL)) break;
      if (raknaEgna(el, MESSAGE_SEL) > 1) break;   // två inlägg = för högt
      if (raknaEgna(el, PROFILE_SEL) > 1) break;   // två författare = för högt
      bast = el;
    }
    return bast;
  }

  function meddelandeText(nod) {
    const t = nod && nod.innerText ? nod.innerText.trim() : '';
    return t.length > 4 ? t : '';
  }

  /*
   * Rader som Meta strör in för att förgifta innerText. På den riktiga sidan
   * börjar behållarens innerText med åtta rader "Facebook" i rad, från synliga
   * spann som inte betyder något. De ska hoppas över, inte avbryta läsningen.
   */
  const LOCKBETE_RAD = /^(facebook|meta|sponsrad|sponsored)$/i;

  function fallbackText(behallare) {
    // Reserv när Meta bytt attributnamn på själva meddelandet: ta behållaren
    // men rensa bort lockbeten, knappar, tider och räknare.
    const namnNod = behallare.querySelector(PROFILE_SEL);
    // Författarnamnet står 2–4 gånger i samma behållare på den riktiga sidan
    // (profilbildens länk, namnlänken och profile_name). Att bara kasta
    // första raden räckte inte.
    const namn = namnNod && !arKommentar(namnNod)
      ? (namnNod.innerText || '').trim().toLowerCase() : '';
    const lines = (behallare.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const kept = [];
    for (const line of lines) {
      if (LOCKBETE_RAD.test(line)) continue;
      if (namn && line.toLowerCase() === namn) continue;
      if (CHROME_LINE.test(line)) break;          // knappraden = slut på inlägget
      if (TIME_LINE.test(line)) continue;
      if (COUNT_LINE.test(line)) continue;
      if (line.length < 3) continue;
      if (kept.length && kept[kept.length - 1] === line) continue;
      kept.push(line);
      if (kept.length >= 6) break;
    }
    // Vet vi inte vad författaren heter är första raden nästan alltid namnet.
    if (!namn && kept.length > 1) kept.shift();
    return kept.join(' ').trim();
  }

  /*
   * INLÄGGS-ID — vad som faktiskt går att få ut, mätt.
   *
   * Permalänken finns bara ibland. På den riktiga sidan hade 1 av 7 inlägg en
   * a[href*="/posts/<id>"], och då bara för att kommentarerna var utfällda och
   * "se fler kommentarer"-länken bar permalänken. De övriga har enbart
   * författarlänkar (/groups/<gid>/user/<uid>/) och ett naket a[href^="?__cft__"].
   *
   * Tre vägar prövades och stängdes:
   *   1. __cft__-blobben är Metas krypterade spårningssträng. Den innehåller
   *      inget läsbart inläggs-id.
   *   2. Sidans inbäddade JSON: hela skriptnyttolasten (2,6 MB, 299 taggar)
   *      innehöll 2 post_id och 4 creation_time för 7 synliga inlägg. Flödet
   *      efterladdas med GraphQL och skrivs aldrig tillbaka till script-taggar.
   *      Alltså ingen källa att lita på.
   *   3. Hovring över tidsstämpeln skriver INTE om href till permalänken
   *      (uppmätt: href oförändrad före och efter). Den ger däremot datumet,
   *      se tidGenomHovring.
   *
   * Slutsats: id finns när det finns, annars är textnyckeln reserv. Det är
   * mätt, inte gissat.
   */
  function postIdOf(behallare) {
    for (const a of behallare.querySelectorAll('a[href]')) {
      if (arKommentar(a)) continue;
      const href = a.getAttribute('href') || '';
      const m =
        /\/groups\/[^\/]+\/(?:posts|permalink)\/(\d+)/.exec(href) ||
        /[?&](?:multi_permalinks|story_fbid|post_id)=(\d+)/.exec(href);
      if (m) return m[1];
    }
    return null;
  }

  /* ---- Tidsstämpeln -------------------------------------------------- */

  const TIDSANKARE_SEL =
    'a[href^="?__cft__"],a[href*="/posts/"],a[href*="/permalink/"],a[href*="story_fbid="]';

  function tidsAnkareI(behallare) {
    const ut = [];
    for (const a of behallare.querySelectorAll(TIDSANKARE_SEL)) {
      if (arKommentar(a)) continue;               // kommentarens tid, inte inläggets
      ut.push(a);
    }
    return ut;
  }

  /*
   * Facebook renderar inte tidsstämpeln som text. Två lägen är uppmätta på
   * samma sida, samma minut:
   *
   *   a) Teckenspann. Varje tecken ligger i ett eget <span> med slumpad
   *      CSS-order, blandat med ett sextiotal lockbetestecken. innerText på
   *      ankaret gav "sepnodorSt0i5513h16mti146tftt9..." — obrukbart. Sortering
   *      på CSS-order gav också skräp. Det som fungerar är geometri: behåll
   *      bara de tecken vars rektangel ligger INUTI ankarets egen rektangel och
   *      läs dem i renderingsordning (y, sedan x). Det gav "13 tim".
   *   b) SVG-sprite. Ankaret innehåller <span><svg><use>. Noll tecken, noll
   *      text, ingen aria-label, ingen title. Där finns ingenting att läsa
   *      synkront — 5 av 7 inlägg låg i det läget, och det är läget nya inlägg
   *      hamnar i eftersom de renderas på klienten.
   *
   * Därför: läs geometriskt först, och först om det inte ger något, hovra.
   */
  /* U+034F (combining grapheme joiner), nollbredds- och riktningsmärken samt
     BOM. Skrivna som escape-sekvenser med flit: de syns inte i en editor, och
     en osynlig teckenklass är omöjlig att granska. */
  const OSYNLIGA = /[\u034F\u200B-\u200F\u2060\uFEFF]/g;

  function synligText(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return '';
    const blad = Array.from(el.querySelectorAll('span'))
      .filter(s => !s.children.length && (s.textContent || '').trim());
    // Vanligt textankare utan teckenspann: innerText duger.
    if (!blad.length) return (el.innerText || '').trim();

    if (typeof el.getBoundingClientRect !== 'function') return '';
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return '';         // orenderat = inget att lita på

    const bitar = [];
    for (const s of blad) {
      // U+034F och nollbreddstecken är ditlagda just för att förstöra en
      // enkel textContent-läsning.
      const t = (s.textContent || '').replace(OSYNLIGA, '');
      if (!t) continue;
      const q = s.getBoundingClientRect();
      if (!q.width) continue;
      // Mitten, inte kanten: lockbetestecknet direkt utanför den klippta rutan
      // börjar exakt på ankarets högerkant och skulle annars glida med.
      const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      bitar.push({ t, x: q.left, y: q.top });
    }
    if (!bitar.length) return '';
    bitar.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return bitar.map(b => b.t).join('').trim();
  }

  const MANADER = {
    januari: 0, jan: 0, februari: 1, feb: 1, mars: 2, mar: 2, april: 3, apr: 3,
    maj: 4, juni: 5, jun: 5, juli: 6, jul: 6, augusti: 7, aug: 7,
    september: 8, sept: 8, sep: 8, oktober: 9, okt: 9, november: 10, nov: 10,
    december: 11, dec: 11,
  };

  function tolkaAbsolutTid(l) {
    // "Igår kl. 18:07", "Idag kl. 09:12"
    const nara = /\b(i\s?går|igår|i\s?dag|idag|yesterday|today)\b[^\d]*(\d{1,2})[:.](\d{2})/.exec(l);
    if (nara) {
      const d = new Date();
      if (/går|yesterday/.test(nara[1])) d.setDate(d.getDate() - 1);
      d.setHours(Number(nara[2]), Number(nara[3]), 0, 0);
      return d.getTime();
    }
    // "Onsdag 19 augusti 2026 kl. 16:59" — formatet hovringen ger.
    const m = /(\d{1,2})\s+([a-zåäö]{3,9})\.?(?:\s+(\d{4}))?\s*(?:kl\.?\s*)?(\d{1,2})[:.](\d{2})/.exec(l);
    if (!m) return null;
    const man = MANADER[m[2]];
    if (man === undefined) return null;
    const ar = m[3] ? Number(m[3]) : new Date().getFullYear();
    const d = new Date(ar, man, Number(m[1]), Number(m[4]), Number(m[5]), 0, 0);
    let t = d.getTime();
    if (!Number.isFinite(t)) return null;
    // Utan årtal: "24 december kl. 18:00" läst i januari betyder förra året.
    if (!m[3] && t > Date.now() + 86400000) { d.setFullYear(ar - 1); t = d.getTime(); }
    return t;
  }

  /** @returns {number|null} millisekunder, eller null när tiden inte går att läsa. */
  function tolkaTid(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s.length > 60) return null;
    const l = s.toLowerCase();
    if (/^(just nu|nyss|precis|now|just now)\b/.test(l)) return Date.now();
    const rel = /^(\d{1,3})\s*(min|minut|minuter|m|tim|timmar|timme|h|t|d|dygn|dag|dagar|v|vecka|veckor)\b/.exec(l);
    if (rel) {
      const n = Number(rel[1]);
      const e = rel[2];
      const ms = /^(min|minut|minuter|m)$/.test(e) ? 60000
        : /^(tim|timmar|timme|h|t)$/.test(e) ? 3600000
        : /^(d|dygn|dag|dagar)$/.test(e) ? 86400000
        : 604800000;
      return Date.now() - n * ms;
    }
    return tolkaAbsolutTid(l);
  }

  /** Synkron avläsning. Ger null när Facebook ritat tiden som SVG-sprite. */
  function postedAtOf(behallare) {
    for (const a of tidsAnkareI(behallare)) {
      const t = tolkaTid(synligText(a));
      if (t) return t;
    }
    for (const el of behallare.querySelectorAll('[data-utime]')) {
      const u = Number(el.getAttribute('data-utime'));
      if (Number.isFinite(u) && u > 0) return u * 1000;
    }
    for (const el of behallare.querySelectorAll('[aria-label],[title]')) {
      if (arKommentar(el)) continue;
      const t = tolkaTid(el.getAttribute('aria-label') || el.getAttribute('title') || '');
      if (t) return t;
    }
    return null;
  }

  /*
   * Sista utvägen: hovra tidsstämpeln. Facebook lägger då upp en
   * [role="tooltip"] med hela datumet i klartext — uppmätt "Onsdag 19 augusti
   * 2026 kl. 16:59" respektive "Måndag 17 augusti 2026 kl. 18:07". Det är
   * exaktare än den relativa texten och är enda vägen till tiden i
   * SVG-sprite-läget, alltså för nya inlägg.
   *
   * Det är en muspekarhändelse, inte ett klick: ingenting publiceras, gillas
   * eller ändras. Men det är en extra automationssignal mot Meta, och en
   * verktygstips blinkar till på ägarens skärm. Därför en egen inställning,
   * och därför hovras bara inlägg som redan passerat parsern — inte hela
   * flödet.
   */
  const PEK = (typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
  const paus = ms => new Promise(r => setTimeout(r, ms));

  function tooltipTid() {
    for (const t of document.querySelectorAll('[role="tooltip"]')) {
      const v = tolkaTid((t.innerText || t.textContent || '').trim());
      if (v) return v;
    }
    return null;
  }

  async function tidGenomHovring(a) {
    if (!a || typeof a.dispatchEvent !== 'function') return null;
    const r = typeof a.getBoundingClientRect === 'function'
      ? a.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const bas = { cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const skicka = (Typ, namn, bubblar) => {
      try { a.dispatchEvent(new Typ(namn, Object.assign({ bubbles: bubblar !== false }, bas))); }
      catch { /* händelsetypen finns inte här — strunt samma */ }
    };
    skicka(PEK, 'pointerover');
    skicka(MouseEvent, 'mouseover');
    skicka(MouseEvent, 'mouseenter', false);
    skicka(MouseEvent, 'mousemove');
    try {
      for (let i = 0; i < HOVER_FORSOK; i++) {
        const t = tooltipTid();
        if (t) return t;
        await paus(HOVER_PAUS_MS);
      }
      return null;
    } finally {
      // Städa efter oss: verktygstipset ska inte bli kvar på ägarens skärm.
      skicka(MouseEvent, 'mouseout');
      skicka(MouseEvent, 'mouseleave', false);
      skicka(PEK, 'pointerout');
    }
  }

  function collectPosts() {
    const alla = Array.from(document.querySelectorAll(MESSAGE_SEL));
    // Yttersta meddelandenoden per inlägg, och aldrig en kommentar.
    const yttersta = alla.filter(n => !alla.some(o => o !== n && o.contains(n)));
    const ut = [];
    const sedda = new Set();
    for (const nod of yttersta) {
      if (arKommentar(nod)) continue;
      const behallare = inlaggsBehallare(nod);
      if (sedda.has(behallare)) continue;
      sedda.add(behallare);
      const text = (meddelandeText(nod) || fallbackText(behallare)).slice(0, 400);
      if (text.length < 7) continue;
      ut.push({
        text,
        id: postIdOf(behallare),
        postedAt: postedAtOf(behallare),
        tidsAnkare: tidsAnkareI(behallare)[0] || null,
        behallare,
      });
    }
    return ut;
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
  const tally = { created: 0, duplicates: 0, refused: 0, skipped: 0, failed: 0, utanTid: 0 };

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

        /*
         * FELET SOM MÄTNINGEN MOT DEN RIKTIGA SIDAN HITTADE
         *
         * Förut stod det:
         *   const createdAt = post.postedAt && post.postedAt < Date.now()
         *     ? post.postedAt : Date.now();
         *
         * postedAt är null så fort tiden inte går att läsa — och på den
         * riktiga sidan gick den inte att läsa på 5 av 7 inlägg, eftersom
         * Facebook ritar tidsstämpeln som en SVG-sprite. Raden ovan
         * översatte alltså "jag vet inte hur gammalt det här är" till "det
         * är skrivet just nu". Ett tre dygn gammalt inlägg om en
         * laserkontroll blev en färsk varning på kartan.
         *
         * Tidsstämpeln avgör om en varning är färsk. Kan den inte läsas
         * skickas ingenting. Hellre tyst än fel.
         */
        let postedAt = post.postedAt;
        if (postedAt == null && CONFIG.hoverForTime) {
          postedAt = await tidGenomHovring(post.tidsAnkare);
        }
        if (postedAt == null) {
          tally.utanTid++; markTry(stable);
          console.log(TAG, 'ålder går inte att läsa — hoppas över:', post.text.slice(0, 80));
          continue;
        }

        const ttl = (TTL_MINUTES[parsed.type] || 45) * 60000;
        const createdAt = postedAt < Date.now() ? postedAt : Date.now();
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
    // Felsökning av just tidsstämpeln — det som gick sönder tyst förut.
    tider: () => collectPosts().map(p => ({
      text: p.text.slice(0, 60),
      id: p.id,
      postedAt: p.postedAt,
      alder: p.postedAt == null ? 'OLÄSLIG'
        : Math.round((Date.now() - p.postedAt) / 60000) + ' min',
      tidText: p.tidsAnkare ? synligText(p.tidsAnkare) : null,
    })),
    tolkaTid,
    synligText,
    forget: () => { seen = {}; localStorage.removeItem(SEEN_KEY); console.log(TAG, 'minneslistan tömd'); },
  };
})();
